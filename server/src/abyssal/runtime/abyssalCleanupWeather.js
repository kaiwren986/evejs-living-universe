"use strict";

const { normalizeText } = require("../domain/abyssalValueUtils");

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

// Exact-ship claims, persistence and runtime verification remain injected.
// Per-call values coordinate the existing bounded cleanup obligation only.
function buildAbyssalCleanupWeatherContext({
  getAbyssalWeatherRemovalState,
  isExactAbyssalWeatherRemovalClaim,
  normalizeLowerText,
}, input) {
  const { resolvedPocketState, deps, options } = input;
  const cleanupShipID = toInt(resolvedPocketState.shipID, 0);
  const cleanupShipItem = cleanupShipID > 0 && typeof deps.findItemById === "function"
    ? deps.findItemById(cleanupShipID)
    : null;
  const cleanupShipSystemID = toInt(
    cleanupShipItem && cleanupShipItem.spaceState && cleanupShipItem.spaceState.systemID,
    toInt(cleanupShipItem && cleanupShipItem.locationID, 0),
  );
  const cleanupSessionShipID = toInt(
    options.session && options.session._space && options.session._space.shipID,
    toInt(options.session && (options.session.shipID || options.session.shipid), 0),
  );
  const shipIsAtKSpaceReturn = Boolean(
    cleanupShipSystemID > 0 &&
    cleanupShipSystemID === toInt(resolvedPocketState.sourceSolarSystemID, 0)
  );
  const exactShipSessionAvailable = Boolean(
    options.session && cleanupSessionShipID === cleanupShipID
  );
  const existingWeatherRemovalState = getAbyssalWeatherRemovalState(
    resolvedPocketState,
  );
  const hasExactWeatherRemovalObligation = Boolean(
    isExactAbyssalWeatherRemovalClaim(
      resolvedPocketState,
      existingWeatherRemovalState,
    )
  );
  const cleanupRunOutcome = normalizeLowerText(
    resolvedPocketState.runOutcome,
    "",
  );
  const returnCommittedWithoutSession = Boolean(
    shipIsAtKSpaceReturn &&
    (
      cleanupRunOutcome === "exited" ||
      cleanupRunOutcome === "cluster_shutdown_returned" ||
      cleanupRunOutcome === "admin_aborted"
    )
  );
  const weatherRemovalRequired = Boolean(
    cleanupShipID > 0 &&
    cleanupShipItem &&
    (
      exactShipSessionAvailable ||
      hasExactWeatherRemovalObligation ||
      returnCommittedWithoutSession
    )
  );
  let weatherRemovalResult = {
    refreshed: false,
    verified: false,
    skipped: !weatherRemovalRequired,
    reason: weatherRemovalRequired
      ? "PENDING"
      : cleanupShipItem
        ? "NO_EXACT_RETURN_SHIP_SESSION"
        : "SHIP_NO_LONGER_EXISTS",
  };
  return { ...input, cleanupShipID, cleanupRunOutcome, weatherRemovalRequired, weatherRemovalResult };
}

function reuseAbyssalCompletedCleanupWeather({
  getActivePocketStateByInstanceID,
  getAbyssalWeatherRemovalState,
  isExactAbyssalWeatherRemovalClaim,
  normalizeLowerText,
  cloneValue,
}, context) {
  const { instanceID } = context;
  context.activeBeforeWeatherRemoval = getActivePocketStateByInstanceID(instanceID) ||
    context.resolvedPocketState;
  context.previousWeatherRemovalState = getAbyssalWeatherRemovalState(
    context.activeBeforeWeatherRemoval,
  ) || {};
  const weatherRemovalAlreadyCompleted = Boolean(
    isExactAbyssalWeatherRemovalClaim(
      context.activeBeforeWeatherRemoval,
      context.previousWeatherRemovalState,
    ) &&
    normalizeLowerText(context.previousWeatherRemovalState.status, "") === "completed" &&
    (
      context.previousWeatherRemovalState.verified === true ||
      // A degraded completion already spent its retry budget; re-staging it
      // would restart the unsatisfiable pending loop this branch exists to end.
      context.previousWeatherRemovalState.degraded === true
    )
  );
  if (!weatherRemovalAlreadyCompleted) return false;
  context.resolvedPocketState = context.activeBeforeWeatherRemoval;
  context.weatherRemovalResult = {
    refreshed: true,
    verified: context.previousWeatherRemovalState.verified === true,
    duplicate: true,
    reason: context.previousWeatherRemovalState.verified === true
      ? "ALREADY_VERIFIED"
      : "ALREADY_COMPLETED_DEGRADED",
    verification: cloneValue(context.previousWeatherRemovalState.verification || {}),
  };
  return true;
}

function stageAbyssalCleanupWeatherAttempt({
  updatePocketState,
  ensureAbyssalPocketPersistenceReady,
  schedulePlaceholderPocketMaintenance,
  cloneValue,
  removeAbyssalWeatherFromRun,
}, context) {
  const { instanceID, reason, deps, options, cleanupNowMs, stagedCleanupState, cleanupShipID, artifactResult, cleanupSummary } = context;
  context.weatherRemovalAttempt = Math.max(
    0,
    toInt(context.previousWeatherRemovalState.attemptCount, 0),
  ) + 1;
  context.pendingWeatherRemovalState = {
    ...context.previousWeatherRemovalState,
    schemaVersion: 1,
    status: "pending",
    instanceID,
    characterID: toInt(context.activeBeforeWeatherRemoval.characterID, 0),
    shipID: cleanupShipID,
    traceItemID: toInt(context.activeBeforeWeatherRemoval.traceItemID, 0),
    reason,
    firstPendingAtMs:
      toInt(context.previousWeatherRemovalState.firstPendingAtMs, 0) || cleanupNowMs,
    lastAttemptAtMs: cleanupNowMs,
    attemptCount: context.weatherRemovalAttempt,
    verified: false,
    completedAtMs: 0,
  };
  const stagedWeatherPocketState = updatePocketState(instanceID, {
    weatherRemovalState: context.pendingWeatherRemovalState,
  }) || context.activeBeforeWeatherRemoval;
  const stagedWeatherPersistence = ensureAbyssalPocketPersistenceReady(
    stagedWeatherPocketState,
    deps,
  );
  if (!stagedWeatherPersistence || stagedWeatherPersistence.success !== true) {
    schedulePlaceholderPocketMaintenance(deps);
    return {
      success: false,
      pending: true,
      alreadyClean: false,
      errorMsg: "ABYSSAL_WEATHER_REMOVAL_STAGE_PERSIST_FAILED",
      reason,
      destroyedItemIDs: artifactResult.destroyedItemIDs,
      destroyedScannerProbeIDs: artifactResult.destroyedScannerProbeIDs || [],
      destroyedHostileIDs: artifactResult.destroyedHostileIDs,
      cleanupSummary: cloneValue(cleanupSummary),
      weatherRemovalPending: true,
      purged: false,
      sceneDisposed: false,
      sceneAlreadyGone: false,
    };
  }
  context.resolvedPocketState = stagedWeatherPocketState;
  context.weatherRemovalResult = removeAbyssalWeatherFromRun(
    context.resolvedPocketState,
    options.session || null,
    deps,
    {
      reason,
      broadcast: options.broadcast !== false,
    },
  );
  return null;
}

function deferUnverifiedAbyssalCleanupWeather({
  ABYSSAL_WEATHER_REMOVAL_MAX_ATTEMPTS,
  ABYSSAL_WEATHER_REMOVAL_MAX_PENDING_MS,
  updatePocketState,
  cloneValue,
  ensureAbyssalPocketPersistenceReady,
  schedulePlaceholderPocketMaintenance,
  log,
}, context) {
  const { instanceID, reason, deps, options, cleanupNowMs, stagedCleanupState, cleanupShipID, artifactResult, cleanupSummary } = context;
  const weatherRemovalBudgetExhausted = Boolean(
    context.weatherRemovalAttempt >= ABYSSAL_WEATHER_REMOVAL_MAX_ATTEMPTS ||
    (
      toInt(context.pendingWeatherRemovalState.firstPendingAtMs, 0) > 0 &&
      cleanupNowMs - toInt(context.pendingWeatherRemovalState.firstPendingAtMs, 0) >=
        ABYSSAL_WEATHER_REMOVAL_MAX_PENDING_MS
    )
  );
  if (
    (!context.weatherRemovalResult || context.weatherRemovalResult.verified !== true) &&
    !weatherRemovalBudgetExhausted
  ) {
    const weatherFailureReason = normalizeText(
      context.weatherRemovalResult && context.weatherRemovalResult.reason,
      "ABYSSAL_WEATHER_REMOVAL_VERIFY_FAILED",
    );
    const pendingPocketState = updatePocketState(instanceID, {
      weatherRemovalState: {
        ...context.pendingWeatherRemovalState,
        status: "pending",
        lastFailedAtMs: cleanupNowMs,
        failureReason: weatherFailureReason,
        verification: cloneValue(
          context.weatherRemovalResult && context.weatherRemovalResult.verification || {},
        ),
      },
      terminalCleanupState: {
        ...stagedCleanupState,
        status: "pending",
        lastFailedAtMs: cleanupNowMs,
        failureReason: "ABYSSAL_WEATHER_REMOVAL_PENDING",
      },
    });
    const pendingPersistence = pendingPocketState
      ? ensureAbyssalPocketPersistenceReady(pendingPocketState, deps)
      : { success: false };
    schedulePlaceholderPocketMaintenance(deps);
    log.warn(
      `[AbyssalCleanupRetry] run=${instanceID} state=pending ` +
        `reason=ABYSSAL_WEATHER_REMOVAL_PENDING ` +
        `refreshReason=${weatherFailureReason} ` +
        `persisted=${pendingPersistence.success === true}`,
    );
    return {
      success: false,
      pending: true,
      alreadyClean: false,
      errorMsg: pendingPersistence.success === true
        ? "ABYSSAL_WEATHER_REMOVAL_PENDING"
        : "ABYSSAL_CLEANUP_PENDING_PERSIST_FAILED",
      reason,
      destroyedItemIDs: artifactResult.destroyedItemIDs,
      destroyedScannerProbeIDs: artifactResult.destroyedScannerProbeIDs || [],
      destroyedHostileIDs: artifactResult.destroyedHostileIDs,
      cleanupSummary: cloneValue(cleanupSummary),
      weatherRemovalPending: true,
      weatherRemovalResult: context.weatherRemovalResult,
      purged: false,
      sceneDisposed: false,
      sceneAlreadyGone: false,
    };
  }
  return null;
}

function commitAbyssalCleanupWeatherCompletion({
  log,
  cloneValue,
  commitPocketStateDurably,
  schedulePlaceholderPocketMaintenance,
}, context) {
  const { instanceID, reason, deps, options, cleanupNowMs, stagedCleanupState, cleanupShipID, artifactResult, cleanupSummary } = context;
  const weatherRemovalVerified = Boolean(
    context.weatherRemovalResult && context.weatherRemovalResult.verified === true
  );
  if (!weatherRemovalVerified) {
    log.warn(
      `[AbyssalCleanupRetry] run=${instanceID} state=degraded ` +
        `reason=ABYSSAL_WEATHER_REMOVAL_UNVERIFIED ` +
        `refreshReason=${normalizeText(
          context.weatherRemovalResult && context.weatherRemovalResult.reason,
          "ABYSSAL_WEATHER_REMOVAL_VERIFY_FAILED",
        )} ` +
        `attempts=${context.weatherRemovalAttempt} ` +
        `pendingMs=${Math.max(
          0,
          cleanupNowMs - toInt(context.pendingWeatherRemovalState.firstPendingAtMs, cleanupNowMs),
        )}`,
    );
  }
  const completedWeatherRemovalState = {
    ...context.pendingWeatherRemovalState,
    status: "completed",
    verified: weatherRemovalVerified,
    degraded: !weatherRemovalVerified,
    failureReason: weatherRemovalVerified
      ? ""
      : normalizeText(
          context.weatherRemovalResult && context.weatherRemovalResult.reason,
          "ABYSSAL_WEATHER_REMOVAL_VERIFY_FAILED",
        ),
    completedAtMs: toInt(deps.now(), cleanupNowMs),
    verification: cloneValue(
      context.weatherRemovalResult && context.weatherRemovalResult.verification || {},
    ),
  };
  const completedCommit = commitPocketStateDurably(
    instanceID,
    {
      weatherRemovalState: {
        ...completedWeatherRemovalState,
      },
    },
    deps,
    { verifyReadBack: true, forceWrite: true },
  );
  if (!completedCommit || completedCommit.success !== true) {
    schedulePlaceholderPocketMaintenance(deps);
    return {
      success: false,
      pending: true,
      alreadyClean: false,
      errorMsg: "ABYSSAL_WEATHER_REMOVAL_COMPLETE_PERSIST_FAILED",
      reason,
      destroyedItemIDs: artifactResult.destroyedItemIDs,
      destroyedScannerProbeIDs: artifactResult.destroyedScannerProbeIDs || [],
      destroyedHostileIDs: artifactResult.destroyedHostileIDs,
      cleanupSummary: cloneValue(cleanupSummary),
      weatherRemovalPending: true,
      weatherRemovalResult: context.weatherRemovalResult,
      purged: false,
      sceneDisposed: false,
      sceneAlreadyGone: false,
    };
  }
  context.resolvedPocketState = cloneValue(
    completedCommit.committedState || completedCommit.state,
  );
  return null;
}

function reconcileAbyssalCleanupWeather({
  buildAbyssalCleanupWeatherContext,
  reuseAbyssalCompletedCleanupWeather,
  stageAbyssalCleanupWeatherAttempt,
  deferUnverifiedAbyssalCleanupWeather,
  commitAbyssalCleanupWeatherCompletion,
}, input) {
  const context = buildAbyssalCleanupWeatherContext(input);
  if (context.weatherRemovalRequired && !reuseAbyssalCompletedCleanupWeather(context)) {
    for (const step of [
      stageAbyssalCleanupWeatherAttempt,
      deferUnverifiedAbyssalCleanupWeather,
      commitAbyssalCleanupWeatherCompletion,
    ]) {
      const result = step(context);
      if (result) return { ready: false, result };
    }
  }
  return {
    ready: true,
    resolvedPocketState: context.resolvedPocketState,
    cleanupShipID: context.cleanupShipID,
    cleanupRunOutcome: context.cleanupRunOutcome,
    weatherRemovalRequired: context.weatherRemovalRequired,
    weatherRemovalResult: context.weatherRemovalResult,
  };
}

// Capture supplied capabilities once, as the original closure did. Internal
// callbacks are bound once per instance; no runtime state lives in this wiring.
function createAbyssalCleanupWeather({
  getAbyssalWeatherRemovalState,
  isExactAbyssalWeatherRemovalClaim,
  normalizeLowerText,
  getActivePocketStateByInstanceID,
  cloneValue,
  updatePocketState,
  ensureAbyssalPocketPersistenceReady,
  schedulePlaceholderPocketMaintenance,
  removeAbyssalWeatherFromRun,
  ABYSSAL_WEATHER_REMOVAL_MAX_ATTEMPTS,
  ABYSSAL_WEATHER_REMOVAL_MAX_PENDING_MS,
  log,
  commitPocketStateDurably,
}) {

  const ports = {
    getAbyssalWeatherRemovalState,
    isExactAbyssalWeatherRemovalClaim,
    normalizeLowerText,
    getActivePocketStateByInstanceID,
    cloneValue,
    updatePocketState,
    ensureAbyssalPocketPersistenceReady,
    schedulePlaceholderPocketMaintenance,
    removeAbyssalWeatherFromRun,
    ABYSSAL_WEATHER_REMOVAL_MAX_ATTEMPTS,
    ABYSSAL_WEATHER_REMOVAL_MAX_PENDING_MS,
    log,
    commitPocketStateDurably,
  };
  ports.buildAbyssalCleanupWeatherContext = buildAbyssalCleanupWeatherContext.bind(null, ports);
  ports.reuseAbyssalCompletedCleanupWeather = reuseAbyssalCompletedCleanupWeather.bind(null, ports);
  ports.stageAbyssalCleanupWeatherAttempt = stageAbyssalCleanupWeatherAttempt.bind(null, ports);
  ports.deferUnverifiedAbyssalCleanupWeather = deferUnverifiedAbyssalCleanupWeather.bind(null, ports);
  ports.commitAbyssalCleanupWeatherCompletion = commitAbyssalCleanupWeatherCompletion.bind(null, ports);
  ports.reconcileAbyssalCleanupWeather = reconcileAbyssalCleanupWeather.bind(null, ports);
  Object.freeze(ports);
  return { reconcileAbyssalCleanupWeather: ports.reconcileAbyssalCleanupWeather };
}

module.exports = { createAbyssalCleanupWeather };
