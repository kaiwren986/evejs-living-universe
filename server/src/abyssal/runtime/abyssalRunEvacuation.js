"use strict";

const { normalizeText } = require("../domain/abyssalValueUtils");

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

// Runtime callbacks for the existing durable recovery coordinator. Mutable values
// belong to one evacuation attempt, never to the module or another participant.
function buildAbyssalEvacuationContext({
  getAbyssalParticipantRecord,
  usesIsolatedAbyssalScene,
  buildAbyssalSceneDescriptor,
  cloneValue,
  buildAbyssalParticipantReturnSpaceState,
  buildPlaceholderReturnSpaceState,
  isAbyssalHostLocationID,
  getObjectPosition,
  ABYSSAL_RECOVERY_ORIGIN_UNRESOLVED,
  normalizeAbyssalRecoveryOriginAttempts,
  getActivePocketStateByInstanceID,
  normalizeAbyssalParticipantRoster,
  getAbyssalWeatherRemovalState,
}, session, pocketState, reason, deps, options, suppliedInstanceID, syntheticOrphanRecovery) {
  const runtime = deps;
  const sessionShipID = session
    ? toInt(session.shipID || session.shipid || session.activeShipID, 0)
    : 0;
  const shipID = sessionShipID || toInt(pocketState && pocketState.shipID, 0);
  const sessionCharacterID = session ? toInt(session.characterID, 0) : 0;
  const characterID =
    sessionCharacterID || toInt(pocketState && pocketState.characterID, 0);
  const currentScene =
    runtime && typeof runtime.getSceneForSession === "function"
      ? runtime.getSceneForSession(session)
      : null;
  const currentShipEntity =
    currentScene && typeof currentScene.getShipEntityForSession === "function"
      ? currentScene.getShipEntityForSession(session)
      : null;
  const rosterParticipant = getAbyssalParticipantRecord(
    pocketState,
    characterID,
  );
  const isolatedSceneDescriptor = usesIsolatedAbyssalScene(pocketState, deps)
    ? buildAbyssalSceneDescriptor(pocketState, deps)
    : null;
  const returnSpaceState = options.returnSpaceStateOverride &&
    typeof options.returnSpaceStateOverride === "object"
    ? cloneValue(options.returnSpaceStateOverride)
    : rosterParticipant
      ? buildAbyssalParticipantReturnSpaceState(
          pocketState,
          rosterParticipant,
          currentShipEntity,
        )
      : buildPlaceholderReturnSpaceState(pocketState, currentShipEntity);
  const targetSystemID = toInt(returnSpaceState && returnSpaceState.systemID, 0);
  const hostLocationID = toInt(
    options.hostLocationID,
    toInt(
      pocketState && pocketState.solarSystemID,
      toInt(session && (session.solarsystemid2 || session.solarsystemid), 0),
    ),
  );
  const recoveryOriginResolved = options.recoveryOriginResolved === undefined
    ? Boolean(
        targetSystemID > 0 &&
        !isAbyssalHostLocationID(targetSystemID, deps),
      )
    : options.recoveryOriginResolved === true;
  const recoveryTargetSource = normalizeText(
    options.recoveryTargetSource,
    recoveryOriginResolved ? "pocketState" : "emergencyFallback",
  );
  const destinationDecision = {
    status: recoveryOriginResolved ? "authoritative" : "emergencyFallback",
    source: recoveryTargetSource,
    originResolved: recoveryOriginResolved,
    systemID: targetSystemID,
    position: getObjectPosition(returnSpaceState) || { x: 0, y: 0, z: 0 },
    originResolutionReason: recoveryOriginResolved
      ? null
      : normalizeText(
          options.originResolutionReason,
          ABYSSAL_RECOVERY_ORIGIN_UNRESOLVED,
        ),
    emergencyFallbackSelected: recoveryOriginResolved !== true,
  };
  const sourceSceneKey = normalizeText(
    isolatedSceneDescriptor && isolatedSceneDescriptor.sceneKey,
    "",
  );
  const recoveryRequest = {
    instanceID: suppliedInstanceID,
    characterID,
    shipID,
    hostLocationID,
    sourceSceneKey,
    recoveryReason: normalizeText(reason, "abyssal-evacuation"),
    destinationDecision,
    returnSpaceState,
    idempotencyKey: normalizeText(
      options.idempotencyKey,
      "abyssal-evacuation:" + suppliedInstanceID + ":" + characterID + ":" + shipID,
    ),
    initialObligationState: normalizeText(options.tombstoneState, "pending"),
    originAuthorityAttempts: normalizeAbyssalRecoveryOriginAttempts(
      options.originAuthorityAttempts,
    ),
    durableState: {
      syntheticOrphanRecovery,
      alreadyMoveCommitted: options.alreadyMoveCommitted === true,
      cleanupRequired: options.cleanupRun !== false,
      runActive: Boolean(
        !syntheticOrphanRecovery &&
        suppliedInstanceID > 0 &&
        getActivePocketStateByInstanceID(suppliedInstanceID)
      ),
      recoveryState: cloneValue(pocketState),
      participant: cloneValue(rosterParticipant),
      participantRoster: normalizeAbyssalParticipantRoster(pocketState),
      gameplayAuthorityDetachedAtMs: toInt(
        pocketState && pocketState.gameplayAuthorityDetachedAtMs,
        0,
      ),
      committedEvacuationState: cloneValue(
        pocketState && pocketState.committedEvacuationState || {},
      ),
      weatherRemovalState: cloneValue(
        getAbyssalWeatherRemovalState(pocketState) || {},
      ),
      traceItemID: toInt(pocketState && pocketState.traceItemID, 0),
      entryRecoveryPending: Boolean(
        pocketState &&
        pocketState.entryRecoveryState &&
        pocketState.entryRecoveryState.pending === true
      ),
    },
  };
  return {
    session, pocketState, reason, deps, options, suppliedInstanceID, syntheticOrphanRecovery,
    runtime, sessionShipID, shipID, sessionCharacterID, characterID, isolatedSceneDescriptor,
    returnSpaceState, targetSystemID, hostLocationID, recoveryOriginResolved, recoveryTargetSource,
    sourceSceneKey, recoveryRequest, tombstone: null, shipItem: null, attachedSessionSceneKey: "", cleanupResult: null,
  };
}

function revalidateAbyssalEvacuation({
  getActivePocketStateByInstanceID,
  getAbyssalParticipantRecord,
}, context, stageRequest) {
  const { suppliedInstanceID, pocketState, characterID, sessionCharacterID, sessionShipID, shipID, hostLocationID, sourceSceneKey, options } = context;
  const activeRecoveryState =
    getActivePocketStateByInstanceID(suppliedInstanceID) || pocketState;
  const participant = getAbyssalParticipantRecord(
    activeRecoveryState,
    characterID,
  );
  const identity = {
    instanceID: suppliedInstanceID,
    characterID: sessionCharacterID ||
      toInt(activeRecoveryState && activeRecoveryState.characterID, characterID),
    shipID: sessionShipID ||
      toInt(
        activeRecoveryState && activeRecoveryState.shipID,
        toInt(participant && participant.shipID, shipID),
      ),
    hostLocationID: toInt(
      options.hostLocationID,
      toInt(activeRecoveryState && activeRecoveryState.solarSystemID, hostLocationID),
    ),
    sourceSceneKey,
  };
  return {
    success: Boolean(
      identity.characterID === characterID &&
      identity.shipID === shipID &&
      identity.hostLocationID === hostLocationID
    ),
    identity,
    destinationDecision: stageRequest.destinationDecision,
    errorMsg: "ABYSSAL_RECOVERY_EXECUTION_REVALIDATION_IDENTITY_MISMATCH",
  };
}

function persistAbyssalEvacuationObligation({
  rememberAbyssalRecoveryTombstone,
  updateAbyssalRecoveryTombstoneState,
  cloneValue,
}, context, stageRequest) {
  context.tombstone = stageRequest.mode === "create"
    ? rememberAbyssalRecoveryTombstone(stageRequest.record)
    : updateAbyssalRecoveryTombstoneState(
        context.tombstone,
        stageRequest.evacuationState,
        stageRequest.patch,
      );
  return {
    success: Boolean(context.tombstone),
    obligation: cloneValue(context.tombstone),
    errorMsg: "ABYSSAL_RECOVERY_OBLIGATION_PERSIST_FAILED",
  };
}

function loadAbyssalEvacuationShip({
  getObjectPosition,
  cloneValue,
}, context) {
  const { deps, shipID, runtime, targetSystemID } = context;
  context.shipItem = shipID > 0 ? deps.findItemById(shipID) : null;
  if (!runtime || shipID <= 0 || targetSystemID <= 0 || !context.shipItem) {
    return {
      success: false,
      errorMsg: !runtime
        ? "RUNTIME_UNAVAILABLE"
        : shipID <= 0
          ? "SHIP_ID_MISSING"
          : targetSystemID <= 0
            ? "RETURN_SYSTEM_MISSING"
            : "SHIP_ITEM_NOT_FOUND",
    };
  }
  const position = getObjectPosition(context.shipItem && context.shipItem.spaceState);
  return {
    success: true,
    shipItem: cloneValue(context.shipItem),
    systemID: toInt(
      context.shipItem && context.shipItem.spaceState && context.shipItem.spaceState.systemID,
      toInt(context.shipItem && context.shipItem.locationID, 0),
    ),
    position,
    positionPresent: Boolean(position),
  };
}

function moveAbyssalEvacuationShip({}, context, stageRequest) {
  const { deps, shipID, targetSystemID } = context;
  return deps.moveShipToSpace(
    shipID,
    targetSystemID,
    stageRequest.returnSpaceState,
  );
}

function commitAbyssalEvacuationState({
  getActivePocketStateByInstanceID,
  cloneValue,
  commitPocketStateDurably,
}, context, stageRequest) {
  const { suppliedInstanceID, pocketState, deps } = context;
  if (
    [
      "commit_recovery_receipt",
      "settle_recovery_obligation",
    ].includes(stageRequest.stage) &&
    !getActivePocketStateByInstanceID(suppliedInstanceID)
  ) {
    return {
      success: true,
      skipped: true,
      state: cloneValue(stageRequest.recoveryState || pocketState),
    };
  }
  return commitPocketStateDurably(
    suppliedInstanceID,
    stageRequest.patch,
    deps,
    { verifyReadBack: true, forceWrite: true },
  );
}

function ensureAbyssalEvacuationDurable({
  ensureAbyssalPocketPersistenceReady,
}, context, stageRequest) {
  const { deps } = context;
  return stageRequest.recoveryState
    ? ensureAbyssalPocketPersistenceReady(
        stageRequest.recoveryState,
        deps,
      )
    : { success: false };
}

function reconcileAbyssalEvacuationSession({
  updateCharacterLocationForAbyssalEvacuation,
  syncInventoryChanges,
  buildAbyssalExitSessionChanges,
  applyAbyssalEntrySessionFields,
  sendAbyssalEntrySessionChange,
  clearAbyssalSessionState,
}, context, stageRequest) {
  const { session, runtime, shipID, characterID, targetSystemID, deps, isolatedSceneDescriptor, suppliedInstanceID, shipItem } = context;
  const moveResult = stageRequest.movementResult;
  const alreadyAtReturnTarget =
    stageRequest.context.alreadyAtReturnTarget === true;
  if (session && session._space && typeof runtime.detachSession === "function") {
    runtime.detachSession(session, {
      broadcast: false,
      lifecycleReason: "abyssal-evacuation",
    });
  }
  const staleScene =
    typeof runtime.findSceneContainingDynamicEntity === "function"
      ? runtime.findSceneContainingDynamicEntity(shipID)
      : null;
  if (staleScene && typeof staleScene.removeDynamicEntity === "function") {
    staleScene.removeDynamicEntity(shipID, {
      broadcast: false,
      lifecycleReason: "abyssal-evacuation",
    });
  }
  const characterUpdateResult = updateCharacterLocationForAbyssalEvacuation(
    characterID,
    targetSystemID,
    deps,
  );
  if (characterUpdateResult && characterUpdateResult.success === false) {
    return {
      success: false,
      errorMsg:
        characterUpdateResult.errorMsg || "CHARACTER_UPDATE_FAILED",
    };
  }

  let attachedEntity = null;
  if (session) {
    if (!alreadyAtReturnTarget) {
      syncInventoryChanges(session, [{
        item: moveResult.data,
        previousData: moveResult.previousData || shipItem,
      }], deps);
    }
    const exitSessionChangeState = isolatedSceneDescriptor
      ? buildAbyssalExitSessionChanges(
          session,
          targetSystemID,
          moveResult.data,
          isolatedSceneDescriptor,
        )
      : null;
    if (exitSessionChangeState) {
      applyAbyssalEntrySessionFields(
        session,
        exitSessionChangeState.target,
        moveResult.data,
      );
      sendAbyssalEntrySessionChange(session, exitSessionChangeState, {
        mode: "isolated-scene-rollback",
        characterID,
        instanceID: suppliedInstanceID,
      });
    } else {
      session.locationid = targetSystemID;
      session.solarsystemid = targetSystemID;
      session.solarsystemid2 = targetSystemID;
      session.shipID = moveResult.data.itemID;
      session.shipid = moveResult.data.itemID;
      session.activeShipID = moveResult.data.itemID;
      session.activeShipId = moveResult.data.itemID;
      session.shipTypeID = moveResult.data.typeID;
    }
    clearAbyssalSessionState(session);
    attachedEntity =
      typeof runtime.attachSession === "function"
        ? runtime.attachSession(session, moveResult.data, {
            systemID: targetSystemID,
            reconcileUniverseSites: true,
            spawnAsteroidBeltRats: true,
            pendingUndockMovement: false,
            broadcast: true,
            spawnStopped: true,
          })
        : null;
    if (!attachedEntity || !session._space) {
      return {
        success: false,
        errorMsg: "ABYSSAL_EVACUATION_ATTACH_FAILED",
      };
    }
    if (typeof deps.queuePostSpaceAttachFittingHydration === "function") {
      deps.queuePostSpaceAttachFittingHydration(session, moveResult.data.itemID, {
        hydrationProfile: "transition",
      });
    }
  }
  return {
    success: true,
    sessionPresent: Boolean(session),
    attached: Boolean(attachedEntity),
  };
}

function verifyAbyssalEvacuationReturn({
  log,
}, context) {
  const { deps, shipID, runtime, targetSystemID, session, characterID, suppliedInstanceID } = context;
  const persistedShip = deps.findItemById(shipID);
  const persistedSystemID = toInt(
    persistedShip && persistedShip.spaceState &&
      persistedShip.spaceState.systemID,
    toInt(persistedShip && persistedShip.locationID, 0),
  );
  const expectedSceneKey =
    typeof runtime.buildSolarSystemSceneKey === "function"
      ? runtime.buildSolarSystemSceneKey(targetSystemID)
      : "solar-system:" + targetSystemID;
  const attachedScene =
    session && typeof runtime.getSceneForSession === "function"
      ? runtime.getSceneForSession(session)
      : null;
  const attachedShipEntity =
    attachedScene && typeof attachedScene.getShipEntityForSession === "function"
      ? attachedScene.getShipEntityForSession(session)
      : null;
  context.attachedSessionSceneKey = normalizeText(
    session && (
      session.spaceSceneKey ||
      session._space && session._space.sceneKey
    ),
    "",
  );
  const lingeringHostScene =
    typeof runtime.findSceneContainingDynamicEntity === "function"
      ? runtime.findSceneContainingDynamicEntity(shipID)
      : null;
  const invariantFailures = [];
  if (persistedSystemID !== targetSystemID) {
    invariantFailures.push("persisted=" + persistedSystemID);
  }
  if (session) {
    const sessionSystemID = toInt(
      session.solarsystemid2 || session.solarsystemid,
      0,
    );
    if (sessionSystemID !== targetSystemID) {
      invariantFailures.push("session=" + sessionSystemID);
    }
    if (!attachedScene || context.attachedSessionSceneKey !== expectedSceneKey) {
      invariantFailures.push(
        "sceneKey=" + (context.attachedSessionSceneKey || "none"),
      );
    }
    if (!attachedShipEntity || toInt(attachedShipEntity.itemID, 0) !== shipID) {
      invariantFailures.push("ego=missing");
    }
  } else if (
    lingeringHostScene &&
    lingeringHostScene.sceneKey !== expectedSceneKey
  ) {
    invariantFailures.push(
      "staleScene=" + (lingeringHostScene.sceneKey || "unknown"),
    );
  }
  if (invariantFailures.length > 0) {
    log.warn(
      "[AbyssalRecovery] evacuation invariant failed char=" + characterID +
        " ship=" + shipID + " run=" + suppliedInstanceID +
        " targetSystem=" + targetSystemID +
        " failures=" + invariantFailures.join(","),
    );
    return {
      success: false,
      invariantFailures,
      errorMsg: "ABYSSAL_EVACUATION_INVARIANT_FAILED",
    };
  }
  return {
    success: true,
    persistedSystemID,
    sceneKey: context.attachedSessionSceneKey,
  };
}

function cleanupAbyssalEvacuation({
  cleanupAbyssalRun,
}, context, stageRequest) {
  const { options, pocketState, deps, reason, session } = context;
  context.cleanupResult = options.cleanupRun === false
    ? { success: true, skipped: true }
    : cleanupAbyssalRun(pocketState, deps, {
        reason:
          "relog-recovery-evacuation-" +
          normalizeText(reason, "unknown").toLowerCase(),
        session,
        allowPendingEntryRecoveryCleanup: Boolean(
          stageRequest.recoveryState &&
          stageRequest.recoveryState.entryRecoveryState &&
          stageRequest.recoveryState.entryRecoveryState.pending === true
        ),
      });
  return context.cleanupResult && typeof context.cleanupResult === "object"
    ? context.cleanupResult
    : {
        success: false,
        errorMsg: "ABYSSAL_EVACUATION_CLEANUP_PENDING",
      };
}

function scheduleAbyssalEvacuationRetry({
  schedulePlaceholderPocketMaintenance,
}, context) {
  const { deps } = context;
  schedulePlaceholderPocketMaintenance(deps);
  return { success: true };
}

function getAbyssalEvacuationTime({}, context) {
  const { deps } = context;
  return toInt(deps && deps.now && deps.now(), Date.now());
}

function finishAbyssalEvacuation({
  log,
  ABYSSAL_RECOVERY_ORIGIN_UNRESOLVED,
}, context, recoveryExecutionResult) {
  let { cleanupResult } = context;
  const { targetSystemID, returnSpaceState, characterID, shipID, suppliedInstanceID, reason,
    attachedSessionSceneKey, recoveryOriginResolved, options, recoveryTargetSource } = context;
  const historicalErrorMsg = normalizeText(
    recoveryExecutionResult && recoveryExecutionResult.errorMsg,
    "ABYSSAL_EVACUATION_FAILED",
  );
  if (!recoveryExecutionResult || recoveryExecutionResult.success !== true) {
    const sourceCommitIrreversible = Boolean(
      recoveryExecutionResult &&
      recoveryExecutionResult.sourceCommitIrreversible === true,
    );
    return {
      success: false,
      evacuated: sourceCommitIrreversible,
      ...(sourceCommitIrreversible
        ? {
            committed: true,
            sourceCommitIrreversible: true,
            returnSystemID: targetSystemID,
            returnSpaceState,
          }
        : {}),
      errorMsg:
        historicalErrorMsg ===
          "ABYSSAL_RECOVERY_EXECUTION_DESTINATION_INVALID"
          ? "RETURN_SYSTEM_MISSING"
          : historicalErrorMsg,
      recoveryExecutionResult,
    };
  }

  cleanupResult = recoveryExecutionResult.cleanupResult || cleanupResult;
  log.warn(
    "[AbyssalRecovery] evacuation char=" + characterID +
      " ship=" + shipID + " run=" + suppliedInstanceID +
      " reason=" + normalizeText(reason, "UNKNOWN") +
      " returnSystem=" + targetSystemID +
      " sceneKey=" + (attachedSessionSceneKey || "none") +
      " cleanup=" + Boolean(cleanupResult && cleanupResult.success === true),
  );
  return {
    success: true,
    evacuated: true,
    moved: recoveryExecutionResult.moved === true,
    alreadyAtReturnTarget:
      recoveryExecutionResult.alreadyAtReturnTarget === true,
    returnSystemID: targetSystemID,
    returnSpaceState,
    originResolved: recoveryOriginResolved,
    originResolutionReason: recoveryOriginResolved
      ? null
      : normalizeText(
          options.originResolutionReason,
          ABYSSAL_RECOVERY_ORIGIN_UNRESOLVED,
        ),
    recoveryTargetSource,
    cleanupResult,
    recoveryExecutionResult,
  };
}

function evacuateAbyssalRunSession({
  getDependencies,
  ensureAbyssalPocketDurablyAdopted,
  cloneValue,
  buildAbyssalEvacuationContext,
  createAbyssalRecoveryExecutionCoordinator,
  revalidateAbyssalEvacuation,
  persistAbyssalEvacuationObligation,
  loadAbyssalEvacuationShip,
  moveAbyssalEvacuationShip,
  commitAbyssalEvacuationState,
  ensureAbyssalEvacuationDurable,
  reconcileAbyssalEvacuationSession,
  verifyAbyssalEvacuationReturn,
  cleanupAbyssalEvacuation,
  scheduleAbyssalEvacuationRetry,
  getAbyssalEvacuationTime,
  finishAbyssalEvacuation,
},
  session,
  pocketState,
  reason,
  deps = getDependencies(),
  options = {},
) {
  const suppliedInstanceID = toInt(pocketState && pocketState.instanceID, 0);
  const syntheticOrphanRecovery = options.syntheticOrphanRecovery === true;
  if (suppliedInstanceID > 0 && !syntheticOrphanRecovery) {
    const adoptionResult = ensureAbyssalPocketDurablyAdopted(
      pocketState,
      deps,
      { verifyReadBack: true },
    );
    if (!adoptionResult || adoptionResult.success !== true) {
      return {
        success: false,
        evacuated: false,
        errorMsg: normalizeText(
          adoptionResult && adoptionResult.errorMsg,
          "ABYSSAL_POCKET_DURABLE_ADOPTION_FAILED",
        ),
      };
    }
    pocketState = cloneValue(
      adoptionResult.committedState || adoptionResult.state,
    );
  }
  const context = buildAbyssalEvacuationContext(
    session, pocketState, reason, deps, options, suppliedInstanceID, syntheticOrphanRecovery,
  );
  const recoveryCoordinator = createAbyssalRecoveryExecutionCoordinator({
    revalidateRecovery: (stageRequest) => revalidateAbyssalEvacuation(context, stageRequest),
    persistRecoveryObligation: (stageRequest) => persistAbyssalEvacuationObligation(context, stageRequest),
    loadParticipantReturnState: () => loadAbyssalEvacuationShip(context),
    moveParticipant: (stageRequest) => moveAbyssalEvacuationShip(context, stageRequest),
    commitRecoveryState: (stageRequest) => commitAbyssalEvacuationState(context, stageRequest),
    ensureRecoveryStateDurable: (stageRequest) => ensureAbyssalEvacuationDurable(context, stageRequest),
    reconcileSession: (stageRequest) => reconcileAbyssalEvacuationSession(context, stageRequest),
    verifyParticipantReturn: () => verifyAbyssalEvacuationReturn(context),
    performRecoveryCleanup: (stageRequest) => cleanupAbyssalEvacuation(context, stageRequest),
    scheduleRecovery: () => scheduleAbyssalEvacuationRetry(context),
    getCurrentTime: () => getAbyssalEvacuationTime(context),
  });
  return finishAbyssalEvacuation(context, recoveryCoordinator.executeRecovery(context.recoveryRequest));
}

// Capture supplied capabilities once, as the original closure did. Internal
// callbacks are bound once per instance; no runtime state lives in this wiring.
function createAbyssalRunEvacuation({
  getAbyssalParticipantRecord,
  usesIsolatedAbyssalScene,
  buildAbyssalSceneDescriptor,
  cloneValue,
  buildAbyssalParticipantReturnSpaceState,
  buildPlaceholderReturnSpaceState,
  isAbyssalHostLocationID,
  getObjectPosition,
  ABYSSAL_RECOVERY_ORIGIN_UNRESOLVED,
  normalizeAbyssalRecoveryOriginAttempts,
  getActivePocketStateByInstanceID,
  normalizeAbyssalParticipantRoster,
  getAbyssalWeatherRemovalState,
  rememberAbyssalRecoveryTombstone,
  updateAbyssalRecoveryTombstoneState,
  commitPocketStateDurably,
  ensureAbyssalPocketPersistenceReady,
  updateCharacterLocationForAbyssalEvacuation,
  syncInventoryChanges,
  buildAbyssalExitSessionChanges,
  applyAbyssalEntrySessionFields,
  sendAbyssalEntrySessionChange,
  clearAbyssalSessionState,
  log,
  cleanupAbyssalRun,
  schedulePlaceholderPocketMaintenance,
  getDependencies,
  ensureAbyssalPocketDurablyAdopted,
  createAbyssalRecoveryExecutionCoordinator,
}) {

  const ports = {
    getAbyssalParticipantRecord,
    usesIsolatedAbyssalScene,
    buildAbyssalSceneDescriptor,
    cloneValue,
    buildAbyssalParticipantReturnSpaceState,
    buildPlaceholderReturnSpaceState,
    isAbyssalHostLocationID,
    getObjectPosition,
    ABYSSAL_RECOVERY_ORIGIN_UNRESOLVED,
    normalizeAbyssalRecoveryOriginAttempts,
    getActivePocketStateByInstanceID,
    normalizeAbyssalParticipantRoster,
    getAbyssalWeatherRemovalState,
    rememberAbyssalRecoveryTombstone,
    updateAbyssalRecoveryTombstoneState,
    commitPocketStateDurably,
    ensureAbyssalPocketPersistenceReady,
    updateCharacterLocationForAbyssalEvacuation,
    syncInventoryChanges,
    buildAbyssalExitSessionChanges,
    applyAbyssalEntrySessionFields,
    sendAbyssalEntrySessionChange,
    clearAbyssalSessionState,
    log,
    cleanupAbyssalRun,
    schedulePlaceholderPocketMaintenance,
    getDependencies,
    ensureAbyssalPocketDurablyAdopted,
    createAbyssalRecoveryExecutionCoordinator,
  };
  ports.buildAbyssalEvacuationContext = buildAbyssalEvacuationContext.bind(null, ports);
  ports.revalidateAbyssalEvacuation = revalidateAbyssalEvacuation.bind(null, ports);
  ports.persistAbyssalEvacuationObligation = persistAbyssalEvacuationObligation.bind(null, ports);
  ports.loadAbyssalEvacuationShip = loadAbyssalEvacuationShip.bind(null, ports);
  ports.moveAbyssalEvacuationShip = moveAbyssalEvacuationShip.bind(null, ports);
  ports.commitAbyssalEvacuationState = commitAbyssalEvacuationState.bind(null, ports);
  ports.ensureAbyssalEvacuationDurable = ensureAbyssalEvacuationDurable.bind(null, ports);
  ports.reconcileAbyssalEvacuationSession = reconcileAbyssalEvacuationSession.bind(null, ports);
  ports.verifyAbyssalEvacuationReturn = verifyAbyssalEvacuationReturn.bind(null, ports);
  ports.cleanupAbyssalEvacuation = cleanupAbyssalEvacuation.bind(null, ports);
  ports.scheduleAbyssalEvacuationRetry = scheduleAbyssalEvacuationRetry.bind(null, ports);
  ports.getAbyssalEvacuationTime = getAbyssalEvacuationTime.bind(null, ports);
  ports.finishAbyssalEvacuation = finishAbyssalEvacuation.bind(null, ports);
  ports.evacuateAbyssalRunSession = evacuateAbyssalRunSession.bind(null, ports);
  Object.freeze(ports);
  return { evacuateAbyssalRunSession: ports.evacuateAbyssalRunSession };
}

module.exports = { createAbyssalRunEvacuation };
