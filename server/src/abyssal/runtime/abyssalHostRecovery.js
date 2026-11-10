"use strict";

const { normalizeText } = require("../domain/abyssalValueUtils");

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

// Login reconciliation and explicit rescue retain the central origin/host policies.
// Emergency destinations are never promoted into authoritative return origins.
function resolveOrphanedHostReturnTarget({
  getDependencies,
  findAbyssalRecoveryTombstone,
  getObjectPosition,
  resolveAuthoritativeRecoveryOrigin,
  resolveEmergencyRecoveryDecision,
  SAFE_FALLBACK_SOLAR_SYSTEM_ID,
}, session, context, deps = getDependencies()) {
  const tombstone = findAbyssalRecoveryTombstone({
    characterID: context.characterID,
    shipID: context.shipID,
    hostLocationID: context.systemID,
  });
  const tombstoneSystemID = toInt(tombstone && tombstone.sourceSolarSystemID, 0);
  const priorEmergencyDestinationSystemID =
    tombstone && tombstone.originResolved === false
      ? toInt(tombstone.destinationSolarSystemID, 0)
      : 0;
  const policyInput = {
    tombstoneCandidate: tombstone
      ? {
          present: true,
          originResolved: tombstone.originResolved,
          systemID: tombstoneSystemID,
          position: getObjectPosition(tombstone.returnPosition),
        }
      : null,
    previousEmergencyDestinationSystemID: priorEmergencyDestinationSystemID,
  };
  let authoritativeDecision = resolveAuthoritativeRecoveryOrigin(policyInput);

  if (authoritativeDecision.originResolved !== true) {
    const characterRecord =
      deps && typeof deps.getCharacterRecord === "function"
        ? deps.getCharacterRecord(context.characterID)
        : null;
    policyInput.characterCandidate = characterRecord
      ? {
          present: true,
          systemID: toInt(characterRecord.solarSystemID, 0),
          position: { x: 0, y: 0, z: 0 },
        }
      : null;
    authoritativeDecision = resolveAuthoritativeRecoveryOrigin(policyInput);
  }

  if (authoritativeDecision.originResolved !== true) {
    const shipItem =
      context.shipID > 0 && deps && typeof deps.findItemById === "function"
        ? deps.findItemById(context.shipID)
        : null;
    policyInput.shipCandidate = shipItem
      ? {
          present: true,
          systemID: toInt(
            shipItem.spaceState && shipItem.spaceState.systemID,
            toInt(shipItem.locationID, 0),
          ),
          position: getObjectPosition(shipItem.spaceState),
        }
      : null;
    authoritativeDecision = resolveAuthoritativeRecoveryOrigin(policyInput);
  }

  if (authoritativeDecision.originResolved === true) {
    return {
      ...authoritativeDecision,
      tombstone: tombstone || null,
    };
  }

  const emergencyDecision = resolveEmergencyRecoveryDecision({
    authoritativeDecision,
    previousEmergencyDestination: {
      systemID: priorEmergencyDestinationSystemID,
      position: getObjectPosition(tombstone && tombstone.returnPosition),
    },
    emergencyFallback: {
      systemID: SAFE_FALLBACK_SOLAR_SYSTEM_ID,
      position: { x: 0, y: 0, z: 0 },
    },
  });
  return {
    ...emergencyDecision,
    tombstone: tombstone || null,
  };
}

function formatAbyssalRecoveryOriginAttempts({
  normalizeAbyssalRecoveryOriginAttempts,
}, attempts) {
  return normalizeAbyssalRecoveryOriginAttempts(attempts)
    .map((attempt) =>
      `${attempt.source}:${attempt.status}:${toInt(attempt.systemID, 0) || "none"}`
    )
    .join(",");
}

function recoverOrphanedAbyssalHostSession({
  getDependencies,
  resolveOrphanedHostReturnTarget,
  getObjectPosition,
  log,
  formatAbyssalRecoveryOriginAttempts,
  evacuateAbyssalRunSession,
  cloneValue,
}, session, context, deps = getDependencies(), reason = "ORPHANED_HOST") {
  const target = resolveOrphanedHostReturnTarget(session, context, deps);
  const shipID = toInt(context.shipID, 0);
  const characterID = toInt(context.characterID, 0);
  const returnSpaceState = {
    systemID: toInt(target.systemID, 0),
    position: getObjectPosition(target.position) || { x: 0, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    direction: { x: 1, y: 0, z: 0 },
    targetPoint: getObjectPosition(target.position) || { x: 0, y: 0, z: 0 },
    mode: "STOP",
    speedFraction: 0,
  };
  const syntheticPocketState = {
    instanceID: toInt(target.tombstone && target.tombstone.runID, 0),
    characterID,
    shipID,
    solarSystemID: toInt(context.systemID, 0),
    traceItemID: toInt(target.tombstone && target.tombstone.traceID, 0),
    sourceSolarSystemID: target.originResolved === true
      ? returnSpaceState.systemID
      : null,
    sourceTracePosition: returnSpaceState.position,
    sourceShipPosition: returnSpaceState.position,
    sourceShipDirection: returnSpaceState.direction,
  };
  if (target.originResolved !== true) {
    log.warn(
      `[AbyssalRecovery] origin unresolved run=${toInt(target.tombstone && target.tombstone.runID, 0)} ` +
        `trace=${toInt(target.tombstone && target.tombstone.traceID, 0)} ` +
        `character=${characterID} ship=${shipID} host=${toInt(context.systemID, 0)} ` +
        `attempts=${formatAbyssalRecoveryOriginAttempts(target.originAuthorityAttempts) || "none"} ` +
        `emergencyFallback=true destination=${returnSpaceState.systemID}`,
    );
  }
  log.warn(
    `[AbyssalRecovery] orphaned host evacuation begin char=${characterID} ship=${shipID} ` +
      `location=${context.systemID} returnSystem=${returnSpaceState.systemID} source=${target.source} ` +
      `originResolved=${target.originResolved === true}`,
  );
  const evacuationResult = evacuateAbyssalRunSession(
    session,
    syntheticPocketState,
    reason,
    deps,
    {
      cleanupRun: false,
      syntheticOrphanRecovery: true,
      returnSpaceStateOverride: returnSpaceState,
      tombstoneState: "orphaned-host",
      hostLocationID: context.systemID,
      recoveryOriginResolved: target.originResolved === true,
      originResolutionReason: target.originResolutionReason,
      recoveryTargetSource: target.source,
      originAuthorityAttempts: target.originAuthorityAttempts,
    },
  );
  log.warn(
    `[AbyssalRecovery] orphaned host evacuation complete char=${characterID} ship=${shipID} ` +
      `location=${context.systemID} returnSystem=${returnSpaceState.systemID} ` +
      `success=${Boolean(evacuationResult && evacuationResult.success === true)} ` +
      `reason=${evacuationResult && evacuationResult.errorMsg || reason}`,
  );
  return {
    recovered: false,
    evacuated: Boolean(evacuationResult && evacuationResult.evacuated === true),
    orphanedHost: true,
    reason: evacuationResult && evacuationResult.success === true
      ? "ORPHANED_HOST_EVACUATED"
      : evacuationResult && evacuationResult.errorMsg || "ORPHANED_HOST_EVACUATION_FAILED",
    returnSystemID: returnSpaceState.systemID,
    source: target.source,
    originResolved: target.originResolved === true,
    originResolutionState: target.originResolved === true ? "resolved" : "unresolved",
    originResolutionReason: target.originResolutionReason,
    emergencyFallbackSelected: target.emergencyFallbackSelected === true,
    originAuthorityAttempts: cloneValue(target.originAuthorityAttempts),
  };
}

function resolveCharacterSpaceLocationBeforeLogin({
  getDependencies,
  isAbyssalHostLocationID,
  prepareStartupRecoveryBarrier,
  cloneValue,
  classifyAbyssalHostLocation,
  getActivePocketStateForCharacterID,
  syncExpiredAbyssalPocketState,
  recoverOrphanedAbyssalHostSession,
}, options = {}, deps = getDependencies()) {
  const characterID = toInt(options.characterID, 0);
  const characterRecord =
    options.characterRecord && typeof options.characterRecord === "object"
      ? options.characterRecord
      : (
          deps && typeof deps.getCharacterRecord === "function"
            ? deps.getCharacterRecord(characterID)
            : null
        );
  const shipID = toInt(
    options.shipID,
    toInt(
      characterRecord && (
        characterRecord.shipID ||
        characterRecord.activeShipID ||
        characterRecord.activeShipId
      ),
      0,
    ),
  );
  const shipItem =
    options.shipItem && typeof options.shipItem === "object"
      ? options.shipItem
      : (shipID > 0 && deps && typeof deps.findItemById === "function"
          ? deps.findItemById(shipID)
          : null);
  const characterSystemID = toInt(characterRecord && characterRecord.solarSystemID, 0);
  const shipSystemID = toInt(
    shipItem && shipItem.spaceState && shipItem.spaceState.systemID,
    toInt(shipItem && shipItem.locationID, 0),
  );
  const requestedSystemID = toInt(options.systemID, 0);
  const hostLocationID = [
    requestedSystemID,
    characterSystemID,
    shipSystemID,
  ].find((candidate) => isAbyssalHostLocationID(candidate));

  if (characterID <= 0) {
    return {
      success: false,
      reason: "CHARACTER_ID_REQUIRED",
    };
  }
  const startupRecovery = prepareStartupRecoveryBarrier(
    normalizeText(options.reason, "character-select"),
    {
      characterID,
      systemID: requestedSystemID || characterSystemID || shipSystemID,
    },
    deps,
  );
  if (startupRecovery && startupRecovery.blocksSession === true) {
    return {
      success: false,
      action: "recovery-pending",
      reason: "ABYSSAL_PERSISTED_RUN_RECOVERY_FAILED",
      failedInstanceIDs: cloneValue(startupRecovery.failedInstanceIDs) || [],
    };
  }
  if (!hostLocationID) {
    return {
      success: true,
      action: "none",
      classification: classifyAbyssalHostLocation(characterSystemID, {
        activeRun: false,
      }).kind,
      characterRecord,
      shipItem,
      systemID: characterSystemID || requestedSystemID || shipSystemID,
    };
  }

  const rawActivePocketState = getActivePocketStateForCharacterID(characterID);
  const activePocketState = rawActivePocketState
    ? syncExpiredAbyssalPocketState(rawActivePocketState, null, deps)
    : null;
  if (activePocketState) {
    return {
      success: true,
      action: "active-run",
      classification: classifyAbyssalHostLocation(hostLocationID, {
        activeRun: true,
      }).kind,
      activeRun: true,
      hostLocationID,
      instanceID: toInt(activePocketState.instanceID, 0),
      pocketState: activePocketState,
      characterRecord,
      shipItem,
      systemID: hostLocationID,
    };
  }

  const context = {
    characterID,
    shipID,
    systemID: hostLocationID,
    corporationID: toInt(characterRecord && characterRecord.corporationID, 0),
    fleetID: 0,
    instanceID: 0,
  };
  const recoveryResult = recoverOrphanedAbyssalHostSession(
    null,
    context,
    deps,
    normalizeText(options.reason, "CHARACTER_SELECT_ORPHANED_HOST"),
  );
  const updatedCharacterRecord =
    deps && typeof deps.getCharacterRecord === "function"
      ? deps.getCharacterRecord(characterID)
      : characterRecord;
  const updatedShipItem =
    shipID > 0 && deps && typeof deps.findItemById === "function"
      ? deps.findItemById(shipID)
      : shipItem;
  const updatedSystemID = toInt(
    updatedCharacterRecord && updatedCharacterRecord.solarSystemID,
    toInt(
      updatedShipItem && updatedShipItem.spaceState && updatedShipItem.spaceState.systemID,
      toInt(recoveryResult && recoveryResult.returnSystemID, 0),
    ),
  );

  return {
    success: Boolean(recoveryResult && recoveryResult.evacuated === true),
    action: "evacuated-orphan",
    classification: "orphaned-host",
    orphanedHost: true,
    evacuated: Boolean(recoveryResult && recoveryResult.evacuated === true),
    reason: recoveryResult && recoveryResult.reason || "ORPHANED_HOST_EVACUATION_FAILED",
    sourceSystemID: hostLocationID,
    returnSystemID: updatedSystemID,
    characterRecord: updatedCharacterRecord,
    shipItem: updatedShipItem,
    result: recoveryResult,
  };
}

function validateInitialCharacterSelectionAbyssalLocation({
  getDependencies,
  isAbyssalHostLocationID,
  getCharacterID,
  getActivePocketStateForCharacterID,
  log,
}, session, notificationPlan, deps = getDependencies()) {
  const sessionChanges = notificationPlan && notificationPlan.sessionChanges;
  if (!session || !sessionChanges) {
    return {
      success: true,
      skipped: true,
      reason: "NO_SESSION_PLAN",
    };
  }
  const plannedSystemID = toInt(
    sessionChanges.solarsystemid2 && sessionChanges.solarsystemid2[1],
    toInt(
      sessionChanges.solarsystemid && sessionChanges.solarsystemid[1],
      toInt(session.solarsystemid2 || session.solarsystemid, 0),
    ),
  );
  if (!isAbyssalHostLocationID(plannedSystemID)) {
    return {
      success: true,
      plannedSystemID,
      classification: "normal",
    };
  }

  const characterID = getCharacterID(session);
  const activePocketState = getActivePocketStateForCharacterID(characterID);
  if (activePocketState) {
    return {
      success: true,
      plannedSystemID,
      classification: "active-abyssal",
      instanceID: toInt(activePocketState.instanceID, 0),
    };
  }

  log.warn(
    `[AbyssalRecovery] blocked orphaned host initial SessionChange ` +
      `char=${characterID} location=${plannedSystemID}`,
  );
  return {
    success: false,
    plannedSystemID,
    classification: "orphaned-host",
    reason: "ORPHANED_HOST_INITIAL_SESSION_CHANGE",
  };
}

function rescueAbyssalSession({
  getDependencies,
  getSessionContext,
  getActivePocketStateForCharacterID,
  evaluateAbyssalDirectCallbackTerminalGuard,
  buildAbyssalDirectCallbackSuppressedResult,
  moveOtherAbyssalParticipantsOutOfRun,
  evacuateAbyssalRunSession,
  isAbyssalHostLocationID,
  recoverOrphanedAbyssalHostSession,
}, session, reason = "manual-rescue", deps = getDependencies()) {
  const context = getSessionContext(session);
  const pocketState = getActivePocketStateForCharacterID(context.characterID);
  if (pocketState) {
    const terminalGuard = evaluateAbyssalDirectCallbackTerminalGuard(
      pocketState,
      "administrative-rescue",
    );
    if (terminalGuard.blocked) {
      return {
        rescued: false,
        runFound: true,
        suppressed: true,
        terminal: true,
        reason: "ABYSSAL_RUN_TERMINALLY_SETTLED",
        guardReason: terminalGuard.reason,
        from: toInt(pocketState.solarSystemID, 0),
        to: toInt(pocketState.solarSystemID, 0),
        result: buildAbyssalDirectCallbackSuppressedResult(terminalGuard),
      };
    }
    const groupEvacuationResult = moveOtherAbyssalParticipantsOutOfRun(
      pocketState,
      session,
      deps,
      { reason: normalizeText(reason, "manual-rescue") },
    );
    if (!groupEvacuationResult || groupEvacuationResult.success !== true) {
      return {
        rescued: false,
        runFound: true,
        reason: normalizeText(
          groupEvacuationResult && groupEvacuationResult.errorMsg,
          "ACTIVE_RUN_GROUP_EVACUATION_FAILED",
        ),
        from: toInt(pocketState.solarSystemID, 0),
        to: 0,
        result: groupEvacuationResult,
      };
    }
    const result = evacuateAbyssalRunSession(
      session,
      groupEvacuationResult.pocketState || pocketState,
      reason,
      deps,
    );
    return {
      rescued: Boolean(result && result.evacuated === true),
      runFound: true,
      reason: result && result.success === true ? "ACTIVE_RUN_EVACUATED" : result && result.errorMsg || "ACTIVE_RUN_EVACUATION_FAILED",
      from: toInt(pocketState.solarSystemID, 0),
      to: toInt(result && result.returnSystemID, 0),
      result,
    };
  }
  if (isAbyssalHostLocationID(context.systemID, deps)) {
    const result = recoverOrphanedAbyssalHostSession(session, context, deps, reason);
    return {
      rescued: Boolean(result && result.evacuated === true),
      runFound: false,
      reason: result && result.reason || "ORPHANED_HOST_EVACUATION_FAILED",
      from: context.systemID,
      to: toInt(result && result.returnSystemID, 0),
      result,
    };
  }
  return {
    rescued: false,
    runFound: false,
    reason: "NO_ACTIVE_ABYSSAL_RUN",
    from: context.systemID,
    to: context.systemID,
  };
}

function abortAbyssalRunForAdministrativeTransition({
  getDependencies,
  getSessionContext,
  getActivePocketStateForCharacterID,
  evaluateAbyssalDirectCallbackTerminalGuard,
  buildAbyssalDirectCallbackSuppressedResult,
  recordAbyssalRunOutcome,
  moveOtherAbyssalParticipantsOutOfRun,
  evacuateAbyssalRunSession,
  cleanupAbyssalRun,
},
  session,
  reason = "admin-aborted",
  deps = getDependencies(),
) {
  const context = getSessionContext(session);
  const pocketState = getActivePocketStateForCharacterID(context.characterID);
  if (!pocketState) {
    return {
      success: true,
      aborted: false,
      reason: "NO_ACTIVE_ABYSSAL_RUN",
    };
  }
  const terminalGuard = evaluateAbyssalDirectCallbackTerminalGuard(
    pocketState,
    "administrative-abort",
  );
  if (terminalGuard.blocked) {
    return {
      success: true,
      aborted: false,
      suppressed: true,
      terminal: true,
      reason: "ABYSSAL_RUN_TERMINALLY_SETTLED",
      guardReason: terminalGuard.reason,
      result: buildAbyssalDirectCallbackSuppressedResult(terminalGuard),
    };
  }
  let outcomeState = recordAbyssalRunOutcome(pocketState, "admin_aborted", deps, {
    reason: normalizeText(reason, "admin-aborted"),
  }) || pocketState;
  const groupEvacuationResult = moveOtherAbyssalParticipantsOutOfRun(
    outcomeState,
    session,
    deps,
    { reason: normalizeText(reason, "admin-aborted") },
  );
  if (!groupEvacuationResult || groupEvacuationResult.success !== true) {
    return {
      success: false,
      aborted: true,
      errorMsg: normalizeText(
        groupEvacuationResult && groupEvacuationResult.errorMsg,
        "ABYSSAL_ADMIN_GROUP_EVACUATION_FAILED",
      ),
      groupEvacuationResult,
    };
  }
  outcomeState = groupEvacuationResult.pocketState || outcomeState;
  const result = evacuateAbyssalRunSession(
    session,
    outcomeState,
    normalizeText(reason, "admin-aborted"),
    deps,
    {
      tombstoneState: "admin_aborted",
    },
  );
  if (!result || result.success !== true) {
    cleanupAbyssalRun(outcomeState, deps, {
      reason: normalizeText(reason, "admin-aborted"),
      session,
    });
    return {
      success: false,
      aborted: true,
      errorMsg: result && result.errorMsg || "ABYSSAL_ADMIN_ABORT_FAILED",
      result,
    };
  }
  return {
    success: true,
    aborted: true,
    result,
  };
}

// Capture supplied capabilities once, as the original closure did. Internal
// callbacks are bound once per instance; no runtime state lives in this wiring.
function createAbyssalHostRecovery({
  getDependencies,
  findAbyssalRecoveryTombstone,
  getObjectPosition,
  resolveAuthoritativeRecoveryOrigin,
  resolveEmergencyRecoveryDecision,
  SAFE_FALLBACK_SOLAR_SYSTEM_ID,
  normalizeAbyssalRecoveryOriginAttempts,
  log,
  evacuateAbyssalRunSession,
  cloneValue,
  isAbyssalHostLocationID,
  prepareStartupRecoveryBarrier,
  classifyAbyssalHostLocation,
  getActivePocketStateForCharacterID,
  syncExpiredAbyssalPocketState,
  getCharacterID,
  getSessionContext,
  evaluateAbyssalDirectCallbackTerminalGuard,
  buildAbyssalDirectCallbackSuppressedResult,
  moveOtherAbyssalParticipantsOutOfRun,
  recordAbyssalRunOutcome,
  cleanupAbyssalRun,
}) {

  const ports = {
    getDependencies,
    findAbyssalRecoveryTombstone,
    getObjectPosition,
    resolveAuthoritativeRecoveryOrigin,
    resolveEmergencyRecoveryDecision,
    SAFE_FALLBACK_SOLAR_SYSTEM_ID,
    normalizeAbyssalRecoveryOriginAttempts,
    log,
    evacuateAbyssalRunSession,
    cloneValue,
    isAbyssalHostLocationID,
    prepareStartupRecoveryBarrier,
    classifyAbyssalHostLocation,
    getActivePocketStateForCharacterID,
    syncExpiredAbyssalPocketState,
    getCharacterID,
    getSessionContext,
    evaluateAbyssalDirectCallbackTerminalGuard,
    buildAbyssalDirectCallbackSuppressedResult,
    moveOtherAbyssalParticipantsOutOfRun,
    recordAbyssalRunOutcome,
    cleanupAbyssalRun,
  };
  ports.resolveOrphanedHostReturnTarget = resolveOrphanedHostReturnTarget.bind(null, ports);
  ports.formatAbyssalRecoveryOriginAttempts = formatAbyssalRecoveryOriginAttempts.bind(null, ports);
  ports.recoverOrphanedAbyssalHostSession = recoverOrphanedAbyssalHostSession.bind(null, ports);
  ports.resolveCharacterSpaceLocationBeforeLogin = resolveCharacterSpaceLocationBeforeLogin.bind(null, ports);
  ports.validateInitialCharacterSelectionAbyssalLocation = validateInitialCharacterSelectionAbyssalLocation.bind(null, ports);
  ports.rescueAbyssalSession = rescueAbyssalSession.bind(null, ports);
  ports.abortAbyssalRunForAdministrativeTransition = abortAbyssalRunForAdministrativeTransition.bind(null, ports);
  Object.freeze(ports);
  return {
    resolveOrphanedHostReturnTarget: ports.resolveOrphanedHostReturnTarget,
    formatAbyssalRecoveryOriginAttempts: ports.formatAbyssalRecoveryOriginAttempts,
    recoverOrphanedAbyssalHostSession: ports.recoverOrphanedAbyssalHostSession,
    resolveCharacterSpaceLocationBeforeLogin: ports.resolveCharacterSpaceLocationBeforeLogin,
    validateInitialCharacterSelectionAbyssalLocation: ports.validateInitialCharacterSelectionAbyssalLocation,
    rescueAbyssalSession: ports.rescueAbyssalSession,
    abortAbyssalRunForAdministrativeTransition: ports.abortAbyssalRunForAdministrativeTransition,
  };
}

module.exports = { createAbyssalHostRecovery };
