"use strict";

// Stateless operations; ownership remains with the injected registry and persistence ports.
function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function getAbyssalParticipantReturnObligationsByCharacterID(ports, traceState) {
  const {
    cloneValue,
    ABYSSAL_PARTICIPANT_RETURN_OBLIGATION_SCHEMA_VERSION,
  } = ports;
  const obligations = {};
  const rawMap = traceState &&
    traceState.participantReturnObligationsByCharacterID &&
    typeof traceState.participantReturnObligationsByCharacterID === "object" &&
    !Array.isArray(traceState.participantReturnObligationsByCharacterID)
    ? traceState.participantReturnObligationsByCharacterID
    : {};
  for (const [key, rawEntry] of Object.entries(rawMap)) {
    const characterID = toInt(rawEntry && rawEntry.characterID, toInt(key, 0));
    if (characterID <= 0 || !rawEntry || typeof rawEntry !== "object") continue;
    obligations[String(characterID)] = {
      schemaVersion: ABYSSAL_PARTICIPANT_RETURN_OBLIGATION_SCHEMA_VERSION,
      ...cloneValue(rawEntry),
      characterID,
      shipID: toInt(rawEntry.shipID, 0),
      runID: toInt(rawEntry.runID, toInt(traceState && traceState.abyssalRunID, 0)),
      sourceSolarSystemID: toInt(
        rawEntry.sourceSolarSystemID,
        toInt(traceState && traceState.sourceSolarSystemID, 0),
      ),
    };
  }
  const ownerCharacterID = toInt(traceState && traceState.characterID, 0);
  if (ownerCharacterID > 0 && !obligations[String(ownerCharacterID)]) {
    obligations[String(ownerCharacterID)] = {
      schemaVersion: ABYSSAL_PARTICIPANT_RETURN_OBLIGATION_SCHEMA_VERSION,
      characterID: ownerCharacterID,
      shipID: toInt(traceState && traceState.shipID, 0),
      runID: toInt(traceState && traceState.abyssalRunID, 0),
      sourceSolarSystemID: toInt(traceState && traceState.sourceSolarSystemID, 0),
      suspectOnReturn: traceState && traceState.suspectOnReturn === true,
      returnProtectionState:
        traceState && traceState.returnProtectionState
          ? cloneValue(traceState.returnProtectionState)
          : null,
      suspectReturnState:
        traceState && traceState.suspectReturnState
          ? cloneValue(traceState.suspectReturnState)
          : null,
    };
  }
  return obligations;
}

function getAbyssalParticipantReturnObligation(ports, traceState, characterID) {
  return getAbyssalParticipantReturnObligationsByCharacterID(ports, traceState)[
    String(toInt(characterID, 0))
  ] || null;
}

function persistAbyssalParticipantReturnObligation(ports,
  source,
  obligationPatch,
  deps = ports.getDependencies(),
) {
  const {
    cloneValue,
    ABYSSAL_PARTICIPANT_RETURN_OBLIGATION_SCHEMA_VERSION,
    findAbyssalReturnProtectionTraceState,
    listUniquePositiveInts,
    persistTraceState,
  } = ports;
  const traceState = findAbyssalReturnProtectionTraceState(source, deps);
  if (!traceState) return { success: false, errorMsg: "TRACE_ITEM_MISSING" };
  const runID = toInt(source && source.instanceID, toInt(source && source.runID, 0));
  const traceRunID = toInt(traceState.abyssalRunID, 0);
  const characterID = toInt(
    obligationPatch && obligationPatch.characterID,
    toInt(source && source.characterID, 0),
  );
  const participantCharacterIDs = new Set(listUniquePositiveInts([
    traceState.characterID,
    ...(Array.isArray(traceState.participantCharacterIDs)
      ? traceState.participantCharacterIDs
      : []),
    ...(Array.isArray(traceState.participantRoster)
      ? traceState.participantRoster.map((participant) => participant.characterID)
      : []),
  ]));
  if (
    characterID <= 0 ||
    (runID > 0 && traceRunID > 0 && runID !== traceRunID) ||
    !participantCharacterIDs.has(characterID)
  ) {
    return { success: false, errorMsg: "TRACE_PARTICIPANT_OWNERSHIP_MISMATCH" };
  }
  const obligations = getAbyssalParticipantReturnObligationsByCharacterID(ports,
    traceState,
  );
  const existing = obligations[String(characterID)] || {};
  const obligation = {
    schemaVersion: ABYSSAL_PARTICIPANT_RETURN_OBLIGATION_SCHEMA_VERSION,
    ...cloneValue(existing),
    ...cloneValue(obligationPatch),
    characterID,
    shipID: toInt(
      obligationPatch && obligationPatch.shipID,
      toInt(source && source.shipID, toInt(existing.shipID, 0)),
    ),
    runID: traceRunID || runID,
    sourceSolarSystemID: toInt(
      obligationPatch && obligationPatch.sourceSolarSystemID,
      toInt(source && source.sourceSolarSystemID, toInt(existing.sourceSolarSystemID, 0)),
    ),
  };
  obligations[String(characterID)] = obligation;
  const ownerObligation = obligations[String(toInt(traceState.characterID, 0))] || null;
  const nextTraceState = {
    ...traceState,
    participantReturnObligationsSchemaVersion:
      ABYSSAL_PARTICIPANT_RETURN_OBLIGATION_SCHEMA_VERSION,
    participantReturnObligationsByCharacterID: obligations,
    ...(ownerObligation
      ? {
          returnProtectionState: cloneValue(ownerObligation.returnProtectionState),
          suspectReturnState: cloneValue(ownerObligation.suspectReturnState),
          suspectOnReturn: ownerObligation.suspectOnReturn === true,
        }
      : {}),
  };
  return persistTraceState(nextTraceState, deps);
}

function createAbyssalReturnObligations(ports) {
  return {
    getAbyssalParticipantReturnObligationsByCharacterID: getAbyssalParticipantReturnObligationsByCharacterID.bind(null, ports),
    getAbyssalParticipantReturnObligation: getAbyssalParticipantReturnObligation.bind(null, ports),
    persistAbyssalParticipantReturnObligation: persistAbyssalParticipantReturnObligation.bind(null, ports),
  };
}

module.exports = { createAbyssalReturnObligations };
