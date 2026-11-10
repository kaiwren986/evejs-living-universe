"use strict";

const { normalizeText } = require("../domain/abyssalValueUtils");

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

// Stale-system cleanup preserves recoverable traces and active-run artifacts.
// Physical removal outcomes are reported separately from completing the scan.
function cleanupForcedStaleAbyssalTrace({
  readTraceStateFromItem,
  getActivePocketStateByInstanceID,
  normalizeAbyssalTraceLifecyclePhase,
  resolveAbyssalTraceProfile,
  isAbyssalSuspectReturnPending,
  isAbyssalReturnProtectionPending,
  ABYSSAL_TRACE_LIFECYCLE_PHASE,
  registerTrace,
  ensureSourceTraceRuntime,
  scheduleSourceTraceRemoval,
  clearPendingAbyssalTraceActivation,
  clearCreatedAbyssalTraceExpirySchedule,
  destroyPlaceholderTrace,
  invalidateFailedAbyssalDeploymentTrace,
  unregisterTrace,
  log,
}, context, item, artifact, numericItemID) {
  const { numericSystemID, deps, reason, removedItemIDs, removedByRole, failedItemIDs } = context;
  const forcedTraceState = readTraceStateFromItem(item);
  const forcedRunID = toInt(forcedTraceState && forcedTraceState.abyssalRunID, 0);
  if (forcedRunID > 0 && getActivePocketStateByInstanceID(forcedRunID)) {
    // A failed ship move retains the run for a later safe retry. Keep its
    // Trace as well so startup cleanup cannot strand the participant.
    return;
  }
  const forcedTracePhase = normalizeAbyssalTraceLifecyclePhase(
    forcedTraceState && forcedTraceState.lifecyclePhase,
  );
  const forcedTraceProfile = resolveAbyssalTraceProfile(forcedTraceState);
  const forcedSuspectReturnPending = isAbyssalSuspectReturnPending(
    forcedTraceState,
  );
  const forcedReturnProtectionPending = isAbyssalReturnProtectionPending(
    forcedTraceState,
    null,
    deps,
  );
  if (
    forcedTracePhase === ABYSSAL_TRACE_LIFECYCLE_PHASE.RETURNED &&
    (
      forcedTraceProfile ||
      forcedSuspectReturnPending ||
      forcedReturnProtectionPending
    )
  ) {
    registerTrace(forcedTraceState);
    ensureSourceTraceRuntime(forcedTraceState, deps);
    if (forcedTraceProfile && !forcedSuspectReturnPending) {
      scheduleSourceTraceRemoval(
        forcedTraceState,
        deps,
        "recovered-returned-trace-expiry",
      );
    }
    return;
  }
  clearPendingAbyssalTraceActivation(numericItemID, deps);
  clearCreatedAbyssalTraceExpirySchedule(numericItemID, deps);
  let destroyResult = destroyPlaceholderTrace(
    numericSystemID,
    numericItemID,
    deps,
    reason,
  );
  if (
    normalizeAbyssalTraceLifecyclePhase(
      forcedTraceState && forcedTraceState.lifecyclePhase,
    ) === ABYSSAL_TRACE_LIFECYCLE_PHASE.CREATED &&
    (!destroyResult || destroyResult.success !== true)
  ) {
    const invalidationResult = invalidateFailedAbyssalDeploymentTrace(
      forcedTraceState,
      deps,
      reason,
    );
    destroyResult = invalidationResult && invalidationResult.traceRemovalResult ||
      destroyResult;
  }
  unregisterTrace(numericItemID);
  if (destroyResult && (destroyResult.removed === true || destroyResult.alreadyGone === true)) {
    if (destroyResult.removed === true) {
      removedItemIDs.push(numericItemID);
      removedByRole[artifact.role] = toInt(removedByRole[artifact.role], 0) + 1;
    }
  } else if (destroyResult && destroyResult.failed === true) {
    failedItemIDs.push(numericItemID);
  }
  log.info(
    `[AbyssalStartup] source Trace cleared trace=${numericItemID} ` +
      `reason=${reason} removed=${Boolean(
        destroyResult && (destroyResult.removed === true || destroyResult.alreadyGone === true)
      )}`,
  );
  return;
}

function reconcileStaleAbyssalTrace({
  readTraceStateFromItem,
  resolveAbyssalTraceProfile,
  normalizeAbyssalTraceLifecyclePhase,
  isAbyssalSuspectReturnPending,
  ABYSSAL_TRACE_LIFECYCLE_PHASE,
  canRecoverCreatedAbyssalTraceAfterRestart,
  expireCreatedAbyssalTrace,
  destroyPlaceholderTrace,
  log,
  buildPocketSiteKey,
  abyssalTraceStateRegistry,
  getActiveTraceState,
  isAbyssalReturnProtectionPending,
  registerTrace,
  ensureSourceTraceRuntime,
  scheduleCreatedAbyssalTraceExpiry,
  scheduleSourceTraceRemoval,
}, context, item, artifact, numericItemID) {
  const { numericSystemID, deps, reason, removedItemIDs, removedByRole, failedItemIDs, cleanupNowMs } = context;
  const traceState = readTraceStateFromItem(item);
  const capturedTraceProfile = resolveAbyssalTraceProfile(traceState);
  const tracePhase = normalizeAbyssalTraceLifecyclePhase(traceState && traceState.lifecyclePhase);
  const pendingSuspectReturn = isAbyssalSuspectReturnPending(traceState);
  const unexpiredCreatedTrace = Boolean(
    traceState &&
    tracePhase === ABYSSAL_TRACE_LIFECYCLE_PHASE.CREATED &&
    toInt(traceState.expiresAtMs, toInt(item && item.expiresAtMs, 0)) > cleanupNowMs
  );
  const recoverableCreatedTrace = Boolean(
    unexpiredCreatedTrace &&
    canRecoverCreatedAbyssalTraceAfterRestart(traceState)
  );
  if (
    tracePhase === ABYSSAL_TRACE_LIFECYCLE_PHASE.REMOVED ||
    (
      tracePhase === ABYSSAL_TRACE_LIFECYCLE_PHASE.CREATED &&
      !recoverableCreatedTrace
    )
  ) {
    const expiredCreatedTrace = Boolean(
      traceState &&
      tracePhase === ABYSSAL_TRACE_LIFECYCLE_PHASE.CREATED &&
      !unexpiredCreatedTrace
    );
    const removalReason = tracePhase === ABYSSAL_TRACE_LIFECYCLE_PHASE.REMOVED
      ? "removed-trace-tombstone-cleanup"
      : unexpiredCreatedTrace
        ? "uncommitted-created-trace-startup-cleanup"
        : "expired-created-trace-startup-cleanup";
    const expirationResult = expiredCreatedTrace
      ? expireCreatedAbyssalTrace(traceState, deps, removalReason)
      : null;
    const destroyResult = expirationResult
      ? expirationResult.traceRemovalResult
      : destroyPlaceholderTrace(
          numericSystemID,
          numericItemID,
          deps,
          removalReason,
        );
    if (destroyResult && destroyResult.removed === true) {
      removedItemIDs.push(numericItemID);
      removedByRole[artifact.role] = toInt(removedByRole[artifact.role], 0) + 1;
    } else if (destroyResult && destroyResult.failed === true) {
      failedItemIDs.push(numericItemID);
    }
    log.warn(
      `[AbyssalStartup] source Trace rejected trace=${numericItemID} ` +
        `phase=${tracePhase} recoverable=${recoverableCreatedTrace} ` +
        `reason=${removalReason} removed=${Boolean(
          destroyResult && (destroyResult.removed === true || destroyResult.alreadyGone === true)
        )} invalidated=${Boolean(expirationResult && expirationResult.success)}`,
    );
    return true;
  }
  const matchingPersistedRun = capturedTraceProfile && traceState && toInt(traceState.abyssalRunID, 0) > 0 &&
    deps.dungeonRuntime && typeof deps.dungeonRuntime.findInstanceBySiteKey === "function"
      ? deps.dungeonRuntime.findInstanceBySiteKey(buildPocketSiteKey(traceState), {
          activeOnly: true,
          full: true,
        })
      : null;
  if (
    (
      abyssalTraceStateRegistry.hasTrace(numericItemID) &&
      getActiveTraceState(numericItemID, deps)
    ) ||
    (
      (
        capturedTraceProfile ||
        pendingSuspectReturn ||
        isAbyssalReturnProtectionPending(traceState, null, deps)
      ) &&
      tracePhase === ABYSSAL_TRACE_LIFECYCLE_PHASE.RETURNED
    ) ||
    recoverableCreatedTrace ||
    matchingPersistedRun
  ) {
    if (traceState) {
      registerTrace(traceState);
      ensureSourceTraceRuntime(traceState, deps);
      if (recoverableCreatedTrace) {
        scheduleCreatedAbyssalTraceExpiry(
          traceState,
          deps,
          "recovered-created-trace-expired",
        );
      }
      if (
        capturedTraceProfile &&
        !pendingSuspectReturn &&
        tracePhase === ABYSSAL_TRACE_LIFECYCLE_PHASE.RETURNED
      ) {
        scheduleSourceTraceRemoval(traceState, deps);
      }
    }
    return true;
  }
  return false;
}

function cleanupStaleAbyssalInventory({
  inspectAbyssalTaggedSpaceItem,
  cleanupForcedStaleAbyssalTrace,
  reconcileStaleAbyssalTrace,
  getActivePocketStateByInstanceID,
  destroyPlaceholderTrace,
}, context, spaceItems) {
  const { numericSystemID, deps, reason, removedItemIDs, removedByRole, failedItemIDs, forceRemoveLiveAbyssals, unknownTaggedArtifacts } = context;
  for (const item of spaceItems) {
    const artifact = inspectAbyssalTaggedSpaceItem(item);
    if (!artifact) {
      continue;
    }
    if (artifact.role === "unknownTaggedArtifact") {
      unknownTaggedArtifacts.push(artifact.itemID);
      continue;
    }
    const numericItemID = toInt(item && item.itemID, 0);
    if (numericItemID <= 0) {
      continue;
    }

    if (artifact.role === "entranceTrace") {
      if (forceRemoveLiveAbyssals) {
        cleanupForcedStaleAbyssalTrace(context, item, artifact, numericItemID);
        continue;
      }
      if (reconcileStaleAbyssalTrace(context, item, artifact, numericItemID)) {
        continue;
      }
    } else if (toInt(artifact.activeKey, 0) > 0) {
      const activePocketState = getActivePocketStateByInstanceID(toInt(artifact.activeKey, 0));
      if (activePocketState) {
        continue;
      }
    }

    const destroyResult = destroyPlaceholderTrace(numericSystemID, numericItemID, deps, reason);
    if (destroyResult && destroyResult.removed === true) {
      removedItemIDs.push(numericItemID);
      removedByRole[artifact.role] = toInt(removedByRole[artifact.role], 0) + 1;
    } else if (destroyResult && destroyResult.failed === true) {
      failedItemIDs.push(numericItemID);
    }
  }
}

function cleanupStaleAbyssalScenery({
  isAbyssalEnvironmentVisualEntity,
  getActivePocketStateByInstanceID,
  destroyAbyssalSceneryVisualEntity,
}, context) {
  const { numericSystemID, deps, reason, removedItemIDs, removedByRole, failedItemIDs } = context;
  const runtime = deps;
  const scene =
    runtime && typeof runtime.ensureScene === "function"
      ? runtime.ensureScene(numericSystemID)
      : null;
  const staticEntities = Array.isArray(scene && scene.staticEntities) ? scene.staticEntities : [];
  for (const entity of staticEntities) {
    if (!isAbyssalEnvironmentVisualEntity(entity)) {
      continue;
    }
    const entityID = toInt(entity && entity.itemID, 0);
    if (entityID <= 0) {
      continue;
    }
    const activePocketState = getActivePocketStateByInstanceID(
      toInt(entity && entity.evejsAbyssalInstanceID, 0),
    );
    if (activePocketState) {
      continue;
    }
    const removeResult = destroyAbyssalSceneryVisualEntity(
      numericSystemID,
      entityID,
      deps,
      reason,
    );
    if (removeResult && removeResult.removed === true) {
      removedItemIDs.push(entityID);
      removedByRole.sceneryVisual = toInt(removedByRole.sceneryVisual, 0) + 1;
    } else if (removeResult && removeResult.failed === true) {
      failedItemIDs.push(entityID);
    }
  }
}

function reportStaleAbyssalCleanup({
  log,
  rememberAbyssalCleanupReport,
}, context) {
  const { numericSystemID, reason, removedItemIDs, removedByRole, unknownTaggedArtifacts, failedItemIDs } = context;
  if (removedItemIDs.length > 0) {
    log.info(
      `[AbyssalMgr] Stale Abyssal run cleanup system=${numericSystemID} reason=${reason} removed=${removedItemIDs.length} ` +
        `traces=${toInt(removedByRole.entranceTrace, 0)} markers=${toInt(removedByRole.originMarker, 0)} ` +
        `conduits=${toInt(removedByRole.conduitOrExitMarker, 0)} rewardCaches=${toInt(removedByRole.rewardCache, 0)} ` +
        `extractionNodes=${toInt(removedByRole.extractionNode, 0)} ` +
        `environmentalObjects=${toInt(removedByRole.environmentalObject, 0)} ` +
        `sceneryVisuals=${toInt(removedByRole.sceneryVisual, 0)} itemIDs=${removedItemIDs.join(",")}`,
    );
    log.info(
      `[AbyssalMgr] Abyssal run outcome char=0 instance=0 trace=0 state=cleaned_stale objectiveComplete=false timerExpired=false reason=${reason}`,
    );
  }
  rememberAbyssalCleanupReport({
    reason: normalizeText(reason, "stale-cleanup"),
    scope: "stale-system",
    systemID: numericSystemID,
    removedItemIDs,
    removedByRole,
    unknownTaggedArtifacts,
    failedItemIDs,
    cleanupFailedCount: failedItemIDs.length,
    artifactRemovalAttemptsAlreadyGoneCount: 0,
    alreadyGoneCount: 0,
    alreadyGoneCountScope: "artifact-removal-attempts",
    staleArtifactCount: removedItemIDs.length + unknownTaggedArtifacts.length,
  });
}

function cleanupStalePlaceholderArtifactsInSystem({
  cleanupStaleAbyssalInventory,
  cleanupStaleAbyssalScenery,
  reportStaleAbyssalCleanup,
  abyssalMaintenanceState,
},
  systemID,
  deps,
  reason = "stale-cleanup",
  options = {},
) {
  const numericSystemID = toInt(systemID, 0);
  if (numericSystemID <= 0 || typeof deps.listSystemSpaceItems !== "function") {
    return {
      success: true,
      removedItemIDs: [],
      scannedCount: 0,
      report: {
        removedItemIDs: [],
        removedByRole: {},
        unknownTaggedArtifacts: [],
        failedItemIDs: [],
      },
    };
  }

  const spaceItems = Array.isArray(deps.listSystemSpaceItems(numericSystemID))
    ? deps.listSystemSpaceItems(numericSystemID)
    : [];
  const removedItemIDs = [];
  const removedByRole = {};
  const unknownTaggedArtifacts = [];
  const failedItemIDs = [];
  const cleanupNowMs = toInt(
    deps && typeof deps.now === "function" ? deps.now() : Date.now(),
    Date.now(),
  );
  const forceRemoveLiveAbyssals = options.forceRemoveLiveAbyssals === true;
  const context = {
    numericSystemID, deps, reason, removedItemIDs, removedByRole, unknownTaggedArtifacts,
    failedItemIDs, cleanupNowMs, forceRemoveLiveAbyssals,
  };
  cleanupStaleAbyssalInventory(context, spaceItems);
  cleanupStaleAbyssalScenery(context);
  reportStaleAbyssalCleanup(context);

  return {
    success: true,
    removedItemIDs,
    scannedCount: spaceItems.length,
    report: abyssalMaintenanceState.getLastCleanupReport(),
  };
}

// Capture supplied capabilities once, as the original closure did. Internal
// callbacks are bound once per instance; no runtime state lives in this wiring.
function createAbyssalStaleCleanup({
  inspectAbyssalTaggedSpaceItem,
  readTraceStateFromItem,
  getActivePocketStateByInstanceID,
  normalizeAbyssalTraceLifecyclePhase,
  resolveAbyssalTraceProfile,
  isAbyssalSuspectReturnPending,
  isAbyssalReturnProtectionPending,
  ABYSSAL_TRACE_LIFECYCLE_PHASE,
  registerTrace,
  ensureSourceTraceRuntime,
  scheduleSourceTraceRemoval,
  clearPendingAbyssalTraceActivation,
  clearCreatedAbyssalTraceExpirySchedule,
  destroyPlaceholderTrace,
  invalidateFailedAbyssalDeploymentTrace,
  unregisterTrace,
  log,
  canRecoverCreatedAbyssalTraceAfterRestart,
  expireCreatedAbyssalTrace,
  buildPocketSiteKey,
  abyssalTraceStateRegistry,
  getActiveTraceState,
  scheduleCreatedAbyssalTraceExpiry,
  isAbyssalEnvironmentVisualEntity,
  destroyAbyssalSceneryVisualEntity,
  rememberAbyssalCleanupReport,
  abyssalMaintenanceState,
}) {

  const ports = {
    inspectAbyssalTaggedSpaceItem,
    readTraceStateFromItem,
    getActivePocketStateByInstanceID,
    normalizeAbyssalTraceLifecyclePhase,
    resolveAbyssalTraceProfile,
    isAbyssalSuspectReturnPending,
    isAbyssalReturnProtectionPending,
    ABYSSAL_TRACE_LIFECYCLE_PHASE,
    registerTrace,
    ensureSourceTraceRuntime,
    scheduleSourceTraceRemoval,
    clearPendingAbyssalTraceActivation,
    clearCreatedAbyssalTraceExpirySchedule,
    destroyPlaceholderTrace,
    invalidateFailedAbyssalDeploymentTrace,
    unregisterTrace,
    log,
    canRecoverCreatedAbyssalTraceAfterRestart,
    expireCreatedAbyssalTrace,
    buildPocketSiteKey,
    abyssalTraceStateRegistry,
    getActiveTraceState,
    scheduleCreatedAbyssalTraceExpiry,
    isAbyssalEnvironmentVisualEntity,
    destroyAbyssalSceneryVisualEntity,
    rememberAbyssalCleanupReport,
    abyssalMaintenanceState,
  };
  ports.cleanupForcedStaleAbyssalTrace = cleanupForcedStaleAbyssalTrace.bind(null, ports);
  ports.reconcileStaleAbyssalTrace = reconcileStaleAbyssalTrace.bind(null, ports);
  ports.cleanupStaleAbyssalInventory = cleanupStaleAbyssalInventory.bind(null, ports);
  ports.cleanupStaleAbyssalScenery = cleanupStaleAbyssalScenery.bind(null, ports);
  ports.reportStaleAbyssalCleanup = reportStaleAbyssalCleanup.bind(null, ports);
  ports.cleanupStalePlaceholderArtifactsInSystem = cleanupStalePlaceholderArtifactsInSystem.bind(null, ports);
  Object.freeze(ports);
  return { cleanupStalePlaceholderArtifactsInSystem: ports.cleanupStalePlaceholderArtifactsInSystem };
}

module.exports = { createAbyssalStaleCleanup };
