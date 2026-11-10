#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { isDeepStrictEqual } = require("node:util");
const {
  applySovProspectingNamePatch,
  buildSovProspectingNameRepair,
} = require("../../server/src/services/dungeon/sovProspectingNameRepair");

const repoRoot = path.resolve(__dirname, "..", "..");
const TABLE = "dungeonRuntimeState";

function parseArgs(argv) {
  const options = { apply: false, backupDir: path.join(repoRoot, "_local", "backups") };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--apply") options.apply = true;
    else if (token === "--dry-run") options.apply = false;
    else if (token === "--help") options.help = true;
    else if (token === "--backup-dir" || token === "--system-id") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${token}`);
      if (token === "--backup-dir") options.backupDir = path.resolve(value);
      else {
        options.systemID = Number(value);
        if (!Number.isSafeInteger(options.systemID) || options.systemID <= 0) {
          throw new Error("--system-id must be a positive integer");
        }
      }
    } else throw new Error(`Unknown argument: ${token}`);
  }
  return options;
}

function requireSuccess(result, operation) {
  if (!result || result.success !== true) {
    throw new Error(`${operation} failed: ${result && (result.errorMsg || result.code) || "UNKNOWN"}`);
  }
  return result;
}

function writeBackup(backupDir, originals, database) {
  requireSuccess(database.flushTableSync(TABLE), "Flush dungeon runtime before backup");
  const Database = require(require.resolve("better-sqlite3", {
    paths: [path.join(repoRoot, "server")],
  }));
  fs.mkdirSync(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, `sov-prospecting-names-${Date.now()}-${process.pid}`);
  fs.mkdirSync(backupPath);
  const snapshotPath = path.join(backupPath, "gamestore.sqlite");
  const source = new Database(database._sqliteDbPath, { readonly: true, fileMustExist: true });
  try {
    // One consistent SQLite snapshot includes committed WAL contents. Copying
    // only the main database file would silently omit those saved changes.
    source.prepare("VACUUM INTO ?").run(snapshotPath);
  } finally {
    source.close();
  }
  const snapshot = new Database(snapshotPath, { readonly: true, fileMustExist: true });
  try {
    if (snapshot.pragma("quick_check", { simple: true }) !== "ok") {
      throw new Error(`SQLite backup integrity check failed: ${snapshotPath}`);
    }
    const select = snapshot.prepare('SELECT json FROM "dungeonRuntimeState" WHERE key = ?');
    for (const [instanceKey, original] of Object.entries(originals)) {
      const row = select.get(`instancesByID\u001f${instanceKey}`);
      if (!row || !isDeepStrictEqual(JSON.parse(row.json), original)) {
        throw new Error(`SQLite backup content verification failed for ${instanceKey}: ${snapshotPath}`);
      }
    }
  } finally {
    snapshot.close();
  }
  const backup = {
    schema: "evejs.sov-prospecting-name-backup.v1",
    source: database._sqliteDbPath,
    createdAt: new Date().toISOString(),
    table: TABLE,
    instancesByID: originals,
  };
  const manifestPath = path.join(backupPath, "manifest.json");
  fs.writeFileSync(manifestPath, `${JSON.stringify(backup, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  if (!isDeepStrictEqual(JSON.parse(fs.readFileSync(manifestPath, "utf8")), backup)) {
    throw new Error(`Backup manifest verification failed: ${manifestPath}`);
  }
  return backupPath;
}

// Injected dependencies keep the ownership/backup/write ordering testable
// without granting unit tests access to a user's game store.
async function executeRepair({ database, loadTemplates, options, backup = writeBackup, log = console.log }) {
  let failure = null;
  try {
    if (options.apply) database.acquirePersistenceOwnerLease({ recover: true });
    const state = requireSuccess(database.readPersisted(TABLE, "/"), "Read dungeon runtime").data;
    const plan = buildSovProspectingNameRepair(state, loadTemplates(), options);
    log(JSON.stringify({ mode: options.apply ? "apply" : "dry-run", ...plan.report }, null, 2));
    if (!options.apply || !plan.patches.length) return plan.report;

    // Snapshot SQLite and record the affected originals in its manifest. No
    // gameplay record is written before the backup passes verification.
    const originals = Object.fromEntries(plan.patches.map((patch) => [patch.instanceKey, state.instancesByID[patch.instanceKey]]));
    const backupPath = backup(options.backupDir, originals, database);
    database.renewPersistenceOwnerLease();
    for (const patch of plan.patches) {
      const persisted = requireSuccess(database.readPersisted(TABLE, `/instancesByID/${patch.instanceKey}`), "Verify original instance").data;
      if (!isDeepStrictEqual(persisted, originals[patch.instanceKey])) {
        throw new Error(`Instance ${patch.instanceID} changed after planning; backup: ${backupPath}`);
      }
    }
    const expected = new Map();
    for (const patch of plan.patches) {
      const repaired = applySovProspectingNamePatch(originals[patch.instanceKey], patch);
      expected.set(patch.instanceKey, repaired);
      requireSuccess(database.write(TABLE, `/instancesByID/${patch.instanceKey}`, repaired), `Repair instance ${patch.instanceID}; backup ${backupPath}`);
    }
    requireSuccess(database.flushTableSync(TABLE), `Flush repairs; backup ${backupPath}`);
    database.renewPersistenceOwnerLease();
    for (const [instanceKey, repaired] of expected) {
      const persisted = requireSuccess(database.readPersisted(TABLE, `/instancesByID/${instanceKey}`), `Read durable repair; backup ${backupPath}`).data;
      if (!isDeepStrictEqual(persisted, repaired)) {
        throw new Error(`Durable verification failed for instance ${instanceKey}; backup: ${backupPath}`);
      }
    }
    log(`Repaired ${plan.patches.length} Sov Prospecting name(s). Backup: ${backupPath}`);
    return { ...plan.report, backupPath };
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    if (options.apply) {
      try {
        requireSuccess(await database.shutdown("repair-sov-prospecting-names"), "GameStore maintenance shutdown");
      } catch (shutdownError) {
        if (failure) {
          failure.shutdownError = shutdownError;
          log(`GameStore maintenance shutdown also failed: ${shutdownError.message}`);
        } else throw shutdownError;
      }
    }
  }
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log([
      "Usage: node tools/Maintenance/repair-sov-prospecting-names.js [options]",
      "Run with the server and other writers stopped before --apply.",
      "  --dry-run             Read and report only (default)",
      "  --apply               Acquire maintenance lease, back up SQLite, repair names",
      "  --system-id <id>      Restrict repair to one solar system",
      "  --backup-dir <path>   Backup destination (default: _local/backups)",
      "  --help                Show this help",
      "Uses EVEJS_GAMESTORE_DATA_DIR and installed content packs for the selected store.",
    ].join("\n"));
    return;
  }
  process.env.EVEJS_GAMESTORE_OWNER_ROLE = options.apply ? "maintenance" : "reader";
  const database = require("../../server/src/gameStore");
  if (!fs.existsSync(database._sqliteDbPath)) {
    throw new Error(`No existing game database at ${database._sqliteDbPath}; nothing was created`);
  }
  await executeRepair({
    database,
    options,
    loadTemplates: () => {
      // A missing validation receipt must not make a dry run write a cache.
      require("../../server/src/contentPacks/contentPackManager").initializeContentPacks({ readOnly: true });
      return require("../../server/src/services/dungeon/dungeonAuthority").listTemplateSelectionDescriptorsByFamily("ore");
    },
  });
}

if (require.main === module) {
  void main().catch((error) => {
    console.error(error && error.stack || error);
    process.exitCode = 1;
  });
}

module.exports = { executeRepair, main, parseArgs, writeBackup };
