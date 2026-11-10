"use strict";

const {
  evaluateAbyssalRunOutcomeTransition,
  normalizeAbyssalRunOutcome,
} = require("../domain/abyssalTerminalTransitionPolicy");

const ABYSSAL_RUN_OUTCOME_COMMIT_STATUS = Object.freeze({
  COMMITTED: "committed",
  UNCHANGED: "unchanged",
  REJECTED: "rejected",
  READBACK_UNAVAILABLE: "readback_unavailable",
  READBACK_MISMATCH: "readback_mismatch",
});

function buildCommitResult({
  status,
  committed,
  changed,
  writeAttempted,
  state,
  previousOutcome,
  outcome,
  transition,
}) {
  return {
    status,
    committed,
    changed,
    writeAttempted,
    state: state || null,
    previousOutcome,
    outcome,
    transition,
  };
}

function createAbyssalRunOutcomeCommitCoordinator(dependencies = {}) {
  const { readRunOutcome, updateRunOutcome } = dependencies;
  if (typeof readRunOutcome !== "function") {
    throw new TypeError("readRunOutcome dependency is required");
  }
  if (typeof updateRunOutcome !== "function") {
    throw new TypeError("updateRunOutcome dependency is required");
  }

  function commitAbyssalRunOutcome(request = {}) {
    const {
      instanceID,
      currentState: fallbackState = null,
      requestedOutcome,
      outcomePatch,
    } = request;
    const currentState = readRunOutcome(instanceID) || fallbackState || null;
    const transition = evaluateAbyssalRunOutcomeTransition(
      currentState && currentState.runOutcome,
      requestedOutcome,
    );

    if (!transition.allowed) {
      return buildCommitResult({
        status: ABYSSAL_RUN_OUTCOME_COMMIT_STATUS.REJECTED,
        committed: false,
        changed: false,
        writeAttempted: false,
        state: currentState,
        previousOutcome: transition.current,
        outcome: transition.current,
        transition,
      });
    }

    if (transition.idempotent) {
      return buildCommitResult({
        status: ABYSSAL_RUN_OUTCOME_COMMIT_STATUS.UNCHANGED,
        committed: true,
        changed: false,
        writeAttempted: false,
        state: currentState,
        previousOutcome: transition.current,
        outcome: transition.current,
        transition,
      });
    }

    const durableOutcomePatch =
      typeof outcomePatch === "function" ? outcomePatch() : outcomePatch;
    updateRunOutcome(instanceID, durableOutcomePatch);
    const committedState = readRunOutcome(instanceID);
    if (!committedState) {
      return buildCommitResult({
        status: ABYSSAL_RUN_OUTCOME_COMMIT_STATUS.READBACK_UNAVAILABLE,
        committed: false,
        changed: false,
        writeAttempted: true,
        state: currentState,
        previousOutcome: transition.current,
        outcome: transition.current,
        transition: {
          ...transition,
          allowed: false,
          reason: "RUN_OUTCOME_COMMIT_READBACK_UNAVAILABLE",
        },
      });
    }

    const committedOutcome = normalizeAbyssalRunOutcome(
      committedState.runOutcome,
    );
    if (committedOutcome !== transition.requested) {
      const rejectedAfterCommit = evaluateAbyssalRunOutcomeTransition(
        committedOutcome,
        transition.requested,
      );
      return buildCommitResult({
        status: ABYSSAL_RUN_OUTCOME_COMMIT_STATUS.READBACK_MISMATCH,
        committed: false,
        changed: false,
        writeAttempted: true,
        state: committedState,
        previousOutcome: transition.current,
        outcome: committedOutcome,
        transition: {
          ...rejectedAfterCommit,
          allowed: false,
          reason: "RUN_OUTCOME_COMMIT_DID_NOT_MATCH_REQUEST",
        },
      });
    }

    return buildCommitResult({
      status: ABYSSAL_RUN_OUTCOME_COMMIT_STATUS.COMMITTED,
      committed: true,
      changed: true,
      writeAttempted: true,
      state: committedState,
      previousOutcome: transition.current,
      outcome: committedOutcome,
      transition,
    });
  }

  return Object.freeze({ commitAbyssalRunOutcome });
}

module.exports = {
  ABYSSAL_RUN_OUTCOME_COMMIT_STATUS,
  createAbyssalRunOutcomeCommitCoordinator,
};
