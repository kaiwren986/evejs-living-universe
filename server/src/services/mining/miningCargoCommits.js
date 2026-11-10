"use strict";

// A synchronous domain journal bridges rock state and native cargo receipts.
// Persist intent, deplete once, grant once, then acknowledge. Unknown outcomes
// retain the intent; no later resource user may pass a pending settlement.
const { createTableRepository } = require("../../gameStore/tableRepository");
const repo = createTableRepository("service:mining");
const cargo = require("./npcMiningCargo");
const native = require("../../space/npc/nativeNpcStore");
const TABLE = "miningCargoCommits";
const clone = value => JSON.parse(JSON.stringify(value));
const fail = errorMsg => ({ success: false, errorMsg });
function records() { const result = repo.read(TABLE, "/"); return result.success ? result.data || {} : {}; }
let indexedRoot;
let pendingByResource = new Map();
let pendingByActor = new Map();
function pendingIndex() {
  const root = records();
  if (root === indexedRoot) return;
  indexedRoot = root;
  pendingByResource = new Map(); pendingByActor = new Map();
  for (const entry of Object.entries(root)) {
    const record = entry[1];
    if (record.status !== "pending") continue;
    const resource = `${record.systemID}:${record.resourceID}`;
    if (!pendingByResource.has(resource)) pendingByResource.set(resource, []);
    if (!pendingByActor.has(record.actorID)) pendingByActor.set(record.actorID, []);
    pendingByResource.get(resource).push(entry); pendingByActor.get(record.actorID).push(entry);
  }
}
function write(key, record) {
  indexedRoot = undefined;
  repo.ensureTable(TABLE);
  const before = records()[key];
  const result = repo.write(TABLE, `/${key}`, record);
  if (!result.success) return result;
  try {
    const flushed = repo.flushTableSync(TABLE);
    if (flushed?.success) return { success: true };
    if (before) repo.write(TABLE, `/${key}`, before); else repo.remove(TABLE, `/${key}`);
    return flushed || fail("MINING_INTENT_FLUSH_FAILED");
  } catch (error) {
    if (before) repo.write(TABLE, `/${key}`, before); else repo.remove(TABLE, `/${key}`);
    throw error;
  }
}
function settle(key, record) {
  if (record.status === "completed") return { success: true, duplicate: true, data: clone(record) };
  const resource = require("./miningRuntimeState").commitCargoDepletion(record);
  if (!resource.success) return resource;
  const granted = record.cargo ? cargo.apply(record.cargo) : { success: true };
  if (!granted.success) return granted;
  const completed = { ...record, status: "completed" };
  const saved = write(key, completed);
  return saved.success ? { success: true, data: completed } : saved;
}
function reconcileResource(systemID, resourceID) {
  pendingIndex();
  for (const [key, record] of pendingByResource.get(`${Number(systemID)}:${Number(resourceID)}`) || []) {
    const result = settle(key, record);
    if (!result.success) return result;
  }
  return { success: true };
}
function reconcileActor(entityID) {
  pendingIndex();
  for (const [key, record] of pendingByActor.get(Number(entityID)) || []) {
    const result = settle(key, record);
    if (!result.success) return result;
  }
  return native.reconcileMiningCargoWreckTransfers(entityID);
}
function reconcile() {
  for (const [key, record] of Object.entries(records())) {
    if (record.status !== "pending") continue;
    const result = settle(key, record);
    if (!result.success) return result;
  }
  const wrecks = native.reconcileMiningCargoWreckTransfers();
  return wrecks.success ? native.retirePreviousMiningCargoOwners() : wrecks;
}
function commit({ scene, entity, target, state, moduleID, cycleMs, transferred, mined, wasted, critical = 0 }) {
  const actorRecovery = reconcileActor(entity.itemID);
  if (!actorRecovery.success) return actorRecovery;
  const key = `${entity.transient ? native.miningCargoOwnerInstanceID + ":" : ""}${entity.itemID}:${moduleID}`;
  const old = records()[key];
  if (old && old.cycleMs >= cycleMs) {
    if (old.cycleMs !== cycleMs || old.resourceID !== Number(target.itemID)) return fail("MINING_CYCLE_STALE");
    const result = settle(key, old);
    return result.success ? { ...result, duplicate: true } : result;
  }
  const recovered = reconcileResource(scene.systemID, target.itemID);
  if (!recovered.success) return recovered;
  // The producer cannot replace its previous unfinished obligation.
  if (old?.status === "pending") {
    const result = settle(key, old);
    if (!result.success) return result;
  }
  const commandID = `npc-mining:${key}:${cycleMs}`;
  if (![transferred, mined, wasted, critical].every(n => Number.isSafeInteger(n) && n >= 0) || mined + wasted > state.remainingQuantity) return fail("MINING_QUANTITY_INVALID");
  const prepared = transferred > 0 ? cargo.prepareGrant(entity, state.yieldTypeID, transferred, commandID) : { success: true, data: null };
  if (!prepared.success) return prepared;
  const record = { status: "pending", commandID, actorID: Number(entity.itemID),
    resourceID: Number(target.itemID), systemID: Number(scene.systemID), cycleMs,
    previousState: clone(state), state: { ...clone(state),
      remainingQuantity: Math.max(0, state.remainingQuantity - mined - wasted),
      updatedAtMs: cycleMs, lastCargoCommit: commandID },
    transferred, mined, wasted, critical, cargo: prepared.data };
  const checked = require("./miningRuntimeState").commitCargoDepletion(record, { validateOnly: true });
  if (!checked.success) return checked;
  if (Object.keys(records()).length >= 100000 && !old) return fail("MINING_PRODUCER_CAPACITY");
  const saved = write(key, record);
  return saved.success ? settle(key, record) : saved;
}
module.exports = { commit, reconcile, reconcileActor, reconcileResource, listRecords: records };
