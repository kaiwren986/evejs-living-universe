"use strict";

const { normalizeText } = require("../domain/abyssalValueUtils");

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

// Optional extraction-node creation and restart reconciliation. Selection stays
// with the versioned content policy; state, inventory and runtime are explicit ports.
function reconcileObsoleteTranquilExtractionState({
  getDependencies,
  isTranquilAbyssalContent,
  getPlaceholderRoomEntry,
  listUniquePositiveInts,
  removeObsoleteExtractionArtifact,
  setPlaceholderRoomEntry,
  updatePocketState,
  buildPocketStateForCurrentRoom,
  log,
},
  pocketState,
  roomIndex,
  deps = getDependencies(),
) {
  const numericRoomIndex = toInt(roomIndex, 0);
  if (
    !isTranquilAbyssalContent(pocketState) ||
    (numericRoomIndex !== 2 && numericRoomIndex !== 3)
  ) {
    return {
      success: true,
      skipped: true,
      data: pocketState,
    };
  }

  const roomEntry = getPlaceholderRoomEntry(pocketState, numericRoomIndex);
  const structureItemIDs = listUniquePositiveInts([
    ...listUniquePositiveInts(roomEntry.extractionNodeItemIDs),
    ...listUniquePositiveInts(roomEntry.extractionNodeHistoricalItemIDs),
    ...listUniquePositiveInts(roomEntry.extractionNodeRewardMaterializedItemIDs),
  ]);
  const lootContainerItemIDs = listUniquePositiveInts(
    roomEntry.extractionNodeLootContainerItemIDs,
  );
  const hasObsoleteState =
    structureItemIDs.length > 0 ||
    lootContainerItemIDs.length > 0 ||
    toInt(roomEntry.extractionNodeSpawnedAtMs, 0) > 0 ||
    normalizeText(roomEntry.extractionNodeProfileID, "").includes("tranquil");
  if (!hasObsoleteState) {
    return {
      success: true,
      skipped: true,
      data: pocketState,
    };
  }

  const instanceID = toInt(pocketState && pocketState.instanceID, 0);
  const traceItemID = toInt(pocketState && pocketState.traceItemID, 0);
  const removalResults = [];
  const ownershipMismatches = [];
  const attempt = { deps, instanceID, traceItemID, numericRoomIndex, pocketState, removalResults, ownershipMismatches };

  for (const itemID of structureItemIDs) {
    removeObsoleteExtractionArtifact(attempt,
      itemID,
      "extraction_node_structure",
      0,
      "obsolete non-retail Tranquil extraction node",
    );
  }
  for (const itemID of lootContainerItemIDs) {
    removeObsoleteExtractionArtifact(attempt,
      itemID,
      "extraction_node_loot_container",
      0,
      "obsolete non-retail Tranquil extraction reward container",
    );
  }

  const failedResults = removalResults.filter((result) => result && result.failed === true);
  if (ownershipMismatches.length > 0 || failedResults.length > 0) {
    return {
      success: false,
      errorMsg: ownershipMismatches.length > 0
        ? "ABYSSAL_TRANQUIL_EXTRACTION_OWNERSHIP_MISMATCH"
        : "ABYSSAL_TRANQUIL_EXTRACTION_REMOVAL_FAILED",
      ownershipMismatches,
      removalResults,
      data: pocketState,
    };
  }

  const obsoleteItemIDs = new Set([...structureItemIDs, ...lootContainerItemIDs]);
  const nextRoomState = setPlaceholderRoomEntry(
    pocketState,
    numericRoomIndex,
    {
      ...roomEntry,
      extractionNodeItemIDs: [],
      extractionNodeHistoricalItemIDs: [],
      extractionNodeLootContainerItemIDs: [],
      extractionNodeRewardMaterializedItemIDs: [],
      extractionNodeSpawnedAtMs: 0,
      extractionNodeLifecycleState: "removed_non_retail_captured_profile",
      extractionNodeProfileID: "abyssal:extraction:none",
      deliveredEntityIDs: listUniquePositiveInts(roomEntry.deliveredEntityIDs)
        .filter((itemID) => !obsoleteItemIDs.has(itemID)),
    },
  );
  const updatedPocketState = updatePocketState(instanceID, {
    ...buildPocketStateForCurrentRoom(pocketState, nextRoomState),
  }) || pocketState;
  log.info(
    `[AbyssalMgr] Removed obsolete non-retail Tranquil extraction state ` +
      `instance=${instanceID} trace=${traceItemID} room=${numericRoomIndex} ` +
      `structures=${structureItemIDs.length} lootContainers=${lootContainerItemIDs.length} ` +
      `removed=${removalResults.filter((result) => result && result.removed === true).length} ` +
      `alreadyGone=${removalResults.filter((result) => result && result.alreadyGone === true).length}`,
  );
  return {
    success: true,
    migrated: true,
    removalResults,
    data: updatedPocketState,
  };
}

function removeObsoleteExtractionArtifact({
  readExtractionNodeStateFromItem,
  destroyPlaceholderTrace,
  buildAbyssalSceneDescriptor,
}, attempt, itemID, expectedRole, expectedTypeID, itemLabel) {
  const {
    deps,
    instanceID,
    traceItemID,
    numericRoomIndex,
    pocketState,
    removalResults,
    ownershipMismatches,
  } = attempt;

  const item = typeof deps.findItemById === "function" ? deps.findItemById(itemID) : null;
  if (item) {
    const artifactState = readExtractionNodeStateFromItem(item);
    const stateMatchesRun =
      artifactState &&
      toInt(artifactState.instanceID, 0) === instanceID &&
      toInt(artifactState.roomIndex, 0) === numericRoomIndex &&
      normalizeText(artifactState.role, "") === expectedRole &&
      (
        traceItemID <= 0 ||
        toInt(artifactState.traceItemID, 0) <= 0 ||
        toInt(artifactState.traceItemID, 0) === traceItemID
      );
    const typeMatches = expectedTypeID <= 0 || toInt(item.typeID, 0) === expectedTypeID;
    if (!stateMatchesRun || !typeMatches) {
      ownershipMismatches.push(itemID);
      return;
    }
  }
  removalResults.push(destroyPlaceholderTrace(
    toInt(pocketState && pocketState.solarSystemID, 0),
    itemID,
    deps,
    "tranquil-obsolete-extraction-removal",
    itemLabel,
    {
      sceneDescriptor: buildAbyssalSceneDescriptor(pocketState, deps) || undefined,
    },
  ));
}

function reconcileUntrackedAbyssalExtractionArtifacts({
  getDependencies,
  listAuthoritativeAbyssalRoomRewardArtifacts,
  TYPE_ABYSSAL_EXTRACTION_SUBNODE,
  TYPE_ABYSSAL_EXTRACTION_NODE,
  readExtractionNodeStateFromItem,
  TYPE_ABYSSAL_EXTRACTION_SUBNODE_WRECK,
  TYPE_ABYSSAL_EXTRACTION_NODE_WRECK,
  failClosedAbyssalRewardArtifactReconciliation,
  selectExtractionArtifactSurvivors,
},
  pocketState,
  roomIndex,
  extractionNodeProfile,
  deps = getDependencies(),
) {
  const profileID = normalizeText(
    extractionNodeProfile && extractionNodeProfile.extractionNodeProfileID,
    "",
  );
  const structureScan = listAuthoritativeAbyssalRoomRewardArtifacts(
    pocketState,
    roomIndex,
    deps,
    {
      role: "extraction_node_structure",
      typeIDs: [TYPE_ABYSSAL_EXTRACTION_SUBNODE, TYPE_ABYSSAL_EXTRACTION_NODE],
      profileID,
      stateReader: readExtractionNodeStateFromItem,
    },
  );
  const containerScan = listAuthoritativeAbyssalRoomRewardArtifacts(
    pocketState,
    roomIndex,
    deps,
    {
      role: "extraction_node_loot_container",
      typeIDs: [
        TYPE_ABYSSAL_EXTRACTION_SUBNODE_WRECK,
        TYPE_ABYSSAL_EXTRACTION_NODE_WRECK,
      ],
      profileID,
      stateReader: readExtractionNodeStateFromItem,
      requireSourceStructure: true,
    },
  );
  if (!structureScan.supported || !containerScan.supported) {
    return {
      success: false,
      reconciled: false,
      errorMsg: "ABYSSAL_EXTRACTION_ARTIFACT_SCAN_FAILED",
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
        errorMsg: "ABYSSAL_EXTRACTION_ARTIFACT_OWNERSHIP_AMBIGUOUS",
        suppressionReason: "EXTRACTION_ARTIFACT_OWNERSHIP_AMBIGUOUS",
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
  return selectExtractionArtifactSurvivors({
    pocketState,
    roomIndex,
    deps,
    profileID,
    structures,
    containers,
    ambiguous,
  });
}

function selectExtractionArtifactSurvivors({
  getPlaceholderRoomEntry,
  listUniquePositiveInts,
  restoreExtractionArtifactSurvivors,
}, attempt) {
  const {
    pocketState,
    roomIndex,
    structures,
    containers,
  } = attempt;
  const roomEntry = getPlaceholderRoomEntry(pocketState, roomIndex);
  const trackedStructureIDs = listUniquePositiveInts(roomEntry.extractionNodeItemIDs);
  const trackedContainerIDs = listUniquePositiveInts(
    roomEntry.extractionNodeLootContainerItemIDs,
  );
  const materializedSourceIDs = listUniquePositiveInts(
    roomEntry.extractionNodeRewardMaterializedItemIDs,
  );
  const recordsByNodeIndex = new Map();
  const addRecord = (record, kind) => {
    const nodeIndex = Math.max(1, toInt(record && record.state && record.state.nodeIndex, 1));
    const group = recordsByNodeIndex.get(nodeIndex) || { structures: [], containers: [] };
    group[kind].push(record);
    recordsByNodeIndex.set(nodeIndex, group);
  };
  structures.forEach((record) => addRecord(record, "structures"));
  containers.forEach((record) => addRecord(record, "containers"));

  const adoptedStructures = [];
  const adoptedContainers = [];
  const duplicateRecords = [];
  const consumedStructureIDs = [];
  for (const [, group] of [...recordsByNodeIndex.entries()].sort((left, right) => left[0] - right[0])) {
    const primaryContainer = group.containers.find((entry) => (
      trackedContainerIDs.includes(entry.itemID)
    )) || group.containers[0] || null;
    if (primaryContainer) {
      adoptedContainers.push(primaryContainer);
      duplicateRecords.push(
        ...group.containers.filter((entry) => entry.itemID !== primaryContainer.itemID),
        ...group.structures,
      );
      continue;
    }
    const primaryStructure = group.structures.find((entry) => (
      trackedStructureIDs.includes(entry.itemID)
    )) || group.structures[0] || null;
    if (!primaryStructure) {
      continue;
    }
    if (materializedSourceIDs.includes(primaryStructure.itemID)) {
      consumedStructureIDs.push(primaryStructure.itemID);
      duplicateRecords.push(...group.structures);
      continue;
    }
    adoptedStructures.push(primaryStructure);
    duplicateRecords.push(
      ...group.structures.filter((entry) => entry.itemID !== primaryStructure.itemID),
    );
  }
  return restoreExtractionArtifactSurvivors({
    ...attempt,
    roomEntry,
    trackedStructureIDs,
    trackedContainerIDs,
    materializedSourceIDs,
    adoptedStructures,
    adoptedContainers,
    duplicateRecords,
    consumedStructureIDs,
  });
}

function restoreExtractionArtifactSurvivors({
  spawnPocketDynamicInventoryEntity,
  listUniquePositiveInts,
  persistExtractionArtifactSurvivors,
}, attempt) {
  const {
    pocketState,
    deps,
    ambiguous,
    trackedStructureIDs,
    trackedContainerIDs,
    adoptedStructures,
    adoptedContainers,
    duplicateRecords,
    consumedStructureIDs,
  } = attempt;
  const adoptedRecords = [...adoptedStructures, ...adoptedContainers];
  for (const record of adoptedRecords) {
    const spawnResult = spawnPocketDynamicInventoryEntity(
      pocketState,
      record.itemID,
      deps,
      { broadcast: false },
    );
    if (!spawnResult || spawnResult.success !== true) {
      return {
        success: false,
        reconciled: false,
        errorMsg: normalizeText(
          spawnResult && spawnResult.errorMsg,
          "ABYSSAL_EXTRACTION_ARTIFACT_RUNTIME_RESTORE_FAILED",
        ),
        data: pocketState,
      };
    }
  }

  const adoptedStructureIDs = adoptedStructures.map((entry) => entry.itemID);
  const adoptedContainerIDs = adoptedContainers.map((entry) => entry.itemID);
  const adoptedContainerSourceIDs = adoptedContainers.map((entry) => (
    toInt(entry.state && entry.state.sourceStructureItemID, 0)
  )).filter((itemID) => itemID > 0);
  const sameItemIDs = (left, right) => {
    const normalizedLeft = listUniquePositiveInts(left).sort((a, b) => a - b);
    const normalizedRight = listUniquePositiveInts(right).sort((a, b) => a - b);
    return normalizedLeft.length === normalizedRight.length &&
      normalizedLeft.every((itemID, index) => itemID === normalizedRight[index]);
  };
  if (
    duplicateRecords.length === 0 &&
    consumedStructureIDs.length === 0 &&
    sameItemIDs(adoptedStructureIDs, trackedStructureIDs) &&
    sameItemIDs(adoptedContainerIDs, trackedContainerIDs)
  ) {
    return {
      success: true,
      reconciled: false,
      foundTrackedArtifact: true,
      ambiguousItemIDs: ambiguous.map((entry) => entry.itemID),
      data: pocketState,
    };
  }
  return persistExtractionArtifactSurvivors({
    ...attempt,
    adoptedRecords,
    adoptedStructureIDs,
    adoptedContainerIDs,
    adoptedContainerSourceIDs,
  });
}

function persistExtractionArtifactSurvivors({
  listUniquePositiveInts,
  setPlaceholderRoomEntry,
  updatePocketState,
  buildPocketStateForCurrentRoom,
  ensureAbyssalPocketPersistenceReady,
  removeDuplicateAbyssalRoomRewardArtifacts,
  failClosedAbyssalRewardArtifactReconciliation,
  log,
}, attempt) {
  const {
    pocketState,
    roomIndex,
    deps,
    profileID,
    structures,
    containers,
    ambiguous,
    roomEntry,
    trackedStructureIDs,
    trackedContainerIDs,
    materializedSourceIDs,
    adoptedStructures,
    adoptedContainers,
    duplicateRecords,
    consumedStructureIDs,
    adoptedRecords,
    adoptedStructureIDs,
    adoptedContainerIDs,
    adoptedContainerSourceIDs,
  } = attempt;
  const scannedArtifactIDs = new Set([
    ...structures.map((entry) => entry.itemID),
    ...containers.map((entry) => entry.itemID),
    ...trackedStructureIDs,
    ...trackedContainerIDs,
  ]);
  const nextMaterializedSourceIDs = listUniquePositiveInts([
    ...materializedSourceIDs,
    ...adoptedContainerSourceIDs,
    ...consumedStructureIDs,
  ]).filter((itemID) => !adoptedStructureIDs.includes(itemID));
  const nextLifecycleState = adoptedStructureIDs.length > 0
    ? adoptedContainerIDs.length > 0
      ? "partially_destroyed_loot_containers_spawned"
      : "spawned"
    : adoptedContainerIDs.length > 0
      ? "structure_destroyed_loot_container_spawned"
      : "consumed_or_removed";
  const nextRoomEntry = {
    ...roomEntry,
    extractionNodeItemIDs: adoptedStructureIDs,
    extractionNodeHistoricalItemIDs: listUniquePositiveInts([
      ...listUniquePositiveInts(roomEntry.extractionNodeHistoricalItemIDs),
      ...structures.map((entry) => entry.itemID),
      ...adoptedContainerSourceIDs,
      ...consumedStructureIDs,
    ]),
    extractionNodeLootContainerItemIDs: adoptedContainerIDs,
    extractionNodeRewardMaterializedItemIDs: nextMaterializedSourceIDs,
    extractionNodeSpawnedAtMs: Math.max(
      1,
      toInt(roomEntry.extractionNodeSpawnedAtMs, toInt(deps.now(), Date.now())),
    ),
    extractionNodeLifecycleState: nextLifecycleState,
    extractionNodeProfileID: profileID,
    deliveredEntityIDs: listUniquePositiveInts([
      ...listUniquePositiveInts(roomEntry.deliveredEntityIDs)
        .filter((itemID) => !scannedArtifactIDs.has(itemID)),
      ...adoptedStructureIDs,
      ...adoptedContainerIDs,
    ]),
  };
  const nextRoomState = setPlaceholderRoomEntry(
    pocketState,
    roomIndex,
    nextRoomEntry,
  );
  const updatedPocketState = updatePocketState(pocketState.instanceID, {
    ...buildPocketStateForCurrentRoom(pocketState, nextRoomState),
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
  const duplicateRemovalResults = removeDuplicateAbyssalRoomRewardArtifacts(
    updatedPocketState,
    duplicateRecords,
    deps,
    "extraction-reward-restart-reconciliation",
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
        errorMsg: "ABYSSAL_EXTRACTION_ARTIFACT_DUPLICATE_CLEANUP_FAILED",
        suppressionReason: "EXTRACTION_ARTIFACT_DUPLICATE_CLEANUP_FAILED",
        failedItemIDs: failedDuplicateItemIDs,
        duplicateRemovalResults,
      },
    );
  }
  log.warn(
    `[AbyssalMgr] Reconciled untracked extraction artifacts ` +
      `instance=${toInt(updatedPocketState.instanceID, 0)} room=${toInt(roomIndex, 0)} ` +
      `structures=${adoptedStructureIDs.join(",") || "none"} ` +
      `containers=${adoptedContainerIDs.join(",") || "none"} ` +
      `duplicates=${duplicateRecords.map((entry) => entry.itemID).join(",") || "none"} ` +
      `ambiguous=${ambiguous.map((entry) => entry.itemID).join(",") || "none"}`,
  );
  return {
    success: true,
    reconciled: true,
    adoptedItemID: toInt(adoptedRecords[0] && adoptedRecords[0].itemID, 0),
    adoptedItemIDs: adoptedRecords.map((entry) => entry.itemID),
    adoptedRole: adoptedContainers.length > 0
      ? "extraction_node_loot_container"
      : adoptedStructures.length > 0
        ? "extraction_node_structure"
        : "consumed_or_removed",
    duplicateRemovalResults,
    ambiguousItemIDs: ambiguous.map((entry) => entry.itemID),
    data: updatedPocketState,
  };
}

function ensurePlaceholderExtractionNodes({
  getDependencies,
  getActivePocketStateByInstanceID,
  cloneValue,
  buildPlaceholderRoomState,
  clampRoomIndex,
  getPlaceholderRoomEntry,
  retryPendingAbyssalRewardMaterializations,
  getAbyssalRoomRewardSuppressionReason,
  reconcileObsoleteTranquilExtractionState,
  resolveRoomEncounterProfile,
  resolveRoomExtractionNodeProfile,
  log,
  summarizeRewardLootEntries,
  reconcileExtractionNodesBeforeCreation,
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
  if (
    roomEntry.extractionNodeRewardRetryIntentsByItemID &&
    Object.keys(roomEntry.extractionNodeRewardRetryIntentsByItemID).length > 0
  ) {
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
  const rewardSuppressionReason = getAbyssalRoomRewardSuppressionReason(
    resolvedPocketState,
    roomIndex,
  );
  if (rewardSuppressionReason) {
    return {
      success: true,
      created: false,
      skipped: true,
      reason: rewardSuppressionReason,
      data: resolvedPocketState,
    };
  }
  const obsoleteStateResult = reconcileObsoleteTranquilExtractionState(
    resolvedPocketState,
    roomIndex,
    deps,
  );
  if (!obsoleteStateResult.success) {
    return obsoleteStateResult;
  }
  resolvedPocketState = obsoleteStateResult.data || resolvedPocketState;
  roomEntry = getPlaceholderRoomEntry(resolvedPocketState, roomIndex);
  const encounterProfile = options.encounterProfile || resolveRoomEncounterProfile(
    resolvedPocketState,
    roomIndex,
    {
      logResolution: false,
    },
  );
  const extractionNodeProfile = resolveRoomExtractionNodeProfile(
    resolvedPocketState,
    roomIndex,
    {
      encounterProfile,
    },
  );
  if (
    !extractionNodeProfile ||
    extractionNodeProfile.enabled !== true ||
    extractionNodeProfile.eligibleForRoom !== true ||
    Math.max(
      0,
      toInt(
        extractionNodeProfile.maximumSpawnCount,
        extractionNodeProfile.spawnCount,
      ),
    ) <= 0
  ) {
    return {
      success: true,
      skipped: true,
      data: resolvedPocketState,
    };
  }
  log.info(
    `[AbyssalMgr] Extraction node profile resolved char=${resolvedPocketState.characterID} ` +
      `instance=${resolvedPocketState.instanceID} trace=${resolvedPocketState.traceItemID} ` +
      `room=${roomIndex}/${roomState.implementedRooms} ` +
      `profile=${normalizeText(extractionNodeProfile.extractionNodeProfileID, "unknown")} ` +
      `spawnRange=${toInt(extractionNodeProfile.minimumSpawnCount, extractionNodeProfile.spawnCount)}-` +
        `${toInt(extractionNodeProfile.maximumSpawnCount, extractionNodeProfile.spawnCount)} ` +
      `guaranteed="${summarizeRewardLootEntries(extractionNodeProfile.guaranteedLootEntries)}"`,
  );
  return reconcileExtractionNodesBeforeCreation({
    session,
    deps,
    options,
    numericInstanceID,
    resolvedPocketState,
    roomIndex,
    roomEntry,
    extractionNodeProfile,
  });
}

function reconcileExtractionNodesBeforeCreation({
  reconcileUntrackedAbyssalExtractionArtifacts,
  listUniquePositiveInts,
  setPlaceholderRoomEntry,
  updatePocketState,
  buildPocketStateForCurrentRoom,
  hasFailedTimeoutOutcome,
  createExtractionNodes,
}, attempt) {
  const {
    session,
    deps,
    options,
    numericInstanceID,
    resolvedPocketState,
    roomIndex,
    roomEntry,
    extractionNodeProfile,
  } = attempt;
  const artifactReconciliation = reconcileUntrackedAbyssalExtractionArtifacts(
    resolvedPocketState,
    roomIndex,
    extractionNodeProfile,
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
  const trackedItemIDs = listUniquePositiveInts(roomEntry.extractionNodeItemIDs);
  const existingItemIDs = trackedItemIDs
    .filter((itemID) => deps.findItemById(itemID));
  if (existingItemIDs.length > 0) {
    return {
      success: true,
      created: false,
      skipped: true,
      data: resolvedPocketState,
    };
  }
  if (trackedItemIDs.length > 0) {
    const nextRoomState = setPlaceholderRoomEntry(
      resolvedPocketState,
      roomIndex,
      {
        ...roomEntry,
        extractionNodeItemIDs: [],
        extractionNodeLifecycleState: "consumed_or_removed",
        extractionNodeProfileID: normalizeText(
          roomEntry.extractionNodeProfileID,
          extractionNodeProfile.extractionNodeProfileID,
        ),
      },
    );
    const updatedPocketState = updatePocketState(numericInstanceID, {
      ...buildPocketStateForCurrentRoom(resolvedPocketState, nextRoomState),
    });
    return {
      success: true,
      created: false,
      skipped: true,
      data: updatedPocketState || resolvedPocketState,
    };
  }
  if (hasFailedTimeoutOutcome(resolvedPocketState)) {
    return {
      success: true,
      created: false,
      skipped: true,
      data: resolvedPocketState,
    };
  }
  if (toInt(roomEntry.extractionNodeSpawnedAtMs, 0) > 0) {
    const nextRoomState = setPlaceholderRoomEntry(
      resolvedPocketState,
      roomIndex,
      {
        ...roomEntry,
        extractionNodeItemIDs: [],
        extractionNodeLifecycleState: "consumed_or_removed",
        extractionNodeProfileID: normalizeText(
          roomEntry.extractionNodeProfileID,
          extractionNodeProfile.extractionNodeProfileID,
        ),
      },
    );
    const updatedPocketState = updatePocketState(numericInstanceID, {
      ...buildPocketStateForCurrentRoom(resolvedPocketState, nextRoomState),
    });
    return {
      success: true,
      created: false,
      skipped: true,
      data: updatedPocketState || resolvedPocketState,
    };
  }
  return createExtractionNodes(attempt);
}

function createExtractionNodes({
  buildExtractionNodeSpawnStates,
  materializeExtractionNode,
  syncInventoryChanges,
  setPlaceholderRoomEntry,
  listUniquePositiveInts,
  updatePocketState,
  buildPocketStateForCurrentRoom,
}, attempt) {
  const {
    session,
    deps,
    options,
    numericInstanceID,
    resolvedPocketState,
    roomIndex,
    roomEntry,
    extractionNodeProfile,
  } = attempt;
  const spawnStates = buildExtractionNodeSpawnStates(
    resolvedPocketState,
    extractionNodeProfile,
    roomIndex,
    deps,
  );
  const createdItemIDs = [];
  const plannedTypeIDs = [];
  const changes = [];
  const materialization = { ...attempt, createdItemIDs, plannedTypeIDs, changes };
  for (const spawnState of spawnStates) {
    materializeExtractionNode(materialization, spawnState);
  }

  if (changes.length > 0) {
    syncInventoryChanges(session, changes, deps);
  }
  const nextRoomState = setPlaceholderRoomEntry(
    resolvedPocketState,
    roomIndex,
    {
      ...roomEntry,
      extractionNodeItemIDs: createdItemIDs,
      extractionNodeHistoricalItemIDs: listUniquePositiveInts([
        ...listUniquePositiveInts(roomEntry.extractionNodeHistoricalItemIDs),
        ...createdItemIDs,
      ]),
      extractionNodeLootContainerItemIDs: listUniquePositiveInts(roomEntry.extractionNodeLootContainerItemIDs),
      extractionNodeRewardMaterializedItemIDs: listUniquePositiveInts(roomEntry.extractionNodeRewardMaterializedItemIDs),
      extractionNodePlannedCount: spawnStates.length,
      extractionNodePlannedTypeIDs: plannedTypeIDs,
      extractionNodeSelectionKey:
        `${numericInstanceID}:${roomIndex}:${normalizeText(extractionNodeProfile.extractionNodeProfileID, "")}`,
      extractionNodeSpawnedAtMs: createdItemIDs.length > 0 ? toInt(deps.now(), 0) : 0,
      extractionNodeLifecycleState: createdItemIDs.length > 0 ? "spawned" : "",
      extractionNodeProfileID: normalizeText(extractionNodeProfile.extractionNodeProfileID, ""),
    },
  );
  const updatedPocketState = updatePocketState(numericInstanceID, {
    ...buildPocketStateForCurrentRoom(resolvedPocketState, nextRoomState),
  });
  return {
    success: createdItemIDs.length > 0,
    created: createdItemIDs.length > 0,
    skipped: createdItemIDs.length <= 0,
    data: updatedPocketState || resolvedPocketState,
  };
}

function materializeExtractionNode({
  resolveAbyssalStructureType,
  TYPE_ABYSSAL_EXTRACTION_NODE,
  resolvePlaceholderDurationMs,
  getContentProfile,
  buildExtractionNodeCustomInfo,
  ABYSSAL_EARLY_VISIBILITY_STATES,
  spawnPocketDynamicInventoryEntity,
  ABYSSAL_ROOM_ENTITY_ROLES,
  ABYSSAL_ROOM_DELIVERY_STATE,
  resolveRoomOriginPosition,
  toReal,
  log,
  formatVectorForLog,
}, attempt, spawnState) {
  const {
    deps,
    options,
    numericInstanceID,
    resolvedPocketState,
    roomIndex,
    roomEntry,
    extractionNodeProfile,
    createdItemIDs,
    plannedTypeIDs,
    changes,
  } = attempt;

  const structureType = resolveAbyssalStructureType(
    toInt(spawnState.structureTypeID, TYPE_ABYSSAL_EXTRACTION_NODE),
    deps,
  );
  if (!structureType) {
    return;
  }
  plannedTypeIDs.push(toInt(structureType.typeID, 0));
  const createResult = deps.createSpaceItemForOwner(
    resolvedPocketState.characterID,
    resolvedPocketState.solarSystemID,
    structureType,
    {
      itemName: normalizeText(
        structureType.name,
        "Triglavian Extraction Node",
      ),
      ...spawnState,
      createdAtMs: toInt(deps.now(), 0),
      expiresAtMs: toInt(
        resolvedPocketState &&
          resolvedPocketState.timerState &&
          resolvedPocketState.timerState.expiresAtMs,
        toInt(deps.now(), 0) + resolvePlaceholderDurationMs(getContentProfile(resolvedPocketState), deps),
      ),
      customInfo: buildExtractionNodeCustomInfo(resolvedPocketState, {
        roomIndex,
        role: "extraction_node_structure",
        extractionNodeProfileID: extractionNodeProfile.extractionNodeProfileID,
        nodeIndex: spawnState.nodeIndex,
      }),
    },
  );
  if (!createResult || !createResult.success || !createResult.data) {
    return;
  }
  const extractionNodeItem = createResult.data;
  const extractionNodeDeliveryState = normalizeText(roomEntry.deliveryState, "");
  const deferInitialPublication =
    options.broadcast === false ||
    ABYSSAL_EARLY_VISIBILITY_STATES.has(extractionNodeDeliveryState);
  const spawnResult = spawnPocketDynamicInventoryEntity(
    resolvedPocketState,
    extractionNodeItem.itemID,
    deps,
    {
      broadcast: options.broadcast !== false,
      initialPublication: deferInitialPublication ? "deferred" : undefined,
      suppressInitialPublication: deferInitialPublication,
      runtimeEntityMetadata: deferInitialPublication
        ? {
            abyssalRunID: numericInstanceID,
            abyssalRoomIndex: roomIndex,
            abyssalEntityRole: ABYSSAL_ROOM_ENTITY_ROLES.EXTRACTION_NODE,
            abyssalRoomDeliveryState: extractionNodeDeliveryState ||
              ABYSSAL_ROOM_DELIVERY_STATE.PREWARMED_HIDDEN,
            evejsAbyssalRoomDeliveryState: extractionNodeDeliveryState ||
              ABYSSAL_ROOM_DELIVERY_STATE.PREWARMED_HIDDEN,
            abyssalSelectedRoomLayoutID: normalizeText(roomEntry.selectedRoomLayoutID, ""),
            abyssalTransitionToken: toInt(roomEntry.deliveryTransitionToken, 0),
            evejsAbyssalRoomOriginPosition: resolveRoomOriginPosition(
              resolvedPocketState,
              roomIndex,
            ),
            evejsAbyssalAuthoredLocalPosition: {
              x: toReal(spawnState.dunPosition && spawnState.dunPosition[0], 0),
              y: toReal(spawnState.dunPosition && spawnState.dunPosition[1], 0),
              z: toReal(spawnState.dunPosition && spawnState.dunPosition[2], 0),
            },
          }
        : undefined,
    },
  );
  if (!spawnResult || !spawnResult.success) {
    deps.removeInventoryItem(extractionNodeItem.itemID, { removeContents: true });
    return;
  }
  createdItemIDs.push(toInt(extractionNodeItem.itemID, 0));
  changes.push(...(createResult.changes || []));
  log.info(
    `[AbyssalMgr] Abyssal reward structure spawned instance=${resolvedPocketState.instanceID} ` +
      `room=${roomIndex} role=extraction-node itemID=${toInt(extractionNodeItem.itemID, 0)} ` +
      `typeID=${toInt(structureType.typeID, 0)} position=${formatVectorForLog(spawnState.position)}`,
  );
}

// Capture supplied capabilities once, as the original closure did. Internal
// callbacks are bound once per instance; no runtime state lives in this wiring.
function createAbyssalExtractionNodes({
  getDependencies,
  isTranquilAbyssalContent,
  getPlaceholderRoomEntry,
  listUniquePositiveInts,
  readExtractionNodeStateFromItem,
  destroyPlaceholderTrace,
  buildAbyssalSceneDescriptor,
  setPlaceholderRoomEntry,
  updatePocketState,
  buildPocketStateForCurrentRoom,
  log,
  listAuthoritativeAbyssalRoomRewardArtifacts,
  failClosedAbyssalRewardArtifactReconciliation,
  spawnPocketDynamicInventoryEntity,
  ensureAbyssalPocketPersistenceReady,
  removeDuplicateAbyssalRoomRewardArtifacts,
  getActivePocketStateByInstanceID,
  cloneValue,
  buildPlaceholderRoomState,
  clampRoomIndex,
  retryPendingAbyssalRewardMaterializations,
  getAbyssalRoomRewardSuppressionReason,
  resolveRoomEncounterProfile,
  resolveRoomExtractionNodeProfile,
  summarizeRewardLootEntries,
  hasFailedTimeoutOutcome,
  buildExtractionNodeSpawnStates,
  resolveAbyssalStructureType,
  resolvePlaceholderDurationMs,
  getContentProfile,
  buildExtractionNodeCustomInfo,
  resolveRoomOriginPosition,
  toReal,
  formatVectorForLog,
  syncInventoryChanges,
  TYPE_ABYSSAL_EXTRACTION_SUBNODE,
  TYPE_ABYSSAL_EXTRACTION_NODE,
  TYPE_ABYSSAL_EXTRACTION_SUBNODE_WRECK,
  TYPE_ABYSSAL_EXTRACTION_NODE_WRECK,
  ABYSSAL_EARLY_VISIBILITY_STATES,
  ABYSSAL_ROOM_ENTITY_ROLES,
  ABYSSAL_ROOM_DELIVERY_STATE,
}) {

  const ports = {
    getDependencies,
    isTranquilAbyssalContent,
    getPlaceholderRoomEntry,
    listUniquePositiveInts,
    readExtractionNodeStateFromItem,
    destroyPlaceholderTrace,
    buildAbyssalSceneDescriptor,
    setPlaceholderRoomEntry,
    updatePocketState,
    buildPocketStateForCurrentRoom,
    log,
    listAuthoritativeAbyssalRoomRewardArtifacts,
    failClosedAbyssalRewardArtifactReconciliation,
    spawnPocketDynamicInventoryEntity,
    ensureAbyssalPocketPersistenceReady,
    removeDuplicateAbyssalRoomRewardArtifacts,
    getActivePocketStateByInstanceID,
    cloneValue,
    buildPlaceholderRoomState,
    clampRoomIndex,
    retryPendingAbyssalRewardMaterializations,
    getAbyssalRoomRewardSuppressionReason,
    resolveRoomEncounterProfile,
    resolveRoomExtractionNodeProfile,
    summarizeRewardLootEntries,
    hasFailedTimeoutOutcome,
    buildExtractionNodeSpawnStates,
    resolveAbyssalStructureType,
    resolvePlaceholderDurationMs,
    getContentProfile,
    buildExtractionNodeCustomInfo,
    resolveRoomOriginPosition,
    toReal,
    formatVectorForLog,
    syncInventoryChanges,
    TYPE_ABYSSAL_EXTRACTION_SUBNODE,
    TYPE_ABYSSAL_EXTRACTION_NODE,
    TYPE_ABYSSAL_EXTRACTION_SUBNODE_WRECK,
    TYPE_ABYSSAL_EXTRACTION_NODE_WRECK,
    ABYSSAL_EARLY_VISIBILITY_STATES,
    ABYSSAL_ROOM_ENTITY_ROLES,
    ABYSSAL_ROOM_DELIVERY_STATE,
  };
  ports.reconcileObsoleteTranquilExtractionState = reconcileObsoleteTranquilExtractionState.bind(null, ports);
  ports.removeObsoleteExtractionArtifact = removeObsoleteExtractionArtifact.bind(null, ports);
  ports.reconcileUntrackedAbyssalExtractionArtifacts = reconcileUntrackedAbyssalExtractionArtifacts.bind(null, ports);
  ports.selectExtractionArtifactSurvivors = selectExtractionArtifactSurvivors.bind(null, ports);
  ports.restoreExtractionArtifactSurvivors = restoreExtractionArtifactSurvivors.bind(null, ports);
  ports.persistExtractionArtifactSurvivors = persistExtractionArtifactSurvivors.bind(null, ports);
  ports.ensurePlaceholderExtractionNodes = ensurePlaceholderExtractionNodes.bind(null, ports);
  ports.reconcileExtractionNodesBeforeCreation = reconcileExtractionNodesBeforeCreation.bind(null, ports);
  ports.createExtractionNodes = createExtractionNodes.bind(null, ports);
  ports.materializeExtractionNode = materializeExtractionNode.bind(null, ports);
  Object.freeze(ports);
  return Object.freeze({
    reconcileObsoleteTranquilExtractionState: ports.reconcileObsoleteTranquilExtractionState,
    reconcileUntrackedAbyssalExtractionArtifacts: ports.reconcileUntrackedAbyssalExtractionArtifacts,
    ensurePlaceholderExtractionNodes: ports.ensurePlaceholderExtractionNodes,
  });
}

module.exports = { createAbyssalExtractionNodes };
