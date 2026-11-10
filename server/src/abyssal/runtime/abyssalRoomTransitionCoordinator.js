"use strict";

const ABYSSAL_ROOM_TRANSITION_STAGE = Object.freeze({
  REVALIDATE: "revalidate",
  COMMIT_SOURCE: "commit_source",
  DELIVER_PARTICIPANTS: "deliver_participants",
  CLEANUP_SOURCE: "cleanup_source",
  PREPARE_DESTINATION_STATE: "prepare_destination_state",
  PUBLISH_DESTINATION: "publish_destination",
  ACTIVATE_DESTINATION: "activate_destination",
  COMMIT_TRANSITION: "commit_transition",
  COMPLETE: "complete",
});

const ABYSSAL_ROOM_TRANSITION_STATUS = Object.freeze({
  COMPLETED: "completed",
  ALREADY_COMPLETED: "already_completed",
  REJECTED: "rejected",
  FAILED: "failed",
  CONVERGED_FORWARD: "converged_forward",
});

const EFFECT_STAGES = Object.freeze([
  [ABYSSAL_ROOM_TRANSITION_STAGE.COMMIT_SOURCE, "commitSourceRoom"],
  [ABYSSAL_ROOM_TRANSITION_STAGE.DELIVER_PARTICIPANTS, "deliverParticipants"],
  [ABYSSAL_ROOM_TRANSITION_STAGE.CLEANUP_SOURCE, "cleanupSourceRoom"],
  [ABYSSAL_ROOM_TRANSITION_STAGE.PREPARE_DESTINATION_STATE, "prepareDestinationState"],
  [ABYSSAL_ROOM_TRANSITION_STAGE.PUBLISH_DESTINATION, "publishDestination"],
  [ABYSSAL_ROOM_TRANSITION_STAGE.ACTIVATE_DESTINATION, "activateDestination"],
  [ABYSSAL_ROOM_TRANSITION_STAGE.COMMIT_TRANSITION, "commitTransition"],
]);

function toInteger(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function normalizeText(value, fallback = "") {
  const normalized = String(value == null ? "" : value).trim();
  return normalized || fallback;
}

function buildIdentity(request = {}) {
  const progression = request.progression && typeof request.progression === "object"
    ? request.progression
    : {};
  return Object.freeze({
    instanceID: toInteger(request.instanceID, 0),
    participantCharacterID: toInteger(request.participantCharacterID, 0),
    shipID: toInteger(request.shipID, 0),
    fromRoomIndex: toInteger(
      progression.fromRoomIndex,
      toInteger(request.fromRoomIndex, 0),
    ),
    toRoomIndex: toInteger(
      progression.toRoomIndex,
      toInteger(request.toRoomIndex, 0),
    ),
    progressionKind: normalizeText(progression.kind, ""),
    sourceSceneKey: normalizeText(request.sourceSceneKey, ""),
    destinationSceneKey: normalizeText(request.destinationSceneKey, ""),
    transitionToken: toInteger(request.transitionToken, 0),
  });
}

function validateRequest(request, identity) {
  if (identity.progressionKind !== "nextRoom") {
    return identity.progressionKind === "finalExit"
      ? "ABYSSAL_ROOM_TRANSITION_FINAL_EXIT_OUT_OF_SCOPE"
      : "ABYSSAL_ROOM_TRANSITION_PROGRESSION_INVALID";
  }
  if (
    identity.instanceID <= 0 ||
    identity.participantCharacterID <= 0 ||
    identity.shipID <= 0 ||
    identity.fromRoomIndex <= 0 ||
    identity.toRoomIndex !== identity.fromRoomIndex + 1 ||
    !identity.sourceSceneKey ||
    !identity.destinationSceneKey ||
    identity.transitionToken <= 0
  ) {
    return "ABYSSAL_ROOM_TRANSITION_IDENTITY_INVALID";
  }
  if (
    request.transitionStatus === "completed" &&
    toInteger(request.committedRoomIndex, 0) !== identity.toRoomIndex
  ) {
    return "ABYSSAL_ROOM_TRANSITION_COMPLETION_IDENTITY_MISMATCH";
  }
  if (
    request.transitionStatus &&
    !["pending", "completed"].includes(normalizeText(request.transitionStatus, ""))
  ) {
    return "ABYSSAL_ROOM_TRANSITION_NOT_PENDING";
  }
  return "";
}

function identityMatches(expected, candidate = {}) {
  return Boolean(
    candidate &&
    toInteger(candidate.instanceID, 0) === expected.instanceID &&
    toInteger(candidate.participantCharacterID, 0) ===
      expected.participantCharacterID &&
    toInteger(candidate.shipID, 0) === expected.shipID &&
    toInteger(candidate.fromRoomIndex, 0) === expected.fromRoomIndex &&
    toInteger(candidate.toRoomIndex, 0) === expected.toRoomIndex &&
    toInteger(candidate.transitionToken, 0) === expected.transitionToken &&
    normalizeText(candidate.sourceSceneKey, "") === expected.sourceSceneKey &&
    normalizeText(candidate.destinationSceneKey, "") ===
      expected.destinationSceneKey
  );
}

function buildResult(identity, patch = {}) {
  return {
    success: false,
    status: ABYSSAL_ROOM_TRANSITION_STATUS.FAILED,
    stage: ABYSSAL_ROOM_TRANSITION_STAGE.REVALIDATE,
    identity,
    sourceCommitted: false,
    participantDelivered: false,
    sourceCleaned: false,
    destinationPrepared: false,
    destinationPublished: false,
    destinationActivated: false,
    transitionCommitted: false,
    rollbackAttempted: false,
    rollbackSucceeded: false,
    convergenceMode: "",
    degradedStages: [],
    stageResults: {},
    errorMsg: "",
    ...patch,
  };
}

function normalizeStageResult(result, fallbackError) {
  if (!result || typeof result !== "object") {
    return {
      success: false,
      errorMsg: fallbackError,
    };
  }
  return {
    ...result,
    success: result.success === true,
    errorMsg: normalizeText(result.errorMsg, result.success === true ? "" : fallbackError),
  };
}

function buildStageRequest(attempt, stage) {
  const { identity, stageResults } = attempt;
  return Object.freeze({
    stage,
    identity,
    progression: Object.freeze({
      kind: "nextRoom",
      fromRoomIndex: identity.fromRoomIndex,
      toRoomIndex: identity.toRoomIndex,
    }),
    instanceID: identity.instanceID,
    participantCharacterID: identity.participantCharacterID,
    shipID: identity.shipID,
    fromRoomIndex: identity.fromRoomIndex,
    toRoomIndex: identity.toRoomIndex,
    sourceSceneKey: identity.sourceSceneKey,
    destinationSceneKey: identity.destinationSceneKey,
    transitionToken: identity.transitionToken,
    stageResults: Object.freeze({ ...stageResults }),
  });
}

function invokeStage(attempt, dependencyName, stage) {
  try {
    return normalizeStageResult(
      attempt.dependencies[dependencyName](buildStageRequest(attempt, stage)),
      `ABYSSAL_ROOM_TRANSITION_${stage.toUpperCase()}_FAILED`,
    );
  } catch (error) {
    return {
      success: false,
      errorMsg: normalizeText(
        error && error.message,
        `ABYSSAL_ROOM_TRANSITION_${stage.toUpperCase()}_THREW`,
      ),
      thrownError: error,
    };
  }
}

function readTransitionProgress(attempt) {
  return {
    sourceCommitted: attempt.sourceCommitted,
    participantDelivered: attempt.participantDelivered,
    sourceCleaned: attempt.sourceCleaned,
    destinationPrepared: attempt.destinationPrepared,
    destinationPublished: attempt.destinationPublished,
    destinationActivated: attempt.destinationActivated,
    transitionCommitted: attempt.transitionCommitted,
  };
}

function settleTransitionFailure(attempt, stage, stageResult) {
  const effectiveSourceCommitted = Boolean(
    attempt.sourceCommitted || stageResult.sourceCommitIrreversible === true,
  );
  const convergenceMode = effectiveSourceCommitted
    ? "converge_forward"
    : "restore_source";
  let rollbackResult = null;
  let rollbackAttempted = false;
  if (stageResult.settlementHandled === true) {
    rollbackAttempted = stageResult.rollbackAttempted === true ||
      stageResult.sourceCommitIrreversible === true ||
      stageResult.terminallySettled === true;
    rollbackResult = stageResult.rollbackResult || stageResult;
  } else {
    rollbackAttempted = true;
    try {
      rollbackResult = attempt.dependencies.rollbackTransition(Object.freeze({
        ...buildStageRequest(attempt, stage),
        failedStage: stage,
        failureResult: stageResult,
        convergenceMode,
        ...readTransitionProgress(attempt),
        sourceCommitted: effectiveSourceCommitted,
      }));
    } catch (error) {
      rollbackResult = {
        success: false,
        errorMsg: normalizeText(
          error && error.message,
          "ABYSSAL_ROOM_TRANSITION_ROLLBACK_THREW",
        ),
        thrownError: error,
      };
    }
  }
  const rollbackSucceeded = Boolean(
    rollbackResult &&
    (rollbackResult.success === true || rollbackResult.terminallySettled === true)
  );
  return buildResult(attempt.identity, {
    status: effectiveSourceCommitted
      ? ABYSSAL_ROOM_TRANSITION_STATUS.CONVERGED_FORWARD
      : ABYSSAL_ROOM_TRANSITION_STATUS.FAILED,
    stage,
    ...readTransitionProgress(attempt),
    sourceCommitted: effectiveSourceCommitted,
    rollbackAttempted,
    rollbackSucceeded,
    rollbackResult,
    convergenceMode,
    degradedStages: [...attempt.degradedStages],
    stageResults: { ...attempt.stageResults },
    errorMsg: normalizeText(
      stageResult.errorMsg,
      `ABYSSAL_ROOM_TRANSITION_${stage.toUpperCase()}_FAILED`,
    ),
  });
}

function recordTransitionProgress(attempt, stage, stageResult) {
  if (stage === ABYSSAL_ROOM_TRANSITION_STAGE.COMMIT_SOURCE) {
    attempt.sourceCommitted = true;
  } else if (stage === ABYSSAL_ROOM_TRANSITION_STAGE.DELIVER_PARTICIPANTS) {
    attempt.participantDelivered = true;
  } else if (stage === ABYSSAL_ROOM_TRANSITION_STAGE.CLEANUP_SOURCE) {
    attempt.sourceCleaned = stageResult.success;
  } else if (stage === ABYSSAL_ROOM_TRANSITION_STAGE.PREPARE_DESTINATION_STATE) {
    attempt.destinationPrepared = true;
  } else if (stage === ABYSSAL_ROOM_TRANSITION_STAGE.PUBLISH_DESTINATION) {
    attempt.destinationPublished = true;
  } else if (stage === ABYSSAL_ROOM_TRANSITION_STAGE.ACTIVATE_DESTINATION) {
    attempt.destinationActivated = true;
  } else if (stage === ABYSSAL_ROOM_TRANSITION_STAGE.COMMIT_TRANSITION) {
    attempt.transitionCommitted = true;
  }
}

function executeRoomTransition(dependencies, request = {}) {
  const identity = buildIdentity(request);
  const validationError = validateRequest(request, identity);
  if (validationError) {
    return buildResult(identity, {
      status: ABYSSAL_ROOM_TRANSITION_STATUS.REJECTED,
      errorMsg: validationError,
    });
  }
  if (request.transitionStatus === "completed") {
    return buildResult(identity, {
      success: true,
      status: ABYSSAL_ROOM_TRANSITION_STATUS.ALREADY_COMPLETED,
      stage: ABYSSAL_ROOM_TRANSITION_STAGE.COMPLETE,
      sourceCommitted: true,
      participantDelivered: true,
      sourceCleaned: true,
      destinationPrepared: true,
      destinationPublished: true,
      destinationActivated: true,
      transitionCommitted: true,
    });
  }

  // Per-execution progress, never retained by the factory or shared across runs.
  const attempt = {
    dependencies,
    identity,
    stageResults: {},
    degradedStages: [],
    sourceCommitted: false,
    participantDelivered: false,
    sourceCleaned: false,
    destinationPrepared: false,
    destinationPublished: false,
    destinationActivated: false,
    transitionCommitted: false,
  };
  const revalidationResult = invokeStage(
    attempt, "revalidateTransition", ABYSSAL_ROOM_TRANSITION_STAGE.REVALIDATE,
  );
  attempt.stageResults[ABYSSAL_ROOM_TRANSITION_STAGE.REVALIDATE] = revalidationResult;
  if (!revalidationResult.success || !identityMatches(identity, revalidationResult.identity)) {
    return settleTransitionFailure(
      attempt,
      ABYSSAL_ROOM_TRANSITION_STAGE.REVALIDATE,
      revalidationResult.success
        ? {
            ...revalidationResult,
            success: false,
            errorMsg: "ABYSSAL_ROOM_TRANSITION_REVALIDATION_IDENTITY_MISMATCH",
          }
        : revalidationResult,
    );
  }

  for (const [stage, dependencyName] of EFFECT_STAGES) {
    const stageResult = invokeStage(attempt, dependencyName, stage);
    attempt.stageResults[stage] = stageResult;
    if (!stageResult.success) {
      if (stageResult.continueTransition === true) {
        attempt.degradedStages.push(stage);
      } else {
        return settleTransitionFailure(attempt, stage, stageResult);
      }
    }
    recordTransitionProgress(attempt, stage, stageResult);
  }

  return buildResult(identity, {
    success: true,
    status: ABYSSAL_ROOM_TRANSITION_STATUS.COMPLETED,
    stage: ABYSSAL_ROOM_TRANSITION_STAGE.COMPLETE,
    ...readTransitionProgress(attempt),
    degradedStages: attempt.degradedStages,
    stageResults: attempt.stageResults,
  });
}

function createAbyssalRoomTransitionCoordinator(dependencies = {}) {
  const requiredDependencies = [
    "revalidateTransition",
    ...EFFECT_STAGES.map(([, dependencyName]) => dependencyName),
    "rollbackTransition",
  ];
  for (const dependencyName of requiredDependencies) {
    if (typeof dependencies[dependencyName] !== "function") {
      throw new TypeError(`${dependencyName} dependency is required`);
    }
  }
  return Object.freeze({ executeRoomTransition: executeRoomTransition.bind(null, dependencies) });
}

module.exports = {
  ABYSSAL_ROOM_TRANSITION_STAGE,
  ABYSSAL_ROOM_TRANSITION_STATUS,
  createAbyssalRoomTransitionCoordinator,
};
