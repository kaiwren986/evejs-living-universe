"use strict";

const {
  isAbyssalHostLocationID,
} = require("../domain/abyssalHostLocation");

const SAFE_FALLBACK_SOLAR_SYSTEM_ID = 30000142;
const ABYSSAL_RECOVERY_ORIGIN_UNRESOLVED = "RECOVERY_ORIGIN_UNRESOLVED";
const ZERO_POSITION = Object.freeze({ x: 0, y: 0, z: 0 });
// Current location is only a candidate authority. Emergency relocation must
// remain distinct from authoritative recovery origin.
const RECOVERY_ORIGIN_SOURCES = Object.freeze([
  "tombstone",
  "character",
  "ship",
]);

function toInteger(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function normalizePosition(position) {
  if (
    !position ||
    typeof position !== "object" ||
    !Number.isFinite(Number(position.x)) ||
    !Number.isFinite(Number(position.y)) ||
    !Number.isFinite(Number(position.z))
  ) {
    return { ...ZERO_POSITION };
  }
  return {
    x: Number(position.x),
    y: Number(position.y),
    z: Number(position.z),
  };
}

function classifyRecoveryOriginCandidate(
  source,
  candidate,
  previousEmergencyDestinationSystemID = 0,
) {
  const present = Boolean(
    candidate &&
      typeof candidate === "object" &&
      candidate.present !== false,
  );
  const systemID = toInteger(candidate && candidate.systemID, 0);
  let status = "accepted";

  if (!present) {
    status = "absent";
  } else if (
    source === "tombstone" &&
    (candidate.originResolved === false || systemID <= 0)
  ) {
    status = "unresolved";
  } else if (systemID <= 0) {
    status = "absent";
  } else if (isAbyssalHostLocationID(systemID)) {
    status = "abyssal-host";
  } else if (
    source !== "tombstone" &&
    toInteger(previousEmergencyDestinationSystemID, 0) > 0 &&
    systemID === toInteger(previousEmergencyDestinationSystemID, 0)
  ) {
    status = "prior-emergency-destination";
  }

  return {
    source,
    status,
    systemID,
  };
}

function resolveAuthoritativeRecoveryOrigin(input = {}) {
  const previousEmergencyDestinationSystemID = toInteger(
    input.previousEmergencyDestinationSystemID,
    0,
  );
  const candidates = {
    tombstone: input.tombstoneCandidate,
    character: input.characterCandidate,
    ship: input.shipCandidate,
  };
  const originAuthorityAttempts = [];

  for (const source of RECOVERY_ORIGIN_SOURCES) {
    const candidate = candidates[source];
    const attempt = classifyRecoveryOriginCandidate(
      source,
      candidate,
      previousEmergencyDestinationSystemID,
    );
    originAuthorityAttempts.push(attempt);
    if (attempt.status !== "accepted") {
      continue;
    }

    return {
      status: "authoritative",
      source,
      systemID: attempt.systemID,
      position: normalizePosition(candidate && candidate.position),
      originResolved: true,
      originResolutionReason: null,
      emergencyFallbackSelected: false,
      originAuthorityAttempts,
    };
  }

  return {
    status: "unresolved",
    source: null,
    systemID: null,
    position: { ...ZERO_POSITION },
    originResolved: false,
    originResolutionReason: ABYSSAL_RECOVERY_ORIGIN_UNRESOLVED,
    emergencyFallbackSelected: false,
    originAuthorityAttempts,
  };
}

function resolveEmergencyRecoveryDecision(input = {}) {
  const authoritativeDecision = input.authoritativeDecision;
  if (authoritativeDecision && authoritativeDecision.originResolved === true) {
    return {
      status: "not-required",
      originResolved: true,
      emergencyFallbackSelected: false,
    };
  }

  const previousEmergencyDestination =
    input.previousEmergencyDestination &&
    typeof input.previousEmergencyDestination === "object"
      ? input.previousEmergencyDestination
      : null;
  const previousEmergencyDestinationSystemID = toInteger(
    previousEmergencyDestination && previousEmergencyDestination.systemID,
    0,
  );
  const retainPreviousEmergencyDestination = Boolean(
    previousEmergencyDestinationSystemID > 0 &&
      !isAbyssalHostLocationID(previousEmergencyDestinationSystemID),
  );
  const configuredFallbackSystemID = toInteger(
    input.emergencyFallback && input.emergencyFallback.systemID,
    SAFE_FALLBACK_SOLAR_SYSTEM_ID,
  );
  const systemID = retainPreviousEmergencyDestination
    ? previousEmergencyDestinationSystemID
    : configuredFallbackSystemID;

  // An observed emergency location is still not authoritative recovery origin.
  return {
    status: "emergencyFallback",
    source: "emergencyFallback",
    systemID,
    position: normalizePosition(
      retainPreviousEmergencyDestination
        ? previousEmergencyDestination && previousEmergencyDestination.position
        : input.emergencyFallback && input.emergencyFallback.position,
    ),
    originResolved: false,
    originResolutionReason: ABYSSAL_RECOVERY_ORIGIN_UNRESOLVED,
    emergencyFallbackSelected: true,
    originAuthorityAttempts: Array.isArray(
      authoritativeDecision && authoritativeDecision.originAuthorityAttempts
    )
      ? authoritativeDecision.originAuthorityAttempts.map((attempt) => ({ ...attempt }))
      : [],
  };
}

module.exports = {
  ABYSSAL_RECOVERY_ORIGIN_UNRESOLVED,
  SAFE_FALLBACK_SOLAR_SYSTEM_ID,
  classifyRecoveryOriginCandidate,
  resolveAuthoritativeRecoveryOrigin,
  resolveEmergencyRecoveryDecision,
};
