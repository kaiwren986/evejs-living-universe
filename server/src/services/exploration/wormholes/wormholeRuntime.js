"use strict";

const {
  cloneVector,
} = require("../../../common/vector");

const {
  toFiniteNumber,
} = require("../../../common/numbers");

const crypto = require("crypto");
const path = require("path");

const config = require(path.join(__dirname, "../../../config"));
const log = require(path.join(__dirname, "../../../utils/logger"));
const worldData = require(path.join(__dirname, "../../../space/worldData"));
const {
  getCodeTypeRecord,
  getK162TypeRecord,
  getSystemAuthority,
  getSystemClassID,
  listCodeTypes,
  listCandidateSystemIDsForClass,
  listSystems,
  listStaticSlotsForSystem,
  listWanderingProfiles,
  listWanderingProfilesForSourceClass,
  selectCandidateSystemIDForClass,
} = require("./wormholeAuthority");
const {
  buildWormholePresentationSnapshot,
} = require("./wormholePresentation");
const {
  buildAnchorRelativeSignaturePlacement,
} = require(path.join(__dirname, "../signatures/signaturePlacement"));
const {
  getStateView,
  getStateSnapshot,
  createMaintenanceCursors,
  getIndexStats,
  createRandomProfilePopulationCursor,
  getRandomProfileRevision,
  listPairsForSystem: listIndexedPairsForSystem,
  mutateState,
  mutateStateRows,
} = require("./wormholeRuntimeState");
const wormholeEnvironmentRuntime = require("./wormholeEnvironmentRuntime");
const {
  isAddBalls2BootstrapScope,
} = require(path.join(
  __dirname,
  "../../../space/destiny/bootstrap/staticBootstrap",
));
const targetIdRuntime = require(path.join(
  __dirname,
  "../signatures/targetIdRuntime",
));

const WORMHOLE_GROUP_ID = 988;
const WORMHOLE_CATEGORY_ID = 2;
const K162_CODE = "K162";
const POLARIZATION_DURATION_SECONDS = 5 * 60;
const WORMHOLE_ENDPOINT_ID_BASE = 9_920_000_000_000;
const WORMHOLE_TICK_INTERVAL_MS = 5000;
const WORMHOLE_MAINTENANCE_DEFAULT_INTERVAL_MS = 1000;
const WORMHOLE_MAINTENANCE_DEFAULT_MAX_ITEMS_PER_SLICE = 24;
const WORMHOLE_MAINTENANCE_DEFAULT_MAX_SLICE_MS = 8;
const WORMHOLE_PREPARED_JUMP_RESERVATION_MS = 5000;
const WORMHOLE_PASSIVE_K162_REVEAL_THRESHOLD_MS = 15 * 60 * 60 * 1000;
const WORMHOLE_PASSIVE_K162_CHECK_INTERVAL_MS = 5 * 60 * 1000;
const WORMHOLE_PASSIVE_K162_FORCE_REVEAL_MS = 30 * 60 * 1000;
const WORMHOLE_MASS_REGEN_PERIOD_MS = 24 * 60 * 60 * 1000;
const WORMHOLE_MAX_SHIP_MASS_SMALL = 1;
const WORMHOLE_MAX_SHIP_MASS_MEDIUM = 2;
const WORMHOLE_MAX_SHIP_MASS_LARGE = 3;
const WORMHOLE_MAX_SHIP_MASS_VERY_LARGE = 4;
const WORMHOLE_MIN_POST_JUMP_SURFACE_DISTANCE_METERS = 2500;
const WORMHOLE_FRESH_POST_JUMP_DEVIATION_METERS = 2000;
const WORMHOLE_CRITICAL_POST_JUMP_DEVIATION_METERS = 5000;
const TRIGLAVIAN_FACTION_ID = 500026;
const WORMHOLE_POST_JUMP_DISTANCE_ANCHORS = Object.freeze([
  Object.freeze({ shipMass: 1_280_000, surfaceDistance: 5500 }),
  Object.freeze({ shipMass: 14_300_000, surfaceDistance: 6900 }),
  Object.freeze({ shipMass: 101_000_000, surfaceDistance: 8800 }),
  Object.freeze({ shipMass: 250_000_000, surfaceDistance: 10100 }),
  Object.freeze({ shipMass: 1_120_000_000, surfaceDistance: 13500 }),
  Object.freeze({ shipMass: 1_240_000_000, surfaceDistance: 13800 }),
]);
const signatureStateChangeListeners = new Set();
const systemNameCache = new Map();
const sceneAnchorsCache = new Map();
const pairIndexCache = new WeakMap();
let lifecycleMaintenanceCycle = null;
let lifecycleSchedulerHandle = null;
let lifecycleSchedulerRunning = false;
let staticMaintenanceItemsCache = null;
const preparedJumpReservationsByPairID = new Map();
let preparedJumpReservationSequence = 1;

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function getPairState(pair) {
  return String((pair && pair.state) || "").toLowerCase();
}

function addIndexedPair(indexMap, systemID, pair) {
  const numericSystemID = toInt(systemID, 0);
  if (numericSystemID <= 0 || !pair) {
    return;
  }
  const existing = indexMap.get(numericSystemID);
  if (existing) {
    existing.push(pair);
  } else {
    indexMap.set(numericSystemID, [pair]);
  }
}

function buildPairIndex(table = {}) {
  const activePairsBySystemID = new Map();
  const allPairsBySystemID = new Map();
  let activePairCount = 0;
  let totalPairCount = 0;
  for (const pair of Object.values(table.pairsByID || {})) {
    totalPairCount += 1;
    const sourceSystemID = toInt(pair && pair.source && pair.source.systemID, 0);
    const destinationSystemID = toInt(pair && pair.destination && pair.destination.systemID, 0);
    addIndexedPair(allPairsBySystemID, sourceSystemID, pair);
    if (destinationSystemID !== sourceSystemID) {
      addIndexedPair(allPairsBySystemID, destinationSystemID, pair);
    }
    if (getPairState(pair) !== "active") {
      continue;
    }
    activePairCount += 1;
    addIndexedPair(activePairsBySystemID, sourceSystemID, pair);
    if (destinationSystemID !== sourceSystemID) {
      addIndexedPair(activePairsBySystemID, destinationSystemID, pair);
    }
  }
  return {
    activePairsBySystemID,
    allPairsBySystemID,
    activePairCount,
    totalPairCount,
  };
}

function getPairIndex(table = {}) {
  if (!table || typeof table !== "object") {
    return buildPairIndex({});
  }
  const cached = pairIndexCache.get(table);
  if (cached) {
    return cached;
  }
  const index = buildPairIndex(table);
  pairIndexCache.set(table, index);
  return index;
}

function notifySignatureStateChanged(systemIDs = []) {
  const normalizedSystemIDs = [...new Set(
    (Array.isArray(systemIDs) ? systemIDs : [systemIDs])
      .map((systemID) => toInt(systemID, 0))
      .filter((systemID) => systemID > 0),
  )];
  if (normalizedSystemIDs.length <= 0) {
    return;
  }
  for (const listener of signatureStateChangeListeners) {
    try {
      listener(normalizedSystemIDs);
    } catch (error) {
      log.warn(
        `[Wormholes] Signature state change listener failed: ${
          error && error.message ? error.message : error
        }`,
      );
    }
  }
}

function registerSignatureStateChangeListener(listener) {
  if (typeof listener === "function") {
    signatureStateChangeListeners.add(listener);
  }
}

function unregisterSignatureStateChangeListener(listener) {
  if (typeof listener === "function") {
    signatureStateChangeListeners.delete(listener);
  }
}

function collectVisibleSignatureSystemIDsForPair(pair, options = {}) {
  const includeHiddenDestination = options.includeHiddenDestination === true;
  if (!pair) {
    return [];
  }
  const systems = new Set();
  if (isEndpointVisible(pair.source)) {
    systems.add(toInt(pair.source && pair.source.systemID, 0));
  }
  if (
    isEndpointVisible(pair.destination) ||
    (includeHiddenDestination && toInt(pair.destination && pair.destination.systemID, 0) > 0)
  ) {
    systems.add(toInt(pair.destination && pair.destination.systemID, 0));
  }
  return [...systems].filter((systemID) => systemID > 0);
}

function scaleVector(vector, scalar) {
  return {
    x: vector.x * scalar,
    y: vector.y * scalar,
    z: vector.z * scalar,
  };
}

function addVectors(left, right) {
  return {
    x: left.x + right.x,
    y: left.y + right.y,
    z: left.z + right.z,
  };
}

function subtractVectors(left, right) {
  return {
    x: left.x - right.x,
    y: left.y - right.y,
    z: left.z - right.z,
  };
}

function magnitude(vector) {
  return Math.sqrt((vector.x ** 2) + (vector.y ** 2) + (vector.z ** 2));
}

function normalizeVector(vector, fallback = { x: 1, y: 0, z: 0 }) {
  const numeric = cloneVector(vector, fallback);
  const length = magnitude(numeric);
  if (!Number.isFinite(length) || length <= 0) {
    return cloneVector(fallback);
  }
  return scaleVector(numeric, 1 / length);
}

function hashSeed(seed) {
  const digest = crypto.createHash("sha1").update(String(seed || "")).digest();
  return digest.readUInt32LE(0);
}

function getSystemName(systemID) {
  const numericSystemID = toInt(systemID, 0);
  if (numericSystemID > 0 && systemNameCache.has(numericSystemID)) {
    return systemNameCache.get(numericSystemID);
  }
  const system = worldData.getSolarSystemByID(systemID);
  if (system && system.solarSystemName) {
    const systemName = system.solarSystemName;
    if (numericSystemID > 0) {
      systemNameCache.set(numericSystemID, systemName);
    }
    return systemName;
  }
  const authority = getSystemAuthority(systemID);
  const systemName = authority && authority.solarSystemName
    ? authority.solarSystemName
    : `System ${systemID}`;
  if (numericSystemID > 0) {
    systemNameCache.set(numericSystemID, systemName);
  }
  return systemName;
}

function getSceneAnchors(systemID) {
  const numericSystemID = toInt(systemID, 0);
  if (numericSystemID > 0 && sceneAnchorsCache.has(numericSystemID)) {
    return sceneAnchorsCache.get(numericSystemID);
  }
  const celestials = worldData.getCelestialsForSystem(systemID)
    .filter((entry) => entry && entry.itemID)
    .filter((entry) => entry.kind !== "sun" && toInt(entry.groupID, 0) !== 6);
  const stargates = worldData.getStargatesForSystem(systemID);
  const stations = worldData.getStationsForSystem(systemID);
  const fallback = worldData.getCelestialsForSystem(systemID).filter(Boolean);
  const anchors = [...celestials, ...stargates, ...stations];
  const resolvedAnchors = anchors.length > 0 ? anchors : fallback;
  if (numericSystemID > 0) {
    sceneAnchorsCache.set(numericSystemID, resolvedAnchors);
  }
  return resolvedAnchors;
}

function buildEndpointPose(systemID, seed) {
  const anchors = getSceneAnchors(systemID);
  const fallbackDirection = { x: 1, y: 0, z: 0 };
  if (anchors.length <= 0) {
    return {
      position: { x: 1_000_000_000, y: 0, z: 0 },
      direction: fallbackDirection,
    };
  }
  const placement = buildAnchorRelativeSignaturePlacement(
    anchors.map((anchor) => ({
      itemID: toInt(anchor && anchor.itemID, 0),
      position: cloneVector(anchor && anchor.position),
    })),
    `wormhole:${toInt(systemID, 0)}:${String(seed || "")}`,
    {
      fallbackAnchorItemID: toInt(systemID, 0),
      baseDistanceAu: 4,
      distanceJitterAu: 0.4,
      verticalJitterAu: 0.16,
    },
  );
  return {
    position: cloneVector(placement && placement.position, { x: 1_000_000_000, y: 0, z: 0 }),
    direction: normalizeVector(placement && placement.direction, fallbackDirection),
    anchorItemID: toInt(placement && placement.anchorItemID, 0) || null,
    anchorDistanceMeters: toFiniteNumber(placement && placement.distanceMeters, 0),
    anchorDistanceAu: toFiniteNumber(placement && placement.distanceAu, 0),
  };
}

function resolveDestinationSystemID(sourceSystemID, targetClassID, seed) {
  return selectCandidateSystemIDForClass(targetClassID, hashSeed(seed), sourceSystemID);
}

function buildEndpointRecord(systemID, typeRecord, options = {}) {
  const authority = getSystemAuthority(systemID);
  const pose = buildEndpointPose(systemID, options.seed);
  const typeName =
    String(typeRecord && (typeRecord.typeName || typeRecord.name) || "").trim() ||
    `Wormhole ${options.code || ""}`.trim();
  const endpointID = toInt(options.endpointID, 0);
  return {
    endpointID,
    systemID,
    typeID: toInt(typeRecord && typeRecord.typeID, 0),
    targetID:
      String(options.targetID || "").trim().toUpperCase() ||
      (endpointID > 0
        ? targetIdRuntime.encodeTargetID("wormhole", systemID, endpointID)
        : null),
    code: String(options.code || "").trim().toUpperCase() || null,
    discovered: options.discovered === true,
    visibilityState: options.discovered === true ? "visible" : "hidden",
    wormholeClassID: getSystemClassID(systemID, authority && authority.securityStatus),
    nebulaID: authority ? toInt(authority.nebulaID, 0) : 0,
    position: pose.position,
    direction: pose.direction,
    radius: Math.max(1, toFiniteNumber(typeRecord && typeRecord.radius, 3000)),
    graphicID: toInt(typeRecord && typeRecord.graphicID, 0),
    typeName,
    slotKey: String(options.slotKey || "").trim() || null,
  };
}

function allocateEndpointID(table) {
  const nextSequence = Math.max(1, toInt(table.nextEndpointSequence, 1));
  table.nextEndpointSequence = nextSequence + 1;
  return WORMHOLE_ENDPOINT_ID_BASE + nextSequence;
}

function allocatePairID(table) {
  const nextSequence = Math.max(1, toInt(table.nextPairSequence, 1));
  table.nextPairSequence = nextSequence + 1;
  return nextSequence;
}

function getPairByEndpoint(table, endpointID) {
  const numericEndpointID = toInt(endpointID, 0);
  for (const pair of Object.values(table.pairsByID || {})) {
    if (
      toInt(pair && pair.source && pair.source.endpointID, 0) === numericEndpointID ||
      toInt(pair && pair.destination && pair.destination.endpointID, 0) === numericEndpointID
    ) {
      return pair;
    }
  }
  return null;
}

function getPairRole(pair, endpointID) {
  const numericEndpointID = toInt(endpointID, 0);
  if (toInt(pair && pair.source && pair.source.endpointID, 0) === numericEndpointID) {
    return "source";
  }
  if (toInt(pair && pair.destination && pair.destination.endpointID, 0) === numericEndpointID) {
    return "destination";
  }
  return null;
}

function getOtherRole(role) {
  return role === "source" ? "destination" : "source";
}

function getEndpoint(pair, role) {
  return role === "source" ? pair.source : pair.destination;
}

function setEndpointVisibilityState(endpoint, state) {
  if (!endpoint) {
    return;
  }
  const normalizedState = String(state || "").trim().toLowerCase();
  endpoint.visibilityState =
    normalizedState === "visible" ||
    normalizedState === "hidden" ||
    normalizedState === "invisible"
      ? normalizedState
      : (endpoint.discovered === true ? "visible" : "hidden");
  endpoint.discovered = endpoint.visibilityState === "visible";
}

function isEndpointVisible(endpoint) {
  return !!endpoint && String(endpoint.visibilityState || "").toLowerCase() === "visible";
}

function getPairRemainingLifetimeMs(pair, nowMs) {
  const expiresAtMs = Math.max(0, toInt(pair && pair.expiresAtMs, 0));
  return Math.max(0, expiresAtMs - Math.max(0, toInt(nowMs, 0)));
}

function projectRemainingMass(pair, nowMs) {
  const totalMass = Math.max(0, toFiniteNumber(pair && pair.totalMass, 0));
  const remainingMass = Math.max(0, toFiniteNumber(pair && pair.remainingMass, 0));
  const massRegeneration = Math.max(0, toFiniteNumber(pair && pair.massRegeneration, 0));
  if (totalMass <= 0 || massRegeneration <= 0 || remainingMass >= totalMass) {
    return remainingMass;
  }
  const lastMassStateAtMs = Math.max(
    0,
    toInt(pair && pair.lastMassStateAtMs, pair && pair.createdAtMs),
  );
  const elapsedMs = Math.max(0, toInt(nowMs, 0) - lastMassStateAtMs);
  if (elapsedMs <= 0) {
    return remainingMass;
  }
  const regenerationAmount =
    ((elapsedMs / WORMHOLE_MASS_REGEN_PERIOD_MS) * massRegeneration) +
    Math.max(0, toFiniteNumber(pair && pair.massRegenRemainder, 0));
  if (regenerationAmount <= 0) {
    return remainingMass;
  }
  return Math.min(totalMass, remainingMass + Math.floor(regenerationAmount));
}

function applyMassRegeneration(pair, nowMs) {
  if (!pair) {
    return;
  }
  const totalMass = Math.max(0, toFiniteNumber(pair.totalMass, 0));
  const remainingMass = Math.max(0, toFiniteNumber(pair.remainingMass, 0));
  const massRegeneration = Math.max(0, toFiniteNumber(pair.massRegeneration, 0));
  if (totalMass <= 0 || massRegeneration <= 0 || remainingMass >= totalMass) {
    if (Math.max(0, toFiniteNumber(pair.massRegenRemainder, 0)) > 0) {
      pair.massRegenRemainder = 0;
    }
    return;
  }
  const lastMassStateAtMs = Math.max(0, toInt(pair.lastMassStateAtMs, pair.createdAtMs));
  const elapsedMs = Math.max(0, toInt(nowMs, 0) - lastMassStateAtMs);
  if (elapsedMs <= 0) {
    return;
  }
  const regenerationAmount =
    ((elapsedMs / WORMHOLE_MASS_REGEN_PERIOD_MS) * massRegeneration) +
    Math.max(0, toFiniteNumber(pair.massRegenRemainder, 0));
  const regeneratedMass = Math.max(0, Math.floor(regenerationAmount));
  pair.remainingMass = Math.min(totalMass, remainingMass + regeneratedMass);
  pair.massRegenRemainder =
    pair.remainingMass >= totalMass
      ? 0
      : Math.max(0, regenerationAmount - regeneratedMass);
  pair.lastMassStateAtMs = Math.max(0, toInt(nowMs, 0));
}

function maybePassivelyRevealDestination(pair, nowMs) {
  if (!pair || !pair.destination) {
    return false;
  }
  if (String(pair.destination.visibilityState || "").toLowerCase() !== "invisible") {
    return false;
  }
  const remainingLifetimeMs = getPairRemainingLifetimeMs(pair, nowMs);
  if (remainingLifetimeMs <= 0 || remainingLifetimeMs > WORMHOLE_PASSIVE_K162_REVEAL_THRESHOLD_MS) {
    return false;
  }
  if (remainingLifetimeMs <= WORMHOLE_PASSIVE_K162_FORCE_REVEAL_MS) {
    setEndpointVisibilityState(pair.destination, "visible");
    pair.lastPassiveRevealCheckAtMs = Math.max(0, toInt(nowMs, 0));
    return true;
  }

  const lastCheckAtMs = Math.max(0, toInt(pair.lastPassiveRevealCheckAtMs, 0));
  if (lastCheckAtMs > 0 && (toInt(nowMs, 0) - lastCheckAtMs) < WORMHOLE_PASSIVE_K162_CHECK_INTERVAL_MS) {
    return false;
  }

  const checkIndex = Math.floor(
    Math.max(0, toInt(nowMs, 0) - (
      Math.max(0, toInt(pair.createdAtMs, 0)) ||
      toInt(nowMs, 0)
    )) / WORMHOLE_PASSIVE_K162_CHECK_INTERVAL_MS,
  );
  const revealProgress = 1 - (
    remainingLifetimeMs / WORMHOLE_PASSIVE_K162_REVEAL_THRESHOLD_MS
  );
  const revealChance = Math.max(0.15, Math.min(0.95, 0.15 + (revealProgress * 0.75)));
  const roll = hashSeed(`${pair.pairID}:passive-reveal:${checkIndex}`) / 0xffffffff;
  pair.lastPassiveRevealCheckAtMs = Math.max(0, toInt(nowMs, 0));
  if (roll <= revealChance) {
    setEndpointVisibilityState(pair.destination, "visible");
    return true;
  }
  return false;
}

function pairNeedsMassRegeneration(pair, nowMs) {
  if (!pair) {
    return false;
  }
  const totalMass = Math.max(0, toFiniteNumber(pair.totalMass, 0));
  const remainingMass = Math.max(0, toFiniteNumber(pair.remainingMass, 0));
  const massRegeneration = Math.max(0, toFiniteNumber(pair.massRegeneration, 0));
  if (totalMass <= 0 || massRegeneration <= 0 || remainingMass >= totalMass) {
    return false;
  }
  const lastMassStateAtMs = Math.max(0, toInt(pair.lastMassStateAtMs, pair.createdAtMs));
  return Math.max(0, toInt(nowMs, 0) - lastMassStateAtMs) > 0;
}

function pairNeedsPassiveRevealCheck(pair, nowMs) {
  if (!pair || !pair.destination) {
    return false;
  }
  if (String(pair.destination.visibilityState || "").toLowerCase() !== "invisible") {
    return false;
  }
  const remainingLifetimeMs = getPairRemainingLifetimeMs(pair, nowMs);
  if (remainingLifetimeMs <= 0 || remainingLifetimeMs > WORMHOLE_PASSIVE_K162_REVEAL_THRESHOLD_MS) {
    return false;
  }
  if (remainingLifetimeMs <= WORMHOLE_PASSIVE_K162_FORCE_REVEAL_MS) {
    return true;
  }
  const lastCheckAtMs = Math.max(0, toInt(pair.lastPassiveRevealCheckAtMs, 0));
  return !(lastCheckAtMs > 0 && (toInt(nowMs, 0) - lastCheckAtMs) < WORMHOLE_PASSIVE_K162_CHECK_INTERVAL_MS);
}

function pairNeedsStateAdvance(pair, nowMs) {
  return pairNeedsMassRegeneration(pair, nowMs) ||
    pairNeedsPassiveRevealCheck(pair, nowMs);
}

function advancePairState(pair, nowMs) {
  if (!pair || String(pair.state || "").toLowerCase() !== "active") {
    return;
  }
  applyMassRegeneration(pair, nowMs);
  maybePassivelyRevealDestination(pair, nowMs);
}

function interpolateAnchoredValue(anchors, value) {
  const numericValue = Math.max(0, toFiniteNumber(value, 0));
  if (!Array.isArray(anchors) || anchors.length <= 0) {
    return 0;
  }
  if (numericValue <= anchors[0].shipMass) {
    return anchors[0].surfaceDistance;
  }
  for (let index = 1; index < anchors.length; index += 1) {
    const left = anchors[index - 1];
    const right = anchors[index];
    if (numericValue <= right.shipMass) {
      const leftMass = Math.log(Math.max(1, left.shipMass));
      const rightMass = Math.log(Math.max(1, right.shipMass));
      const currentMass = Math.log(Math.max(1, numericValue));
      const progress =
        rightMass <= leftMass
          ? 0
          : ((currentMass - leftMass) / (rightMass - leftMass));
      return left.surfaceDistance +
        ((right.surfaceDistance - left.surfaceDistance) * progress);
    }
  }
  return anchors[anchors.length - 1].surfaceDistance;
}

function resolveWormholeAge(pair, nowMs) {
  const createdAtMs = Math.max(0, toInt(pair && pair.createdAtMs, 0));
  const expiresAtMs = Math.max(0, toInt(pair && pair.expiresAtMs, 0));
  const state = String(pair && pair.state || "").toLowerCase();
  if (state && state !== "active" && Math.max(0, toInt(pair && pair.collapseAtMs, 0)) > 0) {
    return 4;
  }
  if (!createdAtMs || !expiresAtMs || expiresAtMs <= createdAtMs) {
    return 0;
  }
  const remainingMs = Math.max(0, expiresAtMs - Math.max(0, toInt(nowMs, 0)));
  if (remainingMs <= (60 * 60 * 1000)) {
    return 3;
  }
  if (remainingMs <= (4 * 60 * 60 * 1000)) {
    return 2;
  }
  if (remainingMs <= (24 * 60 * 60 * 1000)) {
    return 1;
  }
  return 0;
}

function resolveWormholeSize(pair, nowMs = Date.now()) {
  const totalMass = Math.max(0, toFiniteNumber(pair && pair.totalMass, 0));
  const remainingMass = Math.max(0, projectRemainingMass(pair, nowMs));
  if (totalMass <= 0) {
    return 1.0;
  }
  const remainingRatio = Math.max(0, Math.min(1, remainingMass / totalMass));
  if (remainingRatio < 0.5) {
    return 0.4;
  }
  if (remainingRatio < 1) {
    return 0.7;
  }
  return 1.0;
}

function isTriglavianSystem(systemID) {
  const system = worldData.getSolarSystemByID(systemID);
  return toInt(system && system.factionID, 0) === TRIGLAVIAN_FACTION_ID;
}

function resolveMaxShipMassCategory(maxJumpMass) {
  const numericMass = Math.max(0, toFiniteNumber(maxJumpMass, 0));
  if (numericMass <= 20_000_000) {
    return WORMHOLE_MAX_SHIP_MASS_SMALL;
  }
  if (numericMass <= 300_000_000) {
    return WORMHOLE_MAX_SHIP_MASS_MEDIUM;
  }
  if (numericMass <= 1_500_000_000) {
    return WORMHOLE_MAX_SHIP_MASS_LARGE;
  }
  return WORMHOLE_MAX_SHIP_MASS_VERY_LARGE;
}

function buildEntityFromPair(pair, role, nowMs = Date.now()) {
  const endpoint = getEndpoint(pair, role);
  const otherEndpoint = getEndpoint(pair, getOtherRole(role));
  const projectedRemainingMass = Math.max(0, Math.round(projectRemainingMass(pair, nowMs)));
  return {
    kind: "wormhole",
    itemID: endpoint.endpointID,
    typeID: endpoint.typeID,
    groupID: WORMHOLE_GROUP_ID,
    categoryID: WORMHOLE_CATEGORY_ID,
    // Grid-local rather than broadcast system-wide. "publicgrid" (not "bubble")
    // is the right scope for a warp-to object: bubble visibility is a discrete
    // bubbleID membership test, which a warping pilot only satisfies once the
    // landing handoff completes, so the wormhole popped in AFTER warp ended.
    // publicgrid matches on the visibility cluster OR proximity, so it
    // materializes during deceleration like stargates and empire scenery, which
    // use this same scope.
    staticVisibilityScope: "publicgrid",
    itemName:
      endpoint.code === K162_CODE
        ? "Wormhole K162"
        : `Wormhole ${endpoint.code || endpoint.typeID}`,
    ownerID: 1,
    radius: Math.max(1, toFiniteNumber(endpoint.radius, 3000)),
    position: cloneVector(endpoint.position),
    velocity: { x: 0, y: 0, z: 0 },
    graphicID: toInt(endpoint.graphicID, 0),
    wormholePairID: pair.pairID,
    wormholeRole: role,
    destinationSystemID: toInt(otherEndpoint.systemID, 0),
    otherSolarSystemClass: toInt(otherEndpoint.wormholeClassID, 0),
    nebulaType: toInt(otherEndpoint.nebulaID, 0),
    wormholeAge: resolveWormholeAge(pair, nowMs),
    wormholeSize: resolveWormholeSize(pair, nowMs),
    maxShipJumpMass: resolveMaxShipMassCategory(pair.maxJumpMass),
    isDestTriglavian: isTriglavianSystem(toInt(otherEndpoint && otherEndpoint.systemID, 0)),
    maxJumpMass: Math.max(0, toInt(pair.maxJumpMass, 0)),
    remainingMass: projectedRemainingMass,
    totalMass: Math.max(0, toInt(pair.totalMass, 0)),
  };
}

function createStaticPair(table, systemID, slot, nowMs) {
  const sourceSystemID = toInt(systemID, 0);
  const generationSeed = `${slot.slotKey}:${Math.max(0, toInt(
    table.staticSlotsByKey[slot.slotKey] && table.staticSlotsByKey[slot.slotKey].generation,
    0,
  )) + 1}`;
  const destinationSystemID = resolveDestinationSystemID(
    sourceSystemID,
    slot.targetClassID,
    generationSeed,
  );
  if (!destinationSystemID) {
    return null;
  }

  const sourceType = getCodeTypeRecord(slot.code || slot.typeID);
  const k162Type = getK162TypeRecord();
  if (!sourceType || !k162Type) {
    return null;
  }

  const pairID = allocatePairID(table);
  const sourceEndpointID = allocateEndpointID(table);
  const destinationEndpointID = allocateEndpointID(table);
  const lifetimeMinutes = Math.max(
    1,
    Math.round(Math.max(1, toInt(slot.lifetimeMinutes, sourceType.lifetimeMinutes || 960)) *
      Math.max(0.0001, toFiniteNumber(config.wormholeLifetimeScale, 1))),
  );
  const slotState = table.staticSlotsByKey[slot.slotKey] || {
    slotKey: slot.slotKey,
    systemID: sourceSystemID,
    generation: 0,
    activePairID: 0,
    nextRespawnAtMs: 0,
  };
  slotState.generation = Math.max(0, toInt(slotState.generation, 0)) + 1;
  slotState.activePairID = pairID;
  slotState.nextRespawnAtMs = 0;
  table.staticSlotsByKey[slot.slotKey] = slotState;

  const pair = {
    pairID,
    kind: "static",
    state: "active",
    createdAtMs: nowMs,
    expiresAtMs: nowMs + lifetimeMinutes * 60 * 1000,
    collapseAtMs: 0,
    collapseReason: null,
    totalMass: Math.max(0, toInt(slot.maxStableMass, sourceType.maxStableMass || 0)),
    remainingMass: Math.max(0, toInt(slot.maxStableMass, sourceType.maxStableMass || 0)),
    massRegeneration: Math.max(0, toInt(slot.massRegeneration, sourceType.massRegeneration || 0)),
    maxJumpMass: Math.max(0, toInt(slot.maxJumpMass, sourceType.maxJumpMass || 0)),
    lifetimeMinutes,
    lastMassStateAtMs: nowMs,
    massRegenRemainder: 0,
    lastPassiveRevealCheckAtMs: 0,
    staticSlotKey: slot.slotKey,
    source: buildEndpointRecord(sourceSystemID, sourceType, {
      endpointID: sourceEndpointID,
      code: slot.code,
      discovered: true,
      seed: `${pairID}:source`,
      slotKey: slot.slotKey,
    }),
    destination: buildEndpointRecord(destinationSystemID, k162Type, {
      endpointID: destinationEndpointID,
      code: K162_CODE,
      discovered: false,
      seed: `${pairID}:destination`,
    }),
  };

  table.pairsByID[String(pairID)] = pair;
  return pair;
}

function selectSourceSystemForRandomProfile(
  table,
  profile,
  seed,
  options = {},
) {
  const sourceClassID = toInt(profile && profile.sourceClassID, 0);
  const candidates = listCandidateSystemIDsForClass(sourceClassID, { clone: false });
  if (candidates.length <= 0) {
    return { systemID: 0, availableIndex: -1 };
  }
  const profileKey = String(profile && profile.profileKey || "").trim();
  const occupiedSystemIDs = options.occupiedSystemIDs instanceof Set
    ? options.occupiedSystemIDs
    : new Set(
      Object.values(table.pairsByID || {})
        .filter((pair) => String(pair && pair.kind || "").toLowerCase() === "random")
        .filter((pair) => String(pair && pair.state || "").toLowerCase() === "active")
        .filter((pair) => String(pair && pair.randomProfileKey || "").trim() === profileKey)
        .map((pair) => toInt(pair && pair.source && pair.source.systemID, 0))
        .filter((systemID) => systemID > 0),
    );
  const availableSystemIDs = Array.isArray(options.availableSystemIDs)
    ? options.availableSystemIDs
    : candidates.filter((systemID) => !occupiedSystemIDs.has(systemID));
  const selectionPool = availableSystemIDs.length > 0 ? availableSystemIDs : candidates;
  const index = hashSeed(`${profileKey}:${seed}:source-system`) % selectionPool.length;
  return {
    systemID: selectionPool[index],
    availableIndex: availableSystemIDs.length > 0 ? index : -1,
  };
}

function createRandomPairFromProfile(table, profile, nowMs, options = {}) {
  const sourceType = getCodeTypeRecord(profile && (profile.code || profile.typeID));
  const k162Type = getK162TypeRecord();
  if (!sourceType || !k162Type) {
    return null;
  }
  const profileKey = String(profile && profile.profileKey || "").trim();
  const source = selectSourceSystemForRandomProfile(
    table,
    profile,
    options.seed || `${profileKey}:${nowMs}:${table.nextPairSequence}`,
    options,
  );
  const sourceSystemID = source.systemID;
  if (!sourceSystemID) {
    return null;
  }
  const destinationClassID =
    toInt(profile && profile.destinationClassID, 0) ||
    toInt(sourceType.targetClassID, 0);
  const destinationSystemID = resolveDestinationSystemID(
    sourceSystemID,
    destinationClassID,
    `${profileKey}:${sourceSystemID}:${nowMs}:${sourceType.code}`,
  );
  if (!destinationSystemID) {
    return null;
  }
  const pairID = allocatePairID(table);
  const lifetimeMinutes = Math.max(
    1,
    Math.round(Math.max(1, toInt(
      profile && profile.lifetimeMinutes,
      sourceType.lifetimeMinutes || 960,
    )) * Math.max(0.0001, toFiniteNumber(config.wormholeLifetimeScale, 1))),
  );
  const totalMass = Math.max(
    0,
    toInt(profile && profile.maxStableMass, sourceType.maxStableMass || 0),
  );
  const pair = {
    pairID,
    kind: "random",
    randomProfileKey: profileKey || null,
    state: "active",
    createdAtMs: nowMs,
    expiresAtMs: nowMs + lifetimeMinutes * 60 * 1000,
    collapseAtMs: 0,
    collapseReason: null,
    totalMass,
    remainingMass: totalMass,
    massRegeneration: Math.max(
      0,
      toInt(profile && profile.massRegeneration, sourceType.massRegeneration || 0),
    ),
    maxJumpMass: Math.max(
      0,
      toInt(profile && profile.maxJumpMass, sourceType.maxJumpMass || 0),
    ),
    lifetimeMinutes,
    lastMassStateAtMs: nowMs,
    massRegenRemainder: 0,
    lastPassiveRevealCheckAtMs: 0,
    staticSlotKey: null,
    source: buildEndpointRecord(sourceSystemID, sourceType, {
      endpointID: allocateEndpointID(table),
      code: sourceType.code,
      discovered: true,
      seed: `${pairID}:source`,
    }),
    destination: buildEndpointRecord(destinationSystemID, k162Type, {
      endpointID: allocateEndpointID(table),
      code: K162_CODE,
      discovered: false,
      seed: `${pairID}:destination`,
    }),
  };
  table.pairsByID[String(pairID)] = pair;
  if (Array.isArray(options.availableSystemIDs) && source.availableIndex >= 0) {
    const last = options.availableSystemIDs.pop();
    if (source.availableIndex < options.availableSystemIDs.length) {
      options.availableSystemIDs[source.availableIndex] = last;
    }
  }
  if (options.occupiedSystemIDs instanceof Set && sourceSystemID > 0) {
    options.occupiedSystemIDs.add(sourceSystemID);
  }
  return pair;
}

function createRandomPair(table, systemID, nowMs, options = {}) {
  const sourceSystemID = toInt(systemID, 0);
  const codeTypes = listCodeTypes();
  if (codeTypes.length <= 0) {
    return null;
  }
  const targetClassChoices = [7, 8, 9, 1, 2, 3, 4, 5, 6, 12, 13];
  const classSeed = hashSeed(`${sourceSystemID}:${nowMs}:random-class`);
  const targetClassID = targetClassChoices[classSeed % targetClassChoices.length];
  const matchingTypes = codeTypes.filter((record) => toInt(record.targetClassID, 0) === targetClassID);
  const sourceType = matchingTypes.length > 0
    ? matchingTypes[hashSeed(`${sourceSystemID}:${nowMs}:random-type`) % matchingTypes.length]
    : codeTypes[hashSeed(`${sourceSystemID}:${nowMs}:fallback-type`) % codeTypes.length];
  const destinationSystemID = resolveDestinationSystemID(
    sourceSystemID,
    toInt(sourceType.targetClassID, targetClassID),
    `${sourceSystemID}:${nowMs}:${sourceType.code}`,
  );
  const k162Type = getK162TypeRecord();
  if (!sourceType || !destinationSystemID || !k162Type) {
    return null;
  }
  const pairID = allocatePairID(table);
  const lifetimeMinutes = Math.max(
    1,
    Math.round(Math.max(1, toInt(sourceType.lifetimeMinutes, 960)) *
      Math.max(0.0001, toFiniteNumber(config.wormholeLifetimeScale, 1))),
  );
  const pair = {
    pairID,
    kind: "random",
    randomProfileKey: String(options.profileKey || "").trim() || null,
    state: "active",
    createdAtMs: nowMs,
    expiresAtMs: nowMs + lifetimeMinutes * 60 * 1000,
    collapseAtMs: 0,
    collapseReason: null,
    totalMass: Math.max(0, toInt(sourceType.maxStableMass, 0)),
    remainingMass: Math.max(0, toInt(sourceType.maxStableMass, 0)),
    massRegeneration: Math.max(0, toInt(sourceType.massRegeneration, 0)),
    maxJumpMass: Math.max(0, toInt(sourceType.maxJumpMass, 0)),
    lifetimeMinutes,
    lastMassStateAtMs: nowMs,
    massRegenRemainder: 0,
    lastPassiveRevealCheckAtMs: 0,
    staticSlotKey: null,
    source: buildEndpointRecord(sourceSystemID, sourceType, {
      endpointID: allocateEndpointID(table),
      code: sourceType.code,
      discovered: true,
      seed: `${pairID}:source`,
    }),
    destination: buildEndpointRecord(destinationSystemID, k162Type, {
      endpointID: allocateEndpointID(table),
      code: K162_CODE,
      discovered: false,
      seed: `${pairID}:destination`,
    }),
  };
  table.pairsByID[String(pairID)] = pair;
  return pair;
}

function collapsePairInTable(table, pair, nowMs, reason = "collapsed") {
  if (!pair || String(pair.state || "").toLowerCase() !== "active") {
    return pair;
  }
  pair.state = "collapsed";
  pair.collapseAtMs = nowMs;
  pair.collapseReason = String(reason || "collapsed");
  if (pair.staticSlotKey) {
    const slotState = table.staticSlotsByKey[pair.staticSlotKey] || {
      slotKey: pair.staticSlotKey,
      systemID: toInt(pair.source && pair.source.systemID, 0),
      generation: 0,
      activePairID: 0,
      nextRespawnAtMs: 0,
    };
    slotState.activePairID = 0;
    slotState.nextRespawnAtMs =
      nowMs + Math.max(0, toInt(config.wormholeStaticRespawnDelaySeconds, 60)) * 1000;
    table.staticSlotsByKey[pair.staticSlotKey] = slotState;
  }
  return pair;
}

function prunePreparedJumpReservations(nowMs = Date.now()) {
  for (const [pairID, reservations] of preparedJumpReservationsByPairID) {
    for (const [token, expiresAtMs] of reservations) {
      if (toInt(expiresAtMs, 0) <= nowMs) {
        reservations.delete(token);
      }
    }
    if (reservations.size <= 0) {
      preparedJumpReservationsByPairID.delete(pairID);
    }
  }
}

function reservePreparedJump(pairID, options = {}) {
  const numericPairID = toInt(pairID, 0);
  if (numericPairID <= 0) {
    return null;
  }
  const nowMs = Math.max(0, toInt(options.nowMs, Date.now()));
  prunePreparedJumpReservations(nowMs);
  const token = `${numericPairID}:${preparedJumpReservationSequence}`;
  preparedJumpReservationSequence += 1;
  const expiresAtMs = Math.max(
    nowMs + 1,
    toInt(options.expiresAtMs, nowMs + WORMHOLE_PREPARED_JUMP_RESERVATION_MS),
  );
  const reservations = preparedJumpReservationsByPairID.get(numericPairID) || new Map();
  reservations.set(token, expiresAtMs);
  preparedJumpReservationsByPairID.set(numericPairID, reservations);
  return token;
}

function releasePreparedJump(pairID, token) {
  const numericPairID = toInt(pairID, 0);
  const reservations = preparedJumpReservationsByPairID.get(numericPairID);
  if (!reservations || !reservations.delete(String(token || ""))) {
    return false;
  }
  if (reservations.size <= 0) {
    preparedJumpReservationsByPairID.delete(numericPairID);
  }
  return true;
}

function isPairReservedForPreparedJump(pairID, nowMs = Date.now()) {
  prunePreparedJumpReservations(nowMs);
  const reservations = preparedJumpReservationsByPairID.get(toInt(pairID, 0));
  return Boolean(reservations && reservations.size > 0);
}

function createStaticPairInRowTransaction(transaction, systemID, slot, nowMs) {
  const slotKey = String(slot && slot.slotKey || "").trim();
  const generationTable = {
    nextPairSequence: Math.max(1, toInt(transaction.getScalar("nextPairSequence"), 1)),
    nextEndpointSequence: Math.max(
      1,
      toInt(transaction.getScalar("nextEndpointSequence"), 1),
    ),
    pairsByID: {},
    staticSlotsByKey: {},
  };
  const existingSlot = transaction.getStaticSlot(slotKey);
  if (existingSlot) {
    generationTable.staticSlotsByKey[slotKey] = { ...existingSlot };
  }
  const pair = createStaticPair(generationTable, systemID, slot, nowMs);
  if (!pair) {
    return null;
  }
  transaction.setScalar("nextPairSequence", generationTable.nextPairSequence);
  transaction.setScalar("nextEndpointSequence", generationTable.nextEndpointSequence);
  transaction.setStaticSlot(slotKey, generationTable.staticSlotsByKey[slotKey]);
  transaction.setPair(pair);
  return pair;
}

function createRandomPairInRowTransaction(
  transaction,
  profile,
  nowMs,
  options = {},
) {
  const generationTable = {
    nextPairSequence: Math.max(1, toInt(transaction.getScalar("nextPairSequence"), 1)),
    nextEndpointSequence: Math.max(
      1,
      toInt(transaction.getScalar("nextEndpointSequence"), 1),
    ),
    pairsByID: {},
    staticSlotsByKey: {},
  };
  const pair = createRandomPairFromProfile(generationTable, profile, nowMs, options);
  if (!pair) {
    return null;
  }
  transaction.setScalar("nextPairSequence", generationTable.nextPairSequence);
  transaction.setScalar("nextEndpointSequence", generationTable.nextEndpointSequence);
  transaction.setPair(pair);
  return pair;
}

function collapsePairInRowTransaction(transaction, pair, nowMs, reason = "collapsed") {
  if (!pair || String(pair.state || "").toLowerCase() !== "active") {
    return pair;
  }
  pair.state = "collapsed";
  pair.collapseAtMs = nowMs;
  pair.collapseReason = String(reason || "collapsed");
  if (pair.staticSlotKey) {
    const slotState = transaction.getStaticSlot(pair.staticSlotKey) || {
      slotKey: pair.staticSlotKey,
      systemID: toInt(pair.source && pair.source.systemID, 0),
      generation: 0,
      activePairID: 0,
      nextRespawnAtMs: 0,
    };
    slotState.activePairID = 0;
    slotState.nextRespawnAtMs =
      nowMs + Math.max(0, toInt(config.wormholeStaticRespawnDelaySeconds, 60)) * 1000;
    transaction.setStaticSlot(pair.staticSlotKey, slotState);
  }
  transaction.setPair(pair);
  return pair;
}

function prunePolarizations(table, nowMs) {
  for (const [characterKey, endpoints] of Object.entries(table.polarizationByCharacter || {})) {
    for (const [endpointKey, record] of Object.entries(endpoints || {})) {
      if (toInt(record && record.endAtMs, 0) <= nowMs) {
        delete endpoints[endpointKey];
      }
    }
    if (Object.keys(endpoints || {}).length <= 0) {
      delete table.polarizationByCharacter[characterKey];
    }
  }
}

function ensureStaticPairsInTable(table, systemID, nowMs) {
  const staticSlots = listStaticSlotsForSystem(systemID);
  const createdPairs = [];
  for (const slot of staticSlots) {
    const slotKey = String(slot.slotKey || "").trim();
    if (!slotKey) {
      continue;
    }
    const slotState = table.staticSlotsByKey[slotKey] || {
      slotKey,
      systemID: toInt(systemID, 0),
      generation: 0,
      activePairID: 0,
      nextRespawnAtMs: 0,
    };
    const activePair = table.pairsByID[String(slotState.activePairID)] || null;
    if (activePair && String(activePair.state || "").toLowerCase() === "active") {
      table.staticSlotsByKey[slotKey] = slotState;
      continue;
    }
    if (toInt(slotState.nextRespawnAtMs, 0) > nowMs) {
      table.staticSlotsByKey[slotKey] = slotState;
      continue;
    }
    table.staticSlotsByKey[slotKey] = slotState;
    const createdPair = createStaticPair(table, systemID, slot, nowMs);
    if (createdPair) {
      createdPairs.push(createdPair);
    }
  }
  return createdPairs;
}

function resolveDesiredRandomProfileCount(profile) {
  const authoredCount = Math.max(0, toInt(profile && profile.estimatedUniverseCount, 0));
  const scale = Math.max(0, toFiniteNumber(config.wormholeWanderingCountScale, 1));
  return Math.max(0, Math.round(authoredCount * scale));
}

function countEffectiveRandomPairsForProfile(table, profileKey, nowMs) {
  const normalizedProfileKey = String(profileKey || "").trim();
  if (!normalizedProfileKey) {
    return 0;
  }
  const respawnDelayMs = Math.max(
    0,
    toInt(config.wormholeWanderingRespawnDelaySeconds, 60),
  ) * 1000;
  let count = 0;
  for (const pair of Object.values(table.pairsByID || {})) {
    if (String(pair && pair.kind || "").toLowerCase() !== "random") {
      continue;
    }
    if (String(pair && pair.randomProfileKey || "").trim() !== normalizedProfileKey) {
      continue;
    }
    if (String(pair && pair.state || "").toLowerCase() === "active") {
      count += 1;
      continue;
    }
    if (respawnDelayMs <= 0) {
      continue;
    }
    const collapseAtMs = Math.max(0, toInt(pair && pair.collapseAtMs, 0));
    if (collapseAtMs > 0 && (collapseAtMs + respawnDelayMs) > nowMs) {
      count += 1;
    }
  }
  return count;
}

function collectRandomProfileStats(table, nowMs) {
  const countsByProfileKey = new Map();
  const occupiedSystemIDsByProfileKey = new Map();
  const respawnDelayMs = Math.max(
    0,
    toInt(config.wormholeWanderingRespawnDelaySeconds, 60),
  ) * 1000;

  for (const pair of Object.values(table.pairsByID || {})) {
    if (String(pair && pair.kind || "").toLowerCase() !== "random") {
      continue;
    }
    const profileKey = String(pair && pair.randomProfileKey || "").trim();
    if (!profileKey) {
      continue;
    }
    const state = String(pair && pair.state || "").toLowerCase();
    const collapseAtMs = Math.max(0, toInt(pair && pair.collapseAtMs, 0));
    const countsAsPresent = state === "active" || (
      respawnDelayMs > 0 &&
      collapseAtMs > 0 &&
      (collapseAtMs + respawnDelayMs) > nowMs
    );
    if (countsAsPresent) {
      countsByProfileKey.set(profileKey, (countsByProfileKey.get(profileKey) || 0) + 1);
    }
    if (state === "active") {
      const sourceSystemID = toInt(pair && pair.source && pair.source.systemID, 0);
      if (sourceSystemID > 0) {
        const occupiedSystemIDs = occupiedSystemIDsByProfileKey.get(profileKey) || new Set();
        occupiedSystemIDs.add(sourceSystemID);
        occupiedSystemIDsByProfileKey.set(profileKey, occupiedSystemIDs);
      }
    }
  }

  return {
    countsByProfileKey,
    occupiedSystemIDsByProfileKey,
  };
}

function ensureRandomPairsInTable(table, nowMs) {
  const createdPairs = [];
  const {
    countsByProfileKey,
    occupiedSystemIDsByProfileKey,
  } = collectRandomProfileStats(table, nowMs);
  for (const profile of listWanderingProfiles()) {
    const desiredCount = resolveDesiredRandomProfileCount(profile);
    if (desiredCount <= 0) {
      continue;
    }
    const profileKey = String(profile && profile.profileKey || "").trim();
    const currentCount = countsByProfileKey.get(profileKey) || 0;
    const deficit = Math.max(0, desiredCount - currentCount);
    if (deficit <= 0) {
      continue;
    }
    const occupiedSystemIDs = occupiedSystemIDsByProfileKey.get(profileKey) || new Set();
    const availableSystemIDs = listCandidateSystemIDsForClass(profile.sourceClassID, { clone: false })
      .filter((systemID) => !occupiedSystemIDs.has(systemID));
    for (let index = 0; index < deficit; index += 1) {
      const createdPair = createRandomPairFromProfile(
        table,
        profile,
        nowMs + createdPairs.length + index,
        {
          occupiedSystemIDs,
          availableSystemIDs,
        },
      );
      if (createdPair) {
        createdPairs.push(createdPair);
        countsByProfileKey.set(profileKey, (countsByProfileKey.get(profileKey) || 0) + 1);
      }
    }
  }
  return createdPairs;
}

function seedUniverseStaticsInTable(table, nowMs) {
  const createdPairs = [];
  for (const system of listSystems()) {
    if (!system || !Array.isArray(system.staticSlots) || system.staticSlots.length <= 0) {
      continue;
    }
    createdPairs.push(
      ...ensureStaticPairsInTable(table, toInt(system.solarSystemID, 0), nowMs),
    );
  }
  createdPairs.push(...ensureRandomPairsInTable(table, nowMs));
  if (toInt(table.universeSeededAtMs, 0) <= 0) {
    table.universeSeededAtMs = nowMs;
  }
  return createdPairs;
}

function collectPairsForSystem(table, systemID, options = {}) {
  const numericSystemID = toInt(systemID, 0);
  const includeCollapsed = options.includeCollapsed === true;
  if (numericSystemID > 0) {
    if (table === getStateView()) {
      return listIndexedPairsForSystem(numericSystemID, {
        clone: false,
        includeCollapsed,
      });
    }
    const index = getPairIndex(table);
    const indexedPairs = includeCollapsed
      ? index.allPairsBySystemID.get(numericSystemID)
      : index.activePairsBySystemID.get(numericSystemID);
    return indexedPairs ? [...indexedPairs] : [];
  }
  const allPairs = Object.values(table.pairsByID || {});
  if (includeCollapsed) {
    return allPairs;
  }
  return allPairs.filter((pair) => getPairState(pair) === "active");
}

function collectVisiblePairsForSystem(table, systemID) {
  const numericSystemID = toInt(systemID, 0);
  return collectPairsForSystem(table, numericSystemID)
    .filter((pair) =>
      (
        toInt(pair.source && pair.source.systemID, 0) === numericSystemID &&
        isEndpointVisible(pair.source)
      ) ||
      (
        toInt(pair.destination && pair.destination.systemID, 0) === numericSystemID &&
        isEndpointVisible(pair.destination)
      ),
    );
}

function syncSceneEntities(scene, nowMs) {
  if (!scene) {
    return;
  }
  const table = getStateView();
  const desiredByID = new Map();
  const desiredSecondarySunEntity = wormholeEnvironmentRuntime.buildSecondarySunEntity(
    scene.systemID,
  );
  if (desiredSecondarySunEntity) {
    desiredByID.set(
      toInt(desiredSecondarySunEntity.itemID, 0),
      desiredSecondarySunEntity,
    );
  }
  const desiredEffectBeaconEntity = wormholeEnvironmentRuntime.buildEffectBeaconEntity(
    scene.systemID,
  );
  if (desiredEffectBeaconEntity) {
    desiredByID.set(
      toInt(desiredEffectBeaconEntity.itemID, 0),
      desiredEffectBeaconEntity,
    );
  }
  for (const pair of collectVisiblePairsForSystem(table, scene.systemID)) {
    if (
      toInt(pair.source && pair.source.systemID, 0) === toInt(scene.systemID, 0) &&
      isEndpointVisible(pair.source)
    ) {
      desiredByID.set(pair.source.endpointID, buildEntityFromPair(pair, "source", nowMs));
    }
    if (
      toInt(pair.destination && pair.destination.systemID, 0) === toInt(scene.systemID, 0) &&
      isEndpointVisible(pair.destination)
    ) {
      desiredByID.set(pair.destination.endpointID, buildEntityFromPair(pair, "destination", nowMs));
    }
  }

  let changed = false;
  const addedGlobalEntities = [];
  for (const entity of [...scene.staticEntities]) {
    if (
      !entity ||
      (
        entity.kind !== "wormhole" &&
        entity.kind !== "secondarySun" &&
        entity.kind !== "effectBeacon"
      )
    ) {
      continue;
    }
    if (!desiredByID.has(toInt(entity.itemID, 0))) {
      scene.removeStaticEntity(entity.itemID, {
        broadcast: true,
      });
      changed = true;
    }
  }

  const updated = [];
  for (const [entityID, desiredEntity] of desiredByID.entries()) {
    const existing = scene.staticEntitiesByID.get(entityID) || null;
    if (!existing) {
      if (scene.addStaticEntity(desiredEntity)) {
        changed = true;
        // Grid-scoped statics (bubble/site/publicgrid) are delivered per-session
        // by visibility reconciliation. Only a genuinely system-wide static may
        // take the AddBalls broadcast below.
        if (
          desiredEntity &&
          !isAddBalls2BootstrapScope(desiredEntity.staticVisibilityScope)
        ) {
          addedGlobalEntities.push(desiredEntity);
        }
      }
      continue;
    }
    const before = JSON.stringify([
      existing.kind,
      existing.wormholeAge,
      existing.wormholeSize,
      existing.nebulaType,
      existing.otherSolarSystemClass,
      existing.maxShipJumpMass,
      existing.remainingMass,
      existing.totalMass,
      existing.typeID,
      existing.position,
      existing.environmentEffectTypeID,
    ]);
    Object.assign(existing, desiredEntity);
    const after = JSON.stringify([
      existing.kind,
      existing.wormholeAge,
      existing.wormholeSize,
      existing.nebulaType,
      existing.otherSolarSystemClass,
      existing.maxShipJumpMass,
      existing.remainingMass,
      existing.totalMass,
      existing.typeID,
      existing.position,
      existing.environmentEffectTypeID,
    ]);
    if (before !== after) {
      updated.push(existing);
    }
  }

  // A global Ball's add is broadcast to every Observer; any other
  // reaches its Grid bubble through the bubble update.
  if (addedGlobalEntities.length > 0) {
    scene.broadcastAddBalls(addedGlobalEntities, null, { nowMs });
  }
  if (updated.length > 0) {
    scene.broadcastSlimItemChanges(updated);
  }
}

function systemNeedsStaticEnsure(table, systemID, nowMs) {
  const numericSystemID = toInt(systemID, 0);
  if (numericSystemID <= 0) {
    return false;
  }
  const staticSlots = listStaticSlotsForSystem(numericSystemID);
  if (!Array.isArray(staticSlots) || staticSlots.length <= 0) {
    return false;
  }
  for (const slot of staticSlots) {
    const slotKey = String(slot && slot.slotKey || "").trim();
    if (!slotKey) {
      continue;
    }
    const slotState = table.staticSlotsByKey && table.staticSlotsByKey[slotKey];
    if (!slotState) {
      return true;
    }
    const activePair = table.pairsByID && table.pairsByID[String(slotState.activePairID)];
    if (activePair && getPairState(activePair) === "active") {
      continue;
    }
    if (toInt(slotState.nextRespawnAtMs, 0) <= nowMs) {
      return true;
    }
  }
  return false;
}

function ensureStaticSlotWithRows(systemID, slot, nowMs) {
  const slotKey = String(slot && slot.slotKey || "").trim();
  if (!slotKey) {
    return null;
  }
  const currentTable = getStateView();
  const slotState = currentTable.staticSlotsByKey && currentTable.staticSlotsByKey[slotKey];
  const activePair = slotState && currentTable.pairsByID &&
    currentTable.pairsByID[String(slotState.activePairID)];
  if (activePair && getPairState(activePair) === "active") {
    return null;
  }
  if (slotState && toInt(slotState.nextRespawnAtMs, 0) > nowMs) {
    return null;
  }
  const result = mutateStateRows((transaction) =>
    createStaticPairInRowTransaction(transaction, systemID, slot, nowMs));
  return result.success === true && result.data ? result.data : null;
}

function ensureSystemStatics(systemID, nowMs = Date.now()) {
  if (config.wormholesEnabled !== true) {
    return {
      success: true,
      data: {
        createdPairs: [],
      },
    };
  }
  const numericSystemID = toInt(systemID, 0);
  const currentTable = getStateView();
  if (!systemNeedsStaticEnsure(currentTable, numericSystemID, nowMs)) {
    return {
      success: true,
      unchanged: true,
      data: {
        createdPairs: [],
      },
    };
  }
  const createdPairs = [];
  let success = true;
  for (const slot of listStaticSlotsForSystem(numericSystemID)) {
    const createdPair = ensureStaticSlotWithRows(numericSystemID, slot, nowMs);
    if (createdPair) {
      createdPairs.push(cloneValue(createdPair));
    }
  }
  if (createdPairs.length > 0) {
    notifySignatureStateChanged(
      createdPairs.flatMap((pair) => collectVisibleSignatureSystemIDsForPair(pair)),
    );
  }
  return {
    success,
    data: {
      createdPairs,
    },
  };
}

function ensureUniverseStatics(nowMs = Date.now()) {
  if (config.wormholesEnabled !== true) {
    return {
      success: true,
      data: {
        createdPairs: [],
      },
    };
  }
  let createdPairs = [];
  const result = mutateState((table) => {
    prunePolarizations(table, nowMs);
    createdPairs = seedUniverseStaticsInTable(table, nowMs).map(cloneValue);
    return table;
  });
  if (result.success === true && createdPairs.length > 0) {
    notifySignatureStateChanged(
      createdPairs.flatMap((pair) => collectVisibleSignatureSystemIDsForPair(pair)),
    );
  }
  return {
    success: result.success,
    data: {
      createdPairs,
    },
  };
}

function handleSceneCreated(scene) {
  if (!scene || config.wormholesEnabled !== true) {
    return;
  }
  const nowMs = Date.now();
  const startedAtMs = Date.now();
  const ensureElapsedMs = 0;
  const syncStartedAtMs = Date.now();
  syncSceneEntities(scene, nowMs);
  const syncElapsedMs = Date.now() - syncStartedAtMs;
  scene._wormholeLastTickAtMs = nowMs;
  const summaryStartedAtMs = Date.now();
  if (log.isVerboseDebugEnabled()) {
    logSceneSummary(scene, nowMs);
  }
  const summaryElapsedMs = Date.now() - summaryStartedAtMs;
  const totalElapsedMs = Date.now() - startedAtMs;
  if (totalElapsedMs >= 500) {
    log.info(
      `[Wormholes] Scene startup profile system=${toInt(scene.systemID, 0)} totalMs=${totalElapsedMs} ensureMs=${ensureElapsedMs} syncMs=${syncElapsedMs} summaryMs=${summaryElapsedMs}`,
    );
  }
}

function maintainPairByID(pairID, nowMs) {
  const current = getStateView().pairsByID[String(toInt(pairID, 0))];
  if (!current || getPairState(current) !== "active") {
    return [];
  }
  const shouldAdvance = pairNeedsStateAdvance(current, nowMs);
  const shouldCollapse =
    toInt(current.expiresAtMs, 0) > 0 &&
    toInt(current.expiresAtMs, 0) <= nowMs;
  const collapseReserved = shouldCollapse &&
    isPairReservedForPreparedJump(pairID, nowMs);
  if (!shouldAdvance && (!shouldCollapse || collapseReserved)) {
    return [];
  }
  const changedSystemIDs = new Set();
  const result = mutateStateRows((transaction) => {
    const pair = transaction.getPairByID(pairID);
    if (!pair || getPairState(pair) !== "active") {
      return null;
    }
    const beforeSourceVisible = isEndpointVisible(pair.source);
    const beforeDestinationVisible = isEndpointVisible(pair.destination);
    const beforeState = getPairState(pair);
    if (pairNeedsStateAdvance(pair, nowMs)) {
      advancePairState(pair, nowMs);
    }
    if (
      toInt(pair.expiresAtMs, 0) > 0 &&
      toInt(pair.expiresAtMs, 0) <= nowMs &&
      !isPairReservedForPreparedJump(pairID, nowMs)
    ) {
      collapsePairInRowTransaction(transaction, pair, nowMs, "expired");
    } else {
      transaction.setPair(pair);
    }
    if (
      beforeState !== getPairState(pair) ||
      beforeSourceVisible !== isEndpointVisible(pair.source) ||
      beforeDestinationVisible !== isEndpointVisible(pair.destination)
    ) {
      for (const systemID of collectVisibleSignatureSystemIDsForPair(pair, {
        includeHiddenDestination: beforeDestinationVisible,
      })) {
        changedSystemIDs.add(systemID);
      }
    }
    return null;
  });
  return result.success === true ? [...changedSystemIDs] : [];
}

function tickScene(scene, nowMs = Date.now()) {
  if (!scene || config.wormholesEnabled !== true) {
    return;
  }
  const lastTickAtMs = Math.max(0, toInt(scene._wormholeLastTickAtMs, 0));
  if (lastTickAtMs > 0 && (nowMs - lastTickAtMs) < WORMHOLE_TICK_INTERVAL_MS) {
    return;
  }
  scene._wormholeLastTickAtMs = nowMs;
  syncSceneEntities(scene, nowMs);
}

function buildStaticMaintenanceItems() {
  if (staticMaintenanceItemsCache) {
    return staticMaintenanceItemsCache;
  }
  const items = [];
  for (const system of listSystems()) {
    const systemID = toInt(system && system.solarSystemID, 0);
    for (const slot of Array.isArray(system && system.staticSlots) ? system.staticSlots : []) {
      if (systemID > 0 && slot && slot.slotKey) {
        items.push({ systemID, slot });
      }
    }
  }
  staticMaintenanceItemsCache = items;
  return staticMaintenanceItemsCache;
}

function createLifecycleMaintenanceCycle(nowMs, options = {}) {
  const cursors = createMaintenanceCursors();
  return {
    epochMs: Math.max(0, toInt(nowMs, Date.now())),
    generationOrdinal: 0,
    phase: "statics",
    staticItems: Array.isArray(options.staticItems)
      ? options.staticItems
      : buildStaticMaintenanceItems(),
    staticCursor: 0,
    pairIDs: cursors.pairs,
    pairCount: cursors.pairCount,
    pairCursor: 0,
    polarizationCharacterIDs: cursors.polarizations,
    polarizationCount: cursors.polarizationCount,
    polarizationCursor: 0,
    profiles: Array.isArray(options.profiles)
      ? options.profiles
      : listWanderingProfiles(),
    profileCursor: 0,
    profilePending: null,
    profilePopulations: new Map(),
  };
}

function removeCollapsedPairByID(pairID) {
  const result = mutateStateRows((transaction) => {
    const pair = transaction.getPairByID(pairID);
    if (!pair || getPairState(pair) === "active") {
      return false;
    }
    transaction.removePair(pairID);
    return true;
  });
  return result.success === true && result.data === true;
}

function getPopulationForCycle(cycle, profile) {
  const profileKey = String(profile && profile.profileKey || "").trim();
  const previous = cycle.profilePopulations.get(profileKey);
  if (previous && previous.revision === getRandomProfileRevision(profileKey)) {
    return previous;
  }
  const population = {
    ...createRandomProfilePopulationCursor(profileKey),
    pairCursor: 0,
    count: 0,
    occupiedSystemIDs: new Set(),
    candidates: null,
    candidateCursor: 0,
    availableSystemIDs: [],
  };
  cycle.profilePopulations.set(profileKey, population);
  return population;
}

function pruneCharacterPolarizationsByID(characterID, nowMs) {
  const result = mutateStateRows((transaction) => {
    const endpoints = transaction.getPolarizations(characterID);
    let changed = false;
    for (const [endpointID, record] of Object.entries(endpoints)) {
      if (toInt(record && record.endAtMs, 0) <= nowMs) {
        delete endpoints[endpointID];
        changed = true;
      }
    }
    if (!changed) {
      return false;
    }
    if (Object.keys(endpoints).length > 0) {
      transaction.setPolarizations(characterID, endpoints);
    } else {
      transaction.removePolarizations(characterID);
    }
    return true;
  });
  return result.success === true && result.data === true;
}

function createRandomPairForCycle(cycle, profile, population) {
  const profileKey = String(profile && profile.profileKey || "").trim();
  if (population.count >= resolveDesiredRandomProfileCount(profile)) {
    return null;
  }
  const occupiedSystemIDs = population.occupiedSystemIDs;
  const createdAtMs = cycle.epochMs + cycle.generationOrdinal;
  cycle.generationOrdinal += 1;
  const result = mutateStateRows((transaction) =>
    createRandomPairInRowTransaction(transaction, profile, createdAtMs, {
      occupiedSystemIDs,
      availableSystemIDs: population.availableSystemIDs,
      seed: `${profileKey}:${cycle.epochMs}:${cycle.generationOrdinal}`,
    }));
  const pair = result.success === true ? result.data : null;
  if (pair) {
    population.count += 1;
    population.revision = getRandomProfileRevision(profileKey);
  }
  return pair;
}

function elapsedSliceMs(startedAt) {
  return Number(process.hrtime.bigint() - startedAt) / 1e6;
}

function runLifecycleMaintenanceSlice(options = {}) {
  const startedAt = process.hrtime.bigint();
  if (config.wormholesEnabled !== true) {
    lifecycleMaintenanceCycle = null;
    return { complete: true, enabled: false, processedItems: 0, elapsedMs: 0 };
  }
  if (options.resetCycle === true) {
    lifecycleMaintenanceCycle = null;
  }
  if (!lifecycleMaintenanceCycle) {
    lifecycleMaintenanceCycle = createLifecycleMaintenanceCycle(
      options.nowMs === undefined ? Date.now() : options.nowMs,
      options,
    );
  }
  const cycle = lifecycleMaintenanceCycle;
  const maxItems = Math.max(
    1,
    toInt(
      options.maxItems,
      config.wormholeMaintenanceMaxItemsPerSlice ||
        WORMHOLE_MAINTENANCE_DEFAULT_MAX_ITEMS_PER_SLICE,
    ),
  );
  const maxSliceMs = Math.max(
    1,
    toFiniteNumber(
      options.maxSliceMs,
      config.wormholeMaintenanceMaxSliceMs ||
        WORMHOLE_MAINTENANCE_DEFAULT_MAX_SLICE_MS,
    ),
  );
  const changedSystemIDs = new Set();
  let processedItems = 0;

  while (processedItems < maxItems && elapsedSliceMs(startedAt) < maxSliceMs) {
    if (cycle.phase === "statics") {
      if (cycle.staticCursor >= cycle.staticItems.length) {
        cycle.phase = "pairs";
        continue;
      }
      const item = cycle.staticItems[cycle.staticCursor];
      cycle.staticCursor += 1;
      processedItems += 1;
      const pair = ensureStaticSlotWithRows(item.systemID, item.slot, cycle.epochMs);
      if (pair) {
        for (const systemID of collectVisibleSignatureSystemIDsForPair(pair)) {
          changedSystemIDs.add(systemID);
        }
      }
      continue;
    }

    if (cycle.phase === "pairs") {
      if (cycle.pairCursor >= cycle.pairCount) {
        cycle.phase = "polarizations";
        continue;
      }
      const item = cycle.pairIDs.next();
      if (item.done) {
        cycle.phase = "polarizations";
        continue;
      }
      const pairID = toInt(item.value, 0);
      cycle.pairCursor += 1;
      processedItems += 1;
      const before = getStateView().pairsByID[String(pairID)];
      if (!before) {
        continue;
      }
      if (getPairState(before) === "active") {
        for (const systemID of maintainPairByID(pairID, cycle.epochMs)) {
          changedSystemIDs.add(systemID);
        }
      }
      const pair = getStateView().pairsByID[String(pairID)];
      if (!pair) {
        continue;
      }
      if (getPairState(pair) !== "active") {
        const randomCooldownMs = Math.max(
          0,
          toInt(config.wormholeWanderingRespawnDelaySeconds, 60),
        ) * 1000;
        const keepForRandomCooldown =
          String(pair.kind || "").toLowerCase() === "random" &&
          toInt(pair.collapseAtMs, 0) > 0 &&
          (toInt(pair.collapseAtMs, 0) + randomCooldownMs) > cycle.epochMs;
        if (!keepForRandomCooldown) {
          removeCollapsedPairByID(pairID);
        }
      }
      continue;
    }

    if (cycle.phase === "polarizations") {
      if (cycle.polarizationCursor >= cycle.polarizationCount) {
        cycle.phase = "profiles";
        continue;
      }
      const item = cycle.polarizationCharacterIDs.next();
      if (item.done) {
        cycle.phase = "profiles";
        continue;
      }
      const characterID = toInt(
        item.value,
        0,
      );
      cycle.polarizationCursor += 1;
      processedItems += 1;
      if (characterID > 0) {
        pruneCharacterPolarizationsByID(characterID, cycle.epochMs);
      }
      continue;
    }

    if (cycle.phase === "profiles") {
      if (cycle.profilePending) {
        const profile = cycle.profilePending.profile;
        const desiredCount = resolveDesiredRandomProfileCount(profile);
        if (desiredCount <= 0) {
          cycle.profilePending = null;
          continue;
        }
        const population = getPopulationForCycle(cycle, profile);
        if (population.pairCursor < population.pairCount) {
          processedItems += 1;
          const item = population.pairs.next();
          population.pairCursor += 1;
          if (item.done) {
            population.pairCursor = population.pairCount;
            continue;
          }
          const pair = item.value;
          if (pair.state === "active") {
            population.count += 1;
            population.occupiedSystemIDs.add(pair.source.systemID);
          } else {
            const respawnDelayMs = Math.max(0,
              toInt(config.wormholeWanderingRespawnDelaySeconds, 60)) * 1000;
            if (respawnDelayMs > 0 && pair.collapseAtMs > 0 &&
              pair.collapseAtMs + respawnDelayMs > cycle.epochMs) {
              population.count += 1;
            }
          }
          continue;
        }
        if (population.count >= desiredCount) {
          cycle.profilePending = null;
          continue;
        }
        if (!population.candidates) {
          population.candidates = listCandidateSystemIDsForClass(profile.sourceClassID, { clone: false });
        }
        if (population.candidateCursor < population.candidates.length) {
          processedItems += 1;
          const candidate = population.candidates[population.candidateCursor];
          population.candidateCursor += 1;
          if (!population.occupiedSystemIDs.has(candidate)) {
            population.availableSystemIDs.push(candidate);
          }
          continue;
        }
        processedItems += 1;
        const pair = createRandomPairForCycle(cycle, profile, population);
        if (pair) {
          for (const systemID of collectVisibleSignatureSystemIDsForPair(pair)) {
            changedSystemIDs.add(systemID);
          }
        } else {
          cycle.profilePending = null;
        }
        continue;
      }
      cycle.profilePending = null;
      if (cycle.profileCursor >= cycle.profiles.length) {
        cycle.phase = "finish";
        continue;
      }
      const profile = cycle.profiles[cycle.profileCursor];
      cycle.profileCursor += 1;
      processedItems += 1;
      const desiredCount = resolveDesiredRandomProfileCount(profile);
      if (desiredCount > 0) {
        cycle.profilePending = { profile };
      }
      continue;
    }

    if (cycle.phase === "finish") {
      if (toInt(getStateView().universeSeededAtMs, 0) <= 0) {
        mutateStateRows((transaction) => {
          transaction.setScalar("universeSeededAtMs", cycle.epochMs);
          return null;
        });
      }
      lifecycleMaintenanceCycle = null;
      notifySignatureStateChanged([...changedSystemIDs]);
      return {
        complete: true,
        enabled: true,
        processedItems,
        elapsedMs: elapsedSliceMs(startedAt),
      };
    }
  }

  notifySignatureStateChanged([...changedSystemIDs]);
  return {
    complete: false,
    enabled: true,
    phase: cycle.phase,
    processedItems,
    elapsedMs: elapsedSliceMs(startedAt),
  };
}

function clearLifecycleSchedulerHandle() {
  if (!lifecycleSchedulerHandle) {
    return;
  }
  if (lifecycleSchedulerHandle.kind === "immediate") {
    clearImmediate(lifecycleSchedulerHandle.handle);
  } else {
    clearTimeout(lifecycleSchedulerHandle.handle);
  }
  lifecycleSchedulerHandle = null;
}

function scheduleLifecycleSchedulerPump(delayMs = 0) {
  if (!lifecycleSchedulerRunning || lifecycleSchedulerHandle) {
    return;
  }
  const callback = () => {
    lifecycleSchedulerHandle = null;
    if (!lifecycleSchedulerRunning) {
      return;
    }
    const result = runLifecycleMaintenanceSlice();
    if (toFiniteNumber(result && result.elapsedMs, 0) >= 25) {
      log.warn(
        `[Wormholes] Lifecycle slice exceeded hard budget: ` +
        `elapsedMs=${toFiniteNumber(result.elapsedMs, 0).toFixed(2)} ` +
        `items=${toInt(result.processedItems, 0)} phase=${String(result.phase || "complete")}`,
      );
    }
    const delay = result.complete === true
      ? Math.max(
          50,
          toInt(
            config.wormholeMaintenanceIntervalMs,
            WORMHOLE_MAINTENANCE_DEFAULT_INTERVAL_MS,
          ),
        )
      : 0;
    scheduleLifecycleSchedulerPump(delay);
  };
  if (delayMs > 0) {
    const handle = setTimeout(callback, delayMs);
    if (handle && typeof handle.unref === "function") {
      handle.unref();
    }
    lifecycleSchedulerHandle = { kind: "timeout", handle };
  } else {
    const handle = setImmediate(callback);
    if (handle && typeof handle.unref === "function") {
      handle.unref();
    }
    lifecycleSchedulerHandle = { kind: "immediate", handle };
  }
}

function startLifecycleScheduler() {
  if (lifecycleSchedulerRunning || config.wormholesEnabled !== true) {
    return false;
  }
  lifecycleSchedulerRunning = true;
  scheduleLifecycleSchedulerPump(0);
  return true;
}

function stopLifecycleScheduler() {
  lifecycleSchedulerRunning = false;
  lifecycleMaintenanceCycle = null;
  clearLifecycleSchedulerHandle();
}

function getLifecycleSchedulerStatus() {
  prunePreparedJumpReservations(Date.now());
  return {
    running: lifecycleSchedulerRunning,
    phase: lifecycleMaintenanceCycle ? lifecycleMaintenanceCycle.phase : "idle",
    scheduled: Boolean(lifecycleSchedulerHandle),
    reservedPairCount: preparedJumpReservationsByPairID.size,
  };
}

function markWarpInitiated(endpointID, nowMs = Date.now()) {
  const numericEndpointID = toInt(endpointID, 0);
  return mutateStateRows((transaction) => {
    const pair = transaction.getPairByEndpoint(numericEndpointID);
    if (!pair || String(pair.state || "").toLowerCase() !== "active") {
      return null;
    }
    advancePairState(pair, nowMs);
    const role = getPairRole(pair, numericEndpointID);
    if (role !== "source") {
      transaction.setPair(pair);
      return null;
    }
    if (String(pair.destination.visibilityState || "").toLowerCase() === "hidden") {
      setEndpointVisibilityState(pair.destination, "invisible");
    }
    transaction.setPair(pair);
    return null;
  });
}

function revealOppositeEndpoint(endpointID, nowMs = Date.now()) {
  const numericEndpointID = toInt(endpointID, 0);
  const changedSystemIDs = new Set();
  const result = mutateStateRows((transaction) => {
    const pair = transaction.getPairByEndpoint(numericEndpointID);
    if (!pair || String(pair.state || "").toLowerCase() !== "active") {
      return null;
    }
    advancePairState(pair, nowMs);
    const role = getPairRole(pair, numericEndpointID);
    if (role !== "source") {
      transaction.setPair(pair);
      return null;
    }
    if (!isEndpointVisible(pair.destination)) {
      setEndpointVisibilityState(pair.destination, "visible");
      changedSystemIDs.add(toInt(pair.destination && pair.destination.systemID, 0));
    }
    transaction.setPair(pair);
    return null;
  });
  notifySignatureStateChanged([...changedSystemIDs]);
  return result;
}

function prepareJump(endpointID, characterID, shipMass, nowMs = Date.now()) {
  const numericEndpointID = toInt(endpointID, 0);
  const numericCharacterID = toInt(characterID, 0);
  const numericShipMass = Math.max(0, toInt(shipMass, 0));
  let prepareJumpResult = null;
  const changedSystemIDs = new Set();
  const result = mutateStateRows((transaction) => {
    const pair = transaction.getPairByEndpoint(numericEndpointID);
    if (!pair) {
      prepareJumpResult = { success: false, errorMsg: "WORMHOLE_NOT_FOUND" };
      return prepareJumpResult;
    }
    advancePairState(pair, nowMs);
    if (String(pair.state || "").toLowerCase() !== "active") {
      prepareJumpResult = { success: false, errorMsg: "WORMHOLE_COLLAPSED" };
      transaction.setPair(pair);
      return prepareJumpResult;
    }
    if (toInt(pair.expiresAtMs, 0) > 0 && toInt(pair.expiresAtMs, 0) <= nowMs) {
      collapsePairInRowTransaction(transaction, pair, nowMs, "expired");
      prepareJumpResult = { success: false, errorMsg: "WORMHOLE_COLLAPSED" };
      return prepareJumpResult;
    }
    const role = getPairRole(pair, numericEndpointID);
    const endpoint = getEndpoint(pair, role);
    const otherEndpoint = getEndpoint(pair, getOtherRole(role));
    if (!isEndpointVisible(endpoint)) {
      prepareJumpResult = { success: false, errorMsg: "WORMHOLE_NOT_DISCOVERED" };
      transaction.setPair(pair);
      return prepareJumpResult;
    }
    const characterPolarizations = transaction.getPolarizations(numericCharacterID);
    for (const [polarizedEndpointID, record] of Object.entries(characterPolarizations)) {
      if (toInt(record && record.endAtMs, 0) <= nowMs) {
        delete characterPolarizations[polarizedEndpointID];
      }
    }
    const existingPolarization =
      characterPolarizations[String(numericEndpointID)];
    if (existingPolarization && toInt(existingPolarization.endAtMs, 0) > nowMs) {
      prepareJumpResult = { success: false, errorMsg: "WORMHOLE_POLARIZED" };
      transaction.setPair(pair);
      transaction.setPolarizations(numericCharacterID, characterPolarizations);
      return prepareJumpResult;
    }
    if (pair.maxJumpMass > 0 && numericShipMass > pair.maxJumpMass) {
      prepareJumpResult = { success: false, errorMsg: "SHIP_TOO_MASSIVE" };
      transaction.setPair(pair);
      transaction.setPolarizations(numericCharacterID, characterPolarizations);
      return prepareJumpResult;
    }
    if (role === "source" && !isEndpointVisible(otherEndpoint)) {
      setEndpointVisibilityState(otherEndpoint, "visible");
      changedSystemIDs.add(toInt(otherEndpoint && otherEndpoint.systemID, 0));
    }
    const projectedRemainingMassAfterJump = Math.max(
      0,
      projectRemainingMass(pair, nowMs) - numericShipMass,
    );
    prepareJumpResult = {
      success: true,
      data: {
        pairID: pair.pairID,
        role,
        pair: cloneValue(pair),
        destinationSystemID: toInt(otherEndpoint.systemID, 0),
        destinationClassID: toInt(otherEndpoint.wormholeClassID, 0),
        destinationEndpointID: toInt(otherEndpoint.endpointID, 0),
        projectedRemainingMassAfterJump,
        willCollapseAfterJump:
          (projectRemainingMass(pair, nowMs) > 0 && projectedRemainingMassAfterJump <= 0) ||
          (pair.expiresAtMs > 0 && pair.expiresAtMs <= nowMs),
      },
    };
    transaction.setPair(pair);
    transaction.setPolarizations(numericCharacterID, characterPolarizations);
    return prepareJumpResult;
  });
  notifySignatureStateChanged([...changedSystemIDs]);
  return result.success === true && prepareJumpResult
    ? prepareJumpResult
    : { success: false, errorMsg: "WORMHOLE_PREPARE_FAILED" };
}

function commitJump(endpointID, characterID, shipMass, nowMs = Date.now()) {
  const numericEndpointID = toInt(endpointID, 0);
  const numericCharacterID = toInt(characterID, 0);
  const numericShipMass = Math.max(0, toInt(shipMass, 0));
  const changedSystemIDs = new Set();
  const result = mutateStateRows((transaction) => {
    const pair = transaction.getPairByEndpoint(numericEndpointID);
    if (!pair || String(pair.state || "").toLowerCase() !== "active") {
      return null;
    }
    const beforeSourceVisible = isEndpointVisible(pair.source);
    const beforeDestinationVisible = isEndpointVisible(pair.destination);
    advancePairState(pair, nowMs);
    pair.remainingMass = Math.max(0, toInt(pair.remainingMass, 0) - numericShipMass);
    pair.lastMassStateAtMs = Math.max(0, toInt(nowMs, pair.lastMassStateAtMs));
    pair.massRegenRemainder = Math.max(0, toFiniteNumber(pair.massRegenRemainder, 0));
    const characterPolarizations = transaction.getPolarizations(numericCharacterID);
    for (const [polarizedEndpointID, record] of Object.entries(characterPolarizations)) {
      if (toInt(record && record.endAtMs, 0) <= nowMs) {
        delete characterPolarizations[polarizedEndpointID];
      }
    }
    // Polarization applies to the hole, not to the mouth you happened to use.
    // Recording it only against the end jumped *from* left the pilot standing at
    // the other end un-polarized, so the immediate jump back -- the one thing
    // polarization exists to prevent -- was allowed.
    const polarizationRecord = {
      endAtMs: nowMs + POLARIZATION_DURATION_SECONDS * 1000,
      durationSeconds: POLARIZATION_DURATION_SECONDS,
    };
    for (const polarizedEndpointID of [
      numericEndpointID,
      toInt(pair.source && pair.source.endpointID, 0),
      toInt(pair.destination && pair.destination.endpointID, 0),
    ]) {
      if (polarizedEndpointID > 0) {
        characterPolarizations[String(polarizedEndpointID)] = { ...polarizationRecord };
      }
    }
    transaction.setPolarizations(numericCharacterID, characterPolarizations);
    if (
      toInt(pair.remainingMass, 0) <= 0 ||
      (toInt(pair.expiresAtMs, 0) > 0 && toInt(pair.expiresAtMs, 0) <= nowMs)
    ) {
      collapsePairInRowTransaction(
        transaction,
        pair,
        nowMs,
        toInt(pair.remainingMass, 0) <= 0 ? "mass" : "expired",
      );
      for (const systemID of collectVisibleSignatureSystemIDsForPair(pair, {
        includeHiddenDestination: beforeDestinationVisible,
      })) {
        changedSystemIDs.add(systemID);
      }
    }
    transaction.setPair(pair);
    return null;
  });
  notifySignatureStateChanged([...changedSystemIDs]);
  return result;
}

function getPolarization(endpointID, characterID, nowMs = Date.now()) {
  const table = getStateView();
  const record =
    table.polarizationByCharacter[String(toInt(characterID, 0))] &&
    table.polarizationByCharacter[String(toInt(characterID, 0))][String(toInt(endpointID, 0))];
  if (!record) {
    return null;
  }
  if (toInt(record.endAtMs, 0) <= nowMs) {
    return null;
  }
  return {
    endAtMs: toInt(record.endAtMs, 0),
    durationSeconds: Math.max(0, toInt(record.durationSeconds, 0)),
  };
}

function buildJumpSpawnState(pair, sourceRole, options = {}) {
  const destination = getEndpoint(pair, getOtherRole(sourceRole));
  const outwardDirection = normalizeVector(destination.direction, { x: 1, y: 0, z: 0 });
  const shipMass = Math.max(0, toFiniteNumber(options.shipMass, 0));
  const nowMs = Math.max(0, toInt(options.nowMs, Date.now()));
  const characterID = Math.max(0, toInt(options.characterID, 0));
  const randomSeed = options.randomSeed !== undefined && options.randomSeed !== null
    ? Number(options.randomSeed)
    : null;
  const postJumpRemainingMass = Math.max(
    0,
    projectRemainingMass(pair, nowMs) - shipMass,
  );
  const totalMass = Math.max(0, toFiniteNumber(pair && pair.totalMass, 0));
  const postJumpSizeRatio =
    totalMass > 0
      ? Math.max(0, Math.min(1, postJumpRemainingMass / totalMass))
      : 1;
  const baseSurfaceDistance = interpolateAnchoredValue(
    WORMHOLE_POST_JUMP_DISTANCE_ANCHORS,
    shipMass,
  );
  const maxDeviation =
    WORMHOLE_FRESH_POST_JUMP_DEVIATION_METERS +
    ((1 - postJumpSizeRatio) *
      (WORMHOLE_CRITICAL_POST_JUMP_DEVIATION_METERS - WORMHOLE_FRESH_POST_JUMP_DEVIATION_METERS));
  const rollSeed = Number.isFinite(randomSeed)
    ? randomSeed
    : hashSeed(`${pair.pairID}:${characterID}:${shipMass}:${nowMs}`);
  const roll = ((Math.abs(rollSeed) % 1_000_000) / 1_000_000);
  const signedDeviation = ((roll * 2) - 1) * maxDeviation;
  const surfaceDistance = Math.max(
    WORMHOLE_MIN_POST_JUMP_SURFACE_DISTANCE_METERS,
    Math.round(baseSurfaceDistance + signedDeviation),
  );
  return {
    anchorType: "wormhole",
    anchorID: destination.endpointID,
    anchorName:
      destination.code === K162_CODE
        ? "Wormhole K162"
        : `Wormhole ${destination.code || destination.endpointID}`,
    direction: outwardDirection,
    position: addVectors(
      cloneVector(destination.position),
      scaleVector(
        outwardDirection,
        Math.max(
          toFiniteNumber(destination.radius, 3000) +
            surfaceDistance,
          toFiniteNumber(destination.radius, 3000) +
            WORMHOLE_MIN_POST_JUMP_SURFACE_DISTANCE_METERS,
        ),
      ),
    ),
  };
}

function listPairViewsFromTable(table, options = {}) {
  const systemIDFilter = toInt(options.systemID, 0);
  const includeCollapsed = options.includeCollapsed === true;
  const includeUndiscovered = options.includeUndiscovered === true;
  const nowMs = Math.max(0, toInt(options.nowMs, Date.now()));
  const pairs = systemIDFilter > 0
    ? collectPairsForSystem(table, systemIDFilter, { includeCollapsed })
    : Object.values(table.pairsByID || {});
  return pairs
    .filter((pair) => includeCollapsed || String(pair.state || "").toLowerCase() === "active")
    .filter((pair) => {
      if (!systemIDFilter) {
        return true;
      }
      return (
        toInt(pair.source && pair.source.systemID, 0) === systemIDFilter ||
        toInt(pair.destination && pair.destination.systemID, 0) === systemIDFilter
      );
    })
    .map((pair) => {
      const ageState = resolveWormholeAge(pair, nowMs);
      const sizeRatio = resolveWormholeSize(pair, nowMs);
      const presentation = buildWormholePresentationSnapshot({
        otherSolarSystemClass: toInt(pair.destination && pair.destination.wormholeClassID, 0),
        wormholeAge: ageState,
        wormholeSize: sizeRatio,
        maxShipJumpMass: resolveMaxShipMassCategory(pair.maxJumpMass),
      });
      return {
        presentation,
        pairID: pair.pairID,
        kind: pair.kind,
        state: pair.state,
        sourceSystemID: toInt(pair.source && pair.source.systemID, 0),
        sourceSystemName: getSystemName(pair.source && pair.source.systemID),
        sourceEndpointID: toInt(pair.source && pair.source.endpointID, 0),
        sourceCode: pair.source && pair.source.code,
        sourceDiscovered: isEndpointVisible(pair.source),
        randomProfileKey: pair.randomProfileKey || null,
        destinationSystemID: toInt(pair.destination && pair.destination.systemID, 0),
        destinationSystemName: getSystemName(pair.destination && pair.destination.systemID),
        destinationEndpointID: toInt(pair.destination && pair.destination.endpointID, 0),
        destinationCode: pair.destination && pair.destination.code,
        destinationDiscovered: isEndpointVisible(pair.destination),
        destinationVisibilityState: String(pair.destination && pair.destination.visibilityState || "hidden"),
        destinationClassID: toInt(pair.destination && pair.destination.wormholeClassID, 0),
        destinationClassLabel: presentation.classLabel,
        destinationEnvironmentFamily:
          String((getSystemAuthority(pair.destination && pair.destination.systemID) || {}).environmentFamily || "").trim() || null,
        destinationEnvironmentEffectTypeID:
          toInt((getSystemAuthority(pair.destination && pair.destination.systemID) || {}).environmentEffectTypeID, 0),
        destinationEnvironmentEffectTypeName:
          String((getSystemAuthority(pair.destination && pair.destination.systemID) || {}).environmentEffectTypeName || "").trim() || null,
        sourceVisibilityState: String(pair.source && pair.source.visibilityState || "hidden"),
        remainingMass: Math.max(0, Math.round(projectRemainingMass(pair, nowMs))),
        totalMass: toInt(pair.totalMass, 0),
        massRegeneration: toInt(pair.massRegeneration, 0),
        sizeRatio,
        stabilityLabel: presentation.stabilityLabel,
        ageState,
        ageLabel: presentation.ageLabel,
        maxShipJumpMassLabel: presentation.shipMassLabel,
        expiresAtMs: toInt(pair.expiresAtMs, 0),
        staticSlotKey: pair.staticSlotKey || null,
        visible:
          isEndpointVisible(pair.source) ||
          isEndpointVisible(pair.destination),
      };
    })
    .filter((entry) => includeUndiscovered || entry.visible === true)
    .sort((left, right) => left.sourceSystemID - right.sourceSystemID || left.pairID - right.pairID);
}

function listPairViews(options = {}) {
  return listPairViewsFromTable(getStateView(), options);
}

function buildSystemSummaryViewsFromTable(table, options = {}) {
  const systemIDFilter = toInt(options.systemID, 0);
  const entries = listPairViewsFromTable(table, {
    ...options,
    includeCollapsed: options.includeCollapsed === true,
    includeUndiscovered: options.includeUndiscovered !== false,
  });
  const summariesBySystemID = new Map();
  for (const entry of entries) {
    const touchpoints = [
      {
        systemID: entry.sourceSystemID,
        systemName: entry.sourceSystemName,
        code: entry.sourceCode,
        discovered: entry.sourceDiscovered === true,
      },
      {
        systemID: entry.destinationSystemID,
        systemName: entry.destinationSystemName,
        code: entry.destinationCode,
        discovered: entry.destinationDiscovered === true,
      },
    ];
    for (const touchpoint of touchpoints) {
      const systemID = toInt(touchpoint.systemID, 0);
      if (systemID <= 0) {
        continue;
      }
      if (systemIDFilter > 0 && systemID !== systemIDFilter) {
        continue;
      }
      const existing = summariesBySystemID.get(systemID) || {
        systemID,
        systemName: touchpoint.systemName || getSystemName(systemID),
        activePairCount: 0,
        staticPairCount: 0,
        randomPairCount: 0,
        discoveredEndpointCount: 0,
        hiddenEndpointCount: 0,
        environmentFamily: String((getSystemAuthority(systemID) || {}).environmentFamily || "").trim() || null,
        environmentEffectTypeID: toInt((getSystemAuthority(systemID) || {}).environmentEffectTypeID, 0),
        environmentEffectTypeName:
          String((getSystemAuthority(systemID) || {}).environmentEffectTypeName || "").trim() || null,
        codes: new Set(),
        pairIDs: new Set(),
      };
      if (!existing.pairIDs.has(entry.pairID)) {
        existing.pairIDs.add(entry.pairID);
        existing.activePairCount += 1;
        if (entry.kind === "static") {
          existing.staticPairCount += 1;
        } else if (entry.kind === "random") {
          existing.randomPairCount += 1;
        }
      }
      if (touchpoint.code) {
        existing.codes.add(String(touchpoint.code).trim().toUpperCase());
      }
      if (touchpoint.discovered === true) {
        existing.discoveredEndpointCount += 1;
      } else {
        existing.hiddenEndpointCount += 1;
      }
      summariesBySystemID.set(systemID, existing);
    }
  }

  return [...summariesBySystemID.values()]
    .map((entry) => ({
      ...entry,
      codes: [...entry.codes].sort((left, right) => left.localeCompare(right)),
    }))
    .sort((left, right) => left.systemName.localeCompare(right.systemName));
}

function buildSystemSummaryViews(options = {}) {
  return buildSystemSummaryViewsFromTable(getStateView(), options);
}

function buildUniverseSummary(options = {}) {
  const table = getStateView();
  const entries = listPairViewsFromTable(table, {
    includeCollapsed: options.includeCollapsed === true,
    includeUndiscovered: options.includeUndiscovered !== false,
  });
  const systemSummaries = buildSystemSummaryViewsFromTable(table, {
    includeCollapsed: options.includeCollapsed === true,
    includeUndiscovered: options.includeUndiscovered !== false,
  });
  let staticPairCount = 0;
  let randomPairCount = 0;
  let revealedExitCount = 0;
  let hiddenExitCount = 0;
  let environmentSystemCount = 0;
  for (const entry of entries) {
    if (entry.kind === "static") {
      staticPairCount += 1;
    } else if (entry.kind === "random") {
      randomPairCount += 1;
    }
    if (entry.destinationDiscovered === true) {
      revealedExitCount += 1;
    } else {
      hiddenExitCount += 1;
    }
  }
  for (const summary of systemSummaries) {
    if (summary.environmentEffectTypeID > 0) {
      environmentSystemCount += 1;
    }
  }
  return {
    activePairCount: entries.length,
    staticPairCount,
    randomPairCount,
    revealedExitCount,
    hiddenExitCount,
    systemCount: systemSummaries.length,
    environmentSystemCount,
  };
}

function logSceneSummary(scene, nowMs = Date.now()) {
  if (!scene) {
    return;
  }
  const summary = buildSystemSummaryViewsFromTable(getStateView(), {
    systemID: scene.systemID,
    includeCollapsed: false,
    includeUndiscovered: true,
    nowMs,
  })[0] || null;
  if (!summary) {
    log.info(`[Wormholes] ${getSystemName(scene.systemID)} (${scene.systemID}) loaded: 0 tracked wormhole pairs`);
    return;
  }
  log.info(
    `[Wormholes] ${summary.systemName} (${summary.systemID}) loaded: ${summary.activePairCount} pair(s) | static ${summary.staticPairCount} | random ${summary.randomPairCount} | discovered ${summary.discoveredEndpointCount} | hidden ${summary.hiddenEndpointCount} | env ${summary.environmentFamily || "-"} | codes ${summary.codes.join(",") || "-"}`,
  );
}

function warmRuntimeCache(nowMs = Date.now()) {
  if (config.wormholesEnabled !== true) {
    return {
      success: true,
      enabled: false,
      elapsedMs: 0,
      activePairCount: 0,
      totalPairCount: 0,
    };
  }

  const startedAtMs = Date.now();
  const authoritySystemCount = listSystems().length;
  if (worldData && typeof worldData.ensureLoaded === "function") {
    worldData.ensureLoaded();
  }
  const index = getIndexStats();
  const elapsedMs = Date.now() - startedAtMs;

  if (elapsedMs >= 250) {
    log.info(
      `[Wormholes] Runtime cache warmed in ${elapsedMs}ms | active=${index.activePairCount} total=${index.totalPairCount} authoritySystems=${authoritySystemCount}`,
    );
  }

  void nowMs;
  return {
    success: true,
    enabled: true,
    elapsedMs,
    activePairCount: index.activePairCount,
    totalPairCount: index.totalPairCount,
    authoritySystemCount,
  };
}

function spawnRandomPairs(systemID, count = 1, nowMs = Date.now()) {
  const createdPairs = [];
  mutateState((table) => {
    prunePolarizations(table, nowMs);
    const total = Math.max(1, toInt(count, 1));
    for (let index = 0; index < total; index += 1) {
      const pair = createRandomPair(table, systemID, nowMs + index, {});
      if (pair) {
        createdPairs.push(cloneValue(pair));
      }
    }
    return table;
  });
  if (createdPairs.length > 0) {
    notifySignatureStateChanged(
      createdPairs.flatMap((pair) => collectVisibleSignatureSystemIDsForPair(pair)),
    );
  }
  return createdPairs;
}

function clearPairs(systemID = 0, nowMs = Date.now()) {
  const targetSystemID = toInt(systemID, 0);
  const changedSystemIDs = new Set();
  mutateState((table) => {
    for (const pair of Object.values(table.pairsByID || {})) {
      if (
        targetSystemID > 0 &&
        toInt(pair.source && pair.source.systemID, 0) !== targetSystemID &&
        toInt(pair.destination && pair.destination.systemID, 0) !== targetSystemID
      ) {
        continue;
      }
      const beforeDestinationVisible = isEndpointVisible(pair.destination);
      collapsePairInTable(table, pair, nowMs, "gm-clear");
      for (const systemID of collectVisibleSignatureSystemIDsForPair(pair, {
        includeHiddenDestination: beforeDestinationVisible,
      })) {
        changedSystemIDs.add(systemID);
      }
    }
    return table;
  });
  notifySignatureStateChanged([...changedSystemIDs]);
}

module.exports = {
  POLARIZATION_DURATION_SECONDS,
  buildEntityFromPair,
  buildSystemSummaryViews,
  buildUniverseSummary,
  buildJumpSpawnState,
  clearPairs,
  commitJump,
  ensureSystemStatics,
  ensureUniverseStatics,
  getLifecycleSchedulerStatus,
  getPolarization,
  handleSceneCreated,
  listPairViews,
  logSceneSummary,
  markWarpInitiated,
  prepareJump,
  registerSignatureStateChangeListener,
  releasePreparedJump,
  reservePreparedJump,
  revealOppositeEndpoint,
  runLifecycleMaintenanceSlice,
  spawnRandomPairs,
  startLifecycleScheduler,
  stopLifecycleScheduler,
  syncSceneEntities,
  tickScene,
  unregisterSignatureStateChangeListener,
  warmRuntimeCache,
  _testing: {
    applyMassRegeneration,
    buildEndpointPose,
    collapsePairInTable,
    createRandomPair,
    createRandomPairInRowTransaction,
    createStaticPair,
    createStaticPairInRowTransaction,
    getPairByEndpoint,
    getPairRole,
    maybePassivelyRevealDestination,
    projectRemainingMass,
    resolveDestinationSystemID,
    resolveMaxShipMassCategory,
    resolveWormholeAge,
    resolveWormholeSize,
    setEndpointVisibilityState,
  },
};
