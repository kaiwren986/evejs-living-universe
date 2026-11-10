"use strict";

// Only accepted terminal damage belongs here. Nonlethal combat budgets remain
// owned by the scene and ship row; this journal survives capsule/root removal.
const { createHash } = require("node:crypto");
const { createTableRepository } = require("../../gameStore/tableRepository");
const { createDurableSchedulerBinding } = require("../_shared/durableSchedulerBinding");
const { getWallclockNowMs } = require("../../space/runtime/runtimeClock");
const characterState = require("../character/characterState");
const sessionRegistry = require("../chat/sessionRegistry");
const log = require("../../utils/logger");
const TABLE_NAME = "breacherPodDeaths";
const JOB_TYPE = "ship.breacher-pod-death";
const repository = createTableRepository("service:ship");
const binding = createDurableSchedulerBinding({ requires: ["schedule", "cancel"] });
const pending = new Set();
const lanes = new Map();
const completing = new Set();
const death = () => require("../../space/shipDestruction");
const tracker = () => require("../../space/combat/killmailTracker");
const space = () => require("../../space/runtime");
function check(result) {
  if (!result?.success) throw new Error(result?.errorMsg || "BREACHER_DEATH_OWNER_FAILED");
  return result.data;
}
function root() {
  repository.ensureTable(TABLE_NAME);
  return structuredClone(check(repository.read(TABLE_NAME, "/")) || {});
}
function getRecord(key) { return root().byKey?.[key] || null; }
function listRecords() { return Object.values(root().byKey || {}); }
function save(record) {
  const previous = root();
  const next = structuredClone(previous);
  next.version = 1; next.byKey ||= {}; next.byKey[record.key] = structuredClone(record);
  check(repository.write(TABLE_NAME, "/", next));
  try { check(repository.flushTableSync(TABLE_NAME)); }
  catch (error) { repository.write(TABLE_NAME, "/", previous); throw error; }
  return record;
}
function snapshotEntity(entity) {
  const fields = ["itemID", "typeID", "groupID", "categoryID", "kind", "ownerID", "characterID",
    "pilotCharacterID", "corporationID", "allianceID", "warFactionID", "systemID", "sceneKey",
    "sceneKind", "nativeNpc", "evejsAbyssalInstanceID", "evejsAbyssalRoomIndex"];
  return { ...Object.fromEntries(fields.filter((key) => entity[key] !== undefined).map((key) => [key, entity[key]])),
    ...require("../../space/runtime/entityScopeTags").serializeRuntimeEntityScopeMetadata(entity) };
}
function prepare(scene, target, application, atMs, amount) {
  const ship = require("../inventory/itemStore").findShipItemById(target.itemID);
  if (target.persistSpaceState !== true || !ship || !characterState.getCharacterRecord(ship.ownerID)) return null;
  const key = "breacher-death:" + createHash("sha256").update(JSON.stringify([
    target.itemID, scene.sceneKey, application.source.itemID, application.moduleID,
    application.startedAtMs, atMs,
  ])).digest("hex");
  const source = structuredClone(application.source);
  const weaponSnapshot = { family: "breacherPodLauncher", moduleID: application.moduleID,
    moduleTypeID: application.moduleTypeID, chargeTypeID: application.chargeTypeID };
  const moduleItem = { itemID: application.moduleID, typeID: application.moduleTypeID };
  const options = { whenMs: atMs, weaponSnapshot, moduleItem, attackerIdentity: source.combatIdentity };
  return { version: 1, key, state: "prepared", shipID: target.itemID, characterID: ship.ownerID,
    sceneKey: scene.sceneKey, instanceID: Number(scene.instanceID || 0), atMs,
    target: snapshotEntity(target), source, weaponSnapshot, moduleItem,
    victimIdentity: tracker().resolveVictimIdentity(target),
    damageLedger: tracker().snapshotDamageLedger(target, source, amount, options),
    plan: death().prepareDurableShipDeath(target, structuredClone(ship), key, scene, target.session) };
}
async function schedule(record) {
  const scheduler = binding.get();
  if (!scheduler) return;
  if (record.state === "completed") return scheduler.cancel(record.key);
  return scheduler.schedule({ jobID: record.key, type: JOB_TYPE, dueAtMs: getWallclockNowMs(), payload: { key: record.key } });
}
function kick(record) {
  const work = Promise.resolve().then(() => schedule(record)).catch((error) =>
    log.warn(`[BreacherDeath] schedule ${record.shipID}: ${error.message}`));
  pending.add(work); void work.finally(() => pending.delete(work));
}
function accept(record) {
  if (!record) return null;
  let saved = getRecord(record.key);
  if (!saved) {
    check(repository.flushTableSync("items"));
    saved = save(record);
  }
  kick(saved);
  return saved;
}
function complete(record) {
  // Capsule handoff can synchronously wake/tick the same scene. That nested
  // tick must not settle inventory while the visible destruction is running.
  if (completing.has(record.key)) return { success: false, errorMsg: "BREACHER_DEATH_IN_PROGRESS" };
  completing.add(record.key);
  try { return settle(record); }
  finally { completing.delete(record.key); }
}
function settle(record) {
  record = getRecord(record.key) || accept(record);
  if (record.state === "completed") return { success: true, duplicate: true, data: record };
  const scene = space().scenes.get(record.sceneKey);
  const target = scene?.getEntityByID(record.shipID);
  const session = sessionRegistry.findSessionByCharacterID(record.characterID);
  // Never destroy the pilot's replacement ship. A live original hull retains
  // the normal explosion/session path; later retries finish receipt operations.
  if (target && session && session._space?.shipID === record.shipID &&
      characterState.getActiveShipRecord(record.characterID)?.itemID === record.shipID) {
    const result = require("../../space/runtime/combatDestruction").destroyCombatEntity(scene, target, {
      attackerEntity: record.source, destructionNowMs: record.atMs,
      destructionReason: "breacher-pod", deathReceipt: record.plan });
    check(result);
  }
  check(death().finishDurableShipDeathHandoff(record.plan));
  const settled = check(death().settleDurableShipDeath(record.plan));
  const debris = settled.debrisID && require("../inventory/itemStore").findItemById(settled.debrisID);
  const debrisIsLive = debris && (!Number(debris.expiresAtMs) || Number(debris.expiresAtMs) > scene?.getCurrentSimTimeMs());
  if (scene && space().scenes.get(record.sceneKey) === scene && settled.debrisID &&
      debrisIsLive && !scene.getEntityByID(settled.debrisID)) {
    check(space().spawnDynamicInventoryEntity(record.plan.systemID, settled.debrisID,
      { sceneDescriptor: scene.sceneDescriptor }));
  }
  if (record.instanceID) {
    const manager = require("../../space/runtime/abyssalServicePort").getAbyssalMgrServiceModule();
    const run = manager.getActiveAbyssalRunForCharacterID(record.characterID);
    if (run && Number(run.instanceID) === record.instanceID) {
      const activeShip = characterState.getActiveShipRecord(record.characterID);
      const continuation = session || { characterID: record.characterID, shipID: activeShip?.itemID,
        _abyssalOfflineSession: true, _space: { shipID: activeShip?.itemID, systemID: record.plan.systemID,
          instanceID: record.instanceID, sceneKey: record.sceneKey, sceneKind: "abyssal" },
        sendNotification() {}, sendSessionChange() {} };
      check(manager.handleSessionShipDestroyed(continuation, { reason: "abyssal-combat-destruction",
        destroyedCapsule: false, destructionResult: { success: true, data: { destroyedShipID: record.shipID,
          capsule: activeShip, wreckSuppressed: record.plan.suppressWreck, lootOutcome: settled.lootOutcome } } }));
    }
  }
  const victim = { ...record.target };
  const source = { ...record.source };
  const liveSource = space().scenes.get(source.sceneKey)?.getEntityByID(source.itemID);
  if (liveSource?.ownerID === source.ownerID) source.session = liveSource.session;
  if (session) victim.session = session;
  const killmail = tracker().recordKillmailFromDestruction(victim,
    { success: true, data: { lootOutcome: settled.lootOutcome, wreck: { itemID: settled.debrisID } } },
    { attackerEntity: source, whenMs: record.atMs, weaponSnapshot: record.weaponSnapshot, moduleItem: record.moduleItem,
      damageLedger: record.damageLedger, victimIdentity: record.victimIdentity, idempotencyKey: record.key,
      attackerIdentity: record.source.combatIdentity });
  if (!killmail?.killID) throw new Error("BREACHER_DEATH_KILLMAIL_FAILED");
  check(repository.flushTablesSync(["characters", "items", "insuranceContracts", "notifications", "shipKillCounters"]));
  if (record.instanceID) check(repository.flushTablesSync(["dungeonRuntimeState", "abyssalRecoveryTombstones"]));
  if (scene?.getEntityByID(record.shipID)) scene.removeDynamicEntity(record.shipID, { broadcast: true });
  const completed = save({ ...record, state: "completed", killID: killmail.killID, resolvedAtMs: getWallclockNowMs() });
  kick(completed);
  return { success: true, data: completed };
}
function retry(record) {
  try { return complete(accept(record)); }
  catch (error) {
    log.warn(`[BreacherDeath] pending ship=${record.shipID}: ${error.message}`);
    return { success: false, errorMsg: error.message };
  }
}
function handleJob(job) {
  const key = job?.payload?.key;
  const prior = lanes.get(key) || Promise.resolve();
  const work = prior.catch(() => null).then(() => {
    const record = getRecord(key);
    return record && record.state !== "completed" ? complete(record) : { success: true, stale: true };
  });
  lanes.set(key, work);
  void work.finally(() => { if (lanes.get(key) === work) lanes.delete(key); }).catch(() => null);
  return work;
}
async function reconcile() {
  // Close the crash window between the atomic health/intent row and its
  // terminal journal. Only an exact dead hull row can authorize this handoff.
  for (const item of Object.values(check(repository.read("items", "/")) || {})) {
    const record = item.spaceState?.breacherPodRuntime?.pendingKill?.deathRecord;
    if (record?.version === 1 && record.shipID === item.itemID && record.characterID === item.ownerID &&
        item.conditionState?.damage >= 1 && record.plan?.shipRecord?.itemID === item.itemID) accept(record);
  }
  let scheduled = 0;
  for (const record of listRecords()) if (record.state !== "completed") { await schedule(record); scheduled += 1; }
  return { scheduled };
}
async function idle() {
  while (pending.size || lanes.size) await Promise.all([...pending, ...lanes.values()].map((work) => work.catch(() => null)));
}
function isShipDeathPending(shipID) {
  const ship = require("../inventory/itemStore").findShipItemById(shipID);
  const record = ship?.spaceState?.breacherPodRuntime?.pendingKill?.deathRecord;
  return Boolean(ship && ship.conditionState?.damage >= 1 && record?.shipID === ship.itemID && record.characterID === ship.ownerID);
}
module.exports = { TABLE_NAME, JOB_TYPE, prepare, accept, complete, retry, handleJob, reconcile, getRecord, listRecords,
  bindDurableScheduler: binding.bind, unbindDurableScheduler: binding.unbind, idle, isShipDeathPending };
