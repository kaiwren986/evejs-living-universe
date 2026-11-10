"use strict";

const path = require("path");

const spaceRuntime = require(path.join(__dirname, "../../space/runtime"));
const {
  ITEM_FLAGS,
  grantItemToOwnerLocation,
  listContainerItems,
} = require(path.join(__dirname, "../inventory/itemStore"));
const { getFlexFuelProfile } = require("../structure/structureFlexFuelRuntime");
const structureState = require(path.join(
  __dirname,
  "../structure/structureState",
));
const {
  STRUCTURE_SERVICE_ID,
  STRUCTURE_SERVICE_STATE,
  STRUCTURE_UPKEEP_STATE,
} = require(path.join(__dirname, "../structure/structureConstants"));
const {
  buildAnchorLayout,
  cloneSpacePoint,
  normalizePositiveInteger,
} = require(path.join(__dirname, "./sovAnchorLayout"));
const {
  getStructurePositionsForSystem,
} = require(path.join(__dirname, "./sovAutoNavigation"));
const {
  POWER_STATE,
  getHubIDForSolarSystem,
  getHubUpgrades,
  seedHubFuelForInstalledUpgrades,
  setHubUpgradeInstallations,
} = require(path.join(__dirname, "./sovModernState"));
const {
  getSystemState,
} = require(path.join(__dirname, "./sovState"));
const {
  TYPE_ANSIBLEX_JUMP_BRIDGE,
  TYPE_ADVANCED_LOGISTICS_NETWORK_UPGRADE,
  TYPE_CYNO_NAVIGATION_UPGRADE,
  TYPE_CYNO_SUPPRESSION_UPGRADE,
  TYPE_PHAROLUX_CYNO_BEACON,
  TYPE_TENEBREX_CYNO_JAMMER,
} = require(path.join(__dirname, "./sovUpgradeSupport"));

const TYPE_LIQUID_OZONE = 16273;
const TYPE_NITROGEN_FUEL_BLOCK = 4051;
const DEFAULT_SOV_FLEX_FUEL_HOURS = 168;
const HOUR_MS = 60 * 60 * 1000;
const FLEX_DEPLOY_FAST_FORWARD_SHORT_SECONDS = 901;
const FLEX_DEPLOY_FAST_FORWARD_LONG_SECONDS = 86_401;

const FLEX_DEFINITION_BY_KIND = Object.freeze({
  pharolux: Object.freeze({
    kind: "pharolux",
    label: "Pharolux Cyno Beacon",
    typeID: TYPE_PHAROLUX_CYNO_BEACON,
    serviceID: STRUCTURE_SERVICE_ID.CYNO_BEACON,
    requiredUpgradeTypeID: TYPE_CYNO_NAVIGATION_UPGRADE,
    offset: Object.freeze({ x: 650_000, y: 0, z: -650_000 }),
  }),
  ansiblex: Object.freeze({
    kind: "ansiblex",
    label: "Ansiblex Jump Bridge",
    typeID: TYPE_ANSIBLEX_JUMP_BRIDGE,
    serviceID: STRUCTURE_SERVICE_ID.JUMP_BRIDGE,
    requiredUpgradeTypeID: TYPE_ADVANCED_LOGISTICS_NETWORK_UPGRADE,
    offset: Object.freeze({ x: -650_000, y: 0, z: -650_000 }),
  }),
  tenebrex: Object.freeze({
    kind: "tenebrex",
    label: "Tenebrex Cyno Jammer",
    typeID: TYPE_TENEBREX_CYNO_JAMMER,
    serviceID: STRUCTURE_SERVICE_ID.CYNO_JAMMER,
    requiredUpgradeTypeID: TYPE_CYNO_SUPPRESSION_UPGRADE,
    offset: Object.freeze({ x: 0, y: 0, z: 650_000 }),
  }),
});

const FLEX_KIND_ORDER = Object.freeze(["pharolux", "ansiblex", "tenebrex"]);
const FLEX_TYPE_IDS = new Set(
  FLEX_KIND_ORDER.map((kind) => FLEX_DEFINITION_BY_KIND[kind].typeID),
);
const FLEX_MAX_PER_SOLAR_SYSTEM_BY_KIND = Object.freeze({
  pharolux: 1,
  ansiblex: 1,
  tenebrex: 3,
});

function normalizeInteger(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.trunc(numeric);
}

function clonePoint(value, fallback = null) {
  const point = cloneSpacePoint(value, fallback);
  return point ? { ...point } : fallback;
}

function addPoint(left, right) {
  const leftPoint = clonePoint(left, null);
  const rightPoint = clonePoint(right, null);
  if (!leftPoint || !rightPoint) {
    return null;
  }
  return {
    x: leftPoint.x + rightPoint.x,
    y: leftPoint.y + rightPoint.y,
    z: leftPoint.z + rightPoint.z,
  };
}

function normalizeSovereigntyFlexKind(token) {
  const normalized = String(token || "").trim().toLowerCase();
  if (!normalized || normalized === "all" || normalized === "flex" || normalized === "flexes") {
    return "all";
  }
  if (normalized === "beacon") {
    return "pharolux";
  }
  if (normalized === "bridge" || normalized === "jumpbridge") {
    return "ansiblex";
  }
  if (normalized === "jammer") {
    return "tenebrex";
  }
  return Object.prototype.hasOwnProperty.call(FLEX_DEFINITION_BY_KIND, normalized)
    ? normalized
    : null;
}

function getSovereigntyFlexDefinitions(kind = "all") {
  const normalizedKind = normalizeSovereigntyFlexKind(kind);
  if (!normalizedKind) {
    return [];
  }
  if (normalizedKind === "all") {
    return FLEX_KIND_ORDER.map((entry) => FLEX_DEFINITION_BY_KIND[entry]);
  }
  return [FLEX_DEFINITION_BY_KIND[normalizedKind]];
}

function listSovereigntyFlexStructuresForSystem(solarSystemID, options = {}) {
  const numericSolarSystemID = normalizePositiveInteger(solarSystemID, null);
  if (!numericSolarSystemID) {
    return [];
  }
  const includeDestroyed = options.includeDestroyed === true;
  return structureState.listStructuresForSystem(numericSolarSystemID, {
    includeDestroyed,
    refresh: false,
  }).filter((structure) =>
    FLEX_TYPE_IDS.has(normalizePositiveInteger(structure && structure.typeID, 0)));
}

function listFlexStructuresByKind(solarSystemID, kind, options = {}) {
  const definition = FLEX_DEFINITION_BY_KIND[String(kind || "").trim().toLowerCase()] || null;
  if (!definition) {
    return [];
  }
  return listSovereigntyFlexStructuresForSystem(solarSystemID, options)
    .filter(
      (structure) =>
        normalizePositiveInteger(structure && structure.typeID, 0) === definition.typeID,
    )
    .sort((left, right) =>
      normalizePositiveInteger(left && left.structureID, 0) -
        normalizePositiveInteger(right && right.structureID, 0));
}

function getFlexStructureByKind(solarSystemID, kind) {
  return listFlexStructuresByKind(solarSystemID, kind)[0] || null;
}

function buildFlexPosition(solarSystemID, definition) {
  const currentPositions = getStructurePositionsForSystem(solarSystemID);
  const basePoint = clonePoint(currentPositions.positionsByKind.ihub, null);
  if (basePoint) {
    return addPoint(basePoint, definition.offset);
  }
  return addPoint(
    buildAnchorLayout(solarSystemID).primaryPoint,
    definition.offset,
  );
}

function normalizePoint(value, fallback = null) {
  if (!value || typeof value !== "object") {
    return fallback;
  }
  const x = Number(value.x);
  const y = Number(value.y);
  const z = Number(value.z);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
    return fallback;
  }
  return { x, y, z };
}

function getJumpBridgeDestinationSolarSystemID(structure) {
  const devFlags =
    structure && structure.devFlags && typeof structure.devFlags === "object"
      ? structure.devFlags
      : {};
  return normalizePositiveInteger(
    devFlags.destinationSolarsystemID ||
    devFlags.sovereigntyJumpBridgeDestinationSolarsystemID,
    null,
  );
}

function syncStructureRuntime(structureOrSystemID) {
  const solarSystemID =
    typeof structureOrSystemID === "object" && structureOrSystemID !== null
      ? normalizePositiveInteger(structureOrSystemID.solarSystemID, 0)
      : normalizePositiveInteger(structureOrSystemID, 0);
  if (!solarSystemID) {
    return;
  }
  if (typeof spaceRuntime.syncStructureSceneState === "function") {
    spaceRuntime.syncStructureSceneState(solarSystemID);
  }
}

function advanceStructureTimers(structureID, seconds) {
  const result = structureState.fastForwardStructure(structureID, seconds);
  if (!result.success) {
    return result;
  }
  structureState.tickStructures(Date.now());
  const structure = structureState.getStructureByID(structureID, { refresh: false });
  syncStructureRuntime(structure || result.data);
  return {
    success: true,
    data: structure || result.data,
  };
}

function seedSovereigntyFlexFuel(structureID, hours = DEFAULT_SOV_FLEX_FUEL_HOURS) {
  const structure = structureState.getStructureByID(structureID, { refresh: false });
  if (!structure) {
    return {
      success: false,
      errorMsg: "STRUCTURE_NOT_FOUND",
    };
  }
  const definition = getSovereigntyFlexDefinitions().find(
    (entry) => entry.typeID === normalizePositiveInteger(structure.typeID, 0),
  );
  if (!definition) {
    return {
      success: false,
      errorMsg: "SOV_FLEX_TYPE_NOT_FOUND",
    };
  }
  const fuelProfile = getFlexFuelProfile(definition.typeID);
  const seededHours = Math.max(1, normalizeInteger(hours, DEFAULT_SOV_FLEX_FUEL_HOURS));
  const liquidOzoneQty = Math.ceil(
    Math.max(Number(structure.liquidOzoneQty) || 0,
      Math.max(0, fuelProfile.onlineAmount) +
      (Math.max(0, fuelProfile.hourlyAmount) * seededHours)),
  );
  // The deployment helper already bypasses the startup charge when it enables
  // the service. Seed its hourly fuel as real blocks in the shared fuel bay;
  // Ozone is separate jump fuel and cannot keep the service online.
  const fuelBlockQty = Math.ceil(Math.max(0, fuelProfile.hourlyAmount) * seededHours);
  const fuelQuantities = new Map();
  for (const [typeID, targetQuantity] of [
    [TYPE_NITROGEN_FUEL_BLOCK, fuelBlockQty],
    [TYPE_LIQUID_OZONE, liquidOzoneQty],
  ]) {
    const currentQuantity = listContainerItems(null, structureID, ITEM_FLAGS.STRUCTURE_FUEL_BAY)
      .filter((item) => Number(item.typeID) === typeID)
      .reduce((sum, item) => sum + Number(item.stacksize || item.quantity || 0), 0);
    if (currentQuantity < targetQuantity) {
      const grant = grantItemToOwnerLocation(
        structure.ownerCorpID || structure.ownerID, structureID,
        ITEM_FLAGS.STRUCTURE_FUEL_BAY, typeID, targetQuantity - currentQuantity,
      );
      if (!grant.success) return grant;
    }
    fuelQuantities.set(typeID, Math.max(currentQuantity, targetQuantity));
  }
  const fuelExpiresAt = Date.now() + (seededHours * HOUR_MS);
  const updateResult = structureState.updateStructureRecord(structureID, (current) => ({
    ...current,
    upkeepState: STRUCTURE_UPKEEP_STATE.FULL_POWER,
    fuelExpiresAt,
    liquidOzoneQty: fuelQuantities.get(TYPE_LIQUID_OZONE),
  }));
  if (!updateResult.success) {
    return updateResult;
  }
  syncStructureRuntime(updateResult.data);
  return {
    success: true,
    data: {
      ...updateResult.data,
      fuelTypeID: TYPE_NITROGEN_FUEL_BLOCK,
      fuelHours: seededHours,
      fuelBlockQty: fuelQuantities.get(TYPE_NITROGEN_FUEL_BLOCK),
      liquidOzoneQty: fuelQuantities.get(TYPE_LIQUID_OZONE),
      fuelExpiresAt,
    },
  };
}

function ensureFlexUpgradeOnline(solarSystemID, definition, identity, fuelHours) {
  const hubID = normalizePositiveInteger(getHubIDForSolarSystem(solarSystemID), null);
  if (!hubID) {
    return {
      success: false,
      errorMsg: "HUB_NOT_FOUND",
    };
  }
  // The Hub's allocation includes workforce imports, upgrade production, and
  // saved priority. Static local capacity cannot decide whether a FLEX fits.
  const upgradeResult = setHubUpgradeInstallations(
    hubID,
    [{ typeID: definition.requiredUpgradeTypeID, online: true }],
    identity,
  );
  if (!upgradeResult.ok) {
    return {
      success: false,
      errorMsg: upgradeResult.errorCode || "HUB_UPGRADE_CONFIGURATION_FAILED",
    };
  }
  const seedFuelResult = seedHubFuelForInstalledUpgrades(hubID, fuelHours, identity);
  if (!seedFuelResult || !seedFuelResult.ok) {
    return { success: false, errorMsg: seedFuelResult?.errorCode || "HUB_FUEL_SEED_FAILED" };
  }
  const upgradeSnapshot = getHubUpgrades(hubID, identity);
  const requiredUpgrade =
    upgradeSnapshot &&
    Array.isArray(upgradeSnapshot.upgrades)
      ? upgradeSnapshot.upgrades.find(
        (entry) => Number(entry && entry.typeID) === definition.requiredUpgradeTypeID,
      ) || null
      : null;
  if (
    !requiredUpgrade ||
    Number(requiredUpgrade.powerState) !== POWER_STATE.POWER_STATE_ONLINE
  ) {
    return {
      success: false,
      errorMsg: "REQUIRED_HUB_UPGRADE_NOT_ONLINE",
    };
  }
  return {
    success: true,
    data: {
      hubID,
      requiredUpgrade,
      hubFuel: seedFuelResult && seedFuelResult.ok ? seedFuelResult : null,
    },
  };
}

function deploySovereigntyFlexStructure(session, kind, options = {}) {
  const definition = getSovereigntyFlexDefinitions(kind)[0] || null;
  if (!definition) {
    return {
      success: false,
      errorMsg: "SOV_FLEX_KIND_NOT_FOUND",
    };
  }

  const solarSystemID = normalizePositiveInteger(
    options.solarSystemID || (session && (session.solarsystemid2 || session.solarsystemid)),
    null,
  );
  if (!solarSystemID) {
    return {
      success: false,
      errorMsg: "SOLAR_SYSTEM_REQUIRED",
    };
  }

  const system = getSystemState(solarSystemID) || null;
  const allianceID = normalizePositiveInteger(
    options.allianceID || (system && system.allianceID) || (session && (session.allianceID || session.allianceid)),
    null,
  );
  const corporationID = normalizePositiveInteger(
    options.ownerCorpID || options.corporationID || (system && system.corporationID) || (session && (session.corporationID || session.corpid)),
    null,
  );
  if (
    !system ||
    !normalizePositiveInteger(system.infrastructureHubID, null) ||
    !normalizePositiveInteger(system.allianceID, null)
  ) {
    return {
      success: false,
      errorMsg: "SOV_HUB_REQUIRED",
    };
  }
  if (!allianceID || !corporationID) {
    return {
      success: false,
      errorMsg: "TARGET_OWNER_REQUIRED",
    };
  }

  const existingStructures = listFlexStructuresByKind(solarSystemID, definition.kind);
  const existing = existingStructures[0] || null;
  const maxPerSolarSystem =
    FLEX_MAX_PER_SOLAR_SYSTEM_BY_KIND[definition.kind] || 1;
  if (
    options.reuseExisting !== true &&
    existingStructures.length >= maxPerSolarSystem
  ) {
    return {
      success: false,
      errorMsg: "STRUCTURE_SYSTEM_CAP_REACHED",
      data: {
        structure: existing,
        count: existingStructures.length,
        limit: maxPerSolarSystem,
        typeID: definition.typeID,
      },
    };
  }

  const identity = {
    characterID: normalizePositiveInteger(
      session && (session.characterID || session.charid || session.userid),
      0,
    ) || 0,
    solarSystemID,
    allianceID,
    corporationID,
  };
  const fuelHours = Math.max(
    1,
    normalizeInteger(options.fuelHours, DEFAULT_SOV_FLEX_FUEL_HOURS),
  );
  const upgradeResult = ensureFlexUpgradeOnline(
    solarSystemID,
    definition,
    identity,
    fuelHours,
  );
  if (!upgradeResult.success) {
    return upgradeResult;
  }

  if (existing && options.reuseExisting === true) {
    const refuelResult = seedSovereigntyFlexFuel(existing.structureID, fuelHours);
    return refuelResult.success
      ? {
        success: true,
        data: {
          structure: refuelResult.data,
          created: false,
          definition,
          hubID: upgradeResult.data.hubID,
          requiredUpgrade: upgradeResult.data.requiredUpgrade,
        },
      }
      : refuelResult;
  }

  const seedResult = structureState.seedStructureForSession(
    session || {},
    definition.typeID,
    {
      solarSystemID,
      ownerCorpID: corporationID,
      allianceID,
      position: normalizePoint(
        options.position,
        buildFlexPosition(solarSystemID, definition),
      ),
      name: options.name || definition.label,
      itemName: options.name || definition.label,
      profileID: options.profileID,
      reinforceWeekday: options.reinforceWeekday,
      reinforceHour: options.reinforceHour,
      devFlags: {
        sovereigntyFlex: true,
        sovereigntyFlexKind: definition.kind,
        ...(normalizePositiveInteger(options.destinationSolarsystemID, null)
          ? {
            destinationSolarsystemID: normalizePositiveInteger(options.destinationSolarsystemID, null),
            sovereigntyJumpBridgeDestinationSolarsystemID: normalizePositiveInteger(options.destinationSolarsystemID, null),
          }
          : {}),
        ...(options.devFlags || {}),
      },
    },
  );
  if (!seedResult.success) {
    return seedResult;
  }
  syncStructureRuntime(seedResult.data);

  const structureID = seedResult.data.structureID;
  const anchorResult = structureState.startAnchoring(structureID);
  if (!anchorResult.success) {
    return anchorResult;
  }
  syncStructureRuntime(anchorResult.data);

  const fastForwardShortResult = advanceStructureTimers(
    structureID,
    FLEX_DEPLOY_FAST_FORWARD_SHORT_SECONDS,
  );
  if (!fastForwardShortResult.success) {
    return fastForwardShortResult;
  }

  const fastForwardLongResult = advanceStructureTimers(
    structureID,
    FLEX_DEPLOY_FAST_FORWARD_LONG_SECONDS,
  );
  if (!fastForwardLongResult.success) {
    return fastForwardLongResult;
  }

  const coreResult = structureState.setStructureQuantumCoreInstalled(structureID, true);
  if (!coreResult.success) {
    return coreResult;
  }
  syncStructureRuntime(coreResult.data);

  const serviceResult = structureState.setStructureServiceState(
    structureID,
    definition.serviceID,
    STRUCTURE_SERVICE_STATE.ONLINE,
    { consumeFlexOnlineFuel: false },
  );
  if (!serviceResult.success) {
    if (
      definition.kind !== "tenebrex" ||
      serviceResult.errorMsg !== "STRUCTURE_CYNO_JAMMER_ALREADY_ONLINE"
    ) {
      return serviceResult;
    }
    const offlineStructure = structureState.getStructureByID(structureID, {
      refresh: false,
    });
    syncStructureRuntime(offlineStructure || coreResult.data);
    return {
      success: true,
      data: {
        structure: offlineStructure || coreResult.data,
        created: true,
        serviceOnline: false,
        serviceOnlineSkippedReason: serviceResult.errorMsg,
        definition,
        hubID: upgradeResult.data.hubID,
        requiredUpgrade: upgradeResult.data.requiredUpgrade,
      },
    };
  }
  syncStructureRuntime(serviceResult.data);

  const serviceFastForwardResult = advanceStructureTimers(
    structureID,
    FLEX_DEPLOY_FAST_FORWARD_SHORT_SECONDS,
  );
  if (!serviceFastForwardResult.success) {
    return serviceFastForwardResult;
  }

  const fuelResult = seedSovereigntyFlexFuel(structureID, fuelHours);
  if (!fuelResult.success) {
    return fuelResult;
  }

  return {
    success: true,
    data: {
      structure: fuelResult.data,
      created: true,
      serviceOnline: true,
      definition,
      hubID: upgradeResult.data.hubID,
      requiredUpgrade: upgradeResult.data.requiredUpgrade,
    },
  };
}

module.exports = {
  DEFAULT_SOV_FLEX_FUEL_HOURS,
  FLEX_MAX_PER_SOLAR_SYSTEM_BY_KIND,
  TYPE_LIQUID_OZONE,
  deploySovereigntyFlexStructure,
  listFlexStructuresByKind,
  getFlexStructureByKind,
  getJumpBridgeDestinationSolarSystemID,
  getSovereigntyFlexDefinitions,
  listSovereigntyFlexStructuresForSystem,
  normalizeSovereigntyFlexKind,
  seedSovereigntyFlexFuel,
};
