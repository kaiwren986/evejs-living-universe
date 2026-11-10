"use strict";

const {
  ABYSS_ROOM_COUNT: ABYSSAL_ROOM_COUNT,
  ABYSS_RUN_DURATION_MS: ABYSSAL_RUN_LIMIT_MS,
  ABYSS_UNUSED_TRACE_DURATION_MS,
} = require("./abyssalRuntimeConstants");
const {
  deepFreeze,
} = require("../domain/abyssalValueUtils");
const TRANQUIL_TIER = 0;

// Identity and restriction fields come from Tranquility's published type
// records. Qualitative weather behavior and the three-room, 20-minute run
// contract are corroborated by CCP's Abyssal Deadspace support documentation.

function buildTranquilDefinition(typeID, weatherType, effects) {
  const weatherName = weatherType[0].toUpperCase() + weatherType.slice(1);
  return {
    typeID,
    name: `Tranquil ${weatherName} Filament`,
    tier: TRANQUIL_TIER,
    tierName: "Tranquil",
    weatherType,
    effects,
    roomCount: ABYSSAL_ROOM_COUNT,
    runLimitMs: ABYSSAL_RUN_LIMIT_MS,
    unusedTraceLifetimeMs: ABYSS_UNUSED_TRACE_DURATION_MS,
    activationRestrictions: {
      blockedSecurityRatings: [0.9, 1.0],
      soloHull: "cruiser",
      allowedCruiserTechLevels: [1, 2],
    },
    runtimeSupported: true,
  };
}

const TRANQUIL_FILAMENT_DEFINITIONS = deepFreeze([
  buildTranquilDefinition(56131, "electrical", {
    penalty: "emResistance",
    bonus: "capacitorRecharge",
  }),
  buildTranquilDefinition(56132, "dark", {
    penalty: "weaponRange",
    bonus: "shipVelocity",
  }),
  buildTranquilDefinition(56133, "exotic", {
    penalty: "kineticResistance",
    bonus: "scanResolution",
  }),
  buildTranquilDefinition(56134, "firestorm", {
    penalty: "thermalResistance",
    bonus: "armorStrength",
  }),
  buildTranquilDefinition(56136, "gamma", {
    penalty: "explosiveResistance",
    bonus: "shieldStrength",
  }),
]);

const TRANQUIL_FILAMENT_DEFINITION_BY_TYPE_ID = new Map(
  TRANQUIL_FILAMENT_DEFINITIONS.map((definition) => [definition.typeID, definition]),
);

function normalizeTypeID(value) {
  if (typeof value === "string" && value.trim() === "") {
    return 0;
  }
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : 0;
}

function cloneDefinition(definition) {
  return definition == null ? null : JSON.parse(JSON.stringify(definition));
}

function resolveTranquilFilamentDefinition(typeID) {
  return cloneDefinition(
    TRANQUIL_FILAMENT_DEFINITION_BY_TYPE_ID.get(normalizeTypeID(typeID)) || null,
  );
}

function listTranquilFilamentDefinitions() {
  return TRANQUIL_FILAMENT_DEFINITIONS.map(cloneDefinition);
}

module.exports = {
  ABYSSAL_ROOM_COUNT,
  ABYSSAL_RUN_LIMIT_MS,
  ABYSS_UNUSED_TRACE_DURATION_MS,
  TRANQUIL_TIER,
  listTranquilFilamentDefinitions,
  resolveTranquilFilamentDefinition,
};
