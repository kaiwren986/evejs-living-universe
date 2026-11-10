"use strict";

const { normalizeText } = require("../domain/abyssalValueUtils");

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

// Inspect the actual scene recipient, ego and current-room ownership before SetState.
// Legacy layout identity is checked only through the existing recovery-only selector.
function formatAbyssalRoomEntityDiagnostics({
  listUniquePositiveInts,
  listAbyssalRoomEntityRecords,
}, pocketState, roomIndex, entityIDs, deps) {
  const wanted = new Set(listUniquePositiveInts(entityIDs));
  if (wanted.size === 0) return "none";
  const rolesByID = new Map(
    listAbyssalRoomEntityRecords(pocketState, roomIndex, deps).map((record) => [
      toInt(record && record.runtimeItemID, 0),
      normalizeText(record && record.abyssalEntityRole, "unknown"),
    ]),
  );
  return [...wanted]
    .map((entityID) => `${entityID}:${rolesByID.get(entityID) || "unknown"}`)
    .join(",");
}

// What the SetState this bootstrap requests will carry: it is built by the
// scene's next doPreTick, after the bubble update commits the room spawned
// in this tick, so the room counts from its AddBall on.
function inspectAbyssalBootstrapEntityOwnership({}, scene, session, pocketState, currentRoomIndex, roomEntityIDs, shipID) {
  const visibleEntities = scene && typeof scene.getSessionGridEntities === "function"
    ? scene.getSessionGridEntities(session)
    : [];
  const visibleEntityIDs = new Set(
    (Array.isArray(visibleEntities) ? visibleEntities : [])
      .map((entity) => toInt(entity && entity.itemID, 0))
      .filter((entityID) => entityID > 0),
  );
  const missingRoomEntityIDs = roomEntityIDs.filter((entityID) => !visibleEntityIDs.has(entityID));
  const staleRoomEntityIDs = (Array.isArray(visibleEntities) ? visibleEntities : [])
    .filter((entity) => {
      if (toInt(entity && entity.itemID, 0) === shipID) return false;
      const entityRunID = toInt(
        entity && entity.abyssalRunID,
        toInt(
          entity && entity.evejsAbyssalInstanceID,
          toInt(entity && entity.evejsAbyssalPocketInstanceID, 0),
        ),
      );
      const entityRoomIndex = toInt(
        entity && entity.abyssalRoomIndex,
        toInt(entity && entity.evejsAbyssalRoomIndex, 0),
      );
      return entityRunID === toInt(pocketState && pocketState.instanceID, 0) &&
        entityRoomIndex > 0 &&
        entityRoomIndex !== currentRoomIndex;
    })
    .map((entity) => toInt(entity && entity.itemID, 0))
    .filter((entityID) => entityID > 0);
  const foreignRunEntityIDs = (Array.isArray(visibleEntities) ? visibleEntities : [])
    .filter((entity) => {
      if (toInt(entity && entity.itemID, 0) === shipID) return false;
      const entityRunID = toInt(
        entity && entity.abyssalRunID,
        toInt(
          entity && entity.evejsAbyssalInstanceID,
          toInt(entity && entity.evejsAbyssalPocketInstanceID, 0),
        ),
      );
      return entityRunID > 0 && entityRunID !== toInt(pocketState && pocketState.instanceID, 0);
    })
    .map((entity) => toInt(entity && entity.itemID, 0))
    .filter((entityID) => entityID > 0);
  const wrongOwnerEntityIDs = roomEntityIDs.filter((entityID) => {
    const entity = scene && typeof scene.getEntityByID === "function"
      ? scene.getEntityByID(entityID)
      : null;
    if (!entity) return false;
    const entityRunID = toInt(
      entity.abyssalRunID,
      toInt(entity.evejsAbyssalInstanceID, toInt(entity.evejsAbyssalPocketInstanceID, 0)),
    );
    const entityRoomIndex = toInt(
      entity.abyssalRoomIndex,
      toInt(entity.evejsAbyssalRoomIndex, 0),
    );
    return entityRunID !== toInt(pocketState && pocketState.instanceID, 0) ||
      entityRoomIndex !== currentRoomIndex;
  });
  const shipEntity = scene && typeof scene.getEntityByID === "function"
    ? scene.getEntityByID(shipID)
    : null;
  return {
    visibleEntityIDs, missingRoomEntityIDs, staleRoomEntityIDs, foreignRunEntityIDs,
    wrongOwnerEntityIDs, shipEntity,
  };
}

function inspectAbyssalBootstrapLayoutIdentity({
  normalizeT0DarkLayoutSelectionState,
  resolveSelectedT0DarkRoom,
}, pocketState, currentRoomIndex) {
  const normalizedLayout = normalizeT0DarkLayoutSelectionState(pocketState);
  const persistedLayoutSetID = normalizeText(pocketState && pocketState.selectedLayoutSetID, "");
  const persistedRoomLayoutID = normalizeText(
    pocketState && pocketState.selectedRoomLayoutIDs &&
      (pocketState.selectedRoomLayoutIDs[String(currentRoomIndex)] ||
        pocketState.selectedRoomLayoutIDs[currentRoomIndex]),
    "",
  );
  const resolvedRoomLayout = normalizedLayout
    ? resolveSelectedT0DarkRoom(normalizedLayout, currentRoomIndex)
    : null;
  const layoutSetID = normalizeText(normalizedLayout && normalizedLayout.selectedLayoutSetID, "");
  const roomLayoutID = normalizeText(resolvedRoomLayout && resolvedRoomLayout.layoutID, "");
  const layoutIdentityValid = !normalizedLayout || Boolean(
    (!persistedLayoutSetID || persistedLayoutSetID === layoutSetID) &&
      (!persistedRoomLayoutID || persistedRoomLayoutID === roomLayoutID)
  );
  return { layoutSetID, roomLayoutID, layoutIdentityValid };
}

function evaluateAbyssalBootstrapBinding({}, {
  runtime, descriptor, scene, session, expectedSceneKey, actualSceneKey,
  shipEntity, shipID, visibleEntityIDs, roomEntityIDs, layoutIdentityValid,
  missingRoomEntityIDs, staleRoomEntityIDs, wrongOwnerEntityIDs, foreignRunEntityIDs,
}) {
  const sceneMatches = Boolean(
    scene &&
      expectedSceneKey &&
      actualSceneKey === expectedSceneKey &&
      normalizeText(scene.sceneKey, "") === expectedSceneKey
  );
  const recipientMember = Boolean(
    sceneMatches &&
      scene.sessions instanceof Map &&
      scene.sessions.get(session.clientID) === session
  );
  const sceneAttached = sceneMatches && recipientMember;
  const shipRegistered = Boolean(
    shipEntity &&
      scene &&
      scene.dynamicEntities instanceof Map &&
      scene.dynamicEntities.get(shipID) === shipEntity
  );
  const participantShipCount = visibleEntityIDs.has(shipID) && shipRegistered ? 1 : 0;
  const visibleRoomEntityCount = roomEntityIDs.filter((entityID) =>
    visibleEntityIDs.has(entityID)
  ).length;
  let reason = "VALID";
  if (!runtime || !descriptor || !sceneMatches) reason = "WRONG_SCENE";
  else if (!recipientMember) reason = "NOT_SCENE_RECIPIENT";
  else if (!layoutIdentityValid) reason = "LAYOUT_MISMATCH";
  else if (!shipRegistered || participantShipCount !== 1) reason = "EGO_MISMATCH";
  else if (visibleEntityIDs.size <= 0) reason = "EMPTY_SNAPSHOT";
  else if (roomEntityIDs.length <= 0) reason = "ROOM_ENTITY_COUNT_MISMATCH";
  else if (missingRoomEntityIDs.length > 0) reason = "MISSING_CURRENT_ROOM_ENTITY";
  else if (visibleRoomEntityCount !== roomEntityIDs.length) reason = "ROOM_ENTITY_COUNT_MISMATCH";
  else if (staleRoomEntityIDs.length > 0) reason = "STALE_PRIOR_ROOM_ENTITY";
  else if (wrongOwnerEntityIDs.length > 0 || foreignRunEntityIDs.length > 0) {
    reason = "FOREIGN_RUN_ENTITY";
  }
  return {
    sceneMatches, recipientMember, sceneAttached, shipRegistered, participantShipCount,
    visibleRoomEntityCount, reason,
  };
}

function inspectAbyssalRelogBootstrapState({
  usesIsolatedAbyssalScene,
  buildAbyssalSceneDescriptor,
  buildPlaceholderRoomState,
  listAbyssalRoomBootstrapEntityIDs,
  inspectAbyssalBootstrapEntityOwnership,
  inspectAbyssalBootstrapLayoutIdentity,
  evaluateAbyssalBootstrapBinding,
  formatAbyssalRoomEntityDiagnostics,
}, session, pocketState, deps) {
  const runtime = deps;
  const descriptor = pocketState && usesIsolatedAbyssalScene(pocketState, deps)
    ? buildAbyssalSceneDescriptor(pocketState, deps)
    : null;
  const expectedSceneKey = normalizeText(descriptor && descriptor.sceneKey, "");
  const actualSceneKey = normalizeText(session && session._space && session._space.sceneKey, "");
  const scene = runtime && typeof runtime.getSceneForSession === "function"
    ? runtime.getSceneForSession(session)
    : null;
  const currentRoomIndex = buildPlaceholderRoomState(pocketState).currentRoomIndex;
  const roomEntityIDs = listAbyssalRoomBootstrapEntityIDs(pocketState, currentRoomIndex);
  const shipID = toInt(
    session && session._space && session._space.shipID,
    toInt(pocketState && pocketState.shipID, 0),
  );
  const {
    visibleEntityIDs, missingRoomEntityIDs, staleRoomEntityIDs, foreignRunEntityIDs,
    wrongOwnerEntityIDs, shipEntity,
  } = inspectAbyssalBootstrapEntityOwnership(
    scene, session, pocketState, currentRoomIndex, roomEntityIDs, shipID,
  );
  const { layoutSetID, roomLayoutID, layoutIdentityValid } =
    inspectAbyssalBootstrapLayoutIdentity(pocketState, currentRoomIndex);
  const {
    sceneMatches, recipientMember, sceneAttached, shipRegistered, participantShipCount,
    visibleRoomEntityCount, reason,
  } = evaluateAbyssalBootstrapBinding({
    runtime, descriptor, scene, session, expectedSceneKey, actualSceneKey,
    shipEntity, shipID, visibleEntityIDs, roomEntityIDs, layoutIdentityValid,
    missingRoomEntityIDs, staleRoomEntityIDs, wrongOwnerEntityIDs, foreignRunEntityIDs,
  });
  return {
    valid: reason === "VALID",
    reason,
    scene,
    descriptor,
    expectedSceneKey,
    actualSceneKey,
    currentRoomIndex,
    roomEntityIDs,
    missingRoomEntityIDs,
    missingRoomEntityDetails: formatAbyssalRoomEntityDiagnostics(
      pocketState,
      currentRoomIndex,
      missingRoomEntityIDs,
      deps,
    ),
    wrongOwnerEntityIDs,
    wrongOwnerEntityDetails: formatAbyssalRoomEntityDiagnostics(
      pocketState,
      currentRoomIndex,
      wrongOwnerEntityIDs,
      deps,
    ),
    staleRoomEntityIDs,
    foreignRunEntityIDs,
    inventoryHydrationRejectedCount: toInt(
      scene && scene.abyssalInventoryHydrationRejectedCount,
      0,
    ),
    shipID,
    shipEntity,
    visibleEntityCount: visibleEntityIDs.size,
    setStateSlimCount: participantShipCount + visibleRoomEntityCount,
    participantShipCount,
    visibleRoomEntityCount,
    expectedRoomEntityCount: roomEntityIDs.length,
    stalePriorRoomEntityCount: staleRoomEntityIDs.length,
    foreignRunEntityCount: foreignRunEntityIDs.length,
    recipientMember,
    setStatePreviouslyDelivered: Boolean(
      session && session._space && session._space.initialStateSent === true
    ),
    layoutSetID,
    roomLayoutID,
    layoutIdentityValid,
    layoutMatches: layoutIdentityValid,
    sceneMatches,
    sceneAttached,
    shipRegistered,
  };
}

function logAbyssalRelogBootstrapState({
  log,
  getCharacterID,
}, session, pocketState, state, details = {}) {
  log.info(
    `[AbyssalRelogBootstrap] run=${toInt(pocketState && pocketState.instanceID, 0)} ` +
      `room=${toInt(state && state.currentRoomIndex, 0)} ` +
      `character=${getCharacterID(session)} ship=${toInt(state && state.shipID, 0)} ` +
      `expectedScene=${normalizeText(state && state.expectedSceneKey, "none")} ` +
      `initialScene=${normalizeText(details.initialSceneKey, "none")} ` +
      `finalScene=${normalizeText(state && state.actualSceneKey, "none")} ` +
      `layoutSetID=${normalizeText(state && state.layoutSetID, "none")} ` +
      `roomLayoutID=${normalizeText(state && state.roomLayoutID, "none")} ` +
      `materializedEntities=${Array.isArray(state && state.roomEntityIDs) ? state.roomEntityIDs.length : 0} ` +
      `visibleEntities=${toInt(state && state.visibleEntityCount, 0)} ` +
      `setStateSlimCount=${toInt(details.setStateSlimCount, 0)} ` +
      `setStateEgo=${toInt(details.setStateEgo, 0)} ` +
      `staleEntitiesRejected=${toInt(
        details.staleEntitiesRejected,
        toInt(state && state.inventoryHydrationRejectedCount, 0) +
          (Array.isArray(state && state.staleRoomEntityIDs) ? state.staleRoomEntityIDs.length : 0),
      )} ` +
      `missingCurrentRoomEntities=${normalizeText(state && state.missingRoomEntityDetails, "none")} ` +
      `wrongOwnerRoomEntities=${normalizeText(state && state.wrongOwnerEntityDetails, "none")} ` +
      `repairAttempted=${details.repairAttempted === true} ` +
      `state=${normalizeText(details.bootstrapState, state && state.valid ? "ready" : "blocked")} ` +
      `reason=${normalizeText(details.reason, state && state.reason || "UNKNOWN")}`,
  );
}

function logRelogRecoveryState({
  log,
  formatVectorForLog,
}, context, pocketState, recoveryState) {
  log.info(
    `[AbyssalMgr] Relog recovery ship state char=${context.characterID} ` +
      `ship=${recoveryState.shipID} run=${pocketState.instanceID} sourceSystem=${pocketState.sourceSolarSystemID} ` +
      `currentSystem=${recoveryState.currentSystemID} sourcePos=${formatVectorForLog(pocketState.sourceShipPosition)} ` +
      `pocketPos=${formatVectorForLog(recoveryState.pocketPosition)} currentPos=${formatVectorForLog(recoveryState.currentShipPosition)} ` +
      `objectiveComplete=${pocketState.objectiveComplete === true} hostilesTracked=${recoveryState.hostilesTracked} ` +
      `hostilesPresent=${recoveryState.hostilesPresent} originMarkerPresent=${recoveryState.originMarkerPresent} ` +
      `exitMarkerPresent=${recoveryState.exitMarkerPresent} timerRemainingMs=${recoveryState.timerRemainingMs} ` +
      `timerExpired=${recoveryState.timerExpired} activeRuntime=${recoveryState.activeRuntime}`,
  );
}

// Capture supplied capabilities once, as the original closure did. Internal
// callbacks are bound once per instance; no runtime state lives in this wiring.
function createAbyssalRelogInspection({
  listUniquePositiveInts,
  listAbyssalRoomEntityRecords,
  usesIsolatedAbyssalScene,
  buildAbyssalSceneDescriptor,
  buildPlaceholderRoomState,
  listAbyssalRoomBootstrapEntityIDs,
  normalizeT0DarkLayoutSelectionState,
  resolveSelectedT0DarkRoom,
  log,
  getCharacterID,
  formatVectorForLog,
}) {

  const ports = {
    listUniquePositiveInts,
    listAbyssalRoomEntityRecords,
    usesIsolatedAbyssalScene,
    buildAbyssalSceneDescriptor,
    buildPlaceholderRoomState,
    listAbyssalRoomBootstrapEntityIDs,
    normalizeT0DarkLayoutSelectionState,
    resolveSelectedT0DarkRoom,
    log,
    getCharacterID,
    formatVectorForLog,
  };
  ports.formatAbyssalRoomEntityDiagnostics = formatAbyssalRoomEntityDiagnostics.bind(null, ports);
  ports.inspectAbyssalBootstrapEntityOwnership = inspectAbyssalBootstrapEntityOwnership.bind(null, ports);
  ports.inspectAbyssalBootstrapLayoutIdentity = inspectAbyssalBootstrapLayoutIdentity.bind(null, ports);
  ports.evaluateAbyssalBootstrapBinding = evaluateAbyssalBootstrapBinding.bind(null, ports);
  ports.inspectAbyssalRelogBootstrapState = inspectAbyssalRelogBootstrapState.bind(null, ports);
  ports.logAbyssalRelogBootstrapState = logAbyssalRelogBootstrapState.bind(null, ports);
  ports.logRelogRecoveryState = logRelogRecoveryState.bind(null, ports);
  Object.freeze(ports);
  return {
    inspectAbyssalRelogBootstrapState: ports.inspectAbyssalRelogBootstrapState,
    logAbyssalRelogBootstrapState: ports.logAbyssalRelogBootstrapState,
    logRelogRecoveryState: ports.logRelogRecoveryState,
  };
}

module.exports = { createAbyssalRelogInspection };
