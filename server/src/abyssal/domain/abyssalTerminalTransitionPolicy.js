"use strict";

const ABYSSAL_RUN_OUTCOME = Object.freeze({
  COMPLETED: "completed",
  EXITED: "exited",
  FAILED_ENTRY_READINESS: "failed_entry_readiness",
  FAILED_ROOM_ACTIVATION: "failed_room_activation",
  FAILED_TIMEOUT: "failed_timeout",
  FAILED_SHIP_DESTROYED: "failed_ship_destroyed",
  ABANDONED_OR_RECOVERED: "abandoned_or_recovered",
  ADMIN_ABORTED: "admin_aborted",
  CLUSTER_SHUTDOWN_RETURNED: "cluster_shutdown_returned",
});

const KNOWN_ABYSSAL_RUN_OUTCOMES = new Set(
  Object.values(ABYSSAL_RUN_OUTCOME),
);

// `completed` records final-objective completion while the final exit remains
// pending. Preserve the manager's existing post-completion settlement paths.
const ABYSSAL_POST_COMPLETION_OUTCOMES = new Set([
  ABYSSAL_RUN_OUTCOME.EXITED,
  ABYSSAL_RUN_OUTCOME.FAILED_TIMEOUT,
  ABYSSAL_RUN_OUTCOME.FAILED_SHIP_DESTROYED,
  ABYSSAL_RUN_OUTCOME.ABANDONED_OR_RECOVERED,
  ABYSSAL_RUN_OUTCOME.ADMIN_ABORTED,
  ABYSSAL_RUN_OUTCOME.CLUSTER_SHUTDOWN_RETURNED,
]);

const ABYSSAL_PARTICIPANT_DESTRUCTION_OPERATION_SCHEMA_VERSION = 2;
const ABYSSAL_PARTICIPANT_DESTRUCTION_OPERATION_STATUS = Object.freeze({
  HULL_INTENT_COMMITTED: "hull_intent_committed",
  HULL_DESTROYED: "hull_destroyed",
  INTENT_COMMITTED: "intent_committed",
  POD_DESTROYED: "pod_destroyed",
});
const ABYSSAL_PARTICIPANT_DESTRUCTION_STATUS_RANK = Object.freeze({
  [ABYSSAL_PARTICIPANT_DESTRUCTION_OPERATION_STATUS.HULL_INTENT_COMMITTED]: 1,
  [ABYSSAL_PARTICIPANT_DESTRUCTION_OPERATION_STATUS.HULL_DESTROYED]: 2,
  [ABYSSAL_PARTICIPANT_DESTRUCTION_OPERATION_STATUS.INTENT_COMMITTED]: 3,
  [ABYSSAL_PARTICIPANT_DESTRUCTION_OPERATION_STATUS.POD_DESTROYED]: 4,
});
const ABYSSAL_PARTICIPANT_TERMINAL_CAUSE = Object.freeze({
  RUN_TIMEOUT: ABYSSAL_RUN_OUTCOME.FAILED_TIMEOUT,
  RUN_SHIP_DESTROYED: ABYSSAL_RUN_OUTCOME.FAILED_SHIP_DESTROYED,
  MEMBER_SHIP_DESTROYED: "participant_ship_destroyed",
});

const ABYSSAL_REWARD_ARTIFACT_DESTRUCTION_OPERATION_SCHEMA_VERSION = 1;
const ABYSSAL_REWARD_ARTIFACT_DESTRUCTION_STATUS = Object.freeze({
  CLAIMED: "claimed",
  SOURCE_DESTROYED: "source_destroyed",
  REWARD_COMPLETED: "reward_completed",
  SUPPRESSED: "suppressed",
});
const ABYSSAL_REWARD_ARTIFACT_DESTRUCTION_STATUS_RANK = Object.freeze({
  [ABYSSAL_REWARD_ARTIFACT_DESTRUCTION_STATUS.CLAIMED]: 1,
  [ABYSSAL_REWARD_ARTIFACT_DESTRUCTION_STATUS.SOURCE_DESTROYED]: 2,
  [ABYSSAL_REWARD_ARTIFACT_DESTRUCTION_STATUS.REWARD_COMPLETED]: 3,
  [ABYSSAL_REWARD_ARTIFACT_DESTRUCTION_STATUS.SUPPRESSED]: 3,
});

const ABYSSAL_TERMINAL_TRANSITION_ACTION = Object.freeze({
  NONE: "none",
  COMMIT_RUN_OUTCOME: "commitRunOutcome",
  SETTLE_PARTICIPANT_DESTRUCTION: "settleParticipantDestruction",
  SETTLE_RUN_DESTRUCTION: "settleRunDestruction",
  COMMIT_PARTICIPANT_OPERATION: "commitParticipantDestructionOperation",
  RECONCILE_PARTICIPANT_OPERATION: "reconcileParticipantDestructionOperation",
  COMMIT_REWARD_ARTIFACT_OPERATION: "commitRewardArtifactDestructionOperation",
  RECONCILE_REWARD_ARTIFACT_OPERATION: "reconcileRewardArtifactDestructionOperation",
  SUPPRESS_UNCLAIMED_REWARD_ARTIFACT: "suppressUnclaimedRewardArtifactDestruction",
  REQUIRE_REWARD_ARTIFACT_CLAIM: "requireRewardArtifactDestructionClaim",
  COMMIT_REWARD_ARTIFACT_SOURCE_DESTROYED: "commitRewardArtifactSourceDestroyed",
});

function toInteger(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function normalizeText(value, fallback = "") {
  const normalized = String(value == null ? "" : value).trim();
  return normalized || fallback;
}

function normalizeLowerText(value, fallback = "") {
  return normalizeText(value, fallback).toLowerCase();
}

function clonePlainData(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => clonePlainData(entry));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, clonePlainData(entry)]),
    );
  }
  return value;
}

function normalizeAbyssalRunOutcome(value) {
  const normalized = normalizeLowerText(value, "");
  // Historical diagnostics sometimes stored "active" explicitly. Production
  // normally represents the active state with an empty outcome.
  return normalized === "active" ? "" : normalized;
}

function isKnownAbyssalRunOutcome(value) {
  return KNOWN_ABYSSAL_RUN_OUTCOMES.has(normalizeAbyssalRunOutcome(value));
}

function hasImmutableAbyssalRunOutcome(source) {
  const outcome = normalizeAbyssalRunOutcome(
    source && typeof source === "object" ? source.runOutcome : source,
  );
  if (!outcome) return false;
  // Unknown persisted evidence is deliberately fail-closed.
  return outcome !== ABYSSAL_RUN_OUTCOME.COMPLETED;
}

function resolveAbyssalTerminalCallbackReason(outcome) {
  switch (normalizeAbyssalRunOutcome(outcome)) {
    case ABYSSAL_RUN_OUTCOME.FAILED_TIMEOUT:
      return "ABYSSAL_RUN_FAILED_TIMEOUT";
    case ABYSSAL_RUN_OUTCOME.FAILED_SHIP_DESTROYED:
      return "ABYSSAL_RUN_FAILED_SHIP_DESTROYED";
    case ABYSSAL_RUN_OUTCOME.FAILED_ENTRY_READINESS:
      return "ABYSSAL_RUN_FAILED_ENTRY_READINESS";
    case ABYSSAL_RUN_OUTCOME.FAILED_ROOM_ACTIVATION:
      return "ABYSSAL_RUN_FAILED_ROOM_ACTIVATION";
    case ABYSSAL_RUN_OUTCOME.ADMIN_ABORTED:
      return "ABYSSAL_RUN_ADMIN_ABORTED";
    case ABYSSAL_RUN_OUTCOME.ABANDONED_OR_RECOVERED:
      return "ABYSSAL_RUN_ABANDONED_OR_RECOVERED";
    case ABYSSAL_RUN_OUTCOME.CLUSTER_SHUTDOWN_RETURNED:
      return "ABYSSAL_RUN_CLUSTER_SHUTDOWN_RETURNED";
    case ABYSSAL_RUN_OUTCOME.EXITED:
      return "ABYSSAL_RUN_EXITED";
    default:
      return "ABYSSAL_RUN_TERMINALLY_SETTLED";
  }
}

function hasFailedTimeoutOutcome(pocketState) {
  return normalizeText(pocketState && pocketState.runOutcome, "") === "failed_timeout";
}

function hasFailedParticipantShipDestroyedOutcome(pocketState) {
  return normalizeText(pocketState && pocketState.runOutcome, "") === "failed_ship_destroyed";
}

function hasTerminalFailureOutcome(pocketState) {
  return normalizeText(pocketState && pocketState.runOutcome, "").startsWith("failed_");
}

function buildRunOutcomeDecision({
  allowed,
  idempotent,
  current,
  requested,
  reason,
}) {
  return {
    allowed,
    idempotent,
    action: allowed && !idempotent
      ? ABYSSAL_TERMINAL_TRANSITION_ACTION.COMMIT_RUN_OUTCOME
      : ABYSSAL_TERMINAL_TRANSITION_ACTION.NONE,
    current,
    requested,
    nextOutcome: allowed ? requested : current,
    outcomeChanged: allowed && !idempotent,
    reason,
  };
}

function evaluateAbyssalRunOutcomeTransition(currentOutcome, requestedOutcome) {
  const current = normalizeAbyssalRunOutcome(currentOutcome);
  const requested = normalizeAbyssalRunOutcome(requestedOutcome);

  if (current === requested) {
    return buildRunOutcomeDecision({
      allowed: true,
      idempotent: true,
      current,
      requested,
      reason: "UNCHANGED",
    });
  }
  if (!requested) {
    const unchanged = current.length === 0;
    return buildRunOutcomeDecision({
      allowed: unchanged,
      idempotent: unchanged,
      current,
      requested,
      reason: current ? "RUN_OUTCOME_CANNOT_BE_CLEARED" : "UNCHANGED",
    });
  }
  if (!KNOWN_ABYSSAL_RUN_OUTCOMES.has(requested)) {
    return buildRunOutcomeDecision({
      allowed: false,
      idempotent: false,
      current,
      requested,
      reason: "UNKNOWN_REQUESTED_RUN_OUTCOME",
    });
  }
  if (!current) {
    return buildRunOutcomeDecision({
      allowed: true,
      idempotent: false,
      current,
      requested,
      reason: "INITIAL_OUTCOME",
    });
  }
  if (!KNOWN_ABYSSAL_RUN_OUTCOMES.has(current)) {
    return buildRunOutcomeDecision({
      allowed: false,
      idempotent: false,
      current,
      requested,
      reason: "UNKNOWN_EXISTING_RUN_OUTCOME_LOCKED",
    });
  }
  if (current === ABYSSAL_RUN_OUTCOME.COMPLETED) {
    const allowed = ABYSSAL_POST_COMPLETION_OUTCOMES.has(requested);
    return buildRunOutcomeDecision({
      allowed,
      idempotent: false,
      current,
      requested,
      reason: allowed
        ? "POST_COMPLETION_TERMINAL_TRANSITION"
        : "INVALID_POST_COMPLETION_TRANSITION",
    });
  }
  return buildRunOutcomeDecision({
    allowed: false,
    idempotent: false,
    current,
    requested,
    reason: "TERMINAL_RUN_OUTCOME_IMMUTABLE",
  });
}

function evaluateAbyssalTerminalOperationGuard(input = {}) {
  const outcome = normalizeAbyssalRunOutcome(input.currentOutcome);
  const allowedTerminalOutcomes = new Set(
    (Array.isArray(input.allowedTerminalOutcomes)
      ? input.allowedTerminalOutcomes
      : []
    )
      .map((entry) => normalizeAbyssalRunOutcome(entry))
      .filter(Boolean),
  );
  const immutableOutcome = hasImmutableAbyssalRunOutcome(outcome);
  const terminalOutcomeAllowed =
    immutableOutcome && allowedTerminalOutcomes.has(outcome);
  const blocked = Boolean(
    (immutableOutcome && !terminalOutcomeAllowed) ||
      (input.pendingTerminalCleanup === true &&
        input.allowPendingTerminalCleanup !== true) ||
      (input.gameplayAuthorityDetached === true &&
        input.allowDetachedGameplayAuthority !== true),
  );
  return {
    allowed: !blocked,
    blocked,
    outcome,
    immutableOutcome,
    reason: !blocked
      ? "ALLOWED"
      : immutableOutcome && !terminalOutcomeAllowed
        ? "IMMUTABLE_TERMINAL_OUTCOME"
        : input.pendingTerminalCleanup === true
          ? "TERMINAL_CLEANUP_PENDING"
          : "GAMEPLAY_AUTHORITY_DETACHED",
  };
}

function evaluateAbyssalParticipantDestructionTransition(input = {}) {
  const currentOutcome = normalizeAbyssalRunOutcome(input.currentOutcome);
  const timeoutCommitted =
    input.timeoutCommitted === true ||
    currentOutcome === ABYSSAL_RUN_OUTCOME.FAILED_TIMEOUT;
  const groupRunContinues = Boolean(
    input.participantPresent === true &&
      input.survivorsRemain === true &&
      !timeoutCommitted,
  );
  const terminalCause = groupRunContinues
    ? ABYSSAL_PARTICIPANT_TERMINAL_CAUSE.MEMBER_SHIP_DESTROYED
    : timeoutCommitted
      ? ABYSSAL_PARTICIPANT_TERMINAL_CAUSE.RUN_TIMEOUT
      : ABYSSAL_PARTICIPANT_TERMINAL_CAUSE.RUN_SHIP_DESTROYED;
  const nextOutcome = groupRunContinues ? currentOutcome : terminalCause;
  return {
    allowed: true,
    action: groupRunContinues
      ? ABYSSAL_TERMINAL_TRANSITION_ACTION.SETTLE_PARTICIPANT_DESTRUCTION
      : ABYSSAL_TERMINAL_TRANSITION_ACTION.SETTLE_RUN_DESTRUCTION,
    currentOutcome,
    nextOutcome,
    outcomeChanged: currentOutcome !== nextOutcome,
    terminalCause,
    groupRunContinues,
    destructionKind: normalizeLowerText(input.destructionKind, "ship"),
    reason: groupRunContinues
      ? "SURVIVING_PARTICIPANT_CONTINUES_RUN"
      : timeoutCommitted
        ? "TIMEOUT_OUTCOME_PRESERVED"
        : input.participantPresent === true
          ? "LAST_PARTICIPANT_DESTROYED"
          : "RUN_PARTICIPANT_CONTEXT_REQUIRED",
  };
}

function normalizeAbyssalParticipantDestructionOperation(operation) {
  if (!operation || typeof operation !== "object") return null;
  return {
    schemaVersion: Math.max(
      ABYSSAL_PARTICIPANT_DESTRUCTION_OPERATION_SCHEMA_VERSION,
      toInteger(
        operation.schemaVersion,
        ABYSSAL_PARTICIPANT_DESTRUCTION_OPERATION_SCHEMA_VERSION,
      ),
    ),
    operationID: normalizeText(operation.operationID, ""),
    status: normalizeLowerText(operation.status, ""),
    terminalCause: normalizeAbyssalRunOutcome(operation.terminalCause),
    runID: toInteger(operation.runID, 0),
    characterID: toInteger(operation.characterID, 0),
    originalShipID: toInteger(operation.originalShipID, 0),
    capsuleID: toInteger(operation.capsuleID, 0),
    roomIndex: Math.max(0, toInteger(operation.roomIndex, 0)),
    sceneKey: normalizeText(operation.sceneKey, ""),
    identityMode: normalizeText(operation.identityMode, "exact_capsule"),
    intentSource: normalizeText(operation.intentSource, "abyssal-manager"),
    intentCommittedAtMs: Math.max(0, toInteger(operation.intentCommittedAtMs, 0)),
    hullIntentCommittedAtMs: Math.max(
      0,
      toInteger(operation.hullIntentCommittedAtMs, 0),
    ),
    hullDestroyedAtMs: Math.max(0, toInteger(operation.hullDestroyedAtMs, 0)),
    podDestroyedAtMs: Math.max(0, toInteger(operation.podDestroyedAtMs, 0)),
    lastAttemptAtMs: Math.max(0, toInteger(operation.lastAttemptAtMs, 0)),
    attemptCount: Math.max(0, toInteger(operation.attemptCount, 0)),
    hullAttemptCount: Math.max(0, toInteger(operation.hullAttemptCount, 0)),
    failureReason: normalizeText(operation.failureReason, ""),
    hullFailureReason: normalizeText(operation.hullFailureReason, ""),
    hullReceipt: operation.hullReceipt && typeof operation.hullReceipt === "object"
      ? clonePlainData(operation.hullReceipt)
      : null,
    receipt: operation.receipt && typeof operation.receipt === "object"
      ? clonePlainData(operation.receipt)
      : null,
  };
}

function isKnownAbyssalParticipantDestructionStatus(status) {
  return Object.prototype.hasOwnProperty.call(
    ABYSSAL_PARTICIPANT_DESTRUCTION_STATUS_RANK,
    normalizeLowerText(status, ""),
  );
}

function isValidAbyssalParticipantDestructionOperation(operation) {
  const normalized = normalizeAbyssalParticipantDestructionOperation(operation);
  if (!normalized) return false;
  if (
    !normalized.operationID ||
    normalized.runID <= 0 ||
    normalized.characterID <= 0 ||
    normalized.originalShipID <= 0 ||
    ![
      ABYSSAL_RUN_OUTCOME.FAILED_TIMEOUT,
      ABYSSAL_RUN_OUTCOME.FAILED_SHIP_DESTROYED,
      ABYSSAL_PARTICIPANT_TERMINAL_CAUSE.MEMBER_SHIP_DESTROYED,
    ].includes(normalized.terminalCause) ||
    !isKnownAbyssalParticipantDestructionStatus(normalized.status)
  ) {
    return false;
  }
  if (
    normalized.status ===
      ABYSSAL_PARTICIPANT_DESTRUCTION_OPERATION_STATUS.HULL_DESTROYED &&
    !normalized.hullReceipt
  ) {
    return false;
  }
  if (
    normalized.status ===
      ABYSSAL_PARTICIPANT_DESTRUCTION_OPERATION_STATUS.INTENT_COMMITTED &&
    normalized.capsuleID <= 0
  ) {
    return false;
  }
  if (
    normalized.status ===
      ABYSSAL_PARTICIPANT_DESTRUCTION_OPERATION_STATUS.POD_DESTROYED &&
    normalized.capsuleID <= 0 &&
    normalized.identityMode !== "authoritative_clone_handoff"
  ) {
    return false;
  }
  return true;
}

function isSameAbyssalParticipantDestructionIdentity(left, right) {
  const normalizedLeft = normalizeAbyssalParticipantDestructionOperation(left);
  const normalizedRight = normalizeAbyssalParticipantDestructionOperation(right);
  return Boolean(
    normalizedLeft &&
      normalizedRight &&
      normalizedLeft.operationID === normalizedRight.operationID &&
      normalizedLeft.runID === normalizedRight.runID &&
      normalizedLeft.characterID === normalizedRight.characterID &&
      normalizedLeft.originalShipID === normalizedRight.originalShipID &&
      (
        normalizedLeft.capsuleID === normalizedRight.capsuleID ||
        normalizedLeft.capsuleID <= 0 ||
        normalizedRight.capsuleID <= 0
      ) &&
      normalizedLeft.terminalCause === normalizedRight.terminalCause &&
      normalizedLeft.identityMode === normalizedRight.identityMode,
  );
}

function buildParticipantOperationDecision({
  allowed,
  idempotent,
  reason,
  current,
  requested,
}) {
  return {
    allowed,
    idempotent,
    action: allowed
      ? idempotent
        ? ABYSSAL_TERMINAL_TRANSITION_ACTION.RECONCILE_PARTICIPANT_OPERATION
        : ABYSSAL_TERMINAL_TRANSITION_ACTION.COMMIT_PARTICIPANT_OPERATION
      : ABYSSAL_TERMINAL_TRANSITION_ACTION.NONE,
    reason,
    current,
    requested,
    nextOperation: allowed ? requested || current : current,
  };
}

function evaluateAbyssalParticipantDestructionOperationTransition(
  currentOperation,
  requestedOperation,
) {
  const current = normalizeAbyssalParticipantDestructionOperation(currentOperation);
  const requested = normalizeAbyssalParticipantDestructionOperation(requestedOperation);
  if (!current && !requested) {
    return buildParticipantOperationDecision({
      allowed: true,
      idempotent: true,
      reason: "UNCHANGED_EMPTY",
      current,
      requested,
    });
  }
  if (current && !requested) {
    return buildParticipantOperationDecision({
      allowed: false,
      idempotent: false,
      reason: "DESTRUCTION_OPERATION_CANNOT_BE_CLEARED",
      current,
      requested,
    });
  }
  if (!requested || !isValidAbyssalParticipantDestructionOperation(requested)) {
    return buildParticipantOperationDecision({
      allowed: false,
      idempotent: false,
      reason: "INVALID_REQUESTED_DESTRUCTION_OPERATION",
      current,
      requested,
    });
  }
  if (!current) {
    return buildParticipantOperationDecision({
      allowed: true,
      idempotent: false,
      reason: "INITIAL_DESTRUCTION_INTENT",
      current,
      requested,
    });
  }
  if (!isValidAbyssalParticipantDestructionOperation(current)) {
    return buildParticipantOperationDecision({
      allowed: false,
      idempotent: false,
      reason: "INVALID_EXISTING_DESTRUCTION_OPERATION_LOCKED",
      current,
      requested,
    });
  }
  if (!isSameAbyssalParticipantDestructionIdentity(current, requested)) {
    return buildParticipantOperationDecision({
      allowed: false,
      idempotent: false,
      reason: "DESTRUCTION_OPERATION_IDENTITY_CONFLICT",
      current,
      requested,
    });
  }
  const currentRank = toInteger(
    ABYSSAL_PARTICIPANT_DESTRUCTION_STATUS_RANK[current.status],
    0,
  );
  const requestedRank = toInteger(
    ABYSSAL_PARTICIPANT_DESTRUCTION_STATUS_RANK[requested.status],
    0,
  );
  if (requestedRank < currentRank) {
    return buildParticipantOperationDecision({
      allowed: false,
      idempotent: false,
      reason: "DESTRUCTION_OPERATION_CANNOT_REGRESS",
      current,
      requested,
    });
  }
  const idempotent = requestedRank === currentRank;
  return buildParticipantOperationDecision({
    allowed: true,
    idempotent,
    reason: idempotent
      ? "UNCHANGED_DESTRUCTION_OPERATION"
      : "POD_DESTRUCTION_RECEIPT_ADVANCE",
    current,
    requested,
  });
}

function normalizeAbyssalRewardArtifactDestructionOperation(operation) {
  if (!operation || typeof operation !== "object") return null;
  return {
    schemaVersion: Math.max(
      ABYSSAL_REWARD_ARTIFACT_DESTRUCTION_OPERATION_SCHEMA_VERSION,
      toInteger(
        operation.schemaVersion,
        ABYSSAL_REWARD_ARTIFACT_DESTRUCTION_OPERATION_SCHEMA_VERSION,
      ),
    ),
    operationID: normalizeText(operation.operationID, ""),
    status: normalizeLowerText(operation.status, ""),
    runID: toInteger(operation.runID, 0),
    roomIndex: Math.max(1, toInteger(operation.roomIndex, 1)),
    characterID: toInteger(operation.characterID, 0),
    sourceStructureItemID: toInteger(operation.sourceStructureItemID, 0),
    sourceStructureTypeID: toInteger(operation.sourceStructureTypeID, 0),
    artifactKind: normalizeLowerText(operation.artifactKind, ""),
    claimCommittedAtMs: Math.max(0, toInteger(operation.claimCommittedAtMs, 0)),
    sourceDestroyedAtMs: Math.max(0, toInteger(operation.sourceDestroyedAtMs, 0)),
    rewardCompletedAtMs: Math.max(0, toInteger(operation.rewardCompletedAtMs, 0)),
    suppressionReason: normalizeText(operation.suppressionReason, ""),
    retryIntent: operation.retryIntent && typeof operation.retryIntent === "object"
      ? clonePlainData(operation.retryIntent)
      : null,
    artifactSnapshot:
      operation.artifactSnapshot && typeof operation.artifactSnapshot === "object"
        ? clonePlainData(operation.artifactSnapshot)
        : null,
    receipt: operation.receipt && typeof operation.receipt === "object"
      ? clonePlainData(operation.receipt)
      : null,
  };
}

function isSameAbyssalRewardArtifactDestructionIdentity(left, right) {
  const normalizedLeft = normalizeAbyssalRewardArtifactDestructionOperation(left);
  const normalizedRight = normalizeAbyssalRewardArtifactDestructionOperation(right);
  return Boolean(
    normalizedLeft &&
      normalizedRight &&
      normalizedLeft.operationID &&
      normalizedLeft.operationID === normalizedRight.operationID &&
      normalizedLeft.runID === normalizedRight.runID &&
      normalizedLeft.roomIndex === normalizedRight.roomIndex &&
      normalizedLeft.characterID === normalizedRight.characterID &&
      normalizedLeft.sourceStructureItemID === normalizedRight.sourceStructureItemID &&
      normalizedLeft.sourceStructureTypeID === normalizedRight.sourceStructureTypeID &&
      normalizedLeft.artifactKind === normalizedRight.artifactKind,
  );
}

function isValidAbyssalRewardArtifactDestructionOperation(operation) {
  const normalized = normalizeAbyssalRewardArtifactDestructionOperation(operation);
  return Boolean(
    normalized &&
      normalized.operationID &&
      normalized.runID > 0 &&
      normalized.roomIndex > 0 &&
      normalized.sourceStructureItemID > 0 &&
      normalized.sourceStructureTypeID > 0 &&
      ["reward_cache", "extraction_node"].includes(normalized.artifactKind) &&
      ABYSSAL_REWARD_ARTIFACT_DESTRUCTION_STATUS_RANK[normalized.status] > 0,
  );
}

function buildRewardArtifactOperationDecision({
  allowed,
  idempotent,
  reason,
  current,
  requested,
}) {
  return {
    allowed,
    idempotent,
    action: allowed
      ? idempotent
        ? ABYSSAL_TERMINAL_TRANSITION_ACTION.RECONCILE_REWARD_ARTIFACT_OPERATION
        : ABYSSAL_TERMINAL_TRANSITION_ACTION.COMMIT_REWARD_ARTIFACT_OPERATION
      : ABYSSAL_TERMINAL_TRANSITION_ACTION.NONE,
    current,
    requested,
    nextOperation: allowed ? requested || current : current,
    reason,
  };
}

function evaluateAbyssalRewardArtifactDestructionOperationTransition(
  currentOperation,
  requestedOperation,
) {
  const current = normalizeAbyssalRewardArtifactDestructionOperation(currentOperation);
  const requested = normalizeAbyssalRewardArtifactDestructionOperation(requestedOperation);
  if (!current && !requested) {
    return buildRewardArtifactOperationDecision({
      allowed: true,
      idempotent: true,
      current,
      requested,
      reason: "EMPTY",
    });
  }
  if (!current) {
    const allowed = isValidAbyssalRewardArtifactDestructionOperation(requested);
    return buildRewardArtifactOperationDecision({
      allowed,
      idempotent: false,
      current,
      requested,
      reason: allowed ? "CLAIM_CREATED" : "REQUESTED_OPERATION_INVALID",
    });
  }
  if (!requested) {
    return buildRewardArtifactOperationDecision({
      allowed: false,
      idempotent: false,
      current,
      requested,
      reason: "REWARD_ARTIFACT_OPERATION_CANNOT_BE_CLEARED",
    });
  }
  if (!isSameAbyssalRewardArtifactDestructionIdentity(current, requested)) {
    return buildRewardArtifactOperationDecision({
      allowed: false,
      idempotent: false,
      current,
      requested,
      reason: "REWARD_ARTIFACT_OPERATION_IDENTITY_CONFLICT",
    });
  }
  const currentRank = toInteger(
    ABYSSAL_REWARD_ARTIFACT_DESTRUCTION_STATUS_RANK[current.status],
    0,
  );
  const requestedRank = toInteger(
    ABYSSAL_REWARD_ARTIFACT_DESTRUCTION_STATUS_RANK[requested.status],
    0,
  );
  if (requestedRank < currentRank) {
    return buildRewardArtifactOperationDecision({
      allowed: false,
      idempotent: false,
      current,
      requested,
      reason: "REWARD_ARTIFACT_OPERATION_STATUS_REGRESSION",
    });
  }
  if (currentRank >= 3 && requested.status !== current.status) {
    return buildRewardArtifactOperationDecision({
      allowed: false,
      idempotent: false,
      current,
      requested,
      reason: "REWARD_ARTIFACT_OPERATION_TERMINAL",
    });
  }
  const idempotent = requested.status === current.status;
  return buildRewardArtifactOperationDecision({
    allowed: true,
    idempotent,
    current,
    requested,
    reason: idempotent ? "IDEMPOTENT" : "STATUS_ADVANCED",
  });
}

function evaluateAbyssalRewardArtifactDestructionTransition(input = {}) {
  const claimOperationID = normalizeText(input.claimOperationID, "");
  const currentOperationID = normalizeText(input.currentOperationID, "");
  const currentStatus = normalizeLowerText(input.currentStatus, "");
  const suppressed = Boolean(
    input.suppressionPresent === true ||
      input.artifactExplicitlySuppressed === true ||
      input.terminalBlocked === true,
  );

  if (!claimOperationID) {
    return suppressed
      ? {
          allowed: true,
          action:
            ABYSSAL_TERMINAL_TRANSITION_ACTION.SUPPRESS_UNCLAIMED_REWARD_ARTIFACT,
          duplicate: false,
          suppressed: true,
          reason: "REWARD_ARTIFACT_DESTRUCTION_SUPPRESSED",
        }
      : {
          allowed: false,
          action:
            ABYSSAL_TERMINAL_TRANSITION_ACTION.REQUIRE_REWARD_ARTIFACT_CLAIM,
          duplicate: false,
          suppressed: false,
          reason: "ABYSSAL_REWARD_ARTIFACT_DURABLE_CLAIM_REQUIRED",
        };
  }
  if (!currentOperationID || currentOperationID !== claimOperationID) {
    return {
      allowed: false,
      action: ABYSSAL_TERMINAL_TRANSITION_ACTION.NONE,
      duplicate: false,
      suppressed: false,
      reason: "ABYSSAL_REWARD_ARTIFACT_CLAIM_MISMATCH",
    };
  }
  if ([
    ABYSSAL_REWARD_ARTIFACT_DESTRUCTION_STATUS.REWARD_COMPLETED,
    ABYSSAL_REWARD_ARTIFACT_DESTRUCTION_STATUS.SUPPRESSED,
  ].includes(currentStatus)) {
    return {
      allowed: true,
      action:
        ABYSSAL_TERMINAL_TRANSITION_ACTION.RECONCILE_REWARD_ARTIFACT_OPERATION,
      duplicate: true,
      suppressed:
        currentStatus === ABYSSAL_REWARD_ARTIFACT_DESTRUCTION_STATUS.SUPPRESSED,
      reason: "REWARD_ARTIFACT_DESTRUCTION_ALREADY_SETTLED",
    };
  }
  return {
    allowed: true,
    action:
      ABYSSAL_TERMINAL_TRANSITION_ACTION.COMMIT_REWARD_ARTIFACT_SOURCE_DESTROYED,
    duplicate: currentStatus ===
      ABYSSAL_REWARD_ARTIFACT_DESTRUCTION_STATUS.SOURCE_DESTROYED,
    suppressed: false,
    reason: currentStatus ===
      ABYSSAL_REWARD_ARTIFACT_DESTRUCTION_STATUS.SOURCE_DESTROYED
      ? "REWARD_ARTIFACT_SOURCE_DESTRUCTION_RECONCILIATION_REQUIRED"
      : "REWARD_ARTIFACT_SOURCE_DESTRUCTION_COMMIT_REQUIRED",
  };
}

module.exports = {
  ABYSSAL_PARTICIPANT_DESTRUCTION_OPERATION_SCHEMA_VERSION,
  ABYSSAL_PARTICIPANT_DESTRUCTION_OPERATION_STATUS,
  ABYSSAL_PARTICIPANT_DESTRUCTION_STATUS_RANK,
  ABYSSAL_PARTICIPANT_TERMINAL_CAUSE,
  ABYSSAL_REWARD_ARTIFACT_DESTRUCTION_OPERATION_SCHEMA_VERSION,
  ABYSSAL_REWARD_ARTIFACT_DESTRUCTION_STATUS,
  ABYSSAL_REWARD_ARTIFACT_DESTRUCTION_STATUS_RANK,
  ABYSSAL_RUN_OUTCOME,
  ABYSSAL_TERMINAL_TRANSITION_ACTION,
  evaluateAbyssalParticipantDestructionOperationTransition,
  evaluateAbyssalParticipantDestructionTransition,
  evaluateAbyssalRewardArtifactDestructionOperationTransition,
  evaluateAbyssalRewardArtifactDestructionTransition,
  evaluateAbyssalRunOutcomeTransition,
  evaluateAbyssalTerminalOperationGuard,
  hasFailedParticipantShipDestroyedOutcome,
  hasFailedTimeoutOutcome,
  hasImmutableAbyssalRunOutcome,
  hasTerminalFailureOutcome,
  isKnownAbyssalParticipantDestructionStatus,
  isKnownAbyssalRunOutcome,
  isSameAbyssalParticipantDestructionIdentity,
  isSameAbyssalRewardArtifactDestructionIdentity,
  isValidAbyssalParticipantDestructionOperation,
  isValidAbyssalRewardArtifactDestructionOperation,
  normalizeAbyssalParticipantDestructionOperation,
  normalizeAbyssalRewardArtifactDestructionOperation,
  normalizeAbyssalRunOutcome,
  resolveAbyssalTerminalCallbackReason,
};
