"use strict";

const { createAbyssalWeatherModel } = require("./abyssalWeatherModel");
const { createAbyssalWeatherRuntime } = require("./abyssalWeatherRuntime");
const { createAbyssalEnvironmentControllerAdapters } = require("./abyssalEnvironmentControllerAdapters");
const { createAbyssalEnvironmentModel } = require("./abyssalEnvironmentModel");
const { createAbyssalEnvironmentObjects } = require("./abyssalEnvironmentObjects");
const { createAbyssalClientEnvironment } = require("./abyssalClientEnvironment");
const { createAbyssalSceneryModel } = require("./abyssalSceneryModel");
const { createAbyssalSceneryRuntime } = require("./abyssalSceneryRuntime");

function composeWeatherModel(scope) {
  return createAbyssalWeatherModel({
    getContentProfile: scope.getContentProfile,
    cloneValue: scope.cloneValue,
    normalizeLowerText: scope.normalizeLowerText,
    resolveDarkWeatherSelection: scope.resolveDarkWeatherSelection,
    toReal: scope.toReal,
    round6: scope.round6,
    ABYSSAL_WEATHER_PRESENTATION_STAGES_BY_TYPE: scope.ABYSSAL_WEATHER_PRESENTATION_STAGES_BY_TYPE,
    DOGMA_OP_POST_PERCENT: scope.DOGMA_OP_POST_PERCENT,
    ABYSSAL_WEATHER_SHIP_ATTRIBUTE_NAME_TO_ID: scope.ABYSSAL_WEATHER_SHIP_ATTRIBUTE_NAME_TO_ID,
    ABYSSAL_WEATHER_TURRET_GROUP_IDS: scope.ABYSSAL_WEATHER_TURRET_GROUP_IDS,
    ATTRIBUTE_MAX_RANGE: scope.ATTRIBUTE_MAX_RANGE,
    ATTRIBUTE_FALLOFF: scope.ATTRIBUTE_FALLOFF,
    ABYSSAL_WEATHER_SYNTHETIC_ATTRIBUTE_RANGE_PERCENT: scope.ABYSSAL_WEATHER_SYNTHETIC_ATTRIBUTE_RANGE_PERCENT,
  });
}

function composeWeatherRuntime(scope) {
  return createAbyssalWeatherRuntime({
    getDependencies: scope.getDependencies,
    cloneValue: scope.cloneValue,
    normalizeLowerText: scope.normalizeLowerText,
    getActivePocketStateForShipID: scope.getActivePocketStateForShipID,
    getResolvedWeatherState: scope.getResolvedWeatherState,
    resolveExactAbyssalRunRoomScope: scope.resolveExactAbyssalRunRoomScope,
    getActivePocketStateByInstanceID: scope.getActivePocketStateByInstanceID,
    buildPlaceholderRoomState: scope.buildPlaceholderRoomState,
    isRetainedAbyssalPlayerCompanion: scope.isRetainedAbyssalPlayerCompanion,
    inspectAbyssalPlayerCreatedObjectAuthority: scope.inspectAbyssalPlayerCreatedObjectAuthority,
    ABYSSAL_PLAYER_ATTRIBUTE_SOURCE_KEY: scope.ABYSSAL_PLAYER_ATTRIBUTE_SOURCE_KEY,
    seedMissingAbyssalResonanceBaseAttributes: scope.seedMissingAbyssalResonanceBaseAttributes,
    applyModifierGroups: scope.applyModifierGroups,
    ATTRIBUTE_MAX_VELOCITY: scope.ATTRIBUTE_MAX_VELOCITY,
    ATTRIBUTE_SCAN_RESOLUTION: scope.ATTRIBUTE_SCAN_RESOLUTION,
    ATTRIBUTE_CAPACITOR_RECHARGE_RATE: scope.ATTRIBUTE_CAPACITOR_RECHARGE_RATE,
    ATTRIBUTE_SHIELD_CAPACITY: scope.ATTRIBUTE_SHIELD_CAPACITY,
    ATTRIBUTE_ARMOR_HP: scope.ATTRIBUTE_ARMOR_HP,
    ABYSSAL_WEATHER_SHIP_ATTRIBUTE_NAME_TO_ID: scope.ABYSSAL_WEATHER_SHIP_ATTRIBUTE_NAME_TO_ID,
    repairAppliedAbyssalResonanceAttributes: scope.repairAppliedAbyssalResonanceAttributes,
    getPocketScene: scope.getPocketScene,
    listPocketHostileEntityIDs: scope.listPocketHostileEntityIDs,
    getEntityPassiveAttributeMap: scope.getEntityPassiveAttributeMap,
    log: scope.log,
    buildRoomLogContext: scope.buildRoomLogContext,
    rememberAbyssalWeatherDiagnostics: scope.rememberAbyssalWeatherDiagnostics,
    getCharacterID: scope.getCharacterID,
  });
}

function composeEnvironmentControllerAdapters(scope) {
  return createAbyssalEnvironmentControllerAdapters({
    getDependencies: scope.getDependencies,
    FILETIME_TICKS_PER_MS: scope.FILETIME_TICKS_PER_MS,
    FILETIME_UNIX_EPOCH_OFFSET: scope.FILETIME_UNIX_EPOCH_OFFSET,
    buildAbyssalSuppressorStartFxOptions: scope.buildAbyssalSuppressorStartFxOptions,
    isSuppressorDebugEnabled: scope.isSuppressorDebugEnabled,
    log: scope.log,
    buildPlaceholderRoomState: scope.buildPlaceholderRoomState,
    clampRoomIndex: scope.clampRoomIndex,
    getPocketScene: scope.getPocketScene,
    getPlaceholderRoomEntry: scope.getPlaceholderRoomEntry,
    listUniquePositiveInts: scope.listUniquePositiveInts,
    getAbyssalSuppressorPresentationProfileByTypeID: scope.getAbyssalSuppressorPresentationProfileByTypeID,
    getSuppressorController: scope.getSuppressorController,
    startSuppressorPresentationForSession: scope.startSuppressorPresentationForSession,
    listSuppressorPresentationStatesForRun: scope.listSuppressorPresentationStatesForRun,
    stopSuppressorPresentationForSession: scope.stopSuppressorPresentationForSession,
    stopSuppressorPresentationsForRun: scope.stopSuppressorPresentationsForRun,
    getActivePocketStateByInstanceID: scope.getActivePocketStateByInstanceID,
    removeSelectedMissile: scope.removeSelectedMissile,
    usesIsolatedAbyssalScene: scope.usesIsolatedAbyssalScene,
    buildAbyssalSceneDescriptor: scope.buildAbyssalSceneDescriptor,
    registerSuppressorPresentationState: scope.registerSuppressorPresentationState,
    getAbyssalSuppressorMechanicsProfileByTypeID: scope.getAbyssalSuppressorMechanicsProfileByTypeID,
    registerSuppressorController: scope.registerSuppressorController,
    activateSuppressorControllersForRoom: scope.activateSuppressorControllersForRoom,
    resolveExactAbyssalRunRoomScope: scope.resolveExactAbyssalRunRoomScope,
    normalizeLowerText: scope.normalizeLowerText,
    TYPE_UNSTABLE_ABYSSAL_DEPTHS: scope.TYPE_UNSTABLE_ABYSSAL_DEPTHS,
    resolveAbyssalLiveCombatParticipant: scope.resolveAbyssalLiveCombatParticipant,
    getPendingAbyssalTransitionState: scope.getPendingAbyssalTransitionState,
    ABYSSAL_ROOM_DELIVERY_STATE: scope.ABYSSAL_ROOM_DELIVERY_STATE,
    hasTerminalFailureOutcome: scope.hasTerminalFailureOutcome,
    isCapsuleTypeID: scope.isCapsuleTypeID,
    getObjectPosition: scope.getObjectPosition,
    round6: scope.round6,
    ensureActiveBoundaryController: scope.ensureActiveBoundaryController,
  });
}

function composeEnvironmentModel(scope) {
  return createAbyssalEnvironmentModel({
    buildPlaceholderRoomState: scope.buildPlaceholderRoomState,
    ABYSSAL_ENVIRONMENTAL_OBJECT_ROLE: scope.ABYSSAL_ENVIRONMENTAL_OBJECT_ROLE,
    resolveAbyssalRoomEntityRole: scope.resolveAbyssalRoomEntityRole,
    clampRoomIndex: scope.clampRoomIndex,
    cloneValue: scope.cloneValue,
    buildCapturedRetailIdentityState: scope.buildCapturedRetailIdentityState,
    parseCustomInfo: scope.parseCustomInfo,
    getCapturedT0DarkRoom: scope.getCapturedT0DarkRoom,
    getContentProfile: scope.getContentProfile,
    resolveAbyssalEnvironmentRoomProfile: scope.resolveAbyssalEnvironmentRoomProfile,
    resolveSelectedAbyssalBaseRoomLayoutID: scope.resolveSelectedAbyssalBaseRoomLayoutID,
    getResolvedWeatherState: scope.getResolvedWeatherState,
    normalizeLowerText: scope.normalizeLowerText,
    getObjectPosition: scope.getObjectPosition,
    resolveRoomOriginPosition: scope.resolveRoomOriginPosition,
    TYPE_ABYSSAL_PERIMETER_LIGHTS: scope.TYPE_ABYSSAL_PERIMETER_LIGHTS,
    buildRoomConduitState: scope.buildRoomConduitState,
    addVectors: scope.addVectors,
    TYPE_UNSTABLE_ABYSSAL_DEPTHS: scope.TYPE_UNSTABLE_ABYSSAL_DEPTHS,
    toReal: scope.toReal,
    getPlaceholderRoomEntry: scope.getPlaceholderRoomEntry,
    listAbyssalEnvironmentalObjectsForRoom: scope.listAbyssalEnvironmentalObjectsForRoom,
    isProceduralEnvironment: scope.isProceduralEnvironment,
  });
}

function composeEnvironmentObjects(scope) {
  return createAbyssalEnvironmentObjects({
    cleanupSuppressorControllerByRuntimeEntity: scope.cleanupSuppressorControllerByRuntimeEntity,
    getPocketScene: scope.getPocketScene,
    cleanupSuppressorPresentationStateByEntity: scope.cleanupSuppressorPresentationStateByEntity,
    getDependencies: scope.getDependencies,
    getActivePocketStateByInstanceID: scope.getActivePocketStateByInstanceID,
    evaluateAbyssalDirectCallbackTerminalGuard: scope.evaluateAbyssalDirectCallbackTerminalGuard,
    buildAbyssalDirectCallbackSuppressedResult: scope.buildAbyssalDirectCallbackSuppressedResult,
    listSuppressorControllersForRun: scope.listSuppressorControllersForRun,
    getSuppressorPresentationState: scope.getSuppressorPresentationState,
    listSuppressorPresentationStatesForRun: scope.listSuppressorPresentationStatesForRun,
    getPlaceholderRoomEntry: scope.getPlaceholderRoomEntry,
    listUniquePositiveInts: scope.listUniquePositiveInts,
    getAbyssalEnvironmentalDefinition: scope.getAbyssalEnvironmentalDefinition,
    resolveSuppressorSceneKey: scope.resolveSuppressorSceneKey,
    setPlaceholderRoomEntry: scope.setPlaceholderRoomEntry,
    cloneValue: scope.cloneValue,
    updatePocketState: scope.updatePocketState,
    buildPocketStateForCurrentRoom: scope.buildPocketStateForCurrentRoom,
    ensureAbyssalPocketPersistenceReady: scope.ensureAbyssalPocketPersistenceReady,
    stopSuppressorPresentationsForPocketRun: scope.stopSuppressorPresentationsForPocketRun,
    listAuthoredAbyssalEnvironmentalEntries: scope.listAuthoredAbyssalEnvironmentalEntries,
    listPositiveInts: scope.listPositiveInts,
    getAbyssalSuppressorMechanicsProfileByTypeID: scope.getAbyssalSuppressorMechanicsProfileByTypeID,
    ENVIRONMENTAL_EFFECT_KIND: scope.ENVIRONMENTAL_EFFECT_KIND,
    readEnvironmentalObjectStateFromItem: scope.readEnvironmentalObjectStateFromItem,
    resolveExactAbyssalRunRoomScope: scope.resolveExactAbyssalRunRoomScope,
    listExactAbyssalBoundaryCompanionEntities: scope.listExactAbyssalBoundaryCompanionEntities,
    getVectorDistance: scope.getVectorDistance,
    buildPlaceholderRoomState: scope.buildPlaceholderRoomState,
    clampRoomIndex: scope.clampRoomIndex,
    ensureSuppressorControllersForRoom: scope.ensureSuppressorControllersForRoom,
    destroyPlaceholderTrace: scope.destroyPlaceholderTrace,
    buildAbyssalSceneDescriptor: scope.buildAbyssalSceneDescriptor,
    resolveAbyssalStructureType: scope.resolveAbyssalStructureType,
    buildEnvironmentalObjectSpawnState: scope.buildEnvironmentalObjectSpawnState,
    resolvePlaceholderDurationMs: scope.resolvePlaceholderDurationMs,
    getContentProfile: scope.getContentProfile,
    buildEnvironmentalObjectCustomInfo: scope.buildEnvironmentalObjectCustomInfo,
    toReal: scope.toReal,
    spawnPocketDynamicInventoryEntity: scope.spawnPocketDynamicInventoryEntity,
    ABYSSAL_ROOM_DELIVERY_STATE: scope.ABYSSAL_ROOM_DELIVERY_STATE,
    syncInventoryChanges: scope.syncInventoryChanges,
    UNSTABLE_ABYSSAL_DEPTHS_BOUNDARY_PROFILE: scope.UNSTABLE_ABYSSAL_DEPTHS_BOUNDARY_PROFILE,
    listPocketHostileEntityIDs: scope.listPocketHostileEntityIDs,
    evaluateAbyssalEnvironmentalEffects: scope.evaluateAbyssalEnvironmentalEffects,
    ensureBoundaryControllerForPocketState: scope.ensureBoundaryControllerForPocketState,
    log: scope.log,
  });
}

function composeClientEnvironment(scope) {
  return createAbyssalClientEnvironment({
    getDependencies: scope.getDependencies,
    cloneValue: scope.cloneValue,
    log: scope.log,
    buildPlaceholderRoomState: scope.buildPlaceholderRoomState,
    clampRoomIndex: scope.clampRoomIndex,
    getContentProfile: scope.getContentProfile,
    resolveAbyssalEnvironmentRoomProfileForPocket: scope.resolveAbyssalEnvironmentRoomProfileForPocket,
    buildAbyssalSceneDescriptor: scope.buildAbyssalSceneDescriptor,
    usesIsolatedAbyssalScene: scope.usesIsolatedAbyssalScene,
    getAbyssalContentID: scope.getAbyssalContentID,
    describeAbyssalEnvironmentSource: scope.describeAbyssalEnvironmentSource,
    normalizeLowerText: scope.normalizeLowerText,
    getResolvedWeatherState: scope.getResolvedWeatherState,
    getObjectPosition: scope.getObjectPosition,
    resolveRoomOriginPosition: scope.resolveRoomOriginPosition,
    buildDict: scope.buildDict,
    listAbyssalRoomBootstrapEntityIDs: scope.listAbyssalRoomBootstrapEntityIDs,
    getPlaceholderRoomEntry: scope.getPlaceholderRoomEntry,
    listUniquePositiveInts: scope.listUniquePositiveInts,
    isAbyssalHostLocationID: scope.isAbyssalHostLocationID,
    PROXY_NODE_ID: scope.PROXY_NODE_ID,
    OPTIONAL_CLOUD_PRESENTATION_NOT_AUTHORED: scope.OPTIONAL_CLOUD_PRESENTATION_NOT_AUTHORED,
    updatePocketStateBestEffort: scope.updatePocketStateBestEffort,
    getActivePocketStateByInstanceID: scope.getActivePocketStateByInstanceID,
    abyssalPendingWorkRegistry: scope.abyssalPendingWorkRegistry,
    ABYSSAL_POST_SETSTATE_ENVIRONMENT_RETRY_DELAY_MS: scope.ABYSSAL_POST_SETSTATE_ENVIRONMENT_RETRY_DELAY_MS,
    // Readiness consumes the environment ports below; no callback runs at construction.
    flushPendingAbyssalEntryReadyWork: (...args) => (0, scope.flushPendingAbyssalEntryReadyWork)(...args),
  });
}

function composeSceneryModel(scope) {
  return createAbyssalSceneryModel({
    ABYSSAL_SCENERY_VISUAL_ROLE: scope.ABYSSAL_SCENERY_VISUAL_ROLE,
    ABYSSAL_SCENERY_STATIC_ITEM_ID_BASE: scope.ABYSSAL_SCENERY_STATIC_ITEM_ID_BASE,
    getContentProfile: scope.getContentProfile,
    resolveSelectedAbyssalBaseRoomLayoutID: scope.resolveSelectedAbyssalBaseRoomLayoutID,
    resolveAbyssalBaseRoomSceneryProfile: scope.resolveAbyssalBaseRoomSceneryProfile,
    isCapturedT0DarkContent: scope.isCapturedT0DarkContent,
    getCapturedT0DarkRoom: scope.getCapturedT0DarkRoom,
    T0_DARK_RETAIL_CAPTURED_PROFILE_ID: scope.T0_DARK_RETAIL_CAPTURED_PROFILE_ID,
    normalizeLowerText: scope.normalizeLowerText,
    SCENERY_POLICY_EXPERIMENTAL: scope.SCENERY_POLICY_EXPERIMENTAL,
    T0_DARK_RETAIL_CAPTURED_LAYOUT_VARIANT: scope.T0_DARK_RETAIL_CAPTURED_LAYOUT_VARIANT,
    cloneValue: scope.cloneValue,
    toReal: scope.toReal,
    resolveGeneratedAuthoredAbyssalSceneryProfile: scope.resolveGeneratedAuthoredAbyssalSceneryProfile,
    resolveT0TranquilRetailCapturedSceneryProfile: scope.resolveT0TranquilRetailCapturedSceneryProfile,
    SCENERY_POLICY_AUTHORITATIVE: scope.SCENERY_POLICY_AUTHORITATIVE,
    getDependencies: scope.getDependencies,
    buildPlaceholderRoomState: scope.buildPlaceholderRoomState,
    isAbyssalSceneryVisualsRequested: scope.isAbyssalSceneryVisualsRequested,
    ABYSSAL_SCENERY_GUARD_STATUS: scope.ABYSSAL_SCENERY_GUARD_STATUS,
    isSupportedCalmSceneryContentProfile: scope.isSupportedCalmSceneryContentProfile,
    getObjectPosition: scope.getObjectPosition,
    addVectors: scope.addVectors,
    normalizeDirection: scope.normalizeDirection,
    scaleVector: scope.scaleVector,
    ABYSSAL_ROOM_DELIVERY_STATE: scope.ABYSSAL_ROOM_DELIVERY_STATE,
    resolveAbyssalRoomEntityRole: scope.resolveAbyssalRoomEntityRole,
    ABYSSAL_SCENERY_PROBE_PROFILE: scope.ABYSSAL_SCENERY_PROBE_PROFILE,
    ABYSSAL_ROOM_ENTITY_ROLES: scope.ABYSSAL_ROOM_ENTITY_ROLES,
  });
}

function composeSceneryRuntime(scope) {
  return createAbyssalSceneryRuntime({
    getPocketScene: scope.getPocketScene,
    isAbyssalEnvironmentVisualEntity: scope.isAbyssalEnvironmentVisualEntity,
    getDependencies: scope.getDependencies,
    getActivePocketStateByInstanceID: scope.getActivePocketStateByInstanceID,
    cloneValue: scope.cloneValue,
    resolveAbyssalSceneryProfile: scope.resolveAbyssalSceneryProfile,
    buildPlaceholderRoomState: scope.buildPlaceholderRoomState,
    getPlaceholderRoomEntry: scope.getPlaceholderRoomEntry,
    setPlaceholderRoomEntry: scope.setPlaceholderRoomEntry,
    updatePocketState: scope.updatePocketState,
    buildPocketStateForCurrentRoom: scope.buildPocketStateForCurrentRoom,
    listAbyssalSceneryProfileEntries: scope.listAbyssalSceneryProfileEntries,
    buildAbyssalSceneryVisualItemID: scope.buildAbyssalSceneryVisualItemID,
    buildAbyssalSceneryVisualEntity: scope.buildAbyssalSceneryVisualEntity,
    listUniquePositiveInts: scope.listUniquePositiveInts,
    getActivePocketStateForSession: scope.getActivePocketStateForSession,
    isAbyssalSceneryVisualsRequested: scope.isAbyssalSceneryVisualsRequested,
    ABYSSAL_SCENERY_GUARD_STATUS: scope.ABYSSAL_SCENERY_GUARD_STATUS,
    getContentProfile: scope.getContentProfile,
    isSupportedCalmSceneryContentProfile: scope.isSupportedCalmSceneryContentProfile,
    resolveAbyssalSceneryProbeCandidate: scope.resolveAbyssalSceneryProbeCandidate,
    resolveAbyssalSceneryProbePreset: scope.resolveAbyssalSceneryProbePreset,
    buildAbyssalSceneryProbeEntity: scope.buildAbyssalSceneryProbeEntity,
    ABYSSAL_SCENERY_PROBE_PROFILE: scope.ABYSSAL_SCENERY_PROBE_PROFILE,
    getObjectPosition: scope.getObjectPosition,
    getAbyssalSceneryProbeCandidateIndex: scope.getAbyssalSceneryProbeCandidateIndex,
    listAbyssalSceneryProbeCandidateKeys: scope.listAbyssalSceneryProbeCandidateKeys,
    normalizeLowerText: scope.normalizeLowerText,
  });
}

// Construction-only lexical links. Leaves receive their existing explicit
// capabilities, never this scope or an arbitrary dependency resolver.
function createAbyssalEnvironmentComposition(dependencies) {
  const scope = Object.freeze(Object.create(dependencies, {
    getResolvedWeatherState: { get: () => weatherModel.getResolvedWeatherState },
    seedMissingAbyssalResonanceBaseAttributes: { get: () => weatherModel.seedMissingAbyssalResonanceBaseAttributes },
    repairAppliedAbyssalResonanceAttributes: { get: () => weatherModel.repairAppliedAbyssalResonanceAttributes },
    resolveSuppressorSceneKey: { get: () => environmentControllerAdapters.resolveSuppressorSceneKey },
    stopSuppressorPresentationsForPocketRun: { get: () => environmentControllerAdapters.stopSuppressorPresentationsForPocketRun },
    listAuthoredAbyssalEnvironmentalEntries: { get: () => environmentModel.listAuthoredAbyssalEnvironmentalEntries },
    readEnvironmentalObjectStateFromItem: { get: () => environmentModel.readEnvironmentalObjectStateFromItem },
    listExactAbyssalBoundaryCompanionEntities: { get: () => environmentControllerAdapters.listExactAbyssalBoundaryCompanionEntities },
    ensureSuppressorControllersForRoom: { get: () => environmentControllerAdapters.ensureSuppressorControllersForRoom },
    buildEnvironmentalObjectSpawnState: { get: () => environmentModel.buildEnvironmentalObjectSpawnState },
    buildEnvironmentalObjectCustomInfo: { get: () => environmentModel.buildEnvironmentalObjectCustomInfo },
    ensureBoundaryControllerForPocketState: { get: () => environmentControllerAdapters.ensureBoundaryControllerForPocketState },
    resolveAbyssalEnvironmentRoomProfileForPocket: { get: () => environmentModel.resolveAbyssalEnvironmentRoomProfileForPocket },
    isAbyssalEnvironmentVisualEntity: { get: () => sceneryModel.isAbyssalEnvironmentVisualEntity },
    resolveAbyssalSceneryProfile: { get: () => sceneryModel.resolveAbyssalSceneryProfile },
    listAbyssalSceneryProfileEntries: { get: () => sceneryModel.listAbyssalSceneryProfileEntries },
    buildAbyssalSceneryVisualItemID: { get: () => sceneryModel.buildAbyssalSceneryVisualItemID },
    buildAbyssalSceneryVisualEntity: { get: () => sceneryModel.buildAbyssalSceneryVisualEntity },
    buildAbyssalSceneryProbeEntity: { get: () => sceneryModel.buildAbyssalSceneryProbeEntity },
  }));
  const weatherModel = composeWeatherModel(scope);
  const weatherRuntime = composeWeatherRuntime(scope);
  const environmentControllerAdapters = composeEnvironmentControllerAdapters(scope);
  const environmentModel = composeEnvironmentModel(scope);
  const environmentObjects = composeEnvironmentObjects(scope);
  const clientEnvironment = composeClientEnvironment(scope);
  const sceneryModel = composeSceneryModel(scope);
  const sceneryRuntime = composeSceneryRuntime(scope);
  return Object.freeze({
    ...weatherModel,
    ...weatherRuntime,
    ...environmentControllerAdapters,
    ...environmentModel,
    ...environmentObjects,
    ...clientEnvironment,
    ...sceneryModel,
    ...sceneryRuntime,
  });
}

module.exports = { createAbyssalEnvironmentComposition };
