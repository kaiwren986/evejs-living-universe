"use strict";

const ABYSSAL_DEADLINE_ACTION = Object.freeze({
  NONE: "none",
  SETTLE_TIMEOUT: "settleTimeout",
  RECONCILE_PARTICIPANT_DESTRUCTION: "reconcileParticipantDestruction",
});

const ABYSSAL_DEADLINE_REASON = Object.freeze({
  DEADLINE_MISSING: "deadlineMissing",
  NOT_EXPIRED: "notExpired",
  DEADLINE_EXPIRED: "deadlineExpired",
  TIMEOUT_SETTLEMENT_PENDING: "timeoutSettlementPending",
  TIMEOUT_ALREADY_SETTLED: "timeoutAlreadySettled",
  PARTICIPANT_DESTRUCTION_TERMINAL: "participantDestructionTerminal",
  OTHER_TERMINAL_OUTCOME: "otherTerminalOutcome",
});

function toInteger(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function resolveAbyssalRunDeadlineMs(input = {}) {
  const expiresAtMs = toInteger(input.expiresAtMs, 0);
  if (input.anchored === true) {
    return expiresAtMs;
  }
  return toInteger(input.provisionalExpiresAtMs, expiresAtMs);
}

function calculateAbyssalRemainingDuration(input = {}) {
  return Math.max(
    0,
    toInteger(input.deadlineAtMs, 0) - toInteger(input.nowMs, 0),
  );
}

function classifyAbyssalRunDeadline(input = {}) {
  const deadlineAtMs = Object.prototype.hasOwnProperty.call(input, "deadlineAtMs")
    ? toInteger(input.deadlineAtMs, 0)
    : resolveAbyssalRunDeadlineMs(input.deadline);
  const nowMs = toInteger(input.nowMs, 0);
  const deadlinePresent = deadlineAtMs > 0;
  return {
    deadlineAtMs,
    deadlineSource: deadlinePresent
      ? input.deadline && input.deadline.anchored === true
        ? "anchored"
        : "persisted"
      : "missing",
    expired: deadlinePresent && nowMs >= deadlineAtMs,
    remainingMs: calculateAbyssalRemainingDuration({
      nowMs,
      deadlineAtMs,
    }),
  };
}

function resolveAbyssalTimeoutDecision(input = {}) {
  const deadline = classifyAbyssalRunDeadline(input);
  const lifecycle = input.lifecycle && typeof input.lifecycle === "object"
    ? input.lifecycle
    : {};
  const timeout = input.timeout && typeof input.timeout === "object"
    ? input.timeout
    : {};

  if (lifecycle.participantDestructionCommitted === true) {
    return {
      ...deadline,
      action: ABYSSAL_DEADLINE_ACTION.RECONCILE_PARTICIPANT_DESTRUCTION,
      reason: ABYSSAL_DEADLINE_REASON.PARTICIPANT_DESTRUCTION_TERMINAL,
    };
  }

  if (lifecycle.timeoutCommitted === true) {
    return {
      ...deadline,
      action: timeout.alreadySettled === true
        ? ABYSSAL_DEADLINE_ACTION.NONE
        : ABYSSAL_DEADLINE_ACTION.SETTLE_TIMEOUT,
      reason: timeout.alreadySettled === true
        ? ABYSSAL_DEADLINE_REASON.TIMEOUT_ALREADY_SETTLED
        : ABYSSAL_DEADLINE_REASON.TIMEOUT_SETTLEMENT_PENDING,
    };
  }

  if (lifecycle.terminal === true) {
    return {
      ...deadline,
      action: ABYSSAL_DEADLINE_ACTION.NONE,
      reason: ABYSSAL_DEADLINE_REASON.OTHER_TERMINAL_OUTCOME,
    };
  }

  if (timeout.alreadySettled === true) {
    return {
      ...deadline,
      action: ABYSSAL_DEADLINE_ACTION.NONE,
      reason: ABYSSAL_DEADLINE_REASON.TIMEOUT_ALREADY_SETTLED,
    };
  }

  if (!deadline.expired) {
    return {
      ...deadline,
      action: ABYSSAL_DEADLINE_ACTION.NONE,
      reason: deadline.deadlineAtMs > 0
        ? ABYSSAL_DEADLINE_REASON.NOT_EXPIRED
        : ABYSSAL_DEADLINE_REASON.DEADLINE_MISSING,
    };
  }

  return {
    ...deadline,
    action: ABYSSAL_DEADLINE_ACTION.SETTLE_TIMEOUT,
    reason: timeout.handlingInProgress === true
      ? ABYSSAL_DEADLINE_REASON.TIMEOUT_SETTLEMENT_PENDING
      : ABYSSAL_DEADLINE_REASON.DEADLINE_EXPIRED,
  };
}

module.exports = {
  ABYSSAL_DEADLINE_ACTION,
  ABYSSAL_DEADLINE_REASON,
  calculateAbyssalRemainingDuration,
  classifyAbyssalRunDeadline,
  resolveAbyssalRunDeadlineMs,
  resolveAbyssalTimeoutDecision,
};
