"use strict";

/**
 * The installed moon composition pack, served at runtime.
 *
 * `tools/moon-data/generate-moon-composition-pack.js` writes one JSON pack per
 * install into the store root (`moon-compositions.json`, about 100 MB for the
 * whole universe). Survey probes, moon binding and extraction yield all read a
 * moon's ores from it, so what a probe reports is what a chunk later holds.
 *
 * Parsing the pack costs about 300 ms and 250 MB of transient heap, so it is
 * read once into a compact typed-array index, and that index is cached beside
 * the pack (`moon-compositions.index.bin`). Later loads read the cache in a few
 * milliseconds and rebuild it only when the pack file changes.
 *
 * A missing or malformed pack fails closed: every lookup returns null, and the
 * callers treat the moon as having no known composition.
 */

const fs = require("fs");
const path = require("path");

const log = require(path.join(__dirname, "../../utils/logger"));
const { resolveStoreRoot } = require(path.join(__dirname, "../../gameStore/storeRoot"));

const PACK_FILE_NAME = "moon-compositions.json";
const INDEX_FILE_NAME = "moon-compositions.index.bin";
const INDEX_FORMAT = "evejs-moon-composition-index";
const INDEX_FORMAT_VERSION = 1;
const PACK_SCHEMA_VERSION = 1;
const CURRENT_GENERATOR_VERSION = 4;
const AUTHORITY_CLASSES = new Set(["evidence_snapshot", "project_generated", "tranquility_exact"]);
// Same display-rounding allowance as moonResourceAuthority.
const MAX_FRACTION_TOTAL = 1.00011;

const STATE = Object.freeze({
  UNLOADED: "unloaded",
  READY: "ready",
  MISSING: "missing",
  INVALID: "invalid",
});

let loaded = null;
let datasetOverride = null;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toPositiveInt(value) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : 0;
}

function resolvePackPath() {
  const configured = String(process.env.EVEJS_MOON_COMPOSITION_PACK || "").trim();
  return configured
    ? path.resolve(configured)
    : path.join(resolveStoreRoot(), PACK_FILE_NAME);
}

function resolveIndexPath(packPath) {
  return path.join(path.dirname(packPath), INDEX_FILE_NAME);
}

function failed(state, reason, details = {}) {
  return {
    state,
    reason,
    datasetVersion: null,
    profileCount: 0,
    ...details,
    lookup: null,
  };
}

// The pack header without its profiles: what the index cache records and what
// callers see as the pack's identity.
function buildPackIdentity(dataset) {
  const generation = isPlainObject(dataset.generation) ? dataset.generation : {};
  const points = isPlainObject(dataset.miningPointAuthority) ? dataset.miningPointAuthority : {};
  return {
    datasetVersion: String(dataset.datasetVersion || ""),
    contentHash: String(dataset.contentHash || ""),
    sourceBuild: toPositiveInt(dataset.sourceBuild),
    authorityClass: String(dataset.authorityClass || ""),
    tranquilityExact: dataset.tranquilityExact === true,
    generatorVersion: toPositiveInt(generation.generatorVersion),
    rulesetID: String(generation.rulesetID || ""),
    miningPointContentHash: String(points.contentHash || ""),
    miningPointSourceBuild: toPositiveInt(points.sourceBuild),
  };
}

function validatePackHeader(dataset) {
  if (!isPlainObject(dataset)) {
    return "PACK_NOT_AN_OBJECT";
  }
  if (dataset.schemaVersion !== PACK_SCHEMA_VERSION) {
    return "UNSUPPORTED_SCHEMA_VERSION";
  }
  if (!AUTHORITY_CLASSES.has(dataset.authorityClass)) {
    return "INVALID_AUTHORITY_CLASS";
  }
  if (dataset.fallbackPolicy !== "fail_closed") {
    return "UNSAFE_FALLBACK_POLICY";
  }
  if (typeof dataset.datasetVersion !== "string" || !dataset.datasetVersion.trim()) {
    return "INVALID_DATASET_VERSION";
  }
  if (!Array.isArray(dataset.profiles)) {
    return "INVALID_PROFILES";
  }
  return null;
}

// Build the typed-array index. Rows that break the authority rules are
// rejected as a whole pack, the same fail-closed stance moonResourceAuthority
// takes, rather than silently dropping a moon.
function buildIndexFromDataset(dataset) {
  const headerError = validatePackHeader(dataset);
  if (headerError) {
    return { error: headerError };
  }
  const profiles = [...dataset.profiles].sort(
    (left, right) => toPositiveInt(left && left.moonID) - toPositiveInt(right && right.moonID),
  );
  let entryCount = 0;
  for (const profile of profiles) {
    entryCount += Array.isArray(profile && profile.composition) ? profile.composition.length : 0;
  }
  const moonIDs = new Int32Array(profiles.length);
  const solarSystemIDs = new Int32Array(profiles.length);
  const offsets = new Uint32Array(profiles.length + 1);
  const typeIDs = new Int32Array(entryCount);
  const fractions = new Float64Array(entryCount);
  let cursor = 0;
  let previousMoonID = 0;
  for (let index = 0; index < profiles.length; index += 1) {
    const profile = profiles[index];
    const moonID = toPositiveInt(profile && profile.moonID);
    const solarSystemID = toPositiveInt(profile && profile.solarSystemID);
    if (!moonID || !solarSystemID || moonID === previousMoonID) {
      return { error: "INVALID_OR_DUPLICATE_MOON", moonID };
    }
    if (profile.datasetVersion !== dataset.datasetVersion || profile.sourceStatus !== "valid") {
      return { error: "UNUSABLE_PROFILE", moonID };
    }
    const composition = Array.isArray(profile.composition) ? profile.composition : [];
    if (composition.length === 0) {
      return { error: "EMPTY_COMPOSITION", moonID };
    }
    previousMoonID = moonID;
    moonIDs[index] = moonID;
    solarSystemIDs[index] = solarSystemID;
    offsets[index] = cursor;
    const rows = [...composition].sort(
      (left, right) => toPositiveInt(left && left.typeID) - toPositiveInt(right && right.typeID),
    );
    let total = 0;
    let previousTypeID = 0;
    for (const row of rows) {
      const typeID = toPositiveInt(row && row.typeID);
      const fraction = Number(row && row.fraction);
      if (!typeID || typeID === previousTypeID || !(fraction > 0 && fraction <= 1)) {
        return { error: "INVALID_COMPOSITION_ROW", moonID };
      }
      previousTypeID = typeID;
      total += fraction;
      typeIDs[cursor] = typeID;
      fractions[cursor] = fraction;
      cursor += 1;
    }
    if (total > MAX_FRACTION_TOTAL) {
      return { error: "COMPOSITION_OVER_ONE", moonID };
    }
  }
  offsets[profiles.length] = cursor;
  return {
    identity: buildPackIdentity(dataset),
    arrays: { moonIDs, solarSystemIDs, offsets, typeIDs, fractions },
  };
}

function writeIndexCache(indexPath, packStat, built) {
  const header = Buffer.from(JSON.stringify({
    format: INDEX_FORMAT,
    formatVersion: INDEX_FORMAT_VERSION,
    packBytes: packStat.size,
    packMtimeMs: Math.trunc(packStat.mtimeMs),
    profileCount: built.arrays.moonIDs.length,
    entryCount: built.arrays.typeIDs.length,
    identity: built.identity,
  }), "utf8");
  const lengthPrefix = Buffer.alloc(4);
  lengthPrefix.writeUInt32LE(header.length, 0);
  // Pad the header so every typed array below starts 8-byte aligned.
  const padding = Buffer.alloc((8 - ((4 + header.length) % 8)) % 8);
  const { moonIDs, solarSystemIDs, offsets, typeIDs, fractions } = built.arrays;
  const parts = [
    lengthPrefix,
    header,
    padding,
    Buffer.from(fractions.buffer, fractions.byteOffset, fractions.byteLength),
    Buffer.from(moonIDs.buffer, moonIDs.byteOffset, moonIDs.byteLength),
    Buffer.from(solarSystemIDs.buffer, solarSystemIDs.byteOffset, solarSystemIDs.byteLength),
    Buffer.from(offsets.buffer, offsets.byteOffset, offsets.byteLength),
    Buffer.from(typeIDs.buffer, typeIDs.byteOffset, typeIDs.byteLength),
  ];
  const temporaryPath = `${indexPath}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(temporaryPath, Buffer.concat(parts));
    fs.renameSync(temporaryPath, indexPath);
  } catch (error) {
    // The cache only saves the next load a parse; losing it costs time, not data.
    log.debug(`[MoonComposition] could not write the index cache ${indexPath}: ${error.message}`);
    try {
      fs.rmSync(temporaryPath, { force: true });
    } catch (cleanupError) {
      log.debug(`[MoonComposition] could not remove ${temporaryPath}: ${cleanupError.message}`);
    }
  }
}

function copyTypedArray(buffer, byteOffset, length, TypedArray) {
  const bytes = length * TypedArray.BYTES_PER_ELEMENT;
  const copy = new TypedArray(length);
  new Uint8Array(copy.buffer).set(buffer.subarray(byteOffset, byteOffset + bytes));
  return { array: copy, nextOffset: byteOffset + bytes };
}

function readIndexCache(indexPath, packStat) {
  let buffer;
  try {
    buffer = fs.readFileSync(indexPath);
  } catch (_error) {
    // ignored: a missing cache is the normal first load; the pack is parsed instead.
    return null;
  }
  try {
    const headerLength = buffer.readUInt32LE(0);
    const header = JSON.parse(buffer.subarray(4, 4 + headerLength).toString("utf8"));
    if (
      header.format !== INDEX_FORMAT ||
      header.formatVersion !== INDEX_FORMAT_VERSION ||
      header.packBytes !== packStat.size ||
      header.packMtimeMs !== Math.trunc(packStat.mtimeMs)
    ) {
      return null;
    }
    let offset = 4 + headerLength;
    offset += (8 - (offset % 8)) % 8;
    const profileCount = toPositiveInt(header.profileCount);
    const entryCount = toPositiveInt(header.entryCount);
    const fractions = copyTypedArray(buffer, offset, entryCount, Float64Array);
    const moonIDs = copyTypedArray(buffer, fractions.nextOffset, profileCount, Int32Array);
    const solarSystemIDs = copyTypedArray(buffer, moonIDs.nextOffset, profileCount, Int32Array);
    const offsets = copyTypedArray(buffer, solarSystemIDs.nextOffset, profileCount + 1, Uint32Array);
    const typeIDs = copyTypedArray(buffer, offsets.nextOffset, entryCount, Int32Array);
    if (typeIDs.nextOffset !== buffer.length || offsets.array[profileCount] !== entryCount) {
      return null;
    }
    return {
      identity: header.identity,
      arrays: {
        moonIDs: moonIDs.array,
        solarSystemIDs: solarSystemIDs.array,
        offsets: offsets.array,
        typeIDs: typeIDs.array,
        fractions: fractions.array,
      },
    };
  } catch (error) {
    log.debug(`[MoonComposition] ignoring an unreadable index cache ${indexPath}: ${error.message}`);
    return null;
  }
}

function createLookup(arrays) {
  const { moonIDs, solarSystemIDs, offsets, typeIDs, fractions } = arrays;
  return function lookup(moonID) {
    let low = 0;
    let high = moonIDs.length - 1;
    while (low <= high) {
      const middle = (low + high) >>> 1;
      const candidate = moonIDs[middle];
      if (candidate === moonID) {
        const composition = [];
        for (let entry = offsets[middle]; entry < offsets[middle + 1]; entry += 1) {
          composition.push(Object.freeze({ typeID: typeIDs[entry], fraction: fractions[entry] }));
        }
        return { solarSystemID: solarSystemIDs[middle], composition: Object.freeze(composition) };
      }
      if (candidate < moonID) {
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    return null;
  };
}

// Pack against the current universe: a pack generated for other mining points
// still names real moons, so it stays usable, but the operator should
// regenerate it. A pack from before generator 4 predates mixed compositions.
function describePackAge(identity, currentPointMetadata) {
  const notes = [];
  if (identity.generatorVersion > 0 && identity.generatorVersion < CURRENT_GENERATOR_VERSION) {
    notes.push(`generator ${identity.generatorVersion} (current ${CURRENT_GENERATOR_VERSION})`);
  }
  const currentHash = currentPointMetadata && currentPointMetadata.contentHash;
  if (currentHash && identity.miningPointContentHash && identity.miningPointContentHash !== currentHash) {
    notes.push("generated for different moon mining points");
  }
  return notes;
}

function readCurrentMiningPointMetadata() {
  try {
    const worldData = require(path.join(__dirname, "../../space/worldData"));
    return typeof worldData.getMoonMiningPointMetadata === "function"
      ? worldData.getMoonMiningPointMetadata()
      : null;
  } catch (error) {
    log.debug(`[MoonComposition] moon mining point metadata unavailable: ${error.message}`);
    return null;
  }
}

function finishLoad(built, source, packPath) {
  const notes = describePackAge(built.identity, readCurrentMiningPointMetadata());
  if (notes.length > 0) {
    log.warn(
      `[MoonComposition] ${packPath} is out of date (${notes.join("; ")}). ` +
        "Regenerate it with tools/moon-data/generate-moon-composition-pack.js --force " +
        "(default seed EveJS, or the install's own EVEJS_MOON_WORLD_SEED); " +
        "moons keep their current ores until then.",
    );
  }
  return {
    state: STATE.READY,
    reason: null,
    source,
    packPath,
    ...built.identity,
    profileCount: built.arrays.moonIDs.length,
    outOfDate: notes,
    lookup: createLookup(built.arrays),
  };
}

function loadFromDisk() {
  const packPath = resolvePackPath();
  let packStat;
  try {
    packStat = fs.statSync(packPath);
  } catch (_error) {
    // ignored: no pack installed is a supported state; lookups fail closed.
    return failed(STATE.MISSING, "PACK_NOT_INSTALLED", { packPath });
  }
  const indexPath = resolveIndexPath(packPath);
  const cached = readIndexCache(indexPath, packStat);
  if (cached) {
    return finishLoad(cached, "index-cache", packPath);
  }
  const startedAtMs = Date.now();
  let dataset;
  try {
    dataset = JSON.parse(fs.readFileSync(packPath, "utf8"));
  } catch (error) {
    log.warn(`[MoonComposition] cannot read ${packPath}: ${error.message}`);
    return failed(STATE.INVALID, "PACK_UNREADABLE", { packPath });
  }
  const built = buildIndexFromDataset(dataset);
  dataset = null;
  if (built.error) {
    log.warn(
      `[MoonComposition] rejected ${packPath}: ${built.error}` +
        `${built.moonID ? ` (moon ${built.moonID})` : ""}; moon compositions stay unavailable`,
    );
    return failed(STATE.INVALID, built.error, { packPath });
  }
  writeIndexCache(indexPath, packStat, built);
  log.info(
    `[MoonComposition] loaded ${built.arrays.moonIDs.length} moon profiles from ${packPath} ` +
      `in ${Date.now() - startedAtMs} ms (${built.identity.datasetVersion})`,
  );
  return finishLoad(built, "pack", packPath);
}

function ensureLoaded() {
  if (loaded) {
    return loaded;
  }
  if (datasetOverride) {
    const built = buildIndexFromDataset(datasetOverride);
    loaded = built.error
      ? failed(STATE.INVALID, built.error, { packPath: "<test dataset>" })
      : finishLoad(built, "test-dataset", "<test dataset>");
    return loaded;
  }
  loaded = loadFromDisk();
  return loaded;
}

/**
 * The installed ores of one moon, or null when the pack is missing, invalid or
 * has no profile for the moon.
 *
 * @returns {{moonID:number, solarSystemID:number, datasetVersion:string,
 *   composition:ReadonlyArray<{typeID:number, fraction:number}>}|null}
 */
function getMoonComposition(moonID) {
  const numericMoonID = toPositiveInt(moonID);
  if (!numericMoonID) {
    return null;
  }
  const current = ensureLoaded();
  if (current.state !== STATE.READY) {
    return null;
  }
  const found = current.lookup(numericMoonID);
  if (!found) {
    return null;
  }
  return Object.freeze({
    moonID: numericMoonID,
    solarSystemID: found.solarSystemID,
    datasetVersion: current.datasetVersion,
    composition: found.composition,
  });
}

/** Load state and pack identity, for diagnostics and GM commands. */
function getMoonCompositionStatus() {
  const current = ensureLoaded();
  const { lookup, ...status } = current;
  return Object.freeze({ ...status, available: Boolean(lookup) });
}

/**
 * Serve an in-memory pack instead of the installed file. Tests use it with a
 * small generated dataset; pass null to go back to the installed pack.
 */
function setMoonCompositionDatasetForTests(dataset) {
  datasetOverride = dataset || null;
  loaded = null;
}

function resetMoonCompositionRuntime() {
  loaded = null;
}

module.exports = {
  INDEX_FILE_NAME,
  PACK_FILE_NAME,
  STATE,
  getMoonComposition,
  getMoonCompositionStatus,
  resetMoonCompositionRuntime,
  resolvePackPath,
  setMoonCompositionDatasetForTests,
  _testing: {
    buildIndexFromDataset,
    readIndexCache,
    writeIndexCache,
  },
};
