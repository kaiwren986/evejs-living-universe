"use strict";

const { normalizeText } = require("../domain/abyssalValueUtils");

// Existing participant, controller and maintenance authorities remain injected.
function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function resolveAuthoritativeAbyssalFleetMembership(ports,
  context,
  deps = ports.getDependencies(),
) {
  const fleetID = toInt(context && context.fleetID, 0);
  const characterID = toInt(context && context.characterID, 0);
  if (fleetID <= 0 || characterID <= 0) {
    return {
      success: false,
      reason: "FLEET_REQUIRED_FOR_SHIP_CLASS",
      fleetID,
      characterID,
    };
  }
  const runtime = deps && deps.fleetRuntime;
  if (
    !runtime ||
    typeof runtime.getFleetByID !== "function" ||
    typeof runtime.getMemberRecord !== "function"
  ) {
    return {
      success: false,
      reason: "FLEET_AUTHORITY_UNAVAILABLE",
      fleetID,
      characterID,
    };
  }
  let fleet = null;
  let member = null;
  try {
    fleet = runtime.getFleetByID(fleetID) || null;
    member = fleet ? runtime.getMemberRecord(fleet, characterID) : null;
  } catch (error) {
    return {
      success: false,
      reason: "FLEET_AUTHORITY_UNAVAILABLE",
      fleetID,
      characterID,
      errorMsg: normalizeText(error && error.message, "FLEET_AUTHORITY_FAILED"),
    };
  }
  const authoritativeFleetID = toInt(
    fleet && (fleet.fleetID || fleet.fleetid),
    fleet ? fleetID : 0,
  );
  if (!fleet || !member || authoritativeFleetID !== fleetID) {
    return {
      success: false,
      reason: "FLEET_MEMBERSHIP_NOT_AUTHORITATIVE",
      fleetID,
      authoritativeFleetID,
      characterID,
    };
  }
  return {
    success: true,
    fleet,
    member,
    fleetID: authoritativeFleetID,
    characterID,
  };
}

function resolveCurrentAuthoritativeAbyssalFleetMembership(ports,
  characterID,
  deps = ports.getDependencies(),
) {
  const numericCharacterID = toInt(characterID, 0);
  const runtime = deps && deps.fleetRuntime;
  if (
    numericCharacterID <= 0 ||
    !runtime ||
    typeof runtime.getFleetForCharacter !== "function" ||
    typeof runtime.getMemberRecord !== "function"
  ) {
    return {
      success: false,
      reason: "FLEET_AUTHORITY_UNAVAILABLE",
      characterID: numericCharacterID,
      fleetID: 0,
    };
  }
  let fleet = null;
  let member = null;
  try {
    fleet = runtime.getFleetForCharacter(numericCharacterID) || null;
    member = fleet ? runtime.getMemberRecord(fleet, numericCharacterID) : null;
  } catch (error) {
    return {
      success: false,
      reason: "FLEET_AUTHORITY_UNAVAILABLE",
      characterID: numericCharacterID,
      fleetID: 0,
      errorMsg: normalizeText(error && error.message, "FLEET_AUTHORITY_FAILED"),
    };
  }
  const fleetID = toInt(fleet && (fleet.fleetID || fleet.fleetid), 0);
  const memberCharacterID = toInt(
    member && (member.charID || member.characterID || member.characterid),
    0,
  );
  if (
    !fleet ||
    !member ||
    fleetID <= 0 ||
    memberCharacterID !== numericCharacterID
  ) {
    return {
      success: false,
      reason: "FLEET_MEMBERSHIP_NOT_AUTHORITATIVE",
      characterID: numericCharacterID,
      fleetID,
      memberCharacterID,
    };
  }
  return {
    success: true,
    fleet,
    member,
    characterID: numericCharacterID,
    fleetID,
  };
}

function normalizeAbyssalParticipantStatus(ports, value, fallback = ports.ABYSSAL_PARTICIPANT_STATUS.RESERVED) {
  const {
    ABYSSAL_PARTICIPANT_STATUS,
    normalizeLowerText,
  } = ports;
  const normalized = normalizeLowerText(value, "");
  return Object.values(ABYSSAL_PARTICIPANT_STATUS).includes(normalized)
    ? normalized
    : fallback;
}

function normalizeAbyssalParticipantRecord(ports, record = {}, defaults = {}) {
  const {
    normalizeLowerText,
    ABYSSAL_PARTICIPANT_ROSTER_SCHEMA_VERSION,
    cloneValue,
    getObjectPosition,
    normalizeDirection,
    toReal,
  } = ports;
  const characterID = toInt(
    record.characterID || record.characterid || record.charID,
    toInt(defaults.characterID, 0),
  );
  if (characterID <= 0) return null;
  const role = characterID === toInt(defaults.ownerCharacterID, 0) ||
    normalizeLowerText(record.role, "") === "owner"
    ? "owner"
    : "member";
  return {
    schemaVersion: ABYSSAL_PARTICIPANT_ROSTER_SCHEMA_VERSION,
    characterID,
    shipID: toInt(record.shipID || record.shipid, toInt(defaults.shipID, 0)),
    shipTypeID: toInt(record.shipTypeID, toInt(defaults.shipTypeID, 0)),
    shipClass: normalizeText(record.shipClass, normalizeText(defaults.shipClass, "")),
    role,
    status: normalizeAbyssalParticipantStatus(ports,
      record.status,
      normalizeAbyssalParticipantStatus(ports, defaults.status),
    ),
    fleetID: toInt(record.fleetID, toInt(defaults.fleetID, 0)),
    admittedAtMs: toInt(record.admittedAtMs, toInt(defaults.admittedAtMs, 0)),
    lastSeenAtMs: toInt(record.lastSeenAtMs, toInt(defaults.lastSeenAtMs, 0)),
    disconnectedAtMs: toInt(record.disconnectedAtMs, 0),
    destroyedAtMs: toInt(record.destroyedAtMs, 0),
    exitedAtMs: toInt(record.exitedAtMs, 0),
    currentRoomIndex: Math.max(1, toInt(record.currentRoomIndex, toInt(defaults.currentRoomIndex, 1))),
    sourceSolarSystemID: toInt(
      record.sourceSolarSystemID,
      toInt(defaults.sourceSolarSystemID, 0),
    ),
    sourceLocationID: toInt(
      record.sourceLocationID,
      toInt(defaults.sourceLocationID, 0),
    ),
    sourceShipPosition: cloneValue(
      getObjectPosition(record.sourceShipPosition) ||
      getObjectPosition(defaults.sourceShipPosition),
    ),
    sourceShipDirection: normalizeDirection(
      record.sourceShipDirection || defaults.sourceShipDirection,
      { x: 1, y: 0, z: 0 },
    ),
    sourceShipRadius: toReal(
      record.sourceShipRadius,
      toReal(defaults.sourceShipRadius, 0),
    ),
    suspectOnReturn: record.suspectOnReturn === true || defaults.suspectOnReturn === true,
  };
}

function mergeAbyssalParticipantRecords(ports, previousRecord, requestedRecord) {
  const {
    cloneValue,
    isTerminalParticipantStatus,
  } = ports;
  if (!previousRecord) return requestedRecord;
  if (!requestedRecord) return previousRecord;
  const previousTerminal = isTerminalParticipantStatus(
    normalizeAbyssalParticipantStatus(ports, previousRecord.status),
  );
  const requestedTerminal = isTerminalParticipantStatus(
    normalizeAbyssalParticipantStatus(ports, requestedRecord.status),
  );
  return {
    ...cloneValue(previousRecord),
    ...cloneValue(requestedRecord),
    role: previousRecord.role === "owner" ? "owner" : requestedRecord.role,
    status: previousTerminal && !requestedTerminal
      ? previousRecord.status
      : requestedRecord.status,
    admittedAtMs: toInt(previousRecord.admittedAtMs, 0) ||
      toInt(requestedRecord.admittedAtMs, 0),
    destroyedAtMs: toInt(previousRecord.destroyedAtMs, 0) ||
      toInt(requestedRecord.destroyedAtMs, 0),
    exitedAtMs: toInt(previousRecord.exitedAtMs, 0) ||
      toInt(requestedRecord.exitedAtMs, 0),
  };
}

function normalizeAbyssalParticipantRoster(ports, state = {}, previousState = null) {
  const {
    ABYSSAL_PARTICIPANT_STATUS,
  } = ports;
  const ownerDefaults = {
    ownerCharacterID: toInt(state.characterID, toInt(previousState && previousState.characterID, 0)),
    characterID: toInt(state.characterID, toInt(previousState && previousState.characterID, 0)),
    shipID: toInt(state.shipID, toInt(previousState && previousState.shipID, 0)),
    shipTypeID: toInt(state.shipTypeID, 0),
    shipClass: normalizeText(state.shipClass, ""),
    fleetID: toInt(state.fleetID, 0),
    status: ABYSSAL_PARTICIPANT_STATUS.RESERVED,
    admittedAtMs: toInt(state.activatedAtMs, 0),
    currentRoomIndex: toInt(state.roomState && state.roomState.currentRoomIndex, 1),
    sourceSolarSystemID: toInt(state.sourceSolarSystemID, toInt(state.solarSystemID, 0)),
    sourceLocationID: toInt(state.sourceLocationID, toInt(state.sourceSolarSystemID, 0)),
    sourceShipPosition: state.sourceShipPosition,
    sourceShipDirection: state.sourceShipDirection,
    sourceShipRadius: state.sourceShipRadius,
    suspectOnReturn: state.suspectOnReturn === true,
  };
  const previousByCharacterID = new Map();
  for (const entry of Array.isArray(previousState && previousState.participantRoster)
    ? previousState.participantRoster
    : []) {
    const normalized = normalizeAbyssalParticipantRecord(ports, entry, ownerDefaults);
    if (normalized) previousByCharacterID.set(normalized.characterID, normalized);
  }
  const requestedByCharacterID = new Map();
  for (const entry of Array.isArray(state.participantRoster) ? state.participantRoster : []) {
    const normalized = normalizeAbyssalParticipantRecord(ports, entry, ownerDefaults);
    if (normalized) requestedByCharacterID.set(normalized.characterID, normalized);
  }
  if (ownerDefaults.characterID > 0 && !requestedByCharacterID.has(ownerDefaults.characterID)) {
    requestedByCharacterID.set(
      ownerDefaults.characterID,
      normalizeAbyssalParticipantRecord(ports, {}, ownerDefaults),
    );
  }
  for (const [characterID, previousRecord] of previousByCharacterID.entries()) {
    requestedByCharacterID.set(
      characterID,
      mergeAbyssalParticipantRecords(ports,
        previousRecord,
        requestedByCharacterID.get(characterID) || null,
      ),
    );
  }
  return [...requestedByCharacterID.values()].sort((left, right) => {
    if (left.role !== right.role) return left.role === "owner" ? -1 : 1;
    return left.characterID - right.characterID;
  });
}

function getAbyssalParticipantRecord(ports, pocketState, characterID) {
  if (!pocketState || typeof pocketState !== "object") return null;
  const numericCharacterID = toInt(characterID, 0);
  return normalizeAbyssalParticipantRoster(ports, pocketState).find(
    (participant) => participant.characterID === numericCharacterID,
  ) || null;
}

function isAbyssalParticipantInRun(ports, pocketState, characterID, options = {}) {
  const {
    ABYSSAL_PARTICIPANT_STATUS,
    isTerminalParticipantStatus,
  } = ports;
  const participant = getAbyssalParticipantRecord(ports, pocketState, characterID);
  if (!participant) return false;
  if (options.includeTerminal === true) return true;
  return !isTerminalParticipantStatus(participant.status) &&
    ![
      ABYSSAL_PARTICIPANT_STATUS.RESERVED,
      ABYSSAL_PARTICIPANT_STATUS.ADMISSION_FAILED,
    ].includes(participant.status);
}

function isAbyssalParticipantIndexed(ports, participant) {
  const {
    ABYSSAL_PARTICIPANT_STATUS,
    isTerminalParticipantStatus,
  } = ports;
  return Boolean(
    participant &&
    !isTerminalParticipantStatus(participant.status) &&
    participant.status !== ABYSSAL_PARTICIPANT_STATUS.ADMISSION_FAILED
  );
}

function upsertAbyssalParticipantRosterEntry(ports, pocketState, participantPatch) {
  const {
    cloneValue,
    buildPlaceholderRoomState,
  } = ports;
  const characterID = toInt(participantPatch && participantPatch.characterID, 0);
  const roster = normalizeAbyssalParticipantRoster(ports, pocketState);
  const existingIndex = roster.findIndex((entry) => entry.characterID === characterID);
  const defaults = {
    ownerCharacterID: toInt(pocketState && pocketState.characterID, 0),
    fleetID: toInt(pocketState && pocketState.fleetID, 0),
    shipClass: normalizeText(pocketState && pocketState.shipClass, ""),
    currentRoomIndex: buildPlaceholderRoomState(pocketState).currentRoomIndex,
    sourceSolarSystemID: toInt(pocketState && pocketState.sourceSolarSystemID, 0),
  };
  const normalized = normalizeAbyssalParticipantRecord(ports,
    existingIndex >= 0
      ? { ...roster[existingIndex], ...cloneValue(participantPatch) }
      : participantPatch,
    defaults,
  );
  if (!normalized) return roster;
  if (existingIndex >= 0) roster[existingIndex] = normalized;
  else roster.push(normalized);
  return normalizeAbyssalParticipantRoster(ports, {
    ...cloneValue(pocketState),
    participantRoster: roster,
  }, pocketState);
}

function listAuthoritativeAbyssalFleetCharacterIDs(ports, fleet, ownerCharacterID = 0) {
  const characterIDs = new Set();
  const addRecord = (record, fallbackID = 0) => {
    const characterID = toInt(
      record && (record.charID || record.characterID || record.characterid),
      toInt(fallbackID, 0),
    );
    if (characterID > 0) characterIDs.add(characterID);
  };
  const members = fleet && fleet.members;
  if (members instanceof Map) {
    for (const [key, member] of members.entries()) addRecord(member, key);
  } else if (Array.isArray(members)) {
    for (const member of members) addRecord(member);
  } else if (members && typeof members === "object") {
    for (const [key, member] of Object.entries(members)) addRecord(member, key);
  }
  if (toInt(ownerCharacterID, 0) > 0) characterIDs.add(toInt(ownerCharacterID, 0));
  return [...characterIDs].sort((left, right) => left - right);
}

function listAbyssalParticipantCharacterIDs(ports, pocketState, options = {}) {
  const {
    isTerminalParticipantStatus,
  } = ports;
  return normalizeAbyssalParticipantRoster(ports, pocketState)
    .filter((participant) => options.includeTerminal === true ||
      !isTerminalParticipantStatus(participant.status))
    .map((participant) => participant.characterID);
}

function buildAbyssalSurvivorControllerSelectionRequest(ports,
  pocketState,
  scene,
  options = {},
) {
  const {
    normalizeLowerText,
    buildPlaceholderRoomState,
    clampRoomIndex,
    resolveExactAbyssalRunRoomScope,
    listUniquePositiveInts,
  } = ports;
  const roomState = buildPlaceholderRoomState(pocketState);
  const roomIndex = clampRoomIndex(
    toInt(options.roomIndex, roomState.currentRoomIndex),
    roomState.implementedRooms,
  );
  const sceneKey = normalizeText(scene && scene.sceneKey, "");
  const participants = normalizeAbyssalParticipantRoster(ports, pocketState)
    .map((participant) => {
      const shipID = toInt(participant && participant.shipID, 0);
      const shipEntity = shipID > 0 && scene && typeof scene.getEntityByID === "function"
        ? scene.getEntityByID(shipID)
        : shipID > 0 && scene && scene.dynamicEntities instanceof Map
          ? scene.dynamicEntities.get(shipID) || null
          : null;
      const entityScope = resolveExactAbyssalRunRoomScope(shipEntity);
      const destructionState = normalizeLowerText(
        shipEntity && shipEntity.destructionState,
        "",
      );
      return {
        characterID: toInt(participant && participant.characterID, 0),
        shipID,
        role: normalizeLowerText(participant && participant.role, "member"),
        status: normalizeAbyssalParticipantStatus(ports, participant && participant.status),
        currentRoomIndex: toInt(participant && participant.currentRoomIndex, 0),
        destroyedAtMs: toInt(participant && participant.destroyedAtMs, 0),
        exitedAtMs: toInt(participant && participant.exitedAtMs, 0),
        controllerAuthority: {
          available: Boolean(shipEntity && scene),
          registered: Boolean(
            shipEntity &&
            (
              !(scene && scene.dynamicEntities instanceof Map) ||
              scene.dynamicEntities.get(shipID) === shipEntity
            )
          ),
          destroyed: Boolean(
            shipEntity &&
            (
              shipEntity.destroyed === true ||
              shipEntity.destroying === true ||
              shipEntity.removed === true ||
              shipEntity.isDestroyed === true ||
              ["destroying", "destroyed", "removed"].includes(destructionState)
            )
          ),
          incapacitated: Boolean(
            shipEntity &&
            shipEntity.conditionState &&
            shipEntity.conditionState.incapacitated === true
          ),
          instanceID: toInt(entityScope && entityScope.runID, 0),
          roomIndex: toInt(entityScope && entityScope.roomIndex, 0),
          sceneKey: normalizeText(shipEntity && shipEntity.sceneKey, sceneKey),
          characterID: toInt(
            shipEntity && shipEntity.pilotCharacterID,
            toInt(
              shipEntity && shipEntity.characterID,
              toInt(shipEntity && shipEntity.ownerID, 0),
            ),
          ),
          shipID: toInt(shipEntity && shipEntity.itemID, 0),
          controllerRef: shipEntity || null,
        },
      };
    });
  return {
    instanceID: toInt(pocketState && pocketState.instanceID, 0),
    ownerCharacterID: toInt(pocketState && pocketState.characterID, 0),
    excludedCharacterID: toInt(options.excludedCharacterID, 0),
    roomIndex,
    sceneKey,
    participants,
    preferredShipIDs: listUniquePositiveInts(options.preferredShipIDs),
    preferredCharacterID: toInt(options.preferredCharacterID, 0),
  };
}

function resolveAbyssalLiveCombatParticipant(ports,
  pocketState,
  scene,
  options = {},
) {
  const {
    cloneValue,
    selectAbyssalSurvivorController,
  } = ports;
  const request = buildAbyssalSurvivorControllerSelectionRequest(ports,
    pocketState,
    scene,
    options,
  );
  const selection = selectAbyssalSurvivorController(request);
  const selectedParticipant = selection.success
    ? getAbyssalParticipantRecord(ports, pocketState, selection.characterID)
    : null;
  return {
    success: selection.success,
    reason: selection.success
      ? "OK"
      : "ABYSSAL_LIVE_COMBAT_PARTICIPANT_UNAVAILABLE",
    roomIndex: selection.roomIndex,
    participant: selectedParticipant && cloneValue(selectedParticipant),
    characterID: selection.characterID,
    shipID: selection.shipID,
    shipEntity: selection.controllerRef || null,
    candidateCharacterIDs: [...selection.candidateCharacterIDs],
    candidateShipIDs: [...selection.candidateShipIDs],
    handoffStatus: selection.status,
    survivorExists: selection.survivorExists,
  };
}

function areAllEnteredAbyssalParticipantsTerminal(ports, pocketState) {
  const {
    ABYSSAL_PARTICIPANT_STATUS,
    isTerminalParticipantStatus,
  } = ports;
  const enteredParticipants = normalizeAbyssalParticipantRoster(ports, pocketState)
    .filter((participant) => [
      ABYSSAL_PARTICIPANT_STATUS.ACTIVE,
      ABYSSAL_PARTICIPANT_STATUS.DISCONNECTED,
      ABYSSAL_PARTICIPANT_STATUS.DESTROYED,
      ABYSSAL_PARTICIPANT_STATUS.EXITING,
      ABYSSAL_PARTICIPANT_STATUS.EXITED,
    ].includes(participant.status));
  return enteredParticipants.length > 0 && enteredParticipants.every((participant) =>
    isTerminalParticipantStatus(participant.status)
  );
}

function createAbyssalParticipantRoster(ports) {
  return {
    resolveAuthoritativeAbyssalFleetMembership: resolveAuthoritativeAbyssalFleetMembership.bind(null, ports),
    resolveCurrentAuthoritativeAbyssalFleetMembership: resolveCurrentAuthoritativeAbyssalFleetMembership.bind(null, ports),
    normalizeAbyssalParticipantStatus: normalizeAbyssalParticipantStatus.bind(null, ports),
    normalizeAbyssalParticipantRecord: normalizeAbyssalParticipantRecord.bind(null, ports),
    mergeAbyssalParticipantRecords: mergeAbyssalParticipantRecords.bind(null, ports),
    normalizeAbyssalParticipantRoster: normalizeAbyssalParticipantRoster.bind(null, ports),
    getAbyssalParticipantRecord: getAbyssalParticipantRecord.bind(null, ports),
    isAbyssalParticipantInRun: isAbyssalParticipantInRun.bind(null, ports),
    isAbyssalParticipantIndexed: isAbyssalParticipantIndexed.bind(null, ports),
    upsertAbyssalParticipantRosterEntry: upsertAbyssalParticipantRosterEntry.bind(null, ports),
    listAuthoritativeAbyssalFleetCharacterIDs: listAuthoritativeAbyssalFleetCharacterIDs.bind(null, ports),
    listAbyssalParticipantCharacterIDs: listAbyssalParticipantCharacterIDs.bind(null, ports),
    buildAbyssalSurvivorControllerSelectionRequest: buildAbyssalSurvivorControllerSelectionRequest.bind(null, ports),
    resolveAbyssalLiveCombatParticipant: resolveAbyssalLiveCombatParticipant.bind(null, ports),
    areAllEnteredAbyssalParticipantsTerminal: areAllEnteredAbyssalParticipantsTerminal.bind(null, ports),
  };
}

module.exports = { createAbyssalParticipantRoster };
