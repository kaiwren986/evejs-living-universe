"use strict";

// The one-time reset to retail-parity sovereignty. The server supports only
// today's Tranquility rules: the Sovereignty Hub is the only sovereignty
// structure and a claimed Hub is the claim. Sovereignty data from earlier
// releases (TCU claims, empty claims, display-only campaigns) is not repaired;
// the reset removes it once and records a marker so later runs do nothing.
//
// It removes every claim, Hub with its upgrades and fuel, command node,
// campaign and its scheduled job, alliance prime hour and capital setting,
// development index and recent activity, Skyhook, Mercenary Den and FLEX
// structure (Ansiblex, Pharolux, Tenebrex), and everything stored in them.
// The static resource definitions in the sovereignty table are kept.
//
// Two callers, one implementation: the server runs it at startup, before any
// service or scene exists (sovResetMarker.applySovereigntyResetAtStartup), and
// tools/Maintenance/reset-sovereignty.js runs it offline for the Updater and
// the Docker maintenance command. Either way the caller already holds the
// store's owner lease.
//
// The server runs under the world role, and scheduledJobs belongs to the
// scheduler process, so the startup reset leaves campaign tick jobs in place.
// That is safe: the campaign tick handler finds no Hub for them and the
// scheduler drops them as stale when they come due. The maintenance tool may
// write every table and removes them.

const fs = require("fs");
const path = require("path");

const persistenceRoles = require(path.join(__dirname, "../../gameStore/persistenceRoles"));
const {
  SOVEREIGNTY_RESET_MARKER,
} = require(path.join(__dirname, "./sovConstants"));

const CAMPAIGN_TICK_JOB_TYPE = "sovereignty.campaign-tick";
const TYPE_TERRITORIAL_CLAIM_UNIT = 32226;
const TYPE_INFRASTRUCTURE_HUB = 32458;
const TYPE_SOVEREIGNTY_COMMAND_NODE = 34832;
const TYPE_PHAROLUX_CYNO_BEACON = 35840;
const TYPE_ANSIBLEX_JUMP_BRIDGE = 35841;
const TYPE_TENEBREX_CYNO_JAMMER = 37534;
const TYPE_ORBITAL_SKYHOOK = 81080;
const TYPE_MERCENARY_DEN = 85230;
const TYPE_SENESCHAL_MERCENARY_DEN = 85980;
const SOVEREIGNTY_STRUCTURE_TYPE_IDS = new Set([
  TYPE_TERRITORIAL_CLAIM_UNIT,
  TYPE_INFRASTRUCTURE_HUB,
  TYPE_SOVEREIGNTY_COMMAND_NODE,
  TYPE_PHAROLUX_CYNO_BEACON,
  TYPE_ANSIBLEX_JUMP_BRIDGE,
  TYPE_TENEBREX_CYNO_JAMMER,
  TYPE_ORBITAL_SKYHOOK,
  TYPE_MERCENARY_DEN,
  TYPE_SENESCHAL_MERCENARY_DEN,
]);
const RESET_TABLES = [
  "structures",
  "items",
  "planetOrbitalState",
  "scheduledJobs",
  "sovereignty",
];

function requireSuccess(result, operation) {
  if (!result || result.success !== true) {
    const error = new Error(
      `${operation} failed: ${result && (result.errorMsg || result.code) || "unknown error"}`,
    );
    error.code = result && (result.code || result.errorMsg) ||
      "GAMESTORE_MAINTENANCE_OPERATION_FAILED";
    throw error;
  }
  return result;
}

function toPositiveInteger(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : 0;
}

function isSovereigntyStructureRow(row) {
  if (!row) {
    return false;
  }
  if (SOVEREIGNTY_STRUCTURE_TYPE_IDS.has(toPositiveInteger(row.typeID))) {
    return true;
  }
  const flags = row.devFlags && typeof row.devFlags === "object" ? row.devFlags : {};
  return (
    flags.sovereigntyMirror === true ||
    flags.sovereigntyFlex === true ||
    flags.sovereigntyCommandNode === true ||
    flags.sovAutomation === true ||
    Boolean(flags.sovereigntyAuxiliary) ||
    Boolean(flags.sovAutoJobID)
  );
}

function isSystemWithSovereigntyData(system) {
  return Boolean(
    system &&
    (
      toPositiveInteger(system.allianceID) ||
      toPositiveInteger(system.claimStructureID) ||
      toPositiveInteger(system.infrastructureHubID) ||
      (Array.isArray(system.structures) && system.structures.length > 0)
    ),
  );
}

function readTable(database, table) {
  const result = database.read(table, "/");
  return result && result.success && result.data && typeof result.data === "object"
    ? result.data
    : {};
}

function readResetMarker(database) {
  const marker = (readTable(database, "sovereignty")._meta || {})[SOVEREIGNTY_RESET_MARKER];
  return marker && typeof marker === "object" ? marker : null;
}

// Required on first use, not at load: the server loads this module at startup
// and should not pull the structure and inventory modules in early just to
// find the marker already there.
function loadResetContext(database) {
  const removesJobs = persistenceRoles.roleMayMutateTable(database._processRole, "scheduledJobs");
  return {
    database,
    structureState: require(path.join(__dirname, "../structure/structureState")),
    itemStore: require(path.join(__dirname, "../inventory/itemStore")),
    sovStore: require(path.join(__dirname, "./sovStore")),
    marker: SOVEREIGNTY_RESET_MARKER,
    removesJobs,
    tables: removesJobs ? RESET_TABLES : RESET_TABLES.filter((table) => table !== "scheduledJobs"),
  };
}

function collectScope({ database, structureState, itemStore, removesJobs }) {
  const sovereignty = readTable(database, "sovereignty");
  const systems = Object.values(sovereignty.systems || {});
  const structures = structureState
    .listStructures({ includeDestroyed: true, refresh: false })
    .filter(isSovereigntyStructureRow);
  const orbitals = readTable(database, "planetOrbitalState").orbitalsByID || {};
  const skyhookOrbitalIDs = Object.entries(orbitals)
    .filter(([, record]) => toPositiveInteger(record && record.typeID) === TYPE_ORBITAL_SKYHOOK)
    .map(([key]) => key);
  const skyhookItemIDs = Object.values(itemStore.getAllItems())
    .filter((item) => toPositiveInteger(item && item.typeID) === TYPE_ORBITAL_SKYHOOK)
    .map((item) => toPositiveInteger(item.itemID))
    .filter(Boolean);
  let scheduledJobs;
  try {
    scheduledJobs = readTable(database, "scheduledJobs");
  } catch (error) {
    // World startup precedes the scheduler's first boot, so its owned table
    // may not exist yet. There are no persisted jobs to report in that case;
    // do not create foreign schema or hide corrupt/unreadable scheduler data.
    if (
      removesJobs ||
      error.code !== "SQLITE_TABLE_NOT_FOUND" ||
      error.table !== "scheduledJobs"
    ) {
      throw error;
    }
    scheduledJobs = {};
  }
  const campaignJobIDs = Object.entries(scheduledJobs)
    .filter(([, job]) => job && String(job.type || "") === CAMPAIGN_TICK_JOB_TYPE)
    .map(([jobID]) => jobID);
  const jobIDs = removesJobs ? campaignJobIDs : [];
  return {
    sovereignty,
    systemsWithData: systems.filter(isSystemWithSovereigntyData).length,
    systemRecords: systems.length,
    hubs: Object.keys(sovereignty.hubs || {}).length,
    skyhookRecords: Object.keys(sovereignty.skyhooks || {}).length,
    mercenaryDens: Object.keys(sovereignty.mercenaryDens || {}).length,
    alliances: Object.keys(sovereignty.alliances || {}).length,
    structures,
    skyhookOrbitalIDs,
    skyhookItemIDs,
    jobIDs,
    jobsLeftForScheduler: campaignJobIDs.length - jobIDs.length,
  };
}

// Nothing the reset would remove. A fresh install lands here: it gets the
// marker without a copy of a database that holds no sovereignty data.
function isScopeEmpty(scope) {
  return (
    scope.systemRecords === 0 &&
    scope.hubs === 0 &&
    scope.skyhookRecords === 0 &&
    scope.mercenaryDens === 0 &&
    scope.alliances === 0 &&
    scope.structures.length === 0 &&
    scope.skyhookOrbitalIDs.length === 0 &&
    scope.skyhookItemIDs.length === 0 &&
    scope.jobIDs.length === 0
  );
}

function describeScope(scope) {
  const structureCounts = new Map();
  for (const structure of scope.structures) {
    const typeID = toPositiveInteger(structure.typeID);
    structureCounts.set(typeID, (structureCounts.get(typeID) || 0) + 1);
  }
  const structureLabel = [...structureCounts.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([typeID, count]) => `${count} x type ${typeID}`)
    .join(", ");
  return [
    `sovereignty systems with data: ${scope.systemsWithData} (records: ${scope.systemRecords})`,
    `hub records: ${scope.hubs}`,
    `skyhook records: ${scope.skyhookRecords}, skyhook orbital rows: ${scope.skyhookOrbitalIDs.length}, skyhook items: ${scope.skyhookItemIDs.length}`,
    `mercenary den records: ${scope.mercenaryDens}`,
    `alliance settings (prime hour, capital): ${scope.alliances}`,
    `sovereignty structures: ${scope.structures.length}${structureLabel ? ` (${structureLabel})` : ""}`,
    `campaign tick jobs: ${scope.jobIDs.length}` +
      (scope.jobsLeftForScheduler > 0
        ? ` (${scope.jobsLeftForScheduler} left for the scheduler, which drops them as stale)`
        : ""),
  ];
}

function resolveBackupDirectory(database, stamp) {
  const storeRoot = path.dirname(database._sqliteDbPath);
  const backupRoot = process.env.EVEJS_SOV_RESET_BACKUP_DIR
    ? path.resolve(process.env.EVEJS_SOV_RESET_BACKUP_DIR)
    : path.resolve(storeRoot, "..", "backups");
  return path.join(backupRoot, `sov-parity-reset-${stamp}`);
}

// A second, read-only connection copies the live WAL database with VACUUM
// INTO, one read of a single consistent snapshot. Not SQLite's online backup
// API: that copies in steps and starts over whenever another connection
// writes, and a running server's persistence worker writes all the time
// (lease renewals, table flushes), so a large store never finished copying.
// The tables the reset touches are flushed first, so the copy holds exactly
// what the reset is about to remove.
function backupDatabase(database, backupDirectory, scope, tool, tables) {
  requireSuccess(database.flushTablesSync(tables), "flush sovereignty tables before the backup");
  const Database = require("better-sqlite3");
  fs.mkdirSync(backupDirectory, { recursive: true });
  const source = new Database(database._sqliteDbPath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    source.prepare("VACUUM INTO ?").run(path.join(backupDirectory, "gamestore.sqlite"));
  } finally {
    source.close();
  }
  fs.writeFileSync(
    path.join(backupDirectory, "manifest.json"),
    `${JSON.stringify({
      tool,
      createdAt: new Date().toISOString(),
      source: database._sqliteDbPath,
      scope: describeScope(scope),
    }, null, 2)}\n`,
  );
}

function performReset({ database, structureState, itemStore, sovStore, marker }, scope, now, provenance) {
  const removed = {
    structures: 0,
    skyhookItems: 0,
    skyhookOrbitals: 0,
    jobs: 0,
  };

  // Structures first: the modern sovereignty state rebuilds Hub records from
  // published Hub mirrors, so mirrors must be gone before the table is reset.
  for (const structure of scope.structures) {
    const structureID = toPositiveInteger(structure.structureID);
    if (!structureID) {
      continue;
    }
    requireSuccess(
      structureState.removeStructure(structureID, {
        discardContents: true,
        emitLive: false,
        nowMs: now,
      }),
      `remove sovereignty structure ${structureID}`,
    );
    removed.structures += 1;
  }

  for (const itemID of scope.skyhookItemIDs) {
    const result = itemStore.removeInventoryItem(itemID, { removeContents: true });
    if (result && result.success === false && result.errorMsg === "ITEM_NOT_FOUND") {
      continue;
    }
    requireSuccess(result, `remove skyhook item ${itemID}`);
    removed.skyhookItems += 1;
  }

  if (scope.skyhookOrbitalIDs.length > 0) {
    const orbitalState = readTable(database, "planetOrbitalState");
    const orbitalsByID = { ...(orbitalState.orbitalsByID || {}) };
    for (const key of scope.skyhookOrbitalIDs) {
      if (Object.prototype.hasOwnProperty.call(orbitalsByID, key)) {
        delete orbitalsByID[key];
        removed.skyhookOrbitals += 1;
      }
    }
    requireSuccess(
      database.write("planetOrbitalState", "/", { ...orbitalState, orbitalsByID }),
      "write planet orbital state",
    );
  }

  for (const jobID of scope.jobIDs) {
    const result = database.remove("scheduledJobs", `/${jobID}`);
    if (result && result.success === false && result.errorMsg !== "ENTRY_NOT_FOUND") {
      requireSuccess(result, `remove scheduled job ${jobID}`);
    }
    removed.jobs += 1;
  }

  const current = scope.sovereignty;
  const next = sovStore.buildDefaultSovereigntyTable();
  next.resources = sovStore.cloneValue(
    current.resources && typeof current.resources === "object"
      ? current.resources
      : next.resources,
  );
  next._meta.version = Math.max(
    1,
    Number(current._meta && current._meta.version) || next._meta.version,
  );
  next._meta.updatedAt = new Date(now).toISOString();
  next._meta[marker] = {
    at: new Date(now).toISOString(),
    tool: provenance.tool,
    backup: provenance.backupDirectory || null,
    removed: {
      systems: scope.systemsWithData,
      hubs: scope.hubs,
      skyhooks: scope.skyhookRecords,
      mercenaryDens: scope.mercenaryDens,
      alliances: scope.alliances,
      structures: removed.structures,
      skyhookItems: removed.skyhookItems,
      skyhookOrbitals: removed.skyhookOrbitals,
      campaignTickJobs: removed.jobs,
      campaignTickJobsLeftForScheduler: scope.jobsLeftForScheduler,
    },
  };
  requireSuccess(database.write("sovereignty", "/", next), "write sovereignty table");
  return removed;
}

function verifyReset({ database, marker, removesJobs }, scope) {
  const sovereignty = requireSuccess(
    database.readPersisted("sovereignty", "/"),
    "verify sovereignty table",
  ).data || {};
  const problems = [];
  if (!sovereignty._meta || !sovereignty._meta[marker]) {
    problems.push("the reset marker is missing");
  }
  for (const key of ["systems", "hubs", "skyhooks", "mercenaryDens", "alliances"]) {
    if (Object.keys(sovereignty[key] || {}).length > 0) {
      problems.push(`sovereignty.${key} is not empty`);
    }
  }
  const before = JSON.stringify(scope.sovereignty.resources || null);
  const after = JSON.stringify(sovereignty.resources || null);
  if (scope.sovereignty.resources && before !== after) {
    problems.push("sovereignty.resources changed");
  }
  const structures = requireSuccess(
    database.readPersisted("structures", "/"),
    "verify structures table",
  ).data || {};
  const structureRows = Array.isArray(structures)
    ? structures
    : Object.values(structures).flatMap((entry) => (Array.isArray(entry) ? entry : [entry]));
  if (structureRows.some((row) => row && typeof row === "object" && isSovereigntyStructureRow(row))) {
    problems.push("sovereignty structure rows remain");
  }
  const orbitals = (requireSuccess(
    database.readPersisted("planetOrbitalState", "/"),
    "verify planet orbital state",
  ).data || {}).orbitalsByID || {};
  if (Object.values(orbitals).some((record) => toPositiveInteger(record && record.typeID) === TYPE_ORBITAL_SKYHOOK)) {
    problems.push("skyhook orbital rows remain");
  }
  if (removesJobs) {
    const jobs = requireSuccess(
      database.readPersisted("scheduledJobs", "/"),
      "verify scheduled jobs",
    ).data || {};
    if (Object.values(jobs).some((job) => job && String(job.type || "") === CAMPAIGN_TICK_JOB_TYPE)) {
      problems.push("campaign tick jobs remain");
    }
  }
  if (problems.length > 0) {
    const error = new Error(`durable state did not match the reset: ${problems.join("; ")}`);
    error.code = "GAMESTORE_DURABLE_VERIFICATION_FAILED";
    throw error;
  }
}

// The reset writes the sovereignty table directly. sovState re-reads it on its
// own (it compares _meta.updatedAt), but the modern state keeps a derived cache
// that only sovState's writes clear. Clear it here when something loaded it.
function invalidateLoadedSovereigntyCaches() {
  const loaded = require.cache[require.resolve(path.join(__dirname, "./sovModernState"))];
  if (loaded && loaded.exports && typeof loaded.exports.invalidateSovereigntyModernStateCache === "function") {
    loaded.exports.invalidateSovereigntyModernStateCache();
  }
}

/**
 * Run the reset against a store the caller owns.
 *
 * @param {object} database the gameStore module, its owner lease held.
 * @param {object} [options]
 * @param {string} [options.tool] who ran it, recorded in the marker and backup.
 * @param {boolean} [options.dryRun] report what would be removed; change nothing.
 * @param {boolean} [options.force] run even though the marker says it already ran.
 * @param {number} [options.nowMs]
 * @param {function} [options.onBackupStart] called with the backup folder
 *   before the copy starts; the copy is the slow part.
 * @returns {Promise<object>} status "already-ran", "dry-run" or "reset", with
 *   the marker, the scope lines, the backup folder (null when the store held
 *   nothing to remove) and the removed counts. A thrown error carries
 *   backupDirectory when the backup was made before the failure.
 */
async function runSovereigntyParityReset(database, options = {}) {
  const tool = String(options.tool || "reset-sovereignty");
  const existingMarker = readResetMarker(database);
  if (existingMarker && options.force !== true) {
    return { status: "already-ran", marker: existingMarker, lines: [], backupDirectory: null, removed: null };
  }

  const context = loadResetContext(database);
  const scope = collectScope(context);
  const lines = describeScope(scope);
  if (options.dryRun === true) {
    return { status: "dry-run", marker: existingMarker, lines, backupDirectory: null, removed: null };
  }

  const now = Number.isFinite(Number(options.nowMs)) ? Math.trunc(Number(options.nowMs)) : Date.now();
  // Set only once the copy is complete, so a failure never names a backup
  // that does not exist.
  let backupDirectory = null;
  try {
    if (!isScopeEmpty(scope)) {
      const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
      const target = resolveBackupDirectory(database, stamp);
      if (typeof options.onBackupStart === "function") {
        options.onBackupStart(target);
      }
      backupDatabase(database, target, scope, tool, context.tables);
      backupDirectory = target;
    }
    const removed = performReset(context, scope, now, { tool, backupDirectory });
    requireSuccess(database.flushTablesSync(context.tables), "flush sovereignty reset tables");
    verifyReset(context, scope);
    invalidateLoadedSovereigntyCaches();
    return {
      status: "reset",
      marker: readResetMarker(database),
      lines,
      backupDirectory,
      removed,
    };
  } catch (error) {
    if (error && typeof error === "object") {
      error.backupDirectory = backupDirectory;
    }
    throw error;
  }
}

module.exports = {
  CAMPAIGN_TICK_JOB_TYPE,
  SOVEREIGNTY_STRUCTURE_TYPE_IDS,
  describeScope,
  isScopeEmpty,
  isSovereigntyStructureRow,
  isSystemWithSovereigntyData,
  readResetMarker,
  runSovereigntyParityReset,
};
