"use strict";

const path = require("node:path");

const SHADOW_STATUS = Object.freeze({
  PARITY: "parity",
  COMPOSITION_MISMATCH: "composition_mismatch",
  CURRENT_PROFILE_MISSING: "current_profile_missing",
  STRUCTURE_BINDING_MISSING: "structure_binding_missing",
  STRUCTURE_BINDING_MISMATCH: "structure_binding_mismatch",
  AUTHORITY_PROFILE_MISSING: "authority_profile_missing",
  AUTHORITY_READ_ERROR: "authority_read_error",
});

const DEFAULT_DIAGNOSTIC_LIMIT = 128;
const FRACTION_TOLERANCE = 1e-12;

function normalizePositiveInteger(value) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : 0;
}

function normalizePersistedMoonID(value) {
  return normalizePositiveInteger(value) || null;
}

function freezeResult(result) {
  return Object.freeze({
    ...result,
    currentComposition: Object.freeze(result.currentComposition || []),
    authorityComposition: Object.freeze(result.authorityComposition || []),
  });
}

function normalizeCurrentComposition(profile) {
  const resources = profile && profile.resources;
  if (!resources || typeof resources !== "object" || Array.isArray(resources)) {
    return [];
  }
  return Object.entries(resources)
    .map(([rawTypeID, rawFraction]) => ({
      typeID: normalizePositiveInteger(rawTypeID),
      fraction: Number(rawFraction),
    }))
    .filter((entry) =>
      entry.typeID > 0 && Number.isFinite(entry.fraction) && entry.fraction > 0,
    )
    .sort((left, right) => left.typeID - right.typeID)
    .map((entry) => Object.freeze(entry));
}

function normalizeAuthorityComposition(profile) {
  if (!profile || !Array.isArray(profile.composition)) {
    return [];
  }
  return profile.composition
    .map((entry) => ({
      typeID: normalizePositiveInteger(entry && entry.typeID),
      fraction: Number(entry && entry.fraction),
    }))
    .filter((entry) =>
      entry.typeID > 0 && Number.isFinite(entry.fraction) && entry.fraction > 0,
    )
    .sort((left, right) => left.typeID - right.typeID)
    .map((entry) => Object.freeze(entry));
}

function compositionsMatch(currentComposition, authorityComposition) {
  if (currentComposition.length !== authorityComposition.length) {
    return false;
  }
  return currentComposition.every((entry, index) => {
    const authorityEntry = authorityComposition[index];
    return (
      entry.typeID === authorityEntry.typeID &&
      Math.abs(entry.fraction - authorityEntry.fraction) <= FRACTION_TOLERANCE
    );
  });
}

function diagnosticKey(result) {
  return JSON.stringify([
    result.status,
    result.structureID,
    result.moonID,
    result.currentProfileMoonID,
    result.currentComposition,
    result.authorityComposition,
  ]);
}

function createMoonResourceShadowRead(options = {}) {
  const authority = options.authority;
  if (!authority || typeof authority.getMoonProfile !== "function") {
    throw new TypeError("moon resource shadow read requires an authority lookup");
  }
  const emitDiagnostic = typeof options.emitDiagnostic === "function"
    ? options.emitDiagnostic
    : () => {};
  const diagnosticLimit = Number.isInteger(options.diagnosticLimit)
    ? Math.max(0, options.diagnosticLimit)
    : DEFAULT_DIAGNOSTIC_LIMIT;
  const emittedKeys = new Set();
  let droppedDiagnostics = 0;

  function emitOnce(result) {
    const key = diagnosticKey(result);
    if (emittedKeys.has(key)) {
      return;
    }
    if (emittedKeys.size >= diagnosticLimit) {
      droppedDiagnostics += 1;
      return;
    }
    emittedKeys.add(key);
    try {
      emitDiagnostic(result);
    } catch (_error) {
      // ignored: shadow telemetry must never affect the gameplay read it observes.
    }
  }

  function observe(input = {}) {
    const structureID = normalizePositiveInteger(input.structureID);
    const structure = input.structure && typeof input.structure === "object"
      ? input.structure
      : null;
    const currentProfile = input.currentProfile && typeof input.currentProfile === "object"
      ? input.currentProfile
      : null;
    const moonID = normalizePositiveInteger(structure && structure.moonID);
    const currentProfileMoonID = normalizePositiveInteger(currentProfile && currentProfile.moonID);
    const currentComposition = normalizeCurrentComposition(currentProfile);
    let result;

    if (!moonID) {
      result = freezeResult({
        status: SHADOW_STATUS.STRUCTURE_BINDING_MISSING,
        structureID,
        moonID: 0,
        currentProfileMoonID,
        currentComposition,
        authorityComposition: [],
      });
      emitOnce(result);
      return result;
    }

    if (currentProfileMoonID && currentProfileMoonID !== moonID) {
      result = freezeResult({
        status: SHADOW_STATUS.STRUCTURE_BINDING_MISMATCH,
        structureID,
        moonID,
        currentProfileMoonID,
        currentComposition,
        authorityComposition: [],
      });
      emitOnce(result);
      return result;
    }

    let authorityProfile;
    try {
      authorityProfile = authority.getMoonProfile(moonID);
    } catch (error) {
      if (error && error.code === "MOON_PROFILE_NOT_FOUND") {
        result = freezeResult({
          status: SHADOW_STATUS.AUTHORITY_PROFILE_MISSING,
          structureID,
          moonID,
          currentProfileMoonID,
          currentComposition,
          authorityComposition: [],
        });
        emitOnce(result);
        return result;
      }
      result = freezeResult({
        status: SHADOW_STATUS.AUTHORITY_READ_ERROR,
        structureID,
        moonID,
        currentProfileMoonID,
        currentComposition,
        authorityComposition: [],
        errorCode: error && error.code ? String(error.code) : "UNKNOWN_ERROR",
      });
      emitOnce(result);
      return result;
    }

    const authorityComposition = normalizeAuthorityComposition(authorityProfile);
    result = freezeResult({
      status: !currentProfile
        ? SHADOW_STATUS.CURRENT_PROFILE_MISSING
        : compositionsMatch(currentComposition, authorityComposition)
          ? SHADOW_STATUS.PARITY
          : SHADOW_STATUS.COMPOSITION_MISMATCH,
      structureID,
      moonID,
      currentProfileMoonID,
      currentComposition,
      authorityComposition,
      datasetVersion: authorityProfile.datasetVersion || null,
      profileID: authorityProfile.profileID || null,
    });
    emitOnce(result);
    return result;
  }

  return Object.freeze({
    observe,
    getDiagnosticStats() {
      return Object.freeze({
        emitted: emittedKeys.size,
        dropped: droppedDiagnostics,
        limit: diagnosticLimit,
      });
    },
  });
}

function loadConfiguredMoonResourceShadowRead(options = {}) {
  const environment = options.environment || process.env;
  const databasePath = String(
    options.databasePath !== undefined
      ? options.databasePath
      : environment.EVEJS_MOON_RESOURCE_SHADOW_DATABASE || "",
  ).trim();
  if (!databasePath) {
    return null;
  }
  const manifestPath = String(
    options.manifestPath !== undefined
      ? options.manifestPath
      : environment.EVEJS_MOON_RESOURCE_SHADOW_MANIFEST || "",
  ).trim();
  const configuredLimit = Number(
    options.diagnosticLimit !== undefined
      ? options.diagnosticLimit
      : environment.EVEJS_MOON_RESOURCE_SHADOW_DIAGNOSTIC_LIMIT,
  );
  const { loadMoonResourceAuthorityFromSqlite } = require(path.join(
    __dirname,
    "./moonResourceSqliteAdapter",
  ));
  const loaded = loadMoonResourceAuthorityFromSqlite(databasePath, {
    manifestPath: manifestPath || undefined,
    expectedSourceBuild: options.expectedSourceBuild,
  });
  const shadowRead = createMoonResourceShadowRead({
    authority: loaded.authority,
    emitDiagnostic: options.emitDiagnostic,
    diagnosticLimit: Number.isInteger(configuredLimit)
      ? configuredLimit
      : DEFAULT_DIAGNOSTIC_LIMIT,
  });
  return Object.freeze({
    observe: shadowRead.observe,
    getDiagnosticStats: shadowRead.getDiagnosticStats,
    authorityMetadata: loaded.authority.metadata,
    importSummary: loaded.summary,
  });
}

module.exports = {
  DEFAULT_DIAGNOSTIC_LIMIT,
  SHADOW_STATUS,
  createMoonResourceShadowRead,
  loadConfiguredMoonResourceShadowRead,
  normalizePersistedMoonID,
};
