"use strict";

const {
  toInt,
} = require("../../common/numbers");

const path = require("path");

const {
  TABLE,
  readStaticTable,
} = require(path.join(__dirname, "../_shared/referenceData"));

let cache = null;

function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizePayload(payload = {}) {
  return {
    version: toInt(payload.version, 0),
    generatedAt: String(payload.generatedAt || "").trim(),
    source: payload && typeof payload.source === "object" ? payload.source : {},
    counts: payload && typeof payload.counts === "object" ? payload.counts : {},
    relationsByOwnerID:
      payload && typeof payload.relationsByOwnerID === "object"
        ? payload.relationsByOwnerID
        : {},
    entries: Array.isArray(payload.entries) ? payload.entries : [],
    clientNpcNpcStandings:
      payload && payload.clientNpcNpcStandings && typeof payload.clientNpcNpcStandings === "object"
        ? payload.clientNpcNpcStandings
        : null,
  };
}

function buildCache() {
  const payload = normalizePayload(readStaticTable(TABLE.NPC_STANDINGS_AUTHORITY));
  const relationsByOwnerID = new Map();

  for (const [ownerID, relations] of Object.entries(payload.relationsByOwnerID || {})) {
    const normalizedOwnerID = toInt(ownerID, 0);
    if (!normalizedOwnerID) {
      continue;
    }
    const normalizedRelations = Array.isArray(relations)
      ? relations
          .map((entry) => ({
            toID: toInt(entry && entry.toID, 0),
            standing: Number(entry && entry.standing),
            propagationMultiplier:
              entry && Object.prototype.hasOwnProperty.call(entry, "propagationMultiplier")
                ? Number(entry.propagationMultiplier)
                : Number(entry && entry.standing),
            source: String(entry && entry.source || ""),
            sourceLabel: String(entry && entry.sourceLabel || ""),
          }))
          .filter(
            (entry) =>
              entry.toID > 0 &&
              entry.toID !== normalizedOwnerID &&
              Number.isFinite(entry.standing) &&
              Number.isFinite(entry.propagationMultiplier),
          )
      : [];
    relationsByOwnerID.set(normalizedOwnerID, normalizedRelations);
  }

  const entries = Array.isArray(payload.entries)
    ? payload.entries
        .map((entry) => ({
          fromID: toInt(entry && entry.fromID, 0),
          toID: toInt(entry && entry.toID, 0),
          standing: Number(entry && entry.standing),
          propagationMultiplier:
            entry && Object.prototype.hasOwnProperty.call(entry, "propagationMultiplier")
              ? Number(entry.propagationMultiplier)
              : Number(entry && entry.standing),
          source: String(entry && entry.source || ""),
          sourceLabel: String(entry && entry.sourceLabel || ""),
        }))
        .filter(
          (entry) =>
            entry.fromID > 0 &&
            entry.toID > 0 &&
            entry.fromID !== entry.toID &&
            Number.isFinite(entry.standing) &&
            Number.isFinite(entry.propagationMultiplier),
        )
    : [];

  // What Tranquility answers to standingMgr.GetNPCNPCStandings, as the table keeps it (clientNpcNpcStandings: the
  // factions' standings with each other, in the order they were answered). The relations above stay what the
  // standings' spreading reads; nothing here is used for that.
  const clientRows = payload.clientNpcNpcStandings && Array.isArray(payload.clientNpcNpcStandings.rows)
    ? payload.clientNpcNpcStandings.rows
        .map((row) => ({
          fromID: toInt(row && row.fromID, 0),
          toID: toInt(row && row.toID, 0),
          standing: Number(row && row.standing),
        }))
        .filter((row) => row.fromID > 0 && row.toID > 0 && Number.isFinite(row.standing))
    : [];

  return {
    payload,
    relationsByOwnerID,
    entries,
    clientRows,
  };
}

function ensureCache() {
  if (!cache) {
    cache = buildCache();
  }
  return cache;
}

function clearCache() {
  cache = null;
}

function listNpcStandings() {
  return cloneValue(ensureCache().entries);
}

/** The NPCs' standings with each other as Tranquility answers them; empty where the table keeps none. */
function listClientNpcStandings() {
  return cloneValue(ensureCache().clientRows);
}

function getRelationsForOwner(ownerID) {
  const record = ensureCache().relationsByOwnerID.get(toInt(ownerID, 0));
  return record ? cloneValue(record) : [];
}

function getPayload() {
  return cloneValue(ensureCache().payload);
}

module.exports = {
  clearCache,
  getPayload,
  getRelationsForOwner,
  listClientNpcStandings,
  listNpcStandings,
};
