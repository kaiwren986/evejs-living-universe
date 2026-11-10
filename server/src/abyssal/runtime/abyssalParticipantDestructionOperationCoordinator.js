"use strict";

const {
  ABYSSAL_PARTICIPANT_DESTRUCTION_STATUS_RANK,
  ABYSSAL_TERMINAL_TRANSITION_ACTION,
  evaluateAbyssalParticipantDestructionOperationTransition,
  isSameAbyssalParticipantDestructionIdentity,
  normalizeAbyssalParticipantDestructionOperation,
} = require("../domain/abyssalTerminalTransitionPolicy");
const {
  performDurableWriteAndReadback,
} = require("./abyssalDurableReadbackCommit");

const ABYSSAL_PARTICIPANT_DESTRUCTION_OPERATION_COMMIT_STATUS = Object.freeze({
  COMMITTED: "committed",
  RECONCILED: "reconciled",
  UNCHANGED: "unchanged",
  REJECTED: "rejected",
  WRITE_FAILED: "write_failed",
  READBACK_UNAVAILABLE: "readback_unavailable",
  READBACK_MISMATCH: "readback_mismatch",
});

function toInteger(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function normalizeReadResult(readResult, fallbackState, fallbackOperation) {
  if (
    readResult &&
    typeof readResult === "object" &&
    (
      Object.prototype.hasOwnProperty.call(readResult, "operation") ||
      Object.prototype.hasOwnProperty.call(readResult, "state") ||
      Object.prototype.hasOwnProperty.call(readResult, "pocketState")
    )
  ) {
    return {
      state: readResult.state || readResult.pocketState || fallbackState || null,
      operation: normalizeAbyssalParticipantDestructionOperation(
        readResult.operation,
      ),
    };
  }
  return {
    state: fallbackState || null,
    operation: normalizeAbyssalParticipantDestructionOperation(
      readResult || fallbackOperation,
    ),
  };
}

function buildCommitResult({
  status,
  committed,
  changed,
  writeAttempted,
  state,
  previousOperation,
  operation,
  transition,
  writeResult = null,
  errorMsg = "",
}) {
  return {
    status,
    committed,
    changed,
    writeAttempted,
    state: state || null,
    previousOperation: previousOperation || null,
    operation: operation || null,
    previousOperationStatus: previousOperation && previousOperation.status || "",
    operationStatus: operation && operation.status || "",
    transition,
    writeResult,
    errorMsg,
  };
}

function commitAbyssalParticipantDestructionOperation({ readParticipantOperation, updateParticipantOperation }, request = {}) {
  const instanceID = toInteger(request.instanceID, 0);
  const participantCharacterID = toInteger(
    request.participantCharacterID,
    0,
  );
  const requestedOperation =
    normalizeAbyssalParticipantDestructionOperation(
      request.requestedOperation,
    );
  const initialRead = normalizeReadResult(
    readParticipantOperation(instanceID, participantCharacterID, {
      phase: "current",
      fallbackState: request.currentState || null,
    }),
    request.currentState || null,
    request.currentOperation || null,
  );
  const currentOperation = initialRead.operation;
  let transition = evaluateAbyssalParticipantDestructionOperationTransition(
    currentOperation,
    requestedOperation,
  );

  if (
    requestedOperation &&
    (
      instanceID <= 0 ||
      participantCharacterID <= 0 ||
      requestedOperation.runID !== instanceID ||
      requestedOperation.characterID !== participantCharacterID
    )
  ) {
    transition = {
      ...transition,
      allowed: false,
      idempotent: false,
      action: ABYSSAL_TERMINAL_TRANSITION_ACTION.NONE,
      reason: "DESTRUCTION_OPERATION_REQUEST_SCOPE_MISMATCH",
      nextOperation: currentOperation,
    };
  }

  if (!transition.allowed) {
    return buildCommitResult({
      status:
        ABYSSAL_PARTICIPANT_DESTRUCTION_OPERATION_COMMIT_STATUS.REJECTED,
      committed: false,
      changed: false,
      writeAttempted: false,
      state: initialRead.state,
      previousOperation: currentOperation,
      operation: currentOperation,
      transition,
      errorMsg: transition.reason,
    });
  }

  if (!requestedOperation) {
    return buildCommitResult({
      status:
        ABYSSAL_PARTICIPANT_DESTRUCTION_OPERATION_COMMIT_STATUS.UNCHANGED,
      committed: true,
      changed: false,
      writeAttempted: false,
      state: initialRead.state,
      previousOperation: currentOperation,
      operation: currentOperation,
      transition,
    });
  }
  return persistDestructionOperation({ readParticipantOperation, updateParticipantOperation }, {
    request,
    instanceID,
    participantCharacterID,
    requestedOperation,
    initialRead,
    currentOperation,
    transition,
  });
}

function persistDestructionOperation({ readParticipantOperation, updateParticipantOperation }, attempt) {
  const {
    request,
    instanceID,
    participantCharacterID,
    requestedOperation,
    initialRead,
    currentOperation,
    transition,
  } = attempt;
  const operationPatch = typeof request.operationPatch === "function"
    ? request.operationPatch({
        state: initialRead.state,
        currentOperation,
        requestedOperation,
        transition,
      })
    : request.operationPatch;
  const durableCommit = performDurableWriteAndReadback({
    write: updateParticipantOperation,
    writeArguments: [
      instanceID,
      participantCharacterID,
      operationPatch,
      {
        currentOperation,
        requestedOperation,
        transition,
      },
    ],
    read: (writeResult) => readParticipantOperation(
      instanceID,
      participantCharacterID,
      {
        phase: "readback",
        fallbackState: initialRead.state,
        writeResult,
      },
    ),
  });
  const { writeResult } = durableCommit;
  if (!durableCommit.writeCompleted) {
    return buildCommitResult({
      status:
        ABYSSAL_PARTICIPANT_DESTRUCTION_OPERATION_COMMIT_STATUS.WRITE_FAILED,
      committed: false,
      changed: false,
      writeAttempted: true,
      state: initialRead.state,
      previousOperation: currentOperation,
      operation: currentOperation,
      transition,
      writeResult,
      errorMsg:
        String(writeResult.errorMsg || "").trim() ||
        "ABYSSAL_PARTICIPANT_DESTRUCTION_PERSIST_FAILED",
    });
  }
  return verifyDestructionReadback({ ...attempt, durableCommit, writeResult });
}

function verifyDestructionReadback(attempt) {
  const {
    instanceID,
    participantCharacterID,
    requestedOperation,
    initialRead,
    currentOperation,
    transition,
    durableCommit,
    writeResult,
  } = attempt;
  const committedRead = normalizeReadResult(
    durableCommit.readbackState,
    initialRead.state,
    null,
  );
  const committedOperation = committedRead.operation;
  if (!committedOperation) {
    return buildCommitResult({
      status:
        ABYSSAL_PARTICIPANT_DESTRUCTION_OPERATION_COMMIT_STATUS
          .READBACK_UNAVAILABLE,
      committed: false,
      changed: false,
      writeAttempted: true,
      state: initialRead.state,
      previousOperation: currentOperation,
      operation: currentOperation,
      transition: {
        ...transition,
        allowed: false,
        reason: "ABYSSAL_PARTICIPANT_DESTRUCTION_READBACK_UNAVAILABLE",
      },
      writeResult,
      errorMsg: "ABYSSAL_PARTICIPANT_DESTRUCTION_READBACK_UNAVAILABLE",
    });
  }

  const requestedRank = toInteger(
    ABYSSAL_PARTICIPANT_DESTRUCTION_STATUS_RANK[requestedOperation.status],
    0,
  );
  const committedRank = toInteger(
    ABYSSAL_PARTICIPANT_DESTRUCTION_STATUS_RANK[committedOperation.status],
    0,
  );
  if (
    committedOperation.runID !== instanceID ||
    committedOperation.characterID !== participantCharacterID ||
    !isSameAbyssalParticipantDestructionIdentity(
      requestedOperation,
      committedOperation,
    ) ||
    committedRank < requestedRank
  ) {
    return buildCommitResult({
      status:
        ABYSSAL_PARTICIPANT_DESTRUCTION_OPERATION_COMMIT_STATUS
          .READBACK_MISMATCH,
      committed: false,
      changed: false,
      writeAttempted: true,
      state: committedRead.state,
      previousOperation: currentOperation,
      operation: committedOperation,
      transition: {
        ...transition,
        allowed: false,
        reason: "ABYSSAL_PARTICIPANT_DESTRUCTION_READBACK_MISMATCH",
      },
      writeResult,
      errorMsg: "ABYSSAL_PARTICIPANT_DESTRUCTION_READBACK_MISMATCH",
    });
  }

  return buildCommitResult({
    status: transition.idempotent
      ? ABYSSAL_PARTICIPANT_DESTRUCTION_OPERATION_COMMIT_STATUS.RECONCILED
      : ABYSSAL_PARTICIPANT_DESTRUCTION_OPERATION_COMMIT_STATUS.COMMITTED,
    committed: true,
    changed: !transition.idempotent,
    writeAttempted: true,
    state: committedRead.state,
    previousOperation: currentOperation,
    operation: committedOperation,
    transition,
    writeResult,
  });
}

function createAbyssalParticipantDestructionOperationCoordinator(
  dependencies = {},
) {
  const { readParticipantOperation, updateParticipantOperation } = dependencies;
  if (typeof readParticipantOperation !== "function") {
    throw new TypeError("readParticipantOperation dependency is required");
  }
  if (typeof updateParticipantOperation !== "function") {
    throw new TypeError("updateParticipantOperation dependency is required");
  }
  const ports = Object.freeze({ readParticipantOperation, updateParticipantOperation });
  return Object.freeze({
    commitAbyssalParticipantDestructionOperation: commitAbyssalParticipantDestructionOperation.bind(null, ports),
  });
}

module.exports = {
  ABYSSAL_PARTICIPANT_DESTRUCTION_OPERATION_COMMIT_STATUS,
  createAbyssalParticipantDestructionOperationCoordinator,
};
