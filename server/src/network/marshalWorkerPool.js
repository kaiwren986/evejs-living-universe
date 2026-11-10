"use strict";

// Bounded, lazy worker pool for coarse MachoNet marshal and cached-object
// compression tasks. Small values remain synchronous; queue saturation,
// worker failure, and timeouts deliberately fall back to the caller's inline
// encoder so transport behavior remains available under overload.

const os = require("node:os");
const path = require("node:path");
const { AsyncLocalStorage } = require("node:async_hooks");
const { performance } = require("node:perf_hooks");
const { Worker } = require("node:worker_threads");

const WORKER_PATH = path.join(__dirname, "marshalWorkerPool.worker.js");
const offloadContext = new AsyncLocalStorage();

function runWithOffloadContext(callback) {
  return offloadContext.run(true, callback);
}

function isOffloadContextActive() {
  return offloadContext.getStore() === true;
}

function readInteger(value, fallback, minimum = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= minimum
    ? Math.trunc(numeric)
    : fallback;
}

function defaultWorkerCount() {
  const available = typeof os.availableParallelism === "function"
    ? os.availableParallelism()
    : os.cpus().length;
  return Math.max(1, Math.min(2, available - 1));
}

function estimateMarshalWork(value, thresholds = {}) {
  const byteThreshold = readInteger(
    thresholds.byteThreshold,
    Number.POSITIVE_INFINITY,
  );
  const nodeThreshold = readInteger(
    thresholds.nodeThreshold,
    Number.POSITIVE_INFINITY,
  );
  const stack = [value];
  const seen = new WeakSet();
  let estimatedBytes = 0;
  let nodes = 0;

  while (stack.length > 0) {
    const current = stack.pop();
    nodes += 1;

    if (typeof current === "string") {
      estimatedBytes += Buffer.byteLength(current);
    } else if (typeof current === "number" || typeof current === "bigint") {
      estimatedBytes += 8;
    } else if (typeof current === "boolean") {
      estimatedBytes += 1;
    } else if (Buffer.isBuffer(current) || current instanceof Uint8Array) {
      estimatedBytes += current.byteLength;
    } else if (current && typeof current === "object") {
      if (!seen.has(current)) {
        seen.add(current);
        if (Array.isArray(current)) {
          for (let index = current.length - 1; index >= 0; index -= 1) {
            stack.push(current[index]);
          }
        } else {
          const keys = Object.keys(current);
          for (let index = keys.length - 1; index >= 0; index -= 1) {
            estimatedBytes += Buffer.byteLength(keys[index]);
            stack.push(current[keys[index]]);
          }
        }
      }
    }

    if (estimatedBytes >= byteThreshold || nodes >= nodeThreshold) {
      return {
        estimatedBytes,
        nodes,
        thresholdReached: true,
        truncated: stack.length > 0,
      };
    }
  }

  return {
    estimatedBytes,
    nodes,
    thresholdReached: false,
    truncated: false,
  };
}

function restoreWorkerBuffers(value, seen = new WeakSet()) {
  if (!value || typeof value !== "object" || Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  if (seen.has(value)) return value;
  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      value[index] = restoreWorkerBuffers(value[index], seen);
    }
    return value;
  }
  for (const key of Object.keys(value)) {
    value[key] = restoreWorkerBuffers(value[key], seen);
  }
  return value;
}

function normalizeWorkerResult(result) {
  return restoreWorkerBuffers(result);
}

function createPool(options = {}) {
  const configuredSize = readInteger(
    options.size,
    readInteger(process.env.EVEJS_MARSHAL_WORKER_COUNT, defaultWorkerCount()),
  );
  const enabled = options.enabled === undefined
    ? process.env.EVEJS_MARSHAL_WORKER_POOL !== "0" && configuredSize > 0
    : options.enabled === true && configuredSize > 0;
  const size = enabled ? configuredSize : 0;
  const maxQueue = readInteger(
    options.maxQueue,
    readInteger(process.env.EVEJS_MARSHAL_WORKER_MAX_QUEUE, 64),
  );
  const taskTimeoutMs = readInteger(
    options.taskTimeoutMs,
    readInteger(process.env.EVEJS_MARSHAL_WORKER_TIMEOUT_MS, 5000, 1),
    1,
  );
  const minBytes = readInteger(
    options.minBytes,
    readInteger(process.env.EVEJS_MARSHAL_WORKER_MIN_BYTES, 256 * 1024),
  );
  const minNodes = readInteger(
    options.minNodes,
    readInteger(process.env.EVEJS_MARSHAL_WORKER_MIN_NODES, 5000),
  );
  const createWorker = typeof options.createWorker === "function"
    ? options.createWorker
    : (workerPath) => new Worker(workerPath);

  const slots = new Set();
  const queue = [];
  const drainWaiters = [];
  let activeTasks = 0;
  let nextTaskId = 1;
  let shuttingDown = false;
  let closed = false;
  const stats = {
    considered: 0,
    submitted: 0,
    completed: 0,
    failed: 0,
    timedOut: 0,
    timedOutQueued: 0,
    timedOutExecuting: 0,
    inlineThreshold: 0,
    inlineDisabled: 0,
    inlineOverloaded: 0,
    inlineShuttingDown: 0,
    inlineFallback: 0,
    inlineEncodeMs: 0,
    inlineDecodeMs: 0,
    workerEncodeMs: 0,
    workerDecodeMs: 0,
    workerQueueMs: 0,
  };

  function snapshotStats() {
    return {
      ...stats,
      enabled,
      size,
      maxQueue,
      minBytes,
      minNodes,
      active: activeTasks,
      queued: queue.length,
      workers: slots.size,
      shuttingDown,
      closed,
    };
  }

  function resolveDrainWaiters() {
    if (activeTasks !== 0 || queue.length !== 0) {
      return;
    }
    while (drainWaiters.length > 0) {
      drainWaiters.shift()(snapshotStats());
    }
  }

  function removeSlot(slot) {
    if (!slot || slot.removed) {
      return;
    }
    slot.removed = true;
    slots.delete(slot);
  }

  function dispatch() {
    if (closed) {
      return;
    }
    for (const slot of slots) {
      if (queue.length === 0) {
        break;
      }
      if (slot.removed || slot.task) {
        continue;
      }
      const task = queue.shift();
      slot.task = task;
      task.slot = slot;
      activeTasks += 1;
      task.startedAtMs = performance.now();
      if (typeof slot.worker.ref === "function") {
        slot.worker.ref();
      }
      try {
        slot.worker.postMessage({
          type: "task",
          taskId: task.id,
          operation: task.operation,
          value: task.value,
          options: task.options,
        });
      } catch (error) {
        clearTimeout(task.timeout);
        slot.task = null;
        task.slot = null;
        activeTasks -= 1;
        stats.failed += 1;
        task.reject(error);
        if (typeof slot.worker.unref === "function") {
          slot.worker.unref();
        }
        setImmediate(dispatch);
      }
    }
    resolveDrainWaiters();
  }

  function handleSlotFailure(slot, error) {
    if (!slot || slot.removed) {
      return;
    }
    removeSlot(slot);
    const task = slot.task;
    slot.task = null;
    if (task) {
      clearTimeout(task.timeout);
      task.slot = null;
      activeTasks -= 1;
      stats.failed += 1;
      task.reject(error);
    }
    if (!closed) {
      ensureWorkers();
      dispatch();
    }
    resolveDrainWaiters();
  }

  function spawnWorker() {
    let worker;
    try {
      worker = createWorker(WORKER_PATH);
    } catch (error) {
      // ignored: false stops ensureWorkers; with no worker at all, queued tasks fail with "could not start a worker"
      return false;
    }
    const slot = { worker, task: null, removed: false };
    slots.add(slot);
    worker.on("message", (message) => {
      const task = slot.task;
      if (!task || !message || message.taskId !== task.id) {
        return;
      }
      clearTimeout(task.timeout);
      slot.task = null;
      task.slot = null;
      activeTasks -= 1;
      if (message.type === "result") {
        stats.completed += 1;
        stats.workerEncodeMs += Number(message.result && message.result.encodeMs) || 0;
        stats.workerDecodeMs += Number(message.result && message.result.decodeMs) || 0;
        stats.workerQueueMs += task.startedAtMs - task.queuedAtMs;
        task.resolve({
          ...normalizeWorkerResult(message.result),
          queueMs: task.startedAtMs - task.queuedAtMs,
          wallMs: performance.now() - task.queuedAtMs,
        });
      } else {
        stats.failed += 1;
        task.reject(new Error(message.error || "marshal worker task failed"));
      }
      if (typeof worker.unref === "function") {
        worker.unref();
      }
      dispatch();
    });
    worker.on("error", (error) => {
      handleSlotFailure(slot, error);
    });
    worker.on("exit", (code) => {
      if (!slot.removed && (slot.task || code !== 0)) {
        handleSlotFailure(
          slot,
          new Error(`marshal worker exited with code ${code}`),
        );
      } else {
        removeSlot(slot);
      }
    });
    // Unref last: adding a "message" listener refs the worker's port again,
    // which would let an idle worker keep the process alive.
    if (typeof worker.unref === "function") {
      worker.unref();
    }
    return true;
  }

  function ensureWorkers() {
    if (
      !enabled ||
      closed ||
      (shuttingDown && queue.length === 0)
    ) {
      return;
    }
    while (slots.size < size) {
      if (!spawnWorker()) {
        break;
      }
    }
    if (slots.size === 0 && queue.length > 0) {
      const error = new Error("marshal worker pool could not start a worker");
      while (queue.length > 0) {
        stats.failed += 1;
        const task = queue.shift();
        clearTimeout(task.timeout);
        task.reject(error);
      }
      resolveDrainWaiters();
    }
  }

  function createTaskTimeoutError(task, phase) {
    const observedAtMs = performance.now();
    const startedAtMs = Number.isFinite(task.startedAtMs)
      ? task.startedAtMs
      : null;
    const queueMs = startedAtMs === null
      ? Math.max(0, observedAtMs - task.queuedAtMs)
      : Math.max(0, startedAtMs - task.queuedAtMs);
    const executionMs = startedAtMs === null
      ? 0
      : Math.max(0, observedAtMs - startedAtMs);
    const wallMs = Math.max(0, observedAtMs - task.queuedAtMs);
    const error = new Error(
      `marshal worker task ${task.id} timed out after ${taskTimeoutMs}ms ` +
        `(phase=${phase} queueMs=${queueMs.toFixed(2)} ` +
        `executionMs=${executionMs.toFixed(2)} wallMs=${wallMs.toFixed(2)})`,
    );
    error.code = "MARSHAL_WORKER_TIMEOUT";
    error.phase = phase;
    error.queueMs = queueMs;
    error.executionMs = executionMs;
    error.wallMs = wallMs;
    return error;
  }

  function handleTaskTimeout(task) {
    const queuedIndex = queue.indexOf(task);
    if (queuedIndex >= 0) {
      queue.splice(queuedIndex, 1);
      stats.failed += 1;
      stats.timedOut += 1;
      stats.timedOutQueued += 1;
      task.reject(createTaskTimeoutError(task, "queue"));
      resolveDrainWaiters();
      return;
    }

    const slot = task.slot;
    if (!slot || slot.task !== task) {
      return;
    }
    slot.task = null;
    task.slot = null;
    activeTasks -= 1;
    stats.failed += 1;
    stats.timedOut += 1;
    stats.timedOutExecuting += 1;
    removeSlot(slot);
    task.reject(createTaskTimeoutError(task, "execution"));
    Promise.resolve(slot.worker.terminate()).catch(() => {});
    ensureWorkers();
    dispatch();
    resolveDrainWaiters();
  }

  function plan(operation, value, taskOptions = {}, planOptions = {}) {
    stats.considered += 1;
    if (!enabled) {
      stats.inlineDisabled += 1;
      return { mode: "inline", reason: "disabled", estimate: null };
    }
    if (shuttingDown || closed) {
      stats.inlineShuttingDown += 1;
      return { mode: "inline", reason: "shutting-down", estimate: null };
    }
    const estimate = estimateMarshalWork(value, {
      byteThreshold: minBytes,
      nodeThreshold: minNodes,
    });
    if (planOptions.force !== true && !estimate.thresholdReached) {
      stats.inlineThreshold += 1;
      return { mode: "inline", reason: "threshold", estimate };
    }
    if (activeTasks + queue.length >= size + maxQueue) {
      stats.inlineOverloaded += 1;
      return { mode: "inline", reason: "overloaded", estimate };
    }

    let resolveTask;
    let rejectTask;
    const promise = new Promise((resolve, reject) => {
      resolveTask = resolve;
      rejectTask = reject;
    });
    const task = {
      id: nextTaskId,
      operation,
      value,
      options: taskOptions,
      queuedAtMs: performance.now(),
      startedAtMs: null,
      slot: null,
      timeout: null,
      resolve: resolveTask,
      reject: rejectTask,
    };
    nextTaskId += 1;
    task.timeout = setTimeout(() => handleTaskTimeout(task), taskTimeoutMs);
    stats.submitted += 1;
    queue.push(task);
    ensureWorkers();
    dispatch();
    return { mode: "worker", reason: "eligible", estimate, promise };
  }

  function recordInline(reason, details = {}) {
    stats.inlineEncodeMs += Number(details.encodeMs) || 0;
    stats.inlineDecodeMs += Number(details.decodeMs) || 0;
    if (reason === "fallback") {
      stats.inlineFallback += 1;
    }
  }

  function drain() {
    if (activeTasks === 0 && queue.length === 0) {
      return Promise.resolve(snapshotStats());
    }
    return new Promise((resolve) => drainWaiters.push(resolve));
  }

  async function shutdown() {
    if (closed) {
      return snapshotStats();
    }
    shuttingDown = true;
    await drain();
    const workers = [...slots];
    await Promise.all(workers.map((slot) =>
      Promise.resolve(slot.worker.terminate()).catch(() => null)));
    for (const slot of workers) {
      removeSlot(slot);
    }
    closed = true;
    return snapshotStats();
  }

  return {
    plan,
    recordInline,
    drain,
    shutdown,
    getStats: snapshotStats,
    isEnabled: () => enabled,
  };
}

const pool = createPool();

module.exports = {
  plan: pool.plan,
  recordInline: pool.recordInline,
  drain: pool.drain,
  shutdown: pool.shutdown,
  getStats: pool.getStats,
  isEnabled: pool.isEnabled,
  runWithOffloadContext,
  isOffloadContextActive,
  estimateMarshalWork,
  _createPoolForTests: createPool,
};
