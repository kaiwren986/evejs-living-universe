"use strict";

// Signal, beforeExit and exit handling for a process that owns durable
// GameStore state: the world server and the wallet and scheduler authorities.
// The store never touches the process itself. Each of those entry points calls
// installOwnerProcessShutdown once, after it has set its owner role and loaded
// the store; test processes and maintenance tools do not.

const log = require("../utils/logger");

const SHUTDOWN_SIGNALS = Object.freeze(["SIGINT", "SIGTERM", "SIGBREAK", "SIGHUP"]);
const INSTALLED = Symbol.for("evejs.gameStore.ownerProcessShutdownInstalled");

function installOwnerProcessShutdown(database, options = {}) {
  const processRef = options.processRef || process;
  const signals = Array.isArray(options.signals) ? options.signals : SHUTDOWN_SIGNALS;
  if (processRef[INSTALLED]) {
    return processRef[INSTALLED];
  }

  let stopping = null;
  // Runs the store's signal shutdown once and exits: exitCode when every hook
  // and the store shut down cleanly, 1 otherwise.
  const shutdownAndExit = (signal, exitCode = 0) => {
    if (!stopping) {
      // Started synchronously so the store's "received <signal>" line comes
      // first, as it did when the store installed these handlers itself.
      let run;
      try {
        run = Promise.resolve(database.shutdownForSignal(signal));
      } catch (error) {
        run = Promise.reject(error);
      }
      stopping = run
        .then(
          (result) => processRef.exit(result && result.success ? exitCode : 1),
          () => processRef.exit(1),
        );
    }
    return stopping;
  };

  for (const signal of signals) {
    try {
      processRef.on(signal, () => {
        void shutdownAndExit(signal);
      });
    } catch (error) {
      log.warn(`[GameStore] failed to register ${signal} shutdown handler: ${error.message}`);
    }
  }

  // A fenced authority must not keep accepting state-changing traffic.
  const unsubscribeOwnerLost = database.onPersistenceOwnerLost(() => {
    processRef.exitCode = 1;
    void shutdownAndExit("PERSISTENCE_OWNER_LEASE_LOST", 1);
  });

  processRef.on("beforeExit", () => {
    const needs = database.getShutdownNeeds();
    if (needs.unflushedWrites || needs.holdsOwnerLease) {
      void database.shutdown("beforeExit").then((result) => {
        if (!result.success) processRef.exitCode = 1;
      });
    }
  });

  processRef.on("exit", () => {
    // Last-chance sync flush for any remaining dirty tables.
    if (database.getShutdownNeeds().unflushedWrites) {
      const result = database.flushDirtyTablesForShutdown("exit");
      if (!result.success && !processRef.exitCode) {
        processRef.exitCode = 1;
      }
    }
  });

  processRef[INSTALLED] = { shutdownAndExit, unsubscribeOwnerLost };
  return processRef[INSTALLED];
}

module.exports = {
  SHUTDOWN_SIGNALS,
  installOwnerProcessShutdown,
};
