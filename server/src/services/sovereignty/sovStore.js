"use strict";

const {
  cloneValue,
} = require("../../common/clone");

const path = require("path");

const database = require(path.join(__dirname, "../../gameStore"));
const {
  SOVEREIGNTY_RESET_MARKER,
  SOVEREIGNTY_TABLE,
} = require(path.join(__dirname, "./sovConstants"));

function normalizeInteger(value, fallback = 0) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return fallback;
  }
  return Math.trunc(numericValue);
}

function normalizeStringList(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => String(entry || "").trim())
    .filter((entry) => entry.length > 0);
}

function normalizeSemanticVersion(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  return {
    major: Math.max(0, normalizeInteger(source.major, 0)),
    minor: Math.max(0, normalizeInteger(source.minor, 0)),
    patch: Math.max(0, normalizeInteger(source.patch, 0)),
    prerelease_tags: normalizeStringList(source.prerelease_tags),
    build_tags: normalizeStringList(source.build_tags),
  };
}

function buildDefaultResourcesState() {
  return {
    planetDefinitions: [],
    planetDefinitionsVersion: normalizeSemanticVersion({
      major: 0,
      minor: 0,
      patch: 0,
    }),
    starConfigurations: [],
    upgradeDefinitions: [],
  };
}

function buildDefaultSovereigntyTable() {
  return {
    _meta: {
      version: 2,
      updatedAt: null,
    },
    alliances: {},
    systems: {},
    hubs: {},
    skyhooks: {},
    mercenaryDens: {},
    resources: buildDefaultResourcesState(),
  };
}

function mergeSovereigntyTableDefaults(value = {}) {
  const defaults = buildDefaultSovereigntyTable();
  const table = value && typeof value === "object" ? cloneValue(value) : {};
  return {
    _meta: {
      version: Math.max(
        1,
        normalizeInteger(table && table._meta && table._meta.version, defaults._meta.version),
      ),
      updatedAt:
        table && table._meta && table._meta.updatedAt
          ? String(table._meta.updatedAt)
          : null,
      ...(table && table._meta && table._meta[SOVEREIGNTY_RESET_MARKER] &&
        typeof table._meta[SOVEREIGNTY_RESET_MARKER] === "object"
        ? { [SOVEREIGNTY_RESET_MARKER]: cloneValue(table._meta[SOVEREIGNTY_RESET_MARKER]) }
        : {}),
    },
    alliances:
      table && table.alliances && typeof table.alliances === "object"
        ? cloneValue(table.alliances)
        : {},
    systems:
      table && table.systems && typeof table.systems === "object"
        ? cloneValue(table.systems)
        : {},
    hubs:
      table && table.hubs && typeof table.hubs === "object"
        ? cloneValue(table.hubs)
        : {},
    skyhooks:
      table && table.skyhooks && typeof table.skyhooks === "object"
        ? cloneValue(table.skyhooks)
        : {},
    mercenaryDens:
      table && table.mercenaryDens && typeof table.mercenaryDens === "object"
        ? cloneValue(table.mercenaryDens)
        : {},
    resources: {
      planetDefinitions:
        table &&
        table.resources &&
        Array.isArray(table.resources.planetDefinitions)
          ? cloneValue(table.resources.planetDefinitions)
          : cloneValue(defaults.resources.planetDefinitions),
      planetDefinitionsVersion: normalizeSemanticVersion(
        table && table.resources && table.resources.planetDefinitionsVersion,
      ),
      starConfigurations:
        table &&
        table.resources &&
        Array.isArray(table.resources.starConfigurations)
          ? cloneValue(table.resources.starConfigurations)
          : cloneValue(defaults.resources.starConfigurations),
      upgradeDefinitions:
        table &&
        table.resources &&
        Array.isArray(table.resources.upgradeDefinitions)
          ? cloneValue(table.resources.upgradeDefinitions)
          : cloneValue(defaults.resources.upgradeDefinitions),
    },
  };
}

function readSovereigntyTable() {
  const result = database.read(SOVEREIGNTY_TABLE, "/");
  return mergeSovereigntyTableDefaults(result && result.success ? result.data : {});
}

/**
 * Reads just `_meta.updatedAt`, without materialising the table.
 *
 * readSovereigntyTable has to deep-clone: the store hands back its live in-memory
 * object, so the defaults merge copies it to stop callers mutating cached state.
 * That makes it far too expensive to use as a cache-validity probe, which is the
 * only thing the readers actually need it for -- they were paying a full miss on
 * every hit. This returns the same value the merged table would carry (a string,
 * or null when absent or unreadable) so it can be compared against a cached
 * table's own `_meta.updatedAt` directly.
 */
function readSovereigntyTableUpdatedAt() {
  const result = database.read(SOVEREIGNTY_TABLE, "/_meta");
  if (!result || result.success !== true || !result.data) {
    return null;
  }
  return result.data.updatedAt ? String(result.data.updatedAt) : null;
}

// Whether this process may persist the sovereignty table.
//
// The readers normalise and bootstrap the table on load and write the result
// back. That write is a repair, not a state change, so a passive process can
// skip it and keep the normalised table in memory. Genuine sovereignty
// mutations still call writeSovereigntyTable directly and still fail loudly.
function maySovereigntyPersist() {
  return database.mayMutateTable(SOVEREIGNTY_TABLE);
}

function writeSovereigntyTable(table) {
  const nextTable = mergeSovereigntyTableDefaults(table);
  nextTable._meta.updatedAt = new Date().toISOString();
  const result = database.write(SOVEREIGNTY_TABLE, "/", nextTable);
  if (!result || !result.success) throw new Error(result && result.errorMsg || "SOVEREIGNTY_WRITE_FAILED");
  return nextTable;
}

module.exports = {
  buildDefaultResourcesState,
  buildDefaultSovereigntyTable,
  cloneValue,
  maySovereigntyPersist,
  mergeSovereigntyTableDefaults,
  normalizeSemanticVersion,
  readSovereigntyTable,
  readSovereigntyTableUpdatedAt,
  writeSovereigntyTable,
};
