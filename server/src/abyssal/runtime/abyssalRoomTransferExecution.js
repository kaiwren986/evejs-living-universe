"use strict";

const { normalizeText } = require("../domain/abyssalValueUtils");
const { createAbyssalRoomTransitionCoordinator } = require("./abyssalRoomTransitionCoordinator");

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

// Per-call stage context only: durable run state and mutation batches retain their
// existing owners. Every handoff executes one coordinator and closes any open batch.
function buildAbyssalTransferExecutionContext({
  getPlaceholderRoomEntry,
  buildAbyssalClientEnvironmentSelection,
  hasPrewarmedPlaceholderRoomContent,
  buildEncounterStateFromRoomEntry,
  setPlaceholderRoomEntry,
  buildAbyssalTransferDestinationRoomEntry,
  buildPocketStateForCurrentRoom,
  buildAbyssalParticipantRoomScopeMetadata,
  usesIsolatedAbyssalScene,
  buildAbyssalSceneDescriptor,
}, input) {
  const { pocketState, currentRoomIndex, nextRoomIndex, session, deps, validation } = input;
  const currentRoomEntry = getPlaceholderRoomEntry(pocketState, currentRoomIndex);
  const previousEnvironmentSelection = buildAbyssalClientEnvironmentSelection(
    pocketState,
    session,
    deps,
  );
  const previousDungeonID = toInt(
    previousEnvironmentSelection && previousEnvironmentSelection.volumetricCloudDungeonID,
    toInt(
      session && session.abyssalClientEnvironment &&
        session.abyssalClientEnvironment.volumetricCloudDungeonID,
      0,
    ),
  );
  const nextRoomEntry = getPlaceholderRoomEntry(pocketState, nextRoomIndex);
  const nextRoomPrewarmed = hasPrewarmedPlaceholderRoomContent(nextRoomEntry);
  const nextRoomEncounterState = nextRoomPrewarmed
    ? buildEncounterStateFromRoomEntry(nextRoomEntry)
    : null;
  const plannedNextRoomState = setPlaceholderRoomEntry(
    pocketState,
    nextRoomIndex,
    buildAbyssalTransferDestinationRoomEntry(
      pocketState, nextRoomIndex, nextRoomEntry, nextRoomPrewarmed, deps,
    ),
    {
      currentRoomIndex: nextRoomIndex,
      finalExitAvailable: false,
    },
  );
  const plannedNextPocketState = buildPocketStateForCurrentRoom(pocketState, plannedNextRoomState);
  const nextRoomScopeMetadata = buildAbyssalParticipantRoomScopeMetadata(
    plannedNextPocketState,
    nextRoomIndex,
  );
  const runtime = deps;
  const currentScene =
    runtime && typeof runtime.getSceneForSession === "function"
      ? runtime.getSceneForSession(session)
      : null;
  const currentShipEntity =
    currentScene && typeof currentScene.getShipEntityForSession === "function"
      ? currentScene.getShipEntityForSession(session)
      : validation.data.shipEntity || null;
  const isolatedSceneDescriptor =
    usesIsolatedAbyssalScene(pocketState, deps)
      ? buildAbyssalSceneDescriptor(pocketState, deps)
      : null;
  const transferTargetPosition =
    plannedNextPocketState.shipSpawnState && plannedNextPocketState.shipSpawnState.position;
  const transferTargetDirection =
    plannedNextPocketState.shipSpawnState && plannedNextPocketState.shipSpawnState.direction;
  const expectedSceneKey = normalizeText(
    isolatedSceneDescriptor && isolatedSceneDescriptor.sceneKey,
    normalizeText(
      session && (session.spaceSceneKey || (session._space && session._space.sceneKey)),
      "",
    ),
  );
  const persistedShip = deps.findItemById(validation.data.context.shipID);
  return {
    ...input, currentRoomEntry, previousDungeonID, nextRoomEntry, nextRoomPrewarmed,
    nextRoomEncounterState, plannedNextPocketState, nextRoomScopeMetadata, runtime,
    currentScene, currentShipEntity, isolatedSceneDescriptor, transferTargetPosition,
    transferTargetDirection, expectedSceneKey, persistedShip,
    attachedEntity: null, transitionMode: "attach-session", movedShip: null,
    authoredEnvironmentNotification: false, transferEnvironmentDeliveryState: null,
    oldRoomEntityIDs: [], transferDestinyStamp: 0, sourceCommitIrreversible: false,
    effectivePocketState: null, completedPocketState: null,
    roomStateAfterCurrentCleanup: null, deliveryScene: null,
  };
}

function createAbyssalTransferPhaseRecorder({
  log,
}, deps, transitionMutationBatch, currentRoomIndex, nextRoomIndex) {
  const transferPerfEnabled = deps && deps.abyssalTransitionPerfDiagnosticsEnabled === true;
  const transferStartedAtNs = process.hrtime.bigint();
  let transferLastPhaseAtNs = transferStartedAtNs;
  return (phase, details = {}) => {
    if (!transferPerfEnabled) return;
    const nowNs = process.hrtime.bigint();
    const detailText = Object.entries(details)
      .map(([key, value]) => `${key}=${String(value)}`)
      .join(" ");
    log.info(
      `[AbyssalTransitionPerf] run=${transitionMutationBatch.instanceID} ` +
        `flow=handoff fromRoom=${currentRoomIndex} toRoom=${nextRoomIndex} phase=${phase} ` +
        `phaseMs=${(Number(nowNs - transferLastPhaseAtNs) / 1_000_000).toFixed(3)} ` +
        `totalMs=${(Number(nowNs - transferStartedAtNs) / 1_000_000).toFixed(3)} ` +
        detailText,
    );
    transferLastPhaseAtNs = nowNs;
  };
}

function settleAbyssalTransferExecutionFailure({
  abortAbyssalPocketMutationBatch,
  settleFailedAbyssalDestinationActivation,
  getActivePocketStateByInstanceID,
  cloneValue,
}, context, failureReason, details = {}) {
  const { transitionMutationBatch, pocketState, plannedNextPocketState, session, deps, currentRoomIndex, nextRoomIndex } = context;
  if (transitionMutationBatch.active) {
    abortAbyssalPocketMutationBatch(transitionMutationBatch.instanceID);
    transitionMutationBatch.active = false;
  }
  if (!context.sourceCommitIrreversible) {
    context.restoreSourceRoomAfterPreDeliveryFailure(failureReason);
    return {
      success: false,
      errorMsg: normalizeText(failureReason, "ABYSSAL_TRANSFER_PRE_DELIVERY_FAILED"),
    };
  }
  return settleFailedAbyssalDestinationActivation(
    getActivePocketStateByInstanceID(toInt(pocketState.instanceID, 0)) ||
      plannedNextPocketState,
    session,
    deps,
    failureReason,
    {
      sourceRoomIndex: currentRoomIndex,
      destinationRoomIndex: nextRoomIndex,
      ...cloneValue(details),
    },
  );
}

function configureAbyssalTransferExecutionCallbacks({
  restoreAbyssalTransferSourceRoom,
  settleAbyssalTransferExecutionFailure,
  isSessionReadyForIncrementalSpaceDelivery,
}, context) {
  const { session, currentScene } = context;
  context.restoreSourceRoomAfterPreDeliveryFailure = (reason) =>
    restoreAbyssalTransferSourceRoom(context, reason);
  context.settleCommittedDestinationFailure = (reason, details) =>
    settleAbyssalTransferExecutionFailure(context, reason, details);
  context.markSourceCommitIrreversible = () => { context.sourceCommitIrreversible = true; };
  context.canCommitOrderedDestinationDelivery = () => Boolean(
    isSessionReadyForIncrementalSpaceDelivery(session) &&
      currentScene &&
      typeof currentScene.sendAbyssalRoomTransferDeliveryToSession === "function" &&
      (typeof currentScene.canSessionReceiveDestiny !== "function" ||
        currentScene.canSessionReceiveDestiny(session) === true),
  );
}

function revalidateAbyssalTransferExecution({
  getActivePocketStateByInstanceID,
  buildPlaceholderRoomState,
  getPendingAbyssalTransitionState,
  getAbyssalParticipantRecord,
}, { pocketState, validation, currentRoomIndex, nextRoomIndex, expectedSceneKey }) {
  const currentPocketState =
    getActivePocketStateByInstanceID(toInt(pocketState.instanceID, 0)) ||
    pocketState;
  const currentRoomState = buildPlaceholderRoomState(currentPocketState);
  const currentPendingState = getPendingAbyssalTransitionState(currentPocketState);
  const currentParticipant = getAbyssalParticipantRecord(
    currentPocketState,
    validation.data.context.characterID,
  );
  return {
    success: Boolean(
      toInt(currentPocketState && currentPocketState.instanceID, 0) ===
        toInt(pocketState.instanceID, 0) &&
      currentRoomState.currentRoomIndex === currentRoomIndex &&
      currentPendingState &&
      currentPendingState.status === "pending" &&
      currentPendingState.phase === "transfer" &&
      currentPendingState.sourceRoomIndex === currentRoomIndex &&
      currentPendingState.targetRoomIndex === nextRoomIndex &&
      currentPendingState.token === toInt(
        pocketState && pocketState.pendingTransitionState &&
          pocketState.pendingTransitionState.token,
        0,
      ) &&
      toInt(currentParticipant && currentParticipant.shipID, 0) ===
        toInt(validation.data.context.shipID, 0)
    ),
    errorMsg: "ABYSSAL_ROOM_TRANSITION_REVALIDATION_IDENTITY_MISMATCH",
    identity: {
      instanceID: toInt(currentPocketState && currentPocketState.instanceID, 0),
      participantCharacterID: toInt(validation.data.context.characterID, 0),
      shipID: toInt(currentParticipant && currentParticipant.shipID, 0),
      fromRoomIndex: currentRoomState.currentRoomIndex,
      toRoomIndex: toInt(currentPendingState && currentPendingState.targetRoomIndex, 0),
      sourceSceneKey: normalizeText(
        currentPendingState && currentPendingState.sourceSceneID,
        expectedSceneKey,
      ),
      destinationSceneKey: normalizeText(
        currentPendingState && currentPendingState.destinationSceneKey,
        expectedSceneKey,
      ),
      transitionToken: toInt(currentPendingState && currentPendingState.token, 0),
    },
  };
}

function acknowledgeAbyssalTransferRollback({}, rollbackRequest) {
  if (
    rollbackRequest &&
    rollbackRequest.failureResult &&
    (
      rollbackRequest.failureResult.terminallySettled === true ||
      rollbackRequest.failureResult.sourceCommitIrreversible === true
    )
  ) {
    return {
      success: rollbackRequest.failureResult.terminallySettled === true,
      terminallySettled:
        rollbackRequest.failureResult.terminallySettled === true,
      alreadySettled: true,
    };
  }
  // The shared pending-transition scheduler remains the existing owner of
  // pre-commit source restoration. A coordinator failure is returned to
  // that boundary immediately after this callback, so performing the same
  // restoration here would duplicate the established rollback effects.
  return {
    success: true,
    delegatedToPendingTransitionScheduler: true,
  };
}

function buildAbyssalTransferExecutionRequest({}, { pocketState, validation, expectedSceneKey, currentRoomIndex, nextRoomIndex }) {
  return {
    instanceID: toInt(pocketState.instanceID, 0),
    participantCharacterID: toInt(validation.data.context.characterID, 0),
    shipID: toInt(validation.data.context.shipID, 0),
    sourceSceneKey: normalizeText(
      pocketState && pocketState.pendingTransitionState &&
        pocketState.pendingTransitionState.sourceSceneID,
      expectedSceneKey,
    ),
    destinationSceneKey: normalizeText(
      pocketState && pocketState.pendingTransitionState &&
        pocketState.pendingTransitionState.destinationSceneKey,
      expectedSceneKey,
    ),
    transitionToken: toInt(
      pocketState && pocketState.pendingTransitionState &&
        pocketState.pendingTransitionState.token,
      0,
    ),
    transitionStatus: normalizeText(
      pocketState && pocketState.pendingTransitionState &&
        pocketState.pendingTransitionState.status,
      "pending",
    ),
    committedRoomIndex: toInt(
      pocketState && pocketState.pendingTransitionState &&
        pocketState.pendingTransitionState.committedRoomIndex,
      currentRoomIndex,
    ),
    progression: {
      kind: "nextRoom",
      fromRoomIndex: currentRoomIndex,
      toRoomIndex: nextRoomIndex,
    },
  };
}

function commitAbyssalTransferExecution({
  commitAbyssalPocketMutationBatch,
  cloneValue,
}, context) {
  const { transitionMutationBatch, deps, recordTransferPhase, settleCommittedDestinationFailure } = context;
  if (transitionMutationBatch.active) {
    const batchCommitResult = commitAbyssalPocketMutationBatch(
      transitionMutationBatch.instanceID,
      deps,
    );
    transitionMutationBatch.active = false;
    recordTransferPhase("durable-final-commit");
    if (!batchCommitResult || batchCommitResult.success !== true) {
      return settleCommittedDestinationFailure(
        normalizeText(
          batchCommitResult && batchCommitResult.errorMsg,
          "ABYSSAL_TRANSFER_FINAL_PERSIST_FAILED",
        ),
        { persistenceBatch: cloneValue(batchCommitResult && batchCommitResult.batch) },
      );
    }
    context.completedPocketState = cloneValue(
      batchCommitResult.committedState || batchCommitResult.state,
    ) || context.completedPocketState;
  }
  recordTransferPhase("complete");
  return { success: true };
}

function buildAbyssalTransferExecutionStages({
  revalidateAbyssalTransferExecution,
  commitAbyssalTransferSourceRoom,
  deliverAbyssalTransferParticipants,
  cleanAbyssalTransferSourceRoom,
  prepareAbyssalTransferDestinationContent,
  publishAbyssalTransferDestination,
  activateAbyssalTransferDestination,
  commitAbyssalTransferExecution,
  acknowledgeAbyssalTransferRollback,
}, context) {
  return {
    revalidateTransition: () => revalidateAbyssalTransferExecution(context),
    commitSourceRoom() {
      const result = commitAbyssalTransferSourceRoom(context);
      if (!result.success) return result;
      context.authoredEnvironmentNotification = result.authoredEnvironmentNotification;
      context.oldRoomEntityIDs = result.oldRoomEntityIDs;
      return { success: true, sourceCommitIrreversible: context.sourceCommitIrreversible };
    },
    deliverParticipants() {
      const result = deliverAbyssalTransferParticipants(context);
      if (!result.success) return result;
      context.movedShip = result.movedShip;
      context.attachedEntity = result.attachedEntity;
      context.transferDestinyStamp = result.transferDestinyStamp;
      context.transitionMode = result.transitionMode;
      return { success: true };
    },
    cleanupSourceRoom() {
      const result = cleanAbyssalTransferSourceRoom(context);
      context.roomStateAfterCurrentCleanup = result.roomStateAfterCurrentCleanup;
      return { success: result.success, residualCleanupResult: result.residualCleanupResult };
    },
    prepareDestinationState() {
      const result = prepareAbyssalTransferDestinationContent(context);
      if (!result.success) return result;
      context.effectivePocketState = result.effectivePocketState;
      return { success: true };
    },
    publishDestination() {
      const result = publishAbyssalTransferDestination(context);
      if (!result.success) return result;
      context.effectivePocketState = result.effectivePocketState;
      context.deliveryScene = result.deliveryScene;
      context.transferEnvironmentDeliveryState = result.transferEnvironmentDeliveryState;
      return { success: true };
    },
    activateDestination() {
      const result = activateAbyssalTransferDestination(context);
      if (!result.success) return result;
      context.effectivePocketState = result.effectivePocketState;
      context.transferEnvironmentDeliveryState = result.transferEnvironmentDeliveryState;
      context.completedPocketState = result.completedPocketState;
      return { success: true };
    },
    commitTransition: () => commitAbyssalTransferExecution(context),
    rollbackTransition: acknowledgeAbyssalTransferRollback,
  };
}

function buildAbyssalTransferExecutionResult({}, context, coordinatorResult) {
  const { movedShip, attachedEntity, transitionMode, nextRoomIndex, currentRoomIndex, completedPocketState } = context;
  if (!coordinatorResult.success) {
    const failedStageResult =
      coordinatorResult.stageResults &&
      coordinatorResult.stageResults[coordinatorResult.stage];
    return failedStageResult && failedStageResult.success === false
      ? failedStageResult
      : {
          success: false,
          errorMsg: normalizeText(
            coordinatorResult.errorMsg,
            "ABYSSAL_ROOM_TRANSITION_FAILED",
          ),
          coordinatorResult,
        };
  }
  return {
    success: true,
    data: {
      movedShip,
      attachedEntity,
      transitionMode,
      nextRoomIndex,
      previousRoomIndex: currentRoomIndex,
      pocketState: completedPocketState,
      coordinatorResult,
    },
  };
}

function transferShipToNextPlaceholderRoom({
  getDependencies,
  buildPlaceholderRoomState,
  createAbyssalTransferPhaseRecorder,
  buildAbyssalTransferExecutionContext,
  configureAbyssalTransferExecutionCallbacks,
  buildAbyssalTransferExecutionStages,
  buildAbyssalTransferExecutionRequest,
  buildAbyssalTransferExecutionResult,
  abortAbyssalPocketMutationBatch,
}, validation, session, deps = getDependencies()) {
  const pocketState = validation.data.pocketState;
  const roomState = buildPlaceholderRoomState(pocketState);
  const currentRoomIndex = roomState.currentRoomIndex;
  const nextRoomIndex = currentRoomIndex + 1;
  if (nextRoomIndex > roomState.implementedRooms) {
    return {
      success: false,
      errorMsg: "NO_NEXT_ABYSSAL_ROOM",
    };
  }
  const transitionMutationBatch = {
    active: false,
    instanceID: toInt(pocketState && pocketState.instanceID, 0),
    enabled: deps && deps.abyssalTransitionMutationBatchingEnabled !== false,
  };
  const recordTransferPhase = createAbyssalTransferPhaseRecorder(
    deps, transitionMutationBatch, currentRoomIndex, nextRoomIndex,
  );
  try {
    const context = buildAbyssalTransferExecutionContext({
      validation, session, deps, pocketState, currentRoomIndex, nextRoomIndex,
      transitionMutationBatch, recordTransferPhase,
    });
    configureAbyssalTransferExecutionCallbacks(context);
    const coordinator = createAbyssalRoomTransitionCoordinator(
      buildAbyssalTransferExecutionStages(context),
    );
    const coordinatorResult = coordinator.executeRoomTransition(
      buildAbyssalTransferExecutionRequest(context),
    );
    return buildAbyssalTransferExecutionResult(context, coordinatorResult);
  } finally {
    if (transitionMutationBatch.active) {
      abortAbyssalPocketMutationBatch(transitionMutationBatch.instanceID);
      transitionMutationBatch.active = false;
    }
  }
}

// Capture supplied capabilities once, as the original closure did. Internal
// callbacks are bound once per instance; no runtime state lives in this wiring.
function createAbyssalRoomTransferExecution({
  getPlaceholderRoomEntry,
  buildAbyssalClientEnvironmentSelection,
  hasPrewarmedPlaceholderRoomContent,
  buildEncounterStateFromRoomEntry,
  setPlaceholderRoomEntry,
  buildAbyssalTransferDestinationRoomEntry,
  buildPocketStateForCurrentRoom,
  buildAbyssalParticipantRoomScopeMetadata,
  usesIsolatedAbyssalScene,
  buildAbyssalSceneDescriptor,
  log,
  abortAbyssalPocketMutationBatch,
  settleFailedAbyssalDestinationActivation,
  getActivePocketStateByInstanceID,
  cloneValue,
  restoreAbyssalTransferSourceRoom,
  isSessionReadyForIncrementalSpaceDelivery,
  buildPlaceholderRoomState,
  getPendingAbyssalTransitionState,
  getAbyssalParticipantRecord,
  commitAbyssalPocketMutationBatch,
  commitAbyssalTransferSourceRoom,
  deliverAbyssalTransferParticipants,
  cleanAbyssalTransferSourceRoom,
  prepareAbyssalTransferDestinationContent,
  publishAbyssalTransferDestination,
  activateAbyssalTransferDestination,
  getDependencies,
}) {

  const ports = {
    getPlaceholderRoomEntry,
    buildAbyssalClientEnvironmentSelection,
    hasPrewarmedPlaceholderRoomContent,
    buildEncounterStateFromRoomEntry,
    setPlaceholderRoomEntry,
    buildAbyssalTransferDestinationRoomEntry,
    buildPocketStateForCurrentRoom,
    buildAbyssalParticipantRoomScopeMetadata,
    usesIsolatedAbyssalScene,
    buildAbyssalSceneDescriptor,
    log,
    abortAbyssalPocketMutationBatch,
    settleFailedAbyssalDestinationActivation,
    getActivePocketStateByInstanceID,
    cloneValue,
    restoreAbyssalTransferSourceRoom,
    isSessionReadyForIncrementalSpaceDelivery,
    buildPlaceholderRoomState,
    getPendingAbyssalTransitionState,
    getAbyssalParticipantRecord,
    commitAbyssalPocketMutationBatch,
    commitAbyssalTransferSourceRoom,
    deliverAbyssalTransferParticipants,
    cleanAbyssalTransferSourceRoom,
    prepareAbyssalTransferDestinationContent,
    publishAbyssalTransferDestination,
    activateAbyssalTransferDestination,
    getDependencies,
  };
  ports.buildAbyssalTransferExecutionContext = buildAbyssalTransferExecutionContext.bind(null, ports);
  ports.createAbyssalTransferPhaseRecorder = createAbyssalTransferPhaseRecorder.bind(null, ports);
  ports.settleAbyssalTransferExecutionFailure = settleAbyssalTransferExecutionFailure.bind(null, ports);
  ports.configureAbyssalTransferExecutionCallbacks = configureAbyssalTransferExecutionCallbacks.bind(null, ports);
  ports.revalidateAbyssalTransferExecution = revalidateAbyssalTransferExecution.bind(null, ports);
  ports.acknowledgeAbyssalTransferRollback = acknowledgeAbyssalTransferRollback.bind(null, ports);
  ports.buildAbyssalTransferExecutionRequest = buildAbyssalTransferExecutionRequest.bind(null, ports);
  ports.commitAbyssalTransferExecution = commitAbyssalTransferExecution.bind(null, ports);
  ports.buildAbyssalTransferExecutionStages = buildAbyssalTransferExecutionStages.bind(null, ports);
  ports.buildAbyssalTransferExecutionResult = buildAbyssalTransferExecutionResult.bind(null, ports);
  ports.transferShipToNextPlaceholderRoom = transferShipToNextPlaceholderRoom.bind(null, ports);
  Object.freeze(ports);
  return { transferShipToNextPlaceholderRoom: ports.transferShipToNextPlaceholderRoom };
}

module.exports = { createAbyssalRoomTransferExecution };
