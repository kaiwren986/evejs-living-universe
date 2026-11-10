"use strict";

const { normalizeText } = require("../domain/abyssalValueUtils");

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

// Reward lifecycle transitions and persisted retry dispatch. This factory keeps
// no run state; injected owners retain persistence, physical I/O and terminal authority.
function retryPendingAbyssalRewardMaterializations({
  getDependencies,
  getActivePocketStateByInstanceID,
  getPlaceholderRoomEntry,
  cloneValue,
  retryCacheReward,
  retryExtractionReward,
  ensureAbyssalPocketPersistenceReady,
  refreshAbyssalDungeonTrackingState,
},
  pocketState,
  roomIndex,
  deps = getDependencies(),
) {
  let currentPocketState = getActivePocketStateByInstanceID(
    toInt(pocketState && pocketState.instanceID, 0),
  ) || pocketState;
  if (!currentPocketState) {
    return { success: false, attempted: false, errorMsg: "POCKET_STATE_MISSING" };
  }
  const attempt = {
    currentPocketState,
    attempted: false,
    allSuccessful: true,
    roomEntry: getPlaceholderRoomEntry(currentPocketState, roomIndex),
  };
  const cacheIntent = attempt.roomEntry.cacheRewardRetryIntent &&
    typeof attempt.roomEntry.cacheRewardRetryIntent === "object"
      ? cloneValue(attempt.roomEntry.cacheRewardRetryIntent)
      : null;
  if (cacheIntent && toInt(cacheIntent.sourceStructureItemID, 0) > 0) {
    const result = retryCacheReward(attempt, roomIndex, deps, cacheIntent);
    if (result !== undefined) return result;
  }


  attempt.roomEntry = getPlaceholderRoomEntry(attempt.currentPocketState, roomIndex);
  const extractionIntents = attempt.roomEntry.extractionNodeRewardRetryIntentsByItemID &&
    typeof attempt.roomEntry.extractionNodeRewardRetryIntentsByItemID === "object"
      ? cloneValue(attempt.roomEntry.extractionNodeRewardRetryIntentsByItemID)
      : {};
  for (const sourceKey of Object.keys(extractionIntents).sort((left, right) => (
    toInt(left, 0) - toInt(right, 0)
  ))) {
    const retryIntent = extractionIntents[sourceKey];
    const sourceStructureItemID = toInt(
      retryIntent && retryIntent.sourceStructureItemID,
      toInt(sourceKey, 0),
    );
    if (!retryIntent || sourceStructureItemID <= 0) {
      continue;
    }
    const result = retryExtractionReward(attempt, roomIndex, deps, retryIntent, sourceStructureItemID, sourceKey);
    if (result !== undefined) return result;
  }


  if (attempt.attempted) {
    ensureAbyssalPocketPersistenceReady(attempt.currentPocketState, deps);
    refreshAbyssalDungeonTrackingState(
      attempt.currentPocketState,
      deps,
      attempt.allSuccessful ? "reward_retry_completed" : "reward_retry_pending",
    );
  }
  const finalRoomEntry = getPlaceholderRoomEntry(attempt.currentPocketState, roomIndex);
  const finalCacheRetryIntent = finalRoomEntry.cacheRewardRetryIntent &&
    typeof finalRoomEntry.cacheRewardRetryIntent === "object"
    ? finalRoomEntry.cacheRewardRetryIntent
    : null;
  const reconciliationRequired = Boolean(
    (
      finalCacheRetryIntent &&
      finalCacheRetryIntent.reconciliationRequired === true
    ) || Object.values(finalRoomEntry.extractionNodeRewardRetryIntentsByItemID || {})
      .some((intent) => intent && intent.reconciliationRequired === true),
  );
  return {
    success: attempt.allSuccessful,
    attempted: attempt.attempted,
    retryPending: attempt.attempted && !attempt.allSuccessful,
    reconciliationRequired,
    retainedContainerItemID: toInt(
      finalCacheRetryIntent && finalCacheRetryIntent.retainedContainerItemID,
      0,
    ),
    data: attempt.currentPocketState,
  };
}

function retryCacheReward({
  getCacheProfile,
  resolveRoomRewardProfile,
  ensureAbyssalRewardPlan,
  getPlaceholderRoomEntry,
  resolveRewardContainerType,
  retryAbyssalRewardLootContainer,
  buildRewardCacheCustomInfo,
  getRewardTierMultiplierApplied,
  completeCacheRewardRetry,
  failCacheRewardRetry,
}, attempt, roomIndex, deps, cacheIntent) {
  attempt.attempted = true;
  const cacheProfile = getCacheProfile(attempt.currentPocketState) || {};
  const rewardProfile = resolveRoomRewardProfile(attempt.currentPocketState, roomIndex, {
    logResolution: false,
  });
  const rewardPlanResult = ensureAbyssalRewardPlan(
    attempt.currentPocketState,
    roomIndex,
    rewardProfile,
    deps,
  );
  if (!rewardPlanResult.success) {
    return { ...rewardPlanResult, attempted: true };
  }
  attempt.currentPocketState = rewardPlanResult.data || attempt.currentPocketState;
  attempt.roomEntry = getPlaceholderRoomEntry(attempt.currentPocketState, roomIndex);
  const rewardPlan = rewardPlanResult.rewardPlan;
  const containerType = resolveRewardContainerType(cacheProfile, deps);
  const retryResult = retryAbyssalRewardLootContainer(
    attempt.currentPocketState,
    roomIndex,
    containerType,
    cacheIntent,
    buildRewardCacheCustomInfo(attempt.currentPocketState, {
      roomIndex,
      role: "cache_loot_container",
      cacheProfileID: normalizeText(
        cacheProfile.cacheProfileID,
        normalizeText(cacheProfile.cacheFamily, ""),
      ),
      rewardProfileID: rewardProfile && rewardProfile.rewardProfileID,
      allowEmptyManifest: cacheIntent.allowEmptyManifest === true,
      rewardMultiplier: getRewardTierMultiplierApplied(
        rewardProfile,
        attempt.currentPocketState,
      ),
      roomRewardMultiplier: Number(rewardProfile && rewardProfile.roomMultiplier) || 1,
      rewardQuantityBonus: toInt(rewardProfile && rewardProfile.rewardQuantityBonus, 0),
      cacheRewardMaterialized: true,
      sourceStructureItemID: cacheIntent.sourceStructureItemID,
      sourceStructureTypeID: cacheIntent.sourceStructureTypeID,
    }),
    deps,
  );
  attempt.roomEntry = getPlaceholderRoomEntry(attempt.currentPocketState, roomIndex);
  if (retryResult.success) {
    return completeCacheRewardRetry(attempt, roomIndex, deps, cacheIntent, rewardPlan, retryResult);
  }
  return failCacheRewardRetry(attempt, roomIndex, deps, cacheIntent, retryResult);
}

function completeCacheRewardRetry({
  markAbyssalRewardPlanGranted,
  setPlaceholderRoomEntry,
  cloneValue,
  listUniquePositiveInts,
  updatePocketState,
  buildPocketStateForCurrentRoom,
}, attempt, roomIndex, deps, cacheIntent, rewardPlan, retryResult) {
  const data = retryResult.data || {};
  const completedRewardPlan = markAbyssalRewardPlanGranted(
    rewardPlan,
    data.rewardReceiptKey,
    toInt(deps.now(), Date.now()),
  );
  const nextRoomState = setPlaceholderRoomEntry(attempt.currentPocketState, roomIndex, {
    ...attempt.roomEntry,
    cacheRewardPlan: completedRewardPlan,
    cacheItemID: 0,
    cacheStructureItemID: 0,
    cacheLootContainerItemID: toInt(data.containerItemID, 0),
    cacheRewardEntries: cloneValue(cacheIntent.lootEntries),
    cacheRewardMaterialized: true,
    cacheLifecycleState: "structure_destroyed_loot_container_spawned",
    cacheRewardRetryIntent: null,
    cacheRewardRetryError: "",
    rewardTypeID: toInt(data.rewardTypeID, 0),
    rewardQuantity: toInt(data.rewardQuantity, 0),
    contentsGranted: data.contentsGranted === true,
    deliveredEntityIDs: listUniquePositiveInts([
      ...listUniquePositiveInts(attempt.roomEntry.deliveredEntityIDs)
        .filter((itemID) => itemID !== toInt(cacheIntent.sourceStructureItemID, 0)),
      toInt(data.containerItemID, 0),
    ]),
  });
  attempt.currentPocketState = updatePocketState(attempt.currentPocketState.instanceID, {
    ...buildPocketStateForCurrentRoom(attempt.currentPocketState, nextRoomState),
    rewardState: {
      ...cloneValue(attempt.currentPocketState.rewardState || {}),
      cacheRewardPlan: completedRewardPlan,
      cacheItemID: 0,
      cacheStructureItemID: 0,
      cacheLootContainerItemID: toInt(data.containerItemID, 0),
      cacheRewardEntries: cloneValue(cacheIntent.lootEntries),
      cacheRewardMaterialized: true,
      cacheLifecycleState: "structure_destroyed_loot_container_spawned",
      cacheRewardRetryIntent: null,
      rewardTypeID: toInt(data.rewardTypeID, 0),
      rewardQuantity: toInt(data.rewardQuantity, 0),
      contentsGranted: data.contentsGranted === true,
      unavailableReason: "",
    },
  }) || attempt.currentPocketState;
}

function failCacheRewardRetry({
  suppressAbyssalRoomRewards,
  getPlaceholderRoomEntry,
  setPlaceholderRoomEntry,
  updatePocketState,
  buildPocketStateForCurrentRoom,
  ensureAbyssalPocketPersistenceReady,
  cloneValue,
}, attempt, roomIndex, deps, cacheIntent, retryResult) {
  attempt.allSuccessful = false;
  const lastError = normalizeText(
    retryResult.errorMsg,
    "CACHE_REWARD_MATERIALIZATION_FAILED",
  );
  if (retryResult.retryable === false) {
    attempt.currentPocketState = suppressAbyssalRoomRewards(
      attempt.currentPocketState,
      roomIndex,
      deps,
      lastError,
    ) || attempt.currentPocketState;
    attempt.roomEntry = getPlaceholderRoomEntry(attempt.currentPocketState, roomIndex);
    const nextRoomState = setPlaceholderRoomEntry(attempt.currentPocketState, roomIndex, {
      ...attempt.roomEntry,
      cacheRewardRetryIntent: null,
      cacheRewardRetryError: lastError,
      extractionNodeRewardRetryIntentsByItemID: {},
      extractionNodeRewardRetryItemID: 0,
      extractionNodeRewardRetryError: lastError,
    });
    attempt.currentPocketState = updatePocketState(attempt.currentPocketState.instanceID, {
      ...buildPocketStateForCurrentRoom(attempt.currentPocketState, nextRoomState),
    }) || attempt.currentPocketState;
    ensureAbyssalPocketPersistenceReady(attempt.currentPocketState, deps);
    return {
      success: false,
      attempted: true,
      retryPending: false,
      suppressed: true,
      errorMsg: lastError,
      data: attempt.currentPocketState,
    };
  }
  const nextIntent = {
    ...cacheIntent,
    attemptCount: Math.max(0, toInt(cacheIntent.attemptCount, 0)) + 1,
    retainedContainerItemID: toInt(
      retryResult.containerItemID,
      toInt(cacheIntent.retainedContainerItemID, 0),
    ),
    lastError,
    reconciliationRequired:
      retryResult.reconciliationRequired === true ||
      cacheIntent.reconciliationRequired === true,
  };
  const nextRoomState = setPlaceholderRoomEntry(attempt.currentPocketState, roomIndex, {
    ...attempt.roomEntry,
    cacheLifecycleState: "reward_retry_pending",
    cacheRewardRetryIntent: nextIntent,
    cacheRewardRetryError: lastError,
  });
  attempt.currentPocketState = updatePocketState(attempt.currentPocketState.instanceID, {
    ...buildPocketStateForCurrentRoom(attempt.currentPocketState, nextRoomState),
    rewardState: {
      ...cloneValue(attempt.currentPocketState.rewardState || {}),
      cacheLifecycleState: "reward_retry_pending",
      cacheRewardRetryIntent: nextIntent,
      unavailableReason: lastError,
    },
  }) || attempt.currentPocketState;
}

function retryExtractionReward({
  resolveRoomExtractionNodeProfile,
  resolveExtractionNodeContainerType,
  retryAbyssalRewardLootContainer,
  buildExtractionNodeCustomInfo,
  getPlaceholderRoomEntry,
  cloneValue,
  completeExtractionRewardRetry,
  failExtractionRewardRetry,
}, attempt, roomIndex, deps, retryIntent, sourceStructureItemID, sourceKey) {
  attempt.attempted = true;
  const extractionNodeProfile = resolveRoomExtractionNodeProfile(
    attempt.currentPocketState,
    roomIndex,
    { logResolution: false },
  );
  const containerType = resolveExtractionNodeContainerType(
    retryIntent.sourceStructureTypeID,
    deps,
  );
  const retryResult = retryAbyssalRewardLootContainer(
    attempt.currentPocketState,
    roomIndex,
    containerType,
    retryIntent,
    buildExtractionNodeCustomInfo(attempt.currentPocketState, {
      roomIndex,
      role: "extraction_node_loot_container",
      extractionNodeProfileID:
        extractionNodeProfile && extractionNodeProfile.extractionNodeProfileID,
      nodeIndex: retryIntent.nodeIndex,
      sourceStructureItemID,
      sourceStructureTypeID: retryIntent.sourceStructureTypeID,
    }),
    deps,
  );
  attempt.roomEntry = getPlaceholderRoomEntry(attempt.currentPocketState, roomIndex);
  const nextIntents = cloneValue(
    attempt.roomEntry.extractionNodeRewardRetryIntentsByItemID || {},
  );
  if (retryResult.success) {
    return completeExtractionRewardRetry(attempt, roomIndex, deps, sourceKey, sourceStructureItemID, retryResult, nextIntents);
  }
  return failExtractionRewardRetry(attempt, roomIndex, deps, sourceKey, sourceStructureItemID, retryIntent, retryResult, nextIntents);
}

function completeExtractionRewardRetry({
  listUniquePositiveInts,
  setPlaceholderRoomEntry,
  updatePocketState,
  buildPocketStateForCurrentRoom,
}, attempt, roomIndex, deps, sourceKey, sourceStructureItemID, retryResult, nextIntents) {
  delete nextIntents[sourceKey];
  const data = retryResult.data || {};
  const remainingStructures = listUniquePositiveInts(attempt.roomEntry.extractionNodeItemIDs)
    .filter((itemID) => itemID !== sourceStructureItemID);
  const nextContainers = listUniquePositiveInts([
    ...listUniquePositiveInts(attempt.roomEntry.extractionNodeLootContainerItemIDs),
    toInt(data.containerItemID, 0),
  ]);
  const remainingRetryKeys = Object.keys(nextIntents)
    .filter((key) => toInt(key, 0) > 0)
    .sort((left, right) => toInt(left, 0) - toInt(right, 0));
  const remainingRetryIntent = remainingRetryKeys.length > 0
    ? nextIntents[remainingRetryKeys[0]]
    : null;
  const nextRoomState = setPlaceholderRoomEntry(attempt.currentPocketState, roomIndex, {
    ...attempt.roomEntry,
    extractionNodeItemIDs: remainingStructures,
    extractionNodeHistoricalItemIDs: listUniquePositiveInts([
      ...listUniquePositiveInts(attempt.roomEntry.extractionNodeHistoricalItemIDs),
      sourceStructureItemID,
    ]),
    extractionNodeLootContainerItemIDs: nextContainers,
    extractionNodeRewardMaterializedItemIDs: listUniquePositiveInts([
      ...listUniquePositiveInts(attempt.roomEntry.extractionNodeRewardMaterializedItemIDs),
      sourceStructureItemID,
    ]),
    extractionNodeRewardRetryIntentsByItemID: nextIntents,
    extractionNodeRewardRetryItemID: toInt(remainingRetryKeys[0], 0),
    extractionNodeRewardRetryError: normalizeText(
      remainingRetryIntent && remainingRetryIntent.lastError,
      "",
    ),
    extractionNodeLifecycleState: remainingRetryKeys.length > 0
      ? "reward_retry_pending"
      : remainingStructures.length > 0
        ? "partially_destroyed_loot_containers_spawned"
        : "structure_destroyed_loot_container_spawned",
    deliveredEntityIDs: listUniquePositiveInts([
      ...listUniquePositiveInts(attempt.roomEntry.deliveredEntityIDs)
        .filter((itemID) => itemID !== sourceStructureItemID),
      toInt(data.containerItemID, 0),
    ]),
  });
  attempt.currentPocketState = updatePocketState(attempt.currentPocketState.instanceID, {
    ...buildPocketStateForCurrentRoom(attempt.currentPocketState, nextRoomState),
  }) || attempt.currentPocketState;
}

function failExtractionRewardRetry({
  suppressAbyssalRoomRewards,
  getPlaceholderRoomEntry,
  setPlaceholderRoomEntry,
  updatePocketState,
  buildPocketStateForCurrentRoom,
  ensureAbyssalPocketPersistenceReady,
}, attempt, roomIndex, deps, sourceKey, sourceStructureItemID, retryIntent, retryResult, nextIntents) {
  attempt.allSuccessful = false;
  const lastError = normalizeText(
    retryResult.errorMsg,
    "EXTRACTION_REWARD_MATERIALIZATION_FAILED",
  );
  if (retryResult.retryable === false) {
    attempt.currentPocketState = suppressAbyssalRoomRewards(
      attempt.currentPocketState,
      roomIndex,
      deps,
      lastError,
    ) || attempt.currentPocketState;
    attempt.roomEntry = getPlaceholderRoomEntry(attempt.currentPocketState, roomIndex);
    const nextRoomState = setPlaceholderRoomEntry(attempt.currentPocketState, roomIndex, {
      ...attempt.roomEntry,
      cacheRewardRetryIntent: null,
      cacheRewardRetryError: lastError,
      extractionNodeRewardRetryIntentsByItemID: {},
      extractionNodeRewardRetryItemID: 0,
      extractionNodeRewardRetryError: lastError,
    });
    attempt.currentPocketState = updatePocketState(attempt.currentPocketState.instanceID, {
      ...buildPocketStateForCurrentRoom(attempt.currentPocketState, nextRoomState),
    }) || attempt.currentPocketState;
    ensureAbyssalPocketPersistenceReady(attempt.currentPocketState, deps);
    return {
      success: false,
      attempted: true,
      retryPending: false,
      suppressed: true,
      errorMsg: lastError,
      data: attempt.currentPocketState,
    };
  }
  nextIntents[sourceKey] = {
    ...retryIntent,
    attemptCount: Math.max(0, toInt(retryIntent.attemptCount, 0)) + 1,
    retainedContainerItemID: toInt(
      retryResult.containerItemID,
      toInt(retryIntent.retainedContainerItemID, 0),
    ),
    lastError,
    reconciliationRequired:
      retryResult.reconciliationRequired === true ||
      retryIntent.reconciliationRequired === true,
  };
  const nextRoomState = setPlaceholderRoomEntry(attempt.currentPocketState, roomIndex, {
    ...attempt.roomEntry,
    extractionNodeLifecycleState: "reward_retry_pending",
    extractionNodeRewardRetryIntentsByItemID: nextIntents,
    extractionNodeRewardRetryItemID: sourceStructureItemID,
    extractionNodeRewardRetryError: lastError,
  });
  attempt.currentPocketState = updatePocketState(attempt.currentPocketState.instanceID, {
    ...buildPocketStateForCurrentRoom(attempt.currentPocketState, nextRoomState),
  }) || attempt.currentPocketState;
}

function markRewardCacheUnavailable({
  getDependencies,
  getActivePocketStateByInstanceID,
  cloneValue,
  getRewardState,
  buildPlaceholderRoomState,
  getPlaceholderRoomEntry,
  setPlaceholderRoomEntry,
  updatePocketState,
  buildPocketStateForCurrentRoom,
  log,
},
  pocketState,
  reason,
  deps = getDependencies(),
  extraState = {},
) {
  const numericInstanceID = toInt(pocketState && pocketState.instanceID, 0);
  if (numericInstanceID <= 0) {
    return pocketState || null;
  }
  const currentPocketState =
    getActivePocketStateByInstanceID(numericInstanceID) || cloneValue(pocketState);
  const nextRewardState = {
    ...(getRewardState(currentPocketState) || {}),
    optionalExit: true,
    unavailableReason: normalizeText(reason, "UNKNOWN"),
    attemptedAtMs: toInt(deps.now(), 0),
    ...cloneValue(extraState),
  };
  const roomState = buildPlaceholderRoomState(currentPocketState);
  const currentRoomEntry = getPlaceholderRoomEntry(currentPocketState, roomState.currentRoomIndex);
  const nextRoomState = setPlaceholderRoomEntry(
    currentPocketState,
    roomState.currentRoomIndex,
    {
      ...currentRoomEntry,
      cacheItemID: toInt(nextRewardState.cacheItemID, currentRoomEntry.cacheItemID),
      cacheStructureItemID: toInt(nextRewardState.cacheStructureItemID, currentRoomEntry.cacheStructureItemID),
      cacheLootContainerItemID: toInt(nextRewardState.cacheLootContainerItemID, currentRoomEntry.cacheLootContainerItemID),
      cacheRewardMaterialized: nextRewardState.cacheRewardMaterialized === true ||
        currentRoomEntry.cacheRewardMaterialized === true,
      cacheLifecycleState: normalizeText(nextRewardState.cacheLifecycleState, currentRoomEntry.cacheLifecycleState),
      unavailableReason: normalizeText(nextRewardState.unavailableReason, ""),
      suppressedReason: normalizeText(nextRewardState.suppressedReason, currentRoomEntry.suppressedReason),
      cacheSpawnedAtMs: toInt(nextRewardState.cacheSpawnedAtMs, currentRoomEntry.cacheSpawnedAtMs),
      rewardTypeID: toInt(nextRewardState.rewardTypeID, currentRoomEntry.rewardTypeID),
      rewardQuantity: toInt(nextRewardState.rewardQuantity, currentRoomEntry.rewardQuantity),
      contentsGranted: nextRewardState.contentsGranted === true || currentRoomEntry.contentsGranted === true,
    },
  );
  const updatedPocketState = updatePocketState(numericInstanceID, {
    ...buildPocketStateForCurrentRoom(currentPocketState, nextRoomState),
    rewardState: nextRewardState,
  });
  const effectivePocketState = updatedPocketState || pocketState;
  log.warn(
    `[AbyssalMgr] Reward cache unavailable char=${effectivePocketState.characterID} ` +
      `instance=${effectivePocketState.instanceID} trace=${effectivePocketState.traceItemID} ` +
      `reason=${normalizeText(reason, "UNKNOWN")}`,
  );
  return effectivePocketState;
}

function getAbyssalRoomRewardSuppressionReason({
  buildPlaceholderRoomState,
  clampRoomIndex,
  getPlaceholderRoomEntry,
}, pocketState, roomIndex = null) {
  if (!pocketState) return "";
  const roomState = buildPlaceholderRoomState(pocketState);
  const resolvedRoomIndex = clampRoomIndex(
    roomIndex == null ? roomState.currentRoomIndex : toInt(roomIndex, roomState.currentRoomIndex),
    roomState.implementedRooms,
  );
  const roomEntry = getPlaceholderRoomEntry(pocketState, resolvedRoomIndex);
  const explicitReason = normalizeText(
    roomEntry && roomEntry.suppressedReason,
    normalizeText(
      resolvedRoomIndex === roomState.currentRoomIndex
        ? pocketState.rewardState && pocketState.rewardState.suppressedReason
        : "",
      "",
    ),
  );
  if (explicitReason) return explicitReason;
  if (
    normalizeText(roomEntry && roomEntry.npcControllerActivationState, "") === "degraded" ||
    (
      resolvedRoomIndex === roomState.currentRoomIndex &&
      normalizeText(pocketState.encounterState && pocketState.encounterState.spawnMode, "") ===
        "degraded"
    )
  ) {
    return "ROOM_ENCOUNTER_DEGRADED";
  }
  return "";
}

function suppressAbyssalRoomRewards({
  getDependencies,
  getActivePocketStateByInstanceID,
  buildPlaceholderRoomState,
  clampRoomIndex,
  getPlaceholderRoomEntry,
  listUniquePositiveInts,
  getCacheProfile,
  resolveRewardContainerType,
  listAuthoritativeAbyssalRoomRewardArtifacts,
  readRewardCacheStateFromItem,
  resolveRoomExtractionNodeProfile,
  TYPE_ABYSSAL_EXTRACTION_SUBNODE_WRECK,
  TYPE_ABYSSAL_EXTRACTION_NODE_WRECK,
  readExtractionNodeStateFromItem,
  claimRewardSuppression,
},
  pocketState,
  roomIndex,
  deps = getDependencies(),
  reason = "ROOM_ENCOUNTER_DEGRADED",
) {
  const instanceID = toInt(pocketState && pocketState.instanceID, 0);
  if (instanceID <= 0) return pocketState || null;
  const currentPocketState = getActivePocketStateByInstanceID(instanceID) || pocketState;
  const roomState = buildPlaceholderRoomState(currentPocketState);
  const resolvedRoomIndex = clampRoomIndex(
    toInt(roomIndex, roomState.currentRoomIndex),
    roomState.implementedRooms,
  );
  const roomEntry = getPlaceholderRoomEntry(currentPocketState, resolvedRoomIndex);
  const suppressionReason = normalizeText(reason, "ROOM_ENCOUNTER_DEGRADED");
  const cacheRetryRetainedContainerItemIDs = listUniquePositiveInts([
    roomEntry.cacheRewardRetryIntent &&
      roomEntry.cacheRewardRetryIntent.retainedContainerItemID,
  ]);
  const extractionRetryRetainedContainerItemIDs = listUniquePositiveInts(
    Object.values(roomEntry.extractionNodeRewardRetryIntentsByItemID || {})
      .map((intent) => intent && intent.retainedContainerItemID),
  );
  const cacheProfile = getCacheProfile(currentPocketState) || {};
  const cacheContainerType = resolveRewardContainerType(cacheProfile, deps);
  const cacheContainerTypeID = toInt(cacheContainerType && cacheContainerType.typeID, 0);
  const cacheContainerScan = cacheContainerTypeID > 0
    ? listAuthoritativeAbyssalRoomRewardArtifacts(
        currentPocketState,
        resolvedRoomIndex,
        deps,
        {
          role: "cache_loot_container",
          typeID: cacheContainerTypeID,
          stateReader: readRewardCacheStateFromItem,
          requireSourceStructure: true,
        },
      )
    : { authoritative: [] };
  const extractionNodeProfile = resolveRoomExtractionNodeProfile(
    currentPocketState,
    resolvedRoomIndex,
    { logResolution: false },
  );
  const extractionContainerScan = listAuthoritativeAbyssalRoomRewardArtifacts(
    currentPocketState,
    resolvedRoomIndex,
    deps,
    {
      role: "extraction_node_loot_container",
      typeIDs: [
        TYPE_ABYSSAL_EXTRACTION_SUBNODE_WRECK,
        TYPE_ABYSSAL_EXTRACTION_NODE_WRECK,
      ],
      profileID: normalizeText(
        extractionNodeProfile && extractionNodeProfile.extractionNodeProfileID,
        "",
      ),
      stateReader: readExtractionNodeStateFromItem,
      requireSourceStructure: true,
    },
  );
  const cacheItemIDs = listUniquePositiveInts([
    roomEntry.cacheItemID,
    roomEntry.cacheStructureItemID,
    roomEntry.cacheLootContainerItemID,
    ...cacheRetryRetainedContainerItemIDs,
    ...(cacheContainerScan.authoritative || []).map((entry) => entry.itemID),
  ]);
  const extractionStructureItemIDs = listUniquePositiveInts(
    roomEntry.extractionNodeItemIDs,
  );
  const extractionLootContainerItemIDs = listUniquePositiveInts(
    [
      ...listUniquePositiveInts(roomEntry.extractionNodeLootContainerItemIDs),
      ...extractionRetryRetainedContainerItemIDs,
      ...(extractionContainerScan.authoritative || []).map((entry) => entry.itemID),
    ],
  );
  const rewardArtifactItemIDs = listUniquePositiveInts([
    ...cacheItemIDs,
    ...extractionStructureItemIDs,
    ...extractionLootContainerItemIDs,
    ...listUniquePositiveInts(roomEntry.rewardSuppressionPendingRemovalItemIDs),
  ]);
  return claimRewardSuppression({
    deps,
    instanceID,
    currentPocketState,
    roomState,
    resolvedRoomIndex,
    roomEntry,
    suppressionReason,
    cacheItemIDs,
    extractionStructureItemIDs,
    extractionLootContainerItemIDs,
    rewardArtifactItemIDs,
  });
}

function claimRewardSuppression({
  setPlaceholderRoomEntry,
  listUniquePositiveInts,
  buildPocketStateForCurrentRoom,
  updatePocketState,
  getRewardState,
  cloneValue,
  removeSuppressedRewardArtifacts,
}, context) {
  const {
    deps,
    instanceID,
    currentPocketState,
    roomState,
    resolvedRoomIndex,
    roomEntry,
    suppressionReason,
    cacheItemIDs,
    extractionStructureItemIDs,
    extractionLootContainerItemIDs,
    rewardArtifactItemIDs,
  } = context;
  // Persist the suppression claim before attempting physical removal. Runtime
  // destruction callbacks can be synchronous; this makes them observe the
  // no-loot policy even if they fire during cleanup.
  const claimedRoomState = setPlaceholderRoomEntry(
    currentPocketState,
    resolvedRoomIndex,
    {
      ...roomEntry,
      cacheLootContainerItemID: cacheItemIDs.find((itemID) => (
        itemID !== toInt(roomEntry.cacheItemID, 0) &&
        itemID !== toInt(roomEntry.cacheStructureItemID, 0)
      )) || 0,
      cacheRewardRetryIntent: null,
      cacheRewardRetryError: "",
      cacheRewardEntries: [],
      cacheRewardMaterialized: true,
      cacheLifecycleState: "suppression_claimed",
      unavailableReason: suppressionReason,
      suppressedReason: suppressionReason,
      rewardTypeID: 0,
      rewardQuantity: 0,
      contentsGranted: false,
      extractionNodeRewardMaterializedItemIDs: listUniquePositiveInts([
        ...roomEntry.extractionNodeRewardMaterializedItemIDs,
        ...extractionStructureItemIDs,
      ]),
      extractionNodeLootContainerItemIDs: extractionLootContainerItemIDs,
      extractionNodeRewardRetryIntentsByItemID: {},
      extractionNodeRewardRetryItemID: 0,
      extractionNodeRewardRetryError: "",
      extractionNodeLifecycleState: "suppression_claimed",
      rewardSuppressionPendingRemovalItemIDs: rewardArtifactItemIDs,
    },
  );
  const claimedRoomPatch = resolvedRoomIndex === roomState.currentRoomIndex
    ? buildPocketStateForCurrentRoom(currentPocketState, claimedRoomState)
    : { roomState: claimedRoomState };
  updatePocketState(instanceID, {
    ...claimedRoomPatch,
    rewardState: resolvedRoomIndex === roomState.currentRoomIndex
      ? {
          ...(getRewardState(currentPocketState) || {}),
          cacheRewardEntries: [],
          cacheRewardMaterialized: true,
          cacheLifecycleState: "suppression_claimed",
          spawnMode: "suppressed",
          unavailableReason: suppressionReason,
          suppressedReason: suppressionReason,
          rewardTypeID: 0,
          rewardQuantity: 0,
          contentsGranted: false,
        }
      : cloneValue(currentPocketState.rewardState || {}),
  });
  return removeSuppressedRewardArtifacts(context);
}

function removeSuppressedRewardArtifacts({
  buildAbyssalSceneDescriptor,
  destroyPlaceholderTrace,
  listUniquePositiveInts,
  setPlaceholderRoomEntry,
  buildPocketStateForCurrentRoom,
  updatePocketState,
  getRewardState,
  cloneValue,
  log,
}, context) {
  const {
    deps,
    instanceID,
    currentPocketState,
    roomState,
    resolvedRoomIndex,
    roomEntry,
    suppressionReason,
    cacheItemIDs,
    extractionStructureItemIDs,
    extractionLootContainerItemIDs,
    rewardArtifactItemIDs,
  } = context;
  const sceneDescriptor = buildAbyssalSceneDescriptor(currentPocketState, deps);
  const removalResults = rewardArtifactItemIDs.map((itemID) => ({
    itemID,
    result: destroyPlaceholderTrace(
      currentPocketState.solarSystemID,
      itemID,
      deps,
      "degraded-room-reward-suppression",
      "degraded room reward artifact",
      { sceneDescriptor: sceneDescriptor || undefined },
    ),
  }));
  const failedItemIDs = new Set(
    removalResults
      .filter((entry) => entry.result && entry.result.failed === true)
      .map((entry) => entry.itemID),
  );
  const retainedCacheStructureItemID = listUniquePositiveInts([
    roomEntry.cacheItemID,
    roomEntry.cacheStructureItemID,
  ]).find((itemID) => failedItemIDs.has(itemID)) || 0;
  const retainedCacheLootContainerItemID = cacheItemIDs
    .filter((itemID) => (
      itemID !== toInt(roomEntry.cacheItemID, 0) &&
      itemID !== toInt(roomEntry.cacheStructureItemID, 0)
    ))
    .find((itemID) => failedItemIDs.has(itemID)) || 0;
  const retainedExtractionStructureItemIDs = extractionStructureItemIDs
    .filter((itemID) => failedItemIDs.has(itemID));
  const retainedExtractionLootContainerItemIDs = extractionLootContainerItemIDs
    .filter((itemID) => failedItemIDs.has(itemID));
  const nextRoomState = setPlaceholderRoomEntry(
    currentPocketState,
    resolvedRoomIndex,
    {
      ...roomEntry,
      cacheItemID: retainedCacheStructureItemID,
      cacheStructureItemID: retainedCacheStructureItemID,
      cacheLootContainerItemID: retainedCacheLootContainerItemID,
      cacheRewardEntries: [],
      cacheRewardMaterialized: true,
      cacheLifecycleState: failedItemIDs.size > 0
        ? "suppression_remove_failed"
        : "suppressed",
      unavailableReason: suppressionReason,
      suppressedReason: suppressionReason,
      rewardTypeID: 0,
      rewardQuantity: 0,
      contentsGranted: false,
      cacheRewardRetryIntent: null,
      cacheRewardRetryError: "",
      extractionNodeItemIDs: retainedExtractionStructureItemIDs,
      extractionNodeLootContainerItemIDs: retainedExtractionLootContainerItemIDs,
      extractionNodeRewardRetryIntentsByItemID: {},
      extractionNodeRewardRetryItemID: 0,
      extractionNodeRewardRetryError: "",
      extractionNodeRewardMaterializedItemIDs: listUniquePositiveInts([
        ...roomEntry.extractionNodeRewardMaterializedItemIDs,
        ...extractionStructureItemIDs,
      ]),
      extractionNodeLifecycleState: failedItemIDs.size > 0
        ? "suppression_remove_failed"
        : "suppressed",
      rewardSuppressionPendingRemovalItemIDs: [...failedItemIDs],
      deliveredEntityIDs: listUniquePositiveInts(roomEntry.deliveredEntityIDs)
        .filter((itemID) => !rewardArtifactItemIDs.includes(itemID)),
    },
  );
  const roomPatch = resolvedRoomIndex === roomState.currentRoomIndex
    ? buildPocketStateForCurrentRoom(currentPocketState, nextRoomState)
    : { roomState: nextRoomState };
  const updatedPocketState = updatePocketState(instanceID, {
    ...roomPatch,
    rewardState: resolvedRoomIndex === roomState.currentRoomIndex
      ? {
          ...(getRewardState(currentPocketState) || {}),
          cacheItemID: retainedCacheStructureItemID,
          cacheStructureItemID: retainedCacheStructureItemID,
          cacheLootContainerItemID: retainedCacheLootContainerItemID,
          cacheRewardEntries: [],
          cacheRewardMaterialized: true,
          cacheLifecycleState: failedItemIDs.size > 0
            ? "suppression_remove_failed"
            : "suppressed",
          spawnMode: "suppressed",
          unavailableReason: suppressionReason,
          suppressedReason: suppressionReason,
          rewardTypeID: 0,
          rewardQuantity: 0,
          contentsGranted: false,
        }
      : cloneValue(currentPocketState.rewardState || {}),
  }) || currentPocketState;
  log.warn(
    `[AbyssalMgr] Room rewards suppressed instance=${instanceID} ` +
      `room=${resolvedRoomIndex} reason=${suppressionReason} ` +
      `artifacts=${rewardArtifactItemIDs.join(",") || "none"} ` +
      `removalFailures=${[...failedItemIDs].join(",") || "none"}`,
  );
  return updatedPocketState;
}

function markRewardCacheConsumedOrRemoved({
  getDependencies,
  getActivePocketStateByInstanceID,
  cloneValue,
  buildPlaceholderRoomState,
  clampRoomIndex,
  getPlaceholderRoomEntry,
  getRewardState,
  setPlaceholderRoomEntry,
  listUniquePositiveInts,
  buildPocketStateForCurrentRoom,
  updatePocketState,
},
  pocketState,
  deps = getDependencies(),
  extraState = {},
) {
  const numericInstanceID = toInt(pocketState && pocketState.instanceID, 0);
  if (numericInstanceID <= 0) {
    return pocketState || null;
  }
  const currentPocketState =
    getActivePocketStateByInstanceID(numericInstanceID) || cloneValue(pocketState);
  const roomState = buildPlaceholderRoomState(currentPocketState);
  const roomIndex = clampRoomIndex(
    toInt(extraState.roomIndex, roomState.currentRoomIndex),
    roomState.implementedRooms,
  );
  const removedContainerItemID = toInt(
    extraState.removedContainerItemID,
    toInt(extraState.cacheLootContainerItemID, 0),
  );
  const rewardStateOverrides = cloneValue(extraState);
  delete rewardStateOverrides.roomIndex;
  delete rewardStateOverrides.removedContainerItemID;
  const currentRoomEntry = getPlaceholderRoomEntry(currentPocketState, roomIndex);
  const isCurrentRoom = roomIndex === roomState.currentRoomIndex;
  const nextRewardState = {
    ...(isCurrentRoom ? getRewardState(currentPocketState) || {} : currentRoomEntry),
    cacheItemID: 0,
    cacheStructureItemID: 0,
    cacheLootContainerItemID: 0,
    cacheRewardMaterialized: true,
    optionalExit: true,
    consumedOrRemovedAtMs: toInt(deps.now(), 0),
    cacheLifecycleState: "consumed_or_removed",
    ...rewardStateOverrides,
  };
  nextRewardState.cacheLootContainerItemID = 0;
  const nextRoomState = setPlaceholderRoomEntry(
    currentPocketState,
    roomIndex,
    {
      ...currentRoomEntry,
      cacheItemID: 0,
      cacheStructureItemID: 0,
      cacheLootContainerItemID: 0,
      cacheRewardMaterialized: true,
      deliveredEntityIDs: listUniquePositiveInts(currentRoomEntry.deliveredEntityIDs)
        .filter((entityID) => entityID !== removedContainerItemID),
      cacheLifecycleState: "consumed_or_removed",
      cacheSpawnedAtMs: toInt(nextRewardState.cacheSpawnedAtMs, currentRoomEntry.cacheSpawnedAtMs),
      unavailableReason: normalizeText(nextRewardState.unavailableReason, currentRoomEntry.unavailableReason),
      suppressedReason: normalizeText(nextRewardState.suppressedReason, currentRoomEntry.suppressedReason),
      rewardTypeID: toInt(nextRewardState.rewardTypeID, currentRoomEntry.rewardTypeID),
      rewardQuantity: toInt(nextRewardState.rewardQuantity, currentRoomEntry.rewardQuantity),
      contentsGranted: nextRewardState.contentsGranted === true || currentRoomEntry.contentsGranted === true,
    },
  );
  const roomPatch = roomIndex === roomState.currentRoomIndex
    ? buildPocketStateForCurrentRoom(currentPocketState, nextRoomState)
    : { roomState: nextRoomState };
  const updatedPocketState = updatePocketState(numericInstanceID, {
    ...roomPatch,
    rewardState: isCurrentRoom ? nextRewardState : cloneValue(currentPocketState.rewardState || {}),
  });
  return updatedPocketState || pocketState;
}

function handleAbyssalRewardLootContainerRemoved({
  getDependencies,
  parseCustomInfo,
  getActivePocketStateByInstanceID,
  evaluateAbyssalDirectCallbackTerminalGuard,
  buildAbyssalDirectCallbackSuppressedResult,
  buildPlaceholderRoomState,
  clampRoomIndex,
  markRewardCacheConsumedOrRemoved,
  log,
},
  containerItem,
  reason = "reward-loot-container-removed",
  deps = getDependencies(),
) {
  const itemID = toInt(containerItem && containerItem.itemID, 0);
  const parsed = parseCustomInfo(containerItem && containerItem.customInfo);
  const artifactState = parsed && parsed.evejsAbyssalRewardCache;
  if (
    itemID <= 0 ||
    !artifactState ||
    typeof artifactState !== "object" ||
    normalizeText(artifactState.role, "") !== "cache_loot_container"
  ) {
    return { handled: false, reason: "NOT_ABYSSAL_REWARD_LOOT_CONTAINER" };
  }
  const instanceID = toInt(artifactState.instanceID, 0);
  const pocketState = getActivePocketStateByInstanceID(instanceID);
  if (!pocketState) {
    return { handled: false, reason: "ABYSSAL_INSTANCE_NOT_ACTIVE", instanceID, itemID };
  }
  const terminalGuard = evaluateAbyssalDirectCallbackTerminalGuard(
    pocketState,
    "reward-loot-container-removed",
  );
  if (terminalGuard.blocked) {
    return buildAbyssalDirectCallbackSuppressedResult(terminalGuard, {
      itemID,
      extra: { removed: true },
    });
  }
  const roomState = buildPlaceholderRoomState(pocketState);
  const roomIndex = clampRoomIndex(
    toInt(artifactState.roomIndex, roomState.currentRoomIndex),
    roomState.implementedRooms,
  );
  const updatedPocketState = markRewardCacheConsumedOrRemoved(
    pocketState,
    deps,
    {
      roomIndex,
      removedContainerItemID: itemID,
      cacheLootContainerItemID: 0,
      cacheRewardMaterialized: true,
      cacheLifecycleState: "consumed_or_removed",
      consumedOrRemovedReason: normalizeText(reason, "reward-loot-container-removed"),
    },
  );
  log.info(
    `[AbyssalMgr] Reward loot container removed instance=${instanceID} room=${roomIndex} ` +
      `itemID=${itemID} reason=${normalizeText(reason, "reward-loot-container-removed")} ` +
      `state=consumed_or_removed`,
  );
  return {
    handled: true,
    instanceID,
    roomIndex,
    itemID,
    pocketState: updatedPocketState,
  };
}

// Capture supplied capabilities once, as the original closure did. Internal
// callbacks are bound once per instance; no runtime state lives in this wiring.
function createAbyssalRewardLifecycle({
  getDependencies,
  getActivePocketStateByInstanceID,
  getPlaceholderRoomEntry,
  cloneValue,
  getCacheProfile,
  resolveRoomRewardProfile,
  ensureAbyssalRewardPlan,
  resolveRewardContainerType,
  retryAbyssalRewardLootContainer,
  buildRewardCacheCustomInfo,
  getRewardTierMultiplierApplied,
  markAbyssalRewardPlanGranted,
  setPlaceholderRoomEntry,
  listUniquePositiveInts,
  updatePocketState,
  buildPocketStateForCurrentRoom,
  ensureAbyssalPocketPersistenceReady,
  resolveRoomExtractionNodeProfile,
  resolveExtractionNodeContainerType,
  buildExtractionNodeCustomInfo,
  refreshAbyssalDungeonTrackingState,
  getRewardState,
  buildPlaceholderRoomState,
  clampRoomIndex,
  log,
  listAuthoritativeAbyssalRoomRewardArtifacts,
  readRewardCacheStateFromItem,
  readExtractionNodeStateFromItem,
  buildAbyssalSceneDescriptor,
  destroyPlaceholderTrace,
  parseCustomInfo,
  evaluateAbyssalDirectCallbackTerminalGuard,
  buildAbyssalDirectCallbackSuppressedResult,
  TYPE_ABYSSAL_EXTRACTION_SUBNODE_WRECK,
  TYPE_ABYSSAL_EXTRACTION_NODE_WRECK,
}) {

  const ports = {
    getDependencies,
    getActivePocketStateByInstanceID,
    getPlaceholderRoomEntry,
    cloneValue,
    getCacheProfile,
    resolveRoomRewardProfile,
    ensureAbyssalRewardPlan,
    resolveRewardContainerType,
    retryAbyssalRewardLootContainer,
    buildRewardCacheCustomInfo,
    getRewardTierMultiplierApplied,
    markAbyssalRewardPlanGranted,
    setPlaceholderRoomEntry,
    listUniquePositiveInts,
    updatePocketState,
    buildPocketStateForCurrentRoom,
    ensureAbyssalPocketPersistenceReady,
    resolveRoomExtractionNodeProfile,
    resolveExtractionNodeContainerType,
    buildExtractionNodeCustomInfo,
    refreshAbyssalDungeonTrackingState,
    getRewardState,
    buildPlaceholderRoomState,
    clampRoomIndex,
    log,
    listAuthoritativeAbyssalRoomRewardArtifacts,
    readRewardCacheStateFromItem,
    readExtractionNodeStateFromItem,
    buildAbyssalSceneDescriptor,
    destroyPlaceholderTrace,
    parseCustomInfo,
    evaluateAbyssalDirectCallbackTerminalGuard,
    buildAbyssalDirectCallbackSuppressedResult,
    TYPE_ABYSSAL_EXTRACTION_SUBNODE_WRECK,
    TYPE_ABYSSAL_EXTRACTION_NODE_WRECK,
  };
  ports.retryPendingAbyssalRewardMaterializations = retryPendingAbyssalRewardMaterializations.bind(null, ports);
  ports.retryCacheReward = retryCacheReward.bind(null, ports);
  ports.completeCacheRewardRetry = completeCacheRewardRetry.bind(null, ports);
  ports.failCacheRewardRetry = failCacheRewardRetry.bind(null, ports);
  ports.retryExtractionReward = retryExtractionReward.bind(null, ports);
  ports.completeExtractionRewardRetry = completeExtractionRewardRetry.bind(null, ports);
  ports.failExtractionRewardRetry = failExtractionRewardRetry.bind(null, ports);
  ports.markRewardCacheUnavailable = markRewardCacheUnavailable.bind(null, ports);
  ports.getAbyssalRoomRewardSuppressionReason = getAbyssalRoomRewardSuppressionReason.bind(null, ports);
  ports.suppressAbyssalRoomRewards = suppressAbyssalRoomRewards.bind(null, ports);
  ports.claimRewardSuppression = claimRewardSuppression.bind(null, ports);
  ports.removeSuppressedRewardArtifacts = removeSuppressedRewardArtifacts.bind(null, ports);
  ports.markRewardCacheConsumedOrRemoved = markRewardCacheConsumedOrRemoved.bind(null, ports);
  ports.handleAbyssalRewardLootContainerRemoved = handleAbyssalRewardLootContainerRemoved.bind(null, ports);
  Object.freeze(ports);
  return Object.freeze({
    retryPendingAbyssalRewardMaterializations: ports.retryPendingAbyssalRewardMaterializations,
    markRewardCacheUnavailable: ports.markRewardCacheUnavailable,
    getAbyssalRoomRewardSuppressionReason: ports.getAbyssalRoomRewardSuppressionReason,
    suppressAbyssalRoomRewards: ports.suppressAbyssalRoomRewards,
    markRewardCacheConsumedOrRemoved: ports.markRewardCacheConsumedOrRemoved,
    handleAbyssalRewardLootContainerRemoved: ports.handleAbyssalRewardLootContainerRemoved,
  });
}

module.exports = { createAbyssalRewardLifecycle };
