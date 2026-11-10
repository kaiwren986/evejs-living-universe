"use strict";

const ABYSSAL_TRACE_RETIREMENT_FAMILY = Object.freeze({
  RETURNED_SOURCE_TRACE: "returned_source_trace",
});

const ABYSSAL_TRACE_RETIREMENT_STAGE = Object.freeze({
  REVALIDATE: "revalidate_trace",
  CHECK_EXPIRY: "check_expiry",
  CHECK_PENDING_OBLIGATIONS: "check_pending_obligations",
  REMOVE_REPRESENTATION: "remove_trace_representation",
  FINALIZE: "finalize_trace_retirement",
  COMPLETE: "complete",
});

const ABYSSAL_TRACE_RETIREMENT_STATUS = Object.freeze({
  RETIRED: "retired",
  ALREADY_RETIRED: "already_retired",
  DEFERRED: "deferred",
  REJECTED: "rejected",
  FAILED: "failed",
  FORWARD_CONVERGENCE_REQUIRED: "forward_convergence_required",
});

function toInteger(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function normalizeText(value, fallback = "") {
  const normalized = String(value == null ? "" : value).trim();
  return normalized || fallback;
}

function buildIdentity(request = {}) {
  return Object.freeze({
    traceItemID: toInteger(request.traceItemID, 0),
    instanceID: toInteger(
      request.instanceID,
      toInteger(request.abyssalRunID, 0),
    ),
    characterID: toInteger(request.characterID, 0),
    sourceSolarSystemID: toInteger(request.sourceSolarSystemID, 0),
  });
}

function identityMatches(expected, actual) {
  return Boolean(
    actual &&
    expected.traceItemID === toInteger(actual.traceItemID, 0) &&
    expected.instanceID === toInteger(
      actual.instanceID,
      toInteger(actual.abyssalRunID, 0),
    ) &&
    expected.characterID === toInteger(actual.characterID, 0) &&
    expected.sourceSolarSystemID === toInteger(actual.sourceSolarSystemID, 0)
  );
}

function normalizeStageResult(result, fallbackErrorMsg) {
  if (!result || typeof result !== "object") {
    return { success: false, errorMsg: fallbackErrorMsg };
  }
  return {
    ...result,
    success: result.success === true,
    errorMsg: normalizeText(
      result.errorMsg,
      result.success === true ? "" : fallbackErrorMsg,
    ),
  };
}

function buildResult(identity, patch = {}) {
  return {
    success: false,
    status: ABYSSAL_TRACE_RETIREMENT_STATUS.FAILED,
    stage: ABYSSAL_TRACE_RETIREMENT_STAGE.REVALIDATE,
    identity,
    eligible: false,
    expired: false,
    deferred: false,
    pendingReturnProtection: false,
    pendingSuspectReturn: false,
    physicallyAbsent: false,
    physicalRemovalCommitted: false,
    finalized: false,
    forwardConvergenceRequired: false,
    stageResults: {},
    errorMsg: "",
    ...patch,
  };
}

function buildStageRequest(attempt, stage, facts = null, extra = {}) {
  const { request, traceFamily, identity, nowMs, stageResults } = attempt;
  return Object.freeze({
    stage,
    traceFamily,
    identity,
    traceItemID: identity.traceItemID,
    instanceID: identity.instanceID,
    characterID: identity.characterID,
    sourceSolarSystemID: identity.sourceSolarSystemID,
    nowMs,
    reason: normalizeText(request.reason, "post-return-expiry"),
    facts,
    stageResults: Object.freeze({ ...stageResults }),
    ...extra,
  });
}

function invoke(dependencies, attempt, dependencyName, stage, facts = null, extra = {}) {
  try {
    return normalizeStageResult(
      dependencies[dependencyName](buildStageRequest(attempt, stage, facts, extra)),
      `ABYSSAL_TRACE_RETIREMENT_${stage.toUpperCase()}_FAILED`,
    );
  } catch (error) {
    return {
      success: false,
      errorMsg: normalizeText(
        error && error.message,
        `ABYSSAL_TRACE_RETIREMENT_${stage.toUpperCase()}_THREW`,
      ),
      thrownError: error,
    };
  }
}

function executeRetirement(dependencies, request = {}) {
  const identity = buildIdentity(request);
  const traceFamily = normalizeText(
    request.traceFamily,
    ABYSSAL_TRACE_RETIREMENT_FAMILY.RETURNED_SOURCE_TRACE,
  );
  const nowMs = Number(request.nowMs);
  if (
    traceFamily !== ABYSSAL_TRACE_RETIREMENT_FAMILY.RETURNED_SOURCE_TRACE ||
    identity.traceItemID <= 0 ||
    identity.instanceID <= 0 ||
    identity.characterID <= 0 ||
    identity.sourceSolarSystemID <= 0 ||
    !Number.isFinite(nowMs)
  ) {
    return buildResult(identity, {
      status: ABYSSAL_TRACE_RETIREMENT_STATUS.REJECTED,
      errorMsg: traceFamily !==
        ABYSSAL_TRACE_RETIREMENT_FAMILY.RETURNED_SOURCE_TRACE
        ? "ABYSSAL_TRACE_RETIREMENT_FAMILY_OUT_OF_SCOPE"
        : "ABYSSAL_TRACE_RETIREMENT_REQUEST_INVALID",
    });
  }

  const stageResults = {};
  const attempt = { request, traceFamily, identity, nowMs, stageResults };
  const revalidation = invoke(dependencies, attempt,
    "revalidateTraceRetirement",
    ABYSSAL_TRACE_RETIREMENT_STAGE.REVALIDATE,
  );
  stageResults[ABYSSAL_TRACE_RETIREMENT_STAGE.REVALIDATE] = revalidation;
  if (!revalidation.success || !identityMatches(identity, revalidation.identity)) {
    return buildResult(identity, {
      stageResults,
      errorMsg: revalidation.success
        ? "ABYSSAL_TRACE_RETIREMENT_REVALIDATION_IDENTITY_MISMATCH"
        : revalidation.errorMsg,
    });
  }

  const physicallyAbsent = Boolean(
    revalidation.physicallyAbsent === true ||
    revalidation.alreadyRemoved === true,
  );
  if (physicallyAbsent && revalidation.retirementFinalized === true) {
    return buildResult(identity, {
      success: true,
      status: ABYSSAL_TRACE_RETIREMENT_STATUS.ALREADY_RETIRED,
      stage: ABYSSAL_TRACE_RETIREMENT_STAGE.COMPLETE,
      eligible: true,
      expired: true,
      physicallyAbsent: true,
      physicalRemovalCommitted: true,
      finalized: true,
      stageResults,
    });
  }

  const lifecyclePhase = normalizeText(revalidation.lifecyclePhase).toLowerCase();
  const removalDeadlineMs = toInteger(revalidation.removalDeadlineMs, 0);
  if (!physicallyAbsent && lifecyclePhase !== "returned") {
    return buildResult(identity, {
      status: ABYSSAL_TRACE_RETIREMENT_STATUS.REJECTED,
      stageResults,
      errorMsg: "ABYSSAL_TRACE_RETIREMENT_TRACE_NOT_RETURNED",
    });
  }
  if (!physicallyAbsent && removalDeadlineMs <= 0) {
    return buildResult(identity, {
      status: ABYSSAL_TRACE_RETIREMENT_STATUS.REJECTED,
      stageResults,
      errorMsg: "ABYSSAL_TRACE_RETIREMENT_DEADLINE_MISSING",
    });
  }

  if (!physicallyAbsent) {
    const expired = nowMs >= removalDeadlineMs;
    stageResults[ABYSSAL_TRACE_RETIREMENT_STAGE.CHECK_EXPIRY] = {
      success: true,
      expired,
      nowMs,
      removalDeadlineMs,
    };
    if (!expired) {
      return buildResult(identity, {
        success: true,
        status: ABYSSAL_TRACE_RETIREMENT_STATUS.DEFERRED,
        stage: ABYSSAL_TRACE_RETIREMENT_STAGE.CHECK_EXPIRY,
        deferred: true,
        removalDeadlineMs,
        retryAtMs: removalDeadlineMs,
        stageResults,
      });
    }

    const pendingReturnProtection = revalidation.pendingReturnProtection === true;
    const pendingSuspectReturn = revalidation.pendingSuspectReturn === true;
    stageResults[ABYSSAL_TRACE_RETIREMENT_STAGE.CHECK_PENDING_OBLIGATIONS] = {
      success: true,
      pendingReturnProtection,
      pendingSuspectReturn,
    };
    if (pendingReturnProtection || pendingSuspectReturn) {
      return buildResult(identity, {
        success: true,
        status: ABYSSAL_TRACE_RETIREMENT_STATUS.DEFERRED,
        stage: ABYSSAL_TRACE_RETIREMENT_STAGE.CHECK_PENDING_OBLIGATIONS,
        eligible: true,
        expired: true,
        deferred: true,
        pendingReturnProtection,
        pendingSuspectReturn,
        removalDeadlineMs,
        retryAtMs: toInteger(revalidation.pendingObligationDeadlineMs, 0),
        stageResults,
      });
    }
  }
  return finishRetirement(dependencies, attempt, revalidation, physicallyAbsent, removalDeadlineMs);
}

function finishRetirement(dependencies, attempt, revalidation, physicallyAbsent, removalDeadlineMs) {
  const { identity, stageResults } = attempt;
  let physicalRemovalCommitted = physicallyAbsent;
  let removalResult = null;
  if (!physicallyAbsent) {
    removalResult = invoke(dependencies, attempt,
      "removeTraceRepresentation",
      ABYSSAL_TRACE_RETIREMENT_STAGE.REMOVE_REPRESENTATION,
      revalidation,
    );
    stageResults[ABYSSAL_TRACE_RETIREMENT_STAGE.REMOVE_REPRESENTATION] =
      removalResult;
    physicalRemovalCommitted = Boolean(
      removalResult.removed === true ||
      removalResult.alreadyGone === true ||
      removalResult.physicalRemovalCommitted === true,
    );
    if (!removalResult.success) {
      return buildResult(identity, {
        status: physicalRemovalCommitted
          ? ABYSSAL_TRACE_RETIREMENT_STATUS.FORWARD_CONVERGENCE_REQUIRED
          : ABYSSAL_TRACE_RETIREMENT_STATUS.FAILED,
        stage: ABYSSAL_TRACE_RETIREMENT_STAGE.REMOVE_REPRESENTATION,
        eligible: true,
        expired: true,
        physicallyAbsent: physicalRemovalCommitted,
        physicalRemovalCommitted,
        forwardConvergenceRequired: physicalRemovalCommitted,
        removalDeadlineMs,
        removalResult,
        stageResults,
        errorMsg: removalResult.errorMsg,
      });
    }
    if (!physicalRemovalCommitted) {
      return buildResult(identity, {
        stage: ABYSSAL_TRACE_RETIREMENT_STAGE.REMOVE_REPRESENTATION,
        eligible: true,
        expired: true,
        removalDeadlineMs,
        removalResult,
        stageResults,
        errorMsg: "ABYSSAL_TRACE_RETIREMENT_REMOVAL_NOT_VERIFIED",
      });
    }
  }

  const finalization = invoke(dependencies, attempt,
    "finalizeTraceRetirement",
    ABYSSAL_TRACE_RETIREMENT_STAGE.FINALIZE,
    revalidation,
    {
      physicallyAbsent: true,
      physicalRemovalCommitted: true,
      removalResult,
    },
  );
  stageResults[ABYSSAL_TRACE_RETIREMENT_STAGE.FINALIZE] = finalization;
  if (!finalization.success) {
    return buildResult(identity, {
      status: ABYSSAL_TRACE_RETIREMENT_STATUS.FORWARD_CONVERGENCE_REQUIRED,
      stage: ABYSSAL_TRACE_RETIREMENT_STAGE.FINALIZE,
      eligible: true,
      expired: true,
      physicallyAbsent: true,
      physicalRemovalCommitted: true,
      forwardConvergenceRequired: true,
      removalDeadlineMs,
      removalResult,
      finalizationResult: finalization,
      stageResults,
      errorMsg: finalization.errorMsg,
    });
  }

  return buildResult(identity, {
    success: true,
    status: physicallyAbsent
      ? ABYSSAL_TRACE_RETIREMENT_STATUS.ALREADY_RETIRED
      : ABYSSAL_TRACE_RETIREMENT_STATUS.RETIRED,
    stage: ABYSSAL_TRACE_RETIREMENT_STAGE.COMPLETE,
    eligible: true,
    expired: true,
    physicallyAbsent: true,
    physicalRemovalCommitted: true,
    finalized: true,
    removalDeadlineMs,
    removalResult,
    finalizationResult: finalization,
    stageResults,
  });
}

function createAbyssalTraceRetirementCoordinator(dependencies = {}) {
  for (const dependencyName of [
    "revalidateTraceRetirement",
    "removeTraceRepresentation",
    "finalizeTraceRetirement",
  ]) {
    if (typeof dependencies[dependencyName] !== "function") {
      throw new TypeError(`${dependencyName} dependency is required`);
    }
  }
  return Object.freeze({
    executeRetirement: executeRetirement.bind(null, dependencies),
  });
}

module.exports = {
  ABYSSAL_TRACE_RETIREMENT_FAMILY,
  ABYSSAL_TRACE_RETIREMENT_STAGE,
  ABYSSAL_TRACE_RETIREMENT_STATUS,
  createAbyssalTraceRetirementCoordinator,
};
