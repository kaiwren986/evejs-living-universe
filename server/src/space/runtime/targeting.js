"use strict";

module.exports = {
  buildEntityTargetingAttributeSnapshot,
  clampTargetLockDurationMs,
  computeTargetLockDurationMs,
  ensureEntityTargetingState,
  getEntityLockSignatureRadius,
  getEntityTargetingRadius,
  isEntityLockedTarget,
  isNonTargetableSceneryEntity,
};

const runtimeEntryDirname = require("path").resolve(__dirname, "..");
const path = require("path");
const {
  getEntitySurfaceDistance: getDestinyEntitySurfaceDistance,
  getEntityTargetingRadius: getDestinyEntityTargetingRadius,
} = require(path.join(runtimeEntryDirname, "./destiny/projection/range.js"));
const {
  ATTRIBUTE_CLOAKING_TARGETING_DELAY,
  ATTRIBUTE_MAX_LOCKED_TARGETS,
  ATTRIBUTE_MAX_TARGET_RANGE,
  ATTRIBUTE_SCAN_RESOLUTION,
  ATTRIBUTE_SIGNATURE_RADIUS,
} = require("./dogmaAttributeIds");
const {
  roundNumber,
  toFiniteNumber,
  toInt,
} = require("../../common/numbers");

const NON_TARGETABLE_GROUP_IDS = new Set([
  6, // Sun
  7, // Planet
  8, // Moon
  9, // Asteroid Belt (also the ice/gas field marker)
  10, // Stargate
  885, // Cosmic Anomaly
  995, // Secondary Sun
]);

function ensureEntityTargetingState(entity) {
  if (!entity || typeof entity !== "object") {
    return null;
  }
  if (!(entity.lockedTargets instanceof Map)) {
    entity.lockedTargets = new Map();
  }
  if (!(entity.pendingTargetLocks instanceof Map)) {
    entity.pendingTargetLocks = new Map();
  }
  if (!(entity.targetedBy instanceof Set)) {
    entity.targetedBy = new Set();
  }
  return entity;
}

function getEntityTargetingRadius(entity) {
  return getDestinyEntityTargetingRadius(entity);
}

function isNonTargetableSceneryEntity(entity) {
  if (!entity) {
    return false;
  }
  if (entity.airMiningTargetable === false) return true;
  // slimGroupID is what the client brackets and filters on, so it decides here
  // too; entities that do not override it fall back to their own group.
  const groupID = toInt(entity.slimGroupID, toInt(entity.groupID, 0));
  return groupID > 0 && NON_TARGETABLE_GROUP_IDS.has(groupID);
}

function getEntityLockSignatureRadius(entity) {
  const signatureRadius = toFiniteNumber(entity && entity.signatureRadius, NaN);
  if (Number.isFinite(signatureRadius) && signatureRadius > 0) {
    return signatureRadius;
  }

  const fallbackRadius = getEntityTargetingRadius(entity);
  return fallbackRadius > 0 ? fallbackRadius : 1;
}

function clampTargetLockDurationMs(value) {
  const numericValue = toFiniteNumber(value, TARGETING_CLIENT_FALLBACK_LOCK_MS);
  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    return TARGETING_CLIENT_FALLBACK_LOCK_MS;
  }

  return Math.min(Math.max(numericValue, 1), TARGETING_MAX_LOCK_MS);
}

function computeTargetLockDurationMs(sourceEntity, targetEntity) {
  const scanResolution = Math.max(
    toFiniteNumber(sourceEntity && sourceEntity.scanResolution, 0),
    0,
  );
  const signatureRadius = Math.max(getEntityLockSignatureRadius(targetEntity), 1);
  if (scanResolution <= 0) {
    return TARGETING_CLIENT_FALLBACK_LOCK_MS;
  }

  const logTerm = Math.log(
    signatureRadius + Math.sqrt(signatureRadius * signatureRadius + 1),
  );
  if (!Number.isFinite(logTerm) || logTerm <= 0) {
    return TARGETING_CLIENT_FALLBACK_LOCK_MS;
  }

  return clampTargetLockDurationMs(
    (40000000.0 / scanResolution) / (logTerm ** 2),
  );
}

function buildEntityTargetingAttributeSnapshot(entity) {
  return {
    maxTargetRange: roundNumber(toFiniteNumber(entity && entity.maxTargetRange, 0), 6),
    maxLockedTargets: roundNumber(toFiniteNumber(entity && entity.maxLockedTargets, 0), 6),
    signatureRadius: roundNumber(toFiniteNumber(entity && entity.signatureRadius, 0), 6),
    cloakingTargetingDelay: roundNumber(
      toFiniteNumber(entity && entity.cloakingTargetingDelay, 0),
      6,
    ),
    scanResolution: roundNumber(toFiniteNumber(entity && entity.scanResolution, 0), 6),
  };
}

const TARGETING_MAX_LOCK_MS = 180000;

const TARGETING_CLIENT_FALLBACK_LOCK_MS = 2000;

const TARGET_LOSS_REASON_ATTEMPT_CANCELLED = "TargetingAttemptCancelled";

const TARGET_LOSS_REASON_EXPLODING = "Exploding";

// Tranquility's word when a ship goes into warp: the pilot's own locks cleared ('clear', its ship, 'WarpingOut') and
// each lock on it lost ('otherlost', the locking ship, 'WarpingOut'), in the tick it enters warp (its recordings: 50
// and 138 of them).
const TARGET_LOSS_REASON_WARPING_OUT = "WarpingOut";

const TARGETING_DERIVED_ATTRIBUTE_IDS = new Set([
  ATTRIBUTE_MAX_TARGET_RANGE,
  ATTRIBUTE_MAX_LOCKED_TARGETS,
  ATTRIBUTE_SIGNATURE_RADIUS,
  ATTRIBUTE_CLOAKING_TARGETING_DELAY,
  ATTRIBUTE_SCAN_RESOLUTION,
]);

function isEntityLockedTarget(entity, targetID) {
  const normalizedTargetID = toInt(targetID, 0);
  if (!entity || normalizedTargetID <= 0) {
    return false;
  }

  return ensureEntityTargetingState(entity).lockedTargets.has(normalizedTargetID);
}

Object.assign(module.exports, {
  NON_TARGETABLE_GROUP_IDS,
  TARGETING_CLIENT_FALLBACK_LOCK_MS,
  TARGETING_DERIVED_ATTRIBUTE_IDS,
  TARGETING_MAX_LOCK_MS,
  TARGET_LOSS_REASON_ATTEMPT_CANCELLED,
  TARGET_LOSS_REASON_EXPLODING,
  TARGET_LOSS_REASON_WARPING_OUT,
});
