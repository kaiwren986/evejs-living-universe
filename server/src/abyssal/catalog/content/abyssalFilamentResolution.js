"use strict";

function buildResolvedContentGovernanceOperation(scope, definition, options = {}) {

  const policy = (0, scope.validateAbyssalContentCompletenessPolicy)(
    definition && definition.contentCompletenessPolicy ||
      scope.ABYSSAL_CONTENT_COMPLETENESS_POLICY.DEVELOPMENT,
    `Abyssal filament definition ${String(
      definition && definition.definitionID || "unknown",
    )}`,
  );
  const tier = Math.max(0, (0, scope.toInteger)(definition && definition.tier, 0));
  const weatherType = String(definition && definition.weatherType || "").toLowerCase();
  const filamentTypeID = (0, scope.toInteger)(definition && definition.filamentTypeID, 0);
  const t0Dark = filamentTypeID === scope.T0_DARK_FILAMENT_TYPE_ID;
  const t0Tranquil = scope.T0_TRANQUIL_FILAMENT_TYPE_IDS.includes(filamentTypeID);
  const tier1Calm = tier === 1 &&
    (0, scope.shouldUseTier1AbyssalSpaceEmpiricalContent)(definition);
  const tier2Agitated = tier === 2 &&
    (0, scope.shouldUseTier2AbyssalSpaceEmpiricalContent)(definition);
  const tier3Fierce = tier === 3 &&
    (0, scope.shouldUseTier3AbyssalSpaceEmpiricalContent)(definition);
  const tier4Raging = tier === 4 &&
    (0, scope.shouldUseTier4AbyssalSpaceEmpiricalContent)(definition);
  const tier5Chaotic = tier === 5 &&
    (0, scope.shouldUseTier5AbyssalSpaceEmpiricalContent)(definition);
  const tier6Cataclysmic = tier === 6 &&
    (0, scope.shouldUseTier6AbyssalSpaceEmpiricalContent)(definition);
  const tier1Through6Empirical =
    tier1Calm || tier2Agitated || tier3Fierce || tier4Raging || tier5Chaotic ||
    tier6Cataclysmic;
  const roomCount = Math.max(
    1,
    (0, scope.toInteger)(
      definition && definition.roomProfile && definition.roomProfile.implementedRooms,
      1,
    ),
  );
  const environmentProfile = (0, scope.resolveAbyssalEnvironmentProfile)({
    tier,
    weatherType,
    layoutVariant: definition && definition.environmentLayoutVariant,
    seed:
      options.environmentSelectionSeed ||
      definition && definition.observedNpcSpawnSelectionSeed ||
      definition && definition.filamentTypeID,
  });
  const sceneryAuthority = (0, scope.resolveProfileContentAuthority)(
    environmentProfile,
    scope.ABYSSAL_CONTENT_AUTHORITY.DEBUG_PLACEHOLDER,
    `Abyssal scenery ${tier}:${weatherType}`,
  );
  const transitionAuthority =
    t0Dark &&
    scope.T0_DARK_TRANSITION_PROFILES
      ? (0, scope.resolveProfileContentAuthority)(
        scope.T0_DARK_TRANSITION_PROFILES,
        scope.ABYSSAL_CONTENT_AUTHORITY.CAPTURED_RETAIL,
        "Tier 0 Dark transition profiles",
      )
      : scope.ABYSSAL_CONTENT_AUTHORITY.PROJECT_AUTHORED;
  const weatherAuthority = (0, scope.resolveProfileContentAuthority)(
    (t0Tranquil || tier1Through6Empirical) && definition && definition.weatherProfile &&
      definition.weatherProfile.authorityFacets
      ? definition.weatherProfile.authorityFacets.observedMechanicsContract ||
        definition.weatherProfile.authorityFacets.mechanicsContract
      : definition && definition.weatherProfile,
    scope.ABYSSAL_CONTENT_AUTHORITY.DEBUG_PLACEHOLDER,
    `Abyssal weather ${weatherType || "unknown"}`,
  );
    return (0, scope.resolveFilamentEvidenceAuthorities)({
      definition,
      options,
      policy,
      tier,
      weatherType,
      filamentTypeID,
      t0Dark,
      t0Tranquil,
      tier1Calm,
      tier2Agitated,
      tier3Fierce,
      tier4Raging,
      tier5Chaotic,
      tier6Cataclysmic,
      tier1Through6Empirical,
      roomCount,
      environmentProfile,
      sceneryAuthority,
      transitionAuthority,
      weatherAuthority,
    });
  }

function resolveFilamentEvidenceAuthoritiesOperation(scope, attempt) {
    const {
      t0Dark, t0Tranquil, tier1Calm, tier2Agitated, tier3Fierce, tier4Raging, tier5Chaotic, tier6Cataclysmic,
      definition,
    } = attempt;
const traceAuthority = (0, scope.resolveProfileContentAuthority)(
    t0Dark && scope.SHARED_ABYSSAL_ENTRANCE_TRACE_PROFILE.authorityFacets
      ? scope.SHARED_ABYSSAL_ENTRANCE_TRACE_PROFILE.authorityFacets
        .t0DarkObservedContract
      : t0Tranquil && scope.SHARED_ABYSSAL_ENTRANCE_TRACE_PROFILE.authorityFacets
        ? scope.SHARED_ABYSSAL_ENTRANCE_TRACE_PROFILE.authorityFacets
          .t0TranquilBaselineContract
      : tier1Calm && scope.SHARED_ABYSSAL_ENTRANCE_TRACE_PROFILE.authorityFacets
        ? scope.SHARED_ABYSSAL_ENTRANCE_TRACE_PROFILE.authorityFacets
          .tier1CalmBaselineContract
      : tier2Agitated && scope.SHARED_ABYSSAL_ENTRANCE_TRACE_PROFILE.authorityFacets
        ? scope.SHARED_ABYSSAL_ENTRANCE_TRACE_PROFILE.authorityFacets
          .tier2AgitatedBaselineContract
      : tier3Fierce && scope.SHARED_ABYSSAL_ENTRANCE_TRACE_PROFILE.authorityFacets
        ? scope.SHARED_ABYSSAL_ENTRANCE_TRACE_PROFILE.authorityFacets
          .tier3FierceBaselineContract
      : tier4Raging && scope.SHARED_ABYSSAL_ENTRANCE_TRACE_PROFILE.authorityFacets
        ? scope.SHARED_ABYSSAL_ENTRANCE_TRACE_PROFILE.authorityFacets
          .tier4RagingBaselineContract
      : tier5Chaotic && scope.SHARED_ABYSSAL_ENTRANCE_TRACE_PROFILE.authorityFacets
        ? scope.SHARED_ABYSSAL_ENTRANCE_TRACE_PROFILE.authorityFacets
          .tier5ChaoticBaselineContract
      : tier6Cataclysmic && scope.SHARED_ABYSSAL_ENTRANCE_TRACE_PROFILE.authorityFacets
        ? scope.SHARED_ABYSSAL_ENTRANCE_TRACE_PROFILE.authorityFacets
          .tier6CataclysmicBaselineContract
      : scope.SHARED_ABYSSAL_ENTRANCE_TRACE_PROFILE,
    scope.ABYSSAL_CONTENT_AUTHORITY.PROVISIONAL,
    "Abyssal entrance trace profile",
  );
  const boundaryAuthority = (0, scope.resolveProfileContentAuthority)(
    t0Dark && scope.UNSTABLE_ABYSSAL_DEPTHS_BOUNDARY_PROFILE.authorityFacets
      ? scope.UNSTABLE_ABYSSAL_DEPTHS_BOUNDARY_PROFILE.authorityFacets.t0DarkPolicy
      : t0Tranquil && scope.UNSTABLE_ABYSSAL_DEPTHS_BOUNDARY_PROFILE.authorityFacets
        ? scope.UNSTABLE_ABYSSAL_DEPTHS_BOUNDARY_PROFILE.authorityFacets.t0TranquilPolicy
      : tier1Calm && scope.UNSTABLE_ABYSSAL_DEPTHS_BOUNDARY_PROFILE.authorityFacets
        ? scope.UNSTABLE_ABYSSAL_DEPTHS_BOUNDARY_PROFILE.authorityFacets.tier1CalmPolicy
      : tier2Agitated && scope.UNSTABLE_ABYSSAL_DEPTHS_BOUNDARY_PROFILE.authorityFacets
        ? scope.UNSTABLE_ABYSSAL_DEPTHS_BOUNDARY_PROFILE.authorityFacets
          .tier2AgitatedPolicy
      : tier3Fierce && scope.UNSTABLE_ABYSSAL_DEPTHS_BOUNDARY_PROFILE.authorityFacets
        ? scope.UNSTABLE_ABYSSAL_DEPTHS_BOUNDARY_PROFILE.authorityFacets
          .tier3FiercePolicy
      : tier4Raging && scope.UNSTABLE_ABYSSAL_DEPTHS_BOUNDARY_PROFILE.authorityFacets
        ? scope.UNSTABLE_ABYSSAL_DEPTHS_BOUNDARY_PROFILE.authorityFacets
          .tier4RagingPolicy
      : tier5Chaotic && scope.UNSTABLE_ABYSSAL_DEPTHS_BOUNDARY_PROFILE.authorityFacets
        ? scope.UNSTABLE_ABYSSAL_DEPTHS_BOUNDARY_PROFILE.authorityFacets
          .tier5ChaoticPolicy
      : tier6Cataclysmic && scope.UNSTABLE_ABYSSAL_DEPTHS_BOUNDARY_PROFILE.authorityFacets
        ? scope.UNSTABLE_ABYSSAL_DEPTHS_BOUNDARY_PROFILE.authorityFacets
          .tier6CataclysmicPolicy
      : scope.UNSTABLE_ABYSSAL_DEPTHS_BOUNDARY_PROFILE,
    scope.ABYSSAL_CONTENT_AUTHORITY.PROVISIONAL,
    "Abyssal boundary profile",
  );
  const suppressorAuthority = (0, scope.resolveProfileContentAuthority)(
    scope.SHORT_RANGE_SUPPRESSOR_MECHANICS_PROFILE,
    scope.ABYSSAL_CONTENT_AUTHORITY.PROJECT_AUTHORED,
    "Abyssal suppressor mechanics profile",
  );
  const capturedSelection = Boolean(
    definition && definition.authoredContentSelection &&
      definition.authoredContentSelection.selected === true,
  );
  const explicitCapturedSelection = Boolean(
    capturedSelection &&
    definition.authoredContentSelection.selectionPolicy ===
      "explicit-capture-id",
  );
  const tier0EmpiricalSelection = Boolean(
    t0Tranquil && (0, scope.shouldUseTier0AbyssalSpaceEmpiricalContent)(definition),
  );
  const tier1EmpiricalSelection = Boolean(tier1Calm);
  const tier2EmpiricalSelection = Boolean(tier2Agitated);
  const tier3EmpiricalSelection = Boolean(tier3Fierce);
  const tier4EmpiricalSelection = Boolean(tier4Raging);
  const tier5EmpiricalSelection = Boolean(tier5Chaotic);
  const tier6EmpiricalSelection = Boolean(tier6Cataclysmic);
  const abyssalSpaceEmpiricalSelection = Boolean(
    !explicitCapturedSelection && (
      tier0EmpiricalSelection || tier1EmpiricalSelection ||
      tier2EmpiricalSelection || tier3EmpiricalSelection ||
      tier4EmpiricalSelection || tier5EmpiricalSelection ||
      tier6EmpiricalSelection
    ),
  );
  const observedSelection = Boolean(
    abyssalSpaceEmpiricalSelection ||
      !capturedSelection &&
        definition && definition.observedNpcSpawnSelectionEnabled === true,
  );
  const roomsAuthority = {};
  const roomsRequirements = {};
    return (0, scope.assembleResolvedFilamentGovernance)({
      ...attempt,
      traceAuthority,
      boundaryAuthority,
      suppressorAuthority,
      capturedSelection,
      explicitCapturedSelection,
      tier0EmpiricalSelection,
      tier1EmpiricalSelection,
      tier2EmpiricalSelection,
      tier3EmpiricalSelection,
      tier4EmpiricalSelection,
      tier5EmpiricalSelection,
      tier6EmpiricalSelection,
      abyssalSpaceEmpiricalSelection,
      observedSelection,
      roomsAuthority,
      roomsRequirements,
    });
  }

function assembleResolvedFilamentGovernanceOperation(scope, attempt) {
    const {
      roomCount, definition, abyssalSpaceEmpiricalSelection, tier, roomsAuthority, observedSelection,
      capturedSelection, sceneryAuthority, transitionAuthority, boundaryAuthority, suppressorAuthority,
      roomsRequirements, weatherAuthority, traceAuthority, policy, environmentProfile,
      tier0EmpiricalSelection, tier1EmpiricalSelection, tier2EmpiricalSelection, tier3EmpiricalSelection,
    } = attempt;
for (let roomIndex = 1; roomIndex <= roomCount; roomIndex += 1) {
    const encounterProfile =
      definition && definition.roomEncounterProfilesByIndex &&
      (definition.roomEncounterProfilesByIndex[String(roomIndex)] ||
        definition.roomEncounterProfilesByIndex[roomIndex]) ||
      null;
    const rewardProfile = abyssalSpaceEmpiricalSelection
      ? definition && definition.rewardProfile || null
      : encounterProfile && encounterProfile.rewardProfileOverride ||
        definition && definition.rewardProfile || null;
    const extractionProfile =
      encounterProfile && encounterProfile.extractionNodeProfileOverride ||
      definition && definition.extractionNodeProfile ||
      null;
    const extractionApplicable = (0, scope.isExtractionProfileApplicableToRoom)(
      extractionProfile,
      roomIndex,
      tier,
    );
    roomsAuthority[String(roomIndex)] = {
      encounter: observedSelection
        ? scope.ABYSSAL_CONTENT_AUTHORITY.PROJECT_AUTHORED
        : (0, scope.resolveProfileContentAuthority)(
          encounterProfile,
          scope.ABYSSAL_CONTENT_AUTHORITY.DEBUG_PLACEHOLDER,
          `Abyssal encounter room ${roomIndex}`,
        ),
      rewards: (0, scope.resolveProfileContentAuthority)(
        rewardProfile,
        scope.ABYSSAL_CONTENT_AUTHORITY.DEBUG_PLACEHOLDER,
        `Abyssal rewards room ${roomIndex}`,
      ),
      scenery: capturedSelection
        ? scope.ABYSSAL_CONTENT_AUTHORITY.CAPTURED_RETAIL
        : sceneryAuthority,
      transitions: transitionAuthority,
      boundary: boundaryAuthority,
      suppressors: suppressorAuthority,
      ...(extractionApplicable
        ? {
          extraction_nodes: (0, scope.resolveProfileContentAuthority)(
            extractionProfile,
            scope.ABYSSAL_CONTENT_AUTHORITY.DEBUG_PLACEHOLDER,
            `Abyssal extraction nodes room ${roomIndex}`,
          ),
        }
        : {}),
    };
    roomsRequirements[String(roomIndex)] = {
      encounter: scope.ABYSSAL_CONTENT_COMPONENT_REQUIREMENT.REQUIRED,
      rewards: scope.ABYSSAL_CONTENT_COMPONENT_REQUIREMENT.REQUIRED,
      scenery: scope.ABYSSAL_CONTENT_COMPONENT_REQUIREMENT.OPTIONAL,
      transitions: scope.ABYSSAL_CONTENT_COMPONENT_REQUIREMENT.REQUIRED,
      boundary: scope.ABYSSAL_CONTENT_COMPONENT_REQUIREMENT.REQUIRED,
      suppressors: scope.ABYSSAL_CONTENT_COMPONENT_REQUIREMENT.OPTIONAL,
      extraction_nodes: extractionApplicable
        ? scope.ABYSSAL_CONTENT_COMPONENT_REQUIREMENT.OPTIONAL
        : scope.ABYSSAL_CONTENT_COMPONENT_REQUIREMENT.NOT_APPLICABLE,
    };
  }
  const contentAuthority = {
    definition: (0, scope.validateAbyssalContentAuthority)(
      definition && definition.definitionContentAuthority ||
        scope.ABYSSAL_CONTENT_AUTHORITY.DEBUG_PLACEHOLDER,
      `Abyssal filament definition ${String(
        definition && definition.definitionID || "unknown",
      )}`,
    ),
    weather: weatherAuthority,
    trace: traceAuthority,
    rooms: roomsAuthority,
  };
  const contentRequirements = {
    definition: scope.ABYSSAL_CONTENT_COMPONENT_REQUIREMENT.REQUIRED,
    weather: scope.ABYSSAL_CONTENT_COMPONENT_REQUIREMENT.REQUIRED,
    trace: scope.ABYSSAL_CONTENT_COMPONENT_REQUIREMENT.REQUIRED,
    rooms: roomsRequirements,
  };
  const governedDefinition = {
    ...definition,
    contentCompletenessPolicy: policy,
    contentAuthority,
    contentRequirements,
  };
  const contentComponents = (0, scope.buildResolvedContentComponents)(governedDefinition, {
    policy,
    roomCount,
    environmentProfile,
    capturedSelection,
    observedSelection,
    tier0EmpiricalSelection,
    tier1EmpiricalSelection,
    tier2EmpiricalSelection,
    tier3EmpiricalSelection,
    abyssalSpaceEmpiricalSelection,
    transitionAuthority,
    traceAuthority,
    boundaryAuthority,
  });
  const enrichedDefinition = {
    ...governedDefinition,
    contentComponents,
  };
  const legacyReport = (0, scope.buildAbyssalContentCompletenessReport)(enrichedDefinition);
  const contentCompletenessAudit =
    (0, scope.auditResolvedAbyssalContentCompleteness)(enrichedDefinition);
  return {
    ...enrichedDefinition,
    contentCompletenessReport: {
      ...legacyReport,
      declaredCompletenessLevel:
        contentCompletenessAudit.declaredCompletenessLevel,
      achievedCompletenessLevel:
        contentCompletenessAudit.achievedCompletenessLevel,
      regression: contentCompletenessAudit.regression,
      promotionAvailable: contentCompletenessAudit.promotionAvailable,
    },
    contentCompletenessAudit,
  };
  }

function validateResolvedAbyssalContentDefinitionOperation(scope, definition = null) {
  const report = (0, scope.buildAbyssalContentCompletenessReport)(definition);
  const releaseValidation = (0, scope.validateResolvedFilamentCompleteness)(definition);
  if (report.complete === true && releaseValidation.success === true) {
    return {
      success: true,
      report: {
        ...report,
        declaredCompletenessLevel:
          releaseValidation.audit.declaredCompletenessLevel,
        achievedCompletenessLevel:
          releaseValidation.audit.achievedCompletenessLevel,
        regression: false,
        promotionAvailable: releaseValidation.promotionAvailable,
      },
      contentCompletenessAudit: releaseValidation.audit,
    };
  }
  if (report.complete === true && !releaseValidation.success) {
    return {
      ...releaseValidation,
      filamentTypeID: (0, scope.toInteger)(definition && definition.filamentTypeID, 0),
      tier: (0, scope.toInteger)(definition && definition.tier, 0),
      weather: String(definition && definition.weatherType || ""),
      policy: definition && definition.contentCompletenessPolicy || null,
      contentCompletenessDiagnostic: {
        complete: false,
        declaredCompletenessLevel:
          releaseValidation.declaredCompletenessLevel,
        achievedCompletenessLevel:
          releaseValidation.achievedCompletenessLevel,
        blockers: (0, scope.cloneValue)(releaseValidation.blockers.slice(0, 20)),
      },
    };
  }
  const firstViolation = report.violations[0] || {};
  const pathParts = String(firstViolation.path || "").split(".");
  const roomPathIndex = pathParts.indexOf("rooms");
  return {
    success: false,
    errorMsg: "ABYSSAL_CONTENT_INCOMPLETE",
    errorCode: "ABYSSAL_CONTENT_INCOMPLETE",
    filamentTypeID: (0, scope.toInteger)(definition && definition.filamentTypeID, 0),
    tier: (0, scope.toInteger)(definition && definition.tier, 0),
    weather: String(definition && definition.weatherType || ""),
    policy: definition && definition.contentCompletenessPolicy || null,
    room: roomPathIndex >= 0
      ? (0, scope.toInteger)(pathParts[roomPathIndex + 1], 0) || null
      : null,
    component: String(firstViolation.component || "unknown"),
    resolvedAuthority: firstViolation.resolvedAuthority || null,
    contentCompletenessDiagnostic: {
      complete: false,
      violationCount: report.violations.length,
      violations: (0, scope.cloneValue)(report.violations.slice(0, 20)),
    },
  };
}

function buildResolvedDefinitionOperation(scope, baseDefinition, hullMode, options = {}) {

  const resolvedHullMode = (0, scope.normalizeHullMode)(hullMode);
  const tierMetadata = baseDefinition && baseDefinition.tierMetadata
    ? (0, scope.cloneValue)(baseDefinition.tierMetadata)
    : (0, scope.buildTierMetadata)(baseDefinition && baseDefinition.tier);
  const weatherProfile = baseDefinition && baseDefinition.weatherProfile
    ? (0, scope.cloneValue)(baseDefinition.weatherProfile)
    : (0, scope.buildWeatherProfile)(baseDefinition && baseDefinition.weatherType, {
      weatherName: baseDefinition && baseDefinition.weatherName,
      penaltyBandKey: tierMetadata.penaltyBandKey,
      penaltyBandLabel: tierMetadata.penaltyBandLabel,
    });
  const roomProfile = baseDefinition && baseDefinition.roomProfile
    ? (0, scope.cloneValue)(baseDefinition.roomProfile)
    : (0, scope.buildPlaceholderRoomProfile)();
  const extractionNodeProfile = baseDefinition && baseDefinition.extractionNodeProfile
    ? (0, scope.cloneValue)(baseDefinition.extractionNodeProfile)
    : (0, scope.buildPlaceholderExtractionNodeProfile)();
  const cacheProfile = baseDefinition && baseDefinition.cacheProfile
    ? (0, scope.cloneValue)(baseDefinition.cacheProfile)
    : null;
  const rewardProfile = baseDefinition && baseDefinition.rewardProfile
    ? (0, scope.cloneValue)(baseDefinition.rewardProfile)
    : null;
  const npcProfile = baseDefinition && baseDefinition.npcProfile
    ? (0, scope.cloneValue)(baseDefinition.npcProfile)
    : null;
  const roomEncounterProfilesByIndex =
    baseDefinition && baseDefinition.roomEncounterProfilesByIndex &&
      typeof baseDefinition.roomEncounterProfilesByIndex === "object"
      ? (0, scope.cloneValue)(baseDefinition.roomEncounterProfilesByIndex)
      : (0, scope.buildPlaceholderRoomEncounterProfilesForDefinition)(baseDefinition);
  const requiredFilaments = (0, scope.toInteger)(
    baseDefinition &&
      baseDefinition.requiredFilamentsByHullMode &&
      baseDefinition.requiredFilamentsByHullMode[resolvedHullMode],
    0,
  );
  const maxShips = (0, scope.toInteger)(
    baseDefinition &&
      baseDefinition.maxShipsByHullMode &&
      baseDefinition.maxShipsByHullMode[resolvedHullMode],
    0,
  );
    return (0, scope.materializeResolvedFilamentDefinition)({
      baseDefinition,
      hullMode,
      options,
      resolvedHullMode,
      tierMetadata,
      weatherProfile,
      roomProfile,
      extractionNodeProfile,
      cacheProfile,
      rewardProfile,
      npcProfile,
      roomEncounterProfilesByIndex,
      requiredFilaments,
      maxShips,
    });
  }

function materializeResolvedFilamentDefinitionOperation(scope, attempt) {
    const {
      baseDefinition, tierMetadata, weatherProfile, resolvedHullMode, requiredFilaments, maxShips,
      roomProfile, extractionNodeProfile, cacheProfile, npcProfile, rewardProfile,
      roomEncounterProfilesByIndex, options,
    } = attempt;
return (0, scope.buildResolvedContentGovernance)({
    definitionID: String(baseDefinition.definitionID || ""),
    filamentTypeID: (0, scope.toInteger)(baseDefinition.filamentTypeID, 0),
    filamentName: String(baseDefinition.filamentName || ""),
    tier: Math.max(0, (0, scope.toInteger)(baseDefinition.tier, 1)),
    tierName: String(baseDefinition.tierName || tierMetadata.name || ""),
    tierMetadata,
    tier0AbyssalSpaceTelemetryEnabled:
      baseDefinition.tier0AbyssalSpaceTelemetryEnabled === true,
    tier0AbyssalSpaceTelemetryCatalogueID: String(
      baseDefinition.tier0AbyssalSpaceTelemetryCatalogueID || "",
    ),
    tier1AbyssalSpaceTelemetryEnabled:
      baseDefinition.tier1AbyssalSpaceTelemetryEnabled === true,
    tier1AbyssalSpaceTelemetryCatalogueID: String(
      baseDefinition.tier1AbyssalSpaceTelemetryCatalogueID || "",
    ),
    tier2AbyssalSpaceTelemetryEnabled:
      baseDefinition.tier2AbyssalSpaceTelemetryEnabled === true,
    tier2AbyssalSpaceTelemetryCatalogueID: String(
      baseDefinition.tier2AbyssalSpaceTelemetryCatalogueID || "",
    ),
    tier3AbyssalSpaceTelemetryEnabled:
      baseDefinition.tier3AbyssalSpaceTelemetryEnabled === true,
    tier3AbyssalSpaceTelemetryCatalogueID: String(
      baseDefinition.tier3AbyssalSpaceTelemetryCatalogueID || "",
    ),
    tier4AbyssalSpaceTelemetryEnabled:
      baseDefinition.tier4AbyssalSpaceTelemetryEnabled === true,
    tier4AbyssalSpaceTelemetryCatalogueID: String(
      baseDefinition.tier4AbyssalSpaceTelemetryCatalogueID || "",
    ),
    tier5AbyssalSpaceTelemetryEnabled:
      baseDefinition.tier5AbyssalSpaceTelemetryEnabled === true,
    tier5AbyssalSpaceTelemetryCatalogueID: String(
      baseDefinition.tier5AbyssalSpaceTelemetryCatalogueID || "",
    ),
    tier6AbyssalSpaceTelemetryEnabled:
      baseDefinition.tier6AbyssalSpaceTelemetryEnabled === true,
    tier6AbyssalSpaceTelemetryCatalogueID: String(
      baseDefinition.tier6AbyssalSpaceTelemetryCatalogueID || "",
    ),
    weatherType: String(baseDefinition.weatherType || weatherProfile.weatherType || ""),
    weatherName: String(baseDefinition.weatherName || weatherProfile.weatherName || ""),
    weatherProfile,
    traceProfileID: String(baseDefinition.traceProfileID || "").trim(),
    traceProfileID: String(baseDefinition.traceProfileID || "").trim(),
    environmentLayoutVariant: String(
      baseDefinition.environmentLayoutVariant || "",
    ),
    hullMode: resolvedHullMode,
    allowedHullModes: (0, scope.normalizeStringArray)(baseDefinition.allowedHullModes),
    requiredFilaments,
    maxShips,
    maxShipsByHullMode: (0, scope.cloneValue)(baseDefinition.maxShipsByHullMode || {}),
    timerDurationMs: Math.max(
      1,
      (0, scope.toInteger)(baseDefinition.timerDurationMs, scope.DEFAULT_ABYSSAL_TIMER_DURATION_MS),
    ),
    roomProfile,
    extractionNodeProfile,
    cacheProfile,
    npcProfile,
    rewardProfile,
    roomEncounterProfilesByIndex,
    observedNpcSpawnSelectionEnabled:
      options.observedNpcSpawnSelectionEnabled === true,
    observedNpcSpawnSelectionSeed: String(
      options.observedNpcSpawnSelectionSeed || "",
    ),
    observedNpcSpawnCatalogueID:
      options.observedNpcSpawnSelectionEnabled === true
        ? scope.ABYSSAL_ENCOUNTER_RESOLVER.getObservedCatalogueID()
        : "",
    retailNotes: (0, scope.normalizeStringArray)(baseDefinition.retailNotes),
    implementationLimits: (0, scope.normalizeStringArray)(baseDefinition.implementationLimits),
    placeholderNotes: (0, scope.normalizeStringArray)(baseDefinition.placeholderNotes),
    debugFallback: options.debugFallback === true,
    contentCompletenessPolicy: (0, scope.validateAbyssalContentCompletenessPolicy)(
      baseDefinition.contentCompletenessPolicy ||
        (options.debugFallback === true
          ? scope.ABYSSAL_CONTENT_COMPLETENESS_POLICY.DEVELOPMENT
          : scope.ABYSSAL_CONTENT_COMPLETENESS_POLICY.SUPPORTED),
      `Abyssal filament definition ${String(baseDefinition.definitionID || "unknown")}`,
    ),
    declaredCompletenessLevel: (0, scope.validateAbyssalContentCompletenessLevel)(
      baseDefinition.declaredCompletenessLevel,
      `Abyssal filament definition ${String(baseDefinition.definitionID || "unknown")}`,
    ),
    definitionContentAuthority: (0, scope.validateAbyssalContentAuthority)(
      baseDefinition.definitionContentAuthority ||
        (options.debugFallback === true
          ? scope.ABYSSAL_CONTENT_AUTHORITY.DEBUG_PLACEHOLDER
          : scope.ABYSSAL_CONTENT_AUTHORITY.PROJECT_AUTHORED),
      `Abyssal filament definition ${String(baseDefinition.definitionID || "unknown")}`,
    ),
    timerPolicyAuthority: (0, scope.validateAbyssalContentAuthority)(
      baseDefinition.timerPolicyAuthority || scope.ABYSSAL_CONTENT_AUTHORITY.PROVISIONAL,
      `Abyssal timer policy ${String(baseDefinition.definitionID || "unknown")}`,
    ),
    timeoutPolicyAuthority: (0, scope.validateAbyssalContentAuthority)(
      baseDefinition.timeoutPolicyAuthority ||
        scope.ABYSSAL_CONTENT_AUTHORITY.PROJECT_AUTHORED,
      `Abyssal timeout policy ${String(baseDefinition.definitionID || "unknown")}`,
    ),
    objectivePolicyAuthority: (0, scope.validateAbyssalContentAuthority)(
      baseDefinition.objectivePolicyAuthority ||
        scope.ABYSSAL_CONTENT_AUTHORITY.PROJECT_AUTHORED,
      `Abyssal objective policy ${String(baseDefinition.definitionID || "unknown")}`,
    ),
    conduitPolicyAuthority: (0, scope.validateAbyssalContentAuthority)(
      baseDefinition.conduitPolicyAuthority ||
        scope.ABYSSAL_CONTENT_AUTHORITY.PROJECT_AUTHORED,
      `Abyssal conduit policy ${String(baseDefinition.definitionID || "unknown")}`,
    ),
    cachePolicyAuthority: (0, scope.validateAbyssalContentAuthority)(
      baseDefinition.cachePolicyAuthority ||
        scope.ABYSSAL_CONTENT_AUTHORITY.PROJECT_AUTHORED,
      `Abyssal cache policy ${String(baseDefinition.definitionID || "unknown")}`,
    ),
  }, options);
  }

function buildDebugFallbackDefinitionOperation(scope, filamentTypeRecord = null, hullMode = "", options = {}) {
  const typeID = (0, scope.toInteger)(filamentTypeRecord && filamentTypeRecord.typeID, scope.FILAMENT_DEBUG_FALLBACK_TYPE_ID);
  const filamentName = String(
    filamentTypeRecord && filamentTypeRecord.name ||
    options.filamentName ||
    "Unsupported Abyssal Filament (Debug Placeholder)",
  );
  return (0, scope.buildResolvedDefinition)({
    definitionID: "abyssal:debug-placeholder",
    filamentTypeID: typeID,
    filamentName,
    tier: 1,
    weatherType: "debug",
    weatherName: "Debug Placeholder Weather",
    allowedHullModes: ["frigate", "destroyer", "cruiser"],
    requiredFilamentsByHullMode: scope.DEFAULT_REQUIRED_FILAMENTS_BY_HULL_MODE,
    maxShipsByHullMode: scope.DEFAULT_MAX_SHIPS_BY_HULL_MODE,
    timerDurationMs: scope.DEFAULT_ABYSSAL_TIMER_DURATION_MS,
    contentCompletenessPolicy: scope.ABYSSAL_CONTENT_COMPLETENESS_POLICY.DEVELOPMENT,
    declaredCompletenessLevel: scope.ABYSSAL_CONTENT_COMPLETENESS_LEVEL.PLAYABLE,
    definitionContentAuthority: scope.ABYSSAL_CONTENT_AUTHORITY.DEBUG_PLACEHOLDER,
    roomProfile: (0, scope.buildPlaceholderRoomProfile)(),
    extractionNodeProfile: (0, scope.buildPlaceholderExtractionNodeProfile)(),
    cacheProfile: (0, scope.buildPlaceholderCacheProfile)({
      cacheDisplayName: "Abyssal Cache (Debug Placeholder)",
    }),
    npcProfile: (0, scope.buildPlaceholderNpcProfile)(),
    rewardProfile: (0, scope.buildPlaceholderRewardProfile)(),
    roomEncounterProfilesByIndex: (0, scope.buildPlaceholderRoomEncounterProfilesForDefinition)({
      tier: 1,
      weatherType: "debug",
      weatherName: "Debug Placeholder Weather",
      definitionContentAuthority: scope.ABYSSAL_CONTENT_AUTHORITY.DEBUG_PLACEHOLDER,
      npcProfile: (0, scope.buildPlaceholderNpcProfile)(),
    }),
    retailNotes: [
      "Debug fallback content is for EveJS development only.",
    ],
    placeholderNotes: [
      "Debug fallback definition was used because no authored filament definition exists.",
    ],
  }, hullMode, {
    debugFallback: true,
  });
}

function resolveDefinitionOperation(scope, input = {}, options = {}, mode = "procedural") {

  const procedural = mode === "procedural" || mode === "procedural-v1";
  const filamentTypeID = (0, scope.toInteger)(
    input.filamentTypeID ?? input.typeID ?? input.itemTypeID,
    0,
  );
  const hullMode = (0, scope.normalizeHullMode)(input.hullMode ?? input.shipClass ?? "");
  if (filamentTypeID <= 0) {
    return {
      success: false,
      errorMsg: "FILAMENT_TYPE_REQUIRED",
      errorCode: "FILAMENT_TYPE_REQUIRED",
    };
  }
  if (!hullMode) {
    return {
      success: false,
      errorMsg: "FILAMENT_HULL_MODE_REQUIRED",
      errorCode: "FILAMENT_HULL_MODE_REQUIRED",
    };
  }

  const baseDefinition = scope.ABYSSAL_FILAMENT_DEFINITIONS_BY_TYPE_ID[filamentTypeID] || null;
  if (!baseDefinition) {
    if ((0, scope.readDebugFallbackEnabled)(options)) {
      return {
        success: true,
        usedDebugFallback: true,
        definition: (0, scope.buildDebugFallbackDefinition)(input.filamentTypeRecord || null, hullMode, input),
      };
    }
    return {
      success: false,
      errorMsg: "UNSUPPORTED_FILAMENT_DEFINITION",
      errorCode: "UNSUPPORTED_FILAMENT_DEFINITION",
      filamentTypeID,
    };
  }

  const allowedHullModes = (0, scope.normalizeStringArray)(baseDefinition.allowedHullModes);
  if (!allowedHullModes.includes(hullMode)) {
    return {
      success: false,
      errorMsg: "FILAMENT_HULL_MODE_UNSUPPORTED",
      errorCode: "FILAMENT_HULL_MODE_UNSUPPORTED",
      filamentTypeID,
      hullMode,
      allowedHullModes,
    };
  }

  if (procedural && input.authoredCaptureID) {
    return { success: false, errorMsg: "AUTHORED_CAPTURE_RECOVERY_ONLY", errorCode: "AUTHORED_CAPTURE_RECOVERY_ONLY" };
  }
  const authoredSelection = procedural ? { success: false } : (0, scope.selectAuthoredAbyssalCapture)({
    authoredCaptureID: input.authoredCaptureID,
    tier: baseDefinition.tier,
    weatherType: baseDefinition.weatherType,
    filamentTypeID,
    selectionSeed:
      input.authoredSelectionSeed ??
      input.selectionSeed ??
      input.traceItemID ??
      input.filamentItemID ??
      filamentTypeID,
  });
  if (
    input.authoredCaptureID &&
    (!authoredSelection.success ||
      (0, scope.toInteger)(authoredSelection.capture && authoredSelection.capture.filamentTypeID, 0) !==
        filamentTypeID)
  ) {
    return {
      success: false,
      errorMsg: authoredSelection.success
        ? "AUTHORED_CAPTURE_FILAMENT_MISMATCH"
        : authoredSelection.errorMsg,
      errorCode: authoredSelection.success
        ? "AUTHORED_CAPTURE_FILAMENT_MISMATCH"
        : authoredSelection.errorCode,
      filamentTypeID,
      authoredContentDiagnostic: (0, scope.cloneValue)(authoredSelection),
    };
  }
    return (0, scope.resolveSelectedFilamentDefinition)({
      input,
      options,
      mode,
      procedural,
      filamentTypeID,
      hullMode,
      baseDefinition,
      allowedHullModes,
      authoredSelection,
    });
  }

function resolveSelectedFilamentDefinitionOperation(scope, attempt) {
    const {
      input, procedural, mode, baseDefinition, hullMode, authoredSelection, filamentTypeID,
    } = attempt;
const observedNpcSpawnSelectionSeed = String(
    input.observedNpcSpawnSelectionSeed ??
      input.runID ??
      input.instanceID ??
      input.traceItemID ??
      input.filamentItemID ??
      "",
  ).trim();
  const observedNpcSpawnSelectionEnabled = procedural || Boolean(
    observedNpcSpawnSelectionSeed &&
    observedNpcSpawnSelectionSeed !== "0"
  );
  const resolvedDefinition = (0, scope.buildResolvedDefinition)(
    procedural ? (mode === "procedural-v1" ? scope.composeProceduralContentV1 : scope.composeProceduralContent)(baseDefinition, scope.proceduralContentInputs) : baseDefinition,
    hullMode,
    {
      observedNpcSpawnSelectionEnabled,
      observedNpcSpawnSelectionSeed:
        observedNpcSpawnSelectionEnabled
          ? observedNpcSpawnSelectionSeed
          : "",
    },
  );
  const empiricalBaselineSelected =
    (0, scope.shouldUseCorrelatedAbyssalSpaceEmpiricalContent)(resolvedDefinition);
  let definition = procedural ? resolvedDefinition : authoredSelection.success
    ? (0, scope.applyAuthoredCaptureToDefinition)(resolvedDefinition, authoredSelection)
    : {
      ...resolvedDefinition,
      authoredContentSelection: {
        selected: false,
        fallbackUsed: !empiricalBaselineSelected,
        selectionMode: empiricalBaselineSelected ? "observed_empirical" : "fallback",
        errorCode: String(authoredSelection.errorCode || "NO_ELIGIBLE_AUTHORED_CAPTURE"),
        errorMsg: String(authoredSelection.errorMsg || ""),
        unavailableCaptures: (0, scope.cloneValue)(authoredSelection.unavailableCaptures || []),
      },
    };

  if (
    !authoredSelection.success &&
    definition.observedNpcSpawnSelectionEnabled === true
  ) {
    const observedNpcSpawnCoverage =
      (0, scope.validateObservedAbyssalNpcSpawnCoverage)(definition);
    if (!observedNpcSpawnCoverage.success) {
      return {
        success: false,
        errorMsg:
          "OBSERVED_ABYSSAL_NPC_CONTEXT_UNAVAILABLE " +
          `tier=${observedNpcSpawnCoverage.tier} ` +
          `weather=${observedNpcSpawnCoverage.weatherType} ` +
          `rooms=${observedNpcSpawnCoverage.unavailableRooms
            .map((entry) => entry.roomIndex)
            .join(",")}`,
        errorCode: "OBSERVED_ABYSSAL_NPC_CONTEXT_UNAVAILABLE",
        filamentTypeID,
        observedNpcSpawnCoverage: (0, scope.cloneValue)(observedNpcSpawnCoverage),
        authoredContentDiagnostic: (0, scope.cloneValue)(
          definition.authoredContentSelection,
        ),
      };
    }
    definition = {
      ...definition,
      observedNpcSpawnCoverage: (0, scope.cloneValue)(observedNpcSpawnCoverage),
    };
  }

  definition = (0, scope.buildResolvedContentGovernance)(definition, {
    environmentSelectionSeed:
      input.environmentSelectionSeed ??
      input.runID ??
      input.instanceID ??
      input.traceItemID ??
      input.filamentItemID ??
      filamentTypeID,
  });
  const completenessValidation =
    (0, scope.validateResolvedAbyssalContentDefinition)(definition);
  if (!completenessValidation.success) {
    return completenessValidation;
  }

  return {
    success: true,
    usedDebugFallback: false,
    definition: mode === "legacy" ? definition : {
      ...definition,
      contentGeneration: (0, scope.buildContentGenerationIdentity)(definition,
        mode === "procedural" ? scope.PROCEDURAL_CONTENT_GENERATION_MODELS :
          mode === "procedural-v1" ? scope.PROCEDURAL_CONTENT_GENERATION_MODELS_V1 : scope.CONTENT_GENERATION_MODELS),
    },
    authoredContentDiagnostic: (0, scope.cloneValue)(definition.authoredContentSelection),
  };
  }

function resolveFilamentDefinitionOperation(scope, input = {}, options = {}) {
  return (0, scope.resolveDefinition)(input, options);
}

function resolvePersistedFilamentDefinitionOperation(scope, reference = {}) {
  const schema = Number(reference.abyssalContentProfileReferenceSchemaVersion);
  if (schema !== 1 && schema !== 2) {
    return { success: false, errorCode: "ABYSSAL_CONTENT_REFERENCE_VERSION_UNSUPPORTED" };
  }
  const model = reference.contentGeneration?.definition;
  if (schema === 2 && model !== scope.CONTENT_GENERATION_MODELS.definition &&
      model !== scope.PROCEDURAL_CONTENT_GENERATION_MODELS_V1.definition &&
      model !== scope.PROCEDURAL_CONTENT_GENERATION_MODELS.definition) {
    return { success: false, errorCode: "ABYSSAL_CONTENT_GENERATION_MISMATCH" };
  }
  const result = (0, scope.resolveDefinition)({
    filamentTypeID: reference.filamentTypeID,
    hullMode: reference.hullMode,
    authoredCaptureID: reference.authoredCaptureID || undefined,
    observedNpcSpawnSelectionSeed: reference.observedNpcSpawnSelectionSeed || undefined,
  }, { allowDebugFallback: false }, schema === 1 ? "legacy" :
    model === scope.CONTENT_GENERATION_MODELS.definition ? "hybrid" :
      model === scope.PROCEDURAL_CONTENT_GENERATION_MODELS_V1.definition ? "procedural-v1" : "procedural");
  if (!result.success) return result;
  if (String(result.definition.definitionID) !== String(reference.definitionID || "").trim() ||
      String(result.definition.authoredCaptureID || "") !==
        String(reference.authoredCaptureID || "").trim()) {
    return { success: false, errorCode: "ABYSSAL_PERSISTED_CONTENT_PROFILE_REFERENCE_UNRESOLVED" };
  }
  if (schema === 2 && !(0, scope.matchesContentGenerationIdentity)(
    reference.contentGeneration, result.definition.contentGeneration,
  )) {
    return { success: false, errorCode: "ABYSSAL_CONTENT_GENERATION_MISMATCH" };
  }
  return result;
}

function listSupportedFilamentDefinitionsOperation(scope) {
  return Object.values(scope.ABYSSAL_FILAMENT_DEFINITIONS_BY_TYPE_ID).map((entry) => {
    const result = (0, scope.resolveFilamentDefinition)({ filamentTypeID: entry.filamentTypeID,
      hullMode: (0, scope.normalizeStringArray)(entry.allowedHullModes)[0] || "cruiser" });
    if (!result.success) throw new Error(result.errorMsg || result.errorCode);
    return result.definition;
  });
}

function listProductionSupportedFilamentDefinitionsOperation(scope) {
  return (0, scope.listSupportedFilamentDefinitions)().filter((entry) =>
    [
      scope.ABYSSAL_CONTENT_COMPLETENESS_POLICY.SUPPORTED,
      scope.ABYSSAL_CONTENT_COMPLETENESS_POLICY.RETAIL_PARITY,
    ].includes(entry.contentCompletenessPolicy)
  );
}

function auditAbyssalFilamentDefinitionsOperation(scope) {

  const definitions = Object.values(scope.ABYSSAL_FILAMENT_DEFINITIONS_BY_TYPE_ID);
  const entries = definitions.map((baseDefinition) => {
    const hullMode = (0, scope.normalizeStringArray)(baseDefinition.allowedHullModes)[0] || "cruiser";
    const filamentTypeID = (0, scope.toInteger)(baseDefinition.filamentTypeID, 0);
    const resolution = (0, scope.resolveFilamentDefinition)({
      filamentTypeID,
      hullMode,
    }, {
      allowDebugFallback: false,
    });
    const definition = resolution && resolution.definition || null;
    const report = definition && definition.contentCompletenessReport ||
      resolution && resolution.contentCompletenessDiagnostic ||
      null;
    const releaseAudit = definition && definition.contentCompletenessAudit ||
      resolution && resolution.audit ||
      null;
    const violations = Array.isArray(report && report.violations)
      ? (0, scope.cloneValue)(report.violations)
      : [];
    return {
      filamentTypeID,
      definitionID: String(baseDefinition.definitionID || ""),
      filamentName: String(baseDefinition.filamentName || ""),
      tier: (0, scope.toInteger)(baseDefinition.tier, 0),
      weather: String(baseDefinition.weatherType || ""),
      hullMode,
      supportedHullModes: (0, scope.normalizeStringArray)(baseDefinition.allowedHullModes),
      contentInvariantAcrossHullModes: true,
      policy: String(
        definition && definition.contentCompletenessPolicy ||
        baseDefinition.contentCompletenessPolicy ||
        "",
      ),
      complete: resolution && resolution.success === true &&
        Boolean(report && report.complete === true),
      placeholderComponentCount: Array.isArray(report && report.placeholderComponents)
        ? report.placeholderComponents.length
        : 0,
      provisionalComponentCount: Array.isArray(report && report.provisionalComponents)
        ? report.provisionalComponents.length
        : 0,
      declaredCompletenessLevel: String(
        releaseAudit && releaseAudit.declaredCompletenessLevel ||
        baseDefinition.declaredCompletenessLevel ||
        "",
      ),
      achievedCompletenessLevel: String(
        releaseAudit && releaseAudit.achievedCompletenessLevel ||
        scope.ABYSSAL_CONTENT_COMPLETENESS_LEVEL.INCOMPLETE,
      ),
      regression: releaseAudit ? releaseAudit.regression === true : true,
      promotionAvailable: releaseAudit
        ? releaseAudit.promotionAvailable === true
        : false,
      nextLevel: releaseAudit && releaseAudit.nextLevel || null,
      nextLevelBlockers: (0, scope.cloneValue)(
        releaseAudit && releaseAudit.nextLevelBlockers || [],
      ),
      declaredLevelBlockers: (0, scope.cloneValue)(
        releaseAudit && releaseAudit.declaredLevelBlockers || [],
      ),
      fallbackCount: (0, scope.toInteger)(releaseAudit && releaseAudit.fallbackCount, 0),
      requiredAuthorityCounts: (0, scope.cloneValue)(
        releaseAudit && releaseAudit.requiredAuthorityCounts || {},
      ),
      requiredStatusCounts: (0, scope.cloneValue)(
        releaseAudit && releaseAudit.requiredStatusCounts || {},
      ),
      components: (0, scope.cloneValue)(releaseAudit && releaseAudit.components || []),
      violations,
      errorCode: resolution && resolution.success === false
        ? String(resolution.errorCode || resolution.errorMsg || "")
        : "",
    };
  });
    return (0, scope.summarizeAbyssalFilamentDefinitionAudit)({

      definitions,
      entries,
    });
  }

function summarizeAbyssalFilamentDefinitionAuditOperation(scope, attempt) {
    const {
      entries,
    } = attempt;
const supportedEntries = entries.filter((entry) =>
    [
      scope.ABYSSAL_CONTENT_COMPLETENESS_POLICY.SUPPORTED,
      scope.ABYSSAL_CONTENT_COMPLETENESS_POLICY.RETAIL_PARITY,
    ].includes(entry.policy)
  );
  const levelValues = Object.values(scope.ABYSSAL_CONTENT_COMPLETENESS_LEVEL);
  const declaredLevelCounts = Object.fromEntries(
    levelValues.map((level) => [level, 0]),
  );
  const achievedLevelCounts = Object.fromEntries(
    levelValues.map((level) => [level, 0]),
  );
  const requiredAuthorityCounts = Object.fromEntries([
    ...Object.values(scope.ABYSSAL_CONTENT_AUTHORITY),
    ...Object.values(scope.ABYSSAL_CONTENT_VALIDATION_AUTHORITY),
  ].map((authority) => [authority, 0]));
  const requiredStatusCounts = Object.fromEntries(
    Object.values(scope.ABYSSAL_CONTENT_COMPLETENESS_STATUS)
      .map((status) => [status, 0]),
  );
  for (const entry of supportedEntries) {
    declaredLevelCounts[entry.declaredCompletenessLevel] += 1;
    achievedLevelCounts[entry.achievedCompletenessLevel] += 1;
    for (const [authority, count] of Object.entries(entry.requiredAuthorityCounts)) {
      if (!Object.hasOwn(requiredAuthorityCounts, authority)) {
        requiredAuthorityCounts[authority] = 0;
      }
      requiredAuthorityCounts[authority] += (0, scope.toInteger)(count, 0);
    }
    for (const [status, count] of Object.entries(entry.requiredStatusCounts)) {
      if (!Object.hasOwn(requiredStatusCounts, status)) {
        requiredStatusCounts[status] = 0;
      }
      requiredStatusCounts[status] += (0, scope.toInteger)(count, 0);
    }
  }
  return {
    complete: supportedEntries.every((entry) =>
      entry.complete && !entry.regression
    ),
    definitionCount: entries.length,
    supportedDefinitionCount: supportedEntries.length,
    completeDefinitionCount: entries.filter((entry) => entry.complete).length,
    failedDefinitionCount: entries.filter((entry) => !entry.complete).length,
    placeholderComponentCount: entries.reduce(
      (total, entry) => total + entry.placeholderComponentCount,
      0,
    ),
    provisionalComponentCount: entries.reduce(
      (total, entry) => total + entry.provisionalComponentCount,
      0,
    ),
    violationCount: entries.reduce(
      (total, entry) => total + entry.violations.length,
      0,
    ),
    regressionCount: supportedEntries.filter((entry) => entry.regression).length,
    promotionOpportunityCount: supportedEntries.filter(
      (entry) => entry.promotionAvailable,
    ).length,
    fallbackCount: supportedEntries.reduce(
      (total, entry) => total + entry.fallbackCount,
      0,
    ),
    declaredLevelCounts,
    achievedLevelCounts,
    requiredAuthorityCounts,
    requiredStatusCounts,
    tiersExamined: [...new Set(
      supportedEntries.map((entry) => entry.tier),
    )].sort((left, right) => left - right),
    entries,
  };
  }

function auditAbyssalFilamentCompletenessOperation(scope) {
  return (0, scope.auditAbyssalFilamentDefinitions)();
}

function resolveFilamentDefinitionByTierWeatherOperation(scope, input = {}, options = {}) {
    const tier = (0, scope.toInteger)(input.tier, -1);
    const weatherType = String(input.weatherType ?? input.weather ?? "")
      .trim()
      .toLowerCase();
    if (tier < 0 || tier > 6) {
      return {
        success: false,
        errorMsg: "FILAMENT_TIER_REQUIRED",
        errorCode: "FILAMENT_TIER_REQUIRED",
      };
    }
    if (!weatherType) {
      return {
        success: false,
        errorMsg: "FILAMENT_WEATHER_REQUIRED",
        errorCode: "FILAMENT_WEATHER_REQUIRED",
      };
    }
    const baseDefinition = Object.values(scope.ABYSSAL_FILAMENT_DEFINITIONS_BY_TYPE_ID)
      .find((entry) => entry.tier === tier && entry.weatherType === weatherType);
    if (!baseDefinition) {
      return {
        success: false,
        errorMsg: "UNSUPPORTED_FILAMENT_DEFINITION",
        errorCode: "UNSUPPORTED_FILAMENT_DEFINITION",
        tier,
        weatherType,
      };
    }
    return (0, scope.resolveFilamentDefinition)({
      ...input,
      filamentTypeID: baseDefinition.filamentTypeID,
    }, options);
  }

function getProductionDefinitionIdentityManifestOperation(scope) {
    return Object.values(scope.ABYSSAL_FILAMENT_DEFINITIONS_BY_TYPE_ID).map((entry) => ({
      filamentTypeID: entry.filamentTypeID,
      definitionID: entry.definitionID,
      tier: entry.tier,
      weatherType: entry.weatherType,
    }));
  }

function bindAbyssalFilamentResolutionOperations(scope) {
  scope.buildResolvedContentGovernance = function buildResolvedContentGovernance(definition, options = {}) {
    return buildResolvedContentGovernanceOperation(scope, definition, options);
  };
  scope.resolveFilamentEvidenceAuthorities = function resolveFilamentEvidenceAuthorities(attempt) {
    return resolveFilamentEvidenceAuthoritiesOperation(scope, attempt);
  };
  scope.assembleResolvedFilamentGovernance = function assembleResolvedFilamentGovernance(attempt) {
    return assembleResolvedFilamentGovernanceOperation(scope, attempt);
  };
  scope.validateResolvedAbyssalContentDefinition = function validateResolvedAbyssalContentDefinition(definition = null) {
    return validateResolvedAbyssalContentDefinitionOperation(scope, definition);
  };
  scope.buildResolvedDefinition = function buildResolvedDefinition(baseDefinition, hullMode, options = {}) {
    return buildResolvedDefinitionOperation(scope, baseDefinition, hullMode, options);
  };
  scope.materializeResolvedFilamentDefinition = function materializeResolvedFilamentDefinition(attempt) {
    return materializeResolvedFilamentDefinitionOperation(scope, attempt);
  };
  scope.buildDebugFallbackDefinition = function buildDebugFallbackDefinition(filamentTypeRecord = null, hullMode = "", options = {}) {
    return buildDebugFallbackDefinitionOperation(scope, filamentTypeRecord, hullMode, options);
  };
  scope.resolveDefinition = function resolveDefinition(input = {}, options = {}, mode = "procedural") {
    return resolveDefinitionOperation(scope, input, options, mode);
  };
  scope.resolveSelectedFilamentDefinition = function resolveSelectedFilamentDefinition(attempt) {
    return resolveSelectedFilamentDefinitionOperation(scope, attempt);
  };
  scope.resolveFilamentDefinition = function resolveFilamentDefinition(input = {}, options = {}) {
    return resolveFilamentDefinitionOperation(scope, input, options);
  };
  scope.resolvePersistedFilamentDefinition = function resolvePersistedFilamentDefinition(reference = {}) {
    return resolvePersistedFilamentDefinitionOperation(scope, reference);
  };
  scope.listSupportedFilamentDefinitions = function listSupportedFilamentDefinitions() {
    return listSupportedFilamentDefinitionsOperation(scope);
  };
  scope.listProductionSupportedFilamentDefinitions = function listProductionSupportedFilamentDefinitions() {
    return listProductionSupportedFilamentDefinitionsOperation(scope);
  };
  scope.auditAbyssalFilamentDefinitions = function auditAbyssalFilamentDefinitions() {
    return auditAbyssalFilamentDefinitionsOperation(scope);
  };
  scope.summarizeAbyssalFilamentDefinitionAudit = function summarizeAbyssalFilamentDefinitionAudit(attempt) {
    return summarizeAbyssalFilamentDefinitionAuditOperation(scope, attempt);
  };
  scope.auditAbyssalFilamentCompleteness = function auditAbyssalFilamentCompleteness() {
    return auditAbyssalFilamentCompletenessOperation(scope);
  };
  scope.resolveFilamentDefinitionByTierWeather = function resolveFilamentDefinitionByTierWeather(input = {}, options = {}) {
    return resolveFilamentDefinitionByTierWeatherOperation(scope, input, options);
  };
  scope.getProductionDefinitionIdentityManifest = function getProductionDefinitionIdentityManifest() {
    return getProductionDefinitionIdentityManifestOperation(scope);
  };
}

module.exports = {
  bindAbyssalFilamentResolutionOperations,
};
