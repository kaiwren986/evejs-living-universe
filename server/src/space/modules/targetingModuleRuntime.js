"use strict";

const {
  toFiniteNumber,
} = require("../../common/numbers");

// Auto Targeting Systems (effect 55 targetHostiles) and Passive Targeters
// (effect 54 targetPassively).
//
// Both effects carry an empty modifierInfo in the SDE — everything they declare
// is behaviour the server has to implement, not a modifier the dogma engine can
// apply. Until this existed both modules activated, cycled and burned capacitor
// while doing nothing at all.
//
// The passive halves of these modules are unaffected by any of this: an Auto
// Targeting System's +2/+3 maxLockedTargetsBonus rides on effect 118
// (electronicAttributeModifyOnline) and already lands through the ordinary ship
// resource state.
const path = require("path");

const {
  getAttributeIDByNames,
} = require(path.join(__dirname, "../../services/fitting/liveFittingState"));
const {
  buildLiveModuleAttributeMap,
} = require(path.join(__dirname, "./liveModuleAttributes"));

const GROUP_AUTO_TARGETING_SYSTEM = 96;
const GROUP_PASSIVE_TARGETING_SYSTEM = 82;

const EFFECT_TARGET_PASSIVELY = 54;
const EFFECT_TARGET_HOSTILES = 55;

const ATTRIBUTE_CAPACITOR_NEED = getAttributeIDByNames("capacitorNeed") || 6;
const ATTRIBUTE_DURATION = getAttributeIDByNames("duration") || 73;
const ATTRIBUTE_TARGET_HOSTILE_RANGE = getAttributeIDByNames("targetHostileRange") || 143;
const ATTRIBUTE_MAX_TARGET_RANGE = getAttributeIDByNames("maxTargetRange") || 76;

function toInt(value, fallback = 0) {
  const numeric = Math.trunc(Number(value) || 0);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function roundNumber(value, digits = 6) {
  return Number(toFiniteNumber(value, 0).toFixed(digits));
}

function normalizeEffectName(effectRecord) {
  return String((effectRecord && effectRecord.name) || "").trim().toLowerCase();
}

function isAutoTargetingEffect(effectRecord, moduleItem = null) {
  return (
    normalizeEffectName(effectRecord) === "targethostiles" ||
    toInt(effectRecord && effectRecord.effectID, 0) === EFFECT_TARGET_HOSTILES ||
    toInt(moduleItem && moduleItem.groupID, 0) === GROUP_AUTO_TARGETING_SYSTEM
  );
}

function isPassiveTargetingEffect(effectRecord, moduleItem = null) {
  return (
    normalizeEffectName(effectRecord) === "targetpassively" ||
    toInt(effectRecord && effectRecord.effectID, 0) === EFFECT_TARGET_PASSIVELY ||
    toInt(moduleItem && moduleItem.groupID, 0) === GROUP_PASSIVE_TARGETING_SYSTEM
  );
}

function isTargetingModuleEffect(effectRecord, moduleItem = null) {
  return (
    isAutoTargetingEffect(effectRecord, moduleItem) ||
    isPassiveTargetingEffect(effectRecord, moduleItem)
  );
}

function getPreferredAttributeValue(attributeMap, preferredAttributeIDs = [], fallback = 0) {
  if (!attributeMap || typeof attributeMap !== "object") {
    return { attributeID: 0, value: toFiniteNumber(fallback, 0) };
  }
  for (const attributeID of preferredAttributeIDs) {
    const numericAttributeID = toInt(attributeID, 0);
    if (
      numericAttributeID > 0 &&
      Object.prototype.hasOwnProperty.call(attributeMap, numericAttributeID)
    ) {
      return {
        attributeID: numericAttributeID,
        value: toFiniteNumber(attributeMap[numericAttributeID], fallback),
      };
    }
  }
  return { attributeID: 0, value: toFiniteNumber(fallback, 0) };
}

function buildTargetingRuntimeAttributes(moduleAttributes, effectRecord) {
  const durationResolution = getPreferredAttributeValue(
    moduleAttributes,
    [effectRecord && effectRecord.durationAttributeID, ATTRIBUTE_DURATION],
    5000,
  );
  const dischargeResolution = getPreferredAttributeValue(
    moduleAttributes,
    [effectRecord && effectRecord.dischargeAttributeID, ATTRIBUTE_CAPACITOR_NEED],
    0,
  );
  return {
    capNeed: Math.max(0, roundNumber(dischargeResolution.value, 6)),
    durationMs: Math.max(1, roundNumber(durationResolution.value, 3)),
    durationAttributeID:
      durationResolution.attributeID > 0
        ? durationResolution.attributeID
        : ATTRIBUTE_DURATION,
    reactivationDelayMs: 0,
    maxGroupActive: 0,
    weaponFamily: null,
    attributeOverrides: { ...moduleAttributes },
  };
}

function resolveTargetingModuleActivation({
  entity,
  moduleItem,
  effectRecord,
  shipItem,
  skillMap = null,
  fittedItems = null,
  activeModuleContexts = null,
  additionalLocationModifierSources = null,
  targetID = 0,
} = {}) {
  if (!isTargetingModuleEffect(effectRecord, moduleItem)) {
    return { matched: false };
  }
  if (!entity || !moduleItem || !shipItem) {
    return { matched: true, success: false, errorMsg: "UNSUPPORTED_MODULE" };
  }

  const moduleAttributes = buildLiveModuleAttributeMap(
    shipItem,
    moduleItem,
    null,
    skillMap,
    fittedItems,
    activeModuleContexts,
    {
      additionalLocationModifierSources: Array.isArray(additionalLocationModifierSources)
        ? additionalLocationModifierSources
        : [],
    },
  );
  if (!moduleAttributes) {
    return { matched: true, success: false, errorMsg: "UNSUPPORTED_MODULE" };
  }

  const runtimeAttrs = buildTargetingRuntimeAttributes(moduleAttributes, effectRecord);

  // effect 54 is category 2 (activeTarget): a passive targeter is pointed at one
  // ship, so a target is mandatory. effect 55 sweeps and takes none.
  if (isPassiveTargetingEffect(effectRecord, moduleItem)) {
    const normalizedTargetID = toInt(targetID, 0);
    if (normalizedTargetID <= 0) {
      return { matched: true, success: false, errorMsg: "TARGET_REQUIRED" };
    }
    return {
      matched: true,
      success: true,
      data: {
        offensiveActivation: false,
        runtimeAttrs,
        effectStatePatch: {
          passiveTargetingEffect: true,
          targetID: normalizedTargetID,
        },
      },
    };
  }

  // targetHostileRange is the module's own reach and is what the client shows as
  // its targeting range. Fall back to the ship's maxTargetRange only if a type
  // somehow omits it, so a missing attribute cannot silently mean "zero reach".
  const rangeResolution = getPreferredAttributeValue(
    moduleAttributes,
    [ATTRIBUTE_TARGET_HOSTILE_RANGE],
    0,
  );
  const autoTargetRangeMeters = rangeResolution.value > 0
    ? Math.max(0, roundNumber(rangeResolution.value, 3))
    : Math.max(0, roundNumber(toFiniteNumber(entity.maxTargetRange, 0), 3));

  return {
    matched: true,
    success: true,
    data: {
      offensiveActivation: false,
      runtimeAttrs,
      effectStatePatch: {
        autoTargetingEffect: true,
        autoTargetRangeMeters,
      },
    },
  };
}

// One Auto Targeting System cycle: acquire whatever hostiles are in reach and
// still fit in the ship's remaining lock slots.
//
// "Hostile" is read off the entities currently targeting this ship rather than
// invented from standings — the module exists to answer someone who has engaged
// you, and targeters are the runtime's own record of exactly that.
function executeAutoTargetingCycle({
  scene,
  entity,
  effectState,
  nowMs,
  callbacks = {},
} = {}) {
  if (!scene || !entity || !effectState) {
    return { success: false, stopReason: "module" };
  }

  const rangeMeters = Math.max(0, toFiniteNumber(effectState.autoTargetRangeMeters, 0));
  if (rangeMeters <= 0) {
    return { success: true, data: { acquiredTargetIDs: [] } };
  }

  const candidates = callbacks.listAutoTargetCandidates
    ? callbacks.listAutoTargetCandidates(entity, rangeMeters)
    : [];
  const acquiredTargetIDs = [];
  for (const candidateEntity of Array.isArray(candidates) ? candidates : []) {
    const candidateID = toInt(candidateEntity && candidateEntity.itemID, 0);
    if (candidateID <= 0) {
      continue;
    }
    const acquired = callbacks.acquireAutoTarget
      ? callbacks.acquireAutoTarget(entity, candidateEntity, nowMs)
      : false;
    if (acquired) {
      acquiredTargetIDs.push(candidateID);
    }
  }

  return { success: true, data: { acquiredTargetIDs } };
}

module.exports = {
  GROUP_AUTO_TARGETING_SYSTEM,
  GROUP_PASSIVE_TARGETING_SYSTEM,
  EFFECT_TARGET_HOSTILES,
  EFFECT_TARGET_PASSIVELY,
  ATTRIBUTE_TARGET_HOSTILE_RANGE,
  ATTRIBUTE_MAX_TARGET_RANGE,
  isAutoTargetingEffect,
  isPassiveTargetingEffect,
  isTargetingModuleEffect,
  resolveTargetingModuleActivation,
  executeAutoTargetingCycle,
};
