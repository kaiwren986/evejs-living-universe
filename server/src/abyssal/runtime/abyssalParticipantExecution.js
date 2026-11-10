"use strict";

const { normalizeText } = require("../domain/abyssalValueUtils");
const {
  ABYSSAL_PARTICIPANT_TERMINAL_CAUSE,
  ABYSSAL_PARTICIPANT_DESTRUCTION_OPERATION_STATUS,
  ABYSSAL_PARTICIPANT_DESTRUCTION_STATUS_RANK,
  normalizeAbyssalRunOutcome,
  normalizeAbyssalParticipantDestructionOperation,
} = require("../domain/abyssalTerminalTransitionPolicy");
const { createAbyssalParticipantDestructionExecutor } = require("./abyssalParticipantDestructionExecutor");

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function completeDurableAbyssalParticipantDestruction(
  ports, pocketState, participant, preferredSession,
  deps = ports.getDependencies(), options = {},
) {
  const {
    getActivePocketStateByInstanceID,
    getAbyssalParticipantRecord,
    getAbyssalParticipantDestructionOperation,
  } = ports;
  const instanceID = toInt(pocketState && pocketState.instanceID, 0);

  const characterID = toInt(participant && participant.characterID, 0);

  const originalShipID = toInt(participant && participant.shipID, 0);

  const terminalCause = normalizeAbyssalRunOutcome(
    options.terminalCause || ABYSSAL_PARTICIPANT_TERMINAL_CAUSE.RUN_TIMEOUT,
  );

  const nowMs = toInt(options.nowMs, toInt(deps.now(), Date.now()));

  let workingState = getActivePocketStateByInstanceID(instanceID) || pocketState;

  let workingParticipant = getAbyssalParticipantRecord(workingState, characterID) || participant;

  let operation = getAbyssalParticipantDestructionOperation(
    workingState,
    characterID,
  );

  if (
    operation &&
    operation.status === ABYSSAL_PARTICIPANT_DESTRUCTION_OPERATION_STATUS.POD_DESTROYED
  ) {
    const rosterReceipt = commitAbyssalParticipantRosterTerminalReceipt(
    ports, workingState,
      workingParticipant,
      deps,
    );
    return rosterReceipt.success
      ? {
          success: true,
          terminal: true,
          duplicate: true,
          pocketState: rosterReceipt.pocketState,
          operation,
        }
      : rosterReceipt;
  }
  const context = {
    instanceID, characterID, originalShipID, terminalCause, nowMs,
    workingState, workingParticipant, operation, preferredSession, deps, options,
  };
  for (const step of [
    selectParticipantDestructionSession,
    commitAndExecuteParticipantHull,
    commitParticipantPodIntent,
    inspectParticipantPodReceiptEvidence,
    executeParticipantPod,
  ]) {
    const result = step(ports, context);
    if (result) return result;
  }
  return commitParticipantPodAndRosterReceipts(ports, context);
}

function selectParticipantDestructionSession(ports, context) {
  const {
    resolveAbyssalTimeoutRuntimeSession,
    buildAbyssalParticipantTerminalProjection,
    resolveAbyssalParticipantActiveShip,
  } = ports;
  const { workingState, workingParticipant, preferredSession, deps, options, operation } = context;
  let destructionSession = resolveAbyssalTimeoutRuntimeSession(
    buildAbyssalParticipantTerminalProjection(workingState, workingParticipant),
    deps,
    preferredSession,
    {
      participant: workingParticipant,
      preferredSessionAuthority: options.preferredSessionAuthority || null,
    },
  );

  let activeShip = resolveAbyssalParticipantActiveShip(destructionSession, deps);

  const shipDestruction = deps;

  const physicalDestructionExecutor =
    createAbyssalParticipantDestructionExecutor({
      destroySessionShip:
        shipDestruction && typeof shipDestruction.destroySessionShip === "function"
          ? shipDestruction.destroySessionShip
          : null,
    });

  let observedCapsuleID = toInt(
    options.destroyedCapsuleID,
    toInt(
      options.hullDestructionResult && options.hullDestructionResult.data &&
        options.hullDestructionResult.data.capsule &&
        options.hullDestructionResult.data.capsule.itemID,
      activeShip.isCapsule === true ? activeShip.shipID : 0,
    ),
  );

  const hullAlreadyDestroyed = Boolean(
    operation && toInt(
      ABYSSAL_PARTICIPANT_DESTRUCTION_STATUS_RANK[operation.status],
      0,
    ) >= ABYSSAL_PARTICIPANT_DESTRUCTION_STATUS_RANK[
      ABYSSAL_PARTICIPANT_DESTRUCTION_OPERATION_STATUS.HULL_DESTROYED
    ] ||
    options.hullAlreadyDestroyed === true ||
    observedCapsuleID > 0
  );
  Object.assign(context, { destructionSession, activeShip, shipDestruction, physicalDestructionExecutor, observedCapsuleID, hullAlreadyDestroyed });
  return null;
}

function commitAndExecuteParticipantHull(ports, context) {
  const {
    cloneValue,
    resolveAbyssalTimeoutRuntimeSession,
    buildAbyssalParticipantTerminalProjection,
    resolveAbyssalParticipantActiveShip,
    buildAbyssalParticipantHullDestructionIntent,
    commitAbyssalParticipantDestructionOperationState,
  } = ports;
  const { terminalCause, nowMs, deps, options, originalShipID, instanceID, preferredSession, workingParticipant, shipDestruction, physicalDestructionExecutor, hullAlreadyDestroyed } = context;
  let { workingState, operation, observedCapsuleID, destructionSession, activeShip } = context;
  if (!operation) {
    const hullIntent = buildAbyssalParticipantHullDestructionIntent(
      workingState,
      workingParticipant,
      nowMs,
      { terminalCause, intentSource: normalizeText(options.intentSource, "abyssal-manager") },
    );
    const intentCommit = commitAbyssalParticipantDestructionOperationState(
      workingState,
      hullIntent,
      deps,
    );
    if (!intentCommit.success) return intentCommit;
    workingState = intentCommit.pocketState;
    operation = intentCommit.operation;
  }

  if (!hullAlreadyDestroyed) {
    if (
      !destructionSession ||
      !shipDestruction ||
      typeof shipDestruction.destroySessionShip !== "function" ||
      activeShip.shipID !== originalShipID ||
      activeShip.isCapsule === true
    ) {
      return {
        success: true,
        pending: true,
        errorMsg: !destructionSession
          ? "NO_EXACT_SESSION_FOR_ABYSSAL_PARTICIPANT_DESTRUCTION"
          : "ABYSSAL_PARTICIPANT_HULL_AUTHORITY_UNREADY",
        pocketState: workingState,
        operation,
      };
    }
    const hullExecution = physicalDestructionExecutor.executeHullDestruction({
      session: destructionSession,
      expectedShipID: originalShipID,
      destructionContext: {
        sessionChangeReason: normalizeText(options.sessionChangeReason, "abyssal-timeout"),
        suppressWreck: options.suppressWreck !== false,
        destructionReason: normalizeText(options.destructionReason, "abyssal-timeout-lethal"),
        emitNotifications: options.emitNotifications !== false,
        abyssalRunID: instanceID,
        abyssalTerminalCause: terminalCause,
        abyssalTerminalOperationID: operation.operationID,
      },
    });
    const hullResult = hullExecution.physicalResult;
    if (!hullResult || hullResult.success !== true) {
      const failedOperation = normalizeAbyssalParticipantDestructionOperation({
        ...cloneValue(operation),
        lastAttemptAtMs: nowMs,
        hullAttemptCount: Math.max(0, toInt(operation.hullAttemptCount, 0)) + 1,
        hullFailureReason: normalizeText(
          hullResult && hullResult.errorMsg,
          "SHIP_DESTRUCTION_REQUEST_FAILED",
        ),
      });
      const failureCommit = commitAbyssalParticipantDestructionOperationState(
        workingState,
        failedOperation,
        deps,
      );
      return {
        success: true,
        pending: true,
        errorMsg: failedOperation.hullFailureReason,
        pocketState: failureCommit.pocketState || workingState,
        operation: failureCommit.operation || failedOperation,
      };
    }
    const hullReceipt = buildAbyssalParticipantHullDestructionReceipt(
    ports, operation,
      hullResult,
      nowMs,
    );
    observedCapsuleID = toInt(hullReceipt && hullReceipt.capsuleID, observedCapsuleID);
    const hullReceiptCommit = commitAbyssalParticipantDestructionOperationState(
      workingState,
      hullReceipt,
      deps,
    );
    if (!hullReceiptCommit.success) return hullReceiptCommit;
    workingState = hullReceiptCommit.pocketState;
    operation = hullReceiptCommit.operation;
    destructionSession = resolveAbyssalTimeoutRuntimeSession(
      buildAbyssalParticipantTerminalProjection(workingState, workingParticipant),
      deps,
      preferredSession,
      { participant: workingParticipant },
    );
    activeShip = resolveAbyssalParticipantActiveShip(destructionSession, deps);
  } else if (
    toInt(ABYSSAL_PARTICIPANT_DESTRUCTION_STATUS_RANK[operation.status], 0) <
      ABYSSAL_PARTICIPANT_DESTRUCTION_STATUS_RANK[
        ABYSSAL_PARTICIPANT_DESTRUCTION_OPERATION_STATUS.HULL_DESTROYED
      ]
  ) {
    const hullReceipt = buildAbyssalParticipantHullDestructionReceipt(
    ports, operation,
      options.hullDestructionResult || {
        success: true,
        data: { destroyedShipID: originalShipID, capsule: { itemID: observedCapsuleID } },
      },
      nowMs,
    );
    const hullReceiptCommit = commitAbyssalParticipantDestructionOperationState(
      workingState,
      hullReceipt,
      deps,
    );
    if (!hullReceiptCommit.success) return hullReceiptCommit;
    workingState = hullReceiptCommit.pocketState;
    operation = hullReceiptCommit.operation;
  }
  Object.assign(context, { workingState, operation, observedCapsuleID, destructionSession, activeShip });
  return null;
}

function commitParticipantPodIntent(ports, context) {
  const {
    getActivePocketStateByInstanceID,
    getAbyssalParticipantDestructionOperation,
    buildAbyssalParticipantTerminalProjection,
    ensureDurableAbyssalParticipantDestructionIntent,
    log,
  } = ports;
  const { deps, options, terminalCause, nowMs, instanceID, characterID, observedCapsuleID, activeShip, workingParticipant } = context;
  let { workingState, operation } = context;
  const capsuleID = toInt(operation && operation.capsuleID, 0) ||
    toInt(observedCapsuleID, 0) ||
    (activeShip.isCapsule === true ? toInt(activeShip.shipID, 0) : 0);

  const participantProjection = buildAbyssalParticipantTerminalProjection(
    workingState,
    workingParticipant,
  );

  const podIntentResult = ensureDurableAbyssalParticipantDestructionIntent(
    participantProjection,
    capsuleID,
    deps,
    { terminalCause, nowMs, intentSource: normalizeText(options.intentSource, "abyssal-manager") },
  );

  if (!podIntentResult.success) {
    log.warn(
      `[AbyssalParticipantDestruction] pod intent deferred ` +
        `run=${instanceID} character=${characterID} capsule=${capsuleID} ` +
        `reason=${normalizeText(podIntentResult.errorMsg, "UNKNOWN")}`,
    );
    return podIntentResult;
  }

  workingState = getActivePocketStateByInstanceID(instanceID) || podIntentResult.pocketState || workingState;

  operation = getAbyssalParticipantDestructionOperation(workingState, characterID);
  Object.assign(context, { workingState, operation, capsuleID });
  return null;
}

function inspectParticipantPodReceiptEvidence(ports, context) {
  const {
    cloneValue,
    buildAbyssalParticipantTerminalProjection,
    getPendingAbyssalParticipantDestructionReceipt,
    inspectCommittedAbyssalParticipantDeathHandoff,
  } = ports;
  const { options, deps, workingState, operation, workingParticipant, preferredSession } = context;
  const pendingReceiptEvidence =
    getPendingAbyssalParticipantDestructionReceipt(workingState, operation);

  let authoritativeDeathHandoff =
    options.authoritativeDeathHandoff &&
    options.authoritativeDeathHandoff.committed === true
      ? cloneValue(options.authoritativeDeathHandoff)
      : null;

  if (!pendingReceiptEvidence && !authoritativeDeathHandoff) {
    const inspectedHandoff = inspectCommittedAbyssalParticipantDeathHandoff(
      buildAbyssalParticipantTerminalProjection(
        workingState,
        workingParticipant,
      ),
      preferredSession,
      deps,
    );
    if (inspectedHandoff && inspectedHandoff.committed === true) {
      authoritativeDeathHandoff = inspectedHandoff;
    }
  }

  const podAlreadyDestroyed = Boolean(
    options.podAlreadyDestroyed === true ||
    pendingReceiptEvidence ||
    authoritativeDeathHandoff
  );

  let podResult = options.podDestructionResult ||
    pendingReceiptEvidence && pendingReceiptEvidence.podDestructionResult ||
    null;
  Object.assign(context, { pendingReceiptEvidence, authoritativeDeathHandoff, podAlreadyDestroyed, podResult });
  return null;
}

function executeParticipantPod(ports, context) {
  const {
    cloneValue,
    resolveAbyssalTimeoutRuntimeSession,
    buildAbyssalParticipantTerminalProjection,
    resolveAbyssalParticipantActiveShip,
    commitAbyssalParticipantDestructionOperationState,
    rememberPendingAbyssalParticipantDestructionReceipt,
  } = ports;
  const { options, deps, workingParticipant, preferredSession, shipDestruction, physicalDestructionExecutor, capsuleID, instanceID, terminalCause, nowMs, workingState, operation, podAlreadyDestroyed } = context;
  let { destructionSession, activeShip, podResult } = context;
  if (!podAlreadyDestroyed) {
    destructionSession = resolveAbyssalTimeoutRuntimeSession(
      buildAbyssalParticipantTerminalProjection(workingState, workingParticipant),
      deps,
      preferredSession,
      { participant: workingParticipant },
    );
    activeShip = resolveAbyssalParticipantActiveShip(destructionSession, deps);
    if (
      !destructionSession ||
      !shipDestruction ||
      typeof shipDestruction.destroySessionShip !== "function" ||
      activeShip.isCapsule !== true ||
      activeShip.shipID !== capsuleID
    ) {
      return {
        success: true,
        pending: true,
        errorMsg: !destructionSession
          ? "NO_EXACT_SESSION_FOR_ABYSSAL_PARTICIPANT_POD_DESTRUCTION"
          : "ABYSSAL_PARTICIPANT_POD_AUTHORITY_UNREADY",
        pocketState: workingState,
        operation,
      };
    }
    const podExecution = physicalDestructionExecutor.executePodDestruction({
      session: destructionSession,
      expectedShipID: capsuleID,
      destructionContext: {
        sessionChangeReason: normalizeText(options.sessionChangeReason, "abyssal-timeout"),
        suppressWreck: true,
        destructionReason: normalizeText(options.destructionReason, "abyssal-timeout-lethal"),
        emitNotifications: options.emitNotifications !== false,
        abyssalRunID: instanceID,
        abyssalTerminalCause: terminalCause,
        abyssalTerminalOperationID: operation.operationID,
      },
    });
    podResult = podExecution.physicalResult;
    if (!podResult || podResult.success !== true) {
      const failedOperation = normalizeAbyssalParticipantDestructionOperation({
        ...cloneValue(operation),
        lastAttemptAtMs: nowMs,
        attemptCount: Math.max(0, toInt(operation.attemptCount, 0)) + 1,
        failureReason: normalizeText(
          podResult && podResult.errorMsg,
          "POD_DESTRUCTION_REQUEST_FAILED",
        ),
      });
      const failureCommit = commitAbyssalParticipantDestructionOperationState(
        workingState,
        failedOperation,
        deps,
      );
      return {
        success: true,
        pending: true,
        errorMsg: failedOperation.failureReason,
        pocketState: failureCommit.pocketState || workingState,
        operation: failureCommit.operation || failedOperation,
      };
    }
    rememberPendingAbyssalParticipantDestructionReceipt(
      workingState,
      operation,
      {
        capsuleID,
        podDestructionResult: podResult,
        receiptSource: normalizeText(
          options.receiptSource,
          "destroySessionShip",
        ),
        nowMs,
      },
    );
  }
  Object.assign(context, { podResult });
  return null;
}

function commitParticipantPodAndRosterReceipts(ports, context) {
  const {
    cloneValue,
    getAbyssalParticipantRecord,
    commitAbyssalParticipantDestructionOperationState,
    log,
    clearPendingAbyssalParticipantDestructionReceipt,
  } = ports;
  const { operation, nowMs, podAlreadyDestroyed, instanceID, characterID, originalShipID, capsuleID, podResult, authoritativeDeathHandoff, options, pendingReceiptEvidence, terminalCause, deps } = context;
  let { workingState, workingParticipant } = context;
  const completedOperation = normalizeAbyssalParticipantDestructionOperation({
    ...cloneValue(operation),
    status: ABYSSAL_PARTICIPANT_DESTRUCTION_OPERATION_STATUS.POD_DESTROYED,
    podDestroyedAtMs: toInt(operation.podDestroyedAtMs, 0) || nowMs,
    lastAttemptAtMs: nowMs,
    attemptCount: Math.max(0, toInt(operation.attemptCount, 0)) +
      (podAlreadyDestroyed ? 0 : 1),
    failureReason: "",
    receipt: {
      schemaVersion: 1,
      operationID: operation.operationID,
      runID: instanceID,
      characterID,
      originalShipID,
      capsuleID,
      destroyedShipID: toInt(
        podResult && podResult.data && podResult.data.destroyedShipID,
        capsuleID,
      ),
      corpseItemID: toInt(
        podResult && podResult.data && podResult.data.corpse &&
          podResult.data.corpse.itemID,
        0,
      ) || null,
      receiptSource: authoritativeDeathHandoff
        ? "authoritative_clone_handoff"
        : normalizeText(
            options.receiptSource ||
              pendingReceiptEvidence && pendingReceiptEvidence.receiptSource,
            "destroySessionShip",
          ),
      authoritativeDeathHandoff: cloneValue(authoritativeDeathHandoff) || null,
      committedAtMs: nowMs,
    },
  });

  const podReceiptCommit = commitAbyssalParticipantDestructionOperationState(
    workingState,
    completedOperation,
    deps,
  );

  if (!podReceiptCommit.success) return podReceiptCommit;

  log.info(
    terminalCause === ABYSSAL_PARTICIPANT_TERMINAL_CAUSE.RUN_TIMEOUT
      ? `[AbyssalMgr] Lethal timeout pod destruction complete ` +
          `char=${characterID} instance=${instanceID} capsule=${capsuleID} ` +
          `operation=${completedOperation.operationID}`
      : `[AbyssalParticipantDestruction] pod destruction complete ` +
          `run=${instanceID} character=${characterID} capsule=${capsuleID} ` +
          `operation=${completedOperation.operationID}`,
  );

  clearPendingAbyssalParticipantDestructionReceipt(instanceID, characterID);

  workingState = podReceiptCommit.pocketState;

  workingParticipant = getAbyssalParticipantRecord(workingState, characterID) || workingParticipant;

  const rosterReceipt = commitAbyssalParticipantRosterTerminalReceipt(
    ports, workingState,
    workingParticipant,
    deps,
  );

  if (!rosterReceipt.success) return rosterReceipt;

  return {
    success: true,
    terminal: true,
    pocketState: rosterReceipt.pocketState,
    operation: completedOperation,
    hullDestructionResult: options.hullDestructionResult || null,
    podDestructionResult: podResult,
  };
}

function buildAbyssalParticipantHullDestructionReceipt(
  ports,
  operation,
  destructionResult,
  nowMs,
) {
  const {
    cloneValue,
  } = ports;

  const capsuleID = toInt(
    destructionResult && destructionResult.data &&
      destructionResult.data.capsule && destructionResult.data.capsule.itemID,
    toInt(operation && operation.capsuleID, 0),
  );
  return normalizeAbyssalParticipantDestructionOperation({
    ...cloneValue(operation),
    status: ABYSSAL_PARTICIPANT_DESTRUCTION_OPERATION_STATUS.HULL_DESTROYED,
    capsuleID,
    hullDestroyedAtMs: toInt(operation && operation.hullDestroyedAtMs, 0) || nowMs,
    lastAttemptAtMs: nowMs,
    hullAttemptCount: Math.max(0, toInt(operation && operation.hullAttemptCount, 0)) + 1,
    hullFailureReason: "",
    hullReceipt: {
      schemaVersion: 1,
      operationID: normalizeText(operation && operation.operationID, ""),
      runID: toInt(operation && operation.runID, 0),
      characterID: toInt(operation && operation.characterID, 0),
      destroyedShipID: toInt(
        destructionResult && destructionResult.data &&
          destructionResult.data.destroyedShipID,
        toInt(operation && operation.originalShipID, 0),
      ),
      capsuleID: capsuleID || null,
      committedAtMs: nowMs,
    },
  });
}

function commitAbyssalParticipantRosterTerminalReceipt(
  ports,
  pocketState,
  participant,
  deps = ports.getDependencies(),
) {
  const {
    cloneValue,
    upsertAbyssalParticipantRosterEntry,
    ABYSSAL_PARTICIPANT_STATUS,
    commitPocketStateDurably,
  } = ports;

  const nowMs = toInt(deps.now(), Date.now());
  const participantRoster = upsertAbyssalParticipantRosterEntry(pocketState, {
    ...cloneValue(participant),
    status: ABYSSAL_PARTICIPANT_STATUS.DESTROYED,
    destroyedAtMs: toInt(participant && participant.destroyedAtMs, 0) || nowMs,
    lastSeenAtMs: nowMs,
  });
  const commitResult = commitPocketStateDurably(
    toInt(pocketState && pocketState.instanceID, 0),
    { participantRoster },
    deps,
    { verifyReadBack: true, forceWrite: true },
  );
  return commitResult && commitResult.success === true
    ? {
        success: true,
        pocketState: cloneValue(commitResult.committedState || commitResult.state),
      }
    : {
        success: false,
        pending: true,
        errorMsg: normalizeText(
          commitResult && commitResult.errorMsg,
          "ABYSSAL_PARTICIPANT_TERMINAL_RECEIPT_PERSIST_FAILED",
        ),
      };
}

function reconcilePendingAbyssalMemberDestructions(
  ports,
  pocketState,
  deps = ports.getDependencies(),
  nowMs = null,
) {
  const {
    getAbyssalParticipantRecord,
    getAbyssalParticipantDestructionOperationsByCharacterID,
  } = ports;

  let workingState = pocketState;
  const operations = getAbyssalParticipantDestructionOperationsByCharacterID(
    workingState,
  );
  for (const operation of Object.values(operations)) {
    if (
      operation.terminalCause !==
        ABYSSAL_PARTICIPANT_TERMINAL_CAUSE.MEMBER_SHIP_DESTROYED ||
      operation.status ===
        ABYSSAL_PARTICIPANT_DESTRUCTION_OPERATION_STATUS.POD_DESTROYED
    ) {
      continue;
    }
    const participant = getAbyssalParticipantRecord(
      workingState,
      operation.characterID,
    );
    if (!participant) continue;
    const result = completeDurableAbyssalParticipantDestruction(
    ports, workingState,
      participant,
      null,
      deps,
      {
        terminalCause: ABYSSAL_PARTICIPANT_TERMINAL_CAUSE.MEMBER_SHIP_DESTROYED,
        nowMs: toInt(nowMs, toInt(deps.now(), Date.now())),
        intentSource: "combat-participant-destruction-retry",
        sessionChangeReason: "abyssal-combat-destruction",
        destructionReason: "abyssal-combat-destruction",
        hullAlreadyDestroyed: true,
        destroyedCapsuleID: operation.capsuleID,
      },
    );
    if (result && result.pocketState) workingState = result.pocketState;
  }
  return workingState;
}

function createAbyssalParticipantExecution(ports) {
  return {
    buildAbyssalParticipantHullDestructionReceipt: buildAbyssalParticipantHullDestructionReceipt.bind(null, ports),
    commitAbyssalParticipantRosterTerminalReceipt: commitAbyssalParticipantRosterTerminalReceipt.bind(null, ports),
    completeDurableAbyssalParticipantDestruction: completeDurableAbyssalParticipantDestruction.bind(null, ports),
    reconcilePendingAbyssalMemberDestructions: reconcilePendingAbyssalMemberDestructions.bind(null, ports),
  };
}

module.exports = { createAbyssalParticipantExecution };
