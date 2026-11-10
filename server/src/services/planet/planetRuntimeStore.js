"use strict";

const path = require("path");

const config = require(path.join(__dirname, "../../config"));
const database = require(path.join(__dirname, "../../gameStore"));
const log = require(path.join(__dirname, "../../utils/logger"));
const {
  throwWrappedUserError,
} = require(path.join(__dirname, "../../common/machoErrors"));
const {
  currentFileTime: baseCurrentFileTime,
  unwrapMarshalValue,
} = require(path.join(__dirname, "../_shared/serviceHelpers"));
const planetStaticData = require("./planetStaticData");
const { getPlanetResourceAbundanceMultiplier } = require("./planetResourceAbundance");

const TABLE_NAME = "planetRuntimeState";
const SCHEMA_VERSION = 2;
const RESOURCE_RECORD_VERSION = 2;
const RESOURCE_LAYER_VERSION = 1;
const PLANET_RESOURCE_MAX_VALUE = 1.21;
const MAX_DISPLAY_QUALITY = 154;
const LINK_TYPE_ID = 2280;
const STATE_IDLE = 0;
const STATE_ACTIVE = 1;
const SECOND_TICKS = 10000000;
const HOUR_TICKS = 60 * 60 * 10000000;
const DAY_TICKS = 24n * 60n * 60n * 10000000n;
const FILETIME_UNIX_EPOCH_OFFSET = 116444736000000000n;
const MAX_SIMULATION_EVENTS = 20000;
const ECU_PROGRAM_INSTALLATION_COOLDOWN_TICKS = 60n * BigInt(SECOND_TICKS);
const COMMAND_CENTER_LAUNCH_CYCLE_TICKS = 60n * 10000000n;
const PI_LAUNCH_ORBIT_DECAY_TICKS = 5n * DAY_TICKS;
const PI_LAUNCH_CLEANUP_GRACE_TICKS = 30n * DAY_TICKS;
const EXPEDITED_TRANSFER_MINIMUM_TICKS = 5 * 60 * 10000000;
const MAX_ROUTE_WAYPOINTS = 5;
const LINK_MAX_UPGRADE = 10;
const ECU_MAX_HEADS = 10;
const RADIUS_DRILL_AREA_MIN = 0.01;
const RADIUS_DRILL_AREA_MAX = 0.05;
const RADIUS_DRILL_AREA_DIFF = RADIUS_DRILL_AREA_MAX - RADIUS_DRILL_AREA_MIN;
const RESOURCE_LAYER_HOTSPOT_MIN = 6;
const RESOURCE_LAYER_HOTSPOT_SPREAD = 4;
const RESOURCE_DEPLETION_EVENT_LIMIT = 24;
const RESOURCE_DEPLETION_RECOVERY_HOURS = 96;
const RESOURCE_SH_MAX_BANDS = 30;
const RESOURCE_SH_COEFFICIENT_BYTES = 4;
const DEFAULT_ECU_TYPE_ID = 2848;
// The client previews ECU programs by evaluating the float32 spherical-
// harmonic coefficients returned by GetResourceData. Keep that coefficient
// field authoritative for server quotes and installs too. This multiplier is
// calibrated by the supplied Henebene I Base Metals capture: the four exact
// heads at radius 0.010121 produce the observed 1,951 base units after the
// client-compatible real-SH evaluation below.
const RESOURCE_SH_CLIENT_CALIBRATION = 1.106750553281421;
// Preserve the established synthetic depletion pressure while changing the
// authoritative sampling representation. This denominator is not used for
// program yield; it only keeps existing depletion-event strength stable.
const RESOURCE_DEPLETION_PRESSURE_SCALE = 412.224;
const MAX_CUSTOMS_OPERATION_RECEIPTS = 1024;
const MAX_NETWORK_EDIT_RECEIPTS = 128;
const NETWORK_EDIT_RETRY_WINDOW_TICKS = 30n * BigInt(SECOND_TICKS);

const COMMAND = Object.freeze({
  CREATEPIN: 1,
  REMOVEPIN: 2,
  CREATELINK: 3,
  REMOVELINK: 4,
  SETLINKLEVEL: 5,
  CREATEROUTE: 6,
  REMOVEROUTE: 7,
  SETSCHEMATIC: 8,
  UPGRADECOMMANDCENTER: 9,
  ADDEXTRACTORHEAD: 10,
  KILLEXTRACTORHEAD: 11,
  MOVEEXTRACTORHEAD: 12,
  INSTALLPROGRAM: 13,
});

// GetMyLaunchesDetails sends launchID as a 32-bit integer, as Tranquility does,
// so a launch ID has to fit one. The packet path cannot marshal a larger ID,
// and the client is then answered None instead of its launches.
const MAX_LAUNCH_ID = 0x7fffffff;

const DEFAULT_NEXT_IDS = Object.freeze({
  pinID: 900000000000,
  routeID: 1,
  launchID: 910000000,
});

// PI production is settled lazily whenever a colony is read or mutated. Keep
// its notion of "now" injectable for the gameplay harness without changing
// the process-wide Date.now(), which the persistence lease correctly keeps on
// wall time.
let nowFileTimeOverride = null;

function currentFileTime() {
  if (typeof nowFileTimeOverride === "function") {
    try {
      const override = nowFileTimeOverride();
      if (override !== null && override !== undefined) {
        return BigInt(override);
      }
    } catch (_error) {
      // ignored: a bad test clock must not make production gameplay lose its real clock.
    }
  }
  return baseCurrentFileTime();
}

function setNowFileTimeOverride(fn) {
  nowFileTimeOverride = typeof fn === "function" ? fn : null;
}

function resetNowFileTimeOverride() {
  nowFileTimeOverride = null;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeState(rawState = {}) {
  const state = isPlainObject(rawState) ? { ...rawState } : {};
  let changed = false;
  const previousSchemaVersion = normalizeInteger(state.schemaVersion, 0);

  if (state.schemaVersion !== SCHEMA_VERSION) {
    state.schemaVersion = SCHEMA_VERSION;
    changed = true;
  }

  for (const key of [
    "resourcesByPlanetID",
    "coloniesByKey",
    "launchesByID",
    "acceptedNetworkEditsByKey",
    "networkEditReceiptsByKey",
    "customsOperationReceipts",
  ]) {
    if (!isPlainObject(state[key])) {
      state[key] = {};
      changed = true;
    }
  }

  if (previousSchemaVersion < 2 && Object.keys(state.acceptedNetworkEditsByKey).length > 0) {
    // V1 treated a payload digest as permanent request identity. Those receipts
    // cannot be safely migrated because they carry neither a request scope nor a
    // colony revision, so discard them during the V2 migration.
    state.acceptedNetworkEditsByKey = {};
    changed = true;
  }

  if (!isPlainObject(state.nextIDs)) {
    state.nextIDs = cloneJson(DEFAULT_NEXT_IDS);
    changed = true;
  } else {
    for (const [key, value] of Object.entries(DEFAULT_NEXT_IDS)) {
      if (!Number.isFinite(Number(state.nextIDs[key]))) {
        state.nextIDs[key] = value;
        changed = true;
      }
    }
  }

  if (renumberWideLaunchIDs(state)) {
    changed = true;
  }

  return { state, changed };
}

function storedLaunchID(key, launch) {
  return normalizeInteger((launch && launch.launchID) || key, 0);
}

// Launch IDs used to be counted up from 910000000000, which does not fit the
// 32-bit launchID column. A store written then holds launches under those IDs
// and a counter past them. Each such launch is given the next free ID that
// fits and is stored under it, with the ID it had kept as legacyLaunchID, and
// the counter is brought back into range. Nothing else about the launch
// changes: it keeps its container (itemID) and its stored position, which was
// worked out from the old ID when it was launched and is where the container is.
function renumberWideLaunchIDs(state) {
  const storedCounter = normalizeInteger(state.nextIDs.launchID, 0);
  const counterFits = storedCounter > 0 && storedCounter <= MAX_LAUNCH_ID;
  const wideKeys = Object.keys(state.launchesByID).filter((key) => (
    isPlainObject(state.launchesByID[key]) &&
    storedLaunchID(key, state.launchesByID[key]) > MAX_LAUNCH_ID
  ));
  if (counterFits && wideKeys.length === 0) {
    return false;
  }

  const usedIDs = new Set();
  for (const [key, launch] of Object.entries(state.launchesByID)) {
    usedIDs.add(normalizeInteger(key, 0));
    usedIDs.add(storedLaunchID(key, launch));
  }

  let nextID = counterFits ? storedCounter : DEFAULT_NEXT_IDS.launchID;
  const renumberedByKey = new Map();
  wideKeys.sort((left, right) => (
    storedLaunchID(left, state.launchesByID[left]) -
    storedLaunchID(right, state.launchesByID[right])
  ));
  for (const key of wideKeys) {
    const launch = state.launchesByID[key];
    const previousLaunchID = storedLaunchID(key, launch);
    while (usedIDs.has(nextID)) {
      nextID += 1;
    }
    const launchID = nextID;
    usedIDs.add(launchID);
    nextID += 1;

    // A launch that never got a container carries its launch ID as its item ID.
    const itemID = normalizeInteger(launch.itemID, 0);
    renumberedByKey.set(key, {
      ...launch,
      launchID,
      legacyLaunchID: previousLaunchID,
      itemID: itemID > 0 && itemID !== previousLaunchID ? itemID : launchID,
    });
  }

  // Build new objects instead of editing the ones read from the store, so a
  // read that does not go on to write leaves the stored table as it was.
  const launchesByID = {};
  for (const [key, launch] of Object.entries(state.launchesByID)) {
    const renumbered = renumberedByKey.get(key);
    if (renumbered) {
      launchesByID[String(renumbered.launchID)] = renumbered;
    } else {
      launchesByID[key] = launch;
    }
  }
  state.launchesByID = launchesByID;
  state.nextIDs = { ...state.nextIDs, launchID: nextID };
  return true;
}

// The stored launch with this ID. A launch that was renumbered still answers to
// the ID it had, which its container's tag and a list read earlier may hold.
function findStoredLaunch(state, launchID) {
  const launch = state.launchesByID[String(launchID)];
  if (launch) {
    return launch;
  }
  if (launchID > MAX_LAUNCH_ID) {
    for (const candidate of Object.values(state.launchesByID)) {
      if (normalizeInteger(candidate && candidate.legacyLaunchID, 0) === launchID) {
        return candidate;
      }
    }
  }
  return null;
}

function readState(options = {}) {
  const result = database.read(TABLE_NAME, "/");
  if (!result.success) {
    log.warn(
      `[PlanetRuntimeStore] Failed to read ${TABLE_NAME}: ${result.errorMsg || "READ_ERROR"}`,
    );
  }

  const { state, changed } = normalizeState(result.success ? result.data : {});
  if (changed && options.repair === true) {
    writeState(state);
  }
  return state;
}

function flushStateToDisk() {
  const result = database.flushTableSync(TABLE_NAME);
  if (!result.success) {
    log.warn(
      `[PlanetRuntimeStore] Failed to flush ${TABLE_NAME}: ${result.errorMsg || "FLUSH_ERROR"}`,
    );
  }
  return result.success === true;
}

function writeState(state) {
  const { state: normalizedState } = normalizeState(state);
  const result = database.write(TABLE_NAME, "/", normalizedState, { force: true });
  if (!result.success) {
    log.warn(
      `[PlanetRuntimeStore] Failed to write ${TABLE_NAME}: ${result.errorMsg || "WRITE_ERROR"}`,
    );
    return false;
  }
  return flushStateToDisk();
}

function normalizeInteger(value, fallback = 0) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return fallback;
  }
  return Math.trunc(numericValue);
}

function normalizeReal(value, fallback = 0) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : fallback;
}

function normalizeNullableInteger(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? Math.trunc(numericValue) : null;
}

function currentFileTimeString() {
  return currentFileTime().toString();
}

function filetimeBigInt(value, fallback = currentFileTime()) {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }

  try {
    if (typeof value === "bigint") {
      return value;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return BigInt(Math.trunc(value));
    }
    if (typeof value === "string") {
      return BigInt(value);
    }
  } catch (error) {
    return fallback;
  }

  return fallback;
}

function colonyKey(planetID, ownerID) {
  return `${normalizeInteger(planetID, 0)}:${normalizeInteger(ownerID, 0)}`;
}

function getNetworkEditReceiptBucket(state, key, options = {}) {
  if (!isPlainObject(state.networkEditReceiptsByKey)) {
    state.networkEditReceiptsByKey = {};
  }
  if (!isPlainObject(state.networkEditReceiptsByKey[key])) {
    if (options.create !== true) {
      return null;
    }
    state.networkEditReceiptsByKey[key] = {};
  }
  return state.networkEditReceiptsByKey[key];
}

function getNetworkEditReplay({
  planetID,
  ownerID,
  editHash,
  requestScope = null,
  nowFileTime = currentFileTime(),
} = {}) {
  const normalizedPlanetID = normalizeInteger(planetID, 0);
  const normalizedOwnerID = normalizeInteger(ownerID, 0);
  if (normalizedPlanetID <= 0 || normalizedOwnerID <= 0 || !editHash) {
    return { status: "none", receipt: null };
  }

  const state = readState({ repair: true });
  const key = colonyKey(normalizedPlanetID, normalizedOwnerID);
  const storedColony = state.coloniesByKey[key];
  if (!storedColony) {
    return { status: "none", receipt: null };
  }
  const colony = normalizeColony(storedColony, {
    planetID: normalizedPlanetID,
    ownerID: normalizedOwnerID,
  });
  const currentRevision = normalizeInteger(colony.networkRevision, 0);
  const bucket = getNetworkEditReceiptBucket(
    state,
    key,
  );
  const receipts = Object.values(bucket || {})
    .filter((receipt) => isPlainObject(receipt));
  const normalizedHash = String(editHash);
  const normalizedScope = requestScope === null || requestScope === undefined
    ? ""
    : String(requestScope);

  if (normalizedScope) {
    const exactReceipt = receipts
      .filter((receipt) => String(receipt.requestScope || "") === normalizedScope)
      .sort((left, right) => (
        filetimeBigInt(right.acceptedAtFileTime, 0n) > filetimeBigInt(left.acceptedAtFileTime, 0n)
          ? 1
          : -1
      ))[0] || null;
    if (exactReceipt) {
      if (String(exactReceipt.editHash || "") !== normalizedHash) {
        return { status: "conflict", receipt: exactReceipt, colony };
      }
      if (normalizeInteger(exactReceipt.resultRevision, -1) !== currentRevision) {
        return { status: "stale", receipt: exactReceipt, colony };
      }
      return { status: "replay", receipt: exactReceipt, colony };
    }
  }

  const nowTicks = filetimeBigInt(nowFileTime, currentFileTime());
  const recentReceipt = receipts
    .filter((receipt) => (
      String(receipt.editHash || "") === normalizedHash &&
      normalizeInteger(receipt.resultRevision, -1) === currentRevision
    ))
    .map((receipt) => ({
      receipt,
      acceptedTicks: filetimeBigInt(receipt.acceptedAtFileTime, 0n),
    }))
    .filter(({ acceptedTicks }) => (
      acceptedTicks > 0n &&
      nowTicks >= acceptedTicks &&
      nowTicks - acceptedTicks <= NETWORK_EDIT_RETRY_WINDOW_TICKS
    ))
    .sort((left, right) => (right.acceptedTicks > left.acceptedTicks ? 1 : -1))[0];

  return recentReceipt
    ? { status: "replay", receipt: recentReceipt.receipt, colony }
    : { status: "none", receipt: null, colony };
}

function markNetworkEditReceipt(state, key, operationKey, details = {}) {
  if (!operationKey || !details.editHash) {
    return;
  }
  const bucket = getNetworkEditReceiptBucket(state, key, { create: true });
  const acceptedAtFileTime = filetimeBigInt(
    details.acceptedAtFileTime,
    currentFileTime(),
  ).toString();
  bucket[String(operationKey)] = {
    operationKey: String(operationKey),
    requestScope: details.requestScope ? String(details.requestScope) : null,
    editHash: String(details.editHash),
    baseRevision: normalizeInteger(details.baseRevision, 0),
    resultRevision: normalizeInteger(details.resultRevision, 0),
    acceptedAtFileTime,
    acceptedAt: new Date().toISOString(),
    constructionCost: normalizeReal(details.constructionCost, 0),
    createdPinIDs: (Array.isArray(details.createdPinIDs) ? details.createdPinIDs : [])
      .map((pinID) => normalizeInteger(pinID, 0))
      .filter((pinID) => pinID > 0),
  };

  const retained = Object.entries(bucket)
    .sort(([, left], [, right]) => (
      filetimeBigInt(right && right.acceptedAtFileTime, 0n) >
      filetimeBigInt(left && left.acceptedAtFileTime, 0n)
        ? 1
        : -1
    ))
    .slice(0, MAX_NETWORK_EDIT_RECEIPTS);
  state.networkEditReceiptsByKey[key] = Object.fromEntries(retained);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeResourceTypeIDs(resourceTypeIDs = []) {
  return [...new Set(
    (Array.isArray(resourceTypeIDs) ? resourceTypeIDs : [])
      .map((typeID) => normalizeInteger(typeID, 0))
      .filter((typeID) => typeID > 0),
  )].sort((left, right) => left - right);
}

function stableHash(parts = []) {
  let hash = 2166136261;
  const source = parts.map((part) => String(part)).join(":");
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

function hashRatio(parts = []) {
  return stableHash(parts) / 0xffffffff;
}

function signedHashRatio(parts = []) {
  return (hashRatio(parts) * 2) - 1;
}

function normalizeLongitude(value) {
  const tau = Math.PI * 2;
  const rawValue = normalizeReal(value, 0);
  const wrapped = rawValue % tau;
  return wrapped < 0 ? wrapped + tau : wrapped;
}

function normalizeLatitude(value) {
  return clamp(normalizeReal(value, 0), 0, Math.PI);
}

function normalizeSurfacePoint(latitude, longitude) {
  return {
    latitude: normalizeLatitude(latitude),
    longitude: normalizeLongitude(longitude),
  };
}

function sphericalDistance(left, right) {
  const deltaLongitude = normalizeLongitude(left.longitude - right.longitude);
  const shortestDelta = deltaLongitude > Math.PI
    ? (Math.PI * 2) - deltaLongitude
    : deltaLongitude;
  const cosineDistance = (
    Math.cos(left.latitude) * Math.cos(right.latitude) +
    Math.sin(left.latitude) * Math.sin(right.latitude) * Math.cos(shortestDelta)
  );
  return Math.acos(clamp(cosineDistance, -1, 1));
}

function filetimeToUnixMs(value, fallbackMs = Date.now()) {
  if (value === null || value === undefined || value === "") {
    return fallbackMs;
  }

  try {
    const filetime = typeof value === "bigint" ? value : BigInt(String(value));
    return Number((filetime - FILETIME_UNIX_EPOCH_OFFSET) / 10000n);
  } catch (error) {
    return fallbackMs;
  }
}

function buildResourceQuality(planetMeta, resourceTypeID, index) {
  const planetID = normalizeInteger(planetMeta && planetMeta.planetID, 0);
  const planetTypeID = normalizeInteger(planetMeta && planetMeta.typeID, 0);
  const security = Number(planetMeta && planetMeta.security);
  const securityBonus = Number.isFinite(security)
    ? clamp(1 - security, 0, 1.25) * 22
    : 10;
  const noise = hashRatio([planetID, planetTypeID, resourceTypeID, "quality"]);
  const spread = 42 + noise * 78 + securityBonus + index * 2.5;
  return Math.round(clamp(spread, 18, MAX_DISPLAY_QUALITY));
}

function buildResourceHotspot(planetMeta, resourceTypeID, quality, index, hotspotIndex) {
  const planetID = normalizeInteger(planetMeta && planetMeta.planetID, 0);
  const planetTypeID = normalizeInteger(planetMeta && planetMeta.typeID, 0);
  const seedParts = [
    planetID,
    planetTypeID,
    resourceTypeID,
    index,
    hotspotIndex,
    "resource-hotspot",
  ];
  const qualityScale = clamp(quality / MAX_DISPLAY_QUALITY, 0.08, 1);

  return {
    latitude: Number((hashRatio([...seedParts, "latitude"]) * Math.PI).toFixed(6)),
    longitude: Number((hashRatio([...seedParts, "longitude"]) * Math.PI * 2).toFixed(6)),
    radius: Number((0.16 + hashRatio([...seedParts, "radius"]) * 0.34).toFixed(6)),
    amplitude: Number(((0.24 + hashRatio([...seedParts, "amplitude"]) * 0.94) * qualityScale).toFixed(6)),
  };
}

function buildResourceLayer(planetMeta, resourceTypeID, quality, index) {
  const planetID = normalizeInteger(planetMeta && planetMeta.planetID, 0);
  const planetTypeID = normalizeInteger(planetMeta && planetMeta.typeID, 0);
  const solarSystemID = normalizeInteger(planetMeta && planetMeta.solarSystemID, 0);
  const seed = stableHash([
    planetID,
    planetTypeID,
    solarSystemID,
    resourceTypeID,
    "resource-layer",
  ]);
  const qualityScale = clamp(quality / MAX_DISPLAY_QUALITY, 0.08, 1);
  const hotspotCount = RESOURCE_LAYER_HOTSPOT_MIN +
    Math.floor(hashRatio([seed, "hotspot-count"]) * RESOURCE_LAYER_HOTSPOT_SPREAD);
  const hotspots = [];
  for (let hotspotIndex = 0; hotspotIndex < hotspotCount; hotspotIndex += 1) {
    hotspots.push(buildResourceHotspot(
      planetMeta,
      resourceTypeID,
      quality,
      index,
      hotspotIndex,
    ));
  }

  return {
    version: RESOURCE_LAYER_VERSION,
    resourceTypeID,
    seed,
    quality,
    background: Number((qualityScale * (0.08 + hashRatio([seed, "background"]) * 0.08)).toFixed(6)),
    hotspots,
    depletionEvents: [],
  };
}

function normalizeResourceLayer(layer = {}) {
  const normalizedLayer = isPlainObject(layer) ? { ...layer } : {};
  normalizedLayer.version = normalizeInteger(normalizedLayer.version, 0);
  normalizedLayer.resourceTypeID = normalizeInteger(normalizedLayer.resourceTypeID, 0);
  normalizedLayer.seed = normalizeInteger(normalizedLayer.seed, 0);
  normalizedLayer.quality = normalizeInteger(normalizedLayer.quality, 0);
  normalizedLayer.background = clamp(normalizeReal(normalizedLayer.background, 0), 0, PLANET_RESOURCE_MAX_VALUE);
  normalizedLayer.hotspots = (Array.isArray(normalizedLayer.hotspots) ? normalizedLayer.hotspots : [])
    .map((hotspot) => ({
      latitude: normalizeLatitude(hotspot && hotspot.latitude),
      longitude: normalizeLongitude(hotspot && hotspot.longitude),
      radius: clamp(normalizeReal(hotspot && hotspot.radius, 0.2), 0.01, Math.PI),
      amplitude: clamp(normalizeReal(hotspot && hotspot.amplitude, 0), 0, PLANET_RESOURCE_MAX_VALUE),
    }));
  normalizedLayer.depletionEvents = (Array.isArray(normalizedLayer.depletionEvents)
    ? normalizedLayer.depletionEvents
    : [])
    .map((event) => ({
      installTime: event && event.installTime ? String(event.installTime) : null,
      expiryTime: event && event.expiryTime ? String(event.expiryTime) : null,
      headRadius: clamp(
        normalizeReal(event && event.headRadius, RADIUS_DRILL_AREA_MIN),
        RADIUS_DRILL_AREA_MIN,
        RADIUS_DRILL_AREA_MAX,
      ),
      depletionRadius: clamp(normalizeReal(event && event.depletionRadius, 0.15), 0.01, Math.PI),
      strength: clamp(normalizeReal(event && event.strength, 0), 0, PLANET_RESOURCE_MAX_VALUE),
      heads: normalizeHeads(event && event.heads),
    }))
    .filter((event) => event.strength > 0 && event.heads.length > 0);
  return normalizedLayer;
}

function buildResourceRecord(planetMeta, resourceTypeIDs = []) {
  const normalizedTypeIDs = normalizeResourceTypeIDs(resourceTypeIDs);
  const planetID = normalizeInteger(planetMeta && planetMeta.planetID, 0);
  const planetTypeID = normalizeInteger(planetMeta && planetMeta.typeID, 0);
  const solarSystemID = normalizeInteger(planetMeta && planetMeta.solarSystemID, 0);
  const seed = stableHash([planetID, planetTypeID, solarSystemID, "planet-resource"]);
  const qualitiesByTypeID = {};
  const layersByTypeID = {};

  normalizedTypeIDs.forEach((resourceTypeID, index) => {
    const quality = buildResourceQuality(
      planetMeta,
      resourceTypeID,
      index,
    );
    qualitiesByTypeID[String(resourceTypeID)] = quality;
    layersByTypeID[String(resourceTypeID)] = buildResourceLayer(
      planetMeta,
      resourceTypeID,
      quality,
      index,
    );
  });

  return {
    version: RESOURCE_RECORD_VERSION,
    planetID,
    planetTypeID,
    solarSystemID,
    seed,
    resourceTypeIDs: normalizedTypeIDs,
    qualitiesByTypeID,
    layersByTypeID,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function shouldRefreshResourceRecord(record, planetMeta, resourceTypeIDs) {
  if (!isPlainObject(record) || record.version !== RESOURCE_RECORD_VERSION) {
    return true;
  }

  const normalizedTypeIDs = normalizeResourceTypeIDs(resourceTypeIDs);
  const storedTypeIDs = normalizeResourceTypeIDs(record.resourceTypeIDs);
  if (storedTypeIDs.length !== normalizedTypeIDs.length) {
    return true;
  }

  if (!isPlainObject(record.layersByTypeID)) {
    return true;
  }

  if (normalizedTypeIDs.some((typeID) => {
    const layer = record.layersByTypeID[String(typeID)];
    return !isPlainObject(layer) || normalizeInteger(layer.version, 0) !== RESOURCE_LAYER_VERSION;
  })) {
    return true;
  }

  return normalizedTypeIDs.some((typeID, index) => storedTypeIDs[index] !== typeID) ||
    normalizeInteger(record.planetTypeID, 0) !== normalizeInteger(planetMeta && planetMeta.typeID, 0);
}

function getOrCreatePlanetResources(planetMeta, resourceTypeIDs = []) {
  const planetID = normalizeInteger(planetMeta && planetMeta.planetID, 0);
  if (planetID <= 0) {
    return buildResourceRecord(planetMeta || {}, resourceTypeIDs);
  }

  const state = readState({ repair: true });
  const key = String(planetID);
  if (shouldRefreshResourceRecord(state.resourcesByPlanetID[key], planetMeta, resourceTypeIDs)) {
    const previousRecord = state.resourcesByPlanetID[key];
    const nextRecord = buildResourceRecord(planetMeta, resourceTypeIDs);
    if (previousRecord && previousRecord.createdAt) {
      nextRecord.createdAt = previousRecord.createdAt;
    }
    state.resourcesByPlanetID[key] = nextRecord;
    writeState(state);
  }

  return state.resourcesByPlanetID[key];
}

function getResourceLayerFromRecord(resourceRecord, resourceTypeID) {
  if (!isPlainObject(resourceRecord) || !isPlainObject(resourceRecord.layersByTypeID)) {
    return null;
  }
  const layer = resourceRecord.layersByTypeID[String(normalizeInteger(resourceTypeID, 0))];
  return isPlainObject(layer) ? normalizeResourceLayer(layer) : null;
}

function getResourceQualitiesForClient(resourceRecord) {
  return Object.fromEntries(Object.entries(resourceRecord.qualitiesByTypeID || {}).map(([typeID, quality]) => {
    return [typeID, Math.round(clamp(
      normalizeInteger(quality, 0) * getPlanetResourceAbundanceMultiplier(),
      0,
      MAX_DISPLAY_QUALITY,
    ))];
  }));
}

function getResourceLayer(planetID, resourceTypeID, options = {}) {
  const normalizedPlanetID = normalizeInteger(planetID, 0);
  const normalizedResourceTypeID = normalizeInteger(resourceTypeID, 0);
  if (normalizedPlanetID <= 0 || normalizedResourceTypeID <= 0) {
    return null;
  }

  const state = options.state || readState({ repair: true });
  const resourceRecord = state.resourcesByPlanetID[String(normalizedPlanetID)];
  return getResourceLayerFromRecord(resourceRecord, normalizedResourceTypeID);
}

function buildResourceLayerCoefficient(layer, coefficientIndex, options = {}) {
  const normalizedLayer = normalizeResourceLayer(layer);
  const band = Math.floor(Math.sqrt(coefficientIndex)) + 1;
  const bandStart = (band - 1) ** 2;
  const withinBand = coefficientIndex - bandStart;
  const qualityScale = clamp(normalizedLayer.quality / MAX_DISPLAY_QUALITY, 0.08, 1);

  if (coefficientIndex === 0) {
    return 64 + (qualityScale * 142);
  }

  const seed = normalizedLayer.seed || stableHash([
    normalizedLayer.resourceTypeID,
    normalizedLayer.quality,
    "resource-sh",
  ]);
  const bandDecay = 1 / (1 + (band * 0.32));
  const angleMultiplier = withinBand + 1;
  const hotspots = normalizedLayer.hotspots.length > 0
    ? normalizedLayer.hotspots
    : [{ latitude: Math.PI / 2, longitude: 0, amplitude: normalizedLayer.background || 0.1 }];
  let hotspotSignal = 0;
  for (let index = 0; index < hotspots.length; index += 1) {
    const hotspot = hotspots[index];
    const phase = (
      band * Math.cos(hotspot.latitude) +
      angleMultiplier * Math.sin(hotspot.longitude) +
      index
    );
    hotspotSignal += hotspot.amplitude * Math.cos(phase);
  }
  hotspotSignal /= Math.max(1, hotspots.length);

  let depletionSignal = 0;
  const nowMs = normalizeInteger(options.nowMs, Date.now());
  for (const event of normalizedLayer.depletionEvents) {
    const timeFactor = getDepletionEventFactor(event, nowMs);
    if (timeFactor < 0.01) {
      continue;
    }

    for (const head of event.heads) {
      const phase = (
        band * Math.cos(head[1]) +
        angleMultiplier * Math.sin(head[2])
      );
      depletionSignal += event.strength * timeFactor * Math.cos(phase);
    }
  }

  const noise = signedHashRatio([
    seed,
    normalizedLayer.resourceTypeID,
    band,
    withinBand,
    "resource-sh-coeff",
  ]);
  const coefficient = (
    (hotspotSignal * 13.5) +
    (noise * 2.25 * qualityScale) -
    (depletionSignal * 9.5)
  ) * bandDecay;
  return Number.isFinite(coefficient) ? coefficient : 0;
}

function normalizeResourceShBands(value, fallback = RESOURCE_SH_MAX_BANDS) {
  return clamp(
    normalizeInteger(value, fallback),
    0,
    RESOURCE_SH_MAX_BANDS,
  );
}

function buildResourceLayerCoefficients(layer, numBands, options = {}) {
  const normalizedBands = normalizeResourceShBands(numBands);
  const coefficientCount = normalizedBands ** 2;
  // Both client scan bytes and authoritative ECU quotes use these exact
  // float32 coefficients. Keep saved layers unscaled so config changes never
  // reroll a planet or multiply an already-scaled field a second time.
  const abundanceMultiplier = getPlanetResourceAbundanceMultiplier();
  return Array.from({ length: coefficientCount }, (_, coefficientIndex) => (
    Math.fround(
      buildResourceLayerCoefficient(layer, coefficientIndex, options) *
      RESOURCE_SH_CLIENT_CALIBRATION * abundanceMultiplier,
    )
  ));
}

function buildResourceLayerBuffer(layer, numBands, options = {}) {
  const coefficients = buildResourceLayerCoefficients(layer, numBands, options);
  const buffer = Buffer.alloc(coefficients.length * RESOURCE_SH_COEFFICIENT_BYTES);
  coefficients.forEach((coefficient, coefficientIndex) => {
    buffer.writeFloatLE(
      coefficient,
      coefficientIndex * RESOURCE_SH_COEFFICIENT_BYTES,
    );
  });
  return buffer;
}

function getFactorialRatio(numerator, denominator) {
  let ratio = 1;
  if (numerator < denominator) {
    for (let value = numerator + 1; value <= denominator; value += 1) {
      ratio /= value;
    }
  } else {
    for (let value = denominator + 1; value <= numerator; value += 1) {
      ratio *= value;
    }
  }
  return ratio;
}

function getAssociatedLegendreValue(degree, order, x) {
  let diagonal = 1;
  if (order > 0) {
    const root = Math.sqrt(Math.max(0, 1 - (x * x)));
    let factor = 1;
    for (let index = 1; index <= order; index += 1) {
      diagonal *= -factor * root;
      factor += 2;
    }
  }
  if (degree === order) {
    return diagonal;
  }

  let next = x * ((2 * order) + 1) * diagonal;
  if (degree === order + 1) {
    return next;
  }

  for (let currentDegree = order + 2; currentDegree <= degree; currentDegree += 1) {
    const value = (
      (((2 * currentDegree) - 1) * x * next) -
      ((currentDegree + order - 1) * diagonal)
    ) / (currentDegree - order);
    diagonal = next;
    next = value;
  }
  return next;
}

function getRealSphericalHarmonicValue(degree, order, azimuth, polarAngle) {
  const absoluteOrder = Math.abs(order);
  const normalization = Math.sqrt(
    (((2 * degree) + 1) / (4 * Math.PI)) *
    getFactorialRatio(degree - absoluteOrder, degree + absoluteOrder),
  );
  const baseValue = normalization * getAssociatedLegendreValue(
    degree,
    absoluteOrder,
    Math.cos(polarAngle),
  );
  if (order < 0) {
    return Math.SQRT2 * baseValue * Math.sin(absoluteOrder * azimuth);
  }
  if (order > 0) {
    return Math.SQRT2 * baseValue * Math.cos(order * azimuth);
  }
  return baseValue;
}

function evaluateResourceHarmonicCoefficients(
  coefficients,
  numBands,
  latitude,
  longitude,
) {
  const normalizedBands = normalizeResourceShBands(numBands, 0);
  const coefficientCount = Math.min(
    normalizedBands ** 2,
    Array.isArray(coefficients) ? coefficients.length : 0,
  );
  if (coefficientCount < 1) {
    return 0;
  }

  // EcuPin heads are serialized as (id, phi, theta). The extracted client
  // evaluates the resource harmonic at (2*pi-theta, phi).
  const polarAngle = normalizeLatitude(latitude);
  const azimuth = normalizeLongitude((Math.PI * 2) - normalizeLongitude(longitude));
  let value = 0;
  for (let coefficientIndex = 0; coefficientIndex < coefficientCount; coefficientIndex += 1) {
    const degree = Math.floor(Math.sqrt(coefficientIndex));
    const order = coefficientIndex - (degree ** 2) - degree;
    value += normalizeReal(coefficients[coefficientIndex], 0) *
      getRealSphericalHarmonicValue(degree, order, azimuth, polarAngle);
  }
  return Number.isFinite(value) ? value : 0;
}

function evaluateResourceHarmonicBuffer(
  buffer,
  numBands,
  latitude,
  longitude,
) {
  const normalizedBands = normalizeResourceShBands(numBands, 0);
  const requestedCoefficientCount = normalizedBands ** 2;
  const availableCoefficientCount = Buffer.isBuffer(buffer)
    ? Math.floor(buffer.length / RESOURCE_SH_COEFFICIENT_BYTES)
    : 0;
  const coefficientCount = Math.min(requestedCoefficientCount, availableCoefficientCount);
  const coefficients = Array.from({ length: coefficientCount }, (_, coefficientIndex) => (
    buffer.readFloatLE(coefficientIndex * RESOURCE_SH_COEFFICIENT_BYTES)
  ));
  return evaluateResourceHarmonicCoefficients(
    coefficients,
    normalizedBands,
    latitude,
    longitude,
  );
}

function evaluateResourceLayerHarmonicValue(layer, latitude, longitude, options = {}) {
  const numBands = normalizeResourceShBands(options.numBands);
  const coefficients = Array.isArray(options.coefficients)
    ? options.coefficients
    : buildResourceLayerCoefficients(layer, numBands, options);
  return evaluateResourceHarmonicCoefficients(
    coefficients,
    numBands,
    latitude,
    longitude,
  );
}

function getResourceDataForClient(planetMeta, resourceTypeID, resourceTypeIDs = [], info = {}) {
  const resourceRecord = getOrCreatePlanetResources(planetMeta, resourceTypeIDs);
  const layer = getResourceLayerFromRecord(resourceRecord, resourceTypeID);
  const oldBand = normalizeInteger(info.oldBand, 0);
  const requestedBand = clamp(
    normalizeInteger(info.newBand, oldBand),
    0,
    RESOURCE_SH_MAX_BANDS,
  );

  if (!layer || requestedBand <= 0) {
    return {
      data: null,
      numBands: oldBand,
      proximity: Object.prototype.hasOwnProperty.call(info, "proximity")
        ? info.proximity
        : null,
      layer,
    };
  }

  return {
    data: {
      type: "bytes",
      value: buildResourceLayerBuffer(layer, requestedBand),
    },
    numBands: requestedBand,
    proximity: Object.prototype.hasOwnProperty.call(info, "proximity")
      ? info.proximity
      : null,
    layer,
  };
}

function getDepletionEventFactor(event, nowMs = Date.now()) {
  const expiryMs = filetimeToUnixMs(event && event.expiryTime, nowMs);
  if (nowMs <= expiryMs) {
    return 1;
  }

  const hoursSinceExpiry = Math.max(0, (nowMs - expiryMs) / (60 * 60 * 1000));
  return Math.exp(-hoursSinceExpiry / RESOURCE_DEPLETION_RECOVERY_HOURS);
}

function evaluateResourceLayerValue(layer, latitude, longitude, options = {}) {
  if (!isPlainObject(layer)) {
    return 0;
  }

  const normalizedLayer = normalizeResourceLayer(layer);
  const point = normalizeSurfacePoint(latitude, longitude);
  let value = normalizedLayer.background;

  for (const hotspot of normalizedLayer.hotspots) {
    const distance = sphericalDistance(point, hotspot);
    const radius = Math.max(0.01, hotspot.radius);
    value += hotspot.amplitude * Math.exp(-(distance * distance) / (2 * radius * radius));
  }

  const nowMs = normalizeInteger(options.nowMs, Date.now());
  for (const event of normalizedLayer.depletionEvents) {
    const timeFactor = getDepletionEventFactor(event, nowMs);
    if (timeFactor < 0.01) {
      continue;
    }

    for (const head of event.heads) {
      const headPoint = normalizeSurfacePoint(head[1], head[2]);
      const distance = sphericalDistance(point, headPoint);
      const radius = Math.max(0.01, event.depletionRadius);
      value -= event.strength * timeFactor *
        Math.exp(-(distance * distance) / (2 * radius * radius));
    }
  }

  return clamp(value, 0, PLANET_RESOURCE_MAX_VALUE) * getPlanetResourceAbundanceMultiplier();
}

function evaluateResourceValueAt(planetID, resourceTypeID, latitude, longitude, options = {}) {
  const layer = getResourceLayer(planetID, resourceTypeID, options);
  return evaluateResourceLayerValue(layer, latitude, longitude, options);
}

function pruneDepletionEvents(events = [], nowMs = Date.now()) {
  return (Array.isArray(events) ? events : [])
    .map((event) => normalizeResourceLayer({ depletionEvents: [event] }).depletionEvents[0])
    .filter((event) => event && getDepletionEventFactor(event, nowMs) >= 0.01)
    .slice(-RESOURCE_DEPLETION_EVENT_LIMIT);
}

function normalizeIDTuple(value) {
  const unwrapped = unwrapMarshalValue(value);
  if (!Array.isArray(unwrapped) || unwrapped.length < 2) {
    return null;
  }

  const namespace = normalizeInteger(unwrapped[0], 0);
  const localID = normalizeInteger(unwrapped[1], 0);
  if (namespace <= 0 || localID <= 0) {
    return null;
  }
  return [namespace, localID];
}

function temporaryIDKey(value) {
  const tuple = normalizeIDTuple(value);
  if (tuple) {
    return `tmp:${tuple[0]}:${tuple[1]}`;
  }

  const normalizedID = normalizeInteger(value, 0);
  return normalizedID > 0 ? `id:${normalizedID}` : null;
}

function isTemporaryID(value, namespace = null) {
  const tuple = normalizeIDTuple(value);
  if (!tuple) {
    return false;
  }
  return namespace === null || tuple[0] === namespace;
}

function collectUsedIDs(state, fieldName) {
  const usedIDs = new Set();
  for (const colony of Object.values(state.coloniesByKey || {})) {
    for (const pin of Array.isArray(colony && colony.pins) ? colony.pins : []) {
      if (fieldName === "pinID") {
        const pinID = normalizeInteger(pin && (pin.pinID ?? pin.id), 0);
        if (pinID > 0) {
          usedIDs.add(pinID);
        }
      }
    }
    for (const route of Array.isArray(colony && colony.routes) ? colony.routes : []) {
      if (fieldName === "routeID") {
        const routeID = normalizeInteger(route && route.routeID, 0);
        if (routeID > 0) {
          usedIDs.add(routeID);
        }
      }
    }
  }
  if (fieldName === "launchID") {
    for (const [key, launch] of Object.entries(state.launchesByID || {})) {
      const launchID = storedLaunchID(key, launch);
      if (launchID > 0) {
        usedIDs.add(launchID);
      }
    }
  }
  return usedIDs;
}

function allocateNextID(state, key, usedIDs = new Set()) {
  if (!isPlainObject(state.nextIDs)) {
    state.nextIDs = cloneJson(DEFAULT_NEXT_IDS);
  }

  const fallbackID = DEFAULT_NEXT_IDS[key] || 1;
  let candidate = normalizeInteger(state.nextIDs[key], fallbackID);
  if (candidate <= 0) {
    candidate = fallbackID;
  }

  while (usedIDs.has(candidate)) {
    candidate += 1;
  }

  usedIDs.add(candidate);
  state.nextIDs[key] = candidate + 1;
  return candidate;
}

function resolveSubmittedID(value, idMap) {
  const key = temporaryIDKey(value);
  if (key && idMap.has(key)) {
    return idMap.get(key);
  }

  const normalizedID = normalizeInteger(value, 0);
  return normalizedID > 0 ? normalizedID : 0;
}

function findPin(colony, pinID) {
  const normalizedPinID = normalizeInteger(pinID, 0);
  return (Array.isArray(colony.pins) ? colony.pins : [])
    .find((pin) => normalizeInteger(pin && (pin.pinID ?? pin.id), 0) === normalizedPinID) || null;
}

function normalizeContents(contents) {
  if (!isPlainObject(contents)) {
    return {};
  }

  const normalizedContents = {};
  for (const [typeID, quantity] of Object.entries(contents)) {
    const normalizedTypeID = normalizeInteger(typeID, 0);
    const normalizedQuantity = normalizeInteger(quantity, 0);
    if (normalizedTypeID > 0 && normalizedQuantity > 0) {
      normalizedContents[String(normalizedTypeID)] = normalizedQuantity;
    }
  }
  return normalizedContents;
}

function normalizeLaunchRecord(launch = {}) {
  const launchID = normalizeInteger(launch.launchID ?? launch.itemID, 0);
  return {
    ...launch,
    launchID,
    itemID: normalizeInteger(launch.itemID ?? launchID, launchID),
    ownerID: normalizeInteger(launch.ownerID, 0),
    planetID: normalizeInteger(launch.planetID, 0),
    solarSystemID: normalizeInteger(launch.solarSystemID, 0),
    commandPinID: normalizeInteger(launch.commandPinID, 0),
    launchTime: launch.launchTime ? String(launch.launchTime) : currentFileTimeString(),
    x: normalizeReal(launch.x, 0),
    y: normalizeReal(launch.y, 0),
    z: normalizeReal(launch.z, 0),
    contents: normalizeContents(launch.contents),
    deleted: launch.deleted === true,
    createdAt: launch.createdAt || new Date().toISOString(),
    updatedAt: launch.updatedAt || launch.createdAt || new Date().toISOString(),
  };
}

function isLaunchExpired(launch, nowFileTime = currentFileTime()) {
  const normalizedLaunch = normalizeLaunchRecord(launch);
  const launchTime = filetimeBigInt(normalizedLaunch.launchTime, nowFileTime);
  return nowFileTime - launchTime >= PI_LAUNCH_ORBIT_DECAY_TICKS;
}

function isLaunchCleanupEligible(launch, nowFileTime = currentFileTime(), maxAgeTicks = null) {
  const normalizedLaunch = normalizeLaunchRecord(launch);
  const launchTime = filetimeBigInt(normalizedLaunch.launchTime, nowFileTime);
  const cleanupAge = maxAgeTicks === null
    ? PI_LAUNCH_ORBIT_DECAY_TICKS + PI_LAUNCH_CLEANUP_GRACE_TICKS
    : BigInt(maxAgeTicks);
  return nowFileTime - launchTime >= cleanupAge;
}

function summarizeContents(contents = {}) {
  const normalizedContents = normalizeContents(contents);
  return Object.entries(normalizedContents)
    .map(([typeID, quantity]) => ({
      typeID: normalizeInteger(typeID, 0),
      quantity: normalizeInteger(quantity, 0),
    }))
    .sort((left, right) => left.typeID - right.typeID);
}

function normalizePin(pin = {}, ownerID = 0) {
  const pinID = normalizeInteger(pin.pinID ?? pin.id, 0);
  const typeID = normalizeInteger(pin.typeID, 0);
  const entityType = planetStaticData.getPinEntityType(typeID);
  const normalizedPin = {
    ...pin,
    id: pinID,
    pinID,
    ownerID: normalizeInteger(pin.ownerID ?? pin.charID, ownerID),
    typeID,
    latitude: normalizeReal(pin.latitude, 0),
    longitude: normalizeReal(pin.longitude, 0),
    lastRunTime: pin.lastRunTime ? String(pin.lastRunTime) : currentFileTimeString(),
    contents: normalizeContents(pin.contents),
    state: normalizeInteger(pin.state, STATE_IDLE),
  };

  if (entityType === "command" || entityType === "spaceport") {
    normalizedPin.lastLaunchTime = pin.lastLaunchTime ? String(pin.lastLaunchTime) : "0";
  }

  if (entityType === "process") {
    normalizedPin.schematicID = normalizeNullableInteger(pin.schematicID);
    // ProcessPin initializes both flags to true in the client. Preserve explicit
    // simulation state, but do not turn a newly-created/restored processor into
    // a never-primed pin merely because an older record omitted the fields.
    normalizedPin.hasReceivedInputs = pin.hasReceivedInputs === undefined ||
      pin.hasReceivedInputs === null
      ? true
      : pin.hasReceivedInputs === true;
    normalizedPin.receivedInputsLastCycle = pin.receivedInputsLastCycle === undefined ||
      pin.receivedInputsLastCycle === null
      ? true
      : pin.receivedInputsLastCycle === true;
  }

  if (entityType === "ecu") {
    normalizedPin.cycleTime = normalizeInteger(pin.cycleTime, 0);
    normalizedPin.programType = normalizeNullableInteger(pin.programType);
    normalizedPin.qtyPerCycle = normalizeInteger(pin.qtyPerCycle, 0);
    normalizedPin.expiryTime = pin.expiryTime ? String(pin.expiryTime) : null;
    normalizedPin.installTime = pin.installTime ? String(pin.installTime) : null;
    normalizedPin.headRadius = normalizeReal(pin.headRadius, RADIUS_DRILL_AREA_MIN);
    normalizedPin.heads = (Array.isArray(pin.heads) ? pin.heads : [])
      .map((head) => (Array.isArray(head) ? head : []))
      .map((head) => [
        normalizeInteger(head[0], 0),
        normalizeReal(head[1], normalizedPin.latitude),
        normalizeReal(head[2], normalizedPin.longitude),
      ])
      .sort((left, right) => left[0] - right[0]);
  }

  return normalizedPin;
}

function buildPin(pinID, typeID, ownerID, latitude, longitude) {
  const entityType = planetStaticData.getPinEntityType(typeID);
  if (!entityType || entityType === "link") {
    throw new Error(`Invalid PI pin typeID ${typeID}`);
  }

  return normalizePin({
    id: pinID,
    pinID,
    ownerID,
    typeID,
    latitude,
    longitude,
    lastRunTime: currentFileTimeString(),
    contents: {},
    state: STATE_IDLE,
  }, ownerID);
}

function buildLaunchCoordinates(planetMeta = {}, launchID = 0) {
  const position = isPlainObject(planetMeta.position) ? planetMeta.position : {};
  const baseX = normalizeReal(position.x ?? planetMeta.x, 0);
  const baseY = normalizeReal(position.y ?? planetMeta.y, 0);
  const baseZ = normalizeReal(position.z ?? planetMeta.z, 0);
  const radius = Math.max(0, normalizeReal(planetMeta.radius, 0));
  const distance = Math.max(radius + 2500000, 10000000);
  const seed = stableHash([
    planetMeta.planetID,
    planetMeta.ownerID,
    launchID,
    "planetary-launch",
  ]);
  const theta = hashRatio([seed, "theta"]) * Math.PI * 2;
  const phi = Math.acos((hashRatio([seed, "phi"]) * 2) - 1);
  return {
    x: Math.round(baseX + (Math.sin(phi) * Math.cos(theta) * distance)),
    y: Math.round(baseY + (Math.sin(phi) * Math.sin(theta) * distance)),
    z: Math.round(baseZ + (Math.cos(phi) * distance)),
  };
}

function normalizeColony(rawColony, context = {}) {
  const planetID = normalizeInteger(
    context.planetID ?? (rawColony && rawColony.planetID),
    0,
  );
  const ownerID = normalizeInteger(
    context.ownerID ?? (rawColony && rawColony.ownerID),
    0,
  );
  const now = currentFileTimeString();

  const colony = isPlainObject(rawColony) ? cloneJson(rawColony) : {};
  colony.planetID = planetID;
  colony.ownerID = ownerID;
  colony.solarSystemID = normalizeInteger(
    context.solarSystemID ?? colony.solarSystemID,
    0,
  );
  colony.planetTypeID = normalizeInteger(
    context.planetTypeID ?? colony.planetTypeID ?? colony.typeID,
    0,
  );
  colony.planetRadius = normalizeReal(context.planetRadius ?? colony.planetRadius, 0);
  colony.typeID = colony.planetTypeID;
  colony.level = normalizeInteger(colony.level ?? colony.commandCenterLevel, 0);
  colony.commandCenterLevel = colony.level;
  colony.networkRevision = Math.max(0, normalizeInteger(colony.networkRevision, 0));
  colony.currentSimTime = colony.currentSimTime ? String(colony.currentSimTime) : now;
  colony.createdAt = colony.createdAt || new Date().toISOString();
  colony.updatedAt = colony.updatedAt || colony.createdAt;
  colony.pins = (Array.isArray(colony.pins) ? colony.pins : [])
    .map((pin) => normalizePin(pin, ownerID))
    .filter((pin) => normalizeInteger(pin.pinID, 0) > 0);
  colony.links = (Array.isArray(colony.links) ? colony.links : [])
    .map((link) => {
      const endpoints = sortEndpoints(link && link.endpoint1, link && link.endpoint2);
      return {
        ...link,
        typeID: normalizeInteger(link && link.typeID, LINK_TYPE_ID),
        endpoint1: endpoints[0],
        endpoint2: endpoints[1],
        level: normalizeInteger(link && link.level, 0),
      };
    })
    .filter((link) => link.endpoint1 > 0 && link.endpoint2 > 0 && link.endpoint1 !== link.endpoint2);
  colony.routes = (Array.isArray(colony.routes) ? colony.routes : [])
    .map((route) => ({
      ...route,
      routeID: normalizeInteger(route && route.routeID, 0),
      charID: normalizeInteger(route && (route.charID ?? route.ownerID), ownerID),
      path: (Array.isArray(route && route.path) ? route.path : [])
        .map((pinID) => normalizeInteger(pinID, 0))
        .filter((pinID) => pinID > 0),
      commodityTypeID: normalizeInteger(route && (route.commodityTypeID ?? route.typeID), 0),
      commodityQuantity: normalizeInteger(route && (route.commodityQuantity ?? route.quantity), 0),
    }))
    .filter((route) => route.routeID > 0 && route.path.length >= 2);

  return colony;
}

function getPinEntityType(pin) {
  return planetStaticData.getPinEntityType(pin && pin.typeID);
}

function isStorageEntityType(entityType) {
  return entityType === "storage" || entityType === "spaceport" || entityType === "command";
}

function isProducerEntityType(entityType) {
  return entityType === "ecu" || entityType === "extractor" || entityType === "process";
}

function isConsumerEntityType(entityType) {
  return entityType === "process";
}

function getCommandPin(colony) {
  return (Array.isArray(colony && colony.pins) ? colony.pins : [])
    .find((pin) => getPinEntityType(pin) === "command") || null;
}

function assertCommandCenterPresent(colony) {
  if (!getCommandPin(colony)) {
    throw new Error("CannotManagePlanetWithoutCommandCenter");
  }
}

function assertPinOwnedBy(pin, ownerID, errorMsg = "CanOnlyManageOwnPins") {
  if (normalizeInteger(pin && pin.ownerID, 0) !== normalizeInteger(ownerID, 0)) {
    throw new Error(errorMsg);
  }
}

function validatePinTypeForCreate(colony, typeID, context = {}) {
  const normalizedTypeID = normalizeInteger(typeID, 0);
  const entityType = planetStaticData.getPinEntityType(normalizedTypeID);
  if (!entityType || entityType === "link") {
    throw new Error("InvalidPinType");
  }

  if (entityType === "command") {
    if (getCommandPin(colony)) {
      throw new Error("CannotBuildMultipleCommandPins");
    }
  } else {
    assertCommandCenterPresent(colony);
  }

  const typeInfo = planetStaticData.getPITypeInfo(normalizedTypeID);
  const planetRestrictionTypeID = normalizeInteger(
    typeInfo && typeInfo.planetRestrictionTypeID,
    0,
  );
  const planetTypeID = normalizeInteger(context.planetTypeID, 0);
  if (
    planetRestrictionTypeID > 0 &&
    planetTypeID > 0 &&
    planetRestrictionTypeID !== planetTypeID
  ) {
    throw new Error("CannotCreatePinWrongPlanetType");
  }
}

// Read per call rather than cached at module load so a config reload or a test override takes
// effect without restarting the process.
function getSchematicOutputMultiplier() {
  const configuredValue = config.planetSchematicOutputMultiplier;
  // Number(null) and Number("") are both 0, so an unset or blank config value would silently
  // stop every factory. Treat those as "not configured".
  if (configuredValue === null || configuredValue === undefined || configuredValue === "") {
    return 1;
  }
  const multiplier = Number(configuredValue);
  return Number.isFinite(multiplier) && multiplier > 0 ? multiplier : 1;
}

// Round to the nearest whole unit and never let a positive schematic output round away to
// nothing: a factory that consumes its inputs every cycle and produces zero reads as a broken
// colony, not as a setting. The four schematic output quantities are 20 (P1), 5 (P2), 3 (P3)
// and 1 (P4), so the clamp only ever bites on P3/P4 at multipliers well below 0.5.
function scaleSchematicOutput(quantity) {
  const base = normalizeInteger(quantity, 0);
  if (base <= 0) {
    return 0;
  }
  const multiplier = getSchematicOutputMultiplier();
  return multiplier === 1 ? base : Math.max(1, Math.round(base * multiplier));
}

function getPinProducts(pin) {
  const entityType = getPinEntityType(pin);
  if (entityType === "ecu") {
    const programType = normalizeNullableInteger(pin && pin.programType);
    const qtyPerCycle = normalizeInteger(pin && pin.qtyPerCycle, 0);
    const cycleTime = normalizeInteger(pin && pin.cycleTime, 0);
    const noiseFactor = Math.max(
      0,
      getEcuAttribute(
        pin && pin.typeID,
        planetStaticData.ATTRIBUTE.ECU_NOISE_FACTOR,
        0,
      ),
    );
    const cycleOutput = cycleTime > 0
      ? Math.trunc((1 + noiseFactor) * qtyPerCycle) * (cycleTime / SECOND_TICKS) / 900
      : qtyPerCycle;
    // The client exposes the ECU's maximum noisy cycle, not qtyPerCycle, as
    // the amount that may be reserved by routes.
    return programType && cycleOutput > 0
      ? { [String(programType)]: Math.floor(cycleOutput) }
      : {};
  }

  if (entityType === "process") {
    const schematic = getProcessSchematic(pin);
    return Object.fromEntries(
      (schematic && Array.isArray(schematic.outputs) ? schematic.outputs : [])
        .map((output) => [
          String(normalizeInteger(output.typeID, 0)),
          // For a processor this is the route-creation cap, not the production figure. Take
          // whichever of the retail and scaled quantities is larger: the client caps its own
          // route amount at the retail output and pre-validates locally, so a multiplier below
          // 1 must not make the server reject a route the client was allowed to submit, and
          // lowering the multiplier later must not strand an existing colony behind
          // CreateRouteCommodityProductionTooSmall on every subsequent edit.
          Math.max(
            normalizeInteger(output.quantity, 0),
            scaleSchematicOutput(output.quantity),
          ),
        ])
        .filter(([typeID, quantity]) => normalizeInteger(typeID, 0) > 0 && quantity > 0),
    );
  }

  return {};
}

function getPinConsumables(pin) {
  if (!isConsumerEntityType(getPinEntityType(pin))) {
    return {};
  }
  const schematic = getProcessSchematic(pin);
  return Object.fromEntries(
    (schematic && Array.isArray(schematic.inputs) ? schematic.inputs : [])
      .map((input) => [
        String(normalizeInteger(input.typeID, 0)),
        normalizeInteger(input.quantity, 0),
      ])
      .filter(([typeID, quantity]) => normalizeInteger(typeID, 0) > 0 && quantity > 0),
  );
}

function assertSurfacePointInRange(latitude, longitude) {
  const normalizedLatitude = normalizeReal(latitude, Number.NaN);
  const normalizedLongitude = normalizeReal(longitude, Number.NaN);
  if (
    !Number.isFinite(normalizedLatitude) ||
    normalizedLatitude < 0 ||
    normalizedLatitude > Math.PI
  ) {
    throw new Error("Invalid value for latitude - must be between 0..pi");
  }
  if (
    !Number.isFinite(normalizedLongitude) ||
    normalizedLongitude < 0 ||
    normalizedLongitude > Math.PI * 2
  ) {
    throw new Error("Invalid value for longitude - must be between 0..2pi");
  }
}

function findExtractorHead(pin, headID) {
  const normalizedHeadID = normalizeInteger(headID, 0);
  return (Array.isArray(pin && pin.heads) ? pin.heads : [])
    .find((head) => normalizeInteger(head && head[0], 0) === normalizedHeadID) || null;
}

function assertExtractorPin(pin, ownerID) {
  if (!pin) {
    throw new Error("PinDoesNotExist");
  }
  assertPinOwnedBy(pin, ownerID);
  if (getPinEntityType(pin) !== "ecu") {
    throw new Error("PinDoesNotHaveHeads");
  }
}

function assertExtractorHeadWithinArea(pin, latitude, longitude) {
  const areaOfInfluence = getEcuAttribute(
    pin && pin.typeID,
    planetStaticData.ATTRIBUTE.ECU_AREA_OF_INFLUENCE,
    0,
  );
  if (!(areaOfInfluence > 0)) {
    return;
  }

  const distance = sphericalDistance(
    normalizeSurfacePoint(pin.latitude, pin.longitude),
    normalizeSurfacePoint(latitude, longitude),
  );
  if (distance > areaOfInfluence) {
    throw new Error("CannotPlaceHeadTooFarAway");
  }
}

function getTypeVolume(typeID) {
  const type = planetStaticData.getType(typeID);
  const volume = Number(type && type.volume);
  return Number.isFinite(volume) && volume > 0 ? volume : 0;
}

function getPinCapacity(pin) {
  if (!isStorageEntityType(getPinEntityType(pin))) {
    return 0;
  }

  const info = planetStaticData.getPITypeInfo(pin && pin.typeID);
  const capacity = Number(info && info.capacity);
  return Number.isFinite(capacity) && capacity >= 0 ? capacity : Infinity;
}

function getPinUsedVolume(pin) {
  const contents = normalizeContents(pin && pin.contents);
  return Object.entries(contents).reduce((total, [typeID, quantity]) => (
    total + (getTypeVolume(typeID) * quantity)
  ), 0);
}

function getPinFreeSpace(pin) {
  const capacity = getPinCapacity(pin);
  if (capacity === Infinity) {
    return Infinity;
  }
  return Math.max(0, capacity - getPinUsedVolume(pin));
}

function getPinCycleTime(pin) {
  const entityType = getPinEntityType(pin);
  if (entityType === "ecu") {
    return Math.max(0, normalizeInteger(pin && pin.cycleTime, 0));
  }
  if (entityType === "process") {
    const schematic = planetStaticData.getSchematicByID(pin && pin.schematicID);
    return schematic ? Math.max(1, schematic.cycleTime * SECOND_TICKS) : 0;
  }
  return 0;
}

function getContentsQuantity(pin, typeID) {
  const key = String(normalizeInteger(typeID, 0));
  return normalizeInteger(pin && pin.contents && pin.contents[key], 0);
}

function setContentsQuantity(pin, typeID, quantity) {
  if (!pin) {
    return;
  }
  const key = String(normalizeInteger(typeID, 0));
  const normalizedQuantity = normalizeInteger(quantity, 0);
  pin.contents = normalizeContents(pin.contents);
  if (normalizedQuantity > 0) {
    pin.contents[key] = normalizedQuantity;
  } else {
    delete pin.contents[key];
  }
}

function getProcessSchematic(pin) {
  if (getPinEntityType(pin) !== "process") {
    return null;
  }
  return planetStaticData.getSchematicByID(pin && pin.schematicID);
}

function installProcessSchematic(pin, schematicID) {
  const schematic = planetStaticData.getSchematicByID(schematicID);
  if (!pin || getPinEntityType(pin) !== "process" || !schematic) {
    return false;
  }

  const previousContents = normalizeContents(pin.contents);
  const retainedContents = {};
  for (const input of schematic.inputs) {
    const retainedQuantity = Math.min(
      normalizeInteger(previousContents[String(input.typeID)], 0),
      input.quantity,
    );
    if (retainedQuantity > 0) {
      retainedContents[String(input.typeID)] = retainedQuantity;
    }
  }

  pin.schematicID = schematic.schematicID;
  pin.contents = retainedContents;
  pin.state = STATE_IDLE;
  // ClientColony.InstallSchematicForPin stimulates the consumer after replacing
  // its schematic. Preserve that serialized signal; the simulator still requires
  // a complete retained/routed batch before it can actually activate the pin.
  pin.hasReceivedInputs = true;
  return true;
}

function getProcessDemand(pin, typeID) {
  const schematic = getProcessSchematic(pin);
  const normalizedTypeID = normalizeInteger(typeID, 0);
  return schematic
    ? schematic.inputs.find((entry) => entry.typeID === normalizedTypeID) || null
    : null;
}

function getProcessCycleTime(pin) {
  const schematic = getProcessSchematic(pin);
  return schematic ? Math.max(1, schematic.cycleTime * SECOND_TICKS) : 0;
}

function getAcceptableQuantity(pin, typeID, desiredQuantity) {
  const desired = normalizeInteger(desiredQuantity, 0);
  if (!pin || desired <= 0) {
    return 0;
  }

  const entityType = getPinEntityType(pin);
  if (entityType === "process") {
    const demand = getProcessDemand(pin, typeID);
    if (!demand) {
      return 0;
    }
    return Math.min(
      desired,
      Math.max(0, demand.quantity - getContentsQuantity(pin, typeID)),
    );
  }

  if (!isStorageEntityType(entityType)) {
    return 0;
  }

  const volume = getTypeVolume(typeID);
  if (volume <= 0) {
    return desired;
  }
  const freeSpace = getPinFreeSpace(pin);
  if (freeSpace === Infinity) {
    return desired;
  }
  return Math.min(desired, Math.max(0, Math.floor((freeSpace + 1e-9) / volume)));
}

function addCommodityToPin(pin, typeID, quantity) {
  const acceptedQuantity = getAcceptableQuantity(pin, typeID, quantity);
  if (acceptedQuantity <= 0) {
    return 0;
  }

  setContentsQuantity(
    pin,
    typeID,
    getContentsQuantity(pin, typeID) + acceptedQuantity,
  );
  if (getPinEntityType(pin) === "process") {
    pin.hasReceivedInputs = true;
  }
  return acceptedQuantity;
}

function removeCommodityFromPin(pin, typeID, quantity) {
  const removedQuantity = Math.min(
    getContentsQuantity(pin, typeID),
    Math.max(0, normalizeInteger(quantity, 0)),
  );
  if (removedQuantity <= 0) {
    return 0;
  }

  setContentsQuantity(
    pin,
    typeID,
    getContentsQuantity(pin, typeID) - removedQuantity,
  );
  return removedQuantity;
}

function hasEnoughProcessInputs(pin) {
  const schematic = getProcessSchematic(pin);
  return Boolean(
    schematic &&
    schematic.inputs.every((input) => getContentsQuantity(pin, input.typeID) >= input.quantity),
  );
}

function consumeProcessInputs(pin) {
  const schematic = getProcessSchematic(pin);
  if (!schematic) {
    return false;
  }
  if (!hasEnoughProcessInputs(pin)) {
    return false;
  }

  for (const input of schematic.inputs) {
    removeCommodityFromPin(pin, input.typeID, input.quantity);
  }
  return true;
}

function activateProcessPin(pin, runTime) {
  if (!pin || getPinEntityType(pin) !== "process" || pin.state === STATE_ACTIVE) {
    return false;
  }
  if (!consumeProcessInputs(pin)) {
    return false;
  }

  pin.state = STATE_ACTIVE;
  pin.receivedInputsLastCycle = pin.hasReceivedInputs === true;
  pin.hasReceivedInputs = false;
  pin.lastRunTime = runTime.toString();
  return true;
}

function runProcessCycle(pin, runTime) {
  const schematic = getProcessSchematic(pin);
  if (!schematic || pin.state !== STATE_ACTIVE) {
    return {};
  }

  const products = {};
  for (const output of schematic.outputs) {
    const quantity = scaleSchematicOutput(output.quantity);
    if (quantity <= 0) {
      continue;
    }
    products[String(output.typeID)] = (products[String(output.typeID)] || 0) + quantity;
  }

  pin.lastRunTime = runTime.toString();
  if (consumeProcessInputs(pin)) {
    pin.state = STATE_ACTIVE;
  } else {
    pin.state = STATE_IDLE;
  }
  pin.receivedInputsLastCycle = pin.hasReceivedInputs === true;
  pin.hasReceivedInputs = false;
  return products;
}

function runEcuCycle(pin, runTime) {
  if (
    !pin ||
    getPinEntityType(pin) !== "ecu" ||
    pin.state !== STATE_ACTIVE ||
    !pin.programType ||
    normalizeInteger(pin.qtyPerCycle, 0) <= 0
  ) {
    return {};
  }

  const expiryTime = filetimeBigInt(pin.expiryTime, null);
  if (expiryTime !== null && runTime > expiryTime) {
    pin.state = STATE_IDLE;
    return {};
  }

  pin.lastRunTime = runTime.toString();
  if (expiryTime !== null && runTime >= expiryTime) {
    pin.state = STATE_IDLE;
  }

  return {
    [String(pin.programType)]: getEcuProgramOutput(pin, runTime),
  };
}

function repairNonPositiveEcuPrograms(colony) {
  let changed = false;
  for (const pin of Array.isArray(colony && colony.pins) ? colony.pins : []) {
    if (
      getPinEntityType(pin) === "ecu" &&
      pin.state === STATE_ACTIVE &&
      normalizeInteger(pin.qtyPerCycle, 0) <= 0
    ) {
      // EcuPin.InstallProgram never activates a nonpositive quote. Repair old,
      // malformed records immediately while retaining their configuration so
      // Restart Extractors may try the same layout again later.
      pin.state = STATE_IDLE;
      changed = true;
    }
  }
  return changed;
}

function getEcuProgramOutput(pin, runTime) {
  const baseValue = Math.max(0, normalizeInteger(pin && pin.qtyPerCycle, 0));
  const cycleTime = Math.max(0, normalizeInteger(pin && pin.cycleTime, 0));
  if (baseValue <= 0 || cycleTime <= 0) {
    return 0;
  }

  const currentTime = filetimeBigInt(runTime, 0n);
  const startTime = filetimeBigInt(
    pin && pin.installTime,
    filetimeBigInt(pin && pin.lastRunTime, currentTime),
  );
  const elapsedTicks = Number(currentTime - startTime);
  const cycleNumber = Math.max(
    Math.floor((elapsedTicks + SECOND_TICKS) / cycleTime) - 1,
    0,
  );
  const barWidth = (cycleTime / SECOND_TICKS) / 900;
  const t = (cycleNumber + 0.5) * barWidth;
  const decayFactor = getEcuAttribute(
    pin && pin.typeID,
    planetStaticData.ATTRIBUTE.ECU_DECAY_FACTOR,
    0,
  );
  const noiseFactor = getEcuAttribute(
    pin && pin.typeID,
    planetStaticData.ATTRIBUTE.ECU_NOISE_FACTOR,
    0,
  );
  const decayValue = baseValue / (1 + (t * decayFactor));
  const phaseShift = baseValue ** 0.7;
  const noiseWave = Math.max(0, (
    Math.cos(phaseShift + (t / 12)) +
    Math.cos((phaseShift / 2) + (t / 5)) +
    Math.cos(t / 2)
  ) / 3);
  return Math.max(0, Math.trunc(
    barWidth * decayValue * (1 + (noiseFactor * noiseWave)),
  ));
}

function getRouteSourceID(route) {
  return Array.isArray(route && route.path) && route.path.length > 0
    ? normalizeInteger(route.path[0], 0)
    : 0;
}

function getRouteDestinationID(route) {
  return Array.isArray(route && route.path) && route.path.length > 0
    ? normalizeInteger(route.path[route.path.length - 1], 0)
    : 0;
}

function getProcessInputBufferState(pin) {
  const schematic = getProcessSchematic(pin);
  if (!schematic || !Array.isArray(schematic.inputs) || schematic.inputs.length < 1) {
    return 1;
  }

  const filledRatio = schematic.inputs.reduce((total, input) => (
    total + (getContentsQuantity(pin, input.typeID) / input.quantity)
  ), 0);
  return 1 - (filledRatio / schematic.inputs.length);
}

function compareOutputRouteEntries(left, right) {
  if (left.priority !== right.priority) {
    return left.priority - right.priority;
  }
  if (left.destinationPinID !== right.destinationPinID) {
    return left.destinationPinID - right.destinationPinID;
  }
  if (left.commodityTypeID !== right.commodityTypeID) {
    return left.commodityTypeID - right.commodityTypeID;
  }
  return left.commodityQuantity - right.commodityQuantity;
}

function getSortedOutputRoutes(colony, sourcePinID, commodities = {}, outputScale = 1) {
  const normalizedSourcePinID = normalizeInteger(sourcePinID, 0);
  const availableCommodities = normalizeContents(commodities);
  const aggregatedRoutes = new Map();

  for (const route of Array.isArray(colony.routes) ? colony.routes : []) {
    const commodityTypeID = normalizeInteger(route && route.commodityTypeID, 0);
    const destinationPinID = getRouteDestinationID(route);
    const quantity = normalizeInteger(route && route.commodityQuantity, 0);
    if (
      getRouteSourceID(route) !== normalizedSourcePinID ||
      quantity <= 0 ||
      !Object.prototype.hasOwnProperty.call(availableCommodities, String(commodityTypeID))
    ) {
      continue;
    }

    // These are throwaway copies used to plan this one cycle's deliveries, so scaling them
    // leaves the persisted route rows - and the link bandwidth computed from them - on the
    // retail numbers the client agreed to. Ceil rather than round so the scaled routes can
    // always absorb the scaled production; they can never over-deliver, because
    // routeCommodityOutput still caps every move at what was actually produced.
    const scaledQuantity = outputScale === 1
      ? quantity
      : Math.ceil(quantity * outputScale);

    const key = `${destinationPinID}:${commodityTypeID}`;
    const existing = aggregatedRoutes.get(key);
    if (existing) {
      existing.commodityQuantity += scaledQuantity;
    } else {
      aggregatedRoutes.set(key, {
        path: [normalizedSourcePinID, destinationPinID],
        destinationPinID,
        commodityTypeID,
        commodityQuantity: scaledQuantity,
      });
    }
  }

  const processorRoutes = [];
  const storageRoutes = [];
  for (const route of aggregatedRoutes.values()) {
    const destinationPin = findPin(colony, route.destinationPinID);
    if (!destinationPin) {
      continue;
    }
    if (getPinEntityType(destinationPin) === "process") {
      processorRoutes.push({
        ...route,
        priority: getProcessInputBufferState(destinationPin),
      });
    } else if (isStorageEntityType(getPinEntityType(destinationPin))) {
      storageRoutes.push({
        ...route,
        priority: getPinFreeSpace(destinationPin),
      });
    }
  }

  processorRoutes.sort(compareOutputRouteEntries);
  storageRoutes.sort(compareOutputRouteEntries);
  return [processorRoutes, storageRoutes];
}

function getDestinationRoutes(colony, destinationPinID, commodityTypeID = 0) {
  const normalizedDestinationPinID = normalizeInteger(destinationPinID, 0);
  const normalizedCommodityTypeID = normalizeInteger(commodityTypeID, 0);
  return (Array.isArray(colony.routes) ? colony.routes : [])
    .filter((route) => (
      getRouteDestinationID(route) === normalizedDestinationPinID &&
      normalizeInteger(route.commodityQuantity, 0) > 0 &&
      (
        normalizedCommodityTypeID <= 0 ||
        normalizeInteger(route.commodityTypeID, 0) === normalizedCommodityTypeID
      )
    ))
    .sort((left, right) => normalizeInteger(left.routeID, 0) - normalizeInteger(right.routeID, 0));
}

function moveCommodityOverRoute(colony, route, sourcePin, typeID, maxQuantity, options = {}) {
  const destinationPin = findPin(colony, getRouteDestinationID(route));
  if (!destinationPin) {
    return { movedQuantity: 0, destinationPin: null };
  }

  const routeQuantity = normalizeInteger(route.commodityQuantity, 0);
  let quantity = Math.min(normalizeInteger(maxQuantity, 0), routeQuantity);
  if (options.consumeSource === true) {
    quantity = Math.min(quantity, getContentsQuantity(sourcePin, typeID));
  }
  if (quantity <= 0) {
    return { movedQuantity: 0, destinationPin };
  }

  const movedQuantity = addCommodityToPin(destinationPin, typeID, quantity);
  if (movedQuantity > 0 && options.consumeSource === true) {
    removeCommodityFromPin(sourcePin, typeID, movedQuantity);
  }
  return { movedQuantity, destinationPin };
}

function routeCommodityOutput(colony, sourcePin, commodities = {}, options = {}) {
  if (!sourcePin || !isPlainObject(commodities) || normalizeInteger(options.depth, 0) > 8) {
    return 0;
  }

  const sourceConsumes = options.consumeSource === true;
  let movedTotal = 0;
  const remainingCommodities = normalizeContents(commodities);
  const storageAdditionsByPinID = new Map();
  // A factory's output route is one cycle's worth of product, so it has to grow with the output
  // it carries or the surplus is dropped below. Only processors scale: storage pass-through
  // routes just forward what the pin already holds. Never scale below 1 - the client caps route
  // quantities at the retail schematic output, so a multiplier under 1 must not shrink a route
  // the player was allowed to create (production is the binding constraint there anyway).
  const outputScale = getPinEntityType(sourcePin) === "process"
    ? Math.max(1, getSchematicOutputMultiplier())
    : 1;
  const routeGroups = getSortedOutputRoutes(
    colony,
    sourcePin.pinID,
    remainingCommodities,
    outputScale,
  );

  for (let groupIndex = 0; groupIndex < routeGroups.length; groupIndex += 1) {
    const routes = routeGroups[groupIndex];
    for (let routeIndex = 0; routeIndex < routes.length; routeIndex += 1) {
      const route = routes[routeIndex];
      const typeID = route.commodityTypeID;
      const typeKey = String(typeID);
      let maxQuantity = normalizeInteger(remainingCommodities[typeKey], 0);
      if (sourceConsumes) {
        maxQuantity = Math.min(maxQuantity, getContentsQuantity(sourcePin, typeID));
      }
      if (groupIndex === 1) {
        maxQuantity = Math.min(
          maxQuantity,
          Math.ceil(maxQuantity / (routes.length - routeIndex)),
        );
      }
      if (maxQuantity <= 0) {
        continue;
      }

      const { movedQuantity, destinationPin } = moveCommodityOverRoute(
        colony,
        route,
        sourcePin,
        typeID,
        maxQuantity,
        { consumeSource: sourceConsumes },
      );
      if (movedQuantity <= 0) {
        continue;
      }

      movedTotal += movedQuantity;
      remainingCommodities[typeKey] -= movedQuantity;
      if (remainingCommodities[typeKey] <= 0) {
        delete remainingCommodities[typeKey];
      }

      if (
        destinationPin &&
        isStorageEntityType(getPinEntityType(destinationPin)) &&
        !isStorageEntityType(getPinEntityType(sourcePin))
      ) {
        const destinationPinID = normalizeInteger(destinationPin.pinID, 0);
        if (!storageAdditionsByPinID.has(destinationPinID)) {
          storageAdditionsByPinID.set(destinationPinID, {});
        }
        const additions = storageAdditionsByPinID.get(destinationPinID);
        additions[typeKey] = (additions[typeKey] || 0) + movedQuantity;
      }
    }

    if (Object.keys(remainingCommodities).length < 1) {
      break;
    }
  }

  for (const [destinationPinID, additions] of storageAdditionsByPinID.entries()) {
    const destinationPin = findPin(colony, destinationPinID);
    routeCommodityOutput(
      colony,
      destinationPin,
      additions,
      { consumeSource: true, depth: normalizeInteger(options.depth, 0) + 1 },
    );
  }
  return movedTotal;
}

function repairEcuSourceRoutes(colony) {
  const routes = Array.isArray(colony && colony.routes) ? colony.routes : [];
  if (routes.length < 1) {
    return false;
  }

  const routeQuantities = new Map();
  const routeIDsToRemove = new Set();
  const ecuPins = (Array.isArray(colony.pins) ? colony.pins : [])
    .filter((pin) => getPinEntityType(pin) === "ecu")
    .sort((left, right) => normalizeInteger(left.pinID, 0) - normalizeInteger(right.pinID, 0));

  for (const ecuPin of ecuPins) {
    const ecuPinID = normalizeInteger(ecuPin.pinID, 0);
    const sourceRoutes = routes
      .filter((route) => getRouteSourceID(route) === ecuPinID)
      .sort((left, right) => normalizeInteger(left.routeID, 0) - normalizeInteger(right.routeID, 0));
    if (sourceRoutes.length < 1) {
      continue;
    }

    const programTypeID = normalizeNullableInteger(ecuPin.programType);
    if (!programTypeID) {
      continue;
    }
    const productQuantity = normalizeInteger(
      getPinProducts(ecuPin)[String(programTypeID)],
      0,
    );
    const processRoutes = [];
    const storageRoutes = [];

    for (const route of sourceRoutes) {
      const routeID = normalizeInteger(route.routeID, 0);
      const destinationPin = findPin(colony, getRouteDestinationID(route));
      const destinationType = getPinEntityType(destinationPin);
      if (
        normalizeInteger(route.commodityTypeID, 0) !== programTypeID ||
        (!isConsumerEntityType(destinationType) && !isStorageEntityType(destinationType)) ||
        (
          isConsumerEntityType(destinationType) &&
          normalizeInteger(getPinConsumables(destinationPin)[String(programTypeID)], 0) <= 0
        )
      ) {
        routeIDsToRemove.add(routeID);
      } else if (isConsumerEntityType(destinationType)) {
        processRoutes.push(route);
      } else {
        storageRoutes.push(route);
      }
    }

    // The current client recreates processor routes first when a program is
    // installed, preserving their former quantities until output is exhausted.
    let quantityRemaining = productQuantity;
    for (const route of processRoutes) {
      const routeID = normalizeInteger(route.routeID, 0);
      const quantity = Math.min(
        normalizeInteger(route.commodityQuantity, 0),
        quantityRemaining,
      );
      if (quantity <= 0) {
        routeIDsToRemove.add(routeID);
        continue;
      }
      routeQuantities.set(routeID, quantity);
      quantityRemaining -= quantity;
    }

    // Any remainder is shared proportionally among storage routes, mirroring
    // clientPlanet.InstallProgram's route-recreation policy.
    const formerStorageQuantity = storageRoutes.reduce((total, route) => (
      total + normalizeInteger(route.commodityQuantity, 0)
    ), 0);
    const storageQuantityLimit = Math.min(quantityRemaining, formerStorageQuantity);
    let storageQuantityAssigned = 0;
    let roundingRemainder = 0;
    for (let index = 0; index < storageRoutes.length; index += 1) {
      const route = storageRoutes[index];
      const routeID = normalizeInteger(route.routeID, 0);
      const formerQuantity = normalizeInteger(route.commodityQuantity, 0);
      const isLastRoute = index === storageRoutes.length - 1;
      const quantityAvailable = storageQuantityLimit - storageQuantityAssigned;
      let quantity = 0;
      if (formerStorageQuantity > 0 && quantityAvailable > 0) {
        if (isLastRoute) {
          quantity = quantityAvailable;
        } else {
          const proportionalQuantity =
            (formerQuantity / formerStorageQuantity) * storageQuantityLimit;
          quantity = Math.round(proportionalQuantity);
          roundingRemainder += proportionalQuantity - quantity;
          const roundingAdjustment = Math.round(roundingRemainder);
          quantity += roundingAdjustment;
          roundingRemainder -= roundingAdjustment;
          quantity = Math.min(formerQuantity, quantityAvailable, Math.max(0, quantity));
        }
      }
      if (quantity <= 0) {
        routeIDsToRemove.add(routeID);
        continue;
      }
      routeQuantities.set(routeID, quantity);
      storageQuantityAssigned += quantity;
    }
  }

  let changed = false;
  colony.routes = routes.filter((route) => {
    const routeID = normalizeInteger(route.routeID, 0);
    if (routeIDsToRemove.has(routeID)) {
      changed = true;
      return false;
    }
    if (routeQuantities.has(routeID)) {
      const quantity = routeQuantities.get(routeID);
      if (normalizeInteger(route.commodityQuantity, 0) !== quantity) {
        route.commodityQuantity = quantity;
        changed = true;
      }
    }
    return true;
  });
  return changed;
}

function routeCommodityInput(colony, processPin) {
  const schematic = getProcessSchematic(processPin);
  if (!schematic) {
    return 0;
  }

  let movedTotal = 0;
  for (const input of schematic.inputs) {
    let missingQuantity = Math.max(
      0,
      input.quantity - getContentsQuantity(processPin, input.typeID),
    );
    if (missingQuantity <= 0) {
      continue;
    }

    for (const route of getDestinationRoutes(colony, processPin.pinID, input.typeID)) {
      if (missingQuantity <= 0) {
        break;
      }

      const sourcePin = findPin(colony, getRouteSourceID(route));
      if (!sourcePin || !isStorageEntityType(getPinEntityType(sourcePin))) {
        continue;
      }

      const { movedQuantity } = moveCommodityOverRoute(
        colony,
        route,
        sourcePin,
        input.typeID,
        missingQuantity,
        { consumeSource: true },
      );
      movedTotal += movedQuantity;
      missingQuantity -= movedQuantity;
    }
  }
  return movedTotal;
}

function primeReadyProcessors(colony, runTime) {
  let changed = false;
  for (const pin of Array.isArray(colony.pins) ? colony.pins : []) {
    if (getPinEntityType(pin) !== "process" || pin.state === STATE_ACTIVE) {
      continue;
    }

    if (routeCommodityInput(colony, pin) > 0) {
      changed = true;
    }
    if (activateProcessPin(pin, runTime)) {
      changed = true;
      // EvaluatePin routes inputs again immediately after the idle processor
      // consumes its first batch, leaving one future batch reserved in-buffer.
      if (routeCommodityInput(colony, pin) > 0) {
        changed = true;
      }
    }
  }
  return changed;
}

function stimulateIdlePin(colony, pin, runTime) {
  if (!pin) {
    return false;
  }

  let changed = false;
  const entityType = getPinEntityType(pin);
  if (isStorageEntityType(entityType)) {
    changed = routeCommodityOutput(
      colony,
      pin,
      normalizeContents(pin.contents),
      { consumeSource: true },
    ) > 0;
  }
  if (entityType === "process") {
    pin.hasReceivedInputs = true;
    changed = true;
  }
  return primeReadyProcessors(colony, runTime) || changed;
}

function getNextPinRunTime(pin, targetTime) {
  const entityType = getPinEntityType(pin);
  if (entityType === "ecu") {
    if (
      pin.state !== STATE_ACTIVE ||
      !pin.programType ||
      normalizeInteger(pin.cycleTime, 0) <= 0 ||
      normalizeInteger(pin.qtyPerCycle, 0) <= 0
    ) {
      return null;
    }

    const nextRunTime = filetimeBigInt(pin.lastRunTime, targetTime) +
      BigInt(normalizeInteger(pin.cycleTime, 0));
    const expiryTime = filetimeBigInt(pin.expiryTime, null);
    if (expiryTime !== null && nextRunTime > expiryTime) {
      return null;
    }
    return nextRunTime < targetTime ? nextRunTime : null;
  }

  if (entityType === "process" && pin.state === STATE_ACTIVE) {
    const cycleTime = getProcessCycleTime(pin);
    if (cycleTime <= 0) {
      return null;
    }
    const nextRunTime = filetimeBigInt(pin.lastRunTime, targetTime) + BigInt(cycleTime);
    return nextRunTime < targetTime ? nextRunTime : null;
  }

  return null;
}

function getNextSimulationEvent(colony, targetTime) {
  let nextEvent = null;
  for (const pin of Array.isArray(colony.pins) ? colony.pins : []) {
    const nextRunTime = getNextPinRunTime(pin, targetTime);
    if (nextRunTime === null) {
      continue;
    }
    if (
      !nextEvent ||
      nextRunTime < nextEvent.runTime ||
      (
        nextRunTime === nextEvent.runTime &&
        normalizeInteger(pin.pinID, 0) < normalizeInteger(nextEvent.pinID, 0)
      )
    ) {
      nextEvent = {
        pinID: normalizeInteger(pin.pinID, 0),
        runTime: nextRunTime,
      };
    }
  }
  return nextEvent;
}

function runColonySimulation(rawColony, targetFileTime = currentFileTimeString(), context = {}) {
  const colony = normalizeColony(rawColony, context);
  const targetTime = filetimeBigInt(targetFileTime, currentFileTime());
  let simulationTime = filetimeBigInt(colony.currentSimTime, targetTime);
  const repairedPrograms = repairNonPositiveEcuPrograms(colony);
  const repairedRoutes = repairEcuSourceRoutes(colony);
  if (targetTime <= simulationTime) {
    if (repairedPrograms || repairedRoutes) {
      colony.updatedAt = new Date().toISOString();
    }
    return { colony, changed: repairedPrograms || repairedRoutes };
  }

  const primedProcessors = primeReadyProcessors(colony, simulationTime);
  let changed = repairedPrograms || repairedRoutes || primedProcessors;
  let eventCount = 0;
  while (eventCount < MAX_SIMULATION_EVENTS) {
    const event = getNextSimulationEvent(colony, targetTime);
    if (!event) {
      break;
    }

    simulationTime = event.runTime;
    colony.currentSimTime = simulationTime.toString();
    const pin = findPin(colony, event.pinID);
    if (!pin) {
      break;
    }

    const entityType = getPinEntityType(pin);
    let products = {};
    if (entityType === "ecu") {
      products = runEcuCycle(pin, simulationTime);
    } else if (entityType === "process") {
      products = runProcessCycle(pin, simulationTime);
      routeCommodityInput(colony, pin);
      if (activateProcessPin(pin, simulationTime)) {
        routeCommodityInput(colony, pin);
      }
    }

    if (Object.keys(products).length > 0) {
      routeCommodityOutput(colony, pin, products);
    }
    primeReadyProcessors(colony, simulationTime);
    changed = true;
    eventCount += 1;
  }

  const pendingEvent = eventCount >= MAX_SIMULATION_EVENTS
    ? getNextSimulationEvent(colony, targetTime)
    : null;
  if (pendingEvent) {
    log.warn(
      `[PlanetRuntimeStore] PI simulation event cap reached planetID=${colony.planetID} ownerID=${colony.ownerID}`,
    );
  }

  const targetTimeString = targetTime.toString();
  if (!pendingEvent && colony.currentSimTime !== targetTimeString) {
    colony.currentSimTime = targetTimeString;
    changed = true;
  }
  if (changed) {
    colony.updatedAt = new Date().toISOString();
  }
  return {
    colony: normalizeColony(colony, context),
    changed,
  };
}

function sortEndpoints(endpoint1, endpoint2) {
  const left = normalizeInteger(endpoint1, 0);
  const right = normalizeInteger(endpoint2, 0);
  return left <= right ? [left, right] : [right, left];
}

function linkKey(endpoint1, endpoint2) {
  return sortEndpoints(endpoint1, endpoint2).join(":");
}

function getLinkByEndpoints(colony, endpoint1, endpoint2) {
  const key = linkKey(endpoint1, endpoint2);
  return (Array.isArray(colony.links) ? colony.links : [])
    .find((link) => linkKey(link.endpoint1, link.endpoint2) === key) || null;
}

function getPinDistanceMeters(pinA, pinB, planetRadius = 0) {
  const radius = Math.max(0, normalizeReal(planetRadius, 0));
  if (!pinA || !pinB || radius <= 0) {
    return 0;
  }
  return sphericalDistance(
    normalizeSurfacePoint(pinA.latitude, pinA.longitude),
    normalizeSurfacePoint(pinB.latitude, pinB.longitude),
  ) * radius;
}

function getLinkCpuUsage(link, colony, context = {}) {
  const params = planetStaticData.getUsageParametersForLinkType(link && link.typeID);
  const pinA = findPin(colony, link && link.endpoint1);
  const pinB = findPin(colony, link && link.endpoint2);
  const length = getPinDistanceMeters(pinA, pinB, context.planetRadius);
  const level = Math.max(0, normalizeInteger(link && link.level, 0));
  return params.baseCpuUsage +
    Math.ceil(params.cpuUsagePerKm * (length / 1000) * ((level + 1) ** params.cpuUsageLevelModifier));
}

function getLinkPowerUsage(link, colony, context = {}) {
  const params = planetStaticData.getUsageParametersForLinkType(link && link.typeID);
  const pinA = findPin(colony, link && link.endpoint1);
  const pinB = findPin(colony, link && link.endpoint2);
  const length = getPinDistanceMeters(pinA, pinB, context.planetRadius);
  const level = Math.max(0, normalizeInteger(link && link.level, 0));
  return params.basePowerUsage +
    Math.ceil(params.powerUsagePerKm * (length / 1000) * ((level + 1) ** params.powerUsageLevelModifier));
}

function getPinCpuPower(pin) {
  const typeUsage = planetStaticData.getCPUAndPowerForPinType(pin && pin.typeID);
  const entityType = getPinEntityType(pin);
  if (entityType !== "ecu") {
    return {
      cpuUsage: typeUsage.cpuUsage,
      powerUsage: typeUsage.powerUsage,
    };
  }

  const headCount = Array.isArray(pin.heads) ? pin.heads.length : 0;
  return {
    cpuUsage: typeUsage.cpuUsage +
      Math.max(0, planetStaticData.getTypeAttribute(
        pin.typeID,
        planetStaticData.ATTRIBUTE.EXTRACTOR_HEAD_CPU,
        0,
      )) * headCount,
    powerUsage: typeUsage.powerUsage +
      Math.max(0, planetStaticData.getTypeAttribute(
        pin.typeID,
        planetStaticData.ATTRIBUTE.EXTRACTOR_HEAD_POWER,
        0,
      )) * headCount,
  };
}

function getColonyCpuPowerStats(colony, context = {}) {
  const level = clamp(normalizeInteger(colony && colony.level, 0), 0, 5);
  const commandPin = (Array.isArray(colony.pins) ? colony.pins : [])
    .find((pin) => getPinEntityType(pin) === "command") || null;
  const commandInfo = planetStaticData.getCommandCenterInfo(level) || {};
  const stats = {
    hasCommandPin: Boolean(commandPin),
    cpuSupply: commandPin ? normalizeInteger(commandInfo.cpuOutput, 0) : 0,
    powerSupply: commandPin ? normalizeInteger(commandInfo.powerOutput, 0) : 0,
    cpuUsage: 0,
    powerUsage: 0,
  };

  for (const pin of Array.isArray(colony.pins) ? colony.pins : []) {
    const entityType = getPinEntityType(pin);
    if (entityType === "command") {
      continue;
    }
    const usage = getPinCpuPower(pin);
    stats.cpuUsage += usage.cpuUsage;
    stats.powerUsage += usage.powerUsage;
  }

  for (const link of Array.isArray(colony.links) ? colony.links : []) {
    stats.cpuUsage += getLinkCpuUsage(link, colony, context);
    stats.powerUsage += getLinkPowerUsage(link, colony, context);
  }

  stats.cpuUsage = Math.ceil(stats.cpuUsage);
  stats.powerUsage = Math.ceil(stats.powerUsage);
  return stats;
}

function getRouteCycleTime(colony, route) {
  const path = Array.isArray(route && route.path) ? route.path : [];
  const sourcePin = findPin(colony, path[0]);
  const destinationPin = findPin(colony, path[path.length - 1]);
  const sourceCycleTime = getPinCycleTime(sourcePin);
  const destinationCycleTime = getPinCycleTime(destinationPin);
  if (sourceCycleTime > 0 && getPinEntityType(sourcePin) !== "storage") {
    return sourceCycleTime;
  }
  if (destinationCycleTime > 0) {
    return destinationCycleTime;
  }
  return Math.max(sourceCycleTime, destinationCycleTime);
}

function getRouteBandwidthUsage(colony, route) {
  const typeID = normalizeInteger(route && route.commodityTypeID, 0);
  const quantity = normalizeInteger(route && route.commodityQuantity, 0);
  const volumePerCycle = getTypeVolume(typeID) * quantity;
  const cycleTime = getRouteCycleTime(colony, route);
  if (cycleTime > 0) {
    return volumePerCycle * (HOUR_TICKS / cycleTime);
  }
  return volumePerCycle;
}

function getLinkBandwidthCapacity(link) {
  const params = planetStaticData.getUsageParametersForLinkType(link && link.typeID);
  const level = Math.max(0, normalizeInteger(link && link.level, 0));
  return Math.max(0, Number(params.logisticalCapacity) || 0) * (2 ** level);
}

function getCommodityTotalVolume(commodities = {}) {
  return Object.entries(normalizeContents(commodities)).reduce(
    (total, [typeID, quantity]) => total + (getTypeVolume(typeID) * quantity),
    0,
  );
}

function getExpeditedTransferTimeTicks(linkBandwidth, commodities = {}) {
  const bandwidth = Math.max(0, Number(linkBandwidth) || 0);
  if (!(bandwidth > 0)) {
    return EXPEDITED_TRANSFER_MINIMUM_TICKS;
  }
  const commodityVolume = getCommodityTotalVolume(commodities);
  return Math.ceil(Math.max(
    EXPEDITED_TRANSFER_MINIMUM_TICKS,
    (commodityVolume / bandwidth) * HOUR_TICKS,
  ));
}

function normalizeTransferPath(path = []) {
  const unwrappedPath = unwrapMarshalValue(path);
  return (Array.isArray(unwrappedPath) ? unwrappedPath : [])
    .map((pinID) => normalizeInteger(unwrapMarshalValue(pinID), 0))
    .filter((pinID) => pinID > 0);
}

function getMinimumLinkBandwidthForPath(colony, path = []) {
  let minBandwidth = null;
  for (let index = 0; index < path.length - 1; index += 1) {
    const link = getLinkByEndpoints(colony, path[index], path[index + 1]);
    if (!link) {
      throw new Error("RouteFailedValidationLinkDoesNotExist");
    }
    const bandwidth = getLinkBandwidthCapacity(link);
    if (minBandwidth === null || bandwidth < minBandwidth) {
      minBandwidth = bandwidth;
    }
  }
  if (minBandwidth === null || minBandwidth < 0) {
    throw new Error("RouteFailedValidationNoBandwidthAvailable");
  }
  return minBandwidth;
}

function validateColonyCommandCenter(colony) {
  const pins = Array.isArray(colony && colony.pins) ? colony.pins : [];
  const commandPins = pins.filter((pin) => getPinEntityType(pin) === "command");
  if (commandPins.length > 1) {
    throw new Error("CannotBuildMultipleCommandPins");
  }
  if (
    commandPins.length < 1 &&
    (
      pins.some((pin) => getPinEntityType(pin) !== "command") ||
      (Array.isArray(colony.links) && colony.links.length > 0) ||
      (Array.isArray(colony.routes) && colony.routes.length > 0)
    )
  ) {
    throw new Error("CannotManagePlanetWithoutCommandCenter");
  }
}

function validateRouteSemantics(colony, route, context = {}) {
  const path = Array.isArray(route && route.path) ? route.path : [];
  const typeID = normalizeInteger(route && route.commodityTypeID, 0);
  const quantity = normalizeInteger(route && route.commodityQuantity, 0);
  if (typeID <= 0 || quantity < 1) {
    throw new Error("CreateRouteWithoutCommodities");
  }
  if (path.length < 2) {
    throw new Error("CreateRouteTooShort");
  }
  if (path.length - 2 > MAX_ROUTE_WAYPOINTS) {
    throw new Error("CannotRouteTooManyWaypoints");
  }

  const sourcePin = findPin(colony, path[0]);
  const destinationPin = findPin(colony, path[path.length - 1]);
  if (!sourcePin || !destinationPin) {
    throw new Error("RouteFailedValidationPinDoesNotExist");
  }

  const sourceType = getPinEntityType(sourcePin);
  const destinationType = getPinEntityType(destinationPin);
  if (isStorageEntityType(sourceType) && !isConsumerEntityType(destinationType)) {
    throw new Error("CannotRouteStorageMustGoToConsumer");
  }
  if (!isConsumerEntityType(destinationType) && !isStorageEntityType(destinationType)) {
    throw new Error("CannotRouteDestinationWillNotAccept");
  }

  // An ECU programmed in this submit has no known output until every INSTALLPROGRAM in the
  // submit has been applied, because extractors sharing a resource penalise each other's
  // overlapping heads. Checking a route against a half-applied colony rejects submits the
  // client had no way to size correctly, so for such an ECU these two checks are left to the
  // end-of-stream repairEcuSourceRoutes/validateColonyNetwork pass, which sees the final
  // yields and trims the routes to fit before re-running this function in full. The caller
  // sets deferEcuProduction only for that ECU: a route from any other extractor is still
  // refused here when it does not fit.
  const deferEcuProduction = context.deferEcuProduction === true && sourceType === "ecu";
  if (isProducerEntityType(sourceType) && !deferEcuProduction) {
    const sourceProducts = getPinProducts(sourcePin);
    const productQuantity = normalizeInteger(sourceProducts[String(typeID)], 0);
    if (productQuantity <= 0) {
      throw new Error("CreateRouteCommodityNotProduced");
    }

    const existingRouteQuantity = (Array.isArray(colony.routes) ? colony.routes : [])
      .filter((candidate) => (
        normalizeInteger(candidate.routeID, 0) !== normalizeInteger(route.routeID, 0) &&
        getRouteSourceID(candidate) === normalizeInteger(sourcePin.pinID, 0) &&
        normalizeInteger(candidate.commodityTypeID, 0) === typeID
      ))
      .reduce((total, candidate) => (
        total + normalizeInteger(candidate.commodityQuantity, 0)
      ), 0);
    if (existingRouteQuantity + quantity > productQuantity) {
      throw new Error("CreateRouteCommodityProductionTooSmall");
    }
  }

  if (isConsumerEntityType(destinationType)) {
    const consumables = getPinConsumables(destinationPin);
    if (normalizeInteger(consumables[String(typeID)], 0) <= 0) {
      throw new Error("CreateRouteDestinationCannotAcceptCommodity");
    }
  }

  const ownerID = normalizeInteger(context.ownerID, 0);
  let previousPinID = null;
  for (const pinID of path) {
    const pin = findPin(colony, pinID);
    if (!pin) {
      throw new Error("RouteFailedValidationPinDoesNotExist");
    }
    if (ownerID > 0) {
      assertPinOwnedBy(pin, ownerID, "RouteFailedValidationPinNotYours");
    }
    if (previousPinID !== null && !getLinkByEndpoints(colony, previousPinID, pinID)) {
      throw new Error("RouteFailedValidationLinkDoesNotExist");
    }
    previousPinID = pinID;
  }
}

function validateColonyRoutesAndLinks(colony, context = {}) {
  const seenLinkKeys = new Set();
  for (const link of Array.isArray(colony.links) ? colony.links : []) {
    if (normalizeInteger(link.level, 0) > LINK_MAX_UPGRADE) {
      throw new Error("CannotUpgradeLinkTooHigh");
    }
    ensurePinsExist(colony, [link.endpoint1, link.endpoint2]);
    const key = linkKey(link.endpoint1, link.endpoint2);
    if (seenLinkKeys.has(key)) {
      throw new Error("LinkAlreadyExists");
    }
    seenLinkKeys.add(key);
  }

  const bandwidthByLinkKey = new Map();
  for (const route of Array.isArray(colony.routes) ? colony.routes : []) {
    validateRouteSemantics(colony, route, context);
    const path = Array.isArray(route.path) ? route.path : [];
    if (path.length < 2) {
      throw new Error("CreateRouteTooShort");
    }
    if (path.length - 2 > MAX_ROUTE_WAYPOINTS) {
      throw new Error("CannotRouteTooManyWaypoints");
    }
    ensurePinsExist(colony, path);

    const bandwidthUsage = getRouteBandwidthUsage(colony, route);
    for (let index = 0; index < path.length - 1; index += 1) {
      const previousPinID = path[index];
      const nextPinID = path[index + 1];
      const link = getLinkByEndpoints(colony, previousPinID, nextPinID);
      if (!link) {
        throw new Error("RouteFailedValidationLinkDoesNotExist");
      }
      const key = linkKey(previousPinID, nextPinID);
      bandwidthByLinkKey.set(
        key,
        (bandwidthByLinkKey.get(key) || 0) + bandwidthUsage,
      );
    }
  }

  for (const [key, bandwidthUsage] of bandwidthByLinkKey.entries()) {
    const link = (Array.isArray(colony.links) ? colony.links : [])
      .find((candidate) => linkKey(candidate.endpoint1, candidate.endpoint2) === key);
    if (link && bandwidthUsage > getLinkBandwidthCapacity(link) + 1e-9) {
      throw new Error("RouteFailedValidationCannotRouteCommodities");
    }
  }
}

function validateColonyCpuPower(colony, context = {}) {
  const stats = getColonyCpuPowerStats(colony, context);
  if (!stats.hasCommandPin) {
    return stats;
  }
  if (stats.cpuUsage > stats.cpuSupply) {
    throw new Error("CannotAddToColonyCPUUsageExceeded");
  }
  if (stats.powerUsage > stats.powerSupply) {
    throw new Error("CannotAddToColonyPowerUsageExceeded");
  }
  return stats;
}

function validateColonyNetwork(colony, context = {}) {
  validateColonyCommandCenter(colony);
  validateColonyRoutesAndLinks(colony, context);
  return validateColonyCpuPower(colony, context);
}

function removeRoutesTouchingPin(colony, pinID) {
  const normalizedPinID = normalizeInteger(pinID, 0);
  colony.routes = (Array.isArray(colony.routes) ? colony.routes : [])
    .filter((route) => !(Array.isArray(route.path) && route.path.includes(normalizedPinID)));
}

function routeUsesLink(route, endpoint1, endpoint2) {
  const targetKey = linkKey(endpoint1, endpoint2);
  const path = Array.isArray(route && route.path) ? route.path : [];
  for (let index = 0; index < path.length - 1; index += 1) {
    if (linkKey(path[index], path[index + 1]) === targetKey) {
      return true;
    }
  }
  return false;
}

function removeRoutesTouchingLink(colony, endpoint1, endpoint2) {
  colony.routes = (Array.isArray(colony.routes) ? colony.routes : [])
    .filter((route) => !routeUsesLink(route, endpoint1, endpoint2));
}

function setExtractorHead(pin, headID, latitude, longitude) {
  if (!pin) {
    return;
  }
  const normalizedHeadID = normalizeInteger(headID, 0);
  pin.heads = (Array.isArray(pin.heads) ? pin.heads : [])
    .filter((head) => normalizeInteger(head && head[0], 0) !== normalizedHeadID);
  pin.heads.push([
    normalizedHeadID,
    normalizeReal(latitude, pin.latitude),
    normalizeReal(longitude, pin.longitude),
  ]);
  pin.heads.sort((left, right) => left[0] - right[0]);
}

function addExtractorHead(pin, ownerID, headID, latitude, longitude) {
  assertSurfacePointInRange(latitude, longitude);
  assertExtractorPin(pin, ownerID);
  if (findExtractorHead(pin, headID)) {
    throw new Error("CannotAddHeadAlreadyExists");
  }
  if ((Array.isArray(pin.heads) ? pin.heads : []).length >= ECU_MAX_HEADS) {
    throw new Error("CannotPlaceHeadLimitReached");
  }
  if (normalizeInteger(pin.state, STATE_IDLE) > STATE_IDLE) {
    throw new Error("You cannot add an extractor head while program is active");
  }
  assertExtractorHeadWithinArea(pin, latitude, longitude);
  setExtractorHead(pin, headID, latitude, longitude);
}

function removeExtractorHead(pin, ownerID, headID) {
  assertExtractorPin(pin, ownerID);
  if (!findExtractorHead(pin, headID)) {
    throw new Error("CannotRemoveHeadNotPresent");
  }
  if (normalizeInteger(pin.state, STATE_IDLE) > STATE_IDLE) {
    throw new Error("You cannot remove an extractor head while program is active");
  }
  const normalizedHeadID = normalizeInteger(headID, 0);
  pin.heads = (Array.isArray(pin.heads) ? pin.heads : [])
    .filter((head) => normalizeInteger(head && head[0], 0) !== normalizedHeadID);
}

function moveExtractorHead(pin, ownerID, headID, latitude, longitude) {
  assertSurfacePointInRange(latitude, longitude);
  assertExtractorPin(pin, ownerID);
  if (!findExtractorHead(pin, headID)) {
    throw new Error("CannotMoveHeadNotPresent");
  }
  assertExtractorHeadWithinArea(pin, latitude, longitude);
  setExtractorHead(pin, headID, latitude, longitude);
}

function getProgramLengthFromHeadRadius(headRadius) {
  return (
    (clamp(headRadius, RADIUS_DRILL_AREA_MIN, RADIUS_DRILL_AREA_MAX) - RADIUS_DRILL_AREA_MIN) /
    RADIUS_DRILL_AREA_DIFF *
    335 +
    1
  );
}

function getCycleTimeFromProgramLength(programLength) {
  return 0.25 * 2 ** Math.max(0, Math.floor(Math.log2(programLength / 25.0)) + 1);
}

function normalizeHeads(heads = []) {
  return (Array.isArray(heads) ? heads : [])
    .map((head) => (Array.isArray(head) ? head : []))
    .map((head) => [
      normalizeInteger(head[0], 0),
      normalizeReal(head[1], 0),
      normalizeReal(head[2], 0),
    ]);
}

function getEcuAttribute(ecuTypeID, attributeID, fallback) {
  const normalizedTypeID = normalizeInteger(ecuTypeID, DEFAULT_ECU_TYPE_ID);
  const value = planetStaticData.getTypeAttribute(normalizedTypeID, attributeID, fallback);
  return Number.isFinite(value) ? value : fallback;
}

function getEcuMaxVolume(ecuTypeID) {
  return Math.max(
    0,
    getEcuAttribute(
      ecuTypeID,
      planetStaticData.ATTRIBUTE.ECU_MAX_VOLUME,
      9.2,
    ),
  );
}

function getCircleOverlapRatio(distance, radius) {
  const safeRadius = Math.max(0.0001, radius);
  if (distance >= safeRadius * 2) {
    return 0;
  }
  if (distance <= 0) {
    return 1;
  }

  const radiusSquared = safeRadius ** 2;
  const overlapArea = (
    2 * radiusSquared * Math.acos(0.5 * (distance / safeRadius)) -
    0.5 * distance * Math.sqrt(Math.max(0, (4 * radiusSquared) - (distance ** 2)))
  );
  return clamp(overlapArea / (Math.PI * radiusSquared), 0, 1);
}

function getUnequalCircleOverlapRatio(distance, targetRadius, otherRadius) {
  let safeDistance = Math.max(0, normalizeReal(distance, 0));
  const safeTargetRadius = Math.max(0.0001, normalizeReal(targetRadius, RADIUS_DRILL_AREA_MAX));
  const safeOtherRadius = Math.max(0.0001, normalizeReal(otherRadius, RADIUS_DRILL_AREA_MAX));
  if (safeDistance > safeTargetRadius + safeOtherRadius) {
    return 0;
  }
  if (safeDistance === 0) {
    safeDistance = 0.0001;
  }

  const targetArea = Math.PI * (safeTargetRadius ** 2);
  const distanceSquared = safeDistance ** 2;
  const targetRadiusSquared = safeTargetRadius ** 2;
  const otherRadiusSquared = safeOtherRadius ** 2;
  const alpha = (
    distanceSquared + otherRadiusSquared - targetRadiusSquared
  ) / (2 * safeDistance * safeOtherRadius);
  let overlapArea;
  if (alpha < -1) {
    overlapArea = Math.PI * otherRadiusSquared;
  } else if (alpha > 1) {
    overlapArea = targetArea;
  } else {
    const firstArea = otherRadiusSquared * Math.acos(clamp(alpha, -1, 1));
    const secondCosine = (
      distanceSquared + targetRadiusSquared - otherRadiusSquared
    ) / (2 * safeDistance * safeTargetRadius);
    const secondArea = targetRadiusSquared * Math.acos(clamp(secondCosine, -1, 1));
    const triangleArea = 0.5 * Math.sqrt(Math.max(0, (
      (-safeDistance + safeOtherRadius + safeTargetRadius) *
      (safeDistance + safeOtherRadius - safeTargetRadius) *
      (safeDistance - safeOtherRadius + safeTargetRadius) *
      (safeDistance + safeOtherRadius + safeTargetRadius)
    )));
    overlapArea = firstArea + secondArea - triangleArea;
  }
  return Math.max(0, overlapArea / targetArea);
}

function getOwnHeadModifiers(heads, headRadius, overlapFactor) {
  const modifiers = new Map(heads.map((head) => [normalizeInteger(head[0], 0), 1]));
  for (let leftIndex = 0; leftIndex < heads.length; leftIndex += 1) {
    const left = heads[leftIndex];
    const leftPoint = normalizeSurfacePoint(left[1], left[2]);
    for (let rightIndex = leftIndex + 1; rightIndex < heads.length; rightIndex += 1) {
      const right = heads[rightIndex];
      const rightPoint = normalizeSurfacePoint(right[1], right[2]);
      const distance = sphericalDistance(leftPoint, rightPoint);
      const overlap = getCircleOverlapRatio(distance, headRadius);
      if (overlap <= 0) {
        continue;
      }

      const modifier = clamp(1 - (overlap * overlapFactor), 0, 1);
      const leftID = normalizeInteger(left[0], 0);
      const rightID = normalizeInteger(right[0], 0);
      modifiers.set(leftID, (modifiers.get(leftID) || 1) * modifier);
      modifiers.set(rightID, (modifiers.get(rightID) || 1) * modifier);
    }
  }
  return modifiers;
}

// peerInstallByPinID, when supplied, overrides a peer ECU's stored program and head radius
// with the ones it will be running once the submit being applied has finished. Both fields are
// written only by installECUProgram, so a peer whose own INSTALLPROGRAM has not been reached
// yet still reads programType null and its pin-creation default radius. Without this the
// penalty a peer imposes depends on where its command happens to sit in the stream: the first
// extractor installed in a submit is unpenalised and the last one absorbs every overlap.
function getOtherEcuHeadModifiers(
  heads,
  headRadius,
  overlapFactor,
  otherEcuPins,
  resourceTypeID,
  ecuPinID,
  peerInstallByPinID = null,
) {
  const modifiers = new Map(heads.map((head) => [normalizeInteger(head[0], 0), 1]));
  const normalizedEcuPinID = normalizeInteger(ecuPinID, 0);
  const getPeerInstall = (pin) => (
    peerInstallByPinID
      ? peerInstallByPinID.get(normalizeInteger(pin && pin.pinID, 0))
      : undefined
  );
  const getPeerProgram = (pin) => {
    const install = getPeerInstall(pin);
    return normalizeNullableInteger(
      install ? install.programTypeID : (pin && pin.programType),
    );
  };
  const getPeerHeadRadius = (pin) => {
    const install = getPeerInstall(pin);
    return clamp(
      normalizeReal(
        install ? install.headRadius : (pin && pin.headRadius),
        RADIUS_DRILL_AREA_MIN,
      ),
      RADIUS_DRILL_AREA_MIN,
      RADIUS_DRILL_AREA_MAX,
    );
  };
  const matchingPins = (Array.isArray(otherEcuPins) ? otherEcuPins : [])
    .filter((pin) => (
      getPinEntityType(pin) === "ecu" &&
      normalizeInteger(pin && pin.pinID, 0) !== normalizedEcuPinID &&
      getPeerProgram(pin) === resourceTypeID
    ));

  for (const head of heads) {
    const headID = normalizeInteger(head[0], 0);
    const headPoint = normalizeSurfacePoint(head[1], head[2]);
    let modifier = 1;
    for (const otherPin of matchingPins) {
      if (modifier <= 0) {
        break;
      }
      const otherRadius = getPeerHeadRadius(otherPin);
      for (const otherHead of normalizeHeads(otherPin && otherPin.heads)) {
        const distance = sphericalDistance(
          headPoint,
          normalizeSurfacePoint(otherHead[1], otherHead[2]),
        );
        const overlap = getUnequalCircleOverlapRatio(distance, headRadius, otherRadius);
        if (overlap <= 0) {
          continue;
        }
        modifier *= clamp(1 - (overlap * 2 * overlapFactor), 0, 1);
      }
    }
    modifiers.set(headID, modifier);
  }
  return modifiers;
}

function estimateProgramResult({
  planetID = 0,
  resourceTypeID = 0,
  heads = [],
  headRadius = RADIUS_DRILL_AREA_MIN,
  ecuTypeID = DEFAULT_ECU_TYPE_ID,
  ecuPinID = 0,
  otherEcuPins = [],
  peerInstallByPinID = null,
  state = null,
} = {}) {
  const normalizedPlanetID = normalizeInteger(planetID, 0);
  const normalizedResourceTypeID = normalizeInteger(resourceTypeID, 0);
  if (normalizedResourceTypeID <= 0) {
    return {
      qtyToDistribute: 0,
      cycleTime: 0,
      numCycles: 0,
    };
  }

  const normalizedHeads = normalizeHeads(heads);
  const clampedRadius = clamp(
    normalizeReal(headRadius, RADIUS_DRILL_AREA_MIN),
    RADIUS_DRILL_AREA_MIN,
    RADIUS_DRILL_AREA_MAX,
  );
  const programLength = getProgramLengthFromHeadRadius(clampedRadius);
  const cycleTimeHours = getCycleTimeFromProgramLength(programLength);
  const cycleTime = Math.max(1, Math.trunc(cycleTimeHours * HOUR_TICKS));
  const numCycles = Math.max(1, Math.trunc(programLength / cycleTimeHours));

  const sourceState = state || readState({ repair: true });
  const resourceRecord = sourceState.resourcesByPlanetID[String(normalizedPlanetID)] || {};
  const layer = getResourceLayerFromRecord(resourceRecord, normalizedResourceTypeID);
  if (!layer || normalizedHeads.length < 1) {
    return {
      qtyToDistribute: 0,
      cycleTime,
      numCycles,
    };
  }
  const overlapFactor = clamp(
    getEcuAttribute(ecuTypeID, planetStaticData.ATTRIBUTE.ECU_OVERLAP_FACTOR, 0.5),
    0,
    1,
  );
  const maxVolume = getEcuMaxVolume(ecuTypeID);
  const headModifiers = getOwnHeadModifiers(normalizedHeads, clampedRadius, overlapFactor);
  const otherHeadModifiers = getOtherEcuHeadModifiers(
    normalizedHeads,
    clampedRadius,
    overlapFactor,
    otherEcuPins,
    normalizedResourceTypeID,
    ecuPinID,
    peerInstallByPinID,
  );
  // Survey bands control only the heatmap resolution presented to the client.
  // Program quotes and installs are authoritative and always use the complete
  // resource harmonic; the retail quote/install protocol does not submit a band.
  const normalizedBands = RESOURCE_SH_MAX_BANDS;
  const nowMs = Date.now();
  const coefficients = buildResourceLayerCoefficients(layer, normalizedBands, { nowMs });
  const summedHeadValue = normalizedHeads.reduce((total, head) => {
    const resourceValue = Math.max(0, evaluateResourceLayerHarmonicValue(
      layer,
      head[1],
      head[2],
      { coefficients, numBands: normalizedBands },
    ));
    const headID = normalizeInteger(head[0], 0);
    const modifier = (headModifiers.get(headID) ?? 1) *
      (otherHeadModifiers.get(headID) ?? 1);
    return total + (resourceValue * modifier);
  }, 0);
  const qtyToDistribute = Math.max(0, Math.trunc(maxVolume * summedHeadValue));

  return {
    qtyToDistribute,
    cycleTime,
    numCycles,
  };
}

function recordResourceDepletionEvent({
  state,
  planetID,
  resourceTypeID,
  heads = [],
  headRadius = RADIUS_DRILL_AREA_MIN,
  ecuTypeID = DEFAULT_ECU_TYPE_ID,
  result = {},
  installTime = null,
  expiryTime = null,
} = {}) {
  if (!state || !isPlainObject(state.resourcesByPlanetID)) {
    return;
  }

  const resourceRecord = state.resourcesByPlanetID[String(normalizeInteger(planetID, 0))];
  if (!isPlainObject(resourceRecord) || !isPlainObject(resourceRecord.layersByTypeID)) {
    return;
  }

  const layerKey = String(normalizeInteger(resourceTypeID, 0));
  const layer = resourceRecord.layersByTypeID[layerKey];
  if (!isPlainObject(layer)) {
    return;
  }

  const normalizedHeads = normalizeHeads(heads);
  if (normalizedHeads.length < 1) {
    return;
  }

  const normalizedHeadRadius = clamp(
    normalizeReal(headRadius, RADIUS_DRILL_AREA_MIN),
    RADIUS_DRILL_AREA_MIN,
    RADIUS_DRILL_AREA_MAX,
  );
  const depletionRange = Math.max(
    1,
    getEcuAttribute(
      ecuTypeID,
      planetStaticData.ATTRIBUTE.EXTRACTOR_DEPLETION_RANGE,
      5,
    ),
  );
  const depletionRate = Math.max(
    0.1,
    getEcuAttribute(
      ecuTypeID,
      planetStaticData.ATTRIBUTE.EXTRACTOR_DEPLETION_RATE,
      1,
    ),
  );
  const maxVolume = getEcuMaxVolume(ecuTypeID) * RESOURCE_DEPLETION_PRESSURE_SCALE;
  // Store depletion in baseline units, like the resource field itself. The
  // common coefficient builder scales both together for scans and quotes.
  const pressurePerHead = (normalizeInteger(result.qtyToDistribute, 0) /
    getPlanetResourceAbundanceMultiplier()) /
    Math.max(1, maxVolume * normalizedHeads.length);
  const strength = clamp(pressurePerHead * 0.16 * depletionRate, 0.01, 0.2);
  const depletionRadius = clamp(
    normalizedHeadRadius * depletionRange,
    normalizedHeadRadius,
    0.45,
  );

  layer.depletionEvents = pruneDepletionEvents(layer.depletionEvents);
  layer.depletionEvents.push({
    installTime: installTime ? String(installTime) : currentFileTimeString(),
    expiryTime: expiryTime ? String(expiryTime) : currentFileTimeString(),
    headRadius: normalizedHeadRadius,
    depletionRadius,
    strength: Number(strength.toFixed(6)),
    heads: normalizedHeads,
  });
  layer.depletionEvents = pruneDepletionEvents(layer.depletionEvents);
  resourceRecord.updatedAt = new Date().toISOString();
}

function formatFiletimeInterval(intervalTicks) {
  const remainingSeconds = Math.max(
    1,
    Math.ceil(Number(intervalTicks) / SECOND_TICKS),
  );
  if (remainingSeconds === 60) {
    return "1 minute";
  }
  return `${remainingSeconds} second${remainingSeconds === 1 ? "" : "s"}`;
}

function assertCanInstallECUProgram(
  pin,
  ownerID,
  headRadius,
  editTime = currentFileTime(),
) {
  assertExtractorPin(pin, ownerID);
  const normalizedHeadRadius = normalizeReal(headRadius, Number.NaN);
  if (
    !Number.isFinite(normalizedHeadRadius) ||
    normalizedHeadRadius < RADIUS_DRILL_AREA_MIN ||
    normalizedHeadRadius > RADIUS_DRILL_AREA_MAX
  ) {
    throw new Error("Cannot install a program with a completely bonkers radius");
  }

  if (!normalizeNullableInteger(pin.programType)) {
    return;
  }
  const normalizedEditTime = filetimeBigInt(editTime, currentFileTime());
  const expiryTime = filetimeBigInt(pin.expiryTime, null);
  if (expiryTime !== null && expiryTime <= normalizedEditTime) {
    return;
  }
  const installTime = filetimeBigInt(pin.installTime, null);
  if (installTime === null) {
    // Permit malformed legacy records to be replaced instead of trapping the
    // colony behind a timestamp that cannot be evaluated.
    return;
  }
  const nextEditTime = installTime + ECU_PROGRAM_INSTALLATION_COOLDOWN_TICKS;
  if (nextEditTime <= normalizedEditTime) {
    return;
  }
  throwWrappedUserError("CantInstallProgramNeedsCooldown", {
    ecu: [4, normalizeInteger(pin.typeID, 0)],
    timeDiff: formatFiletimeInterval(nextEditTime - normalizedEditTime),
  });
}

function installECUProgram(pin, programTypeID, headRadius, context = {}) {
  const normalizedProgramTypeID = normalizeNullableInteger(programTypeID);
  if (!normalizedProgramTypeID) {
    pin.cycleTime = 0;
    pin.programType = null;
    pin.qtyPerCycle = 0;
    pin.expiryTime = null;
    pin.installTime = null;
    pin.headRadius = normalizeReal(headRadius, pin.headRadius || RADIUS_DRILL_AREA_MIN);
    pin.state = STATE_IDLE;
    return true;
  }

  const result = estimateProgramResult({
    planetID: context.planetID,
    resourceTypeID: normalizedProgramTypeID,
    heads: pin.heads,
    headRadius,
    ecuTypeID: pin.typeID,
    ecuPinID: pin.pinID,
    otherEcuPins: context.otherEcuPins,
    peerInstallByPinID: context.peerInstallByPinID,
    state: context.state,
  });
  if (normalizeInteger(result.qtyToDistribute, 0) <= 0) {
    // Retail EcuPin.InstallProgram logs and returns before changing any field
    // when the authoritative quote is nonpositive. Say so: the pin keeps a null
    // programType, so the next thing the player sees is CreateRouteCommodityNotProduced
    // on a route many commands later, and nothing else records why.
    log.warn(
      `[PlanetRuntimeStore] Refused ECU program install on pin ${normalizeInteger(pin.pinID, 0)}: ` +
      `resourceTypeID=${normalizedProgramTypeID} quoted ${normalizeInteger(result.qtyToDistribute, 0)} ` +
      `units/cycle from ${normalizeHeads(pin.heads).length} head(s)`,
    );
    return false;
  }
  const installTime = context.installTime === null || context.installTime === undefined
    ? currentFileTimeString()
    : filetimeBigInt(context.installTime, currentFileTime()).toString();
  const expiryTime = (
    BigInt(installTime) +
    BigInt(result.cycleTime) * BigInt(result.numCycles)
  ).toString();

  pin.cycleTime = result.cycleTime;
  pin.programType = normalizedProgramTypeID;
  pin.qtyPerCycle = result.qtyToDistribute;
  pin.expiryTime = expiryTime;
  pin.installTime = installTime;
  pin.lastRunTime = installTime;
  pin.headRadius = clamp(
    normalizeReal(headRadius, RADIUS_DRILL_AREA_MIN),
    RADIUS_DRILL_AREA_MIN,
    RADIUS_DRILL_AREA_MAX,
  );
  pin.state = STATE_ACTIVE;

  recordResourceDepletionEvent({
    state: context.state,
    planetID: context.planetID,
    resourceTypeID: normalizedProgramTypeID,
    heads: pin.heads,
    headRadius: pin.headRadius,
    ecuTypeID: pin.typeID,
    result,
    installTime,
    expiryTime,
  });
  return true;
}

function normalizeCommandStream(serializedChanges = []) {
  const stream = unwrapMarshalValue(serializedChanges);
  if (!Array.isArray(stream)) {
    return [];
  }

  return stream
    .map((entry) => {
      const unwrappedEntry = unwrapMarshalValue(entry);
      if (Array.isArray(unwrappedEntry)) {
        const args = Array.isArray(unwrappedEntry[1])
          ? unwrappedEntry[1]
          : [unwrappedEntry[1]].filter((value) => value !== undefined);
        return {
          id: normalizeInteger(unwrappedEntry[0], 0),
          args,
        };
      }

      if (isPlainObject(unwrappedEntry)) {
        const args = Array.isArray(unwrappedEntry.args)
          ? unwrappedEntry.args
          : Array.isArray(unwrappedEntry.argTuple)
            ? unwrappedEntry.argTuple
            : [];
        return {
          id: normalizeInteger(unwrappedEntry.id ?? unwrappedEntry.commandID, 0),
          args,
        };
      }

      return null;
    })
    .filter((entry) => entry && entry.id > 0);
}

function ensurePinsExist(colony, pinIDs = []) {
  for (const pinID of pinIDs) {
    if (!findPin(colony, pinID)) {
      throw new Error(`Invalid PI command references missing pin ${pinID}`);
    }
  }
}

function validateLinkPins(colony, endpoints, ownerID) {
  assertCommandCenterPresent(colony);
  const [endpoint1, endpoint2] = endpoints;
  if (endpoint1 <= 0 || endpoint2 <= 0 || endpoint1 === endpoint2) {
    throw new Error("CannotLinkPinsToThemselves");
  }
  const pin1 = findPin(colony, endpoint1);
  const pin2 = findPin(colony, endpoint2);
  if (!pin1 || !pin2) {
    throw new Error("PinDoesNotExist");
  }
  assertPinOwnedBy(pin1, ownerID);
  assertPinOwnedBy(pin2, ownerID);
}

function createLink(colony, endpoint1, endpoint2, level, ownerID) {
  const endpoints = sortEndpoints(endpoint1, endpoint2);
  validateLinkPins(colony, endpoints, ownerID);
  const key = linkKey(endpoints[0], endpoints[1]);
  if ((Array.isArray(colony.links) ? colony.links : [])
    .some((link) => linkKey(link.endpoint1, link.endpoint2) === key)) {
    throw new Error("LinkAlreadyExists");
  }
  colony.links.push({
    typeID: LINK_TYPE_ID,
    endpoint1: endpoints[0],
    endpoint2: endpoints[1],
    level: Math.max(0, normalizeInteger(level, 0)),
  });
  colony.links.sort((left, right) => (
    left.endpoint1 === right.endpoint1
      ? left.endpoint2 - right.endpoint2
      : left.endpoint1 - right.endpoint1
  ));
}

function setLinkLevel(colony, endpoint1, endpoint2, level, ownerID) {
  const endpoints = sortEndpoints(endpoint1, endpoint2);
  validateLinkPins(colony, endpoints, ownerID);
  const link = getLinkByEndpoints(colony, endpoints[0], endpoints[1]);
  if (!link) {
    throw new Error("PinDoesNotExist");
  }
  const nextLevel = normalizeInteger(level, 0);
  if (nextLevel > LINK_MAX_UPGRADE) {
    throw new Error("CannotUpgradeLinkAlreadyMaxed");
  }
  link.level = Math.max(0, nextLevel);
}

// `createdPinIDs`, when a Set is supplied, collects the post-remap pin IDs of every
// CREATEPIN command this call actually applied. Callers that charge the player for a
// placement (planetMgrService consumes a Command Center item per command-centre pin) must
// derive their charge set from this rather than from the resulting `colony.pins`, which
// still contains everything earlier submits created. See
// docs/ErrorWatch/2026-08-06T23-55-27-237Z.md.
function applyUserUpdateNetwork({
  planetID,
  ownerID,
  solarSystemID = 0,
  planetTypeID = 0,
  planetRadius = 0,
  serializedChanges = [],
  commands = null,
  editHash = null,
  operationKey = null,
  requestScope = null,
  expectedNetworkRevision = null,
  constructionCost = 0,
  dryRun = false,
  createdPinIDs = null,
} = {}) {
  const normalizedPlanetID = normalizeInteger(planetID, 0);
  const normalizedOwnerID = normalizeInteger(ownerID, 0);
  if (normalizedPlanetID <= 0 || normalizedOwnerID <= 0) {
    throw new Error("Cannot update PI network without a planet and owner");
  }

  const commandStream = normalizeCommandStream(commands || serializedChanges);
  const persistedState = readState({ repair: true });
  const state = dryRun ? cloneJson(persistedState) : persistedState;
  const key = colonyKey(normalizedPlanetID, normalizedOwnerID);
  const storedColony = state.coloniesByKey[key]
    ? normalizeColony(state.coloniesByKey[key], {
        planetID: normalizedPlanetID,
        ownerID: normalizedOwnerID,
        solarSystemID,
        planetTypeID,
        planetRadius,
      })
    : null;
  const baseRevision = normalizeInteger(storedColony && storedColony.networkRevision, 0);
  const editTime = currentFileTime();
  if (!dryRun && operationKey) {
    const receiptBucket = getNetworkEditReceiptBucket(state, key);
    const receipt = receiptBucket && receiptBucket[String(operationKey)];
    if (receipt) {
      if (
        String(receipt.editHash || "") !== String(editHash || "") ||
        (
          expectedNetworkRevision !== null &&
          expectedNetworkRevision !== undefined &&
          normalizeInteger(receipt.baseRevision, -1) !==
            normalizeInteger(expectedNetworkRevision, -2)
        )
      ) {
        throw new Error("IDEMPOTENCY_KEY_REUSED");
      }
      if (storedColony && normalizeInteger(receipt.resultRevision, -1) === baseRevision) {
        if (createdPinIDs instanceof Set) {
          for (const pinID of Array.isArray(receipt.createdPinIDs) ? receipt.createdPinIDs : []) {
            const normalizedPinID = normalizeInteger(pinID, 0);
            if (normalizedPinID > 0) {
              createdPinIDs.add(normalizedPinID);
            }
          }
        }
        return storedColony;
      }
      throw new Error("PlanetNetworkChanged");
    }
  }
  if (
    !dryRun &&
    expectedNetworkRevision !== null &&
    expectedNetworkRevision !== undefined &&
    normalizeInteger(expectedNetworkRevision, -1) !== baseRevision
  ) {
    throw new Error("PlanetNetworkChanged");
  }
  const simulationResult = runColonySimulation(state.coloniesByKey[key], editTime, {
    planetID: normalizedPlanetID,
    ownerID: normalizedOwnerID,
    solarSystemID,
    planetTypeID,
    planetRadius,
  });
  const colony = simulationResult.colony;
  colony.planetRadius = normalizeReal(planetRadius, normalizeReal(colony.planetRadius, 0));
  const idMap = new Map();
  const usedPinIDs = collectUsedIDs(state, "pinID");
  const usedRouteIDs = collectUsedIDs(state, "routeID");
  const cooldownValidatedEcuPinIDs = new Set();
  // pinID -> { programTypeID, headRadius } for every INSTALLPROGRAM in this stream that installs
  // a program, applied together once the stream has been replayed. Stop Program is applied at
  // once instead. See the INSTALLPROGRAM case below.
  const pendingProgramInstalls = new Map();

  for (const command of commandStream) {
    const args = Array.isArray(command.args) ? command.args : [];

    switch (command.id) {
      case COMMAND.CREATEPIN: {
        const submittedPinID = args[0];
        const typeID = normalizeInteger(args[1], 0);
        validatePinTypeForCreate(colony, typeID, {
          planetTypeID,
        });
        const pinID = isTemporaryID(submittedPinID, 1)
          ? allocateNextID(state, "pinID", usedPinIDs)
          : normalizeInteger(submittedPinID, 0);
        if (pinID <= 0) {
          throw new Error("CREATEPIN requires a valid pin ID");
        }
        const submittedKey = temporaryIDKey(submittedPinID);
        if (submittedKey) {
          idMap.set(submittedKey, pinID);
        }
        if (createdPinIDs instanceof Set) {
          // Record the resolved ID, not the submitted one: a temporary [1, n] tuple is
          // remapped above and the caller matches this against the persisted pin IDs.
          createdPinIDs.add(pinID);
        }

        colony.pins = colony.pins.filter((pin) => normalizeInteger(pin.pinID, 0) !== pinID);
        colony.pins.push(buildPin(
          pinID,
          typeID,
          normalizedOwnerID,
          normalizeReal(args[2], 0),
          normalizeReal(args[3], 0),
        ));
        colony.pins.sort((left, right) => normalizeInteger(left.pinID, 0) - normalizeInteger(right.pinID, 0));
        break;
      }

      case COMMAND.REMOVEPIN: {
        const pinID = resolveSubmittedID(args[0], idMap);
        const pin = findPin(colony, pinID);
        if (!pin) {
          throw new Error("PinDoesNotExist");
        }
        assertPinOwnedBy(pin, normalizedOwnerID);
        colony.pins = colony.pins.filter((pin) => normalizeInteger(pin.pinID, 0) !== pinID);
        colony.links = colony.links.filter((link) => (
          normalizeInteger(link.endpoint1, 0) !== pinID &&
          normalizeInteger(link.endpoint2, 0) !== pinID
        ));
        removeRoutesTouchingPin(colony, pinID);
        break;
      }

      case COMMAND.CREATELINK: {
        createLink(
          colony,
          resolveSubmittedID(args[0], idMap),
          resolveSubmittedID(args[1], idMap),
          args[2],
          normalizedOwnerID,
        );
        break;
      }

      case COMMAND.REMOVELINK: {
        const endpoints = sortEndpoints(
          resolveSubmittedID(args[0], idMap),
          resolveSubmittedID(args[1], idMap),
        );
        const keyToRemove = linkKey(endpoints[0], endpoints[1]);
        if (!getLinkByEndpoints(colony, endpoints[0], endpoints[1])) {
          throw new Error("LinkDoesNotExist");
        }
        colony.links = colony.links.filter((link) => linkKey(link.endpoint1, link.endpoint2) !== keyToRemove);
        removeRoutesTouchingLink(colony, endpoints[0], endpoints[1]);
        break;
      }

      case COMMAND.SETLINKLEVEL: {
        setLinkLevel(
          colony,
          resolveSubmittedID(args[0], idMap),
          resolveSubmittedID(args[1], idMap),
          args[2],
          normalizedOwnerID,
        );
        break;
      }

      case COMMAND.CREATEROUTE: {
        const submittedRouteID = args[0];
        const routeID = isTemporaryID(submittedRouteID, 2)
          ? allocateNextID(state, "routeID", usedRouteIDs)
          : normalizeInteger(submittedRouteID, 0);
        if (routeID <= 0) {
          throw new Error("CREATEROUTE requires a valid route ID");
        }
        const submittedKey = temporaryIDKey(submittedRouteID);
        if (submittedKey) {
          idMap.set(submittedKey, routeID);
        }

        const path = (Array.isArray(args[1]) ? args[1] : [])
          .map((pinID) => resolveSubmittedID(pinID, idMap))
          .filter((pinID) => pinID > 0);
        ensurePinsExist(colony, path);
        const route = {
          routeID,
          charID: normalizedOwnerID,
          path,
          commodityTypeID: normalizeInteger(args[2], 0),
          commodityQuantity: normalizeInteger(args[3], 0),
        };
        validateRouteSemantics(colony, route, {
          ownerID: normalizedOwnerID,
          // Only an extractor whose program is installed in this submit has an output that is
          // not known yet. Every other extractor's routes are checked against its output now.
          deferEcuProduction: pendingProgramInstalls.has(getRouteSourceID(route)),
        });
        colony.routes = colony.routes.filter((route) => normalizeInteger(route.routeID, 0) !== routeID);
        colony.routes.push(route);
        colony.routes.sort((left, right) => normalizeInteger(left.routeID, 0) - normalizeInteger(right.routeID, 0));
        break;
      }

      case COMMAND.REMOVEROUTE: {
        const routeID = resolveSubmittedID(args[0], idMap);
        if (!(Array.isArray(colony.routes) ? colony.routes : [])
          .some((route) => normalizeInteger(route.routeID, 0) === routeID)) {
          throw new Error("RouteDoesNotExist");
        }
        colony.routes = colony.routes.filter((route) => normalizeInteger(route.routeID, 0) !== routeID);
        break;
      }

      case COMMAND.SETSCHEMATIC: {
        const pin = findPin(colony, resolveSubmittedID(args[0], idMap));
        if (!pin) {
          throw new Error("PinDoesNotExist");
        }
        assertPinOwnedBy(pin, normalizedOwnerID);
        if (getPinEntityType(pin) !== "process") {
          throw new Error("CannotAssignSchematicToPinType");
        }
        const schematicID = normalizeNullableInteger(args[1]);
        const schematic = planetStaticData.getSchematicByID(schematicID);
        if (!schematic) {
          throw new Error(`Schematic with schematicID ${schematicID} does not exist`);
        }
        if (!Array.isArray(schematic.pinTypeIDs) || !schematic.pinTypeIDs.includes(pin.typeID)) {
          throw new Error("CannotAssignSchematicToPinType");
        }
        installProcessSchematic(pin, schematicID);
        break;
      }

      case COMMAND.UPGRADECOMMANDCENTER: {
        const pin = findPin(colony, resolveSubmittedID(args[0], idMap));
        if (!pin) {
          throw new Error("PinDoesNotExist");
        }
        assertPinOwnedBy(pin, normalizedOwnerID);
        if (getPinEntityType(pin) !== "command") {
          throw new Error("CannotManagePlanetWithoutCommandCenter");
        }
        const level = normalizeInteger(args[1], 0);
        if (level <= normalizeInteger(colony.level, 0)) {
          throw new Error("We can't downgrade");
        }
        if (level > 5) {
          throw new Error("Trying to upgrade past maximum level");
        }
        colony.level = level;
        colony.commandCenterLevel = level;
        break;
      }

      case COMMAND.ADDEXTRACTORHEAD: {
        addExtractorHead(
          findPin(colony, resolveSubmittedID(args[0], idMap)),
          normalizedOwnerID,
          args[1],
          args[2],
          args[3],
        );
        break;
      }

      case COMMAND.KILLEXTRACTORHEAD: {
        removeExtractorHead(
          findPin(colony, resolveSubmittedID(args[0], idMap)),
          normalizedOwnerID,
          args[1],
        );
        break;
      }

      case COMMAND.MOVEEXTRACTORHEAD: {
        moveExtractorHead(
          findPin(colony, resolveSubmittedID(args[0], idMap)),
          normalizedOwnerID,
          args[1],
          args[2],
          args[3],
        );
        break;
      }

      case COMMAND.INSTALLPROGRAM: {
        const pin = findPin(colony, resolveSubmittedID(args[0], idMap));
        const pinID = normalizeInteger(pin && pin.pinID, 0);
        if (!cooldownValidatedEcuPinIDs.has(pinID)) {
          assertCanInstallECUProgram(
            pin,
            normalizedOwnerID,
            args[2],
            editTime,
          );
          cooldownValidatedEcuPinIDs.add(pinID);
        }
        const programTypeID = normalizeNullableInteger(args[1]);
        if (!programTypeID) {
          // Stop Program needs no quote, so it is applied at once. The survey window locks the
          // heads of a running program, so a player who wants to add or remove a head clicks
          // Stop Program, edits the heads and installs again, all in one submit.
          // addExtractorHead and removeExtractorHead refuse while the pin is still active, so
          // deferring the stop would reject that submit. The client's CommandStream drops an
          // earlier INSTALLPROGRAM only when the resource matches too, so the stop and the
          // reinstall both arrive.
          pendingProgramInstalls.delete(pinID);
          installECUProgram(pin, null, args[2], {
            planetID: normalizedPlanetID,
            otherEcuPins: colony.pins,
            state,
            installTime: editTime,
          });
          break;
        }
        // Otherwise only the intent is recorded here. Installing in stream order would quote
        // each extractor against a colony in which the extractors later in the stream have no
        // program yet, so they would impose no overlap penalty and the last one submitted
        // would absorb all of it. The deferred pass below quotes every one of them against
        // the same final layout instead. A later install for the same pin replaces this one.
        pendingProgramInstalls.set(pinID, {
          programTypeID,
          headRadius: args[2],
        });
        break;
      }

      default:
        log.warn(`[PlanetRuntimeStore] Ignoring unsupported PI command ${command.id}`);
        break;
    }
  }

  // Every extractor this submit programs is quoted against the same final layout: heads and
  // link/pin edits are all applied by now, and peerInstallByPinID tells the overlap
  // calculation which program and head radius each peer ends the submit with, so the result no
  // longer depends on the order the commands happened to arrive in. Sorted by pin ID purely so
  // the pass is reproducible.
  if (pendingProgramInstalls.size > 0) {
    for (const pinID of [...pendingProgramInstalls.keys()].sort((left, right) => left - right)) {
      const pin = findPin(colony, pinID);
      if (!pin) {
        // A later REMOVEPIN took the extractor away again; nothing to install onto.
        continue;
      }
      const install = pendingProgramInstalls.get(pinID);
      installECUProgram(pin, install.programTypeID, install.headRadius, {
        planetID: normalizedPlanetID,
        otherEcuPins: colony.pins,
        peerInstallByPinID: pendingProgramInstalls,
        state,
        installTime: editTime,
      });
    }
  }

  // Retail clients remove and recreate ECU routes around InstallProgram, and the server
  // enforces the same invariant so older emulator colonies and non-retail callers cannot
  // retain reservations above a program's maximum output. It runs here, after the stream,
  // rather than inside INSTALLPROGRAM: a route created later in the same stream would
  // otherwise escape the trim entirely, and every later edit to the colony would then fail
  // validation on that one over-sized route with no way for the player to correct it.
  repairEcuSourceRoutes(colony);

  // runColonySimulation deliberately leaves a resumable checkpoint when its
  // safety cap is reached. Do not falsely advance that checkpoint after edits.
  colony.updatedAt = new Date().toISOString();
  validateColonyNetwork(colony, {
    ownerID: normalizedOwnerID,
    planetRadius,
    planetTypeID,
  });
  if (!dryRun) {
    colony.networkRevision = baseRevision + 1;
  }
  state.coloniesByKey[key] = normalizeColony(colony, {
    planetID: normalizedPlanetID,
    ownerID: normalizedOwnerID,
    solarSystemID,
    planetTypeID,
    planetRadius,
  });
  if (dryRun) {
    return state.coloniesByKey[key];
  }
  markNetworkEditReceipt(state, key, operationKey, {
    editHash,
    requestScope,
    baseRevision,
    resultRevision: state.coloniesByKey[key].networkRevision,
    constructionCost,
    createdPinIDs: createdPinIDs instanceof Set ? [...createdPinIDs] : [],
  });
  writeState(state);
  return state.coloniesByKey[key];
}

function previewUserUpdateNetwork(options = {}) {
  return applyUserUpdateNetwork({
    ...options,
    // A dry run persists nothing, so it must never report pins as created — otherwise a
    // caller that previews and then applies would see (and charge for) each pin twice.
    createdPinIDs: null,
    dryRun: true,
  });
}

function prepareLaunchCommodities({
  planetID,
  ownerID,
  solarSystemID = 0,
  planetTypeID = 0,
  commandPinID,
  commodities = {},
  planetMeta = {},
} = {}) {
  const normalizedPlanetID = normalizeInteger(planetID, 0);
  const normalizedOwnerID = normalizeInteger(ownerID, 0);
  const normalizedCommandPinID = normalizeInteger(commandPinID, 0);
  if (normalizedPlanetID <= 0 || normalizedOwnerID <= 0 || normalizedCommandPinID <= 0) {
    return { success: false, errorMsg: "CannotLaunchWithoutColony" };
  }

  const commoditiesToLaunch = normalizeContents(commodities);
  if (Object.keys(commoditiesToLaunch).length < 1) {
    return { success: false, errorMsg: "PleaseSelectCommoditiesToLaunch" };
  }

  const state = readState({ repair: true });
  const key = colonyKey(normalizedPlanetID, normalizedOwnerID);
  if (!state.coloniesByKey[key]) {
    return { success: false, errorMsg: "CannotLaunchWithoutColony" };
  }

  const launchTime = currentFileTimeString();
  const simulationResult = runColonySimulation(state.coloniesByKey[key], launchTime, {
    planetID: normalizedPlanetID,
    ownerID: normalizedOwnerID,
    solarSystemID,
    planetTypeID,
  });
  const colony = simulationResult.colony;
  const commandPin = findPin(colony, normalizedCommandPinID);
  if (!commandPin || getPinEntityType(commandPin) !== "command") {
    return { success: false, errorMsg: "CanOnlyLaunchFromCommandCenters" };
  }

  const lastLaunchTime = filetimeBigInt(commandPin.lastLaunchTime, 0n);
  const currentLaunchTime = filetimeBigInt(launchTime, currentFileTime());
  if (lastLaunchTime > 0n && lastLaunchTime + COMMAND_CENTER_LAUNCH_CYCLE_TICKS > currentLaunchTime) {
    return { success: false, errorMsg: "CannotLaunchCommandPinNotReady" };
  }

  for (const [typeID, quantity] of Object.entries(commoditiesToLaunch)) {
    if (getContentsQuantity(commandPin, typeID) < quantity) {
      return { success: false, errorMsg: "CannotLaunchCommoditiesNotFound" };
    }
  }

  return {
    success: true,
    state,
    key,
    colony,
    commandPin,
    launchTime,
    commoditiesToLaunch,
  };
}

function previewLaunchCommodities(options = {}) {
  const result = prepareLaunchCommodities(options);
  if (!result.success) {
    return result;
  }
  return {
    success: true,
    commandPin: { ...result.commandPin },
    commoditiesToLaunch: { ...result.commoditiesToLaunch },
    launchTime: result.launchTime,
  };
}

function launchCommodities(options = {}) {
  const {
    planetID,
    ownerID,
    solarSystemID = 0,
    planetTypeID = 0,
    commandPinID,
    planetMeta = {},
  } = options;
  const normalizedPlanetID = normalizeInteger(planetID, 0);
  const normalizedOwnerID = normalizeInteger(ownerID, 0);
  const normalizedCommandPinID = normalizeInteger(commandPinID, 0);
  const result = prepareLaunchCommodities(options);
  if (!result.success) {
    return result;
  }

  const {
    state,
    key,
    colony,
    commandPin,
    launchTime,
    commoditiesToLaunch,
  } = result;

  for (const [typeID, quantity] of Object.entries(commoditiesToLaunch)) {
    removeCommodityFromPin(commandPin, typeID, quantity);
  }
  commandPin.lastLaunchTime = launchTime;

  const launchID = allocateNextID(state, "launchID", collectUsedIDs(state, "launchID"));
  const coordinates = buildLaunchCoordinates({
    ...planetMeta,
    planetID: normalizedPlanetID,
    ownerID: normalizedOwnerID,
    solarSystemID,
    planetTypeID,
  }, launchID);
  const launch = normalizeLaunchRecord({
    launchID,
    itemID: launchID,
    ownerID: normalizedOwnerID,
    planetID: normalizedPlanetID,
    solarSystemID: normalizeInteger(solarSystemID, 0),
    commandPinID: normalizedCommandPinID,
    launchTime,
    x: coordinates.x,
    y: coordinates.y,
    z: coordinates.z,
    contents: commoditiesToLaunch,
    deleted: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  state.launchesByID[String(launchID)] = launch;
  state.coloniesByKey[key] = normalizeColony(colony, {
    planetID: normalizedPlanetID,
    ownerID: normalizedOwnerID,
    solarSystemID,
    planetTypeID,
  });
  writeState(state);

  return {
    success: true,
    lastLaunchTime: launchTime,
    launch,
  };
}

function abandonColony(planetID, ownerID) {
  const normalizedPlanetID = normalizeInteger(planetID, 0);
  const normalizedOwnerID = normalizeInteger(ownerID, 0);
  if (normalizedPlanetID <= 0 || normalizedOwnerID <= 0) {
    return false;
  }

  const state = readState({ repair: true });
  delete state.coloniesByKey[colonyKey(normalizedPlanetID, normalizedOwnerID)];
  writeState(state);
  return true;
}

function getColony(planetID, ownerID) {
  const normalizedPlanetID = normalizeInteger(planetID, 0);
  const normalizedOwnerID = normalizeInteger(ownerID, 0);
  if (normalizedPlanetID <= 0 || normalizedOwnerID <= 0) {
    return null;
  }

  const state = readState({ repair: true });
  const key = colonyKey(normalizedPlanetID, normalizedOwnerID);
  const colony = state.coloniesByKey[key];
  if (!colony) {
    return null;
  }

  const simulationResult = runColonySimulation(colony, currentFileTimeString(), {
    planetID: normalizedPlanetID,
    ownerID: normalizedOwnerID,
  });
  if (simulationResult.changed) {
    state.coloniesByKey[key] = simulationResult.colony;
    writeState(state);
  }
  return simulationResult.colony;
}

function listColoniesForCharacter(ownerID) {
  const normalizedOwnerID = normalizeInteger(ownerID, 0);
  if (normalizedOwnerID <= 0) {
    return [];
  }

  const state = readState({ repair: true });
  const colonies = [];
  let changed = false;
  for (const [key, rawColony] of Object.entries(state.coloniesByKey)) {
    if (normalizeInteger(rawColony && rawColony.ownerID, 0) !== normalizedOwnerID) {
      continue;
    }

    const simulationResult = runColonySimulation(rawColony, currentFileTimeString(), {
      planetID: rawColony && rawColony.planetID,
      ownerID: normalizedOwnerID,
    });
    if (simulationResult.changed) {
      state.coloniesByKey[key] = simulationResult.colony;
      changed = true;
    }
    colonies.push(simulationResult.colony);
  }
  if (changed) {
    writeState(state);
  }
  return colonies;
}

function listColoniesForPlanet(planetID) {
  const normalizedPlanetID = normalizeInteger(planetID, 0);
  if (normalizedPlanetID <= 0) {
    return [];
  }

  const state = readState({ repair: true });
  const colonies = [];
  let changed = false;
  for (const [key, rawColony] of Object.entries(state.coloniesByKey)) {
    if (normalizeInteger(rawColony && rawColony.planetID, 0) !== normalizedPlanetID) {
      continue;
    }

    const simulationResult = runColonySimulation(rawColony, currentFileTimeString(), {
      planetID: normalizedPlanetID,
      ownerID: rawColony && rawColony.ownerID,
    });
    if (simulationResult.changed) {
      state.coloniesByKey[key] = simulationResult.colony;
      changed = true;
    }
    colonies.push(simulationResult.colony);
  }
  if (changed) {
    writeState(state);
  }
  return colonies;
}

// Convenience aggregation mirroring the live client's clientPlanet.RestartExtractors():
// for every ECU that has a configured program but is no longer active, reinstall the same
// program (same resource + head radius + heads), which resets its expiry and resumes
// extraction. Active ECUs and never-configured ECUs are left untouched. Each affected
// colony is applied through applyUserUpdateNetwork so the normal simulation/validation/
// persistence path runs (writeState flushes synchronously).
function restartExtractorsForCharacter(ownerID, options = {}) {
  const normalizedOwnerID = normalizeInteger(ownerID, 0);
  if (normalizedOwnerID <= 0) {
    return { ownerID: 0, restartedCount: 0, colonyCount: 0, colonies: [] };
  }
  const planetFilter = normalizeInteger(options.planetID, 0);

  const colonies = listColoniesForCharacter(normalizedOwnerID).filter(
    (colony) => planetFilter <= 0 || normalizeInteger(colony.planetID, 0) === planetFilter,
  );

  const summaries = [];
  let restartedCount = 0;
  let failedCount = 0;

  for (const colony of colonies) {
    const planetID = normalizeInteger(colony.planetID, 0);
    const pins = Array.isArray(colony.pins) ? colony.pins : [];
    const ecuPins = pins.filter((pin) => getPinEntityType(pin) === "ecu");
    const commands = [];
    for (const pin of ecuPins) {
      const programType = normalizeNullableInteger(pin.programType);
      if (!programType) {
        // ECU never had a program configured; nothing to reinstall.
        continue;
      }
      if (normalizeInteger(pin.state, STATE_IDLE) === STATE_ACTIVE) {
        // Still running (not yet expired); leave it alone.
        continue;
      }
      commands.push({
        id: COMMAND.INSTALLPROGRAM,
        args: [
          normalizeInteger(pin.pinID, 0),
          programType,
          normalizeReal(pin.headRadius, RADIUS_DRILL_AREA_MIN),
        ],
      });
    }

    const colonySummary = {
      planetID,
      solarSystemID: normalizeInteger(colony.solarSystemID, 0),
      extractorCount: ecuPins.length,
      restartedCount: 0,
    };

    if (commands.length > 0) {
      try {
        const restartedColony = applyUserUpdateNetwork({
          planetID,
          ownerID: normalizedOwnerID,
          solarSystemID: normalizeInteger(colony.solarSystemID, 0),
          planetTypeID: normalizeInteger(colony.planetTypeID, 0),
          planetRadius: normalizeReal(colony.planetRadius, 0),
          commands,
        });
        const requestedPinIDs = new Set(commands.map((command) => (
          normalizeInteger(command.args[0], 0)
        )));
        const actualRestartCount = (Array.isArray(restartedColony.pins)
          ? restartedColony.pins
          : [])
          .filter((pin) => (
            requestedPinIDs.has(normalizeInteger(pin.pinID, 0)) &&
            normalizeInteger(pin.state, STATE_IDLE) === STATE_ACTIVE &&
            normalizeInteger(pin.qtyPerCycle, 0) > 0
          ))
          .length;
        colonySummary.restartedCount = actualRestartCount;
        restartedCount += actualRestartCount;
      } catch (error) {
        // One colony failing (e.g. a validation edge case) must not abort the others.
        colonySummary.error =
          error && error.message ? error.message : "restart failed";
        failedCount += 1;
        log.warn(
          `[PlanetRuntimeStore] Failed to restart extractors on planet ${planetID} ` +
            `for owner ${normalizedOwnerID}: ${colonySummary.error}`,
        );
      }
    }

    summaries.push(colonySummary);
  }

  return {
    ownerID: normalizedOwnerID,
    restartedCount,
    failedCount,
    colonyCount: summaries.length,
    colonies: summaries,
  };
}

function getColonyByPin(ownerID, pinID) {
  const normalizedOwnerID = normalizeInteger(ownerID, 0);
  const normalizedPinID = normalizeInteger(pinID, 0);
  if (normalizedOwnerID <= 0 || normalizedPinID <= 0) {
    return null;
  }

  const state = readState({ repair: true });
  let changed = false;
  for (const [key, rawColony] of Object.entries(state.coloniesByKey || {})) {
    if (normalizeInteger(rawColony && rawColony.ownerID, 0) !== normalizedOwnerID) {
      continue;
    }

    const simulationResult = runColonySimulation(rawColony, currentFileTimeString(), {
      planetID: rawColony && rawColony.planetID,
      ownerID: normalizedOwnerID,
    });
    const colony = simulationResult.colony;
    if (simulationResult.changed) {
      state.coloniesByKey[key] = colony;
      changed = true;
    }
    if (findPin(colony, normalizedPinID)) {
      if (changed) {
        writeState(state);
      }
      return colony;
    }
  }

  if (changed) {
    writeState(state);
  }
  return null;
}

function prepareSpaceportImportExport({
  planetID,
  ownerID,
  spaceportPinID,
  importCommodities = {},
  exportCommodities = {},
} = {}) {
  const normalizedPlanetID = normalizeInteger(planetID, 0);
  const normalizedOwnerID = normalizeInteger(ownerID, 0);
  const normalizedSpaceportPinID = normalizeInteger(spaceportPinID, 0);
  if (normalizedPlanetID <= 0 || normalizedOwnerID <= 0 || normalizedSpaceportPinID <= 0) {
    return { success: false, errorMsg: "CannotImportEndpointNotFound" };
  }

  const normalizedImports = normalizeContents(importCommodities);
  const normalizedExports = normalizeContents(exportCommodities);
  if (
    Object.keys(normalizedImports).length < 1 &&
    Object.keys(normalizedExports).length < 1
  ) {
    return { success: false, errorMsg: "PleaseSelectCommoditiesToImport" };
  }

  const state = readState({ repair: true });
  const key = colonyKey(normalizedPlanetID, normalizedOwnerID);
  if (!state.coloniesByKey[key]) {
    return { success: false, errorMsg: "CannotImportEndpointNotFound" };
  }

  const simulationResult = runColonySimulation(state.coloniesByKey[key], currentFileTimeString(), {
    planetID: normalizedPlanetID,
    ownerID: normalizedOwnerID,
  });
  const colony = simulationResult.colony;
  const spaceportPin = findPin(colony, normalizedSpaceportPinID);
  if (!spaceportPin || getPinEntityType(spaceportPin) !== "spaceport") {
    return { success: false, errorMsg: "CannotImportEndpointNotFound" };
  }

  const workingPin = cloneJson(spaceportPin);
  for (const [typeID, quantity] of Object.entries(normalizedExports)) {
    if (getContentsQuantity(workingPin, typeID) < quantity) {
      return { success: false, errorMsg: "CannotLaunchCommoditiesNotFound" };
    }
    removeCommodityFromPin(workingPin, typeID, quantity);
  }

  for (const [typeID, quantity] of Object.entries(normalizedImports)) {
    if (getAcceptableQuantity(workingPin, typeID, quantity) < quantity) {
      return { success: false, errorMsg: "NotEnoughCargoSpace" };
    }
    addCommodityToPin(workingPin, typeID, quantity);
  }

  return {
    success: true,
    state,
    key,
    colony,
    spaceportPin,
    workingPin,
    importCommodities: normalizedImports,
    exportCommodities: normalizedExports,
  };
}

function prepareExpeditedTransfer({
  planetID,
  ownerID,
  solarSystemID = 0,
  planetTypeID = 0,
  planetRadius = 0,
  path = [],
  commodities = {},
} = {}) {
  const normalizedPlanetID = normalizeInteger(planetID, 0);
  const normalizedOwnerID = normalizeInteger(ownerID, 0);
  const normalizedPath = normalizeTransferPath(path);
  const normalizedCommodities = normalizeContents(commodities);
  if (normalizedPlanetID <= 0 || normalizedOwnerID <= 0) {
    return { success: false, errorMsg: "CannotManagePlanetWithoutCommandCenter" };
  }
  if (normalizedPath.length < 2) {
    return { success: false, errorMsg: "CreateRouteTooShort" };
  }
  if (Object.keys(normalizedCommodities).length < 1) {
    return { success: false, errorMsg: "CreateRouteWithoutCommodities" };
  }

  const state = readState({ repair: true });
  const key = colonyKey(normalizedPlanetID, normalizedOwnerID);
  if (!state.coloniesByKey[key]) {
    return { success: false, errorMsg: "CannotManagePlanetWithoutCommandCenter" };
  }

  const runTime = currentFileTimeString();
  const simulationResult = runColonySimulation(state.coloniesByKey[key], runTime, {
    planetID: normalizedPlanetID,
    ownerID: normalizedOwnerID,
    solarSystemID,
    planetTypeID,
    planetRadius,
  });
  const colony = simulationResult.colony;
  const sourcePin = findPin(colony, normalizedPath[0]);
  const destinationPin = findPin(colony, normalizedPath[normalizedPath.length - 1]);
  if (!sourcePin || !destinationPin) {
    return { success: false, errorMsg: "RouteFailedValidationPinDoesNotExist" };
  }
  if (!isStorageEntityType(getPinEntityType(sourcePin))) {
    return { success: false, errorMsg: "RouteFailedValidationExpeditedSourceNotStorage" };
  }

  for (const pinID of normalizedPath) {
    const pin = findPin(colony, pinID);
    if (!pin) {
      return { success: false, errorMsg: "RouteFailedValidationPinDoesNotExist" };
    }
    if (normalizeInteger(pin.ownerID, normalizedOwnerID) !== normalizedOwnerID) {
      return { success: false, errorMsg: "RouteFailedValidationPinNotYours" };
    }
  }

  for (const [typeID, quantity] of Object.entries(normalizedCommodities)) {
    if (getContentsQuantity(sourcePin, typeID) <= 0) {
      return { success: false, errorMsg: "RouteFailedValidationExpeditedSourceLacksCommodity" };
    }
    if (getContentsQuantity(sourcePin, typeID) < quantity) {
      return { success: false, errorMsg: "RouteFailedValidationExpeditedSourceLacksCommodityQty" };
    }
    if (getAcceptableQuantity(destinationPin, typeID, quantity) < 1) {
      return { success: false, errorMsg: "RouteFailedValidationExpeditedDestinationCannotAccept" };
    }
  }

  let minBandwidth;
  try {
    minBandwidth = getMinimumLinkBandwidthForPath(colony, normalizedPath);
  } catch (error) {
    return {
      success: false,
      errorMsg: error && error.message ? error.message : "RouteFailedValidationNoBandwidthAvailable",
    };
  }
  if (!(minBandwidth > 0)) {
    return { success: false, errorMsg: "RouteFailedValidationNoBandwidthAvailable" };
  }

  const nextTransferTime = filetimeBigInt(sourcePin.lastRunTime, 0n);
  const currentRunTime = filetimeBigInt(runTime, currentFileTime());
  if (nextTransferTime > currentRunTime) {
    return { success: false, errorMsg: "RouteFailedValidationExpeditedSourceNotReady" };
  }

  return {
    success: true,
    state,
    key,
    colony,
    sourcePin,
    destinationPin,
    path: normalizedPath,
    commoditiesToTransfer: normalizedCommodities,
    minBandwidth,
    runTime,
  };
}

function previewTransferCommodities(options = {}) {
  const result = prepareExpeditedTransfer(options);
  if (!result.success) {
    return result;
  }
  return {
    success: true,
    path: [...result.path],
    commoditiesToTransfer: { ...result.commoditiesToTransfer },
    minBandwidth: result.minBandwidth,
    runTime: result.runTime,
    sourcePin: { ...result.sourcePin },
    destinationPin: { ...result.destinationPin },
  };
}

function transferCommodities(options = {}) {
  const result = prepareExpeditedTransfer(options);
  if (!result.success) {
    return result;
  }

  const movedCommodities = {};
  for (const [typeID, quantity] of Object.entries(result.commoditiesToTransfer)) {
    const transferQuantity = Math.min(
      normalizeInteger(quantity, 0),
      getContentsQuantity(result.sourcePin, typeID),
    );
    const movedQuantity = addCommodityToPin(result.destinationPin, typeID, transferQuantity);
    if (movedQuantity > 0) {
      removeCommodityFromPin(result.sourcePin, typeID, movedQuantity);
      movedCommodities[String(typeID)] = movedQuantity;
    }
  }

  if (Object.keys(movedCommodities).length < 1) {
    return { success: false, errorMsg: "RouteFailedValidationExpeditedDestinationCannotAccept" };
  }

  stimulateIdlePin(result.colony, result.destinationPin, filetimeBigInt(result.runTime));

  const transferTicks = BigInt(getExpeditedTransferTimeTicks(
    result.minBandwidth,
    movedCommodities,
  ));
  const sourceRunTime = (
    filetimeBigInt(result.runTime, currentFileTime()) + transferTicks
  ).toString();
  result.sourcePin.lastRunTime = sourceRunTime;
  result.colony.currentSimTime = result.runTime;
  result.colony.updatedAt = new Date().toISOString();
  result.state.coloniesByKey[result.key] = normalizeColony(result.colony, {
    planetID: options.planetID,
    ownerID: options.ownerID,
    solarSystemID: options.solarSystemID,
    planetTypeID: options.planetTypeID,
    planetRadius: options.planetRadius,
  });
  writeState(result.state);

  return {
    success: true,
    simTime: result.runTime,
    sourceRunTime,
    movedCommodities,
    path: result.path,
    sourcePinID: normalizeInteger(result.sourcePin.pinID, 0),
    destinationPinID: normalizeInteger(result.destinationPin.pinID, 0),
  };
}

function previewSpaceportImportExport(options = {}) {
  const result = prepareSpaceportImportExport(options);
  if (!result.success) {
    return result;
  }
  return {
    success: true,
    colony: result.colony,
    spaceportPin: { ...result.spaceportPin },
    importCommodities: { ...result.importCommodities },
    exportCommodities: { ...result.exportCommodities },
  };
}

function applySpaceportImportExport(options = {}) {
  const {
    planetID,
    ownerID,
  } = options;
  const normalizedPlanetID = normalizeInteger(planetID, 0);
  const normalizedOwnerID = normalizeInteger(ownerID, 0);
  const normalizedSpaceportPinID = normalizeInteger(options.spaceportPinID, 0);
  const idempotencyKey = String(options.idempotencyKey || "").trim();
  const normalizedImports = normalizeContents(options.importCommodities);
  const normalizedExports = normalizeContents(options.exportCommodities);
  const fingerprint = JSON.stringify({
    planetID: normalizedPlanetID,
    ownerID: normalizedOwnerID,
    spaceportPinID: normalizedSpaceportPinID,
    importCommodities: Object.fromEntries(
      Object.entries(normalizedImports).sort(([left], [right]) => Number(left) - Number(right)),
    ),
    exportCommodities: Object.fromEntries(
      Object.entries(normalizedExports).sort(([left], [right]) => Number(left) - Number(right)),
    ),
  });
  if (idempotencyKey) {
    const state = readState({ repair: true });
    const existing = state.customsOperationReceipts[idempotencyKey];
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        return { success: false, ambiguous: true, errorMsg: "IDEMPOTENCY_KEY_REUSED" };
      }
      return {
        success: true,
        duplicate: true,
        data: cloneJson(existing.result),
        ...cloneJson(existing.result),
      };
    }
  }
  const result = prepareSpaceportImportExport(options);
  if (!result.success) {
    return result;
  }

  result.spaceportPin.contents = normalizeContents(result.workingPin.contents);
  result.colony.currentSimTime = currentFileTimeString();
  result.colony.updatedAt = new Date().toISOString();
  result.state.coloniesByKey[result.key] = normalizeColony(result.colony, {
    planetID: normalizedPlanetID,
    ownerID: normalizedOwnerID,
  });
  const resultData = {
    colony: result.state.coloniesByKey[result.key],
    spaceportPin: normalizePin(result.spaceportPin, normalizedOwnerID),
    importCommodities: result.importCommodities,
    exportCommodities: result.exportCommodities,
  };
  if (idempotencyKey) {
    result.state.customsOperationReceipts[idempotencyKey] = {
      fingerprint,
      result: cloneJson(resultData),
      createdAt: new Date().toISOString(),
    };
    const receiptKeys = Object.keys(result.state.customsOperationReceipts);
    if (receiptKeys.length > MAX_CUSTOMS_OPERATION_RECEIPTS) {
      receiptKeys
        .sort((left, right) => String(
          result.state.customsOperationReceipts[left] &&
            result.state.customsOperationReceipts[left].createdAt,
        ).localeCompare(String(
          result.state.customsOperationReceipts[right] &&
            result.state.customsOperationReceipts[right].createdAt,
        )))
        .slice(0, receiptKeys.length - MAX_CUSTOMS_OPERATION_RECEIPTS)
        .forEach((key) => delete result.state.customsOperationReceipts[key]);
    }
  }
  if (!writeState(result.state)) {
    return { success: false, ambiguous: true, errorMsg: "WRITE_ERROR" };
  }

  return {
    success: true,
    duplicate: false,
    data: cloneJson(resultData),
    ...resultData,
  };
}

function listLaunchesForCharacter(ownerID) {
  const normalizedOwnerID = normalizeInteger(ownerID, 0);
  if (normalizedOwnerID <= 0) {
    return [];
  }

  const state = readState({ repair: true });
  return Object.values(state.launchesByID)
    .map(normalizeLaunchRecord)
    .filter((launch) => (
      normalizeInteger(launch && launch.ownerID, 0) === normalizedOwnerID &&
      launch.deleted !== true
    ));
}

function cleanupExpiredLaunches(options = {}) {
  const state = readState({ repair: true });
  const nowFileTime = filetimeBigInt(options.nowFileTime, currentFileTime());
  const maxAgeDays = normalizeInteger(options.maxAgeDays, 0);
  const maxAgeTicks = maxAgeDays > 0
    ? BigInt(maxAgeDays) * DAY_TICKS
    : null;
  const ownerID = normalizeInteger(options.ownerID, 0);
  const planetID = normalizeInteger(options.planetID, 0);
  let scanned = 0;
  let deleted = 0;
  const deletedLaunchIDs = [];

  for (const [launchKey, rawLaunch] of Object.entries(state.launchesByID || {})) {
    const launch = normalizeLaunchRecord(rawLaunch);
    if (ownerID > 0 && normalizeInteger(launch.ownerID, 0) !== ownerID) {
      continue;
    }
    if (planetID > 0 && normalizeInteger(launch.planetID, 0) !== planetID) {
      continue;
    }

    scanned += 1;
    if (launch.deleted === true || !isLaunchCleanupEligible(launch, nowFileTime, maxAgeTicks)) {
      continue;
    }

    launch.deleted = true;
    launch.deletedAt = new Date().toISOString();
    launch.updatedAt = launch.deletedAt;
    state.launchesByID[launchKey] = launch;
    deleted += 1;
    deletedLaunchIDs.push(normalizeInteger(launch.launchID, 0));
  }

  if (deleted > 0) {
    writeState(state);
  }

  return {
    scanned,
    deleted,
    deletedLaunchIDs,
    maxAgeDays: maxAgeDays > 0
      ? maxAgeDays
      : Number((PI_LAUNCH_ORBIT_DECAY_TICKS + PI_LAUNCH_CLEANUP_GRACE_TICKS) / DAY_TICKS),
  };
}

function summarizePin(pin = {}) {
  const entityType = getPinEntityType(pin);
  return {
    pinID: normalizeInteger(pin.pinID ?? pin.id, 0),
    typeID: normalizeInteger(pin.typeID, 0),
    entityType: entityType || "",
    state: normalizeInteger(pin.state, STATE_IDLE),
    schematicID: normalizeNullableInteger(pin.schematicID),
    programType: normalizeNullableInteger(pin.programType),
    contents: summarizeContents(pin.contents),
    lastRunTime: pin.lastRunTime ? String(pin.lastRunTime) : null,
    lastLaunchTime: pin.lastLaunchTime ? String(pin.lastLaunchTime) : null,
  };
}

function summarizeColony(colony = {}) {
  const normalizedColony = normalizeColony(colony, {
    planetID: colony && colony.planetID,
    ownerID: colony && colony.ownerID,
  });
  const pinSummaries = (Array.isArray(normalizedColony.pins) ? normalizedColony.pins : [])
    .map(summarizePin)
    .sort((left, right) => left.pinID - right.pinID);
  const contentsByTypeID = {};
  for (const pin of normalizedColony.pins) {
    for (const [typeID, quantity] of Object.entries(normalizeContents(pin.contents))) {
      contentsByTypeID[typeID] = normalizeInteger(contentsByTypeID[typeID], 0) +
        normalizeInteger(quantity, 0);
    }
  }

  return {
    planetID: normalizeInteger(normalizedColony.planetID, 0),
    ownerID: normalizeInteger(normalizedColony.ownerID, 0),
    level: normalizeInteger(normalizedColony.level, 0),
    currentSimTime: normalizedColony.currentSimTime ? String(normalizedColony.currentSimTime) : null,
    pinCount: pinSummaries.length,
    linkCount: Array.isArray(normalizedColony.links) ? normalizedColony.links.length : 0,
    routeCount: Array.isArray(normalizedColony.routes) ? normalizedColony.routes.length : 0,
    activePinCount: pinSummaries.filter((pin) => pin.state === STATE_ACTIVE).length,
    pins: pinSummaries,
    contentsByTypeID: summarizeContents(contentsByTypeID),
  };
}

function summarizeResourceRecord(record = {}) {
  if (!isPlainObject(record)) {
    return {
      resourceTypeIDs: [],
      qualitiesByTypeID: {},
      layers: [],
    };
  }

  const layers = [];
  for (const resourceTypeID of normalizeResourceTypeIDs(record.resourceTypeIDs)) {
    const layer = getResourceLayerFromRecord(record, resourceTypeID);
    layers.push({
      resourceTypeID,
      quality: normalizeInteger(
        record.qualitiesByTypeID && record.qualitiesByTypeID[String(resourceTypeID)],
        0,
      ),
      hotspotCount: layer && Array.isArray(layer.hotspots) ? layer.hotspots.length : 0,
      depletionEventCount: layer && Array.isArray(layer.depletionEvents)
        ? layer.depletionEvents.length
        : 0,
    });
  }

  return {
    version: normalizeInteger(record.version, 0),
    planetID: normalizeInteger(record.planetID, 0),
    resourceTypeIDs: normalizeResourceTypeIDs(record.resourceTypeIDs),
    qualitiesByTypeID: isPlainObject(record.qualitiesByTypeID)
      ? { ...record.qualitiesByTypeID }
      : {},
    layers,
  };
}

function getPlanetDiagnostics(options = {}) {
  const state = readState({ repair: true });
  const planetID = normalizeInteger(options.planetID, 0);
  const ownerID = normalizeInteger(options.ownerID, 0);
  const nowFileTime = currentFileTime();
  const colonies = Object.values(state.coloniesByKey || {})
    .filter((colony) => (
      (planetID <= 0 || normalizeInteger(colony && colony.planetID, 0) === planetID) &&
      (ownerID <= 0 || normalizeInteger(colony && colony.ownerID, 0) === ownerID)
    ))
    .map(summarizeColony)
    .sort((left, right) => (
      left.planetID === right.planetID
        ? left.ownerID - right.ownerID
        : left.planetID - right.planetID
    ));
  const launches = Object.values(state.launchesByID || {})
    .map(normalizeLaunchRecord)
    .filter((launch) => (
      (planetID <= 0 || normalizeInteger(launch.planetID, 0) === planetID) &&
      (ownerID <= 0 || normalizeInteger(launch.ownerID, 0) === ownerID)
    ));
  const activeLaunches = launches.filter((launch) => (
    launch.deleted !== true && !isLaunchExpired(launch, nowFileTime)
  ));
  const expiredLaunches = launches.filter((launch) => (
    launch.deleted !== true && isLaunchExpired(launch, nowFileTime)
  ));
  const resourceRecord = planetID > 0
    ? state.resourcesByPlanetID[String(planetID)]
    : null;

  return {
    schemaVersion: normalizeInteger(state.schemaVersion, SCHEMA_VERSION),
    planetID,
    ownerID,
    colonyCount: colonies.length,
    colonies,
    launches: {
      total: launches.length,
      active: activeLaunches.length,
      expired: expiredLaunches.length,
      deleted: launches.filter((launch) => launch.deleted === true).length,
    },
    resources: summarizeResourceRecord(resourceRecord),
    nextIDs: isPlainObject(state.nextIDs) ? { ...state.nextIDs } : cloneJson(DEFAULT_NEXT_IDS),
  };
}

function addCommodityToColonyPin({
  planetID,
  ownerID,
  pinID,
  typeID,
  quantity,
} = {}) {
  const normalizedPlanetID = normalizeInteger(planetID, 0);
  const normalizedOwnerID = normalizeInteger(ownerID, 0);
  const normalizedPinID = normalizeInteger(pinID, 0);
  const normalizedTypeID = normalizeInteger(typeID, 0);
  const normalizedQuantity = normalizeInteger(quantity, 0);
  if (
    normalizedPlanetID <= 0 ||
    normalizedOwnerID <= 0 ||
    normalizedPinID <= 0 ||
    normalizedTypeID <= 0 ||
    normalizedQuantity <= 0
  ) {
    return { success: false, errorMsg: "INVALID_ARGUMENTS" };
  }

  const state = readState({ repair: true });
  const key = colonyKey(normalizedPlanetID, normalizedOwnerID);
  const colony = state.coloniesByKey[key]
    ? normalizeColony(state.coloniesByKey[key], {
      planetID: normalizedPlanetID,
      ownerID: normalizedOwnerID,
    })
    : null;
  if (!colony) {
    return { success: false, errorMsg: "COLONY_NOT_FOUND" };
  }

  const pin = findPin(colony, normalizedPinID);
  if (!pin) {
    return { success: false, errorMsg: "PIN_NOT_FOUND" };
  }

  const added = addCommodityToPin(pin, normalizedTypeID, normalizedQuantity);
  if (added <= 0) {
    return { success: false, errorMsg: "PIN_CANNOT_ACCEPT_COMMODITY" };
  }

  state.coloniesByKey[key] = normalizeColony(colony, {
    planetID: normalizedPlanetID,
    ownerID: normalizedOwnerID,
  });
  writeState(state);
  return {
    success: true,
    added,
    colony: state.coloniesByKey[key],
  };
}

function getLaunch(launchID, ownerID = 0) {
  const normalizedLaunchID = normalizeInteger(launchID, 0);
  if (normalizedLaunchID <= 0) {
    return null;
  }

  const state = readState({ repair: true });
  const launch = findStoredLaunch(state, normalizedLaunchID);
  if (!launch) {
    return null;
  }

  const normalizedLaunch = normalizeLaunchRecord(launch);
  const normalizedOwnerID = normalizeInteger(ownerID, 0);
  if (
    normalizedLaunch.deleted === true ||
    (
      normalizedOwnerID > 0 &&
      normalizeInteger(normalizedLaunch.ownerID, 0) > 0 &&
      normalizeInteger(normalizedLaunch.ownerID, 0) !== normalizedOwnerID
    )
  ) {
    return null;
  }
  return normalizedLaunch;
}

function deleteLaunch(launchID, ownerID = 0) {
  const normalizedLaunchID = normalizeInteger(launchID, 0);
  if (normalizedLaunchID <= 0) {
    return false;
  }

  const state = readState({ repair: true });
  const launch = findStoredLaunch(state, normalizedLaunchID);
  if (!launch) {
    return true;
  }

  // A launch that has an owner is removed for that owner only. A caller with no
  // owner to give (a session with no character chosen sends 0) is not it.
  const normalizedOwnerID = normalizeInteger(ownerID, 0);
  if (
    normalizeInteger(launch.ownerID, 0) > 0 &&
    normalizeInteger(launch.ownerID, 0) !== normalizedOwnerID
  ) {
    return false;
  }

  launch.deleted = true;
  launch.deletedAt = new Date().toISOString();
  writeState(state);
  return true;
}

function attachLaunchContainer({
  launchID,
  ownerID = 0,
  itemID,
} = {}) {
  const normalizedLaunchID = normalizeInteger(launchID, 0);
  const normalizedItemID = normalizeInteger(itemID, 0);
  if (normalizedLaunchID <= 0 || normalizedItemID <= 0) {
    return null;
  }

  const state = readState({ repair: true });
  const launch = state.launchesByID[String(normalizedLaunchID)];
  if (!launch) {
    return null;
  }

  const normalizedOwnerID = normalizeInteger(ownerID, 0);
  if (
    normalizedOwnerID > 0 &&
    normalizeInteger(launch.ownerID, 0) > 0 &&
    normalizeInteger(launch.ownerID, 0) !== normalizedOwnerID
  ) {
    return null;
  }

  const updatedLaunch = normalizeLaunchRecord({
    ...launch,
    itemID: normalizedItemID,
    physicalContainerID: normalizedItemID,
    updatedAt: new Date().toISOString(),
  });
  state.launchesByID[String(normalizedLaunchID)] = updatedLaunch;
  writeState(state);
  return updatedLaunch;
}

module.exports = {
  TABLE_NAME,
  SCHEMA_VERSION,
  DEFAULT_NEXT_IDS,
  COMMAND,
  LINK_TYPE_ID,
  PLANET_RESOURCE_MAX_VALUE,
  RESOURCE_SH_MAX_BANDS,
  PI_LAUNCH_ORBIT_DECAY_TICKS,
  EXPEDITED_TRANSFER_MINIMUM_TICKS,
  getOrCreatePlanetResources,
  getResourceQualitiesForClient,
  getResourceDataForClient,
  getResourceLayer,
  evaluateResourceValueAt,
  getColony,
  getColonyByPin,
  listColoniesForCharacter,
  listColoniesForPlanet,
  restartExtractorsForCharacter,
  listLaunchesForCharacter,
  getNetworkEditReplay,
  cleanupExpiredLaunches,
  getPlanetDiagnostics,
  addCommodityToColonyPin,
  getLaunch,
  deleteLaunch,
  attachLaunchContainer,
  previewLaunchCommodities,
  launchCommodities,
  previewTransferCommodities,
  transferCommodities,
  previewSpaceportImportExport,
  applySpaceportImportExport,
  previewUserUpdateNetwork,
  applyUserUpdateNetwork,
  abandonColony,
  estimateProgramResult,
  _testing: {
    setNowFileTimeOverride,
    resetNowFileTimeOverride,
    buildPin,
    buildResourceRecord,
    buildResourceLayer,
    buildResourceLayerCoefficients,
    buildResourceLayerBuffer,
    evaluateResourceLayerValue,
    evaluateResourceHarmonicBuffer,
    evaluateResourceLayerHarmonicValue,
    normalizeCommandStream,
    normalizeColony,
    normalizeResourceLayer,
    normalizeState,
    stableHash,
    validateColonyNetwork,
    getExpeditedTransferTimeTicks,
    assertCanInstallECUProgram,
    assertExtractorHeadWithinArea,
    getEcuProgramOutput,
    installECUProgram,
    installProcessSchematic,
    stimulateIdlePin,
    getPinProducts,
    getSchematicOutputMultiplier,
    scaleSchematicOutput,
    runProcessCycle,
    routeCommodityOutput,
    runColonySimulation,
  },
};
