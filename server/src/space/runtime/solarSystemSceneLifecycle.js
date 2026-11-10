"use strict";

module.exports = {
  getEmptySolarSystemRetainedObjectState,
  isLiveEmptySceneRetentionEntity,
  isPlayerOwnedEmptySceneEntity,
};

const {
  toFiniteNumber,
  toInt,
} = require("../../common/numbers");
const {
  getWallclockNowMs,
} = require("./runtimeClock");
const {
  normalizeSceneText,
} = require("./sceneIdentity");
const inventorySpaceEntityModule = require("./inventorySpaceEntity");

const NEW_EDEN_SYSTEM_LOADING = Object.freeze({
  LAZY: 1,
  HIGHSEC: 2,
  ALL: 3,
  ONGOING_LAZY: 4,
});

const STARTUP_PRELOADED_SYSTEM_IDS = Object.freeze([30000142, 30000145, 30100032]);

const EMPTY_SOLAR_SYSTEM_COLLECTION_GRACE_MS = 60_000;

const EMPTY_SOLAR_SYSTEM_RETAINED_OBJECT_GRACE_MS = 2 * 60 * 60 * 1000;

const EMPTY_SOLAR_SYSTEM_COLLECTION_MAX_PER_SWEEP = 16;

const EMPTY_SOLAR_SYSTEM_COLLECTION_SWEEP_INTERVAL_MS = 5_000;

const PLAYER_OWNED_SPACE_OBJECT_MIN_OWNER_ID = 2_000_000;

function isPlayerOwnedEmptySceneEntity(entity) {
  if (!entity || typeof entity !== "object") {
    return false;
  }
  if (entity.playerOwned === true) {
    return true;
  }
  return [
    entity.ownerID,
    entity.ownerCharacterID,
    entity.deployerCharacterID,
    entity.characterID,
    entity.charID,
    entity.corporationID,
  ].some(
    (candidateID) =>
      toInt(candidateID, 0) >= PLAYER_OWNED_SPACE_OBJECT_MIN_OWNER_ID,
  );
}

function isLiveEmptySceneRetentionEntity(entity, sceneNowMs = Date.now()) {
  const RUNTIME_STARBASE_KIND = inventorySpaceEntityModule.RUNTIME_STARBASE_KIND;
  if (
    !entity ||
    entity.removed === true ||
    entity.destroyed === true ||
    entity.destructionState === "destroyed" ||
    entity.evejsAbyssalEnvironmentalDestructionNotified === true
  ) {
    return false;
  }
  const expiresAtMs = toFiniteNumber(entity.expiresAtMs, 0);
  if (expiresAtMs > 0 && expiresAtMs <= sceneNowMs) {
    return false;
  }

  const kind = normalizeSceneText(entity.kind, "").toLowerCase();
  const isPlayerOwned = isPlayerOwnedEmptySceneEntity(entity);
  if (kind === "wreck" || entity.nativeNpcWreck === true) {
    return isPlayerOwned;
  }
  if (!isPlayerOwned) {
    return false;
  }
  if (
    kind === "deployable" ||
    kind === RUNTIME_STARBASE_KIND.toLowerCase() ||
    kind === "orbital" ||
    kind === "forcefield"
  ) {
    return true;
  }

  const anchorState = normalizeSceneText(entity.anchorState, "").toLowerCase();
  return Boolean(
    entity.isAnchored === true ||
    entity.anchored === true ||
    (entity.spaceState && (
      entity.spaceState.isAnchored === true ||
      entity.spaceState.isAnchored === 1 ||
      entity.spaceState.anchored === true
    )) ||
    anchorState === "anchoring" ||
    anchorState === "anchored" ||
    anchorState === "unanchoring"
  );
}

function getEmptySolarSystemRetainedObjectState(
  scene,
  wallclockNowMs = getWallclockNowMs(),
) {
  const sceneNowMs = Math.max(
    0,
    toFiniteNumber(
      scene && typeof scene.peekSimTimeForWallclock === "function"
        ? scene.peekSimTimeForWallclock(wallclockNowMs)
        : scene && typeof scene.getCurrentSimTimeMs === "function"
          ? scene.getCurrentSimTimeMs()
          : wallclockNowMs,
      wallclockNowMs,
    ),
  );
  const retainedEntityIDs = [];
  let wreckCount = 0;
  let anchoredObjectCount = 0;

  if (scene && scene.dynamicEntities instanceof Map) {
    for (const entity of scene.dynamicEntities.values()) {
      if (!isLiveEmptySceneRetentionEntity(entity, sceneNowMs)) {
        continue;
      }
      retainedEntityIDs.push(toInt(entity.itemID, 0));
      if (
        normalizeSceneText(entity.kind, "").toLowerCase() === "wreck" ||
        entity.nativeNpcWreck === true
      ) {
        wreckCount += 1;
      } else {
        anchoredObjectCount += 1;
      }
    }
  }

  if (scene && Array.isArray(scene.staticEntities)) {
    for (const entity of scene.staticEntities) {
      if (
        !entity ||
        normalizeSceneText(entity.kind, "").toLowerCase() !== "structure" ||
        entity.removed === true ||
        entity.destroyed === true ||
        entity.destructionState === "destroyed" ||
        !isPlayerOwnedEmptySceneEntity(entity)
      ) {
        continue;
      }
      retainedEntityIDs.push(toInt(entity.itemID, 0));
      anchoredObjectCount += 1;
    }
  }

  return {
    requiresExtendedRetention: retainedEntityIDs.length > 0,
    retainedEntityIDs: retainedEntityIDs.filter((entityID) => entityID > 0),
    retainedObjectCount: retainedEntityIDs.length,
    wreckCount,
    anchoredObjectCount,
  };
}

Object.assign(module.exports, {
  EMPTY_SOLAR_SYSTEM_COLLECTION_GRACE_MS,
  EMPTY_SOLAR_SYSTEM_COLLECTION_MAX_PER_SWEEP,
  EMPTY_SOLAR_SYSTEM_COLLECTION_SWEEP_INTERVAL_MS,
  EMPTY_SOLAR_SYSTEM_RETAINED_OBJECT_GRACE_MS,
  NEW_EDEN_SYSTEM_LOADING,
  PLAYER_OWNED_SPACE_OBJECT_MIN_OWNER_ID,
  STARTUP_PRELOADED_SYSTEM_IDS,
});
