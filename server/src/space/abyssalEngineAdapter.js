"use strict";

const path = require("path");

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
  listContainerItems,
  listSystemSpaceItems,
  moveShipToSpace,
  removeInventoryItem,
  updateInventoryItem,
  updateShipItem,
} = require(path.join(__dirname, "../services/inventory/itemStore"));
const {
  resolveItemByName,
  resolveItemByTypeID,
} = require(path.join(__dirname, "../services/inventory/itemTypeRegistry"));
const { matchesTypeList } = require(path.join(
  __dirname,
  "../services/inventory/typeListAuthority",
));
const abyssalFilamentCompensationStore = require("../abyssal").engineSupport.filamentCompensationStore;
const worldData = require(path.join(__dirname, "worldData"));
const crimewatchState = require(path.join(__dirname, "../services/security/crimewatchState"));
const fleetRuntime = require(path.join(__dirname, "../services/fleets/fleetRuntime"));
const dungeonRuntime = require(path.join(__dirname, "../services/dungeon/dungeonRuntime"));
const dungeonTrackingRuntime = require(path.join(
  __dirname,
  "../services/dungeon/dungeonTrackingRuntime",
));
const dungeonUniverseSiteService = require(path.join(
  __dirname,
  "../services/dungeon/dungeonUniverseSiteService",
));
const { queuePostSpaceAttachFittingHydration } = require(path.join(
  __dirname,
  "modules/spaceAttachHydration",
));
const npcService = require(path.join(__dirname, "npc"));
const shipDestruction = require(path.join(__dirname, "shipDestruction"));
const sessionRegistry = require(path.join(__dirname, "../services/chat/sessionRegistry"));
const characterState = require(path.join(__dirname, "../services/character/characterState"));
const industryRuntimeState = require(path.join(
  __dirname,
  "../services/industry/industryRuntimeState",
));
const probeRuntimeState = require(path.join(
  __dirname,
  "../services/exploration/probes/probeRuntimeState",
));
const droneRuntime = require(path.join(__dirname, "../services/drone/droneRuntime"));
const fighterRuntime = require(path.join(__dirname, "../services/fighter/fighterRuntime"));
const structureTethering = require(path.join(__dirname, "structureTethering"));
const {
  assertValidAbyssalEnginePort,
} = require("../abyssal").engineSupport.enginePort;

const portsByRuntime = new WeakMap();

function bindOperation(target, name) {
  if (!target || typeof target[name] !== "function") {
    const error = new Error(`ABYSSAL_ENGINE_ADAPTER_MISSING_OPERATION:${name}`);
    error.code = `ABYSSAL_ENGINE_ADAPTER_MISSING_OPERATION:${name}`;
    throw error;
  }
  return target[name].bind(target);
}

function releaseAbyssalPlayerCompanionsForController(scene, controllerEntity, options = {}) {
  const droneResult = typeof droneRuntime.handleControllerLost === "function"
    ? droneRuntime.handleControllerLost(scene, controllerEntity, {
      ...options,
      entityIDs: options.droneEntityIDs,
      attemptBayRecovery: false,
    })
    : { success: false, errorMsg: "DRONE_RUNTIME_UNAVAILABLE" };
  const fighterResult = typeof fighterRuntime.handleControllerLost === "function"
    ? fighterRuntime.handleControllerLost(scene, controllerEntity, {
      ...options,
      entityIDs: options.fighterEntityIDs,
      attemptTubeRecovery: false,
    })
    : { success: false, errorMsg: "FIGHTER_RUNTIME_UNAVAILABLE" };
  return {
    success: Boolean(
      droneResult && droneResult.success === true &&
      fighterResult && fighterResult.success === true
    ),
    droneResult,
    fighterResult,
  };
}

function createAbyssalEnginePort(spaceRuntime) {
  if (!spaceRuntime || (typeof spaceRuntime !== "object" && typeof spaceRuntime !== "function")) {
    throw new TypeError("ABYSSAL_ENGINE_ADAPTER_RUNTIME_REQUIRED");
  }
  const existing = portsByRuntime.get(spaceRuntime);
  if (existing) return existing;

  const npcRuntime = npcService.runtime;
  const port = {
    ITEM_FLAGS,
    findItemById,
    consumeInventoryItemQuantity,
    createSpaceItemForOwner,
    grantItemToOwnerLocation,
    grantItemToOwnerLocationIdempotent,
    grantItemsToOwnerLocationIdempotent,
    getIdempotentGrantReceipt,
    getAllItems,
    listContainerItems,
    listSystemSpaceItems,
    moveShipToSpace,
    removeInventoryItem,
    updateInventoryItem,
    updateShipItem,
    resolveItemByName,
    resolveItemByTypeID,
    matchesTypeList,
    readAbyssalFilamentCompensationClaim: abyssalFilamentCompensationStore.readClaim,
    persistAbyssalFilamentCompensationClaim: abyssalFilamentCompensationStore.persistClaim,
    listAbyssalFilamentCompensationClaimsForCharacter:
      abyssalFilamentCompensationStore.listClaimsForCharacter,
    worldData,
    crimewatchState,
    fleetRuntime,
    dungeonRuntime,
    dungeonTrackingRuntime,
    dungeonUniverseSiteService,
    queuePostSpaceAttachFittingHydration,
    isEntityStructureTethered: structureTethering.isEntityStructureTethered,
    // The runtime's wall clock, so activation delays, maintenance and run
    // timers judge time the way the scenes do.
    now: () => spaceRuntime.getWallclockNowMs(),
    isShipSelfDestructing: shipID => require("../services/ship/selfDestructRuntime").isShipSelfDestructing(shipID),
    isEntityFilamentBlocked: entity => require("../services/spaceComponents/shipLinkRestrictions").blocksShipAction(entity, "blocksFilament"),
    nextRandom: () => Math.random(),
    nextEncounterRandom: () => Math.random(),
    nextBoundaryRandom: () => Math.random(),
    scheduleTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
    clearScheduledTimeout: (handle) => clearTimeout(handle),
    scheduleInterval: (callback, intervalMs) => setInterval(callback, intervalMs),
    clearScheduledInterval: (handle) => clearInterval(handle),
    scheduleBoundaryInterval: (callback, intervalMs) => setInterval(callback, intervalMs),
    clearScheduledBoundaryInterval: (handle) => clearInterval(handle),
    allocateAbyssalLocationID: bindOperation(spaceRuntime, "allocateAbyssalLocationID"),
    normalizeSceneDescriptor: bindOperation(spaceRuntime, "normalizeSceneDescriptor"),
    buildAbyssalSceneKey: bindOperation(spaceRuntime, "buildAbyssalSceneKey"),
    buildSolarSystemSceneKey: bindOperation(spaceRuntime, "buildSolarSystemSceneKey"),
    hasScene: (sceneKey) => Boolean(
      spaceRuntime.scenes instanceof Map && spaceRuntime.scenes.has(sceneKey),
    ),
    ensureScene: bindOperation(spaceRuntime, "ensureScene"),
    getSceneByDescriptor: bindOperation(spaceRuntime, "getSceneByDescriptor"),
    getSceneForSession: bindOperation(spaceRuntime, "getSceneForSession"),
    findSceneContainingDynamicEntity: bindOperation(
      spaceRuntime,
      "findSceneContainingDynamicEntity",
    ),
    disposeScene: bindOperation(spaceRuntime, "disposeScene"),
    ensureInitialBallpark: bindOperation(spaceRuntime, "ensureInitialBallpark"),
    attachSession: bindOperation(spaceRuntime, "attachSession"),
    detachSession: bindOperation(spaceRuntime, "detachSession"),
    teleportSessionShipForAbyssalTransition: bindOperation(
      spaceRuntime,
      "teleportSessionShipForAbyssalTransition",
    ),
    getEntity: bindOperation(spaceRuntime, "getEntity"),
    spawnDynamicInventoryEntity: bindOperation(spaceRuntime, "spawnDynamicInventoryEntity"),
    destroyDynamicInventoryEntity: bindOperation(
      spaceRuntime,
      "destroyDynamicInventoryEntity",
    ),
    removeDynamicEntity: bindOperation(spaceRuntime, "removeDynamicEntity"),
    refreshShipDerivedState: bindOperation(spaceRuntime, "refreshShipDerivedState"),
    isEntityUndockInvulnerable: bindOperation(spaceRuntime, "isEntityUndockInvulnerable"),
    grantTimedInvulnerabilityForSession: bindOperation(
      spaceRuntime,
      "grantTimedInvulnerabilityForSession",
    ),
    getControllerByEntityID: bindOperation(npcRuntime, "getControllerByEntityID"),
    activateNpcController: bindOperation(npcRuntime, "activateNpcController"),
    deactivateNpcControllerCombat: bindOperation(npcRuntime, "deactivateNpcControllerCombat"),
    issueAttackOrder: bindOperation(npcRuntime, "issueAttackOrder"),
    issueOrder: bindOperation(npcRuntime, "issueOrder"),
    pauseNpcController: bindOperation(npcRuntime, "pauseNpcController"),
    tickNpcControllersInScene: bindOperation(npcRuntime, "tickNpcControllersInScene"),
    spawnBatchInSystem: bindOperation(npcRuntime, "spawnBatchInSystem"),
    despawn: bindOperation(npcRuntime, "despawn"),
    getNpcServiceControllerByEntityID: bindOperation(
      npcService,
      "getControllerByEntityID",
    ),
    destroyNpcControllerByEntityID: bindOperation(
      npcService,
      "destroyNpcControllerByEntityID",
    ),
    deactivateAllActiveModules: bindOperation(spaceRuntime, "deactivateAllActiveModules"),
    clearTargets: bindOperation(spaceRuntime, "clearTargets"),
    applyDroneWeaponDamageToTarget: bindOperation(
      spaceRuntime.droneInterop,
      "applyWeaponDamageToTarget",
    ),
    applyResolvedEnvironmentalDamageToTarget: bindOperation(
      spaceRuntime,
      "applyResolvedEnvironmentalDamageToTarget",
    ),
    destroySessionShip: bindOperation(shipDestruction, "destroySessionShip"),
    playSpecialFx: bindOperation(spaceRuntime, "playSpecialFx"),
    stopSpecialFx: bindOperation(spaceRuntime, "stopSpecialFx"),
    activateAbyssalTrace: bindOperation(spaceRuntime, "activateAbyssalTrace"),
    publishAbyssalTraceInitial: bindOperation(spaceRuntime, "publishAbyssalTraceInitial"),
    updateAbyssalTracePresentation: bindOperation(
      spaceRuntime,
      "updateAbyssalTracePresentation",
    ),
    validateAbyssalTracePublicationReceipt: bindOperation(
      spaceRuntime,
      "validateAbyssalTracePublicationReceipt",
    ),
    summarizeAbyssalBootstrapInventory: bindOperation(
      spaceRuntime,
      "summarizeAbyssalBootstrapInventory",
    ),
    getAbyssalOfflineSessionForRun: bindOperation(
      spaceRuntime,
      "getAbyssalOfflineSessionForRun",
    ),
    findSessionByCharacterID: bindOperation(sessionRegistry, "findSessionByCharacterID"),
    syncInventoryItemForSession: characterState.syncInventoryItemForSession,
    getCharacterRecord: characterState.getCharacterRecord,
    updateCharacterRecord: characterState.updateCharacterRecord,
    removeBlueprintState: industryRuntimeState.removeBlueprintState,
    initializeBlueprintState: industryRuntimeState.initializeBlueprintState,
    updateBlueprintState: industryRuntimeState.updateBlueprintState,
    removeExactAbyssalProbes: probeRuntimeState.removeExactAbyssalProbes,
    releaseAbyssalPlayerCompanionsForController,
  };

  assertValidAbyssalEnginePort(port);
  Object.freeze(port);
  portsByRuntime.set(spaceRuntime, port);
  return port;
}

let bindingCallCount = 0;

function configureAbyssalManagerEnginePort(spaceRuntime) {
  const AbyssalMgrService = require("../abyssal").lifecycleHooks;
  const port = createAbyssalEnginePort(spaceRuntime);
  // The space runtime asks for the manager on every weapon snapshot, module
  // activation and modifier rebuild. Once this runtime's port is the configured
  // one, answer from the binding state instead of re-validating 90 capabilities
  // per call. A test reset clears the binding, so this stays correct after it.
  if (
    typeof AbyssalMgrService.getConfiguredAbyssalEnginePort === "function" &&
    AbyssalMgrService.getConfiguredAbyssalEnginePort() === port
  ) {
    return { success: true, changed: false };
  }
  bindingCallCount += 1;
  return AbyssalMgrService.configureAbyssalEnginePort(port);
}

module.exports = {
  createAbyssalEnginePort,
  configureAbyssalManagerEnginePort,
  _testing: Object.freeze({
    getBindingCallCount: () => bindingCallCount,
  }),
};
