"use strict";

const { queueDogmaEventPairs } = require("../dogmaEvents");

const runtimeEntryDirname = require("path").resolve(__dirname, "../..");
const path = require("path");
const {
  isWarping,
} = require(path.join(runtimeEntryDirname, "./destiny/simulation/evolve.js"));
const starbaseDefenseRuntime = require("../../../services/starbase/starbaseDefenseRuntime");
const config = require(path.join(runtimeEntryDirname, "../config"));
const log = require(path.join(runtimeEntryDirname, "../utils/logger"));
const mobileCynoInhibitorRuntime = require(path.join(runtimeEntryDirname, "../services/ship/mobileCynoInhibitorRuntime"));
const warpDisruptFieldGeneratorRuntime = require(path.join(
  runtimeEntryDirname,
  "../services/ship/warpDisruptFieldGeneratorRuntime",
));
const {
  getFittedModuleItems,
  listFittedItemsForLocation,
  buildSlimModuleTuples,
  buildCharacterTargetingState,
  buildChargeTupleItemID,
  buildShipResourceState,
  SLOT_FAMILY_FLAGS,
  getAttributeIDByNames,
  getEffectIDByNames,
  getTypeDogmaAttributes,
  getTypeDogmaEffects,
  getTypeEffectRecords,
  getPassiveModifierEffectRecords,
  getTypeAttributeValue,
  getEffectTypeRecord,
  getRequiredSkillRequirements,
  getLoadedChargeByFlag,
  isChargeCompatibleWithModule,
  isModuleOnline,
  isStructureDogmaHost,
  resolveDogmaSkillMapForHost,
  appendDirectModifierEntries,
  buildEffectiveItemAttributeMap,
  indexOverloadEffectRecordsByModuleID,
  buildProjectedModuleSourceAttributeMap,
} = require(path.join(runtimeEntryDirname, "../services/fitting/liveFittingState"));
const {
  logNpcCombatDebug,
  summarizeNpcCombatEntity,
  summarizeNpcCombatModule,
} = require(path.join(runtimeEntryDirname, "./npc/npcCombatDebug"));
const {
  buildNpcEffectiveModuleItem,
} = require(path.join(runtimeEntryDirname, "./npc/npcCapabilityResolver"));
const commandBurstRuntime = require(path.join(
  runtimeEntryDirname,
  "./modules/commandBurstRuntime",
));
const {
  collectNumericModuleAttributeDiffs,
  resolveModuleSnapshotDirectModifierEntries,
} = require(path.join(
  runtimeEntryDirname,
  "./modules/moduleAttributeDiff",
));
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
const jammerModuleRuntime = require(path.join(
  runtimeEntryDirname,
  "./modules/jammerModuleRuntime",
));
const smartbombRuntime = require(path.join(
  runtimeEntryDirname,
  "./modules/smartbombRuntime",
));
const bombRuntime = require("../../modules/bombRuntime");
const defenderRuntime = require("../../modules/defenderMissileRuntime");
const targetingModuleRuntime = require(path.join(
  runtimeEntryDirname,
  "./modules/targetingModuleRuntime",
));
const entosisLinkRuntime = require(path.join(
  runtimeEntryDirname,
  "./modules/entosisLinkRuntime",
));
const scannerModuleRuntime = require(path.join(
  runtimeEntryDirname,
  "./modules/scannerModuleRuntime",
));
const pointDefenseRuntime = require(path.join(
  runtimeEntryDirname,
  "./modules/pointDefenseRuntime",
));
const microJumpDriveRuntime = require(path.join(
  runtimeEntryDirname,
  "./modules/microJumpDriveRuntime",
));
const tractorBeamRuntime = require(path.join(
  runtimeEntryDirname,
  "./modules/tractorBeamRuntime",
));
const salvagerRuntime = require(path.join(
  runtimeEntryDirname,
  "./modules/salvagerRuntime",
));
const structureTethering = require(path.join(
  runtimeEntryDirname,
  "./structureTethering",
));
const {
  applyDamageToEntity,
  applyResolvedDamageAmountToEntity,
  buildLiveDamageState,
  hasDamageableHealth,
  getEntityCurrentHealthLayers,
  getEntityMaxHealthLayers,
  sumDamageVector,
} = require(path.join(runtimeEntryDirname, "./combat/damage"));
const {
  buildWeaponModuleSnapshot,
  isChargeOptionalTurretWeapon,
  isMissileWeaponFamily,
  isVortonWeaponFamily,
  isTurretCycleWeaponFamily,
  isDefenderMissileWeaponSnapshot,
  resolveWeaponFamily,
  resolveWeaponSpecialFxGUID,
} = require(path.join(runtimeEntryDirname, "./combat/weaponDogma"));
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
  estimateMissileClientImpactTimeMs,
  resolveMissileClientVisualProfile,
  estimateMissileFlightBudgetMs,
  resolveMissileAppliedDamage,
} = require(path.join(runtimeEntryDirname, "./combat/missiles/missileSolver"));
const {
  prepareLocalCycleActivation,
  prepareLocalCycleBoundary,
  executeLocalCycle,
  queueAncillaryLocalReloadOnManualDeactivate,
} = require(path.join(runtimeEntryDirname, "./modules/localCycleRuntime"));
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
  resolveAbyssalCloakActivationRestriction,
  resolveAbyssalCynosuralActivationRestriction,
  resolveCynosuralActivationSpaceRestriction,
} = require("../activationSpaceRestrictions");
const {
  buildCloakModuleSpecialFxTimingOptions,
  buildMiningSpecialFxTimingOptions,
  resolveSpecialFxRepeatCount,
} = require("../activeModuleSpecialFx");
const {
  collectEntityWormholeLocationModifierSources,
  effectRecordSelfModifiesProjectedAttributes,
} = require("../activeShipModifiers");
const {
  notifyCapacitorChangeToSession,
  notifyGenericDerivedAttributesToSession,
  notifyPropulsionDerivedAttributesToSession,
} = require("../attributeChangeNotification");
const {
  getAutoTargetingMissileRangeMeters,
  hasActiveAutoTargetingMissileAggression,
  isAutoTargetingMissileCharge,
  resolveAutoTargetingMissileNpcPackKey,
  resolveAutoTargetingMissileTarget,
} = require("../autoTargetingMissiles");
const {
  syncInventoryChangesToSession,
} = require("../characterStateBridge");
const {
  executeCommandBurstCycle,
  recordCommandBurstWeaponTimer,
} = require("../commandBurst");
const {
  evaluateCrimewatchOffensiveAggression,
  evaluateEmpireUntargetedOffensiveActivation,
  recordCrimewatchOffensiveAggression,
} = require("../crimewatchAdapter");
const {
  clearCynosuralFieldForEffect,
  isCynosuralGenerationEffect,
  resolveCynosuralFieldTypeID,
  spawnCynosuralFieldForEffect,
} = require("../cynosuralField");
const {
  isReadyForDestiny,
} = require("../destinyDeliveryEligibility");
const {
  noteDroneAssistSuccessfulOffensiveCycle,
} = require("../droneAssistOffensiveNotice");
const { noteVisionsPaidEwarCycle } = require("../visionsEwarNotice");
const {
  consumeEntityCapacitor,
  getEntityCapacitorAmount,
  persistEntityCapacitorRatio,
  setEntityCapacitorRatio,
} = require("../entityCapacitor");
const {
  getEntityRuntimeActiveModuleContexts,
  getEntityRuntimeFittedItems,
  getEntityRuntimeLoadedCharge,
  getEntityRuntimeModuleItem,
  getEntityRuntimeShipItem,
  getEntityRuntimeSkillMap,
  getShipEntityInventoryCharacterID,
  getSkillLevel,
  isRuntimeStructureDogmaHostEntity,
} = require("../entityDogmaView");
const {
  persistDynamicEntity,
} = require("../entitySpacePersistence");
const {
  recordEntosisWeaponTimer,
} = require("../entosisCapture");
const {
  isShipInsideForceField,
} = require("../forceFieldContainment");
const {
  notifyGenericModuleEffectState,
  notifyModuleEffectState,
} = require("../godmaShipEffectNotification");
const {
  buildGroupedTurretBankPresentationEffectStates,
  reconcileActiveTurretWeaponBankEffectStates,
  resolveGroupedTurretBankModuleIDs,
  resolveGroupedWeaponBankContext,
} = require("../groupedWeaponBank");
const {
  applyJammerCyclePresentation,
  buildAssistanceHudState,
  buildHostileHudState,
  notifyAssistanceHudStateToSession,
  notifyHostileHudStateToSession,
  removeJammerCyclePresentation,
  resolveAssistanceJamDurationMs,
  resolveHostileJamDurationMs,
} = require("../hudIconStates");
const {
  getIndustrialCoreDependentModuleIDs,
  hasActiveIndustrialCoreEffect,
  isIndustrialCoreEffectName,
  moduleActivationRequiresActiveIndustrialCore,
  refreshShipCompressionFacilityState,
} = require("../industrialCore");
const {
  isEntityMicroJumpDriveBlocked,
} = require("../microJumpDriveEligibility");
const {
  resolveChargeDefaultActivationEffectForModule,
  resolveDefaultActivationEffect,
  resolveEffectByName,
  resolveNpcSyntheticHullEffectRecord,
} = require("../moduleActivationEffectRecord");
const {
  MODULE_ATTRIBUTE_MAX_VELOCITY_ACTIVATION_LIMIT,
  MODULE_ATTRIBUTE_MAX_VELOCITY_LIMITED,
  getGenericModuleRuntimeAttributes,
} = require("../moduleAttributes");
const {
  buildPendingReloadActivationSuccess,
  isPendingMissileReloadReactivation,
} = require("../moduleChargeReload");
const {
  MODULE_CONSEQUENCE_DELIVERY,
  resolveModuleConsequenceDelivery,
} = require("../moduleConsequenceDelivery");
const {
  getEffectCycleBoundaryMs,
  normalizeEffectRepeatCount,
  resolveModuleRemainingCyclesForActivation,
} = require("../moduleCycleSchedule");
const {
  clearJumpPortalBridgeModeForEffect,
  forceDeactivateBlockedMovementEffects,
} = require("../moduleEffectShutdown");
const {
  TYPE_THERMODYNAMICS,
  advanceEntityRackHeat,
  buildOverloadEffectState,
  burnOutModuleOnActivation,
  ensureEntityOverloadModuleEffects,
  ensureEntityPendingOverloadModuleEffects,
  getModuleOverloadEffectRecord,
  getOverloadRackModuleItems,
  isEmergencyHullEnergizerEffect,
  isModuleIncapacitated,
  notifyEntityRackHeatSourcesToOwner,
  notifyEntityRackHeatToOwner,
} = require("../moduleHeat");
const {
  getShipDogmaMotionValue,
} = require("../pendingShipMotion");
const {
  buildAssistanceModuleRuntimeCallbacks,
  buildAutoTargetingRuntimeCallbacks,
  buildHostileModuleRuntimeCallbacks,
  buildJammerModuleRuntimeCallbacks,
  buildLocalCycleRuntimeCallbacks,
  buildMicroJumpDriveRuntimeCallbacks,
  buildPointDefenseRuntimeCallbacks,
  buildSalvagerRuntimeCallbacks,
  buildScannerRuntimeCallbacks,
  buildSmartbombRuntimeCallbacks,
  buildBombRuntimeCallbacks,
  buildDefenderRuntimeCallbacks,
  buildSuperweaponRuntimeCallbacks,
  buildTractorBeamRuntimeCallbacks,
} = require("../moduleRuntimeCallbacks");
const {
  broadcastVortonCycleSpecialFx,
  buildGenericModuleSpecialFxGraphicInfo,
  resolveGenericModuleControlSpecialFxGuid,
  resolveGenericModuleSpecialFxGuid,
} = require("../moduleSpecialFx");
const {
  roundNumber,
  toFiniteNumber,
  toInt,
} = require("../../../common/numbers");
const {
  PROPULSION_EFFECT_AFTERBURNER,
  PROPULSION_EFFECT_MICROWARPDRIVE,
  PROPULSION_GUID_BY_EFFECT,
  getPropulsionEffectID,
  getPropulsionModuleRuntimeAttributes,
} = require("../propulsionModule");
const {
  lazyRequire,
} = require("../runtimeModuleBoundary");
const {
  ATTRIBUTE_DISALLOW_DOCKING,
  ATTRIBUTE_DISALLOW_TETHERING,
  cynosuralModuleTypeDeclaresShipRestriction,
  findActiveEffectStateDisallowingCloaking,
  findActiveEffectStateDisallowingEarlyDeactivation,
  isBastionModuleActivation,
  isEntityOffensiveActivationDisallowed,
  isShipCloakDisabledByRuntime,
  isShipMovementLockedByRuntime,
  shipModifierEntriesImmobilizeShip,
  shipModifierEntriesSetPositiveAttribute,
} = require("../shipActionRestrictions");
const {
  DESTINY_CLOAK_MODE_NORMAL,
  MIN_CLOAKING_DISTANCE_METERS,
  MODULE_ATTRIBUTE_CAN_ACTIVATE_IN_GATE_CLOAK,
  buildCloakModuleUncloakDogmaEvents,
  findActiveCloakingModuleEffectState,
  getEntityCloakStabilizationStrength,
  isCloakingModuleActivation,
  isCloakingModuleEffectState,
  isEntityActiveWarpInFlight,
  isEntityCloaked,
  isEntityModuleCloaked,
  isEntityNormalCloaked,
  isPrototypeCloakingModule,
  isWarpSafeCloakingEffectDescriptor,
  isWarpSafeModuleEffectDescriptor,
  resolveCloakModuleTargetingDelayMs,
  resolveCloakModuleUncloakRangeMeters,
  resolveCloakStabilizationDurationMs,
} = require("../shipCloak");
const {
  consumeShipModuleFuelForSession,
  rollbackShipModuleFuelConsumption,
  roundModuleFuelQuantity,
} = require("../shipModuleFuel");
const {
  breakEntityStructureTether,
} = require("../structureTether");
const {
  TARGET_LOSS_REASON_ATTEMPT_CANCELLED,
  isEntityLockedTarget,
} = require("../targeting");
const {
  breakEntityTimedInvulnerability,
} = require("../timedInvulnerability");
const {
  getTypeDogmaAttributeValueByID,
} = require("../typeAttributeLookup");
const {
  magnitude,
} = require("../../../common/vector");
const {
  resolveVortonArcChain,
  stashVortonArcPlan,
} = require("../vortonArcChain");
const {
  executeMissileCycle,
  executeTurretCycle,
} = require("../weaponCycle");
const {
  buildWeaponSnapshotForEntity,
  isOffensiveWeaponFamily,
  isSnapshotWeaponFamily,
  isValidWeaponSnapshotTarget,
} = require("../weaponSnapshot");

module.exports = {

getActiveModuleEffect(shipID, moduleID) {
    const entity = this.getEntityByID(shipID);
    if (!entity || !(entity.activeModuleEffects instanceof Map)) {
      return null;
    }
    return entity.activeModuleEffects.get(toInt(moduleID, 0)) || null;
  },

getOverloadModuleEffect(shipID, moduleID) {
    const entity = this.getEntityByID(shipID);
    if (!entity || !(entity.overloadModuleEffects instanceof Map)) {
      return null;
    }
    return entity.overloadModuleEffects.get(toInt(moduleID, 0)) || null;
  },

setModuleOverloadState(session, moduleItem, effectID, active, options = {}) {
    const entity = this.getShipEntityForSession(session);
    if (!entity || !moduleItem) {
      return {
        success: false,
        errorMsg: "SHIP_NOT_FOUND",
      };
    }

    const normalizedModuleID = toInt(moduleItem.itemID, 0);
    if (
      normalizedModuleID <= 0 ||
      toInt(moduleItem.locationID, 0) !== toInt(entity.itemID, 0)
    ) {
      return {
        success: false,
        errorMsg: "MODULE_NOT_FOUND",
      };
    }
    if (!isModuleOnline(moduleItem)) {
      return {
        success: false,
        errorMsg: "MODULE_NOT_ONLINE",
      };
    }
    if (active && isModuleIncapacitated(moduleItem)) {
      return {
        success: false,
        errorMsg: "MODULE_INCAPACITATED",
      };
    }

    const effectRecord = getModuleOverloadEffectRecord(moduleItem, effectID);
    if (!effectRecord) {
      return {
        success: false,
        errorMsg: "MODULE_NOT_OVERLOADABLE",
      };
    }
    if (active && getSkillLevel(getEntityRuntimeSkillMap(entity), TYPE_THERMODYNAMICS) <= 0) {
      return {
        success: false,
        errorMsg: "THERMODYNAMICS_SKILL_REQUIRED",
        data: {
          skillLevel: 1,
        },
      };
    }

    const overloadEffects = ensureEntityOverloadModuleEffects(entity);
    const pendingOverloadEffects = ensureEntityPendingOverloadModuleEffects(entity);
    const now = this.getCurrentSimTimeMs();
    let effectState =
      overloadEffects.get(normalizedModuleID) ||
      buildOverloadEffectState(moduleItem, effectRecord, now);
    const changed = active
      ? !overloadEffects.has(normalizedModuleID)
      : overloadEffects.has(normalizedModuleID);

    // A module that is mid-cycle keeps running at the strength it started at.
    // Hold the request; `settlePendingOverloadModuleTransition` applies it when
    // the cycle boundary arrives. Re-pressing the button before then simply
    // withdraws the held request, the way the client's own
    // Stop{Pending,PendingStop}OverloadModule does.
    // `immediate` is for teardown (offlining, unfitting), where the module is
    // about to stop cycling anyway and there is no next cycle to wait for.
    const isCycling =
      options.immediate !== true &&
      entity.activeModuleEffects instanceof Map &&
      entity.activeModuleEffects.has(normalizedModuleID);
    if (isCycling) {
      pendingOverloadEffects.delete(normalizedModuleID);
      if (changed) {
        pendingOverloadEffects.set(normalizedModuleID, {
          active: active === true,
          effectState: active
            ? buildOverloadEffectState(moduleItem, effectRecord, now)
            : effectState,
          requestedAtMs: now,
        });
      }
      // Keep the heat clock current without republishing a gauge that has not
      // moved: nothing about the running cycle changed yet.
      advanceEntityRackHeat(this, entity, now);
      return {
        success: true,
        data: {
          moduleID: normalizedModuleID,
          effectID: toInt(effectRecord.effectID, 0),
          effectState,
          changed: false,
          pending: changed,
        },
      };
    }

    pendingOverloadEffects.delete(normalizedModuleID);
    if (active) {
      effectState = {
        ...effectState,
        startedAtMs: changed ? now : toFiniteNumber(effectState.startedAtMs, now),
      };
      overloadEffects.set(normalizedModuleID, effectState);
    } else {
      overloadEffects.delete(normalizedModuleID);
    }

    notifyGenericModuleEffectState(session, entity, effectState, active === true, {
      whenMs: now,
      startTimeMs: effectState.startedAtMs || now,
      actualStopTimeMs: active ? null : now,
    });

    // Sync the rack heat gauges on overload transitions so the client's own
    // gauge prediction re-anchors from an authoritative server value.
    advanceEntityRackHeat(this, entity, now);
    notifyEntityRackHeatToOwner(this, entity, now, { force: true });

    if (options.refreshDerivedState !== false) {
      this.refreshSessionShipDerivedState(session, {
        notifyGenericModuleAttributes: true,
      });
    }

    return {
      success: true,
      data: {
        moduleID: normalizedModuleID,
        effectID: toInt(effectRecord.effectID, 0),
        effectState,
        changed,
      },
    };
  },

overloadModule(session, moduleItem, effectID, options = {}) {
    return this.setModuleOverloadState(session, moduleItem, effectID, true, options);
  },

stopOverloadModule(session, moduleItem, effectID, options = {}) {
    return this.setModuleOverloadState(session, moduleItem, effectID, false, options);
  },

setOverloadRackState(session, anchorModuleItem, active) {
    const entity = this.getShipEntityForSession(session);
    if (!entity || !anchorModuleItem) {
      return {
        success: false,
        errorMsg: "SHIP_NOT_FOUND",
      };
    }
    if (toInt(anchorModuleItem.locationID, 0) !== toInt(entity.itemID, 0)) {
      return {
        success: false,
        errorMsg: "MODULE_NOT_FOUND",
      };
    }

    const moduleItems = getOverloadRackModuleItems(entity, anchorModuleItem);
    if (moduleItems.length <= 0) {
      return {
        success: false,
        errorMsg: "MODULE_NOT_OVERLOADABLE",
      };
    }

    const moduleIDs = [];
    let lastErrorMsg = null;
    for (const moduleItem of moduleItems) {
      const effectRecord = getModuleOverloadEffectRecord(moduleItem);
      const result = this.setModuleOverloadState(
        session,
        moduleItem,
        effectRecord && effectRecord.effectID,
        active,
        {
          refreshDerivedState: false,
        },
      );
      if (result.success) {
        moduleIDs.push(toInt(moduleItem.itemID, 0));
      } else {
        lastErrorMsg = result.errorMsg || lastErrorMsg;
      }
    }

    if (moduleIDs.length <= 0) {
      return {
        success: false,
        errorMsg: lastErrorMsg || "MODULE_NOT_OVERLOADABLE",
      };
    }

    this.refreshSessionShipDerivedState(session, {
      notifyGenericModuleAttributes: true,
    });

    return {
      success: true,
      data: {
        moduleIDs,
      },
    };
  },

overloadRack(session, anchorModuleItem) {
    return this.setOverloadRackState(session, anchorModuleItem, true);
  },

stopOverloadRack(session, anchorModuleItem) {
    return this.setOverloadRackState(session, anchorModuleItem, false);
  },

reconcileActiveTurretWeaponBankEffects(shipID, moduleIDs = []) {
    const entity = this.getEntityByID(shipID);
    return reconcileActiveTurretWeaponBankEffectStates(entity, moduleIDs);
  },

activatePropulsionModule(session, moduleItem, effectName, options = {}) {
    const entity = this.getShipEntityForSession(session);
    if (!entity || !moduleItem) {
      return {
        success: false,
        errorMsg: "SHIP_NOT_FOUND",
      };
    }

    if (isEntityActiveWarpInFlight(entity) &&
        !isWarpSafeModuleEffectDescriptor(getEffectTypeRecord(getPropulsionEffectID(effectName)))) {
      return { success: false, errorMsg: "CANNOT_ACTIVATE_IN_WARP" };
    }
    const normalizedModuleID = toInt(moduleItem.itemID, 0);
    if (
      normalizedModuleID <= 0 ||
      toInt(moduleItem.locationID, 0) !== toInt(entity.itemID, 0)
    ) {
      return {
        success: false,
        errorMsg: "MODULE_NOT_FOUND",
      };
    }
    if (!isModuleOnline(moduleItem)) {
      return {
        success: false,
        errorMsg: "MODULE_NOT_ONLINE",
      };
    }
    if (isModuleIncapacitated(moduleItem)) {
      return {
        success: false,
        errorMsg: "MODULE_INCAPACITATED",
      };
    }
    if (!(entity.activeModuleEffects instanceof Map)) {
      entity.activeModuleEffects = new Map();
    }
    if (!(entity.moduleReactivationLocks instanceof Map)) {
      entity.moduleReactivationLocks = new Map();
    }
    if (entity.activeModuleEffects.has(normalizedModuleID)) {
      return {
        success: false,
        errorMsg: "MODULE_ALREADY_ACTIVE",
      };
    }

    if (isEntityModuleCloaked(entity)) {
      return {
        success: false,
        errorMsg: "MODULE_CLOAKED",
      };
    }

    const lockUntil = toFiniteNumber(
      entity.moduleReactivationLocks.get(normalizedModuleID),
      0,
    );
    const now = this.getCurrentSimTimeMs();
    if (lockUntil > now) {
      return {
        success: false,
        errorMsg: "MODULE_REACTIVATING",
      };
    }
    if (isShipMovementLockedByRuntime(entity, now)) {
      return {
        success: false,
        errorMsg: "SHIP_IMMOBILE",
      };
    }
    if (
      effectName === PROPULSION_EFFECT_MICROWARPDRIVE &&
      (hostileModuleRuntime.isMicrowarpdriveBlocked(entity) ||
        require("../../../services/dynamic/essFieldRuntime").isEntityWarpBlocked(this, entity))
    ) {
      return {
        success: false,
        errorMsg: "MICROWARPDRIVE_BLOCKED",
      };
    }

    const runtimeAttributes = getPropulsionModuleRuntimeAttributes(
      getShipEntityInventoryCharacterID(entity, toInt(session && session.characterID, 0)),
      moduleItem,
      {
        skillMap: getEntityRuntimeSkillMap(entity),
        shipItem: getEntityRuntimeShipItem(entity),
        fittedItems: getEntityRuntimeFittedItems(entity),
        activeModuleContexts: getEntityRuntimeActiveModuleContexts(entity, {
          excludeModuleID: normalizedModuleID,
          includeOverloadModuleID: normalizedModuleID,
        }),
        additionalDirectModifierEntries:
          resolveModuleSnapshotDirectModifierEntries(entity, moduleItem, {
            nowMs: now,
            collectModifierEntriesForItem:
              commandBurstRuntime.collectModifierEntriesForItem,
          }),
      },
    );
    if (!runtimeAttributes) {
      return {
        success: false,
        errorMsg: "UNSUPPORTED_EFFECT",
      };
    }

    const currentSpeed = magnitude(entity.velocity);
    if (
      runtimeAttributes.maxVelocityActivationLimit > 0 &&
      currentSpeed > runtimeAttributes.maxVelocityActivationLimit + 1e-6
    ) {
      return {
        success: false,
        errorMsg: "MAX_VELOCITY_ACTIVATION_LIMIT",
      };
    }

    if (runtimeAttributes.maxGroupActive > 0) {
      let activeCount = 0;
      for (const effectState of entity.activeModuleEffects.values()) {
        if (toInt(effectState.groupID, 0) === toInt(moduleItem.groupID, 0)) {
          activeCount += 1;
        }
      }
      if (activeCount >= runtimeAttributes.maxGroupActive) {
        return {
          success: false,
          errorMsg: "MAX_GROUP_ACTIVE",
        };
      }
    }


    const previousChargeAmount = getEntityCapacitorAmount(entity);
    if (!consumeEntityCapacitor(entity, runtimeAttributes.capNeed)) {
      return {
        success: false,
        errorMsg: "NOT_ENOUGH_CAPACITOR",
      };
    }
    // CCP parity: Notify the client that capacitor has been consumed so the
    // HUD gauge updates immediately rather than waiting for the next poll.
    notifyCapacitorChangeToSession(session, entity, now, previousChargeAmount);

    const effectID = getPropulsionEffectID(effectName);
    const effectRecord = effectID > 0 ? getEffectTypeRecord(effectID) : null;
    const effectState = {
      moduleID: normalizedModuleID,
      moduleFlagID: toInt(moduleItem.flagID, 0),
      effectName,
      effectID,
      effectCategoryID: toInt(effectRecord && effectRecord.effectCategoryID, 1),
      effectRecord: effectRecord && typeof effectRecord === "object"
        ? { ...effectRecord }
        : null,
      groupID: toInt(moduleItem.groupID, 0),
      typeID: toInt(moduleItem.typeID, 0),
      startedAtMs: now,
      durationMs: runtimeAttributes.durationMs,
      nextCycleAtMs: now + runtimeAttributes.durationMs,
      capNeed: runtimeAttributes.capNeed,
      speedFactor: runtimeAttributes.speedFactor,
      speedBoostFactor: runtimeAttributes.speedBoostFactor,
      massAddition: runtimeAttributes.massAddition,
      signatureRadiusBonus: runtimeAttributes.signatureRadiusBonus,
      reactivationDelayMs: runtimeAttributes.reactivationDelayMs,
      guid: PROPULSION_GUID_BY_EFFECT[effectName] || "",
      repeat: normalizeEffectRepeatCount(options.repeat, null),
      remainingCycles: resolveModuleRemainingCyclesForActivation(options.repeat, moduleItem),
      consequenceDelivery: MODULE_CONSEQUENCE_DELIVERY.CONTINUOUS,
      deactivationRequestedAtMs: 0,
      deactivateAtMs: 0,
      stopReason: null,
    };
    entity.activeModuleEffects.set(normalizedModuleID, effectState);
    breakEntityTimedInvulnerability(entity, { trigger: "module" });
    const refreshResult = isReadyForDestiny(session)
      ? this.refreshSessionShipDerivedState(session, {
          broadcast: true,
        })
      : this.refreshShipEntityDerivedState(entity, {
          session,
          broadcast: true,
        });
    if (refreshResult.success) {
      notifyPropulsionDerivedAttributesToSession(session, entity, effectState, now);
      this.broadcastSpecialFx(
        entity.itemID,
        effectState.guid,
        {
          moduleID: effectState.moduleID,
          moduleTypeID: effectState.typeID,
          start: true,
          active: true,
          duration: effectState.durationMs,
        },
        entity,
      );
      notifyModuleEffectState(session, entity, effectState, true, {
        whenMs: now,
        startTimeMs: now,
      });
    }
    // An overloaded module heats its rack from the moment it cycles, so the
    // pilot is told with the effect rather than at the next tick.
    notifyEntityRackHeatSourcesToOwner(this, entity);

    return this.cancelStargateJumpCloakAfterCommand(session, {
      success: true,
      data: {
        entity,
        effectState,
      },
    }, "module");
  },

finalizePropulsionModuleDeactivation(session, moduleID, options = {}) {
    const entity = this.getShipEntityForSession(session);
    const normalizedModuleID = toInt(moduleID, 0);
    if (
      !entity ||
      normalizedModuleID <= 0 ||
      !(entity.activeModuleEffects instanceof Map)
    ) {
      return {
        success: false,
        errorMsg: "MODULE_NOT_ACTIVE",
      };
    }

    const effectState = entity.activeModuleEffects.get(normalizedModuleID) || null;
    if (!effectState) {
      return {
        success: false,
        errorMsg: "MODULE_NOT_ACTIVE",
      };
    }

    const stopTimeMs = Math.max(
      0,
      toFiniteNumber(
        options.nowMs,
        getEffectCycleBoundaryMs(effectState, this.getCurrentSimTimeMs()),
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

    const hasReadyOwnerSession = isReadyForDestiny(session);
    const suppressOwnerDestinyUpdates =
      options.suppressOwnerDestinyUpdates === true;

    // The new prime values and the effect's stop go to the ship's Grid bubble
    // history, its owner included.
    const refreshResult = hasReadyOwnerSession && !suppressOwnerDestinyUpdates
      ? this.refreshSessionShipDerivedState(session, {
          broadcast: true,
        })
      : this.refreshShipEntityDerivedState(entity, {
          session,
          broadcast: false,
          // Told when the new values apply.
          shipPrimeBroadcast: (previousState) => this.broadcastShipPrimeUpdates(entity, {
            previousState,
          }),
        });
    if (refreshResult.success) {
      notifyPropulsionDerivedAttributesToSession(session, entity, effectState, stopTimeMs);
      this.broadcastSpecialFx(
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
      notifyModuleEffectState(session, entity, effectState, false, {
        whenMs: stopTimeMs,
      });
    }
    notifyEntityRackHeatSourcesToOwner(this, entity);

    return {
      success: true,
      data: {
        entity,
        effectState,
        stoppedAtMs: stopTimeMs,
      },
    };
  },

deactivatePropulsionModule(session, moduleID, options = {}) {
    const entity = this.getShipEntityForSession(session);
    const normalizedModuleID = toInt(moduleID, 0);
    if (
      !entity ||
      normalizedModuleID <= 0 ||
      !(entity.activeModuleEffects instanceof Map)
    ) {
      return {
        success: false,
        errorMsg: "MODULE_NOT_ACTIVE",
      };
    }

    const effectState = entity.activeModuleEffects.get(normalizedModuleID) || null;
    if (!effectState) {
      return {
        success: false,
        errorMsg: "MODULE_NOT_ACTIVE",
      };
    }

    const now = this.getCurrentSimTimeMs();
    const reason = String(options.reason || "manual");
    const cycleBoundaryMs = getEffectCycleBoundaryMs(effectState, now);
    // See deactivateGenericModule: deferUntilCycle === true lets a non-manual
    // caller stop the module at its cycle boundary instead of instantly. This
    // is what keeps the MWD's burst when a cloak is engaged.
    const shouldDefer =
      options.deferUntilCycle === true ||
      (options.deferUntilCycle !== false && reason === "manual");

    if (effectState.deactivateAtMs > 0 && effectState.deactivateAtMs > now) {
      return {
        success: true,
        data: {
          entity,
          effectState,
          pending: true,
          deactivateAtMs: effectState.deactivateAtMs,
        },
      };
    }

    if (shouldDefer && cycleBoundaryMs > now + 1) {
      effectState.deactivationRequestedAtMs = now;
      effectState.deactivateAtMs = cycleBoundaryMs;
      effectState.stopReason = reason;
      persistDynamicEntity(entity);
      return {
        success: true,
        data: {
          entity,
          effectState,
          pending: true,
          deactivateAtMs: cycleBoundaryMs,
        },
      };
    }

    return this.finalizePropulsionModuleDeactivation(session, normalizedModuleID, {
      reason,
      nowMs: cycleBoundaryMs > 0 ? cycleBoundaryMs : now,
    });
  },

// -------------------------------------------------------------------
  // Generic module activation (non-propulsion) — weapons, repairers,
  // shield boosters, etc.  Sends OnGodmaShipEffect with proper timing
  // so the HUD radial cycle ring animates correctly.
  // -------------------------------------------------------------------

  activateGenericModule(session, moduleItem, effectName, options = {}) {
    const entity = this.getShipEntityForSession(session);
    if (!entity || !moduleItem) {
      return { success: false, errorMsg: "SHIP_NOT_FOUND" };
    }
    if (starbaseDefenseRuntime.isStarbaseBattery(entity)) {
      const valid = starbaseDefenseRuntime.validateBatteryOperation(entity.itemID);
      if (!valid.success) return valid;
      if (toInt(moduleItem.itemID, 0) !== toInt(entity.itemID, 0)) {
        return { success: false, errorMsg: "MODULE_NOT_FOUND" };
      }
      moduleItem = starbaseDefenseRuntime.getBatteryModuleView(entity.itemID);
      effectName = valid.data.profile.effectName;
    }
    if (isRuntimeStructureDogmaHostEntity(entity) && session) {
      entity.session = session;
      entity.characterID = toInt(session.characterID || session.charid, 0);
      entity.pilotCharacterID = entity.characterID;
      entity.corporationID = toInt(
        session.corporationID || session.corpid,
        entity.corporationID,
      );
      entity.allianceID = toInt(
        session.allianceID || session.allianceid,
        entity.allianceID,
      );
    }
    const effectiveModuleItem = buildNpcEffectiveModuleItem(moduleItem);

    const normalizedModuleID = toInt(moduleItem.itemID, 0);
    if (
      normalizedModuleID <= 0 ||
      toInt(moduleItem.locationID, 0) !== toInt(entity.itemID, 0)
    ) {
      return { success: false, errorMsg: "MODULE_NOT_FOUND" };
    }
    if (!isModuleOnline(moduleItem)) {
      return { success: false, errorMsg: "MODULE_NOT_ONLINE" };
    }
    if (isModuleIncapacitated(moduleItem)) {
      return { success: false, errorMsg: "MODULE_INCAPACITATED" };
    }
    if (!(entity.activeModuleEffects instanceof Map)) {
      entity.activeModuleEffects = new Map();
    }
    if (!(entity.moduleReactivationLocks instanceof Map)) {
      entity.moduleReactivationLocks = new Map();
    }
    const now = this.getCurrentSimTimeMs();
    if (entity.activeModuleEffects.has(normalizedModuleID)) {
      const existingEffectState = entity.activeModuleEffects.get(normalizedModuleID) || null;
      if (isPendingMissileReloadReactivation(existingEffectState, now)) {
        return buildPendingReloadActivationSuccess(entity, existingEffectState);
      }
      return { success: false, errorMsg: "MODULE_ALREADY_ACTIVE" };
    }

    // Resolve the activation effect from the module's type dogma
    const requestedEffectName = String(effectName || "").trim();
    let effectRecord = requestedEffectName
      ? resolveEffectByName(effectiveModuleItem.typeID, requestedEffectName)
      : null;
    if (!effectRecord && requestedEffectName) {
      effectRecord = resolveNpcSyntheticHullEffectRecord(moduleItem, requestedEffectName);
    }
    if (!effectRecord) {
      // The default-activation fallback is for a caller that named no effect, or named one this
      // type no longer carries — a client activation packet is a hint, and a fitted module's
      // first activatable effect is what the module does. A synthetic NPC hull module has no
      // such second identity: its effect name IS the module, and the hull's first activatable
      // effect is an unrelated family (a rat's gun). Fail loudly there rather than substitute.
      if (requestedEffectName && moduleItem.npcSyntheticHullModule === true) {
        return { success: false, errorMsg: "EFFECT_NOT_ON_MODULE" };
      }
      effectRecord = resolveDefaultActivationEffect(effectiveModuleItem.typeID);
    }
    if (!effectRecord) {
      return { success: false, errorMsg: "NO_ACTIVATABLE_EFFECT" };
    }
    const isCloakingActivation = isCloakingModuleActivation(
      effectiveModuleItem,
      effectRecord,
    );
    const isBastionActivation = isBastionModuleActivation(
      effectiveModuleItem,
      effectRecord,
    );
    const isCynosuralActivation = isCynosuralGenerationEffect(effectRecord);
    const essRestriction = require("../../../services/dynamic/essFieldRuntime").resolveModuleRestriction(
      this, entity, { ...effectRecord, cloaking: isCloakingActivation, cynosuralGeneration: isCynosuralActivation },
    );
    if (essRestriction) return { success: false, errorMsg: essRestriction };
    const abyssalCynosuralRestriction = isCynosuralActivation
      ? resolveAbyssalCynosuralActivationRestriction(session, entity, this)
      : null;
    if (abyssalCynosuralRestriction && abyssalCynosuralRestriction.blocked) {
      return {
        success: false,
        errorMsg: abyssalCynosuralRestriction.errorMsg,
        data: {
          ...abyssalCynosuralRestriction,
          sceneKey: this.sceneKey,
        },
      };
    }
    // The 500 m/s activation ceiling. `activatePropulsionModule` has carried
    // this gate for a long time, but nothing in the generic path did — and the
    // attribute pair is declared by exactly three published types, all of them
    // Cynosural Field Generators, none of which is a propulsion module. So the
    // rule EVE University states plainly ("If you want to light a cyno you have
    // to be in a fleet ... and slower than 500 m/s",
    // https://wiki.eveuniversity.org/Jump_drives) did not exist here.
    // Written off the attributes rather than the family: no effect in the SDE
    // modifies 1333 or 1334, so the type value is the live value, and the reach
    // is exactly those three types.
    const maxVelocityLimited = toFiniteNumber(
      getTypeDogmaAttributeValueByID(
        toInt(effectiveModuleItem.typeID, 0),
        MODULE_ATTRIBUTE_MAX_VELOCITY_LIMITED,
        0,
      ),
      0,
    ) > 0;
    if (maxVelocityLimited) {
      const activationSpeedLimit = toFiniteNumber(
        getTypeDogmaAttributeValueByID(
          toInt(effectiveModuleItem.typeID, 0),
          MODULE_ATTRIBUTE_MAX_VELOCITY_ACTIVATION_LIMIT,
          0,
        ),
        0,
      );
      if (
        activationSpeedLimit > 0 &&
        magnitude(entity.velocity) > activationSpeedLimit + 1e-6
      ) {
        return { success: false, errorMsg: "MAX_VELOCITY_ACTIVATION_LIMIT" };
      }
    }
    const cynosuralSpaceRestriction = isCynosuralActivation
      ? resolveCynosuralActivationSpaceRestriction(this, effectiveModuleItem)
      : null;
    if (cynosuralSpaceRestriction && cynosuralSpaceRestriction.blocked) {
      return {
        success: false,
        errorMsg: cynosuralSpaceRestriction.errorMsg,
        data: {
          ...cynosuralSpaceRestriction,
          sceneKey: this.sceneKey,
        },
      };
    }
    if (!isCloakingActivation && isEntityModuleCloaked(entity)) {
      return { success: false, errorMsg: "MODULE_CLOAKED" };
    }
    const lockUntil = toFiniteNumber(
      entity.moduleReactivationLocks.get(normalizedModuleID),
      0,
    );
    if (lockUntil > now) {
      return { success: false, errorMsg: "MODULE_REACTIVATING" };
    }
    if (isCloakingActivation) {
      const abyssalCloakRestriction =
        resolveAbyssalCloakActivationRestriction(session, entity);
      if (abyssalCloakRestriction && abyssalCloakRestriction.blocked) {
        return {
          success: false,
          errorMsg: abyssalCloakRestriction.errorMsg,
          data: abyssalCloakRestriction,
        };
      }
      // FakeCloaking.PreStartChecks:139 refuses a *second device*:
      //   if dogmaLM.IsShipCloaked(): raise UserError('CantCloakTooManyDevices')
      // A stargate jump cloak is not a device. Reading any cloak mode here made
      // DESTINY_CLOAK_MODE_RESTORE (2) answer "module already active", so a ship
      // that had just landed on a gate could not arm its cloak inside the 60 s
      // session cloak — which is the entire covert manoeuvre, and the same
      // interaction family 11 fixed from the other side with
      // `canActivateInGateCloak`. Refuse only when a cloaking device is running.
      if (
        isEntityNormalCloaked(entity) ||
        findActiveCloakingModuleEffectState(entity)
      ) {
        return { success: false, errorMsg: "MODULE_ALREADY_ACTIVE" };
      }
      if (require("../../../services/seasons/eventHooks").fw.cloakBlocked(this,entity) || require("../../../services/seasons/eventHooks").fabricator.disruption(this,entity) || isShipCloakDisabledByRuntime(entity, now)) {
        return { success: false, errorMsg: "CLOAK_DISRUPTED" };
      }
      // `disruptionLanceDisallowCloaking` (5425), and the matching passive
      // effect 11714, both sit on the Disruptive Lance module rather than on
      // anything it shoots: a Lancer Dreadnought carrying one cannot engage a
      // cloak at all, fired or not.
      if (entityHasCloakDisallowingFittedModule(getEntityRuntimeFittedItems(entity))) {
        return { success: false, errorMsg: "CLOAK_DISALLOWED_BY_FITTING" };
      }
      // Engaging a cloak stops every other running module at its own cycle
      // boundary (deactivateAllActiveModules below), so a module whose cycle
      // cannot be cut short blocks the cloak outright rather than being
      // stopped by it at all.
      // This is the V24 client's own rule — FakeCloaking.PreStartChecks walks
      // GetActivatedEffectsOnShip and raises CantCloakModuleActive for any type
      // carrying disallowEarlyDeactivation. It is what makes a gas cloud
      // harvester's cycle a real commitment: the harvester must finish before a
      // covert ops ship can cloak up.
      const uncuttableEffectState =
        findActiveEffectStateDisallowingEarlyDeactivation(entity, normalizedModuleID) ||
        findActiveEffectStateDisallowingCloaking(entity, normalizedModuleID);
      if (uncuttableEffectState) {
        return {
          success: false,
          errorMsg: "CLOAK_MODULE_ACTIVE",
          data: {
            moduleID: toInt(uncuttableEffectState.moduleID, 0),
            moduleTypeID: toInt(uncuttableEffectState.typeID, 0),
            effectName: String(uncuttableEffectState.effectName || ""),
          },
        };
      }
      const targeterIDs = this.getTargetersForEntity(entity);
      if (targeterIDs.length > 0) {
        return {
          success: false,
          errorMsg: "CLOAK_TARGET_LOCKED",
          data: {
            targeterIDs,
          },
        };
      }
      // A standard cloaking device cannot be engaged once the ship is committed
      // to a warp — neither in warp nor aligning into one, since the warp it is
      // committed to cannot be flown cloaked. A WARP Ball with a negative
      // effectStamp is aligning, which isEntityActiveWarpInFlight excludes.
      // Warp-safe (covert ops) cloaks may be engaged at any point in the cycle.
      if (
        (isEntityActiveWarpInFlight(entity) || (entity.mode === "WARP" && Number(entity.effectStamp) < 0)) &&
        !isWarpSafeCloakingEffectDescriptor(effectRecord)
      ) {
        return { success: false, errorMsg: "CLOAK_WARP_BLOCKED" };
      }
      // Proximity applies in every state, with one exception: a warp-safe
      // (covert ops) cloak ignores departure proximity once the ship is
      // genuinely in warp (active warp in flight). Covert-ops-capable ships are
      // allowed to warp cloaked, and by the time the warp is underway the ship
      // is leaving those objects behind. Before/at warp start (aligning, or not
      // yet moving) proximity still applies, so a covert cloak cannot engage
      // while the ship is still sitting on top of an object.
      const warpSafeInFlight =
        isEntityActiveWarpInFlight(entity) &&
        isWarpSafeCloakingEffectDescriptor(effectRecord);
      if (!warpSafeInFlight) {
        const proximityTrigger = this.findCloakProximityTrigger(
          entity,
          MIN_CLOAKING_DISTANCE_METERS,
        );
        if (proximityTrigger) {
          return {
            success: false,
            errorMsg: "CLOAK_PROXIMITY_BLOCKED",
            data: {
              triggerEntityID: toInt(
                proximityTrigger.triggerEntity &&
                  proximityTrigger.triggerEntity.itemID,
                0,
              ),
              surfaceDistanceMeters: proximityTrigger.surfaceDistanceMeters,
              rangeMeters: proximityTrigger.rangeMeters,
            },
          };
        }
      }
    }
    if (isBastionActivation && isWarping(entity)) {
      return { success: false, errorMsg: "CANNOT_ACTIVATE_IN_WARP" };
    }
    if (isBastionActivation && entity.pendingDock) {
      return { success: false, errorMsg: "SHIP_IMMOBILE" };
    }
    // A smartbomb cannot be activated while the ship is in warp. Every other
    // offensive family is stopped by its own target requirement — you cannot
    // hold a lock through warp — but an EMP wave takes no target, so nothing
    // else refuses it. Gate it explicitly.
    if (
      isEntityActiveWarpInFlight(entity) &&
      smartbombRuntime.isSmartbombEffect(effectRecord, effectiveModuleItem)
    ) {
      return { success: false, errorMsg: "CANNOT_ACTIVATE_IN_WARP" };
    }
    if (
      moduleActivationRequiresActiveIndustrialCore(effectiveModuleItem.typeID) &&
      !hasActiveIndustrialCoreEffect(entity)
    ) {
      return {
        success: false,
        errorMsg: "ACTIVE_INDUSTRIAL_CORE_REQUIRED",
      };
    }

    const chargeItem = getEntityRuntimeLoadedCharge(entity, moduleItem);
    if (
      warpDisruptFieldGeneratorRuntime.isWarpDisruptFieldGeneratorActivation(
        effectiveModuleItem,
        effectRecord && (effectRecord.name || effectRecord.guid || effectName),
      )
    ) {
      const warpDisruptFieldRestriction =
        warpDisruptFieldGeneratorRuntime.getActivationRestriction(
          this.systemID,
          effectiveModuleItem,
          chargeItem,
        );
      if (warpDisruptFieldRestriction) {
        return {
          success: false,
          errorMsg: warpDisruptFieldRestriction,
        };
      }
    }
    effectRecord = resolveChargeDefaultActivationEffectForModule(
      effectiveModuleItem,
      effectRecord,
      chargeItem,
    );
    if (isEntityActiveWarpInFlight(entity) &&
        !isWarpSafeModuleEffectDescriptor(effectRecord)) {
      return { success: false, errorMsg: "CANNOT_ACTIVATE_IN_WARP" };
    }
    const weaponFamily = resolveWeaponFamily(moduleItem, chargeItem);
    const chargeOptionalTurretWeapon = isChargeOptionalTurretWeapon(
      moduleItem,
      chargeItem,
    );
    const miningRuntime =
      config.miningEnabled === true
        ? lazyRequire("../services/mining/miningRuntime")
        : null;
    let weaponSnapshot = null;
    let miningActivation = null;
    let commandBurstActivation = null;
    let assistanceActivation = null;
    let jammerModuleActivation = null;
    let hostileModuleActivation = null;
    let smartbombActivation = null;
    let bombActivation = null;
    let defenderActivation = null;
    let targetingModuleActivation = null;
    let entosisLinkActivation = null;
    let scannerActivation = null;
    let pointDefenseActivation = null;
    let tractorBeamActivation = null;
    let salvagerActivation = null;
    let microJumpDriveActivation = null;
    let targetEntity = null;
    let resolvedTargetID = toInt(options.targetID, 0);
    const shipRecord = getEntityRuntimeShipItem(entity);
    if (!shipRecord) {
      return { success: false, errorMsg: "SHIP_NOT_FOUND" };
    }
    const fittedItems = getEntityRuntimeFittedItems(entity);
    const skillMap = getEntityRuntimeSkillMap(entity);
    const activeModuleContexts = getEntityRuntimeActiveModuleContexts(entity, {
      excludeModuleID: normalizedModuleID,
      includeOverloadModuleID: normalizedModuleID,
    });
    if (bombRuntime.isBombLauncher(effectiveModuleItem)) {
      weaponSnapshot = chargeItem ? buildWeaponSnapshotForEntity(entity, moduleItem, chargeItem,
        { shipItem: shipRecord }) : null;
      bombActivation = bombRuntime.resolveBombLauncherActivation({ scene: this, entity,
        moduleItem: effectiveModuleItem, chargeItem, snapshot: weaponSnapshot });
      if (!bombActivation.success) return { success: false, errorMsg: bombActivation.errorMsg };
      weaponSnapshot = bombActivation.data.snapshot;
      resolvedTargetID = 0;
    }
    if (defenderRuntime.isModernDefenderActivation(entity, effectiveModuleItem, resolvedTargetID)) {
      weaponSnapshot = chargeItem ? buildWeaponSnapshotForEntity(entity, moduleItem, chargeItem,
        { shipItem: shipRecord }) : null;
      defenderActivation = defenderRuntime.resolveDefenderActivation({ scene: this, entity,
        moduleItem: effectiveModuleItem, chargeItem, snapshot: weaponSnapshot });
      if (!defenderActivation.success) return { success: false, errorMsg: defenderActivation.errorMsg };
      weaponSnapshot = defenderActivation.data.snapshot;
      resolvedTargetID = 0;
    }
    if (!defenderActivation && isSnapshotWeaponFamily(weaponFamily)) {
      if (!chargeItem && !chargeOptionalTurretWeapon) {
        return { success: false, errorMsg: "NO_AMMO" };
      }
      weaponSnapshot = buildWeaponSnapshotForEntity(entity, moduleItem, chargeItem, {
        shipItem: shipRecord,
      });
      if (!weaponSnapshot) {
        return { success: false, errorMsg: chargeItem ? "UNSUPPORTED_WEAPON" : "NO_AMMO" };
      }
      const autoTargetingMissileCharge =
        isMissileWeaponFamily(weaponSnapshot.family) &&
        isAutoTargetingMissileCharge(chargeItem);
      if (autoTargetingMissileCharge) {
        targetEntity = resolveAutoTargetingMissileTarget(
          this,
          entity,
          weaponSnapshot,
          chargeItem,
        );
        resolvedTargetID = toInt(targetEntity && targetEntity.itemID, 0);
        if (resolvedTargetID <= 0) {
          return { success: false, errorMsg: "TARGET_NOT_FOUND" };
        }
      }
      if (resolvedTargetID <= 0) {
        return { success: false, errorMsg: "TARGET_REQUIRED" };
      }
      targetEntity = targetEntity || this.getEntityByID(resolvedTargetID);
      if (!targetEntity) {
        return { success: false, errorMsg: "TARGET_NOT_FOUND" };
      }
      const targetLocked = isEntityLockedTarget(entity, resolvedTargetID);
      if (!autoTargetingMissileCharge && !targetLocked) {
        return { success: false, errorMsg: "TARGET_NOT_LOCKED" };
      }
      if (
        autoTargetingMissileCharge &&
        !hasActiveAutoTargetingMissileAggression(targetEntity, entity)
      ) {
        return { success: false, errorMsg: "TARGET_NOT_FOUND" };
      }
      if (!isValidWeaponSnapshotTarget(entity, targetEntity, weaponSnapshot)) {
        // "That target is no longer present" is what a despawned entity means, and
        // folding every other rejection into it costs real diagnosis time: a rat
        // whose hull declares no shield, armor or structure hit points sits on the
        // grid, locks, and orbits, yet reports itself gone the moment a gun or
        // launcher is pointed at it. Name that case instead of hiding it.
        return {
          success: false,
          errorMsg: hasDamageableHealth(targetEntity)
            ? "TARGET_NOT_FOUND"
            : "TARGET_NOT_DAMAGEABLE",
        };
      }

      // A locked target can be fired on even when the missile will expire
      // before impact. Auto-targeting charges still have a search radius.
      if (autoTargetingMissileCharge) {
        const desiredRange = getAutoTargetingMissileRangeMeters(chargeItem);
        const missileRangeState = this.getEntitySurfaceState(entity, targetEntity);
        if (!missileRangeState.available) {
          return {
            success: false,
            errorMsg: "TARGET_NOT_FOUND",
            data: { positionSample: missileRangeState.positionSample },
          };
        }
        const rangeDecision = {
          desiredRange,
          actualDistance: missileRangeState.surfaceDistance,
          graceMeters: 1,
          sampledAtSimTimeMs: now,
          sourcePosition: { ...missileRangeState.sourceEntity.position },
          targetPosition: { ...missileRangeState.targetEntity.position },
        };
        if (rangeDecision.actualDistance > desiredRange + rangeDecision.graceMeters) {
          return {
            success: false,
            errorMsg: "TARGET_OUT_OF_RANGE",
            data: { rangeDecision },
          };
        }
      }
    }
    // Effect 6063 is effectCategoryID 2 (activeTarget) with rangeAttributeID 54,
    // but the generic fallback enforces neither: target requirement and range
    // are gated on isSnapshotWeaponFamily, and an Entosis Link is not a weapon.
    // Left alone it activated with no target at all and dropped the requested
    // targetID to 0.
    entosisLinkActivation = entosisLinkRuntime.resolveEntosisLinkActivation({
      scene: this,
      entity,
      moduleItem: effectiveModuleItem,
      effectRecord,
      chargeItem,
      shipItem: shipRecord,
      skillMap,
      fittedItems,
      activeModuleContexts,
      additionalLocationModifierSources: isStructureDogmaHost(shipRecord)
        ? []
        : collectEntityWormholeLocationModifierSources(entity),
      targetID: resolvedTargetID,
      nowMs: now,
      isTargetLocked: isEntityLockedTarget,
    });
    if (entosisLinkActivation && entosisLinkActivation.matched === true) {
      if (entosisLinkActivation.success !== true) {
        return {
          success: false,
          errorMsg: entosisLinkActivation.errorMsg || "UNSUPPORTED_MODULE",
          data: entosisLinkActivation.data || undefined,
        };
      }
      targetEntity = entosisLinkActivation.data.targetEntity;
    }
    // Effects 46/47 are effectCategoryID 2 (activeTarget) with their own range
    // attributes, and the generic fallback enforced neither, so both scanners
    // activated on nothing, at any distance, and dropped their targetID to 0.
    scannerActivation = scannerModuleRuntime.resolveScannerActivation({
      entity,
      moduleItem: effectiveModuleItem,
      effectRecord,
      chargeItem,
      shipItem: shipRecord,
      skillMap,
      fittedItems,
      activeModuleContexts,
      additionalLocationModifierSources: isStructureDogmaHost(shipRecord)
        ? []
        : collectEntityWormholeLocationModifierSources(entity),
      targetID: resolvedTargetID,
      callbacks: buildScannerRuntimeCallbacks(this),
    });
    if (scannerActivation && scannerActivation.matched === true) {
      if (scannerActivation.success !== true) {
        return {
          success: false,
          errorMsg: scannerActivation.errorMsg || "UNSUPPORTED_MODULE",
          data: scannerActivation.data || undefined,
        };
      }
      targetEntity = scannerActivation.data.targetEntity;
    }
    // Effect 1738 (doHacking) is effectCategoryID 2 (activeTarget) and its FX guid is
    // effects.TargetScan, a LocatorStretchEffect the client draws from the ship to the FX target
    // (stretchEffect.py Prepare raises "no target ball found" without one). The dogma layer has
    // already checked the container, its range and the analyzer kind; keep it as the target so the
    // effect state and its OnSpecialFX name the container instead of 0.
    if (!targetEntity && resolvedTargetID > 0 && String(effectRecord && effectRecord.name) === "doHacking") {
      targetEntity = this.getEntityByID(resolvedTargetID) || null;
    }
    if (
      !weaponSnapshot &&
      miningRuntime &&
      typeof miningRuntime.resolveMiningActivation === "function"
    ) {
      miningActivation = miningRuntime.resolveMiningActivation(
        this,
        entity,
        moduleItem,
        effectRecord,
        options,
      );
      if (miningActivation && miningActivation.matched === true) {
        if (miningActivation.success !== true) {
          return {
            success: false,
            errorMsg: miningActivation.errorMsg || "UNSUPPORTED_MODULE",
            data: miningActivation.data || null,
          };
        }
        targetEntity = miningActivation.data && miningActivation.data.targetEntity
          ? miningActivation.data.targetEntity
          : null;
      }
    }
    if (!weaponSnapshot && !(miningActivation && miningActivation.success === true)) {
      commandBurstActivation = commandBurstRuntime.resolveCommandBurstActivation({
        characterID: toInt(
          session && (session.characterID || session.charid),
          toInt(entity && (entity.characterID ?? entity.pilotCharacterID), 0),
        ),
        effectRecord,
        moduleItem,
        chargeItem,
        shipItem: shipRecord,
        skillMap,
        fittedItems,
        activeModuleContexts,
      });
      if (commandBurstActivation && commandBurstActivation.matched === true) {
        if (commandBurstActivation.success !== true) {
          return {
            success: false,
            errorMsg: commandBurstActivation.errorMsg || "UNSUPPORTED_MODULE",
          };
        }
        if (isShipInsideForceField(this, entity, now)) {
          return {
            success: false,
            errorMsg: "SHIP_IN_FORCE_FIELD",
          };
        }
        // A Phenomena Generator declares its warfare buffs on the module and
        // takes no charge — it runs on isotopes through the generic fuel path.
        const commandBurstCarriesOwnBuffs = Boolean(
          commandBurstActivation.data &&
          commandBurstActivation.data.effectStatePatch &&
          commandBurstActivation.data.effectStatePatch.commandBurstCarriesOwnBuffs,
        );
        if (
          !commandBurstCarriesOwnBuffs &&
          !getEntityRuntimeLoadedCharge(entity, moduleItem)
        ) {
          return {
            success: false,
            errorMsg: "CHARGE_REQUIRED",
          };
        }
        const weaponTimerPreflight = recordCommandBurstWeaponTimer(
          this,
          entity,
          now,
          { dryRun: true },
        );
        if (!weaponTimerPreflight || weaponTimerPreflight.success !== true) {
          return {
            success: false,
            errorMsg:
              weaponTimerPreflight && weaponTimerPreflight.errorMsg ||
              "COMMAND_BURST_WEAPON_TIMER_FAILED",
          };
        }
      }
    }
    if (
      !weaponSnapshot &&
      !(miningActivation && miningActivation.success === true) &&
      !(commandBurstActivation && commandBurstActivation.matched === true)
    ) {
      assistanceActivation = assistanceModuleRuntime.resolveAssistanceModuleActivation({
        scene: this,
        entity,
        moduleItem,
        effectRecord,
        chargeItem,
        shipItem: shipRecord,
        skillMap,
        fittedItems,
        activeModuleContexts,
        additionalDirectModifierEntries:
          resolveModuleSnapshotDirectModifierEntries(entity, moduleItem, {
            nowMs: now,
            collectModifierEntriesForItem:
              commandBurstRuntime.collectModifierEntriesForItem,
          }),
        options,
        callbacks: buildAssistanceModuleRuntimeCallbacks(this),
      });
      if (assistanceActivation && assistanceActivation.matched === true) {
        if (assistanceActivation.success !== true) {
          return {
            success: false,
            errorMsg: assistanceActivation.errorMsg || "UNSUPPORTED_MODULE",
          };
        }
        targetEntity = assistanceActivation.data && assistanceActivation.data.targetEntity
          ? assistanceActivation.data.targetEntity
          : targetEntity;
      }
    }
    if (
      !weaponSnapshot &&
      !(miningActivation && miningActivation.success === true) &&
      !(commandBurstActivation && commandBurstActivation.matched === true) &&
      !(assistanceActivation && assistanceActivation.matched === true)
    ) {
      jammerModuleActivation = jammerModuleRuntime.resolveJammerModuleActivation({
        scene: this,
        entity,
        moduleItem,
        effectRecord,
        chargeItem,
        shipItem: shipRecord,
        skillMap,
        fittedItems,
        activeModuleContexts,
        additionalDirectModifierEntries:
          resolveModuleSnapshotDirectModifierEntries(entity, moduleItem, {
            nowMs: now,
            collectModifierEntriesForItem:
              commandBurstRuntime.collectModifierEntriesForItem,
          }),
        options,
        callbacks: buildJammerModuleRuntimeCallbacks(this),
      });
      if (jammerModuleActivation && jammerModuleActivation.matched === true) {
        if (jammerModuleActivation.success !== true) {
          return {
            success: false,
            errorMsg: jammerModuleActivation.errorMsg || "UNSUPPORTED_MODULE",
          };
        }
        targetEntity = jammerModuleActivation.data && jammerModuleActivation.data.targetEntity
          ? jammerModuleActivation.data.targetEntity
          : targetEntity;
      }
    }
    if (
      !weaponSnapshot &&
      !(miningActivation && miningActivation.success === true) &&
      !(commandBurstActivation && commandBurstActivation.matched === true) &&
      !(assistanceActivation && assistanceActivation.matched === true) &&
      !(jammerModuleActivation && jammerModuleActivation.matched === true)
    ) {
      hostileModuleActivation = hostileModuleRuntime.resolveHostileModuleActivation({
        scene: this,
        entity,
        moduleItem,
        effectRecord,
        chargeItem,
        shipItem: shipRecord,
        skillMap,
        fittedItems,
        activeModuleContexts,
        additionalDirectModifierEntries:
          resolveModuleSnapshotDirectModifierEntries(entity, moduleItem, {
            nowMs: now,
            collectModifierEntriesForItem:
              commandBurstRuntime.collectModifierEntriesForItem,
          }),
        options,
        callbacks: buildHostileModuleRuntimeCallbacks(this),
      });
      if (hostileModuleActivation && hostileModuleActivation.matched === true) {
        if (hostileModuleActivation.success !== true) {
          return {
            success: false,
            errorMsg: hostileModuleActivation.errorMsg || "UNSUPPORTED_MODULE",
          };
        }
        targetEntity = hostileModuleActivation.data && hostileModuleActivation.data.targetEntity
          ? hostileModuleActivation.data.targetEntity
          : targetEntity;
      }
    }
    if (
      !weaponSnapshot &&
      !(miningActivation && miningActivation.success === true) &&
      !(commandBurstActivation && commandBurstActivation.matched === true) &&
      !(assistanceActivation && assistanceActivation.matched === true) &&
      !(jammerModuleActivation && jammerModuleActivation.matched === true) &&
      !(hostileModuleActivation && hostileModuleActivation.matched === true)
    ) {
      smartbombActivation = smartbombRuntime.resolveSmartbombActivation({
        entity,
        moduleItem,
        effectRecord,
        chargeItem,
        shipItem: shipRecord,
        skillMap,
        fittedItems,
        activeModuleContexts,
        additionalLocationModifierSources: isStructureDogmaHost(shipRecord)
          ? []
          : collectEntityWormholeLocationModifierSources(entity),
      });
      if (smartbombActivation && smartbombActivation.matched === true) {
        if (smartbombActivation.success !== true) {
          return {
            success: false,
            errorMsg: smartbombActivation.errorMsg || "UNSUPPORTED_MODULE",
          };
        }
      }
    }
    if (
      !weaponSnapshot &&
      !(miningActivation && miningActivation.success === true) &&
      !(commandBurstActivation && commandBurstActivation.matched === true) &&
      !(assistanceActivation && assistanceActivation.matched === true) &&
      !(jammerModuleActivation && jammerModuleActivation.matched === true) &&
      !(hostileModuleActivation && hostileModuleActivation.matched === true) &&
      !(smartbombActivation && smartbombActivation.matched === true)
    ) {
      targetingModuleActivation = targetingModuleRuntime.resolveTargetingModuleActivation({
        entity,
        moduleItem,
        effectRecord,
        shipItem: shipRecord,
        skillMap,
        fittedItems,
        activeModuleContexts,
        targetID: resolvedTargetID,
        additionalLocationModifierSources: isStructureDogmaHost(shipRecord)
          ? []
          : collectEntityWormholeLocationModifierSources(entity),
      });
      if (targetingModuleActivation && targetingModuleActivation.matched === true) {
        if (targetingModuleActivation.success !== true) {
          return {
            success: false,
            errorMsg: targetingModuleActivation.errorMsg || "UNSUPPORTED_MODULE",
          };
        }
      }
    }
    if (
      !weaponSnapshot &&
      !(miningActivation && miningActivation.success === true) &&
      !(commandBurstActivation && commandBurstActivation.matched === true) &&
      !(assistanceActivation && assistanceActivation.matched === true) &&
      !(jammerModuleActivation && jammerModuleActivation.matched === true) &&
      !(hostileModuleActivation && hostileModuleActivation.matched === true) &&
      !(smartbombActivation && smartbombActivation.matched === true) &&
      !(targetingModuleActivation && targetingModuleActivation.matched === true)
    ) {
      pointDefenseActivation = pointDefenseRuntime.resolvePointDefenseActivation({
        scene: this,
        entity,
        moduleItem,
        effectRecord,
        chargeItem,
        shipItem: shipRecord,
        skillMap,
        fittedItems,
        activeModuleContexts,
      });
      if (pointDefenseActivation && pointDefenseActivation.matched === true) {
        if (pointDefenseActivation.success !== true) {
          return {
            success: false,
            errorMsg: pointDefenseActivation.errorMsg || "UNSUPPORTED_MODULE",
          };
        }
      }
    }
    if (
      !weaponSnapshot &&
      !(miningActivation && miningActivation.success === true) &&
      !(commandBurstActivation && commandBurstActivation.matched === true) &&
      !(assistanceActivation && assistanceActivation.matched === true) &&
      !(jammerModuleActivation && jammerModuleActivation.matched === true) &&
      !(hostileModuleActivation && hostileModuleActivation.matched === true) &&
      !(smartbombActivation && smartbombActivation.matched === true) &&
      !(targetingModuleActivation && targetingModuleActivation.matched === true) &&
      !(pointDefenseActivation && pointDefenseActivation.matched === true)
    ) {
      tractorBeamActivation = tractorBeamRuntime.resolveTractorBeamActivation({
        scene: this,
        entity,
        moduleItem,
        effectRecord,
        chargeItem,
        shipItem: shipRecord,
        skillMap,
        fittedItems,
        activeModuleContexts,
        options,
        callbacks: buildTractorBeamRuntimeCallbacks(this),
      });
      if (tractorBeamActivation && tractorBeamActivation.matched === true) {
        if (tractorBeamActivation.success !== true) {
          return {
            success: false,
            errorMsg: tractorBeamActivation.errorMsg || "UNSUPPORTED_MODULE",
          };
        }
        targetEntity = tractorBeamActivation.data && tractorBeamActivation.data.targetEntity
          ? tractorBeamActivation.data.targetEntity
          : targetEntity;
      }
    }
    if (
      !weaponSnapshot &&
      !(miningActivation && miningActivation.success === true) &&
      !(commandBurstActivation && commandBurstActivation.matched === true) &&
      !(assistanceActivation && assistanceActivation.matched === true) &&
      !(jammerModuleActivation && jammerModuleActivation.matched === true) &&
      !(hostileModuleActivation && hostileModuleActivation.matched === true) &&
      !(smartbombActivation && smartbombActivation.matched === true) &&
      !(targetingModuleActivation && targetingModuleActivation.matched === true) &&
      !(pointDefenseActivation && pointDefenseActivation.matched === true) &&
      !(tractorBeamActivation && tractorBeamActivation.matched === true)
    ) {
      salvagerActivation = salvagerRuntime.resolveSalvagerActivation({
        scene: this,
        entity,
        moduleItem,
        effectRecord,
        chargeItem,
        shipItem: shipRecord,
        skillMap,
        fittedItems,
        activeModuleContexts,
        additionalDirectModifierEntries:
          resolveModuleSnapshotDirectModifierEntries(entity, moduleItem, {
            nowMs: now,
            collectModifierEntriesForItem:
              commandBurstRuntime.collectModifierEntriesForItem,
          }),
        options,
        callbacks: buildSalvagerRuntimeCallbacks(this),
      });
      if (salvagerActivation && salvagerActivation.matched === true) {
        if (salvagerActivation.success !== true) {
          return {
            success: false,
            errorMsg: salvagerActivation.errorMsg || "UNSUPPORTED_MODULE",
          };
        }
        targetEntity = salvagerActivation.data && salvagerActivation.data.targetEntity
          ? salvagerActivation.data.targetEntity
          : targetEntity;
      }
    }
    if (
      !weaponSnapshot &&
      !(miningActivation && miningActivation.success === true) &&
      !(commandBurstActivation && commandBurstActivation.matched === true) &&
      !(assistanceActivation && assistanceActivation.matched === true) &&
      !(jammerModuleActivation && jammerModuleActivation.matched === true) &&
      !(hostileModuleActivation && hostileModuleActivation.matched === true) &&
      !(smartbombActivation && smartbombActivation.matched === true) &&
      !(targetingModuleActivation && targetingModuleActivation.matched === true) &&
      !(pointDefenseActivation && pointDefenseActivation.matched === true) &&
      !(tractorBeamActivation && tractorBeamActivation.matched === true) &&
      !(salvagerActivation && salvagerActivation.matched === true)
    ) {
      microJumpDriveActivation = microJumpDriveRuntime.resolveMicroJumpDriveActivation({
        entity,
        moduleItem,
        effectRecord,
        chargeItem,
        shipItem: shipRecord,
        skillMap,
        fittedItems,
        activeModuleContexts,
        callbacks: buildMicroJumpDriveRuntimeCallbacks(this),
      });
      if (microJumpDriveActivation && microJumpDriveActivation.matched === true) {
        if (microJumpDriveActivation.success !== true) {
          return {
            success: false,
            errorMsg: microJumpDriveActivation.errorMsg || "UNSUPPORTED_MODULE",
          };
        }
        if (isShipMovementLockedByRuntime(entity, now)) {
          return {
            success: false,
            errorMsg: "SHIP_IMMOBILE",
          };
        }
        if (isEntityMicroJumpDriveBlocked(entity, now)) {
          return {
            success: false,
            errorMsg: "MICRO_JUMP_DRIVE_BLOCKED",
          };
        }
      }
    }
    const runtimeAttrs =
      miningActivation && miningActivation.success === true
        ? miningActivation.data.runtimeAttrs
        : commandBurstActivation && commandBurstActivation.success === true
          ? commandBurstActivation.data.runtimeAttrs
          : assistanceActivation && assistanceActivation.success === true
            ? assistanceActivation.data.runtimeAttrs
            : jammerModuleActivation && jammerModuleActivation.success === true
              ? jammerModuleActivation.data.runtimeAttrs
            : hostileModuleActivation && hostileModuleActivation.success === true
              ? hostileModuleActivation.data.runtimeAttrs
            : smartbombActivation && smartbombActivation.success === true
              ? smartbombActivation.data.runtimeAttrs
            : targetingModuleActivation && targetingModuleActivation.success === true
              ? targetingModuleActivation.data.runtimeAttrs
            : pointDefenseActivation && pointDefenseActivation.success === true
              ? pointDefenseActivation.data.runtimeAttrs
            : tractorBeamActivation && tractorBeamActivation.success === true
              ? tractorBeamActivation.data.runtimeAttrs
            : salvagerActivation && salvagerActivation.success === true
              ? salvagerActivation.data.runtimeAttrs
              : microJumpDriveActivation && microJumpDriveActivation.success === true
                ? microJumpDriveActivation.data.runtimeAttrs
        : getGenericModuleRuntimeAttributes(
          getShipEntityInventoryCharacterID(entity, toInt(session && session.characterID, 0)),
          shipRecord,
          effectiveModuleItem,
          chargeItem,
          weaponSnapshot,
          {
            skillMap,
            fittedItems,
            activeModuleContexts,
            additionalLocationModifierSources: isStructureDogmaHost(shipRecord)
              ? []
              : collectEntityWormholeLocationModifierSources(entity),
            additionalDirectModifierEntries:
              resolveModuleSnapshotDirectModifierEntries(
                entity,
                effectiveModuleItem,
                {
                  nowMs: now,
                  collectModifierEntriesForItem:
                    commandBurstRuntime.collectModifierEntriesForItem,
                },
              ),
          },
        );
    if (!runtimeAttrs) {
      return { success: false, errorMsg: "UNSUPPORTED_MODULE" };
    }
    const localCycleCallbacks = buildLocalCycleRuntimeCallbacks(
      toInt(session && session.characterID, 0),
    );
    const superweaponCallbacks = buildSuperweaponRuntimeCallbacks(
      this,
      toInt(session && session.characterID, 0),
    );
    const localCycleActivation = prepareLocalCycleActivation({
      entity,
      shipItem: shipRecord,
      moduleItem,
      effectRecord,
      chargeItem,
      callbacks: localCycleCallbacks,
      baseRuntimeAttributes: runtimeAttrs,
      nowMs: now,
    });
    if (localCycleActivation.matched === true && localCycleActivation.success !== true) {
      return {
        success: false,
        errorMsg: localCycleActivation.errorMsg || "UNSUPPORTED_MODULE",
      };
    }
    const effectiveRuntimeAttrs =
      localCycleActivation.matched === true &&
      localCycleActivation.success === true &&
      localCycleActivation.runtimeAttributes
        ? localCycleActivation.runtimeAttributes
        : runtimeAttrs;
    const superweaponActivation = prepareSuperweaponActivation({
      scene: this,
      session,
      entity,
      shipItem: shipRecord,
      moduleItem,
      effectRecord,
      chargeItem,
      callbacks: superweaponCallbacks,
      baseRuntimeAttributes: effectiveRuntimeAttrs,
      options,
      nowMs: now,
    });
    if (superweaponActivation.matched === true && superweaponActivation.success !== true) {
      return {
        success: false,
        errorMsg: superweaponActivation.errorMsg || "UNSUPPORTED_MODULE",
      };
    }
    if (superweaponActivation.targetEntity) {
      targetEntity = superweaponActivation.targetEntity;
    }
    const finalRuntimeAttrsBase =
      superweaponActivation.matched === true &&
      superweaponActivation.success === true &&
      superweaponActivation.runtimeAttributes
        ? superweaponActivation.runtimeAttributes
        : effectiveRuntimeAttrs;
    const superweaponEffectStatePatch =
      superweaponActivation.matched === true &&
      superweaponActivation.success === true &&
      superweaponActivation.effectStatePatch &&
      typeof superweaponActivation.effectStatePatch === "object"
        ? superweaponActivation.effectStatePatch
        : null;
    // Upwell structures have immutable green safety. Structure superweapons
    // pure-filter targets inside their own activation/tick pipeline and never
    // create Crimewatch consequences for the controlling capsuleer.
    const immutableGreenStructureOffense = Boolean(
      superweaponEffectStatePatch &&
      superweaponEffectStatePatch.superweaponStructureDoomsday === true,
    );
    const finalRuntimeAttrsUnscaled = superweaponEffectStatePatch
      ? {
        ...finalRuntimeAttrsBase,
        capNeed: roundNumber(
          toFiniteNumber(
            superweaponEffectStatePatch.capNeed,
            finalRuntimeAttrsBase.capNeed,
          ),
          6,
        ),
        fuelTypeID: Math.max(
          0,
          toInt(finalRuntimeAttrsBase.fuelTypeID, 0),
        ),
        fuelPerActivation: roundModuleFuelQuantity(
          finalRuntimeAttrsBase.fuelPerActivation,
        ),
      }
      : finalRuntimeAttrsBase;
    const finalWeaponFamily =
      weaponSnapshot && weaponSnapshot.family
        ? weaponSnapshot.family
        : weaponFamily;
    const turretActivationBankContext =
      isTurretCycleWeaponFamily(finalWeaponFamily)
        ? resolveGroupedWeaponBankContext(entity, null, moduleItem, {
          family: finalWeaponFamily,
        })
        : null;
    const turretActivationBankModuleIDs =
      turretActivationBankContext &&
      Array.isArray(turretActivationBankContext.launchModuleIDs)
        ? turretActivationBankContext.launchModuleIDs
            .map((moduleID) => toInt(moduleID, 0))
            .filter((moduleID) => moduleID > 0)
        : [];
    const turretActivationBankSize = Math.max(
      1,
      turretActivationBankModuleIDs.length,
    );
    const finalRuntimeAttrs =
      turretActivationBankSize > 1 &&
      toFiniteNumber(finalRuntimeAttrsUnscaled.capNeed, 0) > 0
        ? {
          ...finalRuntimeAttrsUnscaled,
          capNeed: roundNumber(
            toFiniteNumber(finalRuntimeAttrsUnscaled.capNeed, 0) *
              turretActivationBankSize,
            6,
          ),
        }
        : finalRuntimeAttrsUnscaled;

    const offensiveActivation =
      (bombActivation && bombActivation.success === true) ||
      (
        superweaponActivation.matched === true &&
        superweaponActivation.success === true &&
        superweaponActivation.offensiveActivation === true
      ) ||
      (
        smartbombActivation &&
        smartbombActivation.success === true &&
        smartbombActivation.data &&
        smartbombActivation.data.offensiveActivation === true
      ) ||
      (
        pointDefenseActivation &&
        pointDefenseActivation.success === true &&
        pointDefenseActivation.data &&
        pointDefenseActivation.data.offensiveActivation === true
      ) ||
      (
        jammerModuleActivation &&
        jammerModuleActivation.success === true &&
        jammerModuleActivation.data &&
        jammerModuleActivation.data.offensiveActivation === true
      ) ||
      targetEntity &&
      (
        isOffensiveWeaponFamily(
          weaponSnapshot && weaponSnapshot.family
            ? weaponSnapshot.family
            : weaponFamily,
        ) ||
        (weaponFamily !== "festivalLauncher" && effectRecord.isOffensive === true)
      );
    const sovereigntyEntosisActivation = Boolean(
      entosisLinkActivation &&
      entosisLinkActivation.matched === true &&
      entosisLinkActivation.success === true &&
      entosisLinkActivation.effectStatePatch &&
      entosisLinkActivation.effectStatePatch.entosisCaptureEnabled === true
    );
    // Retail refuses docking and tethering while an Entosis Link runs. Effect
    // 6063 ships with an empty modifierInfo, so, like the cynosural family
    // below, the restriction is stated here rather than read off a ship-domain
    // modifier. It holds for every link, including one that scores nothing.
    const entosisLinkCommitsShip = Boolean(
      entosisLinkActivation &&
      entosisLinkActivation.matched === true &&
      entosisLinkActivation.success === true
    );
    if (targetEntity && structureTethering.isEntityStructureTethered(targetEntity)) {
      return { success: false, errorMsg: "TARGET_TETHERED" };
    }
    if (
      (offensiveActivation || sovereigntyEntosisActivation) &&
      isEntityOffensiveActivationDisallowed(entity)
    ) {
      return { success: false, errorMsg: "OFFENSIVE_ACT_DISALLOWED" };
    }
    if (sovereigntyEntosisActivation) {
      const weaponTimerPreflight = recordEntosisWeaponTimer(
        this,
        entity,
        now,
        { dryRun: true },
      );
      if (!weaponTimerPreflight || weaponTimerPreflight.success !== true) {
        return {
          success: false,
          errorMsg:
            weaponTimerPreflight && weaponTimerPreflight.errorMsg ||
            "ENTOSIS_WEAPON_TIMER_FAILED",
        };
      }
    }
    const isSmartbombActivation = Boolean(
      smartbombActivation &&
      smartbombActivation.matched === true &&
      smartbombActivation.success === true,
    );
    const smartbombEmpireSafetyEvaluation = isSmartbombActivation
      ? evaluateEmpireUntargetedOffensiveActivation(this, entity)
      : null;
    if (
      smartbombEmpireSafetyEvaluation &&
      smartbombEmpireSafetyEvaluation.success !== true
    ) {
      return {
        success: false,
        errorMsg:
          smartbombEmpireSafetyEvaluation.errorMsg || "SafetyActivated",
        data: smartbombEmpireSafetyEvaluation.data || undefined,
      };
    }
    const crimewatchAggressionEvaluation =
      offensiveActivation && targetEntity && !immutableGreenStructureOffense
        ? evaluateCrimewatchOffensiveAggression(
          this,
          entity,
          targetEntity,
          now,
        )
        : null;
    if (
      crimewatchAggressionEvaluation &&
      crimewatchAggressionEvaluation.success !== true
    ) {
      return {
        success: false,
        errorMsg:
          crimewatchAggressionEvaluation.errorMsg || "SafetyActivated",
        data: crimewatchAggressionEvaluation.data || undefined,
      };
    }

    if (finalRuntimeAttrs.maxGroupActive > 0) {
      let activeCount = 0;
      for (const es of entity.activeModuleEffects.values()) {
        if (toInt(es.groupID, 0) === toInt(moduleItem.groupID, 0)) {
          activeCount += 1;
        }
      }
      if (activeCount >= finalRuntimeAttrs.maxGroupActive) {
        return { success: false, errorMsg: "MAX_GROUP_ACTIVE" };
      }
    }

    if (isCynosuralActivation) {
      const inhibitorConflict = mobileCynoInhibitorRuntime.findActiveInhibitorConflict(
        this.systemID,
        entity.position,
        {
          scene: this,
          fieldTypeID: resolveCynosuralFieldTypeID(moduleItem),
          nowMs: now,
          targetEntity: entity,
        },
      );
      if (inhibitorConflict) {
        return { success: false, errorMsg: "CYNOSURAL_FIELD_INHIBITED" };
      }
    }

    const previousChargeAmount = getEntityCapacitorAmount(entity);
    if (finalRuntimeAttrs.capNeed > previousChargeAmount + 1e-6) {
      return { success: false, errorMsg: "NOT_ENOUGH_CAPACITOR" };
    }

    // Fuel custody is the last fallible activation prerequisite. Commit it as
    // one inventory mutation before Crimewatch, but defer client sync until the
    // consequence succeeds. If Crimewatch refuses its durable boundary, restore
    // the exact fuel rows before returning. Tether/cap/ammo/effect state remain
    // untouched throughout either failure path.
    const dedicatedSuperweaponFuelTypeID = Math.max(
      0,
      toInt(
        superweaponEffectStatePatch &&
          superweaponEffectStatePatch.superweaponFuelTypeID,
        0,
      ),
    );
    const dedicatedSuperweaponFuelPerActivation = Math.max(
      0,
      toInt(
        superweaponEffectStatePatch &&
          superweaponEffectStatePatch.superweaponFuelPerActivation,
        0,
      ),
    );
    const usesDedicatedSuperweaponFuel =
      superweaponActivation.matched === true &&
      superweaponActivation.success === true &&
      dedicatedSuperweaponFuelTypeID > 0 &&
      dedicatedSuperweaponFuelPerActivation > 0;
    const initialFuelConsumptionResult = consumeShipModuleFuelForSession(
      session,
      entity,
      usesDedicatedSuperweaponFuel
        ? dedicatedSuperweaponFuelTypeID
        : finalRuntimeAttrs.fuelTypeID,
      usesDedicatedSuperweaponFuel
        ? dedicatedSuperweaponFuelPerActivation
        : finalRuntimeAttrs.fuelPerActivation,
      { deferSync: true },
    );
    if (!initialFuelConsumptionResult.success) {
      return {
        success: false,
        errorMsg: initialFuelConsumptionResult.errorMsg || "NO_FUEL",
      };
    }
    let entosisWarmupEffectState = null;
    if (sovereigntyEntosisActivation) {
      entosisWarmupEffectState = {
        moduleID: normalizedModuleID,
        targetID: resolvedTargetID,
        ...entosisLinkActivation.effectStatePatch,
      };
      const warmupResult = entosisLinkRuntime.registerEntosisLinkWarmup({
        scene: this,
        entity,
        effectState: entosisWarmupEffectState,
        nowMs: now,
      });
      if (!warmupResult || warmupResult.success !== true) {
        const fuelRollback = rollbackShipModuleFuelConsumption(
          entity,
          initialFuelConsumptionResult,
        );
        if (!fuelRollback || fuelRollback.success !== true) {
          return { success: false, errorMsg: "FUEL_ROLLBACK_FAILED" };
        }
        return {
          success: false,
          errorMsg:
            warmupResult && warmupResult.errorMsg || "ENTOSIS_WARMUP_FAILED",
        };
      }
      const weaponTimerResult = recordEntosisWeaponTimer(this, entity, now);
      if (!weaponTimerResult || weaponTimerResult.success !== true) {
        entosisLinkRuntime.stopEntosisLinkCapture({
          scene: this,
          effectState: entosisWarmupEffectState,
          nowMs: now,
        });
        const fuelRollback = rollbackShipModuleFuelConsumption(
          entity,
          initialFuelConsumptionResult,
        );
        if (!fuelRollback || fuelRollback.success !== true) {
          return { success: false, errorMsg: "FUEL_ROLLBACK_FAILED" };
        }
        return {
          success: false,
          errorMsg:
            weaponTimerResult && weaponTimerResult.errorMsg ||
            "ENTOSIS_WEAPON_TIMER_FAILED",
        };
      }
    }
    let crimewatchCommit = null;
    if (offensiveActivation && targetEntity && !immutableGreenStructureOffense) {
      crimewatchCommit = recordCrimewatchOffensiveAggression(
        this,
        entity,
        targetEntity,
        now,
      );
      if (!crimewatchCommit || crimewatchCommit.success !== true) {
        const fuelRollback = rollbackShipModuleFuelConsumption(
          entity,
          initialFuelConsumptionResult,
        );
        if (!fuelRollback || fuelRollback.success !== true) {
          log.error(
            `[SpaceRuntime] Failed to compensate module fuel after Crimewatch refusal ` +
            `ship=${entity.itemID} module=${normalizedModuleID} error=${
              fuelRollback && fuelRollback.errorMsg || "UNKNOWN_ERROR"
            }`,
          );
          return {
            success: false,
            errorMsg: "FUEL_ROLLBACK_FAILED",
          };
        }
        return {
          success: false,
          errorMsg:
            crimewatchCommit && crimewatchCommit.errorMsg ||
            "CRIMEWATCH_AGGRESSION_FAILED",
        };
      }
    }
    if (session) {
      syncInventoryChangesToSession(
        session,
        initialFuelConsumptionResult.changes,
      );
    }
    if (
      sovereigntyEntosisActivation ||
      (
        offensiveActivation &&
        superweaponActivation.matched !== true
      )
    ) {
      breakEntityStructureTether(this, entity, {
        nowMs: now,
        reason: sovereigntyEntosisActivation
          ? "ENTOSIS_ACTIVATION"
          : "OFFENSIVE_ACTIVATION",
      });
    }
    if (!consumeEntityCapacitor(entity, finalRuntimeAttrs.capNeed)) {
      return { success: false, errorMsg: "NOT_ENOUGH_CAPACITOR" };
    }
    notifyCapacitorChangeToSession(session, entity, now, previousChargeAmount);

    const activeShipModifierEntries = [];
    appendDirectModifierEntries(
      activeShipModifierEntries,
      buildEffectiveItemAttributeMap(effectiveModuleItem, chargeItem),
      [effectRecord],
      "fittedModule",
    );
    const npcPrecursorSpoolPerCycleOverride = Number(
      effectiveModuleItem && effectiveModuleItem.npcPrecursorSpoolPerCycle,
    );
    const npcPrecursorSpoolMaxOverride = Number(
      effectiveModuleItem && effectiveModuleItem.npcPrecursorSpoolMax,
    );

    let cloakActivationDeactivationResult = null;
    const effectState = {
      moduleID: normalizedModuleID,
      moduleFlagID: toInt(moduleItem.flagID, 0),
      effectName: effectRecord.name,
      effectID: toInt(effectRecord.effectID, 0),
      effectCategoryID: toInt(effectRecord.effectCategoryID, 0),
      effectRecord: effectRecord && typeof effectRecord === "object"
        ? { ...effectRecord }
        : null,
      guid: resolveGenericModuleSpecialFxGuid(effectRecord, {
        weaponSnapshot,
        weaponFamily,
        moduleItem: effectiveModuleItem,
        chargeItem,
      }),
      groupID: toInt(moduleItem.groupID, 0),
      typeID: toInt(moduleItem.typeID, 0),
      moduleItemSnapshot:
        effectiveModuleItem && typeof effectiveModuleItem === "object"
          ? { ...effectiveModuleItem }
          : null,
      startedAtMs: now,
      durationMs: finalRuntimeAttrs.durationMs,
      durationAttributeID: finalRuntimeAttrs.durationAttributeID,
      nextCycleAtMs: now + finalRuntimeAttrs.durationMs,
      capNeed: finalRuntimeAttrs.capNeed,
      fuelTypeID: Math.max(0, toInt(finalRuntimeAttrs.fuelTypeID, 0)),
      fuelPerActivation: Math.max(0, toInt(finalRuntimeAttrs.fuelPerActivation, 0)),
      reactivationDelayMs: finalRuntimeAttrs.reactivationDelayMs,
      repeat: isCynosuralActivation
        ? 1
        : normalizeEffectRepeatCount(options.repeat, null),
      remainingCycles: isCynosuralActivation
        ? null
        : resolveModuleRemainingCyclesForActivation(options.repeat, effectiveModuleItem),
      targetID: targetEntity ? resolvedTargetID : 0,
      ...(entosisLinkActivation && entosisLinkActivation.matched === true
        ? entosisLinkActivation.effectStatePatch
        : null),
      ...(entosisWarmupEffectState && entosisWarmupEffectState.entosisWarmupRegisteredAtMs
        ? {
          entosisWarmupRegisteredAtMs:
            entosisWarmupEffectState.entosisWarmupRegisteredAtMs,
        }
        : null),
      ...(scannerActivation && scannerActivation.matched === true &&
        scannerActivation.success === true
        ? scannerActivation.effectStatePatch
        : null),
      chargeTypeID: toInt(
        (chargeItem && chargeItem.typeID) ||
          (weaponSnapshot && weaponSnapshot.chargeTypeID) ||
          (
            runtimeAttrs.miningSnapshot &&
            runtimeAttrs.miningSnapshot.chargeTypeID
          ),
        0,
      ),
      weaponFamily:
        weaponSnapshot && weaponSnapshot.family
          ? weaponSnapshot.family
          : null,
      autoTargetingMissileEffect: Boolean(
        weaponSnapshot &&
        isMissileWeaponFamily(weaponSnapshot.family) &&
        isAutoTargetingMissileCharge(chargeItem)
      ),
      autoTargetingMissileHostilePackKey:
        weaponSnapshot &&
        isMissileWeaponFamily(weaponSnapshot.family) &&
        isAutoTargetingMissileCharge(chargeItem)
          ? resolveAutoTargetingMissileNpcPackKey(targetEntity) || null
          : null,
      bankModuleIDs:
        isTurretCycleWeaponFamily(finalWeaponFamily)
          ? (
            turretActivationBankModuleIDs.length > 0
              ? turretActivationBankModuleIDs
              : resolveGroupedTurretBankModuleIDs(
                entity,
                normalizedModuleID,
                toInt(moduleItem.typeID, 0),
              )
          )
          : null,
      miningEffect: Boolean(miningActivation && miningActivation.success === true),
      salvagerEffect: Boolean(salvagerActivation && salvagerActivation.success === true),
      cloakModuleEffect: isCloakingActivation,
      bastionModuleEffect: isBastionActivation,
      cynosuralGeneration: isCynosuralActivation,
      cynosuralFleetID: isCynosuralActivation ? toInt(session && session.fleetid, 0) : 0,
      cynosuralCharacterID: isCynosuralActivation ? toInt(session && session.characterID, 0) : 0,
      cynosuralSolarSystemID: isCynosuralActivation ? toInt(this.systemID, 0) : 0,
      autoDeactivateAtCycleEnd: isCynosuralActivation,
      deactivationRequestedAtMs: 0,
      deactivateAtMs: 0,
      stopReason: null,
      isGeneric: true,
      genericAttributeOverrides:
        finalRuntimeAttrs &&
        finalRuntimeAttrs.attributeOverrides &&
        typeof finalRuntimeAttrs.attributeOverrides === "object"
          ? {
            ...finalRuntimeAttrs.attributeOverrides,
          }
          : null,
      ...(Number.isFinite(npcPrecursorSpoolPerCycleOverride)
        ? {
          precursorSpoolPerCycleOverride: Math.max(
            0,
            npcPrecursorSpoolPerCycleOverride,
          ),
        }
        : {}),
      ...(Number.isFinite(npcPrecursorSpoolMaxOverride)
        ? {
          precursorSpoolMaxOverride: Math.max(0, npcPrecursorSpoolMaxOverride),
        }
        : {}),
      // A module whose activation rewrites its own attributes still changes the
      // ship, indirectly: its always-on effects project those attributes onto
      // the hull. Counting only the ship-domain modifiers left the Assault
      // Damage Control's whole active half unpublished.
      affectsShipDerivedState:
        activeShipModifierEntries.length > 0 ||
        effectRecordSelfModifiesProjectedAttributes(effectRecord, effectiveModuleItem),
      immobilizesShip: shipModifierEntriesImmobilizeShip(activeShipModifierEntries),
      disallowsDocking: shipModifierEntriesSetPositiveAttribute(
        activeShipModifierEntries,
        ATTRIBUTE_DISALLOW_DOCKING,
      ) || cynosuralModuleTypeDeclaresShipRestriction(
        isCynosuralActivation,
        effectiveModuleItem,
        ATTRIBUTE_DISALLOW_DOCKING,
      ) || entosisLinkCommitsShip,
      disallowsTethering: shipModifierEntriesSetPositiveAttribute(
        activeShipModifierEntries,
        ATTRIBUTE_DISALLOW_TETHERING,
      ) || cynosuralModuleTypeDeclaresShipRestriction(
        isCynosuralActivation,
        effectiveModuleItem,
        ATTRIBUTE_DISALLOW_TETHERING,
      ) || entosisLinkCommitsShip,
      ...(localCycleActivation.matched === true && localCycleActivation.success === true
        ? localCycleActivation.effectStatePatch
        : {}),
      ...(commandBurstActivation && commandBurstActivation.matched === true &&
        commandBurstActivation.success === true
        ? commandBurstActivation.data.effectStatePatch
        : {}),
      ...(assistanceActivation && assistanceActivation.matched === true &&
        assistanceActivation.success === true
        ? assistanceActivation.data.effectStatePatch
        : {}),
      ...(jammerModuleActivation && jammerModuleActivation.matched === true &&
        jammerModuleActivation.success === true
        ? jammerModuleActivation.data.effectStatePatch
        : {}),
      ...(hostileModuleActivation && hostileModuleActivation.matched === true &&
        hostileModuleActivation.success === true
        ? hostileModuleActivation.data.effectStatePatch
        : {}),
      ...(smartbombActivation && smartbombActivation.matched === true &&
        smartbombActivation.success === true
        ? smartbombActivation.data.effectStatePatch
        : {}),
      ...(bombActivation && bombActivation.success === true ? {
        bombLauncherEffect: true, bombSnapshot: weaponSnapshot,
        autoDeactivateAtCycleEnd: true, suppressStopSpecialFx: true,
        guid: "effects.MissileDeployment",
      } : {}),
      ...(defenderActivation && defenderActivation.success === true ? {
        defenderLauncherEffect: true, defenderSnapshot: weaponSnapshot,
        autoDeactivateAtCycleEnd: true, suppressStopSpecialFx: true,
        guid: "effects.MissileDeployment",
      } : {}),
      ...(targetingModuleActivation && targetingModuleActivation.matched === true &&
        targetingModuleActivation.success === true
        ? targetingModuleActivation.data.effectStatePatch
        : {}),
      ...(pointDefenseActivation && pointDefenseActivation.matched === true &&
        pointDefenseActivation.success === true
        ? pointDefenseActivation.data.effectStatePatch
        : {}),
      ...(tractorBeamActivation && tractorBeamActivation.matched === true &&
        tractorBeamActivation.success === true
        ? tractorBeamActivation.data.effectStatePatch
        : {}),
      ...(salvagerActivation && salvagerActivation.matched === true &&
        salvagerActivation.success === true
        ? salvagerActivation.data.effectStatePatch
        : {}),
      ...(microJumpDriveActivation && microJumpDriveActivation.matched === true &&
        microJumpDriveActivation.success === true
        ? microJumpDriveActivation.data.effectStatePatch
        : {}),
      ...(superweaponActivation.matched === true && superweaponActivation.success === true
        ? superweaponEffectStatePatch
        : {}),
      superweaponFuelPreconsumed: usesDedicatedSuperweaponFuel,
    };
    if (effectState.cloakModuleEffect === true) {
      effectState.durationMs = -1;
      effectState.nextCycleAtMs = Number.MAX_SAFE_INTEGER;
      effectState.repeat = 0;
    }
    if (isCloakingActivation) {
      cloakActivationDeactivationResult = this.deactivateAllActiveModules(session, {
        reason: "cloakActivation",
        nowMs: now,
        // A cloak stops further cycles; it does not end the cycle already
        // running. Stopping at once deleted each effect immediately, which
        // ended the MWD's burst the instant the cloak came up and made the
        // MWD-cloak manoeuvre impossible. Modules that may not be cut short at
        // all are still refused the cloak outright, above.
        deferUntilCycle: true,
        excludeModuleIDs: [normalizedModuleID],
      });
      if (!cloakActivationDeactivationResult.success) {
        return {
          success: false,
          errorMsg:
            cloakActivationDeactivationResult.errorMsg ||
            "ACTIVE_MODULE_DEACTIVATION_FAILED",
          data: cloakActivationDeactivationResult.data || null,
        };
      }
    }
    if (effectState.tractorBeamEffect === true) {
      effectState.lastTractorTickAtMs = now;
      effectState.lastTractorPersistAtMs = 0;
    }
    if (
      effectState.commandBurstEffect === true &&
      normalizeEffectRepeatCount(effectState.repeat, null) === 0
    ) {
      effectState.autoDeactivateAtCycleEnd = true;
      effectState.stopReason = effectState.stopReason || "cycle";
    }
    effectState.consequenceDelivery = resolveModuleConsequenceDelivery(effectState);
    if (isPrecursorTurretFamily(effectState.weaponFamily)) {
      initializePrecursorTurretEffectState(effectState, weaponSnapshot, now);
    }
    entity.activeModuleEffects.set(normalizedModuleID, effectState);
    if (offensiveActivation && targetEntity && !immutableGreenStructureOffense) {
      lazyRequire("../services/security/crimewatchState").beginModuleCombatActivity(
        this, entity, targetEntity, effectState, now, crimewatchCommit,
      );
    }
    // A Warp Disruption Field Generator switched on in sphere mode makes its
    // ship a sphere's source; the volume goes when the field does.
    if (
      Number(effectState.groupID) === warpDisruptFieldGeneratorRuntime.GROUP_WARP_DISRUPT_FIELD_GENERATOR &&
      !(Number(effectState.chargeTypeID) > 0) &&
      typeof this.getInterdictionVolumes === "function"
    ) {
      this.getInterdictionVolumes().addVolume(entity);
    }
    if (
      entosisLinkRuntime.isEntosisLinkEffectState(effectState) &&
      effectState.entosisCaptureEnabled === true
    ) {
      // Warmup registration creates the initial durable projection. Publish
      // it only after the module activation has committed so both observers
      // already on grid (OnSlimItemChange) and later entrants (AddBalls) see
      // the exact same entosis_score tuple.
      this.syncStructureEntitiesFromState();
    }
    if (
      effectState.bastionModuleEffect === true ||
      effectState.immobilizesShip === true
    ) {
      const immobilizerReason = effectState.bastionModuleEffect === true
        ? "bastion"
        : "moduleImmobilizer";
      forceDeactivateBlockedMovementEffects(this, entity, now, immobilizerReason, {
        blockAllPropulsion: true,
      });
      this.stopShipEntity(entity, {
        reason: immobilizerReason,
      });
    }
    if (effectState.cynosuralGeneration === true) {
      const cynoSpawnResult = spawnCynosuralFieldForEffect(
        this,
        session,
        entity,
        moduleItem,
        effectRecord,
        now,
        {
          durationMs: effectState.durationMs,
        },
      );
      if (!cynoSpawnResult.success) {
        entity.activeModuleEffects.delete(normalizedModuleID);
        return {
          success: false,
          errorMsg: cynoSpawnResult.errorMsg || "CYNOSURAL_FIELD_SPAWN_FAILED",
        };
      }
      const cynoData = cynoSpawnResult.data || null;
      if (cynoData && cynoData.fieldEntity) {
        effectState.cynosuralFieldEntityID = toInt(cynoData.fieldEntity.itemID, 0);
        effectState.cynosuralFieldTypeID = toInt(cynoData.fieldTypeID, 0);
        effectState.cynosuralFieldSpawnRadius = toFiniteNumber(
          cynoData.fieldEntity.cynosuralFieldSpawnRadius,
          0,
        );
      }
    }
    // "Burns out after a single use." The client's own effect does this the
    // moment the module starts — emergencyHullEnergizer.py Start() sets the
    // module's damage attribute to its hp before it even adds the modifiers —
    // so the burnout lands on activation and the cycle still runs its course.
    if (isEmergencyHullEnergizerEffect(effectRecord)) {
      burnOutModuleOnActivation(this, entity, moduleItem, now);
    }
    let activationDerivedRefreshResult = null;
    if (effectState.affectsShipDerivedState) {
      activationDerivedRefreshResult = this.refreshShipEntityDerivedState(entity, {
        session,
        broadcast: effectState.cloakModuleEffect !== true,
        notifyTargeting: true,
        // Cloaks deliver maxVelocity and targeting Dogma through a deliberately
        // ordered OnMultiEvent bundle below. A direct generic notification here
        // would arrive early and break that client contract.
        notifyDerivedAttributes: effectState.cloakModuleEffect !== true,
      });
    }
    let bundledCloakActivationDogma = false;
    let prototypeCloakActivationOwnerSession = null;
    if (effectState.cloakModuleEffect === true) {
      const ownerSession = session && isReadyForDestiny(session) ? session : null;
      const isPrototypeCloakActivation = isPrototypeCloakingModule(
        effectiveModuleItem,
        effectRecord,
      );
      const cloakStabilizationDurationMs =
        resolveCloakStabilizationDurationMs(effectiveModuleItem);
      const previousCloakStabilizationStrength =
        getEntityCloakStabilizationStrength(entity, now);
      if (ownerSession && isPrototypeCloakActivation) {
        prototypeCloakActivationOwnerSession = ownerSession;
        bundledCloakActivationDogma = this.sendOwnerCloakActivationDogma(
          ownerSession,
          entity,
          effectState,
          {
            nowMs: now,
            previousMaxVelocity:
              activationDerivedRefreshResult &&
              activationDerivedRefreshResult.data &&
              Number.isFinite(Number(activationDerivedRefreshResult.data.previousMaxVelocity))
                ? activationDerivedRefreshResult.data.previousMaxVelocity
                : null,
            previousCloakStabilizationStrength,
            currentCloakStabilizationStrength:
              cloakStabilizationDurationMs > 0 ? 1 : 0,
          },
        );
      }
      // "While the cloak is active the ship cannot target anything"
      // (https://wiki.eveuniversity.org/Cloaking), so engaging a device drops
      // every lock the ship is holding, the same way entering warp does. The
      // matching refusal for new locks lives in validateTargetLockRequest.
      this.clearOutgoingTargetLocks(entity, {
        notifySelf: true,
        notifyTarget: true,
        nowMs: now,
        activeReason: null,
        pendingReason: TARGET_LOSS_REASON_ATTEMPT_CANCELLED,
      });
      const cloakResult = this.cloakEntity(entity, {
        cloakMode: DESTINY_CLOAK_MODE_NORMAL,
        nowMs: now,
        uncloakRangeMeters: resolveCloakModuleUncloakRangeMeters(
          effectiveModuleItem,
          effectRecord,
        ),
        ownerSetMaxSpeed: !prototypeCloakActivationOwnerSession,
        cloakStabilizationDurationMs,
        targetingDelayMs: resolveCloakModuleTargetingDelayMs(effectState),
      });
      if (!cloakResult.success) {
        entity.activeModuleEffects.delete(normalizedModuleID);
        return {
          success: false,
          errorMsg: cloakResult.errorMsg || "CLOAK_ACTIVATION_FAILED",
        };
      }
      if (prototypeCloakActivationOwnerSession) {
        this.sendOwnerCloakActivationPresentation(
          prototypeCloakActivationOwnerSession,
          entity,
          effectState,
        );
      }
    }
    const compressionSlimChanged = refreshShipCompressionFacilityState(entity);
    if (compressionSlimChanged) {
      this.broadcastSlimItemChanges([entity]);
    }

    if (effectState.bombLauncherEffect === true || effectState.defenderLauncherEffect === true) {
      const launch = effectState.defenderLauncherEffect === true
        ? defenderRuntime.executeDefenderLaunch({ scene: this, entity, moduleItem,
          chargeItem, effectState, nowMs: now, callbacks: buildDefenderRuntimeCallbacks(this) })
        : bombRuntime.executeBombLaunchCycle({ scene: this, entity, moduleItem,
          chargeItem, effectState, nowMs: now, callbacks: buildBombRuntimeCallbacks(this) });
      if (!launch.success) {
        entity.activeModuleEffects.delete(normalizedModuleID);
        if (effectState.affectsShipDerivedState) this.refreshShipEntityDerivedState(entity,
          { session, broadcast: true, notifyTargeting: true });
        const consumed = getEntityCapacitorAmount(entity);
        setEntityCapacitorRatio(entity, entity.capacitorCapacity > 0 ? previousChargeAmount / entity.capacitorCapacity : 0);
        persistEntityCapacitorRatio(entity);
        notifyCapacitorChangeToSession(session, entity, now, consumed);
        return { success: false, errorMsg: launch.errorMsg };
      }
    }
    if (effectState.superweaponEffect === true) {
      const superweaponExecuteResult = executeSuperweaponActivation({
        scene: this,
        session,
        entity,
        moduleItem,
        effectState,
        nowMs: now,
        callbacks: superweaponCallbacks,
      });
      if (!superweaponExecuteResult.success) {
        // The lance-beacon preflight is intentionally the last fallible step.
        // Restore the generic activation's reserved resources without creating
        // a reactivation lock or emitting a stop FX for a shot that never
        // started.
        entity.activeModuleEffects.delete(normalizedModuleID);
        if (effectState.affectsShipDerivedState) {
          this.refreshShipEntityDerivedState(entity, {
            session,
            broadcast: true,
            notifyTargeting: true,
          });
        }
        const consumedChargeAmount = getEntityCapacitorAmount(entity);
        const capacitorCapacity = Math.max(
          0,
          toFiniteNumber(entity.capacitorCapacity, 0),
        );
        setEntityCapacitorRatio(
          entity,
          capacitorCapacity > 0
            ? previousChargeAmount / capacitorCapacity
            : 0,
        );
        persistEntityCapacitorRatio(entity);
        notifyCapacitorChangeToSession(
          session,
          entity,
          now,
          consumedChargeAmount,
        );
        const fuelRollback = rollbackShipModuleFuelConsumption(
          entity,
          initialFuelConsumptionResult,
        );
        if (!fuelRollback || fuelRollback.success !== true) {
          return {
            success: false,
            errorMsg: "FUEL_ROLLBACK_FAILED",
          };
        }
        if (session) {
          syncInventoryChangesToSession(session, fuelRollback.changes);
        }
        return {
          success: false,
          errorMsg:
            superweaponExecuteResult.errorMsg || "SUPERWEAPON_ACTIVATION_FAILED",
        };
      }
    }

    // Settle the arc chain before the FX goes out: the V24 client's
    // ChainWeaponEffect reads graphicInfo['targets'] once, at Start, and draws
    // primary -> targets[0] -> targets[1] ... from it. The first cycle then
    // consumes this same plan, so the ships that light up are the ships that
    // take damage.
    if (isVortonWeaponFamily(effectState.weaponFamily) && targetEntity) {
      stashVortonArcPlan(
        effectState,
        targetEntity,
        now,
        resolveVortonArcChain(this, entity, targetEntity, weaponSnapshot),
      );
    }

    const groupedTurretPresentationStates =
      buildGroupedTurretBankPresentationEffectStates(entity, effectState);
    if (effectState.guid && effectState.suppressStartSpecialFx !== true) {
      for (const presentationEffectState of groupedTurretPresentationStates) {
        const baseStartFxOptions = {
          moduleID: presentationEffectState.moduleID,
          moduleTypeID: presentationEffectState.typeID,
          targetID: effectState.defenderLauncherEffect === true
            ? effectState.defenderTargetID || null : presentationEffectState.targetID || null,
          chargeTypeID: presentationEffectState.chargeTypeID || null,
          weaponFamily: String(effectState.weaponFamily || ""),
          isOffensive: effectState.defenderLauncherEffect !== true && (
            isOffensiveWeaponFamily(effectState.weaponFamily) ||
            effectRecord.isOffensive === true),
          start: true,
          active: true,
          duration: presentationEffectState.durationMs,
          repeat: resolveSpecialFxRepeatCount(effectState),
          graphicInfo: buildGenericModuleSpecialFxGraphicInfo(effectState),
          ...buildMiningSpecialFxTimingOptions(effectState, now, {
            includeElapsed: false,
          }),
        };
        const controlSpecialFxGuid = resolveGenericModuleControlSpecialFxGuid(effectState);
        if (controlSpecialFxGuid) {
          this.broadcastSpecialFx(
            entity.itemID,
            controlSpecialFxGuid,
            baseStartFxOptions,
            entity,
          );
        }
        // A canceled lock can reactivate against the same primary before the
        // previous one-shot expires. Refresh its cached targets on this start too.
        broadcastVortonCycleSpecialFx(this, entity, effectState, baseStartFxOptions);
      }
    }
    if (effectState.tractorBeamEffect === true) {
      tractorBeamRuntime.broadcastTractorBeamActivationBootstrap(
        this,
        entity,
        effectState,
        now,
        { persistDynamicEntity },
      );
    }
    if (!bundledCloakActivationDogma) {
      notifyGenericDerivedAttributesToSession(session, effectState, now);
      for (const presentationEffectState of groupedTurretPresentationStates) {
        notifyGenericModuleEffectState(session, entity, presentationEffectState, true, {
          whenMs: now,
          startTimeMs: now,
        });
      }
    }
    notifyEntityRackHeatSourcesToOwner(this, entity);
    if (effectState.assistanceModuleEffect === true) {
      const initialAssistanceCycleResult = assistanceModuleRuntime.executeAssistanceModuleCycle({
        scene: this,
        session,
        entity,
        effectState,
        nowMs: now,
        // The activation pass sets the module running; a remote repair only
        // lands at the cycle boundary, so this pass must not spend a charge.
        isActivationPass: true,
        callbacks: buildAssistanceModuleRuntimeCallbacks(this),
      });
      if (!initialAssistanceCycleResult.success) {
        this.finalizeGenericModuleDeactivation(session, normalizedModuleID, {
          reason: initialAssistanceCycleResult.stopReason || "assistance",
          nowMs: now,
        });
        if (toInt(this.getEntityByID(toInt(effectState.targetID, 0))?.categoryID, 0) === 23 ||
          initialAssistanceCycleResult.errorMsg === "HOMEFRONT_DREAD_IN_SIEGE") {
          return { success: false, errorMsg: initialAssistanceCycleResult.errorMsg || "ASSISTANCE_FAILED" };
        }
      } else {
        const targetEntity =
          initialAssistanceCycleResult.data && initialAssistanceCycleResult.data.targetEntity
            ? initialAssistanceCycleResult.data.targetEntity
            : this.getEntityByID(toInt(effectState.targetID, 0));
        const targetSession = targetEntity && targetEntity.session ? targetEntity.session : null;
        if (
          targetEntity &&
          initialAssistanceCycleResult.data &&
          initialAssistanceCycleResult.data.aggregateChanged
        ) {
          this.refreshShipEntityDerivedState(targetEntity, {
            session: targetSession,
            broadcast: true,
            notifyTargeting: true,
          });
        }
        const hudSyncResult = targetEntity
          ? hudIconRuntime.upsertHudIconState(
            targetEntity,
            buildAssistanceHudState(targetEntity, entity, effectState, now),
          )
          : { state: null };
        if (targetSession && isReadyForDestiny(targetSession) && hudSyncResult.state) {
          notifyAssistanceHudStateToSession(targetSession, hudSyncResult.state, true, {
            startTimeMs: now,
            durationMs: resolveAssistanceJamDurationMs(effectState, now),
          });
        }
      }
    }
    if (effectState.jammerModuleEffect === true) {
      const initialJammerCycleResult = jammerModuleRuntime.executeJammerModuleCycle({
        scene: this,
        entity,
        effectState,
        nowMs: now,
        callbacks: buildJammerModuleRuntimeCallbacks(this),
      });
      if (!initialJammerCycleResult.success) {
        this.finalizeGenericModuleDeactivation(session, normalizedModuleID, {
          reason: initialJammerCycleResult.stopReason || "jammer",
          nowMs: now,
        });
      } else {
        applyJammerCyclePresentation(
          this,
          entity,
          effectState,
          now,
          initialJammerCycleResult,
        );
        noteDroneAssistSuccessfulOffensiveCycle(
          this,
          entity,
          effectState,
          initialJammerCycleResult,
          "jammer",
          now,
        );
        noteVisionsPaidEwarCycle(this, entity, effectState, initialJammerCycleResult, "jammer", now);
      }
    }
    if (effectState.jammerBurstEffect === true) {
      const initialJammerBurstCycleResult = jammerModuleRuntime.executeJammerBurstCycle({
        scene: this,
        entity,
        effectState,
        nowMs: now,
        callbacks: buildJammerModuleRuntimeCallbacks(this),
      });
      if (!initialJammerBurstCycleResult.success) {
        this.finalizeGenericModuleDeactivation(session, normalizedModuleID, {
          reason: initialJammerBurstCycleResult.stopReason || "jammerBurst",
          nowMs: now,
        });
      }
    }
    if (effectState.hostileModuleEffect === true) {
      const initialHostileCycleResult = hostileModuleRuntime.executeHostileModuleCycle({
        scene: this,
        session,
        entity,
        effectState,
        nowMs: now,
        callbacks: buildHostileModuleRuntimeCallbacks(this),
      });
      if (!initialHostileCycleResult.success) {
        this.finalizeGenericModuleDeactivation(session, normalizedModuleID, {
          reason: initialHostileCycleResult.stopReason || "hostile",
          nowMs: now,
        });
      } else {
        const resolvedTargetEntity =
          initialHostileCycleResult.data && initialHostileCycleResult.data.targetEntity
            ? initialHostileCycleResult.data.targetEntity
            : this.getEntityByID(toInt(effectState.targetID, 0));
        const targetSession =
          resolvedTargetEntity && resolvedTargetEntity.session
            ? resolvedTargetEntity.session
            : null;
        if (
          resolvedTargetEntity &&
          initialHostileCycleResult.data &&
          initialHostileCycleResult.data.aggregateChanged
        ) {
          this.refreshShipEntityDerivedState(resolvedTargetEntity, {
            session: targetSession,
            broadcast: true,
            notifyTargeting: true,
          });
          if (
            hostileModuleRuntime.isMicrowarpdriveBlocked(resolvedTargetEntity) ||
            hostileModuleRuntime.isMicroJumpDriveBlocked(resolvedTargetEntity) ||
            (
              resolvedTargetEntity.mode === "WARP" &&
              Number(resolvedTargetEntity.effectStamp) < 0 &&
              hostileModuleRuntime.isEntityWarpScrambled(resolvedTargetEntity)
            )
          ) {
            forceDeactivateBlockedMovementEffects(this, resolvedTargetEntity, now, "scram");
          }
        }
        const hudSyncResult = resolvedTargetEntity
          ? hudIconRuntime.upsertHudIconState(
            resolvedTargetEntity,
            buildHostileHudState(resolvedTargetEntity, entity, effectState, now),
          )
          : { state: null };
        if (targetSession && isReadyForDestiny(targetSession) && hudSyncResult.state) {
          notifyHostileHudStateToSession(targetSession, hudSyncResult.state, true, {
            startTimeMs: now,
            durationMs: resolveHostileJamDurationMs(effectState, now),
          });
        }
        noteDroneAssistSuccessfulOffensiveCycle(
          this,
          entity,
          effectState,
          initialHostileCycleResult,
          "hostile",
          now,
        );
        noteVisionsPaidEwarCycle(this, entity, effectState, initialHostileCycleResult, "hostile", now);
      }
    }
    if (effectState.localCycleEffect === true) {
      const initialLocalCycleResult = executeLocalCycle({
        scene: this,
        session,
        entity,
        moduleItem,
        effectState,
        nowMs: now,
        activation: true,
        callbacks: localCycleCallbacks,
      });
      if (!initialLocalCycleResult.success) {
        this.finalizeGenericModuleDeactivation(session, normalizedModuleID, {
          reason: initialLocalCycleResult.stopReason || "localCycle",
          nowMs: now,
        });
      } else if (
        initialLocalCycleResult.data &&
        initialLocalCycleResult.data.reloadState
      ) {
        effectState.pendingLocalReload = initialLocalCycleResult.data.reloadState;
        effectState.nextCycleAtMs = Math.max(
          now,
          Number(initialLocalCycleResult.data.reloadState.completeAtMs) || now,
        );
      }
    }
    if (effectState.commandBurstEffect === true) {
      const initialCommandBurstCycleResult = executeCommandBurstCycle(
        this,
        session,
        entity,
        moduleItem,
        effectState,
        now,
        { weaponTimerPreflightPassed: true },
      );
      if (!initialCommandBurstCycleResult.success) {
        this.finalizeGenericModuleDeactivation(session, normalizedModuleID, {
          reason: initialCommandBurstCycleResult.stopReason || "commandBurst",
          nowMs: now,
        });
      } else if (
        initialCommandBurstCycleResult.data &&
        initialCommandBurstCycleResult.data.reloadState
      ) {
        effectState.pendingLocalReload = initialCommandBurstCycleResult.data.reloadState;
        effectState.nextCycleAtMs = Math.max(
          now,
          Number(initialCommandBurstCycleResult.data.reloadState.completeAtMs) || now,
        );
      } else if (
        initialCommandBurstCycleResult.data &&
        initialCommandBurstCycleResult.data.stopReason
      ) {
        this.finalizeGenericModuleDeactivation(session, normalizedModuleID, {
          reason: initialCommandBurstCycleResult.data.stopReason,
          nowMs: now,
        });
      }
    }
    if (effectState.smartbombEffect === true) {
      const initialSmartbombCycleResult = smartbombRuntime.executeSmartbombCycle({
        scene: this,
        entity,
        moduleItem,
        effectState,
        nowMs: now,
        callbacks: buildSmartbombRuntimeCallbacks(this),
      });
      if (!initialSmartbombCycleResult.success) {
        this.finalizeGenericModuleDeactivation(session, normalizedModuleID, {
          reason: initialSmartbombCycleResult.stopReason || "smartbomb",
          nowMs: now,
        });
        return {
          success: false,
          errorMsg:
            initialSmartbombCycleResult.errorMsg ||
            "CRIMEWATCH_AGGRESSION_FAILED",
          data: initialSmartbombCycleResult.data || undefined,
        };
      }
    }
    if (effectState.autoTargetingEffect === true) {
      // Sweep on activation as well as on every cycle boundary: the module is
      // switched on because something is already shooting, and waiting a full
      // cycle before the first acquisition would be its own bug.
      const initialAutoTargetingResult = targetingModuleRuntime.executeAutoTargetingCycle({
        scene: this,
        entity,
        effectState,
        nowMs: now,
        callbacks: buildAutoTargetingRuntimeCallbacks(this),
      });
      if (!initialAutoTargetingResult.success) {
        this.finalizeGenericModuleDeactivation(session, normalizedModuleID, {
          reason: initialAutoTargetingResult.stopReason || "autoTargeting",
          nowMs: now,
        });
      }
    }
    if (effectState.passiveTargetingEffect === true) {
      // The lock the module was activated for. It runs through the ordinary
      // pipeline with only the victim's notice withheld, so range, capacity and
      // scan resolution all still apply.
      const passiveTargetEntity = this.getEntityByID(toInt(effectState.targetID, 0));
      const passiveLockResult = passiveTargetEntity
        ? this.requestModuleTargetLock(entity, passiveTargetEntity, {
          nowMs: now,
          suppressTargetNotice: true,
        })
        : { success: false, errorMsg: "TARGET_NOT_FOUND" };
      if (!passiveLockResult.success) {
        this.finalizeGenericModuleDeactivation(session, normalizedModuleID, {
          reason: "passiveTargeting",
          nowMs: now,
        });
        return {
          success: false,
          errorMsg: passiveLockResult.errorMsg || "TARGET_NOT_FOUND",
        };
      }
    }
    if (effectState.pointDefenseEffect === true) {
      const initialPointDefenseCycleResult = pointDefenseRuntime.executePointDefenseCycle({
        scene: this,
        entity,
        moduleItem,
        effectState,
        nowMs: now,
        callbacks: buildPointDefenseRuntimeCallbacks(this),
      });
      if (!initialPointDefenseCycleResult.success) {
        this.finalizeGenericModuleDeactivation(session, normalizedModuleID, {
          reason: initialPointDefenseCycleResult.stopReason || "pointDefense",
          nowMs: now,
        });
      } else if (
        initialPointDefenseCycleResult.data &&
        initialPointDefenseCycleResult.data.stopReason
      ) {
        this.finalizeGenericModuleDeactivation(session, normalizedModuleID, {
          reason: initialPointDefenseCycleResult.data.stopReason,
          nowMs: now,
        });
      }
    }

    if (
      offensiveActivation &&
      targetEntity
    ) {
      try {
        const npcService = lazyRequire("./npc");
        if (npcService && typeof npcService.noteNpcIncomingAggression === "function") {
          npcService.noteNpcIncomingAggression(
            targetEntity,
            entity,
            now,
          );
        }
      } catch (error) {
        log.warn(`[SpaceRuntime] NPC aggression activation hook failed: ${error.message}`);
      }
      if (targetEntity.dungeonSiteInstanceID) {
        // Opening fire on a site's object or wave ship fires the waves that wait for it
        // (encounter trigger "attacked"), a miss included.
        try {
          lazyRequire("../services/dungeon/dungeonUniverseSiteService")
            .handleEncounterEntityAttacked(this, targetEntity, { nowMs: now });
        } catch (error) {
          log.warn(`[SpaceRuntime] Site attacked trigger failed: ${error.message}`);
        }
      }
    }

    if (isSnapshotWeaponFamily(effectState.weaponFamily)) {
      const initialCycleResult = isTurretCycleWeaponFamily(effectState.weaponFamily)
        ? executeTurretCycle(
          this,
          entity,
          effectState,
          now,
        )
        : executeMissileCycle(
          this,
          entity,
          effectState,
          now,
          {
            deferUntilVisibilitySync: true,
          },
        );
      if (entity && entity.nativeNpc === true) {
        logNpcCombatDebug("npc.weapons.initial-cycle", {
          entity: summarizeNpcCombatEntity(entity),
          moduleItem: summarizeNpcCombatModule(moduleItem),
          target: summarizeNpcCombatEntity(targetEntity),
          weaponFamily: String(effectState.weaponFamily || ""),
          success: Boolean(initialCycleResult && initialCycleResult.success),
          stopReason: initialCycleResult && initialCycleResult.stopReason
            ? String(initialCycleResult.stopReason)
            : (
              initialCycleResult &&
              initialCycleResult.data &&
              initialCycleResult.data.stopReason
                ? String(initialCycleResult.data.stopReason)
                : null
            ),
          reloadState:
            initialCycleResult && initialCycleResult.data
              ? initialCycleResult.data.reloadState || null
              : null,
          errorMsg: initialCycleResult && initialCycleResult.errorMsg
            ? String(initialCycleResult.errorMsg)
            : null,
        });
      }
      noteDroneAssistSuccessfulOffensiveCycle(
        this,
        entity,
        effectState,
        initialCycleResult,
        isTurretCycleWeaponFamily(effectState.weaponFamily)
          ? "turret"
          : "missile",
        now,
      );
      if (!initialCycleResult.success) {
        this.finalizeGenericModuleDeactivation(session, normalizedModuleID, {
          reason: initialCycleResult.stopReason || "weapon",
          nowMs: now,
        });
      } else if (
        initialCycleResult.data &&
        (
          initialCycleResult.data.reloadState ||
          initialCycleResult.data.bankReloadStates
        )
      ) {
        effectState.pendingMissileReload =
          initialCycleResult.data.bankReloadStates
            ? null
            : initialCycleResult.data.reloadState;
        effectState.pendingMissileBankReloads =
          initialCycleResult.data.bankReloadStates || null;
        const reloadCompletionAtMs = initialCycleResult.data.bankReloadStates
          ? Math.max(
            ...initialCycleResult.data.bankReloadStates.map(
              (reloadState) => Number(reloadState && reloadState.completeAtMs) || now,
            ),
            now,
          )
          : Number(initialCycleResult.data.reloadState && initialCycleResult.data.reloadState.completeAtMs) || now;
        effectState.nextCycleAtMs = Math.max(
          now,
          reloadCompletionAtMs,
        );
        // The first volley emptied the launcher, so it reloads now, as at a
        // cycle boundary (tick.js): it shows off for the reload and the tick
        // starts it again when the reload completes. The client's cycle ring
        // idles while the module reloads and returns only on that fresh start.
        if (isMissileWeaponFamily(effectState.weaponFamily)) {
          effectState.pendingReloadReactivation = true;
          if (session && isReadyForDestiny(session)) {
            notifyGenericModuleEffectState(session, entity, effectState, false, {
              whenMs: now,
            });
          }
        }
      } else if (
        initialCycleResult.data &&
        initialCycleResult.data.stopReason
      ) {
        this.finalizeGenericModuleDeactivation(session, normalizedModuleID, {
          reason: initialCycleResult.data.stopReason,
          nowMs: now,
        });
      }
    }

    // Version 23.02 parity: only a successfully committed offensive activation
    // cancels Abyssal-return (and ordinary undock) invulnerability. Support and
    // propulsion modules retain the grace, and hard activation failures above
    // never consume it.
    breakEntityTimedInvulnerability(entity, {
      trigger:
        offensiveActivation || sovereigntyEntosisActivation
          ? "offensive-module"
          : "module",
    });
    const activationResult = {
      success: true,
      data: {
        entity,
        effectState,
        cloakActivationDeactivatedModuleIDs:
          cloakActivationDeactivationResult &&
          cloakActivationDeactivationResult.data
            ? cloakActivationDeactivationResult.data.stoppedModuleIDs || []
            : [],
        // Modules the cloak lets finish their current cycle; the tick stops them.
        cloakActivationPendingModuleIDs:
          cloakActivationDeactivationResult &&
          cloakActivationDeactivationResult.data
            ? cloakActivationDeactivationResult.data.pendingModuleIDs || []
            : [],
      },
    };
    // canActivateInGateCloak (3123) is the one exemption from "arming anything
    // drops the gate cloak". Nothing read it, so a Warp Core Stabilizer or an
    // Interdiction Nullifier decloaked the ship the instant it was switched on
    // — which is the exact moment both modules exist to survive.
    if (
      getTypeDogmaAttributeValueByID(
        toInt(effectiveModuleItem.typeID, 0),
        MODULE_ATTRIBUTE_CAN_ACTIVATE_IN_GATE_CLOAK,
        0,
      ) > 0
    ) {
      return activationResult;
    }
    return this.cancelStargateJumpCloakAfterCommand(
      session,
      activationResult,
      "module",
    );
  },

finalizeGenericModuleDeactivation(session, moduleID, options = {}) {
    const entity = this.getShipEntityForSession(session);
    const normalizedModuleID = toInt(moduleID, 0);
    if (
      !entity ||
      normalizedModuleID <= 0 ||
      !(entity.activeModuleEffects instanceof Map)
    ) {
      return { success: false, errorMsg: "MODULE_NOT_ACTIVE" };
    }

    const effectState = entity.activeModuleEffects.get(normalizedModuleID) || null;
    if (!effectState) {
      return { success: false, errorMsg: "MODULE_NOT_ACTIVE" };
    }
    const isCloakingEffect = isCloakingModuleEffectState(effectState);

    const stopTimeMs = Math.max(
      0,
      toFiniteNumber(
        options.nowMs,
        getEffectCycleBoundaryMs(effectState, this.getCurrentSimTimeMs()),
      ),
    );

    if (
      entosisLinkRuntime.isEntosisLinkEffectState(effectState) &&
      effectState.entosisCaptureEnabled === true
    ) {
      const entosisStopResult = entosisLinkRuntime.stopEntosisLinkCapture({
        scene: this,
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
      this.syncStructureEntitiesFromState();
    }

    const stopReason = options.reason || effectState.stopReason || null;
    let ancillaryManualReloadResult = null;
    if (stopReason === "manual" && effectState.localCycleEffect === true) {
      const moduleItem = getEntityRuntimeModuleItem(
        entity,
        normalizedModuleID,
        effectState.moduleFlagID,
      );
      ancillaryManualReloadResult = queueAncillaryLocalReloadOnManualDeactivate({
        entity,
        scene: this,
        session,
        moduleItem,
        effectState,
        nowMs: stopTimeMs,
        callbacks: buildLocalCycleRuntimeCallbacks(
          toInt(session && session.characterID, 0),
        ),
      });
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
    effectState.stopReason = stopReason;
    lazyRequire("../services/security/crimewatchState").endModuleCombatActivity(effectState, stopTimeMs);
    clearJumpPortalBridgeModeForEffect(effectState);
    clearCynosuralFieldForEffect(this, session, effectState, {
      nowMs: stopTimeMs,
    });
    if (isPrecursorTurretFamily(effectState.weaponFamily)) {
      resetPrecursorTurretSpool(effectState);
    }
    const dependentIndustrialModuleIDs = isIndustrialCoreEffectName(effectState.effectName)
      ? getIndustrialCoreDependentModuleIDs(entity, normalizedModuleID)
      : [];
    if (effectState.tractorBeamEffect === true) {
      tractorBeamRuntime.handleTractorBeamDeactivation(this, effectState, stopTimeMs, {
        persistDynamicEntity,
      });
    }
    if (effectState.superweaponEffect === true) {
      finalizeSuperweaponDeactivation({
        scene: this,
        session,
        entity,
        effectState,
        nowMs: stopTimeMs,
        callbacks: buildSuperweaponRuntimeCallbacks(this, toInt(session && session.characterID, 0)),
      });
    }
    let derivedRefreshResult = null;
    if (
      effectState.affectsShipDerivedState &&
      options.refreshDerivedState !== false
    ) {
      derivedRefreshResult = this.refreshShipEntityDerivedState(entity, {
        session,
        broadcast: !isCloakingEffect,
        // The uncloaked speed applies at the next Destiny tick, after
        // Observers get the ship back with its cloaked one: they hear of it
        // then. The owner's comes with the uncloak presentation.
        ...(isCloakingEffect
          ? {
            shipPrimeBroadcast: (previousState) => this.broadcastShipPrimeUpdates(entity, {
              previousState,
            }),
          }
          : {}),
        notifyTargeting: true,
        // Preserve the cloak-specific bundled/delayed Dogma presentation for
        // both owner-session and sessionless deactivation paths.
        notifyDerivedAttributes: !isCloakingEffect,
      });
    }
    // The owner's uncloak Dogma events are collected for the next doPostTick;
    // the uncloak itself is scene/cloaking.js's,
    // its new speed limit the ship prime broadcast above.
    let bundledCloakUncloakDogma = false;
    if (isCloakingEffect && isEntityCloaked(entity)) {
      const ownerSession = session && isReadyForDestiny(session) ? session : null;
      if (ownerSession) {
        const previousMaxVelocity =
          derivedRefreshResult &&
          derivedRefreshResult.data &&
          Number.isFinite(Number(derivedRefreshResult.data.previousMaxVelocity))
            ? derivedRefreshResult.data.previousMaxVelocity
            : null;
        const uncloakDogmaEvents = buildCloakModuleUncloakDogmaEvents(
          ownerSession,
          entity,
          effectState,
          {
            whenMs: stopTimeMs,
            previousMaxVelocity,
            currentMaxVelocity: getShipDogmaMotionValue(entity, "maxVelocity"),
            duplicateMaxVelocity: true,
          },
        );
        bundledCloakUncloakDogma = queueDogmaEventPairs(ownerSession, uncloakDogmaEvents);
        this.uncloakEntity(entity, {
          nowMs: stopTimeMs,
          ownerSetMaxSpeed: false,
        });
      } else {
        this.uncloakEntity(entity, {
          nowMs: stopTimeMs,
          ownerSetMaxSpeed: true,
        });
      }
    }
    if (effectState.assistanceModuleEffect === true) {
      const targetEntity = this.getEntityByID(toInt(effectState.targetID, 0));
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
        this.refreshShipEntityDerivedState(targetEntity, {
          session: targetSession,
          broadcast: true,
          notifyTargeting: true,
        });
      }
      // Stopped mid-cycle, the icon stays until the cycle ends.
      const removedHudState = targetEntity
        ? hudIconRuntime.releaseHudIconStateAtCycleEnd(
          targetEntity,
          buildAssistanceHudState(targetEntity, entity, effectState, stopTimeMs),
          this.getCurrentSimTimeMs(),
        )
        : null;
      if (targetSession && isReadyForDestiny(targetSession) && removedHudState) {
        notifyAssistanceHudStateToSession(targetSession, removedHudState, false, {
          startTimeMs: stopTimeMs,
        });
      }
    }
  if (effectState.jammerModuleEffect === true) {
    removeJammerCyclePresentation(this, entity, effectState, stopTimeMs);
  }
    if (effectState.hostileModuleEffect === true) {
      const targetEntity = this.getEntityByID(toInt(effectState.targetID, 0));
      const targetSession = targetEntity && targetEntity.session ? targetEntity.session : null;
      const hostileRemovalResult = hostileModuleRuntime.removeHostileModuleState({
        targetEntity,
        sourceEntity: entity,
        effectState,
        scene: this,
        nowMs: stopTimeMs,
      });
      if (
        hostileRemovalResult &&
        hostileRemovalResult.success &&
        hostileRemovalResult.data &&
        hostileRemovalResult.data.aggregateChanged &&
        targetEntity
      ) {
        this.refreshShipEntityDerivedState(targetEntity, {
          session: targetSession,
          broadcast: true,
          notifyTargeting: true,
        });
      }
      // Stopped mid-cycle, the icon stays until the cycle ends.
      const removedHudState = targetEntity
        ? hudIconRuntime.releaseHudIconStateAtCycleEnd(
          targetEntity,
          buildHostileHudState(targetEntity, entity, effectState, stopTimeMs),
          this.getCurrentSimTimeMs(),
        )
        : null;
      if (targetSession && isReadyForDestiny(targetSession) && removedHudState) {
        notifyHostileHudStateToSession(targetSession, removedHudState, false, {
          startTimeMs: stopTimeMs,
        });
      }
    }

    const groupedTurretPresentationStates =
      buildGroupedTurretBankPresentationEffectStates(entity, effectState);
    const controlSpecialFxGuid = resolveGenericModuleControlSpecialFxGuid(effectState);
    if (controlSpecialFxGuid && effectState.suppressStopSpecialFx !== true) {
      const isOffensiveFx = isOffensiveWeaponFamily(effectState.weaponFamily);
      for (const presentationEffectState of groupedTurretPresentationStates) {
        const baseStopFxOptions = {
          moduleID: presentationEffectState.moduleID,
          moduleTypeID: presentationEffectState.typeID,
          targetID: presentationEffectState.targetID || null,
          chargeTypeID: presentationEffectState.chargeTypeID || null,
          weaponFamily: String(effectState.weaponFamily || ""),
          isOffensive: isOffensiveFx,
          start: false,
          active: effectState.miningEffect === true || isCloakingEffect,
          duration: presentationEffectState.durationMs,
          ...(isCloakingEffect
            ? buildCloakModuleSpecialFxTimingOptions(effectState, stopTimeMs, {
                includeElapsed: true,
              })
            : buildMiningSpecialFxTimingOptions(effectState, stopTimeMs, {
                includeElapsed: true,
              })),
        };
        this.broadcastSpecialFx(
          entity.itemID,
          controlSpecialFxGuid,
          baseStopFxOptions,
          entity,
        );
      }
    }
    if (!bundledCloakUncloakDogma) {
      notifyGenericDerivedAttributesToSession(session, effectState, stopTimeMs);
      for (const presentationEffectState of groupedTurretPresentationStates) {
        notifyGenericModuleEffectState(session, entity, presentationEffectState, false, {
          whenMs: stopTimeMs,
        });
      }
    }
    notifyEntityRackHeatSourcesToOwner(this, entity);
    if (dependentIndustrialModuleIDs.length > 0) {
      for (const dependentModuleID of dependentIndustrialModuleIDs) {
        this.finalizeGenericModuleDeactivation(session, dependentModuleID, {
          reason: "industrialCore",
          nowMs: stopTimeMs,
          suppressCompressionSlimBroadcast: true,
        });
      }
    }
    const compressionSlimChanged =
      refreshShipCompressionFacilityState(entity) ||
      dependentIndustrialModuleIDs.length > 0;
    if (
      compressionSlimChanged &&
      options.suppressCompressionSlimBroadcast !== true
    ) {
      this.broadcastSlimItemChanges([entity]);
    }

    return {
      success: true,
      data: {
        entity,
        effectState,
        stoppedAtMs: stopTimeMs,
        ancillaryManualReload:
          ancillaryManualReloadResult &&
          ancillaryManualReloadResult.matched === true &&
          ancillaryManualReloadResult.success === true &&
          ancillaryManualReloadResult.data &&
          (
            ancillaryManualReloadResult.data.queued === true ||
            ancillaryManualReloadResult.data.alreadyPending === true ||
            ancillaryManualReloadResult.data.reloadState
          )
            ? ancillaryManualReloadResult.data || null
            : null,
      },
    };
  },

deactivateGenericModule(session, moduleID, options = {}) {
    const entity = this.getShipEntityForSession(session);
    const normalizedModuleID = toInt(moduleID, 0);
    if (
      !entity ||
      normalizedModuleID <= 0 ||
      !(entity.activeModuleEffects instanceof Map)
    ) {
      return { success: false, errorMsg: "MODULE_NOT_ACTIVE" };
    }

    const effectState = entity.activeModuleEffects.get(normalizedModuleID) || null;
    if (!effectState) {
      return { success: false, errorMsg: "MODULE_NOT_ACTIVE" };
    }

    const now = this.getCurrentSimTimeMs();
    const reason = String(options.reason || "manual");
    const isCloakingEffect = isCloakingModuleEffectState(effectState);
    const cycleBoundaryMs = getEffectCycleBoundaryMs(effectState, now);
    // deferUntilCycle === true is an explicit opt-in for callers that are not a
    // manual click but still must let a running cycle finish. Engaging a cloak
    // is the case that matters: it stops further cycles without cutting the
    // current one short, which is what keeps the MWD overshoot available.
    const shouldDefer =
      !isCloakingEffect &&
      (options.deferUntilCycle === true ||
        (options.deferUntilCycle !== false && reason === "manual"));

    // EVE parity: mining lasers and strip miners can be short-cycled — a manual
    // mid-cycle stop interrupts the cycle immediately and deposits ore
    // proportional to the elapsed time. A loaded mining crystal does not change
    // that; EVE University calls short-cycling "particularly useful when using
    // strip miners" (https://wiki.eveuniversity.org/Mining_yield), which are the
    // crystal-using family. The only six published types declaring a crystal
    // chargeGroup are Modulated Strip Miner II, Modulated Deep Core Miner II,
    // Modulated Deep Core Strip Miner II and their three Abyssal variants — all
    // ore modules, and crystal wear already scales with the partial cycle
    // because applyCrystalVolatility takes the same efficiency.
    //
    // Ice harvesters and ice mining lasers are the exception, and fall through
    // to the deferred boundary stop below. EVE University is explicit:
    // "Short-cycling is equally useful when harvesting gas, but should never be
    // used while ice harvesting (as ice mining lasers/harvesters only harvest 1
    // unit of ice per complete cycle; short-cycle your ice harvester, and you
    // mine nothing)"
    // (https://wiki.eveuniversity.org/Mining_yield). One ice cycle is 1000 m³
    // against a 1000 m³ ice unit, so a pro-rata stop is a fraction of a unit
    // that randomizedRound coin-flips into a whole unit EVE never grants — and
    // depletes the field by it. miningModuleCanShortCycle gates on the resolved
    // mining family, not a typeID list.
    //
    // Gas cloud scoops and harvesters DO short-cycle, despite being the only
    // mining modules that declare disallowEarlyDeactivation (906). That
    // attribute is misleadingly named: its own SDE description is "will prevent
    // ejection from the ship it is fitted to and extend the log out ship
    // removal timer", and it says nothing about cycles. The same EVE University
    // sentence says so. Gating gas here was tried and reverted.
    if (reason === "manual" && effectState.miningEffect === true) {
      const miningRuntime = config.miningEnabled === true
        ? lazyRequire("../services/mining/miningRuntime")
        : null;
      const canShortCycle =
        miningRuntime &&
        typeof miningRuntime.miningModuleCanShortCycle === "function"
          ? miningRuntime.miningModuleCanShortCycle(entity, effectState)
          : true;
      if (canShortCycle) {
        const durationMs = Math.max(
          1,
          toFiniteNumber(effectState.durationMs, 1000),
        );
        const elapsedMs = Math.min(
          durationMs,
          Math.max(
            0,
            now - toFiniteNumber(effectState.startedAtMs, now),
          ),
        );
        const efficiency = elapsedMs / durationMs;
        let partialMiningCycleResult = null;

        if (miningRuntime && efficiency > 0) {
          try {
            if (typeof miningRuntime.executeMiningCycle === "function") {
              partialMiningCycleResult = miningRuntime.executeMiningCycle(
                this,
                entity,
                effectState,
                now,
                {
                  efficiency,
                  partialCycle: true,
                },
              );
            }
          } catch (error) {
            log.warn(
              `[SpaceRuntime] Partial mining cycle failed for entity=${toInt(entity.itemID, 0)} ` +
                `module=${normalizedModuleID}: ${error.message}`,
            );
          }
        }

        const moduleStillActive =
          entity.activeModuleEffects instanceof Map &&
          entity.activeModuleEffects.has(normalizedModuleID);
        const finalizeResult = moduleStillActive
          ? this.finalizeGenericModuleDeactivation(
              session,
              normalizedModuleID,
              {
                reason,
                nowMs: now,
              },
            )
          : {
              success: true,
              data: {
                entity,
                effectState,
                stoppedAtMs: now,
              },
            };
        if (finalizeResult.success && finalizeResult.data) {
          finalizeResult.data.partialMiningCycle = {
            efficiency,
            elapsedMs,
            durationMs,
            result: partialMiningCycleResult,
          };
        }
        return finalizeResult;
      }
    }

    if (effectState.deactivateAtMs > 0 && effectState.deactivateAtMs > now) {
      return {
        success: true,
        data: { entity, effectState, pending: true, deactivateAtMs: effectState.deactivateAtMs },
      };
    }

    if (shouldDefer && cycleBoundaryMs > now + 1) {
      effectState.deactivationRequestedAtMs = now;
      effectState.deactivateAtMs = cycleBoundaryMs;
      effectState.stopReason = reason;
      return {
        success: true,
        data: { entity, effectState, pending: true, deactivateAtMs: cycleBoundaryMs },
      };
    }

    return this.finalizeGenericModuleDeactivation(session, normalizedModuleID, {
      reason,
      nowMs: isCloakingEffect ? now : (cycleBoundaryMs > 0 ? cycleBoundaryMs : now),
    });
  },

deactivateAllActiveModules(session, options = {}) {
    const entity = this.getShipEntityForSession(session);
    if (!entity) {
      return {
        success: false,
        errorMsg: "SHIP_NOT_FOUND",
      };
    }

    const activeEffectStates =
      entity.activeModuleEffects instanceof Map
        ? [...entity.activeModuleEffects.values()]
        : [];
    if (activeEffectStates.length === 0) {
      return {
        success: true,
        data: {
          stoppedModuleIDs: [],
          pendingModuleIDs: [],
          errors: [],
        },
      };
    }

    const nowMs = Math.max(
      0,
      toFiniteNumber(options.nowMs, this.getCurrentSimTimeMs()),
    );
    const reason = String(options.reason || "sessionTransition");
    const deferUntilCycle = options.deferUntilCycle === true;
    const excludeModuleIDs = new Set(
      (Array.isArray(options.excludeModuleIDs) ? options.excludeModuleIDs : [])
        .map((moduleID) => toInt(moduleID, 0))
        .filter((moduleID) => moduleID > 0),
    );
    const activeStatesByModuleID = new Map(
      activeEffectStates
        .map((effectState) => [toInt(effectState && effectState.moduleID, 0), effectState])
        .filter(([moduleID]) => moduleID > 0),
    );
    const sortedModuleIDs = [...activeStatesByModuleID.keys()].sort(
      (left, right) => left - right,
    );
    const stoppedModuleIDs = [];
    // Modules still running to their cycle boundary. Only deferUntilCycle
    // produces these; the tick stops them later, so they are not stopped yet.
    const pendingModuleIDs = [];
    const errors = [];

    for (const moduleID of sortedModuleIDs) {
      if (excludeModuleIDs.has(moduleID)) {
        continue;
      }
      if (
        !(entity.activeModuleEffects instanceof Map) ||
        !entity.activeModuleEffects.has(moduleID)
      ) {
        continue;
      }

      const effectState = activeStatesByModuleID.get(moduleID) || null;
      const effectName = String(effectState && effectState.effectName || "");
      const isPropulsionEffect =
        effectName === PROPULSION_EFFECT_AFTERBURNER ||
        effectName === PROPULSION_EFFECT_MICROWARPDRIVE;
      // deferUntilCycle routes through the deactivate* wrappers, which mark the
      // effect to stop at its own cycle boundary rather than deleting it now.
      // Engaging a cloak uses this: EVE stops further cycles but never cuts a
      // running one short, and deleting the effect immediately is what killed
      // the MWD burst. A session transition still stops everything outright.
      const result = deferUntilCycle
        ? (isPropulsionEffect
            ? this.deactivatePropulsionModule(session, moduleID, {
                reason,
                deferUntilCycle: true,
              })
            : this.deactivateGenericModule(session, moduleID, {
                reason,
                deferUntilCycle: true,
              }))
        : (isPropulsionEffect
            ? this.finalizePropulsionModuleDeactivation(session, moduleID, {
                reason,
                nowMs,
              })
            : this.finalizeGenericModuleDeactivation(session, moduleID, {
                reason,
                nowMs,
              }));

      if (result && result.success) {
        if (result.data && result.data.pending === true) {
          pendingModuleIDs.push(moduleID);
        } else {
          stoppedModuleIDs.push(moduleID);
        }
        continue;
      }

      errors.push({
        moduleID,
        errorMsg: result && result.errorMsg ? result.errorMsg : "DEACTIVATION_FAILED",
      });
    }

    return {
      success: errors.length === 0,
      errorMsg: errors.length > 0 ? "ACTIVE_MODULE_DEACTIVATION_FAILED" : null,
      data: {
        stoppedModuleIDs,
        pendingModuleIDs,
        errors,
      },
    };
  },
};
