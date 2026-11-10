"use strict";

const { randomUUID } = require("node:crypto");
const { cloneValue } = require("../../common/clone");
const { createTableRepository } = require("../../gameStore/tableRepository");
const { createDurableSchedulerBinding } = require("../_shared/durableSchedulerBinding");
const { resolveSessionCharacterID } = require("../_shared/sessionIdentity");
const { buildDict } = require("../_shared/serviceHelpers");
const characterState = require("../character/characterState");
const sessionRegistry = require("../chat/sessionRegistry");
const { getWallclockNowMs, toFileTimeFromMs } = require("../../space/runtime/runtimeClock");
const log = require("../../utils/logger");

const TABLE_NAME = "shipSelfDestructs";
const SELF_DESTRUCT_DURATION_MS = 120000;
const DURABLE_SELF_DESTRUCT_JOB_TYPE = "ship.self-destruct";
const repository = createTableRepository("service:ship");
const binding = createDurableSchedulerBinding({ requires: ["schedule", "cancel"] });
const pending = new Set();
const lanes = new Map();
function space() { return require("../../space/runtime"); }
function death() { return require("../../space/shipDestruction"); }
function check(result) {
  if (!result || !result.success) throw new Error(result?.errorMsg || "SELF_DESTRUCT_OWNER_COMMAND_FAILED");
  return result.data;
}
function root() {
  repository.ensureTable(TABLE_NAME);
  return cloneValue(check(repository.read(TABLE_NAME, "/")) || { version: 1, byShipID: {} });
}
function getRecord(shipID) { return root().byShipID?.[String(shipID)] || null; }
function listRecords() { return Object.values(root().byShipID || {}); }
function save(record) {
  const previous = root();
  const next = cloneValue(previous);
  next.byShipID ||= {};
  next.byShipID[String(record.shipID)] = cloneValue(record);
  check(repository.write(TABLE_NAME, "/", next));
  try { check(repository.flushTableSync(TABLE_NAME)); }
  catch (error) { repository.write(TABLE_NAME, "/", previous); throw error; }
  return record;
}
function active(record) { return record && ["countdown", "prepared"].includes(record.state); }
function jobID(record) { return `self-destruct:${record.shipID}:${record.generation}`; }
async function schedule(record) {
  const scheduler = binding.get();
  if (!scheduler) return;
  if (!active(record)) return scheduler.cancel(jobID(record));
  return scheduler.schedule({ jobID: jobID(record), type: DURABLE_SELF_DESTRUCT_JOB_TYPE,
    dueAtMs: record.state === "prepared" ? getWallclockNowMs() : record.expiresAtMs,
    payload: { shipID: record.shipID, generation: record.generation } });
}
function kick(record) {
  const promise = Promise.resolve().then(() => schedule(record)).catch(error =>
    log.warn(`[SelfDestruct] schedule ship=${record.shipID}: ${error.message}`));
  pending.add(promise);
  void promise.finally(() => pending.delete(promise));
}
function resolvePilot(session, requestedShipID = null) {
  const characterID = resolveSessionCharacterID(session);
  if (!characterID) return { success: false, errorMsg: "CHARACTER_NOT_SELECTED" };
  if (!session._space || session.stationid || session.stationID || session.structureid || session.structureID)
    return { success: false, errorMsg: "NOT_IN_SPACE" };
  const ship = characterState.getActiveShipRecord(characterID);
  const scene = space().getSceneForSession(session);
  const entity = scene && ship && scene.getEntityByID(ship.itemID);
  if (!ship || (requestedShipID != null && Number(requestedShipID) !== Number(ship.itemID)) ||
      Number(session._space.shipID) !== Number(ship.itemID) || Number(ship.ownerID) !== characterID ||
      ship.flagID !== 0 || Number(ship.locationID) !== Number(scene?.systemID) || ship.transient === true ||
      !scene || !entity || entity.kind !== "ship" || entity.session !== session ||
      entity.sceneKey !== scene.sceneKey || Number(entity.pilotCharacterID || entity.characterID) !== characterID)
    return { success: false, errorMsg: "SELF_DESTRUCT_SHIP_AUTHORITY_MISMATCH" };
  return { success: true, characterID, ship, scene, entity };
}
function exactPilot(record) {
  const session = sessionRegistry.findSessionByCharacterID(record.characterID);
  const context = resolvePilot(session, record.shipID);
  return context.success && context.scene.sceneKey === record.sceneKey &&
    Number(context.scene.instanceID || 0) === record.instanceID ? { ...context, session } : null;
}
function notify(session, messageID) {
  if (session && typeof session.sendNotification === "function")
    session.sendNotification("OnRemoteMessage", "clientID", [messageID, buildDict([])]);
}
function publish(record, session = null) {
  const scene = space().scenes.get(record.sceneKey);
  const entity = scene?.getEntityByID(record.shipID);
  if (!entity || entity.sceneKey !== record.sceneKey) return;
  entity.selfDestructTime = record.state === "countdown" ? toFileTimeFromMs(record.expiresAtMs) : null;
  scene.broadcastSlimItemChanges([entity]);
}
async function startShipSelfDestruct(session, requestedShipID = null) {
  const context = resolvePilot(session, requestedShipID);
  if (!context.success) return context;
  if (!binding.get()) return { success: false, errorMsg: "SELF_DESTRUCT_SCHEDULER_UNAVAILABLE" };
  const prior = getRecord(context.ship.itemID);
  if (active(prior)) {
    if (prior.characterID !== context.characterID || prior.sceneKey !== context.scene.sceneKey)
      return { success: false, errorMsg: "SELF_DESTRUCT_ALREADY_OWNED" };
    if (prior.state === "countdown") await schedule(prior);
    return { success: true, duplicate: true, data: prior };
  }
  const startedAtMs = getWallclockNowMs();
  if (require("../../space/runtime/shipCloak").isEntityCloaked(context.entity))
    check(context.scene.forceDecloakEntity(context.entity, null, { reason: "self-destruct" }));
  const record = save({ version: 1, shipID: context.ship.itemID, characterID: context.characterID,
    typeID: context.ship.typeID, sceneKey: context.scene.sceneKey, instanceID: Number(context.scene.instanceID || 0),
    sceneDescriptor: cloneValue(context.scene.sceneDescriptor), generation: randomUUID(),
    startedAtMs, expiresAtMs: startedAtMs + SELF_DESTRUCT_DURATION_MS, state: "countdown" });
  try { await schedule(record); }
  catch (error) {
    cancel(record, "scheduler-admission-failed");
    log.warn(`[SelfDestruct] admission ship=${record.shipID}: ${error.message}`);
    return { success: false, errorMsg: "SELF_DESTRUCT_SCHEDULER_UNAVAILABLE" };
  }
  const latest = getRecord(record.shipID);
  if (latest.generation !== record.generation || latest.state !== "countdown" || !exactPilot(record)) {
    if (latest.generation === record.generation) cancel(latest, "pilot-departed-during-admission");
    return { success: false, errorMsg: "SELF_DESTRUCT_SHIP_AUTHORITY_MISMATCH" };
  }
  publish(record);
  notify(session, "SelfDestructInitiatedOther");
  return { success: true, data: record };
}
function cancel(record, reason, session = null) {
  if (!record || record.state !== "countdown") return { success: true, duplicate: true };
  const stopped = save({ ...record, state: "aborted", reason, resolvedAtMs: getWallclockNowMs() });
  publish(stopped);
  if (session) notify(session, "SelfDestructAbortedOther2");
  kick(stopped);
  return { success: true, data: stopped };
}
function abortShipSelfDestruct(session, requestedShipID = null) {
  const context = resolvePilot(session, requestedShipID);
  if (!context.success) return context;
  const record = getRecord(context.ship.itemID);
  if (record?.state === "prepared") return { success: false, errorMsg: "SELF_DESTRUCT_COMPLETION_IN_PROGRESS" };
  if (record && (record.characterID !== context.characterID || record.sceneKey !== context.scene.sceneKey))
    return { success: false, errorMsg: "SELF_DESTRUCT_SHIP_AUTHORITY_MISMATCH" };
  return cancel(record, "manual-abort", session);
}
function handleSceneDeparture(session, options = {}) {
  const shipID = Number(options.shipID || session?._space?.shipID);
  const record = getRecord(shipID);
  if (record?.characterID === resolveSessionCharacterID(session))
    return cancel(record, options.lifecycleReason || "scene-departure", session);
  return { success: true };
}
function handleSceneDisposed(sceneKey) {
  for (const record of listRecords()) if (record.sceneKey === sceneKey) cancel(record, "scene-disposed");
}
function isShipSelfDestructing(shipID) { return active(getRecord(shipID)); }
function getShipSelfDestructFileTime(shipID) {
  const record = getRecord(shipID);
  return record?.state === "countdown" ? toFileTimeFromMs(record.expiresAtMs) : null;
}
function handleSessionAttached(session) {
  const record = getRecord(session?._space?.shipID);
  if (record?.state === "countdown") {
    if (exactPilot(record)) publish(record);
    else cancel(record, "attachment-authority-changed");
  }
}

async function complete(record) {
  let context = exactPilot(record);
  if (record.state === "countdown") {
    if (!context) return cancel(record, "pilot-or-scene-departed");
    if (Number(context.ship.typeID) !== record.typeID) return cancel(record, "ship-changed");
    const plan = death().prepareDurableShipDeath(context.entity, context.ship,
      jobID(record), context.scene, context.session);
    record = save({ ...record, state: "prepared", plan });
    publish(record);
    notify(context.session, "SelfDestructImmediateOther");
  }
  if (context) {
    const result = death().destroySessionShip(context.session, { sessionChangeReason: "selfdestruct",
      destructionReason: "selfdestruct", deathReceipt: record.plan,
      suppressWreck: record.plan.suppressWreck });
    if (!result.success && characterState.getActiveShipRecord(record.characterID)?.itemID === record.shipID)
      throw new Error(result.errorMsg);
  }
  // Eject can have durably switched to the capsule before a crash, while
  // inventory still contains the old hull. Finish that journal, never eject
  // whichever ship happens to be active now.
  check(death().finishDurableShipDeathHandoff(record.plan));
  check(death().settleDurableShipDeath(record.plan));
  if (record.plan.capsule) check(death().finishDurablePodDeath(record.plan,
    sessionRegistry.findSessionByCharacterID(record.characterID)));
  if (record.instanceID) {
    const manager = require("../../space/runtime/abyssalServicePort").getAbyssalMgrServiceModule();
    const run = manager.getActiveAbyssalRunForCharacterID(record.characterID);
    if (run && Number(run.instanceID) === record.instanceID) {
      const ship = characterState.getActiveShipRecord(record.characterID);
      const session = sessionRegistry.findSessionByCharacterID(record.characterID) || {
        characterID: record.characterID, shipID: ship?.itemID, _abyssalOfflineSession: true,
        _space: { shipID: ship?.itemID, systemID: record.plan.systemID,
          instanceID: record.instanceID, sceneKey: record.sceneKey, sceneKind: "abyssal" },
        sendNotification() {}, sendSessionChange() {} };
      check(manager.handleSessionShipDestroyed(session, { reason: "abyssal-self-destruct",
        destroyedCapsule: record.plan.capsule, destructionResult: { success: true, data: {
          destroyedShipID: record.shipID, capsule: record.plan.capsule ? null : ship,
          wreckSuppressed: record.plan.suppressWreck, lootOutcome: { items: record.plan.loot.items } } } }));
    }
  }
  const killmail = require("../killmail/killmailState").createKillmailRecordIdempotent({
    killTime: record.plan.destroyedAtFiletime, solarSystemID: record.plan.systemID,
    victimCharacterID: record.characterID, victimCorporationID: record.plan.victimCorporationID,
    victimAllianceID: record.plan.victimAllianceID, victimShipTypeID: record.typeID,
    victimDamageTaken: 0, finalCharacterID: null, attackers: [], items: record.plan.loot.items,
  }, record.plan.key);
  if (!killmail) throw new Error("SELF_DESTRUCT_KILLMAIL_COMMIT_FAILED");
  const settledTables = ["characters", "items", "insuranceContracts", "notifications"];
  if (record.instanceID) settledTables.push("dungeonRuntimeState", "abyssalRecoveryTombstones");
  check(repository.flushTablesSync(settledTables));
  const scene = space().scenes.get(record.sceneKey);
  if (scene?.getEntityByID(record.shipID)) scene.removeDynamicEntity(record.shipID, { broadcast: true });
  const completed = save({ ...record, state: "completed", lastError: null, killID: killmail.killID, resolvedAtMs: getWallclockNowMs() });
  kick(completed);
  return { success: true, data: completed };
}
function handleDurableSelfDestruct(job) {
  const shipID = Number(job?.payload?.shipID);
  const prior = lanes.get(shipID) || Promise.resolve();
  const work = prior.catch(() => null).then(async () => {
    const record = getRecord(shipID);
    if (!active(record) || record.generation !== job.payload.generation) return { success: true, stale: true };
    if (record.state === "countdown" && getWallclockNowMs() < record.expiresAtMs) {
      await schedule(record);
      return { success: true, rescheduled: true };
    }
    try { return await complete(record); }
    catch (error) {
      const latest = getRecord(shipID);
      if (active(latest)) save({ ...latest, lastError: String(error.message) });
      log.warn(`[SelfDestruct] completion ship=${shipID}: ${error.message}`);
      throw error;
    }
  });
  lanes.set(shipID, work);
  void work.finally(() => { if (lanes.get(shipID) === work) lanes.delete(shipID); }).catch(() => null);
  return work;
}
async function reconcileDurableSelfDestructs() {
  let scheduled = 0;
  for (const record of listRecords().filter(active)) {
    if (record.state === "countdown" && !exactPilot(record)) cancel(record, "restart-without-pilot");
    else { await schedule(record); scheduled += 1; }
  }
  return { scheduled };
}
async function idle() {
  while (pending.size || lanes.size) await Promise.all([...pending, ...lanes.values()].map(p => p.catch(() => null)));
}
module.exports = { TABLE_NAME, SELF_DESTRUCT_DURATION_MS, DURABLE_SELF_DESTRUCT_JOB_TYPE,
  startShipSelfDestruct, abortShipSelfDestruct, isShipSelfDestructing, getShipSelfDestructFileTime,
  handleSceneDeparture, handleSessionDisconnected: handleSceneDeparture, handleSceneDisposed, handleSessionAttached,
  handleDurableSelfDestruct, reconcileDurableSelfDestructs, bindDurableScheduler: binding.bind,
  unbindDurableScheduler: binding.unbind, idle, getRecord, listRecords };
