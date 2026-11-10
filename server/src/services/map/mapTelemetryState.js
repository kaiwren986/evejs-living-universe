"use strict";

const path = require("path");

// Phase 0 / 0.C: map telemetry state via an ownership-scoped repository.
const {
  createTableRepository,
} = require(path.join(__dirname, "../../gameStore/tableRepository"));
const repo = createTableRepository("service:map", { strict: true });
const log = require(path.join(__dirname, "../../utils/logger"));
const {
  buildFiletimeLong,
  currentFileTime,
} = require(path.join(__dirname, "../_shared/serviceHelpers"));

const TABLE = "mapTelemetry";
const FILETIME_EPOCH_OFFSET = 116444736000000000n;
const FILETIME_TICKS_PER_MS = 10000n;
const DEFAULT_JUMP_RETENTION_HOURS = 168;
const MAX_JUMP_EVENTS = 10000;

function toPositiveInteger(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  const normalized = Math.trunc(numeric);
  return normalized > 0 ? normalized : fallback;
}

function toInteger(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.trunc(numeric);
}

let bootstrapComplete = false;

function normalizeFiletimeString(value, fallback = null) {
  try {
    if (typeof value === "bigint") {
      return value > 0n ? value.toString() : fallback;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      const normalized = BigInt(Math.trunc(value));
      return normalized > 0n ? normalized.toString() : fallback;
    }
    if (typeof value === "string" && value.trim() !== "") {
      const normalized = BigInt(value.trim());
      return normalized > 0n ? normalized.toString() : fallback;
    }
    if (value && typeof value === "object" && value.type === "long") {
      return normalizeFiletimeString(value.value, fallback);
    }
  } catch (error) {
    return fallback;
  }
  return fallback;
}

function filetimeFromMs(ms = Date.now()) {
  const normalizedMs = Math.max(0, Math.trunc(Number(ms) || 0));
  return (BigInt(normalizedMs) * FILETIME_TICKS_PER_MS + FILETIME_EPOCH_OFFSET).toString();
}

function msFromFiletime(value, fallback = 0) {
  const normalized = normalizeFiletimeString(value, null);
  if (!normalized) {
    return fallback;
  }
  try {
    const filetime = BigInt(normalized);
    if (filetime <= FILETIME_EPOCH_OFFSET) {
      return fallback;
    }
    return Number((filetime - FILETIME_EPOCH_OFFSET) / FILETIME_TICKS_PER_MS);
  } catch (error) {
    return fallback;
  }
}

function currentFiletimeString() {
  return currentFileTime().toString();
}

function reportWrite(result) {
  if (!result.success) {
    log.warn(`[MapTelemetry] Failed to write ${TABLE}: ${result.errorMsg || "WRITE_ERROR"}`);
  }
  return result.success;
}

// The top-level shape used to be re-established on every read, which meant deep
// cloning the whole table per call. Establish it once instead, on the first
// write of the process. Reads stay tolerant of a missing key so they never need
// this (and so a reader-role process is never asked to write).
function ensureBootstrapped() {
  if (bootstrapComplete) {
    return;
  }

  const meta = repo.read(TABLE, "/_meta");
  if (!meta.success || !meta.data || typeof meta.data !== "object") {
    reportWrite(repo.write(TABLE, "/_meta", { schemaVersion: 1 }));
  }

  const visits = repo.read(TABLE, "/visitsByCharacterID");
  if (!visits.success || !visits.data || typeof visits.data !== "object") {
    reportWrite(repo.write(TABLE, "/visitsByCharacterID", {}));
  }

  // Must exist as an array before any indexed write: the write path creates
  // missing intermediates as {}, and an object here would break pruning.
  const jumps = repo.read(TABLE, "/jumpEvents");
  if (!jumps.success || !Array.isArray(jumps.data)) {
    reportWrite(repo.write(TABLE, "/jumpEvents", []));
  }

  bootstrapComplete = true;
}

// Both readers return the live stored node, not a copy. Treat them as read-only:
// mutating one in place and writing it back to its own path is a silent no-op,
// because the path-scoped write short-circuits on reference equality.
function readCharacterVisitNode(characterKey) {
  const result = repo.read(TABLE, `/visitsByCharacterID/${characterKey}`);
  if (!result.success || !result.data || typeof result.data !== "object") {
    return null;
  }
  return result.data;
}

function readVisitSystems(characterNode) {
  if (!characterNode || !characterNode.systems || typeof characterNode.systems !== "object") {
    return null;
  }
  return characterNode.systems;
}

function readJumpEvents() {
  const result = repo.read(TABLE, "/jumpEvents");
  return result.success && Array.isArray(result.data) ? result.data : [];
}

function getCharacterID(sessionOrCharacterID) {
  if (sessionOrCharacterID && typeof sessionOrCharacterID === "object") {
    return toPositiveInteger(
      sessionOrCharacterID.characterID ||
        sessionOrCharacterID.charid ||
        sessionOrCharacterID.userid ||
        0,
      0,
    );
  }
  return toPositiveInteger(sessionOrCharacterID, 0);
}

function normalizeVisitEntry(entry, solarSystemID, nowMs, nowFiletime) {
  const visits = toPositiveInteger(entry && entry.visits, 0);
  const lastDateTime = normalizeFiletimeString(
    entry && entry.lastDateTime,
    nowFiletime,
  );
  return {
    solarSystemID,
    visits,
    lastDateTime,
    lastDateTimeMs: toPositiveInteger(
      entry && entry.lastDateTimeMs,
      msFromFiletime(lastDateTime, nowMs),
    ),
  };
}

function recordSolarSystemVisit(sessionOrCharacterID, solarSystemID, options = {}) {
  const characterID = getCharacterID(sessionOrCharacterID);
  const systemID = toPositiveInteger(solarSystemID, 0);
  if (characterID <= 0 || systemID <= 0) {
    return false;
  }

  ensureBootstrapped();

  const nowMs = toPositiveInteger(options.nowMs, Date.now());
  const nowFiletime = normalizeFiletimeString(options.filetime, filetimeFromMs(nowMs));
  const characterKey = String(characterID);
  const systemKey = String(systemID);
  const characterNode = readCharacterVisitNode(characterKey);
  const systems = readVisitSystems(characterNode);

  const existing = normalizeVisitEntry(
    systems ? systems[systemKey] : null,
    systemID,
    nowMs,
    nowFiletime,
  );
  const previousSystemID = toPositiveInteger(characterNode && characterNode.lastSolarSystemID, 0);
  const shouldIncrement = previousSystemID !== systemID || existing.visits <= 0;

  // A fresh object, never the stored one: an identical reference would make the
  // write report success without marking the row dirty, and the visit would be
  // lost at restart.
  const entry = {
    ...existing,
    visits: shouldIncrement ? existing.visits + 1 : existing.visits,
    lastDateTime: nowFiletime,
    lastDateTimeMs: nowMs,
  };

  // First visit by this character: write the whole node at once. Writing the
  // system entry alone would let the write path create the character node
  // without lastSolarSystemID, so the next visit would double-count.
  if (!systems) {
    return reportWrite(repo.write(TABLE, `/visitsByCharacterID/${characterKey}`, {
      lastSolarSystemID: systemID,
      systems: { [systemKey]: entry },
    }));
  }

  const entryWritten = reportWrite(
    repo.write(TABLE, `/visitsByCharacterID/${characterKey}/systems/${systemKey}`, entry),
  );
  if (!entryWritten || previousSystemID === systemID) {
    return entryWritten;
  }
  return reportWrite(
    repo.write(TABLE, `/visitsByCharacterID/${characterKey}/lastSolarSystemID`, systemID),
  );
}

// The list is appended in time order and only ever loses events off its head,
// so it is already sorted every time but the first. Confirm that in one pass
// and slice, instead of re-sorting all MAX_JUMP_EVENTS entries on every jump;
// fall back to the full sort only when a caller supplied an out-of-order
// timestamp. Always returns a new array, never the one passed in.
// Nothing else ever removes a character's visit history, so without this the
// table keeps a full map for every character the server has ever had. Per
// character the history is bounded by the size of the universe; the number of
// characters is not.
function clearCharacterVisits(sessionOrCharacterID) {
  const characterID = getCharacterID(sessionOrCharacterID);
  if (characterID <= 0) {
    return false;
  }

  const result = repo.remove(TABLE, `/visitsByCharacterID/${characterID}`);
  if (result.success || result.errorMsg === "ENTRY_NOT_FOUND" || result.errorMsg === "TABLE_NOT_FOUND") {
    return true;
  }
  log.warn(
    `[MapTelemetry] Failed to clear visits characterID=${characterID}: ${result.errorMsg || "REMOVE_ERROR"}`,
  );
  return false;
}

function pruneJumpEvents(events, nowMs) {
  const cutoffMs = nowMs - DEFAULT_JUMP_RETENTION_HOURS * 60 * 60 * 1000;
  const source = Array.isArray(events) ? events : [];

  let firstKeptIndex = -1;
  let ascending = true;
  let previousAtMs = 0;
  for (let index = 0; index < source.length; index += 1) {
    const atMs = toPositiveInteger(source[index] && source[index].atMs, 0);
    if (atMs < previousAtMs) {
      ascending = false;
      break;
    }
    previousAtMs = atMs;
    if (firstKeptIndex < 0 && atMs >= cutoffMs) {
      firstKeptIndex = index;
    }
  }

  const pruned = ascending
    ? (firstKeptIndex < 0 ? [] : source.slice(firstKeptIndex))
    : source
      .filter((event) => toPositiveInteger(event && event.atMs, 0) >= cutoffMs)
      .sort((left, right) => toPositiveInteger(left && left.atMs, 0) - toPositiveInteger(right && right.atMs, 0));

  if (pruned.length <= MAX_JUMP_EVENTS) {
    return pruned;
  }
  return pruned.slice(pruned.length - MAX_JUMP_EVENTS);
}

function recordSolarSystemJump(sessionOrCharacterID, details = {}) {
  const characterID = getCharacterID(sessionOrCharacterID);
  const fromSolarSystemID = toPositiveInteger(details.fromSolarSystemID, 0);
  const toSolarSystemID = toPositiveInteger(
    details.toSolarSystemID || details.solarSystemID,
    0,
  );
  if (characterID <= 0 || toSolarSystemID <= 0) {
    return false;
  }

  ensureBootstrapped();

  const nowMs = toPositiveInteger(details.nowMs, Date.now());
  const atFiletime = normalizeFiletimeString(details.filetime, filetimeFromMs(nowMs));
  const read = repo.read(TABLE, "/");
  if (!read.success || !read.data || typeof read.data !== "object") {
    log.warn(`[MapTelemetry] Failed to read ${TABLE}: ${read.errorMsg || "READ_ERROR"}`);
    return false;
  }

  // jumpEvents is an unkeyed array, so it is a single stored row either way. A
  // root write of the table's own reference skips the whole-table comparison,
  // and knownChangedPaths keeps the flush on its localized row path.
  const table = read.data;
  const previousJumpEvents = table.jumpEvents;
  const nextJumpEvents = pruneJumpEvents(table.jumpEvents, nowMs);
  nextJumpEvents.push({
    atMs: nowMs,
    atFiletime,
    characterID,
    shipID: toPositiveInteger(details.shipID, null),
    fromSolarSystemID: fromSolarSystemID || null,
    toSolarSystemID,
    kind: String(details.kind || "stargate"),
    sourceID: toPositiveInteger(details.sourceID, null),
    destinationID: toPositiveInteger(details.destinationID, null),
  });
  table.jumpEvents = nextJumpEvents;

  const written = reportWrite(
    repo.write(TABLE, "/", table, { knownChangedPaths: ["/jumpEvents"] }),
  );
  if (!written) {
    // The mutation landed in the live table before the write was refused, so
    // undo it rather than leave an unpersisted event behind.
    table.jumpEvents = previousJumpEvents;
  }
  return written;
}

function listSolarSystemVisitRows(characterID) {
  const numericCharacterID = getCharacterID(characterID);
  if (numericCharacterID <= 0) {
    return [];
  }

  const systems = readVisitSystems(readCharacterVisitNode(String(numericCharacterID)));
  if (!systems) {
    return [];
  }

  return Object.values(systems)
    .map((entry) => {
      const solarSystemID = toPositiveInteger(entry && entry.solarSystemID, 0);
      const visits = toPositiveInteger(entry && entry.visits, 0);
      const lastDateTime = normalizeFiletimeString(
        entry && entry.lastDateTime,
        currentFiletimeString(),
      );
      if (solarSystemID <= 0 || visits <= 0) {
        return null;
      }
      return [
        buildFiletimeLong(lastDateTime),
        solarSystemID,
        visits,
      ];
    })
    .filter(Boolean)
    .sort((left, right) => toInteger(left[1], 0) - toInteger(right[1], 0));
}

function listJumpHistoryRows(hours = 1, nowMs = Date.now()) {
  const windowHours = Math.max(1, Math.min(24, toPositiveInteger(hours, 1)));
  const cutoffMs = nowMs - windowHours * 60 * 60 * 1000;
  const counts = new Map();

  for (const event of readJumpEvents()) {
    const atMs = toPositiveInteger(event && event.atMs, 0);
    if (atMs < cutoffMs || atMs > nowMs + 60000) {
      continue;
    }
    const solarSystemID = toPositiveInteger(
      event && (event.toSolarSystemID || event.solarSystemID),
      0,
    );
    if (solarSystemID <= 0) {
      continue;
    }
    counts.set(solarSystemID, (counts.get(solarSystemID) || 0) + 1);
  }

  return [...counts.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([solarSystemID, count]) => [solarSystemID, count, 0, 0]);
}

module.exports = {
  TABLE,
  clearCharacterVisits,
  filetimeFromMs,
  msFromFiletime,
  listJumpHistoryRows,
  listSolarSystemVisitRows,
  recordSolarSystemJump,
  recordSolarSystemVisit,
};
