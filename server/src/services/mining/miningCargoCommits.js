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
function records() {
  repo.ensureTable(TABLE);
  const result = repo.read(TABLE, "/");
  if (!result.success || !result.data || typeof result.data !== "object" || Array.isArray(result.data)) throw new Error("MINING_JOURNAL_UNAVAILABLE");
  return result.data;
}
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
  const granted = record.inventoryCargo
    ? require("../inventory/itemStore").grantItemToOwnerLocationIdempotent(
      record.inventoryCargo.ownerID, record.inventoryCargo.locationID, 5,
      record.state.yieldTypeID, record.transferred,
      { receiptKey: `crew-mining:${record.jobID}:grant`, requireDurable: true })
    : record.cargo ? cargo.apply(record.cargo) : { success: true };
  if (!granted.success) return granted;
  const itemIDs = granted.data?.itemIDs || granted.data?.items?.map(item => item.itemID);
  if (record.inventoryCargo && (granted.durable !== true || itemIDs?.length !== 1)) return fail("MINING_CREW_GRANT_PENDING");
  const completed = { ...record, status: "completed",
    ...(record.inventoryCargo ? { itemID: itemIDs[0] } : {}) };
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
// A bounded producer watermark remains after inventory receipts retire. Replaying
// an old extraction can therefore never mint another stack or debit another rock.
function commitCrewExtraction({ ownerID, locationID, serial, jobID, systemID, resourceID, state, quantity, atMs }) {
  if (![ownerID, locationID, serial, systemID, resourceID, quantity].every(n => Number.isSafeInteger(n) && n > 0) ||
      locationID !== 8_500_000_000_000_000 + ownerID || !/^[a-f0-9]{64}$/.test(jobID) ||
      state?.yieldKind !== "ore" || quantity > state.remainingQuantity || !Number.isSafeInteger(atMs)) return fail("MINING_CREW_INVALID");
  const key = `crew-mining:${ownerID}`, old = records()[key];
  if (old && old.serial >= serial) {
    if (old.serial !== serial || old.jobID !== jobID || old.resourceID !== resourceID || old.systemID !== systemID ||
        old.transferred !== quantity || old.state.yieldTypeID !== state.yieldTypeID) return fail("MINING_CYCLE_STALE");
    return settle(key, old);
  }
  if (old?.status === "pending") { const result = settle(key, old); if (!result.success) return result; }
  const recovery = reconcileResource(systemID, resourceID);
  if (!recovery.success) return recovery;
  const commandID = `crew-mining:${jobID}`;
  const record = { status: "pending", commandID, actorID: key, jobID, serial, systemID, resourceID,
    cycleMs: atMs, previousState: clone(state), state: { ...clone(state), remainingQuantity: state.remainingQuantity - quantity,
      updatedAtMs: atMs, lastCargoCommit: commandID }, transferred: quantity, mined: quantity, wasted: 0, critical: 0,
    inventoryCargo: { ownerID, locationID } };
  const checked = require("./miningRuntimeState").commitCargoDepletion(record, { validateOnly: true });
  if (!checked.success) return { ...checked, notAccepted: true };
  if (!old && Object.keys(records()).length >= 100000) return fail("MINING_PRODUCER_CAPACITY");
  const saved = write(key, record);
  return saved.success ? settle(key, record) : saved;
}
module.exports = { commit, commitCrewExtraction, reconcile, reconcileActor, reconcileResource, listRecords: records };
