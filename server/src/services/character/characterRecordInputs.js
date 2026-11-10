"use strict";

// Per-character normalization inputs. Adapted from ciefa/evejs-ciefa-fork
// a3f9a4060; this leaf is safe for the inventory and skills owners to import.
let counter = 1;
let epoch = 1;
const stamps = new Map();

function toCharacterID(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : 0;
}

function noteCharacterRecordInputChanged(characterID) {
  const id = toCharacterID(characterID);
  if (id) stamps.set(id, ++counter);
}

function noteAllCharacterRecordInputsChanged() {
  epoch = ++counter;
  stamps.clear();
}

function getCharacterRecordInputVersion(characterID) {
  return Math.max(epoch, stamps.get(toCharacterID(characterID)) || 0);
}

const asRow = (value) => value && typeof value === "object" ? value : null;
const isKnownNonShip = (row) => !row || (row.categoryID != null
  && Number.isFinite(Number(row.categoryID)) && Number(row.categoryID) > 0 && Number(row.categoryID) !== 6);

function changesRecordFields(before, after) {
  if (!before || !after || before === after) return before !== after || Boolean(before);
  return ["ownerID", "categoryID", "locationID", "flagID", "singleton", "quantity", "stacksize"]
    .some((field) => before[field] !== after[field])
    || (before.itemID ?? before.shipID) !== (after.itemID ?? after.shipID)
    || (before.typeID ?? before.shipTypeID) !== (after.typeID ?? after.shipTypeID)
    || (before.itemName ?? before.shipName) !== (after.itemName ?? after.shipName)
    || before.spaceState?.systemID !== after.spaceState?.systemID;
}

function noteCommittedItemRows(originals, items) {
  const owners = new Set();
  for (const [key, original] of originals) {
    const before = original.existed ? asRow(original.value) : null;
    const after = Object.prototype.hasOwnProperty.call(items, key) ? asRow(items[key]) : null;
    // With no preimage, an in-place owner/category change can hide even the
    // former owner. A global epoch is the conservative fallback.
    if (before && before === after) {
      noteAllCharacterRecordInputsChanged();
      return;
    }
    if ((isKnownNonShip(before) && isKnownNonShip(after)) || !changesRecordFields(before, after)) continue;
    if (before) owners.add(before.ownerID);
    if (after) owners.add(after.ownerID);
  }
  for (const ownerID of owners) noteCharacterRecordInputChanged(ownerID);
}

module.exports = {
  getCharacterRecordInputVersion,
  noteCharacterRecordInputChanged,
  noteAllCharacterRecordInputsChanged,
  noteCommittedItemRows,
  changesRecordFields,
};
