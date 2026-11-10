"use strict";

const {
  toInt,
} = require("../../common/numbers");

const path = require("path");

const { resolveItemByTypeID } = require(path.join(
  __dirname,
  "./itemTypeRegistry",
));
const { matchesTypeList } = require(path.join(
  __dirname,
  "./typeListAuthority",
));
const {
  isAllowedInCapitalIndustrialMaintenanceBay,
  validateShipMaintenanceBayContents: validateShipMaintenanceBayEligibility,
} = require(path.join(__dirname, "../ship/shipMaintenanceBayRules"));

const GROUP_CAPSULE = 29;
const TYPE_RORQUAL = 28352;
const ALLOWED_IN_SMA_CARGO_HOLDS_TYPE_LIST_ID = 11;

function resolveTypeRecord(itemOrTypeID) {
  if (!itemOrTypeID) {
    return null;
  }
  if (typeof itemOrTypeID !== "object") {
    return resolveItemByTypeID(toInt(itemOrTypeID, 0)) || null;
  }

  const typeID = toInt(itemOrTypeID.typeID || itemOrTypeID.itemTypeID, 0);
  const typeRecord = typeID > 0 ? resolveItemByTypeID(typeID) : null;
  return typeRecord ? { ...typeRecord, ...itemOrTypeID } : itemOrTypeID;
}

function isRorqualMaintenanceBayShipAllowed(itemOrTypeID) {
  const typeRecord = resolveTypeRecord(itemOrTypeID);
  return Boolean(
    typeRecord && isAllowedInCapitalIndustrialMaintenanceBay(typeRecord),
  );
}

function validateShipMaintenanceBayContents(contents = []) {
  const rejectedItems = (Array.isArray(contents) ? contents : []).filter(
    (contentItem) => !matchesTypeList(
      contentItem,
      ALLOWED_IN_SMA_CARGO_HOLDS_TYPE_LIST_ID,
    ),
  );
  if (rejectedItems.length === 0) {
    return { success: true };
  }

  return {
    success: false,
    errorMsg: "SHIP_MAINTENANCE_BAY_CARGO_RESTRICTED",
    userMessage:
      "You cannot store a ship that contains cargo other than charges, " +
      "modules and rigs, subsystems, drones, deployables, implants and " +
      "boosters, filaments, Liquid Ozone, or Strontium Clathrates in a " +
      "Ship Maintenance Bay.",
    rejectedItemIDs: rejectedItems
      .map((contentItem) => toInt(contentItem && contentItem.itemID, 0))
      .filter((itemID) => itemID > 0),
  };
}

function validateShipMaintenanceBayItem(hostShip, item, options = {}) {
  const typeRecord = resolveTypeRecord(item);
  if (toInt(typeRecord && typeRecord.groupID, 0) === GROUP_CAPSULE) {
    return {
      success: false,
      errorMsg: "CANNOT_STORE_CAPSULE",
      userMessage: "Capsules cannot be placed in a Ship Maintenance Bay.",
    };
  }

  const eligibility = validateShipMaintenanceBayEligibility(hostShip, item);
  if (!eligibility.success) {
    return eligibility;
  }

  return validateShipMaintenanceBayContents(options.contents);
}

module.exports = {
  ALLOWED_IN_SMA_CARGO_HOLDS_TYPE_LIST_ID,
  GROUP_CAPSULE,
  TYPE_RORQUAL,
  isRorqualMaintenanceBayShipAllowed,
  validateShipMaintenanceBayContents,
  validateShipMaintenanceBayItem,
};
