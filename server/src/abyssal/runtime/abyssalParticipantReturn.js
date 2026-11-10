"use strict";

const { normalizeText } = require("../domain/abyssalValueUtils");

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

// Participant return is a staged operation over existing roster and trace
// authority. A persisted move is reused after an interrupted exit receipt.
function buildAbyssalParticipantReturnSpaceState({
  buildPlaceholderReturnSpaceState,
  cloneValue,
  toReal,
}, pocketState, participant, currentShipEntity = null) {
  return buildPlaceholderReturnSpaceState({
    ...cloneValue(pocketState),
    characterID: toInt(participant && participant.characterID, pocketState.characterID),
    shipID: toInt(participant && participant.shipID, pocketState.shipID),
    sourceSolarSystemID: toInt(
      participant && participant.sourceSolarSystemID,
      pocketState.sourceSolarSystemID,
    ),
    sourceLocationID: toInt(
      participant && participant.sourceLocationID,
      pocketState.sourceLocationID,
    ),
    sourceShipPosition: cloneValue(
      participant && participant.sourceShipPosition || pocketState.sourceShipPosition,
    ),
    sourceShipDirection: cloneValue(
      participant && participant.sourceShipDirection || pocketState.sourceShipDirection,
    ),
    sourceShipRadius: toReal(
      participant && participant.sourceShipRadius,
      pocketState.sourceShipRadius,
    ),
  }, currentShipEntity);
}

function buildAbyssalParticipantReturnObligationSource({
  getDependencies,
  findAbyssalReturnProtectionTraceState,
  getAbyssalParticipantReturnObligation,
  cloneValue,
},
  pocketState,
  participant,
  deps = getDependencies(),
) {
  const traceState = findAbyssalReturnProtectionTraceState(pocketState, deps);
  const obligation = getAbyssalParticipantReturnObligation(
    traceState,
    toInt(participant && participant.characterID, 0),
  );
  return {
    ...cloneValue(pocketState),
    characterID: toInt(participant && participant.characterID, 0),
    shipID: toInt(participant && participant.shipID, 0),
    sourceSolarSystemID: toInt(
      participant && participant.sourceSolarSystemID,
      toInt(pocketState && pocketState.sourceSolarSystemID, 0),
    ),
    sourceLocationID: toInt(
      participant && participant.sourceLocationID,
      toInt(pocketState && pocketState.sourceLocationID, 0),
    ),
    suspectOnReturn: participant && participant.suspectOnReturn === true ||
      pocketState && pocketState.suspectOnReturn === true,
    securityPolicy: cloneValue(
      obligation && obligation.securityPolicy || pocketState && pocketState.securityPolicy,
    ),
    returnProtectionState: cloneValue(
      obligation && obligation.returnProtectionState,
    ),
    suspectReturnState: cloneValue(
      obligation && obligation.suspectReturnState,
    ),
  };
}

function stageAbyssalParticipantReturnObligations({
  getDependencies,
  buildAbyssalParticipantReturnObligationSource,
  stageAbyssalReturnProtectionObligation,
  cloneValue,
  normalizeLowerText,
  persistAbyssalSuspectReturnTraceState,
},
  pocketState,
  participant,
  deps = getDependencies(),
) {
  let source = buildAbyssalParticipantReturnObligationSource(
    pocketState,
    participant,
    deps,
  );
  const protectionResult = stageAbyssalReturnProtectionObligation(source, deps);
  if (!protectionResult || protectionResult.success !== true) {
    return {
      success: false,
      errorMsg: normalizeText(
        protectionResult && protectionResult.errorMsg,
        "ABYSSAL_PARTICIPANT_RETURN_PROTECTION_STAGE_FAILED",
      ),
      protectionResult,
    };
  }
  source = {
    ...source,
    returnProtectionState: cloneValue(protectionResult.state),
  };
  const nowMs = toInt(deps.now(), Date.now());
  const priorSuspectState = source.suspectReturnState &&
    typeof source.suspectReturnState === "object"
    ? cloneValue(source.suspectReturnState)
    : {};
  const suspectState = source.suspectOnReturn === true
    ? {
        ...priorSuspectState,
        state: normalizeLowerText(priorSuspectState.state, "") === "completed"
          ? "completed"
          : "pending",
        idempotencyKey: normalizeText(
          priorSuspectState.idempotencyKey,
          `abyssal-return-suspect:${toInt(source.sourceTraceItemID, source.traceItemID)}:${source.characterID}`,
        ),
        stagedAtMs: toInt(priorSuspectState.stagedAtMs, nowMs),
        attemptCount: Math.max(0, toInt(priorSuspectState.attemptCount, 0)),
      }
    : { state: "not_required", stagedAtMs: nowMs, attemptCount: 0 };
  const suspectPersistResult = persistAbyssalSuspectReturnTraceState(
    source,
    suspectState,
    deps,
  );
  if (!suspectPersistResult || suspectPersistResult.success !== true) {
    return {
      success: false,
      errorMsg: normalizeText(
        suspectPersistResult && suspectPersistResult.errorMsg,
        "ABYSSAL_PARTICIPANT_SUSPECT_RETURN_STAGE_FAILED",
      ),
      protectionResult,
      suspectPersistResult,
    };
  }
  return {
    success: true,
    source: { ...source, suspectReturnState: suspectState },
    protectionResult,
    suspectPersistResult,
  };
}

function prepareAbyssalParticipantReturn({
  resolveAbyssalRosterParticipantSession,
  getPocketScene,
  buildAbyssalClientEnvironmentSelection,
  buildAbyssalSceneDescriptor,
  buildAbyssalParticipantReturnSpaceState,
  stageAbyssalParticipantReturnObligations,
  upsertAbyssalParticipantRosterEntry,
  ABYSSAL_PARTICIPANT_STATUS,
  commitPocketStateDurably,
  cloneValue,
}, context) {
  const { participant, deps, runtime, results } = context;
  let { workingState } = context;
  const participantSession = resolveAbyssalRosterParticipantSession(
    workingState,
    participant,
    deps,
  );
  const currentScene = participantSession &&
    typeof runtime.getSceneForSession === "function"
    ? runtime.getSceneForSession(participantSession)
    : getPocketScene(workingState, deps);
  const currentShipEntity = currentScene && typeof currentScene.getEntityByID === "function"
    ? currentScene.getEntityByID(participant.shipID)
    : null;
  const exitingEnvironmentSelection = participantSession
    ? buildAbyssalClientEnvironmentSelection(
        workingState,
        participantSession,
        deps,
      )
    : null;
  const isolatedSceneDescriptor = currentScene && currentScene.sceneKind === "abyssal"
    ? currentScene.sceneDescriptor || buildAbyssalSceneDescriptor(workingState, deps)
    : null;
  const returnSpaceState = buildAbyssalParticipantReturnSpaceState(
    workingState,
    participant,
    currentShipEntity,
  );
  const returnObligationStage = stageAbyssalParticipantReturnObligations(
    workingState,
    participant,
    deps,
  );
  if (!returnObligationStage || returnObligationStage.success !== true) {
    return {
      success: false,
      committed: false,
      errorMsg: normalizeText(
        returnObligationStage && returnObligationStage.errorMsg,
        "ABYSSAL_PARTICIPANT_RETURN_OBLIGATION_STAGE_FAILED",
      ),
      characterID: participant.characterID,
      shipID: participant.shipID,
      results,
    };
  }
  const exitingAtMs = toInt(deps.now(), Date.now());
  const exitingRoster = upsertAbyssalParticipantRosterEntry(workingState, {
    ...participant,
    status: ABYSSAL_PARTICIPANT_STATUS.EXITING,
    lastSeenAtMs: exitingAtMs,
  });
  const exitingCommit = commitPocketStateDurably(
    workingState.instanceID,
    { participantRoster: exitingRoster },
    deps,
    { verifyReadBack: true, forceWrite: true },
  );
  if (!exitingCommit || exitingCommit.success !== true) {
    return {
      success: false,
      errorMsg: normalizeText(
        exitingCommit && exitingCommit.errorMsg,
        "ABYSSAL_PARTICIPANT_EXIT_INTENT_PERSIST_FAILED",
      ),
      results,
    };
  }
  workingState = cloneValue(exitingCommit.committedState || exitingCommit.state);
  Object.assign(context, {
    workingState, participantSession, exitingEnvironmentSelection, isolatedSceneDescriptor,
    returnSpaceState, returnObligationStage, exitingAtMs,
  });
  return { success: true };
}

function moveAbyssalReturningParticipant({
  ABYSSAL_PARTICIPANT_STATUS,
  cloneValue,
  updateCharacterLocationForAbyssalEvacuation,
}, context) {
  const { participant, participantSession, deps, runtime, results, workingState, returnSpaceState, options } = context;
  const shipItem = deps.findItemById(participant.shipID);
  const targetSystemID = toInt(returnSpaceState.systemID, 0);
  const persistedShipSystemID = toInt(
    shipItem && shipItem.spaceState && shipItem.spaceState.systemID,
    toInt(shipItem && shipItem.locationID, 0),
  );
  const moveAlreadyCommitted = Boolean(
    participant.status === ABYSSAL_PARTICIPANT_STATUS.EXITING &&
    targetSystemID > 0 &&
    persistedShipSystemID === targetSystemID
  );
  const moveResult = shipItem
    ? moveAlreadyCommitted
      ? {
          success: true,
          data: cloneValue(shipItem),
          previousData: cloneValue(shipItem),
          alreadyAtReturnTarget: true,
        }
      : deps.moveShipToSpace(
          participant.shipID,
          targetSystemID,
          returnSpaceState,
        )
    : null;
  if (!moveResult || moveResult.success !== true || !moveResult.data) {
    return {
      success: false,
      errorMsg: normalizeText(
        moveResult && moveResult.errorMsg,
        "ABYSSAL_PARTICIPANT_EXIT_MOVE_FAILED",
      ),
      characterID: participant.characterID,
      shipID: participant.shipID,
      results,
    };
  }
  const participantSessionAlreadyReturned = Boolean(
    moveAlreadyCommitted &&
    participantSession &&
    toInt(
      participantSession.solarsystemid2 || participantSession.solarsystemid,
      0,
    ) === targetSystemID &&
    toInt(participantSession._space && participantSession._space.systemID, 0) ===
      targetSystemID &&
    normalizeText(
      participantSession._space && participantSession._space.sceneKey,
      normalizeText(participantSession.spaceSceneKey, ""),
    ) !== `abyssal-run:${toInt(workingState.instanceID, 0)}`
  );
  if (
    !participantSessionAlreadyReturned &&
    participantSession &&
    participantSession._space &&
    typeof runtime.detachSession === "function"
  ) {
    runtime.detachSession(participantSession, {
      broadcast: false,
      lifecycleReason: normalizeText(options.reason, "abyssal-group-final-exit"),
    });
  }
  const staleScene = !participantSessionAlreadyReturned &&
    typeof runtime.findSceneContainingDynamicEntity === "function"
    ? runtime.findSceneContainingDynamicEntity(participant.shipID)
    : null;
  if (staleScene && typeof staleScene.removeDynamicEntity === "function") {
    staleScene.removeDynamicEntity(participant.shipID, {
      broadcast: false,
      lifecycleReason: normalizeText(options.reason, "abyssal-group-final-exit"),
    });
  }
  updateCharacterLocationForAbyssalEvacuation(
    participant.characterID,
    toInt(returnSpaceState.systemID, 0),
    deps,
  );
  Object.assign(context, { shipItem, targetSystemID, moveAlreadyCommitted, moveResult, participantSessionAlreadyReturned });
  return { success: true };
}

function attachAbyssalReturningParticipant({
  sendAbyssalDungeonExitNotification,
  sendAbyssalLocationExitNotification,
  syncInventoryChanges,
  clearAbyssalClientEnvironmentForSession,
  buildAbyssalExitSessionChanges,
  applyAbyssalEntrySessionFields,
  sendAbyssalEntrySessionChange,
  clearAbyssalSessionState,
  clearExactAbyssalParticipantRoomScopeMetadata,
}, context) {
  const {
    participant,
    participantSession,
    deps,
    runtime,
    results,
    workingState,
    returnSpaceState,
    exitingEnvironmentSelection,
    isolatedSceneDescriptor,
    shipItem,
    targetSystemID,
    moveResult,
    participantSessionAlreadyReturned,
  } = context;
  let attachedEntity = null;
  if (participantSession && !participantSessionAlreadyReturned) {
    if (exitingEnvironmentSelection) {
      sendAbyssalDungeonExitNotification(
        participantSession,
        exitingEnvironmentSelection.volumetricCloudDungeonID,
      );
      sendAbyssalLocationExitNotification(
        participantSession,
        exitingEnvironmentSelection.runID,
        exitingEnvironmentSelection.roomIndex,
        { phase: "group-final-exit", deps },
      );
    }
    syncInventoryChanges(participantSession, [{
      item: moveResult.data,
      previousData: moveResult.previousData || shipItem,
    }], deps);
    clearAbyssalClientEnvironmentForSession(
      workingState,
      participantSession,
      `solar-system:${targetSystemID}`,
      deps,
      "exit",
    );
    const exitSessionChangeState = isolatedSceneDescriptor
      ? buildAbyssalExitSessionChanges(
          participantSession,
          targetSystemID,
          moveResult.data,
          isolatedSceneDescriptor,
        )
      : null;
    if (exitSessionChangeState) {
      applyAbyssalEntrySessionFields(
        participantSession,
        exitSessionChangeState.target,
        moveResult.data,
      );
      sendAbyssalEntrySessionChange(participantSession, exitSessionChangeState, {
        mode: "isolated-group-exit",
        characterID: participant.characterID,
        instanceID: workingState.instanceID,
      });
    } else {
      participantSession.locationid = targetSystemID;
      participantSession.solarsystemid = targetSystemID;
      participantSession.solarsystemid2 = targetSystemID;
      participantSession.shipID = moveResult.data.itemID;
      participantSession.shipid = moveResult.data.itemID;
      participantSession.activeShipID = moveResult.data.itemID;
      participantSession.activeShipId = moveResult.data.itemID;
      participantSession.shipTypeID = moveResult.data.typeID;
    }
    clearAbyssalSessionState(participantSession);
    attachedEntity = runtime.attachSession(participantSession, moveResult.data, {
      systemID: toInt(returnSpaceState.systemID, 0),
      reconcileUniverseSites: true,
      spawnAsteroidBeltRats: true,
      pendingUndockMovement: false,
      broadcast: true,
      spawnStopped: true,
    });
    if (!attachedEntity || !participantSession._space) {
      return {
        success: false,
        committed: true,
        sourceCommitIrreversible: true,
        errorMsg: "ABYSSAL_PARTICIPANT_EXIT_ATTACH_FAILED",
        characterID: participant.characterID,
        shipID: participant.shipID,
        results,
      };
    }
    clearExactAbyssalParticipantRoomScopeMetadata(
      attachedEntity,
      workingState.instanceID,
    );
    if (typeof deps.queuePostSpaceAttachFittingHydration === "function") {
      deps.queuePostSpaceAttachFittingHydration(
        participantSession,
        moveResult.data.itemID,
        { hydrationProfile: "transition" },
      );
    }
  } else if (participantSessionAlreadyReturned) {
    const returnedScene = typeof runtime.getSceneForSession === "function"
      ? runtime.getSceneForSession(participantSession)
      : null;
    attachedEntity = returnedScene &&
      typeof returnedScene.getShipEntityForSession === "function"
      ? returnedScene.getShipEntityForSession(participantSession)
      : returnedScene && typeof returnedScene.getEntityByID === "function"
        ? returnedScene.getEntityByID(participant.shipID)
        : null;
    clearAbyssalSessionState(participantSession);
    clearExactAbyssalParticipantRoomScopeMetadata(
      attachedEntity,
      workingState.instanceID,
    );
  }
  context.attachedEntity = attachedEntity;
  return { success: true };
}

function commitAbyssalParticipantReturnReceipt({
  upsertAbyssalParticipantRosterEntry,
  ABYSSAL_PARTICIPANT_STATUS,
  commitPocketStateDurably,
  cloneValue,
  settleAbyssalReturnProtectionObligation,
  settleAbyssalSuspectOnReturn,
  refreshAbyssalPlayerShipWeather,
  sendAbyssalContentFinishedNotification,
  scheduleAbyssalKSpaceArrivalAfterExit,
}, context) {
  const {
    participant,
    participantSession,
    deps,
    results,
    exitingAtMs,
    returnObligationStage,
    attachedEntity,
    options,
    returnSpaceState,
    moveAlreadyCommitted,
  } = context;
  let { workingState } = context;
  const exitedRoster = upsertAbyssalParticipantRosterEntry(workingState, {
    ...participant,
    status: ABYSSAL_PARTICIPANT_STATUS.EXITED,
    exitedAtMs: toInt(deps.now(), exitingAtMs),
    lastSeenAtMs: toInt(deps.now(), exitingAtMs),
  });
  const exitedCommit = commitPocketStateDurably(
    workingState.instanceID,
    { participantRoster: exitedRoster },
    deps,
    { verifyReadBack: true, forceWrite: true },
  );
  if (!exitedCommit || exitedCommit.success !== true) {
    return {
      success: false,
      committed: true,
      sourceCommitIrreversible: true,
      errorMsg: normalizeText(
        exitedCommit && exitedCommit.errorMsg,
        "ABYSSAL_PARTICIPANT_EXIT_RECEIPT_PERSIST_FAILED",
      ),
      results,
    };
  }
  workingState = cloneValue(exitedCommit.committedState || exitedCommit.state);
  let returnProtectionResult = { success: true, skipped: true };
  let suspectReturnResult = { success: true, skipped: true };
  let arrivalPresentationResult = {
    success: true,
    scheduled: false,
    skipped: true,
    reason: participantSession ? "NOT_REQUESTED" : "NO_LIVE_SESSION",
  };
  if (participantSession) {
    returnProtectionResult = settleAbyssalReturnProtectionObligation(
      returnObligationStage.source,
      participantSession,
      attachedEntity,
      deps,
    );
    suspectReturnResult = settleAbyssalSuspectOnReturn(
      returnObligationStage.source,
      participantSession,
      deps,
    );
    refreshAbyssalPlayerShipWeather(participantSession, deps);
    sendAbyssalContentFinishedNotification(participantSession, workingState, deps);
    if (options.scheduleKSpaceArrivalPresentation === true) {
      arrivalPresentationResult = scheduleAbyssalKSpaceArrivalAfterExit(
        workingState,
        participantSession,
        deps,
        {
          finalizeRunOnCompletion: false,
          returnReceiptCommitted: true,
        },
      );
    }
  }
  results.push({
    characterID: participant.characterID,
    shipID: participant.shipID,
    returnSystemID: toInt(returnSpaceState.systemID, 0),
    moveAlreadyCommitted,
    returnProtectionResult,
    suspectReturnResult,
    arrivalPresentationResult,
  });
  context.workingState = workingState;
  return { success: true };
}

function logAbyssalGroupReturnPresentation({
  log,
}, context) {
  const { options, results, workingState } = context;
  if (options.scheduleKSpaceArrivalPresentation === true) {
    const eligibleResults = results.filter(
      (result) => result.arrivalPresentationResult &&
        result.arrivalPresentationResult.skipped !== true,
    );
    const scheduledResults = eligibleResults.filter(
      (result) => result.arrivalPresentationResult.scheduled === true,
    );
    const failedResults = eligibleResults.filter(
      (result) => result.arrivalPresentationResult.success !== true,
    );
    log.info(
      `[AbyssalGroupKSpaceArrival] run=${toInt(workingState.instanceID, 0)} ` +
        `returnedParticipantCount=${results.length} ` +
        `eligibleSessionCount=${eligibleResults.length} ` +
        `scheduledCount=${scheduledResults.length} failedCount=${failedResults.length} ` +
        `participants=${results.map((result) =>
          `${result.characterID}:${result.shipID}:` +
          `${result.arrivalPresentationResult.scheduled === true
            ? "SCHEDULED"
            : normalizeText(
                result.arrivalPresentationResult.errorMsg ||
                  result.arrivalPresentationResult.reason,
                "SKIPPED",
              )}`
        ).join(",") || "none"}`,
    );
  }
}

function moveOtherAbyssalParticipantsOutOfRun({
  getDependencies,
  getCharacterID,
  getActivePocketStateByInstanceID,
  normalizeAbyssalParticipantRoster,
  ABYSSAL_PARTICIPANT_STATUS,
  prepareAbyssalParticipantReturn,
  moveAbyssalReturningParticipant,
  attachAbyssalReturningParticipant,
  commitAbyssalParticipantReturnReceipt,
  logAbyssalGroupReturnPresentation,
},
  pocketState,
  activatingSession,
  deps = getDependencies(),
  options = {},
) {
  const activatingCharacterID = getCharacterID(activatingSession);
  const onlyCharacterID = toInt(options.characterID, 0);
  const runtime = deps;
  let workingState = getActivePocketStateByInstanceID(pocketState.instanceID) || pocketState;
  const results = [];
  for (const participant of normalizeAbyssalParticipantRoster(workingState)) {
    if (
      (onlyCharacterID > 0 && participant.characterID !== onlyCharacterID) ||
      participant.characterID === activatingCharacterID ||
      ![
        ABYSSAL_PARTICIPANT_STATUS.ACTIVE,
        ABYSSAL_PARTICIPANT_STATUS.DISCONNECTED,
        ABYSSAL_PARTICIPANT_STATUS.ADMITTING,
        ABYSSAL_PARTICIPANT_STATUS.EXITING,
      ].includes(participant.status)
    ) {
      continue;
    }
    const context = { workingState, participant, deps, runtime, results, options };
    const preparationResult = prepareAbyssalParticipantReturn(context);
    if (!preparationResult.success) return preparationResult;
    const movementResult = moveAbyssalReturningParticipant(context);
    if (!movementResult.success) return movementResult;
    const attachmentResult = attachAbyssalReturningParticipant(context);
    if (!attachmentResult.success) return attachmentResult;
    const receiptResult = commitAbyssalParticipantReturnReceipt(context);
    if (!receiptResult.success) return receiptResult;
    workingState = context.workingState;
  }
  logAbyssalGroupReturnPresentation({ options, results, workingState });
  return { success: true, pocketState: workingState, results };
}

// Capture supplied capabilities once, as the original closure did. Internal
// callbacks are bound once per instance; no runtime state lives in this wiring.
function createAbyssalParticipantReturn({
  buildPlaceholderReturnSpaceState,
  cloneValue,
  toReal,
  getDependencies,
  findAbyssalReturnProtectionTraceState,
  getAbyssalParticipantReturnObligation,
  stageAbyssalReturnProtectionObligation,
  normalizeLowerText,
  persistAbyssalSuspectReturnTraceState,
  getCharacterID,
  getActivePocketStateByInstanceID,
  normalizeAbyssalParticipantRoster,
  ABYSSAL_PARTICIPANT_STATUS,
  resolveAbyssalRosterParticipantSession,
  getPocketScene,
  buildAbyssalClientEnvironmentSelection,
  buildAbyssalSceneDescriptor,
  upsertAbyssalParticipantRosterEntry,
  commitPocketStateDurably,
  updateCharacterLocationForAbyssalEvacuation,
  sendAbyssalDungeonExitNotification,
  sendAbyssalLocationExitNotification,
  syncInventoryChanges,
  clearAbyssalClientEnvironmentForSession,
  buildAbyssalExitSessionChanges,
  applyAbyssalEntrySessionFields,
  sendAbyssalEntrySessionChange,
  clearAbyssalSessionState,
  clearExactAbyssalParticipantRoomScopeMetadata,
  settleAbyssalReturnProtectionObligation,
  settleAbyssalSuspectOnReturn,
  refreshAbyssalPlayerShipWeather,
  sendAbyssalContentFinishedNotification,
  scheduleAbyssalKSpaceArrivalAfterExit,
  log,
}) {

  const ports = {
    buildPlaceholderReturnSpaceState,
    cloneValue,
    toReal,
    getDependencies,
    findAbyssalReturnProtectionTraceState,
    getAbyssalParticipantReturnObligation,
    stageAbyssalReturnProtectionObligation,
    normalizeLowerText,
    persistAbyssalSuspectReturnTraceState,
    getCharacterID,
    getActivePocketStateByInstanceID,
    normalizeAbyssalParticipantRoster,
    ABYSSAL_PARTICIPANT_STATUS,
    resolveAbyssalRosterParticipantSession,
    getPocketScene,
    buildAbyssalClientEnvironmentSelection,
    buildAbyssalSceneDescriptor,
    upsertAbyssalParticipantRosterEntry,
    commitPocketStateDurably,
    updateCharacterLocationForAbyssalEvacuation,
    sendAbyssalDungeonExitNotification,
    sendAbyssalLocationExitNotification,
    syncInventoryChanges,
    clearAbyssalClientEnvironmentForSession,
    buildAbyssalExitSessionChanges,
    applyAbyssalEntrySessionFields,
    sendAbyssalEntrySessionChange,
    clearAbyssalSessionState,
    clearExactAbyssalParticipantRoomScopeMetadata,
    settleAbyssalReturnProtectionObligation,
    settleAbyssalSuspectOnReturn,
    refreshAbyssalPlayerShipWeather,
    sendAbyssalContentFinishedNotification,
    scheduleAbyssalKSpaceArrivalAfterExit,
    log,
  };
  ports.buildAbyssalParticipantReturnSpaceState = buildAbyssalParticipantReturnSpaceState.bind(null, ports);
  ports.buildAbyssalParticipantReturnObligationSource = buildAbyssalParticipantReturnObligationSource.bind(null, ports);
  ports.stageAbyssalParticipantReturnObligations = stageAbyssalParticipantReturnObligations.bind(null, ports);
  ports.prepareAbyssalParticipantReturn = prepareAbyssalParticipantReturn.bind(null, ports);
  ports.moveAbyssalReturningParticipant = moveAbyssalReturningParticipant.bind(null, ports);
  ports.attachAbyssalReturningParticipant = attachAbyssalReturningParticipant.bind(null, ports);
  ports.commitAbyssalParticipantReturnReceipt = commitAbyssalParticipantReturnReceipt.bind(null, ports);
  ports.logAbyssalGroupReturnPresentation = logAbyssalGroupReturnPresentation.bind(null, ports);
  ports.moveOtherAbyssalParticipantsOutOfRun = moveOtherAbyssalParticipantsOutOfRun.bind(null, ports);
  Object.freeze(ports);
  return {
    buildAbyssalParticipantReturnSpaceState: ports.buildAbyssalParticipantReturnSpaceState,
    buildAbyssalParticipantReturnObligationSource: ports.buildAbyssalParticipantReturnObligationSource,
    stageAbyssalParticipantReturnObligations: ports.stageAbyssalParticipantReturnObligations,
    moveOtherAbyssalParticipantsOutOfRun: ports.moveOtherAbyssalParticipantsOutOfRun,
  };
}

module.exports = { createAbyssalParticipantReturn };
