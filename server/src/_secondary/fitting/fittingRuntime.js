"use strict";

const {
  toFiniteNumber,
} = require("../../common/numbers");

const path = require("path");

const {
  getSkillMutationVersion,
} = require(path.join(__dirname, "../../services/skills/skillState"));
const {
  getExpertSystemMutationVersion,
} = require(path.join(
  __dirname,
  "../../services/skills/expertSystems/expertSystemState",
));
const {
  getDogmaInvalidationVersion,
} = require(path.join(
  __dirname,
  "../../services/character/dogmaInvalidationVersion",
));

function getFittingSnapshotBuilder() {
  return require(path.join(__dirname, "./fittingSnapshotBuilder"));
}

// The pilot's drone attributes, maxActiveDrones (352) and droneControlDistance
// (458), which the snapshot's ship carries for this server's drone rules
// (liveFittingState CHAR_DOMAIN_SHIP_ATTRIBUTE_ALLOWLIST).
const PILOT_DRONE_ATTRIBUTE_IDS = Object.freeze([352, 458]);

// What the client is told of the ship's attributes (the changes to them,
// listShipFittingAttributeChanges): the snapshot's, but for the pilot's drone
// attributes where the ship's type has them not. They are the character's,
// and no ship's item in Tranquility's answers lists them
// (dogmaService/itemInfo.js _buildShipAttributeDict).
function withoutPilotDroneAttributes(attributes, shipTypeID) {
  const { getTypeDogmaAttributes } = require(path.join(
    __dirname,
    "../../services/fitting/liveFittingState",
  ));
  const typeAttributes = getTypeDogmaAttributes(toInt(shipTypeID, 0)) || {};
  const tracked = { ...attributes };
  for (const attributeID of PILOT_DRONE_ATTRIBUTE_IDS) {
    if (!(String(attributeID) in typeAttributes)) {
      delete tracked[attributeID];
    }
  }
  return tracked;
}

let nextSnapshotVersion = 1;
const shipSnapshotCache = new Map();

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function normalizeReasonList(reasonOrReasons) {
  const values = Array.isArray(reasonOrReasons)
    ? reasonOrReasons
    : reasonOrReasons === undefined || reasonOrReasons === null
      ? []
      : [reasonOrReasons];
  return [...new Set(
    values
      .map((value) => String(value || "").trim())
      .filter(Boolean),
  )];
}

function buildShipSnapshotCacheKey(characterID, shipReference, options = {}) {
  const shipID = toInt(
    shipReference && typeof shipReference === "object"
      ? shipReference.itemID
      : shipReference,
    toInt(options.shipID, toInt(options.shipItem && options.shipItem.itemID, 0)),
  );
  if (shipID <= 0) {
    return null;
  }

  const fittingMode =
    options.assumeActiveShipModules === true ? "active" : "passive";
  return `${toInt(characterID, 0)}:${shipID}:${fittingMode}`;
}

function normalizeSnapshotAttributes(attributes = {}) {
  return Object.fromEntries(
    Object.entries(attributes || {})
      .map(([attributeID, value]) => [Number(attributeID), Number(value)])
      .filter(
        ([attributeID, value]) =>
          Number.isInteger(attributeID) && Number.isFinite(value),
      ),
  );
}

function getDogmaDependencyVersions() {
  return {
    dogmaInvalidationVersion: toInt(getDogmaInvalidationVersion(), 0),
    skillMutationVersion: toInt(getSkillMutationVersion(), 0),
    expertSystemMutationVersion: toInt(getExpertSystemMutationVersion(), 0),
  };
}

function isSnapshotDogmaCurrent(snapshot) {
  if (!snapshot) {
    return false;
  }
  const dependencyVersions = getDogmaDependencyVersions();
  return (
    toInt(snapshot.dogmaInvalidationVersion, 0) ===
      dependencyVersions.dogmaInvalidationVersion &&
    toInt(snapshot.skillMutationVersion, 0) ===
      dependencyVersions.skillMutationVersion &&
    toInt(snapshot.expertSystemMutationVersion, 0) ===
      dependencyVersions.expertSystemMutationVersion
  );
}

function buildRuntimeSnapshotRecord(characterID, shipReference, options = {}) {
  const { buildFittingSnapshot } = getFittingSnapshotBuilder();
  const builtSnapshot = buildFittingSnapshot(characterID, shipReference, options);
  if (!builtSnapshot) {
    return null;
  }

  const shipAttributes = normalizeSnapshotAttributes(
    builtSnapshot.shipAttributes,
  );
  const trackedShipAttributes = withoutPilotDroneAttributes(
    shipAttributes,
    builtSnapshot.shipItem && builtSnapshot.shipItem.typeID,
  );
  const reasons = normalizeReasonList(options.reasons || options.reason);
  const dependencyVersions = getDogmaDependencyVersions();

  return {
    version: nextSnapshotVersion++,
    builtAt: Date.now(),
    reasons,
    characterID: toInt(characterID, 0),
    ...dependencyVersions,
    shipID: toInt(builtSnapshot.shipID, 0),
    shipItem: builtSnapshot.shipItem,
    fittedItems: builtSnapshot.fittedItems,
    skillMap: builtSnapshot.skillMap,
    resourceState: builtSnapshot.resourceState,
    shipAttributes: {
      ...shipAttributes,
    },
    trackedShipAttributes,
    snapshot: builtSnapshot,
    buildResourceStateForItems: builtSnapshot.buildResourceStateForItems,
    getModuleResourceLoad: builtSnapshot.getModuleResourceLoad,
    getModuleAttributeOverrides: builtSnapshot.getModuleAttributeOverrides,
    buildOnlineCandidateResourceState:
      builtSnapshot.buildOnlineCandidateResourceState,
  };
}

function getShipFittingSnapshot(characterID, shipReference, options = {}) {
  const cacheKey = buildShipSnapshotCacheKey(characterID, shipReference, options);
  if (!options.forceRefresh && cacheKey && shipSnapshotCache.has(cacheKey)) {
    const cachedSnapshot = shipSnapshotCache.get(cacheKey);
    if (isSnapshotDogmaCurrent(cachedSnapshot)) {
      return cachedSnapshot;
    }
    shipSnapshotCache.delete(cacheKey);
  }

  const record = buildRuntimeSnapshotRecord(characterID, shipReference, options);
  if (record && cacheKey) {
    shipSnapshotCache.set(cacheKey, record);
  }
  return record;
}

function refreshShipFittingSnapshot(characterID, shipReference, options = {}) {
  return getShipFittingSnapshot(characterID, shipReference, {
    ...options,
    forceRefresh: true,
  });
}

function peekShipFittingSnapshot(characterID, shipReference, options = {}) {
  const cacheKey = buildShipSnapshotCacheKey(characterID, shipReference, options);
  if (!cacheKey) {
    return null;
  }
  return shipSnapshotCache.get(cacheKey) || null;
}

function invalidateShipFittingSnapshot(characterID, shipReference, options = {}) {
  const cacheKey = buildShipSnapshotCacheKey(characterID, shipReference, options);
  if (!cacheKey) {
    return null;
  }
  const previousSnapshot = shipSnapshotCache.get(cacheKey) || null;
  shipSnapshotCache.delete(cacheKey);
  return previousSnapshot;
}

function listShipFittingAttributeChanges(previousSnapshot, nextSnapshot) {
  if (!previousSnapshot || !nextSnapshot) {
    return [];
  }

  const previousAttributes =
    previousSnapshot.trackedShipAttributes || previousSnapshot.shipAttributes || {};
  const nextAttributes =
    nextSnapshot.trackedShipAttributes || nextSnapshot.shipAttributes || {};
  const attributeIDs = new Set([
    ...Object.keys(previousAttributes),
    ...Object.keys(nextAttributes),
  ]);

  return [...attributeIDs]
    .map((attributeID) => toInt(attributeID, 0))
    .filter((attributeID) => attributeID > 0)
    .sort((left, right) => left - right)
    .map((attributeID) => {
      const previousValue = toFiniteNumber(previousAttributes[attributeID], 0);
      const nextValue = toFiniteNumber(nextAttributes[attributeID], 0);
      return {
        attributeID,
        previousValue,
        nextValue,
      };
    })
    .filter(
      (change) => Math.abs(change.nextValue - change.previousValue) > 1e-6,
    );
}

// What a ship's cargo hold carries, counted the way the inventory broker's
// capacity answer counts it. The item store is loaded on first use, like the
// snapshot builder, so this file stays safe to load early.
function getShipCargoUsedVolume(shipID) {
  const {
    ITEM_FLAGS,
    listContainerItems,
    getInventoryItemUnitVolume,
  } = require(path.join(__dirname, "../../services/inventory/itemStore"));
  return listContainerItems(null, toInt(shipID, 0), ITEM_FLAGS.CARGO_HOLD).reduce(
    (sum, item) => {
      if (!item) {
        return sum;
      }
      const units =
        toInt(item.singleton, 0) === 1
          ? 1
          : Math.max(0, toInt(item.stacksize ?? item.quantity, 0));
      return sum + (Math.max(0, toFiniteNumber(getInventoryItemUnitVolume(item), 0)) * units);
    },
    0,
  );
}

// A cargo hold may not be left carrying more than its capacity when fitted
// items that enlarge it stop applying: unfitted, destroyed or put offline.
// `snapshot` is the ship's fitting from before the change. addedCargoVolume is
// cargo the same change puts in the hold, such as the module itself when it is
// unfitted to cargo. Returns the numbers when the hold would end up over
// capacity, otherwise null. A hold that is already over capacity for another
// reason does not block a change that leaves its size alone.
function getCargoOverflowWithoutItems(snapshot, itemIDs, addedCargoVolume = 0) {
  if (!snapshot || typeof snapshot.buildResourceStateForItems !== "function") {
    return null;
  }
  const used =
    getShipCargoUsedVolume(snapshot.shipID) +
    Math.max(0, toFiniteNumber(addedCargoVolume, 0));
  if (used <= 0) {
    return null;
  }
  const leavingItemIDs = new Set(
    (Array.isArray(itemIDs) ? itemIDs : [itemIDs]).map((itemID) => toInt(itemID, 0)),
  );
  const fittedItems = Array.isArray(snapshot.fittedItems) ? snapshot.fittedItems : [];
  const remainingItems = fittedItems.filter(
    (item) => !leavingItemIDs.has(toInt(item && item.itemID, 0)),
  );
  if (remainingItems.length === fittedItems.length) {
    return null;
  }
  const capacityBefore = toFiniteNumber(
    snapshot.resourceState && snapshot.resourceState.cargoCapacity,
    0,
  );
  const remainingResourceState = snapshot.buildResourceStateForItems(remainingItems);
  if (!remainingResourceState) {
    return null;
  }
  const capacityAfter = toFiniteNumber(remainingResourceState.cargoCapacity, 0);
  if (capacityAfter >= capacityBefore - 1e-7 || used <= capacityAfter + 1e-7) {
    return null;
  }
  return { used, capacityBefore, capacityAfter };
}

function buildShipFittingSnapshotDiagnostics(snapshot) {
  if (!snapshot) {
    return null;
  }

  return {
    version: toInt(snapshot.version, 0),
    builtAt: toInt(snapshot.builtAt, 0),
    reasons: [...normalizeReasonList(snapshot.reasons)],
    characterID: toInt(snapshot.characterID, 0),
    dogmaInvalidationVersion: toInt(snapshot.dogmaInvalidationVersion, 0),
    skillMutationVersion: toInt(snapshot.skillMutationVersion, 0),
    expertSystemMutationVersion: toInt(snapshot.expertSystemMutationVersion, 0),
    shipID: toInt(snapshot.shipID, 0),
    fittedItemCount: Array.isArray(snapshot.fittedItems)
      ? snapshot.fittedItems.length
      : 0,
    cpuLoad: toFiniteNumber(snapshot.resourceState && snapshot.resourceState.cpuLoad, 0),
    cpuOutput: toFiniteNumber(snapshot.resourceState && snapshot.resourceState.cpuOutput, 0),
    powerLoad: toFiniteNumber(snapshot.resourceState && snapshot.resourceState.powerLoad, 0),
    powerOutput: toFiniteNumber(
      snapshot.resourceState && snapshot.resourceState.powerOutput,
      0,
    ),
    trackedAttributeCount: Object.keys(
      snapshot.trackedShipAttributes || snapshot.shipAttributes || {},
    ).length,
  };
}

function resetFittingRuntimeForTests() {
  shipSnapshotCache.clear();
  nextSnapshotVersion = 1;
}

module.exports = {
  buildShipSnapshotCacheKey,
  getShipFittingSnapshot,
  refreshShipFittingSnapshot,
  peekShipFittingSnapshot,
  invalidateShipFittingSnapshot,
  listShipFittingAttributeChanges,
  getCargoOverflowWithoutItems,
  buildShipFittingSnapshotDiagnostics,
  resetFittingRuntimeForTests,
};
