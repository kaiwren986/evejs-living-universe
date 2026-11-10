"use strict";

function buildManagerGroup10Binding1Part2(scope) {
  return {
  get getDependencies() { return scope.getDependencies; },
  get cloneValue() { return scope.cloneValue; },
  get runPlaceholderPocketMaintenance() { return scope.runPlaceholderPocketMaintenance; },
  get getActivePocketStateByInstanceID() { return scope.getActivePocketStateByInstanceID; },
  get buildPocketStateForCurrentRoom() { return scope.buildPocketStateForCurrentRoom; },
  get buildPlaceholderRoomState() { return scope.buildPlaceholderRoomState; },
  get log() { return scope.log; },
  get getPlaceholderRoomEntry() { return scope.getPlaceholderRoomEntry; },
  get getObjectPosition() { return scope.getObjectPosition; },
  get resolveRoomOriginPosition() { return scope.resolveRoomOriginPosition; },
  get buildRoomConduitState() { return scope.buildRoomConduitState; },
  get isFinalRoomIndex() { return scope.isFinalRoomIndex; },
  get getFinalExitConduitLabel() { return scope.getFinalExitConduitLabel; },
  get getTransferConduitLabel() { return scope.getTransferConduitLabel; },
  get resolveRoomEncounterProfile() { return scope.resolveRoomEncounterProfile; },
  get resolveRoomRewardProfile() { return scope.resolveRoomRewardProfile; },
  get setPlaceholderRoomEntry() { return scope.setPlaceholderRoomEntry; },
  get buildRoomShipSpawnState() { return scope.buildRoomShipSpawnState; },
  get buildEncounterStateFromRoomEntry() { return scope.buildEncounterStateFromRoomEntry; },
  get buildPlaceholderTimerState() { return scope.buildPlaceholderTimerState; },
  get getNpcRuntimePolicy() { return scope.getNpcRuntimePolicy; },
  get registerPocket() { return scope.registerPocket; },
  get schedulePlaceholderPocketMaintenance() { return scope.schedulePlaceholderPocketMaintenance; },
  get destroyPlaceholderTrace() { return scope.destroyPlaceholderTrace; },
  get buildAbyssalSceneDescriptor() { return scope.buildAbyssalSceneDescriptor; },
  get ensurePocketMarker() { return scope.ensurePocketMarker; },
  get TYPE_ABYSSAL_ORIGIN_CONDUIT() { return scope.TYPE_ABYSSAL_ORIGIN_CONDUIT; },
  get TYPE_ABYSSAL_TRANSFER_CONDUIT() { return scope.TYPE_ABYSSAL_TRANSFER_CONDUIT; },
  get listPocketHostileEntityIDs() { return scope.listPocketHostileEntityIDs; },
  get buildPlaceholderEncounterState() { return scope.buildPlaceholderEncounterState; },
  get listUniquePositiveInts() { return scope.listUniquePositiveInts; },
  get isAbyssalPocketMutationBatchActive() { return scope.isAbyssalPocketMutationBatchActive; },
  get suppressAbyssalRoomRewards() { return scope.suppressAbyssalRoomRewards; },
  get ensurePlaceholderExtractionNodes() { return scope.ensurePlaceholderExtractionNodes; },
  get getAbyssalSceneryProfileForRoomIndex() { return scope.getAbyssalSceneryProfileForRoomIndex; },
  get isAuthoritativeAbyssalSceneryProfile() { return scope.isAuthoritativeAbyssalSceneryProfile; },
  get usesIsolatedAbyssalScene() { return scope.usesIsolatedAbyssalScene; },
  get ensureAbyssalSceneryVisuals() { return scope.ensureAbyssalSceneryVisuals; },
  get ensureAbyssalEnvironmentalObjects() { return scope.ensureAbyssalEnvironmentalObjects; },
  get getContentProfile() { return scope.getContentProfile; },
  get isSupportedAbyssalContentTier() { return scope.isSupportedAbyssalContentTier; },
  get hasTerminalFailureOutcome() { return scope.hasTerminalFailureOutcome; },
  get ensurePlaceholderRewardCache() { return scope.ensurePlaceholderRewardCache; },
  get maybeSendAbyssalRoomOneClientFx() { return scope.maybeSendAbyssalRoomOneClientFx; },
  get buildRoomLogContext() { return scope.buildRoomLogContext; },
  get logAbyssalRoomContentPrepared() { return scope.logAbyssalRoomContentPrepared; },
  get resolveSelectedAbyssalBaseRoomLayoutID() { return scope.resolveSelectedAbyssalBaseRoomLayoutID; },
  get ABYSSAL_ROOM_DELIVERY_STATE() { return scope.ABYSSAL_ROOM_DELIVERY_STATE; },
  get setAbyssalRoomEntityDeliveryState() { return scope.setAbyssalRoomEntityDeliveryState; },
  get ABYSSAL_ROOM_ENTITY_ROLES() { return scope.ABYSSAL_ROOM_ENTITY_ROLES; },
  get updatePocketState() { return scope.updatePocketState; },
  get pauseSuppressorControllersForRoom() { return scope.pauseSuppressorControllersForRoom; },
  get cleanupSuppressorControllerByRuntimeEntity() { return scope.cleanupSuppressorControllerByRuntimeEntity; },
  get cleanupSuppressorPresentationStateByEntity() { return scope.cleanupSuppressorPresentationStateByEntity; },
  get destroyAbyssalSceneryVisualEntity() { return scope.destroyAbyssalSceneryVisualEntity; },
  get removeRetiredAbyssalRoomRuntimeResidue() { return scope.removeRetiredAbyssalRoomRuntimeResidue; },
  get beginAbyssalPocketMutationBatch() { return scope.beginAbyssalPocketMutationBatch; },
  get commitAbyssalPocketMutationBatch() { return scope.commitAbyssalPocketMutationBatch; },
  get abortAbyssalPocketMutationBatch() { return scope.abortAbyssalPocketMutationBatch; },
  get clampRoomIndex() { return scope.clampRoomIndex; },
  get buildPlaceholderRoomEntry() { return scope.buildPlaceholderRoomEntry; },
  get destroyRoomExtractionNodes() { return scope.destroyRoomExtractionNodes; },
  get destroyRoomExtractionNodeLootContainers() { return scope.destroyRoomExtractionNodeLootContainers; },
  get despawnAbyssalEnvironmentalObjectEntity() { return scope.despawnAbyssalEnvironmentalObjectEntity; },
  get listPositiveInts() { return scope.listPositiveInts; },
  get logAbyssalRoomContentCleaned() { return scope.logAbyssalRoomContentCleaned; },
  get getAbyssalParticipantRecord() { return scope.getAbyssalParticipantRecord; },
  get upsertAbyssalParticipantRosterEntry() { return scope.upsertAbyssalParticipantRosterEntry; },
  get ABYSSAL_PARTICIPANT_STATUS() { return scope.ABYSSAL_PARTICIPANT_STATUS; },
  get settleFailedAbyssalDestinationActivation() { return scope.settleFailedAbyssalDestinationActivation; },
  get getPendingAbyssalTransitionState() { return scope.getPendingAbyssalTransitionState; },
  get activateAbyssalRoomNpcControllers() { return scope.activateAbyssalRoomNpcControllers; },
  get activateSuppressorControllersForPocketRoom() { return scope.activateSuppressorControllersForPocketRoom; },
  get deliverSuppressorPresentationForSession() { return scope.deliverSuppressorPresentationForSession; },
  get ensureBoundaryControllerForPocketState() { return scope.ensureBoundaryControllerForPocketState; },
  get getPocketScene() { return scope.getPocketScene; },
  get stampAbyssalParticipantRoomScope() { return scope.stampAbyssalParticipantRoomScope; },
  get formatVectorForLog() { return scope.formatVectorForLog; },
  get cleanupExactAbyssalScannerProbes() { return scope.cleanupExactAbyssalScannerProbes; },
  get abandonExactAbyssalSourceRoomPlayerCompanions() { return scope.abandonExactAbyssalSourceRoomPlayerCompanions; },
  get retireExactAbyssalSourceRoomPlayerObjects() { return scope.retireExactAbyssalSourceRoomPlayerObjects; },
  get stopSuppressorPresentationForPocketSession() { return scope.stopSuppressorPresentationForPocketSession; },
  get clearSuppressorDebugHistoryForRun() { return scope.clearSuppressorDebugHistoryForRun; },
  get buildAbyssalClientEnvironmentSelection() { return scope.buildAbyssalClientEnvironmentSelection; },
  get listAbyssalRoomRetirementEntityIDs() { return scope.listAbyssalRoomRetirementEntityIDs; },
  get normalizeAbyssalParticipantRoster() { return scope.normalizeAbyssalParticipantRoster; },
  get syncInventoryChanges() { return scope.syncInventoryChanges; },
  get recordAbyssalEnvironmentSequenceEvent() { return scope.recordAbyssalEnvironmentSequenceEvent; },
  get advanceAbyssalRoomTransferLifecycle() { return scope.advanceAbyssalRoomTransferLifecycle; },
  get moveOtherAbyssalParticipantsToRoom() { return scope.moveOtherAbyssalParticipantsToRoom; },
  get listAbyssalRoomBootstrapEntityIDs() { return scope.listAbyssalRoomBootstrapEntityIDs; },
  get resolveAbyssalRosterParticipantSession() { return scope.resolveAbyssalRosterParticipantSession; },
  get buildAbyssalDestinationRequirements() { return scope.buildAbyssalDestinationRequirements; },
  get markAbyssalRoomContentDelivered() { return scope.markAbyssalRoomContentDelivered; },
  get markAbyssalDungeonRoomWithoutGenericNotification() { return scope.markAbyssalDungeonRoomWithoutGenericNotification; },
  get selectAbyssalClientEnvironmentForSession() { return scope.selectAbyssalClientEnvironmentForSession; },
  get OPTIONAL_CLOUD_PRESENTATION_NOT_AUTHORED() { return scope.OPTIONAL_CLOUD_PRESENTATION_NOT_AUTHORED; },
  get sendAbyssalDungeonExitNotification() { return scope.sendAbyssalDungeonExitNotification; },
  get sendAbyssalLocationEnteredNotification() { return scope.sendAbyssalLocationEnteredNotification; },
  get sendAbyssalLocationExitNotification() { return scope.sendAbyssalLocationExitNotification; },
  get updateAbyssalClientEnvironmentDeliveryState() { return scope.updateAbyssalClientEnvironmentDeliveryState; },
  get refreshAbyssalDungeonTrackingState() { return scope.refreshAbyssalDungeonTrackingState; },
  get evaluateEnvironmentalEffectsForPocketState() { return scope.evaluateEnvironmentalEffectsForPocketState; },
  get applyAbyssalWeatherToRun() { return scope.applyAbyssalWeatherToRun; },
  get buildAbyssalDestinationMechanicsReadiness() { return scope.buildAbyssalDestinationMechanicsReadiness; },
  get logAbyssalRoomContentActivated() { return scope.logAbyssalRoomContentActivated; },
  get listCurrentRoomBootstrapEntityIDs() { return scope.listCurrentRoomBootstrapEntityIDs; },
  get hasPrewarmedPlaceholderRoomContent() { return scope.hasPrewarmedPlaceholderRoomContent; },
  get buildAbyssalParticipantRoomScopeMetadata() { return scope.buildAbyssalParticipantRoomScopeMetadata; },
  get isSessionReadyForIncrementalSpaceDelivery() { return scope.isSessionReadyForIncrementalSpaceDelivery; },
};
}

function buildManagerGroup10Binding1Part1(scope) {
  return (0, scope.createAbyssalRoomTransferComposition)(buildManagerGroup10Binding1Part2(scope));
}

function initializeManagerGroup10Binding1(scope) {
  const {
  spawnPlaceholderPocketContent,
  prewarmCurrentPlaceholderRoomContent,
  prewarmNextPlaceholderRoomContent,
  rollbackFailedAbyssalDestinationPrewarm,
  buildAbyssalTransferDestinationRoomEntry,
  cleanAbyssalTransferSourceRoom,
  prepareAbyssalTransferDestinationContent,
  restoreAbyssalTransferSourceRoom,
  commitAbyssalTransferSourceRoom,
  deliverAbyssalTransferParticipants,
  publishAbyssalTransferDestination,
  activateAbyssalTransferDestination,
  transferShipToNextPlaceholderRoom,
} = buildManagerGroup10Binding1Part1(scope);
  scope.spawnPlaceholderPocketContent = spawnPlaceholderPocketContent;
  scope.prewarmCurrentPlaceholderRoomContent = prewarmCurrentPlaceholderRoomContent;
  scope.prewarmNextPlaceholderRoomContent = prewarmNextPlaceholderRoomContent;
  scope.rollbackFailedAbyssalDestinationPrewarm = rollbackFailedAbyssalDestinationPrewarm;
  scope.buildAbyssalTransferDestinationRoomEntry = buildAbyssalTransferDestinationRoomEntry;
  scope.cleanAbyssalTransferSourceRoom = cleanAbyssalTransferSourceRoom;
  scope.prepareAbyssalTransferDestinationContent = prepareAbyssalTransferDestinationContent;
  scope.restoreAbyssalTransferSourceRoom = restoreAbyssalTransferSourceRoom;
  scope.commitAbyssalTransferSourceRoom = commitAbyssalTransferSourceRoom;
  scope.deliverAbyssalTransferParticipants = deliverAbyssalTransferParticipants;
  scope.publishAbyssalTransferDestination = publishAbyssalTransferDestination;
  scope.activateAbyssalTransferDestination = activateAbyssalTransferDestination;
  scope.transferShipToNextPlaceholderRoom = transferShipToNextPlaceholderRoom;
}

function initializeManagerGroup10Binding2(scope) {
  const {
  resolveAbyssalParticipantAdmissionState,
  admitAbyssalParticipantIntoExistingRun,
} = (0, scope.createAbyssalParticipantAdmission)({
  buildPlaceholderRoomState: scope.buildPlaceholderRoomState,
  getPendingAbyssalTransitionState: scope.getPendingAbyssalTransitionState,
  normalizeLowerText: scope.normalizeLowerText,
  getPlaceholderRoomEntry: scope.getPlaceholderRoomEntry,
  upsertAbyssalParticipantRosterEntry: scope.upsertAbyssalParticipantRosterEntry,
  cloneValue: scope.cloneValue,
  ABYSSAL_PARTICIPANT_STATUS: scope.ABYSSAL_PARTICIPANT_STATUS,
  commitPocketStateDurably: scope.commitPocketStateDurably,
  ABYSSAL_PARTICIPANT_ROSTER_SCHEMA_VERSION: scope.ABYSSAL_PARTICIPANT_ROSTER_SCHEMA_VERSION,
  buildAbyssalSceneDescriptor: scope.buildAbyssalSceneDescriptor,
  resolveAbyssalEnvironmentRoomProfileForPocket: scope.resolveAbyssalEnvironmentRoomProfileForPocket,
  resolveTransitionProfileSetForLayout: scope.resolveTransitionProfileSetForLayout,
  maybeSendAbyssalTransitionFx: scope.maybeSendAbyssalTransitionFx,
  resolveAbyssalClientDungeonIdentifier: scope.resolveAbyssalClientDungeonIdentifier,
  normalizeAbyssalParticipantRoster: scope.normalizeAbyssalParticipantRoster,
  getObjectPosition: scope.getObjectPosition,
  addVectors: scope.addVectors,
  moveShipIntoPlaceholderPocket: scope.moveShipIntoPlaceholderPocket,
  getActivePocketStateByInstanceID: scope.getActivePocketStateByInstanceID,
  persistTraceState: scope.persistTraceState,
  log: scope.log,
  broadcastAbyssalRoomBootstrapAddBalls: scope.broadcastAbyssalRoomBootstrapAddBalls,
  queueAbyssalFreshEntryBootstrap: scope.queueAbyssalFreshEntryBootstrap,
  applyAbyssalWeatherToRun: scope.applyAbyssalWeatherToRun,
  usesAuthoredAbyssalEnvironmentNotification: scope.usesAuthoredAbyssalEnvironmentNotification,
  queueAbyssalClientEnvironmentDelivery: scope.queueAbyssalClientEnvironmentDelivery,
  sendAbyssalExpiryDurationNotification: scope.sendAbyssalExpiryDurationNotification,
  sendOrQueueInitialAbyssalArrivalFx: scope.sendOrQueueInitialAbyssalArrivalFx,
  deliverSuppressorPresentationForSession: scope.deliverSuppressorPresentationForSession,
  schedulePlaceholderPocketMaintenance: scope.schedulePlaceholderPocketMaintenance,
  abyssalPendingWorkRegistry: scope.abyssalPendingWorkRegistry,
  getAbyssalParticipantRecord: scope.getAbyssalParticipantRecord,
  validateAbyssalTraceActivation: (...args) => (0, scope.validateAbyssalTraceActivation)(...args),
  getDependencies: scope.getDependencies,
});
  scope.resolveAbyssalParticipantAdmissionState = resolveAbyssalParticipantAdmissionState;
  scope.admitAbyssalParticipantIntoExistingRun = admitAbyssalParticipantIntoExistingRun;
}

function initializeManagerGroup10Binding3(scope) {
  const { schedulePendingAbyssalTransition } = (0, scope.createAbyssalTransitionScheduling)({
  log: scope.log,
  maybeSendAbyssalTransitionFx: scope.maybeSendAbyssalTransitionFx,
  recordAbyssalEnvironmentSequenceEvent: scope.recordAbyssalEnvironmentSequenceEvent,
  getActivePocketStateByInstanceID: scope.getActivePocketStateByInstanceID,
  clearPendingAbyssalTransitionHandle: scope.clearPendingAbyssalTransitionHandle,
  usesIsolatedAbyssalScene: scope.usesIsolatedAbyssalScene,
  buildAbyssalSceneDescriptor: scope.buildAbyssalSceneDescriptor,
  resolveSelectedAbyssalBaseRoomLayoutID: scope.resolveSelectedAbyssalBaseRoomLayoutID,
  TRANSITION_POLICY_EXPERIMENTAL: scope.TRANSITION_POLICY_EXPERIMENTAL,
  updatePocketState: scope.updatePocketState,
  setAbyssalRoomEntityDeliveryState: scope.setAbyssalRoomEntityDeliveryState,
  ABYSSAL_ROOM_DELIVERY_STATE: scope.ABYSSAL_ROOM_DELIVERY_STATE,
  getPendingAbyssalTransitionState: scope.getPendingAbyssalTransitionState,
  cloneValue: scope.cloneValue,
  restoreAbyssalSourceRoomAfterTransitionFailure: scope.restoreAbyssalSourceRoomAfterTransitionFailure,
  evaluateAbyssalDirectCallbackTerminalGuard: scope.evaluateAbyssalDirectCallbackTerminalGuard,
  settleFailedAbyssalDestinationActivation: scope.settleFailedAbyssalDestinationActivation,
  ensureBoundaryControllerForPocketState: scope.ensureBoundaryControllerForPocketState,
  abyssalPendingWorkRegistry: scope.abyssalPendingWorkRegistry,
  syncExpiredAbyssalPocketState: scope.syncExpiredAbyssalPocketState,
});
  scope.schedulePendingAbyssalTransition = schedulePendingAbyssalTransition;
}

function initializeManagerGroup10Binding4(scope) {
  const {
  buildAbyssalKSpaceArrivalReadiness,
  logAbyssalKSpaceArrival,
  clearPendingAbyssalKSpaceArrival,
  finalizeAbyssalKSpaceArrival,
  scheduleAbyssalKSpaceArrivalAfterExit,
  completeAbyssalKSpaceArrivalForSession,
} = (0, scope.createAbyssalKSpaceArrival)({
  getDependencies: scope.getDependencies,
  getActivePocketStateByInstanceID: scope.getActivePocketStateByInstanceID,
  getAbyssalParticipantRecord: scope.getAbyssalParticipantRecord,
  getPendingAbyssalTransitionState: scope.getPendingAbyssalTransitionState,
  getCharacterID: scope.getCharacterID,
  log: scope.log,
  evaluateAbyssalDirectCallbackTerminalGuard: scope.evaluateAbyssalDirectCallbackTerminalGuard,
  ABYSSAL_RUN_OUTCOME: scope.ABYSSAL_RUN_OUTCOME,
  buildAbyssalDirectCallbackSuppressedResult: scope.buildAbyssalDirectCallbackSuppressedResult,
  sendAbyssalContentFinishedNotification: scope.sendAbyssalContentFinishedNotification,
  createComposedAbyssalFinalExitCoordinator: scope.createComposedAbyssalFinalExitCoordinator,
  hasTerminalFailureOutcome: scope.hasTerminalFailureOutcome,
  recordAbyssalRunOutcome: scope.recordAbyssalRunOutcome,
  normalizeAbyssalRunOutcome: scope.normalizeAbyssalRunOutcome,
  cleanupAbyssalRun: scope.cleanupAbyssalRun,
  schedulePlaceholderPocketMaintenance: scope.schedulePlaceholderPocketMaintenance,
  buildAbyssalFinalExitCoordinatorRequest: scope.buildAbyssalFinalExitCoordinatorRequest,
  buildAbyssalTransitionFxProfile: scope.buildAbyssalTransitionFxProfile,
  abyssalPendingWorkRegistry: scope.abyssalPendingWorkRegistry,
  cloneValue: scope.cloneValue,
  ABYSSAL_KSPACE_ARRIVAL_READINESS_EXPIRY_MS: scope.ABYSSAL_KSPACE_ARRIVAL_READINESS_EXPIRY_MS,
  updateAbyssalTransitionFxState: scope.updateAbyssalTransitionFxState,
  maybeSendAbyssalArrivalFx: scope.maybeSendAbyssalArrivalFx,
  ABYSSAL_BEYONCE_POST_SETSTATE_ARRIVAL_FX_DELAY_MS: scope.ABYSSAL_BEYONCE_POST_SETSTATE_ARRIVAL_FX_DELAY_MS,
});
  scope.buildAbyssalKSpaceArrivalReadiness = buildAbyssalKSpaceArrivalReadiness;
  scope.logAbyssalKSpaceArrival = logAbyssalKSpaceArrival;
  scope.clearPendingAbyssalKSpaceArrival = clearPendingAbyssalKSpaceArrival;
  scope.finalizeAbyssalKSpaceArrival = finalizeAbyssalKSpaceArrival;
  scope.scheduleAbyssalKSpaceArrivalAfterExit = scheduleAbyssalKSpaceArrivalAfterExit;
  scope.completeAbyssalKSpaceArrivalForSession = completeAbyssalKSpaceArrivalForSession;
}

function initializeManagerGroup10Binding5(scope) {
  const {
  buildAbyssalParticipantReturnSpaceState,
  buildAbyssalParticipantReturnObligationSource,
  stageAbyssalParticipantReturnObligations,
  moveOtherAbyssalParticipantsOutOfRun,
} = (0, scope.createAbyssalParticipantReturn)({
  buildPlaceholderReturnSpaceState: scope.buildPlaceholderReturnSpaceState,
  cloneValue: scope.cloneValue,
  toReal: scope.toReal,
  getDependencies: scope.getDependencies,
  findAbyssalReturnProtectionTraceState: scope.findAbyssalReturnProtectionTraceState,
  getAbyssalParticipantReturnObligation: scope.getAbyssalParticipantReturnObligation,
  stageAbyssalReturnProtectionObligation: scope.stageAbyssalReturnProtectionObligation,
  normalizeLowerText: scope.normalizeLowerText,
  persistAbyssalSuspectReturnTraceState: scope.persistAbyssalSuspectReturnTraceState,
  getCharacterID: scope.getCharacterID,
  getActivePocketStateByInstanceID: scope.getActivePocketStateByInstanceID,
  normalizeAbyssalParticipantRoster: scope.normalizeAbyssalParticipantRoster,
  ABYSSAL_PARTICIPANT_STATUS: scope.ABYSSAL_PARTICIPANT_STATUS,
  resolveAbyssalRosterParticipantSession: scope.resolveAbyssalRosterParticipantSession,
  getPocketScene: scope.getPocketScene,
  buildAbyssalClientEnvironmentSelection: scope.buildAbyssalClientEnvironmentSelection,
  buildAbyssalSceneDescriptor: scope.buildAbyssalSceneDescriptor,
  upsertAbyssalParticipantRosterEntry: scope.upsertAbyssalParticipantRosterEntry,
  commitPocketStateDurably: scope.commitPocketStateDurably,
  updateCharacterLocationForAbyssalEvacuation: scope.updateCharacterLocationForAbyssalEvacuation,
  sendAbyssalDungeonExitNotification: scope.sendAbyssalDungeonExitNotification,
  sendAbyssalLocationExitNotification: scope.sendAbyssalLocationExitNotification,
  syncInventoryChanges: scope.syncInventoryChanges,
  clearAbyssalClientEnvironmentForSession: scope.clearAbyssalClientEnvironmentForSession,
  buildAbyssalExitSessionChanges: scope.buildAbyssalExitSessionChanges,
  applyAbyssalEntrySessionFields: scope.applyAbyssalEntrySessionFields,
  sendAbyssalEntrySessionChange: scope.sendAbyssalEntrySessionChange,
  clearAbyssalSessionState: scope.clearAbyssalSessionState,
  clearExactAbyssalParticipantRoomScopeMetadata: scope.clearExactAbyssalParticipantRoomScopeMetadata,
  settleAbyssalReturnProtectionObligation: scope.settleAbyssalReturnProtectionObligation,
  settleAbyssalSuspectOnReturn: scope.settleAbyssalSuspectOnReturn,
  refreshAbyssalPlayerShipWeather: scope.refreshAbyssalPlayerShipWeather,
  sendAbyssalContentFinishedNotification: scope.sendAbyssalContentFinishedNotification,
  scheduleAbyssalKSpaceArrivalAfterExit: scope.scheduleAbyssalKSpaceArrivalAfterExit,
  log: scope.log,
});
  scope.buildAbyssalParticipantReturnSpaceState = buildAbyssalParticipantReturnSpaceState;
  scope.buildAbyssalParticipantReturnObligationSource = buildAbyssalParticipantReturnObligationSource;
  scope.stageAbyssalParticipantReturnObligations = stageAbyssalParticipantReturnObligations;
  scope.moveOtherAbyssalParticipantsOutOfRun = moveOtherAbyssalParticipantsOutOfRun;
}

function initializeManagerGroup10Binding6(scope) {
  const ABYSSAL_RECOVERY_TOMBSTONE_TABLE = "abyssalRecoveryTombstones";
  scope.ABYSSAL_RECOVERY_TOMBSTONE_TABLE = ABYSSAL_RECOVERY_TOMBSTONE_TABLE;
}

function initializeManagerGroup10Binding7(scope) {
  const ABYSSAL_RECOVERY_TOMBSTONE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
  scope.ABYSSAL_RECOVERY_TOMBSTONE_RETENTION_MS = ABYSSAL_RECOVERY_TOMBSTONE_RETENTION_MS;
}

function initializeManagerGroup10Binding8(scope) {
  const ABYSSAL_RECOVERY_TOMBSTONE_MAX_SCAN_PER_PASS = 256;
  scope.ABYSSAL_RECOVERY_TOMBSTONE_MAX_SCAN_PER_PASS = ABYSSAL_RECOVERY_TOMBSTONE_MAX_SCAN_PER_PASS;
}

function initializeManagerGroup10Binding9(scope) {
  const ABYSSAL_RECOVERY_TOMBSTONE_MAX_EVICTIONS_PER_PASS = 128;
  scope.ABYSSAL_RECOVERY_TOMBSTONE_MAX_EVICTIONS_PER_PASS = ABYSSAL_RECOVERY_TOMBSTONE_MAX_EVICTIONS_PER_PASS;
}

function initializeManagerGroup10Binding10(scope) {
  const ABYSSAL_RECOVERY_TOMBSTONE_IDLE_MAINTENANCE_INTERVAL_MS = 60_000;
  scope.ABYSSAL_RECOVERY_TOMBSTONE_IDLE_MAINTENANCE_INTERVAL_MS = ABYSSAL_RECOVERY_TOMBSTONE_IDLE_MAINTENANCE_INTERVAL_MS;
}

function initializeManagerGroup10Binding11(scope) {
  const ABYSSAL_RECOVERY_TOMBSTONE_FAILURE_LOG_INTERVAL_MS = 60_000;
  scope.ABYSSAL_RECOVERY_TOMBSTONE_FAILURE_LOG_INTERVAL_MS = ABYSSAL_RECOVERY_TOMBSTONE_FAILURE_LOG_INTERVAL_MS;
}

function initializeManagerGroup10Binding12(scope) {
  const ABYSSAL_RECOVERY_RETRY_BASE_DELAY_MS = 1_000;
  scope.ABYSSAL_RECOVERY_RETRY_BASE_DELAY_MS = ABYSSAL_RECOVERY_RETRY_BASE_DELAY_MS;
}

function initializeManagerGroup10Binding13(scope) {
  const ABYSSAL_RECOVERY_RETRY_MAX_DELAY_MS = 60_000;
  scope.ABYSSAL_RECOVERY_RETRY_MAX_DELAY_MS = ABYSSAL_RECOVERY_RETRY_MAX_DELAY_MS;
}

function initializeManagerGroup10Binding14(scope) {
class AbyssalPocketPersistenceError extends Error {
  constructor(result = {}) {
    const errorMsg = (0, scope.normalizeText)(
      result && result.errorMsg,
      scope.ABYSSAL_POCKET_PERSISTENCE_ERROR,
    );
    super(errorMsg);
    this.name = "AbyssalPocketPersistenceError";
    this.code = errorMsg;
    this.instanceID = (0, scope.toInt)(result && result.instanceID, 0);
    this.persistenceResult = (0, scope.cloneValue)(result && result.persistenceResult) || null;
    this.conflict = result && result.conflict === true;
  }
}
  scope.AbyssalPocketPersistenceError = AbyssalPocketPersistenceError;
}

function initializeManagerGroup10Binding15(scope) {
  const {
  stageCommittedAbyssalFinalExitState,
  settleCommittedAbyssalFinalExitFailure,
} = (0, scope.createAbyssalFinalExitSettlement)({
  getActivePocketStateByInstanceID: scope.getActivePocketStateByInstanceID,
  getAbyssalWeatherRemovalState: scope.getAbyssalWeatherRemovalState,
  upsertAbyssalParticipantRosterEntry: scope.upsertAbyssalParticipantRosterEntry,
  cloneValue: scope.cloneValue,
  getAbyssalParticipantRecord: scope.getAbyssalParticipantRecord,
  ABYSSAL_PARTICIPANT_STATUS: scope.ABYSSAL_PARTICIPANT_STATUS,
  commitPocketStateDurably: scope.commitPocketStateDurably,
  normalizeLowerText: scope.normalizeLowerText,
  schedulePlaceholderPocketMaintenance: scope.schedulePlaceholderPocketMaintenance,
  log: scope.log,
  sendAbyssalContentFinishedNotification: scope.sendAbyssalContentFinishedNotification,
  hasTerminalFailureOutcome: scope.hasTerminalFailureOutcome,
  recordAbyssalRunOutcome: scope.recordAbyssalRunOutcome,
  AbyssalPocketPersistenceError: scope.AbyssalPocketPersistenceError,
  cleanupAbyssalRun: scope.cleanupAbyssalRun,
});
  scope.stageCommittedAbyssalFinalExitState = stageCommittedAbyssalFinalExitState;
  scope.settleCommittedAbyssalFinalExitFailure = settleCommittedAbyssalFinalExitFailure;
}

function initializeManagerGroup10Binding16(scope) {
  const { moveShipOutOfPlaceholderPocket } = (0, scope.createAbyssalFinalExitExecution)({
  getDependencies: scope.getDependencies,
  getCharacterID: scope.getCharacterID,
  stageCommittedAbyssalFinalExitState: scope.stageCommittedAbyssalFinalExitState,
  settleCommittedAbyssalFinalExitFailure: scope.settleCommittedAbyssalFinalExitFailure,
  getActivePocketStateByInstanceID: scope.getActivePocketStateByInstanceID,
  hasTerminalFailureOutcome: scope.hasTerminalFailureOutcome,
  recordAbyssalRunOutcome: scope.recordAbyssalRunOutcome,
  normalizeAbyssalRunOutcome: scope.normalizeAbyssalRunOutcome,
  ABYSSAL_RUN_OUTCOME: scope.ABYSSAL_RUN_OUTCOME,
  cleanupAbyssalRun: scope.cleanupAbyssalRun,
  createComposedAbyssalFinalExitCoordinator: scope.createComposedAbyssalFinalExitCoordinator,
  ensureAbyssalPocketDurablyAdopted: scope.ensureAbyssalPocketDurablyAdopted,
  cloneValue: scope.cloneValue,
  getAbyssalParticipantRecord: scope.getAbyssalParticipantRecord,
  getPendingAbyssalTransitionState: scope.getPendingAbyssalTransitionState,
  buildPlaceholderRoomState: scope.buildPlaceholderRoomState,
  moveOtherAbyssalParticipantsOutOfRun: scope.moveOtherAbyssalParticipantsOutOfRun,
  buildAbyssalParticipantReturnSpaceState: scope.buildAbyssalParticipantReturnSpaceState,
  buildAbyssalClientEnvironmentSelection: scope.buildAbyssalClientEnvironmentSelection,
  buildAbyssalSceneDescriptor: scope.buildAbyssalSceneDescriptor,
  stageAbyssalParticipantReturnObligations: scope.stageAbyssalParticipantReturnObligations,
  pauseSuppressorControllersForRoom: scope.pauseSuppressorControllersForRoom,
  stopSuppressorPresentationForPocketSession: scope.stopSuppressorPresentationForPocketSession,
  clearSuppressorDebugHistoryForRun: scope.clearSuppressorDebugHistoryForRun,
  markSourceTraceReturnedForPocket: scope.markSourceTraceReturnedForPocket,
  log: scope.log,
  commitPocketStateDurably: scope.commitPocketStateDurably,
  sendAbyssalDungeonExitNotification: scope.sendAbyssalDungeonExitNotification,
  sendAbyssalLocationExitNotification: scope.sendAbyssalLocationExitNotification,
  syncInventoryChanges: scope.syncInventoryChanges,
  clearAbyssalClientEnvironmentForSession: scope.clearAbyssalClientEnvironmentForSession,
  buildAbyssalExitSessionChanges: scope.buildAbyssalExitSessionChanges,
  applyAbyssalEntrySessionFields: scope.applyAbyssalEntrySessionFields,
  sendAbyssalEntrySessionChange: scope.sendAbyssalEntrySessionChange,
  clearExactAbyssalParticipantRoomScopeMetadata: scope.clearExactAbyssalParticipantRoomScopeMetadata,
  grantAbyssalReturnProtectionAfterAttach: scope.grantAbyssalReturnProtectionAfterAttach,
  settleAbyssalSuspectOnReturn: scope.settleAbyssalSuspectOnReturn,
  scheduleAbyssalKSpaceArrivalAfterExit: scope.scheduleAbyssalKSpaceArrivalAfterExit,
  resolveAbyssalSceneModeState: scope.resolveAbyssalSceneModeState,
  formatVectorForLog: scope.formatVectorForLog,
  buildAbyssalKSpaceArrivalReadiness: scope.buildAbyssalKSpaceArrivalReadiness,
  logAbyssalKSpaceArrival: scope.logAbyssalKSpaceArrival,
  sendAbyssalContentFinishedNotification: scope.sendAbyssalContentFinishedNotification,
  buildAbyssalFinalExitCoordinatorRequest: scope.buildAbyssalFinalExitCoordinatorRequest,
});
  scope.moveShipOutOfPlaceholderPocket = moveShipOutOfPlaceholderPocket;
}

function initializeManagerGroup10Binding17(scope) {
  const { prepareAbyssalRunCleanup } = (0, scope.createAbyssalCleanupPreparation)({
  getActivePocketStateByInstanceID: scope.getActivePocketStateByInstanceID,
  cloneValue: scope.cloneValue,
  normalizeAbyssalParticipantRoster: scope.normalizeAbyssalParticipantRoster,
  ABYSSAL_PARTICIPANT_STATUS: scope.ABYSSAL_PARTICIPANT_STATUS,
  schedulePlaceholderPocketMaintenance: scope.schedulePlaceholderPocketMaintenance,
  requiresAbyssalParticipantDestructionReceiptForCleanup: scope.requiresAbyssalParticipantDestructionReceiptForCleanup,
  listUniquePositiveInts: scope.listUniquePositiveInts,
  getAbyssalParticipantDestructionOperation: scope.getAbyssalParticipantDestructionOperation,
  ABYSSAL_PARTICIPANT_DESTRUCTION_OPERATION_STATUS: scope.ABYSSAL_PARTICIPANT_DESTRUCTION_OPERATION_STATUS,
  log: scope.log,
  persistAndVerifyAbyssalParticipantDestructionOperation: scope.persistAndVerifyAbyssalParticipantDestructionOperation,
  getAbyssalTerminalCleanupState: scope.getAbyssalTerminalCleanupState,
  updatePocketState: scope.updatePocketState,
  ensureAbyssalPocketPersistenceReady: scope.ensureAbyssalPocketPersistenceReady,
  normalizeLowerText: scope.normalizeLowerText,
  buildPlaceholderReturnSpaceState: scope.buildPlaceholderReturnSpaceState,
  markSourceTraceReturnedForPocket: scope.markSourceTraceReturnedForPocket,
});
  scope.prepareAbyssalRunCleanup = prepareAbyssalRunCleanup;
}

function initializeManagerGroup10Binding18(scope) {
  const { collectAbyssalArtifactInventory, buildExtractionNodeCleanupTracking, destroyPocketArtifacts } = (0, scope.createAbyssalArtifactCleanup)({
  getDependencies: scope.getDependencies,
  getResolvedWeatherState: scope.getResolvedWeatherState,
  listAllPocketHostileEntityIDs: scope.listAllPocketHostileEntityIDs,
  buildPlaceholderRoomState: scope.buildPlaceholderRoomState,
  listUniquePositiveInts: scope.listUniquePositiveInts,
  log: scope.log,
  destroyPocketEncounterEntities: scope.destroyPocketEncounterEntities,
  cleanupExactAbyssalScannerProbes: scope.cleanupExactAbyssalScannerProbes,
  buildAbyssalSceneDescriptor: scope.buildAbyssalSceneDescriptor,
  destroyPlaceholderTrace: scope.destroyPlaceholderTrace,
  destroyAbyssalSceneryVisualEntity: scope.destroyAbyssalSceneryVisualEntity,
  getActiveTraceState: scope.getActiveTraceState,
  resolveAbyssalTraceProfile: scope.resolveAbyssalTraceProfile,
  isAbyssalSuspectReturnPending: scope.isAbyssalSuspectReturnPending,
  isAbyssalReturnProtectionPending: scope.isAbyssalReturnProtectionPending,
  normalizeLowerText: scope.normalizeLowerText,
  normalizeAbyssalTraceLifecyclePhase: scope.normalizeAbyssalTraceLifecyclePhase,
  ABYSSAL_TRACE_LIFECYCLE_PHASE: scope.ABYSSAL_TRACE_LIFECYCLE_PHASE,
  removeOwnedSourceTrace: scope.removeOwnedSourceTrace,
  cleanupResidualPocketSpaceItems: scope.cleanupResidualPocketSpaceItems,
  cloneValue: scope.cloneValue,
});
  scope.collectAbyssalArtifactInventory = collectAbyssalArtifactInventory;
  scope.buildExtractionNodeCleanupTracking = buildExtractionNodeCleanupTracking;
  scope.destroyPocketArtifacts = destroyPocketArtifacts;
}

function initializeManagerGroup10Binding19(scope) {
  const { reconcileAbyssalCleanupWeather } = (0, scope.createAbyssalCleanupWeather)({
  getAbyssalWeatherRemovalState: scope.getAbyssalWeatherRemovalState,
  isExactAbyssalWeatherRemovalClaim: scope.isExactAbyssalWeatherRemovalClaim,
  normalizeLowerText: scope.normalizeLowerText,
  getActivePocketStateByInstanceID: scope.getActivePocketStateByInstanceID,
  cloneValue: scope.cloneValue,
  updatePocketState: scope.updatePocketState,
  ensureAbyssalPocketPersistenceReady: scope.ensureAbyssalPocketPersistenceReady,
  schedulePlaceholderPocketMaintenance: scope.schedulePlaceholderPocketMaintenance,
  removeAbyssalWeatherFromRun: scope.removeAbyssalWeatherFromRun,
  ABYSSAL_WEATHER_REMOVAL_MAX_ATTEMPTS: scope.ABYSSAL_WEATHER_REMOVAL_MAX_ATTEMPTS,
  ABYSSAL_WEATHER_REMOVAL_MAX_PENDING_MS: scope.ABYSSAL_WEATHER_REMOVAL_MAX_PENDING_MS,
  log: scope.log,
  commitPocketStateDurably: scope.commitPocketStateDurably,
});
  scope.reconcileAbyssalCleanupWeather = reconcileAbyssalCleanupWeather;
}

function bindAbyssalManagerRuntimeGroup10Operations(scope) {

}

function initializeAbyssalManagerRuntimeGroup10Part1(scope) {
  initializeManagerGroup10Binding1(scope);
  initializeManagerGroup10Binding2(scope);
  initializeManagerGroup10Binding3(scope);
  initializeManagerGroup10Binding4(scope);
  initializeManagerGroup10Binding5(scope);
  initializeManagerGroup10Binding6(scope);
  initializeManagerGroup10Binding7(scope);
  initializeManagerGroup10Binding8(scope);
  initializeManagerGroup10Binding9(scope);
  initializeManagerGroup10Binding10(scope);
  initializeManagerGroup10Binding11(scope);
  initializeManagerGroup10Binding12(scope);
  initializeManagerGroup10Binding13(scope);
  initializeManagerGroup10Binding14(scope);
  initializeManagerGroup10Binding15(scope);
  initializeManagerGroup10Binding16(scope);
  initializeManagerGroup10Binding17(scope);
  initializeManagerGroup10Binding18(scope);
  initializeManagerGroup10Binding19(scope);
}

function initializeAbyssalManagerRuntimeGroup10(scope) {
  initializeAbyssalManagerRuntimeGroup10Part1(scope);
}

module.exports = {
  bindAbyssalManagerRuntimeGroup10Operations,
  initializeAbyssalManagerRuntimeGroup10,
};
