"use strict";

const runtimeEntryDirname = require("path").resolve(__dirname, "../..");
const path = require("path");
const spatialTrace = require(path.join(runtimeEntryDirname, "../network/spatialTrace"));
const tickProfiler = require(path.join(runtimeEntryDirname, "tickProfiler"));
const starbaseDefenseRuntime = require("../../../services/starbase/starbaseDefenseRuntime");
const config = require(path.join(runtimeEntryDirname, "../config"));
const log = require(path.join(runtimeEntryDirname, "../utils/logger"));
const {
  CAPSULE_TYPE_ID,
  CAPSULE_TYPE_ID_GOLDEN,
  ITEM_FLAGS,
  updateShipItem,
  updateInventoryItem,
  removeInventoryItem,
  getShipConditionState,
  normalizeShipConditionState,
  getItemMetadata,
  pruneExpiredSpaceItems,
} = require(path.join(runtimeEntryDirname, "../services/inventory/itemStore"));
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
  isAligningForWarp,
} = require(path.join(runtimeEntryDirname, "./destiny/simulation/evolve.js"));
const mobileTractorUnitRuntime = require(path.join(runtimeEntryDirname, "../services/ship/mobileTractorUnitRuntime"));
const surveyProbeRuntime = require(path.join(
  runtimeEntryDirname,
  "../services/exploration/probes/surveyProbeRuntime",
));
const {
  logNpcCombatDebug,
  summarizeNpcCombatEntity,
  summarizeNpcCombatModule,
} = require(path.join(runtimeEntryDirname, "./npc/npcCombatDebug"));
const {
  PILOT_WARP_ACTIVATION_DELAY_DESTINY_TICKS,
  PILOT_WARP_DESTINATION_ACQUIRE_LEAD_DESTINY_TICKS,
  PILOT_WARP_DESTINATION_STATIC_PRELOAD_DISTANCE_METERS,
  PILOT_WARP_HISTORY_SAFE_DESTINY_LEAD,
  PILOT_WARP_SOURCE_REMOVAL_SETTLE_MS,
} = require(path.join(runtimeEntryDirname, "./destiny/simulation/warpContract.js"));
const {
  isAnchorRelevanceEnabled,
  hasStartupAnchorRelevanceContext,
  syncRelevantStartupControllersForScene,
  prewarmStartupControllersForWarpDestination,
} = require(path.join(runtimeEntryDirname, "./npc/npcAnchorRelevance"));
const commandBurstRuntime = require(path.join(
  runtimeEntryDirname,
  "./modules/commandBurstRuntime",
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
const reactiveArmorHardenerRuntime = require(path.join(
  runtimeEntryDirname,
  "./modules/reactiveArmorHardenerRuntime",
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
const remoteRepairShowRuntime = require(path.join(
  runtimeEntryDirname,
  "../RemoteRepShow/remoteRepairShowRuntime",
));
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
  flushDogmaReloadsAtSimTime,
  queueAutomaticMissileReload,
  resolvePendingMissileReload,
} = require(path.join(runtimeEntryDirname, "./combat/missiles/missileReloads"));
const {
  prepareLocalCycleActivation,
  prepareLocalCycleBoundary,
  executeLocalCycle,
  queueAncillaryLocalReloadOnManualDeactivate,
} = require(path.join(runtimeEntryDirname, "./modules/localCycleRuntime"));
const {
  queueAutomaticLocalModuleReload,
  resolvePendingLocalModuleReload,
} = require(path.join(runtimeEntryDirname, "./modules/localCycleReloads"));
const {
  buildSuperweaponFreshAcquireFxOptions,
  prepareSuperweaponActivation,
  executeSuperweaponActivation,
  finalizeSuperweaponDeactivation,
  isSuperweaponFxReplayWindowActive,
  tickScene: tickSuperweaponScene,
  tickSuperTitanShowScene,
  isSuperweaponMovementLocked,
  isSuperweaponJumpOrCloakLocked,
  entityHasCloakDisallowingFittedModule,
} = require(path.join(runtimeEntryDirname, "./modules/superweapons/superweaponRuntime"));
const state = require("../state");
const {
  notifyCapacitorChangeToSession,
  notifyGenericDerivedAttributesToSession,
} = require("../attributeChangeNotification");
const {
  executeCommandBurstCycle,
  recordCommandBurstWeaponTimer,
} = require("../commandBurst");
const {
  isReadyForDestiny,
} = require("../destinyDeliveryEligibility");
const {
  runDueDestinyTicks,
} = require("../destinyTick");
const {
  noteDroneAssistSuccessfulOffensiveCycle,
} = require("../droneAssistOffensiveNotice");
const {
  consumeEntityCapacitor,
  getEntityCapacitorAmount,
  getEntityCapacitorRatio,
  persistEntityCapacitorRatio,
  setEntityCapacitorRatio,
} = require("../entityCapacitor");
const {
  getEntityRuntimeModuleItem,
} = require("../entityDogmaView");
const {
  getOwningSessionForEntity,
} = require("../entityOwnerSession");
const {
  persistDynamicEntity,
  persistShipEntity,
  shouldPersistShipEntityAtTick,
} = require("../entitySpacePersistence");
const {
  sovereigntyCaptureTickRequiresStructureSync,
} = require("../entosisCapture");
const {
  isShipInsideForceField,
} = require("../forceFieldContainment");
const {
  notifyGenericModuleEffectState,
  notifyModuleEffectState,
} = require("../godmaShipEffectNotification");
const {
  ASSISTANCE_JAM_REFRESH_GRACE_MS,
  applyJammerCyclePresentation,
  buildAssistanceHudState,
  buildHostileHudState,
  notifyAssistanceHudStateToSession,
  notifyHostileHudStateToSession,
  resolveHostileJamRefreshDurationMs,
  tickHudIconStateExpiries,
} = require("../hudIconStates");
const {
  CATEGORY_STARBASE,
} = require("../inventorySpaceEntity");
const {
  hasPostMicroJumpWarpScramble,
} = require("../microJumpDriveEligibility");
const {
  resolvePendingGroupedMissileReloads,
} = require("../moduleChargeReload");
const {
  MODULE_CONSEQUENCE_DELIVERY,
  normalizeModuleConsequenceDelivery,
  resolveModuleConsequenceDelivery,
} = require("../moduleConsequenceDelivery");
const {
  applyAssistanceCycleRuntimeSnapshot,
  applyHostileCycleRuntimeSnapshot,
  applyJammerCycleRuntimeSnapshot,
  applySalvagerCycleRuntimeSnapshot,
  resolveAssistanceCycleRuntimeSnapshot,
  resolveHostileCycleRuntimeSnapshot,
  resolveJammerCycleRuntimeSnapshot,
  resolveSalvagerCycleRuntimeSnapshot,
} = require("../moduleCycleBoundarySnapshot");
const {
  getEffectCycleBoundaryMs,
} = require("../moduleCycleSchedule");
const {
  deactivateWarpUnsafeActiveModulesForWarpStart,
  finalizeGenericModuleDeactivationWithoutSession,
  forceDeactivateBlockedMovementEffects,
} = require("../moduleEffectShutdown");
const {
  advanceEntityRackHeat,
  applyOverloadHeatDamageToModule,
  settlePendingOverloadModuleTransition,
} = require("../moduleHeat");
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
  buildSuperweaponRuntimeCallbacks,
  buildTractorBeamRuntimeCallbacks,
} = require("../moduleRuntimeCallbacks");
const {
  clamp,
  roundNumber,
  toFiniteNumber,
  toInt,
} = require("../../../common/numbers");
const {
  advancePassiveRechargeRatio,
  settlePassiveRechargeRatio,
} = require("../passiveDerivedState");
const {
  isMovementTraceActive,
  logBallDebug,
  logMovementDebug,
} = require("../runtimeDebugInstrumentation");
const {
  lazyRequire,
} = require("../runtimeModuleBoundary");
const {
  buildShipHealthTransitionResult,
  notifyShipHealthAttributesToSession,
} = require("../shipHealthState");
const {
  consumeShipModuleFuelForSession,
} = require("../shipModuleFuel");
const {
  tickStarbaseDefenseForScene,
} = require("../starbaseDefenseTick");
const {
  buildDockingDebugState,
  clearPendingDock,
} = require("../stationDockingGeometry");
const {
  getControlledStaticStructureDogmaHosts,
} = require("../structureSessionHost");
const {
  tickSceneStructureTethers,
} = require("../structureTether");
const {
  isEntityLockedTarget,
} = require("../targeting");
const {
  magnitude,
} = require("../../../common/vector");
const {
  executeMissileCycle,
  executeTurretCycle,
} = require("../weaponCycle");
const {
  isSnapshotWeaponFamily,
} = require("../weaponSnapshot");

module.exports = {

// The Gameplay tick: one 100 ms step of the Solar system's gameplay. The
// Destiny ticks due run first (runtime/destinyTick.js), right after
// the sim clock advances: as many as the driver says are due at the sim time
// it has just reached, each applying the queue, moving every Ball over 1 s
// and sending. Gameplay then reads every Ball as the last Evolve left it,
// and any movement change it makes waits in the queue for the next Destiny
// tick.
tick(wallclockNow) {
    try {
      require("../../../services/dungeon/siteHazardOutcomes").recoverForScene(this);
    } catch (error) {
      log.warn(`[SpaceRuntime] Holding scene ${this.sceneKey} for hazard health recovery: ${error.message}`);
      return { blocked: true, errorMsg: "SITE_HAZARD_HEALTH_PENDING" };
    }
    const clockState = this.advanceClock(wallclockNow);
    const now = clockState.simNowMs;
    const deltaSeconds = Math.max(clockState.simDeltaMs / 1000, 0);
    this._activeTickSequence = this._nextTickSequence;
    this._nextTickSequence += 1;
    this._activeTickDeltaSeconds = deltaSeconds;
    this._activeTickNowMs = now;
    this._tickTargetingStatsCache = new Map();
    // Each in-space pilot's clock snapshot (session._space.simTimeMs, its
    // file time and Time Dilation) is what gameplay reads as "now" for that
    // pilot (attribute notifications, timers). Main refreshed it on every
    // Destiny send; it is refreshed here, once per gameplay tick. A pilot
    // still bootstrapping gets its clock from the bootstrap.
    for (const session of this.sessions.values()) {
      if (isReadyForDestiny(session)) {
        this.refreshSessionClockSnapshot(session, now);
      }
    }
    // Each Destiny tick contains its own phases (runtime/destinyTick.js);
    // this catch is for the driver itself, like every section below.
    let destinyTicks = [];
    try {
      destinyTicks = runDueDestinyTicks(this, now);
    } catch (error) {
      log.error(
        `[SpaceRuntime] Destiny tick failed for system=${this.systemID}: ` +
        `${error && error.stack ? error.stack : error}`,
      );
    }
    // BringOutTheDeads: the Balls a hit or an expiry removed inside
    // Evolve go now, before any gameplay reads the park; a hit missile stays,
    // moribund and stopped, for its delay.
    this.bringOutTheDeads();
    // The force-field boundary, against the slots the Evolves just left: a
    // ship that crossed into a field it may not enter is pushed out at the
    // next Destiny tick, through the queue.
    if (destinyTicks.length > 0) {
      this.checkForceFieldBoundaries(now);
    }
    flushDogmaReloadsAtSimTime(now);
    this.sweepStrandedDestinySessions(clockState.wallclockNowMs);
    // DoSimClockRebase mirrors native client sim-clock changes. Broadcasting
    // it as a periodic keepalive made Michelle's ball time run backwards, so
    // rebases are now limited to scene entry/bootstrap and explicit TiDi
    // changes until the native TiDi update path is reproduced.

    const settledStargates = this.settleTransientStargateActivationStates(
      clockState.wallclockNowMs,
    );
    if (settledStargates.length > 0) {
      this.broadcastSlimItemChanges(settledStargates);
    }

    const beltRatArrivalEvents = destinyTicks.flatMap((frame) => (
      frame.output ? frame.output.beltRatArrivalEvents : []
    ));
    const dockRequests = new Map();
    // The event world and Campaign Trail ticks each sit in their own try, so
    // a throw in one never skips the other or the rest of the tick.
    try {
      const eventWorldRuntime = lazyRequire("../services/seasons/eventWorldRuntime");
      eventWorldRuntime.tickScene(this);
    } catch (error) {
      log.warn(`[SpaceRuntime] Event world tick failed for system=${this.systemID}: ${error.message}`);
    }
    try {
      const eventHooks = lazyRequire("../services/seasons/eventHooks");
      eventHooks.trail.tickScene(this, now);
    } catch (error) {
      log.warn(`[SpaceRuntime] Campaign Trail tick failed for system=${this.systemID}: ${error.message}`);
    }
    try {
      const crimewatchState = lazyRequire("../services/security/crimewatchState");
      if (crimewatchState && typeof crimewatchState.tickScene === "function") {
        tickProfiler.section("crimewatch", () => crimewatchState.tickScene(this, now));
      }
    } catch (error) {
      log.warn(`[SpaceRuntime] Crimewatch tick failed for system=${this.systemID}: ${error.message}`);
    }
    try {
      // This scene clock owns both live score deadlines and due reinforcement
      // exits. Run it even when no link is currently active so a loaded system
      // enters its command-node campaign at the exact simulation time. The
      // adapter internally limits score ticks to authoritative active targets.
      const captureTickResult = tickProfiler.section(
        "sovereigntyCapture",
        () => entosisLinkRuntime.tickSovereigntyCaptureForScene(this, now),
      );
      if (!captureTickResult || captureTickResult.success === false) {
        log.warn(
          `[SpaceRuntime] Sovereignty capture tick failed for ` +
          `system=${this.systemID}: ${
            captureTickResult && captureTickResult.errorMsg || "UNKNOWN_ERROR"
          }`,
        );
      }
      if (sovereigntyCaptureTickRequiresStructureSync(captureTickResult)) {
        // Most ticks merely compare the exact completion deadline and do not
        // checkpoint a projection. Rebuild the static entity only when the
        // capture core reports a pivot, blocked completion, disappearance,
        // or completed claim. Completion still lands in this simulation tick
        // even when it occurs between long Entosis module-cycle boundaries.
        this.syncStructureEntitiesFromState();
      }
    } catch (error) {
      log.warn(
        `[SpaceRuntime] Sovereignty capture tick failed for ` +
        `system=${this.systemID}: ${error.message}`,
      );
    }
    try {
      const npcService = lazyRequire("./npc");
      if (npcService && typeof npcService.tickScene === "function") {
        tickProfiler.section("npc", () => npcService.tickScene(this, now));
      }
    } catch (error) {
      log.warn(`[SpaceRuntime] NPC tick failed for system=${this.systemID}: ${error.message}`);
    }
    try {
      const bountyRuntime = lazyRequire("../services/bounty/bountyRuntime");
      if (bountyRuntime && typeof bountyRuntime.tickScene === "function") {
        tickProfiler.section("bounty", () => bountyRuntime.tickScene(this, now));
      }
    } catch (error) {
      log.warn(`[SpaceRuntime] NPC bounty payout tick failed for system=${this.systemID}: ${error.message}`);
    }
    if (config.miningEnabled === true) {
      try {
        const miningRuntime = lazyRequire("../services/mining/miningRuntime");
        if (miningRuntime && typeof miningRuntime.tickScene === "function") {
          tickProfiler.section("mining", () => miningRuntime.tickScene(this, now));
        }
      } catch (error) {
        log.warn(`[SpaceRuntime] Mining tick failed for system=${this.systemID}: ${error.message}`);
      }
    }
    try {
      const droneRuntime = lazyRequire("../services/drone/droneRuntime");
      if (droneRuntime && typeof droneRuntime.tickScene === "function") {
        tickProfiler.section("drone", () => droneRuntime.tickScene(this, now));
      }
    } catch (error) {
      log.warn(`[SpaceRuntime] Drone tick failed for system=${this.systemID}: ${error.message}`);
    }
    try {
      const fighterRuntime = lazyRequire("../services/fighter/fighterRuntime");
      if (fighterRuntime && typeof fighterRuntime.tickScene === "function") {
        tickProfiler.section("fighter", () => fighterRuntime.tickScene(this, now));
      }
    } catch (error) {
      log.warn(`[SpaceRuntime] Fighter tick failed for system=${this.systemID}: ${error.message}`);
    }
    try {
      const HackingMgrService = lazyRequire("../services/exploration/hackingMgrService");
      if (HackingMgrService && typeof HackingMgrService.tickScene === "function") {
        tickProfiler.section("hacking", () => HackingMgrService.tickScene(this));
      }
    } catch (error) {
      log.warn(`[SpaceRuntime] Hacking tick failed for system=${this.systemID}: ${error.message}`);
    }
    if (config.wormholesEnabled === true) {
      try {
        const wormholeRuntime = lazyRequire("../services/exploration/wormholes/wormholeRuntime");
        if (wormholeRuntime && typeof wormholeRuntime.tickScene === "function") {
          tickProfiler.section("wormhole", () => wormholeRuntime.tickScene(this, now));
        }
      } catch (error) {
        log.warn(`[SpaceRuntime] Wormhole tick failed for system=${this.systemID}: ${error.message}`);
      }
    }
    try {
      tickProfiler.section("surveyProbe", () => surveyProbeRuntime.tickScene(this, now));
    } catch (error) {
      log.warn(`[SpaceRuntime] Survey Probe tick failed for system=${this.systemID}: ${error.message}`);
    }
    try {
      tickProfiler.section("superweapon", () => tickSuperweaponScene(
        this,
        now,
        buildSuperweaponRuntimeCallbacks(this, 0),
      ));
    } catch (error) {
      log.warn(`[SpaceRuntime] Superweapon tick failed for system=${this.systemID}: ${error.message}`);
    }
    try {
      tickProfiler.section("remoteRepair", () => remoteRepairShowRuntime.tickScene(this, now));
    } catch (error) {
      log.warn(`[SpaceRuntime] Remote repair show tick failed for system=${this.systemID}: ${error.message}`);
    }
    try {
      tickProfiler.section("tractorBeam", () => tractorBeamRuntime.tickScene(
        this,
        now,
        buildTractorBeamRuntimeCallbacks(this),
      ));
    } catch (error) {
      log.warn(`[SpaceRuntime] Tractor beam tick failed for system=${this.systemID}: ${error.message}`);
    }
    try {
      tickProfiler.section("mobileTractorUnit", () => mobileTractorUnitRuntime.tickScene(this, now));
    } catch (error) {
      log.warn(`[SpaceRuntime] Mobile Tractor Unit tick failed for system=${this.systemID}: ${error.message}`);
    }

    try {
      tickProfiler.section("starbaseDefense", () => tickStarbaseDefenseForScene(this, now));
    } catch (error) {
      log.warn(`[SpaceRuntime] Starbase defense tick failed for system=${this.systemID}: ${error.message}`);
    }
    // Breacher pods: each target's damage over time, on its 1 s cadence of
    // sim time, through the normal health and
    // destruction owners.
    try {
      tickProfiler.section("breacherPods", () => require("../../combat/breacherPods").tickScene(this, now));
    } catch (error) {
      log.warn(`[SpaceRuntime] Breacher pod tick failed for system=${this.systemID}: ${error.message}`);
    }
    // Per-subsystem profiler (EVEJS_TICK_PROFILE): split the post-subsystem scene
    // work into its sequential phases (entity loop / visibility / broadcast) so the
    // "other(movement/destiny)" bucket stays attributable.
    const __mvEntityLoopStart = tickProfiler.now();
    this.pruneExpiredCommandBurstBuffs(now);
    const controlledStaticStructureDogmaHosts = new Set(
      getControlledStaticStructureDogmaHosts(this),
    );
    const activeTickDynamicEntities = new Set(this.dynamicEntities.values());
    const activeTickDogmaHosts = [
      ...activeTickDynamicEntities,
      ...controlledStaticStructureDogmaHosts,
    ];
    for (const entity of activeTickDogmaHosts) {
      if (Array.isArray(entity.pendingModuleStopNotifications) && entity.pendingModuleStopNotifications.length > 0) {
        const flushSession = entity.session || getOwningSessionForEntity(this, entity);
        if (flushSession && isReadyForDestiny(flushSession)) {
          const pendingStops = entity.pendingModuleStopNotifications.splice(0);
          for (const pending of pendingStops) {
            if (pending.isPropulsion) {
              notifyModuleEffectState(flushSession, entity, pending.effectState, false, { whenMs: pending.stopTimeMs });
            } else {
              notifyGenericModuleEffectState(flushSession, entity, pending.effectState, false, { whenMs: pending.stopTimeMs });
            }
          }
        }
      }
      // A held overload request whose module is no longer cycling has nothing
      // left to wait for — the cycle it was waiting on ended when the pilot
      // switched the module off. Settle it here so the module is already hot
      // (or cold) the next time it is activated.
      if (
        entity.pendingOverloadModuleEffects instanceof Map &&
        entity.pendingOverloadModuleEffects.size > 0
      ) {
        for (const pendingModuleID of [...entity.pendingOverloadModuleEffects.keys()]) {
          if (
            entity.activeModuleEffects instanceof Map &&
            entity.activeModuleEffects.has(toInt(pendingModuleID, 0))
          ) {
            continue;
          }
          settlePendingOverloadModuleTransition(this, entity, pendingModuleID, now);
        }
      }
      if (entity.activeModuleEffects instanceof Map && entity.activeModuleEffects.size > 0) {
        const ownerSession = getOwningSessionForEntity(this, entity);
        for (const effectState of [...entity.activeModuleEffects.values()]) {
          if (!effectState) {
            continue;
          }
          if (effectState.careerEwarSpan) {
            hostileModuleRuntime.measureCareerHostileDuration({ scene: this, entity,
              effectState, nowMs: now, callbacks: buildHostileModuleRuntimeCallbacks(this) });
          }
          if (starbaseDefenseRuntime.isStarbaseBattery(entity)) {
            const valid = starbaseDefenseRuntime.validateBatteryOperation(entity.itemID);
            if (!valid.success) {
              starbaseDefenseRuntime.stopBattery(this, entity.itemID, {
                reason: valid.errorMsg,
              });
              continue;
            }
          }
          if (effectState.cloakModuleEffect === true) {
            effectState.durationMs = -1;
            effectState.nextCycleAtMs = Number.MAX_SAFE_INTEGER;
            continue;
          }
          if (
            effectState.commandBurstEffect === true &&
            isShipInsideForceField(this, entity, now)
          ) {
            if (ownerSession && isReadyForDestiny(ownerSession)) {
              this.finalizeGenericModuleDeactivation(
                ownerSession,
                effectState.moduleID,
                {
                  reason: "forceField",
                  nowMs: now,
                },
              );
            } else {
              finalizeGenericModuleDeactivationWithoutSession(
                this,
                entity,
                effectState,
                {
                  reason: "forceField",
                  nowMs: now,
                },
              );
            }
            continue;
          }

          const cycleBoundaryMs = getEffectCycleBoundaryMs(effectState, now);
          if (now < cycleBoundaryMs) {
            continue;
          }

          const isGenericEffect = Boolean(effectState.isGeneric);
          const finalizeDeactivation = isGenericEffect
            ? (sess, modID, opts) => this.finalizeGenericModuleDeactivation(sess, modID, opts)
            : (sess, modID, opts) => this.finalizePropulsionModuleDeactivation(sess, modID, opts);
          const notifyEffect = isGenericEffect
            ? notifyGenericModuleEffectState
            : notifyModuleEffectState;
          const moduleItem = getEntityRuntimeModuleItem(
            entity,
            effectState.moduleID,
            effectState.moduleFlagID,
          );

          // A deferred manual stop on an end-of-cycle module must still complete
          // the current cycle and deliver its final effect at the boundary (EVE
          // parity) before deactivating, rather than short-circuiting and
          // dropping it. Let it fall through to the normal cycle path below; it
          // is finalized after the effect is applied, and the stop cycle does
          // not charge capacitor/fuel for the next (non-existent) cycle. This
          // covers:
          //   - ice harvesters and ice mining lasers, which cannot be
          //     short-cycled and must deliver their full final-cycle yield (ice
          //     only lands when a cycle completes). Ore and gas modules —
          //     including the crystal-using modulated miners — short-cycle
          //     immediately in deactivateGenericModule and never set
          //     deactivateAtMs, so only ice reaches this branch among mining
          //     effects; and
          //   - end-of-cycle local-cycle repairers (armor, hull/structure, and
          //     ancillary armor repairers), whose final repair tick lands at the
          //     cycle end.
          // Start-of-cycle local-cycle effects (shield boosters, capacitor
          // boosters, ancillary shield boosters) already applied this cycle's
          // effect at its start, so they keep the immediate boundary finalize —
          // running another effect at the stop boundary would double-apply.
          // Weapons are intentionally excluded: a final-volley-on-stop change
          // touches combat parity and is out of scope here. Every other module
          // keeps the immediate boundary finalize.
          //   - Micro Jump Drives and Micro Jump Field Generators, which pay
          //     capacitor at activation and deliver the jump at the boundary.
          //     "Like other prop modules, the MJD cannot be deactivated before
          //     its cycle ends" and "Even if the jump fails, the module will
          //     still enter its cooldown period"
          //     (https://wiki.eveuniversity.org/Propulsion_equipment) — the
          //     pilot is committed the instant the button goes green. Without
          //     this, clicking the module off mid-spool finalized the
          //     deactivation before the cycle ran and silently cancelled the
          //     jump, which is a free abort of the module's entire risk.
          //   - Salvagers, which charge their 20 GJ at activation and resolve
          //     the access-difficulty roll only at the boundary. They are
          //     already classified MODULE_CONSEQUENCE_DELIVERY.BOUNDARY, and
          //     unlike a mining laser a salvager has nothing to short-cycle: a
          //     partial cycle produces no partial salvage. Without this the
          //     pilot clicking the module off mid-cycle spent the capacitor and
          //     the client kept the button locked for the rest of the cycle
          //     (`shipmodulebutton.DelayButtonUnlockForDeactivate`), while the
          //     server dropped the roll entirely and the wreck survived.
          const deferredStopDue =
            toFiniteNumber(effectState.deactivateAtMs, 0) > 0 &&
            toFiniteNumber(effectState.deactivateAtMs, 0) <= cycleBoundaryMs + 1 &&
            (
              effectState.miningEffect === true ||
              effectState.microJumpDriveEffect === true ||
              effectState.salvagerEffect === true ||
              (
                effectState.localCycleEffect === true &&
                effectState.localCycleTiming === "end"
              )
            );

          // Lifecycle accounting is deliberately separate from effectState.repeat,
          // which is the client-facing presentation value. Source authority only
          // establishes repeat=0 as a one-cycle request; all other values retain
          // their legacy unbounded behavior until GOLD-001 resolves finite values.
          // Existing module-specific auto-deactivation (cynos and command bursts)
          // continues through its established handler below.
          const consequenceDelivery = effectState.consequenceDelivery === undefined
            ? resolveModuleConsequenceDelivery(effectState)
            : normalizeModuleConsequenceDelivery(effectState.consequenceDelivery);
          const lifecycleTerminalBoundary =
            effectState.remainingCycles === 1 &&
            consequenceDelivery !== MODULE_CONSEQUENCE_DELIVERY.MANAGED &&
            effectState.autoDeactivateAtCycleEnd !== true;
          const lifecycleFinalEffectDue =
            lifecycleTerminalBoundary &&
            consequenceDelivery === MODULE_CONSEQUENCE_DELIVERY.BOUNDARY;
          // Not const: capacitor starvation on a boundary-delivery module is a
          // third way the completed cycle's consequence can be owed, and it is
          // only knowable once cycleCapNeed has been resolved below.
          let terminalFinalEffectDue =
            deferredStopDue || lifecycleFinalEffectDue;

          if (lifecycleTerminalBoundary && !lifecycleFinalEffectDue) {
            // Activation-delivered, continuous, and legacy-unknown effects keep
            // the Phase-A terminal behavior: apply the completed cycle's owed
            // heat, but do not enter reload, consume next-cycle resources, or
            // execute another consequence. Unknown families stay here until
            // lifecycle evidence establishes a different delivery class.
            const heatDamageResult = applyOverloadHeatDamageToModule(
              this,
              entity,
              moduleItem,
              effectState,
              cycleBoundaryMs,
            );
            if (!heatDamageResult.success) {
              log.warn(
                `[SpaceRuntime] Overload heat damage failed for ship=${toInt(entity && entity.itemID, 0)} ` +
                  `module=${toInt(effectState && effectState.moduleID, 0)} ` +
                  `error=${heatDamageResult.errorMsg || "UNKNOWN"}`,
              );
            }
            const terminalReason =
              heatDamageResult.success &&
              heatDamageResult.data &&
              heatDamageResult.data.burnedOut === true
                ? "heat"
                : "cycle";
            effectState.remainingCycles = 0;
            if (ownerSession && isReadyForDestiny(ownerSession)) {
              finalizeDeactivation(ownerSession, effectState.moduleID, {
                reason: terminalReason,
                nowMs: cycleBoundaryMs,
              });
            } else if (isGenericEffect) {
              finalizeGenericModuleDeactivationWithoutSession(
                this,
                entity,
                effectState,
                {
                  reason: terminalReason,
                  nowMs: cycleBoundaryMs,
                },
              );
            } else {
              entity.activeModuleEffects.delete(toInt(effectState.moduleID, 0));
            }
            continue;
          }

          if (toFiniteNumber(effectState.deactivateAtMs, 0) > 0 && !deferredStopDue) {
            if (ownerSession && isReadyForDestiny(ownerSession)) {
              finalizeDeactivation(
                ownerSession,
                effectState.moduleID,
                {
                  reason: effectState.stopReason || "manual",
                  nowMs: Math.max(
                    cycleBoundaryMs,
                    toFiniteNumber(effectState.deactivateAtMs, 0),
                  ),
                },
              );
            } else {
              if (isGenericEffect) {
                finalizeGenericModuleDeactivationWithoutSession(
                  this,
                  entity,
                  effectState,
                  {
                    reason: effectState.stopReason || "manual",
                    nowMs: Math.max(
                      cycleBoundaryMs,
                      toFiniteNumber(effectState.deactivateAtMs, 0),
                    ),
                  },
                );
              } else {
                entity.activeModuleEffects.delete(toInt(effectState.moduleID, 0));
              }
            }
            continue;
          }

          // The cycle that just ended ran at the strength it started with; the
          // cycle starting now is the one a held overload request belongs to.
          // Settle it before any next-cycle attributes are resolved below, so
          // duration, capacitor and projected strength all come out of the new
          // state — and keep the amount the completed cycle earned, for the
          // families that deliver theirs at the boundary.
          const completedCycleLocalState =
            effectState.localCycleEffect === true
              ? effectState.localCycleResolvedState || null
              : null;
          const overloadTransition = settlePendingOverloadModuleTransition(
            this,
            entity,
            effectState.moduleID,
            cycleBoundaryMs,
          );

          const localCycleCallbacks = effectState.localCycleEffect === true
            ? buildLocalCycleRuntimeCallbacks(
              toInt(ownerSession && ownerSession.characterID, 0),
            )
            : null;
          if (effectState.localCycleEffect === true) {
            const boundaryResult = prepareLocalCycleBoundary({
              entity,
              moduleItem,
              effectState,
              effectRecord: effectState.localCycleFamily || effectState.effectName,
              callbacks: localCycleCallbacks,
              nowMs: cycleBoundaryMs,
            });
            if (!boundaryResult.success) {
              if (ownerSession && isReadyForDestiny(ownerSession)) {
                finalizeDeactivation(ownerSession, effectState.moduleID, {
                  reason: boundaryResult.stopReason || "localCycle",
                  nowMs: cycleBoundaryMs,
                });
              } else {
                if (isGenericEffect) {
                  finalizeGenericModuleDeactivationWithoutSession(
                    this,
                    entity,
                    effectState,
                    {
                      reason: boundaryResult.stopReason || "localCycle",
                      nowMs: cycleBoundaryMs,
                    },
                  );
                } else {
                  entity.activeModuleEffects.delete(toInt(effectState.moduleID, 0));
                }
              }
              continue;
            }
            if (boundaryResult.waiting) {
              continue;
            }
          }

          if (isMissileWeaponFamily(effectState.weaponFamily)) {
            const reloadResult = effectState.pendingMissileBankReloads
              ? resolvePendingGroupedMissileReloads(
                entity,
                effectState,
                { nowMs: now },
              )
              : resolvePendingMissileReload(
                entity,
                effectState,
                moduleItem,
                { nowMs: now },
              );
            if (!reloadResult.success) {
              if (ownerSession && isReadyForDestiny(ownerSession)) {
                finalizeDeactivation(ownerSession, effectState.moduleID, {
                  reason: "ammo",
                  nowMs: cycleBoundaryMs,
                });
              } else {
                if (isGenericEffect) {
                  finalizeGenericModuleDeactivationWithoutSession(
                    this,
                    entity,
                    effectState,
                    {
                      reason: "ammo",
                      nowMs: cycleBoundaryMs,
                    },
                  );
                } else {
                  entity.activeModuleEffects.delete(toInt(effectState.moduleID, 0));
                }
              }
              continue;
            }
            if (reloadResult.waiting) {
              continue;
            }
            // CCP parity: reload completed — re-notify the client that the
            // module is active again so the HUD cycle ring resumes.
            if (
              effectState.pendingReloadReactivation &&
              ownerSession &&
              isReadyForDestiny(ownerSession)
            ) {
              effectState.pendingReloadReactivation = false;
              notifyEffect(ownerSession, entity, effectState, true, {
                whenMs: cycleBoundaryMs,
                startTimeMs: cycleBoundaryMs,
                repeatNotification: true,
              });
            }
          }
          if (
            effectState.commandBurstEffect === true &&
            effectState.pendingLocalReload
          ) {
            const reloadResult = resolvePendingLocalModuleReload(
              entity,
              effectState,
              moduleItem,
              {
                nowMs: now,
              },
            );
            if (!reloadResult.success) {
              if (ownerSession && isReadyForDestiny(ownerSession)) {
                finalizeDeactivation(ownerSession, effectState.moduleID, {
                  reason: "ammo",
                  nowMs: cycleBoundaryMs,
                });
              } else if (isGenericEffect) {
                finalizeGenericModuleDeactivationWithoutSession(
                  this,
                  entity,
                  effectState,
                  {
                    reason: "ammo",
                    nowMs: cycleBoundaryMs,
                  },
                );
              } else {
                entity.activeModuleEffects.delete(toInt(effectState.moduleID, 0));
              }
              continue;
            }
            if (reloadResult.waiting) {
              continue;
            }
          }
          if (
            entity.nativeNpc === true &&
            isTurretCycleWeaponFamily(effectState.weaponFamily) &&
            effectState.pendingLocalReload
          ) {
            const reloadResult = resolvePendingLocalModuleReload(
              entity,
              effectState,
              moduleItem,
              {
                nowMs: now,
              },
            );
            if (!reloadResult.success) {
              if (ownerSession && isReadyForDestiny(ownerSession)) {
                finalizeDeactivation(ownerSession, effectState.moduleID, {
                  reason: "ammo",
                  nowMs: cycleBoundaryMs,
                });
              } else if (isGenericEffect) {
                finalizeGenericModuleDeactivationWithoutSession(
                  this,
                  entity,
                  effectState,
                  {
                    reason: "ammo",
                    nowMs: cycleBoundaryMs,
                  },
                );
              } else {
                entity.activeModuleEffects.delete(toInt(effectState.moduleID, 0));
              }
              continue;
            }
            if (reloadResult.waiting) {
              continue;
            }
          }

          if (effectState.autoDeactivateAtCycleEnd === true) {
            if (ownerSession && isReadyForDestiny(ownerSession)) {
              finalizeDeactivation(ownerSession, effectState.moduleID, {
                reason: effectState.stopReason || "cycle",
                nowMs: cycleBoundaryMs,
              });
            } else if (isGenericEffect) {
              finalizeGenericModuleDeactivationWithoutSession(
                this,
                entity,
                effectState,
                {
                  reason: effectState.stopReason || "cycle",
                  nowMs: cycleBoundaryMs,
                },
              );
            } else {
              entity.activeModuleEffects.delete(toInt(effectState.moduleID, 0));
            }
            continue;
          }

          if (lifecycleFinalEffectDue) {
            // Record the finite lifecycle as terminal before a boundary handler
            // runs. Some handlers (notably successful Salvager cleanup) remove
            // their target synchronously, which can finalize this effect through
            // target-loss cleanup before control returns to the shared loop.
            effectState.remainingCycles = 0;
          }

          let miningRuntimeForCycle = null;
          let preparedMiningCycle = null;
          if (
            config.miningEnabled === true &&
            effectState &&
            effectState.miningEffect === true
          ) {
            try {
              miningRuntimeForCycle = lazyRequire("../services/mining/miningRuntime");
              const boundaryResult =
                miningRuntimeForCycle &&
                typeof miningRuntimeForCycle.prepareMiningCycleBoundary === "function"
                  ? miningRuntimeForCycle.prepareMiningCycleBoundary(
                    entity,
                    effectState,
                    cycleBoundaryMs,
                  )
                  : { success: false, stopReason: "mining" };
              if (!boundaryResult.success || !boundaryResult.data) {
                const stopReason = boundaryResult.stopReason || "mining";
                if (ownerSession && isReadyForDestiny(ownerSession)) {
                  finalizeDeactivation(ownerSession, effectState.moduleID, {
                    reason: stopReason,
                    nowMs: cycleBoundaryMs,
                  });
                } else if (isGenericEffect) {
                  finalizeGenericModuleDeactivationWithoutSession(
                    this,
                    entity,
                    effectState,
                    {
                      reason: stopReason,
                      nowMs: cycleBoundaryMs,
                    },
                  );
                } else {
                  entity.activeModuleEffects.delete(toInt(effectState.moduleID, 0));
                }
                continue;
              }
              preparedMiningCycle = boundaryResult.data;
            } catch (error) {
              log.warn(
                `[SpaceRuntime] Mining boundary preparation failed for entity=${toInt(entity && entity.itemID, 0)} ` +
                  `module=${toInt(effectState && effectState.moduleID, 0)}: ${error.message}`,
              );
              if (ownerSession && isReadyForDestiny(ownerSession)) {
                finalizeDeactivation(ownerSession, effectState.moduleID, {
                  reason: "mining",
                  nowMs: cycleBoundaryMs,
                });
              } else if (isGenericEffect) {
                finalizeGenericModuleDeactivationWithoutSession(
                  this,
                  entity,
                  effectState,
                  {
                    reason: "mining",
                    nowMs: cycleBoundaryMs,
                  },
                );
              } else {
                entity.activeModuleEffects.delete(toInt(effectState.moduleID, 0));
              }
              continue;
            }
          }

          if (
            effectState &&
            effectState.assistanceModuleEffect === true
          ) {
            const boundaryResult = resolveAssistanceCycleRuntimeSnapshot(
              this,
              entity,
              moduleItem,
              effectState,
              cycleBoundaryMs,
            );
            if (
              !boundaryResult ||
              boundaryResult.success !== true ||
              !boundaryResult.data ||
              !applyAssistanceCycleRuntimeSnapshot(
                effectState,
                boundaryResult.data,
              )
            ) {
              const stopReason =
                (boundaryResult && boundaryResult.stopReason) ||
                "assistance";
              if (ownerSession && isReadyForDestiny(ownerSession)) {
                finalizeDeactivation(ownerSession, effectState.moduleID, {
                  reason: stopReason,
                  nowMs: cycleBoundaryMs,
                });
              } else if (isGenericEffect) {
                finalizeGenericModuleDeactivationWithoutSession(
                  this,
                  entity,
                  effectState,
                  {
                    reason: stopReason,
                    nowMs: cycleBoundaryMs,
                  },
                );
              } else {
                entity.activeModuleEffects.delete(toInt(effectState.moduleID, 0));
              }
              continue;
            }
          }

          if (
            effectState &&
            effectState.salvagerEffect === true
          ) {
            const boundaryResult = resolveSalvagerCycleRuntimeSnapshot(
              this,
              entity,
              moduleItem,
              effectState,
              cycleBoundaryMs,
            );
            if (
              !boundaryResult ||
              boundaryResult.success !== true ||
              !boundaryResult.data ||
              !applySalvagerCycleRuntimeSnapshot(
                effectState,
                boundaryResult.data,
              )
            ) {
              const stopReason =
                (boundaryResult && boundaryResult.stopReason) ||
                "salvager";
              if (ownerSession && isReadyForDestiny(ownerSession)) {
                finalizeDeactivation(ownerSession, effectState.moduleID, {
                  reason: stopReason,
                  nowMs: cycleBoundaryMs,
                });
              } else if (isGenericEffect) {
                finalizeGenericModuleDeactivationWithoutSession(
                  this,
                  entity,
                  effectState,
                  {
                    reason: stopReason,
                    nowMs: cycleBoundaryMs,
                  },
                );
              } else {
                entity.activeModuleEffects.delete(toInt(effectState.moduleID, 0));
              }
              continue;
            }
          }

          if (
            effectState &&
            effectState.jammerModuleEffect === true
          ) {
            const boundaryResult = resolveJammerCycleRuntimeSnapshot(
              this,
              entity,
              moduleItem,
              effectState,
              cycleBoundaryMs,
            );
            if (
              !boundaryResult ||
              boundaryResult.success !== true ||
              !boundaryResult.data ||
              !applyJammerCycleRuntimeSnapshot(
                effectState,
                boundaryResult.data,
              )
            ) {
              const stopReason =
                (boundaryResult && boundaryResult.stopReason) ||
                "jammer";
              if (ownerSession && isReadyForDestiny(ownerSession)) {
                finalizeDeactivation(ownerSession, effectState.moduleID, {
                  reason: stopReason,
                  nowMs: cycleBoundaryMs,
                });
              } else if (isGenericEffect) {
                finalizeGenericModuleDeactivationWithoutSession(
                  this,
                  entity,
                  effectState,
                  {
                    reason: stopReason,
                    nowMs: cycleBoundaryMs,
                  },
                );
              } else {
                entity.activeModuleEffects.delete(toInt(effectState.moduleID, 0));
              }
              continue;
            }
          }

          if (
            effectState &&
            effectState.hostileModuleEffect === true
          ) {
            const boundaryResult = resolveHostileCycleRuntimeSnapshot(
              this,
              entity,
              moduleItem,
              effectState,
              cycleBoundaryMs,
            );
            if (
              !boundaryResult ||
              boundaryResult.success !== true ||
              !boundaryResult.data ||
              !applyHostileCycleRuntimeSnapshot(
                effectState,
                boundaryResult.data,
              )
            ) {
              const stopReason =
                (boundaryResult && boundaryResult.stopReason) ||
                "hostile";
              if (ownerSession && isReadyForDestiny(ownerSession)) {
                finalizeDeactivation(ownerSession, effectState.moduleID, {
                  reason: stopReason,
                  nowMs: cycleBoundaryMs,
                });
              } else if (isGenericEffect) {
                finalizeGenericModuleDeactivationWithoutSession(
                  this,
                  entity,
                  effectState,
                  {
                    reason: stopReason,
                    nowMs: cycleBoundaryMs,
                  },
                );
              } else {
                entity.activeModuleEffects.delete(toInt(effectState.moduleID, 0));
              }
              continue;
            }
          }

          if (effectState && effectState.commandBurstEffect === true) {
            const weaponTimerPreflight = recordCommandBurstWeaponTimer(
              this,
              entity,
              cycleBoundaryMs,
              { dryRun: true },
            );
            if (!weaponTimerPreflight || weaponTimerPreflight.success !== true) {
              const stopReason = "crimewatch";
              if (ownerSession && isReadyForDestiny(ownerSession)) {
                finalizeDeactivation(ownerSession, effectState.moduleID, {
                  reason: stopReason,
                  nowMs: cycleBoundaryMs,
                });
              } else if (isGenericEffect) {
                finalizeGenericModuleDeactivationWithoutSession(
                  this,
                  entity,
                  effectState,
                  {
                    reason: stopReason,
                    nowMs: cycleBoundaryMs,
                  },
                );
              } else {
                entity.activeModuleEffects.delete(toInt(effectState.moduleID, 0));
              }
              continue;
            }
          }

          const cycleCapNeed = preparedMiningCycle && preparedMiningCycle.snapshot
            ? Math.max(
              0,
              toFiniteNumber(
                preparedMiningCycle.snapshot.capNeed,
                effectState.capNeed,
              ),
            )
            : Math.max(0, toFiniteNumber(effectState.capNeed, 0));
          const previousChargeAmount = getEntityCapacitorAmount(entity);
          // EVE parity: "A module that is already running will not stop working
          // immediately when you run out of capacitor, but will instead run to
          // the end of its current cycle, and then switch off."
          // (https://wiki.eveuniversity.org/Capacitor)
          //
          // The cycle that just ended was paid for at ITS start, so its
          // consequence is owed here. MODULE_CONSEQUENCE_DELIVERY.BOUNDARY is
          // the engine's own name for exactly that contract — "pays at
          // activation, delivers its authoritative outcome only when that paid
          // cycle reaches its boundary" — so it is the condition, rather than a
          // hand-maintained list of families. An ACTIVATION family (shield
          // booster, capacitor booster, ancillary shield booster, weapons,
          // smartbombs, jammers, remote reps) already ran its handler at
          // activation and the boundary handler would be delivering the NEXT
          // cycle, which the empty bank has not bought; a CONTINUOUS family
          // (tractor beam, webs, sensor boosts) does its work between the
          // boundaries and has nothing owed at one. Neither must be paid twice.
          //
          // Measured, each family fixed here failing on the pre-fix runtime:
          //   - Medium Armor Repairer II, 240 GJ bank: armorDamage held at 0.6
          //     for the full 12 s cycle and the module then stopped for
          //     capacitor with 0.6 still on the clock — 368 HP bought and never
          //     delivered (family 33);
          //   - Salvager I on an Angel Small Wreck, 30 GJ bank: zero access
          //     rolls at the starved boundary, and unlike a mining laser a
          //     salvager has no partial payout to fall back on (family 25 fixed
          //     the manual-stop twin of this);
          //   - Miner II on Veldspar, 27 GJ bank: zero units of ore for a paid
          //     15 s cycle. This is not the short-cycle path — at a starvation
          //     boundary the cycle is 100% complete, so there is nothing to
          //     pro-rate; the partial payout in deactivateGenericModule is
          //     reached only by a manual stop.
          // Micro jump drives and cargo/ship scanners are in the BOUNDARY class
          // but cannot reach this line: every published type declares
          // disallowRepeatingActivation, which pins remainingCycles to 1, so
          // lifecycleFinalEffectDue has already set terminalFinalEffectDue at
          // the first boundary and no next-cycle charge is attempted at all.
          //
          // The engine already models "deliver the completed cycle, charge
          // nothing for the next one, then switch off": it is what a deferred
          // manual stop does. Capacitor starvation is the same terminal shape,
          // so it joins terminalFinalEffectDue rather than growing a parallel
          // path.
          const capacitorStarvedFinalEffectDue =
            !terminalFinalEffectDue &&
            cycleCapNeed > previousChargeAmount + 1e-6 &&
            consequenceDelivery === MODULE_CONSEQUENCE_DELIVERY.BOUNDARY;
          if (capacitorStarvedFinalEffectDue) {
            terminalFinalEffectDue = true;
          }
          if (!terminalFinalEffectDue && cycleCapNeed > previousChargeAmount + 1e-6) {
            if (entity.session && isReadyForDestiny(entity.session)) {
              notifyCapacitorChangeToSession(
                entity.session,
                entity,
                now,
                previousChargeAmount,
              );
              finalizeDeactivation(entity.session, effectState.moduleID, {
                reason: "capacitor",
                nowMs: cycleBoundaryMs,
              });
            } else {
              if (isGenericEffect) {
                finalizeGenericModuleDeactivationWithoutSession(
                  this,
                  entity,
                  effectState,
                  {
                    reason: "capacitor",
                    nowMs: cycleBoundaryMs,
                  },
                );
              } else {
                entity.activeModuleEffects.delete(toInt(effectState.moduleID, 0));
              }
            }
            continue;
          }
          const cycleFuelConsumptionResult = terminalFinalEffectDue
            ? { success: true }
            : consumeShipModuleFuelForSession(
              ownerSession,
              entity,
              effectState.fuelTypeID,
              effectState.fuelPerActivation,
            );
          if (!cycleFuelConsumptionResult.success) {
            if (entity.session && isReadyForDestiny(entity.session)) {
              finalizeDeactivation(entity.session, effectState.moduleID, {
                reason: "fuel",
                nowMs: cycleBoundaryMs,
              });
            } else if (isGenericEffect) {
              finalizeGenericModuleDeactivationWithoutSession(
                this,
                entity,
                effectState,
                {
                  reason: "fuel",
                  nowMs: cycleBoundaryMs,
                },
              );
            } else {
              entity.activeModuleEffects.delete(toInt(effectState.moduleID, 0));
            }
            continue;
          }
          if (!terminalFinalEffectDue && !consumeEntityCapacitor(entity, cycleCapNeed)) {
            if (entity.session && isReadyForDestiny(entity.session)) {
              notifyCapacitorChangeToSession(
                entity.session,
                entity,
                now,
                previousChargeAmount,
              );
              finalizeDeactivation(entity.session, effectState.moduleID, {
                reason: "capacitor",
                nowMs: cycleBoundaryMs,
              });
            } else {
              if (isGenericEffect) {
                finalizeGenericModuleDeactivationWithoutSession(
                  this,
                  entity,
                  effectState,
                  {
                    reason: "capacitor",
                    nowMs: cycleBoundaryMs,
                  },
                );
              } else {
                entity.activeModuleEffects.delete(toInt(effectState.moduleID, 0));
              }
            }
            continue;
          }
          // CCP parity: Update the client's capacitor gauge each cycle.
          if (!terminalFinalEffectDue && entity.session && isReadyForDestiny(entity.session)) {
            notifyCapacitorChangeToSession(
              entity.session,
              entity,
              now,
              previousChargeAmount,
            );
          }

          let cycleStopReason = null;
          let cycleExecutedForHeat = true;
          let nextMiningCycleRuntimeAttrs = null;
          if (
            effectState &&
            effectState.localCycleEffect === true
          ) {
            // An end-of-cycle repairer delivers at this boundary what the cycle
            // that just ran earned. The boundary resolve above has already moved
            // the state to the cycle starting now, so an overload that starts
            // here would otherwise pay its bonus out one cycle early. Lend the
            // completed cycle's amounts back for the delivery and hand the new
            // state straight back — everything else (charge, reload) belongs to
            // the cycle starting now and stays on the fresh state.
            let restoreLocalCycleResolvedState = null;
            if (
              overloadTransition.applied &&
              completedCycleLocalState &&
              completedCycleLocalState.applicationTiming === "end" &&
              effectState.localCycleResolvedState
            ) {
              restoreLocalCycleResolvedState = effectState.localCycleResolvedState;
              effectState.localCycleResolvedState = {
                ...restoreLocalCycleResolvedState,
                armorRepairAmount: completedCycleLocalState.armorRepairAmount,
                shieldBoostAmount: completedCycleLocalState.shieldBoostAmount,
                structureRepairAmount: completedCycleLocalState.structureRepairAmount,
              };
            }
            const cycleResult = executeLocalCycle({
              scene: this,
              session: ownerSession,
              entity,
              moduleItem,
              effectState,
              nowMs: cycleBoundaryMs,
              callbacks: localCycleCallbacks,
            });
            if (restoreLocalCycleResolvedState) {
              effectState.localCycleResolvedState = restoreLocalCycleResolvedState;
            }
            if (!cycleResult.success) {
              cycleExecutedForHeat = false;
              cycleStopReason = cycleResult.stopReason || "localCycle";
            } else if (
              !terminalFinalEffectDue &&
              cycleResult.data &&
              cycleResult.data.reloadState
            ) {
              effectState.pendingLocalReload = cycleResult.data.reloadState;
              effectState.startedAtMs = cycleBoundaryMs;
              effectState.nextCycleAtMs = Math.max(
                cycleBoundaryMs,
                Number(cycleResult.data.reloadState.completeAtMs) || cycleBoundaryMs,
              );
              continue;
            }
            // When the stop is deferred, an ancillary repairer that just spent
            // its last charge on this final cycle must NOT begin reloading — the
            // pilot asked it to stop. Fall through to the deferred-stop finalize
            // below; the boosted final repair has already been applied.
          } else if (
            config.miningEnabled === true &&
            effectState &&
            effectState.miningEffect === true
          ) {
            try {
              if (
                miningRuntimeForCycle &&
                typeof miningRuntimeForCycle.executeMiningCycle === "function"
              ) {
                const cycleResult = miningRuntimeForCycle.executeMiningCycle(
                  this,
                  entity,
                  effectState,
                  cycleBoundaryMs,
                  { preparedCycle: preparedMiningCycle },
                );
                if (!cycleResult.success) {
                  cycleExecutedForHeat = false;
                  cycleStopReason = cycleResult.stopReason || "mining";
                } else if (cycleResult.data) {
                  nextMiningCycleRuntimeAttrs =
                    cycleResult.data.nextCycleRuntimeAttrs || null;
                  if (cycleResult.data.stopReason) {
                    cycleStopReason = cycleResult.data.stopReason;
                  } else if (cycleResult.data.depleted === true) {
                    cycleStopReason = "miningDepleted";
                  }
                }
              } else {
                cycleExecutedForHeat = false;
                cycleStopReason = "mining";
              }
            } catch (error) {
              cycleExecutedForHeat = false;
              log.warn(
                `[SpaceRuntime] Mining cycle failed for entity=${toInt(entity && entity.itemID, 0)} ` +
                  `module=${toInt(effectState && effectState.moduleID, 0)}: ${error.message}`,
              );
              cycleStopReason = "mining";
            }
          } else if (
            effectState &&
            effectState.commandBurstEffect === true
          ) {
            const cycleResult = executeCommandBurstCycle(
              this,
              ownerSession,
              entity,
              moduleItem,
              effectState,
              cycleBoundaryMs,
              { weaponTimerPreflightPassed: true },
            );
            if (!cycleResult.success) {
              cycleExecutedForHeat = false;
              cycleStopReason = cycleResult.stopReason || "commandBurst";
            } else if (cycleResult.data && cycleResult.data.reloadState) {
              effectState.pendingLocalReload = cycleResult.data.reloadState;
              effectState.startedAtMs = cycleBoundaryMs;
              effectState.nextCycleAtMs = Math.max(
                cycleBoundaryMs,
                Number(cycleResult.data.reloadState.completeAtMs) || cycleBoundaryMs,
              );
              continue;
            } else if (cycleResult.data && cycleResult.data.stopReason) {
              cycleStopReason = cycleResult.data.stopReason;
            }
          } else if (
            effectState &&
            effectState.pointDefenseEffect === true
          ) {
            const cycleResult = pointDefenseRuntime.executePointDefenseCycle({
              scene: this,
              entity,
              moduleItem,
              effectState,
              nowMs: cycleBoundaryMs,
              callbacks: buildPointDefenseRuntimeCallbacks(this),
            });
            if (!cycleResult.success) {
              cycleExecutedForHeat = false;
              cycleStopReason = cycleResult.stopReason || "pointDefense";
            } else if (cycleResult.data && cycleResult.data.stopReason) {
              cycleStopReason = cycleResult.data.stopReason;
            }
          } else if (
            effectState &&
            effectState.smartbombEffect === true
          ) {
            const cycleResult = smartbombRuntime.executeSmartbombCycle({
              scene: this,
              entity,
              moduleItem,
              effectState,
              nowMs: cycleBoundaryMs,
              callbacks: buildSmartbombRuntimeCallbacks(this),
            });
            if (!cycleResult.success) {
              cycleExecutedForHeat = false;
              cycleStopReason = cycleResult.stopReason || "smartbomb";
            }
          } else if (
            effectState &&
            reactiveArmorHardenerRuntime.isReactiveArmorHardenerEffectState(effectState)
          ) {
            const cycleResult =
              reactiveArmorHardenerRuntime.executeReactiveArmorHardenerCycle({
                entity,
                moduleItem,
                effectState,
              });
            // Only republish when the profile actually moved: an undamaged
            // cycle leaves it alone, and this runs every 10 seconds per ship.
            if (cycleResult.data && cycleResult.data.resonancesChanged === true) {
              this.refreshShipEntityDerivedState(entity, {
                session: ownerSession,
                broadcast: true,
              });
            }
          } else if (
            effectState &&
            effectState.autoTargetingEffect === true
          ) {
            const cycleResult = targetingModuleRuntime.executeAutoTargetingCycle({
              scene: this,
              entity,
              effectState,
              nowMs: cycleBoundaryMs,
              callbacks: buildAutoTargetingRuntimeCallbacks(this),
            });
            if (!cycleResult.success) {
              cycleExecutedForHeat = false;
              cycleStopReason = cycleResult.stopReason || "autoTargeting";
            }
          } else if (
            effectState &&
            entosisLinkRuntime.isEntosisLinkEffectState(effectState)
          ) {
            const cycleResult = entosisLinkRuntime.executeEntosisLinkCycle({
              scene: this,
              entity,
              effectState,
              nowMs: cycleBoundaryMs,
              isTargetLocked: isEntityLockedTarget,
            });
            if (!cycleResult.success) {
              cycleExecutedForHeat = false;
              cycleStopReason = cycleResult.stopReason || "entosisLink";
            } else if (
              cycleResult.data &&
              cycleResult.data.captureScoringStarted === true
            ) {
              this.syncStructureEntitiesFromState();
            }
          } else if (
            effectState &&
            scannerModuleRuntime.isScannerEffectState(effectState)
          ) {
            const cycleResult = scannerModuleRuntime.executeScannerCycle({
              entity,
              effectState,
              session: ownerSession,
              callbacks: buildScannerRuntimeCallbacks(this),
            });
            if (!cycleResult.success) {
              cycleExecutedForHeat = false;
              cycleStopReason = cycleResult.stopReason || "scanner";
            }
          } else if (
            effectState &&
            effectState.assistanceModuleEffect === true
          ) {
            const cycleResult = assistanceModuleRuntime.executeAssistanceModuleCycle({
              scene: this,
              session: ownerSession,
              entity,
              effectState,
              nowMs: cycleBoundaryMs,
              callbacks: buildAssistanceModuleRuntimeCallbacks(this),
            });
            if (!cycleResult.success) {
              cycleExecutedForHeat = false;
              cycleStopReason = cycleResult.stopReason || "assistance";
            } else {
              const targetEntity =
                cycleResult.data && cycleResult.data.targetEntity
                  ? cycleResult.data.targetEntity
                  : this.getEntityByID(toInt(effectState.targetID, 0));
              const targetSession = targetEntity && targetEntity.session ? targetEntity.session : null;
              if (targetEntity && cycleResult.data && cycleResult.data.aggregateChanged) {
                this.refreshShipEntityDerivedState(targetEntity, {
                  session: targetSession,
                  broadcast: true,
                  notifyTargeting: true,
                });
              }
              if (!cycleStopReason) {
                const hudSyncResult = targetEntity
                  ? hudIconRuntime.upsertHudIconState(
                    targetEntity,
                    buildAssistanceHudState(
                      targetEntity,
                      entity,
                      effectState,
                      cycleBoundaryMs,
                    ),
                  )
                  : { state: null };
                if (
                  targetSession &&
                  isReadyForDestiny(targetSession) &&
                  hudSyncResult.state
                ) {
                  notifyAssistanceHudStateToSession(
                    targetSession,
                    hudSyncResult.state,
                    true,
                    {
                      startTimeMs: cycleBoundaryMs,
                      durationMs: Math.max(
                        1,
                        toInt(effectState.durationMs, 1000) +
                          ASSISTANCE_JAM_REFRESH_GRACE_MS,
                      ),
                      refreshTimerOnly: true,
                    },
                  );
                }
              }
            }
          } else if (
            effectState &&
            effectState.jammerModuleEffect === true
          ) {
            const cycleResult = jammerModuleRuntime.executeJammerModuleCycle({
              scene: this,
              entity,
              effectState,
              nowMs: cycleBoundaryMs,
              callbacks: buildJammerModuleRuntimeCallbacks(this),
            });
            if (!cycleResult.success) {
              cycleExecutedForHeat = false;
              cycleStopReason = cycleResult.stopReason || "jammer";
            } else {
              applyJammerCyclePresentation(
                this,
                entity,
                effectState,
                cycleBoundaryMs,
                cycleResult,
              );
              noteDroneAssistSuccessfulOffensiveCycle(
                this,
                entity,
                effectState,
                cycleResult,
                "jammer",
                cycleBoundaryMs,
              );
            }
          } else if (
            effectState &&
            effectState.jammerBurstEffect === true
          ) {
            const cycleResult = jammerModuleRuntime.executeJammerBurstCycle({
              scene: this,
              entity,
              effectState,
              nowMs: cycleBoundaryMs,
              callbacks: buildJammerModuleRuntimeCallbacks(this),
            });
            if (!cycleResult.success) {
              cycleExecutedForHeat = false;
              cycleStopReason = cycleResult.stopReason || "jammerBurst";
            }
          } else if (
            effectState &&
            effectState.hostileModuleEffect === true
          ) {
            const cycleResult = hostileModuleRuntime.executeHostileModuleCycle({
              scene: this,
              session: ownerSession,
              entity,
              effectState,
              nowMs: cycleBoundaryMs,
              callbacks: buildHostileModuleRuntimeCallbacks(this),
            });
            if (!cycleResult.success) {
              cycleExecutedForHeat = false;
              cycleStopReason = cycleResult.stopReason || "hostile";
            } else {
              const targetEntity =
                cycleResult.data && cycleResult.data.targetEntity
                  ? cycleResult.data.targetEntity
                  : this.getEntityByID(toInt(effectState.targetID, 0));
              const targetSession = targetEntity && targetEntity.session ? targetEntity.session : null;
              if (targetEntity && cycleResult.data && cycleResult.data.aggregateChanged) {
                this.refreshShipEntityDerivedState(targetEntity, {
                  session: targetSession,
                  broadcast: true,
                  notifyTargeting: true,
                });
                const scrambledWhileAligning =
                  isAligningForWarp(targetEntity) &&
                  hostileModuleRuntime.isEntityWarpScrambled(targetEntity);
                if (
                  hostileModuleRuntime.isMicrowarpdriveBlocked(targetEntity) ||
                  hostileModuleRuntime.isMicroJumpDriveBlocked(targetEntity) ||
                  scrambledWhileAligning
                ) {
                  forceDeactivateBlockedMovementEffects(this, targetEntity, cycleBoundaryMs, "scram");
                }
                // A scramble ends a warp still aligning: the ship stops,
                // through the queue, before its Evolve can take it into warp.
                if (scrambledWhileAligning) {
                  this.stopShipEntity(targetEntity, {
                    nowMs: cycleBoundaryMs,
                    reason: "warpScrambled",
                  });
                }
              }
              const hudSyncResult = targetEntity
                ? hudIconRuntime.upsertHudIconState(
                  targetEntity,
                  buildHostileHudState(targetEntity, entity, effectState, cycleBoundaryMs),
                )
                : { state: null };
              if (targetSession && isReadyForDestiny(targetSession) && hudSyncResult.state) {
                notifyHostileHudStateToSession(targetSession, hudSyncResult.state, true, {
                  startTimeMs: cycleBoundaryMs,
                  durationMs: resolveHostileJamRefreshDurationMs(effectState),
                  refreshTimerOnly: true,
                });
              }
              noteDroneAssistSuccessfulOffensiveCycle(
                this,
                entity,
                effectState,
                cycleResult,
                "hostile",
                cycleBoundaryMs,
              );
            }
          } else if (
            effectState &&
            effectState.salvagerEffect === true
          ) {
            const cycleResult = salvagerRuntime.executeSalvagerCycle({
              scene: this,
              entity,
              effectState,
              nowMs: cycleBoundaryMs,
              callbacks: buildSalvagerRuntimeCallbacks(this),
            });
            if (!cycleResult.success) {
              cycleExecutedForHeat = Boolean(
                cycleResult.data && cycleResult.data.salvaged === true,
              );
              cycleStopReason = cycleResult.stopReason || "salvager";
            }
          } else if (
            effectState &&
            effectState.tractorBeamEffect === true
          ) {
            const cycleResult = tractorBeamRuntime.executeTractorBeamCycle({
              scene: this,
              entity,
              effectState,
              callbacks: buildTractorBeamRuntimeCallbacks(this),
            });
            if (!cycleResult.success) {
              cycleExecutedForHeat = false;
              cycleStopReason = cycleResult.stopReason || "tractor";
            }
          } else if (
            effectState &&
            effectState.microJumpDriveEffect === true
          ) {
            const cycleResult = microJumpDriveRuntime.executeMicroJumpDriveCycle({
              scene: this,
              entity,
              effectState,
              nowMs: cycleBoundaryMs,
              callbacks: buildMicroJumpDriveRuntimeCallbacks(this),
            });
            if (!cycleResult.success) {
              cycleExecutedForHeat = false;
              cycleStopReason = cycleResult.stopReason || "microJumpDrive";
            } else if (cycleResult.data && cycleResult.data.stopReason) {
              cycleStopReason = cycleResult.data.stopReason;
            }
          } else if (isSnapshotWeaponFamily(effectState.weaponFamily)) {
            const cycleResult = isTurretCycleWeaponFamily(effectState.weaponFamily)
              ? executeTurretCycle(
                this,
                entity,
                effectState,
                cycleBoundaryMs,
              )
              : executeMissileCycle(
                this,
                entity,
                effectState,
                cycleBoundaryMs,
                {
                  deferUntilVisibilitySync: true,
                },
              );
            noteDroneAssistSuccessfulOffensiveCycle(
              this,
              entity,
              effectState,
              cycleResult,
              isTurretCycleWeaponFamily(effectState.weaponFamily)
                ? "turret"
                : "missile",
              cycleBoundaryMs,
            );
            if (!cycleResult.success) {
              cycleExecutedForHeat = false;
              cycleStopReason = cycleResult.stopReason || "weapon";
            } else if (cycleResult.data) {
              if (
                cycleResult.data.reloadState ||
                cycleResult.data.bankReloadStates
              ) {
                if (isTurretCycleWeaponFamily(effectState.weaponFamily)) {
                  effectState.pendingLocalReload = cycleResult.data.reloadState;
                } else {
                  effectState.pendingMissileReload =
                    cycleResult.data.bankReloadStates
                      ? null
                      : cycleResult.data.reloadState;
                  effectState.pendingMissileBankReloads =
                    cycleResult.data.bankReloadStates || null;
                }
                const reloadCompletionAtMs =
                  cycleResult.data.bankReloadStates
                    ? Math.max(
                      ...cycleResult.data.bankReloadStates.map(
                        (reloadState) =>
                          Number(reloadState && reloadState.completeAtMs) || cycleBoundaryMs,
                      ),
                      cycleBoundaryMs,
                    )
                    : Number(cycleResult.data.reloadState && cycleResult.data.reloadState.completeAtMs) || cycleBoundaryMs;
                effectState.startedAtMs = cycleBoundaryMs;
                effectState.nextCycleAtMs = Math.max(
                  cycleBoundaryMs,
                  reloadCompletionAtMs,
                );
                if (!isTurretCycleWeaponFamily(effectState.weaponFamily)) {
                  // CCP parity: missile launcher deactivates visually while
                  // reloading. The module stays in activeModuleEffects so the
                  // reload can complete and auto-resume, but the client must
                  // see active=0 during the reload window.
                  effectState.pendingReloadReactivation = true;
                  if (ownerSession && isReadyForDestiny(ownerSession)) {
                    notifyEffect(ownerSession, entity, effectState, false, {
                      whenMs: cycleBoundaryMs,
                    });
                  }
                }
                continue;
              }
              if (
                (
                  cycleResult.data.destroyResult &&
                  cycleResult.data.destroyResult.success
                ) ||
                (
                  cycleResult.data.damageResult &&
                  cycleResult.data.damageResult.success &&
                  cycleResult.data.damageResult.data &&
                  cycleResult.data.damageResult.data.destroyed
                )
              ) {
                cycleStopReason = "target";
              } else if (cycleResult.data.stopReason) {
                cycleStopReason = cycleResult.data.stopReason;
              }
            }
          }
          if (cycleExecutedForHeat) {
            const heatDamageResult = applyOverloadHeatDamageToModule(
              this,
              entity,
              moduleItem,
              effectState,
              cycleBoundaryMs,
              {
                overloadedForCompletedCycle: overloadTransition.applied
                  ? overloadTransition.active !== true
                  : undefined,
              },
            );
            if (!heatDamageResult.success) {
              log.warn(
                `[SpaceRuntime] Overload heat damage failed for ship=${toInt(entity && entity.itemID, 0)} ` +
                  `module=${toInt(effectState && effectState.moduleID, 0)} ` +
                  `error=${heatDamageResult.errorMsg || "UNKNOWN"}`,
              );
            } else if (
              heatDamageResult.data &&
              heatDamageResult.data.burnedOut === true &&
              !cycleStopReason
            ) {
              cycleStopReason = "heat";
            }
          }
          if (
            !(entity.activeModuleEffects instanceof Map) ||
            entity.activeModuleEffects.get(toInt(effectState.moduleID, 0)) !== effectState
          ) {
            // A family handler may have synchronously finalized this exact
            // effect (for example when a successfully salvaged wreck is removed
            // and target-loss cleanup runs). Owed heat has landed; do not emit a
            // second stop/finalization from the shared loop.
            continue;
          }
          if (cycleStopReason) {
            if (lifecycleFinalEffectDue) {
              effectState.remainingCycles = 0;
            }
            if (entity && entity.nativeNpc === true) {
              logNpcCombatDebug("npc.weapons.cycle-stop", {
                entity: summarizeNpcCombatEntity(entity),
                moduleItem: summarizeNpcCombatModule(moduleItem),
                targetID: toInt(effectState && effectState.targetID, 0),
                weaponFamily: String(effectState.weaponFamily || ""),
                reason: String(cycleStopReason || "weapon"),
                cycleBoundaryMs: roundNumber(toFiniteNumber(cycleBoundaryMs, 0), 3),
                pendingMissileReload:
                  effectState && effectState.pendingMissileReload
                    ? effectState.pendingMissileReload
                    : null,
                pendingLocalReload:
                  effectState && effectState.pendingLocalReload
                    ? effectState.pendingLocalReload
                    : null,
              });
            }
            if (entity.session && isReadyForDestiny(entity.session)) {
              finalizeDeactivation(entity.session, effectState.moduleID, {
                reason: cycleStopReason,
                nowMs: cycleBoundaryMs,
              });
            } else {
              if (isGenericEffect) {
                finalizeGenericModuleDeactivationWithoutSession(
                  this,
                  entity,
                  effectState,
                  {
                    reason: cycleStopReason,
                    nowMs: cycleBoundaryMs,
                  },
                );
              } else {
                entity.activeModuleEffects.delete(toInt(effectState.moduleID, 0));
              }
            }
            continue;
          }

          if (terminalFinalEffectDue) {
            // The already-paid-for final consequence — mining yield, salvage
            // roll, or end-of-cycle repair — has now landed. Complete the
            // deferred manual stop, the repeat=0 lifecycle, or the
            // capacitor-starved stop without starting or charging another cycle.
            if (lifecycleFinalEffectDue) {
              effectState.remainingCycles = 0;
            }
            const stopAtMs = deferredStopDue
              ? Math.max(
                cycleBoundaryMs,
                toFiniteNumber(effectState.deactivateAtMs, 0),
              )
              : cycleBoundaryMs;
            const terminalReason = deferredStopDue
              ? effectState.stopReason || "manual"
              : capacitorStarvedFinalEffectDue
                ? "capacitor"
                : "cycle";
            if (ownerSession && isReadyForDestiny(ownerSession)) {
              finalizeDeactivation(ownerSession, effectState.moduleID, {
                reason: terminalReason,
                nowMs: stopAtMs,
              });
            } else if (isGenericEffect) {
              finalizeGenericModuleDeactivationWithoutSession(
                this,
                entity,
                effectState,
                {
                  reason: terminalReason,
                  nowMs: stopAtMs,
                },
              );
            } else {
              entity.activeModuleEffects.delete(toInt(effectState.moduleID, 0));
            }
            continue;
          }

          if (nextMiningCycleRuntimeAttrs) {
            effectState.capNeed = Math.max(
              0,
              toFiniteNumber(
                nextMiningCycleRuntimeAttrs.capNeed,
                effectState.capNeed,
              ),
            );
            effectState.durationMs = Math.max(
              1,
              toFiniteNumber(
                nextMiningCycleRuntimeAttrs.durationMs,
                effectState.durationMs,
              ),
            );
            effectState.durationAttributeID = Math.max(
              0,
              toInt(
                nextMiningCycleRuntimeAttrs.durationAttributeID,
                effectState.durationAttributeID,
              ),
            );
          }
          effectState.startedAtMs = cycleBoundaryMs;
          effectState.nextCycleAtMs =
            cycleBoundaryMs + Math.max(1, toFiniteNumber(effectState.durationMs, 1000));
          if (
            entity.session &&
            isReadyForDestiny(entity.session) &&
            isPrecursorTurretFamily(effectState.weaponFamily)
          ) {
            notifyGenericDerivedAttributesToSession(
              entity.session,
              effectState,
              cycleBoundaryMs,
            );
          }
          if (
            entity.session &&
            isReadyForDestiny(entity.session) &&
            !(
              isGenericEffect &&
              isMissileWeaponFamily(effectState.weaponFamily)
            ) &&
            effectState.miningEffect !== true
          ) {
            // CCP client parity: missile launchers and mining lasers keep repeating
            // locally from the initial OnGodmaShipEffect timing data.
            notifyEffect(entity.session, entity, effectState, true, {
              whenMs: cycleBoundaryMs,
              startTimeMs: cycleBoundaryMs,
              repeatNotification: true,
            });
          }
        }
      }

      let oldestOutstandingCommandBurstBoundaryMs = now;
      if (entity.activeModuleEffects instanceof Map) {
        for (const pendingEffectState of entity.activeModuleEffects.values()) {
          const pendingBoundaryMs = getEffectCycleBoundaryMs(
            pendingEffectState,
            now,
          );
          if (
            Number.isFinite(pendingBoundaryMs) &&
            pendingBoundaryMs < oldestOutstandingCommandBurstBoundaryMs
          ) {
            oldestOutstandingCommandBurstBoundaryMs = pendingBoundaryMs;
          }
        }
      }
      // Timed burst inputs are queried at authored module boundaries, which
      // can trail scene time while a lagged entity catches up. Once all of this
      // entity's effects have run, intervals older than both scene time and its
      // oldest still-pending boundary can no longer affect authoritative work.
      commandBurstRuntime.discardTimedCommandBurstHistoryBefore(
        entity,
        oldestOutstandingCommandBurstBoundaryMs,
      );

      // -----------------------------------------------------------------
      // Rack heat: build while overloaded modules cycle, dissipate
      // otherwise, and stream the heatHi/heatMed/heatLow gauges to the
      // owner.  Early-exits unless the ship is overloading or still warm.
      // -----------------------------------------------------------------
      advanceEntityRackHeat(this, entity, now);

      // -----------------------------------------------------------------
      // CCP parity: Non-linear capacitor recharge.
      //
      // Formula (instantaneous rate):
      //   dC/dt = (10 * Cmax / tau) * ( sqrt(C/Cmax) - C/Cmax )
      //
      // Where Cmax = capacitorCapacity (GJ), tau = rechargeRate (ms → s),
      // C = current capacitor level.  Peak recharge occurs at exactly 25%
      // capacitor.  This matches CCP's Dogma engine as verified by
      // community tools (Pyfa, EFT) and the EVE University wiki.
      //
      // Notifications are throttled to ~500 ms to avoid flooding the
      // client (which itself only polls at 500 ms intervals).
      // -----------------------------------------------------------------
      if (
        (
          entity.kind === "ship" ||
          controlledStaticStructureDogmaHosts.has(entity)
        ) &&
        toFiniteNumber(entity.capacitorCapacity, 0) > 0 &&
        toFiniteNumber(entity.capacitorRechargeRate, 0) > 0
      ) {
        const capRatio = getEntityCapacitorRatio(entity);
        if (capRatio < 1) {
          const Cmax = entity.capacitorCapacity;
          const tauSeconds = entity.capacitorRechargeRate / 1000;
          const previousChargeAmount = Cmax * capRatio;
          const rechargedRatio = advancePassiveRechargeRatio(
            capRatio,
            deltaSeconds,
            tauSeconds,
          );
          const newRatio = settlePassiveRechargeRatio(rechargedRatio, Cmax);
          if (newRatio !== capRatio) {
            setEntityCapacitorRatio(entity, newRatio);
            // Throttle persistence and client notifications to ~500 ms.
            const lastCapNotify = toFiniteNumber(entity._lastCapNotifyAtMs, 0);
            if (now - lastCapNotify >= 500) {
              persistEntityCapacitorRatio(entity);
              if (entity.session && isReadyForDestiny(entity.session)) {
                notifyCapacitorChangeToSession(
                  entity.session,
                  entity,
                  now,
                  previousChargeAmount,
                );
              }
              entity._lastCapNotifyAtMs = now;
            }
          }
        }
      }

      // Controlled structures share the generic module-cycle and capacitor
      // machinery, but they remain anchored static balls. Do not feed them
      // through ship shield, movement, warp, docking, or persistence phases.
      if (controlledStaticStructureDogmaHosts.has(entity)) {
        continue;
      }

      // -----------------------------------------------------------------
      // Server-authoritative passive shield recharge.
      //
      // CCP's client already animates shield recovery locally from the last
      // Michelle damage-state tuple and its tau/filetime. Re-broadcasting
      // OnDamageStateChange every recharge tick just injects extra non-local
      // destiny traffic into normal movement/combat history and causes
      // Michelle to rebase mid-flight. Keep the runtime conditionState and the
      // pilot HUD attributes authoritative here, but leave in-space damage
      // presentation on the last discrete damage/heal event.
      // -----------------------------------------------------------------
      if (
        state.passiveShieldRechargeEnabled &&
        (entity.kind === "ship" ||
          // Starbase structures are the only other entities that recharge here.
          // Check the category first so drones, wrecks and missiles skip the call.
          (toInt(entity.categoryID, 0) === CATEGORY_STARBASE &&
            lazyRequire("../services/starbase/starbaseRepairRuntime")
              .canRechargeStarbaseShield(entity, { scene: this, nowMs: Date.now() }))) &&
        toFiniteNumber(entity.shieldCapacity, 0) > 0 &&
        toFiniteNumber(entity.shieldRechargeRate, 0) > 0
      ) {
        const previousConditionState = normalizeShipConditionState(entity.conditionState);
        const shieldRatio = clamp(
          toFiniteNumber(previousConditionState.shieldCharge, 0),
          0,
          1,
        );
        if (shieldRatio < 1) {
          const shieldCapacity = entity.shieldCapacity;
          const rechargeSeconds = entity.shieldRechargeRate / 1000;
          const seededShieldRatio =
            shieldRatio > 0
              ? shieldRatio
              : Math.min(1, 1 / Math.max(1, shieldCapacity));
          const rechargedRatio = advancePassiveRechargeRatio(
            seededShieldRatio,
            deltaSeconds,
            rechargeSeconds,
          );
          const newShieldRatio = settlePassiveRechargeRatio(rechargedRatio, shieldCapacity);
          if (Math.abs(newShieldRatio - shieldRatio) > 1e-9) {
            entity.conditionState = normalizeShipConditionState({
              ...previousConditionState,
              shieldCharge: newShieldRatio,
            });
            const lastShieldNotify = toFiniteNumber(entity._lastShieldNotifyAtMs, 0);
            if (now - lastShieldNotify >= 500) {
              const healthTransitionResult = buildShipHealthTransitionResult(
                entity,
                previousConditionState,
              );
              if (toInt(entity.categoryID, 0) === 23) {
                const persisted = lazyRequire("../services/starbase/starbaseRepairRuntime")
                  .commitStarbaseHealthChange(entity, previousConditionState,
                    { scene: this, nowMs: Date.now(), recoverIncapacitated: false });
                if (!persisted.success) continue;
              } else {
                persistDynamicEntity(entity);
              }
              if (entity.session && isReadyForDestiny(entity.session)) {
                notifyShipHealthAttributesToSession(
                  entity.session,
                  entity,
                  healthTransitionResult,
                  now,
                );
              }
              entity._lastShieldNotifyAtMs = now;
            }
          }
        }
      }

      // A docking ship's dock completes on the Gameplay tick, a gameplay
      // timer; the dock queued the ship's Stop (scene/pilotCommands.js).
      if (
        entity.pendingDock &&
        this.dynamicEntities.get(entity.itemID) === entity &&
        entity.session &&
        entity.session._space &&
        now >= Number(entity.pendingDock.completeAtMs || 0)
      ) {
        dockRequests.set(entity.session.clientID, {
          session: entity.session,
          stationID: entity.pendingDock.stationID,
        });
      }
    }
    // The align gate runs at the top of every Destiny
    // tick's doPreTick (scene/pilotCommands.js gateAligningWarps), not here.
    try {
      tickProfiler.section("superTitanShow", () => tickSuperTitanShowScene(
        this,
        now,
        buildSuperweaponRuntimeCallbacks(this, 0),
      ));
    } catch (error) {
      log.warn(`[SpaceRuntime] Super titan show tick failed for system=${this.systemID}: ${error.message}`);
    }

    if (dockRequests.size > 0) {
      const { dockSession } = lazyRequire("./transitions");
      for (const request of dockRequests.values()) {
        const result = dockSession(request.session, request.stationID);
        if (!result.success) {
          const entity = this.getShipEntityForSession(request.session);
          clearPendingDock(entity);
          log.warn(
            `[SpaceRuntime] Delayed dock failed for char=${request.session && request.session.characterID} station=${request.stationID}: ${result.errorMsg}`,
          );
        }
      }
    }
    tickProfiler.add("mv.entityLoop", __mvEntityLoopStart);

    this.validateAllTargetLocks(now);
    try {
      require("../../../services/spaceComponents/towGameObjectiveRuntime").tickScene(this);
    } catch (error) {
      log.warn(`[Tow] Scene cleanup failed for system=${this.systemID}: ${error.message}`);
    }
    try {
      require("../../../services/activity/pvpFilamentQueueRuntime").tickScene(this);
    } catch (error) {
      log.warn(`[PvpFilaments] Scene queue cleanup failed for system=${this.systemID}: ${error.message}`);
    }
    tickSceneStructureTethers(this, now);
    if (isAnchorRelevanceEnabled() && hasStartupAnchorRelevanceContext(this)) {
      const anchorRelevanceResult = syncRelevantStartupControllersForScene(this, {
        broadcast: false,
        nowMs: now,
      });
      if (!anchorRelevanceResult.success) {
        log.warn(
          `[SpaceRuntime] NPC anchor relevance sync failed for system=${this.systemID}: ${anchorRelevanceResult.errorMsg || "SYNC_FAILED"}`,
        );
      }
    }
    for (const arrivalEvent of beltRatArrivalEvents) {
      this.maybeSpawnAsteroidBeltRatsForArrival(
        arrivalEvent.session,
        arrivalEvent.entity,
        {
          nowMs: arrivalEvent.nowMs,
          targetEntityID: arrivalEvent.targetEntityID,
          broadcast: false,
          source: "warpCompleted",
        },
      );
    }
    tickHudIconStateExpiries(this, now);
    this.processStargateJumpCloakExpirations(now);
    this.processCloakProximityDecloaks(now);
    spatialTrace.recordSimulationState(this, now);
    // Locks, tethers, NPC relevance, arrivals, HUD and cloak timers: no
    // visibility work is left here.
    // Safe logoff, last: a countdown whose deadline has passed logs its pilot
    // off; one whose conditions broke is aborted. Its deadline is wall-clock
    // time.
    try {
      require("../../../services/ship/safeLogoffRuntime")
        .processScene(this, clockState.wallclockNowMs);
    } catch (error) {
      log.warn(`[SpaceRuntime] Safe logoff tick failed for system=${this.systemID}: ${error.message}`);
    }
    this._tickTargetingStatsCache = null;
  },

// The Destiny tick's send (runtime/destinyTick.js doPostTick): one batch per
// Grid bubble with a history and one per Observer with a character history,
// every entry stamped with the tick's number.
sendDestinyTickOutput(frame) {
    return this.sendDestinyBatches(frame);
  },
};
