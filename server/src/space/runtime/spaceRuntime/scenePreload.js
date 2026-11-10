"use strict";

const runtimeEntryDirname = require("path").resolve(__dirname, "../..");
const path = require("path");
const log = require(path.join(runtimeEntryDirname, "../utils/logger"));
const {
  buildStartupPresenceSummary,
  getSceneActivityState,
} = require(path.join(runtimeEntryDirname, "./npc/npcSceneActivity"));
const {
  toInt,
} = require("../../../common/numbers");
const {
  formatStartupBootstrapMetrics,
  getStartupPreloadSystemLabel,
  resolveStartupSolarSystemPreloadPlan,
  shouldLogStartupPreloadCheckpoint,
} = require("../startupPreloadPlan");

module.exports = {

preloadSolarSystems(systemIDs, options = {}) {
    const preloadList = Array.isArray(systemIDs) ? systemIDs : [systemIDs];
    const normalizedSystemIDs = preloadList
      .map((systemID) => toInt(systemID, 0))
      .filter((systemID) => systemID > 0);
    const totalSystems = normalizedSystemIDs.length;
    const logStartupProgress = options.logStartupProgress === true;

    for (const [systemIndex, systemID] of normalizedSystemIDs.entries()) {
      const numericSystemID = toInt(systemID, 0);
      const progressIndex = systemIndex + 1;
      const shouldLogCheckpoint =
        logStartupProgress &&
        shouldLogStartupPreloadCheckpoint(progressIndex, totalSystems);
      const bootstrapMetrics = logStartupProgress ? {} : null;
      const systemLabel = getStartupPreloadSystemLabel(numericSystemID);
      const sceneStartedAtMs = Date.now();

      if (shouldLogCheckpoint) {
        log.info(
          `[SpaceRuntime] Startup preload ${progressIndex}/${totalSystems}: ` +
            `bootstrapping ${systemLabel}`,
        );
      }

      this.ensureScene(numericSystemID, {
        refreshStargates: false,
        startupBootstrapMetrics: bootstrapMetrics,
        reconcileUniverseSites: options.reconcileUniverseSites,
      });

      if (shouldLogCheckpoint) {
        const sceneElapsedMs = Date.now() - sceneStartedAtMs;
        const metricsSummary = formatStartupBootstrapMetrics(bootstrapMetrics);
        log.info(
          `[SpaceRuntime] Startup preload ${progressIndex}/${totalSystems}: ` +
            `${systemLabel} ready in ${sceneElapsedMs}ms` +
            `${metricsSummary ? ` | ${metricsSummary}` : ""}`,
        );
      }
    }

    const stargateRefreshStartedAtMs = Date.now();
    if (logStartupProgress) {
      log.info(
        `[SpaceRuntime] Startup preload stargates: refreshing activation state after ` +
          `${totalSystems} system(s)`,
      );
    }
    const activationChanges = this.refreshStargateActivationStates({
      broadcast: options.broadcast !== false,
    });
    if (logStartupProgress) {
      log.info(
        `[SpaceRuntime] Startup preload stargates complete in ` +
          `${Date.now() - stargateRefreshStartedAtMs}ms ` +
          `(${activationChanges.length} activation update(s))`,
      );
    }
    return activationChanges;
  },

preloadStartupSolarSystems(options = {}) {
    const preloadPlan = resolveStartupSolarSystemPreloadPlan();
    const startedAt = Date.now();
    const startupPresenceConfigSummary = buildStartupPresenceSummary([]);
    log.info(
      `[SpaceRuntime] Starting startup solar-system preload: mode=${preloadPlan.mode} ` +
        `${preloadPlan.modeName} count=${preloadPlan.systemIDs.length}`,
    );
    log.info(
      `[SpaceRuntime] NPC startup config: skip=${startupPresenceConfigSummary.settings.skipNpcStartup} ` +
        `authored=${startupPresenceConfigSummary.settings.authoredStartupEnabled} ` +
        `defaultConcord=${startupPresenceConfigSummary.settings.defaultConcordStartupEnabled} ` +
        `stationScreens=${startupPresenceConfigSummary.settings.defaultConcordStationScreensEnabled} ` +
        `ambientVirtualization=${startupPresenceConfigSummary.settings.ambientVirtualizationEnabled} ` +
        `combatDormancy=${startupPresenceConfigSummary.settings.combatDormancyEnabled}`,
    );
    const activationChanges = this.preloadSolarSystems(preloadPlan.systemIDs, {
      ...options,
      logStartupProgress: true,
    });
    const startupPresenceSummary = buildStartupPresenceSummary(preloadPlan.systemIDs);
    log.info(
      `[SpaceRuntime] Startup CONCORD presence: ${startupPresenceSummary.concord.ships} ships ` +
        `(live ${startupPresenceSummary.concord.liveShips} / virtualized ${startupPresenceSummary.concord.virtualizedShips}) ` +
        `across ${startupPresenceSummary.concord.stargateAnchors} gates / ` +
        `${startupPresenceSummary.concord.anchors} anchors in ` +
        `${startupPresenceSummary.concord.systems} systems`,
    );
    log.info(
      `[SpaceRuntime] Startup NPC presence: ${startupPresenceSummary.npc.ships} ships ` +
        `(live ${startupPresenceSummary.npc.liveShips} / virtualized ${startupPresenceSummary.npc.virtualizedShips}) ` +
        `across ${startupPresenceSummary.npc.stargateAnchors} gates / ` +
        `${startupPresenceSummary.npc.anchors} anchors in ` +
        `${startupPresenceSummary.npc.systems} systems`,
    );
    log.info(
      `[SpaceRuntime] Startup presence totals: ${startupPresenceSummary.totalStartupShips} ships ` +
        `(live ${startupPresenceSummary.liveStartupShips} / virtualized ${startupPresenceSummary.virtualizedStartupShips}) ` +
        `with startup presence in ${startupPresenceSummary.startupSystemsWithPresence} / ` +
        `${startupPresenceSummary.systemsConsidered} preloaded systems`,
    );
    log.success(
      `[SpaceRuntime] Startup solar-system preload complete in ${Date.now() - startedAt}ms ` +
        `(${preloadPlan.systemIDs.length} systems, ${activationChanges.length} stargate activation updates)`,
    );
    return activationChanges;
  },

getStartupSolarSystemPreloadPlan() {
    return resolveStartupSolarSystemPreloadPlan();
  },
};
