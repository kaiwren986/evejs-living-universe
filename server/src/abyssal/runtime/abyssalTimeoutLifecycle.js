"use strict";

const { normalizeText } = require("../domain/abyssalValueUtils");

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

// Timeout orchestration only; participant destruction and durable state authority are injected.
function resolveEffectiveAbyssalMaintenanceNowMs({
  getDependencies,
}, nowMs = null, deps = getDependencies()) {
  return Math.max(
    0,
    toInt(nowMs, 0),
    toInt(deps && typeof deps.now === "function" ? deps.now() : Date.now(), 0),
  );
}

function syncExpiredAbyssalPocketState({
  getDependencies,
  getActivePocketStateByInstanceID,
  resolveEffectiveAbyssalMaintenanceNowMs,
  getAbyssalTimeoutState,
  resolveAbyssalTimeoutDecision,
  isAbyssalTimerAnchored,
  hasImmutableAbyssalRunOutcome,
  hasFailedTimeoutOutcome,
  hasFailedParticipantShipDestroyedOutcome,
  ABYSSAL_DEADLINE_ACTION,
  completeAbyssalParticipantPodDestructionAndCleanup,
  resolveAbyssalTimeoutRuntimeSession,
  handleAbyssalTimeout,
},
  pocketState,
  nowMs = null,
  deps = getDependencies(),
  explicitSession = null,
  terminalOptions = {},
) {
  const resolvedPocketState =
    pocketState && toInt(pocketState.instanceID, 0) > 0
      ? getActivePocketStateByInstanceID(toInt(pocketState.instanceID, 0)) || pocketState
      : null;
  if (!resolvedPocketState) {
    return null;
  }
  const effectiveNowMs = resolveEffectiveAbyssalMaintenanceNowMs(nowMs, deps);
  const timerState = resolvedPocketState.timerState;
  const timeoutState = getAbyssalTimeoutState(resolvedPocketState, deps);
  const deadlineDecision = resolveAbyssalTimeoutDecision({
    nowMs: effectiveNowMs,
    deadline: {
      anchored: isAbyssalTimerAnchored(timerState),
      expiresAtMs: timerState && timerState.expiresAtMs,
      provisionalExpiresAtMs: timerState && timerState.provisionalExpiresAtMs,
    },
    lifecycle: {
      terminal: hasImmutableAbyssalRunOutcome(resolvedPocketState),
      timeoutCommitted: hasFailedTimeoutOutcome(resolvedPocketState),
      participantDestructionCommitted:
        hasFailedParticipantShipDestroyedOutcome(resolvedPocketState),
    },
    timeout: {
      alreadySettled: timeoutState.cleanupTriggered === true,
      handlingInProgress: Boolean(
        (timerState && timerState.expired === true) ||
          resolvedPocketState.timerFailureState ||
          resolvedPocketState.timeoutState,
      ),
    },
  });
  if (
    deadlineDecision.action ===
      ABYSSAL_DEADLINE_ACTION.RECONCILE_PARTICIPANT_DESTRUCTION
  ) {
    completeAbyssalParticipantPodDestructionAndCleanup(
      resolvedPocketState,
      explicitSession || resolveAbyssalTimeoutRuntimeSession(resolvedPocketState, deps),
      deps,
      {
        lethalTimeout: false,
        cleanupReason: "abyssal-combat-destruction",
        nowMs: effectiveNowMs,
        emitNotifications: terminalOptions.emitNotifications !== false,
      },
    );
  } else if (
    deadlineDecision.action === ABYSSAL_DEADLINE_ACTION.SETTLE_TIMEOUT
  ) {
    handleAbyssalTimeout(
      resolvedPocketState,
      effectiveNowMs,
      deps,
      explicitSession,
      terminalOptions,
    );
  }
  return getActivePocketStateByInstanceID(toInt(resolvedPocketState.instanceID, 0));
}

function quiesceAbyssalRunForTimeout({
  getDependencies,
  cancelPendingAbyssalTransition,
  stopSuppressorPresentationsForPocketRun,
  cleanupSuppressorControllersForRun,
  clearSuppressorDebugForRun,
  pauseAbyssalObjectiveControllers,
  listAllPocketHostileEntityIDs,
  getActivePocketStateByInstanceID,
}, pocketState, deps = getDependencies()) {
  const instanceID = toInt(pocketState && pocketState.instanceID, 0);
  if (instanceID <= 0) {
    return pocketState || null;
  }
  cancelPendingAbyssalTransition(instanceID, deps, "abyssal-timeout");
  stopSuppressorPresentationsForPocketRun(pocketState, deps, {
    reason: "abyssal-timeout",
  });
  cleanupSuppressorControllersForRun(instanceID, "abyssal-timeout");
  clearSuppressorDebugForRun(instanceID);
  pauseAbyssalObjectiveControllers(
    deps,
    listAllPocketHostileEntityIDs(pocketState),
    "abyssal-timeout",
  );
  return getActivePocketStateByInstanceID(instanceID) || pocketState;
}

function buildAbyssalLethalTimeoutPhase({}, timeoutState) {
  if (timeoutState.cleanupTriggered === true) {
    return "failed_timeout_lethal_cleaned";
  }
  if (timeoutState.podDestroyed === true) {
    return "failed_timeout_lethal_cleanup_retry";
  }
  if (timeoutState.shipDestroyed === true) {
    return timeoutState.reason === "LETHAL_TIMEOUT_PENDING_POD_DESTRUCTION"
      ? "failed_timeout_lethal_pod_pending"
      : "failed_timeout_lethal_pod_retry";
  }
  return timeoutState.reason === "LETHAL_TIMEOUT_PENDING_SHIP_DESTRUCTION"
    ? "failed_timeout_lethal_pending"
    : "failed_timeout_lethal_destroy_retry";
}

function prepareAbyssalTimeout({
  getActivePocketStateByInstanceID,
  getAbyssalTimeoutState,
  ABYSSAL_TIMEOUT_MODE,
  getAbyssalTimeoutPolicy,
  hasFailedTimeoutOutcome,
  buildPlaceholderRoomState,
  updatePocketState,
  buildPocketStateForCurrentRoom,
  cloneValue,
  buildAbyssalLethalTimeoutPhase,
  quiesceAbyssalRunForTimeout,
}, context) {
  const { pocketState, effectiveNowMs, deps } = context;
  const instanceID = toInt(pocketState && pocketState.instanceID, 0);
  let activePocketState = getActivePocketStateByInstanceID(instanceID);
  if (!activePocketState) {
    const alreadyCleanState = getAbyssalTimeoutState(pocketState, deps);
    return {
      success: true,
      alreadyClean: true,
      data: {
        ...alreadyCleanState,
        mode: ABYSSAL_TIMEOUT_MODE.LETHAL,
        lethalTimeoutEnabled: true,
        cleanupTriggered: true,
      },
    };
  }
  const policy = getAbyssalTimeoutPolicy(deps);
  const firstTimeoutTransition = !hasFailedTimeoutOutcome(activePocketState);
  const previousTimeoutState = getAbyssalTimeoutState(activePocketState, deps);
  let timeoutState = {
    ...previousTimeoutState,
    mode: policy.mode,
    lethalTimeoutEnabled: true,
    reason: normalizeText(
      previousTimeoutState.reason,
      "LETHAL_TIMEOUT_PENDING_SHIP_DESTRUCTION",
    ),
    expiredAtMs: toInt(previousTimeoutState.expiredAtMs, 0) || effectiveNowMs,
  };
  if (
    firstTimeoutTransition ||
    previousTimeoutState.mode === ABYSSAL_TIMEOUT_MODE.SAFE_PLACEHOLDER
  ) {
    timeoutState = {
      ...timeoutState,
      mode: ABYSSAL_TIMEOUT_MODE.LETHAL,
      lethalTimeoutEnabled: true,
      cleanupTriggered: false,
      reason: previousTimeoutState.shipDestroyed
        ? "LETHAL_TIMEOUT_PENDING_POD_DESTRUCTION"
        : "LETHAL_TIMEOUT_PENDING_SHIP_DESTRUCTION",
      expiredAtMs: toInt(previousTimeoutState.expiredAtMs, 0) || effectiveNowMs,
    };
  }
  const nextRoomState = buildPlaceholderRoomState(activePocketState, {
    finalExitAvailable: false,
  });
  let updatedPocketState = updatePocketState(instanceID, {
    ...buildPocketStateForCurrentRoom(activePocketState, nextRoomState),
    timerState: {
      ...cloneValue(activePocketState.timerState),
      expired: true,
      expiryLoggedAtMs:
        toInt(
          activePocketState.timerState && activePocketState.timerState.expiryLoggedAtMs,
          0,
        ) || effectiveNowMs,
    },
    allowDebugExit: false,
    timerFailureState: buildAbyssalLethalTimeoutPhase(timeoutState),
    failedAtMs: toInt(activePocketState.failedAtMs, effectiveNowMs),
    failureReason: "timer_expired",
    timeoutState,
  });
  if (!updatedPocketState) {
    return {
      success: false,
      errorMsg: "TIMEOUT_STATE_UPDATE_FAILED",
    };
  }
  updatedPocketState = quiesceAbyssalRunForTimeout(updatedPocketState, deps);
  Object.assign(context, { instanceID, policy, firstTimeoutTransition, updatedPocketState });
  return null;
}

function suppressTimedOutAbyssalRewards({
  buildPlaceholderRoomState,
  suppressAbyssalRoomRewards,
  ensureAbyssalPocketPersistenceReady,
  schedulePlaceholderPocketMaintenance,
  getAbyssalTimeoutState,
}, context) {
  const { deps } = context;
  let { updatedPocketState } = context;
  // Revoke rewards in every room and verify persistence before destruction.
  const timeoutRoomState = buildPlaceholderRoomState(updatedPocketState);
  for (
    let timeoutRoomIndex = 1;
    timeoutRoomIndex <= timeoutRoomState.implementedRooms;
    timeoutRoomIndex += 1
  ) {
    updatedPocketState = suppressAbyssalRoomRewards(
      updatedPocketState,
      timeoutRoomIndex,
      deps,
      "RUN_FAILED_TIMEOUT",
    ) || updatedPocketState;
  }
  const timeoutRewardSuppressionPersistence = ensureAbyssalPocketPersistenceReady(
    updatedPocketState,
    deps,
  );
  if (
    !timeoutRewardSuppressionPersistence ||
    timeoutRewardSuppressionPersistence.success !== true
  ) {
    schedulePlaceholderPocketMaintenance(deps);
    return {
      success: false,
      pending: true,
      errorMsg: "ABYSSAL_TIMEOUT_REWARD_SUPPRESSION_PERSIST_FAILED",
      data: getAbyssalTimeoutState(updatedPocketState, deps),
    };
  }
  context.updatedPocketState = updatedPocketState;
  return null;
}

function recordAbyssalTimeoutOutcome({
  buildRoomLogContext,
  recordAuditEvent,
  recordAbyssalRunOutcome,
  getActivePocketStateByInstanceID,
  log,
}, context) {
  const { instanceID, deps, policy, firstTimeoutTransition } = context;
  let { updatedPocketState } = context;
  const roomLogContext = buildRoomLogContext(updatedPocketState, deps);
  if (firstTimeoutTransition) {
    recordAuditEvent("abyssal_placeholder_timer_expired", [], null, {
      instanceID,
      traceItemID: updatedPocketState.traceItemID,
      mode: policy.mode,
    });
    recordAbyssalRunOutcome(updatedPocketState, "failed_timeout", deps, {
      reason: "timer_expired_lethal",
      timeoutMode: policy.mode,
    });
    updatedPocketState = getActivePocketStateByInstanceID(instanceID) || updatedPocketState;
    log.info(
      `[AbyssalMgr] Rewards suppressed after timeout char=${roomLogContext.characterID} ` +
        `ship=${roomLogContext.shipID} filament=${roomLogContext.filamentTypeID} ` +
        `name="${roomLogContext.filamentName}" tier=${roomLogContext.tier} weather=${roomLogContext.weather} ` +
        `room=${roomLogContext.roomIndex}/${roomLogContext.totalRooms} roomOrigin=${roomLogContext.roomOrigin} ` +
        `finalShip=${roomLogContext.finalShip} hostileCount=${roomLogContext.hostileCount} ` +
        `cacheID=${roomLogContext.cacheID} conduitID=${roomLogContext.conduitID} ` +
        `timerRemainingMs=0 reason=RUN_FAILED_TIMEOUT`,
    );
    log.info(
      `[AbyssalMgr] Abyssal timer expired char=${updatedPocketState.characterID} ` +
        `instance=${updatedPocketState.instanceID} trace=${updatedPocketState.traceItemID} ` +
        `mode=${policy.mode}`,
    );
  }
  context.updatedPocketState = updatedPocketState;
}

function handleAbyssalTimeout({
  getDependencies,
  prepareAbyssalTimeout,
  suppressTimedOutAbyssalRewards,
  recordAbyssalTimeoutOutcome,
  completeDurableAbyssalTimeoutParticipants,
  getActivePocketStateByInstanceID,
},
  pocketState,
  effectiveNowMs,
  deps = getDependencies(),
  explicitSession = null,
  terminalOptions = {},
) {
  const context = { pocketState, effectiveNowMs, deps, explicitSession, terminalOptions };
  const preparation = prepareAbyssalTimeout(context);
  if (preparation) return preparation;
  const suppression = suppressTimedOutAbyssalRewards(context);
  if (suppression) return suppression;
  recordAbyssalTimeoutOutcome(context);
  return completeDurableAbyssalTimeoutParticipants(
    getActivePocketStateByInstanceID(context.instanceID) || context.updatedPocketState,
    effectiveNowMs,
    deps,
    explicitSession,
    terminalOptions,
  );
}

function destroyAbyssalTimeoutParticipants({
  getActivePocketStateByInstanceID,
  getCharacterID,
  completeDurableAbyssalParticipantDestruction,
  ABYSSAL_PARTICIPANT_TERMINAL_CAUSE,
}, context) {
  const { instanceID, requiredParticipants, results, deps, effectiveNowMs, explicitSession, terminalOptions } = context;
  let { workingState } = context;
  for (const participant of requiredParticipants) {
    workingState = getActivePocketStateByInstanceID(instanceID) || workingState;
    const preferredSession = getCharacterID(explicitSession) === participant.characterID
      ? explicitSession
      : null;
    const result = completeDurableAbyssalParticipantDestruction(
      workingState,
      participant,
      preferredSession,
      deps,
      {
        terminalCause: ABYSSAL_PARTICIPANT_TERMINAL_CAUSE.RUN_TIMEOUT,
        nowMs: effectiveNowMs,
        intentSource: "lethal-timeout",
        sessionChangeReason: "abyssal-timeout",
        destructionReason: "abyssal-timeout-lethal",
        suppressWreck: true,
        emitNotifications: terminalOptions.emitNotifications !== false,
      },
    );
    results.push({ characterID: participant.characterID, result });
    if (result && result.pocketState) workingState = result.pocketState;
  }
  context.workingState = workingState;
}

function projectAbyssalTimeoutParticipants({
  getActivePocketStateByInstanceID,
  getAbyssalParticipantDestructionOperationsByCharacterID,
  ABYSSAL_PARTICIPANT_DESTRUCTION_OPERATION_STATUS,
  ABYSSAL_PARTICIPANT_DESTRUCTION_STATUS_RANK,
  getAbyssalTimeoutState,
  ABYSSAL_TIMEOUT_MODE,
  withRateLimitedAbyssalDestructionWarning,
  log,
}, context) {
  const { instanceID, requiredParticipants, results, deps, effectiveNowMs } = context;
  let { workingState } = context;
  workingState = getActivePocketStateByInstanceID(instanceID) || workingState;
  const operations = getAbyssalParticipantDestructionOperationsByCharacterID(
    workingState,
  );
  const allParticipantsTerminal = requiredParticipants.length > 0 &&
    requiredParticipants.every((participant) => {
      const operation = operations[String(participant.characterID)];
      return Boolean(
        operation &&
        operation.status ===
          ABYSSAL_PARTICIPANT_DESTRUCTION_OPERATION_STATUS.POD_DESTROYED,
      );
    });
  const allParticipantHullsTerminal = requiredParticipants.length > 0 &&
    requiredParticipants.every((participant) => {
      const operation = operations[String(participant.characterID)];
      return Boolean(
        operation &&
        toInt(
          ABYSSAL_PARTICIPANT_DESTRUCTION_STATUS_RANK[operation.status],
          0,
        ) >= ABYSSAL_PARTICIPANT_DESTRUCTION_STATUS_RANK[
          ABYSSAL_PARTICIPANT_DESTRUCTION_OPERATION_STATUS.HULL_DESTROYED
        ],
      );
    });
  const firstPendingResult = results.find((entry) =>
    !entry.result || entry.result.success !== true || entry.result.pending === true
  );
  const failedHullOperation = Object.values(operations).find((operation) =>
    operation.status ===
      ABYSSAL_PARTICIPANT_DESTRUCTION_OPERATION_STATUS.HULL_INTENT_COMMITTED &&
    normalizeText(operation.hullFailureReason, "")
  );
  const failedPodOperation = Object.values(operations).find((operation) =>
    operation.status ===
      ABYSSAL_PARTICIPANT_DESTRUCTION_OPERATION_STATUS.INTENT_COMMITTED &&
    normalizeText(operation.failureReason, "")
  );
  const aggregateFailureState = allParticipantsTerminal
    ? "failed_timeout_lethal_cleanup_retry"
    : failedHullOperation
      ? "failed_timeout_lethal_destroy_retry"
      : failedPodOperation
        ? "failed_timeout_lethal_pod_retry"
        : "failed_timeout_lethal_participant_retry";
  let aggregateTimeoutState = {
    ...getAbyssalTimeoutState(workingState, deps),
    mode: ABYSSAL_TIMEOUT_MODE.LETHAL,
    lethalTimeoutEnabled: true,
    shipDestroyed: allParticipantHullsTerminal,
    podDestroyed: allParticipantsTerminal,
    cleanupTriggered: false,
    reason: allParticipantsTerminal
      ? "LETHAL_TIMEOUT_PENDING_ALL_PARTICIPANT_CLEANUP"
      : normalizeText(
          firstPendingResult && firstPendingResult.result &&
            firstPendingResult.result.errorMsg,
          "LETHAL_TIMEOUT_PENDING_PARTICIPANT_DESTRUCTION",
        ),
  };
  if (!allParticipantsTerminal && firstPendingResult) {
    const rawPendingReason = normalizeText(
      firstPendingResult.result && firstPendingResult.result.errorMsg,
      "LETHAL_TIMEOUT_PENDING_PARTICIPANT_DESTRUCTION",
    );
    const pendingReason = rawPendingReason.startsWith("NO_EXACT_SESSION_FOR_ABYSSAL_PARTICIPANT")
      ? "NO_ACTIVE_SESSION_FOR_LETHAL_TIMEOUT"
      : rawPendingReason;
    const warning = withRateLimitedAbyssalDestructionWarning(
      aggregateTimeoutState,
      pendingReason,
      effectiveNowMs,
    );
    aggregateTimeoutState = warning.timeoutState;
    if (warning.shouldLog) {
      log.warn(
        `[AbyssalMgr] Lethal timeout ${allParticipantHullsTerminal ? "pod" : "ship"} ` +
          `destruction unavailable char=${firstPendingResult.characterID} ` +
          `instance=${instanceID} trace=${toInt(workingState.traceItemID, 0)} ` +
          `reason=${pendingReason}`,
      );
    }
  }
  Object.assign(context, { workingState, operations, allParticipantsTerminal, aggregateFailureState, aggregateTimeoutState });
}

function commitAbyssalTimeoutParticipants({
  commitPocketStateDurably,
  ABYSSAL_PARTICIPANT_DESTRUCTION_OPERATION_STATUS,
  schedulePlaceholderPocketMaintenance,
  cloneValue,
}, context) {
  const { instanceID, requiredParticipants, operations, results, deps, effectiveNowMs,
    aggregateFailureState, aggregateTimeoutState, allParticipantsTerminal } = context;
  let { workingState } = context;
  const aggregateCommit = commitPocketStateDurably(
    instanceID,
    {
      timerFailureState: aggregateFailureState,
      timeoutState: aggregateTimeoutState,
      participantTerminalState: {
        schemaVersion: 1,
        requiredCharacterIDs: requiredParticipants.map((participant) =>
          participant.characterID
        ),
        completedCharacterIDs: requiredParticipants
          .filter((participant) => {
            const operation = operations[String(participant.characterID)];
            return operation && operation.status ===
              ABYSSAL_PARTICIPANT_DESTRUCTION_OPERATION_STATUS.POD_DESTROYED;
          })
          .map((participant) => participant.characterID),
        allTerminal: allParticipantsTerminal,
        lastEvaluatedAtMs: effectiveNowMs,
      },
    },
    deps,
    { verifyReadBack: true, forceWrite: true },
  );
  if (!aggregateCommit || aggregateCommit.success !== true) {
    schedulePlaceholderPocketMaintenance(deps);
    return {
      success: true,
      pending: true,
      persistencePending: true,
      errorMsg: normalizeText(
        aggregateCommit && aggregateCommit.errorMsg,
        "ABYSSAL_PARTICIPANT_TERMINAL_AGGREGATE_PERSIST_FAILED",
      ),
      data: aggregateTimeoutState,
      participantResults: results,
    };
  }
  workingState = cloneValue(aggregateCommit.committedState || aggregateCommit.state);
  if (!allParticipantsTerminal) {
    schedulePlaceholderPocketMaintenance(deps);
    return {
      success: true,
      pending: true,
      data: aggregateTimeoutState,
      participantResults: results,
    };
  }
  context.workingState = workingState;
  return null;
}

function tearDownAbyssalTimeoutParticipants({
  resolveAbyssalRosterParticipantSession,
  getCharacterID,
  sendAbyssalTerminalClientTeardown,
  buildAbyssalParticipantTerminalProjection,
}, context) {
  const { requiredParticipants, workingState, deps, explicitSession, terminalOptions } = context;
  for (const participant of requiredParticipants) {
    const participantSession = resolveAbyssalRosterParticipantSession(
      workingState,
      participant,
      deps,
      getCharacterID(explicitSession) === participant.characterID
        ? explicitSession
        : null,
    );
    if (terminalOptions.emitNotifications !== false && participantSession) {
      sendAbyssalTerminalClientTeardown(
        buildAbyssalParticipantTerminalProjection(workingState, participant),
        participantSession,
        deps,
        "abyssal-timeout-lethal",
      );
    }
  }
}

function cleanupAbyssalTimeoutParticipants({
  getAbyssalParticipantDestructionOperation,
  log,
  getAbyssalParticipantDestructionOperationsByCharacterID,
  cleanupAbyssalRun,
  schedulePlaceholderPocketMaintenance,
}, context) {
  const { instanceID, workingState, deps, explicitSession, aggregateTimeoutState, results } = context;
  let cleanupResult = null;
  const cleanupOwnerOperation = getAbyssalParticipantDestructionOperation(
    workingState,
    toInt(workingState && workingState.characterID, 0),
  );
  log.info(
    `[AbyssalRoster] all-participant timeout cleanup ready ` +
      `run=${instanceID} ownerOperation=${normalizeText(
        cleanupOwnerOperation && cleanupOwnerOperation.status,
        "missing",
      )} operationCount=${Object.keys(
        getAbyssalParticipantDestructionOperationsByCharacterID(workingState),
      ).length}`,
  );
  try {
    cleanupResult = cleanupAbyssalRun(workingState, deps, {
      reason: "abyssal-timeout-lethal",
      session: explicitSession,
    });
  } catch (error) {
    cleanupResult = {
      success: false,
      errorMsg: normalizeText(error && error.message, "ABYSSAL_TIMEOUT_CLEANUP_FAILED"),
    };
  }
  if (!cleanupResult || cleanupResult.success !== true) {
    log.warn(
      `[AbyssalRoster] all-participant timeout cleanup deferred ` +
        `run=${instanceID} reason=${normalizeText(
          cleanupResult && cleanupResult.errorMsg,
          "ABYSSAL_TIMEOUT_CLEANUP_FAILED",
        )}`,
    );
    schedulePlaceholderPocketMaintenance(deps);
    return {
      success: true,
      pending: true,
      data: aggregateTimeoutState,
      cleanupResult,
      participantResults: results,
    };
  }
  return {
    success: true,
    data: {
      ...aggregateTimeoutState,
      cleanupTriggered: true,
      reason: "LETHAL_TIMEOUT_ALL_PARTICIPANTS_DESTROYED",
    },
    cleanupResult,
    participantResults: results,
  };
}

function completeDurableAbyssalTimeoutParticipants({
  getDependencies,
  getActivePocketStateByInstanceID,
  normalizeAbyssalParticipantRoster,
  ABYSSAL_PARTICIPANT_STATUS,
  destroyAbyssalTimeoutParticipants,
  projectAbyssalTimeoutParticipants,
  commitAbyssalTimeoutParticipants,
  tearDownAbyssalTimeoutParticipants,
  cleanupAbyssalTimeoutParticipants,
},
  pocketState,
  effectiveNowMs,
  deps = getDependencies(),
  explicitSession = null,
  terminalOptions = {},
) {
  const instanceID = toInt(pocketState && pocketState.instanceID, 0);
  let workingState = getActivePocketStateByInstanceID(instanceID) || pocketState;
  const requiredParticipants = normalizeAbyssalParticipantRoster(workingState)
    .filter((participant) => ![
      ABYSSAL_PARTICIPANT_STATUS.RESERVED,
      ABYSSAL_PARTICIPANT_STATUS.ADMISSION_FAILED,
      ABYSSAL_PARTICIPANT_STATUS.EXITED,
    ].includes(participant.status));
  const results = [];
  const context = { instanceID, workingState, requiredParticipants, results,
    effectiveNowMs, deps, explicitSession, terminalOptions };
  destroyAbyssalTimeoutParticipants(context);
  projectAbyssalTimeoutParticipants(context);
  const commitResult = commitAbyssalTimeoutParticipants(context);
  if (commitResult) return commitResult;
  tearDownAbyssalTimeoutParticipants(context);
  return cleanupAbyssalTimeoutParticipants(context);
}

// Capture supplied capabilities once, as the original closure did. Internal
// callbacks are bound once per instance; no runtime state lives in this wiring.
function createAbyssalTimeoutLifecycle({
  getDependencies,
  getActivePocketStateByInstanceID,
  getAbyssalTimeoutState,
  getAbyssalTimeoutPolicy,
  hasFailedTimeoutOutcome,
  buildPlaceholderRoomState,
  buildPocketStateForCurrentRoom,
  updatePocketState,
  cloneValue,
  cancelPendingAbyssalTransition,
  stopSuppressorPresentationsForPocketRun,
  cleanupSuppressorControllersForRun,
  clearSuppressorDebugForRun,
  pauseAbyssalObjectiveControllers,
  listAllPocketHostileEntityIDs,
  suppressAbyssalRoomRewards,
  ensureAbyssalPocketPersistenceReady,
  schedulePlaceholderPocketMaintenance,
  buildRoomLogContext,
  recordAuditEvent,
  recordAbyssalRunOutcome,
  normalizeAbyssalParticipantRoster,
  ABYSSAL_PARTICIPANT_STATUS,
  getCharacterID,
  completeDurableAbyssalParticipantDestruction,
  ABYSSAL_PARTICIPANT_TERMINAL_CAUSE,
  getAbyssalParticipantDestructionOperationsByCharacterID,
  ABYSSAL_PARTICIPANT_DESTRUCTION_OPERATION_STATUS,
  ABYSSAL_PARTICIPANT_DESTRUCTION_STATUS_RANK,
  withRateLimitedAbyssalDestructionWarning,
  commitPocketStateDurably,
  resolveAbyssalRosterParticipantSession,
  sendAbyssalTerminalClientTeardown,
  buildAbyssalParticipantTerminalProjection,
  getAbyssalParticipantDestructionOperation,
  cleanupAbyssalRun,
  resolveAbyssalTimeoutDecision,
  isAbyssalTimerAnchored,
  hasImmutableAbyssalRunOutcome,
  hasFailedParticipantShipDestroyedOutcome,
  completeAbyssalParticipantPodDestructionAndCleanup,
  resolveAbyssalTimeoutRuntimeSession,
  ABYSSAL_DEADLINE_ACTION,
  ABYSSAL_TIMEOUT_MODE,
  log,
}) {

  const ports = {
    getDependencies,
    getActivePocketStateByInstanceID,
    getAbyssalTimeoutState,
    getAbyssalTimeoutPolicy,
    hasFailedTimeoutOutcome,
    buildPlaceholderRoomState,
    buildPocketStateForCurrentRoom,
    updatePocketState,
    cloneValue,
    cancelPendingAbyssalTransition,
    stopSuppressorPresentationsForPocketRun,
    cleanupSuppressorControllersForRun,
    clearSuppressorDebugForRun,
    pauseAbyssalObjectiveControllers,
    listAllPocketHostileEntityIDs,
    suppressAbyssalRoomRewards,
    ensureAbyssalPocketPersistenceReady,
    schedulePlaceholderPocketMaintenance,
    buildRoomLogContext,
    recordAuditEvent,
    recordAbyssalRunOutcome,
    normalizeAbyssalParticipantRoster,
    ABYSSAL_PARTICIPANT_STATUS,
    getCharacterID,
    completeDurableAbyssalParticipantDestruction,
    ABYSSAL_PARTICIPANT_TERMINAL_CAUSE,
    getAbyssalParticipantDestructionOperationsByCharacterID,
    ABYSSAL_PARTICIPANT_DESTRUCTION_OPERATION_STATUS,
    ABYSSAL_PARTICIPANT_DESTRUCTION_STATUS_RANK,
    withRateLimitedAbyssalDestructionWarning,
    commitPocketStateDurably,
    resolveAbyssalRosterParticipantSession,
    sendAbyssalTerminalClientTeardown,
    buildAbyssalParticipantTerminalProjection,
    getAbyssalParticipantDestructionOperation,
    cleanupAbyssalRun,
    resolveAbyssalTimeoutDecision,
    isAbyssalTimerAnchored,
    hasImmutableAbyssalRunOutcome,
    hasFailedParticipantShipDestroyedOutcome,
    completeAbyssalParticipantPodDestructionAndCleanup,
    resolveAbyssalTimeoutRuntimeSession,
    ABYSSAL_DEADLINE_ACTION,
    ABYSSAL_TIMEOUT_MODE,
    log,
  };
  ports.resolveEffectiveAbyssalMaintenanceNowMs = resolveEffectiveAbyssalMaintenanceNowMs.bind(null, ports);
  ports.syncExpiredAbyssalPocketState = syncExpiredAbyssalPocketState.bind(null, ports);
  ports.quiesceAbyssalRunForTimeout = quiesceAbyssalRunForTimeout.bind(null, ports);
  ports.buildAbyssalLethalTimeoutPhase = buildAbyssalLethalTimeoutPhase.bind(null, ports);
  ports.prepareAbyssalTimeout = prepareAbyssalTimeout.bind(null, ports);
  ports.suppressTimedOutAbyssalRewards = suppressTimedOutAbyssalRewards.bind(null, ports);
  ports.recordAbyssalTimeoutOutcome = recordAbyssalTimeoutOutcome.bind(null, ports);
  ports.handleAbyssalTimeout = handleAbyssalTimeout.bind(null, ports);
  ports.destroyAbyssalTimeoutParticipants = destroyAbyssalTimeoutParticipants.bind(null, ports);
  ports.projectAbyssalTimeoutParticipants = projectAbyssalTimeoutParticipants.bind(null, ports);
  ports.commitAbyssalTimeoutParticipants = commitAbyssalTimeoutParticipants.bind(null, ports);
  ports.tearDownAbyssalTimeoutParticipants = tearDownAbyssalTimeoutParticipants.bind(null, ports);
  ports.cleanupAbyssalTimeoutParticipants = cleanupAbyssalTimeoutParticipants.bind(null, ports);
  ports.completeDurableAbyssalTimeoutParticipants = completeDurableAbyssalTimeoutParticipants.bind(null, ports);
  Object.freeze(ports);
  return {
    resolveEffectiveAbyssalMaintenanceNowMs: ports.resolveEffectiveAbyssalMaintenanceNowMs,
    syncExpiredAbyssalPocketState: ports.syncExpiredAbyssalPocketState,
    quiesceAbyssalRunForTimeout: ports.quiesceAbyssalRunForTimeout,
    buildAbyssalLethalTimeoutPhase: ports.buildAbyssalLethalTimeoutPhase,
    completeDurableAbyssalTimeoutParticipants: ports.completeDurableAbyssalTimeoutParticipants,
    handleAbyssalTimeout: ports.handleAbyssalTimeout,
  };
}

module.exports = { createAbyssalTimeoutLifecycle };
