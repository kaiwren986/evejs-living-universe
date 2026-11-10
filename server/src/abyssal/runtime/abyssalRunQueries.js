"use strict";

// Stateless operations using existing authoritative identity and persistence capabilities.
function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function getActiveTraceStateForCharacterID(ports, characterID, deps = ports.getDependencies()) {
  const {
    getActiveTraceState,
    getTraceIDForCharacter,
  } = ports;
  const numericCharacterID = toInt(characterID, 0);
  if (numericCharacterID <= 0) {
    return null;
  }
  const traceItemID = getTraceIDForCharacter(numericCharacterID) || 0;
  return traceItemID > 0 ? getActiveTraceState(traceItemID, deps) : null;
}

function getActivePocketStateForCharacterID(ports, characterID) {
  const {
    getRunByParticipantCharacterID,
  } = ports;
  const numericCharacterID = toInt(characterID, 0);
  if (numericCharacterID <= 0) {
    return null;
  }
  const registeredState = getRunByParticipantCharacterID(
    numericCharacterID,
  );
  const pocketState = registeredState
    ? getActivePocketStateByInstanceID(ports, registeredState.instanceID)
    : null;
  return pocketState && pocketState.gameplayAuthorityDetached !== true ? pocketState : null;
}

function hasUnresolvedAbyssalRecoveryObligation(ports,
  pocketState,
  characterID = 0,
) {
  const {
    getAbyssalParticipantRecord,
    hasPendingAbyssalTerminalCleanup,
    normalizeLowerText,
    getAbyssalWeatherRemovalState,
    getAbyssalParticipantDestructionOperation,
    ABYSSAL_PARTICIPANT_DESTRUCTION_OPERATION_STATUS,
    hasTerminalFailureOutcome,
    isTerminalParticipantStatus,
  } = ports;
  if (!pocketState || typeof pocketState !== "object") {
    return false;
  }
  const numericCharacterID = toInt(characterID, 0);
  const participant = numericCharacterID > 0
    ? getAbyssalParticipantRecord(pocketState, numericCharacterID)
    : null;
  if (numericCharacterID > 0 && !participant) {
    return false;
  }
  const participantTerminal = Boolean(
    participant && isTerminalParticipantStatus(participant.status),
  );
  const obligationMatchesCharacter = (obligation) => {
    const obligationCharacterID = toInt(
      obligation && obligation.characterID,
      0,
    );
    return numericCharacterID <= 0 ||
      obligationCharacterID <= 0 ||
      obligationCharacterID === numericCharacterID;
  };
  const entryRecoveryPending = Boolean(
    pocketState.entryRecoveryState &&
    pocketState.entryRecoveryState.pending === true &&
    !participantTerminal,
  );
  const terminalCleanupPending = Boolean(
    hasPendingAbyssalTerminalCleanup(pocketState) &&
    !participantTerminal,
  );
  const committedExitState = pocketState.committedExitState &&
    typeof pocketState.committedExitState === "object"
    ? pocketState.committedExitState
    : null;
  const committedExitInFlight = Boolean(
    committedExitState &&
    normalizeLowerText(committedExitState.status, "") !== "completed",
  );
  const weatherRemovalState = getAbyssalWeatherRemovalState(pocketState) || {};
  const weatherRemovalPending = Boolean(
    normalizeLowerText(weatherRemovalState.status, "") === "pending" &&
    obligationMatchesCharacter(weatherRemovalState) &&
    !committedExitInFlight,
  );
  const committedEvacuationState = pocketState.committedEvacuationState &&
    typeof pocketState.committedEvacuationState === "object"
    ? pocketState.committedEvacuationState
    : null;
  const committedEvacuationPending = Boolean(
    committedEvacuationState &&
    normalizeLowerText(committedEvacuationState.status, "") !== "completed" &&
    obligationMatchesCharacter(committedEvacuationState),
  );
  const participantDestructionOperation = numericCharacterID > 0
    ? getAbyssalParticipantDestructionOperation(pocketState, numericCharacterID)
    : null;
  const participantDestructionPending = Boolean(
    participantDestructionOperation &&
    participantDestructionOperation.status !==
      ABYSSAL_PARTICIPANT_DESTRUCTION_OPERATION_STATUS.POD_DESTROYED,
  );

  const terminalFailurePending = Boolean(
    hasTerminalFailureOutcome(pocketState) &&
    !participantTerminal,
  );

  return entryRecoveryPending ||
    terminalCleanupPending ||
    weatherRemovalPending ||
    committedEvacuationPending ||
    participantDestructionPending ||
    terminalFailurePending;
}

function getRecoverablePocketStateForCharacterID(ports, characterID) {
  const {
    listActiveRuns,
  } = ports;
  const numericCharacterID = toInt(characterID, 0);
  if (numericCharacterID <= 0) {
    return null;
  }
  for (const pocketState of listActiveRuns()) {
    if (
      hasUnresolvedAbyssalRecoveryObligation(ports,
        pocketState,
        numericCharacterID,
      )
    ) {
      return getActivePocketStateByInstanceID(ports, pocketState.instanceID);
    }
  }
  return null;
}

function getActivePocketStateForShipID(ports, shipID) {
  const {
    normalizeAbyssalParticipantRoster,
    isAbyssalParticipantIndexed,
    cloneValue,
    listActiveRuns,
  } = ports;
  const numericShipID = toInt(shipID, 0);
  if (numericShipID <= 0) {
    return null;
  }

  for (const pocketState of listActiveRuns()) {
    if (
      pocketState.gameplayAuthorityDetached !== true &&
      normalizeAbyssalParticipantRoster(pocketState).some((participant) =>
        isAbyssalParticipantIndexed(participant) &&
        participant.shipID === numericShipID
      )
    ) {
      return cloneValue(pocketState);
    }
  }

  return null;
}

function getActiveAbyssalRunForCharacterID(ports, characterID) {
  return getActivePocketStateForCharacterID(ports, characterID);
}

function getActiveAbyssalRunForShipID(ports, shipID) {
  return getActivePocketStateForShipID(ports, shipID);
}

function getActiveAbyssalRunForCharacter(ports, characterID) {
  return getActiveAbyssalRunForCharacterID(ports, characterID);
}

function getActiveAbyssalRunForShip(ports, shipID) {
  return getActiveAbyssalRunForShipID(ports, shipID);
}

function isCharacterInActiveAbyssalRun(ports, characterID) {
  return Boolean(getActiveAbyssalRunForCharacterID(ports, characterID));
}

function isShipInActiveAbyssalRun(ports, shipID) {
  return Boolean(getActiveAbyssalRunForShipID(ports, shipID));
}

function getActivePocketStateByInstanceID(ports, instanceID) {
  const {
    cloneValue,
    getRunByInstanceID,
    hasMutationBatch,
  } = ports;
  const numericInstanceID = toInt(instanceID, 0);
  if (numericInstanceID <= 0) {
    return null;
  }
  const state = getRunByInstanceID(numericInstanceID);
  if (state && hasMutationBatch(numericInstanceID)) {
    return state;
  }
  return state ? cloneValue(state) : null;
}

function getActivePocketStateForSession(ports, session) {
  const {
    getCharacterID,
    getRunByParticipantCharacterID,
  } = ports;
  const explicitInstanceID = toInt(session && session.abyssalInstanceID, 0);
  if (explicitInstanceID > 0) {
    const explicitPocketState = getActivePocketStateByInstanceID(ports, explicitInstanceID);
    return explicitPocketState && explicitPocketState.gameplayAuthorityDetached !== true
      ? explicitPocketState
      : null;
  }
  const registeredState = getRunByParticipantCharacterID(
    getCharacterID(session),
  );
  const pocketState = registeredState
    ? getActivePocketStateByInstanceID(ports, registeredState.instanceID)
    : null;
  return pocketState && pocketState.gameplayAuthorityDetached !== true
    ? pocketState
    : null;
}

function getActivePocketStateByMarkerItemID(ports, markerItemID, deps = ports.getDependencies()) {
  const {
    cloneValue,
    readPocketMarkerStateFromItem,
    buildPocketSiteKey,
    buildPocketStateFromInstance,
    registerPocket,
    logRecoveredT0DarkLayoutSelection,
    logRecoveredAbyssalSceneMode,
    getRunByMarkerID,
  } = ports;
  const numericMarkerItemID = toInt(markerItemID, 0);
  if (numericMarkerItemID <= 0) {
    return null;
  }
  const cachedPocketState = getRunByMarkerID(
    numericMarkerItemID,
  );
  if (cachedPocketState) {
    return getActivePocketStateByInstanceID(ports, cachedPocketState.instanceID);
  }
  const markerItem = deps.findItemById(numericMarkerItemID);
  const markerState = readPocketMarkerStateFromItem(markerItem);
  if (!markerState || markerState.traceItemID <= 0) {
    return null;
  }
  const existingInstance = deps.dungeonRuntime.findInstanceBySiteKey(
    buildPocketSiteKey(markerState),
    {
      activeOnly: true,
      full: true,
    },
  );
  if (!existingInstance) {
    return null;
  }
  const resolvedPocketState = buildPocketStateFromInstance(existingInstance, markerState);
  const registeredPocketState = registerPocket(resolvedPocketState);
  if (!registeredPocketState) {
    return null;
  }
  logRecoveredT0DarkLayoutSelection(registeredPocketState);
  logRecoveredAbyssalSceneMode(registeredPocketState, deps);
  return cloneValue(registeredPocketState);
}

function createAbyssalRunQueries(ports) {
  return {
    getActiveTraceStateForCharacterID: getActiveTraceStateForCharacterID.bind(null, ports),
    getActivePocketStateForCharacterID: getActivePocketStateForCharacterID.bind(null, ports),
    hasUnresolvedAbyssalRecoveryObligation: hasUnresolvedAbyssalRecoveryObligation.bind(null, ports),
    getRecoverablePocketStateForCharacterID: getRecoverablePocketStateForCharacterID.bind(null, ports),
    getActivePocketStateForShipID: getActivePocketStateForShipID.bind(null, ports),
    getActiveAbyssalRunForCharacterID: getActiveAbyssalRunForCharacterID.bind(null, ports),
    getActiveAbyssalRunForShipID: getActiveAbyssalRunForShipID.bind(null, ports),
    getActiveAbyssalRunForCharacter: getActiveAbyssalRunForCharacter.bind(null, ports),
    getActiveAbyssalRunForShip: getActiveAbyssalRunForShip.bind(null, ports),
    isCharacterInActiveAbyssalRun: isCharacterInActiveAbyssalRun.bind(null, ports),
    isShipInActiveAbyssalRun: isShipInActiveAbyssalRun.bind(null, ports),
    getActivePocketStateByInstanceID: getActivePocketStateByInstanceID.bind(null, ports),
    getActivePocketStateForSession: getActivePocketStateForSession.bind(null, ports),
    getActivePocketStateByMarkerItemID: getActivePocketStateByMarkerItemID.bind(null, ports),
  };
}

module.exports = { createAbyssalRunQueries };
