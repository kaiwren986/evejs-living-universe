"use strict";

const { cloneValue } = require("../../domain/abyssalValueUtils");
const { ABYSSAL_CONTENT_AUTHORITY } = require("../abyssalContentAuthority");
const { ABYSSAL_REWARD_QUANTITY_POLICY } = require("../../domain/abyssalRewardQuantityPolicy");

const { PROCEDURAL_ENVIRONMENT_MODEL } = require("../abyssalProceduralEnvironment");
const PROCEDURAL_DEFINITION_MODEL_V1 = "abyssal:procedural-content-v1";
const PROCEDURAL_DEFINITION_MODEL = "abyssal:procedural-content-v2";
const PROCEDURAL_ROOM_MODEL = "abyssal:qsna-three-room-v1";
const PROCEDURAL_EXTRACTION_MODEL = "abyssal:procedural-core-extraction-v1";
const WEATHER_TYPES = Object.freeze(["dark", "electrical", "exotic", "firestorm", "gamma"]);
const CORE_MATERIAL_NAMES = Object.freeze([
  "Triglavian Survey Database", "Zero-Point Condensate", "Crystalline Isogen-10",
]);

function validateContext({ tier, weatherType }) {
  if (!Number.isInteger(tier) || tier < 0 || tier > 6 || !WEATHER_TYPES.includes(weatherType)) {
    throw new Error(`ABYSSAL_PROCEDURAL_CONTEXT_UNAVAILABLE tier=${tier} weather=${weatherType}`);
  }
}

function isProceduralAbyssalContent(profile) {
  return [PROCEDURAL_DEFINITION_MODEL_V1, PROCEDURAL_DEFINITION_MODEL].includes(profile?.contentGeneration?.definition);
}

function buildProceduralExtractionProfile({ tier, weatherType, coreMaterials, structureTypes }) {
  validateContext({ tier, weatherType });
  const materials = CORE_MATERIAL_NAMES.map((name) =>
    coreMaterials?.find((type) => type.name === name && type.published !== false &&
      Number.isSafeInteger(type.typeID) && type.typeID > 0));
  if (materials.some((type) => !type) || !Array.isArray(structureTypes) ||
      structureTypes.length !== 2 || structureTypes.some((type) => !type ||
        !Number.isSafeInteger(type.typeID) || type.typeID <= 0) ||
      new Set(structureTypes.map((type) => type.typeID)).size !== 2) {
    throw new Error(`ABYSSAL_PROCEDURAL_EXTRACTION_INPUTS_UNAVAILABLE tier=${tier} weather=${weatherType}`);
  }
  // Item/structure identities come from SDE and captured extraction evidence.
  // One node, Calm's 45% whole-node empty roll, and the linear tier quantity curve are
  // explicit EveJS policy, not measured retail probabilities or tier balance.
  // T0 stays disabled; the old runtime materialised 3 * tier per base item.
  // That scaling now happens here, once, rather than in the manager.
  const quantity = 3 * tier;
  return {
    extractionNodeProfileID: `${PROCEDURAL_EXTRACTION_MODEL}:t${tier}:${weatherType}`,
    lootTableID: `${PROCEDURAL_EXTRACTION_MODEL}:t${tier}:${weatherType}`,
    contentAuthority: ABYSSAL_CONTENT_AUTHORITY.PROJECT_AUTHORED,
    quantityPolicy: ABYSSAL_REWARD_QUANTITY_POLICY.PRE_SCALED,
    enabled: tier > 0,
    displayName: `Tier ${tier} ${weatherType} Procedural Extraction`,
    extractionNodeTypeName: structureTypes[0].name,
    extractionNodeDisplayName: "Triglavian Extraction Node",
    eligibleRoomIndexes: tier <= 1 ? [1, 2, 3] : [2, 3],
    eligibleTiers: [tier],
    spawnCount: tier > 0 ? 1 : 0,
    minimumSpawnCount: tier > 0 ? 1 : 0,
    maximumSpawnCount: tier > 0 ? 1 : 0,
    structureTypeIDs: structureTypes.map((type) => type.typeID),
    // Alternatives above are not a captured multiset of simultaneous nodes.
    observedStructureTypeIDs: [],
    lootEmptyChance: tier === 1 ? 0.45 : 0,
    wholeNodeEmptyRoll: true,
    spawnOffsetMeters: 2800,
    guaranteedLootEntries: tier === 0 ? [] : materials.map((type) => ({
      itemName: type.name, itemTypeID: type.typeID, groupID: type.groupID,
      categoryID: type.categoryID, published: true,
      quantity, minQuantity: quantity, maxQuantity: quantity, probability: 1,
      weight: 1, allowedRoomIndexes: [1, 2, 3], allowedTiers: [tier],
      allowedWeatherTypes: [weatherType], unresolvedReference: false,
    })),
    independentLootEntries: [], weightedLootPools: [], rareLootEntries: [],
    extractionSubnodes: [], unresolvedLootReferences: [], unresolvedLootReferenceCount: 0,
    placeholderOnly: false,
    evidenceRefs: ["server/src/space/abyssal/abyssalProceduralLoot.js",
      "doc/abyssal/target-architecture.md"],
    placeholderNotes: ["Procedural EveJS side-loot policy; quantities and probability are not retail-exact."],
  };
}

function composeProceduralContentV1(baseDefinition, { buildRewardProfile, coreMaterials, structureTypes } = {}) {
  const { tier, weatherType } = baseDefinition;
  validateContext({ tier, weatherType });
  const rewardProfile = typeof buildRewardProfile === "function" ? buildRewardProfile({ tier, weatherType }) : null;
  if (!rewardProfile || rewardProfile.rewardMode !== "procedural_sde_weighted_pool") {
    throw new Error(`ABYSSAL_PROCEDURAL_REWARD_UNAVAILABLE tier=${tier} weather=${weatherType}`);
  }
  // Only operational/filament metadata is inherited. These replacements never
  // inspect the old NPC rosters, room reward overrides, or extraction templates.
  return {
    ...baseDefinition,
    roomProfile: {
      retailTargetRooms: 3, implementedRooms: 3, currentRoomIndex: 1,
      completedRooms: 0, currentRoomComplete: false,
      roomOriginLabel: "Abyssal Origin Marker",
      transferConduitLabel: "Transfer Conduit (Triglavian)",
      finalExitConduitLabel: "Origin Conduit (Triglavian)",
      roomOffsetsMeters: Array.from({ length: 3 }, (_, i) => ({ x: 0, y: i * 12000000, z: 0 })),
      finalExitAvailableOnCompletion: true, placeholderSingleRoomMode: false,
      contentAuthority: ABYSSAL_CONTENT_AUTHORITY.PROJECT_AUTHORED,
    },
    npcProfile: {
      runtimeKind: "nativeCombat", amount: 0, selectionMode: "qsna_runtime",
      spawnOffsetMeters: 6000, objectiveRole: "kill_all_hostiles",
      spawnReference: "ship_spawn", spawnDistanceMode: "ahead_of_ship",
      runtimePolicy: { suppressBounty: true, suppressWreck: true, suppressStandings: true },
    },
    // These are contracts, not sampled encounters. The runtime resolves a QSNA
    // family with the real run ID and persists its exact NPC list before use.
    roomEncounterProfilesByIndex: Object.fromEntries([1, 2, 3].map((roomIndex) => [
      String(roomIndex), {
        roomIndex, encounterProfileID: `${PROCEDURAL_ROOM_MODEL}:t${tier}:${weatherType}:r${roomIndex}`,
        selectionMode: "qsna_runtime", tierRange: { minTier: tier, maxTier: tier },
        weatherTheme: weatherType, objectiveType: "kill_objective_hostiles",
        contentAuthority: ABYSSAL_CONTENT_AUTHORITY.PROJECT_AUTHORED,
        npcEntries: [], rewardMultiplier: 1, rewardQuantityBonus: 0,
        rewardProfileOverride: null, extractionNodeProfileOverride: null,
      },
    ])),
    rewardProfile: cloneValue(rewardProfile),
    extractionNodeProfile: buildProceduralExtractionProfile({ tier, weatherType, coreMaterials, structureTypes }),
    placeholderNotes: ["QSNA supplies observed NPC constraints; EveJS sampling and loot policies are not retail-exact."],
  };
}

function composeProceduralContent(baseDefinition, inputs) {
  return { ...composeProceduralContentV1(baseDefinition, inputs),
    environmentLayoutVariant: PROCEDURAL_ENVIRONMENT_MODEL };
}

module.exports = {
  PROCEDURAL_DEFINITION_MODEL, PROCEDURAL_DEFINITION_MODEL_V1, PROCEDURAL_ROOM_MODEL, PROCEDURAL_EXTRACTION_MODEL,
  buildProceduralExtractionProfile, composeProceduralContent, composeProceduralContentV1, isProceduralAbyssalContent,
};
