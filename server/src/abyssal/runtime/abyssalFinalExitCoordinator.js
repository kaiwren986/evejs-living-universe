"use strict";

const ABYSSAL_FINAL_EXIT_STAGE = Object.freeze({
  REVALIDATE: "revalidate",
  RETURN_OTHER_PARTICIPANTS: "return_other_participants",
  RESOLVE_RETURN_TARGET: "resolve_return_target",
  STAGE_RETURN_OBLIGATIONS: "stage_return_obligations",
  QUIESCE_SOURCE: "quiesce_source",
  MOVE_ACTIVATING_PARTICIPANT: "move_activating_participant",
  COMMIT_EXIT_AUTHORITY: "commit_exit_authority",
  COMMIT_TRACE_RETURN: "commit_trace_return",
  DELIVER_ACTIVATING_PARTICIPANT: "deliver_activating_participant",
  APPLY_RETURN_EFFECTS: "apply_return_effects",
  SCHEDULE_FINALIZATION: "schedule_finalization",
  SCHEDULE_HANDOFF: "schedule_handoff",
  COMMIT_EXITED_OUTCOME: "commit_exited_outcome",
  FINAL_CLEANUP: "final_cleanup",
  COMPLETE: "complete",
});

const ABYSSAL_FINAL_EXIT_STATUS = Object.freeze({
  COMPLETED: "completed",
  ALREADY_COMPLETED: "already_completed",
  REJECTED: "rejected",
  FAILED: "failed",
  CONVERGED_FORWARD: "converged_forward",
});

const HANDOFF_STAGES = Object.freeze([
  [ABYSSAL_FINAL_EXIT_STAGE.REVALIDATE, "revalidateFinalExit"],
  [ABYSSAL_FINAL_EXIT_STAGE.RETURN_OTHER_PARTICIPANTS, "returnOtherParticipants"],
  [ABYSSAL_FINAL_EXIT_STAGE.RESOLVE_RETURN_TARGET, "resolveReturnTarget"],
  [ABYSSAL_FINAL_EXIT_STAGE.STAGE_RETURN_OBLIGATIONS, "stageReturnObligations"],
  [ABYSSAL_FINAL_EXIT_STAGE.QUIESCE_SOURCE, "quiesceFinalRoom"],
  [ABYSSAL_FINAL_EXIT_STAGE.MOVE_ACTIVATING_PARTICIPANT, "moveActivatingParticipant"],
  [ABYSSAL_FINAL_EXIT_STAGE.COMMIT_EXIT_AUTHORITY, "commitExitAuthority"],
  [ABYSSAL_FINAL_EXIT_STAGE.COMMIT_TRACE_RETURN, "commitTraceReturn"],
  [ABYSSAL_FINAL_EXIT_STAGE.DELIVER_ACTIVATING_PARTICIPANT, "deliverActivatingParticipant"],
  [ABYSSAL_FINAL_EXIT_STAGE.APPLY_RETURN_EFFECTS, "applyReturnEffects"],
  [ABYSSAL_FINAL_EXIT_STAGE.SCHEDULE_FINALIZATION, "scheduleFinalization"],
]);

const REQUIRED_DEPENDENCIES = Object.freeze([
  ...HANDOFF_STAGES.map(([, dependencyName]) => dependencyName),
  "scheduleFinalExitHandoff",
  "commitExitedOutcome",
  "performFinalCleanup",
  "settleExitFailure",
]);

function toPositiveInt(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function buildIdentity(request = {}) {
  const progression = request.progression && typeof request.progression === "object"
    ? request.progression
    : {};
  return Object.freeze({
    instanceID: toPositiveInt(request.instanceID),
    ownerCharacterID: toPositiveInt(request.ownerCharacterID),
    participantCharacterID: toPositiveInt(request.participantCharacterID),
    shipID: toPositiveInt(request.shipID),
    sourceRoomIndex: toPositiveInt(progression.fromRoomIndex),
    sourceSceneKey: normalizeText(request.sourceSceneKey),
    transitionToken: toPositiveInt(request.transitionToken),
    progressionKind: normalizeText(progression.kind),
  });
}

function identityIsValid(identity, request) {
  const progression = request && request.progression || {};
  return Boolean(
    identity.instanceID > 0 &&
    identity.participantCharacterID > 0 &&
    identity.shipID > 0 &&
    identity.sourceRoomIndex > 0 &&
    identity.sourceSceneKey &&
    identity.transitionToken > 0 &&
    identity.progressionKind === "finalExit" &&
    Number(progression.toRoomIndex) === 0
  );
}

function scheduleIdentityIsValid(identity, request) {
  const progression = request && request.progression || {};
  return Boolean(
    identity.instanceID > 0 &&
    identity.participantCharacterID > 0 &&
    identity.shipID > 0 &&
    identity.sourceRoomIndex > 0 &&
    identity.sourceSceneKey &&
    identity.progressionKind === "finalExit" &&
    Number(progression.toRoomIndex) === 0
  );
}

function identityMatches(expected, actual) {
  return Boolean(
    actual &&
    expected.instanceID === toPositiveInt(actual.instanceID) &&
    expected.participantCharacterID === toPositiveInt(actual.participantCharacterID) &&
    expected.shipID === toPositiveInt(actual.shipID) &&
    expected.sourceRoomIndex === toPositiveInt(actual.sourceRoomIndex) &&
    expected.sourceSceneKey === normalizeText(actual.sourceSceneKey) &&
    expected.transitionToken === toPositiveInt(actual.transitionToken) &&
    expected.progressionKind === normalizeText(actual.progressionKind || "finalExit")
  );
}

function normalizeStageResult(result, fallbackErrorMsg) {
  if (result && typeof result === "object") return result;
  return {
    success: false,
    errorMsg: fallbackErrorMsg,
  };
}

function invoke({ dependencies }, dependencyName, stageRequest, stage) {
  try {
    return normalizeStageResult(
      dependencies[dependencyName](stageRequest),
      `ABYSSAL_FINAL_EXIT_${stage.toUpperCase()}_FAILED`,
    );
  } catch (error) {
    return {
      success: false,
      errorMsg: normalizeText(error && error.message) ||
        `ABYSSAL_FINAL_EXIT_${stage.toUpperCase()}_FAILED`,
    };
  }
}

function settleFailure({ invoke }, request, identity, context, stageResults, details) {
  const sourceCommitIrreversible = Boolean(
    details.sourceCommitIrreversible ||
    details.failureResult && details.failureResult.sourceCommitIrreversible === true,
  );
  const convergenceMode = sourceCommitIrreversible
    ? "converge_forward"
    : "restore_source";
  const alreadySettled = Boolean(
    details.failureResult &&
    (details.failureResult.settlementHandled === true ||
      details.failureResult.terminallySettled === true),
  );
  let settlementResult = alreadySettled
    ? {
        success: details.failureResult.terminallySettled === true,
        alreadySettled: true,
        terminallySettled: details.failureResult.terminallySettled === true,
      }
    : null;
  if (!alreadySettled) {
    settlementResult = invoke(
      "settleExitFailure",
      {
        ...request,
        identity,
        context: { ...context },
        stageResults: { ...stageResults },
        failedStage: details.stage,
        failureResult: details.failureResult,
        sourceCommitIrreversible,
        convergenceMode,
      },
      details.stage,
    );
  }
  return {
    success: false,
    status: sourceCommitIrreversible
      ? ABYSSAL_FINAL_EXIT_STATUS.CONVERGED_FORWARD
      : ABYSSAL_FINAL_EXIT_STATUS.FAILED,
    stage: details.stage,
    identity,
    sourceCommitIrreversible,
    participantsReturned: Math.max(0, Number(context.participantsReturned) || 0),
    receiptsCommitted: context.receiptsCommitted === true,
    exitAuthorityCommitted: context.exitAuthorityCommitted === true,
    traceReturnCommitted: context.traceReturnCommitted === true,
    participantDelivered: context.participantDelivered === true,
    outcomeCommitted: context.outcomeCommitted === true,
    cleanupStarted: context.cleanupStarted === true,
    cleanupCompleted: context.cleanupCompleted === true,
    forwardConvergenceRequired: sourceCommitIrreversible,
    settlementAttempted: true,
    settlementResult,
    convergenceMode,
    degradedStages: [...(context.degradedStages || [])],
    stageResults: { ...stageResults },
    context: { ...context },
    errorMsg: normalizeText(details.failureResult && details.failureResult.errorMsg) ||
      `ABYSSAL_FINAL_EXIT_${details.stage.toUpperCase()}_FAILED`,
  };
}

function executeFinalExit({ invoke, settleFailure }, request = {}) {
  const identity = buildIdentity(request);
  if (!identityIsValid(identity, request)) {
    return {
      success: false,
      status: ABYSSAL_FINAL_EXIT_STATUS.REJECTED,
      stage: "validation",
      identity,
      errorMsg: identity.progressionKind !== "finalExit"
        ? "ABYSSAL_FINAL_EXIT_PROGRESSION_REQUIRED"
        : "ABYSSAL_FINAL_EXIT_IDENTITY_INVALID",
    };
  }
  if (normalizeText(request.runOutcome).toLowerCase() === "exited") {
    return {
      success: true,
      status: ABYSSAL_FINAL_EXIT_STATUS.ALREADY_COMPLETED,
      stage: ABYSSAL_FINAL_EXIT_STAGE.COMPLETE,
      identity,
      sourceCommitIrreversible: true,
      receiptsCommitted: true,
      exitAuthorityCommitted: true,
      traceReturnCommitted: true,
      participantDelivered: true,
      outcomeCommitted: true,
      cleanupCompleted: request.cleanupCompleted === true,
      forwardConvergenceRequired: request.cleanupCompleted !== true,
      stageResults: {},
    };
  }
  if (!["pending", "executing"].includes(normalizeText(request.transitionStatus).toLowerCase())) {
    return {
      success: false,
      status: ABYSSAL_FINAL_EXIT_STATUS.REJECTED,
      stage: "validation",
      identity,
      errorMsg: "ABYSSAL_FINAL_EXIT_TRANSITION_NOT_PENDING",
    };
  }

  const context = {
    participantsReturned: 0,
    otherParticipantReceiptsCommitted: false,
    receiptsCommitted: false,
    exitAuthorityCommitted: false,
    traceReturnCommitted: false,
    participantDelivered: false,
    outcomeCommitted: false,
    cleanupStarted: false,
    cleanupCompleted: false,
    sourceCommitIrreversible: false,
    degradedStages: [],
  };
  const stageResults = {};

  for (const [stage, dependencyName] of HANDOFF_STAGES) {
    const stageRequest = {
      ...request,
      identity,
      stage,
      context: { ...context },
      stageResults: { ...stageResults },
    };
    let stageResult = invoke(dependencyName, stageRequest, stage);
    if (
      stage === ABYSSAL_FINAL_EXIT_STAGE.REVALIDATE &&
      stageResult.success === true &&
      !identityMatches(identity, stageResult.identity)
    ) {
      stageResult = {
        ...stageResult,
        success: false,
        errorMsg: "ABYSSAL_FINAL_EXIT_REVALIDATION_IDENTITY_MISMATCH",
      };
    }
    stageResults[stage] = stageResult;
    if (stageResult.context && typeof stageResult.context === "object") {
      Object.assign(context, stageResult.context);
    }
    if (stageResult.sourceCommitIrreversible === true) {
      context.sourceCommitIrreversible = true;
    }
    if (stage === ABYSSAL_FINAL_EXIT_STAGE.RETURN_OTHER_PARTICIPANTS) {
      const returnedCount = Math.max(
        0,
        Number(stageResult.participantsReturned) ||
          (Array.isArray(stageResult.results) ? stageResult.results.length : 0),
      );
      context.participantsReturned += returnedCount;
      context.otherParticipantReceiptsCommitted =
        stageResult.receiptsCommitted !== false;
      if (returnedCount > 0) context.sourceCommitIrreversible = true;
    }
    if (stageResult.success !== true) {
      if (stageResult.continueExit === true) {
        context.degradedStages.push(stage);
        continue;
      }
      return settleFailure(request, identity, context, stageResults, {
        stage,
        failureResult: stageResult,
        sourceCommitIrreversible: context.sourceCommitIrreversible,
      });
    }
    if (stage === ABYSSAL_FINAL_EXIT_STAGE.MOVE_ACTIVATING_PARTICIPANT) {
      context.sourceCommitIrreversible = true;
      context.participantsReturned += 1;
    } else if (stage === ABYSSAL_FINAL_EXIT_STAGE.COMMIT_EXIT_AUTHORITY) {
      context.exitAuthorityCommitted = true;
      context.receiptsCommitted = true;
    } else if (stage === ABYSSAL_FINAL_EXIT_STAGE.COMMIT_TRACE_RETURN) {
      context.traceReturnCommitted = true;
    } else if (stage === ABYSSAL_FINAL_EXIT_STAGE.DELIVER_ACTIVATING_PARTICIPANT) {
      context.participantDelivered = true;
    }
  }

  return {
    success: true,
    status: ABYSSAL_FINAL_EXIT_STATUS.COMPLETED,
    stage: ABYSSAL_FINAL_EXIT_STAGE.COMPLETE,
    identity,
    sourceCommitIrreversible: context.sourceCommitIrreversible,
    participantsReturned: context.participantsReturned,
    receiptsCommitted: context.receiptsCommitted,
    exitAuthorityCommitted: context.exitAuthorityCommitted,
    traceReturnCommitted: context.traceReturnCommitted,
    participantDelivered: context.participantDelivered,
    outcomeCommitted: context.outcomeCommitted,
    cleanupStarted: context.cleanupStarted,
    cleanupCompleted: context.cleanupCompleted,
    forwardConvergenceRequired: false,
    degradedStages: [...context.degradedStages],
    stageResults,
    context: { ...context },
  };
}

function beginFinalExit({ invoke }, request = {}) {
  const identity = buildIdentity(request);
  if (!scheduleIdentityIsValid(identity, request)) {
    return {
      success: false,
      status: ABYSSAL_FINAL_EXIT_STATUS.REJECTED,
      stage: "validation",
      identity,
      errorMsg: identity.progressionKind !== "finalExit"
        ? "ABYSSAL_FINAL_EXIT_PROGRESSION_REQUIRED"
        : "ABYSSAL_FINAL_EXIT_IDENTITY_INVALID",
    };
  }
  const stage = ABYSSAL_FINAL_EXIT_STAGE.SCHEDULE_HANDOFF;
  const scheduleResult = invoke(
    "scheduleFinalExitHandoff",
    { ...request, identity, stage },
    stage,
  );
  if (scheduleResult.success !== true) {
    return {
      ...scheduleResult,
      success: false,
      status: ABYSSAL_FINAL_EXIT_STATUS.FAILED,
      stage,
      identity,
      sourceCommitIrreversible: false,
      forwardConvergenceRequired: false,
      stageResults: { [stage]: scheduleResult },
      errorMsg: normalizeText(scheduleResult.errorMsg) ||
        "ABYSSAL_FINAL_EXIT_SCHEDULE_HANDOFF_FAILED",
    };
  }
  return {
    ...scheduleResult,
    success: true,
    status: scheduleResult.deferred === true ? "scheduled" : "handoff_completed",
    stage,
    identity,
    stageResults: { [stage]: scheduleResult },
  };
}

function finalizeFinalExit({ invoke, settleFailure }, request = {}) {
  const identity = buildIdentity(request);
  if (!identityIsValid(identity, request)) {
    return {
      success: false,
      status: ABYSSAL_FINAL_EXIT_STATUS.REJECTED,
      stage: "validation",
      identity,
      errorMsg: "ABYSSAL_FINAL_EXIT_IDENTITY_INVALID",
    };
  }
  const context = {
    sourceCommitIrreversible: true,
    receiptsCommitted: request.receiptsCommitted !== false,
    exitAuthorityCommitted: request.exitAuthorityCommitted !== false,
    traceReturnCommitted: request.traceReturnCommitted !== false,
    participantDelivered: request.participantDelivered !== false,
    participantsReturned: Math.max(1, Number(request.participantsReturned) || 1),
    outcomeCommitted: normalizeText(request.runOutcome).toLowerCase() === "exited",
    cleanupStarted: false,
    cleanupCompleted: request.cleanupCompleted === true,
    degradedStages: [],
  };
  const stageResults = {};
  if (!context.outcomeCommitted) {
    const outcomeStage = ABYSSAL_FINAL_EXIT_STAGE.COMMIT_EXITED_OUTCOME;
    const outcomeResult = invoke(
      "commitExitedOutcome",
      { ...request, identity, stage: outcomeStage, context: { ...context } },
      outcomeStage,
    );
    stageResults[outcomeStage] = outcomeResult;
    if (!outcomeResult.success) {
      return settleFailure(request, identity, context, stageResults, {
        stage: outcomeStage,
        failureResult: outcomeResult,
        sourceCommitIrreversible: true,
      });
    }
    context.outcomeCommitted = true;
  }
  if (!context.cleanupCompleted) {
    context.cleanupStarted = true;
    const cleanupStage = ABYSSAL_FINAL_EXIT_STAGE.FINAL_CLEANUP;
    const cleanupResult = invoke(
      "performFinalCleanup",
      { ...request, identity, stage: cleanupStage, context: { ...context } },
      cleanupStage,
    );
    stageResults[cleanupStage] = cleanupResult;
    if (!cleanupResult.success) {
      return settleFailure(request, identity, context, stageResults, {
        stage: cleanupStage,
        failureResult: cleanupResult,
        sourceCommitIrreversible: true,
      });
    }
    context.cleanupCompleted = true;
  }
  return {
    success: true,
    status: ABYSSAL_FINAL_EXIT_STATUS.COMPLETED,
    stage: ABYSSAL_FINAL_EXIT_STAGE.COMPLETE,
    identity,
    sourceCommitIrreversible: true,
    participantsReturned: context.participantsReturned,
    receiptsCommitted: context.receiptsCommitted,
    exitAuthorityCommitted: context.exitAuthorityCommitted,
    traceReturnCommitted: context.traceReturnCommitted,
    participantDelivered: context.participantDelivered,
    outcomeCommitted: context.outcomeCommitted,
    cleanupStarted: context.cleanupStarted,
    cleanupCompleted: context.cleanupCompleted,
    forwardConvergenceRequired: false,
    stageResults,
    context,
  };
}

function createAbyssalFinalExitCoordinator(dependencies = {}) {
  for (const dependencyName of REQUIRED_DEPENDENCIES) {
    if (typeof dependencies[dependencyName] !== "function") {
      throw new TypeError(`${dependencyName} dependency is required`);
    }
  }
  const ports = { dependencies };
  ports.invoke = invoke.bind(null, ports);
  ports.settleFailure = settleFailure.bind(null, ports);
  ports.executeFinalExit = executeFinalExit.bind(null, ports);
  ports.beginFinalExit = beginFinalExit.bind(null, ports);
  ports.finalizeFinalExit = finalizeFinalExit.bind(null, ports);
  Object.freeze(ports);
  return Object.freeze({
    beginFinalExit: ports.beginFinalExit,
    executeFinalExit: ports.executeFinalExit,
    finalizeFinalExit: ports.finalizeFinalExit,
  });
}

module.exports = {
  ABYSSAL_FINAL_EXIT_STAGE,
  ABYSSAL_FINAL_EXIT_STATUS,
  createAbyssalFinalExitCoordinator,
};
