"use strict";

function initializeManagerGroup1Binding1(scope) {
  const {
  createComposedAbyssalFinalExitCoordinator,
  buildAbyssalFinalExitCoordinatorRequest,
} = (0, scope.createAbyssalFinalExitInputs)({
  createAbyssalFinalExitCoordinator: (...args) => (0, scope.createAbyssalFinalExitCoordinator)(...args),
  getPendingAbyssalTransitionState: (...args) => (0, scope.getPendingAbyssalTransitionState)(...args),
  buildPlaceholderRoomState: (...args) => (0, scope.buildPlaceholderRoomState)(...args),
  normalizeAbyssalRunOutcome: (...args) => (0, scope.normalizeAbyssalRunOutcome)(...args),
});
  scope.createComposedAbyssalFinalExitCoordinator = createComposedAbyssalFinalExitCoordinator;
  scope.buildAbyssalFinalExitCoordinatorRequest = buildAbyssalFinalExitCoordinatorRequest;
}

function initializeManagerGroup1Binding2(scope) {
  const {
  buildErrorList,
  throwAbyssError,
  throwGateRejected,
  throwCustomNotify,
  buildAbyssErrorArgs,
  buildAbyssErrorFromValidationError,
} = (0, scope.createAbyssalProtocolErrors)({
  buildList: (...args) => (0, scope.buildList)(...args),
  get ABYSS_ERROR() { return scope.ABYSS_ERROR; },
  throwWrappedUserError: (...args) => (0, scope.throwWrappedUserError)(...args),
  get CLIENT_ABYSS_ERROR() { return scope.CLIENT_ABYSS_ERROR; },
});
  scope.buildErrorList = buildErrorList;
  scope.throwAbyssError = throwAbyssError;
  scope.throwGateRejected = throwGateRejected;
  scope.throwCustomNotify = throwCustomNotify;
  scope.buildAbyssErrorArgs = buildAbyssErrorArgs;
  scope.buildAbyssErrorFromValidationError = buildAbyssErrorFromValidationError;
}

function initializeManagerGroup1Binding3(scope) {
  const {
  getCharacterID,
  getSessionContext,
  getAbyssalAuditMaximumAgeMs,
  pruneExpiredAbyssalAuditEvents,
  recordAuditEvent,
} = (0, scope.createAbyssalSessionAudit)({
  get ABYSSAL_AUDIT_DEFAULT_MAX_AGE_MS() { return scope.ABYSSAL_AUDIT_DEFAULT_MAX_AGE_MS; },
  getAuditMaximumAgeMs: () => scope.config && scope.config.abyssalAuditMaximumAgeMs,
  pruneAuditEvents: (...args) => scope.abyssalDiagnosticsState.pruneAuditEvents(...args),
  sanitizeAbyssalAuditValue: (...args) => (0, scope.sanitizeAbyssalAuditValue)(...args),
  cloneArgs: (...args) => (0, scope.cloneArgs)(...args),
  get ABYSSAL_AUDIT_MAX_EVENT_BYTES() { return scope.ABYSSAL_AUDIT_MAX_EVENT_BYTES; },
  get ABYSSAL_AUDIT_REJECTION_AGGREGATION_WINDOW_MS() { return scope.ABYSSAL_AUDIT_REJECTION_AGGREGATION_WINDOW_MS; },
  get ABYSSAL_AUDIT_MAX_EVENTS() { return scope.ABYSSAL_AUDIT_MAX_EVENTS; },
  incrementAuditMetric: (...args) => scope.abyssalDiagnosticsState.incrementAuditMetric(...args),
  updateLatestAuditEvent: (...args) => scope.abyssalDiagnosticsState.updateLatestAuditEvent(...args),
  appendAuditEvent: (...args) => scope.abyssalDiagnosticsState.appendAuditEvent(...args),
});
  scope.getCharacterID = getCharacterID;
  scope.getSessionContext = getSessionContext;
  scope.getAbyssalAuditMaximumAgeMs = getAbyssalAuditMaximumAgeMs;
  scope.pruneExpiredAbyssalAuditEvents = pruneExpiredAbyssalAuditEvents;
  scope.recordAuditEvent = recordAuditEvent;
}

function initializeManagerGroup1Binding4(scope) {
  const {
  buildNewT0DarkLayoutSelection,
  logNewT0DarkLayoutSelection,
  logRecoveredT0DarkLayoutSelection,
  logAbyssalBaseRoomLayoutSelection,
  logRecoveredAbyssalBaseRoomLayoutSelection,
} = (0, scope.createAbyssalLayoutDiagnostics)({
  getContentProfile: (...args) => (0, scope.getContentProfile)(...args),
  getT0DarkLayoutCompatibilityOptions: (...args) => (0, scope.getT0DarkLayoutCompatibilityOptions)(...args),
  isCompatibleT0DarkLayoutRequest: (...args) => (0, scope.isCompatibleT0DarkLayoutRequest)(...args),
  logT0DarkLayoutCatalogWarningsOnce: (...args) => (0, scope.logT0DarkLayoutCatalogWarningsOnce)(...args),
  selectT0DarkLayoutSet: (...args) => (0, scope.selectT0DarkLayoutSet)(...args),
  getT0DarkLayoutOverride: (...args) => scope.abyssalPendingWorkRegistry.getT0DarkLayoutOverride(...args),
  get log() { return scope.log; },
  get ABYSSAL_DIAGNOSTIC_DEDUPE_SCOPE() { return scope.ABYSSAL_DIAGNOSTIC_DEDUPE_SCOPE; },
  isCapturedT0DarkContent: (...args) => (0, scope.isCapturedT0DarkContent)(...args),
  normalizeT0DarkLayoutSelectionState: (...args) => (0, scope.normalizeT0DarkLayoutSelectionState)(...args),
  hasDedupeKey: (...args) => scope.abyssalDiagnosticsState.hasDedupeKey(...args),
  recordDedupeKey: (...args) => scope.abyssalDiagnosticsState.recordDedupeKey(...args),
  normalizeAbyssalBaseRoomLayoutSelectionState: (...args) => (0, scope.normalizeAbyssalBaseRoomLayoutSelectionState)(...args),
});
  scope.buildNewT0DarkLayoutSelection = buildNewT0DarkLayoutSelection;
  scope.logNewT0DarkLayoutSelection = logNewT0DarkLayoutSelection;
  scope.logRecoveredT0DarkLayoutSelection = logRecoveredT0DarkLayoutSelection;
  scope.logAbyssalBaseRoomLayoutSelection = logAbyssalBaseRoomLayoutSelection;
  scope.logRecoveredAbyssalBaseRoomLayoutSelection = logRecoveredAbyssalBaseRoomLayoutSelection;
}

function initializeManagerGroup1Binding5(scope) {
  const {
  listT0DarkLayoutsForStaff,
  setNextT0DarkLayoutForSession,
  clearNextT0DarkLayoutForSession,
  getT0DarkLayoutStatusForSession,
  setAbyssalSuppressorDebugForSession,
  getAbyssalSuppressorDebugForSession,
} = (0, scope.createAbyssalStaffControls)({
  logT0DarkLayoutCatalogWarningsOnce: (...args) => (0, scope.logT0DarkLayoutCatalogWarningsOnce)(...args),
  listEnabledT0DarkLayoutSets: (...args) => (0, scope.listEnabledT0DarkLayoutSets)(...args),
  cloneValue: (...args) => (0, scope.cloneValue)(...args),
  getDependencies: (...args) => (0, scope.getDependencies)(...args),
  getCharacterID: (...args) => (0, scope.getCharacterID)(...args),
  resolveT0DarkLayoutSetByID: (...args) => (0, scope.resolveT0DarkLayoutSetByID)(...args),
  isCompatibleT0DarkLayoutRequest: (...args) => (0, scope.isCompatibleT0DarkLayoutRequest)(...args),
  setT0DarkLayoutOverride: (...args) => scope.abyssalPendingWorkRegistry.setT0DarkLayoutOverride(...args),
  deleteT0DarkLayoutOverride: (...args) => scope.abyssalPendingWorkRegistry.deleteT0DarkLayoutOverride(...args),
  getActivePocketStateForSession: (...args) => (0, scope.getActivePocketStateForSession)(...args),
  normalizeT0DarkLayoutSelectionState: (...args) => (0, scope.normalizeT0DarkLayoutSelectionState)(...args),
  getContentProfile: (...args) => (0, scope.getContentProfile)(...args),
  normalizeAbyssalBaseRoomLayoutSelectionState: (...args) => (0, scope.normalizeAbyssalBaseRoomLayoutSelectionState)(...args),
  getT0DarkLayoutOverride: (...args) => scope.abyssalPendingWorkRegistry.getT0DarkLayoutOverride(...args),
  setSuppressorDebugForRun: (...args) => (0, scope.setSuppressorDebugForRun)(...args),
  getSuppressorDebugSnapshot: (...args) => (0, scope.getSuppressorDebugSnapshot)(...args),
});
  scope.listT0DarkLayoutsForStaff = listT0DarkLayoutsForStaff;
  scope.setNextT0DarkLayoutForSession = setNextT0DarkLayoutForSession;
  scope.clearNextT0DarkLayoutForSession = clearNextT0DarkLayoutForSession;
  scope.getT0DarkLayoutStatusForSession = getT0DarkLayoutStatusForSession;
  scope.setAbyssalSuppressorDebugForSession = setAbyssalSuppressorDebugForSession;
  scope.getAbyssalSuppressorDebugForSession = getAbyssalSuppressorDebugForSession;
}

function initializeManagerGroup1Binding6(scope) {
  const {
  getRewardState,
  getRewardCacheItemID,
} = (0, scope.createAbyssalRewardStateViews)({
  cloneValue: (...args) => (0, scope.cloneValue)(...args),
  getPlaceholderRoomEntry: (...args) => (0, scope.getPlaceholderRoomEntry)(...args),
});
  scope.getRewardState = getRewardState;
  scope.getRewardCacheItemID = getRewardCacheItemID;
}

function initializeManagerGroup1Binding7(scope) {
  const {
  summarizeContentSummary,
  countMaterializedContent,
  shouldAttemptAuthoredSiteMaterialization,
} = (0, scope.createAbyssalContentMaterializationViews)({
  get PLACEHOLDER_POCKET_MODE() { return scope.PLACEHOLDER_POCKET_MODE; },
});
  scope.summarizeContentSummary = summarizeContentSummary;
  scope.countMaterializedContent = countMaterializedContent;
  scope.shouldAttemptAuthoredSiteMaterialization = shouldAttemptAuthoredSiteMaterialization;
}

function initializeManagerGroup1Binding8(scope) {
  const {
  sceneHasDynamicEntity,
  sceneBubbleHasEntity,
  getReadOnlySolarSystemScene,
  collectAbyssalNpcSceneRegistrationDiagnostics,
  formatAbyssalNpcSceneRegistrationDiagnostics,
  resolveEntityBubbleForScene,
} = (0, scope.createAbyssalSceneDiagnostics)({
  getDependencies: (...args) => (0, scope.getDependencies)(...args),
  buildSlimItemObject: (...args) => scope.destiny.buildSlimItemObject(...args),
});
  scope.sceneHasDynamicEntity = sceneHasDynamicEntity;
  scope.sceneBubbleHasEntity = sceneBubbleHasEntity;
  scope.getReadOnlySolarSystemScene = getReadOnlySolarSystemScene;
  scope.collectAbyssalNpcSceneRegistrationDiagnostics = collectAbyssalNpcSceneRegistrationDiagnostics;
  scope.formatAbyssalNpcSceneRegistrationDiagnostics = formatAbyssalNpcSceneRegistrationDiagnostics;
  scope.resolveEntityBubbleForScene = resolveEntityBubbleForScene;
}

function initializeManagerGroup1Binding9(scope) {
  const {
  isAbyssalIsolatedScenesEnabled,
  normalizeAbyssalSceneMode,
  getConfiguredAbyssalSceneModeSource,
  resolveAbyssalSceneModeState,
  usesIsolatedAbyssalScene,
  logRecoveredAbyssalSceneMode,
  logAmbiguousAbyssalSceneMode,
  validateAbyssalIsolatedSceneRuntime,
  buildAbyssalSceneDescriptor,
  getPocketScene,
} = (0, scope.createAbyssalSceneMode)({
  get ABYSSAL_SCENE_MODE_ISOLATED() { return scope.ABYSSAL_SCENE_MODE_ISOLATED; },
  get ABYSSAL_SCENE_MODE_LEGACY() { return scope.ABYSSAL_SCENE_MODE_LEGACY; },
  getDependencies: (...args) => (0, scope.getDependencies)(...args),
  get ABYSSAL_DIAGNOSTIC_DEDUPE_SCOPE() { return scope.ABYSSAL_DIAGNOSTIC_DEDUPE_SCOPE; },
  get log() { return scope.log; },
  hasDedupeKey: (...args) => scope.abyssalDiagnosticsState.hasDedupeKey(...args),
  recordDedupeKey: (...args) => scope.abyssalDiagnosticsState.recordDedupeKey(...args),
});
  scope.isAbyssalIsolatedScenesEnabled = isAbyssalIsolatedScenesEnabled;
  scope.normalizeAbyssalSceneMode = normalizeAbyssalSceneMode;
  scope.getConfiguredAbyssalSceneModeSource = getConfiguredAbyssalSceneModeSource;
  scope.resolveAbyssalSceneModeState = resolveAbyssalSceneModeState;
  scope.usesIsolatedAbyssalScene = usesIsolatedAbyssalScene;
  scope.logRecoveredAbyssalSceneMode = logRecoveredAbyssalSceneMode;
  scope.logAmbiguousAbyssalSceneMode = logAmbiguousAbyssalSceneMode;
  scope.validateAbyssalIsolatedSceneRuntime = validateAbyssalIsolatedSceneRuntime;
  scope.buildAbyssalSceneDescriptor = buildAbyssalSceneDescriptor;
  scope.getPocketScene = getPocketScene;
}

function initializeManagerGroup1Binding10(scope) {
  const {
  hasAbyssalAdministrativeRole,
  isAbyssalRestrictionBypassAllowed,
  buildAbyssalVisibilityRestrictionEntry,
  resolveAbyssalVisibilityRestrictionForSession,
  buildAbyssalVisibilityRestrictionSummaryForSession,
} = (0, scope.createAbyssalVisibilityRestrictions)({
  normalizeRoleValue: (...args) => (0, scope.normalizeRoleValue)(...args),
  get ROLEMASK_VIEW() { return scope.ROLEMASK_VIEW; },
  get ABYSSAL_INTERNAL_BYPASS() { return scope.ABYSSAL_INTERNAL_BYPASS; },
  get ABYSSAL_VISIBILITY_STATUS() { return scope.ABYSSAL_VISIBILITY_STATUS; },
  getSessionContext: (...args) => (0, scope.getSessionContext)(...args),
  isAbyssalHostLocationID: (...args) => (0, scope.isAbyssalHostLocationID)(...args),
  getActiveAbyssalRunForCharacterID: (...args) => (0, scope.getActiveAbyssalRunForCharacterID)(...args),
  getActiveAbyssalRunForShipID: (...args) => (0, scope.getActiveAbyssalRunForShipID)(...args),
  getActivePocketStateForSession: (...args) => (0, scope.getActivePocketStateForSession)(...args),
});
  scope.hasAbyssalAdministrativeRole = hasAbyssalAdministrativeRole;
  scope.isAbyssalRestrictionBypassAllowed = isAbyssalRestrictionBypassAllowed;
  scope.buildAbyssalVisibilityRestrictionEntry = buildAbyssalVisibilityRestrictionEntry;
  scope.resolveAbyssalVisibilityRestrictionForSession = resolveAbyssalVisibilityRestrictionForSession;
  scope.buildAbyssalVisibilityRestrictionSummaryForSession = buildAbyssalVisibilityRestrictionSummaryForSession;
}

function initializeManagerGroup1Binding11(scope) {
  const {
  appendPlacementBlocker,
  collectPlacementBlockers,
  findPlacementConflict,
} = (0, scope.createAbyssalDeploymentPlacement)({
  matchesTypeList: (...args) => (0, scope.matchesTypeList)(...args),
  get FILAMENT_PROXIMITY_RESTRICTION_LIST_ID() { return scope.FILAMENT_PROXIMITY_RESTRICTION_LIST_ID; },
  get MIN_DISTANCE_FROM_DISALLOWED_OBJECTS_METERS() { return scope.MIN_DISTANCE_FROM_DISALLOWED_OBJECTS_METERS; },
});
  scope.appendPlacementBlocker = appendPlacementBlocker;
  scope.collectPlacementBlockers = collectPlacementBlockers;
  scope.findPlacementConflict = findPlacementConflict;
}

function initializeManagerGroup1Binding12(scope) {
  const {
  buildValidationError,
  normalizeSecurityBand,
  getAbyssalShipCloakMode,
  hasActiveAbyssalCynosuralGeneration,
  listAbyssalValidationSceneEntities,
  isAbyssalShipInsideForceField,
  buildAbyssalShipStateBlock,
  resolveAbyssalSecurityPolicy,
  buildAbyssalSecurityRestrictionNotify,
} = (0, scope.createAbyssalAdmissionPolicies)({
  get ABYSS_ERROR() { return scope.ABYSS_ERROR; },
  cloneValue: (...args) => (0, scope.cloneValue)(...args),
  resolveTypeRecord: (...args) => (0, scope.resolveTypeRecord)(...args),
  get FORCE_FIELD_GROUP_ID() { return scope.FORCE_FIELD_GROUP_ID; },
  get ABYSSAL_SHIP_STATE_CLIENT_CODE() { return scope.ABYSSAL_SHIP_STATE_CLIENT_CODE; },
  get CLIENT_ABYSS_ERROR() { return scope.CLIENT_ABYSS_ERROR; },
});
  scope.buildValidationError = buildValidationError;
  scope.normalizeSecurityBand = normalizeSecurityBand;
  scope.getAbyssalShipCloakMode = getAbyssalShipCloakMode;
  scope.hasActiveAbyssalCynosuralGeneration = hasActiveAbyssalCynosuralGeneration;
  scope.listAbyssalValidationSceneEntities = listAbyssalValidationSceneEntities;
  scope.isAbyssalShipInsideForceField = isAbyssalShipInsideForceField;
  scope.buildAbyssalShipStateBlock = buildAbyssalShipStateBlock;
  scope.resolveAbyssalSecurityPolicy = resolveAbyssalSecurityPolicy;
  scope.buildAbyssalSecurityRestrictionNotify = buildAbyssalSecurityRestrictionNotify;
}

function initializeManagerGroup1Binding13(scope) {
  const {
  getItemQuantity,
  resolveTypeRecord,
  getGroupID,
  getCategoryID,
  getGroupName,
  isAbyssalFilamentItem,
  resolveShipClassProfile,
} = (0, scope.createAbyssalInventoryTypeViews)({
  get GROUP_ABYSSAL_FILAMENT() { return scope.GROUP_ABYSSAL_FILAMENT; },
  get CATEGORY_SHIP() { return scope.CATEGORY_SHIP; },
  matchesTypeList: (...args) => (0, scope.matchesTypeList)(...args),
  get FILAMENT_FRIGATE_TYPE_RESTRICTION_LIST_ID() { return scope.FILAMENT_FRIGATE_TYPE_RESTRICTION_LIST_ID; },
  get FILAMENT_DESTROYER_TYPE_RESTRICTION_LIST_ID() { return scope.FILAMENT_DESTROYER_TYPE_RESTRICTION_LIST_ID; },
  get FILAMENT_CRUISER_TYPE_RESTRICTION_LIST_ID() { return scope.FILAMENT_CRUISER_TYPE_RESTRICTION_LIST_ID; },
});
  scope.getItemQuantity = getItemQuantity;
  scope.resolveTypeRecord = resolveTypeRecord;
  scope.getGroupID = getGroupID;
  scope.getCategoryID = getCategoryID;
  scope.getGroupName = getGroupName;
  scope.isAbyssalFilamentItem = isAbyssalFilamentItem;
  scope.resolveShipClassProfile = resolveShipClassProfile;
}

function initializeManagerGroup1Binding14(scope) {
  const {
  resolveFilamentContentDefinition,
  resolveTraceContentProfile,
  resolveFilamentItemID,
  resolveActivateForFleet,
  isFleetRequiredForAbyssalShipProfile,
  resolveGateTraceID,
  resolveAbyssalTierFromFilamentName,
  resolveAbyssalTemplateID,
  buildPocketSiteKey,
} = (0, scope.createAbyssalActivationInputs)({
  getDependencies: (...args) => (0, scope.getDependencies)(...args),
  get log() { return scope.log; },
  get resolveFilamentDefinition() {
    return typeof scope.AbyssalContentManagerService.resolveFilamentDefinition === "function"
      ? (...args) => scope.AbyssalContentManagerService.resolveFilamentDefinition(...args)
      : undefined;
  },
  getContentProfile: (...args) => (0, scope.getContentProfile)(...args),
  isAbyssalFilamentItem: (...args) => (0, scope.isAbyssalFilamentItem)(...args),
  getActiveTraceState: (...args) => (0, scope.getActiveTraceState)(...args),
  getCharacterID: (...args) => (0, scope.getCharacterID)(...args),
  getTraceIDForCharacter: (...args) => scope.abyssalTraceStateRegistry.getTraceIDForCharacter(...args),
  get PLACEHOLDER_POCKET_TEMPLATE_ID_BY_TIER() { return scope.PLACEHOLDER_POCKET_TEMPLATE_ID_BY_TIER; },
});
  scope.resolveFilamentContentDefinition = resolveFilamentContentDefinition;
  scope.resolveTraceContentProfile = resolveTraceContentProfile;
  scope.resolveFilamentItemID = resolveFilamentItemID;
  scope.resolveActivateForFleet = resolveActivateForFleet;
  scope.isFleetRequiredForAbyssalShipProfile = isFleetRequiredForAbyssalShipProfile;
  scope.resolveGateTraceID = resolveGateTraceID;
  scope.resolveAbyssalTierFromFilamentName = resolveAbyssalTierFromFilamentName;
  scope.resolveAbyssalTemplateID = resolveAbyssalTemplateID;
  scope.buildPocketSiteKey = buildPocketSiteKey;
}

function initializeManagerGroup1Binding15(scope) {
  const {
  buildAbyssalRoomOneFxSelection,
  getAbyssalRoomOneClientFxState,
  updateAbyssalRoomOneFxState,
  maybeSendAbyssalRoomOneClientFx,
  playAbyssalCalmDarkFxProbeForSession,
} = (0, scope.createAbyssalRoomClientEffects)({
  resolveAbyssalCalmDarkProbeEffect: (...args) => (0, scope.resolveAbyssalCalmDarkProbeEffect)(...args),
  get ABYSSAL_CALM_DARK_DEFAULT_EFFECT_KEY() { return scope.ABYSSAL_CALM_DARK_DEFAULT_EFFECT_KEY; },
  listAbyssalCalmDarkProbeEffectKeys: (...args) => (0, scope.listAbyssalCalmDarkProbeEffectKeys)(...args),
  updatePocketState: (...args) => (0, scope.updatePocketState)(...args),
  cloneValue: (...args) => (0, scope.cloneValue)(...args),
  getDependencies: (...args) => (0, scope.getDependencies)(...args),
  getContentProfile: (...args) => (0, scope.getContentProfile)(...args),
  buildPlaceholderRoomState: (...args) => (0, scope.buildPlaceholderRoomState)(...args),
  isAbyssalVisualFxContentProfile: (...args) => (0, scope.isAbyssalVisualFxContentProfile)(...args),
  buildAbyssalRoomOneFxStatus: (...args) => (0, scope.buildAbyssalRoomOneFxStatus)(...args),
});
  scope.buildAbyssalRoomOneFxSelection = buildAbyssalRoomOneFxSelection;
  scope.getAbyssalRoomOneClientFxState = getAbyssalRoomOneClientFxState;
  scope.updateAbyssalRoomOneFxState = updateAbyssalRoomOneFxState;
  scope.maybeSendAbyssalRoomOneClientFx = maybeSendAbyssalRoomOneClientFx;
  scope.playAbyssalCalmDarkFxProbeForSession = playAbyssalCalmDarkFxProbeForSession;
}

function initializeManagerGroup1Binding16(scope) {
  const {
  buildAbyssalSceneryVisualStatus,
  buildAbyssalSceneryProbeStatus,
  buildAbyssalRoomVisualStatus,
  buildAbyssalRoomOneFxStatus,
} = (0, scope.createAbyssalVisualDiagnostics)({
  getDependencies: (...args) => (0, scope.getDependencies)(...args),
  isAbyssalSceneryVisualsRequested: (...args) => (0, scope.isAbyssalSceneryVisualsRequested)(...args),
  buildPlaceholderRoomState: (...args) => (0, scope.buildPlaceholderRoomState)(...args),
  getContentProfile: (...args) => (0, scope.getContentProfile)(...args),
  getAbyssalSceneryProfileForRoomIndex: (...args) => (0, scope.getAbyssalSceneryProfileForRoomIndex)(...args),
  resolveAbyssalSceneryPolicy: (...args) => (0, scope.resolveAbyssalSceneryPolicy)(...args),
  get SCENERY_POLICY_AUTHORITATIVE() { return scope.SCENERY_POLICY_AUTHORITATIVE; },
  buildAbyssalSceneryProfileSummary: (...args) => (0, scope.buildAbyssalSceneryProfileSummary)(...args),
  getPlaceholderRoomEntry: (...args) => (0, scope.getPlaceholderRoomEntry)(...args),
  get ABYSSAL_SCENERY_GUARD_STATUS() { return scope.ABYSSAL_SCENERY_GUARD_STATUS; },
  isSupportedCalmSceneryContentProfile: (...args) => (0, scope.isSupportedCalmSceneryContentProfile)(...args),
  resolveAbyssalSceneryProbeCandidate: (...args) => (0, scope.resolveAbyssalSceneryProbeCandidate)(...args),
  buildAbyssalSceneryProbeCatalogueEntry: (...args) => (0, scope.buildAbyssalSceneryProbeCatalogueEntry)(...args),
  getAbyssalSceneryProbeCandidateIndex: (...args) => (0, scope.getAbyssalSceneryProbeCandidateIndex)(...args),
  get ABYSSAL_SCENERY_PROBE_PROFILE() { return scope.ABYSSAL_SCENERY_PROBE_PROFILE; },
  listAbyssalSceneryProbeCandidateKeys: (...args) => (0, scope.listAbyssalSceneryProbeCandidateKeys)(...args),
  resolveAbyssalEnvironmentRoomProfileForPocket: (...args) => (0, scope.resolveAbyssalEnvironmentRoomProfileForPocket)(...args),
  describeAbyssalEnvironmentSource: (...args) => (0, scope.describeAbyssalEnvironmentSource)(...args),
  usesIsolatedAbyssalScene: (...args) => (0, scope.usesIsolatedAbyssalScene)(...args),
  get ABYSSAL_ROOM_VISUAL_PROFILE() { return scope.ABYSSAL_ROOM_VISUAL_PROFILE; },
  isAbyssalVisualFxContentProfile: (...args) => (0, scope.isAbyssalVisualFxContentProfile)(...args),
  buildAbyssalRoomOneFxSelection: (...args) => (0, scope.buildAbyssalRoomOneFxSelection)(...args),
  getAbyssalRoomOneClientFxState: (...args) => (0, scope.getAbyssalRoomOneClientFxState)(...args),
});
  scope.buildAbyssalSceneryVisualStatus = buildAbyssalSceneryVisualStatus;
  scope.buildAbyssalSceneryProbeStatus = buildAbyssalSceneryProbeStatus;
  scope.buildAbyssalRoomVisualStatus = buildAbyssalRoomVisualStatus;
  scope.buildAbyssalRoomOneFxStatus = buildAbyssalRoomOneFxStatus;
}

function initializeManagerGroup1Binding17(scope) {
  const {
  listAbyssalSceneryProbeCandidateKeys,
  getAbyssalSceneryProbeCandidateIndex,
  resolveAbyssalSceneryProbeCandidate,
  listAbyssalSceneryProbeCatalogueCategoryKeys,
  resolveAbyssalSceneryProbeCatalogueCategory,
  buildAbyssalSceneryProbeCatalogueEntry,
  listAbyssalSceneryProbeCatalogue,
  listAbyssalSceneryProbePresetKeys,
  resolveAbyssalSceneryProbePreset,
} = (0, scope.createAbyssalProbeCatalogue)({
  get ABYSSAL_SCENERY_PROBE_PROFILE() { return scope.ABYSSAL_SCENERY_PROBE_PROFILE; },
  cloneValue: (...args) => (0, scope.cloneValue)(...args),
  getDependencies: (...args) => (0, scope.getDependencies)(...args),
});
  scope.listAbyssalSceneryProbeCandidateKeys = listAbyssalSceneryProbeCandidateKeys;
  scope.getAbyssalSceneryProbeCandidateIndex = getAbyssalSceneryProbeCandidateIndex;
  scope.resolveAbyssalSceneryProbeCandidate = resolveAbyssalSceneryProbeCandidate;
  scope.listAbyssalSceneryProbeCatalogueCategoryKeys = listAbyssalSceneryProbeCatalogueCategoryKeys;
  scope.resolveAbyssalSceneryProbeCatalogueCategory = resolveAbyssalSceneryProbeCatalogueCategory;
  scope.buildAbyssalSceneryProbeCatalogueEntry = buildAbyssalSceneryProbeCatalogueEntry;
  scope.listAbyssalSceneryProbeCatalogue = listAbyssalSceneryProbeCatalogue;
  scope.listAbyssalSceneryProbePresetKeys = listAbyssalSceneryProbePresetKeys;
  scope.resolveAbyssalSceneryProbePreset = resolveAbyssalSceneryProbePreset;
}

function initializeManagerGroup1Binding18(scope) {
  const {
  isAbyssalSceneryVisualsRequested,
  isSupportedAbyssalContentTier,
  isSupportedBaselineAbyssalContentTier,
  isSupportedCalmSceneryContentProfile,
  isAbyssalVisualFxContentProfile,
} = (0, scope.createAbyssalVisualPolicy)({
  getDependencies: (...args) => (0, scope.getDependencies)(...args),
  get SUPPORTED_ABYSSAL_CONTENT_TIERS() { return scope.SUPPORTED_ABYSSAL_CONTENT_TIERS; },
  get CALM_SCENERY_SUPPORTED_WEATHER_TYPES() { return scope.CALM_SCENERY_SUPPORTED_WEATHER_TYPES; },
});
  scope.isAbyssalSceneryVisualsRequested = isAbyssalSceneryVisualsRequested;
  scope.isSupportedAbyssalContentTier = isSupportedAbyssalContentTier;
  scope.isSupportedBaselineAbyssalContentTier = isSupportedBaselineAbyssalContentTier;
  scope.isSupportedCalmSceneryContentProfile = isSupportedCalmSceneryContentProfile;
  scope.isAbyssalVisualFxContentProfile = isAbyssalVisualFxContentProfile;
}

function initializeManagerGroup1Binding19(scope) {
  const {
  buildAbyssalNpcSpawnPosition,
  buildSourceTransitionState,
  buildDeployStateFromShipEntity,
  buildPlaceholderPocketPosition,
  buildPlaceholderShipSpaceState,
  buildPlaceholderReturnSpaceState,
  isPointWithinPocketRecoveryRadius,
  buildRewardCacheSpawnState,
  buildExtractionNodeSpawnStates,
} = (0, scope.createAbyssalSpawnGeometry)({
  resolveRoomOriginPosition: (...args) => (0, scope.resolveRoomOriginPosition)(...args),
  buildRoomConduitState: (...args) => (0, scope.buildRoomConduitState)(...args),
  buildRoomLateralDirection: (...args) => (0, scope.buildRoomLateralDirection)(...args),
  getPlaceholderRoomEntry: (...args) => (0, scope.getPlaceholderRoomEntry)(...args),
  get PLACEHOLDER_ROOM_CLEANUP_RADIUS_METERS() { return scope.PLACEHOLDER_ROOM_CLEANUP_RADIUS_METERS; },
  nextAbyssalEncounterRandom: (...args) => (0, scope.nextAbyssalEncounterRandom)(...args),
  resolveAbyssalTraceProfile: (...args) => (0, scope.resolveAbyssalTraceProfile)(...args),
  get DEPLOY_DISTANCE_METERS() { return scope.DEPLOY_DISTANCE_METERS; },
  get PLACEHOLDER_POCKET_OFFSET_METERS() { return scope.PLACEHOLDER_POCKET_OFFSET_METERS; },
  get PLACEHOLDER_POCKET_SHIP_OFFSET_METERS() { return scope.PLACEHOLDER_POCKET_SHIP_OFFSET_METERS; },
  getContentProfile: (...args) => (0, scope.getContentProfile)(...args),
  get PLACEHOLDER_RETURN_OFFSET_METERS() { return scope.PLACEHOLDER_RETURN_OFFSET_METERS; },
  get PLACEHOLDER_RELOG_RECOVERY_RADIUS_METERS() { return scope.PLACEHOLDER_RELOG_RECOVERY_RADIUS_METERS; },
  getDependencies: (...args) => (0, scope.getDependencies)(...args),
  getCacheProfile: (...args) => (0, scope.getCacheProfile)(...args),
  buildPlaceholderRoomState: (...args) => (0, scope.buildPlaceholderRoomState)(...args),
  getCapturedT0DarkRoom: (...args) => (0, scope.getCapturedT0DarkRoom)(...args),
  cloneValue: (...args) => (0, scope.cloneValue)(...args),
  getCapturedAuthoredRoom: (...args) => (0, scope.getCapturedAuthoredRoom)(...args),
  getCapturedAuthoredRoomEntity: (...args) => (0, scope.getCapturedAuthoredRoomEntity)(...args),
  buildCapturedAuthoredDunRotation: (...args) => (0, scope.buildCapturedAuthoredDunRotation)(...args),
  buildRoomOffsetFromConduitState: (...args) => (0, scope.buildRoomOffsetFromConduitState)(...args),
  get PLACEHOLDER_REWARD_CACHE_OFFSET_METERS() { return scope.PLACEHOLDER_REWARD_CACHE_OFFSET_METERS; },
  get TYPE_ABYSSAL_EXTRACTION_NODE() { return scope.TYPE_ABYSSAL_EXTRACTION_NODE; },
  get MIN_EXTRACTION_NODE_FROM_CONDUIT_METERS() { return scope.MIN_EXTRACTION_NODE_FROM_CONDUIT_METERS; },
  get PLACEHOLDER_EXTRACTION_NODE_FROM_CONDUIT_METERS() { return scope.PLACEHOLDER_EXTRACTION_NODE_FROM_CONDUIT_METERS; },
});
  scope.buildAbyssalNpcSpawnPosition = buildAbyssalNpcSpawnPosition;
  scope.buildSourceTransitionState = buildSourceTransitionState;
  scope.buildDeployStateFromShipEntity = buildDeployStateFromShipEntity;
  scope.buildPlaceholderPocketPosition = buildPlaceholderPocketPosition;
  scope.buildPlaceholderShipSpaceState = buildPlaceholderShipSpaceState;
  scope.buildPlaceholderReturnSpaceState = buildPlaceholderReturnSpaceState;
  scope.isPointWithinPocketRecoveryRadius = isPointWithinPocketRecoveryRadius;
  scope.buildRewardCacheSpawnState = buildRewardCacheSpawnState;
  scope.buildExtractionNodeSpawnStates = buildExtractionNodeSpawnStates;
}

function initializeManagerGroup1Binding20(scope) {
  const {
  resolveConfiguredAbyssalDurationMs,
  resolveConfiguredUnusedTraceDurationMs,
  resolveConfiguredAbyssalReturnProtectionDurationMs,
  getAbyssalTimeoutPolicy,
  resolvePlaceholderDurationMs,
  getAbyssalTimeoutState,
  buildPlaceholderTimerState,
} = (0, scope.createAbyssalTimerModels)({
  getDependencies: (...args) => (0, scope.getDependencies)(...args),
  get ABYSS_RUN_DURATION_MS() { return scope.ABYSS_RUN_DURATION_MS; },
  get ABYSS_UNUSED_TRACE_DURATION_MS() { return scope.ABYSS_UNUSED_TRACE_DURATION_MS; },
  get ABYSS_RETURN_PROTECTION_DURATION_MS() { return scope.ABYSS_RETURN_PROTECTION_DURATION_MS; },
  get ABYSSAL_TIMEOUT_MODE() { return scope.ABYSSAL_TIMEOUT_MODE; },
  getContentProfile: (...args) => (0, scope.getContentProfile)(...args),
  hasFailedTimeoutOutcome: (...args) => (0, scope.hasFailedTimeoutOutcome)(...args),
  get ABYSSAL_TIMEOUT_POD_STATUS() { return scope.ABYSSAL_TIMEOUT_POD_STATUS; },
});
  scope.resolveConfiguredAbyssalDurationMs = resolveConfiguredAbyssalDurationMs;
  scope.resolveConfiguredUnusedTraceDurationMs = resolveConfiguredUnusedTraceDurationMs;
  scope.resolveConfiguredAbyssalReturnProtectionDurationMs = resolveConfiguredAbyssalReturnProtectionDurationMs;
  scope.getAbyssalTimeoutPolicy = getAbyssalTimeoutPolicy;
  scope.resolvePlaceholderDurationMs = resolvePlaceholderDurationMs;
  scope.getAbyssalTimeoutState = getAbyssalTimeoutState;
  scope.buildPlaceholderTimerState = buildPlaceholderTimerState;
}

function initializeManagerGroup1Binding21(scope) {
  const {
  resolveEmpiricalRewardLootEntries,
  resolveObservedRunRewardLootEntries,
  buildResolvedRewardCacheLootEntries,
  listContainerLootEntries,
  listCombinedContainerLootEntries,
  resolveRoomExtractionNodeProfile,
  buildResolvedExtractionNodeLootEntries,
} = (0, scope.createAbyssalRewardLootResolution)({
  getAbyssalEmpiricalTierLootTable: (...args) => (0, scope.getAbyssalEmpiricalTierLootTable)(...args),
  nextAbyssalLootRandom: (...args) => (0, scope.nextAbyssalLootRandom)(...args),
  rollRewardEntryQuantity: (...args) => (0, scope.rollRewardEntryQuantity)(...args),
  cloneValue: (...args) => (0, scope.cloneValue)(...args),
  isObservedRunRewardAllocationProfile: (...args) => (0, scope.isObservedRunRewardAllocationProfile)(...args),
  validateObservedRunRewardAllocation: (...args) => (0, scope.validateObservedRunRewardAllocation)(...args),
  buildObservedRunRewardAllocation: (...args) => (0, scope.buildObservedRunRewardAllocation)(...args),
  getObservedRunRewardArtifactAllocation: (...args) => (0, scope.getObservedRunRewardArtifactAllocation)(...args),
  selectObservedRunRewardOutcome: (...args) => (0, scope.selectObservedRunRewardOutcome)(...args),
  getDependencies: (...args) => (0, scope.getDependencies)(...args),
  buildRewardLootRollContext: (...args) => (0, scope.buildRewardLootRollContext)(...args),
  listGuaranteedRewardLootEntries: (...args) => (0, scope.listGuaranteedRewardLootEntries)(...args),
  isRewardLootEntryEligibleForContext: (...args) => (0, scope.isRewardLootEntryEligibleForContext)(...args),
  selectWeightedRewardLootEntry: (...args) => (0, scope.selectWeightedRewardLootEntry)(...args),
  applyRoomRewardQuantityAdjustments: (...args) => (0, scope.applyRoomRewardQuantityAdjustments)(...args),
  mergeAbyssalRewardEntries: (...args) => (0, scope.mergeAbyssalRewardEntries)(...args),
  applyRewardQuantityPolicy: (...args) => (0, scope.applyRewardQuantityPolicy)(...args),
  getCacheRewardQuantityMultiplier: (...args) => (0, scope.getCacheRewardQuantityMultiplier)(...args),
  validateRewardProfileQuantityPolicy: (...args) => (0, scope.validateRewardProfileQuantityPolicy)(...args),
  buildPlaceholderRoomState: (...args) => (0, scope.buildPlaceholderRoomState)(...args),
  logTier0RewardResolution: (...args) => (0, scope.logTier0RewardResolution)(...args),
  logTier2RewardResolution: (...args) => (0, scope.logTier2RewardResolution)(...args),
  resolveInventoryItemLogicalQuantity: (...args) => (0, scope.resolveInventoryItemLogicalQuantity)(...args),
  getContentProfile: (...args) => (0, scope.getContentProfile)(...args),
  getExtractionNodeProfile: (...args) => (0, scope.getExtractionNodeProfile)(...args),
  isProceduralAbyssalContent: (...args) => (0, scope.isProceduralAbyssalContent)(...args),
  buildAbyssalContentResolutionError: (...args) => (0, scope.buildAbyssalContentResolutionError)(...args),
  clampRoomIndex: (...args) => (0, scope.clampRoomIndex)(...args),
  resolveRoomEncounterProfile: (...args) => (0, scope.resolveRoomEncounterProfile)(...args),
  getAuthoredRoomEncounterProfile: (...args) => (0, scope.getAuthoredRoomEncounterProfile)(...args),
  isTranquilAbyssalContent: (...args) => (0, scope.isTranquilAbyssalContent)(...args),
  applyRewardQuantityMultiplier: (...args) => (0, scope.applyRewardQuantityMultiplier)(...args),
  get shouldUseCorrelatedAbyssalSpaceEmpiricalContent() {
    return typeof scope.AbyssalContentManagerService.shouldUseCorrelatedAbyssalSpaceEmpiricalContent === "function"
      ? (...args) => scope.AbyssalContentManagerService.shouldUseCorrelatedAbyssalSpaceEmpiricalContent(...args)
      : undefined;
  },
  get isSupportedAbyssalExtractionEncounter() {
    return typeof scope.AbyssalContentManagerService.isSupportedAbyssalExtractionEncounter === "function"
      ? (...args) => scope.AbyssalContentManagerService.isSupportedAbyssalExtractionEncounter(...args)
      : undefined;
  },
});
  scope.resolveEmpiricalRewardLootEntries = resolveEmpiricalRewardLootEntries;
  scope.resolveObservedRunRewardLootEntries = resolveObservedRunRewardLootEntries;
  scope.buildResolvedRewardCacheLootEntries = buildResolvedRewardCacheLootEntries;
  scope.listContainerLootEntries = listContainerLootEntries;
  scope.listCombinedContainerLootEntries = listCombinedContainerLootEntries;
  scope.resolveRoomExtractionNodeProfile = resolveRoomExtractionNodeProfile;
  scope.buildResolvedExtractionNodeLootEntries = buildResolvedExtractionNodeLootEntries;
}

function bindAbyssalManagerRuntimeGroup1Operations(scope) {

}

function initializeAbyssalManagerRuntimeGroup1Part1(scope) {
  initializeManagerGroup1Binding1(scope);
  initializeManagerGroup1Binding2(scope);
  initializeManagerGroup1Binding3(scope);
  initializeManagerGroup1Binding4(scope);
  initializeManagerGroup1Binding5(scope);
  initializeManagerGroup1Binding6(scope);
  initializeManagerGroup1Binding7(scope);
  initializeManagerGroup1Binding8(scope);
  initializeManagerGroup1Binding9(scope);
  initializeManagerGroup1Binding10(scope);
  initializeManagerGroup1Binding11(scope);
  initializeManagerGroup1Binding12(scope);
  initializeManagerGroup1Binding13(scope);
  initializeManagerGroup1Binding14(scope);
  initializeManagerGroup1Binding15(scope);
  initializeManagerGroup1Binding16(scope);
  initializeManagerGroup1Binding17(scope);
  initializeManagerGroup1Binding18(scope);
  initializeManagerGroup1Binding19(scope);
  initializeManagerGroup1Binding20(scope);
  initializeManagerGroup1Binding21(scope);
}

function initializeAbyssalManagerRuntimeGroup1(scope) {
  initializeAbyssalManagerRuntimeGroup1Part1(scope);
}

module.exports = {
  bindAbyssalManagerRuntimeGroup1Operations,
  initializeAbyssalManagerRuntimeGroup1,
};
