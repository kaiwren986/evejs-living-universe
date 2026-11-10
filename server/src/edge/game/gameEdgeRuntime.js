"use strict";

const path = require("node:path");

const config = require(path.join(__dirname, "../../config"));
const log = require(path.join(__dirname, "../../utils/logger"));
const { createEdgeProcessClient } = require(path.join(
  __dirname,
  "../edgeProcessClient",
));
const { createGameSocketAuthorityBridge } = require("./gameSocketAuthorityBridge");

const AUTHORITY_NAME = "game-edge";
const DEFAULT_RESTART_DELAY_MS = 250;
const DEFAULT_MAX_STARTUP_RESTART_ATTEMPTS = 3;

function positiveInteger(value, fallback) {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : fallback;
}

function toPort(value, fallback) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric >= 0 && numeric <= 65_535
    ? numeric
    : fallback;
}

function createGameEdgeRuntime(options = {}) {
  if (typeof options.handleSocket !== "function") {
    throw new TypeError("game edge runtime requires an authoritative socket handler");
  }
  const address = Object.freeze({
    host: String(options.host || config.gameServerBindHost || "127.0.0.1").trim(),
    port: Object.prototype.hasOwnProperty.call(options, "port")
      ? toPort(options.port, 26_000)
      : toPort(config.serverPort, 26_000),
  });
  const runtimeLog = options.log || log;
  const restartDelayMs = positiveInteger(
    options.restartDelayMs,
    DEFAULT_RESTART_DELAY_MS,
  );
  const maxStartupRestartAttempts = positiveInteger(
    options.maxStartupRestartAttempts,
    DEFAULT_MAX_STARTUP_RESTART_ATTEMPTS,
  );
  const createClient = typeof options.createEdgeClient === "function"
    ? options.createEdgeClient
    : createEdgeProcessClient;
  let client = null;
  let desiredRunning = false;
  let state = "idle";
  let startPromise = null;
  let shutdownPromise = null;
  let restartTimer = null;
  let restartCount = 0;
  let startupRestartAttempts = 0;
  let lastStatus = null;

  const socketBridge = createGameSocketAuthorityBridge({
    handleSocket: options.handleSocket,
    sendCommand(command, payload) {
      return client.call(command, payload);
    },
  });

  function clearRestartTimer() {
    if (!restartTimer) return;
    clearTimeout(restartTimer);
    restartTimer = null;
  }

  function scheduleRestart(exit) {
    if (!desiredRunning || restartTimer || state === "closing" || state === "closed") {
      return;
    }
    socketBridge.cleanupGeneration(exit.generation);
    state = "restarting";
    lastStatus = null;
    restartTimer = setTimeout(() => {
      restartTimer = null;
      if (!desiredRunning) return;
      restartCount += 1;
      void start().catch((error) => {
        runtimeLog.warn(`[GameEdge] restart failed: ${error.message}`);
      });
    }, restartDelayMs);
    if (typeof restartTimer.unref === "function") restartTimer.unref();
  }

  client = createClient({
    authorityName: AUTHORITY_NAME,
    workerPath: path.join(__dirname, "gameEdgeProcess.worker.js"),
    cwd: options.cwd || process.cwd(),
    env: {
      ...(options.env && typeof options.env === "object" ? options.env : {}),
      EVEJS_GAME_EDGE_HOST: address.host,
      EVEJS_GAME_EDGE_PORT: String(address.port),
      EVEJS_GAME_EDGE_TEST_CRASH: options.enableTestCrash === true ? "1" : "0",
    },
    handleRequest: socketBridge.handleRequest,
    maxPending: options.maxPending || 1024,
    requestTimeoutMs: options.requestTimeoutMs || 15_000,
    shutdownTimeoutMs: options.shutdownTimeoutMs || 15_000,
    startupTimeoutMs: options.startupTimeoutMs || 15_000,
    onExit(exit) {
      if (!exit || exit.unexpected !== true) return;
      if (exit.previousState === "starting") {
        if (startupRestartAttempts >= maxStartupRestartAttempts) {
          runtimeLog.warn("[GameEdge] startup restart limit reached");
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
      return Promise.reject(new Error("game edge runtime is shutting down"));
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
      await socketBridge.shutdown();
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
      sockets: socketBridge.getDiagnostics(),
      state,
      transport: client.getStats(),
    });
  }

  return Object.freeze({
    crashForTest() {
      if (options.enableTestCrash !== true) {
        const error = new Error("game edge test crash is disabled");
        error.code = "GAME_EDGE_TEST_CRASH_DISABLED";
        return Promise.reject(error);
      }
      return client.call("test.crash", {});
    },
    getSnapshot,
    shutdown,
    start,
  });
}

module.exports = {
  AUTHORITY_NAME,
  createGameEdgeRuntime,
};
