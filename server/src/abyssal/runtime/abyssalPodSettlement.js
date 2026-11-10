"use strict";

const { normalizeText } = require("../domain/abyssalValueUtils");
const {
  ABYSSAL_RUN_OUTCOME, ABYSSAL_PARTICIPANT_DESTRUCTION_OPERATION_STATUS,
  normalizeAbyssalRunOutcome, hasFailedTimeoutOutcome,
  normalizeAbyssalParticipantDestructionOperation,
} = require("../domain/abyssalTerminalTransitionPolicy");
const { createAbyssalParticipantDestructionExecutor } = require("./abyssalParticipantDestructionExecutor");

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function completeAbyssalParticipantPodDestructionAndCleanup(
  ports, pocketState, session, deps = ports.getDependencies(), options = {},
) {
  const {
    getActivePocketStateByInstanceID,
    schedulePlaceholderPocketMaintenance,
    getAbyssalTimeoutState,
  } = ports;
  const instanceID = toInt(pocketState && pocketState.instanceID, 0);

  let activePocketState =
    getActivePocketStateByInstanceID(instanceID) ||
    pocketState ||
    null;

  if (!activePocketState || instanceID <= 0) {
    return {
      success: true,
      alreadyClean: true,
      data: {
        shipDestroyed: true,
        podDestroyed: true,
        cleanupTriggered: true,
      },
    };
  }

  const lethalTimeout =
    options.lethalTimeout === true ||
    hasFailedTimeoutOutcome(activePocketState);

  const terminalCause = lethalTimeout
    ? ABYSSAL_RUN_OUTCOME.FAILED_TIMEOUT
    : ABYSSAL_RUN_OUTCOME.FAILED_SHIP_DESTROYED;

  if (
    normalizeAbyssalRunOutcome(activePocketState.runOutcome) !== terminalCause
  ) {
    schedulePlaceholderPocketMaintenance(deps);
    return {
      success: false,
      pending: true,
      errorMsg: "ABYSSAL_PARTICIPANT_DESTRUCTION_TERMINAL_CAUSE_NOT_COMMITTED",
      data: getAbyssalTimeoutState(activePocketState, deps),
    };
  }

  const phasePrefix = lethalTimeout
    ? "failed_timeout_lethal"
    : "failed_ship_destroyed";

  const cleanupReason = normalizeText(
    options.cleanupReason,
    lethalTimeout ? "abyssal-timeout-lethal" : "abyssal-combat-destruction",
  );

  const logLabel = lethalTimeout ? "Lethal timeout" : "Abyssal participant";

  const nowMs = Math.max(
    0,
    toInt(
      options.nowMs,
      deps && typeof deps.now === "function" ? deps.now() : Date.now(),
    ),
  );
  const context = {
    instanceID, activePocketState, lethalTimeout, terminalCause, phasePrefix,
    cleanupReason, logLabel, nowMs, session, deps, options,
  };
  inspectPodSettlementEvidence(ports, context);
  if (context.observedPodAlreadyDestroyed || context.authoritativeDeathHandoff) {
    const result = commitObservedPodReceipt(ports, context);
    if (result) return result;
  } else {
    for (const step of [resolveSettlementCapsule, commitSettlementPodIntent]) {
      const result = step(ports, context);
      if (result) return result;
    }
    if (context.intentResult.alreadyDestroyed !== true) {
      for (const step of [executeSettlementPod, commitExecutedPodReceipt]) {
        const result = step(ports, context);
        if (result) return result;
      }
    }
  }
  return verifyPodReceiptAndCleanup(ports, context);
}

function inspectPodSettlementEvidence(ports, context) {
  const {
    getAbyssalTimeoutState,
    getAbyssalParticipantDestructionOperation,
    getPendingAbyssalParticipantDestructionReceipt,
    cloneValue,
    inspectCommittedAbyssalParticipantDeathHandoff,
  } = ports;
  const { activePocketState, deps, options, instanceID, session } = context;
  let timeoutState = {
    ...getAbyssalTimeoutState(activePocketState, deps),
    shipDestroyed: true,
    cleanupTriggered: false,
  };

  const shipDestruction = deps;

  let destructionOperation =
    getAbyssalParticipantDestructionOperation(activePocketState);

  let pendingReceiptEvidence =
    getPendingAbyssalParticipantDestructionReceipt(
      activePocketState,
      destructionOperation,
    );

  let authoritativeDeathHandoff =
    options.authoritativeDeathHandoff &&
    options.authoritativeDeathHandoff.committed === true
      ? cloneValue(options.authoritativeDeathHandoff)
      : null;

  const externallyDestroyedCapsuleID = toInt(
    options.destroyedCapsuleID,
    toInt(
      options.podDestructionResult &&
        options.podDestructionResult.data &&
        options.podDestructionResult.data.destroyedShipID,
      toInt(
        options.shipDestroyResult &&
          options.shipDestroyResult.data &&
          options.shipDestroyResult.data.destroyedShipID,
        toInt(
          pendingReceiptEvidence && pendingReceiptEvidence.capsuleID,
          toInt(destructionOperation && destructionOperation.capsuleID, 0),
        ),
      ),
    ),
  );

  const observedPodAlreadyDestroyed = Boolean(
    options.podAlreadyDestroyed === true ||
    Boolean(pendingReceiptEvidence) ||
    (
      destructionOperation &&
      destructionOperation.status ===
        ABYSSAL_PARTICIPANT_DESTRUCTION_OPERATION_STATUS.POD_DESTROYED
    )
  );

  if (
    !authoritativeDeathHandoff &&
    timeoutState.podDestroyed === true &&
    !observedPodAlreadyDestroyed
  ) {
    const inspectedHandoff = inspectCommittedAbyssalParticipantDeathHandoff(
      activePocketState,
      session,
      deps,
    );
    if (inspectedHandoff && inspectedHandoff.committed === true) {
      authoritativeDeathHandoff = inspectedHandoff;
    }
  }
  Object.assign(context, { timeoutState, shipDestruction, destructionOperation, pendingReceiptEvidence, authoritativeDeathHandoff, externallyDestroyedCapsuleID, observedPodAlreadyDestroyed });
  return null;
}

function commitObservedPodReceipt(ports, context) {
  const {
    getActivePocketStateByInstanceID,
    schedulePlaceholderPocketMaintenance,
    getAbyssalTimeoutState,
    getAbyssalParticipantDestructionOperation,
    commitDurableAbyssalParticipantPodDestructionReceipt,
    rememberPendingAbyssalParticipantDestructionReceipt,
    clearPendingAbyssalParticipantDestructionReceipt,
  } = ports;
  const { deps, options, terminalCause, nowMs, externallyDestroyedCapsuleID, pendingReceiptEvidence, authoritativeDeathHandoff, instanceID } = context;
  let { activePocketState, destructionOperation, timeoutState } = context;
  const receiptResult =
    commitDurableAbyssalParticipantPodDestructionReceipt(
      activePocketState,
      deps,
      {
        terminalCause,
        nowMs,
        podAlreadyDestroyed: true,
        capsuleID: externallyDestroyedCapsuleID,
        podDestructionResult:
          options.podDestructionResult ||
          options.shipDestroyResult ||
          pendingReceiptEvidence &&
            pendingReceiptEvidence.podDestructionResult ||
          null,
        authoritativeDeathHandoff:
          authoritativeDeathHandoff ||
          pendingReceiptEvidence &&
            pendingReceiptEvidence.authoritativeDeathHandoff ||
          null,
        receiptSource: authoritativeDeathHandoff
          ? "authoritative_clone_handoff"
          : normalizeText(
              options.receiptSource ||
                pendingReceiptEvidence &&
                  pendingReceiptEvidence.receiptSource,
              "external-pod-destruction-callback",
            ),
        incrementAttempt: false,
      },
    );

  if (!receiptResult || receiptResult.success !== true) {
    rememberPendingAbyssalParticipantDestructionReceipt(
      activePocketState,
      destructionOperation ||
        receiptResult && receiptResult.operation,
      {
        capsuleID: externallyDestroyedCapsuleID,
        podDestructionResult:
          options.podDestructionResult ||
          options.shipDestroyResult ||
          pendingReceiptEvidence &&
            pendingReceiptEvidence.podDestructionResult ||
          null,
        authoritativeDeathHandoff:
          authoritativeDeathHandoff ||
          pendingReceiptEvidence &&
            pendingReceiptEvidence.authoritativeDeathHandoff ||
          null,
        receiptSource: normalizeText(
          options.receiptSource ||
            pendingReceiptEvidence && pendingReceiptEvidence.receiptSource,
          "external-pod-destruction-callback",
        ),
        nowMs,
      },
    );
    schedulePlaceholderPocketMaintenance(deps);
    return {
      success: true,
      pending: true,
      persistencePending: true,
      errorMsg: normalizeText(
        receiptResult && receiptResult.errorMsg,
        "ABYSSAL_PARTICIPANT_DESTRUCTION_RECEIPT_PERSIST_FAILED",
      ),
      data: getAbyssalTimeoutState(
        receiptResult && receiptResult.pocketState || activePocketState,
        deps,
      ),
    };
  }

  clearPendingAbyssalParticipantDestructionReceipt(instanceID);

  activePocketState =
    getActivePocketStateByInstanceID(instanceID) ||
    receiptResult.pocketState ||
    activePocketState;

  destructionOperation =
    getAbyssalParticipantDestructionOperation(activePocketState);

  timeoutState = getAbyssalTimeoutState(activePocketState, deps);
  Object.assign(context, { activePocketState, destructionOperation, timeoutState });
  return null;
}

function resolveSettlementCapsule(ports, context) {
  const {
    getAbyssalTimeoutState,
    resolveAbyssalTimeoutRuntimeSession,
    resolveAbyssalParticipantActiveShip,
    updatePocketState,
    log,
  } = ports;
  const { deps, session, options, shipDestruction, lethalTimeout, nowMs, instanceID, phasePrefix, logLabel } = context;
  let { activePocketState, timeoutState } = context;
  const destructionSession = resolveAbyssalTimeoutRuntimeSession(
    activePocketState,
    deps,
    session,
    {
      preferredSessionAuthority:
        options.preferredSessionAuthority || null,
    },
  );

  const activeShip = resolveAbyssalParticipantActiveShip(
    destructionSession,
    deps,
  );

  const resultCapsuleID = toInt(
    options.shipDestroyResult &&
      options.shipDestroyResult.data &&
      options.shipDestroyResult.data.capsule &&
      options.shipDestroyResult.data.capsule.itemID,
    0,
  );

  const capsuleReady = Boolean(
    destructionSession &&
    activeShip.isCapsule === true &&
    activeShip.shipID > 0 &&
    (
      resultCapsuleID <= 0 ||
      activeShip.shipID === resultCapsuleID
    )
  );

  let pendingReason = "";

  if (!destructionSession) {
    pendingReason = lethalTimeout
      ? "NO_EXACT_SESSION_FOR_LETHAL_TIMEOUT"
      : "NO_EXACT_SESSION_FOR_ABYSSAL_DESTRUCTION";
  } else if (
    !shipDestruction ||
    typeof shipDestruction.destroySessionShip !== "function"
  ) {
    pendingReason = "SHIP_DESTRUCTION_HOOK_UNAVAILABLE";
  } else if (!capsuleReady) {
    pendingReason =
      activeShip.shipID > 0
        ? "ACTIVE_SHIP_IS_NOT_EXACT_ABYSSAL_CAPSULE"
        : "ABYSSAL_CAPSULE_NOT_READY";
  }

  if (pendingReason) {
    const warning = withRateLimitedAbyssalDestructionWarning(
    ports, {
        ...timeoutState,
        podDestructionReason: pendingReason,
      },
      pendingReason,
      nowMs,
    );
    timeoutState = warning.timeoutState;
    activePocketState = updatePocketState(instanceID, {
      allowDebugExit: false,
      timerFailureState:
        pendingReason === "ABYSSAL_CAPSULE_NOT_READY"
          ? `${phasePrefix}_pod_pending`
          : `${phasePrefix}_pod_retry`,
      timeoutState,
    }) || activePocketState;
    if (warning.shouldLog) {
      log.warn(
        `[AbyssalMgr] ${logLabel} pod destruction unavailable ` +
          `char=${activePocketState.characterID} instance=${instanceID} ` +
          `trace=${activePocketState.traceItemID} ship=${activeShip.shipID} ` +
          `reason=${pendingReason}`,
      );
    }
    return {
      success: true,
      pending: true,
      data: getAbyssalTimeoutState(activePocketState, deps),
    };
  }
  Object.assign(context, { activePocketState, timeoutState, destructionSession, activeShip });
  return null;
}

function commitSettlementPodIntent(ports, context) {
  const {
    getActivePocketStateByInstanceID,
    schedulePlaceholderPocketMaintenance,
    getAbyssalTimeoutState,
    getAbyssalParticipantDestructionOperation,
    log,
    ensureDurableAbyssalParticipantDestructionIntent,
    getAuthoritativeAbyssalPocketState,
  } = ports;
  const { deps, activeShip, terminalCause, nowMs, lethalTimeout, instanceID, logLabel } = context;
  let { activePocketState, destructionOperation } = context;
  const intentResult = ensureDurableAbyssalParticipantDestructionIntent(
    activePocketState,
    activeShip.shipID,
    deps,
    {
      terminalCause,
      nowMs,
      intentSource: lethalTimeout
        ? "lethal-timeout"
        : "combat-participant-destruction",
    },
  );

  if (!intentResult || intentResult.success !== true) {
    const intentFailureReason = normalizeText(
      intentResult && intentResult.errorMsg,
      "ABYSSAL_PARTICIPANT_DESTRUCTION_INTENT_PERSIST_FAILED",
    );
    const warning = withRateLimitedAbyssalDestructionWarning(
    ports, {
        ...getAbyssalTimeoutState(
          intentResult && intentResult.pocketState || activePocketState,
          deps,
        ),
        shipDestroyed: true,
        podDestroyed: false,
        cleanupTriggered: false,
        podDestructionReason: intentFailureReason,
      },
      intentFailureReason,
      nowMs,
    );
    // The candidate intent was not durably committed and therefore was not
    // published. Do not perform a second authoritative write merely to store
    // diagnostics while the same persistence boundary is failing.
    activePocketState = getAuthoritativeAbyssalPocketState(
      instanceID,
      activePocketState,
    );
    schedulePlaceholderPocketMaintenance(deps);
    if (warning.shouldLog) {
      log.warn(
        `[AbyssalMgr] ${logLabel} pod destruction intent not durable ` +
          `char=${activePocketState.characterID} instance=${instanceID} ` +
          `trace=${activePocketState.traceItemID} pod=${activeShip.shipID} ` +
          `reason=${intentFailureReason}`,
      );
    }
    return {
      success: true,
      pending: true,
      persistencePending: true,
      errorMsg: intentFailureReason,
      data: warning.timeoutState,
    };
  }

  activePocketState =
    getActivePocketStateByInstanceID(instanceID) ||
    intentResult.pocketState ||
    activePocketState;

  destructionOperation =
    getAbyssalParticipantDestructionOperation(activePocketState);
  Object.assign(context, { activePocketState, destructionOperation, intentResult });
  return null;
}

function executeSettlementPod(ports, context) {
  const {
    getAbyssalTimeoutState,
    getAbyssalParticipantDestructionOperation,
    cloneValue,
    log,
    commitAbyssalParticipantDestructionOperationState,
    AbyssalPocketPersistenceError,
    ABYSSAL_POCKET_PERSISTENCE_ERROR,
    ABYSSAL_TIMEOUT_POD_STATUS,
  } = ports;
  const { instanceID, logLabel, activeShip, shipDestruction, destructionSession, lethalTimeout, cleanupReason, options, terminalCause, nowMs, phasePrefix, deps } = context;
  let { activePocketState, destructionOperation, timeoutState } = context;
  log.info(
      `[AbyssalMgr] ${logLabel} pod destruction requested ` +
        `char=${activePocketState.characterID} instance=${instanceID} ` +
        `trace=${activePocketState.traceItemID} pod=${activeShip.shipID} ` +
        `operation=${normalizeText(
          destructionOperation && destructionOperation.operationID,
          "none",
        )}`,
    );

  const podExecution = createAbyssalParticipantDestructionExecutor({
      destroySessionShip: shipDestruction.destroySessionShip,
    }).executePodDestruction({
      session: destructionSession,
      expectedShipID: activeShip.shipID,
      destructionContext: {
        sessionChangeReason: lethalTimeout
          ? "abyssal-timeout"
          : "abyssal-combat-destruction",
        suppressWreck: lethalTimeout,
        destructionReason: cleanupReason,
        emitNotifications: options.emitNotifications !== false,
        abyssalRunID: instanceID,
        abyssalTerminalCause: terminalCause,
        abyssalTerminalOperationID:
          destructionOperation && destructionOperation.operationID,
      },
    });

  const podDestroyResult = podExecution.physicalResult;

  if (!podDestroyResult || podDestroyResult.success !== true) {
      const podDestroyFailureReason = normalizeText(
        podDestroyResult && podDestroyResult.errorMsg,
        ABYSSAL_TIMEOUT_POD_STATUS.POD_DESTRUCTION_REQUEST_FAILED,
      );
      const currentOperation =
        getAbyssalParticipantDestructionOperation(activePocketState);
      const warning = withRateLimitedAbyssalDestructionWarning(
    ports, {
          ...getAbyssalTimeoutState(activePocketState, deps),
          shipDestroyed: true,
          podDestroyed: false,
          cleanupTriggered: false,
          podDestructionReason: podDestroyFailureReason,
        },
        lethalTimeout
          ? "LETHAL_TIMEOUT_POD_DESTRUCTION_RETRY"
          : "ABYSSAL_PARTICIPANT_POD_DESTRUCTION_RETRY",
        nowMs,
      );
      timeoutState = warning.timeoutState;
      const failedOperation =
        normalizeAbyssalParticipantDestructionOperation({
          ...cloneValue(currentOperation),
          lastAttemptAtMs: nowMs,
          attemptCount:
            Math.max(0, toInt(currentOperation.attemptCount, 0)) + 1,
          failureReason: podDestroyFailureReason,
        });
      const failureCommit =
        commitAbyssalParticipantDestructionOperationState(
          activePocketState,
          failedOperation,
          deps,
          {
            // This same-state diagnostic update did not require physical
            // readback before the extraction. Preserve that contract.
            verifyReadBack: false,
            additionalPatch: {
              allowDebugExit: false,
              timerFailureState: `${phasePrefix}_pod_retry`,
              timeoutState,
            },
          },
        );
      if (!failureCommit || failureCommit.success !== true) {
        throw new AbyssalPocketPersistenceError({
          instanceID,
          errorMsg: normalizeText(
            failureCommit && failureCommit.errorMsg,
            ABYSSAL_POCKET_PERSISTENCE_ERROR,
          ),
        });
      }
      activePocketState = failureCommit.pocketState || activePocketState;
      if (warning.shouldLog) {
        log.warn(
          `[AbyssalMgr] ${logLabel} pod destruction failed ` +
            `char=${activePocketState.characterID} instance=${instanceID} ` +
            `trace=${activePocketState.traceItemID} ` +
            `operation=${normalizeText(
              currentOperation && currentOperation.operationID,
              "none",
            )} reason=${podDestroyFailureReason}`,
        );
      }
      return {
        success: true,
        pending: true,
        data: getAbyssalTimeoutState(activePocketState, deps),
      };
    }
  Object.assign(context, { activePocketState, destructionOperation, timeoutState, podDestroyResult });
  return null;
}

function commitExecutedPodReceipt(ports, context) {
  const {
    getActivePocketStateByInstanceID,
    schedulePlaceholderPocketMaintenance,
    getAbyssalTimeoutState,
    getAbyssalParticipantDestructionOperation,
    commitDurableAbyssalParticipantPodDestructionReceipt,
    rememberPendingAbyssalParticipantDestructionReceipt,
    clearPendingAbyssalParticipantDestructionReceipt,
    log,
  } = ports;
  const { podDestroyResult, activeShip, instanceID, deps, terminalCause, nowMs, logLabel } = context;
  let { activePocketState, destructionOperation, pendingReceiptEvidence, timeoutState } = context;
  const resultDestroyedShipID = toInt(
      podDestroyResult &&
        podDestroyResult.data &&
        podDestroyResult.data.destroyedShipID,
      0,
    );

  if (
      resultDestroyedShipID > 0 &&
      resultDestroyedShipID !== activeShip.shipID
    ) {
      log.error(
        `[AbyssalPodDestruction] result identity mismatch ` +
          `run=${instanceID} operation=${normalizeText(
            destructionOperation && destructionOperation.operationID,
            "none",
          )} expectedPod=${activeShip.shipID} ` +
          `destroyedShip=${resultDestroyedShipID}`,
      );
      schedulePlaceholderPocketMaintenance(deps);
      return {
        success: false,
        pending: true,
        errorMsg: "ABYSSAL_PARTICIPANT_DESTRUCTION_RESULT_IDENTITY_MISMATCH",
        data: getAbyssalTimeoutState(activePocketState, deps),
      };
    }

  pendingReceiptEvidence =
      rememberPendingAbyssalParticipantDestructionReceipt(
        activePocketState,
        destructionOperation,
        {
          capsuleID: activeShip.shipID,
          podDestructionResult: podDestroyResult,
          receiptSource: "destroySessionShip",
          nowMs,
        },
      );

  const receiptResult =
      commitDurableAbyssalParticipantPodDestructionReceipt(
        activePocketState,
        deps,
        {
          terminalCause,
          nowMs,
          capsuleID: activeShip.shipID,
          podDestructionResult: podDestroyResult,
          receiptSource: "destroySessionShip",
        },
      );

  if (!receiptResult || receiptResult.success !== true) {
      schedulePlaceholderPocketMaintenance(deps);
      log.error(
        `[AbyssalPodDestruction] pod destroyed but receipt not durable ` +
          `run=${instanceID} character=${activePocketState.characterID} ` +
          `pod=${activeShip.shipID} operation=${normalizeText(
            destructionOperation && destructionOperation.operationID,
            "none",
          )} reason=${normalizeText(
            receiptResult && receiptResult.errorMsg,
            "ABYSSAL_PARTICIPANT_DESTRUCTION_RECEIPT_PERSIST_FAILED",
          )}`,
      );
      return {
        success: true,
        pending: true,
        persistencePending: true,
        errorMsg: normalizeText(
          receiptResult && receiptResult.errorMsg,
          "ABYSSAL_PARTICIPANT_DESTRUCTION_RECEIPT_PERSIST_FAILED",
        ),
        data: getAbyssalTimeoutState(
          receiptResult && receiptResult.pocketState || activePocketState,
          deps,
        ),
      };
    }

  clearPendingAbyssalParticipantDestructionReceipt(instanceID);

  activePocketState =
      getActivePocketStateByInstanceID(instanceID) ||
      receiptResult.pocketState ||
      activePocketState;

  destructionOperation =
      getAbyssalParticipantDestructionOperation(activePocketState);

  timeoutState = getAbyssalTimeoutState(activePocketState, deps);

  log.info(
      `[AbyssalMgr] ${logLabel} pod destruction complete ` +
        `char=${activePocketState.characterID} instance=${instanceID} ` +
        `trace=${activePocketState.traceItemID} operation=${normalizeText(
          destructionOperation && destructionOperation.operationID,
          "none",
        )}`,
    );
  Object.assign(context, { activePocketState, destructionOperation, pendingReceiptEvidence, timeoutState });
  return null;
}

function verifyPodReceiptAndCleanup(ports, context) {
  const {
    getActivePocketStateByInstanceID,
    schedulePlaceholderPocketMaintenance,
    getAbyssalTimeoutState,
    getAbyssalParticipantDestructionOperation,
    updatePocketState,
    persistAndVerifyAbyssalParticipantDestructionOperation,
    cleanupAbyssalRun,
  } = ports;
  const { instanceID, deps, options, session, cleanupReason, phasePrefix, lethalTimeout } = context;
  let { activePocketState, destructionOperation, timeoutState } = context;
  activePocketState =
    getActivePocketStateByInstanceID(instanceID) || activePocketState;

  destructionOperation =
    getAbyssalParticipantDestructionOperation(activePocketState);

  if (
    !destructionOperation ||
    destructionOperation.status !==
      ABYSSAL_PARTICIPANT_DESTRUCTION_OPERATION_STATUS.POD_DESTROYED
  ) {
    schedulePlaceholderPocketMaintenance(deps);
    return {
      success: true,
      pending: true,
      persistencePending: true,
      errorMsg: "ABYSSAL_PARTICIPANT_DESTRUCTION_DURABLE_RECEIPT_REQUIRED",
      data: getAbyssalTimeoutState(activePocketState, deps),
    };
  }

  const finalReceiptVerification =
    persistAndVerifyAbyssalParticipantDestructionOperation(
      activePocketState,
      deps,
      destructionOperation,
    );

  if (!finalReceiptVerification || finalReceiptVerification.success !== true) {
    schedulePlaceholderPocketMaintenance(deps);
    return {
      success: true,
      pending: true,
      persistencePending: true,
      errorMsg: normalizeText(
        finalReceiptVerification && finalReceiptVerification.errorMsg,
        "ABYSSAL_PARTICIPANT_DESTRUCTION_DURABLE_RECEIPT_REQUIRED",
      ),
      data: getAbyssalTimeoutState(activePocketState, deps),
    };
  }

  if (options.emitNotifications !== false) {
    sendAbyssalTerminalClientTeardown(
    ports, activePocketState,
      session,
      deps,
      cleanupReason,
    );
  }

  let cleanupResult = null;

  try {
    cleanupResult = cleanupAbyssalRun(activePocketState, deps, {
      reason: cleanupReason,
      session,
    });
  } catch (error) {
    cleanupResult = {
      success: false,
      errorMsg: normalizeText(
        error && error.message,
        "ABYSSAL_PARTICIPANT_DESTRUCTION_CLEANUP_FAILED",
      ),
    };
  }

  if (!cleanupResult || cleanupResult.success !== true) {
    const cleanupFailureReason = normalizeText(
      cleanupResult && cleanupResult.errorMsg,
      "ABYSSAL_PARTICIPANT_DESTRUCTION_CLEANUP_FAILED",
    );
    const remainingPocketState = getActivePocketStateByInstanceID(instanceID);
    if (remainingPocketState) {
      timeoutState = {
        ...getAbyssalTimeoutState(remainingPocketState, deps),
        shipDestroyed: true,
        podDestroyed: true,
        cleanupTriggered: false,
        reason: cleanupFailureReason,
      };
      updatePocketState(instanceID, {
        allowDebugExit: false,
        timerFailureState: `${phasePrefix}_cleanup_retry`,
        timeoutState,
      });
    }
    return {
      success: true,
      pending: true,
      data: timeoutState,
      cleanupResult,
    };
  }

  return {
    success: true,
    data: {
      ...timeoutState,
      shipDestroyed: true,
      podDestroyed: true,
      cleanupTriggered: true,
      reason: lethalTimeout
        ? "LETHAL_TIMEOUT_SHIP_AND_POD_DESTROYED"
        : "ABYSSAL_PARTICIPANT_SHIP_AND_POD_DESTROYED",
      participantDestructionOperationID: destructionOperation.operationID,
    },
    cleanupResult,
  };
}

function withRateLimitedAbyssalDestructionWarning(
  ports,
  timeoutState,
  reason,
  nowMs,
) {

  const normalizedReason = normalizeText(reason, "ABYSSAL_DESTRUCTION_PENDING");
  const warningAtMs = toInt(timeoutState && timeoutState.pendingWarningAtMs, 0);
  const warningReason = normalizeText(
    timeoutState && timeoutState.pendingWarningReason,
    "",
  );
  const effectiveNowMs = Math.max(0, toInt(nowMs, Date.now()));
  const shouldLog =
    warningReason !== normalizedReason ||
    warningAtMs <= 0 ||
    effectiveNowMs - warningAtMs >= 30_000;
  return {
    shouldLog,
    timeoutState: {
      ...timeoutState,
      reason: normalizedReason,
      pendingWarningReason: shouldLog ? normalizedReason : warningReason,
      pendingWarningAtMs: shouldLog ? effectiveNowMs : warningAtMs,
    },
  };
}

function sendAbyssalTerminalClientTeardown(
  ports,
  pocketState,
  session,
  deps = ports.getDependencies(),
  reason = "terminal-destruction",
) {
  const {
    log,
    buildPlaceholderRoomState,
    sendAbyssalDungeonExitNotification,
    sendAbyssalLocationExitNotification,
    sendAbyssalContentFinishedNotification,
    getCharacterID,
  } = ports;

  if (!session || typeof session.sendNotification !== "function") {
    return {
      sent: false,
      reason: "TERMINAL_CLIENT_TEARDOWN_UNAVAILABLE",
    };
  }
  const runID = toInt(pocketState && pocketState.instanceID, 0);
  const roomIndex = buildPlaceholderRoomState(pocketState).currentRoomIndex;
  const clientEnvironment =
    session.abyssalClientEnvironment &&
    typeof session.abyssalClientEnvironment === "object"
      ? session.abyssalClientEnvironment
      : null;
  const dungeonID = toInt(
    clientEnvironment && clientEnvironment.volumetricCloudDungeonID,
    0,
  );
  const dungeonExitResult = dungeonID > 0
    ? sendAbyssalDungeonExitNotification(session, dungeonID, {
        pocketState,
        roomIndex,
        deps,
        sequenceEvent: "terminal-destruction-dungeon-exit",
      })
    : {
        sent: false,
        duplicate: false,
        reason: "DUNGEON_ID_UNAVAILABLE",
      };
  const locationExitResult = sendAbyssalLocationExitNotification(
    session,
    runID,
    roomIndex,
    {
      phase: "terminal-destruction",
      deps,
    },
  );
  const contentFinishedResult = sendAbyssalContentFinishedNotification(
    session,
    pocketState,
    deps,
    {
      markPocketsCompleted: false,
      trackingEvent: "content_terminated",
    },
  );
  log.info(
    `[AbyssalClientTeardown] char=${getCharacterID(session)} instance=${runID} ` +
      `room=${roomIndex} dungeonExit=${Boolean(
        dungeonExitResult.sent || dungeonExitResult.duplicate,
      )} locationExit=${Boolean(
        locationExitResult.sent || locationExitResult.duplicate,
      )} contentFinished=${Boolean(
        contentFinishedResult.sent || contentFinishedResult.duplicate,
      )} reason=${normalizeText(reason, "terminal-destruction")}`,
  );
  return {
    sent: Boolean(
      locationExitResult.sent || locationExitResult.duplicate ||
      contentFinishedResult.sent || contentFinishedResult.duplicate,
    ),
    dungeonExitResult,
    locationExitResult,
    contentFinishedResult,
  };
}

function createAbyssalPodSettlement(ports) {
  return {
    withRateLimitedAbyssalDestructionWarning: withRateLimitedAbyssalDestructionWarning.bind(null, ports),
    sendAbyssalTerminalClientTeardown: sendAbyssalTerminalClientTeardown.bind(null, ports),
    completeAbyssalParticipantPodDestructionAndCleanup: completeAbyssalParticipantPodDestructionAndCleanup.bind(null, ports),
  };
}

module.exports = { createAbyssalPodSettlement };
