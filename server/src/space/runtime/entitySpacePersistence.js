"use strict";

module.exports = {
  buildShipSpaceState,
  persistDynamicEntity,
  persistInventoryBackedEntity,
  persistShipEntity,
  scheduleShipPersistenceRetry,
  serializeSpaceState,
  shouldPersistShipEntityAtTick,
};

const runtimeEntryDirname = require("path").resolve(__dirname, "..");
const path = require("path");
const log = require(path.join(runtimeEntryDirname, "../utils/logger"));
const {
  CAPSULE_TYPE_ID,
  CAPSULE_TYPE_ID_GOLDEN,
  ITEM_FLAGS,
  updateShipItem,
  updateInventoryItem,
  removeInventoryItem,
  getShipConditionState,
  normalizeShipConditionState,
  getItemMetadata,
  pruneExpiredSpaceItems,
} = require(path.join(runtimeEntryDirname, "../services/inventory/itemStore"));
const {
  findItemById,
  findShipItemById,
  listContainerItems,
  listSystemSpaceItems,
  warmSimulationInventoryProjection,
} = require(path.join(
  runtimeEntryDirname,
  "../services/inventory/simulationInventoryProjection",
));
const {
  buildStoredRackHeatForEntity,
  withStoredRackHeat,
} = require(path.join(runtimeEntryDirname, "../services/inventory/shipRackHeatState"));
const {
  serializeRuntimeDungeonTrackingState,
  serializeRuntimeEntityScopeMetadata,
} = require("./entityScopeTags");
const {
  isInventoryBackedDynamicEntity,
} = require("./inventorySpaceEntity");
const {
  toFiniteNumber,
  toInt,
} = require("../../common/numbers");
const {
  normalizeMode,
} = require("./shipMotionKinematics");
const {
  coerceDunRotationTuple,
} = require("./staticSceneEntity");
const {
  DEFAULT_RIGHT,
  buildPerpendicular,
  cloneVector,
} = require("../../common/vector");
const inventorySpaceEntityModule = require("./inventorySpaceEntity");
const {
  describeWarpForSave,
  normalizeSavedWarpLanding,
} = require("./savedWarpLanding");

const SHIP_SPACE_STATE_PERSIST_INTERVAL_MS = 2000;

function serializeSpaceState(entity) {
  const RUNTIME_STARBASE_KIND = inventorySpaceEntityModule.RUNTIME_STARBASE_KIND;
  const STARBASE_ANCHOR_STATE = inventorySpaceEntityModule.STARBASE_ANCHOR_STATE;
  // A ship in mode WARP is stored stopped, at its landing point or, for a
  // site warp, where it is with a savedWarpLanding record (savedWarpLanding.js).
  const savedWarp = describeWarpForSave(entity);
  const storedWarpPosition = savedWarp ? savedWarp.position : null;
  const savedWarpLanding = savedWarp
    ? savedWarp.savedWarpLanding
    : normalizeSavedWarpLanding(entity.savedWarpLanding);
  const serialized = {
    systemID: entity.systemID,
    position: storedWarpPosition || cloneVector(entity.position),
    // A ship in mode WARP is stored stopped, and stopped means at rest. A
    // warp's velocity is AU-scale, and kept with mode STOP it would coast
    // far past the warp's destination on load.
    velocity: storedWarpPosition ? { x: 0, y: 0, z: 0 } : cloneVector(entity.velocity),
    direction: cloneVector(entity.direction),
    targetPoint: storedWarpPosition || cloneVector(entity.targetPoint, entity.position),
    speedFraction: entity.speedFraction,
    mode: entity.mode === "WARP" ? "STOP" : normalizeMode(entity.mode),
    targetEntityID: entity.targetEntityID || null,
    followRange: entity.followRange || 0,
    orbitDistance: entity.orbitDistance || 0,
    orbitNormal: cloneVector(entity.orbitNormal, buildPerpendicular(entity.direction)),
    orbitSign: entity.orbitSign < 0 ? -1 : 1,
    ...(savedWarpLanding ? { savedWarpLanding } : {}),
    ...serializeRuntimeEntityScopeMetadata(entity),
    ...serializeRuntimeDungeonTrackingState(entity),
  };
  if (entity.kind === "orbital" && Number(entity.spaceState?.orbitalPositionVersion) > 0) {
    serialized.orbitalPositionVersion = Math.trunc(Number(entity.spaceState.orbitalPositionVersion));
  }
  const breacher = require("../combat/breacherPods");
  const breacherState = breacher.serializeRuntimeState(entity);
  if (breacherState) serialized[breacher.STATE_KEY] = breacherState;
  if (entity && entity.kind === "forceField") {
    serialized.mode = "FIELD";
    serialized.destinyHarmonic = toInt(
      entity.destinyHarmonic ?? entity.harmonic,
      0,
    );
    serialized.harmonic = serialized.destinyHarmonic;
    serialized.corporationID = toInt(entity.corporationID, 0);
    serialized.allianceID = toInt(entity.allianceID, 0);
    serialized.controlTowerID = toInt(entity.controlTowerID, 0) || null;
  }
  if (entity && entity.kind === RUNTIME_STARBASE_KIND) {
    serialized.corporationID = toInt(entity.corporationID, 0);
    serialized.allianceID = toInt(entity.allianceID, 0);
    serialized.warFactionID = toInt(entity.warFactionID, 0);
    serialized.online = toInt(entity.online, 0);
    serialized.incapacitated = toInt(entity.incapacitated, 0);
    serialized.controlTowerID = toInt(
      entity.controlTowerID,
      toInt(entity.spaceState && entity.spaceState.controlTowerID, 0),
    ) || null;
    serialized.moonID = toInt(
      entity.moonID,
      toInt(entity.spaceState && entity.spaceState.moonID, 0),
    ) || null;
    serialized.anchorState = String(
      entity.anchorState || STARBASE_ANCHOR_STATE.UNANCHORED,
    );
    serialized.isAnchored = entity.isAnchored === true;
    serialized.anchorStartedAtMs =
      toFiniteNumber(entity.anchorStartedAtMs, 0) > 0
        ? toFiniteNumber(entity.anchorStartedAtMs, 0)
        : null;
    serialized.anchorCompletesAtMs =
      toFiniteNumber(entity.anchorCompletesAtMs, 0) > 0
        ? toFiniteNumber(entity.anchorCompletesAtMs, 0)
        : null;
    serialized.onlineState = String(entity.onlineState || "offline");
    serialized.onlineStartedAtMs =
      toFiniteNumber(entity.onlineStartedAtMs, 0) > 0
        ? toFiniteNumber(entity.onlineStartedAtMs, 0)
        : null;
    serialized.onlineCompletesAtMs =
      toFiniteNumber(entity.onlineCompletesAtMs, 0) > 0
        ? toFiniteNumber(entity.onlineCompletesAtMs, 0)
        : null;
    if (
      entity.spaceState &&
      entity.spaceState.starbaseFuelState &&
      typeof entity.spaceState.starbaseFuelState === "object"
    ) {
      serialized.starbaseFuelState = {
        ...entity.spaceState.starbaseFuelState,
      };
    }
    if (entity.spaceState?.starbaseReinforcementState) {
      serialized.starbaseReinforcementState = { ...entity.spaceState.starbaseReinforcementState };
    }
    if (String(entity.spaceState && entity.spaceState.starbaseDisabledReason || "").trim()) {
      serialized.starbaseDisabledReason = String(
        entity.spaceState.starbaseDisabledReason,
      );
    }
    if (toFiniteNumber(entity.spaceState && entity.spaceState.starbaseDisabledAtMs, 0) > 0) {
      serialized.starbaseDisabledAtMs = toFiniteNumber(
        entity.spaceState.starbaseDisabledAtMs,
        0,
      );
    }
    const moduleSpecificState =
      entity.starbaseModuleState ||
      entity.spaceState && entity.spaceState.starbaseModuleState;
    if (
      moduleSpecificState &&
      typeof moduleSpecificState === "object" &&
      !Array.isArray(moduleSpecificState)
    ) {
      serialized.starbaseModuleState = { ...moduleSpecificState };
    }
    const posTimerScale = Number(
      entity.posTimerScale ??
        (entity.spaceState && entity.spaceState.posTimerScale),
    );
    serialized.posTimerScale =
      Number.isFinite(posTimerScale) && posTimerScale > 0
        ? posTimerScale
        : 1;
  }
  return serialized;
}

function buildShipSpaceState(source = {}) {
  if (source && typeof source.spaceState === "object" && source.spaceState !== null) {
    return source.spaceState;
  }

  return {
    position: cloneVector(source.position),
    velocity: cloneVector(source.velocity),
    direction: cloneVector(source.direction, DEFAULT_RIGHT),
    targetPoint: source.targetPoint ? cloneVector(source.targetPoint) : undefined,
    speedFraction: source.speedFraction,
    mode: source.mode,
    targetEntityID: source.targetEntityID,
    followRange: source.followRange,
    orbitDistance: source.orbitDistance,
    orbitNormal: source.orbitNormal ? cloneVector(source.orbitNormal) : undefined,
    orbitSign: source.orbitSign,
  };
}

function scheduleShipPersistenceRetry(entity, nowMs, failure) {
  if (entity && typeof entity === "object") {
    entity.nextPersistRetryAt = nowMs +
      SHIP_SPACE_STATE_PERSIST_INTERVAL_MS;
  }
  const result = failure && typeof failure === "object"
    ? failure
    : {
        success: false,
        errorMsg: "SHIP_PERSISTENCE_FAILED",
      };
  log.warn(
    `[SpaceRuntime] Failed to persist ship ${entity && entity.itemID}: ${result.errorMsg || "SHIP_PERSISTENCE_FAILED"}`,
  );
  return result;
}

function shouldPersistShipEntityAtTick(entity, nowMs, options = {}) {
  if (!entity || entity.kind !== "ship" || entity.persistSpaceState !== true) {
    return false;
  }
  if (options.force === true) {
    return true;
  }
  const retryAt = toFiniteNumber(entity.nextPersistRetryAt, 0);
  if (retryAt > 0) {
    return toFiniteNumber(nowMs, 0) >= retryAt;
  }
  return (
    toFiniteNumber(nowMs, 0) - toFiniteNumber(entity.lastPersistAt, 0) >=
    SHIP_SPACE_STATE_PERSIST_INTERVAL_MS
  );
}

function persistShipEntity(entity, options = {}) {
  if (!entity || entity.kind !== "ship" || entity.persistSpaceState !== true) {
    return {
      success: false,
      skipped: true,
      reason: "SHIP_NOT_PERSISTED",
    };
  }

  const nowMs = toFiniteNumber(options.nowMs, Date.now());
  if (require("./siteHazardDamage").hasUnpublishedHealth(entity)) {
    return scheduleShipPersistenceRetry(entity, nowMs, {
      success: false, errorMsg: "SITE_HAZARD_HEALTH_PENDING",
    });
  }
  const findShipItem = typeof options.findShipItemById === "function"
    ? options.findShipItemById
    : findShipItemById;
  const updateItem = typeof options.updateShipItem === "function"
    ? options.updateShipItem
    : updateShipItem;
  let shipItem = null;
  try {
    shipItem = findShipItem(entity.itemID);
  } catch (error) {
    return scheduleShipPersistenceRetry(entity, nowMs, {
      success: false,
      errorMsg: error && (error.code || error.message) || "SHIP_LOOKUP_FAILED",
    });
  }
  if (!shipItem) {
    entity.persistSpaceState = false;
    entity.nextPersistRetryAt = 0;
    return {
      success: true,
      skipped: true,
      reason: "SHIP_ITEM_NOT_FOUND",
    };
  }

  let result;
  try {
    result = updateItem(entity.itemID, (currentItem) => ({
      ...currentItem,
      locationID: entity.systemID,
      flagID: 0,
      spaceState: serializeSpaceState(entity),
      // The entity's own condition, and with it what its racks hold now, for the
      // ship to keep when the entity is gone (shipRackHeatState.js): a docking or a
      // jump unregisters the entity, and that persists it. By the wall clock,
      // whatever nowMs is.
      conditionState: withStoredRackHeat(
        normalizeShipConditionState(entity.conditionState),
        buildStoredRackHeatForEntity(entity, Date.now()),
      ),
    }));
  } catch (error) {
    return scheduleShipPersistenceRetry(entity, nowMs, {
      success: false,
      errorMsg: error && (error.code || error.message) || "SHIP_UPDATE_FAILED",
    });
  }

  if (!result || result.success !== true) {
    return scheduleShipPersistenceRetry(entity, nowMs, result);
  }

  entity.lastPersistAt = nowMs;
  entity.nextPersistRetryAt = 0;
  return result;
}

function persistInventoryBackedEntity(entity) {
  if (!entity) {
    return {
      success: false,
      errorMsg: "ENTITY_NOT_FOUND",
    };
  }
  if (require("./siteHazardDamage").hasUnpublishedHealth(entity)) {
    return { success: false, errorMsg: "SITE_HAZARD_HEALTH_PENDING" };
  }
  if (
    entity.destroyed === true ||
    entity.removed === true ||
    entity.destructionState === "destroyed" ||
    entity.evejsAbyssalEnvironmentalDestructionNotified === true
  ) {
    return {
      success: true,
      skipped: true,
      reason: "ENTITY_LIFECYCLE_TERMINAL",
    };
  }
  if (!isInventoryBackedDynamicEntity(entity) || entity.persistSpaceState !== true) {
    return {
      success: true,
      skipped: true,
      reason: "PERSISTENCE_DISABLED",
    };
  }

  const result = updateInventoryItem(entity.itemID, (currentItem) => ({
    ...currentItem,
    locationID: entity.systemID,
    flagID: 0,
    spaceState: {
      ...serializeSpaceState(entity),
      // An anchoring move commits the inventory version before relocating its
      // already-published entity. That entity can still hold its old snapshot.
      ...(entity.kind === "orbital" && Number(currentItem.spaceState?.orbitalPositionVersion) > 0
        ? { orbitalPositionVersion: Math.trunc(Number(currentItem.spaceState.orbitalPositionVersion)) } : {}),
    },
    conditionState: normalizeShipConditionState(entity.conditionState),
    createdAtMs: toFiniteNumber(entity.createdAtMs, 0) || null,
    expiresAtMs: toFiniteNumber(entity.expiresAtMs, 0) || null,
    launcherID: toInt(entity.launcherID, 0) || null,
    dunRotation: coerceDunRotationTuple(entity.dunRotation),
  }));

  if (!result.success) {
    log.warn(
      `[SpaceRuntime] Failed to persist ${entity.kind} ${entity.itemID}: ${result.errorMsg}`,
    );
    return result;
  }

  entity.lastPersistAt = Date.now();
  return result;
}

function persistDynamicEntity(entity) {
  if (!entity) {
    return {
      success: false,
      errorMsg: "ENTITY_NOT_FOUND",
    };
  }
  if (entity.nativeNpc === true && entity.dungeonSiteContentRole === "required_actor") {
    return require("../npc/nativeNpcService").persistRequiredDungeonActor(entity);
  }
  if (entity.kind === "ship") {
    return persistShipEntity(entity);
  }
  return persistInventoryBackedEntity(entity);
}

Object.assign(module.exports, {
  SHIP_SPACE_STATE_PERSIST_INTERVAL_MS,
});
