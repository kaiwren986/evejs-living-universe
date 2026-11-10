"use strict";

const runtimeEntryDirname = require("path").resolve(__dirname, "../..");
const path = require("path");
const {
  ABYSSAL_LOCATION_ID_MIN,
  ABYSSAL_LOCATION_ID_COUNT,
  isAbyssalHostLocationID,
} = require("../../../abyssal").engineSupport.hostLocation;
const config = require(path.join(runtimeEntryDirname, "../config"));
const log = require(path.join(runtimeEntryDirname, "../utils/logger"));
const {
  buildStartupPresenceSummary,
  getSceneActivityState,
} = require(path.join(runtimeEntryDirname, "./npc/npcSceneActivity"));
const {
  materializeAmbientStartupControllersForScene,
  dematerializeAmbientStartupControllersForScene,
} = require(path.join(runtimeEntryDirname, "./npc/npcAmbientMaterialization"));
const {
  materializeDormantCombatControllersForScene,
  dematerializeDormantCombatControllersForScene,
} = require(path.join(runtimeEntryDirname, "./npc/npcCombatDormancy"));
const {
  isAnchorRelevanceEnabled,
  hasStartupAnchorRelevanceContext,
  syncRelevantStartupControllersForScene,
  prewarmStartupControllersForWarpDestination,
} = require(path.join(runtimeEntryDirname, "./npc/npcAnchorRelevance"));
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
  SolarSystemScene,
} = require("../solarSystemScene");
const {
  formatStartupBootstrapMetrics,
  resolveAlwaysOnSolarSystemIDs,
} = require("../startupPreloadPlan");

module.exports = {

isSolarSystemSceneLoaded(systemID) {
    const numericSystemID = toInt(systemID, 0);
    return numericSystemID > 0 && this.scenes.has(numericSystemID);
  },

listLoadedSolarSystemIDs() {
    const systemIDs = new Set();
    for (const scene of this.scenes.values()) {
      if (!scene || scene.sceneKind !== SCENE_KIND_SOLAR_SYSTEM) {
        continue;
      }
      const systemID = toInt(scene.systemID, 0);
      const canonicalSceneKey = buildSolarSystemSceneKey(systemID);
      // Reserved Abyssal hosts are private implementation locations even when
      // a legacy recovery scene still carries the generic solar-scene shape.
      // Never publish or feed them into system-wide control loops.
      if (
        systemID > 0 &&
        !isAbyssalHostLocationID(systemID) &&
        normalizeSceneText(scene.sceneKey, "") === canonicalSceneKey
      ) {
        systemIDs.add(systemID);
      }
    }
    return [...systemIDs].sort((left, right) => left - right);
  },

listAwakeSolarSystemIDs(options = {}) {
    const requireSessions = options.requireSessions !== false;
    const wallclockNow = toFiniteNumber(options.wallclockNowMs, getWallclockNowMs());
    const systemIDs = new Set();
    for (const scene of this.scenes.values()) {
      if (!scene || scene.sceneKind !== SCENE_KIND_SOLAR_SYSTEM) {
        continue;
      }
      const activity = getSceneActivityState(scene, wallclockNow);
      if (requireSessions && activity.hasSessions !== true) {
        continue;
      }
      if (!requireSessions && activity.shouldTick !== true) {
        continue;
      }
      const systemID = toInt(scene.systemID, 0);
      if (
        systemID > 0 &&
        !isAbyssalHostLocationID(systemID) &&
        normalizeSceneText(scene.sceneKey, "") === buildSolarSystemSceneKey(systemID)
      ) {
        systemIDs.add(systemID);
      }
    }
    return [...systemIDs]
      .sort((left, right) => left - right);
  },

listAlwaysOnSolarSystemIDs() {
    return resolveAlwaysOnSolarSystemIDs();
  },

isSolarSystemAlwaysOn(systemID) {
    const numericSystemID = toInt(systemID, 0);
    return numericSystemID > 0 &&
      resolveAlwaysOnSolarSystemIDs().includes(numericSystemID);
  },

noteSolarSystemSceneOccupied(scene) {
    if (!scene || scene.sceneKind !== SCENE_KIND_SOLAR_SYSTEM) {
      return false;
    }
    scene._emptySinceWallclockMs = null;
    scene._emptyCollectionRetryNotBeforeWallclockMs = null;
    return true;
  },

noteSolarSystemSceneEmpty(scene, wallclockNowMs = getWallclockNowMs()) {
    if (
      !scene ||
      scene.sceneKind !== SCENE_KIND_SOLAR_SYSTEM ||
      !(scene.sessions instanceof Map) ||
      scene.sessions.size > 0
    ) {
      return false;
    }
    if (
      scene._emptySinceWallclockMs === null ||
      !Number.isFinite(Number(scene._emptySinceWallclockMs))
    ) {
      scene._emptySinceWallclockMs = toFiniteNumber(wallclockNowMs, getWallclockNowMs());
      scene._emptyCollectionRetryNotBeforeWallclockMs = null;
    }
    return true;
  },

ensureScene(systemID, options = {}) {
    const descriptor = normalizeSceneDescriptor(
      options.sceneDescriptor || systemID,
      options,
    );
    if (!descriptor) {
      return null;
    }
    // Reserved Abyssal host locations are multiplexed by run scene key. A raw
    // numeric lookup normalizes as a public solar-system scene and would create
    // a second authority at `solar-system:<hostID>` beside the private run.
    // Callers that own an Abyssal run must provide its exact descriptor.
    if (
      descriptor.sceneKind === SCENE_KIND_SOLAR_SYSTEM &&
      isAbyssalHostLocationID(descriptor.locationID)
    ) {
      return null;
    }
    const numericSystemID = descriptor.locationID;
    const sceneKey = descriptor.sceneKey;
    if (descriptor.sceneKind === SCENE_KIND_SOLAR_SYSTEM) {
      require(path.join(runtimeEntryDirname, "../services/dynamic/dynamicBountyRuntime")).ensureSystem(numericSystemID);
    }

    const suppliedBootstrapMetrics =
      options.startupBootstrapMetrics &&
      typeof options.startupBootstrapMetrics === "object"
        ? options.startupBootstrapMetrics
        : null;
    // Live cold wakes need the same phase attribution as startup preloads.
    // Keeping a local metrics object also makes the slow-path log useful when
    // no caller explicitly asks for startup progress.
    const sceneAlreadyExists = this.scenes.has(sceneKey);
    const bootstrapMetrics =
      suppliedBootstrapMetrics || (!sceneAlreadyExists ? {} : null);
    const ensureSceneStartedAtMs = bootstrapMetrics ? Date.now() : 0;
    let created = false;
    if (!this.scenes.has(sceneKey)) {
      const sceneConstructionStartedAtMs = Date.now();
      this.scenes.set(sceneKey, new SolarSystemScene(numericSystemID, descriptor));
      bootstrapMetrics.sceneConstructionElapsedMs =
        Date.now() - sceneConstructionStartedAtMs;
      created = true;
    }
    const scene = this.scenes.get(sceneKey);
    if (descriptor.sceneKind === SCENE_KIND_SOLAR_SYSTEM) {
      this._garbageCollectedSolarSystemIDs.delete(numericSystemID);
    }
    if (
      created &&
      descriptor.sceneKind === SCENE_KIND_SOLAR_SYSTEM &&
      options.refreshStargates !== false
    ) {
      const stargateRefreshStartedAtMs = Date.now();
      this.refreshStargateActivationStates({
        broadcast: options.broadcastStargateChanges !== false,
      });
      bootstrapMetrics.stargatesElapsedMs =
        Date.now() - stargateRefreshStartedAtMs;
    }
    if (
      created &&
      descriptor.sceneKind === SCENE_KIND_SOLAR_SYSTEM &&
      options.reconcileUniverseSites !== false
    ) {
      try {
        const startupStartedAtMs = Date.now();
        const dungeonUniverseRuntime = lazyRequire("../services/dungeon/dungeonUniverseRuntime");
        if (
          dungeonUniverseRuntime &&
          options.synchronousUniverseSiteReconcile === true &&
          typeof dungeonUniverseRuntime.ensureSystemUniversePersistentSites === "function"
        ) {
          dungeonUniverseRuntime.ensureSystemUniversePersistentSites(numericSystemID, {
            reason: options.universeSiteReconcileReason || "scene-created",
            nowMs: options.nowMs,
            force: options.forceUniverseSiteReconcile === true,
          });
        } else if (
          dungeonUniverseRuntime &&
          options.scheduleUniverseSiteReconcile === true &&
          typeof dungeonUniverseRuntime.scheduleSystemUniversePersistentSitesReconcile === "function"
        ) {
          dungeonUniverseRuntime.scheduleSystemUniversePersistentSitesReconcile(numericSystemID, {
            reason: options.universeSiteReconcileReason || "scene-created",
            nowMs: options.nowMs,
            force: options.forceUniverseSiteReconcile === true,
            initialDelayMs: options.universeSiteReconcileInitialDelayMs,
          });
        }
        bootstrapMetrics.dungeonReconcileElapsedMs = Date.now() - startupStartedAtMs;
      } catch (error) {
        log.warn(
          `[SpaceRuntime] Dungeon universe reconcile failed for system=${numericSystemID}: ${error.message}`,
        );
      }
    }
    if (created && descriptor.sceneKind === SCENE_KIND_SOLAR_SYSTEM) {
      if (config.asteroidFieldsEnabled === true) {
        try {
          const startupStartedAtMs = Date.now();
          const asteroidService = lazyRequire("./asteroids");
          if (asteroidService && typeof asteroidService.handleSceneCreated === "function") {
            asteroidService.handleSceneCreated(scene);
          }
          bootstrapMetrics.asteroidsElapsedMs = Date.now() - startupStartedAtMs;
        } catch (error) {
          log.warn(
            `[SpaceRuntime] Failed to initialize asteroid fields for system ${numericSystemID}: ${error.message}`,
          );
        }
      } else {
        scene._asteroidFieldsInitialized = true;
      }
      if (config.miningEnabled === true) {
        try {
          const startupStartedAtMs = Date.now();
          const miningRuntime = lazyRequire("../services/mining/miningRuntime");
          if (miningRuntime && typeof miningRuntime.handleSceneCreated === "function") {
            miningRuntime.handleSceneCreated(scene);
          }
          const startupElapsedMs = Date.now() - startupStartedAtMs;
          bootstrapMetrics.miningElapsedMs = startupElapsedMs;
          if (startupElapsedMs >= 500) {
            log.info(
              `[SpaceRuntime] Scene startup mining system=${numericSystemID} took ${startupElapsedMs}ms`,
            );
          }
        } catch (error) {
          log.warn(
            `[SpaceRuntime] Mining scene startup failed for system=${numericSystemID}: ${error.message}`,
          );
        }
      }
      if (process.env.EVEJS_SKIP_NPC_STARTUP !== "1") {
        try {
          const startupStartedAtMs = Date.now();
          const npcService = lazyRequire("./npc");
          if (npcService && typeof npcService.handleSceneCreated === "function") {
            npcService.handleSceneCreated(scene);
          }
          const startupElapsedMs = Date.now() - startupStartedAtMs;
          bootstrapMetrics.npcElapsedMs = startupElapsedMs;
          if (startupElapsedMs >= 500) {
            log.info(
              `[SpaceRuntime] Scene startup npc system=${numericSystemID} took ${startupElapsedMs}ms`,
            );
          }
        } catch (error) {
          log.warn(
            `[SpaceRuntime] NPC scene startup failed for system=${numericSystemID}: ${error.message}`,
          );
        }
      }
      if (options.reconcileUniverseSites !== false) {
        try {
          const startupStartedAtMs = Date.now();
          const dungeonUniverseSiteService = lazyRequire("../services/dungeon/dungeonUniverseSiteService");
          if (
            dungeonUniverseSiteService &&
            typeof dungeonUniverseSiteService.handleSceneCreated === "function"
          ) {
            // The seeded-site hook can spawn first-pass encounter NPCs, so let
            // the shared NPC scene bootstrap finish first and then materialize
            // dungeon contents on top of that initialized runtime.
            dungeonUniverseSiteService.handleSceneCreated(scene);
          }
          const startupElapsedMs = Date.now() - startupStartedAtMs;
          bootstrapMetrics.dungeonElapsedMs = startupElapsedMs;
          if (startupElapsedMs >= 500) {
            log.info(
              `[SpaceRuntime] Scene startup dungeon system=${numericSystemID} took ${startupElapsedMs}ms`,
            );
          }
        } catch (error) {
          log.warn(
            `[SpaceRuntime] Dungeon universe site startup failed for system=${numericSystemID}: ${error.message}`,
          );
        }
      }
      if (config.wormholesEnabled === true) {
        try {
          const startupStartedAtMs = Date.now();
          const wormholeRuntime = lazyRequire("../services/exploration/wormholes/wormholeRuntime");
          if (wormholeRuntime && typeof wormholeRuntime.handleSceneCreated === "function") {
            wormholeRuntime.handleSceneCreated(scene);
          }
          const startupElapsedMs = Date.now() - startupStartedAtMs;
          bootstrapMetrics.wormholesElapsedMs = startupElapsedMs;
          if (startupElapsedMs >= 500) {
            log.info(
              `[SpaceRuntime] Scene startup wormholes system=${numericSystemID} took ${startupElapsedMs}ms`,
            );
          }
        } catch (error) {
          log.warn(
            `[SpaceRuntime] Wormhole scene startup failed for system=${numericSystemID}: ${error.message}`,
          );
        }
      }
      if (process.env.EVEJS_SKIP_NPC_STARTUP !== "1") {
        try {
          const startupStartedAtMs = Date.now();
          const npcService = lazyRequire("./npc");
          if (
            npcService &&
            typeof npcService.refreshStartupRulesForScene === "function"
          ) {
            // Some startup rules depend on static scene content that is
            // materialized later in scene bootstrap, like universe signature
            // sites and wormhole scene anchors. Sweep those rules one more time
            // after the static layers are in place so they do not wait for the
            // first maintenance tick to appear.
            npcService.refreshStartupRulesForScene(scene);
          }
          const startupElapsedMs = Date.now() - startupStartedAtMs;
          bootstrapMetrics.npcPostStaticElapsedMs = startupElapsedMs;
          if (startupElapsedMs >= 500) {
            log.info(
              `[SpaceRuntime] Scene startup npc post-static sweep system=${numericSystemID} took ${startupElapsedMs}ms`,
            );
          }
        } catch (error) {
          log.warn(
            `[SpaceRuntime] NPC post-static startup sweep failed for system=${numericSystemID}: ${error.message}`,
          );
        }
      }
    }
    if (bootstrapMetrics) {
      bootstrapMetrics.created = created;
      bootstrapMetrics.totalElapsedMs = Date.now() - ensureSceneStartedAtMs;
      bootstrapMetrics.systemID = numericSystemID;
      if (
        created &&
        !suppliedBootstrapMetrics &&
        bootstrapMetrics.totalElapsedMs >= 250
      ) {
        const metricsSummary = formatStartupBootstrapMetrics(bootstrapMetrics);
        log.info(
          `[SpaceRuntime] Live scene bootstrap system=${numericSystemID} ` +
            `took ${bootstrapMetrics.totalElapsedMs}ms` +
            `${metricsSummary ? ` | ${metricsSummary}` : ""}`,
        );
      }
    }
    return scene;
  },

getSceneActivityState(systemID, wallclockNow = Date.now()) {
    const numericSystemID = toInt(systemID, 0);
    const scene = this.scenes.get(numericSystemID);
    return scene ? getSceneActivityState(scene, wallclockNow) : null;
  },

wakeSceneForImmediateUse(sceneOrSystemID, options = {}) {
    const scene =
      typeof sceneOrSystemID === "object" && sceneOrSystemID !== null
        ? sceneOrSystemID
        : this.ensureScene(sceneOrSystemID, {
            refreshStargates: options.refreshStargates,
            broadcastStargateChanges: options.broadcastStargateChanges,
          });
    if (!scene) {
      return {
        success: false,
        errorMsg: "SCENE_NOT_FOUND",
      };
    }

    const wallclockNow = toFiniteNumber(options.wallclockNowMs, getWallclockNowMs());
    const before = getSceneActivityState(scene, wallclockNow);
    const shouldCatchUp = options.force === true || before.sessionCount === 0;
    if (shouldCatchUp) {
      const destroyExpiredStartedAtMs = Date.now();
      scene.destroyExpiredInventoryBackedEntities(before.sceneNowMs);
      const destroyExpiredElapsedMs = Date.now() - destroyExpiredStartedAtMs;
      if (destroyExpiredElapsedMs >= 250) {
        log.info(
          `[SpaceRuntime] destroyExpiredInventoryBackedEntities system=${scene.systemID} ` +
          `reason=${String(options.reason || "").trim() || "wake"} took ${destroyExpiredElapsedMs}ms`,
        );
      }
      const tickStartedAtMs = Date.now();
      scene.tick(wallclockNow);
      const tickElapsedMs = Date.now() - tickStartedAtMs;
      if (tickElapsedMs >= 250) {
        log.info(
          `[SpaceRuntime] scene.tick system=${scene.systemID} reason=${String(options.reason || "").trim() || "wake"} ` +
          `took ${tickElapsedMs}ms`,
        );
      }
    }
    const useAnchorRelevance =
      isAnchorRelevanceEnabled() &&
      hasStartupAnchorRelevanceContext(scene, {
        relevantClusterKeys: options.relevantClusterKeys,
        relevantEntities: options.relevantEntities,
        relevantPositions: options.relevantPositions,
      });
    let ambientMaterializationResult;
    let combatMaterializationResult;
    if (useAnchorRelevance) {
      const anchorRelevanceResult = syncRelevantStartupControllersForScene(scene, {
        broadcast: false,
        excludedSession: options.excludedSession || null,
        nowMs: before.sceneNowMs,
        catchUpBehavior: true,
        relevantClusterKeys: options.relevantClusterKeys,
        relevantEntities: options.relevantEntities,
        relevantPositions: options.relevantPositions,
        materializeAmbientStartup: options.materializeAmbientStartup !== false,
        materializeDormantCombat: options.materializeDormantCombat !== false,
        dematerializeAmbientStartup: true,
        dematerializeDormantCombat: true,
      });
      if (!anchorRelevanceResult.success) {
        return anchorRelevanceResult;
      }
      ambientMaterializationResult = {
        success: true,
        data: anchorRelevanceResult.data.ambient,
      };
      combatMaterializationResult = {
        success: true,
        data: anchorRelevanceResult.data.combat,
      };
    } else {
      ambientMaterializationResult =
        options.materializeAmbientStartup === false || before.sessionCount > 0
          ? {
              success: true,
              data: {
                materialized: [],
                materializedCount: 0,
              },
            }
          : materializeAmbientStartupControllersForScene(scene, {
              broadcast: false,
              excludedSession: options.excludedSession || null,
            });
      if (!ambientMaterializationResult.success) {
        return ambientMaterializationResult;
      }
      combatMaterializationResult =
        options.materializeDormantCombat === false || before.sessionCount > 0
          ? {
              success: true,
              data: {
                materialized: [],
                materializedCount: 0,
              },
            }
          : materializeDormantCombatControllersForScene(scene, {
              broadcast: false,
              excludedSession: options.excludedSession || null,
              catchUpBehavior: true,
              nowMs: before.sceneNowMs,
            });
      if (!combatMaterializationResult.success) {
        return combatMaterializationResult;
      }
    }

    return {
      success: true,
      data: {
        scene,
        ticked: shouldCatchUp,
        ambientMaterialization: ambientMaterializationResult.data,
        combatMaterialization: combatMaterializationResult.data,
        before,
        after: getSceneActivityState(scene, wallclockNow),
        reason: String(options.reason || "").trim() || null,
      },
    };
  },
};
