"use strict";

function toInstanceID(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  const integer = Math.trunc(numeric);
  return integer > 0 ? integer : 0;
}

function cloneSnapshot(value, seen = new WeakMap()) {
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return seen.get(value);
  if (value instanceof Date) return new Date(value.getTime());
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (Array.isArray(value)) {
    const clone = [];
    seen.set(value, clone);
    for (const entry of value) clone.push(cloneSnapshot(entry, seen));
    return clone;
  }
  if (value instanceof Map) {
    const clone = new Map();
    seen.set(value, clone);
    for (const [key, entry] of value.entries()) {
      clone.set(cloneSnapshot(key, seen), cloneSnapshot(entry, seen));
    }
    return clone;
  }
  if (value instanceof Set) {
    const clone = new Set();
    seen.set(value, clone);
    for (const entry of value.values()) clone.add(cloneSnapshot(entry, seen));
    return clone;
  }
  const clone = {};
  seen.set(value, clone);
  for (const key of Object.keys(value)) {
    clone[key] = cloneSnapshot(value[key], seen);
  }
  return clone;
}

function createPassMetrics() {
  return {
    passCount: 0,
    overlapSkipCount: 0,
    totalDurationMs: 0,
    lastDurationMs: 0,
    lastPassWriteCount: 0,
    totalWriteCount: 0,
  };
}

function tryBeginPass({ state, passMetrics }) {
  if (state.running) {
    passMetrics.overlapSkipCount += 1;
    return {
      started: false,
      reason: "MAINTENANCE_ALREADY_RUNNING",
    };
  }
  state.running = true;
  state.activeWriteCount = 0;
  return {
    started: true,
    reason: null,
  };
}

function recordWrite({ state }, count = 1) {
  if (!state.running) return state.activeWriteCount;
  const numericCount = Number(count);
  const increment = Number.isFinite(numericCount)
    ? Math.max(0, Math.trunc(numericCount))
    : 0;
  state.activeWriteCount += increment;
  return state.activeWriteCount;
}

function finishPass({ state, passMetrics }, durationMs = 0) {
  if (!state.running) {
    return {
      finished: false,
      writeCount: 0,
    };
  }
  const numericDurationMs = Number(durationMs);
  const normalizedDurationMs = Number.isFinite(numericDurationMs)
    ? Math.max(0, numericDurationMs)
    : 0;
  const writeCount = state.activeWriteCount;
  state.running = false;
  state.activeWriteCount = 0;
  passMetrics.passCount += 1;
  passMetrics.lastDurationMs = normalizedDurationMs;
  passMetrics.totalDurationMs += normalizedDurationMs;
  passMetrics.lastPassWriteCount = writeCount;
  passMetrics.totalWriteCount += writeCount;
  return {
    finished: true,
    writeCount,
  };
}

function isPassRunning({ state }) {
  return state.running;
}

function getActiveWriteCount({ state }) {
  return state.activeWriteCount;
}

function getPassMetrics({ passMetrics, state }) {
  return {
    ...passMetrics,
    active: state.running,
  };
}

function hasTimerHandle({ state }) {
  return state.timerHandle !== null;
}

function setTimerHandle({ state }, handle) {
  if (handle === undefined || handle === null) {
    throw new TypeError("maintenance timer handle is required");
  }
  if (state.timerHandle !== null) {
    throw new Error("maintenance timer handle is already registered");
  }
  state.timerHandle = handle;
  return handle;
}

function cancelTimerHandle({ state }, clearScheduledTimeout = null) {
  const handle = state.timerHandle;
  if (handle === null) return null;
  if (typeof clearScheduledTimeout !== "function") {
    throw new Error("maintenance timer cancellation is unavailable");
  }
  clearScheduledTimeout(handle);
  if (state.timerHandle === handle) state.timerHandle = null;
  return handle;
}

function takeTimerHandle({ state }) {
  const handle = state.timerHandle;
  state.timerHandle = null;
  return handle;
}

function takeTimerHandleIfCurrent({ state }, expectedHandle) {
  if (
    expectedHandle === null ||
    expectedHandle === undefined ||
    state.timerHandle !== expectedHandle
  ) {
    return null;
  }
  state.timerHandle = null;
  return expectedHandle;
}

function setRuntimeTelemetry({ cloneValue, runtimeTelemetryByInstanceID }, instanceID, telemetry) {
  const numericInstanceID = toInstanceID(instanceID);
  if (numericInstanceID <= 0) return null;
  const snapshot = cloneValue(telemetry && typeof telemetry === "object" ? telemetry : {});
  runtimeTelemetryByInstanceID.set(numericInstanceID, snapshot);
  return cloneValue(snapshot);
}

function getRuntimeTelemetry({ runtimeTelemetryByInstanceID, cloneValue }, instanceID) {
  const telemetry = runtimeTelemetryByInstanceID.get(toInstanceID(instanceID)) || null;
  return telemetry ? cloneValue(telemetry) : null;
}

function deleteRuntimeTelemetry({ runtimeTelemetryByInstanceID }, instanceID) {
  return runtimeTelemetryByInstanceID.delete(toInstanceID(instanceID));
}

function getRuntimeTelemetryCount({ runtimeTelemetryByInstanceID }) {
  return runtimeTelemetryByInstanceID.size;
}

function setRecoveryRetryState({ cloneValue, recoveryRetryStateByInstanceID }, instanceID, retryState) {
  const numericInstanceID = toInstanceID(instanceID);
  if (numericInstanceID <= 0) return null;
  const snapshot = cloneValue(retryState && typeof retryState === "object" ? retryState : {});
  recoveryRetryStateByInstanceID.set(numericInstanceID, snapshot);
  return cloneValue(snapshot);
}

function hasRecoveryRetryState({ recoveryRetryStateByInstanceID }, instanceID) {
  return recoveryRetryStateByInstanceID.has(toInstanceID(instanceID));
}

function getRecoveryRetryState({ recoveryRetryStateByInstanceID, cloneValue }, instanceID) {
  const retryState = recoveryRetryStateByInstanceID.get(toInstanceID(instanceID)) || null;
  return retryState ? cloneValue(retryState) : null;
}

function deleteRecoveryRetryState({ recoveryRetryStateByInstanceID }, instanceID) {
  return recoveryRetryStateByInstanceID.delete(toInstanceID(instanceID));
}

function listRecoveryRetryStates({ recoveryRetryStateByInstanceID, cloneValue }) {
  return [...recoveryRetryStateByInstanceID.values()].map((entry) => cloneValue(entry));
}

function getRecoveryRetryCount({ recoveryRetryStateByInstanceID }) {
  return recoveryRetryStateByInstanceID.size;
}

function getStartupRecoveryState({ state, cloneValue }) {
  return {
    resetApplied: state.restartResetApplied,
    discoveryApplied: state.restartDiscoveryApplied,
    resetResult: cloneValue(state.restartResetResult),
  };
}

function setStartupResetApplied({ state }, applied) {
  state.restartResetApplied = applied === true;
  return state.restartResetApplied;
}

function setStartupDiscoveryApplied({ state }, applied) {
  state.restartDiscoveryApplied = applied === true;
  return state.restartDiscoveryApplied;
}

function setStartupResetResult({ state, cloneValue }, result) {
  state.restartResetResult = result && typeof result === "object"
    ? cloneValue(result)
    : null;
  return cloneValue(state.restartResetResult);
}

function setLastCleanupReport({ state, cloneValue }, report) {
  state.lastCleanupReport = report && typeof report === "object"
    ? cloneValue(report)
    : null;
  return cloneValue(state.lastCleanupReport);
}

function getLastCleanupReport({ cloneValue, state }) {
  return cloneValue(state.lastCleanupReport);
}

function reset({ takeTimerHandle, state, passMetrics, runtimeTelemetryByInstanceID, recoveryRetryStateByInstanceID }, options = {}) {
  const preserveTimerHandle = options.preserveTimerHandle === true;
  const pendingTimerHandle = preserveTimerHandle ? null : takeTimerHandle();
  state.running = false;
  state.activeWriteCount = 0;
  Object.assign(passMetrics, createPassMetrics());
  runtimeTelemetryByInstanceID.clear();
  recoveryRetryStateByInstanceID.clear();
  state.restartResetApplied = false;
  state.restartDiscoveryApplied = false;
  state.restartResetResult = null;
  state.lastCleanupReport = null;
  const result = {
    timerHandle: pendingTimerHandle,
  };
  if (preserveTimerHandle) result.preservedTimerHandle = state.timerHandle;
  return result;
}

// Mutable values stay private to this owner; only bound operations escape.
function createAbyssalMaintenanceState(options = {}) {
  const cloneValue = typeof options.cloneValue === "function"
    ? options.cloneValue
    : cloneSnapshot;
  const passMetrics = createPassMetrics();
  const runtimeTelemetryByInstanceID = new Map();
  const recoveryRetryStateByInstanceID = new Map();
  const state = {
    timerHandle: null,
    running: false,
    activeWriteCount: 0,
    restartResetApplied: false,
    restartDiscoveryApplied: false,
    restartResetResult: null,
    lastCleanupReport: null,
  };
  const ports = { state, cloneValue, passMetrics, runtimeTelemetryByInstanceID, recoveryRetryStateByInstanceID };
  ports.tryBeginPass = tryBeginPass.bind(null, ports);
  ports.recordWrite = recordWrite.bind(null, ports);
  ports.finishPass = finishPass.bind(null, ports);
  ports.isPassRunning = isPassRunning.bind(null, ports);
  ports.getActiveWriteCount = getActiveWriteCount.bind(null, ports);
  ports.getPassMetrics = getPassMetrics.bind(null, ports);
  ports.hasTimerHandle = hasTimerHandle.bind(null, ports);
  ports.setTimerHandle = setTimerHandle.bind(null, ports);
  ports.cancelTimerHandle = cancelTimerHandle.bind(null, ports);
  ports.takeTimerHandle = takeTimerHandle.bind(null, ports);
  ports.takeTimerHandleIfCurrent = takeTimerHandleIfCurrent.bind(null, ports);
  ports.setRuntimeTelemetry = setRuntimeTelemetry.bind(null, ports);
  ports.getRuntimeTelemetry = getRuntimeTelemetry.bind(null, ports);
  ports.deleteRuntimeTelemetry = deleteRuntimeTelemetry.bind(null, ports);
  ports.getRuntimeTelemetryCount = getRuntimeTelemetryCount.bind(null, ports);
  ports.setRecoveryRetryState = setRecoveryRetryState.bind(null, ports);
  ports.hasRecoveryRetryState = hasRecoveryRetryState.bind(null, ports);
  ports.getRecoveryRetryState = getRecoveryRetryState.bind(null, ports);
  ports.deleteRecoveryRetryState = deleteRecoveryRetryState.bind(null, ports);
  ports.listRecoveryRetryStates = listRecoveryRetryStates.bind(null, ports);
  ports.getRecoveryRetryCount = getRecoveryRetryCount.bind(null, ports);
  ports.getStartupRecoveryState = getStartupRecoveryState.bind(null, ports);
  ports.setStartupResetApplied = setStartupResetApplied.bind(null, ports);
  ports.setStartupDiscoveryApplied = setStartupDiscoveryApplied.bind(null, ports);
  ports.setStartupResetResult = setStartupResetResult.bind(null, ports);
  ports.setLastCleanupReport = setLastCleanupReport.bind(null, ports);
  ports.getLastCleanupReport = getLastCleanupReport.bind(null, ports);
  ports.reset = reset.bind(null, ports);
  Object.freeze(ports);
  return Object.freeze({
    tryBeginPass: ports.tryBeginPass,
    recordWrite: ports.recordWrite,
    finishPass: ports.finishPass,
    isPassRunning: ports.isPassRunning,
    getActiveWriteCount: ports.getActiveWriteCount,
    getPassMetrics: ports.getPassMetrics,
    hasTimerHandle: ports.hasTimerHandle,
    setTimerHandle: ports.setTimerHandle,
    cancelTimerHandle: ports.cancelTimerHandle,
    takeTimerHandle: ports.takeTimerHandle,
    takeTimerHandleIfCurrent: ports.takeTimerHandleIfCurrent,
    setRuntimeTelemetry: ports.setRuntimeTelemetry,
    getRuntimeTelemetry: ports.getRuntimeTelemetry,
    deleteRuntimeTelemetry: ports.deleteRuntimeTelemetry,
    getRuntimeTelemetryCount: ports.getRuntimeTelemetryCount,
    setRecoveryRetryState: ports.setRecoveryRetryState,
    hasRecoveryRetryState: ports.hasRecoveryRetryState,
    getRecoveryRetryState: ports.getRecoveryRetryState,
    deleteRecoveryRetryState: ports.deleteRecoveryRetryState,
    listRecoveryRetryStates: ports.listRecoveryRetryStates,
    getRecoveryRetryCount: ports.getRecoveryRetryCount,
    getStartupRecoveryState: ports.getStartupRecoveryState,
    setStartupResetApplied: ports.setStartupResetApplied,
    setStartupDiscoveryApplied: ports.setStartupDiscoveryApplied,
    setStartupResetResult: ports.setStartupResetResult,
    setLastCleanupReport: ports.setLastCleanupReport,
    getLastCleanupReport: ports.getLastCleanupReport,
    reset: ports.reset,
  });
}

const abyssalMaintenanceState = createAbyssalMaintenanceState();

module.exports = {
  abyssalMaintenanceState,
  createAbyssalMaintenanceState,
};
