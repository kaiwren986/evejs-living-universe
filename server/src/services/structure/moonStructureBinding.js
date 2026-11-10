"use strict";

const { isDeepStrictEqual } = require("node:util");

const {
  ELIGIBILITY_CODE,
  MINING_POINT_STATUS,
  MOON_MINING_MODE,
} = require("./moonMiningEligibility");

const MOON_STRUCTURE_BINDING_SCHEMA_VERSION = 1;
const MOON_STRUCTURE_BINDING_AUTHORITY = "moonMiningEligibility";

const BINDING_CODE = Object.freeze({
  BOUND: "MOON_STRUCTURE_BOUND",
  UNBOUND: "MOON_STRUCTURE_UNBOUND",
  INVALID_STRUCTURE: "MOON_STRUCTURE_BINDING_INVALID_STRUCTURE",
  DESTROYED_STRUCTURE: "MOON_STRUCTURE_BINDING_DESTROYED_STRUCTURE",
  INVALID_ELIGIBILITY: "MOON_STRUCTURE_BINDING_INVALID_ELIGIBILITY",
  INVALID_MINING_POINT: "MOON_STRUCTURE_BINDING_INVALID_MINING_POINT",
  AUTHORITY_MISMATCH: "MOON_STRUCTURE_BINDING_AUTHORITY_MISMATCH",
  INVALID_PERSISTED_BINDING: "MOON_STRUCTURE_BINDING_INVALID_PERSISTED_BINDING",
  LEGACY_BINDING_REQUIRES_MIGRATION: "MOON_STRUCTURE_BINDING_LEGACY_REQUIRES_MIGRATION",
  IMMUTABLE_BINDING_CONFLICT: "MOON_STRUCTURE_BINDING_IMMUTABLE_CONFLICT",
  MINING_POINT_OCCUPIED: "MOON_STRUCTURE_BINDING_POINT_OCCUPIED",
});

const SUPPORTED_BINDING_MODES = new Set(Object.values(MOON_MINING_MODE));

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function normalizeDatasetVersion(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function freezeResult(result) {
  if (result && result.binding && isPlainObject(result.binding)) {
    Object.freeze(result.binding);
  }
  if (result && result.structure && isPlainObject(result.structure)) {
    if (isPlainObject(result.structure.moonMiningBinding)) {
      Object.freeze(result.structure.moonMiningBinding);
    }
    Object.freeze(result.structure);
  }
  return Object.freeze(result);
}

function failure(code, details = {}) {
  return freezeResult({
    success: false,
    code,
    ...details,
  });
}

function normalizeCanonicalBinding(value) {
  if (!isPlainObject(value)) {
    return null;
  }
  const datasetVersion = normalizeDatasetVersion(value.datasetVersion);
  const mode = typeof value.mode === "string"
    ? value.mode.trim().toLowerCase()
    : "";
  if (
    value.schemaVersion !== MOON_STRUCTURE_BINDING_SCHEMA_VERSION ||
    value.authority !== MOON_STRUCTURE_BINDING_AUTHORITY ||
    !isPositiveInteger(value.structureID) ||
    !isPositiveInteger(value.solarSystemID) ||
    !isPositiveInteger(value.moonID) ||
    !isPositiveInteger(value.beaconID) ||
    !datasetVersion ||
    !SUPPORTED_BINDING_MODES.has(mode)
  ) {
    return null;
  }
  return Object.freeze({
    schemaVersion: MOON_STRUCTURE_BINDING_SCHEMA_VERSION,
    authority: MOON_STRUCTURE_BINDING_AUTHORITY,
    structureID: value.structureID,
    solarSystemID: value.solarSystemID,
    moonID: value.moonID,
    beaconID: value.beaconID,
    datasetVersion,
    mode,
  });
}

function bindingEquals(left, right) {
  const a = normalizeCanonicalBinding(left);
  const b = normalizeCanonicalBinding(right);
  return Boolean(a && b) &&
    a.schemaVersion === b.schemaVersion &&
    a.authority === b.authority &&
    a.structureID === b.structureID &&
    a.solarSystemID === b.solarSystemID &&
    a.moonID === b.moonID &&
    a.beaconID === b.beaconID &&
    a.datasetVersion === b.datasetVersion &&
    a.mode === b.mode;
}

function buildCanonicalBinding({ structure, locationEligibility, miningPoint } = {}) {
  if (
    !isPlainObject(structure) ||
    !isPositiveInteger(structure.structureID) ||
    !isPositiveInteger(structure.solarSystemID)
  ) {
    return failure(BINDING_CODE.INVALID_STRUCTURE);
  }
  if (
    !isPlainObject(locationEligibility) ||
    locationEligibility.eligible !== true ||
    locationEligibility.code !== ELIGIBILITY_CODE.LOCATION_ELIGIBLE ||
    !isPositiveInteger(locationEligibility.solarSystemID) ||
    !isPositiveInteger(locationEligibility.moonID) ||
    !isPositiveInteger(locationEligibility.beaconID) ||
    !normalizeDatasetVersion(locationEligibility.miningPointDatasetVersion) ||
    typeof locationEligibility.mode !== "string" ||
    !SUPPORTED_BINDING_MODES.has(locationEligibility.mode.trim().toLowerCase())
  ) {
    return failure(BINDING_CODE.INVALID_ELIGIBILITY);
  }
  if (
    !isPlainObject(miningPoint) ||
    String(miningPoint.status || "").trim().toLowerCase() !== MINING_POINT_STATUS.VERIFIED ||
    !isPositiveInteger(miningPoint.solarSystemID) ||
    !isPositiveInteger(miningPoint.moonID) ||
    !isPositiveInteger(miningPoint.beaconID) ||
    !normalizeDatasetVersion(miningPoint.datasetVersion)
  ) {
    return failure(BINDING_CODE.INVALID_MINING_POINT);
  }

  const datasetVersion = normalizeDatasetVersion(miningPoint.datasetVersion);
  const eligibilityDatasetVersion = normalizeDatasetVersion(
    locationEligibility.miningPointDatasetVersion,
  );
  if (
    structure.solarSystemID !== locationEligibility.solarSystemID ||
    miningPoint.solarSystemID !== locationEligibility.solarSystemID ||
    miningPoint.moonID !== locationEligibility.moonID ||
    miningPoint.beaconID !== locationEligibility.beaconID ||
    datasetVersion !== eligibilityDatasetVersion
  ) {
    return failure(BINDING_CODE.AUTHORITY_MISMATCH);
  }

  const binding = normalizeCanonicalBinding({
    schemaVersion: MOON_STRUCTURE_BINDING_SCHEMA_VERSION,
    authority: MOON_STRUCTURE_BINDING_AUTHORITY,
    structureID: structure.structureID,
    solarSystemID: structure.solarSystemID,
    moonID: miningPoint.moonID,
    beaconID: miningPoint.beaconID,
    datasetVersion,
    mode: locationEligibility.mode,
  });
  if (!binding) {
    return failure(BINDING_CODE.AUTHORITY_MISMATCH);
  }
  return freezeResult({
    success: true,
    code: BINDING_CODE.BOUND,
    binding,
  });
}

function inspectStructureBinding(structure) {
  if (
    !isPlainObject(structure) ||
    !isPositiveInteger(structure.structureID) ||
    !isPositiveInteger(structure.solarSystemID)
  ) {
    return failure(BINDING_CODE.INVALID_STRUCTURE);
  }

  const rawBinding = structure.moonMiningBinding;
  const rawMoonID = structure.moonID;
  if (rawBinding === undefined || rawBinding === null) {
    if (rawMoonID === undefined || rawMoonID === null) {
      return freezeResult({ success: true, code: BINDING_CODE.UNBOUND, binding: null });
    }
    return failure(BINDING_CODE.LEGACY_BINDING_REQUIRES_MIGRATION, {
      legacyMoonID: isPositiveInteger(rawMoonID) ? rawMoonID : null,
    });
  }

  const binding = normalizeCanonicalBinding(rawBinding);
  if (
    !binding ||
    binding.structureID !== structure.structureID ||
    binding.solarSystemID !== structure.solarSystemID ||
    binding.moonID !== rawMoonID
  ) {
    return failure(BINDING_CODE.INVALID_PERSISTED_BINDING);
  }
  return freezeResult({ success: true, code: BINDING_CODE.BOUND, binding });
}

function findOccupiedMiningPoint(structures, targetStructureID, binding) {
  for (const candidate of Array.isArray(structures) ? structures : []) {
    if (
      !isPlainObject(candidate) ||
      candidate.destroyedAt ||
      candidate.structureID === targetStructureID
    ) {
      continue;
    }
    const inspected = inspectStructureBinding(candidate);
    if (!inspected.success || !inspected.binding) {
      continue;
    }
    if (
      inspected.binding.moonID === binding.moonID ||
      inspected.binding.beaconID === binding.beaconID
    ) {
      return Object.freeze({
        structureID: candidate.structureID,
        moonID: inspected.binding.moonID,
        beaconID: inspected.binding.beaconID,
      });
    }
  }
  return null;
}

function validateBindingTransition(previousStructures, nextStructures, options = {}) {
  const previousByID = new Map(
    (Array.isArray(previousStructures) ? previousStructures : [])
      .filter((entry) => isPlainObject(entry) && isPositiveInteger(entry.structureID))
      .map((entry) => [entry.structureID, entry]),
  );
  const allowedStructureID = isPositiveInteger(options.allowNewBindingStructureID)
    ? options.allowNewBindingStructureID
    : null;
  let bindingChanged = false;

  for (const next of Array.isArray(nextStructures) ? nextStructures : []) {
    if (!isPlainObject(next) || !isPositiveInteger(next.structureID)) {
      return failure(BINDING_CODE.INVALID_STRUCTURE);
    }
    const previous = previousByID.get(next.structureID) || null;
    const previousState = previous
      ? { moonID: previous.moonID ?? null, moonMiningBinding: previous.moonMiningBinding ?? null }
      : { moonID: null, moonMiningBinding: null };
    const nextState = {
      moonID: next.moonID ?? null,
      moonMiningBinding: next.moonMiningBinding ?? null,
    };
    if (isDeepStrictEqual(previousState, nextState)) {
      continue;
    }
    bindingChanged = true;

    const previousInspection = previous
      ? inspectStructureBinding(previous)
      : freezeResult({ success: true, code: BINDING_CODE.UNBOUND, binding: null });
    const nextInspection = inspectStructureBinding(next);
    if (
      previousInspection.success &&
      previousInspection.binding &&
      nextInspection.success &&
      nextInspection.binding &&
      bindingEquals(previousInspection.binding, nextInspection.binding)
    ) {
      continue;
    }
    if (
      next.structureID === allowedStructureID &&
      previousInspection.success &&
      previousInspection.code === BINDING_CODE.UNBOUND &&
      nextInspection.success &&
      nextInspection.binding
    ) {
      continue;
    }
    if (previousInspection.binding) {
      return failure(BINDING_CODE.IMMUTABLE_BINDING_CONFLICT, {
        binding: previousInspection.binding,
      });
    }
    return failure(nextInspection.code || BINDING_CODE.INVALID_PERSISTED_BINDING);
  }

  const occupied = new Map();
  for (const structure of Array.isArray(nextStructures) ? nextStructures : []) {
    if (structure.destroyedAt) {
      continue;
    }
    const inspected = inspectStructureBinding(structure);
    if (!inspected.success || !inspected.binding) {
      continue;
    }
    for (const key of [
      `moon:${inspected.binding.moonID}`,
      `beacon:${inspected.binding.beaconID}`,
    ]) {
      const prior = occupied.get(key);
      if (prior && prior !== structure.structureID) {
        return failure(BINDING_CODE.MINING_POINT_OCCUPIED, {
          occupiedBy: Object.freeze({
            structureID: prior,
            moonID: inspected.binding.moonID,
            beaconID: inspected.binding.beaconID,
          }),
        });
      }
      occupied.set(key, structure.structureID);
    }
  }
  return freezeResult({
    success: true,
    code: bindingChanged ? BINDING_CODE.BOUND : BINDING_CODE.UNBOUND,
  });
}

function applyCanonicalBinding({ structure, binding, structures = [] } = {}) {
  if (
    !isPlainObject(structure) ||
    !isPositiveInteger(structure.structureID) ||
    !isPositiveInteger(structure.solarSystemID)
  ) {
    return failure(BINDING_CODE.INVALID_STRUCTURE);
  }
  const canonical = normalizeCanonicalBinding(binding);
  if (
    !canonical ||
    canonical.structureID !== structure.structureID ||
    canonical.solarSystemID !== structure.solarSystemID
  ) {
    return failure(BINDING_CODE.INVALID_PERSISTED_BINDING);
  }

  const current = inspectStructureBinding(structure);
  if (current.code === BINDING_CODE.LEGACY_BINDING_REQUIRES_MIGRATION) {
    return current;
  }
  if (!current.success && current.code !== BINDING_CODE.UNBOUND) {
    return current;
  }
  if (structure.destroyedAt && !current.binding) {
    return failure(BINDING_CODE.DESTROYED_STRUCTURE);
  }
  if (current.binding && !bindingEquals(current.binding, canonical)) {
    return failure(BINDING_CODE.IMMUTABLE_BINDING_CONFLICT, {
      binding: current.binding,
    });
  }

  const occupiedBy = findOccupiedMiningPoint(structures, structure.structureID, canonical);
  if (occupiedBy) {
    return failure(BINDING_CODE.MINING_POINT_OCCUPIED, { occupiedBy });
  }

  const nextStructure = {
    ...structure,
    moonID: canonical.moonID,
    moonMiningBinding: canonical,
  };
  return freezeResult({
    success: true,
    code: BINDING_CODE.BOUND,
    binding: canonical,
    structure: nextStructure,
    idempotent: Boolean(current.binding),
  });
}

module.exports = {
  BINDING_CODE,
  MOON_STRUCTURE_BINDING_AUTHORITY,
  MOON_STRUCTURE_BINDING_SCHEMA_VERSION,
  applyCanonicalBinding,
  bindingEquals,
  buildCanonicalBinding,
  findOccupiedMiningPoint,
  inspectStructureBinding,
  normalizeCanonicalBinding,
  validateBindingTransition,
};
