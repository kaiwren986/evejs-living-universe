"use strict";

const {
  ABYSSAL_AUTHORED_NPC_PROFILES_BY_TYPE_ID,
  ABYSSAL_CALM_WEATHER_TYPES,
  ABYSSAL_CONTENT_AUTHORITY,
  ABYSSAL_CONTENT_COMPLETENESS_STATUS,
  ABYSSAL_EXPLICIT_PLACEHOLDER_NPC_PROFILE_ID,
  ABYSSAL_HIGHER_TIER_APPROVED_TYPE_IDS,
  ABYSSAL_HIGHER_TIER_ENCOUNTER_THEME_BY_TIER,
  ABYSSAL_HIGHER_TIER_KEY_BY_TIER,
  ABYSSAL_HIGHER_TIER_LABEL_BY_TIER,
  ABYSSAL_NPC_COMPLETENESS_AUDIT_CACHE,
  ABYSSAL_SAFE_NPC_CANDIDATE_SPECS_BY_ID,
  ABYSSAL_SAFE_NPC_CATALOG_BY_PROFILE_ID,
  ABYSSAL_SAFE_NPC_PROFILES_BY_TYPE_ID,
  ABYSSAL_SPACE_ENCOUNTER_CATALOG_BY_TIER,
  ABYSSAL_SPACE_ENCOUNTER_PARTITION_INDEX,
  ABYSSAL_SPACE_TIER0_CATALOGUE_ID,
  ABYSSAL_SPACE_TIER1_CATALOGUE_ID,
  ABYSSAL_SPACE_TIER2_CATALOGUE_ID,
  ABYSSAL_SPACE_TIER3_CATALOGUE_ID,
  ABYSSAL_SPACE_TIER4_CATALOGUE_ID,
  ABYSSAL_SPACE_TIER5_CATALOGUE_ID,
  ABYSSAL_SPACE_TIER6_CATALOGUE_ID,
  ABYSSAL_TIER0_APPROVED_TYPE_IDS,
  ABYSSAL_TIER0_COMBINED_ENCOUNTER_THEME,
  ABYSSAL_TIER0_TELEMETRY_ONLY_NPC_TYPE_IDS,
  ABYSSAL_TIER1_APPROVED_TYPE_IDS,
  ABYSSAL_TIER1_COMBINED_ENCOUNTER_THEME,
  ABYSSAL_TIER1_ENCOUNTER_MAX_NPC_COUNT,
  ABYSSAL_TIER1_NEEDLE_DRONE_FACTION_ID,
  ABYSSAL_TIER1_NEEDLE_DRONE_GROUP_ID,
  ABYSSAL_TIER1_TRIGLAVIAN_FACTION_ID,
  ABYSSAL_TIER1_TRIGLAVIAN_FRIGATE_GROUP_ID,
  ABYSSAL_TIER2_APPROVED_TYPE_IDS,
  ABYSSAL_TIER2_COMBINED_ENCOUNTER_THEME,
  ABYSSAL_TIER3_COMBINED_ENCOUNTER_THEME,
  ABYSSAL_TIER4_COMBINED_ENCOUNTER_THEME,
  ABYSSAL_TIER5_COMBINED_ENCOUNTER_THEME,
  ABYSSAL_TIER6_COMBINED_ENCOUNTER_THEME,
  EMPTY_ABYSSAL_SPACE_ENCOUNTER_PARTITION,
  OBSERVED_ABYSSAL_ENCOUNTER_THEME_BY_TIER,
  OBSERVED_ABYSSAL_NPC_SPAWN_AUDIT,
  OBSERVED_ABYSSAL_NPC_SPAWN_REGISTRY,
  OBSERVED_ABYSSAL_NPC_TYPE_RESOLUTION_AUDIT,
  QSNA_ABYSSAL_NPC_SOURCE_AUTHORITY,
  RETAIL_EMPTY_NPC_ENTITY_LOADOUT_ID,
  T0_DARK_ENCOUNTER_THEME,
  T0_DARK_ENCOUNTER_VARIANT_SPECS,
  auditEncounterNpcRuntimeCompleteness,
  auditNpcRuntimeSupport,
  buildAbyssalSpaceEncounterPartitionIndex,
  buildEncounterNpcEntry,
  buildEncounterProfile,
  buildNpcDefinition,
  buildSafeAbyssalNpcCatalogEntry,
  cloneValue,
  createQsnaAbyssalSpawnRegistry,
  deepFreeze,
  getAbyssalNpcEncounterTierAdmissionReport,
  getAbyssalNpcProfileValidationReport,
  getAbyssalSpaceEncounterPartition,
  getAbyssalTier1SafeNpcTypeSpecs,
  getNpcBehaviorProfile,
  getNpcProfile,
  isObservedAbyssalEncounterProfile,
  listEncounterNpcCandidates,
  listObservedAbyssalEncounterProfilesForTier,
  normalizeEncounterResolutionRequest,
  normalizeEncounterRoomIndexes,
  normalizeEncounterText,
  normalizeEncounterWeatherTypes,
  normalizeStringArray,
  resolveNpcHardwareFamily,
  resolveSafeAbyssalNpcCatalogEntry,
  toInteger,
  validateAbyssalContentAuthority,
  validateAbyssalTier1SafeNpcType,
  validateNpcHardwareDefinition,
  validateObservedAbyssalNpcSpawnCoverage,
} = require("./abyssalEncounterNpcCatalog");

const {
  ABYSSAL_ENCOUNTER_THEME_BY_TIER,
  ABYSSAL_SPACE_CATALOGUE_ID_BY_TIER,
  ABYSSAL_SPACE_CLASSIFIER_BY_TIER,
  buildEmpiricalEncounterAuthorityProfile,
  isAbyssalSpaceEncounterProfile,
  isCombinedAbyssalEncounterProfile,
  isHigherTierCombinedEncounterProfile,
  isSupportedAbyssalExtractionEncounter,
  isTier0AbyssalSpaceEncounterProfile,
  isTier0CombinedEncounterProfile,
  isTier1AbyssalSpaceEncounterProfile,
  isTier1CombinedEncounterProfile,
  isTier2AbyssalSpaceEncounterProfile,
  isTier2CombinedEncounterProfile,
  isTier3AbyssalSpaceEncounterProfile,
  isTier4AbyssalSpaceEncounterProfile,
  isTier5AbyssalSpaceEncounterProfile,
  isTier6AbyssalSpaceEncounterProfile,
  listEncounterEntryChoices,
  readAbyssalEncounterAuthorityValue,
  summarizeCombinedEncounterComposition,
  summarizeHigherTierCombinedEncounterComposition,
  summarizeTier1CombinedEncounterComposition,
  summarizeTier2CombinedEncounterComposition,
  validateAbyssalSpaceEncounterCatalogue,
  validateEncounterCatalogue,
} = require("./abyssalEncounterPolicy");

const {
  ABYSSAL_ENCOUNTER_ARCHETYPE_SPECS_BY_WEATHER_TYPE,
  ABYSSAL_ENCOUNTER_TIER_BANDS,
  ABYSSAL_ENCOUNTER_VARIETY_BY_WEATHER_TYPE,
  ABYSSAL_TIER0_ENCOUNTER_CATALOG,
  ABYSSAL_TIER1_ENCOUNTER_CATALOG,
  ABYSSAL_TIER1_LEGACY_ENCOUNTER_CATALOG,
  ABYSSAL_TIER2_ENCOUNTER_CATALOG,
  ABYSSAL_TIER3_ENCOUNTER_CATALOG,
  ABYSSAL_TIER4_ENCOUNTER_CATALOG,
  ABYSSAL_TIER5_ENCOUNTER_CATALOG,
  ABYSSAL_TIER6_ENCOUNTER_CATALOG,
  buildHigherTierEncounterProfile,
  resolveAbyssalEncounterArchetypeSpec,
  resolveAbyssalEncounterTierBand,
  resolveAbyssalEncounterVariety,
} = require("./abyssalEncounterDefinitions");

function createAbyssalEncounterResolver({
  authoredCataloguesByTier = {
    0: ABYSSAL_TIER0_ENCOUNTER_CATALOG,
    1: ABYSSAL_TIER1_ENCOUNTER_CATALOG,
    2: ABYSSAL_TIER2_ENCOUNTER_CATALOG,
    3: ABYSSAL_TIER3_ENCOUNTER_CATALOG,
    4: ABYSSAL_TIER4_ENCOUNTER_CATALOG,
    5: ABYSSAL_TIER5_ENCOUNTER_CATALOG,
    6: ABYSSAL_TIER6_ENCOUNTER_CATALOG,
  },
  legacyTier1Catalogue = ABYSSAL_TIER1_LEGACY_ENCOUNTER_CATALOG,
  legacySpaceContentRegistriesByTier = {},
  legacySpaceEncounterBuildersByTier = {},
} = {}) {
  const legacySpaceCatalogueCache = new Map();

  function getLegacySpaceEncounterCatalogue(tier) {
    const numericTier = toInteger(tier, -1);
    if (!legacySpaceCatalogueCache.has(numericTier)) {
      const registry =
        legacySpaceContentRegistriesByTier[String(numericTier)] || null;
      const buildProfile =
        legacySpaceEncounterBuildersByTier[String(numericTier)] || null;
      if (!registry || typeof buildProfile !== "function") return [];
      legacySpaceCatalogueCache.set(
        numericTier,
        deepFreeze(registry.listVariants({ runtimeReady: true })
          .map(buildProfile)),
      );
    }
    return legacySpaceCatalogueCache.get(numericTier);
  }

  function listAuthoredEncounterProfiles(tier) {
    return cloneValue(
      authoredCataloguesByTier[String(toInteger(tier, -1))] || [],
    );
  }

  function listLegacySpaceEncounterProfiles(tier, query = {}) {
    const weatherType = normalizeEncounterText(
      query.weatherType,
      "",
    ).toLowerCase();
    const roomIndex = toInteger(query.roomIndex, 0);
    const catalogue = getLegacySpaceEncounterCatalogue(tier);
    return cloneValue(catalogue.filter((profile) =>
      (
        !weatherType || (
          Array.isArray(profile && profile.eligibleWeatherTypes) &&
          profile.eligibleWeatherTypes.includes(weatherType)
        )
      ) &&
      (
        roomIndex <= 0 || (
          Array.isArray(profile && profile.eligibleRoomIndexes) &&
          profile.eligibleRoomIndexes.includes(roomIndex)
        )
      )));
  }

  function selectObservedEncounterProfile(context = {}) {
    const selection = OBSERVED_ABYSSAL_NPC_SPAWN_REGISTRY
      .selectProfileForContext(context);
    return cloneValue(selection);
  }

  return Object.freeze({
    auditEncounterNpcRuntimeCompleteness,
    buildEmpiricalEncounterAuthorityProfile,
    getAbyssalSpaceEncounterPartition,
    getLegacySpaceEncounterCatalogue,
    getObservedCatalogueID() {
      return String(OBSERVED_ABYSSAL_NPC_SPAWN_REGISTRY.catalogueID || "");
    },
    getObservedAbyssalNpcSpawnAudit() {
      return cloneValue(OBSERVED_ABYSSAL_NPC_SPAWN_AUDIT);
    },
    isHigherTierCombinedEncounterProfile,
    isObservedAbyssalEncounterProfile,
    isSupportedAbyssalExtractionEncounter,
    isTier0AbyssalSpaceEncounterProfile,
    isTier0CombinedEncounterProfile,
    isTier1AbyssalSpaceEncounterProfile,
    isTier1CombinedEncounterProfile,
    isTier2AbyssalSpaceEncounterProfile,
    isTier2CombinedEncounterProfile,
    isTier3AbyssalSpaceEncounterProfile,
    isTier4AbyssalSpaceEncounterProfile,
    isTier5AbyssalSpaceEncounterProfile,
    isTier6AbyssalSpaceEncounterProfile,
    listAuthoredEncounterProfiles,
    listEncounterNpcCandidates,
    listLegacySpaceEncounterProfiles,
    listObservedEncounterProfiles(tier) {
      return cloneValue(listObservedAbyssalEncounterProfilesForTier(tier));
    },
    listTier1LegacyEncounterProfiles() {
      return cloneValue(legacyTier1Catalogue);
    },
    normalizeEncounterResolutionRequest,
    resolveEncounterCataloguePartition: getAbyssalSpaceEncounterPartition,
    resolveEncounterForSpawn: selectObservedEncounterProfile,
    resolveEncounterProfile: selectObservedEncounterProfile,
    selectObservedEncounterProfile,
    summarizeHigherTierCombinedEncounterComposition,
    summarizeTier1CombinedEncounterComposition,
    summarizeTier2CombinedEncounterComposition,
    validateAuthoredEncounterCatalogue(tier, catalogue = undefined) {
      const numericTier = toInteger(tier, -1);
      return validateEncounterCatalogue(
        catalogue === undefined
          ? authoredCataloguesByTier[String(numericTier)] || []
          : catalogue,
        numericTier,
      );
    },
    validateEncounterNpcCapabilities: auditEncounterNpcRuntimeCompleteness,
    validateObservedAbyssalNpcSpawnCoverage,
    validateSpaceEncounterCatalogue(tier, catalogue = undefined) {
      const numericTier = toInteger(tier, -1);
      return validateAbyssalSpaceEncounterCatalogue(
        catalogue === undefined
          ? ABYSSAL_SPACE_ENCOUNTER_CATALOG_BY_TIER[String(numericTier)] || []
          : catalogue,
        numericTier,
      );
    },
  });
}

function buildLegacyAbyssalSpaceEncounterProfile({
  variant,
  tier,
  catalogueID,
  encounterTheme,
  rewardProfilesByWeather,
}, dependencies = {}) {
  const normalizeExtractionNodeProfile =
    typeof dependencies.normalizeExtractionNodeProfile === "function"
      ? dependencies.normalizeExtractionNodeProfile
      : cloneValue;
  const npcEntries = variant.npcEntries.map((entry, index) => ({
    npcEntryID: entry.npcEntryID,
    npcProfileKey: entry.profileID,
    role: `observed_hostile_${index + 1}`,
    minimumCount: entry.quantity,
    maximumCount: entry.quantity,
    required: true,
    objectiveRelevant: true,
  }));
  const factionThemes = new Set(
    variant.npcEntries.map((entry) =>
      entry.groupID === ABYSSAL_TIER1_NEEDLE_DRONE_GROUP_ID
        ? "rogue_drone"
        : "triglavian"),
  );
  const factionTheme = factionThemes.size === 1
    ? [...factionThemes][0]
    : "observed_mixed";
  const observedExtractionStructureTypeIDs = variant.objectEntries.flatMap(
    (entry) => {
      if (!["Triglavian Extraction Node", "Triglavian Extraction SubNode"]
        .includes(String(entry && entry.itemName || ""))) {
        return [];
      }
      return Array.from(
        { length: Math.max(0, toInteger(entry && entry.quantity, 0)) },
        () => toInteger(entry && entry.typeID, 0),
      ).filter((typeID) => typeID > 0);
    },
  );
  const extractionNodeProfileOverride =
    [2, 3, 4, 5, 6].includes(tier) &&
      observedExtractionStructureTypeIDs.length > 0
      ? normalizeExtractionNodeProfile({
        extractionNodeProfileID:
          `${variant.variantID}:observed-extraction-structures`,
        contentAuthority: ABYSSAL_CONTENT_AUTHORITY.PROJECT_AUTHORED,
        lootTableID: `${variant.variantID}:no-attributed-node-loot`,
        enabled: true,
        displayName: `Observed Tier ${tier} extraction structures`,
        quantityPolicy: dependencies.retailFinalQuantityPolicy,
        extractionNodeTypeName: "Observed extraction structure",
        extractionNodeDisplayName: "Triglavian Extraction Structure",
        eligibleRoomIndexes: [variant.roomNumber],
        eligibleTiers: [tier],
        spawnCount: observedExtractionStructureTypeIDs.length,
        minimumSpawnCount: observedExtractionStructureTypeIDs.length,
        maximumSpawnCount: observedExtractionStructureTypeIDs.length,
        structureTypeIDs: observedExtractionStructureTypeIDs,
        observedStructureTypeIDs: observedExtractionStructureTypeIDs,
        lootEmptyChance: 1,
        guaranteedLootEntries: [],
        independentLootEntries: [],
        weightedLootPools: [],
        placeholderOnly: false,
        placeholderNotes: [
          "Structure identity and multiplicity come from the correlated observed room record.",
          "Placement is deterministic project-authored because the source has no exact transform evidence.",
          "No extraction-node loot is attributed from whole-run telemetry.",
        ],
      })
      : null;
  return buildEncounterProfile({
    encounterProfileID: variant.variantID,
    encounterName:
      `Observed ${variant.weatherType} Room ${variant.roomNumber} ${variant.spawnID}`,
    tier,
    eligibleRoomIndexes: [variant.roomNumber],
    eligibleWeatherTypes: [variant.weatherType],
    factionTheme,
    encounterTheme,
    objectiveType: "kill_objective_hostiles",
    weight: Math.max(1, variant.runtimeReadiness.admittedConfidenceCount),
    npcEntries,
    spawnRadiusMeters: 9_000 + (variant.roomNumber * 1_500),
    spawnJitterMeters: 2_000,
    maximumTotalCount: variant.runtimeReadiness.npcCount,
    rewardProfileOverride: rewardProfilesByWeather
      ? rewardProfilesByWeather[variant.weatherType]
      : null,
    cacheProfileOverride: variant.cacheProfile,
    extractionNodeProfileOverride,
    observedObjectEntries: variant.objectEntries,
    sourceModelID: catalogueID,
    sourceVariantID: variant.variantID,
    sourceSpawnID: variant.spawnID,
    sourceSpawnFamily: variant.spawnFamily,
    sourceObservationCount: variant.observationCount,
    sourceConfidenceCounts: variant.confidenceCounts,
    rawObservationWeight: variant.observationCount,
    effectiveProductionWeight:
      variant.runtimeReadiness.admittedConfidenceCount,
    sourceEvidenceAuthority: variant.evidenceAuthority,
    contentAuthority: ABYSSAL_CONTENT_AUTHORITY.OBSERVED_EMPIRICAL,
  }, dependencies);
}

function buildCapturedRoomEncounterProfiles(capture = null) {
  const profilesByRoomIndex = {};
  for (const room of Array.isArray(capture && capture.rooms) ? capture.rooms : []) {
    const roomIndex = Math.max(1, toInteger(room && room.roomNumber, 1));
    const blockerEntityIDs = new Set(
      room && room.objective && Array.isArray(room.objective.blockerEntityIDs)
        ? room.objective.blockerEntityIDs.map((entry) => String(entry || ""))
        : [],
    );
    const npcEntries = (Array.isArray(room && room.entities) ? room.entities : [])
      .filter((entity) => String(entity && entity.kind || "") === "npc")
      .map((entity, index) => {
        const runtimeProfile =
          capture &&
          capture.runtimeReadiness &&
          capture.runtimeReadiness.npcProfilesByTypeID &&
          capture.runtimeReadiness.npcProfilesByTypeID[String(toInteger(entity.typeID, 0))] ||
          null;
        const objectiveRelevant = blockerEntityIDs.has(String(entity.entityID || ""));
        return {
          npcEntryID: String(entity.entityID || `authored_npc_${index + 1}`),
          runtimeKind: "nativeCombat",
          npcProfileKey: String(runtimeProfile && runtimeProfile.profileID || ""),
          profileQuery: String(runtimeProfile && runtimeProfile.profileID || ""),
          profileName: String(runtimeProfile && runtimeProfile.profileName || entity.typeName || ""),
          typeID: toInteger(entity.typeID, 0),
          displayName: String(entity.typeName || ""),
          groupID: toInteger(entity.groupID, 0),
          factionID: toInteger(runtimeProfile && runtimeProfile.factionID, 0),
          requestedProfileQuery: String(runtimeProfile && runtimeProfile.profileID || ""),
          fallbackUsed: false,
          fallbackReason: "",
          weaponStyle: String(runtimeProfile && runtimeProfile.weaponStyle || ""),
          capabilities: cloneValue(runtimeProfile && runtimeProfile.capabilities) || [],
          capabilityData: cloneValue(runtimeProfile && runtimeProfile.capabilityData) || {},
          behaviorOverrides: cloneValue(runtimeProfile && runtimeProfile.behaviorOverrides) || {},
          role: objectiveRelevant ? "captured_objective_hostile" : "captured_non_blocking_dependant",
          minimumCount: 1,
          maximumCount: 1,
          count: 1,
          resolvedCount: 1,
          required: objectiveRelevant,
          objectiveRelevant,
          objectiveBlocker: objectiveRelevant,
          objectiveRole: objectiveRelevant ? "kill_all_hostiles" : "support",
          spawnRadiusMeters: 0,
          spawnOffsetMeters: 0,
          spawnReference: "captured_room_origin",
          spawnDistanceMode: "captured_exact_transform",
          capturedRoomRelativePosition: cloneValue(entity.position),
          capturedRetailRotation: cloneValue(entity.rotation),
          capturedRetailBallID: String(entity.sourceItemID || entity.sourceObjectID || ""),
          capturedRetailOwnerID: toInteger(entity.ownerID, 0),
          capturedRetailIdentity: {
            entityID: String(entity.entityID || ""),
            sourceObjectID: String(entity.sourceObjectID || ""),
            dunObjectID: toInteger(entity.dunObjectID, 0),
          },
          controllerEntityID: entity.controllerEntityID || null,
          deactivatesOnEntityID: entity.deactivatesOnEntityID || null,
          controllerLossBehavior: entity.controllerLossBehavior || null,
          autoRemoveWithController: entity.autoRemoveWithController === true,
          remainsPresentAndTargetableOnControllerLoss:
            entity.remainsPresentAndTargetableOnControllerLoss === true,
          capturedRetailObject: true,
        };
      });
    profilesByRoomIndex[String(roomIndex)] = {
      roomIndex,
      encounterProfileID: `${capture.captureID}:room-${roomIndex}:encounter`,
      contentAuthority: validateAbyssalContentAuthority(
        capture.contentAuthority || ABYSSAL_CONTENT_AUTHORITY.CAPTURED_RETAIL,
        `Captured Abyssal encounter ${capture.captureID} room ${roomIndex}`,
      ),
      encounterName: `Authored ${capture.weatherName} Room ${roomIndex}`,
      encounterTheme: "retail_derived_authored_capture",
      factionTheme: "captured_mixed",
      weatherTheme: String(capture.weatherType || ""),
      tierBandID: String(capture.tier === 0 ? "tranquil" : "calm"),
      tierBandLabel: String(capture.tier === 0 ? "Tranquil" : "Calm"),
      tierRange: {
        minTier: toInteger(capture.tier, 0),
        maxTier: toInteger(capture.tier, 0),
      },
      objectiveType: "kill_objective_hostiles",
      npcEntries,
      npcCount: npcEntries.length,
      spawnRadiusMeters: 0,
      spawnJitterMeters: 0,
      rewardMultiplier: 1,
      rewardQuantityBonus: 0,
      authoredObjective: cloneValue(room.objective),
      authoredRoomID: String(room.roomID || ""),
      placeholderNotes: [
        "Encounter composition and transforms are imported from captured retail evidence.",
        "Active NPC behavior uses the current validated EveJS runtime profile for each captured type.",
      ],
    };
  }
  return profilesByRoomIndex;
}

module.exports = {
  ABYSSAL_AUTHORED_NPC_PROFILES_BY_TYPE_ID,
  ABYSSAL_CALM_WEATHER_TYPES,
  ABYSSAL_EXPLICIT_PLACEHOLDER_NPC_PROFILE_ID,
  ABYSSAL_HIGHER_TIER_APPROVED_TYPE_IDS,
  ABYSSAL_HIGHER_TIER_ENCOUNTER_THEME_BY_TIER,
  ABYSSAL_HIGHER_TIER_KEY_BY_TIER,
  ABYSSAL_HIGHER_TIER_LABEL_BY_TIER,
  ABYSSAL_SAFE_NPC_CATALOG_BY_PROFILE_ID,
  ABYSSAL_SAFE_NPC_PROFILES_BY_TYPE_ID,
  ABYSSAL_TIER0_APPROVED_TYPE_IDS,
  ABYSSAL_TIER0_COMBINED_ENCOUNTER_THEME,
  ABYSSAL_TIER1_APPROVED_TYPE_IDS,
  ABYSSAL_TIER1_COMBINED_ENCOUNTER_THEME,
  ABYSSAL_TIER1_NEEDLE_DRONE_GROUP_ID,
  ABYSSAL_TIER2_APPROVED_TYPE_IDS,
  ABYSSAL_TIER2_COMBINED_ENCOUNTER_THEME,
  ABYSSAL_TIER3_COMBINED_ENCOUNTER_THEME,
  ABYSSAL_TIER4_COMBINED_ENCOUNTER_THEME,
  ABYSSAL_TIER5_COMBINED_ENCOUNTER_THEME,
  ABYSSAL_TIER6_COMBINED_ENCOUNTER_THEME,
  OBSERVED_ABYSSAL_ENCOUNTER_THEME_BY_TIER,
  OBSERVED_ABYSSAL_NPC_SPAWN_AUDIT,
  OBSERVED_ABYSSAL_NPC_SPAWN_REGISTRY,
  auditEncounterNpcRuntimeCompleteness,
  buildEmpiricalEncounterAuthorityProfile,
  buildCapturedRoomEncounterProfiles,
  buildEncounterNpcEntry,
  buildEncounterProfile,
  buildLegacyAbyssalSpaceEncounterProfile,
  createAbyssalEncounterResolver,
  getAbyssalNpcProfileValidationReport,
  getAbyssalNpcEncounterTierAdmissionReport,
  getAbyssalSpaceEncounterPartition,
  isObservedAbyssalEncounterProfile,
  isHigherTierCombinedEncounterProfile,
  isSupportedAbyssalExtractionEncounter,
  isTier0AbyssalSpaceEncounterProfile,
  isTier0CombinedEncounterProfile,
  isTier1AbyssalSpaceEncounterProfile,
  isTier1CombinedEncounterProfile,
  isTier2AbyssalSpaceEncounterProfile,
  isTier2CombinedEncounterProfile,
  isTier3AbyssalSpaceEncounterProfile,
  isTier4AbyssalSpaceEncounterProfile,
  isTier5AbyssalSpaceEncounterProfile,
  isTier6AbyssalSpaceEncounterProfile,
  listEncounterNpcCandidates,
  listObservedAbyssalEncounterProfilesForTier,
  normalizeEncounterResolutionRequest,
  normalizeEncounterRoomIndexes,
  normalizeEncounterText,
  normalizeEncounterWeatherTypes,
  resolveAbyssalEncounterArchetypeSpec,
  resolveAbyssalEncounterTierBand,
  resolveAbyssalEncounterVariety,
  resolveSafeAbyssalNpcCatalogEntry,
  summarizeHigherTierCombinedEncounterComposition,
  summarizeTier1CombinedEncounterComposition,
  summarizeTier2CombinedEncounterComposition,
  validateObservedAbyssalNpcSpawnCoverage,
};
