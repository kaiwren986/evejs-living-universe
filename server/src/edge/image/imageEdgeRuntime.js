"use strict";

const path = require("node:path");

const config = require(path.join(__dirname, "../../config"));
const log = require(path.join(__dirname, "../../utils/logger"));
const { createOrderedProcessClient } = require(path.join(
  __dirname,
  "../../services/_shared/orderedProcessClient",
));

const AUTHORITY_NAME = "image-edge";
const DEFAULT_RESTART_DELAY_MS = 250;
const DEFAULT_MAX_STARTUP_RESTART_ATTEMPTS = 3;

function startupCancellationError() {
  const error = new Error("image edge startup was cancelled");
  error.code = "IMAGE_EDGE_STARTUP_CANCELLED";
  return error;
}

function snapshotError(error) {
  return Object.freeze({
    code: String(error && error.code || "IMAGE_EDGE_START_FAILED"),
    message: String(error && error.message || error || "image edge startup failed"),
  });
}

function awaitWithAbort(value, signal) {
  if (signal.aborted) return Promise.reject(startupCancellationError());
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(startupCancellationError());
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(value).then(
      (result) => {
        cleanup();
        resolve(result);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function toPort(value, fallback) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric >= 0 && numeric <= 65_535
    ? numeric
    : fallback;
}

function toPositiveInteger(value, fallback) {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : fallback;
}

function resolveImageEdgeAddress(options = {}) {
  const configuredUrl = new URL(String(options.url || config.imageServerUrl));
  const defaultPort = configuredUrl.protocol === "https:" ? 443 : 80;
  const configuredPort = configuredUrl.port
    ? toPort(configuredUrl.port, defaultPort)
    : defaultPort;
  const port = Object.prototype.hasOwnProperty.call(options, "port")
    ? toPort(options.port, configuredPort)
    : configuredPort;
  const host = String(
    options.host ||
      config.imageServerBindHost ||
      (configuredUrl.hostname === "localhost" ? "127.0.0.1" : configuredUrl.hostname),
  ).trim();
  if (!host) {
    throw new TypeError("image edge requires a bind host");
  }
  return Object.freeze({ host, port });
}

function createImageEdgeRuntime(options = {}) {
  const address = resolveImageEdgeAddress(options);
  const createProcessClient =
    typeof options.createProcessClient === "function"
      ? options.createProcessClient
      : createOrderedProcessClient;
  const runtimeLog = options.log || log;
  const corporationLogoProjectionProvider =
    options.corporationLogoProjectionProvider;
  if (typeof corporationLogoProjectionProvider !== "function") {
    throw new TypeError(
      "image edge runtime requires a corporation-logo projection provider",
    );
  }
  const restartDelayMs = toPositiveInteger(
    options.restartDelayMs,
    DEFAULT_RESTART_DELAY_MS,
  );
  const maxStartupRestartAttempts = toPositiveInteger(
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
  let startupController = null;
  let startupLimitLogged = false;
  let lastStartupError = null;
  let lastStatus = null;

  function clearRestartTimer() {
    if (!restartTimer) return;
    clearTimeout(restartTimer);
    restartTimer = null;
  }

  function scheduleRestart(details = {}) {
    if (!desiredRunning || restartTimer || state === "closing" || state === "closed") {
      return false;
    }
    const startupFailure = details.phase === "startup";
    if (startupFailure) {
      if (startupRestartAttempts >= maxStartupRestartAttempts) {
        state = "failed";
        if (!startupLimitLogged) {
          startupLimitLogged = true;
          runtimeLog.warn("[ImageEdge] startup restart limit reached");
        }
        return false;
      }
      startupRestartAttempts += 1;
    } else {
      startupRestartAttempts = 0;
      startupLimitLogged = false;
    }
    state = "restarting";
    lastStatus = null;
    restartTimer = setTimeout(() => {
      restartTimer = null;
      if (!desiredRunning) return;
      restartCount += 1;
      void start().catch((error) => {
        runtimeLog.warn(
          `[ImageEdge] restart failed: ${error.message}`,
        );
      });
    }, restartDelayMs);
    if (typeof restartTimer.unref === "function") restartTimer.unref();
    return true;
  }

  const client = createProcessClient({
    authorityName: AUTHORITY_NAME,
    workerPath: path.join(__dirname, "imageEdgeProcess.worker.js"),
    cwd: options.cwd || process.cwd(),
    env: {
      EVEJS_IMAGE_EDGE_HOST: address.host,
      EVEJS_IMAGE_EDGE_PORT: String(address.port),
    },
    maxPending: options.maxPending || 32,
    requestTimeoutMs: options.requestTimeoutMs || 5_000,
    shutdownTimeoutMs: options.shutdownTimeoutMs || 10_000,
    startupTimeoutMs: options.startupTimeoutMs || 10_000,
    onExit(exit) {
      if (!exit || exit.unexpected !== true) return;
      // The active start Promise owns every pre-READY failure, including the
      // provider phase where no child exists. A READY child exit is separate:
      // reset the startup-failure budget and supervise it without a bound.
      if (exit.previousState === "ready") {
        scheduleRestart({ exit, phase: "ready" });
      }
    },
  });

  function start() {
    desiredRunning = true;
    if (state === "started" && lastStatus) {
      return Promise.resolve(lastStatus);
    }
    if (startPromise) return startPromise;
    if (state === "closing" || state === "closed") {
      return Promise.reject(new Error("image edge runtime is shutting down"));
    }

    clearRestartTimer();
    state = "starting";
    const controller = new AbortController();
    startupController = controller;
    startPromise = (async () => {
      const corporationLogoProjection = await awaitWithAbort(
        Promise.resolve().then(() => corporationLogoProjectionProvider({
          signal: controller.signal,
        })),
        controller.signal,
      );
      await awaitWithAbort(
        client.start({
          bootstrapPayload: { corporationLogoProjection },
        }),
        controller.signal,
      );
      const status = await awaitWithAbort(
        client.call("status", {}),
        controller.signal,
      );
      lastStatus = Object.freeze({ ...status });
      startupRestartAttempts = 0;
      startupLimitLogged = false;
      lastStartupError = null;
      state = "started";
      return lastStatus;
    })().catch((error) => {
      if (!desiredRunning) {
        state = "closed";
      } else {
        lastStartupError = snapshotError(error);
        state = restartTimer ? "restarting" : "failed";
        if (!restartTimer) scheduleRestart({ error, phase: "startup" });
      }
      throw error;
    }).finally(() => {
      if (startupController === controller) startupController = null;
      startPromise = null;
    });
    return startPromise;
  }

  function shutdown() {
    if (shutdownPromise) return shutdownPromise;
    desiredRunning = false;
    clearRestartTimer();
    state = "closing";
    if (startupController) startupController.abort();
    const pendingStart = startPromise;
    shutdownPromise = (async () => {
      const transport = await client.shutdown();
      if (pendingStart) await pendingStart.catch(() => null);
      lastStatus = null;
      state = "closed";
      return Object.freeze({
        state,
        transport,
      });
    })();
    return shutdownPromise;
  }

  function getSnapshot() {
    return Object.freeze({
      address,
      desiredRunning,
      lastStartupError,
      lastStatus,
      ready: state === "started" && Boolean(lastStatus),
      restartCount,
      startupRestartAttempts,
      state,
      transport: client.getStats(),
    });
  }

  return Object.freeze({
    getSnapshot,
    shutdown,
    start,
  });
}

module.exports = {
  AUTHORITY_NAME,
  createImageEdgeRuntime,
  resolveImageEdgeAddress,
};
