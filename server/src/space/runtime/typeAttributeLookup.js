"use strict";

module.exports = {
  getAttributeNameByID,
  getTypeDogmaAttributeValueByID,
};

const runtimeEntryDirname = require("path").resolve(__dirname, "..");
const path = require("path");
const {
  getFittedModuleItems,
  listFittedItemsForLocation,
  buildSlimModuleTuples,
  buildCharacterTargetingState,
  buildChargeTupleItemID,
  buildShipResourceState,
  SLOT_FAMILY_FLAGS,
  getAttributeIDByNames,
  getEffectIDByNames,
  getTypeDogmaAttributes,
  getTypeDogmaEffects,
  getTypeEffectRecords,
  getPassiveModifierEffectRecords,
  getTypeAttributeValue,
  getEffectTypeRecord,
  getRequiredSkillRequirements,
  getLoadedChargeByFlag,
  isChargeCompatibleWithModule,
  isModuleOnline,
  isStructureDogmaHost,
  resolveDogmaSkillMapForHost,
  appendDirectModifierEntries,
  buildEffectiveItemAttributeMap,
  indexOverloadEffectRecordsByModuleID,
  buildProjectedModuleSourceAttributeMap,
} = require(path.join(runtimeEntryDirname, "../services/fitting/liveFittingState"));
const {
  toInt,
} = require("../../common/numbers");
const moduleAttributesModule = require("./moduleAttributes");

function getTypeDogmaAttributeValueByID(typeID, attributeID, fallback = null) {
  const attributeValue = getTypeAttributeValue(typeID, getAttributeNameByID(attributeID));
  if (attributeValue !== null && attributeValue !== undefined) {
    return attributeValue;
  }
  const attributes = getTypeDogmaAttributes(typeID);
  const rawValue = attributes && attributes[String(attributeID)];
  const numericValue = Number(rawValue);
  return Number.isFinite(numericValue) ? numericValue : fallback;
}

function getAttributeNameByID(attributeID) {
  const MODULE_ATTRIBUTE_DURATION = moduleAttributesModule.MODULE_ATTRIBUTE_DURATION;
  const MODULE_ATTRIBUTE_MASS_ADDITION = moduleAttributesModule.MODULE_ATTRIBUTE_MASS_ADDITION;
  const MODULE_ATTRIBUTE_MAX_GROUP_ACTIVE = moduleAttributesModule.MODULE_ATTRIBUTE_MAX_GROUP_ACTIVE;
  const MODULE_ATTRIBUTE_MAX_VELOCITY_ACTIVATION_LIMIT = moduleAttributesModule.MODULE_ATTRIBUTE_MAX_VELOCITY_ACTIVATION_LIMIT;
  const MODULE_ATTRIBUTE_REACTIVATION_DELAY = moduleAttributesModule.MODULE_ATTRIBUTE_REACTIVATION_DELAY;
  const MODULE_ATTRIBUTE_SIGNATURE_RADIUS_BONUS = moduleAttributesModule.MODULE_ATTRIBUTE_SIGNATURE_RADIUS_BONUS;
  const MODULE_ATTRIBUTE_SPEED_BOOST_FACTOR = moduleAttributesModule.MODULE_ATTRIBUTE_SPEED_BOOST_FACTOR;
  const MODULE_ATTRIBUTE_SPEED_FACTOR = moduleAttributesModule.MODULE_ATTRIBUTE_SPEED_FACTOR;
  switch (toInt(attributeID, 0)) {
    case MODULE_ATTRIBUTE_SPEED_FACTOR:
      return "speedFactor";
    case MODULE_ATTRIBUTE_DURATION:
      return "duration";
    case MODULE_ATTRIBUTE_SIGNATURE_RADIUS_BONUS:
      return "signatureRadiusBonus";
    case MODULE_ATTRIBUTE_SPEED_BOOST_FACTOR:
      return "speedBoostFactor";
    case MODULE_ATTRIBUTE_MAX_GROUP_ACTIVE:
      return "maxGroupActive";
    case MODULE_ATTRIBUTE_MASS_ADDITION:
      return "massAddition";
    case MODULE_ATTRIBUTE_REACTIVATION_DELAY:
      return "moduleReactivationDelay";
    case MODULE_ATTRIBUTE_MAX_VELOCITY_ACTIVATION_LIMIT:
      return "maxVelocityActivationLimit";
    default:
      return "";
  }
}
