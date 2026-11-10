"use strict";

const { normalizeText } = require("../domain/abyssalValueUtils");

// Stateless operations; ownership remains with the injected registry and persistence ports.
function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function markAbyssalParticipantDestructionPersistenceFailure(ports,
  pocketState,
  errorMsg,
  deps = ports.getDependencies(),
) {
  const {
    setPersistenceFailure,
    deletePersistedStateSignature,
  } = ports;
  const instanceID = toInt(pocketState && pocketState.instanceID, 0);
  const normalizedError = normalizeText(
    errorMsg,
    "ABYSSAL_PARTICIPANT_DESTRUCTION_PERSIST_FAILED",
  );
  if (instanceID > 0) {
    setPersistenceFailure(instanceID, {
      instanceID,
      errorMsg: normalizedError,
      failedAtMs: toInt(
        deps && typeof deps.now === "function" ? deps.now() : Date.now(),
        Date.now(),
      ),
    });
    deletePersistedStateSignature(instanceID);
  }
  return {
    success: false,
    pending: true,
    errorMsg: normalizedError,
  };
}

function persistAndVerifyAbyssalParticipantDestructionOperation(ports,
  pocketState,
  deps = ports.getDependencies(),
  expectedOperation = null,
) {
  const {
    normalizeAbyssalParticipantDestructionOperation,
    getAbyssalParticipantDestructionOperation,
    commitAbyssalParticipantDestructionOperationState,
    cloneValue,
    deletePersistenceFailure,
  } = ports;
  const operation = normalizeAbyssalParticipantDestructionOperation(
    expectedOperation || getAbyssalParticipantDestructionOperation(pocketState),
  );
  const commitResult = commitAbyssalParticipantDestructionOperationState(
    pocketState,
    operation,
    deps,
  );
  if (!commitResult || commitResult.success !== true) {
    return {
      ...markAbyssalParticipantDestructionPersistenceFailure(ports,
        pocketState,
        normalizeText(
          commitResult && commitResult.errorMsg,
          "ABYSSAL_PARTICIPANT_DESTRUCTION_PERSIST_FAILED",
        ),
        deps,
      ),
      pocketState:
        cloneValue(commitResult && commitResult.pocketState) || pocketState,
      operation: cloneValue(commitResult && commitResult.operation) || operation,
      coordinatorResult: commitResult && commitResult.coordinatorResult || null,
    };
  }
  deletePersistenceFailure(
    toInt(pocketState && pocketState.instanceID, 0),
  );
  return commitResult;
}

function getAuthoritativeAbyssalPocketState(ports, instanceID, fallbackState = null) {
  const {
    cloneValue,
    getActivePocketStateByInstanceID,
  } = ports;
  return (
    getActivePocketStateByInstanceID(toInt(instanceID, 0)) ||
    cloneValue(fallbackState) ||
    null
  );
}

function buildAbyssalPersistencePendingResult(ports,
  pocketState,
  errorMsg,
  deps = ports.getDependencies(),
  options = {},
) {
  const {
    cloneValue,
    ABYSSAL_POCKET_PERSISTENCE_ERROR,
    setPersistenceFailure,
    deletePersistedStateSignature,
  } = ports;
  const instanceID = toInt(pocketState && pocketState.instanceID, 0);
  const normalizedError = normalizeText(
    errorMsg,
    options.defaultErrorMsg || ABYSSAL_POCKET_PERSISTENCE_ERROR,
  );
  if (instanceID > 0) {
    setPersistenceFailure(instanceID, {
      instanceID,
      errorMsg: normalizedError,
      failedAtMs: toInt(
        deps && typeof deps.now === "function" ? deps.now() : Date.now(),
        Date.now(),
      ),
    });
    deletePersistedStateSignature(instanceID);
  }
  return {
    success: false,
    pending: true,
    persistencePending: true,
    errorMsg: normalizedError,
    pocketState: getAuthoritativeAbyssalPocketState(ports, instanceID, pocketState),
    operation: options.operation || null,
    persistenceResult: cloneValue(options.persistenceResult) || null,
  };
}

function rememberPendingAbyssalParticipantDestructionReceipt(ports,
  pocketState,
  operation,
  options = {},
) {
  const {
    normalizeAbyssalParticipantDestructionOperation,
    getAbyssalParticipantDestructionOperation,
    cloneValue,
    isValidAbyssalParticipantDestructionOperation,
    setParticipantDestructionReceipt,
  } = ports;
  const instanceID = toInt(pocketState && pocketState.instanceID, 0);
  const normalizedOperation = normalizeAbyssalParticipantDestructionOperation(
    operation || getAbyssalParticipantDestructionOperation(pocketState),
  );
  if (
    instanceID <= 0 ||
    !normalizedOperation ||
    normalizedOperation.runID !== instanceID ||
    !isValidAbyssalParticipantDestructionOperation(normalizedOperation)
  ) {
    return null;
  }
  const evidence = {
    instanceID,
    operationID: normalizedOperation.operationID,
    characterID: normalizedOperation.characterID,
    terminalCause: normalizedOperation.terminalCause,
    capsuleID: toInt(
      options.capsuleID,
      toInt(normalizedOperation.capsuleID, 0),
    ),
    podDestructionResult:
      cloneValue(options.podDestructionResult) || null,
    authoritativeDeathHandoff:
      cloneValue(options.authoritativeDeathHandoff) || null,
    receiptSource: normalizeText(
      options.receiptSource,
      "pending-pod-destruction-receipt",
    ),
    recordedAtMs: Math.max(0, toInt(options.nowMs, Date.now())),
  };
  setParticipantDestructionReceipt(
    normalizedOperation.operationID,
    evidence,
  );
  return cloneValue(evidence);
}

function getPendingAbyssalParticipantDestructionReceipt(ports,
  pocketState,
  operation = null,
) {
  const {
    normalizeAbyssalParticipantDestructionOperation,
    getAbyssalParticipantDestructionOperation,
    cloneValue,
    getParticipantDestructionReceipt,
    deleteParticipantDestructionReceipt,
  } = ports;
  const instanceID = toInt(pocketState && pocketState.instanceID, 0);
  if (instanceID <= 0) return null;
  const normalizedOperation = normalizeAbyssalParticipantDestructionOperation(
    operation || getAbyssalParticipantDestructionOperation(pocketState),
  );
  const evidence = normalizedOperation
    ? getParticipantDestructionReceipt(
        normalizedOperation.operationID,
      ) || null
    : null;
  if (!evidence) return null;
  if (
    !normalizedOperation ||
    evidence.operationID !== normalizedOperation.operationID ||
    evidence.terminalCause !== normalizedOperation.terminalCause ||
    (
      toInt(evidence.capsuleID, 0) > 0 &&
      toInt(normalizedOperation.capsuleID, 0) > 0 &&
      toInt(evidence.capsuleID, 0) !== toInt(normalizedOperation.capsuleID, 0)
    )
  ) {
    deleteParticipantDestructionReceipt(
      normalizedOperation.operationID,
    );
    return null;
  }
  return cloneValue(evidence);
}

function clearPendingAbyssalParticipantDestructionReceipt(ports,
  instanceID,
  characterID = 0,
) {
  const {
    deleteParticipantDestructionReceipt,
    listParticipantDestructionReceipts,
  } = ports;
  const numericInstanceID = toInt(instanceID, 0);
  const numericCharacterID = toInt(characterID, 0);
  for (const [operationID, evidence] of
    listParticipantDestructionReceipts()) {
    if (
      toInt(evidence && evidence.instanceID, 0) === numericInstanceID &&
      (
        numericCharacterID <= 0 ||
        toInt(evidence && evidence.characterID, 0) === numericCharacterID
      )
    ) {
      deleteParticipantDestructionReceipt(operationID);
    }
  }
}

function createAbyssalDestructionReceipts(ports) {
  return {
    markAbyssalParticipantDestructionPersistenceFailure: markAbyssalParticipantDestructionPersistenceFailure.bind(null, ports),
    persistAndVerifyAbyssalParticipantDestructionOperation: persistAndVerifyAbyssalParticipantDestructionOperation.bind(null, ports),
    getAuthoritativeAbyssalPocketState: getAuthoritativeAbyssalPocketState.bind(null, ports),
    buildAbyssalPersistencePendingResult: buildAbyssalPersistencePendingResult.bind(null, ports),
    rememberPendingAbyssalParticipantDestructionReceipt: rememberPendingAbyssalParticipantDestructionReceipt.bind(null, ports),
    getPendingAbyssalParticipantDestructionReceipt: getPendingAbyssalParticipantDestructionReceipt.bind(null, ports),
    clearPendingAbyssalParticipantDestructionReceipt: clearPendingAbyssalParticipantDestructionReceipt.bind(null, ports),
  };
}

module.exports = { createAbyssalDestructionReceipts };
