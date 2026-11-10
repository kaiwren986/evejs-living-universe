"use strict";

const { normalizeText } = require("../domain/abyssalValueUtils");

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

// No artifacts may be removed before these existing recovery and receipt gates.
// All authority, persistence and retry scheduling remain with injected owners.
function buildAbyssalCleanupPreparationContext({
  getActivePocketStateByInstanceID,
  cloneValue,
}, pocketState, deps, options) {
  const registeredPocketState = pocketState && pocketState.instanceID
    ? getActivePocketStateByInstanceID(pocketState.instanceID)
    : null;
  const explicitAllParticipantTerminalReceipt = Boolean(
    pocketState &&
    pocketState.participantTerminalState &&
    pocketState.participantTerminalState.allTerminal === true,
  );
  const resolvedPocketState = explicitAllParticipantTerminalReceipt
    ? cloneValue(pocketState)
    : registeredPocketState || cloneValue(pocketState);
  const instanceID = toInt(resolvedPocketState && resolvedPocketState.instanceID, 0);
  const reason = normalizeText(options.reason, "cleanup");
  return { resolvedPocketState, instanceID, reason, deps, options };
}

function validateAbyssalCleanupEntryRecovery({
  normalizeAbyssalParticipantRoster,
  ABYSSAL_PARTICIPANT_STATUS,
  schedulePlaceholderPocketMaintenance,
}, context) {
  const { resolvedPocketState, instanceID, reason, deps, options } = context;
  if (instanceID <= 0 || !resolvedPocketState) {
    return {
      success: true,
      alreadyClean: true,
      reason,
      destroyedItemIDs: [],
      destroyedHostileIDs: [],
      cleanupSummary: {},
      purged: false,
    };
  }
  if (
    context.resolvedPocketState.entryRecoveryState &&
    context.resolvedPocketState.entryRecoveryState.pending === true
  ) {
    const pendingReturnParticipants = normalizeAbyssalParticipantRoster(
      context.resolvedPocketState,
    ).filter((participant) => [
      ABYSSAL_PARTICIPANT_STATUS.ACTIVE,
      ABYSSAL_PARTICIPANT_STATUS.DISCONNECTED,
      ABYSSAL_PARTICIPANT_STATUS.ADMITTING,
      ABYSSAL_PARTICIPANT_STATUS.EXITING,
    ].includes(participant.status));
    if (
      options.allowPendingEntryRecoveryCleanup !== true ||
      pendingReturnParticipants.length > 0
    ) {
      schedulePlaceholderPocketMaintenance(deps);
      return {
        success: false,
        pending: true,
        alreadyClean: false,
        errorMsg: pendingReturnParticipants.length > 0
          ? "ABYSSAL_ENTRY_RECOVERY_PARTICIPANT_RETURN_PENDING"
          : "ABYSSAL_ENTRY_RECOVERY_CLEANUP_BLOCKED",
        reason,
        destroyedItemIDs: [],
        destroyedScannerProbeIDs: [],
        destroyedHostileIDs: [],
        cleanupSummary: {},
        purged: false,
        sceneDisposed: false,
        sceneAlreadyGone: false,
      };
    }
  }
  return null;
}

function verifyAbyssalCleanupDestructionReceipts({
  requiresAbyssalParticipantDestructionReceiptForCleanup,
  listUniquePositiveInts,
  getAbyssalParticipantDestructionOperation,
  ABYSSAL_PARTICIPANT_DESTRUCTION_OPERATION_STATUS,
  log,
  schedulePlaceholderPocketMaintenance,
  persistAndVerifyAbyssalParticipantDestructionOperation,
  getActivePocketStateByInstanceID,
}, context) {
  const { instanceID, reason, deps } = context;
  if (
    requiresAbyssalParticipantDestructionReceiptForCleanup(
      context.resolvedPocketState,
      deps,
    )
  ) {
    const requiredCharacterIDs = listUniquePositiveInts(
      context.resolvedPocketState.participantTerminalState &&
        context.resolvedPocketState.participantTerminalState.requiredCharacterIDs ||
        [context.resolvedPocketState.characterID],
    );
    const requiredOperations = requiredCharacterIDs.map((characterID) =>
      getAbyssalParticipantDestructionOperation(context.resolvedPocketState, characterID)
    );
    const incompleteOperationIndex = requiredOperations.findIndex((operation) =>
      !operation ||
      operation.status !==
        ABYSSAL_PARTICIPANT_DESTRUCTION_OPERATION_STATUS.POD_DESTROYED
    );
    const incompleteOperation = incompleteOperationIndex >= 0
      ? requiredOperations[incompleteOperationIndex]
      : null;
    if (incompleteOperationIndex >= 0 || requiredOperations.length !== requiredCharacterIDs.length) {
      log.warn(
        `[AbyssalCleanup] participant destruction receipt incomplete ` +
          `run=${instanceID} character=${toInt(context.resolvedPocketState.characterID, 0)} ` +
          `status=${normalizeText(incompleteOperation && incompleteOperation.status, "missing")} ` +
          `operation=${normalizeText(incompleteOperation && incompleteOperation.operationID, "missing")}`,
      );
      schedulePlaceholderPocketMaintenance(deps);
      return {
        success: false,
        pending: true,
        alreadyClean: false,
        errorMsg: "ABYSSAL_PARTICIPANT_DESTRUCTION_DURABLE_RECEIPT_REQUIRED",
        reason,
        destroyedItemIDs: [],
        destroyedScannerProbeIDs: [],
        destroyedHostileIDs: [],
        cleanupSummary: {},
        purged: false,
        sceneDisposed: false,
        sceneAlreadyGone: false,
      };
    }
    let receiptVerification = null;
    for (const destructionOperation of requiredOperations) {
      receiptVerification = persistAndVerifyAbyssalParticipantDestructionOperation(
        context.resolvedPocketState,
        deps,
        destructionOperation,
      );
      if (!receiptVerification || receiptVerification.success !== true) break;
      context.resolvedPocketState =
        getActivePocketStateByInstanceID(instanceID) || context.resolvedPocketState;
    }
    if (!receiptVerification || receiptVerification.success !== true) {
      schedulePlaceholderPocketMaintenance(deps);
      return {
        success: false,
        pending: true,
        alreadyClean: false,
        errorMsg: normalizeText(
          receiptVerification && receiptVerification.errorMsg,
          "ABYSSAL_PARTICIPANT_DESTRUCTION_DURABLE_RECEIPT_REQUIRED",
        ),
        reason,
        destroyedItemIDs: [],
        destroyedScannerProbeIDs: [],
        destroyedHostileIDs: [],
        cleanupSummary: {},
        purged: false,
        sceneDisposed: false,
        sceneAlreadyGone: false,
      };
    }
    context.resolvedPocketState = getActivePocketStateByInstanceID(instanceID) || context.resolvedPocketState;
  }
  return null;
}

function stageAbyssalTerminalCleanupAttempt({
  log,
  getAbyssalTerminalCleanupState,
  getActivePocketStateByInstanceID,
  updatePocketState,
  ensureAbyssalPocketPersistenceReady,
}, context) {
  const { instanceID, reason, deps } = context;
  log.info(
    `[AbyssalMgr] Abyssal run cleanup begin char=${context.resolvedPocketState.characterID} instance=${context.resolvedPocketState.instanceID} trace=${context.resolvedPocketState.traceItemID} reason=${reason}`,
  );

  context.cleanupNowMs = toInt(
    deps && typeof deps.now === "function" ? deps.now() : Date.now(),
    Date.now(),
  );
  const previousCleanupState = getAbyssalTerminalCleanupState(context.resolvedPocketState) || {};
  context.stagedCleanupState = {
    ...previousCleanupState,
    status: "pending",
    reason,
    firstPendingAtMs: toInt(previousCleanupState.firstPendingAtMs, 0) || context.cleanupNowMs,
    lastAttemptAtMs: context.cleanupNowMs,
    attemptCount: Math.max(0, toInt(previousCleanupState.attemptCount, 0)) + 1,
    failedArtifactCount: 0,
    failedResidualSpaceItemCount: 0,
    failedScannerProbeCleanupCount: 0,
    failedItemIDs: [],
  };
  if (getActivePocketStateByInstanceID(instanceID)) {
    context.resolvedPocketState = updatePocketState(instanceID, {
      terminalCleanupState: context.stagedCleanupState,
    }) || context.resolvedPocketState;
    const pendingPersistence = ensureAbyssalPocketPersistenceReady(
      context.resolvedPocketState,
      deps,
    );
    if (!pendingPersistence || pendingPersistence.success !== true) {
      log.warn(
        `[AbyssalCleanupRetry] run=${instanceID} state=pending ` +
          `reason=ABYSSAL_CLEANUP_PENDING_PERSIST_FAILED`,
      );
      return {
        success: false,
        pending: true,
        alreadyClean: false,
        errorMsg: "ABYSSAL_CLEANUP_PENDING_PERSIST_FAILED",
        reason,
        destroyedItemIDs: [],
        destroyedScannerProbeIDs: [],
        destroyedHostileIDs: [],
        cleanupSummary: {},
        purged: false,
        sceneDisposed: false,
        sceneAlreadyGone: false,
      };
    }
  }
  return null;
}

function reconcileAbyssalCleanupTraceReturn({
  normalizeLowerText,
  cloneValue,
  buildPlaceholderReturnSpaceState,
  markSourceTraceReturnedForPocket,
  updatePocketState,
  ensureAbyssalPocketPersistenceReady,
  schedulePlaceholderPocketMaintenance,
}, context) {
  const { instanceID, reason, deps } = context;
  const committedFinalExitRequiresTraceReturn = Boolean(
    normalizeLowerText(reason, "") === "final-exit" &&
    context.resolvedPocketState.gameplayAuthorityDetached === true &&
    (
      context.resolvedPocketState.committedExitState ||
      context.resolvedPocketState.pendingTransitionState &&
        context.resolvedPocketState.pendingTransitionState.sourceCommitIrreversible === true
    )
  );
  const currentTraceReturnState =
    context.resolvedPocketState.traceReturnState &&
    typeof context.resolvedPocketState.traceReturnState === "object"
      ? cloneValue(context.resolvedPocketState.traceReturnState)
      : null;
  if (
    committedFinalExitRequiresTraceReturn &&
    normalizeLowerText(currentTraceReturnState && currentTraceReturnState.status, "pending") !==
      "completed"
  ) {
    const committedReturnSpaceState =
      currentTraceReturnState && currentTraceReturnState.returnSpaceState ||
      context.resolvedPocketState.committedExitState &&
        context.resolvedPocketState.committedExitState.returnSpaceState ||
      buildPlaceholderReturnSpaceState(context.resolvedPocketState);
    const traceReturnResult = markSourceTraceReturnedForPocket(
      context.resolvedPocketState,
      committedReturnSpaceState,
      deps,
    );
    if (!traceReturnResult || traceReturnResult.success !== true) {
      const traceFailureReason = normalizeText(
        traceReturnResult && traceReturnResult.errorMsg,
        "TRACE_RETURN_STATE_FAILED",
      );
      const pendingTracePocketState = updatePocketState(instanceID, {
        traceReturnState: {
          ...cloneValue(currentTraceReturnState || {}),
          schemaVersion: 1,
          status: "pending",
          instanceID,
          characterID: toInt(context.resolvedPocketState.characterID, 0),
          shipID: toInt(context.resolvedPocketState.shipID, 0),
          traceItemID: toInt(
            context.resolvedPocketState.sourceTraceItemID,
            toInt(context.resolvedPocketState.traceItemID, 0),
          ),
          returnSpaceState: cloneValue(committedReturnSpaceState),
          lastFailedAtMs: context.cleanupNowMs,
          failureReason: traceFailureReason,
        },
        terminalCleanupState: {
          ...context.stagedCleanupState,
          status: "pending",
          lastFailedAtMs: context.cleanupNowMs,
          failureReason: "ABYSSAL_TRACE_RETURN_PENDING",
        },
      }) || context.resolvedPocketState;
      const pendingTracePersistence = ensureAbyssalPocketPersistenceReady(
        pendingTracePocketState,
        deps,
      );
      schedulePlaceholderPocketMaintenance(deps);
      return {
        success: false,
        pending: true,
        alreadyClean: false,
        errorMsg:
          pendingTracePersistence && pendingTracePersistence.success === true
            ? "ABYSSAL_TRACE_RETURN_PENDING"
            : "ABYSSAL_CLEANUP_PENDING_PERSIST_FAILED",
        reason,
        destroyedItemIDs: [],
        destroyedScannerProbeIDs: [],
        destroyedHostileIDs: [],
        cleanupSummary: {},
        traceReturnPending: true,
        purged: false,
        sceneDisposed: false,
        sceneAlreadyGone: false,
      };
    }
    const completedTracePocketState = updatePocketState(instanceID, {
      traceReturnState: {
        ...cloneValue(currentTraceReturnState || {}),
        schemaVersion: 1,
        status: "completed",
        instanceID,
        characterID: toInt(context.resolvedPocketState.characterID, 0),
        shipID: toInt(context.resolvedPocketState.shipID, 0),
        traceItemID: toInt(
          context.resolvedPocketState.sourceTraceItemID,
          toInt(context.resolvedPocketState.traceItemID, 0),
        ),
        returnSpaceState: cloneValue(committedReturnSpaceState),
        failureReason: "",
        completedAtMs: context.cleanupNowMs,
      },
    }) || context.resolvedPocketState;
    const completedTracePersistence = ensureAbyssalPocketPersistenceReady(
      completedTracePocketState,
      deps,
    );
    if (!completedTracePersistence || completedTracePersistence.success !== true) {
      schedulePlaceholderPocketMaintenance(deps);
      return {
        success: false,
        pending: true,
        alreadyClean: false,
        errorMsg: "ABYSSAL_TRACE_RETURN_COMPLETE_PERSIST_FAILED",
        reason,
        destroyedItemIDs: [],
        destroyedScannerProbeIDs: [],
        destroyedHostileIDs: [],
        cleanupSummary: {},
        traceReturnPending: true,
        purged: false,
        sceneDisposed: false,
        sceneAlreadyGone: false,
      };
    }
    context.resolvedPocketState = completedTracePocketState;
  }
  return null;
}

function settleAbyssalCleanupAchievements({ schedulePlaceholderPocketMaintenance }, context) {
  const { resolvedPocketState, deps } = context;
  try {
    const career = deps.dungeonTrackingRuntime?.recordCareerAbyssalRun?.(resolvedPocketState?.instanceID);
    if (career && !career.success) {
      schedulePlaceholderPocketMaintenance(deps);
      return { success: false, pending: true, alreadyClean: false, purged: false,
        errorMsg: career.errorMsg || "CAREER_ABYSSAL_SETTLEMENT_PENDING", reason: context.reason };
    }
  } catch (error) {
    schedulePlaceholderPocketMaintenance(deps);
    return { success: false, pending: true, alreadyClean: false, purged: false,
      errorMsg: error.message || "CAREER_ABYSSAL_SETTLEMENT_PENDING", reason: context.reason };
  }
  // The preceding cleanup-attempt stage has durably retained this canonical
  // successful run. A failed progress write must remain selected for automatic
  // maintenance even when its weather and return obligations are already done.
  if (resolvedPocketState && resolvedPocketState.runOutcome === "exited" &&
      deps.dungeonTrackingRuntime && typeof deps.dungeonTrackingRuntime.recordAbyssalRunCompletion === "function") {
    const achievementResult = deps.dungeonTrackingRuntime.recordAbyssalRunCompletion(resolvedPocketState);
    if (!achievementResult || achievementResult.success !== true) {
      schedulePlaceholderPocketMaintenance(deps);
      return {
        success: false, pending: true, alreadyClean: false, purged: false,
        errorMsg: "ABYSSAL_ACHIEVEMENT_COMPLETION_PENDING", reason: context.reason,
      };
    }
  }
  return null;
}

function prepareAbyssalRunCleanup({
  buildAbyssalCleanupPreparationContext,
  validateAbyssalCleanupEntryRecovery,
  verifyAbyssalCleanupDestructionReceipts,
  stageAbyssalTerminalCleanupAttempt,
  settleAbyssalCleanupAchievements,
  reconcileAbyssalCleanupTraceReturn,
}, pocketState, deps, options = {}) {
  const context = buildAbyssalCleanupPreparationContext(pocketState, deps, options);
  for (const prepare of [
    validateAbyssalCleanupEntryRecovery,
    verifyAbyssalCleanupDestructionReceipts,
    stageAbyssalTerminalCleanupAttempt,
    settleAbyssalCleanupAchievements,
    reconcileAbyssalCleanupTraceReturn,
  ]) {
    const result = prepare(context);
    if (result) return { ready: false, result };
  }
  return {
    ready: true,
    resolvedPocketState: context.resolvedPocketState,
    instanceID: context.instanceID,
    reason: context.reason,
    cleanupNowMs: context.cleanupNowMs,
    stagedCleanupState: context.stagedCleanupState,
  };
}

// Capture supplied capabilities once, as the original closure did. Internal
// callbacks are bound once per instance; no runtime state lives in this wiring.
function createAbyssalCleanupPreparation({
  getActivePocketStateByInstanceID,
  cloneValue,
  normalizeAbyssalParticipantRoster,
  ABYSSAL_PARTICIPANT_STATUS,
  schedulePlaceholderPocketMaintenance,
  requiresAbyssalParticipantDestructionReceiptForCleanup,
  listUniquePositiveInts,
  getAbyssalParticipantDestructionOperation,
  ABYSSAL_PARTICIPANT_DESTRUCTION_OPERATION_STATUS,
  log,
  persistAndVerifyAbyssalParticipantDestructionOperation,
  getAbyssalTerminalCleanupState,
  updatePocketState,
  ensureAbyssalPocketPersistenceReady,
  normalizeLowerText,
  buildPlaceholderReturnSpaceState,
  markSourceTraceReturnedForPocket,
}) {

  const ports = {
    getActivePocketStateByInstanceID,
    cloneValue,
    normalizeAbyssalParticipantRoster,
    ABYSSAL_PARTICIPANT_STATUS,
    schedulePlaceholderPocketMaintenance,
    requiresAbyssalParticipantDestructionReceiptForCleanup,
    listUniquePositiveInts,
    getAbyssalParticipantDestructionOperation,
    ABYSSAL_PARTICIPANT_DESTRUCTION_OPERATION_STATUS,
    log,
    persistAndVerifyAbyssalParticipantDestructionOperation,
    getAbyssalTerminalCleanupState,
    updatePocketState,
    ensureAbyssalPocketPersistenceReady,
    normalizeLowerText,
    buildPlaceholderReturnSpaceState,
    markSourceTraceReturnedForPocket,
  };
  ports.buildAbyssalCleanupPreparationContext = buildAbyssalCleanupPreparationContext.bind(null, ports);
  ports.validateAbyssalCleanupEntryRecovery = validateAbyssalCleanupEntryRecovery.bind(null, ports);
  ports.verifyAbyssalCleanupDestructionReceipts = verifyAbyssalCleanupDestructionReceipts.bind(null, ports);
  ports.stageAbyssalTerminalCleanupAttempt = stageAbyssalTerminalCleanupAttempt.bind(null, ports);
  ports.settleAbyssalCleanupAchievements = settleAbyssalCleanupAchievements.bind(null, ports);
  ports.reconcileAbyssalCleanupTraceReturn = reconcileAbyssalCleanupTraceReturn.bind(null, ports);
  ports.prepareAbyssalRunCleanup = prepareAbyssalRunCleanup.bind(null, ports);
  Object.freeze(ports);
  return { prepareAbyssalRunCleanup: ports.prepareAbyssalRunCleanup };
}

module.exports = { createAbyssalCleanupPreparation };
