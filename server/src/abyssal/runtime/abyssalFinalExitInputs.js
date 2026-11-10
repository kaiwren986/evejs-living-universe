"use strict";
const { toInt, normalizeText } = require("../domain/abyssalRuntimeValues");

function createComposedAbyssalFinalExitCoordinator(ports, capabilities = {}) {
  const {
    createAbyssalFinalExitCoordinator,
  } = ports;
  const unavailable = (name) => () => ({
    success: false,
    errorMsg: `ABYSSAL_FINAL_EXIT_${name.toUpperCase()}_UNAVAILABLE`,
  });
  return createAbyssalFinalExitCoordinator({
    revalidateFinalExit: unavailable("revalidate"),
    returnOtherParticipants: unavailable("return_other_participants"),
    resolveReturnTarget: unavailable("resolve_return_target"),
    stageReturnObligations: unavailable("stage_return_obligations"),
    quiesceFinalRoom: unavailable("quiesce_source"),
    moveActivatingParticipant: unavailable("move_activating_participant"),
    commitExitAuthority: unavailable("commit_exit_authority"),
    commitTraceReturn: unavailable("commit_trace_return"),
    deliverActivatingParticipant: unavailable("deliver_activating_participant"),
    applyReturnEffects: unavailable("apply_return_effects"),
    scheduleFinalization: unavailable("schedule_finalization"),
    scheduleFinalExitHandoff: unavailable("schedule_handoff"),
    commitExitedOutcome: unavailable("commit_exited_outcome"),
    performFinalCleanup: unavailable("final_cleanup"),
    settleExitFailure: unavailable("settlement"),
    ...capabilities,
  });
}

function buildAbyssalFinalExitCoordinatorRequest(ports, pocketState, overrides = {}) {
  const {
    getPendingAbyssalTransitionState,
    buildPlaceholderRoomState,
    normalizeAbyssalRunOutcome,
  } = ports;
  const pendingTransitionState = getPendingAbyssalTransitionState(pocketState) || {};
  const committedExitState = pocketState && pocketState.committedExitState || {};
  const roomState = buildPlaceholderRoomState(pocketState || {});
  const instanceID = toInt(pocketState && pocketState.instanceID, 0);
  return {
    instanceID,
    ownerCharacterID: toInt(pocketState && pocketState.characterID, 0),
    participantCharacterID: toInt(
      committedExitState.characterID,
      toInt(pocketState && pocketState.characterID, 0),
    ),
    shipID: toInt(
      committedExitState.shipID,
      toInt(pocketState && pocketState.shipID, 0),
    ),
    sourceSceneKey: normalizeText(
      pendingTransitionState.sourceSceneID,
      `abyssal-run:${instanceID}`,
    ),
    transitionToken: toInt(
      pendingTransitionState.token,
      toInt(committedExitState.committedAtMs, instanceID),
    ),
    transitionStatus: normalizeText(pendingTransitionState.status, "pending"),
    runOutcome: normalizeAbyssalRunOutcome(pocketState && pocketState.runOutcome),
    progression: {
      kind: "finalExit",
      fromRoomIndex: toInt(
        pendingTransitionState.sourceRoomIndex,
        roomState.currentRoomIndex,
      ),
      toRoomIndex: 0,
    },
    ...overrides,
  };
}

function createAbyssalFinalExitInputs(ports) {
  return {
    createComposedAbyssalFinalExitCoordinator: createComposedAbyssalFinalExitCoordinator.bind(null, ports),
    buildAbyssalFinalExitCoordinatorRequest: buildAbyssalFinalExitCoordinatorRequest.bind(null, ports),
  };
}

module.exports = { createAbyssalFinalExitInputs };
