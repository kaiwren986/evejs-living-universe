"use strict";

function buildManagerGroup12Binding7Part2(scope) {
  return {
  get getDependencies() { return scope.getDependencies; },
  get toReal() { return scope.toReal; },
  get normalizeLowerText() { return scope.normalizeLowerText; },
  get isAbyssalHostLocationID() { return scope.isAbyssalHostLocationID; },
  get buildAbyssalShipStateBlock() { return scope.buildAbyssalShipStateBlock; },
  get VOID_SYSTEM_ID_MIN() { return scope.VOID_SYSTEM_ID_MIN; },
  get VOID_SYSTEM_ID_MAX() { return scope.VOID_SYSTEM_ID_MAX; },
  get SOLAR_SYSTEM_ZARZAKH() { return scope.SOLAR_SYSTEM_ZARZAKH; },
  get isAbyssalShipInsideForceField() { return scope.isAbyssalShipInsideForceField; },
  get getAbyssalShipCloakMode() { return scope.getAbyssalShipCloakMode; },
  get hostileModuleRuntime() { return scope.hostileModuleRuntime; },
  get hasActiveAbyssalCynosuralGeneration() { return scope.hasActiveAbyssalCynosuralGeneration; },
  get getSessionContext() { return scope.getSessionContext; },
  get resolveActivateForFleet() { return scope.resolveActivateForFleet; },
  get resetPersistedAbyssalRunsAfterServerRestart() { return scope.resetPersistedAbyssalRunsAfterServerRestart; },
  get ensureSystemStalePlaceholderCleanup() { return scope.ensureSystemStalePlaceholderCleanup; },
  get ABYSS_ERROR() { return scope.ABYSS_ERROR; },
  get ABYSS_ERROR_KIND() { return scope.ABYSS_ERROR_KIND; },
  get buildValidationError() { return scope.buildValidationError; },
  get resolveExistingActiveRunConflict() { return scope.resolveExistingActiveRunConflict; },
  get resolveShipClassProfile() { return scope.resolveShipClassProfile; },
  get getGroupID() { return scope.getGroupID; },
  get getGroupName() { return scope.getGroupName; },
  get resolveFilamentItemID() { return scope.resolveFilamentItemID; },
  get isAbyssalFilamentItem() { return scope.isAbyssalFilamentItem; },
  get resolveTypeRecord() { return scope.resolveTypeRecord; },
  get resolveFilamentContentDefinition() { return scope.resolveFilamentContentDefinition; },
  get getItemQuantity() { return scope.getItemQuantity; },
  get isFleetRequiredForAbyssalShipProfile() { return scope.isFleetRequiredForAbyssalShipProfile; },
  get resolveAuthoritativeAbyssalFleetMembership() { return scope.resolveAuthoritativeAbyssalFleetMembership; },
  get resolveAbyssalSecurityPolicy() { return scope.resolveAbyssalSecurityPolicy; },
  get buildDeployStateFromShipEntity() { return scope.buildDeployStateFromShipEntity; },
  get findPlacementConflict() { return scope.findPlacementConflict; },
  get MIN_DISTANCE_FROM_DISALLOWED_OBJECTS_METERS() { return scope.MIN_DISTANCE_FROM_DISALLOWED_OBJECTS_METERS; },
  get ABYSSAL_PARTICIPANT_STATUS() { return scope.ABYSSAL_PARTICIPANT_STATUS; },
  get ABYSSAL_TERMINAL_PARTICIPANT_STATUSES() { return scope.ABYSSAL_TERMINAL_PARTICIPANT_STATUSES; },
  get ABYSSAL_TRACE_LIFECYCLE_PHASE() { return scope.ABYSSAL_TRACE_LIFECYCLE_PHASE; },
  get TRACE_ACTIVATION_RANGE_METERS() { return scope.TRACE_ACTIVATION_RANGE_METERS; },
  get TYPE_ABYSSAL_TRACE() { return scope.TYPE_ABYSSAL_TRACE; },
  get abyssalTraceStateRegistry() { return scope.abyssalTraceStateRegistry; },
  get activeAbyssalRunRegistry() { return scope.activeAbyssalRunRegistry; },
  get canRecoverCreatedAbyssalTraceAfterRestart() { return scope.canRecoverCreatedAbyssalTraceAfterRestart; },
  get cloneValue() { return scope.cloneValue; },
  get evaluateGateActivationRange() { return scope.evaluateGateActivationRange; },
  get expireCreatedAbyssalTrace() { return scope.expireCreatedAbyssalTrace; },
  get getAbyssalParticipantRecord() { return scope.getAbyssalParticipantRecord; },
  get getActivePocketStateByInstanceID() { return scope.getActivePocketStateByInstanceID; },
  get getActivePocketStateForCharacterID() { return scope.getActivePocketStateForCharacterID; },
  get getActiveTraceState() { return scope.getActiveTraceState; },
  get getObjectPosition() { return scope.getObjectPosition; },
  get getObjectRadius() { return scope.getObjectRadius; },
  get getPendingAbyssalTransitionState() { return scope.getPendingAbyssalTransitionState; },
  get isCreatedAbyssalTraceExpired() { return scope.isCreatedAbyssalTraceExpired; },
  get listUniquePositiveInts() { return scope.listUniquePositiveInts; },
  get normalizeAbyssalParticipantRoster() { return scope.normalizeAbyssalParticipantRoster; },
  get normalizeAbyssalTraceLifecyclePhase() { return scope.normalizeAbyssalTraceLifecyclePhase; },
  get normalizeDirection() { return scope.normalizeDirection; },
  get persistTraceState() { return scope.persistTraceState; },
  get resolveAbyssalParticipantAdmissionState() { return scope.resolveAbyssalParticipantAdmissionState; },
  get resolveCurrentAuthoritativeAbyssalFleetMembership() { return scope.resolveCurrentAuthoritativeAbyssalFleetMembership; },
  get resolveGateTraceID() { return scope.resolveGateTraceID; },
  get resolveTraceContentProfile() { return scope.resolveTraceContentProfile; },
  get upsertAbyssalParticipantRosterEntry() { return scope.upsertAbyssalParticipantRosterEntry; },
  get stageAbyssalFilamentCompensationClaim() { return scope.stageAbyssalFilamentCompensationClaim; },
  get log() { return scope.log; },
  get cancelPendingAbyssalTransition() { return scope.cancelPendingAbyssalTransition; },
  get persistPendingAbyssalEntryRecovery() { return scope.persistPendingAbyssalEntryRecovery; },
  get ABYSSAL_ENTRY_RECOVERY_REASON() { return scope.ABYSSAL_ENTRY_RECOVERY_REASON; },
  get reconcilePendingAbyssalEntryRecovery() { return scope.reconcilePendingAbyssalEntryRecovery; },
  get logPendingAbyssalTraceActivation() { return scope.logPendingAbyssalTraceActivation; },
  get clearPendingAbyssalTraceActivation() { return scope.clearPendingAbyssalTraceActivation; },
  get transitionSourceTraceState() { return scope.transitionSourceTraceState; },
  get scheduleCreatedAbyssalTraceExpiry() { return scope.scheduleCreatedAbyssalTraceExpiry; },
  get ensureSourceTraceRuntime() { return scope.ensureSourceTraceRuntime; },
  get removeOwnedSourceTrace() { return scope.removeOwnedSourceTrace; },
  get settleAbyssalFilamentCompensationClaim() { return scope.settleAbyssalFilamentCompensationClaim; },
  get markAbyssalFilamentCompensationTraceInvalidated() { return scope.markAbyssalFilamentCompensationTraceInvalidated; },
  get buildPocketSiteKey() { return scope.buildPocketSiteKey; },
  get buildPocketStateFromInstance() { return scope.buildPocketStateFromInstance; },
  get registerPocket() { return scope.registerPocket; },
  get logRecoveredT0DarkLayoutSelection() { return scope.logRecoveredT0DarkLayoutSelection; },
  get logRecoveredAbyssalBaseRoomLayoutSelection() { return scope.logRecoveredAbyssalBaseRoomLayoutSelection; },
  get logRecoveredAbyssalSceneMode() { return scope.logRecoveredAbyssalSceneMode; },
  get buildSourceTransitionState() { return scope.buildSourceTransitionState; },
  get resolveAbyssalTemplateID() { return scope.resolveAbyssalTemplateID; },
  get getContentProfile() { return scope.getContentProfile; },
  get selectAbyssalEnvironmentLayoutVariant() { return scope.selectAbyssalEnvironmentLayoutVariant; },
  get crypto() { return scope.crypto; },
  get buildNewT0DarkLayoutSelection() { return scope.buildNewT0DarkLayoutSelection; },
  get selectAbyssalBaseRoomLayouts() { return scope.selectAbyssalBaseRoomLayouts; },
  get resolveAbyssalSceneModeState() { return scope.resolveAbyssalSceneModeState; },
  get ABYSSAL_SCENE_MODE_ISOLATED() { return scope.ABYSSAL_SCENE_MODE_ISOLATED; },
  get allocateAbyssalSpatialReservation() { return scope.allocateAbyssalSpatialReservation; },
  get formatVectorForLog() { return scope.formatVectorForLog; },
  get buildPlaceholderPocketPosition() { return scope.buildPlaceholderPocketPosition; },
  get buildPlaceholderShipSpaceState() { return scope.buildPlaceholderShipSpaceState; },
  get buildPlaceholderRoomState() { return scope.buildPlaceholderRoomState; },
  get getNpcRuntimePolicy() { return scope.getNpcRuntimePolicy; },
  get ABYSSAL_PARTICIPANT_ROSTER_SCHEMA_VERSION() { return scope.ABYSSAL_PARTICIPANT_ROSTER_SCHEMA_VERSION; },
  get buildPersistedAbyssalContentProfile() { return scope.buildPersistedAbyssalContentProfile; },
  get buildAbyssalWeatherState() { return scope.buildAbyssalWeatherState; },
  get PLACEHOLDER_POCKET_MODE() { return scope.PLACEHOLDER_POCKET_MODE; },
  get PLACEHOLDER_POCKET_ISOLATION() { return scope.PLACEHOLDER_POCKET_ISOLATION; },
  get abyssalPendingWorkRegistry() { return scope.abyssalPendingWorkRegistry; },
  get logNewT0DarkLayoutSelection() { return scope.logNewT0DarkLayoutSelection; },
  get logAbyssalBaseRoomLayoutSelection() { return scope.logAbyssalBaseRoomLayoutSelection; },
  get abyssalHostSlotAllocator() { return scope.abyssalHostSlotAllocator; },
  get getActivePocketStateByMarkerItemID() { return scope.getActivePocketStateByMarkerItemID; },
  get getActivePocketStateForSession() { return scope.getActivePocketStateForSession; },
  get syncExpiredAbyssalPocketState() { return scope.syncExpiredAbyssalPocketState; },
  get readPocketMarkerStateFromItem() { return scope.readPocketMarkerStateFromItem; },
  get getPlaceholderRoomEntry() { return scope.getPlaceholderRoomEntry; },
  get isAbyssalParticipantInRun() { return scope.isAbyssalParticipantInRun; },
  get evaluateAbyssalDirectCallbackTerminalGuard() { return scope.evaluateAbyssalDirectCallbackTerminalGuard; },
  get resolveAbyssalTerminalCallbackReason() { return scope.resolveAbyssalTerminalCallbackReason; },
  get suppressAbyssalRoomRewards() { return scope.suppressAbyssalRoomRewards; },
  get retryPendingAbyssalRewardMaterializations() { return scope.retryPendingAbyssalRewardMaterializations; },
  get hasTerminalFailureOutcome() { return scope.hasTerminalFailureOutcome; },
  get ensureAbyssalPocketPersistenceReady() { return scope.ensureAbyssalPocketPersistenceReady; },
  get buildAbyssalRoomProgressionPolicyInput() { return scope.buildAbyssalRoomProgressionPolicyInput; },
  get TYPE_ABYSSAL_ORIGIN_CONDUIT() { return scope.TYPE_ABYSSAL_ORIGIN_CONDUIT; },
  get TYPE_ABYSSAL_TRANSFER_CONDUIT() { return scope.TYPE_ABYSSAL_TRANSFER_CONDUIT; },
  get getPocketScene() { return scope.getPocketScene; },
  get resolveExactAbyssalRunRoomScope() { return scope.resolveExactAbyssalRunRoomScope; },
  get ABYSSAL_ROOM_ENTITY_ROLES() { return scope.ABYSSAL_ROOM_ENTITY_ROLES; },
  get CONDUIT_ACTIVATION_RANGE_METERS() { return scope.CONDUIT_ACTIVATION_RANGE_METERS; },
  get buildAbyssalRoomObjectivePolicyInput() { return scope.buildAbyssalRoomObjectivePolicyInput; },
  get buildRoomLogContext() { return scope.buildRoomLogContext; },
};
}

function buildManagerGroup12Binding7Part1(scope) {
  return (0, scope.createAbyssalAdmissionComposition)(buildManagerGroup12Binding7Part2(scope));
}

function buildDefaultDependenciesOperation(scope) {
  return {
    isShipSelfDestructing: shipID => require("../../services/ship/selfDestructRuntime").isShipSelfDestructing(shipID),
    isEntityFilamentBlocked: entity => entity?.linkWithShipRestriction?.blocksFilament === true ||
      require("../../services/dynamic/essFieldRuntime").isEntityFilamentBlocked(entity),
    ITEM_FLAGS: scope.ITEM_FLAGS,
    now: () => Date.now(),
    findItemById: scope.findItemById,
    consumeInventoryItemQuantity: scope.consumeInventoryItemQuantity,
    createSpaceItemForOwner: scope.createSpaceItemForOwner,
    grantItemToOwnerLocation: scope.grantItemToOwnerLocation,
    grantItemToOwnerLocationIdempotent: scope.grantItemToOwnerLocationIdempotent,
    grantItemsToOwnerLocationIdempotent: scope.grantItemsToOwnerLocationIdempotent,
    getIdempotentGrantReceipt: scope.getIdempotentGrantReceipt,
    getAllItems: scope.getAllItems,
    readAbyssalFilamentCompensationClaim:
      scope.abyssalFilamentCompensationStore.readClaim,
    persistAbyssalFilamentCompensationClaim:
      scope.abyssalFilamentCompensationStore.persistClaim,
    listAbyssalFilamentCompensationClaimsForCharacter:
      scope.abyssalFilamentCompensationStore.listClaimsForCharacter,
    listContainerItems: scope.listContainerItems,
    listSystemSpaceItems: scope.listSystemSpaceItems,
    moveShipToSpace: scope.moveShipToSpace,
    removeInventoryItem: scope.removeInventoryItem,
    updateInventoryItem: scope.updateInventoryItem,
    updateShipItem: scope.updateShipItem,
    resolveItemByName: scope.resolveItemByName,
    resolveItemByTypeID: scope.resolveItemByTypeID,
    matchesTypeList: scope.matchesTypeList,
    worldData: scope.worldData,
    fleetRuntime: scope.fleetRuntime,
    dungeonRuntime: scope.dungeonRuntime,
    dungeonTrackingRuntime: scope.dungeonTrackingRuntime,
    dungeonUniverseSiteService: scope.dungeonUniverseSiteService,
    queuePostSpaceAttachFittingHydration: scope.queuePostSpaceAttachFittingHydration,
    nextRandom: () => Math.random(),
    nextEncounterRandom: () => Math.random(),
    nextBoundaryRandom: () => Math.random(),
    scheduleTimeout(callback, delayMs) {
      return setTimeout(callback, delayMs);
    },
    clearScheduledTimeout(handle) {
      clearTimeout(handle);
    },
    scheduleInterval(callback, intervalMs) {
      return setInterval(callback, intervalMs);
    },
    clearScheduledInterval(handle) {
      clearInterval(handle);
    },
    scheduleBoundaryInterval(callback, intervalMs) {
      return setInterval(callback, intervalMs);
    },
    clearScheduledBoundaryInterval(handle) {
      clearInterval(handle);
    },
  };
}

function configureAbyssalEnginePortOperation(scope, port) {
  const validated = (0, scope.assertValidAbyssalEnginePort)(port);
  return scope.abyssalEngineBindingState.configureEnginePort(validated);
}

function initializeManagerGroup12Binding1(scope) {
  const deathRecovery = (0, scope.createAbyssalDeathRecovery)({
  getDependencies: scope.getDependencies,
  getAbyssalTimeoutState: scope.getAbyssalTimeoutState,
  getAbyssalParticipantDestructionOperation: scope.getAbyssalParticipantDestructionOperation,
  isCapsuleTypeID: scope.isCapsuleTypeID,
  resolveAbyssalSceneModeState: scope.resolveAbyssalSceneModeState,
  ABYSSAL_SCENE_MODE_ISOLATED: scope.ABYSSAL_SCENE_MODE_ISOLATED,
  isPointWithinPocketRecoveryRadius: scope.isPointWithinPocketRecoveryRadius,
  getAbyssalParticipantDestructionOperationsByCharacterID: scope.getAbyssalParticipantDestructionOperationsByCharacterID,
  completeDurableAbyssalTimeoutParticipants: (...args) => (0, scope.completeDurableAbyssalTimeoutParticipants)(...args),
  getActivePocketStateByInstanceID: scope.getActivePocketStateByInstanceID,
  log: scope.log,
  updatePocketState: scope.updatePocketState,
  completeAbyssalParticipantPodDestructionAndCleanup: scope.completeAbyssalParticipantPodDestructionAndCleanup,
  listUniquePositiveInts: scope.listUniquePositiveInts,
});
  scope.deathRecovery = deathRecovery;
}

function initializeManagerGroup12Binding2(scope) {
  const { inspectCommittedAbyssalParticipantDeathHandoff } = scope.deathRecovery;
  scope.inspectCommittedAbyssalParticipantDeathHandoff = inspectCommittedAbyssalParticipantDeathHandoff;
}

function initializeManagerGroup12Binding3(scope) {
  const {
  completeDurableAbyssalParticipantDestruction,
  reconcilePendingAbyssalMemberDestructions,
} = (0, scope.createAbyssalParticipantExecution)({
  getDependencies: scope.getDependencies,
  cloneValue: scope.cloneValue,
  getActivePocketStateByInstanceID: scope.getActivePocketStateByInstanceID,
  getAbyssalParticipantRecord: scope.getAbyssalParticipantRecord,
  getAbyssalParticipantDestructionOperation: scope.getAbyssalParticipantDestructionOperation,
  resolveAbyssalTimeoutRuntimeSession: scope.resolveAbyssalTimeoutRuntimeSession,
  buildAbyssalParticipantTerminalProjection: scope.buildAbyssalParticipantTerminalProjection,
  resolveAbyssalParticipantActiveShip: scope.resolveAbyssalParticipantActiveShip,
  buildAbyssalParticipantHullDestructionIntent: scope.buildAbyssalParticipantHullDestructionIntent,
  commitAbyssalParticipantDestructionOperationState: scope.commitAbyssalParticipantDestructionOperationState,
  ensureDurableAbyssalParticipantDestructionIntent: scope.ensureDurableAbyssalParticipantDestructionIntent,
  log: scope.log,
  getPendingAbyssalParticipantDestructionReceipt: scope.getPendingAbyssalParticipantDestructionReceipt,
  inspectCommittedAbyssalParticipantDeathHandoff: scope.inspectCommittedAbyssalParticipantDeathHandoff,
  rememberPendingAbyssalParticipantDestructionReceipt: scope.rememberPendingAbyssalParticipantDestructionReceipt,
  clearPendingAbyssalParticipantDestructionReceipt: scope.clearPendingAbyssalParticipantDestructionReceipt,
  getAbyssalParticipantDestructionOperationsByCharacterID: scope.getAbyssalParticipantDestructionOperationsByCharacterID,
  upsertAbyssalParticipantRosterEntry: scope.upsertAbyssalParticipantRosterEntry,
  ABYSSAL_PARTICIPANT_STATUS: scope.ABYSSAL_PARTICIPANT_STATUS,
  commitPocketStateDurably: scope.commitPocketStateDurably,
});
  scope.completeDurableAbyssalParticipantDestruction = completeDurableAbyssalParticipantDestruction;
  scope.reconcilePendingAbyssalMemberDestructions = reconcilePendingAbyssalMemberDestructions;
}

function initializeManagerGroup12Binding4(scope) {
  const timeoutLifecycle = (0, scope.createAbyssalTimeoutLifecycle)({
  getDependencies: scope.getDependencies,
  getActivePocketStateByInstanceID: scope.getActivePocketStateByInstanceID,
  getAbyssalTimeoutState: scope.getAbyssalTimeoutState,
  getAbyssalTimeoutPolicy: scope.getAbyssalTimeoutPolicy,
  hasFailedTimeoutOutcome: scope.hasFailedTimeoutOutcome,
  buildPlaceholderRoomState: scope.buildPlaceholderRoomState,
  buildPocketStateForCurrentRoom: scope.buildPocketStateForCurrentRoom,
  updatePocketState: scope.updatePocketState,
  cloneValue: scope.cloneValue,
  cancelPendingAbyssalTransition: scope.cancelPendingAbyssalTransition,
  stopSuppressorPresentationsForPocketRun: scope.stopSuppressorPresentationsForPocketRun,
  cleanupSuppressorControllersForRun: scope.cleanupSuppressorControllersForRun,
  clearSuppressorDebugForRun: scope.clearSuppressorDebugForRun,
  pauseAbyssalObjectiveControllers: (...args) => (0, scope.pauseAbyssalObjectiveControllers)(...args),
  listAllPocketHostileEntityIDs: scope.listAllPocketHostileEntityIDs,
  suppressAbyssalRoomRewards: scope.suppressAbyssalRoomRewards,
  ensureAbyssalPocketPersistenceReady: scope.ensureAbyssalPocketPersistenceReady,
  schedulePlaceholderPocketMaintenance: scope.schedulePlaceholderPocketMaintenance,
  buildRoomLogContext: scope.buildRoomLogContext,
  recordAuditEvent: scope.recordAuditEvent,
  recordAbyssalRunOutcome: scope.recordAbyssalRunOutcome,
  normalizeAbyssalParticipantRoster: scope.normalizeAbyssalParticipantRoster,
  ABYSSAL_PARTICIPANT_STATUS: scope.ABYSSAL_PARTICIPANT_STATUS,
  getCharacterID: scope.getCharacterID,
  completeDurableAbyssalParticipantDestruction: scope.completeDurableAbyssalParticipantDestruction,
  ABYSSAL_PARTICIPANT_TERMINAL_CAUSE: scope.ABYSSAL_PARTICIPANT_TERMINAL_CAUSE,
  getAbyssalParticipantDestructionOperationsByCharacterID: scope.getAbyssalParticipantDestructionOperationsByCharacterID,
  ABYSSAL_PARTICIPANT_DESTRUCTION_OPERATION_STATUS: scope.ABYSSAL_PARTICIPANT_DESTRUCTION_OPERATION_STATUS,
  ABYSSAL_PARTICIPANT_DESTRUCTION_STATUS_RANK: scope.ABYSSAL_PARTICIPANT_DESTRUCTION_STATUS_RANK,
  withRateLimitedAbyssalDestructionWarning: scope.withRateLimitedAbyssalDestructionWarning,
  commitPocketStateDurably: scope.commitPocketStateDurably,
  resolveAbyssalRosterParticipantSession: scope.resolveAbyssalRosterParticipantSession,
  sendAbyssalTerminalClientTeardown: scope.sendAbyssalTerminalClientTeardown,
  buildAbyssalParticipantTerminalProjection: scope.buildAbyssalParticipantTerminalProjection,
  getAbyssalParticipantDestructionOperation: scope.getAbyssalParticipantDestructionOperation,
  cleanupAbyssalRun: scope.cleanupAbyssalRun,
  resolveAbyssalTimeoutDecision: scope.resolveAbyssalTimeoutDecision,
  isAbyssalTimerAnchored: scope.isAbyssalTimerAnchored,
  hasImmutableAbyssalRunOutcome: scope.hasImmutableAbyssalRunOutcome,
  hasFailedParticipantShipDestroyedOutcome: scope.hasFailedParticipantShipDestroyedOutcome,
  completeAbyssalParticipantPodDestructionAndCleanup: scope.completeAbyssalParticipantPodDestructionAndCleanup,
  resolveAbyssalTimeoutRuntimeSession: scope.resolveAbyssalTimeoutRuntimeSession,
  ABYSSAL_DEADLINE_ACTION: scope.ABYSSAL_DEADLINE_ACTION,
  ABYSSAL_TIMEOUT_MODE: scope.ABYSSAL_TIMEOUT_MODE,
  log: scope.log,
});
  scope.timeoutLifecycle = timeoutLifecycle;
}

function initializeManagerGroup12Binding5(scope) {
  const {
  resolveEffectiveAbyssalMaintenanceNowMs,
  quiesceAbyssalRunForTimeout,
  buildAbyssalLethalTimeoutPhase,
  completeDurableAbyssalTimeoutParticipants,
  handleAbyssalTimeout,
} = scope.timeoutLifecycle;
  scope.resolveEffectiveAbyssalMaintenanceNowMs = resolveEffectiveAbyssalMaintenanceNowMs;
  scope.quiesceAbyssalRunForTimeout = quiesceAbyssalRunForTimeout;
  scope.buildAbyssalLethalTimeoutPhase = buildAbyssalLethalTimeoutPhase;
  scope.completeDurableAbyssalTimeoutParticipants = completeDurableAbyssalTimeoutParticipants;
  scope.handleAbyssalTimeout = handleAbyssalTimeout;
}

function initializeManagerGroup12Binding6(scope) {
  const { handleAbyssalSessionShipDestroyed } = (0, scope.createAbyssalDestructionCallback)({
  getDependencies: scope.getDependencies,
  getActivePocketStateForSession: scope.getActivePocketStateForSession,
  getActivePocketStateForCharacterID: scope.getActivePocketStateForCharacterID,
  getCharacterID: scope.getCharacterID,
  evaluateAbyssalDirectCallbackTerminalGuard: scope.evaluateAbyssalDirectCallbackTerminalGuard,
  buildAbyssalDirectCallbackSuppressedResult: scope.buildAbyssalDirectCallbackSuppressedResult,
  getAbyssalParticipantRecord: scope.getAbyssalParticipantRecord,
  normalizeAbyssalParticipantRoster: scope.normalizeAbyssalParticipantRoster,
  ABYSSAL_PARTICIPANT_STATUS: scope.ABYSSAL_PARTICIPANT_STATUS,
  completeDurableAbyssalParticipantDestruction: scope.completeDurableAbyssalParticipantDestruction,
  clearAbyssalSessionState: scope.clearAbyssalSessionState,
  log: scope.log,
  getPendingAbyssalTransitionState: scope.getPendingAbyssalTransitionState,
  cancelPendingAbyssalTransition: scope.cancelPendingAbyssalTransition,
  purgePlaceholderPocket: scope.purgePlaceholderPocket,
  getAbyssalTimeoutState: scope.getAbyssalTimeoutState,
  ABYSSAL_TIMEOUT_MODE: scope.ABYSSAL_TIMEOUT_MODE,
  updatePocketState: scope.updatePocketState,
  ABYSSAL_TIMEOUT_POD_STATUS: scope.ABYSSAL_TIMEOUT_POD_STATUS,
  recordAbyssalRunOutcome: scope.recordAbyssalRunOutcome,
  buildPlaceholderRoomState: scope.buildPlaceholderRoomState,
  getAbyssalParticipantDestructionOperation: scope.getAbyssalParticipantDestructionOperation,
  commitPocketStateDurably: scope.commitPocketStateDurably,
  cloneValue: scope.cloneValue,
  completeAbyssalParticipantPodDestructionAndCleanup: scope.completeAbyssalParticipantPodDestructionAndCleanup,
  isCapsuleTypeID: scope.isCapsuleTypeID,
  buildAbyssalParticipantRoomScopeMetadata: scope.buildAbyssalParticipantRoomScopeMetadata,
  applyAbyssalParticipantRoomScopeMetadata: scope.applyAbyssalParticipantRoomScopeMetadata,
  upsertAbyssalParticipantRosterEntry: (...args) => scope.upsertAbyssalParticipantRosterEntry(...args),
});
  scope.handleAbyssalSessionShipDestroyed = handleAbyssalSessionShipDestroyed;
}

function initializeManagerGroup12Binding7(scope) {
  const {
  evaluateAbyssalShipActivationState,
  validateAbyssalEntranceDeployment,
  validateAbyssalTraceActivation,
  rollbackPendingAbyssalTraceActivation,
  createOrResolvePlaceholderPocket,
  validateAbyssalExitTraceActivation,
} = buildManagerGroup12Binding7Part1(scope);
  scope.evaluateAbyssalShipActivationState = evaluateAbyssalShipActivationState;
  scope.validateAbyssalEntranceDeployment = validateAbyssalEntranceDeployment;
  scope.validateAbyssalTraceActivation = validateAbyssalTraceActivation;
  scope.rollbackPendingAbyssalTraceActivation = rollbackPendingAbyssalTraceActivation;
  scope.createOrResolvePlaceholderPocket = createOrResolvePlaceholderPocket;
  scope.validateAbyssalExitTraceActivation = validateAbyssalExitTraceActivation;
}

function initializeManagerGroup12Binding8(scope) {
  const {
  getRoomObjectiveIDSets,
  buildAbyssalNpcDestroyedResult,
  inspectAbyssalNpcDestructionAuthority,
  queuePendingAbyssalNpcDestroyed,
  reconcilePendingAbyssalObjectiveDeaths,
  handleAbyssalNpcDestroyed,
  handleAbyssalNpcsDestroyed,
  buildAbyssalDestinationMechanicsReadiness,
  buildAbyssalDestinationPreDeliveryReadiness,
  buildAbyssalActiveRoomReadiness,
} = (0, scope.createAbyssalNpcOutcomeComposition)({
  get getDependencies() { return scope.getDependencies; },
  get listUniquePositiveInts() { return scope.listUniquePositiveInts; },
  get getActivePocketStateByInstanceID() { return scope.getActivePocketStateByInstanceID; },
  get evaluateAbyssalDirectCallbackTerminalGuard() { return scope.evaluateAbyssalDirectCallbackTerminalGuard; },
  get abyssalPendingWorkRegistry() { return scope.abyssalPendingWorkRegistry; },
  get buildPlaceholderRoomState() { return scope.buildPlaceholderRoomState; },
  get buildAbyssalSceneDescriptor() { return scope.buildAbyssalSceneDescriptor; },
  get cloneValue() { return scope.cloneValue; },
  get log() { return scope.log; },
  get getPlaceholderRoomEntry() { return scope.getPlaceholderRoomEntry; },
  get reconcileControllerDependantLifecycleOnNpcDestroyed() { return scope.reconcileControllerDependantLifecycleOnNpcDestroyed; },
  get runPlaceholderPocketMaintenance() { return scope.runPlaceholderPocketMaintenance; },
  get setPlaceholderRoomEntry() { return scope.setPlaceholderRoomEntry; },
  get updatePocketState() { return scope.updatePocketState; },
  get buildPocketStateForCurrentRoom() { return scope.buildPocketStateForCurrentRoom; },
  get refreshAbyssalDungeonTrackingState() { return scope.refreshAbyssalDungeonTrackingState; },
  get recordAuditEvent() { return scope.recordAuditEvent; },
  get beginAbyssalPocketMutationBatch() { return scope.beginAbyssalPocketMutationBatch; },
  get abortAbyssalPocketMutationBatch() { return scope.abortAbyssalPocketMutationBatch; },
  get commitAbyssalPocketMutationBatch() { return scope.commitAbyssalPocketMutationBatch; },
  get getPocketScene() { return scope.getPocketScene; },
  get resolveAbyssalLiveCombatParticipant() { return scope.resolveAbyssalLiveCombatParticipant; },
  get resolveExactAbyssalRunRoomScope() { return scope.resolveExactAbyssalRunRoomScope; },
  get listActiveAbyssalRoomNpcIDs() { return scope.listActiveAbyssalRoomNpcIDs; },
  get buildAbyssalEnvironmentalMaterializationReadiness() { return scope.buildAbyssalEnvironmentalMaterializationReadiness; },
  get buildAbyssalEnvironmentalEffectReadiness() { return scope.buildAbyssalEnvironmentalEffectReadiness; },
  get listSuppressorControllersForRun() { return scope.listSuppressorControllersForRun; },
  get buildAbyssalDestinationRequirements() { return scope.buildAbyssalDestinationRequirements; },
  get hasTerminalFailureOutcome() { return scope.hasTerminalFailureOutcome; },
  get isAbyssalWeatherApplicationReady() { return scope.isAbyssalWeatherApplicationReady; },
  get sceneBubbleHasEntity() { return scope.sceneBubbleHasEntity; },
  get getObjectPosition() { return scope.getObjectPosition; },
  get isAbyssalSceneryVisualsRequested() { return scope.isAbyssalSceneryVisualsRequested; },
  get SCENERY_POLICY_AUTHORITATIVE() { return scope.SCENERY_POLICY_AUTHORITATIVE; },
  get buildAbyssalNpcControllerReadiness() { return scope.buildAbyssalNpcControllerReadiness; },
  get normalizeLowerText() { return scope.normalizeLowerText; },
});
  scope.getRoomObjectiveIDSets = getRoomObjectiveIDSets;
  scope.buildAbyssalNpcDestroyedResult = buildAbyssalNpcDestroyedResult;
  scope.inspectAbyssalNpcDestructionAuthority = inspectAbyssalNpcDestructionAuthority;
  scope.queuePendingAbyssalNpcDestroyed = queuePendingAbyssalNpcDestroyed;
  scope.reconcilePendingAbyssalObjectiveDeaths = reconcilePendingAbyssalObjectiveDeaths;
  scope.handleAbyssalNpcDestroyed = handleAbyssalNpcDestroyed;
  scope.handleAbyssalNpcsDestroyed = handleAbyssalNpcsDestroyed;
  scope.buildAbyssalDestinationMechanicsReadiness = buildAbyssalDestinationMechanicsReadiness;
  scope.buildAbyssalDestinationPreDeliveryReadiness = buildAbyssalDestinationPreDeliveryReadiness;
  scope.buildAbyssalActiveRoomReadiness = buildAbyssalActiveRoomReadiness;
}

function bindAbyssalManagerRuntimeGroup12Operations(scope) {
  scope.buildDefaultDependencies = function buildDefaultDependencies() {
    return buildDefaultDependenciesOperation(scope);
  };
  scope.configureAbyssalEnginePort = function configureAbyssalEnginePort(port) {
    return configureAbyssalEnginePortOperation(scope, port);
  };
  scope.getConfiguredAbyssalEnginePort = function getConfiguredAbyssalEnginePort() {
    return scope.abyssalEngineBindingState.getConfiguredEnginePort();
  };
}

function initializeAbyssalManagerRuntimeGroup12Part1(scope) {
  initializeManagerGroup12Binding1(scope);
  initializeManagerGroup12Binding2(scope);
  initializeManagerGroup12Binding3(scope);
  initializeManagerGroup12Binding4(scope);
  initializeManagerGroup12Binding5(scope);
  initializeManagerGroup12Binding6(scope);
  initializeManagerGroup12Binding7(scope);
  initializeManagerGroup12Binding8(scope);
}

function initializeAbyssalManagerRuntimeGroup12(scope) {
  initializeAbyssalManagerRuntimeGroup12Part1(scope);
}

module.exports = {
  bindAbyssalManagerRuntimeGroup12Operations,
  initializeAbyssalManagerRuntimeGroup12,
};
