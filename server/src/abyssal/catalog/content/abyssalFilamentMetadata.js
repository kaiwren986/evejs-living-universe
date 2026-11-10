"use strict";

function buildDEFAULTABYSSALTIMERDURATIONMSPart1(scope) {
  return 20 * 60 * 1000;
}

function buildTURRETWEAPONGROUPIDSPart2(scope) {
  return Object.freeze([53, 55, 74, 1986]);
}

function buildFILAMENTDEBUGFALLBACKTYPEIDPart3(scope) {
  return -1;
}

function buildDEFAULTREQUIREDFILAMENTSBYHULLMODEPart4(scope) {
  return Object.freeze({
  frigate: 3,
  destroyer: 2,
  cruiser: 1,
});
}

function buildDEFAULTMAXSHIPSBYHULLMODEPart5(scope) {
  return Object.freeze({
  frigate: 3,
  destroyer: 2,
  cruiser: 1,
});
}

function buildABYSSALTIERMETADATABYTIERPart6(scope) {
  return Object.freeze({
  0: {
    tier: 0,
    name: "Tranquil",
    penaltyBandKey: "trace",
    penaltyBandLabel: "Trace",
  },
  1: {
    tier: 1,
    name: "Calm",
    penaltyBandKey: "weak",
    penaltyBandLabel: "Weak",
  },
  2: {
    tier: 2,
    name: "Agitated",
    penaltyBandKey: "moderate",
    penaltyBandLabel: "Moderate",
  },
  3: {
    tier: 3,
    name: "Fierce",
    penaltyBandKey: "strong",
    penaltyBandLabel: "Strong",
  },
  4: {
    tier: 4,
    name: "Raging",
    penaltyBandKey: "severe",
    penaltyBandLabel: "Severe",
  },
  5: {
    tier: 5,
    name: "Chaotic",
    penaltyBandKey: "extreme",
    penaltyBandLabel: "Extreme",
  },
  6: {
    tier: 6,
    name: "Cataclysmic",
    penaltyBandKey: "cataclysmic",
    penaltyBandLabel: "Cataclysmic",
  },
});
}

function buildABYSSALWEATHERMETADATABYTYPEPart9(scope) {
  return {
    weatherType: "dark",
    weatherName: "Dark Matter Field",
    bonusText: "Massively boosts ship velocity.",
    penaltyText: "Reduces weapon ranges.",
    effectDescriptors: Object.freeze([
      Object.freeze({
        effectID: "max_velocity_bonus",
        effectType: "ship_attribute",
        appliesTo: Object.freeze(["player", "npc"]),
        attributeNames: Object.freeze(["maxVelocity"]),
        operation: "post_percent",
        strengthRole: "bonus",
      }),
      Object.freeze({
        effectID: "turret_optimal_penalty",
        effectType: "module_location_attribute",
        appliesTo: Object.freeze(["player", "npc"]),
        attributeNames: Object.freeze(["maxRange"]),
        operation: "post_percent",
        strengthRole: "penalty",
        groupIDs: scope.TURRET_WEAPON_GROUP_IDS,
      }),
      Object.freeze({
        effectID: "turret_falloff_penalty",
        effectType: "module_location_attribute",
        appliesTo: Object.freeze(["player", "npc"]),
        attributeNames: Object.freeze(["falloff"]),
        operation: "post_percent",
        strengthRole: "penalty",
        groupIDs: scope.TURRET_WEAPON_GROUP_IDS,
      }),
    ]),
  };
}

function buildABYSSALWEATHERMETADATABYTYPEPart10(scope) {
  return {
    weatherType: "electrical",
    weatherName: "Electrical Storm",
    bonusText: "Improves capacitor recharge.",
    penaltyText: "Weakens EM resistance.",
    effectDescriptors: Object.freeze([
      Object.freeze({
        effectID: "capacitor_recharge_bonus",
        effectType: "ship_attribute",
        appliesTo: Object.freeze(["player", "npc"]),
        attributeNames: Object.freeze(["capacitorRechargeRate"]),
        operation: "post_percent",
        strengthRole: "bonus_inverted",
      }),
      Object.freeze({
        effectID: "em_resist_penalty",
        effectType: "ship_attribute",
        appliesTo: Object.freeze(["player", "npc"]),
        attributeNames: Object.freeze([
          "shieldEmDamageResonance",
          "armorEmDamageResonance",
          "emDamageResonance",
        ]),
        operation: "post_percent",
        strengthRole: "penalty",
      }),
    ]),
  };
}

function buildABYSSALWEATHERMETADATABYTYPEPart11(scope) {
  return {
    weatherType: "exotic",
    weatherName: "Exotic Matter Storm",
    bonusText: "Improves scan resolution.",
    penaltyText: "Weakens kinetic resistance.",
    effectDescriptors: Object.freeze([
      Object.freeze({
        effectID: "scan_resolution_bonus",
        effectType: "ship_attribute",
        appliesTo: Object.freeze(["player", "npc"]),
        attributeNames: Object.freeze(["scanResolution"]),
        operation: "post_percent",
        strengthRole: "bonus",
      }),
      Object.freeze({
        effectID: "kinetic_resist_penalty",
        effectType: "ship_attribute",
        appliesTo: Object.freeze(["player", "npc"]),
        attributeNames: Object.freeze([
          "shieldKineticDamageResonance",
          "armorKineticDamageResonance",
          "kineticDamageResonance",
        ]),
        operation: "post_percent",
        strengthRole: "penalty",
      }),
    ]),
  };
}

function buildABYSSALWEATHERMETADATABYTYPEPart12(scope) {
  return {
    weatherType: "gamma",
    weatherName: "Gamma-Ray Storm",
    bonusText: "Boosts shield hitpoints.",
    penaltyText: "Weakens explosive resistance.",
    effectDescriptors: Object.freeze([
      Object.freeze({
        effectID: "shield_hp_bonus",
        effectType: "ship_attribute",
        appliesTo: Object.freeze(["player", "npc"]),
        attributeNames: Object.freeze(["shieldCapacity"]),
        operation: "post_percent",
        strengthRole: "bonus",
      }),
      Object.freeze({
        effectID: "explosive_resist_penalty",
        effectType: "ship_attribute",
        appliesTo: Object.freeze(["player", "npc"]),
        attributeNames: Object.freeze([
          "shieldExplosiveDamageResonance",
          "armorExplosiveDamageResonance",
          "explosiveDamageResonance",
        ]),
        operation: "post_percent",
        strengthRole: "penalty",
      }),
    ]),
  };
}

function buildABYSSALWEATHERMETADATABYTYPEPart13(scope) {
  return {
    weatherType: "firestorm",
    weatherName: "Plasma Firestorm",
    bonusText: "Boosts armor hitpoints.",
    penaltyText: "Weakens thermal resistance.",
    effectDescriptors: Object.freeze([
      Object.freeze({
        effectID: "armor_hp_bonus",
        effectType: "ship_attribute",
        appliesTo: Object.freeze(["player", "npc"]),
        attributeNames: Object.freeze(["armorHP"]),
        operation: "post_percent",
        strengthRole: "bonus",
      }),
      Object.freeze({
        effectID: "thermal_resist_penalty",
        effectType: "ship_attribute",
        appliesTo: Object.freeze(["player", "npc"]),
        attributeNames: Object.freeze([
          "shieldThermalDamageResonance",
          "armorThermalDamageResonance",
          "thermalDamageResonance",
        ]),
        operation: "post_percent",
        strengthRole: "penalty",
      }),
    ]),
  };
}

function buildABYSSALWEATHERMETADATABYTYPEPart14(scope) {
  return {
    weatherType: "unknown",
    weatherName: "Unknown Abyssal Weather",
    bonusText: "No authored weather bonus text is available yet.",
    penaltyText: "No authored weather penalty text is available yet.",
    effectDescriptors: Object.freeze([]),
  };
}

function buildABYSSALWEATHERMETADATABYTYPEPart8(scope) {
  return {
  dark: buildABYSSALWEATHERMETADATABYTYPEPart9(scope),
  electrical: buildABYSSALWEATHERMETADATABYTYPEPart10(scope),
  exotic: buildABYSSALWEATHERMETADATABYTYPEPart11(scope),
  gamma: buildABYSSALWEATHERMETADATABYTYPEPart12(scope),
  firestorm: buildABYSSALWEATHERMETADATABYTYPEPart13(scope),
  unknown: buildABYSSALWEATHERMETADATABYTYPEPart14(scope),
};
}

function buildABYSSALWEATHERMETADATABYTYPEPart7(scope) {
  return Object.freeze(buildABYSSALWEATHERMETADATABYTYPEPart8(scope));
}

function buildT0DARKALLOWEDWEATHERSTAGESPart15(scope) {
  return (0, scope.listAllowedDarkWeatherStagesForTier)(0);
}

function buildT0DARKALLOWEDWEATHERDEFINITIONSPart16(scope) {
  return scope.T0_DARK_ALLOWED_WEATHER_STAGES
  .map((stage) => (0, scope.getDarkWeatherStage)(stage));
}

function buildT0DARKWEATHERSTAGEWEIGHTSPart17(scope) {
  return (0, scope.listDarkWeatherStageWeightsForTier)(0);
}

function initializeAbyssalFilamentMetadata(scope) {
  scope.DEFAULT_ABYSSAL_TIMER_DURATION_MS = buildDEFAULTABYSSALTIMERDURATIONMSPart1(scope);
  scope.TURRET_WEAPON_GROUP_IDS = buildTURRETWEAPONGROUPIDSPart2(scope);
  scope.FILAMENT_DEBUG_FALLBACK_TYPE_ID = buildFILAMENTDEBUGFALLBACKTYPEIDPart3(scope);
  scope.DEFAULT_REQUIRED_FILAMENTS_BY_HULL_MODE = buildDEFAULTREQUIREDFILAMENTSBYHULLMODEPart4(scope);
  scope.DEFAULT_MAX_SHIPS_BY_HULL_MODE = buildDEFAULTMAXSHIPSBYHULLMODEPart5(scope);
  scope.ABYSSAL_TIER_METADATA_BY_TIER = buildABYSSALTIERMETADATABYTIERPart6(scope);
  scope.ABYSSAL_WEATHER_METADATA_BY_TYPE = buildABYSSALWEATHERMETADATABYTYPEPart7(scope);
  scope.T0_DARK_ALLOWED_WEATHER_STAGES = buildT0DARKALLOWEDWEATHERSTAGESPart15(scope);
  scope.T0_DARK_ALLOWED_WEATHER_DEFINITIONS = buildT0DARKALLOWEDWEATHERDEFINITIONSPart16(scope);
  scope.T0_DARK_WEATHER_STAGE_WEIGHTS = buildT0DARKWEATHERSTAGEWEIGHTSPart17(scope);
}

function validateObservedAbyssalNpcSpawnCoverageOperation(scope, definition = null) {
  return scope.ABYSSAL_ENCOUNTER_RESOLVER.validateObservedAbyssalNpcSpawnCoverage({
    tier: definition && definition.tier,
    weatherType: definition && definition.weatherType,
    implementedRooms:
      definition && definition.roomProfile &&
        definition.roomProfile.implementedRooms,
  });
}

function shouldUseTier0AbyssalSpaceEmpiricalContentOperation(scope, contentProfile = null) {
  const profile = contentProfile || {};
  if (
    (0, scope.toInteger)(profile.tier, -1) !== 0 ||
    profile.tier0AbyssalSpaceTelemetryEnabled !== true
  ) {
    return false;
  }
  if (!String(profile.authoredCaptureID || "").trim()) {
    return true;
  }
  return scope.T0_TRANQUIL_FILAMENT_TYPE_IDS.includes(
    (0, scope.toInteger)(profile.filamentTypeID, 0),
  );
}

function shouldUseTier1AbyssalSpaceEmpiricalContentOperation(scope, contentProfile = null) {
  const profile = contentProfile || {};
  return (
    (0, scope.toInteger)(profile.tier, -1) === 1 &&
    profile.tier1AbyssalSpaceTelemetryEnabled === true
  );
}

function shouldUseTier2AbyssalSpaceEmpiricalContentOperation(scope, contentProfile = null) {
  const profile = contentProfile || {};
  return (
    (0, scope.toInteger)(profile.tier, -1) === 2 &&
    profile.tier2AbyssalSpaceTelemetryEnabled === true
  );
}

function shouldUseTier3AbyssalSpaceEmpiricalContentOperation(scope, contentProfile = null) {
  const profile = contentProfile || {};
  return (
    (0, scope.toInteger)(profile.tier, -1) === 3 &&
    profile.tier3AbyssalSpaceTelemetryEnabled === true
  );
}

function shouldUseTier4AbyssalSpaceEmpiricalContentOperation(scope, contentProfile = null) {
  const profile = contentProfile || {};
  return (
    (0, scope.toInteger)(profile.tier, -1) === 4 &&
    profile.tier4AbyssalSpaceTelemetryEnabled === true
  );
}

function shouldUseTier5AbyssalSpaceEmpiricalContentOperation(scope, contentProfile = null) {
  const profile = contentProfile || {};
  return (
    (0, scope.toInteger)(profile.tier, -1) === 5 &&
    profile.tier5AbyssalSpaceTelemetryEnabled === true
  );
}

function shouldUseTier6AbyssalSpaceEmpiricalContentOperation(scope, contentProfile = null) {
  const profile = contentProfile || {};
  return (
    (0, scope.toInteger)(profile.tier, -1) === 6 &&
    profile.tier6AbyssalSpaceTelemetryEnabled === true
  );
}

function shouldUseCorrelatedAbyssalSpaceEmpiricalContentOperation(scope, contentProfile = null) {
  return (
    (0, scope.shouldUseTier0AbyssalSpaceEmpiricalContent)(contentProfile) ||
    (0, scope.shouldUseTier1AbyssalSpaceEmpiricalContent)(contentProfile) ||
    (0, scope.shouldUseTier2AbyssalSpaceEmpiricalContent)(contentProfile) ||
    (0, scope.shouldUseTier3AbyssalSpaceEmpiricalContent)(contentProfile) ||
    (0, scope.shouldUseTier4AbyssalSpaceEmpiricalContent)(contentProfile) ||
    (0, scope.shouldUseTier5AbyssalSpaceEmpiricalContent)(contentProfile) ||
    (0, scope.shouldUseTier6AbyssalSpaceEmpiricalContent)(contentProfile)
  );
}

function buildAuthoredRoomEncounterProfilesOperation(scope, capture = null) {
  return (0, scope.buildCapturedRoomEncounterProfiles)(capture);
}

function applyAuthoredCaptureToDefinitionOperation(scope, definition, selection) {
  const capture = selection && selection.capture;
  if (!capture) return definition;
  const reusesExistingRegistration =
    capture.existingRegistration &&
    capture.existingRegistration.reused === true;
  return {
    ...definition,
    environmentLayoutVariant: reusesExistingRegistration
      ? definition.environmentLayoutVariant
      : String(capture.layoutVariant || ""),
    roomEncounterProfilesByIndex: reusesExistingRegistration
      ? definition.roomEncounterProfilesByIndex
      : (0, scope.buildAuthoredRoomEncounterProfiles)(capture),
    authoredCaptureID: String(capture.captureID || ""),
    authoredCaptureKey: String(capture.captureKey || ""),
    authoredWeatherBallTypeID: (0, scope.toInteger)(capture.weatherBallTypeID, 0),
    authoredWeatherEffectTypeID: (0, scope.toInteger)(capture.weatherEffectTypeID, 0),
    authoredEnvironmentTemplateID: (0, scope.toInteger)(capture.environmentTemplateID, 0),
    authoredRoomIDs: Object.fromEntries(
      (Array.isArray(capture.rooms) ? capture.rooms : []).map((room) => [
        String((0, scope.toInteger)(room && room.roomNumber, 0)),
        String(room && room.roomID || ""),
      ]),
    ),
    authoredContentSelection: {
      selected: true,
      fallbackUsed: false,
      captureID: String(capture.captureID || ""),
      captureKey: String(capture.captureKey || ""),
      selectionPolicy: String(selection.selectionPolicy || ""),
      selectionSeed: String(selection.selectionSeed || ""),
      eligibleCaptureIDs: (0, scope.cloneValue)(selection.eligibleCaptureIDs || []),
      runtimeReady: capture.runtimeReadiness &&
        capture.runtimeReadiness.runtimeReady === true,
      weightingAuthority: String(capture.selectionWeightAuthority || ""),
    },
  };
}

function buildTierMetadataOperation(scope, tier, overrides = {}) {
  const normalizedTier = Math.max(0, Math.min(6, (0, scope.toInteger)(tier, 1)));
  const base = scope.ABYSSAL_TIER_METADATA_BY_TIER[normalizedTier] ||
    scope.ABYSSAL_TIER_METADATA_BY_TIER[1];
  return {
    ...(0, scope.cloneValue)(base),
    ...(0, scope.cloneValue)(overrides),
    tier: normalizedTier,
    name: String(overrides.name || base.name || ""),
    penaltyBandKey: String(overrides.penaltyBandKey || base.penaltyBandKey || ""),
    penaltyBandLabel: String(overrides.penaltyBandLabel || base.penaltyBandLabel || ""),
  };
}

function buildWeatherProfileOperation(scope, weatherType, overrides = {}) {
  const normalizedWeatherType = String(weatherType || "").trim().toLowerCase() || "unknown";
  const base = scope.ABYSSAL_WEATHER_METADATA_BY_TYPE[normalizedWeatherType] ||
    scope.ABYSSAL_WEATHER_METADATA_BY_TYPE.unknown;
  return {
    weatherType: normalizedWeatherType,
    weatherName: String(overrides.weatherName || base.weatherName || ""),
    bonusText: String(overrides.bonusText || base.bonusText || ""),
    penaltyText: String(overrides.penaltyText || base.penaltyText || ""),
    penaltyBandKey: String(overrides.penaltyBandKey || ""),
    penaltyBandLabel: String(overrides.penaltyBandLabel || ""),
    weatherEffectsApplied: overrides.weatherEffectsApplied === true,
    effectDescriptors: Array.isArray(overrides.effectDescriptors)
      ? (0, scope.cloneValue)(overrides.effectDescriptors)
      : (0, scope.cloneValue)(base.effectDescriptors || []),
    evidenceRefs: (0, scope.normalizeStringArray)(overrides.evidenceRefs),
    authorityFacets:
      overrides.authorityFacets && typeof overrides.authorityFacets === "object"
        ? (0, scope.cloneValue)(overrides.authorityFacets)
        : {},
    contentAuthority: (0, scope.validateAbyssalContentAuthority)(
      overrides.contentAuthority || (
        ["unknown", "debug"].includes(normalizedWeatherType)
          ? scope.ABYSSAL_CONTENT_AUTHORITY.DEBUG_PLACEHOLDER
          : scope.ABYSSAL_CONTENT_AUTHORITY.PROVISIONAL
      ),
      `Abyssal weather profile ${normalizedWeatherType}`,
    ),
  };
}

function buildAuthoredFilamentDefinitionOperation(scope, overrides = {}) {

  const rawDefinition = {
    definitionID: "abyssal:placeholder",
    filamentTypeID: 0,
    filamentName: "",
    tier: 1,
    weatherType: "",
    weatherName: "",
    allowedHullModes: ["frigate", "destroyer", "cruiser"],
    requiredFilamentsByHullMode: (0, scope.cloneValue)(
      scope.DEFAULT_REQUIRED_FILAMENTS_BY_HULL_MODE,
    ),
    maxShipsByHullMode: (0, scope.cloneValue)(scope.DEFAULT_MAX_SHIPS_BY_HULL_MODE),
    timerDurationMs: scope.DEFAULT_ABYSSAL_TIMER_DURATION_MS,
    contentCompletenessPolicy: scope.ABYSSAL_CONTENT_COMPLETENESS_POLICY.SUPPORTED,
    declaredCompletenessLevel: null,
    definitionContentAuthority: scope.ABYSSAL_CONTENT_AUTHORITY.PROJECT_AUTHORED,
    timerPolicyAuthority: scope.ABYSSAL_CONTENT_AUTHORITY.PROVISIONAL,
    timeoutPolicyAuthority: scope.ABYSSAL_CONTENT_AUTHORITY.PROJECT_AUTHORED,
    objectivePolicyAuthority: scope.ABYSSAL_CONTENT_AUTHORITY.PROJECT_AUTHORED,
    conduitPolicyAuthority: scope.ABYSSAL_CONTENT_AUTHORITY.PROJECT_AUTHORED,
    cachePolicyAuthority: scope.ABYSSAL_CONTENT_AUTHORITY.PROJECT_AUTHORED,
    roomProfile: (0, scope.buildPlaceholderRoomProfile)({
      contentAuthority: scope.ABYSSAL_CONTENT_AUTHORITY.PROVISIONAL,
    }),
    extractionNodeProfile: (0, scope.buildPlaceholderExtractionNodeProfile)(),
    cacheProfile: (0, scope.buildPlaceholderCacheProfile)(),
    npcProfile: (0, scope.buildPlaceholderNpcProfile)(),
    rewardProfile: (0, scope.buildPlaceholderRewardProfile)(),
    roomEncounterProfilesByIndex: null,
    retailNotes: [
      "Retail weather, encounter, and loot parity varies by tier; captured T0 Dark data has the strongest evidence.",
    ],
    implementationLimits: [
      "EveJS runs three-room, run-isolated Abyssal scenes with persisted recovery state.",
      "Eligible frigate and destroyer fleet members can independently enter one shared run; cruiser entry remains solo.",
      "Multiplayer admission, ownership, survivor, disconnect, finalization, and recovery semantics are project-authored EveJS policy unless separately evidence-backed.",
      "Encounter and reward parity outside captured T0 Dark evidence remains conservative.",
    ],
    placeholderNotes: [
      "Three-room progression uses isolated scene and dungeon-instance authority.",
      "Dark weather selects the tier-appropriate 30/50/70 percent penalty per run and always applies the 50 percent maximum-velocity bonus.",
      "Reward loot is deterministic placeholder loot, not a retail loot table.",
      "Timeout is lethal and suppresses rewards before canonical ship-and-capsule destruction.",
    ],
    ...(0, scope.cloneValue)(overrides),
  };

  const tierMetadata = (0, scope.buildTierMetadata)(
    rawDefinition.tier,
    rawDefinition.tierMetadata,
  );

  if (!String(rawDefinition.declaredCompletenessLevel || "").trim()) {
    const error = new TypeError(
      "ABYSSAL_COMPLETENESS_DECLARATION_MISSING " +
      `definitionID=${String(rawDefinition.definitionID || "unknown")} ` +
      `typeID=${(0, scope.toInteger)(rawDefinition.filamentTypeID, 0)}`,
    );
    error.code = "ABYSSAL_COMPLETENESS_DECLARATION_MISSING";
    throw error;
  }

  const weatherProfile = (0, scope.buildWeatherProfile)(rawDefinition.weatherType, {
    ...([1, 2, 3, 4, 5, 6].includes(tierMetadata.tier)
      ? (0, scope.cloneValue)((0, scope.buildEmpiricalBaselineWeatherProfile)(
        tierMetadata.tier,
        rawDefinition.weatherType,
      ))
      : {}),
    ...(0, scope.cloneValue)(rawDefinition.weatherProfile),
    weatherName: rawDefinition.weatherName,
    penaltyBandKey:
      rawDefinition.weatherProfile &&
        rawDefinition.weatherProfile.penaltyBandKey ||
      tierMetadata.penaltyBandKey,
    penaltyBandLabel:
      rawDefinition.weatherProfile &&
        rawDefinition.weatherProfile.penaltyBandLabel ||
      tierMetadata.penaltyBandLabel,
  });
    return (0, scope.materializeAuthoredFilamentDefinition)({
      overrides,
      rawDefinition,
      tierMetadata,
      weatherProfile,
    });
  }

function materializeAuthoredFilamentDefinitionOperation(scope, attempt) {
    const {
      rawDefinition, tierMetadata, weatherProfile,
    } = attempt;
return {
    ...rawDefinition,
    contentCompletenessPolicy: (0, scope.validateAbyssalContentCompletenessPolicy)(
      rawDefinition.contentCompletenessPolicy,
      `Abyssal filament definition ${rawDefinition.definitionID}`,
    ),
    declaredCompletenessLevel: (0, scope.validateAbyssalContentCompletenessLevel)(
      rawDefinition.declaredCompletenessLevel,
      `Abyssal filament definition ${rawDefinition.definitionID}`,
    ),
    definitionContentAuthority: (0, scope.validateAbyssalContentAuthority)(
      rawDefinition.definitionContentAuthority,
      `Abyssal filament definition ${rawDefinition.definitionID}`,
    ),
    timerPolicyAuthority: (0, scope.validateAbyssalContentAuthority)(
      [1, 2, 3, 4, 5, 6].includes(tierMetadata.tier)
        ? scope.ABYSSAL_CONTENT_AUTHORITY.PROJECT_AUTHORED
        : rawDefinition.timerPolicyAuthority,
      `Abyssal timer policy ${rawDefinition.definitionID}`,
    ),
    timeoutPolicyAuthority: (0, scope.validateAbyssalContentAuthority)(
      rawDefinition.timeoutPolicyAuthority,
      `Abyssal timeout policy ${rawDefinition.definitionID}`,
    ),
    objectivePolicyAuthority: (0, scope.validateAbyssalContentAuthority)(
      rawDefinition.objectivePolicyAuthority,
      `Abyssal objective policy ${rawDefinition.definitionID}`,
    ),
    conduitPolicyAuthority: (0, scope.validateAbyssalContentAuthority)(
      rawDefinition.conduitPolicyAuthority,
      `Abyssal conduit policy ${rawDefinition.definitionID}`,
    ),
    cachePolicyAuthority: (0, scope.validateAbyssalContentAuthority)(
      rawDefinition.cachePolicyAuthority,
      `Abyssal cache policy ${rawDefinition.definitionID}`,
    ),
    tier: tierMetadata.tier,
    tier0AbyssalSpaceTelemetryEnabled: tierMetadata.tier === 0,
    tier0AbyssalSpaceTelemetryCatalogueID:
      tierMetadata.tier === 0 ? scope.ABYSSAL_SPACE_TIER0_CATALOGUE_ID : "",
    tier1AbyssalSpaceTelemetryEnabled: tierMetadata.tier === 1,
    tier1AbyssalSpaceTelemetryCatalogueID:
      tierMetadata.tier === 1 ? scope.ABYSSAL_SPACE_TIER1_CATALOGUE_ID : "",
    tier2AbyssalSpaceTelemetryEnabled: tierMetadata.tier === 2,
    tier2AbyssalSpaceTelemetryCatalogueID:
      tierMetadata.tier === 2 ? scope.ABYSSAL_SPACE_TIER2_CATALOGUE_ID : "",
    tier3AbyssalSpaceTelemetryEnabled: tierMetadata.tier === 3,
    tier3AbyssalSpaceTelemetryCatalogueID:
      tierMetadata.tier === 3 ? scope.ABYSSAL_SPACE_TIER3_CATALOGUE_ID : "",
    tier4AbyssalSpaceTelemetryEnabled: tierMetadata.tier === 4,
    tier4AbyssalSpaceTelemetryCatalogueID:
      tierMetadata.tier === 4 ? scope.ABYSSAL_SPACE_TIER4_CATALOGUE_ID : "",
    tier5AbyssalSpaceTelemetryEnabled: tierMetadata.tier === 5,
    tier5AbyssalSpaceTelemetryCatalogueID:
      tierMetadata.tier === 5 ? scope.ABYSSAL_SPACE_TIER5_CATALOGUE_ID : "",
    tier6AbyssalSpaceTelemetryEnabled: tierMetadata.tier === 6,
    tier6AbyssalSpaceTelemetryCatalogueID:
      tierMetadata.tier === 6 ? scope.ABYSSAL_SPACE_TIER6_CATALOGUE_ID : "",
    tierName: tierMetadata.name,
    tierMetadata,
    weatherType: weatherProfile.weatherType,
    weatherName: weatherProfile.weatherName,
    weatherProfile,
    traceProfileID: String(
      rawDefinition.traceProfileID ||
        scope.SHARED_ABYSSAL_ENTRANCE_TRACE_PROFILE_ID,
    ).trim(),
    requiredFilamentsByHullMode: (0, scope.cloneValue)(
      rawDefinition.requiredFilamentsByHullMode,
    ),
    maxShipsByHullMode: (0, scope.cloneValue)(rawDefinition.maxShipsByHullMode),
    roomProfile: (0, scope.buildPlaceholderRoomProfile)(rawDefinition.roomProfile),
    extractionNodeProfile: (0, scope.buildPlaceholderExtractionNodeProfile)(
      rawDefinition.extractionNodeProfile,
    ),
    cacheProfile: (0, scope.buildPlaceholderCacheProfile)(rawDefinition.cacheProfile),
    npcProfile: (0, scope.buildPlaceholderNpcProfile)(rawDefinition.npcProfile),
    rewardProfile: [1, 2, 3, 4, 5, 6].includes(tierMetadata.tier)
      ? (0, scope.cloneValue)(
        (tierMetadata.tier === 1
          ? scope.ABYSSAL_SPACE_TIER1_REWARD_PROFILE_BY_WEATHER
          : tierMetadata.tier === 2
            ? scope.ABYSSAL_SPACE_TIER2_REWARD_PROFILE_BY_WEATHER
            : tierMetadata.tier === 3
              ? scope.ABYSSAL_SPACE_TIER3_REWARD_PROFILE_BY_WEATHER
              : tierMetadata.tier === 4
                ? scope.ABYSSAL_SPACE_TIER4_REWARD_PROFILE_BY_WEATHER
                : tierMetadata.tier === 5
                  ? scope.ABYSSAL_SPACE_TIER5_REWARD_PROFILE_BY_WEATHER
                  : scope.ABYSSAL_SPACE_TIER6_REWARD_PROFILE_BY_WEATHER)[
          weatherProfile.weatherType
        ],
      )
      : (0, scope.buildPlaceholderRewardProfile)(rawDefinition.rewardProfile),
    roomEncounterProfilesByIndex: Object.fromEntries(
      Object.entries(
        rawDefinition.roomEncounterProfilesByIndex &&
          typeof rawDefinition.roomEncounterProfilesByIndex === "object"
          ? rawDefinition.roomEncounterProfilesByIndex
          : (0, scope.buildPlaceholderRoomEncounterProfilesForDefinition)(rawDefinition),
      ).map(([roomIndex, profile]) => [
        String(roomIndex),
        (0, scope.buildPlaceholderRoomEncounterProfile)({
          roomIndex: (0, scope.toInteger)(roomIndex, profile && profile.roomIndex),
          ...(0, scope.cloneValue)(profile),
        }),
      ]),
    ),
    retailNotes: (0, scope.normalizeStringArray)(rawDefinition.retailNotes),
    implementationLimits: (0, scope.normalizeStringArray)(
      rawDefinition.implementationLimits,
    ),
    placeholderNotes: (0, scope.normalizeStringArray)(rawDefinition.placeholderNotes),
  };
  }

function buildProductionAbyssalFilamentDefinitionOperation(scope,
  declaredCompletenessLevel,
  overrides = {},
) {
  return (0, scope.buildAuthoredFilamentDefinition)({
    ...(0, scope.cloneValue)(overrides),
    declaredCompletenessLevel,
  });
}

function buildT0TranquilWeatherProfileOperation(scope, weatherType) {
  const presentations = (0, scope.listT0TranquilWeatherPresentationStages)(weatherType)
    .filter((entry) => scope.T0_DARK_ALLOWED_WEATHER_STAGES.includes(entry.stage));
  return {
    contentAuthority: scope.ABYSSAL_CONTENT_AUTHORITY.PROJECT_AUTHORED,
    evidenceRefs: [
      "server/src/services/activity/abyssalContentManagerService.js:ABYSSAL_WEATHER_METADATA_BY_TYPE",
      "server/src/services/activity/abyssalMgrService.js:resolveAbyssalWeatherStrengthSelection",
      "server/tests/abyssalWeatherStrengthSelection.test.js",
      "server/tests/abyssalWeatherScope.test.js",
    ],
    authorityFacets: {
      mechanicsContract: {
        profileID: `abyssal:weather:${weatherType}:t0-mechanics-contract-v1`,
        contentAuthority: scope.ABYSSAL_CONTENT_AUTHORITY.PROJECT_AUTHORED,
        bonusStrengthPercent: 50,
        effectModel: `${weatherType}-weather-runtime-modifiers`,
        evidenceRefs: [
          "server/src/services/activity/abyssalContentManagerService.js:ABYSSAL_WEATHER_METADATA_BY_TYPE",
          "server/tests/abyssalWeatherScope.test.js",
        ],
      },
      presentation: {
        profileID: `abyssal:weather:${weatherType}:t0-presentation-v1`,
        contentAuthority: presentations.every((entry) =>
          entry.evidence === scope.ENVIRONMENTAL_EVIDENCE.RETAIL_CONFIRMED
        )
          ? scope.ABYSSAL_CONTENT_AUTHORITY.CAPTURED_RETAIL
          : scope.ABYSSAL_CONTENT_AUTHORITY.PROJECT_AUTHORED,
        weatherObjectTypeIDs: presentations.map((entry) => entry.typeID),
        evidenceByTypeID: Object.fromEntries(
          presentations.map((entry) => [String(entry.typeID), entry.evidence]),
        ),
      },
      stageSelection: {
        profileID: `abyssal:weather:${weatherType}:t0-stage-selection-v1`,
        contentAuthority: scope.ABYSSAL_CONTENT_AUTHORITY.PROJECT_AUTHORED,
        allowedStages: (0, scope.cloneValue)(scope.T0_DARK_ALLOWED_WEATHER_STAGES),
        allowedWeatherObjectTypeIDs: presentations.map((entry) => entry.typeID),
        penaltyStrengthPercents: scope.T0_DARK_ALLOWED_WEATHER_STAGES
          .map((stage) => 10 + (20 * stage)),
        uncapturedWeatherObjectTypeIDs: presentations
          .filter((entry) => entry.evidence !== scope.ENVIRONMENTAL_EVIDENCE.RETAIL_CONFIRMED)
          .map((entry) => entry.typeID),
        selectionScope: "per-run",
        evidenceRefs: [
          "server/tests/abyssalWeatherStrengthSelection.test.js",
          "server/src/space/abyssal/abyssalEnvironmentalCatalog.js",
        ],
      },
      stageSelectionWeights: {
        profileID: `abyssal:weather:${weatherType}:t0-stage-selection-weights-v1`,
        contentAuthority: scope.ABYSSAL_CONTENT_AUTHORITY.PROVISIONAL,
        weights: (0, scope.cloneValue)(scope.T0_DARK_WEATHER_STAGE_WEIGHTS),
        selectionModel: "deterministic-per-run-weighted",
        exactRetailProbabilityDistributionVerified: false,
        evidenceRefs: [
          "server/tests/abyssalWeatherStrengthSelection.test.js",
        ],
      },
    },
  };
}

function buildEmpiricalBaselineWeatherProfileOperation(scope, tier, weatherType) {
  const allowedStages = (0, scope.listAllowedDarkWeatherStagesForTier)(tier);
  const weatherStageWeights = (0, scope.listDarkWeatherStageWeightsForTier)(tier);
  const presentations = (0, scope.listT0TranquilWeatherPresentationStages)(weatherType)
    .filter((entry) => allowedStages.includes(entry.stage));
  return {
    contentAuthority: scope.ABYSSAL_CONTENT_AUTHORITY.PROJECT_AUTHORED,
    evidenceRefs: [
      "server/src/services/activity/abyssalMgrService.js:resolveAbyssalWeatherStrengthSelection",
      "server/tests/abyssalWeatherStrengthSelection.test.js",
      "server/tests/abyssalWeatherScope.test.js",
    ],
    authorityFacets: {
      mechanicsContract: {
        profileID: `abyssal:weather:${weatherType}:t${tier}-mechanics-contract-v1`,
        contentAuthority: scope.ABYSSAL_CONTENT_AUTHORITY.PROJECT_AUTHORED,
        bonusStrengthPercent: 50,
        effectModel: `${weatherType}-weather-runtime-modifiers`,
      },
      presentation: {
        profileID: `abyssal:weather:${weatherType}:t${tier}-presentation-v1`,
        contentAuthority: scope.ABYSSAL_CONTENT_AUTHORITY.PROJECT_AUTHORED,
        weatherObjectTypeIDs: presentations.map((entry) => entry.typeID),
        identityAuthority: "project-authored-from-supported-weather-stage-family",
      },
      stageSelection: {
        profileID: `abyssal:weather:${weatherType}:t${tier}-stage-selection-v1`,
        contentAuthority: scope.ABYSSAL_CONTENT_AUTHORITY.PROJECT_AUTHORED,
        allowedStages: (0, scope.cloneValue)(allowedStages),
        allowedWeatherObjectTypeIDs: presentations.map((entry) => entry.typeID),
        penaltyStrengthPercents: allowedStages
          .map((stage) => 10 + (20 * stage)),
        selectionScope: "per-run-persisted",
      },
      stageSelectionWeights: {
        profileID: `abyssal:weather:${weatherType}:t${tier}-stage-selection-weights-v1`,
        contentAuthority: scope.ABYSSAL_CONTENT_AUTHORITY.PROVISIONAL,
        weights: (0, scope.cloneValue)(weatherStageWeights),
        selectionModel: "deterministic-per-run-weighted",
        exactRetailProbabilityDistributionVerified: false,
      },
    },
  };
}

function bindAbyssalFilamentMetadataOperations(scope) {
  scope.validateObservedAbyssalNpcSpawnCoverage = function validateObservedAbyssalNpcSpawnCoverage(definition = null) {
    return validateObservedAbyssalNpcSpawnCoverageOperation(scope, definition);
  };
  scope.shouldUseTier0AbyssalSpaceEmpiricalContent = function shouldUseTier0AbyssalSpaceEmpiricalContent(contentProfile = null) {
    return shouldUseTier0AbyssalSpaceEmpiricalContentOperation(scope, contentProfile);
  };
  scope.shouldUseTier1AbyssalSpaceEmpiricalContent = function shouldUseTier1AbyssalSpaceEmpiricalContent(contentProfile = null) {
    return shouldUseTier1AbyssalSpaceEmpiricalContentOperation(scope, contentProfile);
  };
  scope.shouldUseTier2AbyssalSpaceEmpiricalContent = function shouldUseTier2AbyssalSpaceEmpiricalContent(contentProfile = null) {
    return shouldUseTier2AbyssalSpaceEmpiricalContentOperation(scope, contentProfile);
  };
  scope.shouldUseTier3AbyssalSpaceEmpiricalContent = function shouldUseTier3AbyssalSpaceEmpiricalContent(contentProfile = null) {
    return shouldUseTier3AbyssalSpaceEmpiricalContentOperation(scope, contentProfile);
  };
  scope.shouldUseTier4AbyssalSpaceEmpiricalContent = function shouldUseTier4AbyssalSpaceEmpiricalContent(contentProfile = null) {
    return shouldUseTier4AbyssalSpaceEmpiricalContentOperation(scope, contentProfile);
  };
  scope.shouldUseTier5AbyssalSpaceEmpiricalContent = function shouldUseTier5AbyssalSpaceEmpiricalContent(contentProfile = null) {
    return shouldUseTier5AbyssalSpaceEmpiricalContentOperation(scope, contentProfile);
  };
  scope.shouldUseTier6AbyssalSpaceEmpiricalContent = function shouldUseTier6AbyssalSpaceEmpiricalContent(contentProfile = null) {
    return shouldUseTier6AbyssalSpaceEmpiricalContentOperation(scope, contentProfile);
  };
  scope.shouldUseCorrelatedAbyssalSpaceEmpiricalContent = function shouldUseCorrelatedAbyssalSpaceEmpiricalContent(contentProfile = null) {
    return shouldUseCorrelatedAbyssalSpaceEmpiricalContentOperation(scope, contentProfile);
  };
  scope.buildAuthoredRoomEncounterProfiles = function buildAuthoredRoomEncounterProfiles(capture = null) {
    return buildAuthoredRoomEncounterProfilesOperation(scope, capture);
  };
  scope.applyAuthoredCaptureToDefinition = function applyAuthoredCaptureToDefinition(definition, selection) {
    return applyAuthoredCaptureToDefinitionOperation(scope, definition, selection);
  };
  scope.buildTierMetadata = function buildTierMetadata(tier, overrides = {}) {
    return buildTierMetadataOperation(scope, tier, overrides);
  };
  scope.buildWeatherProfile = function buildWeatherProfile(weatherType, overrides = {}) {
    return buildWeatherProfileOperation(scope, weatherType, overrides);
  };
  scope.buildAuthoredFilamentDefinition = function buildAuthoredFilamentDefinition(overrides = {}) {
    return buildAuthoredFilamentDefinitionOperation(scope, overrides);
  };
  scope.materializeAuthoredFilamentDefinition = function materializeAuthoredFilamentDefinition(attempt) {
    return materializeAuthoredFilamentDefinitionOperation(scope, attempt);
  };
  scope.buildProductionAbyssalFilamentDefinition = function buildProductionAbyssalFilamentDefinition(declaredCompletenessLevel,
  overrides = {}) {
    return buildProductionAbyssalFilamentDefinitionOperation(scope, declaredCompletenessLevel, overrides);
  };
  scope.buildT0TranquilWeatherProfile = function buildT0TranquilWeatherProfile(weatherType) {
    return buildT0TranquilWeatherProfileOperation(scope, weatherType);
  };
  scope.buildEmpiricalBaselineWeatherProfile = function buildEmpiricalBaselineWeatherProfile(tier, weatherType) {
    return buildEmpiricalBaselineWeatherProfileOperation(scope, tier, weatherType);
  };
}

module.exports = {
  bindAbyssalFilamentMetadataOperations,
  initializeAbyssalFilamentMetadata,
};
