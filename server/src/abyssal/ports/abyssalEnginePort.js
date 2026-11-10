"use strict";

// Validated dependency boundary between the Abyssal subsystem and the outer
// game engine. The port exposes individual operations; it never returns the
// global space runtime, the NPC module, or another service locator.

const INVENTORY_CAPABILITIES = Object.freeze([
  "ITEM_FLAGS",
  "findItemById",
  "consumeInventoryItemQuantity",
  "createSpaceItemForOwner",
  "grantItemToOwnerLocation",
  "grantItemToOwnerLocationIdempotent",
  "grantItemsToOwnerLocationIdempotent",
  "getIdempotentGrantReceipt",
  "getAllItems",
  "listContainerItems",
  "listSystemSpaceItems",
  "moveShipToSpace",
  "removeInventoryItem",
  "updateInventoryItem",
  "updateShipItem",
  "resolveItemByName",
  "resolveItemByTypeID",
  "matchesTypeList",
]);

const COMPENSATION_CAPABILITIES = Object.freeze([
  "readAbyssalFilamentCompensationClaim",
  "persistAbyssalFilamentCompensationClaim",
  "listAbyssalFilamentCompensationClaimsForCharacter",
]);

const WORLD_CAPABILITIES = Object.freeze([
  "worldData",
  "crimewatchState",
  "fleetRuntime",
  "dungeonRuntime",
  "dungeonTrackingRuntime",
  "dungeonUniverseSiteService",
  "queuePostSpaceAttachFittingHydration",
  "isEntityStructureTethered",
  "isShipSelfDestructing",
  "isEntityFilamentBlocked",
]);

const CLOCK_CAPABILITIES = Object.freeze([
  "now",
  "nextRandom",
  "nextEncounterRandom",
  "nextBoundaryRandom",
  "scheduleTimeout",
  "clearScheduledTimeout",
  "scheduleInterval",
  "clearScheduledInterval",
  "scheduleBoundaryInterval",
  "clearScheduledBoundaryInterval",
]);

const SCENE_CAPABILITIES = Object.freeze([
  "allocateAbyssalLocationID",
  "normalizeSceneDescriptor",
  "buildAbyssalSceneKey",
  "buildSolarSystemSceneKey",
  "hasScene",
  "ensureScene",
  "getSceneByDescriptor",
  "getSceneForSession",
  "findSceneContainingDynamicEntity",
  "disposeScene",
  "ensureInitialBallpark",
  "attachSession",
  "detachSession",
  "teleportSessionShipForAbyssalTransition",
]);

const ENTITY_CAPABILITIES = Object.freeze([
  "getEntity",
  "spawnDynamicInventoryEntity",
  "destroyDynamicInventoryEntity",
  "removeDynamicEntity",
  "refreshShipDerivedState",
  "isEntityUndockInvulnerable",
  "grantTimedInvulnerabilityForSession",
]);

const NPC_CAPABILITIES = Object.freeze([
  "getControllerByEntityID",
  "activateNpcController",
  "deactivateNpcControllerCombat",
  "issueAttackOrder",
  "issueOrder",
  "pauseNpcController",
  "tickNpcControllersInScene",
  "spawnBatchInSystem",
  "despawn",
  "getNpcServiceControllerByEntityID",
  "destroyNpcControllerByEntityID",
]);

const COMBAT_CAPABILITIES = Object.freeze([
  "deactivateAllActiveModules",
  "clearTargets",
  "applyDroneWeaponDamageToTarget",
  "applyResolvedEnvironmentalDamageToTarget",
  "destroySessionShip",
]);

const PRESENTATION_CAPABILITIES = Object.freeze([
  "playSpecialFx",
  "stopSpecialFx",
  "activateAbyssalTrace",
  "publishAbyssalTraceInitial",
  "updateAbyssalTracePresentation",
  "validateAbyssalTracePublicationReceipt",
  "summarizeAbyssalBootstrapInventory",
]);

const SERVICE_CAPABILITIES = Object.freeze([
  "getAbyssalOfflineSessionForRun",
  "findSessionByCharacterID",
  "syncInventoryItemForSession",
  "getCharacterRecord",
  "updateCharacterRecord",
  "removeBlueprintState",
  "initializeBlueprintState",
  "updateBlueprintState",
  "removeExactAbyssalProbes",
  "releaseAbyssalPlayerCompanionsForController",
]);

const ENGINE_CAPABILITIES = Object.freeze([
  ...SCENE_CAPABILITIES,
  ...ENTITY_CAPABILITIES,
  ...NPC_CAPABILITIES,
  ...COMBAT_CAPABILITIES,
  ...PRESENTATION_CAPABILITIES,
  ...SERVICE_CAPABILITIES,
]);

const ABYSSAL_ENGINE_PORT_CAPABILITIES = Object.freeze([
  ...INVENTORY_CAPABILITIES,
  ...COMPENSATION_CAPABILITIES,
  ...WORLD_CAPABILITIES,
  ...CLOCK_CAPABILITIES,
  ...ENGINE_CAPABILITIES,
]);

const NON_CALLABLE_CAPABILITIES = Object.freeze(new Set([
  "ITEM_FLAGS",
  "worldData",
  "crimewatchState",
  "fleetRuntime",
  "dungeonRuntime",
  "dungeonTrackingRuntime",
  "dungeonUniverseSiteService",
]));

function validateAbyssalEnginePort(candidate) {
  const missing = [];
  const wrongType = [];
  const port = candidate && typeof candidate === "object" ? candidate : {};
  for (const name of ABYSSAL_ENGINE_PORT_CAPABILITIES) {
    if (!(name in port) || port[name] === undefined || port[name] === null) {
      missing.push(name);
    } else if (!NON_CALLABLE_CAPABILITIES.has(name) && typeof port[name] !== "function") {
      wrongType.push(name);
    }
  }
  return { valid: missing.length === 0 && wrongType.length === 0, missing, wrongType };
}

function assertValidAbyssalEnginePort(candidate) {
  const result = validateAbyssalEnginePort(candidate);
  if (result.valid) return candidate;
  const problem = result.missing.length > 0
    ? `MISSING_CAPABILITY:${result.missing[0]}`
    : `INVALID_CAPABILITY:${result.wrongType[0]}`;
  const error = new Error(`ABYSSAL_ENGINE_PORT_${problem}`);
  error.code = `ABYSSAL_ENGINE_PORT_${problem}`;
  error.validation = result;
  throw error;
}

module.exports = {
  ABYSSAL_ENGINE_PORT_CAPABILITIES,
  INVENTORY_CAPABILITIES,
  COMPENSATION_CAPABILITIES,
  WORLD_CAPABILITIES,
  CLOCK_CAPABILITIES,
  SCENE_CAPABILITIES,
  ENTITY_CAPABILITIES,
  NPC_CAPABILITIES,
  COMBAT_CAPABILITIES,
  PRESENTATION_CAPABILITIES,
  SERVICE_CAPABILITIES,
  ENGINE_CAPABILITIES,
  NON_CALLABLE_CAPABILITIES,
  validateAbyssalEnginePort,
  assertValidAbyssalEnginePort,
};
