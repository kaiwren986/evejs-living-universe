"use strict";

const { createAbyssalAdmissionValidation } = require("./abyssalAdmissionValidation");
const { createAbyssalTraceValidation } = require("./abyssalTraceValidation");
const { createAbyssalTraceRollback } = require("./abyssalTraceRollback");
const { createAbyssalRunCreation } = require("./abyssalRunCreation");
const { createAbyssalExitValidation } = require("./abyssalExitValidation");

function composeAdmissionValidation(scope) {
  return createAbyssalAdmissionValidation({
    getDependencies: scope.getDependencies,
    toReal: scope.toReal,
    normalizeLowerText: scope.normalizeLowerText,
    isAbyssalHostLocationID: scope.isAbyssalHostLocationID,
    buildAbyssalShipStateBlock: scope.buildAbyssalShipStateBlock,
    VOID_SYSTEM_ID_MIN: scope.VOID_SYSTEM_ID_MIN,
    VOID_SYSTEM_ID_MAX: scope.VOID_SYSTEM_ID_MAX,
    SOLAR_SYSTEM_ZARZAKH: scope.SOLAR_SYSTEM_ZARZAKH,
    isAbyssalShipInsideForceField: scope.isAbyssalShipInsideForceField,
    getAbyssalShipCloakMode: scope.getAbyssalShipCloakMode,
    isEntityWarpScrambled: (shipEntity) => scope.hostileModuleRuntime &&
      typeof scope.hostileModuleRuntime.isEntityWarpScrambled === "function" &&
      scope.hostileModuleRuntime.isEntityWarpScrambled(shipEntity),
    hasActiveAbyssalCynosuralGeneration: scope.hasActiveAbyssalCynosuralGeneration,
    getSessionContext: scope.getSessionContext,
    resolveActivateForFleet: scope.resolveActivateForFleet,
    resetPersistedAbyssalRunsAfterServerRestart: scope.resetPersistedAbyssalRunsAfterServerRestart,
    ensureSystemStalePlaceholderCleanup: scope.ensureSystemStalePlaceholderCleanup,
    ABYSS_ERROR: scope.ABYSS_ERROR,
    ABYSS_ERROR_KIND: scope.ABYSS_ERROR_KIND,
    buildValidationError: scope.buildValidationError,
    resolveExistingActiveRunConflict: scope.resolveExistingActiveRunConflict,
    resolveShipClassProfile: scope.resolveShipClassProfile,
    getGroupID: scope.getGroupID,
    getGroupName: scope.getGroupName,
    resolveFilamentItemID: scope.resolveFilamentItemID,
    isAbyssalFilamentItem: scope.isAbyssalFilamentItem,
    resolveTypeRecord: scope.resolveTypeRecord,
    resolveFilamentContentDefinition: scope.resolveFilamentContentDefinition,
    getItemQuantity: scope.getItemQuantity,
    isFleetRequiredForAbyssalShipProfile: scope.isFleetRequiredForAbyssalShipProfile,
    resolveAuthoritativeAbyssalFleetMembership: scope.resolveAuthoritativeAbyssalFleetMembership,
    resolveAbyssalSecurityPolicy: scope.resolveAbyssalSecurityPolicy,
    buildDeployStateFromShipEntity: scope.buildDeployStateFromShipEntity,
    findPlacementConflict: scope.findPlacementConflict,
    MIN_DISTANCE_FROM_DISALLOWED_OBJECTS_METERS: scope.MIN_DISTANCE_FROM_DISALLOWED_OBJECTS_METERS,
  });
}

function composeTraceValidation(scope) {
  return createAbyssalTraceValidation({
    ABYSSAL_PARTICIPANT_STATUS: scope.ABYSSAL_PARTICIPANT_STATUS,
    ABYSSAL_TERMINAL_PARTICIPANT_STATUSES: scope.ABYSSAL_TERMINAL_PARTICIPANT_STATUSES,
    ABYSSAL_TRACE_LIFECYCLE_PHASE: scope.ABYSSAL_TRACE_LIFECYCLE_PHASE,
    ABYSS_ERROR: scope.ABYSS_ERROR,
    ABYSS_ERROR_KIND: scope.ABYSS_ERROR_KIND,
    TRACE_ACTIVATION_RANGE_METERS: scope.TRACE_ACTIVATION_RANGE_METERS,
    TYPE_ABYSSAL_TRACE: scope.TYPE_ABYSSAL_TRACE,
    getPendingTraceActivation: (traceItemID) => scope.abyssalTraceStateRegistry.getPendingActivation(traceItemID),
    getRunByTraceID: (traceItemID) => scope.activeAbyssalRunRegistry.getByTraceID(traceItemID),
    buildValidationError: scope.buildValidationError,
    canRecoverCreatedAbyssalTraceAfterRestart: scope.canRecoverCreatedAbyssalTraceAfterRestart,
    cloneValue: scope.cloneValue,
    ensureSystemStalePlaceholderCleanup: scope.ensureSystemStalePlaceholderCleanup,
    evaluateAbyssalShipActivationState: scope.evaluateAbyssalShipActivationState,
    evaluateGateActivationRange: scope.evaluateGateActivationRange,
    expireCreatedAbyssalTrace: scope.expireCreatedAbyssalTrace,
    getAbyssalParticipantRecord: scope.getAbyssalParticipantRecord,
    getActivePocketStateByInstanceID: scope.getActivePocketStateByInstanceID,
    getActivePocketStateForCharacterID: scope.getActivePocketStateForCharacterID,
    getActiveTraceState: scope.getActiveTraceState,
    getDependencies: scope.getDependencies,
    getGroupID: scope.getGroupID,
    getGroupName: scope.getGroupName,
    getObjectPosition: scope.getObjectPosition,
    getObjectRadius: scope.getObjectRadius,
    getPendingAbyssalTransitionState: scope.getPendingAbyssalTransitionState,
    getSessionContext: scope.getSessionContext,
    isCreatedAbyssalTraceExpired: scope.isCreatedAbyssalTraceExpired,
    isFleetRequiredForAbyssalShipProfile: scope.isFleetRequiredForAbyssalShipProfile,
    listUniquePositiveInts: scope.listUniquePositiveInts,
    normalizeAbyssalParticipantRoster: scope.normalizeAbyssalParticipantRoster,
    normalizeAbyssalTraceLifecyclePhase: scope.normalizeAbyssalTraceLifecyclePhase,
    normalizeDirection: scope.normalizeDirection,
    normalizeLowerText: scope.normalizeLowerText,
    persistTraceState: scope.persistTraceState,
    resetPersistedAbyssalRunsAfterServerRestart: scope.resetPersistedAbyssalRunsAfterServerRestart,
    resolveAbyssalParticipantAdmissionState: scope.resolveAbyssalParticipantAdmissionState,
    resolveAbyssalSecurityPolicy: scope.resolveAbyssalSecurityPolicy,
    resolveCurrentAuthoritativeAbyssalFleetMembership: scope.resolveCurrentAuthoritativeAbyssalFleetMembership,
    resolveFilamentContentDefinition: scope.resolveFilamentContentDefinition,
    resolveGateTraceID: scope.resolveGateTraceID,
    resolveShipClassProfile: scope.resolveShipClassProfile,
    resolveTraceContentProfile: scope.resolveTraceContentProfile,
    resolveTypeRecord: scope.resolveTypeRecord,
    toReal: scope.toReal,
    upsertAbyssalParticipantRosterEntry: scope.upsertAbyssalParticipantRosterEntry,
  });
}

function composeTraceRollback(scope) {
  return createAbyssalTraceRollback({
    getDependencies: scope.getDependencies,
    getActiveTraceState: scope.getActiveTraceState,
    stageAbyssalFilamentCompensationClaim: scope.stageAbyssalFilamentCompensationClaim,
    log: scope.log,
    getRunByTraceID: (traceItemID) => scope.activeAbyssalRunRegistry.getByTraceID(traceItemID),
    cancelPendingAbyssalTransition: scope.cancelPendingAbyssalTransition,
    persistPendingAbyssalEntryRecovery: scope.persistPendingAbyssalEntryRecovery,
    getActivePocketStateByInstanceID: scope.getActivePocketStateByInstanceID,
    ABYSSAL_ENTRY_RECOVERY_REASON: scope.ABYSSAL_ENTRY_RECOVERY_REASON,
    reconcilePendingAbyssalEntryRecovery: scope.reconcilePendingAbyssalEntryRecovery,
    cloneValue: scope.cloneValue,
    logPendingAbyssalTraceActivation: scope.logPendingAbyssalTraceActivation,
    clearPendingAbyssalTraceActivation: scope.clearPendingAbyssalTraceActivation,
    normalizeAbyssalTraceLifecyclePhase: scope.normalizeAbyssalTraceLifecyclePhase,
    ABYSSAL_TRACE_LIFECYCLE_PHASE: scope.ABYSSAL_TRACE_LIFECYCLE_PHASE,
    transitionSourceTraceState: scope.transitionSourceTraceState,
    scheduleCreatedAbyssalTraceExpiry: scope.scheduleCreatedAbyssalTraceExpiry,
    ensureSourceTraceRuntime: scope.ensureSourceTraceRuntime,
    removeOwnedSourceTrace: scope.removeOwnedSourceTrace,
    settleAbyssalFilamentCompensationClaim: scope.settleAbyssalFilamentCompensationClaim,
    markAbyssalFilamentCompensationTraceInvalidated: scope.markAbyssalFilamentCompensationTraceInvalidated,
  });
}

function composeRunCreation(scope) {
  return createAbyssalRunCreation({
    getDependencies: scope.getDependencies,
    getRunByTraceID: (traceItemID) => scope.activeAbyssalRunRegistry.getByTraceID(traceItemID),
    cloneValue: scope.cloneValue,
    buildPocketSiteKey: scope.buildPocketSiteKey,
    buildPocketStateFromInstance: scope.buildPocketStateFromInstance,
    registerPocket: scope.registerPocket,
    logRecoveredT0DarkLayoutSelection: scope.logRecoveredT0DarkLayoutSelection,
    logRecoveredAbyssalBaseRoomLayoutSelection: scope.logRecoveredAbyssalBaseRoomLayoutSelection,
    logRecoveredAbyssalSceneMode: scope.logRecoveredAbyssalSceneMode,
    buildSourceTransitionState: scope.buildSourceTransitionState,
    resolveAbyssalTemplateID: scope.resolveAbyssalTemplateID,
    getContentProfile: scope.getContentProfile,
    selectAbyssalEnvironmentLayoutVariant: scope.selectAbyssalEnvironmentLayoutVariant,
    randomUUID: () => scope.crypto.randomUUID(),
    buildNewT0DarkLayoutSelection: scope.buildNewT0DarkLayoutSelection,
    selectAbyssalBaseRoomLayouts: scope.selectAbyssalBaseRoomLayouts,
    resolveAbyssalSceneModeState: scope.resolveAbyssalSceneModeState,
    ABYSSAL_SCENE_MODE_ISOLATED: scope.ABYSSAL_SCENE_MODE_ISOLATED,
    log: scope.log,
    allocateAbyssalSpatialReservation: scope.allocateAbyssalSpatialReservation,
    formatVectorForLog: scope.formatVectorForLog,
    buildPlaceholderPocketPosition: scope.buildPlaceholderPocketPosition,
    buildPlaceholderShipSpaceState: scope.buildPlaceholderShipSpaceState,
    buildPlaceholderRoomState: scope.buildPlaceholderRoomState,
    upsertAbyssalParticipantRosterEntry: scope.upsertAbyssalParticipantRosterEntry,
    ABYSSAL_PARTICIPANT_STATUS: scope.ABYSSAL_PARTICIPANT_STATUS,
    normalizeAbyssalParticipantRoster: scope.normalizeAbyssalParticipantRoster,
    getNpcRuntimePolicy: scope.getNpcRuntimePolicy,
    ABYSSAL_PARTICIPANT_ROSTER_SCHEMA_VERSION: scope.ABYSSAL_PARTICIPANT_ROSTER_SCHEMA_VERSION,
    listUniquePositiveInts: scope.listUniquePositiveInts,
    buildPersistedAbyssalContentProfile: (...args) => (0, scope.buildPersistedAbyssalContentProfile)(...args),
    buildAbyssalWeatherState: scope.buildAbyssalWeatherState,
    PLACEHOLDER_POCKET_MODE: scope.PLACEHOLDER_POCKET_MODE,
    PLACEHOLDER_POCKET_ISOLATION: scope.PLACEHOLDER_POCKET_ISOLATION,
    deleteT0DarkLayoutOverride: (characterID) => scope.abyssalPendingWorkRegistry.deleteT0DarkLayoutOverride(characterID),
    logNewT0DarkLayoutSelection: scope.logNewT0DarkLayoutSelection,
    logAbyssalBaseRoomLayoutSelection: scope.logAbyssalBaseRoomLayoutSelection,
    releaseHostSlot: (runID, identity) => scope.abyssalHostSlotAllocator.release(runID, identity),
  });
}

function composeExitValidation(scope) {
  return createAbyssalExitValidation({
    getDependencies: scope.getDependencies,
    getSessionContext: scope.getSessionContext,
    getActivePocketStateByMarkerItemID: scope.getActivePocketStateByMarkerItemID,
    getActivePocketStateForSession: scope.getActivePocketStateForSession,
    syncExpiredAbyssalPocketState: scope.syncExpiredAbyssalPocketState,
    readPocketMarkerStateFromItem: scope.readPocketMarkerStateFromItem,
    buildPlaceholderRoomState: scope.buildPlaceholderRoomState,
    getPlaceholderRoomEntry: scope.getPlaceholderRoomEntry,
    log: scope.log,
    getAbyssalParticipantRecord: scope.getAbyssalParticipantRecord,
    isAbyssalParticipantInRun: scope.isAbyssalParticipantInRun,
    evaluateAbyssalDirectCallbackTerminalGuard: scope.evaluateAbyssalDirectCallbackTerminalGuard,
    resolveAbyssalTerminalCallbackReason: scope.resolveAbyssalTerminalCallbackReason,
    listUniquePositiveInts: scope.listUniquePositiveInts,
    suppressAbyssalRoomRewards: scope.suppressAbyssalRoomRewards,
    retryPendingAbyssalRewardMaterializations: scope.retryPendingAbyssalRewardMaterializations,
    hasTerminalFailureOutcome: scope.hasTerminalFailureOutcome,
    normalizeLowerText: scope.normalizeLowerText,
    ensureAbyssalPocketPersistenceReady: scope.ensureAbyssalPocketPersistenceReady,
    buildAbyssalRoomProgressionPolicyInput: scope.buildAbyssalRoomProgressionPolicyInput,
    TYPE_ABYSSAL_ORIGIN_CONDUIT: scope.TYPE_ABYSSAL_ORIGIN_CONDUIT,
    TYPE_ABYSSAL_TRANSFER_CONDUIT: scope.TYPE_ABYSSAL_TRANSFER_CONDUIT,
    getPocketScene: scope.getPocketScene,
    resolveExactAbyssalRunRoomScope: scope.resolveExactAbyssalRunRoomScope,
    ABYSSAL_ROOM_ENTITY_ROLES: scope.ABYSSAL_ROOM_ENTITY_ROLES,
    evaluateGateActivationRange: scope.evaluateGateActivationRange,
    CONDUIT_ACTIVATION_RANGE_METERS: scope.CONDUIT_ACTIVATION_RANGE_METERS,
    buildAbyssalRoomObjectivePolicyInput: scope.buildAbyssalRoomObjectivePolicyInput,
    buildRoomLogContext: scope.buildRoomLogContext,
  });
}

// Construction-only lexical links. Leaves receive their existing explicit
// capabilities, never this scope or an arbitrary dependency resolver.
function createAbyssalAdmissionComposition(dependencies) {
  const scope = Object.freeze(Object.create(dependencies, {
    evaluateAbyssalShipActivationState: { get: () => admissionValidation.evaluateAbyssalShipActivationState },
  }));
  const admissionValidation = composeAdmissionValidation(scope);
  const traceValidation = composeTraceValidation(scope);
  const traceRollback = composeTraceRollback(scope);
  const runCreation = composeRunCreation(scope);
  const exitValidation = composeExitValidation(scope);
  return Object.freeze({
    ...admissionValidation,
    ...traceValidation,
    ...traceRollback,
    ...runCreation,
    ...exitValidation,
  });
}

module.exports = { createAbyssalAdmissionComposition };
