"use strict";

module.exports = {
  dispatchIndependentWarpWithFleetAssociationRetirement,
  getTargetMotionPosition,
  getWarpStopDistanceForTarget,
  isDifferentDestinyFollowOrbitBubble,
  isEntityMoribundForDestinyFollowOrbit,
  isInvalidDestinyFollowOrbitCommand,
  isInvalidDestinyFollowOrbitRange,
  recordCharacterWarpCompleted,
  resolveInvalidDestinyMissileFollowReason,
};

const runtimeEntryDirname = require("path").resolve(__dirname, "..");
const path = require("path");
const log = require(path.join(runtimeEntryDirname, "../utils/logger"));
const {
  resolveStargatePhysicalRadius,
} = require(path.join(runtimeEntryDirname, "./stargateRadius"));
const {
  getClientParityWarpInPoint,
} = require(path.join(runtimeEntryDirname, "./destiny/simulation/warpInPointParity"));
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
  canEntitiesInteractLocally,
  isSharedPveTarget,
  resolveEntityInteractionScope,
} = require(path.join(runtimeEntryDirname, "./destiny/identity/interactionScope.js"));
const {
  buildFleetWarpCommandAssociationPlan,
  clearFleetWarpCommandAssociation,
  commitFleetWarpCommandAssociationPlan,
  getFleetWarpCommandAssociation,
  haveSameFleetWarpCommandAssociation,
  isFleetWarpInProgress,
} = require(path.join(
  runtimeEntryDirname,
  "../services/fleets/fleetWarpCommandAssociation.js",
));
const mobileWarpDisruptorRuntime = require(path.join(runtimeEntryDirname, "../services/ship/mobileWarpDisruptorRuntime"));
const {
  updateCharacterRecord,
} = require(path.join(runtimeEntryDirname, "../services/character/characterState"));
const {
  PILOT_WARP_ACTIVATION_DELAY_DESTINY_TICKS,
  PILOT_WARP_DESTINATION_ACQUIRE_LEAD_DESTINY_TICKS,
  PILOT_WARP_DESTINATION_STATIC_PRELOAD_DISTANCE_METERS,
  PILOT_WARP_HISTORY_SAFE_DESTINY_LEAD,
  PILOT_WARP_SOURCE_REMOVAL_SETTLE_MS,
} = require(path.join(runtimeEntryDirname, "./destiny/simulation/warpContract.js"));
const {
  DESTINY_TICK_INTERVAL_MS,
} = require(path.join(runtimeEntryDirname, "./destiny/constants.js"));
const {
  tagUpdatesRequireExistingVisibility,
  buildDirectedMovementUpdates,
  buildPointMovementUpdates,
} = require(path.join(runtimeEntryDirname, "./destiny/dispatch/dispatchUtils.js"));
const {
  refuseFollowOrOrbit,
} = require(path.join(runtimeEntryDirname, "./destiny/simulation/evolve.js"));
const {
  createDestinyWarpTargetPlanner,
} = require(path.join(runtimeEntryDirname, "./destiny/simulation/warpTargets.js"));
const {
  createDestinyMotionStateHelpers,
} = require(path.join(runtimeEntryDirname, "./destiny/simulation/motionState.js"));
const {
  createMovementSubwarpCommands,
} = require(path.join(runtimeEntryDirname, "./destiny/commands/subwarpCommands.js"));
const {
  createMovementWarpCommands,
} = require(path.join(runtimeEntryDirname, "./destiny/commands/warpCommands.js"));
const {
  createMovementStopSpeedCommands,
} = require(path.join(runtimeEntryDirname, "./destiny/commands/stopSpeedCommands.js"));
const {
  queueOrApplyMovementChange,
} = require(path.join(runtimeEntryDirname, "./destiny/commands/movementQueueing.js"));
const {
  isAnchorRelevanceEnabled,
  hasStartupAnchorRelevanceContext,
  syncRelevantStartupControllersForScene,
  prewarmStartupControllersForWarpDestination,
} = require(path.join(runtimeEntryDirname, "./npc/npcAnchorRelevance"));
const {
  currentFileTime,
  buildFiletimeLong,
  buildMarshalReal,
} = require(path.join(runtimeEntryDirname, "../services/_shared/serviceHelpers"));
const destiny = require(path.join(runtimeEntryDirname, "./destiny/index.js"));
const {
  persistShipEntity,
} = require("./entitySpacePersistence");
const {
  listCommandBurstForceFields,
} = require("./forceFieldContainment");
const {
  deactivateWarpUnsafeActiveModulesForWarpStart,
} = require("./moduleEffectShutdown");
const {
  clamp,
  roundNumber,
  toFiniteNumber,
  toInt,
} = require("../../common/numbers");
const {
  armMovementTrace,
  buildMissileFlightSnapshot,
  isMovementTraceActive,
  logMovementDebug,
  logWarpDebug,
  summarizeMissileEntity,
  summarizeVector,
} = require("./runtimeDebugInstrumentation");
const {
  lazyRequire,
} = require("./runtimeModuleBoundary");
const {
  isEntityCloaked,
} = require("./shipCloak");
const {
  MAX_SUBWARP_SPEED_FRACTION,
  TURN_ALIGNMENT_RADIANS,
  deriveAgilitySeconds,
  getActualSpeedFraction,
  getCurrentAlignmentDirection,
  getTurnMetrics,
} = require("./shipMotionKinematics");
const {
  MAX_STARGATE_JUMP_DISTANCE_METERS,
} = require("./stargateJumpRange");
const {
  getShipDockingDistanceToStation,
  getStationApproachPosition,
} = require("./stationDockingGeometry");
const {
  DEFAULT_RIGHT,
  DEFAULT_UP,
  addVectors,
  buildPerpendicular,
  cloneVector,
  crossProduct,
  directionsNearlyMatch,
  distance,
  dotProduct,
  magnitude,
  normalizeVector,
  scaleVector,
  subtractVectors,
} = require("../../common/vector");

const ONE_AU_IN_METERS = 149597870700;

const MIN_WARP_DISTANCE_METERS = 150000;

const PILOT_WARP_LANDING_DESTINATION_UNREACHABLE_GRACE_MS =
  (PILOT_WARP_ACTIVATION_DELAY_DESTINY_TICKS - 2) * DESTINY_TICK_INTERVAL_MS;

const WARP_EXIT_VARIANCE_RADIUS_METERS = 2500;

let nextMissileDebugTraceID = 1;

const movementWarpTargetPlanner = createDestinyWarpTargetPlanner({
  addVectors,
  cloneVector,
  dotProduct,
  normalizeVector,
  resolveStargatePhysicalRadius,
  scaleVector,
  subtractVectors,
  toFiniteNumber,
  DEFAULT_RIGHT,
  MAX_STARGATE_JUMP_DISTANCE_METERS,
  WARP_EXIT_VARIANCE_RADIUS_METERS,
});

const {
  getStargateWarpLandingPoint,
  getStationWarpTargetPosition,
  resolveStargateWarpTarget,
} = movementWarpTargetPlanner;

function getTargetMotionPosition(target, options = {}) {
  if (target && (target.kind === "station" || target.kind === "structure")) {
    return getStationApproachPosition(target, options);
  }

  return cloneVector(target && target.position);
}

function isEntityMoribundForDestinyFollowOrbit(entity) {
  return Boolean(
    entity &&
      (
        entity.isMoribund === true ||
        entity.moribund === true ||
        entity.destroyed === true ||
        entity.isDestroyed === true ||
        entity.pendingRemoval === true ||
        entity.removed === true ||
        toInt(entity.destroyedAt, 0) > 0 ||
        toInt(entity.removedAt, 0) > 0
      ),
  );
}

function isDifferentDestinyFollowOrbitBubble(entity, target) {
  const entityBubbleID = toInt(entity && entity.bubbleID, 0);
  const targetBubbleID = toInt(target && target.bubbleID, 0);
  return (
    entityBubbleID > 0 &&
    targetBubbleID > 0 &&
    entityBubbleID !== targetBubbleID
  );
}

function isInvalidDestinyFollowOrbitRange(value) {
  return !Number.isFinite(Number(value));
}

// What the engine refuses: a Follow or Orbit whose target is missing,
// moribund, cloaked or in another Grid bubble, or with a NaN range; and,
// Server's own, one from a ship in warp or docking, or toward a Ball it may
// not interact with.
function isInvalidDestinyFollowOrbitCommand(entity, target, range) {
  return (
    !entity ||
    (target && entity.itemID === target.itemID) ||
    entity.mode === "WARP" ||
    Boolean(entity.pendingDock) ||
    (target && !canEntitiesInteractLocally(entity, target)) ||
    refuseFollowOrOrbit(entity, target, range, {
      isMoribund: isEntityMoribundForDestinyFollowOrbit,
      isCloaked: isEntityCloaked,
      gridBubbleOf: (ball) => toInt(ball && ball.bubbleID, 0) || null,
    }) !== null
  );
}

function resolveInvalidDestinyMissileFollowReason(ownerEntity, targetEntity) {
  if (!ownerEntity || !targetEntity) {
    return "target-not-found";
  }
  if (toInt(ownerEntity.itemID, 0) === toInt(targetEntity.itemID, 0)) {
    return "target-is-owner";
  }
  if (!canEntitiesInteractLocally(ownerEntity, targetEntity)) {
    return "target-scope-mismatch";
  }
  if (isEntityMoribundForDestinyFollowOrbit(targetEntity)) {
    return "target-moribund";
  }
  if (isDifferentDestinyFollowOrbitBubble(ownerEntity, targetEntity)) {
    return "target-different-bubble";
  }
  if (isEntityCloaked(targetEntity)) {
    return "target-cloaked";
  }
  return null;
}

const movementMotionStateHelpers = createDestinyMotionStateHelpers({
  addVectors,
  clamp,
  clearFleetWarpCommandAssociation,
  cloneVector,
  normalizeVector,
  scaleVector,
  toFiniteNumber,
  MAX_SUBWARP_SPEED_FRACTION,
});

const {
  buildUndockMovement,
  clearTrackingState,
  resetEntityMotion,
  resetEntityMotionForHardRelocation,
} = movementMotionStateHelpers;

function dispatchIndependentWarpWithFleetAssociationRetirement(
  entity,
  dispatch,
) {
  const previousMode = entity && entity.mode;
  const previousWarpDestination = entity && entity.warpDestination;
  const didReplaceWarpState = () => Boolean(
    entity &&
    (
      entity.mode !== previousMode ||
      entity.warpDestination !== previousWarpDestination
    )
  );

  try {
    const result = dispatch();
    if (
      didReplaceWarpState() ||
      (
        result &&
        result.success === true &&
        result.redundant !== true
      )
    ) {
      clearFleetWarpCommandAssociation(entity);
    }
    return result;
  } catch (error) {
    if (didReplaceWarpState()) {
      clearFleetWarpCommandAssociation(entity);
    }
    throw error;
  }
}

function recordCharacterWarpCompleted(session) {
  const characterID =
    toInt(session && (session.characterID || session.charID || session.charid), 0);
  if (!characterID) {
    return;
  }

  const completedAt = currentFileTime().toString();
  const updateResult = updateCharacterRecord(characterID, (record) => {
    const currentAchievementState =
      record && record.achievementState && typeof record.achievementState === "object"
        ? record.achievementState
        : {};
    return {
      ...record,
      achievementState: {
        ...currentAchievementState,
        hasEverWarped: true,
        firstWarpCompletedAt:
          currentAchievementState.firstWarpCompletedAt || completedAt,
        lastWarpCompletedAt: completedAt,
      },
    };
  });

  if (!updateResult || !updateResult.success) {
    log.warn(
      `[SpaceRuntime] Failed to record first-warp achievement state for char=${characterID}: ${updateResult && updateResult.errorMsg ? updateResult.errorMsg : "UNKNOWN"}`,
    );
    return;
  }

  if (session) {
    session.achievementState = {
      ...(session.achievementState || {}),
      hasEverWarped: true,
    };
  }
}

// How far short of a target a warp to it stops.
function getWarpStopDistanceForTarget(shipEntity, targetEntity, minimumRange = 0) {
  const targetRadius = Math.max(0, toFiniteNumber(targetEntity && targetEntity.radius, 0));
  const desiredRange = Math.max(0, toFiniteNumber(minimumRange, 0));

  switch (targetEntity && targetEntity.kind) {
    case "planet":
    case "moon":
      return Math.max(targetRadius + 1000000, desiredRange) + (shipEntity.radius * 2);
    case "sun":
      return Math.max(targetRadius + 5000000, desiredRange) + (shipEntity.radius * 2);
    case "station":
      return targetRadius + desiredRange + (shipEntity.radius * 2);
    case "stargate":
      return Math.max(Math.max(2500, targetRadius * 0.3), desiredRange) + (shipEntity.radius * 2);
    case "asteroidBelt":
      return Math.max(2500, desiredRange) + (shipEntity.radius * 2);
    default:
      return Math.max(Math.max(1000, targetRadius), desiredRange) + (shipEntity.radius * 2);
  }
}

const movementSubwarpCommands = createMovementSubwarpCommands({
  addVectors,
  armMovementTrace,
  buildDirectedMovementUpdates,
  buildPointMovementUpdates,
  buildPerpendicular,
  clearTrackingState,
  cloneVector,
  crossProduct,
  directionsNearlyMatch,
  getShipDockingDistanceToStation,
  getTargetMotionPosition,
  logMovementDebug,
  normalizeVector,
  persistShipEntity,
  roundNumber,
  scaleVector,
  subtractVectors,
  summarizeVector,
  toFiniteNumber,
  toInt,
  DEFAULT_UP,
});

const {
  gotoDirection: dispatchGotoDirection,
  gotoPoint: dispatchGotoPoint,
  alignTo: dispatchAlignTo,
  followShipEntity: dispatchFollowShipEntity,
  followBall: dispatchFollowBall,
  orbitShipEntity: dispatchOrbitShipEntity,
  orbit: dispatchOrbit,
} = movementSubwarpCommands;

const dispatchGotoPointEntity = movementSubwarpCommands.gotoPointEntity;

// Warp outcome for `runtime`'s scene: the sphere that stops or drags a
// warp from `from` to its landing point, as `entity` sees spheres, or null.
function resolveWarpSphereOutcomeForRuntime(runtime, entity, from, landing, options = {}) {
  if (!runtime || !entity) {
    return null;
  }
  return mobileWarpDisruptorRuntime.resolveWarpSphereOutcome(
    runtime.systemID,
    entity,
    from,
    landing,
    {
      ...options,
      scene: runtime,
    },
  );
}

const movementWarpCommands = createMovementWarpCommands({
  armMovementTrace,
  clearTrackingState,
  cloneVector,
  destiny,
  getClientParityWarpInPoint,
  getStargateWarpLandingPoint,
  getStationWarpTargetPosition,
  getTargetMotionPosition,
  getWarpStopDistanceForTarget,
  gotoPointEntity: dispatchGotoPointEntity,
  findActiveWarpDisruptorForEntity(runtime, entity, options = {}) {
    if (!runtime || !entity) {
      return null;
    }
    return mobileWarpDisruptorRuntime.findActiveWarpDisruptorForEntity(
      runtime.systemID,
      entity,
      {
        ...options,
        scene: runtime,
      },
    );
  },
  resolveWarpSphereOutcome: resolveWarpSphereOutcomeForRuntime,
  logMovementDebug,
  logWarpDebug,
  normalizeVector,
  prewarmStartupControllersForWarpDestination,
  persistShipEntity,
  resolveStargateWarpTarget,
  subtractVectors,
  tagUpdatesRequireExistingVisibility,
  toFiniteNumber,
  MIN_WARP_DISTANCE_METERS,
});

const {
  warpToEntity: dispatchWarpToEntity,
  warpToPoint: dispatchWarpToPoint,
  warpDynamicEntityToPoint: dispatchWarpDynamicEntityToPoint,
  forceStartPendingWarp: dispatchForceStartPendingWarp,
  startSessionlessWarpIngress: dispatchStartSessionlessWarpIngress,
  stopWarpScrambledAlign: dispatchStopWarpScrambledAlign,
  stopWarpDisruptedAlign: dispatchStopWarpDisruptedAlign,
} = movementWarpCommands;

const movementStopSpeedCommands = createMovementStopSpeedCommands({
  addVectors,
  armMovementTrace,
  clamp,
  clearTrackingState,
  cloneVector,
  logMovementDebug,
  magnitude,
  persistShipEntity,
  roundNumber,
  scaleVector,
  MAX_SUBWARP_SPEED_FRACTION,
});

const {
  setSpeedFraction: dispatchSetSpeedFraction,
  stopShipEntity: dispatchStopShipEntity,
  stop: dispatchStop,
} = movementStopSpeedCommands;

Object.assign(module.exports, {
  MIN_WARP_DISTANCE_METERS,
  ONE_AU_IN_METERS,
  PILOT_WARP_LANDING_DESTINATION_UNREACHABLE_GRACE_MS,
  WARP_EXIT_VARIANCE_RADIUS_METERS,
  buildUndockMovement,
  clearTrackingState,
  dispatchAlignTo,
  dispatchFollowBall,
  dispatchFollowShipEntity,
  dispatchForceStartPendingWarp,
  dispatchGotoDirection,
  dispatchGotoPoint,
  dispatchGotoPointEntity,
  dispatchOrbit,
  dispatchOrbitShipEntity,
  dispatchSetSpeedFraction,
  dispatchStartSessionlessWarpIngress,
  dispatchStop,
  dispatchStopShipEntity,
  dispatchStopWarpScrambledAlign,
  dispatchStopWarpDisruptedAlign,
  dispatchWarpDynamicEntityToPoint,
  dispatchWarpToEntity,
  dispatchWarpToPoint,
  getStargateWarpLandingPoint,
  getStationWarpTargetPosition,
  movementMotionStateHelpers,
  movementStopSpeedCommands,
  movementSubwarpCommands,
  movementWarpCommands,
  movementWarpTargetPlanner,
  nextMissileDebugTraceID,
  resetEntityMotion,
  resetEntityMotionForHardRelocation,
  resolveStargateWarpTarget,
});
