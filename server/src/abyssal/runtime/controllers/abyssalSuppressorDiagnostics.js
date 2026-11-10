"use strict";

const path = require("path");

const log = require("../../../utils/logger");
const {
  normalizeText,
} = require("../../domain/abyssalValueUtils");

const MAX_MISSILE_ACTIONS = 100;
const MAX_TARGET_ACTIONS = 100;
const MAX_MISSILE_DISTANCE_ENTRIES = 100;
const runDiagnosticsByID = new Map();

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function toFinite(value, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function formatMetric(value) {
  const numeric = toFinite(value, null);
  if (numeric === null) return "unknown";
  const rounded = Number(numeric.toFixed(3));
  return String(rounded);
}

function formatBoolean(value) {
  if (value === true) return "true";
  if (value === false) return "false";
  return "unknown";
}

function formatPosition(position) {
  if (!position || typeof position !== "object") return "unknown";
  const x = toFinite(position.x, null);
  const y = toFinite(position.y, null);
  const z = toFinite(position.z, null);
  if ([x, y, z].some((value) => value === null)) return "unknown";
  return `${formatMetric(x)},${formatMetric(y)},${formatMetric(z)}`;
}

function getDefaultDebugEnabled() {
  return false;
}

function createRunDiagnostics(runID) {
  return {
    runID: toInt(runID, 0),
    overrideEnabled: null,
    characterID: 0,
    changedAt: 0,
    lastPulse: null,
    missileActions: [],
    targetActions: [],
    lastMissileDistanceByID: new Map(),
  };
}

function getOrCreateRunDiagnostics(runID) {
  const numericRunID = toInt(runID, 0);
  if (numericRunID <= 0) return null;
  let state = runDiagnosticsByID.get(numericRunID);
  if (!state) {
    state = createRunDiagnostics(numericRunID);
    runDiagnosticsByID.set(numericRunID, state);
  }
  return state;
}

function isSuppressorDebugEnabled(runID) {
  const numericRunID = toInt(runID, 0);
  if (numericRunID <= 0) return false;
  const state = runDiagnosticsByID.get(numericRunID);
  if (state && typeof state.overrideEnabled === "boolean") {
    return state.overrideEnabled;
  }
  return getDefaultDebugEnabled();
}

function clearRunHistoryState(state) {
  if (!state) return;
  state.lastPulse = null;
  state.missileActions = [];
  state.targetActions = [];
  state.lastMissileDistanceByID.clear();
}

function setSuppressorDebugForRun(runID, characterID, enabled, nowMs = Date.now()) {
  const state = getOrCreateRunDiagnostics(runID);
  if (!state) {
    return { success: false, errorMsg: "ABYSSAL_RUN_ID_INVALID" };
  }
  state.overrideEnabled = enabled === true;
  state.characterID = toInt(characterID, 0);
  state.changedAt = toInt(nowMs, Date.now());
  if (state.overrideEnabled !== true) {
    clearRunHistoryState(state);
  }
  return {
    success: true,
    data: getSuppressorDebugSnapshot(runID),
  };
}

function appendBounded(list, entry, limit) {
  list.push(entry);
  if (list.length > limit) {
    list.splice(0, list.length - limit);
  }
  return entry;
}

function rememberMissileDistance(state, missileID, distanceMeters) {
  const numericMissileID = toInt(missileID, 0);
  const numericDistance = toFinite(distanceMeters, null);
  if (!state || numericMissileID <= 0 || numericDistance === null) return;
  state.lastMissileDistanceByID.delete(numericMissileID);
  state.lastMissileDistanceByID.set(numericMissileID, numericDistance);
  while (state.lastMissileDistanceByID.size > MAX_MISSILE_DISTANCE_ENTRIES) {
    const oldestKey = state.lastMissileDistanceByID.keys().next().value;
    state.lastMissileDistanceByID.delete(oldestKey);
  }
}

function recordSuppressorPulse(entry = {}) {
  const runID = toInt(entry.runID, 0);
  if (!isSuppressorDebugEnabled(runID)) return null;
  const state = getOrCreateRunDiagnostics(runID);
  const snapshot = {
    ...entry,
    runID,
    roomIndex: toInt(entry.roomIndex, 0),
    pulseNumber: toInt(entry.pulseNumber, 0),
    timestamp: toInt(entry.timestamp, Date.now()),
  };
  state.lastPulse = snapshot;
  log.info(
    `[AbyssalSuppressorPulse] run=${runID} room=${snapshot.roomIndex} ` +
      `scene=${normalizeText(snapshot.sceneKey, "none")} ` +
      `entity=${toInt(snapshot.suppressorID, 0)} pulse=${snapshot.pulseNumber} ` +
      `active=${snapshot.active === true} paused=${snapshot.paused === true} ` +
      `sceneDynamicEntities=${toInt(snapshot.sceneDynamicEntities, 0)} ` +
      `sceneMissileIndex=${toInt(snapshot.sceneMissileIndex, 0)} ` +
      `sceneDroneIndex=${toInt(snapshot.sceneDroneIndex, 0)} ` +
      `sceneFighterIndex=${toInt(snapshot.sceneFighterIndex, 0)} ` +
      `sceneNpcIndex=${toInt(snapshot.sceneNpcIndex, 0)} ` +
      `rawCandidates=${toInt(snapshot.rawCandidates, 0)} ` +
      `deduplicatedCandidates=${toInt(snapshot.deduplicatedCandidates, 0)} ` +
      `eligible=${toInt(snapshot.eligible, 0)} insideRange=${toInt(snapshot.insideRange, 0)} ` +
      `selected=${toInt(snapshot.selected, 0)} affected=${toInt(snapshot.affected, 0)} ` +
      `damaged=${toInt(snapshot.damaged, 0)} destroyed=${toInt(snapshot.destroyed, 0)} ` +
      `removedMissiles=${toInt(snapshot.removedMissiles, 0)} failed=${toInt(snapshot.failed, 0)} ` +
      `wrongScene=${toInt(snapshot.wrongScene, 0)} wrongRun=${toInt(snapshot.wrongRun, 0)} ` +
      `wrongRoom=${toInt(snapshot.wrongRoom, 0)} hiddenPrewarm=${toInt(snapshot.hiddenPrewarm, 0)} ` +
      `unsupportedType=${toInt(snapshot.unsupportedType, 0)} ` +
      `unsupportedClass=${toInt(snapshot.unsupportedClass, 0)} ` +
      `missingPosition=${toInt(snapshot.missingPosition, 0)} ` +
      `outsideRange=${toInt(snapshot.outsideRange, 0)} ` +
      `alreadyRemoved=${toInt(snapshot.alreadyRemoved, 0)} ` +
      `alreadyDestroyed=${toInt(snapshot.alreadyDestroyed, 0)} ` +
      `missingController=${toInt(snapshot.missingController, 0)} ` +
      `duplicate=${toInt(snapshot.duplicate, 0)}`,
  );
  return snapshot;
}

function recordSuppressorCandidate(entry = {}) {
  const runID = toInt(entry.runID, 0);
  if (!isSuppressorDebugEnabled(runID)) return null;
  const state = getOrCreateRunDiagnostics(runID);
  if (normalizeText(entry.entityClass, "") === "missile") {
    rememberMissileDistance(state, entry.candidateID, entry.distanceMeters);
  }
  log.info(
    `[AbyssalSuppressorCandidate] run=${runID} room=${toInt(entry.roomIndex, 0)} ` +
      `pulse=${toInt(entry.pulseNumber, 0)} suppressor=${toInt(entry.suppressorID, 0)} ` +
      `candidate=${toInt(entry.candidateID, 0)} typeID=${toInt(entry.typeID, 0)} ` +
      `groupID=${toInt(entry.groupID, 0)} categoryID=${toInt(entry.categoryID, 0)} ` +
      `class=${normalizeText(entry.entityClass, "unknown")} ` +
      `sourceRegistry=${normalizeText(entry.sourceRegistry, "unknown")} ` +
      `ownerID=${toInt(entry.ownerID, 0)} sourceShipID=${toInt(entry.sourceShipID, 0)} ` +
      `scene=${normalizeText(entry.sceneKey, "none")} ` +
      `position=${formatPosition(entry.position)} ` +
      `distanceMeters=${formatMetric(entry.distanceMeters)} ` +
      `eligible=${entry.eligible === true} insideRange=${entry.insideRange === true} ` +
      `action=${normalizeText(entry.action, "reject")} ` +
      `result=${normalizeText(entry.result, "failed")} ` +
      `reason=${normalizeText(entry.reason, "none")}`,
  );
  return { ...entry };
}

function recordSuppressorTargetDamage(entry = {}) {
  const runID = toInt(entry.runID, 0);
  if (!isSuppressorDebugEnabled(runID)) return null;
  const state = getOrCreateRunDiagnostics(runID);
  const action = appendBounded(state.targetActions, {
    ...entry,
    runID,
    roomIndex: toInt(entry.roomIndex, 0),
    pulseNumber: toInt(entry.pulseNumber, 0),
    targetID: toInt(entry.targetID, 0),
  }, MAX_TARGET_ACTIONS);
  if (normalizeText(entry.entityClass, "").includes("drone")) {
    log.info(
      `[AbyssalSuppressorDroneDamage] run=${runID} room=${action.roomIndex} ` +
        `pulse=${action.pulseNumber} drone=${action.targetID} ` +
        `typeID=${toInt(action.typeID, 0)} ownerID=${toInt(action.ownerID, 0)} ` +
        `distance=${formatMetric(action.distanceMeters)} ` +
        `rawDamageExplosive=${formatMetric(action.rawDamageExplosive)} ` +
        `rawDamageThermal=${formatMetric(action.rawDamageThermal)} ` +
        `shieldBefore=${formatMetric(action.shieldBefore)} ` +
        `armorBefore=${formatMetric(action.armorBefore)} ` +
        `structureBefore=${formatMetric(action.structureBefore)} ` +
        `shieldAfter=${formatMetric(action.shieldAfter)} ` +
        `armorAfter=${formatMetric(action.armorAfter)} ` +
        `structureAfter=${formatMetric(action.structureAfter)} ` +
        `destroyed=${action.destroyed === true} ` +
        `result=${normalizeText(action.result, "failed")}`,
    );
  }
  return { ...action };
}

function removeSelectedMissile(options = {}) {
  const scene = options.scene;
  const missile = options.missile;
  const missileID = toInt(missile && missile.itemID, 0);
  const runID = toInt(options.runID, 0);
  const debugEnabled = isSuppressorDebugEnabled(runID);
  const selectedAt = toInt(options.selectedAt, Date.now());
  const baseAction = {
    missileID,
    runID,
    roomIndex: toInt(options.roomIndex, 0),
    pulseNumber: toInt(options.pulseNumber, 0),
    selectedAt,
    removedAt: 0,
    removalReason: "suppressor-pulse",
    sourceShipID: toInt(missile && missile.sourceShipID, 0),
    targetID: toInt(missile && missile.targetEntityID, 0),
    distanceAtSelection: toFinite(options.distanceMeters, null),
    controllerStopped: null,
    removedFromDynamicEntities: null,
    removedFromMissileRegistry: null,
    removeBallsSent: null,
    result: "failed",
  };
  if (
    missileID <= 0 ||
    !scene ||
    !(scene.dynamicEntities instanceof Map) ||
    scene.dynamicEntities.get(missileID) !== missile ||
    missile.destroyed === true ||
    missile.removed === true
  ) {
    if (debugEnabled) {
      appendBounded(
        getOrCreateRunDiagnostics(runID).missileActions,
        { ...baseAction, result: "already-gone" },
        MAX_MISSILE_ACTIONS,
      );
    }
    return {
      affected: false,
      destroyed: false,
      removedMissile: false,
      alreadyGone: true,
      reason: "already-gone",
      diagnostics: { ...baseAction, result: "already-gone" },
    };
  }

  if (debugEnabled) {
    missile.evejsAbyssalSuppressorRemovalDiagnostic = {
      runID,
      roomIndex: baseAction.roomIndex,
      pulseNumber: baseAction.pulseNumber,
      missileID,
      sourceShipID: baseAction.sourceShipID,
      targetID: baseAction.targetID,
      distanceAtSelection: baseAction.distanceAtSelection,
      selectedAt,
      impactBlockedLogged: false,
    };
  }
  let removalDelivery = null;
  const removeResult = typeof scene.removeDynamicEntity === "function"
    ? scene.removeDynamicEntity(missileID, {
      allowSessionOwned: false,
      terminalDestructionEffectID: 0,
      nowMs: selectedAt,
      onRemovalDiagnostics(result) {
        removalDelivery = result && typeof result === "object" ? { ...result } : null;
      },
    })
    : null;
  if (!removeResult || removeResult.success !== true) {
    delete missile.evejsAbyssalSuppressorRemovalDiagnostic;
    return {
      affected: false,
      destroyed: false,
      removedMissile: false,
      failed: true,
      reason: normalizeText(removeResult && removeResult.errorMsg, "remove-failed"),
      diagnostics: baseAction,
    };
  }

  missile.evejsAbyssalSuppressorDestroyed = true;
  missile.destructionState = "destroyed";
  missile.destroyed = true;
  missile.removed = true;
  missile.persistSpaceState = false;
  const action = {
    ...baseAction,
    removedAt: selectedAt,
    controllerStopped: scene.dynamicEntities.get(missileID) !== missile,
    removedFromDynamicEntities: !scene.dynamicEntities.has(missileID),
    removedFromMissileRegistry: scene.dynamicEntityExpiryByID instanceof Map
      ? !scene.dynamicEntityExpiryByID.has(missileID)
      : null,
    removeBallsSent: removalDelivery
      ? toInt(removalDelivery.deliveredCount, 0) > 0
      : null,
    result: "success",
  };
  if (missile.evejsAbyssalSuppressorRemovalDiagnostic) {
    Object.assign(missile.evejsAbyssalSuppressorRemovalDiagnostic, action);
  }
  if (debugEnabled) {
    const state = getOrCreateRunDiagnostics(runID);
    appendBounded(state.missileActions, action, MAX_MISSILE_ACTIONS);
    rememberMissileDistance(state, missileID, action.distanceAtSelection);
    log.info(
      `[AbyssalSuppressorMissileRemoved] run=${runID} room=${action.roomIndex} ` +
        `pulse=${action.pulseNumber} missile=${missileID} source=${action.sourceShipID} ` +
        `target=${action.targetID} distance=${formatMetric(action.distanceAtSelection)} ` +
        `controllerStopped=${formatBoolean(action.controllerStopped)} ` +
        `dynamicEntityRemoved=${formatBoolean(action.removedFromDynamicEntities)} ` +
        `missileIndexRemoved=${formatBoolean(action.removedFromMissileRegistry)} ` +
        `removeBallsSent=${formatBoolean(action.removeBallsSent)}`,
    );
  }
  return {
    affected: true,
    destroyed: true,
    removedMissile: true,
    reason: "removed-by-suppressor",
    diagnostics: action,
  };
}

function recordSuppressorMissileImpactBlocked(missile) {
  const diagnostic = missile && missile.evejsAbyssalSuppressorRemovalDiagnostic;
  const runID = toInt(diagnostic && diagnostic.runID, 0);
  if (
    !diagnostic ||
    diagnostic.impactBlockedLogged === true ||
    !isSuppressorDebugEnabled(runID)
  ) {
    return false;
  }
  diagnostic.impactBlockedLogged = true;
  const state = getOrCreateRunDiagnostics(runID);
  for (let index = state.missileActions.length - 1; index >= 0; index -= 1) {
    if (toInt(state.missileActions[index].missileID, 0) === toInt(diagnostic.missileID, 0)) {
      state.missileActions[index].impactBlocked = true;
      break;
    }
  }
  log.info(
    `[AbyssalSuppressorMissileImpactBlocked] missile=${toInt(diagnostic.missileID, 0)} ` +
      `run=${runID} target=${toInt(diagnostic.targetID, 0)} ` +
      `reason=previously-removed-by-suppressor`,
  );
  return true;
}

function recordSuppressorMissileNormalImpact(missile) {
  const runID = toInt(
    missile && (
      missile.abyssalRunID ||
      missile.evejsAbyssalInstanceID ||
      missile.evejsAbyssalPocketInstanceID
    ),
    0,
  );
  if (runID <= 0 || !isSuppressorDebugEnabled(runID)) return null;
  if (missile.evejsAbyssalSuppressorRemovalDiagnostic) return null;
  const state = getOrCreateRunDiagnostics(runID);
  const missileID = toInt(missile.itemID, 0);
  const distance = state.lastMissileDistanceByID.has(missileID)
    ? state.lastMissileDistanceByID.get(missileID)
    : null;
  const action = appendBounded(state.missileActions, {
    missileID,
    runID,
    roomIndex: toInt(missile.abyssalRoomIndex || missile.evejsAbyssalRoomIndex, 0),
    pulseNumber: 0,
    selectedAt: 0,
    removedAt: 0,
    removalReason: "normal-impact",
    sourceShipID: toInt(missile.sourceShipID, 0),
    targetID: toInt(missile.targetEntityID, 0),
    distanceAtSelection: distance,
    result: "normal-impact",
  }, MAX_MISSILE_ACTIONS);
  log.info(
    `[AbyssalSuppressorMissileNormalImpact] missile=${missileID} run=${runID} ` +
      `target=${action.targetID} lastKnownDistanceFromSuppressor=${formatMetric(distance)}`,
  );
  return { ...action };
}

function getSuppressorDebugSnapshot(runID) {
  const numericRunID = toInt(runID, 0);
  const state = runDiagnosticsByID.get(numericRunID) || null;
  const overrideEnabled = state && typeof state.overrideEnabled === "boolean"
    ? state.overrideEnabled
    : null;
  const enabled = overrideEnabled === null ? getDefaultDebugEnabled() : overrideEnabled;
  return {
    runID: numericRunID,
    enabled,
    source: overrideEnabled === null
      ? getDefaultDebugEnabled()
        ? "startup-default"
        : "default-off"
      : "run-override",
    characterID: toInt(state && state.characterID, 0),
    changedAt: toInt(state && state.changedAt, 0),
    lastPulse: state && state.lastPulse ? { ...state.lastPulse } : null,
    missileActions: state ? state.missileActions.map((entry) => ({ ...entry })) : [],
    targetActions: state ? state.targetActions.map((entry) => ({ ...entry })) : [],
    historyLimits: {
      missileActions: MAX_MISSILE_ACTIONS,
      targetActions: MAX_TARGET_ACTIONS,
    },
  };
}

function clearSuppressorDebugHistoryForRun(runID) {
  const state = runDiagnosticsByID.get(toInt(runID, 0));
  if (!state) return false;
  clearRunHistoryState(state);
  return true;
}

function clearSuppressorDebugForRun(runID) {
  return runDiagnosticsByID.delete(toInt(runID, 0));
}

function resetSuppressorDiagnosticsForTests() {
  runDiagnosticsByID.clear();
}

module.exports = {
  MAX_MISSILE_ACTIONS,
  MAX_TARGET_ACTIONS,
  clearSuppressorDebugForRun,
  clearSuppressorDebugHistoryForRun,
  getSuppressorDebugSnapshot,
  isSuppressorDebugEnabled,
  recordSuppressorCandidate,
  recordSuppressorMissileImpactBlocked,
  recordSuppressorMissileNormalImpact,
  recordSuppressorPulse,
  recordSuppressorTargetDamage,
  removeSelectedMissile,
  resetSuppressorDiagnosticsForTests,
  setSuppressorDebugForRun,
};
