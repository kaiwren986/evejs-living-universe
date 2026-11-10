"use strict";

const {
  ABYSSAL_TERMINAL_TRANSITION_ACTION,
  evaluateAbyssalRewardArtifactDestructionOperationTransition,
  isSameAbyssalRewardArtifactDestructionIdentity,
  normalizeAbyssalRewardArtifactDestructionOperation,
} = require("../domain/abyssalTerminalTransitionPolicy");
const {
  performDurableWriteAndReadback,
} = require("./abyssalDurableReadbackCommit");

const ABYSSAL_REWARD_ARTIFACT_DESTRUCTION_OPERATION_COMMIT_STATUS =
  Object.freeze({
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
      operation: normalizeAbyssalRewardArtifactDestructionOperation(
        readResult.operation,
      ),
    };
  }
  return {
    state: fallbackState || null,
    operation: normalizeAbyssalRewardArtifactDestructionOperation(
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

function commitAbyssalRewardArtifactDestructionOperation({ readRewardArtifactOperation, updateRewardArtifactOperation }, request = {}) {
  const instanceID = toInteger(request.instanceID, 0);
  const sourceStructureItemID = toInteger(
    request.sourceStructureItemID,
    0,
  );
  const requestedOperation =
    normalizeAbyssalRewardArtifactDestructionOperation(
      request.requestedOperation,
    );
  const initialRead = normalizeReadResult(
    readRewardArtifactOperation(instanceID, sourceStructureItemID, {
      phase: "current",
      fallbackState: request.currentState || null,
    }),
    request.currentState || null,
    request.currentOperation || null,
  );
  const currentOperation = initialRead.operation;
  let transition =
    evaluateAbyssalRewardArtifactDestructionOperationTransition(
      currentOperation,
      requestedOperation,
    );

  if (
    requestedOperation &&
    (
      instanceID <= 0 ||
      sourceStructureItemID <= 0 ||
      requestedOperation.runID !== instanceID ||
      requestedOperation.sourceStructureItemID !== sourceStructureItemID
    )
  ) {
    transition = {
      ...transition,
      allowed: false,
      idempotent: false,
      action: ABYSSAL_TERMINAL_TRANSITION_ACTION.NONE,
      reason: "REWARD_ARTIFACT_OPERATION_REQUEST_SCOPE_MISMATCH",
      nextOperation: currentOperation,
    };
  }

  if (!transition.allowed) {
    return buildCommitResult({
      status:
        ABYSSAL_REWARD_ARTIFACT_DESTRUCTION_OPERATION_COMMIT_STATUS.REJECTED,
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
        ABYSSAL_REWARD_ARTIFACT_DESTRUCTION_OPERATION_COMMIT_STATUS.UNCHANGED,
      committed: true,
      changed: false,
      writeAttempted: false,
      state: initialRead.state,
      previousOperation: currentOperation,
      operation: currentOperation,
      transition,
    });
  }
  return persistDestructionOperation({ readRewardArtifactOperation, updateRewardArtifactOperation }, {
    request,
    instanceID,
    sourceStructureItemID,
    requestedOperation,
    initialRead,
    currentOperation,
    transition,
  });
}

function persistDestructionOperation({ readRewardArtifactOperation, updateRewardArtifactOperation }, attempt) {
  const {
    request,
    instanceID,
    sourceStructureItemID,
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
    write: updateRewardArtifactOperation,
    writeArguments: [
      instanceID,
      sourceStructureItemID,
      operationPatch,
      {
        currentOperation,
        requestedOperation,
        transition,
      },
    ],
    read: (writeResult) => readRewardArtifactOperation(
      instanceID,
      sourceStructureItemID,
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
        ABYSSAL_REWARD_ARTIFACT_DESTRUCTION_OPERATION_COMMIT_STATUS
          .WRITE_FAILED,
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
        "ABYSSAL_REWARD_ARTIFACT_OPERATION_PERSIST_FAILED",
    });
  }
  return verifyDestructionReadback({ ...attempt, durableCommit, writeResult });
}

function verifyDestructionReadback(attempt) {
  const {
    instanceID,
    sourceStructureItemID,
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
        ABYSSAL_REWARD_ARTIFACT_DESTRUCTION_OPERATION_COMMIT_STATUS
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
        reason: "ABYSSAL_REWARD_ARTIFACT_OPERATION_READBACK_UNAVAILABLE",
      },
      writeResult,
      errorMsg: "ABYSSAL_REWARD_ARTIFACT_OPERATION_READBACK_UNAVAILABLE",
    });
  }

  const readbackTransition =
    evaluateAbyssalRewardArtifactDestructionOperationTransition(
      requestedOperation,
      committedOperation,
    );
  if (
    committedOperation.runID !== instanceID ||
    committedOperation.sourceStructureItemID !== sourceStructureItemID ||
    !isSameAbyssalRewardArtifactDestructionIdentity(
      requestedOperation,
      committedOperation,
    ) ||
    !readbackTransition.allowed
  ) {
    return buildCommitResult({
      status:
        ABYSSAL_REWARD_ARTIFACT_DESTRUCTION_OPERATION_COMMIT_STATUS
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
        reason: "ABYSSAL_REWARD_ARTIFACT_OPERATION_READBACK_MISMATCH",
      },
      writeResult,
      errorMsg: "ABYSSAL_REWARD_ARTIFACT_OPERATION_READBACK_MISMATCH",
    });
  }

  return buildCommitResult({
    status: transition.idempotent
      ? ABYSSAL_REWARD_ARTIFACT_DESTRUCTION_OPERATION_COMMIT_STATUS.RECONCILED
      : ABYSSAL_REWARD_ARTIFACT_DESTRUCTION_OPERATION_COMMIT_STATUS.COMMITTED,
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

function createAbyssalRewardArtifactDestructionOperationCoordinator(
  dependencies = {},
) {
  const {
    readRewardArtifactOperation,
    updateRewardArtifactOperation,
  } = dependencies;
  if (typeof readRewardArtifactOperation !== "function") {
    throw new TypeError("readRewardArtifactOperation dependency is required");
  }
  if (typeof updateRewardArtifactOperation !== "function") {
    throw new TypeError("updateRewardArtifactOperation dependency is required");
  }
  const ports = Object.freeze({ readRewardArtifactOperation, updateRewardArtifactOperation });
  return Object.freeze({
    commitAbyssalRewardArtifactDestructionOperation: commitAbyssalRewardArtifactDestructionOperation.bind(null, ports),
  });
}

module.exports = {
  ABYSSAL_REWARD_ARTIFACT_DESTRUCTION_OPERATION_COMMIT_STATUS,
  createAbyssalRewardArtifactDestructionOperationCoordinator,
};
