"use strict";

const { createAbyssalEntryBootstrap } = require("./abyssalEntryBootstrap");
const { createAbyssalEntryReadiness } = require("./abyssalEntryReadiness");
const { createAbyssalEntryMovement } = require("./abyssalEntryMovement");

function composeEntryBootstrap(scope) {
  return createAbyssalEntryBootstrap({
    getDependencies: scope.getDependencies,
    buildAbyssalSceneDescriptor: scope.buildAbyssalSceneDescriptor,
    abyssalPendingWorkRegistry: scope.abyssalPendingWorkRegistry,
    getCharacterID: scope.getCharacterID,
    buildPlaceholderRoomState: scope.buildPlaceholderRoomState,
    cloneValue: scope.cloneValue,
    log: scope.log,
    usesIsolatedAbyssalScene: scope.usesIsolatedAbyssalScene,
    updatePocketState: scope.updatePocketState,
    getSessionContext: scope.getSessionContext,
    buildAbyssalHandoffSessionIdentity: scope.buildAbyssalHandoffSessionIdentity,
    getAbyssalParticipantRecord: scope.getAbyssalParticipantRecord,
    abyssalTraceStateRegistry: scope.abyssalTraceStateRegistry,
    pendingAbyssalTraceActivationMatchesSession: scope.pendingAbyssalTraceActivationMatchesSession,
    getActiveTraceState: scope.getActiveTraceState,
    normalizeAbyssalTraceLifecyclePhase: scope.normalizeAbyssalTraceLifecyclePhase,
    resolveAbyssalTraceProfile: scope.resolveAbyssalTraceProfile,
    ABYSSAL_TRACE_LIFECYCLE_PHASE: scope.ABYSSAL_TRACE_LIFECYCLE_PHASE,
    validateAbyssalTraceActivation: (...args) => (0, scope.validateAbyssalTraceActivation)(...args),
    captureAbyssalSpaceSessionFields: scope.captureAbyssalSpaceSessionFields,
    worldData: scope.worldData,
    addAbyssalSessionChange: scope.addAbyssalSessionChange,
    PROXY_NODE_ID: scope.PROXY_NODE_ID,
    evaluateAbyssalDirectCallbackTerminalGuard: scope.evaluateAbyssalDirectCallbackTerminalGuard,
    beginAbyssalCompatibilityRecovery: scope.beginAbyssalCompatibilityRecovery,
  });
}

function composeEntryReadiness(scope) {
  return createAbyssalEntryReadiness({
    getAbyssalEnvironmentNotificationState: scope.getAbyssalEnvironmentNotificationState,
    buildAbyssalLocationEnteredNotificationPayload: scope.buildAbyssalLocationEnteredNotificationPayload,
    log: scope.log,
    getDependencies: scope.getDependencies,
    logAbyssalEnvironmentPacketComparison: scope.logAbyssalEnvironmentPacketComparison,
    cloneValue: scope.cloneValue,
    getActivePocketStateByInstanceID: scope.getActivePocketStateByInstanceID,
    evaluateAbyssalDirectCallbackTerminalGuard: scope.evaluateAbyssalDirectCallbackTerminalGuard,
    buildAbyssalDirectCallbackSuppressedResult: scope.buildAbyssalDirectCallbackSuppressedResult,
    buildPlaceholderRoomState: scope.buildPlaceholderRoomState,
    buildAbyssalClientEnvironmentSelection: scope.buildAbyssalClientEnvironmentSelection,
    getAbyssalClientEnvironmentPrerequisites: scope.getAbyssalClientEnvironmentPrerequisites,
    updateAbyssalClientEnvironmentDeliveryState: scope.updateAbyssalClientEnvironmentDeliveryState,
    logAbyssalClientEnvironmentPrerequisiteFailure: scope.logAbyssalClientEnvironmentPrerequisiteFailure,
    scheduleBoundedAbyssalClientEnvironmentRetry: scope.scheduleBoundedAbyssalClientEnvironmentRetry,
    recordAbyssalEnvironmentSequenceEvent: scope.recordAbyssalEnvironmentSequenceEvent,
    selectAbyssalClientEnvironmentForSession: scope.selectAbyssalClientEnvironmentForSession,
    OPTIONAL_CLOUD_PRESENTATION_NOT_AUTHORED: scope.OPTIONAL_CLOUD_PRESENTATION_NOT_AUTHORED,
    sendAbyssalExpiryDurationNotification: scope.sendAbyssalExpiryDurationNotification,
    sendAbyssalDungeonExitNotification: scope.sendAbyssalDungeonExitNotification,
    refreshAbyssalDungeonTrackingState: scope.refreshAbyssalDungeonTrackingState,
    schedulePostSetStateAbyssalArrivalFx: scope.schedulePostSetStateAbyssalArrivalFx,
    sendOrQueueInitialAbyssalArrivalFx: scope.sendOrQueueInitialAbyssalArrivalFx,
    activateAbyssalRoomNpcControllers: (...args) => (0, scope.activateAbyssalRoomNpcControllers)(...args),
    logAbyssalRoomContentActivated: scope.logAbyssalRoomContentActivated,
    activateSuppressorControllersForPocketRoom: scope.activateSuppressorControllersForPocketRoom,
    deliverSuppressorPresentationForSession: scope.deliverSuppressorPresentationForSession,
    ensureBoundaryControllerForPocketState: scope.ensureBoundaryControllerForPocketState,
    getActivePocketStateForSession: scope.getActivePocketStateForSession,
  });
}

function composeEntryMovement(scope) {
  return createAbyssalEntryMovement({
    cloneValue: scope.cloneValue,
    restoreAbyssalSpaceSessionFields: scope.restoreAbyssalSpaceSessionFields,
    syncInventoryChanges: scope.syncInventoryChanges,
    log: scope.log,
    getCharacterID: scope.getCharacterID,
    validateAbyssalIsolatedSceneRuntime: scope.validateAbyssalIsolatedSceneRuntime,
    getObjectPosition: scope.getObjectPosition,
    captureAbyssalSpaceSessionFields: scope.captureAbyssalSpaceSessionFields,
    buildAbyssalParticipantRoomScopeMetadata: scope.buildAbyssalParticipantRoomScopeMetadata,
    getActivePocketStateByInstanceID: scope.getActivePocketStateByInstanceID,
    updatePocketState: scope.updatePocketState,
    ensureAbyssalPocketPersistenceReady: scope.ensureAbyssalPocketPersistenceReady,
    schedulePlaceholderPocketMaintenance: scope.schedulePlaceholderPocketMaintenance,
    formatVectorForLog: scope.formatVectorForLog,
    resolveAbyssalParticipantRoomScopePersistence: scope.resolveAbyssalParticipantRoomScopePersistence,
    buildPlaceholderRoomState: scope.buildPlaceholderRoomState,
    buildAbyssalEntrySessionChanges: scope.buildAbyssalEntrySessionChanges,
    applyAbyssalEntrySessionFields: scope.applyAbyssalEntrySessionFields,
    sendAbyssalEntrySessionChange: scope.sendAbyssalEntrySessionChange,
    setAbyssalSessionState: scope.setAbyssalSessionState,
    stampAbyssalParticipantRoomScope: scope.stampAbyssalParticipantRoomScope,
    usesAuthoredAbyssalEnvironmentNotification: scope.usesAuthoredAbyssalEnvironmentNotification,
    markAbyssalDungeonRoomWithoutGenericNotification: scope.markAbyssalDungeonRoomWithoutGenericNotification,
    shouldAttemptAuthoredSiteMaterialization: scope.shouldAttemptAuthoredSiteMaterialization,
    recordAuditEvent: scope.recordAuditEvent,
    summarizeContentSummary: scope.summarizeContentSummary,
    upsertAbyssalParticipantRosterEntry: scope.upsertAbyssalParticipantRosterEntry,
    ABYSSAL_PARTICIPANT_STATUS: scope.ABYSSAL_PARTICIPANT_STATUS,
    toReal: scope.toReal,
    getObjectRadius: scope.getObjectRadius,
    resolveTypeRecord: scope.resolveTypeRecord,
    registerPocket: scope.registerPocket,
    shouldUseCorrelatedAbyssalSpaceEmpiricalContent: scope.shouldUseCorrelatedAbyssalSpaceEmpiricalContent,
    getContentProfile: scope.getContentProfile,
    countMaterializedContent: scope.countMaterializedContent,
    getDependencies: scope.getDependencies,
  });
}

// Construction-only lexical links. Leaves receive their existing explicit
// capabilities, never this scope or an arbitrary dependency resolver.
function createAbyssalEntryComposition(dependencies) {
  const scope = Object.freeze(Object.create(dependencies, {
    buildAbyssalEntrySessionChanges: { get: () => entryBootstrap.buildAbyssalEntrySessionChanges },
    applyAbyssalEntrySessionFields: { get: () => entryBootstrap.applyAbyssalEntrySessionFields },
    sendAbyssalEntrySessionChange: { get: () => entryBootstrap.sendAbyssalEntrySessionChange },
  }));
  const entryBootstrap = composeEntryBootstrap(scope);
  const entryReadiness = composeEntryReadiness(scope);
  const entryMovement = composeEntryMovement(scope);
  return Object.freeze({
    ...entryBootstrap,
    ...entryReadiness,
    ...entryMovement,
  });
}

module.exports = { createAbyssalEntryComposition };
