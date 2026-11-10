"use strict";

const path = require("path");

const {
  TABLE,
  readStaticRows,
  readStaticTable,
} = require(path.join(__dirname, "../../services/_shared/referenceData"));
const {
  resolveItemByTypeID,
} = require(path.join(__dirname, "../../services/inventory/itemTypeRegistry"));
const {
  getTypeAttributeMap,
  getTypeDogmaRecord,
  getTypeEffectRecords,
} = require(path.join(__dirname, "../../services/fitting/liveFittingState"));
const {
  resolveEntityEwarSpecs,
} = require(path.join(__dirname, "./npcEntityEwarCatalog"));

const SDE_NPC_CATEGORY_ID = 11;

const NPC_RUNTIME_CAPABILITY = Object.freeze({
  DIRECT_WEAPON: "direct_weapon",
  LOCAL_ARMOR_REPAIR: "local_armor_repair",
  REMOTE_ARMOR_REPAIR: "remote_armor_repair",
  LOCAL_SHIELD_BOOST: "local_shield_boost",
  REMOTE_SHIELD_REPAIR: "remote_shield_repair",
  REMOTE_HULL_REPAIR: "remote_hull_repair",
  REMOTE_CAPACITOR_TRANSFER: "remote_capacitor_transfer",
  REMOTE_SENSOR_BOOST: "remote_sensor_boost",
  REMOTE_TRACKING: "remote_tracking",
  STASIS_WEBIFIER: "stasis_webifier",
  ENERGY_NEUTRALIZER: "energy_neutralizer",
  ENERGY_NOSFERATU: "energy_nosferatu",
  WARP_SCRAMBLER: "warp_scrambler",
  WARP_DISRUPTOR: "warp_disruptor",
  TARGET_PAINTER: "target_painter",
  SENSOR_DAMPENER: "sensor_dampener",
  TRACKING_DISRUPTOR: "tracking_disruptor",
  GUIDANCE_DISRUPTOR: "guidance_disruptor",
  ECM_JAMMER: "ecm_jammer",
  ECM_BURST_JAMMER: "ecm_burst_jammer",
  SUPERWEAPON: "superweapon",
  SMARTBOMB: "smartbomb",
  SIEGE_MODE: "siege_mode",
  MICROWARPDRIVE: "microwarpdrive",
  MICRO_JUMP_ATTACK: "micro_jump_attack",
  MINING_LASER: "mining_laser",
  INDUSTRIAL_CORE: "industrial_core",
  DEPENDANT_CONTROLLER: "dependant_controller",
  CHAIN_LIGHTNING: "chain_lightning",
  DRONE_BANDWIDTH_SUPPRESSION: "drone_bandwidth_suppression",
  GROUP_SHIELD_ASSIST: "group_shield_assist",
  GROUP_ARMOR_ASSIST: "group_armor_assist",
  GROUP_SPEED_ASSIST: "group_speed_assist",
  GROUP_PROPULSION_JAM_ASSIST: "group_propulsion_jam_assist",
  ENVIRONMENTAL_DAMAGE: "environmental_damage",
  SELF_VELOCITY_MODIFIER: "self_velocity_modifier",
  SELF_CRUISE_SPEED_MODIFIER: "self_cruise_speed_modifier",
  MINING_COMMAND_BURST: "mining_command_burst",
  CONTROLLER: "controller",
  DEPENDANT: "dependant",
});

function normalizedEffectMap(entries) {
  return Object.freeze(Object.fromEntries(entries.map(([name, capabilityID]) => [
    String(name).trim().toLowerCase(),
    capabilityID,
  ])));
}

// This table describes SDE semantics only. Runtime support is deliberately
// resolved in npcRuntimeCapabilityRegistry.js so discovery cannot become
// circular and unknown effects cannot default to supported.
const CAPABILITY_BY_EFFECT_NAME = normalizedEffectMap([
  ["targetAttack", NPC_RUNTIME_CAPABILITY.DIRECT_WEAPON],
  ["targetDisintegratorAttack", NPC_RUNTIME_CAPABILITY.DIRECT_WEAPON],
  ["missileLaunchingForEntity", NPC_RUNTIME_CAPABILITY.DIRECT_WEAPON],

  ["entityArmorRepairing", NPC_RUNTIME_CAPABILITY.LOCAL_ARMOR_REPAIR],
  ["entityArmorRepairingSmall", NPC_RUNTIME_CAPABILITY.LOCAL_ARMOR_REPAIR],
  ["entityArmorRepairingMedium", NPC_RUNTIME_CAPABILITY.LOCAL_ARMOR_REPAIR],
  ["entityArmorRepairingLarge", NPC_RUNTIME_CAPABILITY.LOCAL_ARMOR_REPAIR],
  ["armorRepairForEntities", NPC_RUNTIME_CAPABILITY.LOCAL_ARMOR_REPAIR],
  ["npcBehaviorArmorRepairer", NPC_RUNTIME_CAPABILITY.LOCAL_ARMOR_REPAIR],
  ["entityShieldBoosting", NPC_RUNTIME_CAPABILITY.LOCAL_SHIELD_BOOST],
  ["entityShieldBoostingSmall", NPC_RUNTIME_CAPABILITY.LOCAL_SHIELD_BOOST],
  ["entityShieldBoostingMedium", NPC_RUNTIME_CAPABILITY.LOCAL_SHIELD_BOOST],
  ["entityShieldBoostingLarge", NPC_RUNTIME_CAPABILITY.LOCAL_SHIELD_BOOST],
  ["shieldBoostingForEntities", NPC_RUNTIME_CAPABILITY.LOCAL_SHIELD_BOOST],
  ["npcBehaviorShieldBooster", NPC_RUNTIME_CAPABILITY.LOCAL_SHIELD_BOOST],

  ["npcBehaviorRemoteArmorRepairer", NPC_RUNTIME_CAPABILITY.REMOTE_ARMOR_REPAIR],
  ["NPCRemoteArmorRepair", NPC_RUNTIME_CAPABILITY.REMOTE_ARMOR_REPAIR],
  ["behaviorNpcRemoteArmorRepair", NPC_RUNTIME_CAPABILITY.REMOTE_ARMOR_REPAIR],
  ["npcEntityRemoteArmorRepairer", NPC_RUNTIME_CAPABILITY.REMOTE_ARMOR_REPAIR],
  ["npcBehaviorRemoteShieldBooster", NPC_RUNTIME_CAPABILITY.REMOTE_SHIELD_REPAIR],
  ["NPCRemoteShieldBoost", NPC_RUNTIME_CAPABILITY.REMOTE_SHIELD_REPAIR],
  ["npcBehaviorRemoteCapacitorTransmitter", NPC_RUNTIME_CAPABILITY.REMOTE_CAPACITOR_TRANSFER],

  ["modifyTargetSpeed2", NPC_RUNTIME_CAPABILITY.STASIS_WEBIFIER],
  ["npcBehaviorWebifier", NPC_RUNTIME_CAPABILITY.STASIS_WEBIFIER],
  ["concordModifyTargetSpeed", NPC_RUNTIME_CAPABILITY.STASIS_WEBIFIER],
  ["warpScrambleForEntity", NPC_RUNTIME_CAPABILITY.WARP_SCRAMBLER],
  ["warpScrambleTargetMWDBlockActivationForEntity", NPC_RUNTIME_CAPABILITY.WARP_SCRAMBLER],
  ["behaviorWarpScramble", NPC_RUNTIME_CAPABILITY.WARP_SCRAMBLER],
  ["concordWarpScramble", NPC_RUNTIME_CAPABILITY.WARP_SCRAMBLER],
  ["warpScrambleForStructure", NPC_RUNTIME_CAPABILITY.WARP_SCRAMBLER],
  ["warpDisrupt", NPC_RUNTIME_CAPABILITY.WARP_DISRUPTOR],
  ["behaviorWarpDisrupt", NPC_RUNTIME_CAPABILITY.WARP_DISRUPTOR],
  ["entityEnergyNeutralizerFalloff", NPC_RUNTIME_CAPABILITY.ENERGY_NEUTRALIZER],
  ["energyNeutralizerFalloff", NPC_RUNTIME_CAPABILITY.ENERGY_NEUTRALIZER],
  ["npcBehaviorEnergyNeutralizer", NPC_RUNTIME_CAPABILITY.ENERGY_NEUTRALIZER],
  ["npcBehaviorEnergyNosferatu", NPC_RUNTIME_CAPABILITY.ENERGY_NOSFERATU],
  ["behaviorTargetPainter", NPC_RUNTIME_CAPABILITY.TARGET_PAINTER],
  ["entityTargetPaint", NPC_RUNTIME_CAPABILITY.TARGET_PAINTER],
  ["behaviorSensorDampener", NPC_RUNTIME_CAPABILITY.SENSOR_DAMPENER],
  ["entitySensorDampen", NPC_RUNTIME_CAPABILITY.SENSOR_DAMPENER],
  ["npcBehaviorTrackingDisruptor", NPC_RUNTIME_CAPABILITY.TRACKING_DISRUPTOR],
  ["npcEntityTrackingDisruptor", NPC_RUNTIME_CAPABILITY.TRACKING_DISRUPTOR],
  ["npcBehaviorGuidanceDisruptor", NPC_RUNTIME_CAPABILITY.GUIDANCE_DISRUPTOR],
  ["behaviorECM", NPC_RUNTIME_CAPABILITY.ECM_JAMMER],
  ["entityECMFalloff", NPC_RUNTIME_CAPABILITY.ECM_JAMMER],
  ["NPCRemoteECM", NPC_RUNTIME_CAPABILITY.ECM_JAMMER],
  ["concordTargetJam", NPC_RUNTIME_CAPABILITY.ECM_JAMMER],
  ["entityEwTestEffectJam", NPC_RUNTIME_CAPABILITY.ECM_JAMMER],

  ["entitySuperWeapon", NPC_RUNTIME_CAPABILITY.SUPERWEAPON],
  ["entitySuperWeaponLanceAllRaces", NPC_RUNTIME_CAPABILITY.SUPERWEAPON],
  ["EntityChainLightning", NPC_RUNTIME_CAPABILITY.CHAIN_LIGHTNING],
  ["npcBehaviorSmartBomb", NPC_RUNTIME_CAPABILITY.SMARTBOMB],
  ["npcBehaviorSiege", NPC_RUNTIME_CAPABILITY.SIEGE_MODE],
  ["npcBehaviorMicroWarpDrive", NPC_RUNTIME_CAPABILITY.MICROWARPDRIVE],
  ["npcBehaviorMicroJumpAttack", NPC_RUNTIME_CAPABILITY.MICRO_JUMP_ATTACK],
  ["npcBehaviorMiningLaser", NPC_RUNTIME_CAPABILITY.MINING_LASER],
  ["npcBehaviorFakeMiningLaser", NPC_RUNTIME_CAPABILITY.MINING_LASER],
  ["npcBehaviorIndustrialCore", NPC_RUNTIME_CAPABILITY.INDUSTRIAL_CORE],
  ["entityDrifterControlled", NPC_RUNTIME_CAPABILITY.DEPENDANT_CONTROLLER],
  ["targetDroneBandwidthMultiplier", NPC_RUNTIME_CAPABILITY.DRONE_BANDWIDTH_SUPPRESSION],
  ["NPCGroupShieldAssist", NPC_RUNTIME_CAPABILITY.GROUP_SHIELD_ASSIST],
  ["NPCGroupArmorAssist", NPC_RUNTIME_CAPABILITY.GROUP_ARMOR_ASSIST],
  ["NPCGroupSpeedAssist", NPC_RUNTIME_CAPABILITY.GROUP_SPEED_ASSIST],
  ["NPCGroupPropJamAssist", NPC_RUNTIME_CAPABILITY.GROUP_PROPULSION_JAM_ASSIST],
  ["entityEnvironmentalEffectDamageTest", NPC_RUNTIME_CAPABILITY.ENVIRONMENTAL_DAMAGE],
  ["entitySelfVelocityMultiply", NPC_RUNTIME_CAPABILITY.SELF_VELOCITY_MODIFIER],
  ["entitySelfCruiseSpeedMultiply", NPC_RUNTIME_CAPABILITY.SELF_CRUISE_SPEED_MODIFIER],
  ["behaviorModuleBonusWarfareLinkMiningFake", NPC_RUNTIME_CAPABILITY.MINING_COMMAND_BURST],
]);

const EXCLUDED_EFFECT_REASON_BY_NAME = Object.freeze({
  "super shield visual effect": "PRESENTATION_ONLY_EFFECT",
});

const CAPABILITY_BY_ENTITY_EWAR_FAMILY = Object.freeze({
  web: NPC_RUNTIME_CAPABILITY.STASIS_WEBIFIER,
  scram: NPC_RUNTIME_CAPABILITY.WARP_SCRAMBLER,
  neut: NPC_RUNTIME_CAPABILITY.ENERGY_NEUTRALIZER,
  trackingDisrupt: NPC_RUNTIME_CAPABILITY.TRACKING_DISRUPTOR,
  sensorDamp: NPC_RUNTIME_CAPABILITY.SENSOR_DAMPENER,
  paint: NPC_RUNTIME_CAPABILITY.TARGET_PAINTER,
  ecm: NPC_RUNTIME_CAPABILITY.ECM_JAMMER,
});

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function normalizeEffectName(value) {
  return String(value || "").trim().toLowerCase();
}

function cloneEvidenceEffect(effectRecord = {}) {
  return {
    effectID: toInt(effectRecord.effectID, 0),
    effectName: String(effectRecord.name || ""),
    effectGuid: String(effectRecord.guid || ""),
    effectCategoryID: toInt(effectRecord.effectCategoryID, 0),
    isOffensive: effectRecord.isOffensive === true,
    isAssistance: effectRecord.isAssistance === true,
  };
}

function hasNonzeroTargetAttackDamage(attributeMap = {}) {
  const damage = [114, 116, 117, 118]
    .map((attributeID) => Number(attributeMap[attributeID]) || 0)
    .reduce((total, value) => total + Math.max(0, value), 0);
  const multiplier = attributeMap[64] == null
    ? 1
    : Math.max(0, Number(attributeMap[64]) || 0);
  return damage > 0 && multiplier > 0;
}

function listSdeNpcTypes(options = {}) {
  const categoryID = toInt(options.categoryID, SDE_NPC_CATEGORY_ID);
  const rows = Array.isArray(options.typeRows)
    ? options.typeRows
    : readStaticRows(TABLE.ITEM_TYPES);
  return rows
    .filter((row) => toInt(row && row.categoryID, 0) === categoryID)
    .map((row) => ({ ...row, typeID: toInt(row && (row.typeID ?? row._key), 0) }))
    .filter((row) => row.typeID > 0)
    .sort((left, right) => left.typeID - right.typeID);
}

function resolveEffectRecordsFromFixture(options = {}) {
  if (Array.isArray(options.effectRecords)) {
    return options.effectRecords;
  }
  return null;
}

function resolveNpcSdeCapabilities(typeID, options = {}) {
  const numericTypeID = toInt(typeID, 0);
  const typeRecord = options.typeRecord === undefined
    ? resolveItemByTypeID(numericTypeID)
    : options.typeRecord;
  const dogmaRecord = options.dogmaRecord === undefined
    ? getTypeDogmaRecord(numericTypeID)
    : options.dogmaRecord;
  const fixtureEffects = resolveEffectRecordsFromFixture(options);
  const effectRecords = fixtureEffects || (
    numericTypeID > 0 ? getTypeEffectRecords(numericTypeID) : []
  );
  const attributeMap = options.attributeMap === undefined
    ? (numericTypeID > 0 ? getTypeAttributeMap(numericTypeID) : {})
    : options.attributeMap;
  const capabilityEvidence = [];
  const unknownMechanics = [];
  const excludedMechanics = [];

  if (typeRecord && !dogmaRecord && fixtureEffects === null) {
    unknownMechanics.push({
      reason: "TYPE_DOGMA_MISSING",
      source: "sde_type_dogma",
      typeID: numericTypeID,
      effectID: 0,
      effectName: "",
    });
  }

  for (const effectRecord of effectRecords) {
    const normalizedName = normalizeEffectName(effectRecord && effectRecord.name);
    const excludedReason = EXCLUDED_EFFECT_REASON_BY_NAME[normalizedName] || "";
    if (excludedReason) {
      excludedMechanics.push({
        reason: excludedReason,
        source: "sde_dogma_effect",
        typeID: numericTypeID,
        ...cloneEvidenceEffect(effectRecord),
      });
      continue;
    }
    if (
      normalizedName === "targetattack" &&
      fixtureEffects === null &&
      !hasNonzeroTargetAttackDamage(attributeMap)
    ) {
      excludedMechanics.push({
        reason: "INERT_ZERO_DAMAGE_TARGET_ATTACK_SHELL",
        source: "sde_dogma_effect",
        typeID: numericTypeID,
        ...cloneEvidenceEffect(effectRecord),
      });
      continue;
    }
    const capabilityID = CAPABILITY_BY_EFFECT_NAME[normalizedName] || "";
    if (!capabilityID) {
      unknownMechanics.push({
        reason: "UNKNOWN_EFFECT",
        source: "sde_dogma_effect",
        typeID: numericTypeID,
        ...cloneEvidenceEffect(effectRecord),
      });
      continue;
    }
    capabilityEvidence.push({
      capabilityID,
      source: "sde_dogma_effect",
      typeID: numericTypeID,
      ...cloneEvidenceEffect(effectRecord),
      effectRecord,
    });
  }

  for (const spec of resolveEntityEwarSpecs(attributeMap)) {
    const capabilityID = CAPABILITY_BY_ENTITY_EWAR_FAMILY[String(spec.family || "")];
    if (!capabilityID) {
      unknownMechanics.push({
        reason: "UNKNOWN_ENTITY_EWAR_ATTRIBUTE_FAMILY",
        source: "sde_dogma_attributes",
        typeID: numericTypeID,
        family: String(spec.family || ""),
        effectID: 0,
        effectName: String(spec.effectName || ""),
      });
      continue;
    }
    capabilityEvidence.push({
      capabilityID,
      source: "sde_dogma_attributes",
      typeID: numericTypeID,
      family: String(spec.family || ""),
      effectID: 0,
      effectName: String(spec.effectName || ""),
      activationChance: Number(spec.activationChance) || 0,
      rangeMeters: Number(spec.rangeMeters) || 0,
      durationMs: Number(spec.durationMs) || 0,
      effectRecord: { name: String(spec.effectName || "") },
    });
  }

  const detectedCapabilities = [...new Set(
    capabilityEvidence.map((entry) => entry.capabilityID),
  )].sort();

  return {
    typeID: numericTypeID,
    typeExists: Boolean(typeRecord),
    typeName: String(typeRecord && typeRecord.name || dogmaRecord && dogmaRecord.typeName || ""),
    groupID: toInt(typeRecord && typeRecord.groupID, 0),
    groupName: String(typeRecord && typeRecord.groupName || ""),
    categoryID: toInt(typeRecord && typeRecord.categoryID, 0),
    dogmaAvailable: Boolean(dogmaRecord || fixtureEffects),
    detectedCapabilities,
    capabilityEvidence,
    unknownMechanics,
    excludedMechanics,
  };
}

function getSdeNpcEnumerationAudit() {
  const types = listSdeNpcTypes();
  const dogmaRoot = readStaticTable(TABLE.TYPE_DOGMA) || {};
  const typesByTypeID = dogmaRoot.typesByTypeID || {};
  return {
    categoryID: SDE_NPC_CATEGORY_ID,
    categoryReason: "All SDE Entity-category types are auditable NPC/runtime entities.",
    excludedGroups: [],
    npcTypeCount: types.length,
    npcTypesWithDogmaCount: types.filter((entry) => Boolean(
      typesByTypeID[String(entry.typeID)],
    )).length,
  };
}

module.exports = {
  SDE_NPC_CATEGORY_ID,
  NPC_RUNTIME_CAPABILITY,
  CAPABILITY_BY_EFFECT_NAME,
  CAPABILITY_BY_ENTITY_EWAR_FAMILY,
  EXCLUDED_EFFECT_REASON_BY_NAME,
  listSdeNpcTypes,
  resolveNpcSdeCapabilities,
  getSdeNpcEnumerationAudit,
};
