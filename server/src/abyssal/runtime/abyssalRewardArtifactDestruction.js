"use strict";

const { normalizeText } = require("../domain/abyssalValueUtils");
const {
  ABYSSAL_REWARD_ARTIFACT_DESTRUCTION_OPERATION_SCHEMA_VERSION,
  ABYSSAL_REWARD_ARTIFACT_DESTRUCTION_STATUS,
  ABYSSAL_TERMINAL_TRANSITION_ACTION,
  normalizeAbyssalRewardArtifactDestructionOperation,
  isValidAbyssalRewardArtifactDestructionOperation,
  isSameAbyssalRewardArtifactDestructionIdentity,
  evaluateAbyssalRewardArtifactDestructionTransition,
  resolveAbyssalTerminalCallbackReason,
} = require("../domain/abyssalTerminalTransitionPolicy");
const { createAbyssalRewardArtifactDestructionOperationCoordinator } = require("./abyssalRewardArtifactDestructionOperationCoordinator");
const { createAbyssalRewardArtifactCompletion } = require("./abyssalRewardArtifactCompletion");

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

// Durable source-destruction claims and reward completion. Persistence/state,
// physical delivery and terminal authority are explicit ports; no state is retained.
function markAbyssalRewardArtifactPersistenceFailure({
  getDependencies,
  abyssalRunWorkStore,
},
  pocketState,
  errorMsg,
  deps = getDependencies(),
) {
  const instanceID = toInt(pocketState && pocketState.instanceID, 0);
  const normalizedError = normalizeText(
    errorMsg,
    "ABYSSAL_REWARD_ARTIFACT_PERSIST_FAILED",
  );
  if (instanceID > 0) {
    abyssalRunWorkStore.setPersistenceFailure(instanceID, {
      instanceID,
      errorMsg: normalizedError,
      failedAtMs: toInt(
        deps && typeof deps.now === "function" ? deps.now() : Date.now(),
        Date.now(),
      ),
    });
    abyssalRunWorkStore.deletePersistedStateSignature(instanceID);
  }
  return { success: false, pending: true, errorMsg: normalizedError };
}

function commitAbyssalRewardArtifactDestructionOperationState({
  getDependencies,
  cloneValue,
  getActivePocketStateByInstanceID,
  getAbyssalRewardArtifactDestructionOperation,
  commitPocketStateDurably,
  buildAbyssalRewardArtifactDestructionOperationPatch,
  readPersistedAbyssalPocketStateFromInstance,
},
  pocketState,
  operation,
  deps = getDependencies(),
  options = {},
) {
  const instanceID = toInt(pocketState && pocketState.instanceID, 0);
  const normalized = normalizeAbyssalRewardArtifactDestructionOperation(
    operation,
  );
  if (
    instanceID <= 0 ||
    !normalized ||
    !isValidAbyssalRewardArtifactDestructionOperation(normalized)
  ) {
    return {
      success: false,
      pending: true,
      errorMsg: "ABYSSAL_REWARD_ARTIFACT_OPERATION_INVALID",
    };
  }
  const coordinator =
    createAbyssalRewardArtifactDestructionOperationCoordinator({
      readRewardArtifactOperation(
        requestedInstanceID,
        sourceStructureItemID,
        readOptions = {},
      ) {
        const writeResult = readOptions.writeResult || null;
        const authoritativeState = readOptions.phase === "readback"
          ? cloneValue(
              writeResult && (writeResult.committedState || writeResult.state),
            )
          : getActivePocketStateByInstanceID(requestedInstanceID) ||
            cloneValue(readOptions.fallbackState) ||
            null;
        return {
          state: authoritativeState,
          operation: getAbyssalRewardArtifactDestructionOperation(
            authoritativeState,
            sourceStructureItemID,
          ),
        };
      },
      updateRewardArtifactOperation(
        requestedInstanceID,
        _sourceStructureItemID,
        operationPatch,
      ) {
        return commitPocketStateDurably(
          requestedInstanceID,
          operationPatch,
          deps,
          {
            verifyReadBack: options.verifyReadBack !== false,
            forceWrite: true,
          },
        );
      },
    });
  const coordinatorResult =
    coordinator.commitAbyssalRewardArtifactDestructionOperation({
      instanceID,
      sourceStructureItemID: normalized.sourceStructureItemID,
      currentState: pocketState,
      requestedOperation: normalized,
      operationPatch: ({ state }) => {
        const intrinsicPatch =
          buildAbyssalRewardArtifactDestructionOperationPatch(
            state || pocketState,
            normalized,
          );
        const additionalPatch = typeof options.additionalPatch === "function"
          ? options.additionalPatch({
              state: state || pocketState,
              operation: normalized,
            })
          : options.additionalPatch;
        return {
          ...(additionalPatch && typeof additionalPatch === "object"
            ? cloneValue(additionalPatch)
            : {}),
          ...intrinsicPatch,
        };
      },
    });
  if (!coordinatorResult || coordinatorResult.committed !== true) {
    return {
      success: false,
      pending: true,
      persistencePending: true,
      errorMsg: normalizeText(
        coordinatorResult && coordinatorResult.errorMsg,
        "ABYSSAL_REWARD_ARTIFACT_PERSIST_FAILED",
      ),
      pocketState:
        cloneValue(coordinatorResult && coordinatorResult.state) || pocketState,
      operation:
        cloneValue(coordinatorResult && coordinatorResult.operation) || null,
      coordinatorResult,
    };
  }
  const committedState = cloneValue(coordinatorResult.state);
  const committedOperation = cloneValue(coordinatorResult.operation);
  const writeResult = coordinatorResult.writeResult || null;
  return {
    success: true,
    pending: false,
    pocketState: committedState,
    operation: committedOperation,
    persistedInstance:
      (
        writeResult &&
        writeResult.persistenceResult &&
        writeResult.persistenceResult.instance
      ) || null,
    persistedPocketState:
      readPersistedAbyssalPocketStateFromInstance(
        writeResult &&
          writeResult.persistenceResult &&
          writeResult.persistenceResult.instance,
      ),
    coordinatorResult,
  };
}

function persistAndVerifyAbyssalRewardArtifactDestructionOperation({
  getDependencies,
  getAbyssalRewardArtifactDestructionOperation,
  commitAbyssalRewardArtifactDestructionOperationState,
  markAbyssalRewardArtifactPersistenceFailure,
  cloneValue,
  abyssalRunWorkStore,
},
  pocketState,
  sourceItemID,
  deps = getDependencies(),
  expectedOperation = null,
) {
  const operation = normalizeAbyssalRewardArtifactDestructionOperation(
    expectedOperation ||
      getAbyssalRewardArtifactDestructionOperation(pocketState, sourceItemID),
  );
  const commitResult =
    commitAbyssalRewardArtifactDestructionOperationState(
      pocketState,
      operation,
      deps,
    );
  if (!commitResult || commitResult.success !== true) {
    return {
      ...markAbyssalRewardArtifactPersistenceFailure(
        pocketState,
        normalizeText(
          commitResult && commitResult.errorMsg,
          "ABYSSAL_REWARD_ARTIFACT_PERSIST_FAILED",
        ),
        deps,
      ),
      pocketState:
        cloneValue(commitResult && commitResult.pocketState) || pocketState,
      operation: cloneValue(commitResult && commitResult.operation) || operation,
      coordinatorResult: commitResult && commitResult.coordinatorResult || null,
    };
  }
  abyssalRunWorkStore.deletePersistenceFailure(
    toInt(pocketState && pocketState.instanceID, 0),
  );
  return commitResult;
}

function buildAbyssalRewardArtifactSnapshot({
  getPlaceholderRoomEntry,
  getObjectPosition,
  resolveRoomOriginPosition,
  normalizeDirection,
  getCapturedT0DarkRoom,
  toReal,
  cloneValue,
},
  destroyedArtifact,
  pocketState,
  roomIndex,
) {
  const roomEntry = getPlaceholderRoomEntry(pocketState, roomIndex);
  const position =
    getObjectPosition(destroyedArtifact && destroyedArtifact.position) ||
    getObjectPosition(destroyedArtifact && destroyedArtifact.spaceState) ||
    getObjectPosition(roomEntry && roomEntry.roomOriginPosition) ||
    resolveRoomOriginPosition(pocketState, roomIndex);
  const direction = normalizeDirection(
    destroyedArtifact && destroyedArtifact.direction,
    pocketState && pocketState.shipSpawnState && pocketState.shipSpawnState.direction,
  );
  const spawnState = {
    position,
    velocity: { x: 0, y: 0, z: 0 },
    direction,
    targetPoint: position,
    mode: "STOP",
    speedFraction: 0,
  };
  const capturedRoom = getCapturedT0DarkRoom(pocketState, roomIndex);
  if (capturedRoom && capturedRoom.rewardCache) {
    spawnState.dunPosition = [
      toReal(capturedRoom.rewardCache.position && capturedRoom.rewardCache.position.x, 0),
      toReal(capturedRoom.rewardCache.position && capturedRoom.rewardCache.position.y, 0),
      toReal(capturedRoom.rewardCache.position && capturedRoom.rewardCache.position.z, 0),
    ];
    spawnState.dunRotation = cloneValue(capturedRoom.rewardCache.rotation);
  }
  return {
    artifactState: cloneValue(destroyedArtifact && destroyedArtifact.artifactState) || {},
    position: cloneValue(position),
    direction: cloneValue(direction),
    spawnState,
  };
}

function resolveAbyssalRewardArtifactKind({
  normalizeLowerText,
}, destroyedArtifact = {}) {
  const artifactState = destroyedArtifact.artifactState || {};
  const artifactKind = normalizeLowerText(destroyedArtifact.artifactKind, "");
  if (
    artifactKind === "reward_cache" ||
    normalizeLowerText(artifactState.role, "") === "cache_structure"
  ) {
    return "reward_cache";
  }
  if (
    artifactKind === "extraction_node" ||
    normalizeLowerText(artifactState.role, "") === "extraction_node_structure"
  ) {
    return "extraction_node";
  }
  return "";
}

function prepareAbyssalRuntimeArtifactDestruction({
  getDependencies,
  getActivePocketStateByInstanceID,
  syncExpiredAbyssalPocketState,
  evaluateAbyssalDirectCallbackTerminalGuard,
  buildAbyssalDirectCallbackSuppressedResult,
  validateRewardArtifactClaimIdentity,
},
  destroyedArtifact = {},
  deps = getDependencies(),
) {

  const instanceID = toInt(destroyedArtifact.instanceID, 0);
  const itemID = toInt(destroyedArtifact.itemID, 0);
  const sourceStructureTypeID = toInt(destroyedArtifact.typeID, 0);
  // A terminal callback must be suppressed before reward planning or source
  // profile validation. Runtime cleanup and late destruction callbacks can
  // legitimately arrive without the original type metadata after the run has
  // already settled; requiring typeID first would turn a successful terminal
  // suppression into a false operational failure.
  if (instanceID <= 0 || itemID <= 0) {
    return { success: false, errorMsg: "ABYSSAL_ARTIFACT_CONTEXT_MISSING" };
  }
  const initialState = getActivePocketStateByInstanceID(instanceID);
  if (!initialState) {
    return { success: false, errorMsg: "ABYSSAL_INSTANCE_NOT_ACTIVE" };
  }
  let pocketState = syncExpiredAbyssalPocketState(initialState, null, deps);
  if (!pocketState) {
    return { success: false, errorMsg: "ABYSSAL_RUN_TERMINALLY_SETTLED" };
  }
  const terminalGuard = evaluateAbyssalDirectCallbackTerminalGuard(
    pocketState,
    "runtime-artifact-destruction-prepare",
  );
  if (terminalGuard.blocked) {
    return buildAbyssalDirectCallbackSuppressedResult(terminalGuard, {
      itemID,
      roomIndex: toInt(destroyedArtifact.roomIndex, 0),
    });
  }
  if (sourceStructureTypeID <= 0) {
    return { success: false, errorMsg: "ABYSSAL_ARTIFACT_CONTEXT_MISSING" };
  }
  return validateRewardArtifactClaimIdentity({
    destroyedArtifact,
    deps,
    instanceID,
    itemID,
    sourceStructureTypeID,
    initialState,
    pocketState,
    terminalGuard,
  });
}

function validateRewardArtifactClaimIdentity({
  resolveAbyssalRewardArtifactKind,
  buildPlaceholderRoomState,
  clampRoomIndex,
  getPlaceholderRoomEntry,
  getAbyssalRewardArtifactDestructionOperation,
  persistAndVerifyAbyssalRewardArtifactDestructionOperation,
  prepareRewardArtifactClaimContent,
}, attempt) {
  const { destroyedArtifact, pocketState, itemID, sourceStructureTypeID, deps } = attempt;
const artifactKind = resolveAbyssalRewardArtifactKind(destroyedArtifact);
  if (!artifactKind) {
    return { success: false, errorMsg: "ABYSSAL_ARTIFACT_ROLE_UNHANDLED" };
  }
  const roomState = buildPlaceholderRoomState(pocketState);
  const artifactState = destroyedArtifact.artifactState || {};
  const roomIndex = clampRoomIndex(
    toInt(artifactState.roomIndex, toInt(destroyedArtifact.roomIndex, roomState.currentRoomIndex)),
    roomState.implementedRooms,
  );
  const roomEntry = getPlaceholderRoomEntry(pocketState, roomIndex);
  const existingOperation = getAbyssalRewardArtifactDestructionOperation(
    pocketState,
    itemID,
  );
  if (existingOperation) {
    if (
      existingOperation.status !== ABYSSAL_REWARD_ARTIFACT_DESTRUCTION_STATUS.CLAIMED ||
      existingOperation.sourceStructureTypeID !== sourceStructureTypeID ||
      existingOperation.artifactKind !== artifactKind ||
      existingOperation.roomIndex !== roomIndex
    ) {
      return {
        success: false,
        errorMsg: "ABYSSAL_REWARD_ARTIFACT_OPERATION_CONFLICT",
        operation: existingOperation,
      };
    }
    const persistence = persistAndVerifyAbyssalRewardArtifactDestructionOperation(
      pocketState,
      itemID,
      deps,
      existingOperation,
    );
    return {
      ...persistence,
      claimOperationID: existingOperation.operationID,
      operation: existingOperation,
      data: pocketState,
      idempotent: true,
    };
  }
  return prepareRewardArtifactClaimContent({
    ...attempt,
    artifactKind,
    roomState,
    artifactState,
    roomIndex,
    roomEntry,
    existingOperation,
  });
}

function prepareRewardArtifactClaimContent({
  getAbyssalRoomRewardSuppressionReason,
  buildAbyssalRewardArtifactSnapshot,
  resolveRoomRewardProfile,
  ensureAbyssalRewardPlan,
  cloneValue,
  isIntentionallyEmptyObservedRunRoomRewardPlan,
  listUniquePositiveInts,
  resolveRoomExtractionNodeProfile,
  buildResolvedExtractionNodeLootEntries,
  persistRewardArtifactDestructionClaim,
}, attempt) {
  const { roomIndex, destroyedArtifact, artifactKind, roomEntry, itemID, deps, sourceStructureTypeID, artifactState } = attempt;
  let { pocketState } = attempt;
const rewardSuppressionReason = getAbyssalRoomRewardSuppressionReason(
    pocketState,
    roomIndex,
  );
  const snapshot = buildAbyssalRewardArtifactSnapshot(
    destroyedArtifact,
    pocketState,
    roomIndex,
  );
  let retryIntent = null;
  if (artifactKind === "reward_cache") {
    const structureItemID = toInt(
      roomEntry.cacheStructureItemID,
      toInt(roomEntry.cacheItemID, 0),
    );
    if (structureItemID !== itemID) {
      return { success: false, errorMsg: "ABYSSAL_CACHE_STRUCTURE_MISMATCH" };
    }
    if (
      !rewardSuppressionReason &&
      (
        roomEntry.cacheRewardMaterialized === true ||
        toInt(roomEntry.cacheLootContainerItemID, 0) > 0
      )
    ) {
      return { success: false, errorMsg: "ABYSSAL_CACHE_REWARD_ALREADY_MATERIALIZED" };
    }
    if (!rewardSuppressionReason) {
      const rewardProfile = resolveRoomRewardProfile(pocketState, roomIndex, {
        logResolution: false,
      });
      const rewardPlanResult = ensureAbyssalRewardPlan(
        pocketState,
        roomIndex,
        rewardProfile,
        deps,
      );
      if (!rewardPlanResult.success) return rewardPlanResult;
      pocketState = rewardPlanResult.data || pocketState;
      retryIntent = {
        kind: "cache",
        sourceStructureItemID: itemID,
        sourceStructureTypeID,
        lootEntries: cloneValue(rewardPlanResult.rewardPlan.entries),
        allowEmptyManifest: isIntentionallyEmptyObservedRunRoomRewardPlan(
          pocketState,
          rewardProfile,
          rewardPlanResult.rewardPlan,
        ),
        spawnState: cloneValue(snapshot.spawnState),
        attemptCount: 0,
        retainedContainerItemID: 0,
        lastError: "",
      };
    }
  } else {
    const trackedNodes = listUniquePositiveInts(roomEntry.extractionNodeItemIDs);
    if (!trackedNodes.includes(itemID)) {
      return { success: false, errorMsg: "ABYSSAL_EXTRACTION_NODE_MISMATCH" };
    }
    if (
      !rewardSuppressionReason &&
      listUniquePositiveInts(roomEntry.extractionNodeRewardMaterializedItemIDs).includes(itemID)
    ) {
      return { success: false, errorMsg: "ABYSSAL_EXTRACTION_REWARD_ALREADY_MATERIALIZED" };
    }
    if (!rewardSuppressionReason) {
      const extractionNodeProfile = resolveRoomExtractionNodeProfile(
        pocketState,
        roomIndex,
        { logResolution: false },
      );
      const existingPlans =
        roomEntry.extractionNodeRewardPlansByItemID &&
        typeof roomEntry.extractionNodeRewardPlansByItemID === "object"
          ? roomEntry.extractionNodeRewardPlansByItemID
          : {};
      const lootEntries = Array.isArray(existingPlans[String(itemID)])
        ? cloneValue(existingPlans[String(itemID)])
        : buildResolvedExtractionNodeLootEntries(
            extractionNodeProfile,
            pocketState,
            deps,
          );
      retryIntent = {
        kind: "extraction",
        sourceStructureItemID: itemID,
        sourceStructureTypeID,
        nodeIndex: Math.max(1, toInt(artifactState.nodeIndex, 1)),
        lootEntries,
        spawnState: cloneValue(snapshot.spawnState),
        attemptCount: 0,
        retainedContainerItemID: 0,
        lastError: "",
      };
    }
  }
  return persistRewardArtifactDestructionClaim({
    ...attempt,
    rewardSuppressionReason,
    snapshot,
    retryIntent,
    pocketState,
  });
}

function persistRewardArtifactDestructionClaim({
  buildAbyssalRewardArtifactDestructionOperationID,
  commitAbyssalRewardArtifactDestructionOperationState,
  buildAbyssalPersistencePendingResult,
  cloneValue,
  getAuthoritativeAbyssalPocketState,
  abyssalRunWorkStore,
}, attempt) {
  const {
    deps,
    instanceID,
    roomIndex,
    itemID,
    sourceStructureTypeID,
    artifactKind,
    rewardSuppressionReason,
    retryIntent,
    snapshot,
  } = attempt;
  let { pocketState } = attempt;
const nowMs = toInt(deps && typeof deps.now === "function" ? deps.now() : Date.now(), Date.now());
  const operation = normalizeAbyssalRewardArtifactDestructionOperation({
    schemaVersion: ABYSSAL_REWARD_ARTIFACT_DESTRUCTION_OPERATION_SCHEMA_VERSION,
    operationID: buildAbyssalRewardArtifactDestructionOperationID({
      runID: instanceID,
      roomIndex,
      sourceStructureItemID: itemID,
      sourceStructureTypeID,
      artifactKind,
    }),
    status: ABYSSAL_REWARD_ARTIFACT_DESTRUCTION_STATUS.CLAIMED,
    runID: instanceID,
    roomIndex,
    characterID: toInt(pocketState.characterID, 0),
    sourceStructureItemID: itemID,
    sourceStructureTypeID,
    artifactKind,
    claimCommittedAtMs: nowMs,
    suppressionReason: rewardSuppressionReason,
    retryIntent,
    artifactSnapshot: snapshot,
  });
  const commitResult =
    commitAbyssalRewardArtifactDestructionOperationState(
      pocketState,
      operation,
      deps,
    );
  if (!commitResult || commitResult.success !== true) {
    const failure = buildAbyssalPersistencePendingResult(
      pocketState,
      normalizeText(
        commitResult && commitResult.errorMsg,
        "ABYSSAL_REWARD_ARTIFACT_CLAIM_PERSIST_FAILED",
      ),
      deps,
      {
        defaultErrorMsg: "ABYSSAL_REWARD_ARTIFACT_CLAIM_PERSIST_FAILED",
        persistenceResult: commitResult && commitResult.coordinatorResult &&
          commitResult.coordinatorResult.writeResult,
      },
    );
    return { ...failure, data: failure.pocketState };
  }
  pocketState = cloneValue(commitResult.pocketState) ||
    getAuthoritativeAbyssalPocketState(instanceID, pocketState);
  const registeredOperation = commitResult.operation;
  abyssalRunWorkStore.deletePersistenceFailure(instanceID);
  return {
    success: true,
    pending: false,
    claimOperationID: registeredOperation.operationID,
    operation: registeredOperation,
    persistedInstance: commitResult.persistedInstance,
    data: pocketState,
  };
}

function commitDurableAbyssalRewardArtifactSourceDestroyed({
  getDependencies,
  getAbyssalRewardArtifactDestructionOperation,
  persistAndVerifyAbyssalRewardArtifactDestructionOperation,
  getPlaceholderRoomEntry,
  getAbyssalRoomRewardSuppressionReason,
  cloneValue,
  listUniquePositiveInts,
  persistRewardArtifactSourceReceipt,
},
  pocketState,
  operation,
  deps = getDependencies(),
  options = {},
) {

  const sourceItemID = toInt(operation && operation.sourceStructureItemID, 0);
  const currentOperation = getAbyssalRewardArtifactDestructionOperation(
    pocketState,
    sourceItemID,
  );
  if (
    !currentOperation ||
    !isSameAbyssalRewardArtifactDestructionIdentity(currentOperation, operation)
  ) {
    return { success: false, errorMsg: "ABYSSAL_REWARD_ARTIFACT_CLAIM_MISSING" };
  }
  if (
    currentOperation.status !==
      ABYSSAL_REWARD_ARTIFACT_DESTRUCTION_STATUS.CLAIMED
  ) {
    return persistAndVerifyAbyssalRewardArtifactDestructionOperation(
      pocketState,
      sourceItemID,
      deps,
      currentOperation,
    );
  }
  const roomIndex = currentOperation.roomIndex;
  const roomEntry = getPlaceholderRoomEntry(pocketState, roomIndex);
  const nowMs = toInt(
    deps && typeof deps.now === "function" ? deps.now() : Date.now(),
    Date.now(),
  );
  // Re-evaluate suppression at the irreversible source-destroyed receipt. A
  // timeout or controller failure may settle after the claim was committed but
  // before the runtime reports source removal. The durable receipt must capture
  // that newer terminal fact and must never proceed into reward materialisation.
  const effectiveSuppressionReason = normalizeText(
    options.suppressionReason,
    normalizeText(
      currentOperation.suppressionReason,
      getAbyssalRoomRewardSuppressionReason(pocketState, roomIndex),
    ),
  );
  const suppressed = Boolean(effectiveSuppressionReason);
  let nextRoomEntry;
  if (currentOperation.artifactKind === "reward_cache") {
    nextRoomEntry = {
      ...roomEntry,
      cacheItemID: 0,
      cacheStructureItemID: 0,
      cacheRewardMaterialized: false,
      cacheLifecycleState: suppressed
        ? "structure_destroyed_reward_suppressed"
        : "reward_retry_pending",
      cacheRewardRetryIntent: suppressed
        ? null
        : cloneValue(currentOperation.retryIntent),
      cacheRewardRetryError: suppressed ? effectiveSuppressionReason : "",
      deliveredEntityIDs: listUniquePositiveInts(roomEntry.deliveredEntityIDs)
        .filter((itemID) => itemID !== sourceItemID),
    };
  } else {
    const plans = cloneValue(roomEntry.extractionNodeRewardPlansByItemID || {});
    const intents = cloneValue(roomEntry.extractionNodeRewardRetryIntentsByItemID || {});
    if (!suppressed && currentOperation.retryIntent) {
      plans[String(sourceItemID)] = cloneValue(currentOperation.retryIntent.lootEntries);
      intents[String(sourceItemID)] = cloneValue(currentOperation.retryIntent);
    } else {
      delete intents[String(sourceItemID)];
    }
    nextRoomEntry = {
      ...roomEntry,
      extractionNodeItemIDs: listUniquePositiveInts(roomEntry.extractionNodeItemIDs)
        .filter((itemID) => itemID !== sourceItemID),
      extractionNodeLifecycleState: suppressed
        ? "structure_destroyed_reward_suppressed"
        : "reward_retry_pending",
      extractionNodeRewardPlansByItemID: plans,
      extractionNodeRewardRetryIntentsByItemID: intents,
      extractionNodeRewardRetryItemID: suppressed ? 0 : sourceItemID,
      extractionNodeRewardRetryError: suppressed ? effectiveSuppressionReason : "",
      deliveredEntityIDs: listUniquePositiveInts(roomEntry.deliveredEntityIDs)
        .filter((itemID) => itemID !== sourceItemID),
    };
  }
  return persistRewardArtifactSourceReceipt({
    pocketState,
    operation,
    deps,
    options,
    sourceItemID,
    currentOperation,
    roomIndex,
    roomEntry,
    nowMs,
    effectiveSuppressionReason,
    suppressed,
    nextRoomEntry,
  });
}

function persistRewardArtifactSourceReceipt({
  setPlaceholderRoomEntry,
  cloneValue,
  commitAbyssalRewardArtifactDestructionOperationState,
  buildPocketStateForCurrentRoom,
  buildAbyssalPersistencePendingResult,
  getAuthoritativeAbyssalPocketState,
  abyssalRunWorkStore,
}, attempt) {
  const {
    pocketState,
    roomIndex,
    nextRoomEntry,
    currentOperation,
    suppressed,
    nowMs,
    effectiveSuppressionReason,
    sourceItemID,
    deps,
  } = attempt;
const nextRoomState = setPlaceholderRoomEntry(
    pocketState,
    roomIndex,
    nextRoomEntry,
  );
  const nextOperation = normalizeAbyssalRewardArtifactDestructionOperation({
    ...cloneValue(currentOperation),
    status: suppressed
      ? ABYSSAL_REWARD_ARTIFACT_DESTRUCTION_STATUS.SUPPRESSED
      : ABYSSAL_REWARD_ARTIFACT_DESTRUCTION_STATUS.SOURCE_DESTROYED,
    sourceDestroyedAtMs: nowMs,
    rewardCompletedAtMs: suppressed ? nowMs : 0,
    suppressionReason: effectiveSuppressionReason,
    receipt: suppressed
      ? {
          operationID: currentOperation.operationID,
          sourceStructureItemID: sourceItemID,
          outcome: "suppressed",
          reason: effectiveSuppressionReason,
          committedAtMs: nowMs,
        }
      : null,
  });
  const commitResult =
    commitAbyssalRewardArtifactDestructionOperationState(
      pocketState,
      nextOperation,
      deps,
      {
        additionalPatch: buildPocketStateForCurrentRoom(
          pocketState,
          nextRoomState,
        ),
      },
    );
  if (!commitResult || commitResult.success !== true) {
    const failure = buildAbyssalPersistencePendingResult(
      pocketState,
      normalizeText(
        commitResult && commitResult.errorMsg,
        "ABYSSAL_REWARD_ARTIFACT_SOURCE_RECEIPT_FAILED",
      ),
      deps,
      {
        defaultErrorMsg: "ABYSSAL_REWARD_ARTIFACT_SOURCE_RECEIPT_FAILED",
        operation: currentOperation,
        persistenceResult: commitResult && commitResult.coordinatorResult &&
          commitResult.coordinatorResult.writeResult,
      },
    );
    return { ...failure, data: failure.pocketState };
  }
  const updatedState = cloneValue(commitResult.pocketState) ||
    getAuthoritativeAbyssalPocketState(pocketState.instanceID, pocketState);
  const registered = commitResult.operation;
  abyssalRunWorkStore.deletePersistenceFailure(toInt(pocketState.instanceID, 0));
  return {
    success: true,
    pending: false,
    persistedInstance: commitResult.persistedInstance,
    data: updatedState,
    operation: registered,
  };
}

function reconcilePendingAbyssalRewardArtifactDestructions({
  getDependencies,
  getAbyssalRewardArtifactDestructionOperations,
  commitDurableAbyssalRewardArtifactSourceDestroyed,
},
  pocketState,
  deps = getDependencies(),
) {
  let currentState = pocketState;
  for (const operation of Object.values(
    getAbyssalRewardArtifactDestructionOperations(currentState),
  )) {
    if (operation.status !== ABYSSAL_REWARD_ARTIFACT_DESTRUCTION_STATUS.CLAIMED) {
      continue;
    }
    if (deps.findItemById(operation.sourceStructureItemID)) {
      continue;
    }
    const committed = commitDurableAbyssalRewardArtifactSourceDestroyed(
      currentState,
      operation,
      deps,
    );
    if (committed && committed.success === true && committed.data) {
      currentState = committed.data;
    }
  }
  return currentState;
}

function finalizeResolvedAbyssalRewardArtifactDestructions({
  getDependencies,
  getAbyssalRewardArtifactDestructionOperations,
  finalizeDurableAbyssalRewardArtifactOperation,
},
  pocketState,
  deps = getDependencies(),
) {
  let currentState = pocketState;
  for (const operation of Object.values(
    getAbyssalRewardArtifactDestructionOperations(currentState),
  )) {
    if (operation.status !== ABYSSAL_REWARD_ARTIFACT_DESTRUCTION_STATUS.SOURCE_DESTROYED) {
      continue;
    }
    const finalized = finalizeDurableAbyssalRewardArtifactOperation(
      currentState,
      operation,
      deps,
    );
    if (finalized && finalized.success === true && finalized.data) {
      currentState = finalized.data;
    }
  }
  return currentState;
}

function handleAbyssalRuntimeArtifactDestroyed({
  getDependencies,
  getActivePocketStateByInstanceID,
  syncExpiredAbyssalPocketState,
  buildPlaceholderRoomState,
  clampRoomIndex,
  getAbyssalRoomRewardSuppressionReason,
  evaluateAbyssalDirectCallbackTerminalGuard,
  getPlaceholderRoomEntry,
  listUniquePositiveInts,
  validateRewardArtifactDestructionCallback,
}, destroyedArtifact = {}, deps = getDependencies()) {

  const instanceID = toInt(destroyedArtifact.instanceID, 0);
  const itemID = toInt(destroyedArtifact.itemID, 0);
  const claimOperationID = normalizeText(destroyedArtifact.claimOperationID, "");
  if (instanceID <= 0 || itemID <= 0) {
    return { success: false, errorMsg: "ABYSSAL_REWARD_ARTIFACT_CONTEXT_MISSING" };
  }
  let pocketState = getActivePocketStateByInstanceID(instanceID);
  if (!pocketState) {
    return { success: false, errorMsg: "ABYSSAL_INSTANCE_NOT_ACTIVE" };
  }
  pocketState = syncExpiredAbyssalPocketState(pocketState, null, deps) ||
    getActivePocketStateByInstanceID(instanceID);
  if (!pocketState) {
    return {
      success: true,
      suppressed: true,
      terminal: true,
      sourceDestroyed: true,
      reason: "ABYSSAL_RUN_TERMINALLY_SETTLED",
      data: null,
    };
  }
  const artifactState = destroyedArtifact.artifactState || {};
  const roomState = buildPlaceholderRoomState(pocketState);
  const roomIndex = clampRoomIndex(
    toInt(artifactState.roomIndex, toInt(destroyedArtifact.roomIndex, roomState.currentRoomIndex)),
    roomState.implementedRooms,
  );
  const suppressionReason = getAbyssalRoomRewardSuppressionReason(
    pocketState,
    roomIndex,
  );
  const terminalGuard = evaluateAbyssalDirectCallbackTerminalGuard(
    pocketState,
    "runtime-artifact-destroyed",
  );
  const callbackRoomEntry = getPlaceholderRoomEntry(pocketState, roomIndex);
  const artifactExplicitlySuppressed = Boolean(
    normalizeText(callbackRoomEntry && callbackRoomEntry.suppressedReason, "") ||
    normalizeText(callbackRoomEntry && callbackRoomEntry.cacheLifecycleState, "") === "suppressed" ||
    normalizeText(callbackRoomEntry && callbackRoomEntry.extractionNodeLifecycleState, "") === "suppressed" ||
    listUniquePositiveInts(
      callbackRoomEntry && callbackRoomEntry.rewardSuppressionPendingRemovalItemIDs,
    ).includes(itemID)
  );

  // Direct late callbacks that never crossed the authoritative runtime removal
  // boundary are handled as successful suppression and do not create reward
  // plans. When a durable claim is supplied, however, the exact claim must be
  // advanced to a durable source-destroyed/suppressed receipt before returning.
  // Otherwise a source can disappear while its operation remains permanently
  // stuck at `claimed`, defeating restart reconciliation.
  return validateRewardArtifactDestructionCallback({
    destroyedArtifact,
    deps,
    instanceID,
    itemID,
    claimOperationID,
    pocketState,
    artifactState,
    roomState,
    roomIndex,
    suppressionReason,
    terminalGuard,
    callbackRoomEntry,
    artifactExplicitlySuppressed,
  });
}

function validateRewardArtifactDestructionCallback({
  getAbyssalRewardArtifactDestructionOperation,
  persistAndVerifyAbyssalRewardArtifactDestructionOperation,
  commitRewardArtifactDestructionCallback,
}, attempt) {
  const {
    pocketState,
    itemID,
    claimOperationID,
    suppressionReason,
    artifactExplicitlySuppressed,
    terminalGuard,
    callbackRoomEntry,
    deps,
  } = attempt;
const operation = getAbyssalRewardArtifactDestructionOperation(pocketState, itemID);
  const artifactDestructionDecision =
    evaluateAbyssalRewardArtifactDestructionTransition({
      claimOperationID,
      currentOperationID: operation && operation.operationID,
      currentStatus: operation && operation.status,
      suppressionPresent: Boolean(suppressionReason),
      artifactExplicitlySuppressed,
      terminalBlocked: terminalGuard.blocked,
    });
  if (
    artifactDestructionDecision.action ===
      ABYSSAL_TERMINAL_TRANSITION_ACTION.SUPPRESS_UNCLAIMED_REWARD_ARTIFACT
  ) {
    return {
      success: true,
      handled: true,
      suppressed: true,
      terminal: terminalGuard.blocked,
      sourceDestroyed: true,
      reason: suppressionReason ||
        normalizeText(
          callbackRoomEntry && callbackRoomEntry.suppressedReason,
          terminalGuard.blocked
            ? resolveAbyssalTerminalCallbackReason(terminalGuard.outcome)
            : "REWARD_SUPPRESSED",
        ),
      guardReason: terminalGuard.blocked
        ? terminalGuard.reason
        : "REWARD_SUPPRESSED",
      data: pocketState,
    };
  }
  if (!artifactDestructionDecision.allowed) {
    return {
      success: false,
      errorMsg: artifactDestructionDecision.reason,
    };
  }
  if (
    artifactDestructionDecision.action ===
      ABYSSAL_TERMINAL_TRANSITION_ACTION.RECONCILE_REWARD_ARTIFACT_OPERATION
  ) {
    const persistedDuplicate = persistAndVerifyAbyssalRewardArtifactDestructionOperation(
      pocketState,
      itemID,
      deps,
      operation,
    );
    if (!persistedDuplicate || persistedDuplicate.success !== true) {
      return {
        success: false,
        duplicate: true,
        sourceDestroyed: true,
        retryPending: true,
        errorMsg: normalizeText(
          persistedDuplicate && persistedDuplicate.errorMsg,
          "ABYSSAL_REWARD_ARTIFACT_DUPLICATE_RECEIPT_FAILED",
        ),
        data: persistedDuplicate && persistedDuplicate.data || pocketState,
        operation,
      };
    }
    const persistedOperation = persistedDuplicate.operation || operation;
    const suppressed = persistedOperation.status ===
      ABYSSAL_REWARD_ARTIFACT_DESTRUCTION_STATUS.SUPPRESSED;
    return {
      success: true,
      duplicate: true,
      sourceDestroyed: true,
      rewardCompleted: !suppressed,
      suppressed,
      operation: persistedOperation,
      data: persistedDuplicate.data || pocketState,
    };
  }
  return commitRewardArtifactDestructionCallback({
    ...attempt,
    operation,
    artifactDestructionDecision,
  });
}

function commitRewardArtifactDestructionCallback({
  commitDurableAbyssalRewardArtifactSourceDestroyed,
  materializeDestroyedRewardArtifact,
}, attempt) {
  const { operation, deps, suppressionReason, terminalGuard } = attempt;
  let { pocketState } = attempt;
const sourceCommit = commitDurableAbyssalRewardArtifactSourceDestroyed(
    pocketState,
    operation,
    deps,
    {
      suppressionReason: suppressionReason ||
        (terminalGuard.blocked
          ? resolveAbyssalTerminalCallbackReason(terminalGuard.outcome)
          : ""),
    },
  );
  if (!sourceCommit || sourceCommit.success !== true) {
    return {
      success: false,
      sourceDestroyed: true,
      retryPending: true,
      errorMsg: normalizeText(
        sourceCommit && sourceCommit.errorMsg,
        "ABYSSAL_REWARD_ARTIFACT_SOURCE_RECEIPT_FAILED",
      ),
      data: sourceCommit && sourceCommit.data || pocketState,
    };
  }
  pocketState = sourceCommit.data || pocketState;
  const committedOperation = sourceCommit.operation || operation;
  if (committedOperation.status === ABYSSAL_REWARD_ARTIFACT_DESTRUCTION_STATUS.SUPPRESSED) {
    return {
      success: true,
      handled: true,
      suppressed: true,
      terminal: terminalGuard.blocked,
      sourceDestroyed: true,
      reason: normalizeText(
        committedOperation.suppressionReason,
        suppressionReason ||
          resolveAbyssalTerminalCallbackReason(terminalGuard.outcome),
      ),
      operation: committedOperation,
      data: pocketState,
    };
  }
  return materializeDestroyedRewardArtifact({
    ...attempt,
    sourceCommit,
    committedOperation,
    pocketState,
  });
}

function materializeDestroyedRewardArtifact({
  retryPendingAbyssalRewardMaterializations,
  finalizeDurableAbyssalRewardArtifactOperation,
  completeRewardArtifactDestructionCallback,
}, attempt) {
  const { committedOperation, deps } = attempt;
  let { pocketState } = attempt;
const retryResult = retryPendingAbyssalRewardMaterializations(
    pocketState,
    committedOperation.roomIndex,
    deps,
  );
  pocketState = retryResult.data || pocketState;
  if (!retryResult.success) {
    if (retryResult.suppressed === true) {
      const suppressionFinalization = finalizeDurableAbyssalRewardArtifactOperation(
        pocketState,
        committedOperation,
        deps,
        {
          suppressionReason: normalizeText(
            retryResult.errorMsg,
            "ABYSSAL_REWARD_ARTIFACT_MATERIALIZATION_SUPPRESSED",
          ),
        },
      );
      if (suppressionFinalization && suppressionFinalization.success === true) {
        return {
          success: true,
          suppressed: true,
          sourceDestroyed: true,
          operation: suppressionFinalization.operation,
          data: suppressionFinalization.data || pocketState,
        };
      }
    }
    return {
      ...retryResult,
      success: false,
      sourceDestroyed: true,
      retryPending: retryResult.retryPending !== false,
      data: pocketState,
    };
  }
  return completeRewardArtifactDestructionCallback({
    ...attempt,
    retryResult,
    pocketState,
  });
}

function completeRewardArtifactDestructionCallback({
  finalizeDurableAbyssalRewardArtifactOperation,
}, attempt) {
  const { pocketState, committedOperation, deps } = attempt;
const finalization = finalizeDurableAbyssalRewardArtifactOperation(
    pocketState,
    committedOperation,
    deps,
  );
  if (!finalization || finalization.success !== true) {
    return {
      success: false,
      sourceDestroyed: true,
      retryPending: true,
      errorMsg: normalizeText(
        finalization && finalization.errorMsg,
        "ABYSSAL_REWARD_ARTIFACT_COMPLETION_RECEIPT_FAILED",
      ),
      data: finalization && finalization.data || pocketState,
    };
  }
  return {
    success: true,
    sourceDestroyed: true,
    rewardCompleted: true,
    operation: finalization.operation,
    data: finalization.data || pocketState,
  };
}

function destroyRoomExtractionNodes({
  getDependencies,
  getPlaceholderRoomEntry,
  listUniquePositiveInts,
  buildAbyssalSceneDescriptor,
  destroyPlaceholderTrace,
},
  pocketState,
  roomIndex,
  deps = getDependencies(),
  reason = "room-transfer-extraction-node-cleanup",
  options = {},
) {
  const roomEntry = getPlaceholderRoomEntry(pocketState, roomIndex);
  const itemIDs = listUniquePositiveInts(roomEntry.extractionNodeItemIDs);
  const sceneDescriptor = buildAbyssalSceneDescriptor(pocketState, deps);
  return itemIDs.map((itemID) =>
    destroyPlaceholderTrace(
      toInt(pocketState && pocketState.solarSystemID, 0),
      itemID,
      deps,
      reason,
      "extraction node",
      {
        ...options,
        sceneDescriptor: sceneDescriptor || options.sceneDescriptor,
      },
    )
  );
}

function destroyRoomExtractionNodeLootContainers({
  getDependencies,
  getPlaceholderRoomEntry,
  buildAbyssalSceneDescriptor,
  listUniquePositiveInts,
  destroyPlaceholderTrace,
},
  pocketState,
  roomIndex,
  deps = getDependencies(),
  reason = "room-transfer-extraction-node-loot-cleanup",
  options = {},
) {
  const roomEntry = getPlaceholderRoomEntry(pocketState, roomIndex);
  const sceneDescriptor = buildAbyssalSceneDescriptor(pocketState, deps);
  return listUniquePositiveInts(roomEntry.extractionNodeLootContainerItemIDs).map((itemID) =>
    destroyPlaceholderTrace(
      toInt(pocketState && pocketState.solarSystemID, 0),
      itemID,
      deps,
      reason,
      "extraction node loot container",
      {
        ...options,
        sceneDescriptor: sceneDescriptor || options.sceneDescriptor,
      },
    )
  );
}

// Capture supplied capabilities once, as the original closure did. Internal
// callbacks are bound once per instance; no runtime state lives in this wiring.
function createAbyssalRewardArtifactDestruction({
  getDependencies,
  abyssalRunWorkStore,
  getActivePocketStateByInstanceID,
  cloneValue,
  getAbyssalRewardArtifactDestructionOperation,
  commitPocketStateDurably,
  buildAbyssalRewardArtifactDestructionOperationPatch,
  readPersistedAbyssalPocketStateFromInstance,
  getPlaceholderRoomEntry,
  getObjectPosition,
  resolveRoomOriginPosition,
  normalizeDirection,
  getCapturedT0DarkRoom,
  toReal,
  normalizeLowerText,
  syncExpiredAbyssalPocketState,
  evaluateAbyssalDirectCallbackTerminalGuard,
  buildAbyssalDirectCallbackSuppressedResult,
  buildPlaceholderRoomState,
  clampRoomIndex,
  getAbyssalRoomRewardSuppressionReason,
  resolveRoomRewardProfile,
  ensureAbyssalRewardPlan,
  isIntentionallyEmptyObservedRunRoomRewardPlan,
  listUniquePositiveInts,
  resolveRoomExtractionNodeProfile,
  buildResolvedExtractionNodeLootEntries,
  buildAbyssalRewardArtifactDestructionOperationID,
  buildAbyssalPersistencePendingResult,
  getAuthoritativeAbyssalPocketState,
  setPlaceholderRoomEntry,
  buildPocketStateForCurrentRoom,
  buildAbyssalRewardManifestReceiptKey,
  getAbyssalRewardArtifactDestructionOperations,
  retryPendingAbyssalRewardMaterializations,
  buildAbyssalSceneDescriptor,
  destroyPlaceholderTrace,
}) {

  const ports = {
    getDependencies,
    abyssalRunWorkStore,
    getActivePocketStateByInstanceID,
    cloneValue,
    getAbyssalRewardArtifactDestructionOperation,
    commitPocketStateDurably,
    buildAbyssalRewardArtifactDestructionOperationPatch,
    readPersistedAbyssalPocketStateFromInstance,
    getPlaceholderRoomEntry,
    getObjectPosition,
    resolveRoomOriginPosition,
    normalizeDirection,
    getCapturedT0DarkRoom,
    toReal,
    normalizeLowerText,
    syncExpiredAbyssalPocketState,
    evaluateAbyssalDirectCallbackTerminalGuard,
    buildAbyssalDirectCallbackSuppressedResult,
    buildPlaceholderRoomState,
    clampRoomIndex,
    getAbyssalRoomRewardSuppressionReason,
    resolveRoomRewardProfile,
    ensureAbyssalRewardPlan,
    isIntentionallyEmptyObservedRunRoomRewardPlan,
    listUniquePositiveInts,
    resolveRoomExtractionNodeProfile,
    buildResolvedExtractionNodeLootEntries,
    buildAbyssalRewardArtifactDestructionOperationID,
    buildAbyssalPersistencePendingResult,
    getAuthoritativeAbyssalPocketState,
    setPlaceholderRoomEntry,
    buildPocketStateForCurrentRoom,
    buildAbyssalRewardManifestReceiptKey,
    getAbyssalRewardArtifactDestructionOperations,
    retryPendingAbyssalRewardMaterializations,
    buildAbyssalSceneDescriptor,
    destroyPlaceholderTrace,
  };
  ports.markAbyssalRewardArtifactPersistenceFailure = markAbyssalRewardArtifactPersistenceFailure.bind(null, ports);
  ports.commitAbyssalRewardArtifactDestructionOperationState = commitAbyssalRewardArtifactDestructionOperationState.bind(null, ports);
  ports.persistAndVerifyAbyssalRewardArtifactDestructionOperation = persistAndVerifyAbyssalRewardArtifactDestructionOperation.bind(null, ports);
  ports.buildAbyssalRewardArtifactSnapshot = buildAbyssalRewardArtifactSnapshot.bind(null, ports);
  ports.resolveAbyssalRewardArtifactKind = resolveAbyssalRewardArtifactKind.bind(null, ports);
  ports.prepareAbyssalRuntimeArtifactDestruction = prepareAbyssalRuntimeArtifactDestruction.bind(null, ports);
  ports.validateRewardArtifactClaimIdentity = validateRewardArtifactClaimIdentity.bind(null, ports);
  ports.prepareRewardArtifactClaimContent = prepareRewardArtifactClaimContent.bind(null, ports);
  ports.persistRewardArtifactDestructionClaim = persistRewardArtifactDestructionClaim.bind(null, ports);
  ports.commitDurableAbyssalRewardArtifactSourceDestroyed = commitDurableAbyssalRewardArtifactSourceDestroyed.bind(null, ports);
  ports.persistRewardArtifactSourceReceipt = persistRewardArtifactSourceReceipt.bind(null, ports);
  ports.finalizeDurableAbyssalRewardArtifactOperation = createAbyssalRewardArtifactCompletion({
    getDependencies: ports.getDependencies,
    getAbyssalRewardArtifactDestructionOperation: ports.getAbyssalRewardArtifactDestructionOperation,
    persistAndVerifyAbyssalRewardArtifactDestructionOperation: ports.persistAndVerifyAbyssalRewardArtifactDestructionOperation,
    commitAbyssalRewardArtifactDestructionOperationState: ports.commitAbyssalRewardArtifactDestructionOperationState,
    listUniquePositiveInts: ports.listUniquePositiveInts,
    getPlaceholderRoomEntry: ports.getPlaceholderRoomEntry,
    getAbyssalRoomRewardSuppressionReason: ports.getAbyssalRoomRewardSuppressionReason,
    cloneValue: ports.cloneValue,
    buildAbyssalPersistencePendingResult: ports.buildAbyssalPersistencePendingResult,
    getAuthoritativeAbyssalPocketState: ports.getAuthoritativeAbyssalPocketState,
    abyssalRunWorkStore: ports.abyssalRunWorkStore,
    buildAbyssalRewardManifestReceiptKey: ports.buildAbyssalRewardManifestReceiptKey,
  }).finalizeDurableAbyssalRewardArtifactOperation;
  ports.reconcilePendingAbyssalRewardArtifactDestructions = reconcilePendingAbyssalRewardArtifactDestructions.bind(null, ports);
  ports.finalizeResolvedAbyssalRewardArtifactDestructions = finalizeResolvedAbyssalRewardArtifactDestructions.bind(null, ports);
  ports.handleAbyssalRuntimeArtifactDestroyed = handleAbyssalRuntimeArtifactDestroyed.bind(null, ports);
  ports.validateRewardArtifactDestructionCallback = validateRewardArtifactDestructionCallback.bind(null, ports);
  ports.commitRewardArtifactDestructionCallback = commitRewardArtifactDestructionCallback.bind(null, ports);
  ports.materializeDestroyedRewardArtifact = materializeDestroyedRewardArtifact.bind(null, ports);
  ports.completeRewardArtifactDestructionCallback = completeRewardArtifactDestructionCallback.bind(null, ports);
  ports.destroyRoomExtractionNodes = destroyRoomExtractionNodes.bind(null, ports);
  ports.destroyRoomExtractionNodeLootContainers = destroyRoomExtractionNodeLootContainers.bind(null, ports);
  Object.freeze(ports);
  return Object.freeze({
    markAbyssalRewardArtifactPersistenceFailure: ports.markAbyssalRewardArtifactPersistenceFailure,
    commitAbyssalRewardArtifactDestructionOperationState: ports.commitAbyssalRewardArtifactDestructionOperationState,
    persistAndVerifyAbyssalRewardArtifactDestructionOperation: ports.persistAndVerifyAbyssalRewardArtifactDestructionOperation,
    buildAbyssalRewardArtifactSnapshot: ports.buildAbyssalRewardArtifactSnapshot,
    resolveAbyssalRewardArtifactKind: ports.resolveAbyssalRewardArtifactKind,
    prepareAbyssalRuntimeArtifactDestruction: ports.prepareAbyssalRuntimeArtifactDestruction,
    commitDurableAbyssalRewardArtifactSourceDestroyed: ports.commitDurableAbyssalRewardArtifactSourceDestroyed,
    finalizeDurableAbyssalRewardArtifactOperation: ports.finalizeDurableAbyssalRewardArtifactOperation,
    reconcilePendingAbyssalRewardArtifactDestructions: ports.reconcilePendingAbyssalRewardArtifactDestructions,
    finalizeResolvedAbyssalRewardArtifactDestructions: ports.finalizeResolvedAbyssalRewardArtifactDestructions,
    handleAbyssalRuntimeArtifactDestroyed: ports.handleAbyssalRuntimeArtifactDestroyed,
    destroyRoomExtractionNodes: ports.destroyRoomExtractionNodes,
    destroyRoomExtractionNodeLootContainers: ports.destroyRoomExtractionNodeLootContainers,
  });
}

module.exports = { createAbyssalRewardArtifactDestruction };
