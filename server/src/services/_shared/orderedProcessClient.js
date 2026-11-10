"use strict";

const path = require("node:path");
const { fork } = require("node:child_process");
const log = require("../../utils/logger");
const {
  MESSAGE_KIND,
  buildMessage,
  deserializeError,
  isProtocolMessage,
} = require("./orderedProcessProtocol");

const DEFAULT_MAX_PENDING = 128;
const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

function positiveInteger(value, fallback) {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : fallback;
}

function createError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function finiteNonNegative(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
}

function formatTimingMs(value) {
  return value === null ? "unknown" : value.toFixed(2);
}

function createOrderedProcessClient(options = {}) {
  const authorityName = String(options.authorityName || "").trim();
  const workerPath = path.resolve(String(options.workerPath || ""));
  const forkProcess = typeof options.forkProcess === "function"
    ? options.forkProcess
    : fork;
  if (!authorityName || !options.workerPath) {
    throw new TypeError("ordered process client requires an authority name and worker path");
  }

  const maxPending = positiveInteger(options.maxPending, DEFAULT_MAX_PENDING);
  const startupTimeoutMs = positiveInteger(
    options.startupTimeoutMs,
    DEFAULT_STARTUP_TIMEOUT_MS,
  );
  const requestTimeoutMs = positiveInteger(
    options.requestTimeoutMs,
    DEFAULT_REQUEST_TIMEOUT_MS,
  );
  const shutdownTimeoutMs = positiveInteger(
    options.shutdownTimeoutMs,
    DEFAULT_SHUTDOWN_TIMEOUT_MS,
  );
  const onEvent = typeof options.onEvent === "function" ? options.onEvent : null;
  const onExit = typeof options.onExit === "function" ? options.onExit : null;
  const onTiming = typeof options.onTiming === "function" ? options.onTiming : null;
  const timingLog = options.logger === null ? null : options.logger || log;
  const slowRequestMs = positiveInteger(options.slowRequestMs, 1_000);
  const childEnv = {
    ...process.env,
    ...(options.env && typeof options.env === "object" ? options.env : {}),
  };
  if (childEnv.EVEJS_TEST_STORE_ISOLATED === "1") {
    childEnv.EVEJS_TEST_STORE_SHARED_CHILD = "1";
  }

  let child = null;
  let generation = 0;
  let accepting = true;
  let state = "idle";
  let startPromise = null;
  let shutdownPromise = null;
  let nextRequestId = 1;
  let nextSequence = 1;
  let drainWaiters = [];
  let closedAck = null;
  const pending = new Map();
  const targetExitPromises = new WeakMap();
  // A startup Promise can reject before the OS process exits. Keep the phase
  // attached to that target and expose awaiting-exit until its terminal event;
  // this both preserves pre-ready exit classification and fences successors.
  const startingTargets = new WeakSet();
  const stats = {
    submitted: 0,
    completed: 0,
    failed: 0,
    overloaded: 0,
    timedOut: 0,
    processStarts: 0,
    processExits: 0,
    events: 0,
  };

  function snapshotStats() {
    return Object.freeze({
      ...stats,
      accepting,
      authorityName,
      generation,
      maxPending,
      nextSequence,
      pending: pending.size,
      pid: child && Number(child.pid) || null,
      state,
    });
  }

  function settleDrainWaiters() {
    if (pending.size > 0 || drainWaiters.length === 0) {
      return;
    }
    const waiters = drainWaiters;
    drainWaiters = [];
    for (const resolve of waiters) {
      resolve();
    }
  }

  function buildRequestTiming(entry, outcome = {}, observedAtMs = Date.now()) {
    const remoteTiming = outcome.remoteTiming && typeof outcome.remoteTiming === "object"
      ? outcome.remoteTiming
      : {};
    const queueMs = finiteNonNegative(
      remoteTiming.queueMs === undefined
        ? entry.authorityQueueMs
        : remoteTiming.queueMs,
    );
    let executionMs = finiteNonNegative(remoteTiming.executionMs);
    if (
      executionMs === null &&
      Number.isFinite(entry.authorityStartedAtUnixMs)
    ) {
      executionMs = Math.max(0, observedAtMs - entry.authorityStartedAtUnixMs);
    }
    const startupMs = entry.sentAtMs === null
      ? Math.max(0, observedAtMs - entry.submittedAtMs)
      : Math.max(0, entry.sentAtMs - entry.submittedAtMs);
    const phase = outcome.phase || (
      entry.sentAtMs === null
        ? "startup"
        : entry.authorityStartedAtUnixMs === null
          ? "authority-queue-or-ipc"
          : "execution"
    );
    return Object.freeze({
      authorityName,
      command: entry.command,
      executionMs,
      outcome: String(outcome.outcome || "unknown"),
      phase,
      queueMs,
      requestId: entry.requestId,
      roundTripMs: Math.max(0, observedAtMs - entry.submittedAtMs),
      sequence: entry.sequence,
      startupMs,
    });
  }

  function observeRequestTiming(timing) {
    if (onTiming) {
      try {
        onTiming(timing);
      } catch (_) {
        // ignored: diagnostics must never change authority transport outcomes.
      }
    }
    if (
      timingLog &&
      typeof timingLog.warn === "function" &&
      timing.roundTripMs >= slowRequestMs
    ) {
      timingLog.warn(
        `[AuthorityTiming] authority=${timing.authorityName} ` +
          `command=${timing.command} request=${timing.requestId} ` +
          `outcome=${timing.outcome} phase=${timing.phase} ` +
          `startupMs=${formatTimingMs(timing.startupMs)} ` +
          `queueMs=${formatTimingMs(timing.queueMs)} ` +
          `executionMs=${formatTimingMs(timing.executionMs)} ` +
          `roundTripMs=${formatTimingMs(timing.roundTripMs)}`,
      );
    }
  }

  function settlePending(requestId, outcome) {
    const entry = pending.get(requestId);
    if (!entry) {
      return false;
    }
    pending.delete(requestId);
    clearTimeout(entry.timeoutHandle);
    if (entry.timeoutCheckHandle) {
      clearImmediate(entry.timeoutCheckHandle);
      entry.timeoutCheckHandle = null;
    }
    const timing = outcome.timing || buildRequestTiming(entry, {
      outcome: outcome.ok ? "ok" : "error",
      phase: outcome.ok ? "complete" : undefined,
      remoteTiming: outcome.remoteTiming,
    });
    observeRequestTiming(timing);
    if (outcome.ok) {
      stats.completed += 1;
      entry.resolve(outcome.result);
    } else {
      stats.failed += 1;
      entry.reject(outcome.error);
    }
    settleDrainWaiters();
    return true;
  }

  function rejectAllPending(error) {
    for (const requestId of [...pending.keys()]) {
      settlePending(requestId, { ok: false, error });
    }
  }

  function createDisconnectedError(cause = null) {
    const detail = cause && cause.message
      ? `: ${cause.message}`
      : "";
    const error = createError(
      `Authority process IPC channel is disconnected${detail}`,
      "AUTHORITY_DISCONNECTED",
    );
    if (cause) {
      error.cause = cause;
    }
    return error;
  }

  function handleMessage(target, message) {
    if (target !== child || !isProtocolMessage(message)) {
      return;
    }
    if (message.authorityName && message.authorityName !== authorityName) {
      return;
    }
    if (message.kind === MESSAGE_KIND.RESPONSE) {
      const requestId = Number(message.requestId);
      const entry = pending.get(requestId);
      if (!entry) {
        return;
      }
      if (Number(message.sequence) !== entry.sequence) {
        settlePending(requestId, {
          ok: false,
          error: createError(
            `Authority response sequence mismatch for request ${requestId}`,
            "AUTHORITY_SEQUENCE_MISMATCH",
          ),
        });
        return;
      }
      settlePending(requestId, message.ok === true
        ? { ok: true, result: message.result, remoteTiming: message.timing }
        : {
          ok: false,
          error: deserializeError(message.error),
          remoteTiming: message.timing,
        });
      return;
    }
    if (message.kind === MESSAGE_KIND.STARTED) {
      const requestId = Number(message.requestId);
      const entry = pending.get(requestId);
      if (!entry || Number(message.sequence) !== entry.sequence) {
        return;
      }
      entry.authorityQueueMs = finiteNonNegative(message.queueMs);
      entry.authorityStartedAtUnixMs = finiteNonNegative(message.startedAtUnixMs);
      return;
    }
    if (message.kind === MESSAGE_KIND.EVENT) {
      stats.events += 1;
      if (onEvent) {
        onEvent(Object.freeze({
          authorityName,
          generation,
          topic: String(message.topic || ""),
          payload: message.payload,
          sequence: Number(message.sequence) || 0,
        }));
      }
      return;
    }
    if (message.kind === MESSAGE_KIND.CLOSED && closedAck) {
      const resolve = closedAck;
      closedAck = null;
      resolve(message);
    }
  }

  function handleExit(target, code, signal) {
    if (target !== child) {
      return;
    }
    const previousState = startingTargets.has(target) ? "starting" : state;
    startingTargets.delete(target);
    const unexpected = accepting && previousState !== "closing" && previousState !== "closed";
    stats.processExits += 1;
    child = null;
    startPromise = null;
    nextSequence = 1;
    if (closedAck) {
      const resolve = closedAck;
      closedAck = null;
      resolve({ code, signal, exited: true });
    }
    if (state !== "closing" && state !== "closed") {
      state = accepting ? "idle" : "closed";
      rejectAllPending(createError(
        `Authority process exited (code=${code}, signal=${signal || "none"})`,
        "AUTHORITY_PROCESS_EXITED",
      ));
    } else {
      state = "closed";
    }
    if (onExit) {
      try {
        onExit(Object.freeze({
          authorityName,
          code: Number.isInteger(code) ? code : null,
          generation,
          previousState,
          signal: signal || null,
          unexpected,
        }));
      } catch (_) {
        // ignored: lifecycle observers must not interfere with transport cleanup.
      }
    }
  }

  function start(startOptions = {}) {
    const normalizedStartOptions = startOptions && typeof startOptions === "object"
      ? startOptions
      : {};
    const hasBootstrapPayload = Object.prototype.hasOwnProperty.call(
      normalizedStartOptions,
      "bootstrapPayload",
    );
    if (child && state === "ready") {
      return Promise.resolve(child);
    }
    if (startPromise) {
      return startPromise;
    }
    if (!accepting) {
      return Promise.reject(createError(
        "Authority client is shutting down",
        "AUTHORITY_SHUTTING_DOWN",
      ));
    }
    if (child) {
      const priorTarget = child;
      const priorExit = targetExitPromises.get(priorTarget);
      if (priorExit) {
        // A startup refusal or timeout settles its Promise before the OS child
        // necessarily exits. Never overlap generations: supervisors reuse one
        // persistence-owner instance ID across generations, so the successor
        // may only fork after the prior process has actually left the system.
        return priorExit.then(() => start(normalizedStartOptions));
      }
      return Promise.reject(createError(
        "Prior authority process has not reported its exit",
        "AUTHORITY_PREVIOUS_PROCESS_ACTIVE",
      ));
    }

    state = "starting";
    generation += 1;
    const target = forkProcess(workerPath, [], {
      cwd: options.cwd || process.cwd(),
      env: childEnv,
      serialization: "advanced",
      stdio: ["ignore", "inherit", "inherit", "ipc"],
      windowsHide: true,
    });
    child = target;
    startingTargets.add(target);
    let resolveTargetExit;
    const targetExitPromise = new Promise((resolve) => {
      resolveTargetExit = resolve;
    });
    targetExitPromises.set(target, targetExitPromise);
    target.once("exit", (code, signal) => {
      resolveTargetExit({ code, signal });
    });
    stats.processStarts += 1;
    startPromise = new Promise((resolve, reject) => {
      let settled = false;
      let timeoutCheckHandle = null;
      const timeoutHandle = setTimeout(() => {
        // A long synchronous parent phase can make this timer overdue while a
        // READY message is already waiting in the IPC poll queue. Give that
        // queue one turn before declaring the child unhealthy.
        timeoutCheckHandle = setImmediate(() => {
          timeoutCheckHandle = null;
          if (settled) return;
          const error = createError(
            `Authority process did not become ready within ${startupTimeoutMs} ms`,
            "AUTHORITY_START_TIMEOUT",
          );
          failStartup(error);
        });
      }, startupTimeoutMs);

      function clearStartupDeadline() {
        clearTimeout(timeoutHandle);
        if (timeoutCheckHandle) {
          clearImmediate(timeoutCheckHandle);
          timeoutCheckHandle = null;
        }
      }

      function failStartup(error) {
        if (settled) return;
        settled = true;
        clearStartupDeadline();
        target.off("message", finishStartup);
        state = "awaiting-exit";
        if (typeof target.kill === "function") {
          try {
            target.kill();
          } catch (_) {
            // ignored: the exit barrier remains authoritative; a failed kill must not
            // permit an overlapping successor generation.
          }
        }
        reject(error);
      }

      function finishStartup(message) {
        if (
          settled || target !== child ||
          !isProtocolMessage(message) ||
          ![MESSAGE_KIND.READY, MESSAGE_KIND.CLOSED].includes(message.kind) ||
          message.authorityName !== authorityName
        ) {
          return;
        }
        settled = true;
        clearStartupDeadline();
        target.off("message", finishStartup);
        if (message.kind === MESSAGE_KIND.CLOSED) {
          state = "awaiting-exit";
          reject(deserializeError(
            message.startupError,
            "AUTHORITY_START_FAILED",
          ));
          return;
        }
        startingTargets.delete(target);
        state = "ready";
        resolve(target);
      }

      target.on("message", finishStartup);
      target.once("error", (error) => {
        failStartup(error);
      });
      target.once("exit", (code, signal) => {
        if (settled) {
          return;
        }
        settled = true;
        clearStartupDeadline();
        target.off("message", finishStartup);
        state = "idle";
        reject(createError(
          `Authority process exited before ready (code=${code}, signal=${signal || "none"})`,
          "AUTHORITY_START_FAILED",
        ));
      });
      if (hasBootstrapPayload) {
        try {
          target.send(buildMessage(MESSAGE_KIND.BOOTSTRAP, {
            authorityName,
            bootstrapPayload: normalizedStartOptions.bootstrapPayload,
          }), (error) => {
            if (error) {
              failStartup(createDisconnectedError(error));
            }
          });
        } catch (error) {
          failStartup(createDisconnectedError(error));
        }
      }
    }).finally(() => {
      startPromise = null;
    });

    target.on("message", (message) => handleMessage(target, message));
    target.on("exit", (code, signal) => handleExit(target, code, signal));
    return startPromise;
  }

  function call(command, payload = {}, metadata = {}) {
    const normalizedCommand = String(command || "").trim();
    if (!normalizedCommand) {
      return Promise.reject(createError(
        "Authority command is required",
        "AUTHORITY_COMMAND_INVALID",
      ));
    }
    if (!accepting) {
      return Promise.reject(createError(
        "Authority client is shutting down",
        "AUTHORITY_SHUTTING_DOWN",
      ));
    }
    if (pending.size >= maxPending) {
      stats.overloaded += 1;
      return Promise.reject(createError(
        `Authority queue is full (${maxPending})`,
        "AUTHORITY_OVERLOADED",
      ));
    }

    const requestId = nextRequestId;
    nextRequestId += 1;
    stats.submitted += 1;

    return new Promise((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        const entry = pending.get(requestId);
        if (!entry) {
          return;
        }
        // A synchronous parent phase can make this timer overdue while the
        // child response is already waiting in the IPC poll queue. Give that
        // queue one turn before rejecting a request that may have completed on
        // time in the authority process.
        entry.timeoutCheckHandle = setImmediate(() => {
          entry.timeoutCheckHandle = null;
          if (!pending.has(requestId)) {
            return;
          }
          const elapsedMs = Date.now() - entry.submittedAtMs;
          const timing = buildRequestTiming(entry, {
            outcome: "timeout",
          });
          const error = createError(
            `Authority ${authorityName} command ${normalizedCommand} request ` +
              `${requestId} timed out after ${requestTimeoutMs} ms ` +
              `(elapsed ${elapsedMs} ms phase=${timing.phase} ` +
              `startupMs=${formatTimingMs(timing.startupMs)} ` +
              `queueMs=${formatTimingMs(timing.queueMs)} ` +
              `executionMs=${formatTimingMs(timing.executionMs)})`,
            "AUTHORITY_REQUEST_TIMEOUT",
          );
          error.phase = timing.phase;
          error.startupMs = timing.startupMs;
          error.queueMs = timing.queueMs;
          error.executionMs = timing.executionMs;
          error.roundTripMs = timing.roundTripMs;
          stats.timedOut += 1;
          settlePending(requestId, {
            ok: false,
            error,
            timing,
          });
        });
      }, requestTimeoutMs);
      pending.set(requestId, {
        authorityQueueMs: null,
        authorityStartedAtUnixMs: null,
        command: normalizedCommand,
        resolve,
        reject,
        requestId,
        sequence: null,
        sentAtMs: null,
        submittedAtMs: Date.now(),
        timeoutCheckHandle: null,
        timeoutHandle,
      });

      start().then((target) => {
        if (!pending.has(requestId)) {
          return;
        }
        if (target.connected === false || typeof target.send !== "function") {
          settlePending(requestId, {
            ok: false,
            error: createDisconnectedError(),
          });
          return;
        }
        // Reserve ordering only for a request that can actually enter this
        // child's IPC lane. A call may time out while start() is still waiting
        // for readiness; consuming a sequence for that unsent request would
        // leave the live host permanently waiting for a number it never sees.
        const entry = pending.get(requestId);
        const sequence = nextSequence;
        nextSequence += 1;
        entry.sequence = sequence;
        entry.sentAtMs = Date.now();
        try {
          target.send(buildMessage(MESSAGE_KIND.REQUEST, {
            authorityName,
            requestId,
            sequence,
            command: normalizedCommand,
            payload,
            metadata: metadata && typeof metadata === "object" ? metadata : {},
          }), (error) => {
            if (error) {
              settlePending(requestId, {
                ok: false,
                error: createDisconnectedError(error),
              });
            }
          });
        } catch (error) {
          settlePending(requestId, {
            ok: false,
            error: createDisconnectedError(error),
          });
        }
      }).catch((error) => {
        settlePending(requestId, { ok: false, error });
      });
    });
  }

  function drain() {
    if (pending.size === 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => drainWaiters.push(resolve));
  }

  function shutdown() {
    if (shutdownPromise) {
      return shutdownPromise;
    }
    accepting = false;
    state = "draining";
    shutdownPromise = drain().then(async () => {
      const target = child;
      if (!target || target.connected === false) {
        if (child === target) {
          child = null;
        }
        state = "closed";
        return snapshotStats();
      }
      state = "closing";
      let resolveClosed;
      const closedPromise = new Promise((resolve) => {
        resolveClosed = resolve;
        closedAck = resolve;
      });
      const sendFailurePromise = new Promise((resolve) => {
        try {
          target.send(
            buildMessage(MESSAGE_KIND.SHUTDOWN, { authorityName }),
            (error) => {
              if (error) resolve(error);
            },
          );
        } catch (error) {
          resolve(error);
        }
      });
      let timeoutHandle;
      const closeOutcome = await Promise.race([
        closedPromise.then((message) => ({ kind: "closed", message })),
        sendFailurePromise.then((error) => ({ kind: "send-failed", error })),
        new Promise((resolve) => {
          timeoutHandle = setTimeout(
            () => resolve({ kind: "timeout" }),
            shutdownTimeoutMs,
          );
        }),
      ]);
      clearTimeout(timeoutHandle);
      if (closedAck === resolveClosed) {
        closedAck = null;
      }
      const closedMessage = closeOutcome.kind === "closed"
        ? closeOutcome.message
        : null;
      const shutdownError = closedMessage && closedMessage.shutdownError
        ? deserializeError(
          closedMessage.shutdownError,
          "AUTHORITY_SHUTDOWN_FAILED",
        )
        : null;
      const closedAcknowledged = Boolean(
        closedMessage &&
        isProtocolMessage(closedMessage, MESSAGE_KIND.CLOSED),
      );
      if (!closedAcknowledged && typeof target.kill === "function") {
        try {
          target.kill();
        } catch (_) {
          // ignored: the process or its IPC channel already closed during shutdown.
        }
      }
      if (target.connected && typeof target.disconnect === "function") {
        try {
          target.disconnect();
        } catch (_) {
          // ignored: treat a close race as successful shutdown cleanup.
        }
      }
      if (child === target) {
        child = null;
      }
      state = "closed";
      if (shutdownError) {
        throw shutdownError;
      }
      return snapshotStats();
    });
    return shutdownPromise;
  }

  return Object.freeze({
    call,
    drain,
    getStats: snapshotStats,
    shutdown,
    start,
  });
}

module.exports = {
  createOrderedProcessClient,
};
