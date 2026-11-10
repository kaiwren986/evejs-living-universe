#!/usr/bin/env node
"use strict";

/**
 * Migrate legacy per-table JSON runtime data into the SQLite backend.
 *
 * The server already auto-seeds each runtime table from its data.json the
 * first time it is read, so most installs never need to run this. Use it when
 * you want to migrate explicitly — e.g. before a deploy, or to confirm the
 * SQLite file is fully populated — without starting the server.
 *
 * For every runtime table it reads <DATA_DIR>/<table>/data.json and loads each
 * top-level entry as a row (key = top-level key, json = the value) into the
 * SQLite database the server uses. Your data.json files are left untouched.
 *
 * Idempotent: re-running re-imports each table from its JSON file.
 *
 * Usage:
 *   node src/gameStore/migrateJsonToSqlite.js              # all runtime tables
 *   node src/gameStore/migrateJsonToSqlite.js accounts mail   # specific tables
 *   node src/gameStore/migrateJsonToSqlite.js --help
 *
 * The data directory is resolved exactly like the server: $EVEJS_GAMESTORE_DATA_DIR,
 * else _local/gameStore/data, else the in-repo source data dir.
 */

const fs = require("fs");
const path = require("path");
const { isDeepStrictEqual } = require("node:util");

// This is an offline writer. Declaring the role before importing GameStore is
// intentional: unlabelled tools are read-only and never recover a live outbox.
process.env.EVEJS_GAMESTORE_OWNER_ROLE = "maintenance";

// GameStore is lazy: importing it resolves the same paths as production, while
// the first public table operation explicitly acquires maintenance ownership.
const database = require("./index");
const sqliteStore = require("./sqliteStore");

function printHelp() {
  console.log(
    [
      "Migrate legacy per-table JSON runtime data into the SQLite backend.",
      "",
      "Usage:",
      "  node src/gameStore/migrateJsonToSqlite.js [table ...]",
      "",
      "With no arguments, migrates every runtime table currently routed to SQLite.",
      "Your data.json files are left untouched; re-running is safe (idempotent).",
      "Missing or blank data.json files are rejected; use an explicit {} to import an empty table.",
      "",
      `SQLite database: ${database._sqliteDbPath}`,
      `Data directory:  ${database._dataDir}`,
    ].join("\n"),
  );
}

function readMigrationInput(table) {
  const dataFile = path.join(database._dataDir, table, "data.json");
  if (!fs.existsSync(dataFile)) {
    return {
      table,
      rows: 0,
      error: `missing data.json: ${dataFile}; use {} for an explicit empty import`,
    };
  }
  const raw = fs.readFileSync(dataFile, "utf8");
  if (!String(raw).trim()) {
    return {
      table,
      rows: 0,
      error: `data.json is empty: ${dataFile}; use {} for an explicit empty import`,
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { table, rows: 0, error: `invalid JSON: ${error.message}` };
  }

  try {
    const exploded = sqliteStore.explodeToRows(table, parsed);
    const roundTripped = sqliteStore.assembleFromRows(table, exploded);
    if (!isDeepStrictEqual(roundTripped, parsed)) {
      return {
        table,
        rows: 0,
        error: "JSON shape is not losslessly representable as SQLite rows",
      };
    }
    return {
      table,
      parsed,
      rows: Object.keys(exploded).length,
      note: null,
    };
  } catch (error) {
    return {
      table,
      rows: 0,
      error: `JSON shape validation failed: ${error.message}`,
    };
  }
}

function migrateTable(input) {
  const { table, parsed, rows, note } = input;

  const write = database.write(table, "/", parsed, { force: true });
  if (!write || write.success !== true) {
    return {
      table,
      rows: 0,
      error: `GameStore write failed: ${write && write.errorMsg || "UNKNOWN"}`,
    };
  }
  // This CLI performs a synchronous multi-table migration, so its interval
  // heartbeat cannot run until control returns to the event loop. Renew at
  // explicit table boundaries instead of silently letting a long run outlive
  // its maintenance fence.
  database.renewPersistenceOwnerLease();
  const flush = database.flushTableSync(table);
  if (!flush || flush.success !== true) {
    return {
      table,
      rows: 0,
      error: `GameStore flush failed: ${flush && flush.errorMsg || "UNKNOWN"}`,
    };
  }
  database.renewPersistenceOwnerLease();
  const durable = database.readPersisted(table, "/");
  if (!durable || durable.success !== true) {
    return {
      table,
      rows: 0,
      error: `durable verification read failed: ${durable && durable.errorMsg || "UNKNOWN"}`,
    };
  }
  if (!isDeepStrictEqual(durable.data, parsed)) {
    return { table, rows: 0, error: "durable verification mismatch" };
  }

  return {
    table,
    rows,
    note,
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return;
  }

  const unknown = args.filter((table) => !database._sqliteTables.has(table));
  if (unknown.length > 0) {
    console.error(
      `Not SQLite-backed runtime tables (skipping): ${unknown.join(", ")}`,
    );
  }
  const tables = (args.length > 0 ? args : [...database._sqliteTables])
    .filter((table) => database._sqliteTables.has(table))
    .sort();

  if (tables.length === 0) {
    console.log("No runtime tables to migrate.");
    return;
  }

  // Snapshot and prove every input's exact SQLite representation before
  // opening the database or acquiring maintenance ownership. A rejected table
  // therefore cannot leave an earlier table partially imported.
  const inputs = tables.map(readMigrationInput);
  const invalidInputs = inputs.filter((input) => input.error);
  if (invalidInputs.length > 0) {
    for (const input of invalidInputs) {
      console.error(`  x ${input.table}: ${input.error}`);
    }
    console.error(
      `Preflight failed for ${invalidInputs.length} table(s); no tables were changed.`,
    );
    process.exitCode = 1;
    return;
  }

  let failures = 0;
  let workError = null;
  try {
    // Take the exclusive maintenance fence before recovery or application-row
    // mutation. Preflight inputs are immutable in-memory snapshots, so a source
    // file cannot change between validation and its durable write.
    database.acquirePersistenceOwnerLease({ recover: true });
    console.log(`Migrating ${tables.length} runtime table(s) → ${database._sqliteDbPath}`);
    let totalRows = 0;
    for (const input of inputs) {
      const result = migrateTable(input);
      if (result.error) {
        failures += 1;
        console.error(`  x ${input.table}: ${result.error}`);
        continue;
      }
      totalRows += result.rows;
      console.log(
        `  + ${input.table.padEnd(28)} ${String(result.rows).padStart(6)} row(s)` +
          (result.note ? `  (${result.note})` : ""),
      );
    }

    console.log(
      `\nDone: ${tables.length - failures}/${tables.length} table(s), ` +
        `${totalRows} row(s) imported.` +
        (failures > 0 ? ` ${failures} failed.` : ""),
    );
  } catch (error) {
    workError = error;
    throw error;
  } finally {
    const shutdown = await database.shutdown("json-to-sqlite-migration");
    if (!shutdown || shutdown.success !== true) {
      const shutdownError = new Error(
        `GameStore maintenance shutdown failed: ${shutdown && shutdown.errorMsg || "UNKNOWN"}`,
      );
      shutdownError.code = shutdown && shutdown.code || "GAMESTORE_SHUTDOWN_FAILED";
      if (workError) {
        workError.shutdownError = shutdownError;
        console.error(shutdownError.stack || shutdownError);
      } else {
        throw shutdownError;
      }
    }
  }
  process.exitCode = failures > 0 ? 1 : 0;
}

void main().catch((error) => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
