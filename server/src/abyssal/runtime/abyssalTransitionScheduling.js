"use strict";

const { normalizeText } = require("../domain/abyssalValueUtils");

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

// Per-attempt context carries the captured callbacks and identity, not durable
// ownership. Pending transitions and timer handles retain their existing owners.
function prepareAbyssalTransitionScheduleFx({
  log,
  maybeSendAbyssalTransitionFx,
  recordAbyssalEnvironmentSequenceEvent,
  getActivePocketStateByInstanceID,
}, context) {
  const { pocketState, session, deps, options, numericInstanceID, phase, sourceRoomIndex, targetRoomIndex } = context;
  if (phase === "transfer") {
    log.info(
      `[AbyssalRoomTransfer] run=${numericInstanceID} fromRoom=${sourceRoomIndex} ` +
        `toRoom=${targetRoomIndex} state=prepared`,
    );
  }
  const transitionFxResult = maybeSendAbyssalTransitionFx(
    pocketState,
    session,
    phase,
    deps,
    options.transitionFxOptions || {},
  );
  const updatedPocketState =
    transitionFxResult && transitionFxResult.pocketState
      ? transitionFxResult.pocketState
      : pocketState;
  if (
    phase === "entry" &&
    transitionFxResult &&
    transitionFxResult.usesProfileDrivenTraceActivation === true &&
    (!transitionFxResult.runtimeResult || transitionFxResult.runtimeResult.success !== true)
  ) {
    return {
      failureResult: {
        success: false,
        deferred: false,
        pocketState: updatedPocketState,
        transitionFxResult,
        errorMsg: normalizeText(
          transitionFxResult.runtimeResult &&
            transitionFxResult.runtimeResult.errorMsg,
          "ABYSSAL_TRACE_ACTIVATION_PRESENTATION_FAILED",
        ),
      },
    };
  }
  if (phase === "transfer" && transitionFxResult && transitionFxResult.fxSent === true) {
    log.info(
      `[AbyssalRoomTransfer] run=${numericInstanceID} fromRoom=${sourceRoomIndex} ` +
        `toRoom=${targetRoomIndex} state=effect_sent`,
    );
  }
  if (phase === "transfer" && transitionFxResult && transitionFxResult.fxSent === true) {
    recordAbyssalEnvironmentSequenceEvent(
      updatedPocketState,
      session,
      targetRoomIndex,
      "transition_effect",
      deps,
      { effectGuid: transitionFxResult.effectGuid },
    );
  }
  let afterTransitionResult = null;
  if (typeof options.afterTransitionFxSent === "function") {
    afterTransitionResult =
      options.afterTransitionFxSent(updatedPocketState, transitionFxResult);
    if (afterTransitionResult && afterTransitionResult.success === false) {
      return {
        failureResult: {
          success: false,
          deferred: false,
          pocketState:
            getActivePocketStateByInstanceID(numericInstanceID) ||
            updatedPocketState,
          transitionFxResult,
          errorMsg: normalizeText(
            afterTransitionResult.errorMsg,
            "ABYSSAL_TRANSITION_QUIESCE_FAILED",
          ),
        },
      };
    }
  }
  context.transitionFxResult = transitionFxResult;
  context.updatedPocketState = updatedPocketState;
  context.afterTransitionResult = afterTransitionResult;
  return { success: true };
}

function prepareAbyssalTransitionScheduleIdentity({
  clearPendingAbyssalTransitionHandle,
  usesIsolatedAbyssalScene,
  buildAbyssalSceneDescriptor,
  resolveSelectedAbyssalBaseRoomLayoutID,
}, context) {
  const { transitionFxResult, numericInstanceID, updatedPocketState, targetRoomIndex, phase, deps } = context;
  const durationMs = transitionFxResult && (
    transitionFxResult.fxSent === true || transitionFxResult.authoritative === true
  )
    ? toInt(transitionFxResult.durationMs, 0)
    : 0;
  clearPendingAbyssalTransitionHandle(numericInstanceID, deps);
  const scheduledAtMs = toInt(deps.now(), 0);
  const executeAtMs = scheduledAtMs + durationMs;
  const token = scheduledAtMs > 0 ? scheduledAtMs : Date.now();
  const destinationSceneDescriptor = usesIsolatedAbyssalScene(updatedPocketState, deps)
    ? buildAbyssalSceneDescriptor(updatedPocketState, deps)
    : null;
  const destinationLayoutID = normalizeText(
    resolveSelectedAbyssalBaseRoomLayoutID(
      updatedPocketState || {},
      targetRoomIndex,
    ),
    normalizeText(
      updatedPocketState && updatedPocketState.selectedRoomLayoutIDs &&
        (updatedPocketState.selectedRoomLayoutIDs[String(targetRoomIndex)] ||
          updatedPocketState.selectedRoomLayoutIDs[targetRoomIndex]),
      "",
    ),
  );
  const currentPhase = phase === "transfer"
    ? (durationMs > 0 ? "departure-window" : "departure-presentation-sent")
    : (durationMs > 0 ? "departure-presenting" : "ship-repositioned");
  const transitionRuntimeData =
    transitionFxResult &&
    transitionFxResult.runtimeResult &&
    transitionFxResult.runtimeResult.data &&
    typeof transitionFxResult.runtimeResult.data === "object"
      ? transitionFxResult.runtimeResult.data
      : {};
  Object.assign(context, { durationMs, scheduledAtMs, executeAtMs, token, destinationSceneDescriptor, destinationLayoutID, currentPhase, transitionRuntimeData });
}

function buildAbyssalPendingTransitionPlan({
  TRANSITION_POLICY_EXPERIMENTAL,
}, context) {
  const {
    phase,
    activationMode,
    token,
    durationMs,
    scheduledAtMs,
    executeAtMs,
    transitionFxResult,
    currentPhase,
    destinationSceneDescriptor,
    session,
    updatedPocketState,
    destinationLayoutID,
    sourceRoomIndex,
    targetRoomIndex,
    transitionRuntimeData,
    afterTransitionResult,
  } = context;
  return {
    status: "pending",
    phase,
    activationMode,
    token,
    durationMs,
    scheduledAtMs,
    executeAtMs,
    effectKey: normalizeText(transitionFxResult && transitionFxResult.effectKey, "none"),
    effectGuid: normalizeText(transitionFxResult && transitionFxResult.effectGuid, "none"),
    transitionType: normalizeText(transitionFxResult && transitionFxResult.transitionType, phase),
    transitionProfileID: normalizeText(transitionFxResult && transitionFxResult.transitionProfileID, ""),
    traceProfileID: normalizeText(
      transitionFxResult && transitionFxResult.traceProfileID,
      "",
    ),
    transitionPolicy: normalizeText(
      transitionFxResult && transitionFxResult.transitionPolicy,
      TRANSITION_POLICY_EXPERIMENTAL,
    ),
    authoritative: Boolean(transitionFxResult && transitionFxResult.authoritative),
    currentPhase,
    completedPhases: phase === "transfer"
      ? [
          "validated",
          ...(transitionFxResult && transitionFxResult.fxSent === true
            ? ["departure-presentation-sent"]
            : []),
          "source-quiesced",
          ...(durationMs > 0 ? ["departure-window"] : []),
        ]
      : [
          "validated",
          "departure-started",
          ...(durationMs > 0 ? ["departure-presenting"] : []),
        ],
    destinationSceneKey: normalizeText(
      destinationSceneDescriptor && destinationSceneDescriptor.sceneKey,
      normalizeText(session && session.spaceSceneKey, ""),
    ),
    sourceSceneID: normalizeText(
      session && (session.spaceSceneKey || (session._space && session._space.sceneKey)),
      "",
    ),
    destinationSceneID: normalizeText(
      destinationSceneDescriptor && destinationSceneDescriptor.sceneKey,
      phase === "exit"
        ? `solar-system:${toInt(updatedPocketState && updatedPocketState.sourceSolarSystemID, 0)}`
        : normalizeText(session && session.spaceSceneKey, ""),
    ),
    destinationLayoutID,
    sourceRoomIndex,
    targetRoomIndex,
    cancelledAtMs: 0,
    cancelReason: "",
    completedAtMs: 0,
    failureReason: "",
    lifecycleState: phase === "transfer"
      ? (transitionFxResult && transitionFxResult.fxSent === true ? "effect_sent" : "prepared")
      : "",
    completedLifecycleStates: phase === "transfer"
      ? [
          "prepared",
          ...(transitionFxResult && transitionFxResult.fxSent === true ? ["effect_sent"] : []),
        ]
      : [],
    committedRoomIndex: phase === "transfer" ? sourceRoomIndex : targetRoomIndex,
    destinationPrewarmedCount: 0,
    destinationVisibleCount: 0,
    sourceControllersPaused: phase === "transfer",
    destinationControllersActive: false,
    earlyVisibilityViolationCount: 0,
    sourceRemoveBallsCount: 0,
    destinationAddBallsCount: 0,
    departureEffectStamp: toInt(
      transitionRuntimeData.departureEffectStamp,
      toInt(
        transitionFxResult &&
          transitionFxResult.runtimeResult &&
          transitionFxResult.runtimeResult.stamp,
        toInt(transitionRuntimeData.stamp, 0),
      ),
    ),
    initialPublicationStamp: toInt(
      transitionRuntimeData.initialPublicationStamp,
      toInt(transitionRuntimeData.publicationStamp, 0),
    ),
    activationStamp: toInt(transitionRuntimeData.activationStamp, 0),
    controllerEventStamp: toInt(
      transitionRuntimeData.controllerEventStamp,
      0,
    ),
    slimUpdateSent: transitionRuntimeData.slimUpdateSent === true,
    controllerEventSent: transitionRuntimeData.controllerEventSent === true,
    departureEffectSent:
      transitionRuntimeData.departureEffectSent === true ||
      Boolean(transitionFxResult && transitionFxResult.fxSent === true),
    sessionChangeStartedAtMs: 0,
    notificationSent: toInt(afterTransitionResult && afterTransitionResult.notificationStamp, 0) > 0,
    notificationStamp: toInt(afterTransitionResult && afterTransitionResult.notificationStamp, 0),
    sourceRemovalStamp: 0,
    destinationDeliveryStamp: 0,
  };
}

function persistAbyssalPendingTransitionPlan({
  updatePocketState,
  setAbyssalRoomEntityDeliveryState,
  ABYSSAL_ROOM_DELIVERY_STATE,
  getPendingAbyssalTransitionState,
  cloneValue,
}, context) {
  const { numericInstanceID, pendingState, updatedPocketState, phase, targetRoomIndex, session, deps, token } = context;
  let pendingPocketState = updatePocketState(numericInstanceID, {
    pendingTransitionState: pendingState,
  }) || updatedPocketState;
  if (phase === "transfer") {
    const deliveryStateResult = setAbyssalRoomEntityDeliveryState(
      pendingPocketState,
      targetRoomIndex,
      ABYSSAL_ROOM_DELIVERY_STATE.TRANSITION_PENDING,
      session,
      deps,
      { transitionToken: token },
    );
    const latestPendingState = getPendingAbyssalTransitionState(deliveryStateResult.pocketState) || pendingState;
    pendingPocketState = updatePocketState(numericInstanceID, {
      pendingTransitionState: {
        ...cloneValue(latestPendingState),
        destinationPrewarmedCount: deliveryStateResult.count,
        destinationVisibleCount: deliveryStateResult.earlyVisibleEntityIDs.length,
        earlyVisibilityViolationCount: deliveryStateResult.earlyVisibilityViolationCount,
      },
    }) || deliveryStateResult.pocketState;
  }
  context.pendingPocketState = pendingPocketState;
}

function normalizeAbyssalHandoffFailureReason({}, result, fallback) {
  return normalizeText(
    result && result.errorMsg,
    normalizeText(
      result && result.error && result.error.details && result.error.details.reason,
      normalizeText(result && result.error && result.error.code, fallback),
    ),
  );
}

function settleFailedAbyssalScheduledHandoff({
  cloneValue,
  log,
  getActivePocketStateByInstanceID,
  restoreAbyssalSourceRoomAfterTransitionFailure,
  updatePocketState,
}, context, candidatePocketState, errorMsg, details = {}) {
  const {
    phase,
    activationMode,
    sourceRoomIndex,
    targetRoomIndex,
    token,
    numericInstanceID,
    onTransitionFailure,
    session,
    deps,
  } = context;
  const normalizedErrorMsg = normalizeText(errorMsg, "ABYSSAL_TRANSITION_HANDOFF_FAILED");
  if (onTransitionFailure) {
    try {
      onTransitionFailure(candidatePocketState, {
        phase,
        activationMode,
        sourceRoomIndex,
        targetRoomIndex,
        token,
        errorMsg: normalizedErrorMsg,
        ...cloneValue(details),
      });
    } catch (error) {
      log.error(
        `[AbyssalTransition] failure hook failed instance=${numericInstanceID} ` +
          `phase=${phase} reason=${normalizeText(error && error.message, "UNKNOWN")}`,
      );
    }
  }
  const latestPocketState =
    getActivePocketStateByInstanceID(numericInstanceID) || candidatePocketState;
  if (["transfer", "exit"].includes(phase)) {
    return restoreAbyssalSourceRoomAfterTransitionFailure(
      latestPocketState,
      session,
      deps,
      {
        phase,
        sourceRoomIndex,
        targetRoomIndex,
        failureReason: normalizedErrorMsg,
      },
    );
  }
  if (!getActivePocketStateByInstanceID(numericInstanceID)) {
    return null;
  }
  return updatePocketState(numericInstanceID, {
    pendingTransitionState: {
      ...cloneValue(latestPocketState && latestPocketState.pendingTransitionState),
      status: "failed",
      completedAtMs: toInt(deps.now(), 0),
      failureReason: normalizedErrorMsg,
      currentPhase: "failed",
    },
  }) || latestPocketState;
}

function executeAbyssalTransitionAtScheduledHandoff({
  evaluateAbyssalDirectCallbackTerminalGuard,
  clearPendingAbyssalTransitionHandle,
  normalizeAbyssalHandoffFailureReason,
  settleFailedAbyssalScheduledHandoff,
  cloneValue,
  getActivePocketStateByInstanceID,
  getPendingAbyssalTransitionState,
  settleFailedAbyssalDestinationActivation,
}, context, candidatePocketState) {
  const {
    phase,
    activationMode,
    sourceRoomIndex,
    targetRoomIndex,
    token,
    numericInstanceID,
    revalidateTransition,
    executeTransition,
    session,
    deps,
  } = context;
  const terminalGuard = evaluateAbyssalDirectCallbackTerminalGuard(
    candidatePocketState,
    `transition-handoff:${phase || "unknown"}`,
  );
  if (terminalGuard.blocked) {
    clearPendingAbyssalTransitionHandle(numericInstanceID, deps);
    return {
      success: false,
      suppressed: true,
      terminallySettled: true,
      errorMsg: "ABYSSAL_RUN_TERMINALLY_SETTLED",
      pocketState: terminalGuard.pocketState,
    };
  }
  let revalidationResult = { success: true };
  if (revalidateTransition) {
    try {
      revalidationResult = revalidateTransition(candidatePocketState, {
        phase,
        activationMode,
        sourceRoomIndex,
        targetRoomIndex,
        token,
      });
    } catch (error) {
      revalidationResult = {
        success: false,
        errorMsg: normalizeText(
          error && error.message,
          "ABYSSAL_TRANSITION_REVALIDATION_FAILED",
        ),
      };
    }
  }
  if (!revalidationResult || revalidationResult.success !== true) {
    const errorMsg = normalizeAbyssalHandoffFailureReason(
      revalidationResult,
      "ABYSSAL_TRANSITION_REVALIDATION_FAILED",
    );
    settleFailedAbyssalScheduledHandoff(context, candidatePocketState, errorMsg, {
      failureStage: "revalidation",
      revalidationResult: cloneValue(revalidationResult),
    });
    return {
      success: false,
      errorMsg,
      revalidationFailed: true,
      revalidationResult,
    };
  }

  let executeResult;
  try {
    executeResult = executeTransition(candidatePocketState, revalidationResult);
  } catch (error) {
    const thrownErrorMsg = normalizeText(
      error && error.message,
      "TRANSITION_EXECUTE_FAILED",
    );
    const latestPocketState =
      getActivePocketStateByInstanceID(numericInstanceID) || candidatePocketState;
    const latestPendingTransition = getPendingAbyssalTransitionState(latestPocketState);
    executeResult = latestPendingTransition && latestPendingTransition.sourceCommitIrreversible === true
      ? settleFailedAbyssalDestinationActivation(
          latestPocketState,
          session,
          deps,
          thrownErrorMsg,
          {
            sourceRoomIndex,
            destinationRoomIndex: targetRoomIndex,
            failureStage: "execution-exception-after-destination-notification",
          },
        )
      : {
          success: false,
          errorMsg: thrownErrorMsg,
        };
  }
  if (
    (!executeResult || executeResult.success !== true) &&
    !(executeResult && executeResult.terminallySettled === true) &&
    !(executeResult && executeResult.sourceCommitIrreversible === true)
  ) {
    const errorMsg = normalizeAbyssalHandoffFailureReason(
      executeResult,
      "TRANSITION_EXECUTE_FAILED",
    );
    settleFailedAbyssalScheduledHandoff(context, candidatePocketState, errorMsg, {
      failureStage: "execution",
      executeResult: cloneValue(executeResult),
    });
  }
  return executeResult || {
    success: false,
    errorMsg: "TRANSITION_EXECUTE_FAILED",
  };
}

function completeAbyssalScheduledTransition({
  updatePocketState,
  cloneValue,
  ensureBoundaryControllerForPocketState,
}, context, latestPocketState, executeResult) {
  const { numericInstanceID, phase, deps } = context;
  if (!latestPocketState || !executeResult || !executeResult.success) return;
  const settledPocketState = updatePocketState(numericInstanceID, {
    pendingTransitionState: {
      ...cloneValue(latestPocketState.pendingTransitionState),
      status: "completed",
      completedAtMs: toInt(deps.now(), 0),
      failureReason: "",
      currentPhase: "complete",
      completedPhases: [...new Set([
        ...(latestPocketState.pendingTransitionState.completedPhases || []),
        "complete",
      ])],
    },
  });
  if (
    settledPocketState &&
    ["entry", "transfer"].includes(phase)
  ) {
    ensureBoundaryControllerForPocketState(
      settledPocketState,
      deps,
      toInt(deps.now(), 0),
    );
  }
}

function executeImmediateAbyssalScheduledTransition({
  updatePocketState,
  cloneValue,
  executeAbyssalTransitionAtScheduledHandoff,
  getActivePocketStateByInstanceID,
  completeAbyssalScheduledTransition,
}, context) {
  const { numericInstanceID, pendingState, currentPhase, phase, pendingPocketState, transitionFxResult } = context;
  const executingPocketState = updatePocketState(numericInstanceID, {
    pendingTransitionState: {
      ...cloneValue(pendingState),
      currentPhase: phase === "transfer" ? currentPhase : "ship-repositioned",
      completedPhases: phase === "transfer"
        ? [...pendingState.completedPhases]
        : [...pendingState.completedPhases, "ship-repositioned"],
    },
  }) || pendingPocketState;
  const executeResult = executeAbyssalTransitionAtScheduledHandoff(context, executingPocketState);
  const latestPocketState = getActivePocketStateByInstanceID(numericInstanceID);
  completeAbyssalScheduledTransition(context, latestPocketState, executeResult);
  return {
    success: true,
    deferred: false,
    pocketState: pendingPocketState,
    transitionFxResult,
    executeResult,
  };
}

function executeDelayedAbyssalScheduledTransition({
  abyssalPendingWorkRegistry,
  getActivePocketStateByInstanceID,
  getPendingAbyssalTransitionState,
  syncExpiredAbyssalPocketState,
  evaluateAbyssalDirectCallbackTerminalGuard,
  updatePocketState,
  cloneValue,
  executeAbyssalTransitionAtScheduledHandoff,
  completeAbyssalScheduledTransition,
}, context, transitionHandleEntry) {
  const { numericInstanceID, token, phase, deps, session } = context;
  const pendingHandleEntry =
    abyssalPendingWorkRegistry.getTransitionHandle(numericInstanceID) || null;
  if (pendingHandleEntry !== transitionHandleEntry) return;
  abyssalPendingWorkRegistry.deleteTransitionHandle(numericInstanceID);
  let currentPocketState = getActivePocketStateByInstanceID(numericInstanceID);
  let currentPendingState = getPendingAbyssalTransitionState(currentPocketState);
  if (!currentPocketState || !currentPendingState || currentPendingState.status !== "pending" || currentPendingState.token !== token) {
    return;
  }
  // Gate validation happens before the authored departure presentation. A
  // transfer or final-exit callback can therefore run several seconds later,
  // after the hard Abyssal deadline but before the maintenance cadence gets
  // its next turn. Reconcile the authoritative clock again at the actual
  // handoff boundary so the transition animation cannot become a timer
  // extension. Entry is excluded because its run timer is not anchored until
  // the first ship has completed entry.
  if (phase !== "entry") {
    currentPocketState = syncExpiredAbyssalPocketState(
      currentPocketState,
      null,
      deps,
      session,
    );
    currentPendingState = getPendingAbyssalTransitionState(currentPocketState);
    const terminalGuard = evaluateAbyssalDirectCallbackTerminalGuard(
      currentPocketState,
      `transition-timer:${phase || "unknown"}`,
    );
    if (
      !currentPocketState ||
      terminalGuard.blocked ||
      !currentPendingState ||
      currentPendingState.status !== "pending" ||
      currentPendingState.token !== token
    ) {
      return;
    }
  }
  const executingPocketState = updatePocketState(numericInstanceID, {
    pendingTransitionState: {
      ...cloneValue(currentPocketState.pendingTransitionState),
      currentPhase: phase === "transfer"
        ? normalizeText(currentPocketState.pendingTransitionState.currentPhase, "departure-window")
        : "ship-repositioned",
      completedPhases: phase === "transfer"
        ? [...new Set(currentPocketState.pendingTransitionState.completedPhases || [])]
        : [...new Set([
            ...(currentPocketState.pendingTransitionState.completedPhases || []),
            "ship-repositioned",
          ])],
    },
  }) || currentPocketState;
  const executeResult = executeAbyssalTransitionAtScheduledHandoff(context, executingPocketState);
  const latestPocketState = getActivePocketStateByInstanceID(numericInstanceID);
  completeAbyssalScheduledTransition(context, latestPocketState, executeResult);
}

function scheduleAbyssalTransitionHandle({
  executeDelayedAbyssalScheduledTransition,
  abyssalPendingWorkRegistry,
  restoreAbyssalSourceRoomAfterTransitionFailure,
  log,
  TRANSITION_POLICY_EXPERIMENTAL,
}, context) {
  const {
    numericInstanceID,
    token,
    durationMs,
    deps,
    phase,
    sourceRoomIndex,
    targetRoomIndex,
    pendingPocketState,
    session,
    transitionFxResult,
    pocketState,
    activationMode,
  } = context;
  const transitionHandleEntry = { handle: null, token };
  try {
    transitionHandleEntry.handle = deps.scheduleTimeout(
      () => executeDelayedAbyssalScheduledTransition(context, transitionHandleEntry),
      durationMs,
    );
  } catch (error) {
    abyssalPendingWorkRegistry.deleteTransitionHandle(numericInstanceID);
    const errorMsg = normalizeText(
      error && error.message,
      "ABYSSAL_TRANSITION_SCHEDULING_FAILED",
    );
    const restoredPocketState = restoreAbyssalSourceRoomAfterTransitionFailure(
      pendingPocketState,
      session,
      deps,
      {
        phase,
        sourceRoomIndex,
        targetRoomIndex,
        failureReason: errorMsg,
      },
    );
    return {
      success: false,
      deferred: false,
      pocketState: restoredPocketState,
      transitionFxResult,
      errorMsg,
    };
  }
  if (transitionHandleEntry.handle === null || transitionHandleEntry.handle === undefined) {
    const errorMsg = "TRANSITION_TIMER_SCHEDULING_FAILED";
    const failedPocketState = restoreAbyssalSourceRoomAfterTransitionFailure(
      pendingPocketState,
      session,
      deps,
      {
        phase,
        sourceRoomIndex,
        targetRoomIndex,
        failureReason: errorMsg,
      },
    );
    return {
      success: false,
      deferred: false,
      pocketState: failedPocketState,
      transitionFxResult,
      errorMsg,
    };
  }
  abyssalPendingWorkRegistry.setTransitionHandle(numericInstanceID, transitionHandleEntry);
  log.info(
    `[AbyssalTransition] scheduled char=${toInt(pocketState && pocketState.characterID, 0)} ` +
      `instance=${numericInstanceID} phase=${phase} activation=${activationMode} ` +
      `transitionToken=${token} durationMs=${durationMs} ` +
      `policy=${normalizeText(transitionFxResult && transitionFxResult.transitionPolicy, TRANSITION_POLICY_EXPERIMENTAL)} ` +
      `profile=${normalizeText(transitionFxResult && transitionFxResult.transitionProfileID, "none")} ` +
      `effect=${normalizeText(transitionFxResult && transitionFxResult.effectGuid, "none")} ` +
      `participantCount=${toInt(transitionFxResult && transitionFxResult.participantCount, 0)} ` +
      `eligibleFxRecipientCount=${toInt(transitionFxResult && transitionFxResult.eligibleFxRecipientCount, 0)} ` +
      `emittedFxCount=${toInt(transitionFxResult && transitionFxResult.emittedFxCount, 0)} ` +
      `fxSent=${Boolean(transitionFxResult && transitionFxResult.fxSent)}`,
  );
  return {
    success: true,
    deferred: true,
    pocketState: pendingPocketState,
    transitionFxResult,
  };
}

function schedulePendingAbyssalTransition({
  evaluateAbyssalDirectCallbackTerminalGuard,
  getPendingAbyssalTransitionState,
  prepareAbyssalTransitionScheduleFx,
  prepareAbyssalTransitionScheduleIdentity,
  buildAbyssalPendingTransitionPlan,
  persistAbyssalPendingTransitionPlan,
  executeImmediateAbyssalScheduledTransition,
  scheduleAbyssalTransitionHandle,
},
  pocketState,
  session,
  deps,
  options = {},
) {
  const numericInstanceID = toInt(pocketState && pocketState.instanceID, 0);
  const phase = normalizeText(options.phase, "").toLowerCase();
  const executeTransition = typeof options.executeTransition === "function"
    ? options.executeTransition
    : null;
  const revalidateTransition = typeof options.revalidateTransition === "function"
    ? options.revalidateTransition
    : null;
  const onTransitionFailure = typeof options.onTransitionFailure === "function"
    ? options.onTransitionFailure
    : null;
  if (numericInstanceID <= 0 || !executeTransition) {
    return {
      success: false,
      errorMsg: "INVALID_PENDING_TRANSITION",
    };
  }

  const initialTerminalGuard = evaluateAbyssalDirectCallbackTerminalGuard(
    pocketState,
    `transition-schedule:${phase || "unknown"}`,
  );
  if (initialTerminalGuard.blocked) {
    return {
      success: false,
      suppressed: true,
      terminallySettled: true,
      errorMsg: "ABYSSAL_RUN_TERMINALLY_SETTLED",
      pocketState: initialTerminalGuard.pocketState,
    };
  }

  const sourceRoomIndex = toInt(options.sourceRoomIndex, 0);
  const targetRoomIndex = toInt(options.targetRoomIndex, 0);
  const activationMode = normalizeText(options.activationMode, phase);
  const existingPendingState = getPendingAbyssalTransitionState(pocketState);
  if (existingPendingState && existingPendingState.status === "pending") {
    return {
      success: true,
      deferred: true,
      duplicate: true,
      pocketState,
      transitionFxResult: null,
    };
  }
  const context = {
    pocketState, session, deps, options, numericInstanceID, phase, executeTransition,
    revalidateTransition, onTransitionFailure, sourceRoomIndex, targetRoomIndex, activationMode,
  };
  const fxResult = prepareAbyssalTransitionScheduleFx(context);
  if (fxResult.failureResult) return fxResult.failureResult;
  prepareAbyssalTransitionScheduleIdentity(context);
  context.pendingState = buildAbyssalPendingTransitionPlan(context);
  persistAbyssalPendingTransitionPlan(context);
  return !(context.durationMs > 0) || !(deps && typeof deps.scheduleTimeout === "function")
    ? executeImmediateAbyssalScheduledTransition(context)
    : scheduleAbyssalTransitionHandle(context);
}

// Capture supplied capabilities once, as the original closure did. Internal
// callbacks are bound once per instance; no runtime state lives in this wiring.
function createAbyssalTransitionScheduling({
  log,
  maybeSendAbyssalTransitionFx,
  recordAbyssalEnvironmentSequenceEvent,
  getActivePocketStateByInstanceID,
  clearPendingAbyssalTransitionHandle,
  usesIsolatedAbyssalScene,
  buildAbyssalSceneDescriptor,
  resolveSelectedAbyssalBaseRoomLayoutID,
  TRANSITION_POLICY_EXPERIMENTAL,
  updatePocketState,
  setAbyssalRoomEntityDeliveryState,
  ABYSSAL_ROOM_DELIVERY_STATE,
  getPendingAbyssalTransitionState,
  cloneValue,
  restoreAbyssalSourceRoomAfterTransitionFailure,
  evaluateAbyssalDirectCallbackTerminalGuard,
  settleFailedAbyssalDestinationActivation,
  ensureBoundaryControllerForPocketState,
  abyssalPendingWorkRegistry,
  syncExpiredAbyssalPocketState,
}) {

  const ports = {
    log,
    maybeSendAbyssalTransitionFx,
    recordAbyssalEnvironmentSequenceEvent,
    getActivePocketStateByInstanceID,
    clearPendingAbyssalTransitionHandle,
    usesIsolatedAbyssalScene,
    buildAbyssalSceneDescriptor,
    resolveSelectedAbyssalBaseRoomLayoutID,
    TRANSITION_POLICY_EXPERIMENTAL,
    updatePocketState,
    setAbyssalRoomEntityDeliveryState,
    ABYSSAL_ROOM_DELIVERY_STATE,
    getPendingAbyssalTransitionState,
    cloneValue,
    restoreAbyssalSourceRoomAfterTransitionFailure,
    evaluateAbyssalDirectCallbackTerminalGuard,
    settleFailedAbyssalDestinationActivation,
    ensureBoundaryControllerForPocketState,
    abyssalPendingWorkRegistry,
    syncExpiredAbyssalPocketState,
  };
  ports.prepareAbyssalTransitionScheduleFx = prepareAbyssalTransitionScheduleFx.bind(null, ports);
  ports.prepareAbyssalTransitionScheduleIdentity = prepareAbyssalTransitionScheduleIdentity.bind(null, ports);
  ports.buildAbyssalPendingTransitionPlan = buildAbyssalPendingTransitionPlan.bind(null, ports);
  ports.persistAbyssalPendingTransitionPlan = persistAbyssalPendingTransitionPlan.bind(null, ports);
  ports.normalizeAbyssalHandoffFailureReason = normalizeAbyssalHandoffFailureReason.bind(null, ports);
  ports.settleFailedAbyssalScheduledHandoff = settleFailedAbyssalScheduledHandoff.bind(null, ports);
  ports.executeAbyssalTransitionAtScheduledHandoff = executeAbyssalTransitionAtScheduledHandoff.bind(null, ports);
  ports.completeAbyssalScheduledTransition = completeAbyssalScheduledTransition.bind(null, ports);
  ports.executeImmediateAbyssalScheduledTransition = executeImmediateAbyssalScheduledTransition.bind(null, ports);
  ports.executeDelayedAbyssalScheduledTransition = executeDelayedAbyssalScheduledTransition.bind(null, ports);
  ports.scheduleAbyssalTransitionHandle = scheduleAbyssalTransitionHandle.bind(null, ports);
  ports.schedulePendingAbyssalTransition = schedulePendingAbyssalTransition.bind(null, ports);
  Object.freeze(ports);
  return { schedulePendingAbyssalTransition: ports.schedulePendingAbyssalTransition };
}

module.exports = { createAbyssalTransitionScheduling };
