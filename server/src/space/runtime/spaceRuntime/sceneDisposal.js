"use strict";

const runtimeEntryDirname = require("path").resolve(__dirname, "../..");
const path = require("path");
const {
  ABYSSAL_LOCATION_ID_MIN,
  ABYSSAL_LOCATION_ID_COUNT,
  isAbyssalHostLocationID,
} = require("../../../abyssal").engineSupport.hostLocation;
const log = require(path.join(runtimeEntryDirname, "../utils/logger"));
const nativeNpcStore = require(path.join(runtimeEntryDirname, "./npc/nativeNpcStore"));
const {
  persistDynamicEntity,
} = require("../entitySpacePersistence");
const {
  hasKnownNativeControllerSceneRematerializer,
  hasValidDungeonNativeSceneOwner,
  storedNativeRecordBelongsToSolarSystemScene,
} = require("../nativeRecordSceneOwnership");
const {
  toFiniteNumber,
  toInt,
} = require("../../../common/numbers");
const {
  getWallclockNowMs,
} = require("../runtimeClock");
const {
  lazyRequire,
} = require("../runtimeModuleBoundary");
const {
  SCENE_KIND_SOLAR_SYSTEM,
  buildSolarSystemSceneKey,
  normalizeSceneDescriptor,
  normalizeSceneText,
} = require("../sceneIdentity");
const {
  EMPTY_SOLAR_SYSTEM_COLLECTION_GRACE_MS,
  EMPTY_SOLAR_SYSTEM_COLLECTION_MAX_PER_SWEEP,
  EMPTY_SOLAR_SYSTEM_RETAINED_OBJECT_GRACE_MS,
  getEmptySolarSystemRetainedObjectState,
} = require("../solarSystemSceneLifecycle");
const {
  resolveAlwaysOnSolarSystemIDs,
} = require("../startupPreloadPlan");
const sceneFeatureHooks = require("../scene/sceneFeatureHooks");

module.exports = {

prepareEmptySolarSystemSceneForDisposal(scene) {
    if (
      !scene ||
      scene.sceneKind !== SCENE_KIND_SOLAR_SYSTEM ||
      !(scene.sessions instanceof Map) ||
      scene.sessions.size > 0
    ) {
      return {
        success: false,
        errorMsg: "SCENE_NOT_EMPTY_SOLAR_SYSTEM",
      };
    }

    const systemID = toInt(scene.systemID, 0);
    // Persistence is the one expected fallible part of scene release. Complete
    // it before cancelling timers or removing any runtime-owned state so a
    // storage failure leaves a coherent, still-live scene for a later retry.
    const dynamicEntitiesBeforeCleanup = scene.dynamicEntities instanceof Map
      ? [...scene.dynamicEntities.values()]
      : [];
    try {
      require("../../../services/homefront/homefrontHooks").runtime.releaseScene(
        scene,
      );
      for (const entity of dynamicEntitiesBeforeCleanup) {
        if (!entity || entity.persistSpaceState !== true) {
          continue;
        }
        const persistResult = persistDynamicEntity(entity);
        if (!persistResult || persistResult.success === false) {
          return {
            success: false,
            errorMsg:
              persistResult && persistResult.errorMsg ||
              "DYNAMIC_ENTITY_PERSIST_FAILED",
            systemID,
            entityID: toInt(entity.itemID, 0) || null,
          };
        }
      }
    } catch (error) {
      return {
        success: false,
        errorMsg: error.message,
        systemID,
      };
    }

    this.cancelPendingAttachUniverseSiteReconcile(systemID, scene);

    // Everything below this point is the disposal commit. Persistence above is
    // the only operation allowed to abort while the scene is still live. Late
    // cleanup failures are recorded and the remaining release steps continue,
    // so disposeScene never leaves a partially stripped scene registered.
    const cleanupErrors = [];
    const recordCleanupError = (stage, error, details = {}) => {
      cleanupErrors.push({
        stage,
        errorMsg:
          error && error.errorMsg ||
          error && error.message ||
          String(error || "SCENE_CLEANUP_FAILED"),
        ...details,
      });
    };
    let dematerializedNpcCount = 0;
    let discardedNativeNpcCount = 0;
    let discardedNativeNpcFighterCount = 0;
    let preservedNativeNpcCount = 0;
    let deferredNativeNpcCleanupCount = 0;
    let discardedNativeWreckCount = 0;
    let preservedNativeWreckCount = 0;
    let npcRegistry = null;
    let liveControllers = [];
    try {
      npcRegistry = lazyRequire("./npc/npcRegistry");
      liveControllers = typeof npcRegistry.listControllersForScene === "function"
        ? npcRegistry.listControllersForScene(scene)
        : [];
      const nativeNpcService = liveControllers.length > 0
        ? lazyRequire("./npc/nativeNpcService")
        : null;
      const liveControllersByEntityID = new Map(
        liveControllers
          .map((controller) => [
            toInt(controller && (controller.entityID || controller.itemID), 0),
            controller,
          ])
          .filter(([entityID]) => entityID > 0),
      );
      const storedEntitiesByEntityID = new Map(
        nativeNpcStore
          .listNativeEntitiesForSystem(systemID)
          .filter((record) => storedNativeRecordBelongsToSolarSystemScene(record, scene))
          .map((record) => [toInt(record && record.entityID, 0), record])
          .filter(([entityID]) => entityID > 0),
      );
      const storedControllersByEntityID = new Map(
        nativeNpcStore
          .listNativeControllersForSystem(systemID)
          .filter((record) => storedNativeRecordBelongsToSolarSystemScene(record, scene))
          .map((record) => [toInt(record && record.entityID, 0), record])
          .filter(([entityID]) => entityID > 0),
      );
      const nativeEntityIDs = new Set([
        ...liveControllersByEntityID.keys(),
        ...storedEntitiesByEntityID.keys(),
        ...storedControllersByEntityID.keys(),
      ]);
      const controllerIDsWithLiveFighters = new Set();
      if (scene.dynamicEntities instanceof Map) {
        for (const entity of scene.dynamicEntities.values()) {
          const controllerID = entity && entity.kind === "fighter"
            ? toInt(entity.controllerID, 0)
            : 0;
          if (controllerID > 0) {
            controllerIDsWithLiveFighters.add(controllerID);
          }
        }
      }

      for (const entityID of nativeEntityIDs) {
        const liveController = liveControllersByEntityID.get(entityID) || null;
        const storedEntity = storedEntitiesByEntityID.get(entityID) || null;
        const storedController = storedControllersByEntityID.get(entityID) || null;
        const canRematerialize = hasKnownNativeControllerSceneRematerializer(
          storedController,
          storedEntity,
          scene,
        );
        let deferNativeStoreDeletion = false;
        if (!canRematerialize && controllerIDsWithLiveFighters.has(entityID)) {
          try {
            const npcSupercarrierDirector = lazyRequire(
              "../services/fighter/npc/npcSupercarrierDirector",
            );
            const fighterCleanupResult =
              npcSupercarrierDirector.resetNpcSupercarrierWing(
                scene,
                scene.getEntityByID(entityID) || { itemID: entityID },
                liveController || storedController || { entityID, systemID },
                { removeContents: true },
              );
            if (!fighterCleanupResult || fighterCleanupResult.success === false) {
              deferNativeStoreDeletion = true;
              recordCleanupError(
                "npc-fighter-cleanup",
                fighterCleanupResult || "NPC_FIGHTER_CLEANUP_FAILED",
                { entityID },
              );
            } else {
              discardedNativeNpcFighterCount += toInt(
                fighterCleanupResult.data && fighterCleanupResult.data.destroyedCount,
                0,
              );
            }
          } catch (error) {
            deferNativeStoreDeletion = true;
            recordCleanupError("npc-fighter-cleanup", error, { entityID });
          }
        }
        if (liveController) {
          try {
            const result = nativeNpcService.dematerializeNativeController(liveController, {
              broadcast: false,
              persistState: canRematerialize,
            });
            if (!result || result.success === false) {
              recordCleanupError(
                "npc-dematerialize",
                result || "NPC_DEMATERIALIZE_FAILED",
                { entityID },
              );
            } else {
              dematerializedNpcCount += 1;
            }
          } catch (error) {
            recordCleanupError("npc-dematerialize", error, { entityID });
          }
        }

        if (canRematerialize) {
          preservedNativeNpcCount += 1;
          continue;
        }
        if (deferNativeStoreDeletion) {
          // The backing fighter inventory row is still linked to this native
          // controller. Keep that association across the cold scene boundary
          // so the next collection pass can retry the failed custody removal.
          deferredNativeNpcCleanupCount += 1;
          continue;
        }
        try {
          const removeResult = nativeNpcStore.removeNativeEntityCascade(entityID);
          if (!removeResult || removeResult.success === false) {
            recordCleanupError(
              "npc-native-entity-cleanup",
              removeResult || "NPC_NATIVE_ENTITY_CLEANUP_FAILED",
              { entityID },
            );
          } else {
            discardedNativeNpcCount += 1;
          }
        } catch (error) {
          recordCleanupError("npc-native-entity-cleanup", error, { entityID });
        }
      }

      for (const wreckRecord of nativeNpcStore.listNativeWrecks()) {
        if (!storedNativeRecordBelongsToSolarSystemScene(wreckRecord, scene)) {
          continue;
        }
        if (hasValidDungeonNativeSceneOwner(wreckRecord) ||
            (wreckRecord.miningCargoTransferKey && Number(wreckRecord.expiresAtMs) > getWallclockNowMs())) {
          preservedNativeWreckCount += 1;
          continue;
        }
        const wreckID = toInt(wreckRecord.wreckID, 0);
        try {
          const removeResult = nativeNpcStore.removeNativeWreckCascade(wreckID);
          if (!removeResult || removeResult.success === false) {
            recordCleanupError(
              "npc-native-wreck-cleanup",
              removeResult || "NPC_NATIVE_WRECK_CLEANUP_FAILED",
              { wreckID },
            );
          } else {
            discardedNativeWreckCount += 1;
          }
        } catch (error) {
          recordCleanupError("npc-native-wreck-cleanup", error, { wreckID });
        }
      }
    } catch (error) {
      recordCleanupError("native-npc-cleanup", error);
    } finally {
      if (npcRegistry && typeof npcRegistry.unregisterController === "function") {
        for (const controller of liveControllers) {
          const entityID = toInt(
            controller && (controller.entityID || controller.itemID),
            0,
          );
          if (entityID > 0) {
            npcRegistry.unregisterController(entityID);
          }
        }
      }
    }

    let miningCleanup = null;
    try {
      const miningRuntime = lazyRequire("../services/mining/miningRuntime");
      if (miningRuntime && typeof miningRuntime.handleSceneDisposed === "function") {
        miningCleanup = miningRuntime.handleSceneDisposed(scene);
      }
    } catch (error) {
      recordCleanupError("mining-cleanup", error);
    }

    let hackingCleanup = null;
    try {
      const HackingMgrService = lazyRequire(
        "../services/exploration/hackingMgrService",
      );
      if (
        HackingMgrService &&
        typeof HackingMgrService.handleSceneDisposed === "function"
      ) {
        hackingCleanup = HackingMgrService.handleSceneDisposed(scene);
      }
    } catch (error) {
      recordCleanupError("hacking-cleanup", error);
    }

    let releasedDynamicEntityCount = 0;
    if (scene.dynamicEntities instanceof Map) {
      for (const entity of [...scene.dynamicEntities.values()]) {
        try {
          scene.unregisterDynamicEntity(entity, {
            broadcast: false,
            persistSpaceState: false,
          });
          releasedDynamicEntityCount += 1;
        } catch (error) {
          recordCleanupError("dynamic-entity-release", error, {
            entityID: toInt(entity && entity.itemID, 0) || null,
          });
          // The scene itself is being released after this commit. Removing the
          // entry directly prevents a throwing custom unregister hook from
          // retaining the remainder of the object graph in tests/extensions.
          scene.dynamicEntities.delete(toInt(entity && entity.itemID, 0));
        }
      }
    }

    if (cleanupErrors.length > 0) {
      log.warn(
        `[SpaceRuntime] Solar-system scene cleanup completed with ` +
          `${cleanupErrors.length} error(s) system=${systemID}: ` +
          cleanupErrors
            .map((entry) => `${entry.stage}=${entry.errorMsg}`)
            .join(", "),
      );
    }

    return {
      success: true,
      systemID,
      dematerializedNpcCount,
      discardedNativeNpcCount,
      discardedNativeNpcFighterCount,
      preservedNativeNpcCount,
      deferredNativeNpcCleanupCount,
      discardedNativeWreckCount,
      preservedNativeWreckCount,
      miningCleanup,
      hackingCleanup,
      releasedDynamicEntityCount,
      cleanupErrorCount: cleanupErrors.length,
      cleanupErrors,
    };
  },

collectEmptySolarSystems(wallclockNowMs = getWallclockNowMs(), options = {}) {
    const now = toFiniteNumber(wallclockNowMs, getWallclockNowMs());
    const gracePeriodMs = Math.max(
      0,
      toFiniteNumber(
        options.gracePeriodMs,
        EMPTY_SOLAR_SYSTEM_COLLECTION_GRACE_MS,
      ),
    );
    const retainedObjectGracePeriodMs = Math.max(
      gracePeriodMs,
      toFiniteNumber(
        options.retainedObjectGracePeriodMs,
        EMPTY_SOLAR_SYSTEM_RETAINED_OBJECT_GRACE_MS,
      ),
    );
    const alwaysOnSystemIDs = new Set(resolveAlwaysOnSolarSystemIDs());
    const maxCollections = Math.max(
      1,
      toInt(
        options.maxCollections,
        EMPTY_SOLAR_SYSTEM_COLLECTION_MAX_PER_SWEEP,
      ),
    );
    const collectedSystemIDs = [];
    const retainedSystemIDs = [];
    const attemptedSystemIDs = [];
    const failed = [];

    for (const scene of [...this.scenes.values()]) {
      const systemID = toInt(scene && scene.systemID, 0);
      if (
        !scene ||
        scene.sceneKind !== SCENE_KIND_SOLAR_SYSTEM ||
        systemID <= 0 ||
        isAbyssalHostLocationID(systemID) ||
        normalizeSceneText(scene.sceneKey, "") !== buildSolarSystemSceneKey(systemID)
      ) {
        continue;
      }

      const sessionCount = scene.sessions instanceof Map ? scene.sessions.size : 0;
      if (sessionCount > 0) {
        this.noteSolarSystemSceneOccupied(scene);
        continue;
      }
      this.noteSolarSystemSceneEmpty(scene, now);
      if (alwaysOnSystemIDs.has(systemID)) {
        continue;
      }

      const emptySinceWallclockMs = toFiniteNumber(
        scene._emptySinceWallclockMs,
        now,
      );
      const emptyDurationMs = Math.max(0, now - emptySinceWallclockMs);
      if (emptyDurationMs < gracePeriodMs) {
        continue;
      }
      // The retained-object walk can touch every dynamic entity in a scene
      // (including large asteroid fields). There is no retention decision to
      // make until the ordinary grace window has elapsed, so keep young empty
      // scenes on the constant-time path.
      const retainedObjectState = getEmptySolarSystemRetainedObjectState(
        scene,
        now,
      );
      if (
        retainedObjectState.requiresExtendedRetention &&
        emptyDurationMs < retainedObjectGracePeriodMs
      ) {
        retainedSystemIDs.push(systemID);
        continue;
      }
      const retryNotBeforeWallclockMs = toFiniteNumber(
        scene._emptyCollectionRetryNotBeforeWallclockMs,
        0,
      );
      if (retryNotBeforeWallclockMs > now) {
        continue;
      }

      attemptedSystemIDs.push(systemID);
      const disposeResult = this.disposeScene(scene.sceneDescriptor || systemID, {
        reason: "empty-system-garbage-collection",
        refreshStargates: false,
      });
      if (!disposeResult || disposeResult.success === false) {
        // Preserve the true idle age (especially the two-hour retained-object
        // deadline) while throttling retries after a persistence/controller
        // failure. Resetting the idle timestamp here would add another full
        // two hours to every failed retained-object collection attempt.
        scene._emptyCollectionRetryNotBeforeWallclockMs = now + gracePeriodMs;
        failed.push({
          systemID,
          errorMsg: disposeResult && disposeResult.errorMsg || "SCENE_DISPOSE_FAILED",
        });
        if (attemptedSystemIDs.length >= maxCollections) {
          break;
        }
        continue;
      }
      if (disposeResult.removed === true) {
        collectedSystemIDs.push(systemID);
      }
      if (attemptedSystemIDs.length >= maxCollections) {
        break;
      }
    }

    if (collectedSystemIDs.length > 0) {
      this.refreshStargateActivationStates({
        broadcast: options.broadcastStargateChanges !== false,
      });
      log.info(
        `[SpaceRuntime] Garbage-collected ${collectedSystemIDs.length} empty ` +
          `solar system(s): ${collectedSystemIDs.join(",")}`,
      );
    }
    for (const failure of failed) {
      log.warn(
        `[SpaceRuntime] Empty solar-system collection failed ` +
          `system=${failure.systemID}: ${failure.errorMsg}`,
      );
    }

    return {
      collectedSystemIDs,
      retainedSystemIDs,
      attemptedSystemIDs,
      failed,
      gracePeriodMs,
      retainedObjectGracePeriodMs,
      maxCollections,
      alwaysOnSystemIDs: [...alwaysOnSystemIDs].sort((left, right) => left - right),
    };
  },

findSceneContainingDynamicEntity(entityID) {
    const numericEntityID = toInt(entityID, 0);
    if (numericEntityID <= 0) {
      return null;
    }
    for (const scene of this.scenes.values()) {
      if (
        scene &&
        scene.dynamicEntities instanceof Map &&
        scene.dynamicEntities.has(numericEntityID)
      ) {
        return scene;
      }
    }
    return null;
  },

getSceneByDescriptor(sceneDescriptor) {
    const descriptor = normalizeSceneDescriptor(sceneDescriptor);
    return descriptor ? this.scenes.get(descriptor.sceneKey) || null : null;
  },

disposeScene(sceneDescriptor, options = {}) {
    const descriptor = normalizeSceneDescriptor(sceneDescriptor);
    if (!descriptor) {
      return {
        success: false,
        errorMsg: "SCENE_DESCRIPTOR_INVALID",
      };
    }
    const scene = this.scenes.get(descriptor.sceneKey);
    if (!scene) {
      return {
        success: true,
        alreadyGone: true,
        sceneKey: descriptor.sceneKey,
      };
    }
    if (
      options.force !== true &&
      scene.sessions instanceof Map &&
      scene.sessions.size > 0
    ) {
      return {
        success: false,
        errorMsg: "SCENE_HAS_SESSIONS",
        sceneKey: descriptor.sceneKey,
      };
    }
    let cleanup = null;
    if (
      scene.sceneKind === SCENE_KIND_SOLAR_SYSTEM &&
      scene.sessions instanceof Map &&
      scene.sessions.size === 0
    ) {
      cleanup = this.prepareEmptySolarSystemSceneForDisposal(scene);
      if (!cleanup.success) {
        return {
          success: false,
          errorMsg: cleanup.errorMsg || "SCENE_DISPOSAL_PREPARE_FAILED",
          sceneKey: descriptor.sceneKey,
        };
      }
    }
    // Disposal is certain: the scene's features tear down (Scene feature
    // hooks).
    sceneFeatureHooks.notifySceneDisposing(scene, options);
    this.scenes.delete(descriptor.sceneKey);
    if (
      scene.sceneKind === SCENE_KIND_SOLAR_SYSTEM &&
      !isAbyssalHostLocationID(toInt(scene.systemID, 0))
    ) {
      this._garbageCollectedSolarSystemIDs.add(toInt(scene.systemID, 0));
    }
    if (
      scene.sceneKind === SCENE_KIND_SOLAR_SYSTEM &&
      options.refreshStargates !== false
    ) {
      this.refreshStargateActivationStates({
        broadcast: options.broadcastStargateChanges !== false,
        targetSystemID: toInt(scene.systemID, 0),
      });
    }
    return {
      success: true,
      removed: true,
      sceneKey: descriptor.sceneKey,
      cleanup,
    };
  },

getActiveShipEntityForSession(session) {
    const scene = this.getSceneForSession(session);
    if (!scene || !session) {
      return null;
    }
    const shipID = toInt(
      session._space && session._space.shipID,
      toInt(session.shipID || session.shipid || session.activeShipID || session.activeShipId, 0),
    );
    if (shipID <= 0) {
      return null;
    }
    return scene.getEntityByID(shipID) || null;
  },
};
