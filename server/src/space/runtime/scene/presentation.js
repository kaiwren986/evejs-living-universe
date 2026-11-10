"use strict";

const runtimeEntryDirname = require("path").resolve(__dirname, "../..");
const path = require("path");
const spatialTrace = require(path.join(runtimeEntryDirname, "../network/spatialTrace"));
const log = require(path.join(runtimeEntryDirname, "../utils/logger"));
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
  getPayloadPrimaryEntityID: getExactPayloadPrimaryEntityID,
} = require(path.join(runtimeEntryDirname, "./destiny/protocol/payloadIdentity.js"));
const {
  buildInitialBallparkEntityPlan,
} = require(path.join(runtimeEntryDirname, "./destiny/bootstrap/initialBallpark.js"));
const {
  buildDamageStatePresentationUpdates,
  buildSlimItemPresentationUpdates,
  buildSpecialFxBroadcastPayloads,
  buildStructureLifecyclePresentationUpdates,
} = require(path.join(
  runtimeEntryDirname,
  "./destiny/presentation/specialFxPayloads.js",
));
const {
  buildAddBallsPresentationUpdates,
} = require(path.join(
  runtimeEntryDirname,
  "./destiny/presentation/addBalls.js",
));
const {
  resolveFreshAcquireBootstrapModeUpdates,
} = require(path.join(
  runtimeEntryDirname,
  "./destiny/presentation/freshAcquire.js",
));
const {
  buildSetBallFreePresentationUpdates,
} = require(path.join(
  runtimeEntryDirname,
  "./destiny/presentation/mode.js",
));
const {
  buildTerminalDestructionRemoveBallsPresentationUpdates,
} = require(path.join(
  runtimeEntryDirname,
  "./destiny/presentation/removeBalls.js",
));
const {
  isFreeBallInteractive,
} = require(path.join(runtimeEntryDirname, "./destiny/stream/ballEncoding.js"));
const {
  buildShipPrimeDeltaUpdates,
  buildShipPrimeUpdatesForEntities,
} = require(path.join(
  runtimeEntryDirname,
  "./destiny/presentation/shipPrime.js",
));
const surveyProbeRuntime = require(path.join(
  runtimeEntryDirname,
  "../services/exploration/probes/surveyProbeRuntime",
));
const {
  isSessionOpenForDestinyDelivery,
} = require(path.join(runtimeEntryDirname, "./destiny/delivery/michelleContract.js"));
const {
  PILOT_WARP_ACTIVATION_DELAY_DESTINY_TICKS,
  PILOT_WARP_DESTINATION_ACQUIRE_LEAD_DESTINY_TICKS,
  PILOT_WARP_DESTINATION_STATIC_PRELOAD_DISTANCE_METERS,
  PILOT_WARP_HISTORY_SAFE_DESTINY_LEAD,
  PILOT_WARP_SOURCE_REMOVAL_SETTLE_MS,
} = require(path.join(runtimeEntryDirname, "./destiny/simulation/warpContract.js"));
const destiny = require(path.join(runtimeEntryDirname, "./destiny/index.js"));
const gridBubbles = require(path.join(runtimeEntryDirname, "./destiny/visibility/gridBubbles.js"));
const {
  isEntityCloaked,
} = require("../shipCloak");
const {
  sendTimeDilationNotificationToSession,
} = require(path.join(runtimeEntryDirname, "../utils/synchronizedTimeDilation"));
const {
  isAbyssalRoomEntityDeliveryHidden,
} = require("../abyssalRoomEntity");
const {
  buildActiveSpecialFxEffectStateEntriesForSetState,
  buildFreshAcquireActiveSpecialFxReplayUpdates,
  filterSetStateDuplicateSpecialFxReplayUpdates,
} = require("../activeModuleSpecialFx");
const {
  buildCommandBurstDbuffStateEntriesForSession,
  notifyActiveCommandBurstHudStatesToSession,
} = require("../commandBurst");
const {
  canSessionReceiveEntityDependentDestinyUpdate,
  getPayloadPrimaryEntityID,
  isReadyForDestiny,
} = require("../destinyDeliveryEligibility");
const {
  applyRuntimeEntityScopeMetadata,
} = require("../entityScopeTags");
const {
  persistDynamicEntity,
} = require("../entitySpacePersistence");
const {
  buildInitialBootstrapSetStatePresentationUpdate,
  buildUndockBootstrapMovementUpdates,
  resolveBootstrapPreviousSimTimeMs,
} = require("../firstSightPresentation");
const {
  ForceFieldIndexedEntityMap,
} = require("../forceFieldContainment");
const {
  notifyActiveAssistanceJamStatesToSession,
  notifyActiveHostileJamStatesToSession,
} = require("../hudIconStates");
const {
  isInventoryBackedDynamicEntity,
  refreshInventoryBackedEntityPresentationFields,
} = require("../inventorySpaceEntity");
const {
  buildSpecialFxPayloadsForEntity,
} = require("../moduleSpecialFx");
const {
  clamp,
  roundNumber,
  toFiniteNumber,
  toInt,
} = require("../../../common/numbers");
const {
  buildMissileSessionSnapshot,
  logBallDebug,
  logMissileDebug,
  normalizeTraceValue,
  recordSessionJumpTimingTrace,
  summarizeMissileEntity,
  summarizeMissileUpdatesForLog,
} = require("../runtimeDebugInstrumentation");
const {
  normalizeSceneText,
} = require("../sceneIdentity");
const {
  refreshEntitiesForSlimPayload,
  refreshShipPresentationFields,
} = require("../shipEntity");
const {
  STRUCTURE_ECM_BURST_FX_GUID,
  STRUCTURE_REPAIR_COMPLETE_FX_GUID,
} = require("../structureLifecycleFanout");
const {
  autoMaterializeNearbyUniverseSiteForAttach,
} = require("../universeSiteAttach");
const {
  cloneVector,
} = require("../../../common/vector");
const {
  isBootstrapSiteStaticVisibilityEntity,
  isDedicatedSiteStaticVisibilityEntity,
  isIncrementalStaticVisibilityEntity,
} = require("../visibility");

module.exports = {

isSessionOpenForDestinyDelivery(session) {
    return isSessionOpenForDestinyDelivery(session);
  },

refreshInventoryBackedEntityPresentation(entityID, options = {}) {
    const entity = this.getEntityByID(entityID);
    if (!isInventoryBackedDynamicEntity(entity)) {
      return {
        success: false,
        errorMsg: "DYNAMIC_ENTITY_NOT_FOUND",
      };
    }

    const previousIsFree =
      typeof entity.isFree === "boolean" ? entity.isFree : null;
    // The global status its Observers have, before its fields change (an
    // orbital's anchoring or unanchoring is read from its item here).
    this.rememberBallGlobalStatus(entity);
    refreshInventoryBackedEntityPresentationFields(entity);
    const entityMap = this.dynamicEntities.has(entity.itemID) ? this.dynamicEntities : this.staticEntitiesByID;
    if (entityMap instanceof ForceFieldIndexedEntityMap) entityMap.refreshForceField(entity.itemID, entity);
    this.indexDynamicEntityExpiry(entity);
    const nextIsFree =
      typeof entity.isFree === "boolean" ? entity.isFree : null;
    applyRuntimeEntityScopeMetadata(entity, options.entityScopeMetadata);
    persistDynamicEntity(entity);
    // A public customs office or skyhook that anchored, unanchored or was
    // destroyed changes its global status. Told whatever `broadcast` says:
    // what each Observer has must follow the status the scene now routes by.
    this.refreshBallGlobalStatus(entity.itemID);
    if (options.broadcast !== false) {
      this.broadcastSlimItemChanges([entity]);
      if (previousIsFree !== null && nextIsFree !== null && previousIsFree !== nextIsFree) {
        this.queueBallHistory(
          entity,
          buildSetBallFreePresentationUpdates(
            entity.itemID,
            nextIsFree,
            this.nextDestinyStamp,
          ),
        );
      }
    }

    return {
      success: true,
      data: {
        entity,
      },
    };
  },

// A structure's lifecycle transition (its damage state, its slim item and the
// transition FX), built once and queued to the structure's Grid bubble
// history: every Observer that has the structure gets the same entries.
broadcastStructureLifecycleTransitionBundles(transitionBundles) {
    if (!Array.isArray(transitionBundles) || transitionBundles.length === 0) {
      return 0;
    }

    let queuedCount = 0;
    for (const transition of transitionBundles) {
      const entity = transition && transition.entity;
      if (!entity || entity.kind !== "structure") {
        continue;
      }
      const refreshedEntity = refreshEntitiesForSlimPayload([entity])[0];
      if (!refreshedEntity) {
        continue;
      }
      const presentation = (transition && transition.presentation) || {};
      const updates = buildStructureLifecyclePresentationUpdates({
        stamp: this.nextDestinyStamp,
        entityID: refreshedEntity.itemID,
        includeRepairCompleteFx: presentation.includeRepairCompleteFx === true,
        repairCompleteFxGuid: STRUCTURE_REPAIR_COMPLETE_FX_GUID,
        ecmBurstFxGuid: STRUCTURE_ECM_BURST_FX_GUID,
        damageState: destiny.buildDamageState(refreshedEntity, this.getCurrentFileTime()),
        slimItem: destiny.buildSlimItemObject(refreshedEntity),
      });
      if (this.queueBallHistory(refreshedEntity, updates) !== null) {
        queuedCount += 1;
      }
    }
    return queuedCount;
  },

// Slim item changes for one Observer only, in its character history, for
// the Balls its client has.
sendSlimItemChangesToSession(session, entities) {
    if (
      !session ||
      !isReadyForDestiny(session) ||
      !Array.isArray(entities) ||
      entities.length === 0
    ) {
      return 0;
    }
    const visibleEntities = refreshEntitiesForSlimPayload(entities).filter((entity) => (
      entity && canSessionReceiveEntityDependentDestinyUpdate(this, session, entity)
    ));
    const updates = visibleEntities
      .flatMap((entity) => buildSlimItemPresentationUpdates({
        stamp: this.nextDestinyStamp,
        entityID: entity.itemID,
        slimItem: destiny.buildSlimItemObject(entity),
      }));
    if (updates.length === 0) {
      return 0;
    }
    this.queueCharacterHistory(session, updates);
    return updates.length;
  },

// A special effect for one Observer only, in its character history.
sendSpecialFxToSession(session, shipID, guid, options = {}, visibilityEntity = null) {
    if (!session || !isReadyForDestiny(session)) {
      return {
        delivered: false,
        stamp: null,
      };
    }
    const rawOptions =
      options && typeof options === "object"
        ? { ...options }
        : {};
    const { payloads } = buildSpecialFxPayloadsForEntity(shipID, guid, rawOptions, visibilityEntity);
    if (payloads.length === 0) {
      return {
        delivered: false,
        stamp: null,
      };
    }
    const stamp = this.queueCharacterHistory(session, payloads);
    return {
      delivered: stamp !== null,
      stamp,
    };
  },

// A special effect on a Ball (an OnSpecialFX, with its Stop when asked), to
// that Ball's Grid bubble history: every Observer of the bubble, its owner
// included, gets it in the same bubble batch. `visibilityEntity`, when
// given, is the Ball whose bubble it goes to. A Gameplay event,
// stamped like any entry.
broadcastSpecialFx(shipID, guid, options = {}, visibilityEntity = null) {
    const rawOptions =
      options && typeof options === "object"
        ? { ...options }
        : {};
    const includeStopInSameUpdate = rawOptions.includeStopInSameUpdate === true;
    delete rawOptions.includeStopInSameUpdate;
    // A stop aimed at a Ball already gone (a launcher whose target died) is
    // not sent: every client dropped each effect naming that Ball
    // when it removed it (fxSequencer.py DoBallsRemove,
    // RemoveActivationsForBallID), and would get a Ball it no longer has.
    if (rawOptions.start === false && rawOptions.targetID !== null && rawOptions.targetID !== undefined) {
      const target = this.getEntityByID(rawOptions.targetID);
      if (!target || target.isMoribund === true) {
        return {
          stamp: null,
          deliveredCount: 0,
        };
      }
    }
    const { payloads } = buildSpecialFxPayloadsForEntity(shipID, guid, rawOptions, visibilityEntity);
    if (payloads.length === 0) {
      return {
        stamp: null,
        deliveredCount: 0,
      };
    }
    const updates = buildSpecialFxBroadcastPayloads({
      entityID: shipID,
      payloads,
      includeStopInSameUpdate,
    });
    const stamp = this.queueBallHistory(visibilityEntity || shipID, updates);
    return {
      stamp,
      deliveredCount: stamp === null ? 0 : 1,
      resultSessionDelivered: stamp !== null,
    };
  },

// A Ball's slim item changed (OnSlimItemChange): to its Grid bubble's
// history. Returns how many Balls it queued.
broadcastSlimItemChanges(entities) {
    if (!Array.isArray(entities) || entities.length === 0) {
      return 0;
    }
    const publishableEntities = refreshEntitiesForSlimPayload(entities.filter(
      (entity) => entity && !isAbyssalRoomEntityDeliveryHidden(entity),
    ));
    let queued = 0;
    for (const entity of publishableEntities) {
      const updates = buildSlimItemPresentationUpdates({
        stamp: this.nextDestinyStamp,
        entityID: entity.itemID,
        slimItem: destiny.buildSlimItemObject(entity),
      });
      if (updates.length > 0 && this.queueBallHistory(entity, updates) !== null) {
        queued += 1;
      }
    }
    return queued;
  },

// A ship its pilot has just left (an eject, or boarding another ship). TQ
// stops it and tells its Grid bubble, on one stamp: SetBallInteractive(ship,
// 0), Stop(ship), OnSlimItemChange(ship), SetBallAgility(ship),
// SetMaxSpeed(ship), the values now unpiloted (golden log "Eject from Ship
// and Board ship" line 1009, stamp 32606). Main sent the same. The Stop is
// the ship's Ballpark Stop, applied at the next DoPreTick, so the server's
// ship stops with every client's; its update keeps its place in this order.
presentAbandonedShip(entity) {
    if (!entity || entity.kind !== "ship" || isAbyssalRoomEntityDeliveryHidden(entity)) {
      return false;
    }
    const [ship] = refreshEntitiesForSlimPayload([entity]);
    if (!ship) {
      return false;
    }
    this.queueBallHistory(ship, [{
      payload: destiny.buildSetBallInteractivePayload(ship.itemID, isFreeBallInteractive(ship)),
    }]);
    this.stopShipEntity(ship, { reason: "abandonedShip" });
    this.queueBallHistory(ship, [
      { payload: destiny.buildOnSlimItemChangePayload(ship.itemID, destiny.buildSlimItemObject(ship)) },
      { payload: destiny.buildSetBallAgilityPayload(ship.itemID, ship.inertia) },
      { payload: destiny.buildSetMaxSpeedPayload(ship.itemID, ship.maxVelocity) },
    ]);
    return true;
  },

// A Ball whose pilot or owner changed (a ship boarded or left): its new slim
// item and its interactive flag to its Grid bubble's history, on one stamp.
// Observers that have the Ball keep it; an AddBalls of a Ball the client
// already has would be a second add. The flag is what an Observer's Board
// Ship check reads (the client's celestialCheckers.py IsInteractive), and
// carbon-destiny changes it with the stamped SetBallInteractive action
// (_actions.py set_ball_interactive).
broadcastBallRefresh(entities) {
    if (!Array.isArray(entities) || entities.length === 0) {
      return;
    }
    this.broadcastSlimItemChanges(entities);
    for (const entity of entities) {
      if (!entity || entity.kind !== "ship" || isAbyssalRoomEntityDeliveryHidden(entity)) {
        continue;
      }
      this.queueBallHistory(entity, [{
        stamp: this.historyStamp(),
        payload: destiny.buildSetBallInteractivePayload(
          entity.itemID,
          isFreeBallInteractive(entity),
        ),
      }]);
    }
  },

// The AddBalls2 of a bubble update's additions (scene/visibility.js), stamped
// with the tick being run, the same for every Observer: the Balls as the last
// Evolve left them, their modes and active effects, the missiles'
// LaunchMissile. AddBalls2 first. A pilot's ship met in warp is its AddBalls2
// alone, as TQ sends it and main did: its WARP record already carries its
// position, speed, warp distance, effect stamp and destination, and a setter
// after it (interactive flag, mass, agility, speed, mode, effects) could knock
// the client's warp off its curve.
buildGridBubbleAddUpdates(entities, stamp) {
    const balls = refreshEntitiesForSlimPayload(
      entities.filter((entity) => entity && !isEntityCloaked(entity)),
    );
    if (balls.length === 0) {
      return [];
    }
    const rawSimTimeMs = this.getCurrentSimTimeMs();
    const positionRead = this.positionAuthority.readMany(balls, {
      atSimTimeMs: rawSimTimeMs,
      reason: "destiny-presentation-read",
    });
    const updates = buildAddBallsPresentationUpdates({
      stamp,
      entities: positionRead.entities,
      simFileTime: this.getCurrentFileTime(),
      presentationRawSimTimeMs: rawSimTimeMs,
      scene: this,
      session: null,
      replayActiveSpecialFx: true,
      containsOwnerLaunchedMissiles: false,
      buildAddBalls2Payload: destiny.buildAddBalls2Payload,
      buildLaunchMissilePayload: destiny.buildLaunchMissilePayload,
      buildSetBallInteractivePayload: destiny.buildSetBallInteractivePayload,
      buildPrimeUpdatesForEntities: buildShipPrimeUpdatesForEntities,
      buildModeUpdates: (entity, modeStamp) =>
        this.buildModeUpdates(entity, modeStamp),
      buildActiveSpecialFxReplayUpdates: (
        replayEntities,
        replayStamp,
        replayNowMs,
      ) => buildFreshAcquireActiveSpecialFxReplayUpdates(
        replayEntities,
        replayStamp,
        replayNowMs,
        { scene: this },
      ),
    }).updates;
    const pilotsInWarp = new Set(positionRead.entities
      .filter((entity) => (
        entity.kind === "ship" &&
        entity.session &&
        entity.mode === "WARP" &&
        Number(entity.effectStamp) >= 0
      ))
      .map((entity) => getEntityMapKey(entity.itemID)));
    if (pilotsInWarp.size === 0) {
      return updates;
    }
    return updates.filter((update) => {
      const payload = update && update.payload;
      if (!Array.isArray(payload) || payload[0] === "AddBalls2") {
        return true;
      }
      return !pilotsInWarp.has(getEntityMapKey(getExactPayloadPrimaryEntityID(payload)));
    });
  },

// Updates about Balls of one Grid bubble, each to its Ball's bubble history.
broadcastDestinyUpdatesToBubble(bubbleID, updates) {
    if (!Array.isArray(updates) || updates.length === 0) {
      return {
        deliveredCount: 0,
      };
    }
    this.queueBubbleHistory(updates);
    return {
      deliveredCount: 1,
    };
  },

// A SetState for a session already in space (UpdateStateRequest, a ship
// swap, an eject, the damage-presentation refresh): requested now,
// built by the next doPreTick from the park as the last Evolve left it, and
// sent at the front of the session's next character batch.
sendStateRefresh(session, options = {}) {
    if (!session || !isReadyForDestiny(session)) {
      return false;
    }
    return this.requestSetState(session, (stamp) => this.buildStateRefreshUpdates(session, stamp, options));
  },

buildStateRefreshUpdates(session, stamp, options = {}) {
    const egoEntity = this.getShipEntityForSession(session);
    if (!egoEntity || !isReadyForDestiny(session)) {
      return [];
    }
    refreshShipPresentationFields(egoEntity);
    // The ego, its Grid bubble and every global Ball.
    const visibleEntities = refreshEntitiesForSlimPayload(
      this.getVisibleEntitiesForSession(session),
    );
    const rawSimTimeMs = this.getCurrentSimTimeMs();
    const payload = destiny.buildSetStatePayload(
      stamp,
      this.system,
      egoEntity.itemID,
      visibleEntities,
      this.getCurrentSessionFileTime(session, rawSimTimeMs),
      buildCommandBurstDbuffStateEntriesForSession(session, egoEntity, rawSimTimeMs),
      buildActiveSpecialFxEffectStateEntriesForSetState(this, visibleEntities, rawSimTimeMs),
    );
    // SetState is the session's Grid bubble baseline.
    this.markGridBubbleStateSent(session);
    if (options.skipHudIconReseed !== true) {
      this.reseedEgoHud(session, egoEntity, visibleEntities, rawSimTimeMs);
    }
    return [{ stamp, payload }];
  },

// A same-scene ship swap (eject, board, ship to ship), the one exception to
// a SetState on a ship change: no SetState, which tears down the client's
// brackets and overview on a live park. What only the SetState carried goes
// on its own: the new ego's buff state (the SetState's OnDbuffUpdated for its
// ego) to the pilot's character history, and its jam and command-burst HUD
// re-seed.
presentSameSceneShipSwap(session) {
    const egoEntity = this.getShipEntityForSession(session);
    if (!egoEntity || !isReadyForDestiny(session)) {
      return false;
    }
    const rawSimTimeMs = this.getCurrentSimTimeMs();
    const dbuffState = buildCommandBurstDbuffStateEntriesForSession(session, egoEntity, rawSimTimeMs);
    if (Array.isArray(dbuffState) && dbuffState.length > 0) {
      this.queueCharacterHistory(session, [{
        payload: destiny.buildOnDbuffUpdatedPayload(egoEntity.itemID, dbuffState),
      }]);
    }
    this.reseedEgoHud(
      session,
      egoEntity,
      refreshEntitiesForSlimPayload(this.getVisibleEntitiesForSession(session)),
      rawSimTimeMs,
    );
    return true;
  },

// The ego's HUD re-seed, with a SetState or a ship swap: its jam and
// command-burst states.
reseedEgoHud(session, egoEntity, visibleEntities, rawSimTimeMs) {
    // The HUD reseed names Balls the client has (a SetState gives them). Its
    // jam timers (OnJamStart, a Dogma event) ride the next character batch
    // and its command bursts follow in the same history; OnEwarStart and
    // OnRefreshBuffBar are sent, not queued, so they wait for this tick's
    // doPostTick, after the batch.
    const reseed = {
      send: (target, name, idType, args) => this.afterDestinyBatch(target, () => {
        target.sendNotification(name, idType, args);
      }),
    };
    notifyActiveAssistanceJamStatesToSession(this, session, egoEntity, visibleEntities, rawSimTimeMs, reseed);
    notifyActiveHostileJamStatesToSession(this, session, egoEntity, visibleEntities, rawSimTimeMs, reseed);
    notifyActiveCommandBurstHudStatesToSession(this, session, egoEntity, rawSimTimeMs);
  },

// A session's bootstrap: its client's clock is synced now
// (DoSimClockRebase and the Time Dilation notice are not Destiny updates),
// and its SetState is requested: the next doPreTick builds it from the park
// as the last Evolve left it, stamped with that tick, at the front of the
// session's character history, with the ego's prime, mode and active effects
// after it. A session waiting for its Beyonce bind (a jump) gets nothing
// until the bind. Returns true when the SetState is requested or already
// sent.
ensureInitialBallpark(session, options = {}) {
    if (!session || !session._space) {
      return false;
    }

    if (
      !(this.sessions instanceof Map) ||
      this.sessions.get(session.clientID) !== session ||
      normalizeSceneText(session._space.sceneKey, "") !== normalizeSceneText(this.sceneKey, "")
    ) {
      return false;
    }

    const sessionSolarSystemID = toInt(
      session.solarsystemid2 || session.solarsystemid,
      0,
    );
    if (
      sessionSolarSystemID > 0 &&
      toInt(this.systemID, 0) > 0 &&
      sessionSolarSystemID !== toInt(this.systemID, 0)
    ) {
      log.warn(
        `[SpaceBootstrapGuard] SetState blocked char=${toInt(session.characterID, 0)} ` +
          `ship=${toInt(session._space.shipID, 0)} sceneKey=${normalizeSceneText(this.sceneKey, "none")} ` +
          `sceneSystemID=${toInt(this.systemID, 0)} sessionSolarSystemID=${sessionSolarSystemID} ` +
          `reason=SCENE_SESSION_SYSTEM_MISMATCH`,
      );
      return false;
    }

    const generation = session._space;
    if (generation.initialStateSent && options.force !== true) {
      return true;
    }
    if (this.hasPendingSetState(session) && options.force !== true) {
      return true;
    }
    if (!this.isSessionOpenForDestinyDelivery(session)) {
      return false;
    }
    const egoEntity = this.getShipEntityForSession(session);
    if (!egoEntity) {
      return false;
    }

    // A jump: the client's ballpark exists only once it binds Beyonce, so
    // its SetState waits for the bind (the bind asks again).
    if (
      generation.deferInitialBallparkStateUntilBind === true &&
      generation.beyonceBound !== true &&
      options.allowDeferredJumpBootstrapVisuals === true
    ) {
      return true;
    }

    const skipInitialBallparkRebase = session._skipNextInitialBallparkRebase === true;
    const previousSimTimeMs = resolveBootstrapPreviousSimTimeMs(session, undefined);
    const currentFactor = this.getTimeDilation();
    const rawCurrentSimTimeMs = this.getCurrentSimTimeMs();
    const currentSimTimeMs =
      previousSimTimeMs === undefined || previousSimTimeMs === null
        ? this.getCurrentSessionSimTimeMs(session, rawCurrentSimTimeMs)
        : previousSimTimeMs;
    if (generation.initialBallparkClockSynced !== true) {
      generation.clockOffsetMs = roundNumber(currentSimTimeMs - rawCurrentSimTimeMs, 3);
      this.refreshSessionClockSnapshot(session, rawCurrentSimTimeMs, {
        currentSimTimeMs,
      });
      // Announce the scene's Time Dilation and rebase the client's clock: a
      // jump that leaves TiDi needs it at once.
      if (!sendTimeDilationNotificationToSession(session, currentFactor)) {
        return false;
      }
      const syncResult = this.syncSessionSimClock(session, {
        previousSimTimeMs,
        currentSimTimeMs:
          previousSimTimeMs === undefined || previousSimTimeMs === null
            ? undefined
            : currentSimTimeMs,
        emit: !skipInitialBallparkRebase,
        forceRebase: !skipInitialBallparkRebase,
        expectedSpaceGeneration: generation,
      });
      if (!syncResult || session._space !== generation) {
        return false;
      }
      session._skipNextInitialBallparkRebase = false;
      session._nextInitialBallparkPreviousSimTimeMs = null;
      session._nextInitialBallparkPreviousTimeDilation = null;
      session._nextInitialBallparkPreviousCapturedAtWallclockMs = null;
      generation.initialBallparkClockSynced = true;
    }
    recordSessionJumpTimingTrace(session, "ensure-initial-ballpark-request", {
      options,
      currentFactor,
      currentSimTimeMs,
      sceneTimeState: this.buildTimeStateSnapshot(),
    });

    this.requestSetState(session, (stamp) => this.buildInitialBallparkUpdates(session, generation, stamp));
    return true;
  },

// TQ's undock (the golden logs' 26 station undocks and "Undock citadel and
// stopping ship"): the pilot is an Observer of its Grid bubble from the
// undock, before its SetState. Its first bubble update (tick N) gives it its
// bubble's Balls, its own ship among them, in its character batch; the undock
// prime goes in the bubble's batch on that tick from a station, on the next
// from a citadel (noteUndockEntry); the SetState, alone in its batch, comes on
// the tick after the prime's (buildInitialBallparkUpdates).
beginUndockEntry(session, options = {}) {
    const generation = session && session._space;
    const egoEntity = this.getShipEntityForSession(session);
    if (!generation || !egoEntity || generation.initialStateSent === true) {
      return false;
    }
    const fromStructure = options.fromStructure === true;
    generation.undockEntry = { fromStructure, entryStamp: null };
    generation.awaitedEgoAddID = egoEntity.itemID;
    // The prime leaves in the bubble's batch, not behind the SetState.
    generation.undockBootstrapMovementPrimeSent = true;
    if (!fromStructure) {
      this.queueUndockPrime(egoEntity, false);
    }
    return true;
  },

// The undocking pilot's first bubble update ran at `stamp`. A citadel's prime
// follows on the next tick: queued once this tick's batches are sent.
noteUndockEntry(session, stamp) {
    const entry = session && session._space && session._space.undockEntry;
    if (!entry || entry.entryStamp !== null) {
      return;
    }
    entry.entryStamp = stamp;
    if (entry.fromStructure) {
      this.afterDestinyBatch(session, () => {
        const egoEntity = this.getShipEntityForSession(session);
        if (egoEntity) {
          this.queueUndockPrime(egoEntity, true);
        }
      });
    }
  },

queueUndockPrime(egoEntity, fromStructure) {
    return this.queueBallHistory(
      egoEntity,
      buildUndockBootstrapMovementUpdates(egoEntity, this.historyStamp(), { fromStructure }),
    );
  },

// The bootstrap's SetState and what follows it in the same character batch,
// built by doPreTick (requestSetState) at `stamp`.
buildInitialBallparkUpdates(session, generation, stamp) {
    if (session._space !== generation) {
      return [];
    }
    const egoEntity = this.getShipEntityForSession(session);
    if (!egoEntity) {
      return [];
    }
    // An undock's SetState waits for the tick after its prime's.
    const undockEntry = generation.undockEntry || null;
    if (undockEntry) {
      const settleStamp = undockEntry.entryStamp === null
        ? null
        : undockEntry.entryStamp + (undockEntry.fromStructure ? 2 : 1);
      if (settleStamp === null || stamp < settleStamp) {
        this.requestSetState(
          session,
          (nextStamp) => this.buildInitialBallparkUpdates(session, generation, nextStamp),
        );
        return [];
      }
      generation.undockEntry = null;
    }
    const isStructureObserver =
      generation.observerKind === "structure" &&
      egoEntity.kind === "structure";
    refreshShipPresentationFields(egoEntity);
    const rawCurrentSimTimeMs = this.getCurrentSimTimeMs();
    const visibleDynamicEntities = this.getVisibleDynamicEntitiesForSession(session);
    surveyProbeRuntime.announceSurveyProbesForSession(
      this,
      session,
      visibleDynamicEntities,
    );
    const dynamicEntities = refreshEntitiesForSlimPayload(visibleDynamicEntities);
    const visibleEntities = refreshEntitiesForSlimPayload(
      this.getVisibleEntitiesForSession(session),
    );
    const { bootstrapEntities } = buildInitialBallparkEntityPlan({
      egoEntity,
      dynamicEntities,
      visibleEntities,
      isStructureObserver,
      isIncrementalStaticVisibilityEntity,
      isBootstrapSiteStaticVisibilityEntity,
    });
    // SetState carries everything the Observer sees: its own Ball,
    // the committed members of its Grid bubble and every global Ball.
    const stateEntities = visibleEntities.some((entity) => entity === egoEntity)
      ? visibleEntities
      : [...visibleEntities, egoEntity];
    const simFileTime = this.getCurrentSessionFileTime(session, rawCurrentSimTimeMs);
    const effectStateEntries = buildActiveSpecialFxEffectStateEntriesForSetState(
      this,
      stateEntities,
      rawCurrentSimTimeMs,
    );
    const setStateUpdate = buildInitialBootstrapSetStatePresentationUpdate({
      stamp,
      system: this.system,
      egoEntityID: egoEntity.itemID,
      entities: stateEntities,
      simFileTime,
      dbuffStateEntries: buildCommandBurstDbuffStateEntriesForSession(
        session,
        egoEntity,
        rawCurrentSimTimeMs,
      ),
      effectStateEntries,
    });

    const sendUndockMovementPrime =
      generation.undockBootstrapMovementPrime === true &&
      generation.undockBootstrapMovementPrimeSent !== true;
    const undockMovementUpdates = sendUndockMovementPrime
      ? buildUndockBootstrapMovementUpdates(egoEntity, stamp)
      : [];
    const rawPrimeUpdates = buildShipPrimeUpdatesForEntities(bootstrapEntities, stamp);
    const primeUpdates = sendUndockMovementPrime
      ? rawPrimeUpdates.filter((update) => {
        const payload = update && update.payload;
        return !(
          Array.isArray(payload) &&
          payload[0] === "SetBallMass" &&
          entityIDsEqual(getExactPayloadPrimaryEntityID(payload), egoEntity.itemID)
        );
      })
      : rawPrimeUpdates;
    const modeUpdates = resolveFreshAcquireBootstrapModeUpdates(
      [egoEntity],
      this.buildModeUpdates(egoEntity, stamp),
    );
    const activeSpecialFxReplayUpdates = filterSetStateDuplicateSpecialFxReplayUpdates(
      buildFreshAcquireActiveSpecialFxReplayUpdates(
        bootstrapEntities,
        stamp,
        rawCurrentSimTimeMs,
        { scene: this, session },
      ),
      effectStateEntries,
    );

    // The SetState is the session's Grid bubble baseline: its next bubble
    // update continues from what SetState carried (scene/visibility.js).
    this.markGridBubbleStateSent(session);
    generation.initialBallparkVisualsSent = true;
    generation.initialStateSent = true;
    generation.pendingUndockMovement = false;
    generation.deferInitialBallparkClockUntilBind = false;
    generation.deferInitialBallparkStateUntilBind = false;
    if (sendUndockMovementPrime) {
      generation.undockBootstrapMovementPrimeSent = true;
    }
    logBallDebug("bootstrap.ego", egoEntity, {
      setStateStamp: stamp,
      dynamicEntityCount: bootstrapEntities.length,
      visibleEntityCount: stateEntities.length,
      undockMovementPrime: sendUndockMovementPrime,
    });
    recordSessionJumpTimingTrace(session, "ensure-initial-ballpark-setstate", {
      setStateStamp: stamp,
      visibleEntityCount: stateEntities.length,
    });

    // What follows a bootstrap, queued behind the SetState.
    try {
      notifyActiveAssistanceJamStatesToSession(this, session, egoEntity, visibleEntities, rawCurrentSimTimeMs);
      notifyActiveHostileJamStatesToSession(this, session, egoEntity, visibleEntities, rawCurrentSimTimeMs);
      notifyActiveCommandBurstHudStatesToSession(this, session, egoEntity, rawCurrentSimTimeMs);
      autoMaterializeNearbyUniverseSiteForAttach(this, egoEntity, {
        broadcast: false,
        session,
        nowMs: rawCurrentSimTimeMs,
      });
      const structureID = toInt(generation.pendingUndockStructureSlimItemChangeID, 0);
      if (structureID > 0) {
        generation.pendingUndockStructureSlimItemChangeID = 0;
        const structureEntity = this.getEntityByID(structureID);
        if (structureEntity) {
          this.sendSlimItemChangesToSession(session, [structureEntity]);
        }
      }
      this.syncSessionStructureTetherState(session, {
        nowMs: rawCurrentSimTimeMs,
        forceReplayFx: true,
      });
    } catch (error) {
      log.warn(
        `[SpaceRuntime] Bootstrap follow-up for char=${toInt(session.characterID, 0)} failed: ` +
        `${error && error.stack ? error.stack : error}`,
      );
    }

    // A cyno arrival's JumpDriveIn for its pilot (transitions.js
    // jumpSessionToCynosuralBeacon): one-shot, after the SetState that gives
    // the client the new ship's Ball. Built in the tick that sends the
    // observers' copy, the pilot gets that one in its bubble batch instead.
    const pendingArrival = generation.pendingCynosuralArrivalEffect;
    generation.pendingCynosuralArrivalEffect = null;
    const arrivalUpdates = pendingArrival &&
      entityIDsEqual(pendingArrival.shipID, egoEntity.itemID) &&
      pendingArrival.stamp !== stamp &&
      (pendingArrival.guid === "effects.JumpDriveIn" || pendingArrival.guid === "effects.JumpDriveInBO")
      ? buildSpecialFxPayloadsForEntity(egoEntity.itemID, pendingArrival.guid, {
        start: true,
        active: false,
        duration: 5000,
      }, egoEntity).payloads
      : [];

    // An undock's SetState goes alone (TQ, all 27 undocks): the undock
    // prime and the SetState carry what prime and mode updates would.
    if (undockEntry) {
      return [setStateUpdate, ...activeSpecialFxReplayUpdates];
    }
    return [
      setStateUpdate,
      ...undockMovementUpdates,
      ...primeUpdates,
      ...modeUpdates,
      ...activeSpecialFxReplayUpdates,
      ...arrivalUpdates,
    ];
  },

// AddBall's broadcast. A Ball enters the park when the scene registers it,
// and its Grid bubble's Observers are told at the next doPreTick's bubble
// update (scene/visibility.js), so for a Ball of a bubble nothing is queued
// here. A global Ball's add is queued to every Grid bubble's history.
// Returns the global deliveries. The second argument is ignored: every
// Observer of a bubble gets its bubble batch, the owner included;
// the slot stays because the callers pass their options third.
// options.initialStructureBundle: the structures were just deployed
// (broadcastGlobalBallAdds).
broadcastAddBalls(entities, _excludedSession = null, options = {}) {
    if (!Array.isArray(entities) || entities.length === 0) {
      return [];
    }
    const hiddenEntities = entities.filter(isAbyssalRoomEntityDeliveryHidden);
    if (hiddenEntities.length > 0) {
      this.abyssalPrewarmPublicationDiagnostics.blockedDirectPublicationCount += hiddenEntities.length;
    }
    const globals = entities.filter((entity) => (
      entity &&
      !isAbyssalRoomEntityDeliveryHidden(entity) &&
      this.isGlobalBall(entity)
    ));
    if (globals.length === 0) {
      return [];
    }
    return this.broadcastGlobalBallAdds(globals, options);
  },

// A global Ball's AddBalls goes to every Grid bubble's history, built
// once (retail's add_ball_to_client_parks, _ticker.py:172-195). A structure
// just deployed (options.initialStructureBundle, or the structure's own
// initialStructureBundle, staticSceneEntity) comes as TQ sends it: its
// damage state, the AddBalls2, then its slim item, at one stamp (EveBadStuff
// "Citadel Launch - Position - Start Anchor Timer", one DoDestinyUpdate of
// OnDamageStateChange, AddBalls2, OnSlimItemChange).
broadcastGlobalBallAdds(entities, options = {}) {
    const refreshedEntities = refreshEntitiesForSlimPayload(entities);
    const stamp = this.historyStamp();
    const addUpdates = this.buildGridBubbleAddUpdates(refreshedEntities, stamp);
    if (addUpdates.length === 0) {
      return [];
    }
    const deployedStructures = refreshedEntities.filter((entity) => (
      entity &&
      entity.kind === "structure" &&
      (options.initialStructureBundle === true || entity.initialStructureBundle === true)
    ));
    const fileTime = this.getCurrentFileTime();
    const updates = [
      ...deployedStructures.flatMap((entity) => buildDamageStatePresentationUpdates({
        stamp,
        entityID: entity.itemID,
        damageState: destiny.buildDamageState(entity, fileTime),
      })),
      ...addUpdates,
      ...deployedStructures.flatMap((entity) => buildSlimItemPresentationUpdates({
        stamp,
        entityID: entity.itemID,
        slimItem: destiny.buildSlimItemObject(entity),
      })),
    ];
    this.queueEveryBubbleHistory(updates);
    const deliveries = [];
    for (const session of this.sessions.values()) {
      if (!isReadyForDestiny(session)) {
        continue;
      }
      deliveries.push({
        delivered: true,
        session,
        stamp,
        entities: refreshedEntities,
      });
    }
    return deliveries;
  },

// A global Ball's removal is RemoveBalls in every Grid bubble's
// history, the client having no handler for the global-removal actions.
broadcastGlobalBallRemoval(entityID, options = {}) {
    const normalizedEntityID = getEntityMapKey(entityID);
    if (normalizedEntityID === null) {
      return { deliveredCount: 0 };
    }
    const stamp = this.historyStamp();
    const updates = buildTerminalDestructionRemoveBallsPresentationUpdates({
      entityIDs: [normalizedEntityID],
      stamp,
      terminalDestructionEffectID: toInt(options.terminalDestructionEffectID, 0),
      destiny,
    });
    this.queueEveryBubbleHistory(updates);
    let deliveredCount = 0;
    for (const session of this.sessions.values()) {
      if (isReadyForDestiny(session)) {
        deliveredCount += 1;
      }
    }
    return { deliveredCount };
  },

// A destruction effect (TerminalPlayDestructionEffect) is a Gameplay event:
// an entry in the Grid bubble history of the bubble the
// Ball left, at the stamp of the bubble update whose RemoveBalls removes it
// there, so the client reads it as that removal's exploder
// (michelle.py:1156) and the wreck's add shares the bucket. A missile that
// hit carries TQ's (missile, None), the client's default explosion
// (options.missileHit); one that missed vanishes with none.
queueTerminalDestructionEffect(entityID, terminalDestructionEffectID, entity = null, options = {}) {
    const normalizedEntityID = getEntityMapKey(entityID);
    const missileHit = options.missileHit === true;
    const effectID = missileHit ? null : toInt(terminalDestructionEffectID, 0);
    if (
      normalizedEntityID === null ||
      (!missileHit && (effectID <= 0 || (entity && entity.kind === "missile")))
    ) {
      return null;
    }
    const bubble = gridBubbles.committedBubbleOf(this.getGridBubbles(), normalizedEntityID);
    if (bubble === null || bubble === undefined) {
      return null;
    }
    return this.queueBallHistory(
      normalizedEntityID,
      [destiny.buildTerminalPlayDestructionEffectPayload(normalizedEntityID, effectID)],
      { bubble, stamp: this.nextBubbleUpdateStamp() },
    );
  },

// RemoveBall's broadcast. The Ball left the park when the scene unregistered
// it, and its Grid bubble's Observers get the RemoveBalls at the next bubble
// update; only a global's removal is queued now, to every Grid bubble's
// history. The second argument is ignored, as broadcastAddBalls'.
broadcastRemoveBall(entityID, _excludedSession = null, options = {}) {
    const visibilityEntity =
      options && options.visibilityEntity && typeof options.visibilityEntity === "object"
        ? options.visibilityEntity
        : null;
    if (visibilityEntity && visibilityEntity.isGlobal === true) {
      const result = this.broadcastGlobalBallRemoval(entityID, options);
      return { attemptedCount: result.deliveredCount, deliveredCount: result.deliveredCount };
    }
    this.queueTerminalDestructionEffect(entityID, options && options.terminalDestructionEffectID, visibilityEntity, {
      missileHit: Boolean(options && options.missileHitExplosion === true),
    });
    return { attemptedCount: 0, deliveredCount: 0 };
  },

broadcastRemoveStaticEntity(entityID, _excludedSession = null, options = {}) {
    if (options && options.wasGlobal === true) {
      return this.broadcastGlobalBallRemoval(entityID, options);
    }
    this.queueTerminalDestructionEffect(entityID, options && options.terminalDestructionEffectID);
    return { deliveredCount: 0 };
  },

// A ship's prime values changed (SetBallMass, SetBallAgility, SetMaxSpeed):
// to its Grid bubble's history, its owner included.
broadcastShipPrimeUpdates(entity, options = {}) {
    if (!entity || entity.kind !== "ship") {
      return {
        stamp: null,
        deliveredCount: 0,
      };
    }
    const hasExplicitUpdates = Array.isArray(options.updates);
    const hasPreviousState =
      options.previousState &&
      typeof options.previousState === "object" &&
      ["inertia", "mass", "maxVelocity"].every((field) => (
        Object.prototype.hasOwnProperty.call(options.previousState, field)
      ));
    if (!hasExplicitUpdates && !hasPreviousState) {
      return {
        stamp: null,
        deliveredCount: 0,
      };
    }
    const stamp = this.nextDestinyStamp;
    const primeUpdates = hasExplicitUpdates
      ? options.updates
      : buildShipPrimeDeltaUpdates(entity, options.previousState, stamp);
    if (primeUpdates.length === 0) {
      return {
        stamp: null,
        deliveredCount: 0,
      };
    }
    this.queueBallHistory(entity, primeUpdates);
    return {
      stamp,
      deliveredCount: 1,
    };
  },

// Movement updates with a special effect on one Ball: each to its Ball's Grid
// bubble history, the effect after them.
broadcastMovementUpdatesWithSpecialFx(
    updates,
    shipID,
    guid,
    fxOptions = {},
    visibilityEntity = null,
  ) {
    const movementUpdates = Array.isArray(updates) ? updates : [];
    const rawFxOptions =
      fxOptions && typeof fxOptions === "object"
        ? { ...fxOptions }
        : {};
    const { payloads: fxPayloads } = buildSpecialFxPayloadsForEntity(
      shipID,
      guid,
      rawFxOptions,
      visibilityEntity,
    );
    const stamp = this.nextDestinyStamp;
    if (movementUpdates.length > 0) {
      this.queueBubbleHistory(movementUpdates);
    }
    if (fxPayloads.length > 0) {
      this.queueBallHistory(visibilityEntity || shipID, fxPayloads);
    }
    return {
      stamp,
      deliveredCount: movementUpdates.length > 0 || fxPayloads.length > 0 ? 1 : 0,
    };
  },

canSessionReceiveDestiny(session) {
    return Boolean(session && session._space && isReadyForDestiny(session));
  },
};
