"use strict";

const { normalizeText } = require("../domain/abyssalValueUtils");

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

// The existing final-exit coordinator owns stage order. This adapter holds only
// per-call execution values; durable run, receipt and cleanup authority is injected.
function buildAbyssalFinalExitExecutionContext({
  getCharacterID,
}, validation, session, deps) {
  return {
    validation, session, deps,
    pocketState: validation && validation.data && validation.data.pocketState,
    exitingCharacterID: getCharacterID(session),
    exitingParticipant: null,
    groupExitResult: null,
    runtime: deps,
    currentScene: null,
    currentShipEntity: null,
    returnSpaceState: null,
    targetSystemID: 0,
    participantReturnObligationStage: null,
    returnProtectionStageResult: null,
    participantReturnEffectSource: null,
    exitingEnvironmentSelection: null,
    isolatedSceneDescriptor: null,
    exitCommitAtMs: 0,
    moveResult: null,
    movedShip: null,
    committedPocketState: null,
    attachedEntity: null,
    transitionMode: "attach-session",
    returnProtectionResult: { success: true, skipped: true },
    suspectReturnResult: { success: true, skipped: true },
    finalExitCoordinator: null,
  };
}

function commitAbyssalFinalExitOutcome({
  getActivePocketStateByInstanceID,
  hasTerminalFailureOutcome,
  recordAbyssalRunOutcome,
  normalizeAbyssalRunOutcome,
  ABYSSAL_RUN_OUTCOME,
}, context) {
  const { deps } = context;
  const activePocketState =
    getActivePocketStateByInstanceID(toInt(context.pocketState.instanceID, 0)) || context.pocketState;
  if (hasTerminalFailureOutcome(activePocketState)) {
    return { success: true, skipped: true, pocketState: activePocketState };
  }
  try {
    const outcomeState = recordAbyssalRunOutcome(
      activePocketState,
      "exited",
      deps,
      { reason: "normal_exit" },
    ) || activePocketState;
    return {
      success:
        normalizeAbyssalRunOutcome(outcomeState && outcomeState.runOutcome) ===
          ABYSSAL_RUN_OUTCOME.EXITED,
      pocketState: outcomeState,
      errorMsg: "ABYSSAL_EXIT_OUTCOME_PERSIST_FAILED",
    };
  } catch (error) {
    return {
      success: false,
      errorMsg: normalizeText(
        error && error.message,
        "ABYSSAL_EXIT_OUTCOME_PERSIST_FAILED",
      ),
    };
  }
}

function cleanupAbyssalFinalExit({
  cleanupAbyssalRun,
  getActivePocketStateByInstanceID,
}, context) {
  const { session, deps } = context;
  return cleanupAbyssalRun(
    getActivePocketStateByInstanceID(toInt(context.pocketState.instanceID, 0)) || context.pocketState,
    deps,
    { reason: "final-exit", session },
  );
}

function revalidateAbyssalFinalExit({
  ensureAbyssalPocketDurablyAdopted,
  cloneValue,
  getAbyssalParticipantRecord,
  getPendingAbyssalTransitionState,
  buildPlaceholderRoomState,
}, context, stageRequest) {
  const { deps, exitingCharacterID } = context;
  const adoptionResult = ensureAbyssalPocketDurablyAdopted(
    context.pocketState,
    deps,
    { verifyReadBack: true },
  );
  if (!adoptionResult || adoptionResult.success !== true) {
    return {
      success: false,
      committed: false,
      errorMsg: normalizeText(
        adoptionResult && adoptionResult.errorMsg,
        "ABYSSAL_POCKET_DURABLE_ADOPTION_FAILED",
      ),
    };
  }
  context.pocketState = cloneValue(adoptionResult.committedState || adoptionResult.state);
  context.exitingParticipant = getAbyssalParticipantRecord(context.pocketState, exitingCharacterID);
  if (!context.exitingParticipant) {
    return {
      success: false,
      committed: false,
      errorMsg: "ABYSSAL_EXIT_PARTICIPANT_MISSING",
    };
  }
  const pendingTransitionState = getPendingAbyssalTransitionState(context.pocketState) || {};
  const roomState = buildPlaceholderRoomState(context.pocketState);
  const identity = {
    instanceID: toInt(context.pocketState.instanceID, 0),
    ownerCharacterID: toInt(context.pocketState.characterID, 0),
    participantCharacterID: exitingCharacterID,
    shipID: toInt(context.exitingParticipant.shipID, 0),
    sourceRoomIndex: roomState.currentRoomIndex,
    sourceSceneKey: normalizeText(
      pendingTransitionState.sourceSceneID,
      stageRequest.sourceSceneKey,
    ),
    transitionToken: toInt(
      pendingTransitionState.token,
      stageRequest.trustedDirectManagerExecution === true
        ? toInt(stageRequest.transitionToken, 0)
        : 0,
    ),
    progressionKind: "finalExit",
  };
  return {
    success: Boolean(
      identity.instanceID === toInt(stageRequest.instanceID, 0) &&
      identity.participantCharacterID ===
        toInt(stageRequest.participantCharacterID, 0) &&
      identity.shipID === toInt(stageRequest.shipID, 0) &&
      identity.sourceRoomIndex ===
        toInt(stageRequest.progression && stageRequest.progression.fromRoomIndex, 0) &&
      identity.sourceSceneKey === normalizeText(stageRequest.sourceSceneKey, "") &&
      identity.transitionToken === toInt(stageRequest.transitionToken, 0) &&
      (
        pendingTransitionState.status === "pending" &&
        pendingTransitionState.phase === "exit" ||
        stageRequest.trustedDirectManagerExecution === true
      )
    ),
    identity,
    errorMsg: "ABYSSAL_FINAL_EXIT_REVALIDATION_IDENTITY_MISMATCH",
  };
}

function returnOtherAbyssalFinalExitParticipants({
  moveOtherAbyssalParticipantsOutOfRun,
  cloneValue,
}, context) {
  const { validation, session, deps } = context;
  context.groupExitResult = moveOtherAbyssalParticipantsOutOfRun(
    context.pocketState,
    session,
    deps,
    {
      reason: "abyssal-group-final-exit",
      scheduleKSpaceArrivalPresentation: true,
    },
  );
  if (!context.groupExitResult || context.groupExitResult.success !== true) {
    return {
      success: false,
      committed: context.groupExitResult && context.groupExitResult.committed === true,
      sourceCommitIrreversible:
        context.groupExitResult && context.groupExitResult.sourceCommitIrreversible === true,
      participantsReturned: Array.isArray(context.groupExitResult && context.groupExitResult.results)
        ? context.groupExitResult.results.length
        : 0,
      errorMsg: normalizeText(
        context.groupExitResult && context.groupExitResult.errorMsg,
        "ABYSSAL_PARTICIPANT_GROUP_EXIT_FAILED",
      ),
      groupExitResult: context.groupExitResult,
    };
  }
  context.pocketState = context.groupExitResult.pocketState || context.pocketState;
  validation.data.pocketState = context.pocketState;
  return {
    success: true,
    participantsReturned: Array.isArray(context.groupExitResult.results)
      ? context.groupExitResult.results.length
      : 0,
    receiptsCommitted: true,
    results: cloneValue(context.groupExitResult.results) || [],
  };
}

function resolveAbyssalFinalExitTarget({
  buildAbyssalParticipantReturnSpaceState,
  buildAbyssalClientEnvironmentSelection,
  buildAbyssalSceneDescriptor,
  cloneValue,
}, context) {
  const { validation, session, deps, runtime } = context;
  context.currentScene =
    runtime && typeof runtime.getSceneForSession === "function"
      ? runtime.getSceneForSession(session)
      : null;
  context.currentShipEntity =
    context.currentScene && typeof context.currentScene.getShipEntityForSession === "function"
      ? context.currentScene.getShipEntityForSession(session)
      : validation.data.shipEntity || null;
  context.returnSpaceState = buildAbyssalParticipantReturnSpaceState(
    context.pocketState,
    context.exitingParticipant,
    context.currentShipEntity,
  );
  context.targetSystemID = toInt(context.returnSpaceState.systemID, 0);
  if (context.targetSystemID <= 0) {
    return { success: false, errorMsg: "EXIT_TARGET_SYSTEM_MISSING" };
  }
  context.exitingEnvironmentSelection = buildAbyssalClientEnvironmentSelection(
    context.pocketState,
    session,
    deps,
  );
  context.isolatedSceneDescriptor =
    context.currentScene && context.currentScene.sceneKind === "abyssal"
      ? context.currentScene.sceneDescriptor || buildAbyssalSceneDescriptor(context.pocketState, deps)
      : null;
  context.exitCommitAtMs = toInt(deps.now(), Date.now());
  return {
    success: true,
    returnSpaceState: cloneValue(context.returnSpaceState),
    targetSystemID: context.targetSystemID,
  };
}

function stageAbyssalFinalExitObligations({
  stageAbyssalParticipantReturnObligations,
}, context) {
  const { deps } = context;
  // Persist the absolute deadline and stable effect identity before the ship
  // can durably leave the Abyss. A crash after the move can then replay only
  // the time remaining on this exact obligation; it cannot mint a fresh
  // protection window on relog.
  context.participantReturnObligationStage = stageAbyssalParticipantReturnObligations(
    context.pocketState,
    context.exitingParticipant,
    deps,
  );
  if (
    !context.participantReturnObligationStage ||
    context.participantReturnObligationStage.success !== true
  ) {
    return {
      success: false,
      errorMsg: normalizeText(
        context.participantReturnObligationStage && context.participantReturnObligationStage.errorMsg,
        "ABYSSAL_PARTICIPANT_RETURN_OBLIGATION_STAGE_FAILED",
      ),
    };
  }
  context.returnProtectionStageResult = context.participantReturnObligationStage.protectionResult;
  context.participantReturnEffectSource = context.participantReturnObligationStage.source;
  return { success: true };
}

function quiesceAbyssalFinalExitRoom({
  pauseSuppressorControllersForRoom,
  buildPlaceholderRoomState,
  stopSuppressorPresentationForPocketSession,
  clearSuppressorDebugHistoryForRun,
}, context) {
  const { session, deps } = context;
  pauseSuppressorControllersForRoom(
    toInt(context.pocketState && context.pocketState.instanceID, 0),
    buildPlaceholderRoomState(context.pocketState).currentRoomIndex,
    "final-exit-start",
  );
  stopSuppressorPresentationForPocketSession(context.pocketState, session, deps, {
    roomIndex: buildPlaceholderRoomState(context.pocketState).currentRoomIndex,
    reason: "final-exit",
  });
  clearSuppressorDebugHistoryForRun(toInt(context.pocketState && context.pocketState.instanceID, 0));
  return { success: true };
}

function moveAbyssalFinalExitParticipant({}, context) {
  const { validation, deps } = context;
  context.moveResult = deps.moveShipToSpace(
    validation.data.context.shipID,
    context.targetSystemID,
    context.returnSpaceState,
  );
  if (!context.moveResult || !context.moveResult.success || !context.moveResult.data) {
    return {
      success: false,
      errorMsg: context.moveResult && context.moveResult.errorMsg || "EXIT_SHIP_MOVE_FAILED",
    };
  }
  context.movedShip = context.moveResult.data;
  return { success: true, movedShip: context.movedShip };
}

function commitAbyssalFinalExitAuthority({
  stageCommittedAbyssalFinalExitState,
}, context) {
  const committedExitCommit = stageCommittedAbyssalFinalExitState(context);
  if (!committedExitCommit || committedExitCommit.success !== true) {
    return {
      success: false,
      sourceCommitIrreversible: true,
      errorMsg: normalizeText(
        committedExitCommit && committedExitCommit.errorMsg,
        "ABYSSAL_EXIT_COMMIT_PERSIST_FAILED",
      ),
    };
  }
  context.committedPocketState = committedExitCommit.pocketState;
  return { success: true, pocketState: context.committedPocketState };
}

function commitAbyssalFinalExitTraceReturn({
  markSourceTraceReturnedForPocket,
  log,
  commitPocketStateDurably,
  cloneValue,
}, context) {
  const { deps } = context;
  const traceReturnResult = markSourceTraceReturnedForPocket(
    context.committedPocketState,
    context.returnSpaceState,
    deps,
  );
  if (!traceReturnResult.success && traceReturnResult.skipped !== true) {
    log.warn(
      `[AbyssalTraceLifecycle] run=${toInt(context.pocketState && context.pocketState.instanceID, 0)} ` +
        `trace=${toInt(context.pocketState && context.pocketState.traceItemID, 0)} phase=returned ` +
        `status=failed reason=${normalizeText(traceReturnResult.errorMsg, "TRACE_RETURN_STATE_FAILED")}`,
    );
    return {
      success: false,
      sourceCommitIrreversible: true,
      errorMsg: normalizeText(traceReturnResult.errorMsg, "TRACE_RETURN_STATE_FAILED"),
    };
  }
  const traceReturnCompletionCommit = commitPocketStateDurably(
    toInt(context.pocketState.instanceID, 0),
    {
      traceReturnState: {
        ...cloneValue(context.committedPocketState.traceReturnState || {}),
        status: "completed",
        failureReason: "",
        completedAtMs: toInt(deps.now(), context.exitCommitAtMs),
      },
    },
    deps,
    { verifyReadBack: true, forceWrite: true },
  );
  if (!traceReturnCompletionCommit || traceReturnCompletionCommit.success !== true) {
    return {
      success: false,
      sourceCommitIrreversible: true,
      errorMsg: normalizeText(
        traceReturnCompletionCommit && traceReturnCompletionCommit.errorMsg,
        "ABYSSAL_TRACE_RETURN_COMPLETE_PERSIST_FAILED",
      ),
    };
  }
  context.committedPocketState = cloneValue(
    traceReturnCompletionCommit.committedState || traceReturnCompletionCommit.state,
  );
  return { success: true, pocketState: context.committedPocketState };
}

function deliverAbyssalFinalExitParticipant({
  sendAbyssalDungeonExitNotification,
  sendAbyssalLocationExitNotification,
  syncInventoryChanges,
  clearAbyssalClientEnvironmentForSession,
  buildAbyssalExitSessionChanges,
  applyAbyssalEntrySessionFields,
  sendAbyssalEntrySessionChange,
  clearExactAbyssalParticipantRoomScopeMetadata,
}, context) {
  const { validation, session, deps, runtime } = context;
  if (context.exitingEnvironmentSelection) {
    sendAbyssalDungeonExitNotification(
      session,
      context.exitingEnvironmentSelection.volumetricCloudDungeonID,
    );
    sendAbyssalLocationExitNotification(
      session,
      context.exitingEnvironmentSelection.runID,
      context.exitingEnvironmentSelection.roomIndex,
      { phase: "final-exit", deps },
    );
  }
  syncInventoryChanges(session, [{
    item: context.movedShip,
    previousData: context.moveResult.previousData || {},
  }], deps);
  clearAbyssalClientEnvironmentForSession(
    context.pocketState,
    session,
    `solar-system:${context.targetSystemID}`,
    deps,
    "exit",
  );

  const exitSessionChangeState = context.isolatedSceneDescriptor
    ? buildAbyssalExitSessionChanges(
        session,
        context.targetSystemID,
        context.movedShip,
        context.isolatedSceneDescriptor,
      )
    : null;
  if (exitSessionChangeState) {
    applyAbyssalEntrySessionFields(
      session,
      exitSessionChangeState.target,
      context.movedShip,
    );
    sendAbyssalEntrySessionChange(session, exitSessionChangeState, {
      mode: "isolated-exit",
      characterID: validation.data.context.characterID,
      instanceID: context.pocketState.instanceID,
    });
  } else {
    session.locationid = context.targetSystemID;
    session.solarsystemid = context.targetSystemID;
    session.solarsystemid2 = context.targetSystemID;
    session.shipID = context.movedShip.itemID;
    session.shipid = context.movedShip.itemID;
    session.activeShipID = context.movedShip.itemID;
    session.activeShipId = context.movedShip.itemID;
    session.shipTypeID = context.movedShip.typeID;
  }

  const canUseInPlaceTeleport = Boolean(
    runtime &&
      typeof runtime.teleportSessionShipForAbyssalTransition === "function" &&
      context.currentShipEntity &&
      session &&
      session._space &&
      !(context.currentScene && context.currentScene.sceneKind === "abyssal") &&
      toInt(session._space.systemID, 0) === context.targetSystemID,
  );
  if (canUseInPlaceTeleport) {
    context.transitionMode = "teleport-in-place";
    const teleportResult = runtime.teleportSessionShipForAbyssalTransition(
      session,
      context.returnSpaceState.position,
      { direction: context.returnSpaceState.direction },
    );
    if (!teleportResult || !teleportResult.success) {
      context.transitionMode = "attach-after-teleport-failure";
      context.attachedEntity = runtime.attachSession(session, context.movedShip, {
        systemID: context.targetSystemID,
        pendingUndockMovement: false,
        broadcast: true,
        spawnStopped: true,
      });
      if (!context.attachedEntity || !session._space) {
        return {
          success: false,
          sourceCommitIrreversible: true,
          errorMsg:
            teleportResult && teleportResult.errorMsg || "EXIT_SPACE_TELEPORT_FAILED",
        };
      }
      deps.queuePostSpaceAttachFittingHydration(session, context.movedShip.itemID, {
        hydrationProfile: "transition",
      });
    } else {
      context.attachedEntity =
        teleportResult.data && teleportResult.data.entity
          ? teleportResult.data.entity
          : context.currentShipEntity;
    }
  } else {
    context.attachedEntity = runtime.attachSession(session, context.movedShip, {
      systemID: context.targetSystemID,
      pendingUndockMovement: false,
      broadcast: true,
      spawnStopped: true,
    });
    if (!context.attachedEntity || !session._space) {
      return {
        success: false,
        sourceCommitIrreversible: true,
        errorMsg: "EXIT_SPACE_ATTACH_FAILED",
      };
    }
    deps.queuePostSpaceAttachFittingHydration(session, context.movedShip.itemID, {
      hydrationProfile: "transition",
    });
  }
  if (session && session._space) {
    session.spaceSceneKey = normalizeText(
      session._space.sceneKey,
      `solar-system:${context.targetSystemID}`,
    );
    session.spaceInstanceID = toInt(session._space.instanceID, 0);
  }
  clearExactAbyssalParticipantRoomScopeMetadata(
    context.attachedEntity,
    context.pocketState.instanceID,
  );
  return { success: true, attachedEntity: context.attachedEntity, transitionMode: context.transitionMode };
}

function applyAbyssalFinalExitReturnEffects({
  grantAbyssalReturnProtectionAfterAttach,
  log,
  settleAbyssalSuspectOnReturn,
}, context) {
  const { validation, session, deps } = context;
  // Golden lifecycle parity: protection is a post-commit return effect. The
  // exact ship must already be owned by the origin-system scene before it can
  // become protected; never grant this while the Abyssal scene still owns it.
  context.returnProtectionResult = grantAbyssalReturnProtectionAfterAttach(
    context.participantReturnEffectSource,
    session,
    context.attachedEntity,
    deps,
  );
  if (!context.returnProtectionResult || context.returnProtectionResult.success !== true) {
    log.error(
      `[AbyssalMgr] Return protection grant failed ` +
        `char=${validation.data.context.characterID} ship=${validation.data.context.shipID} ` +
        `instance=${context.pocketState.instanceID} ` +
        `reason=${normalizeText(
          context.returnProtectionResult && context.returnProtectionResult.errorMsg,
          "ABYSSAL_RETURN_PROTECTION_GRANT_FAILED",
        )}`,
    );
  }

  context.suspectReturnResult = settleAbyssalSuspectOnReturn(
    context.participantReturnEffectSource,
    session,
    deps,
  );
  if (
    !context.suspectReturnResult.success &&
    context.participantReturnEffectSource.suspectOnReturn === true
  ) {
    log.warn(
      `[AbyssalReturnEffect] run=${toInt(context.pocketState && context.pocketState.instanceID, 0)} ` +
        `trace=${toInt(context.pocketState && context.pocketState.traceItemID, 0)} ` +
        `character=${toInt(context.pocketState && context.pocketState.characterID, 0)} ` +
        `effect=suspect state=pending reason=${normalizeText(
          context.suspectReturnResult.errorMsg,
          "SUSPECT_RETURN_SETTLEMENT_FAILED",
        )}`,
    );
  }
  return {
    success: true,
    returnProtectionResult: context.returnProtectionResult,
    suspectReturnResult: context.suspectReturnResult,
  };
}

function scheduleAbyssalFinalExitFinalization({
  scheduleAbyssalKSpaceArrivalAfterExit,
  resolveAbyssalSceneModeState,
  log,
  formatVectorForLog,
  buildAbyssalKSpaceArrivalReadiness,
  logAbyssalKSpaceArrival,
  sendAbyssalContentFinishedNotification,
  normalizeAbyssalRunOutcome,
  getActivePocketStateByInstanceID,
}, context, stageRequest) {
  const { validation, session, deps } = context;
  const kspaceArrivalSchedule = scheduleAbyssalKSpaceArrivalAfterExit(
    context.pocketState,
    session,
    deps,
  );
  const exitSceneModeState = resolveAbyssalSceneModeState(context.pocketState, deps);
  log.info(
    `[AbyssalMgr] Abyssal pocket exit char=${validation.data.context.characterID} ` +
      `ship=${validation.data.context.shipID} instance=${context.pocketState.instanceID} ` +
      `sourceTrace=${context.pocketState.sourceTraceItemID} returnPos=${formatVectorForLog(context.returnSpaceState.position)} ` +
      `sourceTracePos=${formatVectorForLog(context.pocketState.sourceTracePosition)} ` +
      `sourceShipPos=${formatVectorForLog(context.pocketState.sourceShipPosition)} ` +
      `mode=${context.transitionMode} finalPos=${formatVectorForLog(context.attachedEntity && context.attachedEntity.position)} ` +
      `runMode=${normalizeText(exitSceneModeState.mode, "unknown")}`,
  );

  if (!kspaceArrivalSchedule || kspaceArrivalSchedule.scheduled !== true) {
    const readiness = buildAbyssalKSpaceArrivalReadiness(null, session, deps);
    logAbyssalKSpaceArrival(
      {
        runID: toInt(context.pocketState && context.pocketState.instanceID, 0),
        transitionToken: toInt(
          context.pocketState && context.pocketState.pendingTransitionState &&
            context.pocketState.pendingTransitionState.token,
          0,
        ),
        characterID: validation.data.context.characterID,
        shipID: validation.data.context.shipID,
        destinationSystemID: context.targetSystemID,
        sceneKey: normalizeText(
          session && session._space && session._space.sceneKey,
          "none",
        ),
        effectName: "effects.AbyssalReentrySplash",
      },
      readiness,
      "skipped",
      normalizeText(
        kspaceArrivalSchedule && kspaceArrivalSchedule.errorMsg,
        "KSPACE_ARRIVAL_NOT_SCHEDULED",
      ),
    );
    sendAbyssalContentFinishedNotification(session, context.pocketState, deps);
    const finalizationResult = context.finalExitCoordinator.finalizeFinalExit({
      ...stageRequest,
      runOutcome: normalizeAbyssalRunOutcome(
        getActivePocketStateByInstanceID(toInt(context.pocketState.instanceID, 0)) &&
          getActivePocketStateByInstanceID(toInt(context.pocketState.instanceID, 0)).runOutcome ||
          context.pocketState.runOutcome,
      ),
    });
    return {
      success: true,
      scheduled: false,
      finalizationResult,
      context: {
        outcomeCommitted: finalizationResult.outcomeCommitted === true,
        cleanupStarted: finalizationResult.cleanupStarted === true,
        cleanupCompleted: finalizationResult.cleanupCompleted === true,
      },
    };
  }
  return { success: true, scheduled: true, pendingArrival: kspaceArrivalSchedule.pendingArrival };
}

function settleAbyssalFinalExitExecutionFailure({
  settleCommittedAbyssalFinalExitFailure,
}, context, settlementRequest) {
  if (settlementRequest.convergenceMode === "restore_source") {
    return {
      success: true,
      delegatedToPendingTransitionScheduler: true,
    };
  }
  if (settlementRequest.failedStage === "return_other_participants") {
    return {
      success: false,
      forwardConvergenceRequired: true,
      participantReturnPending: true,
    };
  }
  return settleCommittedAbyssalFinalExitFailure(context,
    normalizeText(
      settlementRequest.failureResult && settlementRequest.failureResult.errorMsg,
      "ABYSSAL_FINAL_EXIT_FORWARD_CONVERGENCE_REQUIRED",
    ),
  );
}

function buildAbyssalFinalExitExecutionStages({
  revalidateAbyssalFinalExit,
  returnOtherAbyssalFinalExitParticipants,
  resolveAbyssalFinalExitTarget,
  stageAbyssalFinalExitObligations,
  quiesceAbyssalFinalExitRoom,
  moveAbyssalFinalExitParticipant,
  commitAbyssalFinalExitAuthority,
  commitAbyssalFinalExitTraceReturn,
  deliverAbyssalFinalExitParticipant,
  applyAbyssalFinalExitReturnEffects,
  scheduleAbyssalFinalExitFinalization,
  settleAbyssalFinalExitExecutionFailure,
  commitAbyssalFinalExitOutcome,
  cleanupAbyssalFinalExit,
}, context) {
  return {
    revalidateFinalExit: (stageRequest) => revalidateAbyssalFinalExit(context, stageRequest),
    returnOtherParticipants: () => returnOtherAbyssalFinalExitParticipants(context),
    resolveReturnTarget: () => resolveAbyssalFinalExitTarget(context),
    stageReturnObligations: () => stageAbyssalFinalExitObligations(context),
    quiesceFinalRoom: () => quiesceAbyssalFinalExitRoom(context),
    moveActivatingParticipant: () => moveAbyssalFinalExitParticipant(context),
    commitExitAuthority: () => commitAbyssalFinalExitAuthority(context),
    commitTraceReturn: () => commitAbyssalFinalExitTraceReturn(context),
    deliverActivatingParticipant: () => deliverAbyssalFinalExitParticipant(context),
    applyReturnEffects: () => applyAbyssalFinalExitReturnEffects(context),
    scheduleFinalization: (stageRequest) => scheduleAbyssalFinalExitFinalization(context, stageRequest),
    settleExitFailure: (settlementRequest) => settleAbyssalFinalExitExecutionFailure(context, settlementRequest),
    commitExitedOutcome: () => commitAbyssalFinalExitOutcome(context),
    performFinalCleanup: () => cleanupAbyssalFinalExit(context),
  };
}

function moveShipOutOfPlaceholderPocket({
  getDependencies,
  buildAbyssalFinalExitExecutionContext,
  createComposedAbyssalFinalExitCoordinator,
  buildAbyssalFinalExitExecutionStages,
  getPendingAbyssalTransitionState,
  buildAbyssalFinalExitCoordinatorRequest,
}, validation, session, deps = getDependencies()) {
  const context = buildAbyssalFinalExitExecutionContext(validation, session, deps);
  context.finalExitCoordinator = createComposedAbyssalFinalExitCoordinator(
    buildAbyssalFinalExitExecutionStages(context),
  );
  const currentExitTransition = getPendingAbyssalTransitionState(context.pocketState);
  const coordinatorRequest = buildAbyssalFinalExitCoordinatorRequest(
    context.pocketState,
    {
      participantCharacterID: toInt(validation.data.context.characterID, 0),
      shipID: toInt(validation.data.context.shipID, 0),
      trustedDirectManagerExecution: !(
        currentExitTransition &&
        currentExitTransition.status === "pending" &&
        currentExitTransition.phase === "exit"
      ),
    },
  );
  const coordinatorResult = context.finalExitCoordinator.executeFinalExit(coordinatorRequest);
  if (!coordinatorResult.success) {
    const failedStageResult =
      coordinatorResult.stageResults &&
      coordinatorResult.stageResults[coordinatorResult.stage];
    return {
      ...(failedStageResult && failedStageResult.success === false
        ? failedStageResult
        : {}),
      success: false,
      committed:
        coordinatorResult.exitAuthorityCommitted === true ||
        coordinatorResult.sourceCommitIrreversible === true,
      sourceCommitIrreversible:
        coordinatorResult.sourceCommitIrreversible === true,
      terminallySettled:
        coordinatorResult.settlementResult &&
        coordinatorResult.settlementResult.terminallySettled === true,
      errorMsg: normalizeText(
        coordinatorResult.errorMsg,
        "ABYSSAL_FINAL_EXIT_FAILED",
      ),
      coordinatorResult,
    };
  }
  return {
    success: true,
    data: {
      movedShip: context.movedShip,
      attachedEntity: context.attachedEntity,
      transitionMode: context.transitionMode,
      returnSpaceState: context.returnSpaceState,
      returnProtectionStageResult: context.returnProtectionStageResult,
      returnProtectionResult: context.returnProtectionResult,
      suspectReturnResult: context.suspectReturnResult,
      groupExitResult: context.groupExitResult,
      coordinatorResult,
    },
  };
}

// Capture supplied capabilities once, as the original closure did. Internal
// callbacks are bound once per instance; no runtime state lives in this wiring.
function createAbyssalFinalExitExecution({
  getDependencies,
  getCharacterID,
  stageCommittedAbyssalFinalExitState,
  settleCommittedAbyssalFinalExitFailure,
  getActivePocketStateByInstanceID,
  hasTerminalFailureOutcome,
  recordAbyssalRunOutcome,
  normalizeAbyssalRunOutcome,
  ABYSSAL_RUN_OUTCOME,
  cleanupAbyssalRun,
  createComposedAbyssalFinalExitCoordinator,
  ensureAbyssalPocketDurablyAdopted,
  cloneValue,
  getAbyssalParticipantRecord,
  getPendingAbyssalTransitionState,
  buildPlaceholderRoomState,
  moveOtherAbyssalParticipantsOutOfRun,
  buildAbyssalParticipantReturnSpaceState,
  buildAbyssalClientEnvironmentSelection,
  buildAbyssalSceneDescriptor,
  stageAbyssalParticipantReturnObligations,
  pauseSuppressorControllersForRoom,
  stopSuppressorPresentationForPocketSession,
  clearSuppressorDebugHistoryForRun,
  markSourceTraceReturnedForPocket,
  log,
  commitPocketStateDurably,
  sendAbyssalDungeonExitNotification,
  sendAbyssalLocationExitNotification,
  syncInventoryChanges,
  clearAbyssalClientEnvironmentForSession,
  buildAbyssalExitSessionChanges,
  applyAbyssalEntrySessionFields,
  sendAbyssalEntrySessionChange,
  clearExactAbyssalParticipantRoomScopeMetadata,
  grantAbyssalReturnProtectionAfterAttach,
  settleAbyssalSuspectOnReturn,
  scheduleAbyssalKSpaceArrivalAfterExit,
  resolveAbyssalSceneModeState,
  formatVectorForLog,
  buildAbyssalKSpaceArrivalReadiness,
  logAbyssalKSpaceArrival,
  sendAbyssalContentFinishedNotification,
  buildAbyssalFinalExitCoordinatorRequest,
}) {

  const ports = {
    getDependencies,
    getCharacterID,
    stageCommittedAbyssalFinalExitState,
    settleCommittedAbyssalFinalExitFailure,
    getActivePocketStateByInstanceID,
    hasTerminalFailureOutcome,
    recordAbyssalRunOutcome,
    normalizeAbyssalRunOutcome,
    ABYSSAL_RUN_OUTCOME,
    cleanupAbyssalRun,
    createComposedAbyssalFinalExitCoordinator,
    ensureAbyssalPocketDurablyAdopted,
    cloneValue,
    getAbyssalParticipantRecord,
    getPendingAbyssalTransitionState,
    buildPlaceholderRoomState,
    moveOtherAbyssalParticipantsOutOfRun,
    buildAbyssalParticipantReturnSpaceState,
    buildAbyssalClientEnvironmentSelection,
    buildAbyssalSceneDescriptor,
    stageAbyssalParticipantReturnObligations,
    pauseSuppressorControllersForRoom,
    stopSuppressorPresentationForPocketSession,
    clearSuppressorDebugHistoryForRun,
    markSourceTraceReturnedForPocket,
    log,
    commitPocketStateDurably,
    sendAbyssalDungeonExitNotification,
    sendAbyssalLocationExitNotification,
    syncInventoryChanges,
    clearAbyssalClientEnvironmentForSession,
    buildAbyssalExitSessionChanges,
    applyAbyssalEntrySessionFields,
    sendAbyssalEntrySessionChange,
    clearExactAbyssalParticipantRoomScopeMetadata,
    grantAbyssalReturnProtectionAfterAttach,
    settleAbyssalSuspectOnReturn,
    scheduleAbyssalKSpaceArrivalAfterExit,
    resolveAbyssalSceneModeState,
    formatVectorForLog,
    buildAbyssalKSpaceArrivalReadiness,
    logAbyssalKSpaceArrival,
    sendAbyssalContentFinishedNotification,
    buildAbyssalFinalExitCoordinatorRequest,
  };
  ports.buildAbyssalFinalExitExecutionContext = buildAbyssalFinalExitExecutionContext.bind(null, ports);
  ports.commitAbyssalFinalExitOutcome = commitAbyssalFinalExitOutcome.bind(null, ports);
  ports.cleanupAbyssalFinalExit = cleanupAbyssalFinalExit.bind(null, ports);
  ports.revalidateAbyssalFinalExit = revalidateAbyssalFinalExit.bind(null, ports);
  ports.returnOtherAbyssalFinalExitParticipants = returnOtherAbyssalFinalExitParticipants.bind(null, ports);
  ports.resolveAbyssalFinalExitTarget = resolveAbyssalFinalExitTarget.bind(null, ports);
  ports.stageAbyssalFinalExitObligations = stageAbyssalFinalExitObligations.bind(null, ports);
  ports.quiesceAbyssalFinalExitRoom = quiesceAbyssalFinalExitRoom.bind(null, ports);
  ports.moveAbyssalFinalExitParticipant = moveAbyssalFinalExitParticipant.bind(null, ports);
  ports.commitAbyssalFinalExitAuthority = commitAbyssalFinalExitAuthority.bind(null, ports);
  ports.commitAbyssalFinalExitTraceReturn = commitAbyssalFinalExitTraceReturn.bind(null, ports);
  ports.deliverAbyssalFinalExitParticipant = deliverAbyssalFinalExitParticipant.bind(null, ports);
  ports.applyAbyssalFinalExitReturnEffects = applyAbyssalFinalExitReturnEffects.bind(null, ports);
  ports.scheduleAbyssalFinalExitFinalization = scheduleAbyssalFinalExitFinalization.bind(null, ports);
  ports.settleAbyssalFinalExitExecutionFailure = settleAbyssalFinalExitExecutionFailure.bind(null, ports);
  ports.buildAbyssalFinalExitExecutionStages = buildAbyssalFinalExitExecutionStages.bind(null, ports);
  ports.moveShipOutOfPlaceholderPocket = moveShipOutOfPlaceholderPocket.bind(null, ports);
  Object.freeze(ports);
  return { moveShipOutOfPlaceholderPocket: ports.moveShipOutOfPlaceholderPocket };
}

module.exports = { createAbyssalFinalExitExecution };
