"use strict";

const path = require("node:path");

const config = require(path.join(__dirname, "../../config"));
const log = require(path.join(__dirname, "../../utils/logger"));
const {
  TLS_CERTIFICATE_CHILD_STARTUP_TIMEOUT_MS,
} = require(path.join(
  __dirname,
  "../../_secondary/express/localTlsCertificate",
));
const { createEdgeProcessClient } = require(path.join(
  __dirname,
  "../edgeProcessClient",
));
const { createGatewayAuthorityBridge } = require("./gatewayAuthorityBridge");
const { createGatewayGrpcAuthorityBridge } = require("./gatewayGrpcAuthorityBridge");

const AUTHORITY_NAME = "gateway-edge";
const DEFAULT_RESTART_DELAY_MS = 250;
const DEFAULT_MAX_STARTUP_RESTART_ATTEMPTS = 3;

function positiveInteger(value, fallback) {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : fallback;
}

function resolveAddress(options) {
  let listenUrl;
  try {
    listenUrl = new URL(String(options.listenUrl || config.microservicesPublicUrl));
  } catch {
    listenUrl = new URL("http://127.0.0.1:26002/");
  }
  const configuredPort = Number(options.port);
  const defaultPort = positiveInteger(
    config.microservicesPort,
    Number(listenUrl.port) || (listenUrl.protocol === "https:" ? 443 : 80),
  );
  const port = Object.prototype.hasOwnProperty.call(options, "port") &&
    Number.isInteger(configuredPort) && configuredPort >= 0 && configuredPort <= 65_535
    ? configuredPort
    : defaultPort;
  const configuredHost = String(
    options.host || config.microservicesBindHost || "",
  ).trim();
  return Object.freeze({
    host: configuredHost || listenUrl.hostname || "127.0.0.1",
    port,
    protocol: listenUrl.protocol === "https:" ? "https:" : "http:",
  });
}

function createGatewayEdgeRuntime(options = {}) {
  const gatewayRuntime = options.gatewayRuntime;
  if (!gatewayRuntime || typeof gatewayRuntime !== "object") {
    throw new TypeError("gateway edge runtime requires the authoritative gateway runtime");
  }
  const handleGatewayStream = options.handleGatewayStream;
  if (typeof handleGatewayStream !== "function") {
    throw new TypeError("gateway edge runtime requires the public gateway stream handler");
  }
  const address = resolveAddress(options);
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

  const runtimeBridge = createGatewayAuthorityBridge({
    gatewayRuntime,
    sendCommand(command, payload) {
      return client.call(command, payload);
    },
  });
  const grpcBridge = createGatewayGrpcAuthorityBridge({
    handleGatewayStream,
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
    runtimeBridge.cleanupGeneration(exit.generation);
    grpcBridge.cleanupGeneration(exit.generation);
    state = "restarting";
    lastStatus = null;
    restartTimer = setTimeout(() => {
      restartTimer = null;
      if (!desiredRunning) return;
      restartCount += 1;
      void start().catch((error) => {
        runtimeLog.warn(`[GatewayEdge] restart failed: ${error.message}`);
      });
    }, restartDelayMs);
    if (typeof restartTimer.unref === "function") restartTimer.unref();
  }

  async function handleOwnerRequest(command, payload, context) {
    if (String(command).startsWith("gateway.grpc.")) {
      return grpcBridge.handleRequest(command, payload, context);
    }
    return runtimeBridge.handleRequest(command, payload, context);
  }

  client = createClient({
    authorityName: AUTHORITY_NAME,
    workerPath: path.join(__dirname, "gatewayEdgeProcess.worker.js"),
    cwd: options.cwd || process.cwd(),
    env: {
      ...(options.env && typeof options.env === "object" ? options.env : {}),
      EVEJS_GATEWAY_EDGE_DEPENDENCIES: JSON.stringify(
        gatewayRuntime.dependencies || {},
      ),
      EVEJS_GATEWAY_EDGE_HOST: address.host,
      EVEJS_GATEWAY_EDGE_PORT: String(address.port),
      EVEJS_GATEWAY_EDGE_PROTOCOL: address.protocol,
      EVEJS_GATEWAY_EDGE_TEST_CRASH: options.enableTestCrash === true ? "1" : "0",
    },
    handleRequest: handleOwnerRequest,
    maxPending: options.maxPending || 256,
    requestTimeoutMs: options.requestTimeoutMs || 15_000,
    shutdownTimeoutMs: options.shutdownTimeoutMs || 15_000,
    startupTimeoutMs:
      options.startupTimeoutMs || (
        address.protocol === "https:"
          ? TLS_CERTIFICATE_CHILD_STARTUP_TIMEOUT_MS
          : 15_000
      ),
    onExit(exit) {
      if (!exit || exit.unexpected !== true) return;
      if (exit.previousState === "starting") {
        if (startupRestartAttempts >= maxStartupRestartAttempts) {
          runtimeLog.warn("[GatewayEdge] startup restart limit reached");
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
      return Promise.reject(new Error("gateway edge runtime is shutting down"));
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
      await grpcBridge.shutdown();
      await runtimeBridge.shutdown();
      const transport = await client.shutdown();
      if (typeof gatewayRuntime.shutdown === "function") {
        await gatewayRuntime.shutdown();
      }
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
      grpc: grpcBridge.getDiagnostics(),
      lastStatus,
      restartCount,
      startupRestartAttempts,
      runtime: runtimeBridge.getDiagnostics(),
      state,
      transport: client.getStats(),
    });
  }

  return Object.freeze({
    crashForTest() {
      if (options.enableTestCrash !== true) {
        const error = new Error("gateway edge test crash is disabled");
        error.code = "GATEWAY_EDGE_TEST_CRASH_DISABLED";
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
  createGatewayEdgeRuntime,
};
