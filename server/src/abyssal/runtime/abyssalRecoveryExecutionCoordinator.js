"use strict";

const ABYSSAL_RECOVERY_EXECUTION_STAGE = Object.freeze({
  REVALIDATE: "revalidate_recovery",
  STAGE_OBLIGATION: "stage_recovery_obligation",
  RECONCILE_OR_MOVE: "reconcile_or_move_participant",
  COMMIT_MOVEMENT_AUTHORITY: "commit_movement_authority",
  RECONCILE_SESSION: "reconcile_session",
  VERIFY_RETURN: "verify_participant_return",
  COMMIT_RECEIPT: "commit_recovery_receipt",
  CLEANUP: "perform_recovery_cleanup",
  SETTLE_OBLIGATION: "settle_recovery_obligation",
  COMPLETE: "complete",
});

const ABYSSAL_RECOVERY_EXECUTION_STATUS = Object.freeze({
  COMPLETED: "completed",
  ALREADY_RECOVERED: "already_recovered",
  EMERGENCY_RELOCATED: "emergency_relocated",
  UNRESOLVED_ORIGIN: "unresolved_origin",
  REJECTED: "rejected",
  FAILED: "failed",
  FORWARD_CONVERGENCE_REQUIRED: "forward_convergence_required",
  DEGRADED: "degraded",
});

const EXECUTION_STAGES = Object.freeze([
  [ABYSSAL_RECOVERY_EXECUTION_STAGE.REVALIDATE, "revalidateRecovery"],
  [ABYSSAL_RECOVERY_EXECUTION_STAGE.STAGE_OBLIGATION, "stageRecoveryObligation"],
  [ABYSSAL_RECOVERY_EXECUTION_STAGE.RECONCILE_OR_MOVE, "reconcileOrMoveParticipant"],
  [ABYSSAL_RECOVERY_EXECUTION_STAGE.COMMIT_MOVEMENT_AUTHORITY, "commitMovementAuthority"],
  [ABYSSAL_RECOVERY_EXECUTION_STAGE.RECONCILE_SESSION, "reconcileSession"],
  [ABYSSAL_RECOVERY_EXECUTION_STAGE.VERIFY_RETURN, "verifyParticipantReturn"],
  [ABYSSAL_RECOVERY_EXECUTION_STAGE.COMMIT_RECEIPT, "commitRecoveryReceipt"],
  [ABYSSAL_RECOVERY_EXECUTION_STAGE.CLEANUP, "performRecoveryCleanup"],
]);

const REQUIRED_DEPENDENCIES = Object.freeze([
  ...EXECUTION_STAGES.map(([, dependencyName]) => dependencyName),
  "settleRecoveryObligation",
]);

function toInteger(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function normalizeText(value, fallback = "") {
  const normalized = String(value == null ? "" : value).trim();
  return normalized || fallback;
}

function normalizePosition(position) {
  const source = position && typeof position === "object" ? position : {};
  return Object.freeze({
    x: Number.isFinite(Number(source.x)) ? Number(source.x) : 0,
    y: Number.isFinite(Number(source.y)) ? Number(source.y) : 0,
    z: Number.isFinite(Number(source.z)) ? Number(source.z) : 0,
  });
}

function normalizeDestinationDecision(decision = {}) {
  const status = normalizeText(decision.status, "unresolved");
  const originResolved = decision.originResolved === true;
  const source = normalizeText(decision.source, "");
  const systemID = toInteger(
    decision.systemID,
    toInteger(decision.destinationSystemID, 0),
  );
  return Object.freeze({
    status,
    source: source || null,
    originResolved,
    systemID: systemID > 0 ? systemID : null,
    position: normalizePosition(decision.position),
    originResolutionReason: originResolved
      ? null
      : normalizeText(decision.originResolutionReason, "RECOVERY_ORIGIN_UNRESOLVED"),
    emergencyFallbackSelected:
      decision.emergencyFallbackSelected === true || status === "emergencyFallback",
  });
}

function buildIdentity(request = {}) {
  return Object.freeze({
    instanceID: toInteger(request.instanceID, 0),
    characterID: toInteger(request.characterID, 0),
    shipID: toInteger(request.shipID, 0),
    hostLocationID: toInteger(request.hostLocationID, 0),
    sourceSceneKey: normalizeText(request.sourceSceneKey, ""),
  });
}

function validateRequest(request, identity, destinationDecision) {
  const syntheticOrphanRecovery = Boolean(
    request && request.durableState && request.durableState.syntheticOrphanRecovery === true,
  );
  if (
    identity.characterID <= 0 ||
    identity.shipID <= 0 ||
    identity.hostLocationID <= 0 ||
    (identity.instanceID <= 0 && !syntheticOrphanRecovery)
  ) {
    return "ABYSSAL_RECOVERY_EXECUTION_IDENTITY_INVALID";
  }
  if (destinationDecision.status === "unresolved") {
    return null;
  }
  if (!destinationDecision.systemID) {
    return "ABYSSAL_RECOVERY_EXECUTION_DESTINATION_INVALID";
  }
  if (
    destinationDecision.status === "authoritative" &&
    (
      destinationDecision.originResolved !== true ||
      !destinationDecision.source ||
      destinationDecision.emergencyFallbackSelected === true
    )
  ) {
    return "ABYSSAL_RECOVERY_EXECUTION_AUTHORITY_INVALID";
  }
  if (
    destinationDecision.status === "emergencyFallback" &&
    (
      destinationDecision.originResolved !== false ||
      destinationDecision.source !== "emergencyFallback" ||
      destinationDecision.emergencyFallbackSelected !== true
    )
  ) {
    return "ABYSSAL_RECOVERY_EXECUTION_EMERGENCY_AUTHORITY_INVALID";
  }
  if (!["authoritative", "emergencyFallback"].includes(destinationDecision.status)) {
    return "ABYSSAL_RECOVERY_EXECUTION_DESTINATION_STATUS_INVALID";
  }
  return null;
}

function identityMatches(expected, actual) {
  return Boolean(
    actual &&
    expected.instanceID === toInteger(actual.instanceID, 0) &&
    expected.characterID === toInteger(actual.characterID, 0) &&
    expected.shipID === toInteger(actual.shipID, 0) &&
    expected.hostLocationID === toInteger(actual.hostLocationID, 0) &&
    expected.sourceSceneKey === normalizeText(actual.sourceSceneKey, "")
  );
}

function positionsMatch(left, right) {
  const a = normalizePosition(left);
  const b = normalizePosition(right);
  return a.x === b.x && a.y === b.y && a.z === b.z;
}

function destinationMatches(expected, actual) {
  if (!actual) return true;
  const normalized = normalizeDestinationDecision(actual);
  return Boolean(
    expected.status === normalized.status &&
    expected.source === normalized.source &&
    expected.originResolved === normalized.originResolved &&
    expected.systemID === normalized.systemID &&
    expected.originResolutionReason === normalized.originResolutionReason &&
    expected.emergencyFallbackSelected === normalized.emergencyFallbackSelected &&
    positionsMatch(expected.position, normalized.position)
  );
}

function normalizeStageResult(result, fallbackErrorMsg) {
  if (result && typeof result === "object") return result;
  return { success: false, errorMsg: fallbackErrorMsg };
}

function invoke(dependencies, dependencyName, stageRequest, stage) {
  try {
    return normalizeStageResult(
      dependencies[dependencyName](stageRequest),
      `ABYSSAL_RECOVERY_EXECUTION_${stage.toUpperCase()}_FAILED`,
    );
  } catch (error) {
    return {
      success: false,
      errorMsg: normalizeText(error && error.message) ||
        `ABYSSAL_RECOVERY_EXECUTION_${stage.toUpperCase()}_FAILED`,
    };
  }
}

function buildStageRequest(request,
  identity,
  destinationDecision,
  stage,
  context,
  stageResults,
  extra = {}) {
  return {
  ...request,
  identity,
  destinationDecision,
  stage,
  context: { ...context },
  stageResults: { ...stageResults },
  ...extra,
};
}

function settleObligation(dependencies,
  request,
  identity,
  destinationDecision,
  context,
  stageResults,
  disposition,
  failedStage = null,
  failureResult = null,
) {
  if (!context.obligationStaged) return null;
  const stage = ABYSSAL_RECOVERY_EXECUTION_STAGE.SETTLE_OBLIGATION;
  const settlementResult = invoke(dependencies,
    "settleRecoveryObligation",
    buildStageRequest(
      request,
      identity,
      destinationDecision,
      stage,
      context,
      stageResults,
      {
        disposition,
        failedStage,
        failureResult,
        sourceCommitIrreversible: context.sourceCommitIrreversible,
      },
    ),
    stage,
  );
  stageResults[stage] = settlementResult;
  return settlementResult;
}

function buildFailureResult(dependencies,
  request,
  identity,
  destinationDecision,
  context,
  stageResults,
  stage,
  failureResult,
  settlementResultOverride,
) {
  const forwardConvergenceRequired = context.sourceCommitIrreversible === true;
  const settlementResult = settlementResultOverride === undefined
    ? settleObligation(dependencies,
        request,
        identity,
        destinationDecision,
        context,
        stageResults,
        forwardConvergenceRequired ? "forward_convergence_required" : "failed",
        stage,
        failureResult,
      )
    : settlementResultOverride;
  return {
    success: false,
    status: forwardConvergenceRequired
      ? ABYSSAL_RECOVERY_EXECUTION_STATUS.FORWARD_CONVERGENCE_REQUIRED
      : ABYSSAL_RECOVERY_EXECUTION_STATUS.FAILED,
    stage,
    identity,
    destinationDecision,
    sourceCommitIrreversible: forwardConvergenceRequired,
    forwardConvergenceRequired,
    moved: context.moved,
    alreadyAtReturnTarget: context.alreadyAtReturnTarget,
    returnVerified: context.returnVerified,
    receiptCommitted: context.receiptCommitted,
    cleanupCompleted: context.cleanupCompleted,
    originResolved: destinationDecision.originResolved,
    recoveryTargetSource: destinationDecision.source,
    returnSystemID: destinationDecision.systemID,
    emergencyFallbackSelected: destinationDecision.emergencyFallbackSelected,
    errorMsg: normalizeText(failureResult && failureResult.errorMsg) ||
      `ABYSSAL_RECOVERY_EXECUTION_${stage.toUpperCase()}_FAILED`,
    settlementResult,
    stageResults: { ...stageResults },
    context: { ...context },
  };
}

function settleRecoveryStageFailure(dependencies, request, identity, destinationDecision, context, stageResults, stage, stageResult) {

  if (stage === ABYSSAL_RECOVERY_EXECUTION_STAGE.CLEANUP) {
    const settlementResult = settleObligation(dependencies,
      request,
      identity,
      destinationDecision,
      context,
      stageResults,
      "cleanup_pending",
      stage,
      stageResult,
    );
    if (!settlementResult || settlementResult.success !== true) {
      return buildFailureResult(dependencies,
        request,
        identity,
        destinationDecision,
        context,
        stageResults,
        stage,
        stageResult,
        settlementResult,
      );
    }
    return {
      success: true,
      status: ABYSSAL_RECOVERY_EXECUTION_STATUS.DEGRADED,
      stage: ABYSSAL_RECOVERY_EXECUTION_STAGE.COMPLETE,
      identity,
      destinationDecision,
      sourceCommitIrreversible: true,
      forwardConvergenceRequired: true,
      moved: context.moved,
      alreadyAtReturnTarget: context.alreadyAtReturnTarget,
      returnVerified: context.returnVerified,
      receiptCommitted: context.receiptCommitted,
      cleanupCompleted: false,
      originResolved: destinationDecision.originResolved,
      recoveryTargetSource: destinationDecision.source,
      returnSystemID: destinationDecision.systemID,
      emergencyFallbackSelected: destinationDecision.emergencyFallbackSelected,
      cleanupResult: stageResult,
      settlementResult,
      stageResults: { ...stageResults },
      context: { ...context },
    };
  }
  return buildFailureResult(dependencies,
    request,
    identity,
    destinationDecision,
    context,
    stageResults,
    stage,
    stageResult,
  );
}

function recordRecoveryStageProgress(context, stage, stageResult) {
  if (stage === ABYSSAL_RECOVERY_EXECUTION_STAGE.STAGE_OBLIGATION) {
    context.obligationStaged = true;
  } else if (stage === ABYSSAL_RECOVERY_EXECUTION_STAGE.RECONCILE_OR_MOVE) {
    context.sourceCommitIrreversible = true;
    context.alreadyAtReturnTarget = stageResult.alreadyAtReturnTarget === true;
    context.moved = !context.alreadyAtReturnTarget && stageResult.moved !== false;
  } else if (stage === ABYSSAL_RECOVERY_EXECUTION_STAGE.COMMIT_MOVEMENT_AUTHORITY) {
    context.movementAuthorityCommitted = true;
  } else if (stage === ABYSSAL_RECOVERY_EXECUTION_STAGE.RECONCILE_SESSION) {
    context.sessionReconciled = true;
  } else if (stage === ABYSSAL_RECOVERY_EXECUTION_STAGE.VERIFY_RETURN) {
    context.returnVerified = true;
  } else if (stage === ABYSSAL_RECOVERY_EXECUTION_STAGE.COMMIT_RECEIPT) {
    context.receiptCommitted = true;
  } else if (stage === ABYSSAL_RECOVERY_EXECUTION_STAGE.CLEANUP) {
    context.cleanupCompleted = true;
  }
}

function completeRecoveryExecution(dependencies, request, identity, destinationDecision, context, stageResults) {
  const settlementResult = settleObligation(dependencies,
    request,
    identity,
    destinationDecision,
    context,
    stageResults,
    "complete",
  );
  if (!settlementResult || settlementResult.success !== true) {
    return buildFailureResult(dependencies,
      request,
      identity,
      destinationDecision,
      context,
      stageResults,
      ABYSSAL_RECOVERY_EXECUTION_STAGE.SETTLE_OBLIGATION,
      settlementResult,
      settlementResult,
    );
  }

  const status = destinationDecision.status === "emergencyFallback"
    ? ABYSSAL_RECOVERY_EXECUTION_STATUS.EMERGENCY_RELOCATED
    : context.alreadyAtReturnTarget
      ? ABYSSAL_RECOVERY_EXECUTION_STATUS.ALREADY_RECOVERED
      : ABYSSAL_RECOVERY_EXECUTION_STATUS.COMPLETED;
  return {
    success: true,
    status,
    stage: ABYSSAL_RECOVERY_EXECUTION_STAGE.COMPLETE,
    identity,
    destinationDecision,
    sourceCommitIrreversible: true,
    forwardConvergenceRequired: false,
    moved: context.moved,
    alreadyAtReturnTarget: context.alreadyAtReturnTarget,
    returnVerified: context.returnVerified,
    receiptCommitted: context.receiptCommitted,
    cleanupCompleted: context.cleanupCompleted,
    originResolved: destinationDecision.originResolved,
    recoveryTargetSource: destinationDecision.source,
    returnSystemID: destinationDecision.systemID,
    emergencyFallbackSelected: destinationDecision.emergencyFallbackSelected,
    cleanupResult: stageResults[ABYSSAL_RECOVERY_EXECUTION_STAGE.CLEANUP],
    settlementResult,
    stageResults: { ...stageResults },
    context: { ...context },
  };
}

function executeRecoveryStages(dependencies, request = {}) {
  const identity = buildIdentity(request);
  const destinationDecision = normalizeDestinationDecision(
    request.destinationDecision,
  );
  const validationError = validateRequest(request, identity, destinationDecision);
  if (validationError) {
    return {
      success: false,
      status: ABYSSAL_RECOVERY_EXECUTION_STATUS.REJECTED,
      stage: "validation",
      identity,
      destinationDecision,
      sourceCommitIrreversible: false,
      forwardConvergenceRequired: false,
      errorMsg: validationError,
    };
  }
  if (destinationDecision.status === "unresolved") {
    return {
      success: false,
      status: ABYSSAL_RECOVERY_EXECUTION_STATUS.UNRESOLVED_ORIGIN,
      stage: "destination",
      identity,
      destinationDecision,
      sourceCommitIrreversible: false,
      forwardConvergenceRequired: false,
      originResolved: false,
      recoveryTargetSource: null,
      returnSystemID: null,
      emergencyFallbackSelected: false,
      errorMsg: destinationDecision.originResolutionReason,
      stageResults: {},
    };
  }

  const context = {
    obligationStaged: false,
    sourceCommitIrreversible: false,
    moved: false,
    alreadyAtReturnTarget: false,
    movementAuthorityCommitted: false,
    sessionReconciled: false,
    returnVerified: false,
    receiptCommitted: false,
    cleanupCompleted: false,
  };
  const stageResults = {};

  for (const [stage, dependencyName] of EXECUTION_STAGES) {
    const stageRequest = buildStageRequest(
      request,
      identity,
      destinationDecision,
      stage,
      context,
      stageResults,
    );
    let stageResult = invoke(dependencies, dependencyName, stageRequest, stage);
    if (
      stage === ABYSSAL_RECOVERY_EXECUTION_STAGE.REVALIDATE &&
      stageResult.success === true &&
      (
        !identityMatches(identity, stageResult.identity) ||
        !destinationMatches(destinationDecision, stageResult.destinationDecision)
      )
    ) {
      stageResult = {
        ...stageResult,
        success: false,
        errorMsg: "ABYSSAL_RECOVERY_EXECUTION_REVALIDATION_MISMATCH",
      };
    }
    stageResults[stage] = stageResult;
    if (stageResult.success !== true) {
      return settleRecoveryStageFailure(dependencies, request, identity, destinationDecision, context, stageResults, stage, stageResult);
    }

    recordRecoveryStageProgress(context, stage, stageResult);
  }

  return completeRecoveryExecution(dependencies, request, identity, destinationDecision, context, stageResults);
}

function createRecoveryExecutionStageCoordinator(dependencies = {}) {
  for (const dependencyName of REQUIRED_DEPENDENCIES) {
    if (typeof dependencies[dependencyName] !== "function") {
      throw new TypeError(`${dependencyName} dependency is required`);
    }
  }
  return Object.freeze({
    executeRecovery: executeRecoveryStages.bind(null, dependencies),
  });
}

const RECOVERY_PORT_DEPENDENCIES = Object.freeze([
  "revalidateRecovery",
  "persistRecoveryObligation",
  "loadParticipantReturnState",
  "moveParticipant",
  "commitRecoveryState",
  "ensureRecoveryStateDurable",
  "reconcileSession",
  "verifyParticipantReturn",
  "performRecoveryCleanup",
  "scheduleRecovery",
  "getCurrentTime",
]);

function cloneValue(value) {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, cloneValue(entry)]),
  );
}

function vectorDistance(left, right) {
  const a = normalizePosition(left);
  const b = normalizePosition(right);
  return Math.sqrt(
    ((a.x - b.x) ** 2) +
    ((a.y - b.y) ** 2) +
    ((a.z - b.z) ** 2),
  );
}

function upsertParticipant(roster, participant) {
  const normalized = Array.isArray(roster) ? roster.map(cloneValue) : [];
  const characterID = toInteger(participant && participant.characterID, 0);
  const existingIndex = normalized.findIndex(
    (entry) => toInteger(entry && entry.characterID, 0) === characterID,
  );
  if (existingIndex >= 0) normalized[existingIndex] = cloneValue(participant);
  else if (characterID > 0) normalized.push(cloneValue(participant));
  return normalized;
}

function persistRecoveryObligation(attempt, stageRequest, mode, patch = {}) {
  const { port, request, durableState, returnSpaceState } = attempt;

  const result = port.persistRecoveryObligation({
    ...stageRequest,
    mode,
    obligation: cloneValue(attempt.obligation),
    record: mode === "create"
      ? {
          idempotencyKey: normalizeText(
            request.idempotencyKey,
            `abyssal-evacuation:${toInteger(request.instanceID, 0)}:` +
              `${toInteger(request.characterID, 0)}:${toInteger(request.shipID, 0)}`,
          ),
          reason: normalizeText(request.recoveryReason, "abyssal-evacuation"),
          characterID: toInteger(request.characterID, 0),
          shipID: toInteger(request.shipID, 0),
          runID: toInteger(request.instanceID, 0),
          traceID: toInteger(durableState.traceItemID, 0),
          hostLocationID: toInteger(request.hostLocationID, 0),
          sourceSolarSystemID:
            stageRequest.destinationDecision.originResolved === true
              ? toInteger(stageRequest.destinationDecision.systemID, 0)
              : null,
          originResolved: stageRequest.destinationDecision.originResolved === true,
          originResolutionReason:
            stageRequest.destinationDecision.originResolutionReason,
          recoveryTargetSource: stageRequest.destinationDecision.source,
          destinationSolarSystemID: toInteger(
            stageRequest.destinationDecision.systemID,
            0,
          ),
          originAuthorityAttempts: cloneValue(request.originAuthorityAttempts || []),
          returnPosition: cloneValue(returnSpaceState.position),
          evacuationState: normalizeText(request.initialObligationState, "pending"),
          createdAt: toInteger(port.getCurrentTime(), Date.now()),
        }
      : null,
    evacuationState: normalizeText(patch.evacuationState, ""),
    patch: cloneValue(patch),
  });
  if (result && result.success === true && result.obligation) {
    attempt.obligation = cloneValue(result.obligation);
  }
  return result;
}

function recoveryRevalidateRecovery(attempt, stageRequest) {
  const { port, request, durableState, returnSpaceState } = attempt;

  return port.revalidateRecovery(stageRequest);
}

function recoveryStageRecoveryObligation(attempt, stageRequest) {
  const { port, request, durableState, returnSpaceState } = attempt;

  return persistRecoveryObligation(attempt, stageRequest, "create");
}

function recoveryReconcileOrMoveParticipant(attempt, stageRequest) {
  const { port, request, durableState, returnSpaceState } = attempt;

  const participantState = port.loadParticipantReturnState(stageRequest);
  if (!participantState || participantState.success !== true) {
    return participantState || {
      success: false,
      errorMsg: "ABYSSAL_RECOVERY_PARTICIPANT_STATE_UNAVAILABLE",
    };
  }
  const targetSystemID = toInteger(stageRequest.destinationDecision.systemID, 0);
  const persistedSystemID = toInteger(participantState.systemID, 0);
  const alreadyAtExactReturnTarget = Boolean(
    persistedSystemID === targetSystemID &&
    participantState.positionPresent !== false &&
    vectorDistance(participantState.position, returnSpaceState.position) <= 0.001
  );
  const alreadyAtReturnTarget = Boolean(
    alreadyAtExactReturnTarget ||
    (
      durableState.alreadyMoveCommitted === true &&
      persistedSystemID === targetSystemID
    )
  );
  const applyingResult = persistRecoveryObligation(attempt, stageRequest, "update", {
    evacuationState: "applying",
    failureReason: "",
  });
  if (!applyingResult || applyingResult.success !== true) {
    return applyingResult || {
      success: false,
      errorMsg: "ABYSSAL_RECOVERY_OBLIGATION_APPLY_PERSIST_FAILED",
    };
  }
  attempt.movementResult = alreadyAtReturnTarget
    ? {
        success: true,
        data: cloneValue(participantState.shipItem),
        previousData: cloneValue(participantState.shipItem),
        alreadyAtReturnTarget: true,
      }
    : port.moveParticipant({
        ...stageRequest,
        participantState: cloneValue(participantState),
        returnSpaceState: cloneValue(returnSpaceState),
      });
  if (!attempt.movementResult || attempt.movementResult.success !== true || !attempt.movementResult.data) {
    return {
      success: false,
      moved: false,
      errorMsg: normalizeText(
        attempt.movementResult && attempt.movementResult.errorMsg,
        "ABYSSAL_EVACUATION_MOVE_FAILED",
      ),
    };
  }
  return {
    success: true,
    moved: !alreadyAtReturnTarget,
    alreadyAtReturnTarget,
    ship: cloneValue(attempt.movementResult.data),
  };
}

function recoveryCommitMovementAuthority(attempt, stageRequest) {
  const { port, request, durableState, returnSpaceState } = attempt;

  attempt.movementCommittedAtMs = toInteger(port.getCurrentTime(), Date.now());
  const movedObligation = persistRecoveryObligation(attempt, stageRequest, "update", {
    evacuationState: "ship-moved",
    moveCommittedAtMs: attempt.movementCommittedAtMs,
    failureReason: "",
  });
  if (!movedObligation || movedObligation.success !== true) {
    return movedObligation || {
      success: false,
      sourceCommitIrreversible: true,
      errorMsg: "ABYSSAL_RECOVERY_MOVE_RECEIPT_PERSIST_FAILED",
    };
  }
  if (
    durableState.syntheticOrphanRecovery !== true &&
    toInteger(request.instanceID, 0) > 0
  ) {
    const participant = durableState.participant;
    const exitingRoster = participant
      ? upsertParticipant(durableState.participantRoster, {
          ...cloneValue(participant),
          status: "exiting",
          lastSeenAtMs: attempt.movementCommittedAtMs,
        })
      : cloneValue(durableState.participantRoster || []);
    const commitResult = port.commitRecoveryState({
      ...stageRequest,
      patch: {
        participantRoster: exitingRoster,
        gameplayAuthorityDetached: true,
        gameplayAuthorityDetachedAtMs:
          toInteger(durableState.gameplayAuthorityDetachedAtMs, 0) ||
          attempt.movementCommittedAtMs,
        gameplayAuthorityDetachedReason:
          "recovery-evacuation-ship-move-committed",
        committedEvacuationState: {
          ...cloneValue(durableState.committedEvacuationState || {}),
          schemaVersion: 1,
          status: "ship-moved",
          instanceID: toInteger(request.instanceID, 0),
          characterID: toInteger(request.characterID, 0),
          shipID: toInteger(request.shipID, 0),
          returnSpaceState: cloneValue(returnSpaceState),
          committedAtMs: attempt.movementCommittedAtMs,
          reason: normalizeText(request.recoveryReason, "abyssal-evacuation"),
        },
        weatherRemovalState: {
          ...cloneValue(durableState.weatherRemovalState || {}),
          schemaVersion: 1,
          status: "pending",
          instanceID: toInteger(request.instanceID, 0),
          characterID: toInteger(request.characterID, 0),
          shipID: toInteger(request.shipID, 0),
          traceItemID: toInteger(durableState.traceItemID, 0),
          reason: "recovery-evacuation",
          firstPendingAtMs:
            toInteger(durableState.weatherRemovalState &&
              durableState.weatherRemovalState.firstPendingAtMs, 0) ||
            attempt.movementCommittedAtMs,
          verified: false,
        },
      },
    });
    if (!commitResult || commitResult.success !== true) {
      return {
        success: false,
        sourceCommitIrreversible: true,
        errorMsg: normalizeText(
          commitResult && commitResult.errorMsg,
          "ABYSSAL_EVACUATION_COMMIT_PERSIST_FAILED",
        ),
      };
    }
    attempt.committedRecoveryState = cloneValue(
      commitResult.committedState || commitResult.state || {},
    );
    const durabilityResult = port.ensureRecoveryStateDurable({
      ...stageRequest,
      recoveryState: cloneValue(attempt.committedRecoveryState),
    });
    if (!durabilityResult || durabilityResult.success !== true) {
      return {
        success: false,
        sourceCommitIrreversible: true,
        errorMsg: "ABYSSAL_EVACUATION_COMMIT_PERSIST_FAILED",
      };
    }
  }
  return {
    success: true,
    committedAtMs: attempt.movementCommittedAtMs,
    recoveryState: cloneValue(attempt.committedRecoveryState),
  };
}

function recoveryReconcileSession(attempt, stageRequest) {
  const { port, request, durableState, returnSpaceState } = attempt;

  return port.reconcileSession({
    ...stageRequest,
    movementResult: cloneValue(attempt.movementResult),
    returnSpaceState: cloneValue(returnSpaceState),
    recoveryState: cloneValue(attempt.committedRecoveryState),
  });
}

function recoveryVerifyParticipantReturn(attempt, stageRequest) {
  const { port, request, durableState, returnSpaceState } = attempt;

  return port.verifyParticipantReturn({
    ...stageRequest,
    movementResult: cloneValue(attempt.movementResult),
    returnSpaceState: cloneValue(returnSpaceState),
    recoveryState: cloneValue(attempt.committedRecoveryState),
  });
}

function recoveryCommitRecoveryReceipt(attempt, stageRequest) {
  const { port, request, durableState, returnSpaceState } = attempt;

  if (
    durableState.participant &&
    durableState.syntheticOrphanRecovery !== true &&
    durableState.runActive !== false &&
    toInteger(request.instanceID, 0) > 0
  ) {
    const latestRoster = Array.isArray(attempt.committedRecoveryState.participantRoster)
      ? attempt.committedRecoveryState.participantRoster
      : durableState.participantRoster;
    const exitedAtMs = toInteger(port.getCurrentTime(), attempt.movementCommittedAtMs);
    const exitedRoster = upsertParticipant(latestRoster, {
      ...cloneValue(durableState.participant),
      status: "exited",
      exitedAtMs,
      lastSeenAtMs: exitedAtMs,
    });
    const receiptCommit = port.commitRecoveryState({
      ...stageRequest,
      patch: { participantRoster: exitedRoster },
    });
    if (!receiptCommit || receiptCommit.success !== true) {
      return {
        success: false,
        sourceCommitIrreversible: true,
        errorMsg: normalizeText(
          receiptCommit && receiptCommit.errorMsg,
          "ABYSSAL_PARTICIPANT_EVACUATION_RECEIPT_PERSIST_FAILED",
        ),
      };
    }
    attempt.committedRecoveryState = cloneValue(
      receiptCommit.committedState || receiptCommit.state || {},
    );
  }
  return {
    success: true,
    receiptCommitted: true,
    recoveryState: cloneValue(attempt.committedRecoveryState),
  };
}

function recoveryPerformRecoveryCleanup(attempt, stageRequest) {
  const { port, request, durableState, returnSpaceState } = attempt;

  return port.performRecoveryCleanup({
    ...stageRequest,
    recoveryState: cloneValue(attempt.committedRecoveryState),
  });
}

function recoverySettleRecoveryObligation(attempt, stageRequest) {
  const { port, request, durableState, returnSpaceState } = attempt;

  const failureReason = normalizeText(
    stageRequest.failureResult && stageRequest.failureResult.errorMsg,
    stageRequest.sourceCommitIrreversible
      ? "ABYSSAL_EVACUATION_POST_MOVE_FAILED"
      : "ABYSSAL_EVACUATION_MOVE_FAILED",
  );
  const evacuationState = stageRequest.disposition === "complete"
    ? "complete"
    : stageRequest.disposition === "cleanup_pending"
      ? "cleanup-pending"
      : stageRequest.sourceCommitIrreversible
        ? "ship-moved"
        : "failed";
  const settlement = persistRecoveryObligation(attempt, stageRequest, "update", {
    evacuationState,
    returnPosition: cloneValue(returnSpaceState.position),
    moveCommittedAtMs: stageRequest.sourceCommitIrreversible
      ? attempt.movementCommittedAtMs
      : 0,
    failureReason: stageRequest.disposition === "complete" ? "" : failureReason,
  });
  if (!settlement || settlement.success !== true) return settlement;

  let persistenceResult = { success: true, skipped: true };
  if (
    stageRequest.sourceCommitIrreversible === true &&
    !["complete", "cleanup_pending"].includes(stageRequest.disposition) &&
    durableState.syntheticOrphanRecovery !== true &&
    durableState.runActive !== false &&
    toInteger(request.instanceID, 0) > 0
  ) {
    persistenceResult = port.commitRecoveryState({
      ...stageRequest,
      patch: {
        gameplayAuthorityDetached: true,
        gameplayAuthorityDetachedAtMs:
          toInteger(
            attempt.committedRecoveryState.gameplayAuthorityDetachedAtMs,
            toInteger(durableState.gameplayAuthorityDetachedAtMs, 0),
          ) || attempt.movementCommittedAtMs,
        gameplayAuthorityDetachedReason:
          "recovery-evacuation-settlement-pending",
        committedEvacuationState: {
          ...cloneValue(
            attempt.committedRecoveryState.committedEvacuationState ||
            durableState.committedEvacuationState || {},
          ),
          schemaVersion: 1,
          status: "settlement-pending",
          failureReason,
          lastFailedAtMs: toInteger(port.getCurrentTime(), attempt.movementCommittedAtMs),
        },
      },
    });
  }
  if (
    stageRequest.disposition === "cleanup_pending" ||
    (
      stageRequest.sourceCommitIrreversible === true &&
      stageRequest.disposition !== "complete"
    )
  ) {
    port.scheduleRecovery({
      ...stageRequest,
      failureReason,
      persistenceResult,
    });
  }
  return {
    success: true,
    state: evacuationState,
    failureReason,
    persistenceResult,
    obligation: cloneValue(attempt.obligation),
  };
}

function executeRecovery(port, request = {}) {
  const durableState = request.durableState && typeof request.durableState === "object"
    ? cloneValue(request.durableState)
    : {};
  const returnSpaceState = request.returnSpaceState &&
    typeof request.returnSpaceState === "object"
    ? cloneValue(request.returnSpaceState)
    : {};
  const obligation = null;
  const movementResult = null;
  const committedRecoveryState = cloneValue(durableState.recoveryState || {});
  const movementCommittedAtMs = 0;
  const attempt = {
    port, request, durableState, returnSpaceState,
    obligation, movementResult, committedRecoveryState, movementCommittedAtMs,
  };
  const stageCoordinator = createRecoveryExecutionStageCoordinator({
    revalidateRecovery: recoveryRevalidateRecovery.bind(null, attempt),
    stageRecoveryObligation: recoveryStageRecoveryObligation.bind(null, attempt),
    reconcileOrMoveParticipant: recoveryReconcileOrMoveParticipant.bind(null, attempt),
    commitMovementAuthority: recoveryCommitMovementAuthority.bind(null, attempt),
    reconcileSession: recoveryReconcileSession.bind(null, attempt),
    verifyParticipantReturn: recoveryVerifyParticipantReturn.bind(null, attempt),
    commitRecoveryReceipt: recoveryCommitRecoveryReceipt.bind(null, attempt),
    performRecoveryCleanup: recoveryPerformRecoveryCleanup.bind(null, attempt),
    settleRecoveryObligation: recoverySettleRecoveryObligation.bind(null, attempt),
  });


  return stageCoordinator.executeRecovery({
    ...request,
    returnSpaceState,
    durableState,
  });
}

function createAbyssalRecoveryExecutionCoordinator(port = {}) {
  for (const dependencyName of RECOVERY_PORT_DEPENDENCIES) {
    if (typeof port[dependencyName] !== "function") {
      throw new TypeError(`${dependencyName} dependency is required`);
    }
  }
  return Object.freeze({
    executeRecovery: executeRecovery.bind(null, port),
  });
}

module.exports = {
  ABYSSAL_RECOVERY_EXECUTION_STAGE,
  ABYSSAL_RECOVERY_EXECUTION_STATUS,
  createAbyssalRecoveryExecutionCoordinator,
};
