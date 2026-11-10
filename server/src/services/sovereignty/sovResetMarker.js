"use strict";

// The retail-parity sovereignty reset (sovParityReset.js) runs once per game
// store and leaves a marker in the sovereignty table's _meta. The server runs
// it at startup when the marker is missing, before any service or scene
// exists; tools/Maintenance/reset-sovereignty.js runs the same reset offline
// for the Updater. The server never repairs old sovereignty data: it removes
// it once, with a backup, and from then on only reports the marker.

const path = require("path");

const {
  SOVEREIGNTY_RESET_MARKER,
} = require(path.join(__dirname, "./sovConstants"));
const {
  readResetMarker,
  runSovereigntyParityReset,
} = require(path.join(__dirname, "./sovParityReset"));

const SOVEREIGNTY_RESET_COMMAND = "node tools/Maintenance/reset-sovereignty.js";
const SOVEREIGNTY_RESET_COMMAND_DOCKER =
  "docker compose run --rm --no-deps maintenance reset-sovereignty";
const SOVEREIGNTY_RESET_CONFIG_KEY = "sovereigntyOneTimeParityReset";
const STARTUP_RESET_TOOL = "server-startup";

function toPositiveInteger(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : 0;
}

function systemHoldsSovereigntyData(system) {
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

function describeSovereigntyResetState(database) {
  const result = database.read("sovereignty", "/");
  const table =
    result && result.success && result.data && typeof result.data === "object"
      ? result.data
      : {};
  const marker =
    table._meta && table._meta[SOVEREIGNTY_RESET_MARKER] &&
    typeof table._meta[SOVEREIGNTY_RESET_MARKER] === "object"
      ? table._meta[SOVEREIGNTY_RESET_MARKER]
      : null;
  const counts = {
    systems: Object.values(table.systems || {}).filter(systemHoldsSovereigntyData).length,
    hubs: Object.keys(table.hubs || {}).length,
    skyhooks: Object.keys(table.skyhooks || {}).length,
    mercenaryDens: Object.keys(table.mercenaryDens || {}).length,
    alliances: Object.keys(table.alliances || {}).length,
  };
  const hasData = Object.values(counts).some((count) => count > 0);
  return {
    markerPresent: Boolean(marker),
    marker,
    counts,
    hasData,
  };
}

function describeCounts(counts) {
  return [
    `${counts.systems} claimed system(s)`,
    `${counts.hubs} Hub record(s)`,
    `${counts.skyhooks} Skyhook record(s)`,
    `${counts.mercenaryDens} Mercenary Den record(s)`,
    `${counts.alliances} alliance setting(s)`,
  ].join(", ");
}

const REMOVED_LABELS = [
  ["systems", "claimed system(s)"],
  ["hubs", "Hub record(s)"],
  ["skyhooks", "Skyhook record(s)"],
  ["mercenaryDens", "Mercenary Den record(s)"],
  ["alliances", "alliance setting(s)"],
  ["structures", "sovereignty structure(s)"],
  ["skyhookItems", "Skyhook item(s)"],
  ["skyhookOrbitals", "Skyhook orbital row(s)"],
  ["campaignTickJobs", "campaign job(s)"],
];

// Only what was there: "3 claimed system(s), 1 alliance setting(s)".
function describeRemoved(removed) {
  const parts = REMOVED_LABELS
    .filter(([key]) => Number(removed && removed[key]) > 0)
    .map(([key, label]) => `${Number(removed[key])} ${label}`);
  return parts.length > 0 ? parts.join(", ") : "empty sovereignty records";
}

function logResetRecorded(log, marker) {
  log.info(
    `[Sovereignty] Retail-parity sovereignty reset recorded at ${marker.at || "an unknown time"}.`,
  );
}

// Runs the one-time reset when the marker is missing. A failure is logged and
// rethrown so startup stops: a world must not run on half-reset sovereignty.
// A later start finds the marker still missing and runs the reset again.
async function applySovereigntyResetAtStartup(log, database) {
  const marker = readResetMarker(database);
  if (marker) {
    logResetRecorded(log, marker);
    return { status: "already-ran", marker };
  }
  let result;
  try {
    result = await runSovereigntyParityReset(database, {
      tool: STARTUP_RESET_TOOL,
      onBackupStart: (backupDirectory) => log.info(
        "[Sovereignty] Running the one-time retail-parity sovereignty reset. " +
          `Backing up the game database to ${backupDirectory} first ...`,
      ),
    });
  } catch (error) {
    log.err(
      `[Sovereignty] The one-time retail-parity sovereignty reset failed, so the server will not start: ` +
        `${error && error.message ? error.message : error}.` +
        (error && error.backupDirectory
          ? ` The game database was backed up to ${error.backupDirectory} before the reset began.`
          : ""),
    );
    throw error;
  }
  if (!result.backupDirectory) {
    log.info(
      "[Sovereignty] Recorded the one-time retail-parity sovereignty reset; " +
        "there was no older sovereignty data to remove.",
    );
    return result;
  }
  log.info(
    "[Sovereignty] Retail-parity sovereignty reset complete: removed " +
      `${describeRemoved(result.marker && result.marker.removed)}. Backup: ${result.backupDirectory}`,
  );
  return result;
}

// Used only when the startup reset is switched off. A warning means an
// operator has to act: old sovereignty data is present and the reset has not
// run.
function logSovereigntyResetState(log, database) {
  let state = null;
  try {
    state = describeSovereigntyResetState(database);
  } catch (error) {
    log.warn(
      `[Sovereignty] Could not check the retail-parity reset marker: ${error.message}`,
    );
    return null;
  }
  if (state.markerPresent) {
    logResetRecorded(log, state.marker);
    return state;
  }
  if (!state.hasData) {
    log.info(
      `[Sovereignty] No sovereignty data and no retail-parity reset marker; ${SOVEREIGNTY_RESET_CONFIG_KEY} ` +
        "is off, so the server did not record the reset.",
    );
    return state;
  }
  log.warn(
    "[Sovereignty] Sovereignty data predates the retail-parity reset " +
      `(${describeCounts(state.counts)}). ${SOVEREIGNTY_RESET_CONFIG_KEY} is off, so the server left it in place. ` +
      `Turn it on in config/gameplay.json to reset at the next start, or stop the server and run ` +
      `${SOVEREIGNTY_RESET_COMMAND} (Docker: ${SOVEREIGNTY_RESET_COMMAND_DOCKER}).`,
  );
  return state;
}

module.exports = {
  SOVEREIGNTY_RESET_COMMAND,
  SOVEREIGNTY_RESET_COMMAND_DOCKER,
  STARTUP_RESET_TOOL,
  applySovereigntyResetAtStartup,
  describeSovereigntyResetState,
  logSovereigntyResetState,
};
