"use strict";

module.exports = {
  getEffectCycleBoundaryMs,
  moduleDisallowsRepeatingActivation,
  normalizeEffectRepeatCount,
  resolveInitialModuleRemainingCycles,
  resolveModuleRemainingCyclesForActivation,
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
  toFiniteNumber,
  toInt,
} = require("../../common/numbers");

function getEffectCycleBoundaryMs(effectState, fallbackNow = Date.now()) {
  if (!effectState) {
    return Math.max(toFiniteNumber(fallbackNow, Date.now()), 0);
  }

  const durationMs = Math.max(1, toFiniteNumber(effectState.durationMs, 1000));
  const nextCycleAtMs = toFiniteNumber(effectState.nextCycleAtMs, 0);
  if (nextCycleAtMs > 0) {
    return nextCycleAtMs;
  }

  const startedAtMs = toFiniteNumber(effectState.startedAtMs, 0);
  if (startedAtMs > 0) {
    return startedAtMs + durationMs;
  }

  return Math.max(toFiniteNumber(fallbackNow, Date.now()), 0);
}

function normalizeEffectRepeatCount(rawRepeat, fallbackRepeat = null) {
  if (
    rawRepeat === undefined ||
    rawRepeat === null ||
    rawRepeat === true ||
    rawRepeat === false
  ) {
    return fallbackRepeat;
  }

  const normalizedRepeat = Math.trunc(Number(rawRepeat));
  if (!Number.isFinite(normalizedRepeat)) {
    return fallbackRepeat;
  }

  if (normalizedRepeat === 0) {
    return 0;
  }

  if (normalizedRepeat < 0) {
    return fallbackRepeat;
  }

  return normalizedRepeat;
}

function resolveInitialModuleRemainingCycles(rawRepeat) {
  return normalizeEffectRepeatCount(rawRepeat, null) === 0 ? 1 : null;
}

const ATTRIBUTE_DISALLOW_REPEATING_ACTIVATION =
  getAttributeIDByNames("disallowRepeatingActivation") || 1014;

// "If set, this module cannot be activated and made to autorepeat." The rule is
// a type attribute rather than the effect's disallowAutoRepeat flag — a
// Signature Radius Suppressor, for instance, carries disallowRepeatingActivation
// while its effect leaves disallowAutoRepeat false. Enforce it here rather than
// trusting the repeat count the client sent, so a module that must fire once
// cannot be held on by asking for it.
function moduleDisallowsRepeatingActivation(moduleItem) {
  return toInt(
    getTypeAttributeValue(
      toInt(moduleItem && moduleItem.typeID, 0),
      "disallowRepeatingActivation",
    ),
    0,
  ) === 1;
}

// Only the server-side cycle budget is capped. effectState.repeat is the count
// the client is told for its FX presentation, and Micro Jump Drives in
// particular carry their own engage-FX shape off it — clamping that too changed
// their payload and broke the golden client-FX contracts.
function resolveModuleRemainingCyclesForActivation(rawRepeat, moduleItem = null) {
  if (moduleDisallowsRepeatingActivation(moduleItem)) {
    return 1;
  }
  return resolveInitialModuleRemainingCycles(rawRepeat);
}

Object.assign(module.exports, {
  ATTRIBUTE_DISALLOW_REPEATING_ACTIVATION,
});
