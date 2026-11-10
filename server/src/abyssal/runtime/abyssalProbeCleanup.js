"use strict";

const { normalizeText } = require("../domain/abyssalValueUtils");

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

// Persistence retirement and scene removal are separate retryable steps.
// Scope is rechecked on live entities; a retired record's ID is never authority.
function isScannerProbeSceneEntity({
  normalizeLowerText,
  GROUP_WARP_DISRUPTION_PROBE,
  GROUP_SCANNER_PROBE,
}, entity) {
  return Boolean(
    entity &&
      (
        (
          normalizeLowerText(entity.kind, "") === "probe" &&
          toInt(entity.groupID, 0) !== GROUP_WARP_DISRUPTION_PROBE
        ) ||
        toInt(entity.groupID, 0) === GROUP_SCANNER_PROBE
      )
  );
}

function retireAbyssalProbeCleanupRecords({
  resolveExactAbyssalRunRoomScope,
}, context) {
  const { runID, knownRoomIndexes, deps, removedRecords, summary, diagnostics } = context;
  for (const roomIndex of knownRoomIndexes) {
    try {
      const removedForRoom = deps.removeExactAbyssalProbes(runID, {
        roomIndex,
        nowMs: toInt(deps && typeof deps.now === "function" ? deps.now() : Date.now(), Date.now()),
      });
      if (!Array.isArray(removedForRoom)) {
        summary.failedScannerProbeCleanup += 1;
        diagnostics.push({ roomIndex, reason: "PROBE_STATE_CLEANUP_RESULT_INVALID" });
        continue;
      }
      for (const probeRecord of removedForRoom) {
        const exactScope = resolveExactAbyssalRunRoomScope(probeRecord);
        if (
          !exactScope ||
          exactScope.runID !== runID ||
          exactScope.roomIndex !== roomIndex
        ) {
          summary.failedScannerProbeCleanup += 1;
          diagnostics.push({
            probeID: toInt(probeRecord && probeRecord.probeID, 0),
            roomIndex,
            reason: "PROBE_STATE_CLEANUP_SCOPE_MISMATCH",
          });
          continue;
        }
        removedRecords.push(probeRecord);
      }
    } catch (error) {
      summary.failedScannerProbeCleanup += 1;
      diagnostics.push({
        roomIndex,
        reason: normalizeText(error && error.message, "PROBE_STATE_CLEANUP_FAILED"),
      });
    }
  }
  summary.removedScannerProbeRecords = removedRecords.length;
}

function collectAbyssalProbeCleanupSceneCandidates({
  getPocketScene,
  isScannerProbeSceneEntity,
}, pocketState, deps, removedRecords, summary) {
  // Retry also scans the scene when persistence was retired before scene removal.
  // A matching entity ID alone never provides scope authority.
  const scene = getPocketScene(pocketState, deps);
  const sceneCandidates = new Map();
  if (scene && scene.dynamicEntities instanceof Map) {
    for (const entity of scene.dynamicEntities.values()) {
      if (isScannerProbeSceneEntity(entity)) {
        sceneCandidates.set(toInt(entity && entity.itemID, 0), entity);
      }
    }
  }
  for (const probeRecord of removedRecords) {
    const probeID = toInt(probeRecord && probeRecord.probeID, 0);
    const entity =
      probeID > 0 && scene && typeof scene.getEntityByID === "function"
        ? scene.getEntityByID(probeID)
        : null;
    if (entity) {
      sceneCandidates.set(probeID, entity);
    } else if (probeID > 0) {
      summary.scannerProbeEntitiesAlreadyGone += 1;
    }
  }
  return { scene, sceneCandidates };
}

function cleanupExactAbyssalScannerProbes({
  buildPlaceholderRoomState,
  retireAbyssalProbeCleanupRecords,
  collectAbyssalProbeCleanupSceneCandidates,
  isScannerProbeSceneEntity,
  resolveExactAbyssalRunRoomScope,
  log,
},
  pocketState,
  deps,
  reason = "run-cleanup",
  options = {},
) {
  const runID = toInt(pocketState && pocketState.instanceID, 0);
  const roomState = buildPlaceholderRoomState(pocketState);
  const allKnownRoomIndexes = [...new Set(
    Object.values(roomState.roomStatesByIndex || {})
      .map((roomEntry) => toInt(roomEntry && roomEntry.roomIndex, 0))
      .filter((roomIndex) => roomIndex > 0),
  )].sort((left, right) => left - right);
  const requestedRoomIndexes = Array.isArray(options.roomIndexes)
    ? [...new Set(options.roomIndexes.map((roomIndex) => toInt(roomIndex, 0)))]
        .filter((roomIndex) => roomIndex > 0)
    : null;
  const knownRoomIndexes = requestedRoomIndexes
    ? requestedRoomIndexes.filter((roomIndex) => allKnownRoomIndexes.includes(roomIndex))
    : allKnownRoomIndexes;
  const summary = {
    removedScannerProbeRecords: 0,
    removedScannerProbeEntities: 0,
    scannerProbeEntitiesAlreadyGone: 0,
    failedScannerProbeCleanup: 0,
    diagnosticSkippedScannerProbeEntities: 0,
  };
  const removedRecords = [];
  const removedEntityIDs = [];
  const diagnostics = [];
  if (
    runID <= 0 ||
    knownRoomIndexes.length === 0 ||
    typeof deps.removeExactAbyssalProbes !== "function"
  ) {
    if (runID > 0 && knownRoomIndexes.length > 0) {
      summary.failedScannerProbeCleanup += 1;
      diagnostics.push({ reason: "PROBE_STATE_CLEANUP_UNAVAILABLE" });
    }
    return { removedRecords, removedEntityIDs, cleanupSummary: summary, diagnostics };
  }

  retireAbyssalProbeCleanupRecords({
    runID, knownRoomIndexes, deps, removedRecords, summary, diagnostics,
  });

  const { scene, sceneCandidates } = collectAbyssalProbeCleanupSceneCandidates(
    pocketState, deps, removedRecords, summary,
  );

  const knownRoomIndexSet = new Set(knownRoomIndexes);
  for (const [probeID, entity] of sceneCandidates.entries()) {
    if (probeID <= 0 || !isScannerProbeSceneEntity(entity)) {
      continue;
    }
    const exactScope = resolveExactAbyssalRunRoomScope(entity);
    if (
      !exactScope ||
      exactScope.runID !== runID ||
      !knownRoomIndexSet.has(exactScope.roomIndex)
    ) {
      if (removedRecords.some((record) => toInt(record && record.probeID, 0) === probeID)) {
        summary.diagnosticSkippedScannerProbeEntities += 1;
        diagnostics.push({
          probeID,
          reason: "PROBE_SCENE_ENTITY_SCOPE_COLLISION",
        });
      }
      continue;
    }
    if (!scene || typeof scene.removeDynamicEntity !== "function") {
      summary.failedScannerProbeCleanup += 1;
      diagnostics.push({ probeID, reason: "PROBE_SCENE_CLEANUP_UNAVAILABLE" });
      continue;
    }
    const removeResult = scene.removeDynamicEntity(probeID, {
      allowSessionOwned: true,
      reason: normalizeText(reason, "run-cleanup"),
    });
    if (removeResult && removeResult.success === true) {
      removedEntityIDs.push(probeID);
      summary.removedScannerProbeEntities += 1;
    } else {
      summary.failedScannerProbeCleanup += 1;
      diagnostics.push({
        probeID,
        reason: normalizeText(removeResult && removeResult.errorMsg, "PROBE_SCENE_CLEANUP_FAILED"),
      });
    }
  }

  if (diagnostics.length > 0) {
    log.warn(
      `[AbyssalProbeCleanup] run=${runID} reason=${normalizeText(reason, "run-cleanup")} ` +
        `failed=${summary.failedScannerProbeCleanup} ` +
        `diagnosticOnly=${summary.diagnosticSkippedScannerProbeEntities} entries=${diagnostics
          .map((entry) => `${toInt(entry.probeID, 0) || "room" + toInt(entry.roomIndex, 0)}:${entry.reason}`)
          .join(",")}`,
    );
  }
  return { removedRecords, removedEntityIDs, cleanupSummary: summary, diagnostics };
}

function createAbyssalProbeCleanup({
  normalizeLowerText,
  GROUP_WARP_DISRUPTION_PROBE,
  GROUP_SCANNER_PROBE,
  resolveExactAbyssalRunRoomScope,
  getPocketScene,
  buildPlaceholderRoomState,
  log,
}) {

  const ports = {
    normalizeLowerText,
    GROUP_WARP_DISRUPTION_PROBE,
    GROUP_SCANNER_PROBE,
    resolveExactAbyssalRunRoomScope,
    getPocketScene,
    buildPlaceholderRoomState,
    log,
  };
  ports.isScannerProbeSceneEntity = isScannerProbeSceneEntity.bind(null, ports);
  ports.retireAbyssalProbeCleanupRecords = retireAbyssalProbeCleanupRecords.bind(null, ports);
  ports.collectAbyssalProbeCleanupSceneCandidates = collectAbyssalProbeCleanupSceneCandidates.bind(null, ports);
  ports.cleanupExactAbyssalScannerProbes = cleanupExactAbyssalScannerProbes.bind(null, ports);
  Object.freeze(ports);
  return { cleanupExactAbyssalScannerProbes: ports.cleanupExactAbyssalScannerProbes };
}

module.exports = { createAbyssalProbeCleanup };
