"use strict";

const { normalizeText } = require("../domain/abyssalValueUtils");

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

// Publish initial space state only through the existing run/binding validation gate.
function prepareAbyssalBallparkPriming({
  normalizeAbyssalBootstrapMode,
  getActivePocketStateForCharacterID,
  getCharacterID,
  evaluateAbyssalDirectCallbackTerminalGuard,
  usesIsolatedAbyssalScene,
  buildPlaceholderRoomState,
}, attempt) {
  const { session, deps, options } = attempt;
  const bootstrapMode = normalizeAbyssalBootstrapMode(options && options.mode, session);
  if (!session || !session._space) {
    return {
      attempted: false,
      primed: false,
      reason: "NOT_IN_SPACE",
      mode: bootstrapMode,
      validationReason: "NOT_IN_SPACE",
    };
  }
  if (!deps || typeof deps.getSceneForSession !== "function") {
    return {
      attempted: false,
      primed: false,
      reason: "SPACE_RUNTIME_UNAVAILABLE",
      mode: bootstrapMode,
      validationReason: "SPACE_RUNTIME_UNAVAILABLE",
    };
  }

  const runtime = deps;
  if (!runtime || typeof runtime.getSceneForSession !== "function") {
    return {
      attempted: false,
      primed: false,
      reason: "SPACE_RUNTIME_UNAVAILABLE",
      mode: bootstrapMode,
      validationReason: "SPACE_RUNTIME_UNAVAILABLE",
    };
  }

  const pocketState = getActivePocketStateForCharacterID(getCharacterID(session));
  const terminalGuard = evaluateAbyssalDirectCallbackTerminalGuard(
    pocketState,
    "client-ready-ballpark-prime",
  );
  if (terminalGuard.blocked) {
    return {
      attempted: false,
      primed: false,
      suppressed: true,
      terminal: true,
      reason: "ABYSSAL_RUN_TERMINALLY_SETTLED",
      guardReason: terminalGuard.reason,
      mode: bootstrapMode,
      validationReason: "ABYSSAL_RUN_TERMINALLY_SETTLED",
      runID: terminalGuard.instanceID,
    };
  }
  if (
    pocketState &&
    session._space.beyonceBound !== true &&
    (
      (
        bootstrapMode === "relog-recovery" &&
        usesIsolatedAbyssalScene(pocketState, deps)
      ) ||
      (
        bootstrapMode === "fresh-entry" &&
        session._abyssalFreshEntryBootstrap
      )
    )
  ) {
    return {
      attempted: false,
      primed: false,
      reason: "BEYONCE_BIND_PENDING",
      mode: bootstrapMode,
      validationReason: "BEYONCE_BIND_PENDING",
      runID: toInt(pocketState && pocketState.instanceID, 0),
      roomIndex: pocketState ? buildPlaceholderRoomState(pocketState).currentRoomIndex : 0,
    };
  }
  Object.assign(attempt, { bootstrapMode, runtime, pocketState });
  return null;
}

function validateAbyssalBallparkPriming({
  usesIsolatedAbyssalScene,
  inspectAbyssalRelogBootstrapState,
  recoverAbyssalSessionState,
  logAbyssalRelogBootstrapState,
  getCharacterID,
  buildAbyssalBootstrapDiagnosticFields,
  updateAbyssalFreshEntryBootstrapStatus,
}, attempt) {
  const { session, pocketState, deps, bootstrapMode } = attempt;
  let relogState = pocketState && usesIsolatedAbyssalScene(pocketState, deps)
    ? inspectAbyssalRelogBootstrapState(session, pocketState, deps)
    : null;
  let repairAttempted = false;
  const initialSceneKey = normalizeText(session._space.sceneKey, "");
  if (
    bootstrapMode === "relog-recovery" &&
    relogState &&
    !relogState.valid &&
    session._abyssalRelogBootstrapRepairAttempted !== true
  ) {
    session._abyssalRelogBootstrapRepairAttempted = true;
    repairAttempted = true;
    recoverAbyssalSessionState(session, deps);
    // Repair may evacuate and detach before a failed K-space reattach. The
    // initial space check no longer proves there is a ballpark to publish.
    if (!session._space) {
      return {
        attempted: true,
        primed: false,
        reason: "NOT_IN_SPACE",
        mode: bootstrapMode,
        validationReason: "NOT_IN_SPACE",
      };
    }
    relogState = inspectAbyssalRelogBootstrapState(session, pocketState, deps);
  }
  if (relogState && !relogState.valid) {
    logAbyssalRelogBootstrapState(session, pocketState, relogState, {
      initialSceneKey,
      repairAttempted,
      staleEntitiesRejected: toInt(session._abyssalRelogStaleEntitiesRejected, 0),
      bootstrapState: "blocked",
      reason: `EMPTY_OR_WRONG_SCENE_SETSTATE:${relogState.reason}`,
    });
    return {
      attempted: true,
      primed: false,
      reason: `EMPTY_OR_WRONG_SCENE_SETSTATE:${relogState.reason}`,
      characterID: getCharacterID(session),
      shipID: relogState.shipID,
      solarSystemID: toInt(session._space.systemID, 0),
      sceneFound: Boolean(relogState.scene),
      sessionAttached: relogState.sceneAttached,
      shipEntityFound: Boolean(relogState.shipEntity),
      shipRegisteredDynamic: relogState.shipRegistered,
      bubbleAssigned: toInt(relogState.shipEntity && relogState.shipEntity.bubbleID, 0) > 0,
      visibleDynamicCount: relogState.visibleEntityCount,
      recipientCount: relogState.scene && relogState.scene.sessions instanceof Map
        ? relogState.scene.sessions.size
        : 0,
      ...buildAbyssalBootstrapDiagnosticFields(relogState, bootstrapMode),
    };
  }
  if (session._space.initialStateSent === true) {
    if (pocketState && session._abyssalFreshEntryBootstrap) {
      updateAbyssalFreshEntryBootstrapStatus(
        session,
        pocketState,
        "consumed",
        deps,
        "SETSTATE_ALREADY_DELIVERED",
      );
    }
    return {
      attempted: false,
      primed: true,
      reason: "ALREADY_PRIMED",
      ...buildAbyssalBootstrapDiagnosticFields(relogState, bootstrapMode),
      validationReason: relogState && relogState.valid ? "VALID" : "ALREADY_PRIMED",
    };
  }
  Object.assign(attempt, { relogState, repairAttempted, initialSceneKey });
  return null;
}

function publishAbyssalInitialBallpark({
  getCharacterID,
  buildAbyssalBootstrapDiagnosticFields,
  inspectAbyssalRelogBootstrapState,
  logAbyssalRelogBootstrapState,
  updateAbyssalFreshEntryBootstrapStatus,
}, attempt) {
  const {
    session, pocketState, deps, context, runtime, bootstrapMode,
    relogState, repairAttempted, initialSceneKey,
  } = attempt;
  const scene = runtime.getSceneForSession(session);
  const shipID = toInt(session._space.shipID, 0);
  const shipEntity =
    scene && typeof scene.getEntityByID === "function"
      ? scene.getEntityByID(shipID)
      : null;
  const result = {
    attempted: true,
    primed: false,
    reason: "UNKNOWN",
    characterID: context && context.characterID ? context.characterID : getCharacterID(session),
    shipID,
    solarSystemID:
      context && context.systemID
        ? context.systemID
        : toInt(session._space.systemID, 0),
    sceneFound: Boolean(scene),
    sessionAttached:
      Boolean(scene && scene.sessions && scene.sessions.get(session.clientID) === session),
    shipEntityFound: Boolean(shipEntity),
    shipRegisteredDynamic:
      Boolean(scene && scene.dynamicEntities && scene.dynamicEntities.get(shipID) === shipEntity),
    bubbleAssigned: toInt(shipEntity && shipEntity.bubbleID, 0) > 0,
    visibleDynamicCount:
      scene && typeof scene.getVisibleDynamicEntitiesForSession === "function"
        ? scene.getVisibleDynamicEntitiesForSession(session).length
        : 0,
    recipientCount:
      scene && scene.sessions && typeof scene.sessions.size === "number"
        ? scene.sessions.size
        : 0,
    ...buildAbyssalBootstrapDiagnosticFields(relogState, bootstrapMode),
  };

  if (!scene) {
    result.reason = "SCENE_NOT_FOUND";
    return result;
  }
  if (!shipEntity) {
    result.reason = "SESSION_SHIP_NOT_FOUND";
    return result;
  }
  if (typeof runtime.ensureInitialBallpark !== "function") {
    result.reason = "INITIAL_BALLPARK_BOOTSTRAP_UNAVAILABLE";
    return result;
  }

  const bootstrapResult = runtime.ensureInitialBallpark(session, {
    reason: "abyssal-client-ready",
  });
  // The SetState is requested: the scene's next doPreTick builds it, so a
  // request is the bootstrap done.
  result.primed = Boolean(
    bootstrapResult === true &&
    session &&
    session._space &&
    (
      session._space.initialStateSent === true ||
      (typeof scene.hasPendingSetState === "function" && scene.hasPendingSetState(session))
    )
  );
  result.reason = result.primed ? "PRIMED" : "INITIAL_BALLPARK_BOOTSTRAP_FAILED";
  result.validationReason = result.primed
    ? "VALID"
    : normalizeText(relogState && relogState.reason, result.reason);
  if (relogState) {
    const finalState = inspectAbyssalRelogBootstrapState(session, pocketState, deps);
    logAbyssalRelogBootstrapState(session, pocketState, finalState, {
      initialSceneKey,
      repairAttempted,
      staleEntitiesRejected: toInt(session._abyssalRelogStaleEntitiesRejected, 0),
      setStateSlimCount: finalState.visibleEntityCount,
      setStateEgo: finalState.shipID,
      bootstrapState: result.primed ? "complete" : "blocked",
      reason: result.reason,
    });
  }
  if (result.primed && pocketState && session._abyssalFreshEntryBootstrap) {
    updateAbyssalFreshEntryBootstrapStatus(
      session,
      pocketState,
      "consumed",
      deps,
      "SETSTATE_DELIVERED",
    );
  }
  return result;
}

function ensureClientReadyBallparkPrimed({
  prepareAbyssalBallparkPriming,
  validateAbyssalBallparkPriming,
  publishAbyssalInitialBallpark,
}, session, deps, context = null, options = {}) {
  const attempt = { session, deps, context, options };
  const preparationResult = prepareAbyssalBallparkPriming(attempt);
  if (preparationResult) return preparationResult;
  const validationResult = validateAbyssalBallparkPriming(attempt);
  if (validationResult) return validationResult;
  return publishAbyssalInitialBallpark(attempt);
}

function createAbyssalBallparkPriming({
  normalizeAbyssalBootstrapMode,
  getActivePocketStateForCharacterID,
  getCharacterID,
  evaluateAbyssalDirectCallbackTerminalGuard,
  usesIsolatedAbyssalScene,
  buildPlaceholderRoomState,
  inspectAbyssalRelogBootstrapState,
  recoverAbyssalSessionState,
  logAbyssalRelogBootstrapState,
  buildAbyssalBootstrapDiagnosticFields,
  updateAbyssalFreshEntryBootstrapStatus,
}) {

  const ports = {
    normalizeAbyssalBootstrapMode,
    getActivePocketStateForCharacterID,
    getCharacterID,
    evaluateAbyssalDirectCallbackTerminalGuard,
    usesIsolatedAbyssalScene,
    buildPlaceholderRoomState,
    inspectAbyssalRelogBootstrapState,
    recoverAbyssalSessionState,
    logAbyssalRelogBootstrapState,
    buildAbyssalBootstrapDiagnosticFields,
    updateAbyssalFreshEntryBootstrapStatus,
  };
  ports.prepareAbyssalBallparkPriming = prepareAbyssalBallparkPriming.bind(null, ports);
  ports.validateAbyssalBallparkPriming = validateAbyssalBallparkPriming.bind(null, ports);
  ports.publishAbyssalInitialBallpark = publishAbyssalInitialBallpark.bind(null, ports);
  ports.ensureClientReadyBallparkPrimed = ensureClientReadyBallparkPrimed.bind(null, ports);
  Object.freeze(ports);
  return { ensureClientReadyBallparkPrimed: ports.ensureClientReadyBallparkPrimed };
}

module.exports = { createAbyssalBallparkPriming };
