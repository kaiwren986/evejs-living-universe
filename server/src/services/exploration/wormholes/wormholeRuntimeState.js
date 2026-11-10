"use strict";

const path = require("path");
const { isDeepStrictEqual } = require("util");

const database = require(path.join(__dirname, "../../../gameStore"));
const targetIdRuntime = require(path.join(
  __dirname,
  "../signatures/targetIdRuntime",
));
const { WORMHOLE_ENDPOINT_ID_BASE } = require("./wormholeRuntimeMigration");

const WORMHOLE_RUNTIME_TABLE = "wormholeRuntimeState";
const WORMHOLE_RUNTIME_VERSION = 4;

function normalizeVisibilityState(value, discovered = false) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "visible" || normalized === "hidden" || normalized === "invisible") {
    return normalized;
  }
  return discovered === true ? "visible" : "hidden";
}

let cache = null;
let cacheIndex = null;
let pendingAllocatorRepairs = [];
let profileRevisionSequence = 0;

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function cloneEndpoint(endpoint = {}) {
  return {
    ...endpoint,
    position: endpoint && endpoint.position && typeof endpoint.position === "object"
      ? { ...endpoint.position }
      : endpoint.position,
    direction: endpoint && endpoint.direction && typeof endpoint.direction === "object"
      ? { ...endpoint.direction }
      : endpoint.direction,
  };
}

function cloneRuntimeState(state = {}) {
  const pairsByID = {};
  for (const [pairKey, pair] of Object.entries(state.pairsByID || {})) {
    pairsByID[pairKey] = {
      ...pair,
      source: cloneEndpoint(pair && pair.source ? pair.source : {}),
      destination: cloneEndpoint(pair && pair.destination ? pair.destination : {}),
    };
  }

  const staticSlotsByKey = {};
  for (const [slotKey, slotState] of Object.entries(state.staticSlotsByKey || {})) {
    staticSlotsByKey[slotKey] = {
      ...slotState,
    };
  }

  const polarizationByCharacter = {};
  for (const [characterKey, endpoints] of Object.entries(state.polarizationByCharacter || {})) {
    const clonedEndpoints = {};
    for (const [endpointKey, record] of Object.entries(endpoints || {})) {
      clonedEndpoints[endpointKey] = {
        ...record,
      };
    }
    polarizationByCharacter[characterKey] = clonedEndpoints;
  }

  return {
    ...state,
    pairsByID,
    staticSlotsByKey,
    polarizationByCharacter,
  };
}

function normalizeEndpoint(endpoint = {}) {
  const discovered = endpoint.discovered === true;
  const visibilityState = normalizeVisibilityState(endpoint.visibilityState, discovered);
  const endpointID = toInt(endpoint.endpointID, 0);
  const systemID = toInt(endpoint.systemID, 0);
  const targetID = String(endpoint.targetID || "").trim().toUpperCase() || (
    endpointID > 0 && systemID > 0
      ? targetIdRuntime.encodeTargetID("wormhole", systemID, endpointID)
      : null
  );
  return {
    endpointID,
    systemID,
    typeID: toInt(endpoint.typeID, 0),
    targetID,
    code: String(endpoint.code || "").trim().toUpperCase() || null,
    discovered: visibilityState === "visible",
    visibilityState,
    wormholeClassID: toInt(endpoint.wormholeClassID, 0),
    nebulaID: toInt(endpoint.nebulaID, 0),
    typeName: String(endpoint.typeName || "").trim() || null,
    position: endpoint.position && typeof endpoint.position === "object"
      ? {
          x: Number(endpoint.position.x) || 0,
          y: Number(endpoint.position.y) || 0,
          z: Number(endpoint.position.z) || 0,
        }
      : { x: 0, y: 0, z: 0 },
    direction: endpoint.direction && typeof endpoint.direction === "object"
      ? {
          x: Number(endpoint.direction.x) || 1,
          y: Number(endpoint.direction.y) || 0,
          z: Number(endpoint.direction.z) || 0,
        }
      : { x: 1, y: 0, z: 0 },
    radius: Number(endpoint.radius) || 3000,
    graphicID: toInt(endpoint.graphicID, 0),
    slotKey: String(endpoint.slotKey || "").trim() || null,
  };
}

function normalizePair(pair = {}) {
  return {
    pairID: toInt(pair.pairID, 0),
    kind: String(pair.kind || "static").trim().toLowerCase() || "static",
    randomProfileKey: String(pair.randomProfileKey || "").trim() || null,
    state: String(pair.state || "active").trim().toLowerCase() || "active",
    createdAtMs: Math.max(0, toInt(pair.createdAtMs, 0)),
    expiresAtMs: Math.max(0, toInt(pair.expiresAtMs, 0)),
    collapseAtMs: Math.max(0, toInt(pair.collapseAtMs, 0)),
    collapseReason: String(pair.collapseReason || "").trim() || null,
    totalMass: Math.max(0, toInt(pair.totalMass, 0)),
    remainingMass: Math.max(0, toInt(pair.remainingMass, 0)),
    massRegeneration: Math.max(0, toInt(pair.massRegeneration, 0)),
    maxJumpMass: Math.max(0, toInt(pair.maxJumpMass, 0)),
    lifetimeMinutes: Math.max(0, toInt(pair.lifetimeMinutes, 0)),
    lastMassStateAtMs: Math.max(
      0,
      toInt(pair.lastMassStateAtMs, pair.createdAtMs),
    ),
    massRegenRemainder: Math.max(0, Number(pair.massRegenRemainder) || 0),
    lastPassiveRevealCheckAtMs: Math.max(0, toInt(pair.lastPassiveRevealCheckAtMs, 0)),
    staticSlotKey: String(pair.staticSlotKey || "").trim() || null,
    source: normalizeEndpoint(pair.source || {}),
    destination: normalizeEndpoint(pair.destination || {}),
  };
}

function normalizeState(table = {}) {
  if (toInt(table.version, 0) > WORMHOLE_RUNTIME_VERSION) {
    throw new Error(`Unsupported wormhole runtime version ${table.version}`);
  }
  const nextPairSequence = Math.max(1, toInt(table.nextPairSequence, 1));
  const nextEndpointSequence = Math.max(1, toInt(table.nextEndpointSequence, 1));
  const universeSeededAtMs = Math.max(0, toInt(table.universeSeededAtMs, 0));
  const pairsByID = {};
  let maxPairID = 0;
  let maxEndpointSequence = 0;
  for (const [pairKey, pair] of Object.entries(table.pairsByID || {})) {
    const normalized = normalizePair(pair);
    if (normalized.pairID > 0) {
      pairsByID[String(normalized.pairID)] = normalized;
    } else if (toInt(pairKey, 0) > 0) {
      normalized.pairID = toInt(pairKey, 0);
      pairsByID[String(normalized.pairID)] = normalized;
    }
    maxPairID = Math.max(maxPairID, normalized.pairID);
    for (const endpoint of [normalized.source, normalized.destination]) {
      maxEndpointSequence = Math.max(maxEndpointSequence,
        endpoint.endpointID > WORMHOLE_ENDPOINT_ID_BASE
          ? endpoint.endpointID - WORMHOLE_ENDPOINT_ID_BASE
          : endpoint.endpointID);
    }
  }

  const staticSlotsByKey = {};
  for (const [slotKey, slotState] of Object.entries(table.staticSlotsByKey || {})) {
    const normalizedKey = String(slotKey || "").trim();
    if (!normalizedKey) {
      continue;
    }
    staticSlotsByKey[normalizedKey] = {
      slotKey: normalizedKey,
      systemID: toInt(slotState.systemID, 0),
      generation: Math.max(0, toInt(slotState.generation, 0)),
      activePairID: Math.max(0, toInt(slotState.activePairID, 0)),
      nextRespawnAtMs: Math.max(0, toInt(slotState.nextRespawnAtMs, 0)),
    };
  }

  const polarizationByCharacter = {};
  for (const [characterKey, endpoints] of Object.entries(table.polarizationByCharacter || {})) {
    const normalizedCharacterID = Math.max(0, toInt(characterKey, 0));
    if (!normalizedCharacterID) {
      continue;
    }
    const normalizedEndpoints = {};
    for (const [endpointKey, polarization] of Object.entries(endpoints || {})) {
      const endpointID = Math.max(0, toInt(endpointKey, 0));
      if (!endpointID) {
        continue;
      }
      const endAtMs = Math.max(0, toInt(polarization && polarization.endAtMs, 0));
      const durationSeconds = Math.max(
        0,
        toInt(polarization && polarization.durationSeconds, 0),
      );
      if (endAtMs > 0 && durationSeconds > 0) {
        normalizedEndpoints[String(endpointID)] = {
          endAtMs,
          durationSeconds,
        };
      }
    }
    polarizationByCharacter[String(normalizedCharacterID)] = normalizedEndpoints;
  }

  return {
    version: WORMHOLE_RUNTIME_VERSION,
    nextPairSequence: Math.max(nextPairSequence, maxPairID + 1),
    nextEndpointSequence: Math.max(nextEndpointSequence, maxEndpointSequence + 1),
    universeSeededAtMs,
    pairsByID,
    staticSlotsByKey,
    polarizationByCharacter,
  };
}

function addPairIDToIndex(index, key, pairID) {
  const numericKey = toInt(key, 0);
  const numericPairID = toInt(pairID, 0);
  if (numericKey <= 0 || numericPairID <= 0) {
    return;
  }
  const pairIDs = index.get(numericKey) || [];
  pairIDs.push(numericPairID);
  index.set(numericKey, pairIDs);
}

function incrementCount(index, key) {
  const numericKey = toInt(key, 0);
  if (numericKey <= 0) {
    return;
  }
  index.set(numericKey, (index.get(numericKey) || 0) + 1);
}

function decrementCount(index, key) {
  const numericKey = toInt(key, 0);
  if (numericKey <= 0) {
    return;
  }
  const nextCount = Math.max(0, (index.get(numericKey) || 0) - 1);
  if (nextCount > 0) {
    index.set(numericKey, nextCount);
  } else {
    index.delete(numericKey);
  }
}

function removePairIDFromIndex(index, key, pairID) {
  const numericKey = toInt(key, 0);
  const numericPairID = toInt(pairID, 0);
  const pairIDs = index.get(numericKey);
  if (!pairIDs) {
    return;
  }
  const nextPairIDs = pairIDs.filter((entry) => entry !== numericPairID);
  if (nextPairIDs.length > 0) {
    index.set(numericKey, nextPairIDs);
  } else {
    index.delete(numericKey);
  }
}

function hasSameRandomPopulation(previous, pair) {
  return previous && previous.kind === "random" && pair.kind === "random" &&
    previous.randomProfileKey && previous.randomProfileKey === pair.randomProfileKey &&
    previous.state === pair.state && (pair.state === "active"
      ? previous.source.systemID === pair.source.systemID
      : previous.collapseAtMs === pair.collapseAtMs);
}

function addPairToStateIndex(index, pair, preserveProfile = false) {
  const pairID = toInt(pair && pair.pairID, 0);
  if (pairID <= 0) {
    return;
  }
  index.pairIDs.add(pairID);
  const profileKey = String(pair.randomProfileKey || "");
  if (pair.kind === "random" && profileKey) {
    const profilePairs = index.randomPairsByProfile.get(profileKey) || new Map();
    profilePairs.set(pairID, pair);
    index.randomPairsByProfile.set(profileKey, profilePairs);
    if (!preserveProfile) {
      index.profileRevisions.set(profileKey, ++profileRevisionSequence);
    }
  }
  const sourceSystemID = toInt(pair && pair.source && pair.source.systemID, 0);
  const destinationSystemID = toInt(
    pair && pair.destination && pair.destination.systemID,
    0,
  );
  index.totalPairCount += 1;
  addPairIDToIndex(index.allPairIDsBySystemID, sourceSystemID, pairID);
  if (destinationSystemID !== sourceSystemID) {
    addPairIDToIndex(index.allPairIDsBySystemID, destinationSystemID, pairID);
  }
  for (const endpoint of [pair && pair.source, pair && pair.destination]) {
    const endpointID = toInt(endpoint && endpoint.endpointID, 0);
    if (endpointID > 0) {
      index.pairIDByEndpointID.set(endpointID, pairID);
    }
  }
  if (String(pair && pair.state || "").toLowerCase() !== "active") {
    return;
  }
  index.activePairCount += 1;
  addPairIDToIndex(index.activePairIDsBySystemID, sourceSystemID, pairID);
  if (destinationSystemID !== sourceSystemID) {
    addPairIDToIndex(index.activePairIDsBySystemID, destinationSystemID, pairID);
  }
  for (const endpoint of [pair && pair.source, pair && pair.destination]) {
    if (
      normalizeVisibilityState(
        endpoint && endpoint.visibilityState,
        endpoint && endpoint.discovered === true,
      ) === "visible"
    ) {
      incrementCount(index.visibleEndpointCountBySystemID, endpoint && endpoint.systemID);
    }
  }
}

function removePairFromStateIndex(index, pair, preserveMaintenanceOrder = false, preserveProfile = false) {
  const pairID = toInt(pair && pair.pairID, 0);
  if (pairID <= 0) {
    return;
  }
  if (!preserveMaintenanceOrder) {
    index.pairIDs.delete(pairID);
  }
  const profileKey = String(pair.randomProfileKey || "");
  if (!preserveProfile && pair.kind === "random" && profileKey) {
    const profilePairs = index.randomPairsByProfile.get(profileKey);
    if (profilePairs) {
      profilePairs.delete(pairID);
      if (profilePairs.size === 0) {
        index.randomPairsByProfile.delete(profileKey);
      }
    }
    index.profileRevisions.set(profileKey, ++profileRevisionSequence);
  }
  const sourceSystemID = toInt(pair && pair.source && pair.source.systemID, 0);
  const destinationSystemID = toInt(
    pair && pair.destination && pair.destination.systemID,
    0,
  );
  index.totalPairCount = Math.max(0, index.totalPairCount - 1);
  removePairIDFromIndex(index.allPairIDsBySystemID, sourceSystemID, pairID);
  if (destinationSystemID !== sourceSystemID) {
    removePairIDFromIndex(index.allPairIDsBySystemID, destinationSystemID, pairID);
  }
  for (const endpoint of [pair && pair.source, pair && pair.destination]) {
    const endpointID = toInt(endpoint && endpoint.endpointID, 0);
    if (endpointID > 0 && index.pairIDByEndpointID.get(endpointID) === pairID) {
      index.pairIDByEndpointID.delete(endpointID);
    }
  }
  if (String(pair && pair.state || "").toLowerCase() !== "active") {
    return;
  }
  index.activePairCount = Math.max(0, index.activePairCount - 1);
  removePairIDFromIndex(index.activePairIDsBySystemID, sourceSystemID, pairID);
  if (destinationSystemID !== sourceSystemID) {
    removePairIDFromIndex(index.activePairIDsBySystemID, destinationSystemID, pairID);
  }
  for (const endpoint of [pair && pair.source, pair && pair.destination]) {
    if (
      normalizeVisibilityState(
        endpoint && endpoint.visibilityState,
        endpoint && endpoint.discovered === true,
      ) === "visible"
    ) {
      decrementCount(index.visibleEndpointCountBySystemID, endpoint && endpoint.systemID);
    }
  }
}

function buildStateIndex(state = {}) {
  const pairIDByEndpointID = new Map();
  const activePairIDsBySystemID = new Map();
  const allPairIDsBySystemID = new Map();
  const visibleEndpointCountBySystemID = new Map();
  const index = {
    activePairCount: 0,
    activePairIDsBySystemID,
    allPairIDsBySystemID,
    pairIDs: new Set(),
    pairIDByEndpointID,
    polarizationCharacterIDs: new Set(Object.keys(state.polarizationByCharacter || {})),
    profileRevisions: new Map(),
    randomPairsByProfile: new Map(),
    totalPairCount: 0,
    visibleEndpointCountBySystemID,
  };
  for (const pair of Object.values(state.pairsByID || {})) {
    addPairToStateIndex(index, pair);
  }
  return index;
}

function getStateIndex() {
  if (!cacheIndex) {
    cacheIndex = buildStateIndex(loadState());
  }
  return cacheIndex;
}

function listPairsForSystem(systemID, options = {}) {
  const numericSystemID = toInt(systemID, 0);
  if (numericSystemID <= 0) {
    return [];
  }
  const state = loadState();
  const index = getStateIndex();
  const pairIDs = options.includeCollapsed === true
    ? index.allPairIDsBySystemID.get(numericSystemID)
    : index.activePairIDsBySystemID.get(numericSystemID);
  return (pairIDs || [])
    .map((pairID) => state.pairsByID[String(pairID)])
    .filter(Boolean)
    .map((pair) => options.clone === false ? pair : cloneRuntimeState({
      pairsByID: { [String(pair.pairID)]: pair },
    }).pairsByID[String(pair.pairID)]);
}

function getPairByEndpointID(endpointID, options = {}) {
  const numericEndpointID = toInt(endpointID, 0);
  if (numericEndpointID <= 0) {
    return null;
  }
  const pairID = getStateIndex().pairIDByEndpointID.get(numericEndpointID);
  const pair = pairID > 0
    ? loadState().pairsByID[String(pairID)]
    : null;
  if (!pair) {
    return null;
  }
  return options.clone === false
    ? pair
    : cloneRuntimeState({ pairsByID: { [String(pairID)]: pair } }).pairsByID[String(pairID)];
}

function getVisibleEndpointCountsBySystem() {
  return new Map(getStateIndex().visibleEndpointCountBySystemID);
}

function getIndexStats() {
  const index = getStateIndex();
  return {
    activePairCount: index.activePairCount,
    totalPairCount: index.totalPairCount,
    endpointCount: index.pairIDByEndpointID.size,
    activeSystemCount: index.activePairIDsBySystemID.size,
  };
}

function createMaintenanceCursors() {
  const index = getStateIndex();
  return {
    pairs: index.pairIDs.values(),
    pairCount: index.pairIDs.size,
    polarizations: index.polarizationCharacterIDs.values(),
    polarizationCount: index.polarizationCharacterIDs.size,
  };
}

function getRandomProfileRevision(profileKey) {
  return getStateIndex().profileRevisions.get(profileKey) || 0;
}

function createRandomProfilePopulationCursor(profileKey) {
  const index = getStateIndex();
  const pairs = index.randomPairsByProfile.get(profileKey);
  return {
    pairs: pairs ? pairs.values() : [][Symbol.iterator](),
    pairCount: pairs ? pairs.size : 0,
    revision: index.profileRevisions.get(profileKey) || 0,
  };
}

function normalizeStaticSlot(slotKey, slotState = {}) {
  const normalizedKey = String(slotKey || slotState.slotKey || "").trim();
  return {
    slotKey: normalizedKey,
    systemID: toInt(slotState.systemID, 0),
    generation: Math.max(0, toInt(slotState.generation, 0)),
    activePairID: Math.max(0, toInt(slotState.activePairID, 0)),
    nextRespawnAtMs: Math.max(0, toInt(slotState.nextRespawnAtMs, 0)),
  };
}

function normalizePolarizations(endpoints = {}) {
  const normalized = {};
  for (const [endpointKey, record] of Object.entries(endpoints || {})) {
    const endpointID = Math.max(0, toInt(endpointKey, 0));
    const endAtMs = Math.max(0, toInt(record && record.endAtMs, 0));
    const durationSeconds = Math.max(0, toInt(record && record.durationSeconds, 0));
    if (endpointID > 0 && endAtMs > 0 && durationSeconds > 0) {
      normalized[String(endpointID)] = { endAtMs, durationSeconds };
    }
  }
  return normalized;
}

function createRowTransaction(state, index) {
  const pairWrites = new Map();
  const pairRemoves = new Set();
  const slotWrites = new Map();
  const slotDrafts = new Map();
  const slotRemoves = new Set();
  const polarizationWrites = new Map();
  const polarizationDrafts = new Map();
  const polarizationRemoves = new Set();
  const scalarWrites = new Map();

  function getPairByID(pairID) {
    const key = String(Math.max(0, toInt(pairID, 0)));
    if (pairRemoves.has(key)) {
      return null;
    }
    if (!pairWrites.has(key)) {
      const current = state.pairsByID && state.pairsByID[key];
      if (!current) {
        return null;
      }
      pairWrites.set(key, cloneRuntimeState({
        pairsByID: { [key]: current },
      }).pairsByID[key]);
    }
    return pairWrites.get(key);
  }

  function getPairByEndpoint(endpointID) {
    const numericEndpointID = Math.max(0, toInt(endpointID, 0));
    for (const pair of pairWrites.values()) {
      if (
        toInt(pair && pair.source && pair.source.endpointID, 0) === numericEndpointID ||
        toInt(pair && pair.destination && pair.destination.endpointID, 0) === numericEndpointID
      ) {
        return pair;
      }
    }
    return getPairByID(index.pairIDByEndpointID.get(numericEndpointID));
  }

  return {
    getPairByEndpoint,
    getPairByID,
    getPolarizations(characterID) {
      const key = String(Math.max(0, toInt(characterID, 0)));
      if (polarizationRemoves.has(key)) {
        return {};
      }
      if (polarizationWrites.has(key)) {
        return polarizationWrites.get(key);
      }
      if (!polarizationDrafts.has(key)) {
        polarizationDrafts.set(key, cloneValue(
          state.polarizationByCharacter && state.polarizationByCharacter[key] || {},
        ));
      }
      return polarizationDrafts.get(key);
    },
    getScalar(key) {
      return scalarWrites.has(key) ? scalarWrites.get(key) : state[key];
    },
    getStaticSlot(slotKey) {
      const key = String(slotKey || "").trim();
      if (!key || slotRemoves.has(key)) {
        return null;
      }
      if (slotWrites.has(key)) {
        return slotWrites.get(key);
      }
      if (!slotDrafts.has(key)) {
        const current = state.staticSlotsByKey && state.staticSlotsByKey[key];
        if (!current) {
          return null;
        }
        slotDrafts.set(key, { ...current });
      }
      return slotDrafts.get(key);
    },
    removePair(pairID) {
      const key = String(Math.max(0, toInt(pairID, 0)));
      pairWrites.delete(key);
      pairRemoves.add(key);
    },
    removePolarizations(characterID) {
      const key = String(Math.max(0, toInt(characterID, 0)));
      polarizationWrites.delete(key);
      polarizationDrafts.delete(key);
      polarizationRemoves.add(key);
    },
    removeStaticSlot(slotKey) {
      const key = String(slotKey || "").trim();
      slotWrites.delete(key);
      slotDrafts.delete(key);
      slotRemoves.add(key);
    },
    setPair(pair) {
      const key = String(Math.max(0, toInt(pair && pair.pairID, 0)));
      if (key === "0") {
        throw new Error("Cannot persist a wormhole pair without a positive pairID");
      }
      pairRemoves.delete(key);
      pairWrites.set(key, pair);
    },
    setPolarizations(characterID, endpoints) {
      const key = String(Math.max(0, toInt(characterID, 0)));
      if (key === "0") {
        throw new Error("Cannot persist wormhole polarization without a characterID");
      }
      polarizationRemoves.delete(key);
      polarizationWrites.set(key, endpoints || {});
    },
    setScalar(key, value) {
      scalarWrites.set(String(key || ""), value);
    },
    setStaticSlot(slotKey, slotState) {
      const key = String(slotKey || slotState && slotState.slotKey || "").trim();
      if (!key) {
        throw new Error("Cannot persist a wormhole static slot without a slotKey");
      }
      slotRemoves.delete(key);
      slotWrites.set(key, slotState);
    },
    _changes: {
      pairRemoves,
      pairWrites,
      polarizationRemoves,
      polarizationWrites,
      scalarWrites,
      slotRemoves,
      slotWrites,
    },
  };
}

function applyRowTransaction(transaction) {
  const state = loadState();
  const index = getStateIndex();
  const changes = transaction._changes;
  // Preserve repaired high-water marks even if cleanup removes the rows
  // that established them before another pair is allocated.
  for (const key of pendingAllocatorRepairs) {
    if (!changes.scalarWrites.has(key)) {
      changes.scalarWrites.set(key, state[key]);
    }
  }
  const normalizedPairWrites = new Map(
    [...changes.pairWrites.entries()].map(([key, pair]) => [key, normalizePair(pair)]),
  );
  const normalizedSlotWrites = new Map(
    [...changes.slotWrites.entries()].map(([key, slot]) => [key, normalizeStaticSlot(key, slot)]),
  );
  const normalizedPolarizationWrites = new Map(
    [...changes.polarizationWrites.entries()].map(([key, endpoints]) => [
      key,
      normalizePolarizations(endpoints),
    ]),
  );
  const writes = [];
  const removes = [];

  for (const [key, pair] of normalizedPairWrites) {
    writes.push([`/pairsByID/${key}`, pair]);
  }
  for (const key of changes.pairRemoves) {
    removes.push(`/pairsByID/${key}`);
  }
  for (const [key, slot] of normalizedSlotWrites) {
    writes.push([`/staticSlotsByKey/${key}`, slot]);
  }
  for (const key of changes.slotRemoves) {
    removes.push(`/staticSlotsByKey/${key}`);
  }
  for (const [key, endpoints] of normalizedPolarizationWrites) {
    writes.push([`/polarizationByCharacter/${key}`, endpoints]);
  }
  for (const key of changes.polarizationRemoves) {
    removes.push(`/polarizationByCharacter/${key}`);
  }
  for (const [key, value] of changes.scalarWrites) {
    if (key) {
      writes.push([`/${key}`, value]);
    }
  }

  for (const [pathSuffix, value] of writes) {
    const result = database.write(WORMHOLE_RUNTIME_TABLE, pathSuffix, value);
    if (!result || result.success !== true) {
      clearRuntimeCache();
      return false;
    }
  }
  for (const pathSuffix of removes) {
    const result = database.remove(WORMHOLE_RUNTIME_TABLE, pathSuffix);
    if (!(result && (result.success === true || result.errorMsg === "ENTRY_NOT_FOUND"))) {
      clearRuntimeCache();
      return false;
    }
  }

  for (const key of changes.pairRemoves) {
    const previous = state.pairsByID[key];
    if (previous) {
      removePairFromStateIndex(index, previous);
      delete state.pairsByID[key];
    }
  }
  for (const [key, pair] of normalizedPairWrites) {
    const previous = state.pairsByID[key];
    const preserveProfile = hasSameRandomPopulation(previous, pair);
    if (previous) {
      removePairFromStateIndex(index, previous, true, preserveProfile);
    }
    state.pairsByID[key] = pair;
    addPairToStateIndex(index, pair, preserveProfile);
  }
  for (const key of changes.slotRemoves) {
    delete state.staticSlotsByKey[key];
  }
  for (const [key, slot] of normalizedSlotWrites) {
    state.staticSlotsByKey[key] = slot;
  }
  for (const key of changes.polarizationRemoves) {
    delete state.polarizationByCharacter[key];
    index.polarizationCharacterIDs.delete(key);
  }
  for (const [key, endpoints] of normalizedPolarizationWrites) {
    state.polarizationByCharacter[key] = endpoints;
    index.polarizationCharacterIDs.add(key);
  }
  for (const [key, value] of changes.scalarWrites) {
    if (key) {
      state[key] = value;
    }
  }
  pendingAllocatorRepairs = [];
  return true;
}

function mutateStateRows(mutator) {
  const state = loadState();
  const transaction = createRowTransaction(state, getStateIndex());
  const data = mutator(transaction);
  const success = applyRowTransaction(transaction);
  return { success, data };
}

function loadState() {
  if (cache) {
    return cache;
  }

  const result = database.read(WORMHOLE_RUNTIME_TABLE, "/");
  const persistedState = result && result.success ? result.data : {};
  cache = normalizeState(persistedState);
  pendingAllocatorRepairs = ["nextPairSequence", "nextEndpointSequence"].filter((key) =>
    cache[key] > Math.max(1, toInt(persistedState[key], 1)));
  return cache;
}

function getStateView() {
  return loadState();
}

// pairsByID / staticSlotsByKey / polarizationByCharacter are wrapper groups
// (one stored row per entity); everything else is a flat scalar row.
const WORMHOLE_GROUP_KEYS = ["pairsByID", "staticSlotsByKey", "polarizationByCharacter"];

// Persist a state by diffing it against the live persisted table and writing
// ONLY the rows that changed (per group entity + per scalar) instead of a
// whole-table root write, so the gameStore dirty-row flush re-serializes only
// the changed rows. The on-disk/cache result is identical to the old root write.
function applyPersistedDiff(nextState) {
  const currentResult = database.read(WORMHOLE_RUNTIME_TABLE, "/");
  const current =
    currentResult && currentResult.success && currentResult.data && typeof currentResult.data === "object"
      ? currentResult.data
      : {};

  const writes = [];
  const removes = [];
  const groupKeys = new Set(WORMHOLE_GROUP_KEYS);

  for (const group of WORMHOLE_GROUP_KEYS) {
    const prevGroup = current[group] && typeof current[group] === "object" ? current[group] : {};
    const nextGroup = nextState[group] && typeof nextState[group] === "object" ? nextState[group] : {};
    for (const entityID of Object.keys(nextGroup)) {
      if (!isDeepStrictEqual(prevGroup[entityID], nextGroup[entityID])) {
        writes.push([`/${group}/${entityID}`, nextGroup[entityID]]);
      }
    }
    for (const entityID of Object.keys(prevGroup)) {
      if (!Object.prototype.hasOwnProperty.call(nextGroup, entityID)) {
        removes.push(`/${group}/${entityID}`);
      }
    }
    // Ensure the group container exists even when empty, so the skeleton row
    // matches what a whole-table write would have produced.
    if (
      Object.prototype.hasOwnProperty.call(nextState, group) &&
      !(current[group] && typeof current[group] === "object") &&
      writes.every(([suffix]) => !suffix.startsWith(`/${group}/`))
    ) {
      writes.push([`/${group}`, {}]);
    }
  }

  for (const key of Object.keys(nextState)) {
    if (groupKeys.has(key)) {
      continue;
    }
    if (!isDeepStrictEqual(current[key], nextState[key])) {
      writes.push([`/${key}`, nextState[key]]);
    }
  }
  for (const key of Object.keys(current)) {
    if (groupKeys.has(key)) {
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(nextState, key)) {
      removes.push(`/${key}`);
    }
  }

  let success = true;
  for (const [pathSuffix, value] of writes) {
    const result = database.write(WORMHOLE_RUNTIME_TABLE, pathSuffix, value);
    if (!result || result.success !== true) {
      success = false;
    }
  }
  for (const pathSuffix of removes) {
    const result = database.remove(WORMHOLE_RUNTIME_TABLE, pathSuffix);
    if (!(result && (result.success === true || result.errorMsg === "ENTRY_NOT_FOUND"))) {
      success = false;
    }
  }
  return { changed: writes.length + removes.length, success };
}

function writeState(state, options = {}) {
  const normalized = options.normalize === false
    ? state
    : normalizeState(state);
  // force is now moot — an unchanged diff simply writes nothing (the persisted
  // result is identical either way); kept in the signature for callers.
  const result = applyPersistedDiff(normalized);
  if (!result.success) {
    return false;
  }
  cache = normalized;
  cacheIndex = buildStateIndex(cache);
  pendingAllocatorRepairs = [];
  return true;
}

function mutateState(mutator) {
  const current = cloneRuntimeState(loadState());
  const next = mutator(current) || current;
  const success = writeState(next, {
    force: true,
    normalize: false,
  });
  return {
    success,
    data: success ? cache : loadState(),
  };
}

function getStateSnapshot() {
  return cloneRuntimeState(loadState());
}

function clearRuntimeCache() {
  cache = null;
  cacheIndex = null;
  pendingAllocatorRepairs = [];
}

module.exports = {
  WORMHOLE_RUNTIME_TABLE,
  WORMHOLE_RUNTIME_VERSION,
  clearRuntimeCache,
  createMaintenanceCursors,
  createRandomProfilePopulationCursor,
  getIndexStats,
  getPairByEndpointID,
  getRandomProfileRevision,
  getStateSnapshot,
  getStateView,
  getVisibleEndpointCountsBySystem,
  listPairsForSystem,
  loadState,
  mutateState,
  mutateStateRows,
  writeState,
};
