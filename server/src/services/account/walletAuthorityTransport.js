"use strict";

const crypto = require("node:crypto");
const path = require("node:path");

const { createOrderedProcessClient } = require(path.join(
  __dirname,
  "../_shared/orderedProcessClient",
));
const {
  configuredLeaseMs,
  recommendedOuterStartupTimeoutMs,
} = require(path.join(__dirname, "../../gameStore/persistenceLeasePolicy"));
const projection = require(path.join(__dirname, "./walletAuthorityProjection"));

const RETRYABLE_CODES = new Set([
  "AUTHORITY_PROCESS_EXITED",
  "AUTHORITY_REQUEST_TIMEOUT",
  "AUTHORITY_START_FAILED",
  "AUTHORITY_START_TIMEOUT",
]);

function positiveInteger(value, fallback) {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : fallback;
}

function createWalletAuthorityTransport(options = {}) {
  let retryCount = 0;
  const persistenceOwnerInstanceId = String(
    options.persistenceOwnerInstanceId ||
      `wallet-supervisor:${process.pid}:${crypto.randomUUID()}`,
  ).trim();
  if (!persistenceOwnerInstanceId) {
    throw new TypeError("wallet authority requires a persistence owner instance ID");
  }
  const childEnvironment = {
    ...(options.env && typeof options.env === "object" ? options.env : {}),
    EVEJS_GAMESTORE_OWNER_INSTANCE: persistenceOwnerInstanceId,
  };
  const configuredAcquireWait =
    childEnvironment.EVEJS_PERSISTENCE_OWNER_ACQUIRE_WAIT_MS === undefined
      ? process.env.EVEJS_PERSISTENCE_OWNER_ACQUIRE_WAIT_MS
      : childEnvironment.EVEJS_PERSISTENCE_OWNER_ACQUIRE_WAIT_MS;
  const defaultStartupTimeoutMs = recommendedOuterStartupTimeoutMs(
    configuredLeaseMs(
      childEnvironment.EVEJS_PERSISTENCE_OWNER_LEASE_MS === undefined
        ? process.env.EVEJS_PERSISTENCE_OWNER_LEASE_MS
        : childEnvironment.EVEJS_PERSISTENCE_OWNER_LEASE_MS,
    ),
    configuredAcquireWait,
  );
  const externalEventHandler = typeof options.onEvent === "function"
    ? options.onEvent
    : null;
  const orderedProcessClientFactory =
    options.orderedProcessClientFactory || createOrderedProcessClient;
  const client = orderedProcessClientFactory({
    authorityName: "wallet",
    workerPath: options.workerPath || path.join(
      __dirname,
      "walletAuthorityProcess.worker.js",
    ),
    maxPending: positiveInteger(
      options.maxPending || process.env.EVEJS_WALLET_AUTHORITY_MAX_PENDING,
      256,
    ),
    requestTimeoutMs: positiveInteger(
      options.requestTimeoutMs || process.env.EVEJS_WALLET_AUTHORITY_TIMEOUT_MS,
      15_000,
    ),
    startupTimeoutMs: positiveInteger(
      options.startupTimeoutMs,
      defaultStartupTimeoutMs,
    ),
    shutdownTimeoutMs: positiveInteger(options.shutdownTimeoutMs, 10_000),
    cwd: options.cwd,
    env: childEnvironment,
    forkProcess: options.forkProcess,
    onEvent(event) {
      if (
        event.topic === "wallet.committed" ||
        event.topic === "wallet.snapshot"
      ) {
        projection.publishCommittedProjection({
          ...event.payload,
          generation: event.generation,
          sequence: event.sequence,
        });
      }
      if (externalEventHandler) {
        externalEventHandler(event);
      }
    },
  });

  async function execute(commandType, payload = {}, metadata = {}) {
    const commandID = String(metadata.commandID || crypto.randomUUID());
    const maxAttempts = positiveInteger(metadata.maxAttempts, 2);
    let attempt = 0;
    while (attempt < maxAttempts) {
      attempt += 1;
      try {
        return await client.call(commandType, payload, {
          ...metadata,
          commandID,
          attempt,
        });
      } catch (error) {
        if (attempt >= maxAttempts || !RETRYABLE_CODES.has(error && error.code)) {
          throw error;
        }
        retryCount += 1;
      }
    }
    throw new Error("Wallet authority retry loop exhausted");
  }

  return Object.freeze({
    execute,
    start: client.start,
    shutdown: client.shutdown,
    getStats() {
      return Object.freeze({
        ...client.getStats(),
        persistenceOwnerInstanceId,
        retries: retryCount,
      });
    },
  });
}

let defaultTransport = null;

function getWalletAuthorityTransport() {
  if (!defaultTransport) {
    defaultTransport = createWalletAuthorityTransport();
  }
  return defaultTransport;
}

module.exports = {
  createWalletAuthorityTransport,
  getWalletAuthorityTransport,
  _resetDefaultTransportForTests() {
    defaultTransport = null;
  },
};
