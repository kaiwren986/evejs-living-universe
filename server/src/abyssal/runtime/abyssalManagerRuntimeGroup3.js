"use strict";

function buildManagerGroup3Binding2Part2(scope) {
  return {
  getSessionContext: (...args) => (0, scope.getSessionContext)(...args),
  getActivePocketStateForSession: (...args) => (0, scope.getActivePocketStateForSession)(...args),
  isAbyssalIsolatedScenesEnabled: (...args) => (0, scope.isAbyssalIsolatedScenesEnabled)(...args),
  getConfiguredAbyssalSceneModeSource: (...args) => (0, scope.getConfiguredAbyssalSceneModeSource)(...args),
  buildAbyssalRoomOneFxStatus: (...args) => (0, scope.buildAbyssalRoomOneFxStatus)(...args),
  buildAbyssalTransitionFxStatus: (...args) => (0, scope.buildAbyssalTransitionFxStatus)(...args),
  buildAbyssalSceneryVisualStatus: (...args) => (0, scope.buildAbyssalSceneryVisualStatus)(...args),
  buildAbyssalSceneryProbeStatus: (...args) => (0, scope.buildAbyssalSceneryProbeStatus)(...args),
  buildAbyssalRoomVisualStatus: (...args) => (0, scope.buildAbyssalRoomVisualStatus)(...args),
  buildAbyssalTraceStatusLines: (...args) => (0, scope.buildAbyssalTraceStatusLines)(...args),
  buildPocketStateForCurrentRoom: (...args) => (0, scope.buildPocketStateForCurrentRoom)(...args),
  getContentProfile: (...args) => (0, scope.getContentProfile)(...args),
  cloneValue: (...args) => (0, scope.cloneValue)(...args),
  buildPlaceholderRoomState: (...args) => (0, scope.buildPlaceholderRoomState)(...args),
  getPlaceholderRoomEntry: (...args) => (0, scope.getPlaceholderRoomEntry)(...args),
  normalizeT0DarkLayoutSelectionState: (...args) => (0, scope.normalizeT0DarkLayoutSelectionState)(...args),
  normalizeAbyssalBaseRoomLayoutSelectionState: (...args) => (0, scope.normalizeAbyssalBaseRoomLayoutSelectionState)(...args),
  resolveSelectedT0DarkRoom: (...args) => (0, scope.resolveSelectedT0DarkRoom)(...args),
  buildAbyssalRoomContentDiagnostics: (...args) => (0, scope.buildAbyssalRoomContentDiagnostics)(...args),
  getSuppressorDebugSnapshot: (...args) => (0, scope.getSuppressorDebugSnapshot)(...args),
  getBoundaryControllerForRun: (...args) => (0, scope.getBoundaryControllerForRun)(...args),
  getResolvedWeatherState: (...args) => (0, scope.getResolvedWeatherState)(...args),
  resolveRoomNpcProfile: (...args) => (0, scope.resolveRoomNpcProfile)(...args),
  resolveRoomRewardProfile: (...args) => (0, scope.resolveRoomRewardProfile)(...args),
  resolveRoomExtractionNodeProfile: (...args) => (0, scope.resolveRoomExtractionNodeProfile)(...args),
  getRewardState: (...args) => (0, scope.getRewardState)(...args),
  getAbyssalTimeoutState: (...args) => (0, scope.getAbyssalTimeoutState)(...args),
  getAbyssalEnvironmentNotificationState: (...args) => (0, scope.getAbyssalEnvironmentNotificationState)(...args),
  buildAbyssalDungeonTrackingState: (...args) => (0, scope.buildAbyssalDungeonTrackingState)(...args),
  buildAbyssalVisibilityRestrictionSummaryForSession: (...args) => (0, scope.buildAbyssalVisibilityRestrictionSummaryForSession)(...args),
  collectAbyssalArtifactInventory: (...args) => (0, scope.collectAbyssalArtifactInventory)(...args),
  resolveAbyssalSceneModeState: (...args) => (0, scope.resolveAbyssalSceneModeState)(...args),
  get ABYSSAL_SCENE_MODE_ISOLATED() { return scope.ABYSSAL_SCENE_MODE_ISOLATED; },
  getPendingAbyssalTransitionState: (...args) => (0, scope.getPendingAbyssalTransitionState)(...args),
  isAbyssalRestrictionBypassAllowed: (...args) => (0, scope.isAbyssalRestrictionBypassAllowed)(...args),
  get ABYSSAL_INTERNAL_BYPASS() { return scope.ABYSSAL_INTERNAL_BYPASS; },
  getRoomProfile: (...args) => (0, scope.getRoomProfile)(...args),
  resolveRoomOriginPosition: (...args) => (0, scope.resolveRoomOriginPosition)(...args),
  get ABYSSAL_ROOM_DELIVERY_STATE() { return scope.ABYSSAL_ROOM_DELIVERY_STATE; },
  getCharacterID: (...args) => (0, scope.getCharacterID)(...args),
  get TRANSITION_POLICY_EXPERIMENTAL() { return scope.TRANSITION_POLICY_EXPERIMENTAL; },
  resolveSelectedAbyssalBaseRoomLayoutID: (...args) => (0, scope.resolveSelectedAbyssalBaseRoomLayoutID)(...args),
  getTimerRemainingMs: (...args) => (0, scope.getTimerRemainingMs)(...args),
  get ABYSSAL_TIMEOUT_MODE() { return scope.ABYSSAL_TIMEOUT_MODE; },
  formatMetricReading: (...args) => (0, scope.formatMetricReading)(...args),
  readEntityMetric: (...args) => (0, scope.readEntityMetric)(...args),
  get ATTRIBUTE_MAX_VELOCITY() { return scope.ATTRIBUTE_MAX_VELOCITY; },
  get ATTRIBUTE_SCAN_RESOLUTION() { return scope.ATTRIBUTE_SCAN_RESOLUTION; },
  get ATTRIBUTE_CAPACITOR_RECHARGE_RATE() { return scope.ATTRIBUTE_CAPACITOR_RECHARGE_RATE; },
  get ATTRIBUTE_SHIELD_CAPACITY() { return scope.ATTRIBUTE_SHIELD_CAPACITY; },
  get ATTRIBUTE_ARMOR_HP() { return scope.ATTRIBUTE_ARMOR_HP; },
  getAttributeIDByNames: (...args) => (0, scope.getAttributeIDByNames)(...args),
  buildResistanceLine: (...args) => (0, scope.buildResistanceLine)(...args),
  get ATTRIBUTE_SHIELD_EM_RESONANCE() { return scope.ATTRIBUTE_SHIELD_EM_RESONANCE; },
  get ATTRIBUTE_SHIELD_THERMAL_RESONANCE() { return scope.ATTRIBUTE_SHIELD_THERMAL_RESONANCE; },
  get ATTRIBUTE_SHIELD_KINETIC_RESONANCE() { return scope.ATTRIBUTE_SHIELD_KINETIC_RESONANCE; },
  get ATTRIBUTE_SHIELD_EXPLOSIVE_RESONANCE() { return scope.ATTRIBUTE_SHIELD_EXPLOSIVE_RESONANCE; },
  get ATTRIBUTE_ARMOR_EM_RESONANCE() { return scope.ATTRIBUTE_ARMOR_EM_RESONANCE; },
  get ATTRIBUTE_ARMOR_THERMAL_RESONANCE() { return scope.ATTRIBUTE_ARMOR_THERMAL_RESONANCE; },
  get ATTRIBUTE_ARMOR_KINETIC_RESONANCE() { return scope.ATTRIBUTE_ARMOR_KINETIC_RESONANCE; },
  get ATTRIBUTE_ARMOR_EXPLOSIVE_RESONANCE() { return scope.ATTRIBUTE_ARMOR_EXPLOSIVE_RESONANCE; },
  get ATTRIBUTE_STRUCTURE_EM_RESONANCE() { return scope.ATTRIBUTE_STRUCTURE_EM_RESONANCE; },
  get ATTRIBUTE_STRUCTURE_THERMAL_RESONANCE() { return scope.ATTRIBUTE_STRUCTURE_THERMAL_RESONANCE; },
  get ATTRIBUTE_STRUCTURE_KINETIC_RESONANCE() { return scope.ATTRIBUTE_STRUCTURE_KINETIC_RESONANCE; },
  get ATTRIBUTE_STRUCTURE_EXPLOSIVE_RESONANCE() { return scope.ATTRIBUTE_STRUCTURE_EXPLOSIVE_RESONANCE; },
  buildPlayerTurretModifierLines: (...args) => (0, scope.buildPlayerTurretModifierLines)(...args),
  summarizeRewardLootEntries: (...args) => (0, scope.summarizeRewardLootEntries)(...args),
  listGuaranteedRewardLootEntries: (...args) => (0, scope.listGuaranteedRewardLootEntries)(...args),
  listContainerLootEntries: (...args) => (0, scope.listContainerLootEntries)(...args),
  listCombinedContainerLootEntries: (...args) => (0, scope.listCombinedContainerLootEntries)(...args),
  getDependencies: (...args) => (0, scope.getDependencies)(...args),
  getActiveRunCount: () => scope.activeAbyssalRunRegistry.size,
  getLastCleanupReport: () => scope.abyssalMaintenanceState.getLastCleanupReport(),
  get buildAbyssalContentCompletenessReport() {
    return typeof scope.AbyssalContentManagerService.buildAbyssalContentCompletenessReport === "function"
      ? (...args) => scope.AbyssalContentManagerService.buildAbyssalContentCompletenessReport(...args)
      : undefined;
  },
  get getAbyssalNpcProfileValidationReport() {
    return typeof scope.AbyssalContentManagerService.getAbyssalNpcProfileValidationReport === "function"
      ? (...args) => scope.AbyssalContentManagerService.getAbyssalNpcProfileValidationReport(...args)
      : undefined;
  },
};
}

function buildManagerGroup3Binding2Part1(scope) {
  return (0, scope.createAbyssalStatusReport)(buildManagerGroup3Binding2Part2(scope));
}

function initializeManagerGroup3Binding1(scope) {
  const {
  buildAbyssalWeatherDiagnostics,
  rememberAbyssalWeatherDiagnostics,
  getEntityPassiveAttributeMap,
  readEntityMetric,
  formatAbyssalMetricValue,
  formatMetricReading,
  formatResistancePctFromResonance,
  buildResistanceLine,
  buildPlayerTurretModifierLines,
  buildAbyssalTraceStatusLines,
} = (0, scope.createAbyssalRuntimeDiagnostics)({
  cloneValue: (...args) => (0, scope.cloneValue)(...args),
  get ABYSSAL_PLAYER_ATTRIBUTE_SOURCE_KEY() { return scope.ABYSSAL_PLAYER_ATTRIBUTE_SOURCE_KEY; },
  get ABYSSAL_PLAYER_LOCATION_SOURCE_KEY() { return scope.ABYSSAL_PLAYER_LOCATION_SOURCE_KEY; },
  getActivePocketStateByInstanceID: (...args) => (0, scope.getActivePocketStateByInstanceID)(...args),
  registerPocketBestEffort: (...args) => (0, scope.registerPocketBestEffort)(...args),
  resolveAbyssalWeatherModifierPercent: (...args) => (0, scope.resolveAbyssalWeatherModifierPercent)(...args),
  getCharacterID: (...args) => (0, scope.getCharacterID)(...args),
  readTraceStateFromItem: (...args) => (0, scope.readTraceStateFromItem)(...args),
  getReadOnlySolarSystemScene: (...args) => (0, scope.getReadOnlySolarSystemScene)(...args),
  getDependencies: (...args) => (0, scope.getDependencies)(...args),
  getTraceIDForCharacter: (...args) => scope.abyssalTraceStateRegistry.getTraceIDForCharacter(...args),
  getTrace: (...args) => scope.abyssalTraceStateRegistry.getTrace(...args),
  listTraces: (...args) => scope.abyssalTraceStateRegistry.listTraces(...args),
  getTraceRemovalSchedule: (...args) => scope.abyssalTraceStateRegistry.getRemovalSchedule(...args),
});
  scope.buildAbyssalWeatherDiagnostics = buildAbyssalWeatherDiagnostics;
  scope.rememberAbyssalWeatherDiagnostics = rememberAbyssalWeatherDiagnostics;
  scope.getEntityPassiveAttributeMap = getEntityPassiveAttributeMap;
  scope.readEntityMetric = readEntityMetric;
  scope.formatAbyssalMetricValue = formatAbyssalMetricValue;
  scope.formatMetricReading = formatMetricReading;
  scope.formatResistancePctFromResonance = formatResistancePctFromResonance;
  scope.buildResistanceLine = buildResistanceLine;
  scope.buildPlayerTurretModifierLines = buildPlayerTurretModifierLines;
  scope.buildAbyssalTraceStatusLines = buildAbyssalTraceStatusLines;
}

function initializeManagerGroup3Binding2(scope) {
  const { buildAbyssalStatusReportForSession } = buildManagerGroup3Binding2Part1(scope);
  scope.buildAbyssalStatusReportForSession = buildAbyssalStatusReportForSession;
}

function initializeManagerGroup3Binding3(scope) {
  const {
  getContentProfile,
  isCapturedT0DarkContent,
  isTranquilAbyssalContent,
  getT0DarkLayoutCompatibilityOptions,
  normalizeT0DarkLayoutSelectionState,
  logT0DarkLayoutCatalogWarningsOnce,
  getCapturedT0DarkRoom,
  getCapturedAuthoredRoom,
  getCapturedAuthoredRoomEntity,
  buildCapturedAuthoredDunRotation,
  normalizeTranquilPresentationIdentity,
  resolveAbyssalCachePresentationIdentity,
  resolveTranquilCachePresentationIdentity,
  resolveTranquilConduitPresentationIdentity,
  getCacheProfile,
  resolveAbyssalRequiredFilamentCount,
  resolveMainAbyssalCacheFamily,
  getExtractionNodeProfile,
} = (0, scope.createAbyssalContentViews)({
  get T0_DARK_RETAIL_CAPTURED_FILAMENT_TYPE_ID() { return scope.T0_DARK_RETAIL_CAPTURED_FILAMENT_TYPE_ID; },
  get T0_DARK_RETAIL_CAPTURED_PROFILE_ID() { return scope.T0_DARK_RETAIL_CAPTURED_PROFILE_ID; },
  get T0_DARK_RETAIL_CAPTURED_LAYOUT_VARIANT() { return scope.T0_DARK_RETAIL_CAPTURED_LAYOUT_VARIANT; },
  isT0DarkRetailCapturedProfile: (...args) => (0, scope.isT0DarkRetailCapturedProfile)(...args),
  resolveT0DarkLayoutSetByID: (...args) => (0, scope.resolveT0DarkLayoutSetByID)(...args),
  buildLegacyT0DarkLayoutSelectionState: (...args) => (0, scope.buildLegacyT0DarkLayoutSelectionState)(...args),
  get T0_DARK_LAYOUT_SELECTION_MODEL() { return scope.T0_DARK_LAYOUT_SELECTION_MODEL; },
  getT0DarkLayoutCatalogValidationReport: (...args) => (0, scope.getT0DarkLayoutCatalogValidationReport)(...args),
  get log() { return scope.log; },
  get T0_DARK_LEGACY_LAYOUT_SET_ID() { return scope.T0_DARK_LEGACY_LAYOUT_SET_ID; },
  buildPlaceholderRoomState: (...args) => (0, scope.buildPlaceholderRoomState)(...args),
  resolveSelectedT0DarkRoom: (...args) => (0, scope.resolveSelectedT0DarkRoom)(...args),
  cloneValue: (...args) => (0, scope.cloneValue)(...args),
  get TYPE_CAPTURED_TRIGLAVIAN_BIOADAPTIVE_CACHE() { return scope.TYPE_CAPTURED_TRIGLAVIAN_BIOADAPTIVE_CACHE; },
  get TYPE_ABYSSAL_BIOCOMBINATIVE_CACHE() { return scope.TYPE_ABYSSAL_BIOCOMBINATIVE_CACHE; },
  get T0_DARK_RETAIL_CAPTURED_LAYOUT() { return scope.T0_DARK_RETAIL_CAPTURED_LAYOUT; },
  isFinalRoomIndex: (...args) => (0, scope.isFinalRoomIndex)(...args),
  getPlaceholderRoomEntry: (...args) => (0, scope.getPlaceholderRoomEntry)(...args),
  get TYPE_CAPTURED_TRIGLAVIAN_BIOADAPTIVE_CACHE_WRECK() { return scope.TYPE_CAPTURED_TRIGLAVIAN_BIOADAPTIVE_CACHE_WRECK; },
  get ABYSSAL_CALM_TIER_REWARD_QUANTITY_MULTIPLIER() { return scope.ABYSSAL_CALM_TIER_REWARD_QUANTITY_MULTIPLIER; },
  get TYPE_ABYSSAL_BIOCOMBINATIVE_CACHE_WRECK() { return scope.TYPE_ABYSSAL_BIOCOMBINATIVE_CACHE_WRECK; },
  isTranquilFilamentTypeID: (...args) => scope.TRANQUIL_ABYSSAL_FILAMENT_TYPE_IDS.has(...args),
  consumeT0DarkLayoutCatalogWarning: (...args) => scope.abyssalDiagnosticsState.consumeT0DarkLayoutCatalogWarning(...args),
  get resolveAuthoredAbyssalCaptureByID() {
    return typeof scope.AbyssalContentManagerService.resolveAuthoredAbyssalCaptureByID === "function"
      ? (...args) => scope.AbyssalContentManagerService.resolveAuthoredAbyssalCaptureByID(...args)
      : undefined;
  },
});
  scope.getContentProfile = getContentProfile;
  scope.isCapturedT0DarkContent = isCapturedT0DarkContent;
  scope.isTranquilAbyssalContent = isTranquilAbyssalContent;
  scope.getT0DarkLayoutCompatibilityOptions = getT0DarkLayoutCompatibilityOptions;
  scope.normalizeT0DarkLayoutSelectionState = normalizeT0DarkLayoutSelectionState;
  scope.logT0DarkLayoutCatalogWarningsOnce = logT0DarkLayoutCatalogWarningsOnce;
  scope.getCapturedT0DarkRoom = getCapturedT0DarkRoom;
  scope.getCapturedAuthoredRoom = getCapturedAuthoredRoom;
  scope.getCapturedAuthoredRoomEntity = getCapturedAuthoredRoomEntity;
  scope.buildCapturedAuthoredDunRotation = buildCapturedAuthoredDunRotation;
  scope.normalizeTranquilPresentationIdentity = normalizeTranquilPresentationIdentity;
  scope.resolveAbyssalCachePresentationIdentity = resolveAbyssalCachePresentationIdentity;
  scope.resolveTranquilCachePresentationIdentity = resolveTranquilCachePresentationIdentity;
  scope.resolveTranquilConduitPresentationIdentity = resolveTranquilConduitPresentationIdentity;
  scope.getCacheProfile = getCacheProfile;
  scope.resolveAbyssalRequiredFilamentCount = resolveAbyssalRequiredFilamentCount;
  scope.resolveMainAbyssalCacheFamily = resolveMainAbyssalCacheFamily;
  scope.getExtractionNodeProfile = getExtractionNodeProfile;
}

function initializeManagerGroup3Binding4(scope) {
  const {
  getRoomProfile,
  getRoomEncounterProfilesByIndex,
  listActiveAbyssalRoomNpcIDs,
  clampRoomIndex,
  getRoomOffsetVectors,
  getRoomOffsetForIndex,
  getImplementedRoomCount,
  getRetailTargetRoomCount,
  getRoomOriginLabel,
  getTransferConduitLabel,
  getFinalExitConduitLabel,
  isFinalRoomIndex,
  resolveRoomOriginPosition,
  buildRoomShipSpawnState,
  buildRoomConduitState,
  buildRoomLateralDirection,
  buildRoomOffsetFromConduitState,
  buildPlaceholderRoomEntry,
  isAbyssalPocketMutationBatchActive,
  buildPlaceholderRoomState,
  getPlaceholderRoomEntry,
  hasPrewarmedPlaceholderRoomContent,
  setPlaceholderRoomEntry,
  buildPocketStateForCurrentRoom,
  getTimerRemainingMs,
  buildRoomLogContext,
  isPocketObjectiveComplete,
  buildAbyssalRoomObjectivePolicyInput,
  buildAbyssalRoomProgressionPolicyInput,
  canExitPlaceholderPocket,
  shouldUseFinalExitConduit,
} = (0, scope.createAbyssalRoomStateModel)({
  getContentProfile: (...args) => (0, scope.getContentProfile)(...args),
  cloneValue: (...args) => (0, scope.cloneValue)(...args),
  get PLACEHOLDER_ROOM_OFFSET_VECTORS() { return scope.PLACEHOLDER_ROOM_OFFSET_VECTORS; },
  isAbyssalFinalRoomIndex: (...args) => (0, scope.isAbyssalFinalRoomIndex)(...args),
  get PLACEHOLDER_POCKET_SHIP_OFFSET_METERS() { return scope.PLACEHOLDER_POCKET_SHIP_OFFSET_METERS; },
  getCapturedT0DarkRoom: (...args) => (0, scope.getCapturedT0DarkRoom)(...args),
  normalizeTranquilPresentationIdentity: (...args) => (0, scope.normalizeTranquilPresentationIdentity)(...args),
  getCapturedAuthoredRoom: (...args) => (0, scope.getCapturedAuthoredRoom)(...args),
  getCapturedAuthoredRoomEntity: (...args) => (0, scope.getCapturedAuthoredRoomEntity)(...args),
  buildCapturedAuthoredDunRotation: (...args) => (0, scope.buildCapturedAuthoredDunRotation)(...args),
  resolveTranquilConduitPresentationIdentity: (...args) => (0, scope.resolveTranquilConduitPresentationIdentity)(...args),
  get PLACEHOLDER_ROOM_CONDUIT_DISTANCE_METERS() { return scope.PLACEHOLDER_ROOM_CONDUIT_DISTANCE_METERS; },
  resolveSelectedAbyssalBaseRoomLayoutID: (...args) => (0, scope.resolveSelectedAbyssalBaseRoomLayoutID)(...args),
  cloneRuntimeRewardProfileOverride: (...args) => (0, scope.cloneRuntimeRewardProfileOverride)(...args),
  calculateAbyssalRemainingDuration: (...args) => (0, scope.calculateAbyssalRemainingDuration)(...args),
  hasFailedTimeoutOutcome: (...args) => (0, scope.hasFailedTimeoutOutcome)(...args),
  hasTerminalFailureOutcome: (...args) => (0, scope.hasTerminalFailureOutcome)(...args),
  evaluateAbyssalRoomObjectiveEligibility: (...args) => (0, scope.evaluateAbyssalRoomObjectiveEligibility)(...args),
  resolveAbyssalRoomProgression: (...args) => (0, scope.resolveAbyssalRoomProgression)(...args),
  hasMutationBatch: (...args) => scope.abyssalRunWorkStore.hasMutationBatch(...args),
  getDependencies: (...args) => (0, scope.getDependencies)(...args),
});
  scope.getRoomProfile = getRoomProfile;
  scope.getRoomEncounterProfilesByIndex = getRoomEncounterProfilesByIndex;
  scope.listActiveAbyssalRoomNpcIDs = listActiveAbyssalRoomNpcIDs;
  scope.clampRoomIndex = clampRoomIndex;
  scope.getRoomOffsetVectors = getRoomOffsetVectors;
  scope.getRoomOffsetForIndex = getRoomOffsetForIndex;
  scope.getImplementedRoomCount = getImplementedRoomCount;
  scope.getRetailTargetRoomCount = getRetailTargetRoomCount;
  scope.getRoomOriginLabel = getRoomOriginLabel;
  scope.getTransferConduitLabel = getTransferConduitLabel;
  scope.getFinalExitConduitLabel = getFinalExitConduitLabel;
  scope.isFinalRoomIndex = isFinalRoomIndex;
  scope.resolveRoomOriginPosition = resolveRoomOriginPosition;
  scope.buildRoomShipSpawnState = buildRoomShipSpawnState;
  scope.buildRoomConduitState = buildRoomConduitState;
  scope.buildRoomLateralDirection = buildRoomLateralDirection;
  scope.buildRoomOffsetFromConduitState = buildRoomOffsetFromConduitState;
  scope.buildPlaceholderRoomEntry = buildPlaceholderRoomEntry;
  scope.isAbyssalPocketMutationBatchActive = isAbyssalPocketMutationBatchActive;
  scope.buildPlaceholderRoomState = buildPlaceholderRoomState;
  scope.getPlaceholderRoomEntry = getPlaceholderRoomEntry;
  scope.hasPrewarmedPlaceholderRoomContent = hasPrewarmedPlaceholderRoomContent;
  scope.setPlaceholderRoomEntry = setPlaceholderRoomEntry;
  scope.buildPocketStateForCurrentRoom = buildPocketStateForCurrentRoom;
  scope.getTimerRemainingMs = getTimerRemainingMs;
  scope.buildRoomLogContext = buildRoomLogContext;
  scope.isPocketObjectiveComplete = isPocketObjectiveComplete;
  scope.buildAbyssalRoomObjectivePolicyInput = buildAbyssalRoomObjectivePolicyInput;
  scope.buildAbyssalRoomProgressionPolicyInput = buildAbyssalRoomProgressionPolicyInput;
  scope.canExitPlaceholderPocket = canExitPlaceholderPocket;
  scope.shouldUseFinalExitConduit = shouldUseFinalExitConduit;
}

function initializeManagerGroup3Binding5(scope) {
  const {
  parseCustomInfo,
  buildTraceCustomInfo,
  buildCapturedRetailIdentityState,
  buildRewardCacheCustomInfo,
  buildExtractionNodeCustomInfo,
  readTraceStateFromItem,
  readRewardCacheStateFromItem,
  readExtractionNodeStateFromItem,
  inspectAbyssalTaggedSpaceItem,
} = (0, scope.createAbyssalItemMetadata)({
  buildAbyssalTraceSlimState: (...args) => (0, scope.buildAbyssalTraceSlimState)(...args),
  buildAbyssalTracePresentationState: (...args) => (0, scope.buildAbyssalTracePresentationState)(...args),
  get ABYSSAL_PARTICIPANT_ROSTER_SCHEMA_VERSION() { return scope.ABYSSAL_PARTICIPANT_ROSTER_SCHEMA_VERSION; },
  normalizeAbyssalParticipantRoster: (...args) => (0, scope.normalizeAbyssalParticipantRoster)(...args),
  normalizeAbyssalTraceLifecyclePhase: (...args) => (0, scope.normalizeAbyssalTraceLifecyclePhase)(...args),
  cloneValue: (...args) => (0, scope.cloneValue)(...args),
  get ABYSSAL_PARTICIPANT_RETURN_OBLIGATION_SCHEMA_VERSION() { return scope.ABYSSAL_PARTICIPANT_RETURN_OBLIGATION_SCHEMA_VERSION; },
  getAbyssalParticipantReturnObligationsByCharacterID: (...args) => (0, scope.getAbyssalParticipantReturnObligationsByCharacterID)(...args),
  get TYPE_ABYSSAL_TRACE() { return scope.TYPE_ABYSSAL_TRACE; },
  get GROUP_FILAMENT_TRACE() { return scope.GROUP_FILAMENT_TRACE; },
  buildPersistedAbyssalContentProfile: (...args) => (0, scope.buildPersistedAbyssalContentProfile)(...args),
  getContentProfile: (...args) => (0, scope.getContentProfile)(...args),
  buildPlaceholderRoomState: (...args) => (0, scope.buildPlaceholderRoomState)(...args),
  getCacheProfile: (...args) => (0, scope.getCacheProfile)(...args),
  clampRoomIndex: (...args) => (0, scope.clampRoomIndex)(...args),
  getPlaceholderRoomEntry: (...args) => (0, scope.getPlaceholderRoomEntry)(...args),
  getCapturedT0DarkRoom: (...args) => (0, scope.getCapturedT0DarkRoom)(...args),
  resolveAbyssalCachePresentationIdentity: (...args) => (0, scope.resolveAbyssalCachePresentationIdentity)(...args),
  get ABYSSAL_ROOM_ENTITY_ROLES() { return scope.ABYSSAL_ROOM_ENTITY_ROLES; },
  listAbyssalParticipantCharacterIDs: (...args) => (0, scope.listAbyssalParticipantCharacterIDs)(...args),
  getCacheRewardQuantityMultiplier: (...args) => (0, scope.getCacheRewardQuantityMultiplier)(...args),
  rehydratePersistedAbyssalContentProfile: (...args) => (0, scope.rehydratePersistedAbyssalContentProfile)(...args),
  resolveAbyssalTraceProfile: (...args) => (0, scope.resolveAbyssalTraceProfile)(...args),
  get ABYSSAL_TRACE_LIFECYCLE_PHASE() { return scope.ABYSSAL_TRACE_LIFECYCLE_PHASE; },
  getAbyssalTracePhaseDefinition: (...args) => (0, scope.getAbyssalTracePhaseDefinition)(...args),
  readPocketMarkerStateFromItem: (...args) => (0, scope.readPocketMarkerStateFromItem)(...args),
  readEnvironmentalObjectStateFromItem: (...args) => (0, scope.readEnvironmentalObjectStateFromItem)(...args),
  resolveEntityInteractionScope: (...args) => (0, scope.resolveEntityInteractionScope)(...args),
  resolveExactAbyssalRunRoomScope: (...args) => (0, scope.resolveExactAbyssalRunRoomScope)(...args),
  get CATEGORY_SHIP() { return scope.CATEGORY_SHIP; },
  isCorpseType: (...args) => (0, scope.isCorpseType)(...args),
  getTraceState: (...args) => scope.abyssalTraceStateRegistry.getTrace(...args),
});
  scope.parseCustomInfo = parseCustomInfo;
  scope.buildTraceCustomInfo = buildTraceCustomInfo;
  scope.buildCapturedRetailIdentityState = buildCapturedRetailIdentityState;
  scope.buildRewardCacheCustomInfo = buildRewardCacheCustomInfo;
  scope.buildExtractionNodeCustomInfo = buildExtractionNodeCustomInfo;
  scope.readTraceStateFromItem = readTraceStateFromItem;
  scope.readRewardCacheStateFromItem = readRewardCacheStateFromItem;
  scope.readExtractionNodeStateFromItem = readExtractionNodeStateFromItem;
  scope.inspectAbyssalTaggedSpaceItem = inspectAbyssalTaggedSpaceItem;
}

function initializeManagerGroup3Binding6(scope) {
  const { cloneValue } = (0, scope.createAbyssalStructuralClone)({
  consumeCloneValueGuardLog: (...args) => scope.abyssalDiagnosticsState.consumeCloneValueGuardLog(...args),
  get log() { return scope.log; },
});
  scope.cloneValue = cloneValue;
}

function initializeManagerGroup3Binding7(scope) {
  const { finishEntranceTransition } = (0, scope.createAbyssalEntranceExecution)({
  getPendingAbyssalTransitionState: (...args) => (0, scope.getPendingAbyssalTransitionState)(...args),
  updatePocketState: (...args) => (0, scope.updatePocketState)(...args),
  cloneValue: (...args) => (0, scope.cloneValue)(...args),
  updatePendingAbyssalTraceActivation: (...args) => (0, scope.updatePendingAbyssalTraceActivation)(...args),
  moveShipIntoPlaceholderPocket: (...args) => (0, scope.moveShipIntoPlaceholderPocket)(...args),
  recordAuditEvent: (...args) => (0, scope.recordAuditEvent)(...args),
  get log() { return scope.log; },
  shouldUseCorrelatedAbyssalSpaceEmpiricalContent: (...args) => (0, scope.shouldUseCorrelatedAbyssalSpaceEmpiricalContent)(...args),
  getContentProfile: (...args) => (0, scope.getContentProfile)(...args),
  spawnPlaceholderPocketContent: (...args) => (0, scope.spawnPlaceholderPocketContent)(...args),
  getActivePocketStateByInstanceID: (...args) => (0, scope.getActivePocketStateByInstanceID)(...args),
  usesAuthoredAbyssalEnvironmentNotification: (...args) => (0, scope.usesAuthoredAbyssalEnvironmentNotification)(...args),
  markAbyssalDungeonRoomWithoutGenericNotification: (...args) => (0, scope.markAbyssalDungeonRoomWithoutGenericNotification)(...args),
  getPocketScene: (...args) => (0, scope.getPocketScene)(...args),
  buildPlaceholderRoomState: (...args) => (0, scope.buildPlaceholderRoomState)(...args),
  broadcastAbyssalRoomBootstrapAddBalls: (...args) => (0, scope.broadcastAbyssalRoomBootstrapAddBalls)(...args),
  usesIsolatedAbyssalScene: (...args) => (0, scope.usesIsolatedAbyssalScene)(...args),
  queueAbyssalFreshEntryBootstrap: (...args) => (0, scope.queueAbyssalFreshEntryBootstrap)(...args),
  queueAbyssalClientEnvironmentDelivery: (...args) => (0, scope.queueAbyssalClientEnvironmentDelivery)(...args),
  sendAbyssalExpiryDurationNotification: (...args) => (0, scope.sendAbyssalExpiryDurationNotification)(...args),
  sendOrQueueInitialAbyssalArrivalFx: (...args) => (0, scope.sendOrQueueInitialAbyssalArrivalFx)(...args),
  activateAbyssalRoomNpcControllers: (...args) => (0, scope.activateAbyssalRoomNpcControllers)(...args),
  logAbyssalRoomContentActivated: (...args) => (0, scope.logAbyssalRoomContentActivated)(...args),
  activateSuppressorControllersForPocketRoom: (...args) => (0, scope.activateSuppressorControllersForPocketRoom)(...args),
  deliverSuppressorPresentationForSession: (...args) => (0, scope.deliverSuppressorPresentationForSession)(...args),
  applyAbyssalWeatherToRun: (...args) => (0, scope.applyAbyssalWeatherToRun)(...args),
  ensureBoundaryControllerForPocketState: (...args) => (0, scope.ensureBoundaryControllerForPocketState)(...args),
  evaluateEnvironmentalEffectsForPocketState: (...args) => (0, scope.evaluateEnvironmentalEffectsForPocketState)(...args),
  buildAbyssalActiveRoomReadiness: (...args) => (0, scope.buildAbyssalActiveRoomReadiness)(...args),
  stageAbyssalFilamentCompensationClaim: (...args) => (0, scope.stageAbyssalFilamentCompensationClaim)(...args),
  suppressAbyssalRoomRewards: (...args) => (0, scope.suppressAbyssalRoomRewards)(...args),
  recordAbyssalRunOutcome: (...args) => (0, scope.recordAbyssalRunOutcome)(...args),
  persistPendingAbyssalEntryRecovery: (...args) => (0, scope.persistPendingAbyssalEntryRecovery)(...args),
  get ABYSSAL_ENTRY_RECOVERY_REASON() { return scope.ABYSSAL_ENTRY_RECOVERY_REASON; },
  reconcilePendingAbyssalEntryRecovery: (...args) => (0, scope.reconcilePendingAbyssalEntryRecovery)(...args),
  clearPendingAbyssalTraceActivation: (...args) => (0, scope.clearPendingAbyssalTraceActivation)(...args),
  completePendingAbyssalTraceActivation: (...args) => (0, scope.completePendingAbyssalTraceActivation)(...args),
});
  scope.finishEntranceTransition = finishEntranceTransition;
}

function initializeManagerGroup3Binding8(scope) {
  const { handleAbyssalEntranceGateActivation } = (0, scope.createAbyssalEntranceRequest)({
  getDependencies: (...args) => (0, scope.getDependencies)(...args),
  validateAbyssalTraceActivation: (...args) => (0, scope.validateAbyssalTraceActivation)(...args),
  recordAuditEvent: (...args) => (0, scope.recordAuditEvent)(...args),
  get log() { return scope.log; },
  getCharacterID: (...args) => (0, scope.getCharacterID)(...args),
  throwCustomNotify: (...args) => (0, scope.throwCustomNotify)(...args),
  get ABYSS_ERROR_KIND() { return scope.ABYSS_ERROR_KIND; },
  get ABYSS_UNSUPPORTED_FILAMENT_NOTIFY() { return scope.ABYSS_UNSUPPORTED_FILAMENT_NOTIFY; },
  buildAbyssalSecurityRestrictionNotify: (...args) => (0, scope.buildAbyssalSecurityRestrictionNotify)(...args),
  throwAbyssError: (...args) => (0, scope.throwAbyssError)(...args),
  buildAbyssErrorFromValidationError: (...args) => (0, scope.buildAbyssErrorFromValidationError)(...args),
  admitAbyssalParticipantIntoExistingRun: (...args) => (0, scope.admitAbyssalParticipantIntoExistingRun)(...args),
  get ABYSS_ERROR() { return scope.ABYSS_ERROR; },
  refreshPendingAbyssalTraceActivationFromValidation: (...args) => (0, scope.refreshPendingAbyssalTraceActivationFromValidation)(...args),
  resolveAbyssalTraceTransitionPresentation: (...args) => (0, scope.resolveAbyssalTraceTransitionPresentation)(...args),
  logPendingAbyssalTraceActivation: (...args) => (0, scope.logPendingAbyssalTraceActivation)(...args),
  clearCreatedAbyssalTraceExpirySchedule: (...args) => (0, scope.clearCreatedAbyssalTraceExpirySchedule)(...args),
  claimPendingAbyssalTraceActivation: (...args) => (0, scope.claimPendingAbyssalTraceActivation)(...args),
  getContentProfile: (...args) => (0, scope.getContentProfile)(...args),
  cloneValue: (...args) => (0, scope.cloneValue)(...args),
  buildAbyssalWeatherState: (...args) => (0, scope.buildAbyssalWeatherState)(...args),
  logResolvedAbyssalWeather: (...args) => (0, scope.logResolvedAbyssalWeather)(...args),
  createOrResolvePlaceholderPocket: (...args) => (0, scope.createOrResolvePlaceholderPocket)(...args),
  rollbackPendingAbyssalTraceActivation: (...args) => (0, scope.rollbackPendingAbyssalTraceActivation)(...args),
  buildPlaceholderRoomState: (...args) => (0, scope.buildPlaceholderRoomState)(...args),
  setAbyssalSessionState: (...args) => (0, scope.setAbyssalSessionState)(...args),
  schedulePlaceholderPocketMaintenance: (...args) => (0, scope.schedulePlaceholderPocketMaintenance)(...args),
  completePendingAbyssalTraceActivation: (...args) => (0, scope.completePendingAbyssalTraceActivation)(...args),
  getPendingAbyssalTransitionState: (...args) => (0, scope.getPendingAbyssalTransitionState)(...args),
  transitionSourceTraceState: (...args) => (0, scope.transitionSourceTraceState)(...args),
  get ABYSSAL_TRACE_LIFECYCLE_PHASE() { return scope.ABYSSAL_TRACE_LIFECYCLE_PHASE; },
  prewarmCurrentPlaceholderRoomContent: (...args) => (0, scope.prewarmCurrentPlaceholderRoomContent)(...args),
  resolveAbyssalEnvironmentRoomProfileForPocket: (...args) => (0, scope.resolveAbyssalEnvironmentRoomProfileForPocket)(...args),
  buildAbyssalSceneDescriptor: (...args) => (0, scope.buildAbyssalSceneDescriptor)(...args),
  resolveTransitionProfileSetForLayout: (...args) => (0, scope.resolveTransitionProfileSetForLayout)(...args),
  schedulePendingAbyssalTransition: (...args) => (0, scope.schedulePendingAbyssalTransition)(...args),
  resolveAbyssalClientDungeonIdentifier: (...args) => (0, scope.resolveAbyssalClientDungeonIdentifier)(...args),
  revalidateDelayedAbyssalEntryHandoff: (...args) => (0, scope.revalidateDelayedAbyssalEntryHandoff)(...args),
  updatePendingAbyssalTraceActivation: (...args) => (0, scope.updatePendingAbyssalTraceActivation)(...args),
  getPendingActivation: (...args) => scope.abyssalTraceStateRegistry.getPendingActivation(...args),
  finishEntranceTransition: (...args) => (0, scope.finishEntranceTransition)(...args),
});
  scope.handleAbyssalEntranceGateActivation = handleAbyssalEntranceGateActivation;
}

function initializeManagerGroup3Binding9(scope) {
  const { handleAbyssalEndGateActivation } = (0, scope.createAbyssalEndGateRequest)({
  getDependencies: (...args) => (0, scope.getDependencies)(...args),
  validateAbyssalExitTraceActivation: (...args) => (0, scope.validateAbyssalExitTraceActivation)(...args),
  recordAuditEvent: (...args) => (0, scope.recordAuditEvent)(...args),
  get log() { return scope.log; },
  throwCustomNotify: (...args) => (0, scope.throwCustomNotify)(...args),
  throwGateRejected: (...args) => (0, scope.throwGateRejected)(...args),
  buildRoomLogContext: (...args) => (0, scope.buildRoomLogContext)(...args),
  getPendingAbyssalTransitionState: (...args) => (0, scope.getPendingAbyssalTransitionState)(...args),
  normalizeAbyssalParticipantRoster: (...args) => (0, scope.normalizeAbyssalParticipantRoster)(...args),
  get ABYSSAL_PARTICIPANT_STATUS() { return scope.ABYSSAL_PARTICIPANT_STATUS; },
  evaluateAbyssalConduitEligibility: (...args) => (0, scope.evaluateAbyssalConduitEligibility)(...args),
  buildAbyssalRoomObjectivePolicyInput: (...args) => (0, scope.buildAbyssalRoomObjectivePolicyInput)(...args),
  buildAbyssalRoomProgressionPolicyInput: (...args) => (0, scope.buildAbyssalRoomProgressionPolicyInput)(...args),
  prewarmNextPlaceholderRoomContent: (...args) => (0, scope.prewarmNextPlaceholderRoomContent)(...args),
  rollbackFailedAbyssalDestinationPrewarm: (...args) => (0, scope.rollbackFailedAbyssalDestinationPrewarm)(...args),
  getPlaceholderRoomEntry: (...args) => (0, scope.getPlaceholderRoomEntry)(...args),
  usesIsolatedAbyssalScene: (...args) => (0, scope.usesIsolatedAbyssalScene)(...args),
  buildAbyssalDestinationPreDeliveryReadiness: (...args) => (0, scope.buildAbyssalDestinationPreDeliveryReadiness)(...args),
  buildAbyssalSceneDescriptor: (...args) => (0, scope.buildAbyssalSceneDescriptor)(...args),
  getSessionContext: (...args) => (0, scope.getSessionContext)(...args),
  schedulePendingAbyssalTransition: (...args) => (0, scope.schedulePendingAbyssalTransition)(...args),
  quiesceAbyssalRoomTransferCombat: (...args) => (0, scope.quiesceAbyssalRoomTransferCombat)(...args),
  revalidateDelayedAbyssalEndGateHandoff: (...args) => (0, scope.revalidateDelayedAbyssalEndGateHandoff)(...args),
  transferShipToNextPlaceholderRoom: (...args) => (0, scope.transferShipToNextPlaceholderRoom)(...args),
  createComposedAbyssalFinalExitCoordinator: (...args) => (0, scope.createComposedAbyssalFinalExitCoordinator)(...args),
  moveShipOutOfPlaceholderPocket: (...args) => (0, scope.moveShipOutOfPlaceholderPocket)(...args),
  formatVectorForLog: (...args) => (0, scope.formatVectorForLog)(...args),
  cloneValue: (...args) => (0, scope.cloneValue)(...args),
  normalizeAbyssalRunOutcome: (...args) => (0, scope.normalizeAbyssalRunOutcome)(...args),
});
  scope.handleAbyssalEndGateActivation = handleAbyssalEndGateActivation;
}

function initializeManagerGroup3Binding10(scope) {
  const { handleAbyssalClientReady } = (0, scope.createAbyssalClientReadyRequest)({
  getDependencies: (...args) => (0, scope.getDependencies)(...args),
  getSessionContext: (...args) => (0, scope.getSessionContext)(...args),
  reconcileAbyssalFilamentCompensationsForSession: (...args) => (0, scope.reconcileAbyssalFilamentCompensationsForSession)(...args),
  log: scope.log,
  resetPersistedAbyssalRunsAfterServerRestart: (...args) => (0, scope.resetPersistedAbyssalRunsAfterServerRestart)(...args),
  runPlaceholderPocketMaintenance: (...args) => (0, scope.runPlaceholderPocketMaintenance)(...args),
  ensureSystemStalePlaceholderCleanup: (...args) => (0, scope.ensureSystemStalePlaceholderCleanup)(...args),
  settlePendingAbyssalReturnProtectionForSession: (...args) => (0, scope.settlePendingAbyssalReturnProtectionForSession)(...args),
  settlePendingAbyssalSuspectReturnForSession: (...args) => (0, scope.settlePendingAbyssalSuspectReturnForSession)(...args),
  routeAbyssalSessionStateForBeyonce: (...args) => (0, scope.routeAbyssalSessionStateForBeyonce)(...args),
  ensureClientReadyBallparkPrimed: (...args) => (0, scope.ensureClientReadyBallparkPrimed)(...args),
  completeAbyssalKSpaceArrivalForSession: (...args) => (0, scope.completeAbyssalKSpaceArrivalForSession)(...args),
  getActivePocketStateForSession: (...args) => (0, scope.getActivePocketStateForSession)(...args),
  completeAbyssalEntryReadyForSession: (...args) => (0, scope.completeAbyssalEntryReadyForSession)(...args),
  flushPendingInitialAbyssalArrivalFx: (...args) => (0, scope.flushPendingInitialAbyssalArrivalFx)(...args),
  getActiveTraceStateForCharacterID: (...args) => (0, scope.getActiveTraceStateForCharacterID)(...args),
  ensureSourceTraceRuntime: (...args) => (0, scope.ensureSourceTraceRuntime)(...args),
  publishSourceTraceInitial: (...args) => (0, scope.publishSourceTraceInitial)(...args),
  resolveAbyssalTraceAutomaticActivationDelayMs: (...args) => (0, scope.resolveAbyssalTraceAutomaticActivationDelayMs)(...args),
  resolveAbyssalTraceProfile: (...args) => (0, scope.resolveAbyssalTraceProfile)(...args),
  persistAbyssalTracePublicationState: (...args) => (0, scope.persistAbyssalTracePublicationState)(...args),
  recordAuditEvent: (...args) => (0, scope.recordAuditEvent)(...args),
});
  scope.handleAbyssalClientReady = handleAbyssalClientReady;
}

function bindAbyssalManagerRuntimeGroup3Operations(scope) {

}

function initializeAbyssalManagerRuntimeGroup3Part1(scope) {
  initializeManagerGroup3Binding1(scope);
  initializeManagerGroup3Binding2(scope);
  initializeManagerGroup3Binding3(scope);
  initializeManagerGroup3Binding4(scope);
  initializeManagerGroup3Binding5(scope);
  initializeManagerGroup3Binding6(scope);
  initializeManagerGroup3Binding7(scope);
  initializeManagerGroup3Binding8(scope);
  initializeManagerGroup3Binding9(scope);
  initializeManagerGroup3Binding10(scope);
}

function initializeAbyssalManagerRuntimeGroup3(scope) {
  initializeAbyssalManagerRuntimeGroup3Part1(scope);
}

module.exports = {
  bindAbyssalManagerRuntimeGroup3Operations,
  initializeAbyssalManagerRuntimeGroup3,
};
