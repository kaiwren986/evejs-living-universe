"use strict";

const { normalizeText } = require("../domain/abyssalValueUtils");

// Per-request state belongs to the delayed handoff, never to the shared adapter.
function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function prepareEndGateRequest(ports, args, session) {
  const {
    getDependencies,
    validateAbyssalExitTraceActivation,
    recordAuditEvent,
    log,
    throwCustomNotify,
    throwGateRejected,
    buildRoomLogContext,
    getPendingAbyssalTransitionState,
    normalizeAbyssalParticipantRoster,
    ABYSSAL_PARTICIPANT_STATUS,
    evaluateAbyssalConduitEligibility,
    buildAbyssalRoomObjectivePolicyInput,
    buildAbyssalRoomProgressionPolicyInput,
  } = ports;
  const gateHandlerStartedAtMs = Date.now();
  const deps = getDependencies();
  const validation = validateAbyssalExitTraceActivation(args, session, deps);
  if (!validation.success) {
  recordAuditEvent("abyssal_end_gate_activation_rejected", args, session, {
    errorMsg: validation.errorMsg,
  });
  log.debug(
    `[AbyssalMgr] AbyssalEndGateActivation rejected reason=${validation.errorMsg || "UNKNOWN"}`,
  );
  if (validation.errorMsg === "ABYSSAL_ROOM_OBJECTIVE_INCOMPLETE") {
    throwCustomNotify("Hostiles remain in this Abyssal room. Clear them before using the conduit.");
  }
  if (validation.errorMsg === "ABYSSAL_ROOM_ENVIRONMENTAL_MECHANICS_BLOCKED") {
    throwCustomNotify(
      "Abyssal environmental mechanics are not authoritative yet. Progression is held safely while the room recovers.",
    );
  }
  if (validation.errorMsg === "ABYSSAL_ROOM_PROGRESSION_BLOCKED_TIMEOUT") {
    throwCustomNotify("The Abyssal timer has expired. Progression is blocked; use the conduit to exit.");
  }
  throwGateRejected();
}
  const roomLogContext = buildRoomLogContext(validation.data.pocketState, deps);
  const pendingTransitionState = getPendingAbyssalTransitionState(validation.data.pocketState);
  const admittingParticipants = normalizeAbyssalParticipantRoster(
  validation.data.pocketState,
).filter(
  (participant) =>
    participant.status === ABYSSAL_PARTICIPANT_STATUS.ADMITTING,
);
  if (
  validation.data.activationMode === "transfer" &&
  admittingParticipants.length > 0
) {
  recordAuditEvent("abyssal_end_gate_activation_admission_pending", args, session, {
    instanceID: validation.data.pocketState.instanceID,
    admittingCharacterIDs: admittingParticipants.map(
      (participant) => participant.characterID,
    ),
  });
  log.info(
    `[AbyssalMgr] Transfer conduit held for participant admission ` +
      `char=${roomLogContext.characterID} instance=${validation.data.pocketState.instanceID} ` +
      `admitting=${admittingParticipants.map((participant) =>
        `${participant.characterID}:${participant.shipID}`
      ).join(",")}`,
  );
  throwCustomNotify(
    "A fleet member is entering this Abyssal run. Wait for their entry transition to complete.",
  );
}
  const activationDecision = evaluateAbyssalConduitEligibility({
  conduit: {
    stale: false,
    exitTracePresent: true,
    runtimeReady: true,
  },
  participantAuthorized: true,
  terminal: { blocked: false, reason: "" },
  range: { inRange: true },
  objective: buildAbyssalRoomObjectivePolicyInput(validation.data.pocketState),
  transition: {
    pending: Boolean(
      pendingTransitionState && pendingTransitionState.status === "pending",
    ),
  },
  run: buildAbyssalRoomProgressionPolicyInput(validation.data.pocketState),
});
  if (!activationDecision.allowed && activationDecision.duplicate === true) {
  log.info(
    `[AbyssalMgr] Duplicate end-gate activation ignored char=${roomLogContext.characterID} ` +
      `instance=${validation.data.pocketState.instanceID} phase=${pendingTransitionState.phase}`,
  );
  return null;
}
  if (!activationDecision.allowed) {
  throwGateRejected();
}
  const progression = activationDecision.progression;
  const targetRoomIndex = toInt(progression && progression.toRoomIndex, 0);
  return { args, session, deps, validation, roomLogContext, progression, targetRoomIndex, gateHandlerStartedAtMs };
}

function prepareTransferRequest(ports, request) {
  const {
    log,
    prewarmNextPlaceholderRoomContent,
    rollbackFailedAbyssalDestinationPrewarm,
    throwCustomNotify,
    getPlaceholderRoomEntry,
    throwGateRejected,
    usesIsolatedAbyssalScene,
    buildAbyssalDestinationPreDeliveryReadiness,
  } = ports;
  const { args, session, deps, validation, roomLogContext, progression, targetRoomIndex, gateHandlerStartedAtMs } = request;
  log.info(
    `[AbyssalMgr] Transfer conduit activated char=${roomLogContext.characterID} ` +
      `ship=${roomLogContext.shipID} filament=${roomLogContext.filamentTypeID} ` +
      `name="${roomLogContext.filamentName}" tier=${roomLogContext.tier} weather=${roomLogContext.weather} ` +
      `room=${roomLogContext.roomIndex}/${roomLogContext.totalRooms} roomOrigin=${roomLogContext.roomOrigin} ` +
      `finalShip=${roomLogContext.finalShip} hostileCount=${roomLogContext.hostileCount} ` +
      `cacheID=${roomLogContext.cacheID} conduitID=${roomLogContext.conduitID} ` +
      `timerRemainingMs=${roomLogContext.timerRemainingMs}`,
  );
  log.info(
    `[AbyssalMgr] Transferring to next Abyssal room char=${roomLogContext.characterID} ` +
      `ship=${roomLogContext.shipID} fromRoom=${roomLogContext.roomIndex} toRoom=${targetRoomIndex} ` +
      `roomOrigin=${roomLogContext.roomOrigin} timerRemainingMs=${roomLogContext.timerRemainingMs}`,
  );
  const prewarmStartedAtMs = Date.now();
  const prewarmTransferResult = prewarmNextPlaceholderRoomContent(
    validation.data.pocketState,
    session,
    deps,
  );
  const prewarmDurationMs = Math.max(0, Date.now() - prewarmStartedAtMs);
  const transferPocketState =
    prewarmTransferResult && prewarmTransferResult.data
      ? prewarmTransferResult.data
      : validation.data.pocketState;
  if (
    !prewarmTransferResult ||
    prewarmTransferResult.success !== true ||
    prewarmTransferResult.partial === true ||
    !prewarmTransferResult.data
  ) {
    const prewarmFailureReason = normalizeText(
      prewarmTransferResult && prewarmTransferResult.errorMsg,
      Array.isArray(prewarmTransferResult && prewarmTransferResult.errors)
        ? prewarmTransferResult.errors.join("|")
        : "ABYSSAL_DESTINATION_PREWARM_FAILED",
    );
    rollbackFailedAbyssalDestinationPrewarm(
      transferPocketState,
      targetRoomIndex,
      session,
      deps,
      prewarmFailureReason,
    );
    log.warn(
      `[AbyssalTransfer] destination prewarm failed before handoff ` +
        `instance=${toInt(transferPocketState.instanceID, 0)} ` +
        `fromRoom=${roomLogContext.roomIndex} toRoom=${targetRoomIndex} ` +
        `reason=${prewarmFailureReason}`,
    );
    throwCustomNotify(
      "Abyssal destination preparation failed safely. The current conduit remains available; try again.",
    );
  }
  const destinationConduitID = toInt(
    getPlaceholderRoomEntry(
      transferPocketState,
      targetRoomIndex,
    ).conduitItemID,
    0,
  );
  if (destinationConduitID <= 0) {
    rollbackFailedAbyssalDestinationPrewarm(
      transferPocketState,
      targetRoomIndex,
      session,
      deps,
      "ABYSSAL_DESTINATION_CONDUIT_MISSING",
    );
    log.warn(
      `[AbyssalTransfer] destination conduit unavailable before handoff ` +
        `instance=${toInt(transferPocketState.instanceID, 0)} ` +
        `fromRoom=${roomLogContext.roomIndex} toRoom=${targetRoomIndex}`,
    );
    throwGateRejected();
  }
  if (usesIsolatedAbyssalScene(transferPocketState, deps)) {
    const destinationReadiness = buildAbyssalDestinationPreDeliveryReadiness(
      transferPocketState,
      session,
      roomLogContext.roomIndex,
      targetRoomIndex,
      deps,
    );
    if (!destinationReadiness.ready) {
      const rollbackResult = rollbackFailedAbyssalDestinationPrewarm(
        transferPocketState,
        targetRoomIndex,
        session,
        deps,
        destinationReadiness.errorMsg,
      );
      log.warn(
        `[AbyssalTransfer] destination pre-delivery validation failed ` +
          `instance=${toInt(transferPocketState.instanceID, 0)} ` +
          `fromRoom=${roomLogContext.roomIndex} toRoom=${targetRoomIndex} ` +
          `reason=${normalizeText(destinationReadiness.errorMsg, "ABYSSAL_DESTINATION_PREDELIVERY_NOT_READY")} ` +
          `missingCriticalRuntimeIDs=${destinationReadiness.missingCriticalRuntimeIDs.join(",") || "none"} ` +
          `definitionOnlyIDs=${destinationReadiness.definitionOnlyIDs.join(",") || "none"} ` +
          `unexpectedRequiredIDs=${destinationReadiness.unexpectedRequiredIDs.join(",") || "none"} ` +
          `rollback=${rollbackResult && rollbackResult.success === true ? "complete" : "pending"}`,
      );
      throwCustomNotify(
        "Abyssal destination preparation is incomplete. The current conduit remains available; try again.",
      );
    }
  }
  return { ...request, transferPocketState, destinationConduitID, prewarmDurationMs };
}

function scheduleTransferRequest(ports, request) {
  const {
    usesIsolatedAbyssalScene,
    buildAbyssalSceneDescriptor,
    getSessionContext,
    schedulePendingAbyssalTransition,
    quiesceAbyssalRoomTransferCombat,
    revalidateDelayedAbyssalEndGateHandoff,
    transferShipToNextPlaceholderRoom,
    log,
    recordAuditEvent,
    throwGateRejected,
  } = ports;
  const { args, session, deps, validation, roomLogContext, progression, targetRoomIndex, gateHandlerStartedAtMs } = request;
  const { transferPocketState, destinationConduitID, prewarmDurationMs } = request;
  const transferSceneDescriptor = usesIsolatedAbyssalScene(transferPocketState, deps)
    ? buildAbyssalSceneDescriptor(transferPocketState, deps)
    : null;
  const transferHandoffIdentity = {
    instanceID: toInt(transferPocketState.instanceID, 0),
    characterID: toInt(validation.data.context.characterID, 0),
    shipID: toInt(validation.data.context.shipID, 0),
    systemID: toInt(getSessionContext(session).systemID, 0),
    sceneKey: normalizeText(
      transferSceneDescriptor && transferSceneDescriptor.sceneKey,
      normalizeText(
        session && session._space && session._space.sceneKey,
        normalizeText(session && session.spaceSceneKey, ""),
      ),
    ),
    sourceRoomIndex: toInt(roomLogContext.roomIndex, 0),
    markerItemID: toInt(roomLogContext.conduitID, 0),
    activationMode: "transfer",
  };
  const transferTransitionResult = schedulePendingAbyssalTransition(
    transferPocketState,
    session,
    deps,
    {
      phase: "transfer",
      activationMode: "transfer",
      sourceRoomIndex: roomLogContext.roomIndex,
      targetRoomIndex,
      transitionFxOptions: {
        targetID: roomLogContext.conduitID,
        destinationConduitID,
      },
      afterTransitionFxSent: (activePocketState) => {
        const quiesceResult = quiesceAbyssalRoomTransferCombat(
          activePocketState,
          session,
          deps,
        );
        if (quiesceResult && quiesceResult.success === false) {
          return quiesceResult;
        }
        return quiesceResult || { success: true };
      },
      revalidateTransition: (activePocketState) =>
        revalidateDelayedAbyssalEndGateHandoff(
          args,
          session,
          activePocketState,
          transferHandoffIdentity,
          deps,
        ),
      executeTransition: (activePocketState, handoffValidation) => {
        const executeStartedAtMs = Date.now();
        const freshValidation = handoffValidation && handoffValidation.data
          ? handoffValidation
          : validation;
        const transferValidation = {
          ...freshValidation,
          data: {
            ...freshValidation.data,
            pocketState: activePocketState,
          },
        };
        const transferResult = transferShipToNextPlaceholderRoom(transferValidation, session, deps);
        log.info(
          `[AbyssalGatePerf] run=${toInt(activePocketState.instanceID, 0)} ` +
            `fromRoom=${roomLogContext.roomIndex} toRoom=${targetRoomIndex} ` +
            `phase=handoff durationMs=${Math.max(0, Date.now() - executeStartedAtMs)} ` +
            `success=${transferResult && transferResult.success === true}`,
        );
        if (!transferResult.success) {
          const npcActivationFailure = normalizeText(transferResult.errorMsg, "")
            .startsWith("ABYSSAL_NPC_");
          recordAuditEvent(
            npcActivationFailure
              ? "abyssal_room_npc_activation_failed"
              : "abyssal_end_gate_activation_failed",
            args,
            session,
            {
            instanceID: activePocketState.instanceID,
            errorMsg: transferResult.errorMsg,
            activationMode: "transfer",
            },
          );
          if (npcActivationFailure) {
            log.warn(
              `[AbyssalNpcActivation] room activation failed ` +
                `char=${validation.data.context.characterID} instance=${activePocketState.instanceID} ` +
                `reason=${transferResult.errorMsg || "UNKNOWN"}`,
            );
          } else {
            log.warn(
              `[AbyssalMgr] AbyssalEndGateActivation failed char=${validation.data.context.characterID} ` +
                `instance=${activePocketState.instanceID} reason=${transferResult.errorMsg || "UNKNOWN"}`,
            );
          }
          return transferResult;
        }
        recordAuditEvent("abyssal_end_gate_activation_complete", args, session, {
          instanceID: activePocketState.instanceID,
          traceItemID: activePocketState.traceItemID,
          transitionMode: transferResult.data.transitionMode,
          activationMode: "transfer",
          nextRoomIndex: transferResult.data.nextRoomIndex,
        });
        return transferResult;
      },
    },
  );
  if (
    transferTransitionResult.deferred !== true &&
    !(transferTransitionResult.executeResult && transferTransitionResult.executeResult.success)
  ) {
    throwGateRejected();
  }
  log.info(
    `[AbyssalGatePerf] run=${toInt(transferPocketState.instanceID, 0)} ` +
      `tier=${roomLogContext.tier} fromRoom=${roomLogContext.roomIndex} ` +
      `toRoom=${targetRoomIndex} phase=activation ` +
      `prewarmMs=${prewarmDurationMs} ` +
      `totalHandlerMs=${Math.max(0, Date.now() - gateHandlerStartedAtMs)} ` +
      `deferred=${transferTransitionResult.deferred === true}`,
  );
  return null;
}

function scheduleFinalExitRequest(ports, request) {
  const {
    log,
    usesIsolatedAbyssalScene,
    buildAbyssalSceneDescriptor,
    getSessionContext,
    createComposedAbyssalFinalExitCoordinator,
    schedulePendingAbyssalTransition,
    quiesceAbyssalRoomTransferCombat,
    revalidateDelayedAbyssalEndGateHandoff,
    moveShipOutOfPlaceholderPocket,
    recordAuditEvent,
    formatVectorForLog,
    cloneValue,
    normalizeAbyssalRunOutcome,
    throwGateRejected,
  } = ports;
  const { args, session, deps, validation, roomLogContext, progression, targetRoomIndex, gateHandlerStartedAtMs } = request;
  log.info(
  `[AbyssalMgr] Final exit conduit activated char=${roomLogContext.characterID} ` +
    `ship=${roomLogContext.shipID} filament=${roomLogContext.filamentTypeID} ` +
    `name="${roomLogContext.filamentName}" tier=${roomLogContext.tier} weather=${roomLogContext.weather} ` +
    `room=${roomLogContext.roomIndex}/${roomLogContext.totalRooms} roomOrigin=${roomLogContext.roomOrigin} ` +
    `finalShip=${roomLogContext.finalShip} hostileCount=${roomLogContext.hostileCount} ` +
    `cacheID=${roomLogContext.cacheID} conduitID=${roomLogContext.conduitID} ` +
    `timerRemainingMs=${roomLogContext.timerRemainingMs}`,
);
  const exitSceneDescriptor = usesIsolatedAbyssalScene(validation.data.pocketState, deps)
  ? buildAbyssalSceneDescriptor(validation.data.pocketState, deps)
  : null;
  const exitHandoffIdentity = {
  instanceID: toInt(validation.data.pocketState.instanceID, 0),
  characterID: toInt(validation.data.context.characterID, 0),
  shipID: toInt(validation.data.context.shipID, 0),
  systemID: toInt(getSessionContext(session).systemID, 0),
  sceneKey: normalizeText(
    exitSceneDescriptor && exitSceneDescriptor.sceneKey,
    normalizeText(
      session && session._space && session._space.sceneKey,
      normalizeText(session && session.spaceSceneKey, ""),
    ),
  ),
  sourceRoomIndex: toInt(roomLogContext.roomIndex, 0),
  markerItemID: toInt(roomLogContext.conduitID, 0),
  activationMode: "final_exit",
};
  const finalExitScheduler = createComposedAbyssalFinalExitCoordinator({
  scheduleFinalExitHandoff() {
    return schedulePendingAbyssalTransition(
      validation.data.pocketState,
      session,
      deps,
      {
        phase: "exit",
        activationMode: "final_exit",
        sourceRoomIndex: roomLogContext.roomIndex,
        targetRoomIndex: 0,
        transitionFxOptions: {
          targetID: roomLogContext.conduitID,
          destinationLocationID: validation.data.pocketState.sourceSolarSystemID,
          includeDungeonIdentifier: false,
        },
        afterTransitionFxSent: (activePocketState) =>
          quiesceAbyssalRoomTransferCombat(
            activePocketState,
            session,
            deps,
            "final-exit-start",
          ),
        revalidateTransition: (activePocketState) =>
          revalidateDelayedAbyssalEndGateHandoff(
            args,
            session,
            activePocketState,
            exitHandoffIdentity,
            deps,
          ),
        executeTransition: (activePocketState, handoffValidation) => {
          const freshValidation = handoffValidation && handoffValidation.data
            ? handoffValidation
            : validation;
          const exitValidation = {
            ...freshValidation,
            data: {
              ...freshValidation.data,
              pocketState: activePocketState,
            },
          };
          const exitResult = moveShipOutOfPlaceholderPocket(exitValidation, session, deps);
          if (!exitResult.success) {
            recordAuditEvent("abyssal_end_gate_activation_failed", args, session, {
              instanceID: activePocketState.instanceID,
              errorMsg: exitResult.errorMsg,
            });
            log.warn(
              `[AbyssalMgr] AbyssalEndGateActivation failed char=${validation.data.context.characterID} ` +
                `instance=${activePocketState.instanceID} reason=${exitResult.errorMsg || "UNKNOWN"}`,
            );
            return exitResult;
          }
          log.info(
            `[AbyssalMgr] Abyssal run completed char=${roomLogContext.characterID} ` +
              `ship=${roomLogContext.shipID} filament=${roomLogContext.filamentTypeID} ` +
              `name="${roomLogContext.filamentName}" tier=${roomLogContext.tier} weather=${roomLogContext.weather} ` +
              `room=${roomLogContext.roomIndex}/${roomLogContext.totalRooms} roomOrigin=${roomLogContext.roomOrigin} ` +
              `finalShip=${formatVectorForLog(exitResult.data && exitResult.data.returnSpaceState && exitResult.data.returnSpaceState.position)} ` +
              `hostileCount=${roomLogContext.hostileCount} cacheID=${roomLogContext.cacheID} ` +
              `conduitID=${roomLogContext.conduitID} timerRemainingMs=${roomLogContext.timerRemainingMs}`,
          );
          recordAuditEvent("abyssal_end_gate_activation_complete", args, session, {
            instanceID: activePocketState.instanceID,
            traceItemID: activePocketState.traceItemID,
            transitionMode: exitResult.data.transitionMode,
            returnPosition: cloneValue(exitResult.data.returnSpaceState.position),
            activationMode: "final_exit",
          });
          return exitResult;
        },
      },
    );
  },
});
  const exitTransitionResult = finalExitScheduler.beginFinalExit({
  instanceID: toInt(validation.data.pocketState.instanceID, 0),
  ownerCharacterID: toInt(validation.data.pocketState.characterID, 0),
  participantCharacterID: toInt(validation.data.context.characterID, 0),
  shipID: toInt(validation.data.context.shipID, 0),
  sourceSceneKey: exitHandoffIdentity.sceneKey,
  transitionToken: 0,
  transitionStatus: "authorized",
  runOutcome: normalizeAbyssalRunOutcome(validation.data.pocketState.runOutcome),
  progression,
});
  if (
  exitTransitionResult.deferred !== true &&
  !(exitTransitionResult.executeResult && exitTransitionResult.executeResult.success)
) {
  throwGateRejected();
}
  return null;
}

function handleAbyssalEndGateActivation(ports, args, session) {
  const request = prepareEndGateRequest(ports, args, session);
  if (!request) return null;
  if (request.validation.data.activationMode === "transfer") {
    return scheduleTransferRequest(ports, prepareTransferRequest(ports, request));
  }
  return scheduleFinalExitRequest(ports, request);
}

function createAbyssalEndGateRequest(ports) {
  return { handleAbyssalEndGateActivation: handleAbyssalEndGateActivation.bind(null, ports) };
}

module.exports = { createAbyssalEndGateRequest };
