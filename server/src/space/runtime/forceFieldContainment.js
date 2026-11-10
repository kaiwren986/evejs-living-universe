"use strict";

module.exports = {
  getCommandBurstForceFieldCenterDistance,
  isCommandBurstForceField,
  isShipInsideForceField,
  listCommandBurstForceFields,
};

const runtimeEntryDirname = require("path").resolve(__dirname, "..");
const path = require("path");
const {
  canEntitiesInteractLocally,
  isSharedPveTarget,
  resolveEntityInteractionScope,
} = require(path.join(runtimeEntryDirname, "./destiny/identity/interactionScope.js"));
const {
  toFiniteNumber,
  toInt,
} = require("../../common/numbers");
const {
  distance,
} = require("../../common/vector");

const COMMAND_BURST_FORCE_FIELD_GROUP_ID = 411;

function isCommandBurstForceField(entity) {
  return Boolean(entity && (toInt(entity.groupID, 0) === COMMAND_BURST_FORCE_FIELD_GROUP_ID ||
    String(entity.kind || "").trim().toLowerCase().replace(/[\s_-]+/g, "") === "forcefield"));
}

// Keep membership beside the scene's authoritative maps. This covers boot,
// spawn, replacement, expiry, removal and clear, including direct map callers.
// Cached lists hold live entities, so radius/position/harmonic refreshes remain
// visible without rebuilding the list on each ship's movement tick.
class ForceFieldIndexedEntityMap extends Map {
  constructor() {
    super();
    this.forceFieldEntities = new Map();
    this.forceFieldVersion = 0;
  }

  set(key, entity) {
    super.set(key, entity);
    this.refreshForceField(key, entity);
    return this;
  }

  refreshForceField(key, entity) {
    if (isCommandBurstForceField(entity)) {
      if (this.forceFieldEntities.get(key) !== entity) {
        this.forceFieldEntities.set(key, entity);
        this.forceFieldVersion += 1;
      }
    } else if (this.forceFieldEntities.delete(key)) {
      this.forceFieldVersion += 1;
    }
  }

  delete(key) {
    if (this.forceFieldEntities.delete(key)) this.forceFieldVersion += 1;
    return super.delete(key);
  }

  clear() {
    if (this.forceFieldEntities.size) {
      this.forceFieldEntities.clear();
      this.forceFieldVersion += 1;
    }
    super.clear();
  }
}

function listCommandBurstForceFields(scene) {
  if (!scene) {
    return [];
  }
  const staticMap = scene.staticEntitiesByID;
  const dynamicMap = scene.dynamicEntities;
  const indexed = staticMap instanceof ForceFieldIndexedEntityMap && dynamicMap instanceof ForceFieldIndexedEntityMap;
  const cached = scene._commandBurstForceFields;
  if (indexed && cached && cached.staticMap === staticMap && cached.dynamicMap === dynamicMap &&
      cached.staticVersion === staticMap.forceFieldVersion && cached.dynamicVersion === dynamicMap.forceFieldVersion) {
    return cached.entities;
  }
  const forceFields = [];
  const seenEntityIDs = new Set();
  const seenObjects = new Set();
  const append = (entity) => {
    if (!entity || typeof entity !== "object") {
      return;
    }
    const entityID = toInt(entity.itemID, 0);
    if (
      (entityID > 0 && seenEntityIDs.has(entityID)) ||
      (entityID <= 0 && seenObjects.has(entity))
    ) {
      return;
    }
    if (!isCommandBurstForceField(entity)) {
      return;
    }
    if (entityID > 0) {
      seenEntityIDs.add(entityID);
    } else {
      seenObjects.add(entity);
    }
    forceFields.push(entity);
  };

  for (const source of indexed ? [staticMap.forceFieldEntities, dynamicMap.forceFieldEntities] : [
    scene.staticEntities,
    scene.staticEntitiesByID,
    scene.dynamicEntities,
  ]) {
    if (source instanceof Map) {
      for (const entity of source.values()) {
        append(entity);
      }
    } else if (Array.isArray(source)) {
      for (const entity of source) {
        append(entity);
      }
    }
  }
  if (indexed) {
    scene._commandBurstForceFields = { staticMap, dynamicMap,
      staticVersion: staticMap.forceFieldVersion, dynamicVersion: dynamicMap.forceFieldVersion,
      entities: forceFields };
  }
  return forceFields;
}

function getCommandBurstForceFieldCenterDistance(
  scene,
  shipEntity,
  forceFieldEntity,
  nowMs,
) {
  if (
    scene &&
    typeof scene.getEntitySurfaceState === "function"
  ) {
    const state = scene.getEntitySurfaceState(shipEntity, forceFieldEntity);
    return state && state.available === true
      ? toFiniteNumber(state.centerDistance, Number.POSITIVE_INFINITY)
      : Number.POSITIVE_INFINITY;
  }
  return distance(
    shipEntity && shipEntity.position,
    forceFieldEntity && forceFieldEntity.position,
  );
}

function isShipInsideForceField(scene, shipEntity, nowMs = null) {
  if (!scene || !shipEntity || shipEntity.kind !== "ship") {
    return false;
  }
  const commandNowMs = nowMs == null
    ? typeof scene.getCurrentSimTimeMs === "function"
      ? scene.getCurrentSimTimeMs()
      : Date.now()
    : nowMs;
  const shipRadius = Math.max(0, toFiniteNumber(shipEntity.radius, 0));
  return listCommandBurstForceFields(scene).some((forceFieldEntity) => {
    if (
      forceFieldEntity === shipEntity ||
      !canEntitiesInteractLocally(shipEntity, forceFieldEntity)
    ) {
      return false;
    }
    const fieldRadius = Math.max(
      0,
      toFiniteNumber(forceFieldEntity.radius, 0),
    );
    if (fieldRadius <= 0) {
      return false;
    }
    const centerDistance = getCommandBurstForceFieldCenterDistance(
      scene,
      shipEntity,
      forceFieldEntity,
      commandNowMs,
    );
    return centerDistance + shipRadius < fieldRadius;
  });
}

Object.assign(module.exports, {
  COMMAND_BURST_FORCE_FIELD_GROUP_ID,
  ForceFieldIndexedEntityMap,
});
