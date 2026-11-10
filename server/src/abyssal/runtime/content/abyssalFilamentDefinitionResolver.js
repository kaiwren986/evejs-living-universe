"use strict";

const { ONE_AU_IN_METERS } = require("../../../space/npc/npcWarpOrigins");
const { cloneValue, deepFreeze } = require("../../domain/abyssalValueUtils");
const {
  ABYSSAL_CONTENT_AUTHORITY,
  ABYSSAL_CONTENT_VALIDATION_AUTHORITY,
  ABYSSAL_CONTENT_COMPLETENESS_POLICY,
  ABYSSAL_CONTENT_COMPLETENESS_STATUS,
  ABYSSAL_CONTENT_COMPLETENESS_LEVEL,
  ABYSSAL_CONTENT_COMPONENT_REQUIREMENT,
  auditResolvedAbyssalContentCompleteness,
  buildAbyssalContentCompletenessReport,
  validateAbyssalContentAuthority,
  validateAbyssalContentCompletenessLevel,
  validateAbyssalContentCompletenessPolicy,
  validateResolvedFilamentCompleteness,
} = require("../../catalog/abyssalContentAuthority");
const {
  CATALOGUE_ID: ABYSSAL_SPACE_TIER0_CATALOGUE_ID,
  TIER1_CATALOGUE_ID: ABYSSAL_SPACE_TIER1_CATALOGUE_ID,
  TIER2_CATALOGUE_ID: ABYSSAL_SPACE_TIER2_CATALOGUE_ID,
  TIER3_CATALOGUE_ID: ABYSSAL_SPACE_TIER3_CATALOGUE_ID,
  TIER4_CATALOGUE_ID: ABYSSAL_SPACE_TIER4_CATALOGUE_ID,
  TIER5_CATALOGUE_ID: ABYSSAL_SPACE_TIER5_CATALOGUE_ID,
  TIER6_CATALOGUE_ID: ABYSSAL_SPACE_TIER6_CATALOGUE_ID,
} = require("../../catalog/content/abyssalTelemetryCatalogueIdentity");
const { buildCapturedRoomEncounterProfiles } = require("./abyssalEncounterResolver");
const {
  SHARED_ABYSSAL_ENTRANCE_TRACE_PROFILE_ID,
  SHARED_ABYSSAL_ENTRANCE_TRACE_PROFILE,
  T0_DARK_FILAMENT_TYPE_ID,
  T0_TRANQUIL_FILAMENT_TYPE_IDS,
} = require("../../catalog/abyssalTraceProfiles");
const {
  ENVIRONMENTAL_EVIDENCE,
  listT0TranquilWeatherPresentationStages,
} = require("../../catalog/abyssalEnvironmentalCatalog");
const { resolveAbyssalEnvironmentProfile } = require("../../catalog/abyssalEnvironmentProfiles");
const {
  getDarkWeatherStage,
  listAllowedDarkWeatherStagesForTier,
  listDarkWeatherStageWeightsForTier,
} = require("../../catalog/abyssalDarkWeatherCatalog");
const { UNSTABLE_ABYSSAL_DEPTHS_BOUNDARY_PROFILE } = require("../../domain/abyssalBoundaryProfile");
const { SHORT_RANGE_SUPPRESSOR_MECHANICS_PROFILE } = require("../../catalog/abyssalSuppressorMechanicsProfile");
const { T0_DARK_TRANSITION_PROFILES } = require("../../catalog/abyssalTransitionProfiles");
const {
  buildContentGenerationIdentity,
  matchesContentGenerationIdentity,
  CONTENT_GENERATION_MODELS,
  PROCEDURAL_CONTENT_GENERATION_MODELS,
  PROCEDURAL_CONTENT_GENERATION_MODELS_V1,
} = require("../../catalog/content/abyssalContentGenerationIdentity");
const { composeProceduralContent, composeProceduralContentV1 } = require("../../catalog/content/abyssalProceduralContentComposer");

function toInteger(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function toBoolean(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => String(entry || "")).filter(Boolean);
}

function normalizeIntegerArray(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => toInteger(entry, 0))
    .filter((entry) => entry > 0);
}

function normalizeHullMode(value) {
  return String(value || "").trim().toLowerCase();
}
const {
  bindAbyssalFilamentMetadataOperations,
  initializeAbyssalFilamentMetadata,
} = require("../../catalog/content/abyssalFilamentMetadata");
const { initializeAbyssalFilamentDefinitions } = require("../../catalog/content/abyssalFilamentDefinitions");
const { bindAbyssalFilamentCompletenessCoreOperations } = require("../../catalog/content/abyssalFilamentCompletenessCore");
const { bindAbyssalFilamentCompletenessDetailOperations } = require("../../catalog/content/abyssalFilamentCompletenessDetails");
const { bindAbyssalFilamentResolutionOperations } = require("../../catalog/content/abyssalFilamentResolution");

function createAbyssalFilamentResolverScope(dependencies) {
const {
    encounterResolver: ABYSSAL_ENCOUNTER_RESOLVER,
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
    rewardContent = {},
    proceduralContentInputs,
  } = dependencies;
const {
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
  } = rewardContent;
const {
    isTier0AbyssalSpaceEncounterProfile,
    isTier1AbyssalSpaceEncounterProfile,
    isTier2AbyssalSpaceEncounterProfile,
    isTier3AbyssalSpaceEncounterProfile,
    isTier4AbyssalSpaceEncounterProfile,
    isTier5AbyssalSpaceEncounterProfile,
    isTier6AbyssalSpaceEncounterProfile,
  } = ABYSSAL_ENCOUNTER_RESOLVER;
  return {
    ABYSSAL_CALM_BONUS_CACHE_LOOT_POOL,
    ABYSSAL_CALM_DARK_ROOM1_REWARD_PROFILE_ID,
    ABYSSAL_CALM_GOLDEN_CACHE_BASE_LOOT_ENTRIES,
    ABYSSAL_CALM_GOLDEN_FILAMENT_CACHE_LOOT_POOL,
    ABYSSAL_CONTENT_AUTHORITY,
    ABYSSAL_CONTENT_COMPLETENESS_LEVEL,
    ABYSSAL_CONTENT_COMPLETENESS_POLICY,
    ABYSSAL_CONTENT_COMPLETENESS_STATUS,
    ABYSSAL_CONTENT_COMPONENT_REQUIREMENT,
    ABYSSAL_CONTENT_VALIDATION_AUTHORITY,
    ABYSSAL_ENCOUNTER_RESOLVER,
    ABYSSAL_SPACE_TIER0_CATALOGUE_ID,
    ABYSSAL_SPACE_TIER0_REWARD_PROFILE_BY_WEATHER,
    ABYSSAL_SPACE_TIER1_CATALOGUE_ID,
    ABYSSAL_SPACE_TIER1_REWARD_PROFILE_BY_WEATHER,
    ABYSSAL_SPACE_TIER2_CATALOGUE_ID,
    ABYSSAL_SPACE_TIER2_REWARD_PROFILE_BY_WEATHER,
    ABYSSAL_SPACE_TIER3_CATALOGUE_ID,
    ABYSSAL_SPACE_TIER3_REWARD_PROFILE_BY_WEATHER,
    ABYSSAL_SPACE_TIER4_CATALOGUE_ID,
    ABYSSAL_SPACE_TIER4_REWARD_PROFILE_BY_WEATHER,
    ABYSSAL_SPACE_TIER5_CATALOGUE_ID,
    ABYSSAL_SPACE_TIER5_REWARD_PROFILE_BY_WEATHER,
    ABYSSAL_SPACE_TIER6_CATALOGUE_ID,
    ABYSSAL_SPACE_TIER6_REWARD_PROFILE_BY_WEATHER,
    CONTENT_GENERATION_MODELS,
    ENVIRONMENTAL_EVIDENCE,
    ONE_AU_IN_METERS,
    PROCEDURAL_CONTENT_GENERATION_MODELS,
    PROCEDURAL_CONTENT_GENERATION_MODELS_V1,
    SHARED_ABYSSAL_ENTRANCE_TRACE_PROFILE,
    SHARED_ABYSSAL_ENTRANCE_TRACE_PROFILE_ID,
    SHORT_RANGE_SUPPRESSOR_MECHANICS_PROFILE,
    T0_DARK_FILAMENT_TYPE_ID,
    T0_DARK_TRANSITION_PROFILES,
    T0_TRANQUIL_FILAMENT_TYPE_IDS,
    UNSTABLE_ABYSSAL_DEPTHS_BOUNDARY_PROFILE,
    auditResolvedAbyssalContentCompleteness,
    buildAbyssalContentCompletenessReport,
    buildAgitatedTier2RoomEncounterProfiles,
    buildCalmDarkRequestedRoomEncounterProfiles,
    buildCalmDarkRoomRewardProfile,
    buildCapturedRoomEncounterProfiles,
    buildContentGenerationIdentity,
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
    cloneValue,
    composeProceduralContent,
    composeProceduralContentV1,
    deepFreeze,
    getDarkWeatherStage,
    isTier0AbyssalSpaceEncounterProfile,
    isTier1AbyssalSpaceEncounterProfile,
    isTier2AbyssalSpaceEncounterProfile,
    isTier3AbyssalSpaceEncounterProfile,
    isTier4AbyssalSpaceEncounterProfile,
    isTier5AbyssalSpaceEncounterProfile,
    isTier6AbyssalSpaceEncounterProfile,
    listAllowedDarkWeatherStagesForTier,
    listDarkWeatherStageWeightsForTier,
    listT0TranquilWeatherPresentationStages,
    matchesContentGenerationIdentity,
    normalizeHullMode,
    normalizeIntegerArray,
    normalizeStringArray,
    proceduralContentInputs,
    resolveAbyssalEnvironmentProfile,
    rewardContent,
    selectAuthoredAbyssalCapture,
    toBoolean,
    toInteger,
    validateAbyssalContentAuthority,
    validateAbyssalContentCompletenessLevel,
    validateAbyssalContentCompletenessPolicy,
    validateResolvedFilamentCompleteness,
  };
}

function createAbyssalFilamentDefinitionResolver(dependencies = {}) {
  const scope = createAbyssalFilamentResolverScope(dependencies);
  bindAbyssalFilamentMetadataOperations(scope);
  bindAbyssalFilamentCompletenessCoreOperations(scope);
  bindAbyssalFilamentCompletenessDetailOperations(scope);
  bindAbyssalFilamentResolutionOperations(scope);
  initializeAbyssalFilamentMetadata(scope);
  initializeAbyssalFilamentDefinitions(scope);
  return Object.freeze({
    auditAbyssalFilamentCompleteness: scope.auditAbyssalFilamentCompleteness,
    auditAbyssalFilamentDefinitions: scope.auditAbyssalFilamentDefinitions,
    buildResolvedContentComponents: scope.buildResolvedContentComponents,
    buildResolvedContentGovernance: scope.buildResolvedContentGovernance,
    buildResolvedDefinition: scope.buildResolvedDefinition,
    buildTierMetadata: scope.buildTierMetadata,
    buildWeatherProfile: scope.buildWeatherProfile,
    getProductionDefinitionIdentityManifest: scope.getProductionDefinitionIdentityManifest,
    getTierMetadataByTier() {
      return (0, scope.cloneValue)(scope.ABYSSAL_TIER_METADATA_BY_TIER);
    },
    getWeatherMetadataByType() {
      return (0, scope.cloneValue)(scope.ABYSSAL_WEATHER_METADATA_BY_TYPE);
    },
    listProductionSupportedFilamentDefinitions: scope.listProductionSupportedFilamentDefinitions,
    listSupportedFilamentDefinitions: scope.listSupportedFilamentDefinitions,
    // Resolve under a named generation model ("hybrid", "procedural-v1",
    // "procedural"): what a saved reference of that model would rebuild.
    resolveDefinition: scope.resolveDefinition,
    resolveFilamentDefinition: scope.resolveFilamentDefinition,
    resolvePersistedFilamentDefinition: scope.resolvePersistedFilamentDefinition,
    resolveFilamentDefinitionByTierWeather: scope.resolveFilamentDefinitionByTierWeather,
    shouldUseCorrelatedAbyssalSpaceEmpiricalContent: scope.shouldUseCorrelatedAbyssalSpaceEmpiricalContent,
    shouldUseTier0AbyssalSpaceEmpiricalContent: scope.shouldUseTier0AbyssalSpaceEmpiricalContent,
    shouldUseTier1AbyssalSpaceEmpiricalContent: scope.shouldUseTier1AbyssalSpaceEmpiricalContent,
    shouldUseTier2AbyssalSpaceEmpiricalContent: scope.shouldUseTier2AbyssalSpaceEmpiricalContent,
    shouldUseTier3AbyssalSpaceEmpiricalContent: scope.shouldUseTier3AbyssalSpaceEmpiricalContent,
    shouldUseTier4AbyssalSpaceEmpiricalContent: scope.shouldUseTier4AbyssalSpaceEmpiricalContent,
    shouldUseTier5AbyssalSpaceEmpiricalContent: scope.shouldUseTier5AbyssalSpaceEmpiricalContent,
    shouldUseTier6AbyssalSpaceEmpiricalContent: scope.shouldUseTier6AbyssalSpaceEmpiricalContent,
    validateResolvedAbyssalContentDefinition: scope.validateResolvedAbyssalContentDefinition,
  });
}

module.exports = {
  createAbyssalFilamentDefinitionResolver,
};
