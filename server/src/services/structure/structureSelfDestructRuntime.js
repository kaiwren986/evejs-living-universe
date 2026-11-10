"use strict";

const { randomUUID } = require("node:crypto");
const { createDurableSchedulerBinding } = require("../_shared/durableSchedulerBinding");
const { resolveSessionCharacterID } = require("../_shared/sessionIdentity");
const { getPersistedCorporationAuthority } = require("../corporation/corporationAuthority");
const { TYPE_TERRITORIAL_CLAIM_UNIT, TYPE_INFRASTRUCTURE_HUB } = require("../sovereignty/sovConstants");
const { canEntitiesInteractLocally } = require("../../space/destiny/identity/interactionScope");
const { getWallclockNowMs } = require("../../space/runtime/runtimeClock");
const registry = require("../chat/sessionRegistry");
const characterState = require("../character/characterState");
const log = require("../../utils/logger");

const SELF_DESTRUCT_DURATION_MS = 1200000;
const MAX_CONFIGURE_DISTANCE_METERS = 5000;
const DURABLE_SELF_DESTRUCT_JOB_TYPE = "structure.self-destruct";
const TARGET_TYPES = new Set([TYPE_TERRITORIAL_CLAIM_UNIT, TYPE_INFRASTRUCTURE_HUB]);
const binding = createDurableSchedulerBinding({ requires: ["schedule", "cancel"] });
const pending = new Set();
const lanes = new Map();
function structures() { return require("./structureState"); }
function sovereignty() { return require("../sovereignty/sovState"); }
function space() { return require("../../space/runtime"); }
function check(result) {
  if (!result?.success) throw new Error(result?.errorMsg || "STRUCTURE_SELF_DESTRUCT_COMMAND_FAILED");
  return result.data;
}
function failure(errorMsg) { return { success: false, errorMsg }; }
// The owner alliance's SovStructureSelfDestruct notices (167 requested, 168
// cancelled, 169 finished). They are keyed by the countdown's generation, so a
// replayed command or job sends each once; a failed notice never fails the
// command.
function notify(kind, record, extra = {}) {
  try {
    const notices = require("../sovereignty/sovCampaignNotifications");
    const send = { requested: notices.notifySovSelfDestructRequested,
      cancelled: notices.notifySovSelfDestructCancelled, finished: notices.notifySovSelfDestructFinished }[kind];
    const result = send({ structureTypeID: record.typeID, solarSystemID: record.solarSystemID,
      allianceID: record.allianceID, corporationID: record.ownerCorpID, eventKey: record.generation, ...extra });
    if (!result || result.success !== true)
      log.warn(`[StructureSelfDestruct] ${kind} notice structure=${record.structureID}: ${result && result.errorMsg || "failed"}`);
  } catch (error) {
    log.warn(`[StructureSelfDestruct] ${kind} notice structure=${record.structureID}: ${error.message}`);
  }
}
function filetime(ms) { return (BigInt(Math.trunc(ms)) * 10000n + 116444736000000000n).toString(); }
function active(record) { return record && ["countdown", "prepared", "destroyed"].includes(record.state); }
function jobID(record) { return `structure-self-destruct:${record.structureID}:${record.generation}`; }
function getRecord(id) { return structures().getStructureSelfDestructRecord(id); }
function listRecords() { return structures().listStructureSelfDestructRecords(); }
function save(record) { return check(structures().commitStructureSelfDestructRecord(record)); }

function resolveAuthority(session, structureID) {
  const characterID = resolveSessionCharacterID(session);
  if (!characterID || !registry.isRegisteredSession(session) ||
      registry.findSessionByCharacterID(characterID) !== session || !session.socket || session.socket.destroyed ||
      session._characterControlDisconnected === true)
    return failure("STRUCTURE_ACCESS_DENIED");
  const character = characterState.peekCharacterRecord(characterID);
  if (!character || character.isDeleted || character.deletedAt || !Number(session.userid) ||
      Number(character.accountId) !== Number(session.userid)) return failure("STRUCTURE_ACCESS_DENIED");
  const structure = structures().getStructureByID(structureID, { refresh: false });
  if (!structure) return failure("STRUCTURE_NOT_FOUND");
  if (!TARGET_TYPES.has(structure.typeID)) return failure("STRUCTURE_SELF_DESTRUCT_NOT_SUPPORTED");
  if (structure.destroyedAt || structure.unanchoring) return failure("STRUCTURE_DESTROYED");
  const authority = getPersistedCorporationAuthority(session);
  if (!structures().hasStructureGmBypass(session) &&
      (!authority?.isDirector || authority.corporationID !== structure.ownerCorpID))
    return failure("STRUCTURE_ACCESS_DENIED");
  const scene = space().getSceneForSession(session);
  const ship = characterState.getActiveShipRecord(characterID);
  const pilot = ship && scene?.getEntityByID(ship.itemID);
  const target = scene?.getEntityByID(structure.structureID);
  if (!session._space || !scene || scene.sceneKey !== `solar-system:${structure.solarSystemID}` ||
      !ship || ship.ownerID !== characterID || ship.flagID !== 0 || ship.transient === true ||
      Number(ship.locationID) !== structure.solarSystemID || Number(session._space.shipID) !== ship.itemID ||
      Number(session.shipID || session.shipid) !== ship.itemID || !pilot || pilot.session !== session ||
      pilot.sceneKey !== scene.sceneKey || Number(pilot.pilotCharacterID || pilot.characterID) !== characterID ||
      !Array.from(scene.sessions.values()).includes(session) ||
      !target || target.kind !== "structure" || scene.staticEntitiesByID.get(structure.structureID) !== target ||
      (target.sceneKey != null && target.sceneKey !== scene.sceneKey) || target.typeID !== structure.typeID ||
      target.ownerID !== structure.ownerCorpID || !canEntitiesInteractLocally(pilot, target) ||
      ![pilot, target].every(entity => ["x", "y", "z"].every(axis => Number.isFinite(entity.position?.[axis]))) ||
      typeof scene.getEntitySurfaceDistance !== "function")
    return failure("STRUCTURE_CONFIGURE_DISTANCE_UNAVAILABLE");
  const distance = scene.getEntitySurfaceDistance(pilot, target);
  if (!Number.isFinite(distance)) return failure("STRUCTURE_CONFIGURE_DISTANCE_UNAVAILABLE");
  if (distance >= MAX_CONFIGURE_DISTANCE_METERS) return failure("STRUCTURE_OUT_OF_CONFIGURE_RANGE");
  return { success: true, data: { structure, characterID, scene } };
}

async function schedule(record) {
  const scheduler = binding.get();
  if (!scheduler) return;
  if (!active(record)) return scheduler.cancel(jobID(record));
  return scheduler.schedule({ jobID: jobID(record), type: DURABLE_SELF_DESTRUCT_JOB_TYPE,
    dueAtMs: record.state === "countdown" ? record.expiresAtMs : getWallclockNowMs(),
    payload: { structureID: record.structureID, generation: record.generation } });
}
function queueRecord(record) {
  const work = Promise.resolve().then(() => schedule(record)).catch(error =>
    log.warn(`[StructureSelfDestruct] schedule structure=${record.structureID}: ${error.message}`));
  pending.add(work);
  void work.finally(() => pending.delete(work));
  return work;
}
function startStructureSelfDestruct(session, structureID) {
  const result = resolveAuthority(session, Number(structureID));
  if (!result.success) return result;
  if (!binding.get()) return failure("STRUCTURE_SELF_DESTRUCT_SCHEDULER_UNAVAILABLE");
  const { structure, characterID, scene } = result.data;
  const prior = getRecord(structure.structureID);
  if (active(prior)) { queueRecord(prior); return { success: true, data: prior, duplicate: true }; }
  const nowMs = getWallclockNowMs();
  const record = save({ generation: randomUUID(), state: "countdown", structureID: structure.structureID,
    typeID: structure.typeID, ownerCorpID: structure.ownerCorpID, allianceID: structure.allianceID,
    solarSystemID: structure.solarSystemID, sceneKey: scene.sceneKey, characterID,
    startedAtMs: nowMs, expiresAtMs: nowMs + SELF_DESTRUCT_DURATION_MS });
  queueRecord(record);
  notify("requested", record, { characterID, destructTime: filetime(record.expiresAtMs) });
  return { success: true, data: record };
}
function abortStructureSelfDestruct(session, structureID) {
  const result = resolveAuthority(session, Number(structureID));
  if (!result.success) return result;
  const record = getRecord(result.data.structure.structureID);
  if (!active(record)) return { success: true, duplicate: true };
  if (record.state !== "countdown" || getWallclockNowMs() >= record.expiresAtMs)
    return failure("STRUCTURE_SELF_DESTRUCT_TOO_LATE");
  const cancelled = save({ ...record, state: "aborted", reason: "pilot-abort", resolvedAtMs: getWallclockNowMs() });
  queueRecord(cancelled);
  notify("cancelled", cancelled, { characterID: result.data.characterID });
  return { success: true, data: cancelled };
}
// GM time skip (owner ruling 2026-11-07, hybrid with time forwarding): make a
// running countdown end in `seconds`. The record and the structure's
// selfDestructAt move together, and the job is rescheduled to the new deadline.
function adminSetSelfDestructRemaining(structureID, seconds) {
  const record = getRecord(Number(structureID));
  if (!record || record.state !== "countdown") return failure("STRUCTURE_SELF_DESTRUCT_NOT_RUNNING");
  const expiresAtMs = getWallclockNowMs() + Math.max(0, Number(seconds) || 0) * 1000;
  const moved = save({ ...record, expiresAtMs });
  queueRecord(moved);
  return { success: true, data: moved };
}
function sameStructure(record, structure) {
  return structure && !structure.destroyedAt && !structure.unanchoring &&
    TARGET_TYPES.has(structure.typeID) &&
    structure.typeID === record.typeID && structure.ownerCorpID === record.ownerCorpID &&
    structure.solarSystemID === record.solarSystemID &&
    structure.selfDestructGeneration === record.generation && structure.selfDestructAt === record.expiresAtMs;
}
function cancelChanged(record) {
  const cancelled = save({ ...record, state: "aborted", reason: "structure-authority-changed", resolvedAtMs: getWallclockNowMs() });
  queueRecord(cancelled);
  return { success: true, data: cancelled };
}
function complete(record) {
  let current = structures().getStructureByID(record.structureID, { refresh: false });
  if (record.state === "countdown") {
    const canonical = sovereignty().findSovereigntyStructureByID(record.structureID);
    if (!sameStructure(record, current) || (canonical &&
      (canonical.solarSystemID !== record.solarSystemID || canonical.structure.typeID !== record.typeID ||
       Number(canonical.structure.corporationID || canonical.structure.ownerID) !== record.ownerCorpID)))
      return cancelChanged(record);
    record = save({ ...record, state: "prepared", structure: current, lastError: null });
  }
  if (record.state === "prepared") {
    if (!sameStructure(record, current))
      throw new Error("STRUCTURE_SELF_DESTRUCT_AUTHORITY_CHANGED");
    check(structures().destroyStructure(record.structureID, {
      nowMs: record.expiresAtMs, selfDestructGeneration: record.generation }));
    record = getRecord(record.structureID);
    if (record.state !== "destroyed") throw new Error("STRUCTURE_SELF_DESTRUCT_DESTRUCTION_NOT_COMMITTED");
  }
  const dropLocationID = record.loot?.wreck?.itemID || record.loot?.containers?.[0]?.containerID || null;
  const loss = check(sovereignty().commitSovereigntyStructureDestruction({
    structure: record.structure, generation: record.generation, dropLocationID, nowMs: record.expiresAtMs }));
  if (space().getSceneByDescriptor(record.solarSystemID)) {
    const inventory = require("../inventory/itemStore");
    for (const itemID of record.loot?.spawnItemIDs || []) {
      if (inventory.findItemById(itemID)) check(space().spawnDynamicInventoryEntity(record.solarSystemID, itemID));
    }
  }
  structures().createStructureDestroyedNotifications(record.structure, { idempotencyKey: jobID(record) });
  notify("finished", record);
  check(require("../../gameStore").flushTablesSync(["structures", "items", "sovereignty", "notifications"]));
  const completed = save({ ...record, state: "completed", sovereignLoss: loss, lastError: null, resolvedAtMs: getWallclockNowMs() });
  queueRecord(completed);
  return { success: true, data: completed };
}
function handleDurableSelfDestruct(job) {
  const structureID = Number(job?.payload?.structureID);
  const prior = lanes.get(structureID) || Promise.resolve();
  const work = prior.catch(() => null).then(async () => {
    const record = getRecord(structureID);
    if (!active(record) || record.generation !== job?.payload?.generation) return { success: true, stale: true };
    if (record.state === "countdown" && getWallclockNowMs() < record.expiresAtMs) {
      await schedule(record);
      return { success: true, rescheduled: true };
    }
    try { return complete(record); }
    catch (error) {
      const latest = getRecord(structureID);
      if (active(latest) && latest.generation === record.generation) save({ ...latest, lastError: error.message });
      throw error;
    }
  });
  lanes.set(structureID, work);
  void work.then(() => { if (lanes.get(structureID) === work) lanes.delete(structureID); },
    () => { if (lanes.get(structureID) === work) lanes.delete(structureID); });
  return work;
}
async function reconcileDurableSelfDestructs() {
  let scheduled = 0;
  for (const record of listRecords()) {
    if (active(record)) { await schedule(record); scheduled += 1; }
    else if (binding.get()) await binding.get().cancel(jobID(record));
  }
  return { scheduled };
}
async function idle() {
  while (pending.size || lanes.size) await Promise.all([...pending, ...lanes.values()].map(work => work.catch(() => null)));
}
module.exports = { adminSetSelfDestructRemaining, SELF_DESTRUCT_DURATION_MS, MAX_CONFIGURE_DISTANCE_METERS, DURABLE_SELF_DESTRUCT_JOB_TYPE,
  startStructureSelfDestruct, abortStructureSelfDestruct, handleDurableSelfDestruct, reconcileDurableSelfDestructs,
  bindDurableScheduler: binding.bind, unbindDurableScheduler: binding.unbind, getRecord, listRecords, queueRecord, idle };
