"use strict";

const path = require("node:path");

const config = require(path.join(__dirname, "../../config"));
const log = require(path.join(__dirname, "../../utils/logger"));
const { createEdgeProcessClient } = require(path.join(
  __dirname,
  "../edgeProcessClient",
));

const AUTHORITY_NAME = "redshift-edge";
const DEFAULT_PORT = 26_400;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_RESTART_DELAY_MS = 250;
const DEFAULT_MAX_STARTUP_RESTART_ATTEMPTS = 3;

function toPort(value, fallback) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric >= 0 && numeric <= 65_535
    ? numeric
    : fallback;
}

function positiveInteger(value, fallback) {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : fallback;
}

function createRedshiftEdgeRuntime(options = {}) {
  if (typeof options.handleOwnerRequest !== "function") {
    throw new TypeError("redshift edge runtime requires an owner request handler");
  }
  const address = Object.freeze({
    host: String(options.host || config.redshiftMonitorHost || DEFAULT_HOST).trim(),
    port: Object.prototype.hasOwnProperty.call(options, "port")
      ? toPort(options.port, DEFAULT_PORT)
      : toPort(config.redshiftMonitorPort, DEFAULT_PORT),
  });
  if (!address.host) throw new TypeError("redshift edge requires a bind host");
  const createClient = typeof options.createEdgeClient === "function"
    ? options.createEdgeClient
    : createEdgeProcessClient;
  const runtimeLog = options.log || log;
  const restartDelayMs = positiveInteger(
    options.restartDelayMs,
    DEFAULT_RESTART_DELAY_MS,
  );
  const maxStartupRestartAttempts = positiveInteger(
    options.maxStartupRestartAttempts,
    DEFAULT_MAX_STARTUP_RESTART_ATTEMPTS,
  );
  let desiredRunning = false;
  let state = "idle";
  let startPromise = null;
  let shutdownPromise = null;
  let restartTimer = null;
  let restartCount = 0;
  let startupRestartAttempts = 0;
  let lastStatus = null;

  function clearRestartTimer() {
    if (!restartTimer) return;
    clearTimeout(restartTimer);
    restartTimer = null;
  }

  function scheduleRestart(exit) {
    if (!desiredRunning || restartTimer || state === "closing" || state === "closed") {
      return;
    }
    state = "restarting";
    lastStatus = null;
    restartTimer = setTimeout(() => {
      restartTimer = null;
      if (!desiredRunning) return;
      restartCount += 1;
      void start().catch((error) => {
        runtimeLog.warn(
          `[RedshiftEdge] restart failed after child exit ` +
            `(code=${exit.code == null ? "none" : exit.code} ` +
            `signal=${exit.signal || "none"}): ${error.message}`,
        );
      });
    }, restartDelayMs);
    if (typeof restartTimer.unref === "function") restartTimer.unref();
  }

  const client = createClient({
    authorityName: AUTHORITY_NAME,
    workerPath: path.join(__dirname, "redshiftEdgeProcess.worker.js"),
    cwd: options.cwd || process.cwd(),
    env: {
      EVEJS_REDSHIFT_EDGE_HOST: address.host,
      EVEJS_REDSHIFT_EDGE_PORT: String(address.port),
    },
    handleRequest: options.handleOwnerRequest,
    maxPending: options.maxPending || 64,
    requestTimeoutMs: options.requestTimeoutMs || 10_000,
    shutdownTimeoutMs: options.shutdownTimeoutMs || 10_000,
    startupTimeoutMs: options.startupTimeoutMs || 10_000,
    onExit(exit) {
      if (!exit || exit.unexpected !== true) return;
      if (exit.previousState === "starting") {
        if (startupRestartAttempts >= maxStartupRestartAttempts) {
          runtimeLog.warn("[RedshiftEdge] startup restart limit reached");
          return;
        }
        startupRestartAttempts += 1;
      } else if (exit.previousState === "ready") {
        startupRestartAttempts = 0;
      } else {
        return;
      }
      scheduleRestart(exit);
    },
  });

  function start() {
    desiredRunning = true;
    if (state === "started" && lastStatus) return Promise.resolve(lastStatus);
    if (startPromise) return startPromise;
    if (state === "closing" || state === "closed") {
      return Promise.reject(new Error("redshift edge runtime is shutting down"));
    }
    clearRestartTimer();
    state = "starting";
    startPromise = (async () => {
      await client.start();
      const status = await client.call("status", {});
      lastStatus = Object.freeze({ ...status });
      startupRestartAttempts = 0;
      state = "started";
      return lastStatus;
    })().catch((error) => {
      state = desiredRunning ? "failed" : "closed";
      throw error;
    }).finally(() => {
      startPromise = null;
    });
    return startPromise;
  }

  function shutdown() {
    if (shutdownPromise) return shutdownPromise;
    desiredRunning = false;
    clearRestartTimer();
    state = "closing";
    shutdownPromise = (async () => {
      if (startPromise) await startPromise.catch(() => null);
      const transport = await client.shutdown();
      lastStatus = null;
      state = "closed";
      return Object.freeze({ state, transport });
    })();
    return shutdownPromise;
  }

  function getSnapshot() {
    return Object.freeze({
      address,
      desiredRunning,
      lastStatus,
      restartCount,
      startupRestartAttempts,
      state,
      transport: client.getStats(),
    });
  }

  return Object.freeze({ getSnapshot, shutdown, start });
}

module.exports = {
  AUTHORITY_NAME,
  createRedshiftEdgeRuntime,
};
