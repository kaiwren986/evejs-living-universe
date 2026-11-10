"use strict";
const { getSessionCorporationRoleMask } = require("../corporation/corporationRoleChecks");

const path = require("path");
const database = require("../../gameStore");
const log = require("../../utils/logger");
const { settleSkyhookHarvest } = require("./skyhookHarvest");
const hubFuel = require("./sovHubFuelBurn");
const { getWallclockNowMs } = require("../../space/runtime/runtimeClock");
const { ORBITAL_STATE, getDeployedSkyhookRevision } = require("../planet/planetOrbitalState");
const PRODUCTIVE_ORBITAL_STATES = new Set([ORBITAL_STATE.IDLE, ORBITAL_STATE.OPERATING]);

const sessionRegistry = require(path.join(
  __dirname,
  "../chat/sessionRegistry",
));
const {
  getSovereigntyStaticSnapshot,
} = require(path.join(__dirname, "./sovStaticData"));
const {
  cloneValue,
  maySovereigntyPersist,
  mergeSovereigntyTableDefaults,
  normalizeSemanticVersion,
  readSovereigntyTable,
  readSovereigntyTableUpdatedAt,
  writeSovereigntyTable,
} = require(path.join(__dirname, "./sovStore"));
const {
  listStructures,
} = require(path.join(__dirname, "../structure/structureState"));
const {
  getGroupForCharacter,
} = require(path.join(__dirname, "../bookmark/bookmarkRuntimeState"));

const POWER_STATE = Object.freeze({
  POWER_STATE_UNSPECIFIED: 0,
  POWER_STATE_OFFLINE: 1,
  POWER_STATE_ONLINE: 2,
  POWER_STATE_LOW: 3,
  POWER_STATE_PENDING: 4,
});

const HOUR_MS = 60 * 60 * 1000;

let cache = null;
let settlingFuel = false;
let fuelPersistencePending = false;
let fuelPlansPendingPublication = [];
let fuelSchedulePublisher = null;
let hubStateNoticePublisher = null;

function getCharacterRecord(characterID) {
  const characterState = require(path.join(
    __dirname,
    "../character/characterState",
  ));
  return characterState && typeof characterState.peekCharacterRecord === "function"
    ? characterState.peekCharacterRecord(characterID)
    : null;
}

function normalizeInteger(value, fallback = 0) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return fallback;
  }
  return Math.trunc(numericValue);
}

function normalizePositiveInteger(value, fallback = null) {
  const numericValue = normalizeInteger(value, 0);
  return numericValue > 0 ? numericValue : fallback;
}

function normalizePositiveArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(
    value
      .map((entry) => normalizePositiveInteger(entry, null))
    .filter(Boolean),
  )].sort((left, right) => left - right);
}

function resolveSessionInteger(session, names = []) {
  if (!session) {
    return null;
  }
  for (const name of names) {
    if (
      Object.prototype.hasOwnProperty.call(session, name) &&
      session[name] !== undefined &&
      session[name] !== null &&
      session[name] !== ""
    ) {
      return Math.max(0, normalizeInteger(session[name], 0));
    }
  }
  return null;
}

function normalizeBoolean(value, fallback = false) {
  if (value === undefined || value === null) {
    return fallback;
  }
  return Boolean(value);
}

function normalizeTimestampMs(value, fallback = 0) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return fallback;
  }
  return Math.max(0, Math.trunc(numericValue));
}

function getStrategicIndexLevelForSystem(system = null) {
  return require(path.join(__dirname, "./sovState")).getStrategicIndexLevel(
    system &&
      system.devIndices &&
      system.devIndices.claimedForDays,
  );
}

function normalizeWorkforceConfiguration(value = {}, fallbackHubID = null) {
  const mode = String(value.mode || "").trim().toLowerCase();
  if (mode === "import") {
    return {
      hubID: normalizePositiveInteger(value.hubID, fallbackHubID),
      mode: "import",
      sourceSystemIDs: normalizePositiveArray(value.sourceSystemIDs),
      destinationSystemID: null,
      amount: 0,
    };
  }
  if (mode === "export") {
    return {
      hubID: normalizePositiveInteger(value.hubID, fallbackHubID),
      mode: "export",
      sourceSystemIDs: [],
      destinationSystemID: normalizePositiveInteger(value.destinationSystemID, null),
      amount: Math.max(0, normalizeInteger(value.amount, 0)),
    };
  }
  if (mode === "transit") {
    return {
      hubID: normalizePositiveInteger(value.hubID, fallbackHubID),
      mode: "transit",
      sourceSystemIDs: [],
      destinationSystemID: null,
      amount: 0,
    };
  }
  return {
    hubID: normalizePositiveInteger(value.hubID, fallbackHubID),
    mode: "inactive",
    sourceSystemIDs: [],
    destinationSystemID: null,
    amount: 0,
  };
}

function normalizeUpgradeInstallation(value = {}) {
  return {
    typeID: normalizePositiveInteger(value.typeID, null),
    online: normalizeBoolean(value.online, false),
  };
}

function normalizeFuelLedger(value = {}) {
  const normalized = {};
  if (!value || typeof value !== "object") {
    return normalized;
  }
  for (const [fuelTypeID, fuelEntry] of Object.entries(value)) {
    const numericFuelTypeID = normalizePositiveInteger(fuelTypeID, null);
    if (!numericFuelTypeID) {
      continue;
    }
    normalized[String(numericFuelTypeID)] = {
      amount: Math.max(
        0,
        normalizeInteger(fuelEntry && fuelEntry.amount, 0),
      ),
    };
  }
  return normalized;
}

function normalizeHubRecord(value = {}, fallback = {}) {
  const installedUpgrades = Array.isArray(value.installedUpgrades)
    ? value.installedUpgrades
        .map((entry) => normalizeUpgradeInstallation(entry))
        .filter((entry) => entry.typeID)
    : [];
  const uniqueUpgrades = [];
  const seenTypeIDs = new Set();
  for (const installation of installedUpgrades) {
    if (seenTypeIDs.has(installation.typeID)) {
      continue;
    }
    seenTypeIDs.add(installation.typeID);
    uniqueUpgrades.push(installation);
  }
  return {
    hubID: normalizePositiveInteger(value.hubID, fallback.hubID),
    solarSystemID: normalizePositiveInteger(
      value.solarSystemID,
      fallback.solarSystemID,
    ),
    corporationID: normalizePositiveInteger(
      value.corporationID,
      fallback.corporationID,
    ),
    allianceID: normalizePositiveInteger(value.allianceID, fallback.allianceID),
    installedUpgrades: uniqueUpgrades,
    installedUpgradeSources: cloneValue(Object.fromEntries(
      Object.entries(value.installedUpgradeSources || {})
        .filter(([typeID]) => seenTypeIDs.has(Number(typeID))),
    )),
    pendingUpgradeInstall: cloneValue(value.pendingUpgradeInstall || null),
    fuelByTypeID: normalizeFuelLedger(value.fuelByTypeID),
    hubFuelState: hubFuel.normalizeFuelState(value.hubFuelState),
    pendingFuelDeposits: cloneValue(value.pendingFuelDeposits || {}),
    fuelLastUpdatedMs: normalizeTimestampMs(
      value.fuelLastUpdatedMs,
      fallback.fuelLastUpdatedMs || 0,
    ),
    workforceConfiguration: normalizeWorkforceConfiguration(
      value.workforceConfiguration,
      fallback.hubID,
    ),
    workforceLastUpdatedMs: normalizeTimestampMs(
      value.workforceLastUpdatedMs,
      fallback.workforceLastUpdatedMs || 0,
    ),
    upgradesLastUpdatedMs: normalizeTimestampMs(
      value.upgradesLastUpdatedMs,
      fallback.upgradesLastUpdatedMs || 0,
    ),
  };
}

function normalizeSkyhookRecord(value = {}, fallback = {}) {
  const rawDefinitions = Array.isArray(value.reagentDefinitions)
    ? value.reagentDefinitions
    : fallback.reagentDefinitions || [];
  const rawSimulations = Array.isArray(value.reagentSimulations)
    ? value.reagentSimulations
    : fallback.reagentSimulations || [];
  return {
    skyhookID: normalizePositiveInteger(value.skyhookID, fallback.skyhookID),
    solarSystemID: normalizePositiveInteger(
      value.solarSystemID,
      fallback.solarSystemID,
    ),
    planetID: normalizePositiveInteger(value.planetID, fallback.planetID),
    corporationID: normalizePositiveInteger(
      value.corporationID,
      fallback.corporationID,
    ),
    allianceID: normalizePositiveInteger(
      value.allianceID,
      fallback.allianceID,
    ),
    destroyed: value.destroyed === true,
    deployedItem: value.deployedItem === true,
    orbitalState: value.orbitalState ?? null,
    pendingExtraction: cloneValue(value.pendingExtraction || null),
    raid: cloneValue(value.raid || null),
    active: normalizeBoolean(value.active, fallback.active !== false),
    workforceAmount: normalizePositiveInteger(
      value.workforceAmount,
      fallback.workforceAmount || null,
    ),
    reagentDefinitions: rawDefinitions
      .map((entry) => ({
        reagentTypeID: normalizePositiveInteger(entry.reagentTypeID, null),
        amountPerCycle: Math.max(
          0,
          normalizeInteger(entry.amountPerCycle, 0),
        ),
        cyclePeriodSeconds: Math.max(
          0,
          normalizeInteger(entry.cyclePeriodSeconds, 0),
        ),
        securedPercentage: Math.max(
          0,
          normalizeInteger(entry.securedPercentage, 0),
        ),
        securedCapacity: Math.max(
          0,
          normalizeInteger(entry.securedCapacity, 0),
        ),
        unsecuredCapacity: Math.max(
          0,
          normalizeInteger(entry.unsecuredCapacity, 0),
        ),
      }))
      .filter((entry) => entry.reagentTypeID),
    reagentSimulations: rawSimulations
      .map((entry) => ({
        reagentTypeID: normalizePositiveInteger(entry.reagentTypeID, null),
        securedStock: Math.max(0, normalizeInteger(entry.securedStock, 0)),
        unsecuredStock: Math.max(0, normalizeInteger(entry.unsecuredStock, 0)),
        lastCycleMs: normalizeTimestampMs(entry.lastCycleMs, Date.now()),
      }))
      .filter((entry) => entry.reagentTypeID),
    theftVulnerability: {
      startMs: normalizeTimestampMs(
        value &&
          value.theftVulnerability &&
          value.theftVulnerability.startMs,
        fallback &&
          fallback.theftVulnerability &&
          fallback.theftVulnerability.startMs,
      ),
      endMs: normalizeTimestampMs(
        value &&
          value.theftVulnerability &&
          value.theftVulnerability.endMs,
        fallback &&
          fallback.theftVulnerability &&
          fallback.theftVulnerability.endMs,
      ),
    },
    lastUpdatedMs: normalizeTimestampMs(
      value.lastUpdatedMs,
      fallback.lastUpdatedMs || Date.now(),
    ),
  };
}

function buildDefaultWorkforceConfigurationForHub(hubID) {
  if ((hubID || 0) % 2 === 0) {
    return {
      mode: "transit",
      sourceSystemIDs: [],
      destinationSystemID: null,
      amount: 0,
    };
  }
  return {
    mode: "inactive",
    sourceSystemIDs: [],
    destinationSystemID: null,
    amount: 0,
  };
}

function buildDefaultSkyhookWindow(skyhookID) {
  const now = Date.now();
  const remainder = normalizeInteger(skyhookID, 0) % 4;
  const startMs =
    now +
    [-HOUR_MS, HOUR_MS, 2 * HOUR_MS, -2 * HOUR_MS][remainder];
  return {
    startMs,
    endMs: startMs + HOUR_MS,
  };
}

function buildResourcesTableFromStatic(staticSnapshot) {
  return {
    planetDefinitions: cloneValue(staticSnapshot.planetDefinitions),
    planetDefinitionsVersion: normalizeSemanticVersion(
      staticSnapshot.planetDefinitionsVersion,
    ),
    starConfigurations: cloneValue(staticSnapshot.starConfigurations),
    upgradeDefinitions: cloneValue(staticSnapshot.upgradeDefinitions),
  };
}

function arrayShallowEquals(left = [], right = []) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    if (String(left[index]) !== String(right[index])) {
      return false;
    }
  }
  return true;
}

function semanticVersionEquals(left, right) {
  const normalizedLeft = normalizeSemanticVersion(left);
  const normalizedRight = normalizeSemanticVersion(right);
  return (
    normalizedLeft.major === normalizedRight.major &&
    normalizedLeft.minor === normalizedRight.minor &&
    normalizedLeft.patch === normalizedRight.patch &&
    arrayShallowEquals(normalizedLeft.prerelease_tags, normalizedRight.prerelease_tags) &&
    arrayShallowEquals(normalizedLeft.build_tags, normalizedRight.build_tags)
  );
}

function resourceRowsMatch(currentRows, targetRows, idName) {
  if (!Array.isArray(currentRows) || !Array.isArray(targetRows)) {
    return false;
  }
  if (currentRows.length !== targetRows.length) {
    return false;
  }
  if (currentRows.length === 0) {
    return true;
  }
  const targetByID = new Map(
    targetRows.map((row) => [normalizePositiveInteger(row && row[idName], null), row]),
  );
  for (const row of currentRows) {
    const id = normalizePositiveInteger(row && row[idName], null);
    const target = targetByID.get(id);
    if (!id || !target) {
      return false;
    }
    if (JSON.stringify(row) !== JSON.stringify(target)) {
      return false;
    }
  }
  return true;
}

function getSkyhookHarvestContribution(skyhook, staticSnapshot) {
  if (!skyhook || !skyhook.active) {
    return {
      power: 0,
      workforce: 0,
    };
  }

  const planetDefinition = staticSnapshot.planetDefinitionsByPlanetID.get(
    normalizePositiveInteger(skyhook.planetID, 0),
  );
  return {
    power: Number(planetDefinition && planetDefinition.power) || 0,
    workforce:
      normalizePositiveInteger(
        skyhook.workforceAmount,
        Number(planetDefinition && planetDefinition.workforce) || 0,
      ) || 0,
  };
}

function ensureStaticResources(table, staticSnapshot) {
  const needsBootstrap =
    !table.resources ||
    !Array.isArray(table.resources.planetDefinitions) ||
    !Array.isArray(table.resources.starConfigurations) ||
    !Array.isArray(table.resources.upgradeDefinitions) ||
    table.resources.planetDefinitions.length === 0 ||
    table.resources.starConfigurations.length === 0 ||
    table.resources.upgradeDefinitions.length === 0;
  if (needsBootstrap) {
    table.resources = buildResourcesTableFromStatic(staticSnapshot);
    return true;
  }

  if (
    !semanticVersionEquals(
      table.resources.planetDefinitionsVersion,
      staticSnapshot.planetDefinitionsVersion,
    ) ||
    !resourceRowsMatch(
      table.resources.planetDefinitions,
      staticSnapshot.planetDefinitions,
      "planetID",
    ) ||
    !resourceRowsMatch(
      table.resources.starConfigurations,
      staticSnapshot.starConfigurations,
      "starID",
    ) ||
    !resourceRowsMatch(
      table.resources.upgradeDefinitions,
      staticSnapshot.upgradeDefinitions,
      "installationTypeID",
    )
  ) {
    table.resources = buildResourcesTableFromStatic(staticSnapshot);
    return true;
  }
  return false;
}

function bootstrapHubsFromSystems(table) {
  let changed = false;
  const validHubKeys = new Set();
  for (const [solarSystemID, system] of Object.entries(table.systems || {})) {
    const numericSolarSystemID = normalizePositiveInteger(solarSystemID, null);
    const hubID = normalizePositiveInteger(
      system && system.infrastructureHubID,
      null,
    );
    const allianceID = normalizePositiveInteger(system && system.allianceID, null);
    const corporationID = normalizePositiveInteger(
      system && system.corporationID,
      null,
    );
    if (!numericSolarSystemID || !hubID || !allianceID || !corporationID) {
      continue;
    }

    const key = String(hubID);
    validHubKeys.add(key);
    const fallback = {
      hubID,
      solarSystemID: numericSolarSystemID,
      corporationID,
      allianceID,
      installedUpgrades: [],
      fuelByTypeID: {},
      fuelLastUpdatedMs: 0,
      workforceConfiguration: buildDefaultWorkforceConfigurationForHub(hubID),
      workforceLastUpdatedMs: 0,
      upgradesLastUpdatedMs: 0,
    };
    const normalized = normalizeHubRecord(
      table.hubs && table.hubs[key] ? table.hubs[key] : {},
      fallback,
    );
    normalized.hubID = hubID;
    normalized.solarSystemID = numericSolarSystemID;
    normalized.corporationID = corporationID;
    normalized.allianceID = allianceID;
    if (
      !table.hubs[key] ||
      JSON.stringify(table.hubs[key]) !== JSON.stringify(normalized)
    ) {
      table.hubs[key] = normalized;
      changed = true;
    }
  }

  for (const structure of listStructures({
    includeDestroyed: false,
    refresh: false,
  })) {
    const hubID = normalizePositiveInteger(structure && structure.structureID, null);
    const solarSystemID = normalizePositiveInteger(
      structure && structure.solarSystemID,
      null,
    );
    const corporationID = normalizePositiveInteger(
      structure && (structure.ownerCorpID || structure.corporationID || structure.ownerID),
      null,
    );
    const allianceID = normalizePositiveInteger(
      structure && structure.allianceID,
      null,
    );
    if (
      Number(structure && structure.typeID) !== 32458 ||
      structure.published === false ||
      !hubID ||
      !solarSystemID ||
      !corporationID ||
      !allianceID
    ) {
      continue;
    }

    const key = String(hubID);
    validHubKeys.add(key);
    const fallback = {
      hubID,
      solarSystemID,
      corporationID,
      allianceID,
      installedUpgrades: [],
      fuelByTypeID: {},
      fuelLastUpdatedMs: 0,
      workforceConfiguration: buildDefaultWorkforceConfigurationForHub(hubID),
      workforceLastUpdatedMs: 0,
      upgradesLastUpdatedMs: 0,
    };
    const normalized = normalizeHubRecord(
      table.hubs && table.hubs[key] ? table.hubs[key] : {},
      fallback,
    );
    normalized.hubID = hubID;
    normalized.solarSystemID = solarSystemID;
    normalized.corporationID = corporationID;
    normalized.allianceID = allianceID;
    if (
      !table.hubs[key] ||
      JSON.stringify(table.hubs[key]) !== JSON.stringify(normalized)
    ) {
      table.hubs[key] = normalized;
      changed = true;
    }
  }

  for (const hubKey of Object.keys(table.hubs || {})) {
    if (validHubKeys.has(hubKey)) {
      continue;
    }
    delete table.hubs[hubKey];
    changed = true;
  }
  return changed;
}

function mergeReagentSimulationsWithDefinitions(currentSimulations, definitions) {
  const currentByTypeID = new Map();
  for (const simulation of Array.isArray(currentSimulations) ? currentSimulations : []) {
    const reagentTypeID = normalizePositiveInteger(
      simulation && simulation.reagentTypeID,
      null,
    );
    if (reagentTypeID) {
      currentByTypeID.set(reagentTypeID, simulation);
    }
  }
  return (Array.isArray(definitions) ? definitions : [])
    .map((reagent) => {
      const reagentTypeID = normalizePositiveInteger(
        reagent && reagent.reagentTypeID,
        null,
      );
      if (!reagentTypeID) {
        return null;
      }
      const current = currentByTypeID.get(reagentTypeID) || {};
      return {
        reagentTypeID,
        securedStock: Math.max(
          0,
          normalizeInteger(current.securedStock, reagent.securedStock || 0),
        ),
        unsecuredStock: Math.max(
          0,
          normalizeInteger(current.unsecuredStock, reagent.unsecuredStock || 0),
        ),
        lastCycleMs: normalizeTimestampMs(current.lastCycleMs, Date.now()),
      };
    })
    .filter(Boolean);
}

function bootstrapSkyhooksFromSystems(table, staticSnapshot, options = {}) {
  let changed = false;
  const refreshResourceDefinitions = Boolean(options.refreshResourceDefinitions);
  const validSkyhookKeys = new Set();
  for (const orbital of readDeployedSkyhookOrbitals()) {
    const key = String(orbital.itemID);
    validSkyhookKeys.add(key);
    const definition = staticSnapshot.planetDefinitionsByPlanetID.get(Number(orbital.planetID));
    if (!definition) continue;
    const existing = table.skyhooks[key];
    const nowMs = Date.now();
    const next = normalizeSkyhookRecord(existing || {}, {
      skyhookID: Number(orbital.itemID), planetID: Number(orbital.planetID),
      solarSystemID: Number(orbital.solarSystemID), corporationID: Number(orbital.corporationID || orbital.ownerID),
      allianceID: Number(orbital.allianceID) || null,
      active: PRODUCTIVE_ORBITAL_STATES.has(Number(orbital.state)) && !orbital.destroyedAtMs,
      reagentDefinitions: definition.reagentDefinitions,
      reagentSimulations: (definition.reagentDefinitions || []).map((entry) => ({
        reagentTypeID: entry.reagentTypeID, securedStock: 0, unsecuredStock: 0, lastCycleMs: nowMs,
      })),
      workforceAmount: definition.workforce,
      theftVulnerability: buildDefaultSkyhookWindow(Number(orbital.itemID)),
    });
    next.deployedItem = true;
    next.corporationID = Number(orbital.corporationID || orbital.ownerID);
    next.allianceID = Number(orbital.allianceID) || null;
    if (next.orbitalState !== orbital.state || (orbital.destroyedAtMs && !next.destroyed)) {
      settleSkyhookHarvest(next, nowMs);
      next.active = PRODUCTIVE_ORBITAL_STATES.has(Number(orbital.state)) && !orbital.destroyedAtMs && !next.destroyed;
      next.orbitalState = orbital.state;
      for (const simulation of next.reagentSimulations) simulation.lastCycleMs = nowMs;
    }
    next.destroyed = next.destroyed || Boolean(orbital.destroyedAtMs);
    if (refreshResourceDefinitions) {
      next.reagentDefinitions = cloneValue(definition.reagentDefinitions || []);
      next.reagentSimulations = mergeReagentSimulationsWithDefinitions(next.reagentSimulations, next.reagentDefinitions);
      next.workforceAmount = definition.workforce || null;
    }
    if (JSON.stringify(existing) !== JSON.stringify(next)) {
      table.skyhooks[key] = next;
      changed = true;
    }
  }
  // Planet potential is installation capacity, never harvested resources.
  // Legacy synthetic rows are retired without manufacturing an orbital.
  for (const skyhookKey of Object.keys(table.skyhooks || {})) {
    if (validSkyhookKeys.has(skyhookKey)) {
      continue;
    }
    const oldSkyhook = table.skyhooks[skyhookKey];
    if (oldSkyhook.deployedItem === true && oldSkyhook.raid) {
      // Keep raid receipts reachable when deployment rows are removed. The
      // raid owner finishes pending custody and closes the silo generation.
      if (!oldSkyhook.destroyed) {
        settleSkyhookHarvest(oldSkyhook);
        oldSkyhook.destroyed = true;
        oldSkyhook.active = false;
        changed = true;
      }
      continue;
    }
    if (oldSkyhook.destroyed === true) continue;
    delete table.skyhooks[skyhookKey];
    changed = true;
  }
  return changed;
}

function readDeployedSkyhookOrbitals() {
  const result = database.read("planetOrbitalState", "/orbitalsByID");
  const itemStore = require("../inventory/itemStore");
  const orbitalState = require("../planet/planetOrbitalState");
  const { hasPrivateScope } = require("../planet/planetOrbitalPlacement");
  const planets = getSovereigntyStaticSnapshot().planetDefinitionsByPlanetID;
  return Object.values(result && result.success && result.data || {})
    .filter((entry) => {
      if (Number(entry.typeID) !== 81080 || !(Number(entry.planetID) > 0)) return false;
      if (orbitalState.isSkyhookDeploymentPending?.(entry)) return false;
      const item = itemStore.findItemById(Number(entry.itemID));
      const planet = planets.get(Number(entry.planetID));
      return Boolean(item && item.spaceState && planet &&
        !hasPrivateScope(entry) && !hasPrivateScope(item) && !hasPrivateScope(item.spaceState) &&
        (!item.spaceState.sceneKind || item.spaceState.sceneKind === "solarSystem") &&
        Number(item.typeID) === 81080 && Number(item.flagID) === 0 &&
        Number(item.ownerID) === Number(entry.corporationID || entry.ownerID) &&
        Number(item.locationID) === Number(entry.solarSystemID) &&
        Number(item.spaceState.systemID) === Number(entry.solarSystemID) &&
        Number(planet.solarSystemID) === Number(entry.solarSystemID));
    });
}

function ensureBootstrappedTable() {
  const staticSnapshot = getSovereigntyStaticSnapshot();
  let table = readSovereigntyTable();
  let changed = false;
  const resourcesChanged = ensureStaticResources(table, staticSnapshot);
  changed = resourcesChanged || changed;
  changed = bootstrapHubsFromSystems(table) || changed;
  changed = bootstrapSkyhooksFromSystems(table, staticSnapshot, {
    refreshResourceDefinitions: resourcesChanged,
  }) || changed;
  // Bootstrapping derives hubs, skyhooks and resources from the static snapshot,
  // so a passive process reproduces the same table in memory and reads from it.
  // Only the durable owner writes it back — and leaving `_meta.updatedAt` alone
  // is what lets the ensureLoaded probe hit on the next call.
  if (changed && maySovereigntyPersist()) {
    table = writeSovereigntyTable(table);
  }
  return {
    table,
    staticSnapshot,
  };
}

function getHubLocalHarvest(hubRecord, stateCache) {
  const solarSystemID = normalizePositiveInteger(hubRecord && hubRecord.solarSystemID, 0);
  const starConfiguration =
    stateCache.staticSnapshot.starConfigurationsBySolarSystemID.get(solarSystemID) ||
    null;
  const harvested = stateCache.localHarvestBySolarSystemID.get(solarSystemID) || null;
  return {
    power:
      Number(harvested && harvested.power) ||
      Number(starConfiguration && starConfiguration.power) ||
      0,
    workforce: Number(harvested && harvested.workforce) || 0,
  };
}

function getHubImportAmount(sourceHub, stateCache) {
  if (!sourceHub) {
    return 0;
  }
  const sourceHarvest = getHubLocalHarvest(sourceHub, stateCache);
  return Math.max(0, Math.min(Number(sourceHarvest.workforce || 0), 1000));
}

function getHubTransferDelta(hubRecord, stateCache) {
  const configuration = normalizeWorkforceConfiguration(
    hubRecord && hubRecord.workforceConfiguration,
    hubRecord && hubRecord.hubID,
  );
  if (configuration.mode === "import") {
    return configuration.sourceSystemIDs.reduce((sum, sourceSystemID) => {
      const sourceHub = stateCache.hubsBySolarSystemID.get(sourceSystemID) || null;
      return sum + getHubImportAmount(sourceHub, stateCache);
    }, 0);
  }

  if (configuration.mode === "export") {
    return -Math.max(0, normalizeInteger(configuration.amount, 0));
  }

  return 0;
}

function computeHubUpgradeSnapshot(hubRecord, stateCache) {
  const localHarvest = getHubLocalHarvest(hubRecord, stateCache);
  const powerLocalHarvest = Number(localHarvest.power || 0);
  const workforceLocalHarvest = Number(localHarvest.workforce || 0);
  const workforceTransferDelta = getHubTransferDelta(hubRecord, stateCache);

  const workforceAvailable = Math.max(
    0,
    workforceLocalHarvest + workforceTransferDelta,
  );
  let totalPowerAvailable = powerLocalHarvest;
  let totalWorkforceAvailable = workforceAvailable;
  let powerAllocated = 0;
  let workforceAllocated = 0;
  const upgrades = [];
  const funded = new Set(hubFuel.selectRunningUpgrades(
    hubFuel.checkpointUpgrades(hubRecord.installedUpgrades, stateCache.staticSnapshot.upgradeDefinitionsByTypeID),
    { power: powerLocalHarvest, workforce: workforceAvailable },
    hubRecord.fuelByTypeID, hubRecord.hubFuelState,
  ).runningTypeIDs);

  for (const installation of hubRecord.installedUpgrades) {
    const definition = stateCache.staticSnapshot.upgradeDefinitionsByTypeID.get(
      installation.typeID,
    );
    if (!definition) {
      continue;
    }

    let powerState = POWER_STATE.POWER_STATE_OFFLINE;
    if (installation.online) {
      const canPower =
        funded.has(installation.typeID) &&
        powerAllocated + definition.powerRequired <= totalPowerAvailable;
      const canWorkforce =
        workforceAllocated + definition.workforceRequired <= totalWorkforceAvailable;
      if (canPower && canWorkforce) {
        powerState = POWER_STATE.POWER_STATE_ONLINE;
        powerAllocated += definition.powerRequired;
        workforceAllocated += definition.workforceRequired;
        totalPowerAvailable += definition.powerProduced;
        totalWorkforceAvailable += definition.workforceProduced;
      } else {
        powerState = POWER_STATE.POWER_STATE_LOW;
      }
    }

    upgrades.push({
      typeID: installation.typeID,
      definition,
      powerState,
    });
  }


  return {
    // The client starts its priority simulation with these resources and adds
    // each online upgrade's production itself. Including production here counts
    // it twice and lets later producers incorrectly support earlier consumers.
    resources: {
      power: {
        available: powerLocalHarvest,
        allocated: powerAllocated,
        localHarvest: powerLocalHarvest,
      },
      workforce: {
        available: workforceAvailable,
        allocated: workforceAllocated,
        localHarvest: workforceLocalHarvest,
      },
    },
    upgrades,
  };
}

function buildWorkforceState(configuration, hubRecord, identityCache) {
  if (configuration.mode === "import") {
    const sources = configuration.sourceSystemIDs.map((sourceSystemID) => {
      const sourceHub =
        identityCache.hubsBySolarSystemID.get(sourceSystemID) || null;
      return {
        sourceSystemID,
        amount: getHubImportAmount(sourceHub, identityCache),
      };
    });
    return {
      mode: "import",
      sources,
      destinationSystemID: null,
      amount: 0,
      connected: false,
    };
  }

  if (configuration.mode === "export") {
    const connected =
      configuration.destinationSystemID &&
      identityCache.hubsBySolarSystemID.has(configuration.destinationSystemID);
    return {
      mode: "export",
      sources: [],
      destinationSystemID: configuration.destinationSystemID,
      amount: configuration.amount,
      connected,
    };
  }

  if (configuration.mode === "transit") {
    return {
      mode: "transit",
      sources: [],
      destinationSystemID: null,
      amount: 0,
      connected: false,
    };
  }

  return {
    mode: "inactive",
    sources: [],
    destinationSystemID: null,
    amount: 0,
    connected: false,
  };
}

function deriveSkyhookTheftVulnerability(skyhook) {
  const now = getWallclockNowMs();
  const startMs = normalizeTimestampMs(
    skyhook &&
      skyhook.theftVulnerability &&
      skyhook.theftVulnerability.startMs,
    0,
  );
  const endMs = normalizeTimestampMs(
    skyhook &&
      skyhook.theftVulnerability &&
      skyhook.theftVulnerability.endMs,
    0,
  );
  return {
    vulnerable:
      Boolean(skyhook && skyhook.active) &&
      startMs > 0 &&
      endMs > 0 &&
      now >= startMs &&
      now < endMs,
    startMs,
    endMs,
  };
}

function ensureLoaded(sourceTable = null) {
  // The orbital table bumps this revision whenever a deployed skyhook row
  // changes, so reads never have to scan it.
  const orbitalRevision = getDeployedSkyhookRevision();
  // Fast path: bootstrapping is a pure function of the table and the static
  // snapshot, so if neither has moved since the cache was built it can only
  // reproduce what is already there. Probing the table's revision avoids reading
  // and cloning it, and avoids re-running the hub/skyhook/resource scans, just to
  // discover there was nothing to do. getSovereigntyStaticSnapshot is memoised
  // and hands back the same object every time, so identity is a sound key for it.
  const probedUpdatedAt = readSovereigntyTableUpdatedAt();
  if (
    !sourceTable && cache &&
    cache.orbitalRevision === orbitalRevision &&
    cache.updatedAt === probedUpdatedAt &&
    cache.staticSnapshot === getSovereigntyStaticSnapshot()
  ) {
    return cache;
  }

  const { table, staticSnapshot } = sourceTable
    ? { table: sourceTable, staticSnapshot: getSovereigntyStaticSnapshot() }
    : ensureBootstrappedTable();
  const updatedAt = table && table._meta ? table._meta.updatedAt : null;
  if (!sourceTable && cache && cache.updatedAt === updatedAt && cache.orbitalRevision === orbitalRevision) {
    return cache;
  }

  const nextCache = {
    orbitalRevision,
    updatedAt,
    staticSnapshot,
    table,
    hubsByID: new Map(),
    hubsBySolarSystemID: new Map(),
    skyhooksByID: new Map(),
    skyhooksBySolarSystemID: new Map(),
    skyhooksByCorporationID: new Map(),
    vulnerableSkyhooksBySolarSystemID: new Map(),
    localHarvestBySolarSystemID: new Map(),
    hubSnapshotsByID: new Map(),
  };

  for (const [hubID, rawHub] of Object.entries(table.hubs || {})) {
    const normalizedHub = normalizeHubRecord(rawHub, {
      hubID: normalizePositiveInteger(hubID, null),
    });
    if (!normalizedHub.hubID || !normalizedHub.solarSystemID) {
      continue;
    }
    nextCache.hubsByID.set(normalizedHub.hubID, normalizedHub);
    nextCache.hubsBySolarSystemID.set(
      normalizedHub.solarSystemID,
      normalizedHub,
    );
  }

  for (const [skyhookID, rawSkyhook] of Object.entries(table.skyhooks || {})) {
    if (rawSkyhook && rawSkyhook.destroyed === true) {
      continue;
    }
    const normalizedSkyhook = normalizeSkyhookRecord(rawSkyhook, {
      skyhookID: normalizePositiveInteger(skyhookID, null),
    });
    if (
      !normalizedSkyhook.skyhookID ||
      !normalizedSkyhook.solarSystemID ||
      !normalizedSkyhook.planetID
    ) {
      continue;
    }

    nextCache.skyhooksByID.set(normalizedSkyhook.skyhookID, normalizedSkyhook);
    if (!nextCache.skyhooksBySolarSystemID.has(normalizedSkyhook.solarSystemID)) {
      nextCache.skyhooksBySolarSystemID.set(normalizedSkyhook.solarSystemID, []);
    }
    nextCache.skyhooksBySolarSystemID
      .get(normalizedSkyhook.solarSystemID)
      .push(normalizedSkyhook);

    if (!nextCache.skyhooksByCorporationID.has(normalizedSkyhook.corporationID)) {
      nextCache.skyhooksByCorporationID.set(normalizedSkyhook.corporationID, []);
    }
    nextCache.skyhooksByCorporationID
      .get(normalizedSkyhook.corporationID)
      .push(normalizedSkyhook);

    if (!nextCache.localHarvestBySolarSystemID.has(normalizedSkyhook.solarSystemID)) {
      const starConfiguration =
        staticSnapshot.starConfigurationsBySolarSystemID.get(
          normalizedSkyhook.solarSystemID,
        ) || null;
      nextCache.localHarvestBySolarSystemID.set(normalizedSkyhook.solarSystemID, {
        power: Number(starConfiguration && starConfiguration.power) || 0,
        workforce: 0,
      });
    }
    const localHarvest = nextCache.localHarvestBySolarSystemID.get(
      normalizedSkyhook.solarSystemID,
    );
    const contribution = getSkyhookHarvestContribution(
      normalizedSkyhook,
      staticSnapshot,
    );
    localHarvest.power += Number(contribution.power || 0);
    // A Mercenary Den at the skyhook takes its anarchy stage's workforce
    // (mercenaryDenState). Upgrades the hub can no longer staff go low power.
    const denSiphon = require("./mercenaryDenState").getSkyhookWorkforceSiphon(
      table,
      normalizedSkyhook.skyhookID,
    );
    localHarvest.workforce += Math.max(0, Number(contribution.workforce || 0) - denSiphon);

    const vulnerability = deriveSkyhookTheftVulnerability(normalizedSkyhook);
    if (vulnerability.endMs > Date.now()) {
      if (
        !nextCache.vulnerableSkyhooksBySolarSystemID.has(
          normalizedSkyhook.solarSystemID,
        )
      ) {
        nextCache.vulnerableSkyhooksBySolarSystemID.set(
          normalizedSkyhook.solarSystemID,
          [],
        );
      }
      nextCache.vulnerableSkyhooksBySolarSystemID
        .get(normalizedSkyhook.solarSystemID)
        .push({
          skyhookID: normalizedSkyhook.skyhookID,
          planetID: normalizedSkyhook.planetID,
          startMs: vulnerability.startMs,
          endMs: vulnerability.endMs,
        });
    }
  }

  for (const list of nextCache.skyhooksBySolarSystemID.values()) {
    list.sort((left, right) => left.skyhookID - right.skyhookID);
  }
  for (const list of nextCache.skyhooksByCorporationID.values()) {
    list.sort((left, right) => left.skyhookID - right.skyhookID);
  }
  for (const list of nextCache.vulnerableSkyhooksBySolarSystemID.values()) {
    list.sort((left, right) => left.skyhookID - right.skyhookID);
  }
  for (const hub of nextCache.hubsByID.values()) {
    nextCache.hubSnapshotsByID.set(
      hub.hubID,
      computeHubUpgradeSnapshot(hub, nextCache),
    );
  }

  if (!sourceTable) cache = nextCache;
  return nextCache;
}

function flushHubFuel() {
  if (!fuelPersistencePending) return [];
  const result = database.flushTableSync("sovereignty");
  if (!result || !result.success) {
    const error = new Error("HUB_FUEL_PERSISTENCE_FAILED");
    error.code = "HUB_FUEL_PERSISTENCE_FAILED";
    error.errorCode = "HUB_FUEL_PERSISTENCE_FAILED";
    error.statusCode = 503;
    throw error;
  }
  fuelPersistencePending = false;
  const plans = fuelPlansPendingPublication;
  fuelPlansPendingPublication = [];
  return plans;
}

function planHubFuel(table, stateCache, nowMs) {
  const plans = [];
  for (const hub of stateCache.hubsByID.values()) {
    const harvest = getHubLocalHarvest(hub, stateCache);
    const plan = hubFuel.settleHubFuel({
      fuelByTypeID: hub.fuelByTypeID, fuelState: hub.hubFuelState,
      upgrades: hubFuel.checkpointUpgrades(hub.installedUpgrades, stateCache.staticSnapshot.upgradeDefinitionsByTypeID),
      resources: { power: harvest.power, workforce: Math.max(0, harvest.workforce + getHubTransferDelta(hub, stateCache)) },
      nowMs,
    });
    if (table && plan.changed) {
      const current = table.hubs[String(hub.hubID)];
      current.fuelByTypeID = plan.fuelByTypeID;
      current.hubFuelState = plan.fuelState;
      if (JSON.stringify(hub.fuelByTypeID) !== JSON.stringify(plan.fuelByTypeID)) current.fuelLastUpdatedMs = nowMs;
      if (plan.observableChanged) current.upgradesLastUpdatedMs = nowMs;
    }
    plans.push({ hubID: hub.hubID, ...plan });
  }
  return plans;
}

function publishHubFuelPlans(plans) {
  if (typeof fuelSchedulePublisher === "function") fuelSchedulePublisher();
  if (typeof hubStateNoticePublisher !== "function") return;
  for (const plan of plans) if (plan.observableChanged) {
    try { hubStateNoticePublisher(plan.hubID); }
    catch (error) { log.warn(`[SovHubFuel] notice for Hub ${plan.hubID} failed: ${error.message}`); }
  }
}

// Cursor, fractional remainder, startup payment and debit share one durable
// sovereignty write. A failed flush keeps that staged version for the next
// retry; no caller may grant benefits until the flush succeeds. Replaying an
// older on-disk version after a crash replays its debit exactly once.
function settleAllHubFuel(options = {}) {
  if (settlingFuel || !maySovereigntyPersist()) return { hubs: 0, changed: 0 };
  settlingFuel = true;
  try {
    const recoveredPlans = flushHubFuel();
    const stateCache = ensureLoaded();
    const nowMs = options.nowMs ?? getWallclockNowMs();
    const plans = planHubFuel(null, stateCache, nowMs);
    const recoveredHubIDs = new Set(recoveredPlans.filter(plan => plan.observableChanged).map(plan => plan.hubID));
    const publicationPlans = plans.map(plan => ({ ...plan,
      observableChanged: plan.observableChanged || recoveredHubIDs.has(plan.hubID),
    }));
    const changed = plans.filter((plan) => plan.changed).length;
    // A read need not rewrite the entire sovereignty table just to checkpoint
    // an invisible fraction. The old cursor retains that liability until the
    // next unit, transition or durable tick; replay after a crash computes it
    // from the same wall clock. Any observable debit/state change is durable.
    const persist = changed && (!options.forRead || plans.some((plan) => plan.observableChanged));
    if (persist) {
      const table = mergeSovereigntyTableDefaults(stateCache.table);
      for (const plan of plans) if (plan.changed) {
        const current = table.hubs[String(plan.hubID)];
        if (JSON.stringify(current.fuelByTypeID || {}) !== JSON.stringify(plan.fuelByTypeID)) current.fuelLastUpdatedMs = nowMs;
        if (plan.observableChanged) current.upgradesLastUpdatedMs = nowMs;
        current.fuelByTypeID = plan.fuelByTypeID;
        current.hubFuelState = plan.fuelState;
      }
      // A running upgrade debits a unit every few seconds. Rebuilding the cache
      // from the table just written keeps the next read on the fast path; dropping
      // it made that read re-bootstrap everything, a 100 ms tick each debit.
      cache = ensureLoaded(writeSovereigntyTable(table));
      fuelPersistencePending = true;
      fuelPlansPendingPublication = publicationPlans;
      flushHubFuel();
      publishHubFuelPlans(publicationPlans);
    } else if (recoveredPlans.length) {
      publishHubFuelPlans(publicationPlans);
    }
    return { hubs: plans.length, changed, nextDueAtMs: Math.min(...plans.map((plan) => plan.nextDueAtMs ?? Infinity)) };
  } finally { settlingFuel = false; }
}

function getHubFuelNextDueAtMs() {
  const stateCache = ensureLoaded();
  let dueAtMs = Infinity;
  for (const hub of stateCache.hubsByID.values()) {
    const harvest = getHubLocalHarvest(hub, stateCache);
    const plan = hubFuel.settleHubFuel({ fuelByTypeID: hub.fuelByTypeID, fuelState: hub.hubFuelState,
      upgrades: hubFuel.checkpointUpgrades(hub.installedUpgrades, stateCache.staticSnapshot.upgradeDefinitionsByTypeID),
      resources: { power: harvest.power, workforce: Math.max(0, harvest.workforce + getHubTransferDelta(hub, stateCache)) },
      nowMs: hub.hubFuelState?.settledAtMs ?? getWallclockNowMs() });
    if (plan.nextDueAtMs !== null) dueAtMs = Math.min(dueAtMs, plan.nextDueAtMs);
  }
  return Number.isFinite(dueAtMs) ? dueAtMs : null;
}

function mutateTable(mutator) {
  settleAllHubFuel();
  const { table } = ensureBootstrappedTable();
  const workingTable = mergeSovereigntyTableDefaults(table);
  const result = mutator(workingTable) || {};
  const plans = planHubFuel(workingTable, ensureLoaded(workingTable), getWallclockNowMs());
  const persistedTable = writeSovereigntyTable(workingTable);
  cache = null;
  if (JSON.stringify(table.hubs) !== JSON.stringify(workingTable.hubs)) {
    fuelPersistencePending = true;
    fuelPlansPendingPublication = plans;
    try {
      flushHubFuel();
    } catch (error) {
      // Distinguish this requested mutation from the upkeep flush at entry.
      // Custody callers may report a durable debit as committed only after its
      // matching credit/configuration was staged with the durable cursor.
      if (error.code === "HUB_FUEL_PERSISTENCE_FAILED") error.hubMutationStaged = true;
      throw error;
    }
  }
  settlingFuel = true;
  try { publishHubFuelPlans(plans); } finally { settlingFuel = false; }
  return {
    ...result,
    table: persistedTable,
  };
}

function findLiveSessionByCharacterID(characterID) {
  const numericCharacterID = normalizePositiveInteger(characterID, null);
  if (!numericCharacterID) {
    return null;
  }
  return sessionRegistry.findSessionByCharacterID(numericCharacterID) || null;
}

function getActiveCharacterIdentity(characterID) {
  const numericCharacterID = normalizePositiveInteger(characterID, null);
  const record = numericCharacterID ? getCharacterRecord(numericCharacterID) : null;
  const validCharacter = Boolean(numericCharacterID && record &&
    !record.isDeleted && !record.deletedAt && !record.deleted);
  const persistedCorporationID = validCharacter
    ? normalizePositiveInteger(record.corporationID, 0) : 0;
  const { getPersistedCorporationAuthority, getAllianceMemberAuthority } =
    require("../corporation/corporationAuthority");
  // The gateway resolves the selected character before dispatch. Resolve its
  // private organization scopes from the store even if live affiliation delivery
  // was missed; live session aliases must not retain a former organization's data.
  const actor = { characterID: numericCharacterID, corporationID: persistedCorporationID };
  const authority = validCharacter ? getPersistedCorporationAuthority(actor) : null;
  const corporationState = require("../corporation/corporationState");
  const corporation = persistedCorporationID
    ? corporationState.getCorporationRecord(persistedCorporationID) : null;
  const npcCorporationID = corporation && !corporation.deleted &&
    (corporation.isNPC === true || corporationState.isNpcCorporationID(persistedCorporationID))
    ? persistedCorporationID : 0;
  const liveSession = numericCharacterID
    ? findLiveSessionByCharacterID(numericCharacterID)
    : null;
  const liveSolarSystemID = resolveSessionInteger(liveSession, [
    "solarsystemid2",
    "solarsystemid",
  ]);
  return {
    characterID: validCharacter ? numericCharacterID : 0,
    corporationID: authority?.corporationID || npcCorporationID,
    allianceID: authority ? getAllianceMemberAuthority(actor)?.allianceID || 0 : 0,
    solarSystemID:
      liveSolarSystemID !== null
        ? liveSolarSystemID
        : normalizePositiveInteger(record && record.solarSystemID, 0) || 0,
  };
}

function getHubIDForSolarSystem(solarSystemID) {
  const hub =
    ensureLoaded().hubsBySolarSystemID.get(
      normalizePositiveInteger(solarSystemID, 0),
    ) || null;
  return hub ? hub.hubID : null;
}

function hasAllianceOrCorporationAccess(owner, identity) {
  if (!owner || !identity) {
    return false;
  }
  if (
    normalizePositiveInteger(owner.corporationID, 0) > 0 &&
    normalizePositiveInteger(identity.corporationID, 0) ===
      normalizePositiveInteger(owner.corporationID, 0)
  ) {
    return true;
  }
  return (
    normalizePositiveInteger(owner.allianceID, 0) > 0 &&
    normalizePositiveInteger(identity.allianceID, 0) ===
      normalizePositiveInteger(owner.allianceID, 0)
  );
}

function getHubRecord(hubID) {
  return ensureLoaded().hubsByID.get(normalizePositiveInteger(hubID, 0)) || null;
}

function requireHubAccess(hubID, identity, requireOwnership = false) {
  const hub = getHubRecord(hubID);
  if (!hub) {
    return {
      ok: false,
      statusCode: 404,
      errorCode: "HUB_NOT_FOUND",
      hub: null,
    };
  }
  if (!requireOwnership || hasAllianceOrCorporationAccess(hub, identity)) {
    return {
      ok: true,
      hub,
    };
  }
  return {
    ok: false,
    statusCode: 403,
    errorCode: "FORBIDDEN_REQUEST",
    hub,
  };
}

function requireSkyhookAccess(skyhookID, identity, options = {}) {
  const skyhook =
    ensureLoaded().skyhooksByID.get(normalizePositiveInteger(skyhookID, 0)) || null;
  if (!skyhook) {
    return {
      ok: false,
      statusCode: 404,
      errorCode: "SKYHOOK_NOT_FOUND",
      skyhook: null,
    };
  }
  if (
    options.allowLocalSystem &&
    normalizePositiveInteger(identity && identity.solarSystemID, 0) ===
      normalizePositiveInteger(skyhook.solarSystemID, 0)
  ) {
    return {
      ok: true,
      skyhook,
    };
  }
  if (!options.requireOwnership || hasAllianceOrCorporationAccess(skyhook, identity)) {
    return {
      ok: true,
      skyhook,
    };
  }
  return {
    ok: false,
    statusCode: 403,
    errorCode: "FORBIDDEN_REQUEST",
    skyhook,
  };
}

function buildHubUpgradePayloadState(hubID, settleFuel = true) {
  if (settleFuel) settleAllHubFuel({ forRead: true });
  const stateCache = ensureLoaded();
  const hub = stateCache.hubsByID.get(normalizePositiveInteger(hubID, 0)) || null;
  if (!hub) {
    return null;
  }
  const upgradeSnapshot =
    stateCache.hubSnapshotsByID.get(hub.hubID) ||
    computeHubUpgradeSnapshot(hub, stateCache);
  return {
    hubID: hub.hubID,
    solarSystemID: hub.solarSystemID,
    resources: upgradeSnapshot.resources,
    upgrades: upgradeSnapshot.upgrades.map((upgrade) => ({
      hubID: hub.hubID,
      typeID: upgrade.typeID,
      installationTypeID: upgrade.definition.installationTypeID,
      powerState: upgrade.powerState,
      definition: upgrade.definition,
      // When it started running (sovHubFuelBurn), for the site supply's
      // first-spawn wait; null when not running.
      runningSinceMs: hub.hubFuelState && hub.hubFuelState.runningSinceByTypeID &&
        hub.hubFuelState.runningSinceByTypeID[String(upgrade.typeID)] !== undefined
        ? Number(hub.hubFuelState.runningSinceByTypeID[String(upgrade.typeID)])
        : null,
    })),
    lastUpdatedMs: hub.upgradesLastUpdatedMs || 0,
  };
}

function getHubResources(hubID, identity = null) {
  if (identity) {
    const access = requireHubAccess(hubID, identity, true);
    if (!access.ok) {
      return access;
    }
  }
  const payloadState = buildHubUpgradePayloadState(hubID);
  if (!payloadState) {
    return null;
  }
  return {
    hubID: payloadState.hubID,
    solarSystemID: payloadState.solarSystemID,
    power: cloneValue(payloadState.resources.power),
    workforce: cloneValue(payloadState.resources.workforce),
  };
}

function listUpgradeDefinitions() {
  return cloneValue(ensureLoaded().staticSnapshot.upgradeDefinitions);
}

function getHubUpgrades(hubID, identity = null) {
  if (identity) {
    const access = requireHubAccess(hubID, identity, true);
    if (!access.ok) {
      return access;
    }
  }
  const payloadState = buildHubUpgradePayloadState(hubID);
  if (!payloadState) {
    return null;
  }
  return cloneValue(payloadState);
}

// A durable inventory debit can precede a delayed Hub flush. Its save reply
// still identifies the installed configuration, but cannot promise benefits
// from an unflushed activation. Normal readers retain the flush guard.
function getHubUpgradesPendingPersistence(hubID) {
  const hub = ensureLoaded().hubsByID.get(normalizePositiveInteger(hubID, 0));
  const payload = buildHubUpgradePayloadState(hubID, false);
  if (!hub || !payload) return null;
  const enabled = new Set(hub.installedUpgrades.filter(entry => entry.online).map(entry => entry.typeID));
  return { ...cloneValue(payload), upgrades: payload.upgrades.map(upgrade => ({
    ...cloneValue(upgrade),
    powerState: enabled.has(upgrade.typeID) ? POWER_STATE.POWER_STATE_PENDING : POWER_STATE.POWER_STATE_OFFLINE,
  })) };
}

function validateUpgradeConfiguration(installations, staticSnapshot, system = null) {
  const strategicLevel = getStrategicIndexLevelForSystem(system);
  const onlineCountsByGroup = new Map();
  for (const installation of installations) {
    if (!installation.online) {
      continue;
    }
    const definition = staticSnapshot.upgradeDefinitionsByTypeID.get(installation.typeID);
    if (!definition) {
      return {
        ok: false,
        statusCode: 400,
        errorCode: "INVALID_DATA",
      };
    }
    const requiredStrategicIndex = Math.max(
      0,
      normalizeInteger(definition.requiredStrategicIndex, 0),
    );
    if (strategicLevel < requiredStrategicIndex) {
      return {
        ok: false,
        statusCode: 409,
        errorCode: "CONFLICT",
      };
    }
    const groupName = String(definition.mutuallyExclusiveGroup || "").trim();
    if (!groupName) {
      continue;
    }
    const count = (onlineCountsByGroup.get(groupName) || 0) + 1;
    onlineCountsByGroup.set(groupName, count);
    if (count > 1) {
      return {
        ok: false,
        statusCode: 409,
        errorCode: "CONFLICT",
      };
    }
  }
  return {
    ok: true,
  };
}

// The Sov Hub window and its reagent bay only take items from a ship within cargo
// transfer range of the Hub, the range skyhook extraction also checks.
function isShipWithinHubTransferRange(session, shipID, hubID) {
  const spaceRuntime = require(path.join(__dirname, "../../space/runtime"));
  const {
    MAX_CARGO_CONTAINER_TRANSFER_DISTANCE_METERS,
  } = require(path.join(__dirname, "../ship/cargoContainerRuntime"));
  const shipEntity = session ? spaceRuntime.getEntity(session, shipID) : null;
  const hubEntity = session ? spaceRuntime.getEntity(session, hubID) : null;
  if (!shipEntity || !hubEntity) {
    return false;
  }
  const distance = Math.hypot(...["x", "y", "z"].map((axis) => (
    Number(shipEntity.position && shipEntity.position[axis]) -
    Number(hubEntity.position && hubEntity.position[axis])
  ))) - Number(shipEntity.radius || 0) - Number(hubEntity.radius || 0);
  return Number.isFinite(distance) && distance <= MAX_CARGO_CONTAINER_TRANSFER_DISTANCE_METERS;
}

function processHubUpgradeConfiguration(
  hubID,
  newUpgradeItemIDs,
  configurations,
  identity,
) {
  const access = requireHubAccess(hubID, identity, true);
  if (!access.ok) {
    return access;
  }

  const staticSnapshot = ensureLoaded().staticSnapshot;
  try {
    return require("./sovHubUpgradeInstall").installHubUpgrades({
      hub: access.hub, newUpgradeItemIDs, configurations, identity,
      session: findLiveSessionByCharacterID(identity.characterID),
      inTransferRange: (shipID) => isShipWithinHubTransferRange(
        findLiveSessionByCharacterID(identity.characterID),
        shipID,
        access.hub.hubID,
      ),
      mutateHub: (mutator) => mutateTable((table) => mutator(table.hubs[String(access.hub.hubID)])),
      isUpgradeType: (typeID) => staticSnapshot.upgradeDefinitionsByTypeID.has(
        normalizePositiveInteger(typeID, null),
      ),
      buildInstallations: (newTypeIDs, requestedConfigurations) => {
        const { table } = ensureBootstrappedTable();
        const hub = normalizeHubRecord(table.hubs[String(access.hub.hubID)], access.hub);
        const installedTypeIDs = hub.installedUpgrades.map((installation) => installation.typeID);
        const installationsByTypeID = new Map(
          hub.installedUpgrades.map((installation) => [installation.typeID, installation]),
        );

        for (const typeID of newTypeIDs) {
          if (!installationsByTypeID.has(typeID)) {
            installationsByTypeID.set(typeID, {
              typeID,
              online: false,
            });
          }
        }

        const configuredOrder = [];
        for (const configuration of requestedConfigurations || []) {
          const typeID = normalizePositiveInteger(configuration.typeID, null);
          if (!typeID || !installationsByTypeID.has(typeID)) {
            throw {
              statusCode: 404,
              errorCode: "NOT_FOUND",
            };
          }
          installationsByTypeID.set(typeID, {
            typeID,
            online: Boolean(configuration.online),
          });
          configuredOrder.push(typeID);
        }

        // Request order is priority order, used both for resource allocation
        // and the client's post-save comparison. Keep omitted entries last.
        const installations = [...new Set([...configuredOrder, ...installationsByTypeID.keys()])]
          .map(typeID => installationsByTypeID.get(typeID));
        const system = table.systems[String(hub.solarSystemID)] || {
          solarSystemID: hub.solarSystemID,
        };
        const validation = validateUpgradeConfiguration(
          installations,
          staticSnapshot,
          system,
        );
        if (!validation.ok) {
          throw validation;
        }

        return { installations, installedTypeIDs };
      },
    });
  } catch (error) {
    return {
      ok: false,
      statusCode: error && error.statusCode ? error.statusCode : 500,
      errorCode: error && error.errorCode ? error.errorCode : "INTERNAL_SERVER_ERROR",
      hub: access.hub,
    };
  } finally {
    cache = null;
  }
}

function setHubUpgradeInstallations(
  hubID,
  installations,
  identity,
) {
  const access = requireHubAccess(hubID, identity, true);
  if (!access.ok) {
    return access;
  }

  const staticSnapshot = ensureLoaded().staticSnapshot;
  try {
    return mutateTable((table) => {
      const hub = normalizeHubRecord(table.hubs[String(access.hub.hubID)], access.hub);
      const installationsByTypeID = new Map(
        hub.installedUpgrades.map((installation) => [installation.typeID, installation]),
      );

      for (const installation of installations || []) {
        const typeID = normalizePositiveInteger(installation && installation.typeID, null);
        if (!typeID || !staticSnapshot.upgradeDefinitionsByTypeID.has(typeID)) {
          throw {
            statusCode: 404,
            errorCode: "NOT_FOUND",
          };
        }
        installationsByTypeID.set(typeID, {
          typeID,
          online: Boolean(installation && installation.online),
        });
      }

      // The installed list is the Hub's priority order, which players set in
      // the Sov Hub window. An upgrade enabled here keeps its place, and a new
      // one goes last.
      const nextInstallations = [...installationsByTypeID.values()];
      const system = table.systems[String(hub.solarSystemID)] || {
        solarSystemID: hub.solarSystemID,
      };
      const validation = validateUpgradeConfiguration(
        nextInstallations,
        staticSnapshot,
        system,
      );
      if (!validation.ok) {
        throw validation;
      }

      hub.installedUpgrades = nextInstallations;
      hub.upgradesLastUpdatedMs = Date.now();
      table.hubs[String(hub.hubID)] = hub;
      return {
        ok: true,
        hubID: hub.hubID,
        solarSystemID: hub.solarSystemID,
      };
    });
  } catch (error) {
    return {
      ok: false,
      statusCode: error && error.statusCode ? error.statusCode : 500,
      errorCode: error && error.errorCode ? error.errorCode : "INTERNAL_SERVER_ERROR",
      hub: access.hub,
    };
  }
}

function uninstallHubUpgrade(hubID, upgradeTypeID, identity) {
  const access = requireHubAccess(hubID, identity, true);
  if (!access.ok) {
    return access;
  }

  const numericUpgradeTypeID = normalizePositiveInteger(upgradeTypeID, null);
  if (!numericUpgradeTypeID) {
    return {
      ok: false,
      statusCode: 404,
      errorCode: "NOT_FOUND",
      hub: access.hub,
    };
  }

  try {
    return mutateTable((table) => {
      const hub = normalizeHubRecord(table.hubs[String(access.hub.hubID)], access.hub);
      const beforeCount = hub.installedUpgrades.length;
      hub.installedUpgrades = hub.installedUpgrades.filter(
        (installation) => installation.typeID !== numericUpgradeTypeID,
      );
      delete hub.installedUpgradeSources[numericUpgradeTypeID];
      if (hub.installedUpgrades.length === beforeCount) {
        throw {
          statusCode: 404,
          errorCode: "NOT_FOUND",
        };
      }
      hub.upgradesLastUpdatedMs = Date.now();
      table.hubs[String(hub.hubID)] = hub;
      return {
        ok: true,
        hubID: hub.hubID,
        solarSystemID: hub.solarSystemID,
        upgradeTypeID: numericUpgradeTypeID,
      };
    });
  } catch (error) {
    return {
      ok: false,
      statusCode: error && error.statusCode ? error.statusCode : 500,
      errorCode: error && error.errorCode ? error.errorCode : "INTERNAL_SERVER_ERROR",
      hub: access.hub,
    };
  }
}

function getHubFuel(hubID, identity = null) {
  settleAllHubFuel({ forRead: true });
  if (identity) {
    const access = requireHubAccess(hubID, identity, true);
    // A pilot on the Hub's fuel access list may read its fuel as well, because
    // the reagent bay reads it before that pilot can deposit.
    if (!access.ok && (access.statusCode !== 403 || !requireHubFuelDepositAccess(
      hubID,
      identity,
      findLiveSessionByCharacterID(identity.characterID),
    ).ok)) {
      return access;
    }
  }
  const hub = getHubRecord(hubID);
  if (!hub) {
    return null;
  }
  const upgradeState = buildHubUpgradePayloadState(hubID, false) || {
    upgrades: [],
  };
  const burnedPerHourByFuelType = new Map();
  for (const upgrade of upgradeState.upgrades || []) {
    if (upgrade.powerState !== POWER_STATE.POWER_STATE_ONLINE) {
      continue;
    }
    const definition = upgrade.definition;
    const currentBurn = burnedPerHourByFuelType.get(definition.fuelTypeID) || 0;
    burnedPerHourByFuelType.set(
      definition.fuelTypeID,
      currentBurn + Number(definition.fuelConsumptionPerHour || 0),
    );
  }

  const fuelTypeIDs = new Set([
    ...Object.keys(hub.fuelByTypeID || {}).map((entry) => Number(entry) || 0),
    ...burnedPerHourByFuelType.keys(),
  ]);

  return {
    hubID: hub.hubID,
    solarSystemID: hub.solarSystemID,
    lastUpdatedMs: hub.fuelLastUpdatedMs || 0,
    fuels: [...fuelTypeIDs]
      .filter((typeID) => typeID > 0)
      .sort((left, right) => left - right)
      .map((typeID) => ({
        fuelTypeID: typeID,
        amount: Number(
          hub.fuelByTypeID &&
            hub.fuelByTypeID[String(typeID)] &&
            hub.fuelByTypeID[String(typeID)].amount,
        ) || 0,
        burnedPerHour: burnedPerHourByFuelType.get(typeID) || 0,
      })),
  };
}

const CORP_ROLE_DIRECTOR = 1n;
const CORP_ROLE_STATION_MANAGER = 2048n;

// A pilot who manages the owning corporation's structures: a Station Manager,
// Director or CEO of that corporation, the roles that set the fuel access list.
function hasHubStructureRole(session, ownerCorporationID) {
  const corporationID = normalizePositiveInteger(
    session && (session.corporationID || session.corpid),
    null,
  );
  if (!corporationID || corporationID !== normalizePositiveInteger(ownerCorporationID, null)) {
    return false;
  }
  const roleMask = getSessionCorporationRoleMask(session);
  return (roleMask & CORP_ROLE_STATION_MANAGER) !== 0n ||
    (roleMask & CORP_ROLE_DIRECTOR) !== 0n ||
    session.isCEO === true;
}

// The client opens a Hub's reagent bay only for a Station Manager of the Hub's
// corporation or for a pilot on the Hub's fuel access list, as
// openFunctions.OpenSovFuelDepositWindow shows. With no list set, the client
// does not show who else may deposit, so the Hub's alliance and corporation keep
// the access they had.
function requireHubFuelDepositAccess(hubID, identity, session) {
  const hub = getHubRecord(hubID);
  if (!hub) {
    return {
      ok: false,
      statusCode: 404,
      errorCode: "HUB_NOT_FOUND",
      hub: null,
    };
  }
  const system = ensureLoaded().table.systems[String(hub.solarSystemID)] || null;
  const fuelAccessGroupID = normalizePositiveInteger(system && system.fuelAccessGroupID, null);
  const characterID = normalizePositiveInteger(identity && identity.characterID, null);
  const allowed = hasHubStructureRole(session, hub.corporationID) || (
    fuelAccessGroupID
      ? Boolean(characterID && getGroupForCharacter(characterID, fuelAccessGroupID))
      : hasAllianceOrCorporationAccess(hub, identity)
  );
  if (!allowed) {
    return {
      ok: false,
      statusCode: 403,
      errorCode: "FORBIDDEN_REQUEST",
      hub,
    };
  }
  return {
    ok: true,
    hub,
  };
}

function addHubFuel(hubID, fuelItemID, amount, identity) {
  const access = requireHubFuelDepositAccess(
    hubID,
    identity,
    findLiveSessionByCharacterID(identity.characterID),
  );
  if (!access.ok) {
    return access;
  }
  const { depositHubFuel } = require("./sovHubFuelDeposit");
  try {
    return depositHubFuel({
      hub: access.hub, itemID: fuelItemID, amount, identity,
      session: findLiveSessionByCharacterID(identity.characterID),
      inTransferRange: (shipID) => isShipWithinHubTransferRange(
        findLiveSessionByCharacterID(identity.characterID),
        shipID,
        access.hub.hubID,
      ),
      mutateHub: (mutator) => mutateTable((table) => {
        mutator(table.hubs[String(access.hub.hubID)]);
      }),
    });
  } finally {
    cache = null;
  }
}

function seedHubFuelForInstalledUpgrades(hubID, hours = 168, identity = null) {
  let access = null;
  if (identity) {
    access = requireHubAccess(hubID, identity, true);
    if (!access.ok) {
      return access;
    }
  } else {
    const hub = getHubRecord(hubID);
    if (!hub) {
      return null;
    }
    access = {
      ok: true,
      hub,
    };
  }

  const seededHours = Math.max(1, normalizeInteger(hours, 168));
  const payloadState = buildHubUpgradePayloadState(access.hub.hubID);
  if (!payloadState) {
    return null;
  }

  const seededAmountsByFuelType = new Map();
  for (const upgrade of payloadState.upgrades || []) {
    if (!access.hub.installedUpgrades.some((installation) => installation.typeID === upgrade.typeID && installation.online)) {
      continue;
    }
    const definition = upgrade.definition || {};
    const fuelTypeID = normalizePositiveInteger(definition.fuelTypeID, null);
    if (!fuelTypeID) {
      continue;
    }
    const amountToSeed =
      Math.max(0, Number(definition.fuelStartupCost || 0)) +
      (Math.max(0, Number(definition.fuelConsumptionPerHour || 0)) * seededHours);
    seededAmountsByFuelType.set(
      fuelTypeID,
      (seededAmountsByFuelType.get(fuelTypeID) || 0) + amountToSeed,
    );
  }

  return mutateTable((table) => {
    const hub = normalizeHubRecord(table.hubs[String(access.hub.hubID)], access.hub);
    for (const [fuelTypeID, amount] of seededAmountsByFuelType.entries()) {
      const currentEntry = hub.fuelByTypeID[String(fuelTypeID)] || { amount: 0 };
      hub.fuelByTypeID[String(fuelTypeID)] = {
        amount: Math.max(
          normalizeInteger(currentEntry.amount, 0),
          Math.ceil(Math.max(0, Number(amount) || 0)),
        ),
      };
    }
    hub.fuelLastUpdatedMs = Date.now();
    table.hubs[String(hub.hubID)] = hub;
    return {
      ok: true,
      hubID: hub.hubID,
      solarSystemID: hub.solarSystemID,
      seededHours,
      fuelByTypeID: cloneValue(hub.fuelByTypeID),
    };
  });
}

function getWorkforceConfiguration(hubID, identity = null) {
  if (identity) {
    const access = requireHubAccess(hubID, identity, true);
    if (!access.ok) {
      return access;
    }
  }
  const hub = getHubRecord(hubID);
  if (!hub) {
    return null;
  }
  return {
    hubID: hub.hubID,
    solarSystemID: hub.solarSystemID,
    configuration: cloneValue(hub.workforceConfiguration),
    lastUpdatedMs: hub.workforceLastUpdatedMs || 0,
  };
}

function getWorkforceState(hubID, identity = null) {
  if (identity) {
    const access = requireHubAccess(hubID, identity, true);
    if (!access.ok) {
      return access;
    }
  }
  const stateCache = ensureLoaded();
  const hub = stateCache.hubsByID.get(normalizePositiveInteger(hubID, 0)) || null;
  if (!hub) {
    return null;
  }
  return {
    hubID: hub.hubID,
    solarSystemID: hub.solarSystemID,
    state: buildWorkforceState(
      hub.workforceConfiguration,
      hub,
      stateCache,
    ),
    lastUpdatedMs: hub.workforceLastUpdatedMs || 0,
  };
}

function configureWorkforce(hubID, configuration, identity) {
  const access = requireHubAccess(hubID, identity, true);
  if (!access.ok) {
    return access;
  }
  const normalizedConfiguration = normalizeWorkforceConfiguration(
    configuration,
    access.hub.hubID,
  );
  const previousState = getWorkforceState(access.hub.hubID);
  return mutateTable((table) => {
    const hub = normalizeHubRecord(table.hubs[String(access.hub.hubID)], access.hub);
    const previousConfiguration = cloneValue(hub.workforceConfiguration);
    hub.workforceConfiguration = normalizedConfiguration;
    hub.workforceLastUpdatedMs = Date.now();
    table.hubs[String(hub.hubID)] = hub;
    const refreshedState = buildWorkforceState(
      normalizedConfiguration,
      hub,
      ensureLoaded(),
    );
    return {
      ok: true,
      hubID: hub.hubID,
      solarSystemID: hub.solarSystemID,
      previousConfiguration,
      nextConfiguration: cloneValue(normalizedConfiguration),
      previousState: previousState ? previousState.state : null,
      nextState: refreshedState,
    };
  });
}

function listNetworkableHubs(hubID, identity = null) {
  if (identity) {
    const access = requireHubAccess(hubID, identity, true);
    if (!access.ok) {
      return access;
    }
  }
  const stateCache = ensureLoaded();
  const hub = stateCache.hubsByID.get(normalizePositiveInteger(hubID, 0)) || null;
  if (!hub) {
    return null;
  }
  const hubs = [...stateCache.hubsByID.values()]
    .filter(
      (candidate) =>
        candidate.hubID !== hub.hubID &&
        candidate.allianceID === hub.allianceID,
    )
    .sort((left, right) => left.solarSystemID - right.solarSystemID)
    .map((candidate) => ({
      hubID: candidate.hubID,
      solarSystemID: candidate.solarSystemID,
      configuration: cloneValue(candidate.workforceConfiguration),
      state: buildWorkforceState(
        candidate.workforceConfiguration,
        candidate,
        stateCache,
      ),
    }));
  return {
    hubID: hub.hubID,
    solarSystemID: hub.solarSystemID,
    hubs,
  };
}

function buildSkyhookGatewayState(skyhook) {
  skyhook = settleSkyhookHarvest(cloneValue(skyhook));
  const stateCache = ensureLoaded();
  const vulnerability = deriveSkyhookTheftVulnerability(skyhook);
  return {
    skyhookID: skyhook.skyhookID,
    solarSystemID: skyhook.solarSystemID,
    planetID: skyhook.planetID,
    corporationID: skyhook.corporationID,
    allianceID: skyhook.allianceID,
    active: skyhook.active,
    workforceAmount: skyhook.workforceAmount,
    reagentDefinitions: cloneValue(skyhook.reagentDefinitions),
    reagentSimulations: cloneValue(skyhook.reagentSimulations),
    theftVulnerability: vulnerability,
    planetResourcesVersion: cloneValue(
      stateCache.staticSnapshot.planetDefinitionsVersion,
    ),
  };
}

function getSkyhook(skyhookID, identity) {
  const access = requireSkyhookAccess(skyhookID, identity, {
    allowLocalSystem: true,
    requireOwnership: true,
  });
  if (!access.ok) {
    return access;
  }
  return {
    ok: true,
    skyhook: buildSkyhookGatewayState(access.skyhook),
  };
}

function listLocalSkyhooks(identity) {
  const solarSystemID = normalizePositiveInteger(identity && identity.solarSystemID, 0);
  return {
    solarSystemID,
    skyhooks: cloneValue(
      (ensureLoaded().skyhooksBySolarSystemID.get(solarSystemID) || []).map(
        buildSkyhookGatewayState,
      ),
    ),
  };
}

function listSkyhooksByCorporation(corporationID, identity) {
  const numericCorporationID = normalizePositiveInteger(corporationID, null);
  if (!numericCorporationID) {
    return {
      ok: false,
      statusCode: 404,
      errorCode: "NOT_FOUND",
    };
  }
  if (numericCorporationID !== normalizePositiveInteger(identity && identity.corporationID, 0)) {
    return {
      ok: false,
      statusCode: 403,
      errorCode: "FORBIDDEN_REQUEST",
    };
  }
  return {
    ok: true,
    corporationID: numericCorporationID,
    skyhooks: cloneValue(
      (ensureLoaded().skyhooksByCorporationID.get(numericCorporationID) || []).map(
        buildSkyhookGatewayState,
      ),
    ),
  };
}

function setSkyhookActivation(skyhookID, active, identity) {
  const access = requireSkyhookAccess(skyhookID, identity);
  if (!access.ok) {
    return access;
  }
  // The client exposes online-state changes only to the owning corporation's
  // Station Managers. Alliance membership alone grants no configuration right.
  const { getPersistedCorporationAuthority, corporationAuthorityHasRole } =
    require("../corporation/corporationAuthority");
  const authority = getPersistedCorporationAuthority(
    findLiveSessionByCharacterID(identity && identity.characterID),
  );
  if (!authority ||
      Number(authority.corporationID) !== Number(access.skyhook.corporationID) ||
      !corporationAuthorityHasRole(authority, CORP_ROLE_STATION_MANAGER)) {
    return { ok: false, statusCode: 403, errorCode: "FORBIDDEN_REQUEST" };
  }
  // Retail has refused switching off reagent skyhooks, on lava and ice planets,
  // since the 2024-10-01 patch. The client shows this 403 as its
  // forbidden-offline notice.
  if (!active && (access.skyhook.reagentDefinitions || []).length > 0) {
    return { ok: false, statusCode: 403, errorCode: "FORBIDDEN_REQUEST" };
  }
  return mutateTable((table) => {
    const skyhook = normalizeSkyhookRecord(
      table.skyhooks[String(access.skyhook.skyhookID)],
      access.skyhook,
    );
    if (skyhook.deployedItem && active && !PRODUCTIVE_ORBITAL_STATES.has(skyhook.orbitalState)) {
      return { ok: false, statusCode: 403, errorCode: "FORBIDDEN_REQUEST" };
    }
    settleSkyhookHarvest(skyhook);
    if (skyhook.active !== Boolean(active)) {
      for (const simulation of skyhook.reagentSimulations) simulation.lastCycleMs = Date.now();
    }
    skyhook.active = Boolean(active);
    skyhook.lastUpdatedMs = Date.now();
    table.skyhooks[String(skyhook.skyhookID)] = skyhook;
    return {
      ok: true,
      skyhookID: skyhook.skyhookID,
      solarSystemID: skyhook.solarSystemID,
      planetID: skyhook.planetID,
      skyhook: buildSkyhookGatewayState(skyhook),
    };
  });
}

function listSolarSystemsWithTheftVulnerableSkyhooks() {
  return [...ensureLoaded().vulnerableSkyhooksBySolarSystemID.keys()].sort(
    (left, right) => left - right,
  );
}

function listTheftVulnerableSkyhooksInSolarSystem(solarSystemID) {
  return cloneValue(
    ensureLoaded().vulnerableSkyhooksBySolarSystemID.get(
      normalizePositiveInteger(solarSystemID, 0),
    ) || [],
  );
}

function modifySkyhookReagents(skyhookID, reagentStates, identity) {
  const access = requireSkyhookAccess(skyhookID, identity, {
    requireOwnership: true,
  });
  if (!access.ok) {
    return access;
  }
  if (access.skyhook.raid && access.skyhook.raid.pendingSettlement) {
    return { ok: false, statusCode: 409, errorCode: "SKYHOOK_RAID_SETTLEMENT_PENDING" };
  }
  return mutateTable((table) => {
    const skyhook = normalizeSkyhookRecord(
      table.skyhooks[String(access.skyhook.skyhookID)],
      access.skyhook,
    );
    for (const reagentState of reagentStates || []) {
      const reagentTypeID = normalizePositiveInteger(reagentState.reagentTypeID, null);
      if (!reagentTypeID) {
        continue;
      }
      const existingIndex = skyhook.reagentSimulations.findIndex(
        (entry) => entry.reagentTypeID === reagentTypeID,
      );
      const updatedEntry = {
        reagentTypeID,
        securedStock: Math.max(0, normalizeInteger(reagentState.securedStock, 0)),
        unsecuredStock: Math.max(
          0,
          normalizeInteger(reagentState.unsecuredStock, 0),
        ),
        lastCycleMs: normalizeTimestampMs(
          reagentState.timestampMs,
          Date.now(),
        ),
      };
      if (existingIndex >= 0) {
        skyhook.reagentSimulations[existingIndex] = updatedEntry;
      } else {
        skyhook.reagentSimulations.push(updatedEntry);
      }
    }
    skyhook.reagentSimulations.sort(
      (left, right) => left.reagentTypeID - right.reagentTypeID,
    );
    skyhook.lastUpdatedMs = Date.now();
    table.skyhooks[String(skyhook.skyhookID)] = skyhook;
    return {
      ok: true,
      skyhookID: skyhook.skyhookID,
      solarSystemID: skyhook.solarSystemID,
      planetID: skyhook.planetID,
      skyhook: buildSkyhookGatewayState(skyhook),
    };
  });
}

function getFuelAccessGroupID(solarSystemID) {
  const table = readSovereigntyTable();
  const system = table.systems[String(normalizePositiveInteger(solarSystemID, 0))] || null;
  return normalizePositiveInteger(system && system.fuelAccessGroupID, null);
}

function setFuelAccessGroupID(solarSystemID, fuelAccessGroupID) {
  const numericSolarSystemID = normalizePositiveInteger(solarSystemID, null);
  if (!numericSolarSystemID) {
    return null;
  }
  const normalizedGroupID = normalizePositiveInteger(fuelAccessGroupID, null);
  const result = mutateTable((table) => {
    const systemKey = String(numericSolarSystemID);
    const currentSystem = table.systems[systemKey] || {
      solarSystemID: numericSolarSystemID,
    };
    table.systems[systemKey] = {
      ...currentSystem,
      fuelAccessGroupID: normalizedGroupID,
    };
    return {
      ok: true,
    };
  });
  return result && result.ok ? normalizedGroupID : null;
}

function isOnLocalFuelAccessGroup(session) {
  const solarSystemID = normalizePositiveInteger(
    session && (session.solarsystemid2 || session.solarsystemid),
    0,
  );
  const fuelAccessGroupID = getFuelAccessGroupID(solarSystemID);
  if (!fuelAccessGroupID) {
    return true;
  }
  const characterID = normalizePositiveInteger(
    session && (session.characterID || session.charID || session.charid),
    0,
  );
  // A configured fuel list is an actual access group, not an ownership
  // shortcut. Reuse the bookmark runtime's character/corporation/alliance
  // resolver so the same selected list governs this client-facing check.
  return Boolean(characterID && getGroupForCharacter(characterID, fuelAccessGroupID));
}

function resetSovereigntyModernStateForTests() {
  cache = null;
  fuelPersistencePending = false;
  fuelPlansPendingPublication = [];
}

function invalidateSovereigntyModernStateCache() {
  cache = null;
}

function getPendingSkyhookExtraction(skyhookID) {
  const skyhook = ensureLoaded().skyhooksByID.get(Number(skyhookID));
  return skyhook && skyhook.pendingExtraction ? cloneValue(skyhook.pendingExtraction) : null;
}

// Raid commands share the existing stock authority, including tombstones whose
// prepared loot must finish after the parent is destroyed or replaced.
function listRaidSkyhooks() {
  ensureLoaded();
  return Object.values(database.read("sovereignty", "/skyhooks").data || {})
    .filter((record) => record.deployedItem === true).map(cloneValue);
}

function getRaidSkyhook(skyhookID) {
  ensureLoaded();
  const record = database.read("sovereignty", `/skyhooks/${Number(skyhookID)}`).data;
  return record && record.deployedItem === true ? cloneValue(record) : null;
}

function mutateSkyhookRaid(skyhookID, mutation) {
  let result;
  let previous;
  mutateTable((table) => {
    const record = table.skyhooks[String(skyhookID)];
    if (!record || !record.deployedItem) throw new Error("SKYHOOK_NOT_FOUND");
    previous = cloneValue(record);
    result = mutation(record);
  });
  const flushed = database.flushTableSync("sovereignty");
  if (!flushed.success) {
    mutateTable((table) => { table.skyhooks[String(skyhookID)] = previous; });
    throw new Error("SKYHOOK_RAID_NOT_DURABLE");
  }
  return result;
}

// Settles a reservation whose grant outcome is known. returnStock puts the
// reserved units back in the secure bay when the grant never happened.
function releaseSkyhookExtraction(skyhookID, receiptKey, options = {}) {
  let released = false;
  mutateTable((table) => {
    const skyhook = table.skyhooks[String(skyhookID)];
    const pending = skyhook && skyhook.pendingExtraction;
    if (!pending || pending.receiptKey !== receiptKey) {
      return;
    }
    if (options.returnStock === true) {
      settleSkyhookHarvest(skyhook);
      const simulation = (skyhook.reagentSimulations || [])
        .find((entry) => entry.reagentTypeID === pending.typeID);
      const definition = (skyhook.reagentDefinitions || [])
        .find((entry) => entry.reagentTypeID === pending.typeID);
      if (simulation) {
        simulation.securedStock = Math.min(
          definition ? Number(definition.securedCapacity) : Infinity,
          simulation.securedStock + pending.quantity,
        );
      }
    }
    skyhook.pendingExtraction = null;
    released = true;
  });
  if (released && !database.flushTableSync("sovereignty").success) {
    throw new Error("SKYHOOK_RELEASE_NOT_DURABLE");
  }
  return released;
}

// Reserve stock durably before the inventory grant, so a crash between the two
// can be settled later from the grant receipt. A grant that reports nothing
// written returns the stock at once; an unknown outcome leaves the reservation
// for the next extraction to settle.
function extractSkyhookReagents(skyhookID, quantity, destination, deliver) {
  const current = ensureLoaded().skyhooksByID.get(Number(skyhookID));
  if (!current || !current.active) throw new Error("SKYHOOK_NOT_ACTIVE");
  if (current.pendingExtraction) throw new Error("SKYHOOK_EXTRACTION_PENDING");
  if (current.raid && (current.raid.activeLink || current.raid.pendingSettlement)) {
    throw new Error("SKYHOOK_RAID_IN_PROGRESS");
  }
  if (!Number.isSafeInteger(quantity) || quantity <= 0) throw new Error("INVALID_QUANTITY");
  let pending = null;
  mutateTable((table) => {
    const skyhook = settleSkyhookHarvest(table.skyhooks[String(skyhookID)]);
    const simulation = skyhook.reagentSimulations[0];
    if (!simulation || quantity > simulation.securedStock) throw new Error("INSUFFICIENT_REAGENTS");
    pending = {
      ...destination, quantity, typeID: simulation.reagentTypeID,
      receiptKey: `skyhook:${skyhookID}:${require("node:crypto").randomUUID()}`,
    };
    simulation.securedStock -= quantity;
    skyhook.pendingExtraction = pending;
  });
  const reserved = database.flushTableSync("sovereignty");
  if (!reserved.success) throw new Error("SKYHOOK_RESERVATION_NOT_DURABLE");
  const granted = deliver(pending);
  if (!granted || !granted.success) {
    if (granted && granted.ambiguous === false) {
      releaseSkyhookExtraction(skyhookID, pending.receiptKey, { returnStock: true });
    }
    throw new Error(granted && granted.errorMsg || "SKYHOOK_GRANT_FAILED");
  }
  releaseSkyhookExtraction(skyhookID, pending.receiptKey);
  return { quantity, granted, skyhook: buildSkyhookGatewayState(ensureLoaded().skyhooksByID.get(Number(skyhookID))) };
}

module.exports = {
  settleAllHubFuel,
  getHubFuelNextDueAtMs,
  registerHubFuelSchedulePublisher(publisher) { fuelSchedulePublisher = publisher; },
  registerHubStateNoticePublisher(publisher) { hubStateNoticePublisher = publisher; },
  listRaidSkyhooks,
  getRaidSkyhook,
  mutateSkyhookRaid,
  getPendingSkyhookExtraction,
  releaseSkyhookExtraction,
  extractSkyhookReagents,
  POWER_STATE,
  addHubFuel,
  configureWorkforce,
  getActiveCharacterIdentity,
  getFuelAccessGroupID,
  getHubFuel,
  getHubIDForSolarSystem,
  getHubResources,
  getHubUpgrades,
  getHubUpgradesPendingPersistence,
  getSkyhook,
  getWorkforceConfiguration,
  getWorkforceState,
  isOnLocalFuelAccessGroup,
  listLocalSkyhooks,
  listNetworkableHubs,
  listSkyhooksByCorporation,
  listSolarSystemsWithTheftVulnerableSkyhooks,
  listTheftVulnerableSkyhooksInSolarSystem,
  listUpgradeDefinitions,
  modifySkyhookReagents,
  processHubUpgradeConfiguration,
  resetSovereigntyModernStateForTests,
  invalidateSovereigntyModernStateCache,
  seedHubFuelForInstalledUpgrades,
  setHubUpgradeInstallations,
  setFuelAccessGroupID,
  setSkyhookActivation,
  uninstallHubUpgrade,
};
