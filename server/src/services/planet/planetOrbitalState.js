"use strict";

const path = require("path");

const database = require(path.join(__dirname, "../../gameStore"));
const log = require(path.join(__dirname, "../../utils/logger"));
const {
  TABLE,
  readStaticRows,
} = require(path.join(__dirname, "../_shared/referenceData"));
const {
  findItemById,
  getItemMetadata,
  updateInventoryItem,
} = require(path.join(__dirname, "../inventory/itemStore"));
const {
  resolveAbyssalDeployableItemRestriction,
  resolveAbyssalDeployableLaunchRestriction,
} = require(path.join(__dirname, "../_shared/abyssalDeployablePolicy"));
const {
  resolveSessionCharacterID,
} = require(path.join(__dirname, "../_shared/sessionIdentity"));
const {
  peekCharacterRecord,
} = require(path.join(__dirname, "../character/characterState"));
const {
  getCorporationRecord,
} = require(path.join(__dirname, "../corporation/corporationState"));
const {
  getCorporationRuntime,
} = require(path.join(__dirname, "../corporation/corporationRuntimeState"));

const TABLE_NAME = "planetOrbitalState";
const SCHEMA_VERSION = 1;

const CATEGORY_ORBITAL = 46;
const GROUP_PLANETARY_CUSTOMS_OFFICES = 1025;
const GROUP_ORBITAL_CONSTRUCTION_PLATFORM = 1106;
const TYPE_CUSTOMS_OFFICE = 2233;
const TYPE_CUSTOMS_OFFICE_GANTRY = 3962;
const TYPE_INTERBUS_CUSTOMS_OFFICE = 4318;
const DEFAULT_CUSTOMS_OFFICE_ITEM_ID_OFFSET = 1_200_000_000_000;
// An office no player corporation holds is InterBus's: const.ownerInterBus (inventorycommon/const.py 3223), to
// whom a closed corporation's orbitals go back (eveplanet/orbital.py OrbitalOwnershipChanger.ChangeOwnerToInterBus,
// planetOrbitalRegistryBroker.RevertOrbitalsToInterBus). Its slim item's corpID is a corporation's then, whose
// ticker the client has of its own data, as every corpID on Tranquility is.
const DEFAULT_CUSTOMS_OFFICE_OWNER_ID = 1000148;
const GROUP_ORBITAL_SKYHOOK = 4736;
const INTERBUS_TAX_RATE = 0.17;

const ORBITAL_STATE = Object.freeze({
  OFFLINING: -7,
  ANCHORING: -6,
  ONLINING: -5,
  ANCHORED: -4,
  UNANCHORING: -3,
  UNANCHORED: -2,
  IDLE: 0,
  OPERATING: 1,
});

const DEFAULT_ORBITAL_TIMER_MS = Math.max(
  1_000,
  Number(process.env.EVEJS_PI_ORBITAL_TIMER_MS) || 60_000,
);

const DEFAULT_TAX_RATES = Object.freeze({
  corporation: 0.05,
  alliance: 0.05,
  standingHorrible: 0.05,
  standingBad: 0.05,
  standingNeutral: 0.05,
  standingGood: 0.05,
  standingHigh: 0.05,
});

const DEFAULT_DUN_ROTATION = Object.freeze([0, 0, 0]);
const MAX_TIMER_DELAY_MS = 2_147_000_000;
let planetCacheBySystem = null;
let planetCacheByID = null;
const orbitalTransitionTimers = new Map();
// Loaded/imported rows still need the legacy normalization/repair pass. Remember
// checked stable row objects weakly so warm reads skip it, while replaced rows
// are checked again without retaining removed rows or scanning serialized data.
let checkedStableOrbitalRecords = new WeakSet();
const TYPE_ORBITAL_SKYHOOK = 81080;
// Sovereignty caches deployed skyhooks, so it needs to know when their rows
// change. Its reads compare this revision instead of scanning the table, and
// writes that touch only other orbitals, such as each hit on a customs office,
// leave the revision alone.
let deployedSkyhookRevision = 0;
let deployedSkyhookSignature = null;
let resourcePersistencePending = false;
let replacementRecoveryDiscovered = false;
let replacementRecoveryDiscoveryTimer = null;

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function toInt(value, fallback = 0) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? Math.trunc(numericValue) : fallback;
}

function toReal(value, fallback = 0) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : fallback;
}

function resolveOrbitalAbyssalRestriction(item, record = null) {
  const subject = item || (record && {
    itemID: record.itemID,
    locationID: record.solarSystemID,
    systemID: record.solarSystemID,
  });
  return resolveAbyssalDeployableItemRestriction(subject, record || {});
}

function normalizeVector(value, fallback = { x: 0, y: 0, z: 0 }) {
  const source = isPlainObject(value) ? value : fallback;
  return {
    x: toReal(source && source.x, fallback.x),
    y: toReal(source && source.y, fallback.y),
    z: toReal(source && source.z, fallback.z),
  };
}

function normalizeDunRotation(value) {
  if (!Array.isArray(value) || value.length < 3) {
    return [...DEFAULT_DUN_ROTATION];
  }
  return [
    toReal(value[0], 0),
    toReal(value[1], 0),
    toReal(value[2], 0),
  ];
}

function distanceSquared(left, right) {
  const dx = toReal(left && left.x, 0) - toReal(right && right.x, 0);
  const dy = toReal(left && left.y, 0) - toReal(right && right.y, 0);
  const dz = toReal(left && left.z, 0) - toReal(right && right.z, 0);
  return dx * dx + dy * dy + dz * dz;
}

function normalizeTaxRates(rawRates = {}) {
  const rates = {};
  const source = isPlainObject(rawRates) ? rawRates : {};
  for (const [key, defaultValue] of Object.entries(DEFAULT_TAX_RATES)) {
    const value = Number(source[key]);
    rates[key] = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : defaultValue;
  }
  return rates;
}

function normalizeOrbitalConditionState(rawConditionState = {}) {
  const source = isPlainObject(rawConditionState) ? rawConditionState : {};
  const clampUnit = (value, fallback) => {
    const numericValue = Number(value);
    return Number.isFinite(numericValue)
      ? Math.max(0, Math.min(1, numericValue))
      : fallback;
  };
  return {
    shieldCharge: clampUnit(source.shieldCharge, 1),
    armorDamage: clampUnit(source.armorDamage, 0),
    damage: clampUnit(source.damage, 0),
  };
}

function isOrbitalRecordDestroyed(record) {
  return toInt(record && record.destroyedAtMs, 0) > 0;
}

function isCustomsInventoryOrbitalRecord(record) {
  return Boolean(record) && !isOrbitalRecordDestroyed(record) &&
    [GROUP_PLANETARY_CUSTOMS_OFFICES, GROUP_ORBITAL_SKYHOOK].includes(Number(record.groupID)) &&
    (Number(record.groupID) !== GROUP_ORBITAL_SKYHOOK ||
      [ORBITAL_STATE.IDLE, ORBITAL_STATE.OPERATING].includes(Number(record.state))) &&
    !isOfficeReplacementPending(record.itemID, record.planetID) &&
    !isSkyhookDeploymentPending(record);
}

function isOfficeReplacementPending(itemID, planetID) {
  const pending = readState().replacementsByPlanet?.[String(planetID)];
  return Boolean(pending && !pending.completed &&
    (!pending.phase || pending.phase === "finalizing") && pending.officeIDs.includes(Number(itemID)));
}

function isSkyhookDeploymentPending(record) {
  const intent = readState().replacementsByPlanet?.[String(record && record.planetID)];
  return Boolean(intent && !intent.completed && Number(intent.launchedItemID) === Number(record.itemID));
}

function isSkyhookDeploymentUnpublished(record) {
  if (!isSkyhookDeploymentPending(record)) return false;
  const intent = readState().replacementsByPlanet[String(record.planetID)];
  return intent.phase !== "onlining";
}

function normalizeState(rawState = {}) {
  const state = isPlainObject(rawState) ? { ...rawState } : {};
  let changed = false;

  if (state.schemaVersion !== SCHEMA_VERSION) {
    state.schemaVersion = SCHEMA_VERSION;
    changed = true;
  }
  if (!isPlainObject(state.orbitalsByID)) {
    state.orbitalsByID = {};
    changed = true;
  } else {
    // Callers replace normalized rows before writeState. Keep those map edits
    // out of the database's cached table until the write boundary is reached.
    state.orbitalsByID = { ...state.orbitalsByID };
  }
  state.replacementsByPlanet = isPlainObject(state.replacementsByPlanet)
    ? { ...state.replacementsByPlanet } : {};

  return { state, changed };
}

function readState(options = {}) {
  const result = database.read(TABLE_NAME, "/");
  if (!result.success) {
    log.warn(
      `[PlanetOrbitalState] Failed to read ${TABLE_NAME}: ${result.errorMsg || "READ_ERROR"}`,
    );
  }

  const { state, changed } = normalizeState(result.success ? result.data : {});
  if (result.success && !replacementRecoveryDiscovered) {
    // Mark discovery before repair writes or fuel settlement can re-enter this
    // owner. The saga itself runs later, outside every read/write/fuel stack.
    replacementRecoveryDiscovered = true;
    const systems = [...new Set(Object.values(state.replacementsByPlanet)
      .filter(intent => intent && (!intent.completed || !intent.presentationCompleted))
      .map(intent => toInt(intent.systemID, 0)).filter(systemID => systemID > 0))];
    if (systems.length) {
      replacementRecoveryDiscoveryTimer = setTimeout(() => {
        replacementRecoveryDiscoveryTimer = null;
        try {
          const replacement = require("./skyhookOfficeReplacement");
          for (const systemID of systems) replacement.scheduleRecovery(systemID);
        } catch (error) {
          replacementRecoveryDiscovered = false;
          log.warn(`[PlanetOrbitalState] Replacement recovery discovery failed: ${error.message}`);
        }
      }, 0);
      replacementRecoveryDiscoveryTimer.unref?.();
    }
  }
  if (changed && options.repair === true) {
    writeState(state);
  }
  if (deployedSkyhookSignature === null) {
    noteDeployedSkyhookRows(state.orbitalsByID, state.replacementsByPlanet);
  }
  return state;
}

function flushStateToDisk() {
  const result = database.flushTableSync(TABLE_NAME);
  if (!result.success) {
    log.warn(
      `[PlanetOrbitalState] Failed to flush ${TABLE_NAME}: ${result.errorMsg || "FLUSH_ERROR"}`,
    );
  }
  return result.success === true;
}

function isDeployedSkyhookRecord(record) {
  return Boolean(record) &&
    Number(record.typeID) === TYPE_ORBITAL_SKYHOOK &&
    Number(record.planetID) > 0;
}

// The signature holds only the skyhook fields sovereignty reads.
function buildDeployedSkyhookSignature(orbitalsByID, replacementsByPlanet = {}) {
  const rows = [];
  for (const record of Object.values(orbitalsByID || {})) {
    if (!isDeployedSkyhookRecord(record)) {
      continue;
    }
    rows.push([
      record.itemID,
      record.planetID,
      record.solarSystemID,
      record.ownerID,
      record.corporationID,
      record.allianceID,
      record.state,
      record.destroyedAtMs || null,
      Boolean(replacementsByPlanet[String(record.planetID)] &&
        !replacementsByPlanet[String(record.planetID)].completed &&
        Number(replacementsByPlanet[String(record.planetID)].launchedItemID) === Number(record.itemID)),
    ]);
  }
  rows.sort((left, right) => Number(left[0]) - Number(right[0]));
  return JSON.stringify(rows);
}

function noteDeployedSkyhookRows(orbitalsByID, replacementsByPlanet = {}) {
  const signature = buildDeployedSkyhookSignature(orbitalsByID, replacementsByPlanet);
  if (signature !== deployedSkyhookSignature) {
    deployedSkyhookSignature = signature;
    deployedSkyhookRevision += 1;
  }
}

function getDeployedSkyhookRevision() {
  if (resourcePersistencePending) {
    if (!flushStateToDisk()) {
      const error = new Error("ORBITAL_RESOURCE_PERSISTENCE_FAILED");
      error.code = "ORBITAL_RESOURCE_PERSISTENCE_FAILED";
      throw error;
    }
    resourcePersistencePending = false;
    const state = readState();
    noteDeployedSkyhookRows(state.orbitalsByID, state.replacementsByPlanet);
    require("../sovereignty/sovModernState").settleAllHubFuel();
  }
  if (deployedSkyhookSignature === null || !replacementRecoveryDiscovered) {
    const state = readState();
    noteDeployedSkyhookRows(state.orbitalsByID, state.replacementsByPlanet);
  }
  return deployedSkyhookRevision;
}

function writeState(state, options = {}) {
  const { state: normalizedState } = normalizeState(state);
  if (deployedSkyhookSignature === null) readState();
  const resourceRowsChanged = options.skyhookRowsUnchanged !== true &&
    buildDeployedSkyhookSignature(normalizedState.orbitalsByID,
      normalizedState.replacementsByPlanet) !== deployedSkyhookSignature;
  const settle = () => {
    const sov = require("../sovereignty/sovModernState");
    if (typeof sov.settleAllHubFuel === "function") sov.settleAllHubFuel();
  };
  // Damage, tax and presentation writes must remain independent of Hub fuel
  // persistence. Only changes that can alter deployed resources settle fuel.
  if (resourceRowsChanged) settle();
  const result = database.write(TABLE_NAME, "/", normalizedState, { force: true });
  if (!result.success) {
    log.warn(
      `[PlanetOrbitalState] Failed to write ${TABLE_NAME}: ${result.errorMsg || "WRITE_ERROR"}`,
    );
    return false;
  }
  const durable = flushStateToDisk();
  const settledPendingResourceWrite = durable && resourcePersistencePending;
  if (!durable && resourceRowsChanged) resourcePersistencePending = true;
  if (durable) resourcePersistencePending = false;
  if (durable && (options.skyhookRowsUnchanged !== true || settledPendingResourceWrite)) {
    noteDeployedSkyhookRows(normalizedState.orbitalsByID, normalizedState.replacementsByPlanet);
  }
  if (durable && (resourceRowsChanged || settledPendingResourceWrite)) settle();
  return durable;
}

function getPlanetsBySystem() {
  if (planetCacheBySystem) {
    return planetCacheBySystem;
  }

  planetCacheBySystem = new Map();
  planetCacheByID = new Map();
  for (const row of readStaticRows(TABLE.CELESTIALS)) {
    if (!row || (row.kind !== "planet" && row.groupName !== "Planet")) {
      continue;
    }
    const solarSystemID = toInt(row.solarSystemID, 0);
    const planetID = toInt(row.itemID, 0);
    if (!solarSystemID || !planetID) {
      continue;
    }
    if (!planetCacheBySystem.has(solarSystemID)) {
      planetCacheBySystem.set(solarSystemID, []);
    }
    const planet = {
      planetID,
      solarSystemID,
      typeID: toInt(row.typeID, 0),
      radius: toReal(row.radius, 0),
      position: normalizeVector(row.position),
      celestialIndex: toInt(row.celestialIndex, 0),
      itemName: String(row.itemName || row.name || `Planet ${planetID}`),
    };
    planetCacheBySystem.get(solarSystemID).push(planet);
    planetCacheByID.set(planetID, planet);
  }

  for (const planets of planetCacheBySystem.values()) {
    planets.sort((left, right) => (
      (left.celestialIndex || left.planetID) - (right.celestialIndex || right.planetID)
    ));
  }

  return planetCacheBySystem;
}

function listPlanetsForSystem(solarSystemID) {
  return [...(getPlanetsBySystem().get(toInt(solarSystemID, 0)) || [])];
}

function buildDefaultCustomsOfficeItemID(planetID) {
  const numericPlanetID = toInt(planetID, 0);
  return numericPlanetID > 0
    ? DEFAULT_CUSTOMS_OFFICE_ITEM_ID_OFFSET + numericPlanetID
    : 0;
}

function buildDefaultCustomsOfficeName(planet = {}) {
  const planetName = String(
    planet.itemName ||
      planet.name ||
      (planet.planetID ? `Planet ${planet.planetID}` : "Planet"),
  ).trim();
  return `Customs Office (${planetName || "Planet"})`;
}

function buildDefaultCustomsOfficeDunRotation(planetID) {
  const seed = Math.abs(toInt(planetID, 0));
  return [
    (seed * 37) % 360,
    (((seed * 17) % 600) - 300) / 100,
    0,
  ];
}

function buildDefaultCustomsOfficeRecordForPlanet(planet = {}) {
  const planetID = toInt(planet.planetID, 0);
  const solarSystemID = toInt(planet.solarSystemID, 0);
  const itemID = buildDefaultCustomsOfficeItemID(planetID);
  if (!itemID || !planetID || !solarSystemID) {
    return null;
  }

  return normalizeOrbitalRecord({
    itemID,
    typeID: TYPE_INTERBUS_CUSTOMS_OFFICE,
    groupID: GROUP_PLANETARY_CUSTOMS_OFFICES,
    categoryID: CATEGORY_ORBITAL,
    itemName: buildDefaultCustomsOfficeName(planet),
    ownerID: DEFAULT_CUSTOMS_OFFICE_OWNER_ID,
    corporationID: DEFAULT_CUSTOMS_OFFICE_OWNER_ID,
    solarSystemID,
    planetID,
    level: 0,
    state: ORBITAL_STATE.ANCHORED,
    stateStartedAtMs: null,
    stateEndsAtMs: null,
    dunRotation: buildDefaultCustomsOfficeDunRotation(planetID),
  });
}

function listDefaultCustomsOfficesForSystem(solarSystemID) {
  const numericSystemID = toInt(solarSystemID, 0);
  if (!numericSystemID) {
    return [];
  }

  const occupiedPlanetIDs = new Set(
    listOrbitalsForSystem(numericSystemID)
      .map((record) => toInt(record && record.planetID, 0))
      .filter((planetID) => planetID > 0),
  );

  return listPlanetsForSystem(numericSystemID)
    .filter((planet) => !occupiedPlanetIDs.has(toInt(planet && planet.planetID, 0)))
    .map(buildDefaultCustomsOfficeRecordForPlanet)
    .filter(Boolean);
}

function findNearestPlanetID(solarSystemID, position = null) {
  const planets = listPlanetsForSystem(solarSystemID);
  if (planets.length === 0) {
    return 0;
  }
  if (!isPlainObject(position)) {
    return planets[0].planetID;
  }

  const normalizedPosition = normalizeVector(position);
  let nearestPlanet = planets[0];
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const planet of planets) {
    const candidateDistance = distanceSquared(normalizedPosition, planet.position);
    if (candidateDistance < nearestDistance) {
      nearestDistance = candidateDistance;
      nearestPlanet = planet;
    }
  }
  return nearestPlanet ? nearestPlanet.planetID : 0;
}

function getDefaultStateForItem(item = {}) {
  const typeID = toInt(item.typeID, 0);
  const groupID = toInt(item.groupID, 0);
  if (typeID === TYPE_CUSTOMS_OFFICE_GANTRY || groupID === GROUP_ORBITAL_CONSTRUCTION_PLATFORM) {
    return ORBITAL_STATE.UNANCHORED;
  }
  return ORBITAL_STATE.IDLE;
}

function normalizeOrbitalRecord(rawRecord = {}, defaults = {}) {
  let record = isPlainObject(rawRecord) ? rawRecord : {};
  // Only the deterministic server-seeded IDs are eligible for legacy repair.
  if (Number(record.itemID) === buildDefaultCustomsOfficeItemID(record.planetID) &&
      Number(record.ownerID) === 1 && Number(record.groupID) === GROUP_PLANETARY_CUSTOMS_OFFICES) {
    record = { ...record, ownerID: DEFAULT_CUSTOMS_OFFICE_OWNER_ID,
      corporationID: DEFAULT_CUSTOMS_OFFICE_OWNER_ID, typeID: TYPE_INTERBUS_CUSTOMS_OFFICE };
  }
  const itemID = toInt(record.itemID ?? defaults.itemID, 0);
  const typeID = toInt(record.typeID ?? defaults.typeID, 0);
  const metadata = getItemMetadata(typeID, record.itemName || defaults.itemName);
  const ownerID = toInt(record.ownerID ?? defaults.ownerID, 0);
  const corporationID = toInt(
    record.corporationID ?? defaults.corporationID,
    ownerID,
  );
  const state = toInt(
    record.state ?? defaults.state,
    getDefaultStateForItem({
      typeID,
      groupID: toInt(record.groupID ?? defaults.groupID, metadata.groupID),
    }),
  );

  return {
    itemID,
    // Only skyhooks carry the one-time activation marker.
    ...(typeID === TYPE_ORBITAL_SKYHOOK ? {
      skyhookActivationStarted:
        record.skyhookActivationStarted === true || defaults.skyhookActivationStarted === true,
    } : {}),
    typeID: toInt(metadata.typeID, typeID),
    groupID: toInt(record.groupID ?? defaults.groupID, metadata.groupID),
    categoryID: CATEGORY_ORBITAL,
    itemName: String(record.itemName || defaults.itemName || metadata.name || "Orbital"),
    ownerID,
    corporationID,
    allianceID: toInt(record.allianceID ?? defaults.allianceID, 0),
    warFactionID: toInt(record.warFactionID ?? defaults.warFactionID, 0),
    solarSystemID: toInt(record.solarSystemID ?? defaults.solarSystemID, 0),
    planetID: toInt(record.planetID ?? defaults.planetID, 0),
    level: Math.max(0, toInt(record.level ?? defaults.level, 1)),
    state,
    stateStartedAtMs: toInt(record.stateStartedAtMs ?? defaults.stateStartedAtMs, 0) || null,
    stateEndsAtMs: toInt(record.stateEndsAtMs ?? defaults.stateEndsAtMs, 0) || null,
    reinforceHour: Math.max(0, Math.min(23, toInt(record.reinforceHour ?? defaults.reinforceHour, 18))),
    taxRates: ownerID === DEFAULT_CUSTOMS_OFFICE_OWNER_ID
      ? Object.fromEntries(Object.keys(DEFAULT_TAX_RATES).map(key => [key, INTERBUS_TAX_RATE]))
      : normalizeTaxRates(record.taxRates || defaults.taxRates),
    standingLevel: Math.max(
      -10,
      Math.min(10, toInt(record.standingLevel ?? defaults.standingLevel, 0)),
    ),
    allowAlliance: Boolean(record.allowAlliance ?? defaults.allowAlliance ?? false),
    allowStandings: Boolean(record.allowStandings ?? defaults.allowStandings ?? false),
    aclGroupID: toInt(record.aclGroupID ?? defaults.aclGroupID, 0) || null,
    dunRotation: normalizeDunRotation(record.dunRotation || defaults.dunRotation),
    conditionState: normalizeOrbitalConditionState(
      record.conditionState ?? defaults.conditionState,
    ),
    destroyedAtMs: toInt(record.destroyedAtMs ?? defaults.destroyedAtMs, 0) || null,
  };
}

function buildDefaultsFromItem(item = {}, options = {}) {
  const solarSystemID = toInt(
    options.solarSystemID,
    toInt(item.locationID, toInt(item.spaceState && item.spaceState.systemID, 0)),
  );
  const position = item.spaceState && item.spaceState.position
    ? item.spaceState.position
    : options.position;
  const ownerID = toInt(options.ownerID, toInt(item.ownerID, 0));
  const corporationID = toInt(options.corporationID, ownerID);
  return {
    itemID: toInt(item.itemID, 0),
    typeID: toInt(item.typeID, 0),
    groupID: toInt(item.groupID, 0),
    categoryID: CATEGORY_ORBITAL,
    itemName: item.itemName,
    ownerID,
    corporationID,
    allianceID: toInt(options.allianceID, 0),
    warFactionID: toInt(options.warFactionID, 0),
    solarSystemID,
    planetID: toInt(
      options.planetID,
      findNearestPlanetID(solarSystemID, position),
    ),
    state: options.state,
    stateStartedAtMs: options.stateStartedAtMs,
    stateEndsAtMs: options.stateEndsAtMs,
    dunRotation: item.dunRotation || options.dunRotation || DEFAULT_DUN_ROTATION,
  };
}

function upsertOrbitalRecord(record, options = {}) {
  const normalizedRecord = normalizeOrbitalRecord(record);
  if (!normalizedRecord.itemID) {
    return {
      success: false,
      errorMsg: "ORBITAL_NOT_FOUND",
    };
  }

  const state = options.state || readState({ repair: true });
  const key = String(normalizedRecord.itemID);
  // Compare only this row before replacing it. Damage and settings do not
  // alter resource fields, so a hit on a POCO or skyhook skips the global scan
  // and remains independent of the Hub fuel persistence boundary.
  const skyhookRowsUnchanged = !options.state &&
    buildDeployedSkyhookSignature({ [key]: state.orbitalsByID[key] }, state.replacementsByPlanet) ===
    buildDeployedSkyhookSignature({ [key]: normalizedRecord }, state.replacementsByPlanet);
  state.orbitalsByID[key] = normalizedRecord;
  if (options.deferWrite !== true && !writeState(state, { skyhookRowsUnchanged })) {
    return {
      success: false,
      errorMsg: "WRITE_ERROR",
    };
  }
  return {
    success: true,
    data: normalizedRecord,
    state,
  };
}

function completeOnliningOrbital(record) {
  if (Number(record.typeID) === TYPE_ORBITAL_SKYHOOK) {
    return normalizeOrbitalRecord({ ...record, state: ORBITAL_STATE.IDLE,
      stateStartedAtMs: null, stateEndsAtMs: null });
  }
  const metadata = getItemMetadata(TYPE_CUSTOMS_OFFICE, "Customs Office");
  const updateResult = updateInventoryItem(record.itemID, (currentItem) => ({
    ...currentItem,
    typeID: TYPE_CUSTOMS_OFFICE,
    itemName: metadata.name || "Customs Office",
    singleton: 1,
  }));
  if (!updateResult.success) {
    log.warn(
      `[PlanetOrbitalState] Failed to convert gantry ${record.itemID} to POCO: ${updateResult.errorMsg || "UNKNOWN"}`,
    );
  }

  return normalizeOrbitalRecord({
    ...record,
    typeID: TYPE_CUSTOMS_OFFICE,
    groupID: GROUP_PLANETARY_CUSTOMS_OFFICES,
    itemName: metadata.name || "Customs Office",
    state: ORBITAL_STATE.IDLE,
    stateStartedAtMs: null,
    stateEndsAtMs: null,
  });
}

function beginSkyhookActivation(record, nowMs = Date.now()) {
  if (isSkyhookDeploymentPending(record)) return record;
  if (Number(record.typeID) === TYPE_ORBITAL_SKYHOOK && record.state !== ORBITAL_STATE.UNANCHORED) {
    return { ...record, skyhookActivationStarted: true };
  }
  if (Number(record.typeID) === TYPE_ORBITAL_SKYHOOK && !record.destroyedAtMs &&
      record.state === ORBITAL_STATE.UNANCHORED && !record.skyhookActivationStarted) {
    return { ...record, skyhookActivationStarted: true, state: ORBITAL_STATE.ONLINING,
      stateStartedAtMs: nowMs, stateEndsAtMs: nowMs + DEFAULT_ORBITAL_TIMER_MS };
  }
  return record;
}

function getSpaceRuntime() {
  // The runtime hydrates orbital state while it is loading its scene, so keep
  // this dependency lazy to avoid a module-initialization cycle.
  return require(path.join(__dirname, "../../space/runtime"));
}

function refreshOrbitalPresentation(record, options = {}) {
  const item = findItemById(record && record.itemID);
  const solarSystemID = toInt(
    record && record.solarSystemID,
    toInt(item && item.locationID, 0),
  );
  if (!item || !solarSystemID || toInt(item.locationID, 0) !== solarSystemID) {
    return null;
  }
  return getSpaceRuntime().refreshInventoryBackedEntityPresentation(
    solarSystemID,
    item.itemID,
    {
      broadcast: options.broadcast !== false,
      excludedSession: options.excludedSession || null,
    },
  );
}

function clearOrbitalTransitionTimer(itemID) {
  const numericItemID = toInt(itemID, 0);
  const entry = orbitalTransitionTimers.get(numericItemID);
  if (entry) {
    clearTimeout(entry.timer);
    orbitalTransitionTimers.delete(numericItemID);
  }
}

function clearOrbitalTransitionTimers() {
  for (const itemID of orbitalTransitionTimers.keys()) {
    clearOrbitalTransitionTimer(itemID);
  }
}

function scheduleOrbitalTransitionReconciliation(itemID, stateEndsAtMs) {
  const numericItemID = toInt(itemID, 0);
  const completesAtMs = toInt(stateEndsAtMs, 0);
  const existing = orbitalTransitionTimers.get(numericItemID);
  if (existing && existing.completesAtMs === completesAtMs) {
    return true;
  }
  clearOrbitalTransitionTimer(numericItemID);
  if (!numericItemID || !completesAtMs) {
    return false;
  }

  const delayMs = Math.min(
    MAX_TIMER_DELAY_MS,
    Math.max(0, completesAtMs - Date.now()),
  );
  const timer = setTimeout(() => {
    orbitalTransitionTimers.delete(numericItemID);
    const result = reconcilePlanetaryOrbitalTransition(numericItemID, {
      nowMs: Date.now(),
      schedule: true,
    });
    if (!result.success) {
      log.warn(
        `[PlanetOrbitalState] Reconciliation failed orbital=${numericItemID} ` +
        `error=${result.errorMsg}`,
      );
    }
  }, delayMs);
  if (timer && typeof timer.unref === "function") {
    timer.unref();
  }
  orbitalTransitionTimers.set(numericItemID, { timer, completesAtMs });
  return true;
}

function tickDueOrbitals(nowMs = Date.now()) {
  const state = readState({ repair: true });
  let changed = false;
  const normalizedNow = toInt(nowMs, Date.now());
  const completedRecords = [];

  for (const [key, rawRecord] of Object.entries(state.orbitalsByID)) {
    // Repair each newly observed stable row once; subsequent reads need only
    // scalar checks. Transitions and one-shot activation always run below.
    const rawState = toInt(rawRecord && rawRecord.state, -1);
    const rawEndsAtMs = toInt(rawRecord && rawRecord.stateEndsAtMs, 0);
    const rawTypeID = toInt(rawRecord && rawRecord.typeID, 0);
    const needsSkyhookActivationFlag =
      rawTypeID === TYPE_ORBITAL_SKYHOOK &&
      rawRecord.skyhookActivationStarted !== true &&
      !rawRecord.destroyedAtMs &&
      !isSkyhookDeploymentPending(rawRecord);
    const isRawTransitioning =
      rawEndsAtMs > 0 &&
      [ORBITAL_STATE.ANCHORING, ORBITAL_STATE.ONLINING, ORBITAL_STATE.UNANCHORING].includes(rawState);
    if (!needsSkyhookActivationFlag && !isRawTransitioning &&
        checkedStableOrbitalRecords.has(rawRecord)) {
      const stableItemID = toInt(rawRecord && rawRecord.itemID, 0);
      if (orbitalTransitionTimers.has(stableItemID)) {
        clearOrbitalTransitionTimer(stableItemID);
      }
      continue;
    }

    let record = beginSkyhookActivation(normalizeOrbitalRecord(rawRecord), normalizedNow);
    if (resolveOrbitalAbyssalRestriction(findItemById(record.itemID), record)) {
      // Persisted host rows are retained for operator recovery, but they must
      // never advance a timer or convert inventory while the host is serving
      // as private Abyssal capacity.
      continue;
    }
    const stateEndsAtMs = toInt(record.stateEndsAtMs, 0);
    const isTransitioning = [
      ORBITAL_STATE.ANCHORING,
      ORBITAL_STATE.ONLINING,
      ORBITAL_STATE.UNANCHORING,
    ].includes(record.state);
    if (!isTransitioning || !stateEndsAtMs) {
      clearOrbitalTransitionTimer(record.itemID);
      if (JSON.stringify(record) !== JSON.stringify(rawRecord)) {
        state.orbitalsByID[key] = record;
        changed = true;
        checkedStableOrbitalRecords.add(record);
      } else {
        checkedStableOrbitalRecords.add(rawRecord);
      }
      continue;
    }
    if (stateEndsAtMs > normalizedNow) {
      scheduleOrbitalTransitionReconciliation(record.itemID, stateEndsAtMs);
      if (JSON.stringify(record) !== JSON.stringify(rawRecord)) {
        state.orbitalsByID[key] = record;
        changed = true;
      }
      continue;
    }

    // The replacement owner completes the cargo/settings handoff before making
    // this hook active. Reads may tick timers while that saga is recovering.
    if (Number(record.typeID) === TYPE_ORBITAL_SKYHOOK &&
        record.state === ORBITAL_STATE.ONLINING && isSkyhookDeploymentPending(record)) {
      continue;
    }

    if (record.state === ORBITAL_STATE.ANCHORING) {
      record = normalizeOrbitalRecord({
        ...record,
        state: ORBITAL_STATE.ANCHORED,
        stateStartedAtMs: null,
        stateEndsAtMs: null,
      });
      changed = true;
    } else if (record.state === ORBITAL_STATE.ONLINING) {
      const occupied = Number(record.groupID) === GROUP_ORBITAL_CONSTRUCTION_PLATFORM &&
        Object.values(state.orbitalsByID).some(other =>
          Number(other.itemID) !== Number(record.itemID) && Number(other.planetID) === Number(record.planetID) &&
          !isOrbitalRecordDestroyed(other) &&
          [GROUP_PLANETARY_CUSTOMS_OFFICES, GROUP_ORBITAL_SKYHOOK].includes(Number(other.groupID)));
      record = occupied ? normalizeOrbitalRecord({ ...record, state: ORBITAL_STATE.ANCHORED,
        stateStartedAtMs: null, stateEndsAtMs: null }) : completeOnliningOrbital(record);
      changed = true;
    } else if (record.state === ORBITAL_STATE.UNANCHORING) {
      record = normalizeOrbitalRecord({
        ...record,
        state: ORBITAL_STATE.UNANCHORED,
        stateStartedAtMs: null,
        stateEndsAtMs: null,
      });
      changed = true;
    }

    state.orbitalsByID[key] = record;
    completedRecords.push(record);
    clearOrbitalTransitionTimer(record.itemID);
  }

  if (changed) {
    writeState(state);
    for (const record of completedRecords) {
      refreshOrbitalPresentation(record);
      if (Number(record.typeID) === TYPE_ORBITAL_SKYHOOK) {
        require("../sovereignty/skyhookRuntime").publishSkyhookState(record.solarSystemID);
      }
    }
  }

  return {
    success: true,
    data: state,
    changed,
    completedItemIDs: completedRecords.map((record) => record.itemID),
  };
}

function reconcilePlanetaryOrbitalTransition(itemID, options = {}) {
  const numericItemID = toInt(itemID, 0);
  const item = findItemById(numericItemID);
  if (!item || toInt(item.categoryID, 0) !== CATEGORY_ORBITAL) {
    clearOrbitalTransitionTimer(numericItemID);
    return { success: false, errorMsg: "ORBITAL_NOT_FOUND" };
  }
  const state = readState({ repair: true });
  const record = normalizeOrbitalRecord(state.orbitalsByID[String(numericItemID)]);
  const isTransitioning = [
    ORBITAL_STATE.ANCHORING,
    ORBITAL_STATE.ONLINING,
    ORBITAL_STATE.UNANCHORING,
  ].includes(record.state);
  const stateEndsAtMs = toInt(record.stateEndsAtMs, 0);
  if (!isTransitioning || !stateEndsAtMs) {
    clearOrbitalTransitionTimer(numericItemID);
    return { success: true, data: record, completed: false };
  }

  const nowMs = toInt(options.nowMs, Date.now());
  if (nowMs < stateEndsAtMs) {
    if (options.schedule !== false) {
      scheduleOrbitalTransitionReconciliation(numericItemID, stateEndsAtMs);
    }
    return { success: true, data: record, completed: false };
  }

  if (Number(record.typeID) === TYPE_ORBITAL_SKYHOOK && isSkyhookDeploymentPending(record)) {
    const result = require("./skyhookOfficeReplacement").reconcileForSystem(record.solarSystemID, { nowMs });
    const updated = normalizeOrbitalRecord(readState().orbitalsByID[String(numericItemID)]);
    return { ...result, data: updated, completed:
      [ORBITAL_STATE.IDLE, ORBITAL_STATE.OPERATING].includes(updated.state) &&
      !isSkyhookDeploymentPending(updated) };
  }

  const result = tickDueOrbitals(nowMs);
  const updated = normalizeOrbitalRecord(
    readState({ repair: true }).orbitalsByID[String(numericItemID)],
  );
  return {
    success: result.success,
    data: updated,
    completed: result.completedItemIDs.includes(numericItemID),
  };
}

function ensureOrbitalForItem(item, options = {}) {
  if (!item || toInt(item.itemID, 0) <= 0 || toInt(item.categoryID, 0) !== CATEGORY_ORBITAL) {
    return null;
  }

  if (resolveOrbitalAbyssalRestriction(item, {
    solarSystemID: toInt(
      options.solarSystemID,
      toInt(item.locationID, toInt(item.spaceState && item.spaceState.systemID, 0)),
    ),
  })) {
    return null;
  }

  tickDueOrbitals();
  const state = readState({ repair: true });
  const key = String(item.itemID);
  const existing = state.orbitalsByID[key];
  if (existing) {
    const normalized = beginSkyhookActivation(normalizeOrbitalRecord(existing, buildDefaultsFromItem(item, options)));
    if (JSON.stringify(existing) !== JSON.stringify(normalized)) {
      state.orbitalsByID[key] = normalized;
      writeState(state);
    }
    return normalized;
  }

  const record = beginSkyhookActivation(normalizeOrbitalRecord({}, buildDefaultsFromItem(item, {
    ...options,
    state: options.state ?? getDefaultStateForItem(item),
  })));
  state.orbitalsByID[key] = record;
  writeState(state);
  if (record.state === ORBITAL_STATE.ONLINING && Number(record.typeID) === TYPE_ORBITAL_SKYHOOK) {
    scheduleOrbitalTransitionReconciliation(record.itemID, record.stateEndsAtMs);
  }
  return record;
}

function getOrbitalByID(itemID, options = {}) {
  if (options.refresh !== false) {
    tickDueOrbitals();
  }
  const state = readState({ repair: true });
  const record = state.orbitalsByID[String(toInt(itemID, 0))];
  if (record) {
    const normalized = normalizeOrbitalRecord(record);
    if (resolveOrbitalAbyssalRestriction(findItemById(itemID), normalized)) {
      return null;
    }
    return normalized;
  }

  const item = findItemById(itemID);
  return ensureOrbitalForItem(item, options);
}

function listOrbitalsForSystem(solarSystemID) {
  const tickResult = tickDueOrbitals();
  const state = tickResult && tickResult.data ? tickResult.data : readState({ repair: true });
  const numericSystemID = toInt(solarSystemID, 0);
  const records = [];
  for (const rawRecord of Object.values(state.orbitalsByID)) {
    if (toInt(rawRecord && rawRecord.solarSystemID, 0) !== numericSystemID) {
      continue;
    }
    const record = normalizeOrbitalRecord(rawRecord);
    if (!resolveOrbitalAbyssalRestriction(findItemById(record.itemID), record)) {
      records.push(record);
    }
  }
  return records;
}

function listOrbitalsForPlanet(planetID) {
  const tickResult = tickDueOrbitals();
  const state = tickResult && tickResult.data ? tickResult.data : readState({ repair: true });
  const numericPlanetID = toInt(planetID, 0);
  const records = [];
  for (const rawRecord of Object.values(state.orbitalsByID)) {
    if (toInt(rawRecord && rawRecord.planetID, 0) !== numericPlanetID) {
      continue;
    }
    const record = normalizeOrbitalRecord(rawRecord);
    if (!resolveOrbitalAbyssalRestriction(findItemById(record.itemID), record)) {
      records.push(record);
    }
  }
  return records;
}

function beginOrbitalState(itemID, nextState, durationMs, session = null) {
  const numericItemID = toInt(itemID, 0);
  const item = findItemById(numericItemID);
  if (!item || toInt(item.categoryID, 0) !== CATEGORY_ORBITAL) {
    return {
      success: false,
      errorMsg: "ORBITAL_NOT_FOUND",
    };
  }

  const launchRestriction = resolveAbyssalDeployableLaunchRestriction(
    session,
    {
      systemID: toInt(
        session && session._space && session._space.systemID,
        toInt(item.spaceState && item.spaceState.systemID, toInt(item.locationID, 0)),
      ),
      shipID: toInt(
        session && session._space && session._space.shipID,
        toInt(session && (session.shipID || session.shipid), 0),
      ),
    },
  );
  if (launchRestriction || resolveOrbitalAbyssalRestriction(item)) {
    return {
      success: false,
      errorMsg: "ABYSSAL_DEPLOYMENT_FORBIDDEN",
    };
  }

  const nowMs = Date.now();
  const record = ensureOrbitalForItem(item, {
    corporationID: toInt(session && (session.corporationID || session.corpid), toInt(item.ownerID, 0)),
    allianceID: toInt(session && (session.allianceID || session.allianceid), 0),
    warFactionID: toInt(session && (session.warFactionID || session.warfactionid), 0),
    solarSystemID: toInt(
      session && session._space && session._space.systemID,
      toInt(item.locationID, 0),
    ),
  });
  if (!record) {
    return {
      success: false,
      errorMsg: "ORBITAL_NOT_FOUND",
    };
  }

  if (isSkyhookDeploymentPending(record)) {
    return { success: false, errorMsg: "SKYHOOK_DEPLOYMENT_IN_PROGRESS" };
  }

  const updatedRecord = normalizeOrbitalRecord({
    ...record,
    typeID: toInt(item.typeID, record.typeID),
    groupID: toInt(item.groupID, record.groupID),
    itemName: item.itemName || record.itemName,
    ownerID: toInt(item.ownerID, record.ownerID),
    corporationID: toInt(session && (session.corporationID || session.corpid), record.corporationID),
    allianceID: toInt(session && (session.allianceID || session.allianceid), record.allianceID),
    warFactionID: toInt(session && (session.warFactionID || session.warfactionid), record.warFactionID),
    state: nextState,
    stateStartedAtMs: nowMs,
    stateEndsAtMs: nowMs + Math.max(1_000, toInt(durationMs, DEFAULT_ORBITAL_TIMER_MS)),
  });

  if ([ORBITAL_STATE.ANCHORING, ORBITAL_STATE.ONLINING].includes(nextState) &&
      listOrbitalsForPlanet(record.planetID).some(other => Number(other.itemID) !== Number(record.itemID) &&
        !isOrbitalRecordDestroyed(other))) {
    return { success: false, errorMsg: "PLANET_ALREADY_HAS_ORBITAL" };
  }

  if (nextState === ORBITAL_STATE.ANCHORING) {
    const planet = require("../../space/worldData").getCelestialByID(record.planetID);
    const plan = require("./planetOrbitalPlacement").planOrbitalPositionMigration(
      item, { ...record, state: ORBITAL_STATE.ANCHORED }, planet,
    );
    if (plan) {
      const moved = updateInventoryItem(item.itemID, () => plan.item);
      if (!moved.success) return moved;
    }
    const flushed = database.flushTableSync("items");
    if (!flushed.success) return flushed;
  }

  const result = upsertOrbitalRecord(updatedRecord);
  if (result.success) {
    if (nextState === ORBITAL_STATE.ANCHORING) {
      const current = findItemById(numericItemID);
      const runtime = getSpaceRuntime();
      const scene = runtime.scenes.get(record.solarSystemID);
      if (scene && scene.dynamicEntities.has(numericItemID) && current?.spaceState?.position) {
        const moved = scene.teleportDynamicEntityToPoint(numericItemID, current.spaceState.position, {
          direction: current.spaceState.direction || { x: 1, y: 0, z: 0 },
        });
        if (!moved.success) return moved;
      }
    }
    scheduleOrbitalTransitionReconciliation(
      numericItemID,
      result.data.stateEndsAtMs,
    );
  }
  return result;
}

function anchorOrbital(itemID, session = null) {
  const record = getOrbitalByID(itemID);
  if (
    record &&
    ![ORBITAL_STATE.UNANCHORED, null, undefined].includes(record.state)
  ) {
    return {
      success: false,
      errorMsg: "ORBITAL_NOT_UNANCHORED",
      data: record,
    };
  }
  return beginOrbitalState(itemID, ORBITAL_STATE.ANCHORING, DEFAULT_ORBITAL_TIMER_MS, session);
}

function onlineOrbital(itemID, session = null) {
  const record = getOrbitalByID(itemID);
  if (
    record &&
    ![ORBITAL_STATE.ANCHORED, ORBITAL_STATE.UNANCHORED].includes(record.state)
  ) {
    return {
      success: false,
      errorMsg: "ORBITAL_NOT_ANCHORED",
      data: record,
    };
  }
  return beginOrbitalState(itemID, ORBITAL_STATE.ONLINING, DEFAULT_ORBITAL_TIMER_MS, session);
}

function unanchorOrbital(itemID, session = null) {
  const record = getOrbitalByID(itemID);
  if (
    record &&
    [ORBITAL_STATE.UNANCHORED, ORBITAL_STATE.UNANCHORING].includes(record.state)
  ) {
    return {
      success: false,
      errorMsg: "ORBITAL_ALREADY_UNANCHORED",
      data: record,
    };
  }
  return beginOrbitalState(itemID, ORBITAL_STATE.UNANCHORING, DEFAULT_ORBITAL_TIMER_MS, session);
}

function hydrateOrbitalEntityFromInventoryItem(entity, item, options = {}) {
  if (!entity || !item) {
    return entity;
  }

  if (resolveOrbitalAbyssalRestriction(item, {
    solarSystemID: toInt(
      options.solarSystemID,
      toInt(entity.systemID, toInt(item.locationID, 0)),
    ),
  })) {
    return entity;
  }

  const record = ensureOrbitalForItem(item, {
    solarSystemID: toInt(options.solarSystemID, toInt(entity.systemID, toInt(item.locationID, 0))),
  });
  if (!record) {
    return entity;
  }

  const latestItem = findItemById(item.itemID) || item;
  entity.typeID = toInt(latestItem.typeID, record.typeID);
  entity.groupID = toInt(latestItem.groupID, record.groupID);
  entity.categoryID = CATEGORY_ORBITAL;
  entity.itemName = String(latestItem.itemName || record.itemName || "Orbital");
  entity.ownerID = toInt(latestItem.ownerID, record.ownerID);
  entity.corporationID = toInt(record.corporationID, entity.ownerID);
  entity.allianceID = toInt(record.allianceID, 0);
  entity.warFactionID = toInt(record.warFactionID, 0);
  entity.locationID = toInt(record.solarSystemID, toInt(latestItem.locationID, entity.systemID));
  entity.planetID = toInt(record.planetID, 0);
  entity.level = Math.max(0, toInt(record.level, 1));
  entity.orbitalState = toInt(record.state, ORBITAL_STATE.UNANCHORED);
  if (entity.typeID === TYPE_ORBITAL_SKYHOOK) {
    entity.skyhook_state = [ORBITAL_STATE.IDLE, ORBITAL_STATE.OPERATING].includes(entity.orbitalState) && !record.destroyedAtMs ? 210 : 0;
    entity.component_activate = [entity.skyhook_state === 210, entity.skyhook_state === 210 ? null : record.stateEndsAtMs];
  }
  entity.orbitalTimestampMs = toInt(record.stateEndsAtMs, 0) || null;
  entity.orbitalHackerID = null;
  entity.orbitalHackerProgress = null;
  entity.dunRotation = normalizeDunRotation(latestItem.dunRotation || record.dunRotation);
  entity.conditionState = normalizeOrbitalConditionState(record.conditionState);
  return entity;
}

function findPlanetByID(planetID) {
  const numericPlanetID = toInt(planetID, 0);
  if (numericPlanetID <= 0) {
    return null;
  }
  getPlanetsBySystem();
  return planetCacheByID.get(numericPlanetID) || null;
}

// Cheap eligibility check for inventory paths that also handle ordinary cargo.
// Read the authoritative rows rather than caching membership: registry-only
// skyhooks and direct database restores must be visible immediately. A positive
// result still requires the normal resolver's timer, replacement and access
// checks; this function neither materializes nor publishes an orbital.
function mayResolveOrbitalID(orbitalID) {
  const numericID = toInt(orbitalID, 0);
  if (numericID <= 0) {
    return false;
  }
  const registered = database.read(TABLE_NAME, `/orbitalsByID/${numericID}`);
  if (registered.success && registered.data) {
    return true;
  }
  const item = database.read("items", `/${numericID}`);
  if (item.success && item.data && (
    toInt(item.data.categoryID, 0) === CATEGORY_ORBITAL ||
    toInt(getItemMetadata(item.data.typeID ?? item.data.shipTypeID).categoryID, 0) === CATEGORY_ORBITAL
  )) {
    return true;
  }
  return numericID > DEFAULT_CUSTOMS_OFFICE_ITEM_ID_OFFSET &&
    findPlanetByID(numericID - DEFAULT_CUSTOMS_OFFICE_ITEM_ID_OFFSET) !== null;
}

// The owner of an orbital, read the way mayResolveOrbitalID reads it: no timer ticked, no default office
// materialized. Wallet reads use it to name the corporation a customs tax was paid to. A registered record's owner
// (a seeded office's legacy owner 1 is InterBus, as normalizeOrbitalRecord repairs it), an orbital item's owner,
// InterBus for a synthesized default office; 0 for anything else.
function peekOrbitalOwnerID(orbitalID) {
  const numericID = toInt(orbitalID, 0);
  if (numericID <= 0) {
    return 0;
  }
  const registered = database.read(TABLE_NAME, `/orbitalsByID/${numericID}`);
  if (registered.success && registered.data) {
    return toInt(normalizeOrbitalRecord(registered.data).ownerID, 0);
  }
  const item = database.read("items", `/${numericID}`);
  if (item.success && item.data && (
    toInt(item.data.categoryID, 0) === CATEGORY_ORBITAL ||
    toInt(getItemMetadata(item.data.typeID ?? item.data.shipTypeID).categoryID, 0) === CATEGORY_ORBITAL
  )) {
    return toInt(item.data.ownerID, 0);
  }
  return numericID > DEFAULT_CUSTOMS_OFFICE_ITEM_ID_OFFSET &&
    findPlanetByID(numericID - DEFAULT_CUSTOMS_OFFICE_ITEM_ID_OFFSET) !== null
    ? DEFAULT_CUSTOMS_OFFICE_OWNER_ID
    : 0;
}

// Read-only counterpart to ensureRuntimeOrbitalRecord.  A caller that only needs
// to *identify* an orbital — binding a Customs Office inventory, say — must be
// able to see a synthesized default office without persisting it: there is one
// per planet in the cluster, so materializing them on sight would write tens of
// thousands of rows and defeat the lazy design below.  The returned record is
// therefore not written to the registry.
function resolveOrbitalOrDefaultByID(orbitalID, options = {}) {
  const numericID = toInt(orbitalID, 0);
  if (numericID <= 0) {
    return null;
  }

  const existing = getOrbitalByID(numericID, options);
  if (existing) {
    return existing;
  }

  const planetID = numericID - DEFAULT_CUSTOMS_OFFICE_ITEM_ID_OFFSET;
  const planet = findPlanetByID(planetID);
  if (!planet) {
    return null;
  }
  // Mirror listDefaultCustomsOfficesForSystem: a planet that already carries an
  // orbital gets no synthesized default, so its default id addresses nothing
  // and must not resolve.
  if (listOrbitalsForPlanet(planetID).length > 0) {
    return null;
  }
  return buildDefaultCustomsOfficeRecordForPlanet(planet);
}

// Default Customs Offices are synthesized per planet and only exist as records
// once something actually happens to them.  Damage is the first such event, so
// materialize the row before writing to it — otherwise the damage would be
// dropped and the office would rebuild itself intact on the next scene load.
function ensureRuntimeOrbitalRecord(orbitalID) {
  const numericID = toInt(orbitalID, 0);
  if (numericID <= 0) {
    return null;
  }

  const existing = getOrbitalByID(numericID, { refresh: false });
  if (existing) {
    return existing;
  }

  const planet = findPlanetByID(numericID - DEFAULT_CUSTOMS_OFFICE_ITEM_ID_OFFSET);
  if (!planet) {
    return null;
  }
  const record = buildDefaultCustomsOfficeRecordForPlanet(planet);
  if (!record) {
    return null;
  }
  const upsertResult = upsertOrbitalRecord(record);
  return upsertResult.success ? upsertResult.data : null;
}

// A Customs Office takes damage straight through shield -> armor -> structure and
// is destroyed when structure is gone.  There is no reinforcement phase: the
// client has no way to surface an orbital reinforcement timer in this build
// (component_reinforce is not rendered for orbitals and there is no reinforced
// orbital-state value), so an invulnerable phase with no visible reason is worse
// than just letting the office be destroyed.
function applyOrbitalDamageTransition(record, damageResult) {
  if (!record || !damageResult || !damageResult.success || !damageResult.data) {
    return { orbital: record, destroy: false, changed: false };
  }

  const next = normalizeOrbitalRecord({
    ...record,
    conditionState: damageResult.data.afterConditionState,
  });
  return {
    orbital: next,
    destroy: damageResult.data.destroyed === true,
    changed: true,
  };
}

function applyRuntimeOrbitalDamage(orbitalID, damageResult, nowMs = Date.now(), options = {}) {
  const record = ensureRuntimeOrbitalRecord(orbitalID);
  if (!record) {
    return {
      success: false,
      errorMsg: "ORBITAL_NOT_FOUND",
    };
  }

  const transition = applyOrbitalDamageTransition(record, damageResult);
  const upsertResult = upsertOrbitalRecord(transition.orbital, options);
  if (!upsertResult.success) {
    return upsertResult;
  }

  return {
    success: true,
    data: {
      orbital: upsertResult.data,
      destroy: transition.destroy === true,
      changed: transition.changed === true,
    },
  };
}

function markOrbitalDestroyed(orbitalID, nowMs = Date.now()) {
  const record = ensureRuntimeOrbitalRecord(orbitalID);
  if (!record) {
    return {
      success: false,
      errorMsg: "ORBITAL_NOT_FOUND",
    };
  }

  // Keep a tombstone instead of dropping the row.  listDefaultCustomsOfficesForSystem
  // treats a planet with no record as needing a fresh default Customs Office, so
  // deleting a destroyed one would respawn it intact on the next scene build.
  const destroyedRecord = normalizeOrbitalRecord({
    ...record,
    state: ORBITAL_STATE.UNANCHORED,
    stateStartedAtMs: null,
    stateEndsAtMs: null,
    destroyedAtMs: toInt(nowMs, Date.now()),
    conditionState: { shieldCharge: 0, armorDamage: 1, damage: 1 },
  });
  const upsertResult = upsertOrbitalRecord(destroyedRecord);
  if (upsertResult.success) {
    log.info(`[PlanetOrbitalState] Orbital=${record.itemID} destroyed`);
  }
  return upsertResult;
}

function buildOrbitalSettingsInfo(orbitalID) {
  const record = getOrbitalByID(orbitalID) || normalizeOrbitalRecord({
    itemID: orbitalID,
    typeID: TYPE_CUSTOMS_OFFICE,
    groupID: GROUP_PLANETARY_CUSTOMS_OFFICES,
    state: ORBITAL_STATE.IDLE,
  });
  return {
    reinforceHour: record.reinforceHour,
    taxRates: normalizeTaxRates(record.taxRates),
    standingLevel: record.standingLevel,
    allowAlliance: record.allowAlliance,
    allowStandings: record.allowStandings,
    aclGroupID: record.aclGroupID,
  };
}

function updateOrbitalSettings(orbitalID, settings = {}) {
  const record = getOrbitalByID(orbitalID, { refresh: true });
  if (!record) {
    return {
      success: false,
      errorMsg: "ORBITAL_NOT_FOUND",
    };
  }

  if (isOfficeReplacementPending(record.itemID, record.planetID)) {
    return { success: false, errorMsg: "CUSTOMS_OFFICE_REPLACEMENT_PENDING" };
  }

  const updatedRecord = normalizeOrbitalRecord({
    ...record,
    reinforceHour: settings.reinforceHour,
    taxRates: settings.taxRates || record.taxRates,
    standingLevel: settings.standingLevel,
    allowAlliance: settings.allowAlliance,
    allowStandings: settings.allowStandings,
    aclGroupID: settings.aclGroupID,
  });
  return upsertOrbitalRecord(updatedRecord);
}

function getStandingTaxRateKey(standing) {
  const value = Math.max(-10, Math.min(10, toReal(standing, 0)));
  if (value > 5) {
    return "standingHigh";
  }
  if (value > 0) {
    return "standingGood";
  }
  if (value === 0) {
    return "standingNeutral";
  }
  if (value >= -5) {
    return "standingBad";
  }
  return "standingHorrible";
}

function resolveCorporationContactStanding(ownerCorporationID, visitor = {}) {
  const runtime = getCorporationRuntime(ownerCorporationID) || {};
  const contacts = isPlainObject(runtime.contacts) ? runtime.contacts : {};
  // Retail distinguishes corporation-to-character, corporation-to-corporation,
  // and corporation-to-alliance contacts.  Prefer the most specific live
  // identity rather than selecting the numerically most favourable contact.
  for (const ownerID of [
    visitor.characterID,
    visitor.corporationID,
    visitor.allianceID,
  ]) {
    const normalizedOwnerID = toInt(ownerID, 0);
    if (
      normalizedOwnerID > 0 &&
      Object.prototype.hasOwnProperty.call(contacts, String(normalizedOwnerID))
    ) {
      return Math.max(
        -10,
        Math.min(10, toReal(contacts[String(normalizedOwnerID)].relationshipID, 0)),
      );
    }
  }
  return 0;
}

function resolveCustomsOfficeTaxAccess(record, session = null) {
  const rates = normalizeTaxRates(record && record.taxRates);
  const ownerCorporationID = toInt(record && record.ownerID, 0);

  // Synthesized InterBus offices are the public baseline and preserve the
  // long-standing default-rate contract even for service probes without a
  // character session.
  if (ownerCorporationID === DEFAULT_CUSTOMS_OFFICE_OWNER_ID) {
    return { allowed: true, rateKey: "corporation", rate: INTERBUS_TAX_RATE };
  }

  const characterID = resolveSessionCharacterID(session);
  const character = characterID > 0 ? peekCharacterRecord(characterID) : null;
  const visitorCorporationID = toInt(character && character.corporationID, 0);
  if (!character || !visitorCorporationID || !ownerCorporationID) {
    return { allowed: false, rateKey: null, rate: null };
  }

  if (visitorCorporationID === ownerCorporationID) {
    return { allowed: true, rateKey: "corporation", rate: rates.corporation };
  }

  const ownerCorporation = getCorporationRecord(ownerCorporationID);
  const visitorCorporation = getCorporationRecord(visitorCorporationID);
  const ownerAllianceID = toInt(ownerCorporation && ownerCorporation.allianceID, 0);
  const visitorAllianceID = toInt(visitorCorporation && visitorCorporation.allianceID, 0);
  if (
    record && record.allowAlliance === true &&
    ownerAllianceID > 0 &&
    visitorAllianceID === ownerAllianceID
  ) {
    return { allowed: true, rateKey: "alliance", rate: rates.alliance };
  }

  if (!record || record.allowStandings !== true) {
    return { allowed: false, rateKey: null, rate: null };
  }

  const standing = resolveCorporationContactStanding(ownerCorporationID, {
    characterID,
    corporationID: visitorCorporationID,
    allianceID: visitorAllianceID,
  });
  if (standing < toInt(record.standingLevel, 0)) {
    return { allowed: false, rateKey: null, rate: null, standing };
  }
  const rateKey = getStandingTaxRateKey(standing);
  return { allowed: true, rateKey, rate: rates[rateKey], standing };
}

function getTaxRate(orbitalID, session = null) {
  const record = resolveOrbitalOrDefaultByID(orbitalID, { refresh: true });
  if (!record) {
    return DEFAULT_TAX_RATES.corporation;
  }
  const access = resolveCustomsOfficeTaxAccess(record, session);
  if (!access.allowed || Number(record.ownerID) === DEFAULT_CUSTOMS_OFFICE_OWNER_ID) return access.rate;
  const system = require("../../space/worldData").getSolarSystemByID(record.solarSystemID);
  if (!system || Number(system.security ?? system.securityStatus ?? system.trueSecurity) < 0.45) return access.rate;
  const characterID = resolveSessionCharacterID(session);
  const skills = require("../skills/skillState").getCachedCharacterSkillMap(characterID);
  const skill = skills instanceof Map ? skills.get(33467) : skills && skills[33467];
  const level = Math.max(0, Math.min(5, toInt(skill && (skill.effectiveSkillLevel ?? skill.skillLevel ?? skill.level), 0)));
  return Math.round((access.rate + 0.10 * (1 - 0.10 * level)) * 1e10) / 1e10;
}

function resetForTests(snapshot = null) {
  resourcePersistencePending = false;
  checkedStableOrbitalRecords = new WeakSet();
  clearOrbitalTransitionTimers();
  if (replacementRecoveryDiscoveryTimer) clearTimeout(replacementRecoveryDiscoveryTimer);
  replacementRecoveryDiscoveryTimer = null;
  require.cache[require.resolve("./skyhookOfficeReplacement")]?.exports?._testing?.clearRetries();
  const payload = snapshot || {
    schemaVersion: SCHEMA_VERSION,
    orbitalsByID: {},
  };
  // Reset must not discover the table being replaced via writeState's resource
  // settlement reads. The next owner read discovers only the restored snapshot.
  replacementRecoveryDiscovered = true;
  try {
    return writeState(cloneJson(payload));
  } finally {
    replacementRecoveryDiscovered = false;
  }
}

module.exports = {
  TABLE_NAME,
  SCHEMA_VERSION,
  CATEGORY_ORBITAL,
  GROUP_PLANETARY_CUSTOMS_OFFICES,
  GROUP_ORBITAL_SKYHOOK,
  GROUP_ORBITAL_CONSTRUCTION_PLATFORM,
  TYPE_CUSTOMS_OFFICE,
  TYPE_CUSTOMS_OFFICE_GANTRY,
  TYPE_INTERBUS_CUSTOMS_OFFICE,
  DEFAULT_CUSTOMS_OFFICE_ITEM_ID_OFFSET,
  DEFAULT_CUSTOMS_OFFICE_OWNER_ID,
  ORBITAL_STATE,
  DEFAULT_ORBITAL_TIMER_MS,
  DEFAULT_TAX_RATES,
  INTERBUS_TAX_RATE,
  readState,
  writeState,
  getDeployedSkyhookRevision,
  tickDueOrbitals,
  reconcilePlanetaryOrbitalTransition,
  ensureOrbitalForItem,
  getOrbitalByID,
  mayResolveOrbitalID,
  peekOrbitalOwnerID,
  resolveOrbitalOrDefaultByID,
  listOrbitalsForSystem,
  listOrbitalsForPlanet,
  listDefaultCustomsOfficesForSystem,
  findNearestPlanetID,
  buildDefaultCustomsOfficeItemID,
  anchorOrbital,
  onlineOrbital,
  unanchorOrbital,
  hydrateOrbitalEntityFromInventoryItem,
  buildOrbitalSettingsInfo,
  updateOrbitalSettings,
  getTaxRate,
  applyRuntimeOrbitalDamage,
  markOrbitalDestroyed,
  ensureRuntimeOrbitalRecord,
  isOrbitalRecordDestroyed,
  isCustomsInventoryOrbitalRecord,
  isOfficeReplacementPending,
  isSkyhookDeploymentPending,
  isSkyhookDeploymentUnpublished,
  normalizeOrbitalConditionState,
  resetForTests,
  _testing: {
    normalizeOrbitalRecord,
    normalizeTaxRates,
    findNearestPlanetID,
    findPlanetByID,
    listPlanetsForSystem,
    buildDefaultCustomsOfficeRecordForPlanet,
    applyOrbitalDamageTransition,
    getStandingTaxRateKey,
    resolveCorporationContactStanding,
    resolveCustomsOfficeTaxAccess,
    clearOrbitalTransitionTimers,
  },
};
