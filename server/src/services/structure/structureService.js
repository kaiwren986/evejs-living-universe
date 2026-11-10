"use strict";
const { getSessionCorporationRoleMask } = require("../corporation/corporationRoleChecks");

const path = require("path");

const BaseService = require(path.join(__dirname, "../baseService"));
const log = require(path.join(__dirname, "../../utils/logger"));
const {
  throwWrappedUserError,
} = require(path.join(__dirname, "../../common/machoErrors"));
const {
  buildBoundObjectResponse,
  extractList,
  resolveBoundNodeId,
  unwrapMarshalValue,
} = require(path.join(__dirname, "../_shared/serviceHelpers"));
const {
  LOOT_CUSTOM_INFO_KEY,
  buildProtectedCorporationSpaceLootInfo,
} = require(path.join(__dirname, "../_shared/spaceLootEntitlement"));
const {
  syncInventoryItemForSession,
} = require(path.join(__dirname, "../character/characterState"));
const {
  ITEM_FLAGS,
  createSpaceItemForOwner,
  findItemById,
  moveItemToLocation,
  restoreInventoryItemChangesAtomic,
} = require(path.join(__dirname, "../inventory/itemStore"));
const {
  resolveItemByName,
  resolveItemByTypeID,
} = require(path.join(__dirname, "../inventory/itemTypeRegistry"));
const {
  FUEL_BLOCK_GROUP_ID,
  TYPE_LIQUID_OZONE,
} = require(path.join(__dirname, "../inventory/fuelBayInventory"));
const {
  buildCrpAccessDeniedInsufficientRolesValues,
} = require(path.join(__dirname, "./structureServiceAuthority"));
const structureState = require(path.join(__dirname, "./structureState"));
const spaceRuntime = require(path.join(__dirname, "../../space/runtime"));
const {
  JETCAN_LIFETIME_MS,
} = require(path.join(__dirname, "../ship/jettisonRuntime"));

const JETCAN_CONTAINER_NAME = "Cargo Container";
const CORP_ROLE_STATION_MANAGER = 2048n;
const CORP_ROLE_STARBASE_CARETAKER = 288230376151711744n;

const defaultFuelJettisonDependencies = Object.freeze({
  createSpaceItemForOwner,
  moveItemToLocation,
  restoreInventoryItemChangesAtomic,
  spawnDynamicInventoryEntity(systemID, itemID, options = {}) {
    return spaceRuntime.spawnDynamicInventoryEntity(systemID, itemID, options);
  },
  findDynamicEntity(systemID, itemID) {
    const scene = spaceRuntime.ensureScene(systemID);
    return scene && typeof scene.getEntityByID === "function"
      ? scene.getEntityByID(itemID)
      : null;
  },
  removeDynamicEntity(systemID, itemID) {
    return spaceRuntime.removeDynamicEntity(systemID, itemID, {
      allowSessionOwned: true,
      persistSpaceState: false,
    });
  },
});

let fuelJettisonDependencies = { ...defaultFuelJettisonDependencies };

function setFuelJettisonDependenciesForTests(overrides = {}) {
  fuelJettisonDependencies = {
    ...defaultFuelJettisonDependencies,
    ...(overrides && typeof overrides === "object" ? overrides : {}),
  };
}

function resetFuelJettisonDependenciesForTests() {
  fuelJettisonDependencies = { ...defaultFuelJettisonDependencies };
}

function toInt(value, fallback = 0) {
  const unwrapped = unwrapMarshalValue(value);
  if (typeof unwrapped === "bigint") {
    return Number(unwrapped);
  }
  const numeric = Number(unwrapped);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function toPositiveInt(value, fallback = 0) {
  const numeric = toInt(value, fallback);
  return numeric > 0 ? numeric : fallback;
}

function normalizeVector(value, fallback) {
  const source = value && typeof value === "object" ? value : fallback;
  return {
    x: Number(source && source.x) || 0,
    y: Number(source && source.y) || 0,
    z: Number(source && source.z) || 0,
  };
}

function normalizeDirection(value) {
  const vector = normalizeVector(value, { x: 1, y: 0, z: 0 });
  const length = Math.sqrt(
    vector.x * vector.x +
      vector.y * vector.y +
      vector.z * vector.z,
  );
  if (!(length > 0)) {
    return { x: 1, y: 0, z: 0 };
  }
  return {
    x: vector.x / length,
    y: vector.y / length,
    z: vector.z / length,
  };
}

function addScaledVector(position, direction, distance) {
  return {
    x: position.x + direction.x * distance,
    y: position.y + direction.y * distance,
    z: position.z + direction.z * distance,
  };
}

function getStructureOwnerID(structure) {
  return toPositiveInt(
    structure && (structure.ownerCorpID || structure.ownerID),
    0,
  );
}

function getSessionCorporationID(session) {
  const { getPersistedCorporationAuthority } = require("../corporation/corporationAuthority");
  return getPersistedCorporationAuthority(session)?.corporationID || 0;
}

function getSessionRoleMask(session) {
  return getSessionCorporationRoleMask(session);
}

function hasStructureFuelJettisonRole(session) {
  const roleMask = getSessionRoleMask(session);
  return (
    (roleMask & CORP_ROLE_STATION_MANAGER) === CORP_ROLE_STATION_MANAGER ||
    (roleMask & CORP_ROLE_STARBASE_CARETAKER) === CORP_ROLE_STARBASE_CARETAKER
  );
}

function sessionControlsStructure(session, structureID) {
  const targetID = toPositiveInt(structureID, 0);
  if (!targetID) {
    return false;
  }
  return [
    session && session.shipid,
    session && session.shipID,
    session && session.activeShipID,
    session && session._space && session._space.shipID,
  ].some((value) => toPositiveInt(value, 0) === targetID);
}

function isStructureFuelJettisonItem(item) {
  const typeID = toPositiveInt(item && item.typeID, 0);
  if (typeID === TYPE_LIQUID_OZONE) {
    return true;
  }
  const typeRecord = resolveItemByTypeID(typeID);
  return toPositiveInt(
    (item && item.groupID) || (typeRecord && typeRecord.groupID),
    0,
  ) === FUEL_BLOCK_GROUP_ID;
}

function getStructureSpacePosition(session, structure) {
  const structureID = toPositiveInt(structure && structure.structureID, 0);
  const entity = structureID > 0 ? spaceRuntime.getEntity(session, structureID) : null;
  return normalizeVector(
    (entity && entity.position) ||
      (structure && structure.spaceState && structure.spaceState.position) ||
      (structure && structure.position),
    { x: 0, y: 0, z: 0 },
  );
}

function getStructureSpaceDirection(session, structure) {
  const structureID = toPositiveInt(structure && structure.structureID, 0);
  const entity = structureID > 0 ? spaceRuntime.getEntity(session, structureID) : null;
  return normalizeDirection(
    (entity && entity.direction) ||
      (structure && structure.spaceState && structure.spaceState.direction) ||
      (structure && structure.direction),
  );
}

function buildStructureFuelJettisonSpawnState(session, structure) {
  const position = getStructureSpacePosition(session, structure);
  const direction = getStructureSpaceDirection(session, structure);
  const containerPosition = addScaledVector(position, direction, 275);
  return {
    position: containerPosition,
    velocity: { x: 0, y: 0, z: 0 },
    direction,
    targetPoint: containerPosition,
    mode: "STOP",
    speedFraction: 0,
  };
}

function syncChangesToSession(session, changes = []) {
  for (const change of Array.isArray(changes) ? changes : []) {
    if (!change || !change.item) {
      continue;
    }
    syncInventoryItemForSession(
      session,
      change.item,
      change.previousData || change.previousState || {},
      { emitCfgLocation: true },
    );
  }
}

function normalizeItemIDList(value) {
  return extractList(value)
    .map((entry) => toPositiveInt(entry, 0))
    .filter((itemID, index, itemIDs) => itemID > 0 && itemIDs.indexOf(itemID) === index);
}

function callFuelJettisonDependency(name, args, fallbackErrorMsg) {
  const dependency = fuelJettisonDependencies[name];
  if (typeof dependency !== "function") {
    return { success: false, errorMsg: fallbackErrorMsg };
  }
  try {
    return dependency(...args);
  } catch (error) {
    return {
      success: false,
      errorMsg: String(error && (error.code || error.message) || fallbackErrorMsg),
    };
  }
}

function inspectFuelJettisonEntity(systemID, containerID) {
  const dependency = fuelJettisonDependencies.findDynamicEntity;
  if (typeof dependency !== "function") {
    return { success: false, errorMsg: "SCENE_LOOKUP_UNAVAILABLE" };
  }
  try {
    return {
      success: true,
      entity: dependency(systemID, containerID) || null,
    };
  } catch (error) {
    return {
      success: false,
      errorMsg: String(error && (error.code || error.message) || "SCENE_LOOKUP_FAILED"),
    };
  }
}

function syncFuelJettisonChanges(session, changes) {
  try {
    syncChangesToSession(session, changes);
    return true;
  } catch (error) {
    log.error(
      `[Structure] JettisonStructureFuel inventory sync failed: ` +
        `${error && (error.code || error.message) || "UNKNOWN_ERROR"}`,
    );
    return false;
  }
}

class StructureService extends BaseService {
  constructor() {
    super("structure");
  }

  Handle_MachoResolveObject() {
    log.debug("[Structure] MachoResolveObject");
    return resolveBoundNodeId();
  }

  Handle_MachoBindObject(args, session, kwargs) {
    log.debug("[Structure] MachoBindObject");
    return buildBoundObjectResponse(this, args, session, kwargs);
  }

  _getBoundStructureID(session) {
    const boundObjectID = session && session.currentBoundObjectID;
    const boundParams =
      boundObjectID &&
      this.serviceManager &&
      typeof this.serviceManager.getBoundObjectParams === "function"
        ? this.serviceManager.getBoundObjectParams(boundObjectID)
        : null;
    return (
      toPositiveInt(boundParams, 0) ||
      toPositiveInt(session && session.structureid, 0) ||
      toPositiveInt(session && session.structureID, 0)
    );
  }

  _assertCanJettisonStructureFuel(session, structure) {
    const structureID = toPositiveInt(structure && structure.structureID, 0);
    const ownerID = getStructureOwnerID(structure);
    const sessionCorpID = getSessionCorporationID(session);
    if (
      !structureID ||
      !ownerID ||
      !sessionControlsStructure(session, structureID) ||
      sessionCorpID !== ownerID ||
      !hasStructureFuelJettisonRole(session)
    ) {
      throwWrappedUserError(
        "CrpAccessDenied",
        buildCrpAccessDeniedInsufficientRolesValues(),
      );
    }
  }

  _getValidFuelItems(structure, itemIDs) {
    const structureID = toPositiveInt(structure && structure.structureID, 0);
    const ownerID = getStructureOwnerID(structure);
    const validItems = [];
    for (const itemID of itemIDs) {
      const item = findItemById(itemID);
      if (
        !item ||
        toPositiveInt(item.ownerID, 0) !== ownerID ||
        toPositiveInt(item.locationID, 0) !== structureID ||
        toPositiveInt(item.flagID, 0) !== ITEM_FLAGS.STRUCTURE_FUEL_BAY ||
        !isStructureFuelJettisonItem(item)
      ) {
        continue;
      }
      validItems.push(item);
    }
    return validItems;
  }

  Handle_JettisonStructureFuel(args, session) {
    const structureID = this._getBoundStructureID(session);
    const structure = structureState.getStructureByID(structureID);
    this._assertCanJettisonStructureFuel(session, structure);

    const itemIDs = normalizeItemIDList(args && args.length > 0 ? args[0] : args);
    const validItems = this._getValidFuelItems(structure, itemIDs);
    if (validItems.length === 0) {
      return null;
    }

    const containerType = resolveItemByName(JETCAN_CONTAINER_NAME);
    if (!containerType.success || !containerType.match) {
      log.warn("[Structure] JettisonStructureFuel failed to resolve Cargo Container");
      return null;
    }

    const ownerID = getStructureOwnerID(structure);
    const solarSystemID =
      toPositiveInt(structure && structure.solarSystemID, 0) ||
      toPositiveInt(session && (session.solarsystemid2 || session.solarsystemid), 0);
    const simTimeMs = spaceRuntime.getSimulationTimeMsForSession(session, Date.now());
    const protectedCorporationLootInfo =
      buildProtectedCorporationSpaceLootInfo(ownerID);
    if (!protectedCorporationLootInfo) {
      log.warn(
        `[Structure] JettisonStructureFuel refused unprotected corporation owner=${ownerID}`,
      );
      return null;
    }
    const createResult = callFuelJettisonDependency(
      "createSpaceItemForOwner",
      [
        ownerID,
        solarSystemID,
        containerType.match,
        {
          ...buildStructureFuelJettisonSpawnState(session, structure),
          customInfo: JSON.stringify({
            [LOOT_CUSTOM_INFO_KEY]: protectedCorporationLootInfo,
          }),
          createdAtMs: simTimeMs,
          expiresAtMs: simTimeMs + JETCAN_LIFETIME_MS,
        },
      ],
      "CONTAINER_CREATE_FAILED",
    );
    if (!createResult.success || !createResult.data) {
      log.warn(
        `[Structure] JettisonStructureFuel container creation failed: ${createResult.errorMsg || "UNKNOWN_ERROR"}`,
      );
      return null;
    }

    const containerID = toPositiveInt(createResult.data.itemID, 0);
    const inventoryChanges = [
      ...(Array.isArray(createResult.changes) ? createResult.changes : []),
    ];
    const rollBackInventory = (failureStage, failure) => {
      const rollbackResult = callFuelJettisonDependency(
        "restoreInventoryItemChangesAtomic",
        [inventoryChanges],
        "INVENTORY_ROLLBACK_FAILED",
      );
      if (!rollbackResult || rollbackResult.success !== true) {
        log.error(
          `[Structure] JettisonStructureFuel ${failureStage} failed and ` +
            `inventory compensation failed container=${containerID} ` +
            `cause=${failure && failure.errorMsg || "UNKNOWN_ERROR"} ` +
            `rollback=${rollbackResult && rollbackResult.errorMsg || "UNKNOWN_ERROR"}`,
        );
        // The successful prefix remains authoritative. Publish it only after
        // rollback has definitively failed so the client never sees a state
        // that was subsequently compensated.
        syncFuelJettisonChanges(session, inventoryChanges);
        return false;
      }
      log.warn(
        `[Structure] JettisonStructureFuel rolled back after ${failureStage} ` +
          `container=${containerID} cause=${failure && failure.errorMsg || "UNKNOWN_ERROR"}`,
      );
      return true;
    };

    for (const item of validItems) {
      const moveResult = callFuelJettisonDependency(
        "moveItemToLocation",
        [item.itemID, containerID, ITEM_FLAGS.HANGAR],
        "FUEL_MOVE_FAILED",
      );
      if (!moveResult || moveResult.success !== true) {
        rollBackInventory("fuel move", moveResult);
        return null;
      }
      inventoryChanges.push(
        ...(
          moveResult.data && Array.isArray(moveResult.data.changes)
            ? moveResult.data.changes
            : []
        ),
      );
    }

    // Keep the tentative entity from rewriting the freshly-created inventory
    // row before the scene boundary settles. A successful (or deliberately
    // preserved) entity is re-enabled for normal persistence below.
    const spawnResult = callFuelJettisonDependency(
      "spawnDynamicInventoryEntity",
      [
        solarSystemID,
        containerID,
        { runtimeEntityMetadata: { persistSpaceState: false } },
      ],
      "CONTAINER_SPAWN_FAILED",
    );
    if (!spawnResult || !spawnResult.success) {
      const beforeCleanup = inspectFuelJettisonEntity(solarSystemID, containerID);
      if (!beforeCleanup.success) {
        log.error(
          `[Structure] JettisonStructureFuel spawn failed and live-entity ` +
            `state could not be established container=${containerID} ` +
            `error=${beforeCleanup.errorMsg || "UNKNOWN_ERROR"}; preserving custody`,
        );
        syncFuelJettisonChanges(session, inventoryChanges);
        return null;
      }

      if (beforeCleanup.entity) {
        const cleanupResult = callFuelJettisonDependency(
          "removeDynamicEntity",
          [solarSystemID, containerID],
          "DYNAMIC_ENTITY_REMOVE_FAILED",
        );
        const afterCleanup = inspectFuelJettisonEntity(solarSystemID, containerID);
        if (!afterCleanup.success || afterCleanup.entity) {
          // Never remove persisted custody underneath a live entity: doing so
          // would turn a failed cleanup into a ghost/duplication boundary. The
          // selected fuel is already outside the structure, so a retry with the
          // same IDs is naturally idempotent.
          beforeCleanup.entity.persistSpaceState = true;
          log.error(
            `[Structure] JettisonStructureFuel spawn failed and live container ` +
              `cleanup did not settle container=${containerID} ` +
              `spawn=${spawnResult.errorMsg || "UNKNOWN_ERROR"} ` +
              `cleanup=${cleanupResult && cleanupResult.errorMsg || "UNKNOWN_ERROR"} ` +
              `verify=${afterCleanup.errorMsg || "ENTITY_STILL_LIVE"}; preserving custody`,
          );
          syncFuelJettisonChanges(session, inventoryChanges);
          return null;
        }
      }

      rollBackInventory("scene spawn", spawnResult);
      return null;
    }

    const spawnedEntity =
      spawnResult.data && spawnResult.data.entity
        ? spawnResult.data.entity
        : inspectFuelJettisonEntity(solarSystemID, containerID).entity;
    if (spawnedEntity) {
      spawnedEntity.persistSpaceState = true;
    }
    syncFuelJettisonChanges(session, inventoryChanges);

    return null;
  }
}

module.exports = StructureService;
StructureService._testing = {
  resetFuelJettisonDependenciesForTests,
  setFuelJettisonDependenciesForTests,
};
