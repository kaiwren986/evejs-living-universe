"use strict";

const { normalizeText } = require("../domain/abyssalValueUtils");

// Stateless operations using existing authoritative identity and persistence capabilities.
function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function updateCharacterLocationForAbyssalEvacuation(ports, characterID, returnSystemID, deps) {
  const numericCharacterID = toInt(characterID, 0);
  const numericSystemID = toInt(returnSystemID, 0);
  if (
    numericCharacterID <= 0 ||
    numericSystemID <= 0 ||
    !deps ||
    typeof deps.updateCharacterRecord !== "function"
  ) {
    return {
      success: numericCharacterID <= 0,
      skipped: numericCharacterID <= 0,
      errorMsg: numericCharacterID <= 0 ? null : "CHARACTER_UPDATE_UNAVAILABLE",
    };
  }
  return deps.updateCharacterRecord(
    numericCharacterID,
    (record) => {
      const systemIdentity =
        deps.worldData && typeof deps.worldData.getSolarSystemByID === "function"
          ? deps.worldData.getSolarSystemByID(numericSystemID)
          : null;
      return {
        ...record,
        stationID: null,
        structureID: null,
        solarSystemID: numericSystemID,
        constellationID: toInt(
          systemIdentity && systemIdentity.constellationID,
          toInt(record && record.constellationID, 0),
        ),
        regionID: toInt(
          systemIdentity && systemIdentity.regionID,
          toInt(record && record.regionID, 0),
        ),
      };
    },
    { expectedLocationTransitionReason: "abyssal-evacuation" },
  );
}

function buildAbyssalParticipantRoomScopeMetadata(ports, pocketState, roomIndex = null) {
  const {
    buildPlaceholderRoomState,
    clampRoomIndex,
  } = ports;
  const runID = toInt(pocketState && pocketState.instanceID, 0);
  const roomState = buildPlaceholderRoomState(pocketState);
  const resolvedRoomIndex = clampRoomIndex(
    toInt(roomIndex, roomState.currentRoomIndex),
    roomState.implementedRooms,
  );
  if (runID <= 0 || resolvedRoomIndex <= 0) {
    return null;
  }
  return {
    abyssalRunID: runID,
    evejsAbyssalInstanceID: runID,
    evejsAbyssalPocketInstanceID: runID,
    abyssalRoomIndex: resolvedRoomIndex,
    evejsAbyssalRoomIndex: resolvedRoomIndex,
    dungeonSiteInstanceID: runID,
  };
}

function applyAbyssalParticipantRoomScopeMetadata(ports, target, metadata) {
  if (!target || typeof target !== "object" || !metadata) {
    return target;
  }
  Object.assign(target, metadata);
  return target;
}

function clearExactAbyssalParticipantRoomScopeMetadata(ports, target, runID) {
  const {
    resolveExactAbyssalRunRoomScope,
  } = ports;
  if (!target || typeof target !== "object") {
    return false;
  }
  const numericRunID = toInt(runID, 0);
  const exactScope = resolveExactAbyssalRunRoomScope(target);
  if (!exactScope || numericRunID <= 0 || exactScope.runID !== numericRunID) {
    return false;
  }
  for (const field of [
    "abyssalRunID",
    "evejsAbyssalInstanceID",
    "evejsAbyssalPocketInstanceID",
    "abyssalRoomIndex",
    "evejsAbyssalRoomIndex",
    "dungeonSiteInstanceID",
  ]) {
    delete target[field];
  }
  return true;
}

function resolveAbyssalParticipantRoomScopePersistence(ports,
  pocketState,
  roomIndex,
  runtimeEntity,
  deps = ports.getDependencies(),
  options = {},
) {
  const {
    resolveExactAbyssalRunRoomScope,
  } = ports;
  const metadata = buildAbyssalParticipantRoomScopeMetadata(ports, pocketState, roomIndex);
  const shipID = toInt(
    options.shipID,
    toInt(pocketState && pocketState.shipID, toInt(runtimeEntity && runtimeEntity.itemID, 0)),
  );
  if (!metadata || shipID <= 0 || (runtimeEntity && toInt(runtimeEntity.itemID, 0) !== shipID)) {
    return { success: false, errorMsg: "ABYSSAL_PARTICIPANT_ROOM_SCOPE_IDENTITY_INVALID" };
  }

  let persistedShip = options.persistedShip || (
    deps && typeof deps.findItemById === "function" ? deps.findItemById(shipID) : null
  );
  let persistenceResult = null;
  const persistedScope = resolveExactAbyssalRunRoomScope({
    spaceState: persistedShip && persistedShip.spaceState,
  });
  if (
    !persistedScope ||
    persistedScope.runID !== metadata.abyssalRunID ||
    persistedScope.roomIndex !== metadata.abyssalRoomIndex
  ) {
    if (options.persist === false) {
      return {
        success: false,
        errorMsg: "ABYSSAL_PARTICIPANT_ROOM_SCOPE_NOT_PERSISTED",
      };
    }
    const updateFn = deps && (
      typeof deps.updateShipItem === "function"
        ? deps.updateShipItem
        : typeof deps.updateInventoryItem === "function"
          ? deps.updateInventoryItem
          : null
    );
    if (!updateFn) {
      return {
        success: false,
        errorMsg: "ABYSSAL_PARTICIPANT_ROOM_SCOPE_PERSIST_UNAVAILABLE",
      };
    }
    persistenceResult = updateFn(shipID, (currentItem) => ({
      ...currentItem,
      spaceState: {
        ...(currentItem && currentItem.spaceState || {}),
        ...metadata,
      },
    }));
    if (!persistenceResult || !persistenceResult.success || !persistenceResult.data) {
      return {
        success: false,
        errorMsg: persistenceResult && persistenceResult.errorMsg ||
          "ABYSSAL_PARTICIPANT_ROOM_SCOPE_PERSIST_FAILED",
      };
    }
    persistedShip = persistenceResult.data;
  }

  return { success: true, metadata, persistedShip, persistenceResult };
}

function stampAbyssalParticipantRoomScope(ports,
  pocketState,
  roomIndex,
  session,
  runtimeEntity,
  deps = ports.getDependencies(),
  options = {},
) {
  const {
    resolveExactAbyssalRunRoomScope,
    syncInventoryChanges,
  } = ports;
  const persistence = resolveAbyssalParticipantRoomScopePersistence(ports,
    pocketState,
    roomIndex,
    runtimeEntity,
    deps,
    options,
  );
  if (!persistence.success) {
    return persistence;
  }
  const { metadata, persistedShip, persistenceResult } = persistence;

  applyAbyssalParticipantRoomScopeMetadata(ports, session, metadata);
  if (session && session._space && typeof session._space === "object") {
    applyAbyssalParticipantRoomScopeMetadata(ports, session._space, metadata);
  }
  applyAbyssalParticipantRoomScopeMetadata(ports, runtimeEntity, metadata);
  const runtimeScope = runtimeEntity
    ? resolveExactAbyssalRunRoomScope(runtimeEntity)
    : metadata;
  if (
    runtimeEntity &&
    (
      !runtimeScope ||
      runtimeScope.runID !== metadata.abyssalRunID ||
      runtimeScope.roomIndex !== metadata.abyssalRoomIndex
    )
  ) {
    return { success: false, errorMsg: "ABYSSAL_PARTICIPANT_RUNTIME_SCOPE_INVALID" };
  }
  if (persistenceResult && options.syncInventory !== false) {
    syncInventoryChanges(session, [{
      item: persistedShip,
      previousData: persistenceResult.previousData || null,
    }], deps);
  }
  return {
    success: true,
    metadata,
    persistedShip,
    persistenceResult,
  };
}

function setAbyssalSessionState(ports, session, pocketState, traceItemID = 0) {
  const {
    usesIsolatedAbyssalScene,
    buildAbyssalSceneDescriptor,
  } = ports;
  if (!session || typeof session !== "object") {
    return;
  }
  const resolvedTraceItemID = toInt(
    traceItemID,
    toInt(pocketState && pocketState.traceItemID, 0),
  );
  if (resolvedTraceItemID > 0) {
    session.abyssalTraceID = resolvedTraceItemID;
  }
  const instanceID = toInt(pocketState && pocketState.instanceID, 0);
  if (instanceID > 0) {
    session.abyssalInstanceID = instanceID;
  }
  const roomMetadata = buildAbyssalParticipantRoomScopeMetadata(ports, pocketState);
  applyAbyssalParticipantRoomScopeMetadata(ports, session, roomMetadata);
  if (session._space && typeof session._space === "object") {
    applyAbyssalParticipantRoomScopeMetadata(ports, session._space, roomMetadata);
  }
  if (usesIsolatedAbyssalScene(pocketState)) {
    const descriptor = buildAbyssalSceneDescriptor(pocketState);
    if (descriptor) {
      session.spaceSceneKey = descriptor.sceneKey;
      session.spaceInstanceID = descriptor.instanceID;
    }
  }
  session.abyssalPlaceholder = true;
}

function captureAbyssalSpaceSessionFields(ports, session) {
  return {
    locationid: session && session.locationid !== undefined ? session.locationid : null,
    solarsystemid: session && session.solarsystemid !== undefined ? session.solarsystemid : null,
    solarsystemid2: session && session.solarsystemid2 !== undefined ? session.solarsystemid2 : null,
    constellationid:
      session && session.constellationID !== undefined
        ? session.constellationID
        : session && session.constellationid !== undefined
          ? session.constellationid
          : null,
    regionid:
      session && session.regionID !== undefined
        ? session.regionID
        : session && session.regionid !== undefined
          ? session.regionid
          : null,
    shipid: session && session.shipid !== undefined ? session.shipid : session && session.shipID || null,
  };
}

function restoreAbyssalSpaceSessionFields(ports, session, fields) {
  if (!session || !fields) {
    return;
  }
  session.locationid = fields.locationid;
  session.solarsystemid = fields.solarsystemid;
  session.solarsystemid2 = fields.solarsystemid2;
  session.constellationID = fields.constellationid || 0;
  session.constellationid = session.constellationID;
  session.regionID = fields.regionid || 0;
  session.regionid = session.regionID;
  session.shipid = fields.shipid;
  session.shipID = fields.shipid;
}

function addAbyssalSessionChange(ports, changes, key, oldValue, newValue) {
  if (oldValue === newValue) {
    return;
  }
  changes[key] = [oldValue, newValue];
}

function buildAbyssalExitSessionChanges(ports, session, targetLocationID, movedShip, descriptor) {
  const {
    buildAbyssalEntrySessionChanges,
  } = ports;
  return buildAbyssalEntrySessionChanges(session, targetLocationID, movedShip, descriptor);
}

function clearAbyssalSessionState(ports, session, options = {}) {
  if (!session || typeof session !== "object") {
    return;
  }
  const currentSpaceSceneKey = normalizeText(
    session && session._space && session._space.sceneKey,
    normalizeText(session.spaceSceneKey, ""),
  );
  const currentSpaceInstanceID = toInt(
    session && session._space && session._space.instanceID,
    toInt(session.spaceInstanceID, 0),
  );
  const preserveCommittedKSpaceIdentity = Boolean(
    currentSpaceInstanceID === 0 &&
    currentSpaceSceneKey.startsWith("solar-system:")
  );
  const pendingKSpaceArrival = session._abyssalKSpaceArrival;
  const preserveCommittedArrivalPresentation = Boolean(
    options.preserveCommittedArrivalPresentation === true &&
      preserveCommittedKSpaceIdentity &&
      pendingKSpaceArrival &&
      pendingKSpaceArrival.finalizeRunOnCompletion === false &&
      pendingKSpaceArrival.returnReceiptCommitted === true
  );
  delete session.abyssalTraceID;
  delete session.abyssalInstanceID;
  delete session.abyssalRunID;
  delete session.evejsAbyssalInstanceID;
  delete session.evejsAbyssalPocketInstanceID;
  delete session.abyssalRoomIndex;
  delete session.evejsAbyssalRoomIndex;
  delete session.dungeonSiteInstanceID;
  delete session.abyssalPlaceholder;
  delete session.abyssalClientEnvironment;
  delete session.abyssalClientEnvironmentDelivery;
  delete session.abyssalDungeonNotificationState;
  delete session.abyssalEnvironmentSequence;
  delete session._abyssalFreshEntryBootstrap;
  delete session._abyssalBootstrapMode;
  if (!preserveCommittedArrivalPresentation) {
    delete session._abyssalKSpaceArrival;
    delete session._abyssalKSpaceArrivalSessionIdentity;
  }
  if (preserveCommittedKSpaceIdentity) {
    session.spaceSceneKey = currentSpaceSceneKey;
    session.spaceInstanceID = 0;
  } else {
    delete session.spaceSceneKey;
    delete session.spaceInstanceID;
  }
  if (session._space && typeof session._space === "object") {
    delete session._space.abyssalRunID;
    delete session._space.evejsAbyssalInstanceID;
    delete session._space.evejsAbyssalPocketInstanceID;
    delete session._space.abyssalRoomIndex;
    delete session._space.evejsAbyssalRoomIndex;
    delete session._space.dungeonSiteInstanceID;
  }
}

function createAbyssalParticipantSession(ports) {
  return {
    updateCharacterLocationForAbyssalEvacuation: updateCharacterLocationForAbyssalEvacuation.bind(null, ports),
    buildAbyssalParticipantRoomScopeMetadata: buildAbyssalParticipantRoomScopeMetadata.bind(null, ports),
    applyAbyssalParticipantRoomScopeMetadata: applyAbyssalParticipantRoomScopeMetadata.bind(null, ports),
    clearExactAbyssalParticipantRoomScopeMetadata: clearExactAbyssalParticipantRoomScopeMetadata.bind(null, ports),
    resolveAbyssalParticipantRoomScopePersistence: resolveAbyssalParticipantRoomScopePersistence.bind(null, ports),
    stampAbyssalParticipantRoomScope: stampAbyssalParticipantRoomScope.bind(null, ports),
    setAbyssalSessionState: setAbyssalSessionState.bind(null, ports),
    captureAbyssalSpaceSessionFields: captureAbyssalSpaceSessionFields.bind(null, ports),
    restoreAbyssalSpaceSessionFields: restoreAbyssalSpaceSessionFields.bind(null, ports),
    addAbyssalSessionChange: addAbyssalSessionChange.bind(null, ports),
    buildAbyssalExitSessionChanges: buildAbyssalExitSessionChanges.bind(null, ports),
    clearAbyssalSessionState: clearAbyssalSessionState.bind(null, ports),
  };
}

module.exports = { createAbyssalParticipantSession };
