"use strict";

const {
  toFiniteNumber,
  toInt,
} = require("../../common/numbers");

const path = require("path");

const { resolveItemByTypeID } = require(path.join(
  __dirname,
  "../inventory/itemTypeRegistry",
));
const {
  MINING_HOLD_FLAGS,
  MINING_HOLD_DEFINITIONS,
  getMiningHoldDefinitionByFlag,
} = require("./miningConstants");

const MINING_SHIP_BAY_FLAGS = Object.freeze(
  MINING_HOLD_DEFINITIONS.map((definition) => definition.flagID),
);
const miningMaterialKindCache = new Map();
// V24.01 tools/ClientCodeGrabber/Latest/eve/common/script/util/
// inventoryFlagsCommon.py:69-120. These group checks matter because not every
// asteroid-category record is cargo ore, and compressed gas is not named
// "Harvestable Cloud" in current static data.
const GROUP_HARVESTABLE_CLOUD = 711;
const GROUP_COMPRESSED_GAS = 4168;
const GROUP_PRISMATICITE = 4915;
const ICE_GROUP_IDS = Object.freeze(new Set([465, 903, 2022]));
const BLOCKED_ASTEROID_GROUP_IDS = Object.freeze(new Set([
  519,  // Terran Artifacts
  4094, // Scalable Decorative Asteroid
  4714, // Non-Interactable Asteroid
]));

function resolveTypeRecord(itemOrTypeID) {
  if (!itemOrTypeID) {
    return null;
  }
  if (typeof itemOrTypeID === "object") {
    return itemOrTypeID;
  }
  const typeID = toInt(itemOrTypeID, 0);
  if (typeID <= 0) {
    return null;
  }
  return resolveItemByTypeID(typeID) || null;
}

function computeMiningMaterialKind(typeRecord) {
  if (!typeRecord) {
    return null;
  }

  const categoryID = toInt(typeRecord.categoryID, 0);
  const groupID = toInt(typeRecord.groupID, 0);

  if (groupID === GROUP_HARVESTABLE_CLOUD || groupID === GROUP_COMPRESSED_GAS) {
    return "gas";
  }

  if (ICE_GROUP_IDS.has(groupID)) {
    return "ice";
  }

  if (
    (categoryID === 25 || groupID === GROUP_PRISMATICITE) &&
    !BLOCKED_ASTEROID_GROUP_IDS.has(groupID)
  ) {
    return "ore";
  }

  return null;
}

function classifyMiningMaterialType(itemOrTypeID) {
  const typeRecord = resolveTypeRecord(itemOrTypeID);
  if (!typeRecord) {
    return null;
  }

  const typeID = toInt(typeRecord.typeID, 0);
  if (typeID > 0 && miningMaterialKindCache.has(typeID)) {
    const kind = miningMaterialKindCache.get(typeID);
    return kind
      ? {
          kind,
          typeRecord,
        }
      : null;
  }

  const kind = computeMiningMaterialKind(typeRecord);
  if (typeID > 0) {
    miningMaterialKindCache.set(typeID, kind || null);
  }

  return kind
    ? {
        kind,
        typeRecord,
      }
    : null;
}

function isMiningMaterialType(itemOrTypeID) {
  return Boolean(classifyMiningMaterialType(itemOrTypeID));
}

function isItemTypeAllowedInHoldFlag(itemOrTypeID, flagID) {
  const numericFlagID = toInt(flagID, 0);
  const typeRecord = resolveTypeRecord(itemOrTypeID);
  if (!typeRecord) {
    return false;
  }
  const categoryID = toInt(typeRecord.categoryID, 0);
  const groupID = toInt(typeRecord.groupID, 0);

  switch (numericFlagID) {
    case MINING_HOLD_FLAGS.GENERAL_MINING_HOLD:
      return (
        (
          categoryID === 25 &&
          !BLOCKED_ASTEROID_GROUP_IDS.has(groupID)
        ) ||
        groupID === GROUP_HARVESTABLE_CLOUD ||
        groupID === GROUP_COMPRESSED_GAS ||
        groupID === GROUP_PRISMATICITE
      );
    case MINING_HOLD_FLAGS.SPECIALIZED_ASTEROID_HOLD:
      return (
        (
          categoryID === 25 &&
          !BLOCKED_ASTEROID_GROUP_IDS.has(groupID) &&
          !ICE_GROUP_IDS.has(groupID)
        ) ||
        groupID === GROUP_PRISMATICITE
      );
    case MINING_HOLD_FLAGS.SPECIALIZED_GAS_HOLD:
      return groupID === GROUP_HARVESTABLE_CLOUD || groupID === GROUP_COMPRESSED_GAS;
    case MINING_HOLD_FLAGS.SPECIALIZED_ICE_HOLD:
      return ICE_GROUP_IDS.has(groupID);
    default:
      return false;
  }
}

function getShipHoldCapacityByFlag(resourceState, flagID) {
  const definition = getMiningHoldDefinitionByFlag(flagID);
  if (!definition || !resourceState) {
    return 0;
  }
  return toFiniteNumber(resourceState[definition.resourceKey], 0);
}

function getPreferredMiningHoldFlagForType(resourceState, itemOrTypeID) {
  const classification = classifyMiningMaterialType(itemOrTypeID);
  if (!classification || !resourceState) {
    return null;
  }

  if (
    classification.kind === "ore" &&
    getShipHoldCapacityByFlag(resourceState, MINING_HOLD_FLAGS.SPECIALIZED_ASTEROID_HOLD) > 0
  ) {
    return MINING_HOLD_FLAGS.SPECIALIZED_ASTEROID_HOLD;
  }

  if (
    classification.kind === "gas" &&
    getShipHoldCapacityByFlag(resourceState, MINING_HOLD_FLAGS.SPECIALIZED_GAS_HOLD) > 0
  ) {
    return MINING_HOLD_FLAGS.SPECIALIZED_GAS_HOLD;
  }

  if (
    classification.kind === "ice" &&
    getShipHoldCapacityByFlag(resourceState, MINING_HOLD_FLAGS.SPECIALIZED_ICE_HOLD) > 0
  ) {
    return MINING_HOLD_FLAGS.SPECIALIZED_ICE_HOLD;
  }

  return getShipHoldCapacityByFlag(resourceState, MINING_HOLD_FLAGS.GENERAL_MINING_HOLD) > 0
    ? MINING_HOLD_FLAGS.GENERAL_MINING_HOLD
    : null;
}

module.exports = {
  MINING_HOLD_FLAGS,
  MINING_HOLD_DEFINITIONS,
  MINING_SHIP_BAY_FLAGS,
  classifyMiningMaterialType,
  isMiningMaterialType,
  isItemTypeAllowedInHoldFlag,
  getShipHoldCapacityByFlag,
  getPreferredMiningHoldFlagForType,
};
