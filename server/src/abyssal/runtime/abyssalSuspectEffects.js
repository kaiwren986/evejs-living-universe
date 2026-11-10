"use strict";

const { normalizeText } = require("../domain/abyssalValueUtils");

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function buildAbyssalSuspectFlagResult(ports, validation, overrides = {}) {
  const {
    toReal,
  } = ports;
  const securityPolicy =
    validation && validation.data && validation.data.securityPolicy
      ? validation.data.securityPolicy
      : {};
  const filamentDefinition =
    validation && validation.data && validation.data.filamentDefinition
      ? validation.data.filamentDefinition
      : {};
  const filamentType =
    validation && validation.data && validation.data.filamentType
      ? validation.data.filamentType
      : null;
  const context =
    validation && validation.data && validation.data.context
      ? validation.data.context
      : {};
  return {
    characterID: toInt(context.characterID, 0),
    filamentTypeID: toInt(
      filamentDefinition && filamentDefinition.filamentTypeID,
      toInt(filamentType && filamentType.typeID, 0),
    ),
    tier: toInt(filamentDefinition && filamentDefinition.tier, 0),
    security: toReal(securityPolicy.security, 0),
    band: toReal(securityPolicy.normalizedSecurity, 0),
    suspectRequired: securityPolicy.suspectRequired === true,
    suspectApplied: false,
    reason: "NOT_REQUIRED",
    suspectTimerExpiresAtMs: 0,
    ...overrides,
  };
}

function getAbyssalSuspectTimerExpiresAtMs(ports, crimewatchState) {
  if (!crimewatchState || crimewatchState.suspect !== true) {
    return 0;
  }
  return toInt(
    crimewatchState.suspectTimerExpiresAtMs,
    toInt(crimewatchState.criminalTimerExpiresAtMs, 0),
  );
}

function applyAbyssalSuspectFlagIfRequired(ports,
  validation,
  session,
  deps = ports.getDependencies(),
  options = {},
) {
  const {
    ABYSSAL_SUSPECT_RETURN_DURATION_MS,
  } = ports;
  const baseResult = buildAbyssalSuspectFlagResult(ports, validation);
  if (baseResult.suspectRequired !== true) {
    return baseResult;
  }

  const crimewatch = deps.crimewatchState;
  if (
    !crimewatch ||
    typeof crimewatch.getCharacterCrimewatchState !== "function" ||
    typeof crimewatch.setCharacterCrimewatchDebugState !== "function"
  ) {
    return {
      ...baseResult,
      reason: "NO_SUSPECT_TIMER_HOOK",
    };
  }

  const now = deps.now();
  const currentState = crimewatch.getCharacterCrimewatchState(
    baseResult.characterID,
    now,
  ) || null;
  const currentTimerExpiresAtMs =
    getAbyssalSuspectTimerExpiresAtMs(ports, currentState);
  const desiredUntilMs = Math.max(
    now + 1,
    toInt(options.desiredUntilMs, now + ABYSSAL_SUSPECT_RETURN_DURATION_MS),
  );
  const currentCriminalExpiresAtMs = currentState && currentState.criminal === true
    ? toInt(currentState.criminalTimerExpiresAtMs, 0)
    : 0;
  if (currentCriminalExpiresAtMs >= desiredUntilMs) {
    return {
      ...baseResult,
      suspectApplied: true,
      reason: "CRIMINAL_ALREADY_SATISFIED",
      suspectTimerExpiresAtMs: currentCriminalExpiresAtMs,
    };
  }
  if (
    currentState &&
    currentState.suspect === true &&
    currentTimerExpiresAtMs >= desiredUntilMs
  ) {
    return {
      ...baseResult,
      suspectApplied: true,
      reason: "ALREADY_SATISFIED",
      suspectTimerExpiresAtMs: currentTimerExpiresAtMs,
    };
  }

  const context =
    validation && validation.data && validation.data.context
      ? validation.data.context
      : {};
  const applyResult = crimewatch.setCharacterCrimewatchDebugState(
    baseResult.characterID,
    {
      suspect: true,
      criminal: false,
      criminalTimerMs: Math.max(1, desiredUntilMs - now),
    },
    {
      now,
      systemID: toInt(context.systemID, 0),
    },
  );
  if (!applyResult || applyResult.success !== true) {
    return {
      ...baseResult,
      reason: normalizeText(
        applyResult && applyResult.errorMsg,
        "SUSPECT_APPLY_FAILED",
      ),
    };
  }

  if (
    session &&
    typeof crimewatch.synchronizeSessionTimerNotifications === "function"
  ) {
    crimewatch.synchronizeSessionTimerNotifications(null, session, now);
  }

  return {
    ...baseResult,
    suspectApplied: true,
    reason: "APPLIED",
    suspectTimerExpiresAtMs:
      getAbyssalSuspectTimerExpiresAtMs(ports, applyResult.data) || desiredUntilMs,
  };
}

function recordAndLogAbyssalSuspectFlagOutcome(ports,
  suspectResult,
  args,
  session,
  traceItemID = 0,
) {
  const {
    toReal,
    recordAuditEvent,
    log,
  } = ports;
  const details = {
    traceItemID: toInt(traceItemID, 0),
    filamentTypeID: toInt(suspectResult && suspectResult.filamentTypeID, 0),
    tier: toInt(suspectResult && suspectResult.tier, 0),
    security: toReal(suspectResult && suspectResult.security, 0),
    normalizedSecurity: toReal(suspectResult && suspectResult.band, 0),
    suspectRequired: suspectResult && suspectResult.suspectRequired === true,
    suspectApplied: suspectResult && suspectResult.suspectApplied === true,
    reason: normalizeText(suspectResult && suspectResult.reason, "UNKNOWN"),
    suspectTimerExpiresAtMs: toInt(
      suspectResult && suspectResult.suspectTimerExpiresAtMs,
      0,
    ),
  };
  recordAuditEvent("abyssal_entrance_deployment_suspect_status", args, session, details);
  const message =
    `[AbyssalMgr] Abyssal activation security char=${toInt(suspectResult && suspectResult.characterID, 0)} ` +
    `trace=${toInt(traceItemID, 0)} filamentTypeID=${toInt(suspectResult && suspectResult.filamentTypeID, 0)} ` +
    `tier=${toInt(suspectResult && suspectResult.tier, 0)} ` +
    `security=${toReal(suspectResult && suspectResult.security, 0)} ` +
    `band=${toReal(suspectResult && suspectResult.band, 0)} ` +
    `suspectRequired=${suspectResult && suspectResult.suspectRequired === true} ` +
    `suspectApplied=${suspectResult && suspectResult.suspectApplied === true} ` +
    `reason=${normalizeText(suspectResult && suspectResult.reason, "UNKNOWN")}`;
  if (
    suspectResult &&
    suspectResult.suspectRequired === true &&
    suspectResult.suspectApplied !== true &&
    (
      suspectResult.reason === "NO_SUSPECT_TIMER_HOOK" ||
      suspectResult.reason === "SUSPECT_APPLY_FAILED"
    )
  ) {
    log.warn(message);
    return;
  }
  log.info(message);
  if (
    suspectResult &&
    suspectResult.suspectRequired === true &&
    suspectResult.suspectApplied === true
  ) {
    log.info(
      `[AbyssalMgr] Suspect flag applied for Abyssal activation char=${toInt(suspectResult.characterID, 0)} ` +
        `trace=${toInt(traceItemID, 0)} filamentTypeID=${toInt(suspectResult.filamentTypeID, 0)} ` +
        `tier=${toInt(suspectResult.tier, 0)} security=${toReal(suspectResult.security, 0)} ` +
        `band=${toReal(suspectResult.band, 0)}`,
    );
  }
}

function isAbyssalSuspectReturnPending(ports, source) {
  const {
    getAbyssalParticipantReturnObligationsByCharacterID,
    normalizeLowerText,
  } = ports;
  if (
    source &&
    source.participantReturnObligationsByCharacterID &&
    typeof source.participantReturnObligationsByCharacterID === "object"
  ) {
    return Object.values(
      getAbyssalParticipantReturnObligationsByCharacterID(source),
    ).some((obligation) => Boolean(
      obligation.suspectOnReturn === true &&
      normalizeLowerText(
        obligation.suspectReturnState && obligation.suspectReturnState.state,
        "pending",
      ) !== "completed",
    ));
  }
  return Boolean(
    source &&
    source.suspectOnReturn === true &&
    normalizeLowerText(
      source.suspectReturnState && source.suspectReturnState.state,
      "pending",
    ) !== "completed"
  );
}

function buildAbyssalSuspectReturnValidation(ports, source) {
  const {
    cloneValue,
    getContentProfile,
  } = ports;
  const securityPolicy = source && source.securityPolicy &&
    typeof source.securityPolicy === "object"
      ? cloneValue(source.securityPolicy)
      : {
          suspectRequired: source && source.suspectOnReturn === true,
          security: 0,
          normalizedSecurity: 0,
        };
  const contentProfile = getContentProfile(source) || {};
  return {
    success: true,
    data: {
      securityPolicy: {
        ...securityPolicy,
        suspectRequired: source && source.suspectOnReturn === true ||
          securityPolicy.suspectRequired === true,
      },
      filamentDefinition: contentProfile,
      filamentType: {
        typeID: toInt(source && source.filamentTypeID, toInt(contentProfile.filamentTypeID, 0)),
      },
      context: {
        characterID: toInt(source && source.characterID, 0),
        shipID: toInt(source && source.shipID, 0),
        systemID: toInt(
          source && source.sourceSolarSystemID,
          toInt(source && source.solarSystemID, 0),
        ),
      },
    },
  };
}

function persistAbyssalSuspectReturnTraceState(ports,
  source,
  suspectReturnState,
  deps = ports.getDependencies(),
) {
  const {
    cloneValue,
    persistAbyssalParticipantReturnObligation,
  } = ports;
  return persistAbyssalParticipantReturnObligation(
    source,
    {
      characterID: toInt(source && source.characterID, 0),
      shipID: toInt(source && source.shipID, 0),
      sourceSolarSystemID: toInt(source && source.sourceSolarSystemID, 0),
      securityPolicy: cloneValue(source && source.securityPolicy),
      suspectOnReturn: source && source.suspectOnReturn === true,
      suspectReturnState: cloneValue(suspectReturnState),
    },
    deps,
  );
}

function recordAndLogAbyssalSuspectReturnOutcome(ports,
  source,
  suspectResult,
  suspectReturnState,
  session,
) {
  const {
    recordAuditEvent,
    log,
  } = ports;
  const details = {
    instanceID: toInt(source && source.instanceID, 0),
    traceItemID: toInt(
      source && source.sourceTraceItemID,
      toInt(source && source.traceItemID, 0),
    ),
    characterID: toInt(source && source.characterID, 0),
    filamentTypeID: toInt(suspectResult && suspectResult.filamentTypeID, 0),
    suspectRequired: source && source.suspectOnReturn === true,
    suspectApplied: suspectResult && suspectResult.suspectApplied === true,
    reason: normalizeText(suspectResult && suspectResult.reason, "UNKNOWN"),
    state: normalizeText(suspectReturnState && suspectReturnState.state, "unknown"),
    idempotencyKey: normalizeText(
      suspectReturnState && suspectReturnState.idempotencyKey,
      "",
    ),
    attemptCount: toInt(suspectReturnState && suspectReturnState.attemptCount, 0),
    desiredUntilMs: toInt(suspectReturnState && suspectReturnState.desiredUntilMs, 0),
    suspectTimerExpiresAtMs: toInt(
      suspectResult && suspectResult.suspectTimerExpiresAtMs,
      0,
    ),
  };
  recordAuditEvent("abyssal_return_suspect_status", [], session, details);
  const message =
    `[AbyssalReturnEffect] run=${details.instanceID} trace=${details.traceItemID} ` +
    `character=${details.characterID} effect=suspect state=${details.state} ` +
    `attempt=${details.attemptCount} applied=${details.suspectApplied} ` +
    `reason=${details.reason} desiredUntilMs=${details.desiredUntilMs} ` +
    `expiresAtMs=${details.suspectTimerExpiresAtMs}`;
  if (details.suspectRequired && !details.suspectApplied) {
    log.warn(message);
  } else {
    log.info(message);
  }
}

function doesCrimewatchStateSatisfyPersistedAbyssalSuspectReturn(ports,
  source,
  desiredUntilMs,
  now,
  deps = ports.getDependencies(),
) {
  const persistedDesiredUntilMs = toInt(desiredUntilMs, 0);
  const characterID = toInt(source && source.characterID, 0);
  const crimewatch = deps && deps.crimewatchState;
  if (
    persistedDesiredUntilMs <= 0 ||
    characterID <= 0 ||
    !crimewatch ||
    typeof crimewatch.getCharacterCrimewatchState !== "function"
  ) {
    return false;
  }
  let currentState = null;
  try {
    currentState = crimewatch.getCharacterCrimewatchState(characterID, now) || null;
  } catch (error) {
    // ignored: an unreadable crimewatch state does not satisfy the saved suspect timer (false)
    return false;
  }
  const currentTimerExpiresAtMs =
    getAbyssalSuspectTimerExpiresAtMs(ports, currentState);
  return Boolean(
    currentState &&
    currentState.suspect === true &&
    currentTimerExpiresAtMs >= persistedDesiredUntilMs
  );
}

function settlePendingAbyssalSuspectReturnForSession(ports,
  session,
  deps = ports.getDependencies(),
) {
  const {
    normalizeLowerText,
    cloneValue,
    getSessionContext,
    listTraces,
    readTraceStateFromItem,
    getAbyssalParticipantReturnObligation,
    normalizeAbyssalTraceLifecyclePhase,
    ABYSSAL_TRACE_LIFECYCLE_PHASE,
  } = ports;
  const context = getSessionContext(session);
  if (context.characterID <= 0 || context.systemID <= 0) {
    return { success: true, skipped: true, reason: "SESSION_NOT_IN_SPACE" };
  }
  const candidates = new Map();
  for (const traceState of listTraces()) {
    if (traceState && toInt(traceState.traceItemID, 0) > 0) {
      candidates.set(toInt(traceState.traceItemID, 0), cloneValue(traceState));
    }
  }
  if (typeof deps.listSystemSpaceItems === "function") {
    for (const item of deps.listSystemSpaceItems(context.systemID)) {
      const traceState = readTraceStateFromItem(item);
      if (traceState) {
        candidates.set(toInt(traceState.traceItemID, 0), traceState);
      }
    }
  }
  let pendingSource = null;
  for (const traceState of candidates.values()) {
    const obligation = getAbyssalParticipantReturnObligation(
      traceState,
      context.characterID,
    );
    if (
      obligation &&
      toInt(obligation.sourceSolarSystemID, 0) === context.systemID &&
      obligation.suspectOnReturn === true &&
      normalizeAbyssalTraceLifecyclePhase(traceState.lifecyclePhase) ===
        ABYSSAL_TRACE_LIFECYCLE_PHASE.RETURNED &&
      normalizeLowerText(
        obligation.suspectReturnState && obligation.suspectReturnState.state,
        "pending",
      ) !== "completed"
    ) {
      pendingSource = {
        ...cloneValue(traceState),
        instanceID: toInt(obligation.runID, toInt(traceState.abyssalRunID, 0)),
        characterID: obligation.characterID,
        shipID: obligation.shipID,
        sourceSolarSystemID: obligation.sourceSolarSystemID,
        securityPolicy: cloneValue(obligation.securityPolicy || traceState.securityPolicy),
        suspectOnReturn: true,
        suspectReturnState: cloneValue(obligation.suspectReturnState),
      };
      break;
    }
  }
  return pendingSource
    ? settleAbyssalSuspectOnReturn(ports, pendingSource, session, deps)
    : { success: true, skipped: true, reason: "NO_PENDING_SUSPECT_RETURN" };
}

// An applying claim can mean authority succeeded but receipt persistence failed.
// Preserve its satisfied deadline; a failed pending retry still owes a full duration.
function settleAbyssalSuspectOnReturn(ports, source, session, deps = ports.getDependencies()) {
  const work = { source, session, deps };
  for (const settle of [prepareSuspectClaim, persistSuspectClaim, applySuspectClaim, persistSuspectReceipt]) {
    const result = settle(ports, work);
    if (result) return result;
  }
  return finishSuspectSettlement(ports, work);
}

function prepareSuspectClaim(ports, work) {
  const {
    ABYSSAL_SUSPECT_RETURN_DURATION_MS,
    normalizeLowerText,
    cloneValue,
  } = ports;
  const {
    source,
    deps,
  } = work;
  if (!source || source.suspectOnReturn !== true) {
    return {
      success: true,
      skipped: true,
      state: {
        state: "not_required",
      },
    };
  }
  const now = toInt(deps.now(), Date.now());
  const priorState = source.suspectReturnState &&
  typeof source.suspectReturnState === "object"
    ? cloneValue(source.suspectReturnState)
    : {};
  if (normalizeLowerText(priorState.state, "") === "completed") {
    return {
      success: true,
      skipped: true,
      duplicate: true,
      state: priorState,
    };
  }
  const traceItemID = toInt(
    source.sourceTraceItemID,
    toInt(source.traceItemID, 0),
  );
  const priorStateName = normalizeLowerText(priorState.state, "pending");
  const persistedDesiredUntilMs = toInt(priorState.desiredUntilMs, 0);
  const previouslyAppliedTimerStillSatisfiesClaim =
  priorStateName === "applying" &&
  doesCrimewatchStateSatisfyPersistedAbyssalSuspectReturn(ports,
    source,
    persistedDesiredUntilMs,
    now,
    deps,
  );
  const desiredUntilMs = previouslyAppliedTimerStillSatisfiesClaim
  ? persistedDesiredUntilMs
  : Math.max(
      persistedDesiredUntilMs,
      now + ABYSSAL_SUSPECT_RETURN_DURATION_MS,
    );
  const claimState = {
    ...priorState,
    state: "applying",
    idempotencyKey: normalizeText(
      priorState.idempotencyKey,
      `abyssal-return-suspect:${traceItemID}:${toInt(source.characterID, 0)}`,
    ),
    stagedAtMs: toInt(priorState.stagedAtMs, now),
    desiredUntilMs,
    claimedAtMs: toInt(priorState.claimedAtMs, now),
    lastAttemptAtMs: now,
    attemptCount: Math.max(0, toInt(priorState.attemptCount, 0)) + 1,
  };
  Object.assign(work, { now, traceItemID, desiredUntilMs, claimState });
}

function persistSuspectClaim(ports, work) {
  const {
    cloneValue,
    getActivePocketStateByInstanceID,
    updatePocketState,
    ensureAbyssalPocketPersistenceReady,
  } = ports;
  const {
    source,
    deps,
    claimState,
  } = work;
  let claimedPocketState = null;
  let sourceIsPocketOwner = false;
  if (toInt(source.instanceID, 0) > 0) {
    const activePocketState = getActivePocketStateByInstanceID(
      toInt(source.instanceID, 0),
    );
    sourceIsPocketOwner = Boolean(
      activePocketState &&
      toInt(activePocketState.characterID, 0) === toInt(source.characterID, 0),
    );
    claimedPocketState = sourceIsPocketOwner
      ? updatePocketState(toInt(source.instanceID, 0), {
          suspectOnReturn: true,
          securityPolicy: cloneValue(source.securityPolicy),
          suspectReturnState: claimState,
        })
      : activePocketState;
    const pocketPersistence = ensureAbyssalPocketPersistenceReady(
      claimedPocketState || source,
      deps,
    );
    if (!pocketPersistence.success) {
      return {
        success: false,
        errorMsg: "ABYSSAL_SUSPECT_RETURN_CLAIM_PERSIST_FAILED",
        state: claimState,
      };
    }
  }
  const claimPersistenceSource = sourceIsPocketOwner
  ? claimedPocketState || source
  : source;
  const traceClaimResult = persistAbyssalSuspectReturnTraceState(ports,
    claimPersistenceSource,
    claimState,
    deps,
  );
  if (!traceClaimResult.success) {
    return {
      success: false,
      errorMsg: normalizeText(
        traceClaimResult.errorMsg,
        "ABYSSAL_SUSPECT_RETURN_TRACE_CLAIM_PERSIST_FAILED",
      ),
      state: claimState,
    };
  }
  Object.assign(work, { claimedPocketState, sourceIsPocketOwner, claimPersistenceSource });
}

function applySuspectClaim(ports, work) {
  const {
    deps,
    session,
    claimPersistenceSource,
    desiredUntilMs,
    now,
    claimState,
  } = work;
  const validation = buildAbyssalSuspectReturnValidation(ports, claimPersistenceSource);
  const suspectResult = applyAbyssalSuspectFlagIfRequired(ports,
    validation,
    session,
    deps,
    { desiredUntilMs },
  );
  const applied = suspectResult && suspectResult.suspectApplied === true;
  const settledAtMs = toInt(deps.now(), now);
  const settledState = {
    ...claimState,
    state: applied ? "completed" : "pending",
    lastResult: normalizeText(suspectResult && suspectResult.reason, "UNKNOWN"),
    ...(applied
      ? {
          completedAtMs: settledAtMs,
          suspectTimerExpiresAtMs: toInt(suspectResult.suspectTimerExpiresAtMs, 0),
        }
      : {
          failedAtMs: settledAtMs,
        }),
  };
  Object.assign(work, { suspectResult, applied, settledState });
}

function persistSuspectReceipt(ports, work) {
  const {
    getActivePocketStateByInstanceID,
    updatePocketState,
    ensureAbyssalPocketPersistenceReady,
    getActiveTraceState,
    finalizeAbyssalReturnedTracePostCommitEffects,
  } = ports;
  const {
    source,
    deps,
    sourceIsPocketOwner,
    claimedPocketState,
    settledState,
    applied,
    traceItemID,
  } = work;
  let settledPocketState = null;
  if (toInt(source.instanceID, 0) > 0) {
    const activePocketState = getActivePocketStateByInstanceID(
      toInt(source.instanceID, 0),
    );
    settledPocketState = activePocketState &&
      toInt(activePocketState.characterID, 0) === toInt(source.characterID, 0)
      ? updatePocketState(toInt(source.instanceID, 0), {
          suspectReturnState: settledState,
        })
      : activePocketState;
  }
  const traceSettleResult = persistAbyssalSuspectReturnTraceState(ports,
    sourceIsPocketOwner
      ? settledPocketState || claimedPocketState || source
      : source,
    settledState,
    deps,
  );
  const pocketSettleResult = sourceIsPocketOwner && settledPocketState
  ? ensureAbyssalPocketPersistenceReady(settledPocketState, deps)
  : { success: true, skipped: true };
  let traceFinalizeResult = { success: true, skipped: true };
  if (applied && traceSettleResult.success) {
    const settledTraceState = traceSettleResult.state ||
      getActiveTraceState(traceItemID, deps);
    if (settledTraceState) {
      traceFinalizeResult = finalizeAbyssalReturnedTracePostCommitEffects(
        settledTraceState,
        deps,
      );
    }
  }
  Object.assign(work, { settledPocketState, traceSettleResult, pocketSettleResult, traceFinalizeResult });
}

function finishSuspectSettlement(ports, work) {
  const {
    source,
    session,
    sourceIsPocketOwner,
    settledPocketState,
    claimedPocketState,
    suspectResult,
    settledState,
    applied,
    traceSettleResult,
    pocketSettleResult,
    traceFinalizeResult,
  } = work;
  recordAndLogAbyssalSuspectReturnOutcome(ports,
    sourceIsPocketOwner
      ? settledPocketState || claimedPocketState || source
      : source,
    suspectResult,
    settledState,
    session,
  );
  return {
    success:
      applied &&
      traceSettleResult.success &&
      pocketSettleResult.success &&
      traceFinalizeResult.success !== false,
    applied,
    errorMsg: applied
      ? (
          !traceSettleResult.success
            ? normalizeText(traceSettleResult.errorMsg, "ABYSSAL_SUSPECT_RETURN_TRACE_RECEIPT_PERSIST_FAILED")
            : !pocketSettleResult.success
              ? "ABYSSAL_SUSPECT_RETURN_RECEIPT_PERSIST_FAILED"
              : traceFinalizeResult.success === false
                ? normalizeText(
                    traceFinalizeResult.errorMsg,
                    "ABYSSAL_SUSPECT_RETURN_TRACE_FINALIZE_FAILED",
                  )
              : ""
        )
      : normalizeText(suspectResult && suspectResult.reason, "SUSPECT_APPLY_FAILED"),
    suspectResult,
    state: settledState,
    pocketState: settledPocketState,
    traceSettleResult,
    pocketSettleResult,
    traceFinalizeResult,
  };
}

function createAbyssalSuspectEffects(ports) {
  return {
    buildAbyssalSuspectFlagResult: buildAbyssalSuspectFlagResult.bind(null, ports),
    getAbyssalSuspectTimerExpiresAtMs: getAbyssalSuspectTimerExpiresAtMs.bind(null, ports),
    applyAbyssalSuspectFlagIfRequired: applyAbyssalSuspectFlagIfRequired.bind(null, ports),
    recordAndLogAbyssalSuspectFlagOutcome: recordAndLogAbyssalSuspectFlagOutcome.bind(null, ports),
    isAbyssalSuspectReturnPending: isAbyssalSuspectReturnPending.bind(null, ports),
    buildAbyssalSuspectReturnValidation: buildAbyssalSuspectReturnValidation.bind(null, ports),
    persistAbyssalSuspectReturnTraceState: persistAbyssalSuspectReturnTraceState.bind(null, ports),
    recordAndLogAbyssalSuspectReturnOutcome: recordAndLogAbyssalSuspectReturnOutcome.bind(null, ports),
    doesCrimewatchStateSatisfyPersistedAbyssalSuspectReturn: doesCrimewatchStateSatisfyPersistedAbyssalSuspectReturn.bind(null, ports),
    settleAbyssalSuspectOnReturn: settleAbyssalSuspectOnReturn.bind(null, ports),
    settlePendingAbyssalSuspectReturnForSession: settlePendingAbyssalSuspectReturnForSession.bind(null, ports),
  };
}

module.exports = { createAbyssalSuspectEffects };
