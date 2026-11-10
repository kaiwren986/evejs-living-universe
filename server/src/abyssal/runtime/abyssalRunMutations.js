"use strict";

const { normalizeText } = require("../domain/abyssalValueUtils");

// Stateless operations; ownership remains with the injected registry and persistence ports.
function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function unregisterPocket(ports, instanceID) {
  const {
    log,
    ABYSSAL_DIAGNOSTIC_DEDUPE_SCOPE,
    hasAbyssalRecoveryTombstoneBacklog,
    clearPlaceholderPocketMaintenance,
    cleanupPendingWork,
    removeActiveRun,
    cleanupRunWork,
    deleteRuntimeTelemetry,
    deleteDiagnosticKeysMatching,
    deleteDiagnosticKey,
    getActiveRunCount,
    hasTombstoneScanInProgress,
  } = ports;
  const numericInstanceID = toInt(instanceID, 0);
  if (numericInstanceID <= 0) {
    return;
  }
  const deps = ports.getDependencies();
  const pendingCleanup = cleanupPendingWork(
    numericInstanceID,
    deps && deps.clearScheduledTimeout,
  );
  for (const failure of pendingCleanup.failedScheduledHandles) {
    log.warn(
      `[AbyssalPendingWork] ${failure.kind} timer cancellation failed ` +
        `instance=${numericInstanceID} character=${toInt(failure.characterID, 0)} ` +
        `reason=${normalizeText(failure.error && failure.error.message, "UNKNOWN")}`,
    );
  }
  removeActiveRun(numericInstanceID);
  cleanupRunWork(numericInstanceID);
  deleteRuntimeTelemetry(numericInstanceID);
  deleteDiagnosticKey(
    ABYSSAL_DIAGNOSTIC_DEDUPE_SCOPE.RECOVERED_SCENE_MODE,
    numericInstanceID,
  );
  deleteDiagnosticKey(
    ABYSSAL_DIAGNOSTIC_DEDUPE_SCOPE.AMBIGUOUS_SCENE_MODE,
    numericInstanceID,
  );
  deleteDiagnosticKey(
    ABYSSAL_DIAGNOSTIC_DEDUPE_SCOPE.LAYOUT_RECOVERY,
    numericInstanceID,
  );
  deleteDiagnosticKey(
    ABYSSAL_DIAGNOSTIC_DEDUPE_SCOPE.BASE_ROOM_LAYOUT_RECOVERY,
    numericInstanceID,
  );
  const runKeyPrefix = `${numericInstanceID}:`;
  deleteDiagnosticKeysMatching(
    ABYSSAL_DIAGNOSTIC_DEDUPE_SCOPE.ROOM_CONTENT_LIFECYCLE,
    (key) => String(key).startsWith(runKeyPrefix),
  );
  deleteDiagnosticKeysMatching(
    ABYSSAL_DIAGNOSTIC_DEDUPE_SCOPE.MISSING_AUTHORITATIVE_SCENERY,
    (key) => String(key).startsWith(runKeyPrefix),
  );
  if (
    getActiveRunCount() <= 0 &&
    !hasAbyssalRecoveryTombstoneBacklog() &&
    !hasTombstoneScanInProgress()
  ) {
    clearPlaceholderPocketMaintenance(ports.getDependencies());
  }
}

function buildNextAbyssalPocketState(ports,
  instanceID,
  patchOrUpdater,
) {
  const {
    cloneValue,
    getRunByInstanceID,
  } = ports;
  const numericInstanceID = toInt(instanceID, 0);
  if (numericInstanceID <= 0) {
    return {
      success: false,
      errorMsg: "POCKET_STATE_MISSING",
      currentState: null,
      nextState: null,
    };
  }
  const currentState = getRunByInstanceID(numericInstanceID);
  if (!currentState) {
    return {
      success: false,
      errorMsg: "POCKET_STATE_NOT_REGISTERED",
      currentState: null,
      nextState: null,
    };
  }
  const patch = typeof patchOrUpdater === "function"
    ? patchOrUpdater(cloneValue(currentState))
    : patchOrUpdater;
  if (!patch || typeof patch !== "object") {
    return {
      success: true,
      unchanged: true,
      currentState: cloneValue(currentState),
      nextState: cloneValue(currentState),
    };
  }
  return {
    success: true,
    unchanged: false,
    currentState: cloneValue(currentState),
    nextState: {
      ...cloneValue(currentState),
      ...cloneValue(patch),
    },
  };
}

function commitPocketStateDurably(ports,
  instanceID,
  patchOrUpdater,
  deps = ports.getDependencies(),
  options = {},
) {
  const {
    cloneValue,
    getAbyssalPocketPersistenceVersion,
    persistRegisteredAbyssalPocketState,
    ABYSSAL_POCKET_PERSISTENCE_ERROR,
    registerPocketInternal,
    ABYSSAL_POCKET_MUTATION_DURABILITY,
  } = ports;
  const candidate = buildNextAbyssalPocketState(ports, instanceID, patchOrUpdater);
  if (!candidate.success) {
    return {
      success: false,
      instanceID: toInt(instanceID, 0),
      errorMsg: candidate.errorMsg,
    };
  }
  const currentVersion = getAbyssalPocketPersistenceVersion(
    candidate.currentState,
  );
  if (
    options.expectedVersion !== undefined &&
    options.expectedVersion !== null &&
    toInt(options.expectedVersion, -1) !== currentVersion
  ) {
    return {
      success: false,
      conflict: true,
      instanceID: toInt(instanceID, 0),
      currentVersion,
      expectedVersion: toInt(options.expectedVersion, -1),
      errorMsg: "ABYSSAL_POCKET_STATE_VERSION_CONFLICT",
    };
  }
  if (candidate.unchanged) {
    const persistenceResult = persistRegisteredAbyssalPocketState(
      candidate.currentState,
      deps,
      {
        requireDurableStore: true,
        verifyReadBack: options.verifyReadBack === true,
        forceWrite: options.forceWrite === true,
      },
    );
    if (!persistenceResult || persistenceResult.success !== true) {
      return {
        success: false,
        instanceID: toInt(instanceID, 0),
        currentVersion,
        persistenceResult: cloneValue(persistenceResult),
        errorMsg: normalizeText(
          persistenceResult && persistenceResult.errorMsg,
          ABYSSAL_POCKET_PERSISTENCE_ERROR,
        ),
      };
    }
    return {
      success: true,
      unchanged: true,
      durable: persistenceResult.durable === true,
      instanceID: toInt(instanceID, 0),
      committedState: cloneValue(candidate.currentState),
      state: cloneValue(candidate.currentState),
      currentVersion,
      persistenceResult: cloneValue(persistenceResult),
    };
  }
  return registerPocketInternal(candidate.nextState, {
    deps,
    durability: ABYSSAL_POCKET_MUTATION_DURABILITY.DURABLE,
    verifyReadBack: options.verifyReadBack === true,
    forceWrite: options.forceWrite === true,
  });
}

function updatePocketStateBestEffort(ports,
  instanceID,
  patchOrUpdater,
  deps = ports.getDependencies(),
  options = {},
) {
  const {
    cloneValue,
    registerPocketInternal,
    ABYSSAL_POCKET_MUTATION_DURABILITY,
  } = ports;
  const batchedResult = applyAbyssalPocketMutationInMemory(ports,
    instanceID,
    patchOrUpdater,
  );
  if (batchedResult) {
    return {
      ...batchedResult,
      bestEffort: true,
      persistenceResult: {
        success: true,
        skipped: true,
        batched: true,
        durable: false,
      },
    };
  }
  const candidate = buildNextAbyssalPocketState(ports, instanceID, patchOrUpdater);
  if (!candidate.success) {
    return {
      success: false,
      instanceID: toInt(instanceID, 0),
      errorMsg: candidate.errorMsg,
    };
  }
  if (candidate.unchanged) {
    return {
      success: true,
      unchanged: true,
      bestEffort: true,
      state: cloneValue(candidate.currentState),
      committedState: cloneValue(candidate.currentState),
      persistenceResult: {
        success: true,
        skipped: true,
        unchanged: true,
        durable: false,
      },
    };
  }
  return registerPocketInternal(candidate.nextState, {
    ...options,
    deps,
    durability: ABYSSAL_POCKET_MUTATION_DURABILITY.BEST_EFFORT,
  });
}

function beginAbyssalPocketMutationBatch(ports, instanceID, deps = ports.getDependencies()) {
  const {
    cloneValue,
    getAbyssalPocketPersistenceVersion,
    getRunByInstanceID,
    hasMutationBatch,
    setMutationBatch,
  } = ports;
  const numericInstanceID = toInt(instanceID, 0);
  const baseState = getRunByInstanceID(numericInstanceID);
  if (numericInstanceID <= 0 || !baseState) {
    return { success: false, errorMsg: "POCKET_STATE_NOT_REGISTERED" };
  }
  if (hasMutationBatch(numericInstanceID)) {
    return { success: false, errorMsg: "ABYSSAL_POCKET_MUTATION_BATCH_ALREADY_ACTIVE" };
  }
  const batch = {
    instanceID: numericInstanceID,
    baseState: cloneValue(baseState),
    persistenceVersion: getAbyssalPocketPersistenceVersion(baseState),
    mutationCount: 0,
    updateMutationCount: 0,
    registerMutationCount: 0,
    startedAtNs: process.hrtime.bigint(),
    diagnosticsEnabled: deps && deps.abyssalTransitionPerfDiagnosticsEnabled === true,
  };
  setMutationBatch(numericInstanceID, batch);
  return { success: true, batch };
}

function applyAbyssalPocketMutationInMemory(ports,
  instanceID,
  patchOrUpdater,
  mutationKind = "update",
) {
  const {
    cloneValue,
    AbyssalRunRegistryError,
    getRunByInstanceID,
    replaceActiveRun,
    getMutationBatch,
  } = ports;
  const numericInstanceID = toInt(instanceID, 0);
  const batch = getMutationBatch(numericInstanceID) || null;
  if (!batch) {
    return null;
  }
  const currentState = getRunByInstanceID(numericInstanceID);
  if (!currentState) {
    return { success: false, errorMsg: "POCKET_STATE_NOT_REGISTERED" };
  }
  const patch = typeof patchOrUpdater === "function"
    ? patchOrUpdater(cloneValue(currentState))
    : patchOrUpdater;
  const unchanged = !patch || typeof patch !== "object";
  const nextState = unchanged
    ? currentState
    : {
        ...currentState,
        ...patch,
        persistenceVersion: batch.persistenceVersion,
      };
  try {
    replaceActiveRun(nextState);
  } catch (error) {
    if (!(error instanceof AbyssalRunRegistryError)) throw error;
    return { success: false, errorMsg: error.code };
  }
  if (!unchanged) {
    batch.mutationCount += 1;
    if (mutationKind === "register") {
      batch.registerMutationCount += 1;
    } else {
      batch.updateMutationCount += 1;
    }
  }
  return {
    success: true,
    unchanged,
    batched: true,
    state: nextState,
    committedState: nextState,
  };
}

function registerAbyssalPocketInMemory(ports, pocketState) {
  const {
    getRunByInstanceID,
    getMutationBatch,
  } = ports;
  const instanceID = toInt(pocketState && pocketState.instanceID, 0);
  const batch = getMutationBatch(instanceID) || null;
  if (!batch) {
    return null;
  }
  const currentState = getRunByInstanceID(instanceID) || batch.baseState;
  return applyAbyssalPocketMutationInMemory(ports,
    instanceID,
    {
      ...currentState,
      ...pocketState,
      persistenceVersion: batch.persistenceVersion,
    },
    "register",
  );
}

function abortAbyssalPocketMutationBatch(ports, instanceID) {
  const {
    cloneValue,
    replaceActiveRun,
    hasActiveRun,
    getMutationBatch,
    deleteMutationBatch,
  } = ports;
  const numericInstanceID = toInt(instanceID, 0);
  const batch = getMutationBatch(numericInstanceID) || null;
  if (!batch) {
    return { success: true, skipped: true };
  }
  deleteMutationBatch(numericInstanceID);
  // Terminal settlement may clean up and unregister the run while a transition
  // batch is still unwinding. Do not resurrect that removed run when aborting.
  if (!hasActiveRun(numericInstanceID)) {
    return { success: true, aborted: true, runRemoved: true, batch };
  }
  replaceActiveRun(cloneValue(batch.baseState));
  return { success: true, aborted: true, batch };
}

function commitAbyssalPocketMutationBatch(ports, instanceID, deps = ports.getDependencies()) {
  const {
    log,
    cloneValue,
    registerPocketInternal,
    ABYSSAL_POCKET_MUTATION_DURABILITY,
    getRunByInstanceID,
    replaceActiveRun,
    getMutationBatch,
    deleteMutationBatch,
  } = ports;
  const numericInstanceID = toInt(instanceID, 0);
  const batch = getMutationBatch(numericInstanceID) || null;
  if (!batch) {
    return { success: false, errorMsg: "ABYSSAL_POCKET_MUTATION_BATCH_NOT_ACTIVE" };
  }
  const finalState = cloneValue(
    getRunByInstanceID(numericInstanceID) || batch.baseState,
  );
  deleteMutationBatch(numericInstanceID);
  replaceActiveRun(cloneValue(batch.baseState));
  const commitResult = registerPocketInternal(finalState, {
    deps,
    durability: ABYSSAL_POCKET_MUTATION_DURABILITY.DURABLE,
  });
  const durationMs = Number(process.hrtime.bigint() - batch.startedAtNs) / 1_000_000;
  if (batch.diagnosticsEnabled) {
    log.info(
      `[AbyssalTransitionPerf] run=${numericInstanceID} phase=persistence-batch ` +
        `durationMs=${durationMs.toFixed(3)} mutations=${batch.mutationCount} ` +
        `updateMutations=${batch.updateMutationCount} ` +
        `registerMutations=${batch.registerMutationCount} durableWrites=1 ` +
        `avoidedDurableWrites=${Math.max(0, batch.mutationCount - 1)} ` +
        `success=${Boolean(commitResult && commitResult.success === true)}`,
    );
  }
  return {
    ...(commitResult || {}),
    batch: {
      mutationCount: batch.mutationCount,
      updateMutationCount: batch.updateMutationCount,
      registerMutationCount: batch.registerMutationCount,
      avoidedDurableWrites: Math.max(0, batch.mutationCount - 1),
      durationMs,
    },
  };
}

function updatePocketState(ports, instanceID, patchOrUpdater) {
  const {
    cloneValue,
    AbyssalPocketPersistenceError,
  } = ports;
  const batchedResult = applyAbyssalPocketMutationInMemory(ports,
    instanceID,
    patchOrUpdater,
  );
  if (batchedResult) {
    if (batchedResult.success !== true) {
      throw new AbyssalPocketPersistenceError(batchedResult || {});
    }
    return batchedResult.committedState || batchedResult.state;
  }
  const result = commitPocketStateDurably(ports,
    instanceID,
    patchOrUpdater,
    ports.getDependencies(),
  );
  if (!result || result.success !== true) {
    throw new AbyssalPocketPersistenceError(result || {});
  }
  return cloneValue(result.committedState || result.state);
}

function createAbyssalRunMutations(ports) {
  return {
    unregisterPocket: unregisterPocket.bind(null, ports),
    buildNextAbyssalPocketState: buildNextAbyssalPocketState.bind(null, ports),
    commitPocketStateDurably: commitPocketStateDurably.bind(null, ports),
    updatePocketStateBestEffort: updatePocketStateBestEffort.bind(null, ports),
    beginAbyssalPocketMutationBatch: beginAbyssalPocketMutationBatch.bind(null, ports),
    applyAbyssalPocketMutationInMemory: applyAbyssalPocketMutationInMemory.bind(null, ports),
    registerAbyssalPocketInMemory: registerAbyssalPocketInMemory.bind(null, ports),
    abortAbyssalPocketMutationBatch: abortAbyssalPocketMutationBatch.bind(null, ports),
    commitAbyssalPocketMutationBatch: commitAbyssalPocketMutationBatch.bind(null, ports),
    updatePocketState: updatePocketState.bind(null, ports),
  };
}

module.exports = { createAbyssalRunMutations };
