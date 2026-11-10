"use strict";

// playerOwned.py:428-467,501; playerOwnedTargetMgr.py:94-109. Control is a
// session-local grant, never a persisted owner change or an active-ship swap.
const defense = require("./starbaseDefenseRuntime");
const inventory = require("../inventory/itemStore");
const authority = require("../corporation/corporationAuthority");
const skills = require("../skills/skillState");
const { TABLE, readStaticTable } = require("../_shared/referenceData");
const { canEntitiesInteractLocally } = require("../../space/destiny/identity/interactionScope");
const grants = new Map();
const CONTROL_ROLE = 144115188075855872n; // appConst.py:365
const CONTROL_SKILL = 3373;
const CONTROL_AMOUNT_ATTRIBUTE = 1174;
const CONTROL_DISTANCE_ATTRIBUTE = 1214;
const number = (value) => Number(value) || 0;
const fail = (errorMsg, data) => ({ success: false, errorMsg, data });
const success = (data) => ({ success: true, data });

function getStarbaseControlAmount(characterID) {
  if (!(number(characterID) > 0)) return 0;
  // Pinned effect 2918: add skillLevel (280) to charID attribute 1174. No
  // gunnery, implant, or ship bonuses belong on the separately operated gun.
  const skill = skills.getCachedCharacterSkillMap(characterID).get(CONTROL_SKILL);
  return Math.max(0, Math.min(5, Math.trunc(number(skill && (skill.skillLevel ?? skill.level)))));
}

function validateEnvironment(session, batteryID) {
  const scene = require("../../space/runtime").getSceneForSession(session);
  const prepared = defense.prepareBatteryActor(scene, batteryID);
  if (!prepared.success) return prepared;
  const { item, tower, entity, profile } = prepared.data;
  if (!Object.hasOwn(profile.attributes, "1167")) return fail("STARBASE_NOT_CONTROLLABLE");
  const member = authority.getPersistedCorporationAuthority(session);
  if (!member || number(member.corporationID) !== number(tower.ownerID)) return fail("STARBASE_CONTROL_CORPORATION_REQUIRED");
  if (!member.isCEO && !authority.corporationAuthorityHasRole(member, CONTROL_ROLE)) return fail("STARBASE_CONTROL_ROLE_REQUIRED");
  const amount = getStarbaseControlAmount(member.characterID);
  if (!amount) return fail("STARBASE_CONTROL_SKILL_REQUIRED");
  const shipID = number(session && session._space && session._space.shipID);
  const shipItem = inventory.findItemById(shipID);
  const ship = scene && scene.getEntityByID(shipID);
  const towerEntity = scene && scene.getEntityByID(number(tower.itemID));
  if (!shipItem || number(shipItem.ownerID) !== number(member.characterID) ||
      number(shipItem.categoryID) !== 6 || number(shipItem.locationID) !== number(scene.systemID) ||
      !ship || !towerEntity || number(session._space.systemID) !== number(scene.systemID) ||
      session.socket && session.socket.destroyed || session.disconnected === true ||
      number(session.stationID || session.stationid) > 0 || ship.cloaked || ship.isCloaked ||
      ship.destroyed || ship.destroying || ["destroying", "destroyed"].includes(ship.destructionState) || ship.pendingDock ||
      (ship.session !== session && !(scene.sessions instanceof Map && [...scene.sessions.values()].includes(session))) ||
      String(ship.mode || "").toUpperCase() === "WARP" ||
      !canEntitiesInteractLocally(ship, entity) || !canEntitiesInteractLocally(ship, towerEntity) ||
      (typeof scene.canSessionSeeDungeonScopedEntity === "function" && !scene.canSessionSeeDungeonScopedEntity(session, entity))) {
    return fail("STARBASE_CONTROL_SHIP_UNAVAILABLE");
  }
  const row = readStaticTable(TABLE.TYPE_DOGMA).typesByTypeID[tower.typeID];
  const maxDistance = number(row && row.attributes[CONTROL_DISTANCE_ATTRIBUTE]);
  const distance = typeof scene.getEntitySurfaceDistance === "function"
    ? scene.getEntitySurfaceDistance(ship, towerEntity)
    : Math.max(0, Math.hypot(...["x", "y", "z"].map((key) =>
      Number(ship.position && ship.position[key]) - Number(towerEntity.position && towerEntity.position[key]))) -
      Math.max(0, number(ship.radius)) - Math.max(0, number(towerEntity.radius)));
  if (!maxDistance || !Number.isFinite(distance) || distance > maxDistance) return fail("STARBASE_CONTROL_TOO_FAR", { maxDistance });
  return success({ scene, item, entity, tower, shipID, member, amount });
}

function notifyStarbaseTargetEvent(entity, what, targetID = null, reason = null) {
  const grant = grants.get(number(entity && entity.itemID));
  if (!grant || grant.entity !== entity || number(entity.controllerID) !== grant.characterID) return false;
  grant.session.sendNotification?.("OnTargetOBO", "charid", [what, entity.itemID, targetID, reason]);
  return true;
}

function getStarbaseControlObserver(entity) {
  const grant = grants.get(number(entity && entity.itemID));
  return grant && grant.entity === entity && number(entity.controllerID) === grant.characterID
    ? grant.session : null;
}

function releaseGrant(grant, reason = "relinquished") {
  if (!grant || grants.get(grant.entity.itemID) !== grant || grant.releasing) return false;
  grant.releasing = true;
  // Stop before removing the grant so effect-end and target-loss notifications
  // still reach the original gunner; other pilots never receive OBO target IDs.
  const safely = (callback) => {
    try { callback(); } catch (error) {
      require("../../utils/logger").warn(`[StarbaseControl] release battery=${grant.entity.itemID}: ${error.message}`);
    }
  };
  try {
    safely(() => defense.stopBattery(grant.scene, grant.entity.itemID, { reason }));
    // Source-object cleanup also works if destruction already removed the
    // entity from its scene, or a socket callback interrupted normal cleanup.
    for (const targetID of [...(grant.entity.pendingTargetLocks?.keys() || [])]) {
      safely(() => grant.scene.cancelPendingTargetLock(grant.entity, targetID, { notifySelf: false, reason }));
    }
    for (const targetID of [...(grant.entity.lockedTargets?.keys() || [])]) {
      safely(() => grant.scene.removeLockedTarget(grant.entity, targetID, { notifySelf: false, reason }));
    }
    safely(() => notifyStarbaseTargetEvent(grant.entity, "clear", null, reason));
  } finally {
    grants.delete(grant.entity.itemID);
    grant.entity.controllerID = null;
    safely(() => grant.scene.broadcastSlimItemChanges?.([grant.entity]));
  }
  return true;
}

function refreshStarbaseControlGrants(scene) {
  const counts = new Map();
  for (const grant of [...grants.values()]) {
    if (grant.scene !== scene || grant.releasing) continue;
    const current = validateEnvironment(grant.session, grant.entity.itemID);
    const count = (counts.get(grant.characterID) || 0) + 1;
    if (!current.success || current.data.entity !== grant.entity ||
        current.data.shipID !== grant.shipID || current.data.member.characterID !== grant.characterID ||
        number(grant.entity.controllerID) !== grant.characterID || count > current.data.amount) {
      releaseGrant(grant, current.errorMsg || "controlChanged");
      continue;
    }
    counts.set(grant.characterID, count);
    const session = defense.getBatterySession(scene, grant.entity);
    for (const targetID of new Set([...(grant.entity.lockedTargets?.keys() || []),
      ...(grant.entity.pendingTargetLocks?.keys() || [])])) {
      const target = scene.getEntityByID(number(targetID));
      const valid = target && scene.validateTargetLockRequest(session, grant.entity, target, { ignoreCapacity: true });
      if (!valid || !valid.success) {
        if (grant.entity.pendingTargetLocks?.has(targetID)) scene.cancelAddTarget(session, targetID, { reason: "targetLost", notifySelf: true });
        scene.removeTarget(session, targetID, { reason: "targetLost" });
      }
    }
  }
}

function assumeStructureControl(session, batteryID) {
  const context = validateEnvironment(session, batteryID);
  if (!context.success) return context;
  const { scene, entity, member, amount, shipID } = context.data;
  refreshStarbaseControlGrants(scene);
  if (grants.has(number(batteryID)) || number(entity.controllerID) > 0) return fail("STARBASE_STRUCTURE_CONTROLLED");
  const count = [...grants.values()].filter((grant) => grant.characterID === number(member.characterID)).length;
  if (count >= amount) return fail("STARBASE_CONTROL_LIMIT_REACHED", { amount });
  defense.stopBattery(scene, batteryID, { reason: "manualControl" });
  const grant = { session, scene, entity, characterID: number(member.characterID), shipID };
  grants.set(number(batteryID), grant);
  entity.controllerID = grant.characterID;
  scene.broadcastSlimItemChanges?.([entity]);
  return success({ itemID: number(batteryID), controllerID: grant.characterID });
}

function getControlledContext(session, batteryID) {
  const grant = grants.get(number(batteryID));
  if (!grant || grant.session !== session || grant.characterID !== number(session && (session.characterID || session.charid))) {
    return fail("STARBASE_CONTROL_REQUIRED");
  }
  refreshStarbaseControlGrants(grant.scene);
  if (grants.get(number(batteryID)) !== grant) return fail("STARBASE_CONTROL_REQUIRED");
  return success(grant);
}

function sessionHoldsControlGrant(session) {
  for (const grant of grants.values()) {
    if (grant.session === session) return true;
  }
  return false;
}

function getControlledBatteryContext(session, itemOrID) {
  // Dogma asks this for every charge and every item a pilot does not own. Only a
  // control grant held by this session can make the answer non-null, so check
  // that before reading, and copying, the item.
  if (!sessionHoldsControlGrant(session)) return null;
  const item = inventory.findItemById(number(itemOrID && itemOrID.itemID || itemOrID));
  const batteryID = item && defense.isStarbaseBattery(item) ? item.itemID
    : item && number(item.categoryID) === 8 && number(item.flagID) === 27 ? item.locationID : 0;
  const result = batteryID && getControlledContext(session, batteryID);
  return result && result.success ? { ...result.data, item } : null;
}

function getVisibleOwnedTower(session, itemOrID) {
  const item = inventory.findStarbaseItemById(number(itemOrID && itemOrID.itemID || itemOrID));
  if (!item || number(item.categoryID) !== 23 || number(item.groupID) !== 365) return null;
  const member = authority.getPersistedCorporationAuthority(session);
  const scene = require("../../space/runtime").getSceneForSession(session);
  const shipID = number(session && session._space && session._space.shipID);
  const ship = scene && scene.getEntityByID(shipID);
  const shipItem = inventory.findItemById(shipID);
  const entity = scene && scene.getEntityByID(item.itemID);
  return member && number(member.corporationID) === number(item.ownerID) &&
    scene && number(session._space.systemID) === number(scene.systemID) &&
    number(item.locationID) === number(scene.systemID) && number(item.flagID) === 0 &&
    shipItem && number(shipItem.ownerID) === number(member.characterID) && entity && ship &&
    canEntitiesInteractLocally(ship, entity) &&
    (typeof scene.canSessionSeeDungeonScopedEntity !== "function" || scene.canSessionSeeDungeonScopedEntity(session, entity)) ? item : null;
}

function relinquishStructureControl(session, batteryID) {
  const grant = grants.get(number(batteryID));
  // The client relinquishes again when a battery vanishes from its ballpark.
  if (!grant) return success({ released: false });
  if (grant.session !== session) return fail("STARBASE_CONTROL_REQUIRED");
  return success({ released: releaseGrant(grant) });
}

function releaseStarbaseControlForSession(session) {
  let released = 0;
  for (const grant of [...grants.values()]) if (grant.session === session) released += Number(releaseGrant(grant, "sessionEnded"));
  return released;
}

function addTargetOBO(session, batteryID, targetID) {
  const controlled = getControlledContext(session, batteryID);
  if (!controlled.success) return controlled;
  const { scene, entity } = controlled.data;
  return scene.addTarget(defense.getBatterySession(scene, entity), number(targetID));
}

function removeTargetOBO(session, batteryID, targetID) {
  const controlled = getControlledContext(session, batteryID);
  if (!controlled.success) return controlled;
  const { scene, entity } = controlled.data;
  if (entity.pendingTargetLocks?.has(number(targetID))) {
    scene.cancelAddTarget(defense.getBatterySession(scene, entity), number(targetID), { notifySelf: true });
  }
  return scene.removeTarget(defense.getBatterySession(scene, entity), number(targetID), { notifySelf: true, notifyTarget: true });
}

function activateControlledBattery(session, batteryID, effectName, targetID) {
  const controlled = getControlledContext(session, batteryID);
  if (!controlled.success) return controlled;
  const { scene, entity } = controlled.data;
  const profile = defense.getBatteryProfile(inventory.findItemById(batteryID));
  if (!profile || String(effectName).toLowerCase() !== profile.effectName.toLowerCase()) return fail("STARBASE_CONTROL_EFFECT_INVALID");
  // Activate cannot manufacture an OBO lock; the client first locks via AddTargetOBO.
  if (!entity.lockedTargets?.has(number(targetID))) return fail("TARGET_NOT_LOCKED");
  return defense.activateBattery(scene, batteryID, targetID, { automatic: false });
}

function deactivateControlledBattery(session, batteryID, effectName) {
  const controlled = getControlledContext(session, batteryID);
  if (!controlled.success) return controlled;
  const { scene, entity } = controlled.data;
  const profile = defense.getBatteryProfile(inventory.findItemById(batteryID));
  if (!profile || String(effectName).toLowerCase() !== profile.effectName.toLowerCase()) return fail("STARBASE_CONTROL_EFFECT_INVALID");
  // Deactivation keeps the lock and the control grant, unlike relinquishment.
  return scene.deactivateGenericModule(defense.getBatterySession(scene, entity), number(batteryID), { deferUntilCycle: false });
}

function resetStarbaseControlForTests() {
  for (const grant of [...grants.values()]) releaseGrant(grant, "reset");
  grants.clear();
}

function requireStarbaseControlResult(result) {
  if (result && result.success) return result.data;
  const messages = {
    STARBASE_CONTROL_CORPORATION_REQUIRED: "Only members of the corporation that owns this starbase can control its batteries.",
    STARBASE_CONTROL_ROLE_REQUIRED: "You need the Infrastructure Tactical Officer corporation role to control starbase batteries.",
    STARBASE_CONTROL_SKILL_REQUIRED: "Train Starbase Defense Management to control starbase batteries.",
    STARBASE_CONTROL_LIMIT_REACHED: "You are already controlling the maximum number of batteries allowed by Starbase Defense Management.",
    STARBASE_CONTROL_TOO_FAR: "Move within 15,000 meters of the control tower to control its batteries.",
    STARBASE_CONTROL_SHIP_UNAVAILABLE: "Your ship must remain visible and in space near the control tower to control its batteries.",
    STARBASE_STRUCTURE_CONTROLLED: "That starbase battery is already controlled by a pilot.",
    STARBASE_CONTROL_REQUIRED: "You must assume control of this starbase battery before operating it.",
    STARBASE_CONTROL_EFFECT_INVALID: "That effect cannot be activated on this starbase battery.",
    MODULE_NOT_ONLINE: "The starbase battery must be online before you can control it.",
    MODULE_INCAPACITATED: "An incapacitated starbase battery cannot be controlled.",
    CONTROL_TOWER_NOT_ONLINE: "The control tower must be online before you can control its batteries.",
    TARGET_NOT_LOCKED: "The starbase battery must lock that target before firing.",
  };
  require("../../common/machoErrors").throwWrappedUserError("CustomNotify", {
    notify: messages[result && result.errorMsg] || "The starbase battery cannot perform that operation in its current state.",
  });
}

module.exports = {
  CONTROL_ROLE, CONTROL_SKILL, CONTROL_AMOUNT_ATTRIBUTE, CONTROL_DISTANCE_ATTRIBUTE,
  getStarbaseControlAmount, assumeStructureControl, relinquishStructureControl,
  addTargetOBO, removeTargetOBO, activateControlledBattery, deactivateControlledBattery,
  refreshStarbaseControlGrants, releaseStarbaseControlForSession,
  notifyStarbaseTargetEvent, getStarbaseControlObserver, resetStarbaseControlForTests,
  getControlledBatteryContext, getVisibleOwnedTower, requireStarbaseControlResult,
};
