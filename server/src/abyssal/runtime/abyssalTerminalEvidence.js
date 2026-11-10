"use strict";

const crypto = require("node:crypto");
const { normalizeText } = require("../domain/abyssalValueUtils");

// Terminal evidence retains existing transition policies and durable commit authority.
function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function evaluateAbyssalDirectCallbackTerminalGuard(ports,
  pocketState,
  callbackName,
  options = {},
) {
  const {
    getActivePocketStateByInstanceID,
    normalizeAbyssalRunOutcome,
    evaluateAbyssalTerminalOperationGuard,
    log,
    recordAuditEvent,
  } = ports;
  const instanceID = toInt(pocketState && pocketState.instanceID, 0);
  const currentPocketState =
    instanceID > 0
      ? getActivePocketStateByInstanceID(instanceID) || pocketState
      : pocketState || null;
  const outcome = normalizeAbyssalRunOutcome(
    currentPocketState && currentPocketState.runOutcome,
  );
  const pendingTerminalCleanup = Boolean(
    currentPocketState && hasPendingAbyssalTerminalCleanup(ports, currentPocketState),
  );
  const gameplayAuthorityDetached = Boolean(
    currentPocketState && currentPocketState.gameplayAuthorityDetached === true,
  );
  const terminalDecision = evaluateAbyssalTerminalOperationGuard({
    currentOutcome: outcome,
    allowedTerminalOutcomes: options.allowedTerminalOutcomes,
    pendingTerminalCleanup,
    allowPendingTerminalCleanup: options.allowPendingTerminalCleanup === true,
    gameplayAuthorityDetached,
    allowDetachedGameplayAuthority:
      options.allowDetachedGameplayAuthority === true,
  });
  const { blocked, reason } = terminalDecision;

  const guard = {
    blocked,
    reason,
    callbackName: normalizeText(callbackName, "unknown-direct-callback"),
    outcome,
    instanceID,
    characterID: toInt(currentPocketState && currentPocketState.characterID, 0),
    shipID: toInt(currentPocketState && currentPocketState.shipID, 0),
    traceItemID: toInt(currentPocketState && currentPocketState.traceItemID, 0),
    pocketState: currentPocketState,
  };

  if (blocked) {
    log.info(
      `[AbyssalMgr] terminal direct callback suppressed ` +
        `callback=${guard.callbackName} instance=${guard.instanceID} ` +
        `character=${guard.characterID} ship=${guard.shipID} ` +
        `trace=${guard.traceItemID} outcome=${normalizeText(outcome, "active")} ` +
        `reason=${reason}`,
    );
    recordAuditEvent(
      "abyssal_terminal_direct_callback_suppressed",
      [],
      null,
      {
        callbackName: guard.callbackName,
        instanceID: guard.instanceID,
        characterID: guard.characterID,
        shipID: guard.shipID,
        traceItemID: guard.traceItemID,
        outcome,
        reason,
      },
    );
  }

  return guard;
}

function buildAbyssalDirectCallbackSuppressedResult(ports,
  guard,
  overrides = {},
) {
  const {
    normalizeAbyssalRunOutcome,
    resolveAbyssalTerminalCallbackReason,
    cloneValue,
  } = ports;
  return {
    success: true,
    handled: overrides.handled === undefined ? true : overrides.handled === true,
    suppressed: true,
    terminal: true,
    pending: false,
    reason: resolveAbyssalTerminalCallbackReason(guard && guard.outcome),
    guardReason: normalizeText(
      guard && guard.reason,
      "IMMUTABLE_TERMINAL_OUTCOME",
    ),
    callbackName: normalizeText(
      guard && guard.callbackName,
      "unknown-direct-callback",
    ),
    runOutcome: normalizeAbyssalRunOutcome(guard && guard.outcome),
    instanceID: toInt(guard && guard.instanceID, 0),
    itemID: toInt(overrides.itemID, 0),
    roomIndex: toInt(overrides.roomIndex, 0),
    data: guard && guard.pocketState || null,
    ...cloneValue(overrides.extra || {}),
  };
}

function logRejectedAbyssalRunOutcomeTransition(ports,
  pocketState,
  transition,
  details = {},
) {
  const {
    log,
    recordAuditEvent,
  } = ports;
  const instanceID = toInt(pocketState && pocketState.instanceID, 0);
  const characterID = toInt(pocketState && pocketState.characterID, 0);
  const traceItemID = toInt(pocketState && pocketState.traceItemID, 0);
  const current = normalizeText(transition && transition.current, "active");
  const requested = normalizeText(transition && transition.requested, "active");
  const reason = normalizeText(
    transition && transition.reason,
    "RUN_OUTCOME_TRANSITION_REJECTED",
  );

  log.warn(
    `[AbyssalMgr] rejected run outcome transition ` +
      `char=${characterID} instance=${instanceID} trace=${traceItemID} ` +
      `current=${current} requested=${requested} reason=${reason}`,
  );
  recordAuditEvent(
    "abyssal_run_outcome_transition_rejected",
    [],
    null,
    {
      instanceID,
      characterID,
      traceItemID,
      currentOutcome: transition && transition.current || "",
      requestedOutcome: transition && transition.requested || "",
      reason,
      requestReason: normalizeText(details && details.reason, ""),
    },
  );
}

function getAbyssalRewardArtifactDestructionOperations(ports, pocketState) {
  const {
    normalizeAbyssalRewardArtifactDestructionOperation,
  } = ports;
  const raw = pocketState && pocketState.rewardArtifactDestructionOperationsByItemID;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const normalized = {};
  for (const [key, value] of Object.entries(raw)) {
    const operation = normalizeAbyssalRewardArtifactDestructionOperation(value);
    const sourceItemID = toInt(
      operation && operation.sourceStructureItemID,
      toInt(key, 0),
    );
    if (operation && sourceItemID > 0) {
      normalized[String(sourceItemID)] = operation;
    }
  }
  return normalized;
}

function getAbyssalRewardArtifactDestructionOperation(ports, pocketState, sourceItemID) {
  const numericSourceItemID = toInt(sourceItemID, 0);
  if (numericSourceItemID <= 0) {
    return null;
  }
  return getAbyssalRewardArtifactDestructionOperations(ports, pocketState)[
    String(numericSourceItemID)
  ] || null;
}

function buildAbyssalRewardArtifactDestructionOperationID(ports, identity = {}) {
  const {
    normalizeLowerText,
  } = ports;
  const material = [
    "abyssal-reward-artifact-destruction-v1",
    toInt(identity.runID, 0),
    toInt(identity.roomIndex, 0),
    toInt(identity.sourceStructureItemID, 0),
    toInt(identity.sourceStructureTypeID, 0),
    normalizeLowerText(identity.artifactKind, ""),
  ].join(":");
  return crypto.createHash("sha256").update(material).digest("hex");
}

function buildAbyssalRewardArtifactDestructionOperationPatch(ports,
  pocketState,
  operation,
) {
  const {
    normalizeAbyssalRewardArtifactDestructionOperation,
  } = ports;
  const normalized = normalizeAbyssalRewardArtifactDestructionOperation(
    operation,
  );
  if (!normalized) return {};
  const operations = getAbyssalRewardArtifactDestructionOperations(ports, pocketState);
  operations[String(normalized.sourceStructureItemID)] = normalized;
  return { rewardArtifactDestructionOperationsByItemID: operations };
}

function mergeProtectedAbyssalRewardArtifactDestructionOperations(ports,
  previousState,
  requestedState,
) {
  const {
    log,
    cloneValue,
    evaluateAbyssalRewardArtifactDestructionOperationTransition,
  } = ports;
  const previous = getAbyssalRewardArtifactDestructionOperations(ports, previousState);
  const requested = getAbyssalRewardArtifactDestructionOperations(ports, requestedState);
  const merged = {};
  const keys = new Set([...Object.keys(previous), ...Object.keys(requested)]);
  for (const key of keys) {
    const transition = evaluateAbyssalRewardArtifactDestructionOperationTransition(
      previous[key],
      requested[key],
    );
    if (!transition.allowed) {
      log.warn(
        `[AbyssalRewardArtifact] rejected operation transition ` +
          `run=${toInt(previousState && previousState.instanceID, 0)} ` +
          `source=${toInt(key, 0)} reason=${transition.reason}`,
      );
      if (previous[key]) merged[key] = cloneValue(previous[key]);
      continue;
    }
    const selected = requested[key] || previous[key];
    if (selected) {
      merged[key] = transition.idempotent && previous[key]
        ? {
            ...cloneValue(selected),
            claimCommittedAtMs: toInt(
              previous[key].claimCommittedAtMs,
              selected.claimCommittedAtMs,
            ),
            sourceDestroyedAtMs: toInt(
              previous[key].sourceDestroyedAtMs,
              selected.sourceDestroyedAtMs,
            ),
            rewardCompletedAtMs: toInt(
              previous[key].rewardCompletedAtMs,
              selected.rewardCompletedAtMs,
            ),
            receipt: cloneValue(previous[key].receipt) || cloneValue(selected.receipt),
          }
        : cloneValue(selected);
    }
  }
  return merged;
}

function getAbyssalParticipantDestructionOperationsByCharacterID(ports, pocketState) {
  const {
    normalizeAbyssalParticipantDestructionOperation,
  } = ports;
  const operations = {};
  const rawMap = pocketState &&
    pocketState.participantDestructionOperationsByCharacterID &&
    typeof pocketState.participantDestructionOperationsByCharacterID === "object" &&
    !Array.isArray(pocketState.participantDestructionOperationsByCharacterID)
    ? pocketState.participantDestructionOperationsByCharacterID
    : {};
  for (const rawOperation of Object.values(rawMap)) {
    const operation = normalizeAbyssalParticipantDestructionOperation(rawOperation);
    if (operation && operation.characterID > 0) {
      operations[String(operation.characterID)] = operation;
    }
  }
  const legacyOperation = normalizeAbyssalParticipantDestructionOperation(
    pocketState && pocketState.participantDestructionOperation,
  );
  if (
    legacyOperation &&
    legacyOperation.characterID > 0 &&
    !operations[String(legacyOperation.characterID)]
  ) {
    operations[String(legacyOperation.characterID)] = legacyOperation;
  }
  return operations;
}

function getAbyssalParticipantDestructionOperation(ports, pocketState, characterID = 0) {
  const requestedCharacterID = toInt(characterID, 0);
  const numericCharacterID = requestedCharacterID > 0
    ? requestedCharacterID
    : toInt(pocketState && pocketState.characterID, 0);
  return getAbyssalParticipantDestructionOperationsByCharacterID(ports, pocketState)[
    String(numericCharacterID)
  ] || null;
}

function buildAbyssalParticipantDestructionOperationPatch(ports, pocketState, operation) {
  const {
    normalizeAbyssalParticipantDestructionOperation,
    ABYSSAL_PARTICIPANT_DESTRUCTION_MAP_SCHEMA_VERSION,
  } = ports;
  const normalized = normalizeAbyssalParticipantDestructionOperation(operation);
  if (!normalized || normalized.characterID <= 0) {
    return {};
  }
  const operationsByCharacterID =
    getAbyssalParticipantDestructionOperationsByCharacterID(ports, pocketState);
  operationsByCharacterID[String(normalized.characterID)] = normalized;
  const patch = {
    participantDestructionOperationsSchemaVersion:
      ABYSSAL_PARTICIPANT_DESTRUCTION_MAP_SCHEMA_VERSION,
    participantDestructionOperationsByCharacterID: operationsByCharacterID,
  };
  if (normalized.characterID === toInt(pocketState && pocketState.characterID, 0)) {
    patch.participantDestructionOperation = normalized;
  }
  return patch;
}

function buildAbyssalParticipantDestructionOperationID(ports, identity = {}) {
  const {
    normalizeAbyssalRunOutcome,
  } = ports;
  const payload = [
    "abyssal-participant-destruction-v1",
    toInt(identity.runID, 0),
    toInt(identity.characterID, 0),
    toInt(identity.originalShipID, 0),
    toInt(identity.capsuleID, 0),
    normalizeAbyssalRunOutcome(identity.terminalCause),
    normalizeText(identity.identityMode, "exact_capsule"),
  ].join(":");
  return crypto.createHash("sha256").update(payload).digest("hex");
}

function buildAbyssalParticipantHullDestructionIntent(ports,
  pocketState,
  participant,
  nowMs,
  options = {},
) {
  const {
    normalizeAbyssalRunOutcome,
    normalizeAbyssalParticipantDestructionOperation,
    ABYSSAL_PARTICIPANT_DESTRUCTION_OPERATION_SCHEMA_VERSION,
    ABYSSAL_PARTICIPANT_DESTRUCTION_OPERATION_STATUS,
    buildPlaceholderRoomState,
  } = ports;
  const terminalCause = normalizeAbyssalRunOutcome(
    options.terminalCause || pocketState && pocketState.runOutcome,
  );
  const identity = {
    runID: toInt(pocketState && pocketState.instanceID, 0),
    characterID: toInt(participant && participant.characterID, 0),
    originalShipID: toInt(participant && participant.shipID, 0),
    capsuleID: 0,
    terminalCause,
    identityMode: "participant_hull_and_capsule",
  };
  return normalizeAbyssalParticipantDestructionOperation({
    schemaVersion: ABYSSAL_PARTICIPANT_DESTRUCTION_OPERATION_SCHEMA_VERSION,
    operationID: buildAbyssalParticipantDestructionOperationID(ports, identity),
    status: ABYSSAL_PARTICIPANT_DESTRUCTION_OPERATION_STATUS.HULL_INTENT_COMMITTED,
    ...identity,
    roomIndex: buildPlaceholderRoomState(pocketState).currentRoomIndex,
    sceneKey: normalizeText(
      pocketState && pocketState.sceneKey,
      `abyssal-run:${identity.runID}`,
    ),
    intentSource: normalizeText(options.intentSource, "abyssal-manager"),
    hullIntentCommittedAtMs: Math.max(0, toInt(nowMs, Date.now())),
    lastAttemptAtMs: Math.max(0, toInt(nowMs, Date.now())),
    hullAttemptCount: 0,
  });
}

function buildAbyssalParticipantDestructionIntent(ports,
  pocketState,
  capsuleID,
  nowMs,
  options = {},
) {
  const {
    normalizeAbyssalRunOutcome,
    normalizeAbyssalParticipantDestructionOperation,
    ABYSSAL_PARTICIPANT_DESTRUCTION_OPERATION_SCHEMA_VERSION,
    ABYSSAL_PARTICIPANT_DESTRUCTION_OPERATION_STATUS,
    buildPlaceholderRoomState,
  } = ports;
  const terminalCause = normalizeAbyssalRunOutcome(
    options.terminalCause || pocketState && pocketState.runOutcome,
  );
  const roomIndex = buildPlaceholderRoomState(pocketState).currentRoomIndex;
  const identityMode = normalizeText(options.identityMode, "exact_capsule");
  const identity = {
    runID: toInt(pocketState && pocketState.instanceID, 0),
    characterID: toInt(pocketState && pocketState.characterID, 0),
    originalShipID: toInt(pocketState && pocketState.shipID, 0),
    capsuleID: toInt(capsuleID, 0),
    terminalCause,
    identityMode,
  };
  return normalizeAbyssalParticipantDestructionOperation({
    schemaVersion: ABYSSAL_PARTICIPANT_DESTRUCTION_OPERATION_SCHEMA_VERSION,
    operationID: buildAbyssalParticipantDestructionOperationID(ports, identity),
    status: ABYSSAL_PARTICIPANT_DESTRUCTION_OPERATION_STATUS.INTENT_COMMITTED,
    ...identity,
    roomIndex,
    sceneKey: normalizeText(
      pocketState && pocketState.sceneKey,
      `abyssal-run:${identity.runID}`,
    ),
    intentSource: normalizeText(options.intentSource, "abyssal-manager"),
    intentCommittedAtMs: Math.max(0, toInt(nowMs, Date.now())),
    podDestroyedAtMs: 0,
    lastAttemptAtMs: Math.max(0, toInt(nowMs, Date.now())),
    attemptCount: 0,
    failureReason: "",
    receipt: null,
  });
}

function logRejectedAbyssalParticipantDestructionTransition(ports,
  pocketState,
  transition,
) {
  const {
    log,
    recordAuditEvent,
  } = ports;
  const current = transition && transition.current;
  const requested = transition && transition.requested;
  log.error(
    `[AbyssalPodDestruction] rejected operation transition ` +
      `run=${toInt(pocketState && pocketState.instanceID, 0)} ` +
      `character=${toInt(pocketState && pocketState.characterID, 0)} ` +
      `currentOperation=${normalizeText(current && current.operationID, "none")} ` +
      `currentStatus=${normalizeText(current && current.status, "none")} ` +
      `requestedOperation=${normalizeText(requested && requested.operationID, "none")} ` +
      `requestedStatus=${normalizeText(requested && requested.status, "none")} ` +
      `reason=${normalizeText(
        transition && transition.reason,
        "DESTRUCTION_OPERATION_TRANSITION_REJECTED",
      )}`,
  );
  recordAuditEvent(
    "abyssal_participant_destruction_transition_rejected",
    [],
    null,
    {
      instanceID: toInt(pocketState && pocketState.instanceID, 0),
      characterID: toInt(pocketState && pocketState.characterID, 0),
      currentOperationID: normalizeText(current && current.operationID, ""),
      currentStatus: normalizeText(current && current.status, ""),
      requestedOperationID: normalizeText(requested && requested.operationID, ""),
      requestedStatus: normalizeText(requested && requested.status, ""),
      reason: normalizeText(
        transition && transition.reason,
        "DESTRUCTION_OPERATION_TRANSITION_REJECTED",
      ),
    },
  );
}

function buildAbyssalParticipantTerminalProjection(ports, pocketState, participant) {
  const {
    cloneValue,
  } = ports;
  return {
    ...cloneValue(pocketState),
    characterID: toInt(participant && participant.characterID, 0),
    shipID: toInt(participant && participant.shipID, 0),
    shipTypeID: toInt(
      participant && participant.shipTypeID,
      toInt(pocketState && pocketState.shipTypeID, 0),
    ),
  };
}

function recordAbyssalRunOutcome(ports,
  pocketState,
  outcome,
  deps = ports.getDependencies(),
  details = {},
) {
  const {
    normalizeAbyssalRunOutcome,
    log,
    cloneValue,
    refreshAbyssalDungeonTrackingState,
    commitRunOutcome,
  } = ports;
  const numericInstanceID = toInt(pocketState && pocketState.instanceID, 0);
  const normalizedOutcome = normalizeAbyssalRunOutcome(outcome);
  if (numericInstanceID <= 0) {
    return pocketState || null;
  }

  const outcomeCommit =
    commitRunOutcome({
      instanceID: numericInstanceID,
      currentState: cloneValue(pocketState),
      requestedOutcome: normalizedOutcome,
      outcomePatch: () => ({
        runOutcome: normalizedOutcome,
        runOutcomeAtMs: toInt(
          deps && typeof deps.now === "function" ? deps.now() : Date.now(),
          Date.now(),
        ),
        runOutcomeDetails: cloneValue(details),
      }),
    });
  const effectivePocketState = outcomeCommit.state;
  const transition = outcomeCommit.transition;

  if (!outcomeCommit.committed) {
    logRejectedAbyssalRunOutcomeTransition(ports,
      effectivePocketState,
      transition,
      details,
    );
    return effectivePocketState;
  }

  if (!outcomeCommit.changed) {
    return effectivePocketState;
  }

  log.info(
    `[AbyssalMgr] Abyssal run outcome char=${effectivePocketState.characterID} ` +
      `instance=${effectivePocketState.instanceID} trace=${effectivePocketState.traceItemID} ` +
      `previous=${normalizeText(transition.current, "active")} ` +
      `state=${normalizedOutcome} objectiveComplete=${effectivePocketState.objectiveComplete === true} ` +
      `timerExpired=${Boolean(effectivePocketState.timerState && effectivePocketState.timerState.expired)} ` +
      `reason=${normalizeText(details.reason, "n/a")}`,
  );
  refreshAbyssalDungeonTrackingState(
    effectivePocketState,
    deps,
    `run_${normalizedOutcome}`,
  );
  return effectivePocketState;
}

function getAbyssalTerminalCleanupState(ports, pocketState) {
  const {
    cloneValue,
  } = ports;
  return pocketState &&
    pocketState.terminalCleanupState &&
    typeof pocketState.terminalCleanupState === "object"
    ? cloneValue(pocketState.terminalCleanupState)
    : null;
}

function hasPendingAbyssalTerminalCleanup(ports, pocketState) {
  const {
    normalizeLowerText,
  } = ports;
  return normalizeLowerText(
    getAbyssalTerminalCleanupState(ports, pocketState) &&
      getAbyssalTerminalCleanupState(ports, pocketState).status,
    "",
  ) === "pending";
}

function shouldDeferAbyssalWeatherRemovalMaintenanceRetry(ports,
  pocketState,
  nowMs,
  deps = ports.getDependencies(),
) {
  const {
    normalizeLowerText,
    getAbyssalWeatherRemovalState,
    isExactAbyssalWeatherRemovalClaim,
    ABYSSAL_WEATHER_REMOVAL_MAX_ATTEMPTS,
    ABYSSAL_WEATHER_REMOVAL_MAX_PENDING_MS,
    resolveAbyssalWeatherRemovalRuntimeSession,
  } = ports;
  const terminalCleanupState = getAbyssalTerminalCleanupState(ports, pocketState) || {};
  const weatherRemovalState = getAbyssalWeatherRemovalState(pocketState) || {};
  const firstPendingAtMs = toInt(weatherRemovalState.firstPendingAtMs, 0);
  const attemptCount = Math.max(0, toInt(weatherRemovalState.attemptCount, 0));
  const pendingMs = Math.max(0, toInt(nowMs, Date.now()) - firstPendingAtMs);
  if (
    normalizeText(terminalCleanupState.failureReason, "") !==
      "ABYSSAL_WEATHER_REMOVAL_PENDING" ||
    normalizeLowerText(weatherRemovalState.status, "") !== "pending" ||
    normalizeText(weatherRemovalState.failureReason, "") !==
      "NO_EXACT_KSPACE_RUNTIME_SHIP" ||
    !isExactAbyssalWeatherRemovalClaim(pocketState, weatherRemovalState) ||
    firstPendingAtMs <= 0 ||
    attemptCount >= ABYSSAL_WEATHER_REMOVAL_MAX_ATTEMPTS ||
    pendingMs >= ABYSSAL_WEATHER_REMOVAL_MAX_PENDING_MS
  ) {
    return false;
  }

  // Replaying the entire terminal cleanup cannot make progress while the exact
  // returned ship has no runtime entity. A relog recovery retries directly, and
  // maintenance resumes as soon as that entity appears or the bounded pending
  // window expires.
  return !resolveAbyssalWeatherRemovalRuntimeSession(pocketState, null, deps);
}

function resolveAbyssalRecoveryCleanupReason(ports,
  pocketState,
  fallback = "relog-terminal-cleanup",
) {
  const terminalCleanupState = getAbyssalTerminalCleanupState(ports, pocketState) || {};
  if (normalizeText(terminalCleanupState.reason, "")) {
    return normalizeText(terminalCleanupState.reason, fallback);
  }
  if (pocketState && pocketState.committedExitState) {
    return "final-exit";
  }
  return normalizeText(
    pocketState && pocketState.committedEvacuationState &&
      pocketState.committedEvacuationState.reason,
    fallback,
  );
}

function hasDurableAbyssalParticipantPodDestructionReceipt(ports, pocketState) {
  const {
    ABYSSAL_PARTICIPANT_DESTRUCTION_OPERATION_STATUS,
  } = ports;
  const operation = getAbyssalParticipantDestructionOperation(ports, pocketState);
  return Boolean(
    operation &&
    operation.status ===
      ABYSSAL_PARTICIPANT_DESTRUCTION_OPERATION_STATUS.POD_DESTROYED
  );
}

function requiresAbyssalParticipantDestructionReceiptForCleanup(ports,
  pocketState,
  deps = ports.getDependencies(),
) {
  const {
    normalizeAbyssalRunOutcome,
    getAbyssalTimeoutState,
    ABYSSAL_RUN_OUTCOME,
  } = ports;
  const outcome = normalizeAbyssalRunOutcome(
    pocketState && pocketState.runOutcome,
  );
  const timeoutState = getAbyssalTimeoutState(pocketState, deps);
  return Boolean(
    [
      ABYSSAL_RUN_OUTCOME.FAILED_TIMEOUT,
      ABYSSAL_RUN_OUTCOME.FAILED_SHIP_DESTROYED,
    ].includes(outcome) &&
    timeoutState.shipDestroyed === true
  );
}

function createAbyssalTerminalEvidence(ports) {
  return {
    evaluateAbyssalDirectCallbackTerminalGuard: evaluateAbyssalDirectCallbackTerminalGuard.bind(null, ports),
    buildAbyssalDirectCallbackSuppressedResult: buildAbyssalDirectCallbackSuppressedResult.bind(null, ports),
    logRejectedAbyssalRunOutcomeTransition: logRejectedAbyssalRunOutcomeTransition.bind(null, ports),
    getAbyssalRewardArtifactDestructionOperations: getAbyssalRewardArtifactDestructionOperations.bind(null, ports),
    getAbyssalRewardArtifactDestructionOperation: getAbyssalRewardArtifactDestructionOperation.bind(null, ports),
    buildAbyssalRewardArtifactDestructionOperationID: buildAbyssalRewardArtifactDestructionOperationID.bind(null, ports),
    buildAbyssalRewardArtifactDestructionOperationPatch: buildAbyssalRewardArtifactDestructionOperationPatch.bind(null, ports),
    mergeProtectedAbyssalRewardArtifactDestructionOperations: mergeProtectedAbyssalRewardArtifactDestructionOperations.bind(null, ports),
    getAbyssalParticipantDestructionOperationsByCharacterID: getAbyssalParticipantDestructionOperationsByCharacterID.bind(null, ports),
    getAbyssalParticipantDestructionOperation: getAbyssalParticipantDestructionOperation.bind(null, ports),
    buildAbyssalParticipantDestructionOperationPatch: buildAbyssalParticipantDestructionOperationPatch.bind(null, ports),
    buildAbyssalParticipantDestructionOperationID: buildAbyssalParticipantDestructionOperationID.bind(null, ports),
    buildAbyssalParticipantHullDestructionIntent: buildAbyssalParticipantHullDestructionIntent.bind(null, ports),
    buildAbyssalParticipantDestructionIntent: buildAbyssalParticipantDestructionIntent.bind(null, ports),
    logRejectedAbyssalParticipantDestructionTransition: logRejectedAbyssalParticipantDestructionTransition.bind(null, ports),
    buildAbyssalParticipantTerminalProjection: buildAbyssalParticipantTerminalProjection.bind(null, ports),
    recordAbyssalRunOutcome: recordAbyssalRunOutcome.bind(null, ports),
    getAbyssalTerminalCleanupState: getAbyssalTerminalCleanupState.bind(null, ports),
    hasPendingAbyssalTerminalCleanup: hasPendingAbyssalTerminalCleanup.bind(null, ports),
    shouldDeferAbyssalWeatherRemovalMaintenanceRetry: shouldDeferAbyssalWeatherRemovalMaintenanceRetry.bind(null, ports),
    resolveAbyssalRecoveryCleanupReason: resolveAbyssalRecoveryCleanupReason.bind(null, ports),
    hasDurableAbyssalParticipantPodDestructionReceipt: hasDurableAbyssalParticipantPodDestructionReceipt.bind(null, ports),
    requiresAbyssalParticipantDestructionReceiptForCleanup: requiresAbyssalParticipantDestructionReceiptForCleanup.bind(null, ports),
  };
}

module.exports = { createAbyssalTerminalEvidence };
