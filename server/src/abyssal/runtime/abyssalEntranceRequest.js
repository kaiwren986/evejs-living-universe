"use strict";

const { normalizeText } = require("../domain/abyssalValueUtils");

// Validation, admission and scheduling retain independent per-request continuation data.
function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

// The activation bundle must reach the pilot after the trace itself. When the
// pilot is not yet an Observer of the trace's Grid bubble, or the activation
// would carry an earlier stamp than the trace, the activation is refused and
// nothing reaches the client. That is a timing condition, not a broken entry:
// the prepared run stays and the activation is sent again a tick later, for
// as long as the trace is open.
const ENTRY_ACTIVATION_RETRY_REASONS = Object.freeze([
  "ABYSSAL_TRACE_ACTIVATION_DELIVERY_REJECTED",
  "ABYSSAL_TRACE_ACTIVATION_ORDER_INVALID",
]);
const ENTRY_ACTIVATION_RETRY_DELAY_MS = 1_000;
const ENTRY_ACTIVATION_RETRY_LIMIT = 30;

function canRetryEntryActivation(ports, request, reason) {
  const { getActiveTraceState, isCreatedAbyssalTraceExpired } = ports;
  const { deps, traceState } = request;
  if (!ENTRY_ACTIVATION_RETRY_REASONS.includes(normalizeText(reason, ""))) return false;
  if (toInt(request.activationRetryCount, 0) >= ENTRY_ACTIVATION_RETRY_LIMIT) return false;
  if (!deps || typeof deps.scheduleTimeout !== "function") return false;
  if (typeof getActiveTraceState !== "function") return false;
  const activeTrace = getActiveTraceState(toInt(traceState && traceState.traceItemID, 0), deps);
  if (!activeTrace) return false;
  return !(typeof isCreatedAbyssalTraceExpired === "function" &&
    isCreatedAbyssalTraceExpired(activeTrace, toInt(deps.now(), Date.now())));
}

function scheduleEntryActivationRetry(ports, request, reason) {
  const { updatePendingAbyssalTraceActivation, log } = ports;
  const { deps, traceState, pocketState, context, activationRetryState } = request;
  if (activationRetryState) activationRetryState.scheduled = true;
  const attempt = toInt(request.activationRetryCount, 0) + 1;
  const traceItemID = toInt(traceState && traceState.traceItemID, 0);
  const instanceID = toInt(pocketState && pocketState.instanceID, 0);
  const normalizedReason = normalizeText(reason, "ENTRY_TRACE_ACTIVATION_FAILED");
  updatePendingAbyssalTraceActivation(traceItemID, "activation-retry-pending", {
    runID: instanceID,
    status: "scheduled",
    reason: normalizedReason,
  });
  log.info(
    `[AbyssalTraceActivation] activation not delivered, retrying trace=${traceItemID} ` +
      `run=${instanceID} character=${toInt(context && context.characterID, 0)} ` +
      `attempt=${attempt} reason=${normalizedReason}`,
  );
  deps.scheduleTimeout(() => {
    try {
      finishEntranceRequest(ports, scheduleEntranceRequest(ports, {
        ...request,
        entryTransitionResult: undefined,
        activationRetryState: undefined,
        activationRetryCount: attempt,
      }));
    } catch (error) {
      log.warn(
        `[AbyssalTraceActivation] activation retry ended trace=${traceItemID} ` +
          `attempt=${attempt} reason=${normalizeText(error && error.message, "UNKNOWN")}`,
      );
    }
  }, ENTRY_ACTIVATION_RETRY_DELAY_MS);
  return null;
}

function validateEntranceRequest(ports, args, session, automaticTraceActivationTraceID) {
  const {
    getDependencies,
    validateAbyssalTraceActivation,
    recordAuditEvent,
    log,
    getCharacterID,
    throwCustomNotify,
    ABYSS_ERROR_KIND,
    ABYSS_UNSUPPORTED_FILAMENT_NOTIFY,
    buildAbyssalSecurityRestrictionNotify,
    throwAbyssError,
    buildAbyssErrorFromValidationError,
    admitAbyssalParticipantIntoExistingRun,
    ABYSS_ERROR,
  } = ports;
  const deps = getDependencies();
  const validation = validateAbyssalTraceActivation(args, session, deps);
  if (!validation.success) {
  recordAuditEvent("abyssal_entrance_gate_activation_rejected", args, session, {
    error: validation.error,
  });
  log.info(
    `[AbyssalMgr] Entrance gate activation rejected char=${getCharacterID(session)} code=${validation.error.code} details=${JSON.stringify(validation.error.details)}`,
  );
  if (
    validation.error &&
    validation.error.details &&
    String(validation.error.details.reason || "").startsWith("ACTIVE_")
  ) {
    log.info(
      `[AbyssalMgr] Active run rejected char=${getCharacterID(session)} reason=${validation.error.details.reason}`,
    );
    throwCustomNotify("An Abyssal run is already active.");
  }
  if (
    validation.error &&
    validation.error.kind === ABYSS_ERROR_KIND.UNSUPPORTED_FILAMENT_DEFINITION
  ) {
    throwCustomNotify(ABYSS_UNSUPPORTED_FILAMENT_NOTIFY);
  }
  if (validation.error) {
    const securityNotify = buildAbyssalSecurityRestrictionNotify(validation.error.details);
    if (securityNotify) {
      throwCustomNotify(securityNotify);
    }
  }
  throwAbyssError(buildAbyssErrorFromValidationError(validation.error));
}
  const {
  context,
  traceState,
} = validation.data;
  if (validation.data.joinExistingRun === true) {
  const admissionResult = admitAbyssalParticipantIntoExistingRun(
    validation,
    session,
    deps,
  );
  recordAuditEvent(
    admissionResult && admissionResult.success === true
      ? "abyssal_participant_admission_complete"
      : "abyssal_participant_admission_failed",
    args,
    session,
    {
      traceItemID: traceState.traceItemID,
      instanceID: toInt(
        validation.data.existingRunState && validation.data.existingRunState.instanceID,
        0,
      ),
      characterID: context.characterID,
      shipID: context.shipID,
      errorMsg: normalizeText(admissionResult && admissionResult.errorMsg, ""),
    },
  );
  if (!admissionResult || admissionResult.success !== true) {
    log.warn(
      `[AbyssalRoster] participant admission failed character=${context.characterID} ` +
        `ship=${context.shipID} trace=${traceState.traceItemID} ` +
        `reason=${normalizeText(admissionResult && admissionResult.errorMsg, "UNKNOWN")}`,
    );
    throwAbyssError([[ABYSS_ERROR.POCKET_MOVE_FAILED, []]]);
  }
  return null;
}
  return { args, session, deps, validation, context, traceState, automaticTraceActivationTraceID };
}

function claimEntranceRequest(ports, request) {
  const {
    refreshPendingAbyssalTraceActivationFromValidation,
    throwAbyssError,
    ABYSS_ERROR,
    resolveAbyssalTraceTransitionPresentation,
    logPendingAbyssalTraceActivation,
    clearCreatedAbyssalTraceExpirySchedule,
    claimPendingAbyssalTraceActivation,
    recordAuditEvent,
    log,
  } = ports;
  const { getPendingActivation } = ports;
  const { args, session, deps, validation, context, traceState, automaticTraceActivationTraceID } = request;
  const automaticActivation =
  automaticTraceActivationTraceID === toInt(traceState.traceItemID, 0);
  const existingPendingTraceActivation =
  getPendingActivation(toInt(traceState.traceItemID, 0)) || null;
  if (existingPendingTraceActivation) {
  const pendingRefreshResult = refreshPendingAbyssalTraceActivationFromValidation(
    existingPendingTraceActivation,
    validation,
    session,
    deps,
    automaticActivation
      ? "automatic-precommit-revalidation"
      : "manual-activation-validation",
  );
  if (!pendingRefreshResult.success) {
    throwAbyssError([[ABYSS_ERROR.UNKNOWN_ERROR, []]]);
  }
}
  if (
  !automaticActivation &&
  existingPendingTraceActivation &&
  resolveAbyssalTraceTransitionPresentation(traceState) &&
  (
    existingPendingTraceActivation.status === "activation-pending" ||
    existingPendingTraceActivation.status === "waiting-for-publication" ||
    existingPendingTraceActivation.status === "waiting-for-session"
  )
) {
  logPendingAbyssalTraceActivation(
    existingPendingTraceActivation,
    "manual-joined",
    {
      automatic: false,
      status: "pending",
      reason: "AUTOMATIC_ACTIVATION_BARRIER",
    },
  );
  return null;
}
  clearCreatedAbyssalTraceExpirySchedule(traceState.traceItemID, deps);
  const pendingTraceActivation = claimPendingAbyssalTraceActivation(
  traceState,
  session,
  deps,
  {
    automatic: automaticActivation,
    activatingCharacterID: context.characterID,
    activatingShipID: context.shipID,
  },
);
  recordAuditEvent("abyssal_entrance_gate_activation_requested", args, session, {
  traceItemID: traceState.traceItemID,
  shipID: context.shipID,
  solarSystemID: context.systemID,
  automatic: automaticActivation,
});
  log.info(
  `[AbyssalMgr] Trace activation requested char=${context.characterID} trace=${traceState.traceItemID} ship=${context.shipID} system=${context.systemID}`,
);
  return { ...request, automaticActivation, pendingTraceActivation };
}

function resolveEntranceRequest(ports, request) {
  const {
    getContentProfile,
    cloneValue,
    buildAbyssalWeatherState,
    recordAuditEvent,
    logResolvedAbyssalWeather,
    createOrResolvePlaceholderPocket,
    rollbackPendingAbyssalTraceActivation,
    log,
    throwAbyssError,
    ABYSS_ERROR,
  } = ports;
  const { args, session, deps, validation, context, traceState, automaticActivation, pendingTraceActivation } = request;
  const contentProfile =
  getContentProfile(traceState) ||
  cloneValue(validation.data && validation.data.filamentDefinition);
  const weatherState = buildAbyssalWeatherState(contentProfile, {
  traceItemID: traceState.traceItemID,
  selectionSeed: traceState.traceItemID,
});
  recordAuditEvent("abyssal_entrance_gate_activation_weather_resolved", args, session, {
  traceItemID: traceState.traceItemID,
  filamentTypeID: toInt(traceState.filamentTypeID, 0),
  weatherType: normalizeText(weatherState && weatherState.weatherType, ""),
  weatherName: normalizeText(weatherState && weatherState.weatherName, ""),
  weatherBonusText: normalizeText(weatherState && weatherState.bonusText, ""),
  weatherPenaltyText: normalizeText(weatherState && weatherState.penaltyText, ""),
  penaltyBandLabel: normalizeText(weatherState && weatherState.penaltyBandLabel, ""),
  weatherApplied: Array.isArray(weatherState && weatherState.appliedEffectKeys) &&
    weatherState.appliedEffectKeys.length > 0,
  weatherStrengthPct: toInt(weatherState && weatherState.strengthPercent, 0),
  weatherPenaltyStrengthPct: toInt(
    weatherState && weatherState.penaltyStrengthPercent,
    toInt(weatherState && weatherState.strengthPercent, 0),
  ),
  weatherBonusStrengthPct: toInt(
    weatherState && weatherState.bonusStrengthPercent,
    toInt(weatherState && weatherState.strengthPercent, 0),
  ),
  weatherStage: toInt(weatherState && weatherState.weatherStage, 0),
  weatherTypeID: toInt(weatherState && weatherState.weatherTypeID, 0),
  weatherSelectionModel: normalizeText(
    weatherState && weatherState.weatherSelectionModel,
    "",
  ),
  deterministicWeatherStrength: weatherState && weatherState.deterministicPlaceholder === true,
  weatherAppliedEffects: cloneValue(weatherState && weatherState.appliedEffectKeys) || [],
  weatherSkippedEffects: cloneValue(weatherState && weatherState.skippedEffectKeys) || [],
  tier: toInt(weatherState && weatherState.tier, toInt(contentProfile && contentProfile.tier, 1)),
});
  logResolvedAbyssalWeather(contentProfile, {
  characterID: context.characterID,
  traceItemID: traceState.traceItemID,
  instanceID: 0,
  weatherState,
});
  const pocketResult = createOrResolvePlaceholderPocket(validation, deps);
  if (!pocketResult.success) {
  const rollbackResult = rollbackPendingAbyssalTraceActivation(
    pendingTraceActivation || {
      ...traceState,
      traceState,
      session,
      automatic: automaticActivation,
      runID: 0,
    },
    deps,
    normalizeText(pocketResult.errorMsg, "POCKET_CREATE_FAILED"),
  );
  recordAuditEvent("abyssal_entrance_gate_activation_pocket_failed", args, session, {
    traceItemID: traceState.traceItemID,
    errorMsg: pocketResult.errorMsg,
    rollbackSuccess: rollbackResult && rollbackResult.success === true,
    refunded: rollbackResult && rollbackResult.filamentCompensationResult &&
      rollbackResult.filamentCompensationResult.refunded === true,
  });
  log.warn(
    `[AbyssalMgr] Abyssal pocket creation failed char=${context.characterID} ` +
      `trace=${traceState.traceItemID} system=${context.systemID} ` +
      `reason=${pocketResult.errorMsg} ` +
      `rollback=${rollbackResult && rollbackResult.success === true ? "complete" : "failed-closed"}`,
  );
  throwAbyssError([[ABYSS_ERROR.POCKET_CREATE_FAILED, []]]);
}
  return { ...request, contentProfile, pocketResult };
}

function prepareEntranceRun(ports, request) {
  const {
    buildPlaceholderRoomState,
    recordAuditEvent,
    log,
    setAbyssalSessionState,
    schedulePlaceholderPocketMaintenance,
    completePendingAbyssalTraceActivation,
    getPendingAbyssalTransitionState,
  } = ports;
  const { args, session, deps, validation, context, traceState, pendingTraceActivation, pocketResult } = request;
  let pocketState = pocketResult.data;
  if (pendingTraceActivation) {
  pendingTraceActivation.runID = toInt(pocketState.instanceID, 0);
}
  const roomState = buildPlaceholderRoomState(pocketState);
  recordAuditEvent("abyssal_placeholder_room_mode_active", args, session, {
  traceItemID: traceState.traceItemID,
  instanceID: pocketState.instanceID,
  implementedRooms: toInt(roomState.implementedRooms, 1),
  retailTargetRooms: toInt(roomState.retailTargetRooms, 3),
  currentRoomIndex: toInt(roomState.currentRoomIndex, 1),
});
  log.info(
  `[AbyssalMgr] Abyssal room progression active char=${context.characterID} ` +
    `trace=${traceState.traceItemID} instance=${pocketState.instanceID} ` +
    `implementedRooms=${toInt(roomState.implementedRooms, 1)} ` +
    `retailTargetRooms=${toInt(roomState.retailTargetRooms, 3)} ` +
    `currentRoomIndex=${toInt(roomState.currentRoomIndex, 1)}`,
);
  recordAuditEvent("abyssal_entrance_gate_activation_pocket_ready", args, session, {
  traceItemID: traceState.traceItemID,
  instanceID: pocketState.instanceID,
  templateID: pocketState.templateID,
  created: pocketResult.created === true,
});
  log.info(
  `[AbyssalMgr] Abyssal pocket ${pocketResult.created ? "created" : "resolved"} char=${context.characterID} trace=${traceState.traceItemID} instance=${pocketState.instanceID} template=${pocketState.templateID}`,
);
  if (toInt(session && session.abyssalInstanceID, 0) === toInt(pocketState.instanceID, 0)) {
  setAbyssalSessionState(session, pocketState, traceState.traceItemID);
  schedulePlaceholderPocketMaintenance(deps);
  completePendingAbyssalTraceActivation(traceState.traceItemID, deps, {
    runID: pocketState.instanceID,
    reason: "SESSION_ALREADY_IN_RUN",
  });
  log.info(
    `[AbyssalMgr] Duplicate activation ignored char=${context.characterID} instance=${pocketState.instanceID} trace=${traceState.traceItemID} reason=SESSION_ALREADY_IN_RUN`,
  );
  return null;
}
  const pendingTransitionState = getPendingAbyssalTransitionState(pocketState);
  if (pendingTransitionState && pendingTransitionState.status === "pending") {
  schedulePlaceholderPocketMaintenance(deps);
  log.info(
    `[AbyssalMgr] Duplicate activation ignored char=${context.characterID} instance=${pocketState.instanceID} trace=${traceState.traceItemID} reason=PENDING_TRANSITION`,
  );
  return null;
}
  return { ...request, pocketState };
}

function prewarmEntranceRequest(ports, request) {
  const {
    resolveAbyssalTraceTransitionPresentation,
    transitionSourceTraceState,
    ABYSSAL_TRACE_LIFECYCLE_PHASE,
    rollbackPendingAbyssalTraceActivation,
    throwAbyssError,
    ABYSS_ERROR,
    prewarmCurrentPlaceholderRoomContent,
    getContentProfile,
    resolveAbyssalEnvironmentRoomProfileForPocket,
    buildAbyssalSceneDescriptor,
    resolveTransitionProfileSetForLayout,
  } = ports;
  const { args, session, deps, validation, context, traceState, automaticActivation, pendingTraceActivation } = request;
  let { pocketState } = request;
  if (!resolveAbyssalTraceTransitionPresentation(traceState)) {
  const activeTraceResult = transitionSourceTraceState(
    traceState,
    ABYSSAL_TRACE_LIFECYCLE_PHASE.ACTIVE,
    deps,
    {
      abyssalRunID: toInt(pocketState && pocketState.instanceID, 0),
      broadcast: true,
    },
  );
  if (!activeTraceResult || activeTraceResult.success !== true) {
    rollbackPendingAbyssalTraceActivation(
      pendingTraceActivation || {
        ...traceState,
        traceState,
        automatic: automaticActivation,
        runID: toInt(pocketState && pocketState.instanceID, 0),
      },
      deps,
      normalizeText(
        activeTraceResult && activeTraceResult.errorMsg,
        "TRACE_STATE_PERSIST_FAILED",
      ),
    );
    throwAbyssError([[ABYSS_ERROR.POCKET_MOVE_FAILED, []]]);
  }
}
  const prewarmEntryResult = prewarmCurrentPlaceholderRoomContent(
  validation,
  pocketState,
  session,
  deps,
);
  if (prewarmEntryResult && prewarmEntryResult.data) {
  pocketState = prewarmEntryResult.data;
}
  const entryContentProfile = getContentProfile(pocketState) || {};
  const entryEnvironmentProfile =
  resolveAbyssalEnvironmentRoomProfileForPocket(pocketState, 1);
  const entrySceneDescriptor = buildAbyssalSceneDescriptor(pocketState, deps);
  const authoritativeEntryTransition = Boolean(
  resolveTransitionProfileSetForLayout(
    normalizeText(pocketState && pocketState.selectedLayoutSetID, ""),
  ),
);
  const entryHandoffIdentity = {
  instanceID: toInt(pocketState.instanceID, 0),
  traceItemID: toInt(traceState.traceItemID, 0),
  traceTypeID: toInt(traceState.typeID, 0),
  filamentTypeID: toInt(traceState.filamentTypeID, 0),
  deploymentToken: normalizeText(traceState.deploymentToken, ""),
  characterID: toInt(context.characterID, 0),
  shipID: toInt(context.shipID, 0),
  systemID: toInt(context.systemID, 0),
  sceneKind: "solarSystem",
  sceneKey: normalizeText(
    traceState.sourceSceneKey,
    `solar-system:${toInt(context.systemID, 0)}`,
  ),
};
  return { ...request, pocketState, entryEnvironmentProfile, entrySceneDescriptor, authoritativeEntryTransition, entryHandoffIdentity };
}

function scheduleEntranceRequest(ports, request) {
  const {
    schedulePendingAbyssalTransition,
    resolveAbyssalClientDungeonIdentifier,
    revalidateDelayedAbyssalEntryHandoff,
    rollbackPendingAbyssalTraceActivation,
  } = ports;
  const { args, session, deps, validation, context, traceState, automaticActivation, pendingTraceActivation, pocketState, entryEnvironmentProfile, entrySceneDescriptor, authoritativeEntryTransition, entryHandoffIdentity } = request;
  // Shared with the failure hook below: a deferred handoff fails after this
  // request has returned, so the hook schedules the retry itself, and the
  // immediate path must not schedule a second one.
  const activationRetryState = { scheduled: false };
  const retryRequest = { ...request, activationRetryState };
  const entryTransitionResult = schedulePendingAbyssalTransition(
  pocketState,
  session,
  deps,
  {
    phase: "entry",
    activationMode: "entry",
    sourceRoomIndex: 0,
    targetRoomIndex: 1,
    transitionFxOptions: {
      targetID: traceState.traceItemID,
      destinationLocationID: toInt(
        entrySceneDescriptor && entrySceneDescriptor.locationID,
        pocketState.solarSystemID,
      ),
      destinationGraphicID: authoritativeEntryTransition
        ? toInt(entryEnvironmentProfile && entryEnvironmentProfile.nebulaGraphicID, 0)
        : 0,
      dungeonIdentifier: resolveAbyssalClientDungeonIdentifier(pocketState),
    },
    revalidateTransition: (activePocketState) =>
      revalidateDelayedAbyssalEntryHandoff(
        args,
        session,
        activePocketState,
        entryHandoffIdentity,
        deps,
      ),
    onTransitionFailure: (_activePocketState, failure) => {
      const failureReason = normalizeText(
        failure && failure.errorMsg,
        "ENTRY_TRACE_ACTIVATION_FAILED",
      );
      if (
        !(failure && failure.failureStage === "revalidation") &&
        canRetryEntryActivation(ports, retryRequest, failureReason)
      ) {
        scheduleEntryActivationRetry(ports, retryRequest, failureReason);
        return;
      }
      rollbackPendingAbyssalTraceActivation(
        pendingTraceActivation || {
          ...traceState,
          traceState,
          automatic: automaticActivation,
          runID: toInt(pocketState && pocketState.instanceID, 0),
        },
        deps,
        failure && failure.failureStage === "revalidation"
          ? `PLAYER_WORLD_INVALIDATION:${failureReason}`
          : failureReason,
      );
    },
    executeTransition: (activePocketState, handoffValidation) =>
      ports.finishEntranceTransition(request, activePocketState, handoffValidation),
  },
);
  return { ...retryRequest, entryTransitionResult };
}

function finishEntranceRequest(ports, request) {
  const {
    rollbackPendingAbyssalTraceActivation,
    throwAbyssError,
    ABYSS_ERROR,
    updatePendingAbyssalTraceActivation,
    schedulePlaceholderPocketMaintenance,
  } = ports;
  const { args, session, deps, validation, context, traceState, automaticActivation, pendingTraceActivation, pocketState, entryTransitionResult, activationRetryState } = request;
  if (!entryTransitionResult || entryTransitionResult.success !== true) {
  if (activationRetryState && activationRetryState.scheduled === true) {
    return null;
  }
  const failureReason = normalizeText(
    entryTransitionResult && entryTransitionResult.errorMsg,
    "ENTRY_TRACE_ACTIVATION_FAILED",
  );
  if (canRetryEntryActivation(ports, request, failureReason)) {
    return scheduleEntryActivationRetry(ports, request, failureReason);
  }
  rollbackPendingAbyssalTraceActivation(
    pendingTraceActivation || {
      ...traceState,
      traceState,
      automatic: automaticActivation,
      runID: toInt(pocketState && pocketState.instanceID, 0),
    },
    deps,
    normalizeText(
      entryTransitionResult && entryTransitionResult.errorMsg,
      "ENTRY_TRACE_ACTIVATION_FAILED",
    ),
  );
  throwAbyssError([[ABYSS_ERROR.POCKET_MOVE_FAILED, []]]);
}
  const activationBundleSent = Boolean(
  entryTransitionResult &&
  entryTransitionResult.transitionFxResult &&
  entryTransitionResult.transitionFxResult.fxSent === true
);
  const activationRuntimeData =
  entryTransitionResult &&
  entryTransitionResult.transitionFxResult &&
  entryTransitionResult.transitionFxResult.runtimeResult &&
  entryTransitionResult.transitionFxResult.runtimeResult.data ||
  {};
  const activationPresentationSent = Boolean(
  activationRuntimeData.slimUpdateSent === true &&
  activationRuntimeData.controllerEventSent === true &&
  activationRuntimeData.departureEffectSent === true
);
  updatePendingAbyssalTraceActivation(traceState.traceItemID, "activation-bundle-sent", {
  runID: pocketState.instanceID,
  publicationStamp: toInt(
    activationRuntimeData.initialPublicationStamp,
    toInt(activationRuntimeData.publicationStamp, 0),
  ),
  activationStamp: toInt(activationRuntimeData.activationStamp, 0),
  controllerEventStamp: toInt(activationRuntimeData.controllerEventStamp, 0),
  departureEffectStamp: toInt(activationRuntimeData.departureEffectStamp, 0),
  activationAt: toInt(activationRuntimeData.activationAt, 0),
  transitionDelayMs: toInt(
    entryTransitionResult &&
      entryTransitionResult.transitionFxResult &&
      entryTransitionResult.transitionFxResult.durationMs,
    0,
  ),
  slimUpdateSent: activationRuntimeData.slimUpdateSent === true,
  controllerEventSent: activationRuntimeData.controllerEventSent === true,
  departureEffectSent: activationRuntimeData.departureEffectSent === true,
  status: activationBundleSent && activationPresentationSent ? "complete" : "degraded",
  reason: activationBundleSent && activationPresentationSent
    ? "PROFILE_DRIVEN_BUNDLE_SENT"
    : normalizeText(
        entryTransitionResult &&
          entryTransitionResult.transitionFxResult &&
          entryTransitionResult.transitionFxResult.fxStatus &&
          entryTransitionResult.transitionFxResult.fxStatus.entrySendStatus,
        "OPTIONAL_PRESENTATION_UNAVAILABLE",
      ),
});
  updatePendingAbyssalTraceActivation(traceState.traceItemID, "entry-transition-started", {
  runID: pocketState.instanceID,
  status: entryTransitionResult.deferred === true ? "scheduled" : "complete",
  reason: entryTransitionResult.deferred === true
    ? "AUTHORITATIVE_TRANSITION_DELAY"
    : "IMMEDIATE_TRANSITION",
});
  schedulePlaceholderPocketMaintenance(deps);
  if (entryTransitionResult.deferred === true) {
  return null;
}
  if (!(entryTransitionResult.executeResult && entryTransitionResult.executeResult.success)) {
  const irreversibleEntryRecovery = Boolean(
    entryTransitionResult.executeResult &&
    entryTransitionResult.executeResult.sourceCommitIrreversible === true
  );
  if (irreversibleEntryRecovery) {
    updatePendingAbyssalTraceActivation(
      traceState.traceItemID,
      "entry-recovery-pending",
      {
        runID: pocketState.instanceID,
        status: "paused",
        reason: normalizeText(
          entryTransitionResult.executeResult.errorMsg,
          "ENTRY_COMMITTED_MOVE_ROLLBACK_FAILED",
        ),
      },
    );
  } else if (pendingTraceActivation) {
    rollbackPendingAbyssalTraceActivation(
      pendingTraceActivation,
      deps,
      entryTransitionResult.executeResult &&
        entryTransitionResult.executeResult.errorMsg ||
        "ENTRY_TRANSITION_FAILED",
    );
  }
  throwAbyssError([[ABYSS_ERROR.POCKET_MOVE_FAILED, []]]);
}
  return null;
}

function handleAbyssalEntranceGateActivation(ports, args, session, automaticTraceActivationTraceID) {
  const validated = validateEntranceRequest(ports, args, session, automaticTraceActivationTraceID);
  if (!validated) return null;
  const claimed = claimEntranceRequest(ports, validated);
  if (!claimed) return null;
  const prepared = prepareEntranceRun(ports, resolveEntranceRequest(ports, claimed));
  if (!prepared) return null;
  return finishEntranceRequest(ports, scheduleEntranceRequest(ports, prewarmEntranceRequest(ports, prepared)));
}

function createAbyssalEntranceRequest(ports) {
  return { handleAbyssalEntranceGateActivation: handleAbyssalEntranceGateActivation.bind(null, ports) };
}

module.exports = { createAbyssalEntranceRequest };
