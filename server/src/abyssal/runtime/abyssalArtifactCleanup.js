"use strict";

const { normalizeText } = require("../domain/abyssalValueUtils");

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

// Removal authority stays in the injected exact-run runtime helpers. This
// adapter orders existing removals and reports their per-attempt outcomes.
function createEmptyAbyssalArtifactInventory({}) {
  return {
    entranceTraces: [],
    markers: [],
    conduits: [],
    hostiles: [],
    rewardCaches: [],
    extractionNodes: [],
    sceneryVisuals: [],
    environmentalObjects: [],
    weatherEffects: [],
    alreadyGone: [],
    unknownTaggedArtifacts: [],
    cleanupFailures: [],
  };
}

function collectAbyssalArtifactInventory({
  getDependencies,
  createEmptyAbyssalArtifactInventory,
  buildPlaceholderRoomState,
  listUniquePositiveInts,
  listAllPocketHostileEntityIDs,
  getResolvedWeatherState,
}, pocketState, deps = getDependencies()) {
  if (!pocketState) {
    return createEmptyAbyssalArtifactInventory();
  }
  const roomState = buildPlaceholderRoomState(pocketState);
  const inventory = createEmptyAbyssalArtifactInventory();

  const traceItemID = toInt(pocketState.traceItemID, 0);
  if (traceItemID > 0) {
    inventory.entranceTraces.push(traceItemID);
  }

  for (const roomEntry of Object.values(roomState.roomStatesByIndex || {})) {
    const originMarkerItemID = toInt(roomEntry && roomEntry.originMarkerItemID, 0);
    const conduitItemID = toInt(roomEntry && roomEntry.conduitItemID, 0);
    const cacheItemIDs = listUniquePositiveInts([
      roomEntry && roomEntry.cacheItemID,
      roomEntry && roomEntry.cacheStructureItemID,
      roomEntry && roomEntry.cacheLootContainerItemID,
    ]);
    const extractionNodeItemIDs = listUniquePositiveInts(roomEntry && roomEntry.extractionNodeItemIDs);
    const extractionNodeLootContainerItemIDs = listUniquePositiveInts(
      roomEntry && roomEntry.extractionNodeLootContainerItemIDs,
    );
    const sceneryVisualEntityIDs = listUniquePositiveInts(roomEntry && roomEntry.sceneryVisualEntityIDs);
    const sceneryProbeEntityID = toInt(roomEntry && roomEntry.sceneryProbeEntityID, 0);
    const environmentalObjectItemIDs = listUniquePositiveInts(roomEntry && roomEntry.environmentalObjectItemIDs);
    if (originMarkerItemID > 0) {
      inventory.markers.push(originMarkerItemID);
    } else if (toInt(roomEntry && roomEntry.originMarkerSpawnedAtMs, 0) > 0) {
      inventory.alreadyGone.push({
        role: "originMarker",
        roomIndex: toInt(roomEntry && roomEntry.roomIndex, 0),
      });
    }
    if (conduitItemID > 0) {
      inventory.conduits.push(conduitItemID);
    } else if (toInt(roomEntry && roomEntry.conduitSpawnedAtMs, 0) > 0) {
      inventory.alreadyGone.push({
        role: "conduit",
        roomIndex: toInt(roomEntry && roomEntry.roomIndex, 0),
      });
    }
    if (cacheItemIDs.length > 0) {
      inventory.rewardCaches.push(...cacheItemIDs);
    } else if (
      toInt(roomEntry && roomEntry.cacheSpawnedAtMs, 0) > 0 ||
      normalizeText(roomEntry && roomEntry.cacheLifecycleState, "") === "consumed_or_removed"
    ) {
      inventory.alreadyGone.push({
        role: "rewardCache",
        roomIndex: toInt(roomEntry && roomEntry.roomIndex, 0),
      });
    }
    if (extractionNodeItemIDs.length > 0) {
      inventory.extractionNodes.push(...extractionNodeItemIDs);
    } else if (
      toInt(roomEntry && roomEntry.extractionNodeSpawnedAtMs, 0) > 0 ||
      normalizeText(roomEntry && roomEntry.extractionNodeLifecycleState, "") === "consumed_or_removed"
    ) {
      inventory.alreadyGone.push({
        role: "extractionNode",
        roomIndex: toInt(roomEntry && roomEntry.roomIndex, 0),
      });
    }
    if (sceneryVisualEntityIDs.length > 0) {
      inventory.sceneryVisuals.push(...sceneryVisualEntityIDs);
    } else if (
      toInt(roomEntry && roomEntry.sceneryVisualSpawnedAtMs, 0) > 0 ||
      normalizeText(roomEntry && roomEntry.sceneryVisualLifecycleState, "") === "removed"
    ) {
      inventory.alreadyGone.push({
        role: "sceneryVisual",
        roomIndex: toInt(roomEntry && roomEntry.roomIndex, 0),
      });
    }
    if (sceneryProbeEntityID > 0) {
      inventory.sceneryVisuals.push(sceneryProbeEntityID);
    } else if (
      toInt(roomEntry && roomEntry.sceneryProbeSpawnedAtMs, 0) > 0 ||
      normalizeText(roomEntry && roomEntry.sceneryProbeLifecycleState, "") === "removed"
    ) {
      inventory.alreadyGone.push({
        role: "sceneryVisual",
        roomIndex: toInt(roomEntry && roomEntry.roomIndex, 0),
      });
    }
    if (environmentalObjectItemIDs.length > 0) {
      inventory.environmentalObjects.push(...environmentalObjectItemIDs);
    } else if (
      toInt(roomEntry && roomEntry.environmentalObjectSpawnedAtMs, 0) > 0 ||
      normalizeText(roomEntry && roomEntry.environmentalObjectLifecycleState, "") === "removed"
    ) {
      inventory.alreadyGone.push({
        role: "environmentalObject",
        roomIndex: toInt(roomEntry && roomEntry.roomIndex, 0),
      });
    }
  }

  inventory.hostiles.push(...listAllPocketHostileEntityIDs(pocketState));
  const weatherState = getResolvedWeatherState(pocketState);
  if (weatherState) {
    inventory.weatherEffects.push({
      shipID: toInt(pocketState.shipID, 0),
      weatherType: normalizeText(weatherState.weatherType, "unknown"),
      playerEffectCount: Array.isArray(weatherState.playerAppliedEffectKeys)
        ? weatherState.playerAppliedEffectKeys.length
        : 0,
      npcEffectCount: Array.isArray(weatherState.npcAppliedEffectKeys)
        ? weatherState.npcAppliedEffectKeys.length
        : 0,
      cleanupExpected: Boolean(
        pocketState.weatherDiagnostics &&
        pocketState.weatherDiagnostics.cleanupExpected === true
      ),
    });
  }
  return inventory;
}

function buildExtractionNodeCleanupTracking({
  buildPlaceholderRoomState,
  listUniquePositiveInts,
}, pocketState) {
  const roomState = buildPlaceholderRoomState(pocketState);
  const references = [];
  const addReferences = (roomIndex, collectionName, itemIDs) => {
    const source = `roomStatesByIndex[${roomIndex}].${collectionName}`;
    for (const itemID of listUniquePositiveInts(itemIDs)) {
      references.push({ itemID, source });
    }
  };

  const roomEntries = Object.entries(roomState.roomStatesByIndex || {})
    .sort(([leftIndex], [rightIndex]) => toInt(leftIndex, 0) - toInt(rightIndex, 0));
  for (const [roomIndex, roomEntry] of roomEntries) {
    addReferences(roomIndex, "extractionNodeItemIDs", roomEntry && roomEntry.extractionNodeItemIDs);
    addReferences(
      roomIndex,
      "extractionNodeHistoricalItemIDs",
      roomEntry && roomEntry.extractionNodeHistoricalItemIDs,
    );
    addReferences(
      roomIndex,
      "extractionNodeRewardMaterializedItemIDs",
      roomEntry && roomEntry.extractionNodeRewardMaterializedItemIDs,
    );
  }

  const uniqueExtractionNodeIDs = listUniquePositiveInts(
    references.map((reference) => reference.itemID),
  );
  return {
    extractionNodeReferences: references.length,
    uniqueExtractionNodeIDs,
    uniqueExtractionNodes: uniqueExtractionNodeIDs.length,
    duplicateExtractionNodeReferences: Math.max(0, references.length - uniqueExtractionNodeIDs.length),
    sources: [...new Set(references.map((reference) => reference.source))],
    references,
  };
}

function buildAbyssalArtifactCleanupContext({
  buildPlaceholderRoomState,
  buildExtractionNodeCleanupTracking,
  listUniquePositiveInts,
  log,
  destroyPocketEncounterEntities,
}, pocketState, deps, cleanupReason) {
  const destroyedItemIDs = [];
  const destroyedScannerProbeIDs = [];
  const systemID = toInt(pocketState && pocketState.solarSystemID, 0);
  const roomState = buildPlaceholderRoomState(pocketState);
  const extractionNodeTracking = buildExtractionNodeCleanupTracking(pocketState);
  const extractionNodeIDSet = new Set(extractionNodeTracking.uniqueExtractionNodeIDs);
  const extractionNodeLootContainerItemIDs = listUniquePositiveInts(
    Object.values(roomState.roomStatesByIndex || {}).flatMap((roomEntry) =>
      listUniquePositiveInts(roomEntry && roomEntry.extractionNodeLootContainerItemIDs)
    ),
  ).filter((itemID) => !extractionNodeIDSet.has(itemID));
  log.info(
    `[AbyssalCleanupTracking] instance=${toInt(pocketState && pocketState.instanceID, 0)} ` +
      `extractionNodeReferences=${extractionNodeTracking.extractionNodeReferences} ` +
      `uniqueExtractionNodeIDs=${extractionNodeTracking.uniqueExtractionNodes} ` +
      `duplicateExtractionNodeReferences=${extractionNodeTracking.duplicateExtractionNodeReferences} ` +
      `ids=${extractionNodeTracking.uniqueExtractionNodeIDs.join(",") || "none"} ` +
      `sources=${extractionNodeTracking.sources.join(",") || "none"}`,
  );
  const destroyedHostileIDs = destroyPocketEncounterEntities(pocketState, deps);
  const cleanupSummary = {
    removedEntranceTraces: 0,
    removedRoomMarkers: 0,
    removedConduits: 0,
    removedRewardCaches: 0,
    removedExtractionNodes: 0,
    removedExtractionNodeLootContainers: 0,
    removedSceneryVisuals: 0,
    removedEnvironmentalObjects: 0,
    removedResidualSpaceItems: 0,
    rewardCachesAlreadyGone: 0,
    extractionNodesAlreadyGone: 0,
    extractionNodeLootContainersAlreadyGone: 0,
    failedExtractionNodes: 0,
    trackedExtractionNodeReferences: extractionNodeTracking.extractionNodeReferences,
    uniqueExtractionNodes: extractionNodeTracking.uniqueExtractionNodes,
    duplicateExtractionNodeReferences: extractionNodeTracking.duplicateExtractionNodeReferences,
    extractionNodeTrackingSources: [...extractionNodeTracking.sources],
    uniqueExtractionNodeIDs: [...extractionNodeTracking.uniqueExtractionNodeIDs],
    sceneryVisualsAlreadyGone: 0,
    environmentalObjectsAlreadyGone: 0,
    artifactRemovalAttemptsAlreadyGone: 0,
    alreadyGoneArtifacts: 0,
    failedArtifacts: 0,
    residualSpaceItemsAlreadyGone: 0,
    failedResidualSpaceItems: 0,
    diagnosticSkippedResidualSpaceItems: 0,
    removedRunScopedCorpses: 0,
    runScopedCorpsesAlreadyGone: 0,
    failedRunScopedCorpses: 0,
    removedRunScopedCapsules: 0,
    runScopedCapsulesAlreadyGone: 0,
    failedRunScopedCapsules: 0,
    removedScannerProbeRecords: 0,
    removedScannerProbeEntities: 0,
    scannerProbeEntitiesAlreadyGone: 0,
    failedScannerProbeCleanup: 0,
    diagnosticSkippedScannerProbeEntities: 0,
    alreadyGoneItemIDs: [],
    failedItemIDs: [],
  };
  return { pocketState, deps, cleanupReason, destroyedItemIDs, destroyedScannerProbeIDs, systemID, roomState, extractionNodeTracking, extractionNodeLootContainerItemIDs, destroyedHostileIDs, cleanupSummary };
}

function recordAbyssalArtifactRemoval({}, context, result, category) {
  const { destroyedItemIDs, cleanupSummary } = context;
  if (!result || result.itemID <= 0) {
    return;
  }
  if (result.removed === true) {
    destroyedItemIDs.push(result.itemID);
    if (category === "entranceTrace") {
      cleanupSummary.removedEntranceTraces += 1;
    } else if (category === "originMarker") {
      cleanupSummary.removedRoomMarkers += 1;
    } else if (category === "conduit") {
      cleanupSummary.removedConduits += 1;
    } else if (category === "rewardCache") {
      cleanupSummary.removedRewardCaches += 1;
    } else if (category === "extractionNode") {
      cleanupSummary.removedExtractionNodes += 1;
    } else if (category === "extractionNodeLootContainer") {
      cleanupSummary.removedExtractionNodeLootContainers += 1;
    } else if (category === "sceneryVisual") {
      cleanupSummary.removedSceneryVisuals += 1;
    } else if (category === "environmentalObject") {
      cleanupSummary.removedEnvironmentalObjects += 1;
    }
    return;
  }
  if (result.alreadyGone === true) {
    cleanupSummary.artifactRemovalAttemptsAlreadyGone += 1;
    cleanupSummary.alreadyGoneArtifacts += 1;
    cleanupSummary.alreadyGoneItemIDs.push(result.itemID);
    if (category === "rewardCache") {
      cleanupSummary.rewardCachesAlreadyGone += 1;
    } else if (category === "extractionNode") {
      cleanupSummary.extractionNodesAlreadyGone += 1;
    } else if (category === "extractionNodeLootContainer") {
      cleanupSummary.extractionNodeLootContainersAlreadyGone += 1;
    } else if (category === "sceneryVisual") {
      cleanupSummary.sceneryVisualsAlreadyGone += 1;
    } else if (category === "environmentalObject") {
      cleanupSummary.environmentalObjectsAlreadyGone += 1;
    }
    return;
  }
  if (result.failed === true) {
    cleanupSummary.failedArtifacts += 1;
    cleanupSummary.failedItemIDs.push(result.itemID);
    if (category === "extractionNode") {
      cleanupSummary.failedExtractionNodes += 1;
    }
  }
}

function cleanupAbyssalArtifactProbes({
  cleanupExactAbyssalScannerProbes,
}, context) {
  const { destroyedHostileIDs, destroyedItemIDs, pocketState, deps, cleanupReason, destroyedScannerProbeIDs, cleanupSummary } = context;
  if (destroyedHostileIDs.length > 0) {
    destroyedItemIDs.push(...destroyedHostileIDs);
  }
  const scannerProbeCleanup = cleanupExactAbyssalScannerProbes(
    pocketState,
    deps,
    cleanupReason,
  );
  if (Array.isArray(scannerProbeCleanup.removedEntityIDs)) {
    destroyedScannerProbeIDs.push(...scannerProbeCleanup.removedEntityIDs);
  }
  for (const summaryKey of [
    "removedScannerProbeRecords",
    "removedScannerProbeEntities",
    "scannerProbeEntitiesAlreadyGone",
    "failedScannerProbeCleanup",
    "diagnosticSkippedScannerProbeEntities",
  ]) {
    cleanupSummary[summaryKey] += toInt(
      scannerProbeCleanup && scannerProbeCleanup.cleanupSummary &&
        scannerProbeCleanup.cleanupSummary[summaryKey],
      0,
    );
  }
  return scannerProbeCleanup;
}

function cleanupAbyssalExtractionArtifacts({
  buildAbyssalSceneDescriptor,
  recordAbyssalArtifactRemoval,
  destroyPlaceholderTrace,
}, context) {
  const { pocketState, deps, systemID, extractionNodeTracking, extractionNodeLootContainerItemIDs } = context;
  const pocketSceneDescriptor = buildAbyssalSceneDescriptor(pocketState, deps);
  const pocketRemovalOptions = {
    sceneDescriptor: pocketSceneDescriptor || undefined,
    expectedPocketState: pocketState,
  };
  for (const extractionNodeItemID of extractionNodeTracking.uniqueExtractionNodeIDs) {
    recordAbyssalArtifactRemoval(context,
      destroyPlaceholderTrace(
        systemID,
        extractionNodeItemID,
        deps,
        "pocket-extraction-node-cleanup",
        "extraction node",
        pocketRemovalOptions,
      ),
      "extractionNode",
    );
  }
  for (const extractionNodeLootContainerItemID of extractionNodeLootContainerItemIDs) {
    recordAbyssalArtifactRemoval(context,
      destroyPlaceholderTrace(
        systemID,
        extractionNodeLootContainerItemID,
        deps,
        "pocket-extraction-node-loot-cleanup",
        "extraction node loot container",
        pocketRemovalOptions,
      ),
      "extractionNodeLootContainer",
    );
  }
  return pocketRemovalOptions;
}

function cleanupAbyssalRoomArtifacts({
  listUniquePositiveInts,
  recordAbyssalArtifactRemoval,
  destroyPlaceholderTrace,
  destroyAbyssalSceneryVisualEntity,
}, context, roomEntry) {
  const { pocketState, deps, cleanupReason, systemID, pocketRemovalOptions, cleanupSummary } = context;
  const originMarkerItemID = toInt(roomEntry && roomEntry.originMarkerItemID, 0);
  const conduitItemID = toInt(roomEntry && roomEntry.conduitItemID, 0);
  const cacheItemIDs = listUniquePositiveInts([
    roomEntry && roomEntry.cacheItemID,
    roomEntry && roomEntry.cacheStructureItemID,
    roomEntry && roomEntry.cacheLootContainerItemID,
  ]);
  const sceneryVisualEntityIDs = listUniquePositiveInts(roomEntry && roomEntry.sceneryVisualEntityIDs);
  const sceneryProbeEntityID = toInt(roomEntry && roomEntry.sceneryProbeEntityID, 0);
  const environmentalObjectItemIDs = listUniquePositiveInts(roomEntry && roomEntry.environmentalObjectItemIDs);
  if (originMarkerItemID > 0) {
    recordAbyssalArtifactRemoval(context,
      destroyPlaceholderTrace(
        systemID,
        originMarkerItemID,
        deps,
        "pocket-origin-cleanup",
        "Abyssal trace",
        pocketRemovalOptions,
      ),
      "originMarker",
    );
  }
  if (conduitItemID > 0) {
    recordAbyssalArtifactRemoval(context,
      destroyPlaceholderTrace(
        systemID,
        conduitItemID,
        deps,
        "pocket-exit-cleanup",
        "Abyssal trace",
        pocketRemovalOptions,
      ),
      "conduit",
    );
  }
  if (cacheItemIDs.length > 0) {
    for (const cacheItemID of cacheItemIDs) {
      recordAbyssalArtifactRemoval(context,
        destroyPlaceholderTrace(
          systemID,
          cacheItemID,
          deps,
          "pocket-reward-cache-cleanup",
          "reward cache",
          pocketRemovalOptions,
        ),
        "rewardCache",
      );
    }
  } else if (
    toInt(roomEntry && roomEntry.cacheSpawnedAtMs, 0) > 0 ||
    normalizeText(roomEntry && roomEntry.cacheLifecycleState, "") === "consumed_or_removed"
  ) {
    cleanupSummary.rewardCachesAlreadyGone += 1;
  }
  if (sceneryVisualEntityIDs.length > 0) {
    for (const sceneryVisualEntityID of sceneryVisualEntityIDs) {
      recordAbyssalArtifactRemoval(context,
        destroyAbyssalSceneryVisualEntity(
          pocketState,
          sceneryVisualEntityID,
          deps,
          "pocket-scenery-cleanup",
        ),
        "sceneryVisual",
      );
    }
  } else if (
    toInt(roomEntry && roomEntry.sceneryVisualSpawnedAtMs, 0) > 0 ||
    normalizeText(roomEntry && roomEntry.sceneryVisualLifecycleState, "") === "removed"
  ) {
    cleanupSummary.sceneryVisualsAlreadyGone += 1;
  }
  if (sceneryProbeEntityID > 0) {
    recordAbyssalArtifactRemoval(context,
      destroyAbyssalSceneryVisualEntity(
        pocketState,
        sceneryProbeEntityID,
        deps,
        "pocket-scenery-probe-cleanup",
      ),
      "sceneryVisual",
    );
  } else if (
    toInt(roomEntry && roomEntry.sceneryProbeSpawnedAtMs, 0) > 0 ||
    normalizeText(roomEntry && roomEntry.sceneryProbeLifecycleState, "") === "removed"
  ) {
    cleanupSummary.sceneryVisualsAlreadyGone += 1;
  }
  if (environmentalObjectItemIDs.length > 0) {
    for (const environmentalObjectItemID of environmentalObjectItemIDs) {
      recordAbyssalArtifactRemoval(context,
        destroyPlaceholderTrace(
          systemID,
          environmentalObjectItemID,
          deps,
          normalizeText(cleanupReason, "run-cleanup"),
          "environmental object",
          pocketRemovalOptions,
        ),
        "environmentalObject",
      );
    }
  } else if (
    toInt(roomEntry && roomEntry.environmentalObjectSpawnedAtMs, 0) > 0 ||
    normalizeText(roomEntry && roomEntry.environmentalObjectLifecycleState, "") === "removed"
  ) {
    cleanupSummary.environmentalObjectsAlreadyGone += 1;
  }
}

function cleanupAbyssalEntranceArtifact({
  getActiveTraceState,
  resolveAbyssalTraceProfile,
  isAbyssalSuspectReturnPending,
  isAbyssalReturnProtectionPending,
  normalizeLowerText,
  normalizeAbyssalTraceLifecyclePhase,
  ABYSSAL_TRACE_LIFECYCLE_PHASE,
  recordAbyssalArtifactRemoval,
  removeOwnedSourceTrace,
}, context) {
  const { pocketState, deps, cleanupReason } = context;
  if (toInt(pocketState && pocketState.traceItemID, 0) > 0) {
    const traceState = getActiveTraceState(toInt(pocketState.traceItemID, 0), deps);
    const capturedTraceProfile = resolveAbyssalTraceProfile(traceState);
    const pendingSuspectReturn = isAbyssalSuspectReturnPending(traceState);
    const pendingReturnProtection = isAbyssalReturnProtectionPending(
      traceState,
      null,
      deps,
    );
    const committedTraceReturnPending = Boolean(
      normalizeText(cleanupReason, "") === "final-exit" &&
      pocketState &&
      pocketState.gameplayAuthorityDetached === true &&
      normalizeLowerText(
        pocketState.traceReturnState && pocketState.traceReturnState.status,
        "pending",
      ) !== "completed"
    );
    const preserveReturnedTrace = committedTraceReturnPending || Boolean(
      normalizeText(cleanupReason, "") === "final-exit" &&
      traceState &&
      normalizeAbyssalTraceLifecyclePhase(traceState.lifecyclePhase) ===
        ABYSSAL_TRACE_LIFECYCLE_PHASE.RETURNED &&
      Boolean(capturedTraceProfile || pendingSuspectReturn || pendingReturnProtection)
    );
    if (!preserveReturnedTrace) {
      recordAbyssalArtifactRemoval(context,
        removeOwnedSourceTrace(
          traceState || {
            traceItemID: toInt(pocketState.traceItemID, 0),
            characterID: toInt(pocketState.characterID, 0),
            abyssalRunID: toInt(pocketState.instanceID, 0),
            sourceSolarSystemID: toInt(pocketState.sourceSolarSystemID, 0),
          },
          deps,
          normalizeText(cleanupReason, "run-cleanup"),
        ),
        "entranceTrace",
      );
    }
  }
}

function cleanupAbyssalResidualArtifacts({
  cleanupResidualPocketSpaceItems,
}, context) {
  const { pocketState, deps, destroyedItemIDs, cleanupSummary } = context;
  const residualCleanup = cleanupResidualPocketSpaceItems(
    pocketState,
    deps,
    "pocket-residual-cleanup",
  );
  if (Array.isArray(residualCleanup.removedItemIDs) && residualCleanup.removedItemIDs.length > 0) {
    destroyedItemIDs.push(...residualCleanup.removedItemIDs);
  }
  cleanupSummary.removedResidualSpaceItems += toInt(
    residualCleanup &&
      residualCleanup.cleanupSummary &&
      residualCleanup.cleanupSummary.removedResidualSpaceItems,
    0,
  );
  cleanupSummary.residualSpaceItemsAlreadyGone += toInt(
    residualCleanup &&
      residualCleanup.cleanupSummary &&
      residualCleanup.cleanupSummary.residualSpaceItemsAlreadyGone,
    0,
  );
  cleanupSummary.failedResidualSpaceItems += toInt(
    residualCleanup &&
      residualCleanup.cleanupSummary &&
      residualCleanup.cleanupSummary.failedResidualSpaceItems,
    0,
  );
  cleanupSummary.removedRunScopedCorpses += toInt(
    residualCleanup &&
      residualCleanup.cleanupSummary &&
      residualCleanup.cleanupSummary.removedRunScopedCorpses,
    0,
  );
  cleanupSummary.runScopedCorpsesAlreadyGone += toInt(
    residualCleanup &&
      residualCleanup.cleanupSummary &&
      residualCleanup.cleanupSummary.runScopedCorpsesAlreadyGone,
    0,
  );
  cleanupSummary.failedRunScopedCorpses += toInt(
    residualCleanup &&
      residualCleanup.cleanupSummary &&
      residualCleanup.cleanupSummary.failedRunScopedCorpses,
    0,
  );
  cleanupSummary.removedRunScopedCapsules += toInt(
    residualCleanup &&
      residualCleanup.cleanupSummary &&
      residualCleanup.cleanupSummary.removedRunScopedCapsules,
    0,
  );
  cleanupSummary.runScopedCapsulesAlreadyGone += toInt(
    residualCleanup &&
      residualCleanup.cleanupSummary &&
      residualCleanup.cleanupSummary.runScopedCapsulesAlreadyGone,
    0,
  );
  cleanupSummary.failedRunScopedCapsules += toInt(
    residualCleanup &&
      residualCleanup.cleanupSummary &&
      residualCleanup.cleanupSummary.failedRunScopedCapsules,
    0,
  );
  cleanupSummary.diagnosticSkippedResidualSpaceItems += toInt(
    residualCleanup &&
      residualCleanup.cleanupSummary &&
      residualCleanup.cleanupSummary.diagnosticSkippedResidualSpaceItems,
    0,
  );
}

function destroyPocketArtifacts({
  buildAbyssalArtifactCleanupContext,
  cleanupAbyssalArtifactProbes,
  cleanupAbyssalExtractionArtifacts,
  cleanupAbyssalRoomArtifacts,
  cleanupAbyssalEntranceArtifact,
  cleanupAbyssalResidualArtifacts,
  cloneValue,
}, pocketState, deps, cleanupReason = "run-cleanup") {
  const context = buildAbyssalArtifactCleanupContext(pocketState, deps, cleanupReason);
  context.scannerProbeCleanup = cleanupAbyssalArtifactProbes(context);
  context.pocketRemovalOptions = cleanupAbyssalExtractionArtifacts(context);
  for (const roomEntry of Object.values(context.roomState.roomStatesByIndex || {})) {
    cleanupAbyssalRoomArtifacts(context, roomEntry);
  }
  cleanupAbyssalEntranceArtifact(context);
  cleanupAbyssalResidualArtifacts(context);
  const { destroyedItemIDs, destroyedScannerProbeIDs, destroyedHostileIDs, cleanupSummary, scannerProbeCleanup } = context;
  return {
    destroyedItemIDs,
    destroyedScannerProbeIDs,
    destroyedHostileIDs,
    cleanupSummary,
    scannerProbeDiagnostics: cloneValue(scannerProbeCleanup.diagnostics || []),
  };
}

// Capture supplied capabilities once, as the original closure did. Internal
// callbacks are bound once per instance; no runtime state lives in this wiring.
function createAbyssalArtifactCleanup({
  getDependencies,
  getResolvedWeatherState,
  listAllPocketHostileEntityIDs,
  buildPlaceholderRoomState,
  listUniquePositiveInts,
  log,
  destroyPocketEncounterEntities,
  cleanupExactAbyssalScannerProbes,
  buildAbyssalSceneDescriptor,
  destroyPlaceholderTrace,
  destroyAbyssalSceneryVisualEntity,
  getActiveTraceState,
  resolveAbyssalTraceProfile,
  isAbyssalSuspectReturnPending,
  isAbyssalReturnProtectionPending,
  normalizeLowerText,
  normalizeAbyssalTraceLifecyclePhase,
  ABYSSAL_TRACE_LIFECYCLE_PHASE,
  removeOwnedSourceTrace,
  cleanupResidualPocketSpaceItems,
  cloneValue,
}) {

  const ports = {
    getDependencies,
    getResolvedWeatherState,
    listAllPocketHostileEntityIDs,
    buildPlaceholderRoomState,
    listUniquePositiveInts,
    log,
    destroyPocketEncounterEntities,
    cleanupExactAbyssalScannerProbes,
    buildAbyssalSceneDescriptor,
    destroyPlaceholderTrace,
    destroyAbyssalSceneryVisualEntity,
    getActiveTraceState,
    resolveAbyssalTraceProfile,
    isAbyssalSuspectReturnPending,
    isAbyssalReturnProtectionPending,
    normalizeLowerText,
    normalizeAbyssalTraceLifecyclePhase,
    ABYSSAL_TRACE_LIFECYCLE_PHASE,
    removeOwnedSourceTrace,
    cleanupResidualPocketSpaceItems,
    cloneValue,
  };
  ports.createEmptyAbyssalArtifactInventory = createEmptyAbyssalArtifactInventory.bind(null, ports);
  ports.collectAbyssalArtifactInventory = collectAbyssalArtifactInventory.bind(null, ports);
  ports.buildExtractionNodeCleanupTracking = buildExtractionNodeCleanupTracking.bind(null, ports);
  ports.buildAbyssalArtifactCleanupContext = buildAbyssalArtifactCleanupContext.bind(null, ports);
  ports.recordAbyssalArtifactRemoval = recordAbyssalArtifactRemoval.bind(null, ports);
  ports.cleanupAbyssalArtifactProbes = cleanupAbyssalArtifactProbes.bind(null, ports);
  ports.cleanupAbyssalExtractionArtifacts = cleanupAbyssalExtractionArtifacts.bind(null, ports);
  ports.cleanupAbyssalRoomArtifacts = cleanupAbyssalRoomArtifacts.bind(null, ports);
  ports.cleanupAbyssalEntranceArtifact = cleanupAbyssalEntranceArtifact.bind(null, ports);
  ports.cleanupAbyssalResidualArtifacts = cleanupAbyssalResidualArtifacts.bind(null, ports);
  ports.destroyPocketArtifacts = destroyPocketArtifacts.bind(null, ports);
  Object.freeze(ports);
  return { collectAbyssalArtifactInventory: ports.collectAbyssalArtifactInventory, buildExtractionNodeCleanupTracking: ports.buildExtractionNodeCleanupTracking, destroyPocketArtifacts: ports.destroyPocketArtifacts };
}

module.exports = { createAbyssalArtifactCleanup };
