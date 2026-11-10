"use strict";

// POS batteries are inventory-backed space actors, not modules fitted to the
// gunner's ship. This adapter supplies a non-persisted self-module view to the
// common targeting/weapon/EWAR engine; it never creates or moves an item.
const { findItemById, listContainerItems } = require("../inventory/itemStore");
const { resolveItemByTypeID } = require("../inventory/itemTypeRegistry");
const { TABLE, readStaticTable } = require("../_shared/referenceData");
const resources = require("./starbaseResourceRuntime");

const BATTERY_GROUPS = Object.freeze({
  426: "projectileTurret", 449: "hybridTurret", 430: "laserTurret",
  417: "missileLauncher", 439: "ecm", 441: "web", 440: "sensorDamp",
  443: "warpDisrupt", 837: "energyNeutralizer", 444: "shieldHardener",
});
const WEAPON_FAMILIES = new Set([
  "projectileTurret", "hybridTurret", "laserTurret", "missileLauncher",
]);
const FLAG_CHARGES = 27;
const number = (value, fallback = 0) => Number.isFinite(Number(value))
  ? Number(value) : fallback;

function getBatteryProfile(itemOrType) {
  const typeID = number(itemOrType && itemOrType.typeID || itemOrType);
  const metadata = resolveItemByTypeID(typeID);
  const family = metadata && number(metadata.categoryID) === 23
    ? BATTERY_GROUPS[number(metadata.groupID)] : null;
  if (!family) return null;
  const table = readStaticTable(TABLE.TYPE_DOGMA) || {};
  const row = table.typesByTypeID && table.typesByTypeID[typeID];
  if (!row) return null;
  const effects = (row.effects || []).map((id) => table.effectTypesByID[id]);
  const effect = effects.find((entry) => entry && entry.isOffensive === true) || null;
  return {
    typeID, groupID: number(metadata.groupID), family,
    weaponFamily: WEAPON_FAMILIES.has(family) ? family : null,
    passive: family === "shieldHardener",
    effectName: effect && effect.name || null,
    effectID: number(effect && effect.effectID),
    attributes: row.attributes || {},
  };
}

function isStarbaseBattery(item) {
  return Boolean(item && number(item.categoryID) === 23 &&
    BATTERY_GROUPS[number(item.groupID)] && number(item.groupID) !== 444);
}

function hasUnavailableHealth(item) {
  if (!item) return true;
  const state = item && item.spaceState || {};
  const condition = item && item.conditionState || {};
  // itemStore.normalizeShipConditionState, shared combat and posGmState all
  // store hull damage as a fraction, not raw hitpoints. A retained zero-hull
  // row cannot operate merely because its asynchronous removal has not run.
  return condition.incapacitated === true || number(state.incapacitated) === 1 ||
    Boolean(state.starbaseModuleState && state.starbaseModuleState.destruction) ||
    item.destroyed === true || state.destroyed === true ||
    ["destroyed", "destroying"].includes(String(item.destructionState || state.destructionState)) ||
    number(condition.damage) >= 1;
}

function validateBatteryOperation(itemOrID) {
  // Never trust a caller's hydrated object across online/offline/destruction.
  const item = findItemById(number(itemOrID && itemOrID.itemID || itemOrID));
  const profile = item && getBatteryProfile(item);
  if (!profile || profile.passive || !profile.effectName) {
    return { success: false, errorMsg: "STARBASE_BATTERY_NOT_FOUND" };
  }
  const state = item.spaceState || {};
  if (hasUnavailableHealth(item)) {
    return { success: false, errorMsg: "MODULE_INCAPACITATED" };
  }
  if (state.anchorState !== "anchored" || state.onlineState !== "online" || number(state.online) !== 1) {
    return { success: false, errorMsg: "MODULE_NOT_ONLINE" };
  }
  const tower = findItemById(resources.getModuleControlTowerID(item));
  if (!resources.isControlTower(tower) ||
      number(tower.ownerID) !== number(item.ownerID) ||
      number(tower.locationID) !== number(item.locationID) ||
      number(tower.spaceState && tower.spaceState.systemID) !== number(state.systemID)) {
    return { success: false, errorMsg: "CONTROL_TOWER_NOT_FOUND" };
  }
  const towerState = tower.spaceState || {};
  if (towerState.anchorState !== "anchored" || towerState.onlineState !== "online" ||
      number(towerState.online) !== 1 || hasUnavailableHealth(tower)) {
    return { success: false, errorMsg: "CONTROL_TOWER_NOT_ONLINE" };
  }
  const capacity = resources.validateModuleResources(tower, item);
  if (!capacity.success) return capacity;
  return { success: true, data: { item, tower, profile } };
}

function getBatteryModuleView(itemOrID) {
  const item = findItemById(number(itemOrID && itemOrID.itemID || itemOrID));
  const profile = item && getBatteryProfile(item);
  if (!profile || profile.passive) return null;
  return {
    ...item,
    locationID: item.itemID,
    flagID: FLAG_CHARGES,
    starbaseBatteryModule: true,
    weaponFamily: profile.weaponFamily,
    moduleState: { online: item.spaceState && item.spaceState.onlineState === "online" },
  };
}

function getBatteryFittedItems(itemOrID) {
  const module = getBatteryModuleView(itemOrID);
  return module ? [module, ...listContainerItems(null, module.itemID)
    .filter((item) => number(item.flagID) === FLAG_CHARGES)] : [];
}

function hydrateBatteryActor(entity, item) {
  const profile = getBatteryProfile(item);
  if (!entity || !profile || profile.passive) return entity;
  const attributes = profile.attributes;
  entity.maxTargetRange = number(attributes[76]);
  entity.maxLockedTargets = number(attributes[192], 1);
  entity.scanResolution = number(attributes[564]);
  entity.capacitorCapacity = number(attributes[482]);
  entity.capacitorRechargeRate = number(attributes[55]);
  entity.characterID = 0;
  entity.pilotCharacterID = 0;
  entity.skillMap = new Map();
  for (const key of ["lockedTargets", "pendingTargetLocks", "activeModuleEffects",
    "moduleReactivationLocks"]) {
    if (!(entity[key] instanceof Map)) entity[key] = new Map();
  }
  if (!(entity.targetedBy instanceof Set)) entity.targetedBy = new Set();
  return entity;
}

function prepareBatteryActor(scene, batteryID) {
  const validation = validateBatteryOperation(batteryID);
  if (!validation.success) return validation;
  const entity = scene && scene.getEntityByID(number(batteryID));
  if (!entity || !isStarbaseBattery(entity) ||
      number(entity.systemID) !== number(validation.data.item.spaceState.systemID)) {
    return { success: false, errorMsg: "STARBASE_BATTERY_NOT_IN_SCENE" };
  }
  hydrateBatteryActor(entity, validation.data.item);
  return { success: true, data: { ...validation.data, entity } };
}

function getBatterySession(scene, entity) {
  // Deliberately not inserted in scene.sessions or assigned to entity.session.
  // A controller can observe notifications without becoming the dogma pilot.
  const getObserver = () => require("./starbaseControlRuntime").getStarbaseControlObserver(entity);
  const observer = getObserver();
  return {
    clientID: observer && observer.clientID,
    socket: observer && observer.socket,
    characterID: 0, charid: 0, corporationID: number(entity.corporationID),
    shipID: entity.itemID, shipTypeID: entity.typeID,
    _space: { ...(observer && observer._space || {}), shipID: entity.itemID,
      systemID: scene.systemID, initialStateSent: Boolean(observer?._space?.initialStateSent) },
    sendNotification(...args) { getObserver()?.sendNotification?.(...args); },
    sendServiceNotification(...args) { getObserver()?.sendServiceNotification?.(...args); },
  };
}

function isBatteryManuallyControlled(entity) {
  return number(entity && entity.controllerID) > 0;
}

function activateBattery(scene, batteryID, targetID, options = {}) {
  const prepared = prepareBatteryActor(scene, batteryID);
  if (!prepared.success) return prepared;
  const { entity, profile } = prepared.data;
  if (options.automatic === true && isBatteryManuallyControlled(entity)) {
    return { success: false, errorMsg: "STARBASE_BATTERY_CONTROLLED" };
  }
  const session = getBatterySession(scene, entity);
  const targetValidation = scene.validateTargetLockRequest(session, entity,
    scene.getEntityByID(number(targetID)), { ignoreCapacity: true });
  if (!targetValidation.success) return targetValidation;
  const existing = entity.activeModuleEffects.get(number(batteryID));
  if (existing) return number(existing.targetID) === number(targetID)
    ? { success: true, data: { entity, effectState: existing, alreadyActive: true } }
    : { success: false, errorMsg: "MODULE_ALREADY_ACTIVE" };
  const lock = scene.addTarget(session, number(targetID));
  if (!lock.success) return lock;
  entity.starbaseAutomaticTargetID = options.automatic === true ? number(targetID) : null;
  if (lock.data && lock.data.pending) {
    return { success: false, errorMsg: "TARGET_LOCK_PENDING", data: lock.data };
  }
  const activation = scene.activateGenericModule(session, getBatteryModuleView(batteryID),
    profile.effectName, { targetID: number(targetID), repeat: 9999999 });
  if (activation.success && activation.data && activation.data.effectState) {
    activation.data.effectState.starbaseAutomatic = options.automatic === true;
  }
  return activation;
}

function stopBattery(scene, batteryID, options = {}) {
  const entity = scene && scene.getEntityByID(number(batteryID));
  if (!entity) return { success: true, data: { stopped: false } };
  const session = getBatterySession(scene, entity);
  const effect = entity.activeModuleEffects?.get(number(batteryID));
  if (options.automaticOnly === true &&
      (effect ? effect.starbaseAutomatic !== true : isBatteryManuallyControlled(entity))) {
    return { success: true, data: { stopped: false } };
  }
  if (effect) scene.deactivateGenericModule(session, number(batteryID), {
    reason: options.reason || "starbaseStopped", deferUntilCycle: false,
  });
  for (const targetID of [...(entity.pendingTargetLocks?.keys() || [])]) {
    scene.cancelAddTarget(session, targetID, { notifySelf: true,
      reason: options.reason || "starbaseStopped" });
  }
  for (const targetID of [...(entity.lockedTargets?.keys() || [])]) {
    scene.removeTarget(session, targetID);
  }
  entity.starbaseAutomaticTargetID = null;
  return { success: true, data: { stopped: Boolean(effect) } };
}

module.exports = {
  BATTERY_GROUPS, FLAG_CHARGES, getBatteryProfile, isStarbaseBattery,
  hasUnavailableHealth,
  validateBatteryOperation, getBatteryModuleView, getBatteryFittedItems,
  hydrateBatteryActor, prepareBatteryActor, getBatterySession,
  isBatteryManuallyControlled, activateBattery, stopBattery,
};
