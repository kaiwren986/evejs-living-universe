"use strict";

const { createAbyssalRewardPlans } = require("./abyssalRewardPlans");
const { createAbyssalRewardMaterialization } = require("./abyssalRewardMaterialization");
const { createAbyssalRewardArtifactReconciliation } = require("./abyssalRewardArtifactReconciliation");
const { createAbyssalRewardLifecycle } = require("./abyssalRewardLifecycle");
const { createAbyssalRewardCacheOrchestration } = require("./abyssalRewardCache");
const { createAbyssalExtractionNodes } = require("./abyssalExtractionNodes");
const { createAbyssalRewardArtifactDestruction } = require("./abyssalRewardArtifactDestruction");

function composeRewardPlans(scope) {
  return createAbyssalRewardPlans({
    getDependencies: scope.getDependencies,
    cloneValue: scope.cloneValue,
    getPlaceholderRoomEntry: scope.getPlaceholderRoomEntry,
    setPlaceholderRoomEntry: scope.setPlaceholderRoomEntry,
    buildPocketStateForCurrentRoom: scope.buildPocketStateForCurrentRoom,
    updatePocketState: scope.updatePocketState,
    ensureAbyssalPocketPersistenceReady: scope.ensureAbyssalPocketPersistenceReady,
    buildPlaceholderRoomState: scope.buildPlaceholderRoomState,
    validateObservedRunRewardAllocation: scope.validateObservedRunRewardAllocation,
    validateAbyssalRewardPlanContext: scope.validateAbyssalRewardPlanContext,
    buildAbyssalRewardPlan: scope.buildAbyssalRewardPlan,
    isObservedRunRewardAllocationProfile: scope.isObservedRunRewardAllocationProfile,
    buildObservedRunRewardAllocation: scope.buildObservedRunRewardAllocation,
    hasLegacyObservedRunRewardPlanState: scope.hasLegacyObservedRunRewardPlanState,
    buildLegacyObservedRunRewardProfile: scope.buildLegacyObservedRunRewardProfile,
  });
}

function composeMaterialization(scope) {
  return createAbyssalRewardMaterialization({
    getDependencies: scope.getDependencies,
    cloneValue: scope.cloneValue,
    parseCustomInfo: scope.parseCustomInfo,
    ensureAbyssalPocketPersistenceReady: scope.ensureAbyssalPocketPersistenceReady,
    getContentProfile: scope.getContentProfile,
    resolvePlaceholderDurationMs: scope.resolvePlaceholderDurationMs,
    spawnPocketDynamicInventoryEntity: scope.spawnPocketDynamicInventoryEntity,
    syncInventoryChanges: scope.syncInventoryChanges,
    nextAbyssalLootRandom: scope.nextAbyssalLootRandom,
    listUniquePositiveInts: scope.listUniquePositiveInts,
    CATEGORY_BLUEPRINT: scope.CATEGORY_BLUEPRINT,
    TYPE_CAPTURED_TRIGLAVIAN_BIOADAPTIVE_CACHE: scope.TYPE_CAPTURED_TRIGLAVIAN_BIOADAPTIVE_CACHE,
    TYPE_ABYSSAL_BIOCOMBINATIVE_CACHE: scope.TYPE_ABYSSAL_BIOCOMBINATIVE_CACHE,
    TYPE_ABYSSAL_BIOCOMBINATIVE_CACHE_WRECK: scope.TYPE_ABYSSAL_BIOCOMBINATIVE_CACHE_WRECK,
    TYPE_CAPTURED_TRIGLAVIAN_BIOADAPTIVE_CACHE_WRECK: scope.TYPE_CAPTURED_TRIGLAVIAN_BIOADAPTIVE_CACHE_WRECK,
    TYPE_ABYSSAL_EXTRACTION_SUBNODE: scope.TYPE_ABYSSAL_EXTRACTION_SUBNODE,
    TYPE_ABYSSAL_EXTRACTION_SUBNODE_WRECK: scope.TYPE_ABYSSAL_EXTRACTION_SUBNODE_WRECK,
    TYPE_ABYSSAL_EXTRACTION_NODE_WRECK: scope.TYPE_ABYSSAL_EXTRACTION_NODE_WRECK,
    ABYSSAL_BLUEPRINT_COPY_MIN_RUNS: scope.ABYSSAL_BLUEPRINT_COPY_MIN_RUNS,
    ABYSSAL_BLUEPRINT_COPY_MAX_RUNS: scope.ABYSSAL_BLUEPRINT_COPY_MAX_RUNS,
  });
}

function composeArtifactReconciliation(scope) {
  return createAbyssalRewardArtifactReconciliation({
    getDependencies: scope.getDependencies,
    listUniquePositiveInts: scope.listUniquePositiveInts,
    buildAbyssalSceneDescriptor: scope.buildAbyssalSceneDescriptor,
    destroyPlaceholderTrace: scope.destroyPlaceholderTrace,
    resolveInventoryItemLogicalQuantity: scope.resolveInventoryItemLogicalQuantity,
    suppressAbyssalRoomRewards: (...args) => (0, scope.suppressAbyssalRoomRewards)(...args),
    ensureAbyssalPocketPersistenceReady: scope.ensureAbyssalPocketPersistenceReady,
  });
}

function composeLifecycle(scope) {
  return createAbyssalRewardLifecycle({
    getDependencies: scope.getDependencies,
    getActivePocketStateByInstanceID: scope.getActivePocketStateByInstanceID,
    getPlaceholderRoomEntry: scope.getPlaceholderRoomEntry,
    cloneValue: scope.cloneValue,
    getCacheProfile: scope.getCacheProfile,
    resolveRoomRewardProfile: scope.resolveRoomRewardProfile,
    ensureAbyssalRewardPlan: scope.ensureAbyssalRewardPlan,
    resolveRewardContainerType: scope.resolveRewardContainerType,
    retryAbyssalRewardLootContainer: scope.retryAbyssalRewardLootContainer,
    buildRewardCacheCustomInfo: scope.buildRewardCacheCustomInfo,
    getRewardTierMultiplierApplied: scope.getRewardTierMultiplierApplied,
    markAbyssalRewardPlanGranted: scope.markAbyssalRewardPlanGranted,
    setPlaceholderRoomEntry: scope.setPlaceholderRoomEntry,
    listUniquePositiveInts: scope.listUniquePositiveInts,
    updatePocketState: scope.updatePocketState,
    buildPocketStateForCurrentRoom: scope.buildPocketStateForCurrentRoom,
    ensureAbyssalPocketPersistenceReady: scope.ensureAbyssalPocketPersistenceReady,
    resolveRoomExtractionNodeProfile: scope.resolveRoomExtractionNodeProfile,
    resolveExtractionNodeContainerType: scope.resolveExtractionNodeContainerType,
    buildExtractionNodeCustomInfo: scope.buildExtractionNodeCustomInfo,
    refreshAbyssalDungeonTrackingState: scope.refreshAbyssalDungeonTrackingState,
    getRewardState: scope.getRewardState,
    buildPlaceholderRoomState: scope.buildPlaceholderRoomState,
    clampRoomIndex: scope.clampRoomIndex,
    log: scope.log,
    listAuthoritativeAbyssalRoomRewardArtifacts: scope.listAuthoritativeAbyssalRoomRewardArtifacts,
    readRewardCacheStateFromItem: scope.readRewardCacheStateFromItem,
    readExtractionNodeStateFromItem: scope.readExtractionNodeStateFromItem,
    buildAbyssalSceneDescriptor: scope.buildAbyssalSceneDescriptor,
    destroyPlaceholderTrace: scope.destroyPlaceholderTrace,
    parseCustomInfo: scope.parseCustomInfo,
    evaluateAbyssalDirectCallbackTerminalGuard: scope.evaluateAbyssalDirectCallbackTerminalGuard,
    buildAbyssalDirectCallbackSuppressedResult: scope.buildAbyssalDirectCallbackSuppressedResult,
    TYPE_ABYSSAL_EXTRACTION_SUBNODE_WRECK: scope.TYPE_ABYSSAL_EXTRACTION_SUBNODE_WRECK,
    TYPE_ABYSSAL_EXTRACTION_NODE_WRECK: scope.TYPE_ABYSSAL_EXTRACTION_NODE_WRECK,
  });
}

function composeCache(scope) {
  return createAbyssalRewardCacheOrchestration({
    markAbyssalRewardPlanGranted: scope.markAbyssalRewardPlanGranted,
    applyAbyssalBlueprintCopyStates: scope.applyAbyssalBlueprintCopyStates,
    toReal: scope.toReal,
    getDependencies: scope.getDependencies,
    getCacheProfile: scope.getCacheProfile,
    resolveRewardContainerType: scope.resolveRewardContainerType,
    listAuthoritativeAbyssalRoomRewardArtifacts: scope.listAuthoritativeAbyssalRoomRewardArtifacts,
    readRewardCacheStateFromItem: scope.readRewardCacheStateFromItem,
    failClosedAbyssalRewardArtifactReconciliation: scope.failClosedAbyssalRewardArtifactReconciliation,
    getPlaceholderRoomEntry: scope.getPlaceholderRoomEntry,
    getRewardState: scope.getRewardState,
    resolveRoomRewardProfile: scope.resolveRoomRewardProfile,
    ensureAbyssalRewardPlan: scope.ensureAbyssalRewardPlan,
    cloneValue: scope.cloneValue,
    isIntentionallyEmptyObservedRunRoomRewardPlan: scope.isIntentionallyEmptyObservedRunRoomRewardPlan,
    hasLegacyObservedRunRewardPlanState: scope.hasLegacyObservedRunRewardPlanState,
    setPlaceholderRoomEntry: scope.setPlaceholderRoomEntry,
    buildPlaceholderRoomState: scope.buildPlaceholderRoomState,
    buildPocketStateForCurrentRoom: scope.buildPocketStateForCurrentRoom,
    updatePocketState: scope.updatePocketState,
    resolveAbyssalRewardGrantManifest: scope.resolveAbyssalRewardGrantManifest,
    removeDuplicateAbyssalRoomRewardArtifacts: scope.removeDuplicateAbyssalRoomRewardArtifacts,
    listUniquePositiveInts: scope.listUniquePositiveInts,
    inspectAbyssalRewardContainerManifest: scope.inspectAbyssalRewardContainerManifest,
    buildAbyssalRewardManifestReceiptKey: scope.buildAbyssalRewardManifestReceiptKey,
    isTerminalAbyssalRewardMaterializationError: scope.isTerminalAbyssalRewardMaterializationError,
    ensureAbyssalPocketPersistenceReady: scope.ensureAbyssalPocketPersistenceReady,
    spawnPocketDynamicInventoryEntity: scope.spawnPocketDynamicInventoryEntity,
    log: scope.log,
    getActivePocketStateByInstanceID: scope.getActivePocketStateByInstanceID,
    clampRoomIndex: scope.clampRoomIndex,
    retryPendingAbyssalRewardMaterializations: scope.retryPendingAbyssalRewardMaterializations,
    getAbyssalRoomRewardSuppressionReason: scope.getAbyssalRoomRewardSuppressionReason,
    markRewardCacheConsumedOrRemoved: scope.markRewardCacheConsumedOrRemoved,
    markRewardCacheUnavailable: scope.markRewardCacheUnavailable,
    hasFailedTimeoutOutcome: scope.hasFailedTimeoutOutcome,
    getContentProfile: scope.getContentProfile,
    resolveRoomEncounterProfile: scope.resolveRoomEncounterProfile,
    summarizeRewardLootEntries: scope.summarizeRewardLootEntries,
    listGuaranteedRewardLootEntries: scope.listGuaranteedRewardLootEntries,
    resolveAbyssalStructureType: scope.resolveAbyssalStructureType,
    buildRewardCacheSpawnState: scope.buildRewardCacheSpawnState,
    resolvePlaceholderDurationMs: scope.resolvePlaceholderDurationMs,
    buildRewardCacheCustomInfo: scope.buildRewardCacheCustomInfo,
    getRewardTierMultiplierApplied: scope.getRewardTierMultiplierApplied,
    resolveRoomOriginPosition: scope.resolveRoomOriginPosition,
    syncInventoryChanges: scope.syncInventoryChanges,
    formatVectorForLog: scope.formatVectorForLog,
    TYPE_ABYSSAL_BIOCOMBINATIVE_CACHE: scope.TYPE_ABYSSAL_BIOCOMBINATIVE_CACHE,
    PLACEHOLDER_REWARD_CACHE_MAX_REPAIRS: scope.PLACEHOLDER_REWARD_CACHE_MAX_REPAIRS,
    ABYSSAL_ROOM_DELIVERY_STATE: scope.ABYSSAL_ROOM_DELIVERY_STATE,
    ABYSSAL_ROOM_ENTITY_ROLES: scope.ABYSSAL_ROOM_ENTITY_ROLES,
  });
}

function composeExtractionNodes(scope) {
  return createAbyssalExtractionNodes({
    getDependencies: scope.getDependencies,
    isTranquilAbyssalContent: scope.isTranquilAbyssalContent,
    getPlaceholderRoomEntry: scope.getPlaceholderRoomEntry,
    listUniquePositiveInts: scope.listUniquePositiveInts,
    readExtractionNodeStateFromItem: scope.readExtractionNodeStateFromItem,
    destroyPlaceholderTrace: scope.destroyPlaceholderTrace,
    buildAbyssalSceneDescriptor: scope.buildAbyssalSceneDescriptor,
    setPlaceholderRoomEntry: scope.setPlaceholderRoomEntry,
    updatePocketState: scope.updatePocketState,
    buildPocketStateForCurrentRoom: scope.buildPocketStateForCurrentRoom,
    log: scope.log,
    listAuthoritativeAbyssalRoomRewardArtifacts: scope.listAuthoritativeAbyssalRoomRewardArtifacts,
    failClosedAbyssalRewardArtifactReconciliation: scope.failClosedAbyssalRewardArtifactReconciliation,
    spawnPocketDynamicInventoryEntity: scope.spawnPocketDynamicInventoryEntity,
    ensureAbyssalPocketPersistenceReady: scope.ensureAbyssalPocketPersistenceReady,
    removeDuplicateAbyssalRoomRewardArtifacts: scope.removeDuplicateAbyssalRoomRewardArtifacts,
    getActivePocketStateByInstanceID: scope.getActivePocketStateByInstanceID,
    cloneValue: scope.cloneValue,
    buildPlaceholderRoomState: scope.buildPlaceholderRoomState,
    clampRoomIndex: scope.clampRoomIndex,
    retryPendingAbyssalRewardMaterializations: scope.retryPendingAbyssalRewardMaterializations,
    getAbyssalRoomRewardSuppressionReason: scope.getAbyssalRoomRewardSuppressionReason,
    resolveRoomEncounterProfile: scope.resolveRoomEncounterProfile,
    resolveRoomExtractionNodeProfile: scope.resolveRoomExtractionNodeProfile,
    summarizeRewardLootEntries: scope.summarizeRewardLootEntries,
    hasFailedTimeoutOutcome: scope.hasFailedTimeoutOutcome,
    buildExtractionNodeSpawnStates: scope.buildExtractionNodeSpawnStates,
    resolveAbyssalStructureType: scope.resolveAbyssalStructureType,
    resolvePlaceholderDurationMs: scope.resolvePlaceholderDurationMs,
    getContentProfile: scope.getContentProfile,
    buildExtractionNodeCustomInfo: scope.buildExtractionNodeCustomInfo,
    resolveRoomOriginPosition: scope.resolveRoomOriginPosition,
    toReal: scope.toReal,
    formatVectorForLog: scope.formatVectorForLog,
    syncInventoryChanges: scope.syncInventoryChanges,
    TYPE_ABYSSAL_EXTRACTION_SUBNODE: scope.TYPE_ABYSSAL_EXTRACTION_SUBNODE,
    TYPE_ABYSSAL_EXTRACTION_NODE: scope.TYPE_ABYSSAL_EXTRACTION_NODE,
    TYPE_ABYSSAL_EXTRACTION_SUBNODE_WRECK: scope.TYPE_ABYSSAL_EXTRACTION_SUBNODE_WRECK,
    TYPE_ABYSSAL_EXTRACTION_NODE_WRECK: scope.TYPE_ABYSSAL_EXTRACTION_NODE_WRECK,
    ABYSSAL_EARLY_VISIBILITY_STATES: scope.ABYSSAL_EARLY_VISIBILITY_STATES,
    ABYSSAL_ROOM_ENTITY_ROLES: scope.ABYSSAL_ROOM_ENTITY_ROLES,
    ABYSSAL_ROOM_DELIVERY_STATE: scope.ABYSSAL_ROOM_DELIVERY_STATE,
  });
}

function composeArtifactDestruction(scope) {
  return createAbyssalRewardArtifactDestruction({
    getDependencies: scope.getDependencies,
    abyssalRunWorkStore: scope.abyssalRunWorkStore,
    getActivePocketStateByInstanceID: scope.getActivePocketStateByInstanceID,
    cloneValue: scope.cloneValue,
    getAbyssalRewardArtifactDestructionOperation: scope.getAbyssalRewardArtifactDestructionOperation,
    commitPocketStateDurably: scope.commitPocketStateDurably,
    buildAbyssalRewardArtifactDestructionOperationPatch: scope.buildAbyssalRewardArtifactDestructionOperationPatch,
    readPersistedAbyssalPocketStateFromInstance: (...args) => (0, scope.readPersistedAbyssalPocketStateFromInstance)(...args),
    getPlaceholderRoomEntry: scope.getPlaceholderRoomEntry,
    getObjectPosition: scope.getObjectPosition,
    resolveRoomOriginPosition: scope.resolveRoomOriginPosition,
    normalizeDirection: scope.normalizeDirection,
    getCapturedT0DarkRoom: scope.getCapturedT0DarkRoom,
    toReal: scope.toReal,
    normalizeLowerText: scope.normalizeLowerText,
    syncExpiredAbyssalPocketState: scope.syncExpiredAbyssalPocketState,
    evaluateAbyssalDirectCallbackTerminalGuard: scope.evaluateAbyssalDirectCallbackTerminalGuard,
    buildAbyssalDirectCallbackSuppressedResult: scope.buildAbyssalDirectCallbackSuppressedResult,
    buildPlaceholderRoomState: scope.buildPlaceholderRoomState,
    clampRoomIndex: scope.clampRoomIndex,
    getAbyssalRoomRewardSuppressionReason: scope.getAbyssalRoomRewardSuppressionReason,
    resolveRoomRewardProfile: scope.resolveRoomRewardProfile,
    ensureAbyssalRewardPlan: scope.ensureAbyssalRewardPlan,
    isIntentionallyEmptyObservedRunRoomRewardPlan: scope.isIntentionallyEmptyObservedRunRoomRewardPlan,
    listUniquePositiveInts: scope.listUniquePositiveInts,
    resolveRoomExtractionNodeProfile: scope.resolveRoomExtractionNodeProfile,
    buildResolvedExtractionNodeLootEntries: scope.buildResolvedExtractionNodeLootEntries,
    buildAbyssalRewardArtifactDestructionOperationID: scope.buildAbyssalRewardArtifactDestructionOperationID,
    buildAbyssalPersistencePendingResult: scope.buildAbyssalPersistencePendingResult,
    getAuthoritativeAbyssalPocketState: scope.getAuthoritativeAbyssalPocketState,
    setPlaceholderRoomEntry: scope.setPlaceholderRoomEntry,
    buildPocketStateForCurrentRoom: scope.buildPocketStateForCurrentRoom,
    buildAbyssalRewardManifestReceiptKey: scope.buildAbyssalRewardManifestReceiptKey,
    getAbyssalRewardArtifactDestructionOperations: scope.getAbyssalRewardArtifactDestructionOperations,
    retryPendingAbyssalRewardMaterializations: scope.retryPendingAbyssalRewardMaterializations,
    buildAbyssalSceneDescriptor: scope.buildAbyssalSceneDescriptor,
    destroyPlaceholderTrace: scope.destroyPlaceholderTrace,
  });
}

// Construction-only lexical links. Leaves receive their existing explicit
// capabilities, never this scope or an arbitrary dependency resolver.
function createAbyssalRewardComposition(dependencies) {
  const scope = Object.freeze(Object.create(dependencies, {
    resolveInventoryItemLogicalQuantity: {
      get: () => materialization.resolveInventoryItemLogicalQuantity,
    },
    suppressAbyssalRoomRewards: {
      get: () => lifecycle.suppressAbyssalRoomRewards,
    },
    ensureAbyssalRewardPlan: {
      get: () => rewardPlans.ensureAbyssalRewardPlan,
    },
    resolveRewardContainerType: {
      get: () => materialization.resolveRewardContainerType,
    },
    retryAbyssalRewardLootContainer: {
      get: () => materialization.retryAbyssalRewardLootContainer,
    },
    resolveExtractionNodeContainerType: {
      get: () => materialization.resolveExtractionNodeContainerType,
    },
    listAuthoritativeAbyssalRoomRewardArtifacts: {
      get: () => artifactReconciliation.listAuthoritativeAbyssalRoomRewardArtifacts,
    },
    applyAbyssalBlueprintCopyStates: {
      get: () => materialization.applyAbyssalBlueprintCopyStates,
    },
    failClosedAbyssalRewardArtifactReconciliation: {
      get: () => artifactReconciliation.failClosedAbyssalRewardArtifactReconciliation,
    },
    resolveAbyssalRewardGrantManifest: {
      get: () => materialization.resolveAbyssalRewardGrantManifest,
    },
    removeDuplicateAbyssalRoomRewardArtifacts: {
      get: () => artifactReconciliation.removeDuplicateAbyssalRoomRewardArtifacts,
    },
    inspectAbyssalRewardContainerManifest: {
      get: () => materialization.inspectAbyssalRewardContainerManifest,
    },
    buildAbyssalRewardManifestReceiptKey: {
      get: () => materialization.buildAbyssalRewardManifestReceiptKey,
    },
    isTerminalAbyssalRewardMaterializationError: {
      get: () => materialization.isTerminalAbyssalRewardMaterializationError,
    },
    retryPendingAbyssalRewardMaterializations: {
      get: () => lifecycle.retryPendingAbyssalRewardMaterializations,
    },
    getAbyssalRoomRewardSuppressionReason: {
      get: () => lifecycle.getAbyssalRoomRewardSuppressionReason,
    },
    markRewardCacheConsumedOrRemoved: {
      get: () => lifecycle.markRewardCacheConsumedOrRemoved,
    },
    markRewardCacheUnavailable: {
      get: () => lifecycle.markRewardCacheUnavailable,
    },
    resolveAbyssalStructureType: {
      get: () => materialization.resolveAbyssalStructureType,
    },
  }));
  const rewardPlans = composeRewardPlans(scope);
  const materialization = composeMaterialization(scope);
  const artifactReconciliation = composeArtifactReconciliation(scope);
  const lifecycle = composeLifecycle(scope);
  const cache = composeCache(scope);
  const extractionNodes = composeExtractionNodes(scope);
  const artifactDestruction = composeArtifactDestruction(scope);
  return Object.freeze({
    ...rewardPlans,
    ...materialization,
    ...artifactReconciliation,
    ...lifecycle,
    ...cache,
    ...extractionNodes,
    ...artifactDestruction,
  });
}

module.exports = { createAbyssalRewardComposition };
