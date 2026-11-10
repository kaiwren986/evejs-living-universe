"use strict";

const {
  CACHE_WRECK,
  TYPE_CATALOG,
} = require("../catalog/t0DarkRetailCapturedLayout");
const {
  normalizeText,
} = require("./abyssalValueUtils");

const ABYSSAL_ROOM_ENTITY_ROLES = Object.freeze({
  ORIGIN_MARKER: "origin-marker",
  PLAYER_INSERTION: "player-insertion",
  CONDUIT: "conduit",
  WEATHER: "weather",
  VOLUMETRIC_CLOUD: "volumetric-cloud",
  FUNCTIONAL_ENVIRONMENT: "functional-environment",
  PERIMETER: "perimeter",
  DECORATION: "decoration",
  NPC: "npc",
  REWARD_CACHE: "reward-cache",
  REWARD_WRECK: "reward-wreck",
  EXTRACTION_NODE: "extraction-node",
  PROBE: "probe",
  UNKNOWN: "unknown",
});

const PRIMARY_ROLE_COUNT_FIELD_BY_ROLE = Object.freeze({
  [ABYSSAL_ROOM_ENTITY_ROLES.ORIGIN_MARKER]: "originMarkerCount",
  [ABYSSAL_ROOM_ENTITY_ROLES.PLAYER_INSERTION]: "playerInsertionCount",
  [ABYSSAL_ROOM_ENTITY_ROLES.CONDUIT]: "conduitCount",
  [ABYSSAL_ROOM_ENTITY_ROLES.WEATHER]: "weatherCount",
  [ABYSSAL_ROOM_ENTITY_ROLES.VOLUMETRIC_CLOUD]: "volumetricCloudCount",
  [ABYSSAL_ROOM_ENTITY_ROLES.FUNCTIONAL_ENVIRONMENT]: "functionalEnvironmentCount",
  [ABYSSAL_ROOM_ENTITY_ROLES.PERIMETER]: "perimeterCount",
  [ABYSSAL_ROOM_ENTITY_ROLES.DECORATION]: "decorationCount",
  [ABYSSAL_ROOM_ENTITY_ROLES.NPC]: "npcCount",
  [ABYSSAL_ROOM_ENTITY_ROLES.REWARD_CACHE]: "rewardCacheCount",
  [ABYSSAL_ROOM_ENTITY_ROLES.REWARD_WRECK]: "rewardWreckCount",
  [ABYSSAL_ROOM_ENTITY_ROLES.EXTRACTION_NODE]: "extractionNodeCount",
  [ABYSSAL_ROOM_ENTITY_ROLES.PROBE]: "probeCount",
  [ABYSSAL_ROOM_ENTITY_ROLES.UNKNOWN]: "unknownCount",
});

const PRIMARY_ROLE_COUNT_FIELDS = Object.freeze(
  Object.values(PRIMARY_ROLE_COUNT_FIELD_BY_ROLE),
);

const CAPTURED_LAYOUT_ROLE_TO_DIAGNOSTIC_ROLE = Object.freeze({
  weather_object: ABYSSAL_ROOM_ENTITY_ROLES.WEATHER,
  volumetric_cloud_ball: ABYSSAL_ROOM_ENTITY_ROLES.VOLUMETRIC_CLOUD,
  functional_environmental_structure: ABYSSAL_ROOM_ENTITY_ROLES.FUNCTIONAL_ENVIRONMENT,
  suppressor: ABYSSAL_ROOM_ENTITY_ROLES.FUNCTIONAL_ENVIRONMENT,
  depth_boundary_object: ABYSSAL_ROOM_ENTITY_ROLES.FUNCTIONAL_ENVIRONMENT,
  filament_cloud: ABYSSAL_ROOM_ENTITY_ROLES.FUNCTIONAL_ENVIRONMENT,
  environmental_perimeter: ABYSSAL_ROOM_ENTITY_ROLES.PERIMETER,
  decorative_crystal_debris: ABYSSAL_ROOM_ENTITY_ROLES.DECORATION,
  decorative_extraction_cluster: ABYSSAL_ROOM_ENTITY_ROLES.DECORATION,
  player_insertion_locator: ABYSSAL_ROOM_ENTITY_ROLES.PLAYER_INSERTION,
  transfer_conduit: ABYSSAL_ROOM_ENTITY_ROLES.CONDUIT,
  origin_controller_marker: ABYSSAL_ROOM_ENTITY_ROLES.CONDUIT,
  reward_cache: ABYSSAL_ROOM_ENTITY_ROLES.REWARD_CACHE,
  npc: ABYSSAL_ROOM_ENTITY_ROLES.NPC,
});

const CAPTURED_DIAGNOSTIC_ROLE_BY_TYPE_ID = Object.freeze(
  Object.fromEntries(
    Object.entries(TYPE_CATALOG).map(([typeID, catalogEntry]) => [
      typeID,
      CAPTURED_LAYOUT_ROLE_TO_DIAGNOSTIC_ROLE[String(catalogEntry && catalogEntry[1] || "")] ||
        ABYSSAL_ROOM_ENTITY_ROLES.UNKNOWN,
    ]),
  ),
);

const VALID_ROLES = new Set(Object.values(ABYSSAL_ROOM_ENTITY_ROLES));

function toInt(value, fallback = 0) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeRole(value) {
  const role = normalizeText(value, "").toLowerCase();
  return VALID_ROLES.has(role) ? role : "";
}

function mapCapturedLayoutRoleToAbyssalRoomEntityRole(value) {
  return CAPTURED_LAYOUT_ROLE_TO_DIAGNOSTIC_ROLE[
    normalizeText(value, "").toLowerCase()
  ] || ABYSSAL_ROOM_ENTITY_ROLES.UNKNOWN;
}

function resolveCapturedT0DarkRoomEntityRoleByTypeID(typeID) {
  const numericTypeID = toInt(typeID, 0);
  if (numericTypeID === toInt(CACHE_WRECK && CACHE_WRECK.typeID, 0)) {
    return ABYSSAL_ROOM_ENTITY_ROLES.REWARD_WRECK;
  }
  return CAPTURED_DIAGNOSTIC_ROLE_BY_TYPE_ID[String(numericTypeID)] ||
    ABYSSAL_ROOM_ENTITY_ROLES.UNKNOWN;
}

function resolveEnvironmentalEffectKindRole(effectKind) {
  switch (normalizeText(effectKind, "").toLowerCase()) {
    case "weather_presentation":
      return ABYSSAL_ROOM_ENTITY_ROLES.WEATHER;
    case "boundary_presentation":
      return ABYSSAL_ROOM_ENTITY_ROLES.PERIMETER;
    case "localized_modifier":
    case "point_defense":
    case "unknown_disabled":
      return ABYSSAL_ROOM_ENTITY_ROLES.FUNCTIONAL_ENVIRONMENT;
    default:
      return ABYSSAL_ROOM_ENTITY_ROLES.UNKNOWN;
  }
}

function resolveAbyssalRoomEntityRole(source = {}) {
  if (!source || typeof source !== "object") {
    return ABYSSAL_ROOM_ENTITY_ROLES.UNKNOWN;
  }

  const explicitRole = normalizeRole(
    source.abyssalEntityRole || source.evejsAbyssalEntityRole,
  );
  if (explicitRole) {
    return explicitRole;
  }

  const sourceRole = normalizeText(
    source.sourceRole || source.capturedRole || source.entryRole || source.catalogRole,
    "",
  ).toLowerCase();
  if (sourceRole) {
    const mappedSourceRole = mapCapturedLayoutRoleToAbyssalRoomEntityRole(sourceRole);
    if (mappedSourceRole !== ABYSSAL_ROOM_ENTITY_ROLES.UNKNOWN) {
      return mappedSourceRole;
    }
    if (sourceRole === "cloud") {
      return ABYSSAL_ROOM_ENTITY_ROLES.VOLUMETRIC_CLOUD;
    }
    if (sourceRole === "debris" || sourceRole === "structure") {
      return ABYSSAL_ROOM_ENTITY_ROLES.DECORATION;
    }
  }

  const artifactRole = normalizeText(
    source.role ||
      source.abyssalArtifactRole ||
      source.evejsAbyssalArtifactState && source.evejsAbyssalArtifactState.role,
    "",
  ).toLowerCase();
  if (artifactRole === "cache_structure") {
    return ABYSSAL_ROOM_ENTITY_ROLES.REWARD_CACHE;
  }
  if (artifactRole === "cache_loot_container" || artifactRole === "extraction_node_loot_container") {
    return ABYSSAL_ROOM_ENTITY_ROLES.REWARD_WRECK;
  }
  if (artifactRole === "extraction_node_structure") {
    return ABYSSAL_ROOM_ENTITY_ROLES.EXTRACTION_NODE;
  }

  const markerKind = normalizeText(
    source.markerKind || source.evejsAbyssalPocketMarkerKind,
    "",
  ).toLowerCase();
  if (markerKind === "origin") {
    return ABYSSAL_ROOM_ENTITY_ROLES.ORIGIN_MARKER;
  }
  if (markerKind === "exit") {
    return ABYSSAL_ROOM_ENTITY_ROLES.CONDUIT;
  }

  if (source.evejsAbyssalVisualProbe === true) {
    return ABYSSAL_ROOM_ENTITY_ROLES.PROBE;
  }
  if (source.nativeNpc === true || source.evejsAbyssalNpc === true || source.npcEntityType) {
    return ABYSSAL_ROOM_ENTITY_ROLES.NPC;
  }
  if (source.evejsAbyssalRewardCache === true) {
    return artifactRole === "cache_loot_container"
      ? ABYSSAL_ROOM_ENTITY_ROLES.REWARD_WRECK
      : ABYSSAL_ROOM_ENTITY_ROLES.REWARD_CACHE;
  }
  if (source.evejsAbyssalExtractionNode === true) {
    return artifactRole === "extraction_node_loot_container"
      ? ABYSSAL_ROOM_ENTITY_ROLES.REWARD_WRECK
      : ABYSSAL_ROOM_ENTITY_ROLES.EXTRACTION_NODE;
  }
  if (
    source.evejsAbyssalConduit === true ||
    source.evejsAbyssalTransferConduit === true ||
    source.evejsAbyssalFinalConduit === true ||
    source.abyssalConduitType
  ) {
    return ABYSSAL_ROOM_ENTITY_ROLES.CONDUIT;
  }
  if (
    source.evejsAbyssalRoomOriginMarker === true ||
    source.evejsAbyssalPocketMarker === true && markerKind !== "exit"
  ) {
    return ABYSSAL_ROOM_ENTITY_ROLES.ORIGIN_MARKER;
  }

  const capturedRole = resolveCapturedT0DarkRoomEntityRoleByTypeID(source.typeID);
  if (capturedRole !== ABYSSAL_ROOM_ENTITY_ROLES.UNKNOWN) {
    return capturedRole;
  }

  if (source.evejsAbyssalEnvironmentalObject === true || source.environmentalObject === true) {
    return resolveEnvironmentalEffectKindRole(
      source.effectKind || source.evejsAbyssalEnvironmentalEffectKind,
    );
  }
  if (source.abyssalVisualOnly === true || source.evejsAbyssalVisualOnly === true) {
    return ABYSSAL_ROOM_ENTITY_ROLES.DECORATION;
  }

  return ABYSSAL_ROOM_ENTITY_ROLES.UNKNOWN;
}

function getDefaultMechanicsEnabled(role) {
  return [
    ABYSSAL_ROOM_ENTITY_ROLES.CONDUIT,
    ABYSSAL_ROOM_ENTITY_ROLES.NPC,
    ABYSSAL_ROOM_ENTITY_ROLES.REWARD_CACHE,
    ABYSSAL_ROOM_ENTITY_ROLES.REWARD_WRECK,
    ABYSSAL_ROOM_ENTITY_ROLES.EXTRACTION_NODE,
  ].includes(role);
}

function applyAbyssalRoomEntityMetadata(target, options = {}) {
  if (!target || typeof target !== "object") {
    return target;
  }
  const role = normalizeRole(options.role) || resolveAbyssalRoomEntityRole({
    ...target,
    ...options,
  });
  target.abyssalRunID = toInt(
    options.abyssalRunID,
    toInt(target.abyssalRunID, toInt(target.evejsAbyssalInstanceID, 0)),
  );
  target.abyssalRoomIndex = toInt(
    options.abyssalRoomIndex,
    toInt(target.abyssalRoomIndex, toInt(target.evejsAbyssalRoomIndex, 0)),
  );
  target.abyssalEntityRole = role;
  target.abyssalDefinitionID = normalizeText(
    options.abyssalDefinitionID,
    normalizeText(
      target.abyssalDefinitionID,
      normalizeText(target.evejsAbyssalDefinitionID, ""),
    ),
  );
  target.presentationEnabled = options.presentationEnabled === undefined
    ? target.presentationEnabled !== false
    : options.presentationEnabled === true;
  target.mechanicsEnabled = options.mechanicsEnabled === undefined
    ? (
        typeof target.mechanicsEnabled === "boolean"
          ? target.mechanicsEnabled
          : getDefaultMechanicsEnabled(role)
      )
    : options.mechanicsEnabled === true;
  return target;
}

function createEmptyAbyssalRoomEntityCounts() {
  return {
    originMarkerCount: 0,
    playerInsertionCount: 0,
    conduitCount: 0,
    weatherCount: 0,
    volumetricCloudCount: 0,
    functionalEnvironmentCount: 0,
    perimeterCount: 0,
    decorationCount: 0,
    npcCount: 0,
    rewardCacheCount: 0,
    rewardWreckCount: 0,
    extractionNodeCount: 0,
    probeCount: 0,
    unknownCount: 0,
    totalRoomEntityCount: 0,
    presentationEnvironmentCount: 0,
    authoredSceneryCount: 0,
    environmentCount: 0,
    primaryRoleCountSum: 0,
    primaryRoleIntegrity: true,
    unknownEntityIDs: [],
    unknownTypeIDs: [],
    functionalEnvironmentEntries: [],
  };
}

function summarizeAbyssalRoomEntities(records = []) {
  const counts = createEmptyAbyssalRoomEntityCounts();
  const uniqueRecords = [];
  const seenRuntimeIDs = new Set();
  for (const [index, rawRecord] of (Array.isArray(records) ? records : []).entries()) {
    if (!rawRecord || typeof rawRecord !== "object") {
      continue;
    }
    const runtimeItemID = toInt(
      rawRecord.runtimeItemID,
      toInt(rawRecord.itemID, toInt(rawRecord.entityID, 0)),
    );
    const identityKey = runtimeItemID > 0 ? `runtime:${runtimeItemID}` : `anonymous:${index}`;
    if (seenRuntimeIDs.has(identityKey)) {
      continue;
    }
    seenRuntimeIDs.add(identityKey);
    const role = resolveAbyssalRoomEntityRole(rawRecord);
    const record = {
      ...rawRecord,
      runtimeItemID,
      typeID: toInt(rawRecord.typeID, 0),
      abyssalEntityRole: role,
    };
    uniqueRecords.push(record);
    const countField = PRIMARY_ROLE_COUNT_FIELD_BY_ROLE[role] || "unknownCount";
    counts[countField] += 1;
    if (countField === "unknownCount") {
      if (runtimeItemID > 0) counts.unknownEntityIDs.push(runtimeItemID);
      if (record.typeID > 0) counts.unknownTypeIDs.push(record.typeID);
    }
    if (role === ABYSSAL_ROOM_ENTITY_ROLES.FUNCTIONAL_ENVIRONMENT) {
      counts.functionalEnvironmentEntries.push(record);
    }
  }

  counts.totalRoomEntityCount = uniqueRecords.length;
  counts.presentationEnvironmentCount =
    counts.weatherCount +
    counts.volumetricCloudCount +
    counts.functionalEnvironmentCount +
    counts.perimeterCount;
  counts.authoredSceneryCount =
    counts.decorationCount +
    counts.functionalEnvironmentCount +
    counts.perimeterCount;
  // environmentCount intentionally means presentation environment only. It
  // excludes conduits, caches, NPCs, insertion markers, decorations, and probes.
  counts.environmentCount = counts.presentationEnvironmentCount;
  counts.primaryRoleCountSum = PRIMARY_ROLE_COUNT_FIELDS.reduce(
    (total, field) => total + toInt(counts[field], 0),
    0,
  );
  counts.primaryRoleIntegrity = counts.primaryRoleCountSum === counts.totalRoomEntityCount;
  counts.unknownEntityIDs = [...new Set(counts.unknownEntityIDs)];
  counts.unknownTypeIDs = [...new Set(counts.unknownTypeIDs)];
  counts.records = uniqueRecords;
  return counts;
}

function formatAbyssalRoomEntityCountsForLog(counts = {}) {
  return [
    `total=${toInt(counts.totalRoomEntityCount, 0)}`,
    `originMarkers=${toInt(counts.originMarkerCount, 0)}`,
    `insertions=${toInt(counts.playerInsertionCount, 0)}`,
    `conduits=${toInt(counts.conduitCount, 0)}`,
    `weather=${toInt(counts.weatherCount, 0)}`,
    `clouds=${toInt(counts.volumetricCloudCount, 0)}`,
    `functionalEnvironment=${toInt(counts.functionalEnvironmentCount, 0)}`,
    `perimeters=${toInt(counts.perimeterCount, 0)}`,
    `decorations=${toInt(counts.decorationCount, 0)}`,
    `npcs=${toInt(counts.npcCount, 0)}`,
    `caches=${toInt(counts.rewardCacheCount, 0)}`,
    `wrecks=${toInt(counts.rewardWreckCount, 0)}`,
    `extractionNodes=${toInt(counts.extractionNodeCount, 0)}`,
    `probes=${toInt(counts.probeCount, 0)}`,
    `unknown=${toInt(counts.unknownCount, 0)}`,
    `environmentCount=${toInt(counts.environmentCount, 0)}`,
    `authoredSceneryCount=${toInt(counts.authoredSceneryCount, 0)}`,
    `primaryRoleCountSum=${toInt(counts.primaryRoleCountSum, 0)}`,
    `unknownEntityIDs=${Array.isArray(counts.unknownEntityIDs) && counts.unknownEntityIDs.length > 0 ? counts.unknownEntityIDs.join(",") : "none"}`,
    `unknownTypeIDs=${Array.isArray(counts.unknownTypeIDs) && counts.unknownTypeIDs.length > 0 ? counts.unknownTypeIDs.join(",") : "none"}`,
  ].join(" ");
}

module.exports = {
  ABYSSAL_ROOM_ENTITY_ROLES,
  PRIMARY_ROLE_COUNT_FIELD_BY_ROLE,
  PRIMARY_ROLE_COUNT_FIELDS,
  mapCapturedLayoutRoleToAbyssalRoomEntityRole,
  resolveCapturedT0DarkRoomEntityRoleByTypeID,
  resolveAbyssalRoomEntityRole,
  applyAbyssalRoomEntityMetadata,
  createEmptyAbyssalRoomEntityCounts,
  summarizeAbyssalRoomEntities,
  formatAbyssalRoomEntityCountsForLog,
};
