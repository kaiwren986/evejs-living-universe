"use strict";

const { normalizeText } = require("../domain/abyssalValueUtils");

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

// No retained state; each operation carries only its own attempt-local values.
function ensurePlaceholderRewardCache({
  getDependencies,
  getActivePocketStateByInstanceID,
  cloneValue,
  buildPlaceholderRoomState,
  clampRoomIndex,
  getPlaceholderRoomEntry,
  retryPendingAbyssalRewardMaterializations,
  inspectCacheCreationState,
},
  pocketState,
  session = null,
  deps = getDependencies(),
  options = {},
) {

  const numericInstanceID = toInt(pocketState && pocketState.instanceID, 0);
  if (numericInstanceID <= 0) {
    return {
      success: false,
      errorMsg: "POCKET_STATE_MISSING",
    };
  }
  let resolvedPocketState =
    getActivePocketStateByInstanceID(numericInstanceID) || cloneValue(pocketState);
  const roomState = buildPlaceholderRoomState(resolvedPocketState);
  const roomIndex = clampRoomIndex(
    toInt(options && options.roomIndex, roomState.currentRoomIndex),
    roomState.implementedRooms,
  );
  let roomEntry = getPlaceholderRoomEntry(resolvedPocketState, roomIndex);
  if (roomEntry.cacheRewardRetryIntent) {
    const retryResult = retryPendingAbyssalRewardMaterializations(
      resolvedPocketState,
      roomIndex,
      deps,
    );
    return {
      ...retryResult,
      created: false,
      repaired: retryResult.success === true,
    };
  }
  const allowBeforeObjective = options && options.allowBeforeObjective === true;
  if (!(roomEntry && roomEntry.objectiveComplete === true) && !allowBeforeObjective) {
    return {
      success: false,
      skipped: true,
      errorMsg: "OBJECTIVE_INCOMPLETE",
    };
  }
  return inspectCacheCreationState({
    pocketState,
    session,
    deps,
    options,
    numericInstanceID,
    resolvedPocketState,
    roomState,
    roomIndex,
    roomEntry,
    allowBeforeObjective,
  });
}

function inspectCacheCreationState({
  getRewardState,
  getAbyssalRoomRewardSuppressionReason,
  reconcileCacheBeforeCreation,
}, attempt) {
  const { resolvedPocketState, roomEntry, options, roomIndex } = attempt;
const rewardState = {
    ...(getRewardState(resolvedPocketState) || {}),
    cacheItemID: toInt(roomEntry.cacheItemID, toInt(getRewardState(resolvedPocketState) &&
      getRewardState(resolvedPocketState).cacheItemID, 0)),
    cacheStructureItemID: toInt(roomEntry.cacheStructureItemID, toInt(getRewardState(resolvedPocketState) &&
      getRewardState(resolvedPocketState).cacheStructureItemID, 0)),
    cacheLootContainerItemID: toInt(roomEntry.cacheLootContainerItemID, toInt(getRewardState(resolvedPocketState) &&
      getRewardState(resolvedPocketState).cacheLootContainerItemID, 0)),
    cacheRewardMaterialized: roomEntry.cacheRewardMaterialized === true ||
      Boolean(getRewardState(resolvedPocketState) &&
        getRewardState(resolvedPocketState).cacheRewardMaterialized === true),
    cacheSpawnedAtMs: toInt(roomEntry.cacheSpawnedAtMs, 0),
    cacheLifecycleState: normalizeText(roomEntry.cacheLifecycleState, ""),
    unavailableReason: normalizeText(roomEntry.unavailableReason, ""),
    suppressedReason: normalizeText(roomEntry.suppressedReason, ""),
    rewardTypeID: toInt(roomEntry.rewardTypeID, 0),
    rewardQuantity: toInt(roomEntry.rewardQuantity, 0),
    contentsGranted: roomEntry.contentsGranted === true,
  };
  const existingCacheItemID = toInt(rewardState.cacheItemID, 0) > 0
    ? toInt(rewardState.cacheItemID, 0)
    : toInt(rewardState.cacheStructureItemID, 0);
  const existingLootContainerItemID = toInt(
    rewardState.cacheLootContainerItemID,
    0,
  );
  const allowRepairMissing = options && options.allowRepairMissing === true;
  const authoritativeSuppressionReason =
    getAbyssalRoomRewardSuppressionReason(resolvedPocketState, roomIndex) ||
    rewardState.suppressedReason;
  if (authoritativeSuppressionReason) {
    return {
      success: true,
      created: false,
      repaired: false,
      skipped: true,
      reason: authoritativeSuppressionReason,
      data: resolvedPocketState,
    };
  }
  if (
    rewardState.cacheLifecycleState === "consumed_or_removed" &&
    existingCacheItemID <= 0 &&
    toInt(rewardState.cacheLootContainerItemID, 0) <= 0
  ) {
    return {
      success: true,
      created: false,
      repaired: false,
      skipped: true,
      data: resolvedPocketState,
      reason: "CACHE_CONSUMED_OR_REMOVED",
    };
  }
  return reconcileCacheBeforeCreation({
    ...attempt,
    rewardState,
    existingCacheItemID,
    existingLootContainerItemID,
    allowRepairMissing,
    authoritativeSuppressionReason,
  });
}

function reconcileCacheBeforeCreation({
  reconcileUntrackedAbyssalRewardCacheArtifacts,
  markRewardCacheConsumedOrRemoved,
  PLACEHOLDER_REWARD_CACHE_MAX_REPAIRS,
  markRewardCacheUnavailable,
  hasFailedTimeoutOutcome,
  prepareCacheCreationContent,
}, attempt) {
  const {
    resolvedPocketState,
    roomIndex,
    deps,
    existingCacheItemID,
    existingLootContainerItemID,
    rewardState,
    allowRepairMissing,
  } = attempt;
const artifactReconciliation = reconcileUntrackedAbyssalRewardCacheArtifacts(
    resolvedPocketState,
    roomIndex,
    deps,
  );
  if (!artifactReconciliation.success) {
    return artifactReconciliation;
  }
  if (artifactReconciliation.reconciled === true) {
    return {
      ...artifactReconciliation,
      created: false,
      repaired: true,
    };
  }
  if (existingCacheItemID > 0 && deps.findItemById(existingCacheItemID)) {
    return {
      success: true,
      created: false,
      repaired: false,
      data: resolvedPocketState,
    };
  }
  if (
    existingLootContainerItemID > 0 &&
    deps.findItemById(existingLootContainerItemID)
  ) {
    return {
      success: true,
      created: false,
      repaired: false,
      data: resolvedPocketState,
    };
  }
  if (
    rewardState.unavailableReason &&
    existingCacheItemID <= 0 &&
    toInt(rewardState.cacheSpawnedAtMs, 0) <= 0
  ) {
    return {
      success: false,
      skipped: true,
      errorMsg: rewardState.unavailableReason,
    };
  }
  if (rewardState.suppressedReason && existingCacheItemID <= 0) {
    return {
      success: false,
      skipped: true,
      errorMsg: rewardState.suppressedReason,
    };
  }
  if (
    rewardState.cacheSpawnedAtMs &&
    !allowRepairMissing &&
    (existingCacheItemID <= 0 || !deps.findItemById(existingCacheItemID))
  ) {
    return {
      success: true,
      created: false,
      repaired: false,
      skipped: true,
      data: markRewardCacheConsumedOrRemoved(resolvedPocketState, deps),
    };
  }
  if (
    rewardState.cacheSpawnedAtMs &&
    toInt(rewardState.cacheRepairAttempts, 0) >= PLACEHOLDER_REWARD_CACHE_MAX_REPAIRS
  ) {
    markRewardCacheUnavailable(
      resolvedPocketState,
      "CACHE_MISSING_REPAIR_EXHAUSTED",
      deps,
      {
        spawnMode: "repair_exhausted",
      },
    );
    return {
      success: false,
      errorMsg: "CACHE_MISSING_REPAIR_EXHAUSTED",
    };
  }
  if (hasFailedTimeoutOutcome(resolvedPocketState) && existingCacheItemID <= 0) {
    markRewardCacheUnavailable(
      resolvedPocketState,
      "RUN_FAILED_TIMEOUT",
      deps,
      {
        spawnMode: "suppressed",
        suppressedReason: "RUN_FAILED_TIMEOUT",
      },
    );
    return {
      success: false,
      errorMsg: "RUN_FAILED_TIMEOUT",
    };
  }
  return prepareCacheCreationContent({
    ...attempt,
    artifactReconciliation,
  });
}

function prepareCacheCreationContent({
  ensureAbyssalPocketPersistenceReady,
  getContentProfile,
  getCacheProfile,
  resolveRoomEncounterProfile,
  resolveRoomRewardProfile,
  markRewardCacheUnavailable,
  ensureAbyssalRewardPlan,
  getPlaceholderRoomEntry,
  cloneValue,
  log,
  summarizeRewardLootEntries,
  listGuaranteedRewardLootEntries,
  createCacheInventoryArtifact,
}, attempt) {
  const { deps, roomIndex, roomState } = attempt;
  let { resolvedPocketState, roomEntry } = attempt;
const persistenceResult = ensureAbyssalPocketPersistenceReady(
    resolvedPocketState,
    deps,
  );
  if (!persistenceResult.success) {
    return {
      success: false,
      errorMsg: "ABYSSAL_RUN_STATE_PERSIST_FAILED",
      persistenceResult,
    };
  }

  const contentProfile = getContentProfile(resolvedPocketState);
  const cacheProfile = getCacheProfile(resolvedPocketState);
  const encounterProfile = resolveRoomEncounterProfile(resolvedPocketState, roomIndex, {
    logResolution: false,
  });
  const rewardProfile = resolveRoomRewardProfile(
    resolvedPocketState,
    roomIndex,
    {
      encounterProfile,
    },
  );
  if (!cacheProfile) {
    markRewardCacheUnavailable(resolvedPocketState, "CACHE_PROFILE_MISSING", deps);
    return {
      success: false,
      errorMsg: "CACHE_PROFILE_MISSING",
    };
  }
  if (!rewardProfile) {
    markRewardCacheUnavailable(resolvedPocketState, "REWARD_PROFILE_MISSING", deps);
    return {
      success: false,
      errorMsg: "REWARD_PROFILE_MISSING",
    };
  }
  const rewardPlanResult = ensureAbyssalRewardPlan(
    resolvedPocketState,
    roomIndex,
    rewardProfile,
    deps,
  );
  if (!rewardPlanResult.success) {
    return rewardPlanResult;
  }
  resolvedPocketState = rewardPlanResult.data || resolvedPocketState;
  roomEntry = getPlaceholderRoomEntry(resolvedPocketState, roomIndex);
  const rewardPlan = rewardPlanResult.rewardPlan;
  const resolvedRewardEntries = cloneValue(rewardPlan.entries);
  log.info(
    `[AbyssalMgr] Reward profile resolved char=${resolvedPocketState.characterID} ` +
      `instance=${resolvedPocketState.instanceID} trace=${resolvedPocketState.traceItemID} ` +
      `room=${roomIndex}/${roomState.implementedRooms} ` +
      `rewardProfile=${normalizeText(rewardProfile.rewardProfileID, "unknown")} ` +
      `encounter=${normalizeText(encounterProfile && encounterProfile.encounterProfileID, "unknown")} ` +
      `cacheType="${normalizeText(cacheProfile.cacheTypeName, "unknown")}" ` +
      `cacheName="${normalizeText(cacheProfile.cacheDisplayName, "unknown")}" ` +
      `lootEntries=${Array.isArray(rewardProfile.lootEntries) ? rewardProfile.lootEntries.length : 0} ` +
      `guaranteed="${summarizeRewardLootEntries(listGuaranteedRewardLootEntries(rewardProfile))}" ` +
      `rolled="${summarizeRewardLootEntries(resolvedRewardEntries)}"`,
  );
  return createCacheInventoryArtifact({
    ...attempt,
    persistenceResult,
    contentProfile,
    cacheProfile,
    encounterProfile,
    rewardProfile,
    rewardPlanResult,
    rewardPlan,
    resolvedRewardEntries,
    resolvedPocketState,
    roomEntry,
  });
}

function createCacheInventoryArtifact({
  resolveAbyssalStructureType,
  TYPE_ABYSSAL_BIOCOMBINATIVE_CACHE,
  markRewardCacheUnavailable,
  buildRewardCacheSpawnState,
  resolvePlaceholderDurationMs,
  buildRewardCacheCustomInfo,
  isIntentionallyEmptyObservedRunRoomRewardPlan,
  getRewardTierMultiplierApplied,
  resolveRoomOriginPosition,
  toReal,
  cloneValue,
  publishCacheInventoryArtifact,
}, attempt) {
  const { cacheProfile, deps, resolvedPocketState, contentProfile, roomIndex, rewardProfile, rewardPlan, roomEntry } = attempt;
const structureType = resolveAbyssalStructureType(
    toInt(cacheProfile && cacheProfile.cacheTypeID, TYPE_ABYSSAL_BIOCOMBINATIVE_CACHE),
    deps,
  );
  if (!structureType) {
    markRewardCacheUnavailable(resolvedPocketState, "CACHE_STRUCTURE_TYPE_NOT_FOUND", deps);
    return {
      success: false,
      errorMsg: "CACHE_STRUCTURE_TYPE_NOT_FOUND",
    };
  }

  const rewardSpawnState = buildRewardCacheSpawnState(resolvedPocketState, deps);
  const createResult = deps.createSpaceItemForOwner(
    resolvedPocketState.characterID,
    resolvedPocketState.solarSystemID,
    structureType,
    {
      itemName: normalizeText(structureType.name, "Triglavian Biocombinative Cache"),
      ...rewardSpawnState,
      createdAtMs: toInt(deps.now(), 0),
      expiresAtMs: toInt(
        resolvedPocketState &&
          resolvedPocketState.timerState &&
          resolvedPocketState.timerState.expiresAtMs,
        toInt(deps.now(), 0) + resolvePlaceholderDurationMs(contentProfile, deps),
      ),
      customInfo: buildRewardCacheCustomInfo(resolvedPocketState, {
        roomIndex,
        role: "cache_structure",
        cacheProfileID: normalizeText(
          cacheProfile.cacheProfileID,
          normalizeText(cacheProfile.cacheFamily, ""),
        ),
        rewardProfileID: rewardProfile.rewardProfileID,
        allowEmptyManifest: isIntentionallyEmptyObservedRunRoomRewardPlan(
          resolvedPocketState,
          rewardProfile,
          rewardPlan,
        ),
        rewardMultiplier: getRewardTierMultiplierApplied(
          rewardProfile,
          resolvedPocketState,
        ),
        roomRewardMultiplier: Number(rewardProfile.roomMultiplier) || 1,
        rewardQuantityBonus: toInt(rewardProfile.rewardQuantityBonus, 0),
        cacheRewardMaterialized: false,
        deliveryState: normalizeText(roomEntry.deliveryState, ""),
        transitionToken: toInt(roomEntry.deliveryTransitionToken, 0),
        selectedRoomLayoutID: normalizeText(roomEntry.selectedRoomLayoutID, ""),
        roomOriginPosition: resolveRoomOriginPosition(resolvedPocketState, roomIndex),
        authoredLocalPosition: Array.isArray(rewardSpawnState.dunPosition)
          ? {
              x: toReal(rewardSpawnState.dunPosition[0], 0),
              y: toReal(rewardSpawnState.dunPosition[1], 0),
              z: toReal(rewardSpawnState.dunPosition[2], 0),
            }
          : null,
        worldPosition: cloneValue(rewardSpawnState.position),
      }),
    },
  );
  if (!createResult || !createResult.success || !createResult.data) {
    markRewardCacheUnavailable(
      resolvedPocketState,
      createResult && createResult.errorMsg || "CACHE_CREATE_FAILED",
      deps,
    );
    return {
      success: false,
      errorMsg: createResult && createResult.errorMsg || "CACHE_CREATE_FAILED",
    };
  }
  return publishCacheInventoryArtifact({
    ...attempt,
    structureType,
    rewardSpawnState,
    createResult,
  });
}

function publishCacheInventoryArtifact({
  ABYSSAL_ROOM_DELIVERY_STATE,
  spawnPocketDynamicInventoryEntity,
  ABYSSAL_ROOM_ENTITY_ROLES,
  resolveRoomOriginPosition,
  toReal,
  markRewardCacheUnavailable,
  recordCreatedCacheArtifact,
}, attempt) {
  const { createResult, roomEntry, resolvedPocketState, deps, options, numericInstanceID, roomIndex, rewardSpawnState } = attempt;
const rewardCacheItem = createResult.data;

  const cacheDeliveryState = normalizeText(roomEntry.deliveryState, "");
  const deferInitialPublication =
    cacheDeliveryState === ABYSSAL_ROOM_DELIVERY_STATE.PREWARMED_HIDDEN;
  const spawnResult = spawnPocketDynamicInventoryEntity(
    resolvedPocketState,
    rewardCacheItem.itemID,
    deps,
    {
      broadcast: options.broadcast !== false,
      initialPublication: deferInitialPublication ? "deferred" : undefined,
      suppressInitialPublication: deferInitialPublication,
      runtimeEntityMetadata: deferInitialPublication
        ? {
            abyssalRunID: numericInstanceID,
            abyssalRoomIndex: roomIndex,
            abyssalEntityRole: ABYSSAL_ROOM_ENTITY_ROLES.REWARD_CACHE,
            abyssalRoomDeliveryState: cacheDeliveryState,
            evejsAbyssalRoomDeliveryState: cacheDeliveryState,
            abyssalSelectedRoomLayoutID: normalizeText(roomEntry.selectedRoomLayoutID, ""),
            abyssalTransitionToken: toInt(roomEntry.deliveryTransitionToken, 0),
            evejsAbyssalRoomOriginPosition: resolveRoomOriginPosition(
              resolvedPocketState,
              roomIndex,
            ),
            evejsAbyssalAuthoredLocalPosition: Array.isArray(rewardSpawnState.dunPosition)
              ? {
                  x: toReal(rewardSpawnState.dunPosition[0], 0),
                  y: toReal(rewardSpawnState.dunPosition[1], 0),
                  z: toReal(rewardSpawnState.dunPosition[2], 0),
                }
              : null,
          }
        : undefined,
    },
  );
  if (!spawnResult || !spawnResult.success) {
    deps.removeInventoryItem(rewardCacheItem.itemID, { removeContents: true });
    markRewardCacheUnavailable(
      resolvedPocketState,
      spawnResult && spawnResult.errorMsg || "CACHE_SPAWN_FAILED",
      deps,
    );
    return {
      success: false,
      errorMsg: spawnResult && spawnResult.errorMsg || "CACHE_SPAWN_FAILED",
    };
  }
  return recordCreatedCacheArtifact({
    ...attempt,
    rewardCacheItem,
    cacheDeliveryState,
    deferInitialPublication,
    spawnResult,
  });
}

function recordCreatedCacheArtifact({
  syncInventoryChanges,
  cloneValue,
  setPlaceholderRoomEntry,
  updatePocketState,
  buildPocketStateForCurrentRoom,
  log,
  formatVectorForLog,
}, attempt) {
  const {
    session,
    createResult,
    deps,
    rewardState,
    rewardPlan,
    rewardCacheItem,
    structureType,
    resolvedRewardEntries,
    cacheProfile,
    resolvedPocketState,
    roomIndex,
    roomEntry,
    numericInstanceID,
    rewardSpawnState,
  } = attempt;
syncInventoryChanges(session, createResult.changes || [], deps);
  const repaired = toInt(rewardState.cacheSpawnedAtMs, 0) > 0;
  const nextRewardState = {
    ...rewardState,
    cacheRewardPlan: cloneValue(rewardPlan),
    cacheItemID: toInt(rewardCacheItem.itemID, 0),
    cacheStructureItemID: toInt(rewardCacheItem.itemID, 0),
    cacheStructureTypeID: toInt(structureType.typeID, 0),
    cacheLootContainerItemID: toInt(rewardState.cacheLootContainerItemID, 0),
    cacheRewardEntries: cloneValue(resolvedRewardEntries),
    cacheRewardMaterialized: rewardState.cacheRewardMaterialized === true,
    cacheSpawnedAtMs: toInt(deps.now(), 0),
    cacheRepairAttempts: repaired
      ? toInt(rewardState.cacheRepairAttempts, 0) + 1
      : toInt(rewardState.cacheRepairAttempts, 0),
    spawnMode: "destroyable_structure_pending_loot",
    rewardTypeID: 0,
    rewardQuantity: 0,
    contentsGranted: false,
    optionalExit: cacheProfile.optionalExit !== false,
    unavailableReason: "",
    suppressedReason: null,
  };
  const nextRoomState = setPlaceholderRoomEntry(
    resolvedPocketState,
    roomIndex,
    {
      ...roomEntry,
      cacheRewardPlan: cloneValue(rewardPlan),
      cacheItemID: toInt(rewardCacheItem.itemID, 0),
      cacheStructureItemID: toInt(rewardCacheItem.itemID, 0),
      cacheLootContainerItemID: toInt(rewardState.cacheLootContainerItemID, 0),
      cacheRewardEntries: cloneValue(resolvedRewardEntries),
      cacheRewardMaterialized: rewardState.cacheRewardMaterialized === true,
      cacheSpawnedAtMs: toInt(deps.now(), 0),
      cacheLifecycleState: normalizeText(nextRewardState.spawnMode, ""),
      unavailableReason: "",
      suppressedReason: "",
      rewardTypeID: 0,
      rewardQuantity: 0,
      contentsGranted: false,
    },
  );
  const updatedPocketState = updatePocketState(numericInstanceID, {
    ...buildPocketStateForCurrentRoom(resolvedPocketState, nextRoomState),
    rewardState: nextRewardState,
  });
  const effectivePocketState = updatedPocketState || resolvedPocketState;
  log.info(
    `[AbyssalMgr] Abyssal reward structure spawned instance=${effectivePocketState.instanceID} ` +
      `room=${roomIndex} role=cache itemID=${rewardCacheItem.itemID} ` +
      `typeID=${toInt(structureType.typeID, 0)} position=${formatVectorForLog(rewardSpawnState.position)}`,
  );
  return {
    success: true,
    created: repaired !== true,
    repaired,
    data: effectivePocketState,
  };
}

// Capture supplied capabilities once, as the original closure did. Internal
// callbacks are bound once per instance; no runtime state lives in this wiring.
function createAbyssalRewardCacheCreation({
  toReal,
  getDependencies,
  getCacheProfile,
  getPlaceholderRoomEntry,
  getRewardState,
  resolveRoomRewardProfile,
  ensureAbyssalRewardPlan,
  cloneValue,
  isIntentionallyEmptyObservedRunRoomRewardPlan,
  setPlaceholderRoomEntry,
  buildPlaceholderRoomState,
  buildPocketStateForCurrentRoom,
  updatePocketState,
  ensureAbyssalPocketPersistenceReady,
  spawnPocketDynamicInventoryEntity,
  log,
  getActivePocketStateByInstanceID,
  clampRoomIndex,
  retryPendingAbyssalRewardMaterializations,
  getAbyssalRoomRewardSuppressionReason,
  markRewardCacheConsumedOrRemoved,
  markRewardCacheUnavailable,
  hasFailedTimeoutOutcome,
  getContentProfile,
  resolveRoomEncounterProfile,
  summarizeRewardLootEntries,
  listGuaranteedRewardLootEntries,
  resolveAbyssalStructureType,
  buildRewardCacheSpawnState,
  resolvePlaceholderDurationMs,
  buildRewardCacheCustomInfo,
  getRewardTierMultiplierApplied,
  resolveRoomOriginPosition,
  syncInventoryChanges,
  formatVectorForLog,
  TYPE_ABYSSAL_BIOCOMBINATIVE_CACHE,
  PLACEHOLDER_REWARD_CACHE_MAX_REPAIRS,
  ABYSSAL_ROOM_DELIVERY_STATE,
  ABYSSAL_ROOM_ENTITY_ROLES,
  reconcileUntrackedAbyssalRewardCacheArtifacts,
}) {

  const ports = {
    toReal,
    getDependencies,
    getCacheProfile,
    getPlaceholderRoomEntry,
    getRewardState,
    resolveRoomRewardProfile,
    ensureAbyssalRewardPlan,
    cloneValue,
    isIntentionallyEmptyObservedRunRoomRewardPlan,
    setPlaceholderRoomEntry,
    buildPlaceholderRoomState,
    buildPocketStateForCurrentRoom,
    updatePocketState,
    ensureAbyssalPocketPersistenceReady,
    spawnPocketDynamicInventoryEntity,
    log,
    getActivePocketStateByInstanceID,
    clampRoomIndex,
    retryPendingAbyssalRewardMaterializations,
    getAbyssalRoomRewardSuppressionReason,
    markRewardCacheConsumedOrRemoved,
    markRewardCacheUnavailable,
    hasFailedTimeoutOutcome,
    getContentProfile,
    resolveRoomEncounterProfile,
    summarizeRewardLootEntries,
    listGuaranteedRewardLootEntries,
    resolveAbyssalStructureType,
    buildRewardCacheSpawnState,
    resolvePlaceholderDurationMs,
    buildRewardCacheCustomInfo,
    getRewardTierMultiplierApplied,
    resolveRoomOriginPosition,
    syncInventoryChanges,
    formatVectorForLog,
    TYPE_ABYSSAL_BIOCOMBINATIVE_CACHE,
    PLACEHOLDER_REWARD_CACHE_MAX_REPAIRS,
    ABYSSAL_ROOM_DELIVERY_STATE,
    ABYSSAL_ROOM_ENTITY_ROLES,
    reconcileUntrackedAbyssalRewardCacheArtifacts,
  };
  ports.ensurePlaceholderRewardCache = ensurePlaceholderRewardCache.bind(null, ports);
  ports.inspectCacheCreationState = inspectCacheCreationState.bind(null, ports);
  ports.reconcileCacheBeforeCreation = reconcileCacheBeforeCreation.bind(null, ports);
  ports.prepareCacheCreationContent = prepareCacheCreationContent.bind(null, ports);
  ports.createCacheInventoryArtifact = createCacheInventoryArtifact.bind(null, ports);
  ports.publishCacheInventoryArtifact = publishCacheInventoryArtifact.bind(null, ports);
  ports.recordCreatedCacheArtifact = recordCreatedCacheArtifact.bind(null, ports);
  Object.freeze(ports);
  return Object.freeze({ ensurePlaceholderRewardCache: ports.ensurePlaceholderRewardCache });
}

module.exports = { createAbyssalRewardCacheCreation };
