"use strict";

const path = require("node:path");

const database = require(path.join(__dirname, "../../gameStore"));
const walletCommandAuthority = require(path.join(
  __dirname,
  "./walletCommandAuthority",
));

function createProductionWalletAuthorityRuntime(options = {}) {
  const store = options.database || database;
  const authority = options.walletCommandAuthority || walletCommandAuthority;
  let state = "idle";
  let startPromise = null;
  let shutdownPromise = null;
  let startResult = null;

  function start() {
    if (state === "started") {
      return Promise.resolve(startResult);
    }
    if (startPromise) {
      return startPromise;
    }
    if (state === "closing" || state === "closed") {
      return Promise.reject(new Error("production wallet authority is shutting down"));
    }

    state = "starting";
    startPromise = Promise.resolve().then(async () => {
      const flushResult = store.flushAllSync();
      if (!flushResult || flushResult.success !== true) {
        const error = new Error(
          "wallet authority preflight could not durably flush parent-owned state",
        );
        error.code = "WALLET_AUTHORITY_PREFLIGHT_FLUSH_FAILED";
        throw error;
      }

      await authority.enableWalletAuthorityProcess();
      startResult = Object.freeze({
        processEnabled: true,
        preflightTables: Array.isArray(flushResult.results)
          ? flushResult.results.length
          : 0,
      });
      state = "started";
      return startResult;
    }).catch((error) => {
      state = "idle";
      startPromise = null;
      throw error;
    });
    return startPromise;
  }

  function shutdown() {
    if (shutdownPromise) {
      return shutdownPromise;
    }
    state = "closing";
    shutdownPromise = Promise.resolve(startPromise)
      .catch(() => null)
      .then(() => authority.shutdownWalletAuthorityProcess())
      .finally(() => {
        state = "closed";
      });
    return shutdownPromise;
  }

  return Object.freeze({
    getState: () => state,
    shutdown,
    start,
  });
}

module.exports = {
  createProductionWalletAuthorityRuntime,
};
