"use strict";

function buildCompletenessWeatherStageSelectionComponentOperation(scope, {
  weatherStageSelection, development,
}) {
  return (0, scope.buildContentComponent)({
    component: "weather_stage_selection",
    path: "weather.stage_selection",
    resolvedProfileID: weatherStageSelection.profileID,
    authority: weatherStageSelection.contentAuthority,
    runtimeValid: Array.isArray(weatherStageSelection.allowedWeatherObjectTypeIDs) &&
      weatherStageSelection.allowedWeatherObjectTypeIDs.length > 0,
    profile: weatherStageSelection,
    provenance: { sourceType: "weather_stage_selection_policy" },
    requiredFromLevel: scope.ABYSSAL_CONTENT_COMPLETENESS_LEVEL.BASELINE_COMPLETE,
    debugAllowed: development,
    details: {
      allowedStages: (0, scope.cloneValue)(weatherStageSelection.allowedStages || []),
      allowedWeatherObjectTypeIDs: (0, scope.cloneValue)(
        weatherStageSelection.allowedWeatherObjectTypeIDs || [],
      ),
      penaltyStrengthPercents: (0, scope.cloneValue)(
        weatherStageSelection.penaltyStrengthPercents || [],
      ),
      uncapturedWeatherObjectTypeIDs: (0, scope.cloneValue)(
        weatherStageSelection.uncapturedWeatherObjectTypeIDs || [],
      ),
      selectionScope: weatherStageSelection.selectionScope || "",
    },
  });
}

function buildCompletenessWeatherStageSelectionWeightsComponentOperation(scope, {
  weatherStageSelectionWeights, weatherStageSelection, development,
}) {
  return (0, scope.buildContentComponent)({
    component: "weather_stage_selection_weights",
    path: "weather.stage_selection.weights",
    resolvedProfileID: weatherStageSelectionWeights.profileID,
    authority: weatherStageSelectionWeights.contentAuthority,
    runtimeValid: Array.isArray(weatherStageSelectionWeights.weights) &&
      weatherStageSelectionWeights.weights.length ===
        (weatherStageSelection.allowedStages || []).length &&
      weatherStageSelectionWeights.weights.every(
        (weight) => Number.isFinite(Number(weight)) && Number(weight) >= 0,
      ) &&
      Math.abs(weatherStageSelectionWeights.weights.reduce(
        (total, weight) => total + Number(weight),
        0,
      ) - 1) < 1e-9,
    profile: weatherStageSelectionWeights,
    provenance: { sourceType: "weather_stage_selection_weight_policy" },
    requirement: scope.ABYSSAL_CONTENT_COMPONENT_REQUIREMENT.DIAGNOSTIC_ONLY,
    debugAllowed: development,
    details: {
      weights: (0, scope.cloneValue)(weatherStageSelectionWeights.weights || []),
      selectionModel: weatherStageSelectionWeights.selectionModel || "",
      exactRetailProbabilityDistributionVerified:
        weatherStageSelectionWeights
          .exactRetailProbabilityDistributionVerified === true,
    },
  });
}

function buildCompletenessWeatherCapturedPresentationComponentOperation(scope, {
  capturedWeatherPresentation, development,
}) {
  return (0, scope.buildContentComponent)({
    component: "weather_captured_presentation",
    path: "weather.captured_stage_1_presentation",
    resolvedProfileID: capturedWeatherPresentation.profileID,
    authority: capturedWeatherPresentation.contentAuthority,
    runtimeValid: Array.isArray(capturedWeatherPresentation.weatherObjectTypeIDs) &&
      capturedWeatherPresentation.weatherObjectTypeIDs.includes(
        scope.T0_DARK_ALLOWED_WEATHER_DEFINITIONS[0].typeID,
      ),
    profile: capturedWeatherPresentation,
    provenance: { sourceType: "weather_presentation_evidence" },
    requirement: scope.ABYSSAL_CONTENT_COMPONENT_REQUIREMENT.DIAGNOSTIC_ONLY,
    debugAllowed: development,
    details: {
      weatherObjectTypeIDs: (0, scope.cloneValue)(
        capturedWeatherPresentation.weatherObjectTypeIDs || [],
      ),
      directlyCapturedInSuppliedT0DarkLogs:
        capturedWeatherPresentation.directlyCapturedInSuppliedT0DarkLogs === true,
    },
  });
}

function buildCompletenessWeatherStage2PresentationComponentOperation(scope, {
  stageTwoWeatherPresentation, development,
}) {
  return (0, scope.buildContentComponent)({
    component: "weather_stage_2_presentation",
    path: "weather.presentation.stage_2",
    resolvedProfileID: stageTwoWeatherPresentation.profileID,
    authority: stageTwoWeatherPresentation.contentAuthority,
    runtimeValid: Array.isArray(stageTwoWeatherPresentation.weatherObjectTypeIDs) &&
      stageTwoWeatherPresentation.weatherObjectTypeIDs.includes(
        scope.T0_DARK_ALLOWED_WEATHER_DEFINITIONS[1].typeID,
      ),
    profile: stageTwoWeatherPresentation,
    provenance: { sourceType: "weather_presentation_policy" },
    requirement: scope.ABYSSAL_CONTENT_COMPONENT_REQUIREMENT.DIAGNOSTIC_ONLY,
    debugAllowed: development,
    details: {
      weatherObjectTypeIDs: (0, scope.cloneValue)(
        stageTwoWeatherPresentation.weatherObjectTypeIDs || [],
      ),
      directlyCapturedInSuppliedT0DarkLogs:
        stageTwoWeatherPresentation.directlyCapturedInSuppliedT0DarkLogs === true,
    },
  });
}

function buildCompletenessCapturedWeatherStageSelectionComponentOperation(scope, {
  weatherStageSelection, development,
}) {
  return (0, scope.buildContentComponent)({
    component: "weather_stage_selection",
    path: "weather.stage_selection",
    resolvedProfileID: weatherStageSelection.profileID,
    authority: weatherStageSelection.contentAuthority,
    runtimeValid: Array.isArray(weatherStageSelection.allowedWeatherObjectTypeIDs) &&
      weatherStageSelection.allowedWeatherObjectTypeIDs.length > 0,
    profile: weatherStageSelection,
    provenance: { sourceType: "weather_stage_selection_policy" },
    requiredFromLevel: scope.ABYSSAL_CONTENT_COMPLETENESS_LEVEL.BASELINE_COMPLETE,
    debugAllowed: development,
    details: {
      allowedStages: (0, scope.cloneValue)(weatherStageSelection.allowedStages || []),
      allowedWeatherObjectTypeIDs: (0, scope.cloneValue)(
        weatherStageSelection.allowedWeatherObjectTypeIDs || [],
      ),
      penaltyStrengthPercents: (0, scope.cloneValue)(
        weatherStageSelection.penaltyStrengthPercents || [],
      ),
      uncapturedWeatherObjectTypeIDs: (0, scope.cloneValue)(
        weatherStageSelection.uncapturedWeatherObjectTypeIDs || [],
      ),
      selectionScope: weatherStageSelection.selectionScope || "",
    },
  });
}

function buildCompletenessCapturedWeatherStageSelectionWeightsComponentOperation(scope, {
  weatherStageSelectionWeights, development,
}) {
  return (0, scope.buildContentComponent)({
    component: "weather_stage_selection_weights",
    path: "weather.stage_selection.weights",
    resolvedProfileID: weatherStageSelectionWeights.profileID,
    authority: weatherStageSelectionWeights.contentAuthority,
    runtimeValid: Array.isArray(weatherStageSelectionWeights.weights) &&
      weatherStageSelectionWeights.weights.length ===
        scope.T0_DARK_ALLOWED_WEATHER_STAGES.length &&
      weatherStageSelectionWeights.weights.every(
        (weight) => Number.isFinite(Number(weight)) && Number(weight) >= 0,
      ) &&
      Math.abs(weatherStageSelectionWeights.weights.reduce(
        (total, weight) => total + Number(weight),
        0,
      ) - 1) < 1e-9,
    profile: weatherStageSelectionWeights,
    provenance: { sourceType: "weather_stage_selection_weight_policy" },
    requirement: scope.ABYSSAL_CONTENT_COMPONENT_REQUIREMENT.DIAGNOSTIC_ONLY,
    debugAllowed: development,
    details: {
      weights: (0, scope.cloneValue)(weatherStageSelectionWeights.weights || []),
      selectionModel: weatherStageSelectionWeights.selectionModel || "",
      exactRetailProbabilityDistributionVerified:
        weatherStageSelectionWeights
          .exactRetailProbabilityDistributionVerified === true,
    },
  });
}

function buildCompletenessEntryTraceIdentityPresentationComponentOperation(scope, {
  traceIdentityPresentation, development,
}) {
  return (0, scope.buildContentComponent)({
    component: "entry_trace_identity_presentation",
    path: "entry_trace.identity_presentation",
    resolvedProfileID: traceIdentityPresentation.profileID,
    authority: traceIdentityPresentation.contentAuthority,
    runtimeValid: scope.SHARED_ABYSSAL_ENTRANCE_TRACE_PROFILE.typeID === 48964,
    profile: traceIdentityPresentation,
    provenance: { sourceType: "entry_trace_capture_evidence" },
    requirement: scope.ABYSSAL_CONTENT_COMPONENT_REQUIREMENT.DIAGNOSTIC_ONLY,
    debugAllowed: development,
    details: { typeID: scope.SHARED_ABYSSAL_ENTRANCE_TRACE_PROFILE.typeID },
  });
}

function buildCompletenessEntryTracePostReturnLifetimeComponentOperation(scope, {
  tracePostReturnLifetime, development,
}) {
  return (0, scope.buildContentComponent)({
    component: "entry_trace_post_return_lifetime",
    path: "entry_trace.post_return_lifetime",
    resolvedProfileID: tracePostReturnLifetime.profileID,
    authority: tracePostReturnLifetime.contentAuthority,
    runtimeValid: Number(
      scope.SHARED_ABYSSAL_ENTRANCE_TRACE_PROFILE.postReturnLifetime &&
        scope.SHARED_ABYSSAL_ENTRANCE_TRACE_PROFILE.postReturnLifetime.defaultMs,
    ) > 0,
    profile: tracePostReturnLifetime,
    provenance: { sourceType: "entry_trace_lifecycle_limitation" },
    requirement: scope.ABYSSAL_CONTENT_COMPONENT_REQUIREMENT.DIAGNOSTIC_ONLY,
    debugAllowed: development,
    details: (0, scope.cloneValue)(
      scope.SHARED_ABYSSAL_ENTRANCE_TRACE_PROFILE.postReturnLifetime || {},
    ),
  });
}

function buildCompletenessEntryTraceInteractionPolicyComponentOperation(scope, {
  traceInteractionPolicy, development,
}) {
  return (0, scope.buildContentComponent)({
    component: "entry_trace_interaction_policy",
    path: "entry_trace.interaction_policy",
    resolvedProfileID: traceInteractionPolicy.profileID,
    authority: traceInteractionPolicy.contentAuthority,
    runtimeValid: Number(
      scope.SHARED_ABYSSAL_ENTRANCE_TRACE_PROFILE.interaction &&
        scope.SHARED_ABYSSAL_ENTRANCE_TRACE_PROFILE.interaction
          .serverActivationRangeMeters,
    ) > 0,
    profile: traceInteractionPolicy,
    provenance: { sourceType: "entry_trace_interaction_policy" },
    requirement: scope.ABYSSAL_CONTENT_COMPONENT_REQUIREMENT.DIAGNOSTIC_ONLY,
    debugAllowed: development,
    details: {
      capturedNonInteractivePublication:
        traceInteractionPolicy.capturedNonInteractivePublication === true,
      serverActivationRangeMeters:
        traceInteractionPolicy.serverActivationRangeMeters || 0,
      returnedActivationRejectionCaptured:
        traceInteractionPolicy.returnedActivationRejectionCaptured === true,
    },
  });
}

function buildCompletenessBoundaryDamageModelComponentOperation(scope, {
  boundaryDamageModel, development,
}) {
  return (0, scope.buildContentComponent)({
    component: "boundary_damage_model",
    path: "boundary_policy.damage_model",
    resolvedProfileID: boundaryDamageModel.profileID,
    authority: boundaryDamageModel.contentAuthority,
    runtimeValid: Number(
      scope.UNSTABLE_ABYSSAL_DEPTHS_BOUNDARY_PROFILE.tickIntervalMs,
    ) > 0,
    profile: boundaryDamageModel,
    provenance: { sourceType: "boundary_damage_model" },
    requirement: scope.ABYSSAL_CONTENT_COMPONENT_REQUIREMENT.DIAGNOSTIC_ONLY,
    debugAllowed: development,
    details: {
      distanceCurve:
        scope.UNSTABLE_ABYSSAL_DEPTHS_BOUNDARY_PROFILE.evidence.distanceCurve,
      variance:
        scope.UNSTABLE_ABYSSAL_DEPTHS_BOUNDARY_PROFILE.evidence.variance,
      rawDamageType:
        scope.UNSTABLE_ABYSSAL_DEPTHS_BOUNDARY_PROFILE.evidence.rawDamageType,
    },
  });
}

function buildCompletenessEncounterComponentOperation(scope, {
  roomPath, roomIndex, reportedEncounterProfile, empiricalEncounterAuthority, observedSelection,
  encounterProfile, capturedSelection, encounterFallbackUsed, encounterFallbackReason, capturedFallbackUsed,
  development,
}) {
  return (0, scope.buildContentComponent)({
    component: "encounter",
    path: `${roomPath}.encounter`,
    roomIndex,
    resolvedProfileID: reportedEncounterProfile &&
      (reportedEncounterProfile.encounterProfileID ||
        reportedEncounterProfile.profileID),
    authority: empiricalEncounterAuthority
      ? empiricalEncounterAuthority.contentAuthority
      : observedSelection
      ? scope.ABYSSAL_CONTENT_AUTHORITY.PROJECT_AUTHORED
      : encounterProfile && encounterProfile.contentAuthority,
    runtimeValid: empiricalEncounterAuthority
      ? empiricalEncounterAuthority.runtimeReadyProfileCount > 0
      : Boolean(
        encounterProfile && encounterProfile.encounterProfileID &&
        Array.isArray(encounterProfile.npcEntries) &&
        encounterProfile.npcEntries.length > 0
      ),
    profile: reportedEncounterProfile,
    provenance: { sourceType: empiricalEncounterAuthority || observedSelection
      ? "qsna_encounter_reconstructed_from_observed_marginals"
      : capturedSelection
        ? "captured_room_composition"
        : "encounter_profile" },
    fallbackUsed: encounterFallbackUsed,
    fallbackReason: encounterFallbackReason,
    requestedAuthority: capturedFallbackUsed
      ? scope.ABYSSAL_CONTENT_AUTHORITY.CAPTURED_RETAIL
      : null,
    details: empiricalEncounterAuthority
      ? {
        selectionModel: empiricalEncounterAuthority.selectionModel,
        runtimeReadyProfileCount:
          empiricalEncounterAuthority.runtimeReadyProfileCount,
        sourceVariantCount: empiricalEncounterAuthority.sourceVariantCount,
        effectiveObservationWeight:
          empiricalEncounterAuthority.effectiveObservationWeight,
        observationSampleCount:
          empiricalEncounterAuthority.observationSampleCount,
        selectionAuthority:
          empiricalEncounterAuthority.selectionAuthority,
        familySelectionAuthority:
          empiricalEncounterAuthority.familySelectionAuthority,
        evidenceAuthority:
          empiricalEncounterAuthority.evidenceAuthority,
        familyEligibilityAuthority:
          empiricalEncounterAuthority.familyEligibilityAuthority,
        capabilityGatedVariantCount:
          empiricalEncounterAuthority.capabilityGatedVariantCount,
        capabilityGatedReasons:
          empiricalEncounterAuthority.capabilityGatedReasons,
      }
      : {},
    debugAllowed: development,
  });
}

function buildCompletenessNpcCompositionComponentOperation(scope, {
  roomPath, roomIndex, reportedEncounterProfile, empiricalEncounterAuthority, observedSelection,
  encounterProfile, npcRuntime, capturedSelection, encounterFallbackUsed, encounterFallbackReason,
  capturedFallbackUsed, development,
}) {
  return (0, scope.buildContentComponent)({
    component: "npc_composition",
    path: `${roomPath}.npc_composition`,
    roomIndex,
    resolvedProfileID: reportedEncounterProfile &&
      `${reportedEncounterProfile.encounterProfileID ||
        reportedEncounterProfile.profileID}:npc-composition`,
    authority: empiricalEncounterAuthority
      ? empiricalEncounterAuthority.contentAuthority
      : observedSelection
      ? scope.ABYSSAL_CONTENT_AUTHORITY.PROJECT_AUTHORED
      : encounterProfile && encounterProfile.contentAuthority,
    runtimeValid: npcRuntime.npcCount > 0,
    completeness: npcRuntime.npcCount > 0
      ? scope.ABYSSAL_CONTENT_COMPLETENESS_STATUS.COMPLETE
      : scope.ABYSSAL_CONTENT_COMPLETENESS_STATUS.MISSING,
    profile: reportedEncounterProfile,
    provenance: { sourceType: empiricalEncounterAuthority || observedSelection
      ? "synthetic_npc_composition_from_observed_marginals"
      : capturedSelection
        ? "captured_npc_composition"
        : "authored_npc_composition" },
    fallbackUsed: encounterFallbackUsed,
    fallbackReason: encounterFallbackReason,
    requestedAuthority: capturedFallbackUsed
      ? scope.ABYSSAL_CONTENT_AUTHORITY.CAPTURED_RETAIL
      : null,
    details: empiricalEncounterAuthority
      ? {
        compositionModel: empiricalEncounterAuthority.compositionModel,
        wholeObservedCompositions:
          empiricalEncounterAuthority.wholeObservedCompositions,
        syntheticComposition:
          empiricalEncounterAuthority.syntheticComposition,
        substitutionsAllowed:
          empiricalEncounterAuthority.substitutionsAllowed,
        appearanceAuthority:
          empiricalEncounterAuthority.appearanceAuthority,
        npcIdentityAuthority:
          empiricalEncounterAuthority.npcIdentityAuthority,
        evidenceAuthority:
          empiricalEncounterAuthority.evidenceAuthority,
        quantityBoundsAuthority:
          empiricalEncounterAuthority.quantityBoundsAuthority,
        familyEnemyCountBoundsAuthority:
          empiricalEncounterAuthority.familyEnemyCountBoundsAuthority,
        quantitySelectionAuthority:
          empiricalEncounterAuthority.quantitySelectionAuthority,
        reconciliationAuthority:
          empiricalEncounterAuthority.reconciliationAuthority,
        capabilityGatedVariantCount:
          empiricalEncounterAuthority.capabilityGatedVariantCount,
      }
      : {},
    debugAllowed: development,
  });
}

function buildCompletenessNpcRuntimeSupportComponentOperation(scope, {
  roomPath, roomIndex, reportedEncounterProfile, npcRuntime, empiricalEncounterAuthority, development,
}) {
  return (0, scope.buildContentComponent)({
    component: "npc_runtime_support",
    path: `${roomPath}.npc_runtime_support`,
    roomIndex,
    resolvedProfileID: reportedEncounterProfile &&
      `${reportedEncounterProfile.encounterProfileID ||
        reportedEncounterProfile.profileID}:sde-runtime-audit`,
    authority: scope.ABYSSAL_CONTENT_VALIDATION_AUTHORITY.SDE_RUNTIME_AUDITED,
    authorityAffectsEvidence: false,
    runtimeValid: npcRuntime.runtimeValid,
    completeness: npcRuntime.completeness,
    provenance: { sourceType: "sde_runtime_capability_audit" },
    details: {
      npcCount: npcRuntime.npcCount,
      npcs: npcRuntime.results,
      ...(empiricalEncounterAuthority
        ? {
          auditedProfileCount:
            empiricalEncounterAuthority.runtimeReadyProfileCount,
          capabilityGatedVariantCount:
            empiricalEncounterAuthority.capabilityGatedVariantCount,
        }
        : {}),
    },
    debugAllowed: development,
  });
}

function buildCompletenessEnvironmentComponentOperation(scope, {
  roomPath, roomIndex, environmentProfile, environmentFallbackUsed, development,
}) {
  return (0, scope.buildContentComponent)({
    component: "environment",
    path: `${roomPath}.environment`,
    roomIndex,
    resolvedProfileID: environmentProfile && environmentProfile.profileID,
    authority: environmentProfile && environmentProfile.contentAuthority,
    runtimeValid: Boolean(
      environmentProfile && environmentProfile.profileID &&
      environmentProfile.rooms && environmentProfile.rooms[String(roomIndex)]
    ),
    profile: environmentProfile,
    provenance: { sourceType: environmentFallbackUsed
      ? "generated_environment_fallback"
      : environmentProfile && environmentProfile.contentAuthority ===
          scope.ABYSSAL_CONTENT_AUTHORITY.CAPTURED_RETAIL
        ? "captured_environment_layout"
        : "environment_profile" },
    fallbackUsed: environmentFallbackUsed,
    fallbackReason: environmentFallbackUsed
      ? "REQUESTED_ENVIRONMENT_PROFILE_UNAVAILABLE"
      : "",
    requestedAuthority: environmentFallbackUsed
      ? scope.ABYSSAL_CONTENT_AUTHORITY.CAPTURED_RETAIL
      : null,
    requiredFromLevel: scope.ABYSSAL_CONTENT_COMPLETENESS_LEVEL.BASELINE_COMPLETE,
    debugAllowed: development,
  });
}

function buildCompletenessRewardsComponentOperation(scope, {
  roomPath, roomIndex, rewardProfile, rewardRuntimeValid, development,
}) {
  return (0, scope.buildContentComponent)({
    component: "rewards",
    path: `${roomPath}.rewards`,
    roomIndex,
    resolvedProfileID: rewardProfile && rewardProfile.rewardProfileID,
    authority: rewardProfile && rewardProfile.contentAuthority,
    runtimeValid: rewardRuntimeValid,
    profile: rewardProfile,
    provenance: { sourceType: "reward_profile" },
    fallbackUsed: rewardProfile && rewardProfile.fallbackUsed === true,
    fallbackReason: rewardProfile && rewardProfile.fallbackReason,
    requestedAuthority: rewardProfile && rewardProfile.requestedAuthority,
    requiredFromLevel: scope.ABYSSAL_CONTENT_COMPLETENESS_LEVEL.BASELINE_COMPLETE,
    debugAllowed: development,
    details: {
      quantityPolicy: rewardProfile && rewardProfile.quantityPolicy || "",
      unavailableSourceLootObservationCount: (0, scope.toInteger)(
        rewardProfile && rewardProfile.unavailableSourceLootObservationCount,
        0,
      ),
    },
  });
}

function buildCompletenessRewardQuantityPolicyComponentOperation(scope, {
  roomPath, roomIndex, rewardProfile, development,
}) {
  return (0, scope.buildContentComponent)({
    component: "reward_quantity_policy",
    path: `${roomPath}.reward_quantity_policy`,
    roomIndex,
    resolvedProfileID: rewardProfile && rewardProfile.quantityPolicy
      ? `abyssal:reward-quantity:${rewardProfile.quantityPolicy}`
      : "",
    authority: rewardProfile && rewardProfile.contentAuthority,
    runtimeValid: Boolean(rewardProfile && rewardProfile.quantityPolicy),
    profile: rewardProfile,
    provenance: { sourceType: "reward_quantity_policy" },
    requiredFromLevel: scope.ABYSSAL_CONTENT_COMPLETENESS_LEVEL.BASELINE_COMPLETE,
    debugAllowed: development,
  });
}

function buildCompletenessRewardCachePolicyComponentOperation(scope, {
  roomPath, roomIndex, rewardCacheAuthority, definition, development,
}) {
  return (0, scope.buildContentComponent)({
    component: "reward_cache_policy",
    path: `${roomPath}.reward_cache_policy`,
    roomIndex,
    resolvedProfileID: rewardCacheAuthority && rewardCacheAuthority.profileID ||
      definition && definition.cacheProfile &&
        definition.cacheProfile.cacheProfileID,
    authority: rewardCacheAuthority && rewardCacheAuthority.contentAuthority ||
      definition && definition.cachePolicyAuthority,
    runtimeValid: rewardCacheAuthority
      ? rewardCacheAuthority.cacheIdentities.length > 0
      : Boolean(
        definition && definition.cacheProfile &&
        definition.cacheProfile.cacheProfileID &&
        (0, scope.toInteger)(definition.cacheProfile.cacheTypeID, 0) > 0
      ),
    profile: rewardCacheAuthority || definition && definition.cacheProfile,
    provenance: { sourceType: "cache_policy" },
    requiredFromLevel: scope.ABYSSAL_CONTENT_COMPLETENESS_LEVEL.BASELINE_COMPLETE,
    details: rewardCacheAuthority
      ? {
        cacheIdentityAuthority:
          rewardCacheAuthority.cacheIdentityAuthority,
        rewardManifestAuthority:
          rewardCacheAuthority.rewardManifestAuthority,
        perRoomAllocationAuthority:
          rewardCacheAuthority.perRoomAllocationAuthority,
        perRoomDistributionStatus:
          rewardCacheAuthority.perRoomDistributionStatus,
        cacheIdentities: rewardCacheAuthority.cacheIdentities,
        observedProfilesWithoutCacheIdentity:
          rewardCacheAuthority.observedProfilesWithoutCacheIdentity,
        allocationModel: rewardCacheAuthority.allocationModel,
        sourceProvidesPerRoomLootAttribution:
          rewardCacheAuthority.sourceProvidesPerRoomLootAttribution,
      }
      : {},
    debugAllowed: development,
  });
}

function buildCompletenessRewardCacheIdentityComponentOperation(scope, {
  roomPath, roomIndex, rewardCacheAuthority, definition, development,
}) {
  return (0, scope.buildContentComponent)({
    component: "reward_cache_identity",
    path: `${roomPath}.reward_cache_identity`,
    roomIndex,
    resolvedProfileID: rewardCacheAuthority
      ? `${rewardCacheAuthority.profileID}:identity`
      : definition && definition.cacheProfile &&
        `${definition.cacheProfile.cacheProfileID}:identity`,
    authority: rewardCacheAuthority
      ? rewardCacheAuthority.cacheIdentityAuthority
      : definition && definition.cachePolicyAuthority,
    runtimeValid: rewardCacheAuthority
      ? rewardCacheAuthority.cacheIdentities.length > 0
      : Boolean(
        definition && definition.cacheProfile &&
        (0, scope.toInteger)(definition.cacheProfile.cacheTypeID, 0) > 0
      ),
    profile: rewardCacheAuthority || definition && definition.cacheProfile,
    provenance: { sourceType: "cache_identity_evidence" },
    requirement: scope.ABYSSAL_CONTENT_COMPONENT_REQUIREMENT.DIAGNOSTIC_ONLY,
    details: rewardCacheAuthority
      ? { cacheIdentities: rewardCacheAuthority.cacheIdentities }
      : {},
    debugAllowed: development,
  });
}

function buildCompletenessRewardCacheAllocationComponentOperation(scope, {
  roomPath, roomIndex, rewardCacheAuthority, definition, development,
}) {
  return (0, scope.buildContentComponent)({
    component: "reward_cache_allocation",
    path: `${roomPath}.reward_cache_allocation`,
    roomIndex,
    resolvedProfileID: rewardCacheAuthority
      ? `${rewardCacheAuthority.profileID}:allocation`
      : definition && definition.cacheProfile &&
        `${definition.cacheProfile.cacheProfileID}:allocation`,
    authority: rewardCacheAuthority
      ? rewardCacheAuthority.perRoomAllocationAuthority
      : definition && definition.cachePolicyAuthority,
    runtimeValid: Boolean(
      rewardCacheAuthority || definition && definition.cacheProfile,
    ),
    profile: rewardCacheAuthority || definition && definition.cacheProfile,
    provenance: { sourceType: "cache_reward_allocation_policy" },
    requirement: scope.ABYSSAL_CONTENT_COMPONENT_REQUIREMENT.DIAGNOSTIC_ONLY,
    details: rewardCacheAuthority
      ? {
        distributionStatus:
          rewardCacheAuthority.perRoomDistributionStatus,
        allocationModel: rewardCacheAuthority.allocationModel,
        sourceProvidesPerRoomLootAttribution:
          rewardCacheAuthority.sourceProvidesPerRoomLootAttribution,
      }
      : {},
    debugAllowed: development,
  });
}

function buildCompletenessFunctionalSuppressorsComponentOperation(scope, {
  roomPath, roomIndex, development,
}) {
  return (0, scope.buildContentComponent)({
    component: "functional_suppressors",
    path: `${roomPath}.functional_suppressors`,
    roomIndex,
    resolvedProfileID:
      scope.SHORT_RANGE_SUPPRESSOR_MECHANICS_PROFILE.mechanicsProfileID ||
      "abyssal:suppressor:short-range-v1",
    authority: scope.SHORT_RANGE_SUPPRESSOR_MECHANICS_PROFILE.contentAuthority,
    runtimeValid: true,
    profile: scope.SHORT_RANGE_SUPPRESSOR_MECHANICS_PROFILE,
    provenance: { sourceType: "functional_overlay_profile" },
    requirement: scope.ABYSSAL_CONTENT_COMPONENT_REQUIREMENT.OPTIONAL,
    debugAllowed: development,
  });
}

function buildCompletenessExtractionNodesComponentOperation(scope, {
  roomPath, roomIndex, extractionApplicable, extractionProfile, development,
}) {
  return (0, scope.buildContentComponent)({
    component: "extraction_nodes",
    path: `${roomPath}.extraction_nodes`,
    roomIndex,
    resolvedProfileID: extractionApplicable && extractionProfile
      ? extractionProfile.extractionNodeProfileID
      : "",
    authority: extractionApplicable && extractionProfile
      ? extractionProfile.contentAuthority
      : null,
    runtimeValid: extractionApplicable
      ? Boolean(extractionProfile && extractionProfile.extractionNodeProfileID)
      : false,
    completeness: extractionApplicable
      ? undefined
      : scope.ABYSSAL_CONTENT_COMPLETENESS_STATUS.MISSING,
    profile: extractionProfile,
    provenance: { sourceType: "optional_extraction_profile" },
    requirement: extractionApplicable
      ? scope.ABYSSAL_CONTENT_COMPONENT_REQUIREMENT.OPTIONAL
      : scope.ABYSSAL_CONTENT_COMPONENT_REQUIREMENT.NOT_APPLICABLE,
    debugAllowed: development,
  });
}

function bindAbyssalFilamentCompletenessDetailOperations(scope) {
  scope.buildCompletenessWeatherStageSelectionComponent = function buildCompletenessWeatherStageSelectionComponent(...args) {
    return buildCompletenessWeatherStageSelectionComponentOperation(scope, ...args);
  };
  scope.buildCompletenessWeatherStageSelectionWeightsComponent = function buildCompletenessWeatherStageSelectionWeightsComponent(...args) {
    return buildCompletenessWeatherStageSelectionWeightsComponentOperation(scope, ...args);
  };
  scope.buildCompletenessWeatherCapturedPresentationComponent = function buildCompletenessWeatherCapturedPresentationComponent(...args) {
    return buildCompletenessWeatherCapturedPresentationComponentOperation(scope, ...args);
  };
  scope.buildCompletenessWeatherStage2PresentationComponent = function buildCompletenessWeatherStage2PresentationComponent(...args) {
    return buildCompletenessWeatherStage2PresentationComponentOperation(scope, ...args);
  };
  scope.buildCompletenessCapturedWeatherStageSelectionComponent = function buildCompletenessCapturedWeatherStageSelectionComponent(...args) {
    return buildCompletenessCapturedWeatherStageSelectionComponentOperation(scope, ...args);
  };
  scope.buildCompletenessCapturedWeatherStageSelectionWeightsComponent = function buildCompletenessCapturedWeatherStageSelectionWeightsComponent(...args) {
    return buildCompletenessCapturedWeatherStageSelectionWeightsComponentOperation(scope, ...args);
  };
  scope.buildCompletenessEntryTraceIdentityPresentationComponent = function buildCompletenessEntryTraceIdentityPresentationComponent(...args) {
    return buildCompletenessEntryTraceIdentityPresentationComponentOperation(scope, ...args);
  };
  scope.buildCompletenessEntryTracePostReturnLifetimeComponent = function buildCompletenessEntryTracePostReturnLifetimeComponent(...args) {
    return buildCompletenessEntryTracePostReturnLifetimeComponentOperation(scope, ...args);
  };
  scope.buildCompletenessEntryTraceInteractionPolicyComponent = function buildCompletenessEntryTraceInteractionPolicyComponent(...args) {
    return buildCompletenessEntryTraceInteractionPolicyComponentOperation(scope, ...args);
  };
  scope.buildCompletenessBoundaryDamageModelComponent = function buildCompletenessBoundaryDamageModelComponent(...args) {
    return buildCompletenessBoundaryDamageModelComponentOperation(scope, ...args);
  };
  scope.buildCompletenessEncounterComponent = function buildCompletenessEncounterComponent(...args) {
    return buildCompletenessEncounterComponentOperation(scope, ...args);
  };
  scope.buildCompletenessNpcCompositionComponent = function buildCompletenessNpcCompositionComponent(...args) {
    return buildCompletenessNpcCompositionComponentOperation(scope, ...args);
  };
  scope.buildCompletenessNpcRuntimeSupportComponent = function buildCompletenessNpcRuntimeSupportComponent(...args) {
    return buildCompletenessNpcRuntimeSupportComponentOperation(scope, ...args);
  };
  scope.buildCompletenessEnvironmentComponent = function buildCompletenessEnvironmentComponent(...args) {
    return buildCompletenessEnvironmentComponentOperation(scope, ...args);
  };
  scope.buildCompletenessRewardsComponent = function buildCompletenessRewardsComponent(...args) {
    return buildCompletenessRewardsComponentOperation(scope, ...args);
  };
  scope.buildCompletenessRewardQuantityPolicyComponent = function buildCompletenessRewardQuantityPolicyComponent(...args) {
    return buildCompletenessRewardQuantityPolicyComponentOperation(scope, ...args);
  };
  scope.buildCompletenessRewardCachePolicyComponent = function buildCompletenessRewardCachePolicyComponent(...args) {
    return buildCompletenessRewardCachePolicyComponentOperation(scope, ...args);
  };
  scope.buildCompletenessRewardCacheIdentityComponent = function buildCompletenessRewardCacheIdentityComponent(...args) {
    return buildCompletenessRewardCacheIdentityComponentOperation(scope, ...args);
  };
  scope.buildCompletenessRewardCacheAllocationComponent = function buildCompletenessRewardCacheAllocationComponent(...args) {
    return buildCompletenessRewardCacheAllocationComponentOperation(scope, ...args);
  };
  scope.buildCompletenessFunctionalSuppressorsComponent = function buildCompletenessFunctionalSuppressorsComponent(...args) {
    return buildCompletenessFunctionalSuppressorsComponentOperation(scope, ...args);
  };
  scope.buildCompletenessExtractionNodesComponent = function buildCompletenessExtractionNodesComponent(...args) {
    return buildCompletenessExtractionNodesComponentOperation(scope, ...args);
  };
}

module.exports = {
  bindAbyssalFilamentCompletenessDetailOperations,
};
