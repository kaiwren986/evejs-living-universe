"use strict";

const { normalizeText } = require("../domain/abyssalValueUtils");

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

// Relog restoration and fresh-entry routing share existing durable/content policies.
// Each attempt owns its intermediate scene, entity and publication state.
function restoreAbyssalRecoveryParticipant({
  getAbyssalParticipantRecord,
  ABYSSAL_PARTICIPANT_STATUS,
  upsertAbyssalParticipantRosterEntry,
  buildPlaceholderRoomState,
  commitPocketStateDurably,
  cloneValue,
}, attempt) {
  const { pocketState, context, deps } = attempt;
  const recoveringParticipant = getAbyssalParticipantRecord(
    pocketState,
    context.characterID,
  );
  if (
    recoveringParticipant &&
    recoveringParticipant.status === ABYSSAL_PARTICIPANT_STATUS.DISCONNECTED &&
    recoveringParticipant.shipID === context.shipID &&
    !(
      pocketState.entryRecoveryState &&
      pocketState.entryRecoveryState.pending === true
    )
  ) {
    const participantRoster = upsertAbyssalParticipantRosterEntry(pocketState, {
      ...recoveringParticipant,
      status: ABYSSAL_PARTICIPANT_STATUS.ACTIVE,
      disconnectedAtMs: 0,
      lastSeenAtMs: toInt(deps.now(), Date.now()),
      currentRoomIndex: buildPlaceholderRoomState(pocketState).currentRoomIndex,
    });
    const recoveryRosterCommit = commitPocketStateDurably(
      pocketState.instanceID,
      { participantRoster },
      deps,
      { verifyReadBack: true, forceWrite: true },
    );
    if (!recoveryRosterCommit || recoveryRosterCommit.success !== true) {
      return {
        recovered: false,
        reason: normalizeText(
          recoveryRosterCommit && recoveryRosterCommit.errorMsg,
          "ABYSSAL_PARTICIPANT_RECOVERY_PERSIST_FAILED",
        ),
      };
    }
    Object.assign(
      pocketState,
      cloneValue(recoveryRosterCommit.committedState || recoveryRosterCommit.state),
    );
  }
  return null;
}

function reconcileAbyssalSessionTerminalRecovery({
  reconcilePendingAbyssalEntryRecovery,
  clearPendingAbyssalTraceActivation,
  getActivePocketStateByInstanceID,
  hasPendingAbyssalTerminalCleanup,
  resolveAbyssalRecoveryCleanupReason,
  cleanupAbyssalRun,
  reconcileCommittedAbyssalParticipantDeath,
  hasFailedTimeoutOutcome,
}, attempt) {
  const { pocketState, session, deps } = attempt;
  if (
    pocketState.entryRecoveryState &&
    pocketState.entryRecoveryState.pending === true
  ) {
    const entryRecoveryResult = reconcilePendingAbyssalEntryRecovery(
      pocketState,
      session,
      deps,
    );
    const evacuationSettled = Boolean(
      entryRecoveryResult && entryRecoveryResult.settled === true
    );
    let activationRollbackResult = null;
    if (evacuationSettled) {
      activationRollbackResult = clearPendingAbyssalTraceActivation(
        toInt(pocketState.traceItemID, 0),
        deps,
      );
    }
    return {
      recovered: false,
      terminalCleanup: true,
      entryRecovery: true,
      evacuated: Boolean(
        entryRecoveryResult &&
        entryRecoveryResult.evacuationResult &&
        entryRecoveryResult.evacuationResult.evacuated === true,
      ),
      cleanedUp: evacuationSettled,
      reason: evacuationSettled
        ? "ABYSSAL_ENTRY_RECOVERY_RECONCILED"
        : normalizeText(
          entryRecoveryResult && entryRecoveryResult.errorMsg,
          "ABYSSAL_ENTRY_RECOVERY_PENDING",
        ),
      evacuationResult:
        entryRecoveryResult && entryRecoveryResult.evacuationResult,
      groupEvacuationResult:
        entryRecoveryResult && entryRecoveryResult.groupEvacuationResult,
      entryRecoveryResult,
      activationRollbackResult,
      pocketState: getActivePocketStateByInstanceID(
        toInt(pocketState.instanceID, 0),
      ),
    };
  }
  if (
    pocketState.gameplayAuthorityDetached === true ||
    hasPendingAbyssalTerminalCleanup(pocketState)
  ) {
    const cleanupReason = resolveAbyssalRecoveryCleanupReason(
      pocketState,
      "relog-terminal-cleanup",
    );
    const cleanupResult = cleanupAbyssalRun(pocketState, deps, {
      reason: cleanupReason,
      session,
    });
    return {
      recovered: false,
      terminalCleanup: true,
      cleanedUp: Boolean(cleanupResult && cleanupResult.success === true),
      reason: cleanupResult && cleanupResult.success === true
        ? "ABYSSAL_TERMINAL_CLEANUP_RECONCILED"
        : normalizeText(
          cleanupResult && cleanupResult.errorMsg,
          "ABYSSAL_TERMINAL_CLEANUP_PENDING",
        ),
      cleanupResult,
      pocketState: getActivePocketStateByInstanceID(
        toInt(pocketState.instanceID, 0),
      ),
    };
  }
  const participantDeathRecovery = reconcileCommittedAbyssalParticipantDeath(
    pocketState,
    session,
    deps,
  );
  if (participantDeathRecovery.reconciled === true) {
    if (hasFailedTimeoutOutcome(pocketState)) {
      return {
        recovered: false,
        terminalTimeout: true,
        reason: "ABYSSAL_RUN_FAILED_TIMEOUT",
        pocketState: getActivePocketStateByInstanceID(
          toInt(pocketState.instanceID, 0),
        ),
        participantDeathRecovery,
      };
    }
    return {
      recovered: false,
      terminalDestruction: true,
      reason: participantDeathRecovery.completed === true
        ? "ABYSSAL_PARTICIPANT_DEATH_RECONCILED"
        : "ABYSSAL_PARTICIPANT_DEATH_CLEANUP_PENDING",
      pocketState: getActivePocketStateByInstanceID(toInt(pocketState.instanceID, 0)),
      participantDeathRecovery,
    };
  }
  return null;
}

function checkAbyssalSessionRecoveryDeadline({
  logRecoveredAbyssalSceneMode,
  syncExpiredAbyssalPocketState,
  hasFailedTimeoutOutcome,
  hasFailedParticipantShipDestroyedOutcome,
}, attempt) {
  const { pocketState, session, deps, options } = attempt;
  logRecoveredAbyssalSceneMode(pocketState, deps);

  const timeoutPocketState = syncExpiredAbyssalPocketState(
    pocketState,
    null,
    deps,
    session,
    options,
  );
  if (
    hasFailedTimeoutOutcome(pocketState) ||
    hasFailedTimeoutOutcome(timeoutPocketState)
  ) {
    return {
      recovered: false,
      terminalTimeout: true,
      reason: "ABYSSAL_RUN_FAILED_TIMEOUT",
      pocketState: timeoutPocketState,
    };
  }
  if (
    hasFailedParticipantShipDestroyedOutcome(pocketState) ||
    hasFailedParticipantShipDestroyedOutcome(timeoutPocketState) ||
    !timeoutPocketState
  ) {
    return {
      recovered: false,
      terminalDestruction: true,
      reason: "ABYSSAL_PARTICIPANT_DESTROYED",
      pocketState: timeoutPocketState,
    };
  }
  return null;
}

function prepareAbyssalRelogRuntime({
  usesIsolatedAbyssalScene,
  buildAbyssalSceneDescriptor,
  log,
  abandonRelogRecovery,
}, attempt) {
  const { pocketState, session, context, deps } = attempt;
  const runtime = deps;
  const isolatedSceneDescriptor = usesIsolatedAbyssalScene(pocketState, deps)
    ? buildAbyssalSceneDescriptor(pocketState, deps)
    : null;
  const isolatedLocationID = toInt(isolatedSceneDescriptor && isolatedSceneDescriptor.locationID, 0);
  const pocketLocationID = isolatedLocationID > 0
    ? isolatedLocationID
    : toInt(pocketState && pocketState.solarSystemID, 0);
  const shipID = toInt(context.shipID, toInt(pocketState.shipID, 0));
  const shipItem = shipID > 0 ? deps.findItemById(shipID) : null;
  const currentScene =
    runtime && typeof runtime.getSceneForSession === "function"
      ? runtime.getSceneForSession(session)
      : null;
  const shipEntity =
    currentScene && typeof currentScene.getShipEntityForSession === "function"
      ? currentScene.getShipEntityForSession(session)
      : (
        runtime &&
        typeof runtime.getEntity === "function" &&
        shipID > 0
          ? runtime.getEntity(session, shipID)
          : null
      );
  log.info(
    `[AbyssalMgr] Relog recovery begin char=${context.characterID} ship=${shipID} ` +
      `run=${pocketState.instanceID} sourceSolarSystemID=${pocketState.sourceSolarSystemID} ` +
      `clientAbyssalLocationID=${pocketLocationID} ` +
      `runSceneKey=${normalizeText(isolatedSceneDescriptor && isolatedSceneDescriptor.sceneKey, "none")} ` +
      `returnSolarSystemID=${pocketState.sourceSolarSystemID} ` +
      `currentSessionLocationID=${context.systemID}`,
  );
  if (!runtime || !shipItem) {
    return abandonRelogRecovery(
      session,
      context,
      pocketState,
      !runtime ? "RUNTIME_UNAVAILABLE" : "MISSING_SHIP",
      deps,
    );
  }
  Object.assign(attempt, {
    runtime, isolatedSceneDescriptor, pocketLocationID, shipID, shipItem, currentScene, shipEntity,
  });
  return null;
}

function inspectAbyssalRelogRuntime({
  listPocketHostileEntityIDs,
  getPocketScene,
  getObjectPosition,
  calculateAbyssalRemainingDuration,
  logRelogRecoveryState,
  isPointWithinPocketRecoveryRadius,
  inspectAbyssalRelogBootstrapState,
}, attempt) {
  const {
    pocketState, session, context, deps, isolatedSceneDescriptor, pocketLocationID,
    shipID, shipItem, currentScene, shipEntity,
  } = attempt;
  const hostileEntityIDs = listPocketHostileEntityIDs(pocketState);
  const runtimeScene = getPocketScene(pocketState, deps);
  const hostilesPresent = runtimeScene && typeof runtimeScene.getEntityByID === "function"
    ? hostileEntityIDs.filter((entityID) => runtimeScene.getEntityByID(entityID)).length
    : 0;
  const currentShipPosition = getObjectPosition(shipEntity) || getObjectPosition(shipItem);
  const pocketPosition =
    getObjectPosition(pocketState.shipSpawnState) ||
    getObjectPosition(pocketState.pocketPosition);
  const currentSystemID = toInt(
    shipEntity && shipEntity.systemID,
    toInt(
      shipItem && shipItem.spaceState && shipItem.spaceState.systemID,
      toInt(session && session._space && session._space.systemID, context.systemID),
    ),
  );
  const timerExpiresAtMs = toInt(pocketState.timerState && pocketState.timerState.expiresAtMs, 0);
  const timerRemainingMs = calculateAbyssalRemainingDuration({
    nowMs: toInt(deps.now(), 0),
    deadlineAtMs: timerExpiresAtMs,
  });
  const recoveryState = {
    shipID,
    currentSystemID,
    currentShipPosition,
    pocketPosition,
    hostilesTracked: hostileEntityIDs.length,
    hostilesPresent,
    originMarkerPresent:
      toInt(pocketState.originMarkerItemID, 0) > 0 &&
      Boolean(deps.findItemById(pocketState.originMarkerItemID)),
    exitMarkerPresent:
      toInt(pocketState.exitMarkerItemID, 0) > 0 &&
      Boolean(deps.findItemById(pocketState.exitMarkerItemID)),
    timerRemainingMs,
    timerExpired: Boolean(pocketState.timerState && pocketState.timerState.expired),
    activeRuntime: Boolean(session && session._space),
  };
  logRelogRecoveryState(context, pocketState, recoveryState);

  let movedShip = shipItem;
  let attachedEntity = shipEntity;
  let transitionMode = "resume-current-pocket-position";
  let clientRefreshSent = false;
  const needsSessionRebind = !(session && session._space) || !attachedEntity;
  const alreadyInPocket =
    !needsSessionRebind &&
    currentSystemID === pocketLocationID &&
    isPointWithinPocketRecoveryRadius(currentShipPosition, pocketState);
  const bindingBeforeRecovery = isolatedSceneDescriptor
    ? inspectAbyssalRelogBootstrapState(session, pocketState, deps)
    : null;
  const staleEntitiesRejectedBeforeRecovery = toInt(
    bindingBeforeRecovery && bindingBeforeRecovery.inventoryHydrationRejectedCount,
    0,
  ) + (
    Array.isArray(bindingBeforeRecovery && bindingBeforeRecovery.staleRoomEntityIDs)
      ? bindingBeforeRecovery.staleRoomEntityIDs.length
      : 0
  );
  if (session && typeof session === "object") {
    session._abyssalRelogStaleEntitiesRejected = staleEntitiesRejectedBeforeRecovery;
  }
  const expectedSceneKey = normalizeText(isolatedSceneDescriptor && isolatedSceneDescriptor.sceneKey, "");
  const sessionSceneKey = normalizeText(
    session && session._space && session._space.sceneKey,
    normalizeText(session && session.spaceSceneKey, ""),
  );
  const sameRunSceneBound = Boolean(
    expectedSceneKey &&
      (
        sessionSceneKey === expectedSceneKey ||
        normalizeText(currentScene && currentScene.sceneKey, "") === expectedSceneKey ||
        normalizeText(shipEntity && shipEntity.sceneKey, "") === expectedSceneKey
      ),
  );
  const activeRunBound =
    !pocketState.disconnectState &&
    (isolatedSceneDescriptor ? bindingBeforeRecovery && bindingBeforeRecovery.valid : alreadyInPocket) &&
    toInt(pocketState.instanceID, 0) > 0 &&
    (
      toInt(session && session.abyssalInstanceID, 0) === toInt(pocketState.instanceID, 0) ||
      toInt(session && session._space && session._space.instanceID, 0) === toInt(pocketState.instanceID, 0)
    ) &&
    (!expectedSceneKey || sameRunSceneBound);
  Object.assign(attempt, {
    currentSystemID, currentShipPosition, pocketPosition, movedShip, attachedEntity,
    transitionMode, clientRefreshSent, alreadyInPocket, bindingBeforeRecovery,
    staleEntitiesRejectedBeforeRecovery, expectedSceneKey, sessionSceneKey, activeRunBound,
  });
  return null;
}

function bindExistingAbyssalSession({
  setAbyssalSessionState,
  buildPlaceholderRoomState,
  stampAbyssalParticipantRoomScope,
  abandonRelogRecovery,
  applyAbyssalWeatherToRun,
  getActivePocketStateByInstanceID,
  isAbyssalWeatherApplicationReady,
  queueAbyssalClientEnvironmentDelivery,
  completeAbyssalEntryReadyForSession,
  schedulePlaceholderPocketMaintenance,
  log,
}, attempt) {
  const {
    pocketState, session, context, deps, shipID, shipItem, shipEntity,
    emitNotifications, sessionSceneKey, activeRunBound,
  } = attempt;
  if (activeRunBound) {
    setAbyssalSessionState(session, pocketState, pocketState.traceItemID);
    const activeRoomIndex = buildPlaceholderRoomState(pocketState).currentRoomIndex;
    const scopeResult = stampAbyssalParticipantRoomScope(
      pocketState,
      activeRoomIndex,
      session,
      shipEntity,
      deps,
      { shipID, persistedShip: shipItem, persist: true },
    );
    if (!scopeResult.success) {
      return abandonRelogRecovery(
        session,
        context,
        pocketState,
        scopeResult.errorMsg,
        deps,
      );
    }
    const activeBindWeatherResult = applyAbyssalWeatherToRun(
      getActivePocketStateByInstanceID(toInt(pocketState.instanceID, 0)) || pocketState,
      session,
      deps,
      {
        reason: "active-run-bind",
        emitNotifications,
      },
    );
    if (!isAbyssalWeatherApplicationReady(activeBindWeatherResult)) {
      return abandonRelogRecovery(
        session,
        context,
        getActivePocketStateByInstanceID(toInt(pocketState.instanceID, 0)) || pocketState,
        "ABYSSAL_ACTIVE_RUN_WEATHER_NOT_READY",
        deps,
      );
    }
    queueAbyssalClientEnvironmentDelivery(
      pocketState,
      session,
      deps,
      {
        phase: "relog",
        activateNpcControllers: false,
      },
    );
    if (session && session._space && session._space.initialStateSent === true) {
      completeAbyssalEntryReadyForSession(
        session,
        deps,
        "fresh-entry-or-active-bind",
      );
    }
    schedulePlaceholderPocketMaintenance(deps);
    log.info(
      `[AbyssalMgr] Active Abyssal session already bound char=${context.characterID} ` +
        `ship=${shipID} instance=${pocketState.instanceID} sceneKey=${normalizeText(sessionSceneKey, "n/a")} ` +
        `reason=fresh-entry-or-active-bind`,
    );
    return {
      recovered: false,
      activeRunBound: true,
      reason: "ACTIVE_RUN_ALREADY_BOUND",
      pocketState: getActivePocketStateByInstanceID(pocketState.instanceID),
    };
  }
  return null;
}

function restoreAbyssalRelogPosition({
  log,
  formatVectorForLog,
  buildAbyssalParticipantRoomScopeMetadata,
  abandonRelogRecovery,
  syncInventoryChanges,
}, attempt) {
  const {
    pocketState, session, context, deps, runtime, options, emitNotifications,
    isolatedSceneDescriptor, bindingBeforeRecovery, alreadyInPocket,
    shipID, shipItem, pocketLocationID, currentShipPosition, pocketPosition, expectedSceneKey,
  } = attempt;
  let { movedShip, attachedEntity, transitionMode, clientRefreshSent } = attempt;
  const needsIsolatedSceneRepair = Boolean(
    isolatedSceneDescriptor &&
      (!bindingBeforeRecovery ||
        !bindingBeforeRecovery.sceneAttached ||
        !bindingBeforeRecovery.shipRegistered)
  );
  if (!alreadyInPocket || needsIsolatedSceneRepair) {
    if (!alreadyInPocket) {
      log.info(
        `[AbyssalMgr] Relog recovery restoring pocket position char=${context.characterID} ` +
          `ship=${shipID} run=${pocketState.instanceID} currentPos=${formatVectorForLog(currentShipPosition)} ` +
          `pocketPos=${formatVectorForLog(pocketPosition)}`,
      );
      const moveResult = deps.moveShipToSpace(
        shipID,
        pocketLocationID,
        {
          ...pocketState.shipSpawnState,
          ...buildAbyssalParticipantRoomScopeMetadata(pocketState),
        },
      );
      if (!moveResult || !moveResult.success || !moveResult.data) {
        return abandonRelogRecovery(
          session,
          context,
          pocketState,
          moveResult && moveResult.errorMsg || "POCKET_RESTORE_MOVE_FAILED",
          deps,
        );
      }
      movedShip = moveResult.data;
      if (emitNotifications) {
        syncInventoryChanges(session, [{
          item: movedShip,
          previousData: moveResult.previousData || shipItem,
        }], deps);
      }
    } else {
      log.warn(
        `[AbyssalRelogSceneMismatch] run=${toInt(pocketState.instanceID, 0)} ` +
          `character=${context.characterID} ship=${shipID} expectedScene=${expectedSceneKey} ` +
          `actualScene=${normalizeText(bindingBeforeRecovery && bindingBeforeRecovery.actualSceneKey, "none")} ` +
          `repair=reattach-preserve-position`,
      );
    }

    session.locationid = pocketLocationID;
    session.solarsystemid = pocketLocationID;
    session.solarsystemid2 = pocketLocationID;
    session.shipID = movedShip.itemID;
    session.shipid = movedShip.itemID;
    session.activeShipID = movedShip.itemID;
    session.activeShipId = movedShip.itemID;
    session.shipTypeID = movedShip.typeID;

    const canUseTeleport = Boolean(
        !alreadyInPocket &&
        attachedEntity &&
        session &&
        session._space &&
        !isolatedSceneDescriptor &&
        toInt(session._space.systemID, 0) === pocketLocationID &&
        typeof runtime.teleportSessionShipForAbyssalTransition === "function",
    );
    if (canUseTeleport) {
      transitionMode = "teleport-pocket-restore";
      const teleportResult = runtime.teleportSessionShipForAbyssalTransition(
        session,
        pocketState.shipSpawnState && pocketState.shipSpawnState.position,
        {
          direction: pocketState.shipSpawnState && pocketState.shipSpawnState.direction,
        },
      );
      if (!teleportResult || !teleportResult.success) {
        return abandonRelogRecovery(
          session,
          context,
          pocketState,
          teleportResult && teleportResult.errorMsg || "POCKET_RESTORE_TELEPORT_FAILED",
          deps,
        );
      }
      attachedEntity =
        teleportResult.data && teleportResult.data.entity
          ? teleportResult.data.entity
          : attachedEntity;
      clientRefreshSent = true;
    } else {
      transitionMode = "attach-pocket-restore";
      attachedEntity = runtime.attachSession(session, movedShip, {
        systemID: pocketLocationID,
        sceneDescriptor: isolatedSceneDescriptor || undefined,
        reconcileUniverseSites: !isolatedSceneDescriptor,
        spawnAsteroidBeltRats: !isolatedSceneDescriptor,
        pendingUndockMovement: false,
        broadcast: true,
        emitSimClockRebase: options.preBootstrap !== true,
        spawnStopped: true,
      });
      if (!attachedEntity || !session._space) {
        return abandonRelogRecovery(
          session,
          context,
          pocketState,
          "POCKET_RESTORE_ATTACH_FAILED",
          deps,
        );
      }
      deps.queuePostSpaceAttachFittingHydration(session, movedShip.itemID, {
        hydrationProfile: options.preBootstrap === true ? "login" : "transition",
      });
      clientRefreshSent = emitNotifications;
    }
  }
  Object.assign(attempt, {
    movedShip, attachedEntity, transitionMode, clientRefreshSent, needsIsolatedSceneRepair,
  });
  return null;
}

function restoreAbyssalRelogSceneContent({
  abandonRelogRecovery,
  stampAbyssalParticipantRoomScope,
  buildPlaceholderRoomState,
  usesAuthoredAbyssalEnvironmentNotification,
  markAbyssalDungeonRoomWithoutGenericNotification,
  shouldAttemptAuthoredSiteMaterialization,
  spawnPlaceholderPocketContent,
  getActivePocketStateByInstanceID,
}, attempt) {
  const {
    pocketState, session, context, deps, runtime, attachedEntity, shipID, movedShip,
    emitNotifications,
  } = attempt;
  const sceneAfterRecovery =
    runtime && typeof runtime.getSceneForSession === "function"
      ? runtime.getSceneForSession(session)
      : null;
  if (!sceneAfterRecovery) {
    return abandonRelogRecovery(session, context, pocketState, "POCKET_SCENE_UNAVAILABLE", deps);
  }
  const recoveredParticipantScopeResult = stampAbyssalParticipantRoomScope(
    pocketState,
    buildPlaceholderRoomState(pocketState).currentRoomIndex,
    session,
    attachedEntity,
    deps,
    {
      shipID,
      persistedShip: movedShip,
      persist: true,
    },
  );
  if (!recoveredParticipantScopeResult.success) {
    return abandonRelogRecovery(
      session,
      context,
      pocketState,
      recoveredParticipantScopeResult.errorMsg,
      deps,
    );
  }
  if (
    emitNotifications &&
    usesAuthoredAbyssalEnvironmentNotification(pocketState, session, deps)
  ) {
    markAbyssalDungeonRoomWithoutGenericNotification(
      sceneAfterRecovery,
      session,
      pocketState,
      deps,
      buildPlaceholderRoomState(pocketState).currentRoomIndex,
    );
  } else if (
    emitNotifications &&
    deps.dungeonTrackingRuntime &&
    typeof deps.dungeonTrackingRuntime.enterDungeonRoomForSession === "function"
  ) {
    deps.dungeonTrackingRuntime.enterDungeonRoomForSession(
      sceneAfterRecovery,
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
    deps.dungeonUniverseSiteService.ensureSiteContentsMaterialized(
      sceneAfterRecovery,
      pocketState.instance,
      {
        broadcast: emitNotifications,
        session,
        spawnEncounters: false,
        markCurrentDungeonRoom: false,
      },
    );
  }
  const contentResult = spawnPlaceholderPocketContent(
    null,
    pocketState,
    session,
    deps,
    {
      allowRewardCacheRepair: true,
      suppressClientEntryFx: !emitNotifications,
      suppressPrewarmClientDelivery: !emitNotifications,
    },
  );
  const recoveredPocketState =
    contentResult && contentResult.data
      ? contentResult.data
      : getActivePocketStateByInstanceID(pocketState.instanceID);
  if (!recoveredPocketState || toInt(recoveredPocketState.exitMarkerItemID, 0) <= 0) {
    return abandonRelogRecovery(session, context, pocketState, "POCKET_MARKER_RESTORE_FAILED", deps);
  }
  Object.assign(attempt, { sceneAfterRecovery, recoveredPocketState });
  return null;
}

function validateAbyssalRelogBootstrap({
  broadcastAbyssalRoomBootstrapAddBalls,
  abandonRelogRecovery,
  inspectAbyssalRelogBootstrapState,
  logAbyssalRelogBootstrapState,
  queueAbyssalClientEnvironmentDelivery,
}, attempt) {
  const {
    recoveredPocketState, session, context, deps, isolatedSceneDescriptor,
    bindingBeforeRecovery, needsIsolatedSceneRepair, staleEntitiesRejectedBeforeRecovery,
  } = attempt;
  const bootstrapResult = broadcastAbyssalRoomBootstrapAddBalls(
    recoveredPocketState,
    session,
    deps,
    "relog-recovery",
  );
  if (!bootstrapResult.success) {
    return abandonRelogRecovery(
      session,
      context,
      recoveredPocketState,
      bootstrapResult.errorMsg || "POCKET_BOOTSTRAP_RESTORE_FAILED",
      deps,
    );
  }
  const validatedBootstrapState = isolatedSceneDescriptor
    ? inspectAbyssalRelogBootstrapState(session, recoveredPocketState, deps)
    : null;
  if (validatedBootstrapState && !validatedBootstrapState.valid) {
    logAbyssalRelogBootstrapState(session, recoveredPocketState, validatedBootstrapState, {
      initialSceneKey: bindingBeforeRecovery && bindingBeforeRecovery.actualSceneKey,
      repairAttempted: needsIsolatedSceneRepair,
      staleEntitiesRejected: staleEntitiesRejectedBeforeRecovery,
      bootstrapState: "blocked",
      reason: validatedBootstrapState.reason,
    });
    return abandonRelogRecovery(
      session,
      context,
      recoveredPocketState,
      `POCKET_BOOTSTRAP_VALIDATION_FAILED:${validatedBootstrapState.reason}`,
      deps,
    );
  }
  queueAbyssalClientEnvironmentDelivery(
    recoveredPocketState,
    session,
    deps,
    {
      phase: "relog",
      activateNpcControllers: false,
    },
  );
  attempt.validatedBootstrapState = validatedBootstrapState;
  return null;
}

function finishAbyssalSessionRecovery({
  updatePocketState,
  getActivePocketStateByInstanceID,
  setAbyssalSessionState,
  buildPlaceholderRoomState,
  stampAbyssalParticipantRoomScope,
  abandonRelogRecovery,
  applyAbyssalWeatherToRun,
  isAbyssalWeatherApplicationReady,
  schedulePlaceholderPocketMaintenance,
  logAbyssalRelogBootstrapState,
  log,
}, attempt) {
  const {
    recoveredPocketState, session, context, deps, movedShip, shipID, transitionMode,
    clientRefreshSent, sceneAfterRecovery, attachedEntity, emitNotifications,
    validatedBootstrapState, bindingBeforeRecovery, needsIsolatedSceneRepair,
    staleEntitiesRejectedBeforeRecovery,
  } = attempt;
  const recoveringOwner = context.characterID === toInt(recoveredPocketState.characterID, 0);
  const resumedPocketUpdate = updatePocketState(recoveredPocketState.instanceID, {
    shipID: recoveringOwner
      ? toInt(movedShip && movedShip.itemID, shipID)
      : toInt(recoveredPocketState.shipID, 0),
    disconnectState: null,
    recoveredAtMs: deps.now(),
    relogRecoveryState: {
      resumedAtMs: deps.now(),
      transitionMode,
      clientRefreshSent,
    },
  });
  const resumedPocketState =
    getActivePocketStateByInstanceID(toInt(recoveredPocketState.instanceID, 0)) ||
    resumedPocketUpdate ||
    recoveredPocketState;
  setAbyssalSessionState(session, resumedPocketState, resumedPocketState.traceItemID);
  const resumedRoomIndex = buildPlaceholderRoomState(resumedPocketState).currentRoomIndex;
  const resumedParticipantShipID = toInt(movedShip && movedShip.itemID, shipID);
  const resumedShipEntity =
    sceneAfterRecovery && typeof sceneAfterRecovery.getEntityByID === "function"
      ? sceneAfterRecovery.getEntityByID(resumedParticipantShipID) || attachedEntity
      : attachedEntity;
  const resumedParticipantScopeResult = stampAbyssalParticipantRoomScope(
    resumedPocketState,
    resumedRoomIndex,
    session,
    resumedShipEntity,
    deps,
    {
      shipID: resumedParticipantShipID,
      persistedShip: deps.findItemById(resumedParticipantShipID) || movedShip,
      persist: true,
    },
  );
  if (!resumedParticipantScopeResult.success) {
    return abandonRelogRecovery(
      session,
      context,
      getActivePocketStateByInstanceID(toInt(resumedPocketState.instanceID, 0)) ||
        resumedPocketState,
      resumedParticipantScopeResult.errorMsg,
      deps,
    );
  }
  const relogWeatherResult = applyAbyssalWeatherToRun(resumedPocketState, session, deps, {
    reason: "relog-recovery",
    emitNotifications,
  });
  if (!isAbyssalWeatherApplicationReady(relogWeatherResult)) {
    return abandonRelogRecovery(
      session,
      context,
      getActivePocketStateByInstanceID(toInt(resumedPocketState.instanceID, 0)) ||
        resumedPocketState,
      "ABYSSAL_RELOG_WEATHER_NOT_READY",
      deps,
    );
  }
  if (session && typeof session === "object") {
    session._abyssalBootstrapMode = "relog-recovery";
  }
  schedulePlaceholderPocketMaintenance(deps);
  if (validatedBootstrapState) {
    logAbyssalRelogBootstrapState(session, recoveredPocketState, validatedBootstrapState, {
      initialSceneKey: bindingBeforeRecovery && bindingBeforeRecovery.actualSceneKey,
      repairAttempted: needsIsolatedSceneRepair,
      staleEntitiesRejected: staleEntitiesRejectedBeforeRecovery,
      bootstrapState: "ready-for-setstate",
      reason: "CURRENT_ROOM_VALIDATED",
    });
  }
  log.info(
      `[AbyssalMgr] Relog recovery resumed char=${context.characterID} ` +
      `ship=${toInt(movedShip && movedShip.itemID, shipID)} instance=${resumedPocketState.instanceID} ` +
      `trace=${resumedPocketState.traceItemID} transition=${transitionMode} ` +
      `objectiveComplete=${resumedPocketState.objectiveComplete === true} ` +
      `timerExpired=${Boolean(resumedPocketState.timerState && resumedPocketState.timerState.expired)} ` +
      `clientRefresh=${clientRefreshSent}`,
  );
  return {
    recovered: true,
    pocketState: getActivePocketStateByInstanceID(resumedPocketState.instanceID),
  };

}

function recoverAbyssalSessionState({
  getDependencies,
  getSessionContext,
  getActivePocketStateForCharacterID,
  getRecoverablePocketStateForCharacterID,
  isAbyssalHostLocationID,
  recoverOrphanedAbyssalHostSession,
  restoreAbyssalRecoveryParticipant,
  reconcileAbyssalSessionTerminalRecovery,
  checkAbyssalSessionRecoveryDeadline,
  prepareAbyssalRelogRuntime,
  inspectAbyssalRelogRuntime,
  bindExistingAbyssalSession,
  restoreAbyssalRelogPosition,
  restoreAbyssalRelogSceneContent,
  validateAbyssalRelogBootstrap,
  finishAbyssalSessionRecovery,
},
  session,
  deps = getDependencies(),
  options = {},
) {
  const emitNotifications = options.emitNotifications !== false;
  const context = getSessionContext(session);
  if (context.characterID <= 0 || context.systemID <= 0) {
    return {
      recovered: false,
      reason: "INVALID_SESSION_CONTEXT",
    };
  }

  const publicPocketState = getActivePocketStateForCharacterID(context.characterID);
  const recoverablePocketState = publicPocketState
    ? null
    : getRecoverablePocketStateForCharacterID(context.characterID);
  const pocketState = publicPocketState || recoverablePocketState;
  if (!pocketState) {
    if (isAbyssalHostLocationID(context.systemID, deps)) {
      return recoverOrphanedAbyssalHostSession(session, context, deps, "NO_ACTIVE_POCKET");
    }
    return {
      recovered: false,
      reason: "NO_ACTIVE_POCKET",
    };
  }
  const attempt = { pocketState, session, context, deps, options, emitNotifications };
  for (const operation of [
    restoreAbyssalRecoveryParticipant,
    reconcileAbyssalSessionTerminalRecovery,
    checkAbyssalSessionRecoveryDeadline,
    prepareAbyssalRelogRuntime,
    inspectAbyssalRelogRuntime,
    bindExistingAbyssalSession,
    restoreAbyssalRelogPosition,
    restoreAbyssalRelogSceneContent,
    validateAbyssalRelogBootstrap,
  ]) {
    const result = operation(attempt);
    if (result) return result;
  }
  return finishAbyssalSessionRecovery(attempt);
}

function routeAbyssalSessionTerminalCleanup({
  hasPendingAbyssalTerminalCleanup,
  hasUnresolvedAbyssalRecoveryObligation,
  cleanupAbyssalRun,
  resolveAbyssalRecoveryCleanupReason,
  getActivePocketStateByInstanceID,
}, session, pocketState, context, deps) {
  if (
    pocketState &&
    (
      hasPendingAbyssalTerminalCleanup(pocketState) ||
      (
        pocketState.gameplayAuthorityDetached === true &&
        hasUnresolvedAbyssalRecoveryObligation(
          pocketState,
          context.characterID,
        )
      )
    )
  ) {
    const cleanupResult = cleanupAbyssalRun(pocketState, deps, {
      reason: resolveAbyssalRecoveryCleanupReason(
        pocketState,
        "relog-terminal-cleanup-retry",
      ),
      session,
    });
    return {
      recovered: false,
      evacuated: false,
      activeRunBound: false,
      terminalCleanup: true,
      cleanedUp: cleanupResult && cleanupResult.success === true,
      reason: cleanupResult && cleanupResult.success === true
        ? "ABYSSAL_TERMINAL_CLEANUP_RECONCILED"
        : normalizeText(
            cleanupResult && cleanupResult.errorMsg,
            "ABYSSAL_TERMINAL_CLEANUP_PENDING",
          ),
      cleanupResult,
      pocketState: getActivePocketStateByInstanceID(
        toInt(pocketState.instanceID, 0),
      ),
    };
  }
  return null;
}

function routeAbyssalFreshEntryBootstrap({
  validateAbyssalFreshEntryBootstrapRoute,
  log,
  rollbackAbyssalFreshEntryBootstrap,
  updateAbyssalFreshEntryBootstrapStatus,
  getActivePocketStateByInstanceID,
}, session, pocketState, context, marker, deps) {
  if (
    pocketState &&
    marker &&
    ["pending", "consumed"].includes(normalizeText(marker.status, ""))
  ) {
    const validation = validateAbyssalFreshEntryBootstrapRoute(session, pocketState, deps);
    const descriptor = validation.descriptor;
    const requestedMode = normalizeText(marker.status, "") === "consumed"
      ? "active-bind"
      : "fresh-entry";
    log.info(
      `[AbyssalBootstrapRoute] mode=${requestedMode} character=${context.characterID} ` +
        `ship=${context.shipID} run=${toInt(pocketState.instanceID, 0)} ` +
        `room=${validation.roomIndex} token=${toInt(marker.token, 0)} ` +
        `sourceSolarSystemID=${toInt(pocketState.sourceSolarSystemID, 0)} ` +
        `clientAbyssalLocationID=${toInt(descriptor && descriptor.locationID, 0)} ` +
        `runSceneKey=${normalizeText(descriptor && descriptor.sceneKey, "none")} ` +
        `returnSolarSystemID=${toInt(pocketState.sourceSolarSystemID, 0)} ` +
        `reason=${validation.reason}`,
    );
    if (!validation.valid) {
      return rollbackAbyssalFreshEntryBootstrap(
        session,
        pocketState,
        `FRESH_ENTRY_ROUTE_INVALID:${validation.reason}`,
        deps,
      );
    }
    let routeMode = requestedMode;
    if (
      routeMode === "fresh-entry" &&
      session &&
      session._space &&
      session._space.initialStateSent === true
    ) {
      updateAbyssalFreshEntryBootstrapStatus(
        session,
        pocketState,
        "consumed",
        deps,
        "SETSTATE_ALREADY_DELIVERED",
      );
      routeMode = "active-bind";
    }
    return {
      recovered: false,
      evacuated: false,
      activeRunBound: true,
      freshEntry: routeMode === "fresh-entry",
      route: routeMode,
      bootstrapToken: toInt(marker.token, 0),
      reason: routeMode === "fresh-entry"
        ? "FRESH_ENTRY_BOOTSTRAP_PENDING"
        : "FRESH_ENTRY_BOOTSTRAP_CONSUMED",
      pocketState: getActivePocketStateByInstanceID(pocketState.instanceID),
    };
  }
  return null;
}

function routeAbyssalSessionStateForBeyonce({
  getDependencies,
  getSessionContext,
  getActivePocketStateForCharacterID,
  getRecoverablePocketStateForCharacterID,
  log,
  recoverAbyssalSessionState,
  evaluateAbyssalDirectCallbackTerminalGuard,
  hasTerminalFailureOutcome,
  routeAbyssalSessionTerminalCleanup,
  routeAbyssalFreshEntryBootstrap,
  buildPlaceholderRoomState,
}, session, deps = getDependencies()) {
  const context = getSessionContext(session);
  const activePocketState = getActivePocketStateForCharacterID(context.characterID);
  const recoveryPocketState = activePocketState
    ? null
    : getRecoverablePocketStateForCharacterID(context.characterID);
  const pocketState = activePocketState || recoveryPocketState;
  const marker = session && session._abyssalFreshEntryBootstrap;
  if (recoveryPocketState && recoveryPocketState.gameplayAuthorityDetached === true) {
    log.info(
      `[AbyssalRecovery] detached terminal run found during relog ` +
        `character=${context.characterID} ship=${context.shipID} ` +
        `run=${toInt(recoveryPocketState.instanceID, 0)}`,
    );
  }
  if (
    pocketState &&
    pocketState.entryRecoveryState &&
    pocketState.entryRecoveryState.pending === true
  ) {
    const recoveryResult = recoverAbyssalSessionState(session, deps);
    return {
      ...recoveryResult,
      freshEntry: false,
      route: "entry-recovery",
    };
  }
  const terminalGuard = evaluateAbyssalDirectCallbackTerminalGuard(
    pocketState,
    "beyonce-session-route",
    {
      allowPendingTerminalCleanup: true,
      allowDetachedGameplayAuthority: true,
    },
  );
  if (terminalGuard.blocked) {
    if (hasTerminalFailureOutcome(terminalGuard.pocketState)) {
      const recoveryResult = recoverAbyssalSessionState(session, deps);
      return {
        ...recoveryResult,
        freshEntry: false,
        route: "terminal-recovery",
        terminal: true,
        suppressed: true,
        guardReason: terminalGuard.reason,
      };
    }
    return {
      recovered: false,
      evacuated: false,
      activeRunBound: false,
      freshEntry: false,
      route: "terminal-suppressed",
      terminal: true,
      suppressed: true,
      reason: "ABYSSAL_RUN_TERMINALLY_SETTLED",
      guardReason: terminalGuard.reason,
      pocketState: terminalGuard.pocketState,
    };
  }
  const cleanupResult = routeAbyssalSessionTerminalCleanup(session, pocketState, context, deps);
  if (cleanupResult) return cleanupResult;
  const bootstrapResult = routeAbyssalFreshEntryBootstrap(session, pocketState, context, marker, deps);
  if (bootstrapResult) return bootstrapResult;

  log.info(
    `[AbyssalBootstrapRoute] mode=relog-recovery character=${context.characterID} ` +
      `ship=${context.shipID} run=${toInt(pocketState && pocketState.instanceID, 0)} ` +
      `room=${pocketState ? buildPlaceholderRoomState(pocketState).currentRoomIndex : 0} token=0 ` +
      `sourceSolarSystemID=${toInt(pocketState && pocketState.sourceSolarSystemID, 0)} ` +
      `clientAbyssalLocationID=${context.systemID} ` +
      `runSceneKey=${normalizeText(session && session._space && session._space.sceneKey, "none")} ` +
      `returnSolarSystemID=${toInt(pocketState && pocketState.sourceSolarSystemID, 0)} ` +
      `reason=${pocketState ? "NO_FRESH_ENTRY_TOKEN" : "NO_ACTIVE_POCKET"}`,
  );
  const recoveryResult = recoverAbyssalSessionState(session, deps);
  return {
    ...recoveryResult,
    freshEntry: false,
    route: "relog-recovery",
  };
}

// Capture supplied capabilities once, as the original closure did. Internal
// callbacks are bound once per instance; no runtime state lives in this wiring.
function createAbyssalSessionRecovery({
  getDependencies,
  getSessionContext,
  getActivePocketStateForCharacterID,
  getRecoverablePocketStateForCharacterID,
  log,
  evaluateAbyssalDirectCallbackTerminalGuard,
  hasTerminalFailureOutcome,
  hasPendingAbyssalTerminalCleanup,
  hasUnresolvedAbyssalRecoveryObligation,
  cleanupAbyssalRun,
  resolveAbyssalRecoveryCleanupReason,
  getActivePocketStateByInstanceID,
  validateAbyssalFreshEntryBootstrapRoute,
  rollbackAbyssalFreshEntryBootstrap,
  updateAbyssalFreshEntryBootstrapStatus,
  buildPlaceholderRoomState,
  isAbyssalHostLocationID,
  recoverOrphanedAbyssalHostSession,
  getAbyssalParticipantRecord,
  ABYSSAL_PARTICIPANT_STATUS,
  upsertAbyssalParticipantRosterEntry,
  commitPocketStateDurably,
  cloneValue,
  reconcilePendingAbyssalEntryRecovery,
  clearPendingAbyssalTraceActivation,
  reconcileCommittedAbyssalParticipantDeath,
  hasFailedTimeoutOutcome,
  logRecoveredAbyssalSceneMode,
  syncExpiredAbyssalPocketState,
  hasFailedParticipantShipDestroyedOutcome,
  usesIsolatedAbyssalScene,
  buildAbyssalSceneDescriptor,
  abandonRelogRecovery,
  listPocketHostileEntityIDs,
  getPocketScene,
  getObjectPosition,
  calculateAbyssalRemainingDuration,
  logRelogRecoveryState,
  isPointWithinPocketRecoveryRadius,
  inspectAbyssalRelogBootstrapState,
  setAbyssalSessionState,
  stampAbyssalParticipantRoomScope,
  applyAbyssalWeatherToRun,
  isAbyssalWeatherApplicationReady,
  queueAbyssalClientEnvironmentDelivery,
  completeAbyssalEntryReadyForSession,
  schedulePlaceholderPocketMaintenance,
  formatVectorForLog,
  buildAbyssalParticipantRoomScopeMetadata,
  syncInventoryChanges,
  usesAuthoredAbyssalEnvironmentNotification,
  markAbyssalDungeonRoomWithoutGenericNotification,
  shouldAttemptAuthoredSiteMaterialization,
  spawnPlaceholderPocketContent,
  broadcastAbyssalRoomBootstrapAddBalls,
  logAbyssalRelogBootstrapState,
  updatePocketState,
}) {

  const ports = {
    getDependencies,
    getSessionContext,
    getActivePocketStateForCharacterID,
    getRecoverablePocketStateForCharacterID,
    log,
    evaluateAbyssalDirectCallbackTerminalGuard,
    hasTerminalFailureOutcome,
    hasPendingAbyssalTerminalCleanup,
    hasUnresolvedAbyssalRecoveryObligation,
    cleanupAbyssalRun,
    resolveAbyssalRecoveryCleanupReason,
    getActivePocketStateByInstanceID,
    validateAbyssalFreshEntryBootstrapRoute,
    rollbackAbyssalFreshEntryBootstrap,
    updateAbyssalFreshEntryBootstrapStatus,
    buildPlaceholderRoomState,
    isAbyssalHostLocationID,
    recoverOrphanedAbyssalHostSession,
    getAbyssalParticipantRecord,
    ABYSSAL_PARTICIPANT_STATUS,
    upsertAbyssalParticipantRosterEntry,
    commitPocketStateDurably,
    cloneValue,
    reconcilePendingAbyssalEntryRecovery,
    clearPendingAbyssalTraceActivation,
    reconcileCommittedAbyssalParticipantDeath,
    hasFailedTimeoutOutcome,
    logRecoveredAbyssalSceneMode,
    syncExpiredAbyssalPocketState,
    hasFailedParticipantShipDestroyedOutcome,
    usesIsolatedAbyssalScene,
    buildAbyssalSceneDescriptor,
    abandonRelogRecovery,
    listPocketHostileEntityIDs,
    getPocketScene,
    getObjectPosition,
    calculateAbyssalRemainingDuration,
    logRelogRecoveryState,
    isPointWithinPocketRecoveryRadius,
    inspectAbyssalRelogBootstrapState,
    setAbyssalSessionState,
    stampAbyssalParticipantRoomScope,
    applyAbyssalWeatherToRun,
    isAbyssalWeatherApplicationReady,
    queueAbyssalClientEnvironmentDelivery,
    completeAbyssalEntryReadyForSession,
    schedulePlaceholderPocketMaintenance,
    formatVectorForLog,
    buildAbyssalParticipantRoomScopeMetadata,
    syncInventoryChanges,
    usesAuthoredAbyssalEnvironmentNotification,
    markAbyssalDungeonRoomWithoutGenericNotification,
    shouldAttemptAuthoredSiteMaterialization,
    spawnPlaceholderPocketContent,
    broadcastAbyssalRoomBootstrapAddBalls,
    logAbyssalRelogBootstrapState,
    updatePocketState,
  };
  ports.restoreAbyssalRecoveryParticipant = restoreAbyssalRecoveryParticipant.bind(null, ports);
  ports.reconcileAbyssalSessionTerminalRecovery = reconcileAbyssalSessionTerminalRecovery.bind(null, ports);
  ports.checkAbyssalSessionRecoveryDeadline = checkAbyssalSessionRecoveryDeadline.bind(null, ports);
  ports.prepareAbyssalRelogRuntime = prepareAbyssalRelogRuntime.bind(null, ports);
  ports.inspectAbyssalRelogRuntime = inspectAbyssalRelogRuntime.bind(null, ports);
  ports.bindExistingAbyssalSession = bindExistingAbyssalSession.bind(null, ports);
  ports.restoreAbyssalRelogPosition = restoreAbyssalRelogPosition.bind(null, ports);
  ports.restoreAbyssalRelogSceneContent = restoreAbyssalRelogSceneContent.bind(null, ports);
  ports.validateAbyssalRelogBootstrap = validateAbyssalRelogBootstrap.bind(null, ports);
  ports.finishAbyssalSessionRecovery = finishAbyssalSessionRecovery.bind(null, ports);
  ports.recoverAbyssalSessionState = recoverAbyssalSessionState.bind(null, ports);
  ports.routeAbyssalSessionTerminalCleanup = routeAbyssalSessionTerminalCleanup.bind(null, ports);
  ports.routeAbyssalFreshEntryBootstrap = routeAbyssalFreshEntryBootstrap.bind(null, ports);
  ports.routeAbyssalSessionStateForBeyonce = routeAbyssalSessionStateForBeyonce.bind(null, ports);
  Object.freeze(ports);
  return {
    routeAbyssalSessionStateForBeyonce: ports.routeAbyssalSessionStateForBeyonce,
    recoverAbyssalSessionState: ports.recoverAbyssalSessionState,
  };
}

module.exports = { createAbyssalSessionRecovery };
