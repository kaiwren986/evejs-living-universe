"use strict";

function initializeManagerGroup4Binding1(scope) {
  const { handleAbyssalEntranceDeployment } = (0, scope.createAbyssalDeploymentRequest)({
  getDependencies: (...args) => (0, scope.getDependencies)(...args),
  validateAbyssalEntranceDeployment: (...args) => (0, scope.validateAbyssalEntranceDeployment)(...args),
  recordAuditEvent: (...args) => (0, scope.recordAuditEvent)(...args),
  log: scope.log,
  getCharacterID: (...args) => (0, scope.getCharacterID)(...args),
  throwCustomNotify: (...args) => (0, scope.throwCustomNotify)(...args),
  get ABYSS_ERROR_KIND() { return scope.ABYSS_ERROR_KIND; },
  get ABYSS_UNSUPPORTED_FILAMENT_NOTIFY() { return scope.ABYSS_UNSUPPORTED_FILAMENT_NOTIFY; },
  buildAbyssalSecurityRestrictionNotify: (...args) => (0, scope.buildAbyssalSecurityRestrictionNotify)(...args),
  throwAbyssError: (...args) => (0, scope.throwAbyssError)(...args),
  buildAbyssErrorFromValidationError: (...args) => (0, scope.buildAbyssErrorFromValidationError)(...args),
  deployPlaceholderTrace: (...args) => (0, scope.deployPlaceholderTrace)(...args),
  get ABYSS_ERROR() { return scope.ABYSS_ERROR; },
  buildAbyssalSuspectFlagResult: (...args) => (0, scope.buildAbyssalSuspectFlagResult)(...args),
  recordAndLogAbyssalSuspectFlagOutcome: (...args) => (0, scope.recordAndLogAbyssalSuspectFlagOutcome)(...args),
  scheduleCreatedAbyssalTraceExpiry: (...args) => (0, scope.scheduleCreatedAbyssalTraceExpiry)(...args),
  compensateFailedAbyssalDeployment: (...args) => (0, scope.compensateFailedAbyssalDeployment)(...args),
  hasPendingDeployment: (...args) => scope.abyssalTraceStateRegistry.hasPendingDeployment(...args),
  beginPendingDeployment: (...args) => scope.abyssalTraceStateRegistry.beginPendingDeployment(...args),
  endPendingDeployment: (...args) => scope.abyssalTraceStateRegistry.endPendingDeployment(...args),
});
  scope.handleAbyssalEntranceDeployment = handleAbyssalEntranceDeployment;
}

function initializeManagerGroup4Binding2(scope) {
  const {
  resolveAuthoritativeAbyssalFleetMembership,
  resolveCurrentAuthoritativeAbyssalFleetMembership,
  normalizeAbyssalParticipantStatus,
  normalizeAbyssalParticipantRecord,
  mergeAbyssalParticipantRecords,
  normalizeAbyssalParticipantRoster,
  getAbyssalParticipantRecord,
  isAbyssalParticipantInRun,
  isAbyssalParticipantIndexed,
  upsertAbyssalParticipantRosterEntry,
  listAuthoritativeAbyssalFleetCharacterIDs,
  listAbyssalParticipantCharacterIDs,
  buildAbyssalSurvivorControllerSelectionRequest,
  resolveAbyssalLiveCombatParticipant,
  areAllEnteredAbyssalParticipantsTerminal,
} = (0, scope.createAbyssalParticipantRoster)({
  getDependencies: (...args) => (0, scope.getDependencies)(...args),
  get ABYSSAL_PARTICIPANT_STATUS() { return scope.ABYSSAL_PARTICIPANT_STATUS; },
  normalizeLowerText: (...args) => (0, scope.normalizeLowerText)(...args),
  get ABYSSAL_PARTICIPANT_ROSTER_SCHEMA_VERSION() { return scope.ABYSSAL_PARTICIPANT_ROSTER_SCHEMA_VERSION; },
  cloneValue: (...args) => (0, scope.cloneValue)(...args),
  getObjectPosition: (...args) => (0, scope.getObjectPosition)(...args),
  normalizeDirection: (...args) => (0, scope.normalizeDirection)(...args),
  toReal: (...args) => (0, scope.toReal)(...args),
  buildPlaceholderRoomState: (...args) => (0, scope.buildPlaceholderRoomState)(...args),
  clampRoomIndex: (...args) => (0, scope.clampRoomIndex)(...args),
  resolveExactAbyssalRunRoomScope: (...args) => (0, scope.resolveExactAbyssalRunRoomScope)(...args),
  listUniquePositiveInts: (...args) => (0, scope.listUniquePositiveInts)(...args),
  selectAbyssalSurvivorController: (...args) => (0, scope.selectAbyssalSurvivorController)(...args),
  isTerminalParticipantStatus: (...args) => scope.ABYSSAL_TERMINAL_PARTICIPANT_STATUSES.has(...args),
});
  scope.resolveAuthoritativeAbyssalFleetMembership = resolveAuthoritativeAbyssalFleetMembership;
  scope.resolveCurrentAuthoritativeAbyssalFleetMembership = resolveCurrentAuthoritativeAbyssalFleetMembership;
  scope.normalizeAbyssalParticipantStatus = normalizeAbyssalParticipantStatus;
  scope.normalizeAbyssalParticipantRecord = normalizeAbyssalParticipantRecord;
  scope.mergeAbyssalParticipantRecords = mergeAbyssalParticipantRecords;
  scope.normalizeAbyssalParticipantRoster = normalizeAbyssalParticipantRoster;
  scope.getAbyssalParticipantRecord = getAbyssalParticipantRecord;
  scope.isAbyssalParticipantInRun = isAbyssalParticipantInRun;
  scope.isAbyssalParticipantIndexed = isAbyssalParticipantIndexed;
  scope.upsertAbyssalParticipantRosterEntry = upsertAbyssalParticipantRosterEntry;
  scope.listAuthoritativeAbyssalFleetCharacterIDs = listAuthoritativeAbyssalFleetCharacterIDs;
  scope.listAbyssalParticipantCharacterIDs = listAbyssalParticipantCharacterIDs;
  scope.buildAbyssalSurvivorControllerSelectionRequest = buildAbyssalSurvivorControllerSelectionRequest;
  scope.resolveAbyssalLiveCombatParticipant = resolveAbyssalLiveCombatParticipant;
  scope.areAllEnteredAbyssalParticipantsTerminal = areAllEnteredAbyssalParticipantsTerminal;
}

function initializeManagerGroup4Binding3(scope) {
  const {
  normalizeAbyssalMaintenanceDiagnosticText,
  recordAbyssalMaintenanceFailure,
  clearPlaceholderPocketMaintenance,
  purgePlaceholderPocket,
} = (0, scope.createAbyssalMaintenanceControl)({
  getDependencies: (...args) => (0, scope.getDependencies)(...args),
  recordAuditEvent: (...args) => (0, scope.recordAuditEvent)(...args),
  log: scope.log,
  cleanupBoundaryControllersForRun: (...args) => (0, scope.cleanupBoundaryControllersForRun)(...args),
  cleanupSuppressorControllersForRun: (...args) => (0, scope.cleanupSuppressorControllersForRun)(...args),
  cleanupSuppressorPresentationStatesForRun: (...args) => (0, scope.cleanupSuppressorPresentationStatesForRun)(...args),
  clearSuppressorDebugForRun: (...args) => (0, scope.clearSuppressorDebugForRun)(...args),
  unregisterPocket: (...args) => (0, scope.unregisterPocket)(...args),
  formatVectorForLog: (...args) => (0, scope.formatVectorForLog)(...args),
  getRunByInstanceID: (...args) => scope.activeAbyssalRunRegistry.getByInstanceID(...args),
  cancelMaintenanceTimerHandle: (...args) => scope.abyssalMaintenanceState.cancelTimerHandle(...args),
  getSpatialReservation: (...args) => scope.abyssalHostSlotAllocator.getReservation(...args),
  releaseSpatialReservation: (...args) => scope.abyssalHostSlotAllocator.release(...args),
});
  scope.normalizeAbyssalMaintenanceDiagnosticText = normalizeAbyssalMaintenanceDiagnosticText;
  scope.recordAbyssalMaintenanceFailure = recordAbyssalMaintenanceFailure;
  scope.clearPlaceholderPocketMaintenance = clearPlaceholderPocketMaintenance;
  scope.purgePlaceholderPocket = purgePlaceholderPocket;
}

function initializeManagerGroup4Binding4(scope) {
  const {
  getNpcRuntimePolicy,
  applyAbyssalNpcRuntimeMetadata,
  buildEncounterStateFromRoomEntry,
  listPocketHostileEntityIDs,
  listPocketObjectiveRelevantEntityIDs,
  listAllPocketHostileEntityIDs,
  updateAbyssalRoomNpcActivationState,
  degradeAbyssalRoomNpcActivation,
} = (0, scope.createAbyssalNpcLifecycleMetadata)({
  getContentProfile: (...args) => (0, scope.getContentProfile)(...args),
  cloneValue: (...args) => (0, scope.cloneValue)(...args),
  getResolvedWeatherState: (...args) => (0, scope.getResolvedWeatherState)(...args),
  applyAbyssalRoomEntityMetadata: (...args) => (0, scope.applyAbyssalRoomEntityMetadata)(...args),
  get ABYSSAL_ROOM_ENTITY_ROLES() { return scope.ABYSSAL_ROOM_ENTITY_ROLES; },
  getPlaceholderRoomEntry: (...args) => (0, scope.getPlaceholderRoomEntry)(...args),
  applyAbyssalWeatherToNpcEntity: (...args) => (0, scope.applyAbyssalWeatherToNpcEntity)(...args),
  resolvePerimeterRadius: (...args) => (0, scope.resolvePerimeterRadius)(...args),
  listUniquePositiveInts: (...args) => (0, scope.listUniquePositiveInts)(...args),
  buildPlaceholderRoomState: (...args) => (0, scope.buildPlaceholderRoomState)(...args),
  getActivePocketStateByInstanceID: (...args) => (0, scope.getActivePocketStateByInstanceID)(...args),
  setPlaceholderRoomEntry: (...args) => (0, scope.setPlaceholderRoomEntry)(...args),
  buildPocketStateForCurrentRoom: (...args) => (0, scope.buildPocketStateForCurrentRoom)(...args),
  updatePocketState: (...args) => (0, scope.updatePocketState)(...args),
  pauseAbyssalObjectiveControllers: (...args) => (0, scope.pauseAbyssalObjectiveControllers)(...args),
  suppressAbyssalRoomRewards: (...args) => (0, scope.suppressAbyssalRoomRewards)(...args),
  log: scope.log,
});
  scope.getNpcRuntimePolicy = getNpcRuntimePolicy;
  scope.applyAbyssalNpcRuntimeMetadata = applyAbyssalNpcRuntimeMetadata;
  scope.buildEncounterStateFromRoomEntry = buildEncounterStateFromRoomEntry;
  scope.listPocketHostileEntityIDs = listPocketHostileEntityIDs;
  scope.listPocketObjectiveRelevantEntityIDs = listPocketObjectiveRelevantEntityIDs;
  scope.listAllPocketHostileEntityIDs = listAllPocketHostileEntityIDs;
  scope.updateAbyssalRoomNpcActivationState = updateAbyssalRoomNpcActivationState;
  scope.degradeAbyssalRoomNpcActivation = degradeAbyssalRoomNpcActivation;
}

function initializeManagerGroup4Binding5(scope) {
  const {
  updateCharacterLocationForAbyssalEvacuation,
  buildAbyssalParticipantRoomScopeMetadata,
  applyAbyssalParticipantRoomScopeMetadata,
  clearExactAbyssalParticipantRoomScopeMetadata,
  resolveAbyssalParticipantRoomScopePersistence,
  stampAbyssalParticipantRoomScope,
  setAbyssalSessionState,
  captureAbyssalSpaceSessionFields,
  restoreAbyssalSpaceSessionFields,
  addAbyssalSessionChange,
  buildAbyssalExitSessionChanges,
  clearAbyssalSessionState,
} = (0, scope.createAbyssalParticipantSession)({
  getDependencies: (...args) => (0, scope.getDependencies)(...args),
  buildPlaceholderRoomState: (...args) => (0, scope.buildPlaceholderRoomState)(...args),
  clampRoomIndex: (...args) => (0, scope.clampRoomIndex)(...args),
  resolveExactAbyssalRunRoomScope: (...args) => (0, scope.resolveExactAbyssalRunRoomScope)(...args),
  syncInventoryChanges: (...args) => (0, scope.syncInventoryChanges)(...args),
  usesIsolatedAbyssalScene: (...args) => (0, scope.usesIsolatedAbyssalScene)(...args),
  buildAbyssalSceneDescriptor: (...args) => (0, scope.buildAbyssalSceneDescriptor)(...args),
  buildAbyssalEntrySessionChanges: (...args) => (0, scope.buildAbyssalEntrySessionChanges)(...args),
});
  scope.updateCharacterLocationForAbyssalEvacuation = updateCharacterLocationForAbyssalEvacuation;
  scope.buildAbyssalParticipantRoomScopeMetadata = buildAbyssalParticipantRoomScopeMetadata;
  scope.applyAbyssalParticipantRoomScopeMetadata = applyAbyssalParticipantRoomScopeMetadata;
  scope.clearExactAbyssalParticipantRoomScopeMetadata = clearExactAbyssalParticipantRoomScopeMetadata;
  scope.resolveAbyssalParticipantRoomScopePersistence = resolveAbyssalParticipantRoomScopePersistence;
  scope.stampAbyssalParticipantRoomScope = stampAbyssalParticipantRoomScope;
  scope.setAbyssalSessionState = setAbyssalSessionState;
  scope.captureAbyssalSpaceSessionFields = captureAbyssalSpaceSessionFields;
  scope.restoreAbyssalSpaceSessionFields = restoreAbyssalSpaceSessionFields;
  scope.addAbyssalSessionChange = addAbyssalSessionChange;
  scope.buildAbyssalExitSessionChanges = buildAbyssalExitSessionChanges;
  scope.clearAbyssalSessionState = clearAbyssalSessionState;
}

function initializeManagerGroup4Binding6(scope) {
  const {
  getActiveTraceStateForCharacterID,
  getActivePocketStateForCharacterID,
  hasUnresolvedAbyssalRecoveryObligation,
  getRecoverablePocketStateForCharacterID,
  getActivePocketStateForShipID,
  getActiveAbyssalRunForCharacterID,
  getActiveAbyssalRunForShipID,
  getActiveAbyssalRunForCharacter,
  getActiveAbyssalRunForShip,
  isCharacterInActiveAbyssalRun,
  isShipInActiveAbyssalRun,
  getActivePocketStateByInstanceID,
  getActivePocketStateForSession,
  getActivePocketStateByMarkerItemID,
} = (0, scope.createAbyssalRunQueries)({
  getDependencies: (...args) => (0, scope.getDependencies)(...args),
  getActiveTraceState: (...args) => (0, scope.getActiveTraceState)(...args),
  getAbyssalParticipantRecord: (...args) => (0, scope.getAbyssalParticipantRecord)(...args),
  hasPendingAbyssalTerminalCleanup: (...args) => (0, scope.hasPendingAbyssalTerminalCleanup)(...args),
  normalizeLowerText: (...args) => (0, scope.normalizeLowerText)(...args),
  getAbyssalWeatherRemovalState: (...args) => (0, scope.getAbyssalWeatherRemovalState)(...args),
  getAbyssalParticipantDestructionOperation: (...args) => (0, scope.getAbyssalParticipantDestructionOperation)(...args),
  get ABYSSAL_PARTICIPANT_DESTRUCTION_OPERATION_STATUS() { return scope.ABYSSAL_PARTICIPANT_DESTRUCTION_OPERATION_STATUS; },
  hasTerminalFailureOutcome: (...args) => (0, scope.hasTerminalFailureOutcome)(...args),
  normalizeAbyssalParticipantRoster: (...args) => (0, scope.normalizeAbyssalParticipantRoster)(...args),
  isAbyssalParticipantIndexed: (...args) => (0, scope.isAbyssalParticipantIndexed)(...args),
  cloneValue: (...args) => (0, scope.cloneValue)(...args),
  getCharacterID: (...args) => (0, scope.getCharacterID)(...args),
  readPocketMarkerStateFromItem: (...args) => (0, scope.readPocketMarkerStateFromItem)(...args),
  buildPocketSiteKey: (...args) => (0, scope.buildPocketSiteKey)(...args),
  buildPocketStateFromInstance: (...args) => (0, scope.buildPocketStateFromInstance)(...args),
  registerPocket: (...args) => (0, scope.registerPocket)(...args),
  logRecoveredT0DarkLayoutSelection: (...args) => (0, scope.logRecoveredT0DarkLayoutSelection)(...args),
  logRecoveredAbyssalSceneMode: (...args) => (0, scope.logRecoveredAbyssalSceneMode)(...args),
  getTraceIDForCharacter: (...args) => scope.abyssalTraceStateRegistry.getTraceIDForCharacter(...args),
  getRunByParticipantCharacterID: (...args) => scope.activeAbyssalRunRegistry.getByParticipantCharacterID(...args),
  listActiveRuns: (...args) => scope.activeAbyssalRunRegistry.listActiveRuns(...args),
  getRunByInstanceID: (...args) => scope.activeAbyssalRunRegistry.getByInstanceID(...args),
  getRunByMarkerID: (...args) => scope.activeAbyssalRunRegistry.getByMarkerID(...args),
  hasMutationBatch: (...args) => scope.abyssalRunWorkStore.hasMutationBatch(...args),
  isTerminalParticipantStatus: (...args) => scope.ABYSSAL_TERMINAL_PARTICIPANT_STATUSES.has(...args),
});
  scope.getActiveTraceStateForCharacterID = getActiveTraceStateForCharacterID;
  scope.getActivePocketStateForCharacterID = getActivePocketStateForCharacterID;
  scope.hasUnresolvedAbyssalRecoveryObligation = hasUnresolvedAbyssalRecoveryObligation;
  scope.getRecoverablePocketStateForCharacterID = getRecoverablePocketStateForCharacterID;
  scope.getActivePocketStateForShipID = getActivePocketStateForShipID;
  scope.getActiveAbyssalRunForCharacterID = getActiveAbyssalRunForCharacterID;
  scope.getActiveAbyssalRunForShipID = getActiveAbyssalRunForShipID;
  scope.getActiveAbyssalRunForCharacter = getActiveAbyssalRunForCharacter;
  scope.getActiveAbyssalRunForShip = getActiveAbyssalRunForShip;
  scope.isCharacterInActiveAbyssalRun = isCharacterInActiveAbyssalRun;
  scope.isShipInActiveAbyssalRun = isShipInActiveAbyssalRun;
  scope.getActivePocketStateByInstanceID = getActivePocketStateByInstanceID;
  scope.getActivePocketStateForSession = getActivePocketStateForSession;
  scope.getActivePocketStateByMarkerItemID = getActivePocketStateByMarkerItemID;
}

function initializeManagerGroup4Binding7(scope) {
  const {
  evaluateAbyssalDirectCallbackTerminalGuard,
  buildAbyssalDirectCallbackSuppressedResult,
  logRejectedAbyssalRunOutcomeTransition,
  getAbyssalRewardArtifactDestructionOperations,
  getAbyssalRewardArtifactDestructionOperation,
  buildAbyssalRewardArtifactDestructionOperationID,
  buildAbyssalRewardArtifactDestructionOperationPatch,
  mergeProtectedAbyssalRewardArtifactDestructionOperations,
  getAbyssalParticipantDestructionOperationsByCharacterID,
  getAbyssalParticipantDestructionOperation,
  buildAbyssalParticipantDestructionOperationPatch,
  buildAbyssalParticipantDestructionOperationID,
  buildAbyssalParticipantHullDestructionIntent,
  buildAbyssalParticipantDestructionIntent,
  logRejectedAbyssalParticipantDestructionTransition,
  buildAbyssalParticipantTerminalProjection,
  recordAbyssalRunOutcome,
  getAbyssalTerminalCleanupState,
  hasPendingAbyssalTerminalCleanup,
  shouldDeferAbyssalWeatherRemovalMaintenanceRetry,
  resolveAbyssalRecoveryCleanupReason,
  hasDurableAbyssalParticipantPodDestructionReceipt,
  requiresAbyssalParticipantDestructionReceiptForCleanup,
} = (0, scope.createAbyssalTerminalEvidence)({
  getDependencies: (...args) => (0, scope.getDependencies)(...args),
  getActivePocketStateByInstanceID: (...args) => (0, scope.getActivePocketStateByInstanceID)(...args),
  normalizeAbyssalRunOutcome: (...args) => (0, scope.normalizeAbyssalRunOutcome)(...args),
  evaluateAbyssalTerminalOperationGuard: (...args) => (0, scope.evaluateAbyssalTerminalOperationGuard)(...args),
  log: scope.log,
  recordAuditEvent: (...args) => (0, scope.recordAuditEvent)(...args),
  resolveAbyssalTerminalCallbackReason: (...args) => (0, scope.resolveAbyssalTerminalCallbackReason)(...args),
  cloneValue: (...args) => (0, scope.cloneValue)(...args),
  normalizeAbyssalRewardArtifactDestructionOperation: (...args) => (0, scope.normalizeAbyssalRewardArtifactDestructionOperation)(...args),
  normalizeLowerText: (...args) => (0, scope.normalizeLowerText)(...args),
  evaluateAbyssalRewardArtifactDestructionOperationTransition: (...args) => (0, scope.evaluateAbyssalRewardArtifactDestructionOperationTransition)(...args),
  normalizeAbyssalParticipantDestructionOperation: (...args) => (0, scope.normalizeAbyssalParticipantDestructionOperation)(...args),
  get ABYSSAL_PARTICIPANT_DESTRUCTION_MAP_SCHEMA_VERSION() { return scope.ABYSSAL_PARTICIPANT_DESTRUCTION_MAP_SCHEMA_VERSION; },
  get ABYSSAL_PARTICIPANT_DESTRUCTION_OPERATION_SCHEMA_VERSION() { return scope.ABYSSAL_PARTICIPANT_DESTRUCTION_OPERATION_SCHEMA_VERSION; },
  get ABYSSAL_PARTICIPANT_DESTRUCTION_OPERATION_STATUS() { return scope.ABYSSAL_PARTICIPANT_DESTRUCTION_OPERATION_STATUS; },
  buildPlaceholderRoomState: (...args) => (0, scope.buildPlaceholderRoomState)(...args),
  refreshAbyssalDungeonTrackingState: (...args) => (0, scope.refreshAbyssalDungeonTrackingState)(...args),
  getAbyssalWeatherRemovalState: (...args) => (0, scope.getAbyssalWeatherRemovalState)(...args),
  isExactAbyssalWeatherRemovalClaim: (...args) => (0, scope.isExactAbyssalWeatherRemovalClaim)(...args),
  get ABYSSAL_WEATHER_REMOVAL_MAX_ATTEMPTS() { return scope.ABYSSAL_WEATHER_REMOVAL_MAX_ATTEMPTS; },
  get ABYSSAL_WEATHER_REMOVAL_MAX_PENDING_MS() { return scope.ABYSSAL_WEATHER_REMOVAL_MAX_PENDING_MS; },
  resolveAbyssalWeatherRemovalRuntimeSession: (...args) => (0, scope.resolveAbyssalWeatherRemovalRuntimeSession)(...args),
  getAbyssalTimeoutState: (...args) => (0, scope.getAbyssalTimeoutState)(...args),
  get ABYSSAL_RUN_OUTCOME() { return scope.ABYSSAL_RUN_OUTCOME; },
  commitRunOutcome: (...args) => scope.abyssalRunOutcomeCommitCoordinator.commitAbyssalRunOutcome(...args),
});
  scope.evaluateAbyssalDirectCallbackTerminalGuard = evaluateAbyssalDirectCallbackTerminalGuard;
  scope.buildAbyssalDirectCallbackSuppressedResult = buildAbyssalDirectCallbackSuppressedResult;
  scope.logRejectedAbyssalRunOutcomeTransition = logRejectedAbyssalRunOutcomeTransition;
  scope.getAbyssalRewardArtifactDestructionOperations = getAbyssalRewardArtifactDestructionOperations;
  scope.getAbyssalRewardArtifactDestructionOperation = getAbyssalRewardArtifactDestructionOperation;
  scope.buildAbyssalRewardArtifactDestructionOperationID = buildAbyssalRewardArtifactDestructionOperationID;
  scope.buildAbyssalRewardArtifactDestructionOperationPatch = buildAbyssalRewardArtifactDestructionOperationPatch;
  scope.mergeProtectedAbyssalRewardArtifactDestructionOperations = mergeProtectedAbyssalRewardArtifactDestructionOperations;
  scope.getAbyssalParticipantDestructionOperationsByCharacterID = getAbyssalParticipantDestructionOperationsByCharacterID;
  scope.getAbyssalParticipantDestructionOperation = getAbyssalParticipantDestructionOperation;
  scope.buildAbyssalParticipantDestructionOperationPatch = buildAbyssalParticipantDestructionOperationPatch;
  scope.buildAbyssalParticipantDestructionOperationID = buildAbyssalParticipantDestructionOperationID;
  scope.buildAbyssalParticipantHullDestructionIntent = buildAbyssalParticipantHullDestructionIntent;
  scope.buildAbyssalParticipantDestructionIntent = buildAbyssalParticipantDestructionIntent;
  scope.logRejectedAbyssalParticipantDestructionTransition = logRejectedAbyssalParticipantDestructionTransition;
  scope.buildAbyssalParticipantTerminalProjection = buildAbyssalParticipantTerminalProjection;
  scope.recordAbyssalRunOutcome = recordAbyssalRunOutcome;
  scope.getAbyssalTerminalCleanupState = getAbyssalTerminalCleanupState;
  scope.hasPendingAbyssalTerminalCleanup = hasPendingAbyssalTerminalCleanup;
  scope.shouldDeferAbyssalWeatherRemovalMaintenanceRetry = shouldDeferAbyssalWeatherRemovalMaintenanceRetry;
  scope.resolveAbyssalRecoveryCleanupReason = resolveAbyssalRecoveryCleanupReason;
  scope.hasDurableAbyssalParticipantPodDestructionReceipt = hasDurableAbyssalParticipantPodDestructionReceipt;
  scope.requiresAbyssalParticipantDestructionReceiptForCleanup = requiresAbyssalParticipantDestructionReceiptForCleanup;
}

function initializeManagerGroup4Binding8(scope) {
  const {
  unregisterPocket,
  buildNextAbyssalPocketState,
  commitPocketStateDurably,
  updatePocketStateBestEffort,
  beginAbyssalPocketMutationBatch,
  applyAbyssalPocketMutationInMemory,
  registerAbyssalPocketInMemory,
  abortAbyssalPocketMutationBatch,
  commitAbyssalPocketMutationBatch,
  updatePocketState,
} = (0, scope.createAbyssalRunMutations)({
  getDependencies: (...args) => (0, scope.getDependencies)(...args),
  log: scope.log,
  cloneValue: (...args) => (0, scope.cloneValue)(...args),
  get ABYSSAL_DIAGNOSTIC_DEDUPE_SCOPE() { return scope.ABYSSAL_DIAGNOSTIC_DEDUPE_SCOPE; },
  hasAbyssalRecoveryTombstoneBacklog: (...args) => (0, scope.hasAbyssalRecoveryTombstoneBacklog)(...args),
  clearPlaceholderPocketMaintenance: (...args) => (0, scope.clearPlaceholderPocketMaintenance)(...args),
  getAbyssalPocketPersistenceVersion: (...args) => (0, scope.getAbyssalPocketPersistenceVersion)(...args),
  persistRegisteredAbyssalPocketState: (...args) => (0, scope.persistRegisteredAbyssalPocketState)(...args),
  get ABYSSAL_POCKET_PERSISTENCE_ERROR() { return scope.ABYSSAL_POCKET_PERSISTENCE_ERROR; },
  registerPocketInternal: (...args) => (0, scope.registerPocketInternal)(...args),
  get ABYSSAL_POCKET_MUTATION_DURABILITY() { return scope.ABYSSAL_POCKET_MUTATION_DURABILITY; },
  get AbyssalRunRegistryError() { return scope.AbyssalRunRegistryError; },
  get AbyssalPocketPersistenceError() { return scope.AbyssalPocketPersistenceError; },
  cleanupPendingWork: (...args) => scope.abyssalPendingWorkRegistry.cleanupRun(...args),
  removeActiveRun: (...args) => scope.activeAbyssalRunRegistry.remove(...args),
  cleanupRunWork: (...args) => scope.abyssalRunWorkStore.cleanupRun(...args),
  deleteRuntimeTelemetry: (...args) => scope.abyssalMaintenanceState.deleteRuntimeTelemetry(...args),
  deleteDiagnosticKeysMatching: (...args) => scope.abyssalDiagnosticsState.deleteDedupeKeysMatching(...args),
  deleteDiagnosticKey: (...args) => scope.abyssalDiagnosticsState.deleteDedupeKey(...args),
  getActiveRunCount: () => scope.activeAbyssalRunRegistry.size,
  hasTombstoneScanInProgress: (...args) => scope.abyssalRecoveryTombstoneStore.hasScanInProgress(...args),
  getRunByInstanceID: (...args) => scope.activeAbyssalRunRegistry.getByInstanceID(...args),
  replaceActiveRun: (...args) => scope.activeAbyssalRunRegistry.replace(...args),
  hasActiveRun: (...args) => scope.activeAbyssalRunRegistry.hasRun(...args),
  hasMutationBatch: (...args) => scope.abyssalRunWorkStore.hasMutationBatch(...args),
  setMutationBatch: (...args) => scope.abyssalRunWorkStore.setMutationBatch(...args),
  getMutationBatch: (...args) => scope.abyssalRunWorkStore.getMutationBatch(...args),
  deleteMutationBatch: (...args) => scope.abyssalRunWorkStore.deleteMutationBatch(...args),
});
  scope.unregisterPocket = unregisterPocket;
  scope.buildNextAbyssalPocketState = buildNextAbyssalPocketState;
  scope.commitPocketStateDurably = commitPocketStateDurably;
  scope.updatePocketStateBestEffort = updatePocketStateBestEffort;
  scope.beginAbyssalPocketMutationBatch = beginAbyssalPocketMutationBatch;
  scope.applyAbyssalPocketMutationInMemory = applyAbyssalPocketMutationInMemory;
  scope.registerAbyssalPocketInMemory = registerAbyssalPocketInMemory;
  scope.abortAbyssalPocketMutationBatch = abortAbyssalPocketMutationBatch;
  scope.commitAbyssalPocketMutationBatch = commitAbyssalPocketMutationBatch;
  scope.updatePocketState = updatePocketState;
}

function initializeManagerGroup4Binding9(scope) {
  const {
  allocateAbyssalSpatialReservation,
  reserveAbyssalSpatialSlotForPocketState,
  resolveExistingActiveRunConflict,
  buildAbyssalHandoffSessionIdentity,
} = (0, scope.createAbyssalAdmissionIdentity)({
  getDependencies: (...args) => (0, scope.getDependencies)(...args),
  isAbyssalHostLocationID: (...args) => (0, scope.isAbyssalHostLocationID)(...args),
  cloneValue: (...args) => (0, scope.cloneValue)(...args),
  getObjectPosition: (...args) => (0, scope.getObjectPosition)(...args),
  resolveAbyssalSpatialSlotOrigin: (...args) => (0, scope.resolveAbyssalSpatialSlotOrigin)(...args),
  get ABYSSAL_SPATIAL_RESERVATION_SCHEMA_VERSION() { return scope.ABYSSAL_SPATIAL_RESERVATION_SCHEMA_VERSION; },
  getActivePocketStateForCharacterID: (...args) => (0, scope.getActivePocketStateForCharacterID)(...args),
  getActiveTraceStateForCharacterID: (...args) => (0, scope.getActiveTraceStateForCharacterID)(...args),
  isCreatedAbyssalTraceExpired: (...args) => (0, scope.isCreatedAbyssalTraceExpired)(...args),
  expireCreatedAbyssalTrace: (...args) => (0, scope.expireCreatedAbyssalTrace)(...args),
  readTraceStateFromItem: (...args) => (0, scope.readTraceStateFromItem)(...args),
  normalizeAbyssalTraceLifecyclePhase: (...args) => (0, scope.normalizeAbyssalTraceLifecyclePhase)(...args),
  get ABYSSAL_TRACE_LIFECYCLE_PHASE() { return scope.ABYSSAL_TRACE_LIFECYCLE_PHASE; },
  canRecoverCreatedAbyssalTraceAfterRestart: (...args) => (0, scope.canRecoverCreatedAbyssalTraceAfterRestart)(...args),
  registerTrace: (...args) => (0, scope.registerTrace)(...args),
  ensureSourceTraceRuntime: (...args) => (0, scope.ensureSourceTraceRuntime)(...args),
  scheduleCreatedAbyssalTraceExpiry: (...args) => (0, scope.scheduleCreatedAbyssalTraceExpiry)(...args),
  getSessionContext: (...args) => (0, scope.getSessionContext)(...args),
  getReadOnlySolarSystemScene: (...args) => (0, scope.getReadOnlySolarSystemScene)(...args),
  log: scope.log,
  allocateSpatialSlot: (...args) => scope.abyssalHostSlotAllocator.allocate(...args),
  getSpatialReservation: (...args) => scope.abyssalHostSlotAllocator.getReservation(...args),
  reserveSpatialSlot: (...args) => scope.abyssalHostSlotAllocator.reserve(...args),
  hasPendingDeployment: (...args) => scope.abyssalTraceStateRegistry.hasPendingDeployment(...args),
});
  scope.allocateAbyssalSpatialReservation = allocateAbyssalSpatialReservation;
  scope.reserveAbyssalSpatialSlotForPocketState = reserveAbyssalSpatialSlotForPocketState;
  scope.resolveExistingActiveRunConflict = resolveExistingActiveRunConflict;
  scope.buildAbyssalHandoffSessionIdentity = buildAbyssalHandoffSessionIdentity;
}

function initializeManagerGroup4Binding10(scope) {
  const {
  markAbyssalParticipantDestructionPersistenceFailure,
  persistAndVerifyAbyssalParticipantDestructionOperation,
  getAuthoritativeAbyssalPocketState,
  buildAbyssalPersistencePendingResult,
  rememberPendingAbyssalParticipantDestructionReceipt,
  getPendingAbyssalParticipantDestructionReceipt,
  clearPendingAbyssalParticipantDestructionReceipt,
} = (0, scope.createAbyssalDestructionReceipts)({
  getDependencies: (...args) => (0, scope.getDependencies)(...args),
  normalizeAbyssalParticipantDestructionOperation: (...args) => (0, scope.normalizeAbyssalParticipantDestructionOperation)(...args),
  getAbyssalParticipantDestructionOperation: (...args) => (0, scope.getAbyssalParticipantDestructionOperation)(...args),
  commitAbyssalParticipantDestructionOperationState: (...args) => (0, scope.commitAbyssalParticipantDestructionOperationState)(...args),
  cloneValue: (...args) => (0, scope.cloneValue)(...args),
  getActivePocketStateByInstanceID: (...args) => (0, scope.getActivePocketStateByInstanceID)(...args),
  get ABYSSAL_POCKET_PERSISTENCE_ERROR() { return scope.ABYSSAL_POCKET_PERSISTENCE_ERROR; },
  isValidAbyssalParticipantDestructionOperation: (...args) => (0, scope.isValidAbyssalParticipantDestructionOperation)(...args),
  setPersistenceFailure: (...args) => scope.abyssalRunWorkStore.setPersistenceFailure(...args),
  deletePersistedStateSignature: (...args) => scope.abyssalRunWorkStore.deletePersistedStateSignature(...args),
  deletePersistenceFailure: (...args) => scope.abyssalRunWorkStore.deletePersistenceFailure(...args),
  setParticipantDestructionReceipt: (...args) => scope.abyssalPendingWorkRegistry.setParticipantDestructionReceipt(...args),
  getParticipantDestructionReceipt: (...args) => scope.abyssalPendingWorkRegistry.getParticipantDestructionReceipt(...args),
  deleteParticipantDestructionReceipt: (...args) => scope.abyssalPendingWorkRegistry.deleteParticipantDestructionReceipt(...args),
  listParticipantDestructionReceipts: (...args) => scope.abyssalPendingWorkRegistry.listParticipantDestructionReceipts(...args),
});
  scope.markAbyssalParticipantDestructionPersistenceFailure = markAbyssalParticipantDestructionPersistenceFailure;
  scope.persistAndVerifyAbyssalParticipantDestructionOperation = persistAndVerifyAbyssalParticipantDestructionOperation;
  scope.getAuthoritativeAbyssalPocketState = getAuthoritativeAbyssalPocketState;
  scope.buildAbyssalPersistencePendingResult = buildAbyssalPersistencePendingResult;
  scope.rememberPendingAbyssalParticipantDestructionReceipt = rememberPendingAbyssalParticipantDestructionReceipt;
  scope.getPendingAbyssalParticipantDestructionReceipt = getPendingAbyssalParticipantDestructionReceipt;
  scope.clearPendingAbyssalParticipantDestructionReceipt = clearPendingAbyssalParticipantDestructionReceipt;
}

function initializeManagerGroup4Binding11(scope) {
  const {
  getAbyssalParticipantReturnObligationsByCharacterID,
  getAbyssalParticipantReturnObligation,
  persistAbyssalParticipantReturnObligation,
} = (0, scope.createAbyssalReturnObligations)({
  getDependencies: (...args) => (0, scope.getDependencies)(...args),
  cloneValue: (...args) => (0, scope.cloneValue)(...args),
  get ABYSSAL_PARTICIPANT_RETURN_OBLIGATION_SCHEMA_VERSION() { return scope.ABYSSAL_PARTICIPANT_RETURN_OBLIGATION_SCHEMA_VERSION; },
  findAbyssalReturnProtectionTraceState: (...args) => (0, scope.findAbyssalReturnProtectionTraceState)(...args),
  listUniquePositiveInts: (...args) => (0, scope.listUniquePositiveInts)(...args),
  persistTraceState: (...args) => (0, scope.persistTraceState)(...args),
});
  scope.getAbyssalParticipantReturnObligationsByCharacterID = getAbyssalParticipantReturnObligationsByCharacterID;
  scope.getAbyssalParticipantReturnObligation = getAbyssalParticipantReturnObligation;
  scope.persistAbyssalParticipantReturnObligation = persistAbyssalParticipantReturnObligation;
}

function initializeManagerGroup4Binding12(scope) {
  const {
  markSourceTraceReturnedForPocket,
  settleFailedAbyssalDestinationActivation,
} = (0, scope.createAbyssalTransitionSettlement)({
  getDependencies: (...args) => (0, scope.getDependencies)(...args),
  cloneValue: (...args) => (0, scope.cloneValue)(...args),
  getTrace: (...args) => scope.abyssalTraceStateRegistry.getTrace(...args),
  readTraceStateFromItem: (...args) => (0, scope.readTraceStateFromItem)(...args),
  resolveAbyssalTraceProfile: (...args) => (0, scope.resolveAbyssalTraceProfile)(...args),
  transitionSourceTraceState: (...args) => (0, scope.transitionSourceTraceState)(...args),
  get ABYSSAL_TRACE_LIFECYCLE_PHASE() { return scope.ABYSSAL_TRACE_LIFECYCLE_PHASE; },
  persistTraceState: (...args) => (0, scope.persistTraceState)(...args),
  isAbyssalSuspectReturnPending: (...args) => (0, scope.isAbyssalSuspectReturnPending)(...args),
  isAbyssalReturnProtectionPending: (...args) => (0, scope.isAbyssalReturnProtectionPending)(...args),
  scheduleSourceTraceRemoval: (...args) => (0, scope.scheduleSourceTraceRemoval)(...args),
  removeOwnedSourceTrace: (...args) => (0, scope.removeOwnedSourceTrace)(...args),
  getVectorDistance: (...args) => (0, scope.getVectorDistance)(...args),
  getObjectPosition: (...args) => (0, scope.getObjectPosition)(...args),
  log: scope.log,
  getActivePocketStateByInstanceID: (...args) => (0, scope.getActivePocketStateByInstanceID)(...args),
  buildPlaceholderRoomState: (...args) => (0, scope.buildPlaceholderRoomState)(...args),
  pauseSuppressorControllersForRoom: (...args) => (0, scope.pauseSuppressorControllersForRoom)(...args),
  pauseAbyssalObjectiveControllers: (...args) => (0, scope.pauseAbyssalObjectiveControllers)(...args),
  listPocketHostileEntityIDs: (...args) => (0, scope.listPocketHostileEntityIDs)(...args),
  suppressAbyssalRoomRewards: (...args) => (0, scope.suppressAbyssalRoomRewards)(...args),
  recordAbyssalRunOutcome: (...args) => (0, scope.recordAbyssalRunOutcome)(...args),
  ensureAbyssalPocketPersistenceReady: (...args) => (0, scope.ensureAbyssalPocketPersistenceReady)(...args),
  sendAbyssalTerminalClientTeardown: (...args) => (0, scope.sendAbyssalTerminalClientTeardown)(...args),
  evacuateAbyssalRunSession: (...args) => (0, scope.evacuateAbyssalRunSession)(...args),
  cleanupAbyssalRun: (...args) => (0, scope.cleanupAbyssalRun)(...args),
  schedulePlaceholderPocketMaintenance: (...args) => (0, scope.schedulePlaceholderPocketMaintenance)(...args),
});
  scope.markSourceTraceReturnedForPocket = markSourceTraceReturnedForPocket;
  scope.settleFailedAbyssalDestinationActivation = settleFailedAbyssalDestinationActivation;
}

function initializeManagerGroup4Binding13(scope) {
  const {
  reconcileControllerDependantLifecycleOnNpcDestroyed,
} = (0, scope.createAbyssalDependantLifecycle)({
  cloneValue: (...args) => (0, scope.cloneValue)(...args),
  listUniquePositiveInts: (...args) => (0, scope.listUniquePositiveInts)(...args),
});
  scope.reconcileControllerDependantLifecycleOnNpcDestroyed = reconcileControllerDependantLifecycleOnNpcDestroyed;
}

function bindAbyssalManagerRuntimeGroup4Operations(scope) {

}

function initializeAbyssalManagerRuntimeGroup4Part1(scope) {
  initializeManagerGroup4Binding1(scope);
  initializeManagerGroup4Binding2(scope);
  initializeManagerGroup4Binding3(scope);
  initializeManagerGroup4Binding4(scope);
  initializeManagerGroup4Binding5(scope);
  initializeManagerGroup4Binding6(scope);
  initializeManagerGroup4Binding7(scope);
  initializeManagerGroup4Binding8(scope);
  initializeManagerGroup4Binding9(scope);
  initializeManagerGroup4Binding10(scope);
  initializeManagerGroup4Binding11(scope);
  initializeManagerGroup4Binding12(scope);
  initializeManagerGroup4Binding13(scope);
}

function initializeAbyssalManagerRuntimeGroup4(scope) {
  initializeAbyssalManagerRuntimeGroup4Part1(scope);
}

module.exports = {
  bindAbyssalManagerRuntimeGroup4Operations,
  initializeAbyssalManagerRuntimeGroup4,
};
