"use strict";

// The account owns the intent and its entitlement. The items owner commits the
// certificate debit and its receipt together. All account mutations here are
// synchronous: no other account writer can interleave a stale read and write.
const database = require("../../gameStore");
const store = require("../newEdenStore/storeState");
const items = require("../inventory/itemStore");
const characters = require("../character/characterState");
const { currentFileTime } = require("../_shared/serviceHelpers");
const { createDurableSchedulerBinding } = require("../_shared/durableSchedulerBinding");
const binding = createDurableSchedulerBinding();
const JOB_TYPE = "user.mct-certificate-activation";
const CERTIFICATE_TYPES = new Set([34133, 63188]);
const DAYS = 30;

function positive(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

function check(result, fallback) {
  if (!result?.success) throw new Error(result?.errorMsg || fallback);
  return result.data;
}

function flush() {
  check(database.flushTableSync("newEdenStoreRuntime"), "MCT_ACCOUNT_FLUSH_FAILED");
}

function journal(account) {
  const source = account.mctCertificateActivations || {};
  return {
    nextSequence: positive(source.nextSequence) || 1,
    operations: { ...(source.operations || {}) },
  };
}

function save(accountID, account) {
  return check(store.writeRewardAccount(accountID, account), "MCT_ACCOUNT_WRITE_FAILED");
}

function enqueue(operation) {
  return binding.get()?.schedule({ jobID: operation.id, type: JOB_TYPE,
    dueAtMs: Date.now(), payload: { accountID: operation.accountID, operationID: operation.id } });
}

function wake(operation) {
  // The flushed account intent is the cold-start index even if enqueue fails.
  // A refused fence may also leave that intent cached. Its worker re-fences
  // the account before any debit, so a later normal flush is not stranded.
  Promise.resolve().then(() => {
    const current = journal(store.readRuntimeAccount(operation.accountID)).operations[operation.id];
    if (current?.state === "pending") return enqueue(current);
    return null;
  }).catch(error => {
    require("../../utils/logger").warn(`[MCT] Recovery enqueue failed: ${error.message}`);
  });
}

function chooseSlot(slots, requestedSlot) {
  if (requestedSlot !== null) return String(requestedSlot);
  const now = currentFileTime();
  for (const key of ["2", "3"]) {
    if (BigInt(String(slots[key] || "0")) <= now) return key;
  }
  return BigInt(String(slots["2"])) <= BigInt(String(slots["3"])) ? "2" : "3";
}

function notify(operation, session) {
  if (session) {
    // A lost response may be retried after the remainder moved. Publish current
    // custody, never resurrect the historical remainder from the debit receipt.
    for (const change of operation.inventoryChanges || []) {
      const current = items.findItemById(change.item.itemID);
      const item = current && Number(current.ownerID) === operation.characterID
        ? current : items.buildRemovedItemNotificationState(change.item);
      characters.syncInventoryItemForSession(session, item, change.previousData || {});
    }
  }
  require("../skills/training/skillQueueNotifications")
    .notifyMultipleCharacterTrainingUpdated(operation.accountID);
}

function settle(accountID, operationID, session = null) {
  let account = store.readRuntimeAccount(accountID);
  let state = journal(account), operation = state.operations[operationID];
  if (!operation) return { success: false, errorMsg: "MCT_ACTIVATION_NOT_FOUND" };
  if (operation.accountID !== accountID || operation.id !== operationID) {
    throw new Error("MCT_ACTIVATION_IDENTITY_MISMATCH");
  }
  // A failed flush can leave a pending OR completed account record in cache.
  // Prove that exact state durable before consuming or acknowledging anything.
  flush();
  if (operation.state === "completed") {
    notify(operation, session);
    return { success: true, duplicate: true, data: operation.result };
  }
  if (operation.state !== "pending") return { success: false, errorMsg: operation.errorMsg };

  const receipt = items.getIdempotentGrantReceipt(operation.id, { requireDurable: true });
  check(receipt, "MCT_CONSUME_RECEIPT_FAILED");
  if (!receipt.found) {
    const character = characters.getCharacterRecord(operation.characterID);
    const item = items.findItemById(operation.itemID);
    if (!character || Number(character.accountId) !== accountID || !item ||
        Number(item.ownerID) !== operation.characterID || Number(item.typeID) !== operation.typeID ||
        Number(item.locationID) !== operation.locationID || Number(item.flagID) !== operation.flagID ||
        Number(item.stacksize ?? item.quantity) < 1) {
      operation = { ...operation, state: "refused", errorMsg: "MCT_CERTIFICATE_CUSTODY_CHANGED" };
      state.operations[operationID] = operation;
      save(accountID, { ...account, mctCertificateActivations: state });
      return { success: false, errorMsg: operation.errorMsg };
    }
  }
  const consumed = items.consumeInventoryItemQuantityIdempotent(operation.itemID, 1, {
    removeContents: false, receiptKey: operation.id,
    fingerprint: { kind: JOB_TYPE, accountID, characterID: operation.characterID,
      itemID: operation.itemID, typeID: operation.typeID,
      locationID: operation.locationID, flagID: operation.flagID, quantity: 1 },
  });
  check(consumed, "MCT_CERTIFICATE_CONSUME_FAILED");
  if (!consumed.durable) throw new Error("MCT_CERTIFICATE_CONSUME_NOT_DURABLE");

  // Re-read after the inventory owner returns. Completion and account time are
  // one account-table commit; recovery cannot add another 30 days after it.
  account = store.readRuntimeAccount(accountID);
  state = journal(account);
  operation = state.operations[operationID];
  const currentSlots = store.getTrainingSlotsForAccount(accountID);
  const expiryFileTime = store.computeFutureFileTime(operation.days, currentSlots[operation.slot]);
  operation = { ...operation, state: "completed",
    inventoryChanges: consumed.data?.committedChanges || consumed.data?.changes || [],
    result: { slot: Number(operation.slot), expiryFileTime } };
  state.operations[operationID] = operation;
  save(accountID, { ...account, multiCharacterTrainingSlots: {
    ...account.multiCharacterTrainingSlots, [operation.slot]: expiryFileTime,
  }, mctCertificateActivations: state });
  notify(operation, session);
  return { success: true, duplicate: false, data: operation.result };
}

function activate(rawItemID, rawTrainingID, session, callContext = null) {
  const accountID = positive(session?.userid || session?.userID || session?.accountID);
  const characterID = positive(session?.characterID || session?.charid);
  const itemID = positive(rawItemID);
  const requestedSlot = rawTrainingID == null ? null : Number(rawTrainingID);
  if (!accountID || !characterID || !itemID ||
      (requestedSlot !== null && requestedSlot !== 2 && requestedSlot !== 3)) {
    return { success: false, errorMsg: "MCT_INVALID_ACTIVATION" };
  }
  const character = characters.getCharacterRecord(characterID);
  if (!character || Number(character.accountId) !== accountID) {
    return { success: false, errorMsg: "MCT_ACCOUNT_CHARACTER_MISMATCH" };
  }
  const requestScope = String(callContext?.requestScope || "");
  const fingerprint = JSON.stringify({ accountID, characterID, itemID, requestedSlot });
  const account = store.readRuntimeAccount(accountID), state = journal(account);
  const operations = Object.values(state.operations);
  const scoped = requestScope && operations.find(operation => operation.requestScope === requestScope ||
    (operation.requestScopes || []).includes(requestScope));
  if (scoped) {
    if (scoped.fingerprint !== fingerprint) return { success: false, errorMsg: "MCT_REQUEST_SCOPE_REUSED" };
    return settle(accountID, scoped.id, session);
  }
  const pending = operations.find(operation => operation.state === "pending");
  if (pending) {
    wake(pending);
    if (pending.fingerprint !== fingerprint) return { success: false, errorMsg: "MCT_ACTIVATION_PENDING" };
    if (requestScope) {
      // Bind a reconnect's accepted request before settling it. Its lost-response
      // retry must find this same operation, even after completion.
      state.operations[pending.id] = { ...pending,
        requestScopes: [...new Set([pending.requestScope, ...(pending.requestScopes || []), requestScope].filter(Boolean))] };
      save(accountID, { ...account, mctCertificateActivations: state });
    }
    // A reconnect/new transport may resume an uncertain operation, but cannot
    // spend a second unit until that operation is settled.
    return settle(accountID, pending.id, session);
  }
  const item = items.findItemById(itemID);
  if (!item || Number(item.ownerID) !== characterID ||
      !CERTIFICATE_TYPES.has(Number(item.typeID)) || Number(item.stacksize ?? item.quantity) < 1) {
    return { success: false, errorMsg: "MCT_CERTIFICATE_NOT_OWNED" };
  }
  const sequence = state.nextSequence;
  if (!Number.isSafeInteger(sequence + 1)) return { success: false, errorMsg: "MCT_ACTIVATION_SEQUENCE_EXHAUSTED" };
  const operation = { id: `mct-certificate:${accountID}:${sequence}`, sequence, state: "pending",
    accountID, characterID, itemID, typeID: Number(item.typeID),
    locationID: Number(item.locationID), flagID: Number(item.flagID),
    slot: chooseSlot(store.getTrainingSlotsForAccount(accountID), requestedSlot), days: DAYS,
    requestScope, requestScopes: requestScope ? [requestScope] : [], fingerprint };
  state.nextSequence = sequence + 1;
  state.operations[operation.id] = operation;
  try { save(accountID, { ...account, mctCertificateActivations: state }); }
  finally { wake(operation); }
  return settle(accountID, operation.id, session);
}

async function reconcile() {
  const root = check(database.read("newEdenStoreRuntime", "/"), "MCT_RECOVERY_READ_FAILED");
  for (const [key, account] of Object.entries(root?.accounts || {})) {
    for (const operation of Object.values(journal(account).operations)) {
      if (operation.state !== "pending") continue;
      if (Number(key) !== operation.accountID) throw new Error("MCT_RECOVERY_IDENTITY_MISMATCH");
      if (binding.get()) await enqueue(operation);
      else settle(operation.accountID, operation.id);
    }
  }
}

module.exports = { JOB_TYPE, activate, settle, reconcile,
  bindDurableScheduler: binding.bind, unbindDurableScheduler: binding.unbind,
  handleJob: job => settle(job.payload.accountID, job.payload.operationID) };
