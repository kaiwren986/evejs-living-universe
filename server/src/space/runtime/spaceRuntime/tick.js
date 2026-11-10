"use strict";

const runtimeEntryDirname = require("path").resolve(__dirname, "../..");
const path = require("path");
const tickProfiler = require(path.join(runtimeEntryDirname, "tickProfiler"));
const log = require(path.join(runtimeEntryDirname, "../utils/logger"));
const {
  buildStartupPresenceSummary,
  getSceneActivityState,
} = require(path.join(runtimeEntryDirname, "./npc/npcSceneActivity"));
const {
  materializeDormantCombatControllersForScene,
  dematerializeDormantCombatControllersForScene,
} = require(path.join(runtimeEntryDirname, "./npc/npcCombatDormancy"));
const structureState = require(path.join(
  runtimeEntryDirname,
  "../services/structure/structureState",
));
const {
  toFiniteNumber,
} = require("../../../common/numbers");
const {
  getMonotonicTimeMs,
  getWallclockNowMs,
} = require("../runtimeClock");
const {
  lazyRequire,
} = require("../runtimeModuleBoundary");
const {
  noteSceneAsleep,
} = require("../destinyTick");
const {
  EMPTY_SOLAR_SYSTEM_COLLECTION_SWEEP_INTERVAL_MS,
} = require("../solarSystemSceneLifecycle");
const sceneFeatureHooks = require("../scene/sceneFeatureHooks");

module.exports = {

tick(wallclockNowMs) {
    tickProfiler.tickBoundary();
    const startedAtMonotonicMs = getMonotonicTimeMs();
    const previousTickStartedAtMonotonicMs = toFiniteNumber(
      this._lastTickStartedAtMonotonicMs,
      startedAtMonotonicMs - this._tickIntervalMs,
    );
    const actualIntervalMs = Math.max(
      this._tickIntervalMs,
      startedAtMonotonicMs - previousTickStartedAtMonotonicMs,
    );
    this._lastTickStartedAtMonotonicMs = startedAtMonotonicMs;

    const now = toFiniteNumber(wallclockNowMs, getWallclockNowMs());
    structureState.tickStructures(now);
    let tickedSceneCount = 0;
    let hazardRecoveryBlocked = false;
    for (const scene of this.scenes.values()) {
      try {
        require("../../../services/dungeon/siteHazardOutcomes").recoverForScene(scene);
      } catch (error) {
        hazardRecoveryBlocked = true;
        log.warn(`[SpaceRuntime] Holding scene ${scene.sceneKey} for hazard health recovery: ${error.message}`);
        continue;
      }
      const sceneActivity = getSceneActivityState(scene, now);
      if (!sceneActivity.shouldTick) {
        // Asleep: its next Gameplay tick is a wake, which resyncs its
        // Destiny tick driver quietly (runtime/destinyTick.js).
        noteSceneAsleep(scene);
        continue;
      }
      // This loop is preceded by structureState.tickStructures(now) above, so
      // the per-scene projection read must not run that global tick again.
      scene.syncStructureEntitiesFromState({ refresh: false });
      scene.destroyExpiredInventoryBackedEntities(sceneActivity.sceneNowMs);
      const gameplayTickStartMs = getMonotonicTimeMs();
      const sceneTickResult = scene.tick(now);
      if (sceneTickResult?.blocked) { hazardRecoveryBlocked = true; continue; }
      // Its per-scene features, after its tick, each in its own try (Scene
      // feature hooks): a docking approach that flew into range docks here,
      // as Tranquility docks it, without asking the client again.
      sceneFeatureHooks.tickSceneFeatures(scene, now);
      const gameplayTickWorkMs = Math.max(0, getMonotonicTimeMs() - gameplayTickStartMs);
      scene._lastTickWorkMs = gameplayTickWorkMs;
      tickProfiler.recordSceneTotal(gameplayTickWorkMs);
      scene._lastTickAtWallclockMs = now;
      if (!Array.isArray(scene._recentTickWorkMs)) scene._recentTickWorkMs = [];
      scene._recentTickWorkMs.push(gameplayTickWorkMs);
      if (scene._recentTickWorkMs.length > 120) scene._recentTickWorkMs.shift();
      if (!Array.isArray(scene._recentFactors)) scene._recentFactors = [];
      const factorSample = typeof scene.getTimeDilation === "function"
        ? scene.getTimeDilation()
        : Number(scene.timeDilation) || 1.0;
      scene._recentFactors.push(factorSample);
      if (scene._recentFactors.length > 120) scene._recentFactors.shift();
      if (scene.sessions instanceof Map && scene.sessions.size === 0) {
        dematerializeDormantCombatControllersForScene(scene, {
          broadcast: false,
          nowMs: toFiniteNumber(
            scene.getCurrentSimTimeMs && scene.getCurrentSimTimeMs(),
            sceneActivity.sceneNowMs,
          ),
        });
      }
      tickedSceneCount += 1;
    }

    let collectionSummary = { collectedSystemIDs: [] };
    if (!hazardRecoveryBlocked && now >= this._emptySolarSystemCollectionSchedule.nextSweepAtMs) {
      this._emptySolarSystemCollectionSchedule.nextSweepAtMs =
        now + EMPTY_SOLAR_SYSTEM_COLLECTION_SWEEP_INTERVAL_MS;
      try {
        collectionSummary = this.collectEmptySolarSystems(now);
      } catch (error) {
        log.warn(
          `[SpaceRuntime] Empty solar-system collection sweep failed: ${error.message}`,
        );
      }
    }
    const finishedAtMonotonicMs = getMonotonicTimeMs();
    const tickSummary = {
      startedAtMonotonicMs,
      actualIntervalMs,
      targetTickIntervalMs: this._tickIntervalMs,
      tickDurationMs: Math.max(0, finishedAtMonotonicMs - startedAtMonotonicMs),
      latenessMs: Math.max(0, actualIntervalMs - this._tickIntervalMs),
      sceneCount: this.scenes.size,
      tickedSceneCount,
      collectedSceneCount: collectionSummary.collectedSystemIDs.length,
    };
    this._lastTickSummary = tickSummary;
    if (!Array.isArray(this._recentTickSummaries)) this._recentTickSummaries = [];
    this._recentTickSummaries.push(tickSummary);
    if (this._recentTickSummaries.length > 120) this._recentTickSummaries.shift();
    try {
      const tidiAutoscaler = lazyRequire("../utils/tidiAutoscaler");
      if (
        tidiAutoscaler &&
        typeof tidiAutoscaler.observeRuntimeTickSample === "function"
      ) {
        tidiAutoscaler.observeRuntimeTickSample(tickSummary);
      }
    } catch (error) {
      log.warn(`[SpaceRuntime] TiDi autoscaler sample failed: ${error.message}`);
    }

    return tickSummary;
  },
};
