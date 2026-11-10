"use strict";

const { normalizeText } = require("../domain/abyssalValueUtils");
const { grantAbyssalArrivalProtection } = require("./abyssalArrivalProtection");

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

// Entry relocation and committed-move rollback. Inventory, scene, session,
// participant scope and durable recovery authorities remain injected.
function restorePreviousShipLocation({
  cloneValue,
  restoreAbyssalSpaceSessionFields,
  syncInventoryChanges,
  log,
  getCharacterID,
},
  session,
  movedShip,
  previousData,
  deps,
  reason,
  options = {},
) {
  if (!movedShip || !previousData) {
    return {
      success: false,
      errorMsg: "RESTORE_PREVIOUS_STATE_UNAVAILABLE",
    };
  }
  const previousSystemID = toInt(previousData.locationID, 0);
  const previousSpaceState =
    previousData.spaceState && typeof previousData.spaceState === "object"
      ? {
          ...cloneValue(previousData.spaceState),
          customInfo: previousData.customInfo,
        }
      : {
          customInfo: previousData.customInfo,
        };
  if (previousSystemID <= 0) {
    return {
      success: false,
      errorMsg: "RESTORE_PREVIOUS_SYSTEM_UNAVAILABLE",
    };
  }
  const restoreResult = deps.moveShipToSpace(
    movedShip.itemID,
    previousSystemID,
    previousSpaceState,
  );
  if (restoreResult && restoreResult.success && restoreResult.data) {
    const runtime = deps;
    if (runtime && session && session._space && typeof runtime.detachSession === "function") {
      runtime.detachSession(session, {
        broadcast: false,
        lifecycleReason: "abyssal-entry-rollback",
      });
    }
    const staleScene = runtime && typeof runtime.findSceneContainingDynamicEntity === "function"
      ? runtime.findSceneContainingDynamicEntity(toInt(movedShip.itemID, 0))
      : null;
    if (staleScene && typeof staleScene.removeDynamicEntity === "function") {
      staleScene.removeDynamicEntity(toInt(movedShip.itemID, 0), {
        broadcast: false,
        lifecycleReason: "abyssal-entry-rollback",
      });
    }
    if (options.previousSessionFields) {
      restoreAbyssalSpaceSessionFields(session, options.previousSessionFields);
    } else if (session) {
      session.locationid = previousSystemID;
      session.solarsystemid = previousSystemID;
      session.solarsystemid2 = previousSystemID;
      session.shipID = restoreResult.data.itemID;
      session.shipid = restoreResult.data.itemID;
      session.activeShipID = restoreResult.data.itemID;
      session.activeShipId = restoreResult.data.itemID;
      session.shipTypeID = restoreResult.data.typeID;
    }
    const restoredEntity = runtime && typeof runtime.attachSession === "function"
      ? runtime.attachSession(session, restoreResult.data, {
          systemID: previousSystemID,
          reconcileUniverseSites: true,
          spawnAsteroidBeltRats: true,
          pendingUndockMovement: false,
          broadcast: true,
          spawnStopped: true,
        })
      : null;
    syncInventoryChanges(session, [{
      item: restoreResult.data,
      previousData: movedShip,
    }], deps);
    log.warn(
      `[AbyssalMgr] Restored previous ship position after failed pocket transition ` +
        `char=${getCharacterID(session)} ship=${movedShip.itemID} system=${previousSystemID} ` +
        `reason=${normalizeText(reason, "UNKNOWN")}`,
    );
    if (!restoredEntity || !session || !session._space) {
      return {
        success: false,
        committed: true,
        rollbackMoveCommitted: true,
        errorMsg: "RESTORE_PREVIOUS_SCENE_ATTACH_FAILED",
        data: restoreResult.data,
      };
    }
    return {
      ...restoreResult,
      // The live runtime ball - not the entity itself. This result is carried in
      // the entry-failure return value and gets deep-cloned downstream; the ball
      // reaches session -> socket -> _entry -> socket, so cloning it walked a
      // live network socket and only the bounded-clone guard stopped it. No
      // caller ever read the entity off this payload, so publish the id instead.
      restoredEntityID: toInt(restoredEntity.itemID, 0) || null,
      rollbackMoveCommitted: true,
    };
  }
  return restoreResult || {
    success: false,
    errorMsg: "RESTORE_PREVIOUS_POSITION_FAILED",
  };
}

function resolveAbyssalEntryMoveContext({
  validateAbyssalIsolatedSceneRuntime,
  log,
  getObjectPosition,
  captureAbyssalSpaceSessionFields,
}, validation, pocketState, session, deps) {
  const runtime = deps;
  const entryShipSpawnState = validation.data.participantShipSpawnState &&
    typeof validation.data.participantShipSpawnState === "object"
    ? validation.data.participantShipSpawnState
    : pocketState.shipSpawnState;
  const isolatedSceneValidation = validateAbyssalIsolatedSceneRuntime(pocketState, deps);
  if (!isolatedSceneValidation.success) {
    log.warn(
      `[AbyssalScene] isolated entry failed char=${validation.data.context.characterID} ` +
        `trace=${validation.data.traceState.traceItemID} instance=${toInt(pocketState && pocketState.instanceID, 0)} ` +
        `reason=${isolatedSceneValidation.errorMsg}`,
    );
    return {
      success: false,
      errorMsg: isolatedSceneValidation.errorMsg,
    };
  }
  const isolatedSceneDescriptor = isolatedSceneValidation.descriptor || null;
  const isolatedLocationID = toInt(isolatedSceneDescriptor && isolatedSceneDescriptor.locationID, 0);
  const targetLocationID = isolatedLocationID > 0
    ? isolatedLocationID
    : validation.data.context.systemID;
  const sourceScene =
    runtime && typeof runtime.getSceneForSession === "function"
      ? runtime.getSceneForSession(session)
      : null;
  const sourceShipEntity =
    sourceScene && typeof sourceScene.getShipEntityForSession === "function"
      ? sourceScene.getShipEntityForSession(session)
      : runtime && typeof runtime.getEntity === "function"
        ? runtime.getEntity(session, validation.data.context.shipID)
        : null;
  const previousTransitionState = {
    solarSystemID: toInt(
      session && session._space && session._space.systemID,
      validation.data.context.systemID,
    ),
    locationID: toInt(
      validation.data.shipItem && validation.data.shipItem.locationID,
      validation.data.context.systemID,
    ),
    position:
      getObjectPosition(sourceShipEntity) ||
      getObjectPosition(validation.data.shipItem) ||
      null,
    ballID: toInt(
      sourceShipEntity && sourceShipEntity.itemID,
      validation.data.context.shipID,
    ),
    // The ship's Grid bubble label before the move, an integer.
    bubbleID: toInt(sourceShipEntity && sourceShipEntity.bubbleID, 0),
  };
  const previousSessionFields = captureAbyssalSpaceSessionFields(session);

  if (isolatedSceneDescriptor) {
    log.info(
      `[AbyssalScene] entry path selected mode=isolated-scene char=${validation.data.context.characterID} ` +
        `trace=${validation.data.traceState.traceItemID} instance=${toInt(pocketState && pocketState.instanceID, 0)} ` +
        `sourceSolarSystemID=${toInt(isolatedSceneDescriptor.sourceSolarSystemID, 0)} ` +
        `locationID=${toInt(isolatedSceneDescriptor.locationID, 0)} ` +
        `sceneKey=${normalizeText(isolatedSceneDescriptor.sceneKey, "n/a")}`,
    );
    log.info(
      `[AbyssalScene] run prepared mode=isolated-scene char=${validation.data.context.characterID} ` +
        `trace=${validation.data.traceState.traceItemID} instance=${toInt(pocketState && pocketState.instanceID, 0)} ` +
        `sceneKind=${normalizeText(isolatedSceneDescriptor.sceneKind, "n/a")} ` +
        `sceneKey=${normalizeText(isolatedSceneDescriptor.sceneKey, "n/a")} ` +
        `locationID=${toInt(isolatedSceneDescriptor.locationID, 0)}`,
    );
  } else {
    log.info(
      `[AbyssalScene] entry path selected mode=legacy-same-system char=${validation.data.context.characterID} ` +
        `trace=${validation.data.traceState.traceItemID} instance=${toInt(pocketState && pocketState.instanceID, 0)} ` +
        `sourceSolarSystemID=${validation.data.context.systemID} ` +
        `isolation=shared-solar-system-scene`,
    );
  }

  return {
    ready: true,
    context: { validation, pocketState, entryShipSpawnState, isolatedSceneDescriptor, targetLocationID, sourceScene, sourceShipEntity, previousTransitionState, previousSessionFields },
  };
}

function commitAbyssalEntryInventoryMove({
  buildAbyssalParticipantRoomScopeMetadata,
  syncInventoryChanges,
}, context, session, deps) {
  const { validation, pocketState, targetLocationID, entryShipSpawnState } = context;
  const entryRoomScopeMetadata = buildAbyssalParticipantRoomScopeMetadata(pocketState);
  const moveResult = deps.moveShipToSpace(
    validation.data.context.shipID,
    targetLocationID,
    {
      ...entryShipSpawnState,
      ...entryRoomScopeMetadata,
    },
  );
  if (!moveResult || !moveResult.success || !moveResult.data) {
    return {
      success: false,
      errorMsg: moveResult && moveResult.errorMsg || "SHIP_MOVE_FAILED",
    };
  }

  const movedShip = moveResult.data;
  syncInventoryChanges(session, [{
    item: movedShip,
    previousData: moveResult.previousData || {},
  }], deps);

  return { ready: true, moveResult, movedShip };
}

function rollbackAbyssalCommittedEntryMove({
  restorePreviousShipLocation,
  getActivePocketStateByInstanceID,
  updatePocketState,
  cloneValue,
  ensureAbyssalPocketPersistenceReady,
  schedulePlaceholderPocketMaintenance,
  log,
}, context, session, deps, transitionErrorMsg) {
  const { validation, pocketState, movedShip, moveResult, previousSessionFields, targetLocationID } = context;
  const normalizedTransitionError = normalizeText(
    transitionErrorMsg,
    "ABYSSAL_ENTRY_DESTINATION_BIND_FAILED",
  );
  const rollbackResult = restorePreviousShipLocation(
    session,
    movedShip,
    moveResult.previousData || validation.data.shipItem,
    deps,
    normalizedTransitionError,
    { previousSessionFields },
  );
  if (rollbackResult && rollbackResult.success === true) {
    return {
      success: false,
      errorMsg: normalizedTransitionError,
      rollbackResult,
    };
  }

  const failedAtMs = toInt(deps.now(), Date.now());
  const activePocketState =
    getActivePocketStateByInstanceID(toInt(pocketState.instanceID, 0)) ||
    pocketState;
  const retainedPocketState = updatePocketState(activePocketState.instanceID, {
    allowDebugExit: false,
    pendingTransitionState: {
      ...cloneValue(activePocketState.pendingTransitionState || {}),
      status: "pending",
      phase: "entry",
      activationMode: "entry",
      sourceCommitIrreversible: true,
      currentPhase: "entry-rollback-recovery-pending",
      failureReason: normalizedTransitionError,
      rollbackFailureReason: normalizeText(
        rollbackResult && rollbackResult.errorMsg,
        "RESTORE_PREVIOUS_POSITION_FAILED",
      ),
      lastFailedAtMs: failedAtMs,
    },
    entryRecoveryState: {
      ...cloneValue(activePocketState.entryRecoveryState || {}),
      pending: true,
      reason: "ENTRY_COMMITTED_MOVE_ROLLBACK_FAILED",
      transitionError: normalizedTransitionError,
      rollbackError: normalizeText(
        rollbackResult && rollbackResult.errorMsg,
        "RESTORE_PREVIOUS_POSITION_FAILED",
      ),
      shipMoveCommitted: true,
      compensationDeferred: true,
      sourceSolarSystemID: toInt(activePocketState.sourceSolarSystemID, 0),
      destinationLocationID: targetLocationID,
      recordedAtMs: failedAtMs,
    },
  }) || activePocketState;
  const persistenceResult = ensureAbyssalPocketPersistenceReady(
    retainedPocketState,
    deps,
  );
  schedulePlaceholderPocketMaintenance(deps);
  log.error(
    `[AbyssalRecovery] entry rollback retained durable authority ` +
      `char=${validation.data.context.characterID} ship=${validation.data.context.shipID} ` +
      `run=${toInt(retainedPocketState.instanceID, 0)} ` +
      `transitionError=${normalizedTransitionError} ` +
      `rollbackError=${normalizeText(
        rollbackResult && rollbackResult.errorMsg,
        "RESTORE_PREVIOUS_POSITION_FAILED",
      )} persisted=${Boolean(persistenceResult && persistenceResult.success === true)}`,
  );
  return {
    success: false,
    errorMsg: normalizedTransitionError,
    sourceCommitIrreversible: true,
    entryRecoveryPending: true,
    rollbackResult,
    persistenceResult,
    pocketState: retainedPocketState,
  };
}

function preflightAbyssalEntryParticipantScope({
  log,
  formatVectorForLog,
  resolveAbyssalParticipantRoomScopePersistence,
  buildPlaceholderRoomState,
  rollbackAbyssalCommittedEntryMove,
}, context, session, deps) {
  const { validation, pocketState, previousTransitionState, targetLocationID, movedShip, entryShipSpawnState, isolatedSceneDescriptor } = context;
  log.info(
    `[AbyssalMgr] Abyssal pocket transition begin char=${validation.data.context.characterID} ` +
      `ship=${validation.data.context.shipID} oldSystem=${previousTransitionState.solarSystemID} ` +
      `oldLocation=${previousTransitionState.locationID} oldPos=${formatVectorForLog(previousTransitionState.position)} ` +
      `tracePos=${formatVectorForLog(validation.data.tracePosition)} ` +
      `pocketPos=${formatVectorForLog(pocketState.pocketPosition)} ` +
      `newSystem=${targetLocationID} newLocation=${toInt(movedShip.locationID, 0)} ` +
      `newRoom=room:entry newPos=${formatVectorForLog(entryShipSpawnState && entryShipSpawnState.position)} ` +
      `oldBall=${previousTransitionState.ballID} newBall=${toInt(movedShip.itemID, 0)} ` +
      `runMode=${isolatedSceneDescriptor ? "isolated-scene" : "legacy-same-system"} ` +
      `isolation=${isolatedSceneDescriptor ? "dedicated-instance-scene" : "shared-solar-system-scene"} ` +
      `sceneMode=${isolatedSceneDescriptor ? "isolated-scene" : "legacy-same-system"} ` +
      `sceneKey=${isolatedSceneDescriptor ? normalizeText(isolatedSceneDescriptor.sceneKey, "n/a") : "n/a"}`,
  );

  // Pre-flight the participant room scope BEFORE SessionChange. Once the client
  // is told it has moved it tears down the old scene and builds the new one, so
  // a refusal after that point leaves it stranded in a scene the server has
  // already rolled back - it then throws on the balls that arrive for it. Every
  // check that does not need the runtime entity is made here, while the client
  // is still uncommitted and the rollback is invisible to it. The runtime scope
  // read-back necessarily stays after attachSession (the entity does not exist
  // until then); see the deferred reorder note in the ErrorWatch report.
  const participantScopePreflight = resolveAbyssalParticipantRoomScopePersistence(
    pocketState,
    buildPlaceholderRoomState(pocketState).currentRoomIndex,
    null,
    deps,
    {
      shipID: movedShip.itemID,
      persistedShip: movedShip,
      persist: false,
    },
  );
  if (!participantScopePreflight.success) {
    return rollbackAbyssalCommittedEntryMove(context, session, deps, participantScopePreflight.errorMsg);
  }

  return null;
}

function applyAbyssalEntryMoveSession({
  buildAbyssalEntrySessionChanges,
  applyAbyssalEntrySessionFields,
  sendAbyssalEntrySessionChange,
  setAbyssalSessionState,
}, context, session) {
  const { validation, pocketState, targetLocationID, movedShip, isolatedSceneDescriptor } = context;
  const entrySessionChangeState = isolatedSceneDescriptor
    ? buildAbyssalEntrySessionChanges(session, targetLocationID, movedShip, isolatedSceneDescriptor)
    : null;
  if (entrySessionChangeState) {
    applyAbyssalEntrySessionFields(
      session,
      entrySessionChangeState.target,
      movedShip,
    );
    sendAbyssalEntrySessionChange(session, entrySessionChangeState, {
      characterID: validation.data.context.characterID,
      instanceID: pocketState && pocketState.instanceID,
    });
  } else {
    session.locationid = targetLocationID;
    session.solarsystemid = targetLocationID;
    session.solarsystemid2 = targetLocationID;
    session.shipID = movedShip.itemID;
    session.shipid = movedShip.itemID;
    session.activeShipID = movedShip.itemID;
    session.activeShipId = movedShip.itemID;
    session.shipTypeID = movedShip.typeID;
  }
  setAbyssalSessionState(session, pocketState, validation.data.traceState.traceItemID);
}

function attachAbyssalEntryMoveDestination({
  rollbackAbyssalCommittedEntryMove,
}, context, session, deps) {
  const runtime = deps;
  const { validation, entryShipSpawnState, sourceShipEntity, sourceScene, isolatedSceneDescriptor, previousTransitionState, targetLocationID, movedShip } = context;
  let attachedEntity = null;
  let transitionMode = "attach-session";
  let sessionRebound = true;
  let doDestinyUpdate = false;
  let removeBallsSent = false;
  let addBallsSent = false;
  let setStateSent = false;
  let movementStamp = null;

  const canUseInPlaceTeleport = Boolean(
    runtime &&
      typeof runtime.teleportSessionShipForAbyssalTransition === "function" &&
      sourceShipEntity &&
      session &&
      session._space &&
      !isolatedSceneDescriptor &&
      toInt(session._space.systemID, 0) === validation.data.context.systemID,
  );

  if (canUseInPlaceTeleport) {
    transitionMode = "teleport-in-place";
    sessionRebound = false;
    const teleportResult = runtime.teleportSessionShipForAbyssalTransition(
      session,
      entryShipSpawnState && entryShipSpawnState.position,
      {
        direction: entryShipSpawnState && entryShipSpawnState.direction,
      },
    );
    if (!teleportResult || !teleportResult.success) {
      return rollbackAbyssalCommittedEntryMove(context, session, deps,
        teleportResult && teleportResult.errorMsg || "SPACE_TELEPORT_FAILED",
      );
    }
    attachedEntity =
      teleportResult.data && teleportResult.data.entity
        ? teleportResult.data.entity
        : (
          sourceScene && typeof sourceScene.getShipEntityForSession === "function"
            ? sourceScene.getShipEntityForSession(session)
            : sourceShipEntity
        );
    movementStamp = toInt(
      teleportResult.data && teleportResult.data.stamp,
      0,
    ) || null;
    doDestinyUpdate = true;
    // The teleport took the ship out of its Grid bubble: labels are
    // integers, compared as integers.
    removeBallsSent =
      toInt(attachedEntity && attachedEntity.bubbleID, 0) !== previousTransitionState.bubbleID;
  } else {
    attachedEntity = runtime.attachSession(session, movedShip, {
      systemID: targetLocationID,
      sceneDescriptor: isolatedSceneDescriptor || undefined,
      reconcileUniverseSites: !isolatedSceneDescriptor,
      spawnAsteroidBeltRats: !isolatedSceneDescriptor,
      pendingUndockMovement: false,
      broadcast: true,
      spawnStopped: true,
    });
    if (!attachedEntity || !session._space) {
      return rollbackAbyssalCommittedEntryMove(context, session, deps, "SPACE_ATTACH_FAILED");
    }
    deps.queuePostSpaceAttachFittingHydration(session, movedShip.itemID, {
      hydrationProfile: "transition",
    });
    addBallsSent = true;
    setStateSent = true;
  }

  return { ready: true, attachedEntity, transitionMode, sessionRebound, doDestinyUpdate, removeBallsSent, addBallsSent, setStateSent, movementStamp };
}

function stampAbyssalEntryMoveDestination({
  stampAbyssalParticipantRoomScope,
  buildPlaceholderRoomState,
  rollbackAbyssalCommittedEntryMove,
  log,
  formatVectorForLog,
}, context, session, deps) {
  const runtime = deps;
  const { validation, pocketState, movedShip, attachedEntity, transitionMode, previousTransitionState, sessionRebound, removeBallsSent, addBallsSent, setStateSent, doDestinyUpdate, movementStamp, isolatedSceneDescriptor } = context;
  const participantScopeResult = stampAbyssalParticipantRoomScope(
    pocketState,
    buildPlaceholderRoomState(pocketState).currentRoomIndex,
    session,
    attachedEntity,
    deps,
    {
      shipID: movedShip.itemID,
      persistedShip: movedShip,
      persist: false,
      syncInventory: false,
    },
  );
  if (!participantScopeResult.success) {
    return rollbackAbyssalCommittedEntryMove(context, session, deps, participantScopeResult.errorMsg);
  }

  const protectionResult = grantAbyssalArrivalProtection(pocketState, session, attachedEntity, deps, {
    entry: true,
    roomIndex: buildPlaceholderRoomState(pocketState).currentRoomIndex,
  });
  if (!protectionResult.success) {
    return rollbackAbyssalCommittedEntryMove(context, session, deps, protectionResult.errorMsg);
  }

  log.info(
    `[AbyssalMgr] Abyssal pocket client transition char=${validation.data.context.characterID} ` +
      `ship=${validation.data.context.shipID} mode=${transitionMode} oldBall=${previousTransitionState.ballID} ` +
      `newBall=${toInt(attachedEntity && attachedEntity.itemID, toInt(movedShip.itemID, 0))} ` +
      `sessionRebound=${sessionRebound} removeBalls=${removeBallsSent} addBalls=${addBallsSent} ` +
      `setState=${setStateSent} doDestinyUpdate=${doDestinyUpdate} ` +
      `simClockRebase=${transitionMode === "attach-session"} movementStamp=${movementStamp || 0} ` +
      `finalPos=${formatVectorForLog(attachedEntity && attachedEntity.position)} ` +
      `finalBubble=${toInt(attachedEntity && attachedEntity.bubbleID, 0)} ` +
      `finalGrid=${
        attachedEntity && attachedEntity.bubbleID
          ? String(attachedEntity.bubbleID)
          : "n/a"
      }`,
  );

  if (isolatedSceneDescriptor) {
    const attachedScene =
      runtime && typeof runtime.getSceneForSession === "function"
        ? runtime.getSceneForSession(session)
        : null;
    log.info(
      `[AbyssalScene] ship attached mode=isolated-scene char=${validation.data.context.characterID} ` +
        `instance=${toInt(pocketState && pocketState.instanceID, 0)} ` +
        `sceneKey=${normalizeText(isolatedSceneDescriptor.sceneKey, "n/a")} ` +
        `locationID=${toInt(isolatedSceneDescriptor.locationID, 0)} ` +
        `staticCount=${
          attachedScene && Array.isArray(attachedScene.staticEntities)
            ? attachedScene.staticEntities.length
            : 0
        } ` +
        `dynamicCount=${
          attachedScene && attachedScene.dynamicEntities instanceof Map
            ? attachedScene.dynamicEntities.size
            : 0
        }`,
    );
  }

  return null;
}

function materializeAbyssalEntryLegacySite({
  usesAuthoredAbyssalEnvironmentNotification,
  markAbyssalDungeonRoomWithoutGenericNotification,
  shouldAttemptAuthoredSiteMaterialization,
  recordAuditEvent,
  log,
  summarizeContentSummary,
}, context, session, deps) {
  const runtime = deps;
  const { validation, pocketState } = context;
  const scene = runtime.getSceneForSession(session);
  let materializeResult = null;
  if (scene) {
    if (usesAuthoredAbyssalEnvironmentNotification(pocketState, session, deps)) {
      markAbyssalDungeonRoomWithoutGenericNotification(
        scene,
        session,
        pocketState,
        deps,
        1,
      );
    } else {
      deps.dungeonTrackingRuntime.enterDungeonRoomForSession(
        scene,
        session,
        pocketState.instance,
        "room:entry",
        {
          siteID: pocketState.traceItemID,
          roomPosition: pocketState.pocketPosition,
          forceNotify: true,
        },
      );
    }
    if (
      shouldAttemptAuthoredSiteMaterialization(pocketState) &&
      deps.dungeonUniverseSiteService &&
      typeof deps.dungeonUniverseSiteService.ensureSiteContentsMaterialized === "function"
    ) {
      materializeResult = deps.dungeonUniverseSiteService.ensureSiteContentsMaterialized(
        scene,
        pocketState.instance,
        {
          broadcast: true,
          session,
          spawnEncounters: false,
          markCurrentDungeonRoom: false,
        },
      );
      if (!(materializeResult && materializeResult.success)) {
        recordAuditEvent("abyssal_entrance_gate_activation_materialize_failed", [], session, {
          traceItemID: validation.data.traceState.traceItemID,
          instanceID: pocketState.instanceID,
          errorMsg: materializeResult && materializeResult.errorMsg || "SITE_MATERIALIZE_FAILED",
        });
        log.warn(
          `[AbyssalMgr] Abyssal pocket site materialization failed char=${validation.data.context.characterID} trace=${validation.data.traceState.traceItemID} instance=${pocketState.instanceID} reason=${materializeResult && materializeResult.errorMsg || "SITE_MATERIALIZE_FAILED"}`,
        );
      } else {
        const contentSummary = summarizeContentSummary(
          materializeResult.data && materializeResult.data.contentSummary,
        );
        log.info(
          `[AbyssalMgr] Abyssal pocket content materialized char=${validation.data.context.characterID} ` +
            `trace=${validation.data.traceState.traceItemID} instance=${pocketState.instanceID} ` +
            `containers=${contentSummary.containersSpawned} hazards=${contentSummary.hazardsSpawned} ` +
            `props=${contentSummary.environmentPropsSpawned} rocks=${contentSummary.miningRocksSpawned} ` +
            `gates=${contentSummary.gatesSpawned} objectives=${contentSummary.objectivesSpawned} ` +
            `encounters=${contentSummary.encountersSpawned}`,
        );
      }
    }
  }

  return materializeResult;
}

function registerAbyssalMovedEntryParticipant({
  upsertAbyssalParticipantRosterEntry,
  cloneValue,
  ABYSSAL_PARTICIPANT_STATUS,
  buildPlaceholderRoomState,
  toReal,
  getObjectRadius,
  resolveTypeRecord,
  registerPocket,
}, context, deps) {
  const { validation, pocketState, movedShip, previousTransitionState, sourceShipEntity } = context;
  const enteringCharacterID = toInt(validation.data.context.characterID, 0);
  const ownerCharacterID = toInt(pocketState.characterID, 0);
  const participantAdmission = validation.data.participantAdmission || {};
  const participantRoster = upsertAbyssalParticipantRosterEntry(
    pocketState,
    {
      ...cloneValue(participantAdmission),
      characterID: enteringCharacterID,
      shipID: movedShip.itemID,
      shipTypeID: toInt(movedShip.typeID, toInt(validation.data.shipItem && validation.data.shipItem.typeID, 0)),
      shipClass: normalizeText(validation.data.shipProfile && validation.data.shipProfile.key, pocketState.shipClass),
      role: enteringCharacterID === ownerCharacterID ? "owner" : "member",
      status: ABYSSAL_PARTICIPANT_STATUS.ACTIVE,
      admittedAtMs: toInt(
        participantAdmission.admittedAtMs,
        toInt(deps.now(), Date.now()),
      ),
      lastSeenAtMs: toInt(deps.now(), Date.now()),
      currentRoomIndex: buildPlaceholderRoomState(pocketState).currentRoomIndex,
      sourceSolarSystemID: toInt(
        participantAdmission.sourceSolarSystemID,
        previousTransitionState.solarSystemID,
      ),
      sourceLocationID: toInt(
        participantAdmission.sourceLocationID,
        previousTransitionState.locationID,
      ),
      sourceShipPosition: cloneValue(
        participantAdmission.sourceShipPosition || previousTransitionState.position,
      ),
      sourceShipDirection: cloneValue(
        participantAdmission.sourceShipDirection || sourceShipEntity && sourceShipEntity.direction,
      ),
      sourceShipRadius: toReal(
        participantAdmission.sourceShipRadius,
        getObjectRadius(sourceShipEntity, resolveTypeRecord(validation.data.shipItem, deps)),
      ),
      suspectOnReturn: participantAdmission.suspectOnReturn === true ||
        validation.data.securityPolicy && validation.data.securityPolicy.suspectRequired === true,
    },
  );
  registerPocket({
    ...pocketState,
    shipID: enteringCharacterID === ownerCharacterID
      ? movedShip.itemID
      : pocketState.shipID,
    participantRoster,
  });
  // The durable moved/active roster remains the retry source if the separate
  // career owner is temporarily unavailable. No offline time is inferred.
  try { deps.dungeonTrackingRuntime?.recordCareerAbyssalRun?.(pocketState.instanceID); }
  catch (_) { /* The durable roster is retried by queries and run cleanup. */ }
}

function buildAbyssalEntryMoveResult({
  shouldUseCorrelatedAbyssalSpaceEmpiricalContent,
  getContentProfile,
  countMaterializedContent,
}, context, materializeResult) {
  const { validation, pocketState, movedShip, attachedEntity, transitionMode, sessionRebound } = context;
  return {
    success: true,
    data: {
      movedShip,
      attachedEntity,
      transitionMode,
      sessionRebound,
      materializeResult,
      authoredContentUnavailable:
        !(
          shouldUseCorrelatedAbyssalSpaceEmpiricalContent(
            getContentProfile(pocketState),
          ) ||
          shouldUseCorrelatedAbyssalSpaceEmpiricalContent(
            getContentProfile(validation.data.traceState),
          ) ||
          shouldUseCorrelatedAbyssalSpaceEmpiricalContent(
            validation.data.filamentDefinition,
          )
        ) && (
          !(materializeResult && materializeResult.success) ||
          countMaterializedContent(
            materializeResult &&
            materializeResult.data &&
            materializeResult.data.contentSummary,
          ) <= 0
        ),
    },
  };
}

function moveShipIntoPlaceholderPocket({
  getDependencies,
  resolveAbyssalEntryMoveContext,
  commitAbyssalEntryInventoryMove,
  preflightAbyssalEntryParticipantScope,
  applyAbyssalEntryMoveSession,
  attachAbyssalEntryMoveDestination,
  stampAbyssalEntryMoveDestination,
  materializeAbyssalEntryLegacySite,
  registerAbyssalMovedEntryParticipant,
  buildAbyssalEntryMoveResult,
}, validation, pocketState, session, deps = getDependencies()) {
  const contextResult = resolveAbyssalEntryMoveContext(validation, pocketState, session, deps);
  if (!contextResult.ready) return contextResult;
  const moveResult = commitAbyssalEntryInventoryMove(contextResult.context, session, deps);
  if (!moveResult.ready) return moveResult;
  let context = {
    ...contextResult.context,
    moveResult: moveResult.moveResult,
    movedShip: moveResult.movedShip,
  };
  const preflightFailure = preflightAbyssalEntryParticipantScope(context, session, deps);
  if (preflightFailure) return preflightFailure;
  applyAbyssalEntryMoveSession(context, session);
  const destination = attachAbyssalEntryMoveDestination(context, session, deps);
  if (!destination.ready) return destination;
  context = {
    ...context,
    attachedEntity: destination.attachedEntity,
    transitionMode: destination.transitionMode,
    sessionRebound: destination.sessionRebound,
    doDestinyUpdate: destination.doDestinyUpdate,
    removeBallsSent: destination.removeBallsSent,
    addBallsSent: destination.addBallsSent,
    setStateSent: destination.setStateSent,
    movementStamp: destination.movementStamp,
  };
  const scopeFailure = stampAbyssalEntryMoveDestination(context, session, deps);
  if (scopeFailure) return scopeFailure;
  const materializeResult = materializeAbyssalEntryLegacySite(context, session, deps);
  registerAbyssalMovedEntryParticipant(context, deps);
  return buildAbyssalEntryMoveResult(context, materializeResult);
}

// Capture supplied capabilities once, as the original closure did. Internal
// callbacks are bound once per instance; no runtime state lives in this wiring.
function createAbyssalEntryMovement({
  cloneValue,
  restoreAbyssalSpaceSessionFields,
  syncInventoryChanges,
  log,
  getCharacterID,
  validateAbyssalIsolatedSceneRuntime,
  getObjectPosition,
  captureAbyssalSpaceSessionFields,
  buildAbyssalParticipantRoomScopeMetadata,
  getActivePocketStateByInstanceID,
  updatePocketState,
  ensureAbyssalPocketPersistenceReady,
  schedulePlaceholderPocketMaintenance,
  formatVectorForLog,
  resolveAbyssalParticipantRoomScopePersistence,
  buildPlaceholderRoomState,
  buildAbyssalEntrySessionChanges,
  applyAbyssalEntrySessionFields,
  sendAbyssalEntrySessionChange,
  setAbyssalSessionState,
  stampAbyssalParticipantRoomScope,
  usesAuthoredAbyssalEnvironmentNotification,
  markAbyssalDungeonRoomWithoutGenericNotification,
  shouldAttemptAuthoredSiteMaterialization,
  recordAuditEvent,
  summarizeContentSummary,
  upsertAbyssalParticipantRosterEntry,
  ABYSSAL_PARTICIPANT_STATUS,
  toReal,
  getObjectRadius,
  resolveTypeRecord,
  registerPocket,
  shouldUseCorrelatedAbyssalSpaceEmpiricalContent,
  getContentProfile,
  countMaterializedContent,
  getDependencies,
}) {

  const ports = {
    cloneValue,
    restoreAbyssalSpaceSessionFields,
    syncInventoryChanges,
    log,
    getCharacterID,
    validateAbyssalIsolatedSceneRuntime,
    getObjectPosition,
    captureAbyssalSpaceSessionFields,
    buildAbyssalParticipantRoomScopeMetadata,
    getActivePocketStateByInstanceID,
    updatePocketState,
    ensureAbyssalPocketPersistenceReady,
    schedulePlaceholderPocketMaintenance,
    formatVectorForLog,
    resolveAbyssalParticipantRoomScopePersistence,
    buildPlaceholderRoomState,
    buildAbyssalEntrySessionChanges,
    applyAbyssalEntrySessionFields,
    sendAbyssalEntrySessionChange,
    setAbyssalSessionState,
    stampAbyssalParticipantRoomScope,
    usesAuthoredAbyssalEnvironmentNotification,
    markAbyssalDungeonRoomWithoutGenericNotification,
    shouldAttemptAuthoredSiteMaterialization,
    recordAuditEvent,
    summarizeContentSummary,
    upsertAbyssalParticipantRosterEntry,
    ABYSSAL_PARTICIPANT_STATUS,
    toReal,
    getObjectRadius,
    resolveTypeRecord,
    registerPocket,
    shouldUseCorrelatedAbyssalSpaceEmpiricalContent,
    getContentProfile,
    countMaterializedContent,
    getDependencies,
  };
  ports.restorePreviousShipLocation = restorePreviousShipLocation.bind(null, ports);
  ports.resolveAbyssalEntryMoveContext = resolveAbyssalEntryMoveContext.bind(null, ports);
  ports.commitAbyssalEntryInventoryMove = commitAbyssalEntryInventoryMove.bind(null, ports);
  ports.rollbackAbyssalCommittedEntryMove = rollbackAbyssalCommittedEntryMove.bind(null, ports);
  ports.preflightAbyssalEntryParticipantScope = preflightAbyssalEntryParticipantScope.bind(null, ports);
  ports.applyAbyssalEntryMoveSession = applyAbyssalEntryMoveSession.bind(null, ports);
  ports.attachAbyssalEntryMoveDestination = attachAbyssalEntryMoveDestination.bind(null, ports);
  ports.stampAbyssalEntryMoveDestination = stampAbyssalEntryMoveDestination.bind(null, ports);
  ports.materializeAbyssalEntryLegacySite = materializeAbyssalEntryLegacySite.bind(null, ports);
  ports.registerAbyssalMovedEntryParticipant = registerAbyssalMovedEntryParticipant.bind(null, ports);
  ports.buildAbyssalEntryMoveResult = buildAbyssalEntryMoveResult.bind(null, ports);
  ports.moveShipIntoPlaceholderPocket = moveShipIntoPlaceholderPocket.bind(null, ports);
  Object.freeze(ports);
  return {
    restorePreviousShipLocation: ports.restorePreviousShipLocation,
    moveShipIntoPlaceholderPocket: ports.moveShipIntoPlaceholderPocket,
  };
}

module.exports = { createAbyssalEntryMovement };
