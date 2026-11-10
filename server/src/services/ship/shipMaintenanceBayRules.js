"use strict";

const {
  toInt,
} = require("../../common/numbers");

const path = require("path");

const {
  resolveItemByTypeID,
} = require(path.join(__dirname, "../inventory/itemTypeRegistry"));
const {
  getShipBaseAttributeValue,
} = require(path.join(__dirname, "../fitting/liveFittingState"));

// The SDE classifies the Rorqual as the sole Capital Industrial Ship today.
// Keep the host check group-scoped so another hull in that retail class uses
// the same type-level eligibility attribute without a code change.
const CAPITAL_INDUSTRIAL_SHIP_GROUP_ID = 883;
const CATEGORY_SHIP = 6;
const CAP_INDUSTRIAL_MAINTENANCE_ATTRIBUTE =
  "allowedInCapIndustrialMaintenanceBay";

function resolveType(item) {
  const typeID = toInt(item && item.typeID, 0);
  return typeID > 0 ? resolveItemByTypeID(typeID) : null;
}

function getItemCategoryID(item) {
  const itemCategoryID = toInt(item && item.categoryID, 0);
  if (itemCategoryID > 0) {
    return itemCategoryID;
  }
  const type = resolveType(item);
  return toInt(type && type.categoryID, 0);
}

function isAssembledShipItem(item) {
  return (
    getItemCategoryID(item) === CATEGORY_SHIP &&
    toInt(item && item.singleton, 0) === 1
  );
}

function isCapitalIndustrialMaintenanceBay(hostShip) {
  const hostType = resolveType(hostShip);
  const itemGroupID = toInt(hostShip && hostShip.groupID, 0);
  const groupID = itemGroupID > 0
    ? itemGroupID
    : toInt(hostType && hostType.groupID, 0);
  return groupID === CAPITAL_INDUSTRIAL_SHIP_GROUP_ID;
}

function isAllowedInCapitalIndustrialMaintenanceBay(item) {
  const typeID = toInt(item && item.typeID, 0);
  return typeID > 0 && Number(
    getShipBaseAttributeValue(typeID, CAP_INDUSTRIAL_MAINTENANCE_ATTRIBUTE),
  ) > 0;
}

// This validates contents only. Capacity, access, range, and the presence of
// a bay remain owned by their existing callers.
function validateShipMaintenanceBayContents(hostShip, item) {
  if (!isAssembledShipItem(item)) {
    return {
      success: false,
      errorMsg: "SHIP_MAINTENANCE_BAY_REQUIRES_ASSEMBLED_SHIP",
    };
  }

  if (
    isCapitalIndustrialMaintenanceBay(hostShip) &&
    !isAllowedInCapitalIndustrialMaintenanceBay(item)
  ) {
    return {
      success: false,
      errorMsg: "SHIP_MAINTENANCE_BAY_SHIP_TYPE_NOT_ALLOWED",
    };
  }

  return { success: true };
}

module.exports = {
  CAPITAL_INDUSTRIAL_SHIP_GROUP_ID,
  CAP_INDUSTRIAL_MAINTENANCE_ATTRIBUTE,
  isAssembledShipItem,
  isCapitalIndustrialMaintenanceBay,
  isAllowedInCapitalIndustrialMaintenanceBay,
  validateShipMaintenanceBayContents,
};
