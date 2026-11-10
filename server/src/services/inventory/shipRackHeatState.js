"use strict";

// A ship's rack heat as the store keeps it.
//
// A rack's heat stays with the ship when the ship leaves space: Tranquility's
// answer for a docked Caracal has 17.14 in its medium rack sixteen seconds
// after the rack stopped heating, in the ship's attributes and in its state
// ("Cargo Delivery" recording). In space the heat is the space entity's, and
// space/runtime/moduleHeat.js works it out. This is the form it is kept in
// with the ship, as a part of the ship's stored condition:
//
//   conditionState.heat = { high, med, low, atMs }
//
// each rack's heat as it was at atMs, the wall clock in milliseconds. Whoever
// reads it ages it by the time since (moduleHeat.js). A cold ship has no such
// part, so a ship that never overheated is stored as it always was.

const RACK_FAMILIES = Object.freeze(["high", "med", "low"]);

/** The stored form of what is given, or null where there is nothing to keep: no rack warm, or no time. */
function normalizeStoredRackHeat(rawValue) {
  if (!rawValue || typeof rawValue !== "object") {
    return null;
  }
  const atMs = Number(rawValue.atMs);
  if (!Number.isFinite(atMs) || atMs <= 0) {
    return null;
  }
  const stored = { atMs };
  let warm = false;
  for (const family of RACK_FAMILIES) {
    const heat = Number(rawValue[family]);
    stored[family] = Number.isFinite(heat) && heat > 0 ? heat : 0;
    warm = warm || stored[family] > 0;
  }
  return warm ? stored : null;
}

/**
 * What is to be stored of a ship entity's heat at nowMs, or null where it is
 * cold. An entity whose racks' heat is being worked out (it has a
 * rackHeatState) is stored as it is now. One that has none yet has not taken
 * up its ship's stored heat (moduleHeat.js does that when the state is made):
 * it still carries that heat as it came from the store, and that is kept.
 */
function buildStoredRackHeatForEntity(entity, nowMs) {
  if (!entity) {
    return null;
  }
  if (!entity.rackHeatState) {
    return normalizeStoredRackHeat(entity.conditionState && entity.conditionState.heat);
  }
  return normalizeStoredRackHeat({
    ...(entity.rackHeatState.levels || {}),
    atMs: nowMs,
  });
}

/** A ship's condition with its heat part put in, or taken out where storedHeat is null. */
function withStoredRackHeat(conditionState, storedHeat) {
  const { heat: _previous, ...rest } = conditionState || {};
  return storedHeat ? { ...rest, heat: storedHeat } : rest;
}

module.exports = {
  buildStoredRackHeatForEntity,
  normalizeStoredRackHeat,
  withStoredRackHeat,
};
