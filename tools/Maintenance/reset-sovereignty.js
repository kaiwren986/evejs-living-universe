#!/usr/bin/env node
"use strict";

/**
 * reset-sovereignty.js  (offline maintenance command)
 *
 * One-time reset to retail-parity sovereignty. The server supports only
 * today's Tranquility rules: the Sovereignty Hub is the only sovereignty
 * structure and a claimed Hub is the claim. Sovereignty data from earlier
 * releases (TCU claims, empty claims, display-only campaigns) is not repaired;
 * the reset removes it once and records a marker so later runs do nothing.
 * What it removes is listed in server/src/services/sovereignty/sovParityReset.js,
 * which holds the reset itself.
 *
 * The server runs the same reset at startup when the marker is missing, so
 * this command is only needed with the server stopped: the Updater runs it
 * after every update, and it is the way to preview (--dry-run) or repeat
 * (--force) the reset. It refuses to run while the server holds the game store.
 *
 *   node tools/Maintenance/reset-sovereignty.js [--dry-run] [--force]
 *
 *   --dry-run  report what would be removed and change nothing
 *   --force    run again even though the marker says the reset already ran
 *
 * When there is anything to remove, the game database is backed up first, to
 * <store root>/../backups/sov-parity-reset-<time>/ (EVEJS_SOV_RESET_BACKUP_DIR
 * overrides the backups folder).
 */

const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.join(__dirname, "..", "..");

// Honour the same data dir the server uses so the reset writes where the
// server will read it.
if (!process.env.EVEJS_GAMESTORE_DATA_DIR) {
  process.env.EVEJS_GAMESTORE_DATA_DIR = path.join(
    REPO_ROOT,
    "_local",
    "gameStore",
    "data",
  );
}
// This script is an explicit offline writer. The maintenance role takes an
// exclusive lease, so it cannot run beside the server.
process.env.EVEJS_GAMESTORE_OWNER_ROLE = "maintenance";

function parseArguments(argv) {
  const options = { dryRun: false, force: false };
  for (const argument of argv) {
    if (argument === "--dry-run") {
      options.dryRun = true;
    } else if (argument === "--force") {
      options.force = true;
    } else if (argument === "--help" || argument === "-h") {
      process.stdout.write(
        "Usage: node tools/Maintenance/reset-sovereignty.js [--dry-run] [--force]\n",
      );
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  return options;
}

function requireSuccess(result, operation) {
  if (!result || result.success !== true) {
    throw new Error(
      `${operation} failed: ${result && (result.errorMsg || result.code) || "unknown error"}`,
    );
  }
  return result;
}

// The Updater runs this on every install, including one that has not built
// its game database yet. Loading the store would create an empty one under
// _local, which the server would then pick over its source data, so a missing
// database is "nothing to reset", not an error.
function findExistingDatabase() {
  const storeRoot = path.resolve(process.env.EVEJS_GAMESTORE_DATA_DIR, "..");
  const databasePath = path.join(storeRoot, "gamestore.sqlite");
  return fs.existsSync(databasePath) ? databasePath : null;
}

function summarize(result) {
  if (result.status === "already-ran") {
    return `The retail-parity sovereignty reset already ran at ${result.marker.at || "an unknown time"}; nothing to do.`;
  }
  if (result.status === "dry-run") {
    return ["Dry run. The sovereignty reset would remove:", ...result.lines.map((line) => `  ${line}`)].join("\n");
  }
  return [
    "Retail-parity sovereignty reset complete.",
    `  backup: ${result.backupDirectory || "none (there was nothing to remove)"}`,
    ...result.lines.map((line) => `  removed ${line}`),
    `  removed structure rows: ${result.removed.structures}, skyhook items: ${result.removed.skyhookItems}, ` +
      `skyhook orbital rows: ${result.removed.skyhookOrbitals}, campaign tick jobs: ${result.removed.jobs}`,
    "  static sovereignty resource definitions were kept",
  ].join("\n");
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const existingDatabase = findExistingDatabase();
  if (!existingDatabase) {
    process.stdout.write(
      `No game database at ${path.resolve(process.env.EVEJS_GAMESTORE_DATA_DIR, "..")}; ` +
      "there is no sovereignty data to reset. The server records the reset when it first starts.\n",
    );
    return;
  }
  let database = null;
  let failure = null;
  let summary = null;
  try {
    database = require(path.join(REPO_ROOT, "server", "src", "gameStore"));
    try {
      database.acquirePersistenceOwnerLease({ recover: true });
    } catch (error) {
      const code = String(error && error.code || "");
      if (code.startsWith("PERSISTENCE_OWNER")) {
        const refusal = new Error(
          "The game store is held by another process, probably the server. " +
          "The server runs this reset itself when it starts; to run it here, stop the server and try again.",
        );
        refusal.code = "SOVEREIGNTY_RESET_STORE_BUSY";
        refusal.exitCode = 2;
        throw refusal;
      }
      throw error;
    }
    const { runSovereigntyParityReset } = require(path.join(
      REPO_ROOT, "server", "src", "services", "sovereignty", "sovParityReset",
    ));
    summary = summarize(await runSovereigntyParityReset(database, {
      tool: "reset-sovereignty",
      dryRun: options.dryRun,
      force: options.force,
    }));
  } catch (error) {
    failure = error;
  }

  // Report while the store is still up, and drain the stream, so nothing is
  // left to write after shutdown.
  let exitCode = failure ? (Number(failure.exitCode) || 1) : 0;
  const stream = failure ? process.stderr : process.stdout;
  const report = failure
    ? `${failure && failure.stack ? failure.stack : failure}\n` +
      (failure && failure.backupDirectory ? `The game database was backed up to ${failure.backupDirectory} first.\n` : "")
    : `${summary}\n`;
  await new Promise((resolve) => stream.write(report, () => resolve()));

  if (database) {
    try {
      requireSuccess(await database.shutdown("reset-sovereignty"), "GameStore shutdown");
    } catch (shutdownError) {
      exitCode = exitCode || 1;
      await new Promise((resolve) => process.stderr.write(
        `GameStore shutdown failed: ${shutdownError.message}\n`,
        () => resolve(),
      ));
    }
  }
  // Exit at once. The structure and inventory modules keep timers that read
  // the store, and a read after shutdown re-acquires the maintenance lease
  // and never releases it, which would refuse the next maintenance run for
  // the whole lease period.
  process.exit(exitCode);
}

main().catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : error}\n`, () => process.exit(1));
});
