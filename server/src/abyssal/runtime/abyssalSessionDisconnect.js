"use strict";

const { normalizeText } = require("../domain/abyssalValueUtils");

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

// Keep disconnect ordering explicit; durable state and runtime authority stay injected.
function finalizeDisconnectedAbyssalArrival({
  buildAbyssalKSpaceArrivalReadiness,
  logAbyssalKSpaceArrival,
  finalizeAbyssalKSpaceArrival,
}, context) {
  const { session, deps } = context;
  if (session && session._abyssalKSpaceArrival) {
    const pendingArrival = session._abyssalKSpaceArrival;
    const readiness = buildAbyssalKSpaceArrivalReadiness(pendingArrival, session, deps);
    logAbyssalKSpaceArrival(
      pendingArrival,
      readiness,
      "skipped",
      "SESSION_DISCONNECTED",
    );
    const cleanupResult = finalizeAbyssalKSpaceArrival(
      pendingArrival,
      session,
      deps,
      { notifyClient: false },
    );
    return {
      success: true,
      active: false,
      cleanupResult,
    };
  }

  return null;
}

function detachTerminalAbyssalSession({
  evaluateAbyssalDirectCallbackTerminalGuard,
  hasTerminalFailureOutcome,
  syncExpiredAbyssalPocketState,
  getActivePocketStateByInstanceID,
  stopSuppressorPresentationForPocketSession,
  buildPlaceholderRoomState,
  clearAbyssalSessionState,
  buildAbyssalDirectCallbackSuppressedResult,
  cloneValue,
}, context) {
  const { session, deps, pocketState, traceState } = context;
  if (pocketState) {
    const terminalGuard = evaluateAbyssalDirectCallbackTerminalGuard(
      pocketState,
      "session-disconnect",
    );
    if (terminalGuard.blocked) {
      let terminalReconciliation = null;
      if (hasTerminalFailureOutcome(terminalGuard.pocketState)) {
        terminalReconciliation = syncExpiredAbyssalPocketState(
          terminalGuard.pocketState,
          null,
          deps,
          session,
          { emitNotifications: false },
        );
      }
      const effectivePocketState =
        getActivePocketStateByInstanceID(terminalGuard.instanceID) ||
        terminalReconciliation ||
        terminalGuard.pocketState;
      if (effectivePocketState) {
        stopSuppressorPresentationForPocketSession(
          effectivePocketState,
          session,
          deps,
          {
            roomIndex: buildPlaceholderRoomState(effectivePocketState).currentRoomIndex,
            reason: "terminal-session-detached",
            notifyClient: false,
          },
        );
      }
      clearAbyssalSessionState(session);
      return buildAbyssalDirectCallbackSuppressedResult(terminalGuard, {
        handled: true,
        extra: {
          active: Boolean(
            getActivePocketStateByInstanceID(terminalGuard.instanceID),
          ),
          traceState: traceState || null,
          terminalReconciliation:
            terminalReconciliation && typeof terminalReconciliation === "object"
              ? cloneValue(terminalReconciliation)
              : null,
        },
      });
    }
  }

  return null;
}

function disconnectAbyssalRosterParticipant({
  getAbyssalParticipantRecord,
  normalizeAbyssalParticipantRoster,
  ABYSSAL_PARTICIPANT_STATUS,
  ABYSSAL_TERMINAL_PARTICIPANT_STATUSES,
  upsertAbyssalParticipantRosterEntry,
  commitPocketStateDurably,
  cloneValue,
  stopSuppressorPresentationForPocketSession,
  buildPlaceholderRoomState,
  clearAbyssalSessionState,
  log,
}, context) {
  const { session, deps, characterID, traceState } = context;
  let { pocketState } = context;
  const participant = pocketState
    ? getAbyssalParticipantRecord(pocketState, characterID)
    : null;
  const multiplayerRoster = pocketState
    ? normalizeAbyssalParticipantRoster(pocketState).filter((entry) =>
        entry.status !== ABYSSAL_PARTICIPANT_STATUS.ADMISSION_FAILED
      )
    : [];
  if (
    pocketState &&
    participant &&
    multiplayerRoster.length > 1 &&
    !ABYSSAL_TERMINAL_PARTICIPANT_STATUSES.has(participant.status)
  ) {
    const disconnectedAtMs = toInt(deps.now(), Date.now());
    const participantRoster = upsertAbyssalParticipantRosterEntry(pocketState, {
      ...participant,
      status: ABYSSAL_PARTICIPANT_STATUS.DISCONNECTED,
      disconnectedAtMs,
      lastSeenAtMs: disconnectedAtMs,
    });
    const disconnectCommit = commitPocketStateDurably(
      pocketState.instanceID,
      { participantRoster },
      deps,
      { verifyReadBack: true, forceWrite: true },
    );
    pocketState = disconnectCommit && disconnectCommit.success === true
      ? cloneValue(disconnectCommit.committedState || disconnectCommit.state)
      : pocketState;
    stopSuppressorPresentationForPocketSession(pocketState, session, deps, {
      roomIndex: buildPlaceholderRoomState(pocketState).currentRoomIndex,
      reason: "participant-session-detached",
      notifyClient: false,
    });
    clearAbyssalSessionState(session);
    log.info(
      `[AbyssalRoster] participant disconnected character=${characterID} ` +
        `ship=${participant.shipID} run=${pocketState.instanceID} ` +
        `rosterPersisted=${Boolean(disconnectCommit && disconnectCommit.success === true)}`,
    );
    return {
      success: Boolean(disconnectCommit && disconnectCommit.success === true),
      active: true,
      participantDisconnected: true,
      pocketState,
      traceState: traceState || null,
      errorMsg: disconnectCommit && disconnectCommit.success !== true
        ? normalizeText(
            disconnectCommit.errorMsg,
            "ABYSSAL_PARTICIPANT_DISCONNECT_PERSIST_FAILED",
          )
        : "",
    };
  }

  return null;
}

function settleDisconnectedAbyssalTransition({
  getPendingAbyssalTransitionState,
  clearPendingAbyssalTransitionHandle,
  settleFailedAbyssalDestinationActivation,
  cleanupAbyssalRun,
  clearAbyssalSessionState,
  getActivePocketStateByInstanceID,
  cancelPendingAbyssalTransition,
  purgePlaceholderPocket,
  restoreAbyssalSourceRoomAfterTransitionFailure,
}, context) {
  const { session, options, deps, traceState } = context;
  let { pocketState } = context;
  const pendingTransitionState = getPendingAbyssalTransitionState(pocketState);
  if (pendingTransitionState && pendingTransitionState.status === "pending") {
    if (pendingTransitionState.sourceCommitIrreversible === true) {
      clearPendingAbyssalTransitionHandle(pocketState.instanceID, deps);
      const irreversibleSettlement = pendingTransitionState.phase === "transfer"
        ? settleFailedAbyssalDestinationActivation(
            pocketState,
            session,
            deps,
            "ABYSSAL_IRREVERSIBLE_TRANSFER_DISCONNECTED",
            {
              sourceRoomIndex: toInt(pendingTransitionState.sourceRoomIndex, 0),
              destinationRoomIndex: toInt(pendingTransitionState.targetRoomIndex, 0),
              failureStage: "disconnect-after-destination-commit",
            },
          )
        : cleanupAbyssalRun(pocketState, deps, {
            reason: "final-exit",
            session,
          });
      clearAbyssalSessionState(session);
      return {
        success: true,
        active: false,
        irreversible: true,
        settlementResult: irreversibleSettlement,
        pocketState: getActivePocketStateByInstanceID(pocketState.instanceID),
        traceState: traceState || null,
      };
    }
    pocketState = cancelPendingAbyssalTransition(
      pocketState.instanceID,
      deps,
      normalizeText(options.lifecycleReason, "disconnect"),
    ) || pocketState;
    if (pendingTransitionState.phase === "entry") {
      purgePlaceholderPocket(
        pocketState.instanceID,
        deps,
        "pending-entry-disconnect",
      );
      clearAbyssalSessionState(session);
      return {
        success: true,
        active: Boolean(traceState),
        pocketState: null,
        traceState: traceState || null,
      };
    }
    pocketState = restoreAbyssalSourceRoomAfterTransitionFailure(
      pocketState,
      session,
      deps,
      {
        phase: pendingTransitionState.phase,
        sourceRoomIndex: toInt(pendingTransitionState.sourceRoomIndex, 0),
        targetRoomIndex: toInt(pendingTransitionState.targetRoomIndex, 0),
        failureReason: normalizeText(options.lifecycleReason, "disconnect"),
        terminalStatus: "cancelled",
      },
    ) || pocketState;
  }

  context.pocketState = pocketState;
  return null;
}

function preserveDisconnectedAbyssalRun({
  updateAbyssalFreshEntryBootstrapStatus,
  updatePocketState,
  log,
  getCharacterID,
  stopSuppressorPresentationForPocketSession,
  buildPlaceholderRoomState,
  clearAbyssalSessionState,
}, context) {
  const { session, options, deps, pocketState, traceState } = context;
  if (pocketState) {
    if (session && session._abyssalFreshEntryBootstrap) {
      updateAbyssalFreshEntryBootstrapStatus(
        session,
        pocketState,
        "disconnected",
        deps,
        normalizeText(options.lifecycleReason, "disconnect"),
      );
    }
    updatePocketState(pocketState.instanceID, {
      disconnectState: {
        disconnectedAtMs: deps.now(),
        lifecycleReason: normalizeText(options.lifecycleReason, "disconnect"),
      },
    });
  }
  log.info(
    `[AbyssalMgr] Disconnect/relog recovery char=${getCharacterID(session)} trace=${toInt(traceState && traceState.traceItemID, 0)} instance=${toInt(pocketState && pocketState.instanceID, 0)} state=${pocketState ? "active-pocket-preserved" : "trace-preserved"}`,
  );
  if (pocketState) {
    stopSuppressorPresentationForPocketSession(pocketState, session, deps, {
      roomIndex: buildPlaceholderRoomState(pocketState).currentRoomIndex,
      reason: "session-detached",
      notifyClient: false,
    });
  }
  clearAbyssalSessionState(session);
  return {
    success: true,
    active: true,
    pocketState: pocketState || null,
    traceState: traceState || null,
  };
}

function handleAbyssalSessionDisconnect({
  getDependencies,
  finalizeDisconnectedAbyssalArrival,
  getCharacterID,
  pausePendingAbyssalTraceActivationForCharacter,
  getIndexedPocketStateForCharacterID,
  getActivePocketStateForSession,
  getActivePocketStateForCharacterID,
  getActivePocketStateByInstanceID,
  getActiveTraceStateForCharacterID,
  detachTerminalAbyssalSession,
  disconnectAbyssalRosterParticipant,
  settleDisconnectedAbyssalTransition,
  preserveDisconnectedAbyssalRun,
}, session, options = {}, deps = getDependencies()) {
  const context = { session, options, deps };
  const arrivalResult = finalizeDisconnectedAbyssalArrival(context);
  if (arrivalResult) return arrivalResult;
  const characterID = getCharacterID(session);
  pausePendingAbyssalTraceActivationForCharacter(
    characterID,
    deps,
    normalizeText(options.lifecycleReason, "disconnect"),
  );
  const indexedPocketState = getIndexedPocketStateForCharacterID(
    characterID,
  );
  const pocketState = getActivePocketStateForSession(session) ||
    getActivePocketStateForCharacterID(characterID) ||
    getActivePocketStateByInstanceID(
      toInt(indexedPocketState && indexedPocketState.instanceID, 0),
    );
  const traceState = getActiveTraceStateForCharacterID(getCharacterID(session), deps);
  if (!pocketState && !traceState) {
    return {
      success: true,
      active: false,
    };
  }

  Object.assign(context, { characterID, pocketState, traceState });
  const terminalResult = detachTerminalAbyssalSession(context);
  if (terminalResult) return terminalResult;
  const participantResult = disconnectAbyssalRosterParticipant(context);
  if (participantResult) return participantResult;
  const transitionResult = settleDisconnectedAbyssalTransition(context);
  if (transitionResult) return transitionResult;
  return preserveDisconnectedAbyssalRun(context);
}

// Capture supplied capabilities once, as the original closure did. Internal
// callbacks are bound once per instance; no runtime state lives in this wiring.
function createAbyssalSessionDisconnect({
  getDependencies,
  getCharacterID,
  buildAbyssalKSpaceArrivalReadiness,
  logAbyssalKSpaceArrival,
  finalizeAbyssalKSpaceArrival,
  pausePendingAbyssalTraceActivationForCharacter,
  getIndexedPocketStateForCharacterID,
  getActivePocketStateForSession,
  getActivePocketStateForCharacterID,
  getActivePocketStateByInstanceID,
  getActiveTraceStateForCharacterID,
  evaluateAbyssalDirectCallbackTerminalGuard,
  hasTerminalFailureOutcome,
  syncExpiredAbyssalPocketState,
  stopSuppressorPresentationForPocketSession,
  buildPlaceholderRoomState,
  clearAbyssalSessionState,
  buildAbyssalDirectCallbackSuppressedResult,
  cloneValue,
  getAbyssalParticipantRecord,
  normalizeAbyssalParticipantRoster,
  ABYSSAL_PARTICIPANT_STATUS,
  ABYSSAL_TERMINAL_PARTICIPANT_STATUSES,
  upsertAbyssalParticipantRosterEntry,
  commitPocketStateDurably,
  log,
  getPendingAbyssalTransitionState,
  clearPendingAbyssalTransitionHandle,
  settleFailedAbyssalDestinationActivation,
  cleanupAbyssalRun,
  cancelPendingAbyssalTransition,
  purgePlaceholderPocket,
  restoreAbyssalSourceRoomAfterTransitionFailure,
  updateAbyssalFreshEntryBootstrapStatus,
  updatePocketState,
}) {

  const ports = {
    getDependencies,
    getCharacterID,
    buildAbyssalKSpaceArrivalReadiness,
    logAbyssalKSpaceArrival,
    finalizeAbyssalKSpaceArrival,
    pausePendingAbyssalTraceActivationForCharacter,
    getIndexedPocketStateForCharacterID,
    getActivePocketStateForSession,
    getActivePocketStateForCharacterID,
    getActivePocketStateByInstanceID,
    getActiveTraceStateForCharacterID,
    evaluateAbyssalDirectCallbackTerminalGuard,
    hasTerminalFailureOutcome,
    syncExpiredAbyssalPocketState,
    stopSuppressorPresentationForPocketSession,
    buildPlaceholderRoomState,
    clearAbyssalSessionState,
    buildAbyssalDirectCallbackSuppressedResult,
    cloneValue,
    getAbyssalParticipantRecord,
    normalizeAbyssalParticipantRoster,
    ABYSSAL_PARTICIPANT_STATUS,
    ABYSSAL_TERMINAL_PARTICIPANT_STATUSES,
    upsertAbyssalParticipantRosterEntry,
    commitPocketStateDurably,
    log,
    getPendingAbyssalTransitionState,
    clearPendingAbyssalTransitionHandle,
    settleFailedAbyssalDestinationActivation,
    cleanupAbyssalRun,
    cancelPendingAbyssalTransition,
    purgePlaceholderPocket,
    restoreAbyssalSourceRoomAfterTransitionFailure,
    updateAbyssalFreshEntryBootstrapStatus,
    updatePocketState,
  };
  ports.finalizeDisconnectedAbyssalArrival = finalizeDisconnectedAbyssalArrival.bind(null, ports);
  ports.detachTerminalAbyssalSession = detachTerminalAbyssalSession.bind(null, ports);
  ports.disconnectAbyssalRosterParticipant = disconnectAbyssalRosterParticipant.bind(null, ports);
  ports.settleDisconnectedAbyssalTransition = settleDisconnectedAbyssalTransition.bind(null, ports);
  ports.preserveDisconnectedAbyssalRun = preserveDisconnectedAbyssalRun.bind(null, ports);
  ports.handleAbyssalSessionDisconnect = handleAbyssalSessionDisconnect.bind(null, ports);
  Object.freeze(ports);
  return { handleAbyssalSessionDisconnect: ports.handleAbyssalSessionDisconnect };
}

module.exports = { createAbyssalSessionDisconnect };
