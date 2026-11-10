"use strict";

const { normalizeText } = require("../domain/abyssalValueUtils");
const { evaluateAbyssalConduitEligibility, resolveAbyssalRoomProgression } = require("./abyssalConduitPolicy");

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

// Run identity and durable obligations are checked before runtime, range and objectives.
function validateAbyssalExitTraceActivation(ports, args, session, deps = ports.getDependencies()) {
  const work = { args, session, deps };
  for (const validate of [
    resolveExitConduitIdentity,
    validateExitParticipantAndOutcome,
    settleExitRewardObligations,
    validateExitEnvironmentAndPersistence,
    resolveExitRuntime,
    validateExitRuntimeIdentity,
  ]) {
    const rejected = validate(ports, work);
    if (rejected) return rejected;
  }
  return validateExitRangeAndObjective(ports, work);
}

function resolveExitConduitIdentity(ports, work) {
  const {
    getSessionContext,
    getActivePocketStateByMarkerItemID,
    getActivePocketStateForSession,
    syncExpiredAbyssalPocketState,
    readPocketMarkerStateFromItem,
    buildPlaceholderRoomState,
    getPlaceholderRoomEntry,
    log,
  } = ports;
  const {
    args,
    session,
    deps,
  } = work;
  const context = getSessionContext(session);
  const markerItemID = toInt(args && args[0], 0);
  const rawPocketState = getActivePocketStateByMarkerItemID(markerItemID, deps) ||
    getActivePocketStateForSession(session);
  let pocketState = syncExpiredAbyssalPocketState(
    rawPocketState,
    null,
    deps,
    session,
  );
  const markerItem = deps.findItemById(markerItemID);
  const markerState = readPocketMarkerStateFromItem(markerItem);
  let staleConduitState = null;
  if (pocketState && markerItemID > 0) {
    const roomState = buildPlaceholderRoomState(pocketState);
    const currentRoomEntry = getPlaceholderRoomEntry(pocketState, roomState.currentRoomIndex);
    const currentConduitID = toInt(currentRoomEntry && currentRoomEntry.conduitItemID, 0);
    const knownConduitIDs = Object.values(roomState.roomStatesByIndex || {})
      .map((roomEntry) => toInt(roomEntry && roomEntry.conduitItemID, 0))
      .filter((conduitID) => conduitID > 0);
    const stale = Boolean(
      currentConduitID > 0 &&
      markerItemID !== currentConduitID &&
      (
        knownConduitIDs.includes(markerItemID) ||
        (markerState && markerState.markerKind === "exit") ||
        rawPocketState
      )
    );
    if (stale) {
      staleConduitState = {
        requestedMarker: markerItemID,
        currentRoom: roomState.currentRoomIndex,
        currentConduitID,
      };
    }
  }
  const conduitIdentityPolicyInput = {
    conduit: {
      stale: Boolean(staleConduitState),
      exitTracePresent: Boolean(
        pocketState && markerState && markerState.markerKind === "exit",
      ),
    },
  };
  const conduitIdentityDecision = evaluateAbyssalConduitEligibility(
    conduitIdentityPolicyInput,
    { throughStage: "conduitIdentity" },
  );
  if (!conduitIdentityDecision.allowed) {
    if (conduitIdentityDecision.reason === "ABYSSAL_STALE_ROOM_CONDUIT") {
      log.info(
        `[AbyssalMgr] Stale Abyssal room conduit activation rejected ` +
          `requestedMarker=${markerItemID} currentRoom=${staleConduitState.currentRoom} ` +
          `currentConduitID=${staleConduitState.currentConduitID}`,
      );
      return {
        success: false,
        errorMsg: conduitIdentityDecision.reason,
        data: staleConduitState,
      };
    }
    return {
      success: false,
      errorMsg: conduitIdentityDecision.reason,
    };
  }
  Object.assign(work, { context, markerItemID, pocketState, markerItem, markerState, conduitIdentityPolicyInput });
  return null;
}

function validateExitParticipantAndOutcome(ports, work) {
  const {
    getAbyssalParticipantRecord,
    isAbyssalParticipantInRun,
    evaluateAbyssalDirectCallbackTerminalGuard,
    resolveAbyssalTerminalCallbackReason,
  } = ports;
  const {
    pocketState,
    context,
    conduitIdentityPolicyInput,
  } = work;
  const participant = getAbyssalParticipantRecord(
    pocketState,
    context.characterID,
  );
  const participantAuthorized = isAbyssalParticipantInRun(
    pocketState,
    context.characterID,
  );
  const authorizationPolicyInput = {
    ...conduitIdentityPolicyInput,
    participantAuthorized,
  };
  const authorizationDecision = evaluateAbyssalConduitEligibility(
    authorizationPolicyInput,
    { throughStage: "authorization" },
  );
  if (!authorizationDecision.allowed) {
    return {
      success: false,
      errorMsg: authorizationDecision.reason,
    };
  }
  const terminalGuard = evaluateAbyssalDirectCallbackTerminalGuard(
    pocketState,
    "conduit-activation",
  );
  const terminalReason = terminalGuard.blocked
    ? resolveAbyssalTerminalCallbackReason(terminalGuard.outcome)
    : "";
  const terminalPolicyInput = {
    ...authorizationPolicyInput,
    terminal: {
      blocked: terminalGuard.blocked,
      reason: terminalReason,
    },
  };
  const terminalDecision = evaluateAbyssalConduitEligibility(
    terminalPolicyInput,
    { throughStage: "terminal" },
  );
  if (!terminalDecision.allowed) {
    return {
      success: false,
      suppressed: true,
      terminal: true,
      reason: terminalDecision.reason,
      errorMsg: terminalDecision.reason,
      data: {
        pocketState: terminalGuard.pocketState,
        runOutcome: terminalGuard.outcome,
        guardReason: terminalGuard.reason,
      },
    };
  }
  Object.assign(work, { participant, terminalPolicyInput });
  return null;
}

function settleExitRewardObligations(ports, work) {
  const {
    buildPlaceholderRoomState,
    getPlaceholderRoomEntry,
    listUniquePositiveInts,
    suppressAbyssalRoomRewards,
    retryPendingAbyssalRewardMaterializations,
  } = ports;
  const {
    deps,
    markerItemID,
  } = work;
  let { pocketState } = work;
  let rewardRetryRoomState = buildPlaceholderRoomState(pocketState);
  let rewardRetryRoomEntry = getPlaceholderRoomEntry(
    pocketState,
    rewardRetryRoomState.currentRoomIndex,
  );
  if (listUniquePositiveInts(rewardRetryRoomEntry.rewardSuppressionPendingRemovalItemIDs).length > 0) {
    pocketState = suppressAbyssalRoomRewards(
      pocketState,
      rewardRetryRoomState.currentRoomIndex,
      deps,
      normalizeText(rewardRetryRoomEntry.suppressedReason, "REWARD_SUPPRESSION_CLEANUP_PENDING"),
    ) || pocketState;
    rewardRetryRoomState = buildPlaceholderRoomState(pocketState);
    rewardRetryRoomEntry = getPlaceholderRoomEntry(
      pocketState,
      rewardRetryRoomState.currentRoomIndex,
    );
    const pendingRemovalItemIDs = listUniquePositiveInts(
      rewardRetryRoomEntry.rewardSuppressionPendingRemovalItemIDs,
    );
    if (pendingRemovalItemIDs.length > 0) {
      return {
        success: false,
        errorMsg: "ABYSSAL_REWARD_SUPPRESSION_CLEANUP_PENDING",
        data: { pocketState, pendingRemovalItemIDs },
      };
    }
  }
  if (
    rewardRetryRoomEntry.cacheRewardRetryIntent ||
    (
      rewardRetryRoomEntry.extractionNodeRewardRetryIntentsByItemID &&
      Object.keys(rewardRetryRoomEntry.extractionNodeRewardRetryIntentsByItemID).length > 0
    )
  ) {
    const retryResult = retryPendingAbyssalRewardMaterializations(
      pocketState,
      rewardRetryRoomState.currentRoomIndex,
      deps,
    );
    pocketState = retryResult.data || pocketState;
    rewardRetryRoomState = buildPlaceholderRoomState(pocketState);
    rewardRetryRoomEntry = getPlaceholderRoomEntry(
      pocketState,
      rewardRetryRoomState.currentRoomIndex,
    );
    const pendingExtractionRetryCount = Object.keys(
      rewardRetryRoomEntry.extractionNodeRewardRetryIntentsByItemID || {},
    ).length;
    if (rewardRetryRoomEntry.cacheRewardRetryIntent || pendingExtractionRetryCount > 0) {
      return {
        success: false,
        errorMsg: "ABYSSAL_REWARD_MATERIALIZATION_PENDING",
        data: {
          pocketState,
          markerItemID,
          roomIndex: rewardRetryRoomState.currentRoomIndex,
          cacheRetryPending: Boolean(rewardRetryRoomEntry.cacheRewardRetryIntent),
          extractionRetryPendingCount: pendingExtractionRetryCount,
        },
      };
    }
  }
  Object.assign(work, { pocketState });
  return null;
}

function validateExitEnvironmentAndPersistence(ports, work) {
  const {
    buildPlaceholderRoomState,
    getPlaceholderRoomEntry,
    hasTerminalFailureOutcome,
    normalizeLowerText,
    ensureAbyssalPocketPersistenceReady,
  } = ports;
  const {
    pocketState,
    markerItemID,
    deps,
  } = work;
  const environmentalGateRoomState = buildPlaceholderRoomState(pocketState);
  const environmentalGateRoomEntry = getPlaceholderRoomEntry(
    pocketState,
    environmentalGateRoomState.currentRoomIndex,
  );
  if (
    !hasTerminalFailureOutcome(pocketState) &&
    normalizeLowerText(
      environmentalGateRoomEntry && environmentalGateRoomEntry.environmentalMechanicsState,
      "",
    ) === "blocked"
  ) {
    return {
      success: false,
      errorMsg: "ABYSSAL_ROOM_ENVIRONMENTAL_MECHANICS_BLOCKED",
      data: {
        pocketState,
        markerItemID,
        roomIndex: environmentalGateRoomState.currentRoomIndex,
        reason: normalizeText(
          environmentalGateRoomEntry &&
            environmentalGateRoomEntry.environmentalMechanicsFailureReason,
          "ABYSSAL_ENVIRONMENT_EFFECTS_NOT_READY",
        ),
      },
    };
  }
  const persistenceResult = ensureAbyssalPocketPersistenceReady(pocketState, deps);
  if (!persistenceResult.success) {
    return {
      success: false,
      errorMsg: "ABYSSAL_RUN_STATE_PERSIST_FAILED",
      data: {
        pocketState,
        markerItemID,
        persistenceResult,
      },
    };
  }
  return null;
}

function resolveExitRuntime(ports, work) {
  const {
    buildPlaceholderRoomState,
    buildAbyssalRoomProgressionPolicyInput,
    TYPE_ABYSSAL_ORIGIN_CONDUIT,
    TYPE_ABYSSAL_TRANSFER_CONDUIT,
    getPocketScene,
    resolveExactAbyssalRunRoomScope,
  } = ports;
  const {
    deps,
    context,
    pocketState,
    session,
    markerItemID,
  } = work;
  const runtime = deps;
  const shipItem = deps.findItemById(context.shipID);
  const roomState = buildPlaceholderRoomState(pocketState);
  const currentRoomIndex = roomState.currentRoomIndex;
  const roomProgressionPolicyInput = buildAbyssalRoomProgressionPolicyInput(
    pocketState,
  );
  const progression = resolveAbyssalRoomProgression(
    roomProgressionPolicyInput,
  );
  const activationMode = progression.activationMode;
  const expectedConduitTypeID = activationMode === "final_exit"
    ? TYPE_ABYSSAL_ORIGIN_CONDUIT
    : TYPE_ABYSSAL_TRANSFER_CONDUIT;
  const expectedConduitRole = activationMode;
  const pocketScene = getPocketScene(pocketState, deps);
  const sessionScene = runtime && typeof runtime.getSceneForSession === "function"
    ? runtime.getSceneForSession(session)
    : null;
  const sceneIdentityMatches = Boolean(
    pocketScene &&
    sessionScene &&
    (
      pocketScene === sessionScene ||
      (
        normalizeText(pocketScene.sceneKey, "") &&
        normalizeText(pocketScene.sceneKey, "") === normalizeText(sessionScene.sceneKey, "")
      )
    )
  );
  const shipEntity = context.shipID > 0 && sessionScene &&
    typeof sessionScene.getEntityByID === "function"
    ? sessionScene.getEntityByID(context.shipID)
    : null;
  const markerEntity = markerItemID > 0 && sceneIdentityMatches &&
    typeof pocketScene.getEntityByID === "function"
    ? pocketScene.getEntityByID(markerItemID)
    : null;
  const markerEntityScope = resolveExactAbyssalRunRoomScope(markerEntity);
  Object.assign(work, { shipItem, currentRoomIndex, roomProgressionPolicyInput, activationMode, expectedConduitTypeID, expectedConduitRole, sceneIdentityMatches, shipEntity, markerEntity, markerEntityScope, sessionScene });
  return null;
}

function validateExitRuntimeIdentity(ports, work) {
  const {
    normalizeLowerText,
    ABYSSAL_ROOM_ENTITY_ROLES,
  } = ports;
  const {
    sceneIdentityMatches,
    markerEntity,
    markerEntityScope,
    pocketState,
    currentRoomIndex,
    expectedConduitTypeID,
    markerItem,
    markerState,
    expectedConduitRole,
    terminalPolicyInput,
    markerItemID,
    activationMode,
  } = work;
  const markerRuntimeReady = Boolean(
    sceneIdentityMatches &&
    markerEntity &&
    markerEntityScope &&
    markerEntityScope.runID === toInt(pocketState.instanceID, 0) &&
    markerEntityScope.roomIndex === currentRoomIndex &&
    normalizeText(markerEntity.abyssalEntityRole, "") === ABYSSAL_ROOM_ENTITY_ROLES.CONDUIT &&
    markerEntity.evejsAbyssalPocketMarker === true &&
    normalizeLowerText(markerEntity.evejsAbyssalPocketMarkerKind, "") === "exit" &&
    toInt(markerEntity.typeID, 0) === expectedConduitTypeID &&
    toInt(markerItem && markerItem.typeID, 0) === expectedConduitTypeID &&
    toInt(markerState.instanceID, 0) === toInt(pocketState.instanceID, 0) &&
    toInt(markerState.roomIndex, 0) === currentRoomIndex &&
    normalizeText(markerState.abyssalEntityRole, "") === ABYSSAL_ROOM_ENTITY_ROLES.CONDUIT &&
    normalizeLowerText(markerState.conduitRole, "") === expectedConduitRole
  );
  const runtimePolicyInput = {
    ...terminalPolicyInput,
    conduit: {
      ...terminalPolicyInput.conduit,
      runtimeReady: markerRuntimeReady,
    },
  };
  const runtimeDecision = evaluateAbyssalConduitEligibility(
    runtimePolicyInput,
    { throughStage: "runtime" },
  );
  if (!runtimeDecision.allowed) {
    return {
      success: false,
      errorMsg: runtimeDecision.reason,
      data: {
        pocketState,
        markerItemID,
        activationMode,
        expectedConduitTypeID,
        sceneIdentityMatches,
        markerEntityFound: Boolean(markerEntity),
        markerEntityScope: markerEntityScope || null,
      },
    };
  }
  Object.assign(work, { runtimePolicyInput });
  return null;
}

function validateExitRangeAndObjective(ports, work) {
  const {
    log,
    evaluateGateActivationRange,
    CONDUIT_ACTIVATION_RANGE_METERS,
    buildAbyssalRoomObjectivePolicyInput,
    buildRoomLogContext,
  } = ports;
  const {
    sessionScene,
    shipEntity,
    markerEntity,
    runtimePolicyInput,
    pocketState,
    roomProgressionPolicyInput,
    deps,
    context,
    markerItemID,
    markerState,
    activationMode,
    shipItem,
    markerItem,
    participant,
  } = work;
  const rangeState = evaluateGateActivationRange(
    sessionScene,
    shipEntity,
    markerEntity,
    CONDUIT_ACTIVATION_RANGE_METERS,
  );
  const rangePolicyInput = {
    ...runtimePolicyInput,
    range: { inRange: rangeState.success === true },
  };
  const rangeDecision = evaluateAbyssalConduitEligibility(
    rangePolicyInput,
    { throughStage: "range" },
  );
  if (!rangeDecision.allowed) {
    return {
      success: false,
      errorMsg: rangeDecision.reason,
      data: {
        surfaceDistanceMeters: rangeState.surfaceDistance,
        maximumDistanceMeters: rangeState.rangeMeters,
        reconciliationMeters: rangeState.reconciliationMeters,
      },
    };
  }
  const conduitPolicyInput = {
    ...rangePolicyInput,
    objective: buildAbyssalRoomObjectivePolicyInput(pocketState),
    transition: { pending: false },
    run: roomProgressionPolicyInput,
  };
  const conduitDecision = evaluateAbyssalConduitEligibility(
    conduitPolicyInput,
  );
  if (!conduitDecision.allowed) {
    const roomLogContext = buildRoomLogContext(pocketState, deps);
    log.info(
      `[AbyssalMgr] Room objective incomplete char=${roomLogContext.characterID} ` +
        `ship=${roomLogContext.shipID} filament=${roomLogContext.filamentTypeID} ` +
        `name="${roomLogContext.filamentName}" tier=${roomLogContext.tier} weather=${roomLogContext.weather} ` +
        `room=${roomLogContext.roomIndex}/${roomLogContext.totalRooms} roomOrigin=${roomLogContext.roomOrigin} ` +
        `finalShip=${roomLogContext.finalShip} hostileCount=${roomLogContext.hostileCount} ` +
        `cacheID=${roomLogContext.cacheID} conduitID=${roomLogContext.conduitID} ` +
        `timerRemainingMs=${roomLogContext.timerRemainingMs}`,
    );
    return {
      success: false,
      errorMsg: conduitDecision.reason,
    };
  }
  return {
    success: true,
    data: {
      context,
      markerItemID,
      pocketState,
      markerState,
      activationMode,
      shipItem,
      shipEntity,
      markerItem,
      markerEntity,
      participant,
    },
  };
}

function createAbyssalExitValidation(ports) {
  return {
    validateAbyssalExitTraceActivation: validateAbyssalExitTraceActivation.bind(null, ports),
  };
}

module.exports = { createAbyssalExitValidation };
