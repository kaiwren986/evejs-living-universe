"use strict";

// Living Universe port: the spawn-time edits the mod made inside
// nativeNpcService.js (0.12.6), gathered here so the stock file only calls in.
// Identity overrides (a pilot's corporation, alliance and faction on its hull),
// doctrine governance fields on the entity record, and the pilot skill map and
// drone bay on the live entity.

const path = require("path");

const {
  validateGovernedNpcDefinition,
} = require(path.join(__dirname, "./npcDoctrineGovernance"));
const {
  resolveIndustrialCrewRegionalDefense,
} = require(path.join(__dirname, "./industrialCrewDoctrineCatalog"));

function toPositiveInt(value, fallback = 0) {
  const numeric = Math.trunc(Number(value) || 0);
  return numeric > 0 ? numeric : fallback;
}

function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function toOptionalNonNegativeInt(value) {
  if (value === null || value === undefined || value === "") {
    return undefined;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return undefined;
  }
  const normalized = Math.trunc(numeric);
  return normalized >= 0 ? normalized : undefined;
}

function resolveIndexedNonNegativeIDOverride(
  options,
  singularKey,
  pluralKey,
  index,
) {
  const indexedValues = Array.isArray(options && options[pluralKey])
    ? options[pluralKey]
    : null;
  if (indexedValues && index < indexedValues.length) {
    const indexedOverride = toOptionalNonNegativeInt(indexedValues[index]);
    if (indexedOverride !== undefined) {
      return indexedOverride;
    }
  }
  return toOptionalNonNegativeInt(options && options[singularKey]);
}

// The per-hull form of the batch options: ownerIDOverrides[index] and so on
// become the singular options spawnNativeNpcEntityInContext reads.
function resolveIndexedSpawnOptions(options = {}, index = 0) {
  const pick = (key) => (Array.isArray(options[key]) ? options[key][index] : null);
  const indexedSpawnStateOverride = pick("spawnStateOverrides");
  const indexedCargoOverride = Array.isArray(options.cargoOverrides)
    ? options.cargoOverrides[index]
    : undefined;
  return {
    ownerIDOverride: toPositiveInt(
      pick("ownerIDOverrides"),
      toPositiveInt(options.ownerIDOverride, 0),
    ),
    corporationIDOverride: toPositiveInt(
      pick("corporationIDOverrides"),
      toPositiveInt(options.corporationIDOverride, 0),
    ),
    allianceIDOverride: resolveIndexedNonNegativeIDOverride(
      options,
      "allianceIDOverride",
      "allianceIDOverrides",
      index,
    ),
    warFactionIDOverride: resolveIndexedNonNegativeIDOverride(
      options,
      "warFactionIDOverride",
      "warFactionIDOverrides",
      index,
    ),
    nameIDOverride: toPositiveInt(
      pick("nameIDOverrides"),
      toPositiveInt(options.nameIDOverride ?? options.nameID, 0),
    ),
    cargoOverride: Array.isArray(indexedCargoOverride)
      ? indexedCargoOverride
      : options.cargoOverride,
    spawnStateOverride:
      indexedSpawnStateOverride && typeof indexedSpawnStateOverride === "object"
        ? indexedSpawnStateOverride
        : options.spawnStateOverride,
  };
}

function resolveDefenseProfileForSystem(systemID, options = {}) {
  const explicit = String(
    options.defenseDamageProfile ||
      options.hostileFactionKey ||
      options.pirateFactionKey ||
      "",
  ).trim();
  if (explicit) {
    return explicit;
  }
  try {
    const beltRatRuntime = require(path.join(__dirname, "../beltRatRuntime"));
    if (typeof beltRatRuntime.resolvePirateFactionKeyForSystem === "function") {
      return beltRatRuntime.resolvePirateFactionKeyForSystem(systemID) || "kinetic";
    }
  } catch (_error) {
    // The governed loadout resolver has a deterministic kinetic fallback.
  }
  return "kinetic";
}

function normalizePilotSkills(entries) {
  return (Array.isArray(entries) ? entries : [])
    .map((entry) => ({
      typeID: toPositiveInt(entry && entry.typeID, 0),
      level: Math.max(0, Math.min(5, Math.trunc(Number(entry && entry.level) || 0))),
      name: String(entry && entry.name || "").trim() || null,
    }))
    .filter((entry) => entry.typeID > 0 && entry.level > 0);
}

function buildPilotSkillMap(entries) {
  return new Map(normalizePilotSkills(entries).map((entry) => [
    entry.typeID,
    {
      typeID: entry.typeID,
      skillLevel: entry.level,
      trainedSkillLevel: entry.level,
      effectiveSkillLevel: entry.level,
    },
  ]));
}

function normalizePositiveIntSelector(value, pluralKey, singularKey) {
  const source =
    value && Array.isArray(value[pluralKey])
      ? value[pluralKey]
      : (
        value && value[singularKey] !== undefined && value[singularKey] !== null
          ? [value[singularKey]]
          : []
      );
  return source
    .map((entry) => toPositiveInt(entry, 0))
    .filter((entry) => entry > 0);
}

// An authored charge may name the module slots or module types it is for.
function doesAuthoredChargeSelectModule(chargeEntry, moduleRecord) {
  if (!chargeEntry || !moduleRecord) {
    return false;
  }
  const selectedFlagIDs = normalizePositiveIntSelector(
    chargeEntry,
    "moduleFlagIDs",
    "moduleFlagID",
  );
  const selectedTypeIDs = normalizePositiveIntSelector(
    chargeEntry,
    "moduleTypeIDs",
    "moduleTypeID",
  );
  if (selectedFlagIDs.length <= 0 && selectedTypeIDs.length <= 0) {
    return true;
  }
  if (
    selectedFlagIDs.length > 0 &&
    !selectedFlagIDs.includes(toPositiveInt(moduleRecord.flagID, 0))
  ) {
    return false;
  }
  if (
    selectedTypeIDs.length > 0 &&
    !selectedTypeIDs.includes(toPositiveInt(moduleRecord.typeID, 0))
  ) {
    return false;
  }
  return true;
}

// Fields for the native entity record of one spawn. Fails the spawn when a
// governed definition breaks its doctrine, as the mod did.
function buildSpawnEntityFields(definition, scene, options = {}, entityID = 0, identity = {}) {
  const doctrineGovernanceResult = validateGovernedNpcDefinition(definition);
  if (!doctrineGovernanceResult.success) {
    return doctrineGovernanceResult;
  }
  const doctrineGovernance = doctrineGovernanceResult.data || {
    governed: false,
    governance: {},
  };
  const governed = doctrineGovernance.governed === true;
  const governance = doctrineGovernance.governance || {};
  const regionalDefense = resolveIndustrialCrewRegionalDefense(
    definition && definition.loadout,
    resolveDefenseProfileForSystem(scene && scene.systemID, options),
  );
  const corporationIDOverride = toPositiveInt(options.corporationIDOverride, 0);
  const allianceIDOverride = toOptionalNonNegativeInt(options.allianceIDOverride);
  const warFactionIDOverride = toOptionalNonNegativeInt(options.warFactionIDOverride);
  return {
    success: true,
    data: {
      corporationID: corporationIDOverride || identity.corporationID,
      allianceID: allianceIDOverride === undefined
        ? identity.allianceID
        : allianceIDOverride,
      warFactionID: warFactionIDOverride === undefined
        ? identity.warFactionID
        : warFactionIDOverride,
      loadoutGoverned: governed,
      doctrineID: governed ? governance.doctrineID : null,
      doctrineRevision: governed ? governance.doctrineRevision : null,
      npcRole: governed ? governance.role : null,
      equipmentBand: governed ? governance.equipmentBand : null,
      procurementPolicy: governed ? governance.procurementPolicy : null,
      recoverabilityPolicyID: governed ? governance.recoverabilityPolicyID : null,
      fittedModuleDropChance: governed ? governance.fittedModuleDropChance : null,
      fittedModuleDropChances: governed
        ? cloneValue(governance.fittedModuleDropChances)
        : null,
      cargoSurvivalChance: governed ? governance.cargoSurvivalChance : null,
      pilotSkills: governed ? normalizePilotSkills(governance.pilotSkills) : [],
      governedDroneBay: governed ? cloneValue(regionalDefense.droneBay) : [],
      defensiveDroneFlights: governed
        ? cloneValue(regionalDefense.defenseFlights)
        : [],
      defenseDamageProfile: governed ? regionalDefense.damageProfile : null,
      loadoutSeed: governed ? String(options.loadoutSeed || entityID) : null,
    },
  };
}

// What the live entity carries from its record, for the drone and mining code.
function buildRuntimeEntityFields(entityRecord = {}) {
  return {
    skillMap: buildPilotSkillMap(entityRecord.pilotSkills),
    npcProfileID: entityRecord.profileID || null,
    npcLoadoutID: entityRecord.loadoutID || null,
    npcDoctrineID: entityRecord.doctrineID || null,
    governedDroneBay: cloneValue(entityRecord.governedDroneBay || []),
    defensiveDroneFlights: cloneValue(entityRecord.defensiveDroneFlights || []),
    defenseDamageProfile: entityRecord.defenseDamageProfile || null,
  };
}

module.exports = {
  buildPilotSkillMap,
  buildRuntimeEntityFields,
  buildSpawnEntityFields,
  doesAuthoredChargeSelectModule,
  normalizePilotSkills,
  resolveDefenseProfileForSystem,
  resolveIndexedNonNegativeIDOverride,
  resolveIndexedSpawnOptions,
  toOptionalNonNegativeInt,
};
