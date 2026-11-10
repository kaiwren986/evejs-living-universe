"use strict";

const {
  getNpcProfile,
  buildNpcDefinition,
  getNpcBehaviorProfile,
} = require("../../../space/npc/npcData");
const {
  resolveNpcHardwareFamily,
  validateNpcHardwareDefinition,
} = require("../../../space/npc/npcHardwareCatalog");
const {
  getAbyssalTier1SafeNpcTypeSpecs,
  OBSERVED_ABYSSAL_NPC_TYPE_RESOLUTION_AUDIT,
  validateAbyssalTier1SafeNpcType,
} = require("../../../space/npc/abyssal/abyssalNpcCatalog");
const {
  auditNpcRuntimeSupport,
} = require("../../../space/npc/npcRuntimeCapabilityAudit");
const {
  cloneValue,
  deepFreeze,
} = require("../../domain/abyssalValueUtils");
const {
  ABYSSAL_CONTENT_AUTHORITY,
  ABYSSAL_CONTENT_COMPLETENESS_STATUS,
  validateAbyssalContentAuthority,
} = require("../../catalog/abyssalContentAuthority");
const {
  T0_DARK_ENCOUNTER_THEME,
  T0_DARK_ENCOUNTER_VARIANT_SPECS,
} = require("../../catalog/t0DarkEncounterCatalog");
const {
  CATALOGUE_ID: ABYSSAL_SPACE_TIER0_CATALOGUE_ID,
  TIER1_CATALOGUE_ID: ABYSSAL_SPACE_TIER1_CATALOGUE_ID,
  TIER2_CATALOGUE_ID: ABYSSAL_SPACE_TIER2_CATALOGUE_ID,
  TIER3_CATALOGUE_ID: ABYSSAL_SPACE_TIER3_CATALOGUE_ID,
  TIER4_CATALOGUE_ID: ABYSSAL_SPACE_TIER4_CATALOGUE_ID,
  TIER5_CATALOGUE_ID: ABYSSAL_SPACE_TIER5_CATALOGUE_ID,
  TIER6_CATALOGUE_ID: ABYSSAL_SPACE_TIER6_CATALOGUE_ID,
} = require("../../catalog/content/abyssalTelemetryCatalogueIdentity");
const {
  QSNA_ABYSSAL_NPC_SOURCE_AUTHORITY,
  createQsnaAbyssalSpawnRegistry,
} = require("../../catalog/content/qsnaAbyssalSpawnRegistry");

const RETAIL_EMPTY_NPC_ENTITY_LOADOUT_ID =
  "retail_empty_npc_entity_loadout";
const ABYSSAL_EXPLICIT_PLACEHOLDER_NPC_PROFILE_ID =
  "parity_guristas_missile_frigate";
const ABYSSAL_TIER1_ENCOUNTER_MAX_NPC_COUNT = 16;
const ABYSSAL_CALM_WEATHER_TYPES = Object.freeze([
  "dark",
  "electrical",
  "exotic",
  "firestorm",
  "gamma",
]);
const ABYSSAL_TIER0_COMBINED_ENCOUNTER_THEME = T0_DARK_ENCOUNTER_THEME;
const ABYSSAL_TIER1_COMBINED_ENCOUNTER_THEME =
  "abyssal_mixed_triglavian_drone";
const ABYSSAL_TIER2_COMBINED_ENCOUNTER_THEME =
  "abyssal_tier2_mixed_triglavian_drone";
const ABYSSAL_TIER3_COMBINED_ENCOUNTER_THEME =
  "abyssal_tier3_mixed_triglavian_drone";
const ABYSSAL_TIER4_COMBINED_ENCOUNTER_THEME =
  "abyssal_tier4_mixed_triglavian_drone";
const ABYSSAL_TIER5_COMBINED_ENCOUNTER_THEME =
  "abyssal_tier5_mixed_triglavian_drone";
const ABYSSAL_TIER6_COMBINED_ENCOUNTER_THEME =
  "abyssal_tier6_mixed_triglavian_drone";
const ABYSSAL_TIER1_NEEDLE_DRONE_GROUP_ID = 1997;
const ABYSSAL_TIER1_TRIGLAVIAN_FRIGATE_GROUP_ID = 1982;
const ABYSSAL_TIER1_NEEDLE_DRONE_FACTION_ID = 500025;
const ABYSSAL_TIER1_TRIGLAVIAN_FACTION_ID = 500026;

function toInteger(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => String(entry || "")).filter(Boolean);
}

function normalizeEncounterText(value, fallback = "") {
  const normalized = String(value == null ? "" : value).trim();
  return normalized || fallback;
}

function normalizeEncounterWeatherTypes(value) {
  const weatherTypes = Array.isArray(value)
    ? value
      .map((entry) => String(entry || "").trim().toLowerCase())
      .filter(Boolean)
    : [];
  return weatherTypes.length > 0
    ? [...new Set(weatherTypes)]
    : [...ABYSSAL_CALM_WEATHER_TYPES];
}

function normalizeEncounterRoomIndexes(value) {
  const roomIndexes = Array.isArray(value)
    ? value
      .map((entry) => Math.max(0, toInteger(entry, 0)))
      .filter((entry) => entry > 0)
    : [];
  return [...new Set(roomIndexes)];
}

function normalizeEncounterResolutionRequest(request = {}) {
  const tier = toInteger(request.tier, -1);
  const weatherType = normalizeEncounterText(
    request.weatherType,
    "",
  ).toLowerCase();
  const roomIndex = toInteger(request.roomIndex, 0);
  return {
    tier,
    weatherType,
    roomIndex,
    contextKey: `${tier}:${weatherType}:${roomIndex}`,
  };
}

const ABYSSAL_SAFE_NPC_CANDIDATE_SPECS_BY_ID = deepFreeze({
  ...getAbyssalTier1SafeNpcTypeSpecs(),
  parity_guristas_missile_frigate: {
    profileID: "parity_guristas_missile_frigate",
    factionTheme: "guristas",
    weaponStyle: "missile",
    safetyNotes: [
      "Explicit project-authored placeholder profile; never used as a substitute for an unavailable requested NPC.",
    ],
  },
  parity_guristas_rail_frigate: {
    profileID: "parity_guristas_rail_frigate",
    factionTheme: "guristas",
    weaponStyle: "rail",
    safetyNotes: [
      "Uses the same native parity frigate pattern as the current fallback profile.",
    ],
  },
  parity_dire_pithi_arrogator: {
    profileID: "parity_dire_pithi_arrogator",
    factionTheme: "guristas",
    safetyNotes: [
      "Locally resolved deadspace Guristas frigate with an empty retail NPC entity loadout.",
    ],
  },
  parity_pithi_defender: {
    profileID: "parity_pithi_defender",
    factionTheme: "guristas",
    safetyNotes: [
      "Locally resolved deadspace Guristas frigate with an empty retail NPC entity loadout.",
    ],
  },
  guristas_pithi_arrogator: {
    profileID: "guristas_pithi_arrogator",
    factionTheme: "guristas",
    safetyNotes: [
      "Locally resolved deadspace Guristas frigate backed by an existing non-parity NPC profile ID.",
    ],
  },
  parity_dread_pithi_saboteur: {
    profileID: "parity_dread_pithi_saboteur",
    factionTheme: "guristas",
    safetyNotes: [
      "Locally resolved deadspace Guristas frigate with an empty retail NPC entity loadout.",
    ],
  },
  parity_dread_pithi_invader: {
    profileID: "parity_dread_pithi_invader",
    factionTheme: "guristas",
    safetyNotes: [
      "Locally resolved deadspace Guristas frigate with an empty retail NPC entity loadout.",
    ],
  },
  parity_deadspace_overseer_26684_dread_pithi_terminator: {
    profileID: "parity_deadspace_overseer_26684_dread_pithi_terminator",
    factionTheme: "guristas",
    safetyNotes: [
      "Locally resolved Dread Pithi Terminator profile backed by the existing deadspace overseer frigate definition.",
    ],
  },
  parity_serpentis_rail_frigate: {
    profileID: "parity_serpentis_rail_frigate",
    factionTheme: "serpentis",
    weaponStyle: "rail",
    safetyNotes: [
      "Standard native parity frigate with empty retail NPC entity loadout.",
    ],
  },
  parity_sansha_beam_frigate: {
    profileID: "parity_sansha_beam_frigate",
    factionTheme: "sansha",
    weaponStyle: "beam",
    safetyNotes: [
      "Standard native parity frigate with empty retail NPC entity loadout.",
    ],
  },
});

function buildSafeAbyssalNpcCatalogEntry(spec = {}) {
  const profileID = String(spec.profileID || "").trim();
  const profile = profileID ? getNpcProfile(profileID) : null;
  const definition = profileID ? buildNpcDefinition(profileID) : null;
  const behaviorProfileID = String(
    profile && profile.behaviorProfileID || "",
  ).trim();
  const behaviorProfile = behaviorProfileID
    ? getNpcBehaviorProfile(behaviorProfileID)
    : null;
  const typeID = toInteger(spec.typeID || profile && profile.shipTypeID, 0);
  const typeAuditResult = typeID > 0 && spec.groupID
    ? validateAbyssalTier1SafeNpcType({ ...spec, typeID })
    : null;
  const loadout = definition && definition.loadout &&
      typeof definition.loadout === "object"
    ? definition.loadout
    : null;
  const hostileUtilityTemplateIDs = Array.isArray(
    definition && definition.hostileUtilityTemplateIDs,
  )
    ? definition.hostileUtilityTemplateIDs
    : [];
  const modules = Array.isArray(loadout && loadout.modules)
    ? loadout.modules
    : [];
  const charges = Array.isArray(loadout && loadout.charges)
    ? loadout.charges
    : [];
  const hardwareFamily = String(
    definition ? resolveNpcHardwareFamily(definition) : "",
  ).trim();
  const hardwareValidation = definition
    ? validateNpcHardwareDefinition(definition)
    : { success: false, errorMsg: "NPC_PROFILE_DEFINITION_UNAVAILABLE" };
  const combatControllerSupported = Boolean(behaviorProfile) &&
    behaviorProfileID.length > 0;
  const runtimeCapabilityAudit = typeAuditResult && typeAuditResult.audit &&
      typeAuditResult.audit.runtimeCapabilityAudit
    ? cloneValue(typeAuditResult.audit.runtimeCapabilityAudit)
    : typeID > 0
      ? auditNpcRuntimeSupport(typeID, {
        hardwareValidationStatus:
          hardwareValidation && hardwareValidation.success === true
            ? "VALID"
            : String(
              hardwareValidation && hardwareValidation.errorMsg || "INVALID",
            ),
        combatControllerSupported,
      })
      : null;
  const capabilities = normalizeStringArray(
    Array.isArray(spec.capabilities)
      ? spec.capabilities
      : typeAuditResult && typeAuditResult.audit &&
        typeAuditResult.audit.capabilityIDs,
  );
  const electronicWarfare = capabilities.some((capabilityID) => [
    "stasis_webifier",
    "energy_neutralizer",
    "warp_scrambler",
  ].includes(capabilityID));
  const equipmentMode = modules.length > 0 || charges.length > 0
    ? "authored_module_loadout"
    : hardwareValidation && hardwareValidation.success === true
      ? "native_hardware_family"
      : "missing_or_unsupported_combat_hardware";
  const safe = Boolean(profile) &&
    Boolean(definition) &&
    profileID.length > 0 &&
    String(profile.entityType || "").trim() === "npc" &&
    String(profile.loadoutID || "").trim() ===
      RETAIL_EMPTY_NPC_ENTITY_LOADOUT_ID &&
    hostileUtilityTemplateIDs.length <= 0 &&
    modules.length <= 0 &&
    charges.length <= 0 &&
    combatControllerSupported === true &&
    hardwareValidation &&
    hardwareValidation.success === true &&
    runtimeCapabilityAudit &&
    runtimeCapabilityAudit.status === "SUPPORTED" &&
    runtimeCapabilityAudit.unsupportedCapabilities.length === 0 &&
    runtimeCapabilityAudit.unknownCapabilities.length === 0 &&
    (!typeAuditResult || typeAuditResult.success === true);
  return {
    profileID,
    profileName: String(profile && profile.name || profileID),
    typeID,
    displayName: String(
      spec.displayName || profile && profile.name || profileID,
    ),
    groupID: toInteger(spec.groupID || profile && profile.groupID, 0),
    factionID: toInteger(spec.factionID || profile && profile.factionID, 0),
    factionTheme: String(spec.factionTheme || ""),
    sizeClass: String(spec.sizeClass || ""),
    combatRole: String(spec.combatRole || ""),
    verifiedDamageType: String(spec.verifiedDamageType || ""),
    electronicWarfare,
    allowRetailEwar: spec.allowRetailEwar === true,
    supportBehavior: String(spec.supportBehavior || ""),
    capabilities,
    capabilityData: spec.capabilityData &&
        typeof spec.capabilityData === "object"
      ? cloneValue(spec.capabilityData)
      : {},
    behaviorOverrides: spec.behaviorOverrides &&
        typeof spec.behaviorOverrides === "object"
      ? cloneValue(spec.behaviorOverrides)
      : {},
    tierEligibility: Array.isArray(spec.tierEligibility)
      ? [...new Set(spec.tierEligibility
        .map((entry) => toInteger(entry, -1))
        .filter((entry) => entry >= 0))]
      : [1],
    qsnaTierEligibility: Array.isArray(
      spec.qsnaTierEligibility,
    )
      ? [...new Set(spec.qsnaTierEligibility
        .map((entry) => toInteger(entry, -1))
        .filter((entry) => entry >= 0))]
      : [],
    runtimePolicySupported: true,
    weaponStyle: String(spec.weaponStyle || ""),
    safe,
    entityType: String(profile && profile.entityType || ""),
    behaviorProfileID,
    combatControllerSupported,
    loadoutID: String(profile && profile.loadoutID || ""),
    lootTableID: String(profile && profile.lootTableID || ""),
    hardwareFamily,
    hardwareValidationStatus:
      hardwareValidation && hardwareValidation.success === true
        ? "VALID"
        : String(hardwareValidation && hardwareValidation.errorMsg || "INVALID"),
    typeValidationStatus: typeAuditResult
      ? typeAuditResult.success === true
        ? "VALID"
        : typeAuditResult.errors.join("; ")
      : "",
    typeAudit: typeAuditResult ? cloneValue(typeAuditResult.audit) : null,
    runtimeCapabilityAudit: cloneValue(runtimeCapabilityAudit),
    capabilityMappingMode:
      capabilities.length > 0 ? "profile_declared" : "sde_native_runtime",
    equipmentMode,
    hostileUtilityTemplateIDs: cloneValue(hostileUtilityTemplateIDs),
    safetyNotes: normalizeStringArray(spec.safetyNotes),
  };
}

const ABYSSAL_SAFE_NPC_CATALOG_BY_PROFILE_ID = deepFreeze(
  Object.fromEntries(
    Object.entries(ABYSSAL_SAFE_NPC_CANDIDATE_SPECS_BY_ID)
      .map(([profileID, spec]) => [
        profileID,
        buildSafeAbyssalNpcCatalogEntry(spec),
      ]),
  ),
);

const ABYSSAL_SAFE_NPC_PROFILES_BY_TYPE_ID = deepFreeze(
  Object.values(ABYSSAL_SAFE_NPC_CATALOG_BY_PROFILE_ID)
    .filter((entry) => entry && entry.safe === true &&
      toInteger(entry.typeID, 0) > 0)
    .sort((left, right) =>
      String(left.profileID).localeCompare(String(right.profileID)))
    .reduce((profilesByTypeID, entry) => {
      const typeID = toInteger(entry.typeID, 0);
      const existing = profilesByTypeID[String(typeID)] || null;
      profilesByTypeID[String(typeID)] = {
        profileID: String(entry.profileID || ""),
        profileName: String(entry.profileName || ""),
        typeID,
        groupID: toInteger(entry.groupID, 0),
        factionID: toInteger(entry.factionID, 0),
        factionTheme: String(entry.factionTheme || ""),
        weaponStyle: String(entry.weaponStyle || ""),
        capabilities: cloneValue(entry.capabilities || []),
        capabilityData: cloneValue(entry.capabilityData || {}),
        behaviorOverrides: cloneValue(entry.behaviorOverrides || {}),
        safe: true,
        tierEligibility: [...new Set([
          ...(existing && Array.isArray(existing.tierEligibility)
            ? existing.tierEligibility
            : []),
          ...(Array.isArray(entry.tierEligibility)
            ? entry.tierEligibility
            : []),
        ])].sort((left, right) => left - right),
        qsnaTierEligibility: [...new Set([
          ...(existing && Array.isArray(
            existing.qsnaTierEligibility,
          )
            ? existing.qsnaTierEligibility
            : []),
          ...(Array.isArray(entry.qsnaTierEligibility)
            ? entry.qsnaTierEligibility
            : []),
        ])].sort((left, right) => left - right),
      };
      return profilesByTypeID;
    }, {}),
);

const ABYSSAL_TIER0_TELEMETRY_ONLY_NPC_TYPE_IDS = new Set([
  47879,
  48263,
  56138,
  56188,
  56351,
]);

const ABYSSAL_AUTHORED_NPC_PROFILES_BY_TYPE_ID = deepFreeze(
  Object.fromEntries(
    Object.entries(ABYSSAL_SAFE_NPC_PROFILES_BY_TYPE_ID)
      .filter(([typeID]) =>
        !ABYSSAL_TIER0_TELEMETRY_ONLY_NPC_TYPE_IDS.has(
          toInteger(typeID, 0),
        )),
  ),
);

function getAbyssalNpcProfileValidationReport(profileID) {
  const normalizedProfileID = String(profileID || "").trim();
  const requestedEntry =
    ABYSSAL_SAFE_NPC_CATALOG_BY_PROFILE_ID[normalizedProfileID] || null;
  const requestedIsValid = requestedEntry &&
    requestedEntry.safe === true &&
    requestedEntry.profileID === normalizedProfileID;

  if (!requestedIsValid) {
    return {
      requestedProfileID: normalizedProfileID,
      profileID: normalizedProfileID,
      profileName: "",
      typeID: 0,
      displayName: "",
      groupID: 0,
      factionID: 0,
      validationStatus: "UNAVAILABLE",
      admissionAllowed: false,
      fallbackUsed: false,
      fallbackReason: "",
      errorMsg: normalizedProfileID
        ? "NPC_PROFILE_UNAVAILABLE_OR_UNSAFE"
        : "NPC_PROFILE_REQUIRED",
      factionTheme: "",
      weaponStyle: "",
      hardwareFamily: "",
      hardwareValidationStatus: "INVALID",
      combatControllerSupported: false,
      equipmentMode: "missing_or_unsupported_combat_hardware",
      safe: false,
      tierEligibility: [],
      qsnaTierEligibility: [],
      runtimeCapabilityAudit: null,
      capabilityMappingMode: "unavailable",
    };
  }

  return {
    requestedProfileID: normalizedProfileID,
    profileID: requestedEntry.profileID,
    profileName: requestedEntry.profileName,
    typeID: requestedEntry.typeID,
    displayName: requestedEntry.displayName,
    groupID: requestedEntry.groupID,
    factionID: requestedEntry.factionID,
    validationStatus: "VALID",
    admissionAllowed: true,
    fallbackUsed: false,
    fallbackReason: "",
    errorMsg: "",
    factionTheme: requestedEntry.factionTheme,
    weaponStyle: requestedEntry.weaponStyle,
    hardwareFamily: requestedEntry.hardwareFamily,
    hardwareValidationStatus: requestedEntry.hardwareValidationStatus,
    combatControllerSupported:
      requestedEntry.combatControllerSupported === true,
    equipmentMode: requestedEntry.equipmentMode,
    safe: true,
    tierEligibility: cloneValue(requestedEntry.tierEligibility || []),
    qsnaTierEligibility: cloneValue(
      requestedEntry.qsnaTierEligibility || [],
    ),
    capabilities: cloneValue(requestedEntry.capabilities || []),
    capabilityMappingMode: String(
      requestedEntry.capabilityMappingMode || "unavailable",
    ),
    runtimeCapabilityAudit: cloneValue(
      requestedEntry.runtimeCapabilityAudit || null,
    ),
  };
}

function resolveSafeAbyssalNpcCatalogEntry(profileID) {
  const report = getAbyssalNpcProfileValidationReport(profileID);
  return {
    requestedProfileID: report.requestedProfileID,
    profileID: report.profileID,
    profileName: report.profileName,
    typeID: report.typeID,
    displayName: report.displayName,
    groupID: report.groupID,
    factionID: report.factionID,
    factionTheme: report.factionTheme,
    weaponStyle: report.weaponStyle,
    validationStatus: report.validationStatus,
    admissionAllowed: report.admissionAllowed === true,
    fallbackUsed: false,
    fallbackReason: "",
    errorMsg: report.errorMsg,
    safe: report.safe === true,
    tierEligibility: cloneValue(report.tierEligibility || []),
    qsnaTierEligibility: cloneValue(
      report.qsnaTierEligibility || [],
    ),
    capabilities: cloneValue(report.capabilities || []),
  };
}

function buildEncounterNpcEntry(overrides = {}) {
  const profileChoices = Array.isArray(overrides.npcProfileKeyChoices)
    ? overrides.npcProfileKeyChoices
      .map((entry) => resolveSafeAbyssalNpcCatalogEntry(entry))
    : [];
  const requestedProfileKey = String(
    overrides.npcProfileKey ||
    profileChoices[0] && profileChoices[0].profileID ||
    overrides.profileQuery ||
    overrides.npcProfileID ||
    "",
  ).trim();
  const resolvedProfile = resolveSafeAbyssalNpcCatalogEntry(
    requestedProfileKey,
  );
  const minimumCount = Math.max(
    0,
    toInteger(overrides.minimumCount, toInteger(overrides.count, 1)),
  );
  const maximumCount = Math.max(
    minimumCount,
    toInteger(overrides.maximumCount, minimumCount),
  );
  const spawnRadiusMeters = toInteger(overrides.spawnRadiusMeters, 0);
  return {
    npcEntryID: String(
      overrides.npcEntryID || overrides.role || resolvedProfile.profileID,
    ),
    runtimeKind: "nativeCombat",
    npcProfileKey: resolvedProfile.profileID,
    profileQuery: resolvedProfile.profileID,
    profileName: resolvedProfile.profileName,
    typeID: toInteger(resolvedProfile.typeID, 0),
    displayName: String(
      resolvedProfile.displayName || resolvedProfile.profileName || "",
    ),
    groupID: toInteger(resolvedProfile.groupID, 0),
    factionID: toInteger(resolvedProfile.factionID, 0),
    npcProfileChoices: profileChoices.map((entry) => ({
      npcProfileKey: entry.profileID,
      profileQuery: entry.profileID,
      profileName: entry.profileName,
      typeID: toInteger(entry.typeID, 0),
      displayName: String(entry.displayName || entry.profileName || ""),
      groupID: toInteger(entry.groupID, 0),
      factionID: toInteger(entry.factionID, 0),
      requestedProfileQuery: entry.requestedProfileID,
      validationStatus: entry.validationStatus,
      admissionAllowed: entry.admissionAllowed === true,
      admissionError: entry.errorMsg,
      fallbackUsed: false,
      fallbackReason: "",
      weaponStyle: entry.weaponStyle,
    })),
    requestedProfileQuery: resolvedProfile.requestedProfileID,
    fallbackUsed: resolvedProfile.fallbackUsed,
    fallbackReason: resolvedProfile.fallbackReason,
    weaponStyle: resolvedProfile.weaponStyle,
    role: String(overrides.role || "hostile"),
    minimumCount,
    maximumCount,
    count: minimumCount,
    required: overrides.required !== false,
    objectiveRelevant: overrides.objectiveRelevant !== false,
    objectiveRole:
      overrides.objectiveRelevant === false
        ? "support"
        : "kill_all_hostiles",
    spawnRadiusMeters: spawnRadiusMeters > 0 ? spawnRadiusMeters : 0,
    spawnOffsetMeters: spawnRadiusMeters > 0
      ? spawnRadiusMeters
      : Math.max(5_000, toInteger(overrides.spawnOffsetMeters, 10_000)),
    spawnReference: "encounter_anchor",
    spawnDistanceMode: "formation",
  };
}

function buildEncounterProfile(overrides = {}, dependencies = {}) {
  const normalizeRewardProfile =
    typeof dependencies.normalizeRewardProfile === "function"
      ? dependencies.normalizeRewardProfile
      : cloneValue;
  const normalizeExtractionNodeProfile =
    typeof dependencies.normalizeExtractionNodeProfile === "function"
      ? dependencies.normalizeExtractionNodeProfile
      : cloneValue;
  const npcEntries = Array.isArray(overrides.npcEntries)
    ? overrides.npcEntries.map((entry) => buildEncounterNpcEntry(entry))
    : [];
  const spawnRadiusMeters = Math.max(
    5_000,
    toInteger(overrides.spawnRadiusMeters, 10_000),
  );
  const spawnJitterMeters = Math.max(
    0,
    toInteger(overrides.spawnJitterMeters, 1_500),
  );
  const rewardMultiplier = Number(overrides.rewardMultiplier);
  const maximumTotalCount = Math.max(
    0,
    toInteger(overrides.maximumTotalCount, 0),
  );
  const combatBudget = overrides.combatBudget &&
      typeof overrides.combatBudget === "object"
    ? cloneValue(overrides.combatBudget)
    : null;
  return {
    encounterProfileID: String(overrides.encounterProfileID || ""),
    contentAuthority: validateAbyssalContentAuthority(
      overrides.contentAuthority || ABYSSAL_CONTENT_AUTHORITY.PROJECT_AUTHORED,
      `Abyssal encounter profile ${String(
        overrides.encounterProfileID || "unknown",
      )}`,
    ),
    encounterName: String(overrides.encounterName || ""),
    tier: Math.max(0, toInteger(overrides.tier, 1)),
    eligibleRoomIndexes: normalizeEncounterRoomIndexes(
      overrides.eligibleRoomIndexes,
    ),
    eligibleWeatherTypes: normalizeEncounterWeatherTypes(
      overrides.eligibleWeatherTypes,
    ),
    factionTheme: String(overrides.factionTheme || "mixed"),
    encounterTheme: String(
      overrides.encounterTheme || overrides.factionTheme || "mixed",
    ),
    objectiveType: String(
      overrides.objectiveType || "kill_objective_hostiles",
    ),
    weight: Number(overrides.weight),
    npcEntries,
    spawnRadiusMeters,
    spawnJitterMeters,
    maximumTotalCount,
    combatBudget,
    rewardMultiplier:
      Number.isFinite(rewardMultiplier) && rewardMultiplier > 0
        ? rewardMultiplier
        : 1,
    rewardQuantityBonus: toInteger(overrides.rewardQuantityBonus, 0),
    rewardProfileOverride:
      overrides.rewardProfileOverride &&
        typeof overrides.rewardProfileOverride === "object"
        ? normalizeRewardProfile(overrides.rewardProfileOverride)
        : null,
    cacheProfileOverride:
      overrides.cacheProfileOverride &&
        typeof overrides.cacheProfileOverride === "object"
        ? cloneValue(overrides.cacheProfileOverride)
        : null,
    extractionNodeProfileOverride:
      overrides.extractionNodeProfileOverride &&
        typeof overrides.extractionNodeProfileOverride === "object"
        ? normalizeExtractionNodeProfile(overrides.extractionNodeProfileOverride)
        : null,
    observedObjectEntries: Array.isArray(overrides.observedObjectEntries)
      ? cloneValue(overrides.observedObjectEntries)
      : [],
    sourceModelID: String(overrides.sourceModelID || ""),
    sourceVariantID: String(overrides.sourceVariantID || ""),
    sourceSpawnID: String(overrides.sourceSpawnID || ""),
    sourceSpawnFamily: String(overrides.sourceSpawnFamily || ""),
    sourceObservationCount: Math.max(
      0,
      toInteger(overrides.sourceObservationCount, 0),
    ),
    sourceConfidenceCounts:
      overrides.sourceConfidenceCounts &&
        typeof overrides.sourceConfidenceCounts === "object"
        ? cloneValue(overrides.sourceConfidenceCounts)
        : {},
    rawObservationWeight: Math.max(
      0,
      toInteger(overrides.rawObservationWeight, 0),
    ),
    effectiveProductionWeight: Math.max(
      0,
      toInteger(overrides.effectiveProductionWeight, 0),
    ),
    sourceEvidenceAuthority: String(overrides.sourceEvidenceAuthority || ""),
    enabled: overrides.enabled !== false,
  };
}

const ABYSSAL_TIER0_APPROVED_TYPE_IDS = deepFreeze(
  Object.values(ABYSSAL_SAFE_NPC_CATALOG_BY_PROFILE_ID)
    .filter((entry) =>
      entry &&
      entry.safe === true &&
      Array.isArray(entry.tierEligibility) &&
      entry.tierEligibility.includes(0))
    .map((entry) => entry.typeID)
    .sort((left, right) => left - right),
);
const ABYSSAL_TIER1_APPROVED_TYPE_IDS = deepFreeze([
  47847, 47848, 47849, 47855,
  48092, 48234, 48241, 48253, 48256,
  56295, 56346, 56348, 56349,
]);
const ABYSSAL_TIER2_APPROVED_TYPE_IDS = deepFreeze([
  47856, 47857, 47858, 47859, 48234, 56150, 56170,
]);
const ABYSSAL_HIGHER_TIER_APPROVED_TYPE_IDS =
  ABYSSAL_TIER2_APPROVED_TYPE_IDS;
const ABYSSAL_HIGHER_TIER_ENCOUNTER_THEME_BY_TIER = deepFreeze({
  3: ABYSSAL_TIER3_COMBINED_ENCOUNTER_THEME,
  4: ABYSSAL_TIER4_COMBINED_ENCOUNTER_THEME,
  5: ABYSSAL_TIER5_COMBINED_ENCOUNTER_THEME,
  6: ABYSSAL_TIER6_COMBINED_ENCOUNTER_THEME,
});
const ABYSSAL_HIGHER_TIER_LABEL_BY_TIER = deepFreeze({
  3: "Fierce",
  4: "Raging",
  5: "Chaotic",
  6: "Cataclysmic",
});
const ABYSSAL_HIGHER_TIER_KEY_BY_TIER = deepFreeze({
  3: "fierce",
  4: "raging",
  5: "chaotic",
  6: "cataclysmic",
});
const OBSERVED_ABYSSAL_ENCOUNTER_THEME_BY_TIER = deepFreeze({
  0: ABYSSAL_TIER0_COMBINED_ENCOUNTER_THEME,
  1: ABYSSAL_TIER1_COMBINED_ENCOUNTER_THEME,
  2: ABYSSAL_TIER2_COMBINED_ENCOUNTER_THEME,
  3: ABYSSAL_TIER3_COMBINED_ENCOUNTER_THEME,
  4: ABYSSAL_TIER4_COMBINED_ENCOUNTER_THEME,
  5: ABYSSAL_TIER5_COMBINED_ENCOUNTER_THEME,
  6: ABYSSAL_TIER6_COMBINED_ENCOUNTER_THEME,
});

const OBSERVED_ABYSSAL_NPC_SPAWN_REGISTRY =
  createQsnaAbyssalSpawnRegistry({
    safeNpcCatalogByProfileID: ABYSSAL_SAFE_NPC_CATALOG_BY_PROFILE_ID,
    encounterThemeByTier: OBSERVED_ABYSSAL_ENCOUNTER_THEME_BY_TIER,
  });

const OBSERVED_ABYSSAL_NPC_SPAWN_AUDIT = deepFreeze({
  ...OBSERVED_ABYSSAL_NPC_SPAWN_REGISTRY.getAudit(),
  npcTypeResolutionAudit: cloneValue(
    OBSERVED_ABYSSAL_NPC_TYPE_RESOLUTION_AUDIT || [],
  ),
});

function listObservedAbyssalEncounterProfilesForTier(tier) {
  return OBSERVED_ABYSSAL_NPC_SPAWN_REGISTRY.listProfilesForTier(tier);
}

function isObservedAbyssalEncounterProfile(profile = null, expectedTier = null) {
  if (
    !profile ||
    profile.observedSpawnProfile !== true ||
    normalizeEncounterText(profile.sourceModelID, "") !==
      OBSERVED_ABYSSAL_NPC_SPAWN_REGISTRY.catalogueID ||
    normalizeEncounterText(profile.sourceEvidenceAuthority, "") !==
      QSNA_ABYSSAL_NPC_SOURCE_AUTHORITY
  ) {
    return false;
  }
  const tier = toInteger(profile.tier, -1);
  if (expectedTier != null && tier !== toInteger(expectedTier, -2)) {
    return false;
  }
  const entries = Array.isArray(profile.npcEntries) ? profile.npcEntries : [];
  if (entries.length <= 0) return false;
  let totalCount = 0;
  for (const entry of entries) {
    const profileID = normalizeEncounterText(
      entry && (entry.npcProfileKey || entry.profileQuery),
      "",
    );
    const report = getAbyssalNpcProfileValidationReport(profileID);
    const count = Math.max(0, toInteger(entry && entry.maximumCount, 0));
    if (
      !profileID ||
      report.validationStatus !== "VALID" ||
      report.admissionAllowed !== true ||
      report.safe !== true ||
      report.profileID !== profileID ||
      toInteger(report.typeID, 0) !== toInteger(entry && entry.typeID, 0) ||
      entry.fallbackUsed === true ||
      count <= 0
    ) {
      return false;
    }
    totalCount += count;
  }
  const tierMaximum = toInteger(
    OBSERVED_ABYSSAL_NPC_SPAWN_AUDIT &&
      OBSERVED_ABYSSAL_NPC_SPAWN_REGISTRY.tierMaximumObservedNpcCount &&
      OBSERVED_ABYSSAL_NPC_SPAWN_REGISTRY.tierMaximumObservedNpcCount[
        String(tier)
      ],
    0,
  );
  return totalCount > 0 && (tierMaximum <= 0 || totalCount <= tierMaximum);
}

function getAbyssalNpcEncounterTierAdmissionReport(
  profileID,
  encounterProfile = null,
) {
  const validation = getAbyssalNpcProfileValidationReport(profileID);
  const tier = toInteger(encounterProfile && encounterProfile.tier, -1);
  const legacyTierEligibility = Array.isArray(validation.tierEligibility)
    ? validation.tierEligibility
    : [];
  const qsnaTierEligibility = Array.isArray(
    validation.qsnaTierEligibility,
  )
    ? validation.qsnaTierEligibility
    : [];
  const legacyAdmission = legacyTierEligibility.includes(tier);
  const qsnaContext = encounterProfile &&
    encounterProfile.qsnaSpawnProfile === true &&
    isObservedAbyssalEncounterProfile(encounterProfile, tier);
  const profileOccursInEncounter = qsnaContext &&
    listEncounterNpcCandidates(encounterProfile).some((candidate) =>
      normalizeEncounterText(candidate && candidate.profileID, "") ===
        validation.profileID
    );
  const qsnaAdmission = qsnaContext &&
    profileOccursInEncounter &&
    qsnaTierEligibility.includes(tier) &&
    validation.validationStatus === "VALID" &&
    validation.admissionAllowed === true &&
    validation.safe === true;
  return {
    profileID: validation.profileID,
    tier,
    admitted: legacyAdmission || qsnaAdmission,
    admissionAuthority: qsnaAdmission
      ? "QSNA_PROCEDURAL"
      : legacyAdmission
        ? "LEGACY_GENERAL_COMPATIBILITY"
        : "NONE",
    tierEligibility: cloneValue(legacyTierEligibility),
    qsnaTierEligibility: cloneValue(qsnaTierEligibility),
  };
}

const ABYSSAL_SPACE_ENCOUNTER_CATALOG_BY_TIER = deepFreeze(
  Object.fromEntries(
    Array.from({ length: 7 }, (_, tier) => [
      String(tier),
      deepFreeze(listObservedAbyssalEncounterProfilesForTier(tier)),
    ]),
  ),
);

function buildAbyssalSpaceEncounterPartitionIndex(cataloguesByTier) {
  const index = {};
  for (const [tier, catalogue] of Object.entries(cataloguesByTier)) {
    index[tier] = {};
    for (const profile of catalogue) {
      for (const weatherType of profile.eligibleWeatherTypes) {
        if (!index[tier][weatherType]) index[tier][weatherType] = {};
        for (const roomIndex of profile.eligibleRoomIndexes) {
          const roomKey = String(roomIndex);
          if (!index[tier][weatherType][roomKey]) {
            index[tier][weatherType][roomKey] = [];
          }
          index[tier][weatherType][roomKey].push(profile);
        }
      }
    }
  }
  return deepFreeze(index);
}

const EMPTY_ABYSSAL_SPACE_ENCOUNTER_PARTITION = Object.freeze([]);
const ABYSSAL_SPACE_ENCOUNTER_PARTITION_INDEX =
  buildAbyssalSpaceEncounterPartitionIndex(
    ABYSSAL_SPACE_ENCOUNTER_CATALOG_BY_TIER,
  );

function getAbyssalSpaceEncounterPartition(query = {}) {
  const { tier, weatherType, roomIndex } =
    normalizeEncounterResolutionRequest(query);
  return ABYSSAL_SPACE_ENCOUNTER_PARTITION_INDEX[String(tier)] &&
    ABYSSAL_SPACE_ENCOUNTER_PARTITION_INDEX[String(tier)][weatherType] &&
    ABYSSAL_SPACE_ENCOUNTER_PARTITION_INDEX[String(tier)][weatherType][
      String(roomIndex)
    ] || EMPTY_ABYSSAL_SPACE_ENCOUNTER_PARTITION;
}

function validateObservedAbyssalNpcSpawnCoverage(request = {}) {
  const { tier, weatherType } = normalizeEncounterResolutionRequest(request);
  const implementedRooms = Math.max(
    1,
    toInteger(request.implementedRooms, 3),
  );
  const rooms = [];
  const unavailableRooms = [];
  for (let roomIndex = 1; roomIndex <= implementedRooms; roomIndex += 1) {
    const profiles = OBSERVED_ABYSSAL_NPC_SPAWN_REGISTRY
      .listProfilesForContext({ tier, weatherType, roomIndex });
    const roomCoverage = {
      roomIndex,
      runtimeReadyVariantCount: profiles.length,
    };
    rooms.push(roomCoverage);
    if (profiles.length <= 0) {
      const unavailable = OBSERVED_ABYSSAL_NPC_SPAWN_REGISTRY
        .selectProfileForContext({
          tier,
          weatherType,
          roomIndex,
          selectionSeed: "coverage-validation",
        });
      unavailableRooms.push({
        ...roomCoverage,
        errorMsg: normalizeEncounterText(
          unavailable && unavailable.errorMsg,
          "OBSERVED_ABYSSAL_ENCOUNTER_CONTEXT_UNAVAILABLE",
        ),
        unavailableVariantCount: toInteger(
          unavailable && unavailable.unavailableVariantCount,
          0,
        ),
        unavailableReasons:
          unavailable && Array.isArray(unavailable.unavailableReasons)
            ? cloneValue(unavailable.unavailableReasons)
            : [],
      });
    }
  }
  return {
    success: unavailableRooms.length === 0,
    catalogueID: String(
      OBSERVED_ABYSSAL_NPC_SPAWN_REGISTRY.catalogueID || "",
    ),
    tier,
    weatherType,
    implementedRooms,
    rooms,
    unavailableRooms,
  };
}

function listEncounterNpcCandidates(encounterProfile = null) {
  const candidates = [];
  for (const [entryIndex, entry] of (
    Array.isArray(encounterProfile && encounterProfile.npcEntries)
      ? encounterProfile.npcEntries
      : []
  ).entries()) {
    candidates.push({
      entryIndex,
      choiceIndex: null,
      profileID: String(
        entry && (entry.npcProfileKey || entry.profileQuery) || "",
      ),
      typeID: toInteger(entry && entry.typeID, 0),
      requestedProfileID: String(
        entry && (
          entry.requestedProfileQuery ||
          entry.npcProfileKey ||
          entry.profileQuery
        ) || "",
      ),
      fallbackUsed: entry && entry.fallbackUsed === true,
      fallbackReason: String(entry && entry.fallbackReason || ""),
    });
    for (const [choiceIndex, choice] of (
      Array.isArray(entry && entry.npcProfileChoices)
        ? entry.npcProfileChoices
        : []
    ).entries()) {
      candidates.push({
        entryIndex,
        choiceIndex,
        profileID: String(
          choice && (choice.npcProfileKey || choice.profileQuery) || "",
        ),
        typeID: toInteger(choice && choice.typeID, 0),
        requestedProfileID: String(
          choice && (
            choice.requestedProfileQuery ||
            choice.npcProfileKey ||
            choice.profileQuery
          ) || "",
        ),
        fallbackUsed: choice && choice.fallbackUsed === true,
        fallbackReason: String(choice && choice.fallbackReason || ""),
      });
    }
  }
  return candidates;
}

const ABYSSAL_NPC_COMPLETENESS_AUDIT_CACHE = new Map();

function auditEncounterNpcRuntimeCompleteness(encounterProfile = null) {
  const candidates = listEncounterNpcCandidates(encounterProfile);
  const results = [];
  for (const candidate of candidates) {
    const validation = getAbyssalNpcProfileValidationReport(
      candidate.profileID,
    );
    const typeID = candidate.typeID || toInteger(validation.typeID, 0);
    const declaredCapabilityIDs =
      validation.capabilityMappingMode === "profile_declared"
        ? validation.capabilities
        : undefined;
    const cacheKey = [
      candidate.profileID,
      typeID,
      validation.hardwareValidationStatus,
      validation.combatControllerSupported === true,
      validation.capabilityMappingMode,
      ...(Array.isArray(declaredCapabilityIDs) ? declaredCapabilityIDs : []),
    ].join(":");
    let runtimeAudit = ABYSSAL_NPC_COMPLETENESS_AUDIT_CACHE.get(cacheKey);
    if (!runtimeAudit && typeID > 0) {
      runtimeAudit = auditNpcRuntimeSupport(typeID, {
        ...(declaredCapabilityIDs === undefined
          ? {}
          : { declaredCapabilityIDs }),
        hardwareValidationStatus: validation.hardwareValidationStatus,
        combatControllerSupported: validation.combatControllerSupported,
      });
      ABYSSAL_NPC_COMPLETENESS_AUDIT_CACHE.set(cacheKey, runtimeAudit);
    }
    const unsupportedCapabilities = cloneValue(
      runtimeAudit && runtimeAudit.unsupportedCapabilities || [],
    );
    const unknownCapabilities = cloneValue(
      runtimeAudit && runtimeAudit.unknownCapabilities || [],
    );
    const profileMappingOmissions = cloneValue(
      runtimeAudit && runtimeAudit.profileOmissions || [],
    );
    const runtimeValid = Boolean(
      validation.validationStatus === "VALID" &&
      validation.admissionAllowed === true &&
      validation.safe === true &&
      typeID > 0 &&
      runtimeAudit &&
      runtimeAudit.status === "SUPPORTED" &&
      unsupportedCapabilities.length === 0 &&
      unknownCapabilities.length === 0 &&
      profileMappingOmissions.length === 0 &&
      runtimeAudit.hardwareValidationStatus === "VALID" &&
      runtimeAudit.combatControllerSupported === true
    );
    results.push({
      ...candidate,
      resolvedProfileID: validation.profileID,
      typeID,
      validationStatus: validation.validationStatus,
      admissionAllowed: validation.admissionAllowed === true,
      capabilityMappingMode: validation.capabilityMappingMode,
      hardwareValid: runtimeAudit
        ? runtimeAudit.hardwareValidationStatus === "VALID"
        : false,
      combatControllerSupported: runtimeAudit
        ? runtimeAudit.combatControllerSupported === true
        : false,
      runtimeSupportStatus: runtimeAudit
        ? String(runtimeAudit.status || "UNKNOWN")
        : "UNKNOWN",
      unsupportedCapabilities,
      unknownCapabilities,
      profileMappingOmissions,
      runtimeValid,
    });
  }
  const unknown = results.some((entry) =>
    entry.runtimeSupportStatus === "UNKNOWN" ||
    entry.unknownCapabilities.length > 0);
  const runtimeValid = results.length > 0 &&
    results.every((entry) => entry.runtimeValid === true);
  return {
    runtimeValid,
    completeness: results.length === 0
      ? ABYSSAL_CONTENT_COMPLETENESS_STATUS.MISSING
      : runtimeValid
        ? ABYSSAL_CONTENT_COMPLETENESS_STATUS.COMPLETE
        : unknown
          ? ABYSSAL_CONTENT_COMPLETENESS_STATUS.UNKNOWN
          : ABYSSAL_CONTENT_COMPLETENESS_STATUS.UNSUPPORTED,
    npcCount: results.length,
    results,
  };
}

module.exports = {
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
};
