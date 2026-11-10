"use strict";

// Existing authored racial contents are a compatibility fallback, not a retail
// probability table. Captured overrides qualify only their observed type pair.
const { createHash } = require("node:crypto");
const database = require("../../gameStore");
const characters = require("../character/characterState");
const accounts = require("../newEdenStore/storeState");
const items = require("../inventory/itemStore");
const custody = require("../inventory/itemCustody");
const { resolveItemByTypeID } = require("../inventory/itemTypeRegistry");
const { createDurableSchedulerBinding } = require("../_shared/durableSchedulerBinding");
const { buildDict } = require("../_shared/serviceHelpers");
const binding = createDurableSchedulerBinding();
const JOB_TYPE = "career.crate-open";
const BLUEPRINT_OVERRIDES = Object.freeze({
  // market tasks and blueprint crate.lsw rows42827/49494, type row36954:
  // crate63772 peek:685x1, blueprintRun3, blueprintMaterialLevel10,
  // blueprintProductivityLevel20; OpenCrate row50858 returns quantity -2.
  "63772:685": Object.freeze({ blueprintRuns: 3, materialEfficiency: 10, timeEfficiency: 20,
    source: "market tasks and blueprint crate.lsw:42827,49494,50858" }),
  // The preview, consumed crate's type row and open result refer to the same
  // inventory instance in each capture. These qualify only the observed pair;
  // other racial outputs still require their own finite-copy metadata.
  "63773:32877": Object.freeze({ blueprintRuns: 2, materialEfficiency: 10, timeEfficiency: 20,
    source: "Tutorial/Pyro.lsw:166349,166422,166477" }),
  "63774:687": Object.freeze({ blueprintRuns: 1, materialEfficiency: 10, timeEfficiency: 20,
    source: "Tutorial/Plagio.lsw:240421,240976,241033" }),
  "63775:984": Object.freeze({ blueprintRuns: 1, materialEfficiency: 10, timeEfficiency: 20,
    source: "Tutorial/Distribution missions completed.lsw:625946,626114,626166" }),
});
const check = result => {
  if (!result?.success) throw new Error(result?.errorMsg || "AIR_CRATE_SETTLEMENT_FAILED");
  return result;
};
const clone = value => JSON.parse(JSON.stringify(value));
const key = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function isAirCrate(typeID) {
  const type = resolveItemByTypeID(typeID);
  return [1194, 1818].includes(Number(type?.groupID)) && require("./careerCatalog").list()
    .some(goal => goal.rewards.some(reward => reward.kind === "item" && reward.typeID === Number(typeID)));
}
function rewards(typeID, raceID) {
  const authored = require("./careerCatalog").list().flatMap(goal => goal.rewards)
    .find(reward => reward.kind === "item" && reward.typeID === Number(typeID) && reward.contentsByRace);
  const rows = authored?.contentsByRace?.[String(raceID)];
  if (!Array.isArray(rows) || !rows.length) throw new Error("AIR_CRATE_CONTENTS_UNSUPPORTED");
  return rows.map(raw => {
    const entry = clone(raw), type = resolveItemByTypeID(entry.typeID);
    if (!type || !Number.isSafeInteger(entry.quantity) || entry.quantity <= 0 || entry.quantity > 2147483647)
      throw new Error("AIR_CRATE_CONTENTS_UNSUPPORTED");
    if (Number(type.categoryID) === 9) {
      const observed = BLUEPRINT_OVERRIDES[`${typeID}:${entry.typeID}`];
      if (observed) Object.assign(entry, observed);
      else if (entry.blueprintPolicy === "authored-one-run-fallback-v1" && entry.blueprintRuns === 1 &&
          entry.materialEfficiency === 0 && entry.timeEfficiency === 0) {
        entry.source = "Provisional authored one-run ME0/TE0 copy; retail metadata unrecovered";
      } else throw new Error("AIR_CRATE_BLUEPRINT_RUNS_UNRECOVERED");
    }
    return entry;
  });
}
function model(characterID) {
  const character = characters.getCharacterRecord(characterID);
  if (!character || !Number.isSafeInteger(Number(character.accountId)) || Number(character.accountId) <= 0) throw new Error("CHARACTER_NOT_FOUND");
  return { character, accountID: Number(character.accountId), account: accounts.readRuntimeAccount(Number(character.accountId)) };
}
function previous(characterID, crateID, pendingOnly = false) {
  const { account } = model(characterID);
  return Object.values(account.careerCrateOpenings || {})
    .filter(operation => operation.characterID === characterID && operation.crateID === crateID && (!pendingOnly || operation.state === "pending"))
    .sort((a, b) => b.atMs - a.atMs || Number(b.sequence || 0) - Number(a.sequence || 0) || a.initialQuantity - b.initialQuantity)[0] || null;
}
function save(accountID, operation) {
  const account = accounts.readRuntimeAccount(accountID);
  (account.careerCrateOpenings ||= {})[operation.id] = clone(operation);
  check(accounts.writeRewardAccount(accountID, account));
  check(database.flushTableSync("newEdenStoreRuntime"));
}
function preview(characterID, item) {
  const pending = previous(characterID, item.itemID, true);
  const entries = pending?.entries || rewards(item.typeID, model(characterID).character.raceID);
  // A blueprint's metadata goes out as a Python dict in TQ's key order; a plain object can't be
  // marshalled, and the whole answer would then reach the client as None.
  return entries.map(entry => [entry.typeID, entry.quantity, entry.blueprintRuns ? buildDict([
    ["blueprintRun", entry.blueprintRuns], ["blueprintMaterialLevel", entry.materialEfficiency],
    ["blueprintProductivityLevel", entry.timeEfficiency],
  ]) : null]);
}
function location(characterID, crateID) {
  if (!(characterID > 0) || !characters.getCharacterRecord(characterID)) return null;
  const item = items.findItemById(crateID);
  if (item && Number(item.ownerID) === characterID && isAirCrate(item.typeID)) return [item.locationID, item.flagID];
  const operation = previous(characterID, crateID);
  return operation ? [operation.locationID, operation.flagID] : null;
}
function publish(operation, session) {
  const normalized = operation.result.changes.map(change => {
    const preimage = change.item || change.previousData, current = items.findItemById(preimage.itemID);
    // A minted item carries only previousState. The change dict comes from
    // previousData, and TQ sends {3: 0}; left empty, an open window misses the item.
    return { ...change, previousData: change.previousData || change.previousState,
      item: current && Number(current.ownerID) === operation.characterID
      ? current : items.buildRemovedItemNotificationState(preimage) };
  });
  for (const target of require("../raffles/raffleInventory").getCharacterSessions(operation.characterID, { includeSession: session }))
    characters.emitItemsChangedBatchForSession(target, normalized);
}
function settle(accountID, id, session) {
  let operation = accounts.readRuntimeAccount(accountID).careerCrateOpenings?.[id];
  if (!operation || operation.accountID !== accountID) throw new Error("AIR_CRATE_INTENT_NOT_FOUND");
  check(database.flushTableSync("newEdenStoreRuntime"));
  if (operation.state === "completed") return clone(operation.result.nativeItems);
  const character = characters.getCharacterRecord(operation.characterID);
  if (!character || Number(character.accountId) !== accountID) throw new Error("AIR_CRATE_OWNER_CHANGED");
  const receiptKey = `air-crate-consume:${id}`;
  const consumed = check(items.getIdempotentGrantReceipt(receiptKey, { requireDurable: true }));
  if (!consumed.found) {
    const source = items.findItemById(operation.crateID);
    if (!source || source.ownerID !== operation.characterID || source.typeID !== operation.crateTypeID ||
        source.locationID !== operation.locationID || source.flagID !== operation.flagID || source.stacksize !== operation.initialQuantity)
      throw new Error("AIR_CRATE_CUSTODY_CHANGED");
  }
  const consumption = check(items.consumeInventoryItemQuantityIdempotent(operation.crateID, 1,
    { receiptKey, fingerprint: { characterID: operation.characterID, crateID: operation.crateID,
      crateTypeID: operation.crateTypeID, initialQuantity: operation.initialQuantity, locationID: operation.locationID, flagID: operation.flagID } }));
  const result = { changes: consumption.data?.changes || [], nativeItems: [] };
  for (const [index, entry] of operation.entries.entries()) {
    const effect = `air-crate-grant:${id}:${index}`;
    const proof = check(custody.getCommittedReceipt(effect));
    let destination = operation.destinations?.[index] || { locationID: operation.locationID, flagID: operation.flagID };
    if (!proof.committed && !require("./careerRewardSettlement").canDeliverRewardItems(operation.characterID, destination, [entry])) {
      const home = require("./careerRewardSettlement").homeDestination(character);
      if (!home) throw new Error("AIR_CRATE_DESTINATION_UNAVAILABLE");
      destination = home;
      (operation.destinations ||= {})[index] = destination;
      save(accountID, operation);
    }
    const grant = check(custody.transfer({ items: { typeID: entry.typeID, quantity: entry.quantity,
      options: { singleton: entry.blueprintRuns ? 2 : 0,
        ...(require("./careerRewardSettlement").isCharacterBoundReward(entry.typeID) ? { careerBoundCharacterID: operation.characterID } : {}) } },
      to: custody.custodyRef.ownerLocation(operation.characterID, destination.locationID, destination.flagID),
      actor: operation.characterID, reason: custody.CUSTODY_REASON.CAMPAIGN_REWARD_GRANT, idempotencyKey: effect }));
    if (!grant.durable) throw new Error("AIR_CRATE_GRANT_NOT_DURABLE");
    if (entry.blueprintRuns && grant.data.items.length) check(require("../inventory/blueprintRewardState").ensureGrantedBlueprintCopyState(grant.data.items,
      { runsRemaining: entry.blueprintRuns, materialEfficiency: entry.materialEfficiency, timeEfficiency: entry.timeEfficiency }));
    result.changes.push(...(grant.data.changes || []));
    let remaining = entry.quantity;
    for (const item of grant.data.items) {
      const quantity = entry.blueprintRuns ? -2 : Math.min(item.stacksize, remaining);
      result.nativeItems.push([item.itemID, entry.typeID, quantity]); remaining -= entry.blueprintRuns ? 1 : quantity;
    }
  }
  operation = { ...operation, state: "completed", result };
  save(accountID, operation);
  publish(operation, session);
  return clone(result.nativeItems);
}
function open(characterID, crateID, session) {
  const pending = previous(characterID, crateID, true);
  if (pending) return settle(pending.accountID, pending.id, session);
  const item = items.findItemById(crateID);
  if (!item) {
    const completed = previous(characterID, crateID);
    if (completed?.state === "completed") return clone(completed.result.nativeItems);
    throw new Error("AIR_CRATE_NOT_FOUND");
  }
  if (Number(item.ownerID) !== characterID || !isAirCrate(item.typeID) || Number(item.stacksize) < 1) throw new Error("AIR_CRATE_NOT_OWNED");
  const { character, accountID, account } = model(characterID), entries = rewards(item.typeID, character.raceID);
  if (Object.keys(account.careerCrateOpenings || {}).length >= 8192) throw new Error("AIR_CRATE_RECEIPT_LIMIT");
  // A player may replenish the same source stack to an earlier quantity. A
  // monotonic accepted-opening ordinal prevents that unit reusing an old key.
  const sequence = Object.values(account.careerCrateOpenings || {}).filter(row => row.characterID === characterID && row.crateID === crateID).length + 1;
  const id = key([characterID, crateID, "opening-v2", sequence]);
  const operation = { id, state: "pending", accountID, characterID, crateID, crateTypeID: item.typeID,
    sequence, initialQuantity: item.stacksize, locationID: item.locationID, flagID: item.flagID, entries,
    selectionPolicy: "existing-authored-racial-compatibility; full retail pools and weights unrecovered", atMs: Date.now() };
  save(accountID, operation);
  // The native crate RPC is synchronous. Startup reconciliation schedules any
  // accepted opening interrupted before this inline settlement completes.
  return settle(accountID, id, session);
}
function wasDelivered(characterID, itemID) {
  if (!(characterID > 0) || !characters.getCharacterRecord(characterID)) return false;
  return Object.values(model(characterID).account.careerCrateOpenings || {}).some(operation => operation.characterID === characterID &&
    operation.state === "completed" && operation.result.nativeItems.some(row => row[0] === itemID));
}
async function reconcile() {
  const root = check(database.read("newEdenStoreRuntime", "/"));
  for (const account of Object.values(root.data?.accounts || {})) for (const operation of Object.values(account.careerCrateOpenings || {})) {
    if (operation.state !== "pending") continue;
    if (binding.get()) await binding.get().schedule({ jobID: `air-crate:${operation.id}`, type: JOB_TYPE, dueAtMs: Date.now(),
      payload: { accountID: operation.accountID, id: operation.id } });
    else settle(operation.accountID, operation.id);
  }
}
module.exports = { JOB_TYPE, isAirCrate, preview, location, open, previous, wasDelivered, settle, reconcile,
  bindDurableScheduler: binding.bind, unbindDurableScheduler: binding.unbind,
  handleJob: job => settle(job.payload.accountID, job.payload.id) };
