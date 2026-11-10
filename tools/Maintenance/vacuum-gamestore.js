#!/usr/bin/env node
"use strict";

/**
 * vacuum-gamestore.js  (offline maintenance command)
 *
 * SQLite keeps the pages that deletes and rewrites free up inside the file, so
 * gamestore.sqlite only ever grows. VACUUM rewrites it with the live pages
 * only. Run it with the server stopped: it takes the exclusive maintenance
 * lease first, so it refuses while the server (or another tool) holds a
 * persistence lease, and a server started meanwhile refuses in turn.
 *
 * Usage:
 *   node tools/Maintenance/vacuum-gamestore.js [--store-root <dir>] [--dry-run]
 *
 * --dry-run only reports sizes and free pages. It opens the file read-only and
 * takes no lease, so it is safe while the server runs.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { createRequire } = require("module");

const repoRoot = path.resolve(__dirname, "..", "..");
const serverRequire = createRequire(path.join(repoRoot, "server", "package.json"));
const Database = serverRequire("better-sqlite3");
const sqliteStore = require(path.join(repoRoot, "server", "src", "gameStore", "sqliteStore"));
const storeRootModule = require(path.join(repoRoot, "server", "src", "gameStore", "storeRoot"));

const DB_FILE_NAME = "gamestore.sqlite";
// Long enough for a multi-gigabyte store; the lease is released as soon as
// VACUUM ends.
const MAINTENANCE_LEASE_MS = 10 * 60 * 1000;
const EXIT_REFUSED = 2;

class RefusedError extends Error {}

function usage() {
  return [
    "Usage: node tools/Maintenance/vacuum-gamestore.js [options]",
    "",
    "Compacts gamestore.sqlite by dropping its free pages. Stop the server first.",
    "",
    "Options:",
    "  --store-root <dir>  The gameStore folder. Default: the folder the server uses",
    "                      (EVEJS_GAMESTORE_DATA_DIR's parent, else _local/gameStore).",
    "  --dry-run           Report sizes and free pages only; no lease, no changes.",
    "  --help              Show this message",
    "",
  ].join("\n");
}

function parseArgs(argv) {
  const options = { storeRoot: null, dryRun: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--store-root") {
      const value = argv[++index];
      if (!value) {
        throw new Error("--store-root requires a folder");
      }
      options.storeRoot = path.resolve(value);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  options.storeRoot ||= storeRootModule.resolveStoreRoot();
  return options;
}

function fileSize(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch (_) {
    // ignored: a missing -wal or -shm sidecar is simply size 0
    return 0;
  }
}

function measure(dbPath, connection) {
  return {
    fileBytes: fileSize(dbPath),
    walBytes: fileSize(`${dbPath}-wal`),
    pageSize: connection.pragma("page_size", { simple: true }),
    pageCount: connection.pragma("page_count", { simple: true }),
    freePages: connection.pragma("freelist_count", { simple: true }),
  };
}

function reportDryRun(dbPath) {
  const connection = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return { dbPath, dryRun: true, before: measure(dbPath, connection), after: null };
  } finally {
    connection.close();
  }
}

function vacuumGameStore({ storeRoot, dryRun = false, leaseMs = MAINTENANCE_LEASE_MS }) {
  const dbPath = path.join(storeRoot, DB_FILE_NAME);
  if (!fs.existsSync(dbPath)) {
    throw new Error(`No ${DB_FILE_NAME} in ${storeRoot}`);
  }
  if (dryRun) {
    return reportDryRun(dbPath);
  }

  sqliteStore.init(dbPath);
  let fence = null;
  let connection = null;
  try {
    try {
      fence = sqliteStore.acquirePersistenceOwner(
        "maintenance",
        `vacuum-gamestore:${process.pid}:${crypto.randomUUID()}`,
        { leaseMs },
      );
    } catch (error) {
      if (error.code === "PERSISTENCE_OWNER_ACTIVE" || error.code === "PERSISTENCE_OWNER_CONFLICT") {
        throw new RefusedError(
          `Refusing to vacuum: the store is in use (${error.message}). Stop the server and try again.`,
        );
      }
      throw error;
    }

    // VACUUM runs on its own connection; the store's connection stays idle
    // and only holds the lease row.
    connection = new Database(dbPath, { fileMustExist: true });
    connection.pragma("busy_timeout = 5000");
    const before = measure(dbPath, connection);
    const startedAt = Date.now();
    connection.pragma("wal_checkpoint(TRUNCATE)");
    connection.exec("VACUUM");
    connection.pragma("wal_checkpoint(TRUNCATE)");
    const durationMs = Date.now() - startedAt;
    const after = measure(dbPath, connection);
    return { dbPath, dryRun: false, before, after, durationMs };
  } finally {
    if (connection) {
      connection.close();
    }
    if (fence) {
      sqliteStore.releasePersistenceOwner(fence);
    }
    sqliteStore.close();
  }
}

function megabytes(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function describe(stats) {
  const freeShare = stats.pageCount > 0 ? Math.round((stats.freePages / stats.pageCount) * 100) : 0;
  return `${megabytes(stats.fileBytes)} (WAL ${megabytes(stats.walBytes)}), ` +
    `${stats.pageCount} pages of ${stats.pageSize} bytes, ${stats.freePages} free (${freeShare}%)`;
}

function formatResult(result) {
  const lines = [`${result.dbPath}`, `  before: ${describe(result.before)}`];
  if (result.after) {
    lines.push(`  after:  ${describe(result.after)}`);
    const freed = (result.before.fileBytes + result.before.walBytes) -
      (result.after.fileBytes + result.after.walBytes);
    lines.push(`  vacuumed in ${(result.durationMs / 1000).toFixed(1)} s, ${megabytes(freed)} freed`);
  } else {
    lines.push("  dry run: nothing changed");
  }
  return `${lines.join("\n")}\n`;
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(usage());
    return 0;
  }
  process.stdout.write(formatResult(vacuumGameStore(options)));
  return 0;
}

module.exports = {
  MAINTENANCE_LEASE_MS,
  formatResult,
  parseArgs,
  vacuumGameStore,
};

if (require.main === module) {
  let exitCode;
  try {
    exitCode = main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    exitCode = error instanceof RefusedError ? EXIT_REFUSED : 1;
  }
  process.exitCode = exitCode;
}
