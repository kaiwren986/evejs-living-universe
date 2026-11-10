"use strict";

const { normalizeText } = require("../domain/abyssalValueUtils");

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

// Select only sessions authorized by the existing participant hull/capsule rules.
function resolveAbyssalParticipantActiveShip({
  getDependencies,
  isCapsuleTypeID,
}, session, deps = getDependencies()) {
  const shipID = toInt(
    session &&
      session._space &&
      session._space.shipID,
    toInt(
      session &&
        (
          session.shipID ||
          session.shipid ||
          session.activeShipID
        ),
      0,
    ),
  );
  const shipItem =
    shipID > 0 && deps && typeof deps.findItemById === "function"
      ? deps.findItemById(shipID)
      : null;
  let typeID = toInt(shipItem && shipItem.typeID, 0);
  if (typeID <= 0 && session && session._space) {
    const runtime = deps;
    const scene =
      runtime && typeof runtime.getSceneForSession === "function"
        ? runtime.getSceneForSession(session)
        : null;
    const entity =
      scene && typeof scene.getEntityByID === "function" && shipID > 0
        ? scene.getEntityByID(shipID)
        : null;
    typeID = toInt(entity && entity.typeID, 0);
  }
  return {
    shipID,
    typeID,
    shipItem,
    isCapsule: isCapsuleTypeID(typeID),
  };
}

function collectAbyssalDestructionAliases({}, sources, keys) {
  let present = false;
  let invalid = false;
  const values = [];
  for (const source of sources) {
    if (!source || typeof source !== "object") {
      continue;
    }
    for (const key of keys) {
      if (!Object.prototype.hasOwnProperty.call(source, key)) {
        continue;
      }
      present = true;
      const value = toInt(source[key], 0);
      if (value <= 0) {
        invalid = true;
      } else {
        values.push(value);
      }
    }
  }
  const distinctValues = [...new Set(values)];
  return {
    present,
    valid: present && !invalid && distinctValues.length === 1,
    value: distinctValues.length === 1 ? distinctValues[0] : 0,
  };
}

function buildAbyssalDestructionSessionContext({
  buildPlaceholderRoomState,
  listUniquePositiveInts,
}, pocketState, deps, preferredSession, options) {
  // A replacement ship in the character record must not expand the target set.
  const runID = toInt(pocketState && pocketState.instanceID, 0);
  const participant = options.participant && typeof options.participant === "object"
    ? options.participant
    : null;
  const characterID = participant
    ? toInt(participant.characterID, 0)
    : toInt(pocketState && pocketState.characterID, 0);
  const roomIndex = toInt(
    buildPlaceholderRoomState(pocketState).currentRoomIndex,
    0,
  );
  const exactSceneKey = runID > 0 ? `abyssal-run:${runID}` : "";
  const allowedShipIDs = new Set(listUniquePositiveInts([
    participant && participant.shipID,
    !participant && pocketState && pocketState.shipID,
  ]));
  return { pocketState, deps, preferredSession, options,
    runID, characterID, roomIndex, exactSceneKey, allowedShipIDs };
}

function matchesAbyssalDestructionSession({
  getCharacterID,
  collectAbyssalDestructionAliases,
  resolveAbyssalParticipantActiveShip,
  buildAbyssalParticipantRoomScopeMetadata,
  applyAbyssalParticipantRoomScopeMetadata,
}, candidate, context, requireOfflineSurrogate = false) {
  const { pocketState, deps, preferredSession, options,
    runID, characterID, roomIndex, exactSceneKey, allowedShipIDs } = context;
  if (!candidate || getCharacterID(candidate) !== characterID) {
    return false;
  }
  if (
    requireOfflineSurrogate &&
    candidate._abyssalOfflineSession !== true
  ) {
    return false;
  }
  const sessionSources = [candidate, candidate._space];
  const runAuthority = collectAbyssalDestructionAliases(sessionSources, [
    "abyssalRunID",
    "abyssalInstanceID",
    "evejsAbyssalInstanceID",
    "evejsAbyssalPocketInstanceID",
    "dungeonSiteInstanceID",
  ]);
  if (requireOfflineSurrogate) {
    const offlineRunAuthority = collectAbyssalDestructionAliases(
      [candidate],
      ["_abyssalOfflineRunID"],
    );
    if (
      !offlineRunAuthority.valid ||
      offlineRunAuthority.value !== runID
    ) {
      return false;
    }
  }
  const roomAuthority = collectAbyssalDestructionAliases(sessionSources, [
    "abyssalRoomIndex",
    "evejsAbyssalRoomIndex",
  ]);
  const shipAuthority = collectAbyssalDestructionAliases(sessionSources, [
    "shipID",
    "shipid",
    "activeShipID",
  ]);
  const candidateActiveShip = resolveAbyssalParticipantActiveShip(candidate, deps);
  const candidateCapsuleOwnedByParticipant = Boolean(
    candidateActiveShip.isCapsule === true &&
    candidateActiveShip.shipItem &&
    toInt(candidateActiveShip.shipItem.ownerID, 0) === characterID
  );
  const sceneKeys = [
    candidate.spaceSceneKey,
    candidate._space && candidate._space.sceneKey,
  ]
    .filter((value) => value !== null && value !== undefined)
    .map((value) => normalizeText(value, ""));
  const sceneAuthorityValid = Boolean(
    sceneKeys.length > 0 &&
    sceneKeys.every((sceneKey) => sceneKey === exactSceneKey)
  );
  const preferredServerSession = Boolean(
    preferredSession && candidate === preferredSession
  );
  const preferredSessionAuthority =
    options &&
    options.preferredSessionAuthority &&
    typeof options.preferredSessionAuthority === "object"
      ? options.preferredSessionAuthority
      : null;
  const immediateCapsuleAuthorityAccepted = Boolean(
    preferredServerSession &&
    preferredSessionAuthority &&
    toInt(preferredSessionAuthority.runID, 0) === runID &&
    toInt(preferredSessionAuthority.characterID, 0) === characterID &&
    toInt(preferredSessionAuthority.roomIndex, 0) === roomIndex &&
    toInt(preferredSessionAuthority.capsuleID, 0) > 0 &&
    candidateActiveShip.shipID ===
      toInt(preferredSessionAuthority.capsuleID, 0) &&
    candidateCapsuleOwnedByParticipant &&
    sceneAuthorityValid
  );
  const runAuthorityAccepted = Boolean(
    runAuthority.valid && runAuthority.value === runID
  ) || Boolean(preferredServerSession && !runAuthority.present) ||
    immediateCapsuleAuthorityAccepted;
  const roomAuthorityAccepted = Boolean(
    roomAuthority.valid && roomAuthority.value === roomIndex
  ) || Boolean(preferredServerSession && !roomAuthority.present) ||
    immediateCapsuleAuthorityAccepted;
  const shipAuthorityAccepted = Boolean(
    shipAuthority.valid &&
    (
      allowedShipIDs.has(shipAuthority.value) ||
      (
        candidateCapsuleOwnedByParticipant &&
        candidateActiveShip.shipID === shipAuthority.value
      )
    )
  ) || immediateCapsuleAuthorityAccepted;
  const accepted = Boolean(
    runID > 0 &&
    roomIndex > 0 &&
    sceneAuthorityValid &&
    runAuthorityAccepted &&
    roomAuthorityAccepted &&
    shipAuthorityAccepted
  );
  if (accepted && preferredServerSession) {
    const metadata = buildAbyssalParticipantRoomScopeMetadata(
      pocketState,
      roomIndex,
    );
    applyAbyssalParticipantRoomScopeMetadata(candidate, metadata);
    if (candidate._space && typeof candidate._space === "object") {
      applyAbyssalParticipantRoomScopeMetadata(candidate._space, metadata);
    }
  }
  return accepted;
}

function resolveAbyssalTimeoutRuntimeSession({
  getDependencies,
  buildAbyssalDestructionSessionContext,
  matchesAbyssalDestructionSession,
},
  pocketState,
  deps = getDependencies(),
  preferredSession = null,
  options = {},
) {
  const context = buildAbyssalDestructionSessionContext(pocketState, deps, preferredSession, options);
  const { runID, characterID } = context;
  if (matchesAbyssalDestructionSession(preferredSession, context, false)) {
    return preferredSession;
  }
  const sessionRegistry = deps;
  const registeredSession =
    sessionRegistry && typeof sessionRegistry.findSessionByCharacterID === "function"
      ? sessionRegistry.findSessionByCharacterID(characterID) || null
      : null;
  if (matchesAbyssalDestructionSession(registeredSession, context, false)) {
    return registeredSession;
  }
  const runtime = deps;
  const offlineSession =
    runtime && typeof runtime.getAbyssalOfflineSessionForRun === "function"
      ? runtime.getAbyssalOfflineSessionForRun(runID, characterID)
      : null;
  return matchesAbyssalDestructionSession(offlineSession, context, true)
    ? offlineSession
    : null;
}

function createAbyssalDestructionSessionSelection({
  getDependencies,
  getCharacterID,
  buildPlaceholderRoomState,
  listUniquePositiveInts,
  buildAbyssalParticipantRoomScopeMetadata,
  applyAbyssalParticipantRoomScopeMetadata,
  isCapsuleTypeID,
}) {

  const ports = {
    getDependencies,
    getCharacterID,
    buildPlaceholderRoomState,
    listUniquePositiveInts,
    buildAbyssalParticipantRoomScopeMetadata,
    applyAbyssalParticipantRoomScopeMetadata,
    isCapsuleTypeID,
  };
  ports.resolveAbyssalParticipantActiveShip = resolveAbyssalParticipantActiveShip.bind(null, ports);
  ports.collectAbyssalDestructionAliases = collectAbyssalDestructionAliases.bind(null, ports);
  ports.buildAbyssalDestructionSessionContext = buildAbyssalDestructionSessionContext.bind(null, ports);
  ports.matchesAbyssalDestructionSession = matchesAbyssalDestructionSession.bind(null, ports);
  ports.resolveAbyssalTimeoutRuntimeSession = resolveAbyssalTimeoutRuntimeSession.bind(null, ports);
  Object.freeze(ports);
  return { resolveAbyssalTimeoutRuntimeSession: ports.resolveAbyssalTimeoutRuntimeSession, resolveAbyssalParticipantActiveShip: ports.resolveAbyssalParticipantActiveShip };
}

module.exports = { createAbyssalDestructionSessionSelection };
