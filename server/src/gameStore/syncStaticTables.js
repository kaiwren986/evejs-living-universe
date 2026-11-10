"use strict";

/**
 * KEEPING AN EXISTING STORE'S STATIC TABLES IN STEP WITH THE INSTALLED RELEASE.
 *
 * A store is generated once and then kept: CreateDatabase.bat exits early when a
 * manifest is already there, deliberately, because rebuilding costs an 80 MB
 * download to produce almost the same thing. The consequence is that the shipped
 * static tables and the store's copies drift apart, and nothing ever reconciles
 * them. That has now broken two releases in a row:
 *
 *   a table was ADDED     dungeonClientContent arrived in 0.12.7. Absent from
 *                         every 0.12.6 store, and required, so the server would
 *                         not start: CONTENT_PACK_DUNGEON_BASE_UNAVAILABLE.
 *                         researchFieldAuthority did the same more quietly a
 *                         release earlier -- research agents had no fields.
 *
 *   a table CHANGED       0.12.7.1 removed 684 templates from dungeonAuthority
 *                         because the content packs own them now. A store
 *                         carried over from 0.12.7 still had them, so four of
 *                         the five packs refused to install:
 *                         CONTENT_PACK_TEMPLATE_CONFLICT ... collides with
 *                         client-dungeon:10760. A clean install was fine, which
 *                         is what made it look like a packaging problem.
 *
 * So both halves are handled here: a missing table is written, and a table whose
 * content differs from the shipped copy is refreshed.
 *
 * WHAT MAY BE OVERWRITTEN
 *
 * Only a table the engine owns. server/src/gameStore/tableOwnership.js is the
 * curated source of truth, and its own rule is that a table is runtime iff it is
 * SQLite-backed, "everything else is static SDE/reference data, loaded read-only
 * into memory". Read-only reference data is safe to replace; a runtime table is
 * not, and newEdenStore is exactly that -- it is what the New Eden Store editor
 * saves to, and overwriting it would destroy an operator's work.
 *
 * isRuntimeTable() answers false for a table it has never heard of, which is a
 * default rather than a finding, so an unclassified table is left alone and
 * reported instead of being trusted.
 *
 * A table that is simply MISSING is always written, whoever owns it: there is no
 * operator work to lose in a file that does not exist.
 */

const fs = require("node:fs");
const path = require("node:path");

const { resolveDataDir } = require("./storeRoot");
const { isClassified, isRuntimeTable } = require("./tableOwnership");

const STATIC_TABLE_ROOT = path.resolve(
  __dirname,
  "../../../tools/DatabaseCreator/staticTables",
);

const SAFE_TABLE_NAME = /^[A-Za-z0-9_]+$/;

const OWNERSHIP = Object.freeze({
  ENGINE: "engine",
  OPERATOR: "operator",
  UNKNOWN: "unknown",
});

function classifyTableOwnership(tableName) {
  if (!isClassified(tableName)) return OWNERSHIP.UNKNOWN;
  return isRuntimeTable(tableName) ? OWNERSHIP.OPERATOR : OWNERSHIP.ENGINE;
}

function listShippedStaticTables(staticTableRoot) {
  if (!fs.existsSync(staticTableRoot)) {
    return [];
  }
  return fs.readdirSync(staticTableRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && SAFE_TABLE_NAME.test(entry.name))
    .map((entry) => entry.name)
    .filter((name) => fs.existsSync(path.join(staticTableRoot, name, "data.json")))
    .sort();
}

const COMPARE_CHUNK_BYTES = 1024 * 1024;

// Size first, because it settles most comparisons without reading 67 MB twice.
// Same-size files are compared byte for byte, a chunk at a time, stopping at
// the first difference. That is the same answer a hash comparison gives, at a
// fraction of the cost (hashing both copies of the tables took about 0.7 s of
// every boot).
function filesDiffer(left, right) {
  const size = fs.statSync(left).size;
  if (size !== fs.statSync(right).size) {
    return true;
  }
  const leftFd = fs.openSync(left, "r");
  try {
    const rightFd = fs.openSync(right, "r");
    try {
      const leftChunk = Buffer.allocUnsafe(COMPARE_CHUNK_BYTES);
      const rightChunk = Buffer.allocUnsafe(COMPARE_CHUNK_BYTES);
      for (let offset = 0; offset < size; offset += COMPARE_CHUNK_BYTES) {
        const length = Math.min(COMPARE_CHUNK_BYTES, size - offset);
        if (
          !readExactly(leftFd, leftChunk, length, offset) ||
          !readExactly(rightFd, rightChunk, length, offset) ||
          leftChunk.compare(rightChunk, 0, length, 0, length) !== 0
        ) {
          return true;
        }
      }
      return false;
    } finally {
      fs.closeSync(rightFd);
    }
  } finally {
    fs.closeSync(leftFd);
  }
}

// False when the file ends early: it shrank after the size check, so the two
// files differ.
function readExactly(fd, buffer, length, position) {
  let read = 0;
  while (read < length) {
    const bytes = fs.readSync(fd, buffer, read, length - read, position + read);
    if (bytes === 0) {
      return false;
    }
    read += bytes;
  }
  return true;
}

function writeTableAtomically(source, destination) {
  // Temporary name then rename, so a reader can never see a half-written table
  // if the process dies mid-copy.
  const temporary = `${destination}.syncing`;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, temporary);
  fs.renameSync(temporary, destination);
}

/**
 * Brings the store's shipped static tables in line with the installed release.
 *
 * @param {object} [options]
 * @param {string} [options.dataDir] store data directory; defaults to the resolved store
 * @param {string} [options.staticTableRoot] where the shipped tables live
 */
function syncStaticTables(options = {}) {
  const dataDir = options.dataDir ? path.resolve(options.dataDir) : resolveDataDir();
  const staticTableRoot = options.staticTableRoot
    ? path.resolve(options.staticTableRoot)
    : STATIC_TABLE_ROOT;

  const result = {
    dataDir,
    staticTableRoot,
    seeded: [],
    refreshed: [],
    keptOperatorOwned: [],
    unclassifiedDrift: [],
    unchanged: 0,
    ran: false,
  };

  // No store yet: this is a fresh install and the creator is about to build one
  // properly. Writing here would leave a half-built data directory behind.
  if (!fs.existsSync(dataDir)) {
    return result;
  }
  result.ran = true;

  for (const tableName of listShippedStaticTables(staticTableRoot)) {
    const source = path.join(staticTableRoot, tableName, "data.json");
    const destination = path.join(dataDir, tableName, "data.json");

    if (!fs.existsSync(destination)) {
      writeTableAtomically(source, destination);
      result.seeded.push(tableName);
      continue;
    }
    if (!filesDiffer(source, destination)) {
      result.unchanged += 1;
      continue;
    }

    switch (classifyTableOwnership(tableName)) {
      case OWNERSHIP.ENGINE:
        writeTableAtomically(source, destination);
        result.refreshed.push(tableName);
        break;
      case OWNERSHIP.OPERATOR:
        result.keptOperatorOwned.push(tableName);
        break;
      default:
        result.unclassifiedDrift.push(tableName);
        break;
    }
  }

  return result;
}

function describeSyncResult(result) {
  if (!result.ran) return "";
  const parts = [];
  if (result.seeded.length > 0) {
    parts.push(`added ${result.seeded.length} table(s) this release introduced: ${result.seeded.join(", ")}`);
  }
  if (result.refreshed.length > 0) {
    parts.push(`refreshed ${result.refreshed.length} table(s) this release changed: ${result.refreshed.join(", ")}`);
  }
  if (result.unclassifiedDrift.length > 0) {
    parts.push(
      `${result.unclassifiedDrift.join(", ")} differ(s) from the shipped copy but ` +
      "is not classified in tableOwnership.js, so it was left alone",
    );
  }
  return parts.join("; ");
}

module.exports = {
  OWNERSHIP,
  STATIC_TABLE_ROOT,
  classifyTableOwnership,
  describeSyncResult,
  filesDiffer,
  listShippedStaticTables,
  syncStaticTables,
};
