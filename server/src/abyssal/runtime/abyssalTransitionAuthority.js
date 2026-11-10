"use strict";

const { normalizeText } = require("../domain/abyssalValueUtils");

// Lifecycle mutation, rollback and combat handoff retain existing injected owners.
function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function getPendingAbyssalTransitionState(ports, pocketState = null) {
  const state =
    pocketState && pocketState.pendingTransitionState &&
    typeof pocketState.pendingTransitionState === "object"
      ? pocketState.pendingTransitionState
      : null;
  if (!state) {
    return null;
  }
  return {
    status: normalizeText(state.status, ""),
    phase: normalizeText(state.phase, ""),
    activationMode: normalizeText(state.activationMode, ""),
    token: toInt(state.token, 0),
    durationMs: toInt(state.durationMs, 0),
    scheduledAtMs: toInt(state.scheduledAtMs, 0),
    executeAtMs: toInt(state.executeAtMs, 0),
    effectKey: normalizeText(state.effectKey, ""),
    effectGuid: normalizeText(state.effectGuid, ""),
    sourceRoomIndex: toInt(state.sourceRoomIndex, 0),
    targetRoomIndex: toInt(state.targetRoomIndex, 0),
    cancelledAtMs: toInt(state.cancelledAtMs, 0),
    cancelReason: normalizeText(state.cancelReason, ""),
    completedAtMs: toInt(state.completedAtMs, 0),
    failureReason: normalizeText(state.failureReason, ""),
    transitionType: normalizeText(state.transitionType, ""),
    transitionProfileID: normalizeText(state.transitionProfileID, ""),
    transitionPolicy: normalizeText(state.transitionPolicy, ""),
    authoritative: state.authoritative === true,
    currentPhase: normalizeText(state.currentPhase, ""),
    completedPhases: Array.isArray(state.completedPhases)
      ? state.completedPhases.map((entry) => normalizeText(entry, "")).filter(Boolean)
      : [],
    destinationSceneKey: normalizeText(state.destinationSceneKey, ""),
    destinationLayoutID: normalizeText(state.destinationLayoutID, ""),
    lifecycleState: normalizeText(state.lifecycleState, ""),
    completedLifecycleStates: Array.isArray(state.completedLifecycleStates)
      ? state.completedLifecycleStates.map((entry) => normalizeText(entry, "")).filter(Boolean)
      : [],
    committedRoomIndex: toInt(state.committedRoomIndex, 0),
    destinationPrewarmedCount: Math.max(0, toInt(state.destinationPrewarmedCount, 0)),
    destinationVisibleCount: Math.max(0, toInt(state.destinationVisibleCount, 0)),
    sourceControllersPaused: state.sourceControllersPaused === true,
    destinationControllersActive: state.destinationControllersActive === true,
    sourceCommitIrreversible: state.sourceCommitIrreversible === true,
    earlyVisibilityViolationCount: Math.max(0, toInt(state.earlyVisibilityViolationCount, 0)),
    sourceRemoveBallsCount: Math.max(0, toInt(state.sourceRemoveBallsCount, 0)),
    destinationAddBallsCount: Math.max(0, toInt(state.destinationAddBallsCount, 0)),
    departureEffectStamp: toInt(state.departureEffectStamp, 0),
    notificationStamp: toInt(state.notificationStamp, 0),
    sourceRemovalStamp: toInt(state.sourceRemovalStamp, 0),
    destinationDeliveryStamp: toInt(state.destinationDeliveryStamp, 0),
  };
}

function advanceAbyssalRoomTransferLifecycle(ports,
  pocketState,
  session,
  deps,
  lifecycleState,
  details = {},
) {
  const {
    ABYSSAL_ROOM_TRANSFER_LIFECYCLE_STATES,
    getActivePocketStateByInstanceID,
    cloneValue,
    updatePocketState,
    log,
  } = ports;
  const instanceID = toInt(pocketState && pocketState.instanceID, 0);
  const normalizedState = normalizeText(lifecycleState, "");
  const nextStateIndex = ABYSSAL_ROOM_TRANSFER_LIFECYCLE_STATES.indexOf(normalizedState);
  if (instanceID <= 0 || nextStateIndex < 0) {
    return pocketState;
  }
  const latestPocketState = getActivePocketStateByInstanceID(instanceID) || pocketState;
  const rawPendingState =
    latestPocketState && latestPocketState.pendingTransitionState &&
    typeof latestPocketState.pendingTransitionState === "object"
      ? latestPocketState.pendingTransitionState
      : {};
  const completedLifecycleStates = Array.isArray(rawPendingState.completedLifecycleStates)
    ? rawPendingState.completedLifecycleStates.map((entry) => normalizeText(entry, "")).filter(Boolean)
    : [];
  if (completedLifecycleStates.includes(normalizedState)) {
    return latestPocketState;
  }
  const currentStateIndex = ABYSSAL_ROOM_TRANSFER_LIFECYCLE_STATES.indexOf(
    normalizeText(rawPendingState.lifecycleState, ""),
  );
  if (currentStateIndex > nextStateIndex) {
    return latestPocketState;
  }
  const nextPendingState = {
    ...cloneValue(rawPendingState),
    lifecycleState: normalizedState,
    lifecycleUpdatedAtMs: toInt(deps && deps.now && deps.now(), Date.now()),
    completedLifecycleStates: [
      ...completedLifecycleStates,
      normalizedState,
    ],
    ...cloneValue(details.pendingState || {}),
  };
  const updatedPocketState = updatePocketState(instanceID, {
    pendingTransitionState: nextPendingState,
  }) || latestPocketState;
  log.info(
    `[AbyssalRoomTransfer] run=${instanceID} ` +
      `fromRoom=${toInt(rawPendingState.sourceRoomIndex, toInt(details.fromRoom, 0))} ` +
      `toRoom=${toInt(rawPendingState.targetRoomIndex, toInt(details.toRoom, 0))} ` +
      `state=${normalizedState}`,
  );
  return updatedPocketState;
}

function clearPendingAbyssalTransitionHandle(ports, instanceID, deps = ports.getDependencies()) {
  const {
    cancelTransitionHandle,
  } = ports;
  const numericInstanceID = toInt(instanceID, 0);
  return cancelTransitionHandle(
    numericInstanceID,
    deps && deps.clearScheduledTimeout,
  );
}

function cancelPendingAbyssalTransition(ports, instanceID, deps = ports.getDependencies(), reason = "cancelled") {
  const {
    getActivePocketStateByInstanceID,
    cloneValue,
    updatePocketState,
  } = ports;
  const numericInstanceID = toInt(instanceID, 0);
  if (numericInstanceID <= 0) {
    return null;
  }
  clearPendingAbyssalTransitionHandle(ports, numericInstanceID, deps);
  const pocketState = getActivePocketStateByInstanceID(numericInstanceID);
  const pendingState = getPendingAbyssalTransitionState(ports, pocketState);
  if (!pendingState || pendingState.status !== "pending") {
    return pocketState;
  }
  if (pendingState.sourceCommitIrreversible === true) {
    return updatePocketState(numericInstanceID, {
      pendingTransitionState: {
        ...cloneValue(pocketState && pocketState.pendingTransitionState),
        currentPhase: normalizeText(
          pendingState.currentPhase,
          "irreversible-settlement-pending",
        ),
        cancellationRejectedAtMs: toInt(deps.now(), 0),
        cancellationRejectedReason: normalizeText(reason, "cancelled"),
      },
    }) || pocketState;
  }
  return updatePocketState(numericInstanceID, {
    pendingTransitionState: {
      ...cloneValue(pocketState && pocketState.pendingTransitionState),
      status: "cancelled",
      cancelledAtMs: toInt(deps.now(), 0),
      cancelReason: normalizeText(reason, "cancelled"),
    },
  }) || pocketState;
}

function restoreAbyssalSourceRoomAfterTransitionFailure(ports,
  pocketState,
  session,
  deps,
  options = {},
) {
  const {
    getActivePocketStateByInstanceID,
    cloneValue,
    updatePocketState,
    log,
    setAbyssalRoomEntityDeliveryState,
    ABYSSAL_ROOM_DELIVERY_STATE,
    activateAbyssalRoomNpcControllers,
    activateSuppressorControllersForPocketRoom,
    deliverSuppressorPresentationForSession,
    ensureBoundaryControllerForPocketState,
  } = ports;
  const numericInstanceID = toInt(pocketState && pocketState.instanceID, 0);
  const phase = normalizeText(options.phase, "").toLowerCase();
  const sourceRoomIndex = toInt(options.sourceRoomIndex, 0);
  const targetRoomIndex = toInt(options.targetRoomIndex, 0);
  const failureReason = normalizeText(
    options.failureReason,
    "ABYSSAL_TRANSITION_FAILED",
  );
  const terminalStatus = normalizeText(options.terminalStatus, "failed").toLowerCase() === "cancelled"
    ? "cancelled"
    : "failed";
  let restoredPocketState =
    getActivePocketStateByInstanceID(numericInstanceID) || pocketState;
  let restoreError = "";

  if (!["transfer", "exit"].includes(phase) || numericInstanceID <= 0 || sourceRoomIndex <= 0) {
    return restoredPocketState;
  }

  try {
    if (phase === "transfer" && targetRoomIndex > 0) {
      const hiddenResult = setAbyssalRoomEntityDeliveryState(
        restoredPocketState,
        targetRoomIndex,
        ABYSSAL_ROOM_DELIVERY_STATE.PREWARMED_HIDDEN,
        session,
        deps,
        { transitionToken: 0 },
      );
      restoredPocketState = hiddenResult.pocketState || restoredPocketState;
    }
    const visibleResult = setAbyssalRoomEntityDeliveryState(
      restoredPocketState,
      sourceRoomIndex,
      ABYSSAL_ROOM_DELIVERY_STATE.VISIBLE,
      session,
      deps,
      { transitionToken: 0 },
    );
    restoredPocketState = visibleResult.pocketState || restoredPocketState;
  } catch (error) {
    restoreError = normalizeText(error && error.message, "ROOM_VISIBILITY_RESTORE_FAILED");
  }

  try {
    const npcRestoreResult = activateAbyssalRoomNpcControllers(restoredPocketState, session, deps, {
      roomIndex: sourceRoomIndex,
      expectPaused: true,
      allowAlreadyActive: true,
      roomActive: true,
      degradeOnFailure: false,
    });
    if (!npcRestoreResult || npcRestoreResult.success !== true) {
      restoreError = restoreError || normalizeText(
        npcRestoreResult && npcRestoreResult.errorMsg,
        "ROOM_NPC_CONTROLLER_RESTORE_FAILED",
      );
    }
    activateSuppressorControllersForPocketRoom(
      restoredPocketState,
      sourceRoomIndex,
      deps,
    );
    deliverSuppressorPresentationForSession(
      restoredPocketState,
      session,
      deps,
      {
        roomIndex: sourceRoomIndex,
        reason: `transition-${terminalStatus}`,
        allowRetry: true,
      },
    );
  } catch (error) {
    restoreError = restoreError || normalizeText(
      error && error.message,
      "ROOM_CONTROLLER_RESTORE_FAILED",
    );
  }

  const currentPocketState =
    getActivePocketStateByInstanceID(numericInstanceID) || restoredPocketState;
  const currentPendingState = getPendingAbyssalTransitionState(ports, currentPocketState);
  const settledPocketState = updatePocketState(numericInstanceID, {
    pendingTransitionState: {
      ...cloneValue(currentPendingState || {}),
      status: terminalStatus,
      currentPhase: terminalStatus,
      completedAtMs: toInt(deps.now(), 0),
      cancelledAtMs: terminalStatus === "cancelled" ? toInt(deps.now(), 0) : 0,
      cancelReason: terminalStatus === "cancelled" ? failureReason : "",
      committedRoomIndex: sourceRoomIndex,
      sourceControllersPaused: false,
      destinationControllersActive: false,
      failureReason: terminalStatus === "failed" ? failureReason : "",
      restoreError,
    },
  }) || currentPocketState;
  try {
    ensureBoundaryControllerForPocketState(
      settledPocketState,
      deps,
      toInt(deps.now(), 0),
    );
  } catch (error) {
    log.warn(
      `[AbyssalTransition] source-room boundary restore failed instance=${numericInstanceID} ` +
        `phase=${phase} reason=${normalizeText(error && error.message, "UNKNOWN")}`,
    );
  }
  log.warn(
    `[AbyssalTransition] handoff ${terminalStatus} and source room restored ` +
      `instance=${numericInstanceID} phase=${phase} room=${sourceRoomIndex} ` +
      `reason=${failureReason} restoreError=${restoreError || "none"}`,
  );
  return settledPocketState;
}

function quiesceAbyssalRoomTransferCombat(ports,
  pocketState,
  session,
  deps = ports.getDependencies(),
  reason = "room-transfer-start",
) {
  const {
    log,
    buildPlaceholderRoomState,
    getPlaceholderRoomEntry,
    listUniquePositiveInts,
    finalizeAndCleanupBoundaryControllersForRun,
    pauseAbyssalObjectiveControllers,
    pauseSuppressorControllersForRoom,
    stopSuppressorPresentationForPocketSession,
  } = ports;
  const roomState = buildPlaceholderRoomState(pocketState);
  const roomIndex = roomState.currentRoomIndex;
  const normalizedReason = normalizeText(reason, "room-transfer-start");
  const roomEntry = getPlaceholderRoomEntry(pocketState, roomIndex);
  const hostileIDs = listUniquePositiveInts(roomEntry && roomEntry.hostileEntityIDs);
  const shipID = toInt(pocketState && pocketState.shipID, toInt(session && session.shipID, 0));
  const participantIDs = new Set([shipID, ...hostileIDs].filter((entityID) => entityID > 0));
  const boundaryResults = finalizeAndCleanupBoundaryControllersForRun(
    toInt(pocketState && pocketState.instanceID, 0),
    toInt(deps.now(), Date.now()),
    normalizedReason,
  );
  if (boundaryResults.some((result) => result && result.terminal === true)) {
    return {
      success: false,
      errorMsg: "ABYSSAL_BOUNDARY_DESTRUCTION_STARTED",
      boundaryResults,
    };
  }
  const npcRuntime = deps;
  pauseAbyssalObjectiveControllers(
    npcRuntime,
    hostileIDs,
    `abyssal_${normalizedReason.replace(/-/g, "_")}`,
  );
  const pausedSuppressors = pauseSuppressorControllersForRoom(
    toInt(pocketState && pocketState.instanceID, 0),
    roomIndex,
    normalizedReason,
  );
  const suppressorPresentationResults = stopSuppressorPresentationForPocketSession(
    pocketState,
    session,
    deps,
    {
      roomIndex,
      reason: normalizedReason,
    },
  );
  for (const hostileID of hostileIDs) {
    const controller =
      npcRuntime && typeof npcRuntime.getControllerByEntityID === "function"
        ? npcRuntime.getControllerByEntityID(hostileID)
        : null;
    if (controller) {
      controller.currentTargetID = 0;
      controller.preferredTargetID = 0;
    }
  }

  const runtime = deps;
  const scene = runtime && typeof runtime.getSceneForSession === "function"
    ? runtime.getSceneForSession(session)
    : null;
  const preserveActiveModules = normalizedReason !== "final-exit-start";
  const moduleResult = !preserveActiveModules &&
    runtime && typeof runtime.deactivateAllActiveModules === "function"
    ? runtime.deactivateAllActiveModules(session, {
        reason: "abyssalRoomTransfer",
        nowMs: toInt(deps.now(), 0),
      })
    : null;
  const targetResult = runtime && typeof runtime.clearTargets === "function"
    ? runtime.clearTargets(session, { reason: "abyssalRoomTransfer" })
    : null;
  if (scene && typeof scene.clearAllTargetingForEntity === "function") {
    for (const participantID of participantIDs) {
      const entity = typeof scene.getEntityByID === "function"
        ? scene.getEntityByID(participantID)
        : null;
      if (entity) {
        scene.clearAllTargetingForEntity(entity, {
          reason: "abyssalRoomTransfer",
          nowMs: toInt(deps.now(), 0),
        });
      }
    }
  }

  let removedMissileCount = 0;
  if (
    scene &&
    scene.dynamicEntities instanceof Map &&
    typeof scene.removeDynamicEntity === "function"
  ) {
    const missileIDs = [...scene.dynamicEntities.values()]
      .filter((entity) =>
        entity &&
        entity.kind === "missile" &&
        (
          participantIDs.has(toInt(entity.sourceShipID, 0)) ||
          participantIDs.has(toInt(entity.targetEntityID, 0))
        )
      )
      .map((entity) => toInt(entity.itemID, 0))
      .filter((entityID) => entityID > 0);
    for (const missileID of missileIDs) {
      const result = scene.removeDynamicEntity(missileID, {
        broadcast: true,
        reason: "abyssal-room-transfer",
      });
      if (result && result.success) {
        removedMissileCount += 1;
      }
    }
  }
  log.info(
    `[AbyssalTransfer] combat quiesced run=${toInt(pocketState && pocketState.instanceID, 0)} ` +
      `room=${roomIndex} controllersPaused=${hostileIDs.length} ` +
      `suppressorsPaused=${pausedSuppressors.length} ` +
      `suppressorPresentationsStopped=${suppressorPresentationResults.length} ` +
      `boundaryControllersCleared=${boundaryResults.length} ` +
      `modulePolicy=${preserveActiveModules ? "preserve-active" : "stop-active"} ` +
      `modulesStopped=${toInt(moduleResult && moduleResult.data && moduleResult.data.stoppedModuleIDs && moduleResult.data.stoppedModuleIDs.length, 0)} ` +
      `targetsCleared=${toInt(targetResult && targetResult.data && targetResult.data.clearedTargetIDs && targetResult.data.clearedTargetIDs.length, 0)} ` +
      `missilesRemoved=${removedMissileCount}`,
  );
  return {
    success: true,
    controllersPaused: hostileIDs.length,
    suppressorsPaused: pausedSuppressors.length,
    suppressorPresentationsStopped: suppressorPresentationResults.length,
    boundaryControllersCleared: boundaryResults.length,
    removedMissileCount,
    activeModulesPreserved: preserveActiveModules,
    moduleResult,
    targetResult,
  };
}

function revalidateDelayedAbyssalEndGateHandoff(ports,
  args,
  session,
  currentPocketState,
  expected,
  deps = ports.getDependencies(),
) {
  const {
    buildPlaceholderRoomState,
    getPlaceholderRoomEntry,
    buildAbyssalHandoffSessionIdentity,
    getAbyssalParticipantRecord,
    isAbyssalParticipantInRun,
    evaluateAbyssalDelayedHandoffEligibility,
    validateAbyssalExitTraceActivation,
  } = ports;
  const identityResult = buildAbyssalHandoffSessionIdentity(session, deps, {
    ...expected,
    requireBoundInstance: true,
  });
  if (!identityResult.success) {
    return identityResult;
  }
  const expectedInstanceID = toInt(expected && expected.instanceID, 0);
  const expectedRoomIndex = toInt(expected && expected.sourceRoomIndex, 0);
  const expectedMarkerItemID = toInt(expected && expected.markerItemID, 0);
  const roomState = buildPlaceholderRoomState(currentPocketState);
  const roomEntry = getPlaceholderRoomEntry(currentPocketState, expectedRoomIndex);
  const currentParticipant = getAbyssalParticipantRecord(
    currentPocketState,
    expected.characterID,
  );
  const runIdentityMatches = Boolean(
    currentPocketState &&
    toInt(currentPocketState.instanceID, 0) === expectedInstanceID &&
    isAbyssalParticipantInRun(currentPocketState, expected.characterID) &&
    toInt(currentParticipant && currentParticipant.shipID, 0) ===
      toInt(expected.shipID, 0) &&
    roomState.currentRoomIndex === expectedRoomIndex &&
    toInt(roomEntry && roomEntry.conduitItemID, 0) === expectedMarkerItemID &&
    toInt(currentPocketState.exitMarkerItemID, 0) === expectedMarkerItemID
  );
  const currentIdentityDecision = evaluateAbyssalDelayedHandoffEligibility({
    runIdentityMatches,
  });
  if (!currentIdentityDecision.allowed) {
    return {
      success: false,
      errorMsg: currentIdentityDecision.reason,
    };
  }

  const freshValidation = validateAbyssalExitTraceActivation(
    [expectedMarkerItemID],
    session,
    deps,
  );
  if (!freshValidation || freshValidation.success !== true) {
    return {
      ...(freshValidation || {}),
      success: false,
      errorMsg: normalizeText(
        freshValidation && freshValidation.errorMsg,
        "ABYSSAL_END_GATE_HANDOFF_REVALIDATION_FAILED",
      ),
    };
  }
  const freshPocketState = freshValidation.data && freshValidation.data.pocketState;
  const freshRoomState = buildPlaceholderRoomState(freshPocketState);
  const freshRoomEntry = getPlaceholderRoomEntry(freshPocketState, expectedRoomIndex);
  const validationIdentityDecision = evaluateAbyssalDelayedHandoffEligibility({
    runIdentityMatches: true,
    validationIdentityChecked: true,
    validationIdentityMatches: Boolean(
      toInt(freshValidation.data.markerItemID, 0) === expectedMarkerItemID &&
      normalizeText(freshValidation.data.activationMode, "") ===
        normalizeText(expected.activationMode, "") &&
      toInt(freshPocketState && freshPocketState.instanceID, 0) === expectedInstanceID &&
      freshRoomState.currentRoomIndex === expectedRoomIndex &&
      toInt(freshRoomEntry && freshRoomEntry.conduitItemID, 0) === expectedMarkerItemID,
    ),
  });
  if (!validationIdentityDecision.allowed) {
    return {
      success: false,
      errorMsg: validationIdentityDecision.reason,
    };
  }
  return freshValidation;
}

function createAbyssalTransitionAuthority(ports) {
  return {
    getPendingAbyssalTransitionState: getPendingAbyssalTransitionState.bind(null, ports),
    advanceAbyssalRoomTransferLifecycle: advanceAbyssalRoomTransferLifecycle.bind(null, ports),
    clearPendingAbyssalTransitionHandle: clearPendingAbyssalTransitionHandle.bind(null, ports),
    cancelPendingAbyssalTransition: cancelPendingAbyssalTransition.bind(null, ports),
    restoreAbyssalSourceRoomAfterTransitionFailure: restoreAbyssalSourceRoomAfterTransitionFailure.bind(null, ports),
    quiesceAbyssalRoomTransferCombat: quiesceAbyssalRoomTransferCombat.bind(null, ports),
    revalidateDelayedAbyssalEndGateHandoff: revalidateDelayedAbyssalEndGateHandoff.bind(null, ports),
  };
}

module.exports = { createAbyssalTransitionAuthority };
