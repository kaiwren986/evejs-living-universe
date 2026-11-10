"use strict";

const {
  ABYSSAL_TRACE_LIFECYCLE_PHASE,
  normalizeAbyssalTraceLifecyclePhase,
  resolveAbyssalTraceAutomaticActivationDelayMs,
  resolveAbyssalTraceProfile,
} = require("../catalog/abyssalTraceProfiles");
const { getAbyssalTracePublicationReceipt } = require("./abyssalTracePublicationReceipts");
const { normalizeText } = require("../domain/abyssalValueUtils");

const ABYSSAL_TRANSIENT_ACTIVATION_RETRY_DELAY_MS = 1_000;
const ABYSSAL_TRANSIENT_ACTIVATION_BLOCK_REASONS = Object.freeze([
  "SESSION_CHANGE_IN_PROGRESS",
  "SHIP_SELF_DESTRUCTING",
  "SHIP_IN_DUNGEON",
  "SHIP_IN_FORCE_FIELD",
  "SHIP_IS_CLOAKED",
  "SHIP_IS_INVULNERABLE",
  "SHIP_IS_TETHERED",
  "SHIP_IN_WARP",
  "SHIP_IS_WARP_SCRAMBLED",
  "SHIP_HAS_CYNO_ACTIVE",
  "PVP_TIMER_ACTIVE",
  "SAFETY_ENGAGED",
]);

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

// Owns delayed activation orchestration, not its state or admission/compensation
// policy. Records and timer identity live in the injected registry; engine calls
// use the current port. Admission and failed-entry rollback remain explicit seams.
function logPendingAbyssalTraceActivation({
  isCompleteAbyssalTracePublicationReceipt,
  log,
}, record, phase, options = {}) {
  if (!record) {
    return;
  }
  const status = normalizeText(options.status, "pending");
  const reason = normalizeText(options.reason, "none").replace(/\s+/g, "_");
  const publicationStamp = toInt(
    options.publicationStamp,
    toInt(record.publicationStamp, 0),
  );
  const activationStamp = toInt(
    options.activationStamp,
    toInt(record.activationStamp, 0),
  );
  const delayStartAtMs = toInt(
    options.delayStartAtMs,
    toInt(record.scheduledAtMs, 0),
  );
  const activationAtMs = toInt(
    options.activationAt,
    toInt(record.activationAtMs, 0),
  );
  const publicationIdentity =
    record.publicationReceipt &&
    record.publicationReceipt.sessionIdentity ||
    {};
  const message =
    `[AbyssalTraceActivation] trace=${toInt(record.traceItemID, 0)} ` +
    `traceEntityID=${toInt(record.traceItemID, 0)} ` +
    `profileID=${normalizeText(record.traceProfileID, "legacy-generic")} ` +
    `filamentTypeID=${toInt(record.filamentTypeID, 0)} ` +
    `tier=${toInt(record.tier, 0)} weather=${normalizeText(record.weather, "unknown")} ` +
    `character=${toInt(record.characterID, 0)} ` +
    `session=${toInt(publicationIdentity.clientID, 0)}:${toInt(publicationIdentity.characterID, 0)} ` +
    `phase=${normalizeText(phase, normalizeText(record.status, "unknown"))} ` +
    `automatic=${options.automatic == null ? record.automatic === true : options.automatic === true} ` +
    `delayMs=${toInt(record.delayMs, 0)} transitionDelayMs=${toInt(record.transitionDelayMs, 0)} ` +
    `initialPublicationStamp=${publicationStamp} publicationStamp=${publicationStamp} ` +
    `activationStamp=${activationStamp} ` +
    `controllerEventStamp=${toInt(record.controllerEventStamp, 0)} ` +
    `departureEffectStamp=${toInt(record.departureEffectStamp, 0)} ` +
    `stampDelta=${activationStamp > 0 ? activationStamp - publicationStamp : 0} ` +
    `delayStartAt=${delayStartAtMs} activationAt=${activationAtMs} ` +
    `elapsedAfterPublicationMs=${activationAtMs > 0
      ? Math.max(0, activationAtMs - delayStartAtMs)
      : Math.max(0, toInt(options.loggedAtMs, delayStartAtMs) - delayStartAtMs)} ` +
    `sameDestinyStamp=${publicationStamp > 0 && activationStamp === publicationStamp} ` +
    `publicationComplete=${isCompleteAbyssalTracePublicationReceipt(
      record.publicationReceipt,
      record.traceItemID,
    )} ` +
    `slimUpdateSent=${options.slimUpdateSent == null
      ? record.slimUpdateSent === true
      : options.slimUpdateSent === true} ` +
    `controllerEventSent=${options.controllerEventSent == null
      ? record.controllerEventSent === true
      : options.controllerEventSent === true} ` +
    `departureEffectSent=${options.departureEffectSent == null
      ? record.departureEffectSent === true
      : options.departureEffectSent === true} ` +
    `sessionChangeStartedAt=${toInt(record.sessionChangeStartedAtMs, 0)} ` +
    `runID=${toInt(options.runID, toInt(record.runID, 0))} ` +
    `status=${status} reason=${reason}`;
  if (status === "failed") {
    log.warn(message);
  } else {
    log.info(message);
  }
}

function clearPendingAbyssalTraceActivationHandle({
  getDependencies,
}, record, deps = getDependencies()) {
  if (
    record &&
    record.handle !== null &&
    record.handle !== undefined
  ) {
    if (!deps || typeof deps.clearScheduledTimeout !== "function") {
      throw new Error("Abyssal trace activation timer cancellation is unavailable");
    }
    deps.clearScheduledTimeout(record.handle);
  }
  if (record) {
    record.handle = null;
  }
}

function clearPendingAbyssalTraceActivation({
  getDependencies,
  abyssalTraceStateRegistry,
  clearPendingAbyssalTraceActivationHandle,
}, traceItemID, deps = getDependencies()) {
  const numericTraceItemID = toInt(traceItemID, 0);
  return abyssalTraceStateRegistry.clearPendingActivation(
    numericTraceItemID,
    (record) => clearPendingAbyssalTraceActivationHandle(record, deps),
  );
}

function pendingAbyssalTraceActivationSessionIsReady({
  getSessionContext,
},
  record,
  session,
  options = {},
) {
  if (!record || !session || !session._space) {
    return false;
  }
  const context = getSessionContext(session);
  if (
    context.characterID !== toInt(record.characterID, 0) ||
    context.shipID <= 0 ||
    (
      options.requireExactShip === true &&
      context.shipID !== toInt(record.shipID, 0)
    ) ||
    context.systemID !== toInt(record.sourceSolarSystemID, 0)
  ) {
    return false;
  }
  const publicationIdentity =
    record.publicationReceipt &&
    record.publicationReceipt.sessionIdentity ||
    {};
  if (
    toInt(publicationIdentity.clientID, 0) > 0 &&
    toInt(publicationIdentity.clientID, 0) !==
      toInt(session.clientID ?? session.clientId, 0)
  ) {
    return false;
  }
  const currentSceneKey = normalizeText(
    session._space.sceneKey,
    `solar-system:${context.systemID}`,
  );
  return !record.sourceSceneKey || currentSceneKey === record.sourceSceneKey;
}

function pendingAbyssalTraceActivationMatchesSession({
  pendingAbyssalTraceActivationSessionIsReady,
}, record, session) {
  return pendingAbyssalTraceActivationSessionIsReady(record, session, {
    requireExactShip: true,
  });
}

function refreshPendingAbyssalTraceActivationFromValidation({
  getDependencies,
  abyssalTraceStateRegistry,
  cloneValue,
  log,
},
  record,
  validation,
  session,
  deps = getDependencies(),
  reason = "validated-current-ship",
) {
  const data = validation && validation.success === true && validation.data || null;
  const context = data && data.context || null;
  const traceState = data && data.traceState || null;
  const traceItemID = toInt(traceState && traceState.traceItemID, 0);
  if (!record || !data || !context || !traceState || traceItemID <= 0) {
    return { success: false, errorMsg: "PENDING_ACTIVATION_VALIDATION_MISSING" };
  }
  if (
    abyssalTraceStateRegistry.getPendingActivation(traceItemID) !== record ||
    traceItemID !== toInt(record.traceItemID, 0) ||
    normalizeText(traceState.deploymentToken, "") !==
      normalizeText(record.deploymentToken, "") ||
    toInt(context.characterID, 0) !== toInt(record.characterID, 0) ||
    toInt(context.shipID, 0) <= 0 ||
    toInt(context.systemID, 0) !== toInt(record.sourceSolarSystemID, 0)
  ) {
    return { success: false, errorMsg: "PENDING_ACTIVATION_AUTHORITY_CHANGED" };
  }

  const previousShipID = toInt(record.shipID, 0);
  record.shipID = toInt(context.shipID, 0);
  record.traceState = cloneValue(traceState);
  record.session = session || record.session;
  if (previousShipID > 0 && previousShipID !== record.shipID) {
    log.info(
      `[AbyssalTraceActivation] pending activation ship refreshed ` +
        `trace=${traceItemID} character=${toInt(record.characterID, 0)} ` +
        `old=${previousShipID} new=${record.shipID} ` +
        `reason=${normalizeText(reason, "validated-same-mode-replacement")}`,
    );
  }
  return {
    success: true,
    changed: previousShipID !== record.shipID,
    previousShipID,
    shipID: record.shipID,
  };
}

function deferPendingAbyssalTraceActivationForTransientState({
  getDependencies,
  getActiveTraceState,
  isCreatedAbyssalTraceExpired,
  expireCreatedAbyssalTrace,
  logPendingAbyssalTraceActivation,
  cloneValue,
  persistTraceState,
  log,
  armPendingAbyssalTraceActivation,
},
  record,
  validationError,
  deps = getDependencies(),
) {
  const details = validationError && validationError.details || {};
  const reason = normalizeText(details.reason, "TRANSIENT_ACTIVATION_BLOCK");
  const now = toInt(deps.now(), Date.now());
  const authoritativeDeadlineMs = Math.max(
    toInt(details.sessionChangeDeadlineMs, 0),
    toInt(details.pvpTimerExpiresAtMs, 0),
  );
  const traceState = getActiveTraceState(record.traceItemID, deps) || record.traceState;
  if (isCreatedAbyssalTraceExpired(traceState, now)) {
    const expirationResult = expireCreatedAbyssalTrace(
      traceState,
      deps,
      "transient-activation-retry-deadline",
    );
    record.status = "cancelled";
    logPendingAbyssalTraceActivation(record, "cancelled", {
      automatic: true,
      status: "cancelled",
      reason: expirationResult && expirationResult.success
        ? "TRACE_EXPIRED"
        : "TRACE_EXPIRATION_FAILED",
    });
    return {
      success: Boolean(expirationResult && expirationResult.success),
      scheduled: false,
      expired: true,
      expirationResult,
    };
  }
  let retryAtMs = authoritativeDeadlineMs > now
    ? authoritativeDeadlineMs + 1
    : now + ABYSSAL_TRANSIENT_ACTIVATION_RETRY_DELAY_MS;
  const traceExpiryMs = toInt(traceState && traceState.expiresAtMs, 0);
  if (traceExpiryMs > 0) {
    retryAtMs = Math.min(retryAtMs, traceExpiryMs);
  }
  record.status = "waiting-for-eligibility";
  record.dueAtMs = retryAtMs;
  record.lastEligibilityBlock = {
    reason,
    details: cloneValue(details),
    blockedAtMs: now,
    retryAtMs,
  };
  if (traceState) {
    const nextTraceState = {
      ...traceState,
      automaticActivation: {
        ...cloneValue(traceState.automaticActivation || {}),
        enabled: true,
        status: "waiting-for-eligibility",
        dueAtMs: retryAtMs,
        lastEligibilityBlock: cloneValue(record.lastEligibilityBlock),
      },
    };
    const persistResult = persistTraceState(nextTraceState, deps);
    if (persistResult.success) {
      record.traceState = cloneValue(nextTraceState);
    } else {
      log.warn(
        `[AbyssalTraceActivation] trace=${toInt(record.traceItemID, 0)} ` +
          `state=waiting-for-eligibility persist=failed ` +
          `reason=${normalizeText(persistResult.errorMsg, "TRACE_METADATA_PERSIST_FAILED")}`,
      );
    }
  }
  logPendingAbyssalTraceActivation(record, "waiting-for-eligibility", {
    automatic: true,
    status: "paused",
    reason,
  });
  try {
    return armPendingAbyssalTraceActivation(
      record,
      record.session,
      deps,
      reason,
    );
  } catch (error) {
    record.status = "waiting-for-eligibility";
    record.handle = null;
    log.warn(
      `[AbyssalTraceActivation] trace=${toInt(record.traceItemID, 0)} ` +
        `state=waiting-for-eligibility schedule=failed ` +
        `reason=${normalizeText(error && error.message, "TRACE_ACTIVATION_RETRY_SCHEDULING_FAILED")}`,
    );
    return {
      success: false,
      scheduled: false,
      preserved: true,
      errorMsg: normalizeText(
        error && error.message,
        "TRACE_ACTIVATION_RETRY_SCHEDULING_FAILED",
      ),
    };
  }
}

function executePendingAbyssalTraceActivation({
  getDependencies,
  abyssalTraceStateRegistry,
  getActiveTraceState,
  buildAbyssalTraceDeploymentToken,
  clearPendingAbyssalTraceActivation,
  logPendingAbyssalTraceActivation,
  isCreatedAbyssalTraceExpired,
  expireCreatedAbyssalTrace,
  pendingAbyssalTraceActivationSessionIsReady,
  isCompleteAbyssalTracePublicationReceipt,
  armPendingAbyssalTraceActivation,
  executeValidatedTraceActivation,
}, record, deps = getDependencies(), expectedHandle) {
  const expectedHandleWasProvided = arguments.length >= 4;
  if (
    !record ||
    abyssalTraceStateRegistry.getPendingActivation(toInt(record.traceItemID, 0)) !== record ||
    (expectedHandleWasProvided && record.handle !== expectedHandle)
  ) {
    return;
  }
  record.handle = null;
  const currentTraceState = getActiveTraceState(record.traceItemID, deps);
  const currentDeploymentToken = currentTraceState
    ? normalizeText(
        currentTraceState.deploymentToken,
        buildAbyssalTraceDeploymentToken(
          currentTraceState.traceItemID,
          currentTraceState.deployedAtMs,
        ),
      )
    : "";
  if (
    !currentTraceState ||
    currentDeploymentToken !== record.deploymentToken ||
    normalizeAbyssalTraceLifecyclePhase(currentTraceState.lifecyclePhase) !==
      ABYSSAL_TRACE_LIFECYCLE_PHASE.CREATED
  ) {
    clearPendingAbyssalTraceActivation(record.traceItemID, deps);
    record.status = "cancelled";
    logPendingAbyssalTraceActivation(record, "cancelled", {
      status: "cancelled",
      reason: currentTraceState ? "TRACE_STATE_CHANGED" : "TRACE_MISSING",
    });
    return;
  }
  const executionNowMs = toInt(deps && deps.now && deps.now(), Date.now());
  if (isCreatedAbyssalTraceExpired(currentTraceState, executionNowMs)) {
    const expirationResult = expireCreatedAbyssalTrace(
      currentTraceState,
      deps,
      "automatic-activation-deadline",
    );
    record.status = "cancelled";
    logPendingAbyssalTraceActivation(record, "cancelled", {
      automatic: true,
      status: "cancelled",
      reason: expirationResult && expirationResult.success
        ? "TRACE_EXPIRED"
        : "TRACE_EXPIRATION_FAILED",
    });
    return;
  }
  if (!pendingAbyssalTraceActivationSessionIsReady(record, record.session)) {
    record.status = "waiting-for-session";
    record.session = null;
    logPendingAbyssalTraceActivation(record, "waiting-for-session", {
      status: "paused",
      reason: "SESSION_NOT_READY",
    });
    return;
  }
  if (!isCompleteAbyssalTracePublicationReceipt(
    record.publicationReceipt,
    record.traceItemID,
  )) {
    record.status = "waiting-for-publication";
    logPendingAbyssalTraceActivation(record, "waiting-for-publication", {
      status: "paused",
      reason: "PUBLICATION_RECEIPT_MISSING",
    });
    return;
  }
  const runtime = deps;
  if (
    runtime &&
    typeof runtime.validateAbyssalTracePublicationReceipt === "function"
  ) {
    const validationResult = runtime.validateAbyssalTracePublicationReceipt(
      record.session,
      record.traceItemID,
      record.publicationReceipt,
    );
    if (!validationResult || !validationResult.success) {
      record.status = "waiting-for-session";
      record.session = null;
      logPendingAbyssalTraceActivation(record, "waiting-for-session", {
        status: "paused",
        reason: normalizeText(
          validationResult && validationResult.errorMsg,
          "PUBLICATION_RECEIPT_REVALIDATION_FAILED",
        ),
      });
      return;
    }
  }
  if (toInt(deps.now(), 0) < toInt(record.dueAtMs, 0)) {
    armPendingAbyssalTraceActivation(
      record,
      record.session,
      deps,
      "EARLY_TIMER_REARMED",
    );
    return;
  }
  executeValidatedTraceActivation(record, deps);
}

function executeValidatedTraceActivation({
  validateAbyssalTraceActivation,
  deferPendingAbyssalTraceActivationForTransientState,
  refreshPendingAbyssalTraceActivationFromValidation,
  abyssalTraceStateRegistry,
  rollbackPendingAbyssalTraceActivation,
  logPendingAbyssalTraceActivation,
}, record, deps) {
  const activationValidation = validateAbyssalTraceActivation(
    [record.traceItemID],
    record.session,
    deps,
  );
  if (!activationValidation.success) {
    const blockReason = normalizeText(
      activationValidation.error &&
        activationValidation.error.details &&
        activationValidation.error.details.reason,
      "",
    );
    if (ABYSSAL_TRANSIENT_ACTIVATION_BLOCK_REASONS.includes(blockReason)) {
      deferPendingAbyssalTraceActivationForTransientState(
        record,
        activationValidation.error,
        deps,
      );
      return;
    }
  } else {
    const pendingRefreshResult = refreshPendingAbyssalTraceActivationFromValidation(
      record,
      activationValidation,
      record.session,
      deps,
      "validated-same-mode-replacement",
    );
    if (!pendingRefreshResult.success) {
      if (abyssalTraceStateRegistry.getPendingActivation(record.traceItemID) === record) {
        rollbackPendingAbyssalTraceActivation(
          record,
          deps,
          pendingRefreshResult.errorMsg,
        );
      }
      return;
    }
  }

  record.status = "activation-started";
  record.automatic = true;
  logPendingAbyssalTraceActivation(record, "activation-started", {
    automatic: true,
    status: "started",
    reason: "DELAY_ELAPSED",
  });
  try {
    record.activate(record.session, record.traceItemID);
  } catch (error) {
    if (abyssalTraceStateRegistry.getPendingActivation(record.traceItemID) === record) {
      rollbackPendingAbyssalTraceActivation(
        record,
        deps,
        normalizeText(error && error.message, "AUTOMATIC_ACTIVATION_FAILED"),
      );
    }
  }
}

function armPendingAbyssalTraceActivation({
  getDependencies,
  isCompleteAbyssalTracePublicationReceipt,
  clearPendingAbyssalTraceActivationHandle,
  abyssalTraceStateRegistry,
  logPendingAbyssalTraceActivation,
  executePendingAbyssalTraceActivation,
}, record, session, deps = getDependencies(), reason = "scheduled") {
  if (
    !record ||
    !deps ||
    typeof deps.scheduleTimeout !== "function" ||
    typeof record.activate !== "function"
  ) {
    return {
      success: false,
      scheduled: false,
      errorMsg: "TRACE_ACTIVATION_SCHEDULING_UNAVAILABLE",
    };
  }
  if (!isCompleteAbyssalTracePublicationReceipt(
    record.publicationReceipt,
    record.traceItemID,
  )) {
    clearPendingAbyssalTraceActivationHandle(record, deps);
    record.session = session || null;
    record.status = "waiting-for-publication";
    abyssalTraceStateRegistry.setPendingActivation(record.traceItemID, record);
    logPendingAbyssalTraceActivation(record, "waiting-for-publication", {
      automatic: true,
      status: "pending",
      reason: "PUBLICATION_RECEIPT_MISSING",
    });
    return {
      success: true,
      scheduled: false,
      pendingPublication: true,
      delayMs: toInt(record.delayMs, 0),
      record,
    };
  }
  clearPendingAbyssalTraceActivationHandle(record, deps);
  record.session = session;
  record.status = "activation-pending";
  const remainingDelayMs = Math.max(0, toInt(record.dueAtMs, 0) - toInt(deps.now(), 0));
  let scheduledHandle;
  scheduledHandle = deps.scheduleTimeout(
    () => executePendingAbyssalTraceActivation(record, deps, scheduledHandle),
    remainingDelayMs,
  );
  record.handle = scheduledHandle;
  abyssalTraceStateRegistry.setPendingActivation(record.traceItemID, record);
  logPendingAbyssalTraceActivation(record, "activation-pending", {
    automatic: true,
    status: "scheduled",
    reason,
  });
  return {
    success: true,
    scheduled: true,
    delayMs: remainingDelayMs,
    record,
  };
}

function schedulePendingAbyssalTraceActivation({
  getDependencies,
  isCreatedAbyssalTraceExpired,
  expireCreatedAbyssalTrace,
  buildAbyssalTraceDeploymentToken,
  cloneValue,
  abyssalTraceStateRegistry,
  clearPendingAbyssalTraceActivationHandle,
  armPendingAbyssalTraceActivation,
  clearPendingAbyssalTraceActivation,
  scheduleNewTraceActivation,
},
  traceState,
  session,
  activate,
  deps = getDependencies(),
  options = {},
) {
  const traceProfile = resolveAbyssalTraceProfile(traceState);
  const configuredDelayMs = resolveAbyssalTraceAutomaticActivationDelayMs(traceProfile);
  const traceItemID = toInt(traceState && traceState.traceItemID, 0);
  const schedulingNowMs = toInt(deps && deps.now && deps.now(), Date.now());
  if (isCreatedAbyssalTraceExpired(traceState, schedulingNowMs)) {
    const expirationResult = expireCreatedAbyssalTrace(
      traceState,
      deps,
      options.resume === true
        ? "resumed-automatic-activation-deadline"
        : "automatic-activation-scheduling-deadline",
    );
    return {
      success: Boolean(expirationResult && expirationResult.success),
      scheduled: false,
      expired: true,
      expirationResult,
    };
  }
  if (configuredDelayMs == null || traceItemID <= 0) {
    return { success: true, scheduled: false, skipped: true };
  }
  const deploymentToken = normalizeText(
    traceState && traceState.deploymentToken,
    buildAbyssalTraceDeploymentToken(traceItemID, traceState && traceState.deployedAtMs),
  );
  const publicationReceipt =
    traceState && traceState.publicationReceipt &&
    typeof traceState.publicationReceipt === "object"
      ? cloneValue(traceState.publicationReceipt)
      : null;
  const publicationToken = normalizeText(
    publicationReceipt && publicationReceipt.publicationToken,
    "",
  );
  const existing = abyssalTraceStateRegistry.getPendingActivation(traceItemID) || null;
  if (existing && existing.deploymentToken === deploymentToken) {
    existing.activate = activate;
    const receiptChanged = Boolean(
      publicationToken &&
      publicationToken !== normalizeText(
        existing.publicationReceipt && existing.publicationReceipt.publicationToken,
        "",
      )
    );
    if (receiptChanged) {
      clearPendingAbyssalTraceActivationHandle(existing, deps);
      existing.publicationReceipt = publicationReceipt;
      existing.publicationStamp = toInt(publicationReceipt.addBallsStamp, 0);
      existing.scheduledAtMs = toInt(publicationReceipt.writtenAt, 0);
      existing.dueAtMs = existing.scheduledAtMs + configuredDelayMs;
      existing.traceState = cloneValue(traceState);
      existing.session = session || existing.session;
      return armPendingAbyssalTraceActivation(
        existing,
        existing.session,
        deps,
        options.resume === true ? "PUBLICATION_REESTABLISHED" : "PUBLICATION_COMPLETE",
      );
    }
    if (
      existing.status === "waiting-for-session" ||
      existing.status === "waiting-for-publication" ||
      (
        options.resume === true &&
        existing.status === "activation-pending" &&
        (existing.handle === null || existing.handle === undefined)
      )
    ) {
      return armPendingAbyssalTraceActivation(
        existing,
        session,
        deps,
        options.resume === true ? "SESSION_RESUMED" : "SESSION_REATTACHED",
      );
    }
    existing.session = session || existing.session;
    return {
      success: true,
      scheduled: existing.handle !== null && existing.handle !== undefined,
      duplicate: true,
      delayMs: Math.max(0, toInt(existing.dueAtMs, 0) - toInt(deps.now(), 0)),
      record: existing,
    };
  }
  if (existing) {
    clearPendingAbyssalTraceActivation(traceItemID, deps);
  }
  return scheduleNewTraceActivation({
    traceState,
    session,
    activate,
    deps,
    options,
    traceProfile,
    configuredDelayMs,
    traceItemID,
    deploymentToken,
    publicationReceipt,
  });
}

function scheduleNewTraceActivation({
  isCompleteAbyssalTracePublicationReceipt,
  cloneValue,
  armPendingAbyssalTraceActivation,
}, attempt) {
  const {
    traceState,
    session,
    activate,
    deps,
    options,
    traceProfile,
    configuredDelayMs,
    traceItemID,
    deploymentToken,
    publicationReceipt,
  } = attempt;
  const automaticActivationState =
    traceState && traceState.automaticActivation &&
    typeof traceState.automaticActivation === "object"
      ? traceState.automaticActivation
      : {};
  const scheduledAtMs = toInt(
    automaticActivationState.scheduledAtMs,
    toInt(traceState && traceState.deployedAtMs, toInt(deps.now(), 0)),
  );
  const dueAtMs = toInt(
    automaticActivationState.dueAtMs,
    scheduledAtMs + configuredDelayMs,
  );
  const record = {
    traceItemID,
    deploymentToken,
    traceProfileID: normalizeText(traceProfile && traceProfile.traceProfileID, ""),
    characterID: toInt(traceState && traceState.characterID, 0),
    shipID: toInt(traceState && traceState.shipID, 0),
    filamentItemID: toInt(traceState && traceState.filamentItemID, 0),
    filamentTypeID: toInt(traceState && traceState.filamentTypeID, 0),
    tier: toInt(
      traceState && traceState.contentProfile && traceState.contentProfile.tier,
      0,
    ),
    weather: normalizeText(
      traceState &&
        traceState.contentProfile &&
        traceState.contentProfile.weatherType,
      "unknown",
    ),
    sourceSceneKey: normalizeText(traceState && traceState.sourceSceneKey, ""),
    sourceSolarSystemID: toInt(
      traceState && traceState.sourceSolarSystemID,
      toInt(traceState && traceState.solarSystemID, 0),
    ),
    delayMs: configuredDelayMs,
    scheduledAtMs,
    dueAtMs,
    status: isCompleteAbyssalTracePublicationReceipt(publicationReceipt, traceItemID)
      ? "activation-pending"
      : "waiting-for-publication",
    automatic: true,
    publicationReceipt,
    publicationStamp: toInt(publicationReceipt && publicationReceipt.addBallsStamp, 0),
    activationStamp: 0,
    controllerEventStamp: 0,
    departureEffectStamp: 0,
    activationAtMs: 0,
    transitionDelayMs: 0,
    sessionChangeStartedAtMs: 0,
    slimUpdateSent: false,
    controllerEventSent: false,
    departureEffectSent: false,
    runID: 0,
    session,
    activate,
    handle: null,
    traceState: cloneValue(traceState),
  };
  return armPendingAbyssalTraceActivation(
    record,
    session,
    deps,
    options.resume === true ? "SESSION_RESUMED" : "DEPLOYMENT_COMPLETE",
  );
}

function claimPendingAbyssalTraceActivation({
  getDependencies,
  abyssalTraceStateRegistry,
  buildAbyssalTraceDeploymentToken,
  cloneValue,
  logPendingAbyssalTraceActivation,
  clearPendingAbyssalTraceActivationHandle,
},
  traceState,
  session,
  deps = getDependencies(),
  options = {},
) {
  const traceItemID = toInt(traceState && traceState.traceItemID, 0);
  let record = abyssalTraceStateRegistry.getPendingActivation(traceItemID) || null;
  const deploymentToken = normalizeText(
    traceState && traceState.deploymentToken,
    buildAbyssalTraceDeploymentToken(traceItemID, traceState && traceState.deployedAtMs),
  );
  if (!record && options.automatic !== true && traceItemID > 0) {
    const activatingCharacterID = toInt(
      options.activatingCharacterID,
      toInt(traceState && traceState.characterID, 0),
    );
    const activatingShipID = toInt(
      options.activatingShipID,
      toInt(traceState && traceState.shipID, 0),
    );
    const publicationReceipt = cloneValue(
      getAbyssalTracePublicationReceipt(session, traceItemID) ||
        traceState && traceState.publicationReceipt,
    ) || null;
    const claimedAtMs = toInt(deps && deps.now && deps.now(), Date.now());
    record = {
      traceItemID,
      deploymentToken,
      traceProfileID: normalizeText(traceState && traceState.traceProfileID, ""),
      characterID: toInt(
        activatingCharacterID,
        0,
      ),
      shipID: toInt(
        activatingShipID,
        0,
      ),
      filamentItemID: toInt(traceState && traceState.filamentItemID, 0),
      filamentTypeID: toInt(traceState && traceState.filamentTypeID, 0),
      tier: toInt(
        traceState && traceState.contentProfile && traceState.contentProfile.tier,
        0,
      ),
      weather: normalizeText(
        traceState && traceState.contentProfile && traceState.contentProfile.weatherType,
        "unknown",
      ),
      sourceSceneKey: normalizeText(traceState && traceState.sourceSceneKey, ""),
      sourceSolarSystemID: toInt(
        traceState && traceState.sourceSolarSystemID,
        toInt(traceState && traceState.solarSystemID, 0),
      ),
      delayMs: 0,
      scheduledAtMs: claimedAtMs,
      dueAtMs: claimedAtMs,
      status: "activation-started",
      automatic: false,
      publicationReceipt,
      publicationStamp: toInt(publicationReceipt && publicationReceipt.addBallsStamp, 0),
      activationStamp: 0,
      controllerEventStamp: 0,
      departureEffectStamp: 0,
      activationAtMs: 0,
      transitionDelayMs: 0,
      sessionChangeStartedAtMs: 0,
      slimUpdateSent: false,
      controllerEventSent: false,
      departureEffectSent: false,
      runID: 0,
      session,
      activate: null,
      handle: null,
      traceState: cloneValue(traceState),
    };
    abyssalTraceStateRegistry.setPendingActivation(traceItemID, record);
    logPendingAbyssalTraceActivation(record, "activation-started", {
      automatic: false,
      status: "started",
      reason: "MANUAL_ACTIVATION_CLAIMED",
    });
  }
  if (!record || record.deploymentToken !== deploymentToken) {
    return null;
  }
  clearPendingAbyssalTraceActivationHandle(record, deps);
  record.session = session;
  record.automatic = options.automatic === true;
  if (
    record.status === "activation-pending" ||
    record.status === "waiting-for-session"
  ) {
    record.status = "activation-started";
    logPendingAbyssalTraceActivation(record, "activation-started", {
      automatic: record.automatic,
      status: "started",
      reason: record.automatic ? "AUTOMATIC_CONTINUATION" : "MANUAL_JOIN",
    });
  }
  return record;
}

function updatePendingAbyssalTraceActivation({
  abyssalTraceStateRegistry,
  logPendingAbyssalTraceActivation,
}, traceItemID, phase, options = {}) {
  const record = abyssalTraceStateRegistry.getPendingActivation(toInt(traceItemID, 0)) || null;
  if (!record) {
    return null;
  }
  record.status = normalizeText(phase, record.status);
  record.runID = toInt(options.runID, toInt(record.runID, 0));
  if (options.slimUpdateSent != null) {
    record.slimUpdateSent = options.slimUpdateSent === true;
  }
  if (options.controllerEventSent != null) {
    record.controllerEventSent = options.controllerEventSent === true;
  }
  if (options.departureEffectSent != null) {
    record.departureEffectSent = options.departureEffectSent === true;
  }
  if (options.publicationStamp != null) {
    record.publicationStamp = toInt(options.publicationStamp, record.publicationStamp);
  }
  if (options.activationStamp != null) {
    record.activationStamp = toInt(options.activationStamp, record.activationStamp);
  }
  if (options.controllerEventStamp != null) {
    record.controllerEventStamp = toInt(
      options.controllerEventStamp,
      record.controllerEventStamp,
    );
  }
  if (options.departureEffectStamp != null) {
    record.departureEffectStamp = toInt(
      options.departureEffectStamp,
      record.departureEffectStamp,
    );
  }
  if (options.activationAt != null) {
    record.activationAtMs = toInt(options.activationAt, record.activationAtMs);
  }
  if (options.transitionDelayMs != null) {
    record.transitionDelayMs = toInt(
      options.transitionDelayMs,
      record.transitionDelayMs,
    );
  }
  if (options.sessionChangeStartedAt != null) {
    record.sessionChangeStartedAtMs = toInt(
      options.sessionChangeStartedAt,
      record.sessionChangeStartedAtMs,
    );
  }
  logPendingAbyssalTraceActivation(record, phase, {
    ...options,
    automatic: record.automatic,
    status: normalizeText(options.status, "complete"),
  });
  return record;
}

function completePendingAbyssalTraceActivation({
  getDependencies,
  abyssalTraceStateRegistry,
  updatePendingAbyssalTraceActivation,
  clearPendingAbyssalTraceActivation,
},
  traceItemID,
  deps = getDependencies(),
  options = {},
) {
  const record = abyssalTraceStateRegistry.getPendingActivation(toInt(traceItemID, 0)) || null;
  if (!record) {
    return null;
  }
  updatePendingAbyssalTraceActivation(traceItemID, "entered", {
    ...options,
    status: "complete",
    reason: normalizeText(options.reason, "ENTRY_TRANSITION_COMPLETED"),
  });
  clearPendingAbyssalTraceActivation(traceItemID, deps);
  return record;
}

function pausePendingAbyssalTraceActivationForCharacter({
  getDependencies,
  abyssalTraceStateRegistry,
  clearPendingAbyssalTraceActivationHandle,
  logPendingAbyssalTraceActivation,
},
  characterID,
  deps = getDependencies(),
  reason = "disconnect",
) {
  const numericCharacterID = toInt(characterID, 0);
  const record = [...abyssalTraceStateRegistry.listPendingActivations()].find(
    (candidate) =>
      toInt(candidate && candidate.characterID, 0) === numericCharacterID &&
      (
        candidate.status === "activation-pending" ||
        candidate.status === "waiting-for-publication" ||
        candidate.status === "waiting-for-session"
      ),
  ) || null;
  if (!record) {
    return null;
  }
  clearPendingAbyssalTraceActivationHandle(record, deps);
  record.session = null;
  record.status = "waiting-for-session";
  logPendingAbyssalTraceActivation(record, "waiting-for-session", {
    automatic: true,
    status: "paused",
    reason,
  });
  return record;
}

// Capture supplied capabilities once, as the original closure did. Internal
// callbacks are bound once per instance; no runtime state lives in this wiring.
function createAbyssalTraceActivation({
  getDependencies,
  abyssalTraceStateRegistry,
  cloneValue,
  log,
  getSessionContext,
  isCompleteAbyssalTracePublicationReceipt,
  getActiveTraceState,
  buildAbyssalTraceDeploymentToken,
  isCreatedAbyssalTraceExpired,
  expireCreatedAbyssalTrace,
  persistTraceState,
  validateAbyssalTraceActivation,
  rollbackPendingAbyssalTraceActivation,
}) {

  const ports = {
    getDependencies,
    abyssalTraceStateRegistry,
    cloneValue,
    log,
    getSessionContext,
    isCompleteAbyssalTracePublicationReceipt,
    getActiveTraceState,
    buildAbyssalTraceDeploymentToken,
    isCreatedAbyssalTraceExpired,
    expireCreatedAbyssalTrace,
    persistTraceState,
    validateAbyssalTraceActivation,
    rollbackPendingAbyssalTraceActivation,
  };
  ports.logPendingAbyssalTraceActivation = logPendingAbyssalTraceActivation.bind(null, ports);
  ports.clearPendingAbyssalTraceActivationHandle = clearPendingAbyssalTraceActivationHandle.bind(null, ports);
  ports.clearPendingAbyssalTraceActivation = clearPendingAbyssalTraceActivation.bind(null, ports);
  ports.pendingAbyssalTraceActivationSessionIsReady = pendingAbyssalTraceActivationSessionIsReady.bind(null, ports);
  ports.pendingAbyssalTraceActivationMatchesSession = pendingAbyssalTraceActivationMatchesSession.bind(null, ports);
  ports.refreshPendingAbyssalTraceActivationFromValidation = refreshPendingAbyssalTraceActivationFromValidation.bind(null, ports);
  ports.deferPendingAbyssalTraceActivationForTransientState = deferPendingAbyssalTraceActivationForTransientState.bind(null, ports);
  ports.executePendingAbyssalTraceActivation = executePendingAbyssalTraceActivation.bind(null, ports);
  ports.executeValidatedTraceActivation = executeValidatedTraceActivation.bind(null, ports);
  ports.armPendingAbyssalTraceActivation = armPendingAbyssalTraceActivation.bind(null, ports);
  ports.schedulePendingAbyssalTraceActivation = schedulePendingAbyssalTraceActivation.bind(null, ports);
  ports.scheduleNewTraceActivation = scheduleNewTraceActivation.bind(null, ports);
  ports.claimPendingAbyssalTraceActivation = claimPendingAbyssalTraceActivation.bind(null, ports);
  ports.updatePendingAbyssalTraceActivation = updatePendingAbyssalTraceActivation.bind(null, ports);
  ports.completePendingAbyssalTraceActivation = completePendingAbyssalTraceActivation.bind(null, ports);
  ports.pausePendingAbyssalTraceActivationForCharacter = pausePendingAbyssalTraceActivationForCharacter.bind(null, ports);
  Object.freeze(ports);
  return Object.freeze({
    logPendingAbyssalTraceActivation: ports.logPendingAbyssalTraceActivation,
    clearPendingAbyssalTraceActivationHandle: ports.clearPendingAbyssalTraceActivationHandle,
    clearPendingAbyssalTraceActivation: ports.clearPendingAbyssalTraceActivation,
    pendingAbyssalTraceActivationSessionIsReady: ports.pendingAbyssalTraceActivationSessionIsReady,
    pendingAbyssalTraceActivationMatchesSession: ports.pendingAbyssalTraceActivationMatchesSession,
    refreshPendingAbyssalTraceActivationFromValidation: ports.refreshPendingAbyssalTraceActivationFromValidation,
    deferPendingAbyssalTraceActivationForTransientState: ports.deferPendingAbyssalTraceActivationForTransientState,
    executePendingAbyssalTraceActivation: ports.executePendingAbyssalTraceActivation,
    armPendingAbyssalTraceActivation: ports.armPendingAbyssalTraceActivation,
    schedulePendingAbyssalTraceActivation: ports.schedulePendingAbyssalTraceActivation,
    claimPendingAbyssalTraceActivation: ports.claimPendingAbyssalTraceActivation,
    updatePendingAbyssalTraceActivation: ports.updatePendingAbyssalTraceActivation,
    completePendingAbyssalTraceActivation: ports.completePendingAbyssalTraceActivation,
    pausePendingAbyssalTraceActivationForCharacter: ports.pausePendingAbyssalTraceActivationForCharacter,
  });
}

module.exports = { createAbyssalTraceActivation };
