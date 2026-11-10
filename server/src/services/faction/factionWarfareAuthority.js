"use strict";

// The local authored placements are the only verified occupation seeds. The
// donor's authority table is empty; its historical TQ statistics are not seeds.
const database = require("../../gameStore");
const model = require("./fwOpenModel");
const TABLE = "fwOpenReplay";
const WARZONES = Object.freeze({
  1: Object.freeze([500003, 500002]),
  2: Object.freeze([500001, 500004]),
});
const MILITIAS = Object.freeze({ 500001: 1000180, 500002: 1000182, 500003: 1000179, 500004: 1000181 });
const HEADQUARTERS = Object.freeze({ 500001: 30045324, 500002: 30002055, 500003: 30002974, 500004: 30003788 });

function positiveID(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function getWarzoneID(factionID) {
  return Number(Object.keys(WARZONES).find(id => WARZONES[id].includes(factionID))) || null;
}

function dateTaken(value) {
  const text = typeof value === "string" ? value : Number.isSafeInteger(value) ? String(value) : "";
  return /^\d{1,19}$/.test(text) && BigInt(text) > 0n && BigInt(text) <= 9223372036854775807n ? text : null;
}

function readState() {
  const value = database.read(TABLE, "/state").data;
  return value ? structuredClone(value) : { systems: {}, receipts: {}, pending: {} };
}

function writeState(value) {
  const previous = database.read(TABLE, "/state").data;
  const before = previous ? structuredClone(previous) : null;
  const result = database.write(TABLE, "/state", structuredClone(value));
  if (!result.success) throw new Error(`FW state write failed: ${result.errorMsg}`);
  try {
    const flushed = database.flushTableSync(TABLE);
    if (!flushed?.success) throw new Error(flushed?.errorMsg || "WRITE_ERROR");
  } catch (error) {
    if (before) database.write(TABLE, "/state", before);
    else database.remove(TABLE, "/state");
    throw new Error(`FW state flush failed: ${error.message}`);
  }
}

function getSystem(solarSystemID, state = readState()) {
  if (!positiveID(solarSystemID)) return null;
  const seed = model.SYSTEMS[solarSystemID];
  if (!seed) return null;
  const warzoneID = getWarzoneID(seed.occupier);
  const stored = state.systems[solarSystemID];
  const local = stored || { occupier: seed.occupier, score: seed.initialVP, threshold: 75000 };
  if (!WARZONES[warzoneID]?.includes(local.occupier) ||
      !Number.isFinite(local.score) || local.score < 0 ||
      !Number.isFinite(local.threshold) || local.threshold <= 0 || local.score > local.threshold) return null;
  // There is no installed system-LP donation/upgrade owner. Personal militia
  // LP is never a system pool and must not be exposed as one.
  return { solarSystemID, warzoneID, occupierID: local.occupier,
    attackerID: WARZONES[warzoneID].find(id => id !== local.occupier),
    potentialOccupierIDs: [...WARZONES[warzoneID]], pirateFactionID: warzoneID === 1 ? 500011 : 500010,
    // Existing placements use Command Operations rewards (second-line,1.0).
    // This is an authored status, not a calculated territorial adjacency.
    adjacencyState: "SL", dateTaken: dateTaken(local.dateTaken),
    score: local.score, threshold: local.threshold, systemLP: 0, upgradeLevel: 0,
    source: "evejs-authored-open-fw" };
}

function listSystems(state = readState()) {
  return Object.keys(model.SYSTEMS).map(Number).sort((a, b) => a - b)
    .map(id => getSystem(id, state)).filter(Boolean);
}

function systemState(solarSystemID, state = readState()) {
  const system = getSystem(solarSystemID, state);
  return system ? { ...(state.systems[solarSystemID] || {}),
    occupier: system.occupierID, score: system.score, threshold: system.threshold } : null;
}

function getMilitiaCorporationID(factionID) { return positiveID(factionID) ? MILITIAS[factionID] || null : null; }
function getFactionIDForMilitiaCorporationID(corporationID) {
  return Number(Object.keys(MILITIAS).find(id => MILITIAS[id] === corporationID)) || null;
}

module.exports = { TABLE, WARZONES, MILITIAS, HEADQUARTERS, positiveID, getWarzoneID,
  readState, writeState, getSystem, listSystems, systemState,
  getMilitiaCorporationID, getFactionIDForMilitiaCorporationID, normalizeDateTaken: dateTaken };
