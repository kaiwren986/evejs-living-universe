"use strict";

const { normalizeText } = require("../domain/abyssalValueUtils");

// State and side effects remain owned by the injected run, trace and engine ports.
function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function buildAbyssalTransitionFxProfile(ports, pocketState = null, deps = ports.getDependencies()) {
  const {
    getContentProfile, resolveAbyssalTraceProfile, resolveAbyssalTraceTransitionPresentation,
    resolveTransitionProfileSetForLayout, TRANSITION_POLICY_EXPERIMENTAL,
    TRANSITION_POLICY_AUTHORITATIVE_CAPTURED, resolveTransitionProfile,
    ABYSSAL_TRANSITION_FX_PROFILE, resolveAbyssalCalmDarkProbeEffect,
    isAbyssalVisualFxContentProfile, ABYSSAL_SHIP_HIDE_SUPPORT,
  } = ports;
  const contentProfile = pocketState ? getContentProfile(pocketState) || {} : {};
  const entranceTraceProfile = resolveAbyssalTraceProfile({
    filamentTypeID: toInt(contentProfile.filamentTypeID, 0),
    contentProfile,
  });
  const entranceTransitionPresentation =
    resolveAbyssalTraceTransitionPresentation(entranceTraceProfile);
  const transitionProfileSet = resolveTransitionProfileSetForLayout(
    normalizeText(pocketState && pocketState.selectedLayoutSetID, ""),
  );
  const transitionPolicy = normalizeText(
    transitionProfileSet && transitionProfileSet.transitionPolicy,
    TRANSITION_POLICY_EXPERIMENTAL,
  );
  const authoritative = transitionPolicy === TRANSITION_POLICY_AUTHORITATIVE_CAPTURED;
  const entryTransitionProfile = resolveTransitionProfile(transitionProfileSet, "entry");
  const transferTransitionProfile = resolveTransitionProfile(transitionProfileSet, "room-transfer");
  const exitTransitionProfile = resolveTransitionProfile(transitionProfileSet, "final-exit");
  const entryEffectKey = normalizeText(
    entryTransitionProfile && entryTransitionProfile.departureSpecialFx &&
      entryTransitionProfile.departureSpecialFx[0] &&
      entryTransitionProfile.departureSpecialFx[0].effectKey,
    ABYSSAL_TRANSITION_FX_PROFILE.entryEffectKey,
  );
  const transferEffectKey = normalizeText(
    transferTransitionProfile && transferTransitionProfile.departureSpecialFx &&
      transferTransitionProfile.departureSpecialFx[0] &&
      transferTransitionProfile.departureSpecialFx[0].effectKey,
    ABYSSAL_TRANSITION_FX_PROFILE.transferEffectKey,
  );
  const exitEffectKey = normalizeText(
    exitTransitionProfile && exitTransitionProfile.departureSpecialFx &&
      exitTransitionProfile.departureSpecialFx[0] &&
      exitTransitionProfile.departureSpecialFx[0].effectKey,
    ABYSSAL_TRANSITION_FX_PROFILE.exitEffectKey,
  );
  const arrivalEffectKey = normalizeText(
    entryTransitionProfile && entryTransitionProfile.arrivalSpecialFx &&
      entryTransitionProfile.arrivalSpecialFx[0] &&
      entryTransitionProfile.arrivalSpecialFx[0].effectKey,
    ABYSSAL_TRANSITION_FX_PROFILE.arrivalEffectKey,
  );
  const entryEffect = resolveAbyssalCalmDarkProbeEffect(entryEffectKey);
  const transferEffect = resolveAbyssalCalmDarkProbeEffect(transferEffectKey);
  const exitEffect = resolveAbyssalCalmDarkProbeEffect(exitEffectKey);
  const arrivalEffect = resolveAbyssalCalmDarkProbeEffect(arrivalEffectKey);
  return {
    enabled: true,
    applicable: authoritative || isAbyssalVisualFxContentProfile(contentProfile),
    entranceTraceProfile,
    entranceTransitionPresentation,
    authoritative,
    serverOwnedPolicy: true,
    transitionPolicy,
    evidenceStatus: normalizeText(transitionProfileSet && transitionProfileSet.evidenceStatus, "experimental"),
    profileID: normalizeText(
      transitionProfileSet && transitionProfileSet.profileSetID,
      ABYSSAL_TRANSITION_FX_PROFILE.profileID,
    ),
    transitionProfileSet,
    entryTransitionProfile,
    transferTransitionProfile,
    exitTransitionProfile,
    entryKey: normalizeText(entryEffect && entryEffect.key, entryEffectKey),
    entryGuid: normalizeText(entryEffect && entryEffect.guid, "none"),
    entryEffect: entryEffect || null,
    transferKey: normalizeText(transferEffect && transferEffect.key, transferEffectKey),
    transferGuid: normalizeText(transferEffect && transferEffect.guid, "none"),
    transferEffect: transferEffect || null,
    exitKey: normalizeText(exitEffect && exitEffect.key, exitEffectKey),
    exitGuid: normalizeText(exitEffect && exitEffect.guid, "none"),
    exitEffect: exitEffect || null,
    arrivalKey: normalizeText(arrivalEffect && arrivalEffect.key, arrivalEffectKey),
    arrivalGuid: normalizeText(arrivalEffect && arrivalEffect.guid, "none"),
    arrivalEffect: arrivalEffect || null,
    shipHideSupported: ABYSSAL_SHIP_HIDE_SUPPORT.supported === true,
    shipHideReason: normalizeText(ABYSSAL_SHIP_HIDE_SUPPORT.reason, "none"),
  };
}

function updateAbyssalTransitionFxState(ports, pocketState, nextState = {}) {
  const {
    updatePocketState, cloneValue,
  } = ports;
  const numericInstanceID = toInt(pocketState && pocketState.instanceID, 0);
  if (numericInstanceID <= 0) {
    return pocketState;
  }
  return updatePocketState(numericInstanceID, {
    transitionClientFxState: {
      ...cloneValue(pocketState && pocketState.transitionClientFxState),
      ...cloneValue(nextState),
    },
  }) || pocketState;
}

function getAbyssalParticipantTransitionFxState(ports, pocketState, session) {
  const {
    getCharacterID,
  } = ports;
  const characterID = getCharacterID(session);
  const state =
    pocketState && pocketState.transitionClientFxState &&
    typeof pocketState.transitionClientFxState === "object"
      ? pocketState.transitionClientFxState
      : {};
  const participantStates =
    state.participantStatesByCharacterID &&
    typeof state.participantStatesByCharacterID === "object"
      ? state.participantStatesByCharacterID
      : {};
  const participantState = characterID > 0
    ? participantStates[String(characterID)]
    : null;
  return participantState && typeof participantState === "object"
    ? participantState
    : {};
}

function updateAbyssalParticipantTransitionFxState(ports,
  pocketState,
  session,
  aggregatePatch = {},
  participantPatch = aggregatePatch,
) {
  const {
    cloneValue, getCharacterID, getActivePocketStateByInstanceID,
  } = ports;
  const numericInstanceID = toInt(pocketState && pocketState.instanceID, 0);
  const characterID = getCharacterID(session);
  const currentPocketState =
    getActivePocketStateByInstanceID(numericInstanceID) || pocketState;
  if (numericInstanceID <= 0 || characterID <= 0) {
    return updateAbyssalTransitionFxState(ports, currentPocketState, aggregatePatch);
  }
  const currentState =
    currentPocketState && currentPocketState.transitionClientFxState &&
    typeof currentPocketState.transitionClientFxState === "object"
      ? currentPocketState.transitionClientFxState
      : {};
  const participantStates =
    currentState.participantStatesByCharacterID &&
    typeof currentState.participantStatesByCharacterID === "object"
      ? currentState.participantStatesByCharacterID
      : {};
  const currentParticipantState =
    participantStates[String(characterID)] &&
    typeof participantStates[String(characterID)] === "object"
      ? participantStates[String(characterID)]
      : {};
  return updateAbyssalTransitionFxState(ports, currentPocketState, {
    ...cloneValue(aggregatePatch),
    participantStatesByCharacterID: {
      ...cloneValue(participantStates),
      [String(characterID)]: {
        ...cloneValue(currentParticipantState),
        ...cloneValue(participantPatch),
      },
    },
  });
}

function buildAbyssalTransitionFxStatus(ports, pocketState = null, deps = ports.getDependencies()) {

  const profile = buildAbyssalTransitionFxProfile(ports, pocketState, deps);
  const state =
    pocketState && pocketState.transitionClientFxState &&
    typeof pocketState.transitionClientFxState === "object"
      ? pocketState.transitionClientFxState
      : {};
  const defaultStatus = !pocketState
    ? "NOT_IN_ACTIVE_RUN"
    : profile.applicable !== true
      ? "NOT_APPLICABLE"
      : profile.enabled !== true
        ? "DISABLED"
        : "NOT_YET_ATTEMPTED";
  return {
    ...profile,
    entryStatus: normalizeText(state.entrySendStatus, defaultStatus),
    entryErrorMsg: normalizeText(state.entrySendErrorMsg, "none"),
    entryAttemptedAtMs: toInt(state.entryAttemptedAtMs, 0),
    entrySentAtMs: toInt(state.entrySentAtMs, 0),
    transferStatus: normalizeText(state.transferSendStatus, defaultStatus),
    transferErrorMsg: normalizeText(state.transferSendErrorMsg, "none"),
    transferAttemptedAtMs: toInt(state.transferAttemptedAtMs, 0),
    transferSentAtMs: toInt(state.transferSentAtMs, 0),
    exitStatus: normalizeText(state.exitSendStatus, defaultStatus),
    exitErrorMsg: normalizeText(state.exitSendErrorMsg, "none"),
    exitAttemptedAtMs: toInt(state.exitAttemptedAtMs, 0),
    exitSentAtMs: toInt(state.exitSentAtMs, 0),
  };
}

function resolveAbyssalTransitionDurationMs(ports,
  effect = null,
  phase = "entry",
  transitionProfile = null,
  entranceTransitionPresentation = null,
) {
  const {
    ABYSSAL_TRANSITION_FX_PROFILE, SHARED_ABYSSAL_ENTRANCE_TRANSITION_DELAY_MS,
  } = ports;
  const normalizedPhase = normalizeText(phase, "entry").toLowerCase();
  const entranceTransitionDelayMs = toInt(
    entranceTransitionPresentation && entranceTransitionPresentation.transitionDelayMs,
    0,
  );
  if (normalizedPhase === "entry" && entranceTransitionDelayMs > 0) {
    return entranceTransitionDelayMs;
  }
  const capturedDurationMs = toInt(transitionProfile && transitionProfile.durationMs, 0);
  if (capturedDurationMs > 0) {
    return capturedDurationMs;
  }
  const authoredDurationMs = toInt(effect && effect.start && effect.start.duration, 0);
  if (authoredDurationMs > 0) {
    return authoredDurationMs;
  }
  if (normalizedPhase === "exit") {
    return ABYSSAL_TRANSITION_FX_PROFILE.exitTransitionDelayMs;
  }
  if (normalizedPhase === "transfer") {
    return ABYSSAL_TRANSITION_FX_PROFILE.transferTransitionDelayMs;
  }
  return SHARED_ABYSSAL_ENTRANCE_TRANSITION_DELAY_MS;
}

function resolveAbyssalClientDungeonIdentifier(ports, pocketState) {

  const instanceDungeonID = toInt(
    pocketState && pocketState.instance && pocketState.instance.sourceDungeonID,
    0,
  );
  if (instanceDungeonID > 0) {
    return instanceDungeonID;
  }
  const templateMatch = normalizeText(pocketState && pocketState.templateID, "").match(/(\d+)$/);
  return templateMatch ? toInt(templateMatch[1], 0) : 0;
}

function buildAbyssalTransitionFxOptions(ports, pocketState, options = {}) {

  const phase = normalizeText(options.phase, "entry").toLowerCase();
  const targetID = toInt(options.targetID, 0);
  if (phase === "transfer") {
    const destinationConduitID = toInt(options.destinationConduitID, 0);
    return {
      ...(targetID > 0 ? { targetID } : {}),
      ...(destinationConduitID > 0 ? { chargeTypeID: destinationConduitID } : {}),
      includeStopInSameUpdate: options.includeStopInSameUpdate !== false,
    };
  }
  const destinationLocationID = toInt(
    options.destinationLocationID,
    toInt(pocketState && pocketState.solarSystemID, 0),
  );
  const dungeonIdentifier = options.includeDungeonIdentifier === false
    ? 0
    : toInt(
        options.destinationGraphicID || options.dungeonIdentifier,
        resolveAbyssalClientDungeonIdentifier(ports, pocketState),
      );
  return {
    ...(targetID > 0 ? { targetID } : {}),
    ...(options.includeStopInSameUpdate === true ? { includeStopInSameUpdate: true } : {}),
    ...(
      destinationLocationID > 0
        ? {
          graphicInfo: {
            type: "tuple",
            items: [destinationLocationID, dungeonIdentifier > 0 ? dungeonIdentifier : null],
          },
        }
        : {}
    ),
  };
}

function maybeSendAbyssalArrivalFx(ports,
  pocketState,
  session,
  deps = ports.getDependencies(),
  reason = "arrival",
) {
  const {
    cloneValue, log,
  } = ports;
  const profile = buildAbyssalTransitionFxProfile(ports, pocketState, deps);
  if (profile.enabled !== true || profile.applicable !== true || !profile.arrivalEffect) {
    return {
      success: false,
      skipped: true,
      errorMsg: profile.enabled !== true ? "DISABLED" : "NOT_APPLICABLE",
    };
  }
  const runtime = deps;
  if (!runtime || typeof runtime.playSpecialFx !== "function") {
    return { success: false, errorMsg: "FX_RUNTIME_UNAVAILABLE" };
  }
  const result = runtime.playSpecialFx(session, profile.arrivalGuid, {
    ...cloneValue(profile.arrivalEffect.start),
  });
  log.info(
    `[AbyssalMgr] Abyssal arrival FX instance=${toInt(pocketState && pocketState.instanceID, 0)} ` +
      `guid=${profile.arrivalGuid} reason=${normalizeText(reason, "arrival")} ` +
      `status=${result && result.success ? "SENT" : normalizeText(result && result.errorMsg, "SEND_FAILED")}`,
  );
  return result;
}

function resolveAbyssalTransitionFxParticipants(ports,
  pocketState,
  activatingSession,
  phase,
  deps = ports.getDependencies(),
) {
  const {
    getCharacterID, ABYSSAL_PARTICIPANT_STATUS, normalizeAbyssalParticipantRoster,
    resolveAbyssalRosterParticipantSession,
  } = ports;
  const normalizedPhase = normalizeText(phase, "").toLowerCase();
  const activatingCharacterID = getCharacterID(activatingSession);
  const activatingShipID = toInt(
    activatingSession && activatingSession._space && activatingSession._space.shipID,
    toInt(
      activatingSession && (
        activatingSession.shipID ||
        activatingSession.shipid ||
        activatingSession.activeShipID
      ),
      0,
    ),
  );
  if (normalizedPhase === "entry") {
    const recipients = activatingSession && activatingShipID > 0
      ? [{
          characterID: activatingCharacterID,
          shipID: activatingShipID,
          clientID: toInt(
            activatingSession.clientID || activatingSession.clientId,
            0,
          ),
          session: activatingSession,
        }]
      : [];
    return {
      participantCount: recipients.length,
      eligibleFxRecipientCount: recipients.length,
      recipients,
    };
  }

  const instanceID = toInt(pocketState && pocketState.instanceID, 0);
  const expectedSceneKey = instanceID > 0 ? `abyssal-run:${instanceID}` : "";
  const transitionStatuses = normalizedPhase === "exit"
    ? [
        ABYSSAL_PARTICIPANT_STATUS.ACTIVE,
        ABYSSAL_PARTICIPANT_STATUS.DISCONNECTED,
        ABYSSAL_PARTICIPANT_STATUS.ADMITTING,
        ABYSSAL_PARTICIPANT_STATUS.EXITING,
      ]
    : [
        ABYSSAL_PARTICIPANT_STATUS.ACTIVE,
        ABYSSAL_PARTICIPANT_STATUS.DISCONNECTED,
      ];
  const transitionParticipants = normalizeAbyssalParticipantRoster(pocketState)
    .filter((participant) => transitionStatuses.includes(participant.status));
  const recipients = [];
  for (const participant of transitionParticipants) {
    if (participant.status !== ABYSSAL_PARTICIPANT_STATUS.ACTIVE) {
      continue;
    }
    const participantSession = resolveAbyssalRosterParticipantSession(
      pocketState,
      participant,
      deps,
      participant.characterID === activatingCharacterID
        ? activatingSession
        : null,
    );
    if (!participantSession || participantSession._abyssalOfflineSession === true) {
      continue;
    }
    const sessionSceneKey = normalizeText(
      participantSession.spaceSceneKey ||
        (participantSession._space && participantSession._space.sceneKey),
      "",
    );
    const sessionRunID = toInt(
      participantSession.abyssalInstanceID ||
        participantSession.abyssalRunID ||
        (participantSession._space && (
          participantSession._space.abyssalInstanceID ||
          participantSession._space.abyssalRunID ||
          participantSession._space.instanceID
        )),
      0,
    );
    if (
      instanceID <= 0 ||
      (
        sessionRunID !== instanceID &&
        sessionSceneKey !== expectedSceneKey
      )
    ) {
      continue;
    }
    recipients.push({
      characterID: participant.characterID,
      shipID: participant.shipID,
      clientID: toInt(
        participantSession.clientID || participantSession.clientId,
        0,
      ),
      session: participantSession,
    });
  }
  return {
    participantCount: transitionParticipants.length,
    eligibleFxRecipientCount: recipients.length,
    recipients,
  };
}

function prepareTransitionFxProfile(ports, work) {
  const {
    getContentProfile, resolveAbyssalTraceProfile, resolveAbyssalTraceTransitionPresentation,
    getActiveTraceState,
  } = ports;
  const {
    pocketState, deps, options, normalizedPhase,
  } = work;
  const profile = buildAbyssalTransitionFxProfile(ports, pocketState, deps);
  const sourceTraceState = normalizedPhase === "entry"
    ? getActiveTraceState(toInt(pocketState && pocketState.traceItemID, 0), deps)
    : null;
  const entranceTraceProfile = normalizedPhase === "entry"
    ? resolveAbyssalTraceProfile(
        sourceTraceState || {
          filamentTypeID: toInt(
            pocketState && getContentProfile(pocketState) &&
              getContentProfile(pocketState).filamentTypeID,
            0,
          ),
          contentProfile: getContentProfile(pocketState) || {},
        },
      )
    : null;
  const entranceTransitionPresentation =
    resolveAbyssalTraceTransitionPresentation(entranceTraceProfile);
  const hasProfileDrivenEntryFx = Boolean(
    normalizedPhase === "entry" &&
    sourceTraceState &&
      entranceTraceProfile &&
      entranceTransitionPresentation,
  );
  const usesProfileDrivenTraceActivation = Boolean(
    hasProfileDrivenEntryFx && options.targetedEntryFxOnly !== true,
  );
  const phaseApplicable =
    hasProfileDrivenEntryFx || profile.applicable === true;
  const phaseEnabled =
    hasProfileDrivenEntryFx || profile.enabled === true;
  const phaseFieldPrefix = normalizedPhase === "entry"
    ? "entry"
    : normalizedPhase === "transfer"
      ? "transfer"
      : "exit";
  const attemptedField = `${phaseFieldPrefix}AttemptedAtMs`;
  const sentField = `${phaseFieldPrefix}SentAtMs`;
  const statusField = `${phaseFieldPrefix}SendStatus`;
  const errorField = `${phaseFieldPrefix}SendErrorMsg`;
  Object.assign(work, {
    profile, sourceTraceState, entranceTraceProfile, entranceTransitionPresentation,
    hasProfileDrivenEntryFx, usesProfileDrivenTraceActivation, phaseApplicable, phaseEnabled,
    phaseFieldPrefix, attemptedField, sentField, statusField, errorField,
  });
}

function prepareTransitionFxEffect(ports, work) {
  const {
    resolveAbyssalCalmDarkProbeEffect,
  } = ports;
  const {
    pocketState, session, normalizedPhase, profile, entranceTransitionPresentation,
    hasProfileDrivenEntryFx,
  } = work;
  const profileDrivenEntryEffect = hasProfileDrivenEntryFx
    ? resolveAbyssalCalmDarkProbeEffect(
        entranceTransitionPresentation.departureEffectKey,
      )
    : null;
  const effect = normalizedPhase === "entry"
    ? profileDrivenEntryEffect || profile.entryEffect
    : normalizedPhase === "transfer"
      ? profile.transferEffect
      : profile.exitEffect;
  const effectKey = normalizedPhase === "entry"
    ? normalizeText(
        entranceTransitionPresentation &&
          entranceTransitionPresentation.departureEffectKey,
        profile.entryKey,
      )
    : normalizedPhase === "transfer"
      ? profile.transferKey
      : profile.exitKey;
  const effectGuid = normalizedPhase === "entry"
    ? normalizeText(
        entranceTransitionPresentation &&
          entranceTransitionPresentation.departureEffectGuid,
        profile.entryGuid,
      )
    : normalizedPhase === "transfer"
      ? profile.transferGuid
      : profile.exitGuid;
  const transitionProfile = normalizedPhase === "entry"
    ? profile.entryTransitionProfile
    : normalizedPhase === "transfer"
      ? profile.transferTransitionProfile
      : profile.exitTransitionProfile;
  const transitionType = normalizeText(
    transitionProfile && transitionProfile.transitionType,
    normalizedPhase === "transfer" ? "room-transfer" : normalizedPhase === "exit" ? "final-exit" : "entry",
  );
  const transitionProfileID = normalizeText(
    transitionProfile && transitionProfile.transitionProfileID,
    profile.profileID,
  );
  const departureFxProfile = transitionProfile &&
    Array.isArray(transitionProfile.departureSpecialFx)
      ? transitionProfile.departureSpecialFx[0] || null
      : null;
  const durationMs = resolveAbyssalTransitionDurationMs(ports,
    effect,
    normalizedPhase,
    transitionProfile,
    entranceTransitionPresentation,
  );
  const currentState =
    pocketState && pocketState.transitionClientFxState &&
    typeof pocketState.transitionClientFxState === "object"
      ? pocketState.transitionClientFxState
      : {};
  const participantCurrentState = normalizedPhase === "entry"
    ? getAbyssalParticipantTransitionFxState(ports, pocketState, session)
    : currentState;
  const updateTransitionFxState = (nextState) => normalizedPhase === "entry"
    ? updateAbyssalParticipantTransitionFxState(ports,
        pocketState,
        session,
        nextState,
      )
    : updateAbyssalTransitionFxState(ports, pocketState, nextState);
  Object.assign(work, {
    profileDrivenEntryEffect, effect, effectKey, effectGuid, transitionProfile, transitionType,
    transitionProfileID, departureFxProfile, durationMs, currentState, participantCurrentState,
    updateTransitionFxState,
  });
}

function inspectPreviousTransitionFxAttempt(ports, work) {

  const {
    pocketState, deps, normalizedPhase, profile, attemptedField, statusField, effect, effectKey,
    effectGuid, transitionType, transitionProfileID, durationMs, participantCurrentState,
  } = work;
  if (
    normalizedPhase !== "transfer" &&
    toInt(participantCurrentState[attemptedField], 0) > 0
  ) {
    return {
      pocketState,
      fxStatus: buildAbyssalTransitionFxStatus(ports, pocketState, deps),
      fxSent: normalizeText(participantCurrentState[statusField], "") === "SENT",
      effect,
      effectKey,
      effectGuid,
      durationMs,
      authoritative: profile.authoritative === true,
      transitionPolicy: profile.transitionPolicy,
      transitionType,
      transitionProfileID,
    };
  }
}

function inspectTransitionFxAvailability(ports, work) {

  const {
    pocketState, deps, profile, entranceTraceProfile, usesProfileDrivenTraceActivation,
    phaseApplicable, phaseEnabled, statusField, errorField, effect, effectKey, effectGuid,
    transitionType, transitionProfileID, durationMs, updateTransitionFxState, baseState,
  } = work;
  if (!phaseApplicable) {
    const updatedPocketState = updateTransitionFxState({
      ...baseState,
      [statusField]: "NOT_APPLICABLE",
    });
    return {
      pocketState: updatedPocketState,
      fxStatus: buildAbyssalTransitionFxStatus(ports, updatedPocketState, deps),
      fxSent: false,
      effect,
      effectKey,
      effectGuid,
      durationMs,
      authoritative: profile.authoritative === true,
      transitionPolicy: profile.transitionPolicy,
      transitionType,
      transitionProfileID,
      traceProfileID: normalizeText(entranceTraceProfile && entranceTraceProfile.traceProfileID, ""),
      usesProfileDrivenTraceActivation,
    };
  }
  if (!phaseEnabled) {
    const updatedPocketState = updateTransitionFxState({
      ...baseState,
      [statusField]: "DISABLED",
    });
    return {
      pocketState: updatedPocketState,
      fxStatus: buildAbyssalTransitionFxStatus(ports, updatedPocketState, deps),
      fxSent: false,
      effect,
      effectKey,
      effectGuid,
      durationMs,
      authoritative: profile.authoritative === true,
      transitionPolicy: profile.transitionPolicy,
      transitionType,
      transitionProfileID,
      traceProfileID: normalizeText(entranceTraceProfile && entranceTraceProfile.traceProfileID, ""),
      usesProfileDrivenTraceActivation,
    };
  }
  if (!effect) {
    const updatedPocketState = updateTransitionFxState({
      ...baseState,
      [statusField]: "NO_ALLOWLIST_EFFECT",
      [errorField]: "NO_ALLOWLIST_EFFECT",
    });
    return {
      pocketState: updatedPocketState,
      fxStatus: buildAbyssalTransitionFxStatus(ports, updatedPocketState, deps),
      fxSent: false,
      effect,
      effectKey,
      effectGuid,
      durationMs,
      authoritative: profile.authoritative === true,
      transitionPolicy: profile.transitionPolicy,
      transitionType,
      transitionProfileID,
      traceProfileID: normalizeText(entranceTraceProfile && entranceTraceProfile.traceProfileID, ""),
      usesProfileDrivenTraceActivation,
    };
  }
  const runtime = deps;
  if (
    !runtime ||
    (
      usesProfileDrivenTraceActivation
        ? typeof runtime.activateAbyssalTrace !== "function"
        : typeof runtime.playSpecialFx !== "function"
    )
  ) {
    const updatedPocketState = updateTransitionFxState({
      ...baseState,
      [statusField]: "FX_RUNTIME_UNAVAILABLE",
      [errorField]: "FX_RUNTIME_UNAVAILABLE",
    });
    return {
      pocketState: updatedPocketState,
      fxStatus: buildAbyssalTransitionFxStatus(ports, updatedPocketState, deps),
      fxSent: false,
      effect,
      effectKey,
      effectGuid,
      durationMs,
      authoritative: profile.authoritative === true,
      transitionPolicy: profile.transitionPolicy,
      transitionType,
      transitionProfileID,
      traceProfileID: normalizeText(entranceTraceProfile && entranceTraceProfile.traceProfileID, ""),
      usesProfileDrivenTraceActivation,
    };
  }
}

function sendTraceActivationFx(ports, work) {
  const {
    cloneValue, getCharacterID, log, getAbyssalTracePublicationReceipt, transitionSourceTraceState,
    ABYSSAL_TRACE_LIFECYCLE_PHASE,
  } = ports;
  const {
    pocketState, session, deps, sourceTraceState, entranceTraceProfile,
    entranceTransitionPresentation, effect, effectGuid, fxOptions, fxParticipantSelection,
    fxParticipantResults,
  } = work;
  const runtime = deps;
  let runtimeResult;
    const previousState = toInt(sourceTraceState.activationState, 0);
    const actorPublicationReceipt =
      getAbyssalTracePublicationReceipt(session, sourceTraceState.traceItemID) ||
      sourceTraceState.publicationReceipt;
    const transitionResult = transitionSourceTraceState(
      sourceTraceState,
      ABYSSAL_TRACE_LIFECYCLE_PHASE.ACTIVE,
      deps,
      { abyssalRunID: toInt(pocketState && pocketState.instanceID, 0) },
    );
    const phaseDefinition = entranceTraceProfile.activatingState;
    runtimeResult = transitionResult && transitionResult.success
      ? runtime.activateAbyssalTrace(
          session,
          sourceTraceState.traceItemID,
          transitionResult.state,
          {
            shipID: toInt(
              session && session._space && session._space.shipID,
              toInt(pocketState && pocketState.shipID, 0),
            ),
            effectGuid,
            effectOptions: fxOptions,
            controllerEvent: phaseDefinition.controllerEvent,
            controllerEventArgument: phaseDefinition.controllerEventArgument,
            transitionPresentation: entranceTransitionPresentation,
            publicationReceipt: cloneValue(actorPublicationReceipt),
          },
        )
      : {
          success: false,
          errorMsg: normalizeText(transitionResult && transitionResult.errorMsg, "TRACE_STATE_PERSIST_FAILED"),
        };
    const entryRecipient = fxParticipantSelection.recipients[0] || {
      characterID: getCharacterID(session),
      shipID: toInt(session && session._space && session._space.shipID, 0),
      clientID: toInt(session && (session.clientID || session.clientId), 0),
    };
    fxParticipantResults.push({
      characterID: entryRecipient.characterID,
      shipID: entryRecipient.shipID,
      clientID: entryRecipient.clientID,
      success: Boolean(runtimeResult && runtimeResult.success),
      errorMsg: runtimeResult && runtimeResult.success
        ? "none"
        : normalizeText(runtimeResult && runtimeResult.errorMsg, "SEND_FAILED"),
    });
    log.info(
      `[AbyssalTraceLifecycle] run=${toInt(pocketState && pocketState.instanceID, 0)} ` +
        `trace=${toInt(sourceTraceState.traceItemID, 0)} phase=activating ` +
        `previousState=${previousState} newState=${toInt(transitionResult && transitionResult.state && transitionResult.state.activationState, 1)} ` +
        `publicationStamp=${toInt(runtimeResult && runtimeResult.data && runtimeResult.data.publicationStamp, 0)} ` +
        `activationStamp=${toInt(runtimeResult && runtimeResult.data && runtimeResult.data.activationStamp, 0)} ` +
        `controllerEventStamp=${toInt(runtimeResult && runtimeResult.data && runtimeResult.data.controllerEventStamp, 0)} ` +
        `departureEffectStamp=${toInt(runtimeResult && runtimeResult.data && runtimeResult.data.departureEffectStamp, 0)} ` +
        `stampDelta=${toInt(runtimeResult && runtimeResult.data && runtimeResult.data.stampDelta, 0)} ` +
        `slimUpdateSent=${Boolean(runtimeResult && runtimeResult.data && runtimeResult.data.slimUpdateSent)} ` +
        `controllerEvent=${normalizeText(phaseDefinition.controllerEvent, "none")} ` +
        `controllerEventSent=${Boolean(runtimeResult && runtimeResult.data && runtimeResult.data.controllerEventSent)} ` +
        `effect=${effectGuid} ` +
        `departureEffectSent=${Boolean(runtimeResult && runtimeResult.data && runtimeResult.data.departureEffectSent)} ` +
        `status=${runtimeResult && runtimeResult.success ? "complete" : "failed"}`,
    );

  return runtimeResult;
}

function sendParticipantTransitionFx(ports, work) {
  const {
    cloneValue, getCharacterID,
  } = ports;
  const {
    session, deps, effectGuid, fxOptions, fxParticipantSelection, fxParticipantResults,
  } = work;
  const runtime = deps;
  let runtimeResult;
    for (const recipient of fxParticipantSelection.recipients) {
      const result = runtime.playSpecialFx(
        recipient.session,
        effectGuid,
        fxOptions,
      );
      fxParticipantResults.push({
        characterID: recipient.characterID,
        shipID: recipient.shipID,
        clientID: recipient.clientID,
        success: Boolean(result && result.success),
        errorMsg: result && result.success
          ? "none"
          : normalizeText(result && result.errorMsg, "SEND_FAILED"),
        runtimeResult: result,
      });
    }
    if (fxParticipantResults.length === 1) {
      runtimeResult = fxParticipantResults[0].runtimeResult;
    } else {
      const emittedCount = fxParticipantResults.filter((result) => result.success).length;
      const primaryResult =
        fxParticipantResults.find(
          (result) => result.characterID === getCharacterID(session),
        ) || fxParticipantResults[0] || null;
      const primaryRuntimeResult = primaryResult && primaryResult.runtimeResult;
      runtimeResult = {
        success:
          fxParticipantResults.length > 0 &&
          emittedCount === fxParticipantResults.length,
        errorMsg:
          fxParticipantResults.length === 0
            ? "NO_ELIGIBLE_FX_RECIPIENTS"
            : emittedCount > 0
              ? "PARTIAL_FX_DELIVERY"
              : normalizeText(
                  primaryRuntimeResult && primaryRuntimeResult.errorMsg,
                  "FX_DELIVERY_FAILED",
                ),
        data: {
          ...cloneValue(primaryRuntimeResult && primaryRuntimeResult.data),
          participantResults: fxParticipantResults.map((result) => ({
            characterID: result.characterID,
            shipID: result.shipID,
            clientID: result.clientID,
            success: result.success,
            errorMsg: result.errorMsg,
          })),
        },
      };
    }

  return runtimeResult;
}

function dispatchTransitionFx(ports, work) {
  const {
    cloneValue,
  } = ports;
  const {
    pocketState, session, deps, options, normalizedPhase, usesProfileDrivenTraceActivation, effect,
    departureFxProfile,
  } = work;
  const fxOptions = {
    ...cloneValue(effect.start),
    ...buildAbyssalTransitionFxOptions(ports, pocketState, {
      ...options,
      phase: normalizedPhase,
      includeStopInSameUpdate:
        departureFxProfile
          ? departureFxProfile.includeStopInSameUpdate !== false
          : ["entry", "transfer", "exit"].includes(normalizedPhase),
    }),
  };
  const fxParticipantSelection = resolveAbyssalTransitionFxParticipants(ports,
    pocketState,
    session,
    normalizedPhase,
    deps,
  );
  const fxParticipantResults = [];
  Object.assign(work, { fxOptions, fxParticipantSelection, fxParticipantResults });
  work.runtimeResult = usesProfileDrivenTraceActivation
    ? sendTraceActivationFx(ports, work)
    : sendParticipantTransitionFx(ports, work);
}

function completeTransitionFxDelivery(ports, work) {
  const {
    getCharacterID, log,
  } = ports;
  const {
    pocketState, session, deps, normalizedPhase, profile, entranceTraceProfile,
    usesProfileDrivenTraceActivation, sentField, statusField, errorField, effect, effectKey,
    effectGuid, transitionType, transitionProfileID, durationMs, updateTransitionFxState, baseState,
    fxOptions, fxParticipantSelection, fxParticipantResults, runtimeResult,
  } = work;
  const emittedFxCount = fxParticipantResults.filter((result) => result.success).length;
  const fxSent = emittedFxCount > 0;
  const sendStatus = emittedFxCount > 0 &&
    emittedFxCount === fxParticipantSelection.eligibleFxRecipientCount
    ? "SENT"
    : emittedFxCount > 0
      ? "PARTIAL_FX_DELIVERY"
      : normalizeText(runtimeResult && runtimeResult.errorMsg, "SEND_FAILED");
  const sendErrorMsg = sendStatus === "SENT" ? "none" : sendStatus;
  const updatedPocketState = updateTransitionFxState({
    ...baseState,
    [statusField]: sendStatus,
    [errorField]: sendErrorMsg,
    [sentField]: fxSent ? toInt(deps.now(), 0) : 0,
  });
  const participantResultLog = fxParticipantResults
    .map((result) =>
      `${result.characterID}:${result.shipID}:${result.clientID}:` +
        `${result.success ? "SENT" : result.errorMsg}`,
    )
    .join(",") || "none";
  log.info(
    `[AbyssalMgr] Abyssal transition FX ${normalizedPhase} char=${getCharacterID(session)} ` +
      `instance=${toInt(pocketState && pocketState.instanceID, 0)} key=${effectKey} guid=${effectGuid} ` +
      `target=${toInt(fxOptions.targetID, 0) || "none"} ` +
      `destinationConduit=${toInt(fxOptions.chargeTypeID, 0) || "none"} ` +
      `destination=${toInt(fxOptions.graphicInfo && fxOptions.graphicInfo.items && fxOptions.graphicInfo.items[0], 0) || "none"} ` +
      `dungeon=${toInt(fxOptions.graphicInfo && fxOptions.graphicInfo.items && fxOptions.graphicInfo.items[1], 0) || "none"} ` +
      `participantCount=${fxParticipantSelection.participantCount} ` +
      `eligibleFxRecipientCount=${fxParticipantSelection.eligibleFxRecipientCount} ` +
      `emittedFxCount=${emittedFxCount} recipients=${participantResultLog} ` +
      `status=${sendStatus}`,
  );
  return {
    pocketState: updatedPocketState,
    fxStatus: buildAbyssalTransitionFxStatus(ports, updatedPocketState, deps),
    fxSent,
    participantCount: fxParticipantSelection.participantCount,
    eligibleFxRecipientCount: fxParticipantSelection.eligibleFxRecipientCount,
    emittedFxCount,
    participantResults: fxParticipantResults.map((result) => ({
      characterID: result.characterID,
      shipID: result.shipID,
      clientID: result.clientID,
      success: result.success,
      errorMsg: result.errorMsg,
    })),
    effect,
    effectKey,
    effectGuid,
    durationMs,
    authoritative: profile.authoritative === true,
    transitionPolicy: profile.transitionPolicy,
    transitionType,
    transitionProfileID,
    traceProfileID: normalizeText(entranceTraceProfile && entranceTraceProfile.traceProfileID, ""),
    usesProfileDrivenTraceActivation,
    runtimeResult,
  };
}

function maybeSendAbyssalTransitionFx(ports, pocketState, session, phase, deps = ports.getDependencies(), options = {}) {

  const normalizedPhase = normalizeText(phase, "").toLowerCase();
  if (normalizedPhase !== "entry" && normalizedPhase !== "transfer" && normalizedPhase !== "exit") {
    return {
      pocketState,
      fxStatus: buildAbyssalTransitionFxStatus(ports, pocketState, deps),
      fxSent: false,
      effect: null,
      effectKey: "none",
      effectGuid: "none",
      durationMs: 0,
    };
  }
  const work = { pocketState, session, deps, options, normalizedPhase };
  prepareTransitionFxProfile(ports, work);
  prepareTransitionFxEffect(ports, work);
  const previous = inspectPreviousTransitionFxAttempt(ports, work);
  if (previous) return previous;
  const { profile, attemptedField, sentField, errorField } = work;
  const baseState = {
    profileID: profile.profileID,
    entryKey: profile.entryKey,
    entryGuid: profile.entryGuid,
    transferKey: profile.transferKey,
    transferGuid: profile.transferGuid,
    exitKey: profile.exitKey,
    exitGuid: profile.exitGuid,
    [attemptedField]: toInt(deps.now(), 0),
    [sentField]: 0,
    [errorField]: "none",
  };
  work.baseState = baseState;
  const unavailable = inspectTransitionFxAvailability(ports, work);
  if (unavailable) return unavailable;
  dispatchTransitionFx(ports, work);
  return completeTransitionFxDelivery(ports, work);
}

function createAbyssalTransitionEffects(ports) {
  return {
    buildAbyssalTransitionFxProfile: buildAbyssalTransitionFxProfile.bind(null, ports),
    updateAbyssalTransitionFxState: updateAbyssalTransitionFxState.bind(null, ports),
    getAbyssalParticipantTransitionFxState: getAbyssalParticipantTransitionFxState.bind(null, ports),
    updateAbyssalParticipantTransitionFxState: updateAbyssalParticipantTransitionFxState.bind(null, ports),
    buildAbyssalTransitionFxStatus: buildAbyssalTransitionFxStatus.bind(null, ports),
    resolveAbyssalTransitionDurationMs: resolveAbyssalTransitionDurationMs.bind(null, ports),
    resolveAbyssalClientDungeonIdentifier: resolveAbyssalClientDungeonIdentifier.bind(null, ports),
    buildAbyssalTransitionFxOptions: buildAbyssalTransitionFxOptions.bind(null, ports),
    maybeSendAbyssalArrivalFx: maybeSendAbyssalArrivalFx.bind(null, ports),
    resolveAbyssalTransitionFxParticipants: resolveAbyssalTransitionFxParticipants.bind(null, ports),
    maybeSendAbyssalTransitionFx: maybeSendAbyssalTransitionFx.bind(null, ports),
  };
}

module.exports = { createAbyssalTransitionEffects };
