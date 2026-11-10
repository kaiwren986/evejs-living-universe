"use strict";
const { toInt } = require("../domain/abyssalRuntimeValues");

function getItemQuantity(ports, item) {
  const quantity = Number(item && (item.stacksize ?? item.quantity));
  return Number.isFinite(quantity)
    ? Math.max(0, Math.trunc(quantity))
    : (toInt(item && item.singleton, 0) === 1 ? 1 : 0);
}

function resolveTypeRecord(ports, itemOrTypeID, deps) {
  const typeID = typeof itemOrTypeID === "object"
    ? toInt(itemOrTypeID && itemOrTypeID.typeID, 0)
    : toInt(itemOrTypeID, 0);
  return typeID > 0 ? deps.resolveItemByTypeID(typeID) : null;
}

function getGroupID(ports, item, deps) {
  const itemGroupID = toInt(item && item.groupID, 0);
  if (itemGroupID > 0) {
    return itemGroupID;
  }
  const typeRecord = resolveTypeRecord(ports, item, deps);
  return toInt(typeRecord && typeRecord.groupID, 0);
}

function getCategoryID(ports, item, deps) {
  const itemCategoryID = toInt(item && item.categoryID, 0);
  if (itemCategoryID > 0) {
    return itemCategoryID;
  }
  const typeRecord = resolveTypeRecord(ports, item, deps);
  return toInt(typeRecord && typeRecord.categoryID, 0);
}

function getGroupName(ports, item, deps) {
  const directName = String(item && item.groupName || "").trim();
  if (directName) {
    return directName;
  }
  const typeRecord = resolveTypeRecord(ports, item, deps);
  return String(typeRecord && typeRecord.groupName || "").trim();
}

function isAbyssalFilamentItem(ports, item, deps) {
  const {
    GROUP_ABYSSAL_FILAMENT,
  } = ports;
  return getGroupID(ports, item, deps) === GROUP_ABYSSAL_FILAMENT;
}

function resolveShipClassProfile(ports, shipItem, deps) {
  const {
    CATEGORY_SHIP,
    matchesTypeList,
    FILAMENT_FRIGATE_TYPE_RESTRICTION_LIST_ID,
    FILAMENT_DESTROYER_TYPE_RESTRICTION_LIST_ID,
    FILAMENT_CRUISER_TYPE_RESTRICTION_LIST_ID,
  } = ports;
  if (getCategoryID(ports, shipItem, deps) !== CATEGORY_SHIP) {
    return null;
  }

  const typeContext = {
    typeID: toInt(shipItem && shipItem.typeID, 0),
    groupID: getGroupID(ports, shipItem, deps),
    categoryID: getCategoryID(ports, shipItem, deps),
  };
  const typeListMatcher = typeof deps.matchesTypeList === "function"
    ? deps.matchesTypeList
    : matchesTypeList;
  if (typeListMatcher(typeContext, FILAMENT_FRIGATE_TYPE_RESTRICTION_LIST_ID)) {
    return {
      key: "frigate",
      fallbackRequiredFilaments: 3,
      requiredFilaments: 3,
    };
  }
  if (typeListMatcher(typeContext, FILAMENT_DESTROYER_TYPE_RESTRICTION_LIST_ID)) {
    return {
      key: "destroyer",
      fallbackRequiredFilaments: 2,
      requiredFilaments: 2,
    };
  }
  if (typeListMatcher(typeContext, FILAMENT_CRUISER_TYPE_RESTRICTION_LIST_ID)) {
    return {
      key: "cruiser",
      fallbackRequiredFilaments: 1,
      requiredFilaments: 1,
    };
  }
  return null;
}

function createAbyssalInventoryTypeViews(ports) {
  return {
    getItemQuantity: getItemQuantity.bind(null, ports),
    resolveTypeRecord: resolveTypeRecord.bind(null, ports),
    getGroupID: getGroupID.bind(null, ports),
    getCategoryID: getCategoryID.bind(null, ports),
    getGroupName: getGroupName.bind(null, ports),
    isAbyssalFilamentItem: isAbyssalFilamentItem.bind(null, ports),
    resolveShipClassProfile: resolveShipClassProfile.bind(null, ports),
  };
}

module.exports = { createAbyssalInventoryTypeViews };
