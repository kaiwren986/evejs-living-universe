"use strict";

const path = require("path");

const SHIP_CATEGORY_ID = 6;
const CHARGE_CATEGORY_ID = 8;
const DRONE_CATEGORY_ID = 18;
const FIGHTER_CATEGORY_ID = 87;
const DRONE_BAY_FLAG_ID = 87;
const FIGHTER_FLAG_MIN = 158;
const FIGHTER_FLAG_MAX = 163;
const FITTING_FLAG_RANGES = Object.freeze([
  Object.freeze([11, 34]),
  Object.freeze([92, 99]),
  Object.freeze([125, 132]),
  Object.freeze([164, 171]),
]);

let initialized = false;
let projectionVersion = 0;
const itemsByID = new Map();
const itemIDsByLocation = new Map();

function toPositiveInt(value, fallback = 0) {
  const numeric = Math.trunc(Number(value) || 0);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : fallback;
}

function cloneValue(value) {
  if (value === undefined || value === null) {
    return value;
  }
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) {
    return value;
  }
  seen.add(value);
  for (const child of Object.values(value)) {
    deepFreeze(child, seen);
  }
  return Object.freeze(value);
}

function detachItem(item) {
  const itemID = toPositiveInt(item && item.itemID, 0);
  return itemID ? deepFreeze(cloneValue(item)) : null;
}

function removeLocationIndex(item) {
  const itemID = toPositiveInt(item && item.itemID, 0);
  const locationID = toPositiveInt(item && item.locationID, 0);
  const bucket = itemIDsByLocation.get(locationID);
  if (!itemID || !bucket) {
    return;
  }
  bucket.delete(itemID);
  if (bucket.size === 0) {
    itemIDsByLocation.delete(locationID);
  }
}

function upsertDetachedItem(item) {
  const detached = detachItem(item);
  if (!detached) {
    return false;
  }
  const itemID = toPositiveInt(detached.itemID, 0);
  const previous = itemsByID.get(itemID) || null;
  if (previous) {
    removeLocationIndex(previous);
  }
  itemsByID.set(itemID, detached);
  const locationID = toPositiveInt(detached.locationID, 0);
  if (locationID > 0) {
    if (!itemIDsByLocation.has(locationID)) {
      itemIDsByLocation.set(locationID, new Set());
    }
    itemIDsByLocation.get(locationID).add(itemID);
  }
  return true;
}

function removeProjectedItem(itemID) {
  const normalizedItemID = toPositiveInt(itemID, 0);
  const previous = itemsByID.get(normalizedItemID) || null;
  if (!previous) {
    return false;
  }
  removeLocationIndex(previous);
  itemsByID.delete(normalizedItemID);
  return true;
}

function replaceProjection(itemRows, version) {
  itemsByID.clear();
  itemIDsByLocation.clear();
  for (const item of Array.isArray(itemRows) ? itemRows : []) {
    upsertDetachedItem(item);
  }
  projectionVersion = Math.max(0, Math.trunc(Number(version) || 0));
  initialized = true;
  return getProjectionDiagnostics();
}

function publishItemMutation(message = {}) {
  const incomingVersion = Math.max(0, Math.trunc(Number(message.version) || 0));
  if (Array.isArray(message.fullItems)) {
    if (initialized && incomingVersion < projectionVersion) {
      return false;
    }
    replaceProjection(message.fullItems, incomingVersion);
    return true;
  }
  if (!initialized) {
    return false;
  }
  if (incomingVersion <= projectionVersion) {
    return incomingVersion === projectionVersion;
  }
  if (incomingVersion !== projectionVersion + 1) {
    initialized = false;
    projectionVersion = 0;
    itemsByID.clear();
    itemIDsByLocation.clear();
    return false;
  }
  for (const itemID of Array.isArray(message.removedItemIDs)
    ? message.removedItemIDs
    : []) {
    removeProjectedItem(itemID);
  }
  for (const item of Array.isArray(message.upsertedItems)
    ? message.upsertedItems
    : []) {
    upsertDetachedItem(item);
  }
  projectionVersion = incomingVersion;
  return true;
}

function ensureInitialized() {
  if (initialized) {
    return;
  }
  const itemStore = require(path.join(__dirname, "./itemStore"));
  const seed = itemStore.getSimulationInventoryProjectionSeed();
  replaceProjection(seed.items, seed.version);
}

function warmSimulationInventoryProjection() {
  ensureInitialized();
  return getProjectionDiagnostics();
}

function getProjectionVersion() {
  ensureInitialized();
  return projectionVersion;
}

function findItemById(itemID) {
  ensureInitialized();
  return itemsByID.get(toPositiveInt(itemID, 0)) || null;
}

function findShipItemById(itemID) {
  const item = findItemById(itemID);
  return item && Number(item.categoryID) === SHIP_CATEGORY_ID ? item : null;
}

function listContainerItems(ownerID, locationID, flagID = null) {
  ensureInitialized();
  const normalizedOwnerID = ownerID === null || ownerID === undefined
    ? null
    : toPositiveInt(ownerID, 0);
  const normalizedLocationID = toPositiveInt(locationID, 0);
  const normalizedFlagID = flagID === null || flagID === undefined
    ? null
    : Math.trunc(Number(flagID) || 0);
  const itemIDs = itemIDsByLocation.get(normalizedLocationID) || new Set();
  return [...itemIDs]
    .sort((left, right) => left - right)
    .map((itemID) => itemsByID.get(itemID))
    .filter((item) => (
      item &&
      (normalizedOwnerID === null || Number(item.ownerID) === normalizedOwnerID) &&
      (normalizedFlagID === null || Number(item.flagID) === normalizedFlagID)
    ));
}

function listSystemSpaceItems(systemID, nowMs = Date.now()) {
  return listContainerItems(null, systemID, 0).filter((item) => (
    item &&
    item.spaceState &&
    Number(item.spaceState.systemID) === Number(systemID) &&
    (
      item.expiresAtMs === null || item.expiresAtMs === undefined ||
      !Number.isFinite(Number(item.expiresAtMs)) ||
      Number(item.expiresAtMs) > Number(nowMs)
    )
  ));
}

function isFittingFlag(flagID) {
  const normalizedFlagID = Math.trunc(Number(flagID) || 0);
  return FITTING_FLAG_RANGES.some(
    ([minimum, maximum]) =>
      normalizedFlagID >= minimum && normalizedFlagID <= maximum,
  );
}

function buildShipInventoryProjection(ownerID, shipID) {
  const normalizedOwnerID = toPositiveInt(ownerID, 0);
  const normalizedShipID = toPositiveInt(shipID, 0);
  const shipItem = findShipItemById(normalizedShipID);
  const contents = listContainerItems(
    normalizedOwnerID || null,
    normalizedShipID,
    null,
  );
  const fittedItems = contents.filter((item) => isFittingFlag(item.flagID));
  const charges = fittedItems.filter(
    (item) => Number(item.categoryID) === CHARGE_CATEGORY_ID,
  );
  const drones = contents.filter((item) => (
    Number(item.categoryID) === DRONE_CATEGORY_ID ||
    Number(item.flagID) === DRONE_BAY_FLAG_ID
  ));
  const fighters = contents.filter((item) => (
    Number(item.categoryID) === FIGHTER_CATEGORY_ID ||
    (
      Number(item.flagID) >= FIGHTER_FLAG_MIN &&
      Number(item.flagID) <= FIGHTER_FLAG_MAX
    )
  ));
  const holdsByFlag = {};
  for (const item of contents.filter((entry) => !isFittingFlag(entry.flagID))) {
    const key = String(Math.trunc(Number(item.flagID) || 0));
    if (!holdsByFlag[key]) {
      holdsByFlag[key] = [];
    }
    holdsByFlag[key].push(item);
  }
  for (const rows of Object.values(holdsByFlag)) {
    Object.freeze(rows);
  }
  return Object.freeze({
    version: getProjectionVersion(),
    ownerID: normalizedOwnerID || null,
    shipID: normalizedShipID,
    shipItem,
    contents: Object.freeze(contents),
    fittedItems: Object.freeze(fittedItems),
    charges: Object.freeze(charges),
    drones: Object.freeze(drones),
    fighters: Object.freeze(fighters),
    holdsByFlag: Object.freeze(holdsByFlag),
  });
}

function getProjectionDiagnostics() {
  return Object.freeze({
    initialized,
    version: projectionVersion,
    itemCount: itemsByID.size,
    locationCount: itemIDsByLocation.size,
  });
}

function resetSimulationInventoryProjectionForTests() {
  initialized = false;
  projectionVersion = 0;
  itemsByID.clear();
  itemIDsByLocation.clear();
}

module.exports = {
  buildShipInventoryProjection,
  findItemById,
  findShipItemById,
  getProjectionDiagnostics,
  getProjectionVersion,
  listContainerItems,
  listSystemSpaceItems,
  publishItemMutation,
  resetSimulationInventoryProjectionForTests,
  warmSimulationInventoryProjection,
};
