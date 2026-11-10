"use strict";

const { distance } = require("../../common/vector");
const { isShipInsideForceField } = require("../../space/runtime/forceFieldContainment");
const { resolveCurrentDungeonForSession } = require("../dungeon/dungeonTrackingRuntime");
const { matchesTypeList } = require("../inventory/typeListAuthority");
const { getSafetyLevel, SAFETY_LEVEL_FULL } = require("../security/crimewatchState");
const { actorErrors, collectActorContext, getKey, keyErrors } = require("./filamentAdmission");

// Supported client 3396210, voidspaceencounters[79997] and typelist[325].
// The inventory type is now in the expired group. The replay can explicitly
// authorize this one type while the stock client keeps that classification.
const RUINED_ELECTRICAL = Object.freeze({
  filamentTypeID: 79997,
  filamentGroupID: 4776,
  dungeonID: 10594,
  templateID: "client-dungeon:10594",
  allowedHullListID: 325,
  nebulaGraphicID: 22041,
  originGateTypeID: 80944,
  durationMs: 30 * 60 * 1000,
  activationDelayMs: 8000,
});

const PROXIMITY_TYPE_LIST_ID = 50;
const PROXIMITY_RANGE_M = 1_000_000;

// voidspace.common.error.VoidSpaceJumpError. The trailing codes are specific
// to Void and cannot be shared with the Proving Grounds error vocabulary.
const E = Object.freeze({
  IN_ABYSS_SYSTEM: 1,
  INVALID_KEY_TYPE: 2,
  INVALID_OWNER: 3,
  INVALID_SHIP_TYPE: 4,
  ITEM_NOT_REACHABLE: 5,
  KEY_NOT_FOUND: 6,
  PROXIMITY_RESTRICTION: 7,
  PVP_TIMER_ACTIVE: 8,
  SAFETY_ENGAGED: 9,
  SESSION_CHANGE_IN_PROGRESS: 10,
  INVALID_KEY_AMOUNT: 11,
  SHIP_IN_DUNGEON: 12,
  SHIP_IN_FORCE_FIELD: 13,
  SHIP_IN_WARP: 14,
  SHIP_IS_CLOAKED: 15,
  SHIP_IS_DOCKED: 16,
  SHIP_IS_INVULNERABLE: 17,
  SHIP_IS_SELF_DESTRUCTING: 18,
  SHIP_IS_TETHERED: 19,
  SHIP_IS_WARP_SCRAMBLED: 20,
  SHIP_NOT_FOUND: 21,
  UNKNOWN_ERROR: 22,
  VOID_SPACE_DISALLOWED: 30,
});

function isVoidSystemID(systemID) {
  return Number.isInteger(systemID) && systemID >= 34_000_000 && systemID < 35_000_000;
}

function findProximityBlocker(scene, ship) {
  for (const entities of [scene.staticEntitiesByID, scene.dynamicEntities]) {
    for (const entity of entities.values()) {
      if (entity !== ship && entity.position &&
          distance(entity.position, ship.position) < PROXIMITY_RANGE_M &&
          matchesTypeList(entity, PROXIMITY_TYPE_LIST_ID)) {
        return entity;
      }
    }
  }
  return null;
}

function validateReplayAdmission(itemID, typeID, session, nowMs) {
  if (typeID !== RUINED_ELECTRICAL.filamentTypeID) {
    return { errors: [[E.VOID_SPACE_DISALLOWED, []]] };
  }
  const actor = collectActorContext(session, nowMs);
  const key = getKey(itemID);
  const errors = [
    ...keyErrors(actor, key, typeID, RUINED_ELECTRICAL.filamentGroupID, E),
    ...actorErrors(actor, E),
  ];
  const add = (code, args = [actor.characterID]) => errors.push([code, args]);
  if (actor.shipItem && !matchesTypeList(actor.shipItem, RUINED_ELECTRICAL.allowedHullListID)) {
    add(E.INVALID_SHIP_TYPE);
  }
  if (actor.liveShipValid) {
    if (isVoidSystemID(actor.scene.systemID)) add(E.VOID_SPACE_DISALLOWED, []);
    if (getSafetyLevel(actor.characterID) === SAFETY_LEVEL_FULL) add(E.SAFETY_ENGAGED);
    if (resolveCurrentDungeonForSession(actor.scene, session)) add(E.SHIP_IN_DUNGEON);
    if (isShipInsideForceField(actor.scene, actor.ship)) add(E.SHIP_IN_FORCE_FIELD);
    const blocker = findProximityBlocker(actor.scene, actor.ship);
    if (blocker) add(E.PROXIMITY_RESTRICTION, [blocker.typeID, actor.characterID]);
  }
  return { errors, actor, key };
}

module.exports = {
  RUINED_ELECTRICAL,
  VOID_SPACE_JUMP_ERROR: E,
  isVoidSystemID,
  validateReplayAdmission,
};
