"use strict";

const { normalizeText } = require("../domain/abyssalValueUtils");
const {
  ABYSSAL_RUN_OUTCOME, ABYSSAL_TERMINAL_TRANSITION_ACTION,
  ABYSSAL_PARTICIPANT_TERMINAL_CAUSE,
  ABYSSAL_PARTICIPANT_DESTRUCTION_OPERATION_STATUS,
  ABYSSAL_PARTICIPANT_DESTRUCTION_STATUS_RANK,
  evaluateAbyssalParticipantDestructionTransition, hasFailedTimeoutOutcome,
} = require("../domain/abyssalTerminalTransitionPolicy");

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function handleAbyssalSessionShipDestroyed(ports, session, options = {}, deps = ports.getDependencies()) {
  const {
    getActivePocketStateForSession,
    getActivePocketStateForCharacterID,
    getCharacterID,
    evaluateAbyssalDirectCallbackTerminalGuard,
    buildAbyssalDirectCallbackSuppressedResult,
  } = ports;
  const pocketState = getActivePocketStateForSession(session) ||
    getActivePocketStateForCharacterID(getCharacterID(session));

  if (!pocketState) {
    return {
      success: true,
      active: false,
    };
  }

  const terminalGuard = evaluateAbyssalDirectCallbackTerminalGuard(
    pocketState,
    "session-ship-destroyed",
    {
      allowedTerminalOutcomes: [
        ABYSSAL_RUN_OUTCOME.FAILED_TIMEOUT,
        ABYSSAL_RUN_OUTCOME.FAILED_SHIP_DESTROYED,
      ],
      allowPendingTerminalCleanup: true,
      allowDetachedGameplayAuthority: true,
    },
  );

  if (terminalGuard.blocked) {
    return buildAbyssalDirectCallbackSuppressedResult(terminalGuard, {
      handled: true,
      extra: {
        active: false,
        cleanupDeferred: false,
      },
    });
  }
  const context = { pocketState, session, options, deps };
  for (const step of [
    continueInCapsuleAfterHullLoss,
    settleSurvivingGroupMember,
    cancelDestroyedPendingEntry,
    markDestroyedRunPendingSettlement,
    resolveCallbackCapsuleAuthority,
    executeDestroyedParticipant,
  ]) {
    const result = step(ports, context);
    if (result) return result;
  }
  return settleDestroyedRun(ports, context);
}

// Retail: losing the hull inside a run does not end the run. The pilot goes on
// in the capsule until the timer collapses the pocket, the capsule is destroyed
// or the pilot takes the exit; the run and its timer are untouched. Only a hull
// loss that left no capsule in the run, one during a pending entry, or one the
// timer already owns goes on to the destruction settlement below.
function continueInCapsuleAfterHullLoss(ports, context) {
  const {
    getCharacterID,
    getAbyssalParticipantRecord,
    getPendingAbyssalTransitionState,
    upsertAbyssalParticipantRosterEntry,
    commitPocketStateDurably,
    buildPlaceholderRoomState,
    buildAbyssalParticipantRoomScopeMetadata,
    applyAbyssalParticipantRoomScopeMetadata,
    ABYSSAL_PARTICIPANT_STATUS,
    log,
  } = ports;
  const { pocketState, session, options, deps } = context;
  if (options.destroyedCapsule === true || hasFailedTimeoutOutcome(pocketState)) return null;
  const capsuleID = toInt(
    options.destructionResult && options.destructionResult.data &&
      options.destructionResult.data.capsule &&
      options.destructionResult.data.capsule.itemID,
    0,
  );
  if (capsuleID <= 0) return null;
  const pendingTransition = getPendingAbyssalTransitionState(pocketState);
  if (
    pendingTransition &&
    pendingTransition.status === "pending" &&
    pendingTransition.phase === "entry"
  ) {
    return null;
  }
  const characterID = getCharacterID(session);
  const participant = getAbyssalParticipantRecord(pocketState, characterID);
  if (
    !participant ||
    ![
      ABYSSAL_PARTICIPANT_STATUS.ACTIVE,
      ABYSSAL_PARTICIPANT_STATUS.DISCONNECTED,
    ].includes(participant.status)
  ) {
    return null;
  }
  if (!authorizeExactAbyssalCapsuleSessionFromDestructionResult(
    ports, pocketState, session, options.destructionResult || null, deps,
  )) {
    return null;
  }
  const lostHullID = toInt(
    options.destructionResult.data.destroyedShipID,
    toInt(participant.shipID, 0),
  );
  const capsuleItem = typeof deps.findItemById === "function"
    ? deps.findItemById(capsuleID)
    : null;
  const instanceID = toInt(pocketState.instanceID, 0);
  const commit = commitPocketStateDurably(instanceID, (currentState) => ({
    ...(toInt(currentState.shipID, 0) === lostHullID ? { shipID: capsuleID } : {}),
    participantRoster: upsertAbyssalParticipantRosterEntry(currentState, {
      characterID,
      shipID: capsuleID,
      shipTypeID: toInt(capsuleItem && capsuleItem.typeID, 0),
      lastSeenAtMs: toInt(deps.now(), Date.now()),
    }),
  }), deps, { verifyReadBack: true, forceWrite: true });
  if (!commit || commit.success !== true) {
    log.warn(
      `[AbyssalRoster] capsule continuation not committed run=${instanceID} ` +
        `character=${characterID} capsule=${capsuleID} ` +
        `reason=${normalizeText(commit && commit.errorMsg, "UNKNOWN")}`,
    );
    return null;
  }
  // The capsule entity carries the run and room scope the hull carried, so the
  // survivor selection, the boundary and the NPCs treat it as the participant.
  const scene = typeof deps.getSceneForSession === "function"
    ? deps.getSceneForSession(session)
    : null;
  const capsuleEntity = scene && typeof scene.getEntityByID === "function"
    ? scene.getEntityByID(capsuleID)
    : null;
  if (capsuleEntity) {
    applyAbyssalParticipantRoomScopeMetadata(
      capsuleEntity,
      buildAbyssalParticipantRoomScopeMetadata(
        pocketState,
        toInt(buildPlaceholderRoomState(pocketState).currentRoomIndex, 0),
      ),
    );
    // The eject path marks the pod's dungeon tracker instance invalid because
    // the pod arrives before it carries the exact room scope. With the scope in
    // place the pod is in this run's instance, as the hull was, and can reach
    // the run's conduits and be reached by its NPCs.
    capsuleEntity.dungeonCurrentInstanceID = instanceID;
  }
  log.info(
    `[AbyssalRoster] hull lost, pilot continues in the capsule run=${instanceID} ` +
      `character=${characterID} hull=${lostHullID} capsule=${capsuleID}`,
  );
  return {
    success: true,
    active: true,
    continuesInCapsule: true,
    capsuleID,
    lostHullID,
    pocketState: commit.committedState || commit.pocketState || pocketState,
  };
}

function settleSurvivingGroupMember(ports, context) {
  const {
    getCharacterID,
    getAbyssalParticipantRecord,
    normalizeAbyssalParticipantRoster,
    ABYSSAL_PARTICIPANT_STATUS,
    completeDurableAbyssalParticipantDestruction,
    clearAbyssalSessionState,
    log,
  } = ports;
  const { pocketState, session, options, deps } = context;
  const destroyedCharacterID = getCharacterID(session);

  const destroyedParticipant = getAbyssalParticipantRecord(
    pocketState,
    destroyedCharacterID,
  );

  const survivingParticipants = normalizeAbyssalParticipantRoster(pocketState)
    .filter((participant) =>
      participant.characterID !== destroyedCharacterID &&
      [
        ABYSSAL_PARTICIPANT_STATUS.ACTIVE,
        ABYSSAL_PARTICIPANT_STATUS.DISCONNECTED,
        ABYSSAL_PARTICIPANT_STATUS.ADMITTING,
      ].includes(participant.status)
    );

  const participantDestructionDecision =
    evaluateAbyssalParticipantDestructionTransition({
      currentOutcome: pocketState.runOutcome,
      participantPresent: Boolean(destroyedParticipant),
      survivorsRemain: survivingParticipants.length > 0,
      timeoutCommitted: hasFailedTimeoutOutcome(pocketState),
      destructionKind: options.destroyedCapsule === true ? "pod" : "ship",
    });

  if (
    participantDestructionDecision.action ===
      ABYSSAL_TERMINAL_TRANSITION_ACTION.SETTLE_PARTICIPANT_DESTRUCTION
  ) {
    let callbackCapsuleID = 0;
    if (options.destroyedCapsule !== true) {
      callbackCapsuleID = toInt(
        options.destructionResult && options.destructionResult.data &&
          options.destructionResult.data.capsule &&
          options.destructionResult.data.capsule.itemID,
        0,
      );
      authorizeExactAbyssalCapsuleSessionFromDestructionResult(
    ports, pocketState,
        session,
        options.destructionResult || null,
        deps,
      );
    }
    const durableDestruction = completeDurableAbyssalParticipantDestruction(
      pocketState,
      destroyedParticipant,
      session,
      deps,
      {
        terminalCause: ABYSSAL_PARTICIPANT_TERMINAL_CAUSE.MEMBER_SHIP_DESTROYED,
        nowMs: toInt(deps.now(), Date.now()),
        intentSource: "combat-participant-destruction",
        sessionChangeReason: "abyssal-combat-destruction",
        destructionReason: normalizeText(
          options.reason,
          "abyssal-combat-destruction",
        ),
        hullAlreadyDestroyed: true,
        hullDestructionResult: options.destroyedCapsule === true
          ? null
          : options.destructionResult || null,
        destroyedCapsuleID: options.destroyedCapsule === true
          ? toInt(
              options.destructionResult && options.destructionResult.data &&
                options.destructionResult.data.destroyedShipID,
              0,
            )
          : callbackCapsuleID,
        podAlreadyDestroyed: options.destroyedCapsule === true,
        podDestructionResult: options.destroyedCapsule === true
          ? options.destructionResult || null
          : null,
        receiptSource: options.destroyedCapsule === true
          ? "external-pod-destruction-callback"
          : "destroySessionShip",
        emitNotifications: options.emitNotifications !== false,
      },
    );
    if (durableDestruction.terminal === true) clearAbyssalSessionState(session);
    log.info(
      `[AbyssalRoster] participant destroyed character=${destroyedCharacterID} ` +
        `ship=${destroyedParticipant.shipID} run=${pocketState.instanceID} ` +
        `survivors=${survivingParticipants.length} ` +
        `terminal=${durableDestruction.terminal === true} ` +
        `pending=${durableDestruction.pending === true}`,
    );
    return {
      success: true,
      active: true,
      groupRunContinues: true,
      participantDestroyed: durableDestruction.terminal === true,
      cleanupDeferred: durableDestruction.pending === true,
      destructionResult: durableDestruction,
      pocketState: durableDestruction.pocketState || pocketState,
    };
  }
  Object.assign(context, { destroyedCharacterID, destroyedParticipant });
  return null;
}

function cancelDestroyedPendingEntry(ports, context) {
  const {
    clearAbyssalSessionState,
    getPendingAbyssalTransitionState,
    cancelPendingAbyssalTransition,
    purgePlaceholderPocket,
  } = ports;
  const { pocketState, session, options, deps } = context;
  const pendingTransitionState = getPendingAbyssalTransitionState(pocketState);

  if (
    pendingTransitionState &&
    pendingTransitionState.status === "pending" &&
    pendingTransitionState.phase === "entry"
  ) {
    cancelPendingAbyssalTransition(pocketState.instanceID, deps, normalizeText(options.reason, "ship-destroyed"));
    purgePlaceholderPocket(pocketState.instanceID, deps, "pending-entry-ship-destroyed");
    clearAbyssalSessionState(session);
    return {
      success: true,
      active: false,
      cleanupResult: {
        success: true,
        pendingEntryCancelled: true,
        purged: true,
      },
    };
  }
  Object.assign(context, {  });
  return null;
}

function markDestroyedRunPendingSettlement(ports, context) {
  const {
    cancelPendingAbyssalTransition,
    getAbyssalTimeoutState,
    ABYSSAL_TIMEOUT_MODE,
    updatePocketState,
    ABYSSAL_TIMEOUT_POD_STATUS,
    recordAbyssalRunOutcome,
  } = ports;
  const { pocketState, options, deps } = context;
  const timeoutState = getAbyssalTimeoutState(pocketState, deps);

  const destroyedCapsule = options.destroyedCapsule === true;

  const lethalTimeoutDestruction = hasFailedTimeoutOutcome(pocketState) &&
    timeoutState.mode === ABYSSAL_TIMEOUT_MODE.LETHAL;

  const cleanupReason = lethalTimeoutDestruction
    ? "abyssal-timeout-lethal"
    : normalizeText(options.reason, "abyssal-combat-destruction");

  cancelPendingAbyssalTransition(pocketState.instanceID, deps, cleanupReason);

  let updatedPocketState = updatePocketState(pocketState.instanceID, {
    failedAtMs: deps.now(),
    failureReason: lethalTimeoutDestruction ? "timer_expired_ship_destroyed" : "ship_destroyed",
    allowDebugExit: false,
    timerFailureState: destroyedCapsule
      ? lethalTimeoutDestruction
        ? "failed_timeout_lethal_pod_receipt_retry"
        : "failed_ship_destroyed_pod_receipt_retry"
      : lethalTimeoutDestruction
        ? "failed_timeout_lethal_pod_pending"
        : "failed_ship_destroyed_pod_pending",
    timeoutState: {
      ...timeoutState,
      shipDestroyed: true,
      // A destruction callback is evidence, not the durable receipt. The
      // completion coordinator below commits the exact operation receipt before
      // cleanup can run.
      podDestroyed: timeoutState.podDestroyed === true,
      cleanupTriggered: false,
      reason: destroyedCapsule
        ? lethalTimeoutDestruction
          ? "LETHAL_TIMEOUT_PENDING_DURABLE_POD_RECEIPT"
          : "ABYSSAL_PARTICIPANT_DESTRUCTION_PENDING_DURABLE_POD_RECEIPT"
        : lethalTimeoutDestruction
          ? "LETHAL_TIMEOUT_PENDING_POD_DESTRUCTION"
          : "ABYSSAL_PARTICIPANT_DESTRUCTION_PENDING_POD",
      podDestructionReason: destroyedCapsule
        ? "POD_DESTRUCTION_CALLBACK_PENDING_DURABLE_RECEIPT"
        : normalizeText(
            timeoutState.podDestructionReason,
            ABYSSAL_TIMEOUT_POD_STATUS.NO_SAFE_HOOK,
          ),
    },
  }) || pocketState;

  if (lethalTimeoutDestruction && !destroyedCapsule) {
    return {
      success: true,
      active: true,
      cleanupDeferred: true,
      pocketState: updatedPocketState,
    };
  }

  if (!lethalTimeoutDestruction) {
    updatedPocketState = recordAbyssalRunOutcome(
      updatedPocketState,
      "failed_ship_destroyed",
      deps,
      {
        reason: cleanupReason,
      },
    ) || updatedPocketState;
  }
  Object.assign(context, { destroyedCapsule, lethalTimeoutDestruction, cleanupReason, updatedPocketState });
  return null;
}

function resolveCallbackCapsuleAuthority(ports, context) {
  const {
    buildPlaceholderRoomState,
  } = ports;
  const { destroyedCapsule, options, updatedPocketState, session, deps } = context;
  let preferredSessionAuthority = null;

  if (!destroyedCapsule) {
    const callbackCapsuleID = toInt(
      options.destructionResult &&
        options.destructionResult.data &&
        options.destructionResult.data.capsule &&
        options.destructionResult.data.capsule.itemID,
      0,
    );
    const exactCapsuleAuthorized =
      authorizeExactAbyssalCapsuleSessionFromDestructionResult(
    ports, updatedPocketState,
        session,
        options.destructionResult || null,
        deps,
      );
    if (exactCapsuleAuthorized && callbackCapsuleID > 0) {
      preferredSessionAuthority = {
        runID: toInt(updatedPocketState.instanceID, 0),
        characterID: toInt(updatedPocketState.characterID, 0),
        roomIndex: toInt(
          buildPlaceholderRoomState(updatedPocketState).currentRoomIndex,
          0,
        ),
        capsuleID: callbackCapsuleID,
      };
    }
  }

  const destroyedCapsuleID = destroyedCapsule
    ? toInt(
        options.destructionResult &&
          options.destructionResult.data &&
          options.destructionResult.data.destroyedShipID,
        0,
      )
    : toInt(
        options.destructionResult &&
          options.destructionResult.data &&
          options.destructionResult.data.capsule &&
          options.destructionResult.data.capsule.itemID,
        0,
      );
  Object.assign(context, { preferredSessionAuthority, destroyedCapsuleID });
  return null;
}

function executeDestroyedParticipant(ports, context) {
  const {
    completeDurableAbyssalParticipantDestruction,
    getAbyssalTimeoutState,
    getAbyssalParticipantDestructionOperation,
    commitPocketStateDurably,
    cloneValue,
  } = ports;
  const { destroyedParticipant, session, deps, lethalTimeoutDestruction, destroyedCapsule, cleanupReason, options, destroyedCapsuleID, preferredSessionAuthority, destroyedCharacterID } = context;
  let { updatedPocketState } = context;
  const durableDestruction = destroyedParticipant
    ? completeDurableAbyssalParticipantDestruction(
        updatedPocketState,
        destroyedParticipant,
        session,
        deps,
        {
          terminalCause: lethalTimeoutDestruction
            ? ABYSSAL_PARTICIPANT_TERMINAL_CAUSE.RUN_TIMEOUT
            : ABYSSAL_PARTICIPANT_TERMINAL_CAUSE.RUN_SHIP_DESTROYED,
          nowMs: toInt(deps.now(), Date.now()),
          intentSource: destroyedCapsule
            ? "external-pod-destruction-callback"
            : "combat-participant-destruction",
          sessionChangeReason: lethalTimeoutDestruction
            ? "abyssal-timeout"
            : "abyssal-combat-destruction",
          destructionReason: cleanupReason,
          hullAlreadyDestroyed: true,
          hullDestructionResult: destroyedCapsule
            ? null
            : options.destructionResult || null,
          destroyedCapsuleID,
          podAlreadyDestroyed: destroyedCapsule,
          podDestructionResult: destroyedCapsule
            ? options.destructionResult || null
            : null,
          receiptSource: destroyedCapsule
            ? "external-pod-destruction-callback"
            : "destroySessionShip",
          preferredSessionAuthority,
          emitNotifications: options.emitNotifications !== false,
        },
      )
    : null;

  if (durableDestruction && durableDestruction.pocketState) {
    updatedPocketState = durableDestruction.pocketState;
  }

  if (
    durableDestruction &&
    durableDestruction.pending === true &&
    !lethalTimeoutDestruction
  ) {
    const pendingOperation = durableDestruction.operation ||
      getAbyssalParticipantDestructionOperation(
        updatedPocketState,
        destroyedCharacterID,
      );
    const pendingFailureState = pendingOperation &&
      pendingOperation.status ===
        ABYSSAL_PARTICIPANT_DESTRUCTION_OPERATION_STATUS.HULL_INTENT_COMMITTED
      ? "failed_ship_destroyed_destroy_retry"
      : "failed_ship_destroyed_pod_retry";
    const pendingCommit = commitPocketStateDurably(
      toInt(updatedPocketState.instanceID, 0),
      {
        timerFailureState: pendingFailureState,
        timeoutState: {
          ...getAbyssalTimeoutState(updatedPocketState, deps),
          shipDestroyed: Boolean(
            pendingOperation &&
            toInt(
              ABYSSAL_PARTICIPANT_DESTRUCTION_STATUS_RANK[
                pendingOperation.status
              ],
              0,
            ) >= ABYSSAL_PARTICIPANT_DESTRUCTION_STATUS_RANK[
              ABYSSAL_PARTICIPANT_DESTRUCTION_OPERATION_STATUS.HULL_DESTROYED
            ],
          ),
          podDestroyed: false,
          cleanupTriggered: false,
          reason: normalizeText(
            durableDestruction.errorMsg,
            "ABYSSAL_PARTICIPANT_DESTRUCTION_PENDING",
          ),
        },
      },
      deps,
      { verifyReadBack: true, forceWrite: true },
    );
    if (pendingCommit && pendingCommit.success === true) {
      updatedPocketState = cloneValue(
        pendingCommit.committedState || pendingCommit.state,
      );
      durableDestruction.pocketState = updatedPocketState;
    }
  }
  Object.assign(context, { updatedPocketState, durableDestruction });
  return null;
}

function settleDestroyedRun(ports, context) {
  const {
    getCharacterID,
    log,
    completeAbyssalParticipantPodDestructionAndCleanup,
  } = ports;
  const { durableDestruction, updatedPocketState, session, deps, lethalTimeoutDestruction, cleanupReason, destroyedCapsuleID, destroyedCapsule, options, preferredSessionAuthority, pocketState } = context;
  const completionResult = durableDestruction && durableDestruction.terminal === true
    ? completeAbyssalParticipantPodDestructionAndCleanup(
        updatedPocketState,
        session,
        deps,
        {
          lethalTimeout: lethalTimeoutDestruction,
          cleanupReason,
          nowMs: deps.now(),
          podAlreadyDestroyed: true,
          destroyedCapsuleID,
          podDestructionResult: destroyedCapsule
            ? options.destructionResult || null
            : durableDestruction.podDestructionResult || null,
          receiptSource: destroyedCapsule
            ? "external-pod-destruction-callback"
            : "destroySessionShip",
          preferredSessionAuthority,
        },
      )
    : durableDestruction || completeAbyssalParticipantPodDestructionAndCleanup(
        updatedPocketState,
        session,
        deps,
        {
          lethalTimeout: lethalTimeoutDestruction,
          cleanupReason,
          nowMs: deps.now(),
          shipDestroyResult: destroyedCapsule
            ? null
            : options.destructionResult || null,
          podDestructionResult: destroyedCapsule
            ? options.destructionResult || null
            : null,
          podAlreadyDestroyed: destroyedCapsule,
          destroyedCapsuleID,
          receiptSource: destroyedCapsule
            ? "external-pod-destruction-callback"
            : "destroySessionShip",
          preferredSessionAuthority,
        },
      );

  const cleanupResult = completionResult && completionResult.cleanupResult;

  log.info(
    `[AbyssalMgr] Ship destruction terminal handling ` +
      `char=${getCharacterID(session)} instance=${pocketState.instanceID} ` +
      `trace=${pocketState.traceItemID} podDestroyed=${Boolean(
        completionResult &&
        completionResult.data &&
        completionResult.data.podDestroyed,
      )} cleanupComplete=${Boolean(
        completionResult &&
        completionResult.data &&
        completionResult.data.cleanupTriggered,
      )}`,
  );

  return {
    success: true,
    active: true,
    cleanupDeferred: Boolean(completionResult && completionResult.pending),
    cleanupResult: cleanupResult || null,
    destructionResult: completionResult,
  };
}

function authorizeExactAbyssalCapsuleSessionFromDestructionResult(
  ports,
  pocketState,
  session,
  destructionResult,
  deps = ports.getDependencies(),
) {
  const {
    getCharacterID,
    getAbyssalParticipantRecord,
    buildPlaceholderRoomState,
    isCapsuleTypeID,
    buildAbyssalParticipantRoomScopeMetadata,
    applyAbyssalParticipantRoomScopeMetadata,
  } = ports;

  const runID = toInt(pocketState && pocketState.instanceID, 0);
  const characterID = getCharacterID(session);
  const participant = getAbyssalParticipantRecord(pocketState, characterID);
  const roomIndex = toInt(
    buildPlaceholderRoomState(pocketState).currentRoomIndex,
    0,
  );
  const capsuleID = toInt(
    destructionResult && destructionResult.data &&
      destructionResult.data.capsule &&
      destructionResult.data.capsule.itemID,
    0,
  );
  const activeShipID = toInt(
    session && session._space && session._space.shipID,
    toInt(session && (session.shipID || session.shipid || session.activeShipID), 0),
  );
  const capsuleItem = capsuleID > 0 && deps && typeof deps.findItemById === "function"
    ? deps.findItemById(capsuleID)
    : null;
  if (
    !session ||
    runID <= 0 ||
    roomIndex <= 0 ||
    characterID <= 0 ||
    !participant ||
    getCharacterID(session) !== characterID ||
    capsuleID <= 0 ||
    activeShipID !== capsuleID ||
    !capsuleItem ||
    !isCapsuleTypeID(toInt(capsuleItem.typeID, 0)) ||
    toInt(capsuleItem.ownerID, 0) !== characterID
  ) {
    return false;
  }

  // The ship-destruction callback and exact capsule inventory identity are
  // server-owned evidence. Reapply the run/room aliases and isolated scene to
  // the preferred session before the strict resolver evaluates it. This does
  // not authorize a replacement ship: the active ship must be the exact
  // callback capsule and must still be owned by the participant.
  const metadata = buildAbyssalParticipantRoomScopeMetadata(
    pocketState,
    roomIndex,
  );
  const exactSceneKey = `abyssal-run:${runID}`;
  for (const target of [session, session._space]) {
    if (!target || typeof target !== "object") continue;
    applyAbyssalParticipantRoomScopeMetadata(target, metadata);
    target.shipID = capsuleID;
    target.shipid = capsuleID;
    target.activeShipID = capsuleID;
  }
  session.spaceSceneKey = exactSceneKey;
  if (session._space && typeof session._space === "object") {
    session._space.sceneKey = exactSceneKey;
  }
  return true;
}

function createAbyssalDestructionCallback(ports) {
  return {
    handleAbyssalSessionShipDestroyed: handleAbyssalSessionShipDestroyed.bind(null, ports),
    authorizeExactAbyssalCapsuleSessionFromDestructionResult: authorizeExactAbyssalCapsuleSessionFromDestructionResult.bind(null, ports),
  };
}

module.exports = { createAbyssalDestructionCallback };
