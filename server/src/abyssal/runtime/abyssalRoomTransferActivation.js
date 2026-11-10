"use strict";

const { normalizeText } = require("../domain/abyssalValueUtils");

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

// Destination mechanics must be ready before completion bookkeeping. This layer
// does not publish entities, choose encounters or own final durable transfer commit.
function activateAbyssalTransferDestinationNpcs({
  refreshAbyssalDungeonTrackingState,
  activateAbyssalRoomNpcControllers,
  settleFailedAbyssalDestinationActivation,
  cloneValue,
}, {
  effectivePocketState, deps, authoredEnvironmentNotification, deliveryScene,
  session, nextRoomIndex, currentRoomIndex, recordTransferPhase,
}) {
  refreshAbyssalDungeonTrackingState(effectivePocketState, deps, "room_entered");
  if (
    !authoredEnvironmentNotification &&
    deps.dungeonTrackingRuntime &&
    typeof deps.dungeonTrackingRuntime.enterDungeonRoomForSession === "function"
  ) {
    deps.dungeonTrackingRuntime.enterDungeonRoomForSession(
      deliveryScene,
      session,
      effectivePocketState.instance,
      `room:${nextRoomIndex}`,
      {
        siteID: effectivePocketState.traceItemID,
        roomPosition: effectivePocketState.shipSpawnState && effectivePocketState.shipSpawnState.position,
        forceNotify: true,
      },
    );
  }
  const npcActivationResult = activateAbyssalRoomNpcControllers(
    effectivePocketState,
    session,
    deps,
    {
      roomIndex: nextRoomIndex,
      expectPaused: true,
      roomActive: true,
      degradeOnFailure: false,
    },
  );
  recordTransferPhase("npc-controllers-activated", {
    controllerActivations: toInt(
      npcActivationResult && npcActivationResult.data && npcActivationResult.data.activated,
      0,
    ),
    readinessPasses: toInt(
      npcActivationResult && npcActivationResult.data && npcActivationResult.data.readinessPasses,
      0,
    ),
    readinessRetries: toInt(
      npcActivationResult && npcActivationResult.data && npcActivationResult.data.readinessRetries,
      0,
    ),
    readinessMs: Number(
      npcActivationResult && npcActivationResult.data && npcActivationResult.data.readinessDurationMs,
    ).toFixed(3),
    controllerActivationMs: Number(
      npcActivationResult && npcActivationResult.data &&
        npcActivationResult.data.controllerActivationDurationMs,
    ).toFixed(3),
    bubbleMismatch: (
      npcActivationResult && npcActivationResult.data &&
        Array.isArray(npcActivationResult.data.readiness)
        ? npcActivationResult.data.readiness
        : []
    ).filter((entry) => entry && entry.failure === "BUBBLE_MISMATCH").length,
  });
  if (!npcActivationResult.success) {
    return settleFailedAbyssalDestinationActivation(
      effectivePocketState,
      session,
      deps,
      npcActivationResult.errorMsg || "ABYSSAL_NPC_ACTIVATION_FAILED",
      {
        sourceRoomIndex: currentRoomIndex,
        destinationRoomIndex: nextRoomIndex,
        npcActivationResult: cloneValue(npcActivationResult),
      },
    );
  }
  return { success: true, npcActivationResult };
}

function activateAbyssalTransferDestinationMechanics({
  activateSuppressorControllersForPocketRoom,
  ensureBoundaryControllerForPocketState,
  getActivePocketStateByInstanceID,
  evaluateEnvironmentalEffectsForPocketState,
  applyAbyssalWeatherToRun,
  getContentProfile,
  buildAbyssalDestinationMechanicsReadiness,
  settleFailedAbyssalDestinationActivation,
  cloneValue,
}, {
  effectivePocketState, nextRoomIndex, currentRoomIndex, session, deps,
  recordTransferPhase, npcActivationResult,
}) {
  const suppressorActivationResults = activateSuppressorControllersForPocketRoom(
    effectivePocketState,
    nextRoomIndex,
    deps,
  );
  const boundaryResult = ensureBoundaryControllerForPocketState(
    getActivePocketStateByInstanceID(toInt(effectivePocketState.instanceID, 0)) ||
      effectivePocketState,
    deps,
    toInt(deps.now(), 0),
    { allowPendingDestinationActivation: true },
  );
  const environmentalEffectResult = evaluateEnvironmentalEffectsForPocketState(
    getActivePocketStateByInstanceID(toInt(effectivePocketState.instanceID, 0)) ||
      effectivePocketState,
    deps,
    toInt(deps.now(), 0),
    {
      roomIndex: nextRoomIndex,
      boundaryOptions: { allowPendingDestinationActivation: true },
    },
  );
  recordTransferPhase("environment-mechanics-ready");
  const weatherResult = applyAbyssalWeatherToRun(
    getActivePocketStateByInstanceID(toInt(effectivePocketState.instanceID, 0)) ||
      effectivePocketState,
    session,
    deps,
    { reason: "room-transfer" },
  );
  recordTransferPhase("weather-ready", {
    weather: normalizeText(
      getContentProfile(effectivePocketState) && getContentProfile(effectivePocketState).weatherType,
      "unknown",
    ),
    weatherApplied: Boolean(weatherResult && weatherResult.success !== false),
  });
  const mechanicsPocketState =
    getActivePocketStateByInstanceID(toInt(effectivePocketState.instanceID, 0)) ||
    effectivePocketState;
  const destinationMechanicsReadiness = buildAbyssalDestinationMechanicsReadiness(
    mechanicsPocketState,
    session,
    deps,
    {
      roomIndex: nextRoomIndex,
      npcActivationResult,
      suppressorActivationResults,
      environmentalEffectResult,
      boundaryResult,
      weatherResult,
    },
  );
  if (!destinationMechanicsReadiness.ready) {
    return settleFailedAbyssalDestinationActivation(
      mechanicsPocketState,
      session,
      deps,
      destinationMechanicsReadiness.errorMsg,
      {
        sourceRoomIndex: currentRoomIndex,
        destinationRoomIndex: nextRoomIndex,
        readiness: cloneValue(destinationMechanicsReadiness),
      },
    );
  }
  return { success: true, effectivePocketState: mechanicsPocketState };
}

function finalizeAbyssalTransferDestinationActivation({
  deliverSuppressorPresentationForSession,
  logAbyssalRoomContentActivated,
  getActivePocketStateByInstanceID,
  recordAbyssalEnvironmentSequenceEvent,
  advanceAbyssalRoomTransferLifecycle,
  updateAbyssalClientEnvironmentDeliveryState,
}, context) {
  const { session, deps, nextRoomIndex, currentRoomIndex, npcActivationResult, authoredEnvironmentNotification } = context;
  let { effectivePocketState, transferEnvironmentDeliveryState } = context;
  deliverSuppressorPresentationForSession(
    effectivePocketState,
    session,
    deps,
    {
      roomIndex: nextRoomIndex,
      reason: "room-delivered",
    },
  );
  logAbyssalRoomContentActivated(
    getActivePocketStateByInstanceID(toInt(effectivePocketState.instanceID, 0)) ||
      effectivePocketState,
    { roomIndex: nextRoomIndex },
  );
  recordAbyssalEnvironmentSequenceEvent(
    effectivePocketState,
    session,
    nextRoomIndex,
    "npc_activation",
    deps,
    { degraded: Boolean(npcActivationResult.data && npcActivationResult.data.degraded) },
  );
  effectivePocketState = advanceAbyssalRoomTransferLifecycle(
    effectivePocketState,
    session,
    deps,
    "controllers_activated",
    {
      fromRoom: currentRoomIndex,
      toRoom: nextRoomIndex,
      pendingState: {
        currentPhase: "destination-controllers-activated",
        destinationControllersActive: true,
      },
    },
  );
  if (authoredEnvironmentNotification && transferEnvironmentDeliveryState) {
    transferEnvironmentDeliveryState = {
      ...transferEnvironmentDeliveryState,
      status: transferEnvironmentDeliveryState.status === "degraded_notification_failed"
        ? "degraded_notification_failed"
        : "confirmed_by_server_ordering",
      activateNpcControllers: false,
      confirmedAtMs: toInt(deps.now(), 0),
      entryNpcControllersActivated: true,
      entryNpcActivationDegraded: Boolean(
        npcActivationResult.data && npcActivationResult.data.degraded === true
      ),
      entryComplete: true,
    };
    updateAbyssalClientEnvironmentDeliveryState(
      effectivePocketState,
      session,
      transferEnvironmentDeliveryState,
    );
  }
  recordAbyssalEnvironmentSequenceEvent(
    effectivePocketState,
    session,
    nextRoomIndex,
    "transfer_complete",
    deps,
    { sourceRoomIndex: currentRoomIndex },
  );
  effectivePocketState = advanceAbyssalRoomTransferLifecycle(
    effectivePocketState,
    session,
    deps,
    "complete",
    { fromRoom: currentRoomIndex, toRoom: nextRoomIndex },
  );
  return { effectivePocketState, transferEnvironmentDeliveryState };
}

function completeAbyssalTransferDeliveredRoom({
  getActivePocketStateByInstanceID,
  getPocketScene,
  listCurrentRoomBootstrapEntityIDs,
  markAbyssalRoomContentDelivered,
  activateSuppressorControllersForPocketRoom,
  deliverSuppressorPresentationForSession,
  applyAbyssalWeatherToRun,
  logAbyssalRoomContentActivated,
}, { effectivePocketState, isolatedSceneDescriptor, deps, nextRoomIndex, session }) {
  let completedPocketState =
    getActivePocketStateByInstanceID(toInt(effectivePocketState.instanceID, 0)) ||
    effectivePocketState;
  if (!isolatedSceneDescriptor) {
    const deliveryScene = getPocketScene(completedPocketState, deps);
    const deliveredEntityIDs = listCurrentRoomBootstrapEntityIDs(completedPocketState)
      .filter((entityID) => deliveryScene && deliveryScene.getEntityByID(entityID));
    completedPocketState = markAbyssalRoomContentDelivered(
      completedPocketState,
      deliveredEntityIDs,
      deps,
      {
        roomIndex: nextRoomIndex,
        recipientCount: session ? 1 : 0,
      },
    );
  }
  if (!isolatedSceneDescriptor) {
    activateSuppressorControllersForPocketRoom(
      completedPocketState,
      nextRoomIndex,
      deps,
    );
    deliverSuppressorPresentationForSession(
      completedPocketState,
      session,
      deps,
      {
        roomIndex: nextRoomIndex,
        reason: "room-delivered",
      },
    );
    applyAbyssalWeatherToRun(completedPocketState, session, deps, {
      reason: "room-transfer",
    });
  }
  if (!isolatedSceneDescriptor) {
    logAbyssalRoomContentActivated(
      getActivePocketStateByInstanceID(toInt(completedPocketState.instanceID, 0)) ||
        completedPocketState,
      { roomIndex: nextRoomIndex },
    );
  }
  return completedPocketState;
}

function activateAbyssalTransferDestination({
  activateAbyssalTransferDestinationNpcs,
  activateAbyssalTransferDestinationMechanics,
  finalizeAbyssalTransferDestinationActivation,
  completeAbyssalTransferDeliveredRoom,
}, context) {
  let activation = context;
  if (context.isolatedSceneDescriptor) {
    const npcResult = activateAbyssalTransferDestinationNpcs(activation);
    if (!npcResult.success) return npcResult;
    activation = { ...activation, npcActivationResult: npcResult.npcActivationResult };
    const mechanicsResult = activateAbyssalTransferDestinationMechanics(activation);
    if (!mechanicsResult.success) return mechanicsResult;
    activation = { ...activation, effectivePocketState: mechanicsResult.effectivePocketState };
    activation = { ...activation, ...finalizeAbyssalTransferDestinationActivation(activation) };
  }
  // Legacy scene transfer retains its established mechanics without adding a splash.
  const completedPocketState = completeAbyssalTransferDeliveredRoom(activation);
  return {
    success: true,
    effectivePocketState: activation.effectivePocketState,
    transferEnvironmentDeliveryState: activation.transferEnvironmentDeliveryState,
    completedPocketState,
  };
}

// Capture supplied capabilities once, as the original closure did. Internal
// callbacks are bound once per instance; no runtime state lives in this wiring.
function createAbyssalRoomTransferActivation({
  refreshAbyssalDungeonTrackingState,
  activateAbyssalRoomNpcControllers,
  settleFailedAbyssalDestinationActivation,
  cloneValue,
  activateSuppressorControllersForPocketRoom,
  ensureBoundaryControllerForPocketState,
  getActivePocketStateByInstanceID,
  evaluateEnvironmentalEffectsForPocketState,
  applyAbyssalWeatherToRun,
  getContentProfile,
  buildAbyssalDestinationMechanicsReadiness,
  deliverSuppressorPresentationForSession,
  logAbyssalRoomContentActivated,
  recordAbyssalEnvironmentSequenceEvent,
  advanceAbyssalRoomTransferLifecycle,
  updateAbyssalClientEnvironmentDeliveryState,
  getPocketScene,
  listCurrentRoomBootstrapEntityIDs,
  markAbyssalRoomContentDelivered,
}) {

  const ports = {
    refreshAbyssalDungeonTrackingState,
    activateAbyssalRoomNpcControllers,
    settleFailedAbyssalDestinationActivation,
    cloneValue,
    activateSuppressorControllersForPocketRoom,
    ensureBoundaryControllerForPocketState,
    getActivePocketStateByInstanceID,
    evaluateEnvironmentalEffectsForPocketState,
    applyAbyssalWeatherToRun,
    getContentProfile,
    buildAbyssalDestinationMechanicsReadiness,
    deliverSuppressorPresentationForSession,
    logAbyssalRoomContentActivated,
    recordAbyssalEnvironmentSequenceEvent,
    advanceAbyssalRoomTransferLifecycle,
    updateAbyssalClientEnvironmentDeliveryState,
    getPocketScene,
    listCurrentRoomBootstrapEntityIDs,
    markAbyssalRoomContentDelivered,
  };
  ports.activateAbyssalTransferDestinationNpcs = activateAbyssalTransferDestinationNpcs.bind(null, ports);
  ports.activateAbyssalTransferDestinationMechanics = activateAbyssalTransferDestinationMechanics.bind(null, ports);
  ports.finalizeAbyssalTransferDestinationActivation = finalizeAbyssalTransferDestinationActivation.bind(null, ports);
  ports.completeAbyssalTransferDeliveredRoom = completeAbyssalTransferDeliveredRoom.bind(null, ports);
  ports.activateAbyssalTransferDestination = activateAbyssalTransferDestination.bind(null, ports);
  Object.freeze(ports);
  return { activateAbyssalTransferDestination: ports.activateAbyssalTransferDestination };
}

module.exports = { createAbyssalRoomTransferActivation };
