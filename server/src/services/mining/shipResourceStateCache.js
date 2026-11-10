"use strict";

// Adapted from ciefa/evejs-ciefa-fork 98d7ca1fa1484b0a2bb0f825d0d86218fc1f5fdf.
// Keep one fitting result per live Ball. Weak keys release retired ships rather
// than retaining every inventory revision or every ship ever seen by a process.
let entries = new WeakMap();
let hits = 0;
let builds = 0;
let bypasses = 0;
const VOLATILE_SHIP_FIELDS = new Set([
  "conditionState", "spaceState", "inventoryCustodyRevision",
]);
const ROW_METADATA_FIELDS = new Set(["inventoryCustodyRevision"]);

function gameplayRow(row, ignored = ROW_METADATA_FIELDS) {
  return Object.fromEntries(Object.entries(row || {}).filter(([key]) => !ignored.has(key)));
}

function getShipResourceState(entity, inputs, build) {
  const {
    characterID, shipItem, fittedItems, hiddenModifierItems, skillMap, characterRecord,
  } = inputs;
  const boosters = characterRecord && characterRecord.boosters;
  // Booster effects expire by the clock. Re-evaluate them on every read, and
  // drop an old cached result so removing the last dose cannot revive it.
  if (!entity || typeof entity !== "object" || (Array.isArray(boosters) && boosters.length > 0)) {
    if (entity && typeof entity === "object") entries.delete(entity);
    bypasses += 1;
    return build();
  }
  const key = JSON.stringify([
    characterID,
    gameplayRow(shipItem, VOLATILE_SHIP_FIELDS),
    fittedItems.map((item) => gameplayRow(item)),
    hiddenModifierItems.map((item) => gameplayRow(item)),
    characterRecord && characterRecord.implants || [],
  ]);
  const previous = entries.get(entity);
  if (previous && previous.key === key && previous.skillMap === skillMap) {
    hits += 1;
    return previous.resourceState;
  }
  const resourceState = build();
  builds += 1;
  entries.set(entity, { key, skillMap, resourceState });
  return resourceState;
}

function reset() {
  entries = new WeakMap();
  hits = 0;
  builds = 0;
  bypasses = 0;
}

module.exports = {
  getShipResourceState,
  _testing: { reset, getStats: () => ({ hits, builds, bypasses }) },
};
