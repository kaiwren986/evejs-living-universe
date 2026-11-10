"use strict";

function normalizeTestDependencyOverridesOperation(scope, overrides) {
  const normalized = overrides && typeof overrides === "object" ? { ...overrides } : null;
  if (!normalized) return null;
  const flatten = (accessorName, operationNames) => {
    if (typeof normalized[accessorName] !== "function") return;
    const target = normalized[accessorName]();
    for (const operationName of operationNames) {
      if (
        typeof normalized[operationName] !== "function" &&
        target && typeof target[operationName] === "function"
      ) {
        normalized[operationName] = (...args) => target[operationName](...args);
      }
    }
    delete normalized[accessorName];
  };
  flatten("getSpaceRuntime", [
    "allocateAbyssalLocationID",
    "normalizeSceneDescriptor",
    "buildAbyssalSceneKey",
    "buildSolarSystemSceneKey",
    "ensureScene",
    "getSceneByDescriptor",
    "getSceneForSession",
    "findSceneContainingDynamicEntity",
    "disposeScene",
    "ensureInitialBallpark",
    "attachSession",
    "detachSession",
    "teleportSessionShipForAbyssalTransition",
    "getEntity",
    "spawnDynamicInventoryEntity",
    "destroyDynamicInventoryEntity",
    "removeDynamicEntity",
    "refreshShipDerivedState",
    "refreshSessionShipDerivedState",
    "isEntityUndockInvulnerable",
    "grantTimedInvulnerabilityForSession",
    "deactivateAllActiveModules",
    "clearTargets",
    "applyResolvedEnvironmentalDamageToTarget",
    "playSpecialFx",
    "stopSpecialFx",
    "activateAbyssalTrace",
    "publishAbyssalTraceInitial",
    "updateAbyssalTracePresentation",
    "validateAbyssalTracePublicationReceipt",
    "summarizeAbyssalBootstrapInventory",
    "getAbyssalOfflineSessionForRun",
  ]);
  const runtime = typeof overrides.getSpaceRuntime === "function"
    ? overrides.getSpaceRuntime()
    : null;
  if (typeof normalized.hasScene !== "function") {
    normalized.hasScene = (sceneKey) => Boolean(
      runtime && runtime.scenes instanceof Map && runtime.scenes.has(sceneKey),
    );
  }
  if (
    typeof normalized.applyDroneWeaponDamageToTarget !== "function" &&
    runtime && runtime.droneInterop &&
    typeof runtime.droneInterop.applyWeaponDamageToTarget === "function"
  ) {
    normalized.applyDroneWeaponDamageToTarget = (...args) =>
      runtime.droneInterop.applyWeaponDamageToTarget(...args);
  }
  flatten("getNpcRuntime", [
    "getControllerByEntityID",
    "activateNpcController",
    "deactivateNpcControllerCombat",
    "issueAttackOrder",
    "issueOrder",
    "pauseNpcController",
    "tickNpcControllersInScene",
    "spawnBatchInSystem",
    "despawn",
  ]);
  if (typeof normalized.getNpcService === "function") {
    const npcService = normalized.getNpcService();
    if (
      typeof normalized.getNpcServiceControllerByEntityID !== "function" &&
      npcService && typeof npcService.getControllerByEntityID === "function"
    ) {
      normalized.getNpcServiceControllerByEntityID = (...args) =>
        npcService.getControllerByEntityID(...args);
    } else if (typeof normalized.getNpcServiceControllerByEntityID !== "function") {
      // Override any separately configured production capability: this legacy
      // fixture intentionally models an NPC service without controller reads.
      normalized.getNpcServiceControllerByEntityID = null;
    }
  }
  flatten("getNpcService", ["destroyNpcControllerByEntityID"]);
  flatten("getShipDestruction", ["destroySessionShip"]);
  flatten("getSessionRegistry", ["findSessionByCharacterID"]);
  if (typeof normalized.releaseAbyssalPlayerCompanionsForController !== "function") {
    // The production adapter supplies the real drone/fighter authority. The
    // legacy fixture only needs the capability to be present when a room has
    // no retained player companions; companion-specific tests inject it.
    normalized.releaseAbyssalPlayerCompanionsForController = () => ({
      success: false,
      errorMsg: "PLAYER_COMPANION_RUNTIME_RELEASE_UNAVAILABLE",
    });
  }
  if (typeof normalized.isEntityStructureTethered !== "function") {
    normalized.isEntityStructureTethered = (entity) => Boolean(
      entity &&
      entity.structureTether &&
      entity.structureTether.active === true &&
      (0, scope.toInt)(entity.structureTether.structureID, 0) > 0
    );
  }
  if (typeof normalized.getSyncInventoryItemForSession === "function") {
    normalized.syncInventoryItemForSession = normalized.getSyncInventoryItemForSession();
    delete normalized.getSyncInventoryItemForSession;
  }
  return normalized;
}

function getDependenciesOperation(scope) {
  const configuredPort = scope.abyssalEngineBindingState.getConfiguredEnginePort();
  const testOverrides = scope.abyssalEngineBindingState.getTestDependencyOverrides();
  // Supported production startup supplies the complete validated contract.
  // Do not initialize or merge the legacy defaults on that path. Standalone
  // compatibility consumers and partial fixtures retain their existing behavior.
  return {
    ...(configuredPort || (0, scope.buildDefaultDependencies)()),
    ...(testOverrides || {}),
  };
}

function syncExpiredAbyssalPocketStateOperation(scope, pocketState, nowMs = null, deps = (0, scope.getDependencies)(), explicitSession = null, terminalOptions = {}) {
  return scope.timeoutLifecycle.syncExpiredAbyssalPocketState(pocketState, nowMs, deps, explicitSession, terminalOptions);
}

function inferUnrecordedAbyssalHullLossAfterRestartOperation(scope, pocketState, session = null, deps = (0, scope.getDependencies)()) {
  return scope.deathRecovery.inferUnrecordedAbyssalHullLossAfterRestart(pocketState, session, deps);
}

function reconcileCommittedAbyssalParticipantDeathOperation(scope, pocketState, session = null, deps = (0, scope.getDependencies)()) {
  return scope.deathRecovery.reconcileCommittedAbyssalParticipantDeath(pocketState, session, deps);
}

function isTrackedAbyssalSpaceItemOperation(scope, item) {
  return Boolean((0, scope.inspectAbyssalTaggedSpaceItem)(item));
}

function rememberAbyssalCleanupReportOperation(scope, report) {
  scope.abyssalMaintenanceState.setLastCleanupReport(report);
}

function cleanupAbyssalRunOperation(scope, pocketState, deps = (0, scope.getDependencies)(), options = {}) {
  return scope.terminalCleanup.cleanupAbyssalRun(pocketState, deps, options);
}

function beginAbyssalCompatibilityRecoveryOperation(scope, session, pocketState, reason, deps = (0, scope.getDependencies)(), options = {}) {
  return scope.compatibilityRecovery.beginAbyssalCompatibilityRecovery(session, pocketState, reason, deps, options);
}

function initializeManagerGroup13Binding1(scope) {
  const ABYSSAL_MAX_REWARD_TIER = 6;
  scope.ABYSSAL_MAX_REWARD_TIER = ABYSSAL_MAX_REWARD_TIER;
}

function initializeManagerGroup13Binding2(scope) {
  const SUPPORTED_ABYSSAL_CONTENT_TIERS = Object.freeze([0, 1, 2, 3, 4, 5, 6]);
  scope.SUPPORTED_ABYSSAL_CONTENT_TIERS = SUPPORTED_ABYSSAL_CONTENT_TIERS;
}

function initializeManagerGroup13Binding3(scope) {
  const ABYSSAL_ROOM_TRANSFER_LIFECYCLE_STATES = Object.freeze([
  "prepared",
  "effect_sent",
  "ship_repositioned",
  "old_room_removed",
  "destination_delivered",
  "environment_notified",
  "room_committed",
  "controllers_activated",
  "complete",
]);
  scope.ABYSSAL_ROOM_TRANSFER_LIFECYCLE_STATES = ABYSSAL_ROOM_TRANSFER_LIFECYCLE_STATES;
}

function initializeManagerGroup13Binding4(scope) {
  const {
  buildAbyssalPocketMutationSignature,
  buildPersistedAbyssalContentProfile,
  buildPersistedAbyssalRuntimeState,
  getAbyssalPocketPersistenceVersion,
  isPersistedAbyssalContentProfileReference,
  readPersistedAbyssalPocketStateFromInstance,
  rehydratePersistedAbyssalContentProfile,
  verifyPersistedAbyssalPocketState,
} = (0, scope.createAbyssalRuntimeStateCodec)({
  cloneValue: scope.cloneValue,
  resolvePersistedFilamentDefinition: (reference) =>
    scope.AbyssalContentManagerService.resolvePersistedFilamentDefinition(reference),
});
  scope.buildAbyssalPocketMutationSignature = buildAbyssalPocketMutationSignature;
  scope.buildPersistedAbyssalContentProfile = buildPersistedAbyssalContentProfile;
  scope.buildPersistedAbyssalRuntimeState = buildPersistedAbyssalRuntimeState;
  scope.getAbyssalPocketPersistenceVersion = getAbyssalPocketPersistenceVersion;
  scope.isPersistedAbyssalContentProfileReference = isPersistedAbyssalContentProfileReference;
  scope.readPersistedAbyssalPocketStateFromInstance = readPersistedAbyssalPocketStateFromInstance;
  scope.rehydratePersistedAbyssalContentProfile = rehydratePersistedAbyssalContentProfile;
  scope.verifyPersistedAbyssalPocketState = verifyPersistedAbyssalPocketState;
}

function initializeManagerGroup13Binding5(scope) {
  const abyssalRunOutcomeCommitCoordinator = (0, scope.createAbyssalRunOutcomeCommitCoordinator)({
    readRunOutcome: scope.getActivePocketStateByInstanceID,
    updateRunOutcome: scope.updatePocketState,
  });
  scope.abyssalRunOutcomeCommitCoordinator = abyssalRunOutcomeCommitCoordinator;
}

function initializeManagerGroup13Binding6(scope) {
  const ABYSSAL_INVENTORY_ROOM_STATE_KEYS = Object.freeze([
  "evejsAbyssalPocketMarker",
  "evejsAbyssalRewardCache",
  "evejsAbyssalExtractionNode",
  "evejsAbyssalEnvironmentalObject",
  "evejsAbyssalJettisonContainer",
]);
  scope.ABYSSAL_INVENTORY_ROOM_STATE_KEYS = ABYSSAL_INVENTORY_ROOM_STATE_KEYS;
}

function initializeManagerGroup13Binding7(scope) {
  const {
  buildAbyssalNpcControllerReadiness,
  logAbyssalNpcReadiness,
  logAbyssalNpcReadinessFailures,
  pauseAbyssalObjectiveControllers,
  listAbyssalNpcControllerTargetShipIDs,
  reconcileAbyssalNpcControllerCombatTargets,
  activateAbyssalRoomNpcControllers,
} = (0, scope.createAbyssalNpcControllers)({
  getDependencies: (...args) => (0, scope.getDependencies)(...args),
  resolveEntityBubbleForScene: (...args) => (0, scope.resolveEntityBubbleForScene)(...args),
  getNpcWeaponModules: (...args) => (0, scope.getNpcWeaponModules)(...args),
  getNpcEntityMissileWeaponSource: (...args) => (0, scope.getNpcEntityMissileWeaponSource)(...args),
  buildPlaceholderRoomState: (...args) => (0, scope.buildPlaceholderRoomState)(...args),
  log: scope.log,
  listUniquePositiveInts: (...args) => (0, scope.listUniquePositiveInts)(...args),
  resolveAbyssalLiveCombatParticipant: (...args) => (0, scope.resolveAbyssalLiveCombatParticipant)(...args),
  getActivePocketStateByInstanceID: (...args) => (0, scope.getActivePocketStateByInstanceID)(...args),
  buildAbyssalSurvivorControllerSelectionRequest: (...args) => (0, scope.buildAbyssalSurvivorControllerSelectionRequest)(...args),
  cloneValue: (...args) => (0, scope.cloneValue)(...args),
  getPocketScene: (...args) => (0, scope.getPocketScene)(...args),
  getPlaceholderRoomEntry: (...args) => (0, scope.getPlaceholderRoomEntry)(...args),
  listActiveAbyssalRoomNpcIDs: (...args) => (0, scope.listActiveAbyssalRoomNpcIDs)(...args),
  getCharacterID: (...args) => (0, scope.getCharacterID)(...args),
  getAbyssalParticipantRecord: (...args) => (0, scope.getAbyssalParticipantRecord)(...args),
  updateAbyssalRoomNpcActivationState: (...args) => (0, scope.updateAbyssalRoomNpcActivationState)(...args),
  degradeAbyssalRoomNpcActivation: (...args) => (0, scope.degradeAbyssalRoomNpcActivation)(...args),
  logAbyssalRoomContentActivated: (...args) => (0, scope.logAbyssalRoomContentActivated)(...args),
});
  scope.buildAbyssalNpcControllerReadiness = buildAbyssalNpcControllerReadiness;
  scope.logAbyssalNpcReadiness = logAbyssalNpcReadiness;
  scope.logAbyssalNpcReadinessFailures = logAbyssalNpcReadinessFailures;
  scope.pauseAbyssalObjectiveControllers = pauseAbyssalObjectiveControllers;
  scope.listAbyssalNpcControllerTargetShipIDs = listAbyssalNpcControllerTargetShipIDs;
  scope.reconcileAbyssalNpcControllerCombatTargets = reconcileAbyssalNpcControllerCombatTargets;
  scope.activateAbyssalRoomNpcControllers = activateAbyssalRoomNpcControllers;
}

function initializeManagerGroup13Binding8(scope) {
  const { runAbyssalNpcControllerWatchdog } = (0, scope.createAbyssalNpcWatchdog)({
  getActivePocketStateByInstanceID: (...args) => (0, scope.getActivePocketStateByInstanceID)(...args),
  buildPlaceholderRoomState: (...args) => (0, scope.buildPlaceholderRoomState)(...args),
  getPlaceholderRoomEntry: (...args) => (0, scope.getPlaceholderRoomEntry)(...args),
  hasTerminalFailureOutcome: (...args) => (0, scope.hasTerminalFailureOutcome)(...args),
  normalizeLowerText: (...args) => (0, scope.normalizeLowerText)(...args),
  usesIsolatedAbyssalScene: (...args) => (0, scope.usesIsolatedAbyssalScene)(...args),
  listUniquePositiveInts: (...args) => (0, scope.listUniquePositiveInts)(...args),
  areAllEnteredAbyssalParticipantsTerminal: (...args) => (0, scope.areAllEnteredAbyssalParticipantsTerminal)(...args),
  pauseAbyssalObjectiveControllers: (...args) => (0, scope.pauseAbyssalObjectiveControllers)(...args),
  reconcileAbyssalNpcControllerCombatTargets: (...args) => (0, scope.reconcileAbyssalNpcControllerCombatTargets)(...args),
  buildAbyssalNpcControllerReadiness: (...args) => (0, scope.buildAbyssalNpcControllerReadiness)(...args),
  degradeAbyssalRoomNpcActivation: (...args) => (0, scope.degradeAbyssalRoomNpcActivation)(...args),
  log: scope.log,
  activateAbyssalRoomNpcControllers: (...args) => (0, scope.activateAbyssalRoomNpcControllers)(...args),
  resolveAbyssalLiveCombatParticipant: (...args) => (0, scope.resolveAbyssalLiveCombatParticipant)(...args),
});
  scope.runAbyssalNpcControllerWatchdog = runAbyssalNpcControllerWatchdog;
}

function initializeManagerGroup13Binding9(scope) {
  const ABYSSAL_MGR_CLIENT_RPC_METHODS = new Set([
  "AbyssalEntranceDeployment",
  "AbyssalEntranceGateActivation",
  "AbyssalGateActivation",
  "AbyssalEndGateActivation",
  "ClientIsReady",
]);
  scope.ABYSSAL_MGR_CLIENT_RPC_METHODS = ABYSSAL_MGR_CLIENT_RPC_METHODS;
}

function bindAbyssalManagerRuntimeGroup13Operations(scope) {
  scope.normalizeTestDependencyOverrides = function normalizeTestDependencyOverrides(overrides) {
    return normalizeTestDependencyOverridesOperation(scope, overrides);
  };
  scope.getDependencies = function getDependencies() {
    return getDependenciesOperation(scope);
  };
  scope.syncExpiredAbyssalPocketState = function syncExpiredAbyssalPocketState(pocketState, nowMs = null, deps = (0, scope.getDependencies)(), explicitSession = null, terminalOptions = {}) {
    return syncExpiredAbyssalPocketStateOperation(scope, pocketState, nowMs, deps, explicitSession, terminalOptions);
  };
  scope.inferUnrecordedAbyssalHullLossAfterRestart = function inferUnrecordedAbyssalHullLossAfterRestart(pocketState, session = null, deps = (0, scope.getDependencies)()) {
    return inferUnrecordedAbyssalHullLossAfterRestartOperation(scope, pocketState, session, deps);
  };
  scope.reconcileCommittedAbyssalParticipantDeath = function reconcileCommittedAbyssalParticipantDeath(pocketState, session = null, deps = (0, scope.getDependencies)()) {
    return reconcileCommittedAbyssalParticipantDeathOperation(scope, pocketState, session, deps);
  };
  scope.isTrackedAbyssalSpaceItem = function isTrackedAbyssalSpaceItem(item) {
    return isTrackedAbyssalSpaceItemOperation(scope, item);
  };
  scope.rememberAbyssalCleanupReport = function rememberAbyssalCleanupReport(report) {
    return rememberAbyssalCleanupReportOperation(scope, report);
  };
  scope.cleanupAbyssalRun = function cleanupAbyssalRun(pocketState, deps = (0, scope.getDependencies)(), options = {}) {
    return cleanupAbyssalRunOperation(scope, pocketState, deps, options);
  };
  scope.beginAbyssalCompatibilityRecovery = function beginAbyssalCompatibilityRecovery(session, pocketState, reason, deps = (0, scope.getDependencies)(), options = {}) {
    return beginAbyssalCompatibilityRecoveryOperation(scope, session, pocketState, reason, deps, options);
  };
}

function initializeAbyssalManagerRuntimeGroup13Part1(scope) {
  initializeManagerGroup13Binding1(scope);
  initializeManagerGroup13Binding2(scope);
  initializeManagerGroup13Binding3(scope);
  initializeManagerGroup13Binding4(scope);
  initializeManagerGroup13Binding5(scope);
  initializeManagerGroup13Binding6(scope);
  initializeManagerGroup13Binding7(scope);
  initializeManagerGroup13Binding8(scope);
  initializeManagerGroup13Binding9(scope);
}

function initializeAbyssalManagerRuntimeGroup13(scope) {
  initializeAbyssalManagerRuntimeGroup13Part1(scope);
}

module.exports = {
  bindAbyssalManagerRuntimeGroup13Operations,
  initializeAbyssalManagerRuntimeGroup13,
};
