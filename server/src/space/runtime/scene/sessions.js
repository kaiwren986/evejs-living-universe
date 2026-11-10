"use strict";

const runtimeEntryDirname = require("path").resolve(__dirname, "../..");
const path = require("path");
const {
  seedBallSlots,
} = require(path.join(runtimeEntryDirname, "./destiny/simulation/evolve.js"));
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
  buildTetherPresentationUpdates,
} = require(path.join(
  runtimeEntryDirname,
  "./destiny/presentation/specialFxPayloads.js",
));
const mapTelemetryState = require(path.join(
  runtimeEntryDirname,
  "../services/map/mapTelemetryState",
));
const structureTethering = require(path.join(
  runtimeEntryDirname,
  "./structureTethering",
));
const {
  isReadyForDestiny,
} = require("../destinyDeliveryEligibility");
const {
  buildUndockMovement,
  resetEntityMotion,
} = require("../destinyMovementEngine");
const {
  persistEntityCapacitorRatio,
} = require("../entityCapacitor");
const {
  INVALID_RUNTIME_PERSISTENT_IDENTITY,
  applyRuntimeEntityScopeMetadata,
  clearPlayerShipGenericDungeonScope,
  hasRuntimePersistentIdentityValue,
  replaceRuntimeDungeonTrackingState,
} = require("../entityScopeTags");
const {
  persistShipEntity,
} = require("../entitySpacePersistence");
const {
  resolvePreservedSimTimeMs,
} = require("../firstSightPresentation");
const {
  finalizeGenericModuleDeactivationWithoutSession,
} = require("../moduleEffectShutdown");
const {
  roundNumber,
  toFiniteNumber,
  toInt,
} = require("../../../common/numbers");
const {
  clampTimeDilationFactor,
} = require("../runtimeClock");
const {
  recordSessionJumpTimingTrace,
} = require("../runtimeDebugInstrumentation");
const {
  lazyRequire,
} = require("../runtimeModuleBoundary");
const {
  SCENE_KIND_ABYSSAL,
  SCENE_KIND_SOLAR_SYSTEM,
  buildAbyssalSceneKey,
  decorateEntitySceneOwnership,
  getSceneKeyForSession,
  normalizeSceneText,
} = require("../sceneIdentity");
const {
  applyStargateJumpCloakState,
} = require("../shipCloak");
const {
  applySessionStateToShipEntity,
  buildShipEntity,
  clearSessionStateFromShipEntity,
} = require("../shipEntity");
const {
  handleDroneControllerLostSafe,
  handleFighterControllerLostSafe,
  queueControlledFightersReturnToTubesSafe,
} = require("../squadronRuntimeBridge");
const {
  normalizeLegacyStationState,
} = require("../stationDockingGeometry");
const {
  buildStructureObserverSpaceState,
  clearControlledStaticStructureDogmaHostIdentity,
  hydrateControlledStaticStructureDogmaHost,
  isControlledStaticStructureHostForSession,
  prepareControlledStaticStructureDogmaHost,
  restoreObjectShallowSnapshot,
} = require("../structureSessionHost");
const {
  breakEntityStructureTether,
  buildStructureTetherFxOptions,
  resolveStructureTetherFxEntity,
  syncEntityStructureTetherState,
} = require("../structureTether");
const {
  TARGET_LOSS_REASON_ATTEMPT_CANCELLED,
  ensureEntityTargetingState,
} = require("../targeting");
const {
  cloneVector,
} = require("../../../common/vector");
const sceneFeatureHooks = require("./sceneFeatureHooks");

module.exports = {

attachSession(session, shipItem, options = {}) {
    if (!session || !shipItem) {
      return null;
    }

    const shipEntity = buildShipEntity(session, shipItem, this.systemID);
    decorateEntitySceneOwnership(shipEntity, this.sceneDescriptor);
    const dungeonTrackingRuntime = lazyRequire(
      "../services/dungeon/dungeonTrackingRuntime",
    );
    const rawCurrentDungeonInstanceID = shipEntity.dungeonCurrentInstanceID;
    const hasPersistedCurrentDungeonInstanceID =
      hasRuntimePersistentIdentityValue(rawCurrentDungeonInstanceID);
    const currentDungeonInstanceID = normalizePersistentEntityID(
      rawCurrentDungeonInstanceID,
    );
    let currentDungeonContextAuthorized = false;
    // Set only where the stored tracker named a pocket that no longer exists: "released" when the
    // tracker was cleared, "deferred-to-parked-teardown" when this scene's parked teardown still owns
    // the release. The warp recovery below reads it so neither outcome is undone by the quarantine
    // it writes.
    let currentDungeonTrackerPurgeDisposition = null;
    if (hasPersistedCurrentDungeonInstanceID) {
      const currentDungeonRoomKey = String(
        shipEntity.dungeonCurrentRoomKey || "",
      ).trim();
      const hasCurrentDungeonSiteID = hasRuntimePersistentIdentityValue(
        shipEntity.dungeonCurrentSiteID,
      );
      const currentDungeonResolution = currentDungeonInstanceID === null
        ? null
        : this.resolveAuthorizedDestinationDungeonContext(
            session,
            currentDungeonInstanceID,
            {
              ...(currentDungeonRoomKey
                ? { roomKey: currentDungeonRoomKey }
                : {}),
              ...(hasCurrentDungeonSiteID
                ? { siteID: shipEntity.dungeonCurrentSiteID }
                : {}),
            },
          );
      if (currentDungeonResolution) {
        dungeonTrackingRuntime.markShipCurrentDungeonRoom(
          shipEntity,
          currentDungeonResolution.instance,
          currentDungeonRoomKey || "room:entry",
          {
            nowMs: this.getCurrentSimTimeMs(),
            roomPosition: Array.isArray(shipEntity.dungeonCurrentRoomPosition)
              ? {
                  x: shipEntity.dungeonCurrentRoomPosition[0],
                  y: shipEntity.dungeonCurrentRoomPosition[1],
                  z: shipEntity.dungeonCurrentRoomPosition[2],
                }
              : shipEntity.position,
            siteID: currentDungeonResolution.siteID,
          },
        );
        currentDungeonContextAuthorized = true;
      } else if (
        currentDungeonInstanceID !== null &&
        this.isPurgedDungeonInstance(currentDungeonInstanceID) &&
        this.hasParkedDungeonSiteTeardownForInstance(currentDungeonInstanceID)
      ) {
        // The record is gone but this scene still has the teardown parked, so that teardown is the
        // thing that releases this pilot and their companions together -- which is why
        // releaseSurvivorsStrandedByPurgedInstances skips these instances as well. Leave the tracker
        // exactly as persisted: quarantining would destroy the one thing the teardown matches on,
        // since releasePlayerShipsFromSitePocket keys on the instance id the marker overwrites.
        currentDungeonTrackerPurgeDisposition = "deferred-to-parked-teardown";
      } else if (
        currentDungeonInstanceID !== null &&
        this.isPurgedDungeonInstance(currentDungeonInstanceID)
      ) {
        // The pocket is gone entirely, so there is nothing left to quarantine the pilot out of -- and
        // the marker would be permanent, because it carries no site ID and can never resolve again
        // while the fail-closed persist rewrites it on every save. That costs the pilot every drone
        // and fighter command: getPlayerCompanionSecurityScope reads a present-but-unnormalizable
        // tracker as scope.invalid, and securityScopesExactlyMatch refuses before it ever looks at
        // the companion, so drones left in the site when it despawned become unscoopable for good.
        // Release the tracker instead, which is what the pilot would have got from
        // releasePlayerShipsFromSitePocket had they been on grid when the site tore down.
        //
        // Purged, not merely terminal. Every other reason a context fails to resolve -- a live pocket
        // this pilot may not enter, a finished site, a room or site mismatch -- still quarantines,
        // because those are access decisions rather than a missing pocket.
        currentDungeonTrackerPurgeDisposition = "released";
        dungeonTrackingRuntime.clearShipCurrentDungeonRoom(shipEntity, {
          nowMs: this.getCurrentSimTimeMs(),
        });
      } else {
        shipEntity.dungeonCurrentInstanceID =
          INVALID_RUNTIME_PERSISTENT_IDENTITY;
      }
    }
    // A ship saved in warp into a private site, or out of one, was stored
    // where it was with its warp's landing (savedWarpLanding.js); settle it
    // now that its pilot is here: at the landing point with the
    // destination's tracker when the pilot may be there, where it is
    // otherwise.
    if (shipEntity.savedWarpLanding) {
      const persistedWarpState = shipEntity.savedWarpLanding;
      shipEntity.savedWarpLanding = null;
      const hasPersistedDestinationInstanceID =
        hasRuntimePersistentIdentityValue(
          persistedWarpState.destinationStaticInstanceID,
        );
      const destinationStaticInstanceID = normalizePersistentEntityID(
        persistedWarpState.destinationStaticInstanceID,
      );
      const requiresDungeonVisibilityRecovery = Boolean(
        hasPersistedDestinationInstanceID ||
        hasPersistedCurrentDungeonInstanceID
      );
      let recoveredDungeonVisibilityAtDestination = false;
      let rejectedDungeonDestinationAuthority = false;
      let destinationReleasedAsPurged = false;
      let rejectedDungeonContextOutcome = "invalid context quarantined";
      if (requiresDungeonVisibilityRecovery) {
        const recoveryDestination = cloneVector(
          persistedWarpState.targetPoint ||
          persistedWarpState.rawDestination,
          shipEntity.position,
        );
        if (
          hasPersistedDestinationInstanceID &&
          destinationStaticInstanceID === null
        ) {
          rejectedDungeonDestinationAuthority = true;
        } else if (destinationStaticInstanceID !== null) {
          const persistedDestinationRoomKey = String(
            persistedWarpState.destinationDungeonRoomKey || "",
          ).trim();
          const hasPersistedDestinationSiteID = Boolean(
            persistedWarpState.destinationDungeonSiteID !== null &&
            persistedWarpState.destinationDungeonSiteID !== undefined
          );
          const destinationResolution =
            this.resolveAuthorizedDestinationDungeonContext(
              session,
              destinationStaticInstanceID,
              {
                ...(persistedDestinationRoomKey
                  ? { roomKey: persistedDestinationRoomKey }
                  : {}),
                ...(hasPersistedDestinationSiteID
                  ? { siteID: persistedWarpState.destinationDungeonSiteID }
                  : {}),
              },
            );
          if (destinationResolution) {
            shipEntity.position = recoveryDestination;
            dungeonTrackingRuntime.markShipCurrentDungeonRoom(
              shipEntity,
              destinationResolution.instance,
              String(
                destinationResolution.roomKey ||
                (
                  currentDungeonInstanceID !== null &&
                  entityIDsEqual(
                    currentDungeonInstanceID,
                    destinationStaticInstanceID,
                  )
                    ? shipEntity.dungeonCurrentRoomKey
                    : null
                ) ||
                "room:entry",
              ).trim() || "room:entry",
              {
                nowMs: this.getCurrentSimTimeMs(),
                roomPosition: recoveryDestination,
                siteID: destinationResolution.siteID,
              },
            );
            recoveredDungeonVisibilityAtDestination = true;
          } else {
            rejectedDungeonDestinationAuthority = true;
            // Same distinction the current-tracker branch above draws: a destination that was purged
            // mid-warp is a pocket that no longer exists, not a pocket this pilot was refused. A parked
            // teardown for it does not change that. The teardown releases ships by their
            // dungeonCurrentInstanceID, and a ship still in warp never carried its destination's, so a
            // marker written here would never clear. A tracker that names the same parked instance is
            // still left for the teardown by the deferred disposition below.
            destinationReleasedAsPurged = this.isPurgedDungeonInstance(
              destinationStaticInstanceID,
            );
          }
        } else if (
          hasPersistedCurrentDungeonInstanceID &&
          !currentDungeonContextAuthorized
        ) {
          rejectedDungeonDestinationAuthority = true;
        } else {
          shipEntity.position = recoveryDestination;
          dungeonTrackingRuntime.clearShipCurrentDungeonRoom(shipEntity, {
            nowMs: this.getCurrentSimTimeMs(),
          });
          recoveredDungeonVisibilityAtDestination = true;
        }
        if (
          rejectedDungeonDestinationAuthority &&
          !currentDungeonContextAuthorized
        ) {
          // A pilot who logged off mid-warp into a site that was then purged has nothing to be
          // quarantined out of either, and quarantining here would silently undo whatever the
          // current-tracker branch above decided. Suppress the marker only when every rejection in
          // play is a purge: a destination whose own identity would not normalize, or a live pocket
          // this pilot may not enter, still quarantines.
          const quarantineSuppressedByPurge =
            (
              !hasPersistedDestinationInstanceID ||
              destinationReleasedAsPurged
            ) &&
            (
              !hasPersistedCurrentDungeonInstanceID ||
              currentDungeonTrackerPurgeDisposition !== null
            );
          if (
            currentDungeonTrackerPurgeDisposition ===
              "deferred-to-parked-teardown"
          ) {
            // The parked teardown still owns this tracker; neither clearing nor quarantining it here
            // may take that away.
            rejectedDungeonContextOutcome =
              "its purged site tracker left for the parked teardown";
          } else if (quarantineSuppressedByPurge) {
            dungeonTrackingRuntime.clearShipCurrentDungeonRoom(shipEntity, {
              nowMs: this.getCurrentSimTimeMs(),
            });
            rejectedDungeonContextOutcome = "its purged site context released";
          } else {
            shipEntity.dungeonCurrentInstanceID =
              INVALID_RUNTIME_PERSISTENT_IDENTITY;
          }
        }
      }
      log.warn(
        requiresDungeonVisibilityRecovery
          ? recoveredDungeonVisibilityAtDestination
            ? `[SpaceRuntime] Settled persisted dungeon warp for ship=${shipEntity.itemID} at its authorized destination during login recovery.`
            : `[SpaceRuntime] Rejected persisted dungeon warp authority for ship=${shipEntity.itemID}; spawning stopped at its persisted position with ${currentDungeonContextAuthorized ? "the previously authorized context preserved" : rejectedDungeonContextOutcome}.`
          : `[SpaceRuntime] Restoring persisted warp state for ship=${shipEntity.itemID} on login is unsupported; spawning stopped at current position instead.`,
      );
      resetEntityMotion(shipEntity);
      shipEntity.targetEntityID = null;
    }
    if (options.skipLegacyStationNormalization !== true) {
      normalizeLegacyStationState(shipEntity);
    }
    if (options.spawnStopped) {
      resetEntityMotion(shipEntity);
    } else if (options.undockDirection) {
      buildUndockMovement(
        shipEntity,
        options.undockDirection,
        options.speedFraction ?? 1,
      );
    }

    ensureEntityTargetingState(shipEntity);
    const attachedSceneCurrentSimTimeMs = this.getCurrentSimTimeMs();
    if (options.stargateJumpCloak === true) {
      applyStargateJumpCloakState(shipEntity, {
        nowMs: attachedSceneCurrentSimTimeMs,
        durationMs: options.stargateJumpCloakDurationMs,
      });
    }
    session._space = {
      systemID: this.systemID,
      sceneKey: this.sceneKey,
      sceneKind: this.sceneKind,
      instanceID: this.instanceID,
      shipID: shipEntity.itemID,
      beyonceBound: Boolean(options.beyonceBound),
      initialStateSent: Boolean(options.initialStateSent),
      initialBallparkVisualsSent: Boolean(options.initialBallparkVisualsSent),
      initialBallparkClockSynced: Boolean(options.initialBallparkClockSynced),
      initialBallparkBootstrapInProgress: false,
      deferInitialBallparkClockUntilBind:
        options.deferInitialBallparkClockUntilBind === true,
      deferInitialBallparkStateUntilBind:
        options.deferInitialBallparkStateUntilBind === true,
      pendingUndockMovement: Boolean(options.pendingUndockMovement),
      undockBootstrapMovementPrime:
        options.undockBootstrapMovementPrime === true,
      undockBootstrapMovementPrimeSent: false,
      clockOffsetMs: 0,
      timeDilation: this.getTimeDilation(),
      simTimeMs: this.getCurrentSimTimeMs(),
      simFileTime: this.getCurrentFileTime(),
    };

    // The accepted scene attachment is the authoritative in-space location.
    // Keep the session aliases in step before a bootstrap caller validates
    // them against this scene; character-state reconciliation is only a later
    // persistence repair and must not be the primary write path.
    session.solarsystemid = this.systemID;
    session.solarsystemid2 = this.systemID;
    try {
      mapTelemetryState.recordSolarSystemVisit(session, this.systemID);
    } catch (error) {
      log.warn(
        `[SpaceRuntime] Failed to record map visit characterID=${session.characterID || 0} systemID=${this.systemID}: ${error.message}`,
      );
    }

    this.sessions.set(session.clientID, session);
    seedBallSlots(shipEntity);
    this.dynamicEntities.set(shipEntity.itemID, shipEntity);
    sceneFeatureHooks.notifyEntityAdded(this, shipEntity, { via: "attach", session });
    this.markBallJoiningMovement(shipEntity);
    // AddBall: the ship is in its Grid bubble now; the other Observers are
    // told at the next bubble update, the pilot by its SetState.
    this.reboxBall(shipEntity);
    persistShipEntity(shipEntity);
    session._skipNextInitialBallparkRebase =
      options.skipNextInitialBallparkRebase === true;
    session._nextInitialBallparkPreviousSimTimeMs =
      options.initialBallparkPreviousSimTimeMs === undefined ||
      options.initialBallparkPreviousSimTimeMs === null
        ? null
        : toFiniteNumber(options.initialBallparkPreviousSimTimeMs, null);
    session._nextInitialBallparkPreviousTimeDilation =
      options.initialBallparkPreviousTimeDilation === undefined ||
      options.initialBallparkPreviousTimeDilation === null
        ? null
        : clampTimeDilationFactor(options.initialBallparkPreviousTimeDilation);
    session._nextInitialBallparkPreviousCapturedAtWallclockMs =
      options.initialBallparkPreviousCapturedAtWallclockMs === undefined ||
      options.initialBallparkPreviousCapturedAtWallclockMs === null
        ? null
        : toFiniteNumber(options.initialBallparkPreviousCapturedAtWallclockMs, null);
    const preservedCurrentSessionSimTimeMs = resolvePreservedSimTimeMs(
      options.initialBallparkPreviousSimTimeMs,
      options.initialBallparkPreviousTimeDilation,
      options.initialBallparkPreviousCapturedAtWallclockMs,
      null,
    );
    if (preservedCurrentSessionSimTimeMs !== null) {
      session._space.clockOffsetMs = roundNumber(
        preservedCurrentSessionSimTimeMs - attachedSceneCurrentSimTimeMs,
        3,
      );
    }
    const syncResult = this.syncSessionSimClock(session, {
      previousSimTimeMs: options.previousSimTimeMs,
      currentSimTimeMs:
        preservedCurrentSessionSimTimeMs === null
          ? undefined
          : preservedCurrentSessionSimTimeMs,
      emit: options.emitSimClockRebase !== false,
      forceRebase: options.forceSimClockRebase === true,
    });
    if (options.stargateJumpCloak === true) {
      this.sendStargateJumpCloakUpdated(shipEntity, {
        nowMs: attachedSceneCurrentSimTimeMs,
      });
    }
    recordSessionJumpTimingTrace(session, "attach-session", {
      systemID: this.systemID,
      shipID: shipEntity.itemID,
      options: {
        beyonceBound: options.beyonceBound === true,
        pendingUndockMovement: options.pendingUndockMovement === true,
        spawnStopped: options.spawnStopped === true,
        broadcast: options.broadcast !== false,
        emitSimClockRebase: options.emitSimClockRebase !== false,
        forceSimClockRebase: options.forceSimClockRebase === true,
        previousSimTimeMs:
          options.previousSimTimeMs === undefined ? null : options.previousSimTimeMs,
        initialBallparkPreviousSimTimeMs:
          options.initialBallparkPreviousSimTimeMs === undefined
            ? null
            : options.initialBallparkPreviousSimTimeMs,
        initialBallparkPreviousTimeDilation:
          options.initialBallparkPreviousTimeDilation === undefined
            ? null
            : options.initialBallparkPreviousTimeDilation,
        initialBallparkPreviousCapturedAtWallclockMs:
          options.initialBallparkPreviousCapturedAtWallclockMs === undefined
            ? null
            : options.initialBallparkPreviousCapturedAtWallclockMs,
        deferInitialBallparkClockUntilBind:
          options.deferInitialBallparkClockUntilBind === true,
        deferInitialBallparkStateUntilBind:
          options.deferInitialBallparkStateUntilBind === true,
        undockBootstrapMovementPrime:
          options.undockBootstrapMovementPrime === true,
      },
      sceneTimeState: this.buildTimeStateSnapshot(),
      sessionClockOffsetMs: session._space.clockOffsetMs,
      syncResult,
    });

    log.info(
      `[SpaceRuntime] Attached ${session.characterName || session.characterID} ship=${shipEntity.itemID} to system ${this.systemID}`,
    );

    if (
      this.sceneKind === SCENE_KIND_SOLAR_SYSTEM &&
      options.spawnAsteroidBeltRats !== false
    ) {
      this.maybeSpawnAsteroidBeltRatsForArrival(session, shipEntity, {
        nowMs: attachedSceneCurrentSimTimeMs,
        broadcast: false,
        source: "attachSession",
      });
    }

    if (session._space && session._space.initialStateSent === true) {
      this.syncSessionStructureTetherState(session, {
        nowMs: attachedSceneCurrentSimTimeMs,
        forceReplayFx: true,
      });
    }

    return shipEntity;
  },

maybeSpawnAsteroidBeltRatsForArrival(session, shipEntity, options = {}) {
    if (!session || !shipEntity || shipEntity.session !== session) {
      return {
        success: false,
        spawned: false,
        reason: "SESSION_SHIP_MISMATCH",
      };
    }

    try {
      const beltRatRuntime = lazyRequire("./npc/beltRatRuntime");
      if (
        beltRatRuntime &&
        typeof beltRatRuntime.maybeSpawnForSessionArrival === "function"
      ) {
        return beltRatRuntime.maybeSpawnForSessionArrival(
          this,
          session,
          shipEntity,
          options,
        );
      }
    } catch (error) {
      log.warn(
        `[SpaceRuntime] Belt-rat arrival check failed for system=${this.systemID}: ${error.message}`,
      );
    }

    return {
      success: false,
      spawned: false,
      reason: "BELT_RAT_RUNTIME_UNAVAILABLE",
    };
  },

// A session takes over a ship already in the scene (boarding it in space,
// or an abyssal relog). The stop, the slot seed and the re-box below are a
// documented immediate change, outside the Movement queue: they are how the
// Ball is handed to its new pilot, whose SetState is built from them, as
// adding a Ball is, not a movement order.
attachSessionToExistingEntity(session, shipItem, entity, options = {}) {
    if (!session || !shipItem || !entity || entity.kind !== "ship") {
      return null;
    }

    const previousEntitySession = entity.session || null;
    const preserveAuthoritativeEntityState = Boolean(
      options.preserveAuthoritativeEntityState === true &&
      this.sceneKind === SCENE_KIND_ABYSSAL &&
      previousEntitySession &&
      previousEntitySession._abyssalOfflineSession === true &&
      toInt(previousEntitySession._abyssalOfflineRunID, 0) ===
        toInt(this.instanceID, 0) &&
      toInt(previousEntitySession.characterID || previousEntitySession.charid, 0) ===
        toInt(session.characterID || session.charid, 0) &&
      toInt(previousEntitySession._space && previousEntitySession._space.shipID, 0) ===
        toInt(entity.itemID, 0)
    );
    if (Object.hasOwn(options, "inheritedPlayerEgoScopeState")) {
      const inheritedPlayerEgoScopeState =
        options.inheritedPlayerEgoScopeState;
      replaceRuntimeDungeonTrackingState(
        entity,
        inheritedPlayerEgoScopeState,
      );
      applyRuntimeEntityScopeMetadata(
        entity,
        inheritedPlayerEgoScopeState,
      );
      clearPlayerShipGenericDungeonScope(entity, { playerOwned: true });
    }
    applySessionStateToShipEntity(entity, session, shipItem, {
      preserveAuthoritativeConditionState: preserveAuthoritativeEntityState,
    });
    decorateEntitySceneOwnership(entity, this.sceneDescriptor);
    ensureEntityTargetingState(entity);
    if (
      entity.mode === "WARP" &&
      Number(entity.effectStamp) >= 0
    ) {
      log.warn(
        `[SpaceRuntime] Restoring persisted warp state for boarded ship=${entity.itemID} is unsupported; spawning stopped at current position instead.`,
      );
      resetEntityMotion(entity);
      entity.targetEntityID = null;
    }
    if (options.skipLegacyStationNormalization !== true) {
      normalizeLegacyStationState(entity);
    }
    if (preserveAuthoritativeEntityState) {
      // The retained Abyssal hull continued to simulate while its pilot was
      // offline. Relog only changes transport ownership; it must not heal the
      // hull or cancel motion that NPC combat advanced after disconnect.
    } else if (options.spawnStopped) {
      resetEntityMotion(entity);
    } else if (options.undockDirection) {
      buildUndockMovement(
        entity,
        options.undockDirection,
        options.speedFraction ?? 1,
      );
    }
    if (!preserveAuthoritativeEntityState) {
      seedBallSlots(entity);
    }

    session._space = {
      systemID: this.systemID,
      sceneKey: this.sceneKey,
      sceneKind: this.sceneKind,
      instanceID: this.instanceID,
      shipID: entity.itemID,
      beyonceBound: Boolean(options.beyonceBound),
      initialStateSent: Boolean(options.initialStateSent),
      initialBallparkVisualsSent: Boolean(options.initialBallparkVisualsSent),
      initialBallparkClockSynced: Boolean(options.initialBallparkClockSynced),
      initialBallparkBootstrapInProgress: false,
      deferInitialBallparkClockUntilBind:
        options.deferInitialBallparkClockUntilBind === true,
      deferInitialBallparkStateUntilBind:
        options.deferInitialBallparkStateUntilBind === true,
      pendingUndockMovement: Boolean(options.pendingUndockMovement),
      clockOffsetMs: 0,
      timeDilation: this.getTimeDilation(),
      simTimeMs: this.getCurrentSimTimeMs(),
      simFileTime: this.getCurrentFileTime(),
    };

    this.sessions.set(session.clientID, session);
    sceneFeatureHooks.notifyEntityAdded(this, entity, { via: "attach", session });
    this.reboxBall(entity);
    persistShipEntity(entity);
    session._skipNextInitialBallparkRebase =
      options.skipNextInitialBallparkRebase === true;
    session._nextInitialBallparkPreviousSimTimeMs =
      options.initialBallparkPreviousSimTimeMs === undefined ||
      options.initialBallparkPreviousSimTimeMs === null
        ? null
        : toFiniteNumber(options.initialBallparkPreviousSimTimeMs, null);
    session._nextInitialBallparkPreviousTimeDilation =
      options.initialBallparkPreviousTimeDilation === undefined ||
      options.initialBallparkPreviousTimeDilation === null
        ? null
        : clampTimeDilationFactor(options.initialBallparkPreviousTimeDilation);
    session._nextInitialBallparkPreviousCapturedAtWallclockMs =
      options.initialBallparkPreviousCapturedAtWallclockMs === undefined ||
      options.initialBallparkPreviousCapturedAtWallclockMs === null
        ? null
        : toFiniteNumber(options.initialBallparkPreviousCapturedAtWallclockMs, null);
    const attachedExistingSceneCurrentSimTimeMs = this.getCurrentSimTimeMs();
    const preservedExistingSessionSimTimeMs = resolvePreservedSimTimeMs(
      options.initialBallparkPreviousSimTimeMs,
      options.initialBallparkPreviousTimeDilation,
      options.initialBallparkPreviousCapturedAtWallclockMs,
      null,
    );
    if (preservedExistingSessionSimTimeMs !== null) {
      session._space.clockOffsetMs = roundNumber(
        preservedExistingSessionSimTimeMs - attachedExistingSceneCurrentSimTimeMs,
        3,
      );
    }
    const syncResult = this.syncSessionSimClock(session, {
      previousSimTimeMs: options.previousSimTimeMs,
      currentSimTimeMs:
        preservedExistingSessionSimTimeMs === null
          ? undefined
          : preservedExistingSessionSimTimeMs,
      emit: options.emitSimClockRebase !== false,
      forceRebase: options.forceSimClockRebase === true,
    });
    recordSessionJumpTimingTrace(session, "attach-session-existing-entity", {
      systemID: this.systemID,
      shipID: entity.itemID,
      options: {
        beyonceBound: options.beyonceBound === true,
        pendingUndockMovement: options.pendingUndockMovement === true,
        spawnStopped: options.spawnStopped === true,
        broadcast: options.broadcast !== false,
        emitSimClockRebase: options.emitSimClockRebase !== false,
        forceSimClockRebase: options.forceSimClockRebase === true,
        previousSimTimeMs:
          options.previousSimTimeMs === undefined ? null : options.previousSimTimeMs,
        initialBallparkPreviousSimTimeMs:
          options.initialBallparkPreviousSimTimeMs === undefined
            ? null
            : options.initialBallparkPreviousSimTimeMs,
        initialBallparkPreviousTimeDilation:
          options.initialBallparkPreviousTimeDilation === undefined
            ? null
            : options.initialBallparkPreviousTimeDilation,
        initialBallparkPreviousCapturedAtWallclockMs:
          options.initialBallparkPreviousCapturedAtWallclockMs === undefined
            ? null
            : options.initialBallparkPreviousCapturedAtWallclockMs,
        deferInitialBallparkClockUntilBind:
          options.deferInitialBallparkClockUntilBind === true,
        deferInitialBallparkStateUntilBind:
          options.deferInitialBallparkStateUntilBind === true,
      },
      sceneTimeState: this.buildTimeStateSnapshot(),
      sessionClockOffsetMs: session._space.clockOffsetMs,
      syncResult,
    });

    log.info(
      `[SpaceRuntime] Attached ${session.characterName || session.characterID} to existing ship=${entity.itemID} in system ${this.systemID}`,
    );

    if (
      this.sceneKind === SCENE_KIND_SOLAR_SYSTEM &&
      options.spawnAsteroidBeltRats !== false
    ) {
      this.maybeSpawnAsteroidBeltRatsForArrival(session, entity, {
        nowMs: attachedExistingSceneCurrentSimTimeMs,
        broadcast: false,
        source: "attachSessionToExistingEntity",
      });
    }

    if (options.broadcast !== false) {
      this.broadcastSlimItemChanges([entity]);
      this.broadcastBallRefresh([entity], session);
    }
    if (session._space && session._space.initialStateSent === true) {
      this.syncSessionStructureTetherState(session, {
        nowMs: attachedExistingSceneCurrentSimTimeMs,
        forceReplayFx: true,
      });
    }

    return entity;
  },

syncSessionStructureTetherState(session, options = {}) {
    if (!session || !session._space) {
      return {
        success: false,
        errorMsg: "NOT_IN_SPACE",
      };
    }

    const entity = this.getShipEntityForSession(session);
    if (!entity) {
      return {
        success: false,
        errorMsg: "SHIP_NOT_FOUND",
      };
    }

    const result = syncEntityStructureTetherState(this, entity, {
      nowMs: options.nowMs,
      broadcastFx: false,
      replaySession: session,
      replayFx: options.replayFx !== false,
      forceReplayFx: options.forceReplayFx === true,
      repairOnEngage: options.repairOnEngage !== false,
      suppressRepairFx: options.suppressRepairFx === true,
    });
    const repaired = result.repaired;
    const repairedModules =
      repaired && Array.isArray(repaired.repairedModules)
        ? repaired.repairedModules
        : [];
    const repairedDrones =
      repaired && Array.isArray(repaired.repairedDrones)
        ? repaired.repairedDrones
        : [];
    if (
      result.changed ||
      result.fxReplayed ||
      (
        repaired &&
        (
          repaired.repairedShip ||
          repaired.rechargedCapacitor ||
          repairedModules.length > 0 ||
          repairedDrones.length > 0
        )
      )
    ) {
      persistShipEntity(entity);
    }

    return {
      success: true,
      data: result,
    };
  },

sendTqUndockTetherPresentationToSession(session, entityOrID, structureOrID) {
    if (!session || !isReadyForDestiny(session)) {
      return false;
    }
    const entity =
      entityOrID && typeof entityOrID === "object"
        ? entityOrID
        : this.getEntityByID(entityOrID);
    const structureEntity =
      resolveStructureTetherFxEntity(this, structureOrID) || structureOrID;
    const entityID = toInt(entity && entity.itemID, 0);
    if (entityID <= 0 || !structureEntity) {
      return false;
    }

    const emittedStamp = this.queueCharacterHistory(
      session,
      buildTetherPresentationUpdates({
        stamp: this.nextDestinyStamp,
        entityID,
        tetherFxGuid: structureTethering.TETHER_FX_GUID,
        tetherFxOptions: buildStructureTetherFxOptions(structureEntity, true),
        mass: entity.mass,
      }),
    );
    persistShipEntity(entity);
    return emittedStamp !== null;
  },

preflightControlledStructureSession(session, structureID, options = {}) {
    const targetStructureID = toInt(structureID, 0);
    if (!session || targetStructureID <= 0) {
      return { success: false, errorMsg: "STRUCTURE_NOT_FOUND" };
    }

    let structureEntity = this.staticEntitiesByID.get(targetStructureID) || null;
    if (!structureEntity && options.syncStructures !== false) {
      this.syncStructureEntitiesFromState({ broadcast: false });
      structureEntity = this.staticEntitiesByID.get(targetStructureID) || null;
    }
    if (!structureEntity || structureEntity.kind !== "structure") {
      return { success: false, errorMsg: "STRUCTURE_NOT_FOUND" };
    }

    const allowedControllerSession = options.preflightOnly === true
      ? options.allowControllerSession || null
      : null;
    const controllerSessions = new Set();
    if (this.sessions instanceof Map) {
      for (const candidateSession of this.sessions.values()) {
        if (
          candidateSession &&
          isControlledStaticStructureHostForSession(
            this,
            candidateSession,
            structureEntity,
          )
        ) {
          controllerSessions.add(candidateSession);
        }
      }
    }
    if (structureEntity.session) {
      controllerSessions.add(structureEntity.session);
    }
    const conflictingController = [...controllerSessions].find(
      (candidateSession) =>
        candidateSession !== session &&
        candidateSession !== allowedControllerSession,
    ) || null;
    if (conflictingController) {
      return {
        success: false,
        errorMsg: "STRUCTURE_ALREADY_CONTROLLED",
        data: { entity: structureEntity, conflictingController },
      };
    }

    try {
      const candidatePreparation = options.preparation;
      const preparation =
        candidatePreparation &&
        candidatePreparation.scene === this &&
        candidatePreparation.session === session &&
        candidatePreparation.entity === structureEntity &&
        toInt(candidatePreparation.structureID, 0) === targetStructureID
          ? candidatePreparation
          : prepareControlledStaticStructureDogmaHost(
              this,
              session,
              structureEntity,
            );
      if (!preparation) {
        return { success: false, errorMsg: "STRUCTURE_CONTROL_BIND_FAILED" };
      }
      return {
        success: true,
        data: {
          scene: this,
          entity: structureEntity,
          preparation,
        },
      };
    } catch (error) {
      return {
        success: false,
        errorMsg: error && error.message
          ? `STRUCTURE_CONTROL_BIND_FAILED: ${error.message}`
          : "STRUCTURE_CONTROL_BIND_FAILED",
      };
    }
  },

bindControlledStructureSession(session, structureID, options = {}) {
    const targetStructureID = toInt(structureID, 0);
    const preflightResult = this.preflightControlledStructureSession(
      session,
      targetStructureID,
      {
        ...options,
        preparation: options.preparedBinding || options.preparation,
      },
    );
    if (!preflightResult.success || options.preflightOnly === true) {
      return preflightResult;
    }

    const structureEntity = preflightResult.data.entity;
    const preparation = preflightResult.data.preparation;

    const currentSpaceState = session._space || null;
    const hadStructureViewSpace = Object.prototype.hasOwnProperty.call(
      session,
      "_structureViewSpace",
    );
    const previousStructureViewSpace = session._structureViewSpace;
    const hadPreviousDynamicHost = Object.prototype.hasOwnProperty.call(
      session,
      "_structureControlPreviousDynamicHost",
    );
    const storedPreviousDynamicHost = session._structureControlPreviousDynamicHost;
    const alreadyObservingStructure = Boolean(
      currentSpaceState &&
        normalizeSceneText(currentSpaceState.observerKind, "") === "structure" &&
        toInt(currentSpaceState.shipID, 0) === targetStructureID &&
        getSceneKeyForSession(session) === this.sceneKey,
    );
    const hadPreviousSpaceState = Object.prototype.hasOwnProperty.call(
      session,
      "_structureControlPreviousSpace",
    );
    const previousControlledSpaceState = session._structureControlPreviousSpace;
    const previousSceneSession = this.sessions.get(session.clientID);
    const hadPreviousSceneSession = this.sessions.has(session.clientID);
    const previousEntityState = { ...structureEntity };
    const previousDynamicEntity =
      !alreadyObservingStructure &&
      currentSpaceState &&
      this.dynamicEntities instanceof Map
        ? this.dynamicEntities.get(toInt(currentSpaceState.shipID, 0)) || null
        : null;
    const previousDynamicIdentity =
      previousDynamicEntity && previousDynamicEntity.session === session
        ? {
            session: previousDynamicEntity.session,
            characterID: previousDynamicEntity.characterID,
            pilotCharacterID: previousDynamicEntity.pilotCharacterID,
            corporationID: previousDynamicEntity.corporationID,
            allianceID: previousDynamicEntity.allianceID,
            warFactionID: previousDynamicEntity.warFactionID,
          }
        : null;

    const observerBaseState = alreadyObservingStructure
      ? currentSpaceState
      : session._structureViewSpace || currentSpaceState;
    const observerState = buildStructureObserverSpaceState(
      this,
      targetStructureID,
      observerBaseState,
    );
    observerState.controlledStructureHost = true;
    observerState.pendingBallparkBind = false;

    try {
      const hydratedEntity = hydrateControlledStaticStructureDogmaHost(
        this,
        session,
        structureEntity,
        { preparation },
      );
      if (!hydratedEntity) {
        throw new Error("STRUCTURE_CONTROL_BIND_FAILED");
      }
      if (!hadPreviousSpaceState) {
        session._structureControlPreviousSpace = alreadyObservingStructure
          ? null
          : currentSpaceState;
      }
      if (previousDynamicIdentity && !hadPreviousDynamicHost) {
        session._structureControlPreviousDynamicHost = {
          sceneKey: this.sceneKey,
          entityID: toInt(previousDynamicEntity.itemID, 0),
          entity: previousDynamicEntity,
          identity: previousDynamicIdentity,
        };
        // The old ship remains a physical dynamic ball while the session owns
        // the structure observer. Remove only its transport owner pointer; its
        // persisted character/corporation presentation is restored verbatim on
        // eject and normal detach performs the full unpiloted cleanup.
        previousDynamicEntity.session = null;
      }
      session._space = observerState;
      session._structureViewSpace = observerState;
      this.sessions.set(session.clientID, session);
      return {
        success: true,
        data: {
          scene: this,
          entity: hydratedEntity,
          observerState,
          previousSpaceState: session._structureControlPreviousSpace || null,
        },
      };
    } catch (error) {
      restoreObjectShallowSnapshot(structureEntity, previousEntityState);
      session._space = currentSpaceState;
      if (hadStructureViewSpace) {
        session._structureViewSpace = previousStructureViewSpace;
      } else {
        delete session._structureViewSpace;
      }
      if (hadPreviousSpaceState) {
        session._structureControlPreviousSpace = previousControlledSpaceState;
      } else {
        delete session._structureControlPreviousSpace;
      }
      if (previousDynamicIdentity) {
        Object.assign(previousDynamicEntity, previousDynamicIdentity);
      }
      if (hadPreviousDynamicHost) {
        session._structureControlPreviousDynamicHost = storedPreviousDynamicHost;
      } else {
        delete session._structureControlPreviousDynamicHost;
      }
      if (hadPreviousSceneSession) {
        this.sessions.set(session.clientID, previousSceneSession);
      } else {
        this.sessions.delete(session.clientID);
      }
      return {
        success: false,
        errorMsg: error && error.message
          ? `STRUCTURE_CONTROL_BIND_FAILED: ${error.message}`
          : "STRUCTURE_CONTROL_BIND_FAILED",
      };
    }
  },

releaseControlledStructureSession(session, options = {}) {
    if (!session || !session._space) {
      const sessionStillClaimsControl = Boolean(
        session &&
        toInt(session.shipID || session.shipid, 0) > 0 &&
        toInt(session.shipID || session.shipid, 0) ===
          toInt(session.structureID || session.structureid, 0),
      );
      if (!sessionStillClaimsControl && session) {
        delete session._structureControlPreviousSpace;
        session._structureViewSpace = null;
      }
      return sessionStillClaimsControl
        ? {
            success: false,
            errorMsg: "STRUCTURE_CONTROL_SCENE_NOT_FOUND",
            data: { changed: false, entity: null },
          }
        : { success: true, data: { changed: false, entity: null } };
    }

    const structureID = toInt(session._space.shipID, 0);
    const structureEntity = this.staticEntitiesByID.get(structureID) || null;
    if (!isControlledStaticStructureHostForSession(this, session, structureEntity)) {
      return {
        success: false,
        errorMsg: "STRUCTURE_CONTROL_STATE_MISMATCH",
        data: { changed: false, entity: structureEntity },
      };
    }

    const releaseReason = options.reason || "structureControlRelease";
    // Explicit Release/Eject queues fighters before its session mutation and
    // marks that work below. Transport teardown can call this scene method
    // directly, so keep recall in the canonical release invariant as well.
    const fighterRecallResult = options.fightersAlreadyQueued === true
      ? { success: true, queuedCount: 0, skipped: true }
      : queueControlledFightersReturnToTubesSafe(this, structureEntity, {
          ownerSession: session,
          reason: releaseReason,
        });
    const releaseNowMs = this.getCurrentSimTimeMs();
    let deactivationResult;
    try {
      deactivationResult = options.deactivateModules === false
        ? { success: true, data: { stoppedModuleIDs: [], errors: [] } }
        : this.deactivateAllActiveModules(session, {
            reason: releaseReason,
            nowMs: releaseNowMs,
          });
    } catch (error) {
      deactivationResult = {
        success: false,
        errorMsg: "ACTIVE_MODULE_DEACTIVATION_FAILED",
        data: {
          stoppedModuleIDs: [],
          errors: [{
            moduleID: 0,
            errorMsg: error && error.message
              ? error.message
              : "ACTIVE_MODULE_DEACTIVATION_FAILED",
          }],
        },
      };
    }

    const residualCleanupErrors = [];
    if (
      options.deactivateModules !== false &&
      structureEntity.activeModuleEffects instanceof Map &&
      structureEntity.activeModuleEffects.size > 0
    ) {
      for (const effectState of [...structureEntity.activeModuleEffects.values()]) {
        const moduleID = toInt(effectState && effectState.moduleID, 0);
        try {
          const cleanupResult = finalizeGenericModuleDeactivationWithoutSession(
            this,
            structureEntity,
            effectState,
            {
              reason: releaseReason,
              nowMs: releaseNowMs,
            },
          );
          if (!cleanupResult || cleanupResult.success !== true) {
            residualCleanupErrors.push({
              moduleID,
              errorMsg:
                cleanupResult && cleanupResult.errorMsg ||
                "RESIDUAL_MODULE_CLEANUP_FAILED",
            });
          }
        } catch (error) {
          residualCleanupErrors.push({
            moduleID,
            errorMsg: error && error.message
              ? error.message
              : "RESIDUAL_MODULE_CLEANUP_FAILED",
          });
        } finally {
          // The family-aware fallback above gets the first opportunity to
          // remove projected state. Never transfer a still-cycling effect to a
          // later controller even if that cleanup itself reports an error.
          structureEntity.activeModuleEffects.delete(moduleID);
        }
      }
    }
    if (Array.isArray(structureEntity.pendingModuleStopNotifications)) {
      structureEntity.pendingModuleStopNotifications.length = 0;
    }
    const deactivationErrors = [
      ...(
        deactivationResult &&
        deactivationResult.data &&
        Array.isArray(deactivationResult.data.errors)
          ? deactivationResult.data.errors
          : []
      ),
      ...residualCleanupErrors,
    ];
    const deactivationFailed = Boolean(
      !deactivationResult ||
      deactivationResult.success === false ||
      deactivationErrors.length > 0,
    );
    deactivationResult = {
      ...(deactivationResult || {}),
      success: !deactivationFailed,
      errorMsg: deactivationFailed
        ? "ACTIVE_MODULE_DEACTIVATION_FAILED"
        : null,
      data: {
        ...(
          deactivationResult && deactivationResult.data
            ? deactivationResult.data
            : {}
        ),
        errors: deactivationErrors,
        residualModuleIDs:
          structureEntity.activeModuleEffects instanceof Map
            ? [...structureEntity.activeModuleEffects.keys()]
            : [],
      },
    };
    this.clearAllTargetingForEntity(structureEntity, {
      notifySelf: true,
      notifyTarget: true,
      reason: TARGET_LOSS_REASON_ATTEMPT_CANCELLED,
    });
    persistEntityCapacitorRatio(structureEntity);
    clearControlledStaticStructureDogmaHostIdentity(session, structureEntity);

    const previousSpaceState = Object.prototype.hasOwnProperty.call(
      session,
      "_structureControlPreviousSpace",
    )
      ? session._structureControlPreviousSpace
      : null;
    const previousDynamicHost = session._structureControlPreviousDynamicHost || null;
    delete session._structureControlPreviousSpace;
    delete session._structureControlPreviousDynamicHost;
    session._structureViewSpace = null;
    if (previousSpaceState) {
      previousSpaceState.timeDilation = this.getTimeDilation();
      previousSpaceState.simTimeMs = this.getCurrentSimTimeMs();
      previousSpaceState.simFileTime = this.getCurrentFileTime();
      session._space = previousSpaceState;
      this.sessions.set(session.clientID, session);
      if (
        previousDynamicHost &&
        previousDynamicHost.entity &&
        previousDynamicHost.identity &&
        normalizeSceneText(previousDynamicHost.sceneKey, "") === this.sceneKey &&
        this.dynamicEntities.get(toInt(previousDynamicHost.entityID, 0)) ===
          previousDynamicHost.entity
      ) {
        Object.assign(previousDynamicHost.entity, previousDynamicHost.identity);
      }
    } else {
      session._space = null;
      if (this.sessions.get(session.clientID) === session) {
        this.sessions.delete(session.clientID);
      }
    }

    return {
      success: !deactivationFailed,
      errorMsg: deactivationResult.errorMsg || null,
      data: {
        changed: true,
        entity: structureEntity,
        previousSpaceState: previousSpaceState || null,
        fighterRecallResult,
        deactivationResult,
      },
    };
  },

detachSession(session, options = {}) {
    lazyRequire("../services/starbase/starbaseControlRuntime").releaseStarbaseControlForSession(session);
    if (!session || !session._space) {
      return null;
    }
    const registeredSession = this.sessions.get(session.clientID) || null;
    if (registeredSession && registeredSession !== session) {
      // A reconnect can replace a transport under the same stable client ID
      // before the old socket's close callback arrives. The stale generation
      // must not evict or tear down the replacement scene occupant.
      session._space = null;
      return null;
    }

    const controlledStructure = this.staticEntitiesByID.get(
      toInt(session._space.shipID, 0),
    ) || null;
    if (
      isControlledStaticStructureHostForSession(
        this,
        session,
        controlledStructure,
      )
    ) {
      const releaseResult = this.releaseControlledStructureSession(session, {
        reason: options.lifecycleReason || "sessionDetach",
      });
      if (!releaseResult || !releaseResult.data || releaseResult.data.changed !== true) {
        return null;
      }
      if (!session._space) {
        return null;
      }
    }

    recordSessionJumpTimingTrace(session, "detach-session", {
      systemID: session._space.systemID,
      shipID: session._space.shipID,
      broadcast: options.broadcast !== false,
      sessionSimTimeMs: session._space.simTimeMs,
      sessionSimFileTime: session._space.simFileTime,
      sessionTimeDilation: session._space.timeDilation,
    });
    const sourceSpace = session._space;
    const entity = this.dynamicEntities.get(sourceSpace.shipID) || null;
    // Its features are told while it is still an Observer (Scene feature
    // hooks). Tow links end at transport departure, headless Abyssal
    // retention included.
    sceneFeatureHooks.notifySessionLeaving(this, session, entity, {
      reason: "detach",
      options,
    });
    const requestedAbyssalRunID = toInt(options.abyssalRunID, 0);
    const requestedAbyssalCharacterID = toInt(options.abyssalCharacterID, 0);
    const requestedAbyssalShipID = toInt(options.abyssalShipID, 0);
    const sessionCharacterID = toInt(session.characterID || session.charid, 0);
    const preserveAbyssalOfflineShip = Boolean(
      options.preserveAbyssalOfflineShip === true &&
      requestedAbyssalRunID > 0 &&
      requestedAbyssalCharacterID > 0 &&
      requestedAbyssalShipID > 0 &&
      sessionCharacterID === requestedAbyssalCharacterID &&
      this.sceneKind === SCENE_KIND_ABYSSAL &&
      toInt(this.instanceID, 0) === requestedAbyssalRunID &&
      normalizeSceneText(this.sceneKey, "") ===
        buildAbyssalSceneKey(requestedAbyssalRunID) &&
      normalizeSceneText(sourceSpace.sceneKey, "") ===
        buildAbyssalSceneKey(requestedAbyssalRunID) &&
      normalizeSceneText(sourceSpace.sceneKind, "") === SCENE_KIND_ABYSSAL &&
      toInt(sourceSpace.instanceID, 0) === requestedAbyssalRunID &&
      toInt(sourceSpace.shipID, 0) === requestedAbyssalShipID &&
      entity &&
      entity.kind === "ship" &&
      toInt(entity.itemID, 0) === requestedAbyssalShipID &&
      entity.session === session
    );
    let offlineSession = null;
    if (this.sessions.get(session.clientID) === session) {
      this.sessions.delete(session.clientID);
      this.forgetGridBubbleObserver(session);
      // A session that leaves takes its character history with it.
      this.dropDestinyObserver(session);
    }
    if (entity) {
      // A validated Abyssal disconnect retains the authoritative combat owner
      // in its exact isolated scene. Only the network transport changes:
      // movement, active modules, locks, drones, and fighters keep advancing
      // under the room simulation while NPCs and the absolute timer continue.
      // Ordinary detach still performs the normal teardown below.
      if (!preserveAbyssalOfflineShip) {
        this.clearAllTargetingForEntity(entity, {
          notifySelf: options.notifySelfOnTargetClear === true,
          notifyTarget: true,
          reason: TARGET_LOSS_REASON_ATTEMPT_CANCELLED,
        });
        handleDroneControllerLostSafe(this, entity, {
          lifecycleReason: options.lifecycleReason,
          attemptBayRecovery: options.attemptDroneBayRecovery === true,
        });
        handleFighterControllerLostSafe(this, entity, {
          lifecycleReason: options.lifecycleReason,
          attemptTubeRecovery: options.attemptFighterTubeRecovery === true,
        });
      }
      if (preserveAbyssalOfflineShip) {
        const characterID = sessionCharacterID;
        const shipID = toInt(entity.itemID, 0);
        const offlineClientID =
          `abyssal-offline:${requestedAbyssalRunID}:${characterID}:${shipID}`;
        const offlineSocket = {
          destroyed: false,
          _abyssalOfflineTransport: true,
          destroy() {
            this.destroyed = true;
          },
        };
        offlineSession = {
          ...session,
          clientID: offlineClientID,
          clientid: offlineClientID,
          _abyssalOfflineSession: true,
          _abyssalOfflineRunID: requestedAbyssalRunID,
          _abyssalOfflineOriginalClientID: session.clientID,
          _space: {
            ...sourceSpace,
            sceneKey: this.sceneKey,
            sceneKind: this.sceneKind,
            instanceID: requestedAbyssalRunID,
            shipID,
            // Headless delivery is deliberately accepted by the canonical
            // same-scene destruction path; there is no remote client to seed.
            initialStateSent: true,
            initialBallparkVisualsSent: true,
            initialBallparkClockSynced: true,
          },
          socket: offlineSocket,
          closed: false,
          disconnected: false,
          _closed: false,
          _notifications: [],
          currentBoundObjectID: null,
          lastBoundObjectID: null,
          _boundObjectIDs: null,
          sendNotification() {
            return true;
          },
          sendServiceNotification() {
            return true;
          },
          sendSessionChange() {
            return true;
          },
        };
        // Never retain a real network transport or pending delivery queue on a
        // synthetic owner. Only the inert socket contract above is permitted.
        offlineSession.transport = null;
        offlineSession.connection = null;
        offlineSession._pendingCommandSessionEffects = null;
        entity.session = offlineSession;
        this.sessions.set(offlineClientID, offlineSession);
        persistShipEntity(entity);
      } else {
        this.unregisterDynamicEntity(entity, {
          broadcast: options.broadcast !== false,
          excludedSession: session,
          preserveBreacherApplicationBudget: options.preserveBreacherApplicationBudget === true,
        });
      }
    }

    session._space = null;
    return offlineSession;
  },

disembarkSession(session, options = {}) {
    if (!session || !session._space) {
      return null;
    }
    const registeredSession = this.sessions.get(session.clientID) || null;
    if (registeredSession && registeredSession !== session) {
      session._space = null;
      return null;
    }

    const controlledStructure = this.staticEntitiesByID.get(
      toInt(session._space.shipID, 0),
    ) || null;
    if (
      isControlledStaticStructureHostForSession(
        this,
        session,
        controlledStructure,
      )
    ) {
      const releaseResult = this.releaseControlledStructureSession(session, {
        reason: options.lifecycleReason || "sessionDisembark",
      });
      if (!releaseResult || !releaseResult.data || releaseResult.data.changed !== true) {
        return null;
      }
      if (!session._space) {
        return null;
      }
    }

    const entity = this.dynamicEntities.get(session._space.shipID) || null;
    // Its features are told before it leaves (Scene feature hooks): the rack
    // heat clear among them, queued for it as a Dogma event.
    sceneFeatureHooks.notifySessionLeaving(this, session, entity, {
      reason: "disembark",
      options,
    });

    // The pilot stays an Observer of this scene until its ship's cleanup has
    // run: the target cleanup (OnTarget) and the drone and fighter control
    // changes it is told of are queued for it like any other, and leave with
    // a doPostTick. A same-scene ship change (eject, board) attaches
    // it again before the next tick, so it keeps its character history and
    // its collected Dogma events across the change.
    if (entity) {
      breakEntityStructureTether(this, entity, {
        reason: "DISEMBARKED",
      });
      this.clearAllTargetingForEntity(entity, {
        notifySelf: true,
        notifyTarget: true,
        reason: TARGET_LOSS_REASON_ATTEMPT_CANCELLED,
      });
      handleDroneControllerLostSafe(this, entity, {
        lifecycleReason: options.lifecycleReason,
        attemptBayRecovery: options.attemptDroneBayRecovery === true,
      });
      handleFighterControllerLostSafe(this, entity, {
        lifecycleReason: options.lifecycleReason,
        attemptTubeRecovery: options.attemptFighterTubeRecovery === true,
      });
      clearSessionStateFromShipEntity(entity);
      persistShipEntity(entity);
    }
    if (this.sessions.get(session.clientID) === session) {
      this.sessions.delete(session.clientID);
    }

    session._space = null;

    if (entity && options.broadcast !== false) {
      this.presentAbandonedShip(entity);
    }

    return entity;
  },

prepareSameSceneSessionTetherRelease(session, entity) {
    if (!session || !session._space || !entity) {
      return {
        success: false,
        errorMsg: "INVALID_SAME_SCENE_TETHER_RELEASE",
      };
    }
    if (!structureTethering.isEntityStructureTethered(entity)) {
      return {
        success: true,
        requiredDelivery: false,
      };
    }

    // The release FX goes to the ship's Grid bubble history; a queued entry
    // is accepted.
    const released = breakEntityStructureTether(this, entity, {
      reason: "DISEMBARKED",
      resultSession: session,
    });
    if (!released) {
      return {
        success: false,
        errorMsg: "SAME_SCENE_TETHER_RELEASE_FAILED",
      };
    }
    return {
      success: true,
      requiredDelivery: true,
    };
  },

markBeyonceBound(session) {
    if (session && session._space) {
      session._space.beyonceBound = true;
    }
  },
};
