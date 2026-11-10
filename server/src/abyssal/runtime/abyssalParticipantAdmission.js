"use strict";

const { normalizeText } = require("../domain/abyssalValueUtils");

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

// Joining an existing run retains its durable roster claim and exact delayed
// admission token. Scheduling ownership stays in the injected pending-work registry.
function resolveAbyssalParticipantAdmissionState({
  buildPlaceholderRoomState,
  getPendingAbyssalTransitionState,
  normalizeLowerText,
  getPlaceholderRoomEntry,
}, pocketState) {
  const roomState = buildPlaceholderRoomState(pocketState || {});
  const pendingTransitionState = getPendingAbyssalTransitionState(pocketState);
  const roomProgressionPending = Boolean(
    pendingTransitionState &&
      pendingTransitionState.status === "pending" &&
      ["transfer", "exit"].includes(
        normalizeLowerText(pendingTransitionState.phase, ""),
      )
  );
  return {
    closed: roomState.currentRoomIndex !== 1 || roomProgressionPending,
    currentRoomIndex: roomState.currentRoomIndex,
    objectiveComplete:
      getPlaceholderRoomEntry(pocketState || {}, 1).objectiveComplete === true,
    roomProgressionPending,
    pendingTransitionPhase: normalizeLowerText(
      pendingTransitionState && pendingTransitionState.phase,
      "",
    ),
  };
}

function persistAbyssalParticipantAdmission({
  upsertAbyssalParticipantRosterEntry,
  cloneValue,
  ABYSSAL_PARTICIPANT_STATUS,
  commitPocketStateDurably,
  ABYSSAL_PARTICIPANT_ROSTER_SCHEMA_VERSION,
}, context) {
  const { admission, existingParticipant, deps } = context;
  let { pocketState } = context;
  const admissionStartedAtMs = toInt(deps.now(), Date.now());
  const admittingRoster = upsertAbyssalParticipantRosterEntry(pocketState, {
    ...cloneValue(admission),
    status: ABYSSAL_PARTICIPANT_STATUS.ADMITTING,
    admittedAtMs: toInt(existingParticipant && existingParticipant.admittedAtMs, 0) ||
      admissionStartedAtMs,
    lastSeenAtMs: admissionStartedAtMs,
  });
  const admissionCommit = commitPocketStateDurably(
    pocketState.instanceID,
    {
      participantRosterSchemaVersion: ABYSSAL_PARTICIPANT_ROSTER_SCHEMA_VERSION,
      participantRoster: admittingRoster,
    },
    deps,
    { verifyReadBack: true, forceWrite: true },
  );
  if (!admissionCommit || admissionCommit.success !== true) {
    return {
      success: false,
      errorMsg: normalizeText(
        admissionCommit && admissionCommit.errorMsg,
        "ABYSSAL_PARTICIPANT_ADMISSION_PERSIST_FAILED",
      ),
    };
  }
  pocketState = cloneValue(admissionCommit.committedState || admissionCommit.state);
  context.pocketState = pocketState;
  return { success: true };
}

function prepareAbyssalParticipantAdmissionFx({
  buildAbyssalSceneDescriptor,
  resolveAbyssalEnvironmentRoomProfileForPocket,
  resolveTransitionProfileSetForLayout,
  maybeSendAbyssalTransitionFx,
  resolveAbyssalClientDungeonIdentifier,
}, context) {
  const { validation, session, deps } = context;
  let { pocketState } = context;
  const entrySceneDescriptor = buildAbyssalSceneDescriptor(pocketState, deps);
  const entryEnvironmentProfile =
    resolveAbyssalEnvironmentRoomProfileForPocket(pocketState, 1);
  const authoritativeEntryTransition = Boolean(
    resolveTransitionProfileSetForLayout(
      normalizeText(pocketState && pocketState.selectedLayoutSetID, ""),
    ),
  );
  const transitionFxResult = maybeSendAbyssalTransitionFx(
    pocketState,
    session,
    "entry",
    deps,
    {
      targetID: toInt(validation.data.traceState && validation.data.traceState.traceItemID, 0),
      destinationLocationID: authoritativeEntryTransition
        ? toInt(entrySceneDescriptor && entrySceneDescriptor.locationID, pocketState.solarSystemID)
        : pocketState.solarSystemID,
      destinationGraphicID: authoritativeEntryTransition
        ? toInt(entryEnvironmentProfile && entryEnvironmentProfile.nebulaGraphicID, 0)
        : 0,
      dungeonIdentifier: resolveAbyssalClientDungeonIdentifier(pocketState),
      targetedEntryFxOnly: true,
    },
  );
  pocketState = transitionFxResult && transitionFxResult.pocketState
    ? transitionFxResult.pocketState
    : pocketState;
  const transitionDurationMs = transitionFxResult && (
    transitionFxResult.fxSent === true || transitionFxResult.authoritative === true
  )
    ? toInt(transitionFxResult.durationMs, 0)
    : 0;
  context.pocketState = pocketState;
  context.transitionFxResult = transitionFxResult;
  context.transitionDurationMs = transitionDurationMs;
}

function moveAbyssalAdmittingParticipant({
  normalizeAbyssalParticipantRoster,
  cloneValue,
  getObjectPosition,
  addVectors,
  moveShipIntoPlaceholderPocket,
  upsertAbyssalParticipantRosterEntry,
  getActivePocketStateByInstanceID,
  ABYSSAL_PARTICIPANT_STATUS,
  commitPocketStateDurably,
}, { pocketState, characterID, admission, validation, session, deps }) {
  const ordinal = Math.max(
    1,
    normalizeAbyssalParticipantRoster(pocketState).findIndex(
      (participant) => participant.characterID === characterID,
    ),
  );
  const baseSpawnState = cloneValue(pocketState.shipSpawnState || {});
  const basePosition = getObjectPosition(baseSpawnState) ||
    getObjectPosition(pocketState.pocketPosition) || { x: 0, y: 0, z: 0 };
  const participantShipSpawnState = {
    ...baseSpawnState,
    position: addVectors(basePosition, { x: 0, y: ordinal * 1_500, z: 0 }),
  };
  participantShipSpawnState.targetPoint = cloneValue(participantShipSpawnState.position);
  const moveValidation = {
    ...validation,
    data: {
      ...validation.data,
      pocketState,
      participantShipSpawnState,
    },
  };
  const moveResult = moveShipIntoPlaceholderPocket(
    moveValidation,
    pocketState,
    session,
    deps,
  );
  if (!moveResult || moveResult.success !== true) {
    const failedRoster = upsertAbyssalParticipantRosterEntry(
      getActivePocketStateByInstanceID(pocketState.instanceID) || pocketState,
      {
        ...cloneValue(admission),
        status: ABYSSAL_PARTICIPANT_STATUS.ADMISSION_FAILED,
        lastSeenAtMs: toInt(deps.now(), Date.now()),
      },
    );
    commitPocketStateDurably(
      pocketState.instanceID,
      { participantRoster: failedRoster },
      deps,
      { verifyReadBack: true, forceWrite: true },
    );
    return { failureResult: moveResult || {
      success: false,
      errorMsg: "ABYSSAL_PARTICIPANT_MOVE_FAILED",
    } };
  }
  return { moveResult };
}

function completeAbyssalParticipantAdmission({
  moveAbyssalAdmittingParticipant,
  getActivePocketStateByInstanceID,
  persistTraceState,
  ABYSSAL_PARTICIPANT_ROSTER_SCHEMA_VERSION,
  cloneValue,
  log,
  broadcastAbyssalRoomBootstrapAddBalls,
  queueAbyssalFreshEntryBootstrap,
  applyAbyssalWeatherToRun,
  usesAuthoredAbyssalEnvironmentNotification,
  queueAbyssalClientEnvironmentDelivery,
  sendAbyssalExpiryDurationNotification,
  sendOrQueueInitialAbyssalArrivalFx,
  deliverSuppressorPresentationForSession,
  schedulePlaceholderPocketMaintenance,
  normalizeAbyssalParticipantRoster,
}, context) {
  const { characterID, shipID, validation, session, deps, roomState, transitionFxResult } = context;
  const movement = moveAbyssalAdmittingParticipant(context);
  if (movement.failureResult) return movement.failureResult;
  const { moveResult } = movement;
  let { pocketState } = context;
  pocketState = getActivePocketStateByInstanceID(pocketState.instanceID) || pocketState;
  context.pocketState = pocketState;
  const traceState = validation.data.traceState;
  const tracePersistResult = persistTraceState({
    ...traceState,
    participantRosterSchemaVersion: ABYSSAL_PARTICIPANT_ROSTER_SCHEMA_VERSION,
    participantRoster: cloneValue(pocketState.participantRoster),
  }, deps);
  if (!tracePersistResult || tracePersistResult.success !== true) {
    log.warn(
      `[AbyssalRoster] trace roster mirror persist failed ` +
        `character=${characterID} ship=${shipID} run=${pocketState.instanceID} ` +
        `trace=${toInt(traceState && traceState.traceItemID, 0)}`,
    );
  }

  const bootstrapResult = broadcastAbyssalRoomBootstrapAddBalls(
    pocketState,
    session,
    deps,
    "participant-admission",
  );
  queueAbyssalFreshEntryBootstrap(pocketState, session, deps);
  const weatherResult = applyAbyssalWeatherToRun(pocketState, session, deps, {
    reason: "participant-admission",
    applyNpcWeather: false,
  });
  if (usesAuthoredAbyssalEnvironmentNotification(pocketState, session, deps)) {
    queueAbyssalClientEnvironmentDelivery(pocketState, session, deps, {
      phase: "entry",
      activateNpcControllers: false,
    });
  } else {
    sendAbyssalExpiryDurationNotification(session, pocketState, deps, {
      phase: "participant-entry-without-authored-environment",
    });
    sendOrQueueInitialAbyssalArrivalFx(
      pocketState,
      session,
      deps,
      "participant-room-entry",
    );
  }
  deliverSuppressorPresentationForSession(pocketState, session, deps, {
    roomIndex: roomState.currentRoomIndex,
    reason: "participant-admission",
    allowRetry: true,
  });
  schedulePlaceholderPocketMaintenance(deps);
  log.info(
    `[AbyssalRoster] participant admitted character=${characterID} ship=${shipID} ` +
      `run=${pocketState.instanceID} trace=${pocketState.traceItemID} ` +
      `room=${roomState.currentRoomIndex} participants=${normalizeAbyssalParticipantRoster(pocketState).length}`,
  );
  return {
    success: true,
    data: {
      pocketState,
      moveResult,
      bootstrapResult,
      weatherResult,
      transitionFxResult,
    },
  };
}

function completeScheduledAbyssalParticipantAdmission({
  abyssalPendingWorkRegistry,
  getActivePocketStateByInstanceID,
  getAbyssalParticipantRecord,
  ABYSSAL_PARTICIPANT_STATUS,
  validateAbyssalTraceActivation,
  upsertAbyssalParticipantRosterEntry,
  commitPocketStateDurably,
  log,
  completeAbyssalParticipantAdmission,
}, context, admissionToken) {
  const { admissionInstanceID, characterID, shipID, pocketState, validation, session, deps } = context;
  const pendingHandle =
    abyssalPendingWorkRegistry.getParticipantAdmissionHandle(
      admissionInstanceID,
      characterID,
    ) || null;
  if (!pendingHandle || pendingHandle.token !== admissionToken) {
    return;
  }
  abyssalPendingWorkRegistry.deleteParticipantAdmissionHandle(
    admissionInstanceID,
    characterID,
  );
  const latestPocketState = getActivePocketStateByInstanceID(pocketState.instanceID);
  const latestParticipant = getAbyssalParticipantRecord(
    latestPocketState,
    characterID,
  );
  if (
    !latestPocketState ||
    !latestParticipant ||
    latestParticipant.status !== ABYSSAL_PARTICIPANT_STATUS.ADMITTING ||
    latestParticipant.shipID !== shipID
  ) {
    return;
  }
  const refreshedValidation = validateAbyssalTraceActivation(
    [toInt(validation.data.traceState && validation.data.traceState.traceItemID, 0)],
    session,
    deps,
  );
  if (
    !refreshedValidation ||
    refreshedValidation.success !== true ||
    refreshedValidation.data.joinExistingRun !== true ||
    toInt(
      refreshedValidation.data.existingRunState &&
        refreshedValidation.data.existingRunState.instanceID,
      0,
    ) !== toInt(latestPocketState.instanceID, 0)
  ) {
    const failedRoster = upsertAbyssalParticipantRosterEntry(
      latestPocketState,
      {
        ...latestParticipant,
        status: ABYSSAL_PARTICIPANT_STATUS.ADMISSION_FAILED,
        lastSeenAtMs: toInt(deps.now(), Date.now()),
      },
    );
    commitPocketStateDurably(
      latestPocketState.instanceID,
      { participantRoster: failedRoster },
      deps,
      { verifyReadBack: true, forceWrite: true },
    );
    log.warn(
      `[AbyssalRoster] participant admission handoff rejected ` +
        `character=${characterID} ship=${shipID} run=${latestPocketState.instanceID} ` +
        `reason=${normalizeText(
          refreshedValidation && refreshedValidation.error &&
            refreshedValidation.error.details &&
            refreshedValidation.error.details.reason,
          "REVALIDATION_FAILED",
        )}`,
    );
    return;
  }
  context.validation = refreshedValidation;
  context.pocketState = getActivePocketStateByInstanceID(latestPocketState.instanceID) ||
    refreshedValidation.data.existingRunState;
  const completionResult = completeAbyssalParticipantAdmission(context);
  if (!completionResult || completionResult.success !== true) {
    log.warn(
      `[AbyssalRoster] participant admission handoff failed ` +
        `character=${characterID} ship=${shipID} run=${latestPocketState.instanceID} ` +
        `reason=${normalizeText(
          completionResult && completionResult.errorMsg,
          "ADMISSION_COMPLETION_FAILED",
        )}`,
    );
  }
}

function scheduleAbyssalParticipantAdmission({
  abyssalPendingWorkRegistry,
  completeScheduledAbyssalParticipantAdmission,
  upsertAbyssalParticipantRosterEntry,
  cloneValue,
  ABYSSAL_PARTICIPANT_STATUS,
  commitPocketStateDurably,
  log,
}, context) {
  const { admissionInstanceID, characterID, shipID, pocketState, admission, deps, transitionDurationMs, transitionFxResult } = context;
  const admissionToken = abyssalPendingWorkRegistry.allocateParticipantAdmissionToken();
  let admissionHandle = null;
  try {
    admissionHandle = deps.scheduleTimeout(() => completeScheduledAbyssalParticipantAdmission(context, admissionToken), transitionDurationMs);
  } catch (error) {
    admissionHandle = null;
  }
  if (admissionHandle === null || admissionHandle === undefined) {
    const failedRoster = upsertAbyssalParticipantRosterEntry(pocketState, {
      ...cloneValue(admission),
      status: ABYSSAL_PARTICIPANT_STATUS.ADMISSION_FAILED,
      lastSeenAtMs: toInt(deps.now(), Date.now()),
    });
    commitPocketStateDurably(
      pocketState.instanceID,
      { participantRoster: failedRoster },
      deps,
      { verifyReadBack: true, forceWrite: true },
    );
    return {
      success: false,
      errorMsg: "ABYSSAL_PARTICIPANT_ADMISSION_SCHEDULING_FAILED",
    };
  }
  abyssalPendingWorkRegistry.setParticipantAdmissionHandle(
    admissionInstanceID,
    characterID,
    {
      handle: admissionHandle,
      token: admissionToken,
      shipID,
    },
  );
  log.info(
    `[AbyssalRoster] participant admission handoff scheduled ` +
      `character=${characterID} ship=${shipID} run=${pocketState.instanceID} ` +
      `durationMs=${transitionDurationMs} fxSent=${transitionFxResult.fxSent === true}`,
  );
  return {
    success: true,
    deferred: true,
    data: {
      pocketState,
      transitionFxResult,
    },
  };
}

function admitAbyssalParticipantIntoExistingRun({
  getDependencies,
  getActivePocketStateByInstanceID,
  buildPlaceholderRoomState,
  resolveAbyssalParticipantAdmissionState,
  getAbyssalParticipantRecord,
  ABYSSAL_PARTICIPANT_STATUS,
  abyssalPendingWorkRegistry,
  persistAbyssalParticipantAdmission,
  prepareAbyssalParticipantAdmissionFx,
  completeAbyssalParticipantAdmission,
  scheduleAbyssalParticipantAdmission,
},
  validation,
  session,
  deps = getDependencies(),
) {
  const admission = validation && validation.data && validation.data.participantAdmission;
  let pocketState = validation && validation.data && validation.data.existingRunState;
  const characterID = toInt(admission && admission.characterID, 0);
  const shipID = toInt(admission && admission.shipID, 0);
  if (!pocketState || characterID <= 0 || shipID <= 0) {
    return { success: false, errorMsg: "ABYSSAL_PARTICIPANT_ADMISSION_INVALID" };
  }
  pocketState = getActivePocketStateByInstanceID(pocketState.instanceID) || pocketState;
  const roomState = buildPlaceholderRoomState(pocketState);
  if (resolveAbyssalParticipantAdmissionState(pocketState).closed) {
    return { success: false, errorMsg: "ABYSSAL_PARTICIPANT_ADMISSION_CLOSED" };
  }
  const existingParticipant = getAbyssalParticipantRecord(pocketState, characterID);
  if (
    existingParticipant &&
    existingParticipant.status === ABYSSAL_PARTICIPANT_STATUS.ACTIVE &&
    existingParticipant.shipID === shipID &&
    toInt(session && session.abyssalInstanceID, 0) === toInt(pocketState.instanceID, 0)
  ) {
    return { success: true, idempotent: true, data: { pocketState } };
  }
  const admissionInstanceID = toInt(pocketState.instanceID, 0);
  const existingAdmissionHandle =
    abyssalPendingWorkRegistry.getParticipantAdmissionHandle(
      admissionInstanceID,
      characterID,
    ) || null;
  if (
    existingAdmissionHandle &&
    toInt(existingAdmissionHandle.shipID, 0) === shipID
  ) {
    return {
      success: true,
      deferred: true,
      idempotent: true,
      data: { pocketState },
    };
  }
  if (existingAdmissionHandle) {
    try {
      abyssalPendingWorkRegistry.cancelParticipantAdmissionHandle(
        admissionInstanceID, characterID, deps && deps.clearScheduledTimeout,
      );
    } catch (error) {
      return {
        success: false, errorMsg: "ABYSSAL_PARTICIPANT_ADMISSION_CANCELLATION_FAILED",
      };
    }
  }

  const context = {
    admission, pocketState, characterID, shipID, roomState, existingParticipant,
    admissionInstanceID, validation, session, deps,
  };
  const claimResult = persistAbyssalParticipantAdmission(context);
  if (!claimResult.success) return claimResult;
  prepareAbyssalParticipantAdmissionFx(context);
  return context.transitionDurationMs <= 0
    ? completeAbyssalParticipantAdmission(context)
    : scheduleAbyssalParticipantAdmission(context);
}

// Capture supplied capabilities once, as the original closure did. Internal
// callbacks are bound once per instance; no runtime state lives in this wiring.
function createAbyssalParticipantAdmission({
  buildPlaceholderRoomState,
  getPendingAbyssalTransitionState,
  normalizeLowerText,
  getPlaceholderRoomEntry,
  upsertAbyssalParticipantRosterEntry,
  cloneValue,
  ABYSSAL_PARTICIPANT_STATUS,
  commitPocketStateDurably,
  ABYSSAL_PARTICIPANT_ROSTER_SCHEMA_VERSION,
  buildAbyssalSceneDescriptor,
  resolveAbyssalEnvironmentRoomProfileForPocket,
  resolveTransitionProfileSetForLayout,
  maybeSendAbyssalTransitionFx,
  resolveAbyssalClientDungeonIdentifier,
  normalizeAbyssalParticipantRoster,
  getObjectPosition,
  addVectors,
  moveShipIntoPlaceholderPocket,
  getActivePocketStateByInstanceID,
  persistTraceState,
  log,
  broadcastAbyssalRoomBootstrapAddBalls,
  queueAbyssalFreshEntryBootstrap,
  applyAbyssalWeatherToRun,
  usesAuthoredAbyssalEnvironmentNotification,
  queueAbyssalClientEnvironmentDelivery,
  sendAbyssalExpiryDurationNotification,
  sendOrQueueInitialAbyssalArrivalFx,
  deliverSuppressorPresentationForSession,
  schedulePlaceholderPocketMaintenance,
  abyssalPendingWorkRegistry,
  getAbyssalParticipantRecord,
  validateAbyssalTraceActivation,
  getDependencies,
}) {

  const ports = {
    buildPlaceholderRoomState,
    getPendingAbyssalTransitionState,
    normalizeLowerText,
    getPlaceholderRoomEntry,
    upsertAbyssalParticipantRosterEntry,
    cloneValue,
    ABYSSAL_PARTICIPANT_STATUS,
    commitPocketStateDurably,
    ABYSSAL_PARTICIPANT_ROSTER_SCHEMA_VERSION,
    buildAbyssalSceneDescriptor,
    resolveAbyssalEnvironmentRoomProfileForPocket,
    resolveTransitionProfileSetForLayout,
    maybeSendAbyssalTransitionFx,
    resolveAbyssalClientDungeonIdentifier,
    normalizeAbyssalParticipantRoster,
    getObjectPosition,
    addVectors,
    moveShipIntoPlaceholderPocket,
    getActivePocketStateByInstanceID,
    persistTraceState,
    log,
    broadcastAbyssalRoomBootstrapAddBalls,
    queueAbyssalFreshEntryBootstrap,
    applyAbyssalWeatherToRun,
    usesAuthoredAbyssalEnvironmentNotification,
    queueAbyssalClientEnvironmentDelivery,
    sendAbyssalExpiryDurationNotification,
    sendOrQueueInitialAbyssalArrivalFx,
    deliverSuppressorPresentationForSession,
    schedulePlaceholderPocketMaintenance,
    abyssalPendingWorkRegistry,
    getAbyssalParticipantRecord,
    validateAbyssalTraceActivation,
    getDependencies,
  };
  ports.resolveAbyssalParticipantAdmissionState = resolveAbyssalParticipantAdmissionState.bind(null, ports);
  ports.persistAbyssalParticipantAdmission = persistAbyssalParticipantAdmission.bind(null, ports);
  ports.prepareAbyssalParticipantAdmissionFx = prepareAbyssalParticipantAdmissionFx.bind(null, ports);
  ports.moveAbyssalAdmittingParticipant = moveAbyssalAdmittingParticipant.bind(null, ports);
  ports.completeAbyssalParticipantAdmission = completeAbyssalParticipantAdmission.bind(null, ports);
  ports.completeScheduledAbyssalParticipantAdmission = completeScheduledAbyssalParticipantAdmission.bind(null, ports);
  ports.scheduleAbyssalParticipantAdmission = scheduleAbyssalParticipantAdmission.bind(null, ports);
  ports.admitAbyssalParticipantIntoExistingRun = admitAbyssalParticipantIntoExistingRun.bind(null, ports);
  Object.freeze(ports);
  return { resolveAbyssalParticipantAdmissionState: ports.resolveAbyssalParticipantAdmissionState, admitAbyssalParticipantIntoExistingRun: ports.admitAbyssalParticipantIntoExistingRun };
}

module.exports = { createAbyssalParticipantAdmission };
