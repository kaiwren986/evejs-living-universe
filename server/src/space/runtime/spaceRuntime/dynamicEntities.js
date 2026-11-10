"use strict";

const runtimeEntryDirname = require("path").resolve(__dirname, "../..");
const path = require("path");
const log = require(path.join(runtimeEntryDirname, "../utils/logger"));
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
  applyRuntimeEntityScopeMetadata,
  clearPlayerShipGenericDungeonScope,
} = require("../entityScopeTags");
const {
  buildRuntimeSpaceEntityFromItem,
  isInventoryBackedDynamicEntity,
  isInventoryItemEligibleForSceneSpawn,
} = require("../inventorySpaceEntity");
const {
  toFiniteNumber,
  toInt,
} = require("../../../common/numbers");
const {
  applyRuntimeEntitySpawnMetadata,
} = require("../runtimeEntityIdentity");
const {
  decorateEntitySceneOwnership,
  normalizeSceneDescriptor,
} = require("../sceneIdentity");
const {
  buildRuntimeShipEntity,
} = require("../shipEntity");
const {
  broadcastDamageStateChange,
} = require("../shipHealthState");

module.exports = {

spawnDynamicShip(systemID, shipSpec, options = {}) {
    const descriptor = normalizeSceneDescriptor(options.sceneDescriptor || systemID);
    const numericSystemID = toInt(descriptor && descriptor.locationID, 0);
    if (!numericSystemID) {
      return {
        success: false,
        errorMsg: "SOLAR_SYSTEM_NOT_FOUND",
      };
    }

    const scene = this.ensureScene(descriptor || numericSystemID);
    if (!scene) {
      return {
        success: false,
        errorMsg: "SCENE_NOT_FOUND",
      };
    }

    const entity = buildRuntimeShipEntity(shipSpec || {}, numericSystemID, {
      session: options.session || null,
      persistSpaceState: options.persistSpaceState === true,
    });
    decorateEntitySceneOwnership(entity, scene.sceneDescriptor);
    applyRuntimeEntityScopeMetadata(entity, options.entityScopeMetadata);
    clearPlayerShipGenericDungeonScope(entity);
    return scene.spawnDynamicEntity(entity, options);
  },

buildRuntimeSpaceEntityFromItemRecord(itemRecord, systemID, nowMs = Date.now(), options = {}) {
    const numericSystemID = toInt(systemID, 0);
    if (!numericSystemID || !itemRecord || !itemRecord.itemID) {
      return null;
    }
    return buildRuntimeSpaceEntityFromItem(
      itemRecord,
      numericSystemID,
      toFiniteNumber(nowMs, Date.now()),
      options,
    );
  },

spawnDynamicInventoryEntity(systemID, itemID, options = {}) {
    const descriptor = normalizeSceneDescriptor(options.sceneDescriptor || systemID);
    const numericSystemID = toInt(descriptor && descriptor.locationID, 0);
    const numericItemID = toInt(itemID, 0);
    if (!numericSystemID) {
      return {
        success: false,
        errorMsg: "SOLAR_SYSTEM_NOT_FOUND",
      };
    }
    if (!numericItemID) {
      return {
        success: false,
        errorMsg: "ITEM_NOT_FOUND",
      };
    }

    const itemRecord = findItemById(numericItemID);
    if (!itemRecord) {
      return {
        success: false,
        errorMsg: "ITEM_NOT_FOUND",
      };
    }
    if (!isInventoryItemEligibleForSceneSpawn(itemRecord, descriptor)) {
      return {
        success: false,
        errorMsg: "ITEM_NOT_IN_SPACE",
      };
    }

    const scene = this.ensureScene(descriptor || numericSystemID);
    if (!scene) {
      return {
        success: false,
        errorMsg: "SCENE_NOT_FOUND",
      };
    }

    const existingEntity = scene.getEntityByID(numericItemID);
    if (isInventoryBackedDynamicEntity(existingEntity)) {
      applyRuntimeEntitySpawnMetadata(existingEntity, options.runtimeEntityMetadata);
      if (options.initialPublication === "deferred" || options.suppressInitialPublication === true) {
        existingEntity.evejsInitialPublicationDeferred = true;
      }
      return scene.refreshInventoryBackedEntityPresentation(numericItemID, options);
    }
    if (existingEntity) {
      log.error(
        `[SpaceRuntime] Dynamic inventory spawn ID collision system=${numericSystemID} ` +
          `itemID=${numericItemID} existingKind=${String(existingEntity.kind || "")} ` +
          `existingTypeID=${toInt(existingEntity.typeID, 0)} incomingPersistent=true`,
      );
      return { success: false, errorMsg: "DYNAMIC_ENTITY_ID_COLLISION" };
    }

    const entity = buildRuntimeSpaceEntityFromItem(
      itemRecord,
      numericSystemID,
      scene.getCurrentSimTimeMs(),
      options,
    );
    if (!entity) {
      return {
        success: false,
        errorMsg: "UNSUPPORTED_DYNAMIC_ITEM",
      };
    }

    decorateEntitySceneOwnership(entity, scene.sceneDescriptor);
    applyRuntimeEntitySpawnMetadata(entity, options.runtimeEntityMetadata);
    if (options.initialPublication === "deferred" || options.suppressInitialPublication === true) {
      entity.evejsInitialPublicationDeferred = true;
    }
    return scene.spawnDynamicEntity(entity, {
      ...options,
      interdictionItemRecord: itemRecord,
    });
  },

refreshInventoryBackedEntityPresentation(systemID, entityID, options = {}) {
    const numericSystemID = toInt(systemID, 0);
    if (!numericSystemID) {
      return {
        success: false,
        errorMsg: "SOLAR_SYSTEM_NOT_FOUND",
      };
    }

    // A presentation refresh is only useful for an already-materialized scene.
    // Timer-driven persistent state transitions (deployable activation,
    // reinforcement, and similar callbacks) must not recreate an otherwise
    // collected empty solar system just to update a ball nobody can observe.
    // Callers that intentionally need materialization can opt in explicitly.
    const descriptor = normalizeSceneDescriptor(numericSystemID);
    let scene = null;
    if (options.ensureScene === true) {
      scene = this.ensureScene(descriptor || numericSystemID);
    } else if (descriptor && this.scenes instanceof Map) {
      scene = this.scenes.get(descriptor.sceneKey) || null;
    }
    if (!scene) {
      return {
        success: false,
        errorMsg: "SCENE_NOT_FOUND",
      };
    }

    return scene.refreshInventoryBackedEntityPresentation(entityID, options);
  },

broadcastEntityDamageStateChange(systemID, entityID, options = {}) {
    const descriptor = normalizeSceneDescriptor(options.sceneDescriptor || systemID);
    const numericEntityID = toInt(entityID, 0);
    if (!descriptor || numericEntityID <= 0) {
      return 0;
    }

    const scene = this.getSceneByDescriptor(descriptor);
    const entity = scene && scene.getEntityByID(numericEntityID);
    if (!scene || !entity) {
      return 0;
    }

    return broadcastDamageStateChange(
      scene,
      entity,
      options.whenMs === undefined ? null : options.whenMs,
      options,
    );
  },

removeDynamicEntity(systemID, entityID, options = {}) {
    const descriptor = normalizeSceneDescriptor(options.sceneDescriptor || systemID);
    const numericSystemID = toInt(descriptor && descriptor.locationID, 0);
    if (!numericSystemID) {
      return {
        success: false,
        errorMsg: "SOLAR_SYSTEM_NOT_FOUND",
      };
    }

    // Scene identity is deletion authority. Falling back to a global entity-ID
    // search lets a stale system ID remove an entity from another solar system
    // or a private Abyssal instance.
    const scene = this.scenes.get(descriptor ? descriptor.sceneKey : numericSystemID);
    if (!scene) {
      return {
        success: false,
        errorMsg: "SCENE_NOT_FOUND",
      };
    }

    return scene.removeDynamicEntity(entityID, options);
  },

destroyDynamicInventoryEntity(systemID, entityID, options = {}) {
    const descriptor = normalizeSceneDescriptor(options.sceneDescriptor || systemID);
    const numericSystemID = toInt(descriptor && descriptor.locationID, 0);
    if (!numericSystemID) {
      return {
        success: false,
        errorMsg: "SOLAR_SYSTEM_NOT_FOUND",
      };
    }

    const scene = this.scenes.get(descriptor ? descriptor.sceneKey : numericSystemID);
    if (!scene) {
      return {
        success: false,
        errorMsg: "SCENE_NOT_FOUND",
      };
    }

    return scene.destroyInventoryBackedDynamicEntity(entityID, options);
  },
};
