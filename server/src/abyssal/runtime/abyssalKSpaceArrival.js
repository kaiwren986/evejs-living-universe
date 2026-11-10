"use strict";

const { normalizeText } = require("../domain/abyssalValueUtils");

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

// Exit arrival is session-owned presentation followed by durable finalization.
// Runtime, terminal authority and outcome/cleanup coordination are injected.
function buildAbyssalKSpaceArrivalReadiness({
  getDependencies,
  getActivePocketStateByInstanceID,
  getAbyssalParticipantRecord,
  getPendingAbyssalTransitionState,
  getCharacterID,
},
  pendingArrival,
  session,
  deps = getDependencies(),
) {
  const runtime = deps;
  const scene = runtime && typeof runtime.getSceneForSession === "function"
    ? runtime.getSceneForSession(session)
    : null;
  const sessionSpace = session && session._space && typeof session._space === "object"
    ? session._space
    : null;
  const expectedSceneKey = normalizeText(pendingArrival && pendingArrival.sceneKey, "");
  const actualSceneKey = normalizeText(
    sessionSpace && sessionSpace.sceneKey,
    normalizeText(session && session.spaceSceneKey, ""),
  );
  const sceneKey = normalizeText(scene && scene.sceneKey, actualSceneKey);
  const expectedShipID = toInt(pendingArrival && pendingArrival.shipID, 0);
  const ego = scene && typeof scene.getShipEntityForSession === "function"
    ? scene.getShipEntityForSession(session)
    : null;
  const activePocketState = getActivePocketStateByInstanceID(
    toInt(pendingArrival && pendingArrival.runID, 0),
  );
  const exitingParticipant = getAbyssalParticipantRecord(
    activePocketState,
    toInt(pendingArrival && pendingArrival.characterID, 0),
  );
  const activeTransition = getPendingAbyssalTransitionState(activePocketState);
  const beyonceBound = Boolean(sessionSpace && sessionSpace.beyonceBound === true);
  const setStateDelivered = Boolean(sessionSpace && sessionSpace.initialStateSent === true);
  const egoMatches = Boolean(ego && toInt(ego.itemID, 0) === expectedShipID);
  const recipientMember = Boolean(
    scene &&
      scene.sessions instanceof Map &&
      scene.sessions.get(session && session.clientID) === session
  );
  const hasCommittedPresentationOnlyReturn = Boolean(
    pendingArrival &&
      pendingArrival.finalizeRunOnCompletion === false &&
      pendingArrival.returnReceiptCommitted === true
  );
  const readiness = {
    activePocketState,
    activeTransition,
    scene,
    ego,
    actualSceneKey,
    sceneKey,
    beyonceBound,
    setStateDelivered,
    egoMatches,
    recipientMember,
    ready: false,
    reason: "READY",
  };

  if (!pendingArrival || session && session._abyssalKSpaceArrival !== pendingArrival) {
    readiness.reason = "ARRIVAL_CALLBACK_REPLACED";
  } else if (
    toInt(session && session._abyssalKSpaceArrivalSessionIdentity, 0) !==
    toInt(pendingArrival.sessionIdentity, 0)
  ) {
    readiness.reason = "SESSION_IDENTITY_CHANGED";
  } else if (toInt(session && session.clientID, 0) !== toInt(pendingArrival.clientID, 0)) {
    readiness.reason = "CLIENT_ID_CHANGED";
  } else if (getCharacterID(session) !== toInt(pendingArrival.characterID, 0)) {
    readiness.reason = "CHARACTER_ID_CHANGED";
  } else if (
    toInt(session && (session.shipID || session.shipid || session.activeShipID), 0) !==
      expectedShipID ||
    toInt(sessionSpace && sessionSpace.shipID, 0) !== expectedShipID
  ) {
    readiness.reason = "SHIP_ID_CHANGED";
  } else if (
    toInt(sessionSpace && sessionSpace.systemID, 0) !==
    toInt(pendingArrival.destinationSystemID, 0)
  ) {
    readiness.reason = "DESTINATION_SYSTEM_CHANGED";
  } else if (actualSceneKey !== expectedSceneKey) {
    readiness.reason = "DESTINATION_SCENE_CHANGED";
  } else if (!activePocketState && !hasCommittedPresentationOnlyReturn) {
    readiness.reason = "RUN_NOT_ACTIVE";
  } else if (
    activePocketState &&
    (!exitingParticipant || toInt(exitingParticipant.shipID, 0) !== expectedShipID)
  ) {
    readiness.reason = "RUN_PARTICIPANT_CHANGED";
  } else if (
    activePocketState &&
    (!activeTransition ||
      activeTransition.phase !== "exit" ||
      activeTransition.token !== toInt(pendingArrival.transitionToken, 0))
  ) {
    readiness.reason = "TRANSITION_TOKEN_STALE";
  } else if (
    activeTransition &&
    ["cancelled", "failed"].includes(activeTransition.status)
  ) {
    readiness.reason = "TRANSITION_CONFLICT";
  } else if (!scene) {
    readiness.reason = "DESTINATION_SCENE_UNAVAILABLE";
  } else if (!recipientMember) {
    readiness.reason = "SESSION_NOT_SCENE_RECIPIENT";
  } else if (!beyonceBound) {
    readiness.reason = "BEYONCE_NOT_BOUND";
  } else if (!setStateDelivered) {
    readiness.reason = "SETSTATE_NOT_DELIVERED";
  } else if (!egoMatches) {
    readiness.reason = "SETSTATE_EGO_MISMATCH";
  } else {
    readiness.ready = true;
  }
  return readiness;
}

function logAbyssalKSpaceArrival({
  log,
}, pendingArrival, readiness, status, reason) {
  log.info(
    `[AbyssalKSpaceArrival] run=${toInt(pendingArrival && pendingArrival.runID, 0)} ` +
      `token=${toInt(pendingArrival && pendingArrival.transitionToken, 0)} ` +
      `character=${toInt(pendingArrival && pendingArrival.characterID, 0)} ` +
      `ship=${toInt(pendingArrival && pendingArrival.shipID, 0)} ` +
      `destinationSystem=${toInt(pendingArrival && pendingArrival.destinationSystemID, 0)} ` +
      `sceneKey=${normalizeText(pendingArrival && pendingArrival.sceneKey, "none")} ` +
      `beyonceBound=${Boolean(readiness && readiness.beyonceBound)} ` +
      `setStateDelivered=${Boolean(readiness && readiness.setStateDelivered)} ` +
      `egoMatches=${Boolean(readiness && readiness.egoMatches)} ` +
      `effect=${normalizeText(pendingArrival && pendingArrival.effectName, "none")} ` +
      `arrivalSplashSent=${Boolean(pendingArrival && pendingArrival.arrivalSplashSent)} ` +
      `arrivalSplashStamp=${toInt(pendingArrival && pendingArrival.arrivalSplashStamp, 0)} ` +
      `arrivalSplashAttemptCount=${toInt(pendingArrival && pendingArrival.arrivalSplashAttemptCount, 0)} ` +
      `status=${normalizeText(status, "skipped")} ` +
      `reason=${normalizeText(reason, "none")}`,
  );
}

function clearPendingAbyssalKSpaceArrival({
  getDependencies,
}, session, deps = getDependencies(), options = {}) {
  const pendingArrival = options.expectedArrival || session && session._abyssalKSpaceArrival;
  if (!pendingArrival || typeof pendingArrival !== "object") {
    return null;
  }
  if (
    pendingArrival.cameraGraceHandle &&
    options.timerFired !== true &&
    deps &&
    typeof deps.clearScheduledTimeout === "function"
  ) {
    deps.clearScheduledTimeout(pendingArrival.cameraGraceHandle);
  }
  pendingArrival.cameraGraceHandle = null;
  if (
    pendingArrival.expiryHandle &&
    options.expiryTimerFired !== true &&
    deps &&
    typeof deps.clearScheduledTimeout === "function"
  ) {
    deps.clearScheduledTimeout(pendingArrival.expiryHandle);
  }
  pendingArrival.expiryHandle = null;
  const currentSessionOwnsArrival = Boolean(session && session._abyssalKSpaceArrival === pendingArrival);
  if (currentSessionOwnsArrival) {
    delete session._abyssalKSpaceArrival;
  }
  if (
    session && (
      currentSessionOwnsArrival ||
      toInt(session._abyssalKSpaceArrivalSessionIdentity, 0) ===
        toInt(pendingArrival.sessionIdentity, 0)
    )
  ) {
    delete session._abyssalKSpaceArrivalSessionIdentity;
  }
  return pendingArrival;
}

function finalizeAbyssalKSpaceArrival({
  getDependencies,
  getCharacterID,
  clearPendingAbyssalKSpaceArrival,
  getActivePocketStateByInstanceID,
  evaluateAbyssalDirectCallbackTerminalGuard,
  ABYSSAL_RUN_OUTCOME,
  buildAbyssalDirectCallbackSuppressedResult,
  sendAbyssalContentFinishedNotification,
  createComposedAbyssalFinalExitCoordinator,
  hasTerminalFailureOutcome,
  recordAbyssalRunOutcome,
  normalizeAbyssalRunOutcome,
  cleanupAbyssalRun,
  schedulePlaceholderPocketMaintenance,
  buildAbyssalFinalExitCoordinatorRequest,
},
  pendingArrival,
  session,
  deps = getDependencies(),
  options = {},
) {
  if (!pendingArrival || pendingArrival.finalized === true) {
    return { success: true, duplicate: true, reason: "ALREADY_FINALIZED" };
  }
  pendingArrival.finalized = true;
  const currentSessionOwnsArrival = Boolean(
    session && session._abyssalKSpaceArrival === pendingArrival
  );
  const sessionIdentityStillMatches = Boolean(
    currentSessionOwnsArrival &&
      toInt(session._abyssalKSpaceArrivalSessionIdentity, 0) ===
        toInt(pendingArrival.sessionIdentity, 0) &&
      toInt(session.clientID, 0) === toInt(pendingArrival.clientID, 0) &&
      getCharacterID(session) === toInt(pendingArrival.characterID, 0) &&
      toInt(session._space && session._space.shipID, 0) === toInt(pendingArrival.shipID, 0)
  );
  clearPendingAbyssalKSpaceArrival(session, deps, {
    expectedArrival: pendingArrival,
    timerFired: options.timerFired === true,
    expiryTimerFired: options.expiryTimerFired === true,
  });
  if (pendingArrival.finalizeRunOnCompletion === false) {
    return {
      success: true,
      finalized: true,
      presentationOnly: true,
      reason: "PARTICIPANT_PRESENTATION_COMPLETE",
    };
  }
  const pocketState = getActivePocketStateByInstanceID(toInt(pendingArrival.runID, 0));
  if (!pocketState) {
    return { success: true, alreadyClean: true, reason: "RUN_ALREADY_CLEAN" };
  }
  const terminalGuard = evaluateAbyssalDirectCallbackTerminalGuard(
    pocketState,
    "kspace-arrival-finalize",
    {
      allowedTerminalOutcomes: [ABYSSAL_RUN_OUTCOME.EXITED],
      allowPendingTerminalCleanup: true,
      allowDetachedGameplayAuthority: true,
    },
  );
  if (terminalGuard.blocked) {
    return buildAbyssalDirectCallbackSuppressedResult(terminalGuard, {
      handled: true,
      extra: {
        finalized: false,
        cleanupSkipped: true,
      },
    });
  }
  if (sessionIdentityStillMatches && options.notifyClient !== false) {
    sendAbyssalContentFinishedNotification(session, pocketState, deps);
  }
  const finalExitCoordinator = createComposedAbyssalFinalExitCoordinator({
    commitExitedOutcome() {
      const activePocketState =
        getActivePocketStateByInstanceID(toInt(pocketState.instanceID, 0)) || pocketState;
      if (hasTerminalFailureOutcome(activePocketState)) {
        return { success: true, skipped: true, pocketState: activePocketState };
      }
      try {
        const outcomeState = recordAbyssalRunOutcome(
          activePocketState,
          "exited",
          deps,
          { reason: "normal_exit" },
        ) || activePocketState;
        return {
          success:
            normalizeAbyssalRunOutcome(outcomeState && outcomeState.runOutcome) ===
              ABYSSAL_RUN_OUTCOME.EXITED,
          pocketState: outcomeState,
          errorMsg: "ABYSSAL_EXIT_OUTCOME_PERSIST_FAILED",
        };
      } catch (error) {
        return {
          success: false,
          errorMsg: normalizeText(
            error && error.message,
            "ABYSSAL_EXIT_OUTCOME_PERSIST_FAILED",
          ),
        };
      }
    },
    performFinalCleanup() {
      const activePocketState =
        getActivePocketStateByInstanceID(toInt(pocketState.instanceID, 0)) || pocketState;
      return cleanupAbyssalRun(activePocketState, deps, {
        reason: "final-exit",
        session: sessionIdentityStillMatches ? session : null,
      });
    },
    settleExitFailure() {
      schedulePlaceholderPocketMaintenance(deps);
      return {
        success: false,
        forwardConvergenceRequired: true,
      };
    },
  });
  const coordinatorResult = finalExitCoordinator.finalizeFinalExit(
    buildAbyssalFinalExitCoordinatorRequest(pocketState, {
      participantCharacterID: toInt(pendingArrival.characterID, 0),
      shipID: toInt(pendingArrival.shipID, 0),
    }),
  );
  const cleanupResult =
    coordinatorResult.stageResults &&
    coordinatorResult.stageResults.final_cleanup;
  return cleanupResult && cleanupResult.success === true
    ? { ...cleanupResult, finalExitCoordinatorResult: coordinatorResult }
    : coordinatorResult;
}

function scheduleAbyssalKSpaceArrivalAfterExit({
  getDependencies,
  evaluateAbyssalDirectCallbackTerminalGuard,
  ABYSSAL_RUN_OUTCOME,
  buildAbyssalTransitionFxProfile,
  getPendingAbyssalTransitionState,
  clearPendingAbyssalKSpaceArrival,
  abyssalPendingWorkRegistry,
  getCharacterID,
  cloneValue,
  ABYSSAL_KSPACE_ARRIVAL_READINESS_EXPIRY_MS,
  updateAbyssalTransitionFxState,
  buildAbyssalKSpaceArrivalReadiness,
  logAbyssalKSpaceArrival,
  finalizeAbyssalKSpaceArrival,
},
  pocketState,
  session,
  deps = getDependencies(),
  options = {},
) {
  const terminalGuard = evaluateAbyssalDirectCallbackTerminalGuard(
    pocketState,
    "kspace-arrival-schedule",
    {
      allowedTerminalOutcomes: [ABYSSAL_RUN_OUTCOME.EXITED],
      allowPendingTerminalCleanup: true,
      allowDetachedGameplayAuthority: true,
    },
  );
  if (terminalGuard.blocked) {
    return {
      success: false,
      scheduled: false,
      suppressed: true,
      terminal: true,
      errorMsg: "ABYSSAL_RUN_TERMINALLY_SETTLED",
      pocketState: terminalGuard.pocketState,
    };
  }
  const profile = buildAbyssalTransitionFxProfile(pocketState, deps);
  const transition = getPendingAbyssalTransitionState(pocketState);
  const destinationSystemID = toInt(session && session._space && session._space.systemID, 0);
  const sceneKey = normalizeText(
    session && session._space && session._space.sceneKey,
    normalizeText(session && session.spaceSceneKey, ""),
  );
  if (
    profile.enabled !== true ||
    profile.applicable !== true ||
    !profile.arrivalEffect ||
    !transition ||
    transition.phase !== "exit" ||
    transition.token <= 0 ||
    destinationSystemID <= 0 ||
    !sceneKey ||
    !deps ||
    typeof deps.scheduleTimeout !== "function"
  ) {
    return {
      success: false,
      scheduled: false,
      errorMsg: "KSPACE_ARRIVAL_SCHEDULING_UNAVAILABLE",
    };
  }
  clearPendingAbyssalKSpaceArrival(session, deps);
  const sessionIdentity = abyssalPendingWorkRegistry.allocateKSpaceArrivalSessionIdentity();
  const pendingArrival = {
    status: "awaiting-beyonce",
    runID: toInt(pocketState && pocketState.instanceID, 0),
    transitionToken: transition.token,
    sessionIdentity,
    clientID: toInt(session && session.clientID, 0),
    characterID: getCharacterID(session),
    shipID: toInt(session && session._space && session._space.shipID, 0),
    destinationSystemID,
    sceneKey,
    effectName: profile.arrivalGuid,
    effectOptions: cloneValue(profile.arrivalEffect.start),
    finalizeRunOnCompletion: options.finalizeRunOnCompletion !== false,
    returnReceiptCommitted: options.returnReceiptCommitted === true,
    scheduledAtMs: toInt(deps.now(), 0),
    cameraGraceHandle: null,
    expiryHandle: null,
    expiresAtMs: toInt(deps.now(), 0) + ABYSSAL_KSPACE_ARRIVAL_READINESS_EXPIRY_MS,
    arrivalSplashAttemptCount: 0,
    arrivalSplashSent: false,
    arrivalSplashStamp: 0,
    setStateDeliveredAtMs: 0,
    beyonceBoundAtMs: 0,
    egoMatchedAtMs: 0,
    finalized: false,
  };
  session._abyssalKSpaceArrivalSessionIdentity = sessionIdentity;
  session._abyssalKSpaceArrival = pendingArrival;
  updateAbyssalTransitionFxState(pocketState, {
    finalArrivalSendStatus: "SCHEDULED",
    finalArrivalSentAtMs: 0,
  });
  const readiness = buildAbyssalKSpaceArrivalReadiness(pendingArrival, session, deps);
  logAbyssalKSpaceArrival(
    pendingArrival,
    readiness,
    "scheduled",
    "AWAITING_BEYONCE_SETSTATE",
  );
  pendingArrival.expiryHandle = deps.scheduleTimeout(() => {
    pendingArrival.expiryHandle = null;
    if (
      !session ||
      session._abyssalKSpaceArrival !== pendingArrival ||
      pendingArrival.finalized === true
    ) {
      return;
    }
    const expiryReadiness = buildAbyssalKSpaceArrivalReadiness(
      pendingArrival,
      session,
      deps,
    );
    logAbyssalKSpaceArrival(
      pendingArrival,
      expiryReadiness,
      "expired",
      "READINESS_EXPIRY",
    );
    updateAbyssalTransitionFxState(expiryReadiness.activePocketState, {
      finalArrivalSendStatus: "EXPIRED",
      finalArrivalSentAtMs: 0,
      arrivalSplashAttemptCount: toInt(pendingArrival.arrivalSplashAttemptCount, 0),
    });
    finalizeAbyssalKSpaceArrival(pendingArrival, session, deps, {
      notifyClient: false,
      expiryTimerFired: true,
    });
  }, ABYSSAL_KSPACE_ARRIVAL_READINESS_EXPIRY_MS);
  return { success: true, scheduled: true, pendingArrival };
}

function completeAbyssalKSpaceArrivalCameraGrace({
  buildAbyssalKSpaceArrivalReadiness,
  logAbyssalKSpaceArrival,
  finalizeAbyssalKSpaceArrival,
  evaluateAbyssalDirectCallbackTerminalGuard,
  ABYSSAL_RUN_OUTCOME,
  clearPendingAbyssalKSpaceArrival,
  maybeSendAbyssalArrivalFx,
  cloneValue,
  updateAbyssalTransitionFxState,
}, pendingArrival, session, deps, reason) {
  pendingArrival.cameraGraceHandle = null;
  const callbackReadiness = buildAbyssalKSpaceArrivalReadiness(
    pendingArrival,
    session,
    deps,
  );
  if (!callbackReadiness.ready) {
    logAbyssalKSpaceArrival(
      pendingArrival,
      callbackReadiness,
      "skipped",
      callbackReadiness.reason,
    );
    finalizeAbyssalKSpaceArrival(pendingArrival, session, deps, {
      notifyClient: false,
      timerFired: true,
    });
    return;
  }

  const timerTerminalGuard = evaluateAbyssalDirectCallbackTerminalGuard(
    callbackReadiness.activePocketState,
    "kspace-arrival-camera-timer",
    {
      allowedTerminalOutcomes: [ABYSSAL_RUN_OUTCOME.EXITED],
      allowPendingTerminalCleanup: true,
      allowDetachedGameplayAuthority: true,
    },
  );
  const canSendFromCommittedReturnReceipt = Boolean(
    !callbackReadiness.activePocketState &&
      pendingArrival.finalizeRunOnCompletion === false &&
      pendingArrival.returnReceiptCommitted === true
  );
  if (timerTerminalGuard.blocked && !canSendFromCommittedReturnReceipt) {
    logAbyssalKSpaceArrival(
      pendingArrival,
      callbackReadiness,
      "skipped",
      "ABYSSAL_RUN_TERMINALLY_SETTLED",
    );
    clearPendingAbyssalKSpaceArrival(session, deps, { timerFired: true });
    return;
  }

  let result = null;
  pendingArrival.arrivalSplashAttemptCount += 1;
  try {
    result = callbackReadiness.activePocketState
      ? maybeSendAbyssalArrivalFx(
          callbackReadiness.activePocketState,
          session,
          deps,
          "final-exit-kspace-post-setstate",
        )
      : deps && typeof deps.playSpecialFx === "function"
        ? deps.playSpecialFx(
            session,
            pendingArrival.effectName,
            cloneValue(pendingArrival.effectOptions || {}),
          )
        : { success: false, errorMsg: "FX_RUNTIME_UNAVAILABLE" };
  } catch (error) {
    result = {
      success: false,
      errorMsg: normalizeText(error && error.message, "FX_SEND_FAILED"),
    };
  }
  pendingArrival.arrivalSplashSent = Boolean(result && result.success);
  pendingArrival.arrivalSplashStamp = result && result.success
    ? toInt(result.data && result.data.stamp, 0)
    : 0;
  updateAbyssalTransitionFxState(callbackReadiness.activePocketState, {
    finalArrivalSendStatus: result && result.success
      ? "SENT"
      : normalizeText(result && result.errorMsg, "SEND_FAILED"),
    finalArrivalSentAtMs: result && result.success ? toInt(deps.now(), 0) : 0,
    arrivalSplashSent: pendingArrival.arrivalSplashSent,
    arrivalSplashStamp: pendingArrival.arrivalSplashStamp,
    arrivalSplashAttemptCount: pendingArrival.arrivalSplashAttemptCount,
  });
  logAbyssalKSpaceArrival(
    pendingArrival,
    callbackReadiness,
    result && result.success ? "sent" : "failed",
    result && result.success
      ? normalizeText(reason, "beyonce-post-setstate")
      : normalizeText(result && result.errorMsg, "FX_SEND_FAILED"),
  );
  finalizeAbyssalKSpaceArrival(pendingArrival, session, deps, {
    timerFired: true,
  });
}

function completeAbyssalKSpaceArrivalForSession({
  getDependencies,
  getActivePocketStateByInstanceID,
  evaluateAbyssalDirectCallbackTerminalGuard,
  ABYSSAL_RUN_OUTCOME,
  clearPendingAbyssalKSpaceArrival,
  buildAbyssalDirectCallbackSuppressedResult,
  buildAbyssalKSpaceArrivalReadiness,
  logAbyssalKSpaceArrival,
  finalizeAbyssalKSpaceArrival,
  updateAbyssalTransitionFxState,
  completeAbyssalKSpaceArrivalCameraGrace,
  ABYSSAL_BEYONCE_POST_SETSTATE_ARRIVAL_FX_DELAY_MS,
},
  session,
  deps = getDependencies(),
  reason = "beyonce-post-setstate",
) {
  const pendingArrival = session && session._abyssalKSpaceArrival;
  if (!pendingArrival || typeof pendingArrival !== "object") {
    return null;
  }
  if (pendingArrival.finalized === true) {
    return { success: true, duplicate: true, reason: "ALREADY_FINALIZED" };
  }
  const callbackPocketState = getActivePocketStateByInstanceID(
    toInt(pendingArrival.runID, 0),
  );
  const canCompleteFromCommittedReturnReceipt = Boolean(
    !callbackPocketState &&
      pendingArrival.finalizeRunOnCompletion === false &&
      pendingArrival.returnReceiptCommitted === true
  );
  const terminalGuard = evaluateAbyssalDirectCallbackTerminalGuard(
    callbackPocketState,
    "kspace-arrival-ready",
    {
      allowedTerminalOutcomes: [ABYSSAL_RUN_OUTCOME.EXITED],
      allowPendingTerminalCleanup: true,
      allowDetachedGameplayAuthority: true,
    },
  );
  if (terminalGuard.blocked && !canCompleteFromCommittedReturnReceipt) {
    clearPendingAbyssalKSpaceArrival(session, deps);
    return buildAbyssalDirectCallbackSuppressedResult(terminalGuard, {
      handled: true,
      extra: {
        finalized: false,
        cleanupSkipped: true,
      },
    });
  }
  const readiness = buildAbyssalKSpaceArrivalReadiness(pendingArrival, session, deps);
  if (!readiness.ready) {
    const pendingReason = [
      "DESTINATION_SCENE_UNAVAILABLE",
      "SESSION_NOT_SCENE_RECIPIENT",
      "BEYONCE_NOT_BOUND",
      "SETSTATE_NOT_DELIVERED",
      "SETSTATE_EGO_MISMATCH",
    ].includes(readiness.reason);
    logAbyssalKSpaceArrival(
      pendingArrival,
      readiness,
      pendingReason ? "scheduled" : "skipped",
      readiness.reason,
    );
    if (!pendingReason) {
      finalizeAbyssalKSpaceArrival(pendingArrival, session, deps, {
        notifyClient: false,
      });
    }
    return {
      success: true,
      pending: pendingReason,
      skipped: !pendingReason,
      reason: readiness.reason,
    };
  }
  if (pendingArrival.cameraGraceHandle) {
    logAbyssalKSpaceArrival(
      pendingArrival,
      readiness,
      "skipped",
      "CAMERA_GRACE_ALREADY_SCHEDULED",
    );
    return {
      success: true,
      duplicate: true,
      scheduled: true,
      reason: "CAMERA_GRACE_ALREADY_SCHEDULED",
    };
  }

  pendingArrival.status = "camera-grace";
  pendingArrival.beyonceCompletedAtMs = toInt(deps.now(), 0);
  pendingArrival.beyonceBoundAtMs = pendingArrival.beyonceCompletedAtMs;
  pendingArrival.setStateDeliveredAtMs = pendingArrival.beyonceCompletedAtMs;
  pendingArrival.egoMatchedAtMs = pendingArrival.beyonceCompletedAtMs;
  updateAbyssalTransitionFxState(readiness.activePocketState, {
    beyonceBoundAtMs: pendingArrival.beyonceBoundAtMs,
    setStateDeliveredAtMs: pendingArrival.setStateDeliveredAtMs,
    egoMatchedAtMs: pendingArrival.egoMatchedAtMs,
  });
  const handle = deps.scheduleTimeout(
    () => completeAbyssalKSpaceArrivalCameraGrace(pendingArrival, session, deps, reason),
    ABYSSAL_BEYONCE_POST_SETSTATE_ARRIVAL_FX_DELAY_MS,
  );
  pendingArrival.cameraGraceHandle = handle;
  logAbyssalKSpaceArrival(
    pendingArrival,
    readiness,
    "scheduled",
    "POST_SETSTATE_CAMERA_GRACE",
  );
  return {
    success: true,
    scheduled: true,
    reason: "POST_SETSTATE_CAMERA_GRACE",
  };
}

// Capture supplied capabilities once, as the original closure did. Internal
// callbacks are bound once per instance; no runtime state lives in this wiring.
function createAbyssalKSpaceArrival({
  getDependencies,
  getActivePocketStateByInstanceID,
  getAbyssalParticipantRecord,
  getPendingAbyssalTransitionState,
  getCharacterID,
  log,
  evaluateAbyssalDirectCallbackTerminalGuard,
  ABYSSAL_RUN_OUTCOME,
  buildAbyssalDirectCallbackSuppressedResult,
  sendAbyssalContentFinishedNotification,
  createComposedAbyssalFinalExitCoordinator,
  hasTerminalFailureOutcome,
  recordAbyssalRunOutcome,
  normalizeAbyssalRunOutcome,
  cleanupAbyssalRun,
  schedulePlaceholderPocketMaintenance,
  buildAbyssalFinalExitCoordinatorRequest,
  buildAbyssalTransitionFxProfile,
  abyssalPendingWorkRegistry,
  cloneValue,
  ABYSSAL_KSPACE_ARRIVAL_READINESS_EXPIRY_MS,
  updateAbyssalTransitionFxState,
  maybeSendAbyssalArrivalFx,
  ABYSSAL_BEYONCE_POST_SETSTATE_ARRIVAL_FX_DELAY_MS,
}) {

  const ports = {
    getDependencies,
    getActivePocketStateByInstanceID,
    getAbyssalParticipantRecord,
    getPendingAbyssalTransitionState,
    getCharacterID,
    log,
    evaluateAbyssalDirectCallbackTerminalGuard,
    ABYSSAL_RUN_OUTCOME,
    buildAbyssalDirectCallbackSuppressedResult,
    sendAbyssalContentFinishedNotification,
    createComposedAbyssalFinalExitCoordinator,
    hasTerminalFailureOutcome,
    recordAbyssalRunOutcome,
    normalizeAbyssalRunOutcome,
    cleanupAbyssalRun,
    schedulePlaceholderPocketMaintenance,
    buildAbyssalFinalExitCoordinatorRequest,
    buildAbyssalTransitionFxProfile,
    abyssalPendingWorkRegistry,
    cloneValue,
    ABYSSAL_KSPACE_ARRIVAL_READINESS_EXPIRY_MS,
    updateAbyssalTransitionFxState,
    maybeSendAbyssalArrivalFx,
    ABYSSAL_BEYONCE_POST_SETSTATE_ARRIVAL_FX_DELAY_MS,
  };
  ports.buildAbyssalKSpaceArrivalReadiness = buildAbyssalKSpaceArrivalReadiness.bind(null, ports);
  ports.logAbyssalKSpaceArrival = logAbyssalKSpaceArrival.bind(null, ports);
  ports.clearPendingAbyssalKSpaceArrival = clearPendingAbyssalKSpaceArrival.bind(null, ports);
  ports.finalizeAbyssalKSpaceArrival = finalizeAbyssalKSpaceArrival.bind(null, ports);
  ports.scheduleAbyssalKSpaceArrivalAfterExit = scheduleAbyssalKSpaceArrivalAfterExit.bind(null, ports);
  ports.completeAbyssalKSpaceArrivalCameraGrace = completeAbyssalKSpaceArrivalCameraGrace.bind(null, ports);
  ports.completeAbyssalKSpaceArrivalForSession = completeAbyssalKSpaceArrivalForSession.bind(null, ports);
  Object.freeze(ports);
  return {
    buildAbyssalKSpaceArrivalReadiness: ports.buildAbyssalKSpaceArrivalReadiness,
    logAbyssalKSpaceArrival: ports.logAbyssalKSpaceArrival,
    clearPendingAbyssalKSpaceArrival: ports.clearPendingAbyssalKSpaceArrival,
    finalizeAbyssalKSpaceArrival: ports.finalizeAbyssalKSpaceArrival,
    scheduleAbyssalKSpaceArrivalAfterExit: ports.scheduleAbyssalKSpaceArrivalAfterExit,
    completeAbyssalKSpaceArrivalForSession: ports.completeAbyssalKSpaceArrivalForSession,
  };
}

module.exports = { createAbyssalKSpaceArrival };
