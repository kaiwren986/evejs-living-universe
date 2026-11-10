"use strict";

const catalog = require("./pvpEventCatalog");
const admission = require("./filamentAdmission");
const E = require("./pvpJumpErrors");
const registry = require("../chat/sessionRegistry");
const { matchesTypeList } = require("../inventory/typeListAuthority");
const { getItemMetadata } = require("../inventory/itemStore");
const { getFittedModuleItems, getTypeAttributeValue } = require("../fitting/liveFittingState");
const { getActiveImplants } = require("../dogma/implants/activeImplantModifiers");
const { getWallclockNowMs } = require("../../space/runtime/runtimeClock");
const { buildList } = require("../_shared/serviceHelpers");
const log = require("../../utils/logger");

const RANGE_METERS = 1_000_000;
// Authority is attached to the exact live scene and exact captured transports.
// Numeric IDs are lookup indexes within that scene, never process-global owners.
const scenes = new WeakMap();
// A cleanup index, keyed by the exact fleet object. Scene records remain the
// sole queue authority. Ordinary fleet operations must not boot space runtime.
const fleetScenes = new WeakMap();
function state(scene) {
  let value = scenes.get(scene);
  if (!value) { value = { records: new Set(), byCharacter: new Map(), pending: new Set() }; scenes.set(scene, value); }
  return value;
}
function currentScene(scene) {
  return Boolean(scene && require("../../space/runtime").scenes.get(scene.sceneKey) === scene);
}
function memberContexts(fleet, owner, nowMs) {
  return [...fleet.members.values()].sort((a, b) => a.charID - b.charID).map((member) => {
    const session = member.charID === owner.characterID ? owner.session : registry.findSessionByCharacterID(member.charID);
    const context = admission.collectActorContext(session, nowMs);
    // Keep missing/offline members in the fleet shape; do not filter them away.
    return { ...context, characterID: Number(member.charID), member };
  });
}
function participantErrors(contexts, owner, event) {
  const errors = [], add = (code, args = []) => errors.push([code, args]);
  for (const actor of contexts) {
    errors.push(...admission.actorErrors(actor, E));
    if (actor.shipItem && !matchesTypeList({ typeID: actor.shipItem.typeID }, event.shipRestrictions)) {
      add(E.INVALID_SHIP_TYPE, [actor.characterID]);
    }
    if (actor.characterID !== owner.characterID) {
      const left = owner.ship?.position, right = actor.ship?.position;
      const distance = left && right && Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
      if (actor.scene !== owner.scene || !Number.isFinite(distance) || distance > RANGE_METERS) {
        add(E.FLEET_MEMBER_NOT_IN_RANGE, [actor.characterID, RANGE_METERS]);
      }
    }
  }
  for (const [field, attribute, code] of [
    ["maxOfShipTypeRestriction", "typeID", E.MAX_OF_SHIP_TYPE_RESTRICTIONS],
    ["maxOfShipGroupRestriction", "groupID", E.MAX_OF_SHIP_GROUP_RESTRICTIONS],
  ]) {
    const limit = event[field], counts = new Map();
    if (limit <= 0) continue;
    for (const actor of contexts) {
      const id = getItemMetadata(actor.shipItem?.typeID)?.[attribute];
      if (!id) continue;
      const count = (counts.get(id) || 0) + 1; counts.set(id, count);
      if (count > limit) { add(code, [limit, id]); break; }
    }
  }
  for (const actor of contexts) {
    if (!actor.custodyValid) continue;
    const modules = getFittedModuleItems(actor.characterID, actor.shipID);
    const banned = event.bannedModulesTypeListID && modules.find((item) => matchesTypeList(item, event.bannedModulesTypeListID));
    if (banned) add(E.BANNED_MODULES_RESTRICTIONS, [Number(banned.typeID), actor.characterID]);
    const limited = event.limitedAmountOfModulesTypeListID
      ? modules.filter((item) => matchesTypeList(item, event.limitedAmountOfModulesTypeListID)) : [];
    if (limited.length > event.numberOfLimitedModules) {
      add(E.LIMITED_NUMBER_OF_MODULES_RESTRICTION, [Number(limited[0].typeID), actor.characterID, event.numberOfLimitedModules]);
    }
    const cap = event.moduleAndImplantMetaLevelRestrictions;
    if (cap > 0 && [...modules, ...getActiveImplants(actor.characterID)].some((item) =>
      Number(getTypeAttributeValue(item.typeID, "metaLevel", "metaLevelOld") || 0) > cap)) add(E.MODULE_AND_IMPLANT_RESTRICTIONS);
  }
  return errors;
}
function validateJoin(itemID, typeID, session, nowMs = getWallclockNowMs()) {
  const event = catalog.getActiveEventByFilamentTypeID(typeID, nowMs);
  if (!event) return { errors: [[E.EVENT_NOT_ACTIVE, []]] };
  const owner = admission.collectActorContext(session, nowMs);
  const key = admission.getKey(itemID);
  const errors = admission.keyErrors(owner, key, typeID, 4050, E);
  const fleetRuntime = require("../fleets/fleetRuntime");
  const fleet = fleetRuntime.getFleetForCharacter(owner.characterID);
  const contexts = fleet ? memberContexts(fleet, owner, nowMs) : [owner];
  if (!fleet || !fleet.members.has(owner.characterID)) errors.push([E.SHIP_NOT_IN_FLEET, []]);
  else {
    if ((fleet.members.get(owner.characterID).job & fleetRuntime.FLEET.FLEET_JOB_CREATOR) === 0) errors.push([E.FLEET_ROLES_NEEDED, []]);
    if (fleet.members.size < event.fleetSize) errors.push([E.TOO_FEW_IN_FLEET, [event.fleetSize]]);
    if (fleet.members.size > event.fleetSize) errors.push([E.TOO_MANY_IN_FLEET, [event.fleetSize]]);
  }
  // Refuse a conflicting entry owned by ANY participant, including another fleet.
  if (contexts.some((actor) => {
    const value = actor.scene && scenes.get(actor.scene);
    return value?.byCharacter.has(actor.characterID) || [...(value?.pending || [])]
      .some((notice) => notice.session === actor.session && notice.characterID === actor.characterID);
  })) {
    errors.unshift([E.ALREADY_IN_QUEUE, []]);
  }
  errors.push(...participantErrors(contexts, owner, event));
  return { errors, event, owner, key, fleet, contexts };
}
function publishPending(scene, value) {
  for (const notice of [...value.pending]) {
    const { session, characterID, errors } = notice;
    if (!registry.isRegisteredSession(session) || session.socket?.destroyed ||
      registry.resolveSessionCharacterID(session) !== characterID) { value.pending.delete(notice); continue; }
    try {
      session.sendNotification("OnMatchMakingFailure", "clientID", [buildList(errors)]);
      value.pending.delete(notice);
    } catch (error) { log.warn(`[PvpFilaments] Queue exit notification pending: ${error.message}`); }
  }
}
function clearRecord(scene, record, errors, reason) {
  const value = scenes.get(scene);
  if (!value?.records.delete(record)) return false;
  if (![...value.records].some((entry) => entry.fleet === record.fleet)) {
    const indexed = fleetScenes.get(record.fleet);
    indexed?.delete(scene);
    if (!indexed?.size) fleetScenes.delete(record.fleet);
  }
  for (const actor of record.contexts) {
    if (value.byCharacter.get(actor.characterID) === record) value.byCharacter.delete(actor.characterID);
    value.pending.add({ session: actor.session, characterID: actor.characterID, errors });
  }
  record.status = "departed"; record.exitReason = reason;
  publishPending(scene, value);
  return true;
}
function join(itemID, typeID, session) {
  const validation = validateJoin(itemID, typeID, session);
  if (validation.errors.length) return { success: false, errors: validation.errors };
  const { owner, fleet, contexts, event } = validation;
  const record = { owner, fleet, contexts, itemID, typeID, matchTypeID: event.matchTypeID,
    scheduleID: event.scheduleID, status: "queued_no_match_runtime" };
  const value = state(owner.scene); value.records.add(record);
  let indexed = fleetScenes.get(fleet);
  if (!indexed) { indexed = new Set(); fleetScenes.set(fleet, indexed); }
  indexed.add(owner.scene);
  for (const actor of contexts) value.byCharacter.set(actor.characterID, record);
  // Native donor partial estimate. This is not an estimate for a playable arena.
  return { success: true, estimatedQueueTime: 0 };
}
function leave(session) {
  const actor = admission.collectActorContext(session);
  const record = actor.scene && scenes.get(actor.scene)?.byCharacter.get(actor.characterID);
  if (!record || !record.contexts.some((captured) => captured.session === session && captured.characterID === actor.characterID)) return false;
  return clearRecord(actor.scene, record, [[E.UNKNOWN_ERROR, []]], "participant_left");
}
function tickScene(scene) {
  const value = scenes.get(scene);
  if (!value) return;
  if (!currentScene(scene)) { disposeScene(scene); return; }
  for (const record of [...value.records]) {
    let validation;
    try { validation = validateJoin(record.itemID, record.typeID, record.owner.session); }
    catch (error) {
      // Missing/corrupt authority cannot strand an admitted fleet indefinitely.
      // No gameplay has settled: clear the transient entry and report failure.
      log.warn(`[PvpFilaments] Queue revalidation failed: ${error.message}`);
      clearRecord(scene, record, [[E.UNKNOWN_ERROR, []]], "validation_unavailable");
      continue;
    }
    const errors = validation.errors.filter(([code]) => code !== E.ALREADY_IN_QUEUE);
    const captured = record.contexts;
    const changed = validation.fleet !== record.fleet || validation.contexts?.length !== captured.length ||
      validation.contexts?.some((actor) => !captured.some((old) => old.characterID === actor.characterID &&
        old.session === actor.session && old.ship === actor.ship && old.shipID === actor.shipID && old.member === actor.member));
    if (changed && !errors.some(([code]) => code === E.EVENT_NOT_ACTIVE)) errors.unshift([E.FLEET_SIZE_CHANGED, []]);
    clearRecord(scene, record, errors.length ? errors : [[E.UNKNOWN_ERROR, []]],
      errors.length ? "admission_changed" : "match_runtime_unavailable");
  }
  publishPending(scene, value);
}
function handleSessionDisconnected(session) {
  const scene = require("../../space/runtime").getSceneForSession(session);
  const value = scene && scenes.get(scene);
  if (!value) return;
  for (const record of [...value.records]) if (record.contexts.some((actor) => actor.session === session)) {
    clearRecord(scene, record, [[E.SHIP_NOT_FOUND, []]], "participant_disconnected");
  }
  for (const notice of [...value.pending]) if (notice.session === session) value.pending.delete(notice);
}
function handleEntityRemoved(scene, entity) {
  const value = scenes.get(scene);
  for (const record of [...(value?.records || [])]) if (record.contexts.some((actor) => actor.ship === entity)) {
    clearRecord(scene, record, [[E.SHIP_NOT_FOUND, []]], "ship_departed");
  }
}
function handleFleetChanged(fleet) {
  for (const scene of [...(fleetScenes.get(fleet) || [])]) {
    const value = scenes.get(scene);
    for (const record of [...(value?.records || [])]) if (record.fleet === fleet) {
      clearRecord(scene, record, [[E.FLEET_SIZE_CHANGED, []]], "fleet_changed");
    }
  }
}
function disposeScene(scene) {
  const value = scenes.get(scene);
  for (const record of [...(value?.records || [])]) clearRecord(scene, record, [[E.SHIP_NOT_FOUND, []]], "scene_disposed");
  scenes.delete(scene);
}
function getDiagnostics(scene) {
  const value = scenes.get(scene);
  return { records: [...(value?.records || [])].map((record) => ({ status: record.status,
    matchTypeID: record.matchTypeID, scheduleID: record.scheduleID, ownerCharacterID: record.owner.characterID,
    characterIDs: record.contexts.map((actor) => actor.characterID), itemID: record.itemID })),
    pendingNotifications: value?.pending.size || 0 };
}
module.exports = { join, leave, tickScene, handleSessionDisconnected, handleEntityRemoved,
  handleFleetChanged, disposeScene, getDiagnostics };
