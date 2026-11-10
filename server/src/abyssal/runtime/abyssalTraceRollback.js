"use strict";

const { normalizeText } = require("../domain/abyssalValueUtils");

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

// Compensation and evacuation must be durable before any trace is invalidated.
function rollbackPendingAbyssalTraceActivation(ports, record, deps = ports.getDependencies(), reason = "activation-failed") {
  if (!record) return { success: true, skipped: true };
  const work = { record, deps, reason };
  for (const settle of [
    stageRollbackCompensation,
    settleRollbackEvacuation,
    inspectRollbackTraceRetention,
    reconcileRollbackTrace,
  ]) {
    const blocked = settle(ports, work);
    if (blocked) return blocked;
  }
  return settleRollbackCompensation(ports, work);
}

function stageRollbackCompensation(ports, work) {
  const {
    getActiveTraceState,
    stageAbyssalFilamentCompensationClaim,
    log,
  } = ports;
  const { record, deps, reason } = work;
  const traceState =
    getActiveTraceState(toInt(record.traceItemID, 0), deps) ||
    record.traceState ||
    null;
  const normalizedReason = normalizeText(reason, "activation-failed");
  const compensationStageResult = stageAbyssalFilamentCompensationClaim(
    traceState,
    deps,
    normalizedReason,
  );
  if (!compensationStageResult || compensationStageResult.success !== true) {
    log.error(
      `[AbyssalTraceActivation] rollback failed closed before destructive cleanup ` +
        `trace=${toInt(record.traceItemID, 0)} reason=${normalizedReason} ` +
        `error=${normalizeText(
          compensationStageResult && compensationStageResult.errorMsg,
          "FILAMENT_COMPENSATION_STAGE_FAILED",
        )}`,
    );
    return {
      success: false,
      preserved: true,
      failClosed: true,
      errorMsg: normalizeText(
        compensationStageResult && compensationStageResult.errorMsg,
        "FILAMENT_COMPENSATION_STAGE_FAILED",
      ),
      compensationStageResult,
    };
  }
  Object.assign(work, { traceState, normalizedReason, compensationStageResult });
  return null;
}

function settleRollbackEvacuation(ports, work) {
  const {
    getRunByTraceID,
    cancelPendingAbyssalTransition,
    persistPendingAbyssalEntryRecovery,
    getActivePocketStateByInstanceID,
    ABYSSAL_ENTRY_RECOVERY_REASON,
    reconcilePendingAbyssalEntryRecovery,
    cloneValue,
    logPendingAbyssalTraceActivation,
  } = ports;
  const { record, deps, normalizedReason, traceState, compensationStageResult } = work;
  const pocketState = getRunByTraceID(
    toInt(record.traceItemID, 0),
  );
  if (pocketState) {
    cancelPendingAbyssalTransition(pocketState.instanceID, deps, normalizedReason);
    const recoveryIntentResult = persistPendingAbyssalEntryRecovery(
      getActivePocketStateByInstanceID(toInt(pocketState.instanceID, 0)) ||
        pocketState,
      {
        reason: ABYSSAL_ENTRY_RECOVERY_REASON.PENDING_EVACUATION,
        activationFailureReason: normalizedReason,
        npcActivationError: normalizedReason,
        compensationRequired: true,
        compensationDurablyStaged: true,
        compensationDeploymentToken: normalizeText(
          traceState && traceState.deploymentToken,
          normalizeText(record.deploymentToken, ""),
        ),
        compensationStageError: "",
        evacuationError: "",
      },
      deps,
    );
    if (!recoveryIntentResult || recoveryIntentResult.success !== true) {
      record.status = "recovery-pending";
      return {
        success: false,
        preserved: true,
        failClosed: true,
        recoveryPending: true,
        errorMsg: normalizeText(
          recoveryIntentResult && recoveryIntentResult.errorMsg,
          "ABYSSAL_ENTRY_RECOVERY_PERSIST_FAILED",
        ),
        recoveryIntentResult,
        compensationStageResult,
      };
    }
    const entryRecoveryResult = reconcilePendingAbyssalEntryRecovery(
      cloneValue(recoveryIntentResult.committedState || recoveryIntentResult.state),
      record.session || null,
      deps,
    );
    const evacuationSettled = Boolean(
      entryRecoveryResult && entryRecoveryResult.settled === true
    );
    if (!evacuationSettled) {
      record.status = "recovery-pending";
      logPendingAbyssalTraceActivation(record, "recovery-pending", {
        automatic: record.automatic === true,
        runID: toInt(pocketState.instanceID, toInt(record.runID, 0)),
        status: "paused",
        reason: normalizeText(
          entryRecoveryResult && entryRecoveryResult.errorMsg,
          "ENTRY_ACTIVATION_ROLLBACK_EVACUATION_FAILED",
        ),
      });
      return {
        success: false,
        preserved: true,
        failClosed: true,
        recoveryPending: true,
        pocketState: getActivePocketStateByInstanceID(
          toInt(pocketState.instanceID, 0),
        ),
        evacuationResult:
          entryRecoveryResult && entryRecoveryResult.evacuationResult,
        entryRecoveryResult,
        recoveryIntentResult,
        compensationStageResult,
      };
    }
  }
  Object.assign(work, { pocketState });
  return null;
}

function inspectRollbackTraceRetention(ports, work) {
  const {
    clearPendingAbyssalTraceActivation,
    normalizeAbyssalTraceLifecyclePhase,
    ABYSSAL_TRACE_LIFECYCLE_PHASE,
  } = ports;
  const { record, deps, normalizedReason, traceState } = work;
  clearPendingAbyssalTraceActivation(record.traceItemID, deps);
  const playerWorldInvalidation = normalizedReason.startsWith(
    "PLAYER_WORLD_INVALIDATION:",
  );
  const nowMs = toInt(deps && deps.now && deps.now(), Date.now());
  const expectedDeploymentToken = normalizeText(
    record.deploymentToken,
    normalizeText(
      record.traceState && record.traceState.deploymentToken,
      "",
    ),
  );
  const currentDeploymentToken = normalizeText(
    traceState && traceState.deploymentToken,
    "",
  );
  const currentLifecyclePhase = normalizeAbyssalTraceLifecyclePhase(
    traceState && traceState.lifecyclePhase,
  );
  const canPreservePublishedTrace = Boolean(
    playerWorldInvalidation &&
    traceState &&
    toInt(traceState.traceItemID, 0) === toInt(record.traceItemID, 0) &&
    toInt(traceState.characterID, 0) === toInt(record.characterID, 0) &&
    toInt(traceState.shipID, 0) === toInt(record.shipID, 0) &&
    (!expectedDeploymentToken || currentDeploymentToken === expectedDeploymentToken) &&
    [
      ABYSSAL_TRACE_LIFECYCLE_PHASE.CREATED,
      ABYSSAL_TRACE_LIFECYCLE_PHASE.ACTIVE,
    ].includes(currentLifecyclePhase) &&
    toInt(traceState.expiresAtMs, 0) > nowMs
  );
  Object.assign(work, { nowMs, canPreservePublishedTrace });
  return null;
}

function reconcileRollbackTrace(ports, work) {
  const {
    cloneValue,
    ABYSSAL_TRACE_LIFECYCLE_PHASE,
    transitionSourceTraceState,
    scheduleCreatedAbyssalTraceExpiry,
    ensureSourceTraceRuntime,
    removeOwnedSourceTrace,
  } = ports;
  const { record, deps, normalizedReason, traceState, nowMs, canPreservePublishedTrace } = work;
  let traceRemovalResult;
  let retryableTraceState = null;
  if (canPreservePublishedTrace) {
    const retryableState = {
      ...cloneValue(traceState),
      abyssalRunID: 0,
      automaticActivation: {
        ...cloneValue(traceState.automaticActivation || {}),
        enabled: false,
        status: "retryable-after-player-invalidation",
        invalidatedAtMs: nowMs,
        invalidationReason: normalizedReason,
      },
    };
    const transitionResult = transitionSourceTraceState(
      retryableState,
      ABYSSAL_TRACE_LIFECYCLE_PHASE.CREATED,
      deps,
      {
        abyssalRunID: 0,
        broadcast: true,
      },
    );
    if (transitionResult && transitionResult.success === true) {
      retryableTraceState = transitionResult.state || retryableState;
      const expiryResult = scheduleCreatedAbyssalTraceExpiry(
        retryableTraceState,
        deps,
        "player-invalidated-entry-trace-expired",
      );
      ensureSourceTraceRuntime(retryableTraceState, deps);
      traceRemovalResult = {
        success: Boolean(expiryResult && expiryResult.success),
        preserved: true,
        retryable: true,
        expiryResult,
        state: cloneValue(retryableTraceState),
      };
    } else {
      traceRemovalResult = traceState
        ? removeOwnedSourceTrace(traceState, deps, normalizedReason)
        : { success: true, alreadyGone: true };
    }
  } else {
    traceRemovalResult = traceState
      ? removeOwnedSourceTrace(traceState, deps, normalizedReason)
      : { success: true, alreadyGone: true };
  }
  Object.assign(work, { traceRemovalResult, retryableTraceState });
  return null;
}

function settleRollbackCompensation(ports, work) {
  const {
    logPendingAbyssalTraceActivation,
    settleAbyssalFilamentCompensationClaim,
    markAbyssalFilamentCompensationTraceInvalidated,
  } = ports;
  const { record, deps, normalizedReason, pocketState, compensationStageResult, traceRemovalResult, retryableTraceState } = work;
  let compensationInvalidationResult = null;
  let filamentCompensationResult = null;
  if (retryableTraceState) {
    filamentCompensationResult = settleAbyssalFilamentCompensationClaim(
      compensationStageResult.claim,
      record.session || null,
      deps,
    );
  } else if (traceRemovalResult && traceRemovalResult.success === true) {
    compensationInvalidationResult = markAbyssalFilamentCompensationTraceInvalidated(
      compensationStageResult.claim,
      traceRemovalResult,
      deps,
    );
    if (
      compensationInvalidationResult &&
      compensationInvalidationResult.success === true
    ) {
      filamentCompensationResult = settleAbyssalFilamentCompensationClaim(
        compensationInvalidationResult.claim,
        record.session || null,
        deps,
      );
    }
  }
  record.status = retryableTraceState ? "retryable" : "failed";
  logPendingAbyssalTraceActivation(record, retryableTraceState ? "retryable" : "failed", {
    automatic: record.automatic === true,
    runID: toInt(pocketState && pocketState.instanceID, toInt(record.runID, 0)),
    status: retryableTraceState ? "paused" : "failed",
    reason: normalizedReason,
  });
  return {
    success: Boolean(traceRemovalResult && traceRemovalResult.success),
    pocketPurged: Boolean(pocketState),
    tracePreserved: Boolean(retryableTraceState),
    retryableTraceState,
    traceRemovalResult,
    compensationStageResult,
    compensationInvalidationResult,
    filamentCompensationResult,
  };
}

function createAbyssalTraceRollback(ports) {
  return {
    rollbackPendingAbyssalTraceActivation: rollbackPendingAbyssalTraceActivation.bind(null, ports),
  };
}

module.exports = { createAbyssalTraceRollback };
