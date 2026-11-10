"use strict";

const { normalizeText } = require("../domain/abyssalValueUtils");

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

// Recover failed entry and legacy relog state without granting gameplay authority.
// Compensation claims gate teardown, not the participant's safe return to K-space.
function persistPendingAbyssalEntryRecovery({
  getDependencies,
  getActivePocketStateByInstanceID,
  getPendingAbyssalTransitionState,
  commitPocketStateDurably,
  cloneValue,
},
  pocketState,
  patch,
  deps = getDependencies(),
  options = {},
) {
  const instanceID = toInt(pocketState && pocketState.instanceID, 0);
  const activePocketState =
    getActivePocketStateByInstanceID(instanceID) || pocketState;
  if (instanceID <= 0 || !activePocketState) {
    return {
      success: false,
      errorMsg: "ABYSSAL_ENTRY_RECOVERY_POCKET_MISSING",
    };
  }
  const pendingTransitionState = getPendingAbyssalTransitionState(activePocketState);
  const committedAtMs = toInt(deps && deps.now && deps.now(), Date.now());
  return commitPocketStateDurably(
    instanceID,
    {
      ...cloneValue(options.pocketPatch || {}),
      allowDebugExit: false,
      entryRecoveryState: {
        ...cloneValue(activePocketState.entryRecoveryState || {}),
        ...cloneValue(patch || {}),
        pending: true,
        rewardEligible: false,
        recordedAtMs: committedAtMs,
      },
      ...(pendingTransitionState && pendingTransitionState.phase === "entry"
        ? {
            pendingTransitionState: {
              ...cloneValue(pendingTransitionState),
              status: "failed",
              currentPhase: "entry-rollback-pending",
              failureReason: normalizeText(
                patch && patch.activationFailureReason,
                normalizeText(
                  patch && patch.readinessError,
                  "ENTRY_ACTIVE_ROOM_NOT_READY",
                ),
              ),
              completedAtMs: committedAtMs,
              destinationControllersActive: false,
            },
          }
        : {}),
    },
    deps,
    { verifyReadBack: true, forceWrite: true },
  );
}

function stageAbyssalEntryRecoveryCompensation({
  getActiveTraceState,
  stageAbyssalFilamentCompensationClaim,
  readAbyssalFilamentCompensationClaim,
}, context) {
  const { workingState, entryRecoveryState, deps } = context;
  const compensationRequired = Boolean(
    entryRecoveryState.compensationRequired === true ||
    normalizeText(entryRecoveryState.activationFailureReason, "") ===
      "ENTRY_ACTIVE_ROOM_NOT_READY"
  );
  let compensationDurablyStaged =
    !compensationRequired || entryRecoveryState.compensationDurablyStaged === true;
  let compensationStageResult = null;
  const compensationTraceState = getActiveTraceState(
    toInt(workingState && workingState.traceItemID, 0),
    deps,
  );
  let compensationClaim = null;
  const compensationDeploymentToken = normalizeText(
    compensationTraceState && compensationTraceState.deploymentToken,
    normalizeText(entryRecoveryState.compensationDeploymentToken, ""),
  );
  if (compensationRequired && !compensationDurablyStaged) {
    compensationStageResult = stageAbyssalFilamentCompensationClaim(
      compensationTraceState,
      deps,
      normalizeText(
        entryRecoveryState.activationFailureReason,
        "ENTRY_ACTIVE_ROOM_NOT_READY",
      ),
      { authoritativeEntryCommitted: true },
    );
    compensationDurablyStaged = Boolean(
      compensationStageResult &&
      compensationStageResult.success === true &&
      compensationStageResult.durable === true
    );
    compensationClaim = compensationStageResult && compensationStageResult.claim || null;
  } else if (compensationRequired) {
    if (compensationDeploymentToken) {
      const compensationReadResult = readAbyssalFilamentCompensationClaim(
        compensationDeploymentToken,
        deps,
      );
      compensationClaim = compensationReadResult && compensationReadResult.success === true
        ? compensationReadResult.data
        : null;
    }
  }
  Object.assign(context, {
    compensationDurablyStaged, compensationStageResult, compensationClaim,
  });
}

function evacuateAbyssalEntryRecoveryGroup({
  moveOtherAbyssalParticipantsOutOfRun,
  ABYSSAL_ENTRY_RECOVERY_REASON,
  persistPendingAbyssalEntryRecovery,
  cloneValue,
  getActivePocketStateByInstanceID,
}, context) {
  let { workingState } = context;
  const {
    session, deps, entryRecoveryState, compensationDurablyStaged, compensationStageResult,
  } = context;
  const groupEvacuationResult = moveOtherAbyssalParticipantsOutOfRun(
    workingState,
    session,
    deps,
    {
      reason: normalizeText(
        entryRecoveryState.reason,
        ABYSSAL_ENTRY_RECOVERY_REASON.PENDING_EVACUATION,
      ),
    },
  );
  if (!groupEvacuationResult || groupEvacuationResult.success !== true) {
    const persistResult = persistPendingAbyssalEntryRecovery(
      workingState,
      {
        ...cloneValue(entryRecoveryState),
        reason: ABYSSAL_ENTRY_RECOVERY_REASON.EVACUATION_FAILED,
        compensationDurablyStaged,
        compensationStageError: compensationDurablyStaged
          ? ""
          : normalizeText(
              compensationStageResult && compensationStageResult.errorMsg,
              "FILAMENT_COMPENSATION_STAGE_FAILED",
            ),
        evacuationError: normalizeText(
          groupEvacuationResult && groupEvacuationResult.errorMsg,
          "ABYSSAL_PARTICIPANT_GROUP_EVACUATION_FAILED",
        ),
      },
      deps,
    );
    return {
      success: false,
      settled: false,
      recoveryPending: true,
      errorMsg: normalizeText(
        groupEvacuationResult && groupEvacuationResult.errorMsg,
        "ABYSSAL_PARTICIPANT_GROUP_EVACUATION_FAILED",
      ),
      groupEvacuationResult,
      compensationStageResult,
      persistenceResult: persistResult,
      pocketState:
        getActivePocketStateByInstanceID(toInt(workingState.instanceID, 0)) ||
        workingState,
    };
  }
  workingState = groupEvacuationResult.pocketState || workingState;
  Object.assign(context, { workingState, groupEvacuationResult });
  return null;
}

function finishAbyssalEntryRecovery({
  evacuateAbyssalRunSession,
  ABYSSAL_ENTRY_RECOVERY_REASON,
  settleAbyssalFilamentCompensationClaim,
  persistPendingAbyssalEntryRecovery,
  getActivePocketStateByInstanceID,
  cloneValue,
}, context) {
  const {
    session, deps, workingState, entryRecoveryState, compensationDurablyStaged,
    compensationStageResult, compensationClaim, groupEvacuationResult,
  } = context;
  const evacuationResult = evacuateAbyssalRunSession(
    session,
    workingState,
    normalizeText(
      entryRecoveryState.reason,
      ABYSSAL_ENTRY_RECOVERY_REASON.PENDING_EVACUATION,
    ),
    deps,
    { cleanupRun: compensationDurablyStaged },
  );
  const cleanupComplete = Boolean(
    compensationDurablyStaged &&
    evacuationResult &&
    evacuationResult.success === true &&
    evacuationResult.cleanupResult &&
    evacuationResult.cleanupResult.success === true
  );
  if (cleanupComplete) {
    const compensationSettlementResult = compensationClaim
      ? settleAbyssalFilamentCompensationClaim(
          compensationClaim,
          session,
          deps,
        )
      : { success: true, skipped: true };
    return {
      success: true,
      settled: true,
      recoveryPending: false,
      groupEvacuationResult,
      evacuationResult,
      compensationStageResult,
      compensationSettlementResult,
      pocketState: null,
    };
  }

  const recoveryReason =
    !evacuationResult || evacuationResult.success !== true
      ? ABYSSAL_ENTRY_RECOVERY_REASON.EVACUATION_FAILED
      : !compensationDurablyStaged
        ? ABYSSAL_ENTRY_RECOVERY_REASON.COMPENSATION_PENDING
        : ABYSSAL_ENTRY_RECOVERY_REASON.CLEANUP_PENDING;
  const persistenceResult = persistPendingAbyssalEntryRecovery(
    getActivePocketStateByInstanceID(toInt(workingState.instanceID, 0)) ||
      workingState,
    {
      ...cloneValue(entryRecoveryState),
      reason: recoveryReason,
      compensationDurablyStaged,
      compensationStageError: compensationDurablyStaged
        ? ""
        : normalizeText(
            compensationStageResult && compensationStageResult.errorMsg,
            "FILAMENT_COMPENSATION_STAGE_FAILED",
          ),
      evacuationError: normalizeText(
        evacuationResult && evacuationResult.errorMsg,
        evacuationResult && evacuationResult.success === true
          ? "ABYSSAL_TERMINAL_CLEANUP_INCOMPLETE"
          : "ABYSSAL_EVACUATION_FAILED",
      ),
    },
    deps,
  );
  return {
    success: false,
    settled: false,
    recoveryPending: true,
    errorMsg: normalizeText(
      evacuationResult && evacuationResult.errorMsg,
      recoveryReason,
    ),
    groupEvacuationResult,
    evacuationResult,
    compensationStageResult,
    persistenceResult,
    pocketState:
      getActivePocketStateByInstanceID(toInt(workingState.instanceID, 0)) ||
      workingState,
  };
}

function stageAbyssalCompatibilityRecoveryIntent({
  buildPlaceholderRoomState,
  clampRoomIndex,
  getPlaceholderRoomEntry,
  setPlaceholderRoomEntry,
  buildPocketStateForCurrentRoom,
  persistPendingAbyssalEntryRecovery,
  ABYSSAL_ENTRY_RECOVERY_REASON,
  ABYSSAL_RUN_OUTCOME,
  cloneValue,
  getRewardState,
  schedulePlaceholderPocketMaintenance,
  getActivePocketStateByInstanceID,
}, context) {
  const { instanceID, activePocketState, reason, deps, options } = context;
  const normalizedReason = normalizeText(reason, "ABYSSAL_COMPATIBILITY_RECOVERY");
  const compatibilityPath = normalizeText(
    options.compatibilityPath,
    "legacy-compatibility-recovery",
  );
  const suppressionReason = normalizeText(
    options.suppressionReason,
    "ABYSSAL_COMPATIBILITY_RECOVERY_PENDING",
  );
  const stagedAtMs = toInt(deps && deps.now && deps.now(), Date.now());
  const roomState = buildPlaceholderRoomState(activePocketState);
  const roomIndex = clampRoomIndex(
    roomState.currentRoomIndex,
    roomState.implementedRooms,
  );
  const roomEntry = getPlaceholderRoomEntry(activePocketState, roomIndex);
  const failClosedRoomState = setPlaceholderRoomEntry(
    activePocketState,
    roomIndex,
    {
      ...roomEntry,
      objectiveComplete: false,
      conduitOpen: false,
      unavailableReason: suppressionReason,
      suppressedReason: suppressionReason,
    },
  );
  const failClosedRoomPatch = buildPocketStateForCurrentRoom(
    activePocketState,
    failClosedRoomState,
  );
  const recoveryIntentResult = persistPendingAbyssalEntryRecovery(
    activePocketState,
    {
      reason: ABYSSAL_ENTRY_RECOVERY_REASON.PENDING_EVACUATION,
      compatibilityPath,
      compatibilityReason: normalizedReason,
      compensationRequired: false,
      compensationDurablyStaged: true,
      evacuationError: "",
    },
    deps,
    {
      pocketPatch: {
        ...failClosedRoomPatch,
        objectiveComplete: false,
        gameplayAuthorityDetached: true,
        gameplayAuthorityDetachedAtMs:
          toInt(activePocketState.gameplayAuthorityDetachedAtMs, 0) || stagedAtMs,
        gameplayAuthorityDetachedReason: `${compatibilityPath}-recovery-pending`,
        runOutcome: ABYSSAL_RUN_OUTCOME.ABANDONED_OR_RECOVERED,
        runOutcomeAtMs: toInt(activePocketState.runOutcomeAtMs, 0) || stagedAtMs,
        runOutcomeDetails: {
          ...cloneValue(activePocketState.runOutcomeDetails || {}),
          reason: normalizedReason,
          compatibilityPath,
          rewardEligible: false,
          recoveryPending: true,
        },
        rewardState: {
          ...cloneValue(getRewardState(activePocketState) || {}),
          cacheRewardEntries: [],
          spawnMode: "suppressed",
          unavailableReason: suppressionReason,
          suppressedReason: suppressionReason,
          rewardTypeID: 0,
          rewardQuantity: 0,
          contentsGranted: false,
        },
      },
    },
  );
  if (!recoveryIntentResult || recoveryIntentResult.success !== true) {
    schedulePlaceholderPocketMaintenance(deps);
    return {
      success: false,
      settled: false,
      recoveryPending: true,
      cleanedUp: false,
      evacuated: false,
      errorMsg: normalizeText(
        recoveryIntentResult && recoveryIntentResult.errorMsg,
        "ABYSSAL_COMPATIBILITY_RECOVERY_INTENT_PERSIST_FAILED",
      ),
      recoveryIntentResult,
      pocketState: getActivePocketStateByInstanceID(instanceID) || activePocketState,
    };
  }
  Object.assign(context, {
    normalizedReason, compatibilityPath, suppressionReason, roomIndex, recoveryIntentResult,
  });
  return null;
}

function suppressAbyssalCompatibilityRecoveryGameplay({
  cloneValue,
  cancelPendingAbyssalTransition,
  suppressAbyssalRoomRewards,
  persistPendingAbyssalEntryRecovery,
  getActivePocketStateByInstanceID,
  schedulePlaceholderPocketMaintenance,
}, context) {
  const {
    instanceID, deps, normalizedReason, roomIndex, suppressionReason,
    compatibilityPath, recoveryIntentResult,
  } = context;
  let stagedPocketState = cloneValue(
    recoveryIntentResult.committedState || recoveryIntentResult.state,
  );
  cancelPendingAbyssalTransition(instanceID, deps, normalizedReason);
  try {
    stagedPocketState = suppressAbyssalRoomRewards(
      stagedPocketState,
      roomIndex,
      deps,
      suppressionReason,
    ) || stagedPocketState;
  } catch (error) {
    const suppressionError = normalizeText(
      error && (error.code || error.message),
      "ABYSSAL_COMPATIBILITY_GAMEPLAY_SUPPRESSION_FAILED",
    );
    const suppressionPersistenceResult = persistPendingAbyssalEntryRecovery(
      getActivePocketStateByInstanceID(instanceID) || stagedPocketState,
      {
        compatibilityPath,
        compatibilityReason: normalizedReason,
        gameplaySuppressionError: suppressionError,
      },
      deps,
    );
    schedulePlaceholderPocketMaintenance(deps);
    return {
      success: false,
      settled: false,
      recoveryPending: true,
      cleanedUp: false,
      evacuated: false,
      errorMsg: suppressionError,
      recoveryIntentResult,
      suppressionPersistenceResult,
      pocketState: getActivePocketStateByInstanceID(instanceID) || stagedPocketState,
    };
  }
  context.stagedPocketState = stagedPocketState;
  return null;
}

function finishAbyssalCompatibilityRecovery({
  reconcilePendingAbyssalEntryRecovery,
  getActivePocketStateByInstanceID,
}, context) {
  const { instanceID, stagedPocketState, session, deps, recoveryIntentResult } = context;
  const entryRecoveryResult = reconcilePendingAbyssalEntryRecovery(
    getActivePocketStateByInstanceID(instanceID) || stagedPocketState,
    session,
    deps,
  );
  const settled = Boolean(
    entryRecoveryResult && entryRecoveryResult.settled === true,
  );
  const evacuationResult = entryRecoveryResult && entryRecoveryResult.evacuationResult;
  return {
    success: settled,
    settled,
    recoveryPending: !settled,
    cleanedUp: settled,
    evacuated: Boolean(evacuationResult && evacuationResult.evacuated === true),
    errorMsg: settled
      ? ""
      : normalizeText(
          entryRecoveryResult && entryRecoveryResult.errorMsg,
          "ABYSSAL_COMPATIBILITY_RECOVERY_PENDING",
        ),
    recoveryIntentResult,
    entryRecoveryResult,
    evacuationResult,
    groupEvacuationResult:
      entryRecoveryResult && entryRecoveryResult.groupEvacuationResult,
    pocketState: getActivePocketStateByInstanceID(instanceID),
  };
}

function reconcilePendingAbyssalEntryRecovery({
  getDependencies,
  getActivePocketStateByInstanceID,
  stageAbyssalEntryRecoveryCompensation,
  evacuateAbyssalEntryRecoveryGroup,
  finishAbyssalEntryRecovery,
},
  pocketState,
  session = null,
  deps = getDependencies(),
) {
  let workingState = getActivePocketStateByInstanceID(
    toInt(pocketState && pocketState.instanceID, 0),
  ) || pocketState;
  const entryRecoveryState =
    workingState && workingState.entryRecoveryState || null;
  if (!entryRecoveryState || entryRecoveryState.pending !== true) {
    return {
      success: true,
      skipped: true,
      settled: false,
      pocketState: workingState,
    };
  }
  const context = { workingState, entryRecoveryState, session, deps };
  stageAbyssalEntryRecoveryCompensation(context);
  const groupFailure = evacuateAbyssalEntryRecoveryGroup(context);
  if (groupFailure) return groupFailure;
  return finishAbyssalEntryRecovery(context);
}

function beginAbyssalCompatibilityRecovery({
  getDependencies,
  getActivePocketStateByInstanceID,
  stageAbyssalCompatibilityRecoveryIntent,
  suppressAbyssalCompatibilityRecoveryGameplay,
  finishAbyssalCompatibilityRecovery,
},
  session,
  pocketState,
  reason,
  deps = getDependencies(),
  options = {},
) {
  const instanceID = toInt(pocketState && pocketState.instanceID, 0);
  const activePocketState =
    getActivePocketStateByInstanceID(instanceID) || pocketState;
  if (instanceID <= 0 || !activePocketState) {
    return {
      success: false,
      settled: false,
      recoveryPending: false,
      cleanedUp: false,
      evacuated: false,
      errorMsg: "ABYSSAL_COMPATIBILITY_RECOVERY_POCKET_MISSING",
    };
  }
  const context = { instanceID, activePocketState, session, reason, deps, options };
  const intentFailure = stageAbyssalCompatibilityRecoveryIntent(context);
  if (intentFailure) return intentFailure;
  const suppressionFailure = suppressAbyssalCompatibilityRecoveryGameplay(context);
  if (suppressionFailure) return suppressionFailure;
  return finishAbyssalCompatibilityRecovery(context);
}

function abandonRelogRecovery({
  getDependencies,
  getAbyssalParticipantRecord,
  normalizeAbyssalParticipantRoster,
  ABYSSAL_PARTICIPANT_STATUS,
  moveOtherAbyssalParticipantsOutOfRun,
  log,
  beginAbyssalCompatibilityRecovery,
}, session, context, pocketState, reason, deps = getDependencies()) {
  const participant = getAbyssalParticipantRecord(
    pocketState,
    context.characterID,
  );
  const survivingParticipants = normalizeAbyssalParticipantRoster(pocketState)
    .filter((entry) =>
      entry.characterID !== context.characterID &&
      [
        ABYSSAL_PARTICIPANT_STATUS.ACTIVE,
        ABYSSAL_PARTICIPANT_STATUS.DISCONNECTED,
        ABYSSAL_PARTICIPANT_STATUS.ADMITTING,
      ].includes(entry.status)
    );
  if (participant && survivingParticipants.length > 0) {
    const participantEvacuationResult = moveOtherAbyssalParticipantsOutOfRun(
      pocketState,
      null,
      deps,
      {
        characterID: context.characterID,
        reason: `relog-participant-evacuation-${normalizeText(reason, "unknown").toLowerCase()}`,
      },
    );
    log.warn(
      `[AbyssalRoster] participant recovery abandoned without terminating group ` +
        `character=${context.characterID} ship=${participant.shipID} ` +
        `run=${pocketState.instanceID} survivors=${survivingParticipants.length} ` +
        `evacuated=${Boolean(participantEvacuationResult && participantEvacuationResult.success)}`,
    );
    return {
      recovered: false,
      cleanedUp: false,
      participantEvacuated: Boolean(
        participantEvacuationResult && participantEvacuationResult.success === true,
      ),
      evacuated: Boolean(
        participantEvacuationResult && participantEvacuationResult.success === true,
      ),
      reason: normalizeText(reason, "UNKNOWN"),
      participantEvacuationResult,
    };
  }
  log.warn(
    `[AbyssalMgr] Relog recovery abandoned char=${context.characterID} ` +
      `ship=${toInt(context.shipID, toInt(pocketState && pocketState.shipID, 0))} ` +
      `run=${toInt(pocketState && pocketState.instanceID, 0)} reason=${normalizeText(reason, "UNKNOWN")}`,
  );
  const compatibilityRecovery = beginAbyssalCompatibilityRecovery(
    session,
    pocketState,
    reason,
    deps,
    {
      compatibilityPath: "abandon-relog-recovery",
      suppressionReason: "RELOG_RECOVERY_EVACUATION_PENDING",
    },
  );
  log.warn(
    `[AbyssalMgr] Relog compatibility recovery char=${context.characterID} ` +
      `instance=${toInt(pocketState && pocketState.instanceID, 0)} trace=${toInt(pocketState && pocketState.traceItemID, 0)} ` +
      `reason=${normalizeText(reason, "UNKNOWN")} evacuated=${compatibilityRecovery.evacuated === true} ` +
      `cleanedUp=${compatibilityRecovery.cleanedUp === true}`,
  );
  return {
    recovered: false,
    entryRecovery: true,
    cleanedUp: compatibilityRecovery.cleanedUp === true,
    evacuated: compatibilityRecovery.evacuated === true,
    recoveryPending: compatibilityRecovery.recoveryPending === true,
    reason: normalizeText(
      compatibilityRecovery.errorMsg,
      normalizeText(reason, "UNKNOWN"),
    ),
    compatibilityRecovery,
    entryRecoveryResult: compatibilityRecovery.entryRecoveryResult,
    evacuationResult: compatibilityRecovery.evacuationResult,
    pocketState: compatibilityRecovery.pocketState,
  };
}

// Capture supplied capabilities once, as the original closure did. Internal
// callbacks are bound once per instance; no runtime state lives in this wiring.
function createAbyssalCompatibilityRecovery({
  getDependencies,
  getActivePocketStateByInstanceID,
  getPendingAbyssalTransitionState,
  commitPocketStateDurably,
  cloneValue,
  getActiveTraceState,
  stageAbyssalFilamentCompensationClaim,
  readAbyssalFilamentCompensationClaim,
  moveOtherAbyssalParticipantsOutOfRun,
  ABYSSAL_ENTRY_RECOVERY_REASON,
  evacuateAbyssalRunSession,
  settleAbyssalFilamentCompensationClaim,
  buildPlaceholderRoomState,
  clampRoomIndex,
  getPlaceholderRoomEntry,
  setPlaceholderRoomEntry,
  buildPocketStateForCurrentRoom,
  ABYSSAL_RUN_OUTCOME,
  getRewardState,
  schedulePlaceholderPocketMaintenance,
  cancelPendingAbyssalTransition,
  suppressAbyssalRoomRewards,
  getAbyssalParticipantRecord,
  normalizeAbyssalParticipantRoster,
  ABYSSAL_PARTICIPANT_STATUS,
  log,
}) {

  const ports = {
    getDependencies,
    getActivePocketStateByInstanceID,
    getPendingAbyssalTransitionState,
    commitPocketStateDurably,
    cloneValue,
    getActiveTraceState,
    stageAbyssalFilamentCompensationClaim,
    readAbyssalFilamentCompensationClaim,
    moveOtherAbyssalParticipantsOutOfRun,
    ABYSSAL_ENTRY_RECOVERY_REASON,
    evacuateAbyssalRunSession,
    settleAbyssalFilamentCompensationClaim,
    buildPlaceholderRoomState,
    clampRoomIndex,
    getPlaceholderRoomEntry,
    setPlaceholderRoomEntry,
    buildPocketStateForCurrentRoom,
    ABYSSAL_RUN_OUTCOME,
    getRewardState,
    schedulePlaceholderPocketMaintenance,
    cancelPendingAbyssalTransition,
    suppressAbyssalRoomRewards,
    getAbyssalParticipantRecord,
    normalizeAbyssalParticipantRoster,
    ABYSSAL_PARTICIPANT_STATUS,
    log,
  };
  ports.persistPendingAbyssalEntryRecovery = persistPendingAbyssalEntryRecovery.bind(null, ports);
  ports.stageAbyssalEntryRecoveryCompensation = stageAbyssalEntryRecoveryCompensation.bind(null, ports);
  ports.evacuateAbyssalEntryRecoveryGroup = evacuateAbyssalEntryRecoveryGroup.bind(null, ports);
  ports.finishAbyssalEntryRecovery = finishAbyssalEntryRecovery.bind(null, ports);
  ports.stageAbyssalCompatibilityRecoveryIntent = stageAbyssalCompatibilityRecoveryIntent.bind(null, ports);
  ports.suppressAbyssalCompatibilityRecoveryGameplay = suppressAbyssalCompatibilityRecoveryGameplay.bind(null, ports);
  ports.finishAbyssalCompatibilityRecovery = finishAbyssalCompatibilityRecovery.bind(null, ports);
  ports.reconcilePendingAbyssalEntryRecovery = reconcilePendingAbyssalEntryRecovery.bind(null, ports);
  ports.beginAbyssalCompatibilityRecovery = beginAbyssalCompatibilityRecovery.bind(null, ports);
  ports.abandonRelogRecovery = abandonRelogRecovery.bind(null, ports);
  Object.freeze(ports);
  return {
    persistPendingAbyssalEntryRecovery: ports.persistPendingAbyssalEntryRecovery,
    reconcilePendingAbyssalEntryRecovery: ports.reconcilePendingAbyssalEntryRecovery,
    beginAbyssalCompatibilityRecovery: ports.beginAbyssalCompatibilityRecovery,
    abandonRelogRecovery: ports.abandonRelogRecovery,
  };
}

module.exports = { createAbyssalCompatibilityRecovery };
