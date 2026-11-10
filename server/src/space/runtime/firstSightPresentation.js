"use strict";

module.exports = {
  buildDeferredOwnerMissileAcquireOptions,
  buildInitialBootstrapAddBallsPresentationUpdate,
  buildInitialBootstrapSetStatePresentationUpdate,
  buildMissileLaunchPresentationSnapshot,
  buildUndockBootstrapMovementUpdates,
  resolveBootstrapPreviousSimTimeMs,
  resolvePreservedSimTimeMs,
};

const runtimeEntryDirname = require("path").resolve(__dirname, "..");
const path = require("path");
const {
  entityIDsEqual,
  getEntityMapKey,
  normalizeEntityID,
  normalizeEntityIDSet,
  normalizeNonNegativeInt64,
  normalizePersistentEntityID,
  toJSONSafeEntityID,
} = require(path.join(runtimeEntryDirname, "./destiny/identity/entityID.js"));
const {
  buildInitialBootstrapAddBallsPresentationUpdate:
    buildInitialBootstrapAddBallsPresentationUpdatePlan,
  buildInitialBootstrapSetStatePresentationUpdate:
    buildInitialBootstrapSetStatePresentationUpdatePlan,
} = require(path.join(
  runtimeEntryDirname,
  "./destiny/presentation/addBalls.js",
));
const {
  buildUndockBootstrapMovementUpdates:
    buildUndockBootstrapMovementPresentationUpdates,
} = require(path.join(
  runtimeEntryDirname,
  "./destiny/presentation/shipPrime.js",
));
const {
  cloneDynamicEntityForDestinyPresentation,
} = require(path.join(runtimeEntryDirname, "./destiny/projection/entityProjection.js"));
const destiny = require(path.join(runtimeEntryDirname, "./destiny/index.js"));
const {
  roundNumber,
  toFiniteNumber,
  toInt,
} = require("../../common/numbers");
const {
  clampTimeDilationFactor,
} = require("./runtimeClock");
const {
  isOwnerLaunchedMissileVisibleToSession,
} = require("./visibility");

function buildMissileLaunchPresentationSnapshot(entity) {
  if (!entity || entity.kind !== "missile") {
    return null;
  }

  const snapshot = cloneDynamicEntityForDestinyPresentation(entity);
  delete snapshot.launchPresentationSnapshot;
  delete snapshot.missileSnapshot;
  delete snapshot.lastMissileStep;
  snapshot.launchModules = Array.isArray(entity.launchModules)
    ? entity.launchModules.map((value) => toInt(value, 0))
    : [];
  return snapshot;
}

function buildDeferredOwnerMissileAcquireOptions(scene) {
  return {
    nowMs:
      scene && typeof scene.getCurrentSimTimeMs === "function"
        ? scene.getCurrentSimTimeMs()
        : 0,
    visibilityFn: (session, candidate) =>
      isOwnerLaunchedMissileVisibleToSession(session, candidate),
  };
}

function buildUndockBootstrapMovementUpdates(entity, stamp, options = {}) {
  if (!entity || entity.kind !== "ship") {
    return [];
  }
  return buildUndockBootstrapMovementPresentationUpdates(entity, stamp, options);
}

function buildInitialBootstrapAddBallsPresentationUpdate(options = {}) {
  return buildInitialBootstrapAddBallsPresentationUpdatePlan({
    ...options,
    buildAddBalls2Payload: destiny.buildAddBalls2Payload,
  });
}

function buildInitialBootstrapSetStatePresentationUpdate(options = {}) {
  return buildInitialBootstrapSetStatePresentationUpdatePlan({
    ...options,
    buildSetStatePayload: destiny.buildSetStatePayload,
  });
}

function resolvePreservedSimTimeMs(
  preservedPreviousSimTimeMs,
  previousTimeDilation,
  capturedAtWallclockMs,
  fallbackMs = null,
) {
  const normalizedPreservedPreviousSimTimeMs =
    preservedPreviousSimTimeMs === undefined || preservedPreviousSimTimeMs === null
      ? null
      : toFiniteNumber(preservedPreviousSimTimeMs, fallbackMs);
  if (normalizedPreservedPreviousSimTimeMs === null) {
    return fallbackMs;
  }

  const normalizedCapturedAtWallclockMs =
    capturedAtWallclockMs === undefined || capturedAtWallclockMs === null
      ? null
      : toFiniteNumber(capturedAtWallclockMs, null);
  const normalizedPreviousTimeDilation =
    previousTimeDilation === undefined || previousTimeDilation === null
      ? null
      : clampTimeDilationFactor(previousTimeDilation);
  if (
    normalizedCapturedAtWallclockMs === null ||
    normalizedPreviousTimeDilation === null
  ) {
    return normalizedPreservedPreviousSimTimeMs;
  }

  const elapsedWallclockMs = Math.max(
    0,
    toFiniteNumber(Date.now(), normalizedCapturedAtWallclockMs) -
      normalizedCapturedAtWallclockMs,
  );
  return roundNumber(
    normalizedPreservedPreviousSimTimeMs +
      (elapsedWallclockMs * normalizedPreviousTimeDilation),
    3,
  );
}

function resolveBootstrapPreviousSimTimeMs(session, fallbackMs = null) {
  if (!session) {
    return fallbackMs;
  }

  return resolvePreservedSimTimeMs(
    session._nextInitialBallparkPreviousSimTimeMs,
    session._nextInitialBallparkPreviousTimeDilation,
    session._nextInitialBallparkPreviousCapturedAtWallclockMs,
    fallbackMs,
  );
}
