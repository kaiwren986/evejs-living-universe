"use strict";

const ABYSSAL_TERMINAL_ARTIFACT_CLEANUP_STAGE = Object.freeze({
  REVALIDATE_AUTHORITY: "revalidate_authority",
  RECONCILE_ARTIFACTS: "reconcile_artifacts",
  VERIFY_RESULT: "verify_result",
  PERSIST_PENDING: "persist_pending",
  COMPLETE: "complete",
});

const ABYSSAL_TERMINAL_ARTIFACT_CLEANUP_STATUS = Object.freeze({
  CLEANUP_COMPLETE: "cleanup_complete",
  ALREADY_CLEAN: "already_clean",
  CLEANUP_PENDING: "cleanup_pending",
  REJECTED: "rejected",
  FAILED: "failed",
  PERSIST_FAILED: "persist_failed",
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

function normalizeIdentity(source = {}) {
  return Object.freeze({
    instanceID: toInteger(source.instanceID, 0),
    characterID: toInteger(source.characterID, 0),
    traceItemID: toInteger(source.traceItemID, 0),
    sceneKey: normalizeText(source.sceneKey, ""),
  });
}

function identitiesMatch(left, right) {
  return Boolean(
    left &&
      right &&
      left.instanceID === right.instanceID &&
      left.characterID === right.characterID &&
      left.traceItemID === right.traceItemID &&
      left.sceneKey === right.sceneKey,
  );
}

function normalizeDependencyResult(result, fallbackErrorMsg) {
  if (!result || typeof result !== "object") {
    return { success: false, errorMsg: fallbackErrorMsg };
  }
  if (result.success === false) {
    return {
      ...result,
      success: false,
      errorMsg: normalizeText(result.errorMsg, fallbackErrorMsg),
    };
  }
  return { ...result, success: true };
}

function buildResult(identity, details = {}) {
  return {
    success: details.success === true,
    pending: details.pending === true,
    alreadyClean: details.alreadyClean === true,
    status:
      details.status || ABYSSAL_TERMINAL_ARTIFACT_CLEANUP_STATUS.FAILED,
    stage:
      details.stage ||
      ABYSSAL_TERMINAL_ARTIFACT_CLEANUP_STAGE.REVALIDATE_AUTHORITY,
    identity,
    artifactResult: details.artifactResult || null,
    cleanupSummary: details.cleanupSummary || {},
    failedArtifactCount: toInteger(details.failedArtifactCount, 0),
    failedResidualSpaceItemCount: toInteger(
      details.failedResidualSpaceItemCount,
      0,
    ),
    failedScannerProbeCleanupCount: toInteger(
      details.failedScannerProbeCleanupCount,
      0,
    ),
    pendingCleanupState: details.pendingCleanupState || null,
    persistenceResult: details.persistenceResult || null,
    stageResults: details.stageResults || {},
    errorMsg: normalizeText(details.errorMsg, ""),
  };
}

function invoke(dependencies, dependencyName, stage, stageRequest) {
  try {
    return normalizeDependencyResult(
      dependencies[dependencyName](Object.freeze(stageRequest)),
      `ABYSSAL_TERMINAL_ARTIFACT_CLEANUP_${stage.toUpperCase()}_FAILED`,
    );
  } catch (error) {
    return {
      success: false,
      thrown: true,
      errorMsg: normalizeText(
        error && error.message,
        `ABYSSAL_TERMINAL_ARTIFACT_CLEANUP_${stage.toUpperCase()}_THREW`,
      ),
    };
  }
}

function executeCleanup(dependencies, request = {}) {
  const identity = normalizeIdentity(request);
  const reason = normalizeText(request.reason, "cleanup");
  const nowMs = toInteger(request.nowMs, 0);
  const terminalCleanupState =
    request.terminalCleanupState &&
    typeof request.terminalCleanupState === "object"
      ? request.terminalCleanupState
      : {};
  const baseRequest = Object.freeze({
    ...identity,
    identity,
    reason,
    nowMs,
    terminalCleanupState,
  });
  const stageResults = {};

  if (
    identity.instanceID <= 0 ||
    !identity.sceneKey
  ) {
    return buildResult(identity, {
      status: ABYSSAL_TERMINAL_ARTIFACT_CLEANUP_STATUS.REJECTED,
      errorMsg: "ABYSSAL_TERMINAL_ARTIFACT_CLEANUP_IDENTITY_INVALID",
      stageResults,
    });
  }
  if (request.participantsSettled !== true) {
    return buildResult(identity, {
      status: ABYSSAL_TERMINAL_ARTIFACT_CLEANUP_STATUS.REJECTED,
      errorMsg: "ABYSSAL_TERMINAL_ARTIFACT_CLEANUP_PARTICIPANTS_NOT_SETTLED",
      stageResults,
    });
  }

  const revalidation = invoke(
    dependencies,
    "revalidateCleanupAuthority",
    ABYSSAL_TERMINAL_ARTIFACT_CLEANUP_STAGE.REVALIDATE_AUTHORITY,
    baseRequest,
  );
  stageResults[
    ABYSSAL_TERMINAL_ARTIFACT_CLEANUP_STAGE.REVALIDATE_AUTHORITY
  ] = revalidation;
  if (!revalidation.success) {
    return buildResult(identity, {
      status: ABYSSAL_TERMINAL_ARTIFACT_CLEANUP_STATUS.FAILED,
      stage: ABYSSAL_TERMINAL_ARTIFACT_CLEANUP_STAGE.REVALIDATE_AUTHORITY,
      errorMsg: revalidation.errorMsg,
      stageResults,
    });
  }
  const revalidatedIdentity = normalizeIdentity(
    revalidation.identity || revalidation,
  );
  if (!identitiesMatch(identity, revalidatedIdentity)) {
    return buildResult(identity, {
      status: ABYSSAL_TERMINAL_ARTIFACT_CLEANUP_STATUS.REJECTED,
      stage: ABYSSAL_TERMINAL_ARTIFACT_CLEANUP_STAGE.REVALIDATE_AUTHORITY,
      errorMsg:
        "ABYSSAL_TERMINAL_ARTIFACT_CLEANUP_AUTHORITY_IDENTITY_MISMATCH",
      stageResults,
    });
  }
  if (revalidation.cleanupPermitted !== true) {
    return buildResult(identity, {
      status: ABYSSAL_TERMINAL_ARTIFACT_CLEANUP_STATUS.REJECTED,
      stage: ABYSSAL_TERMINAL_ARTIFACT_CLEANUP_STAGE.REVALIDATE_AUTHORITY,
      errorMsg:
        normalizeText(revalidation.errorMsg, "") ||
        "ABYSSAL_TERMINAL_ARTIFACT_CLEANUP_AUTHORITY_NOT_SETTLED",
      stageResults,
    });
  }
  return reconcileCleanupArtifacts(dependencies, {
    identity,
    nowMs,
    terminalCleanupState,
    baseRequest,
    stageResults,
    revalidation,
  });
}

function reconcileCleanupArtifacts(dependencies, attempt) {
  const {
    identity,
    nowMs,
    terminalCleanupState,
    baseRequest,
    stageResults,
    revalidation,
  } = attempt;
  const rawArtifactResult = invoke(
    dependencies,
    "reconcileOwnedArtifacts",
    ABYSSAL_TERMINAL_ARTIFACT_CLEANUP_STAGE.RECONCILE_ARTIFACTS,
    {
      ...baseRequest,
      authority: revalidation,
    },
  );
  const artifactResult = {
    ...rawArtifactResult,
    destroyedItemIDs: Array.isArray(rawArtifactResult.destroyedItemIDs)
      ? rawArtifactResult.destroyedItemIDs
      : [],
    destroyedScannerProbeIDs: Array.isArray(
      rawArtifactResult.destroyedScannerProbeIDs,
    ) ? rawArtifactResult.destroyedScannerProbeIDs : [],
    destroyedHostileIDs: Array.isArray(rawArtifactResult.destroyedHostileIDs)
      ? rawArtifactResult.destroyedHostileIDs
      : [],
    cleanupSummary:
      rawArtifactResult.cleanupSummary &&
      typeof rawArtifactResult.cleanupSummary === "object"
        ? rawArtifactResult.cleanupSummary
        : {},
  };
  stageResults[
    ABYSSAL_TERMINAL_ARTIFACT_CLEANUP_STAGE.RECONCILE_ARTIFACTS
  ] = artifactResult;
  const cleanupSummary =
    artifactResult.cleanupSummary &&
    typeof artifactResult.cleanupSummary === "object"
      ? artifactResult.cleanupSummary
      : {};
  const failedArtifactCount = artifactResult.success
    ? Math.max(0, toInteger(cleanupSummary.failedArtifacts, 0))
    : Math.max(1, toInteger(cleanupSummary.failedArtifacts, 0));
  const failedResidualSpaceItemCount = Math.max(
    0,
    toInteger(cleanupSummary.failedResidualSpaceItems, 0),
  );
  const failedScannerProbeCleanupCount = Math.max(
    0,
    toInteger(cleanupSummary.failedScannerProbeCleanup, 0),
  );
  const failureCount =
    failedArtifactCount +
    failedResidualSpaceItemCount +
    failedScannerProbeCleanupCount;
  stageResults[
    ABYSSAL_TERMINAL_ARTIFACT_CLEANUP_STAGE.VERIFY_RESULT
  ] = {
    success: artifactResult.success === true && failureCount === 0,
    failedArtifactCount,
    failedResidualSpaceItemCount,
    failedScannerProbeCleanupCount,
    failedItemIDs: listUniquePositiveIntegers(cleanupSummary.failedItemIDs),
  };

  if (artifactResult.success === true && failureCount === 0) {
    const alreadyClean = artifactResult.alreadyClean === true;
    return buildResult(identity, {
      success: true,
      alreadyClean,
      status: alreadyClean
        ? ABYSSAL_TERMINAL_ARTIFACT_CLEANUP_STATUS.ALREADY_CLEAN
        : ABYSSAL_TERMINAL_ARTIFACT_CLEANUP_STATUS.CLEANUP_COMPLETE,
      stage: ABYSSAL_TERMINAL_ARTIFACT_CLEANUP_STAGE.COMPLETE,
      artifactResult,
      cleanupSummary,
      stageResults,
    });
  }
  return persistPendingCleanup(dependencies, {
    ...attempt,
    artifactResult,
    cleanupSummary,
    failedArtifactCount,
    failedResidualSpaceItemCount,
    failedScannerProbeCleanupCount,
  });
}

function persistPendingCleanup(dependencies, attempt) {
  const {
    identity,
    nowMs,
    terminalCleanupState,
    baseRequest,
    stageResults,
    revalidation,
    artifactResult,
    cleanupSummary,
    failedArtifactCount,
    failedResidualSpaceItemCount,
    failedScannerProbeCleanupCount,
  } = attempt;
  const pendingCleanupState = Object.freeze({
    ...terminalCleanupState,
    status: "pending",
    lastFailedAtMs: nowMs,
    failedArtifactCount,
    failedResidualSpaceItemCount,
    failedScannerProbeCleanupCount,
    failedItemIDs: listUniquePositiveIntegers(cleanupSummary.failedItemIDs),
  });
  const persistenceResult = invoke(
    dependencies,
    "persistCleanupPending",
    ABYSSAL_TERMINAL_ARTIFACT_CLEANUP_STAGE.PERSIST_PENDING,
    {
      ...baseRequest,
      authority: revalidation,
      artifactResult,
      cleanupSummary,
      pendingCleanupState,
    },
  );
  stageResults[
    ABYSSAL_TERMINAL_ARTIFACT_CLEANUP_STAGE.PERSIST_PENDING
  ] = persistenceResult;
  const persisted = persistenceResult.success === true;
  return buildResult(identity, {
    pending: true,
    status: persisted
      ? ABYSSAL_TERMINAL_ARTIFACT_CLEANUP_STATUS.CLEANUP_PENDING
      : ABYSSAL_TERMINAL_ARTIFACT_CLEANUP_STATUS.PERSIST_FAILED,
    stage: ABYSSAL_TERMINAL_ARTIFACT_CLEANUP_STAGE.PERSIST_PENDING,
    artifactResult,
    cleanupSummary,
    failedArtifactCount,
    failedResidualSpaceItemCount,
    failedScannerProbeCleanupCount,
    pendingCleanupState,
    persistenceResult,
    stageResults,
    errorMsg: persisted
      ? "ABYSSAL_ARTIFACT_CLEANUP_PENDING"
      : "ABYSSAL_CLEANUP_PENDING_PERSIST_FAILED",
  });
}

function createAbyssalTerminalArtifactCleanupCoordinator(dependencies = {}) {
  const {
    revalidateCleanupAuthority,
    reconcileOwnedArtifacts,
    persistCleanupPending,
  } = dependencies;
  if (typeof revalidateCleanupAuthority !== "function") {
    throw new TypeError("revalidateCleanupAuthority dependency is required");
  }
  if (typeof reconcileOwnedArtifacts !== "function") {
    throw new TypeError("reconcileOwnedArtifacts dependency is required");
  }
  if (typeof persistCleanupPending !== "function") {
    throw new TypeError("persistCleanupPending dependency is required");
  }
  return Object.freeze({ executeCleanup: executeCleanup.bind(null, dependencies) });
}

module.exports = {
  ABYSSAL_TERMINAL_ARTIFACT_CLEANUP_STAGE,
  ABYSSAL_TERMINAL_ARTIFACT_CLEANUP_STATUS,
  createAbyssalTerminalArtifactCleanupCoordinator,
};
