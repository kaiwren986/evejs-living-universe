"use strict";

// Private fixed capability links preserve late reads during catalogue initialization.
function buildAgitatedTier2RoomEncounterProfilesOperation(ports) {
  const room2ExtractionNodeProfile = (0, ports.buildAgitatedTier2RoomExtractionNodeProfile)({
    extractionNodeProfileID: ports.ABYSSAL_AGITATED_ROOM2_EXTRACTION_PROFILE_ID,
    lootTableID: "abyssal:loot:agitated-extraction-room2-v1",
    displayName: "Agitated Room 2 Side Loot Node",
    eligibleRoomIndexes: [2],
    guaranteedLootEntries: (0, ports.cloneValue)(ports.ABYSSAL_CALM_DARK_ROOM2_EXTRACTION_GUARANTEED_LOOT_ENTRIES),
    placeholderNotes: [
      "Tier 2 room two uses the Calm room-two extraction item composition with Tier 2 runtime scaling.",
    ],
  });
  const room3ExtractionNodeProfile = (0, ports.buildAgitatedTier2RoomExtractionNodeProfile)({
    extractionNodeProfileID: ports.ABYSSAL_AGITATED_ROOM3_EXTRACTION_PROFILE_ID,
    lootTableID: "abyssal:loot:agitated-extraction-room3-v1",
    displayName: "Agitated Room 3 Side Loot Node",
    eligibleRoomIndexes: [3],
    guaranteedLootEntries: (0, ports.cloneValue)(ports.ABYSSAL_CALM_EXTRACTION_GUARANTEED_LOOT_ENTRIES),
    placeholderNotes: [
      "Tier 2 room three uses the Calm room-three extraction item composition with Tier 2 runtime scaling.",
    ],
  });
  return Object.fromEntries(
    ports.ABYSSAL_ENCOUNTER_RESOLVER.listAuthoredEncounterProfiles(2)
      .map((profile) => {
      const roomIndex = profile.eligibleRoomIndexes[0] || profile.roomIndex || 1;
      return [
        String(roomIndex),
        (0, ports.buildPlaceholderRoomEncounterProfile)({
        ...(0, ports.cloneValue)(profile),
        roomIndex,
        tierBandID: "agitated",
        tierBandLabel: "Agitated",
        tierRange: {
          minTier: 2,
          maxTier: 2,
        },
        rewardProfileOverride: null,
        extractionNodeProfileOverride:
          roomIndex === 2
            ? room2ExtractionNodeProfile
            : roomIndex === 3
              ? room3ExtractionNodeProfile
              : null,
        placeholderNotes: [
          "Tier 2 Agitated baseline uses audited local Abyssal drone and Triglavian entity types.",
          "No forbidden electronic warfare is enabled in this first Tier 2 slice.",
        ],
      }),
      ];
    }),
  );
}

function buildHigherTierRoomEncounterProfilesOperation(ports, tier) {
  const tierKey = ports.ABYSSAL_HIGHER_TIER_KEY_BY_TIER[tier];
  const tierLabel = ports.ABYSSAL_HIGHER_TIER_LABEL_BY_TIER[tier];
  const roomExtractionProfiles = {
    2: (0, ports.buildHigherTierRoomExtractionNodeProfile)({
      tier,
      tierKey,
      tierLabel,
      roomIndex: 2,
      guaranteedLootEntries: (0, ports.cloneValue)(ports.ABYSSAL_CALM_DARK_ROOM2_EXTRACTION_GUARANTEED_LOOT_ENTRIES),
    }),
    3: (0, ports.buildHigherTierRoomExtractionNodeProfile)({
      tier,
      tierKey,
      tierLabel,
      roomIndex: 3,
      guaranteedLootEntries: (0, ports.cloneValue)(ports.ABYSSAL_CALM_EXTRACTION_GUARANTEED_LOOT_ENTRIES),
    }),
  };
  return Object.fromEntries(
    ports.ABYSSAL_ENCOUNTER_RESOLVER.listAuthoredEncounterProfiles(tier)
      .map((profile) => {
      const roomIndex = profile.eligibleRoomIndexes[0] || profile.roomIndex || 1;
      return [
        String(roomIndex),
        (0, ports.buildPlaceholderRoomEncounterProfile)({
          ...(0, ports.cloneValue)(profile),
          roomIndex,
          tierBandID: tierKey,
          tierBandLabel: tierLabel,
          tierRange: {
            minTier: tier,
            maxTier: tier,
          },
          rewardProfileOverride: null,
          extractionNodeProfileOverride: roomExtractionProfiles[roomIndex] || null,
          placeholderNotes: [
            `Tier ${tier} ${tierLabel} baseline uses audited local Abyssal drone and Triglavian entity types.`,
            "No forbidden electronic warfare is enabled in this baseline slice.",
          ],
        }),
      ];
    }),
  );
}

function buildCalmDarkRequestedRoomEncounterProfilesOperation(ports) {
  const room2ExtractionNodeProfile = (0, ports.buildCalmDarkRoomExtractionNodeProfile)({
    extractionNodeProfileID: ports.ABYSSAL_CALM_DARK_ROOM2_EXTRACTION_PROFILE_ID,
    lootTableID: "abyssal:loot:calm-dark-extraction-room2-v1",
    displayName: "Calm Dark Room 2 Side Loot Node",
    eligibleRoomIndexes: [2],
    guaranteedLootEntries: (0, ports.cloneValue)(ports.ABYSSAL_CALM_DARK_ROOM2_EXTRACTION_GUARANTEED_LOOT_ENTRIES),
    placeholderNotes: [
      "Calm Dark room two keeps extraction loot as a small optional side reward.",
    ],
  });
  const room3ExtractionNodeProfile = (0, ports.buildCalmDarkRoomExtractionNodeProfile)({
    extractionNodeProfileID: ports.ABYSSAL_CALM_DARK_ROOM3_EXTRACTION_PROFILE_ID,
    lootTableID: "abyssal:loot:calm-dark-extraction-room3-v1",
    displayName: "Calm Dark Room 3 Side Loot Node",
    eligibleRoomIndexes: [3],
    guaranteedLootEntries: (0, ports.cloneValue)(ports.ABYSSAL_CALM_EXTRACTION_GUARANTEED_LOOT_ENTRIES),
    placeholderNotes: [
      "Calm Dark room three keeps extraction loot optional but better than room two.",
    ],
  });
  return {
    1: (0, ports.buildPlaceholderRoomEncounterProfile)({
      roomIndex: 1,
      encounterProfileID: "abyssal:encounter:calm-dark-room1-skirmish-v1",
      contentAuthority: ports.ABYSSAL_CONTENT_AUTHORITY.PROJECT_AUTHORED,
      encounterName: "Calm Dark Room 1 Skirmish",
      factionTheme: "guristas",
      weatherTheme: "dark",
      tierBandID: "low",
      tierBandLabel: "Low",
      tierRange: {
        minTier: 0,
        maxTier: 1,
      },
      npcEntries: [{
        npcEntryID: "guristas_arrogator",
        profileQuery: "parity_guristas_missile_frigate",
        count: 4,
        spawnOffsetMeters: 6_000,
      }],
      placeholderNotes: [
        "Calm Dark room one uses the requested Guristas Arrogator composition.",
      ],
    }),
    2: (0, ports.buildPlaceholderRoomEncounterProfile)({
      roomIndex: 2,
      encounterProfileID: "abyssal:encounter:calm-dark-room2-mixed-screen-v1",
      contentAuthority: ports.ABYSSAL_CONTENT_AUTHORITY.PROJECT_AUTHORED,
      encounterName: "Calm Dark Room 2 Mixed Screen",
      factionTheme: "guristas",
      weatherTheme: "dark",
      tierBandID: "low",
      tierBandLabel: "Low",
      tierRange: {
        minTier: 0,
        maxTier: 1,
      },
      npcEntries: [
        {
          npcEntryID: "pithi_defender",
          profileQuery: "parity_pithi_defender",
          count: 2,
          spawnOffsetMeters: 8_000,
        },
        {
          npcEntryID: "guristas_arrogator",
          profileQuery: "parity_guristas_missile_frigate",
          count: 3,
          spawnOffsetMeters: 10_000,
        },
      ],
      rewardProfileOverride: null,
      extractionNodeProfileOverride: room2ExtractionNodeProfile,
      placeholderNotes: [
        "Calm Dark room two uses the requested Pithi Defender and Guristas Arrogator composition.",
      ],
    }),
    3: (0, ports.buildPlaceholderRoomEncounterProfile)({
      roomIndex: 3,
      encounterProfileID: "abyssal:encounter:calm-dark-room3-final-guard-v1",
      contentAuthority: ports.ABYSSAL_CONTENT_AUTHORITY.PROJECT_AUTHORED,
      encounterName: "Calm Dark Room 3 Final Guard",
      factionTheme: "guristas",
      weatherTheme: "dark",
      tierBandID: "low",
      tierBandLabel: "Low",
      tierRange: {
        minTier: 0,
        maxTier: 1,
      },
      npcEntries: [
        {
          npcEntryID: "dread_pithi_saboteur",
          profileQuery: "parity_dread_pithi_saboteur",
          count: 1,
          spawnOffsetMeters: 7_000,
        },
        {
          npcEntryID: "dread_pithi_invader",
          profileQuery: "parity_dread_pithi_invader",
          count: 1,
          spawnOffsetMeters: 9_000,
        },
        {
          npcEntryID: "dread_pithi_terminator",
          profileQuery: "parity_deadspace_overseer_26684_dread_pithi_terminator",
          count: 1,
          spawnOffsetMeters: 11_000,
        },
      ],
      rewardProfileOverride: null,
      extractionNodeProfileOverride: room3ExtractionNodeProfile,
      placeholderNotes: [
        "Calm Dark room three uses the requested locally resolved Dread Pithi final-guard composition.",
      ],
    }),
  };
}

function buildTranquilDarkRequestedRoomEncounterProfilesOperation(ports) {
  const calmProfiles = (0, ports.buildCalmDarkRequestedRoomEncounterProfiles)();
  return Object.fromEntries(
    Object.entries(calmProfiles).map(([roomIndex, profile]) => {
      const tranquilProfile = (0, ports.cloneValue)(profile);
      tranquilProfile.tierRange = {
        minTier: 0,
        maxTier: 0,
      };
      tranquilProfile.rewardProfileOverride =
        (0, ports.buildTranquilDarkProceduralRewardProfile)();
      if (tranquilProfile.extractionNodeProfileOverride) {
        tranquilProfile.extractionNodeProfileOverride = null;
      }
      return [roomIndex, (0, ports.buildPlaceholderRoomEncounterProfile)(tranquilProfile)];
    }),
  );
}

function buildRoomEncounterProfileFromTemplateOperation(ports, templateID, overrides = {}) {
  const template =
    ports.ABYSSAL_PLACEHOLDER_ROOM_ENCOUNTER_TEMPLATES_BY_ID[String(templateID || "")] ||
    ports.ABYSSAL_PLACEHOLDER_ROOM_ENCOUNTER_TEMPLATES_BY_ID.abyssal_test_guristas_frigates;
  return (0, ports.buildPlaceholderRoomEncounterProfile)({
    ...(0, ports.cloneValue)(template),
    ...(0, ports.cloneValue)(overrides),
  });
}

function resolvePlaceholderRoomHostileCountsOperation(ports, tier) {
  const normalizedTier = Math.max(1, (0, ports.toInteger)(tier, 1));
  if (normalizedTier >= 5) {
    return [3, 3, 4];
  }
  if (normalizedTier >= 2) {
    return [2, 2, 3];
  }
  return [1, 1, 2];
}

function buildAbyssalEncounterNpcEntriesOperation(ports, {
  primaryProfileQuery,
  supportProfileQuery,
  hostileCount,
  roomIndex,
}) {
  const normalizedCount = Math.max(1, (0, ports.toInteger)(hostileCount, 1));
  const resolvedRoomIndex = Math.max(1, Math.min(3, (0, ports.toInteger)(roomIndex, 1)));
  let supportCount = 0;
  if (resolvedRoomIndex === 2 && normalizedCount > 1) {
    supportCount = 1;
  } else if (resolvedRoomIndex >= 3 && normalizedCount > 1) {
    supportCount = normalizedCount >= 4 ? 2 : 1;
  }
  const primaryCount = Math.max(1, normalizedCount - supportCount);
  const entries = [
    (0, ports.buildPlaceholderEncounterNpcEntry)({
      npcEntryID: "primary",
      profileQuery: primaryProfileQuery,
      count: primaryCount,
      spawnOffsetMeters: resolvedRoomIndex === 1 ? 6_000 : resolvedRoomIndex === 2 ? 8_000 : 7_000,
      objectiveRole: "kill_all_hostiles",
      spawnReference: "ship_spawn",
      spawnDistanceMode: "ahead_of_ship",
      placeholderNotes: [
        "Primary authored placeholder Abyssal NPC entry.",
      ],
    }),
  ];
  if (supportCount > 0) {
    entries.push((0, ports.buildPlaceholderEncounterNpcEntry)({
      npcEntryID: "support",
      profileQuery: supportProfileQuery || primaryProfileQuery,
      count: supportCount,
      spawnOffsetMeters: resolvedRoomIndex === 2 ? 10_000 : 9_500,
      objectiveRole: "kill_all_hostiles",
      spawnReference: "ship_spawn",
      spawnDistanceMode: "ahead_of_ship",
      placeholderNotes: [
        "Support authored placeholder Abyssal NPC entry.",
      ],
    }));
  }
  return entries;
}

function buildPlaceholderEncounterArchetypeForDefinitionOperation(ports, definition = {}, roomIndex, hostileCount) {
  const resolvedRoomIndex = Math.max(1, Math.min(3, (0, ports.toInteger)(roomIndex, 1)));
  const weatherTheme = String(definition && definition.weatherType || "").trim().toLowerCase() || "unknown";
  const weatherLabel = String(definition && definition.weatherName || "Abyssal");
  const authoredNpcProfile =
    definition && definition.npcProfile && typeof definition.npcProfile === "object"
      ? definition.npcProfile
      : {};
  const {
    profileQuery: ignoredAuthoredProfileQuery,
    ...authoredNpcProfileOverrides
  } = authoredNpcProfile;
  void ignoredAuthoredProfileQuery;
  const encounterVariety = (0, ports.resolveAbyssalEncounterVariety)(weatherTheme, authoredNpcProfileOverrides);
  const tierBand = (0, ports.resolveAbyssalEncounterTierBand)(definition && definition.tier);
  const archetypeSpec = (0, ports.resolveAbyssalEncounterArchetypeSpec)(weatherTheme, resolvedRoomIndex);
  const primaryProfile = (0, ports.buildPlaceholderNpcProfile)({
    ...authoredNpcProfileOverrides,
    profileQuery: encounterVariety.profileID,
  });
  const npcEntries = (0, ports.buildAbyssalEncounterNpcEntries)({
    primaryProfileQuery: String(primaryProfile.profileQuery || ports.ABYSSAL_EXPLICIT_PLACEHOLDER_NPC_PROFILE_ID),
    supportProfileQuery: String(
      encounterVariety.supportProfileID || encounterVariety.profileID || ports.ABYSSAL_EXPLICIT_PLACEHOLDER_NPC_PROFILE_ID
    ),
    hostileCount,
    roomIndex: resolvedRoomIndex,
  });
  return (0, ports.buildPlaceholderRoomEncounterProfile)({
    roomIndex: resolvedRoomIndex,
    encounterProfileID: `abyssal:encounter:${archetypeSpec.archetypeKey}-${tierBand.tierBandID}`,
    contentAuthority:
      definition && definition.definitionContentAuthority ===
        ports.ABYSSAL_CONTENT_AUTHORITY.DEBUG_PLACEHOLDER
        ? ports.ABYSSAL_CONTENT_AUTHORITY.DEBUG_PLACEHOLDER
        : ports.ABYSSAL_CONTENT_AUTHORITY.PROJECT_AUTHORED,
    encounterName: `${weatherLabel} ${archetypeSpec.displayName} (${tierBand.label} Placeholder)`,
    factionTheme: String(
      archetypeSpec.factionTheme ||
      encounterVariety.factionTheme ||
      primaryProfile.factionTheme ||
      "guristas"
    ),
    weatherTheme,
    tierBandID: tierBand.tierBandID,
    tierBandLabel: tierBand.label,
    tierRange: {
      minTier: tierBand.minTier,
      maxTier: tierBand.maxTier,
    },
    npcEntries,
    rewardMultiplier: resolvedRoomIndex === 1 ? 1 : resolvedRoomIndex === 2 ? 1.2 : 1.5,
    placeholderNotes: [
      "Encounter composition is placeholder-authored for EveJS safety.",
      "Archetype selection is deterministic by weather, tier band, and room index.",
    ],
  });
}

function buildPlaceholderRoomEncounterProfilesForDefinitionOperation(ports, definition = {}) {
  const hostileCounts = (0, ports.resolvePlaceholderRoomHostileCounts)(definition && definition.tier);
  return {
    1: (0, ports.buildPlaceholderEncounterArchetypeForDefinition)(definition, 1, hostileCounts[0]),
    2: (0, ports.buildPlaceholderEncounterArchetypeForDefinition)(definition, 2, hostileCounts[1]),
    3: (0, ports.buildPlaceholderEncounterArchetypeForDefinition)(definition, 3, hostileCounts[2]),
  };
}

function createAbyssalCompatibilityEncounterModels(dependencies) {
  const ports = Object.create(dependencies);
  const model = {
    buildAgitatedTier2RoomEncounterProfiles: buildAgitatedTier2RoomEncounterProfilesOperation.bind(undefined, ports),
    buildHigherTierRoomEncounterProfiles: buildHigherTierRoomEncounterProfilesOperation.bind(undefined, ports),
    buildCalmDarkRequestedRoomEncounterProfiles: buildCalmDarkRequestedRoomEncounterProfilesOperation.bind(undefined, ports),
    buildTranquilDarkRequestedRoomEncounterProfiles: buildTranquilDarkRequestedRoomEncounterProfilesOperation.bind(undefined, ports),
    buildRoomEncounterProfileFromTemplate: buildRoomEncounterProfileFromTemplateOperation.bind(undefined, ports),
    resolvePlaceholderRoomHostileCounts: resolvePlaceholderRoomHostileCountsOperation.bind(undefined, ports),
    buildAbyssalEncounterNpcEntries: buildAbyssalEncounterNpcEntriesOperation.bind(undefined, ports),
    buildPlaceholderEncounterArchetypeForDefinition: buildPlaceholderEncounterArchetypeForDefinitionOperation.bind(undefined, ports),
    buildPlaceholderRoomEncounterProfilesForDefinition: buildPlaceholderRoomEncounterProfilesForDefinitionOperation.bind(undefined, ports),
  };
  Object.assign(ports, model);
  Object.freeze(ports);
  return model;
}

module.exports = { createAbyssalCompatibilityEncounterModels };
