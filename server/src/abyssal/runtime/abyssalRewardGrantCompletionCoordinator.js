"use strict";

const {
  ABYSSAL_REWARD_ARTIFACT_DESTRUCTION_STATUS,
  isSameAbyssalRewardArtifactDestructionIdentity,
  isValidAbyssalRewardArtifactDestructionOperation,
  normalizeAbyssalRewardArtifactDestructionOperation,
} = require("../domain/abyssalTerminalTransitionPolicy");

const ABYSSAL_REWARD_GRANT_COMPLETION_STATUS = Object.freeze({
  COMMITTED: "committed",
  ALREADY_COMPLETE: "already_complete",
  REJECTED: "rejected",
  PREREQUISITE_FAILED: "prerequisite_failed",
  COMMIT_FAILED: "commit_failed",
  READBACK_MISMATCH: "readback_mismatch",
});

function toInteger(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function normalizeText(value, fallback = "") {
  const normalized = String(value == null ? "" : value).trim();
  return normalized || fallback;
}

function listUniquePositiveIntegers(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => toInteger(value, 0))
    .filter((value) => value > 0))];
}

function listUniqueTexts(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => normalizeText(value, ""))
    .filter(Boolean))];
}

function buildCompletionResult({
  status,
  completed,
  alreadyComplete = false,
  writeAttempted = false,
  operation = null,
  commitResult = null,
  errorMsg = "",
}) {
  return {
    status,
    completed,
    alreadyComplete,
    writeAttempted,
    operation,
    commitResult,
    errorMsg,
  };
}

function rejectCompletion(errorMsg, operation = null) {
  return buildCompletionResult({
    status: ABYSSAL_REWARD_GRANT_COMPLETION_STATUS.REJECTED,
    completed: false,
    operation,
    errorMsg,
  });
}

function rejectPrerequisite(errorMsg, operation = null) {
  return buildCompletionResult({
    status: ABYSSAL_REWARD_GRANT_COMPLETION_STATUS.PREREQUISITE_FAILED,
    completed: false,
    operation,
    errorMsg,
  });
}

function receiptMatchesCompletion(
  operation,
  artifactOperationID,
  sourceStructureItemID,
  destinationContainerItemIDs,
) {
  const receipt = operation && operation.receipt;
  return Boolean(
    receipt &&
      normalizeText(receipt.operationID, "") === artifactOperationID &&
      toInteger(receipt.sourceStructureItemID, 0) === sourceStructureItemID &&
      normalizeText(receipt.outcome, "") === "reward_completed" &&
      JSON.stringify(listUniquePositiveIntegers(receipt.lootContainerItemIDs)) ===
        JSON.stringify(destinationContainerItemIDs),
  );
}

function completeRewardGrant(ports, request = {}) {
  const runID = toInteger(request.runID, 0);
  const roomIndex = toInteger(request.roomIndex, 0);
  const sourceStructureItemID = toInteger(
    request.sourceStructureItemID,
    0,
  );
  const artifactOperationID = normalizeText(
    request.artifactOperationID,
    "",
  );
  const planID = normalizeText(request.planID, "");
  const grantIDs = listUniqueTexts(request.grantIDs);
  const receiptKey = normalizeText(request.receiptKey, "");
  const destinationContainerItemIDs = listUniquePositiveIntegers(
    request.destinationContainerItemIDs,
  );
  const currentOperation =
    normalizeAbyssalRewardArtifactDestructionOperation(
      request.currentOperation,
    );
  const requestedOperation =
    normalizeAbyssalRewardArtifactDestructionOperation(
      request.requestedOperation,
    );

  if (
    runID <= 0 ||
    roomIndex <= 0 ||
    sourceStructureItemID <= 0 ||
    !artifactOperationID ||
    !currentOperation ||
    !isValidAbyssalRewardArtifactDestructionOperation(currentOperation) ||
    currentOperation.operationID !== artifactOperationID ||
    currentOperation.runID !== runID ||
    currentOperation.roomIndex !== roomIndex ||
    currentOperation.sourceStructureItemID !== sourceStructureItemID
  ) {
    return rejectCompletion(
      "ABYSSAL_REWARD_GRANT_COMPLETION_IDENTITY_MISMATCH",
      currentOperation,
    );
  }
  return reconcileRewardGrant(ports, {
    request,
    runID,
    roomIndex,
    sourceStructureItemID,
    artifactOperationID,
    planID,
    grantIDs,
    receiptKey,
    destinationContainerItemIDs,
    currentOperation,
    requestedOperation,
  });
}

function reconcileRewardGrant(ports, attempt) {
  const {
    request,
    runID,
    roomIndex,
    sourceStructureItemID,
    artifactOperationID,
    planID,
    grantIDs,
    receiptKey,
    destinationContainerItemIDs,
    currentOperation,
    requestedOperation,
  } = attempt;
  if (currentOperation.status ===
  ABYSSAL_REWARD_ARTIFACT_DESTRUCTION_STATUS.REWARD_COMPLETED) {
    return recommitCompletedRewardGrant(ports, attempt);
  }


  if (
    currentOperation.status ===
    ABYSSAL_REWARD_ARTIFACT_DESTRUCTION_STATUS.SUPPRESSED
  ) {
    return rejectCompletion(
      "ABYSSAL_REWARD_GRANT_COMPLETION_SUPPRESSED",
      currentOperation,
    );
  }

  if (
    currentOperation.status !==
    ABYSSAL_REWARD_ARTIFACT_DESTRUCTION_STATUS.SOURCE_DESTROYED
  ) {
    return rejectCompletion(
      "ABYSSAL_REWARD_GRANT_COMPLETION_INVALID_OPERATION_STATE",
      currentOperation,
    );
  }

  if (request.physicalGrantVerified !== true) {
    return rejectPrerequisite(
      "ABYSSAL_REWARD_PHYSICAL_GRANT_UNVERIFIED",
      currentOperation,
    );
  }
  if (request.grantReceiptVerified !== true) {
    return rejectPrerequisite(
      "ABYSSAL_REWARD_GRANT_RECEIPT_UNVERIFIED",
      currentOperation,
    );
  }
  if (request.manifestVerified !== true) {
    return rejectPrerequisite(
      "ABYSSAL_REWARD_MANIFEST_UNVERIFIED",
      currentOperation,
    );
  }
  if (request.blueprintStateVerified !== true) {
    return rejectPrerequisite(
      "ABYSSAL_REWARD_BLUEPRINT_STATE_UNVERIFIED",
      currentOperation,
    );
  }
  if (request.grantProgressVerified !== true) {
    return rejectPrerequisite(
      "ABYSSAL_REWARD_GRANT_PROGRESS_UNVERIFIED",
      currentOperation,
    );
  }

  if (
    destinationContainerItemIDs.length <= 0 ||
    !receiptKey ||
    (
      currentOperation.artifactKind === "reward_cache" &&
      !planID
    ) ||
    !requestedOperation ||
    !isValidAbyssalRewardArtifactDestructionOperation(requestedOperation) ||
    requestedOperation.status !==
      ABYSSAL_REWARD_ARTIFACT_DESTRUCTION_STATUS.REWARD_COMPLETED ||
    !isSameAbyssalRewardArtifactDestructionIdentity(
      currentOperation,
      requestedOperation,
    ) ||
    !receiptMatchesCompletion(
      requestedOperation,
      artifactOperationID,
      sourceStructureItemID,
      destinationContainerItemIDs,
    )
  ) {
    return rejectCompletion(
      "ABYSSAL_REWARD_GRANT_COMPLETION_REQUEST_MISMATCH",
      currentOperation,
    );
  }
  return commitRewardGrant(ports, attempt);
}

function recommitCompletedRewardGrant({ commitRewardArtifactOperation }, attempt) {
  const {
    request,
    runID,
    roomIndex,
    sourceStructureItemID,
    artifactOperationID,
    planID,
    grantIDs,
    receiptKey,
    destinationContainerItemIDs,
    currentOperation,
    requestedOperation,
  } = attempt;

  if (
    !requestedOperation ||
    !isValidAbyssalRewardArtifactDestructionOperation(requestedOperation) ||
    requestedOperation.status !==
      ABYSSAL_REWARD_ARTIFACT_DESTRUCTION_STATUS.REWARD_COMPLETED ||
    !isSameAbyssalRewardArtifactDestructionIdentity(
      currentOperation,
      requestedOperation,
    ) ||
    !receiptMatchesCompletion(
      requestedOperation,
      artifactOperationID,
      sourceStructureItemID,
      destinationContainerItemIDs,
    )
  ) {
    return rejectCompletion(
      "ABYSSAL_REWARD_GRANT_COMPLETION_REQUEST_MISMATCH",
      currentOperation,
    );
  }
  const commitResult = commitRewardArtifactOperation({
    runID,
    roomIndex,
    sourceStructureItemID,
    artifactOperationID,
    planID,
    grantIDs,
    receiptKey,
    destinationContainerItemIDs,
    physicalGrantDuplicate: request.physicalGrantDuplicate === true,
    currentOperation,
    requestedOperation,
  });
  if (!commitResult || commitResult.success !== true) {
    return buildCompletionResult({
      status: ABYSSAL_REWARD_GRANT_COMPLETION_STATUS.COMMIT_FAILED,
      completed: false,
      alreadyComplete: true,
      writeAttempted: true,
      operation: normalizeAbyssalRewardArtifactDestructionOperation(
        commitResult && commitResult.operation,
      ) || currentOperation,
      commitResult: commitResult || null,
      errorMsg:
        normalizeText(commitResult && commitResult.errorMsg, "") ||
        "ABYSSAL_REWARD_GRANT_COMPLETION_COMMIT_FAILED",
    });
  }
  const committedOperation =
    normalizeAbyssalRewardArtifactDestructionOperation(
      commitResult.operation,
    );
  if (
    !committedOperation ||
    committedOperation.status !==
      ABYSSAL_REWARD_ARTIFACT_DESTRUCTION_STATUS.REWARD_COMPLETED ||
    !isSameAbyssalRewardArtifactDestructionIdentity(
      requestedOperation,
      committedOperation,
    ) ||
    !receiptMatchesCompletion(
      committedOperation,
      artifactOperationID,
      sourceStructureItemID,
      destinationContainerItemIDs,
    )
  ) {
    return buildCompletionResult({
      status: ABYSSAL_REWARD_GRANT_COMPLETION_STATUS.READBACK_MISMATCH,
      completed: false,
      alreadyComplete: true,
      writeAttempted: true,
      operation: committedOperation,
      commitResult,
      errorMsg: "ABYSSAL_REWARD_GRANT_COMPLETION_READBACK_MISMATCH",
    });
  }
  return buildCompletionResult({
    status: ABYSSAL_REWARD_GRANT_COMPLETION_STATUS.ALREADY_COMPLETE,
    completed: true,
    alreadyComplete: true,
    writeAttempted: true,
    operation: committedOperation,
    commitResult,
  });
}

function commitRewardGrant({ commitRewardArtifactOperation }, attempt) {
  const {
    request,
    runID,
    roomIndex,
    sourceStructureItemID,
    artifactOperationID,
    planID,
    grantIDs,
    receiptKey,
    destinationContainerItemIDs,
    currentOperation,
    requestedOperation,
  } = attempt;
  const dependencyRequest = {
    runID,
    roomIndex,
    sourceStructureItemID,
    artifactOperationID,
    planID,
    grantIDs,
    receiptKey,
    destinationContainerItemIDs,
    physicalGrantDuplicate: request.physicalGrantDuplicate === true,
    currentOperation,
    requestedOperation,
  };
  const commitResult = commitRewardArtifactOperation(dependencyRequest);
  if (!commitResult || commitResult.success !== true) {
    return buildCompletionResult({
      status: ABYSSAL_REWARD_GRANT_COMPLETION_STATUS.COMMIT_FAILED,
      completed: false,
      writeAttempted: true,
      operation: normalizeAbyssalRewardArtifactDestructionOperation(
        commitResult && commitResult.operation,
      ) || currentOperation,
      commitResult: commitResult || null,
      errorMsg:
        normalizeText(commitResult && commitResult.errorMsg, "") ||
        "ABYSSAL_REWARD_GRANT_COMPLETION_COMMIT_FAILED",
    });
  }

  const committedOperation =
    normalizeAbyssalRewardArtifactDestructionOperation(
      commitResult.operation,
    );
  if (
    !committedOperation ||
    committedOperation.status !==
      ABYSSAL_REWARD_ARTIFACT_DESTRUCTION_STATUS.REWARD_COMPLETED ||
    !isSameAbyssalRewardArtifactDestructionIdentity(
      requestedOperation,
      committedOperation,
    ) ||
    !receiptMatchesCompletion(
      committedOperation,
      artifactOperationID,
      sourceStructureItemID,
      destinationContainerItemIDs,
    )
  ) {
    return buildCompletionResult({
      status: ABYSSAL_REWARD_GRANT_COMPLETION_STATUS.READBACK_MISMATCH,
      completed: false,
      writeAttempted: true,
      operation: committedOperation,
      commitResult,
      errorMsg: "ABYSSAL_REWARD_GRANT_COMPLETION_READBACK_MISMATCH",
    });
  }

  return buildCompletionResult({
    status: ABYSSAL_REWARD_GRANT_COMPLETION_STATUS.COMMITTED,
    completed: true,
    writeAttempted: true,
    operation: committedOperation,
    commitResult,
  });
}

function createAbyssalRewardGrantCompletionCoordinator(dependencies = {}) {
  const { commitRewardArtifactOperation } = dependencies;
  if (typeof commitRewardArtifactOperation !== "function") {
    throw new TypeError("commitRewardArtifactOperation dependency is required");
  }
  const ports = Object.freeze({ commitRewardArtifactOperation });
  return Object.freeze({
    completeRewardGrant: completeRewardGrant.bind(null, ports),
  });
}

module.exports = {
  ABYSSAL_REWARD_GRANT_COMPLETION_STATUS,
  createAbyssalRewardGrantCompletionCoordinator,
};
