"use strict";

const { normalizeText } = require("../domain/abyssalValueUtils");
const {
  ABYSSAL_RUN_OUTCOME, ABYSSAL_PARTICIPANT_TERMINAL_CAUSE,
  ABYSSAL_PARTICIPANT_DESTRUCTION_OPERATION_STATUS,
  normalizeAbyssalRunOutcome, normalizeAbyssalParticipantDestructionOperation,
  isSameAbyssalParticipantDestructionIdentity,
  isValidAbyssalParticipantDestructionOperation,
  evaluateAbyssalParticipantDestructionOperationTransition,
} = require("../domain/abyssalTerminalTransitionPolicy");
const { createAbyssalParticipantDestructionOperationCoordinator } =
  require("./abyssalParticipantDestructionOperationCoordinator");

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function ensureDurableAbyssalParticipantDestructionIntent(
  ports,
  pocketState,
  capsuleID,
  deps = ports.getDependencies(),
  options = {},
) {
  const {
    buildAbyssalPersistencePendingResult,
    clearPersistenceFailure,
    cloneValue,
    getAbyssalParticipantDestructionOperation,
    getAuthoritativeAbyssalPocketState,
  } = ports;
  const instanceID = toInt(pocketState && pocketState.instanceID, 0);
  const terminalCause = normalizeAbyssalRunOutcome(
    options.terminalCause || pocketState && pocketState.runOutcome,
  );
  const numericCapsuleID = toInt(capsuleID, 0);
  if (
    instanceID <= 0 ||
    numericCapsuleID <= 0 ||
    ![
      ABYSSAL_RUN_OUTCOME.FAILED_TIMEOUT,
      ABYSSAL_RUN_OUTCOME.FAILED_SHIP_DESTROYED,
      ABYSSAL_PARTICIPANT_TERMINAL_CAUSE.MEMBER_SHIP_DESTROYED,
    ].includes(terminalCause) ||
    (
      terminalCause !== ABYSSAL_PARTICIPANT_TERMINAL_CAUSE.MEMBER_SHIP_DESTROYED &&
      terminalCause !== normalizeAbyssalRunOutcome(pocketState && pocketState.runOutcome)
    )
  ) {
    return {
      success: false,
      pending: true,
      errorMsg: "ABYSSAL_PARTICIPANT_DESTRUCTION_TERMINAL_IDENTITY_INVALID",
      pocketState,
    };
  }

  const nowMs = Math.max(
    0,
    toInt(
      options.nowMs,
      deps && typeof deps.now === "function" ? deps.now() : Date.now(),
    ),
  );
  const { requestedIntent, existingOperation } = prepareDestructionIntent(
    ports, pocketState, numericCapsuleID, nowMs, terminalCause, options,
  );
  const existingResult = inspectExistingDestructionIntent(
    ports, pocketState, deps, existingOperation, requestedIntent,
  );
  if (existingResult) return existingResult;

  const intent = requestedIntent;
  const committedIntent = normalizeAbyssalParticipantDestructionOperation({
    ...cloneValue(intent),
    lastAttemptAtMs: nowMs,
    attemptCount: Math.max(0, toInt(intent.attemptCount, 0)),
    failureReason: "",
  });
  const commitResult = commitAbyssalParticipantDestructionOperationState(
    ports,
    pocketState,
    committedIntent,
    deps,
  );
  if (!commitResult || commitResult.success !== true) {
    return buildAbyssalPersistencePendingResult(
      pocketState,
      normalizeText(
        commitResult && commitResult.errorMsg,
        "ABYSSAL_PARTICIPANT_DESTRUCTION_INTENT_PERSIST_FAILED",
      ),
      deps,
      {
        defaultErrorMsg:
          "ABYSSAL_PARTICIPANT_DESTRUCTION_INTENT_PERSIST_FAILED",
        operation: existingOperation || null,
        persistenceResult: commitResult && commitResult.coordinatorResult &&
          commitResult.coordinatorResult.writeResult,
      },
    );
  }

  const updatedPocketState = cloneValue(
    commitResult.pocketState,
  ) || getAuthoritativeAbyssalPocketState(instanceID, pocketState);
  const committedOperation = getAbyssalParticipantDestructionOperation(
    updatedPocketState,
    intent.characterID,
  );
  if (
    !committedOperation ||
    !isSameAbyssalParticipantDestructionIdentity(intent, committedOperation)
  ) {
    return buildAbyssalPersistencePendingResult(
      updatedPocketState,
      "ABYSSAL_PARTICIPANT_DESTRUCTION_INTENT_REJECTED",
      deps,
      { operation: committedOperation },
    );
  }
  clearPersistenceFailure(instanceID);
  return {
    success: true,
    pending: false,
    pocketState: updatedPocketState,
    persistedInstance: commitResult.persistedInstance || null,
    persistedPocketState: commitResult.persistedPocketState || null,
    operation: committedOperation,
    alreadyDestroyed: false,
  };
}

function commitDurableAbyssalParticipantPodDestructionReceipt(
  ports,
  pocketState,
  deps = ports.getDependencies(),
  options = {},
) {
  const {
    buildAbyssalPersistencePendingResult,
    clearPendingAbyssalParticipantDestructionReceipt,
    clearPersistenceFailure,
    cloneValue,
    getAbyssalParticipantDestructionOperation,
    getAuthoritativeAbyssalPocketState,
  } = ports;
  const instanceID = toInt(pocketState && pocketState.instanceID, 0);
  const nowMs = Math.max(
    0,
    toInt(
      options.nowMs,
      deps && typeof deps.now === "function" ? deps.now() : Date.now(),
    ),
  );
  const terminalCause = normalizeAbyssalRunOutcome(
    options.terminalCause || pocketState && pocketState.runOutcome,
  );
  let operation = getAbyssalParticipantDestructionOperation(pocketState);
  const receiptCapsuleID = toInt(
    options.capsuleID,
    toInt(operation && operation.capsuleID, 0),
  );
  const authoritativeDeathHandoff =
    options.authoritativeDeathHandoff &&
    options.authoritativeDeathHandoff.committed === true
      ? cloneValue(options.authoritativeDeathHandoff)
      : null;
  const resolved = resolveReceiptOperation(
    ports, pocketState, options, terminalCause, receiptCapsuleID, nowMs,
    authoritativeDeathHandoff, operation,
  );
  if (resolved.success === false) return resolved;
  operation = resolved.operation;

  const destructionResult =
    options.podDestructionResult &&
    typeof options.podDestructionResult === "object"
      ? options.podDestructionResult
      : null;
  const resultDestroyedShipID = toInt(
    destructionResult &&
      destructionResult.data &&
      destructionResult.data.destroyedShipID,
    0,
  );
  if (
    resultDestroyedShipID > 0 &&
    operation.capsuleID > 0 &&
    resultDestroyedShipID !== operation.capsuleID
  ) {
    return {
      success: false,
      pending: true,
      errorMsg: "ABYSSAL_PARTICIPANT_DESTRUCTION_RESULT_IDENTITY_MISMATCH",
      pocketState,
      operation,
    };
  }

  const completedOperation = buildCompletedPodOperation(
    ports, operation, nowMs, options, resultDestroyedShipID, destructionResult,
    authoritativeDeathHandoff,
  );

  const commitResult = commitAbyssalParticipantDestructionOperationState(
    ports,
    pocketState,
    completedOperation,
    deps,
    {
      additionalPatch: buildPendingPodCleanupPatch(ports, pocketState, deps, terminalCause),
    },
  );
  if (!commitResult || commitResult.success !== true) {
    return buildAbyssalPersistencePendingResult(
      pocketState,
      normalizeText(
        commitResult && commitResult.errorMsg,
        "ABYSSAL_PARTICIPANT_DESTRUCTION_RECEIPT_PERSIST_FAILED",
      ),
      deps,
      {
        defaultErrorMsg:
          "ABYSSAL_PARTICIPANT_DESTRUCTION_RECEIPT_PERSIST_FAILED",
        operation,
        persistenceResult: commitResult && commitResult.coordinatorResult &&
          commitResult.coordinatorResult.writeResult,
      },
    );
  }

  const updatedPocketState = cloneValue(
    commitResult.pocketState,
  ) || getAuthoritativeAbyssalPocketState(instanceID, pocketState);
  const registeredOperation = getAbyssalParticipantDestructionOperation(
    updatedPocketState,
    completedOperation.characterID,
  );
  if (
    !registeredOperation ||
    registeredOperation.status !==
      ABYSSAL_PARTICIPANT_DESTRUCTION_OPERATION_STATUS.POD_DESTROYED ||
    !isSameAbyssalParticipantDestructionIdentity(
      completedOperation,
      registeredOperation,
    )
  ) {
    return buildAbyssalPersistencePendingResult(
      updatedPocketState,
      "ABYSSAL_PARTICIPANT_DESTRUCTION_RECEIPT_REJECTED",
      deps,
      { operation: registeredOperation },
    );
  }
  clearPendingAbyssalParticipantDestructionReceipt(instanceID);
  clearPersistenceFailure(instanceID);
  return {
    success: true,
    pending: false,
    pocketState: updatedPocketState,
    persistedInstance: commitResult.persistedInstance || null,
    persistedPocketState: commitResult.persistedPocketState || null,
    operation: registeredOperation,
  };
}

function commitAbyssalParticipantDestructionOperationState(
  ports,
  pocketState,
  operation,
  deps = ports.getDependencies(),
  options = {},
) {
  const {
    buildAbyssalParticipantDestructionOperationPatch,
    cloneValue,
    commitPocketStateDurably,
    getAbyssalParticipantDestructionOperation,
    getActivePocketStateByInstanceID,
    logRejectedAbyssalParticipantDestructionTransition,
    readPersistedAbyssalPocketStateFromInstance,
  } = ports;
  const normalized = normalizeAbyssalParticipantDestructionOperation(operation);
  const instanceID = toInt(pocketState && pocketState.instanceID, 0);
  if (
    instanceID <= 0 ||
    !normalized ||
    !isValidAbyssalParticipantDestructionOperation(normalized)
  ) {
    return {
      success: false,
      pending: true,
      errorMsg: "ABYSSAL_PARTICIPANT_DESTRUCTION_OPERATION_INVALID",
    };
  }

  const coordinator =
    createAbyssalParticipantDestructionOperationCoordinator({
      readParticipantOperation(
        requestedInstanceID,
        participantCharacterID,
        readOptions = {},
      ) {
        const writeResult = readOptions.writeResult || null;
        const authoritativeState = readOptions.phase === "readback"
          ? cloneValue(
              writeResult && (writeResult.committedState || writeResult.state),
            )
          : getActivePocketStateByInstanceID(requestedInstanceID) ||
            cloneValue(readOptions.fallbackState) ||
            null;
        return {
          state: authoritativeState,
          operation: getAbyssalParticipantDestructionOperation(
            authoritativeState,
            participantCharacterID,
          ),
        };
      },
      updateParticipantOperation(
        requestedInstanceID,
        _participantCharacterID,
        operationPatch,
      ) {
        return commitPocketStateDurably(
          requestedInstanceID,
          operationPatch,
          deps,
          {
            verifyReadBack: options.verifyReadBack !== false,
            forceWrite: true,
          },
        );
      },
    });
  const coordinatorResult =
    coordinator.commitAbyssalParticipantDestructionOperation({
      instanceID,
      participantCharacterID: normalized.characterID,
      currentState: pocketState,
      requestedOperation: normalized,
      operationPatch: ({ state }) => {
        const intrinsicPatch =
          buildAbyssalParticipantDestructionOperationPatch(
            state || pocketState,
            normalized,
          );
        const additionalPatch = typeof options.additionalPatch === "function"
          ? options.additionalPatch({
              state: state || pocketState,
              operation: normalized,
            })
          : options.additionalPatch;
        return {
          ...(additionalPatch && typeof additionalPatch === "object"
            ? cloneValue(additionalPatch)
            : {}),
          ...intrinsicPatch,
        };
      },
    });
  if (!coordinatorResult || coordinatorResult.committed !== true) {
    if (
      coordinatorResult &&
      coordinatorResult.transition &&
      coordinatorResult.transition.allowed === false
    ) {
      logRejectedAbyssalParticipantDestructionTransition(
        pocketState,
        coordinatorResult.transition,
      );
    }
    return {
      success: false,
      pending: true,
      errorMsg: normalizeText(
        coordinatorResult && coordinatorResult.errorMsg,
        "ABYSSAL_PARTICIPANT_DESTRUCTION_PERSIST_FAILED",
      ),
      pocketState:
        cloneValue(coordinatorResult && coordinatorResult.state) || pocketState,
      operation:
        cloneValue(coordinatorResult && coordinatorResult.operation) || null,
      coordinatorResult,
    };
  }
  const committedState = cloneValue(coordinatorResult.state);
  const committedOperation = cloneValue(coordinatorResult.operation);
  const writeResult = coordinatorResult.writeResult || null;
  return {
    success: true,
    pending: false,
    pocketState: committedState,
    operation: committedOperation,
    persistedInstance:
      (
        writeResult &&
        writeResult.persistenceResult &&
        writeResult.persistenceResult.instance
      ) || null,
    persistedPocketState:
      readPersistedAbyssalPocketStateFromInstance(
        writeResult &&
          writeResult.persistenceResult &&
          writeResult.persistenceResult.instance,
      ),
    coordinatorResult,
  };
}

function prepareDestructionIntent(
  ports, pocketState, numericCapsuleID, nowMs, terminalCause, options,
) {
  const { buildAbyssalParticipantDestructionIntent, getAbyssalParticipantDestructionOperation, cloneValue } = ports;
  let requestedIntent = buildAbyssalParticipantDestructionIntent(
    pocketState,
    numericCapsuleID,
    nowMs,
    {
      terminalCause,
      identityMode: "exact_capsule",
      intentSource: normalizeText(options.intentSource, "abyssal-manager"),
    },
  );
  const existingOperation = getAbyssalParticipantDestructionOperation(
    pocketState,
    toInt(pocketState && pocketState.characterID, 0),
  );
  if (
    existingOperation &&
    [
      ABYSSAL_PARTICIPANT_DESTRUCTION_OPERATION_STATUS.HULL_INTENT_COMMITTED,
      ABYSSAL_PARTICIPANT_DESTRUCTION_OPERATION_STATUS.HULL_DESTROYED,
      ABYSSAL_PARTICIPANT_DESTRUCTION_OPERATION_STATUS.INTENT_COMMITTED,
    ].includes(existingOperation.status)
  ) {
    requestedIntent = normalizeAbyssalParticipantDestructionOperation({
      ...cloneValue(existingOperation),
      status: ABYSSAL_PARTICIPANT_DESTRUCTION_OPERATION_STATUS.INTENT_COMMITTED,
      capsuleID: numericCapsuleID,
      identityMode: existingOperation.identityMode,
      intentCommittedAtMs: toInt(existingOperation.intentCommittedAtMs, 0) || nowMs,
      lastAttemptAtMs: nowMs,
      failureReason: "",
    });
  }
  return { requestedIntent, existingOperation };
}

function inspectExistingDestructionIntent(
  ports, pocketState, deps, existingOperation, requestedIntent,
) {
  const { logRejectedAbyssalParticipantDestructionTransition, persistAndVerifyAbyssalParticipantDestructionOperation, getAuthoritativeAbyssalPocketState } = ports;
  const instanceID = toInt(pocketState && pocketState.instanceID, 0);
  if (existingOperation) {
    if (
      existingOperation.status ===
      ABYSSAL_PARTICIPANT_DESTRUCTION_OPERATION_STATUS.POD_DESTROYED
    ) {
      if (
        !isSameAbyssalParticipantDestructionIdentity(
          existingOperation,
          requestedIntent,
        )
      ) {
        const conflict = {
          allowed: false,
          idempotent: false,
          reason: "DESTRUCTION_OPERATION_IDENTITY_CONFLICT",
          current: existingOperation,
          requested: requestedIntent,
        };
        logRejectedAbyssalParticipantDestructionTransition(
          pocketState,
          conflict,
        );
        return {
          success: false,
          pending: true,
          errorMsg: conflict.reason,
          pocketState,
          operation: existingOperation,
        };
      }
      const verification =
        persistAndVerifyAbyssalParticipantDestructionOperation(
          pocketState,
          deps,
          existingOperation,
        );
      return {
        ...verification,
        alreadyDestroyed: verification.success === true,
        pocketState: getAuthoritativeAbyssalPocketState(instanceID, pocketState),
        operation: existingOperation,
      };
    }
    const transition = evaluateAbyssalParticipantDestructionOperationTransition(
      existingOperation,
      requestedIntent,
    );
    if (!transition.allowed) {
      logRejectedAbyssalParticipantDestructionTransition(
        pocketState,
        transition,
      );
      return {
        success: false,
        pending: true,
        errorMsg: normalizeText(
          transition.reason,
          "ABYSSAL_PARTICIPANT_DESTRUCTION_OPERATION_CONFLICT",
        ),
        pocketState,
        operation: existingOperation,
      };
    }
  }

  return null;
}

function resolveReceiptOperation(
  ports, pocketState, options, terminalCause, receiptCapsuleID, nowMs,
  authoritativeDeathHandoff, operation,
) {
  const { buildAbyssalParticipantDestructionIntent, buildAbyssalParticipantDestructionOperationID } = ports;
  const instanceID = toInt(pocketState && pocketState.instanceID, 0);
  if (!operation) {
    if (!options.podAlreadyDestroyed) {
      return {
        success: false,
        pending: true,
        errorMsg: "ABYSSAL_PARTICIPANT_DESTRUCTION_INTENT_MISSING",
        pocketState,
      };
    }
    const identityMode = receiptCapsuleID > 0
      ? "exact_capsule"
      : authoritativeDeathHandoff
        ? "authoritative_clone_handoff"
        : "";
    if (!identityMode) {
      return {
        success: false,
        pending: true,
        errorMsg: "ABYSSAL_PARTICIPANT_DESTRUCTION_RECEIPT_IDENTITY_MISSING",
        pocketState,
      };
    }
    operation = buildAbyssalParticipantDestructionIntent(
      pocketState,
      receiptCapsuleID,
      nowMs,
      {
        terminalCause,
        identityMode,
        intentSource: authoritativeDeathHandoff
          ? "startup-authoritative-clone-handoff"
          : "external-pod-destruction-callback",
      },
    );
    if (identityMode === "authoritative_clone_handoff") {
      operation.operationID = buildAbyssalParticipantDestructionOperationID({
        ...operation,
        capsuleID: 0,
        identityMode,
      });
    }
  }
  if (
    operation.terminalCause !== terminalCause ||
    operation.runID !== instanceID ||
    operation.characterID !== toInt(pocketState && pocketState.characterID, 0) ||
    operation.originalShipID !== toInt(pocketState && pocketState.shipID, 0) ||
    (
      operation.capsuleID > 0 &&
      receiptCapsuleID > 0 &&
      operation.capsuleID !== receiptCapsuleID
    )
  ) {
    return {
      success: false,
      pending: true,
      errorMsg: "ABYSSAL_PARTICIPANT_DESTRUCTION_RECEIPT_IDENTITY_CONFLICT",
      pocketState,
      operation,
    };
  }

  return { operation };
}

function buildCompletedPodOperation(ports, operation, nowMs, options, resultDestroyedShipID, destructionResult, authoritativeDeathHandoff) {
  const { cloneValue } = ports;
  const completedOperation = normalizeAbyssalParticipantDestructionOperation({
    ...cloneValue(operation),
    status: ABYSSAL_PARTICIPANT_DESTRUCTION_OPERATION_STATUS.POD_DESTROYED,
    podDestroyedAtMs: toInt(operation.podDestroyedAtMs, 0) || nowMs,
    lastAttemptAtMs: nowMs,
    attemptCount: Math.max(0, toInt(operation.attemptCount, 0)) +
      (options.incrementAttempt === false ? 0 : 1),
    failureReason: "",
    receipt: {
      schemaVersion: 1,
      operationID: operation.operationID,
      runID: operation.runID,
      characterID: operation.characterID,
      originalShipID: operation.originalShipID,
      capsuleID: operation.capsuleID,
      destroyedShipID:
        resultDestroyedShipID || operation.capsuleID || null,
      corpseItemID: toInt(
        destructionResult &&
          destructionResult.data &&
          destructionResult.data.corpse &&
          destructionResult.data.corpse.itemID,
        0,
      ) || null,
      destinationStationID: toInt(
        destructionResult &&
          destructionResult.data &&
          destructionResult.data.station &&
          destructionResult.data.station.stationID,
        0,
      ) || null,
      receiptSource: authoritativeDeathHandoff
        ? "authoritative_clone_handoff"
        : normalizeText(options.receiptSource, "destroySessionShip"),
      authoritativeDeathHandoff,
      committedAtMs: nowMs,
    },
  });
  return completedOperation;
}

function buildPendingPodCleanupPatch(ports, pocketState, deps, terminalCause) {
  const { getAbyssalTimeoutState, ABYSSAL_TIMEOUT_POD_STATUS } = ports;
  const timeoutState = {
    ...getAbyssalTimeoutState(pocketState, deps),
    shipDestroyed: true,
    podDestroyed: true,
    cleanupTriggered: false,
    reason: terminalCause === ABYSSAL_RUN_OUTCOME.FAILED_TIMEOUT
      ? "LETHAL_TIMEOUT_PENDING_CLEANUP"
      : "ABYSSAL_PARTICIPANT_DESTRUCTION_PENDING_CLEANUP",
    podDestructionReason: ABYSSAL_TIMEOUT_POD_STATUS.SHIP_AND_POD_DESTROYED,
  };
  return {
    allowDebugExit: false,
    timerFailureState: terminalCause === ABYSSAL_RUN_OUTCOME.FAILED_TIMEOUT
      ? "failed_timeout_lethal_cleanup_retry"
      : "failed_ship_destroyed_cleanup_retry",
    timeoutState,
  };
}

// Bind capabilities, not engine imports or mutable run state. The factory itself
// also meets the final function-size limit; each operation is independently bounded.
function createAbyssalDestructionCommits(ports) {
  return {
    ensureDurableAbyssalParticipantDestructionIntent: ensureDurableAbyssalParticipantDestructionIntent.bind(null, ports),
    commitDurableAbyssalParticipantPodDestructionReceipt: commitDurableAbyssalParticipantPodDestructionReceipt.bind(null, ports),
    commitAbyssalParticipantDestructionOperationState: commitAbyssalParticipantDestructionOperationState.bind(null, ports),
  };
}

module.exports = { createAbyssalDestructionCommits };
