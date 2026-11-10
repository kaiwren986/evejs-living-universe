"use strict";

// The historical item identifies the Electrical family. Use the supported
// client's weakest Electrical Storm source for this replay's authored tier.
const ELECTRICAL_WEATHER_TYPE_ID = 47381;
const POST_PERCENT = 6;

function shipModifiers(entity) {
  if (!entity?.voidReplayElectrical) return [];
  const dogma = require("../fitting/liveFittingState").getTypeDogmaAttributes(ELECTRICAL_WEATHER_TYPE_ID);
  return [
    [55, dogma[2471]], // Capacitor recharge time.
    [271, dogma[2469]], // Shield EM resonance.
    [267, dogma[2469]], // Armor EM resonance.
    [113, dogma[2469]], // Hull EM resonance.
  ].filter(([, value]) => Number.isFinite(value)).map(([modifiedAttributeID, value]) => ({
    modifiedAttributeID,
    value,
    operation: POST_PERCENT,
    stackingPenalized: false,
  }));
}

function mergeClientDbuffState(entity, entries) {
  if (!entity?.voidReplayElectrical) return entries;
  const dogma = require("../fitting/liveFittingState").getTypeDogmaAttributes(ELECTRICAL_WEATHER_TYPE_ID);
  const merged = new Map(entries);
  for (const [collectionID, value, aggregate] of [
    [dogma[2468], dogma[2469], Math.max],
    [dogma[2470], dogma[2471], Math.min],
  ]) {
    if (!Number.isSafeInteger(collectionID) || !Number.isFinite(value)) continue;
    const existing = merged.get(collectionID);
    if (!existing || aggregate(existing[0], value) === value) merged.set(collectionID, [value, null]);
  }
  return [...merged].sort((left, right) => left[0] - right[0]);
}

module.exports = { mergeClientDbuffState, shipModifiers };
