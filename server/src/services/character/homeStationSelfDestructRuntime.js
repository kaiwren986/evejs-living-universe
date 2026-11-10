"use strict";

// The character owns this docked death journal. Custody, implants and station
// rebuilding remain with their existing owners; a retry uses the original
// capsule and generation, never the pilot's replacement ship.
const { randomUUID } = require("node:crypto");
const character = require("./characterState");
const inventory = require("../inventory/itemStore");
const registry = require("../chat/sessionRegistry");
const worldData = require("../../space/worldData");
const { resolveSessionCharacterID } = require("../_shared/sessionIdentity");
const { createDurableSchedulerBinding } = require("../_shared/durableSchedulerBinding");
const { throwWrappedObject, throwWrappedUserError } = require("../../common/machoErrors");
const { getWallclockNowMs } = require("../../space/runtime/runtimeClock");
const database = require("../../gameStore");
const binding = createDurableSchedulerBinding({ requires: ["schedule", "cancel"] });
const completing = new Set();
const pendingSchedules = new Set();
const DURABLE_SELF_DESTRUCT_JOB_TYPE = "character.home-clone-self-destruct";
const ERROR_TYPE = "homestation.validation.SelfDestructCloneValidationError";

function check(result) {
  if (!result?.success) throw new Error(result?.errorMsg || "HOME_CLONE_TRANSFER_FAILED");
  return result;
}
function validation(errors) {
  throwWrappedObject(ERROR_TYPE, [errors], { errors });
}
function getRecord(characterID) {
  return character.peekCharacterRecord(characterID)?.homeStationSelfDestruct || null;
}
function active(record) { return record && record.state !== "completed"; }
function jobID(record) { return `home-clone-self-destruct:${record.characterID}:${record.generation}`; }
function save(record) {
  check(character.updateCharacterRecord(record.characterID, row => ({ ...row, homeStationSelfDestruct: record })));
  check(database.flushTableSync("characters"));
  return getRecord(record.characterID);
}
function dockable(locationID, characterID) {
  if (worldData.getStationByID(locationID)) return true;
  const structure = worldData.getStructureByID(locationID);
  const row = character.peekCharacterRecord(characterID);
  const session = { characterID, charid: characterID, corporationID: row?.corporationID,
    allianceID: row?.allianceID, accountRole: 0n };
  return !!structure && !structure.destroyedAt && !structure.unanchoring &&
    require("../structure/structureState").canCharacterDockAtStructure(session, structure).success === true;
}
function actingCharacter(session) {
  const characterID = resolveSessionCharacterID(session);
  const row = characterID && character.peekCharacterRecord(characterID);
  if (!row || row.isDeleted || row.deletedAt || !session?.userid ||
      Number(row.accountId) !== Number(session.userid) ||
      !registry.isRegisteredSession(session) || registry.findSessionByCharacterID(characterID) !== session ||
      !session.socket || session.socket.destroyed || session._characterControlDisconnected === true) validation([0]);
  return { characterID, row };
}
function prepare(session, characterID, row) {
  const homeStationID = Number(row.homeStationID || row.cloneStationID) || 0;
  const locationID = Number(row.stationID || row.structureID) || 0;
  const sessionLocation = Number(session.stationID || session.stationid || session.structureID || session.structureid) || 0;
  // A read here must not repair a spoofed or missing active ship into a capsule.
  const ship = inventory.findItemById(Number(row.shipID));
  const errors = [];
  if (locationID && locationID === homeStationID) errors.push(3);
  if (!locationID || locationID !== sessionLocation || session._space ||
      Number(session.shipID || session.shipid) === Number(session.structureID || session.structureid)) errors.push(1);
  if (!ship || !inventory.isCapsuleTypeID(ship.typeID)) errors.push(2);
  if (errors.length) validation(errors);
  if (!homeStationID || !dockable(homeStationID, characterID) || !dockable(locationID, characterID) ||
      ship.ownerID !== characterID || ship.locationID !== locationID || ship.flagID !== inventory.ITEM_FLAGS.HANGAR ||
      ship.transient === true || Number(session.shipID || session.shipid) !== ship.itemID ||
      require("../station/jumpCloneRuntime").hasPendingCloneActivation(characterID)) validation([0]);
  if (!binding.get()) validation([0]);
  return save({ characterID, generation: randomUUID(), state: "prepared", sourceShip: ship,
    sourceLocationID: locationID, homeStationID, transitionReason: "clonejump", startedAtMs: getWallclockNowMs() });
}
async function schedule(record) {
  const scheduler = binding.get();
  if (!scheduler) return;
  if (!active(record)) return scheduler.cancel(jobID(record));
  return scheduler.schedule({ jobID: jobID(record), type: DURABLE_SELF_DESTRUCT_JOB_TYPE,
    dueAtMs: getWallclockNowMs(), payload: { characterID: record.characterID, generation: record.generation } });
}
function queueRecord(record) {
  const work = Promise.resolve().then(() => schedule(record));
  pendingSchedules.add(work);
  void work.then(() => pendingSchedules.delete(work), () => pendingSchedules.delete(work));
  return work;
}
function syncRemoval(session, result) {
  const changes = result?.data?.changes?.length ? result.data.changes : result?.data?.receipt?.resultData?.changes || [];
  for (const change of changes) {
    if (change?.item) character.syncInventoryItemForSession(session, change.item,
      change.previousData || change.previousState || {}, { emitCfgLocation: true });
  }
}
function recordReplacementCapsule(characterID, generation, capsule) {
  const record = getRecord(characterID);
  if (!active(record) || record.generation !== generation || !completing.has(Number(characterID)))
    throw new Error("HOME_CLONE_REPLACEMENT_OPERATION_MISMATCH");
  save({ ...record, replacementCapsule: capsule });
}
function complete(characterID, liveSession = null) {
  let record = getRecord(characterID);
  if (!active(record) || completing.has(characterID)) return;
  completing.add(characterID);
  const session = liveSession || { characterID, shipID: record.sourceShip.itemID,
    _abyssalOfflineSession: true, sendNotification() {}, sendSessionChange() {} };
  try {
    // Check the frozen destination before taking any irreversible leg. A lost
    // structure's normal home relocation owner can repair it before retry.
    if (!dockable(record.homeStationID, characterID)) {
      const row = character.peekCharacterRecord(characterID);
      const relocatedHome = Number(row?.homeStationID || row?.cloneStationID) || 0;
      if (relocatedHome === record.homeStationID || !dockable(relocatedHome, characterID))
        throw new Error("HOME_CLONE_DESTINATION_UNAVAILABLE");
      record = save({ ...record, homeStationID: relocatedHome });
    }
    if (record.state === "prepared") {
      const removal = check(require("../inventory/deathItemCustody").destroyItem({
        item: record.sourceShip, operationID: jobID(record), removeContents: true }));
      check(database.flushTableSync("items"));
      if (liveSession) syncRemoval(session, removal);
      record = save({ ...record, state: "capsule-removed" });
    }
    // The implant owner writes the removal receipt with the implant change in
    // the same character row, then idempotently finishes its inbox notification.
    check(require("../station/jumpCloneRuntime").clearActiveImplantsForPodDeath(session, {
      characterID, operationID: record.generation, locationID: record.sourceLocationID,
      emitNotifications: !!liveSession }));
    check(database.flushTablesSync(["characters", "notifications"]));
    record = save({ ...getRecord(characterID), state: "implants-removed" });
    const row = character.peekCharacterRecord(characterID);
    const ship = inventory.findItemById(Number(row?.shipID));
    // A crash after rookie activation leaves a valid final ship. Rebuilding
    // again would seed an unnecessary second capsule; only restore the session.
    if (ship && ship.itemID !== record.sourceShip.itemID && ship.ownerID === characterID &&
        ship.locationID === record.homeStationID && ship.flagID === inventory.ITEM_FLAGS.HANGAR &&
        Number(row.stationID || row.structureID) === record.homeStationID && !inventory.isCapsuleTypeID(ship.typeID)) {
      if (liveSession) check(character.applyCharacterToSession(session, characterID, {
        selectionEvent: false, deferDockedShipSessionChange: false,
        sessionChangeOptions: { reason: record.transitionReason } }));
    } else {
      check(require("../../space/transitions").rebuildDockedSessionAtStation(session, record.homeStationID, {
        emitNotifications: !!liveSession, boardNewbieShip: true, durableRecovery: true,
        homeCloneSelfDestructGeneration: record.generation,
        sessionChangeOptions: { reason: record.transitionReason },
        logSelection: false, newbieShipLogLabel: "HomeCloneSelfDestruct" }));
    }
    check(database.flushTablesSync(["items", "characters"]));
    const finalRow = character.peekCharacterRecord(characterID);
    const finalShip = inventory.findItemById(Number(finalRow?.shipID));
    if (!finalShip || finalShip.itemID === record.sourceShip.itemID || finalShip.ownerID !== characterID ||
        finalShip.locationID !== record.homeStationID || finalShip.flagID !== inventory.ITEM_FLAGS.HANGAR ||
        Number(finalRow.stationID || finalRow.structureID) !== record.homeStationID)
      throw new Error("HOME_CLONE_REBUILD_INCOMPLETE");
    // Boarding ordinarily consumes the temporary destination capsule. A crash
    // after character activation but before that items flush must finish this
    // leg too, instead of leaving a spare capsule on a skipped rebuild.
    const replacement = getRecord(characterID).replacementCapsule;
    if (replacement && finalShip.itemID !== replacement.itemID && inventory.findItemById(replacement.itemID)) {
      const removal = check(require("../inventory/deathItemCustody").destroyItem({ item: replacement,
        operationID: `${jobID(record)}:replacement`, removeContents: true }));
      check(database.flushTableSync("items"));
      if (liveSession) syncRemoval(session, removal);
    }
    save({ ...getRecord(characterID), state: "completed", resultShipID: finalShip.itemID,
      completedAtMs: getWallclockNowMs(), lastError: null });
  } catch (error) {
    record = getRecord(characterID);
    if (active(record)) save({ ...record, lastError: error.message });
    throw error;
  } finally {
    completing.delete(characterID);
  }
}
async function selfDestructClone(session) {
  let characterID = 0;
  try {
    const actor = actingCharacter(session);
    characterID = actor.characterID;
    let record = getRecord(characterID);
    if (!active(record)) record = prepare(session, characterID, actor.row);
    // The journal is durable before scheduling. Startup reconciliation repairs
    // a crash in this gap; custody starts after the scheduler accepts the job.
    await queueRecord(record);
    complete(characterID, registry.findSessionByCharacterID(characterID) === session &&
      registry.isRegisteredSession(session) && !session.socket?.destroyed && !session._characterControlDisconnected ? session : null);
    // Completion is already durable. A failed cancellation leaves a stale job
    // that safely acknowledges later; it must not turn success into a refusal.
    await queueRecord(getRecord(characterID)).catch(error =>
      require("../../utils/logger").warn(`[HomeCloneSelfDestruct] cancel char=${characterID}: ${error.message}`));
    return null;
  } catch (error) {
    if (error.machoErrorResponse?.payload?.header?.[0]?.value === ERROR_TYPE) throw error;
    require("../../utils/logger").warn(`[HomeCloneSelfDestruct] char=${characterID}: ${error.message}`);
    validation([0]);
  }
}
function recoverBeforeSelection(characterID) {
  if (active(getRecord(characterID)) && !completing.has(Number(characterID))) complete(Number(characterID));
}
function assertServiceActionAllowed(session, serviceName, method) {
  const characterID = resolveSessionCharacterID(session);
  if (!characterID || completing.has(characterID) || !active(getRecord(characterID))) return;
  if (serviceName === "home_station" && method === "self_destruct_clone") return;
  throwWrappedUserError("CustomNotify", { notify: "Your clone transfer is still being recovered. Please try again." });
}
function handleDurableSelfDestruct(job) {
  const characterID = Number(job?.payload?.characterID);
  const record = getRecord(characterID);
  if (!active(record) || record.generation !== job?.payload?.generation) return { success: true, stale: true };
  const session = registry.findSessionByCharacterID(characterID);
  complete(characterID, session && !session.socket?.destroyed && !session._characterControlDisconnected ? session : null);
  return { success: true };
}
async function reconcileDurableSelfDestructs() {
  let scheduled = 0;
  for (const characterID of character.listCharacterIDs()) {
    const record = getRecord(characterID);
    if (record) { await schedule(record); if (active(record)) scheduled += 1; }
  }
  return { scheduled };
}
async function idle() {
  while (pendingSchedules.size) await Promise.allSettled([...pendingSchedules]);
}
module.exports = { DURABLE_SELF_DESTRUCT_JOB_TYPE, selfDestructClone, getRecord, recoverBeforeSelection,
  recordReplacementCapsule,
  assertServiceActionAllowed, handleDurableSelfDestruct, reconcileDurableSelfDestructs, idle,
  bindDurableScheduler: binding.bind, unbindDurableScheduler: binding.unbind };
