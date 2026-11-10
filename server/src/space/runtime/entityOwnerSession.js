"use strict";

module.exports = {
  canEntityHaveOwningSession,
  getCombatNotificationSession,
  getOwningSessionForEntity,
};

const starbaseDefenseRuntime = require("../../services/starbase/starbaseDefenseRuntime");
const {
  toInt,
} = require("../../common/numbers");
const {
  lazyRequire,
} = require("./runtimeModuleBoundary");
const {
  getSceneKeyForSession,
  normalizeSceneText,
} = require("./sceneIdentity");
const {
  getControlledStaticStructureDogmaHosts,
  isControlledStaticStructureHostForSession,
} = require("./structureSessionHost");

function getCombatNotificationSession(entity) {
  if (starbaseDefenseRuntime.isStarbaseBattery(entity)) {
    return lazyRequire("../services/starbase/starbaseControlRuntime").getStarbaseControlObserver(entity);
  }
  return entity && entity.session && typeof entity.session.sendNotification === "function"
    ? entity.session
    : null;
}

function canEntityHaveOwningSession(entity) {
  return Boolean(
    entity && (
      (entity.kind === "ship" && entity.nativeNpc !== true) ||
      entity.kind === "structure" ||
      starbaseDefenseRuntime.isStarbaseBattery(entity)
    ),
  );
}

function getOwningSessionForEntity(scene, entity) {
  if (!scene || !(scene.sessions instanceof Map) || !entity) {
    return null;
  }
  if (starbaseDefenseRuntime.isStarbaseBattery(entity)) {
    return getCombatNotificationSession(entity)
      ? starbaseDefenseRuntime.getBatterySession(scene, entity) : null;
  }

  const shipID = toInt(entity.itemID, 0);
  const isDynamicEntity = Boolean(
    shipID > 0 &&
      scene.dynamicEntities instanceof Map &&
      scene.dynamicEntities.get(shipID) === entity,
  );
  const isControlledStaticStructure = Boolean(
    shipID > 0 &&
      scene.staticEntitiesByID instanceof Map &&
      scene.staticEntitiesByID.get(shipID) === entity &&
      getControlledStaticStructureDogmaHosts(scene).includes(entity),
  );
  if (
    shipID <= 0 ||
    (!isDynamicEntity && !isControlledStaticStructure)
  ) {
    return null;
  }

  const sceneKey = normalizeSceneText(scene.sceneKey, "");
  const sceneSessions = new Set(scene.sessions.values());
  const isExactOwnerSession = (session) => Boolean(
    session &&
      sceneSessions.has(session) &&
      getSceneKeyForSession(session) === sceneKey &&
      toInt(session._space && session._space.shipID, 0) === shipID &&
      (
        isDynamicEntity ||
        isControlledStaticStructureHostForSession(scene, session, entity)
      )
  );

  if (isExactOwnerSession(entity.session)) {
    return entity.session;
  }

  for (const session of scene.sessions.values()) {
    if (isExactOwnerSession(session)) {
      return session;
    }
  }
  return null;
}
