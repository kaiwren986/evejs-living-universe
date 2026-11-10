"use strict";

// A lazy, bounded pool dedicated to post-combat killmail enrichment. Workers
// only receive immutable terminal-event data. They never own live entities,
// sockets, inventory, wallets, standings, kill rights, or killmarks.

const os = require("node:os");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { Worker } = require("node:worker_threads");

const WORKER_PATH = path.join(__dirname, "killmailWorkerPool.worker.js");

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

function createPool(options = {}) {
  const configuredSize = readInteger(
    options.size,
    readInteger(
      process.env.EVEJS_KILLMAIL_WORKER_COUNT,
      defaultWorkerCount(),
    ),
  );
  const enabled = options.enabled === undefined
    ? process.env.EVEJS_KILLMAIL_WORKER_POOL !== "0" && configuredSize > 0
    : options.enabled === true && configuredSize > 0;
  const size = enabled ? configuredSize : 0;
  const maxQueue = readInteger(
    options.maxQueue,
    readInteger(process.env.EVEJS_KILLMAIL_WORKER_MAX_QUEUE, 256),
  );
  const taskTimeoutMs = readInteger(
    options.taskTimeoutMs,
    readInteger(process.env.EVEJS_KILLMAIL_WORKER_TIMEOUT_MS, 5000, 1),
    1,
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
    submitted: 0,
    completed: 0,
    failed: 0,
    timedOut: 0,
    inlineDisabled: 0,
    inlineOverloaded: 0,
    inlineShuttingDown: 0,
    workerPrepareMs: 0,
    workerQueueMs: 0,
  };

  function snapshotStats() {
    return {
      ...stats,
      enabled,
      size,
      maxQueue,
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
      task.startedAtMs = performance.now();
      activeTasks += 1;
      if (typeof slot.worker.ref === "function") {
        slot.worker.ref();
      }
      try {
        slot.worker.postMessage({
          type: "prepare-killmail",
          taskId: task.id,
          record: task.record,
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
      // ignored: false stops the pool starting more workers; with none at all, queued tasks fail
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
        stats.workerPrepareMs +=
          Number(message.result && message.result.prepareMs) || 0;
        stats.workerQueueMs += task.startedAtMs - task.queuedAtMs;
        task.resolve({
          ...message.result,
          queueMs: task.startedAtMs - task.queuedAtMs,
          wallMs: performance.now() - task.queuedAtMs,
        });
      } else {
        stats.failed += 1;
        task.reject(new Error(message.error || "killmail worker task failed"));
      }
      if (typeof worker.unref === "function") {
        worker.unref();
      }
      dispatch();
    });
    worker.on("error", (error) => handleSlotFailure(slot, error));
    worker.on("exit", (code) => {
      if (!slot.removed && (slot.task || code !== 0)) {
        handleSlotFailure(
          slot,
          new Error(`killmail worker exited with code ${code}`),
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
    if (!enabled || closed || (shuttingDown && queue.length === 0)) {
      return;
    }
    while (slots.size < size) {
      if (!spawnWorker()) {
        break;
      }
    }
    if (slots.size === 0 && queue.length > 0) {
      const error = new Error("killmail worker pool could not start a worker");
      while (queue.length > 0) {
        const task = queue.shift();
        clearTimeout(task.timeout);
        stats.failed += 1;
        task.reject(error);
      }
      resolveDrainWaiters();
    }
  }

  function handleTaskTimeout(task) {
    const queuedIndex = queue.indexOf(task);
    if (queuedIndex >= 0) {
      queue.splice(queuedIndex, 1);
      stats.failed += 1;
      stats.timedOut += 1;
      task.reject(new Error(
        `killmail worker task ${task.id} timed out after ${taskTimeoutMs}ms`,
      ));
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
    removeSlot(slot);
    task.reject(new Error(
      `killmail worker task ${task.id} timed out after ${taskTimeoutMs}ms`,
    ));
    Promise.resolve(slot.worker.terminate()).catch(() => {});
    ensureWorkers();
    dispatch();
    resolveDrainWaiters();
  }

  function plan(record, taskOptions = {}) {
    if (!enabled) {
      stats.inlineDisabled += 1;
      return { mode: "inline", reason: "disabled" };
    }
    if (shuttingDown || closed) {
      stats.inlineShuttingDown += 1;
      return { mode: "inline", reason: "shutting-down" };
    }
    if (activeTasks + queue.length >= size + maxQueue) {
      stats.inlineOverloaded += 1;
      return { mode: "inline", reason: "overloaded" };
    }

    let resolveTask;
    let rejectTask;
    const promise = new Promise((resolve, reject) => {
      resolveTask = resolve;
      rejectTask = reject;
    });
    const task = {
      id: nextTaskId,
      record,
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
    return { mode: "worker", reason: "eligible", promise };
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
    drain,
    shutdown,
    getStats: snapshotStats,
    isEnabled: () => enabled,
  };
}

const pool = createPool();

module.exports = {
  plan: pool.plan,
  drain: pool.drain,
  shutdown: pool.shutdown,
  getStats: pool.getStats,
  isEnabled: pool.isEnabled,
  _createPoolForTests: createPool,
};
