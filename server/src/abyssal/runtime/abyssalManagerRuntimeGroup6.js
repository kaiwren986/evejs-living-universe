"use strict";

function initializeManagerGroup6Binding1(scope) {
  const {
  classifyAbyssalFilamentCompensationFailure,
  persistAbyssalFilamentCompensationClaim,
  readAbyssalFilamentCompensationClaim,
  resolveAbyssalFilamentCompensationSource,
  buildAbyssalFilamentCompensationTraceIdentity,
  abyssalFilamentCompensationTupleMatches,
  stageAbyssalFilamentCompensationClaim,
  isReachableAbyssalCompensationStation,
  resolveAbyssalFilamentCompensationDestination,
  abyssalFilamentCompensationDestinationMatches,
  abyssalFilamentCompensationReceiptMatchesClaim,
  markAbyssalFilamentCompensationTraceInvalidated,
  completeAbyssalFilamentCompensationClaim,
  settleAbyssalFilamentCompensationClaim,
  invalidateFailedAbyssalDeploymentTrace,
  ensureAbyssalFilamentCompensationTraceInvalidated,
  reconcileAbyssalFilamentCompensationsForSession,
  compensateFailedAbyssalDeployment,
} = (0, scope.createAbyssalFilamentCompensation)({
  getDependencies: (...args) => (0, scope.getDependencies)(...args),
  get ABYSSAL_FILAMENT_COMPENSATION_FAILURE_CLASS() { return scope.ABYSSAL_FILAMENT_COMPENSATION_FAILURE_CLASS; },
  isPostEntryForfeitReason: reason => scope.ABYSSAL_POST_ENTRY_FILAMENT_FORFEIT_REASONS.has(reason),
  get ABYSSAL_FILAMENT_COMPENSATION_STATE() { return scope.ABYSSAL_FILAMENT_COMPENSATION_STATE; },
  cloneValue: (...args) => (0, scope.cloneValue)(...args),
  normalizeLowerText: (...args) => (0, scope.normalizeLowerText)(...args),
  buildAbyssalTraceDeploymentToken: (...args) => (0, scope.buildAbyssalTraceDeploymentToken)(...args),
  hasCommittedAbyssalFilamentConsumption: (...args) => (0, scope.hasCommittedAbyssalFilamentConsumption)(...args),
  isCompleteAbyssalTracePublicationReceipt: (...args) => (0, scope.isCompleteAbyssalTracePublicationReceipt)(...args),
  getSessionContext: (...args) => (0, scope.getSessionContext)(...args),
  getCategoryID: (...args) => (0, scope.getCategoryID)(...args),
  get CATEGORY_SHIP() { return scope.CATEGORY_SHIP; },
  listUniquePositiveInts: (...args) => (0, scope.listUniquePositiveInts)(...args),
  resolveTypeRecord: (...args) => (0, scope.resolveTypeRecord)(...args),
  syncInventoryChanges: (...args) => (0, scope.syncInventoryChanges)(...args),
  log: scope.log,
  destroyPlaceholderTrace: (...args) => (0, scope.destroyPlaceholderTrace)(...args),
  get ABYSSAL_TRACE_LIFECYCLE_PHASE() { return scope.ABYSSAL_TRACE_LIFECYCLE_PHASE; },
  persistTraceState: (...args) => (0, scope.persistTraceState)(...args),
  unregisterTrace: (...args) => (0, scope.unregisterTrace)(...args),
  readTraceStateFromItem: (...args) => (0, scope.readTraceStateFromItem)(...args),
  normalizeAbyssalTraceLifecyclePhase: (...args) => (0, scope.normalizeAbyssalTraceLifecyclePhase)(...args),
  getCharacterID: (...args) => (0, scope.getCharacterID)(...args),
});
  scope.classifyAbyssalFilamentCompensationFailure = classifyAbyssalFilamentCompensationFailure;
  scope.persistAbyssalFilamentCompensationClaim = persistAbyssalFilamentCompensationClaim;
  scope.readAbyssalFilamentCompensationClaim = readAbyssalFilamentCompensationClaim;
  scope.resolveAbyssalFilamentCompensationSource = resolveAbyssalFilamentCompensationSource;
  scope.buildAbyssalFilamentCompensationTraceIdentity = buildAbyssalFilamentCompensationTraceIdentity;
  scope.abyssalFilamentCompensationTupleMatches = abyssalFilamentCompensationTupleMatches;
  scope.stageAbyssalFilamentCompensationClaim = stageAbyssalFilamentCompensationClaim;
  scope.isReachableAbyssalCompensationStation = isReachableAbyssalCompensationStation;
  scope.resolveAbyssalFilamentCompensationDestination = resolveAbyssalFilamentCompensationDestination;
  scope.abyssalFilamentCompensationDestinationMatches = abyssalFilamentCompensationDestinationMatches;
  scope.abyssalFilamentCompensationReceiptMatchesClaim = abyssalFilamentCompensationReceiptMatchesClaim;
  scope.markAbyssalFilamentCompensationTraceInvalidated = markAbyssalFilamentCompensationTraceInvalidated;
  scope.completeAbyssalFilamentCompensationClaim = completeAbyssalFilamentCompensationClaim;
  scope.settleAbyssalFilamentCompensationClaim = settleAbyssalFilamentCompensationClaim;
  scope.invalidateFailedAbyssalDeploymentTrace = invalidateFailedAbyssalDeploymentTrace;
  scope.ensureAbyssalFilamentCompensationTraceInvalidated = ensureAbyssalFilamentCompensationTraceInvalidated;
  scope.reconcileAbyssalFilamentCompensationsForSession = reconcileAbyssalFilamentCompensationsForSession;
  scope.compensateFailedAbyssalDeployment = compensateFailedAbyssalDeployment;
}

function initializeManagerGroup6Binding2(scope) {
  const {
  buildAbyssalSuspectFlagResult,
  getAbyssalSuspectTimerExpiresAtMs,
  applyAbyssalSuspectFlagIfRequired,
  recordAndLogAbyssalSuspectFlagOutcome,
  isAbyssalSuspectReturnPending,
  buildAbyssalSuspectReturnValidation,
  persistAbyssalSuspectReturnTraceState,
  recordAndLogAbyssalSuspectReturnOutcome,
  doesCrimewatchStateSatisfyPersistedAbyssalSuspectReturn,
  settleAbyssalSuspectOnReturn,
  settlePendingAbyssalSuspectReturnForSession,
} = (0, scope.createAbyssalSuspectEffects)({
  getDependencies: (...args) => (0, scope.getDependencies)(...args),
  toReal: (...args) => (0, scope.toReal)(...args),
  get ABYSSAL_SUSPECT_RETURN_DURATION_MS() { return scope.ABYSSAL_SUSPECT_RETURN_DURATION_MS; },
  recordAuditEvent: (...args) => (0, scope.recordAuditEvent)(...args),
  log: scope.log,
  getAbyssalParticipantReturnObligationsByCharacterID: (...args) => (0, scope.getAbyssalParticipantReturnObligationsByCharacterID)(...args),
  normalizeLowerText: (...args) => (0, scope.normalizeLowerText)(...args),
  cloneValue: (...args) => (0, scope.cloneValue)(...args),
  getContentProfile: (...args) => (0, scope.getContentProfile)(...args),
  persistAbyssalParticipantReturnObligation: (...args) => (0, scope.persistAbyssalParticipantReturnObligation)(...args),
  getActivePocketStateByInstanceID: (...args) => (0, scope.getActivePocketStateByInstanceID)(...args),
  updatePocketState: (...args) => (0, scope.updatePocketState)(...args),
  ensureAbyssalPocketPersistenceReady: (...args) => (0, scope.ensureAbyssalPocketPersistenceReady)(...args),
  getActiveTraceState: (...args) => (0, scope.getActiveTraceState)(...args),
  finalizeAbyssalReturnedTracePostCommitEffects: (...args) => (0, scope.finalizeAbyssalReturnedTracePostCommitEffects)(...args),
  getSessionContext: (...args) => (0, scope.getSessionContext)(...args),
  listTraces: (...args) => scope.abyssalTraceStateRegistry.listTraces(...args),
  readTraceStateFromItem: (...args) => (0, scope.readTraceStateFromItem)(...args),
  getAbyssalParticipantReturnObligation: (...args) => (0, scope.getAbyssalParticipantReturnObligation)(...args),
  normalizeAbyssalTraceLifecyclePhase: (...args) => (0, scope.normalizeAbyssalTraceLifecyclePhase)(...args),
  get ABYSSAL_TRACE_LIFECYCLE_PHASE() { return scope.ABYSSAL_TRACE_LIFECYCLE_PHASE; },
});
  scope.buildAbyssalSuspectFlagResult = buildAbyssalSuspectFlagResult;
  scope.getAbyssalSuspectTimerExpiresAtMs = getAbyssalSuspectTimerExpiresAtMs;
  scope.applyAbyssalSuspectFlagIfRequired = applyAbyssalSuspectFlagIfRequired;
  scope.recordAndLogAbyssalSuspectFlagOutcome = recordAndLogAbyssalSuspectFlagOutcome;
  scope.isAbyssalSuspectReturnPending = isAbyssalSuspectReturnPending;
  scope.buildAbyssalSuspectReturnValidation = buildAbyssalSuspectReturnValidation;
  scope.persistAbyssalSuspectReturnTraceState = persistAbyssalSuspectReturnTraceState;
  scope.recordAndLogAbyssalSuspectReturnOutcome = recordAndLogAbyssalSuspectReturnOutcome;
  scope.doesCrimewatchStateSatisfyPersistedAbyssalSuspectReturn = doesCrimewatchStateSatisfyPersistedAbyssalSuspectReturn;
  scope.settleAbyssalSuspectOnReturn = settleAbyssalSuspectOnReturn;
  scope.settlePendingAbyssalSuspectReturnForSession = settlePendingAbyssalSuspectReturnForSession;
}

function initializeManagerGroup6Binding3(scope) {
  const {
  resolveAbyssalReturnedTraceProtectionDeadlineMs,
  isAbyssalReturnProtectionPending,
  findAbyssalReturnProtectionTraceState,
  persistAbyssalReturnProtectionTraceState,
  stageAbyssalReturnProtectionObligation,
  finalizeAbyssalReturnedTracePostCommitEffects,
  settleAbyssalReturnProtectionObligation,
  settlePendingAbyssalReturnProtectionForSession,
  grantAbyssalReturnProtectionAfterAttach,
} = (0, scope.createAbyssalReturnProtection)({
  getDependencies: (...args) => (0, scope.getDependencies)(...args),
  getAbyssalParticipantReturnObligationsByCharacterID: (...args) => (0, scope.getAbyssalParticipantReturnObligationsByCharacterID)(...args),
  normalizeLowerText: (...args) => (0, scope.normalizeLowerText)(...args),
  cloneValue: (...args) => (0, scope.cloneValue)(...args),
  getTrace: (...args) => scope.abyssalTraceStateRegistry.getTrace(...args),
  listTraces: (...args) => scope.abyssalTraceStateRegistry.listTraces(...args),
  readTraceStateFromItem: (...args) => (0, scope.readTraceStateFromItem)(...args),
  persistAbyssalParticipantReturnObligation: (...args) => (0, scope.persistAbyssalParticipantReturnObligation)(...args),
  resolveConfiguredAbyssalReturnProtectionDurationMs: (...args) => (0, scope.resolveConfiguredAbyssalReturnProtectionDurationMs)(...args),
  getAbyssalParticipantReturnObligation: (...args) => (0, scope.getAbyssalParticipantReturnObligation)(...args),
  normalizeAbyssalTraceLifecyclePhase: (...args) => (0, scope.normalizeAbyssalTraceLifecyclePhase)(...args),
  get ABYSSAL_TRACE_LIFECYCLE_PHASE() { return scope.ABYSSAL_TRACE_LIFECYCLE_PHASE; },
  isAbyssalSuspectReturnPending: (...args) => (0, scope.isAbyssalSuspectReturnPending)(...args),
  resolveAbyssalTraceProfile: (...args) => (0, scope.resolveAbyssalTraceProfile)(...args),
  scheduleSourceTraceRemoval: (...args) => (0, scope.scheduleSourceTraceRemoval)(...args),
  removeOwnedSourceTrace: (...args) => (0, scope.removeOwnedSourceTrace)(...args),
  getCharacterID: (...args) => (0, scope.getCharacterID)(...args),
  getSessionContext: (...args) => (0, scope.getSessionContext)(...args),
});
  scope.resolveAbyssalReturnedTraceProtectionDeadlineMs = resolveAbyssalReturnedTraceProtectionDeadlineMs;
  scope.isAbyssalReturnProtectionPending = isAbyssalReturnProtectionPending;
  scope.findAbyssalReturnProtectionTraceState = findAbyssalReturnProtectionTraceState;
  scope.persistAbyssalReturnProtectionTraceState = persistAbyssalReturnProtectionTraceState;
  scope.stageAbyssalReturnProtectionObligation = stageAbyssalReturnProtectionObligation;
  scope.finalizeAbyssalReturnedTracePostCommitEffects = finalizeAbyssalReturnedTracePostCommitEffects;
  scope.settleAbyssalReturnProtectionObligation = settleAbyssalReturnProtectionObligation;
  scope.settlePendingAbyssalReturnProtectionForSession = settlePendingAbyssalReturnProtectionForSession;
  scope.grantAbyssalReturnProtectionAfterAttach = grantAbyssalReturnProtectionAfterAttach;
}

function initializeManagerGroup6Binding4(scope) {
  const {
  runPlaceholderPocketMaintenance,
  schedulePlaceholderPocketMaintenance,
} = (0, scope.createAbyssalRunMaintenance)({
  getDependencies: (...args) => (0, scope.getDependencies)(...args),
  resolveEffectiveAbyssalMaintenanceNowMs: (...args) => (0, scope.resolveEffectiveAbyssalMaintenanceNowMs)(...args),
  hasImmutableAbyssalRunOutcome: (...args) => (0, scope.hasImmutableAbyssalRunOutcome)(...args),
  hasPendingAbyssalTerminalCleanup: (...args) => (0, scope.hasPendingAbyssalTerminalCleanup)(...args),
  hasUnresolvedAbyssalRecoveryObligation: (...args) => (0, scope.hasUnresolvedAbyssalRecoveryObligation)(...args),
  buildPocketStateForCurrentRoom: (...args) => (0, scope.buildPocketStateForCurrentRoom)(...args),
  cloneValue: (...args) => (0, scope.cloneValue)(...args),
  reconcilePendingAbyssalEntryRecovery: (...args) => (0, scope.reconcilePendingAbyssalEntryRecovery)(...args),
  hasTerminalFailureOutcome: (...args) => (0, scope.hasTerminalFailureOutcome)(...args),
  syncExpiredAbyssalPocketState: (...args) => (0, scope.syncExpiredAbyssalPocketState)(...args),
  shouldDeferAbyssalWeatherRemovalMaintenanceRetry: (...args) => (0, scope.shouldDeferAbyssalWeatherRemovalMaintenanceRetry)(...args),
  cleanupAbyssalRun: (...args) => (0, scope.cleanupAbyssalRun)(...args),
  resolveAbyssalRecoveryCleanupReason: (...args) => (0, scope.resolveAbyssalRecoveryCleanupReason)(...args),
  reconcilePendingAbyssalMemberDestructions: (...args) => (0, scope.reconcilePendingAbyssalMemberDestructions)(...args),
  reconcilePendingAbyssalRewardArtifactDestructions: (...args) => (0, scope.reconcilePendingAbyssalRewardArtifactDestructions)(...args),
  buildPlaceholderRoomState: (...args) => (0, scope.buildPlaceholderRoomState)(...args),
  getPlaceholderRoomEntry: (...args) => (0, scope.getPlaceholderRoomEntry)(...args),
  listUniquePositiveInts: (...args) => (0, scope.listUniquePositiveInts)(...args),
  suppressAbyssalRoomRewards: (...args) => (0, scope.suppressAbyssalRoomRewards)(...args),
  retryPendingAbyssalRewardMaterializations: (...args) => (0, scope.retryPendingAbyssalRewardMaterializations)(...args),
  finalizeResolvedAbyssalRewardArtifactDestructions: (...args) => (0, scope.finalizeResolvedAbyssalRewardArtifactDestructions)(...args),
  reconcilePendingAbyssalObjectiveDeaths: (...args) => (0, scope.reconcilePendingAbyssalObjectiveDeaths)(...args),
  getActivePocketStateByInstanceID: (...args) => (0, scope.getActivePocketStateByInstanceID)(...args),
  getPocketScene: (...args) => (0, scope.getPocketScene)(...args),
  runAbyssalNpcControllerWatchdog: (...args) => (0, scope.runAbyssalNpcControllerWatchdog)(...args),
  setPlaceholderRoomEntry: (...args) => (0, scope.setPlaceholderRoomEntry)(...args),
  updatePocketState: (...args) => (0, scope.updatePocketState)(...args),
  listPocketHostileEntityIDs: (...args) => (0, scope.listPocketHostileEntityIDs)(...args),
  listPocketObjectiveRelevantEntityIDs: (...args) => (0, scope.listPocketObjectiveRelevantEntityIDs)(...args),
  normalizeLowerText: (...args) => (0, scope.normalizeLowerText)(...args),
  getPendingAbyssalTransitionState: (...args) => (0, scope.getPendingAbyssalTransitionState)(...args),
  evaluateEnvironmentalEffectsForPocketState: (...args) => (0, scope.evaluateEnvironmentalEffectsForPocketState)(...args),
  buildAbyssalEnvironmentalMaterializationReadiness: (...args) => (0, scope.buildAbyssalEnvironmentalMaterializationReadiness)(...args),
  buildAbyssalEnvironmentalEffectReadiness: (...args) => (0, scope.buildAbyssalEnvironmentalEffectReadiness)(...args),
  activateSuppressorControllersForPocketRoom: (...args) => (0, scope.activateSuppressorControllersForPocketRoom)(...args),
  listSuppressorControllersForRun: (...args) => (0, scope.listSuppressorControllersForRun)(...args),
  isBenignAbyssalBoundaryControllerState: (...args) => (0, scope.isBenignAbyssalBoundaryControllerState)(...args),
  getRoomObjectiveIDSets: (...args) => (0, scope.getRoomObjectiveIDSets)(...args),
  isFinalRoomIndex: (...args) => (0, scope.isFinalRoomIndex)(...args),
  recordAuditEvent: (...args) => (0, scope.recordAuditEvent)(...args),
  buildRoomLogContext: (...args) => (0, scope.buildRoomLogContext)(...args),
  log: scope.log,
  markCurrentRoomConduitOpen: (...args) => (0, scope.markCurrentRoomConduitOpen)(...args),
  refreshAbyssalDungeonTrackingState: (...args) => (0, scope.refreshAbyssalDungeonTrackingState)(...args),
  recordAbyssalRunOutcome: (...args) => (0, scope.recordAbyssalRunOutcome)(...args),
  hasFailedTimeoutOutcome: (...args) => (0, scope.hasFailedTimeoutOutcome)(...args),
  ensurePlaceholderRewardCache: (...args) => (0, scope.ensurePlaceholderRewardCache)(...args),
  recordAbyssalMaintenanceFailure: (...args) => (0, scope.recordAbyssalMaintenanceFailure)(...args),
  runAbyssalRecoveryTombstoneMaintenance: (...args) => (0, scope.runAbyssalRecoveryTombstoneMaintenance)(...args),
  hasAbyssalRecoveryTombstoneBacklog: (...args) => (0, scope.hasAbyssalRecoveryTombstoneBacklog)(...args),
  get PLACEHOLDER_POCKET_MAINTENANCE_INTERVAL_MS() { return scope.PLACEHOLDER_POCKET_MAINTENANCE_INTERVAL_MS; },
  get ABYSSAL_RECOVERY_TOMBSTONE_IDLE_MAINTENANCE_INTERVAL_MS() { return scope.ABYSSAL_RECOVERY_TOMBSTONE_IDLE_MAINTENANCE_INTERVAL_MS; },
  listActiveRuns: (...args) => scope.activeAbyssalRunRegistry.listActiveRuns(...args),
  getActiveRunCount: () => scope.activeAbyssalRunRegistry.size,
  hasObjectiveDeaths: (...args) => scope.abyssalPendingWorkRegistry.hasObjectiveDeaths(...args),
  getRuntimeTelemetry: (...args) => scope.abyssalMaintenanceState.getRuntimeTelemetry(...args),
  setRuntimeTelemetry: (...args) => scope.abyssalMaintenanceState.setRuntimeTelemetry(...args),
  tryBeginPass: (...args) => scope.abyssalMaintenanceState.tryBeginPass(...args),
  getActiveWriteCount: (...args) => scope.abyssalMaintenanceState.getActiveWriteCount(...args),
  finishPass: (...args) => scope.abyssalMaintenanceState.finishPass(...args),
  hasTimerHandle: (...args) => scope.abyssalMaintenanceState.hasTimerHandle(...args),
  takeTimerHandleIfCurrent: (...args) => scope.abyssalMaintenanceState.takeTimerHandleIfCurrent(...args),
  setTimerHandle: (...args) => scope.abyssalMaintenanceState.setTimerHandle(...args),
  hasTombstoneScanInProgress: (...args) => scope.abyssalRecoveryTombstoneStore.hasScanInProgress(...args),
});
  scope.runPlaceholderPocketMaintenance = runPlaceholderPocketMaintenance;
  scope.schedulePlaceholderPocketMaintenance = schedulePlaceholderPocketMaintenance;
}

function initializeManagerGroup6Binding5(scope) {
  const database = require("../../gameStore");
  scope.database = database;
}

function initializeManagerGroup6Binding6(scope) {
  const { throwWrappedUserError } = require("../../common/machoErrors");
  scope.throwWrappedUserError = throwWrappedUserError;
}

function initializeManagerGroup6Binding7(scope) {
  const { buildDict, buildList } = require("../../services/_shared/serviceHelpers");
  scope.buildDict = buildDict;
  scope.buildList = buildList;
}

function initializeManagerGroup6Binding8(scope) {
  const {
  getAttributeIDByNames,
  applyModifierGroups,
} = require("../../services/fitting/liveFittingState");
  scope.getAttributeIDByNames = getAttributeIDByNames;
  scope.applyModifierGroups = applyModifierGroups;
}

function initializeManagerGroup6Binding9(scope) {
  const {
  ITEM_FLAGS,
  consumeInventoryItemQuantity,
  createSpaceItemForOwner,
  findItemById,
  grantItemToOwnerLocation,
  grantItemToOwnerLocationIdempotent,
  grantItemsToOwnerLocationIdempotent,
  getAllItems,
  getIdempotentGrantReceipt,
  isCapsuleTypeID,
  listContainerItems,
  listSystemSpaceItems,
  moveShipToSpace,
  removeInventoryItem,
  updateInventoryItem,
  updateShipItem,
} = require("../../services/inventory/itemStore");
  scope.ITEM_FLAGS = ITEM_FLAGS;
  scope.consumeInventoryItemQuantity = consumeInventoryItemQuantity;
  scope.createSpaceItemForOwner = createSpaceItemForOwner;
  scope.findItemById = findItemById;
  scope.grantItemToOwnerLocation = grantItemToOwnerLocation;
  scope.grantItemToOwnerLocationIdempotent = grantItemToOwnerLocationIdempotent;
  scope.grantItemsToOwnerLocationIdempotent = grantItemsToOwnerLocationIdempotent;
  scope.getAllItems = getAllItems;
  scope.getIdempotentGrantReceipt = getIdempotentGrantReceipt;
  scope.isCapsuleTypeID = isCapsuleTypeID;
  scope.listContainerItems = listContainerItems;
  scope.listSystemSpaceItems = listSystemSpaceItems;
  scope.moveShipToSpace = moveShipToSpace;
  scope.removeInventoryItem = removeInventoryItem;
  scope.updateInventoryItem = updateInventoryItem;
  scope.updateShipItem = updateShipItem;
}

function initializeManagerGroup6Binding10(scope) {
  const { resolveItemByName, resolveItemByTypeID } = require("../../services/inventory/itemTypeRegistry");
  scope.resolveItemByName = resolveItemByName;
  scope.resolveItemByTypeID = resolveItemByTypeID;
}

function initializeManagerGroup6Binding11(scope) {
  const { isCorpseType } = require("../../space/corpseUtils");
  scope.isCorpseType = isCorpseType;
}

function initializeManagerGroup6Binding12(scope) {
  const { resolveEntityInteractionScope } = require("../../space/destiny/identity/interactionScope");
  scope.resolveEntityInteractionScope = resolveEntityInteractionScope;
}

function initializeManagerGroup6Binding13(scope) {
  const { matchesTypeList } = require("../../services/inventory/typeListAuthority");
  scope.matchesTypeList = matchesTypeList;
}

function initializeManagerGroup6Binding14(scope) {
  const hostileModuleRuntime = require("../../space/modules/hostileModuleRuntime");
  scope.hostileModuleRuntime = hostileModuleRuntime;
}

function initializeManagerGroup6Binding15(scope) {
  const worldData = require("../../space/worldData");
  scope.worldData = worldData;
}

function initializeManagerGroup6Binding16(scope) {
  const destiny = require("../../space/destiny");
  scope.destiny = destiny;
}

function initializeManagerGroup6Binding17(scope) {
  const {
  getNpcWeaponModules,
  getNpcEntityMissileWeaponSource,
} = require("../../space/npc/npcEquipment");
  scope.getNpcWeaponModules = getNpcWeaponModules;
  scope.getNpcEntityMissileWeaponSource = getNpcEntityMissileWeaponSource;
}

function initializeManagerGroup6Binding18(scope) {
  const fleetRuntime = require("../../services/fleets/fleetRuntime");
  scope.fleetRuntime = fleetRuntime;
}

function initializeManagerGroup6Binding19(scope) {
  const dungeonRuntime = require("../../services/dungeon/dungeonRuntime");
  scope.dungeonRuntime = dungeonRuntime;
}

function initializeManagerGroup6Binding20(scope) {
  const dungeonTrackingRuntime = require("../../services/dungeon/dungeonTrackingRuntime");
  scope.dungeonTrackingRuntime = dungeonTrackingRuntime;
}

function initializeManagerGroup6Binding21(scope) {
  const dungeonUniverseSiteService = require("../../services/dungeon/dungeonUniverseSiteService");
  scope.dungeonUniverseSiteService = dungeonUniverseSiteService;
}

function initializeManagerGroup6Binding22(scope) {
  const {
  ROLEMASK_VIEW,
  normalizeRoleValue,
} = require("../../services/account/accountRoleProfiles");
  scope.ROLEMASK_VIEW = ROLEMASK_VIEW;
  scope.normalizeRoleValue = normalizeRoleValue;
}

function initializeManagerGroup6Binding23(scope) {
  const {
  queuePostSpaceAttachFittingHydration,
} = require("../../space/modules/spaceAttachHydration");
  scope.queuePostSpaceAttachFittingHydration = queuePostSpaceAttachFittingHydration;
}

function initializeManagerGroup6Binding24(scope) {
  const {
  ABYSSAL_GATE_ACTIVATION_STATE,
  TYPE_ABYSSAL_TRACE,
  applyAbyssalGatePresentationState,
  buildAbyssalTracePresentationState,
} = require("../domain/abyssalGatePresentation");
  scope.ABYSSAL_GATE_ACTIVATION_STATE = ABYSSAL_GATE_ACTIVATION_STATE;
  scope.TYPE_ABYSSAL_TRACE = TYPE_ABYSSAL_TRACE;
  scope.applyAbyssalGatePresentationState = applyAbyssalGatePresentationState;
  scope.buildAbyssalTracePresentationState = buildAbyssalTracePresentationState;
}

function initializeManagerGroup6Binding25(scope) {
  const {
  ABYSSAL_TRACE_LIFECYCLE_PHASE,
  SHARED_ABYSSAL_ENTRANCE_TRACE_PROFILE_ID,
  SHARED_ABYSSAL_ENTRANCE_TRANSITION_DELAY_MS,
  T0_DARK_TRACE_PROFILE_ID,
  T0_TRANQUIL_FILAMENT_TYPE_IDS,
  buildAbyssalTraceSlimState,
  getAbyssalTracePhaseDefinition,
  normalizeAbyssalTraceLifecyclePhase,
  resolveAbyssalTraceAutomaticActivationDelayMs,
  resolveAbyssalTraceProfile,
  resolveAbyssalTraceTransitionPresentation,
} = require("../catalog/abyssalTraceProfiles");
  scope.ABYSSAL_TRACE_LIFECYCLE_PHASE = ABYSSAL_TRACE_LIFECYCLE_PHASE;
  scope.SHARED_ABYSSAL_ENTRANCE_TRACE_PROFILE_ID = SHARED_ABYSSAL_ENTRANCE_TRACE_PROFILE_ID;
  scope.SHARED_ABYSSAL_ENTRANCE_TRANSITION_DELAY_MS = SHARED_ABYSSAL_ENTRANCE_TRANSITION_DELAY_MS;
  scope.T0_DARK_TRACE_PROFILE_ID = T0_DARK_TRACE_PROFILE_ID;
  scope.T0_TRANQUIL_FILAMENT_TYPE_IDS = T0_TRANQUIL_FILAMENT_TYPE_IDS;
  scope.buildAbyssalTraceSlimState = buildAbyssalTraceSlimState;
  scope.getAbyssalTracePhaseDefinition = getAbyssalTracePhaseDefinition;
  scope.normalizeAbyssalTraceLifecyclePhase = normalizeAbyssalTraceLifecyclePhase;
  scope.resolveAbyssalTraceAutomaticActivationDelayMs = resolveAbyssalTraceAutomaticActivationDelayMs;
  scope.resolveAbyssalTraceProfile = resolveAbyssalTraceProfile;
  scope.resolveAbyssalTraceTransitionPresentation = resolveAbyssalTraceTransitionPresentation;
}

function initializeManagerGroup6Binding26(scope) {
  const {
  getAbyssalTracePublicationReceipt,
} = require("./abyssalTracePublicationReceipts");
  scope.getAbyssalTracePublicationReceipt = getAbyssalTracePublicationReceipt;
}

function initializeManagerGroup6Binding27(scope) {
  const {
  ENVIRONMENTAL_EFFECT_KIND,
  getAbyssalEnvironmentalDefinition,
  listAbyssalEnvironmentalObjectsForRoom,
} = require("../catalog/abyssalEnvironmentalCatalog");
  scope.ENVIRONMENTAL_EFFECT_KIND = ENVIRONMENTAL_EFFECT_KIND;
  scope.getAbyssalEnvironmentalDefinition = getAbyssalEnvironmentalDefinition;
  scope.listAbyssalEnvironmentalObjectsForRoom = listAbyssalEnvironmentalObjectsForRoom;
}

function initializeManagerGroup6Binding28(scope) {
  const {
  resolveGeneratedAuthoredAbyssalSceneryProfile,
  resolveT0TranquilRetailCapturedSceneryProfile,
} = require("../catalog/t0TranquilRetailCapturedScenery");
  scope.resolveGeneratedAuthoredAbyssalSceneryProfile = resolveGeneratedAuthoredAbyssalSceneryProfile;
  scope.resolveT0TranquilRetailCapturedSceneryProfile = resolveT0TranquilRetailCapturedSceneryProfile;
}

function initializeManagerGroup6Binding29(scope) {
  const {
  resolveDarkWeatherSelection,
} = require("../catalog/abyssalDarkWeatherCatalog");
  scope.resolveDarkWeatherSelection = resolveDarkWeatherSelection;
}

function initializeManagerGroup6Binding30(scope) {
  const {
  normalizeAbyssalBaseRoomLayoutSelectionState,
  resolveAbyssalBaseRoomSceneryProfile,
  resolveSelectedAbyssalBaseRoomLayoutID,
  selectAbyssalBaseRoomLayouts,
} = require("../catalog/abyssalBaseRoomLayoutCatalog");
  scope.normalizeAbyssalBaseRoomLayoutSelectionState = normalizeAbyssalBaseRoomLayoutSelectionState;
  scope.resolveAbyssalBaseRoomSceneryProfile = resolveAbyssalBaseRoomSceneryProfile;
  scope.resolveSelectedAbyssalBaseRoomLayoutID = resolveSelectedAbyssalBaseRoomLayoutID;
  scope.selectAbyssalBaseRoomLayouts = selectAbyssalBaseRoomLayouts;
}

function initializeManagerGroup6Binding31(scope) {
  const {
  evaluateAbyssalEnvironmentalEffects,
  clearAbyssalEnvironmentalModifiersForRun,
} = require("./abyssalEnvironmentalRuntime");
  scope.evaluateAbyssalEnvironmentalEffects = evaluateAbyssalEnvironmentalEffects;
  scope.clearAbyssalEnvironmentalModifiersForRun = clearAbyssalEnvironmentalModifiersForRun;
}

function initializeManagerGroup6Binding32(scope) {
  const {
  TYPE_ABYSSAL_PERIMETER_LIGHTS,
  TYPE_UNSTABLE_ABYSSAL_DEPTHS,
  resolvePerimeterRadius,
  ensureActiveBoundaryController,
  finalizeAndCleanupBoundaryControllersForRun,
  cleanupBoundaryControllersForRun,
  getBoundaryControllerForRun,
  resetBoundaryControllersForTests,
} = require("./controllers/abyssalBoundaryMechanicsController");
  scope.TYPE_ABYSSAL_PERIMETER_LIGHTS = TYPE_ABYSSAL_PERIMETER_LIGHTS;
  scope.TYPE_UNSTABLE_ABYSSAL_DEPTHS = TYPE_UNSTABLE_ABYSSAL_DEPTHS;
  scope.resolvePerimeterRadius = resolvePerimeterRadius;
  scope.ensureActiveBoundaryController = ensureActiveBoundaryController;
  scope.finalizeAndCleanupBoundaryControllersForRun = finalizeAndCleanupBoundaryControllersForRun;
  scope.cleanupBoundaryControllersForRun = cleanupBoundaryControllersForRun;
  scope.getBoundaryControllerForRun = getBoundaryControllerForRun;
  scope.resetBoundaryControllersForTests = resetBoundaryControllersForTests;
}

function initializeManagerGroup6Binding33(scope) {
  const {
  UNSTABLE_ABYSSAL_DEPTHS_BOUNDARY_PROFILE,
} = require("../domain/abyssalBoundaryProfile");
  scope.UNSTABLE_ABYSSAL_DEPTHS_BOUNDARY_PROFILE = UNSTABLE_ABYSSAL_DEPTHS_BOUNDARY_PROFILE;
}

function initializeManagerGroup6Binding34(scope) {
  const {
  getAbyssalSuppressorMechanicsProfileByTypeID,
} = require("../catalog/abyssalSuppressorMechanicsProfile");
  scope.getAbyssalSuppressorMechanicsProfileByTypeID = getAbyssalSuppressorMechanicsProfileByTypeID;
}

function initializeManagerGroup6Binding35(scope) {
  const {
  buildAbyssalSuppressorStartFxOptions,
  getAbyssalSuppressorPresentationProfileByTypeID,
} = require("../catalog/abyssalSuppressorPresentationProfile");
  scope.buildAbyssalSuppressorStartFxOptions = buildAbyssalSuppressorStartFxOptions;
  scope.getAbyssalSuppressorPresentationProfileByTypeID = getAbyssalSuppressorPresentationProfileByTypeID;
}

function initializeManagerGroup6Binding36(scope) {
  const {
  cleanupSuppressorPresentationStateByEntity,
  cleanupSuppressorPresentationStatesForRun,
  getSuppressorPresentationState,
  listSuppressorPresentationStatesForRun,
  registerSuppressorPresentationState,
  resetSuppressorPresentationStatesForTests,
  startSuppressorPresentationForSession,
  stopSuppressorPresentationForSession,
  stopSuppressorPresentationsForRun,
} = require("./controllers/abyssalSuppressorPresentationLifecycle");
  scope.cleanupSuppressorPresentationStateByEntity = cleanupSuppressorPresentationStateByEntity;
  scope.cleanupSuppressorPresentationStatesForRun = cleanupSuppressorPresentationStatesForRun;
  scope.getSuppressorPresentationState = getSuppressorPresentationState;
  scope.listSuppressorPresentationStatesForRun = listSuppressorPresentationStatesForRun;
  scope.registerSuppressorPresentationState = registerSuppressorPresentationState;
  scope.resetSuppressorPresentationStatesForTests = resetSuppressorPresentationStatesForTests;
  scope.startSuppressorPresentationForSession = startSuppressorPresentationForSession;
  scope.stopSuppressorPresentationForSession = stopSuppressorPresentationForSession;
  scope.stopSuppressorPresentationsForRun = stopSuppressorPresentationsForRun;
}

function initializeManagerGroup6Binding37(scope) {
  const {
  registerSuppressorController,
  activateSuppressorControllersForRoom,
  pauseSuppressorControllersForRoom,
  cleanupSuppressorControllerByRuntimeEntity,
  cleanupSuppressorControllersForRun,
  getSuppressorController,
  listSuppressorControllersForRun,
  resetSuppressorControllersForTests,
} = require("./controllers/abyssalSuppressorMechanicsController");
  scope.registerSuppressorController = registerSuppressorController;
  scope.activateSuppressorControllersForRoom = activateSuppressorControllersForRoom;
  scope.pauseSuppressorControllersForRoom = pauseSuppressorControllersForRoom;
  scope.cleanupSuppressorControllerByRuntimeEntity = cleanupSuppressorControllerByRuntimeEntity;
  scope.cleanupSuppressorControllersForRun = cleanupSuppressorControllersForRun;
  scope.getSuppressorController = getSuppressorController;
  scope.listSuppressorControllersForRun = listSuppressorControllersForRun;
  scope.resetSuppressorControllersForTests = resetSuppressorControllersForTests;
}

function initializeManagerGroup6Binding38(scope) {
  const {
  clearSuppressorDebugForRun,
  clearSuppressorDebugHistoryForRun,
  getSuppressorDebugSnapshot,
  isSuppressorDebugEnabled,
  removeSelectedMissile,
  resetSuppressorDiagnosticsForTests,
  setSuppressorDebugForRun,
} = require("./controllers/abyssalSuppressorDiagnostics");
  scope.clearSuppressorDebugForRun = clearSuppressorDebugForRun;
  scope.clearSuppressorDebugHistoryForRun = clearSuppressorDebugHistoryForRun;
  scope.getSuppressorDebugSnapshot = getSuppressorDebugSnapshot;
  scope.isSuppressorDebugEnabled = isSuppressorDebugEnabled;
  scope.removeSelectedMissile = removeSelectedMissile;
  scope.resetSuppressorDiagnosticsForTests = resetSuppressorDiagnosticsForTests;
  scope.setSuppressorDebugForRun = setSuppressorDebugForRun;
}

function initializeManagerGroup6Binding39(scope) {
  const {
  resolveAbyssalEnvironmentRoomProfile,
  selectAbyssalEnvironmentLayoutVariant,
} = require("../catalog/abyssalEnvironmentProfiles");
  scope.resolveAbyssalEnvironmentRoomProfile = resolveAbyssalEnvironmentRoomProfile;
  scope.selectAbyssalEnvironmentLayoutVariant = selectAbyssalEnvironmentLayoutVariant;
}

function initializeManagerGroup6Binding40(scope) {
  const {
  ABYSSAL_ROOM_ENTITY_ROLES,
  resolveAbyssalRoomEntityRole,
  applyAbyssalRoomEntityMetadata,
  summarizeAbyssalRoomEntities,
  formatAbyssalRoomEntityCountsForLog,
} = require("../domain/abyssalRoomEntityRoles");
  scope.ABYSSAL_ROOM_ENTITY_ROLES = ABYSSAL_ROOM_ENTITY_ROLES;
  scope.resolveAbyssalRoomEntityRole = resolveAbyssalRoomEntityRole;
  scope.applyAbyssalRoomEntityMetadata = applyAbyssalRoomEntityMetadata;
  scope.summarizeAbyssalRoomEntities = summarizeAbyssalRoomEntities;
  scope.formatAbyssalRoomEntityCountsForLog = formatAbyssalRoomEntityCountsForLog;
}

function initializeManagerGroup6Binding41(scope) {
  const {
  PROFILE_ID: T0_DARK_RETAIL_CAPTURED_PROFILE_ID,
  LAYOUT_VARIANT: T0_DARK_RETAIL_CAPTURED_LAYOUT_VARIANT,
  FILAMENT_TYPE_ID: T0_DARK_RETAIL_CAPTURED_FILAMENT_TYPE_ID,
  T0_DARK_RETAIL_CAPTURED_LAYOUT,
  isT0DarkRetailCapturedProfile,
} = require("../catalog/t0DarkRetailCapturedLayout");
  scope.T0_DARK_RETAIL_CAPTURED_PROFILE_ID = T0_DARK_RETAIL_CAPTURED_PROFILE_ID;
  scope.T0_DARK_RETAIL_CAPTURED_LAYOUT_VARIANT = T0_DARK_RETAIL_CAPTURED_LAYOUT_VARIANT;
  scope.T0_DARK_RETAIL_CAPTURED_FILAMENT_TYPE_ID = T0_DARK_RETAIL_CAPTURED_FILAMENT_TYPE_ID;
  scope.T0_DARK_RETAIL_CAPTURED_LAYOUT = T0_DARK_RETAIL_CAPTURED_LAYOUT;
  scope.isT0DarkRetailCapturedProfile = isT0DarkRetailCapturedProfile;
}

function initializeManagerGroup6Binding42(scope) {
  const {
  LAYOUT_SELECTION_MODEL: T0_DARK_LAYOUT_SELECTION_MODEL,
  LEGACY_LAYOUT_SET_ID: T0_DARK_LEGACY_LAYOUT_SET_ID,
  SCENERY_POLICY_AUTHORITATIVE,
  SCENERY_POLICY_EXPERIMENTAL,
  EVIDENCE_STATUS_CAPTURED_RETAIL,
  buildLegacyT0DarkLayoutSelectionState,
  getT0DarkLayoutCatalogValidationReport,
  isCompatibleT0DarkLayoutRequest,
  listEnabledT0DarkLayoutSets,
  resolveSelectedT0DarkRoom,
  resolveT0DarkLayoutSetByID,
  selectT0DarkLayoutSet,
} = require("../catalog/t0DarkLayoutCatalog");
  scope.T0_DARK_LAYOUT_SELECTION_MODEL = T0_DARK_LAYOUT_SELECTION_MODEL;
  scope.T0_DARK_LEGACY_LAYOUT_SET_ID = T0_DARK_LEGACY_LAYOUT_SET_ID;
  scope.SCENERY_POLICY_AUTHORITATIVE = SCENERY_POLICY_AUTHORITATIVE;
  scope.SCENERY_POLICY_EXPERIMENTAL = SCENERY_POLICY_EXPERIMENTAL;
  scope.EVIDENCE_STATUS_CAPTURED_RETAIL = EVIDENCE_STATUS_CAPTURED_RETAIL;
  scope.buildLegacyT0DarkLayoutSelectionState = buildLegacyT0DarkLayoutSelectionState;
  scope.getT0DarkLayoutCatalogValidationReport = getT0DarkLayoutCatalogValidationReport;
  scope.isCompatibleT0DarkLayoutRequest = isCompatibleT0DarkLayoutRequest;
  scope.listEnabledT0DarkLayoutSets = listEnabledT0DarkLayoutSets;
  scope.resolveSelectedT0DarkRoom = resolveSelectedT0DarkRoom;
  scope.resolveT0DarkLayoutSetByID = resolveT0DarkLayoutSetByID;
  scope.selectT0DarkLayoutSet = selectT0DarkLayoutSet;
}

function initializeManagerGroup6Binding43(scope) {
  const {
  TRANSITION_POLICY_AUTHORITATIVE_CAPTURED,
  TRANSITION_POLICY_EXPERIMENTAL,
  resolveTransitionProfile,
  resolveTransitionProfileSetForLayout,
} = require("../catalog/abyssalTransitionProfiles");
  scope.TRANSITION_POLICY_AUTHORITATIVE_CAPTURED = TRANSITION_POLICY_AUTHORITATIVE_CAPTURED;
  scope.TRANSITION_POLICY_EXPERIMENTAL = TRANSITION_POLICY_EXPERIMENTAL;
  scope.resolveTransitionProfile = resolveTransitionProfile;
  scope.resolveTransitionProfileSetForLayout = resolveTransitionProfileSetForLayout;
}

function initializeManagerGroup6Binding44(scope) {
  const {
  classifyAbyssalHostLocation,
  isAbyssalHostLocationID,
} = require("../domain/abyssalHostLocation");
  scope.classifyAbyssalHostLocation = classifyAbyssalHostLocation;
  scope.isAbyssalHostLocationID = isAbyssalHostLocationID;
}

function initializeManagerGroup6Binding45(scope) {
  const {
  ABYSSAL_RECOVERY_ORIGIN_UNRESOLVED,
  SAFE_FALLBACK_SOLAR_SYSTEM_ID,
  resolveAuthoritativeRecoveryOrigin,
  resolveEmergencyRecoveryDecision,
} = require("./abyssalRecoveryPolicy");
  scope.ABYSSAL_RECOVERY_ORIGIN_UNRESOLVED = ABYSSAL_RECOVERY_ORIGIN_UNRESOLVED;
  scope.SAFE_FALLBACK_SOLAR_SYSTEM_ID = SAFE_FALLBACK_SOLAR_SYSTEM_ID;
  scope.resolveAuthoritativeRecoveryOrigin = resolveAuthoritativeRecoveryOrigin;
  scope.resolveEmergencyRecoveryDecision = resolveEmergencyRecoveryDecision;
}

function bindAbyssalManagerRuntimeGroup6Operations(scope) {

}

function initializeAbyssalManagerRuntimeGroup6Part1(scope) {
  initializeManagerGroup6Binding1(scope);
  initializeManagerGroup6Binding2(scope);
  initializeManagerGroup6Binding3(scope);
  initializeManagerGroup6Binding4(scope);
  initializeManagerGroup6Binding5(scope);
  initializeManagerGroup6Binding6(scope);
  initializeManagerGroup6Binding7(scope);
  initializeManagerGroup6Binding8(scope);
  initializeManagerGroup6Binding9(scope);
  initializeManagerGroup6Binding10(scope);
  initializeManagerGroup6Binding11(scope);
  initializeManagerGroup6Binding12(scope);
  initializeManagerGroup6Binding13(scope);
  initializeManagerGroup6Binding14(scope);
  initializeManagerGroup6Binding15(scope);
  initializeManagerGroup6Binding16(scope);
  initializeManagerGroup6Binding17(scope);
  initializeManagerGroup6Binding18(scope);
  initializeManagerGroup6Binding19(scope);
  initializeManagerGroup6Binding20(scope);
  initializeManagerGroup6Binding21(scope);
  initializeManagerGroup6Binding22(scope);
  initializeManagerGroup6Binding23(scope);
  initializeManagerGroup6Binding24(scope);
  initializeManagerGroup6Binding25(scope);
  initializeManagerGroup6Binding26(scope);
  initializeManagerGroup6Binding27(scope);
  initializeManagerGroup6Binding28(scope);
  initializeManagerGroup6Binding29(scope);
  initializeManagerGroup6Binding30(scope);
  initializeManagerGroup6Binding31(scope);
  initializeManagerGroup6Binding32(scope);
  initializeManagerGroup6Binding33(scope);
  initializeManagerGroup6Binding34(scope);
  initializeManagerGroup6Binding35(scope);
  initializeManagerGroup6Binding36(scope);
  initializeManagerGroup6Binding37(scope);
  initializeManagerGroup6Binding38(scope);
  initializeManagerGroup6Binding39(scope);
  initializeManagerGroup6Binding40(scope);
  initializeManagerGroup6Binding41(scope);
  initializeManagerGroup6Binding42(scope);
  initializeManagerGroup6Binding43(scope);
  initializeManagerGroup6Binding44(scope);
  initializeManagerGroup6Binding45(scope);
}

function initializeAbyssalManagerRuntimeGroup6(scope) {
  initializeAbyssalManagerRuntimeGroup6Part1(scope);
}

module.exports = {
  bindAbyssalManagerRuntimeGroup6Operations,
  initializeAbyssalManagerRuntimeGroup6,
};
