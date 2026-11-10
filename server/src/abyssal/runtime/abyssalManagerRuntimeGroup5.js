"use strict";

function initializeManagerGroup5Binding1(scope) {
  const {
  ensureAbyssalRecoveryTombstoneTable,
  writeAbyssalRecoveryTombstoneIndex,
  readAbyssalRecoveryTombstoneIndex,
  normalizeAbyssalRecoveryOriginAttempts,
  normalizeAbyssalRecoveryTombstone,
  rememberAbyssalRecoveryTombstone,
  findAbyssalRecoveryTombstone,
  updateAbyssalRecoveryTombstoneState,
  getAbyssalRecoveryTombstoneIdentity,
  hasPendingAbyssalParticipantDestructionReceiptForRun,
  abyssalRecoveryTombstoneIsEvictable,
  readAbyssalRecoveryTombstoneTableState,
  hasAbyssalRecoveryTombstoneBacklog,
  iterateAbyssalRecoveryTombstones,
  deleteMatchingAbyssalRecoveryTombstoneMemoryIndexes,
  deleteNestedTablePaths,
  hasNestedTablePath,
  commitAbyssalRecoveryTombstonePathDeletes,
  commitAbyssalRecoveryTombstoneEvictions,
  runAbyssalRecoveryTombstoneMaintenance,
  getAbyssalRecoveryTombstoneDiagnosticsForTests,
} = (0, scope.createAbyssalRecoveryTombstoneOperations)({
  getDependencies: (...args) => (0, scope.getDependencies)(...args),
  get database() { return scope.database; },
  get ABYSSAL_RECOVERY_TOMBSTONE_TABLE() { return scope.ABYSSAL_RECOVERY_TOMBSTONE_TABLE; },
  log: scope.log,
  cloneValue: (...args) => (0, scope.cloneValue)(...args),
  isAbyssalHostLocationID: (...args) => (0, scope.isAbyssalHostLocationID)(...args),
  get ABYSSAL_RECOVERY_ORIGIN_UNRESOLVED() { return scope.ABYSSAL_RECOVERY_ORIGIN_UNRESOLVED; },
  getObjectPosition: (...args) => (0, scope.getObjectPosition)(...args),
  get ABYSSAL_RECOVERY_TOMBSTONE_RETENTION_MS() { return scope.ABYSSAL_RECOVERY_TOMBSTONE_RETENTION_MS; },
  schedulePlaceholderPocketMaintenance: (...args) => (0, scope.schedulePlaceholderPocketMaintenance)(...args),
  get RECOVERY_TOMBSTONE_INDEX_DEFINITIONS() { return scope.RECOVERY_TOMBSTONE_INDEX_DEFINITIONS; },
  get ABYSSAL_RECOVERY_TOMBSTONE_FAILURE_LOG_INTERVAL_MS() { return scope.ABYSSAL_RECOVERY_TOMBSTONE_FAILURE_LOG_INTERVAL_MS; },
  resolveEffectiveAbyssalMaintenanceNowMs: (...args) => (0, scope.resolveEffectiveAbyssalMaintenanceNowMs)(...args),
  get ABYSSAL_RECOVERY_TOMBSTONE_MAX_SCAN_PER_PASS() { return scope.ABYSSAL_RECOVERY_TOMBSTONE_MAX_SCAN_PER_PASS; },
  get ABYSSAL_RECOVERY_TOMBSTONE_MAX_EVICTIONS_PER_PASS() { return scope.ABYSSAL_RECOVERY_TOMBSTONE_MAX_EVICTIONS_PER_PASS; },
  registerTombstone: (...args) => scope.abyssalRecoveryTombstoneStore.register(...args),
  findTombstoneCandidates: (...args) => scope.abyssalRecoveryTombstoneStore.findCandidates(...args),
  hasTombstoneEntries: (...args) => scope.abyssalRecoveryTombstoneStore.hasEntries(...args),
  iterateTombstoneValues: (...args) => scope.abyssalRecoveryTombstoneStore.iterateValues(...args),
  deleteMatchingTombstones: (...args) => scope.abyssalRecoveryTombstoneStore.deleteMatching(...args),
  hasMatchingTombstone: (...args) => scope.abyssalRecoveryTombstoneStore.hasMatching(...args),
  recordTombstoneEvictionFailure: (...args) => scope.abyssalRecoveryTombstoneStore.recordEvictionFailure(...args),
  nextTombstoneScanEntry: (...args) => scope.abyssalRecoveryTombstoneStore.nextScanEntry(...args),
  finishTombstoneScan: (...args) => scope.abyssalRecoveryTombstoneStore.finishScan(...args),
  recordTombstoneMaintenancePass: (...args) => scope.abyssalRecoveryTombstoneStore.recordMaintenancePass(...args),
  hasTombstoneScanInProgress: (...args) => scope.abyssalRecoveryTombstoneStore.hasScanInProgress(...args),
  getTombstoneDiagnostics: (...args) => scope.abyssalRecoveryTombstoneStore.getDiagnostics(...args),
  hasParticipantDestructionReceiptForRun: (...args) => scope.abyssalPendingWorkRegistry.hasParticipantDestructionReceiptForRun(...args),
  hasActiveRun: (...args) => scope.activeAbyssalRunRegistry.hasRun(...args),
  hasPersistenceFailure: (...args) => scope.abyssalRunWorkStore.hasPersistenceFailure(...args),
  hasMutationBatch: (...args) => scope.abyssalRunWorkStore.hasMutationBatch(...args),
  hasRecoveryRetryState: (...args) => scope.abyssalMaintenanceState.hasRecoveryRetryState(...args),
  getTransitionHandle: (...args) => scope.abyssalPendingWorkRegistry.getTransitionHandle(...args),
  getHostReservation: (...args) => scope.abyssalHostSlotAllocator.getReservation(...args),
});
  scope.ensureAbyssalRecoveryTombstoneTable = ensureAbyssalRecoveryTombstoneTable;
  scope.writeAbyssalRecoveryTombstoneIndex = writeAbyssalRecoveryTombstoneIndex;
  scope.readAbyssalRecoveryTombstoneIndex = readAbyssalRecoveryTombstoneIndex;
  scope.normalizeAbyssalRecoveryOriginAttempts = normalizeAbyssalRecoveryOriginAttempts;
  scope.normalizeAbyssalRecoveryTombstone = normalizeAbyssalRecoveryTombstone;
  scope.rememberAbyssalRecoveryTombstone = rememberAbyssalRecoveryTombstone;
  scope.findAbyssalRecoveryTombstone = findAbyssalRecoveryTombstone;
  scope.updateAbyssalRecoveryTombstoneState = updateAbyssalRecoveryTombstoneState;
  scope.getAbyssalRecoveryTombstoneIdentity = getAbyssalRecoveryTombstoneIdentity;
  scope.hasPendingAbyssalParticipantDestructionReceiptForRun = hasPendingAbyssalParticipantDestructionReceiptForRun;
  scope.abyssalRecoveryTombstoneIsEvictable = abyssalRecoveryTombstoneIsEvictable;
  scope.readAbyssalRecoveryTombstoneTableState = readAbyssalRecoveryTombstoneTableState;
  scope.hasAbyssalRecoveryTombstoneBacklog = hasAbyssalRecoveryTombstoneBacklog;
  scope.iterateAbyssalRecoveryTombstones = iterateAbyssalRecoveryTombstones;
  scope.deleteMatchingAbyssalRecoveryTombstoneMemoryIndexes = deleteMatchingAbyssalRecoveryTombstoneMemoryIndexes;
  scope.deleteNestedTablePaths = deleteNestedTablePaths;
  scope.hasNestedTablePath = hasNestedTablePath;
  scope.commitAbyssalRecoveryTombstonePathDeletes = commitAbyssalRecoveryTombstonePathDeletes;
  scope.commitAbyssalRecoveryTombstoneEvictions = commitAbyssalRecoveryTombstoneEvictions;
  scope.runAbyssalRecoveryTombstoneMaintenance = runAbyssalRecoveryTombstoneMaintenance;
  scope.getAbyssalRecoveryTombstoneDiagnosticsForTests = getAbyssalRecoveryTombstoneDiagnosticsForTests;
}

function initializeManagerGroup5Binding2(scope) {
  const {
  listAbyssalRoomBootstrapEntityIDs,
  listCurrentRoomBootstrapEntityIDs,
  listAbyssalRoomRetirementEntityIDs,
  removeRetiredAbyssalRoomRuntimeResidue,
  updateAbyssalInventoryRoomDeliveryCustomInfo,
  persistAbyssalInventoryRoomDeliveryState,
  setAbyssalRoomEntityDeliveryState,
  isSessionReadyForIncrementalSpaceDelivery,
  markAbyssalRoomContentDelivered,
  broadcastAbyssalRoomBootstrapAddBalls,
} = (0, scope.createAbyssalRoomDelivery)({
  getDependencies: (...args) => (0, scope.getDependencies)(...args),
  buildPlaceholderRoomState: (...args) => (0, scope.buildPlaceholderRoomState)(...args),
  clampRoomIndex: (...args) => (0, scope.clampRoomIndex)(...args),
  getPlaceholderRoomEntry: (...args) => (0, scope.getPlaceholderRoomEntry)(...args),
  listUniquePositiveInts: (...args) => (0, scope.listUniquePositiveInts)(...args),
  getPocketScene: (...args) => (0, scope.getPocketScene)(...args),
  listAbyssalRoomEntityRecords: (...args) => (0, scope.listAbyssalRoomEntityRecords)(...args),
  resolveExactAbyssalRunRoomScope: (...args) => (0, scope.resolveExactAbyssalRunRoomScope)(...args),
  normalizeAbyssalParticipantRoster: (...args) => (0, scope.normalizeAbyssalParticipantRoster)(...args),
  buildAbyssalSceneDescriptor: (...args) => (0, scope.buildAbyssalSceneDescriptor)(...args),
  isRetainedAbyssalPlayerCompanion: (...args) => (0, scope.isRetainedAbyssalPlayerCompanion)(...args),
  destroyPlaceholderTrace: (...args) => (0, scope.destroyPlaceholderTrace)(...args),
  parseCustomInfo: (...args) => (0, scope.parseCustomInfo)(...args),
  get ABYSSAL_INVENTORY_ROOM_STATE_KEYS() { return scope.ABYSSAL_INVENTORY_ROOM_STATE_KEYS; },
  resolveSelectedAbyssalBaseRoomLayoutID: (...args) => (0, scope.resolveSelectedAbyssalBaseRoomLayoutID)(...args),
  isEarlyVisibilityState: state => scope.ABYSSAL_EARLY_VISIBILITY_STATES.has(state),
  setPlaceholderRoomEntry: (...args) => (0, scope.setPlaceholderRoomEntry)(...args),
  updatePocketState: (...args) => (0, scope.updatePocketState)(...args),
  log: scope.log,
  buildPocketStateForCurrentRoom: (...args) => (0, scope.buildPocketStateForCurrentRoom)(...args),
  logAbyssalRoomContentDelivered: (...args) => (0, scope.logAbyssalRoomContentDelivered)(...args),
  listPocketHostileEntityIDs: (...args) => (0, scope.listPocketHostileEntityIDs)(...args),
  summarizeAbyssalRoomEntities: (...args) => (0, scope.summarizeAbyssalRoomEntities)(...args),
  formatAbyssalRoomEntityCountsForLog: (...args) => (0, scope.formatAbyssalRoomEntityCountsForLog)(...args),
});
  scope.listAbyssalRoomBootstrapEntityIDs = listAbyssalRoomBootstrapEntityIDs;
  scope.listCurrentRoomBootstrapEntityIDs = listCurrentRoomBootstrapEntityIDs;
  scope.listAbyssalRoomRetirementEntityIDs = listAbyssalRoomRetirementEntityIDs;
  scope.removeRetiredAbyssalRoomRuntimeResidue = removeRetiredAbyssalRoomRuntimeResidue;
  scope.updateAbyssalInventoryRoomDeliveryCustomInfo = updateAbyssalInventoryRoomDeliveryCustomInfo;
  scope.persistAbyssalInventoryRoomDeliveryState = persistAbyssalInventoryRoomDeliveryState;
  scope.setAbyssalRoomEntityDeliveryState = setAbyssalRoomEntityDeliveryState;
  scope.isSessionReadyForIncrementalSpaceDelivery = isSessionReadyForIncrementalSpaceDelivery;
  scope.markAbyssalRoomContentDelivered = markAbyssalRoomContentDelivered;
  scope.broadcastAbyssalRoomBootstrapAddBalls = broadcastAbyssalRoomBootstrapAddBalls;
}

function initializeManagerGroup5Binding3(scope) {
  const {
  buildAbyssalDestinationRequirements,
} = (0, scope.createAbyssalDestinationRequirements)({
  getDependencies: (...args) => (0, scope.getDependencies)(...args),
  getPlaceholderRoomEntry: (...args) => (0, scope.getPlaceholderRoomEntry)(...args),
  listUniquePositiveInts: (...args) => (0, scope.listUniquePositiveInts)(...args),
  getContentProfile: (...args) => (0, scope.getContentProfile)(...args),
  getAbyssalSceneryProfileForRoomIndex: (...args) => (0, scope.getAbyssalSceneryProfileForRoomIndex)(...args),
  listAbyssalSceneryProfileEntries: (...args) => (0, scope.listAbyssalSceneryProfileEntries)(...args),
  resolveAbyssalSceneryPolicy: (...args) => (0, scope.resolveAbyssalSceneryPolicy)(...args),
  get SCENERY_POLICY_AUTHORITATIVE() { return scope.SCENERY_POLICY_AUTHORITATIVE; },
  buildAbyssalSceneryVisualItemID: (...args) => (0, scope.buildAbyssalSceneryVisualItemID)(...args),
  readEnvironmentalObjectStateFromItem: (...args) => (0, scope.readEnvironmentalObjectStateFromItem)(...args),
  listAbyssalRoomBootstrapEntityIDs: (...args) => (0, scope.listAbyssalRoomBootstrapEntityIDs)(...args),
  log: scope.log,
  buildAbyssalSceneryAuthorityDiagnostics: (...args) => (0, scope.buildAbyssalSceneryAuthorityDiagnostics)(...args),
  warnIfAuthoritativeSceneryMissing: (...args) => (0, scope.warnIfAuthoritativeSceneryMissing)(...args),
});
  scope.buildAbyssalDestinationRequirements = buildAbyssalDestinationRequirements;
}

function initializeManagerGroup5Binding4(scope) {
  const {
  getPendingAbyssalTransitionState,
  advanceAbyssalRoomTransferLifecycle,
  clearPendingAbyssalTransitionHandle,
  cancelPendingAbyssalTransition,
  restoreAbyssalSourceRoomAfterTransitionFailure,
  quiesceAbyssalRoomTransferCombat,
  revalidateDelayedAbyssalEndGateHandoff,
} = (0, scope.createAbyssalTransitionAuthority)({
  getDependencies: (...args) => (0, scope.getDependencies)(...args),
  get ABYSSAL_ROOM_TRANSFER_LIFECYCLE_STATES() { return scope.ABYSSAL_ROOM_TRANSFER_LIFECYCLE_STATES; },
  getActivePocketStateByInstanceID: (...args) => (0, scope.getActivePocketStateByInstanceID)(...args),
  cloneValue: (...args) => (0, scope.cloneValue)(...args),
  updatePocketState: (...args) => (0, scope.updatePocketState)(...args),
  log: scope.log,
  cancelTransitionHandle: (...args) => scope.abyssalPendingWorkRegistry.cancelTransitionHandle(...args),
  setAbyssalRoomEntityDeliveryState: (...args) => (0, scope.setAbyssalRoomEntityDeliveryState)(...args),
  get ABYSSAL_ROOM_DELIVERY_STATE() { return scope.ABYSSAL_ROOM_DELIVERY_STATE; },
  activateAbyssalRoomNpcControllers: (...args) => (0, scope.activateAbyssalRoomNpcControllers)(...args),
  activateSuppressorControllersForPocketRoom: (...args) => (0, scope.activateSuppressorControllersForPocketRoom)(...args),
  deliverSuppressorPresentationForSession: (...args) => (0, scope.deliverSuppressorPresentationForSession)(...args),
  ensureBoundaryControllerForPocketState: (...args) => (0, scope.ensureBoundaryControllerForPocketState)(...args),
  buildPlaceholderRoomState: (...args) => (0, scope.buildPlaceholderRoomState)(...args),
  getPlaceholderRoomEntry: (...args) => (0, scope.getPlaceholderRoomEntry)(...args),
  listUniquePositiveInts: (...args) => (0, scope.listUniquePositiveInts)(...args),
  finalizeAndCleanupBoundaryControllersForRun: (...args) => (0, scope.finalizeAndCleanupBoundaryControllersForRun)(...args),
  pauseAbyssalObjectiveControllers: (...args) => (0, scope.pauseAbyssalObjectiveControllers)(...args),
  pauseSuppressorControllersForRoom: (...args) => (0, scope.pauseSuppressorControllersForRoom)(...args),
  stopSuppressorPresentationForPocketSession: (...args) => (0, scope.stopSuppressorPresentationForPocketSession)(...args),
  buildAbyssalHandoffSessionIdentity: (...args) => (0, scope.buildAbyssalHandoffSessionIdentity)(...args),
  getAbyssalParticipantRecord: (...args) => (0, scope.getAbyssalParticipantRecord)(...args),
  isAbyssalParticipantInRun: (...args) => (0, scope.isAbyssalParticipantInRun)(...args),
  evaluateAbyssalDelayedHandoffEligibility: (...args) => (0, scope.evaluateAbyssalDelayedHandoffEligibility)(...args),
  validateAbyssalExitTraceActivation: (...args) => (0, scope.validateAbyssalExitTraceActivation)(...args),
});
  scope.getPendingAbyssalTransitionState = getPendingAbyssalTransitionState;
  scope.advanceAbyssalRoomTransferLifecycle = advanceAbyssalRoomTransferLifecycle;
  scope.clearPendingAbyssalTransitionHandle = clearPendingAbyssalTransitionHandle;
  scope.cancelPendingAbyssalTransition = cancelPendingAbyssalTransition;
  scope.restoreAbyssalSourceRoomAfterTransitionFailure = restoreAbyssalSourceRoomAfterTransitionFailure;
  scope.quiesceAbyssalRoomTransferCombat = quiesceAbyssalRoomTransferCombat;
  scope.revalidateDelayedAbyssalEndGateHandoff = revalidateDelayedAbyssalEndGateHandoff;
}

function initializeManagerGroup5Binding5(scope) {
  const {
  toAbyssalExpiryFileTime,
  isAbyssalTimerAnchored,
  restoreAbyssalTimerDeadlineAfterRestart,
  refreshAbyssalRunArtifactExpiryAtTimerAnchor,
  anchorAbyssalTimerAtExpiryNotification,
  getAbyssalContentID,
  resolveAbyssalCacheObjectiveState,
  buildAbyssalDungeonTrackingState,
  refreshAbyssalDungeonTrackingState,
  sendAbyssalExpiryDurationNotification,
  sendAbyssalContentFinishedNotification,
  sendAbyssalDungeonExitNotification,
  sendAbyssalLocationExitNotification,
  markAbyssalDungeonRoomWithoutGenericNotification,
} = (0, scope.createAbyssalDungeonNotifications)({
  get FILETIME_TICKS_PER_MS() { return scope.FILETIME_TICKS_PER_MS; },
  get FILETIME_UNIX_EPOCH_OFFSET() { return scope.FILETIME_UNIX_EPOCH_OFFSET; },
  getDependencies: (...args) => (0, scope.getDependencies)(...args),
  cloneValue: (...args) => (0, scope.cloneValue)(...args),
  resolvePlaceholderDurationMs: (...args) => (0, scope.resolvePlaceholderDurationMs)(...args),
  buildPlaceholderRoomState: (...args) => (0, scope.buildPlaceholderRoomState)(...args),
  listAbyssalRoomBootstrapEntityIDs: (...args) => (0, scope.listAbyssalRoomBootstrapEntityIDs)(...args),
  getPocketScene: (...args) => (0, scope.getPocketScene)(...args),
  listUniquePositiveInts: (...args) => (0, scope.listUniquePositiveInts)(...args),
  getActivePocketStateByInstanceID: (...args) => (0, scope.getActivePocketStateByInstanceID)(...args),
  updatePocketState: (...args) => (0, scope.updatePocketState)(...args),
  log: scope.log,
  getPlaceholderRoomEntry: (...args) => (0, scope.getPlaceholderRoomEntry)(...args),
  getContentProfile: (...args) => (0, scope.getContentProfile)(...args),
  resolveAbyssalEnvironmentRoomProfileForPocket: (...args) => (0, scope.resolveAbyssalEnvironmentRoomProfileForPocket)(...args),
  describeAbyssalEnvironmentSource: (...args) => (0, scope.describeAbyssalEnvironmentSource)(...args),
  normalizeLowerText: (...args) => (0, scope.normalizeLowerText)(...args),
  calculateAbyssalRemainingDuration: (...args) => (0, scope.calculateAbyssalRemainingDuration)(...args),
  updatePocketStateBestEffort: (...args) => (0, scope.updatePocketStateBestEffort)(...args),
  resolveAbyssalRunDeadlineMs: (...args) => (0, scope.resolveAbyssalRunDeadlineMs)(...args),
  classifyAbyssalRunDeadline: (...args) => (0, scope.classifyAbyssalRunDeadline)(...args),
  syncExpiredAbyssalPocketState: (...args) => (0, scope.syncExpiredAbyssalPocketState)(...args),
  get AbyssalPocketPersistenceError() { return scope.AbyssalPocketPersistenceError; },
  ensureAbyssalPocketPersistenceReady: (...args) => (0, scope.ensureAbyssalPocketPersistenceReady)(...args),
  logAbyssalEnvironmentPacketComparison: (...args) => (0, scope.logAbyssalEnvironmentPacketComparison)(...args),
  get ABYSSAL_TIMER_TYPE_NORMAL_PVE() { return scope.ABYSSAL_TIMER_TYPE_NORMAL_PVE; },
  getAbyssalEnvironmentNotificationState: (...args) => (0, scope.getAbyssalEnvironmentNotificationState)(...args),
  recordAbyssalEnvironmentSequenceEvent: (...args) => (0, scope.recordAbyssalEnvironmentSequenceEvent)(...args),
  resolveRoomOriginPosition: (...args) => (0, scope.resolveRoomOriginPosition)(...args),
});
  scope.toAbyssalExpiryFileTime = toAbyssalExpiryFileTime;
  scope.isAbyssalTimerAnchored = isAbyssalTimerAnchored;
  scope.restoreAbyssalTimerDeadlineAfterRestart = restoreAbyssalTimerDeadlineAfterRestart;
  scope.refreshAbyssalRunArtifactExpiryAtTimerAnchor = refreshAbyssalRunArtifactExpiryAtTimerAnchor;
  scope.anchorAbyssalTimerAtExpiryNotification = anchorAbyssalTimerAtExpiryNotification;
  scope.getAbyssalContentID = getAbyssalContentID;
  scope.resolveAbyssalCacheObjectiveState = resolveAbyssalCacheObjectiveState;
  scope.buildAbyssalDungeonTrackingState = buildAbyssalDungeonTrackingState;
  scope.refreshAbyssalDungeonTrackingState = refreshAbyssalDungeonTrackingState;
  scope.sendAbyssalExpiryDurationNotification = sendAbyssalExpiryDurationNotification;
  scope.sendAbyssalContentFinishedNotification = sendAbyssalContentFinishedNotification;
  scope.sendAbyssalDungeonExitNotification = sendAbyssalDungeonExitNotification;
  scope.sendAbyssalLocationExitNotification = sendAbyssalLocationExitNotification;
  scope.markAbyssalDungeonRoomWithoutGenericNotification = markAbyssalDungeonRoomWithoutGenericNotification;
}

function initializeManagerGroup5Binding6(scope) {
  const {
  sendOrQueueInitialAbyssalArrivalFx,
  flushPendingInitialAbyssalArrivalFx,
  schedulePostSetStateAbyssalArrivalFx,
} = (0, scope.createAbyssalArrivalEffects)({
  getDependencies: (...args) => (0, scope.getDependencies)(...args),
  buildPlaceholderRoomState: (...args) => (0, scope.buildPlaceholderRoomState)(...args),
  maybeSendAbyssalArrivalFx: (...args) => (0, scope.maybeSendAbyssalArrivalFx)(...args),
  updateAbyssalTransitionFxState: (...args) => (0, scope.updateAbyssalTransitionFxState)(...args),
  log: scope.log,
  cloneValue: (...args) => (0, scope.cloneValue)(...args),
  get ABYSSAL_BEYONCE_POST_SETSTATE_ARRIVAL_FX_DELAY_MS() { return scope.ABYSSAL_BEYONCE_POST_SETSTATE_ARRIVAL_FX_DELAY_MS; },
  updateAbyssalClientEnvironmentDeliveryState: (...args) => (0, scope.updateAbyssalClientEnvironmentDeliveryState)(...args),
  getActivePocketStateByInstanceID: (...args) => (0, scope.getActivePocketStateByInstanceID)(...args),
});
  scope.sendOrQueueInitialAbyssalArrivalFx = sendOrQueueInitialAbyssalArrivalFx;
  scope.flushPendingInitialAbyssalArrivalFx = flushPendingInitialAbyssalArrivalFx;
  scope.schedulePostSetStateAbyssalArrivalFx = schedulePostSetStateAbyssalArrivalFx;
}

function initializeManagerGroup5Binding7(scope) {
  const { buildPocketStateFromInstance } = (0, scope.createAbyssalRunReconstruction)({
  get ABYSSAL_RUNTIME_STATE_SCHEMA_VERSION() { return scope.ABYSSAL_RUNTIME_STATE_SCHEMA_VERSION; },
  cloneValue: (...args) => (0, scope.cloneValue)(...args),
  getObjectPosition: (...args) => (0, scope.getObjectPosition)(...args),
  normalizeVector: (...args) => (0, scope.normalizeVector)(...args),
  getContentProfile: (...args) => (0, scope.getContentProfile)(...args),
  rehydratePersistedAbyssalContentProfile: (...args) => (0, scope.rehydratePersistedAbyssalContentProfile)(...args),
  isPersistedAbyssalContentProfileReference: (...args) => (0, scope.isPersistedAbyssalContentProfileReference)(...args),
  buildAbyssalWeatherState: (...args) => (0, scope.buildAbyssalWeatherState)(...args),
  normalizeT0DarkLayoutSelectionState: (...args) => (0, scope.normalizeT0DarkLayoutSelectionState)(...args),
  normalizeLowerText: (...args) => (0, scope.normalizeLowerText)(...args),
  normalizeAbyssalBaseRoomLayoutSelectionState: (...args) => (0, scope.normalizeAbyssalBaseRoomLayoutSelectionState)(...args),
  buildPocketStateForCurrentRoom: (...args) => (0, scope.buildPocketStateForCurrentRoom)(...args),
  get ABYSSAL_PARTICIPANT_ROSTER_SCHEMA_VERSION() { return scope.ABYSSAL_PARTICIPANT_ROSTER_SCHEMA_VERSION; },
  normalizeAbyssalParticipantRoster: (...args) => (0, scope.normalizeAbyssalParticipantRoster)(...args),
  listUniquePositiveInts: (...args) => (0, scope.listUniquePositiveInts)(...args),
  normalizeDirection: (...args) => (0, scope.normalizeDirection)(...args),
  toReal: (...args) => (0, scope.toReal)(...args),
  buildPocketSiteKey: (...args) => (0, scope.buildPocketSiteKey)(...args),
  buildPlaceholderRoomState: (...args) => (0, scope.buildPlaceholderRoomState)(...args),
  getNpcRuntimePolicy: (...args) => (0, scope.getNpcRuntimePolicy)(...args),
  get PLACEHOLDER_POCKET_MODE() { return scope.PLACEHOLDER_POCKET_MODE; },
  get PLACEHOLDER_POCKET_ISOLATION() { return scope.PLACEHOLDER_POCKET_ISOLATION; },
  normalizeAbyssalSceneMode: (...args) => (0, scope.normalizeAbyssalSceneMode)(...args),
});
  scope.buildPocketStateFromInstance = buildPocketStateFromInstance;
}

function initializeManagerGroup5Binding8(scope) {
  const {
  persistRegisteredAbyssalPocketState,
  ensureAbyssalPocketPersistenceReady,
  mergeProtectedAbyssalParticipantDestructionOperations,
  registerPocketInternal,
  registerPocket,
  registerPocketBestEffort,
  evaluateAbyssalPocketIdentityCompatibility,
  ensureAbyssalPocketDurablyAdopted,
} = (0, scope.createAbyssalRunRegistration)({
  getDependencies: (...args) => (0, scope.getDependencies)(...args),
  buildPersistedAbyssalRuntimeState: (...args) => (0, scope.buildPersistedAbyssalRuntimeState)(...args),
  verifyPersistedAbyssalPocketState: (...args) => (0, scope.verifyPersistedAbyssalPocketState)(...args),
  get ABYSSAL_POCKET_PERSISTENCE_ERROR() { return scope.ABYSSAL_POCKET_PERSISTENCE_ERROR; },
  log: scope.log,
  getActivePocketStateByInstanceID: (...args) => (0, scope.getActivePocketStateByInstanceID)(...args),
  getAbyssalParticipantDestructionOperationsByCharacterID: (...args) => (0, scope.getAbyssalParticipantDestructionOperationsByCharacterID)(...args),
  evaluateAbyssalParticipantDestructionOperationTransition: (...args) => (0, scope.evaluateAbyssalParticipantDestructionOperationTransition)(...args),
  logRejectedAbyssalParticipantDestructionTransition: (...args) => (0, scope.logRejectedAbyssalParticipantDestructionTransition)(...args),
  cloneValue: (...args) => (0, scope.cloneValue)(...args),
  normalizeAbyssalParticipantDestructionOperation: (...args) => (0, scope.normalizeAbyssalParticipantDestructionOperation)(...args),
  get ABYSSAL_POCKET_MUTATION_DURABILITY() { return scope.ABYSSAL_POCKET_MUTATION_DURABILITY; },
  get ABYSSAL_PARTICIPANT_ROSTER_SCHEMA_VERSION() { return scope.ABYSSAL_PARTICIPANT_ROSTER_SCHEMA_VERSION; },
  normalizeAbyssalParticipantRoster: (...args) => (0, scope.normalizeAbyssalParticipantRoster)(...args),
  listUniquePositiveInts: (...args) => (0, scope.listUniquePositiveInts)(...args),
  get PLACEHOLDER_POCKET_MODE() { return scope.PLACEHOLDER_POCKET_MODE; },
  get PLACEHOLDER_POCKET_ISOLATION() { return scope.PLACEHOLDER_POCKET_ISOLATION; },
  normalizeAbyssalRunOutcome: (...args) => (0, scope.normalizeAbyssalRunOutcome)(...args),
  evaluateAbyssalRunOutcomeTransition: (...args) => (0, scope.evaluateAbyssalRunOutcomeTransition)(...args),
  logRejectedAbyssalRunOutcomeTransition: (...args) => (0, scope.logRejectedAbyssalRunOutcomeTransition)(...args),
  isKnownAbyssalRunOutcome: (...args) => (0, scope.isKnownAbyssalRunOutcome)(...args),
  get ABYSSAL_PARTICIPANT_DESTRUCTION_MAP_SCHEMA_VERSION() { return scope.ABYSSAL_PARTICIPANT_DESTRUCTION_MAP_SCHEMA_VERSION; },
  mergeProtectedAbyssalRewardArtifactDestructionOperations: (...args) => (0, scope.mergeProtectedAbyssalRewardArtifactDestructionOperations)(...args),
  get AbyssalRunRegistryError() { return scope.AbyssalRunRegistryError; },
  resolveAbyssalSceneModeState: (...args) => (0, scope.resolveAbyssalSceneModeState)(...args),
  get ABYSSAL_SCENE_MODE_ISOLATED() { return scope.ABYSSAL_SCENE_MODE_ISOLATED; },
  reserveAbyssalSpatialSlotForPocketState: (...args) => (0, scope.reserveAbyssalSpatialSlotForPocketState)(...args),
  formatVectorForLog: (...args) => (0, scope.formatVectorForLog)(...args),
  logAmbiguousAbyssalSceneMode: (...args) => (0, scope.logAmbiguousAbyssalSceneMode)(...args),
  getAbyssalPocketPersistenceVersion: (...args) => (0, scope.getAbyssalPocketPersistenceVersion)(...args),
  buildAbyssalPocketMutationSignature: (...args) => (0, scope.buildAbyssalPocketMutationSignature)(...args),
  registerAbyssalPocketInMemory: (...args) => (0, scope.registerAbyssalPocketInMemory)(...args),
  get AbyssalPocketPersistenceError() { return scope.AbyssalPocketPersistenceError; },
  buildPocketStateFromInstance: (...args) => (0, scope.buildPocketStateFromInstance)(...args),
  setPersistenceFailure: (...args) => scope.abyssalRunWorkStore.setPersistenceFailure(...args),
  hasPersistenceFailure: (...args) => scope.abyssalRunWorkStore.hasPersistenceFailure(...args),
  getPersistedStateSignature: (...args) => scope.abyssalRunWorkStore.getPersistedStateSignature(...args),
  deletePersistenceFailure: (...args) => scope.abyssalRunWorkStore.deletePersistenceFailure(...args),
  setPersistedStateSignature: (...args) => scope.abyssalRunWorkStore.setPersistedStateSignature(...args),
  deletePersistedStateSignature: (...args) => scope.abyssalRunWorkStore.deletePersistedStateSignature(...args),
  getPersistenceFailure: (...args) => scope.abyssalRunWorkStore.getPersistenceFailure(...args),
  recordWrite: (...args) => scope.abyssalMaintenanceState.recordWrite(...args),
  getRegisteredRun: (...args) => scope.activeAbyssalRunRegistry.getByInstanceID(...args),
  validateRegistration: (...args) => scope.activeAbyssalRunRegistry.validateRegistration(...args),
  replaceRegisteredRun: (...args) => scope.activeAbyssalRunRegistry.replace(...args),
  registerRun: (...args) => scope.activeAbyssalRunRegistry.register(...args),
  releaseSpatialSlot: (...args) => scope.abyssalHostSlotAllocator.release(...args),
});
  scope.persistRegisteredAbyssalPocketState = persistRegisteredAbyssalPocketState;
  scope.ensureAbyssalPocketPersistenceReady = ensureAbyssalPocketPersistenceReady;
  scope.mergeProtectedAbyssalParticipantDestructionOperations = mergeProtectedAbyssalParticipantDestructionOperations;
  scope.registerPocketInternal = registerPocketInternal;
  scope.registerPocket = registerPocket;
  scope.registerPocketBestEffort = registerPocketBestEffort;
  scope.evaluateAbyssalPocketIdentityCompatibility = evaluateAbyssalPocketIdentityCompatibility;
  scope.ensureAbyssalPocketDurablyAdopted = ensureAbyssalPocketDurablyAdopted;
}

function initializeManagerGroup5Binding9(scope) {
  const {
  buildAbyssalTransitionFxProfile,
  updateAbyssalTransitionFxState,
  getAbyssalParticipantTransitionFxState,
  updateAbyssalParticipantTransitionFxState,
  buildAbyssalTransitionFxStatus,
  resolveAbyssalTransitionDurationMs,
  resolveAbyssalClientDungeonIdentifier,
  buildAbyssalTransitionFxOptions,
  maybeSendAbyssalArrivalFx,
  resolveAbyssalTransitionFxParticipants,
  maybeSendAbyssalTransitionFx,
} = (0, scope.createAbyssalTransitionEffects)({
  getDependencies: (...args) => (0, scope.getDependencies)(...args),
  getContentProfile: (...args) => (0, scope.getContentProfile)(...args),
  resolveAbyssalTraceProfile: (...args) => (0, scope.resolveAbyssalTraceProfile)(...args),
  resolveAbyssalTraceTransitionPresentation: (...args) => (0, scope.resolveAbyssalTraceTransitionPresentation)(...args),
  resolveTransitionProfileSetForLayout: (...args) => (0, scope.resolveTransitionProfileSetForLayout)(...args),
  get TRANSITION_POLICY_EXPERIMENTAL() { return scope.TRANSITION_POLICY_EXPERIMENTAL; },
  get TRANSITION_POLICY_AUTHORITATIVE_CAPTURED() { return scope.TRANSITION_POLICY_AUTHORITATIVE_CAPTURED; },
  resolveTransitionProfile: (...args) => (0, scope.resolveTransitionProfile)(...args),
  get ABYSSAL_TRANSITION_FX_PROFILE() { return scope.ABYSSAL_TRANSITION_FX_PROFILE; },
  resolveAbyssalCalmDarkProbeEffect: (...args) => (0, scope.resolveAbyssalCalmDarkProbeEffect)(...args),
  isAbyssalVisualFxContentProfile: (...args) => (0, scope.isAbyssalVisualFxContentProfile)(...args),
  get ABYSSAL_SHIP_HIDE_SUPPORT() { return scope.ABYSSAL_SHIP_HIDE_SUPPORT; },
  updatePocketState: (...args) => (0, scope.updatePocketState)(...args),
  cloneValue: (...args) => (0, scope.cloneValue)(...args),
  getCharacterID: (...args) => (0, scope.getCharacterID)(...args),
  getActivePocketStateByInstanceID: (...args) => (0, scope.getActivePocketStateByInstanceID)(...args),
  get SHARED_ABYSSAL_ENTRANCE_TRANSITION_DELAY_MS() { return scope.SHARED_ABYSSAL_ENTRANCE_TRANSITION_DELAY_MS; },
  log: scope.log,
  get ABYSSAL_PARTICIPANT_STATUS() { return scope.ABYSSAL_PARTICIPANT_STATUS; },
  normalizeAbyssalParticipantRoster: (...args) => (0, scope.normalizeAbyssalParticipantRoster)(...args),
  resolveAbyssalRosterParticipantSession: (...args) => (0, scope.resolveAbyssalRosterParticipantSession)(...args),
  getActiveTraceState: (...args) => (0, scope.getActiveTraceState)(...args),
  getAbyssalTracePublicationReceipt: (...args) => (0, scope.getAbyssalTracePublicationReceipt)(...args),
  transitionSourceTraceState: (...args) => (0, scope.transitionSourceTraceState)(...args),
  get ABYSSAL_TRACE_LIFECYCLE_PHASE() { return scope.ABYSSAL_TRACE_LIFECYCLE_PHASE; },
});
  scope.buildAbyssalTransitionFxProfile = buildAbyssalTransitionFxProfile;
  scope.updateAbyssalTransitionFxState = updateAbyssalTransitionFxState;
  scope.getAbyssalParticipantTransitionFxState = getAbyssalParticipantTransitionFxState;
  scope.updateAbyssalParticipantTransitionFxState = updateAbyssalParticipantTransitionFxState;
  scope.buildAbyssalTransitionFxStatus = buildAbyssalTransitionFxStatus;
  scope.resolveAbyssalTransitionDurationMs = resolveAbyssalTransitionDurationMs;
  scope.resolveAbyssalClientDungeonIdentifier = resolveAbyssalClientDungeonIdentifier;
  scope.buildAbyssalTransitionFxOptions = buildAbyssalTransitionFxOptions;
  scope.maybeSendAbyssalArrivalFx = maybeSendAbyssalArrivalFx;
  scope.resolveAbyssalTransitionFxParticipants = resolveAbyssalTransitionFxParticipants;
  scope.maybeSendAbyssalTransitionFx = maybeSendAbyssalTransitionFx;
}

function initializeManagerGroup5Binding10(scope) {
  const {
  resolveAbyssalRosterParticipantSession,
  moveOtherAbyssalParticipantsToRoom,
  collectConduitAnimationLookupDiagnostics,
  resolveCurrentRoomConduitSceneEntity,
  markCurrentRoomConduitOpen,
} = (0, scope.createAbyssalRoomProgression)({
  getDependencies: (...args) => (0, scope.getDependencies)(...args),
  getCharacterID: (...args) => (0, scope.getCharacterID)(...args),
  getPocketScene: (...args) => (0, scope.getPocketScene)(...args),
  buildAbyssalSceneDescriptor: (...args) => (0, scope.buildAbyssalSceneDescriptor)(...args),
  getObjectPosition: (...args) => (0, scope.getObjectPosition)(...args),
  buildAbyssalParticipantRoomScopeMetadata: (...args) => (0, scope.buildAbyssalParticipantRoomScopeMetadata)(...args),
  getActivePocketStateByInstanceID: (...args) => (0, scope.getActivePocketStateByInstanceID)(...args),
  normalizeAbyssalParticipantRoster: (...args) => (0, scope.normalizeAbyssalParticipantRoster)(...args),
  get ABYSSAL_PARTICIPANT_STATUS() { return scope.ABYSSAL_PARTICIPANT_STATUS; },
  addVectors: (...args) => (0, scope.addVectors)(...args),
  cloneValue: (...args) => (0, scope.cloneValue)(...args),
  setAbyssalSessionState: (...args) => (0, scope.setAbyssalSessionState)(...args),
  applyAbyssalParticipantRoomScopeMetadata: (...args) => (0, scope.applyAbyssalParticipantRoomScopeMetadata)(...args),
  syncInventoryChanges: (...args) => (0, scope.syncInventoryChanges)(...args),
  usesAuthoredAbyssalEnvironmentNotification: (...args) => (0, scope.usesAuthoredAbyssalEnvironmentNotification)(...args),
  queueAbyssalClientEnvironmentDelivery: (...args) => (0, scope.queueAbyssalClientEnvironmentDelivery)(...args),
  upsertAbyssalParticipantRosterEntry: (...args) => (0, scope.upsertAbyssalParticipantRosterEntry)(...args),
  commitPocketStateDurably: (...args) => (0, scope.commitPocketStateDurably)(...args),
  get TYPE_ABYSSAL_TRANSFER_CONDUIT() { return scope.TYPE_ABYSSAL_TRANSFER_CONDUIT; },
  get TYPE_ABYSSAL_ORIGIN_CONDUIT() { return scope.TYPE_ABYSSAL_ORIGIN_CONDUIT; },
  buildPlaceholderRoomState: (...args) => (0, scope.buildPlaceholderRoomState)(...args),
  getPlaceholderRoomEntry: (...args) => (0, scope.getPlaceholderRoomEntry)(...args),
  log: scope.log,
  parseCustomInfo: (...args) => (0, scope.parseCustomInfo)(...args),
  applyAbyssalGatePresentationState: (...args) => (0, scope.applyAbyssalGatePresentationState)(...args),
  setPlaceholderRoomEntry: (...args) => (0, scope.setPlaceholderRoomEntry)(...args),
  updatePocketState: (...args) => (0, scope.updatePocketState)(...args),
  buildPocketStateForCurrentRoom: (...args) => (0, scope.buildPocketStateForCurrentRoom)(...args),
});
  scope.resolveAbyssalRosterParticipantSession = resolveAbyssalRosterParticipantSession;
  scope.moveOtherAbyssalParticipantsToRoom = moveOtherAbyssalParticipantsToRoom;
  scope.collectConduitAnimationLookupDiagnostics = collectConduitAnimationLookupDiagnostics;
  scope.resolveCurrentRoomConduitSceneEntity = resolveCurrentRoomConduitSceneEntity;
  scope.markCurrentRoomConduitOpen = markCurrentRoomConduitOpen;
}

function initializeManagerGroup5Binding11(scope) {
  const {
  resolveExactAbyssalRunRoomScope,
  listAbyssalPlayerObjectAuthoritySources,
  inspectExactAbyssalSourceRoomObjectScope,
  inspectAbyssalPlayerCreatedObjectAuthority,
  isRetainedAbyssalPlayerCompanion,
  recordReferencesActiveAbyssalCompanionController,
  buildAbandonedAbyssalCompanionInventoryState,
  abandonExactAbyssalSourceRoomPlayerCompanions,
  resolveAbyssalRetirablePlayerObjectKind,
  retireExactAbyssalSourceRoomPlayerObjects,
} = (0, scope.createAbyssalPlayerObjectCleanup)({
  resolveEntityInteractionScope: (...args) => (0, scope.resolveEntityInteractionScope)(...args),
  parseCustomInfo: (...args) => (0, scope.parseCustomInfo)(...args),
  listPocketCleanupAnchors: (...args) => (0, scope.listPocketCleanupAnchors)(...args),
  inspectResidualPocketItemAuthority: (...args) => (0, scope.inspectResidualPocketItemAuthority)(...args),
  normalizeLowerText: (...args) => (0, scope.normalizeLowerText)(...args),
  get CATEGORY_DRONE() { return scope.CATEGORY_DRONE; },
  get CATEGORY_FIGHTER() { return scope.CATEGORY_FIGHTER; },
  get CATEGORY_DEPLOYABLE() { return scope.CATEGORY_DEPLOYABLE; },
  get GROUP_WARP_DISRUPTION_PROBE() { return scope.GROUP_WARP_DISRUPTION_PROBE; },
  getPocketScene: (...args) => (0, scope.getPocketScene)(...args),
  log: scope.log,
  buildTrackedPocketArtifactIDSet: (...args) => (0, scope.buildTrackedPocketArtifactIDSet)(...args),
  listAbyssalRoomBootstrapEntityIDs: (...args) => (0, scope.listAbyssalRoomBootstrapEntityIDs)(...args),
  destroyResidualPocketSpaceItem: (...args) => (0, scope.destroyResidualPocketSpaceItem)(...args),
});
  scope.resolveExactAbyssalRunRoomScope = resolveExactAbyssalRunRoomScope;
  scope.listAbyssalPlayerObjectAuthoritySources = listAbyssalPlayerObjectAuthoritySources;
  scope.inspectExactAbyssalSourceRoomObjectScope = inspectExactAbyssalSourceRoomObjectScope;
  scope.inspectAbyssalPlayerCreatedObjectAuthority = inspectAbyssalPlayerCreatedObjectAuthority;
  scope.isRetainedAbyssalPlayerCompanion = isRetainedAbyssalPlayerCompanion;
  scope.recordReferencesActiveAbyssalCompanionController = recordReferencesActiveAbyssalCompanionController;
  scope.buildAbandonedAbyssalCompanionInventoryState = buildAbandonedAbyssalCompanionInventoryState;
  scope.abandonExactAbyssalSourceRoomPlayerCompanions = abandonExactAbyssalSourceRoomPlayerCompanions;
  scope.resolveAbyssalRetirablePlayerObjectKind = resolveAbyssalRetirablePlayerObjectKind;
  scope.retireExactAbyssalSourceRoomPlayerObjects = retireExactAbyssalSourceRoomPlayerObjects;
}

function bindAbyssalManagerRuntimeGroup5Operations(scope) {

}

function initializeAbyssalManagerRuntimeGroup5Part1(scope) {
  initializeManagerGroup5Binding1(scope);
  initializeManagerGroup5Binding2(scope);
  initializeManagerGroup5Binding3(scope);
  initializeManagerGroup5Binding4(scope);
  initializeManagerGroup5Binding5(scope);
  initializeManagerGroup5Binding6(scope);
  initializeManagerGroup5Binding7(scope);
  initializeManagerGroup5Binding8(scope);
  initializeManagerGroup5Binding9(scope);
  initializeManagerGroup5Binding10(scope);
  initializeManagerGroup5Binding11(scope);
}

function initializeAbyssalManagerRuntimeGroup5(scope) {
  initializeAbyssalManagerRuntimeGroup5Part1(scope);
}

module.exports = {
  bindAbyssalManagerRuntimeGroup5Operations,
  initializeAbyssalManagerRuntimeGroup5,
};
