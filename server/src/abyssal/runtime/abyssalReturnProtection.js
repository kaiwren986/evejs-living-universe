"use strict";

const { normalizeText } = require("../domain/abyssalValueUtils");

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function resolveAbyssalReturnedTraceProtectionDeadlineMs(ports,
  source,
  nowMs,
) {
  const {
    getAbyssalParticipantReturnObligationsByCharacterID,
  } = ports;
  const now = toInt(nowMs, 0);
  const obligations = source &&
    source.participantReturnObligationsByCharacterID &&
    typeof source.participantReturnObligationsByCharacterID === "object"
    ? Object.values(getAbyssalParticipantReturnObligationsByCharacterID(source))
    : [{ returnProtectionState: source && source.returnProtectionState }];
  let deadlineMs = 0;
  for (const obligation of obligations) {
    const protectionState = obligation && obligation.returnProtectionState;
    const untilMs = toInt(protectionState && protectionState.untilMs, 0);
    if (protectionState && untilMs > now) {
      deadlineMs = Math.max(deadlineMs, untilMs);
    }
  }
  return deadlineMs;
}

function isAbyssalReturnProtectionPending(ports, source, nowMs = null, deps = ports.getDependencies()) {
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
    ).some((obligation) => {
      const protectionState = obligation.returnProtectionState;
      const status = normalizeLowerText(
        protectionState && protectionState.state,
        "pending",
      );
      const now = toInt(
        nowMs,
        deps && typeof deps.now === "function" ? deps.now() : Date.now(),
      );
      return Boolean(
        protectionState &&
        (status === "pending" || status === "applying") &&
        toInt(protectionState.untilMs, 0) > now,
      );
    });
  }
  const state = source && source.returnProtectionState;
  if (!state || typeof state !== "object") {
    return false;
  }
  const status = normalizeLowerText(state.state, "pending");
  const now = toInt(
    nowMs,
    deps && typeof deps.now === "function" ? deps.now() : Date.now(),
  );
  return Boolean(
    (status === "pending" || status === "applying") &&
    toInt(state.untilMs, 0) > now
  );
}

function findAbyssalReturnProtectionTraceState(ports, source, deps = ports.getDependencies()) {
  const {
    cloneValue,
    getTrace,
    readTraceStateFromItem,
  } = ports;
  const traceItemID = toInt(
    source && source.sourceTraceItemID,
    toInt(source && source.traceItemID, 0),
  );
  if (traceItemID <= 0) {
    return null;
  }
  return cloneValue(getTrace(traceItemID)) ||
    readTraceStateFromItem(
      deps && typeof deps.findItemById === "function"
        ? deps.findItemById(traceItemID)
        : null,
    );
}

function persistAbyssalReturnProtectionTraceState(ports,
  source,
  returnProtectionState,
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
      suspectOnReturn: source && source.suspectOnReturn === true,
      securityPolicy: cloneValue(source && source.securityPolicy),
      returnProtectionState: cloneValue(returnProtectionState),
      suspectReturnState: cloneValue(source && source.suspectReturnState),
    },
    deps,
  );
}

function stageAbyssalReturnProtectionObligation(ports,
  pocketState,
  deps = ports.getDependencies(),
) {
  const {
    normalizeLowerText,
    cloneValue,
    resolveConfiguredAbyssalReturnProtectionDurationMs,
    getAbyssalParticipantReturnObligation,
    normalizeAbyssalTraceLifecyclePhase,
    ABYSSAL_TRACE_LIFECYCLE_PHASE,
  } = ports;
  const durationMs = resolveConfiguredAbyssalReturnProtectionDurationMs(deps);
  if (!(durationMs > 0)) {
    return {
      success: true,
      skipped: true,
      reason: "ABYSSAL_RETURN_PROTECTION_DISABLED",
      state: { state: "not_required" },
    };
  }
  const traceState = findAbyssalReturnProtectionTraceState(ports, pocketState, deps);
  if (!traceState) {
    return {
      success: false,
      errorMsg: "ABYSSAL_RETURN_PROTECTION_TRACE_MISSING",
    };
  }
  const nowMs = toInt(deps.now(), Date.now());
  const runID = toInt(pocketState && pocketState.instanceID, 0);
  const characterID = toInt(pocketState && pocketState.characterID, 0);
  const shipID = toInt(pocketState && pocketState.shipID, 0);
  const traceItemID = toInt(traceState.traceItemID, 0);
  const priorObligation = getAbyssalParticipantReturnObligation(
    traceState,
    characterID,
  );
  const priorState = priorObligation && priorObligation.returnProtectionState &&
    typeof priorObligation.returnProtectionState === "object"
      ? cloneValue(priorObligation.returnProtectionState)
      : {};
  const traceAlreadyReturned = normalizeAbyssalTraceLifecyclePhase(traceState.lifecyclePhase) ===
    ABYSSAL_TRACE_LIFECYCLE_PHASE.RETURNED;
  const preservePriorDeadline = Boolean(
    traceAlreadyReturned &&
    toInt(priorState.untilMs, 0) > 0 &&
    normalizeText(priorState.idempotencyKey, "")
  );
  const obligationState = {
    ...priorState,
    schemaVersion: 1,
    state: normalizeLowerText(priorState.state, "") === "completed"
      ? "completed"
      : "pending",
    runID,
    characterID,
    shipID,
    traceItemID,
    idempotencyKey: normalizeText(
      priorState.idempotencyKey,
      `abyssal-return-protection:${runID}:${characterID}:${shipID}`,
    ),
    stagedAtMs: preservePriorDeadline
      ? toInt(priorState.stagedAtMs, nowMs)
      : nowMs,
    untilMs: preservePriorDeadline
      ? toInt(priorState.untilMs, nowMs + durationMs)
      : nowMs + durationMs,
    attemptCount: Math.max(0, toInt(priorState.attemptCount, 0)),
  };
  const persistResult = persistAbyssalReturnProtectionTraceState(ports,
    pocketState,
    obligationState,
    deps,
  );
  return persistResult && persistResult.success
    ? {
        success: true,
        state: obligationState,
        traceState: persistResult.state || findAbyssalReturnProtectionTraceState(ports, pocketState, deps),
      }
    : {
        success: false,
        errorMsg: normalizeText(
          persistResult && persistResult.errorMsg,
          "ABYSSAL_RETURN_PROTECTION_STAGE_PERSIST_FAILED",
        ),
      };
}

function finalizeAbyssalReturnedTracePostCommitEffects(ports,
  traceState,
  deps = ports.getDependencies(),
) {
  const {
    normalizeAbyssalTraceLifecyclePhase,
    ABYSSAL_TRACE_LIFECYCLE_PHASE,
    isAbyssalSuspectReturnPending,
    resolveAbyssalTraceProfile,
    scheduleSourceTraceRemoval,
    removeOwnedSourceTrace,
  } = ports;
  if (!traceState) {
    return { success: true, skipped: true, reason: "TRACE_ITEM_MISSING" };
  }
  if (
    normalizeAbyssalTraceLifecyclePhase(traceState.lifecyclePhase) !==
    ABYSSAL_TRACE_LIFECYCLE_PHASE.RETURNED
  ) {
    return { success: true, skipped: true, reason: "TRACE_NOT_RETURNED" };
  }
  if (
    isAbyssalReturnProtectionPending(ports, traceState, null, deps) ||
    isAbyssalSuspectReturnPending(traceState)
  ) {
    return { success: true, skipped: true, reason: "POST_COMMIT_EFFECT_PENDING" };
  }
  return resolveAbyssalTraceProfile(traceState)
    ? scheduleSourceTraceRemoval(traceState, deps, "post-return-effects-settled")
    : removeOwnedSourceTrace(traceState, deps, "post-return-effects-settled");
}

function settlePendingAbyssalReturnProtectionForSession(ports,
  session,
  deps = ports.getDependencies(),
) {
  const {
    normalizeLowerText,
    cloneValue,
    listTraces,
    readTraceStateFromItem,
    getAbyssalParticipantReturnObligation,
    normalizeAbyssalTraceLifecyclePhase,
    ABYSSAL_TRACE_LIFECYCLE_PHASE,
    getSessionContext,
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
    const protectionState = obligation && obligation.returnProtectionState;
    if (
      obligation &&
      toInt(obligation.sourceSolarSystemID, 0) === context.systemID &&
      normalizeAbyssalTraceLifecyclePhase(traceState.lifecyclePhase) ===
        ABYSSAL_TRACE_LIFECYCLE_PHASE.RETURNED &&
      protectionState &&
      ["pending", "applying"].includes(
        normalizeLowerText(protectionState.state, "pending"),
      )
    ) {
      pendingSource = {
        ...cloneValue(traceState),
        instanceID: toInt(obligation.runID, toInt(traceState.abyssalRunID, 0)),
        characterID: obligation.characterID,
        shipID: obligation.shipID,
        sourceSolarSystemID: obligation.sourceSolarSystemID,
        suspectOnReturn: obligation.suspectOnReturn === true,
        securityPolicy: cloneValue(obligation.securityPolicy || traceState.securityPolicy),
        returnProtectionState: cloneValue(protectionState),
        suspectReturnState: cloneValue(obligation.suspectReturnState),
      };
      break;
    }
  }
  return pendingSource
    ? settleAbyssalReturnProtectionObligation(ports, pendingSource, session, null, deps)
    : { success: true, skipped: true, reason: "NO_PENDING_RETURN_PROTECTION" };
}

function grantAbyssalReturnProtectionAfterAttach(ports,
  pocketState,
  session,
  attachedEntity,
  deps = ports.getDependencies(),
) {
  return settleAbyssalReturnProtectionObligation(ports,
    pocketState,
    session,
    attachedEntity,
    deps,
  );
}

// Claim before authority mutation; receipt persistence never extends the staged deadline.
function settleAbyssalReturnProtectionObligation(ports, source, session, attachedEntity = null, deps = ports.getDependencies()) {
  const work = { source, session, attachedEntity, deps };
  for (const settle of [inspectReturnProtectionClaim, expireReturnProtectionClaim,
    validateReturnProtectionAuthority, applyReturnProtectionClaim]) {
    const result = settle(ports, work);
    if (result) return result;
  }
  return completeReturnProtectionClaim(ports, work);
}

function inspectReturnProtectionClaim(ports, work) {
  const {
    normalizeLowerText,
    cloneValue,
    getAbyssalParticipantReturnObligation,
  } = ports;
  const {
    source,
    deps,
  } = work;
  const traceState = findAbyssalReturnProtectionTraceState(ports, source, deps);
  const sourceCharacterID = toInt(
    source && source.characterID,
    toInt(traceState && traceState.characterID, 0),
  );
  const participantObligation = getAbyssalParticipantReturnObligation(
    traceState,
    sourceCharacterID,
  );
  const priorState = participantObligation &&
  participantObligation.returnProtectionState;
  if (!traceState || !priorState || typeof priorState !== "object") {
    return {
      success: true,
      skipped: true,
      reason: "NO_PENDING_RETURN_PROTECTION",
    };
  }
  const obligationSource = {
    ...cloneValue(traceState),
    ...cloneValue(source),
    instanceID: toInt(
      participantObligation && participantObligation.runID,
      toInt(traceState.abyssalRunID, 0),
    ),
    characterID: sourceCharacterID,
    shipID: toInt(
      participantObligation && participantObligation.shipID,
      toInt(source && source.shipID, 0),
    ),
    sourceSolarSystemID: toInt(
      participantObligation && participantObligation.sourceSolarSystemID,
      toInt(source && source.sourceSolarSystemID, 0),
    ),
  };
  const priorStatus = normalizeLowerText(priorState.state, "pending");
  if (["completed", "expired", "not_required"].includes(priorStatus)) {
    return {
      success: true,
      skipped: true,
      duplicate: priorStatus === "completed",
      reason: `RETURN_PROTECTION_${priorStatus.toUpperCase()}`,
      state: cloneValue(priorState),
    };
  }
  Object.assign(work, { traceState, priorState, obligationSource });
}

function expireReturnProtectionClaim(ports, work) {
  const {
    cloneValue,
  } = ports;
  const {
    deps,
    priorState,
    obligationSource,
    traceState,
  } = work;
  const nowMs = toInt(deps.now(), Date.now());
  const untilMs = toInt(priorState.untilMs, 0);
  if (untilMs <= nowMs) {
    const expiredState = {
      ...cloneValue(priorState),
      state: "expired",
      completedAtMs: nowMs,
      lastResult: "RETURN_PROTECTION_DEADLINE_EXPIRED",
    };
    const expirePersistResult = persistAbyssalReturnProtectionTraceState(ports,
      obligationSource,
      expiredState,
      deps,
    );
    if (!expirePersistResult.success) {
      return {
        success: false,
        errorMsg: normalizeText(
          expirePersistResult.errorMsg,
          "ABYSSAL_RETURN_PROTECTION_EXPIRY_PERSIST_FAILED",
        ),
        state: expiredState,
      };
    }
    finalizeAbyssalReturnedTracePostCommitEffects(ports,
      expirePersistResult.state || { ...traceState, returnProtectionState: expiredState },
      deps,
    );
    return {
      success: true,
      skipped: true,
      expired: true,
      reason: "RETURN_PROTECTION_DEADLINE_EXPIRED",
      state: expiredState,
    };
  }
  Object.assign(work, { nowMs, untilMs });
}

function validateReturnProtectionAuthority(ports, work) {
  const {
    cloneValue,
    getCharacterID,
  } = ports;
  const {
    deps,
    priorState,
    traceState,
    session,
    attachedEntity,
  } = work;
  const expectedCharacterID = toInt(priorState.characterID, toInt(traceState.characterID, 0));
  const expectedShipID = toInt(priorState.shipID, toInt(traceState.shipID, 0));
  const sessionShipID = toInt(
    session && session._space && session._space.shipID,
    toInt(session && (session.shipID || session.shipid || session.activeShipID), 0),
  );
  if (
    !session ||
    getCharacterID(session) !== expectedCharacterID ||
    sessionShipID !== expectedShipID ||
    (attachedEntity && toInt(attachedEntity.itemID, 0) !== expectedShipID)
  ) {
    return {
      success: false,
      errorMsg: "ABYSSAL_RETURN_PROTECTION_AUTHORITY_UNREADY",
      state: cloneValue(priorState),
    };
  }
  const runtime = deps;
  if (!runtime || typeof runtime.grantTimedInvulnerabilityForSession !== "function") {
    return {
      success: false,
      errorMsg: "ABYSSAL_RETURN_PROTECTION_AUTHORITY_UNAVAILABLE",
    };
  }
  Object.assign(work, { expectedCharacterID, expectedShipID, runtime });
}

function applyReturnProtectionClaim(ports, work) {
  const {
    cloneValue,
  } = ports;
  const {
    deps,
    priorState,
    traceState,
    session,
    attachedEntity,
    obligationSource,
    nowMs,
    untilMs,
    expectedCharacterID,
    expectedShipID,
    runtime,
  } = work;
  const claimState = {
    ...cloneValue(priorState),
    state: "applying",
    lastAttemptAtMs: nowMs,
    attemptCount: Math.max(0, toInt(priorState.attemptCount, 0)) + 1,
  };
  const claimPersistResult = persistAbyssalReturnProtectionTraceState(ports,
    obligationSource,
    claimState,
    deps,
  );
  if (!claimPersistResult.success) {
    return {
      success: false,
      errorMsg: normalizeText(
        claimPersistResult.errorMsg,
        "ABYSSAL_RETURN_PROTECTION_CLAIM_PERSIST_FAILED",
      ),
      state: claimState,
    };
  }
  const entity = attachedEntity || (
    runtime.getSceneForSession && runtime.getSceneForSession(session) &&
    runtime.getSceneForSession(session).getShipEntityForSession
      ? runtime.getSceneForSession(session).getShipEntityForSession(session)
      : null
  );
  const grantResult = runtime.grantTimedInvulnerabilityForSession(session, {
    entity,
    shipID: expectedShipID,
    kind: "abyssal-return",
    durationMs: Math.max(0, untilMs - nowMs),
    runID: toInt(priorState.runID, toInt(traceState.abyssalRunID, 0)),
    characterID: expectedCharacterID,
    idempotencyKey: normalizeText(priorState.idempotencyKey, ""),
  });
  if (!grantResult || grantResult.success !== true) {
    const pendingState = {
      ...claimState,
      state: "pending",
      failedAtMs: nowMs,
      lastResult: normalizeText(
        grantResult && grantResult.errorMsg,
        "ABYSSAL_RETURN_PROTECTION_GRANT_FAILED",
      ),
    };
    persistAbyssalReturnProtectionTraceState(ports, obligationSource, pendingState, deps);
    return {
      success: false,
      errorMsg: pendingState.lastResult,
      state: pendingState,
      grantResult,
    };
  }
  Object.assign(work, { claimState, grantResult });
}

function completeReturnProtectionClaim(ports, work) {
  const {
    deps,
    priorState,
    traceState,
    obligationSource,
    nowMs,
    untilMs,
    claimState,
    grantResult,
  } = work;
  const completedState = {
    ...claimState,
    state: "completed",
    completedAtMs: toInt(deps.now(), nowMs),
    authorityReceiptKey: normalizeText(priorState.idempotencyKey, ""),
    grantedUntilMs: untilMs,
    lastResult: "RETURN_PROTECTION_GRANTED",
  };
  const completionPersistResult = persistAbyssalReturnProtectionTraceState(ports,
    obligationSource,
    completedState,
    deps,
  );
  if (!completionPersistResult.success) {
    return {
      success: false,
      errorMsg: normalizeText(
        completionPersistResult.errorMsg,
        "ABYSSAL_RETURN_PROTECTION_RECEIPT_PERSIST_FAILED",
      ),
      state: claimState,
      grantResult,
    };
  }
  finalizeAbyssalReturnedTracePostCommitEffects(ports,
    completionPersistResult.state || { ...traceState, returnProtectionState: completedState },
    deps,
  );
  return {
    success: true,
    state: completedState,
    grantResult,
    deadlineMs: untilMs,
    durationMs: Math.max(0, untilMs - nowMs),
  };
}

function createAbyssalReturnProtection(ports) {
  return {
    resolveAbyssalReturnedTraceProtectionDeadlineMs: resolveAbyssalReturnedTraceProtectionDeadlineMs.bind(null, ports),
    isAbyssalReturnProtectionPending: isAbyssalReturnProtectionPending.bind(null, ports),
    findAbyssalReturnProtectionTraceState: findAbyssalReturnProtectionTraceState.bind(null, ports),
    persistAbyssalReturnProtectionTraceState: persistAbyssalReturnProtectionTraceState.bind(null, ports),
    stageAbyssalReturnProtectionObligation: stageAbyssalReturnProtectionObligation.bind(null, ports),
    finalizeAbyssalReturnedTracePostCommitEffects: finalizeAbyssalReturnedTracePostCommitEffects.bind(null, ports),
    settleAbyssalReturnProtectionObligation: settleAbyssalReturnProtectionObligation.bind(null, ports),
    settlePendingAbyssalReturnProtectionForSession: settlePendingAbyssalReturnProtectionForSession.bind(null, ports),
    grantAbyssalReturnProtectionAfterAttach: grantAbyssalReturnProtectionAfterAttach.bind(null, ports),
  };
}

module.exports = { createAbyssalReturnProtection };
