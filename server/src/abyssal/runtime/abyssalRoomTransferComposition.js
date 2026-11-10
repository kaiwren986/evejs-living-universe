"use strict";

const { createAbyssalRoomMaterialization } = require("./abyssalRoomMaterialization");
const { createAbyssalRoomPrewarming } = require("./abyssalRoomPrewarming");
const { createAbyssalRoomTransferContent } = require("./abyssalRoomTransferContent");
const { createAbyssalRoomTransferMovement } = require("./abyssalRoomTransferMovement");
const { createAbyssalRoomTransferPublication } = require("./abyssalRoomTransferPublication");
const { createAbyssalRoomTransferActivation } = require("./abyssalRoomTransferActivation");
const { createAbyssalRoomTransferExecution } = require("./abyssalRoomTransferExecution");

function composeRoomMaterialization(scope) {
  return createAbyssalRoomMaterialization({
    getDependencies: scope.getDependencies,
    cloneValue: scope.cloneValue,
    runPlaceholderPocketMaintenance: scope.runPlaceholderPocketMaintenance,
    getActivePocketStateByInstanceID: scope.getActivePocketStateByInstanceID,
    buildPocketStateForCurrentRoom: scope.buildPocketStateForCurrentRoom,
    buildPlaceholderRoomState: scope.buildPlaceholderRoomState,
    log: scope.log,
    getPlaceholderRoomEntry: scope.getPlaceholderRoomEntry,
    getObjectPosition: scope.getObjectPosition,
    resolveRoomOriginPosition: scope.resolveRoomOriginPosition,
    buildRoomConduitState: scope.buildRoomConduitState,
    isFinalRoomIndex: scope.isFinalRoomIndex,
    getFinalExitConduitLabel: scope.getFinalExitConduitLabel,
    getTransferConduitLabel: scope.getTransferConduitLabel,
    resolveRoomEncounterProfile: scope.resolveRoomEncounterProfile,
    resolveRoomRewardProfile: scope.resolveRoomRewardProfile,
    setPlaceholderRoomEntry: scope.setPlaceholderRoomEntry,
    buildRoomShipSpawnState: scope.buildRoomShipSpawnState,
    buildEncounterStateFromRoomEntry: scope.buildEncounterStateFromRoomEntry,
    buildPlaceholderTimerState: scope.buildPlaceholderTimerState,
    getNpcRuntimePolicy: scope.getNpcRuntimePolicy,
    registerPocket: scope.registerPocket,
    schedulePlaceholderPocketMaintenance: scope.schedulePlaceholderPocketMaintenance,
    destroyPlaceholderTrace: scope.destroyPlaceholderTrace,
    buildAbyssalSceneDescriptor: scope.buildAbyssalSceneDescriptor,
    ensurePocketMarker: scope.ensurePocketMarker,
    TYPE_ABYSSAL_ORIGIN_CONDUIT: scope.TYPE_ABYSSAL_ORIGIN_CONDUIT,
    TYPE_ABYSSAL_TRANSFER_CONDUIT: scope.TYPE_ABYSSAL_TRANSFER_CONDUIT,
    listPocketHostileEntityIDs: scope.listPocketHostileEntityIDs,
    buildPlaceholderEncounterState: scope.buildPlaceholderEncounterState,
    listUniquePositiveInts: scope.listUniquePositiveInts,
    isAbyssalPocketMutationBatchActive: scope.isAbyssalPocketMutationBatchActive,
    suppressAbyssalRoomRewards: scope.suppressAbyssalRoomRewards,
    ensurePlaceholderExtractionNodes: scope.ensurePlaceholderExtractionNodes,
    getAbyssalSceneryProfileForRoomIndex: scope.getAbyssalSceneryProfileForRoomIndex,
    isAuthoritativeAbyssalSceneryProfile: scope.isAuthoritativeAbyssalSceneryProfile,
    usesIsolatedAbyssalScene: scope.usesIsolatedAbyssalScene,
    ensureAbyssalSceneryVisuals: scope.ensureAbyssalSceneryVisuals,
    ensureAbyssalEnvironmentalObjects: scope.ensureAbyssalEnvironmentalObjects,
    getContentProfile: scope.getContentProfile,
    isSupportedAbyssalContentTier: scope.isSupportedAbyssalContentTier,
    hasTerminalFailureOutcome: scope.hasTerminalFailureOutcome,
    ensurePlaceholderRewardCache: scope.ensurePlaceholderRewardCache,
    maybeSendAbyssalRoomOneClientFx: scope.maybeSendAbyssalRoomOneClientFx,
    buildRoomLogContext: scope.buildRoomLogContext,
    logAbyssalRoomContentPrepared: scope.logAbyssalRoomContentPrepared,
  });
}

function composeRoomPrewarming(scope) {
  return createAbyssalRoomPrewarming({
    getDependencies: scope.getDependencies,
    spawnPlaceholderPocketContent: scope.spawnPlaceholderPocketContent,
    usesIsolatedAbyssalScene: scope.usesIsolatedAbyssalScene,
    cloneValue: scope.cloneValue,
    buildPlaceholderRoomState: scope.buildPlaceholderRoomState,
    getPlaceholderRoomEntry: scope.getPlaceholderRoomEntry,
    setPlaceholderRoomEntry: scope.setPlaceholderRoomEntry,
    registerPocket: scope.registerPocket,
    log: scope.log,
    resolveSelectedAbyssalBaseRoomLayoutID: scope.resolveSelectedAbyssalBaseRoomLayoutID,
    buildRoomShipSpawnState: scope.buildRoomShipSpawnState,
    resolveRoomOriginPosition: scope.resolveRoomOriginPosition,
    ABYSSAL_ROOM_DELIVERY_STATE: scope.ABYSSAL_ROOM_DELIVERY_STATE,
    buildPocketStateForCurrentRoom: scope.buildPocketStateForCurrentRoom,
    buildEncounterStateFromRoomEntry: scope.buildEncounterStateFromRoomEntry,
    listUniquePositiveInts: scope.listUniquePositiveInts,
    setAbyssalRoomEntityDeliveryState: scope.setAbyssalRoomEntityDeliveryState,
    ABYSSAL_ROOM_ENTITY_ROLES: scope.ABYSSAL_ROOM_ENTITY_ROLES,
    updatePocketState: scope.updatePocketState,
    pauseSuppressorControllersForRoom: scope.pauseSuppressorControllersForRoom,
    cleanupSuppressorControllerByRuntimeEntity: scope.cleanupSuppressorControllerByRuntimeEntity,
    cleanupSuppressorPresentationStateByEntity: scope.cleanupSuppressorPresentationStateByEntity,
    destroyPlaceholderTrace: scope.destroyPlaceholderTrace,
    buildAbyssalSceneDescriptor: scope.buildAbyssalSceneDescriptor,
    destroyAbyssalSceneryVisualEntity: scope.destroyAbyssalSceneryVisualEntity,
    removeRetiredAbyssalRoomRuntimeResidue: scope.removeRetiredAbyssalRoomRuntimeResidue,
    getActivePocketStateByInstanceID: scope.getActivePocketStateByInstanceID,
    beginAbyssalPocketMutationBatch: scope.beginAbyssalPocketMutationBatch,
    commitAbyssalPocketMutationBatch: scope.commitAbyssalPocketMutationBatch,
    abortAbyssalPocketMutationBatch: scope.abortAbyssalPocketMutationBatch,
    clampRoomIndex: scope.clampRoomIndex,
    buildPlaceholderRoomEntry: scope.buildPlaceholderRoomEntry,
  });
}

function composeRoomTransferContent(scope) {
  return createAbyssalRoomTransferContent({
    buildRoomShipSpawnState: scope.buildRoomShipSpawnState,
    resolveRoomOriginPosition: scope.resolveRoomOriginPosition,
    listUniquePositiveInts: scope.listUniquePositiveInts,
    getObjectPosition: scope.getObjectPosition,
    destroyPlaceholderTrace: scope.destroyPlaceholderTrace,
    destroyRoomExtractionNodes: scope.destroyRoomExtractionNodes,
    destroyRoomExtractionNodeLootContainers: scope.destroyRoomExtractionNodeLootContainers,
    destroyAbyssalSceneryVisualEntity: scope.destroyAbyssalSceneryVisualEntity,
    despawnAbyssalEnvironmentalObjectEntity: scope.despawnAbyssalEnvironmentalObjectEntity,
    listPositiveInts: scope.listPositiveInts,
    cloneValue: scope.cloneValue,
    setAbyssalRoomEntityDeliveryState: scope.setAbyssalRoomEntityDeliveryState,
    getActivePocketStateByInstanceID: scope.getActivePocketStateByInstanceID,
    ABYSSAL_ROOM_DELIVERY_STATE: scope.ABYSSAL_ROOM_DELIVERY_STATE,
    removeRetiredAbyssalRoomRuntimeResidue: scope.removeRetiredAbyssalRoomRuntimeResidue,
    log: scope.log,
    setPlaceholderRoomEntry: scope.setPlaceholderRoomEntry,
    logAbyssalRoomContentCleaned: scope.logAbyssalRoomContentCleaned,
    buildPocketStateForCurrentRoom: scope.buildPocketStateForCurrentRoom,
    getAbyssalParticipantRecord: scope.getAbyssalParticipantRecord,
    upsertAbyssalParticipantRosterEntry: scope.upsertAbyssalParticipantRosterEntry,
    ABYSSAL_PARTICIPANT_STATUS: scope.ABYSSAL_PARTICIPANT_STATUS,
    updatePocketState: scope.updatePocketState,
    getContentProfile: scope.getContentProfile,
    isSupportedAbyssalContentTier: scope.isSupportedAbyssalContentTier,
    hasTerminalFailureOutcome: scope.hasTerminalFailureOutcome,
    ensurePlaceholderRewardCache: scope.ensurePlaceholderRewardCache,
    logAbyssalRoomContentPrepared: scope.logAbyssalRoomContentPrepared,
    spawnPlaceholderPocketContent: scope.spawnPlaceholderPocketContent,
    settleFailedAbyssalDestinationActivation: scope.settleFailedAbyssalDestinationActivation,
  });
}

function composeRoomTransferMovement(scope) {
  return createAbyssalRoomTransferMovement({
    getActivePocketStateByInstanceID: scope.getActivePocketStateByInstanceID,
    getPendingAbyssalTransitionState: scope.getPendingAbyssalTransitionState,
    setAbyssalRoomEntityDeliveryState: scope.setAbyssalRoomEntityDeliveryState,
    ABYSSAL_ROOM_DELIVERY_STATE: scope.ABYSSAL_ROOM_DELIVERY_STATE,
    activateAbyssalRoomNpcControllers: (...args) => (0, scope.activateAbyssalRoomNpcControllers)(...args),
    activateSuppressorControllersForPocketRoom: scope.activateSuppressorControllersForPocketRoom,
    deliverSuppressorPresentationForSession: scope.deliverSuppressorPresentationForSession,
    updatePocketState: scope.updatePocketState,
    cloneValue: scope.cloneValue,
    ensureBoundaryControllerForPocketState: scope.ensureBoundaryControllerForPocketState,
    getPocketScene: scope.getPocketScene,
    stampAbyssalParticipantRoomScope: scope.stampAbyssalParticipantRoomScope,
    log: scope.log,
    formatVectorForLog: scope.formatVectorForLog,
    cleanupExactAbyssalScannerProbes: scope.cleanupExactAbyssalScannerProbes,
    abandonExactAbyssalSourceRoomPlayerCompanions: scope.abandonExactAbyssalSourceRoomPlayerCompanions,
    retireExactAbyssalSourceRoomPlayerObjects: scope.retireExactAbyssalSourceRoomPlayerObjects,
    pauseSuppressorControllersForRoom: scope.pauseSuppressorControllersForRoom,
    stopSuppressorPresentationForPocketSession: scope.stopSuppressorPresentationForPocketSession,
    clearSuppressorDebugHistoryForRun: scope.clearSuppressorDebugHistoryForRun,
    buildAbyssalClientEnvironmentSelection: scope.buildAbyssalClientEnvironmentSelection,
    beginAbyssalPocketMutationBatch: scope.beginAbyssalPocketMutationBatch,
    listAbyssalRoomRetirementEntityIDs: scope.listAbyssalRoomRetirementEntityIDs,
    normalizeAbyssalParticipantRoster: scope.normalizeAbyssalParticipantRoster,
    syncInventoryChanges: scope.syncInventoryChanges,
    getObjectPosition: scope.getObjectPosition,
    recordAbyssalEnvironmentSequenceEvent: scope.recordAbyssalEnvironmentSequenceEvent,
    advanceAbyssalRoomTransferLifecycle: scope.advanceAbyssalRoomTransferLifecycle,
    moveOtherAbyssalParticipantsToRoom: scope.moveOtherAbyssalParticipantsToRoom,
  });
}

function composeRoomTransferPublication(scope) {
  return createAbyssalRoomTransferPublication({
    getPocketScene: scope.getPocketScene,
    setAbyssalRoomEntityDeliveryState: scope.setAbyssalRoomEntityDeliveryState,
    ABYSSAL_ROOM_DELIVERY_STATE: scope.ABYSSAL_ROOM_DELIVERY_STATE,
    listAbyssalRoomBootstrapEntityIDs: scope.listAbyssalRoomBootstrapEntityIDs,
    normalizeAbyssalParticipantRoster: scope.normalizeAbyssalParticipantRoster,
    ABYSSAL_PARTICIPANT_STATUS: scope.ABYSSAL_PARTICIPANT_STATUS,
    resolveAbyssalRosterParticipantSession: scope.resolveAbyssalRosterParticipantSession,
    listUniquePositiveInts: scope.listUniquePositiveInts,
    log: scope.log,
    recordAbyssalEnvironmentSequenceEvent: scope.recordAbyssalEnvironmentSequenceEvent,
    advanceAbyssalRoomTransferLifecycle: scope.advanceAbyssalRoomTransferLifecycle,
    getPlaceholderRoomEntry: scope.getPlaceholderRoomEntry,
    buildAbyssalDestinationRequirements: scope.buildAbyssalDestinationRequirements,
    settleFailedAbyssalDestinationActivation: scope.settleFailedAbyssalDestinationActivation,
    markAbyssalRoomContentDelivered: scope.markAbyssalRoomContentDelivered,
    markAbyssalDungeonRoomWithoutGenericNotification: scope.markAbyssalDungeonRoomWithoutGenericNotification,
    selectAbyssalClientEnvironmentForSession: scope.selectAbyssalClientEnvironmentForSession,
    OPTIONAL_CLOUD_PRESENTATION_NOT_AUTHORED: scope.OPTIONAL_CLOUD_PRESENTATION_NOT_AUTHORED,
    sendAbyssalDungeonExitNotification: scope.sendAbyssalDungeonExitNotification,
    sendAbyssalLocationEnteredNotification: scope.sendAbyssalLocationEnteredNotification,
    sendAbyssalLocationExitNotification: scope.sendAbyssalLocationExitNotification,
    updateAbyssalClientEnvironmentDeliveryState: scope.updateAbyssalClientEnvironmentDeliveryState,
    getActivePocketStateByInstanceID: scope.getActivePocketStateByInstanceID,
    updatePocketState: scope.updatePocketState,
    cloneValue: scope.cloneValue,
  });
}

function composeRoomTransferActivation(scope) {
  return createAbyssalRoomTransferActivation({
    refreshAbyssalDungeonTrackingState: scope.refreshAbyssalDungeonTrackingState,
    activateAbyssalRoomNpcControllers: (...args) => (0, scope.activateAbyssalRoomNpcControllers)(...args),
    settleFailedAbyssalDestinationActivation: scope.settleFailedAbyssalDestinationActivation,
    cloneValue: scope.cloneValue,
    activateSuppressorControllersForPocketRoom: scope.activateSuppressorControllersForPocketRoom,
    ensureBoundaryControllerForPocketState: scope.ensureBoundaryControllerForPocketState,
    getActivePocketStateByInstanceID: scope.getActivePocketStateByInstanceID,
    evaluateEnvironmentalEffectsForPocketState: scope.evaluateEnvironmentalEffectsForPocketState,
    applyAbyssalWeatherToRun: scope.applyAbyssalWeatherToRun,
    getContentProfile: scope.getContentProfile,
    buildAbyssalDestinationMechanicsReadiness: (...args) => (0, scope.buildAbyssalDestinationMechanicsReadiness)(...args),
    deliverSuppressorPresentationForSession: scope.deliverSuppressorPresentationForSession,
    logAbyssalRoomContentActivated: scope.logAbyssalRoomContentActivated,
    recordAbyssalEnvironmentSequenceEvent: scope.recordAbyssalEnvironmentSequenceEvent,
    advanceAbyssalRoomTransferLifecycle: scope.advanceAbyssalRoomTransferLifecycle,
    updateAbyssalClientEnvironmentDeliveryState: scope.updateAbyssalClientEnvironmentDeliveryState,
    getPocketScene: scope.getPocketScene,
    listCurrentRoomBootstrapEntityIDs: scope.listCurrentRoomBootstrapEntityIDs,
    markAbyssalRoomContentDelivered: scope.markAbyssalRoomContentDelivered,
  });
}

function composeRoomTransferExecution(scope) {
  return createAbyssalRoomTransferExecution({
    getPlaceholderRoomEntry: scope.getPlaceholderRoomEntry,
    buildAbyssalClientEnvironmentSelection: scope.buildAbyssalClientEnvironmentSelection,
    hasPrewarmedPlaceholderRoomContent: scope.hasPrewarmedPlaceholderRoomContent,
    buildEncounterStateFromRoomEntry: scope.buildEncounterStateFromRoomEntry,
    setPlaceholderRoomEntry: scope.setPlaceholderRoomEntry,
    buildAbyssalTransferDestinationRoomEntry: scope.buildAbyssalTransferDestinationRoomEntry,
    buildPocketStateForCurrentRoom: scope.buildPocketStateForCurrentRoom,
    buildAbyssalParticipantRoomScopeMetadata: scope.buildAbyssalParticipantRoomScopeMetadata,
    usesIsolatedAbyssalScene: scope.usesIsolatedAbyssalScene,
    buildAbyssalSceneDescriptor: scope.buildAbyssalSceneDescriptor,
    log: scope.log,
    abortAbyssalPocketMutationBatch: scope.abortAbyssalPocketMutationBatch,
    settleFailedAbyssalDestinationActivation: scope.settleFailedAbyssalDestinationActivation,
    getActivePocketStateByInstanceID: scope.getActivePocketStateByInstanceID,
    cloneValue: scope.cloneValue,
    restoreAbyssalTransferSourceRoom: scope.restoreAbyssalTransferSourceRoom,
    isSessionReadyForIncrementalSpaceDelivery: scope.isSessionReadyForIncrementalSpaceDelivery,
    buildPlaceholderRoomState: scope.buildPlaceholderRoomState,
    getPendingAbyssalTransitionState: scope.getPendingAbyssalTransitionState,
    getAbyssalParticipantRecord: scope.getAbyssalParticipantRecord,
    commitAbyssalPocketMutationBatch: scope.commitAbyssalPocketMutationBatch,
    commitAbyssalTransferSourceRoom: scope.commitAbyssalTransferSourceRoom,
    deliverAbyssalTransferParticipants: scope.deliverAbyssalTransferParticipants,
    cleanAbyssalTransferSourceRoom: scope.cleanAbyssalTransferSourceRoom,
    prepareAbyssalTransferDestinationContent: scope.prepareAbyssalTransferDestinationContent,
    publishAbyssalTransferDestination: scope.publishAbyssalTransferDestination,
    activateAbyssalTransferDestination: scope.activateAbyssalTransferDestination,
    getDependencies: scope.getDependencies,
  });
}

// Construction-only lexical links. Leaves receive their existing explicit
// capabilities, never this scope or an arbitrary dependency resolver.
function createAbyssalRoomTransferComposition(dependencies) {
  const scope = Object.freeze(Object.create(dependencies, {
    spawnPlaceholderPocketContent: { get: () => roomMaterialization.spawnPlaceholderPocketContent },
    buildAbyssalTransferDestinationRoomEntry: { get: () => roomTransferContent.buildAbyssalTransferDestinationRoomEntry },
    restoreAbyssalTransferSourceRoom: { get: () => roomTransferMovement.restoreAbyssalTransferSourceRoom },
    commitAbyssalTransferSourceRoom: { get: () => roomTransferMovement.commitAbyssalTransferSourceRoom },
    deliverAbyssalTransferParticipants: { get: () => roomTransferMovement.deliverAbyssalTransferParticipants },
    cleanAbyssalTransferSourceRoom: { get: () => roomTransferContent.cleanAbyssalTransferSourceRoom },
    prepareAbyssalTransferDestinationContent: { get: () => roomTransferContent.prepareAbyssalTransferDestinationContent },
    publishAbyssalTransferDestination: { get: () => roomTransferPublication.publishAbyssalTransferDestination },
    activateAbyssalTransferDestination: { get: () => roomTransferActivation.activateAbyssalTransferDestination },
  }));
  const roomMaterialization = composeRoomMaterialization(scope);
  const roomPrewarming = composeRoomPrewarming(scope);
  const roomTransferContent = composeRoomTransferContent(scope);
  const roomTransferMovement = composeRoomTransferMovement(scope);
  const roomTransferPublication = composeRoomTransferPublication(scope);
  const roomTransferActivation = composeRoomTransferActivation(scope);
  const roomTransferExecution = composeRoomTransferExecution(scope);
  return Object.freeze({
    ...roomMaterialization,
    ...roomPrewarming,
    ...roomTransferContent,
    ...roomTransferMovement,
    ...roomTransferPublication,
    ...roomTransferActivation,
    ...roomTransferExecution,
  });
}

module.exports = { createAbyssalRoomTransferComposition };
