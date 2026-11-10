"use strict";

const { normalizeText } = require("../domain/abyssalValueUtils");

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

// Transfer content uses the already selected room and exact cleanup authorities.
// No run state is owned here; the caller retains transition commit/recovery ordering.
function buildAbyssalTransferDestinationRoomEntry({
  buildRoomShipSpawnState,
  resolveRoomOriginPosition,
  listUniquePositiveInts,
  getObjectPosition,
},
  pocketState,
  nextRoomIndex,
  nextRoomEntry,
  nextRoomPrewarmed,
  deps,
) {
  return {
    ...nextRoomEntry,
    enteredAtMs: toInt(deps.now(), 0),
    shipSpawnState: buildRoomShipSpawnState(pocketState, nextRoomIndex),
    roomOriginPosition: resolveRoomOriginPosition(pocketState, nextRoomIndex),
    hostileEntityIDs: nextRoomPrewarmed
      ? listUniquePositiveInts(nextRoomEntry.hostileEntityIDs)
      : [],
    cacheItemID: toInt(nextRoomEntry.cacheItemID, 0),
    cacheStructureItemID: toInt(nextRoomEntry.cacheStructureItemID, 0),
    cacheLootContainerItemID: toInt(nextRoomEntry.cacheLootContainerItemID, 0),
    cacheRewardMaterialized: nextRoomEntry.cacheRewardMaterialized === true,
    cacheSpawnedAtMs: toInt(nextRoomEntry.cacheSpawnedAtMs, 0),
    cacheLifecycleState: normalizeText(nextRoomEntry.cacheLifecycleState, ""),
    unavailableReason: normalizeText(nextRoomEntry.unavailableReason, ""),
    suppressedReason: normalizeText(nextRoomEntry.suppressedReason, ""),
    extractionNodeItemIDs: listUniquePositiveInts(nextRoomEntry.extractionNodeItemIDs),
    extractionNodeHistoricalItemIDs: listUniquePositiveInts(nextRoomEntry.extractionNodeHistoricalItemIDs),
    extractionNodeLootContainerItemIDs: listUniquePositiveInts(nextRoomEntry.extractionNodeLootContainerItemIDs),
    extractionNodeRewardMaterializedItemIDs: listUniquePositiveInts(nextRoomEntry.extractionNodeRewardMaterializedItemIDs),
    extractionNodeSpawnedAtMs: toInt(nextRoomEntry.extractionNodeSpawnedAtMs, 0),
    extractionNodeLifecycleState: normalizeText(nextRoomEntry.extractionNodeLifecycleState, ""),
    extractionNodeProfileID: normalizeText(nextRoomEntry.extractionNodeProfileID, ""),
    conduitItemID: nextRoomPrewarmed ? toInt(nextRoomEntry.conduitItemID, 0) : 0,
    originMarkerItemID: nextRoomPrewarmed ? toInt(nextRoomEntry.originMarkerItemID, 0) : 0,
    objectiveComplete: nextRoomEntry.objectiveComplete === true,
    objectiveCompletedAtMs: toInt(nextRoomEntry.objectiveCompletedAtMs, 0),
    prewarmedAtMs: toInt(nextRoomEntry.prewarmedAtMs, 0),
    sceneryVisualEntityIDs: nextRoomPrewarmed
      ? listUniquePositiveInts(nextRoomEntry.sceneryVisualEntityIDs)
      : [],
    sceneryVisualTypeIDs: nextRoomPrewarmed
      ? listUniquePositiveInts(nextRoomEntry.sceneryVisualTypeIDs)
      : [],
    sceneryVisualProfileID: nextRoomPrewarmed
      ? normalizeText(nextRoomEntry.sceneryVisualProfileID, "")
      : "",
    sceneryVisualSpawnedAtMs: nextRoomPrewarmed
      ? toInt(nextRoomEntry.sceneryVisualSpawnedAtMs, 0)
      : 0,
    sceneryVisualLifecycleState: nextRoomPrewarmed
      ? normalizeText(nextRoomEntry.sceneryVisualLifecycleState, "")
      : "",
    sceneryVisualBlockReason: nextRoomPrewarmed
      ? normalizeText(nextRoomEntry.sceneryVisualBlockReason, "")
      : "",
    sceneryProbeEntityID: nextRoomPrewarmed ? toInt(nextRoomEntry.sceneryProbeEntityID, 0) : 0,
    sceneryProbeTypeID: nextRoomPrewarmed ? toInt(nextRoomEntry.sceneryProbeTypeID, 0) : 0,
    sceneryProbeTypeName: nextRoomPrewarmed
      ? normalizeText(nextRoomEntry.sceneryProbeTypeName, "")
      : "",
    sceneryProbeCandidateKey: nextRoomPrewarmed
      ? normalizeText(nextRoomEntry.sceneryProbeCandidateKey, "")
      : "",
    sceneryProbePresetKey: nextRoomPrewarmed
      ? normalizeText(nextRoomEntry.sceneryProbePresetKey, "")
      : "",
    sceneryProbeProfileID: nextRoomPrewarmed
      ? normalizeText(nextRoomEntry.sceneryProbeProfileID, "")
      : "",
    sceneryProbeSpawnedAtMs: nextRoomPrewarmed
      ? toInt(nextRoomEntry.sceneryProbeSpawnedAtMs, 0)
      : 0,
    sceneryProbeLifecycleState: nextRoomPrewarmed
      ? normalizeText(nextRoomEntry.sceneryProbeLifecycleState, "")
      : "",
    sceneryProbeBlockReason: nextRoomPrewarmed
      ? normalizeText(nextRoomEntry.sceneryProbeBlockReason, "")
      : "",
    sceneryProbePosition: nextRoomPrewarmed
      ? getObjectPosition(nextRoomEntry.sceneryProbePosition)
      : null,
    sceneryProbeOrdinal: nextRoomPrewarmed
      ? Math.max(0, toInt(nextRoomEntry.sceneryProbeOrdinal, 0))
      : 0,
    sceneryProbePreviousEntityID: nextRoomPrewarmed
      ? toInt(nextRoomEntry.sceneryProbePreviousEntityID, 0)
      : 0,
    sceneryProbeAddBallsSent: nextRoomPrewarmed &&
      nextRoomEntry.sceneryProbeAddBallsSent === true,
  };
}

function removeAbyssalTransferSourceArtifacts({
  destroyPlaceholderTrace,
  listUniquePositiveInts,
  destroyRoomExtractionNodes,
  destroyRoomExtractionNodeLootContainers,
  destroyAbyssalSceneryVisualEntity,
  despawnAbyssalEnvironmentalObjectEntity,
},
  pocketState, currentRoomIndex, currentRoomEntry, isolatedSceneDescriptor, deps,
) {
  let originCleanupResult = null;
  if (toInt(currentRoomEntry.originMarkerItemID, 0) > 0) {
    originCleanupResult = destroyPlaceholderTrace(
      pocketState.solarSystemID,
      currentRoomEntry.originMarkerItemID,
      deps,
      "room-transfer-origin-cleanup",
      "room origin marker",
      {
        broadcast: !isolatedSceneDescriptor,
        sceneDescriptor: isolatedSceneDescriptor || undefined,
      },
    );
  }
  let conduitCleanupResult = null;
  if (toInt(currentRoomEntry.conduitItemID, 0) > 0) {
    conduitCleanupResult = destroyPlaceholderTrace(
      pocketState.solarSystemID,
      currentRoomEntry.conduitItemID,
      deps,
      "room-transfer-conduit-cleanup",
      "room transfer conduit",
      {
        broadcast: !isolatedSceneDescriptor,
        sceneDescriptor: isolatedSceneDescriptor || undefined,
      },
    );
  }
  const cacheCleanupResults = listUniquePositiveInts([
    currentRoomEntry.cacheItemID,
    currentRoomEntry.cacheStructureItemID,
    currentRoomEntry.cacheLootContainerItemID,
    currentRoomEntry.cacheRewardRetryIntent &&
      currentRoomEntry.cacheRewardRetryIntent.retainedContainerItemID,
    ...Object.values(
      currentRoomEntry.extractionNodeRewardRetryIntentsByItemID || {},
    ).map((intent) => toInt(intent && intent.retainedContainerItemID, 0)),
    ...listUniquePositiveInts(currentRoomEntry.rewardSuppressionPendingRemovalItemIDs),
  ]).map((itemID) => destroyPlaceholderTrace(
    pocketState.solarSystemID,
    itemID,
    deps,
    "room-transfer-cache-cleanup",
    "reward cache",
    {
      broadcast: !isolatedSceneDescriptor,
      sceneDescriptor: isolatedSceneDescriptor || undefined,
    },
  ));
  const extractionNodeCleanupResults = destroyRoomExtractionNodes(
    pocketState,
    currentRoomIndex,
    deps,
    "room-transfer-extraction-node-cleanup",
    { broadcast: !isolatedSceneDescriptor },
  );
  const extractionNodeLootCleanupResults = destroyRoomExtractionNodeLootContainers(
    pocketState,
    currentRoomIndex,
    deps,
    "room-transfer-extraction-node-loot-cleanup",
    { broadcast: !isolatedSceneDescriptor },
  );
  const sceneryVisualCleanupResults = listUniquePositiveInts(
    currentRoomEntry && currentRoomEntry.sceneryVisualEntityIDs,
  ).map((entityID) => destroyAbyssalSceneryVisualEntity(
    pocketState,
    entityID,
    deps,
    "room-transfer-scenery-cleanup",
    { broadcast: !isolatedSceneDescriptor },
  ));
  const environmentalObjectCleanupResults = listUniquePositiveInts(
    currentRoomEntry && currentRoomEntry.environmentalObjectItemIDs,
  ).map((itemID) => despawnAbyssalEnvironmentalObjectEntity(
    pocketState,
    itemID,
    deps,
    "room-transition",
  ));
  const sceneryProbeCleanupResult = toInt(currentRoomEntry && currentRoomEntry.sceneryProbeEntityID, 0) > 0
    ? destroyAbyssalSceneryVisualEntity(
      pocketState,
      currentRoomEntry.sceneryProbeEntityID,
      deps,
      "room-transfer-scenery-probe-cleanup",
      { broadcast: !isolatedSceneDescriptor },
    )
    : null;
  return {
    originCleanupResult,
    conduitCleanupResult,
    cacheCleanupResults,
    extractionNodeCleanupResults,
    extractionNodeLootCleanupResults,
    sceneryVisualCleanupResults,
    environmentalObjectCleanupResults,
    sceneryProbeCleanupResult,
  };
}

function buildAbyssalRetiredTransferRoomEntry({
  listUniquePositiveInts,
  listPositiveInts,
  cloneValue,
  getObjectPosition,
}, currentRoomEntry, cleanupResults) {
  const {
    originCleanupResult,
    conduitCleanupResult,
    cacheCleanupResults,
    extractionNodeCleanupResults,
    extractionNodeLootCleanupResults,
    sceneryVisualCleanupResults,
    environmentalObjectCleanupResults,
    sceneryProbeCleanupResult,
  } = cleanupResults;
  return {
    ...currentRoomEntry,
    originMarkerItemID: originCleanupResult && originCleanupResult.failed === true
      ? toInt(currentRoomEntry.originMarkerItemID, 0)
      : 0,
    conduitItemID: conduitCleanupResult && conduitCleanupResult.failed === true
      ? toInt(currentRoomEntry.conduitItemID, 0)
      : 0,
    cacheItemID: cacheCleanupResults.some((result) => result && result.failed === true)
      ? toInt(currentRoomEntry.cacheItemID, 0)
      : 0,
    cacheStructureItemID: cacheCleanupResults.some((result) => result && result.failed === true)
      ? toInt(currentRoomEntry.cacheStructureItemID, 0)
      : 0,
    cacheLootContainerItemID: cacheCleanupResults.some((result) => result && result.failed === true)
      ? toInt(currentRoomEntry.cacheLootContainerItemID, 0)
      : 0,
    cacheLifecycleState: cacheCleanupResults.length > 0
      ? "room_transfer_removed"
      : normalizeText(currentRoomEntry.cacheLifecycleState, ""),
    extractionNodeItemIDs: extractionNodeCleanupResults
      .filter((result) => result && result.failed === true)
      .map((result) => toInt(result.itemID, 0)),
    extractionNodeLootContainerItemIDs: extractionNodeLootCleanupResults
      .filter((result) => result && result.failed === true)
      .map((result) => toInt(result.itemID, 0)),
    sceneryVisualEntityIDs: sceneryVisualCleanupResults
      .filter((result) => result && result.failed === true)
      .map((result) => toInt(result.itemID, 0)),
    sceneryVisualTypeIDs: sceneryVisualCleanupResults.some((result) => result && result.failed === true)
      ? listUniquePositiveInts(currentRoomEntry.sceneryVisualTypeIDs)
      : [],
    sceneryVisualLifecycleState: listUniquePositiveInts(currentRoomEntry.sceneryVisualEntityIDs).length > 0
      ? "removed"
      : normalizeText(currentRoomEntry.sceneryVisualLifecycleState, ""),
    environmentalObjectItemIDs: listUniquePositiveInts(
      currentRoomEntry.environmentalObjectItemIDs,
    ),
    environmentalObjectTypeIDs: listPositiveInts(
      currentRoomEntry.environmentalObjectTypeIDs,
    ),
    environmentalObjectProfileIDs: cloneValue(
      currentRoomEntry.environmentalObjectProfileIDs,
    ),
    environmentalObjectLifecycleState:
      listUniquePositiveInts(currentRoomEntry.environmentalObjectItemIDs).length > 0
        ? environmentalObjectCleanupResults.some((result) => result && result.failed === true)
          ? "runtime_remove_failed"
          : "runtime_removed"
        : normalizeText(currentRoomEntry.environmentalObjectLifecycleState, ""),
    sceneryProbeEntityID: sceneryProbeCleanupResult && sceneryProbeCleanupResult.failed === true
      ? toInt(currentRoomEntry.sceneryProbeEntityID, 0)
      : 0,
    sceneryProbeTypeID: sceneryProbeCleanupResult && sceneryProbeCleanupResult.failed === true
      ? toInt(currentRoomEntry.sceneryProbeTypeID, 0)
      : 0,
    sceneryProbeTypeName: sceneryProbeCleanupResult && sceneryProbeCleanupResult.failed === true
      ? normalizeText(currentRoomEntry.sceneryProbeTypeName, "")
      : "",
    sceneryProbeCandidateKey: sceneryProbeCleanupResult && sceneryProbeCleanupResult.failed === true
      ? normalizeText(currentRoomEntry.sceneryProbeCandidateKey, "")
      : "",
    sceneryProbePresetKey: sceneryProbeCleanupResult && sceneryProbeCleanupResult.failed === true
      ? normalizeText(currentRoomEntry.sceneryProbePresetKey, "")
      : "",
    sceneryProbeProfileID: sceneryProbeCleanupResult && sceneryProbeCleanupResult.failed === true
      ? normalizeText(currentRoomEntry.sceneryProbeProfileID, "")
      : "",
    sceneryProbeSpawnedAtMs: sceneryProbeCleanupResult && sceneryProbeCleanupResult.failed === true
      ? toInt(currentRoomEntry.sceneryProbeSpawnedAtMs, 0)
      : toInt(currentRoomEntry && currentRoomEntry.sceneryProbeSpawnedAtMs, 0),
    sceneryProbeLifecycleState: toInt(currentRoomEntry && currentRoomEntry.sceneryProbeEntityID, 0) > 0
      ? "removed"
      : normalizeText(currentRoomEntry.sceneryProbeLifecycleState, ""),
    sceneryProbeBlockReason: sceneryProbeCleanupResult && sceneryProbeCleanupResult.failed === true
      ? normalizeText(currentRoomEntry.sceneryProbeBlockReason, "")
      : "",
    sceneryProbePosition: sceneryProbeCleanupResult && sceneryProbeCleanupResult.failed === true
      ? getObjectPosition(currentRoomEntry.sceneryProbePosition)
      : null,
    sceneryProbeOrdinal: Math.max(0, toInt(currentRoomEntry && currentRoomEntry.sceneryProbeOrdinal, 0)),
    sceneryProbePreviousEntityID: sceneryProbeCleanupResult && sceneryProbeCleanupResult.failed === true
      ? toInt(currentRoomEntry.sceneryProbePreviousEntityID, 0)
      : toInt(currentRoomEntry && currentRoomEntry.sceneryProbeEntityID, 0),
    sceneryProbeAddBallsSent: sceneryProbeCleanupResult && sceneryProbeCleanupResult.failed === true
      ? currentRoomEntry && currentRoomEntry.sceneryProbeAddBallsSent === true
      : false,
    deliveredEntityIDs: [],
    controllerDependantLifecycleGroups: [],
    dependantInactiveNpcItemIDs: [],
    destroyedDependantNpcItemIDs: [],
    deliveredAtMs: toInt(currentRoomEntry.deliveredAtMs, 0),
    extractionNodeLifecycleState: listUniquePositiveInts(currentRoomEntry.extractionNodeItemIDs).length > 0
      ? "room_transfer_removed"
      : normalizeText(currentRoomEntry.extractionNodeLifecycleState, ""),
  };
}

function cleanAbyssalTransferSourceRoom({
  setAbyssalRoomEntityDeliveryState,
  getActivePocketStateByInstanceID,
  ABYSSAL_ROOM_DELIVERY_STATE,
  removeAbyssalTransferSourceArtifacts,
  removeRetiredAbyssalRoomRuntimeResidue,
  log,
  setPlaceholderRoomEntry,
  buildAbyssalRetiredTransferRoomEntry,
  logAbyssalRoomContentCleaned,
  cloneValue,
}, {
  pocketState, currentRoomIndex, currentRoomEntry, isolatedSceneDescriptor,
  session, deps, oldRoomEntityIDs, recordTransferPhase,
}) {

  if (isolatedSceneDescriptor) {
    setAbyssalRoomEntityDeliveryState(
      getActivePocketStateByInstanceID(toInt(pocketState.instanceID, 0)) || pocketState,
      currentRoomIndex,
      ABYSSAL_ROOM_DELIVERY_STATE.RETIRED,
      session,
      deps,
      {
        transitionToken: toInt(
          pocketState && pocketState.pendingTransitionState && pocketState.pendingTransitionState.token,
          0,
        ),
      },
    );
  }

  const cleanupResults = removeAbyssalTransferSourceArtifacts(
    pocketState, currentRoomIndex, currentRoomEntry, isolatedSceneDescriptor, deps,
  );

  const residualCleanupPocketState =
    getActivePocketStateByInstanceID(toInt(pocketState.instanceID, 0)) || pocketState;
  const residualCleanupResult = removeRetiredAbyssalRoomRuntimeResidue(
    residualCleanupPocketState,
    currentRoomIndex,
    deps,
  );
  log.info(
    `[AbyssalRoomRetirement] run=${toInt(residualCleanupPocketState.instanceID, 0)} ` +
      `room=${currentRoomIndex} removeBallsEntityCount=${oldRoomEntityIDs.length} ` +
      `residualAttemptedCount=${residualCleanupResult.attemptedIDs.length} ` +
      `residualRemovedCount=${residualCleanupResult.removedIDs.length} ` +
      `remainingRuntimeCount=${residualCleanupResult.remainingIDs.length} ` +
      `remainingIDs=${residualCleanupResult.remainingIDs.slice(0, 10).join(",") || "none"} ` +
      `status=${residualCleanupResult.remainingIDs.length === 0 ? "complete" : "failed"}`,
  );

  const roomStateAfterCurrentCleanup = setPlaceholderRoomEntry(
    pocketState,
    currentRoomIndex,
    buildAbyssalRetiredTransferRoomEntry(currentRoomEntry, cleanupResults),
  );
  logAbyssalRoomContentCleaned(
    {
      ...cloneValue(pocketState),
      roomState: roomStateAfterCurrentCleanup,
    },
    {
      roomIndex: currentRoomIndex,
      existingOnly: true,
    },
  );
  recordTransferPhase("source-room-cleaned", {
    removedRuntimeEntities: residualCleanupResult.removedIDs.length,
    remainingRuntimeEntities: residualCleanupResult.remainingIDs.length,
  });
  return {
    success: true,
    residualCleanupResult,
    roomStateAfterCurrentCleanup,
  };
}

function prepareAbyssalTransferDestinationContent({
  setPlaceholderRoomEntry,
  cloneValue,
  buildAbyssalTransferDestinationRoomEntry,
  buildPocketStateForCurrentRoom,
  getActivePocketStateByInstanceID,
  getAbyssalParticipantRecord,
  upsertAbyssalParticipantRosterEntry,
  ABYSSAL_PARTICIPANT_STATUS,
  updatePocketState,
  listUniquePositiveInts,
  getContentProfile,
  isSupportedAbyssalContentTier,
  hasTerminalFailureOutcome,
  ensurePlaceholderRewardCache,
  logAbyssalRoomContentPrepared,
  spawnPlaceholderPocketContent,
  settleFailedAbyssalDestinationActivation,
}, {
  pocketState, roomStateAfterCurrentCleanup, nextRoomIndex, nextRoomEntry,
  nextRoomPrewarmed, nextRoomEncounterState, validation, movedShip,
  currentRoomIndex, isolatedSceneDescriptor, session, deps, recordTransferPhase,
}) {
  const nextRoomState = setPlaceholderRoomEntry(
    {
      ...cloneValue(pocketState),
      roomState: roomStateAfterCurrentCleanup,
    },
    nextRoomIndex,
    {
      ...buildAbyssalTransferDestinationRoomEntry(
        pocketState, nextRoomIndex, nextRoomEntry, nextRoomPrewarmed, deps,
      ),
      deliveredEntityIDs: [],
      deliveredAtMs: 0,
    },
    {
      currentRoomIndex: nextRoomIndex,
      finalExitAvailable: false,
    },
  );
  const nextPocketState = buildPocketStateForCurrentRoom(
    {
      ...cloneValue(pocketState),
      roomState: roomStateAfterCurrentCleanup,
    },
    nextRoomState,
  );
  const latestTransferPocketState =
    getActivePocketStateByInstanceID(pocketState.instanceID) || pocketState;
  const activatingParticipant = getAbyssalParticipantRecord(
    latestTransferPocketState,
    validation.data.context.characterID,
  );
  const transferredParticipantRoster = upsertAbyssalParticipantRosterEntry(
    latestTransferPocketState,
    {
      ...cloneValue(activatingParticipant || {}),
      characterID: validation.data.context.characterID,
      shipID: movedShip.itemID,
      status: ABYSSAL_PARTICIPANT_STATUS.ACTIVE,
      currentRoomIndex: nextRoomIndex,
      lastSeenAtMs: toInt(deps.now(), Date.now()),
    },
  );

  const updatedPocketState = updatePocketState(pocketState.instanceID, {
    ...nextPocketState,
    pendingTransitionState: cloneValue(latestTransferPocketState.pendingTransitionState),
    shipID: validation.data.context.characterID === toInt(pocketState.characterID, 0)
      ? movedShip.itemID
      : pocketState.shipID,
    participantRoster: transferredParticipantRoster,
    encounterState: cloneValue(nextRoomEncounterState),
    hostileEntityIDs: nextRoomPrewarmed
      ? listUniquePositiveInts(nextRoomEntry.hostileEntityIDs)
      : [],
    objectiveComplete: nextRoomPrewarmed && nextRoomEntry.objectiveComplete === true,
    objectiveCompletedAtMs: nextRoomPrewarmed
      ? toInt(nextRoomEntry.objectiveCompletedAtMs, 0)
      : 0,
    allowDebugExit: nextRoomEncounterState && nextRoomEncounterState.allowDebugExit === true,
    originMarkerItemID: nextRoomPrewarmed ? toInt(nextRoomEntry.originMarkerItemID, 0) : 0,
    exitMarkerItemID: nextRoomPrewarmed ? toInt(nextRoomEntry.conduitItemID, 0) : 0,
    rewardState: null,
  }) || nextPocketState;
  let contentResult = null;
  if (nextRoomPrewarmed) {
    const prewarmedContentProfile = getContentProfile(updatedPocketState);
    const prewarmedRewardResult =
      isSupportedAbyssalContentTier(prewarmedContentProfile) &&
      !hasTerminalFailureOutcome(updatedPocketState)
        ? ensurePlaceholderRewardCache(updatedPocketState, session, deps, {
          allowBeforeObjective: true,
          roomIndex: nextRoomIndex,
          broadcast: !isolatedSceneDescriptor,
        })
        : null;
    contentResult = {
      success: true,
      data: prewarmedRewardResult && prewarmedRewardResult.data
        ? prewarmedRewardResult.data
        : cloneValue(updatedPocketState),
    };
    logAbyssalRoomContentPrepared(contentResult.data, {
      roomIndex: nextRoomIndex,
      active: true,
      prewarmed: true,
    });
  } else {
    contentResult = spawnPlaceholderPocketContent(null, updatedPocketState, session, deps);
  }
  const effectivePocketState =
    contentResult && contentResult.data
      ? contentResult.data
      : getActivePocketStateByInstanceID(pocketState.instanceID) || updatedPocketState;
  if (
    !contentResult ||
    contentResult.success !== true ||
    contentResult.partial === true ||
    !contentResult.data
  ) {
    return settleFailedAbyssalDestinationActivation(
      effectivePocketState,
      session,
      deps,
      "ABYSSAL_DESTINATION_CONTENT_NOT_READY",
      {
        sourceRoomIndex: currentRoomIndex,
        destinationRoomIndex: nextRoomIndex,
        contentErrors: cloneValue(contentResult && contentResult.errors || []),
      },
    );
  }
  recordTransferPhase("destination-state-ready");
  return { success: true, effectivePocketState };
}

// Capture supplied capabilities once, as the original closure did. Internal
// callbacks are bound once per instance; no runtime state lives in this wiring.
function createAbyssalRoomTransferContent({
  buildRoomShipSpawnState,
  resolveRoomOriginPosition,
  listUniquePositiveInts,
  getObjectPosition,
  destroyPlaceholderTrace,
  destroyRoomExtractionNodes,
  destroyRoomExtractionNodeLootContainers,
  destroyAbyssalSceneryVisualEntity,
  despawnAbyssalEnvironmentalObjectEntity,
  listPositiveInts,
  cloneValue,
  setAbyssalRoomEntityDeliveryState,
  getActivePocketStateByInstanceID,
  ABYSSAL_ROOM_DELIVERY_STATE,
  removeRetiredAbyssalRoomRuntimeResidue,
  log,
  setPlaceholderRoomEntry,
  logAbyssalRoomContentCleaned,
  buildPocketStateForCurrentRoom,
  getAbyssalParticipantRecord,
  upsertAbyssalParticipantRosterEntry,
  ABYSSAL_PARTICIPANT_STATUS,
  updatePocketState,
  getContentProfile,
  isSupportedAbyssalContentTier,
  hasTerminalFailureOutcome,
  ensurePlaceholderRewardCache,
  logAbyssalRoomContentPrepared,
  spawnPlaceholderPocketContent,
  settleFailedAbyssalDestinationActivation,
}) {

  const ports = {
    buildRoomShipSpawnState,
    resolveRoomOriginPosition,
    listUniquePositiveInts,
    getObjectPosition,
    destroyPlaceholderTrace,
    destroyRoomExtractionNodes,
    destroyRoomExtractionNodeLootContainers,
    destroyAbyssalSceneryVisualEntity,
    despawnAbyssalEnvironmentalObjectEntity,
    listPositiveInts,
    cloneValue,
    setAbyssalRoomEntityDeliveryState,
    getActivePocketStateByInstanceID,
    ABYSSAL_ROOM_DELIVERY_STATE,
    removeRetiredAbyssalRoomRuntimeResidue,
    log,
    setPlaceholderRoomEntry,
    logAbyssalRoomContentCleaned,
    buildPocketStateForCurrentRoom,
    getAbyssalParticipantRecord,
    upsertAbyssalParticipantRosterEntry,
    ABYSSAL_PARTICIPANT_STATUS,
    updatePocketState,
    getContentProfile,
    isSupportedAbyssalContentTier,
    hasTerminalFailureOutcome,
    ensurePlaceholderRewardCache,
    logAbyssalRoomContentPrepared,
    spawnPlaceholderPocketContent,
    settleFailedAbyssalDestinationActivation,
  };
  ports.buildAbyssalTransferDestinationRoomEntry = buildAbyssalTransferDestinationRoomEntry.bind(null, ports);
  ports.removeAbyssalTransferSourceArtifacts = removeAbyssalTransferSourceArtifacts.bind(null, ports);
  ports.buildAbyssalRetiredTransferRoomEntry = buildAbyssalRetiredTransferRoomEntry.bind(null, ports);
  ports.cleanAbyssalTransferSourceRoom = cleanAbyssalTransferSourceRoom.bind(null, ports);
  ports.prepareAbyssalTransferDestinationContent = prepareAbyssalTransferDestinationContent.bind(null, ports);
  Object.freeze(ports);
  return {
    buildAbyssalTransferDestinationRoomEntry: ports.buildAbyssalTransferDestinationRoomEntry,
    cleanAbyssalTransferSourceRoom: ports.cleanAbyssalTransferSourceRoom,
    prepareAbyssalTransferDestinationContent: ports.prepareAbyssalTransferDestinationContent,
  };
}

module.exports = { createAbyssalRoomTransferContent };
