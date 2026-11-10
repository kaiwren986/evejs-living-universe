"use strict";

// The character owns both the entitlement and its current fulfillment intent.
// Custody owns the consume receipt; no activation history or donor store is used.
const database = require("../../gameStore");
const characters = require("./characterState");
const items = require("../inventory/itemStore");
const custody = require("../inventory/itemCustody");
const { resolveSessionCharacterID } = require("../_shared/sessionIdentity");
const { resolvePaperDollState } = require("./paperDollPayloads");
const { createDurableSchedulerBinding } = require("../_shared/durableSchedulerBinding");
const binding = createDurableSchedulerBinding();
const JOB_TYPE = "character.resculpt-activation";

const CERTIFICATE_TYPES = new Set([34132, 89956]);
function positive(value) { return Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : 0; }
function flush() {
  const result = database.flushTableSync("characters");
  if (!result?.success) throw new Error(result?.errorMsg || "RESCULPT_CHARACTER_FLUSH_FAILED");
}
function save(characterID, updater) {
  const result = characters.updateCharacterRecord(characterID, updater);
  if (!result.success) throw new Error(result.errorMsg || "RESCULPT_CHARACTER_WRITE_FAILED");
  flush();
  return result.data;
}
function enqueue(operation) {
  const scheduler = binding.get();
  if (!scheduler) return Promise.resolve();
  return scheduler.schedule({ jobID: operation.id, type: JOB_TYPE, dueAtMs: Date.now(),
    payload: { characterID: operation.characterID, operationID: operation.id } });
}
function wake(operation) {
  // The flushed character intent is also the cold-start index if enqueue fails.
  Promise.resolve().then(() => enqueue(operation)).catch(error => {
    require("../../utils/logger").warn(`[ReSculpt] Recovery enqueue failed: ${error.message}`);
  });
}
function accessible(item, character, session) {
  const dock = positive(character.stationID || character.structureID);
  const sessionDock = positive(session.stationid || session.stationID || session.structureid || session.structureID);
  if (Number(item.flagID) === items.ITEM_FLAGS.HANGAR) {
    return dock > 0 && dock === sessionDock && Number(item.locationID) === dock;
  }
  if (Number(item.flagID) !== items.ITEM_FLAGS.CARGO_HOLD) return false;
  const shipID = positive(character.shipID);
  const ship = items.findItemById(shipID);
  return shipID > 0 && Number(item.locationID) === shipID &&
    positive(session.shipid || session.shipID) === shipID &&
    Number(ship?.ownerID) === Number(item.ownerID);
}
function refresh(characterID, includeSession = null, changes = []) {
  const { getCharacterSessions } = require("../raffles/raffleInventory");
  for (const session of getCharacterSessions(characterID, { includeSession })) {
    // Read current custody, since a response retry can arrive after another move.
    const currentChanges = changes.map(change => {
      const current = items.findItemById(change.item.itemID);
      return { ...change, item: current && Number(current.ownerID) === characterID
        ? current : items.buildRemovedItemNotificationState(change.item) };
    });
    characters.emitItemsChangedBatchForSession(session, currentChanges);
    // The station handler clears its paper-doll cache. Character selection
    // redraws; its data is separately reloaded by the client's save/logoff flow.
    session.sendNotification("OnCharacterHandler", "charid", []);
  }
}
function settle(characterID, operationID, session = null) {
  let character = characters.getCharacterRecord(characterID);
  let operation = character?.resculptActivation;
  // A delayed job cannot reapply an entitlement from an older appearance cycle.
  if (!operation || operation.id !== operationID) return false;
  flush(); // Also retries a prior failed intent/completion flush before proceeding.
  if (operation.state === "completed") {
    if (!operation.appearanceSaved) refresh(characterID, session, operation.inventoryChanges || []);
    return true;
  }
  if (operation.state !== "pending" || Number(character.accountId) !== operation.accountID) return false;
  const result = custody.transfer({
    items: { itemID: operation.itemID, quantity: 1 },
    from: custody.custodyRef.ownerLocation(characterID, operation.locationID, operation.flagID),
    to: custody.custodyRef.void(), actor: characterID,
    reason: custody.CUSTODY_REASON.CHARACTER_RESCULPT_CONSUME, idempotencyKey: operation.id,
  });
  if (!result.success) {
    if (result.ambiguous || result.reserved) throw new Error(result.errorMsg || "RESCULPT_CUSTODY_PENDING");
    save(characterID, record => ({ ...record,
      resculptActivation: { ...record.resculptActivation, state: "refused", errorMsg: result.errorMsg },
    }));
    return false;
  }
  if (!result.durable) throw new Error("RESCULPT_CUSTODY_NOT_DURABLE");
  save(characterID, record => ({ ...record, paperDollState: 1,
    resculptActivation: { ...record.resculptActivation, state: "completed",
      inventoryChanges: result.data?.changes || [] },
  }));
  refresh(characterID, session, result.data?.changes || []);
  return true;
}
function activate(rawItemID, session) {
  const characterID = positive(resolveSessionCharacterID(session));
  const accountID = positive(session?.userid);
  const itemID = positive(rawItemID);
  const character = characterID && characters.getCharacterRecord(characterID);
  if (!itemID || !accountID || !character || Number(character.accountId) !== accountID) return false;
  const previous = character.resculptActivation;
  if (previous?.state === "pending") {
    wake(previous);
    return previous.itemID === itemID && previous.accountID === accountID
      ? settle(characterID, previous.id, session) : false;
  }
  const paperDollState = resolvePaperDollState(character, 2);
  if (paperDollState === 1) {
    if (previous?.state !== "completed" || previous.itemID !== itemID || previous.accountID !== accountID) return false;
    flush();
    refresh(characterID, session, previous.inventoryChanges || []);
    return true;
  }
  if (paperDollState !== 0) return false; // Initial/forced full editors already have access.
  const item = items.findItemById(itemID);
  if (!item || Number(item.ownerID) !== characterID || !CERTIFICATE_TYPES.has(Number(item.typeID)) ||
      !accessible(item, character, session) || Number(item.stacksize ?? item.quantity) < 1) return false;
  const sequence = (positive(previous?.sequence) || 0) + 1;
  if (!Number.isSafeInteger(sequence)) return false;
  const operation = { id: `resculpt:${characterID}:${sequence}`, sequence, state: "pending",
    accountID, characterID, itemID, typeID: Number(item.typeID), quantity: 1,
    locationID: Number(item.locationID), flagID: Number(item.flagID) };
  save(characterID, record => ({ ...record, resculptActivation: operation }));
  wake(operation);
  return settle(characterID, operation.id, session);
}
async function reconcile() {
  const result = database.read("characters", "/");
  if (!result.success) throw new Error(result.errorMsg || "RESCULPT_RECOVERY_READ_FAILED");
  for (const [key, character] of Object.entries(result.data || {})) {
    const operation = character?.resculptActivation;
    if (operation?.state !== "pending") continue;
    if (Number(key) !== operation.characterID) throw new Error("RESCULPT_RECOVERY_IDENTITY_MISMATCH");
    if (binding.get()) await enqueue(operation);
    else settle(operation.characterID, operation.id);
  }
}
module.exports = { JOB_TYPE, activate, settle, reconcile, refresh,
  bindDurableScheduler: binding.bind, unbindDurableScheduler: binding.unbind,
  handleJob: job => settle(job.payload.characterID, job.payload.operationID) };
