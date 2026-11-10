"use strict";

function readDebugFallbackEnabledOperation(scope, options = {}) {
  if (Object.prototype.hasOwnProperty.call(options, "allowDebugFallback")) {
    return (0, scope.toBoolean)(options.allowDebugFallback, false);
  }
  return false;
}

function resolveProfileContentAuthorityOperation(scope, profile, fallbackAuthority, context) {
  return (0, scope.validateAbyssalContentAuthority)(
    profile && profile.contentAuthority || fallbackAuthority,
    context,
  );
}

function isExtractionProfileApplicableToRoomOperation(scope, profile, roomIndex, tier) {
  if (!profile || profile.enabled !== true) {
    return false;
  }
  const eligibleRoomIndexes = (0, scope.normalizeIntegerArray)(profile.eligibleRoomIndexes);
  const eligibleTiers = (0, scope.normalizeIntegerArray)(profile.eligibleTiers);
  return (
    (eligibleRoomIndexes.length === 0 || eligibleRoomIndexes.includes(roomIndex)) &&
    (eligibleTiers.length === 0 || eligibleTiers.includes(tier))
  );
}

function listContentEvidenceRefsOperation(scope, profile = null) {
  if (!profile || typeof profile !== "object") return [];
  const refs = Array.isArray(profile.evidenceRefs)
    ? profile.evidenceRefs.map((entry) => String(entry || "").trim()).filter(Boolean)
    : [];
  const evidence = profile.evidence && typeof profile.evidence === "object"
    ? profile.evidence
    : {};
  for (const value of [
    evidence.sourceFile,
    evidence.sourceSegment,
    evidence.sourceContentUUID,
    profile.sourceModelID,
    profile.sourceSpawnID,
    profile.sourceSpawnFamily,
    profile.sourceEvidenceAuthority,
    profile.observedNpcSpawnCatalogueID,
    profile.evidenceSource,
  ]) {
    const normalized = String(value || "").trim();
    if (normalized && !refs.includes(normalized)) refs.push(normalized);
  }
  return refs;
}

function buildContentProvenanceOperation(scope, profile, options = {}) {
  return {
    sourceID: String(
      options.sourceID ||
      profile && (
        profile.profileID ||
        profile.encounterProfileID ||
        profile.rewardProfileID ||
        profile.extractionNodeProfileID ||
        profile.cacheProfileID ||
        profile.boundaryProfileID ||
        profile.profileSetID
      ) ||
      "",
    ).trim(),
    sourceType: String(options.sourceType || "structured_profile").trim(),
    evidenceRefs: [
      ...new Set([
        ...(0, scope.listContentEvidenceRefs)(profile),
        ...(Array.isArray(options.evidenceRefs) ? options.evidenceRefs : []),
      ].map((entry) => String(entry || "").trim()).filter(Boolean)),
    ],
  };
}

function buildContentComponentOperation(scope, options = {}) {
  const resolvedProfileID = String(options.resolvedProfileID || "").trim();
  const runtimeValid = options.runtimeValid === true;
  return {
    component: String(options.component || "unknown").trim(),
    path: String(options.path || options.component || "unknown").trim(),
    roomIndex: options.roomIndex != null && Number.isFinite(Number(options.roomIndex))
      ? Math.trunc(Number(options.roomIndex))
      : null,
    resolvedProfileID,
    authority: options.authority || null,
    provenance: (0, scope.buildContentProvenance)(
      options.profile,
      {
        sourceID: resolvedProfileID,
        ...(options.provenance || {}),
      },
    ),
    fallbackUsed: options.fallbackUsed === true,
    fallbackReason: String(options.fallbackReason || "").trim(),
    fallbackAllowed: options.fallbackAllowed === true,
    requestedAuthority: options.requestedAuthority || null,
    runtimeValid,
    completeness: options.completeness || (
      !resolvedProfileID
        ? scope.ABYSSAL_CONTENT_COMPLETENESS_STATUS.MISSING
        : runtimeValid
          ? scope.ABYSSAL_CONTENT_COMPLETENESS_STATUS.COMPLETE
          : scope.ABYSSAL_CONTENT_COMPLETENESS_STATUS.UNSUPPORTED
    ),
    requirement:
      options.requirement || scope.ABYSSAL_CONTENT_COMPONENT_REQUIREMENT.REQUIRED,
    requiredFromLevel:
      options.requiredFromLevel || scope.ABYSSAL_CONTENT_COMPLETENESS_LEVEL.PLAYABLE,
    authorityAffectsEvidence: options.authorityAffectsEvidence !== false,
    debugAllowed: options.debugAllowed === true,
    blockers: (0, scope.cloneValue)(options.blockers || []),
    details: (0, scope.cloneValue)(options.details || {}),
  };
}

function listEncounterNpcCandidatesOperation(scope, encounterProfile = null) {
  return scope.ABYSSAL_ENCOUNTER_RESOLVER
    .listEncounterNpcCandidates(encounterProfile);
}

function auditEncounterNpcRuntimeCompletenessOperation(scope, encounterProfile = null) {
  return scope.ABYSSAL_ENCOUNTER_RESOLVER
    .auditEncounterNpcRuntimeCompleteness(encounterProfile);
}

function buildAbyssalSpaceEmpiricalEncounterAuthorityProfileOperation(scope,
  definition,
  roomIndex,
) {
  const tier = (0, scope.toInteger)(definition && definition.tier, -1);
  const empiricalContentEnabled =
    (
      tier === 0 &&
      scope.T0_TRANQUIL_FILAMENT_TYPE_IDS.includes(
        (0, scope.toInteger)(definition && definition.filamentTypeID, 0),
      ) &&
      (0, scope.shouldUseTier0AbyssalSpaceEmpiricalContent)(definition)
    ) ||
    (
      tier === 1 &&
      (0, scope.shouldUseTier1AbyssalSpaceEmpiricalContent)(definition)
    ) ||
    (
      tier === 2 &&
      (0, scope.shouldUseTier2AbyssalSpaceEmpiricalContent)(definition)
    ) ||
    (
      tier === 3 &&
      (0, scope.shouldUseTier3AbyssalSpaceEmpiricalContent)(definition)
    ) ||
    (
      tier === 4 &&
      (0, scope.shouldUseTier4AbyssalSpaceEmpiricalContent)(definition)
    ) ||
    (
      tier === 5 &&
      (0, scope.shouldUseTier5AbyssalSpaceEmpiricalContent)(definition)
    ) ||
    (
      tier === 6 &&
      (0, scope.shouldUseTier6AbyssalSpaceEmpiricalContent)(definition)
    );
  return scope.ABYSSAL_ENCOUNTER_RESOLVER
    .buildEmpiricalEncounterAuthorityProfile({
      tier,
      weatherType: definition && definition.weatherType,
      roomIndex,
      empiricalContentEnabled,
    });
}

function buildAbyssalSpaceRewardCacheAuthorityProfileOperation(scope, definition, roomIndex) {
  const encounterAuthority =
    (0, scope.buildAbyssalSpaceEmpiricalEncounterAuthorityProfile)(definition, roomIndex);
  if (!encounterAuthority) return null;
  const tier = (0, scope.toInteger)(definition && definition.tier, -1);
  const weatherType = String(definition && definition.weatherType || "")
    .trim()
    .toLowerCase();
  const runtimeProfiles = scope.ABYSSAL_ENCOUNTER_RESOLVER
    .getAbyssalSpaceEncounterPartition({
      tier,
      weatherType,
      roomIndex,
    }).filter(
    (profile) =>
      (
        tier === 0
          ? (0, scope.isTier0AbyssalSpaceEncounterProfile)(profile)
          : tier === 1
            ? (0, scope.isTier1AbyssalSpaceEncounterProfile)(profile)
            : tier === 2
              ? (0, scope.isTier2AbyssalSpaceEncounterProfile)(profile)
              : tier === 3
                ? (0, scope.isTier3AbyssalSpaceEncounterProfile)(profile)
              : tier === 4
                ? (0, scope.isTier4AbyssalSpaceEncounterProfile)(profile)
                : tier === 5
                  ? (0, scope.isTier5AbyssalSpaceEncounterProfile)(profile)
                  : (0, scope.isTier6AbyssalSpaceEncounterProfile)(profile)
      ),
  );
  const fallbackCacheProfile = definition && definition.cacheProfile || {};
  const cacheProfiles = runtimeProfiles.map((profile) =>
    profile && profile.cacheProfileOverride || fallbackCacheProfile
  );
  const cacheIdentities = [...new Map(cacheProfiles
    .filter((profile) => (0, scope.toInteger)(profile && profile.cacheTypeID, 0) > 0)
    .map((profile) => [
      `${(0, scope.toInteger)(profile.cacheTypeID, 0)}:${(0, scope.toInteger)(profile.wreckTypeID, 0)}`,
      {
        cacheTypeID: (0, scope.toInteger)(profile.cacheTypeID, 0),
        wreckTypeID: (0, scope.toInteger)(profile.wreckTypeID, 0),
        cacheFamily: String(profile.cacheFamily || ""),
      },
    ])).values()];
  return {
    profileID:
      `abyssal:cache:t${tier}-${weatherType}:room-${roomIndex}:observed-identity-authored-allocation-v1`,
    contentAuthority: scope.ABYSSAL_CONTENT_AUTHORITY.PROJECT_AUTHORED,
    evidenceRefs: [
      ...(tier === 0 && weatherType === "dark"
        ? ["docs/tqlogs.zip:TQTranquilAbyssal5.txt"]
        : []),
      "tools/AbyssalData/data/abyssal-runs-all-tiers.csv.gz",
      tier === 0
        ? "server/src/space/abyssal/content/tier0AbyssalSpaceTelemetry.generated.json"
      : tier === 1
        ? "server/src/space/abyssal/content/tier1AbyssalSpaceTelemetry.generated.json"
        : tier === 2
          ? "server/src/space/abyssal/content/tier2AbyssalSpaceTelemetry.generated.json"
          : tier === 3
            ? "server/src/space/abyssal/content/tier3AbyssalSpaceTelemetry.generated.json"
            : tier === 4
              ? "server/src/space/abyssal/content/tier4AbyssalSpaceTelemetry.generated.json"
              : tier === 5
                ? "server/src/space/abyssal/content/tier5AbyssalSpaceTelemetry.generated.json"
                : "server/src/space/abyssal/content/tier6AbyssalSpaceTelemetry.generated.json",
      ...(tier === 0 && weatherType === "dark"
        ? ["doc/abyssal/t0-dark-retail-layout-audit.md#cache-wreck-and-loot-evidence"]
        : []),
    ],
    roomIndex,
    cacheIdentityAuthority: scope.ABYSSAL_CONTENT_AUTHORITY.OBSERVED_EMPIRICAL,
    rewardManifestAuthority: scope.ABYSSAL_CONTENT_AUTHORITY.OBSERVED_EMPIRICAL,
    perRoomAllocationAuthority: scope.ABYSSAL_CONTENT_AUTHORITY.PROJECT_AUTHORED,
    perRoomDistributionStatus: "provisional_distribution",
    cacheIdentities,
    runtimeReadyProfileCount: runtimeProfiles.length,
    observedProfilesWithoutCacheIdentity: runtimeProfiles.filter(
      (profile) => !profile || !profile.cacheProfileOverride,
    ).length,
    allocationModel: "deterministic-project-authored-three-room-partition",
    sourceProvidesPerRoomLootAttribution: false,
  };
}

function buildResolvedContentComponentsOperation(scope, definition, context = {}) {

  const roomCount = context.roomCount;
  const environmentProfile = context.environmentProfile;
  const capturedSelection = context.capturedSelection === true;
  const observedSelection = context.observedSelection === true;
  const policy = context.policy;
  const development = policy === scope.ABYSSAL_CONTENT_COMPLETENESS_POLICY.DEVELOPMENT;
  const roomProfile = definition && definition.roomProfile || {};
  const timerDurationMs = (0, scope.toInteger)(definition && definition.timerDurationMs, 0);
  const authoredSelection = definition && definition.authoredContentSelection;
  const capturedFallbackUsed = Boolean(
    authoredSelection &&
    authoredSelection.selected !== true &&
    authoredSelection.fallbackUsed === true
  );
  const capturedFallbackReason = String(
    authoredSelection && (
      authoredSelection.errorCode || authoredSelection.errorMsg
    ) || "",
  );
  const transitionAuthority = context.transitionAuthority;
  const capturedTransition =
    transitionAuthority === scope.ABYSSAL_CONTENT_AUTHORITY.CAPTURED_RETAIL;
  const filamentTypeID = (0, scope.toInteger)(definition && definition.filamentTypeID, 0);
  const t0Dark = filamentTypeID === scope.T0_DARK_FILAMENT_TYPE_ID;
  const t0Tranquil = scope.T0_TRANQUIL_FILAMENT_TYPE_IDS.includes(filamentTypeID);
  const tier1Calm = (0, scope.toInteger)(definition && definition.tier, -1) === 1 &&
    (0, scope.shouldUseTier1AbyssalSpaceEmpiricalContent)(definition);
  const tier2Agitated = (0, scope.toInteger)(definition && definition.tier, -1) === 2 &&
    (0, scope.shouldUseTier2AbyssalSpaceEmpiricalContent)(definition);
  const tier3Fierce = (0, scope.toInteger)(definition && definition.tier, -1) === 3 &&
    (0, scope.shouldUseTier3AbyssalSpaceEmpiricalContent)(definition);
  const tier4Raging = (0, scope.toInteger)(definition && definition.tier, -1) === 4 &&
    (0, scope.shouldUseTier4AbyssalSpaceEmpiricalContent)(definition);
  const tier5Chaotic = (0, scope.toInteger)(definition && definition.tier, -1) === 5 &&
    (0, scope.shouldUseTier5AbyssalSpaceEmpiricalContent)(definition);
  const tier6Cataclysmic = (0, scope.toInteger)(definition && definition.tier, -1) === 6 &&
    (0, scope.shouldUseTier6AbyssalSpaceEmpiricalContent)(definition);
  const tier1Through6Empirical =
    tier1Calm || tier2Agitated || tier3Fierce || tier4Raging || tier5Chaotic ||
    tier6Cataclysmic;
  const weatherProfile = definition && definition.weatherProfile || {};
  const weatherAuthorityFacets = weatherProfile.authorityFacets || {};
  const weatherMechanicsContract = t0Tranquil || tier1Through6Empirical
    ? weatherAuthorityFacets.observedMechanicsContract ||
      weatherAuthorityFacets.mechanicsContract ||
      null
    : null;
  const traceAuthority = context.traceAuthority ||
    scope.SHARED_ABYSSAL_ENTRANCE_TRACE_PROFILE.contentAuthority;
  const traceAuthorityFacets =
    scope.SHARED_ABYSSAL_ENTRANCE_TRACE_PROFILE.authorityFacets || {};
  const traceContract = t0Dark
    ? traceAuthorityFacets.t0DarkObservedContract || null
    : t0Tranquil
      ? traceAuthorityFacets.t0TranquilBaselineContract || null
    : tier1Calm
      ? traceAuthorityFacets.tier1CalmBaselineContract || null
    : tier2Agitated
      ? traceAuthorityFacets.tier2AgitatedBaselineContract || null
    : tier3Fierce
      ? traceAuthorityFacets.tier3FierceBaselineContract || null
    : tier4Raging
      ? traceAuthorityFacets.tier4RagingBaselineContract || null
    : tier5Chaotic
      ? traceAuthorityFacets.tier5ChaoticBaselineContract || null
    : tier6Cataclysmic
      ? traceAuthorityFacets.tier6CataclysmicBaselineContract || null
    : null;
  const objectiveEvidenceProfile = t0Dark
    ? {
      profileID: "abyssal:objective:t0-dark:captured-kill-required-hostiles-v1",
      contentAuthority: scope.ABYSSAL_CONTENT_AUTHORITY.CAPTURED_RETAIL,
      objectiveType: "kill_required_hostiles",
      evidenceRefs: [
        "docs/tqlogs.zip:TQTranquilAbyssal5.txt:44421-44578,104603-104680",
        "doc/abyssal/t0-dark-transition-presentation-audit.md",
        "doc/abyssal/t0-dark-retail-layout-audit.md#exact-npc-roster",
      ],
    }
    : null;
  const boundaryAuthority = context.boundaryAuthority ||
    scope.UNSTABLE_ABYSSAL_DEPTHS_BOUNDARY_PROFILE.contentAuthority;
  const boundaryAuthorityFacets =
    scope.UNSTABLE_ABYSSAL_DEPTHS_BOUNDARY_PROFILE.authorityFacets || {};
    return (0, scope.assembleResolvedRunContentComponents)({
      definition,
      context,
      roomCount,
      environmentProfile,
      capturedSelection,
      observedSelection,
      policy,
      development,
      roomProfile,
      timerDurationMs,
      authoredSelection,
      capturedFallbackUsed,
      capturedFallbackReason,
      transitionAuthority,
      capturedTransition,
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
      weatherProfile,
      weatherAuthorityFacets,
      weatherMechanicsContract,
      traceAuthority,
      traceAuthorityFacets,
      traceContract,
      objectiveEvidenceProfile,
      boundaryAuthority,
      boundaryAuthorityFacets,
    });
  }

function assembleResolvedRunContentComponentsOperation(scope, attempt) {
    const {
      definition, t0Dark, development, weatherMechanicsContract, weatherProfile, weatherAuthorityFacets,
      traceAuthority, t0Tranquil, tier1Through6Empirical, traceContract, timerDurationMs,
      objectiveEvidenceProfile, roomCount, capturedTransition, transitionAuthority, roomProfile,
      boundaryAuthority, boundaryAuthorityFacets, tier1Calm, tier2Agitated, tier3Fierce, tier4Raging,
      tier5Chaotic, tier6Cataclysmic, traceAuthorityFacets,
    } = attempt;
const components = [
    (0, scope.buildCompletenessFilamentDefinitionComponent)({
      definition, t0Dark, development,
    }),
    (0, scope.buildCompletenessWeatherComponent)({
      weatherMechanicsContract, definition, weatherProfile, development, t0Dark, weatherAuthorityFacets,
    }),
    (0, scope.buildCompletenessEntryTraceComponent)({
      definition, traceAuthority, t0Tranquil, tier1Through6Empirical, traceContract, development, t0Dark,
    }),
    (0, scope.buildCompletenessRunTimerComponent)({
      definition, timerDurationMs, development,
    }),
    (0, scope.buildCompletenessTimeoutPolicyComponent)({
      definition, timerDurationMs, development,
    }),
    (0, scope.buildCompletenessObjectivePolicyComponent)({
      objectiveEvidenceProfile, definition, roomCount, development,
    }),
    (0, scope.buildCompletenessEntryTransitionComponent)({
      capturedTransition, transitionAuthority, definition, development,
    }),
    (0, scope.buildCompletenessRoomTransferComponent)({
      capturedTransition, transitionAuthority, roomCount, roomProfile, development,
    }),
    (0, scope.buildCompletenessFinalExitComponent)({
      capturedTransition, transitionAuthority, roomProfile, development,
    }),
    (0, scope.buildCompletenessBoundaryPolicyComponent)({
      boundaryAuthority, t0Dark, boundaryAuthorityFacets, t0Tranquil, tier1Calm, tier2Agitated, tier3Fierce,
      tier4Raging, tier5Chaotic, tier6Cataclysmic, development,
    }),
  ];

  if ((t0Tranquil && !t0Dark) || tier1Through6Empirical) {
    const weatherStageSelection = weatherAuthorityFacets.stageSelection || {};
    const weatherStageSelectionWeights =
      weatherAuthorityFacets.stageSelectionWeights || {};
    components.push(
      (0, scope.buildCompletenessWeatherStageSelectionComponent)({
        weatherStageSelection, development,
      }),
      (0, scope.buildCompletenessWeatherStageSelectionWeightsComponent)({
        weatherStageSelectionWeights, weatherStageSelection, development,
      }),
    );
  }

  if (t0Dark) {
    const capturedWeatherPresentation =
      weatherAuthorityFacets.capturedStageOnePresentation || {};
    const stageTwoWeatherPresentation =
      weatherAuthorityFacets.stageTwoPresentation || {};
    const weatherStageSelection = weatherAuthorityFacets.stageSelection || {};
    const weatherStageSelectionWeights =
      weatherAuthorityFacets.stageSelectionWeights || {};
    const traceIdentityPresentation =
      traceAuthorityFacets.t0DarkIdentityPresentation || {};
    const traceInteractionPolicy = traceAuthorityFacets.interactionPolicy || {};
    const tracePostReturnLifetime = traceAuthorityFacets.postReturnLifetime || {};
    const boundaryDamageModel = boundaryAuthorityFacets.damageModel || {};
    components.push(
      (0, scope.buildCompletenessWeatherCapturedPresentationComponent)({
        capturedWeatherPresentation, development,
      }),
      (0, scope.buildCompletenessWeatherStage2PresentationComponent)({
        stageTwoWeatherPresentation, development,
      }),
      (0, scope.buildCompletenessCapturedWeatherStageSelectionComponent)({
        weatherStageSelection, development,
      }),
      (0, scope.buildCompletenessCapturedWeatherStageSelectionWeightsComponent)({
        weatherStageSelectionWeights, development,
      }),
      (0, scope.buildCompletenessEntryTraceIdentityPresentationComponent)({
        traceIdentityPresentation, development,
      }),
      (0, scope.buildCompletenessEntryTracePostReturnLifetimeComponent)({
        tracePostReturnLifetime, development,
      }),
      (0, scope.buildCompletenessEntryTraceInteractionPolicyComponent)({
        traceInteractionPolicy, development,
      }),
      (0, scope.buildCompletenessBoundaryDamageModelComponent)({
        boundaryDamageModel, development,
      }),
    );
  }
    return (0, scope.appendResolvedRoomContentComponents)({
      ...attempt,
      components,
    });
  }

function appendResolvedRoomContentComponentsOperation(scope, attempt) {
    const {
      roomCount, definition, context, capturedFallbackUsed, capturedFallbackReason, environmentProfile,
      components, observedSelection, capturedSelection, development,
    } = attempt;
for (let roomIndex = 1; roomIndex <= roomCount; roomIndex += 1) {
    const encounterProfile = definition && definition.roomEncounterProfilesByIndex &&
      (definition.roomEncounterProfilesByIndex[String(roomIndex)] ||
        definition.roomEncounterProfilesByIndex[roomIndex]) || null;
    const empiricalEncounterAuthority =
      context.abyssalSpaceEmpiricalSelection === true
      ? (0, scope.buildAbyssalSpaceEmpiricalEncounterAuthorityProfile)(
        definition,
        roomIndex,
      )
      : null;
    const reportedEncounterProfile = empiricalEncounterAuthority || encounterProfile;
    const rewardCacheAuthority = context.abyssalSpaceEmpiricalSelection === true
      ? (0, scope.buildAbyssalSpaceRewardCacheAuthorityProfile)(definition, roomIndex)
      : null;
    const rewardProfile = empiricalEncounterAuthority
      ? definition && definition.rewardProfile || null
      : encounterProfile && encounterProfile.rewardProfileOverride ||
        definition && definition.rewardProfile || null;
    const extractionProfile = encounterProfile &&
      encounterProfile.extractionNodeProfileOverride ||
      definition && definition.extractionNodeProfile || null;
    const extractionApplicable = (0, scope.isExtractionProfileApplicableToRoom)(
      extractionProfile,
      roomIndex,
      (0, scope.toInteger)(definition && definition.tier, 0),
    );
    const npcRuntime = empiricalEncounterAuthority
      ? {
        runtimeValid:
          empiricalEncounterAuthority.runtimeReadyProfileCount > 0,
        completeness:
          empiricalEncounterAuthority.runtimeReadyProfileCount > 0
            ? scope.ABYSSAL_CONTENT_COMPLETENESS_STATUS.COMPLETE
            : scope.ABYSSAL_CONTENT_COMPLETENESS_STATUS.MISSING,
        npcCount: empiricalEncounterAuthority.runtimeReadyProfileCount,
        results: [],
      }
      : (0, scope.auditEncounterNpcRuntimeCompleteness)(encounterProfile);
    const entryFallback = (0, scope.listEncounterNpcCandidates)(reportedEncounterProfile)
      .find((entry) => entry.fallbackUsed === true) || null;
    const encounterFallbackUsed = empiricalEncounterAuthority
      ? false
      : capturedFallbackUsed || Boolean(entryFallback);
    const encounterFallbackReason = empiricalEncounterAuthority
      ? ""
      : capturedFallbackUsed
      ? capturedFallbackReason || "CAPTURED_CONTENT_UNAVAILABLE"
      : entryFallback && entryFallback.fallbackReason || "";
    const environmentFallbackUsed = Boolean(
      environmentProfile && environmentProfile.fallbackGenerated === true
    );
    const rewardRuntimeValid = Boolean(
      rewardProfile && rewardProfile.rewardProfileID &&
      String(rewardProfile.quantityPolicy || "").trim() &&
      (0, scope.toInteger)(rewardProfile.unresolvedLootReferenceCount, 0) === 0
    );
    const roomPath = `rooms.${roomIndex}`;
    components.push(
      (0, scope.buildCompletenessEncounterComponent)({
        roomPath, roomIndex, reportedEncounterProfile, empiricalEncounterAuthority, observedSelection,
        encounterProfile, capturedSelection, encounterFallbackUsed, encounterFallbackReason,
        capturedFallbackUsed, development,
      }),
      (0, scope.buildCompletenessNpcCompositionComponent)({
        roomPath, roomIndex, reportedEncounterProfile, empiricalEncounterAuthority, observedSelection,
        encounterProfile, npcRuntime, capturedSelection, encounterFallbackUsed, encounterFallbackReason,
        capturedFallbackUsed, development,
      }),
      (0, scope.buildCompletenessNpcRuntimeSupportComponent)({
        roomPath, roomIndex, reportedEncounterProfile, npcRuntime, empiricalEncounterAuthority, development,
      }),
      (0, scope.buildCompletenessEnvironmentComponent)({
        roomPath, roomIndex, environmentProfile, environmentFallbackUsed, development,
      }),
      (0, scope.buildCompletenessRewardsComponent)({
        roomPath, roomIndex, rewardProfile, rewardRuntimeValid, development,
      }),
      (0, scope.buildCompletenessRewardQuantityPolicyComponent)({
        roomPath, roomIndex, rewardProfile, development,
      }),
      (0, scope.buildCompletenessRewardCachePolicyComponent)({
        roomPath, roomIndex, rewardCacheAuthority, definition, development,
      }),
      (0, scope.buildCompletenessRewardCacheIdentityComponent)({
        roomPath, roomIndex, rewardCacheAuthority, definition, development,
      }),
      (0, scope.buildCompletenessRewardCacheAllocationComponent)({
        roomPath, roomIndex, rewardCacheAuthority, definition, development,
      }),
      (0, scope.buildCompletenessFunctionalSuppressorsComponent)({
        roomPath, roomIndex, development,
      }),
      (0, scope.buildCompletenessExtractionNodesComponent)({
        roomPath, roomIndex, extractionApplicable, extractionProfile, development,
      }),
    );
  }

  return components;
  }

function buildCompletenessFilamentDefinitionComponentOperation(scope, {
  definition, t0Dark, development,
}) {
  return (0, scope.buildContentComponent)({
    component: "filament_definition",
    resolvedProfileID: definition && definition.definitionID,
    authority: definition && definition.definitionContentAuthority,
    runtimeValid: (0, scope.toInteger)(definition && definition.filamentTypeID, 0) > 0,
    profile: t0Dark
      ? {
        profileID: definition && definition.definitionID,
        evidenceRefs: [
          "docs/tqlogs.zip:TQTranquilAbyssal5.txt",
          "doc/abyssal/t0-dark-retail-layout-audit.md",
        ],
      }
      : definition,
    provenance: {
      sourceID: definition && definition.definitionID,
      sourceType: "filament_definition_registry",
    },
    details: t0Dark
      ? {
        capturedStructuralFields: [
          "filamentTypeID",
          "tier",
          "weatherType",
          "roomCount",
        ],
        projectAuthoredPolicyFields: [
          "allowedHullModes",
          "requiredFilamentsByHullMode",
          "maxShipsByHullMode",
          "activationRequirements",
        ],
        aggregateAuthorityRetainedAtWeakestMajorPolicy:
          scope.ABYSSAL_CONTENT_AUTHORITY.PROJECT_AUTHORED,
      }
      : {},
    debugAllowed: development,
  });
}

function buildCompletenessWeatherComponentOperation(scope, {
  weatherMechanicsContract, definition, weatherProfile, development, t0Dark, weatherAuthorityFacets,
}) {
  return (0, scope.buildContentComponent)({
    component: "weather",
    resolvedProfileID: weatherMechanicsContract && weatherMechanicsContract.profileID ||
      `abyssal:weather:${String(
        definition && definition.weatherType || "unknown",
      )}:${String(
        weatherProfile.penaltyBandKey || "default",
      )}`,
    authority: weatherMechanicsContract && weatherMechanicsContract.contentAuthority ||
      weatherProfile.contentAuthority,
    runtimeValid: Boolean(weatherProfile.weatherType),
    profile: weatherMechanicsContract || weatherProfile,
    requiredFromLevel: scope.ABYSSAL_CONTENT_COMPLETENESS_LEVEL.BASELINE_COMPLETE,
    debugAllowed: development,
    details: t0Dark
      ? {
        authorityScope: "captured-dark-weather-effect-contract",
        capturedEffectModel: weatherMechanicsContract &&
          weatherMechanicsContract.effectModel || "",
        capturedBonusStrengthPercent: weatherMechanicsContract &&
          weatherMechanicsContract.capturedBonusStrengthPercent || 0,
        capturedPenaltyStrengthPercent: weatherMechanicsContract &&
          weatherMechanicsContract.capturedPenaltyStrengthPercent || 0,
        exactStageSelectionExcluded: true,
        exactStageWeightsExcluded: true,
        capturedPresentationTypeIDs: (0, scope.cloneValue)(
          weatherAuthorityFacets.capturedStageOnePresentation &&
            weatherAuthorityFacets.capturedStageOnePresentation.weatherObjectTypeIDs || [],
        ),
      }
      : {},
  });
}

function buildCompletenessEntryTraceComponentOperation(scope, {
  definition, traceAuthority, t0Tranquil, tier1Through6Empirical, traceContract, development, t0Dark,
}) {
  return (0, scope.buildContentComponent)({
    component: "entry_trace",
    resolvedProfileID: definition && definition.traceProfileID,
    authority: traceAuthority,
    runtimeValid: Boolean(
      definition && definition.traceProfileID &&
      scope.SHARED_ABYSSAL_ENTRANCE_TRACE_PROFILE.typeID
    ),
    profile: t0Tranquil || tier1Through6Empirical
      ? traceContract
      : scope.SHARED_ABYSSAL_ENTRANCE_TRACE_PROFILE,
    provenance: { sourceType: "entry_trace_profile" },
    debugAllowed: development,
    details: t0Dark
      ? {
        runtimeTraceProfileID:
          scope.SHARED_ABYSSAL_ENTRANCE_TRACE_PROFILE.traceProfileID,
        capturedTypeID: scope.SHARED_ABYSSAL_ENTRANCE_TRACE_PROFILE.typeID,
        authorityScope: (0, scope.cloneValue)(
          traceContract && traceContract.scope || [],
        ),
        excludedPolicyFacets: (0, scope.cloneValue)(
          traceContract && traceContract.excludedPolicyFacets || [],
        ),
      }
      : {},
  });
}

function buildCompletenessRunTimerComponentOperation(scope, {
  definition, timerDurationMs, development,
}) {
  return (0, scope.buildContentComponent)({
    component: "run_timer",
    resolvedProfileID: "abyssal:timer:twenty-minute-runtime-v1",
    authority: definition && definition.timerPolicyAuthority,
    runtimeValid: timerDurationMs > 0,
    provenance: {
      sourceType: "runtime_policy",
      evidenceRefs: [
        "server/src/space/abyssal/abyssalRuntimeConstants.js",
        "server/tests/abyssalRuntimeConstants.test.js",
        "server/tests/abyssalMgrService.test.js:Tier 0 Dark timer contracts",
      ],
    },
    details: {
      timerDurationMs,
      retailExactTimeoutThresholdCaptured: false,
      retailExactWarningAndDeathSequenceCaptured: false,
    },
    debugAllowed: development,
  });
}

function buildCompletenessTimeoutPolicyComponentOperation(scope, {
  definition, timerDurationMs, development,
}) {
  return (0, scope.buildContentComponent)({
    component: "timeout_policy",
    resolvedProfileID: "abyssal:timeout:lethal-ship-and-capsule-v1",
    authority: definition && definition.timeoutPolicyAuthority,
    runtimeValid: timerDurationMs > 0,
    provenance: { sourceType: "runtime_policy" },
    debugAllowed: development,
  });
}

function buildCompletenessObjectivePolicyComponentOperation(scope, {
  objectiveEvidenceProfile, definition, roomCount, development,
}) {
  return (0, scope.buildContentComponent)({
    component: "objective_policy",
    resolvedProfileID: objectiveEvidenceProfile && objectiveEvidenceProfile.profileID ||
      "abyssal:objective:kill-required-hostiles-v1",
    authority: objectiveEvidenceProfile && objectiveEvidenceProfile.contentAuthority ||
      definition && definition.objectivePolicyAuthority,
    runtimeValid: roomCount > 0,
    profile: objectiveEvidenceProfile,
    provenance: { sourceType: objectiveEvidenceProfile
      ? "captured_objective_progression"
      : "runtime_policy" },
    details: objectiveEvidenceProfile
      ? {
        objectiveType: objectiveEvidenceProfile.objectiveType,
        capturedRoomCount: 3,
        observedTransition:
          "required-hostile-destruction-unlocks-current-room-conduit",
      }
      : {},
    debugAllowed: development,
  });
}

function buildCompletenessEntryTransitionComponentOperation(scope, {
  capturedTransition, transitionAuthority, definition, development,
}) {
  return (0, scope.buildContentComponent)({
    component: "entry_transition",
    resolvedProfileID: capturedTransition && scope.T0_DARK_TRANSITION_PROFILES
      ? scope.T0_DARK_TRANSITION_PROFILES.profiles.entry.transitionProfileID
      : "abyssal:transition:project-entry-v1",
    authority: transitionAuthority,
    runtimeValid: Boolean(definition && definition.traceProfileID),
    profile: capturedTransition ? scope.T0_DARK_TRANSITION_PROFILES : null,
    provenance: { sourceType: "transition_profile" },
    debugAllowed: development,
  });
}

function buildCompletenessRoomTransferComponentOperation(scope, {
  capturedTransition, transitionAuthority, roomCount, roomProfile, development,
}) {
  return (0, scope.buildContentComponent)({
    component: "room_transfer",
    resolvedProfileID: capturedTransition && scope.T0_DARK_TRANSITION_PROFILES
      ? scope.T0_DARK_TRANSITION_PROFILES.profiles["room-transfer"].transitionProfileID
      : "abyssal:transition:project-room-transfer-v1",
    authority: transitionAuthority,
    runtimeValid: roomCount > 1 && Boolean(roomProfile.transferConduitLabel),
    profile: capturedTransition ? scope.T0_DARK_TRANSITION_PROFILES : null,
    provenance: { sourceType: "transition_profile" },
    debugAllowed: development,
  });
}

function buildCompletenessFinalExitComponentOperation(scope, {
  capturedTransition, transitionAuthority, roomProfile, development,
}) {
  return (0, scope.buildContentComponent)({
    component: "final_exit",
    resolvedProfileID: capturedTransition && scope.T0_DARK_TRANSITION_PROFILES
      ? scope.T0_DARK_TRANSITION_PROFILES.profiles["final-exit"].transitionProfileID
      : "abyssal:transition:project-final-exit-v1",
    authority: transitionAuthority,
    runtimeValid: Boolean(
      roomProfile.finalExitAvailableOnCompletion &&
      roomProfile.finalExitConduitLabel
    ),
    profile: capturedTransition ? scope.T0_DARK_TRANSITION_PROFILES : null,
    provenance: { sourceType: "transition_profile" },
    debugAllowed: development,
  });
}

function buildCompletenessBoundaryPolicyComponentOperation(scope, {
  boundaryAuthority, t0Dark, boundaryAuthorityFacets, t0Tranquil, tier1Calm, tier2Agitated, tier3Fierce,
  tier4Raging, tier5Chaotic, tier6Cataclysmic, development,
}) {
  return (0, scope.buildContentComponent)({
    component: "boundary_policy",
    resolvedProfileID:
      scope.UNSTABLE_ABYSSAL_DEPTHS_BOUNDARY_PROFILE.profileID ||
      "abyssal:boundary:unstable-depths-v1",
    authority: boundaryAuthority,
    runtimeValid: Number(
      scope.UNSTABLE_ABYSSAL_DEPTHS_BOUNDARY_PROFILE.perimeterRadiusMeters,
    ) > 0,
    profile: t0Dark
      ? boundaryAuthorityFacets.t0DarkPolicy
      : t0Tranquil
        ? boundaryAuthorityFacets.t0TranquilPolicy
      : tier1Calm
        ? boundaryAuthorityFacets.tier1CalmPolicy
      : tier2Agitated
        ? boundaryAuthorityFacets.tier2AgitatedPolicy
      : tier3Fierce
        ? boundaryAuthorityFacets.tier3FiercePolicy
      : tier4Raging
        ? boundaryAuthorityFacets.tier4RagingPolicy
      : tier5Chaotic
        ? boundaryAuthorityFacets.tier5ChaoticPolicy
      : tier6Cataclysmic
        ? boundaryAuthorityFacets.tier6CataclysmicPolicy
      : scope.UNSTABLE_ABYSSAL_DEPTHS_BOUNDARY_PROFILE,
    provenance: { sourceType: "boundary_profile" },
    requiredFromLevel: scope.ABYSSAL_CONTENT_COMPLETENESS_LEVEL.BASELINE_COMPLETE,
    debugAllowed: development,
    details: t0Dark
      ? {
        perimeterRadiusMeters:
          scope.UNSTABLE_ABYSSAL_DEPTHS_BOUNDARY_PROFILE.perimeterRadiusMeters,
        tickIntervalMs:
          scope.UNSTABLE_ABYSSAL_DEPTHS_BOUNDARY_PROFILE.tickIntervalMs,
        sourceName:
          scope.UNSTABLE_ABYSSAL_DEPTHS_BOUNDARY_PROFILE.sourceName,
      }
      : {},
  });
}

function bindAbyssalFilamentCompletenessCoreOperations(scope) {
  scope.readDebugFallbackEnabled = function readDebugFallbackEnabled(options = {}) {
    return readDebugFallbackEnabledOperation(scope, options);
  };
  scope.resolveProfileContentAuthority = function resolveProfileContentAuthority(profile, fallbackAuthority, context) {
    return resolveProfileContentAuthorityOperation(scope, profile, fallbackAuthority, context);
  };
  scope.isExtractionProfileApplicableToRoom = function isExtractionProfileApplicableToRoom(profile, roomIndex, tier) {
    return isExtractionProfileApplicableToRoomOperation(scope, profile, roomIndex, tier);
  };
  scope.listContentEvidenceRefs = function listContentEvidenceRefs(profile = null) {
    return listContentEvidenceRefsOperation(scope, profile);
  };
  scope.buildContentProvenance = function buildContentProvenance(profile, options = {}) {
    return buildContentProvenanceOperation(scope, profile, options);
  };
  scope.buildContentComponent = function buildContentComponent(options = {}) {
    return buildContentComponentOperation(scope, options);
  };
  scope.listEncounterNpcCandidates = function listEncounterNpcCandidates(encounterProfile = null) {
    return listEncounterNpcCandidatesOperation(scope, encounterProfile);
  };
  scope.auditEncounterNpcRuntimeCompleteness = function auditEncounterNpcRuntimeCompleteness(encounterProfile = null) {
    return auditEncounterNpcRuntimeCompletenessOperation(scope, encounterProfile);
  };
  scope.buildAbyssalSpaceEmpiricalEncounterAuthorityProfile = function buildAbyssalSpaceEmpiricalEncounterAuthorityProfile(definition,
  roomIndex) {
    return buildAbyssalSpaceEmpiricalEncounterAuthorityProfileOperation(scope, definition, roomIndex);
  };
  scope.buildAbyssalSpaceRewardCacheAuthorityProfile = function buildAbyssalSpaceRewardCacheAuthorityProfile(definition, roomIndex) {
    return buildAbyssalSpaceRewardCacheAuthorityProfileOperation(scope, definition, roomIndex);
  };
  scope.buildResolvedContentComponents = function buildResolvedContentComponents(definition, context = {}) {
    return buildResolvedContentComponentsOperation(scope, definition, context);
  };
  scope.assembleResolvedRunContentComponents = function assembleResolvedRunContentComponents(attempt) {
    return assembleResolvedRunContentComponentsOperation(scope, attempt);
  };
  scope.appendResolvedRoomContentComponents = function appendResolvedRoomContentComponents(attempt) {
    return appendResolvedRoomContentComponentsOperation(scope, attempt);
  };
  scope.buildCompletenessFilamentDefinitionComponent = function buildCompletenessFilamentDefinitionComponent(...args) {
    return buildCompletenessFilamentDefinitionComponentOperation(scope, ...args);
  };
  scope.buildCompletenessWeatherComponent = function buildCompletenessWeatherComponent(...args) {
    return buildCompletenessWeatherComponentOperation(scope, ...args);
  };
  scope.buildCompletenessEntryTraceComponent = function buildCompletenessEntryTraceComponent(...args) {
    return buildCompletenessEntryTraceComponentOperation(scope, ...args);
  };
  scope.buildCompletenessRunTimerComponent = function buildCompletenessRunTimerComponent(...args) {
    return buildCompletenessRunTimerComponentOperation(scope, ...args);
  };
  scope.buildCompletenessTimeoutPolicyComponent = function buildCompletenessTimeoutPolicyComponent(...args) {
    return buildCompletenessTimeoutPolicyComponentOperation(scope, ...args);
  };
  scope.buildCompletenessObjectivePolicyComponent = function buildCompletenessObjectivePolicyComponent(...args) {
    return buildCompletenessObjectivePolicyComponentOperation(scope, ...args);
  };
  scope.buildCompletenessEntryTransitionComponent = function buildCompletenessEntryTransitionComponent(...args) {
    return buildCompletenessEntryTransitionComponentOperation(scope, ...args);
  };
  scope.buildCompletenessRoomTransferComponent = function buildCompletenessRoomTransferComponent(...args) {
    return buildCompletenessRoomTransferComponentOperation(scope, ...args);
  };
  scope.buildCompletenessFinalExitComponent = function buildCompletenessFinalExitComponent(...args) {
    return buildCompletenessFinalExitComponentOperation(scope, ...args);
  };
  scope.buildCompletenessBoundaryPolicyComponent = function buildCompletenessBoundaryPolicyComponent(...args) {
    return buildCompletenessBoundaryPolicyComponentOperation(scope, ...args);
  };
}

module.exports = {
  bindAbyssalFilamentCompletenessCoreOperations,
};
