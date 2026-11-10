"use strict";

const { normalizeText } = require("../domain/abyssalValueUtils");

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

// Fresh-entry identity, delayed handoff validation and session-change delivery.
// Token allocation, persistence, trace authority and evacuation stay injected.
function buildAbyssalFreshEntryBootstrapState({
  getDependencies,
  buildAbyssalSceneDescriptor,
  abyssalPendingWorkRegistry,
  getCharacterID,
  buildPlaceholderRoomState,
}, pocketState, session, deps = getDependencies()) {
  const descriptor = buildAbyssalSceneDescriptor(pocketState, deps);
  if (!descriptor || !session) {
    return null;
  }
  return {
    status: "pending",
    token: abyssalPendingWorkRegistry.allocateFreshEntryBootstrapToken(),
    characterID: getCharacterID(session),
    shipID: toInt(
      session && (session.shipID || session.shipid || session.activeShipID),
      toInt(pocketState && pocketState.shipID, 0),
    ),
    runID: toInt(pocketState && pocketState.instanceID, 0),
    roomIndex: buildPlaceholderRoomState(pocketState).currentRoomIndex,
    sourceSolarSystemID: toInt(pocketState && pocketState.sourceSolarSystemID, 0),
    clientAbyssalLocationID: toInt(descriptor.locationID, 0),
    runSceneKey: normalizeText(descriptor.sceneKey, ""),
    returnSolarSystemID: toInt(pocketState && pocketState.sourceSolarSystemID, 0),
    queuedAtMs: toInt(deps && typeof deps.now === "function" ? deps.now() : Date.now(), 0),
  };
}

function getAbyssalFreshEntryBootstrapStatesByCharacterID({
  cloneValue,
}, pocketState) {
  const states = {};
  const persistedStates = pocketState &&
    pocketState.freshEntryBootstrapStatesByCharacterID;
  if (
    persistedStates &&
    typeof persistedStates === "object" &&
    !Array.isArray(persistedStates)
  ) {
    for (const [key, state] of Object.entries(persistedStates)) {
      const characterID = toInt(state && state.characterID, toInt(key, 0));
      if (characterID > 0 && state && typeof state === "object") {
        states[String(characterID)] = cloneValue(state);
      }
    }
  }
  const legacyState = pocketState && pocketState.freshEntryBootstrapState;
  const legacyCharacterID = toInt(legacyState && legacyState.characterID, 0);
  if (legacyCharacterID > 0 && !states[String(legacyCharacterID)]) {
    states[String(legacyCharacterID)] = cloneValue(legacyState);
  }
  return states;
}

function logAbyssalFreshEntryBootstrap({
  log,
  getCharacterID,
}, session, state, details = {}) {
  log.info(
    `[AbyssalFreshEntryBootstrap] state=${normalizeText(details.state, state && state.status || "unknown")} ` +
      `character=${toInt(state && state.characterID, getCharacterID(session))} ` +
      `ship=${toInt(state && state.shipID, 0)} run=${toInt(state && state.runID, 0)} ` +
      `room=${toInt(state && state.roomIndex, 0)} token=${toInt(state && state.token, 0)} ` +
      `sourceSolarSystemID=${toInt(state && state.sourceSolarSystemID, 0)} ` +
      `clientAbyssalLocationID=${toInt(state && state.clientAbyssalLocationID, 0)} ` +
      `runSceneKey=${normalizeText(state && state.runSceneKey, "none")} ` +
      `returnSolarSystemID=${toInt(state && state.returnSolarSystemID, 0)} ` +
      `reason=${normalizeText(details.reason, "none")}`,
  );
}

function queueAbyssalFreshEntryBootstrap({
  getDependencies,
  usesIsolatedAbyssalScene,
  buildAbyssalFreshEntryBootstrapState,
  cloneValue,
  getAbyssalFreshEntryBootstrapStatesByCharacterID,
  updatePocketState,
  logAbyssalFreshEntryBootstrap,
}, pocketState, session, deps = getDependencies()) {
  if (!usesIsolatedAbyssalScene(pocketState, deps)) {
    return { queued: false, reason: "ISOLATED_SCENES_DISABLED" };
  }
  const state = buildAbyssalFreshEntryBootstrapState(pocketState, session, deps);
  if (!state || state.runID <= 0 || state.token <= 0 || !state.runSceneKey) {
    return { queued: false, reason: "FRESH_ENTRY_IDENTITY_UNAVAILABLE" };
  }
  session._abyssalFreshEntryBootstrap = cloneValue(state);
  session._abyssalBootstrapMode = "fresh-entry";
  const freshEntryBootstrapStatesByCharacterID = {
    ...getAbyssalFreshEntryBootstrapStatesByCharacterID(pocketState),
    [String(state.characterID)]: cloneValue(state),
  };
  updatePocketState(state.runID, {
    freshEntryBootstrapStatesByCharacterID,
    ...(state.characterID === toInt(pocketState && pocketState.characterID, 0)
      ? { freshEntryBootstrapState: cloneValue(state) }
      : {}),
  });
  logAbyssalFreshEntryBootstrap(session, state, {
    state: "pending",
    reason: "ROOM_PREPARED_AWAITING_FIRST_BIND",
  });
  return { queued: true, state: cloneValue(state) };
}

function updateAbyssalFreshEntryBootstrapStatus({
  getDependencies,
  cloneValue,
  getAbyssalFreshEntryBootstrapStatesByCharacterID,
  updatePocketState,
  logAbyssalFreshEntryBootstrap,
},
  session,
  pocketState,
  status,
  deps = getDependencies(),
  reason = "",
) {
  const current = session && session._abyssalFreshEntryBootstrap;
  if (!current || toInt(current.runID, 0) !== toInt(pocketState && pocketState.instanceID, 0)) {
    return null;
  }
  const nowMs = toInt(deps && typeof deps.now === "function" ? deps.now() : Date.now(), 0);
  const next = {
    ...cloneValue(current),
    status: normalizeText(status, current.status),
    updatedAtMs: nowMs,
    ...(status === "consumed" ? { consumedAtMs: nowMs } : {}),
    ...(status === "failed" ? { failedAtMs: nowMs } : {}),
    ...(status === "disconnected" ? { disconnectedAtMs: nowMs } : {}),
    reason: normalizeText(reason, current.reason || ""),
  };
  session._abyssalFreshEntryBootstrap = cloneValue(next);
  session._abyssalBootstrapMode = status === "consumed" ? "active-bind" : "fresh-entry";
  const freshEntryBootstrapStatesByCharacterID = {
    ...getAbyssalFreshEntryBootstrapStatesByCharacterID(pocketState),
    [String(next.characterID)]: cloneValue(next),
  };
  updatePocketState(toInt(next.runID, 0), {
    freshEntryBootstrapStatesByCharacterID,
    ...(next.characterID === toInt(pocketState && pocketState.characterID, 0)
      ? { freshEntryBootstrapState: cloneValue(next) }
      : {}),
  });
  logAbyssalFreshEntryBootstrap(session, next, {
    state: next.status,
    reason: next.reason,
  });
  return next;
}

function validateAbyssalFreshEntryBootstrapRoute({
  getDependencies,
  buildAbyssalSceneDescriptor,
  buildPlaceholderRoomState,
  getSessionContext,
  getAbyssalFreshEntryBootstrapStatesByCharacterID,
  cloneValue,
}, session, pocketState, deps = getDependencies()) {
  const marker = session && session._abyssalFreshEntryBootstrap;
  const descriptor = buildAbyssalSceneDescriptor(pocketState, deps);
  const roomIndex = buildPlaceholderRoomState(pocketState).currentRoomIndex;
  const context = getSessionContext(session);
  const persistedStates = getAbyssalFreshEntryBootstrapStatesByCharacterID(pocketState);
  const persisted = persistedStates[String(context.characterID)] || null;
  const failures = [];
  if (!marker || !persisted) failures.push("TOKEN_MISSING");
  if (!descriptor) failures.push("SCENE_DESCRIPTOR_MISSING");
  if (marker && persisted && toInt(marker.token, 0) !== toInt(persisted.token, 0)) {
    failures.push("TOKEN_MISMATCH");
  }
  if (marker && toInt(marker.characterID, 0) !== context.characterID) failures.push("CHARACTER_MISMATCH");
  if (marker && toInt(marker.shipID, 0) !== context.shipID) failures.push("SHIP_MISMATCH");
  if (marker && toInt(marker.runID, 0) !== toInt(pocketState && pocketState.instanceID, 0)) {
    failures.push("RUN_MISMATCH");
  }
  if (
    marker &&
    normalizeText(marker.status, "pending").toLowerCase() === "pending" &&
    toInt(marker.roomIndex, 0) !== roomIndex
  ) {
    failures.push("ROOM_MISMATCH");
  }
  if (
    marker &&
    toInt(marker.clientAbyssalLocationID, 0) !== toInt(descriptor && descriptor.locationID, 0)
  ) {
    failures.push("CLIENT_LOCATION_MISMATCH");
  }
  if (
    marker &&
    normalizeText(marker.runSceneKey, "") !== normalizeText(descriptor && descriptor.sceneKey, "")
  ) {
    failures.push("RUN_SCENE_MISMATCH");
  }
  if (
    descriptor &&
    toInt(session && (session.solarsystemid2 || session.solarsystemid), 0) !==
      toInt(descriptor.locationID, 0)
  ) {
    failures.push("SESSION_LOCATION_MISMATCH");
  }
  if (
    descriptor &&
    normalizeText(session && session._space && session._space.sceneKey, "") !==
      normalizeText(descriptor.sceneKey, "")
  ) {
    failures.push("SESSION_SCENE_MISMATCH");
  }
  if (pocketState && pocketState.disconnectState) failures.push("DISCONNECT_STATE_PRESENT");
  return {
    valid: failures.length === 0,
    reason: failures[0] || "VALID",
    failures,
    marker: marker ? cloneValue(marker) : null,
    descriptor,
    roomIndex,
  };
}

function revalidateDelayedAbyssalEntryHandoff({
  getDependencies,
  buildAbyssalHandoffSessionIdentity,
  getAbyssalParticipantRecord,
  abyssalTraceStateRegistry,
  pendingAbyssalTraceActivationMatchesSession,
  getActiveTraceState,
  normalizeAbyssalTraceLifecyclePhase,
  resolveAbyssalTraceProfile,
  ABYSSAL_TRACE_LIFECYCLE_PHASE,
  validateAbyssalTraceActivation,
},
  args,
  session,
  currentPocketState,
  expected,
  deps = getDependencies(),
) {
  const identityResult = buildAbyssalHandoffSessionIdentity(session, deps, expected);
  if (!identityResult.success) {
    return identityResult;
  }
  const expectedInstanceID = toInt(expected && expected.instanceID, 0);
  const expectedTraceItemID = toInt(expected && expected.traceItemID, 0);
  const expectedParticipant = currentPocketState
    ? getAbyssalParticipantRecord(currentPocketState, expected.characterID)
    : null;
  const participantIdentityMatches = Boolean(
    expectedParticipant &&
    toInt(expectedParticipant.shipID, 0) === toInt(expected.shipID, 0),
  );
  if (
    !currentPocketState ||
    toInt(currentPocketState.instanceID, 0) !== expectedInstanceID ||
    toInt(currentPocketState.traceItemID, 0) !== expectedTraceItemID ||
    !participantIdentityMatches
  ) {
    return {
      success: false,
      errorMsg: "ABYSSAL_ENTRY_HANDOFF_RUN_IDENTITY_CHANGED",
    };
  }

  const pendingActivation =
    abyssalTraceStateRegistry.getPendingActivation(expectedTraceItemID) || null;
  if (
    pendingActivation &&
    !pendingAbyssalTraceActivationMatchesSession(pendingActivation, session)
  ) {
    return {
      success: false,
      errorMsg: "ABYSSAL_ENTRY_HANDOFF_ACTIVATION_SESSION_CHANGED",
    };
  }

  const traceState = getActiveTraceState(expectedTraceItemID, deps);
  const traceLifecyclePhase = normalizeAbyssalTraceLifecyclePhase(
    traceState && traceState.lifecyclePhase,
  );
  const traceProfile = resolveAbyssalTraceProfile(traceState);
  if (
    !traceState ||
    toInt(traceState.traceItemID, 0) !== expectedTraceItemID ||
    toInt(traceState.filamentTypeID, 0) !== toInt(expected.filamentTypeID, 0) ||
    (
      toInt(expected.traceTypeID, 0) > 0 &&
      toInt(traceState.typeID, 0) !== toInt(expected.traceTypeID, 0)
    ) ||
    (
      normalizeText(expected.deploymentToken, "") &&
      normalizeText(traceState.deploymentToken, "") !==
        normalizeText(expected.deploymentToken, "")
    ) ||
    normalizeText(traceState.sourceSceneKey, identityResult.data.sceneKey) !==
      identityResult.data.sceneKey ||
    (
      traceProfile &&
      traceLifecyclePhase !== ABYSSAL_TRACE_LIFECYCLE_PHASE.ACTIVE
    ) ||
    (
      !traceProfile &&
      ![
        ABYSSAL_TRACE_LIFECYCLE_PHASE.CREATED,
        ABYSSAL_TRACE_LIFECYCLE_PHASE.ACTIVE,
      ].includes(traceLifecyclePhase)
    ) ||
    (
      traceProfile &&
      toInt(traceState.abyssalRunID, 0) !== expectedInstanceID
    )
  ) {
    return {
      success: false,
      errorMsg: "ABYSSAL_ENTRY_HANDOFF_TRACE_IDENTITY_CHANGED",
    };
  }

  const freshValidation = validateAbyssalTraceActivation(
    [expectedTraceItemID],
    session,
    deps,
  );
  if (!freshValidation || freshValidation.success !== true) {
    return {
      ...(freshValidation || {}),
      success: false,
      errorMsg: normalizeText(
        freshValidation && freshValidation.error &&
          freshValidation.error.details && freshValidation.error.details.reason,
        normalizeText(
          freshValidation && freshValidation.error && freshValidation.error.code,
          "ABYSSAL_ENTRY_HANDOFF_REVALIDATION_FAILED",
        ),
      ),
    };
  }
  if (
    toInt(freshValidation.data.traceItemID, 0) !== expectedTraceItemID ||
    toInt(freshValidation.data.context.characterID, 0) !== toInt(expected.characterID, 0) ||
    toInt(freshValidation.data.context.shipID, 0) !== toInt(expected.shipID, 0)
  ) {
    return {
      success: false,
      errorMsg: "ABYSSAL_ENTRY_HANDOFF_VALIDATION_IDENTITY_CHANGED",
    };
  }
  return freshValidation;
}

function buildAbyssalEntrySessionChanges({
  captureAbyssalSpaceSessionFields,
  worldData,
  addAbyssalSessionChange,
}, session, targetLocationID, movedShip, descriptor) {
  const previous = captureAbyssalSpaceSessionFields(session);
  const targetSystem = worldData.getSolarSystemByID(targetLocationID) || null;
  const targetConstellationID = toInt(
    targetSystem && targetSystem.constellationID,
    toInt(previous.constellationid, 0),
  );
  const targetRegionID = toInt(
    targetSystem && targetSystem.regionID,
    toInt(previous.regionid, 0),
  );
  const targetShipID = toInt(movedShip && movedShip.itemID, toInt(previous.shipid, 0));
  const changes = {};
  addAbyssalSessionChange(changes, "locationid", previous.locationid || null, targetLocationID || null);
  addAbyssalSessionChange(changes, "solarsystemid", previous.solarsystemid || null, targetLocationID || null);
  addAbyssalSessionChange(changes, "solarsystemid2", previous.solarsystemid2 || null, targetLocationID || null);
  addAbyssalSessionChange(changes, "constellationid", previous.constellationid || null, targetConstellationID || null);
  addAbyssalSessionChange(changes, "regionid", previous.regionid || null, targetRegionID || null);
  addAbyssalSessionChange(changes, "shipid", previous.shipid || null, targetShipID || null);
  return {
    previous,
    target: {
      locationid: targetLocationID || null,
      solarsystemid: targetLocationID || null,
      solarsystemid2: targetLocationID || null,
      constellationid: targetConstellationID || 0,
      regionid: targetRegionID || 0,
      shipid: targetShipID || null,
    },
    changes,
    descriptor,
  };
}

function applyAbyssalEntrySessionFields({}, session, targetFields, movedShip) {
  if (!session || !targetFields) {
    return;
  }
  session.locationid = targetFields.locationid;
  session.solarsystemid = targetFields.solarsystemid;
  session.solarsystemid2 = targetFields.solarsystemid2;
  session.constellationID = targetFields.constellationid || 0;
  session.constellationid = session.constellationID;
  session.regionID = targetFields.regionid || 0;
  session.regionid = session.regionID;
  session.shipID = targetFields.shipid;
  session.shipid = targetFields.shipid;
  session.activeShipID = targetFields.shipid;
  session.activeShipId = targetFields.shipid;
  session.shipTypeID = movedShip && movedShip.typeID;
}

function sendAbyssalEntrySessionChange({
  log,
  PROXY_NODE_ID,
}, session, sessionChangeState, context = {}) {
  if (
    !session ||
    !sessionChangeState ||
    !sessionChangeState.changes ||
    Object.keys(sessionChangeState.changes).length <= 0
  ) {
    return false;
  }
  if (typeof session.sendSessionChange !== "function") {
    log.warn(
      `[AbyssalScene] SessionChange unavailable char=${toInt(context.characterID, 0)} ` +
        `instance=${toInt(context.instanceID, 0)} sceneKey=${
          sessionChangeState.descriptor
            ? normalizeText(sessionChangeState.descriptor.sceneKey, "n/a")
            : "n/a"
        }`,
    );
    return false;
  }
  const sourceNodeID =
    Number(session && session._machoNodeID) ||
    PROXY_NODE_ID;
  if (sourceNodeID > 0) {
    session._machoNodeID = sourceNodeID;
  }
  session.sendSessionChange(sessionChangeState.changes, {
    sourceNodeID,
    nodesOfInterest: sourceNodeID > 0 ? [sourceNodeID] : [],
  });
  log.info(
    `[AbyssalScene] SessionChange sent mode=${normalizeText(context.mode, "isolated-scene")} ` +
      `char=${toInt(context.characterID, 0)} ` +
      `instance=${toInt(context.instanceID, 0)} ` +
      `oldLocation=${sessionChangeState.previous.locationid || 0} ` +
      `newLocation=${sessionChangeState.target.locationid || 0} ` +
      `keys=${Object.keys(sessionChangeState.changes).join(",")} ` +
      `sceneKey=${
        sessionChangeState.descriptor
          ? normalizeText(sessionChangeState.descriptor.sceneKey, "n/a")
          : "n/a"
      }`,
  );
  return true;
}

function rollbackAbyssalFreshEntryBootstrap({
  getDependencies,
  evaluateAbyssalDirectCallbackTerminalGuard,
  getSessionContext,
  updateAbyssalFreshEntryBootstrapStatus,
  cloneValue,
  beginAbyssalCompatibilityRecovery,
  logAbyssalFreshEntryBootstrap,
},
  session,
  pocketState,
  reason,
  deps = getDependencies(),
) {
  const terminalGuard = evaluateAbyssalDirectCallbackTerminalGuard(
    pocketState,
    "fresh-entry-bootstrap-rollback",
  );
  if (terminalGuard.blocked) {
    return {
      recovered: false,
      activeRunBound: false,
      freshEntry: true,
      route: "fresh-entry-rollback-terminal-suppressed",
      cleanedUp: false,
      evacuated: false,
      suppressed: true,
      terminal: true,
      reason: "ABYSSAL_RUN_TERMINALLY_SETTLED",
      guardReason: terminalGuard.reason,
      pocketState: terminalGuard.pocketState,
    };
  }
  const normalizedReason = normalizeText(reason, "FRESH_ENTRY_BOOTSTRAP_FAILED");
  const context = getSessionContext(session);
  const marker = updateAbyssalFreshEntryBootstrapStatus(
    session,
    pocketState,
    "failed",
    deps,
    normalizedReason,
  ) || cloneValue(session && session._abyssalFreshEntryBootstrap);
  const compatibilityRecovery = beginAbyssalCompatibilityRecovery(
    session,
    pocketState,
    normalizedReason,
    deps,
    {
      compatibilityPath: "fresh-entry-bootstrap-rollback",
      suppressionReason: "FRESH_ENTRY_BOOTSTRAP_EVACUATION_PENDING",
    },
  );
  logAbyssalFreshEntryBootstrap(session, marker, {
    state: compatibilityRecovery.cleanedUp === true
      ? "rolled-back"
      : "rollback-pending",
    reason: normalizedReason,
  });
  return {
    recovered: false,
    activeRunBound: false,
    freshEntry: true,
    route: "fresh-entry-rollback",
    entryRecovery: true,
    cleanedUp: compatibilityRecovery.cleanedUp === true,
    evacuated: compatibilityRecovery.evacuated === true,
    recoveryPending: compatibilityRecovery.recoveryPending === true,
    reason: normalizedReason,
    returnSystemID: toInt(
      compatibilityRecovery.evacuationResult &&
        compatibilityRecovery.evacuationResult.returnSystemID,
      0,
    ),
    characterID: context.characterID,
    compatibilityRecovery,
    entryRecoveryResult: compatibilityRecovery.entryRecoveryResult,
    evacuationResult: compatibilityRecovery.evacuationResult,
    pocketState: compatibilityRecovery.pocketState,
  };
}

// Capture supplied capabilities once, as the original closure did. Internal
// callbacks are bound once per instance; no runtime state lives in this wiring.
function createAbyssalEntryBootstrap({
  getDependencies,
  buildAbyssalSceneDescriptor,
  abyssalPendingWorkRegistry,
  getCharacterID,
  buildPlaceholderRoomState,
  cloneValue,
  log,
  usesIsolatedAbyssalScene,
  updatePocketState,
  getSessionContext,
  buildAbyssalHandoffSessionIdentity,
  getAbyssalParticipantRecord,
  abyssalTraceStateRegistry,
  pendingAbyssalTraceActivationMatchesSession,
  getActiveTraceState,
  normalizeAbyssalTraceLifecyclePhase,
  resolveAbyssalTraceProfile,
  ABYSSAL_TRACE_LIFECYCLE_PHASE,
  validateAbyssalTraceActivation,
  captureAbyssalSpaceSessionFields,
  worldData,
  addAbyssalSessionChange,
  PROXY_NODE_ID,
  evaluateAbyssalDirectCallbackTerminalGuard,
  beginAbyssalCompatibilityRecovery,
}) {

  const ports = {
    getDependencies,
    buildAbyssalSceneDescriptor,
    abyssalPendingWorkRegistry,
    getCharacterID,
    buildPlaceholderRoomState,
    cloneValue,
    log,
    usesIsolatedAbyssalScene,
    updatePocketState,
    getSessionContext,
    buildAbyssalHandoffSessionIdentity,
    getAbyssalParticipantRecord,
    abyssalTraceStateRegistry,
    pendingAbyssalTraceActivationMatchesSession,
    getActiveTraceState,
    normalizeAbyssalTraceLifecyclePhase,
    resolveAbyssalTraceProfile,
    ABYSSAL_TRACE_LIFECYCLE_PHASE,
    validateAbyssalTraceActivation,
    captureAbyssalSpaceSessionFields,
    worldData,
    addAbyssalSessionChange,
    PROXY_NODE_ID,
    evaluateAbyssalDirectCallbackTerminalGuard,
    beginAbyssalCompatibilityRecovery,
  };
  ports.buildAbyssalFreshEntryBootstrapState = buildAbyssalFreshEntryBootstrapState.bind(null, ports);
  ports.getAbyssalFreshEntryBootstrapStatesByCharacterID = getAbyssalFreshEntryBootstrapStatesByCharacterID.bind(null, ports);
  ports.logAbyssalFreshEntryBootstrap = logAbyssalFreshEntryBootstrap.bind(null, ports);
  ports.queueAbyssalFreshEntryBootstrap = queueAbyssalFreshEntryBootstrap.bind(null, ports);
  ports.updateAbyssalFreshEntryBootstrapStatus = updateAbyssalFreshEntryBootstrapStatus.bind(null, ports);
  ports.validateAbyssalFreshEntryBootstrapRoute = validateAbyssalFreshEntryBootstrapRoute.bind(null, ports);
  ports.revalidateDelayedAbyssalEntryHandoff = revalidateDelayedAbyssalEntryHandoff.bind(null, ports);
  ports.buildAbyssalEntrySessionChanges = buildAbyssalEntrySessionChanges.bind(null, ports);
  ports.applyAbyssalEntrySessionFields = applyAbyssalEntrySessionFields.bind(null, ports);
  ports.sendAbyssalEntrySessionChange = sendAbyssalEntrySessionChange.bind(null, ports);
  ports.rollbackAbyssalFreshEntryBootstrap = rollbackAbyssalFreshEntryBootstrap.bind(null, ports);
  Object.freeze(ports);
  return {
    buildAbyssalFreshEntryBootstrapState: ports.buildAbyssalFreshEntryBootstrapState,
    getAbyssalFreshEntryBootstrapStatesByCharacterID: ports.getAbyssalFreshEntryBootstrapStatesByCharacterID,
    logAbyssalFreshEntryBootstrap: ports.logAbyssalFreshEntryBootstrap,
    queueAbyssalFreshEntryBootstrap: ports.queueAbyssalFreshEntryBootstrap,
    updateAbyssalFreshEntryBootstrapStatus: ports.updateAbyssalFreshEntryBootstrapStatus,
    validateAbyssalFreshEntryBootstrapRoute: ports.validateAbyssalFreshEntryBootstrapRoute,
    revalidateDelayedAbyssalEntryHandoff: ports.revalidateDelayedAbyssalEntryHandoff,
    buildAbyssalEntrySessionChanges: ports.buildAbyssalEntrySessionChanges,
    applyAbyssalEntrySessionFields: ports.applyAbyssalEntrySessionFields,
    sendAbyssalEntrySessionChange: ports.sendAbyssalEntrySessionChange,
    rollbackAbyssalFreshEntryBootstrap: ports.rollbackAbyssalFreshEntryBootstrap,
  };
}

module.exports = { createAbyssalEntryBootstrap };
