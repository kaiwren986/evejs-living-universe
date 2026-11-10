"use strict";

const { normalizeText } = require("../domain/abyssalValueUtils");

// Stateless operations; persistence, runtime and scheduling remain owned by injected ports.
function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function markSourceTraceReturnedForPocket(ports,
  pocketState,
  returnSpaceState,
  deps = ports.getDependencies(),
) {
  const {
    cloneValue,
    getTrace,
    readTraceStateFromItem,
    resolveAbyssalTraceProfile,
    transitionSourceTraceState,
    ABYSSAL_TRACE_LIFECYCLE_PHASE,
    persistTraceState,
    isAbyssalSuspectReturnPending,
    isAbyssalReturnProtectionPending,
    scheduleSourceTraceRemoval,
    removeOwnedSourceTrace,
    getVectorDistance,
    getObjectPosition,
    log,
  } = ports;
  const traceItemID = toInt(pocketState && pocketState.sourceTraceItemID, toInt(pocketState && pocketState.traceItemID, 0));
  const traceState = cloneValue(getTrace(traceItemID)) ||
    readTraceStateFromItem(deps.findItemById(traceItemID));
  const profile = resolveAbyssalTraceProfile(traceState);
  if (!traceState) {
    return { success: true, skipped: true, errorMsg: "TRACE_ITEM_MISSING" };
  }
  const runID = toInt(pocketState && pocketState.instanceID, 0);
  if (
    toInt(traceState.characterID, 0) !== toInt(pocketState && pocketState.characterID, 0) ||
    (
      toInt(traceState.abyssalRunID, 0) > 0 &&
      toInt(traceState.abyssalRunID, 0) !== runID
    )
  ) {
    return { success: false, errorMsg: "TRACE_OWNERSHIP_MISMATCH" };
  }
  const transitionResult = profile
    ? transitionSourceTraceState(
        traceState,
        ABYSSAL_TRACE_LIFECYCLE_PHASE.RETURNED,
        deps,
        {
          abyssalRunID: runID,
          returnedAtMs: toInt(deps.now(), 0),
          broadcast: true,
        },
      )
    : persistTraceState({
        ...traceState,
        lifecyclePhase: ABYSSAL_TRACE_LIFECYCLE_PHASE.RETURNED,
        activationState: 2,
        isAbyssGateOpen: false,
        abyssalRunID: runID,
        returnedAtMs: toInt(deps.now(), 0),
      }, deps);
  const suspectReturnPending = isAbyssalSuspectReturnPending(
    transitionResult.state || traceState,
  );
  const returnProtectionPending = isAbyssalReturnProtectionPending(
    transitionResult.state || traceState,
    null,
    deps,
  );
  const scheduleResult = transitionResult.success && profile && !suspectReturnPending
    ? scheduleSourceTraceRemoval(transitionResult.state, deps, "post-return-expiry")
    : transitionResult.success && !profile && !suspectReturnPending && !returnProtectionPending
      ? removeOwnedSourceTrace(
          transitionResult.state || traceState,
          deps,
          "post-return-effects-settled",
        )
    : transitionResult.success
      ? {
          success: true,
          scheduled: false,
          skipped: true,
          state: transitionResult.state,
        }
      : { success: false, scheduled: false, errorMsg: transitionResult.errorMsg };
  const returnDistance = getVectorDistance(
    getObjectPosition(traceState.sourceTracePosition),
    getObjectPosition(returnSpaceState),
  );
  log.info(
    `[AbyssalTraceLifecycle] run=${runID} trace=${traceItemID} phase=returned ` +
      `state=${toInt(transitionResult && transitionResult.state && transitionResult.state.activationState, 2)} ` +
      `returnDistance=${returnDistance.toFixed(3)} ` +
      `removalScheduled=${scheduleResult.scheduled === true} ` +
      `removalDelayMs=${toInt(scheduleResult.delayMs, 0)} ` +
      `suspectReturnPending=${suspectReturnPending} ` +
      `returnProtectionPending=${returnProtectionPending} ` +
      `status=${transitionResult.success && scheduleResult.success ? "complete" : "failed"}`,
  );
  return {
    success: transitionResult.success && scheduleResult.success,
    transitionResult,
    scheduleResult,
    state: scheduleResult.state || transitionResult.state,
  };
}

function settleFailedAbyssalDestinationActivation(ports,
  pocketState,
  session,
  deps = ports.getDependencies(),
  reason = "ABYSSAL_DESTINATION_ACTIVATION_FAILED",
  details = {},
) {
  const {
    cloneValue,
    log,
    getActivePocketStateByInstanceID,
    buildPlaceholderRoomState,
    pauseSuppressorControllersForRoom,
    pauseAbyssalObjectiveControllers,
    listPocketHostileEntityIDs,
    suppressAbyssalRoomRewards,
    recordAbyssalRunOutcome,
    ensureAbyssalPocketPersistenceReady,
    sendAbyssalTerminalClientTeardown,
    evacuateAbyssalRunSession,
    cleanupAbyssalRun,
    schedulePlaceholderPocketMaintenance,
  } = ports;
  const runID = toInt(pocketState && pocketState.instanceID, 0);
  const activePocketState = getActivePocketStateByInstanceID(runID) || pocketState;
  const roomIndex = buildPlaceholderRoomState(activePocketState).currentRoomIndex;
  const normalizedReason = normalizeText(
    reason,
    "ABYSSAL_DESTINATION_ACTIVATION_FAILED",
  );
  pauseSuppressorControllersForRoom(runID, roomIndex, normalizedReason);
  pauseAbyssalObjectiveControllers(
    deps,
    listPocketHostileEntityIDs(activePocketState),
    "abyssal_destination_activation_failed",
  );
  let terminalPocketState = suppressAbyssalRoomRewards(
    activePocketState,
    roomIndex,
    deps,
    normalizedReason,
  );
  terminalPocketState = recordAbyssalRunOutcome(
    terminalPocketState,
    "failed_room_activation",
    deps,
    {
      reason: normalizedReason,
      rewardEligible: false,
      roomIndex,
      ...cloneValue(details),
    },
  ) || terminalPocketState;
  const persistenceResult = ensureAbyssalPocketPersistenceReady(
    terminalPocketState,
    deps,
  );
  sendAbyssalTerminalClientTeardown(
    terminalPocketState,
    session,
    deps,
    "destination-activation-failed",
  );
  const evacuationResult = evacuateAbyssalRunSession(
    session,
    terminalPocketState,
    normalizedReason,
    deps,
    {
      cleanupRun: false,
      tombstoneState: "pending",
      idempotencyKey:
        `abyssal-destination-activation-failure:${runID}:` +
        `${toInt(terminalPocketState && terminalPocketState.characterID, 0)}:` +
        `${toInt(terminalPocketState && terminalPocketState.shipID, 0)}`,
    },
  );
  let cleanupResult = null;
  if (evacuationResult && evacuationResult.evacuated === true) {
    cleanupResult = cleanupAbyssalRun(
      getActivePocketStateByInstanceID(runID) || terminalPocketState,
      deps,
      {
        reason: "destination-activation-failed",
        session,
      },
    );
    if (!cleanupResult || cleanupResult.success !== true) {
      schedulePlaceholderPocketMaintenance(deps);
    }
  }
  log.warn(
    `[AbyssalDestinationMechanics] run=${runID} room=${roomIndex} ` +
      `state=terminal-settlement reason=${normalizedReason} ` +
      `persisted=${Boolean(persistenceResult && persistenceResult.success === true)} ` +
      `evacuated=${Boolean(evacuationResult && evacuationResult.evacuated === true)} ` +
      `cleanup=${Boolean(cleanupResult && cleanupResult.success === true)}`,
  );
  return {
    success: false,
    errorMsg: normalizedReason,
    terminallySettled: Boolean(evacuationResult && evacuationResult.evacuated === true),
    sourceCommitIrreversible: true,
    persistenceResult,
    evacuationResult,
    cleanupResult,
  };
}

function createAbyssalTransitionSettlement(ports) {
  return {
    markSourceTraceReturnedForPocket: markSourceTraceReturnedForPocket.bind(null, ports),
    settleFailedAbyssalDestinationActivation: settleFailedAbyssalDestinationActivation.bind(null, ports),
  };
}

module.exports = { createAbyssalTransitionSettlement };
