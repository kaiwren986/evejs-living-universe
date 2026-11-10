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

function listEncounterEntryChoices(entry = null) {
  const choices = Array.isArray(entry && entry.npcProfileChoices) &&
      entry.npcProfileChoices.length > 0
    ? entry.npcProfileChoices
    : [entry];
  return choices.filter(Boolean);
}

function summarizeCombinedEncounterComposition(
  profile = null,
  approvedTypeIDs = ABYSSAL_TIER1_APPROVED_TYPE_IDS,
) {
  const summary = {
    droneCount: 0,
    shipCount: 0,
    objectiveCount: 0,
    approvedOnly: true,
    forbiddenEwar: false,
    invalidTypeIDs: [],
  };
  const npcEntries = Array.isArray(profile && profile.npcEntries)
    ? profile.npcEntries
    : [];
  for (const entry of npcEntries) {
    const maxCount = Math.max(
      0,
      toInteger(
        entry && entry.maximumCount,
        toInteger(entry && entry.count, 0),
      ),
    );
    if (entry && entry.objectiveRelevant !== false) {
      summary.objectiveCount += maxCount;
    }
    for (const choice of listEncounterEntryChoices(entry)) {
      const typeID = toInteger(choice && choice.typeID, 0);
      const groupID = toInteger(choice && choice.groupID, 0);
      const factionID = toInteger(choice && choice.factionID, 0);
      if (!approvedTypeIDs.includes(typeID)) {
        summary.approvedOnly = false;
        if (!summary.invalidTypeIDs.includes(typeID)) {
          summary.invalidTypeIDs.push(typeID);
        }
      }
      const validation = getAbyssalNpcProfileValidationReport(
        String(
          choice && (choice.npcProfileKey || choice.profileQuery) || "",
        ).trim(),
      );
      if (
        validation &&
        validation.runtimeCapabilityAudit &&
        (
          validation.runtimeCapabilityAudit.unsupportedCapabilities.length > 0 ||
          validation.runtimeCapabilityAudit.unknownCapabilities.length > 0
        )
      ) {
        summary.forbiddenEwar = true;
      }
      if (
        groupID === ABYSSAL_TIER1_NEEDLE_DRONE_GROUP_ID &&
        factionID === ABYSSAL_TIER1_NEEDLE_DRONE_FACTION_ID
      ) {
        summary.droneCount += maxCount;
      }
      if (
        groupID === ABYSSAL_TIER1_TRIGLAVIAN_FRIGATE_GROUP_ID &&
        factionID === ABYSSAL_TIER1_TRIGLAVIAN_FACTION_ID
      ) {
        summary.shipCount += maxCount;
      }
    }
  }
  return summary;
}

function summarizeTier1CombinedEncounterComposition(profile = null) {
  return summarizeCombinedEncounterComposition(
    profile,
    ABYSSAL_TIER1_APPROVED_TYPE_IDS,
  );
}

function summarizeTier2CombinedEncounterComposition(profile = null) {
  return summarizeCombinedEncounterComposition(
    profile,
    ABYSSAL_TIER2_APPROVED_TYPE_IDS,
  );
}

function summarizeHigherTierCombinedEncounterComposition(profile = null) {
  return summarizeCombinedEncounterComposition(
    profile,
    ABYSSAL_HIGHER_TIER_APPROVED_TYPE_IDS,
  );
}

function isCombinedAbyssalEncounterProfile(
  profile = null,
  requiredTheme = ABYSSAL_TIER1_COMBINED_ENCOUNTER_THEME,
  approvedTypeIDs = ABYSSAL_TIER1_APPROVED_TYPE_IDS,
) {
  if (
    !profile ||
    normalizeEncounterText(profile.encounterTheme, "") !== requiredTheme
  ) {
    return false;
  }
  if (profile.observedSpawnProfile === true) {
    return isObservedAbyssalEncounterProfile(
      profile,
      toInteger(profile && profile.tier, -1),
    );
  }
  const summary = summarizeCombinedEncounterComposition(
    profile,
    approvedTypeIDs,
  );
  return summary.droneCount > 0 &&
    summary.shipCount > 0 &&
    summary.objectiveCount > 0 &&
    summary.approvedOnly === true &&
    summary.forbiddenEwar !== true;
}

function isTier0CombinedEncounterProfile(profile = null) {
  return isCombinedAbyssalEncounterProfile(
    profile,
    ABYSSAL_TIER0_COMBINED_ENCOUNTER_THEME,
    ABYSSAL_TIER0_APPROVED_TYPE_IDS,
  );
}

function isTier0AbyssalSpaceEncounterProfile(profile = null) {
  if (profile && profile.observedSpawnProfile === true) {
    return isObservedAbyssalEncounterProfile(profile, 0);
  }
  if (
    !profile ||
    normalizeEncounterText(profile.sourceModelID, "") !==
      ABYSSAL_SPACE_TIER0_CATALOGUE_ID ||
    normalizeEncounterText(profile.encounterTheme, "") !==
      ABYSSAL_TIER0_COMBINED_ENCOUNTER_THEME
  ) {
    return false;
  }
  const summary = summarizeCombinedEncounterComposition(
    profile,
    ABYSSAL_TIER0_APPROVED_TYPE_IDS,
  );
  return summary.objectiveCount > 0 &&
    summary.approvedOnly === true &&
    summary.forbiddenEwar !== true;
}

function isAbyssalSpaceEncounterProfile(
  profile,
  expectedTier,
  catalogueID,
  encounterTheme,
) {
  if (profile && profile.observedSpawnProfile === true) {
    return isObservedAbyssalEncounterProfile(profile, expectedTier);
  }
  if (
    !profile ||
    toInteger(profile.tier, -1) !== expectedTier ||
    normalizeEncounterText(profile.sourceModelID, "") !== catalogueID ||
    normalizeEncounterText(profile.encounterTheme, "") !== encounterTheme ||
    !normalizeEncounterText(profile.sourceVariantID, "") ||
    !Array.isArray(profile.npcEntries) ||
    profile.npcEntries.length <= 0
  ) {
    return false;
  }
  return profile.npcEntries.every((entry) =>
    toInteger(entry && entry.minimumCount, 0) > 0 &&
    toInteger(entry && entry.minimumCount, -1) ===
      toInteger(entry && entry.maximumCount, -2) &&
    entry && entry.fallbackUsed !== true);
}

const ABYSSAL_SPACE_CLASSIFIER_BY_TIER = Object.freeze({
  0: isTier0AbyssalSpaceEncounterProfile,
  1: (profile) => isAbyssalSpaceEncounterProfile(
    profile,
    1,
    ABYSSAL_SPACE_TIER1_CATALOGUE_ID,
    ABYSSAL_TIER1_COMBINED_ENCOUNTER_THEME,
  ),
  2: (profile) => isAbyssalSpaceEncounterProfile(
    profile,
    2,
    ABYSSAL_SPACE_TIER2_CATALOGUE_ID,
    ABYSSAL_TIER2_COMBINED_ENCOUNTER_THEME,
  ),
  3: (profile) => isAbyssalSpaceEncounterProfile(
    profile,
    3,
    ABYSSAL_SPACE_TIER3_CATALOGUE_ID,
    ABYSSAL_TIER3_COMBINED_ENCOUNTER_THEME,
  ),
  4: (profile) => isAbyssalSpaceEncounterProfile(
    profile,
    4,
    ABYSSAL_SPACE_TIER4_CATALOGUE_ID,
    ABYSSAL_TIER4_COMBINED_ENCOUNTER_THEME,
  ),
  5: (profile) => isAbyssalSpaceEncounterProfile(
    profile,
    5,
    ABYSSAL_SPACE_TIER5_CATALOGUE_ID,
    ABYSSAL_TIER5_COMBINED_ENCOUNTER_THEME,
  ),
  6: (profile) => isAbyssalSpaceEncounterProfile(
    profile,
    6,
    ABYSSAL_SPACE_TIER6_CATALOGUE_ID,
    ABYSSAL_TIER6_COMBINED_ENCOUNTER_THEME,
  ),
});

function isTier1AbyssalSpaceEncounterProfile(profile = null) {
  return ABYSSAL_SPACE_CLASSIFIER_BY_TIER[1](profile);
}

function isTier2AbyssalSpaceEncounterProfile(profile = null) {
  return ABYSSAL_SPACE_CLASSIFIER_BY_TIER[2](profile);
}

function isTier3AbyssalSpaceEncounterProfile(profile = null) {
  return ABYSSAL_SPACE_CLASSIFIER_BY_TIER[3](profile);
}

function isTier4AbyssalSpaceEncounterProfile(profile = null) {
  return ABYSSAL_SPACE_CLASSIFIER_BY_TIER[4](profile);
}

function isTier5AbyssalSpaceEncounterProfile(profile = null) {
  return ABYSSAL_SPACE_CLASSIFIER_BY_TIER[5](profile);
}

function isTier6AbyssalSpaceEncounterProfile(profile = null) {
  return ABYSSAL_SPACE_CLASSIFIER_BY_TIER[6](profile);
}

function isTier1CombinedEncounterProfile(profile = null) {
  return isCombinedAbyssalEncounterProfile(
    profile,
    ABYSSAL_TIER1_COMBINED_ENCOUNTER_THEME,
  );
}

function isTier2CombinedEncounterProfile(profile = null) {
  if (isTier2AbyssalSpaceEncounterProfile(profile)) return true;
  return isCombinedAbyssalEncounterProfile(
    profile,
    ABYSSAL_TIER2_COMBINED_ENCOUNTER_THEME,
    ABYSSAL_TIER2_APPROVED_TYPE_IDS,
  );
}

function isHigherTierCombinedEncounterProfile(profile = null, tier = 0) {
  return isCombinedAbyssalEncounterProfile(
    profile,
    ABYSSAL_HIGHER_TIER_ENCOUNTER_THEME_BY_TIER[tier] || "",
    ABYSSAL_HIGHER_TIER_APPROVED_TYPE_IDS,
  );
}

function readAbyssalEncounterAuthorityValue(profile, key) {
  const authority = profile && profile.encounterAuthority &&
      typeof profile.encounterAuthority === "object"
    ? profile.encounterAuthority
    : null;
  if (authority && Object.prototype.hasOwnProperty.call(authority, key)) {
    return authority[key];
  }
  return profile && Object.prototype.hasOwnProperty.call(profile, key)
    ? profile[key]
    : undefined;
}

function isSupportedAbyssalExtractionEncounter({
  encounterProfile = null,
  tier = null,
  weatherType = "",
  roomIndex = null,
} = {}) {
  if (!encounterProfile) return false;
  const expectedTier = toInteger(tier, -1);
  const expectedWeatherType = normalizeEncounterText(
    weatherType,
    "",
  ).toLowerCase();
  const expectedRoomIndex = toInteger(roomIndex, 0);
  if (
    expectedTier < 2 ||
    expectedTier > 6 ||
    !expectedWeatherType ||
    expectedRoomIndex <= 0
  ) {
    return false;
  }

  let profileTier = toInteger(
    readAbyssalEncounterAuthorityValue(encounterProfile, "tier"),
    -1,
  );
  if (profileTier < 0) {
    const encounterTheme = normalizeEncounterText(
      encounterProfile.encounterTheme,
      "",
    );
    const matchingTierEntry = Object.entries(
      OBSERVED_ABYSSAL_ENCOUNTER_THEME_BY_TIER,
    ).find(([, theme]) => theme === encounterTheme);
    profileTier = matchingTierEntry
      ? toInteger(matchingTierEntry[0], -1)
      : -1;
  }

  const eligibleRoomIndexes = normalizeEncounterRoomIndexes(
    readAbyssalEncounterAuthorityValue(
      encounterProfile,
      "eligibleRoomIndexes",
    ),
  );
  if (eligibleRoomIndexes.length <= 0) {
    const exactRoomIndex = toInteger(encounterProfile.roomIndex, 0);
    if (exactRoomIndex > 0) eligibleRoomIndexes.push(exactRoomIndex);
  }

  const authorityWeatherTypes = readAbyssalEncounterAuthorityValue(
    encounterProfile,
    "eligibleWeatherTypes",
  );
  const eligibleWeatherTypes = Array.isArray(authorityWeatherTypes)
    ? [...new Set(authorityWeatherTypes
      .map((entry) => normalizeEncounterText(entry, "").toLowerCase())
      .filter(Boolean))]
    : [];
  if (eligibleWeatherTypes.length <= 0) {
    const exactWeatherType = normalizeEncounterText(
      encounterProfile.weatherTheme,
      "",
    ).toLowerCase();
    if (exactWeatherType) eligibleWeatherTypes.push(exactWeatherType);
  }

  if (
    profileTier !== expectedTier ||
    !eligibleRoomIndexes.includes(expectedRoomIndex) ||
    !eligibleWeatherTypes.includes(expectedWeatherType) ||
    normalizeEncounterText(encounterProfile.encounterTheme, "") !==
      OBSERVED_ABYSSAL_ENCOUNTER_THEME_BY_TIER[expectedTier]
  ) {
    return false;
  }

  const contentAuthority = normalizeEncounterText(
    readAbyssalEncounterAuthorityValue(
      encounterProfile,
      "contentAuthority",
    ),
    "",
  );
  if (
    contentAuthority === ABYSSAL_CONTENT_AUTHORITY.PROVISIONAL ||
    contentAuthority === ABYSSAL_CONTENT_AUTHORITY.DEBUG_PLACEHOLDER ||
    readAbyssalEncounterAuthorityValue(
      encounterProfile,
      "fallbackUsed",
    ) === true ||
    readAbyssalEncounterAuthorityValue(encounterProfile, "enabled") === false
  ) {
    return false;
  }

  const sourceModelID = normalizeEncounterText(
    encounterProfile.sourceModelID,
    "",
  );
  const sourceEvidenceAuthority = normalizeEncounterText(
    encounterProfile.sourceEvidenceAuthority,
    "",
  );
  const isCurrentQsnaAuthority =
    sourceModelID === OBSERVED_ABYSSAL_NPC_SPAWN_REGISTRY.catalogueID &&
    sourceEvidenceAuthority === QSNA_ABYSSAL_NPC_SOURCE_AUTHORITY;
  const observedSpawnProfile = readAbyssalEncounterAuthorityValue(
    encounterProfile,
    "observedSpawnProfile",
  );
  const qsnaSpawnProfile = readAbyssalEncounterAuthorityValue(
    encounterProfile,
    "qsnaSpawnProfile",
  );

  if (isCurrentQsnaAuthority) {
    if (
      !normalizeEncounterText(encounterProfile.encounterProfileID, "") ||
      !normalizeEncounterText(encounterProfile.sourceVariantID, "") ||
      (contentAuthority && ![
        ABYSSAL_CONTENT_AUTHORITY.PROJECT_AUTHORED,
        ABYSSAL_CONTENT_AUTHORITY.OBSERVED_EMPIRICAL,
      ].includes(contentAuthority)) ||
      (observedSpawnProfile !== undefined &&
        observedSpawnProfile !== true) ||
      (qsnaSpawnProfile !== undefined && qsnaSpawnProfile !== true)
    ) {
      return false;
    }
    return isObservedAbyssalEncounterProfile({
      ...encounterProfile,
      tier: profileTier,
      observedSpawnProfile: true,
    }, expectedTier);
  }

  if (observedSpawnProfile === true || qsnaSpawnProfile === true) {
    return false;
  }
  return ABYSSAL_SPACE_CLASSIFIER_BY_TIER[expectedTier]({
    ...encounterProfile,
    tier: profileTier,
    eligibleRoomIndexes,
    eligibleWeatherTypes,
    observedSpawnProfile: false,
  });
}

function buildEmpiricalEncounterAuthorityProfile(request = {}) {
  const { tier, weatherType, roomIndex } =
    normalizeEncounterResolutionRequest(request);
  if (request.empiricalContentEnabled !== true) return null;
  const catalogueID = OBSERVED_ABYSSAL_NPC_SPAWN_REGISTRY.catalogueID;
  const runtimeProfiles = OBSERVED_ABYSSAL_NPC_SPAWN_REGISTRY
    .listProfilesForContext({ tier, weatherType, roomIndex });
  const unavailableVariants = (
    OBSERVED_ABYSSAL_NPC_SPAWN_AUDIT.unavailableVariants || []
  ).filter((variant) =>
    toInteger(variant && variant.tier, -1) === tier &&
    String(variant && variant.weather || "").toLowerCase() === weatherType);
  const sourceVariantCount = runtimeProfiles.length +
    unavailableVariants.length;
  const sourceRoomsAnalyzed = runtimeProfiles.reduce(
    (total, profile) => total + Math.max(
      0,
      toInteger(profile && profile.sourceRoomsAnalyzed, 0),
    ),
    0,
  );
  return {
    profileID:
      `${catalogueID}:${weatherType}:room-${roomIndex}:selection-contract`,
    encounterProfileID:
      `${catalogueID}:${weatherType}:room-${roomIndex}:selection-contract`,
    contentAuthority: ABYSSAL_CONTENT_AUTHORITY.PROJECT_AUTHORED,
    evidenceAuthority: ABYSSAL_CONTENT_AUTHORITY.OBSERVED_EMPIRICAL,
    npcIdentityAuthority: ABYSSAL_CONTENT_AUTHORITY.OBSERVED_EMPIRICAL,
    sourceModelID: catalogueID,
    sourceEvidenceAuthority: "qsna-derived-abyssal-space-observations",
    evidenceRefs: [
      "tools/AbyssalData/scraper/output/npc-by-combination.csv",
      "tools/AbyssalData/scraper/output/valid-spawn-tables.csv",
      "tools/AbyssalData/scraper/output/excluded-spawn-tables.csv",
      "server/src/space/abyssal/content/qsnaAbyssalSpawnTables.generated.json",
      "server/tests/qsnaAbyssalSpawnRegistry.test.js",
    ],
    weatherType,
    roomIndex,
    runtimeReadyProfileCount: runtimeProfiles.length,
    sourceVariantCount,
    capabilityGatedVariantCount: unavailableVariants.length,
    capabilityGatedReasons: [...new Set(unavailableVariants.flatMap((variant) =>
      Array.isArray(variant && variant.reasons) ? variant.reasons : []))],
    observationSampleCount: sourceRoomsAnalyzed,
    effectiveObservationWeight: 0,
    selectionModel: "uniform-valid-qsna-family-project-authored",
    selectionAuthority: ABYSSAL_CONTENT_AUTHORITY.PROJECT_AUTHORED,
    familySelectionAuthority: ABYSSAL_CONTENT_AUTHORITY.PROJECT_AUTHORED,
    familyEligibilityAuthority: ABYSSAL_CONTENT_AUTHORITY.OBSERVED_EMPIRICAL,
    compositionModel:
      "qsna-independent-appearance-positive-uniform-quantity-bounded-reconciliation",
    appearanceAuthority: ABYSSAL_CONTENT_AUTHORITY.OBSERVED_EMPIRICAL,
    quantityBoundsAuthority: ABYSSAL_CONTENT_AUTHORITY.OBSERVED_EMPIRICAL,
    familyEnemyCountBoundsAuthority:
      ABYSSAL_CONTENT_AUTHORITY.OBSERVED_EMPIRICAL,
    quantitySelectionAuthority: ABYSSAL_CONTENT_AUTHORITY.PROJECT_AUTHORED,
    reconciliationAuthority: ABYSSAL_CONTENT_AUTHORITY.PROJECT_AUTHORED,
    wholeObservedCompositions: false,
    syntheticComposition: true,
    substitutionsAllowed: false,
  };
}

const ABYSSAL_SPACE_CATALOGUE_ID_BY_TIER = Object.freeze({
  0: ABYSSAL_SPACE_TIER0_CATALOGUE_ID,
  1: ABYSSAL_SPACE_TIER1_CATALOGUE_ID,
  2: ABYSSAL_SPACE_TIER2_CATALOGUE_ID,
  3: ABYSSAL_SPACE_TIER3_CATALOGUE_ID,
  4: ABYSSAL_SPACE_TIER4_CATALOGUE_ID,
  5: ABYSSAL_SPACE_TIER5_CATALOGUE_ID,
  6: ABYSSAL_SPACE_TIER6_CATALOGUE_ID,
});
const ABYSSAL_ENCOUNTER_THEME_BY_TIER = Object.freeze({
  0: ABYSSAL_TIER0_COMBINED_ENCOUNTER_THEME,
  1: ABYSSAL_TIER1_COMBINED_ENCOUNTER_THEME,
  2: ABYSSAL_TIER2_COMBINED_ENCOUNTER_THEME,
  3: ABYSSAL_TIER3_COMBINED_ENCOUNTER_THEME,
  4: ABYSSAL_TIER4_COMBINED_ENCOUNTER_THEME,
  5: ABYSSAL_TIER5_COMBINED_ENCOUNTER_THEME,
  6: ABYSSAL_TIER6_COMBINED_ENCOUNTER_THEME,
});

function validateEncounterNpcEntries(npcEntries, errorPrefix, errors) {
  let maxNpcCount = 0;
  let maxObjectiveRelevantCount = 0;
  for (const [index, entry] of npcEntries.entries()) {
    const entryLabel = `${errorPrefix}: npcEntries[${index}]`;
    const minCount = Math.max(0, toInteger(entry && entry.minimumCount, 0));
    const maxCount = Math.max(0, toInteger(entry && entry.maximumCount, 0));
    if (maxCount < minCount) errors.push(`${entryLabel}: invalid count range`);
    const profileKey = String(
      entry && (entry.npcProfileKey || entry.profileQuery) || "",
    ).trim();
    const validation = getAbyssalNpcProfileValidationReport(profileKey);
    if (!profileKey || validation.safe !== true || validation.profileID !== profileKey) {
      errors.push(`${entryLabel}: missing NPC profile/type`);
    }
    for (const choice of listEncounterEntryChoices(entry)) {
      const choiceProfileKey = String(
        choice && (choice.npcProfileKey || choice.profileQuery) || "",
      ).trim();
      const choiceValidation = getAbyssalNpcProfileValidationReport(choiceProfileKey);
      if (
        !choiceProfileKey || choiceValidation.safe !== true ||
        choiceValidation.profileID !== choiceProfileKey
      ) {
        errors.push(`${entryLabel}: missing NPC profile/type`);
      }
    }
    maxNpcCount += maxCount;
    if (entry && entry.objectiveRelevant !== false) maxObjectiveRelevantCount += maxCount;
  }
  return { maxNpcCount, maxObjectiveRelevantCount };
}

function validateCombinedEncounterComposition(profile, expectedTier, errorPrefix, errors) {
  if (profile && profile.observedSpawnProfile === true) return;
  const combinedEncounterTheme = ABYSSAL_ENCOUNTER_THEME_BY_TIER[expectedTier] ||
    ABYSSAL_TIER1_COMBINED_ENCOUNTER_THEME;
  if (
    normalizeEncounterText(profile && profile.encounterTheme, "") !==
      combinedEncounterTheme
  ) return;
  const observedEmpiricalProfile = normalizeEncounterText(profile.sourceModelID, "") ===
    ABYSSAL_SPACE_CATALOGUE_ID_BY_TIER[expectedTier];
  const composition = expectedTier === 0
    ? summarizeCombinedEncounterComposition(profile, ABYSSAL_TIER0_APPROVED_TYPE_IDS)
    : expectedTier >= 2
      ? summarizeCombinedEncounterComposition(
        profile,
        expectedTier === 2
          ? ABYSSAL_TIER2_APPROVED_TYPE_IDS
          : ABYSSAL_HIGHER_TIER_APPROVED_TYPE_IDS,
      )
      : summarizeTier1CombinedEncounterComposition(profile);
  if (!observedEmpiricalProfile && composition.droneCount <= 0) {
    errors.push(`${errorPrefix}: missing approved needle drone`);
  }
  if (!observedEmpiricalProfile && composition.shipCount <= 0) {
    errors.push(`${errorPrefix}: missing approved Triglavian frigate`);
  }
  if (!observedEmpiricalProfile && !composition.approvedOnly) {
    errors.push(`${errorPrefix}: unapproved typeID ${composition.invalidTypeIDs.join(",")}`);
  }
  if (!observedEmpiricalProfile && composition.forbiddenEwar) {
    errors.push(`${errorPrefix}: forbidden EWAR NPC`);
  }
}

function validateEncounterCatalogue(catalogue, expectedTier) {
  const errors = [];
  const seenProfileIDs = new Set();
  for (const profile of Array.isArray(catalogue) ? catalogue : []) {
    const profileID = String(
      profile && profile.encounterProfileID || "",
    ).trim();
    const errorPrefix = profileID || "<missing-profile-id>";
    if (!profileID) {
      errors.push(`${errorPrefix}: missing encounterProfileID`);
    } else if (seenProfileIDs.has(profileID)) {
      errors.push(`${profileID}: duplicate encounterProfileID`);
    }
    seenProfileIDs.add(profileID);
    if (!String(profile && profile.encounterName || "").trim()) {
      errors.push(`${errorPrefix}: missing name`);
    }
    if (toInteger(profile && profile.tier, -1) !== expectedTier) {
      errors.push(`${errorPrefix}: unsupported tier`);
    }
    if (normalizeEncounterRoomIndexes(
      profile && profile.eligibleRoomIndexes,
    ).length <= 0) {
      errors.push(`${errorPrefix}: no eligible rooms`);
    }
    if (normalizeEncounterWeatherTypes(
      profile && profile.eligibleWeatherTypes,
    ).length <= 0) {
      errors.push(`${errorPrefix}: no eligible weather`);
    }
    if (!(Number(profile && profile.weight) > 0)) {
      errors.push(`${errorPrefix}: invalid weight`);
    }
    const npcEntries = Array.isArray(profile && profile.npcEntries)
      ? profile.npcEntries
      : [];
    if (npcEntries.length <= 0) {
      errors.push(`${errorPrefix}: no npcEntries`);
    }
    const { maxNpcCount, maxObjectiveRelevantCount } =
      validateEncounterNpcEntries(npcEntries, errorPrefix, errors);
    if (maxObjectiveRelevantCount <= 0) {
      errors.push(`${errorPrefix}: zero possible objective-relevant NPCs`);
    }
    const maximumTotalCount = toInteger(
      profile && profile.maximumTotalCount,
      0,
    );
    if (
      maximumTotalCount > 0 &&
      maximumTotalCount < maxObjectiveRelevantCount &&
      maximumTotalCount < npcEntries.reduce((total, entry) =>
        total + Math.max(
          0,
          toInteger(entry && entry.minimumCount, 0),
        ), 0)
    ) {
      errors.push(`${errorPrefix}: invalid maximum total count`);
    }
    if (toInteger(profile && profile.spawnRadiusMeters, 0) <= 0) {
      errors.push(`${errorPrefix}: invalid spawn radius`);
    }
    const observedTierMaximum = toInteger(
      OBSERVED_ABYSSAL_NPC_SPAWN_REGISTRY.tierMaximumObservedNpcCount[
        String(expectedTier)
      ],
      ABYSSAL_TIER1_ENCOUNTER_MAX_NPC_COUNT,
    );
    const isEmpiricalAbyssalSpaceProfile =
      ABYSSAL_SPACE_CLASSIFIER_BY_TIER[expectedTier](profile);
    const allowedMaximumNpcCount = profile && (
      profile.observedSpawnProfile === true ||
      isEmpiricalAbyssalSpaceProfile
    )
      ? observedTierMaximum
      : ABYSSAL_TIER1_ENCOUNTER_MAX_NPC_COUNT;
    if (maxNpcCount > allowedMaximumNpcCount) {
      errors.push(`${errorPrefix}: unsafe maximum NPC count`);
    }
    if (
      profile && profile.observedSpawnProfile === true &&
      !isObservedAbyssalEncounterProfile(profile, expectedTier)
    ) {
      errors.push(`${errorPrefix}: observed profile admission invalid`);
    }
    validateCombinedEncounterComposition(profile, expectedTier, errorPrefix, errors);
  }
  return { success: errors.length === 0, errors };
}

function validateAbyssalSpaceEncounterCatalogue(catalogue, expectedTier) {
  const validation = validateEncounterCatalogue(catalogue, expectedTier);
  const errors = [...validation.errors];
  for (const weatherType of ABYSSAL_CALM_WEATHER_TYPES) {
    for (const roomIndex of [1, 2, 3]) {
      if (!catalogue.some((profile) =>
        Array.isArray(profile.eligibleWeatherTypes) &&
        profile.eligibleWeatherTypes.includes(weatherType) &&
        Array.isArray(profile.eligibleRoomIndexes) &&
        profile.eligibleRoomIndexes.includes(roomIndex))) {
        errors.push(
          `abyssal.space Tier ${expectedTier} coverage missing ` +
          `weather=${weatherType} room=${roomIndex}`,
        );
      }
    }
  }
  return { success: errors.length === 0, errors };
}

module.exports = {
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
};
