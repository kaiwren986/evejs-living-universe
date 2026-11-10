"use strict";

const runtimeEntryDirname = require("path").resolve(__dirname, "../..");
const path = require("path");
const log = require(path.join(runtimeEntryDirname, "../utils/logger"));
const {
  toFiniteNumber,
  toInt,
} = require("../../../common/numbers");
const {
  ATTACH_UNIVERSE_SITE_RECONCILE_DELAY_MS,
} = require("../runtimeDebugInstrumentation");
const {
  lazyRequire,
} = require("../runtimeModuleBoundary");
const {
  autoMaterializeNearbyUniverseSiteForAttach,
} = require("../universeSiteAttach");

module.exports = {

prepareUniverseSitesForPlayerEntry(systemID, options = {}) {
    const numericSystemID = toInt(systemID, 0);
    if (numericSystemID <= 0 || options.reconcileUniverseSites === false) {
      return {
        success: numericSystemID > 0,
        prepared: false,
        systemID: numericSystemID,
      };
    }

    const existingScene = this.scenes.get(numericSystemID) || null;
    const firstPlayerEntry = !existingScene ||
      !(existingScene.sessions instanceof Map) ||
      existingScene.sessions.size <= 0;
    if (!firstPlayerEntry) {
      return {
        success: true,
        prepared: false,
        reason: "scene_already_awake",
        systemID: numericSystemID,
        sceneExisted: true,
      };
    }
    // prewarmSolarSystemForArrival already prepared and materialized this
    // scene for the pilot now entering it. One use only.
    if (
      existingScene &&
      toFiniteNumber(existingScene._arrivalPrewarmExpiresAtWallclockMs, 0) >= Date.now()
    ) {
      existingScene._arrivalPrewarmExpiresAtWallclockMs = null;
      return {
        success: true,
        prepared: true,
        reason: "arrival_prewarmed",
        systemID: numericSystemID,
        sceneExisted: false,
      };
    }

    const preparationStartedAtMs = Date.now();
    const finishPreparation = (result, mode) => {
      const elapsedMs = Date.now() - preparationStartedAtMs;
      if (elapsedMs >= 250) {
        log.info(
          `[SpaceRuntime] System content prepare system=${numericSystemID} ` +
            `mode=${mode} took ${elapsedMs}ms`,
        );
      }
      return {
        ...result,
        elapsedMs,
      };
    };

    try {
      const dungeonUniverseRuntime = lazyRequire("../services/dungeon/dungeonUniverseRuntime");
      if (options.deferUniverseSitePreparation === true) {
        if (
          !dungeonUniverseRuntime ||
          typeof dungeonUniverseRuntime.scheduleSystemUniversePersistentSitesReconcile !== "function"
        ) {
          throw new Error("SYSTEM_CONTENT_SCHEDULER_UNAVAILABLE");
        }
        const result = dungeonUniverseRuntime.scheduleSystemUniversePersistentSitesReconcile(
          numericSystemID,
          {
            reason: options.universeSiteReconcileReason || "player-entry",
            nowMs: options.nowMs,
            force: true,
            debounceMs: 0,
            cleanupInvalidGeneratedIce: true,
            includeRandomAllocatedUniverseFamilies: true,
            initialDelayMs: options.universeSiteReconcileInitialDelayMs,
            onComplete: (scheduledResult) => {
              this.completeDeferredUniverseSitePreparation(
                numericSystemID,
                scheduledResult,
                options,
              );
            },
          },
        );
        if (!result || result.success === false) {
          throw new Error(result && result.errorMsg || "SYSTEM_CONTENT_SCHEDULE_FAILED");
        }
        return finishPreparation({
          success: true,
          prepared: false,
          deferred: true,
          systemID: numericSystemID,
          sceneExisted: Boolean(existingScene),
          result,
        }, "deferred");
      }
      if (
        !dungeonUniverseRuntime ||
        typeof dungeonUniverseRuntime.prepareSystemForPlayerEntry !== "function"
      ) {
        throw new Error("SYSTEM_CONTENT_PREPARER_UNAVAILABLE");
      }
      const result = dungeonUniverseRuntime.prepareSystemForPlayerEntry(numericSystemID, {
        reason: options.universeSiteReconcileReason || "player-entry",
        lifecycleReason: "system-wake",
        nowMs: options.nowMs,
        cleanupInvalidGeneratedIce: true,
      });
      if (!result || result.success === false) {
        throw new Error(result && result.errorMsg || "SYSTEM_CONTENT_PREPARE_FAILED");
      }
      return finishPreparation({
        success: true,
        prepared: true,
        systemID: numericSystemID,
        sceneExisted: Boolean(existingScene),
        result,
      }, "synchronous");
    } catch (error) {
      log.warn(
        `[SpaceRuntime] System content prepare failed for system=${numericSystemID}: ${error.message}`,
      );
      return finishPreparation({
        success: false,
        prepared: false,
        errorMsg: error.message,
        systemID: numericSystemID,
        sceneExisted: Boolean(existingScene),
      }, options.deferUniverseSitePreparation === true ? "deferred" : "synchronous");
    }
  },

completeDeferredUniverseSitePreparation(systemID, scheduledResult, options = {}) {
    const numericSystemID = toInt(systemID, 0);
    if (!scheduledResult || scheduledResult.success === false) {
      log.warn(
        `[SpaceRuntime] Deferred system content prepare failed ` +
          `for system=${numericSystemID}: ` +
          `${scheduledResult && scheduledResult.errorMsg || "UNKNOWN_ERROR"}`,
      );
      return {
        success: false,
        errorMsg: scheduledResult && scheduledResult.errorMsg || "SYSTEM_CONTENT_PREPARE_FAILED",
        systemID: numericSystemID,
      };
    }

    const scene = this.scenes.get(numericSystemID) || null;
    if (!scene) {
      return {
        success: true,
        skipped: true,
        reason: "scene_not_loaded",
        systemID: numericSystemID,
      };
    }

    const startedAtMs = Date.now();
    let mining = null;
    let dungeon = null;
    try {
      const miningResourceSiteService = lazyRequire(
        "../services/mining/miningResourceSiteService",
      );
      if (
        miningResourceSiteService &&
        typeof miningResourceSiteService.resetSceneGeneratedResourceSites === "function"
      ) {
        mining = miningResourceSiteService.resetSceneGeneratedResourceSites(scene, {
          broadcast: true,
          nowMs: options.nowMs,
        });
      }
    } catch (error) {
      log.warn(
        `[SpaceRuntime] Deferred mining-site materialization failed ` +
          `for system=${numericSystemID}: ${error.message}`,
      );
    }
    try {
      const dungeonUniverseSiteService = lazyRequire(
        "../services/dungeon/dungeonUniverseSiteService",
      );
      if (
        dungeonUniverseSiteService &&
        typeof dungeonUniverseSiteService.handleSceneCreated === "function"
      ) {
        dungeon = dungeonUniverseSiteService.handleSceneCreated(scene, { force: true });
      }
    } catch (error) {
      log.warn(
        `[SpaceRuntime] Deferred dungeon-site materialization failed ` +
          `for system=${numericSystemID}: ${error.message}`,
      );
    }
    const elapsedMs = Date.now() - startedAtMs;
    if (elapsedMs >= 250) {
      log.info(
        `[SpaceRuntime] Deferred system content materialize system=${numericSystemID} ` +
          `took ${elapsedMs}ms`,
      );
    }
    return {
      success: true,
      systemID: numericSystemID,
      mining,
      dungeon,
      elapsedMs,
    };
  },

materializePreparedUniverseSitesForPlayerEntry(scene, preparation) {
    if (
      !scene ||
      !preparation ||
      preparation.prepared !== true ||
      preparation.sceneExisted !== true
    ) {
      return null;
    }
    try {
      const dungeonUniverseSiteService = lazyRequire("../services/dungeon/dungeonUniverseSiteService");
      if (
        dungeonUniverseSiteService &&
        typeof dungeonUniverseSiteService.handleSceneCreated === "function"
      ) {
        return dungeonUniverseSiteService.handleSceneCreated(scene, { force: true });
      }
    } catch (error) {
      log.warn(
        `[SpaceRuntime] Prepared dungeon-site materialization failed ` +
        `for system=${toInt(scene && scene.systemID, 0)}: ${error.message}`,
      );
    }
    return null;
  },

recoverUniverseSitesForPlayerEntry(scene, systemID, options = {}) {
    const numericSystemID = toInt(systemID, 0);
    if (!scene || numericSystemID <= 0) {
      return {
        success: false,
        errorMsg: "SCENE_NOT_FOUND",
      };
    }

    const nowMs = toFiniteNumber(options.nowMs, Date.now());
    let reconcile = null;
    try {
      const dungeonUniverseRuntime = lazyRequire("../services/dungeon/dungeonUniverseRuntime");
      if (
        !dungeonUniverseRuntime ||
        typeof dungeonUniverseRuntime.ensureSystemUniversePersistentSites !== "function"
      ) {
        throw new Error("SYSTEM_CONTENT_FALLBACK_UNAVAILABLE");
      }
      reconcile = dungeonUniverseRuntime.ensureSystemUniversePersistentSites(numericSystemID, {
        reason: options.universeSiteReconcileReason || "player-entry-fallback",
        nowMs,
        force: true,
        debounceMs: 0,
        cleanupInvalidGeneratedIce: true,
      });
      if (!reconcile || reconcile.success === false) {
        throw new Error(reconcile && reconcile.errorMsg || "SYSTEM_CONTENT_FALLBACK_FAILED");
      }
    } catch (error) {
      log.warn(
        `[SpaceRuntime] System content fallback failed for system=${numericSystemID}: ${error.message}`,
      );
      return {
        success: false,
        errorMsg: error.message,
        reconcile,
      };
    }

    let mining = null;
    let dungeon = null;
    try {
      const miningResourceSiteService = lazyRequire(
        "../services/mining/miningResourceSiteService",
      );
      if (
        miningResourceSiteService &&
        typeof miningResourceSiteService.resetSceneGeneratedResourceSites === "function"
      ) {
        mining = miningResourceSiteService.resetSceneGeneratedResourceSites(scene, {
          broadcast: false,
          nowMs,
        });
      }
    } catch (error) {
      log.warn(
        `[SpaceRuntime] System content fallback mining refresh failed ` +
        `for system=${numericSystemID}: ${error.message}`,
      );
    }
    try {
      const dungeonUniverseSiteService = lazyRequire("../services/dungeon/dungeonUniverseSiteService");
      if (
        dungeonUniverseSiteService &&
        typeof dungeonUniverseSiteService.handleSceneCreated === "function"
      ) {
        dungeon = dungeonUniverseSiteService.handleSceneCreated(scene, { force: true });
      }
    } catch (error) {
      log.warn(
        `[SpaceRuntime] System content fallback dungeon refresh failed ` +
        `for system=${numericSystemID}: ${error.message}`,
      );
    }
    return {
      success: true,
      systemID: numericSystemID,
      reconcile,
      mining,
      dungeon,
    };
  },

reconcileUniverseSitesForAwakeScene(scene, options = {}) {
    const numericSystemID = toInt(scene && scene.systemID, 0);
    if (!scene || numericSystemID <= 0) {
      return {
        success: false,
        errorMsg: "SCENE_NOT_FOUND",
      };
    }
    if (!(scene.sessions instanceof Map) || scene.sessions.size <= 0) {
      return {
        success: true,
        skipped: true,
        reason: "no_player_sessions",
        systemID: numericSystemID,
      };
    }

    const result = {
      success: true,
      systemID: numericSystemID,
      reconcile: null,
      materialize: null,
    };
    try {
      const dungeonUniverseRuntime = lazyRequire("../services/dungeon/dungeonUniverseRuntime");
      if (
        dungeonUniverseRuntime &&
        options.synchronousUniverseSiteReconcile !== true &&
        typeof dungeonUniverseRuntime.scheduleSystemUniversePersistentSitesReconcile === "function"
      ) {
        result.reconcile = dungeonUniverseRuntime.scheduleSystemUniversePersistentSitesReconcile(numericSystemID, {
          reason: options.reason || "awake-scene",
          nowMs: options.nowMs,
          force: options.force === true,
          initialDelayMs: options.initialDelayMs,
          cleanupInvalidGeneratedIce: options.cleanupInvalidGeneratedIce === true,
          onComplete: (scheduledResult) => {
            if (
              !scheduledResult ||
              scheduledResult.success === false ||
              this.scenes.get(scene.sceneKey) !== scene ||
              !(scene.sessions instanceof Map) ||
              scene.sessions.size <= 0
            ) {
              return;
            }
            try {
              const dungeonUniverseSiteService = lazyRequire("../services/dungeon/dungeonUniverseSiteService");
              if (
                dungeonUniverseSiteService &&
                typeof dungeonUniverseSiteService.handleSceneCreated === "function"
              ) {
                dungeonUniverseSiteService.handleSceneCreated(scene, {
                  force: true,
                });
              }
            } catch (error) {
              log.warn(
                `[SpaceRuntime] Dungeon universe background materialize failed ` +
                `for system=${numericSystemID}: ${error.message}`,
              );
            }
          },
        });
      } else if (
        dungeonUniverseRuntime &&
        typeof dungeonUniverseRuntime.ensureSystemUniversePersistentSites === "function"
      ) {
        result.reconcile = dungeonUniverseRuntime.ensureSystemUniversePersistentSites(numericSystemID, {
          reason: options.reason || "awake-scene",
          nowMs: options.nowMs,
          force: options.force === true,
        });
      }
    } catch (error) {
      result.success = false;
      result.errorMsg = error.message;
      log.warn(
        `[SpaceRuntime] Dungeon universe awake reconcile failed for system=${numericSystemID}: ${error.message}`,
      );
    }

    try {
      const dungeonUniverseSiteService = lazyRequire("../services/dungeon/dungeonUniverseSiteService");
      if (
        dungeonUniverseSiteService &&
        typeof dungeonUniverseSiteService.handleSceneCreated === "function"
      ) {
        result.materialize = dungeonUniverseSiteService.handleSceneCreated(scene, {
          force: true,
        });
      }
    } catch (error) {
      result.success = false;
      result.errorMsg = result.errorMsg || error.message;
      log.warn(
        `[SpaceRuntime] Dungeon universe awake materialize failed for system=${numericSystemID}: ${error.message}`,
      );
    }
    return result;
  },

runAttachUniverseSiteReconcile(scene, anchorEntity, options = {}) {
    const numericSystemID = toInt(scene && scene.systemID, 0);
    if (!scene || numericSystemID <= 0) {
      return null;
    }

    const reason = String(options.reason || "").trim() || "attach-session";
    const startedAtMs = Date.now();
    const reconcile = this.reconcileUniverseSitesForAwakeScene(scene, {
      reason,
      nowMs: options.nowMs,
      force: options.force === true,
      synchronousUniverseSiteReconcile: options.synchronousUniverseSiteReconcile === true,
      initialDelayMs:
        options.initialDelayMs !== undefined
          ? options.initialDelayMs
          : (options.deferred === true ? 0 : undefined),
    });
    const materialize = autoMaterializeNearbyUniverseSiteForAttach(
      scene,
      anchorEntity,
      {
        broadcast: options.broadcast === true,
        excludedSession: options.excludedSession || null,
        session:
          options.session ||
          (anchorEntity && anchorEntity.session) ||
          null,
        nowMs: options.nowMs,
      },
    );
    const elapsedMs = Date.now() - startedAtMs;
    if (elapsedMs >= 500) {
      const mode = options.deferred === true ? "deferred" : "inline";
      log.info(
        `[SpaceRuntime] attach universe-site reconcile system=${numericSystemID} ` +
        `reason=${reason} mode=${mode} took ${elapsedMs}ms`,
      );
    }
    return {
      success: !reconcile || reconcile.success !== false,
      reconcile,
      materialize,
      elapsedMs,
    };
  },

queueAttachUniverseSiteReconcile(scene, anchorEntity, options = {}) {
    const numericSystemID = toInt(scene && scene.systemID, 0);
    if (!scene || numericSystemID <= 0) {
      return false;
    }

    const pending =
      this._pendingAttachUniverseSiteReconciles.get(numericSystemID) ||
      {
        scene,
        anchorEntity,
        options: {},
        timer: null,
      };
    pending.scene = scene;
    pending.anchorEntity = anchorEntity;
    pending.options = {
      ...pending.options,
      ...options,
    };

    if (pending.timer) {
      this._pendingAttachUniverseSiteReconciles.set(numericSystemID, pending);
      return true;
    }

    const delayMs = Math.max(
      0,
      toInt(
        options.delayMs,
        ATTACH_UNIVERSE_SITE_RECONCILE_DELAY_MS,
      ),
    );
    pending.timer = setTimeout(() => {
      this._pendingAttachUniverseSiteReconciles.delete(numericSystemID);
      if (
        !pending.scene ||
        this.scenes.get(pending.scene && pending.scene.sceneKey) !== pending.scene ||
        !(pending.scene.sessions instanceof Map) ||
        pending.scene.sessions.size <= 0
      ) {
        return;
      }
      try {
        this.runAttachUniverseSiteReconcile(pending.scene, pending.anchorEntity, {
          ...pending.options,
          deferred: true,
        });
      } catch (error) {
        log.warn(
          `[SpaceRuntime] deferred attach universe-site reconcile failed ` +
          `system=${numericSystemID}: ${error.message}`,
        );
      }
    }, delayMs);
    if (pending.timer && typeof pending.timer.unref === "function") {
      pending.timer.unref();
    }
    this._pendingAttachUniverseSiteReconciles.set(numericSystemID, pending);
    return true;
  },

cancelPendingAttachUniverseSiteReconcile(systemID, expectedScene = null) {
    const numericSystemID = toInt(systemID, 0);
    const pending = this._pendingAttachUniverseSiteReconciles.get(numericSystemID) || null;
    if (!pending || (expectedScene && pending.scene !== expectedScene)) {
      return false;
    }
    if (pending.timer) {
      clearTimeout(pending.timer);
    }
    this._pendingAttachUniverseSiteReconciles.delete(numericSystemID);
    return true;
  },
};
