"use strict";

// Private fixed capability links preserve late reads during catalogue initialization.
function buildPlaceholderRoomProfileOperation(ports, overrides = {}) {
  return {
    retailTargetRooms: 3,
    implementedRooms: 3,
    currentRoomIndex: 1,
    completedRooms: 0,
    currentRoomComplete: false,
    roomOriginLabel: "Abyssal Origin Marker (Placeholder)",
    transferConduitLabel: "Transfer Conduit (Triglavian)",
    finalExitConduitLabel: "Origin Conduit (Triglavian)",
    roomOffsetsMeters: [
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 12_000_000, z: 0 },
      { x: 0, y: 24_000_000, z: 0 },
    ],
    finalExitAvailableOnCompletion: true,
    placeholderSingleRoomMode: false,
    ...(0, ports.cloneValue)(overrides),
    contentAuthority: (0, ports.validateAbyssalContentAuthority)(
      overrides.contentAuthority || ports.ABYSSAL_CONTENT_AUTHORITY.DEBUG_PLACEHOLDER,
      "Abyssal room profile",
    ),
  };
}

function buildTranquilRoomProfileOperation(ports, overrides = {}) {
  return (0, ports.buildPlaceholderRoomProfile)({
    roomOriginLabel: "Abyssal Origin Marker",
    transferConduitLabel: "Transfer Conduit (Triglavian)",
    finalExitConduitLabel: "Origin Conduit (Triglavian)",
    contentAuthority: ports.ABYSSAL_CONTENT_AUTHORITY.PROVISIONAL,
    ...(0, ports.cloneValue)(overrides),
  });
}

function buildPlaceholderExtractionNodeProfileOperation(ports, overrides = {}) {
  if (Object.prototype.hasOwnProperty.call(overrides, "authoredQuantities")) {
    throw new TypeError(
      "Abyssal extraction definitions must use quantityPolicy, not authoredQuantities",
    );
  }
  if (
    (Array.isArray(overrides.weightedLootPools) && overrides.weightedLootPools.length > 0) ||
    (Array.isArray(overrides.rareLootEntries) && overrides.rareLootEntries.length > 0)
  ) {
    throw new TypeError(
      "Abyssal extraction definitions support only guaranteedLootEntries and independentLootEntries",
    );
  }
  const extractionNodeProfileID = String(
    overrides.extractionNodeProfileID || "abyssal:extraction:none",
  );
  const authoredGuaranteedLootEntries = Array.isArray(overrides.guaranteedLootEntries)
    ? overrides.guaranteedLootEntries.map((entry) => (0, ports.buildPlaceholderRewardLootEntry)(entry))
    : [];
  // Calm profiles used to have their authored guaranteed entries discarded and
  // re-emitted as INDEPENDENT entries at probability 0.55. That was wrong twice
  // over, against the retail captures in "full abyssal engine and all logs":
  //
  //   1. It double-counted emptiness. lootEmptyChance (0.45 for these nodes) is
  //      already applied at resolution (abyssalMgrService.js:9500) and models the
  //      whole node being empty. Rolling each entry again at 0.55 on top of that
  //      applies the same chance twice.
  //   2. It decoupled items that retail delivers together. Extraction nodes
  //      49661/49662 drop 48121 Survey Database, 48112 Zero-Point Condensate and
  //      47975 Crystalline Isogen-10 as a set - all three appear in 3 of the 4
  //      captured Calm runs. Independent per-entry rolls would routinely produce
  //      one or two of them, which the captures never show.
  //
  // So an authored guaranteed entry stays guaranteed for every tier, and node
  // emptiness stays the job of lootEmptyChance. This is also what makes the tier
  // ratio contract expressible: Calm and the higher tiers now carry the same
  // entries and differ only by multiplier.
  const guaranteedLootEntries = authoredGuaranteedLootEntries;
  const independentLootEntries = Array.isArray(overrides.independentLootEntries)
    ? overrides.independentLootEntries.map((entry) => (0, ports.buildPlaceholderRewardLootEntry)(entry))
    : [];
  const unresolvedLootReferences = [
    ...guaranteedLootEntries.filter((entry) => entry.unresolvedReference === true),
    ...independentLootEntries.filter((entry) => entry.unresolvedReference === true),
  ];
  const extractionProfile = {
    extractionNodeProfileID,
    contentAuthority: (0, ports.validateAbyssalContentAuthority)(
      overrides.contentAuthority || ports.ABYSSAL_CONTENT_AUTHORITY.DEBUG_PLACEHOLDER,
      `Abyssal extraction profile ${extractionNodeProfileID}`,
    ),
    lootTableID: String(overrides.lootTableID || overrides.extractionNodeProfileID || "abyssal:extraction:none"),
    enabled: (0, ports.toBoolean)(overrides.enabled, false),
    displayName: String(overrides.displayName || "Abyssal Extraction Node (Not Implemented)"),
    quantityPolicy: overrides.quantityPolicy ||
      ports.ABYSSAL_REWARD_QUANTITY_POLICY.PLACEHOLDER_BASE,
    extractionNodeTypeName: String(overrides.extractionNodeTypeName || "Cargo Container"),
    extractionNodeDisplayName: String(overrides.extractionNodeDisplayName || "Abyssal Extraction Node (Placeholder)"),
    eligibleRoomIndexes: (0, ports.normalizeIntegerArray)(overrides.eligibleRoomIndexes)
      .filter((entry) => entry >= 1 && entry <= 3),
    eligibleTiers: (0, ports.normalizeIntegerArray)(overrides.eligibleTiers).filter((entry) => entry >= 0),
    spawnCount: Math.max(0, (0, ports.toInteger)(overrides.spawnCount, 0)),
    minimumSpawnCount: Math.max(0, (0, ports.toInteger)(
      overrides.minimumSpawnCount,
      (0, ports.toInteger)(overrides.spawnCount, 0),
    )),
    maximumSpawnCount: Math.max(0, (0, ports.toInteger)(
      overrides.maximumSpawnCount,
      (0, ports.toInteger)(overrides.spawnCount, 0),
    )),
    structureTypeIDs: (0, ports.normalizeIntegerArray)(
      overrides.structureTypeIDs || [49662],
    ).filter((entry) => entry > 0),
    observedStructureTypeIDs: (0, ports.normalizeIntegerArray)(
      overrides.observedStructureTypeIDs,
    ).filter((entry) => entry > 0),
    lootEmptyChance: Number.isFinite(Number(overrides.lootEmptyChance))
      ? Math.max(0, Math.min(1, Number(overrides.lootEmptyChance)))
      : 0,
    wholeNodeEmptyRoll: (0, ports.toBoolean)(overrides.wholeNodeEmptyRoll, false),
    spawnOffsetMeters: Math.max(0, (0, ports.toInteger)(overrides.spawnOffsetMeters, 2_800)),
    guaranteedLootEntries: guaranteedLootEntries.filter((entry) => entry.unresolvedReference !== true),
    independentLootEntries: independentLootEntries.filter((entry) => entry.unresolvedReference !== true),
    weightedLootPools: [],
    rareLootEntries: [],
    unresolvedLootReferences,
    unresolvedLootReferenceCount: unresolvedLootReferences.length,
    extractionSubnodes: Array.isArray(overrides.extractionSubnodes)
      ? (0, ports.cloneValue)(overrides.extractionSubnodes)
      : [],
    placeholderNotes: (0, ports.normalizeStringArray)(overrides.placeholderNotes),
    placeholderOnly: (0, ports.toBoolean)(overrides.placeholderOnly, true),
  };
  (0, ports.validateRewardProfileQuantityPolicy)({
    quantityPolicy: extractionProfile.quantityPolicy,
    lootEntries: [
      ...extractionProfile.guaranteedLootEntries,
      ...extractionProfile.independentLootEntries,
      ...extractionProfile.rareLootEntries,
    ],
    weightedLootPools: extractionProfile.weightedLootPools,
  });
  return extractionProfile;
}

function buildPlaceholderExtractionNodeProfileFromTemplateOperation(ports, templateID, overrides = {}) {
  const requestedTemplate =
    ports.ABYSSAL_PLACEHOLDER_EXTRACTION_NODE_PROFILES_BY_ID[String(templateID || "")] || null;
  const template = requestedTemplate ||
    ports.ABYSSAL_PLACEHOLDER_EXTRACTION_NODE_PROFILES_BY_ID["abyssal:extraction:none"];
  return (0, ports.buildPlaceholderExtractionNodeProfile)({
    ...(0, ports.cloneValue)(template),
    ...(0, ports.cloneValue)(overrides),
    contentAuthority:
      overrides.contentAuthority ||
      (requestedTemplate
        ? ports.ABYSSAL_CONTENT_AUTHORITY.PROVISIONAL
        : ports.ABYSSAL_CONTENT_AUTHORITY.DEBUG_PLACEHOLDER),
  });
}

function buildPlaceholderCacheProfileOperation(ports, overrides = {}) {
  const presentation = (0, ports.cloneValue)(ports.ABYSSAL_REWARD_STRUCTURE_PRESENTATION_PROFILE);
  const presentationProfileID = String(overrides.cacheProfileID || "").trim();
  return {
    cacheOffsetMeters: 10_000,
    optionalExit: true,
    extractionNodes: [],
    extractionSubnodes: [],
    ...(0, ports.cloneValue)(overrides),
    ...presentation,
    cacheProfileID: presentationProfileID || presentation.cacheProfileID,
  };
}

function resolveAbyssalLootTypeDescriptorOperation(ports, overrides = {}) {
  const explicitTypeID = Math.max(0, (0, ports.toInteger)(overrides.itemTypeID, 0));
  const explicitName = String(overrides.itemName || "").trim();
  const exactNameOnly = overrides.exactNameOnly !== false;
  let resolvedType = explicitTypeID > 0
    ? (0, ports.resolveItemByTypeID)(explicitTypeID)
    : null;
  if (!resolvedType && explicitName) {
    const lookup = (0, ports.resolveItemByName)(explicitName);
    if (
      lookup &&
      lookup.success &&
      lookup.match &&
      (
        exactNameOnly !== true ||
        String(lookup.match.name || "").trim().toLowerCase() === explicitName.toLowerCase()
      )
    ) {
      resolvedType = lookup.match;
    }
  }
  return {
    itemName: String(
      resolvedType && resolvedType.name ||
      explicitName ||
      "Tritanium"
    ),
    itemTypeID: Math.max(0, (0, ports.toInteger)(
      resolvedType && resolvedType.typeID,
      explicitTypeID,
    )),
    groupID: Math.max(0, (0, ports.toInteger)(resolvedType && resolvedType.groupID, 0)),
    groupName: String(resolvedType && resolvedType.groupName || ""),
    categoryID: Math.max(0, (0, ports.toInteger)(resolvedType && resolvedType.categoryID, 0)),
    published: resolvedType ? resolvedType.published !== false : true,
    unresolvedReference:
      explicitName.length > 0 &&
      !resolvedType,
    resolutionReason:
      explicitName.length <= 0
        ? "ITEM_NAME_REQUIRED"
        : resolvedType
          ? "RESOLVED_LOCALLY"
          : "ITEM_NOT_FOUND_LOCALLY",
  };
}

function buildPlaceholderRewardLootEntryOperation(ports, overrides = {}) {
  const resolvedLootType = (0, ports.resolveAbyssalLootTypeDescriptor)(overrides);
  const quantity = (0, ports.validateInventoryQuantity)(
    overrides.quantity == null ? 100 : overrides.quantity,
    "Abyssal authored reward quantity",
  );
  const minQuantity = (0, ports.validateInventoryQuantity)(
    overrides.minQuantity == null ? quantity : overrides.minQuantity,
    "Abyssal authored reward minimum quantity",
  );
  const maxQuantity = (0, ports.validateInventoryQuantity)(
    overrides.maxQuantity == null ? minQuantity : overrides.maxQuantity,
    "Abyssal authored reward maximum quantity",
  );
  if (maxQuantity < minQuantity) {
    throw new TypeError("Abyssal authored reward maximum quantity must be at least its minimum");
  }
  return {
    itemName: resolvedLootType.itemName,
    itemTypeID: resolvedLootType.itemTypeID,
    groupID: resolvedLootType.groupID,
    groupName: resolvedLootType.groupName,
    categoryID: resolvedLootType.categoryID,
    published: resolvedLootType.published !== false,
    quantity,
    minQuantity,
    maxQuantity,
    probability: Number.isFinite(Number(overrides.probability))
      ? Math.max(0, Number(overrides.probability))
      : 1,
    weight: Number.isFinite(Number(overrides.weight))
      ? Math.max(0, Number(overrides.weight))
      : 1,
    allowedRoomIndexes: (0, ports.normalizeIntegerArray)(overrides.allowedRoomIndexes).filter((entry) => entry >= 1 && entry <= 3),
    allowedTiers: (0, ports.normalizeIntegerArray)(overrides.allowedTiers).filter((entry) => entry >= 0),
    allowedWeatherTypes: (0, ports.normalizeStringArray)(overrides.allowedWeatherTypes).map((entry) => String(entry).toLowerCase()),
    unresolvedReference: resolvedLootType.unresolvedReference === true,
    resolutionReason: String(resolvedLootType.resolutionReason || ""),
  };
}

function buildPlaceholderWeightedLootPoolOperation(ports, overrides = {}) {
  const entries = Array.isArray(overrides.entries)
    ? overrides.entries.map((entry) => (0, ports.buildPlaceholderRewardLootEntry)(entry))
    : [];
  return {
    poolID: String(overrides.poolID || "abyssal:loot:pool"),
    displayName: String(overrides.displayName || "Abyssal Loot Pool"),
    chance: Number.isFinite(Number(overrides.chance))
      ? Math.max(0, Math.min(1, Number(overrides.chance)))
      : 1,
    rolls: Math.max(1, (0, ports.toInteger)(overrides.rolls, 1)),
    allowedRoomIndexes: (0, ports.normalizeIntegerArray)(overrides.allowedRoomIndexes).filter((entry) => entry >= 1 && entry <= 3),
    allowedTiers: (0, ports.normalizeIntegerArray)(overrides.allowedTiers).filter((entry) => entry >= 0),
    allowedWeatherTypes: (0, ports.normalizeStringArray)(overrides.allowedWeatherTypes).map((entry) => String(entry).toLowerCase()),
    entries,
    unresolvedLootReferenceCount: entries.filter((entry) => entry.unresolvedReference === true).length,
    placeholderNotes: (0, ports.normalizeStringArray)(overrides.placeholderNotes),
  };
}

function buildRoomMultiplierMapOperation(ports, rawMap = {}, fallback = {}) {
  const source = rawMap && typeof rawMap === "object" ? rawMap : {};
  const map = {};
  for (const roomIndex of [1, 2, 3]) {
    const rawValue = source[String(roomIndex)] ?? source[roomIndex] ?? fallback[String(roomIndex)] ?? fallback[roomIndex];
    const numericValue = Number(rawValue);
    map[String(roomIndex)] = Number.isFinite(numericValue) && numericValue > 0
      ? numericValue
      : 1;
  }
  return map;
}

function buildObservedRewardStatisticsOperation(ports, overrides) {
  return Object.prototype.hasOwnProperty.call(overrides, "sourceRuns")
      ? {
          sourceRuns: Math.max(0, (0, ports.toInteger)(overrides.sourceRuns, 0)),
          rowsWithNonEmptyLoot: Math.max(
            0,
            (0, ports.toInteger)(overrides.rowsWithNonEmptyLoot, 0),
          ),
          rowsWithEmptyOrMissingLoot: Math.max(
            0,
            (0, ports.toInteger)(overrides.rowsWithEmptyOrMissingLoot, 0),
          ),
          normalizedNonEmptyOutcomes: Math.max(
            0,
            (0, ports.toInteger)(overrides.normalizedNonEmptyOutcomes, 0),
          ),
          eligibleRewardOutcomes: Math.max(
            0,
            (0, ports.toInteger)(overrides.eligibleRewardOutcomes, 0),
          ),
          gatedRewardOutcomes: Math.max(
            0,
            (0, ports.toInteger)(overrides.gatedRewardOutcomes, 0),
          ),
          eligibleRewardWeight: Math.max(
            0,
            (0, ports.toInteger)(overrides.eligibleRewardWeight, 0),
          ),
          gatedRewardWeight: Math.max(
            0,
            (0, ports.toInteger)(overrides.gatedRewardWeight, 0),
          ),
          unobservedRewardWeight: Math.max(
            0,
            (0, ports.toInteger)(overrides.unobservedRewardWeight, 0),
          ),
        }
      : {};
}

function buildPlaceholderRewardProfileOperation(ports, overrides = {}) {
  if (Object.prototype.hasOwnProperty.call(overrides, "authoredQuantities")) {
    throw new TypeError(
      "Abyssal reward definitions must use quantityPolicy, not authoredQuantities",
    );
  }
  const rawBaseLootEntries = (
    Array.isArray(overrides.baseLootEntries)
      ? overrides.baseLootEntries
      : Array.isArray(overrides.lootEntries)
        ? overrides.lootEntries
        : [{
          itemName: "Tritanium",
          quantity: 100,
          probability: 1,
        }]
  ).map((entry) => (0, ports.buildPlaceholderRewardLootEntry)(entry));
  const weightedLootPools = Array.isArray(overrides.weightedLootPools)
    ? overrides.weightedLootPools.map((entry) => (0, ports.buildPlaceholderWeightedLootPool)(entry))
    : [];
  const unresolvedLootReferences = [
    ...rawBaseLootEntries.filter((entry) => entry.unresolvedReference === true),
    ...weightedLootPools.flatMap((pool) => pool.entries.filter((entry) => entry.unresolvedReference === true)),
  ];
  const baseLootEntries = rawBaseLootEntries.filter((entry) => entry.unresolvedReference !== true);
  const inferredRewardMode = weightedLootPools.length > 0
    ? "seeded_weighted_placeholder"
    : "deterministic_placeholder";
  const rewardMode = String(overrides.rewardMode || inferredRewardMode);
  const rewardProfile = {
    rewardProfileID: String(overrides.rewardProfileID || "abyssal:placeholder-reward"),
    contentAuthority: (0, ports.validateAbyssalContentAuthority)(
      overrides.contentAuthority || ports.ABYSSAL_CONTENT_AUTHORITY.DEBUG_PLACEHOLDER,
      `Abyssal reward profile ${String(
        overrides.rewardProfileID || "abyssal:placeholder-reward",
      )}`,
    ),
    lootTableID: String(overrides.lootTableID || overrides.rewardProfileID || "abyssal:placeholder-reward"),
    displayName: String(overrides.displayName || "Abyssal Reward Profile (Placeholder)"),
    tier: Math.max(0, (0, ports.toInteger)(overrides.tier, 1)),
    weatherTheme: String(overrides.weatherTheme || ""),
    rewardKind: "cache_loot",
    rewardMode,
    rewardTableKind: rewardMode,
    capturedExact: overrides.capturedExact === true,
    quantityPolicy: overrides.quantityPolicy ||
      ports.ABYSSAL_REWARD_QUANTITY_POLICY.PLACEHOLDER_BASE,
    replaceCapturedReward: overrides.replaceCapturedReward === true,
    sourceModelID: String(overrides.sourceModelID || ""),
    suppressRewardsOnTimeout: true,
    authoredProbabilities: (0, ports.toBoolean)(overrides.authoredProbabilities, weightedLootPools.length > 0),
    roomMultipliersByIndex: (0, ports.buildRoomMultiplierMap)(
      overrides.roomMultipliersByIndex,
      ports.DEFAULT_PLACEHOLDER_ROOM_REWARD_MULTIPLIERS,
    ),
    baseLootEntries,
    lootEntries: (0, ports.cloneValue)(baseLootEntries),
    weightedLootPools: weightedLootPools.map((pool) => ({
      ...pool,
      entries: pool.entries.filter((entry) => entry.unresolvedReference !== true),
    })).filter((pool) => pool.entries.length > 0),
    empiricalLootEntries: Array.isArray(overrides.empiricalLootEntries)
      ? (0, ports.cloneValue)(overrides.empiricalLootEntries)
      : [],
    empiricalRunAllocation:
      overrides.empiricalRunAllocation && typeof overrides.empiricalRunAllocation === "object"
        ? (0, ports.cloneValue)(overrides.empiricalRunAllocation)
        : null,
    observedRunLootOutcomes: Array.isArray(overrides.observedRunLootOutcomes)
      ? (0, ports.cloneValue)(overrides.observedRunLootOutcomes)
      : [],
    observedRunLootAllocation:
      overrides.observedRunLootAllocation &&
        typeof overrides.observedRunLootAllocation === "object"
        ? (0, ports.cloneValue)(overrides.observedRunLootAllocation)
        : null,
    rawSourceLootOutcomeCount: Math.max(
      0,
      (0, ports.toInteger)(overrides.rawSourceLootOutcomeCount, 0),
    ),
    eligibleSourceLootOutcomeCount: Math.max(
      0,
      (0, ports.toInteger)(overrides.eligibleSourceLootOutcomeCount, 0),
    ),
    rawSourceLootObservationWeight: Math.max(
      0,
      (0, ports.toInteger)(overrides.rawSourceLootObservationWeight, 0),
    ),
    effectiveProductionLootObservationWeight: Math.max(
      0,
      (0, ports.toInteger)(overrides.effectiveProductionLootObservationWeight, 0),
    ),
    ...(0, ports.buildObservedRewardStatistics)(overrides),
    sourceEligibleRuns: Math.max(0, (0, ports.toInteger)(overrides.sourceEligibleRuns, 0)),
    rareLootEntries: Array.isArray(overrides.rareLootEntries)
      ? overrides.rareLootEntries.map((entry) => (0, ports.buildPlaceholderRewardLootEntry)(entry))
      : [],
    extractionNodeLootEntries: Array.isArray(overrides.extractionNodeLootEntries)
      ? overrides.extractionNodeLootEntries.map((entry) => (0, ports.buildPlaceholderRewardLootEntry)(entry))
      : [],
    unresolvedLootReferences,
    unresolvedLootReferenceCount: unresolvedLootReferences.length,
    unavailableSourceLootObservations: Array.isArray(
      overrides.unavailableSourceLootObservations,
    )
      ? (0, ports.cloneValue)(overrides.unavailableSourceLootObservations)
      : [],
    unavailableSourceLootObservationCount: Math.max(
      0,
      (0, ports.toInteger)(overrides.unavailableSourceLootObservationCount, 0),
    ),
    unavailableSourceLootOutcomeObservations: Array.isArray(
      overrides.unavailableSourceLootOutcomeObservations,
    )
      ? (0, ports.cloneValue)(overrides.unavailableSourceLootOutcomeObservations)
      : [],
    unavailableSourceLootOutcomeObservationCount: Math.max(
      0,
      (0, ports.toInteger)(overrides.unavailableSourceLootOutcomeObservationCount, 0),
    ),
    placeholderNotes: (0, ports.normalizeStringArray)(overrides.placeholderNotes).length > 0
      ? (0, ports.normalizeStringArray)(overrides.placeholderNotes)
      : [
        "Reward loot remains deterministic placeholder loot, not a retail loot table.",
      ],
  };
  (0, ports.validateRewardProfileQuantityPolicy)(rewardProfile);
  return rewardProfile;
}

function buildPlaceholderRewardProfileFromTemplateOperation(ports, templateID, overrides = {}) {
  const requestedTemplate =
    ports.ABYSSAL_PLACEHOLDER_REWARD_PROFILES_BY_ID[String(templateID || "")] || null;
  const template = requestedTemplate ||
    ports.ABYSSAL_PLACEHOLDER_REWARD_PROFILES_BY_ID["abyssal:reward:calm-dark-placeholder"];
  return (0, ports.buildPlaceholderRewardProfile)({
    ...(0, ports.cloneValue)(template),
    ...(0, ports.cloneValue)(overrides),
    contentAuthority:
      overrides.contentAuthority ||
      (requestedTemplate
        ? ports.ABYSSAL_CONTENT_AUTHORITY.PROVISIONAL
        : ports.ABYSSAL_CONTENT_AUTHORITY.DEBUG_PLACEHOLDER),
  });
}

function buildPlaceholderNpcProfileOperation(ports, overrides = {}) {
  const resolvedProfile = (0, ports.resolveSafeAbyssalNpcCatalogEntry)(
    overrides.profileQuery || ports.ABYSSAL_EXPLICIT_PLACEHOLDER_NPC_PROFILE_ID,
  );
  return {
    runtimeKind: "nativeCombat",
    amount: 1,
    spawnOffsetMeters: 6_000,
    objectiveRole: "kill_all_hostiles",
    spawnReference: "ship_spawn",
    spawnDistanceMode: "ahead_of_ship",
    runtimePolicy: {
      suppressBounty: true,
      suppressWreck: true,
      suppressStandings: true,
      enforcementMode: "groundwork_only",
    },
    ...(0, ports.cloneValue)(overrides),
    profileQuery: resolvedProfile.profileID,
    profileName: resolvedProfile.profileName,
    requestedProfileQuery: resolvedProfile.requestedProfileID,
    validationStatus: resolvedProfile.validationStatus,
    admissionAllowed: resolvedProfile.admissionAllowed === true,
    admissionError: resolvedProfile.errorMsg,
    fallbackUsed: false,
    fallbackReason: "",
    weaponStyle: resolvedProfile.weaponStyle,
  };
}

function buildPlaceholderEncounterNpcEntryOperation(ports, overrides = {}) {
  const resolvedProfile = (0, ports.resolveSafeAbyssalNpcCatalogEntry)(
    overrides.profileQuery || ports.ABYSSAL_EXPLICIT_PLACEHOLDER_NPC_PROFILE_ID,
  );
  const placeholderNotes = [
    "Uses an explicitly authored placeholder native NPC profile.",
    "Unavailable requested NPC profiles are rejected and are never substituted.",
  ];
  return {
    npcEntryID: "primary",
    runtimeKind: "nativeCombat",
    count: 1,
    spawnOffsetMeters: 6_000,
    objectiveRole: "kill_all_hostiles",
    spawnReference: "ship_spawn",
    spawnDistanceMode: "ahead_of_ship",
    placeholderNotes,
    ...(0, ports.cloneValue)(overrides),
    profileQuery: resolvedProfile.profileID,
    profileName: resolvedProfile.profileName,
    requestedProfileQuery: resolvedProfile.requestedProfileID,
    validationStatus: resolvedProfile.validationStatus,
    admissionAllowed: resolvedProfile.admissionAllowed === true,
    admissionError: resolvedProfile.errorMsg,
    fallbackUsed: false,
    fallbackReason: "",
    weaponStyle: resolvedProfile.weaponStyle,
  };
}

function buildPlaceholderRoomEncounterProfileOperation(ports, overrides = {}) {
  const npcEntries = Array.isArray(overrides.npcEntries)
    ? overrides.npcEntries.map((entry) => (0, ports.buildPlaceholderEncounterNpcEntry)(entry))
    : [(0, ports.buildPlaceholderEncounterNpcEntry)()];
  const rewardMultiplier = Number(overrides.rewardMultiplier);
  const rewardQuantityBonus = (0, ports.toInteger)(overrides.rewardQuantityBonus, 0);
  return {
    roomIndex: Math.max(1, (0, ports.toInteger)(overrides.roomIndex, 1)),
    encounterProfileID: String(overrides.encounterProfileID || "abyssal_test_guristas_frigates"),
    contentAuthority: (0, ports.validateAbyssalContentAuthority)(
      overrides.contentAuthority || ports.ABYSSAL_CONTENT_AUTHORITY.DEBUG_PLACEHOLDER,
      `Abyssal encounter profile ${String(
        overrides.encounterProfileID || "abyssal_test_guristas_frigates",
      )}`,
    ),
    encounterName: String(overrides.encounterName || "Guristas Frigates (Placeholder)"),
    factionTheme: String(overrides.factionTheme || "guristas"),
    weatherTheme: String(overrides.weatherTheme || ""),
    tierBandID: String(overrides.tierBandID || ""),
    tierBandLabel: String(overrides.tierBandLabel || ""),
    tierRange: {
      minTier: Math.max(0, (0, ports.toInteger)(overrides && overrides.tierRange && overrides.tierRange.minTier, 0)),
      maxTier: Math.max(0, (0, ports.toInteger)(overrides && overrides.tierRange && overrides.tierRange.maxTier, 0)),
    },
    objectiveType: String(overrides.objectiveType || "kill_all_hostiles"),
    npcEntries,
    npcCount: Math.max(
      0,
      npcEntries.reduce((total, entry) => total + Math.max(0, (0, ports.toInteger)(entry && entry.count, 0)), 0),
    ),
    spawnOffsetsMeters: npcEntries.map((entry) => (0, ports.toInteger)(entry && entry.spawnOffsetMeters, 0)),
    rewardMultiplier: Number.isFinite(rewardMultiplier) && rewardMultiplier > 0
      ? rewardMultiplier
      : 1,
    rewardQuantityBonus,
    rewardProfileOverride:
      overrides.rewardProfileOverride && typeof overrides.rewardProfileOverride === "object"
        ? (0, ports.buildPlaceholderRewardProfile)(overrides.rewardProfileOverride)
        : null,
    extractionNodeProfileOverride:
      overrides.extractionNodeProfileOverride && typeof overrides.extractionNodeProfileOverride === "object"
        ? (0, ports.buildPlaceholderExtractionNodeProfile)(overrides.extractionNodeProfileOverride)
        : null,
    placeholderNotes: (0, ports.normalizeStringArray)(overrides.placeholderNotes).length > 0
      ? (0, ports.normalizeStringArray)(overrides.placeholderNotes)
      : [
        "Encounter composition is placeholder-authored for EveJS safety.",
    ],
  };
}

function createAbyssalCompatibilityProfileModels(dependencies) {
  const ports = Object.create(dependencies);
  const model = {
    buildPlaceholderRoomProfile: buildPlaceholderRoomProfileOperation.bind(undefined, ports),
    buildTranquilRoomProfile: buildTranquilRoomProfileOperation.bind(undefined, ports),
    buildPlaceholderExtractionNodeProfile: buildPlaceholderExtractionNodeProfileOperation.bind(undefined, ports),
    buildPlaceholderExtractionNodeProfileFromTemplate: buildPlaceholderExtractionNodeProfileFromTemplateOperation.bind(undefined, ports),
    buildPlaceholderCacheProfile: buildPlaceholderCacheProfileOperation.bind(undefined, ports),
    resolveAbyssalLootTypeDescriptor: resolveAbyssalLootTypeDescriptorOperation.bind(undefined, ports),
    buildPlaceholderRewardLootEntry: buildPlaceholderRewardLootEntryOperation.bind(undefined, ports),
    buildPlaceholderWeightedLootPool: buildPlaceholderWeightedLootPoolOperation.bind(undefined, ports),
    buildRoomMultiplierMap: buildRoomMultiplierMapOperation.bind(undefined, ports),
    buildObservedRewardStatistics: buildObservedRewardStatisticsOperation.bind(undefined, ports),
    buildPlaceholderRewardProfile: buildPlaceholderRewardProfileOperation.bind(undefined, ports),
    buildPlaceholderRewardProfileFromTemplate: buildPlaceholderRewardProfileFromTemplateOperation.bind(undefined, ports),
    buildPlaceholderNpcProfile: buildPlaceholderNpcProfileOperation.bind(undefined, ports),
    buildPlaceholderEncounterNpcEntry: buildPlaceholderEncounterNpcEntryOperation.bind(undefined, ports),
    buildPlaceholderRoomEncounterProfile: buildPlaceholderRoomEncounterProfileOperation.bind(undefined, ports),
  };
  Object.assign(ports, model);
  Object.freeze(ports);
  return model;
}

module.exports = { createAbyssalCompatibilityProfileModels };
