"use strict";

const { normalizeText } = require("../domain/abyssalValueUtils");
const { grantAbyssalArrivalProtection } = require("./abyssalArrivalProtection");

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function resolveAbyssalRosterParticipantSession(ports,
  pocketState,
  participant,
  deps = ports.getDependencies(),
  preferredSession = null,
) {
  const {
    getCharacterID,
  } = ports;
  const characterID = toInt(participant && participant.characterID, 0);
  const shipID = toInt(participant && participant.shipID, 0);
  const matches = (candidate) => Boolean(
    candidate &&
    getCharacterID(candidate) === characterID &&
    toInt(
      candidate._space && candidate._space.shipID,
      toInt(candidate.shipID || candidate.shipid || candidate.activeShipID, 0),
    ) === shipID
  );
  if (matches(preferredSession)) return preferredSession;
  const registry = deps;
  const registered = registry && typeof registry.findSessionByCharacterID === "function"
    ? registry.findSessionByCharacterID(characterID)
    : null;
  if (matches(registered)) return registered;
  const runtime = deps;
  const offline = runtime && typeof runtime.getAbyssalOfflineSessionForRun === "function"
    ? runtime.getAbyssalOfflineSessionForRun(
        toInt(pocketState && pocketState.instanceID, 0),
        characterID,
      )
    : null;
  return matches(offline) ? offline : null;
}

function collectConduitAnimationLookupDiagnostics(ports, scene, conduitItemID, markerItem, entity) {
  const dynamicEntity = scene && scene.dynamicEntities instanceof Map
    ? scene.dynamicEntities.get(conduitItemID) || null
    : null;
  const staticEntity = scene && scene.staticEntitiesByID instanceof Map
    ? scene.staticEntitiesByID.get(conduitItemID) || null
    : null;
  const bubbleID = toInt(entity && entity.bubbleID, toInt(dynamicEntity && dynamicEntity.bubbleID, 0));
  const bubble = scene && typeof scene.getBubbleByID === "function" && bubbleID > 0
    ? scene.getBubbleByID(bubbleID)
    : null;
  return {
    dynamicFound: Boolean(dynamicEntity),
    staticFound: Boolean(staticEntity),
    bubbleFound: Boolean(bubble && bubble.entityIDs instanceof Set && bubble.entityIDs.has(conduitItemID)),
    inventoryFound: Boolean(markerItem),
    entityKind: normalizeText(entity && entity.kind, ""),
    entityTypeID: toInt(entity && entity.typeID, 0),
    entityInstanceID: toInt(entity && entity.evejsAbyssalPocketInstanceID, 0),
  };
}

function resolveCurrentRoomConduitSceneEntity(ports, pocketState, roomState, roomEntry, conduitItemID, deps = ports.getDependencies()) {
  const {
    getPocketScene,
    TYPE_ABYSSAL_TRANSFER_CONDUIT,
    TYPE_ABYSSAL_ORIGIN_CONDUIT,
  } = ports;
  const systemID = toInt(pocketState && pocketState.solarSystemID, 0);
  const scene = getPocketScene(pocketState, deps);
  const markerItem = deps.findItemById ? deps.findItemById(conduitItemID) : null;
  const entity = scene && typeof scene.getEntityByID === "function"
    ? scene.getEntityByID(conduitItemID)
    : null;
  const diagnostics = collectConduitAnimationLookupDiagnostics(ports, scene, conduitItemID, markerItem, entity);
  const expectedInstanceID = toInt(pocketState && pocketState.instanceID, 0);
  let reason = "";
  if (!scene) {
    reason = "SCENE_NOT_FOUND";
  } else if (!entity) {
    reason = "ENTITY_MISSING";
  } else if (toInt(roomEntry && roomEntry.conduitItemID, 0) !== conduitItemID) {
    reason = "NOT_CURRENT_ROOM_CONDUIT";
  } else if (
    toInt(entity.typeID, 0) !== TYPE_ABYSSAL_TRANSFER_CONDUIT &&
    toInt(entity.typeID, 0) !== TYPE_ABYSSAL_ORIGIN_CONDUIT
  ) {
    reason = "UNEXPECTED_CONDUIT_TYPE";
  } else if (
    expectedInstanceID > 0 &&
    toInt(entity.evejsAbyssalPocketInstanceID, expectedInstanceID) !== expectedInstanceID
  ) {
    reason = "INSTANCE_MISMATCH";
  }

  return {
    success: !reason,
    reason,
    scene,
    entity,
    markerItem,
    diagnostics,
    systemID,
  };
}

function moveOtherAbyssalParticipantsToRoom(ports, pocketState, activatingSession, targetPocketState, targetRoomIndex, deps = ports.getDependencies()) {
  const work = { pocketState, activatingSession, targetPocketState, targetRoomIndex, deps };
  prepareParticipantMovement(ports, work);
  for (const participant of ports.normalizeAbyssalParticipantRoster(work.workingState)) {
    if (participant.characterID === work.activatingCharacterID ||
        ![ports.ABYSSAL_PARTICIPANT_STATUS.ACTIVE, ports.ABYSSAL_PARTICIPANT_STATUS.DISCONNECTED].includes(participant.status)) continue;
    const movement = { ...work, participant };
    for (const advance of [persistParticipantDestination, relocateRoomParticipant, commitRoomParticipant]) {
      const result = advance(ports, movement);
      if (result) return result;
    }
    work.workingState = movement.workingState;
  }
  return { success: true, pocketState: work.workingState, results: work.results };
}

function prepareParticipantMovement(ports, work) {
  const {
    getCharacterID,
    getPocketScene,
    buildAbyssalSceneDescriptor,
    getObjectPosition,
    buildAbyssalParticipantRoomScopeMetadata,
    getActivePocketStateByInstanceID,
  } = ports;
  const {
    pocketState,
    activatingSession,
    targetPocketState,
    targetRoomIndex,
    deps,
  } = work;
  const activatingCharacterID = getCharacterID(activatingSession);
  const runtime = deps;
  const scene = getPocketScene(pocketState, deps);
  const descriptor = buildAbyssalSceneDescriptor(targetPocketState, deps);
  const targetPosition = getObjectPosition(targetPocketState.shipSpawnState);
  const targetDirection = targetPocketState.shipSpawnState &&
  targetPocketState.shipSpawnState.direction;
  const roomScope = buildAbyssalParticipantRoomScopeMetadata(
    targetPocketState,
    targetRoomIndex,
  );
  let workingState = getActivePocketStateByInstanceID(pocketState.instanceID) || pocketState;
  const results = [];
  Object.assign(work, { activatingCharacterID, runtime, scene, descriptor, targetPosition, targetDirection, roomScope, workingState, results });
}

function persistParticipantDestination(ports, work) {
  const {
    addVectors,
    cloneValue,
  } = ports;
  const {
    workingState,
    participant,
    deps,
    results,
    targetPosition,
    descriptor,
    targetPocketState,
    roomScope,
  } = work;
  const participantSession = resolveAbyssalRosterParticipantSession(ports,
    workingState,
    participant,
    deps,
  );
  const persistedShip = deps.findItemById(participant.shipID);
  if (!persistedShip || typeof deps.updateShipItem !== "function") {
    return {
      success: false,
      errorMsg: "ABYSSAL_PARTICIPANT_TRANSFER_SHIP_MISSING",
      characterID: participant.characterID,
      shipID: participant.shipID,
      results,
    };
  }
  const ordinal = Math.max(1, results.length + 1);
  const participantTargetPosition = addVectors(
    targetPosition || { x: 0, y: 0, z: 0 },
    { x: 0, y: ordinal * 1_500, z: 0 },
  );
  const shipUpdate = deps.updateShipItem(participant.shipID, (currentItem) => ({
    ...currentItem,
    locationID: toInt(descriptor && descriptor.locationID, targetPocketState.solarSystemID),
    flagID: 0,
    spaceState: {
      ...(currentItem && currentItem.spaceState || {}),
      ...cloneValue(targetPocketState.shipSpawnState || {}),
      ...roomScope,
      systemID: toInt(descriptor && descriptor.locationID, targetPocketState.solarSystemID),
      position: participantTargetPosition,
      targetPoint: participantTargetPosition,
    },
  }));
  if (!shipUpdate || shipUpdate.success !== true || !shipUpdate.data) {
    return {
      success: false,
      errorMsg: normalizeText(
        shipUpdate && shipUpdate.errorMsg,
        "ABYSSAL_PARTICIPANT_TRANSFER_PERSIST_FAILED",
      ),
      characterID: participant.characterID,
      shipID: participant.shipID,
      results,
    };
  }
  Object.assign(work, { participantSession, persistedShip, participantTargetPosition, shipUpdate });
}

function relocateRoomParticipant(ports, work) {
  const {
    setAbyssalSessionState,
    applyAbyssalParticipantRoomScopeMetadata,
    syncInventoryChanges,
    usesAuthoredAbyssalEnvironmentNotification,
    queueAbyssalClientEnvironmentDelivery,
  } = ports;
  const {
    participant,
    scene,
    participantSession,
    runtime,
    targetPocketState,
    roomScope,
    participantTargetPosition,
    targetDirection,
    results,
    shipUpdate,
    persistedShip,
    deps,
  } = work;
  const runtimeEntity = scene && typeof scene.getEntityByID === "function"
  ? scene.getEntityByID(participant.shipID)
  : null;
  let teleportResult = null;
  if (
    participantSession && participantSession._space &&
    typeof runtime.teleportSessionShipForAbyssalTransition === "function"
  ) {
    setAbyssalSessionState(participantSession, targetPocketState, targetPocketState.traceItemID);
    applyAbyssalParticipantRoomScopeMetadata(participantSession, roomScope);
    applyAbyssalParticipantRoomScopeMetadata(participantSession._space, roomScope);
    teleportResult = runtime.teleportSessionShipForAbyssalTransition(
      participantSession,
      participantTargetPosition,
      {
        direction: targetDirection,
        suppressVisibilityReconciliation: true,
        broadcastMovement: false,
      },
    );
  } else if (runtimeEntity && typeof scene.teleportDynamicEntityToPoint === "function") {
    teleportResult = scene.teleportDynamicEntityToPoint(
      runtimeEntity,
      participantTargetPosition,
      { direction: targetDirection, broadcastMovement: false },
    );
  } else {
    teleportResult = { success: true, deferredUntilRelog: true };
  }
  if (!teleportResult || teleportResult.success !== true) {
    return {
      success: false,
      errorMsg: normalizeText(
        teleportResult && teleportResult.errorMsg,
        "ABYSSAL_PARTICIPANT_TRANSFER_TELEPORT_FAILED",
      ),
      characterID: participant.characterID,
      shipID: participant.shipID,
      results,
    };
  }
  applyAbyssalParticipantRoomScopeMetadata(runtimeEntity, roomScope);
  if (participantSession && teleportResult.deferredUntilRelog !== true) {
    const protectionResult = grantAbyssalArrivalProtection(
      targetPocketState, participantSession,
      (teleportResult.data && teleportResult.data.entity) || runtimeEntity,
      deps, { roomIndex: work.targetRoomIndex },
    );
    if (!protectionResult.success) {
      return {
        ...protectionResult,
        characterID: participant.characterID,
        shipID: participant.shipID,
        results,
      };
    }
  }
  if (participantSession) {
    syncInventoryChanges(participantSession, [{
      item: shipUpdate.data,
      previousData: shipUpdate.previousData || persistedShip,
    }], deps);
    if (usesAuthoredAbyssalEnvironmentNotification(targetPocketState, participantSession, deps)) {
      queueAbyssalClientEnvironmentDelivery(targetPocketState, participantSession, deps, {
        phase: "transfer",
        activateNpcControllers: false,
      });
    }
  }
  Object.assign(work, { teleportResult });
}

function commitRoomParticipant(ports, work) {
  const {
    cloneValue,
    upsertAbyssalParticipantRosterEntry,
    commitPocketStateDurably,
  } = ports;
  const {
    participant,
    targetRoomIndex,
    deps,
    results,
    teleportResult,
  } = work;
  let {
    workingState,
  } = work;
  const roster = upsertAbyssalParticipantRosterEntry(workingState, {
    ...participant,
    status: participant.status,
    currentRoomIndex: targetRoomIndex,
    lastSeenAtMs: toInt(deps.now(), Date.now()),
  });
  const commitResult = commitPocketStateDurably(
    workingState.instanceID,
    { participantRoster: roster },
    deps,
    { verifyReadBack: true, forceWrite: true },
  );
  if (!commitResult || commitResult.success !== true) {
    return {
      success: false,
      errorMsg: normalizeText(
        commitResult && commitResult.errorMsg,
        "ABYSSAL_PARTICIPANT_TRANSFER_ROSTER_PERSIST_FAILED",
      ),
      characterID: participant.characterID,
      shipID: participant.shipID,
      results,
    };
  }
  workingState = cloneValue(commitResult.committedState || commitResult.state);
  results.push({
    characterID: participant.characterID,
    shipID: participant.shipID,
    deferredUntilRelog: teleportResult.deferredUntilRelog === true,
  });
  Object.assign(work, { workingState });
}

function markCurrentRoomConduitOpen(ports, pocketState, session = null, deps = ports.getDependencies(), reason = "objective-complete", openedAtMsOverride = null) {
  const {
    getActivePocketStateByInstanceID,
    buildPlaceholderRoomState,
    getPlaceholderRoomEntry,
  } = ports;
  const resolvedPocketState = pocketState && pocketState.instanceID
  ? getActivePocketStateByInstanceID(pocketState.instanceID) || pocketState
  : null;
  const roomState = buildPlaceholderRoomState(resolvedPocketState);
  const roomEntry = getPlaceholderRoomEntry(resolvedPocketState, roomState.currentRoomIndex);
  const conduitItemID = toInt(roomEntry && roomEntry.conduitItemID, 0);
  if (!resolvedPocketState || conduitItemID <= 0 || roomEntry.conduitOpen === true) {
    return resolvedPocketState || pocketState;
  }
  const work = { pocketState, session, deps, reason, openedAtMsOverride, resolvedPocketState, roomState, roomEntry, conduitItemID };
  inspectConduitPresentation(ports, work);
  persistConduitPresentation(ports, work);
  publishConduitPresentation(ports, work);
  return commitConduitOpenState(ports, work);
}

function inspectConduitPresentation(ports, work) {
  const {
    log,
  } = ports;
  const {
    deps,
    openedAtMsOverride,
    resolvedPocketState,
    roomState,
    roomEntry,
    conduitItemID,
  } = work;
  const openedAtMs = toInt(openedAtMsOverride, toInt(deps.now(), 0));
  const lookup = resolveCurrentRoomConduitSceneEntity(ports,
    resolvedPocketState,
    roomState,
    roomEntry,
    conduitItemID,
    deps,
  );
  log.info(
    `[AbyssalMgr] Abyssal conduit animation lookup ` +
      `instance=${toInt(resolvedPocketState.instanceID, 0)} room=${roomState.currentRoomIndex} ` +
      `itemID=${conduitItemID} systemID=${lookup.systemID} ` +
      `scene=${lookup.scene ? "found" : "missing"} ` +
      `dynamicFound=${lookup.diagnostics.dynamicFound} ` +
      `staticFound=${lookup.diagnostics.staticFound} ` +
      `bubbleFound=${lookup.diagnostics.bubbleFound} ` +
      `inventoryFound=${lookup.diagnostics.inventoryFound} ` +
      `entityKind=${lookup.diagnostics.entityKind || "none"} ` +
      `entityTypeID=${lookup.diagnostics.entityTypeID} ` +
      `entityInstanceID=${lookup.diagnostics.entityInstanceID}`,
  );
  Object.assign(work, { openedAtMs, lookup });
}

function persistConduitPresentation(ports, work) {
  const {
    parseCustomInfo,
    applyAbyssalGatePresentationState,
  } = ports;
  const {
    deps,
    lookup,
    openedAtMs,
    roomEntry,
    reason,
    conduitItemID,
  } = work;
  const markerItem = lookup.markerItem;
  let markerPersisted = false;
  let markerPersistReason = markerItem ? "NOT_ATTEMPTED" : "ITEM_MISSING";
  if (markerItem) {
    const customInfo = parseCustomInfo(markerItem.customInfo);
    const presentationState = applyAbyssalGatePresentationState({}, {
      open: true,
      openedAtMs,
    });
    const nextCustomInfo = JSON.stringify({
      ...customInfo,
      animationState: presentationState.animationState,
      isAbyssGateOpen: presentationState.isAbyssGateOpen,
      evejsAbyssalConduitOpen: presentationState.evejsAbyssalConduitOpen,
      dungeonMaterializedGate: presentationState.dungeonMaterializedGate,
      dungeonGateState: presentationState.dungeonGateState,
      evejsAbyssalConduitOpenedAtMs: presentationState.evejsAbyssalConduitOpenedAtMs,
      evejsAbyssalPocketMarker: {
        ...(customInfo.evejsAbyssalPocketMarker || {}),
        deliveryState: normalizeText(
          lookup.entity && (
            lookup.entity.abyssalRoomDeliveryState ||
            lookup.entity.evejsAbyssalRoomDeliveryState
          ),
          normalizeText(
            roomEntry.deliveryState,
            normalizeText(
              customInfo.evejsAbyssalPocketMarker &&
                customInfo.evejsAbyssalPocketMarker.deliveryState,
              "",
            ),
          ),
        ),
        transitionToken: toInt(
          roomEntry.deliveryTransitionToken,
          toInt(customInfo.evejsAbyssalPocketMarker && customInfo.evejsAbyssalPocketMarker.transitionToken, 0),
        ),
        deliveryTransitionToken: toInt(
          roomEntry.deliveryTransitionToken,
          toInt(customInfo.evejsAbyssalPocketMarker && customInfo.evejsAbyssalPocketMarker.deliveryTransitionToken, 0),
        ),
        selectedRoomLayoutID: normalizeText(
          roomEntry.selectedRoomLayoutID,
          normalizeText(customInfo.evejsAbyssalPocketMarker && customInfo.evejsAbyssalPocketMarker.selectedRoomLayoutID, ""),
        ),
        conduitOpen: true,
        conduitOpenedAtMs: openedAtMs,
        conduitOpenReason: normalizeText(reason, "objective-complete"),
      },
    });
    if (typeof deps.updateInventoryItem === "function") {
      const updateResult = deps.updateInventoryItem(conduitItemID, (currentItem) => ({
        ...currentItem,
        customInfo: nextCustomInfo,
      }));
      markerPersisted = Boolean(updateResult && updateResult.success);
      markerPersistReason = markerPersisted
        ? "OK"
        : normalizeText(updateResult && updateResult.errorMsg, "UPDATE_FAILED");
      markerItem.customInfo = markerPersisted && updateResult.data
        ? updateResult.data.customInfo
        : nextCustomInfo;
    } else {
      markerItem.customInfo = nextCustomInfo;
      markerPersistReason = "UPDATE_HOOK_MISSING";
    }
  }
  Object.assign(work, { markerPersisted, markerPersistReason });
}

function publishConduitPresentation(ports, work) {
  const {
    log,
    applyAbyssalGatePresentationState,
  } = ports;
  const {
    lookup,
    openedAtMs,
    resolvedPocketState,
    conduitItemID,
    markerPersisted,
    markerPersistReason,
  } = work;
  const scene = lookup.scene;
  const conduitEntity = lookup.success ? lookup.entity : null;
  let recipientCount = 0;
  let updateSent = false;
  let updateReason = lookup.reason || "OK";
  if (conduitEntity) {
    applyAbyssalGatePresentationState(conduitEntity, {
      open: true,
      openedAtMs,
    });
    if (typeof scene.broadcastSlimItemChanges === "function") {
      recipientCount = toInt(scene.broadcastSlimItemChanges([conduitEntity]), 0);
      updateSent = recipientCount > 0;
      updateReason = updateSent ? "OK" : "NO_VISIBLE_RECIPIENTS";
    }
  }
  const fxStatus = conduitEntity ? "SLIM_ANIMATION_STATE" : `SLIM_ANIMATION_STATE_${lookup.reason || "ENTITY_MISSING"}`;
  log.info(
    `[AbyssalMgr] Abyssal conduit animation slim update ` +
      `instance=${toInt(resolvedPocketState.instanceID, 0)} itemID=${conduitItemID} ` +
      `animationState=${conduitEntity ? toInt(conduitEntity.animationState, 0) : 0} ` +
      `markerPersisted=${markerPersisted} markerPersistReason=${markerPersistReason} ` +
      `recipientCount=${recipientCount} updateSent=${updateSent} reason=${updateReason}`,
  );
  Object.assign(work, { fxStatus });
}

function commitConduitOpenState(ports, work) {
  const {
    log,
    setPlaceholderRoomEntry,
    updatePocketState,
    buildPocketStateForCurrentRoom,
  } = ports;
  const {
    resolvedPocketState,
    roomState,
    roomEntry,
    openedAtMs,
    fxStatus,
    conduitItemID,
    reason,
  } = work;
  const nextRoomState = setPlaceholderRoomEntry(
    resolvedPocketState,
    roomState.currentRoomIndex,
    {
      ...roomEntry,
      conduitOpen: true,
      conduitOpenedAtMs: openedAtMs,
      conduitOpenFxStatus: fxStatus,
    },
  );
  const updatedPocketState = updatePocketState(resolvedPocketState.instanceID, {
    ...buildPocketStateForCurrentRoom(resolvedPocketState, nextRoomState),
  }) || resolvedPocketState;
  log.info(
    `[AbyssalMgr] Conduit opened char=${toInt(updatedPocketState.characterID, 0)} ` +
      `instance=${toInt(updatedPocketState.instanceID, 0)} room=${roomState.currentRoomIndex} ` +
      `conduitID=${conduitItemID} fx=${fxStatus} reason=${normalizeText(reason, "objective-complete")}`,
  );
  return updatedPocketState;
}

function createAbyssalRoomProgression(ports) {
  return {
    resolveAbyssalRosterParticipantSession: resolveAbyssalRosterParticipantSession.bind(null, ports),
    moveOtherAbyssalParticipantsToRoom: moveOtherAbyssalParticipantsToRoom.bind(null, ports),
    collectConduitAnimationLookupDiagnostics: collectConduitAnimationLookupDiagnostics.bind(null, ports),
    resolveCurrentRoomConduitSceneEntity: resolveCurrentRoomConduitSceneEntity.bind(null, ports),
    markCurrentRoomConduitOpen: markCurrentRoomConduitOpen.bind(null, ports),
  };
}

module.exports = { createAbyssalRoomProgression };
