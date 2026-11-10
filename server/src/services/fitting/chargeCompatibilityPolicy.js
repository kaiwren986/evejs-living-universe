"use strict";

const DEFAULT_UNKNOWN_CAPACITY_QUANTITY = 1;

function positiveNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function positiveInteger(value) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

function normalizeDeclaredGroupIDs(values) {
  return [...new Set(Array.from(values || [])
    .map(positiveInteger)
    .filter((value) => value !== null))]
    .sort((left, right) => left - right);
}

/**
 * Resolve the number of charges that can fit in a module.
 *
 * Positive capacity and volume are authoritative and may legitimately produce
 * zero. When either fact is absent/nonpositive, the SDE does not provide a
 * usable volume bound. Eve.js deliberately falls back to one unit so callers
 * receive a finite, nonnegative quantity without inventing an unbounded clip.
 */
function calculateChargeCapacity({ moduleCapacity, chargeVolume } = {}) {
  const capacity = positiveNumber(moduleCapacity);
  const volume = positiveNumber(chargeVolume);

  if (capacity !== null && volume !== null) {
    // The client's GetModuleCapacityForAmmoType: int(capacity / volume + 1e-07)
    // (dogma/ammoloadingUtils.py). The epsilon keeps a quotient such as
    // 0.6 / 0.05 = 11.999999999999998 at 12.
    const maximumQuantity = Math.trunc(capacity / volume + 1e-7);
    return {
      status: maximumQuantity > 0 ? "authoritative" : "rejected-oversized",
      maximumQuantity,
      moduleCapacity: capacity,
      chargeVolume: volume,
      fallbackReason: null,
    };
  }

  const missingFacts = [];
  if (capacity === null) missingFacts.push("module-capacity-missing-or-nonpositive");
  if (volume === null) missingFacts.push("charge-volume-missing-or-nonpositive");
  return {
    status: "single-unit-fallback",
    maximumQuantity: DEFAULT_UNKNOWN_CAPACITY_QUANTITY,
    moduleCapacity: capacity,
    chargeVolume: volume,
    fallbackReason: missingFacts.join("+"),
  };
}

/**
 * Pure module/charge policy shared by runtime adapters and parity tooling.
 * Module-declared charge groups are the primary relationship. Reciprocal
 * launcherGroup facts are intentionally not a veto: the pinned SDE uses them
 * as corroborating family metadata and does not populate them consistently.
 *
 * The size gate is the MODULE's. Transcribed from the V24 client,
 * `dogma/ammoloadingUtils.py#IsChargeCompatibleWithLauncher`:
 *
 *     requiredChargeSize = GetTypeAttribute2(moduleTypeID, attributeChargeSize)
 *     if requiredChargeSize and requiredChargeSize == GetTypeAttribute2(ammoTypeID, attributeChargeSize):
 *         return True
 *     if not requiredChargeSize and GetModuleCapacityForAmmoType(...) > 0:
 *         return True
 *     return False
 *
 * `GetTypeAttribute2` returns the SDE `defaultValue` for a type that does not
 * declare the attribute, and `chargeSize` (128) defaults to 0. So a charge that
 * declares no size reads 0, and 0 never equals a module's positive required
 * size. The client's other loader says the same thing in the other direction:
 * `eve/client/script/ui/shared/fitting/fittingUtil.py` uses
 * `if desiredSize and getattr(chargeDgmType, 'chargeSize', -1) != desiredSize`.
 *
 * Requiring BOTH sides to declare a positive size before enforcing anything is
 * what let Cap Booster 25 and Navy Cap Booster 25 — the only two published
 * charges in group 87 with no `chargeSize` — into every sized Ancillary Shield
 * Booster: 42 one-cubic-metre charges into a Large that is built for 7.
 */
function evaluateChargeCompatibility({
  declaredChargeGroupIDs,
  chargeGroupID,
  moduleChargeSize,
  chargeSize,
  moduleCapacity,
  chargeVolume,
} = {}) {
  const groups = normalizeDeclaredGroupIDs(declaredChargeGroupIDs);
  const normalizedChargeGroupID = positiveInteger(chargeGroupID);
  const normalizedModuleSize = positiveNumber(moduleChargeSize);
  const normalizedChargeSize = positiveNumber(chargeSize);
  const capacity = calculateChargeCapacity({ moduleCapacity, chargeVolume });

  if (
    normalizedChargeGroupID === null ||
    !groups.includes(normalizedChargeGroupID)
  ) {
    return {
      accepted: false,
      rejectionReason: "charge-group-not-declared-by-module",
      groupConstraint: "rejected",
      sizeConstraint: "not-evaluated",
      capacityConstraint: "not-evaluated",
      maximumQuantity: 0,
      capacity,
    };
  }

  // An undeclared charge size is the attribute's default of 0, not "unknown".
  const effectiveChargeSize = normalizedChargeSize === null ? 0 : normalizedChargeSize;
  if (
    normalizedModuleSize !== null &&
    normalizedModuleSize !== effectiveChargeSize
  ) {
    return {
      accepted: false,
      rejectionReason: "charge-size-mismatch",
      groupConstraint: "matched",
      sizeConstraint: "rejected-mismatch",
      capacityConstraint: "not-evaluated",
      maximumQuantity: 0,
      capacity,
    };
  }

  if (capacity.maximumQuantity <= 0) {
    return {
      accepted: false,
      rejectionReason: "charge-volume-exceeds-module-capacity",
      groupConstraint: "matched",
      sizeConstraint:
        normalizedModuleSize !== null && normalizedChargeSize !== null
          ? "matched"
          : "not-declared-on-both-sides",
      capacityConstraint: "rejected-oversized",
      maximumQuantity: 0,
      capacity,
    };
  }

  return {
    accepted: true,
    rejectionReason: null,
    groupConstraint: "matched",
    sizeConstraint:
      normalizedModuleSize !== null && normalizedChargeSize !== null
        ? "matched"
        : "not-declared-on-both-sides",
    capacityConstraint:
      capacity.status === "authoritative"
        ? "fits"
        : "single-unit-fallback",
    maximumQuantity: capacity.maximumQuantity,
    capacity,
  };
}

module.exports = {
  DEFAULT_UNKNOWN_CAPACITY_QUANTITY,
  calculateChargeCapacity,
  evaluateChargeCompatibility,
  normalizeDeclaredGroupIDs,
  positiveNumber,
};
