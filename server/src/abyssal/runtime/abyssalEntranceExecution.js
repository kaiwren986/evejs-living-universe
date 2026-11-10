"use strict";

const { normalizeText } = require("../domain/abyssalValueUtils");

// Every continuation carries the originating request and freshly revalidated run state.
function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function beginEntranceMovement(ports, request, activePocketState, handoffValidation) {
  const {
    getPendingAbyssalTransitionState,
    updatePocketState,
    cloneValue,
    updatePendingAbyssalTraceActivation,
    moveShipIntoPlaceholderPocket,
    recordAuditEvent,
    log,
  } = ports;
  const { args, session, deps, validation, context, traceState, contentProfile } = request;
  const freshValidation = handoffValidation && handoffValidation.data
  ? handoffValidation
  : validation;
  const activePendingTransition =
  getPendingAbyssalTransitionState(activePocketState) || {};
  const sessionChangeStartedAtMs = Math.max(
  toInt(deps.now(), 0),
  toInt(activePendingTransition.executeAtMs, 0),
);
  activePocketState = updatePocketState(activePocketState.instanceID, {
  pendingTransitionState: {
    ...cloneValue(activePendingTransition),
    sessionChangeStartedAtMs,
  },
}) || activePocketState;
  updatePendingAbyssalTraceActivation(
  traceState.traceItemID,
  "session-change-started",
  {
    runID: activePocketState.instanceID,
    transitionDelayMs: toInt(activePendingTransition.durationMs, 0),
    sessionChangeStartedAt: sessionChangeStartedAtMs,
    status: "started",
    reason: "TRANSITION_INTERVAL_ELAPSED",
  },
);
  const entryValidation = {
  ...freshValidation,
  data: {
    ...freshValidation.data,
    pocketState: activePocketState,
  },
};
  const moveResult = moveShipIntoPlaceholderPocket(entryValidation, activePocketState, session, deps);
  if (!moveResult.success) {
  recordAuditEvent("abyssal_entrance_gate_activation_move_failed", args, session, {
    traceItemID: traceState.traceItemID,
    instanceID: activePocketState.instanceID,
    errorMsg: moveResult.errorMsg,
  });
  log.warn(
    `[AbyssalMgr] Abyssal pocket entry failed char=${context.characterID} trace=${traceState.traceItemID} instance=${activePocketState.instanceID} reason=${moveResult.errorMsg}`,
  );
  return moveResult;
}
  recordAuditEvent("abyssal_entrance_gate_activation_ship_moved", args, session, {
  traceItemID: traceState.traceItemID,
  instanceID: activePocketState.instanceID,
  shipID: context.shipID,
  transitionMode: moveResult.data && moveResult.data.transitionMode || null,
  sessionRebound: Boolean(
    moveResult.data && moveResult.data.sessionRebound,
  ),
});
  log.info(
  `[AbyssalMgr] Ship entered Abyssal pocket char=${context.characterID} trace=${traceState.traceItemID} ship=${context.shipID} instance=${activePocketState.instanceID}`,
);
  return { success: true, execution: { ...request, activePocketState, entryValidation, moveResult } };
}

function spawnEntranceContent(ports, request) {
  const {
    shouldUseCorrelatedAbyssalSpaceEmpiricalContent,
    getContentProfile,
    recordAuditEvent,
    log,
    spawnPlaceholderPocketContent,
    getActivePocketStateByInstanceID,
    usesAuthoredAbyssalEnvironmentNotification,
    markAbyssalDungeonRoomWithoutGenericNotification,
    getPocketScene,
    buildPlaceholderRoomState,
    broadcastAbyssalRoomBootstrapAddBalls,
  } = ports;
  const { args, session, deps, validation, context, traceState, contentProfile, activePocketState, entryValidation, moveResult } = request;
  const authoredContentUnavailable = Boolean(
  moveResult.data && moveResult.data.authoredContentUnavailable,
) && !(
  shouldUseCorrelatedAbyssalSpaceEmpiricalContent(contentProfile) ||
  shouldUseCorrelatedAbyssalSpaceEmpiricalContent(
    getContentProfile(activePocketState),
  ) ||
  shouldUseCorrelatedAbyssalSpaceEmpiricalContent(
    getContentProfile(traceState),
  )
);
  if (authoredContentUnavailable) {
  recordAuditEvent("abyssal_entrance_gate_activation_placeholder_fallback", args, session, {
    traceItemID: traceState.traceItemID,
    instanceID: activePocketState.instanceID,
    templateID: activePocketState.templateID,
  });
  log.info(
    `[AbyssalMgr] Abyssal fallback content mode active ` +
      `char=${context.characterID} trace=${traceState.traceItemID} instance=${activePocketState.instanceID}`,
  );
}
  const spawnResult = spawnPlaceholderPocketContent(entryValidation, activePocketState, session, deps);
  const activePocketStateAfterSpawn =
  spawnResult && spawnResult.data
    ? spawnResult.data
    : getActivePocketStateByInstanceID(activePocketState.instanceID) || activePocketState;
  const authoredEnvironmentNotification = usesAuthoredAbyssalEnvironmentNotification(
  activePocketStateAfterSpawn,
  session,
  deps,
);
  if (authoredEnvironmentNotification) {
  markAbyssalDungeonRoomWithoutGenericNotification(
    getPocketScene(activePocketStateAfterSpawn, deps),
    session,
    activePocketStateAfterSpawn,
    deps,
    buildPlaceholderRoomState(activePocketStateAfterSpawn).currentRoomIndex,
  );
}
  const bootstrapResult = broadcastAbyssalRoomBootstrapAddBalls(
  activePocketStateAfterSpawn,
  session,
  deps,
  "entrance-activation",
);
  return { ...request, authoredContentUnavailable, spawnResult, activePocketStateAfterSpawn, authoredEnvironmentNotification, bootstrapResult };
}

function deliverEntranceBootstrap(ports, request) {
  const {
    usesIsolatedAbyssalScene,
    queueAbyssalFreshEntryBootstrap,
    log,
    buildPlaceholderRoomState,
    recordAuditEvent,
    queueAbyssalClientEnvironmentDelivery,
    getContentProfile,
    sendAbyssalExpiryDurationNotification,
    sendOrQueueInitialAbyssalArrivalFx,
  } = ports;
  const { args, session, deps, context, traceState, activePocketState, activePocketStateAfterSpawn, authoredEnvironmentNotification, bootstrapResult } = request;
  const freshEntryBootstrapResult = usesIsolatedAbyssalScene(activePocketStateAfterSpawn, deps)
  ? queueAbyssalFreshEntryBootstrap(activePocketStateAfterSpawn, session, deps)
  : null;
  if (
  usesIsolatedAbyssalScene(activePocketStateAfterSpawn, deps) &&
  !(freshEntryBootstrapResult && freshEntryBootstrapResult.queued === true)
) {
  log.warn(
    `[AbyssalFreshEntryBootstrap] state=blocked ` +
      `character=${context.characterID} ship=${context.shipID} ` +
      `run=${toInt(activePocketStateAfterSpawn && activePocketStateAfterSpawn.instanceID, 0)} ` +
      `room=${buildPlaceholderRoomState(activePocketStateAfterSpawn).currentRoomIndex} ` +
      `reason=${normalizeText(
        freshEntryBootstrapResult && freshEntryBootstrapResult.reason,
        "TOKEN_QUEUE_FAILED",
      )}`,
  );
}
  if (!bootstrapResult.success) {
  recordAuditEvent("abyssal_entrance_gate_activation_bootstrap_partial", args, session, {
    traceItemID: traceState.traceItemID,
    instanceID: activePocketState.instanceID,
    errorMsg: bootstrapResult.errorMsg,
  });
}
  if (authoredEnvironmentNotification) {
  queueAbyssalClientEnvironmentDelivery(
    activePocketStateAfterSpawn,
    session,
    deps,
    {
      phase: "entry",
      activateNpcControllers: true,
    },
  );
} else {
  const activeRoomState = buildPlaceholderRoomState(activePocketStateAfterSpawn);
  const activeContentProfile = getContentProfile(activePocketStateAfterSpawn) || {};
  log.info(
    `[AbyssalClientEnvironment] phase=entry ` +
      `instance=${toInt(activePocketStateAfterSpawn && activePocketStateAfterSpawn.instanceID, 0)} ` +
      `tier=${toInt(activeContentProfile.tier, 0)} weather=${normalizeText(activeContentProfile.weatherType, "unknown")} ` +
      `room=${toInt(activeRoomState.currentRoomIndex, 0)} notificationSent=false ` +
      `clientApplication=UNVERIFIED reason=ENVIRONMENT_PROFILE_NOT_AUTHORED`,
  );
  // The retail timer is independent of the authored visual stack. Higher
  // tiers without a captured room profile must still receive and anchor
  // their 20-minute expiry contract after the room-one handoff.
  sendAbyssalExpiryDurationNotification(
    session,
    activePocketStateAfterSpawn,
    deps,
    { phase: "entry-without-authored-environment" },
  );
  sendOrQueueInitialAbyssalArrivalFx(
    activePocketStateAfterSpawn,
    session,
    deps,
    "initial-room-entry",
  );
}
}

function activateEntranceGameplay(ports, request) {
  const {
    usesIsolatedAbyssalScene,
    activateAbyssalRoomNpcControllers,
    buildPlaceholderRoomState,
    recordAuditEvent,
    logAbyssalRoomContentActivated,
    getActivePocketStateByInstanceID,
    activateSuppressorControllersForPocketRoom,
    deliverSuppressorPresentationForSession,
    applyAbyssalWeatherToRun,
  } = ports;
  const { args, session, deps, traceState, activePocketState, activePocketStateAfterSpawn, authoredEnvironmentNotification, bootstrapResult } = request;
  const deferNpcActivationForEnvironmentDelivery = Boolean(
  usesIsolatedAbyssalScene(activePocketStateAfterSpawn, deps) &&
    authoredEnvironmentNotification,
);
  let npcActivationResult = {
  success: !usesIsolatedAbyssalScene(activePocketStateAfterSpawn, deps),
  skipped: !usesIsolatedAbyssalScene(activePocketStateAfterSpawn, deps),
};
  if (deferNpcActivationForEnvironmentDelivery) {
  npcActivationResult = {
    success: true,
    deferred: true,
    reason: "AWAITING_ENVIRONMENT_NOTIFICATION_HANDOFF",
  };
} else if (usesIsolatedAbyssalScene(activePocketStateAfterSpawn, deps)) {
  try {
    npcActivationResult = activateAbyssalRoomNpcControllers(
      activePocketStateAfterSpawn,
      session,
      deps,
      {
        roomIndex: buildPlaceholderRoomState(activePocketStateAfterSpawn).currentRoomIndex,
        expectPaused: true,
        roomActive: true,
      },
    );
  } catch (error) {
    npcActivationResult = {
      success: false,
      errorMsg: normalizeText(
        error && error.message,
        "ABYSSAL_NPC_ACTIVATION_FAILED",
      ),
    };
  }
  if (!npcActivationResult.success) {
    recordAuditEvent("abyssal_entrance_gate_activation_npc_activation_failed", args, session, {
      traceItemID: traceState.traceItemID,
      instanceID: activePocketState.instanceID,
      errorMsg: npcActivationResult.errorMsg,
    });
  } else {
    logAbyssalRoomContentActivated(
      getActivePocketStateByInstanceID(toInt(activePocketStateAfterSpawn.instanceID, 0)) ||
        activePocketStateAfterSpawn,
      {
        roomIndex: buildPlaceholderRoomState(activePocketStateAfterSpawn).currentRoomIndex,
      },
    );
  }
}
  let suppressorActivationResults = [];
  if (bootstrapResult.success) {
  const deliveredPocketState =
    getActivePocketStateByInstanceID(toInt(activePocketStateAfterSpawn.instanceID, 0)) ||
    bootstrapResult.pocketState ||
    activePocketStateAfterSpawn;
  suppressorActivationResults = activateSuppressorControllersForPocketRoom(
    deliveredPocketState,
    buildPlaceholderRoomState(deliveredPocketState).currentRoomIndex,
    deps,
  );
  if (!authoredEnvironmentNotification) {
    deliverSuppressorPresentationForSession(
      deliveredPocketState,
      session,
      deps,
      {
        roomIndex: buildPlaceholderRoomState(deliveredPocketState).currentRoomIndex,
        deliveredEntityIDs: bootstrapResult.payloadEntityIDs,
        reason: "room-delivered",
      },
    );
  }
}
  const weatherResult = applyAbyssalWeatherToRun(activePocketStateAfterSpawn, session, deps, {
  reason: "entrance-activation",
});
  if (!usesIsolatedAbyssalScene(activePocketStateAfterSpawn, deps) && !authoredEnvironmentNotification) {
  const activatedPocketState =
    getActivePocketStateByInstanceID(toInt(activePocketStateAfterSpawn.instanceID, 0)) ||
    bootstrapResult.pocketState ||
    activePocketStateAfterSpawn;
  logAbyssalRoomContentActivated(activatedPocketState, {
    roomIndex: buildPlaceholderRoomState(activatedPocketState).currentRoomIndex,
  });
}
  return { ...request, deferNpcActivationForEnvironmentDelivery, npcActivationResult, suppressorActivationResults, weatherResult };
}

function inspectEntranceReadiness(ports, request) {
  const {
    getActivePocketStateByInstanceID,
    ensureBoundaryControllerForPocketState,
    evaluateEnvironmentalEffectsForPocketState,
    buildPlaceholderRoomState,
    buildAbyssalActiveRoomReadiness,
    recordAuditEvent,
  } = ports;
  const { args, session, deps, traceState, activePocketState, activePocketStateAfterSpawn, spawnResult, deferNpcActivationForEnvironmentDelivery, suppressorActivationResults, weatherResult } = request;
  let { npcActivationResult } = request;
  const readinessPocketState =
  getActivePocketStateByInstanceID(toInt(activePocketStateAfterSpawn.instanceID, 0)) ||
  activePocketStateAfterSpawn;
  const boundaryResult = ensureBoundaryControllerForPocketState(
  readinessPocketState,
  deps,
  toInt(deps.now(), 0),
  { allowPendingEntry: true },
);
  const environmentalEffectResult = evaluateEnvironmentalEffectsForPocketState(
  readinessPocketState,
  deps,
  toInt(deps.now(), 0),
  {
    roomIndex: buildPlaceholderRoomState(readinessPocketState).currentRoomIndex,
    boundaryOptions: { allowPendingEntry: true },
  },
);
  let activeRoomReadiness;
  try {
  activeRoomReadiness = buildAbyssalActiveRoomReadiness(
    readinessPocketState,
    session,
    deps,
    {
      spawnResult,
      npcActivationResult,
      suppressorActivationResults,
      environmentalResult:
        spawnResult &&
        spawnResult.materializationResults &&
        spawnResult.materializationResults.environmentalResult,
      environmentalEffectResult,
      boundaryResult,
      weatherResult,
      allowPendingNpcControllers: deferNpcActivationForEnvironmentDelivery,
    },
  );
} catch (error) {
  const readinessError = normalizeText(
    error && error.message,
    "ABYSSAL_ACTIVE_ROOM_READINESS_CHECK_FAILED",
  );
  if (npcActivationResult && npcActivationResult.success === true) {
    npcActivationResult = {
      success: false,
      errorMsg: readinessError,
    };
  }
  activeRoomReadiness = {
    ready: false,
    materializationReady: false,
    gameplayReady: false,
    npcControllersReady: false,
    npcControllersActivated: false,
    errorMsg: "ABYSSAL_ACTIVE_ROOM_NPC_CONTROLLERS_NOT_READY",
    readinessError,
  };
  recordAuditEvent("abyssal_entrance_gate_activation_readiness_check_failed", args, session, {
    traceItemID: traceState.traceItemID,
    instanceID: activePocketState.instanceID,
    errorMsg: readinessError,
  });
}
  return { ...request, npcActivationResult, readinessPocketState, activeRoomReadiness };
}

function stageFailedEntranceRecovery(ports, request) {
  const {
    recordAuditEvent,
    cloneValue,
    stageAbyssalFilamentCompensationClaim,
    buildPlaceholderRoomState,
    suppressAbyssalRoomRewards,
    recordAbyssalRunOutcome,
    persistPendingAbyssalEntryRecovery,
    ABYSSAL_ENTRY_RECOVERY_REASON,
  } = ports;
  const { args, session, deps, traceState, activePocketState, activeRoomReadiness, readinessPocketState, npcActivationResult } = request;
  recordAuditEvent("abyssal_entrance_gate_activation_active_room_not_ready", args, session, {
  traceItemID: traceState.traceItemID,
  instanceID: activePocketState.instanceID,
  errorMsg: activeRoomReadiness.errorMsg,
  readiness: cloneValue(activeRoomReadiness),
});
  const compensationStageResult = stageAbyssalFilamentCompensationClaim(
  traceState,
  deps,
  "ENTRY_ACTIVE_ROOM_NOT_READY",
  { authoritativeEntryCommitted: true },
);
  const roomIndex = buildPlaceholderRoomState(readinessPocketState).currentRoomIndex;
  const rewardSuppressedPocketState = suppressAbyssalRoomRewards(
  readinessPocketState,
  roomIndex,
  deps,
  "ENTRY_ACTIVE_ROOM_NOT_READY",
) || readinessPocketState;
  const terminalPocketState = recordAbyssalRunOutcome(
  rewardSuppressedPocketState,
  "failed_entry_readiness",
  deps,
  {
    reason: "ENTRY_ACTIVE_ROOM_NOT_READY",
    readinessError: activeRoomReadiness.errorMsg,
    rewardEligible: false,
    readiness: cloneValue(activeRoomReadiness),
  },
) || rewardSuppressedPocketState;
  const compensationDurablyStaged = Boolean(
  compensationStageResult &&
  compensationStageResult.success === true &&
  compensationStageResult.durable === true
);
  const recoveryIntentResult = persistPendingAbyssalEntryRecovery(
  terminalPocketState,
  {
    pending: true,
    reason: ABYSSAL_ENTRY_RECOVERY_REASON.PENDING_EVACUATION,
    activationFailureReason: "ENTRY_ACTIVE_ROOM_NOT_READY",
    readinessError: normalizeText(
      activeRoomReadiness.errorMsg,
      "ABYSSAL_ACTIVE_ROOM_NOT_READY",
    ),
    npcActivationError: normalizeText(
      npcActivationResult && npcActivationResult.errorMsg,
      "",
    ),
    compensationRequired: true,
    compensationDurablyStaged,
    compensationDeploymentToken: normalizeText(
      traceState.deploymentToken,
      "",
    ),
    compensationStageError: compensationDurablyStaged
      ? ""
      : normalizeText(
          compensationStageResult && compensationStageResult.errorMsg,
          "FILAMENT_COMPENSATION_STAGE_FAILED",
        ),
    evacuationError: "",
  },
  deps,
);
  return { ...request, compensationStageResult, recoveryIntentResult };
}

function settleFailedEntranceRecovery(ports, request) {
  const {
    updatePendingAbyssalTraceActivation,
    cloneValue,
    reconcilePendingAbyssalEntryRecovery,
    log,
    clearPendingAbyssalTraceActivation,
  } = ports;
  const { session, deps, context, traceState, activePocketState, activeRoomReadiness, moveResult, compensationStageResult, recoveryIntentResult } = request;
  if (!recoveryIntentResult || recoveryIntentResult.success !== true) {
  updatePendingAbyssalTraceActivation(
    traceState.traceItemID,
    "entry-recovery-persist-failed",
    {
      runID: activePocketState.instanceID,
      status: "paused",
      reason: normalizeText(
        recoveryIntentResult && recoveryIntentResult.errorMsg,
        "ABYSSAL_ENTRY_RECOVERY_PERSIST_FAILED",
      ),
    },
  );
  return {
    success: false,
    sourceCommitIrreversible: true,
    recoveryPending: true,
    errorMsg: normalizeText(
      recoveryIntentResult && recoveryIntentResult.errorMsg,
      "ABYSSAL_ENTRY_RECOVERY_PERSIST_FAILED",
    ),
    activeRoomReadiness,
    compensationStageResult,
    recoveryIntentResult,
  };
}
  const recoveryPocketState = cloneValue(
  recoveryIntentResult.committedState || recoveryIntentResult.state,
);
  const entryRecoveryResult = reconcilePendingAbyssalEntryRecovery(
  recoveryPocketState,
  session,
  deps,
);
  if (!entryRecoveryResult || entryRecoveryResult.settled !== true) {
  updatePendingAbyssalTraceActivation(traceState.traceItemID, "entry-recovery-pending", {
    runID: activePocketState.instanceID,
    status: "paused",
    reason: "ENTRY_RECOVERY_PENDING_EVACUATION_FAILED",
  });
  log.error(
    `[AbyssalRecovery] entry readiness recovery pending ` +
      `char=${context.characterID} ship=${context.shipID} ` +
      `run=${toInt(activePocketState.instanceID, 0)} ` +
      `readiness=${normalizeText(activeRoomReadiness.errorMsg, "NOT_READY")} ` +
      `reason=${normalizeText(
        entryRecoveryResult && entryRecoveryResult.errorMsg,
        "ENTRY_RECOVERY_PENDING",
      )}`,
  );
  return {
    success: false,
    sourceCommitIrreversible: true,
    data: moveResult.data,
    recoveryPending: true,
    activeRoomReadiness,
    compensationStageResult,
    recoveryIntentResult,
    entryRecoveryResult,
    evacuationResult:
      entryRecoveryResult && entryRecoveryResult.evacuationResult,
  };
}
  updatePendingAbyssalTraceActivation(traceState.traceItemID, "entry-rollback-complete", {
  runID: activePocketState.instanceID,
  status: "failed",
  reason: "ENTRY_ACTIVE_ROOM_NOT_READY",
});
  clearPendingAbyssalTraceActivation(traceState.traceItemID, deps);
  return {
  success: false,
  sourceCommitIrreversible: true,
  terminallySettled: true,
  errorMsg: activeRoomReadiness.errorMsg || "ABYSSAL_ACTIVE_ROOM_NOT_READY",
  activeRoomReadiness,
  compensationStageResult,
  recoveryIntentResult,
  entryRecoveryResult,
  evacuationResult: entryRecoveryResult.evacuationResult,
};
}

function completeEntranceExecution(ports, request) {
  const {
    recordAuditEvent,
    log,
    completePendingAbyssalTraceActivation,
  } = ports;
  const { args, session, deps, context, traceState, activePocketState, spawnResult, authoredContentUnavailable, moveResult } = request;
  if (spawnResult.partial) {
  recordAuditEvent("abyssal_entrance_gate_activation_spawn_partial", args, session, {
    traceItemID: traceState.traceItemID,
    instanceID: activePocketState.instanceID,
    errors: spawnResult.errors,
  });
  log.warn(
    `[AbyssalMgr] Abyssal content spawn partial char=${context.characterID} trace=${traceState.traceItemID} instance=${activePocketState.instanceID} errors=${spawnResult.errors.join(",")}`,
  );
} else {
  recordAuditEvent("abyssal_entrance_gate_activation_spawn_complete", args, session, {
    traceItemID: traceState.traceItemID,
    instanceID: activePocketState.instanceID,
    originMarkerItemID: spawnResult.data.originMarkerItemID,
    exitMarkerItemID: spawnResult.data.exitMarkerItemID,
    fallbackContent: authoredContentUnavailable,
  });
  log.info(
    `[AbyssalMgr] Abyssal content spawn complete char=${context.characterID} trace=${traceState.traceItemID} instance=${activePocketState.instanceID} origin=${spawnResult.data.originMarkerItemID} exit=${spawnResult.data.exitMarkerItemID}`,
  );
  if (authoredContentUnavailable) {
    log.info(
      `[AbyssalMgr] Abyssal fallback content spawned count=2 char=${context.characterID} ` +
        `trace=${traceState.traceItemID} instance=${activePocketState.instanceID}`,
    );
  }
}
  completePendingAbyssalTraceActivation(traceState.traceItemID, deps, {
  runID: activePocketState.instanceID,
  reason: "ENTRY_TRANSITION_COMPLETED",
});
  return {
  success: true,
  data: {
    ...moveResult.data,
  },
};
}

function finishEntranceTransition(ports, request, activePocketState, handoffValidation) {
  const movement = beginEntranceMovement(ports, request, activePocketState, handoffValidation);
  if (!movement.success) return movement;
  const spawned = spawnEntranceContent(ports, movement.execution);
  deliverEntranceBootstrap(ports, spawned);
  const activated = activateEntranceGameplay(ports, spawned);
  const inspected = inspectEntranceReadiness(ports, activated);
  if (!inspected.activeRoomReadiness.ready) {
    return settleFailedEntranceRecovery(ports, stageFailedEntranceRecovery(ports, inspected));
  }
  return completeEntranceExecution(ports, inspected);
}

function createAbyssalEntranceExecution(ports) {
  return { finishEntranceTransition: finishEntranceTransition.bind(null, ports) };
}

module.exports = { createAbyssalEntranceExecution };
