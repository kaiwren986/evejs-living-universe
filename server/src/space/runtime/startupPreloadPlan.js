"use strict";

module.exports = {
  formatStartupBootstrapMetrics,
  getConfiguredStartupSystemLoadingMode,
  getStartupPreloadSystemLabel,
  keepsAllStargatesActiveDuringLazyLoading,
  mergeAlwaysOnSolarSystemIDs,
  normalizeStartupSystemIDs,
  resolveAlwaysOnSolarSystemIDs,
  resolveStartupPreloadedSystemIDs,
  resolveStartupSolarSystemPreloadPlan,
  shouldLogDetailedStartupPreload,
  shouldLogStartupPreloadCheckpoint,
};

const runtimeEntryDirname = require("path").resolve(__dirname, "..");
const path = require("path");
const config = require(path.join(runtimeEntryDirname, "../config"));
const worldData = require(path.join(runtimeEntryDirname, "./worldData"));
const {
  toInt,
} = require("../../common/numbers");
const {
  NEW_EDEN_SYSTEM_LOADING,
  STARTUP_PRELOADED_SYSTEM_IDS,
} = require("./solarSystemSceneLifecycle");
const {
  getDisplayedSecurityForStartupLoading,
} = require("./systemSecurityBand");

function getConfiguredStartupSystemLoadingMode() {
  switch (String(config.systemLoadingMode || "lazy").trim()) {
    case "onDemandGates":
      return NEW_EDEN_SYSTEM_LOADING.ONGOING_LAZY;
    case "highSecurity":
      return NEW_EDEN_SYSTEM_LOADING.HIGHSEC;
    case "all":
      return NEW_EDEN_SYSTEM_LOADING.ALL;
    default:
      return NEW_EDEN_SYSTEM_LOADING.LAZY;
  }
}

function keepsAllStargatesActiveDuringLazyLoading(
  mode = getConfiguredStartupSystemLoadingMode(),
) {
  return mode === NEW_EDEN_SYSTEM_LOADING.ONGOING_LAZY;
}

function normalizeStartupSystemIDs(systemIDs) {
  return [...new Set(
    (Array.isArray(systemIDs) ? systemIDs : [])
      .map((value) => toInt(value, 0))
      .filter((value) => value > 0),
  )].sort((left, right) => left - right);
}

function resolveAlwaysOnSolarSystemIDs() {
  return normalizeStartupSystemIDs(config.alwaysOnSolarSystemIDs);
}

function mergeAlwaysOnSolarSystemIDs(systemIDs) {
  return normalizeStartupSystemIDs([
    ...(Array.isArray(systemIDs) ? systemIDs : []),
    ...resolveAlwaysOnSolarSystemIDs(),
  ]);
}

function getStartupPreloadSystemLabel(systemID) {
  const numericSystemID = toInt(systemID, 0);
  const systemRecord = worldData.getSolarSystemByID(numericSystemID) || null;
  const systemName = String(
    systemRecord &&
      (systemRecord.solarSystemName ||
        systemRecord.itemName ||
        systemRecord.name ||
        ""),
  ).trim();
  return systemName
    ? `${systemName} (${numericSystemID})`
    : `system ${numericSystemID}`;
}

function shouldLogDetailedStartupPreload(totalSystems) {
  return Math.max(0, toInt(totalSystems, 0)) <= 25;
}

function shouldLogStartupPreloadCheckpoint(index, totalSystems) {
  const normalizedIndex = Math.max(1, toInt(index, 1));
  const normalizedTotal = Math.max(1, toInt(totalSystems, 1));
  if (shouldLogDetailedStartupPreload(normalizedTotal)) {
    return true;
  }
  if (normalizedIndex === 1 || normalizedIndex === normalizedTotal) {
    return true;
  }
  const checkpointStride =
    normalizedTotal >= 1000 ? 100 : normalizedTotal >= 250 ? 25 : 10;
  return normalizedIndex % checkpointStride === 0;
}

function formatStartupBootstrapMetrics(metrics = {}) {
  const parts = [];
  if ((Number(metrics.sceneConstructionElapsedMs) || 0) > 0) {
    parts.push(`scene ${metrics.sceneConstructionElapsedMs}ms`);
  }
  if ((Number(metrics.stargatesElapsedMs) || 0) > 0) {
    parts.push(`stargates ${metrics.stargatesElapsedMs}ms`);
  }
  if ((Number(metrics.dungeonReconcileElapsedMs) || 0) > 0) {
    parts.push(`dungeon-reconcile ${metrics.dungeonReconcileElapsedMs}ms`);
  }
  if ((Number(metrics.asteroidsElapsedMs) || 0) > 0) {
    parts.push(`asteroids ${metrics.asteroidsElapsedMs}ms`);
  }
  if ((Number(metrics.miningElapsedMs) || 0) > 0) {
    parts.push(`mining ${metrics.miningElapsedMs}ms`);
  }
  if ((Number(metrics.npcElapsedMs) || 0) > 0) {
    parts.push(`npc ${metrics.npcElapsedMs}ms`);
  }
  if ((Number(metrics.dungeonElapsedMs) || 0) > 0) {
    parts.push(`dungeon ${metrics.dungeonElapsedMs}ms`);
  }
  if ((Number(metrics.wormholesElapsedMs) || 0) > 0) {
    parts.push(`wormholes ${metrics.wormholesElapsedMs}ms`);
  }
  if ((Number(metrics.npcPostStaticElapsedMs) || 0) > 0) {
    parts.push(`npc-post-static ${metrics.npcPostStaticElapsedMs}ms`);
  }
  return parts.join(" | ");
}

function resolveStartupSolarSystemPreloadPlan() {
  const mode = getConfiguredStartupSystemLoadingMode();

  if (mode === NEW_EDEN_SYSTEM_LOADING.ONGOING_LAZY) {
    return {
      mode,
      modeName: "OnGoingLazy",
      label:
        "preloading the default startup systems plus configured always-on systems while keeping every stargate active for on-demand loading",
      selectionRule:
        "Preserves the lazy preload list, adds configured always-on systems, and keeps all stargates active for on-demand loading",
      targetSummary:
        "Default and configured always-on systems preload with on-demand access to the rest of New Eden",
      systemIDs: mergeAlwaysOnSolarSystemIDs(STARTUP_PRELOADED_SYSTEM_IDS),
    };
  }

  if (mode === NEW_EDEN_SYSTEM_LOADING.HIGHSEC) {
    return {
      mode,
      modeName: "High-Sec Preload",
      label:
        "preloading every high-security system with displayed security 0.5+ from world data",
      selectionRule: "Displayed security >= 0.5, resolved dynamically from world data",
      targetSummary: "All high-security systems",
      systemIDs: mergeAlwaysOnSolarSystemIDs(
        worldData.getSolarSystems()
          .filter(
            (system) => getDisplayedSecurityForStartupLoading(system) >= 0.5,
          )
          .map((system) => system && system.solarSystemID),
      ),
    };
  }

  if (mode === NEW_EDEN_SYSTEM_LOADING.ALL) {
    return {
      mode,
      modeName: "All Systems",
      label: "preloading every solar system in New Eden",
      selectionRule: "Every solar system row is queued during startup",
      targetSummary: "All solar systems",
      systemIDs: mergeAlwaysOnSolarSystemIDs(
        worldData.getSolarSystems().map((system) => system && system.solarSystemID),
      ),
    };
  }

  return {
    mode: NEW_EDEN_SYSTEM_LOADING.LAZY,
    modeName: "Lazy Default",
    label: "preloading the default startup systems plus configured always-on systems",
    selectionRule: "Preserves the default preload and adds configured always-on systems",
    targetSummary: "Default and configured always-on systems",
    systemIDs: mergeAlwaysOnSolarSystemIDs(STARTUP_PRELOADED_SYSTEM_IDS),
  };
}

function resolveStartupPreloadedSystemIDs() {
  return resolveStartupSolarSystemPreloadPlan().systemIDs;
}
