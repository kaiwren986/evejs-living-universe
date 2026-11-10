"use strict";

const {
  toFiniteNumber,
} = require("../../common/numbers");

// Reactive Armor Hardener (effect 4928 adaptiveArmorHardener).
//
// The module spreads a fixed 60 percentage points of armour resistance over the
// four damage types, starting at 15 in each, and every cycle it moves resistance
// away from the damage types it is taking least of and toward the ones it is
// taking most of.
//
// The client does none of this. eve/common/script/dogma/pythonEffects/
// adaptiveHardener.py only carries the modifier plumbing, and its _SetDamageStats
// and _GetAttributeValuesToUpdate hooks are empty stubs — the adaptation is
// server-side, and the client simply re-reads whatever resonances the server
// writes onto the module. This file is that server side.
//
// The redistribution matches the reference implementation in pyfa's engine
// (eos/sim/reactive_armor_hardener.py, __get_next_resos), which is the model
// every player's fitting tool predicts from.
const path = require("path");

const {
  getAttributeIDByNames,
  buildEffectiveItemAttributeMap,
} = require(path.join(__dirname, "../../services/fitting/liveFittingState"));

const EFFECT_ID_ADAPTIVE_ARMOR_HARDENER = 4928;
const EFFECT_NAME_ADAPTIVE_ARMOR_HARDENER = "adaptivearmorhardener";

const ATTRIBUTE_ARMOR_EM_RESONANCE = getAttributeIDByNames("armorEmDamageResonance") || 267;
const ATTRIBUTE_ARMOR_EXPLOSIVE_RESONANCE =
  getAttributeIDByNames("armorExplosiveDamageResonance") || 268;
const ATTRIBUTE_ARMOR_KINETIC_RESONANCE =
  getAttributeIDByNames("armorKineticDamageResonance") || 269;
const ATTRIBUTE_ARMOR_THERMAL_RESONANCE =
  getAttributeIDByNames("armorThermalDamageResonance") || 270;
const ATTRIBUTE_RESISTANCE_SHIFT_AMOUNT =
  getAttributeIDByNames("resistanceShiftAmount") || 1849;

// Order matters and is not cosmetic: sorting is by damage received first and by
// this order second, so it is the documented tie-breaker when two damage types
// land identical amounts — which is the norm, since most cycles see several
// types at exactly zero.
const RESONANCE_ATTRIBUTE_IDS = Object.freeze([
  ATTRIBUTE_ARMOR_EM_RESONANCE,
  ATTRIBUTE_ARMOR_EXPLOSIVE_RESONANCE,
  ATTRIBUTE_ARMOR_KINETIC_RESONANCE,
  ATTRIBUTE_ARMOR_THERMAL_RESONANCE,
]);

const DAMAGE_TYPE_BY_RESONANCE_ATTRIBUTE_ID = Object.freeze({
  [ATTRIBUTE_ARMOR_EM_RESONANCE]: "em",
  [ATTRIBUTE_ARMOR_EXPLOSIVE_RESONANCE]: "explosive",
  [ATTRIBUTE_ARMOR_KINETIC_RESONANCE]: "kinetic",
  [ATTRIBUTE_ARMOR_THERMAL_RESONANCE]: "thermal",
});

// A resonance of 1 is 0% resistance — nothing left to give.
const MAX_RESONANCE = 1;

function toInt(value, fallback = 0) {
  const numeric = Math.trunc(Number(value) || 0);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function roundNumber(value, decimals = 6) {
  const factor = 10 ** decimals;
  return Math.round(toFiniteNumber(value, 0) * factor) / factor;
}

function isReactiveArmorHardenerEffect(effectRecord) {
  if (!effectRecord) {
    return false;
  }
  if (toInt(effectRecord.effectID, 0) === EFFECT_ID_ADAPTIVE_ARMOR_HARDENER) {
    return true;
  }
  return String(effectRecord.name || "").toLowerCase() ===
    EFFECT_NAME_ADAPTIVE_ARMOR_HARDENER;
}

function isReactiveArmorHardenerEffectState(effectState) {
  if (!effectState) {
    return false;
  }
  if (effectState.reactiveArmorHardenerEffect === true) {
    return true;
  }
  if (toInt(effectState.effectID, 0) === EFFECT_ID_ADAPTIVE_ARMOR_HARDENER) {
    return true;
  }
  return String(effectState.effectName || "").toLowerCase() ===
    EFFECT_NAME_ADAPTIVE_ARMOR_HARDENER;
}

function buildZeroDamageTally() {
  const tally = {};
  for (const attributeID of RESONANCE_ATTRIBUTE_IDS) {
    tally[attributeID] = 0;
  }
  return tally;
}

// The profile the module starts every activation from. Deactivating and
// reactivating a Reactive Armor Hardener resets its resists on TQ, and it comes
// out of that reset at the module's declared 15% across the board — so the seed
// is simply the module's own attributes, and dropping the effect state on
// deactivation is what implements the reset.
function buildInitialResonanceState(moduleItem, chargeItem = null) {
  const moduleAttributes = buildEffectiveItemAttributeMap(moduleItem, chargeItem) || {};
  const resonances = {};
  for (const attributeID of RESONANCE_ATTRIBUTE_IDS) {
    resonances[attributeID] = Math.min(
      MAX_RESONANCE,
      Math.max(0, toFiniteNumber(moduleAttributes[attributeID], MAX_RESONANCE)),
    );
  }
  return {
    reactiveArmorHardenerEffect: true,
    reactiveArmorResonances: resonances,
    reactiveArmorCycleDamage: buildZeroDamageTally(),
    reactiveArmorShiftAmount: Math.max(
      0,
      toFiniteNumber(moduleAttributes[ATTRIBUTE_RESISTANCE_SHIFT_AMOUNT], 0) / 100,
    ),
  };
}

// Seed on first use rather than from the activation path, so a module that was
// already running when this code shipped still adapts.
function ensureResonanceState(effectState, moduleItem, chargeItem = null) {
  if (!effectState) {
    return null;
  }
  if (
    effectState.reactiveArmorResonances &&
    typeof effectState.reactiveArmorResonances === "object"
  ) {
    if (!effectState.reactiveArmorCycleDamage) {
      effectState.reactiveArmorCycleDamage = buildZeroDamageTally();
    }
    return effectState.reactiveArmorResonances;
  }
  // Keep any damage already recorded against this activation. Seeding happens
  // at the first cycle boundary, by which point the first cycle's damage is
  // already tallied — overwriting it here cost the module a full cycle of
  // adaptation every time it was switched on.
  const pendingCycleDamage = effectState.reactiveArmorCycleDamage;
  Object.assign(effectState, buildInitialResonanceState(moduleItem, chargeItem));
  if (pendingCycleDamage && typeof pendingCycleDamage === "object") {
    effectState.reactiveArmorCycleDamage = pendingCycleDamage;
  }
  return effectState.reactiveArmorResonances;
}

// The live resonances the ship's derived state must read, rather than the
// module type's static 15% across the board.
function getReactiveArmorHardenerResonanceOverrides(effectState) {
  if (
    !isReactiveArmorHardenerEffectState(effectState) ||
    !effectState.reactiveArmorResonances ||
    typeof effectState.reactiveArmorResonances !== "object"
  ) {
    return null;
  }
  const overrides = {};
  for (const attributeID of RESONANCE_ATTRIBUTE_IDS) {
    const value = toFiniteNumber(effectState.reactiveArmorResonances[attributeID], NaN);
    if (Number.isFinite(value)) {
      overrides[attributeID] = value;
    }
  }
  return Object.keys(overrides).length > 0 ? overrides : null;
}

// Record what the armour actually took this cycle, per damage type. Only the
// ordering of these totals matters — the module ignores how much damage was
// dealt and reacts purely to which types outrank which.
function noteArmorDamageForReactiveHardener(entity, appliedRawDamage, armorResonances) {
  if (!entity || !appliedRawDamage || !(entity.activeModuleEffects instanceof Map)) {
    return false;
  }
  let recorded = false;
  for (const effectState of entity.activeModuleEffects.values()) {
    if (!isReactiveArmorHardenerEffectState(effectState)) {
      continue;
    }
    if (!effectState.reactiveArmorCycleDamage) {
      effectState.reactiveArmorCycleDamage = buildZeroDamageTally();
    }
    for (const attributeID of RESONANCE_ATTRIBUTE_IDS) {
      const damageType = DAMAGE_TYPE_BY_RESONANCE_ATTRIBUTE_ID[attributeID];
      const rawAmount = Math.max(0, toFiniteNumber(appliedRawDamage[damageType], 0));
      if (rawAmount <= 0) {
        continue;
      }
      const resonance = Math.max(
        0,
        toFiniteNumber(armorResonances && armorResonances[damageType], 1),
      );
      effectState.reactiveArmorCycleDamage[attributeID] += rawAmount * resonance;
      recorded = true;
    }
  }
  return recorded;
}

// One cycle of redistribution.
//
// Transcribed from eos/sim/reactive_armor_hardener.py __get_next_resos: at least
// two damage types donate, plus one more for each type that took no damage at
// all; each donor gives up to shiftAmount of resonance but never past 1 (0%
// resistance); the total donated is split evenly among the remaining types.
//
// Total resonance is conserved, which is what holds the module to its 60 point
// pool: with three types drained to 0% the fourth necessarily sits at 60%.
function resolveNextResonances(currentResonances, cycleDamage, shiftAmount) {
  const zeroDamageCount = RESONANCE_ATTRIBUTE_IDS.filter(
    (attributeID) => toFiniteNumber(cycleDamage && cycleDamage[attributeID], 0) <= 0,
  ).length;
  const donorCount = Math.max(2, zeroDamageCount);
  const recipientCount = RESONANCE_ATTRIBUTE_IDS.length - donorCount;
  if (recipientCount <= 0) {
    // Nothing was hit, so there is nobody to give the resistance to. TQ's own
    // pool invariant cannot survive a redistribution with no recipients — every
    // resonance would climb toward 0% resistance and the module would end up
    // strictly worse than an empty slot — so an undamaged cycle changes nothing.
    return null;
  }

  // Ascending by damage taken; ties fall back to the declared attribute order.
  const orderedAttributeIDs = [...RESONANCE_ATTRIBUTE_IDS]
    .map((attributeID, index) => ({ attributeID, index }))
    .sort((left, right) => {
      const leftDamage = toFiniteNumber(cycleDamage && cycleDamage[left.attributeID], 0);
      const rightDamage = toFiniteNumber(cycleDamage && cycleDamage[right.attributeID], 0);
      if (leftDamage !== rightDamage) {
        return leftDamage - rightDamage;
      }
      return left.index - right.index;
    })
    .map((entry) => entry.attributeID);

  const nextResonances = {};
  let donatedAmount = 0;
  for (const attributeID of orderedAttributeIDs.slice(0, donorCount)) {
    const currentResonance = toFiniteNumber(currentResonances[attributeID], MAX_RESONANCE);
    const donation = Math.min(MAX_RESONANCE - currentResonance, shiftAmount);
    donatedAmount += donation;
    nextResonances[attributeID] = roundNumber(currentResonance + donation);
  }
  for (const attributeID of orderedAttributeIDs.slice(donorCount)) {
    const currentResonance = toFiniteNumber(currentResonances[attributeID], MAX_RESONANCE);
    nextResonances[attributeID] = roundNumber(
      currentResonance - (donatedAmount / recipientCount),
    );
  }
  return nextResonances;
}

function executeReactiveArmorHardenerCycle({
  entity,
  moduleItem,
  chargeItem = null,
  effectState,
} = {}) {
  if (!entity || !effectState || !isReactiveArmorHardenerEffectState(effectState)) {
    return { matched: false, success: true, data: { resonancesChanged: false } };
  }

  const currentResonances = ensureResonanceState(effectState, moduleItem, chargeItem);
  if (!currentResonances) {
    return { matched: true, success: true, data: { resonancesChanged: false } };
  }

  const shiftAmount = Math.max(0, toFiniteNumber(effectState.reactiveArmorShiftAmount, 0));
  const nextResonances = shiftAmount > 0
    ? resolveNextResonances(
      currentResonances,
      effectState.reactiveArmorCycleDamage,
      shiftAmount,
    )
    : null;

  // The tally covers one cycle only, so it resets whether or not anything moved.
  effectState.reactiveArmorCycleDamage = buildZeroDamageTally();
  if (!nextResonances) {
    return { matched: true, success: true, data: { resonancesChanged: false } };
  }

  const resonancesChanged = RESONANCE_ATTRIBUTE_IDS.some((attributeID) => (
    Math.abs(
      toFiniteNumber(nextResonances[attributeID], 0) -
      toFiniteNumber(currentResonances[attributeID], 0),
    ) > 1e-9
  ));
  effectState.reactiveArmorResonances = nextResonances;
  return { matched: true, success: true, data: { resonancesChanged } };
}

module.exports = {
  EFFECT_ID_ADAPTIVE_ARMOR_HARDENER,
  RESONANCE_ATTRIBUTE_IDS,
  isReactiveArmorHardenerEffect,
  isReactiveArmorHardenerEffectState,
  ensureResonanceState,
  buildInitialResonanceState,
  getReactiveArmorHardenerResonanceOverrides,
  noteArmorDamageForReactiveHardener,
  executeReactiveArmorHardenerCycle,
  _testing: {
    resolveNextResonances,
  },
};
