"use strict";

const { normalizeText } = require("../domain/abyssalValueUtils");
const { grantAbyssalArrivalProtection } = require("./abyssalArrivalProtection");

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

// Synchronous source commitment and movement use a per-call context, not a state
// registry. The coordinator owns irreversibility, rollback and the open batch.
function restoreAbyssalTransferSourceRoom({
  getActivePocketStateByInstanceID,
  getPendingAbyssalTransitionState,
  setAbyssalRoomEntityDeliveryState,
  ABYSSAL_ROOM_DELIVERY_STATE,
  activateAbyssalRoomNpcControllers,
  activateSuppressorControllersForPocketRoom,
  deliverSuppressorPresentationForSession,
  updatePocketState,
  cloneValue,
  ensureBoundaryControllerForPocketState,
  getPocketScene,
  stampAbyssalParticipantRoomScope,
}, {
  pocketState, currentRoomIndex, nextRoomIndex, session, deps,
}, failureReason) {
  const activeFailureState =
    getActivePocketStateByInstanceID(toInt(pocketState.instanceID, 0)) || pocketState;
  const pendingFailureState = getPendingAbyssalTransitionState(activeFailureState);
  const hiddenResult = setAbyssalRoomEntityDeliveryState(
    activeFailureState,
    nextRoomIndex,
    ABYSSAL_ROOM_DELIVERY_STATE.PREWARMED_HIDDEN,
    session,
    deps,
    { transitionToken: 0 },
  );
  const restoredResult = setAbyssalRoomEntityDeliveryState(
    hiddenResult.pocketState,
    currentRoomIndex,
    ABYSSAL_ROOM_DELIVERY_STATE.VISIBLE,
    session,
    deps,
    { transitionToken: 0 },
  );
  activateAbyssalRoomNpcControllers(restoredResult.pocketState, session, deps, {
    roomIndex: currentRoomIndex,
    expectPaused: true,
    allowAlreadyActive: true,
    roomActive: true,
    degradeOnFailure: false,
  });
  activateSuppressorControllersForPocketRoom(
    restoredResult.pocketState,
    currentRoomIndex,
    deps,
  );
  deliverSuppressorPresentationForSession(
    restoredResult.pocketState,
    session,
    deps,
    {
      roomIndex: currentRoomIndex,
      reason: "room-transfer-pre-delivery-failed",
      allowRetry: true,
    },
  );
  const settledPocketState = updatePocketState(toInt(pocketState.instanceID, 0), {
    pendingTransitionState: {
      ...cloneValue(pendingFailureState || {}),
      status: "failed",
      currentPhase: "failed",
      committedRoomIndex: currentRoomIndex,
      sourceControllersPaused: false,
      destinationControllersActive: false,
      destinationVisibleCount: hiddenResult.visibleCount,
      earlyVisibilityViolationCount: hiddenResult.earlyVisibilityViolationCount,
      failureReason: normalizeText(
        failureReason,
        "ABYSSAL_TRANSFER_PRE_DELIVERY_FAILED",
      ),
    },
  });
  if (settledPocketState) {
    ensureBoundaryControllerForPocketState(
      settledPocketState,
      deps,
      toInt(deps.now(), 0),
    );
  }
  const sourceScene = getPocketScene(activeFailureState, deps);
  const sourceShipEntity = sourceScene && typeof sourceScene.getEntityByID === "function"
    ? sourceScene.getEntityByID(toInt(activeFailureState && activeFailureState.shipID, 0))
    : null;
  stampAbyssalParticipantRoomScope(
    activeFailureState,
    currentRoomIndex,
    session,
    sourceShipEntity,
    deps,
    { persist: true },
  );
  return { hiddenResult, restoredResult };
}

function validateAbyssalTransferSourceScene({
  log,
  formatVectorForLog,
}, {
  pocketState, currentRoomIndex, nextRoomIndex, session, deps,
  runtime, currentScene, currentShipEntity, expectedSceneKey, persistedShip,
  transferTargetPosition, canCommitOrderedDestinationDelivery,
  restoreSourceRoomAfterPreDeliveryFailure,
}) {
  const sessionSceneKey = normalizeText(
    session && (session.spaceSceneKey || (session._space && session._space.sceneKey)),
    "",
  );
  const runtimeShipSceneKey = normalizeText(currentShipEntity && currentShipEntity.sceneKey, sessionSceneKey);
  log.info(
    `[AbyssalTransfer] commit begin run=${toInt(pocketState.instanceID, 0)} ` +
      `fromRoom=${currentRoomIndex} toRoom=${nextRoomIndex} ` +
      `sessionLocation=${toInt(session && session.locationid, 0)} ` +
      `sessionSceneKey=${sessionSceneKey || "none"} ` +
      `shipPersistedLocation=${toInt(persistedShip && persistedShip.locationID, 0)} ` +
      `shipRuntimeSceneKey=${runtimeShipSceneKey || "none"} ` +
      `targetPosition=${formatVectorForLog(transferTargetPosition)}`,
  );
  if (
    !runtime ||
    !currentScene ||
    normalizeText(currentScene.sceneKey, "") !== expectedSceneKey ||
    sessionSceneKey !== expectedSceneKey ||
    runtimeShipSceneKey !== expectedSceneKey
  ) {
    log.warn(
      `[AbyssalTransfer] refused cross-scene attach run=${toInt(pocketState.instanceID, 0)} ` +
        `expected=${expectedSceneKey || "none"} ` +
        `attempted=${normalizeText(currentScene && currentScene.sceneKey, sessionSceneKey || "none")}`,
    );
    restoreSourceRoomAfterPreDeliveryFailure(
      "ABYSSAL_TRANSFER_SCENE_INVARIANT_FAILED",
    );
    return {
      success: false,
      errorMsg: "ABYSSAL_TRANSFER_SCENE_INVARIANT_FAILED",
    };
  }
  if (!currentShipEntity || typeof runtime.teleportSessionShipForAbyssalTransition !== "function") {
    restoreSourceRoomAfterPreDeliveryFailure(
      "ABYSSAL_TRANSFER_TELEPORT_UNSUPPORTED",
    );
    return {
      success: false,
      errorMsg: "ABYSSAL_TRANSFER_TELEPORT_UNSUPPORTED",
    };
  }
  if (!canCommitOrderedDestinationDelivery()) {
    restoreSourceRoomAfterPreDeliveryFailure(
      "ABYSSAL_TRANSFER_DESTINY_NOT_READY",
    );
    return {
      success: false,
      errorMsg: "ABYSSAL_TRANSFER_DESTINY_NOT_READY",
    };
  }
  return { success: true };
}

function retireAbyssalTransferSourcePlayerObjects({
  cleanupExactAbyssalScannerProbes,
  abandonExactAbyssalSourceRoomPlayerCompanions,
  retireExactAbyssalSourceRoomPlayerObjects,
}, {
  pocketState, currentRoomIndex, deps,
}, onFailure) {
  const sourceProbeCleanup = cleanupExactAbyssalScannerProbes(
    pocketState,
    deps,
    "room-transition",
    { roomIndexes: [currentRoomIndex] },
  );
  if (
    toInt(
      sourceProbeCleanup && sourceProbeCleanup.cleanupSummary &&
        sourceProbeCleanup.cleanupSummary.failedScannerProbeCleanup,
      0,
    ) > 0
  ) {
    return onFailure("ABYSSAL_SOURCE_PROBE_CLEANUP_FAILED");
  }
  const sourceCompanionAbandon = abandonExactAbyssalSourceRoomPlayerCompanions(
    pocketState,
    currentRoomIndex,
    deps,
    "room-transition",
  );
  if (!sourceCompanionAbandon.success) {
    return onFailure(
      sourceCompanionAbandon.errorMsg ||
        "ABYSSAL_SOURCE_PLAYER_COMPANION_ABANDON_FAILED",
    );
  }
  const sourcePlayerObjectRetirement = retireExactAbyssalSourceRoomPlayerObjects(
    pocketState,
    currentRoomIndex,
    deps,
    "room-transition",
  );
  if (!sourcePlayerObjectRetirement.success) {
    return onFailure(
      sourcePlayerObjectRetirement.errorMsg ||
        "ABYSSAL_SOURCE_PLAYER_OBJECT_RETIREMENT_FAILED",
    );
  }
  return { success: true };
}

function pauseAbyssalTransferSourceControllers({
  pauseSuppressorControllersForRoom,
  stopSuppressorPresentationForPocketSession,
  clearSuppressorDebugHistoryForRun,
}, { pocketState, currentRoomIndex, session, deps }) {
  pauseSuppressorControllersForRoom(
    toInt(pocketState.instanceID, 0),
    currentRoomIndex,
    "room-transfer-start",
  );
  stopSuppressorPresentationForPocketSession(pocketState, session, deps, {
    roomIndex: currentRoomIndex,
    reason: "room-transfer",
  });
  clearSuppressorDebugHistoryForRun(toInt(pocketState.instanceID, 0));
}

function commitAbyssalTransferSourceRoom({
  validateAbyssalTransferSourceScene,
  buildAbyssalClientEnvironmentSelection,
  retireAbyssalTransferSourcePlayerObjects,
  updatePocketState,
  cloneValue,
  getPendingAbyssalTransitionState,
  getActivePocketStateByInstanceID,
  beginAbyssalPocketMutationBatch,
  pauseAbyssalTransferSourceControllers,
  listAbyssalRoomRetirementEntityIDs,
  normalizeAbyssalParticipantRoster,
}, context) {
  const {
    pocketState, currentRoomIndex, nextRoomIndex, session, deps,
    isolatedSceneDescriptor, transitionMutationBatch, recordTransferPhase,
    settleCommittedDestinationFailure, markSourceCommitIrreversible,
    canCommitOrderedDestinationDelivery,
  } = context;
  let sourceCommitIrreversible = false;
  let authoredEnvironmentNotification = false;
  let oldRoomEntityIDs = [];
  if (isolatedSceneDescriptor) {
    const validationResult = validateAbyssalTransferSourceScene(context);
    if (!validationResult.success) return validationResult;
    authoredEnvironmentNotification = Boolean(
      buildAbyssalClientEnvironmentSelection(
        pocketState,
        session,
        deps,
        { roomIndex: nextRoomIndex },
      ),
    );

    if (!canCommitOrderedDestinationDelivery()) {
      return settleCommittedDestinationFailure(
        "ABYSSAL_TRANSFER_DESTINY_NOT_READY_BEFORE_SOURCE_COMMIT",
      );
    }

    const retirementResult = retireAbyssalTransferSourcePlayerObjects(
      context, settleCommittedDestinationFailure,
    );
    if (!retirementResult.success) return retirementResult;

    // Environment notifications are reversible presentation. The source-room
    // handoff only becomes irreversible after every exact source-owned object
    // has been retired successfully. Marking the first notification as the
    // commit point caused a retirement failure to evacuate and purge an
    // otherwise intact source room instead of restoring it for a safe retry.
    sourceCommitIrreversible = true;
    markSourceCommitIrreversible();
    updatePocketState(toInt(pocketState.instanceID, 0), {
      pendingTransitionState: {
        ...cloneValue(
          getPendingAbyssalTransitionState(
            getActivePocketStateByInstanceID(toInt(pocketState.instanceID, 0)) ||
              pocketState,
          ),
        ),
        currentPhase: "source-player-objects-retired",
        sourceCommitIrreversible: true,
        sourceCommitIrreversibleAtMs: toInt(deps.now(), 0),
      },
    });
    if (transitionMutationBatch.enabled) {
      const batchStartResult = beginAbyssalPocketMutationBatch(
        toInt(pocketState.instanceID, 0),
        deps,
      );
      if (!batchStartResult.success) {
        return settleCommittedDestinationFailure(
          batchStartResult.errorMsg || "ABYSSAL_TRANSFER_PERSISTENCE_BATCH_START_FAILED",
        );
      }
      transitionMutationBatch.active = true;
    }
    recordTransferPhase("source-irreversible-committed");

    pauseAbyssalTransferSourceControllers(context);

    const sourcePocketStateForRetirement =
      getActivePocketStateByInstanceID(toInt(pocketState.instanceID, 0)) || pocketState;
    oldRoomEntityIDs = listAbyssalRoomRetirementEntityIDs(
      sourcePocketStateForRetirement,
      currentRoomIndex,
      session,
      deps,
    ).filter((entityID) => {
      const participantShipIDs = new Set(
        normalizeAbyssalParticipantRoster(sourcePocketStateForRetirement)
          .map((participant) => participant.shipID),
      );
      return entityID > 0 && !participantShipIDs.has(entityID);
    });
  } else {
    const retirementResult = retireAbyssalTransferSourcePlayerObjects(
      context, (errorMsg) => ({ success: false, errorMsg }),
    );
    if (!retirementResult.success) return retirementResult;
    pauseAbyssalTransferSourceControllers(context);
  }
  return { success: true, sourceCommitIrreversible, authoredEnvironmentNotification, oldRoomEntityIDs };
}

function deliverAbyssalIsolatedTransferShip({
  syncInventoryChanges,
  getObjectPosition,
  log,
  formatVectorForLog,
  recordAbyssalEnvironmentSequenceEvent,
  advanceAbyssalRoomTransferLifecycle,
}, {
  pocketState, currentRoomIndex, nextRoomIndex, session, deps,
  validation, isolatedSceneDescriptor, runtime, currentShipEntity, expectedSceneKey,
  persistedShip, plannedNextPocketState, nextRoomScopeMetadata,
  transferTargetPosition, transferTargetDirection, recordTransferPhase,
  settleCommittedDestinationFailure,
}) {
  let movedShip = null;
  let attachedEntity = null;
  let transferDestinyStamp = 0;
  let transitionMode = "attach-session";

  const shipUpdate =
    deps && typeof deps.updateShipItem === "function"
      ? deps.updateShipItem(validation.data.context.shipID, (currentItem) => ({
        ...currentItem,
        locationID: isolatedSceneDescriptor.locationID,
        flagID: 0,
        spaceState: {
          ...(currentItem && currentItem.spaceState || {}),
          ...plannedNextPocketState.shipSpawnState,
          ...nextRoomScopeMetadata,
          systemID: isolatedSceneDescriptor.locationID,
        },
      }))
      : null;
  if (!shipUpdate || !shipUpdate.success || !shipUpdate.data) {
    return settleCommittedDestinationFailure(
      shipUpdate && shipUpdate.errorMsg || "ABYSSAL_TRANSFER_SHIP_UPDATE_FAILED",
    );
  }
  movedShip = shipUpdate.data;
  syncInventoryChanges(session, [{
    item: movedShip,
    previousData: shipUpdate.previousData || persistedShip || validation.data.shipItem,
  }], deps);
  session.locationid = isolatedSceneDescriptor.locationID;
  session.solarsystemid = isolatedSceneDescriptor.locationID;
  session.solarsystemid2 = isolatedSceneDescriptor.locationID;
  session.shipID = movedShip.itemID;
  session.shipid = movedShip.itemID;
  session.activeShipID = movedShip.itemID;
  session.activeShipId = movedShip.itemID;
  session.shipTypeID = movedShip.typeID;
  session.spaceSceneKey = expectedSceneKey;
  session.spaceInstanceID = isolatedSceneDescriptor.instanceID;
  if (session._space) {
    session._space.systemID = isolatedSceneDescriptor.locationID;
    session._space.locationID = isolatedSceneDescriptor.locationID;
    session._space.sceneKey = expectedSceneKey;
    session._space.sceneKind = "abyssal";
    session._space.instanceID = isolatedSceneDescriptor.instanceID;
    session._space.sourceSolarSystemID = isolatedSceneDescriptor.sourceSolarSystemID;
  }

  const oldPosition = getObjectPosition(currentShipEntity);
  const oldBubbleID = toInt(currentShipEntity && currentShipEntity.bubbleID, 0);
  const teleportResult = runtime.teleportSessionShipForAbyssalTransition(
    session,
    transferTargetPosition,
    {
      direction: transferTargetDirection,
      suppressVisibilityReconciliation: true,
      broadcastMovement: false,
    },
  );
  if (!teleportResult || !teleportResult.success) {
    return settleCommittedDestinationFailure(
      teleportResult && teleportResult.errorMsg || "ABYSSAL_TRANSFER_TELEPORT_FAILED",
    );
  }
  transferDestinyStamp = toInt(teleportResult.data && teleportResult.data.stamp, 0);
  transitionMode = "abyssal-run-teleport";
  attachedEntity =
    teleportResult.data && teleportResult.data.entity
      ? teleportResult.data.entity
      : currentShipEntity;
  if (attachedEntity) {
    attachedEntity.locationID = isolatedSceneDescriptor.locationID;
    attachedEntity.systemID = isolatedSceneDescriptor.locationID;
    attachedEntity.sceneKey = expectedSceneKey;
    attachedEntity.sceneKind = "abyssal";
    attachedEntity.instanceScope = "abyssal";
    attachedEntity.abyssalRunID = isolatedSceneDescriptor.instanceID;
    attachedEntity.evejsAbyssalInstanceID = isolatedSceneDescriptor.instanceID;
  }
  log.info(
    `[AbyssalTransfer] ship repositioned sceneKey=${expectedSceneKey} ` +
      `fromRoom=${currentRoomIndex} toRoom=${nextRoomIndex} ` +
      `oldPosition=${formatVectorForLog(oldPosition)} ` +
      `newPosition=${formatVectorForLog(attachedEntity && attachedEntity.position)} ` +
      `oldBubble=${oldBubbleID} newBubble=${toInt(attachedEntity && attachedEntity.bubbleID, 0)}`,
  );
  recordTransferPhase("ship-repositioned");
  recordAbyssalEnvironmentSequenceEvent(
    pocketState,
    session,
    nextRoomIndex,
    "ship_reposition",
    deps,
    { sourceRoomIndex: currentRoomIndex },
  );
  advanceAbyssalRoomTransferLifecycle(
    pocketState,
    session,
    deps,
    "ship_repositioned",
    { fromRoom: currentRoomIndex, toRoom: nextRoomIndex },
  );
  return { success: true, movedShip, attachedEntity, transferDestinyStamp, transitionMode };
}

function deliverAbyssalLegacyTransferShip({
  syncInventoryChanges,
}, {
  validation, session, deps, runtime, plannedNextPocketState, nextRoomScopeMetadata,
  currentShipEntity, transferTargetPosition, transferTargetDirection,
}) {
  let movedShip = null;
  let attachedEntity = null;
  let transitionMode = "attach-session";

  const moveResult = deps.moveShipToSpace(
    validation.data.context.shipID,
    plannedNextPocketState.solarSystemID,
    {
      ...plannedNextPocketState.shipSpawnState,
      ...nextRoomScopeMetadata,
    },
  );
  if (!moveResult || !moveResult.success || !moveResult.data) {
    return {
      success: false,
      errorMsg: moveResult && moveResult.errorMsg || "ROOM_TRANSFER_MOVE_FAILED",
    };
  }
  movedShip = moveResult.data;
  syncInventoryChanges(session, [{
    item: movedShip,
    previousData: moveResult.previousData || validation.data.shipItem,
  }], deps);
  session.locationid = plannedNextPocketState.solarSystemID;
  session.solarsystemid = plannedNextPocketState.solarSystemID;
  session.solarsystemid2 = plannedNextPocketState.solarSystemID;
  session.shipID = movedShip.itemID;
  session.shipid = movedShip.itemID;
  session.activeShipID = movedShip.itemID;
  session.activeShipId = movedShip.itemID;
  session.shipTypeID = movedShip.typeID;

  const canUseInPlaceTeleport = Boolean(
    runtime &&
      typeof runtime.teleportSessionShipForAbyssalTransition === "function" &&
      currentShipEntity &&
      session &&
      session._space &&
      toInt(session._space.systemID, 0) === plannedNextPocketState.solarSystemID,
  );
  if (canUseInPlaceTeleport) {
    transitionMode = "teleport-in-place";
    const teleportResult = runtime.teleportSessionShipForAbyssalTransition(
      session,
      transferTargetPosition,
      {
        direction: transferTargetDirection,
      },
    );
    if (!teleportResult || !teleportResult.success) {
      return {
        success: false,
        errorMsg: teleportResult && teleportResult.errorMsg || "ROOM_TRANSFER_TELEPORT_FAILED",
      };
    }
    attachedEntity =
      teleportResult.data && teleportResult.data.entity
        ? teleportResult.data.entity
        : currentShipEntity;
  } else {
    attachedEntity = runtime.attachSession(session, movedShip, {
      systemID: plannedNextPocketState.solarSystemID,
      pendingUndockMovement: false,
      broadcast: true,
      spawnStopped: true,
    });
    if (!attachedEntity || !session._space) {
      return {
        success: false,
        errorMsg: "ROOM_TRANSFER_ATTACH_FAILED",
      };
    }
    deps.queuePostSpaceAttachFittingHydration(session, movedShip.itemID, {
      hydrationProfile: "transition",
    });
  }
  return { success: true, movedShip, attachedEntity, transferDestinyStamp: 0, transitionMode };
}

function finalizeAbyssalTransferParticipantScope({
  moveOtherAbyssalParticipantsToRoom,
  getActivePocketStateByInstanceID,
  stampAbyssalParticipantRoomScope,
}, {
  pocketState, currentRoomIndex, nextRoomIndex, session, deps,
  isolatedSceneDescriptor, plannedNextPocketState, movedShip, attachedEntity,
  settleCommittedDestinationFailure,
}) {

  const groupTransferResult = moveOtherAbyssalParticipantsToRoom(
    getActivePocketStateByInstanceID(toInt(pocketState.instanceID, 0)) || pocketState,
    session,
    plannedNextPocketState,
    nextRoomIndex,
    deps,
  );
  if (!groupTransferResult || groupTransferResult.success !== true) {
    if (isolatedSceneDescriptor) {
      return settleCommittedDestinationFailure(
        normalizeText(
          groupTransferResult && groupTransferResult.errorMsg,
          "ABYSSAL_PARTICIPANT_GROUP_TRANSFER_FAILED",
        ),
        { participantTransferResult: groupTransferResult },
      );
    }
    return {
      success: false,
      errorMsg: normalizeText(
        groupTransferResult && groupTransferResult.errorMsg,
        "ABYSSAL_PARTICIPANT_GROUP_TRANSFER_FAILED",
      ),
      participantTransferResult: groupTransferResult,
    };
  }

  const participantScopeResult = stampAbyssalParticipantRoomScope(
    groupTransferResult.pocketState || plannedNextPocketState,
    nextRoomIndex,
    session,
    attachedEntity,
    deps,
    {
      shipID: movedShip && movedShip.itemID,
      persistedShip: movedShip,
      persist: false,
      syncInventory: false,
    },
  );
  if (!participantScopeResult.success) {
    if (isolatedSceneDescriptor) {
      return settleCommittedDestinationFailure(participantScopeResult.errorMsg);
    } else {
      stampAbyssalParticipantRoomScope(
        pocketState,
        currentRoomIndex,
        session,
        attachedEntity,
        deps,
        { persist: true },
      );
    }
    return {
      success: false,
      errorMsg: participantScopeResult.errorMsg,
    };
  }

  const protectionResult = grantAbyssalArrivalProtection(
    plannedNextPocketState, session, attachedEntity, deps, { roomIndex: nextRoomIndex },
  );
  if (!protectionResult.success && isolatedSceneDescriptor) {
    return settleCommittedDestinationFailure(protectionResult.errorMsg);
  }
  return protectionResult;
}

function deliverAbyssalTransferParticipants({
  deliverAbyssalIsolatedTransferShip,
  deliverAbyssalLegacyTransferShip,
  finalizeAbyssalTransferParticipantScope,
}, context) {
  const movementResult = context.isolatedSceneDescriptor
    ? deliverAbyssalIsolatedTransferShip(context)
    : deliverAbyssalLegacyTransferShip(context);
  if (!movementResult.success) return movementResult;
  const scopeResult = finalizeAbyssalTransferParticipantScope({
    ...context,
    movedShip: movementResult.movedShip,
    attachedEntity: movementResult.attachedEntity,
  });
  if (!scopeResult.success) return scopeResult;
  return movementResult;
}

// Capture supplied capabilities once, as the original closure did. Internal
// callbacks are bound once per instance; no runtime state lives in this wiring.
function createAbyssalRoomTransferMovement({
  getActivePocketStateByInstanceID,
  getPendingAbyssalTransitionState,
  setAbyssalRoomEntityDeliveryState,
  ABYSSAL_ROOM_DELIVERY_STATE,
  activateAbyssalRoomNpcControllers,
  activateSuppressorControllersForPocketRoom,
  deliverSuppressorPresentationForSession,
  updatePocketState,
  cloneValue,
  ensureBoundaryControllerForPocketState,
  getPocketScene,
  stampAbyssalParticipantRoomScope,
  log,
  formatVectorForLog,
  cleanupExactAbyssalScannerProbes,
  abandonExactAbyssalSourceRoomPlayerCompanions,
  retireExactAbyssalSourceRoomPlayerObjects,
  pauseSuppressorControllersForRoom,
  stopSuppressorPresentationForPocketSession,
  clearSuppressorDebugHistoryForRun,
  buildAbyssalClientEnvironmentSelection,
  beginAbyssalPocketMutationBatch,
  listAbyssalRoomRetirementEntityIDs,
  normalizeAbyssalParticipantRoster,
  syncInventoryChanges,
  getObjectPosition,
  recordAbyssalEnvironmentSequenceEvent,
  advanceAbyssalRoomTransferLifecycle,
  moveOtherAbyssalParticipantsToRoom,
}) {

  const ports = {
    getActivePocketStateByInstanceID,
    getPendingAbyssalTransitionState,
    setAbyssalRoomEntityDeliveryState,
    ABYSSAL_ROOM_DELIVERY_STATE,
    activateAbyssalRoomNpcControllers,
    activateSuppressorControllersForPocketRoom,
    deliverSuppressorPresentationForSession,
    updatePocketState,
    cloneValue,
    ensureBoundaryControllerForPocketState,
    getPocketScene,
    stampAbyssalParticipantRoomScope,
    log,
    formatVectorForLog,
    cleanupExactAbyssalScannerProbes,
    abandonExactAbyssalSourceRoomPlayerCompanions,
    retireExactAbyssalSourceRoomPlayerObjects,
    pauseSuppressorControllersForRoom,
    stopSuppressorPresentationForPocketSession,
    clearSuppressorDebugHistoryForRun,
    buildAbyssalClientEnvironmentSelection,
    beginAbyssalPocketMutationBatch,
    listAbyssalRoomRetirementEntityIDs,
    normalizeAbyssalParticipantRoster,
    syncInventoryChanges,
    getObjectPosition,
    recordAbyssalEnvironmentSequenceEvent,
    advanceAbyssalRoomTransferLifecycle,
    moveOtherAbyssalParticipantsToRoom,
  };
  ports.restoreAbyssalTransferSourceRoom = restoreAbyssalTransferSourceRoom.bind(null, ports);
  ports.validateAbyssalTransferSourceScene = validateAbyssalTransferSourceScene.bind(null, ports);
  ports.retireAbyssalTransferSourcePlayerObjects = retireAbyssalTransferSourcePlayerObjects.bind(null, ports);
  ports.pauseAbyssalTransferSourceControllers = pauseAbyssalTransferSourceControllers.bind(null, ports);
  ports.commitAbyssalTransferSourceRoom = commitAbyssalTransferSourceRoom.bind(null, ports);
  ports.deliverAbyssalIsolatedTransferShip = deliverAbyssalIsolatedTransferShip.bind(null, ports);
  ports.deliverAbyssalLegacyTransferShip = deliverAbyssalLegacyTransferShip.bind(null, ports);
  ports.finalizeAbyssalTransferParticipantScope = finalizeAbyssalTransferParticipantScope.bind(null, ports);
  ports.deliverAbyssalTransferParticipants = deliverAbyssalTransferParticipants.bind(null, ports);
  Object.freeze(ports);
  return {
    restoreAbyssalTransferSourceRoom: ports.restoreAbyssalTransferSourceRoom,
    commitAbyssalTransferSourceRoom: ports.commitAbyssalTransferSourceRoom,
    deliverAbyssalTransferParticipants: ports.deliverAbyssalTransferParticipants,
  };
}

module.exports = { createAbyssalRoomTransferMovement };
