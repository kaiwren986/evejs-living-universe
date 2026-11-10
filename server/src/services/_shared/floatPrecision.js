"use strict";

// Binary floating point leaves artefacts: 5999.999999999999 where the answer is
// 6000, 0.36800000000000005 where it is 0.368, 99.99999999999997 where it is
// 100. None of those digits are gameplay data — they are IEEE-754
// representation error, and they leak in three damaging ways:
//
//   * strict equality against a parity expectation fails,
//   * the value is published to the client as an attribute change,
//   * the value is converted to an integer. That last one shipped a live bug:
//     99.99999999999997 truncated to 99, and a percentage-bonused Liquid Ozone
//     bill charged a whole unit short.
//
// Two normalizations live here and they are NOT interchangeable.
//
//   normalizeDogmaFloat  Dogma attribute chains. Six decimal places — the
//                        precision the SDE publishes and the client's fitting
//                        view displays.
//   roundToCents         Money, bills, and quantities about to become whole
//                        units. Two decimal places, the ledger's denomination.
//
// Dogma deliberately does not get two decimal places. Resonances are published
// to four or more (0.8691), stacking-penalty coefficients are long by nature
// (1, 0.8691, 0.5706, 0.2830), and jumpPortalConsumptionMassFactor is 1.5e-9.
// Rounding any of those to 2 dp changes combat and jump-fuel arithmetic rather
// than cleaning it up.

const DOGMA_DECIMAL_PLACES = 6;

// A 6-dp round is only a cleanup when it leaves the value essentially where it
// was. Below this relative change, what is being removed is representation
// noise. Above it, 6 dp is eating real precision from a legitimately sub-micro
// attribute and the value is handed back untouched instead. The attributes this
// protects, measured across the whole SDE: warpCapacitorNeed (564 types, down
// to 1.38e-8, would become 0), jumpPortalConsumptionMassFactor (20 types, 1e-9,
// would become 0), agility (304 types, 4.36e-6, would shift by 8.3%),
// entityFactionLoss and trackingSpeed. It is necessary but NOT sufficient on its
// own — see the absolute floor below, which is the other half of the guard.
const DOGMA_MAX_RELATIVE_ADJUSTMENT = 1e-6;

// The relative test above cannot stand on its own, and this floor is why.
//
// A 6-dp round moves a value by at most 5e-7 in absolute terms, so the RELATIVE
// move it produces is bounded by 5e-7 / |value|. That bound grows without limit
// as the value shrinks, and it crosses 1e-6 at |value| = 0.5. So a purely
// relative threshold does not select sub-micro attributes at all — it selects
// *everything below a half* whose seventh decimal place happens to be nonzero,
// which is the opposite of the intent. Six decimal places is not scarce
// precision for a 0.49 resonance or a 0.066 spool bonus; it is five significant
// figures.
//
// Measured over all 643,235 dogma attribute values in the SDE (build 3396210),
// 52 attributes carry at least one value a blind 6-dp round would change, and
// 1,357 individual values move by more than 1e-6 relative. Sorted by magnitude
// they fall into two clearly separated populations:
//
//   |value| < 1e-2   782 values — warpCapacitorNeed down to 1.38e-8,
//                    jumpPortalConsumptionMassFactor and agilityMultiplier at
//                    1e-9, agility at 4.36e-6. Rounding these destroys them:
//                    they go to 0, or shift by 8.3%. Genuinely sub-micro.
//   |value| >= 1e-2  575 values — the eight damage resonances (0.19 to 0.49),
//                    entityCapacitorLevelModifierSmall 0.2635, entityDefender-
//                    Chance 0.2109, speedFactor 0.1333, entitySecurityStatus-
//                    KillBonus 0.0163, plus the large end of trackingSpeed,
//                    entityFactionLoss and agility. Ordinary multipliers. The
//                    worst move the escape introduces across all 575 is
//                    trackingSpeed 0.0129375 -> 0.012937, 3.9e-5 relative.
//
// The floor is derived, not picked: it must sit ABOVE the largest value the
// repo has pinned as needing protection (trackingSpeed 0.001633333) and AT OR
// BELOW the smallest ordinary chain output that has to be cleaned (a precursor
// turret spool of 0.06579388600947744, whose 6-dp round moves it 1.7e-6
// relative and which the relative-only guard therefore refused to touch). That
// window is (0.001633333, 0.065794], and 1e-2 is the only power of ten inside
// it. Equivalently: round whenever at least five significant figures survive.
//
// Below the floor the relative guard still decides, so every sub-micro
// attribute above keeps exactly the protection it had.
const DOGMA_RELATIVE_GUARD_FLOOR = 1e-2;

// Both helpers round half away from zero, via toFixed. This is deliberate and
// differs from Math.round, which is half-UP and therefore asymmetric: it sends
// -0.005 toward zero while sending +0.005 away from it. Dogma carries signed
// attributes (falloffBonus -1.333333333, maxRangeBonus, scanResolutionBonus),
// so a positive and its negative must round to mirrored magnitudes. toFixed is
// also exactly what the twenty-plus existing local `round6` helpers in this
// codebase already use, so a value normalized here compares equal to one
// normalized by any of them.
function roundHalfAwayFromZero(value, decimalPlaces) {
  return Number(value.toFixed(decimalPlaces));
}

// Normalizes the OUTPUT of a Dogma modifier chain. Never call this on an
// intermediate step of a chain: rounding between operations changes the result
// rather than tidying it.
function normalizeDogmaFloat(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    // Leave NaN/Infinity alone so a broken chain stays visibly broken instead
    // of quietly becoming a plausible 0.
    return numeric;
  }
  if (numeric === 0) {
    // Also collapses -0 to +0. Object.is(-0, 0) is false, so an unnormalized -0
    // fails a strict-equality parity check against 0.
    return 0;
  }

  const rounded = roundHalfAwayFromZero(numeric, DOGMA_DECIMAL_PLACES);
  if (Math.abs(numeric) >= DOGMA_RELATIVE_GUARD_FLOOR) {
    // Ordinary magnitude: six decimal places is at least five significant
    // figures here, and the most a 6-dp round can move a value of this size is
    // 5e-5 relative. Round unconditionally — applying the relative test up here
    // is what left a 0.0658 spool bonus and a 0.49 resonance carrying their
    // full IEEE tails.
    return rounded;
  }
  if (rounded === 0) {
    return numeric;
  }
  if (
    Math.abs(numeric - rounded) / Math.abs(numeric) >
    DOGMA_MAX_RELATIVE_ADJUSTMENT
  ) {
    return numeric;
  }
  return rounded;
}

// Normalizes a value denominated in currency or in whole tradeable units, to
// the two decimal places the ledger uses.
function roundToCents(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return numeric;
  }
  if (numeric === 0) {
    return 0;
  }
  return roundHalfAwayFromZero(numeric, 2);
}

// Converts a value that a percentage/multiplier chain produced into a whole
// number of units. Truncating such a value directly is the Liquid Ozone defect:
// 99.99999999999997 units of fuel floors to 99. Normalizing away the binary
// noise first makes the floor land on the intended 100.
function floorAfterNormalizing(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  return Math.floor(normalizeDogmaFloat(numeric));
}

// For a quantity whose true value is always integral — a fuel bill, a unit
// count — but which arrives as a float because a percentage chain produced it.
// Rounding is correct here and truncating is not: the fractional part is
// entirely representation error.
function roundToWholeUnits(value, fallback = 0) {
  const numeric = Number(value);
  return Math.max(
    0,
    Math.round(Number.isFinite(numeric) ? numeric : fallback),
  );
}

function ceilAfterNormalizing(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  return Math.ceil(normalizeDogmaFloat(numeric));
}

module.exports = {
  DOGMA_DECIMAL_PLACES,
  DOGMA_MAX_RELATIVE_ADJUSTMENT,
  DOGMA_RELATIVE_GUARD_FLOOR,
  ceilAfterNormalizing,
  floorAfterNormalizing,
  normalizeDogmaFloat,
  roundToCents,
  roundToWholeUnits,
};
