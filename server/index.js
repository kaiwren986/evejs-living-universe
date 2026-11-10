"use strict";

/**
 * EVE.js — Main Entry Point
 *
 * Boots the world with every stage enabled and starts the TCP server.
 * The startup sequence itself lives in bootstrap.js so other callers — the
 * gameplay test harness in particular — can boot the same world with the
 * listeners and durable owners switched off.
 */

// This process is the durable owner for every runtime table not delegated to
// the wallet or scheduler authority. Set the role before any dependency can
// import gameStore transitively.
process.env.EVEJS_GAMESTORE_OWNER_ROLE = "world";
process.env.EVEJS_GAMESTORE_OWNER_INSTANCE =
  `world-supervisor:${process.pid}:${require("node:crypto").randomUUID()}`;

const path = require("path");

// Logs used to be written to server/logs. Move them to the data root's logs folder before
// anything below writes a log. After the first start there is nothing left to move, and an
// EVEJS_DATA_ROOT set on purpose is never filled from the checkout.
const {
  adoptLegacyDataDir,
  describeAdoption,
} = require(path.join(__dirname, "./src/config/dataRootMigration"));
const legacyLogsAdoption = adoptLegacyDataDir("logs", path.join(__dirname, "logs"));

const pauseProfile = require("./src/utils/pauseProfiler").startPauseProfilerFromEnvironment();

const { bootWorld } = require(path.join(__dirname, "./bootstrap"));
const database = require(path.join(__dirname, "./src/gameStore"));
const {
  installOwnerProcessShutdown,
} = require(path.join(__dirname, "./src/gameStore/ownerProcessShutdown"));
const rotatingLog = require(path.join(__dirname, "./src/utils/rotatingLog"));
const log = require(path.join(__dirname, "./src/utils/logger"));

const legacyLogsMessage = describeAdoption("server/logs", legacyLogsAdoption);
if (legacyLogsMessage) {
  if (legacyLogsAdoption.status === "moved") {
    log.info(legacyLogsMessage);
  } else {
    log.warn(legacyLogsMessage);
  }
}

// This process owns its signals and exit codes. The store only shuts down when
// asked; Ctrl+C, a lost owner lease and process exit all come through here.
installOwnerProcessShutdown(database);
if (pauseProfile.enabled) {
  database.registerShutdownHook("pause-profile", () => pauseProfile.stop("shutdown"));
}

// Longest wait for the log files before a failed start exits anyway.
const FAILED_START_LOG_FLUSH_MS = 2000;

// main startup

void bootWorld({ appName: "eve.js server" }).catch(async () => {
  await pauseProfile.stop("boot-failed");
  // bootWorld has already logged the failure and unwound the durable owners
  // and the store. The log files are written asynchronously and startup is
  // mostly synchronous work, so none of the failed start may be on disk yet:
  // write it out before exiting, or server.log shows no trace of it.
  await Promise.race([
    rotatingLog.flushAll(),
    new Promise((resolve) => setTimeout(resolve, FAILED_START_LOG_FLUSH_MS)),
  ]).catch(() => null);
  process.exit(1);
});
