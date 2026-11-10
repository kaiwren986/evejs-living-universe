"use strict";

// Chat command item type lists: removing duplicate item types and sorting them by name.

function dedupeItemTypes(itemTypes) {
  const deduped = [];
  const seen = new Set();
  for (const itemType of Array.isArray(itemTypes) ? itemTypes : []) {
    const typeID = Number(itemType && itemType.typeID) || 0;
    if (typeID <= 0 || seen.has(typeID)) {
      continue;
    }
    seen.add(typeID);
    deduped.push(itemType);
  }
  return deduped;
}

function sortItemTypesByName(left, right) {
  const leftName = String(left && left.name || "");
  const rightName = String(right && right.name || "");
  const nameCompare = leftName.localeCompare(rightName);
  if (nameCompare !== 0) {
    return nameCompare;
  }
  return (Number(left && left.typeID) || 0) - (Number(right && right.typeID) || 0);
}

module.exports = {
  dedupeItemTypes,
  sortItemTypesByName,
};
