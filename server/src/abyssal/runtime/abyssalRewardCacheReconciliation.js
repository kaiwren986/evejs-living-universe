"use strict";

const { createAbyssalRewardMaterializationExecutor } = require("./abyssalRewardMaterializationExecutor");
const { normalizeText } = require("../domain/abyssalValueUtils");

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

// No retained state; each operation carries only its own attempt-local values.
function reconcileUntrackedAbyssalRewardCacheArtifacts({
  getDependencies,
  getCacheProfile,
  TYPE_ABYSSAL_BIOCOMBINATIVE_CACHE,
  resolveRewardContainerType,
  listAuthoritativeAbyssalRoomRewardArtifacts,
  readRewardCacheStateFromItem,
  failClosedAbyssalRewardArtifactReconciliation,
  resolveRecoveredCacheRewardPlan,
},
  pocketState,
  roomIndex,
  deps = getDependencies(),
) {

  const cacheProfile = getCacheProfile(pocketState) || {};
  const structureTypeID = toInt(
    cacheProfile.cacheTypeID,
    TYPE_ABYSSAL_BIOCOMBINATIVE_CACHE,
  );
  const containerType = resolveRewardContainerType(cacheProfile, deps);
  const containerTypeID = toInt(containerType && containerType.typeID, 0);
  const structureScan = listAuthoritativeAbyssalRoomRewardArtifacts(
    pocketState,
    roomIndex,
    deps,
    {
      role: "cache_structure",
      typeID: structureTypeID,
      stateReader: readRewardCacheStateFromItem,
    },
  );
  const containerScan = containerTypeID > 0
    ? listAuthoritativeAbyssalRoomRewardArtifacts(
        pocketState,
        roomIndex,
        deps,
        {
          role: "cache_loot_container",
          typeID: containerTypeID,
          stateReader: readRewardCacheStateFromItem,
          requireSourceStructure: true,
        },
      )
    : { supported: true, authoritative: [], ambiguous: [] };
  if (!structureScan.supported || !containerScan.supported) {
    return {
      success: false,
      reconciled: false,
      errorMsg: "ABYSSAL_REWARD_ARTIFACT_SCAN_FAILED",
      scanErrorMsg: structureScan.errorMsg || containerScan.errorMsg || "",
      data: pocketState,
    };
  }
  const structures = structureScan.authoritative;
  const containers = containerScan.authoritative;
  const ambiguous = [
    ...structureScan.ambiguous,
    ...containerScan.ambiguous,
  ];
  if (ambiguous.length > 0) {
    return failClosedAbyssalRewardArtifactReconciliation(
      pocketState,
      roomIndex,
      deps,
      {
        errorMsg: "ABYSSAL_REWARD_ARTIFACT_OWNERSHIP_AMBIGUOUS",
        suppressionReason: "REWARD_ARTIFACT_OWNERSHIP_AMBIGUOUS",
        ambiguousItemIDs: ambiguous.map((entry) => entry.itemID),
      },
    );
  }
  if (structures.length <= 0 && containers.length <= 0) {
    return {
      success: true,
      reconciled: false,
      data: pocketState,
    };
  }
  return resolveRecoveredCacheRewardPlan({
    pocketState,
    roomIndex,
    deps,
    cacheProfile,
    structureTypeID,
    containerType,
    containerTypeID,
    structureScan,
    containerScan,
    structures,
    containers,
    ambiguous,
  });
}

function resolveRecoveredCacheRewardPlan({
  getPlaceholderRoomEntry,
  getRewardState,
  resolveRoomRewardProfile,
  ensureAbyssalRewardPlan,
  cloneValue,
  isIntentionallyEmptyObservedRunRoomRewardPlan,
  hasLegacyObservedRunRewardPlanState,
  setPlaceholderRoomEntry,
  buildPlaceholderRoomState,
  buildPocketStateForCurrentRoom,
  updatePocketState,
  selectRecoveredCacheArtifact,
}, attempt) {
  const { pocketState, roomIndex, deps } = attempt;
let roomEntry = getPlaceholderRoomEntry(pocketState, roomIndex);
  let rewardState = getRewardState(pocketState) || {};
  const rewardProfile = resolveRoomRewardProfile(pocketState, roomIndex, {
    logResolution: false,
  });
  const rewardPlanResult = ensureAbyssalRewardPlan(
    pocketState,
    roomIndex,
    rewardProfile,
    deps,
  );
  if (!rewardPlanResult.success) {
    return rewardPlanResult;
  }
  const reconciledPocketState = rewardPlanResult.data || pocketState;
  roomEntry = getPlaceholderRoomEntry(reconciledPocketState, roomIndex);
  rewardState = getRewardState(reconciledPocketState) || {};
  const rewardPlan = rewardPlanResult.rewardPlan;
  const rewardEntries = cloneValue(rewardPlan.entries);
  const allowsEmptyObservedRunRoomAllocation =
    isIntentionallyEmptyObservedRunRoomRewardPlan(
      reconciledPocketState,
      rewardProfile,
      rewardPlan,
    );
  const observedRunLootAllocation = rewardProfile &&
    rewardProfile.rewardMode === "observed_empirical_complete_run_outcome" &&
    rewardProfile.observedRunLootAllocation &&
    typeof rewardProfile.observedRunLootAllocation === "object"
    ? rewardProfile.observedRunLootAllocation
    : null;
  const observedRunAllocationRoomIndex = observedRunLootAllocation
    && observedRunLootAllocation.model ===
      "whole_observed_run_outcome_in_final_room_cache"
    ? Math.max(1, toInt(observedRunLootAllocation.roomIndex, 3))
    : hasLegacyObservedRunRewardPlanState(reconciledPocketState, rewardProfile)
      ? 3
      : 0;
  if (
    observedRunAllocationRoomIndex > 0 &&
    toInt(roomIndex, 0) !== observedRunAllocationRoomIndex &&
    rewardEntries.length === 0
  ) {
    const nextRoomState = setPlaceholderRoomEntry(reconciledPocketState, roomIndex, {
      ...roomEntry,
      cacheRewardPlan: rewardPlan,
      cacheRewardEntries: [],
      cacheRewardMaterialized: true,
      cacheLifecycleState: "observed_run_intermediate_empty",
      rewardTypeID: 0,
      rewardQuantity: 0,
      contentsGranted: false,
      unavailableReason: "",
      suppressedReason: "",
    });
    const currentRoomIndex = buildPlaceholderRoomState(reconciledPocketState).currentRoomIndex;
    const roomPatch = toInt(roomIndex, 0) === toInt(currentRoomIndex, 0)
      ? buildPocketStateForCurrentRoom(reconciledPocketState, nextRoomState)
      : { roomState: nextRoomState };
    const updatedPocketState = updatePocketState(reconciledPocketState.instanceID, {
      ...roomPatch,
      rewardState: toInt(roomIndex, 0) === toInt(currentRoomIndex, 0)
        ? {
            ...cloneValue(rewardState),
            cacheRewardPlan: rewardPlan,
            cacheRewardEntries: [],
            cacheRewardMaterialized: true,
            cacheLifecycleState: "observed_run_intermediate_empty",
            rewardTypeID: 0,
            rewardQuantity: 0,
            contentsGranted: false,
            unavailableReason: "",
            suppressedReason: "",
          }
        : cloneValue(rewardState),
    }) || reconciledPocketState;
    return {
      success: true,
      reconciled: true,
      intentionallyEmpty: true,
      rewardPlan,
      data: updatedPocketState,
    };
  }
  return selectRecoveredCacheArtifact({
    ...attempt,
    roomEntry,
    rewardState,
    rewardProfile,
    rewardPlanResult,
    reconciledPocketState,
    rewardPlan,
    rewardEntries,
    allowsEmptyObservedRunRoomAllocation,
    observedRunLootAllocation,
    observedRunAllocationRoomIndex,
  });
}

function selectRecoveredCacheArtifact({
  resolveAbyssalRewardGrantManifest,
  removeDuplicateAbyssalRoomRewardArtifacts,
  failClosedAbyssalRewardArtifactReconciliation,
  listUniquePositiveInts,
  restoreRecoveredCacheArtifact,
}, attempt) {
  const { allowsEmptyObservedRunRoomAllocation, rewardEntries, deps, pocketState, structures, containers, roomIndex, roomEntry } = attempt;
const expectedManifestResult = allowsEmptyObservedRunRoomAllocation
    ? {
        success: true,
        grantEntries: [],
        blueprintCopies: [],
        manifest: [],
        rewardTypeID: 0,
        rewardQuantity: 0,
      }
    : resolveAbyssalRewardGrantManifest(
        rewardEntries,
        deps,
      );
  if (!expectedManifestResult.success) {
    const invalidArtifactRemovalResults = removeDuplicateAbyssalRoomRewardArtifacts(
      pocketState,
      [...structures, ...containers],
      deps,
      "reward-manifest-validation-failed",
    );
    return failClosedAbyssalRewardArtifactReconciliation(
      pocketState,
      roomIndex,
      deps,
      {
        errorMsg: expectedManifestResult.errorMsg,
        suppressionReason: "REWARD_MANIFEST_INVALID",
        failedItemIDs: invalidArtifactRemovalResults
          .filter((entry) => entry.result && entry.result.failed === true)
          .map((entry) => entry.itemID),
        duplicateRemovalResults: invalidArtifactRemovalResults,
      },
    );
  }
  const trackedContainerID = toInt(roomEntry.cacheLootContainerItemID, 0);
  const trackedStructureIDs = listUniquePositiveInts([
    roomEntry.cacheItemID,
    roomEntry.cacheStructureItemID,
  ]);
  const primaryContainer = containers.find((entry) => entry.itemID === trackedContainerID) ||
    containers[0] || null;
  const primaryStructure = primaryContainer
    ? null
    : structures.find((entry) => trackedStructureIDs.includes(entry.itemID)) ||
      structures[0] || null;
  const primaryRecord = primaryContainer || primaryStructure;
  const primaryItemID = toInt(primaryRecord && primaryRecord.itemID, 0);
  if (primaryItemID <= 0) {
    return {
      success: false,
      reconciled: false,
      errorMsg: "ABYSSAL_REWARD_ARTIFACT_RECONCILE_FAILED",
      data: pocketState,
    };
  }
  const materializationAlreadyClaimed = Boolean(
    primaryStructure && roomEntry.cacheRewardMaterialized === true
  );
  return restoreRecoveredCacheArtifact({
    ...attempt,
    expectedManifestResult,
    trackedContainerID,
    trackedStructureIDs,
    primaryContainer,
    primaryStructure,
    primaryRecord,
    primaryItemID,
    materializationAlreadyClaimed,
  });
}

function restoreRecoveredCacheArtifact({
  verifyRecoveredCacheContainer,
  spawnPocketDynamicInventoryEntity,
  persistRecoveredCacheArtifact,
}, attempt) {
  const {
    primaryStructure,
    trackedStructureIDs,
    primaryItemID,
    structures,
    containers,
    ambiguous,
    pocketState,
    primaryContainer,
    trackedContainerID,
    roomEntry,
    expectedManifestResult,
    materializationAlreadyClaimed,
    deps,
  } = attempt;
  const verification = verifyRecoveredCacheContainer(attempt);
  if (verification.success === false) return verification;
  const verifiedContainerContents = verification.verifiedContainerContents;

  if (
    (
      primaryStructure &&
      trackedStructureIDs.includes(primaryItemID) &&
      structures.length === 1 &&
      containers.length === 0
    )
  ) {
    return {
      success: true,
      reconciled: false,
      foundTrackedArtifact: true,
      ambiguousItemIDs: ambiguous.map((entry) => entry.itemID),
      data: pocketState,
    };
  }
  if (
    primaryContainer &&
    primaryItemID === trackedContainerID &&
    containers.length === 1 &&
    structures.length === 0 &&
    roomEntry.cacheRewardMaterialized === true &&
    roomEntry.contentsGranted === true &&
    toInt(roomEntry.rewardQuantity, 0) === expectedManifestResult.rewardQuantity
  ) {
    return {
      success: true,
      reconciled: false,
      foundTrackedArtifact: true,
      ambiguousItemIDs: ambiguous.map((entry) => entry.itemID),
      data: pocketState,
    };
  }
  if (!materializationAlreadyClaimed) {
    const spawnResult = spawnPocketDynamicInventoryEntity(
      pocketState,
      primaryItemID,
      deps,
      { broadcast: false },
    );
    if (!spawnResult || spawnResult.success !== true) {
      return {
        success: false,
        reconciled: false,
        errorMsg: normalizeText(
          spawnResult && spawnResult.errorMsg,
          "ABYSSAL_REWARD_ARTIFACT_RUNTIME_RESTORE_FAILED",
        ),
        data: pocketState,
      };
    }
  }
  return persistRecoveredCacheArtifact({
    ...attempt,
    verification,
    verifiedContainerContents,
  });
}

function persistRecoveredCacheArtifact({
  buildRecoveredCacheContainerState,
  buildClaimedCacheStructureState,
  buildRecoveredCacheStructureState,
  setPlaceholderRoomEntry,
  updatePocketState,
  buildPocketStateForCurrentRoom,
  ensureAbyssalPocketPersistenceReady,
  removeDuplicateAbyssalRoomRewardArtifacts,
  failClosedAbyssalRewardArtifactReconciliation,
  log,
}, attempt) {
  const {
    primaryContainer,
    materializationAlreadyClaimed,
    pocketState,
    roomIndex,
    deps,
    structures,
    containers,
    primaryItemID,
    ambiguous,
  } = attempt;
  const { nextRoomEntry, nextRewardState } = primaryContainer
    ? buildRecoveredCacheContainerState(attempt)
    : materializationAlreadyClaimed
      ? buildClaimedCacheStructureState(attempt)
      : buildRecoveredCacheStructureState(attempt);
const nextRoomState = setPlaceholderRoomEntry(
    pocketState,
    roomIndex,
    nextRoomEntry,
  );
  const updatedPocketState = updatePocketState(pocketState.instanceID, {
    ...buildPocketStateForCurrentRoom(pocketState, nextRoomState),
    rewardState: nextRewardState,
  }) || pocketState;
  const persistenceResult = ensureAbyssalPocketPersistenceReady(updatedPocketState, deps);
  if (!persistenceResult.success) {
    return {
      success: false,
      reconciled: false,
      errorMsg: "ABYSSAL_RUN_STATE_PERSIST_FAILED",
      persistenceResult,
      data: updatedPocketState,
    };
  }
  const duplicateRecords = materializationAlreadyClaimed
    ? [...structures, ...containers]
    : [
        ...structures,
        ...containers,
      ].filter((entry) => entry.itemID !== primaryItemID);
  const duplicateRemovalResults = removeDuplicateAbyssalRoomRewardArtifacts(
    updatedPocketState,
    duplicateRecords,
    deps,
    "reward-cache-restart-reconciliation",
  );
  const failedDuplicateItemIDs = duplicateRemovalResults
    .filter((entry) => entry.result && entry.result.failed === true)
    .map((entry) => entry.itemID);
  if (failedDuplicateItemIDs.length > 0) {
    return failClosedAbyssalRewardArtifactReconciliation(
      updatedPocketState,
      roomIndex,
      deps,
      {
        errorMsg: "ABYSSAL_REWARD_ARTIFACT_DUPLICATE_CLEANUP_FAILED",
        suppressionReason: "REWARD_ARTIFACT_DUPLICATE_CLEANUP_FAILED",
        failedItemIDs: failedDuplicateItemIDs,
        duplicateRemovalResults,
      },
    );
  }
  log.warn(
    `[AbyssalMgr] Reconciled untracked reward artifact ` +
      `instance=${toInt(updatedPocketState.instanceID, 0)} room=${toInt(roomIndex, 0)} ` +
      `role=${primaryContainer ? "cache-loot-container" : materializationAlreadyClaimed ? "consumed-structure" : "cache-structure"} ` +
      `itemID=${primaryItemID} duplicates=${duplicateRecords.map((entry) => entry.itemID).join(",") || "none"} ` +
      `ambiguous=${ambiguous.map((entry) => entry.itemID).join(",") || "none"}`,
  );
  return {
    success: true,
    reconciled: true,
    adoptedItemID: materializationAlreadyClaimed ? 0 : primaryItemID,
    adoptedRole: primaryContainer
      ? "cache_loot_container"
      : materializationAlreadyClaimed
        ? "consumed_or_removed"
        : "cache_structure",
    duplicateRemovalResults,
    ambiguousItemIDs: ambiguous.map((entry) => entry.itemID),
    data: updatedPocketState,
  };
}

function grantEmptyRecoveredCacheContainer({
  buildAbyssalRewardManifestReceiptKey,
  isTerminalAbyssalRewardMaterializationError,
  inspectAbyssalRewardContainerManifest,
}, attempt) {
  const { deps, pocketState, roomIndex, primaryItemID, primaryContainer, expectedManifestResult } = attempt;

    if (typeof deps.grantItemsToOwnerLocationIdempotent !== "function") {
      return {
        success: false,
        reconciled: false,
        retryable: true,
        errorMsg: "REWARD_BATCH_GRANT_UNAVAILABLE",
        data: pocketState,
      };
    }
    const receiptKey = buildAbyssalRewardManifestReceiptKey(
      pocketState,
      roomIndex,
      primaryItemID,
      toInt(primaryContainer.state && primaryContainer.state.sourceStructureItemID, 0),
    );
    const retryGrantExecution = createAbyssalRewardMaterializationExecutor({
      grantItemsToOwnerLocationIdempotent:
        deps.grantItemsToOwnerLocationIdempotent,
    }).executeMaterialization({
      recipientOwnerID: pocketState.characterID,
      destinationLocationID: primaryItemID,
      destinationFlagID: 0,
      grantEntries: expectedManifestResult.grantEntries,
      receiptKey,
      grantOptions: {
        receiptKey,
        grantedAtMs: toInt(deps.now(), 0),
        receiptMetadata: {
          instanceID: toInt(pocketState.instanceID, 0),
          roomIndex: toInt(roomIndex, 0),
          containerItemID: primaryItemID,
          kind: "abyssal_reward_manifest_restart_retry",
        },
      },
    });
    const retryGrantResult = retryGrantExecution.physicalResult;
    if (!retryGrantResult || retryGrantResult.success !== true) {
      const errorMsg = normalizeText(
        retryGrantResult && retryGrantResult.errorMsg,
        "REWARD_MANIFEST_GRANT_FAILED",
      );
      return {
        success: false,
        reconciled: false,
        retryable: !isTerminalAbyssalRewardMaterializationError(errorMsg),
        ambiguous: retryGrantResult && retryGrantResult.ambiguous === true,
        errorMsg,
        grantResult: retryGrantResult,
        data: pocketState,
      };
    }
    const verifiedContainerContents = inspectAbyssalRewardContainerManifest(
      primaryItemID,
      expectedManifestResult.manifest,
      pocketState.characterID,
      deps,
    );

  return { verifiedContainerContents };
}

function persistRecoveredCacheManifestMismatch({
  cloneValue,
  setPlaceholderRoomEntry,
  updatePocketState,
  buildPocketStateForCurrentRoom,
  ensureAbyssalPocketPersistenceReady,
}, attempt) {
  const {
    roomEntry,
    primaryContainer,
    structureTypeID,
    rewardEntries,
    allowsEmptyObservedRunRoomAllocation,
    primaryItemID,
    reconciledPocketState,
    roomIndex,
    deps,
    verifiedContainerContents,
  } = attempt;

    const existingRetryIntent = roomEntry.cacheRewardRetryIntent &&
      typeof roomEntry.cacheRewardRetryIntent === "object"
      ? cloneValue(roomEntry.cacheRewardRetryIntent)
      : {};
    const retainedItem = primaryContainer.item || {};
    const mismatchRetryIntent = {
      ...existingRetryIntent,
      kind: "cache",
      sourceStructureItemID: toInt(
        primaryContainer.state && primaryContainer.state.sourceStructureItemID,
        toInt(existingRetryIntent.sourceStructureItemID, 0),
      ),
      sourceStructureTypeID: toInt(
        primaryContainer.state && primaryContainer.state.sourceStructureTypeID,
        toInt(existingRetryIntent.sourceStructureTypeID, structureTypeID),
      ),
      lootEntries: cloneValue(rewardEntries),
      allowEmptyManifest: allowsEmptyObservedRunRoomAllocation,
      spawnState: cloneValue(existingRetryIntent.spawnState) || {
        position: cloneValue(retainedItem.position),
        velocity: cloneValue(retainedItem.velocity),
        direction: cloneValue(retainedItem.direction),
      },
      attemptCount: Math.max(0, toInt(existingRetryIntent.attemptCount, 0)) + 1,
      retainedContainerItemID: primaryItemID,
      lastError: "REWARD_CONTAINER_MANIFEST_MISMATCH",
      reconciliationRequired: true,
    };
    const mismatchRoomState = setPlaceholderRoomEntry(
      reconciledPocketState,
      roomIndex,
      {
        ...roomEntry,
        cacheRewardMaterialized: false,
        cacheLifecycleState: "reward_retry_pending",
        cacheRewardRetryIntent: mismatchRetryIntent,
        cacheRewardRetryError: "REWARD_CONTAINER_MANIFEST_MISMATCH",
      },
    );
    const mismatchPocketState = updatePocketState(
      reconciledPocketState.instanceID,
      {
        ...buildPocketStateForCurrentRoom(reconciledPocketState, mismatchRoomState),
        rewardState: {
          ...cloneValue(reconciledPocketState.rewardState || {}),
          cacheRewardMaterialized: false,
          cacheLifecycleState: "reward_retry_pending",
          cacheRewardRetryIntent: mismatchRetryIntent,
          unavailableReason: "REWARD_CONTAINER_MANIFEST_MISMATCH",
        },
      },
    ) || reconciledPocketState;
    const persistenceResult = ensureAbyssalPocketPersistenceReady(
      mismatchPocketState,
      deps,
    );
    return {
      success: false,
      reconciled: false,
      retryable: true,
      retryPending: true,
      ambiguous: true,
      reconciliationRequired: true,
      errorMsg: persistenceResult.success
        ? "REWARD_CONTAINER_MANIFEST_MISMATCH"
        : "ABYSSAL_RUN_STATE_PERSIST_FAILED",
      retainedContainerItemID: primaryItemID,
      manifestInspection: verifiedContainerContents,
      persistenceResult,
    data: mismatchPocketState,
  };
}

function verifyRecoveredCacheContainer({
  inspectAbyssalRewardContainerManifest,
  grantEmptyRecoveredCacheContainer,
  persistRecoveredCacheManifestMismatch,
  applyAbyssalBlueprintCopyStates,
}, attempt) {
  const { primaryContainer, primaryItemID, expectedManifestResult, pocketState, deps, reconciledPocketState } = attempt;
let verifiedContainerContents = null;
  if (primaryContainer) {
    verifiedContainerContents = inspectAbyssalRewardContainerManifest(
      primaryItemID,
      expectedManifestResult.manifest,
      pocketState.characterID,
      deps,
    );
    if (!verifiedContainerContents.exact && verifiedContainerContents.empty) {
      const grant = grantEmptyRecoveredCacheContainer(attempt);
      if (grant.success === false) return grant;
      verifiedContainerContents = grant.verifiedContainerContents;
    }
    if (!verifiedContainerContents.exact) {
      return persistRecoveredCacheManifestMismatch({ ...attempt, verifiedContainerContents });
    }
    // Inventory rows and blueprint industry state have separate durable writes.
    // Repair a retained manifest before publication or the tracked-cache fast path.
    const blueprintStateResult = applyAbyssalBlueprintCopyStates(
      { data: { items: verifiedContainerContents.contents } },
      expectedManifestResult,
      deps,
    );
    if (!blueprintStateResult.success) {
      return {
        success: false,
        reconciled: false,
        retryable: true,
        errorMsg: blueprintStateResult.errorMsg,
        retainedContainerItemID: primaryItemID,
        blueprintStateResult,
        data: reconciledPocketState,
      };
    }
  }
  return { verifiedContainerContents };
}

function buildRecoveredCacheContainerState({
  inspectAbyssalRewardContainerManifest,
  markAbyssalRewardPlanGranted,
  buildAbyssalRewardManifestReceiptKey,
  cloneValue,
  listUniquePositiveInts,
}, attempt) {
  const {
    verifiedContainerContents,
    primaryItemID,
    expectedManifestResult,
    pocketState,
    deps,
    rewardPlan,
    reconciledPocketState,
    roomIndex,
    primaryContainer,
    roomEntry,
    rewardEntries,
    structures,
    rewardState,
  } = attempt;

  const contents = verifiedContainerContents ||
    inspectAbyssalRewardContainerManifest(
      primaryItemID,
      expectedManifestResult.manifest,
      pocketState.characterID,
      deps,
    );
  const reconciledRewardPlan = contents.exact
    ? markAbyssalRewardPlanGranted(
        rewardPlan,
        buildAbyssalRewardManifestReceiptKey(
          reconciledPocketState,
          roomIndex,
          primaryItemID,
          toInt(primaryContainer.state && primaryContainer.state.sourceStructureItemID, 0),
        ),
        toInt(deps.now(), Date.now()),
      )
    : rewardPlan;
  const nextRoomEntry = {
    ...roomEntry,
    cacheRewardPlan: reconciledRewardPlan,
    cacheItemID: 0,
    cacheStructureItemID: 0,
    cacheLootContainerItemID: primaryItemID,
    cacheRewardEntries: cloneValue(rewardEntries),
    cacheRewardMaterialized: true,
    cacheLifecycleState: "structure_destroyed_loot_container_spawned",
    rewardTypeID: expectedManifestResult.rewardTypeID,
    rewardQuantity: expectedManifestResult.rewardQuantity,
    contentsGranted:
      contents.exact && expectedManifestResult.manifest.length > 0,
    deliveredEntityIDs: listUniquePositiveInts([
      ...listUniquePositiveInts(roomEntry.deliveredEntityIDs)
        .filter((itemID) => !structures.some((entry) => entry.itemID === itemID)),
      primaryItemID,
    ]),
  };
  const nextRewardState = {
    ...rewardState,
    cacheRewardPlan: reconciledRewardPlan,
    cacheItemID: 0,
    cacheStructureItemID: 0,
    cacheLootContainerItemID: primaryItemID,
    cacheRewardEntries: cloneValue(rewardEntries),
    cacheRewardMaterialized: true,
    cacheLifecycleState: "structure_destroyed_loot_container_spawned",
    rewardTypeID: expectedManifestResult.rewardTypeID,
    rewardQuantity: expectedManifestResult.rewardQuantity,
    contentsGranted:
      contents.exact && expectedManifestResult.manifest.length > 0,
  };

  return { nextRoomEntry, nextRewardState };
}

function buildClaimedCacheStructureState({
  listUniquePositiveInts,
}, attempt) {
  const { structures, roomEntry, rewardPlan, rewardState } = attempt;

  const structureItemIDs = new Set(structures.map((entry) => entry.itemID));
  const nextRoomEntry = {
    ...roomEntry,
    cacheRewardPlan: rewardPlan,
    cacheItemID: 0,
    cacheStructureItemID: 0,
    cacheLootContainerItemID: 0,
    cacheRewardMaterialized: true,
    cacheLifecycleState: "consumed_or_removed",
    unavailableReason: normalizeText(
      roomEntry.unavailableReason,
      "REWARD_MATERIALIZATION_INTERRUPTED",
    ),
    deliveredEntityIDs: listUniquePositiveInts(roomEntry.deliveredEntityIDs)
      .filter((itemID) => !structureItemIDs.has(itemID)),
  };
  const nextRewardState = {
    ...rewardState,
    cacheRewardPlan: rewardPlan,
    cacheItemID: 0,
    cacheStructureItemID: 0,
    cacheLootContainerItemID: 0,
    cacheRewardMaterialized: true,
    cacheLifecycleState: "consumed_or_removed",
    unavailableReason: normalizeText(
      rewardState.unavailableReason,
      "REWARD_MATERIALIZATION_INTERRUPTED",
    ),
  };

  return { nextRoomEntry, nextRewardState };
}

function buildRecoveredCacheStructureState({
  listUniquePositiveInts,
}, attempt) {
  const { roomEntry, rewardPlan, primaryItemID, rewardEntries, deps, rewardState } = attempt;

  const nextRoomEntry = {
    ...roomEntry,
    cacheRewardPlan: rewardPlan,
    cacheItemID: primaryItemID,
    cacheStructureItemID: primaryItemID,
    cacheLootContainerItemID: 0,
    cacheRewardEntries: rewardEntries,
    cacheRewardMaterialized: false,
    cacheSpawnedAtMs: Math.max(
      1,
      toInt(roomEntry.cacheSpawnedAtMs, toInt(deps.now(), Date.now())),
    ),
    cacheLifecycleState: "destroyable_structure_pending_loot",
    unavailableReason: "",
    suppressedReason: "",
    deliveredEntityIDs: listUniquePositiveInts([
      ...listUniquePositiveInts(roomEntry.deliveredEntityIDs),
      primaryItemID,
    ]),
  };
  const nextRewardState = {
    ...rewardState,
    cacheRewardPlan: rewardPlan,
    cacheItemID: primaryItemID,
    cacheStructureItemID: primaryItemID,
    cacheLootContainerItemID: 0,
    cacheRewardEntries: rewardEntries,
    cacheRewardMaterialized: false,
    cacheSpawnedAtMs: nextRoomEntry.cacheSpawnedAtMs,
    cacheLifecycleState: "destroyable_structure_pending_loot",
    spawnMode: "destroyable_structure_pending_loot",
    unavailableReason: "",
    suppressedReason: null,
  };

  return { nextRoomEntry, nextRewardState };
}

// Capture supplied capabilities once, as the original closure did. Internal
// callbacks are bound once per instance; no runtime state lives in this wiring.
function createAbyssalRewardCacheReconciliation({
  markAbyssalRewardPlanGranted,
  applyAbyssalBlueprintCopyStates,
  getDependencies,
  getCacheProfile,
  resolveRewardContainerType,
  listAuthoritativeAbyssalRoomRewardArtifacts,
  readRewardCacheStateFromItem,
  failClosedAbyssalRewardArtifactReconciliation,
  getPlaceholderRoomEntry,
  getRewardState,
  resolveRoomRewardProfile,
  ensureAbyssalRewardPlan,
  cloneValue,
  isIntentionallyEmptyObservedRunRoomRewardPlan,
  hasLegacyObservedRunRewardPlanState,
  setPlaceholderRoomEntry,
  buildPlaceholderRoomState,
  buildPocketStateForCurrentRoom,
  updatePocketState,
  resolveAbyssalRewardGrantManifest,
  removeDuplicateAbyssalRoomRewardArtifacts,
  listUniquePositiveInts,
  inspectAbyssalRewardContainerManifest,
  buildAbyssalRewardManifestReceiptKey,
  isTerminalAbyssalRewardMaterializationError,
  ensureAbyssalPocketPersistenceReady,
  spawnPocketDynamicInventoryEntity,
  log,
  TYPE_ABYSSAL_BIOCOMBINATIVE_CACHE,
}) {

  const ports = {
    markAbyssalRewardPlanGranted,
    applyAbyssalBlueprintCopyStates,
    getDependencies,
    getCacheProfile,
    resolveRewardContainerType,
    listAuthoritativeAbyssalRoomRewardArtifacts,
    readRewardCacheStateFromItem,
    failClosedAbyssalRewardArtifactReconciliation,
    getPlaceholderRoomEntry,
    getRewardState,
    resolveRoomRewardProfile,
    ensureAbyssalRewardPlan,
    cloneValue,
    isIntentionallyEmptyObservedRunRoomRewardPlan,
    hasLegacyObservedRunRewardPlanState,
    setPlaceholderRoomEntry,
    buildPlaceholderRoomState,
    buildPocketStateForCurrentRoom,
    updatePocketState,
    resolveAbyssalRewardGrantManifest,
    removeDuplicateAbyssalRoomRewardArtifacts,
    listUniquePositiveInts,
    inspectAbyssalRewardContainerManifest,
    buildAbyssalRewardManifestReceiptKey,
    isTerminalAbyssalRewardMaterializationError,
    ensureAbyssalPocketPersistenceReady,
    spawnPocketDynamicInventoryEntity,
    log,
    TYPE_ABYSSAL_BIOCOMBINATIVE_CACHE,
  };
  ports.reconcileUntrackedAbyssalRewardCacheArtifacts = reconcileUntrackedAbyssalRewardCacheArtifacts.bind(null, ports);
  ports.resolveRecoveredCacheRewardPlan = resolveRecoveredCacheRewardPlan.bind(null, ports);
  ports.selectRecoveredCacheArtifact = selectRecoveredCacheArtifact.bind(null, ports);
  ports.restoreRecoveredCacheArtifact = restoreRecoveredCacheArtifact.bind(null, ports);
  ports.persistRecoveredCacheArtifact = persistRecoveredCacheArtifact.bind(null, ports);
  ports.grantEmptyRecoveredCacheContainer = grantEmptyRecoveredCacheContainer.bind(null, ports);
  ports.persistRecoveredCacheManifestMismatch = persistRecoveredCacheManifestMismatch.bind(null, ports);
  ports.verifyRecoveredCacheContainer = verifyRecoveredCacheContainer.bind(null, ports);
  ports.buildRecoveredCacheContainerState = buildRecoveredCacheContainerState.bind(null, ports);
  ports.buildClaimedCacheStructureState = buildClaimedCacheStructureState.bind(null, ports);
  ports.buildRecoveredCacheStructureState = buildRecoveredCacheStructureState.bind(null, ports);
  Object.freeze(ports);
  return Object.freeze({ reconcileUntrackedAbyssalRewardCacheArtifacts: ports.reconcileUntrackedAbyssalRewardCacheArtifacts });
}

module.exports = { createAbyssalRewardCacheReconciliation };
