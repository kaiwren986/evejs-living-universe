"use strict";

const {
  toFiniteNumber,
  toInt,
} = require("../../common/numbers");

const path = require("path");

const {
  getAttributeIDByNames,
} = require(path.join(__dirname, "../../services/fitting/liveFittingState"));
const {
  buildLiveModuleAttributeMap,
} = require(path.join(__dirname, "./liveModuleAttributes"));
const {
  captureFittedTractorPresentation,
  applyTractorActivationCommand,
  applyTractorStopCommand,
} = require(path.join(__dirname, "../destiny/commands/tractorBeam.js"));
// What a tractor beam does to its target is movement: it waits in the Movement
// queue and applies at the start of the next Destiny tick.
const {
  queueOrApplyMovementChange,
} = require(path.join(__dirname, "../destiny/commands/movementQueueing"));
const {
  canEntitiesInteractLocally,
} = require(path.join(__dirname, "../destiny/identity/interactionScope"));

const ATTRIBUTE_CAPACITOR_NEED = getAttributeIDByNames("capacitorNeed") || 6;
const ATTRIBUTE_DURATION = getAttributeIDByNames("duration") || 73;
const ATTRIBUTE_SPEED = getAttributeIDByNames("speed") || 51;
const ATTRIBUTE_MAX_RANGE = getAttributeIDByNames("maxRange") || 54;
const ATTRIBUTE_MAX_TRACTOR_VELOCITY = getAttributeIDByNames("maxTractorVelocity") || 1045;
const ATTRIBUTE_MAX_GROUP_ACTIVE = getAttributeIDByNames("maxGroupActive") || 763;
const ATTRIBUTE_REACTIVATION_DELAY =
  getAttributeIDByNames("moduleReactivationDelay", "reactivationDelay") || 669;
const PERSISTENT_SPECIAL_FX_WINDOW_MS = 12 * 60 * 60 * 1000;
const TRACTORABLE_ENTITY_KINDS = new Set(["container", "wreck"]);
// How close the beam brings the object before it lets go. This is a DISTANCE in
// metres and it is deliberately a flat constant: the SDE gives a tractor beam a
// range (`maxRange`, 54) and a pull speed (`maxTractorVelocity`, 1045) and
// nothing else, so there is no per-type attribute for the hold distance. The
// Mobile Tractor Unit — the other half of this mechanic, in
// `services/ship/mobileTractorUnitRuntime.js` — has always parked its targets at
// the same 500 m, and both now read this one constant so they cannot drift.
// It is NOT `maxTractorVelocity`: that is metres per second, and using it here
// made the hold distance scale with the hull's velocity bonus, so an Orca with a
// Capital Tractor Beam II "settled" wrecks 7.2 km away.
const TRACTOR_FOLLOW_RANGE_METERS = 500;

function roundNumber(value, digits = 6) {
  return Number(toFiniteNumber(value, 0).toFixed(digits));
}

function subtractVectors(left, right) {
  return {
    x: toFiniteNumber(left && left.x, 0) - toFiniteNumber(right && right.x, 0),
    y: toFiniteNumber(left && left.y, 0) - toFiniteNumber(right && right.y, 0),
    z: toFiniteNumber(left && left.z, 0) - toFiniteNumber(right && right.z, 0),
  };
}

function magnitude(vector) {
  return Math.sqrt(
    (toFiniteNumber(vector && vector.x, 0) ** 2) +
    (toFiniteNumber(vector && vector.y, 0) ** 2) +
    (toFiniteNumber(vector && vector.z, 0) ** 2),
  );
}

function resolvePersistentRepeat(durationMs) {
  const cycleMs = Math.max(1, toFiniteNumber(durationMs, 1000));
  return Math.max(1, Math.ceil(PERSISTENT_SPECIAL_FX_WINDOW_MS / cycleMs));
}

function normalizeEffectName(effectRecord) {
  return String(effectRecord && effectRecord.name || "").trim();
}

function isTractorableTarget(targetEntity) {
  if (targetEntity?.homefrontRole === "salvage") return false;
  if (
    !targetEntity ||
    !TRACTORABLE_ENTITY_KINDS.has(String(targetEntity.kind || "").trim())
  ) {
    return false;
  }
  // An anchored secure/audit-log container is bolted to the grid. Anchoring is
  // exactly the mechanic that makes a can immovable, so a tractor beam has to
  // refuse it; only free-floating jetcans and wrecks are tractorable.
  return targetEntity.isAnchored !== true;
}

// A tractor beam refuses a wreck or can the pilot has no right to take from.
// This is not an aggression flag: the module simply does not engage, which is
// why ninja-salvagers cannot tractor the wrecks they salvage. The predicate is
// supplied by the scene so this stays the one implementation of loot rights.
function hasTractorLootRight(sourceEntity, targetEntity, callbacks = {}) {
  if (typeof callbacks.hasLootRightForTarget !== "function") {
    return true;
  }
  return callbacks.hasLootRightForTarget(sourceEntity, targetEntity) === true;
}

// The pair's surface distance, the live one, falling back to the two
// Balls' own geometry when the callback gives none.
function resolveTractorSurfaceDistanceMeters(sourceEntity, targetEntity, callbacks = {}) {
  const reported = typeof callbacks.getEntitySurfaceDistance === "function"
    ? Number(callbacks.getEntitySurfaceDistance(sourceEntity, targetEntity))
    : 0;
  if (Number.isFinite(reported)) {
    return reported;
  }
  const centerDistance = magnitude(
    subtractVectors(
      sourceEntity && sourceEntity.position,
      targetEntity && targetEntity.position,
    ),
  );
  return Math.max(
    0,
    centerDistance -
      Math.max(0, toFiniteNumber(sourceEntity && sourceEntity.radius, 0)) -
      Math.max(0, toFiniteNumber(targetEntity && targetEntity.radius, 0)),
  );
}

function resolveTractorFollowRangeMeters(effectState) {
  return Math.max(
    0,
    toFiniteNumber(
      effectState && effectState.tractorBeamFollowRangeMeters,
      toFiniteNumber(
        effectState && effectState.tractorBeamHoldDistanceMeters,
        TRACTOR_FOLLOW_RANGE_METERS,
      ),
    ),
  );
}

function resolveTractorBeamActivation({
  scene,
  entity,
  moduleItem,
  effectRecord,
  chargeItem = null,
  shipItem,
  skillMap = null,
  fittedItems = null,
  activeModuleContexts = null,
  options = {},
  callbacks = {},
} = {}) {
  if (normalizeEffectName(effectRecord) !== "tractorBeamCan") {
    return { matched: false };
  }

  if (!scene || !entity || !moduleItem || !shipItem) {
    return {
      matched: true,
      success: false,
      errorMsg: "UNSUPPORTED_MODULE",
    };
  }

  const normalizedTargetID = toInt(options.targetID, 0);
  if (normalizedTargetID <= 0) {
    return {
      matched: true,
      success: false,
      errorMsg: "TARGET_REQUIRED",
    };
  }

  const targetEntity = scene.getEntityByID(normalizedTargetID);
  if (
    !isTractorableTarget(targetEntity) ||
    !canEntitiesInteractLocally(entity, targetEntity)
  ) {
    return {
      matched: true,
      success: false,
      errorMsg: "TARGET_NOT_FOUND",
    };
  }

  if (!hasTractorLootRight(entity, targetEntity, callbacks)) {
    return {
      matched: true,
      success: false,
      errorMsg: "TARGET_LOOT_RIGHTS_REQUIRED",
    };
  }

  const moduleAttributes = buildLiveModuleAttributeMap(
    shipItem,
    moduleItem,
    chargeItem,
    skillMap,
    fittedItems,
    activeModuleContexts,
  );
  if (!moduleAttributes) {
    return {
      matched: true,
      success: false,
      errorMsg: "UNSUPPORTED_MODULE",
    };
  }

  const maxRangeMeters = Math.max(
    0,
    roundNumber(toFiniteNumber(moduleAttributes[ATTRIBUTE_MAX_RANGE], 0), 3),
  );
  const surfaceDistance = resolveTractorSurfaceDistanceMeters(
    entity,
    targetEntity,
    callbacks,
  );
  if (surfaceDistance > maxRangeMeters + 1) {
    return {
      matched: true,
      success: false,
      errorMsg: "TARGET_OUT_OF_RANGE",
    };
  }

  const rawDurationMs = toFiniteNumber(
    moduleAttributes[ATTRIBUTE_DURATION],
    moduleAttributes[ATTRIBUTE_SPEED],
  );
  const durationAttributeID =
    toFiniteNumber(moduleAttributes[ATTRIBUTE_DURATION], 0) > 0
      ? ATTRIBUTE_DURATION
      : ATTRIBUTE_SPEED;

  const tractorVelocityMetersPerSecond = Math.max(
    0,
    roundNumber(toFiniteNumber(moduleAttributes[ATTRIBUTE_MAX_TRACTOR_VELOCITY], 0), 3),
  );

  return {
    matched: true,
    success: true,
    data: {
      targetEntity,
      runtimeAttrs: {
        capNeed: Math.max(
          0,
          roundNumber(toFiniteNumber(moduleAttributes[ATTRIBUTE_CAPACITOR_NEED], 0), 6),
        ),
        durationMs: Math.max(1, roundNumber(rawDurationMs, 3)),
        durationAttributeID,
        reactivationDelayMs: Math.max(
          0,
          roundNumber(toFiniteNumber(moduleAttributes[ATTRIBUTE_REACTIVATION_DELAY], 0), 3),
        ),
        maxGroupActive: Math.max(0, toInt(moduleAttributes[ATTRIBUTE_MAX_GROUP_ACTIVE], 0)),
        weaponFamily: null,
        attributeOverrides: {
          ...moduleAttributes,
        },
      },
      effectStatePatch: {
        tractorBeamEffect: true,
        tractorBeamRangeMeters: maxRangeMeters,
        tractorBeamVelocityMetersPerSecond: tractorVelocityMetersPerSecond,
        tractorBeamFollowRangeMeters: TRACTOR_FOLLOW_RANGE_METERS,
        tractorBeamHoldDistanceMeters: TRACTOR_FOLLOW_RANGE_METERS,
        forceFreshAcquireSpecialFxReplay: true,
        repeat: resolvePersistentRepeat(rawDurationMs),
      },
    },
  };
}

function stopTractorTarget(scene, targetEntity, nowMs, options = {}) {
  if (!scene || !targetEntity) {
    return false;
  }

  const effectState = options.effectState || null;
  const restoreMaxVelocity = Math.max(
    0,
    toFiniteNumber(
      effectState && effectState.tractorBeamOriginalMaxVelocity,
      targetEntity.maxVelocity,
    ),
  );
  const restoreSpeedUpdateNeeded =
    effectState && effectState.tractorBeamPresentationPrimed === true;
  if (restoreSpeedUpdateNeeded) {
    effectState.tractorBeamPresentationPrimed = false;
    effectState.lastTractorGotoPoint = null;
    effectState.lastTractorGotoStamp = 0;
  }
  queueOrApplyMovementChange(scene, targetEntity, "tractorStop", nowMs, (atMs) => {
    const result = applyTractorStopCommand({
      targetEntity,
      restoreMaxVelocity,
    });
    if (!result.applied) {
      return;
    }
    const stamp = captureFittedTractorPresentation({ scene, nowMs: atMs });
    const updates = [];
    if (restoreSpeedUpdateNeeded) {
      updates.push(...result.buildRestoreSpeedUpdates({ stamp }));
    }
    updates.push(...result.buildStopUpdates({
      stamp,
      includePosition: options.includePosition === true,
    }));
    // Releasing the beam has to release the follow association too. A ball left
    // with targetEntityID/followRange still set is still chasing the ship as far
    // as every downstream movement consumer is concerned.
    targetEntity.targetEntityID = null;
    targetEntity.followRange = 0;
    scene.queueBubbleHistory(updates);
    if (options.persist !== false && typeof options.persistDynamicEntity === "function") {
      options.persistDynamicEntity(targetEntity);
    }
  });
  return true;
}

function handleTractorBeamDeactivation(scene, effectState, nowMs, options = {}) {
  if (!scene || !effectState) {
    return false;
  }
  const targetEntity = scene.getEntityByID(toInt(effectState.targetID, 0));
  if (!targetEntity) {
    return false;
  }
  return stopTractorTarget(scene, targetEntity, nowMs, {
    ...options,
    effectState,
    includePosition: false,
  });
}

function broadcastTractorBeamActivationBootstrap(
  scene,
  sourceEntity,
  effectState,
  nowMs,
  options = {},
) {
  if (!scene || !sourceEntity || !effectState || effectState.tractorBeamEffect !== true) {
    return false;
  }
  if (effectState.tractorBeamActivationBootstrapSent === true) {
    return false;
  }
  const targetEntity = scene.getEntityByID(toInt(effectState.targetID, 0));
  if (
    !isTractorableTarget(targetEntity) ||
    !canEntitiesInteractLocally(sourceEntity, targetEntity)
  ) {
    return false;
  }

  const tractorSpeedMetersPerSecond = Math.max(
    0,
    toFiniteNumber(effectState.tractorBeamVelocityMetersPerSecond, 0),
  );
  const followRangeMeters = resolveTractorFollowRangeMeters(effectState);
  const baseTargetMaxVelocity = Math.max(0, toFiniteNumber(targetEntity.maxVelocity, 0));
  effectState.tractorBeamOriginalMaxVelocity = Math.max(
    0,
    toFiniteNumber(effectState.tractorBeamOriginalMaxVelocity, baseTargetMaxVelocity),
  );
  queueOrApplyMovementChange(scene, targetEntity, "tractorActivation", nowMs, (atMs) => {
    const result = applyTractorActivationCommand({
      sourceEntity,
      targetEntity,
      tractorSpeedMetersPerSecond,
      followRangeMeters,
    });
    if (!result.applied) {
      return;
    }
    const stamp = captureFittedTractorPresentation({ scene, nowMs: atMs });
    scene.queueBubbleHistory(result.buildPresentationUpdates({ stamp }));
    if (options.persist !== false && typeof options.persistDynamicEntity === "function") {
      options.persistDynamicEntity(targetEntity);
    }
  });
  effectState.tractorBeamPresentationPrimed = true;
  effectState.tractorBeamActivationBootstrapSent = true;
  return true;
}

function executeTractorBeamCycle({
  scene,
  entity,
  effectState,
  callbacks = {},
} = {}) {
  if (!scene || !entity || !effectState) {
    return {
      success: false,
      stopReason: "module",
    };
  }

  const targetEntity = scene.getEntityByID(toInt(effectState.targetID, 0));
  if (
    !isTractorableTarget(targetEntity) ||
    !canEntitiesInteractLocally(entity, targetEntity)
  ) {
    return {
      success: false,
      errorMsg: "TARGET_NOT_FOUND",
      stopReason: "target",
    };
  }

  if (!hasTractorLootRight(entity, targetEntity, callbacks)) {
    return {
      success: false,
      errorMsg: "TARGET_LOOT_RIGHTS_REQUIRED",
      stopReason: "target",
    };
  }

  const surfaceDistance = resolveTractorSurfaceDistanceMeters(
    entity,
    targetEntity,
    callbacks,
  );
  if (surfaceDistance > Math.max(0, toFiniteNumber(effectState.tractorBeamRangeMeters, 0)) + 1) {
    return {
      success: false,
      errorMsg: "TARGET_OUT_OF_RANGE",
      stopReason: "target",
    };
  }

  return {
    success: true,
    data: {
      targetEntity,
    },
  };
}

// A tractor pull is a FollowBall on the wreck toward the ship, queued
// once at beam start (broadcastTractorBeamActivationBootstrap) and moved by
// Evolve like any Follow: the follow range brings it to rest at the hold
// distance. The beam writes no position. Each Gameplay tick only checks that
// the pair may still interact, and releases the wreck when they may not.
function tickScene(scene, nowMs, options = {}) {
  if (!scene) {
    return;
  }

  const callbacks = options && typeof options === "object" ? options : {};
  for (const sourceEntity of scene.dynamicEntities.values()) {
    if (!sourceEntity || !(sourceEntity.activeModuleEffects instanceof Map)) {
      continue;
    }

    for (const effectState of sourceEntity.activeModuleEffects.values()) {
      if (!effectState || effectState.tractorBeamEffect !== true) {
        continue;
      }

      const targetEntity = scene.getEntityByID(toInt(effectState.targetID, 0));
      if (!isTractorableTarget(targetEntity)) {
        continue;
      }
      if (!canEntitiesInteractLocally(sourceEntity, targetEntity)) {
        if (effectState.tractorBeamScopeInvalidated !== true) {
          stopTractorTarget(scene, targetEntity, nowMs, {
            ...callbacks,
            effectState,
            includePosition: false,
          });
          effectState.tractorBeamScopeInvalidated = true;
        }
        continue;
      }
      effectState.tractorBeamScopeInvalidated = false;
      if (effectState.tractorBeamActivationBootstrapSent !== true) {
        broadcastTractorBeamActivationBootstrap(
          scene,
          sourceEntity,
          effectState,
          nowMs,
          callbacks,
        );
      }
    }
  }
}

module.exports = {
  TRACTOR_FOLLOW_RANGE_METERS,
  resolveTractorBeamActivation,
  executeTractorBeamCycle,
  tickScene,
  handleTractorBeamDeactivation,
  broadcastTractorBeamActivationBootstrap,
  isTractorableTarget,
};
