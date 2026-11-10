"use strict";

module.exports = {
  clearJumpPortalBridgeModeForEffect,
  deactivateWarpUnsafeActiveModulesForWarpStart,
  finalizeGenericModuleDeactivationWithoutSession,
  finalizePropulsionModuleDeactivationWithoutSession,
  forceDeactivateBlockedMovementEffects,
};

const runtimeEntryDirname = require("path").resolve(__dirname, "..");
const path = require("path");
const log = require(path.join(runtimeEntryDirname, "../utils/logger"));
const hudIconRuntime = require(path.join(
  runtimeEntryDirname,
  "./modules/hudIconRuntime",
));
const assistanceModuleRuntime = require(path.join(
  runtimeEntryDirname,
  "./modules/assistanceModuleRuntime",
));
const hostileModuleRuntime = require(path.join(
  runtimeEntryDirname,
  "./modules/hostileModuleRuntime",
));
const entosisLinkRuntime = require(path.join(
  runtimeEntryDirname,
  "./modules/entosisLinkRuntime",
));
const tractorBeamRuntime = require(path.join(
  runtimeEntryDirname,
  "./modules/tractorBeamRuntime",
));
const {
  ATTRIBUTE_DAMAGE_MULTIPLIER_BONUS_CURRENT,
  ATTRIBUTE_DAMAGE_MULTIPLIER_BONUS_MAX_TIMESTAMP,
  isPrecursorTurretFamily,
  initializePrecursorTurretEffectState,
  synchronizePrecursorTurretEffectState,
  advancePrecursorTurretSpool,
  resetPrecursorTurretSpool,
  buildPrecursorTurretGraphicInfo,
  applyPrecursorTurretSpoolToSnapshot,
} = require(path.join(runtimeEntryDirname, "./combat/precursorTurrets"));
const {
  buildSuperweaponFreshAcquireFxOptions,
  prepareSuperweaponActivation,
  executeSuperweaponActivation,
  finalizeSuperweaponDeactivation,
  isSuperweaponFxReplayWindowActive,
  tickScene: tickSuperweaponScene,
  isSuperweaponMovementLocked,
  isSuperweaponJumpOrCloakLocked,
  entityHasCloakDisallowingFittedModule,
} = require(path.join(runtimeEntryDirname, "./modules/superweapons/superweaponRuntime"));
const {
  clearCynosuralFieldForEffect,
} = require("./cynosuralField");
const {
  isReadyForDestiny,
} = require("./destinyDeliveryEligibility");
const {
  canEntityHaveOwningSession,
  getOwningSessionForEntity,
} = require("./entityOwnerSession");
const {
  persistDynamicEntity,
} = require("./entitySpacePersistence");
const {
  buildAssistanceHudState,
  buildHostileHudState,
  notifyAssistanceHudStateToSession,
  notifyHostileHudStateToSession,
  removeJammerCyclePresentation,
} = require("./hudIconStates");
const {
  getIndustrialCoreDependentModuleIDs,
  isIndustrialCoreEffectName,
  refreshShipCompressionFacilityState,
} = require("./industrialCore");
const {
  getEffectCycleBoundaryMs,
} = require("./moduleCycleSchedule");
const {
  buildSuperweaponRuntimeCallbacks,
} = require("./moduleRuntimeCallbacks");
const {
  resolveGenericModuleControlSpecialFxGuid,
} = require("./moduleSpecialFx");
const {
  toFiniteNumber,
  toInt,
} = require("../../common/numbers");
const {
  isPropulsionModuleEffectState,
} = require("./propulsionModule");
const {
  lazyRequire,
} = require("./runtimeModuleBoundary");
const {
  isCloakingModuleEffectState,
  isWarpSafeActiveModuleEffectState,
} = require("./shipCloak");
const {
  isOffensiveWeaponFamily,
} = require("./weaponSnapshot");
const propulsionModuleModule = require("./propulsionModule");

function finalizePropulsionModuleDeactivationWithoutSession(
  scene,
  entity,
  effectState,
  options = {},
) {
  if (
    !scene ||
    !entity ||
    !effectState ||
    !(entity.activeModuleEffects instanceof Map)
  ) {
    return { success: false, errorMsg: "MODULE_NOT_ACTIVE" };
  }

  const normalizedModuleID = toInt(effectState.moduleID, 0);
  if (normalizedModuleID <= 0) {
    return { success: false, errorMsg: "MODULE_NOT_ACTIVE" };
  }

  const stopTimeMs = Math.max(
    0,
    toFiniteNumber(
      options.nowMs,
      getEffectCycleBoundaryMs(effectState, Date.now()),
    ),
  );

  entity.activeModuleEffects.delete(normalizedModuleID);
  if (!(entity.moduleReactivationLocks instanceof Map)) {
    entity.moduleReactivationLocks = new Map();
  }
  entity.moduleReactivationLocks.set(
    normalizedModuleID,
    stopTimeMs + Math.max(0, toFiniteNumber(effectState.reactivationDelayMs, 0)),
  );

  effectState.deactivatedAtMs = stopTimeMs;
  effectState.deactivationRequestedAtMs = 0;
  effectState.deactivateAtMs = 0;
  effectState.stopReason = options.reason || effectState.stopReason || null;
  if (isPrecursorTurretFamily(effectState.weaponFamily)) {
    resetPrecursorTurretSpool(effectState);
  }

  scene.refreshShipEntityDerivedState(entity, {
    broadcast: true,
  });
  scene.broadcastSpecialFx(
    entity.itemID,
    effectState.guid,
    {
      moduleID: effectState.moduleID,
      moduleTypeID: effectState.typeID,
      targetID: effectState.targetID || null,
      chargeTypeID: effectState.chargeTypeID || null,
      isOffensive: isOffensiveWeaponFamily(effectState.weaponFamily),
      start: false,
      active: false,
      duration: effectState.durationMs,
    },
    entity,
  );

  const potentialSessionProp = entity.session || null;
  if (potentialSessionProp) {
    if (!Array.isArray(entity.pendingModuleStopNotifications)) {
      entity.pendingModuleStopNotifications = [];
    }
    if (entity.pendingModuleStopNotifications.length < 32) {
      entity.pendingModuleStopNotifications.push({
        effectState: { ...effectState },
        stopTimeMs,
        isPropulsion: true,
      });
    }
  }

  return {
    success: true,
    data: {
      entity,
      effectState,
      stoppedAtMs: stopTimeMs,
    },
  };
}

function clearJumpPortalBridgeModeForEffect(effectState) {
  const bridgeMode =
    effectState &&
    effectState.jumpPortalBridgeMode &&
    typeof effectState.jumpPortalBridgeMode === "object"
      ? effectState.jumpPortalBridgeMode
      : null;
  if (!bridgeMode || bridgeMode.cleared === true) {
    return false;
  }
  const fleetID = toInt(bridgeMode.fleetID, 0);
  const shipID = toInt(bridgeMode.shipID, 0);
  if (fleetID <= 0 || shipID <= 0) {
    bridgeMode.cleared = true;
    return false;
  }
  try {
    const fleetRuntime = lazyRequire("../services/fleets/fleetRuntime");
    if (fleetRuntime && typeof fleetRuntime.setBridgeMode === "function") {
      fleetRuntime.setBridgeMode(
        fleetID,
        shipID,
        toInt(bridgeMode.solarsystemID, 0) || null,
        toInt(bridgeMode.itemID, 0) || null,
        false,
      );
      bridgeMode.cleared = true;
      return true;
    }
  } catch (error) {
    log.warn(
      `[SpaceRuntime] Failed to clear jump portal bridge mode ` +
        `fleet=${fleetID} ship=${shipID}: ${error.message}`,
    );
  }
  return false;
}

function finalizeGenericModuleDeactivationWithoutSession(
  scene,
  entity,
  effectState,
  options = {},
) {
  if (
    !scene ||
    !entity ||
    !effectState ||
    !(entity.activeModuleEffects instanceof Map)
  ) {
    return { success: false, errorMsg: "MODULE_NOT_ACTIVE" };
  }

  const normalizedModuleID = toInt(effectState.moduleID, 0);
  if (normalizedModuleID <= 0) {
    return { success: false, errorMsg: "MODULE_NOT_ACTIVE" };
  }
  const isCloakingEffect = isCloakingModuleEffectState(effectState);

  const stopTimeMs = Math.max(
    0,
    toFiniteNumber(
      options.nowMs,
      getEffectCycleBoundaryMs(effectState, Date.now()),
    ),
  );

  if (
    entosisLinkRuntime.isEntosisLinkEffectState(effectState) &&
    effectState.entosisCaptureEnabled === true
  ) {
    const entosisStopResult = entosisLinkRuntime.stopEntosisLinkCapture({
      scene,
      effectState,
      nowMs: stopTimeMs,
    });
    if (!entosisStopResult || entosisStopResult.success !== true) {
      log.warn(
        `[SpaceRuntime] Failed to stop Entosis capture ` +
        `module=${normalizedModuleID}: ${
          entosisStopResult && entosisStopResult.errorMsg || "UNKNOWN_ERROR"
        }`,
      );
    }
    scene.syncStructureEntitiesFromState();
  }

  entity.activeModuleEffects.delete(normalizedModuleID);
  if (!(entity.moduleReactivationLocks instanceof Map)) {
    entity.moduleReactivationLocks = new Map();
  }
  entity.moduleReactivationLocks.set(
    normalizedModuleID,
    stopTimeMs + Math.max(0, toFiniteNumber(effectState.reactivationDelayMs, 0)),
  );

  effectState.deactivatedAtMs = stopTimeMs;
  effectState.deactivationRequestedAtMs = 0;
  effectState.deactivateAtMs = 0;
  effectState.stopReason = options.reason || effectState.stopReason || null;
  clearJumpPortalBridgeModeForEffect(effectState);
  clearCynosuralFieldForEffect(scene, null, effectState, {
    nowMs: stopTimeMs,
  });
  if (isPrecursorTurretFamily(effectState.weaponFamily)) {
    resetPrecursorTurretSpool(effectState);
  }
  const dependentIndustrialModuleIDs = isIndustrialCoreEffectName(effectState.effectName)
    ? getIndustrialCoreDependentModuleIDs(entity, normalizedModuleID)
    : [];
  if (effectState.tractorBeamEffect === true) {
    tractorBeamRuntime.handleTractorBeamDeactivation(scene, effectState, stopTimeMs, {
      persistDynamicEntity,
    });
  }
  if (effectState.superweaponEffect === true) {
    finalizeSuperweaponDeactivation({
      scene,
      entity,
      effectState,
      nowMs: stopTimeMs,
      callbacks: buildSuperweaponRuntimeCallbacks(scene, 0),
    });
  }
  if (
    effectState.affectsShipDerivedState &&
    options.refreshDerivedState !== false
  ) {
    scene.refreshShipEntityDerivedState(entity, {
      broadcast: !isCloakingEffect,
      // The uncloaked speed applies at the next Destiny tick, after
      // Observers get the ship back with its cloaked one: they hear of it
      // then.
      ...(isCloakingEffect
        ? {
          shipPrimeBroadcast: (previousState) => scene.broadcastShipPrimeUpdates(entity, {
            previousState,
          }),
        }
        : {}),
      notifyTargeting: true,
    });
  }
  if (effectState.assistanceModuleEffect === true) {
    const targetEntity = scene.getEntityByID(toInt(effectState.targetID, 0));
    const targetSession = targetEntity && targetEntity.session ? targetEntity.session : null;
    const assistanceRemovalResult = assistanceModuleRuntime.removeAssistanceModuleState({
      targetEntity,
      sourceEntity: entity,
      effectState,
    });
    if (
      assistanceRemovalResult &&
      assistanceRemovalResult.success &&
      assistanceRemovalResult.data &&
      assistanceRemovalResult.data.aggregateChanged &&
      targetEntity
    ) {
      scene.refreshShipEntityDerivedState(targetEntity, {
        session: targetSession,
        broadcast: true,
        notifyTargeting: true,
      });
    }
    const removedHudState = targetEntity
      ? hudIconRuntime.removeHudIconState(
        targetEntity,
        buildAssistanceHudState(targetEntity, entity, effectState, stopTimeMs),
      )
      : null;
    if (targetSession && isReadyForDestiny(targetSession) && removedHudState) {
      notifyAssistanceHudStateToSession(targetSession, removedHudState, false, {
        startTimeMs: stopTimeMs,
      });
    }
  }
  if (effectState.jammerModuleEffect === true) {
    removeJammerCyclePresentation(scene, entity, effectState, stopTimeMs);
  }
  if (effectState.hostileModuleEffect === true) {
    const targetEntity = scene.getEntityByID(toInt(effectState.targetID, 0));
    const targetSession = targetEntity && targetEntity.session ? targetEntity.session : null;
    const hostileRemovalResult = hostileModuleRuntime.removeHostileModuleState({
      targetEntity,
      sourceEntity: entity,
      effectState,
      scene,
      nowMs: stopTimeMs,
    });
    if (
      hostileRemovalResult &&
      hostileRemovalResult.success &&
      hostileRemovalResult.data &&
      hostileRemovalResult.data.aggregateChanged &&
      targetEntity
    ) {
      scene.refreshShipEntityDerivedState(targetEntity, {
        session: targetSession,
        broadcast: true,
        notifyTargeting: true,
      });
    }
    const removedHudState = targetEntity
      ? hudIconRuntime.removeHudIconState(
        targetEntity,
        buildHostileHudState(targetEntity, entity, effectState, stopTimeMs),
      )
      : null;
    if (targetSession && isReadyForDestiny(targetSession) && removedHudState) {
      notifyHostileHudStateToSession(targetSession, removedHudState, false, {
        startTimeMs: stopTimeMs,
      });
    }
  }

  const controlSpecialFxGuid = resolveGenericModuleControlSpecialFxGuid(effectState);
  if (controlSpecialFxGuid && effectState.suppressStopSpecialFx !== true) {
    const isOffensiveFx = isOffensiveWeaponFamily(effectState.weaponFamily);
    scene.broadcastSpecialFx(
      entity.itemID,
      controlSpecialFxGuid,
      {
        moduleID: effectState.moduleID,
        moduleTypeID: effectState.typeID,
        targetID: effectState.targetID || null,
        chargeTypeID: effectState.chargeTypeID || null,
        isOffensive: isOffensiveFx,
        start: false,
        active: false,
        duration: effectState.durationMs,
      },
      entity,
    );
  }

  if (dependentIndustrialModuleIDs.length > 0) {
    for (const dependentModuleID of dependentIndustrialModuleIDs) {
      const dependentEffectState =
        entity.activeModuleEffects.get(toInt(dependentModuleID, 0)) || null;
      if (!dependentEffectState) {
        continue;
      }
      finalizeGenericModuleDeactivationWithoutSession(
        scene,
        entity,
        dependentEffectState,
        {
          reason: "industrialCore",
          nowMs: stopTimeMs,
          suppressCompressionSlimBroadcast: true,
        },
      );
    }
  }
  const compressionSlimChanged =
    refreshShipCompressionFacilityState(entity) ||
    dependentIndustrialModuleIDs.length > 0;
  if (
    compressionSlimChanged &&
    options.suppressCompressionSlimBroadcast !== true
  ) {
    scene.broadcastSlimItemChanges([entity]);
  }

  // Only player hulls, controlled structures and starbase batteries can have an
  // owning session. Skip the scene-wide session scan for NPC hulls and drones.
  const potentialSession = entity.session || (
    canEntityHaveOwningSession(entity)
      ? getOwningSessionForEntity(scene, entity)
      : null
  );
  if (potentialSession) {
    if (!Array.isArray(entity.pendingModuleStopNotifications)) {
      entity.pendingModuleStopNotifications = [];
    }
    if (entity.pendingModuleStopNotifications.length < 32) {
      entity.pendingModuleStopNotifications.push({
        effectState: { ...effectState },
        stopTimeMs,
        isPropulsion: false,
      });
    }
  }

  return {
    success: true,
    data: { entity, effectState, stoppedAtMs: stopTimeMs },
  };
}

function forceDeactivateBlockedMovementEffects(
  scene,
  targetEntity,
  nowMs = null,
  reason = "scram",
  options = {},
) {
  const PROPULSION_EFFECT_AFTERBURNER = propulsionModuleModule.PROPULSION_EFFECT_AFTERBURNER;
  const PROPULSION_EFFECT_MICROWARPDRIVE = propulsionModuleModule.PROPULSION_EFFECT_MICROWARPDRIVE;
  if (!scene || !targetEntity || !(targetEntity.activeModuleEffects instanceof Map)) {
    return 0;
  }

  const stopTimeMs = Math.max(
    0,
    toFiniteNumber(
      nowMs,
      scene && typeof scene.getCurrentSimTimeMs === "function"
        ? scene.getCurrentSimTimeMs()
        : Date.now(),
    ),
  );
  let deactivatedCount = 0;
  const blockAllPropulsion = options && options.blockAllPropulsion === true;

  for (const effectState of [...targetEntity.activeModuleEffects.values()]) {
    if (!effectState) {
      continue;
    }

    if (
      effectState.effectName === PROPULSION_EFFECT_MICROWARPDRIVE ||
      (
        blockAllPropulsion &&
        effectState.effectName === PROPULSION_EFFECT_AFTERBURNER
      )
    ) {
      if (targetEntity.session && isReadyForDestiny(targetEntity.session)) {
        scene.finalizePropulsionModuleDeactivation(targetEntity.session, effectState.moduleID, {
          reason,
          nowMs: stopTimeMs,
        });
      } else {
        finalizePropulsionModuleDeactivationWithoutSession(
          scene,
          targetEntity,
          effectState,
          {
            reason,
            nowMs: stopTimeMs,
          },
        );
      }
      deactivatedCount += 1;
      continue;
    }

    if (effectState.microJumpDriveEffect === true) {
      if (targetEntity.session && isReadyForDestiny(targetEntity.session)) {
        scene.finalizeGenericModuleDeactivation(targetEntity.session, effectState.moduleID, {
          reason,
          nowMs: stopTimeMs,
        });
      } else {
        finalizeGenericModuleDeactivationWithoutSession(
          scene,
          targetEntity,
          effectState,
          {
            reason,
            nowMs: stopTimeMs,
          },
        );
      }
      deactivatedCount += 1;
    }
  }

  if (
    hostileModuleRuntime.isEntityWarpScrambled(targetEntity) &&
    targetEntity.mode === "WARP" &&
    Number(targetEntity.effectStamp) < 0
  ) {
    scene.stopShipEntity(targetEntity, {
      nowMs: stopTimeMs,
    });
  }

  return deactivatedCount;
}

function deactivateWarpUnsafeActiveModulesForWarpStart(
  scene,
  entity,
  nowMs = null,
  options = {},
) {
  if (!scene || !entity || !(entity.activeModuleEffects instanceof Map)) {
    return {
      success: true,
      data: {
        stoppedModuleIDs: [],
        errors: [],
      },
    };
  }

  const activeEffectStates = [...entity.activeModuleEffects.values()]
    .filter((effectState) => effectState && toInt(effectState.moduleID, 0) > 0)
    .sort((left, right) => toInt(left.moduleID, 0) - toInt(right.moduleID, 0));
  if (activeEffectStates.length === 0) {
    return {
      success: true,
      data: {
        stoppedModuleIDs: [],
        errors: [],
      },
    };
  }

  const now = Math.max(
    0,
    toFiniteNumber(
      nowMs,
      typeof scene.getCurrentSimTimeMs === "function"
        ? scene.getCurrentSimTimeMs()
        : Date.now(),
    ),
  );
  const reason = String(options.reason || "warpStart");
  const ownerSession = entity.session || getOwningSessionForEntity(scene, entity);
  const suppressOwnerDestinyUpdates =
    options.suppressOwnerDestinyUpdates !== false;
  const excludedSession =
    options.excludedSession ||
    (
      suppressOwnerDestinyUpdates &&
      ownerSession &&
      isReadyForDestiny(ownerSession)
        ? ownerSession
        : null
    );
  const stoppedModuleIDs = [];
  const errors = [];

  for (const effectState of activeEffectStates) {
    const moduleID = toInt(effectState.moduleID, 0);
    if (
      moduleID <= 0 ||
      !(entity.activeModuleEffects instanceof Map) ||
      !entity.activeModuleEffects.has(moduleID) ||
      isWarpSafeActiveModuleEffectState(effectState)
    ) {
      continue;
    }

    const isPropulsionEffect = isPropulsionModuleEffectState(effectState);
    let result = null;
    if (ownerSession && isReadyForDestiny(ownerSession)) {
      result = isPropulsionEffect
        ? scene.finalizePropulsionModuleDeactivation(ownerSession, moduleID, {
            reason,
            nowMs: now,
            excludedSession,
            suppressOwnerDestinyUpdates,
          })
        : scene.finalizeGenericModuleDeactivation(ownerSession, moduleID, {
            reason,
            nowMs: now,
            excludedSession,
          });
    } else {
      result = isPropulsionEffect
        ? finalizePropulsionModuleDeactivationWithoutSession(
            scene,
            entity,
            effectState,
            {
              reason,
              nowMs: now,
              excludedSession,
            },
          )
        : finalizeGenericModuleDeactivationWithoutSession(
            scene,
            entity,
            effectState,
            {
              reason,
              nowMs: now,
              excludedSession,
            },
          );
    }

    if (result && result.success) {
      stoppedModuleIDs.push(moduleID);
      continue;
    }

    errors.push({
      moduleID,
      errorMsg: result && result.errorMsg ? result.errorMsg : "DEACTIVATION_FAILED",
    });
  }

  return {
    success: errors.length === 0,
    errorMsg: errors.length > 0 ? "WARP_START_DEACTIVATION_FAILED" : null,
    data: {
      stoppedModuleIDs,
      errors,
    },
  };
}
