"use strict";

const runtimeEntryDirname = require("path").resolve(__dirname, "../..");
const path = require("path");
const spatialTrace = require(path.join(runtimeEntryDirname, "../network/spatialTrace"));
const log = require(path.join(runtimeEntryDirname, "../utils/logger"));
const {
  findItemById,
  findShipItemById,
  listContainerItems,
  listSystemSpaceItems,
  warmSimulationInventoryProjection,
} = require(path.join(
  runtimeEntryDirname,
  "../services/inventory/simulationInventoryProjection",
));
const {
  entityIDsEqual,
  getEntityMapKey,
  normalizeEntityID,
  normalizeEntityIDSet,
  normalizeNonNegativeInt64,
  normalizePersistentEntityID,
  toJSONSafeEntityID,
} = require(path.join(runtimeEntryDirname, "./destiny/identity/entityID.js"));
const deployableCynoRuntime = require(path.join(runtimeEntryDirname, "../services/ship/deployableCynoRuntime"));
const mobileAnalysisBeaconRuntime = require(path.join(runtimeEntryDirname, "../services/ship/mobileAnalysisBeaconRuntime"));
const mobileCynoInhibitorRuntime = require(path.join(runtimeEntryDirname, "../services/ship/mobileCynoInhibitorRuntime"));
const mobileDepotRuntime = require(path.join(runtimeEntryDirname, "../services/ship/mobileDepotRuntime"));
const mobileMicroJumpUnitRuntime = require(path.join(runtimeEntryDirname, "../services/ship/mobileMicroJumpUnitRuntime"));
const mobileObservatoryRuntime = require(path.join(runtimeEntryDirname, "../services/ship/mobileObservatoryRuntime"));
const mobilePhaseAnchorRuntime = require(path.join(runtimeEntryDirname, "../services/ship/mobilePhaseAnchorRuntime"));
const mobileScanInhibitorRuntime = require(path.join(runtimeEntryDirname, "../services/ship/mobileScanInhibitorRuntime"));
const mobileSiphonUnitRuntime = require(path.join(runtimeEntryDirname, "../services/ship/mobileSiphonUnitRuntime"));
const mobileTractorUnitRuntime = require(path.join(runtimeEntryDirname, "../services/ship/mobileTractorUnitRuntime"));
const mobileWarpDisruptorRuntime = require(path.join(runtimeEntryDirname, "../services/ship/mobileWarpDisruptorRuntime"));
const interdictionProbeRuntime = require(path.join(runtimeEntryDirname, "../services/ship/interdictionProbeRuntime"));
const {
  createInterdictionVolumes,
} = require(path.join(runtimeEntryDirname, "../services/ship/interdictionVolumes"));
const surveyProbeRuntime = require(path.join(
  runtimeEntryDirname,
  "../services/exploration/probes/surveyProbeRuntime",
));
const {
  estimateMissileEffectiveRange,
  estimateMissileClientImpactTimeMs,
  resolveMissileClientVisualProfile,
  estimateMissileFlightBudgetMs,
  resolveMissileAppliedDamage,
} = require(path.join(runtimeEntryDirname, "./combat/missiles/missileSolver"));
const {
  isAbyssalRoomEntityDeliveryHidden,
} = require("../abyssalRoomEntity");
const {
  notifyAbyssalEnvironmentalObjectDestroyedSafe,
} = require("../abyssalRunReporting");
const {
  isReadyForDestiny,
} = require("../destinyDeliveryEligibility");
const {
  resolveInvalidDestinyMissileFollowReason,
} = require("../destinyMovementEngine");
const {
  seedBallSlots,
} = require(path.join(runtimeEntryDirname, "./destiny/simulation/evolve.js"));
const {
  getOwningSessionForEntity,
} = require("../entityOwnerSession");
const {
  persistDynamicEntity,
} = require("../entitySpacePersistence");
const {
  isInventoryBackedDynamicEntity,
} = require("../inventorySpaceEntity");
const {
  buildMissileDynamicEntity,
} = require("../missileEntity");
const {
  roundNumber,
  toFiniteNumber,
  toInt,
} = require("../../../common/numbers");
const {
  buildMissileChargeTupleDebugContext,
  buildMissileLaunchRangeDebugContext,
  logMissileDebug,
  normalizeTraceValue,
  summarizeMissileEntity,
  summarizeMissileInventoryItemForDebug,
  summarizeMissileWeaponSnapshotForDebug,
  summarizeRuntimeEntityForMissileDebug,
} = require("../runtimeDebugInstrumentation");
const {
  applyRuntimeEntitySpawnMetadata,
} = require("../runtimeEntityIdentity");
const {
  lazyRequire,
} = require("../runtimeModuleBoundary");
const {
  decorateEntitySceneOwnership,
  normalizeSceneText,
} = require("../sceneIdentity");
const sceneFeatureHooks = require("./sceneFeatureHooks");
const {
  TARGET_LOSS_REASON_ATTEMPT_CANCELLED,
  TARGET_LOSS_REASON_EXPLODING,
  ensureEntityTargetingState,
} = require("../targeting");
const {
  isValidWeaponSnapshotTarget,
} = require("../weaponSnapshot");

module.exports = {

getDynamicEntities() {
    return [...this.dynamicEntities.values()];
  },

getEntityByID(entityID) {
    const entityKey = getEntityMapKey(entityID);
    if (entityKey === null) {
      return null;
    }

    return (
      this.dynamicEntities.get(entityKey) ||
      this.staticEntitiesByID.get(entityKey) ||
      null
    );
  },

getShipEntityForSession(session) {
    if (!session || !session._space) {
      return null;
    }

    const sessionShipID = getEntityMapKey(
      session._space.shipID ?? session.shipID ?? session.shipid,
    );
    if (sessionShipID === null) {
      return null;
    }
    const dynamicEntity = this.dynamicEntities.get(sessionShipID) || null;
    if (dynamicEntity) {
      return dynamicEntity;
    }

    if (session._space.observerKind === "structure") {
      const structureID = getEntityMapKey(
        session._space.shipID ??
        session.structureID ??
        session.structureid ??
        sessionShipID,
      );
      if (structureID === null) {
        return null;
      }
      return this.staticEntitiesByID.get(structureID) || null;
    }

    return null;
  },

// The system's warp disruption spheres: one InterdictionVolumes per
// scene, made when first asked for.
getInterdictionVolumes() {
    if (!this._interdictionVolumes) {
      this._interdictionVolumes = createInterdictionVolumes(this.systemID);
    }
    return this._interdictionVolumes;
  },

// A Ball that joins the scene and is a sphere joins its InterdictionVolumes:
// a dictor's probe, launched or made again from its stored item, or
// a mobile warp disruptor with its stored state (`itemRecord`, the item the
// Ball was built from). A heavy interdictor's field joins when it is
// switched on (scene/modules.js).
trackInterdictionVolume(entity, itemRecord = null) {
    if (!entity) {
      return null;
    }
    if (interdictionProbeRuntime.isWarpDisruptionProbeType(entity)) {
      return this.getInterdictionVolumes().addVolume(entity);
    }
    if (mobileWarpDisruptorRuntime.isMobileWarpDisruptorType(entity)) {
      const record = itemRecord && Number(itemRecord.itemID) === Number(entity.itemID)
        ? itemRecord
        : null;
      return record
        ? this.getInterdictionVolumes().addVolume(record, { entity })
        : null;
    }
    return null;
  },

spawnDynamicEntity(entity, options = {}) {
    if (!entity || !entity.itemID) {
      return {
        success: false,
        errorMsg: "INVALID_DYNAMIC_ENTITY",
      };
    }
    if (this.dynamicEntities.has(entity.itemID)) {
      return {
        success: false,
        errorMsg: "DYNAMIC_ENTITY_ALREADY_EXISTS",
      };
    }
    if (this.hasMalformedScope(entity)) {
      log.warn(`[SpaceRuntime] Refused Ball ${entity.itemID} with a malformed scope in system=${this.systemID}`);
      return {
        success: false,
        errorMsg: "MALFORMED_ENTITY_SCOPE",
      };
    }

    // Tow's spawn refusal decides, so it stays here; the registration is
    // notifyEntityAdded's.
    const tow = require("../../../services/spaceComponents/towGameObjectiveRuntime");
    const towContext = options.towObjectiveContext == null ? null
      : tow.validateObjectiveContext(entity, options.towObjectiveContext);
    if (towContext && !towContext.success) return towContext;

    applyRuntimeEntitySpawnMetadata(entity, options.runtimeEntityMetadata);
    entity.systemID = this.systemID;
    decorateEntitySceneOwnership(entity, this.sceneDescriptor);
    entity.session = entity.session || null;
    ensureEntityTargetingState(entity);
    const positionRegistration = this.positionAuthority.registerEntity(entity, {
      atSimTimeMs: this.simTimeMs,
      reason: "dynamic-entity-spawn",
    });
    if (!positionRegistration.available) {
      return {
        success: false,
        errorMsg: "INVALID_DYNAMIC_ENTITY_POSITION",
        data: { reason: positionRegistration.reason },
      };
    }
    // A new Ball's old slot is where it was a tick ago at its velocity.
    seedBallSlots(entity);
    this.dynamicEntities.set(entity.itemID, entity);
    sceneFeatureHooks.notifyEntityAdded(this, entity, {
      via: "spawn",
      towObjective: towContext ? towContext.data : undefined,
      spawnOptions: options,
    });
    this.trackInterdictionVolume(entity, options.interdictionItemRecord || null);
    this.markBallJoiningMovement(entity);
    this.indexDynamicEntityExpiry(entity);
    this.indexCommandBurstExpiry(entity);
    if (entity.kind === "drone") {
      this.droneEntityIDs.add(entity.itemID);
    }
    if (entity.kind === "fighter") {
      this.fighterEntityIDs.add(entity.itemID);
    }
    // AddBall: the Ball is in its Grid bubble now, and its Observers are told
    // at the next doPreTick's bubble update (scene/visibility.js).
    this.reboxBall(entity);
    persistDynamicEntity(entity);
    spatialTrace.recordEntitySpawn(this, entity, options);

    const initialPublicationDeferred =
      options.initialPublication === "deferred" ||
      options.suppressInitialPublication === true ||
      isAbyssalRoomEntityDeliveryHidden(entity);
    entity.evejsInitialPublicationDeferred = initialPublicationDeferred;

    // Only a global Ball is broadcast; any other reaches its Observers
    // through the bubble update.
    if (options.broadcast !== false && !initialPublicationDeferred) {
      this.broadcastAddBalls([entity], options.excludedSession || null, {});
    }

    return {
      success: true,
      data: {
        entity,
      },
    };
  },

launchMissile(attackerEntity, targetID, weaponSnapshot, options = {}) {
    if (!attackerEntity || !weaponSnapshot) {
      logMissileDebug("missile.launch.failed", () => ({
        sceneSystemID: this.systemID,
        reason: "missing-input",
        attacker: summarizeRuntimeEntityForMissileDebug(attackerEntity),
        targetID: toInt(targetID, 0),
      }));
      return {
        success: false,
        errorMsg: "MISSILE_SPAWN_FAILED",
      };
    }

    const targetEntity = this.getEntityByID(targetID);
    if (!targetEntity || !isValidWeaponSnapshotTarget(attackerEntity, targetEntity, weaponSnapshot)) {
      logMissileDebug("missile.launch.failed", () => ({
        sceneSystemID: this.systemID,
        reason: "target-not-found",
        attacker: summarizeRuntimeEntityForMissileDebug(attackerEntity),
        target: summarizeRuntimeEntityForMissileDebug(targetEntity),
        targetID: toInt(targetID, 0),
      }));
      return {
        success: false,
        errorMsg: "TARGET_NOT_FOUND",
      };
    }

    const invalidMissileTargetReason = resolveInvalidDestinyMissileFollowReason(
      attackerEntity,
      targetEntity,
    );
    if (invalidMissileTargetReason) {
      logMissileDebug("missile.launch.failed", () => ({
        sceneSystemID: this.systemID,
        reason: invalidMissileTargetReason,
        attacker: summarizeRuntimeEntityForMissileDebug(attackerEntity),
        target: summarizeRuntimeEntityForMissileDebug(targetEntity),
        targetID: toInt(targetID, 0),
      }));
      return {
        success: false,
        errorMsg: "TARGET_NOT_FOUND",
      };
    }

    if (
      options.skipRangeCheck !== true &&
      this.getEntitySurfaceDistance(attackerEntity, targetEntity) >
        estimateMissileEffectiveRange(weaponSnapshot) + 1
    ) {
      logMissileDebug("missile.launch.failed", () => ({
        sceneSystemID: this.systemID,
        reason: "target-out-of-range",
        attacker: summarizeRuntimeEntityForMissileDebug(attackerEntity),
        target: summarizeRuntimeEntityForMissileDebug(targetEntity),
        targetID: toInt(targetID, 0),
        moduleItem: summarizeMissileInventoryItemForDebug(options.moduleItem),
        chargeItem: summarizeMissileInventoryItemForDebug(options.chargeItem),
        rangeContext: buildMissileLaunchRangeDebugContext(
          attackerEntity,
          targetEntity,
          weaponSnapshot,
          options.moduleItem,
          options.chargeItem,
        ),
      }));
      return {
        success: false,
        errorMsg: "TARGET_OUT_OF_RANGE",
      };
    }

    logMissileDebug("missile.launch.request", () => ({
      sceneSystemID: this.systemID,
      nowMs: roundNumber(
        toFiniteNumber(options.launchTimeMs, this.getCurrentSimTimeMs()),
        3,
      ),
      attacker: summarizeRuntimeEntityForMissileDebug(attackerEntity),
      target: summarizeRuntimeEntityForMissileDebug(targetEntity),
      targetID: toInt(targetID, 0),
      moduleItem: summarizeMissileInventoryItemForDebug(options.moduleItem),
      chargeItem: summarizeMissileInventoryItemForDebug(options.chargeItem),
      chargeTuple: buildMissileChargeTupleDebugContext(
        attackerEntity,
        options.moduleItem,
        options.chargeItem,
      ),
      weaponSnapshot: summarizeMissileWeaponSnapshotForDebug(weaponSnapshot),
      rangeContext: buildMissileLaunchRangeDebugContext(
        attackerEntity,
        targetEntity,
        weaponSnapshot,
        options.moduleItem,
        options.chargeItem,
      ),
      options: normalizeTraceValue(options),
    }));

    const missileEntity = buildMissileDynamicEntity(
      attackerEntity,
      targetEntity,
      weaponSnapshot,
      toFiniteNumber(options.launchTimeMs, this.getCurrentSimTimeMs()),
      options,
    );
    if (!missileEntity) {
      logMissileDebug("missile.launch.failed", () => ({
        sceneSystemID: this.systemID,
        reason: "entity-build-failed",
        attacker: summarizeRuntimeEntityForMissileDebug(attackerEntity),
        target: summarizeRuntimeEntityForMissileDebug(targetEntity),
        targetID: toInt(targetID, 0),
      }));
      return {
        success: false,
        errorMsg: "MISSILE_SPAWN_FAILED",
      };
    }

    // A launch is a queued AddBall: the missile joins at the next Destiny
    // tick, whose number is its effectStamp, and flies its first full second
    // in that tick's Evolve (GotoThrust for its first 800 ms).
    missileEntity.effectStamp = this.nextDestinyStamp;
    // The missile-only registrations decide, so they stay here: a breacher
    // pod's projectile before its spawn, a firework's show ownership after
    // it. Each is a no-op for an ordinary missile.
    require("../../combat/breacherPods").registerProjectile(this, missileEntity);
    const spawnResult = this.spawnDynamicEntity(missileEntity, {
      broadcast: options.broadcast,
      initialPublication: options.initialPublication,
      excludedSession: options.excludedSession || null,
      broadcastOptions:
        options.broadcastOptions && typeof options.broadcastOptions === "object"
          ? { ...options.broadcastOptions }
          : null,
    });
    if (!spawnResult.success) {
      logMissileDebug("missile.launch.failed", () => ({
        sceneSystemID: this.systemID,
        reason: "spawn-failed",
        attacker: summarizeRuntimeEntityForMissileDebug(attackerEntity),
        target: summarizeRuntimeEntityForMissileDebug(targetEntity),
        missile: summarizeMissileEntity(missileEntity),
        spawnResult: normalizeTraceValue(spawnResult),
      }));
      return spawnResult;
    }
    require("../../FireShow/fireShowRuntime").registerMissile(
      this,
      attackerEntity,
      missileEntity,
    );

    logMissileDebug("missile.launch.spawned", () => ({
      sceneSystemID: this.systemID,
      nowMs: roundNumber(this.getCurrentSimTimeMs(), 3),
      missile: summarizeMissileEntity(missileEntity),
      attacker: summarizeRuntimeEntityForMissileDebug(attackerEntity),
      target: summarizeRuntimeEntityForMissileDebug(targetEntity),
      moduleItem: summarizeMissileInventoryItemForDebug(options.moduleItem),
      chargeItem: summarizeMissileInventoryItemForDebug(options.chargeItem),
      rangeContext: buildMissileLaunchRangeDebugContext(
        attackerEntity,
        targetEntity,
        weaponSnapshot,
        options.moduleItem,
        options.chargeItem,
      ),
    }));

    return {
      success: true,
      data: {
        entity: missileEntity,
        targetEntity,
      },
    };
  },

unregisterDynamicEntity(entity, options = {}) {
    if (!entity) {
      return null;
    }
    // Inside Evolve only RemoveBall's moribund mark happens; the
    // removal itself waits for bringOutTheDeads.
    if (this.deferRemovalWhileEvolving(entity, options)) {
      return entity;
    }
    // RemoveBall's StopAllFollowers: its followers fly on or stop,
    // per kind, as each client's RemoveBall does to them.
    if (typeof this.stopAllFollowers === "function") {
      this.stopAllFollowers(entity);
    }

    // The real removal: its features are told while the Ball is still in
    // the scene's maps and unpersisted (Scene feature hooks).
    sceneFeatureHooks.notifyEntityRemoved(this, entity, options, { path: "unregister" });

    const visibilityEntity =
      options.broadcast !== false
        ? { ...entity, isGlobal: this.isGlobalBall(entity) }
        : null;

    spatialTrace.recordTerminalState(this, entity, options);

    this.clearAllTargetingForEntity(entity, {
      notifySelf: entity.session ? isReadyForDestiny(entity.session) : false,
      notifyTarget: true,
      reason:
        toInt(options && options.terminalDestructionEffectID, 0) > 0
          ? TARGET_LOSS_REASON_EXPLODING
          : TARGET_LOSS_REASON_ATTEMPT_CANCELLED,
    });
    if (options.persistSpaceState !== false) {
      persistDynamicEntity(entity);
    }
    // RemoveBall: out of its Grid bubble at once; its Observers get the
    // RemoveBalls at the next bubble update.
    this.removeBallFromGridBubbles(entity);
    this.positionAuthority.unregisterEntity(entity);
    this.dynamicEntities.delete(entity.itemID);
    // A sphere's Ball, or a heavy interdictor, leaving the scene takes its
    // sphere with it.
    if (this._interdictionVolumes) {
      this._interdictionVolumes.removeVolume(entity.itemID);
    }
    this.unindexDynamicEntityExpiry(entity.itemID);
    this.unindexCommandBurstExpiry(entity.itemID);
    if (entity.kind === "drone") {
      this.droneEntityIDs.delete(entity.itemID);
    }
    if (entity.kind === "fighter") {
      this.fighterEntityIDs.delete(entity.itemID);
    }
    let removalDiagnostics = {
      attemptedCount: 0,
      deliveredCount: 0,
    };
    if (options.broadcast !== false) {
      removalDiagnostics = this.broadcastRemoveBall(
        entity.itemID,
        options.excludedSession || null,
        {
          terminalDestructionEffectID: options.terminalDestructionEffectID,
          missileHitExplosion: options.missileHitExplosion === true,
          visibilityEntity,
        },
      ) || removalDiagnostics;
    }
    if (typeof options.onRemovalDiagnostics === "function") {
      options.onRemovalDiagnostics(removalDiagnostics);
    }
    return entity;
  },

purgeDestroyedShipEntityTopology(shipID) {
    const shipEntityKey = getEntityMapKey(shipID);
    if (shipEntityKey === null) {
      return false;
    }
    const staleEntity = this.dynamicEntities.get(shipEntityKey) || null;
    if (!staleEntity || staleEntity.kind !== "ship") {
      return false;
    }
    sceneFeatureHooks.notifyEntityRemoved(this, staleEntity, {}, { path: "purge" });
    this.removeBallFromGridBubbles(staleEntity);
    this.dynamicEntities.delete(shipEntityKey);
    if (this._interdictionVolumes) {
      this._interdictionVolumes.removeVolume(shipEntityKey);
    }
    return true;
  },

removeDynamicEntity(entityID, options = {}) {
    const entity = this.dynamicEntities.get(Number(entityID)) || null;
    if (!entity) {
      return {
        success: false,
        errorMsg: "DYNAMIC_ENTITY_NOT_FOUND",
      };
    }
    if (entity.session && options.allowSessionOwned !== true) {
      return {
        success: false,
        errorMsg: "DYNAMIC_ENTITY_SESSION_OWNED",
      };
    }

    this.unregisterDynamicEntity(entity, options);
    return {
      success: true,
      data: {
        entityID: entity.itemID,
      },
    };
  },

destroyInventoryBackedDynamicEntity(entityID, options = {}) {
    const entity = this.dynamicEntities.get(Number(entityID)) || null;
    if (!isInventoryBackedDynamicEntity(entity)) {
      return {
        success: false,
        errorMsg: "DYNAMIC_ENTITY_NOT_FOUND",
      };
    }

    if (toInt(entity.categoryID, 0) === 23 && toInt(entity.groupID, 0) !== 411) {
      return lazyRequire("../services/starbase/starbaseCombatRuntime")
        .destroyStarbase(entity, { ...options, scene: this });
    }

    const inventoryItem = findItemById(entity.itemID);
    if (
      !inventoryItem ||
      toInt(inventoryItem.ownerID, 0) <= 0 ||
      toInt(inventoryItem.locationID, 0) !== toInt(this.systemID, 0) ||
      toInt(inventoryItem.flagID, -1) !== 0
    ) {
      return {
        success: false,
        errorMsg: "ITEM_CUSTODY_SOURCE_MISMATCH",
      };
    }

    const itemCustody = lazyRequire("../services/inventory/itemCustody");
    const custodyReason = String(
      options.custodyReason || itemCustody.CUSTODY_REASON.SPACE_ENTITY_DESTROY,
    );
    const removeResult = itemCustody.transfer({
      items: { itemID: entity.itemID },
      from: itemCustody.custodyRef.inSpace(
        inventoryItem.ownerID,
        inventoryItem.locationID,
        inventoryItem.spaceState || null,
      ),
      to: itemCustody.custodyRef.void(),
      reason: custodyReason,
      actor: toInt(options.actor, 0) || null,
      idempotencyKey:
        String(options.idempotencyKey || "").trim() ||
        `space-entity-destroy:${entity.itemID}:${inventoryItem.ownerID}:` +
          `${inventoryItem.locationID}:${custodyReason}`,
      options: {
        removeContents: options.removeContents !== false,
      },
    });
    if (!removeResult.success) {
      return removeResult;
    }

    // Keep the live scene authoritative until the durable custody transition
    // succeeds. In particular, a failed fighter deletion must remain visible
    // to its controller (and to a later scene-GC retry) instead of becoming an
    // orphaned in-space inventory row with no runtime entity.
    // The backing row is gone now, so pass the pre-transfer snapshot to each
    // runtime. Their cleanup still needs deployable state to release secondary
    // registrations (fleet beacons, tractor pulls, timers, and similar state).
    deployableCynoRuntime.clearMobileCynoDeployable(inventoryItem, "destroyed");
    mobileDepotRuntime.clearMobileDepot(inventoryItem, "destroyed");
    mobileAnalysisBeaconRuntime.clearMobileAnalysisBeacon(inventoryItem, "destroyed");
    mobileCynoInhibitorRuntime.clearMobileCynoInhibitor(inventoryItem, "destroyed");
    mobileMicroJumpUnitRuntime.clearMobileMicroJumpUnit(inventoryItem, "destroyed");
    mobileObservatoryRuntime.clearMobileObservatory(inventoryItem, "destroyed");
    mobilePhaseAnchorRuntime.clearMobilePhaseAnchor(inventoryItem, "destroyed");
    mobileScanInhibitorRuntime.clearMobileScanInhibitor(inventoryItem, "destroyed");
    mobileSiphonUnitRuntime.clearMobileSiphonUnit(inventoryItem, "destroyed");
    mobileTractorUnitRuntime.clearMobileTractorUnit(inventoryItem, "destroyed");
    mobileWarpDisruptorRuntime.clearMobileWarpDisruptor(inventoryItem, "destroyed");
    if (
      options.suppressSurveyProbeNotification !== true &&
      surveyProbeRuntime.isSurveyProbeType(entity)
    ) {
      surveyProbeRuntime.notifySurveyProbeRemoval(this, entity);
    }
    const environmentalDestroyResult = notifyAbyssalEnvironmentalObjectDestroyedSafe(
      this,
      entity,
      { reason: normalizeSceneText(options.reason, "entity-destroyed") },
    );
    this.unregisterDynamicEntity(entity, {
      ...options,
      // Custody has already removed the backing row; there is no state left to
      // persist, and trying to do so could recreate the just-destroyed item.
      persistSpaceState: false,
    });
    entity.destructionState = "destroyed";
    entity.destroying = false;
    entity.destroyingAtMs = 0;
    entity.destroyed = true;
    entity.removed = true;
    entity.persistSpaceState = false;

    return {
      success: true,
      data: {
        entityID: entity.itemID,
        changes: removeResult.data && removeResult.data.changes,
        environmentalDestroyResult,
      },
    };
  },

destroyExpiredInventoryBackedEntities(now = this.getCurrentSimTimeMs()) {
    const numericNow = toFiniteNumber(now, this.getCurrentSimTimeMs());
    const nextExpiryEntry = this.peekValidDynamicEntityExpiry();
    if (
      !nextExpiryEntry ||
      toFiniteNumber(nextExpiryEntry.expiresAtMs, 0) > numericNow
    ) {
      return [];
    }

    const expiredEntities = [];
    while (true) {
      const entry = this.peekValidDynamicEntityExpiry();
      if (!entry || toFiniteNumber(entry.expiresAtMs, 0) > numericNow) {
        break;
      }
      this.popDynamicEntityExpiryHeap();
      const entityID = toInt(entry.entityID, 0);
      const entity = this.dynamicEntities.get(entityID);
      if (!this.shouldIndexDynamicEntityExpiry(entity)) {
        this.dynamicEntityExpiryByID.delete(entityID);
        continue;
      }
      if (toFiniteNumber(entity.expiresAtMs, 0) <= numericNow) {
        this.dynamicEntityExpiryByID.delete(entityID);
        expiredEntities.push({
          entityID: entity.itemID,
          nativeNpcWreck: entity.nativeNpcWreck === true,
        });
      }
    }

    const destroyedEntityIDs = [];
    const failedEntityIDs = [];
    for (const expiredEntity of expiredEntities) {
      let destroyResult = null;
      if (expiredEntity.nativeNpcWreck === true) {
        const {
          destroyNativeWreck,
        } = lazyRequire("./npc/nativeNpcWreckService");
        destroyResult = destroyNativeWreck(expiredEntity.entityID, {
          systemID: this.systemID,
        });
      } else {
        destroyResult = this.destroyInventoryBackedDynamicEntity(expiredEntity.entityID);
      }
      if (destroyResult.success) {
        destroyedEntityIDs.push(expiredEntity.entityID);
      } else {
        failedEntityIDs.push(expiredEntity.entityID);
      }
    }
    for (const failedEntityID of failedEntityIDs) {
      this.indexDynamicEntityExpiry(this.dynamicEntities.get(failedEntityID));
    }

    return destroyedEntityIDs;
  },
};
