"use strict";

module.exports = {};

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

// CCP parity: After consuming capacitor, notify the owning session so the
// client's HUD gauge updates in real-time.  Attribute 18 ("charge") is the
// current capacitor energy in GJ.
const ATTRIBUTE_CHARGE = 18;

const ATTRIBUTE_ITEM_DAMAGE = 3;

const ATTRIBUTE_SHIP_DAMAGE = getAttributeIDByNames("damage") || 3;

const ATTRIBUTE_SHIP_SHIELD_CHARGE =
  getAttributeIDByNames("shieldCharge") || 264;

const ATTRIBUTE_SHIP_ARMOR_DAMAGE =
  getAttributeIDByNames("armorDamage") || 266;

const ATTRIBUTE_QUANTITY = getAttributeIDByNames("quantity") || 805;

const ATTRIBUTE_CRYSTAL_VOLATILITY_CHANCE =
  getAttributeIDByNames("crystalVolatilityChance") || 783;

const ATTRIBUTE_CRYSTAL_VOLATILITY_DAMAGE =
  getAttributeIDByNames("crystalVolatilityDamage") || 784;

const ATTRIBUTE_EM_DAMAGE = getAttributeIDByNames("emDamage") || 114;

const ATTRIBUTE_EXPLOSIVE_DAMAGE =
  getAttributeIDByNames("explosiveDamage") || 116;

const ATTRIBUTE_KINETIC_DAMAGE = getAttributeIDByNames("kineticDamage") || 117;

const ATTRIBUTE_THERMAL_DAMAGE = getAttributeIDByNames("thermalDamage") || 118;

const ATTRIBUTE_HEAT_DAMAGE = getAttributeIDByNames("heatDamage") || 1211;

const ATTRIBUTE_THERMODYNAMICS_HEAT_DAMAGE =
  getAttributeIDByNames("thermodynamicsHeatDamage") || 1229;

const ATTRIBUTE_MASS = getAttributeIDByNames("mass") || 4;

const ATTRIBUTE_MAX_VELOCITY = getAttributeIDByNames("maxVelocity") || 37;

const ATTRIBUTE_MAX_TARGET_RANGE = getAttributeIDByNames("maxTargetRange") || 76;

const ATTRIBUTE_MAX_LOCKED_TARGETS =
  getAttributeIDByNames("maxLockedTargets") || 192;

const ATTRIBUTE_CLOAKING_TARGETING_DELAY =
  getAttributeIDByNames("cloakingTargetingDelay") || 560;

const ATTRIBUTE_CLOAK_STABILIZATION_STRENGTH =
  getAttributeIDByNames("cloakStabilizationStrength") || 3117;

const ATTRIBUTE_STABILIZE_CLOAK_DURATION =
  getAttributeIDByNames("stabilizeCloakDuration") || 3118;

const ATTRIBUTE_SCAN_RESOLUTION = getAttributeIDByNames("scanResolution") || 564;

const ATTRIBUTE_CAPACITOR_CAPACITY =
  getAttributeIDByNames("capacitorCapacity") || 482;

const ATTRIBUTE_SIGNATURE_RADIUS =
  getAttributeIDByNames("signatureRadius") || 552;

Object.assign(module.exports, {
  ATTRIBUTE_CAPACITOR_CAPACITY,
  ATTRIBUTE_CHARGE,
  ATTRIBUTE_CLOAKING_TARGETING_DELAY,
  ATTRIBUTE_CLOAK_STABILIZATION_STRENGTH,
  ATTRIBUTE_CRYSTAL_VOLATILITY_CHANCE,
  ATTRIBUTE_CRYSTAL_VOLATILITY_DAMAGE,
  ATTRIBUTE_EM_DAMAGE,
  ATTRIBUTE_EXPLOSIVE_DAMAGE,
  ATTRIBUTE_HEAT_DAMAGE,
  ATTRIBUTE_ITEM_DAMAGE,
  ATTRIBUTE_KINETIC_DAMAGE,
  ATTRIBUTE_MASS,
  ATTRIBUTE_MAX_LOCKED_TARGETS,
  ATTRIBUTE_MAX_TARGET_RANGE,
  ATTRIBUTE_MAX_VELOCITY,
  ATTRIBUTE_QUANTITY,
  ATTRIBUTE_SCAN_RESOLUTION,
  ATTRIBUTE_SHIP_ARMOR_DAMAGE,
  ATTRIBUTE_SHIP_DAMAGE,
  ATTRIBUTE_SHIP_SHIELD_CHARGE,
  ATTRIBUTE_SIGNATURE_RADIUS,
  ATTRIBUTE_STABILIZE_CLOAK_DURATION,
  ATTRIBUTE_THERMAL_DAMAGE,
  ATTRIBUTE_THERMODYNAMICS_HEAT_DAMAGE,
});
