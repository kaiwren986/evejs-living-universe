"use strict";

const { findItemById, findStarbaseItemById, listContainerItems } = require("../inventory/itemStore");
const { TABLE, readStaticTable } = require("../_shared/referenceData");
const { canEntitiesInteractLocally } = require("../../space/destiny/identity/interactionScope");
const { isProcessingStorage } = require("./starbaseStorageKinds");

const CORPORATE_HANGAR_GROUP = 471;
const CORPORATE_HANGAR_FLAGS = new Set([115, 116, 117, 118, 119, 120, 121]);
const number = (value) => Number(value) || 0;
const fail = (errorMsg) => ({ success: false, errorMsg });

function isCorporateHangar(item) {
  return Boolean(item && number(item.categoryID) === 23 &&
    ([CORPORATE_HANGAR_GROUP, 413].includes(number(item.groupID)) ||
      (number(item.groupID) === 397 && number(item.typeID) !== 25305)));
}

function isTowerBay(item) {
  return Boolean(item && number(item.categoryID) === 23 && number(item.groupID) === 365);
}

function isMaintenanceArray(item) {
  return Boolean(item && number(item.categoryID) === 23 && number(item.groupID) === 363);
}

function isStarbaseStorage(item) {
  return isCorporateHangar(item) || isMaintenanceArray(item) || isBatteryAmmoInventory(item) || isTowerBay(item) ||
    isProcessingStorage(item);
}

function isBatteryAmmoInventory(item) {
  return Boolean(item && number(item.categoryID) === 23 && [417, 426, 430, 449].includes(number(item.groupID)));
}

function isBatteryAmmoFlag(item, flag) {
  return number(flag) === 27 || (number(item.groupID) === 430 && number(flag) === 0);
}

function getTypeAttribute(typeID, attributeID, fallback = 0) {
  const table = readStaticTable(TABLE.TYPE_DOGMA) || {};
  const type = table.typesByTypeID && table.typesByTypeID[String(typeID)];
  const value = type && type.attributes && type.attributes[String(attributeID)];
  return value !== undefined && Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function isOnline(item) {
  const state = item && item.spaceState;
  return Boolean(state && state.anchorState === "anchored" && state.onlineState === "online" &&
    number(state.online) === 1 && state.isFree !== true &&
    !(item.conditionState && item.conditionState.incapacitated));
}

function isAnchored(item) {
  const state = item && item.spaceState;
  return Boolean(state && state.anchorState === "anchored" && state.isFree !== true &&
    !item.destroyed && !state.destroyed && !["destroyed", "destroying"].includes(String(state.destructionState || item.destructionState)));
}

function finitePosition(position) {
  return Boolean(position && [position.x, position.y, position.z].every((value) => Number.isFinite(Number(value))));
}

function centerDistance(left, right) {
  return finitePosition(left) && finitePosition(right)
    ? Math.hypot(Number(left.x) - Number(right.x), Number(left.y) - Number(right.y), Number(left.z) - Number(right.z))
    : Infinity;
}

// Availability is separate from division / SMA usage permissions. Re-read the
// persisted rows on every operation so retained inventory bindings cannot keep
// a service alive after fuel exhaustion, offlining, or parent destruction.
function validateStarbaseInventoryAccess(session, itemOrID, options = {}) {
  const item = findItemById(number(itemOrID && typeof itemOrID === "object" ? itemOrID.itemID : itemOrID));
  if (!item || number(item.categoryID) !== 23) return fail("STARBASE_INVENTORY_NOT_FOUND");
  const available = options.allowOffline === true ? isAnchored : isOnline;
  if (!available(item)) return fail("STARBASE_INVENTORY_OFFLINE");
  const state = item.spaceState;
  const tower = isTowerBay(item) ? item : findItemById(number(state.controlTowerID || item.controlTowerID));
  if (!tower || number(tower.categoryID) !== 23 || number(tower.groupID) !== 365 ||
      number(tower.ownerID) !== number(item.ownerID) || number(tower.locationID) !== number(item.locationID)) {
    return fail("STARBASE_INVENTORY_TOWER_UNAVAILABLE");
  }
  if (!available(tower)) return fail("STARBASE_INVENTORY_TOWER_UNAVAILABLE");
  const systemID = number(session && session._space && session._space.systemID);
  const shipID = number(session && session._space && session._space.shipID);
  if (!systemID || !shipID || number(item.locationID) !== systemID || number(item.flagID) !== 0) {
    return fail("CONTAINER_NOT_VISIBLE");
  }
  const scene = require("../../space/runtime").getSceneForSession(session);
  const entity = scene && scene.getEntityByID(number(item.itemID));
  const ship = scene && scene.getEntityByID(shipID);
  const towerEntity = scene && scene.getEntityByID(number(tower.itemID));
  if (!entity || !ship || !towerEntity || !canEntitiesInteractLocally(ship, entity) ||
      !canEntitiesInteractLocally(ship, towerEntity) ||
      (typeof scene.canSessionSeeDungeonScopedEntity === "function" && !scene.canSessionSeeDungeonScopedEntity(session, entity))) {
    return fail("CONTAINER_NOT_VISIBLE");
  }
  const surfaceDistance = typeof scene.getEntitySurfaceDistance === "function"
    ? scene.getEntitySurfaceDistance(ship, entity)
    : Math.max(0, centerDistance(ship.position, entity.position) - Math.max(0, number(ship.radius)) - Math.max(0, number(entity.radius)));
  // invControllers.py:1003-1007; michelle.py:1041-1057. The shield alternative
  // compares ship centres, without extending it by the ship's hull radius.
  const withinTowerShield = (!isTowerBay(item) || options.allowTowerShieldRead === true) && isOnline(tower) && centerDistance(ship.position, towerEntity.position) < getTypeAttribute(tower.typeID, 680);
  const maxDistance = options.maxDistanceMeters === undefined
    ? getTypeAttribute(item.typeID, 715, 2500) : Number(options.maxDistanceMeters);
  if (!withinTowerShield && (!Number.isFinite(surfaceDistance) || surfaceDistance > maxDistance)) {
    return fail("STARBASE_INVENTORY_TOO_FAR");
  }
  return { success: true, data: { item, tower, scene, entity, ship, towerEntity, surfaceDistance, withinTowerShield } };
}

// moonmining.py:2379-2400 names the read/deposit and read/deposit/take
// permission columns separately from the SMA's fitting/service "use" column.
// A caller permitted to take is necessarily permitted to view that inventory.
function hasMaintenanceInventoryPermission(session, tower, itemID, operation) {
  const { hasStarbasePermission } = require("./starbaseAccessRuntime");
  return hasStarbasePermission(session, tower, itemID, operation) ||
    (operation === "viewput" && hasStarbasePermission(session, tower, itemID, "viewputtake"));
}

function validateTowerBayAccess(session, itemOrID, operation = "viewput") {
  // moonmining.py:600,1222-1224 binds and lists the tower for management.
  // A read can use the active shield; physical transfers retain their range.
  const result = validateStarbaseInventoryAccess(session, itemOrID, {
    allowOffline: true, allowTowerShieldRead: operation === "view",
  });
  if (!result.success) return result;
  const { item } = result.data;
  if (!isTowerBay(item) || require("./starbaseDefenseRuntime").hasUnavailableHealth(item)) return fail("STARBASE_INVENTORY_OFFLINE");
  return hasMaintenanceInventoryPermission(session, item, item.itemID, operation === "view" ? "viewput" : operation)
    ? result : fail("CONTROL_TOWER_BAY_ACCESS_DENIED");
}

function getTowerBayCapacity(item, flag) {
  if (!isTowerBay(item) || ![0, 122].includes(number(flag))) return 0;
  return number(flag) === 122 ? getTypeAttribute(item.typeID, 1233)
    : getTypeAttribute(item.typeID, 38, number(item.capacity));
}

function validateTowerBayDeposit(item, destination, quantity, projected = null) {
  const tower = destination && findStarbaseItemById(number(destination.locationID));
  if (!isTowerBay(tower)) return { success: true };
  const flag = number(destination.flagID);
  const reinforcement = require("./starbaseReinforcementRuntime");
  const error = reinforcement.validateTowerBayMutation(tower, flag);
  if (error) return fail(error);
  if (![0, 122].includes(flag) || !item ||
      (flag === 122 ? number(item.typeID) !== 16275 : number(item.typeID) === 16275)) {
    return fail("CONTROL_TOWER_INVALID_BAY_ITEM");
  }
  if (quantity !== undefined) {
    const units = (row) => number(row.singleton) === 1 ? 1 : number(row.stacksize ?? row.quantity);
    const volume = (row) => Math.max(0, number(require("../inventory/itemTypeRegistry").resolveItemByTypeID(row.typeID)?.volume));
    const contents = (projected || listContainerItems(null, tower.itemID, flag)).filter((row) => row.itemID !== item.itemID);
    const used = contents.reduce((sum, row) => sum + units(row) * volume(row), 0);
    if (used + (quantity === null ? units(item) : number(quantity)) * volume(item) > getTowerBayCapacity(tower, flag) + 1e-7) {
      return fail("CONTROL_TOWER_BAY_CAPACITY");
    }
  }
  return { success: true };
}

function validateTowerBayBatch(moves) {
  const bays = new Map();
  for (const { item, destination, quantity } of moves) {
    const key = `${destination.locationID}:${destination.flagID}`;
    const contents = bays.get(key) || listContainerItems(null, destination.locationID, destination.flagID);
    const result = validateTowerBayDeposit(item, destination, quantity, contents);
    if (!result.success) return result;
    const units = quantity == null ? (number(item.singleton) === 1 ? 1 : number(item.stacksize ?? item.quantity)) : number(quantity);
    bays.set(key, [...contents.filter((row) => row.itemID !== item.itemID),
      { ...item, stacksize: units, quantity: units }]);
  }
  return { success: true };
}

function validateMaintenanceInventoryAccess(session, itemOrID, operation = "viewput") {
  const result = validateStarbaseInventoryAccess(session, itemOrID);
  if (!result.success) return result;
  const { item, tower } = result.data;
  if (!isMaintenanceArray(item)) return fail("STARBASE_INVENTORY_NOT_FOUND");
  return hasMaintenanceInventoryPermission(session, tower, item.itemID, operation)
    ? result : fail("STARBASE_MAINTENANCE_ACCESS_DENIED");
}

function validateMaintenanceDeposit(item, destination) {
  const array = destination && findStarbaseItemById(number(destination.locationID));
  if (!isMaintenanceArray(array)) return { success: true };
  if (!item || number(item.categoryID) !== 6 || number(item.singleton) !== 1 ||
      number(item.groupID) === 29 || number(destination.flagID) !== 0) {
    return fail("STARBASE_MAINTENANCE_ASSEMBLED_SHIP_REQUIRED");
  }
  // Active ship storage must run the StoreVessel session transition; a plain
  // inventory move cannot remove its live entity or transfer the pilot to a pod.
  if (item.spaceState && number(item.locationID) === number(array.locationID)) {
    return fail("STARBASE_MAINTENANCE_USE_STORE_VESSEL");
  }
  return { success: true };
}

// celestialCheckers.py:200-235 permits loading anchored offline guns. Inventory
// distance follows invControllers.py:1279-1300; an offline tower has no shield
// alternative. Access and custody remain corporation-owned, not pilot Dogma.
function validateBatteryAmmoInventoryAccess(session, itemOrID, operation = "viewput") {
  const result = validateStarbaseInventoryAccess(session, itemOrID, { allowOffline: true });
  if (!result.success) return result;
  const { item, tower } = result.data;
  if (!isBatteryAmmoInventory(item)) return fail("STARBASE_INVENTORY_NOT_FOUND");
  return hasMaintenanceInventoryPermission(session, tower, item.itemID, operation)
    ? result : fail("STARBASE_MAINTENANCE_ACCESS_DENIED");
}

function getBatteryAmmoCapacity(item, flag) {
  if (!isBatteryAmmoInventory(item) || !isBatteryAmmoFlag(item, flag)) return 0;
  return Math.max(0, getTypeAttribute(item.typeID, 38, number(item.capacity)));
}

// The ordinary Add/MultiAdd path keeps real charge rows in the battery. Reuse
// fitting's pinned charge group/size policy, but do not create a ship fitting or
// require a fake fitted module. The laser's active crystal (27) and reserves (0)
// are separate client inventories (invControllers.py:1391-1422).
function validateBatteryAmmoDeposit(item, destination, quantity, projectedContents = null) {
  const battery = destination && findStarbaseItemById(number(destination.locationID));
  if (!isBatteryAmmoInventory(battery)) return { success: true };
  const flag = number(destination.flagID);
  if (!item || number(item.categoryID) !== 8 || !isBatteryAmmoFlag(battery, flag) ||
      !require("../fitting/liveFittingState").isChargeCompatibleWithModule(battery.typeID, item.typeID)) {
    return fail("STARBASE_BATTERY_INCOMPATIBLE_CHARGE");
  }
  const contents = (projectedContents || listContainerItems(null, battery.itemID, flag))
    .filter((row) => number(row.itemID) !== number(item.itemID));
  if (flag === 27 && contents.some((row) => number(row.typeID) !== number(item.typeID))) {
    return fail("STARBASE_BATTERY_MIXED_CHARGES");
  }
  if (quantity !== undefined) {
    const units = (row) => number(row.singleton) === 1 ? 1 : Math.max(0, number(row.stacksize ?? row.quantity));
    const requested = quantity === null ? units(item) : Math.max(1, number(quantity));
    if (number(battery.groupID) === 430 && flag === 27 &&
        requested + contents.reduce((total, row) => total + units(row), 0) > 1) {
      return fail("STARBASE_BATTERY_SINGLE_ACTIVE_CRYSTAL");
    }
    const volume = (row) => Math.max(0, number(require("../inventory/itemTypeRegistry").resolveItemByTypeID(row.typeID)?.volume));
    const used = contents.reduce((total, row) => total + units(row) * volume(row), 0);
    if (used + requested * volume(item) > getBatteryAmmoCapacity(battery, flag) + 1e-7) {
      return fail("STARBASE_BATTERY_AMMO_CAPACITY");
    }
  }
  return { success: true };
}

function validateBatteryAmmoBatch(moves) {
  const bays = new Map();
  for (const { item, destination, quantity } of moves) {
    if (!isBatteryAmmoInventory(findItemById(destination.locationID))) continue;
    const key = `${destination.locationID}:${destination.flagID}`;
    if (!bays.has(key)) bays.set(key, listContainerItems(null, destination.locationID, destination.flagID));
    const contents = bays.get(key);
    const result = validateBatteryAmmoDeposit(item, destination, quantity, contents);
    if (!result.success) return result;
    const units = quantity === null || quantity === undefined
      ? (number(item.singleton) === 1 ? 1 : number(item.stacksize ?? item.quantity)) : number(quantity);
    bays.set(key, [...contents.filter((row) => number(row.itemID) !== number(item.itemID)),
      { ...item, stacksize: units, quantity: units, locationID: destination.locationID, flagID: destination.flagID }]);
  }
  return { success: true };
}

function notifyControlledBatteryInventoryChanges(actorSession, changes, dogma) {
  const scene = require("../../space/runtime").getSceneForSession(actorSession);
  if (!scene) return;
  const control = require("./starbaseControlRuntime");
  const batteries = new Set();
  for (const change of changes) {
    for (const state of [change.item, change.previousData || change.previousState]) {
      if (number(state?.flagID) === 27 && isBatteryAmmoInventory(findItemById(number(state?.locationID)))) {
        batteries.add(number(state.locationID));
      }
    }
  }
  for (const batteryID of batteries) {
    const observer = control.getStarbaseControlObserver(scene.getEntityByID(batteryID));
    if (!observer || !control.getControlledBatteryContext(observer, batteryID)) continue;
    const battery = findItemById(batteryID);
    if (number(battery.groupID) === 430) {
      // godma.py:1274-1287 resets the location's real-item set, including an
      // unloaded crystal; moondefencebutton.py:352-361 then clears/sets it.
      dogma.primeControlledStarbaseBattery(observer, batteryID);
      continue;
    }
    const current = listContainerItems(null, batteryID, 27).filter((item) => number(item.categoryID) === 8);
    const previous = new Map(current.map((item) => [number(item.itemID), item]));
    // Inventory changes are emitted after persistence. Reverse the transaction
    // deltas to recover the previous magazine without keeping session snapshots.
    for (const change of [...changes].reverse()) {
      const old = change.previousData || change.previousState;
      const item = change.item;
      if (number(item?.locationID) === batteryID && number(item?.flagID) === 27) previous.delete(number(item.itemID));
      const before = old && { ...item, ...old };
      if (number(before?.locationID) === batteryID && number(before?.flagID) === 27 && number(before?.categoryID) === 8) {
        previous.set(number(before.itemID), before);
      }
    }
    const active = (rows) => [...rows].filter((item) => number(item.stacksize ?? item.quantity) > 0)
      .sort((left, right) => number(left.itemID) - number(right.itemID))[0] || null;
    const before = active(previous.values());
    const after = active(current);
    const snapshot = (item) => ({ typeID: number(item?.typeID), quantity: number(item?.stacksize ?? item?.quantity) });
    // godma.py:2589-2619 expels an old tuple at quantity zero. Prime alone does
    // not remove sublocations, and plain OnItemChange cannot update their 805.
    dogma._notifyChargeQuantityTransition(observer, number(observer.characterID || observer.charid),
      batteryID, 27, snapshot(before), snapshot(after), { previousChargeItem: before, nextChargeItem: after });
  }
}

module.exports = {
  isTowerBay, validateTowerBayAccess, validateTowerBayDeposit, validateTowerBayBatch, getTowerBayCapacity,
  CORPORATE_HANGAR_FLAGS, isCorporateHangar, isMaintenanceArray, isStarbaseStorage,
  validateStarbaseInventoryAccess, validateMaintenanceInventoryAccess, validateMaintenanceDeposit,
  hasMaintenanceInventoryPermission,
  isBatteryAmmoInventory, isBatteryAmmoFlag, validateBatteryAmmoInventoryAccess,
  validateBatteryAmmoDeposit, getBatteryAmmoCapacity,
  validateBatteryAmmoBatch,
  notifyControlledBatteryInventoryChanges,
};
