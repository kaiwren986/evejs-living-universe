"use strict";

const path = require("path");

const BaseService = require("../../services/baseService");
const log = require("../../utils/logger");
const {
  listItemTypes,
  resolveItemByName,
  resolveItemByTypeID,
} = require("../../services/inventory/itemTypeRegistry");
const { buildDict, buildList } = require("../../services/_shared/serviceHelpers");
const {
  cloneValue,
  deepFreeze,
} = require("../domain/abyssalValueUtils");
const {
  ABYSSAL_CONTENT_AUTHORITY,
  buildAbyssalContentCompletenessReport,
  validateAbyssalContentAuthority,
} = require("../catalog/abyssalContentAuthority");
const {
  createAuthoredAbyssalContentRegistry,
} = require("../catalog/content/authoredAbyssalContentRegistry");
const {
  ABYSSAL_REWARD_QUANTITY_POLICY,
  validateInventoryQuantity,
  validateRewardProfileQuantityPolicy,
} = require("../domain/abyssalRewardQuantityPolicy");
const {
  buildProceduralAbyssalRewardProfile,
  classifyProceduralRewardTypes,
} = require("../catalog/abyssalProceduralLoot");

const {
  CATALOGUE_ID: ABYSSAL_SPACE_TIER0_CATALOGUE_ID,
  TIER1_CATALOGUE_ID: ABYSSAL_SPACE_TIER1_CATALOGUE_ID,
  TIER2_CATALOGUE_ID: ABYSSAL_SPACE_TIER2_CATALOGUE_ID,
  TIER3_CATALOGUE_ID: ABYSSAL_SPACE_TIER3_CATALOGUE_ID,
  TIER4_CATALOGUE_ID: ABYSSAL_SPACE_TIER4_CATALOGUE_ID,
  TIER5_CATALOGUE_ID: ABYSSAL_SPACE_TIER5_CATALOGUE_ID,
  TIER6_CATALOGUE_ID: ABYSSAL_SPACE_TIER6_CATALOGUE_ID,
} = require("../catalog/content/abyssalTelemetryCatalogueIdentity");

const {
  ABYSSAL_AUTHORED_NPC_PROFILES_BY_TYPE_ID,
  ABYSSAL_CALM_WEATHER_TYPES,
  ABYSSAL_EXPLICIT_PLACEHOLDER_NPC_PROFILE_ID,
  ABYSSAL_HIGHER_TIER_APPROVED_TYPE_IDS,
  ABYSSAL_HIGHER_TIER_KEY_BY_TIER,
  ABYSSAL_HIGHER_TIER_LABEL_BY_TIER,
  ABYSSAL_SAFE_NPC_CATALOG_BY_PROFILE_ID,
  ABYSSAL_TIER0_APPROVED_TYPE_IDS,
  ABYSSAL_TIER0_COMBINED_ENCOUNTER_THEME,
  ABYSSAL_TIER1_APPROVED_TYPE_IDS,
  ABYSSAL_TIER1_COMBINED_ENCOUNTER_THEME,
  ABYSSAL_TIER2_APPROVED_TYPE_IDS,
  ABYSSAL_TIER2_COMBINED_ENCOUNTER_THEME,
  ABYSSAL_TIER3_COMBINED_ENCOUNTER_THEME,
  ABYSSAL_TIER4_COMBINED_ENCOUNTER_THEME,
  ABYSSAL_TIER5_COMBINED_ENCOUNTER_THEME,
  ABYSSAL_TIER6_COMBINED_ENCOUNTER_THEME,
  createAbyssalEncounterResolver,
  getAbyssalNpcEncounterTierAdmissionReport:
    getNpcEncounterTierAdmissionReport,
  getAbyssalNpcProfileValidationReport,
  normalizeEncounterText,
  resolveAbyssalEncounterArchetypeSpec:
    resolveEncounterArchetypeSpec,
  resolveAbyssalEncounterTierBand:
    resolveEncounterTierBand,
  resolveAbyssalEncounterVariety:
    resolveEncounterVariety,
  resolveSafeAbyssalNpcCatalogEntry,
} = require("../runtime/content/abyssalEncounterResolver");
const {
  createAbyssalFilamentDefinitionResolver,
} = require("../runtime/content/abyssalFilamentDefinitionResolver");

const { normalizeStringArray, toInteger, toBoolean, normalizeIntegerArray, normalizeHullMode, getCharacterID, cloneArgs } = require("../catalog/content/abyssalContentValues");

const { createAbyssalCompatibilityProfileModels } = require("../catalog/content/abyssalCompatibilityProfileModels");
const {
  buildPlaceholderRoomProfile,
  buildTranquilRoomProfile,
  buildPlaceholderExtractionNodeProfile,
  buildPlaceholderExtractionNodeProfileFromTemplate,
  buildPlaceholderCacheProfile,
  resolveAbyssalLootTypeDescriptor,
  buildPlaceholderRewardLootEntry,
  buildPlaceholderWeightedLootPool,
  buildRoomMultiplierMap,
  buildObservedRewardStatistics,
  buildPlaceholderRewardProfile,
  buildPlaceholderRewardProfileFromTemplate,
  buildPlaceholderNpcProfile,
  buildPlaceholderEncounterNpcEntry,
  buildPlaceholderRoomEncounterProfile,
} = createAbyssalCompatibilityProfileModels({
  get cloneValue() { return cloneValue; },
  get validateAbyssalContentAuthority() { return validateAbyssalContentAuthority; },
  get ABYSSAL_CONTENT_AUTHORITY() { return ABYSSAL_CONTENT_AUTHORITY; },
  get toBoolean() { return toBoolean; },
  get ABYSSAL_REWARD_QUANTITY_POLICY() { return ABYSSAL_REWARD_QUANTITY_POLICY; },
  get normalizeIntegerArray() { return normalizeIntegerArray; },
  get toInteger() { return toInteger; },
  get normalizeStringArray() { return normalizeStringArray; },
  get validateRewardProfileQuantityPolicy() { return validateRewardProfileQuantityPolicy; },
  get ABYSSAL_PLACEHOLDER_EXTRACTION_NODE_PROFILES_BY_ID() { return ABYSSAL_PLACEHOLDER_EXTRACTION_NODE_PROFILES_BY_ID; },
  get ABYSSAL_REWARD_STRUCTURE_PRESENTATION_PROFILE() { return ABYSSAL_REWARD_STRUCTURE_PRESENTATION_PROFILE; },
  get resolveItemByTypeID() { return resolveItemByTypeID; },
  get resolveItemByName() { return resolveItemByName; },
  get validateInventoryQuantity() { return validateInventoryQuantity; },
  get DEFAULT_PLACEHOLDER_ROOM_REWARD_MULTIPLIERS() { return DEFAULT_PLACEHOLDER_ROOM_REWARD_MULTIPLIERS; },
  get ABYSSAL_PLACEHOLDER_REWARD_PROFILES_BY_ID() { return ABYSSAL_PLACEHOLDER_REWARD_PROFILES_BY_ID; },
  get resolveSafeAbyssalNpcCatalogEntry() { return resolveSafeAbyssalNpcCatalogEntry; },
  get ABYSSAL_EXPLICIT_PLACEHOLDER_NPC_PROFILE_ID() { return ABYSSAL_EXPLICIT_PLACEHOLDER_NPC_PROFILE_ID; },
});

const { createAbyssalContentReportModel } = require("../catalog/content/abyssalContentReportModel");
const {
  normalizeNpc,
  normalizeSpawn,
  buildEmptyReport,
  normalizeReport,
  marshalNpc,
  marshalSpawn,
  marshalReport,
} = createAbyssalContentReportModel({
  get toInteger() { return toInteger; },
  get normalizeStringArray() { return normalizeStringArray; },
  get normalizeIntegerArray() { return normalizeIntegerArray; },
  get buildDict() { return buildDict; },
  get buildList() { return buildList; },
});

const { createAbyssalCompatibilityEncounterModels } = require("../catalog/content/abyssalCompatibilityEncounterModels");
const {
  buildAgitatedTier2RoomEncounterProfiles,
  buildHigherTierRoomEncounterProfiles,
  buildCalmDarkRequestedRoomEncounterProfiles,
  buildTranquilDarkRequestedRoomEncounterProfiles,
  buildRoomEncounterProfileFromTemplate,
  resolvePlaceholderRoomHostileCounts,
  buildAbyssalEncounterNpcEntries,
  buildPlaceholderEncounterArchetypeForDefinition,
  buildPlaceholderRoomEncounterProfilesForDefinition,
} = createAbyssalCompatibilityEncounterModels({
  get buildAgitatedTier2RoomExtractionNodeProfile() { return buildAgitatedTier2RoomExtractionNodeProfile; },
  get ABYSSAL_AGITATED_ROOM2_EXTRACTION_PROFILE_ID() { return ABYSSAL_AGITATED_ROOM2_EXTRACTION_PROFILE_ID; },
  get cloneValue() { return cloneValue; },
  get ABYSSAL_CALM_DARK_ROOM2_EXTRACTION_GUARANTEED_LOOT_ENTRIES() { return ABYSSAL_CALM_DARK_ROOM2_EXTRACTION_GUARANTEED_LOOT_ENTRIES; },
  get ABYSSAL_AGITATED_ROOM3_EXTRACTION_PROFILE_ID() { return ABYSSAL_AGITATED_ROOM3_EXTRACTION_PROFILE_ID; },
  get ABYSSAL_CALM_EXTRACTION_GUARANTEED_LOOT_ENTRIES() { return ABYSSAL_CALM_EXTRACTION_GUARANTEED_LOOT_ENTRIES; },
  get ABYSSAL_ENCOUNTER_RESOLVER() { return ABYSSAL_ENCOUNTER_RESOLVER; },
  get buildPlaceholderRoomEncounterProfile() { return buildPlaceholderRoomEncounterProfile; },
  get ABYSSAL_HIGHER_TIER_KEY_BY_TIER() { return ABYSSAL_HIGHER_TIER_KEY_BY_TIER; },
  get ABYSSAL_HIGHER_TIER_LABEL_BY_TIER() { return ABYSSAL_HIGHER_TIER_LABEL_BY_TIER; },
  get buildHigherTierRoomExtractionNodeProfile() { return buildHigherTierRoomExtractionNodeProfile; },
  get buildCalmDarkRoomExtractionNodeProfile() { return buildCalmDarkRoomExtractionNodeProfile; },
  get ABYSSAL_CALM_DARK_ROOM2_EXTRACTION_PROFILE_ID() { return ABYSSAL_CALM_DARK_ROOM2_EXTRACTION_PROFILE_ID; },
  get ABYSSAL_CALM_DARK_ROOM3_EXTRACTION_PROFILE_ID() { return ABYSSAL_CALM_DARK_ROOM3_EXTRACTION_PROFILE_ID; },
  get ABYSSAL_CONTENT_AUTHORITY() { return ABYSSAL_CONTENT_AUTHORITY; },
  get buildTranquilDarkProceduralRewardProfile() { return buildTranquilDarkProceduralRewardProfile; },
  get ABYSSAL_PLACEHOLDER_ROOM_ENCOUNTER_TEMPLATES_BY_ID() { return ABYSSAL_PLACEHOLDER_ROOM_ENCOUNTER_TEMPLATES_BY_ID; },
  get toInteger() { return toInteger; },
  get buildPlaceholderEncounterNpcEntry() { return buildPlaceholderEncounterNpcEntry; },
  get resolveAbyssalEncounterVariety() { return resolveAbyssalEncounterVariety; },
  get resolveAbyssalEncounterTierBand() { return resolveAbyssalEncounterTierBand; },
  get resolveAbyssalEncounterArchetypeSpec() { return resolveAbyssalEncounterArchetypeSpec; },
  get buildPlaceholderNpcProfile() { return buildPlaceholderNpcProfile; },
  get ABYSSAL_EXPLICIT_PLACEHOLDER_NPC_PROFILE_ID() { return ABYSSAL_EXPLICIT_PLACEHOLDER_NPC_PROFILE_ID; },
});

const { createAbyssalCompatibilityExtractionTemplates } = require("../catalog/content/abyssalCompatibilityExtractionTemplates");

const { createAbyssalCompatibilityRewardTemplates } = require("../catalog/content/abyssalCompatibilityRewardTemplates");

const MAX_REPETITIONS = 1000;
const ABYSSAL_AUTHORED_CONTENT_REGISTRY = createAuthoredAbyssalContentRegistry(
  undefined,
  {
    supportedNpcProfilesByTypeID: ABYSSAL_AUTHORED_NPC_PROFILES_BY_TYPE_ID,
    supportedMechanicIDs: ["controller_dependant_lifecycle"],
    isKnownObjectTypeID(typeID) {
      return Boolean(resolveItemByTypeID(toInteger(typeID, 0)));
    },
  },
);

function listAuthoredAbyssalCaptures(query = {}) {
  return ABYSSAL_AUTHORED_CONTENT_REGISTRY.listCaptures(query);
}

function resolveAuthoredAbyssalCaptureByID(captureID) {
  return ABYSSAL_AUTHORED_CONTENT_REGISTRY.resolveCaptureByID(captureID);
}

function selectAuthoredAbyssalCapture(query = {}) {
  return ABYSSAL_AUTHORED_CONTENT_REGISTRY.selectCapture(query);
}

function getAuthoredAbyssalContentAudit() {
  return ABYSSAL_AUTHORED_CONTENT_REGISTRY.getAudit();
}

function resolveAbyssalEncounterVariety(weatherType, overrides = {}) {
  return resolveEncounterVariety(weatherType, overrides);
}

function resolveAbyssalEncounterTierBand(tier) {
  return resolveEncounterTierBand(tier);
}

function resolveAbyssalEncounterArchetypeSpec(weatherType, roomIndex) {
  return resolveEncounterArchetypeSpec(weatherType, roomIndex);
}
const ABYSSAL_PLACEHOLDER_EXTRACTION_NODE_PROFILES_BY_ID = deepFreeze(createAbyssalCompatibilityExtractionTemplates({
  buildPlaceholderExtractionNodeProfile,
}));

const ABYSSAL_REWARD_STRUCTURE_PRESENTATION_PROFILE = Object.freeze({
  cacheProfileID: "abyssal:cache:triglavian-bioadaptive-shared-v1",
  cacheFamily: "captured_triglavian_bioadaptive_cache",
  cacheTypeID: 47951,
  cacheTypeName: "Triglavian Bioadaptive Cache",
  cacheDisplayName: "Triglavian Bioadaptive Cache",
  cacheGroupID: 2009,
  cacheGraphicID: 22217,
  wreckTypeID: 48120,
  wreckTypeName: "Triglavian Bioadaptive Cache Wreck",
  wreckGroupID: 186,
  wreckGraphicID: 22218,
  primaryNodeRole: "reward_cache",
  placeholderOnly: false,
});

const DEFAULT_PLACEHOLDER_ROOM_REWARD_MULTIPLIERS = deepFreeze({
  1: 1,
  2: 1.2,
  3: 1.5,
});

const ABYSSAL_CALM_REWARD_LOOT_TABLE_ID = "abyssal:loot:calm-bioadaptive-cache";
const ABYSSAL_CALM_EXTRACTION_LOOT_TABLE_ID = "abyssal:loot:calm-extraction-node";
const ABYSSAL_CALM_DARK_ROOM1_REWARD_PROFILE_ID = "abyssal:reward:calm-dark-cache-room1-v1";
const ABYSSAL_CALM_DARK_ROOM2_EXTRACTION_PROFILE_ID = "abyssal:extraction:calm-dark-extraction-room2-v1";
const ABYSSAL_CALM_DARK_ROOM3_EXTRACTION_PROFILE_ID = "abyssal:extraction:calm-dark-extraction-room3-v1";
const ABYSSAL_AGITATED_ROOM2_EXTRACTION_PROFILE_ID = "abyssal:extraction:agitated-extraction-room2-v1";
const ABYSSAL_AGITATED_ROOM3_EXTRACTION_PROFILE_ID = "abyssal:extraction:agitated-extraction-room3-v1";
const ABYSSAL_CALM_GUARANTEED_CACHE_LOOT_ENTRIES = deepFreeze([
  buildPlaceholderRewardLootEntry({
    itemName: "Triglavian Survey Database",
    quantity: 2,
  }),
  buildPlaceholderRewardLootEntry({
    itemName: "Zero-Point Condensate",
    quantity: 1,
  }),
]);
const ABYSSAL_CALM_GOLDEN_CACHE_BASE_LOOT_ENTRIES = deepFreeze([]);
const ABYSSAL_CALM_SURVEY_CACHE_LOOT_POOL = deepFreeze(buildPlaceholderWeightedLootPool({
  poolID: "abyssal:loot:calm-survey-database-golden-sample",
  displayName: "Calm Survey Database Pool",
  chance: 1,
  rolls: 1,
  entries: [{
    itemName: "Triglavian Survey Database",
    minQuantity: 2,
    maxQuantity: 6,
    weight: 1,
  }],
  placeholderNotes: [
    "The complete golden Calm cache sample observed quantities from two through six.",
  ],
}));
const ABYSSAL_CALM_BONUS_CACHE_LOOT_POOL = deepFreeze(buildPlaceholderWeightedLootPool({
  poolID: "abyssal:loot:calm-bonus-material",
  displayName: "Calm Bonus Material Pool",
  chance: 0.75,
  rolls: 1,
  entries: [
    {
      itemName: "Zero-Point Condensate",
      minQuantity: 1,
      maxQuantity: 1,
      weight: 3,
    },
    {
      itemName: "Crystalline Isogen-10",
      minQuantity: 1,
      maxQuantity: 1,
      weight: 2,
    },
  ],
}));
const ABYSSAL_CALM_GOLDEN_FILAMENT_CACHE_LOOT_POOL = deepFreeze(buildPlaceholderWeightedLootPool({
  poolID: "abyssal:loot:calm-filament",
  displayName: "Calm Filament Pool",
  chance: 0.2,
  rolls: 1,
  entries: [
    { itemName: "Tranquil Electrical Filament", minQuantity: 1, maxQuantity: 1, weight: 4 },
    { itemName: "Tranquil Dark Filament", minQuantity: 1, maxQuantity: 1, weight: 4 },
    { itemName: "Tranquil Firestorm Filament", minQuantity: 1, maxQuantity: 1, weight: 4 },
    { itemName: "Tranquil Gamma Filament", minQuantity: 1, maxQuantity: 1, weight: 4 },
    { itemName: "Calm Exotic Filament", minQuantity: 1, maxQuantity: 1, weight: 3 },
    { itemName: "Calm Dark Filament", minQuantity: 1, maxQuantity: 1, weight: 3 },
    { itemName: "Calm Electrical Filament", minQuantity: 1, maxQuantity: 1, weight: 3 },
    { itemName: "Agitated Gamma Filament", minQuantity: 1, maxQuantity: 1, weight: 2 },
    { itemName: "Fierce Electrical Filament", minQuantity: 1, maxQuantity: 1, weight: 1 },
  ],
  placeholderNotes: [
    "Every filament type in this pool was observed inside a golden Calm Bioadaptive Cache; the conservative selection weight is not claimed as retail probability.",
  ],
}));
const ABYSSAL_CALM_FILAMENT_CACHE_LOOT_POOL = deepFreeze(buildPlaceholderWeightedLootPool({
  poolID: "abyssal:loot:calm-filament",
  displayName: "Calm Filament Pool",
  chance: 0.2,
  rolls: 1,
  entries: [
    { itemName: "Calm Dark Filament", minQuantity: 1, maxQuantity: 1, weight: 1 },
    { itemName: "Calm Electrical Filament", minQuantity: 1, maxQuantity: 1, weight: 1 },
    { itemName: "Calm Exotic Filament", minQuantity: 1, maxQuantity: 1, weight: 1 },
    { itemName: "Calm Firestorm Filament", minQuantity: 1, maxQuantity: 1, weight: 1 },
    { itemName: "Calm Gamma Filament", minQuantity: 1, maxQuantity: 1, weight: 1 },
  ],
}));
const ABYSSAL_CALM_MUTAPLASMID_CACHE_LOOT_POOL = deepFreeze(buildPlaceholderWeightedLootPool({
  poolID: "abyssal:loot:calm-decayed-mutaplasmid",
  displayName: "Calm Decayed Mutaplasmid Pool",
  chance: 0.08,
  rolls: 1,
  entries: [
    { itemName: "Decayed 1MN Afterburner Mutaplasmid", minQuantity: 1, maxQuantity: 1, weight: 2 },
    { itemName: "Decayed Small Armor Repairer Mutaplasmid", minQuantity: 1, maxQuantity: 1, weight: 2 },
    { itemName: "Decayed Small Shield Booster Mutaplasmid", minQuantity: 1, maxQuantity: 1, weight: 2 },
    { itemName: "Decayed Warp Scrambler Mutaplasmid", minQuantity: 1, maxQuantity: 1, weight: 1 },
    { itemName: "Decayed Stasis Webifier Mutaplasmid", minQuantity: 1, maxQuantity: 1, weight: 1 },
  ],
}));

function buildTranquilDarkProceduralRewardProfile() {
  return cloneValue(ABYSSAL_SPACE_TIER0_REWARD_PROFILE_BY_WEATHER.dark);
}
const ABYSSAL_CALM_EXTRACTION_GUARANTEED_LOOT_ENTRIES = deepFreeze([
  buildPlaceholderRewardLootEntry({
    itemName: "Triglavian Survey Database",
    quantity: 1,
  }),
  buildPlaceholderRewardLootEntry({
    itemName: "Zero-Point Condensate",
    quantity: 1,
  }),
  buildPlaceholderRewardLootEntry({
    itemName: "Crystalline Isogen-10",
    quantity: 1,
  }),
]);
const ABYSSAL_CALM_DARK_ROOM2_CACHE_GUARANTEED_LOOT_ENTRIES = deepFreeze([
  buildPlaceholderRewardLootEntry({ itemName: "Triglavian Survey Database", quantity: 2 }),
  buildPlaceholderRewardLootEntry({ itemName: "Zero-Point Condensate", quantity: 1 }),
  buildPlaceholderRewardLootEntry({ itemName: "Crystalline Isogen-10", quantity: 1 }),
]);
const ABYSSAL_CALM_DARK_ROOM3_CACHE_GUARANTEED_LOOT_ENTRIES = deepFreeze([
  buildPlaceholderRewardLootEntry({ itemName: "Triglavian Survey Database", quantity: 3 }),
  buildPlaceholderRewardLootEntry({ itemName: "Zero-Point Condensate", quantity: 1 }),
  buildPlaceholderRewardLootEntry({ itemName: "Crystalline Isogen-10", quantity: 1 }),
]);
const ABYSSAL_CALM_DARK_ROOM2_EXTRACTION_GUARANTEED_LOOT_ENTRIES = deepFreeze([
  buildPlaceholderRewardLootEntry({
    itemName: "Triglavian Survey Database",
    quantity: 1,
  }),
  buildPlaceholderRewardLootEntry({
    itemName: "Crystalline Isogen-10",
    quantity: 1,
  }),
]);


function buildCalmDarkRoomRewardProfile({
  rewardProfileID,
  lootTableID,
  displayName,
  tier = 1,
  baseLootEntries,
  weightedLootPools = [],
  includeGoldenCalmSurveyPool = false,
  placeholderNotes = [],
} = {}) {
  return buildPlaceholderRewardProfileFromTemplate("abyssal:reward:calm-dark-placeholder", {
    rewardProfileID,
    lootTableID,
    displayName,
    tier,
    contentAuthority: ABYSSAL_CONTENT_AUTHORITY.PROJECT_AUTHORED,
    roomMultipliersByIndex: {
      1: 1,
      2: 1,
      3: 1,
    },
quantityPolicy:
  ABYSSAL_REWARD_QUANTITY_POLICY.AUTHORED_BASE,
    baseLootEntries,
    weightedLootPools: [
      ...(includeGoldenCalmSurveyPool
        ? [cloneValue(ABYSSAL_CALM_SURVEY_CACHE_LOOT_POOL)]
        : []),
      ...cloneValue(weightedLootPools),
    ],
    placeholderNotes,
  });
}

function buildCalmDarkRoomExtractionNodeProfile({
  extractionNodeProfileID,
  lootTableID,
  displayName,
  eligibleRoomIndexes,
  eligibleTiers = [1],
  guaranteedLootEntries,
  placeholderNotes = [],
} = {}) {
  return buildPlaceholderExtractionNodeProfileFromTemplate("abyssal:extraction:calm-dark-side-node", {
    extractionNodeProfileID,
    lootTableID,
    displayName,
    eligibleRoomIndexes,
    eligibleTiers,
    contentAuthority: ABYSSAL_CONTENT_AUTHORITY.PROJECT_AUTHORED,
    quantityPolicy: ABYSSAL_REWARD_QUANTITY_POLICY.AUTHORED_BASE,
    guaranteedLootEntries,
    placeholderNotes,
  });
}

const ABYSSAL_PLACEHOLDER_REWARD_PROFILES_BY_ID = deepFreeze(createAbyssalCompatibilityRewardTemplates({
  buildPlaceholderRewardProfile,
  ABYSSAL_REWARD_QUANTITY_POLICY,
  ABYSSAL_CALM_REWARD_LOOT_TABLE_ID,
  cloneValue,
  ABYSSAL_CALM_GOLDEN_CACHE_BASE_LOOT_ENTRIES,
  ABYSSAL_CALM_SURVEY_CACHE_LOOT_POOL,
  ABYSSAL_CALM_BONUS_CACHE_LOOT_POOL,
  ABYSSAL_CALM_GOLDEN_FILAMENT_CACHE_LOOT_POOL,
  ABYSSAL_CALM_MUTAPLASMID_CACHE_LOOT_POOL,
  ABYSSAL_CALM_GUARANTEED_CACHE_LOOT_ENTRIES,
  ABYSSAL_CALM_FILAMENT_CACHE_LOOT_POOL,
}));

const ABYSSAL_PROCEDURAL_REWARD_TYPES = classifyProceduralRewardTypes(
  listItemTypes(),
);

function buildAbyssalSpaceRewardProfile({ tier, weatherType }) {
  return buildPlaceholderRewardProfile(buildProceduralAbyssalRewardProfile({
    tier,
    weatherType,
    classifiedTypes: ABYSSAL_PROCEDURAL_REWARD_TYPES,
  }));
}


function buildTier0AbyssalSpaceRewardProfile(weatherType) {
  return buildAbyssalSpaceRewardProfile({
    tier: 0,
    weatherType,
  });
}

function buildTier1AbyssalSpaceRewardProfile(weatherType) {
  return buildAbyssalSpaceRewardProfile({
    tier: 1,
    weatherType,
  });
}

function buildTier2AbyssalSpaceRewardProfile(weatherType) {
  return buildAbyssalSpaceRewardProfile({
    tier: 2,
    weatherType,
  });
}

function buildTier3AbyssalSpaceRewardProfile(weatherType) {
  return buildAbyssalSpaceRewardProfile({
    tier: 3,
    weatherType,
  });
}

function buildTier4AbyssalSpaceRewardProfile(weatherType) {
  return buildAbyssalSpaceRewardProfile({
    tier: 4,
    weatherType,
  });
}

function buildTier5AbyssalSpaceRewardProfile(weatherType) {
  return buildAbyssalSpaceRewardProfile({
    tier: 5,
    weatherType,
  });
}

function buildTier6AbyssalSpaceRewardProfile(weatherType) {
  return buildAbyssalSpaceRewardProfile({
    tier: 6,
    weatherType,
  });
}

const ABYSSAL_SPACE_TIER0_REWARD_PROFILE_BY_WEATHER = deepFreeze(
  Object.fromEntries(ABYSSAL_CALM_WEATHER_TYPES.map((weatherType) => [
    weatherType,
    buildTier0AbyssalSpaceRewardProfile(weatherType),
  ])),
);

const ABYSSAL_SPACE_TIER1_REWARD_PROFILE_BY_WEATHER = deepFreeze(
  Object.fromEntries(ABYSSAL_CALM_WEATHER_TYPES.map((weatherType) => [
    weatherType,
    buildTier1AbyssalSpaceRewardProfile(weatherType),
  ])),
);

const ABYSSAL_SPACE_TIER2_REWARD_PROFILE_BY_WEATHER = deepFreeze(
  Object.fromEntries(ABYSSAL_CALM_WEATHER_TYPES.map((weatherType) => [
    weatherType,
    buildTier2AbyssalSpaceRewardProfile(weatherType),
  ])),
);

const ABYSSAL_SPACE_TIER3_REWARD_PROFILE_BY_WEATHER = deepFreeze(
  Object.fromEntries(ABYSSAL_CALM_WEATHER_TYPES.map((weatherType) => [
    weatherType,
    buildTier3AbyssalSpaceRewardProfile(weatherType),
  ])),
);

const ABYSSAL_SPACE_TIER4_REWARD_PROFILE_BY_WEATHER = deepFreeze(
  Object.fromEntries(ABYSSAL_CALM_WEATHER_TYPES.map((weatherType) => [
    weatherType,
    buildTier4AbyssalSpaceRewardProfile(weatherType),
  ])),
);

const ABYSSAL_SPACE_TIER5_REWARD_PROFILE_BY_WEATHER = deepFreeze(
  Object.fromEntries(ABYSSAL_CALM_WEATHER_TYPES.map((weatherType) => [
    weatherType,
    buildTier5AbyssalSpaceRewardProfile(weatherType),
  ])),
);

const ABYSSAL_SPACE_TIER6_REWARD_PROFILE_BY_WEATHER = deepFreeze(
  Object.fromEntries(ABYSSAL_CALM_WEATHER_TYPES.map((weatherType) => [
    weatherType,
    buildTier6AbyssalSpaceRewardProfile(weatherType),
  ])),
);

const ABYSSAL_SPACE_REWARD_PROFILES_BY_TIER = deepFreeze({
  0: ABYSSAL_SPACE_TIER0_REWARD_PROFILE_BY_WEATHER,
  1: ABYSSAL_SPACE_TIER1_REWARD_PROFILE_BY_WEATHER,
  2: ABYSSAL_SPACE_TIER2_REWARD_PROFILE_BY_WEATHER,
  3: ABYSSAL_SPACE_TIER3_REWARD_PROFILE_BY_WEATHER,
  4: ABYSSAL_SPACE_TIER4_REWARD_PROFILE_BY_WEATHER,
  5: ABYSSAL_SPACE_TIER5_REWARD_PROFILE_BY_WEATHER,
  6: ABYSSAL_SPACE_TIER6_REWARD_PROFILE_BY_WEATHER,
});

function resolveAbyssalSpaceRewardProfile({ tier, weatherType } = {}) {
  const profilesByWeather =
    ABYSSAL_SPACE_REWARD_PROFILES_BY_TIER[String(toInteger(tier, -1))] || null;
  const normalizedWeather = normalizeEncounterText(
    weatherType,
    "",
  ).toLowerCase();
  return cloneValue(
    profilesByWeather && profilesByWeather[normalizedWeather] || null,
  );
}

const ABYSSAL_ENCOUNTER_RESOLVER = createAbyssalEncounterResolver();

function listTier0AbyssalEncounterProfiles() {
  return ABYSSAL_ENCOUNTER_RESOLVER.listAuthoredEncounterProfiles(0);
}

function getAbyssalSpaceEncounterPartition(query = {}) {
  return ABYSSAL_ENCOUNTER_RESOLVER.getAbyssalSpaceEncounterPartition(query);
}

function listTier1AbyssalEncounterProfiles() {
  return ABYSSAL_ENCOUNTER_RESOLVER.listAuthoredEncounterProfiles(1);
}

function listTier2AbyssalEncounterProfiles() {
  return ABYSSAL_ENCOUNTER_RESOLVER.listAuthoredEncounterProfiles(2);
}

function listTier3AbyssalEncounterProfiles() {
  return ABYSSAL_ENCOUNTER_RESOLVER.listAuthoredEncounterProfiles(3);
}

function listTier4AbyssalEncounterProfiles() {
  return ABYSSAL_ENCOUNTER_RESOLVER.listAuthoredEncounterProfiles(4);
}

function listTier5AbyssalEncounterProfiles() {
  return ABYSSAL_ENCOUNTER_RESOLVER.listAuthoredEncounterProfiles(5);
}

function listTier6AbyssalEncounterProfiles() {
  return ABYSSAL_ENCOUNTER_RESOLVER.listAuthoredEncounterProfiles(6);
}

function listObservedTier0AbyssalEncounterProfiles() {
  return ABYSSAL_ENCOUNTER_RESOLVER.listObservedEncounterProfiles(0);
}

function listObservedTier1AbyssalEncounterProfiles() {
  return ABYSSAL_ENCOUNTER_RESOLVER.listObservedEncounterProfiles(1);
}

function listObservedTier2AbyssalEncounterProfiles() {
  return ABYSSAL_ENCOUNTER_RESOLVER.listObservedEncounterProfiles(2);
}

function listObservedTier3AbyssalEncounterProfiles() {
  return ABYSSAL_ENCOUNTER_RESOLVER.listObservedEncounterProfiles(3);
}

function listObservedTier4AbyssalEncounterProfiles() {
  return ABYSSAL_ENCOUNTER_RESOLVER.listObservedEncounterProfiles(4);
}

function listObservedTier5AbyssalEncounterProfiles() {
  return ABYSSAL_ENCOUNTER_RESOLVER.listObservedEncounterProfiles(5);
}

function listObservedTier6AbyssalEncounterProfiles() {
  return ABYSSAL_ENCOUNTER_RESOLVER.listObservedEncounterProfiles(6);
}

function selectObservedAbyssalEncounterProfile(context = {}) {
  return ABYSSAL_ENCOUNTER_RESOLVER.selectObservedEncounterProfile(context);
}

function validateObservedAbyssalNpcSpawnCoverage(definition = null) {
  return ABYSSAL_ENCOUNTER_RESOLVER.validateObservedAbyssalNpcSpawnCoverage({
    tier: definition && definition.tier,
    weatherType: definition && definition.weatherType,
    implementedRooms:
      definition && definition.roomProfile &&
        definition.roomProfile.implementedRooms,
  });
}

function listEncounterNpcCandidates(encounterProfile = null) {
  return ABYSSAL_ENCOUNTER_RESOLVER
    .listEncounterNpcCandidates(encounterProfile);
}

function auditEncounterNpcRuntimeCompleteness(encounterProfile = null) {
  return ABYSSAL_ENCOUNTER_RESOLVER
    .auditEncounterNpcRuntimeCompleteness(encounterProfile);
}

function listTier1AbyssalLegacyEncounterProfiles() {
  return ABYSSAL_ENCOUNTER_RESOLVER.listTier1LegacyEncounterProfiles();
}
function isObservedAbyssalEncounterProfile(profile = null, expectedTier = null) {
  return ABYSSAL_ENCOUNTER_RESOLVER.isObservedAbyssalEncounterProfile(
    profile,
    expectedTier,
  );
}

function getAbyssalNpcEncounterTierAdmissionReport(
  profileID,
  encounterProfile = null,
) {
  return getNpcEncounterTierAdmissionReport(profileID, encounterProfile);
}

function summarizeTier1CombinedEncounterComposition(profile = null) {
  return ABYSSAL_ENCOUNTER_RESOLVER
    .summarizeTier1CombinedEncounterComposition(profile);
}

function summarizeTier2CombinedEncounterComposition(profile = null) {
  return ABYSSAL_ENCOUNTER_RESOLVER
    .summarizeTier2CombinedEncounterComposition(profile);
}

function summarizeHigherTierCombinedEncounterComposition(profile = null) {
  return ABYSSAL_ENCOUNTER_RESOLVER
    .summarizeHigherTierCombinedEncounterComposition(profile);
}

function isTier0CombinedEncounterProfile(profile = null) {
  return ABYSSAL_ENCOUNTER_RESOLVER.isTier0CombinedEncounterProfile(profile);
}

function isTier0AbyssalSpaceEncounterProfile(profile = null) {
  return ABYSSAL_ENCOUNTER_RESOLVER
    .isTier0AbyssalSpaceEncounterProfile(profile);
}

function isTier1AbyssalSpaceEncounterProfile(profile = null) {
  return ABYSSAL_ENCOUNTER_RESOLVER
    .isTier1AbyssalSpaceEncounterProfile(profile);
}

function isTier2AbyssalSpaceEncounterProfile(profile = null) {
  return ABYSSAL_ENCOUNTER_RESOLVER
    .isTier2AbyssalSpaceEncounterProfile(profile);
}

function isTier3AbyssalSpaceEncounterProfile(profile = null) {
  return ABYSSAL_ENCOUNTER_RESOLVER
    .isTier3AbyssalSpaceEncounterProfile(profile);
}

function isTier4AbyssalSpaceEncounterProfile(profile = null) {
  return ABYSSAL_ENCOUNTER_RESOLVER
    .isTier4AbyssalSpaceEncounterProfile(profile);
}

function isTier5AbyssalSpaceEncounterProfile(profile = null) {
  return ABYSSAL_ENCOUNTER_RESOLVER
    .isTier5AbyssalSpaceEncounterProfile(profile);
}

function isTier6AbyssalSpaceEncounterProfile(profile = null) {
  return ABYSSAL_ENCOUNTER_RESOLVER
    .isTier6AbyssalSpaceEncounterProfile(profile);
}

function isSupportedAbyssalExtractionEncounter(request = {}) {
  return ABYSSAL_ENCOUNTER_RESOLVER
    .isSupportedAbyssalExtractionEncounter(request);
}

function isTier1CombinedEncounterProfile(profile = null) {
  return ABYSSAL_ENCOUNTER_RESOLVER.isTier1CombinedEncounterProfile(profile);
}

function isTier2CombinedEncounterProfile(profile = null) {
  return ABYSSAL_ENCOUNTER_RESOLVER.isTier2CombinedEncounterProfile(profile);
}

function isHigherTierCombinedEncounterProfile(profile = null, tier = 0) {
  return ABYSSAL_ENCOUNTER_RESOLVER
    .isHigherTierCombinedEncounterProfile(profile, tier);
}
function validateTier0AbyssalEncounterCatalog(catalogue = undefined) {
  return ABYSSAL_ENCOUNTER_RESOLVER
    .validateAuthoredEncounterCatalogue(0, catalogue);
}

function validateTier1AbyssalEncounterCatalog(catalogue = undefined) {
  return ABYSSAL_ENCOUNTER_RESOLVER
    .validateAuthoredEncounterCatalogue(1, catalogue);
}

function buildAgitatedTier2RoomExtractionNodeProfile({
  extractionNodeProfileID,
  lootTableID,
  displayName,
  eligibleRoomIndexes,
  guaranteedLootEntries,
  placeholderNotes = [],
} = {}) {
  return buildCalmDarkRoomExtractionNodeProfile({
    extractionNodeProfileID,
    lootTableID,
    displayName,
    eligibleRoomIndexes,
    eligibleTiers: [2],
    guaranteedLootEntries,
    placeholderNotes,
  });
}

function validateTier2AbyssalEncounterCatalog(catalogue = undefined) {
  return ABYSSAL_ENCOUNTER_RESOLVER
    .validateAuthoredEncounterCatalogue(2, catalogue);
}

function validateTier3AbyssalEncounterCatalog(catalogue = undefined) {
  return ABYSSAL_ENCOUNTER_RESOLVER
    .validateAuthoredEncounterCatalogue(3, catalogue);
}

function validateTier4AbyssalEncounterCatalog(catalogue = undefined) {
  return ABYSSAL_ENCOUNTER_RESOLVER
    .validateAuthoredEncounterCatalogue(4, catalogue);
}

function validateTier5AbyssalEncounterCatalog(catalogue = undefined) {
  return ABYSSAL_ENCOUNTER_RESOLVER
    .validateAuthoredEncounterCatalogue(5, catalogue);
}

function validateTier6AbyssalEncounterCatalog(catalogue = undefined) {
  return ABYSSAL_ENCOUNTER_RESOLVER
    .validateAuthoredEncounterCatalogue(6, catalogue);
}
function buildHigherTierRoomExtractionNodeProfile({
  tier,
  tierKey,
  tierLabel,
  roomIndex,
  guaranteedLootEntries,
} = {}) {
  return buildCalmDarkRoomExtractionNodeProfile({
    extractionNodeProfileID: `abyssal:extraction:${tierKey}-extraction-room${roomIndex}-v1`,
    lootTableID: `abyssal:loot:${tierKey}-extraction-room${roomIndex}-v1`,
    displayName: `${tierLabel} Room ${roomIndex} Side Loot Node`,
    eligibleRoomIndexes: [roomIndex],
    eligibleTiers: [tier],
    guaranteedLootEntries,
    placeholderNotes: [
      `${tierLabel} room ${roomIndex} uses the Calm extraction item composition with Tier ${tier} runtime scaling.`,
    ],
  });
}

const ABYSSAL_PLACEHOLDER_ROOM_ENCOUNTER_TEMPLATES_BY_ID = deepFreeze({
  abyssal_test_guristas_frigates: {
    encounterProfileID: "abyssal_test_guristas_frigates",
    encounterName: "Guristas Frigates (Placeholder)",
    factionTheme: "guristas",
    placeholderNotes: [
      "Uses the current known-safe Guristas missile frigate placeholder NPC.",
    ],
  },
  abyssal_test_weather_screen: {
    encounterProfileID: "abyssal_test_weather_screen",
    encounterName: "Weather Screen (Placeholder)",
    factionTheme: "weather_screen",
    placeholderNotes: [
      "Uses a weather-themed label while reusing the same safe combat NPC profile.",
    ],
  },
  abyssal_test_mixed_frigates: {
    encounterProfileID: "abyssal_test_mixed_frigates",
    encounterName: "Mixed Frigates (Placeholder)",
    factionTheme: "mixed",
    placeholderNotes: [
      "Mixed-room label only; additional safe NPC varieties are future work.",
    ],
  },
  abyssal_test_final_room_frigates: {
    encounterProfileID: "abyssal_test_final_room_frigates",
    encounterName: "Final Room Frigates (Placeholder)",
    factionTheme: "final_room",
    placeholderNotes: [
      "Final room uses conservative count scaling with the safe placeholder NPC.",
    ],
  },
});

const ABYSSAL_FILAMENT_DEFINITION_RESOLVER =
  createAbyssalFilamentDefinitionResolver({
    encounterResolver: ABYSSAL_ENCOUNTER_RESOLVER,
    proceduralContentInputs: {
      buildRewardProfile: buildAbyssalSpaceRewardProfile,
      coreMaterials: ABYSSAL_PROCEDURAL_REWARD_TYPES.coreMaterials,
      structureTypes: [49661, 49662].map((typeID) => resolveItemByTypeID(typeID)),
    },
    selectAuthoredAbyssalCapture,
    buildAgitatedTier2RoomEncounterProfiles,
    buildCalmDarkRequestedRoomEncounterProfiles,
    buildCalmDarkRoomRewardProfile,
    buildHigherTierRoomEncounterProfiles,
    buildPlaceholderCacheProfile,
    buildPlaceholderExtractionNodeProfile,
    buildPlaceholderExtractionNodeProfileFromTemplate,
    buildPlaceholderNpcProfile,
    buildPlaceholderRewardProfile,
    buildPlaceholderRewardProfileFromTemplate,
    buildPlaceholderRoomEncounterProfile,
    buildPlaceholderRoomEncounterProfilesForDefinition,
    buildPlaceholderRoomProfile,
    buildTranquilDarkProceduralRewardProfile,
    buildTranquilDarkRequestedRoomEncounterProfiles,
    buildTranquilRoomProfile,
    rewardContent: {
      ABYSSAL_CALM_BONUS_CACHE_LOOT_POOL,
      ABYSSAL_CALM_DARK_ROOM1_REWARD_PROFILE_ID,
      ABYSSAL_CALM_GOLDEN_CACHE_BASE_LOOT_ENTRIES,
      ABYSSAL_CALM_GOLDEN_FILAMENT_CACHE_LOOT_POOL,
      ABYSSAL_SPACE_TIER0_REWARD_PROFILE_BY_WEATHER,
      ABYSSAL_SPACE_TIER1_REWARD_PROFILE_BY_WEATHER,
      ABYSSAL_SPACE_TIER2_REWARD_PROFILE_BY_WEATHER,
      ABYSSAL_SPACE_TIER3_REWARD_PROFILE_BY_WEATHER,
      ABYSSAL_SPACE_TIER4_REWARD_PROFILE_BY_WEATHER,
      ABYSSAL_SPACE_TIER5_REWARD_PROFILE_BY_WEATHER,
      ABYSSAL_SPACE_TIER6_REWARD_PROFILE_BY_WEATHER,
    },
  });

const {
  auditAbyssalFilamentCompleteness,
  auditAbyssalFilamentDefinitions,
  buildTierMetadata,
  buildWeatherProfile,
  listProductionSupportedFilamentDefinitions,
  listSupportedFilamentDefinitions,
  resolveFilamentDefinition,
  resolvePersistedFilamentDefinition,
  shouldUseCorrelatedAbyssalSpaceEmpiricalContent,
  shouldUseTier0AbyssalSpaceEmpiricalContent,
  shouldUseTier1AbyssalSpaceEmpiricalContent,
  shouldUseTier2AbyssalSpaceEmpiricalContent,
  shouldUseTier3AbyssalSpaceEmpiricalContent,
  shouldUseTier4AbyssalSpaceEmpiricalContent,
  shouldUseTier5AbyssalSpaceEmpiricalContent,
  shouldUseTier6AbyssalSpaceEmpiricalContent,
  validateResolvedAbyssalContentDefinition,
} = ABYSSAL_FILAMENT_DEFINITION_RESOLVER;

const auditEvents = [];
let reportProvider = null;

function recordAuditEvent(kind, args = [], session = null, details = {}) {
  auditEvents.push({
    kind,
    args: cloneArgs(args),
    characterID: getCharacterID(session) || null,
    details: { ...details },
    timestamp: Date.now(),
  });
}

const ABYSSAL_CONTENT_MANAGER_CLIENT_RPC_METHODS = new Set([
  "generate_abyss_npc_spawn_report",
]);

class AbyssalContentManagerService extends BaseService {
  constructor() {
    super("abyssal_content_manager");
    if (toBoolean(process.env.EVEJS_ABYSSAL_CONTENT_DIAGNOSTICS, false)) {
      const audit = getAuthoredAbyssalContentAudit();
      const spawnAudit =
        ABYSSAL_ENCOUNTER_RESOLVER.getObservedAbyssalNpcSpawnAudit();
      log.info(
        `[AbyssalContentManager] Authored content captures=${audit.captureCount} ` +
          `rooms=${audit.roomCount} runtimeReady=${audit.runtimeReadyCaptureIDs.length} ` +
          `dependencyIncomplete=${audit.dependencyIncompleteCaptures.length} ` +
          `unsupportedNpcTypeIDs=${audit.unsupportedNpcTypeIDs.join(",") || "none"} ` +
          `unsupportedMechanics=${audit.unsupportedMechanicIDs.join(",") || "none"}`,
      );
      log.info(
        `[AbyssalContentManager] QSNA spawn tables ` +
          `combinations=${spawnAudit.summary.combinationCount} ` +
          `families=${spawnAudit.summary.validFamilyCount} ` +
          `runtimeReady=${spawnAudit.runtimeReadyVariantCount} ` +
          `unavailable=${spawnAudit.unavailableVariantCount} ` +
          `unresolvedNpcs=${spawnAudit.summary.unresolvedNpcCount}`,
      );
    }
  }

  callMethod(method, args, session, kwargs) {
    const normalizedMethod = BaseService.normalizeMethodName(method);
    if (!ABYSSAL_CONTENT_MANAGER_CLIENT_RPC_METHODS.has(normalizedMethod)) {
      log.warn(
        `[AbyssalContentManager] Rejected non-client RPC method=${JSON.stringify(normalizedMethod)}`,
      );
      return null;
    }
    return super.callMethod(normalizedMethod, args, session, kwargs);
  }

  Handle_generate_abyss_npc_spawn_report(args, session) {
    const difficultyTier = toInteger(args && args[0], 0);
    const spawnTableID = toInteger(args && args[1], 0);
    const repetitions = Math.min(
      MAX_REPETITIONS,
      Math.max(0, toInteger(args && args[2], 0)),
    );

    if (typeof reportProvider === "function") {
      const provided = reportProvider({
        difficultyTier,
        spawnTableID,
        repetitions,
        session,
      });
      const report = normalizeReport(
        provided,
        difficultyTier,
        spawnTableID,
        repetitions,
      );
      recordAuditEvent("abyssal_spawn_report_fixture_returned", args, session, {
        difficultyTier,
        spawnTableID,
        repetitions,
        spawnCount: report.spawns.length,
      });
      return marshalReport(report);
    }

    recordAuditEvent("abyssal_spawn_report_empty", args, session, {
      difficultyTier,
      spawnTableID,
      repetitions,
    });
    log.debug(
      "[AbyssalContentManager] Returning empty NPC spawn report: authored Abyssal spawn tables are unavailable",
    );
    return marshalReport(buildEmptyReport(difficultyTier, spawnTableID, repetitions));
  }
}

AbyssalContentManagerService._testing = {
  filamentDefinitionResolver: ABYSSAL_FILAMENT_DEFINITION_RESOLVER,
  buildEmptyReport,
  marshalReport,
  buildTierMetadata,
  buildWeatherProfile,
  buildPlaceholderCacheProfile,
  buildPlaceholderRewardProfile,
  buildPlaceholderExtractionNodeProfile,
  resolveFilamentDefinition,
  listSupportedFilamentDefinitions,
  listProductionSupportedFilamentDefinitions,
  get encounterTemplatesByID() {
    return cloneValue(ABYSSAL_PLACEHOLDER_ROOM_ENCOUNTER_TEMPLATES_BY_ID);
  },
  get extractionNodeProfilesByID() {
    return cloneValue(ABYSSAL_PLACEHOLDER_EXTRACTION_NODE_PROFILES_BY_ID);
  },
  get rewardProfilesByID() {
    return cloneValue(ABYSSAL_PLACEHOLDER_REWARD_PROFILES_BY_ID);
  },
  get rewardStructurePresentationProfile() {
    return cloneValue(ABYSSAL_REWARD_STRUCTURE_PRESENTATION_PROFILE);
  },
  get tierMetadataByTier() {
    return ABYSSAL_FILAMENT_DEFINITION_RESOLVER.getTierMetadataByTier();
  },
  get weatherMetadataByType() {
    return ABYSSAL_FILAMENT_DEFINITION_RESOLVER.getWeatherMetadataByType();
  },
  get safeNpcCatalogByProfileID() {
    return cloneValue(ABYSSAL_SAFE_NPC_CATALOG_BY_PROFILE_ID);
  },
  get observedAbyssalNpcSpawnAudit() {
    return ABYSSAL_ENCOUNTER_RESOLVER.getObservedAbyssalNpcSpawnAudit();
  },
  selectObservedAbyssalEncounterProfile,
  listObservedTier0AbyssalEncounterProfiles,
  listObservedTier1AbyssalEncounterProfiles,
  listObservedTier2AbyssalEncounterProfiles,
  listObservedTier3AbyssalEncounterProfiles,
  listObservedTier4AbyssalEncounterProfiles,
  listObservedTier5AbyssalEncounterProfiles,
  listObservedTier6AbyssalEncounterProfiles,
  resolveSafeAbyssalNpcCatalogEntry,
  getAbyssalNpcProfileValidationReport,
  getAbyssalNpcEncounterTierAdmissionReport,
  listAuthoredAbyssalCaptures,
  resolveAuthoredAbyssalCaptureByID,
  selectAuthoredAbyssalCapture,
  getAuthoredAbyssalContentAudit,
  shouldUseTier0AbyssalSpaceEmpiricalContent,
  shouldUseTier1AbyssalSpaceEmpiricalContent,
  shouldUseTier2AbyssalSpaceEmpiricalContent,
  shouldUseTier3AbyssalSpaceEmpiricalContent,
  shouldUseTier4AbyssalSpaceEmpiricalContent,
  shouldUseTier5AbyssalSpaceEmpiricalContent,
  shouldUseTier6AbyssalSpaceEmpiricalContent,
  shouldUseCorrelatedAbyssalSpaceEmpiricalContent,
  resolveAbyssalEncounterTierBand,
  resolveAbyssalEncounterVariety,
  listTier0AbyssalEncounterProfiles,
  getAbyssalSpaceEncounterPartition,
  listTier1AbyssalEncounterProfiles,
  listTier2AbyssalEncounterProfiles,
  listTier3AbyssalEncounterProfiles,
  listTier4AbyssalEncounterProfiles,
  listTier5AbyssalEncounterProfiles,
  listTier6AbyssalEncounterProfiles,
  listTier1AbyssalLegacyEncounterProfiles,
  validateTier0AbyssalEncounterCatalog,
  validateTier1AbyssalEncounterCatalog,
  validateTier2AbyssalEncounterCatalog,
  validateTier3AbyssalEncounterCatalog,
  validateTier4AbyssalEncounterCatalog,
  validateTier5AbyssalEncounterCatalog,
  validateTier6AbyssalEncounterCatalog,
  isTier0CombinedEncounterProfile,
  isTier0AbyssalSpaceEncounterProfile,
  isTier1AbyssalSpaceEncounterProfile,
  isTier2AbyssalSpaceEncounterProfile,
  isTier3AbyssalSpaceEncounterProfile,
  isTier4AbyssalSpaceEncounterProfile,
  isTier5AbyssalSpaceEncounterProfile,
  isTier6AbyssalSpaceEncounterProfile,
  isSupportedAbyssalExtractionEncounter,
  isTier1CombinedEncounterProfile,
  isTier2CombinedEncounterProfile,
  isHigherTierCombinedEncounterProfile,
  summarizeTier1CombinedEncounterComposition,
  summarizeTier2CombinedEncounterComposition,
  summarizeHigherTierCombinedEncounterComposition,
  ABYSSAL_TIER0_COMBINED_ENCOUNTER_THEME,
  ABYSSAL_TIER1_COMBINED_ENCOUNTER_THEME,
  ABYSSAL_TIER2_COMBINED_ENCOUNTER_THEME,
  ABYSSAL_TIER3_COMBINED_ENCOUNTER_THEME,
  ABYSSAL_TIER4_COMBINED_ENCOUNTER_THEME,
  ABYSSAL_TIER5_COMBINED_ENCOUNTER_THEME,
  ABYSSAL_TIER6_COMBINED_ENCOUNTER_THEME,
  get ABYSSAL_TIER0_APPROVED_TYPE_IDS() {
    return cloneValue(ABYSSAL_TIER0_APPROVED_TYPE_IDS);
  },
  get ABYSSAL_TIER1_APPROVED_TYPE_IDS() {
    return cloneValue(ABYSSAL_TIER1_APPROVED_TYPE_IDS);
  },
  get ABYSSAL_TIER2_APPROVED_TYPE_IDS() {
    return cloneValue(ABYSSAL_TIER2_APPROVED_TYPE_IDS);
  },
  get ABYSSAL_HIGHER_TIER_APPROVED_TYPE_IDS() {
    return cloneValue(ABYSSAL_HIGHER_TIER_APPROVED_TYPE_IDS);
  },
  buildPlaceholderEncounterNpcEntry,
  buildPlaceholderRoomEncounterProfile,
  buildPlaceholderRoomEncounterProfilesForDefinition,
  getAuditEvents() {
    return auditEvents.map((entry) => ({
      ...entry,
      details: { ...(entry.details || {}) },
    }));
  },
  resetForTests() {
    auditEvents.length = 0;
    reportProvider = null;
  },
  setReportProviderForTests(provider) {
    reportProvider = typeof provider === "function" ? provider : null;
  },
};

module.exports = AbyssalContentManagerService;
module.exports.buildPlaceholderRewardProfile = buildPlaceholderRewardProfile;
module.exports.buildPlaceholderExtractionNodeProfile = buildPlaceholderExtractionNodeProfile;
module.exports.resolveAbyssalSpaceRewardProfile =
  resolveAbyssalSpaceRewardProfile;
module.exports.resolveFilamentDefinition = resolveFilamentDefinition;
module.exports.resolvePersistedFilamentDefinition = resolvePersistedFilamentDefinition;
module.exports.shouldUseCorrelatedAbyssalSpaceEmpiricalContent = shouldUseCorrelatedAbyssalSpaceEmpiricalContent;
module.exports.listSupportedFilamentDefinitions = listSupportedFilamentDefinitions;
module.exports.listProductionSupportedFilamentDefinitions =
  listProductionSupportedFilamentDefinitions;
module.exports.auditAbyssalFilamentDefinitions = auditAbyssalFilamentDefinitions;
module.exports.auditAbyssalFilamentCompleteness =
  auditAbyssalFilamentCompleteness;
module.exports.buildAbyssalContentCompletenessReport =
  buildAbyssalContentCompletenessReport;
module.exports.validateResolvedAbyssalContentDefinition =
  validateResolvedAbyssalContentDefinition;
module.exports.getAbyssalNpcProfileValidationReport = getAbyssalNpcProfileValidationReport;
module.exports.getAbyssalNpcEncounterTierAdmissionReport =
  getAbyssalNpcEncounterTierAdmissionReport;
module.exports.listAuthoredAbyssalCaptures = listAuthoredAbyssalCaptures;
module.exports.resolveAuthoredAbyssalCaptureByID = resolveAuthoredAbyssalCaptureByID;
module.exports.selectAuthoredAbyssalCapture = selectAuthoredAbyssalCapture;
module.exports.getAuthoredAbyssalContentAudit = getAuthoredAbyssalContentAudit;
module.exports.shouldUseTier0AbyssalSpaceEmpiricalContent =
  shouldUseTier0AbyssalSpaceEmpiricalContent;
module.exports.shouldUseTier1AbyssalSpaceEmpiricalContent =
  shouldUseTier1AbyssalSpaceEmpiricalContent;
module.exports.shouldUseTier2AbyssalSpaceEmpiricalContent =
  shouldUseTier2AbyssalSpaceEmpiricalContent;
module.exports.shouldUseTier3AbyssalSpaceEmpiricalContent =
  shouldUseTier3AbyssalSpaceEmpiricalContent;
module.exports.shouldUseTier4AbyssalSpaceEmpiricalContent =
  shouldUseTier4AbyssalSpaceEmpiricalContent;
module.exports.shouldUseTier5AbyssalSpaceEmpiricalContent =
  shouldUseTier5AbyssalSpaceEmpiricalContent;
module.exports.shouldUseTier6AbyssalSpaceEmpiricalContent =
  shouldUseTier6AbyssalSpaceEmpiricalContent;
module.exports.listTier0AbyssalEncounterProfiles = listTier0AbyssalEncounterProfiles;
module.exports.getAbyssalSpaceEncounterPartition =
  getAbyssalSpaceEncounterPartition;
module.exports.listTier1AbyssalEncounterProfiles = listTier1AbyssalEncounterProfiles;
module.exports.listTier2AbyssalEncounterProfiles = listTier2AbyssalEncounterProfiles;
module.exports.listTier3AbyssalEncounterProfiles = listTier3AbyssalEncounterProfiles;
module.exports.listTier4AbyssalEncounterProfiles = listTier4AbyssalEncounterProfiles;
module.exports.listTier5AbyssalEncounterProfiles = listTier5AbyssalEncounterProfiles;
module.exports.listTier6AbyssalEncounterProfiles = listTier6AbyssalEncounterProfiles;
module.exports.listObservedTier0AbyssalEncounterProfiles = listObservedTier0AbyssalEncounterProfiles;
module.exports.listObservedTier1AbyssalEncounterProfiles = listObservedTier1AbyssalEncounterProfiles;
module.exports.listObservedTier2AbyssalEncounterProfiles = listObservedTier2AbyssalEncounterProfiles;
module.exports.listObservedTier3AbyssalEncounterProfiles = listObservedTier3AbyssalEncounterProfiles;
module.exports.listObservedTier4AbyssalEncounterProfiles = listObservedTier4AbyssalEncounterProfiles;
module.exports.listObservedTier5AbyssalEncounterProfiles = listObservedTier5AbyssalEncounterProfiles;
module.exports.listObservedTier6AbyssalEncounterProfiles = listObservedTier6AbyssalEncounterProfiles;
module.exports.selectObservedAbyssalEncounterProfile = selectObservedAbyssalEncounterProfile;
module.exports.validateObservedAbyssalNpcSpawnCoverage =
  validateObservedAbyssalNpcSpawnCoverage;
module.exports.listTier1AbyssalLegacyEncounterProfiles = listTier1AbyssalLegacyEncounterProfiles;
module.exports.validateTier0AbyssalEncounterCatalog = validateTier0AbyssalEncounterCatalog;
module.exports.validateTier1AbyssalEncounterCatalog = validateTier1AbyssalEncounterCatalog;
module.exports.validateTier2AbyssalEncounterCatalog = validateTier2AbyssalEncounterCatalog;
module.exports.validateTier3AbyssalEncounterCatalog = validateTier3AbyssalEncounterCatalog;
module.exports.validateTier4AbyssalEncounterCatalog = validateTier4AbyssalEncounterCatalog;
module.exports.validateTier5AbyssalEncounterCatalog = validateTier5AbyssalEncounterCatalog;
module.exports.validateTier6AbyssalEncounterCatalog = validateTier6AbyssalEncounterCatalog;
module.exports.isTier0CombinedEncounterProfile = isTier0CombinedEncounterProfile;
module.exports.isTier0AbyssalSpaceEncounterProfile = isTier0AbyssalSpaceEncounterProfile;
module.exports.isTier1AbyssalSpaceEncounterProfile =
  isTier1AbyssalSpaceEncounterProfile;
module.exports.isTier2AbyssalSpaceEncounterProfile =
  isTier2AbyssalSpaceEncounterProfile;
module.exports.isTier3AbyssalSpaceEncounterProfile =
  isTier3AbyssalSpaceEncounterProfile;
module.exports.isTier4AbyssalSpaceEncounterProfile =
  isTier4AbyssalSpaceEncounterProfile;
module.exports.isTier5AbyssalSpaceEncounterProfile =
  isTier5AbyssalSpaceEncounterProfile;
module.exports.isTier6AbyssalSpaceEncounterProfile =
  isTier6AbyssalSpaceEncounterProfile;
module.exports.isSupportedAbyssalExtractionEncounter =
  isSupportedAbyssalExtractionEncounter;
module.exports.isTier1CombinedEncounterProfile = isTier1CombinedEncounterProfile;
module.exports.isTier2CombinedEncounterProfile = isTier2CombinedEncounterProfile;
module.exports.isHigherTierCombinedEncounterProfile = isHigherTierCombinedEncounterProfile;
module.exports.summarizeTier1CombinedEncounterComposition = summarizeTier1CombinedEncounterComposition;
module.exports.summarizeTier2CombinedEncounterComposition = summarizeTier2CombinedEncounterComposition;
module.exports.summarizeHigherTierCombinedEncounterComposition = summarizeHigherTierCombinedEncounterComposition;
module.exports.ABYSSAL_TIER0_COMBINED_ENCOUNTER_THEME = ABYSSAL_TIER0_COMBINED_ENCOUNTER_THEME;
module.exports.ABYSSAL_TIER1_COMBINED_ENCOUNTER_THEME = ABYSSAL_TIER1_COMBINED_ENCOUNTER_THEME;
module.exports.ABYSSAL_TIER2_COMBINED_ENCOUNTER_THEME = ABYSSAL_TIER2_COMBINED_ENCOUNTER_THEME;
module.exports.ABYSSAL_TIER3_COMBINED_ENCOUNTER_THEME = ABYSSAL_TIER3_COMBINED_ENCOUNTER_THEME;
module.exports.ABYSSAL_TIER4_COMBINED_ENCOUNTER_THEME = ABYSSAL_TIER4_COMBINED_ENCOUNTER_THEME;
module.exports.ABYSSAL_TIER5_COMBINED_ENCOUNTER_THEME = ABYSSAL_TIER5_COMBINED_ENCOUNTER_THEME;
module.exports.ABYSSAL_TIER6_COMBINED_ENCOUNTER_THEME = ABYSSAL_TIER6_COMBINED_ENCOUNTER_THEME;
module.exports.ABYSSAL_SPACE_TIER0_CATALOGUE_ID = ABYSSAL_SPACE_TIER0_CATALOGUE_ID;
module.exports.ABYSSAL_SPACE_TIER1_CATALOGUE_ID =
  ABYSSAL_SPACE_TIER1_CATALOGUE_ID;
module.exports.ABYSSAL_SPACE_TIER2_CATALOGUE_ID =
  ABYSSAL_SPACE_TIER2_CATALOGUE_ID;
module.exports.ABYSSAL_SPACE_TIER3_CATALOGUE_ID =
  ABYSSAL_SPACE_TIER3_CATALOGUE_ID;
module.exports.ABYSSAL_SPACE_TIER4_CATALOGUE_ID =
  ABYSSAL_SPACE_TIER4_CATALOGUE_ID;
module.exports.ABYSSAL_SPACE_TIER5_CATALOGUE_ID =
  ABYSSAL_SPACE_TIER5_CATALOGUE_ID;
module.exports.ABYSSAL_SPACE_TIER6_CATALOGUE_ID =
  ABYSSAL_SPACE_TIER6_CATALOGUE_ID;
module.exports.isObservedAbyssalEncounterProfile = isObservedAbyssalEncounterProfile;
module.exports.getObservedAbyssalNpcSpawnAudit = function getObservedAbyssalNpcSpawnAudit() {
  return ABYSSAL_ENCOUNTER_RESOLVER.getObservedAbyssalNpcSpawnAudit();
};
