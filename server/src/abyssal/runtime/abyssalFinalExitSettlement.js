"use strict";

const { normalizeText } = require("../domain/abyssalValueUtils");

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

// A committed ship move can converge forward or retain a durable recovery
// obligation. It must never be turned into an uncommitted source rollback.
function stageCommittedAbyssalFinalExitState({
  getActivePocketStateByInstanceID,
  getAbyssalWeatherRemovalState,
  upsertAbyssalParticipantRosterEntry,
  cloneValue,
  getAbyssalParticipantRecord,
  ABYSSAL_PARTICIPANT_STATUS,
  commitPocketStateDurably,
  normalizeLowerText,
}, context, failureReason = "") {
  const {
    pocketState,
    validation,
    exitingCharacterID,
    exitingParticipant,
    exitCommitAtMs,
    returnSpaceState,
    deps,
  } = context;
  const activeExitState =
    getActivePocketStateByInstanceID(toInt(pocketState.instanceID, 0)) || pocketState;
  const previousTraceReturnState =
    activeExitState.traceReturnState &&
    typeof activeExitState.traceReturnState === "object"
      ? activeExitState.traceReturnState
      : {};
  const previousWeatherRemovalState = getAbyssalWeatherRemovalState(activeExitState) || {};
  const exitedParticipantRoster = upsertAbyssalParticipantRosterEntry(
    activeExitState,
    {
      ...cloneValue(
        getAbyssalParticipantRecord(activeExitState, exitingCharacterID) ||
          exitingParticipant,
      ),
      characterID: exitingCharacterID,
      shipID: validation.data.context.shipID,
      status: ABYSSAL_PARTICIPANT_STATUS.EXITED,
      exitedAtMs: exitCommitAtMs,
      lastSeenAtMs: exitCommitAtMs,
    },
  );
  const commitResult = commitPocketStateDurably(
    toInt(pocketState.instanceID, 0),
    {
      participantRoster: exitedParticipantRoster,
      gameplayAuthorityDetached: true,
      gameplayAuthorityDetachedAtMs:
        toInt(activeExitState.gameplayAuthorityDetachedAtMs, 0) || exitCommitAtMs,
      gameplayAuthorityDetachedReason: "final-exit-ship-move-committed",
      committedExitState: {
        ...cloneValue(activeExitState.committedExitState || {}),
        schemaVersion: 1,
        status: "ship-moved",
        instanceID: toInt(activeExitState.instanceID, 0),
        characterID: toInt(validation.data.context.characterID, 0),
        shipID: toInt(validation.data.context.shipID, 0),
        sourceSolarSystemID: toInt(activeExitState.sourceSolarSystemID, 0),
        returnSpaceState: cloneValue(returnSpaceState),
        committedAtMs:
          toInt(activeExitState.committedExitState && activeExitState.committedExitState.committedAtMs, 0) ||
          exitCommitAtMs,
        failureReason: normalizeText(failureReason, ""),
      },
      traceReturnState:
        normalizeLowerText(previousTraceReturnState.status, "") === "completed"
          ? cloneValue(previousTraceReturnState)
          : {
              ...cloneValue(previousTraceReturnState),
              schemaVersion: 1,
              status: "pending",
              instanceID: toInt(activeExitState.instanceID, 0),
              characterID: toInt(validation.data.context.characterID, 0),
              shipID: toInt(validation.data.context.shipID, 0),
              traceItemID: toInt(
                activeExitState.sourceTraceItemID,
                toInt(activeExitState.traceItemID, 0),
              ),
              returnSpaceState: cloneValue(returnSpaceState),
              firstPendingAtMs:
                toInt(previousTraceReturnState.firstPendingAtMs, 0) || exitCommitAtMs,
              failureReason: normalizeText(failureReason, ""),
            },
      weatherRemovalState:
        normalizeLowerText(previousWeatherRemovalState.status, "") === "completed" &&
        previousWeatherRemovalState.verified === true
          ? cloneValue(previousWeatherRemovalState)
          : {
              ...cloneValue(previousWeatherRemovalState),
              schemaVersion: 1,
              status: "pending",
              instanceID: toInt(activeExitState.instanceID, 0),
              characterID: toInt(validation.data.context.characterID, 0),
              shipID: toInt(validation.data.context.shipID, 0),
              traceItemID: toInt(activeExitState.traceItemID, 0),
              reason: "final-exit",
              firstPendingAtMs:
                toInt(previousWeatherRemovalState.firstPendingAtMs, 0) || exitCommitAtMs,
              verified: false,
            },
      pendingTransitionState: {
        ...cloneValue(activeExitState.pendingTransitionState || {}),
        currentPhase: "ship-move-committed",
        sourceCommitIrreversible: true,
        failureReason: normalizeText(failureReason, ""),
        shipMoveCommittedAtMs:
          toInt(
            activeExitState.pendingTransitionState &&
              activeExitState.pendingTransitionState.shipMoveCommittedAtMs,
            0,
          ) || exitCommitAtMs,
      },
    },
    deps,
    { verifyReadBack: true, forceWrite: true },
  );
  if (!commitResult || commitResult.success !== true) {
    return {
      success: false,
      errorMsg: normalizeText(
        commitResult && commitResult.errorMsg,
        "ABYSSAL_EXIT_COMMIT_PERSIST_FAILED",
      ),
      pocketState: activeExitState,
    };
  }
  return {
    success: true,
    pocketState: cloneValue(
      commitResult.committedState || commitResult.state,
    ),
  };
}

function settleCommittedAbyssalFinalExitFailure({
  stageCommittedAbyssalFinalExitState,
  getActivePocketStateByInstanceID,
  schedulePlaceholderPocketMaintenance,
  log,
  sendAbyssalContentFinishedNotification,
  hasTerminalFailureOutcome,
  recordAbyssalRunOutcome,
  AbyssalPocketPersistenceError,
  cleanupAbyssalRun,
}, context, failureReason) {
  const {
    pocketState,
    validation,
    session,
    deps,
  } = context;
  const normalizedFailureReason = normalizeText(
    failureReason,
    "ABYSSAL_EXIT_POST_MOVE_ATTACH_FAILED",
  );
  const markedExitCommit = stageCommittedAbyssalFinalExitState(context, normalizedFailureReason);
  const markedExitState =
    markedExitCommit && markedExitCommit.success === true
      ? markedExitCommit.pocketState
      : getActivePocketStateByInstanceID(toInt(pocketState.instanceID, 0)) || pocketState;
  const committedStatePersistence =
    markedExitCommit && markedExitCommit.success === true
      ? { success: true, durable: true }
      : {
          success: false,
          errorMsg: normalizeText(
            markedExitCommit && markedExitCommit.errorMsg,
            "ABYSSAL_EXIT_COMMIT_PERSIST_FAILED",
          ),
        };
  if (committedStatePersistence.success !== true) {
    schedulePlaceholderPocketMaintenance(deps);
    log.error(
      `[AbyssalMgr] Final exit receipt remains pending after ship move ` +
        `char=${validation.data.context.characterID} ship=${validation.data.context.shipID} ` +
        `instance=${pocketState.instanceID} reason=${normalizedFailureReason} ` +
        `persistReason=${committedStatePersistence.errorMsg}`,
    );
    return {
      success: false,
      committed: true,
      sourceCommitIrreversible: true,
      terminallySettled: false,
      persistencePending: true,
      errorMsg: committedStatePersistence.errorMsg,
    };
  }
  sendAbyssalContentFinishedNotification(session, markedExitState, deps);
  let outcomeState = markedExitState;
  if (!hasTerminalFailureOutcome(markedExitState)) {
    try {
      outcomeState = recordAbyssalRunOutcome(
        markedExitState,
        "exited",
        deps,
        {
          reason: "normal_exit_attach_recovery",
          postMoveFailureReason: normalizedFailureReason,
        },
      ) || markedExitState;
    } catch (error) {
      if (error instanceof AbyssalPocketPersistenceError) {
        schedulePlaceholderPocketMaintenance(deps);
        return {
          success: false,
          committed: true,
          sourceCommitIrreversible: true,
          terminallySettled: false,
          persistencePending: true,
          errorMsg: normalizeText(
            error && error.message,
            "ABYSSAL_EXIT_OUTCOME_PERSIST_FAILED",
          ),
        };
      }
      throw error;
    }
  }
  const cleanupResult = cleanupAbyssalRun(outcomeState, deps, {
    reason: "final-exit",
    session,
  });
  if (!cleanupResult || cleanupResult.success !== true) {
    schedulePlaceholderPocketMaintenance(deps);
  }
  log.error(
    `[AbyssalMgr] Final exit settlement pending after durable ship move ` +
      `char=${validation.data.context.characterID} ship=${validation.data.context.shipID} ` +
      `instance=${pocketState.instanceID} reason=${normalizedFailureReason} ` +
      `statePersisted=${Boolean(committedStatePersistence && committedStatePersistence.success === true)} ` +
      `cleanup=${Boolean(cleanupResult && cleanupResult.success === true)}`,
  );
  return {
    success: false,
    committed: true,
    sourceCommitIrreversible: true,
    terminallySettled: Boolean(cleanupResult && cleanupResult.success === true),
    errorMsg: normalizedFailureReason,
    cleanupResult,
  };
}

// Capture supplied capabilities once, as the original closure did. Internal
// callbacks are bound once per instance; no runtime state lives in this wiring.
function createAbyssalFinalExitSettlement({
  getActivePocketStateByInstanceID,
  getAbyssalWeatherRemovalState,
  upsertAbyssalParticipantRosterEntry,
  cloneValue,
  getAbyssalParticipantRecord,
  ABYSSAL_PARTICIPANT_STATUS,
  commitPocketStateDurably,
  normalizeLowerText,
  schedulePlaceholderPocketMaintenance,
  log,
  sendAbyssalContentFinishedNotification,
  hasTerminalFailureOutcome,
  recordAbyssalRunOutcome,
  AbyssalPocketPersistenceError,
  cleanupAbyssalRun,
}) {

  const ports = {
    getActivePocketStateByInstanceID,
    getAbyssalWeatherRemovalState,
    upsertAbyssalParticipantRosterEntry,
    cloneValue,
    getAbyssalParticipantRecord,
    ABYSSAL_PARTICIPANT_STATUS,
    commitPocketStateDurably,
    normalizeLowerText,
    schedulePlaceholderPocketMaintenance,
    log,
    sendAbyssalContentFinishedNotification,
    hasTerminalFailureOutcome,
    recordAbyssalRunOutcome,
    AbyssalPocketPersistenceError,
    cleanupAbyssalRun,
  };
  ports.stageCommittedAbyssalFinalExitState = stageCommittedAbyssalFinalExitState.bind(null, ports);
  ports.settleCommittedAbyssalFinalExitFailure = settleCommittedAbyssalFinalExitFailure.bind(null, ports);
  Object.freeze(ports);
  return { stageCommittedAbyssalFinalExitState: ports.stageCommittedAbyssalFinalExitState, settleCommittedAbyssalFinalExitFailure: ports.settleCommittedAbyssalFinalExitFailure };
}

module.exports = { createAbyssalFinalExitSettlement };
