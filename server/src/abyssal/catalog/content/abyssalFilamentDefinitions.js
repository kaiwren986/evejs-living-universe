"use strict";

function buildAbyssalFilamentDefinitionsPart5(scope) {
  return {
      contentAuthority: scope.ABYSSAL_CONTENT_AUTHORITY.PROJECT_AUTHORED,
      evidenceRefs: [
        "server/src/space/abyssal/abyssalDarkWeatherCatalog.js",
        "server/tests/abyssalWeatherStrengthSelection.test.js",
        "server/tests/abyssalWeatherScope.test.js",
      ],
      authorityFacets: {
        observedMechanicsContract: {
          profileID: "abyssal:weather:dark:t0-captured-mechanics-contract-v1",
          contentAuthority: scope.ABYSSAL_CONTENT_AUTHORITY.CAPTURED_RETAIL,
          effectModel: "maximum-velocity-bonus-and-turret-range-penalties",
          capturedStage: 1,
          capturedWeatherObjectTypeID: scope.T0_DARK_ALLOWED_WEATHER_DEFINITIONS[0].typeID,
          capturedBonusStrengthPercent: 50,
          capturedPenaltyStrengthPercent: 30,
          exactStageSelectionExcluded: true,
          exactStageWeightsExcluded: true,
          evidenceRefs: [
            "docs/tqlogs.zip:TQTranquilAbyssal5.txt:893,20332,61586,61634",
            "server/src/services/activity/abyssalContentManagerService.js:ABYSSAL_WEATHER_METADATA_BY_TYPE.dark",
            "server/tests/abyssalWeatherScope.test.js",
          ],
        },
        capturedStageOnePresentation: {
          profileID: "abyssal:weather:dark:t0-captured-stage-1-presentation",
          contentAuthority: scope.ABYSSAL_CONTENT_AUTHORITY.CAPTURED_RETAIL,
          weatherObjectTypeIDs: [scope.T0_DARK_ALLOWED_WEATHER_DEFINITIONS[0].typeID],
          directlyCapturedInSuppliedT0DarkLogs: true,
          evidenceRefs: [
            "docs/tqlogs.zip:TQTranquilAbyssal5.txt",
            "doc/abyssal/t0-dark-retail-layout-audit.md",
          ],
        },
        stageTwoPresentation: {
          profileID: "abyssal:weather:dark:t0-stage-2-presentation-v1",
          contentAuthority: scope.ABYSSAL_CONTENT_AUTHORITY.PROJECT_AUTHORED,
          weatherObjectTypeIDs: [scope.T0_DARK_ALLOWED_WEATHER_DEFINITIONS[1].typeID],
          directlyCapturedInSuppliedT0DarkLogs: false,
          evidenceRefs: [
            "server/src/space/abyssal/abyssalDarkWeatherCatalog.js",
            "docs/tqlogs.zip:TQTranquilAbyssal5.txt:no-typeID-47379-record",
          ],
        },
        stageSelection: {
          profileID: "abyssal:weather:dark:t0-stage-selection-v1",
          contentAuthority: scope.ABYSSAL_CONTENT_AUTHORITY.PROJECT_AUTHORED,
          allowedStages: scope.T0_DARK_ALLOWED_WEATHER_STAGES,
          allowedWeatherObjectTypeIDs: scope.T0_DARK_ALLOWED_WEATHER_DEFINITIONS
            .map((entry) => entry.typeID),
          penaltyStrengthPercents: scope.T0_DARK_ALLOWED_WEATHER_DEFINITIONS
            .map((entry) => entry.penaltyPercent),
          uncapturedWeatherObjectTypeIDs: [
            scope.T0_DARK_ALLOWED_WEATHER_DEFINITIONS[1].typeID,
          ],
          selectionScope: "per-run",
          evidenceRefs: [
            "https://wiki.eveuniversity.org/Abyssal_Deadspace",
            "server/src/space/abyssal/abyssalDarkWeatherCatalog.js",
            "server/tests/abyssalDarkWeatherCatalog.test.js",
          ],
        },
        stageSelectionWeights: {
          profileID: "abyssal:weather:dark:t0-stage-selection-weights-v1",
          contentAuthority: scope.ABYSSAL_CONTENT_AUTHORITY.PROVISIONAL,
          weights: scope.T0_DARK_WEATHER_STAGE_WEIGHTS,
          selectionModel: "deterministic-per-run-weighted",
          exactRetailProbabilityDistributionVerified: false,
          evidenceRefs: [
            "server/src/space/abyssal/abyssalDarkWeatherCatalog.js",
            "server/tests/abyssalDarkWeatherCatalog.test.js",
            "tools/AbyssalData/docs/tier0-abyssal-space-telemetry.md",
          ],
        },
      },
    };
}

function buildAbyssalFilamentDefinitionsPart4(scope) {
  return {
    definitionID: "abyssal:tranquil-dark",
    filamentTypeID: 56132,
    filamentName: "Tranquil Dark Filament",
    tier: 0,
    weatherType: "dark",
    weatherName: "Dark Matter Field",
    weatherProfile: buildAbyssalFilamentDefinitionsPart5(scope),
    timerPolicyAuthority: scope.ABYSSAL_CONTENT_AUTHORITY.PROJECT_AUTHORED,
    roomProfile: (0, scope.buildTranquilRoomProfile)({
      coordinateProfileID: "abyssal:t0:dark:room-origin-au-x-v1",
      coordinateProfileVersion: 1,
      roomOriginStrideMeters: scope.ONE_AU_IN_METERS,
      roomOriginAxis: { x: 1, y: 0, z: 0 },
      roomOffsetsMeters: [
        { x: 0, y: 0, z: 0 },
        { x: scope.ONE_AU_IN_METERS, y: 0, z: 0 },
        { x: scope.ONE_AU_IN_METERS * 2, y: 0, z: 0 },
      ],
    }),
    cacheProfile: (0, scope.buildPlaceholderCacheProfile)({
      cacheProfileID: "abyssal:cache:tier0-dark-retail-captured-v1",
      cacheFamily: "captured_triglavian_bioadaptive_cache",
      cacheTypeID: 47951,
      cacheTypeName: "Triglavian Bioadaptive Cache",
      cacheDisplayName: "Triglavian Bioadaptive Cache",
      wreckTypeID: 48120,
      wreckTypeName: "Triglavian Bioadaptive Cache Wreck",
      capturedRetailProfile: true,
      placeholderOnly: false,
    }),
    extractionNodeProfile: (0, scope.buildPlaceholderExtractionNodeProfileFromTemplate)("abyssal:extraction:none"),
    rewardProfile: (0, scope.buildTranquilDarkProceduralRewardProfile)(),
    roomEncounterProfilesByIndex: (0, scope.buildTranquilDarkRequestedRoomEncounterProfiles)(),
    npcProfile: (0, scope.buildPlaceholderNpcProfile)({
      amount: 1,
    }),
    placeholderNotes: [
      "Three-room placeholder run only.",
      "Tier 0 uses the proven mixed drone/Triglavian baseline encounter maps.",
      "Dark weather selects the tier-appropriate 30/50/70 percent penalty per run and always applies the 50 percent maximum-velocity bonus.",
      "Reward loot uses the project-authored SDE-derived procedural tier pool; probabilities are not retail-exact.",
    ],
  };
}

function buildAbyssalFilamentDefinitionsPart3(scope) {
  return (0, scope.buildProductionAbyssalFilamentDefinition)(scope.ABYSSAL_CONTENT_COMPLETENESS_LEVEL.PLAYABLE, buildAbyssalFilamentDefinitionsPart4(scope));
}

function buildAbyssalFilamentDefinitionsPart6(scope) {
  return (0, scope.buildProductionAbyssalFilamentDefinition)(scope.ABYSSAL_CONTENT_COMPLETENESS_LEVEL.PLAYABLE, {
    definitionID: "abyssal:tranquil-electrical",
    filamentTypeID: 56131,
    filamentName: "Tranquil Electrical Filament",
    tier: 0,
    weatherType: "electrical",
    weatherName: "Electrical Storm",
    weatherProfile: (0, scope.buildT0TranquilWeatherProfile)("electrical"),
    timerPolicyAuthority: scope.ABYSSAL_CONTENT_AUTHORITY.PROJECT_AUTHORED,
    roomProfile: (0, scope.buildTranquilRoomProfile)(),
    cacheProfile: (0, scope.buildPlaceholderCacheProfile)({
      cacheProfileID: "abyssal:cache:tier0-tranquil-retail-v1",
      cacheFamily: "captured_triglavian_bioadaptive_cache",
      cacheTypeID: 47951,
      cacheTypeName: "Triglavian Bioadaptive Cache",
      cacheDisplayName: "Triglavian Bioadaptive Cache",
      wreckTypeID: 48120,
      wreckTypeName: "Triglavian Bioadaptive Cache Wreck",
      capturedRetailProfile: true,
      placeholderOnly: false,
    }),
    extractionNodeProfile: (0, scope.buildPlaceholderExtractionNodeProfileFromTemplate)("abyssal:extraction:none"),
    rewardProfile: (0, scope.cloneValue)(scope.ABYSSAL_SPACE_TIER0_REWARD_PROFILE_BY_WEATHER.electrical),
    npcProfile: (0, scope.buildPlaceholderNpcProfile)({
      amount: 1,
    }),
    placeholderNotes: [
      "Three-room isolated run uses the shared durable Tier 0 lifecycle.",
      "Encounters select complete observed room records; capability-gated observations are not substituted.",
      "Electrical weather selects the Tranquil 30/50 percent EM-resistance penalty band per run and applies the fixed 50 percent capacitor-recharge-time bonus.",
      "Reward loot uses the project-authored SDE-derived procedural tier pool; probabilities are not retail-exact.",
    ],
  });
}

function buildAbyssalFilamentDefinitionsPart7(scope) {
  return (0, scope.buildProductionAbyssalFilamentDefinition)(scope.ABYSSAL_CONTENT_COMPLETENESS_LEVEL.PLAYABLE, {
    definitionID: "abyssal:tranquil-exotic",
    filamentTypeID: 56133,
    filamentName: "Tranquil Exotic Filament",
    tier: 0,
    weatherType: "exotic",
    weatherName: "Exotic Matter Storm",
    weatherProfile: (0, scope.buildT0TranquilWeatherProfile)("exotic"),
    timerPolicyAuthority: scope.ABYSSAL_CONTENT_AUTHORITY.PROJECT_AUTHORED,
    roomProfile: (0, scope.buildTranquilRoomProfile)(),
    cacheProfile: (0, scope.buildPlaceholderCacheProfile)({
      cacheProfileID: "abyssal:cache:tier0-tranquil-retail-v1",
      cacheFamily: "captured_triglavian_bioadaptive_cache",
      cacheTypeID: 47951,
      cacheTypeName: "Triglavian Bioadaptive Cache",
      cacheDisplayName: "Triglavian Bioadaptive Cache",
      wreckTypeID: 48120,
      wreckTypeName: "Triglavian Bioadaptive Cache Wreck",
      capturedRetailProfile: true,
      placeholderOnly: false,
    }),
    extractionNodeProfile: (0, scope.buildPlaceholderExtractionNodeProfileFromTemplate)("abyssal:extraction:none"),
    rewardProfile: (0, scope.cloneValue)(scope.ABYSSAL_SPACE_TIER0_REWARD_PROFILE_BY_WEATHER.exotic),
    npcProfile: (0, scope.buildPlaceholderNpcProfile)({
      amount: 1,
    }),
    placeholderNotes: [
      "Three-room isolated run uses the shared durable Tier 0 lifecycle.",
      "Encounters select complete observed room records; capability-gated observations are not substituted.",
      "Exotic weather selects the Tranquil 30/50 percent kinetic-resistance penalty band per run and applies the fixed 50 percent scan-resolution bonus.",
      "Reward loot uses the project-authored SDE-derived procedural tier pool; probabilities are not retail-exact.",
    ],
  });
}

function buildAbyssalFilamentDefinitionsPart8(scope) {
  return (0, scope.buildProductionAbyssalFilamentDefinition)(scope.ABYSSAL_CONTENT_COMPLETENESS_LEVEL.PLAYABLE, {
    definitionID: "abyssal:tranquil-firestorm",
    filamentTypeID: 56134,
    filamentName: "Tranquil Firestorm Filament",
    tier: 0,
    weatherType: "firestorm",
    weatherName: "Plasma Firestorm",
    weatherProfile: (0, scope.buildT0TranquilWeatherProfile)("firestorm"),
    timerPolicyAuthority: scope.ABYSSAL_CONTENT_AUTHORITY.PROJECT_AUTHORED,
    roomProfile: (0, scope.buildTranquilRoomProfile)(),
    cacheProfile: (0, scope.buildPlaceholderCacheProfile)({
      cacheProfileID: "abyssal:cache:tier0-tranquil-retail-v1",
      cacheFamily: "captured_triglavian_bioadaptive_cache",
      cacheTypeID: 47951,
      cacheTypeName: "Triglavian Bioadaptive Cache",
      cacheDisplayName: "Triglavian Bioadaptive Cache",
      wreckTypeID: 48120,
      wreckTypeName: "Triglavian Bioadaptive Cache Wreck",
      capturedRetailProfile: true,
      placeholderOnly: false,
    }),
    extractionNodeProfile: (0, scope.buildPlaceholderExtractionNodeProfileFromTemplate)("abyssal:extraction:none"),
    rewardProfile: (0, scope.cloneValue)(scope.ABYSSAL_SPACE_TIER0_REWARD_PROFILE_BY_WEATHER.firestorm),
    npcProfile: (0, scope.buildPlaceholderNpcProfile)({
      amount: 1,
    }),
    placeholderNotes: [
      "Three-room isolated run uses the shared durable Tier 0 lifecycle.",
      "Encounters select complete observed room records; capability-gated observations are not substituted.",
      "Firestorm weather selects the Tranquil 30/50 percent thermal-resistance penalty band per run and applies the fixed 50 percent armor-HP bonus.",
      "Reward loot uses the project-authored SDE-derived procedural tier pool; probabilities are not retail-exact.",
    ],
  });
}

function buildAbyssalFilamentDefinitionsPart9(scope) {
  return (0, scope.buildProductionAbyssalFilamentDefinition)(scope.ABYSSAL_CONTENT_COMPLETENESS_LEVEL.PLAYABLE, {
    definitionID: "abyssal:tranquil-gamma",
    filamentTypeID: 56136,
    filamentName: "Tranquil Gamma Filament",
    tier: 0,
    weatherType: "gamma",
    weatherName: "Gamma-Ray Storm",
    weatherProfile: (0, scope.buildT0TranquilWeatherProfile)("gamma"),
    timerPolicyAuthority: scope.ABYSSAL_CONTENT_AUTHORITY.PROJECT_AUTHORED,
    roomProfile: (0, scope.buildTranquilRoomProfile)(),
    cacheProfile: (0, scope.buildPlaceholderCacheProfile)({
      cacheProfileID: "abyssal:cache:tier0-tranquil-retail-v1",
      cacheFamily: "captured_triglavian_bioadaptive_cache",
      cacheTypeID: 47951,
      cacheTypeName: "Triglavian Bioadaptive Cache",
      cacheDisplayName: "Triglavian Bioadaptive Cache",
      wreckTypeID: 48120,
      wreckTypeName: "Triglavian Bioadaptive Cache Wreck",
      capturedRetailProfile: true,
      placeholderOnly: false,
    }),
    extractionNodeProfile: (0, scope.buildPlaceholderExtractionNodeProfileFromTemplate)("abyssal:extraction:none"),
    rewardProfile: (0, scope.cloneValue)(scope.ABYSSAL_SPACE_TIER0_REWARD_PROFILE_BY_WEATHER.gamma),
    npcProfile: (0, scope.buildPlaceholderNpcProfile)({
      amount: 1,
    }),
    placeholderNotes: [
      "Three-room isolated run uses the shared durable Tier 0 lifecycle.",
      "Encounters select complete observed room records; capability-gated observations are not substituted.",
      "Gamma weather selects the Tranquil 30/50 percent explosive-resistance penalty band per run and applies the fixed 50 percent shield-HP bonus.",
      "Reward loot uses the project-authored SDE-derived procedural tier pool; probabilities are not retail-exact.",
    ],
  });
}

function buildAbyssalFilamentDefinitionsPart10(scope) {
  return (0, scope.buildProductionAbyssalFilamentDefinition)(scope.ABYSSAL_CONTENT_COMPLETENESS_LEVEL.PLAYABLE, {
    definitionID: "abyssal:calm-dark",
    filamentTypeID: 47762,
    filamentName: "Calm Dark Filament",
    tier: 1,
    weatherType: "dark",
    weatherName: "Dark Matter Field",
    cacheProfile: (0, scope.buildPlaceholderCacheProfile)({
      cacheDisplayName: "Abyssal Biocombinative Cache (Placeholder)",
    }),
    extractionNodeProfile: (0, scope.buildPlaceholderExtractionNodeProfileFromTemplate)("abyssal:extraction:calm-dark-side-node"),
    rewardProfile: (0, scope.buildCalmDarkRoomRewardProfile)({
      rewardProfileID: scope.ABYSSAL_CALM_DARK_ROOM1_REWARD_PROFILE_ID,
      lootTableID: "abyssal:loot:calm-dark-cache-room1-v1",
      displayName: "Calm Dark Room 1 Reward Cache",
      baseLootEntries: (0, scope.cloneValue)(scope.ABYSSAL_CALM_GOLDEN_CACHE_BASE_LOOT_ENTRIES),
      includeGoldenCalmSurveyPool: true,
      weightedLootPools: [
        (0, scope.cloneValue)(scope.ABYSSAL_CALM_BONUS_CACHE_LOOT_POOL),
        (0, scope.cloneValue)(scope.ABYSSAL_CALM_GOLDEN_FILAMENT_CACHE_LOOT_POOL),
      ],
      placeholderNotes: [
        "Golden Calm samples support Survey Databases, optional Abyssal materials, and filaments without a room-specific probability claim.",
      ],
    }),
    npcProfile: (0, scope.buildPlaceholderNpcProfile)({
      amount: 4,
      profileQuery: "parity_guristas_missile_frigate",
    }),
    roomEncounterProfilesByIndex: (0, scope.buildCalmDarkRequestedRoomEncounterProfiles)(),
    placeholderNotes: [
      "Three-room placeholder run only.",
      "Dark weather selects the tier-appropriate 30/50/70 percent penalty per run and always applies the 50 percent maximum-velocity bonus.",
      "Reward loot uses a conservative locally resolved Calm loot table, not retail-complete loot behavior.",
      "Timeout is lethal and suppresses rewards before canonical ship-and-capsule destruction.",
    ],
  });
}

function buildAbyssalFilamentDefinitionsPart11(scope) {
  return (0, scope.buildProductionAbyssalFilamentDefinition)(scope.ABYSSAL_CONTENT_COMPLETENESS_LEVEL.PLAYABLE, {
    definitionID: "abyssal:calm-electrical",
    filamentTypeID: 47765,
    filamentName: "Calm Electrical Filament",
    tier: 1,
    weatherType: "electrical",
    weatherName: "Electrical Storm",
    cacheProfile: (0, scope.buildPlaceholderCacheProfile)({
      cacheDisplayName: "Electrical Abyssal Cache (Placeholder)",
    }),
    extractionNodeProfile: (0, scope.buildPlaceholderExtractionNodeProfileFromTemplate)("abyssal:extraction:calm-electrical-side-node"),
    rewardProfile: (0, scope.buildPlaceholderRewardProfileFromTemplate)("abyssal:reward:calm-electrical-placeholder"),
    npcProfile: (0, scope.buildPlaceholderNpcProfile)({
      amount: 1,
    }),
    placeholderNotes: [
      "Three-room placeholder run only.",
      "Electrical weather uses deterministic placeholder strength instead of retail site rolls.",
      "Reward loot uses a conservative locally resolved Calm loot table, not retail-complete loot behavior.",
      "Timeout is lethal and suppresses rewards before canonical ship-and-capsule destruction.",
    ],
  });
}

function buildAbyssalFilamentDefinitionsPart12(scope) {
  return (0, scope.buildProductionAbyssalFilamentDefinition)(scope.ABYSSAL_CONTENT_COMPLETENESS_LEVEL.PLAYABLE, {
    definitionID: "abyssal:calm-exotic",
    filamentTypeID: 47761,
    filamentName: "Calm Exotic Filament",
    tier: 1,
    weatherType: "exotic",
    weatherName: "Exotic Matter Storm",
    cacheProfile: (0, scope.buildPlaceholderCacheProfile)({
      cacheDisplayName: "Exotic Abyssal Cache (Placeholder)",
    }),
    extractionNodeProfile: (0, scope.buildPlaceholderExtractionNodeProfileFromTemplate)("abyssal:extraction:calm-exotic-side-node"),
    rewardProfile: (0, scope.buildPlaceholderRewardProfileFromTemplate)("abyssal:reward:calm-exotic-placeholder"),
    npcProfile: (0, scope.buildPlaceholderNpcProfile)({
      amount: 1,
    }),
    placeholderNotes: [
      "Three-room placeholder run only.",
      "Exotic weather uses deterministic placeholder strength instead of retail site rolls.",
      "Reward loot uses a conservative locally resolved Calm loot table, not retail-complete loot behavior.",
      "Timeout is lethal and suppresses rewards before canonical ship-and-capsule destruction.",
    ],
  });
}

function buildAbyssalFilamentDefinitionsPart13(scope) {
  return (0, scope.buildProductionAbyssalFilamentDefinition)(scope.ABYSSAL_CONTENT_COMPLETENESS_LEVEL.PLAYABLE, {
    definitionID: "abyssal:calm-firestorm",
    filamentTypeID: 47763,
    filamentName: "Calm Firestorm Filament",
    tier: 1,
    weatherType: "firestorm",
    weatherName: "Plasma Firestorm",
    cacheProfile: (0, scope.buildPlaceholderCacheProfile)({
      cacheDisplayName: "Firestorm Abyssal Cache (Placeholder)",
    }),
    extractionNodeProfile: (0, scope.buildPlaceholderExtractionNodeProfileFromTemplate)("abyssal:extraction:calm-firestorm-side-node"),
    rewardProfile: (0, scope.buildPlaceholderRewardProfileFromTemplate)("abyssal:reward:calm-firestorm-placeholder"),
    npcProfile: (0, scope.buildPlaceholderNpcProfile)({
      amount: 1,
    }),
    placeholderNotes: [
      "Three-room placeholder run only.",
      "Firestorm weather uses deterministic placeholder strength instead of retail site rolls.",
      "Reward loot uses a conservative locally resolved Calm loot table, not retail-complete loot behavior.",
      "Timeout is lethal and suppresses rewards before canonical ship-and-capsule destruction.",
    ],
  });
}

function buildAbyssalFilamentDefinitionsPart14(scope) {
  return (0, scope.buildProductionAbyssalFilamentDefinition)(scope.ABYSSAL_CONTENT_COMPLETENESS_LEVEL.PLAYABLE, {
    definitionID: "abyssal:calm-gamma",
    filamentTypeID: 47764,
    filamentName: "Calm Gamma Filament",
    tier: 1,
    weatherType: "gamma",
    weatherName: "Gamma-Ray Storm",
    cacheProfile: (0, scope.buildPlaceholderCacheProfile)({
      cacheDisplayName: "Gamma Abyssal Cache (Placeholder)",
    }),
    extractionNodeProfile: (0, scope.buildPlaceholderExtractionNodeProfileFromTemplate)("abyssal:extraction:calm-gamma-side-node"),
    rewardProfile: (0, scope.buildPlaceholderRewardProfileFromTemplate)("abyssal:reward:calm-gamma-placeholder"),
    npcProfile: (0, scope.buildPlaceholderNpcProfile)({
      amount: 1,
    }),
    placeholderNotes: [
      "Three-room placeholder run only.",
      "Gamma weather uses deterministic placeholder strength instead of retail site rolls.",
      "Reward loot uses a conservative locally resolved Calm loot table, not retail-complete loot behavior.",
      "Timeout is lethal and suppresses rewards before canonical ship-and-capsule destruction.",
    ],
  });
}

function buildAbyssalFilamentDefinitionsPart15(scope) {
  return (0, scope.buildProductionAbyssalFilamentDefinition)(scope.ABYSSAL_CONTENT_COMPLETENESS_LEVEL.PLAYABLE, {
    definitionID: "abyssal:agitated-dark",
    filamentTypeID: 47892,
    filamentName: "Agitated Dark Filament",
    tier: 2,
    weatherType: "dark",
    weatherName: "Dark Matter Field",
    npcProfile: (0, scope.buildPlaceholderNpcProfile)({
      amount: 2,
    }),
    cacheProfile: (0, scope.buildPlaceholderCacheProfile)({
      cacheDisplayName: "Agitated Abyssal Cache (Placeholder)",
    }),
    extractionNodeProfile: (0, scope.buildPlaceholderExtractionNodeProfileFromTemplate)("abyssal:extraction:agitated-dark-side-node"),
    rewardProfile: (0, scope.buildPlaceholderRewardProfileFromTemplate)("abyssal:reward:agitated-dark-placeholder"),
    roomEncounterProfilesByIndex: (0, scope.buildAgitatedTier2RoomEncounterProfiles)(),
    placeholderNotes: [
      "Three-room placeholder run only.",
      "Tier 2 uses the first Agitated mixed drone/Triglavian baseline, not retail encounter parity.",
      "Dark weather selects the tier-appropriate 30/50/70 percent penalty per run and always applies the 50 percent maximum-velocity bonus.",
      "Reward loot is deterministic placeholder loot, not a retail loot table.",
    ],
  });
}

function buildAbyssalFilamentDefinitionsPart16(scope) {
  return (0, scope.buildProductionAbyssalFilamentDefinition)(scope.ABYSSAL_CONTENT_COMPLETENESS_LEVEL.PLAYABLE, {
    definitionID: "abyssal:agitated-electrical",
    filamentTypeID: 47904,
    filamentName: "Agitated Electrical Filament",
    tier: 2,
    weatherType: "electrical",
    weatherName: "Electrical Storm",
    npcProfile: (0, scope.buildPlaceholderNpcProfile)({
      amount: 2,
    }),
    cacheProfile: (0, scope.buildPlaceholderCacheProfile)({
      cacheDisplayName: "Agitated Electrical Abyssal Cache (Placeholder)",
    }),
    extractionNodeProfile: (0, scope.buildPlaceholderExtractionNodeProfileFromTemplate)("abyssal:extraction:agitated-electrical-side-node"),
    rewardProfile: (0, scope.buildPlaceholderRewardProfileFromTemplate)("abyssal:reward:agitated-electrical-placeholder"),
    roomEncounterProfilesByIndex: (0, scope.buildAgitatedTier2RoomEncounterProfiles)(),
    placeholderNotes: [
      "Three-room placeholder run only.",
      "Tier 2 uses the first Agitated mixed drone/Triglavian baseline, not retail encounter parity.",
      "Electrical weather uses deterministic placeholder strength instead of retail site rolls.",
      "Reward loot is deterministic placeholder loot, not a retail loot table.",
    ],
  });
}

function buildAbyssalFilamentDefinitionsPart17(scope) {
  return (0, scope.buildProductionAbyssalFilamentDefinition)(scope.ABYSSAL_CONTENT_COMPLETENESS_LEVEL.PLAYABLE, {
    definitionID: "abyssal:agitated-exotic",
    filamentTypeID: 47888,
    filamentName: "Agitated Exotic Filament",
    tier: 2,
    weatherType: "exotic",
    weatherName: "Exotic Matter Storm",
    npcProfile: (0, scope.buildPlaceholderNpcProfile)({
      amount: 2,
    }),
    cacheProfile: (0, scope.buildPlaceholderCacheProfile)({
      cacheDisplayName: "Agitated Exotic Abyssal Cache (Placeholder)",
    }),
    extractionNodeProfile: (0, scope.buildPlaceholderExtractionNodeProfileFromTemplate)("abyssal:extraction:agitated-exotic-side-node"),
    rewardProfile: (0, scope.buildPlaceholderRewardProfileFromTemplate)("abyssal:reward:agitated-exotic-placeholder"),
    roomEncounterProfilesByIndex: (0, scope.buildAgitatedTier2RoomEncounterProfiles)(),
    placeholderNotes: [
      "Three-room placeholder run only.",
      "Tier 2 uses the first Agitated mixed drone/Triglavian baseline, not retail encounter parity.",
      "Exotic weather uses deterministic placeholder strength instead of retail site rolls.",
      "Reward loot is deterministic placeholder loot, not a retail loot table.",
    ],
  });
}

function buildAbyssalFilamentDefinitionsPart18(scope) {
  return (0, scope.buildProductionAbyssalFilamentDefinition)(scope.ABYSSAL_CONTENT_COMPLETENESS_LEVEL.PLAYABLE, {
    definitionID: "abyssal:agitated-firestorm",
    filamentTypeID: 47896,
    filamentName: "Agitated Firestorm Filament",
    tier: 2,
    weatherType: "firestorm",
    weatherName: "Plasma Firestorm",
    npcProfile: (0, scope.buildPlaceholderNpcProfile)({
      amount: 2,
    }),
    cacheProfile: (0, scope.buildPlaceholderCacheProfile)({
      cacheDisplayName: "Agitated Firestorm Abyssal Cache (Placeholder)",
    }),
    extractionNodeProfile: (0, scope.buildPlaceholderExtractionNodeProfileFromTemplate)("abyssal:extraction:agitated-firestorm-side-node"),
    rewardProfile: (0, scope.buildPlaceholderRewardProfileFromTemplate)("abyssal:reward:agitated-firestorm-placeholder"),
    roomEncounterProfilesByIndex: (0, scope.buildAgitatedTier2RoomEncounterProfiles)(),
    placeholderNotes: [
      "Three-room placeholder run only.",
      "Tier 2 uses the first Agitated mixed drone/Triglavian baseline, not retail encounter parity.",
      "Firestorm weather uses deterministic placeholder strength instead of retail site rolls.",
      "Reward loot is deterministic placeholder loot, not a retail loot table.",
    ],
  });
}

function buildAbyssalFilamentDefinitionsPart19(scope) {
  return (0, scope.buildProductionAbyssalFilamentDefinition)(scope.ABYSSAL_CONTENT_COMPLETENESS_LEVEL.PLAYABLE, {
    definitionID: "abyssal:agitated-gamma",
    filamentTypeID: 47900,
    filamentName: "Agitated Gamma Filament",
    tier: 2,
    weatherType: "gamma",
    weatherName: "Gamma-Ray Storm",
    npcProfile: (0, scope.buildPlaceholderNpcProfile)({
      amount: 2,
    }),
    cacheProfile: (0, scope.buildPlaceholderCacheProfile)({
      cacheDisplayName: "Agitated Gamma Abyssal Cache (Placeholder)",
    }),
    extractionNodeProfile: (0, scope.buildPlaceholderExtractionNodeProfileFromTemplate)("abyssal:extraction:agitated-gamma-side-node"),
    rewardProfile: (0, scope.buildPlaceholderRewardProfileFromTemplate)("abyssal:reward:agitated-gamma-placeholder"),
    roomEncounterProfilesByIndex: (0, scope.buildAgitatedTier2RoomEncounterProfiles)(),
    placeholderNotes: [
      "Three-room placeholder run only.",
      "Tier 2 uses the first Agitated mixed drone/Triglavian baseline, not retail encounter parity.",
      "Gamma weather uses deterministic placeholder strength instead of retail site rolls.",
      "Reward loot is deterministic placeholder loot, not a retail loot table.",
    ],
  });
}

function buildAbyssalFilamentDefinitionsPart20(scope) {
  return (0, scope.buildProductionAbyssalFilamentDefinition)(scope.ABYSSAL_CONTENT_COMPLETENESS_LEVEL.PLAYABLE, {
    definitionID: "abyssal:fierce-dark",
    filamentTypeID: 47893,
    filamentName: "Fierce Dark Filament",
    tier: 3,
    weatherType: "dark",
    weatherName: "Dark Matter Field",
    npcProfile: (0, scope.buildPlaceholderNpcProfile)({
      amount: 2,
    }),
    cacheProfile: (0, scope.buildPlaceholderCacheProfile)({
      cacheDisplayName: "Fierce Abyssal Cache (Placeholder)",
    }),
    extractionNodeProfile: (0, scope.buildPlaceholderExtractionNodeProfileFromTemplate)("abyssal:extraction:fierce-dark-side-node"),
    rewardProfile: (0, scope.buildPlaceholderRewardProfileFromTemplate)("abyssal:reward:fierce-dark-placeholder"),
    roomEncounterProfilesByIndex: (0, scope.buildHigherTierRoomEncounterProfiles)(3),
    placeholderNotes: [
      "Three-room placeholder run only.",
      "Tier 3 uses the Fierce mixed drone/Triglavian baseline, not retail encounter parity.",
      "Dark weather selects the tier-appropriate 30/50/70 percent penalty per run and always applies the 50 percent maximum-velocity bonus.",
      "Reward loot is deterministic placeholder loot, not a retail loot table.",
    ],
  });
}

function buildAbyssalFilamentDefinitionsPart21(scope) {
  return (0, scope.buildProductionAbyssalFilamentDefinition)(scope.ABYSSAL_CONTENT_COMPLETENESS_LEVEL.PLAYABLE, {
    definitionID: "abyssal:fierce-electrical",
    filamentTypeID: 47905,
    filamentName: "Fierce Electrical Filament",
    tier: 3,
    weatherType: "electrical",
    weatherName: "Electrical Storm",
    npcProfile: (0, scope.buildPlaceholderNpcProfile)({
      amount: 2,
    }),
    cacheProfile: (0, scope.buildPlaceholderCacheProfile)({
      cacheDisplayName: "Fierce Electrical Abyssal Cache (Placeholder)",
    }),
    extractionNodeProfile: (0, scope.buildPlaceholderExtractionNodeProfileFromTemplate)("abyssal:extraction:fierce-electrical-side-node"),
    rewardProfile: (0, scope.buildPlaceholderRewardProfileFromTemplate)("abyssal:reward:fierce-electrical-placeholder"),
    roomEncounterProfilesByIndex: (0, scope.buildHigherTierRoomEncounterProfiles)(3),
    placeholderNotes: [
      "Three-room placeholder run only.",
      "Tier 3 uses the Fierce mixed drone/Triglavian baseline, not retail encounter parity.",
      "Electrical weather uses deterministic placeholder strength instead of retail site rolls.",
      "Reward loot is deterministic placeholder loot, not a retail loot table.",
    ],
  });
}

function buildAbyssalFilamentDefinitionsPart22(scope) {
  return (0, scope.buildProductionAbyssalFilamentDefinition)(scope.ABYSSAL_CONTENT_COMPLETENESS_LEVEL.PLAYABLE, {
    definitionID: "abyssal:fierce-exotic",
    filamentTypeID: 47889,
    filamentName: "Fierce Exotic Filament",
    tier: 3,
    weatherType: "exotic",
    weatherName: "Exotic Matter Storm",
    npcProfile: (0, scope.buildPlaceholderNpcProfile)({
      amount: 2,
    }),
    cacheProfile: (0, scope.buildPlaceholderCacheProfile)({
      cacheDisplayName: "Fierce Exotic Abyssal Cache (Placeholder)",
    }),
    extractionNodeProfile: (0, scope.buildPlaceholderExtractionNodeProfileFromTemplate)("abyssal:extraction:fierce-exotic-side-node"),
    rewardProfile: (0, scope.buildPlaceholderRewardProfileFromTemplate)("abyssal:reward:fierce-exotic-placeholder"),
    roomEncounterProfilesByIndex: (0, scope.buildHigherTierRoomEncounterProfiles)(3),
    placeholderNotes: [
      "Three-room placeholder run only.",
      "Tier 3 uses the Fierce mixed drone/Triglavian baseline, not retail encounter parity.",
      "Exotic weather uses deterministic placeholder strength instead of retail site rolls.",
      "Reward loot is deterministic placeholder loot, not a retail loot table.",
    ],
  });
}

function buildAbyssalFilamentDefinitionsPart23(scope) {
  return (0, scope.buildProductionAbyssalFilamentDefinition)(scope.ABYSSAL_CONTENT_COMPLETENESS_LEVEL.PLAYABLE, {
    definitionID: "abyssal:fierce-firestorm",
    filamentTypeID: 47897,
    filamentName: "Fierce Firestorm Filament",
    tier: 3,
    weatherType: "firestorm",
    weatherName: "Plasma Firestorm",
    npcProfile: (0, scope.buildPlaceholderNpcProfile)({
      amount: 2,
    }),
    cacheProfile: (0, scope.buildPlaceholderCacheProfile)({
      cacheDisplayName: "Fierce Firestorm Abyssal Cache (Placeholder)",
    }),
    extractionNodeProfile: (0, scope.buildPlaceholderExtractionNodeProfileFromTemplate)("abyssal:extraction:fierce-firestorm-side-node"),
    rewardProfile: (0, scope.buildPlaceholderRewardProfileFromTemplate)("abyssal:reward:fierce-firestorm-placeholder"),
    roomEncounterProfilesByIndex: (0, scope.buildHigherTierRoomEncounterProfiles)(3),
    placeholderNotes: [
      "Three-room placeholder run only.",
      "Tier 3 uses the Fierce mixed drone/Triglavian baseline, not retail encounter parity.",
      "Firestorm weather uses deterministic placeholder strength instead of retail site rolls.",
      "Reward loot is deterministic placeholder loot, not a retail loot table.",
    ],
  });
}

function buildAbyssalFilamentDefinitionsPart24(scope) {
  return (0, scope.buildProductionAbyssalFilamentDefinition)(scope.ABYSSAL_CONTENT_COMPLETENESS_LEVEL.PLAYABLE, {
    definitionID: "abyssal:fierce-gamma",
    filamentTypeID: 47901,
    filamentName: "Fierce Gamma Filament",
    tier: 3,
    weatherType: "gamma",
    weatherName: "Gamma-Ray Storm",
    npcProfile: (0, scope.buildPlaceholderNpcProfile)({
      amount: 2,
    }),
    cacheProfile: (0, scope.buildPlaceholderCacheProfile)({
      cacheDisplayName: "Fierce Gamma Abyssal Cache (Placeholder)",
    }),
    extractionNodeProfile: (0, scope.buildPlaceholderExtractionNodeProfileFromTemplate)("abyssal:extraction:fierce-gamma-side-node"),
    rewardProfile: (0, scope.buildPlaceholderRewardProfileFromTemplate)("abyssal:reward:fierce-gamma-placeholder"),
    roomEncounterProfilesByIndex: (0, scope.buildHigherTierRoomEncounterProfiles)(3),
    placeholderNotes: [
      "Three-room placeholder run only.",
      "Tier 3 uses the Fierce mixed drone/Triglavian baseline, not retail encounter parity.",
      "Gamma weather uses deterministic placeholder strength instead of retail site rolls.",
      "Reward loot is deterministic placeholder loot, not a retail loot table.",
    ],
  });
}

function buildAbyssalFilamentDefinitionsPart25(scope) {
  return (0, scope.buildProductionAbyssalFilamentDefinition)(scope.ABYSSAL_CONTENT_COMPLETENESS_LEVEL.PLAYABLE, {
    definitionID: "abyssal:raging-dark",
    filamentTypeID: 47894,
    filamentName: "Raging Dark Filament",
    tier: 4,
    weatherType: "dark",
    weatherName: "Dark Matter Field",
    npcProfile: (0, scope.buildPlaceholderNpcProfile)({
      amount: 2,
    }),
    cacheProfile: (0, scope.buildPlaceholderCacheProfile)({
      cacheDisplayName: "Raging Abyssal Cache (Placeholder)",
    }),
    extractionNodeProfile: (0, scope.buildPlaceholderExtractionNodeProfileFromTemplate)("abyssal:extraction:raging-dark-side-node"),
    rewardProfile: (0, scope.buildPlaceholderRewardProfileFromTemplate)("abyssal:reward:raging-dark-placeholder"),
    roomEncounterProfilesByIndex: (0, scope.buildHigherTierRoomEncounterProfiles)(4),
    placeholderNotes: [
      "Three-room placeholder run only.",
      "Tier 4 uses the Raging mixed drone/Triglavian baseline, not retail encounter parity.",
      "Dark weather selects the tier-appropriate 30/50/70 percent penalty per run and always applies the 50 percent maximum-velocity bonus.",
      "Reward loot is deterministic placeholder loot, not a retail loot table.",
    ],
  });
}

function buildAbyssalFilamentDefinitionsPart26(scope) {
  return (0, scope.buildProductionAbyssalFilamentDefinition)(scope.ABYSSAL_CONTENT_COMPLETENESS_LEVEL.PLAYABLE, {
    definitionID: "abyssal:raging-electrical",
    filamentTypeID: 47906,
    filamentName: "Raging Electrical Filament",
    tier: 4,
    weatherType: "electrical",
    weatherName: "Electrical Storm",
    npcProfile: (0, scope.buildPlaceholderNpcProfile)({
      amount: 2,
    }),
    cacheProfile: (0, scope.buildPlaceholderCacheProfile)({
      cacheDisplayName: "Raging Electrical Abyssal Cache (Placeholder)",
    }),
    extractionNodeProfile: (0, scope.buildPlaceholderExtractionNodeProfileFromTemplate)("abyssal:extraction:raging-electrical-side-node"),
    rewardProfile: (0, scope.buildPlaceholderRewardProfileFromTemplate)("abyssal:reward:raging-electrical-placeholder"),
    roomEncounterProfilesByIndex: (0, scope.buildHigherTierRoomEncounterProfiles)(4),
    placeholderNotes: [
      "Three-room placeholder run only.",
      "Tier 4 uses the Raging mixed drone/Triglavian baseline, not retail encounter parity.",
      "Electrical weather uses deterministic placeholder strength instead of retail site rolls.",
      "Reward loot is deterministic placeholder loot, not a retail loot table.",
    ],
  });
}

function buildAbyssalFilamentDefinitionsPart27(scope) {
  return (0, scope.buildProductionAbyssalFilamentDefinition)(scope.ABYSSAL_CONTENT_COMPLETENESS_LEVEL.PLAYABLE, {
    definitionID: "abyssal:raging-exotic",
    filamentTypeID: 47890,
    filamentName: "Raging Exotic Filament",
    tier: 4,
    weatherType: "exotic",
    weatherName: "Exotic Matter Storm",
    npcProfile: (0, scope.buildPlaceholderNpcProfile)({
      amount: 2,
    }),
    cacheProfile: (0, scope.buildPlaceholderCacheProfile)({
      cacheDisplayName: "Raging Exotic Abyssal Cache (Placeholder)",
    }),
    extractionNodeProfile: (0, scope.buildPlaceholderExtractionNodeProfileFromTemplate)("abyssal:extraction:raging-exotic-side-node"),
    rewardProfile: (0, scope.buildPlaceholderRewardProfileFromTemplate)("abyssal:reward:raging-exotic-placeholder"),
    roomEncounterProfilesByIndex: (0, scope.buildHigherTierRoomEncounterProfiles)(4),
    placeholderNotes: [
      "Three-room placeholder run only.",
      "Tier 4 uses the Raging mixed drone/Triglavian baseline, not retail encounter parity.",
      "Exotic weather uses deterministic placeholder strength instead of retail site rolls.",
      "Reward loot is deterministic placeholder loot, not a retail loot table.",
    ],
  });
}

function buildAbyssalFilamentDefinitionsPart28(scope) {
  return (0, scope.buildProductionAbyssalFilamentDefinition)(scope.ABYSSAL_CONTENT_COMPLETENESS_LEVEL.PLAYABLE, {
    definitionID: "abyssal:raging-firestorm",
    filamentTypeID: 47898,
    filamentName: "Raging Firestorm Filament",
    tier: 4,
    weatherType: "firestorm",
    weatherName: "Plasma Firestorm",
    npcProfile: (0, scope.buildPlaceholderNpcProfile)({
      amount: 2,
    }),
    cacheProfile: (0, scope.buildPlaceholderCacheProfile)({
      cacheDisplayName: "Raging Firestorm Abyssal Cache (Placeholder)",
    }),
    extractionNodeProfile: (0, scope.buildPlaceholderExtractionNodeProfileFromTemplate)("abyssal:extraction:raging-firestorm-side-node"),
    rewardProfile: (0, scope.buildPlaceholderRewardProfileFromTemplate)("abyssal:reward:raging-firestorm-placeholder"),
    roomEncounterProfilesByIndex: (0, scope.buildHigherTierRoomEncounterProfiles)(4),
    placeholderNotes: [
      "Three-room placeholder run only.",
      "Tier 4 uses the Raging mixed drone/Triglavian baseline, not retail encounter parity.",
      "Firestorm weather uses deterministic placeholder strength instead of retail site rolls.",
      "Reward loot is deterministic placeholder loot, not a retail loot table.",
    ],
  });
}

function buildAbyssalFilamentDefinitionsPart29(scope) {
  return (0, scope.buildProductionAbyssalFilamentDefinition)(scope.ABYSSAL_CONTENT_COMPLETENESS_LEVEL.PLAYABLE, {
    definitionID: "abyssal:raging-gamma",
    filamentTypeID: 47902,
    filamentName: "Raging Gamma Filament",
    tier: 4,
    weatherType: "gamma",
    weatherName: "Gamma-Ray Storm",
    npcProfile: (0, scope.buildPlaceholderNpcProfile)({
      amount: 2,
    }),
    cacheProfile: (0, scope.buildPlaceholderCacheProfile)({
      cacheDisplayName: "Raging Gamma Abyssal Cache (Placeholder)",
    }),
    extractionNodeProfile: (0, scope.buildPlaceholderExtractionNodeProfileFromTemplate)("abyssal:extraction:raging-gamma-side-node"),
    rewardProfile: (0, scope.buildPlaceholderRewardProfileFromTemplate)("abyssal:reward:raging-gamma-placeholder"),
    roomEncounterProfilesByIndex: (0, scope.buildHigherTierRoomEncounterProfiles)(4),
    placeholderNotes: [
      "Three-room placeholder run only.",
      "Tier 4 uses the Raging mixed drone/Triglavian baseline, not retail encounter parity.",
      "Gamma weather uses deterministic placeholder strength instead of retail site rolls.",
      "Reward loot is deterministic placeholder loot, not a retail loot table.",
    ],
  });
}

function buildAbyssalFilamentDefinitionsPart30(scope) {
  return (0, scope.buildProductionAbyssalFilamentDefinition)(scope.ABYSSAL_CONTENT_COMPLETENESS_LEVEL.BASELINE_COMPLETE, {
    definitionID: "abyssal:chaotic-dark",
    filamentTypeID: 47895,
    filamentName: "Chaotic Dark Filament",
    tier: 5,
    weatherType: "dark",
    weatherName: "Dark Matter Field",
    npcProfile: (0, scope.buildPlaceholderNpcProfile)({
      amount: 3,
    }),
    cacheProfile: (0, scope.buildPlaceholderCacheProfile)({
      cacheDisplayName: "Chaotic Abyssal Cache (Placeholder)",
    }),
    extractionNodeProfile: (0, scope.buildPlaceholderExtractionNodeProfileFromTemplate)("abyssal:extraction:chaotic-dark-side-node"),
    rewardProfile: (0, scope.buildPlaceholderRewardProfileFromTemplate)("abyssal:reward:chaotic-dark-placeholder"),
    roomEncounterProfilesByIndex: (0, scope.buildHigherTierRoomEncounterProfiles)(5),
    retailNotes: [
      "Tier and weather are inferred from the filament name while full retail data remains unauthored.",
      "Real Chaotic Dark encounter composition and loot tables remain future work.",
    ],
    placeholderNotes: [
      "Three-room placeholder run only.",
      "Tier 5 uses the Chaotic mixed drone/Triglavian baseline, not retail encounter parity.",
      "Dark weather selects the tier-appropriate 30/50/70 percent penalty per run and always applies the 50 percent maximum-velocity bonus.",
      "Reward loot is deterministic placeholder loot, not a retail loot table.",
    ],
  });
}

function buildAbyssalFilamentDefinitionsPart31(scope) {
  return (0, scope.buildProductionAbyssalFilamentDefinition)(scope.ABYSSAL_CONTENT_COMPLETENESS_LEVEL.BASELINE_COMPLETE, {
    definitionID: "abyssal:chaotic-electrical",
    filamentTypeID: 47907,
    filamentName: "Chaotic Electrical Filament",
    tier: 5,
    weatherType: "electrical",
    weatherName: "Electrical Storm",
    npcProfile: (0, scope.buildPlaceholderNpcProfile)({
      amount: 3,
    }),
    cacheProfile: (0, scope.buildPlaceholderCacheProfile)({
      cacheDisplayName: "Chaotic Electrical Abyssal Cache (Placeholder)",
    }),
    extractionNodeProfile: (0, scope.buildPlaceholderExtractionNodeProfileFromTemplate)("abyssal:extraction:chaotic-electrical-side-node"),
    rewardProfile: (0, scope.buildPlaceholderRewardProfileFromTemplate)("abyssal:reward:chaotic-electrical-placeholder"),
    roomEncounterProfilesByIndex: (0, scope.buildHigherTierRoomEncounterProfiles)(5),
    retailNotes: [
      "Tier and weather are inferred from the filament name while full retail data remains unauthored.",
      "Real Chaotic Electrical encounter composition and loot tables remain future work.",
    ],
    placeholderNotes: [
      "Three-room placeholder run only.",
      "Tier 5 uses the Chaotic mixed drone/Triglavian baseline, not retail encounter parity.",
      "Electrical weather uses deterministic placeholder strength instead of retail site rolls.",
      "Reward loot is deterministic placeholder loot, not a retail loot table.",
    ],
  });
}

function buildAbyssalFilamentDefinitionsPart32(scope) {
  return (0, scope.buildProductionAbyssalFilamentDefinition)(scope.ABYSSAL_CONTENT_COMPLETENESS_LEVEL.BASELINE_COMPLETE, {
    definitionID: "abyssal:chaotic-exotic",
    filamentTypeID: 47891,
    filamentName: "Chaotic Exotic Filament",
    tier: 5,
    weatherType: "exotic",
    weatherName: "Exotic Matter Storm",
    npcProfile: (0, scope.buildPlaceholderNpcProfile)({
      amount: 3,
    }),
    cacheProfile: (0, scope.buildPlaceholderCacheProfile)({
      cacheDisplayName: "Chaotic Exotic Abyssal Cache (Placeholder)",
    }),
    extractionNodeProfile: (0, scope.buildPlaceholderExtractionNodeProfileFromTemplate)("abyssal:extraction:chaotic-exotic-side-node"),
    rewardProfile: (0, scope.buildPlaceholderRewardProfileFromTemplate)("abyssal:reward:chaotic-exotic-placeholder"),
    roomEncounterProfilesByIndex: (0, scope.buildHigherTierRoomEncounterProfiles)(5),
    retailNotes: [
      "Tier and weather are inferred from the filament name while full retail data remains unauthored.",
      "Real Chaotic Exotic encounter composition and loot tables remain future work.",
    ],
    placeholderNotes: [
      "Three-room placeholder run only.",
      "Tier 5 uses the Chaotic mixed drone/Triglavian baseline, not retail encounter parity.",
      "Exotic weather uses deterministic placeholder strength instead of retail site rolls.",
      "Reward loot is deterministic placeholder loot, not a retail loot table.",
    ],
  });
}

function buildAbyssalFilamentDefinitionsPart33(scope) {
  return (0, scope.buildProductionAbyssalFilamentDefinition)(scope.ABYSSAL_CONTENT_COMPLETENESS_LEVEL.BASELINE_COMPLETE, {
    definitionID: "abyssal:chaotic-firestorm",
    filamentTypeID: 47899,
    filamentName: "Chaotic Firestorm Filament",
    tier: 5,
    weatherType: "firestorm",
    weatherName: "Plasma Firestorm",
    npcProfile: (0, scope.buildPlaceholderNpcProfile)({
      amount: 3,
    }),
    cacheProfile: (0, scope.buildPlaceholderCacheProfile)({
      cacheDisplayName: "Chaotic Firestorm Abyssal Cache (Placeholder)",
    }),
    extractionNodeProfile: (0, scope.buildPlaceholderExtractionNodeProfileFromTemplate)("abyssal:extraction:chaotic-firestorm-side-node"),
    rewardProfile: (0, scope.buildPlaceholderRewardProfileFromTemplate)("abyssal:reward:chaotic-firestorm-placeholder"),
    roomEncounterProfilesByIndex: (0, scope.buildHigherTierRoomEncounterProfiles)(5),
    retailNotes: [
      "Tier and weather are inferred from the filament name while full retail data remains unauthored.",
      "Real Chaotic Firestorm encounter composition and loot tables remain future work.",
    ],
    placeholderNotes: [
      "Three-room placeholder run only.",
      "Tier 5 uses the Chaotic mixed drone/Triglavian baseline, not retail encounter parity.",
      "Firestorm weather uses deterministic placeholder strength instead of retail site rolls.",
      "Reward loot is deterministic placeholder loot, not a retail loot table.",
    ],
  });
}

function buildAbyssalFilamentDefinitionsPart34(scope) {
  return (0, scope.buildProductionAbyssalFilamentDefinition)(scope.ABYSSAL_CONTENT_COMPLETENESS_LEVEL.BASELINE_COMPLETE, {
    definitionID: "abyssal:chaotic-gamma",
    filamentTypeID: 47903,
    filamentName: "Chaotic Gamma Filament",
    tier: 5,
    weatherType: "gamma",
    weatherName: "Gamma-Ray Storm",
    npcProfile: (0, scope.buildPlaceholderNpcProfile)({
      amount: 3,
    }),
    cacheProfile: (0, scope.buildPlaceholderCacheProfile)({
      cacheDisplayName: "Chaotic Gamma Abyssal Cache (Placeholder)",
    }),
    extractionNodeProfile: (0, scope.buildPlaceholderExtractionNodeProfileFromTemplate)("abyssal:extraction:chaotic-gamma-side-node"),
    rewardProfile: (0, scope.buildPlaceholderRewardProfileFromTemplate)("abyssal:reward:chaotic-gamma-placeholder"),
    roomEncounterProfilesByIndex: (0, scope.buildHigherTierRoomEncounterProfiles)(5),
    retailNotes: [
      "Tier and weather are inferred from the filament name while full retail data remains unauthored.",
      "Real Chaotic Gamma encounter composition and loot tables remain future work.",
    ],
    placeholderNotes: [
      "Three-room placeholder run only.",
      "Tier 5 uses the Chaotic mixed drone/Triglavian baseline, not retail encounter parity.",
      "Gamma weather uses deterministic placeholder strength instead of retail site rolls.",
      "Reward loot is deterministic placeholder loot, not a retail loot table.",
    ],
  });
}

function buildAbyssalFilamentDefinitionsPart35(scope) {
  return (0, scope.buildProductionAbyssalFilamentDefinition)(scope.ABYSSAL_CONTENT_COMPLETENESS_LEVEL.BASELINE_COMPLETE, {
    definitionID: "abyssal:cataclysmic-dark",
    filamentTypeID: 56140,
    filamentName: "Cataclysmic Dark Filament",
    tier: 6,
    weatherType: "dark",
    weatherName: "Dark Matter Field",
    npcProfile: (0, scope.buildPlaceholderNpcProfile)({
      amount: 3,
    }),
    cacheProfile: (0, scope.buildPlaceholderCacheProfile)({
      cacheDisplayName: "Cataclysmic Abyssal Cache (Placeholder)",
    }),
    extractionNodeProfile: (0, scope.buildPlaceholderExtractionNodeProfileFromTemplate)("abyssal:extraction:cataclysmic-dark-side-node"),
    rewardProfile: (0, scope.buildPlaceholderRewardProfileFromTemplate)("abyssal:reward:cataclysmic-dark-placeholder"),
    roomEncounterProfilesByIndex: (0, scope.buildHigherTierRoomEncounterProfiles)(6),
    placeholderNotes: [
      "Three-room placeholder run only.",
      "Tier 6 uses the Cataclysmic mixed drone/Triglavian baseline, not retail encounter parity.",
      "Dark weather selects the tier-appropriate 30/50/70 percent penalty per run and always applies the 50 percent maximum-velocity bonus.",
      "Reward loot is deterministic placeholder loot, not a retail loot table.",
    ],
  });
}

function buildAbyssalFilamentDefinitionsPart36(scope) {
  return (0, scope.buildProductionAbyssalFilamentDefinition)(scope.ABYSSAL_CONTENT_COMPLETENESS_LEVEL.BASELINE_COMPLETE, {
    definitionID: "abyssal:cataclysmic-electrical",
    filamentTypeID: 56139,
    filamentName: "Cataclysmic Electrical Filament",
    tier: 6,
    weatherType: "electrical",
    weatherName: "Electrical Storm",
    npcProfile: (0, scope.buildPlaceholderNpcProfile)({
      amount: 3,
    }),
    cacheProfile: (0, scope.buildPlaceholderCacheProfile)({
      cacheDisplayName: "Cataclysmic Electrical Abyssal Cache (Placeholder)",
    }),
    extractionNodeProfile: (0, scope.buildPlaceholderExtractionNodeProfileFromTemplate)("abyssal:extraction:cataclysmic-electrical-side-node"),
    rewardProfile: (0, scope.buildPlaceholderRewardProfileFromTemplate)("abyssal:reward:cataclysmic-electrical-placeholder"),
    roomEncounterProfilesByIndex: (0, scope.buildHigherTierRoomEncounterProfiles)(6),
    placeholderNotes: [
      "Three-room placeholder run only.",
      "Tier 6 uses the Cataclysmic mixed drone/Triglavian baseline, not retail encounter parity.",
      "Electrical weather uses deterministic placeholder strength instead of retail site rolls.",
      "Reward loot is deterministic placeholder loot, not a retail loot table.",
    ],
  });
}

function buildAbyssalFilamentDefinitionsPart37(scope) {
  return (0, scope.buildProductionAbyssalFilamentDefinition)(scope.ABYSSAL_CONTENT_COMPLETENESS_LEVEL.BASELINE_COMPLETE, {
    definitionID: "abyssal:cataclysmic-exotic",
    filamentTypeID: 56141,
    filamentName: "Cataclysmic Exotic Filament",
    tier: 6,
    weatherType: "exotic",
    weatherName: "Exotic Matter Storm",
    npcProfile: (0, scope.buildPlaceholderNpcProfile)({
      amount: 3,
    }),
    cacheProfile: (0, scope.buildPlaceholderCacheProfile)({
      cacheDisplayName: "Cataclysmic Exotic Abyssal Cache (Placeholder)",
    }),
    extractionNodeProfile: (0, scope.buildPlaceholderExtractionNodeProfileFromTemplate)("abyssal:extraction:cataclysmic-exotic-side-node"),
    rewardProfile: (0, scope.buildPlaceholderRewardProfileFromTemplate)("abyssal:reward:cataclysmic-exotic-placeholder"),
    roomEncounterProfilesByIndex: (0, scope.buildHigherTierRoomEncounterProfiles)(6),
    placeholderNotes: [
      "Three-room placeholder run only.",
      "Tier 6 uses the Cataclysmic mixed drone/Triglavian baseline, not retail encounter parity.",
      "Exotic weather uses deterministic placeholder strength instead of retail site rolls.",
      "Reward loot is deterministic placeholder loot, not a retail loot table.",
    ],
  });
}

function buildAbyssalFilamentDefinitionsPart38(scope) {
  return (0, scope.buildProductionAbyssalFilamentDefinition)(scope.ABYSSAL_CONTENT_COMPLETENESS_LEVEL.BASELINE_COMPLETE, {
    definitionID: "abyssal:cataclysmic-firestorm",
    filamentTypeID: 56142,
    filamentName: "Cataclysmic Firestorm Filament",
    tier: 6,
    weatherType: "firestorm",
    weatherName: "Plasma Firestorm",
    npcProfile: (0, scope.buildPlaceholderNpcProfile)({
      amount: 3,
    }),
    cacheProfile: (0, scope.buildPlaceholderCacheProfile)({
      cacheDisplayName: "Cataclysmic Abyssal Cache (Placeholder)",
    }),
    extractionNodeProfile: (0, scope.buildPlaceholderExtractionNodeProfileFromTemplate)("abyssal:extraction:cataclysmic-firestorm-side-node"),
    rewardProfile: (0, scope.buildPlaceholderRewardProfileFromTemplate)("abyssal:reward:cataclysmic-firestorm-placeholder"),
    roomEncounterProfilesByIndex: (0, scope.buildHigherTierRoomEncounterProfiles)(6),
    placeholderNotes: [
      "Three-room placeholder run only.",
      "Tier 6 uses the Cataclysmic mixed drone/Triglavian baseline, not retail encounter parity.",
      "Firestorm weather uses deterministic placeholder strength instead of retail site rolls.",
      "Reward loot is deterministic placeholder loot, not a retail loot table.",
    ],
  });
}

function buildAbyssalFilamentDefinitionsPart39(scope) {
  return (0, scope.buildProductionAbyssalFilamentDefinition)(scope.ABYSSAL_CONTENT_COMPLETENESS_LEVEL.BASELINE_COMPLETE, {
    definitionID: "abyssal:cataclysmic-gamma",
    filamentTypeID: 56143,
    filamentName: "Cataclysmic Gamma Filament",
    tier: 6,
    weatherType: "gamma",
    weatherName: "Gamma-Ray Storm",
    npcProfile: (0, scope.buildPlaceholderNpcProfile)({
      amount: 3,
    }),
    cacheProfile: (0, scope.buildPlaceholderCacheProfile)({
      cacheDisplayName: "Cataclysmic Gamma Abyssal Cache (Placeholder)",
    }),
    extractionNodeProfile: (0, scope.buildPlaceholderExtractionNodeProfileFromTemplate)("abyssal:extraction:cataclysmic-gamma-side-node"),
    rewardProfile: (0, scope.buildPlaceholderRewardProfileFromTemplate)("abyssal:reward:cataclysmic-gamma-placeholder"),
    roomEncounterProfilesByIndex: (0, scope.buildHigherTierRoomEncounterProfiles)(6),
    placeholderNotes: [
      "Three-room placeholder run only.",
      "Tier 6 uses the Cataclysmic mixed drone/Triglavian baseline, not retail encounter parity.",
      "Gamma weather uses deterministic placeholder strength instead of retail site rolls.",
      "Reward loot is deterministic placeholder loot, not a retail loot table.",
    ],
  });
}

function buildAbyssalFilamentDefinitionsPart2(scope) {
  return {
  56132: buildAbyssalFilamentDefinitionsPart3(scope),
  56131: buildAbyssalFilamentDefinitionsPart6(scope),
  56133: buildAbyssalFilamentDefinitionsPart7(scope),
  56134: buildAbyssalFilamentDefinitionsPart8(scope),
  56136: buildAbyssalFilamentDefinitionsPart9(scope),
  47762: buildAbyssalFilamentDefinitionsPart10(scope),
  47765: buildAbyssalFilamentDefinitionsPart11(scope),
  47761: buildAbyssalFilamentDefinitionsPart12(scope),
  47763: buildAbyssalFilamentDefinitionsPart13(scope),
  47764: buildAbyssalFilamentDefinitionsPart14(scope),
  47892: buildAbyssalFilamentDefinitionsPart15(scope),
  47904: buildAbyssalFilamentDefinitionsPart16(scope),
  47888: buildAbyssalFilamentDefinitionsPart17(scope),
  47896: buildAbyssalFilamentDefinitionsPart18(scope),
  47900: buildAbyssalFilamentDefinitionsPart19(scope),
  47893: buildAbyssalFilamentDefinitionsPart20(scope),
  47905: buildAbyssalFilamentDefinitionsPart21(scope),
  47889: buildAbyssalFilamentDefinitionsPart22(scope),
  47897: buildAbyssalFilamentDefinitionsPart23(scope),
  47901: buildAbyssalFilamentDefinitionsPart24(scope),
  47894: buildAbyssalFilamentDefinitionsPart25(scope),
  47906: buildAbyssalFilamentDefinitionsPart26(scope),
  47890: buildAbyssalFilamentDefinitionsPart27(scope),
  47898: buildAbyssalFilamentDefinitionsPart28(scope),
  47902: buildAbyssalFilamentDefinitionsPart29(scope),
  47895: buildAbyssalFilamentDefinitionsPart30(scope),
  47907: buildAbyssalFilamentDefinitionsPart31(scope),
  47891: buildAbyssalFilamentDefinitionsPart32(scope),
  47899: buildAbyssalFilamentDefinitionsPart33(scope),
  47903: buildAbyssalFilamentDefinitionsPart34(scope),
  56140: buildAbyssalFilamentDefinitionsPart35(scope),
  56139: buildAbyssalFilamentDefinitionsPart36(scope),
  56141: buildAbyssalFilamentDefinitionsPart37(scope),
  56142: buildAbyssalFilamentDefinitionsPart38(scope),
  56143: buildAbyssalFilamentDefinitionsPart39(scope),
};
}

function buildAbyssalFilamentDefinitionsPart1(scope) {
  return (0, scope.deepFreeze)(buildAbyssalFilamentDefinitionsPart2(scope));
}

function initializeAbyssalFilamentDefinitions(scope) {
  scope.ABYSSAL_FILAMENT_DEFINITIONS_BY_TYPE_ID = buildAbyssalFilamentDefinitionsPart1(scope);
}

module.exports = { initializeAbyssalFilamentDefinitions };
