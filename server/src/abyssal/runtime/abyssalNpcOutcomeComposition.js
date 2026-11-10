"use strict";

const { createAbyssalNpcDeathOperations } = require("./abyssalNpcDeathState");
const { createAbyssalNpcDestruction } = require("./abyssalNpcDestruction");
const { createAbyssalRoomReadiness } = require("./abyssalRoomReadiness");

function composeNpcDeathState(scope) {
  return createAbyssalNpcDeathOperations({
    getDependencies: scope.getDependencies,
    listUniquePositiveInts: scope.listUniquePositiveInts,
    getActivePocketStateByInstanceID: scope.getActivePocketStateByInstanceID,
    evaluateAbyssalDirectCallbackTerminalGuard: scope.evaluateAbyssalDirectCallbackTerminalGuard,
    deleteObjectiveDeath: (...args) => scope.abyssalPendingWorkRegistry.deleteObjectiveDeath(...args),
    setObjectiveDeath: (...args) => scope.abyssalPendingWorkRegistry.setObjectiveDeath(...args),
    listObjectiveDeaths: (...args) => scope.abyssalPendingWorkRegistry.listObjectiveDeaths(...args),
    clearObjectiveDeaths: (...args) => scope.abyssalPendingWorkRegistry.clearObjectiveDeaths(...args),
    buildPlaceholderRoomState: scope.buildPlaceholderRoomState,
    buildAbyssalSceneDescriptor: scope.buildAbyssalSceneDescriptor,
    cloneValue: scope.cloneValue,
    log: scope.log,
    handleAbyssalNpcDestroyed: (...args) => (0, scope.handleAbyssalNpcDestroyed)(...args),
  });
}

function composeNpcDestruction(scope) {
  return createAbyssalNpcDestruction({
    getDependencies: scope.getDependencies,
    buildAbyssalNpcDestroyedResult: scope.buildAbyssalNpcDestroyedResult,
    getActivePocketStateByInstanceID: scope.getActivePocketStateByInstanceID,
    evaluateAbyssalDirectCallbackTerminalGuard: scope.evaluateAbyssalDirectCallbackTerminalGuard,
    deleteObjectiveDeath: (runID, itemID) => scope.abyssalPendingWorkRegistry.deleteObjectiveDeath(runID, itemID),
    inspectAbyssalNpcDestructionAuthority: scope.inspectAbyssalNpcDestructionAuthority,
    buildPlaceholderRoomState: scope.buildPlaceholderRoomState,
    getPlaceholderRoomEntry: scope.getPlaceholderRoomEntry,
    reconcileControllerDependantLifecycleOnNpcDestroyed: scope.reconcileControllerDependantLifecycleOnNpcDestroyed,
    cloneValue: scope.cloneValue,
    listUniquePositiveInts: scope.listUniquePositiveInts,
    log: scope.log,
    getRoomObjectiveIDSets: scope.getRoomObjectiveIDSets,
    runPlaceholderPocketMaintenance: scope.runPlaceholderPocketMaintenance,
    setPlaceholderRoomEntry: scope.setPlaceholderRoomEntry,
    updatePocketState: scope.updatePocketState,
    buildPocketStateForCurrentRoom: scope.buildPocketStateForCurrentRoom,
    refreshAbyssalDungeonTrackingState: scope.refreshAbyssalDungeonTrackingState,
    recordAuditEvent: scope.recordAuditEvent,
    beginAbyssalPocketMutationBatch: scope.beginAbyssalPocketMutationBatch,
    abortAbyssalPocketMutationBatch: scope.abortAbyssalPocketMutationBatch,
    queuePendingAbyssalNpcDestroyed: scope.queuePendingAbyssalNpcDestroyed,
    commitAbyssalPocketMutationBatch: scope.commitAbyssalPocketMutationBatch,
  });
}

function composeRoomReadiness(scope) {
  return createAbyssalRoomReadiness({
    getDependencies: scope.getDependencies,
    getActivePocketStateByInstanceID: scope.getActivePocketStateByInstanceID,
    buildPlaceholderRoomState: scope.buildPlaceholderRoomState,
    getPlaceholderRoomEntry: scope.getPlaceholderRoomEntry,
    listUniquePositiveInts: scope.listUniquePositiveInts,
    getPocketScene: scope.getPocketScene,
    resolveAbyssalLiveCombatParticipant: scope.resolveAbyssalLiveCombatParticipant,
    resolveExactAbyssalRunRoomScope: scope.resolveExactAbyssalRunRoomScope,
    listActiveAbyssalRoomNpcIDs: scope.listActiveAbyssalRoomNpcIDs,
    buildAbyssalEnvironmentalMaterializationReadiness: scope.buildAbyssalEnvironmentalMaterializationReadiness,
    buildAbyssalEnvironmentalEffectReadiness: scope.buildAbyssalEnvironmentalEffectReadiness,
    listSuppressorControllersForRun: scope.listSuppressorControllersForRun,
    buildAbyssalDestinationRequirements: scope.buildAbyssalDestinationRequirements,
    hasTerminalFailureOutcome: scope.hasTerminalFailureOutcome,
    isAbyssalWeatherApplicationReady: scope.isAbyssalWeatherApplicationReady,
    cloneValue: scope.cloneValue,
    log: scope.log,
    buildAbyssalSceneDescriptor: scope.buildAbyssalSceneDescriptor,
    sceneBubbleHasEntity: scope.sceneBubbleHasEntity,
    getObjectPosition: scope.getObjectPosition,
    isAbyssalSceneryVisualsRequested: scope.isAbyssalSceneryVisualsRequested,
    SCENERY_POLICY_AUTHORITATIVE: scope.SCENERY_POLICY_AUTHORITATIVE,
    buildAbyssalNpcControllerReadiness: (...args) => (0, scope.buildAbyssalNpcControllerReadiness)(...args),
    normalizeLowerText: scope.normalizeLowerText,
  });
}

// Construction-only lexical links. Leaves receive their existing explicit
// capabilities, never this scope or an arbitrary dependency resolver.
function createAbyssalNpcOutcomeComposition(dependencies) {
  const scope = Object.freeze(Object.create(dependencies, {
    handleAbyssalNpcDestroyed: { get: () => npcDestruction.handleAbyssalNpcDestroyed },
    buildAbyssalNpcDestroyedResult: { get: () => npcDeathState.buildAbyssalNpcDestroyedResult },
    inspectAbyssalNpcDestructionAuthority: { get: () => npcDeathState.inspectAbyssalNpcDestructionAuthority },
    getRoomObjectiveIDSets: { get: () => npcDeathState.getRoomObjectiveIDSets },
    queuePendingAbyssalNpcDestroyed: { get: () => npcDeathState.queuePendingAbyssalNpcDestroyed },
  }));
  const npcDeathState = composeNpcDeathState(scope);
  const npcDestruction = composeNpcDestruction(scope);
  const roomReadiness = composeRoomReadiness(scope);
  return Object.freeze({
    ...npcDeathState,
    ...npcDestruction,
    ...roomReadiness,
  });
}

module.exports = { createAbyssalNpcOutcomeComposition };
