"use strict";

const { normalizeText } = require("../domain/abyssalValueUtils");
const {
  ABYSSAL_PARTICIPANT_DESTRUCTION_OPERATION_STATUS,
  ABYSSAL_PARTICIPANT_DESTRUCTION_STATUS_RANK,
  hasTerminalFailureOutcome,
  hasFailedTimeoutOutcome,
} = require("../domain/abyssalTerminalTransitionPolicy");

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function inspectCommittedAbyssalParticipantDeathHandoff(
  ports,
  pocketState,
  session = null,
  deps = ports.getDependencies(),
) {
  const { getAbyssalTimeoutState, getAbyssalParticipantDestructionOperation } = ports;
  const timeoutState = getAbyssalTimeoutState(pocketState, deps);
  const destructionOperation =
    getAbyssalParticipantDestructionOperation(pocketState);
  const durablePodReceiptPresent = Boolean(
    destructionOperation &&
    destructionOperation.status ===
      ABYSSAL_PARTICIPANT_DESTRUCTION_OPERATION_STATUS.POD_DESTROYED
  );
  const durableParticipantTerminalIntent = Boolean(
    destructionOperation &&
    toInt(
      ABYSSAL_PARTICIPANT_DESTRUCTION_STATUS_RANK[
        destructionOperation.status
      ],
      0,
    ) >= ABYSSAL_PARTICIPANT_DESTRUCTION_STATUS_RANK[
      ABYSSAL_PARTICIPANT_DESTRUCTION_OPERATION_STATUS.HULL_DESTROYED
    ]
  );
  if (
    (
      !durableParticipantTerminalIntent &&
      (
        !hasTerminalFailureOutcome(pocketState) ||
        timeoutState.shipDestroyed !== true
      )
    ) ||
    durablePodReceiptPresent
  ) {
    return { committed: false, reason: "NO_PENDING_PARTICIPANT_DEATH" };
  }

  const originalShipID = toInt(pocketState && pocketState.shipID, 0);
  const originalShipItem =
    originalShipID > 0 && deps && typeof deps.findItemById === "function"
      ? deps.findItemById(originalShipID)
      : null;
  if (originalShipItem) {
    return { committed: false, reason: "ORIGINAL_HULL_STILL_PRESENT" };
  }

  const characterID = toInt(pocketState && pocketState.characterID, 0);
  const characterRecord =
    characterID > 0 && deps && typeof deps.getCharacterRecord === "function"
      ? deps.getCharacterRecord(characterID)
      : null;
  const currentShipID = toInt(
    characterRecord && characterRecord.shipID,
    toInt(
      session && session._space && session._space.shipID,
      toInt(session && (session.shipID || session.shipid || session.activeShipID), 0),
    ),
  );
  const currentShipItem =
    currentShipID > 0 && deps && typeof deps.findItemById === "function"
      ? deps.findItemById(currentShipID)
      : null;
  if (!characterRecord || currentShipID <= 0 || !currentShipItem) {
    return { committed: false, reason: "CURRENT_CLONE_IDENTITY_UNAVAILABLE" };
  }

  return inspectCloneLocationEvidence(
    ports, pocketState, session, deps, characterRecord, currentShipItem, currentShipID,
  );
}

function inferUnrecordedAbyssalHullLossAfterRestart(
  ports,
  pocketState,
  session = null,
  deps = ports.getDependencies(),
) {
  const { isCapsuleTypeID, resolveAbyssalSceneModeState, ABYSSAL_SCENE_MODE_ISOLATED, isPointWithinPocketRecoveryRadius } = ports;
  if (!pocketState || hasTerminalFailureOutcome(pocketState)) {
    return { inferred: false, reason: "TERMINAL_STATE_ALREADY_RECORDED" };
  }

  const originalShipID = toInt(pocketState.shipID, 0);
  if (
    originalShipID <= 0 ||
    (typeof deps.findItemById === "function" && deps.findItemById(originalShipID))
  ) {
    return { inferred: false, reason: "ORIGINAL_HULL_STILL_PRESENT" };
  }

  const characterID = toInt(pocketState.characterID, 0);
  const characterRecord =
    characterID > 0 && typeof deps.getCharacterRecord === "function"
      ? deps.getCharacterRecord(characterID)
      : null;
  const currentShipID = toInt(
    characterRecord && characterRecord.shipID,
    toInt(session && (session.shipID || session.shipid || session.activeShipID), 0),
  );
  const currentShipItem =
    currentShipID > 0 && typeof deps.findItemById === "function"
      ? deps.findItemById(currentShipID)
      : null;
  if (!currentShipItem || !isCapsuleTypeID(toInt(currentShipItem.typeID, 0))) {
    return { inferred: false, reason: "AUTHORITATIVE_CAPSULE_NOT_FOUND" };
  }

  const runID = toInt(pocketState.instanceID, 0);
  const sceneModeState = resolveAbyssalSceneModeState(pocketState, deps);
  const expectedSceneKey = sceneModeState.sceneMode === ABYSSAL_SCENE_MODE_ISOLATED
    ? `abyssal-run:${runID}`
    : "";
  const itemSceneKey = normalizeText(
    currentShipItem.spaceState && currentShipItem.spaceState.sceneKey ||
      currentShipItem.sceneKey,
    "",
  );
  const sessionSceneKey = normalizeText(
    session && session._space && session._space.sceneKey ||
      session && session.spaceSceneKey,
    "",
  );
  const exactIsolatedRunEvidence = Boolean(
    expectedSceneKey &&
    (itemSceneKey === expectedSceneKey || sessionSceneKey === expectedSceneKey)
  );
  const exactLegacyPocketEvidence = Boolean(
    sceneModeState.sceneMode !== ABYSSAL_SCENE_MODE_ISOLATED &&
    isPointWithinPocketRecoveryRadius(currentShipItem.spaceState, pocketState)
  );
  if (!exactIsolatedRunEvidence && !exactLegacyPocketEvidence) {
    return { inferred: false, reason: "CAPSULE_NOT_IN_EXACT_RUN" };
  }

  // Participant destruction is now durable-before-side-effect. A live capsule
  // and a missing original hull are not enough to invent terminal intent after
  // restart. Without a committed terminal outcome or destruction operation the
  // run remains nonterminal and is eligible for administrative safe return.
  return {
    inferred: false,
    reason: "NO_DURABLE_HULL_LOSS_INTENT",
    originalShipID,
    currentShipID,
    exactSceneKey: expectedSceneKey || null,
  };
}

function reconcileCommittedAbyssalParticipantDeath(
  ports,
  pocketState,
  session = null,
  deps = ports.getDependencies(),
) {
  const { getAbyssalParticipantDestructionOperationsByCharacterID, completeDurableAbyssalTimeoutParticipants, getActivePocketStateByInstanceID, log, getAbyssalTimeoutState, updatePocketState, completeAbyssalParticipantPodDestructionAndCleanup } = ports;
  const instanceID = toInt(pocketState && pocketState.instanceID, 0);
  const participantOperations =
    getAbyssalParticipantDestructionOperationsByCharacterID(pocketState);
  if (
    hasFailedTimeoutOutcome(pocketState) &&
    Object.keys(participantOperations).length > 0
  ) {
    const completionResult = completeDurableAbyssalTimeoutParticipants(
      pocketState,
      deps && typeof deps.now === "function" ? deps.now() : Date.now(),
      deps,
      session,
      { emitNotifications: false },
    );
    const completed = !getActivePocketStateByInstanceID(instanceID);
    log.info(
      `[AbyssalDeathRecovery] run=${instanceID} ` +
        `character=${toInt(pocketState && pocketState.characterID, 0)} ` +
        `participantOperations=${Object.keys(participantOperations).length} ` +
        `state=${completed ? "completed" : "participant-retry"} ` +
        `reason=DURABLE_PARTICIPANT_TIMEOUT_OPERATIONS`,
    );
    return {
      reconciled: true,
      completed,
      evidence: {
        committed: true,
        reason: "DURABLE_PARTICIPANT_TIMEOUT_OPERATIONS",
      },
      completionResult,
    };
  }
  const evidence = inspectCommittedAbyssalParticipantDeathHandoff(
    ports, pocketState,
    session,
    deps,
  );
  if (!evidence.committed) {
    return {
      reconciled: false,
      completed: false,
      evidence,
    };
  }

  const lethalTimeout = hasFailedTimeoutOutcome(pocketState);
  const phasePrefix = lethalTimeout
    ? "failed_timeout_lethal"
    : "failed_ship_destroyed";
  const timeoutState = {
    ...getAbyssalTimeoutState(pocketState, deps),
    shipDestroyed: true,
    // The clone handoff proves the pod is gone, but cleanup must wait until an
    // exact durable destruction receipt is committed below.
    podDestroyed: false,
    cleanupTriggered: false,
    reason: lethalTimeout
      ? "LETHAL_TIMEOUT_PENDING_DURABLE_POD_RECEIPT"
      : "ABYSSAL_PARTICIPANT_DESTRUCTION_PENDING_DURABLE_POD_RECEIPT",
    podDestructionReason: "AUTHORITATIVE_CLONE_HANDOFF_PENDING_DURABLE_RECEIPT",
  };
  const markedPocketState = updatePocketState(instanceID, {
    allowDebugExit: false,
    timerFailureState: `${phasePrefix}_pod_receipt_retry`,
    timeoutState,
  }) || pocketState;
  const completionResult = completeAbyssalParticipantPodDestructionAndCleanup(
    markedPocketState,
    session,
    deps,
    {
      lethalTimeout,
      cleanupReason: lethalTimeout
        ? "abyssal-timeout-lethal"
        : "abyssal-combat-destruction",
      nowMs: deps && typeof deps.now === "function" ? deps.now() : Date.now(),
      emitNotifications: false,
      podAlreadyDestroyed: true,
      authoritativeDeathHandoff: evidence,
      receiptSource: "startup-authoritative-clone-handoff",
    },
  );
  const completed = !getActivePocketStateByInstanceID(instanceID);
  log.info(
    `[AbyssalDeathRecovery] run=${instanceID} ` +
      `character=${toInt(pocketState && pocketState.characterID, 0)} ` +
      `originalShip=${toInt(pocketState && pocketState.shipID, 0)} ` +
      `currentShip=${toInt(evidence.currentShipID, 0)} ` +
      `state=${completed ? "completed" : "cleanup-pending"} ` +
      `reason=${evidence.reason}`,
  );
  return {
    reconciled: true,
    completed,
    evidence,
    completionResult,
  };
}

function inspectCloneLocationEvidence(
  ports, pocketState, session, deps, characterRecord, currentShipItem, currentShipID,
) {
  const { resolveAbyssalSceneModeState, ABYSSAL_SCENE_MODE_ISOLATED, listUniquePositiveInts, isCapsuleTypeID } = ports;
  const runID = toInt(pocketState && pocketState.instanceID, 0);
  const sceneModeState = resolveAbyssalSceneModeState(pocketState, deps);
  const expectedSceneKey = sceneModeState.sceneMode === ABYSSAL_SCENE_MODE_ISOLATED
    ? `abyssal-run:${runID}`
    : "";
  const hostLocationIDs = new Set(listUniquePositiveInts([
    pocketState && pocketState.abyssalLocationID,
    pocketState && pocketState.solarSystemID,
    pocketState && pocketState.instance && pocketState.instance.solarSystemID,
  ]));
  const characterSystemID = toInt(
    characterRecord.solarSystemID || characterRecord.solarsystemid2 || characterRecord.solarsystemid,
    0,
  );
  const characterDocked = Boolean(
    toInt(characterRecord.stationID || characterRecord.stationid, 0) > 0 ||
    toInt(characterRecord.structureID || characterRecord.structureid, 0) > 0
  );
  const itemSystemID = toInt(
    currentShipItem.spaceState && currentShipItem.spaceState.systemID,
    0,
  );
  const itemLocationID = toInt(currentShipItem.locationID, 0);
  const itemSceneKey = normalizeText(
    currentShipItem.spaceState && currentShipItem.spaceState.sceneKey || currentShipItem.sceneKey,
    "",
  );
  const sessionSceneKey = normalizeText(
    session && session._space && session._space.sceneKey,
    normalizeText(session && session.spaceSceneKey, ""),
  );
  const sessionSystemID = toInt(session && session._space && session._space.systemID, 0);
  const currentShipIsCapsule = isCapsuleTypeID(toInt(currentShipItem.typeID, 0));
  const exactRunSceneObserved = Boolean(
    expectedSceneKey &&
    (
      itemSceneKey === expectedSceneKey ||
      sessionSceneKey === expectedSceneKey
    )
  );
  const currentShipAtRunHost = Boolean(
    hostLocationIDs.has(itemSystemID) ||
    hostLocationIDs.has(itemLocationID) ||
    hostLocationIDs.has(sessionSystemID)
  );
  if (currentShipIsCapsule && (exactRunSceneObserved || currentShipAtRunHost)) {
    return {
      committed: false,
      reason: "LIVE_CAPSULE_REMAINS_IN_RUN",
      currentShipID,
    };
  }

  const characterOutsideRun = Boolean(
    characterDocked ||
    (characterSystemID > 0 && !hostLocationIDs.has(characterSystemID))
  );
  const currentShipOutsideRun = Boolean(
    (
      itemSceneKey &&
      expectedSceneKey &&
      itemSceneKey !== expectedSceneKey
    ) ||
    (itemSystemID > 0 && !hostLocationIDs.has(itemSystemID)) ||
    (itemLocationID > 0 && !hostLocationIDs.has(itemLocationID)) ||
    (
      sessionSceneKey &&
      expectedSceneKey &&
      sessionSceneKey !== expectedSceneKey
    ) ||
    (sessionSystemID > 0 && !hostLocationIDs.has(sessionSystemID))
  );
  if (!characterOutsideRun || !currentShipOutsideRun) {
    return {
      committed: false,
      reason: "CLONE_HANDOFF_NOT_AUTHORITATIVE",
      currentShipID,
    };
  }

  return {
    committed: true,
    reason: "CLONE_HANDOFF_COMMITTED_OUTSIDE_RUN",
    currentShipID,
    characterSystemID,
    itemSystemID,
    itemLocationID,
  };
}

function createAbyssalDeathRecovery(ports) {
  return {
    inspectCommittedAbyssalParticipantDeathHandoff: inspectCommittedAbyssalParticipantDeathHandoff.bind(null, ports),
    inferUnrecordedAbyssalHullLossAfterRestart: inferUnrecordedAbyssalHullLossAfterRestart.bind(null, ports),
    reconcileCommittedAbyssalParticipantDeath: reconcileCommittedAbyssalParticipantDeath.bind(null, ports),
  };
}

module.exports = { createAbyssalDeathRecovery };
