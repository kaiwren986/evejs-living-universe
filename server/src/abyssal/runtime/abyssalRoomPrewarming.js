"use strict";

const { normalizeText } = require("../domain/abyssalValueUtils");

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

// Destination staging and cleanup stay synchronous within the existing mutation
// batch. Room ownership, publication, persistence and removal remain injected.
function prewarmCurrentPlaceholderRoomContent({
  getDependencies,
  spawnPlaceholderPocketContent,
  usesIsolatedAbyssalScene,
  cloneValue,
  buildPlaceholderRoomState,
  getPlaceholderRoomEntry,
  setPlaceholderRoomEntry,
  registerPocket,
},
  validation,
  pocketState,
  session,
  deps = getDependencies(),
) {
  const prewarmResult = spawnPlaceholderPocketContent(
    validation,
    pocketState,
    session,
    deps,
    {
      suppressClientEntryFx: true,
      suppressRoomEnteredLog: true,
      suppressEarlyRewardCache: true,
      prepareOnly: usesIsolatedAbyssalScene(pocketState, deps),
    },
  );
  if (!(prewarmResult && prewarmResult.data)) {
    return prewarmResult;
  }
  const prewarmedPocketState = cloneValue(prewarmResult.data);
  const roomState = buildPlaceholderRoomState(prewarmedPocketState);
  const roomIndex = roomState.currentRoomIndex;
  const currentRoomEntry = getPlaceholderRoomEntry(prewarmedPocketState, roomIndex);
  const nextRoomState = setPlaceholderRoomEntry(
    prewarmedPocketState,
    roomIndex,
    {
      ...currentRoomEntry,
      prewarmedAtMs: toInt(currentRoomEntry.prewarmedAtMs, toInt(deps.now(), 0)),
    },
  );
  const nextPocketState = {
    ...prewarmedPocketState,
    roomState: nextRoomState,
  };
  registerPocket(nextPocketState);
  return {
    ...prewarmResult,
    data: cloneValue(nextPocketState),
  };
}

function createAbyssalPrewarmPhaseRecorder({
  log,
}, prewarmMutationBatch, nextRoomIndex, deps) {
  const prewarmPerfEnabled = deps && deps.abyssalTransitionPerfDiagnosticsEnabled === true;
  const prewarmStartedAtNs = process.hrtime.bigint();
  let prewarmLastPhaseAtNs = prewarmStartedAtNs;
  const recordPrewarmPhase = (phase) => {
    if (!prewarmPerfEnabled) return;
    const nowNs = process.hrtime.bigint();
    log.info(
      `[AbyssalTransitionPerf] run=${prewarmMutationBatch.instanceID} ` +
        `flow=prewarm room=${nextRoomIndex} phase=${phase} ` +
        `phaseMs=${(Number(nowNs - prewarmLastPhaseAtNs) / 1_000_000).toFixed(3)} ` +
        `totalMs=${(Number(nowNs - prewarmStartedAtNs) / 1_000_000).toFixed(3)}`,
    );
    prewarmLastPhaseAtNs = nowNs;
  };
  return recordPrewarmPhase;
}

function materializeAbyssalNextRoomStage({
  getPlaceholderRoomEntry,
  resolveSelectedAbyssalBaseRoomLayoutID,
  setPlaceholderRoomEntry,
  buildRoomShipSpawnState,
  resolveRoomOriginPosition,
  ABYSSAL_ROOM_DELIVERY_STATE,
  buildPocketStateForCurrentRoom,
  buildEncounterStateFromRoomEntry,
  listUniquePositiveInts,
  spawnPlaceholderPocketContent,
}, activePocketState, nextRoomIndex, session, deps) {
  const nextRoomEntry = getPlaceholderRoomEntry(activePocketState, nextRoomIndex);
  const selectedRoomLayoutID = normalizeText(
    resolveSelectedAbyssalBaseRoomLayoutID(
      activePocketState || {},
      nextRoomIndex,
    ),
    normalizeText(
      activePocketState && activePocketState.selectedRoomLayoutIDs &&
        (activePocketState.selectedRoomLayoutIDs[String(nextRoomIndex)] ||
          activePocketState.selectedRoomLayoutIDs[nextRoomIndex]),
      "",
    ),
  );
  const stagedRoomState = setPlaceholderRoomEntry(
    activePocketState,
    nextRoomIndex,
    {
      ...nextRoomEntry,
      enteredAtMs: toInt(nextRoomEntry.enteredAtMs, toInt(deps.now(), 0)),
      shipSpawnState: buildRoomShipSpawnState(activePocketState, nextRoomIndex),
      roomOriginPosition: resolveRoomOriginPosition(activePocketState, nextRoomIndex),
      deliveryState: ABYSSAL_ROOM_DELIVERY_STATE.PREWARMED_HIDDEN,
      deliveryTransitionToken: 0,
      selectedRoomLayoutID,
      deferredInitialPublicationCount: 0,
      duplicateDestinationPublicationCount: 0,
    },
    {
      currentRoomIndex: nextRoomIndex,
      finalExitAvailable: false,
    },
  );
  const stagedPocketState = {
    ...activePocketState,
    ...buildPocketStateForCurrentRoom(activePocketState, stagedRoomState),
    roomState: stagedRoomState,
    encounterState: buildEncounterStateFromRoomEntry(nextRoomEntry),
    hostileEntityIDs: listUniquePositiveInts(nextRoomEntry.hostileEntityIDs),
    objectiveComplete: nextRoomEntry.objectiveComplete === true,
    objectiveCompletedAtMs: toInt(nextRoomEntry.objectiveCompletedAtMs, 0),
    allowDebugExit: false,
  };
  const prewarmResult = spawnPlaceholderPocketContent(
    null,
    stagedPocketState,
    session,
    deps,
    {
      suppressClientEntryFx: true,
      suppressPrewarmClientDelivery: true,
      suppressRoomEnteredLog: true,
      existingPocketStateOverride: stagedPocketState,
      suppressEarlyRewardCache: true,
    },
  );
  return { selectedRoomLayoutID, prewarmResult };
}

function finalizeAbyssalPrewarmPublication({
  getPlaceholderRoomEntry,
  setPlaceholderRoomEntry,
  registerPocket,
  setAbyssalRoomEntityDeliveryState,
  ABYSSAL_ROOM_DELIVERY_STATE,
  ABYSSAL_ROOM_ENTITY_ROLES,
  updatePocketState,
  log,
}, activePocketState, nextRoomIndex, selectedRoomLayoutID, prewarmResult, session, deps, recordPrewarmPhase) {
  const prewarmedRoomEntry = getPlaceholderRoomEntry(prewarmResult.data, nextRoomIndex);
  const mergedRoomState = setPlaceholderRoomEntry(
    activePocketState,
    nextRoomIndex,
    {
      ...prewarmedRoomEntry,
      prewarmedAtMs: toInt(prewarmedRoomEntry.prewarmedAtMs, toInt(deps.now(), 0)),
    },
  );
  const restoredPocketState = {
    ...activePocketState,
    roomState: mergedRoomState,
  };
  registerPocket(restoredPocketState);
  const deliveryStateResult = setAbyssalRoomEntityDeliveryState(
    restoredPocketState,
    nextRoomIndex,
    ABYSSAL_ROOM_DELIVERY_STATE.PREWARMED_HIDDEN,
    session,
    deps,
    { transitionToken: 0 },
  );
  recordPrewarmPhase("delivery-hidden");
  const prewarmedEntities = Array.isArray(deliveryStateResult.entities)
    ? deliveryStateResult.entities
    : [];
  const prewarmSummary = {
    entityCount: prewarmedEntities.length,
    dynamicCount: prewarmedEntities.filter((entity) =>
      entity && entity.kind !== "static" && entity.abyssalVisualOnly !== true
    ).length,
    staticCount: prewarmedEntities.filter((entity) =>
      entity && (entity.kind === "static" || entity.abyssalVisualOnly === true)
    ).length,
    npcCount: prewarmedEntities.filter((entity) =>
      normalizeText(entity && entity.abyssalEntityRole, "") === ABYSSAL_ROOM_ENTITY_ROLES.NPC
    ).length,
    inventoryBackedCount: prewarmedEntities.filter((entity) =>
      entity && entity.inventoryBacked === true
    ).length,
    initialPublicationDeferredCount: prewarmedEntities.filter((entity) =>
      entity && (
        entity.evejsInitialPublicationDeferred === true ||
        normalizeText(entity.abyssalRoomDeliveryState, "") ===
          ABYSSAL_ROOM_DELIVERY_STATE.PREWARMED_HIDDEN
      )
    ).length,
    unexpectedPublishedCount: deliveryStateResult.earlyVisibleEntityIDs.length,
  };
  const summaryRoomEntry = getPlaceholderRoomEntry(
    deliveryStateResult.pocketState,
    nextRoomIndex,
  );
  const summaryRoomState = setPlaceholderRoomEntry(
    deliveryStateResult.pocketState,
    nextRoomIndex,
    {
      ...summaryRoomEntry,
      deferredInitialPublicationCount: prewarmSummary.initialPublicationDeferredCount,
      earlyPublicationViolationCount: prewarmSummary.unexpectedPublishedCount,
      duplicateDestinationPublicationCount: Math.max(
        0,
        toInt(summaryRoomEntry.duplicateDestinationPublicationCount, 0),
      ),
    },
  );
  const summarizedPocketState = updatePocketState(
    toInt(deliveryStateResult.pocketState && deliveryStateResult.pocketState.instanceID, 0),
    { roomState: summaryRoomState },
  ) || deliveryStateResult.pocketState;
  log.info(
    `[AbyssalPrewarmPublication] run=${toInt(summarizedPocketState.instanceID, 0)} ` +
      `room=${nextRoomIndex} ` +
      `layoutID=${selectedRoomLayoutID || "none"} ` +
      `deliveryState=${ABYSSAL_ROOM_DELIVERY_STATE.PREWARMED_HIDDEN} ` +
      `entityCount=${prewarmSummary.entityCount} ` +
      `dynamicCount=${prewarmSummary.dynamicCount} staticCount=${prewarmSummary.staticCount} ` +
      `npcCount=${prewarmSummary.npcCount} ` +
      `inventoryBackedCount=${prewarmSummary.inventoryBackedCount} ` +
      `initialPublicationDeferredCount=${prewarmSummary.initialPublicationDeferredCount} ` +
      `unexpectedPublishedCount=${prewarmSummary.unexpectedPublishedCount} ` +
      `status=${prewarmSummary.unexpectedPublishedCount === 0 ? "complete" : "failed"} ` +
      `reason=${prewarmSummary.unexpectedPublishedCount === 0 ? "OK" : "EARLY_PUBLICATION"}`,
  );
  return summarizedPocketState;
}

function removeAbyssalPrewarmArtifacts({
  pauseSuppressorControllersForRoom,
  listUniquePositiveInts,
  cleanupSuppressorControllerByRuntimeEntity,
  cleanupSuppressorPresentationStateByEntity,
  destroyPlaceholderTrace,
  buildAbyssalSceneDescriptor,
  destroyAbyssalSceneryVisualEntity,
  removeRetiredAbyssalRoomRuntimeResidue,
}, runID, roomIndex, roomEntry, activePocketState, cleanupAuthorityPocketState, deps) {
  pauseSuppressorControllersForRoom(runID, roomIndex, "destination-prewarm-rollback");
  const npcService = deps;
  const failures = [];
  for (const hostileEntityID of listUniquePositiveInts(roomEntry.hostileEntityIDs)) {
    const result = npcService && typeof npcService.destroyNpcControllerByEntityID === "function"
      ? npcService.destroyNpcControllerByEntityID(hostileEntityID, { removeContents: true })
      : { success: false, errorMsg: "NPC_DESTROY_UNSUPPORTED" };
    if (!result || result.success !== true) {
      failures.push({
        entityID: hostileEntityID,
        role: "npc",
        errorMsg: normalizeText(result && result.errorMsg, "NPC_DESTROY_FAILED"),
      });
    }
  }

  const inventoryBackedIDs = listUniquePositiveInts([
    roomEntry.originMarkerItemID,
    roomEntry.conduitItemID,
    roomEntry.cacheItemID,
    roomEntry.cacheStructureItemID,
    roomEntry.cacheLootContainerItemID,
    ...(roomEntry.extractionNodeItemIDs || []),
    ...(roomEntry.extractionNodeLootContainerItemIDs || []),
    ...(roomEntry.rewardSuppressionPendingRemovalItemIDs || []),
    ...(roomEntry.environmentalObjectItemIDs || []),
  ]);
  for (const itemID of inventoryBackedIDs) {
    cleanupSuppressorControllerByRuntimeEntity(
      runID,
      itemID,
      "destination-prewarm-rollback",
    );
    cleanupSuppressorPresentationStateByEntity(
      runID,
      itemID,
    );
    const result = destroyPlaceholderTrace(
      activePocketState.solarSystemID,
      itemID,
      deps,
      "destination-prewarm-rollback",
      "destination prewarm artifact",
      {
        broadcast: false,
        sceneDescriptor: buildAbyssalSceneDescriptor(activePocketState, deps) || undefined,
      },
    );
    if (result && result.failed === true) {
      failures.push({
        entityID: itemID,
        role: "inventory",
        errorMsg: normalizeText(result.errorMsg, "ARTIFACT_DESTROY_FAILED"),
      });
    }
  }

  for (const sceneryEntityID of listUniquePositiveInts([
    ...(roomEntry.sceneryVisualEntityIDs || []),
    roomEntry.sceneryProbeEntityID,
  ])) {
    const result = destroyAbyssalSceneryVisualEntity(
      activePocketState,
      sceneryEntityID,
      deps,
      "destination-prewarm-rollback",
      { broadcast: false },
    );
    if (result && result.failed === true) {
      failures.push({
        entityID: sceneryEntityID,
        role: "scenery",
        errorMsg: normalizeText(result.errorMsg, "SCENERY_DESTROY_FAILED"),
      });
    }
  }
  const residualResult = removeRetiredAbyssalRoomRuntimeResidue(
    cleanupAuthorityPocketState,
    roomIndex,
    deps,
  );
  if (residualResult.remainingIDs.length > 0) {
    failures.push(...residualResult.remainingIDs.map((entityID) => ({
      entityID,
      role: "runtime-residue",
      errorMsg: "RUNTIME_ENTITY_REMAINED",
    })));
  }
  const remainingInventoryIDs = inventoryBackedIDs.filter((itemID) =>
    typeof deps.findItemById === "function" && deps.findItemById(itemID)
  );
  if (remainingInventoryIDs.length > 0) {
    failures.push(...remainingInventoryIDs.map((entityID) => ({
      entityID,
      role: "inventory-residue",
      errorMsg: "INVENTORY_ITEM_REMAINED",
    })));
  }
  return failures;
}

function prewarmNextPlaceholderRoomContent({
  getDependencies,
  getActivePocketStateByInstanceID,
  cloneValue,
  buildPlaceholderRoomState,
  beginAbyssalPocketMutationBatch,
  createAbyssalPrewarmPhaseRecorder,
  materializeAbyssalNextRoomStage,
  finalizeAbyssalPrewarmPublication,
  commitAbyssalPocketMutationBatch,
  abortAbyssalPocketMutationBatch,
},
  pocketState,
  session,
  deps = getDependencies(),
) {
  const activePocketState =
    getActivePocketStateByInstanceID(toInt(pocketState && pocketState.instanceID, 0)) ||
    cloneValue(pocketState);
  const roomState = buildPlaceholderRoomState(activePocketState);
  const currentRoomIndex = roomState.currentRoomIndex;
  const nextRoomIndex = currentRoomIndex + 1;
  if (nextRoomIndex > roomState.implementedRooms) {
    return {
      success: false,
      errorMsg: "NO_NEXT_ABYSSAL_ROOM",
    };
  }
  const prewarmMutationBatch = {
    active: false,
    instanceID: toInt(activePocketState && activePocketState.instanceID, 0),
    enabled: deps && deps.abyssalTransitionMutationBatchingEnabled !== false,
  };
  if (prewarmMutationBatch.enabled) {
    const batchStartResult = beginAbyssalPocketMutationBatch(
      prewarmMutationBatch.instanceID,
      deps,
    );
    if (!batchStartResult.success) {
      return {
        success: false,
        errorMsg: normalizeText(
          batchStartResult.errorMsg,
          "ABYSSAL_DESTINATION_PREWARM_PERSISTENCE_BATCH_START_FAILED",
        ),
      };
    }
    prewarmMutationBatch.active = true;
  }
  const recordPrewarmPhase = createAbyssalPrewarmPhaseRecorder(prewarmMutationBatch, nextRoomIndex, deps);
  try {
  const { selectedRoomLayoutID, prewarmResult } = materializeAbyssalNextRoomStage(
    activePocketState, nextRoomIndex, session, deps,
  );
  recordPrewarmPhase("content-materialized");
  if (!(prewarmResult && prewarmResult.data)) {
    return prewarmResult;
  }
  const summarizedPocketState = finalizeAbyssalPrewarmPublication(
    activePocketState, nextRoomIndex, selectedRoomLayoutID, prewarmResult, session, deps, recordPrewarmPhase,
  );
  let committedPocketState = summarizedPocketState;
  if (prewarmMutationBatch.active) {
    const batchCommitResult = commitAbyssalPocketMutationBatch(
      prewarmMutationBatch.instanceID,
      deps,
    );
    prewarmMutationBatch.active = false;
    recordPrewarmPhase("durable-commit");
    if (!batchCommitResult || batchCommitResult.success !== true) {
      return {
        success: false,
        errorMsg: normalizeText(
          batchCommitResult && batchCommitResult.errorMsg,
          "ABYSSAL_DESTINATION_PREWARM_FINAL_PERSIST_FAILED",
        ),
        data: cloneValue(summarizedPocketState),
      };
    }
    committedPocketState = cloneValue(
      batchCommitResult.committedState || batchCommitResult.state,
    ) || summarizedPocketState;
  }
  recordPrewarmPhase("complete");
  return {
    ...prewarmResult,
    data: committedPocketState,
  };
  } finally {
    if (prewarmMutationBatch.active) {
      abortAbyssalPocketMutationBatch(prewarmMutationBatch.instanceID);
      prewarmMutationBatch.active = false;
    }
  }
}

function rollbackFailedAbyssalDestinationPrewarm({
  getDependencies,
  getActivePocketStateByInstanceID,
  buildPlaceholderRoomState,
  clampRoomIndex,
  getPlaceholderRoomEntry,
  setAbyssalRoomEntityDeliveryState,
  ABYSSAL_ROOM_DELIVERY_STATE,
  setPlaceholderRoomEntry,
  removeAbyssalPrewarmArtifacts,
  log,
  buildPlaceholderRoomEntry,
  updatePocketState,
},
  pocketState,
  destinationRoomIndex,
  session,
  deps = getDependencies(),
  reason = "ABYSSAL_DESTINATION_PREWARM_NOT_READY",
) {
  const runID = toInt(pocketState && pocketState.instanceID, 0);
  const activePocketState = getActivePocketStateByInstanceID(runID) || pocketState;
  const roomState = buildPlaceholderRoomState(activePocketState);
  const roomIndex = clampRoomIndex(
    destinationRoomIndex,
    roomState.implementedRooms,
  );
  const roomEntry = getPlaceholderRoomEntry(activePocketState, roomIndex);
  if (runID <= 0 || roomIndex === roomState.currentRoomIndex) {
    return {
      success: false,
      errorMsg: "ABYSSAL_DESTINATION_PREWARM_ROLLBACK_SCOPE_INVALID",
    };
  }

  const hiddenStateResult = setAbyssalRoomEntityDeliveryState(
    activePocketState,
    roomIndex,
    ABYSSAL_ROOM_DELIVERY_STATE.RETIRED,
    session,
    deps,
    { transitionToken: 0 },
  );
  const rollbackPocketState = hiddenStateResult.pocketState || activePocketState;
  const rollbackRoomState = buildPlaceholderRoomState(rollbackPocketState);
  const cleanupAuthorityPocketState = {
    ...rollbackPocketState,
    roomState: setPlaceholderRoomEntry(
      rollbackPocketState,
      roomIndex,
      {
        ...roomEntry,
        deliveryState: ABYSSAL_ROOM_DELIVERY_STATE.RETIRED,
      },
      {
        currentRoomIndex: rollbackRoomState.currentRoomIndex,
        finalExitAvailable: rollbackRoomState.finalExitAvailable,
      },
    ),
  };
  const failures = removeAbyssalPrewarmArtifacts(
    runID, roomIndex, roomEntry, activePocketState, cleanupAuthorityPocketState, deps,
  );
  if (failures.length > 0) {
    log.warn(
      `[AbyssalPrewarmRollback] run=${runID} room=${roomIndex} status=pending ` +
        `reason=${normalizeText(reason, "ABYSSAL_DESTINATION_PREWARM_NOT_READY")} ` +
        `failures=${failures.map((entry) => `${entry.entityID}:${entry.errorMsg}`).join(",")}`,
    );
    return {
      success: false,
      pending: true,
      errorMsg: "ABYSSAL_DESTINATION_PREWARM_ROLLBACK_PENDING",
      failures,
      pocketState: getActivePocketStateByInstanceID(runID) || rollbackPocketState,
    };
  }

  const cleanRoomEntry = buildPlaceholderRoomEntry(
    activePocketState,
    roomIndex,
    {
      roomOriginPosition: roomEntry.roomOriginPosition,
      shipSpawnState: roomEntry.shipSpawnState,
      selectedRoomLayoutID: roomEntry.selectedRoomLayoutID,
      deliveryState: ABYSSAL_ROOM_DELIVERY_STATE.PREWARMED_HIDDEN,
    },
  );
  const cleanRoomState = setPlaceholderRoomEntry(
    getActivePocketStateByInstanceID(runID) || rollbackPocketState,
    roomIndex,
    cleanRoomEntry,
    {
      currentRoomIndex: roomState.currentRoomIndex,
      finalExitAvailable: roomState.finalExitAvailable,
    },
  );
  const cleanedPocketState = updatePocketState(runID, {
    roomState: cleanRoomState,
  }) || rollbackPocketState;
  log.warn(
    `[AbyssalPrewarmRollback] run=${runID} room=${roomIndex} status=complete ` +
      `reason=${normalizeText(reason, "ABYSSAL_DESTINATION_PREWARM_NOT_READY")}`,
  );
  return {
    success: true,
    pocketState: cleanedPocketState,
  };
}

// Capture supplied capabilities once, as the original closure did. Internal
// callbacks are bound once per instance; no runtime state lives in this wiring.
function createAbyssalRoomPrewarming({
  getDependencies,
  spawnPlaceholderPocketContent,
  usesIsolatedAbyssalScene,
  cloneValue,
  buildPlaceholderRoomState,
  getPlaceholderRoomEntry,
  setPlaceholderRoomEntry,
  registerPocket,
  log,
  resolveSelectedAbyssalBaseRoomLayoutID,
  buildRoomShipSpawnState,
  resolveRoomOriginPosition,
  ABYSSAL_ROOM_DELIVERY_STATE,
  buildPocketStateForCurrentRoom,
  buildEncounterStateFromRoomEntry,
  listUniquePositiveInts,
  setAbyssalRoomEntityDeliveryState,
  ABYSSAL_ROOM_ENTITY_ROLES,
  updatePocketState,
  pauseSuppressorControllersForRoom,
  cleanupSuppressorControllerByRuntimeEntity,
  cleanupSuppressorPresentationStateByEntity,
  destroyPlaceholderTrace,
  buildAbyssalSceneDescriptor,
  destroyAbyssalSceneryVisualEntity,
  removeRetiredAbyssalRoomRuntimeResidue,
  getActivePocketStateByInstanceID,
  beginAbyssalPocketMutationBatch,
  commitAbyssalPocketMutationBatch,
  abortAbyssalPocketMutationBatch,
  clampRoomIndex,
  buildPlaceholderRoomEntry,
}) {

  const ports = {
    getDependencies,
    spawnPlaceholderPocketContent,
    usesIsolatedAbyssalScene,
    cloneValue,
    buildPlaceholderRoomState,
    getPlaceholderRoomEntry,
    setPlaceholderRoomEntry,
    registerPocket,
    log,
    resolveSelectedAbyssalBaseRoomLayoutID,
    buildRoomShipSpawnState,
    resolveRoomOriginPosition,
    ABYSSAL_ROOM_DELIVERY_STATE,
    buildPocketStateForCurrentRoom,
    buildEncounterStateFromRoomEntry,
    listUniquePositiveInts,
    setAbyssalRoomEntityDeliveryState,
    ABYSSAL_ROOM_ENTITY_ROLES,
    updatePocketState,
    pauseSuppressorControllersForRoom,
    cleanupSuppressorControllerByRuntimeEntity,
    cleanupSuppressorPresentationStateByEntity,
    destroyPlaceholderTrace,
    buildAbyssalSceneDescriptor,
    destroyAbyssalSceneryVisualEntity,
    removeRetiredAbyssalRoomRuntimeResidue,
    getActivePocketStateByInstanceID,
    beginAbyssalPocketMutationBatch,
    commitAbyssalPocketMutationBatch,
    abortAbyssalPocketMutationBatch,
    clampRoomIndex,
    buildPlaceholderRoomEntry,
  };
  ports.prewarmCurrentPlaceholderRoomContent = prewarmCurrentPlaceholderRoomContent.bind(null, ports);
  ports.createAbyssalPrewarmPhaseRecorder = createAbyssalPrewarmPhaseRecorder.bind(null, ports);
  ports.materializeAbyssalNextRoomStage = materializeAbyssalNextRoomStage.bind(null, ports);
  ports.finalizeAbyssalPrewarmPublication = finalizeAbyssalPrewarmPublication.bind(null, ports);
  ports.removeAbyssalPrewarmArtifacts = removeAbyssalPrewarmArtifacts.bind(null, ports);
  ports.prewarmNextPlaceholderRoomContent = prewarmNextPlaceholderRoomContent.bind(null, ports);
  ports.rollbackFailedAbyssalDestinationPrewarm = rollbackFailedAbyssalDestinationPrewarm.bind(null, ports);
  Object.freeze(ports);
  return {
    prewarmCurrentPlaceholderRoomContent: ports.prewarmCurrentPlaceholderRoomContent,
    prewarmNextPlaceholderRoomContent: ports.prewarmNextPlaceholderRoomContent,
    rollbackFailedAbyssalDestinationPrewarm: ports.rollbackFailedAbyssalDestinationPrewarm,
  };
}

module.exports = { createAbyssalRoomPrewarming };
