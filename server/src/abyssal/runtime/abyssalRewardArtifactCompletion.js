"use strict";

const { normalizeText } = require("../domain/abyssalValueUtils");
const {
  ABYSSAL_REWARD_ARTIFACT_DESTRUCTION_OPERATION_SCHEMA_VERSION,
  ABYSSAL_REWARD_ARTIFACT_DESTRUCTION_STATUS,
  ABYSSAL_TERMINAL_TRANSITION_ACTION,
  normalizeAbyssalRewardArtifactDestructionOperation,
  isValidAbyssalRewardArtifactDestructionOperation,
  isSameAbyssalRewardArtifactDestructionIdentity,
  evaluateAbyssalRewardArtifactDestructionTransition,
  resolveAbyssalTerminalCallbackReason,
} = require("../domain/abyssalTerminalTransitionPolicy");
const { createAbyssalRewardGrantCompletionCoordinator } = require("./abyssalRewardGrantCompletionCoordinator");

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function finalizeDurableAbyssalRewardArtifactOperation({
  getDependencies,
  getAbyssalRewardArtifactDestructionOperation,
  persistAndVerifyAbyssalRewardArtifactDestructionOperation,
  commitAbyssalRewardArtifactDestructionOperationState,
  listUniquePositiveInts,
  resolveRewardArtifactCompletion,
},
  pocketState,
  operation,
  deps = getDependencies(),
  options = {},
) {

  const sourceItemID = toInt(operation && operation.sourceStructureItemID, 0);
  const current = getAbyssalRewardArtifactDestructionOperation(
    pocketState,
    sourceItemID,
  );
  if (
    !current ||
    !isSameAbyssalRewardArtifactDestructionIdentity(current, operation)
  ) {
    return { success: false, errorMsg: "ABYSSAL_REWARD_ARTIFACT_OPERATION_MISSING" };
  }
  const completionCoordinator =
    createAbyssalRewardGrantCompletionCoordinator({
      commitRewardArtifactOperation({ requestedOperation }) {
        if (
          current.status ===
          ABYSSAL_REWARD_ARTIFACT_DESTRUCTION_STATUS.REWARD_COMPLETED
        ) {
          return persistAndVerifyAbyssalRewardArtifactDestructionOperation(
            pocketState,
            sourceItemID,
            deps,
            requestedOperation,
          );
        }
        return commitAbyssalRewardArtifactDestructionOperationState(
          pocketState,
          requestedOperation,
          deps,
        );
      },
    });
  if (
    current.status ===
    ABYSSAL_REWARD_ARTIFACT_DESTRUCTION_STATUS.REWARD_COMPLETED
  ) {
    const alreadyCompleteResult =
      completionCoordinator.completeRewardGrant({
        runID: current.runID,
        roomIndex: current.roomIndex,
        sourceStructureItemID: sourceItemID,
        artifactOperationID: current.operationID,
        destinationContainerItemIDs: listUniquePositiveInts(
          current.receipt && current.receipt.lootContainerItemIDs,
        ),
        currentOperation: current,
        requestedOperation: current,
      });
    const alreadyCompleteCommitResult =
      alreadyCompleteResult.commitResult || {};
    return {
      ...alreadyCompleteCommitResult,
      success: alreadyCompleteResult.completed === true,
      pending: alreadyCompleteResult.completed !== true,
      operation: alreadyCompleteResult.operation || current,
      completionCoordinatorResult: alreadyCompleteResult,
    };
  }
  return resolveRewardArtifactCompletion({
    pocketState,
    operation,
    deps,
    options,
    sourceItemID,
    current,
    completionCoordinator,
  });
}

function resolveRewardArtifactCompletion({
  getPlaceholderRoomEntry,
  getAbyssalRoomRewardSuppressionReason,
  listUniquePositiveInts,
  cloneValue,
  commitAbyssalRewardArtifactDestructionOperationState,
  buildAbyssalPersistencePendingResult,
  getAuthoritativeAbyssalPocketState,
  abyssalRunWorkStore,
  commitVerifiedRewardArtifactCompletion,
}, attempt) {
  const { pocketState, current, options, sourceItemID, deps } = attempt;
const roomEntry = getPlaceholderRoomEntry(pocketState, current.roomIndex);
  const suppressionReason = normalizeText(
    options.suppressionReason,
    getAbyssalRoomRewardSuppressionReason(
      pocketState,
      current.roomIndex,
    ),
  );
  const completed = current.artifactKind === "reward_cache"
    ? roomEntry.cacheRewardMaterialized === true &&
      toInt(roomEntry.cacheLootContainerItemID, 0) > 0 &&
      !roomEntry.cacheRewardRetryIntent
    : listUniquePositiveInts(
        roomEntry.extractionNodeRewardMaterializedItemIDs,
      ).includes(sourceItemID) &&
      !(roomEntry.extractionNodeRewardRetryIntentsByItemID || {})[
        String(sourceItemID)
      ];
  if (!completed && !suppressionReason) {
    return {
      success: false,
      pending: true,
      errorMsg: "ABYSSAL_REWARD_ARTIFACT_REWARD_PENDING",
    };
  }
  const nowMs = toInt(
    deps && typeof deps.now === "function" ? deps.now() : Date.now(),
    Date.now(),
  );
  const completedOperation = normalizeAbyssalRewardArtifactDestructionOperation({
    ...cloneValue(current),
    status: suppressionReason
      ? ABYSSAL_REWARD_ARTIFACT_DESTRUCTION_STATUS.SUPPRESSED
      : ABYSSAL_REWARD_ARTIFACT_DESTRUCTION_STATUS.REWARD_COMPLETED,
    suppressionReason: suppressionReason || current.suppressionReason,
    rewardCompletedAtMs: nowMs,
    receipt: {
      operationID: current.operationID,
      sourceStructureItemID: sourceItemID,
      outcome: suppressionReason ? "suppressed" : "reward_completed",
      reason: suppressionReason || null,
      lootContainerItemIDs: suppressionReason
        ? []
        : current.artifactKind === "reward_cache"
          ? [toInt(roomEntry.cacheLootContainerItemID, 0)]
          : listUniquePositiveInts(roomEntry.extractionNodeLootContainerItemIDs),
      committedAtMs: nowMs,
    },
  });
  if (suppressionReason) {
    const suppressionCommitResult =
      commitAbyssalRewardArtifactDestructionOperationState(
        pocketState,
        completedOperation,
        deps,
      );
    if (!suppressionCommitResult || suppressionCommitResult.success !== true) {
      const failure = buildAbyssalPersistencePendingResult(
        pocketState,
        normalizeText(
          suppressionCommitResult && suppressionCommitResult.errorMsg,
          "ABYSSAL_REWARD_ARTIFACT_FINAL_RECEIPT_FAILED",
        ),
        deps,
        {
          defaultErrorMsg: "ABYSSAL_REWARD_ARTIFACT_FINAL_RECEIPT_FAILED",
          operation: current,
          persistenceResult:
            suppressionCommitResult &&
            suppressionCommitResult.coordinatorResult &&
            suppressionCommitResult.coordinatorResult.writeResult,
        },
      );
      return { ...failure, data: failure.pocketState };
    }
    const suppressedState = cloneValue(suppressionCommitResult.pocketState) ||
      getAuthoritativeAbyssalPocketState(pocketState.instanceID, pocketState);
    abyssalRunWorkStore.deletePersistenceFailure(toInt(pocketState.instanceID, 0));
    return {
      success: true,
      pending: false,
      persistedInstance: suppressionCommitResult.persistedInstance,
      data: suppressedState,
      operation: suppressionCommitResult.operation,
    };
  }
  return commitVerifiedRewardArtifactCompletion({
    ...attempt,
    roomEntry,
    suppressionReason,
    completed,
    nowMs,
    completedOperation,
  });
}

function commitVerifiedRewardArtifactCompletion({
  listUniquePositiveInts,
  buildAbyssalRewardManifestReceiptKey,
  buildAbyssalPersistencePendingResult,
  cloneValue,
  getAuthoritativeAbyssalPocketState,
  abyssalRunWorkStore,
}, attempt) {
  const { current, roomEntry, pocketState, sourceItemID, completed, completionCoordinator, completedOperation, deps } = attempt;
const destinationContainerItemIDs = current.artifactKind === "reward_cache"
    ? [toInt(roomEntry.cacheLootContainerItemID, 0)]
    : listUniquePositiveInts(roomEntry.extractionNodeLootContainerItemIDs);
  const rewardPlan = current.artifactKind === "reward_cache" &&
    roomEntry.cacheRewardPlan &&
    typeof roomEntry.cacheRewardPlan === "object"
      ? roomEntry.cacheRewardPlan
      : null;
  const grantProgress = rewardPlan && rewardPlan.grantProgress;
  const receiptKey = current.artifactKind === "reward_cache"
    ? normalizeText(
        grantProgress && Array.isArray(grantProgress.receiptKeys)
          ? grantProgress.receiptKeys[0]
          : "",
        "",
      )
    : buildAbyssalRewardManifestReceiptKey(
        pocketState,
        current.roomIndex,
        destinationContainerItemIDs[0],
        sourceItemID,
      );
  const grantProgressVerified = current.artifactKind === "reward_cache"
    ? Boolean(
        rewardPlan &&
        grantProgress &&
        grantProgress.status === "completed" &&
        receiptKey,
      )
    : completed;
  const completionCoordinatorResult = completionCoordinator.completeRewardGrant({
    runID: current.runID,
    roomIndex: current.roomIndex,
    sourceStructureItemID: sourceItemID,
    artifactOperationID: current.operationID,
    planID: normalizeText(rewardPlan && rewardPlan.planID, ""),
    grantIDs: rewardPlan && Array.isArray(rewardPlan.entries)
      ? rewardPlan.entries.map((entry) => entry && entry.grantID)
      : [],
    receiptKey,
    destinationContainerItemIDs,
    physicalGrantVerified: completed,
    grantReceiptVerified: Boolean(receiptKey),
    manifestVerified: completed,
    blueprintStateVerified: completed,
    grantProgressVerified,
    currentOperation: current,
    requestedOperation: completedOperation,
  });
  const commitResult = completionCoordinatorResult &&
    completionCoordinatorResult.commitResult;
  if (!completionCoordinatorResult || completionCoordinatorResult.completed !== true) {
    const failure = buildAbyssalPersistencePendingResult(
      pocketState,
      normalizeText(
        completionCoordinatorResult && completionCoordinatorResult.errorMsg,
        "ABYSSAL_REWARD_ARTIFACT_FINAL_RECEIPT_FAILED",
      ),
      deps,
      {
        defaultErrorMsg: "ABYSSAL_REWARD_ARTIFACT_FINAL_RECEIPT_FAILED",
        operation: current,
        persistenceResult: commitResult && commitResult.coordinatorResult &&
          commitResult.coordinatorResult.writeResult,
      },
    );
    return {
      ...failure,
      data: failure.pocketState,
      completionCoordinatorResult,
    };
  }
  const updatedState = cloneValue(commitResult.pocketState) ||
    getAuthoritativeAbyssalPocketState(pocketState.instanceID, pocketState);
  const registered = commitResult.operation;
  abyssalRunWorkStore.deletePersistenceFailure(toInt(pocketState.instanceID, 0));
  return {
    success: true,
    pending: false,
    persistedInstance: commitResult.persistedInstance,
    data: updatedState,
    operation: registered,
    completionCoordinatorResult,
  };
}

// Capture supplied capabilities once, as the original closure did. Internal
// callbacks are bound once per instance; no runtime state lives in this wiring.
function createAbyssalRewardArtifactCompletion({
  getDependencies,
  getAbyssalRewardArtifactDestructionOperation,
  persistAndVerifyAbyssalRewardArtifactDestructionOperation,
  commitAbyssalRewardArtifactDestructionOperationState,
  listUniquePositiveInts,
  getPlaceholderRoomEntry,
  getAbyssalRoomRewardSuppressionReason,
  cloneValue,
  buildAbyssalPersistencePendingResult,
  getAuthoritativeAbyssalPocketState,
  abyssalRunWorkStore,
  buildAbyssalRewardManifestReceiptKey,
}) {

  const ports = {
    getDependencies,
    getAbyssalRewardArtifactDestructionOperation,
    persistAndVerifyAbyssalRewardArtifactDestructionOperation,
    commitAbyssalRewardArtifactDestructionOperationState,
    listUniquePositiveInts,
    getPlaceholderRoomEntry,
    getAbyssalRoomRewardSuppressionReason,
    cloneValue,
    buildAbyssalPersistencePendingResult,
    getAuthoritativeAbyssalPocketState,
    abyssalRunWorkStore,
    buildAbyssalRewardManifestReceiptKey,
  };
  ports.finalizeDurableAbyssalRewardArtifactOperation = finalizeDurableAbyssalRewardArtifactOperation.bind(null, ports);
  ports.resolveRewardArtifactCompletion = resolveRewardArtifactCompletion.bind(null, ports);
  ports.commitVerifiedRewardArtifactCompletion = commitVerifiedRewardArtifactCompletion.bind(null, ports);
  Object.freeze(ports);
  return Object.freeze({ finalizeDurableAbyssalRewardArtifactOperation: ports.finalizeDurableAbyssalRewardArtifactOperation });
}

module.exports = { createAbyssalRewardArtifactCompletion };
