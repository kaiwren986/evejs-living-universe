"use strict";

const {
  cloneVector,
} = require("../../common/vector");

const {
  toFiniteNumber,
} = require("../../common/numbers");

const path = require("path");

const log = require(path.join(__dirname, "../../utils/logger"));
const {
  ITEM_FLAGS,
  findItemById,
  isCapsuleTypeID,
  listContainerItems,
  updateInventoryItem,
  updateInventoryItemsAtomic,
} = require(path.join(__dirname, "../inventory/itemStore"));
const {
  resolveItemByTypeID,
} = require(path.join(__dirname, "../inventory/itemTypeRegistry"));
const {
  getActiveShipRecord,
  syncInventoryItemForSession,
} = require(path.join(__dirname, "../character/characterState"));
const {
  getShipBaseAttributeValue,
} = require(path.join(__dirname, "../fitting/liveFittingState"));
const { validateStarbaseInventoryAccess, hasMaintenanceInventoryPermission } = require("../starbase/starbaseInventoryRuntime");
const { hasStarbasePermission } = require("../starbase/starbaseAccessRuntime");
const spaceRuntime = require(path.join(__dirname, "../../space/runtime"));
const {
  buildChildEntityScopeMetadata,
  canEntitiesInteractLocally,
} = require(path.join(
  __dirname,
  "../../space/destiny/identity/interactionScope.js",
));
const {
  boardSpaceShip,
  ejectSession,
  getStrategicCruiserTransitionUseError,
} = require(path.join(__dirname, "../../space/transitions"));
const {
  maybeExpireEmptySpaceContainer,
} = require(path.join(__dirname, "./jettisonRuntime"));
const {
  validateShipFittingServiceAccess,
  validateShipServiceAccess,
} = require(path.join(__dirname, "./shipServiceAccess"));
const {
  resolveAbyssalSessionSceneAuthorityTruthy,
} = require("../../abyssal").engineSupport.sceneKey;
const {
  buildSpaceLootSourceFromItem,
  commitSpaceLootTheft,
  compensateSpaceLootTheft,
  evaluateSpaceLootAccess,
  recordSpaceLootTheft,
} = require(path.join(__dirname, "../_shared/spaceLootEntitlement"));
const {
  MAX_CARGO_CONTAINER_TRANSFER_DISTANCE_METERS,
} = require(path.join(__dirname, "./cargoContainerRuntime"));
const {
  validateShipMaintenanceBayItem,
} = require(path.join(__dirname, "../inventory/shipMaintenanceBayInventory"));

const DEFAULT_LAUNCH_OFFSET_METERS = 275;
const MAX_CONFIGURE_DISTANCE_METERS = 5000;
// The V24.01 client gates POS fitting with appConst.maxConfigureDistance.
// Ship-based fitting has no client-side range check, so use the same bounded
// maintenance-service range already enforced for ship store/board operations.
const SHIP_FITTING_SERVICE_RANGE_METERS = MAX_CONFIGURE_DISTANCE_METERS;
const CATEGORY_SHIP = 6;
const GROUP_SHIP_MAINTENANCE_ARRAY = 363;
const GROUP_ASSEMBLY_ARRAY = 397;

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function magnitude(vector) {
  const resolved = cloneVector(vector);
  return Math.sqrt((resolved.x ** 2) + (resolved.y ** 2) + (resolved.z ** 2));
}

function normalizeVector(vector, fallback = { x: 1, y: 0, z: 0 }) {
  const resolved = cloneVector(vector, fallback);
  const length = magnitude(resolved);
  if (!Number.isFinite(length) || length <= 0) {
    return cloneVector(fallback, { x: 1, y: 0, z: 0 });
  }
  return {
    x: resolved.x / length,
    y: resolved.y / length,
    z: resolved.z / length,
  };
}

function addVectors(left, right) {
  const resolvedLeft = cloneVector(left);
  const resolvedRight = cloneVector(right);
  return {
    x: resolvedLeft.x + resolvedRight.x,
    y: resolvedLeft.y + resolvedRight.y,
    z: resolvedLeft.z + resolvedRight.z,
  };
}

function scaleVector(vector, scalar) {
  const resolved = cloneVector(vector);
  const resolvedScalar = toFiniteNumber(scalar, 0);
  return {
    x: resolved.x * resolvedScalar,
    y: resolved.y * resolvedScalar,
    z: resolved.z * resolvedScalar,
  };
}

function distanceBetween(left, right) {
  const resolvedLeft = cloneVector(left);
  const resolvedRight = cloneVector(right);
  return Math.sqrt(
    ((resolvedLeft.x - resolvedRight.x) ** 2) +
    ((resolvedLeft.y - resolvedRight.y) ** 2) +
    ((resolvedLeft.z - resolvedRight.z) ** 2),
  );
}

function surfaceDistanceBetweenEntities(left, right) {
  return Math.max(
    0,
    distanceBetween(left && left.position, right && right.position) -
      Math.max(0, toFiniteNumber(left && left.radius, 0)) -
      Math.max(0, toFiniteNumber(right && right.radius, 0)),
  );
}

function buildLaunchStateNearSource(sourceEntity, offsetMeters = DEFAULT_LAUNCH_OFFSET_METERS) {
  const direction = normalizeVector(
    sourceEntity && sourceEntity.direction,
    { x: 1, y: 0, z: 0 },
  );
  const sourceRadius = Math.max(0, toFiniteNumber(sourceEntity && sourceEntity.radius, 0));
  const offset = Math.max(
    50,
    sourceRadius + Math.max(50, toFiniteNumber(offsetMeters, DEFAULT_LAUNCH_OFFSET_METERS)),
  );
  const position = addVectors(
    cloneVector(sourceEntity && sourceEntity.position),
    scaleVector(direction, offset),
  );
  return {
    ...buildChildEntityScopeMetadata(sourceEntity),
    systemID: toInt(sourceEntity && sourceEntity.systemID, 0),
    position,
    velocity: { x: 0, y: 0, z: 0 },
    direction,
    targetPoint: position,
    mode: "STOP",
    speedFraction: 0,
  };
}

function isSourceSpaceContainerEntity(entity) {
  return Boolean(
    entity &&
    (entity.kind === "container" || entity.kind === "wreck"),
  );
}

function getActiveAbyssalRunForSession(session) {
  const characterID = toInt(
    session && (session.characterID || session.charid || session.charID),
    0,
  );
  const shipID = toInt(
    session && session._space && session._space.shipID,
    toInt(session && (session.shipID || session.shipid || session.activeShipID), 0),
  );
  const AbyssalMgrService = require("../../abyssal").scenePolicy;
  const characterRun =
    characterID > 0 &&
    typeof AbyssalMgrService.getActiveAbyssalRunForCharacterID === "function"
      ? AbyssalMgrService.getActiveAbyssalRunForCharacterID(characterID)
      : null;
  const activeRun = characterRun || (
    shipID > 0 &&
    typeof AbyssalMgrService.getActiveAbyssalRunForShipID === "function"
      ? AbyssalMgrService.getActiveAbyssalRunForShipID(shipID)
      : null
  );
  if (activeRun) {
    return activeRun;
  }
  const sceneAuthority = resolveAbyssalSessionSceneAuthorityTruthy(session);
  return sceneAuthority
    ? { characterID, shipID, instanceID: sceneAuthority.instanceID }
    : null;
}

function isShipMaintenanceArraySource(item) {
  const groupID = toInt(item && item.groupID, 0);
  return groupID === GROUP_SHIP_MAINTENANCE_ARRAY || groupID === GROUP_ASSEMBLY_ARRAY;
}

function isShipMaintenanceBaySource(item) {
  if (toInt(item && item.categoryID, 0) !== CATEGORY_SHIP) {
    return false;
  }

  const hasMaintenanceBay = toFiniteNumber(
    getShipBaseAttributeValue(item.typeID, "hasShipMaintenanceBay"),
    0,
  );
  const bayCapacity = toFiniteNumber(
    getShipBaseAttributeValue(item.typeID, "shipMaintenanceBayCapacity"),
    0,
  );
  return hasMaintenanceBay > 0 || bayCapacity > 0;
}

function isFiniteVector(vector) {
  return Boolean(
    vector &&
      Number.isFinite(Number(vector.x)) &&
      Number.isFinite(Number(vector.y)) &&
      Number.isFinite(Number(vector.z)),
  );
}

function isExplicitlyFreeMaintenanceArray(item, entity = null) {
  return Boolean(
    (entity && entity.isFree === true) ||
      (item && item.isFree === true) ||
      (item && item.spaceState && item.spaceState.isFree === true),
  );
}

function validatePosMaintenanceArrayAccess(session, item, entity = null) {
  if (isExplicitlyFreeMaintenanceArray(item, entity)) {
    return {
      success: false,
      errorMsg: "POS_MAINTENANCE_ARRAY_NOT_ANCHORED",
    };
  }
  const availability = validateStarbaseInventoryAccess(session, item, {
    maxDistanceMeters: MAX_CONFIGURE_DISTANCE_METERS,
  });
  if (!availability.success) {
    return availability.errorMsg === "STARBASE_INVENTORY_TOO_FAR"
      ? { success: false, errorMsg: "SOURCE_MAINTENANCE_CONTAINER_TOO_FAR" }
      : availability;
  }
  if (!hasStarbasePermission(session, availability.data.tower, item.itemID, "use")) {
    return {
      success: false,
      errorMsg: "POS_MAINTENANCE_ARRAY_ACCESS_DENIED",
    };
  }
  return availability;
}

function getShipMaintenanceBayCapacity(sourceItem) {
  return Math.max(
    0,
    toFiniteNumber(
      getShipBaseAttributeValue(sourceItem && sourceItem.typeID, "shipMaintenanceBayCapacity"),
      0,
    ),
  );
}

function getMaintenanceSourceCapacity(sourceItem, sourceIsShipBay) {
  if (!sourceItem) {
    return 0;
  }

  if (sourceIsShipBay) {
    return getShipMaintenanceBayCapacity(sourceItem);
  }

  const metadata = resolveItemByTypeID(sourceItem.typeID) || {};
  return Math.max(
    0,
    toFiniteNumber(
      sourceItem.capacity,
      toFiniteNumber(metadata.capacity, 0),
    ),
  );
}

function getItemVolume(item) {
  if (!item) {
    return 0;
  }
  const metadata = resolveItemByTypeID(item.typeID) || {};
  const volume = Math.max(
    0,
    toFiniteNumber(item.volume, toFiniteNumber(metadata.volume, 0)),
  );
  const stackSize =
    toInt(item.singleton, 0) === 1
      ? 1
      : Math.max(1, toInt(item.stacksize ?? item.quantity, 1));
  return volume * stackSize;
}

// A ship Maintenance Bay is one flag among many bays sharing the carrier's
// itemID as their locationID, and storeShipRecordInMaintenanceSource stamps
// stored hulls with flagShipHangar. Its used volume must therefore be scoped to
// that flag: summing every row at the hull charges fitted modules, cargo, ore
// holds, the fleet hangar, and the drone bay against shipMaintenanceBayCapacity
// and makes a loaded carrier refuse ship stores that fit. A POS Ship
// Maintenance Array is a container whose entire contents are stored ships at
// flag 0, so it stays flag-blind. Both stay owner-blind: a service bay is one
// shared pool, and every owner's stored ship consumes it (b3924fd9).
function getMaintenanceSourceStoredShipFlagID(sourceIsShipBay) {
  return sourceIsShipBay === true ? ITEM_FLAGS.SHIP_HANGAR : null;
}

function getMaintenanceSourceUsedVolume(
  sourceID,
  excludedItemID = 0,
  flagID = null,
) {
  const excludedID = toInt(excludedItemID, 0);
  return listContainerItems(null, sourceID, flagID).reduce((sum, item) => {
    if (!item || toInt(item.itemID, 0) === excludedID) {
      return sum;
    }
    return sum + getItemVolume(item);
  }, 0);
}

function canStoreShipInMaintenanceSource(context, shipItem, excludedItemID = 0) {
  const capacity = getMaintenanceSourceCapacity(
    context && context.sourceItem,
    context && context.sourceIsShipBay,
  );
  if (capacity <= 0) {
    return true;
  }

  const used = getMaintenanceSourceUsedVolume(
    context.sourceID,
    excludedItemID,
    getMaintenanceSourceStoredShipFlagID(context && context.sourceIsShipBay),
  );
  return used + getItemVolume(shipItem) <= capacity + 0.0001;
}

function validateShipAndContentsForMaintenanceSource(context, shipItem) {
  return validateShipMaintenanceBayItem(
    context && context.sourceIsShipBay ? context.sourceItem : null,
    shipItem,
    {
      contents: listContainerItems(
        null,
        toInt(shipItem && shipItem.itemID, 0),
      ),
    },
  );
}

function isMaintenanceSourceInCurrentSystem(sourceItem, systemID) {
  return Boolean(
    sourceItem &&
    toInt(sourceItem.locationID, 0) === systemID &&
    toInt(sourceItem.flagID, -1) === 0 &&
    sourceItem.spaceState,
  );
}

function buildFallbackSourceEntity(sourceItem, systemID) {
  if (!sourceItem || !sourceItem.spaceState) {
    return null;
  }

  const metadata = resolveItemByTypeID(sourceItem.typeID) || {};
  return {
    ...buildChildEntityScopeMetadata(sourceItem),
    kind: toInt(sourceItem.categoryID, 0) === CATEGORY_SHIP ? "ship" : "structure",
    itemID: toInt(sourceItem.itemID, 0),
    typeID: toInt(sourceItem.typeID, 0),
    groupID: toInt(sourceItem.groupID, toInt(metadata.groupID, 0)),
    categoryID: toInt(sourceItem.categoryID, toInt(metadata.categoryID, 0)),
    systemID,
    position: cloneVector(sourceItem.spaceState.position),
    direction: normalizeVector(sourceItem.spaceState.direction, { x: 1, y: 0, z: 0 }),
    radius: Math.max(
      0,
      toFiniteNumber(sourceItem.radius, toFiniteNumber(metadata.radius, 0)),
    ),
  };
}

function resolveMaintenanceSourceContext(session, sourceLocationID, options = {}) {
  const characterID = toInt(session && session.characterID, 0);
  const systemID = toInt(
    session && session._space && session._space.systemID,
    toInt(session && (session.solarsystemid2 || session.solarsystemid), 0),
  );
  const sourceID = toInt(sourceLocationID, 0);
  if (!characterID || !systemID || !sourceID) {
    return {
      success: false,
      errorMsg: "INVALID_SESSION_OR_ITEM",
    };
  }

  const currentShip = getActiveShipRecord(characterID) || null;
  if (
    options.rejectActiveSource === true &&
    currentShip &&
    toInt(currentShip.itemID, 0) === sourceID
  ) {
    return {
      success: false,
      errorMsg: "SOURCE_IS_ACTIVE_SHIP",
    };
  }

  const sourceItem = findItemById(sourceID);
  if (!isMaintenanceSourceInCurrentSystem(sourceItem, systemID)) {
    return {
      success: false,
      errorMsg: "SOURCE_MAINTENANCE_CONTAINER_NOT_IN_SPACE",
    };
  }

  const sourceIsShipBay = isShipMaintenanceBaySource(sourceItem);
  const sourceIsPosMaintenanceArray = isShipMaintenanceArraySource(sourceItem);
  if (!sourceIsShipBay && !sourceIsPosMaintenanceArray) {
    return {
      success: false,
      errorMsg: "SOURCE_NOT_SHIP_MAINTENANCE_CONTAINER",
    };
  }

  if (sourceIsShipBay) {
    // Retail treats an SMB hull's fitting service separately from opening its
    // maintenance-bay inventory: fitting requires owner/corp/fleet membership,
    // while bay inventory access additionally requires the ship configuration
    // toggle. Keep the stricter check for store/board operations only.
    const serviceAccess = options.requireFittingAccess === true
      ? validateShipFittingServiceAccess(session, sourceItem)
      : validateShipServiceAccess(
        session,
        sourceItem,
        ITEM_FLAGS.SHIP_HANGAR,
      );
    if (!serviceAccess.success) {
      return serviceAccess;
    }
  }

  const scene = spaceRuntime.getSceneForSession(session);
  const sourceEntity =
    (scene && scene.getEntityByID(sourceID)) ||
    (
      scene && scene.sceneKind === "solarSystem"
        ? buildFallbackSourceEntity(sourceItem, systemID)
        : null
    );
  if (!scene || !sourceEntity) {
    return {
      success: false,
      errorMsg: "SOURCE_MAINTENANCE_CONTAINER_NOT_VISIBLE",
    };
  }

  if (sourceIsPosMaintenanceArray) {
    const accessResult = validatePosMaintenanceArrayAccess(
      session,
      sourceItem,
      sourceEntity,
    );
    if (!accessResult.success) {
      return accessResult;
    }
    if (options.inventoryOperation && !hasMaintenanceInventoryPermission(
      session, accessResult.data.tower, sourceItem.itemID, options.inventoryOperation,
    )) {
      return { success: false, errorMsg: "POS_MAINTENANCE_ARRAY_ACCESS_DENIED" };
    }
  }

  const activeEntity =
    currentShip && scene
      ? scene.getEntityByID(toInt(currentShip.itemID, 0))
      : null;
  if (activeEntity && !canEntitiesInteractLocally(activeEntity, sourceEntity)) {
    return {
      success: false,
      errorMsg: "SOURCE_MAINTENANCE_CONTAINER_NOT_VISIBLE",
    };
  }
  if (options.requireActiveRange === true && !sourceIsPosMaintenanceArray) {
    if (!activeEntity) {
      return {
        success: false,
        errorMsg: "ACTIVE_SHIP_ENTITY_NOT_FOUND",
      };
    }
    const distanceMeters = surfaceDistanceBetweenEntities(activeEntity, sourceEntity);
    if (distanceMeters > MAX_CONFIGURE_DISTANCE_METERS) {
      return {
        success: false,
        errorMsg: "SOURCE_MAINTENANCE_CONTAINER_TOO_FAR",
        data: {
          distanceMeters,
          maxDistanceMeters: MAX_CONFIGURE_DISTANCE_METERS,
        },
      };
    }
  }

  return {
    success: true,
    data: {
      characterID,
      systemID,
      sourceID,
      sourceItem,
      sourceEntity,
      sourceIsShipBay,
      sourceIsPosMaintenanceArray,
      scene,
      currentShip,
      activeEntity,
    },
  };
}

function validateMaintenanceFittingServiceAccess(session, sourceItemOrID) {
  const sourceID = toInt(
    sourceItemOrID && typeof sourceItemOrID === "object"
      ? sourceItemOrID.itemID
      : sourceItemOrID,
    0,
  );
  const sourceItem = findItemById(sourceID);
  if (!sourceItem) {
    return {
      success: false,
      errorMsg: "ITEM_NOT_FOUND",
    };
  }

  const sourceIsShipBay = isShipMaintenanceBaySource(sourceItem);
  const sourceIsPosMaintenanceArray = isShipMaintenanceArraySource(sourceItem);
  if (!sourceIsShipBay && !sourceIsPosMaintenanceArray) {
    return {
      success: false,
      errorMsg: "SOURCE_NOT_SHIP_MAINTENANCE_CONTAINER",
    };
  }

  if (sourceIsPosMaintenanceArray) {
    const sourceEntity = spaceRuntime.getEntity(session, sourceItem.itemID);
    const accessResult = validatePosMaintenanceArrayAccess(
      session,
      sourceItem,
      sourceEntity,
    );
    if (!accessResult.success) {
      return accessResult;
    }
  }

  const contextResult = resolveMaintenanceSourceContext(
    session,
    sourceItem.itemID,
    {
      requireActiveRange: true,
      requireFittingAccess: true,
    },
  );
  if (!contextResult.success) {
    return contextResult;
  }

  if (
    sourceIsPosMaintenanceArray &&
    isExplicitlyFreeMaintenanceArray(
      contextResult.data && contextResult.data.sourceItem,
      contextResult.data && contextResult.data.sourceEntity,
    )
  ) {
    return {
      success: false,
      errorMsg: "POS_MAINTENANCE_ARRAY_NOT_ANCHORED",
    };
  }

  return contextResult;
}

function validateShipForMaintenanceSource(context, itemID) {
  const targetItemID = toInt(itemID, 0);
  const containedItem = findItemById(targetItemID);
  if (!containedItem || toInt(containedItem.locationID, 0) !== context.sourceID) {
    return {
      success: false,
      errorMsg: "ITEM_NOT_IN_SOURCE_CONTAINER",
    };
  }

  if (toInt(containedItem.categoryID, 0) !== CATEGORY_SHIP) {
    return {
      success: false,
      errorMsg: "ITEM_NOT_SHIP",
    };
  }

  if (toInt(containedItem.singleton, 0) !== 1) {
    return {
      success: false,
      errorMsg: "SHIP_NOT_ASSEMBLED",
    };
  }

  if (
    context.sourceIsShipBay &&
    toInt(containedItem.flagID, 0) !== ITEM_FLAGS.SHIP_HANGAR
  ) {
    return {
      success: false,
      errorMsg: "SHIP_NOT_IN_SHIP_MAINTENANCE_BAY",
    };
  }

  return {
    success: true,
    data: containedItem,
  };
}

function isLaunchableContainerType(item, metadata) {
  const groupName = String(
    metadata && metadata.groupName || item && item.groupName || "",
  ).trim().toLowerCase();
  return (
    groupName.includes("container") ||
    groupName === "spawn container"
  );
}

function isLaunchableContainedItem(item) {
  if (!item) {
    return false;
  }

  if (toInt(item.categoryID, 0) === CATEGORY_SHIP) {
    return toInt(item.singleton, 0) === 1;
  }

  const stackSize = toInt(item.stacksize ?? item.quantity, 1);
  if (stackSize > 1) {
    return false;
  }

  return isLaunchableContainerType(item, resolveItemByTypeID(item.typeID));
}

function syncUpdatedItem(session, updateResult) {
  if (!session || !updateResult || updateResult.success !== true) {
    return;
  }

  syncInventoryItemForSession(
    session,
    updateResult.data,
    updateResult.previousData || {},
    { emitCfgLocation: true },
  );
}

function launchShipOrContainerFromWreckOrContainer(session, sourceLocationID, itemID) {
  const characterID = toInt(session && session.characterID, 0);
  const systemID = toInt(
    session && session._space && session._space.systemID,
    toInt(session && (session.solarsystemid2 || session.solarsystemid), 0),
  );
  const sourceID = toInt(sourceLocationID, 0);
  const targetItemID = toInt(itemID, 0);
  if (!characterID || !systemID || !sourceID || !targetItemID) {
    return {
      success: false,
      errorMsg: "INVALID_SESSION_OR_ITEM",
    };
  }
  if (getActiveAbyssalRunForSession(session)) {
    return {
      success: false,
      errorMsg: "ABYSSAL_SHIP_OR_CONTAINER_LAUNCH_RESTRICTED",
    };
  }

  const sourceItem = findItemById(sourceID);
  if (
    !sourceItem ||
    toInt(sourceItem.locationID, 0) !== systemID ||
    toInt(sourceItem.flagID, -1) !== 0 ||
    !sourceItem.spaceState
  ) {
    return {
      success: false,
      errorMsg: "SOURCE_CONTAINER_NOT_IN_SPACE",
    };
  }

  const scene = spaceRuntime.getSceneForSession(session);
  const sourceEntity = scene && scene.getEntityByID(sourceID);
  const activeEntity = scene && scene.getShipEntityForSession(session);
  if (
    !scene ||
    !activeEntity ||
    !isSourceSpaceContainerEntity(sourceEntity) ||
    !canEntitiesInteractLocally(activeEntity, sourceEntity) ||
    (
      typeof scene.canSessionSeeDungeonScopedEntity === "function" &&
      !scene.canSessionSeeDungeonScopedEntity(session, sourceEntity)
    )
  ) {
    return {
      success: false,
      errorMsg: "SOURCE_CONTAINER_NOT_VISIBLE",
    };
  }
  if (
    !isFiniteVector(activeEntity.position) ||
    !isFiniteVector(sourceEntity.position)
  ) {
    return {
      success: false,
      errorMsg: "SOURCE_CONTAINER_NOT_VISIBLE",
    };
  }
  if (
    distanceBetween(activeEntity.position, sourceEntity.position) >
    MAX_CARGO_CONTAINER_TRANSFER_DISTANCE_METERS
  ) {
    return {
      success: false,
      errorMsg: "TARGET_TOO_FAR",
    };
  }

  const containedItem = findItemById(targetItemID);
  if (!containedItem || toInt(containedItem.locationID, 0) !== sourceID) {
    return {
      success: false,
      errorMsg: "ITEM_NOT_IN_SOURCE_CONTAINER",
    };
  }

  if (!isLaunchableContainedItem(containedItem)) {
    return {
      success: false,
      errorMsg: "ITEM_NOT_LAUNCHABLE",
    };
  }

  // Removing an assembled ship or container from somebody else's space loot is
  // a take on the source inventory even though the launched item's owner does
  // not change. Use the same immutable owner/corporation/fleet entitlement and
  // green-safety/suspect consequence as Add, FitFitting, scoop, and tractors.
  const lootAccess = evaluateSpaceLootAccess(
    session,
    buildSpaceLootSourceFromItem(sourceItem),
    { scene },
  );
  if (!lootAccess.success) {
    return {
      success: false,
      errorMsg: lootAccess.errorMsg || "SafetyActivated",
    };
  }

  let theftSettlement = null;
  if (lootAccess.requiresSuspectTimer) {
    theftSettlement = recordSpaceLootTheft(session, lootAccess, { scene });
    if (theftSettlement.errorMsg) {
      log.warn(
        `[EjectRuntime] Refusing launch because the theft consequence could ` +
          `not be persisted char=${characterID} source=${sourceID} ` +
          `item=${targetItemID} error=${theftSettlement.errorMsg}`,
      );
      return {
        success: false,
        errorMsg: "CRIMEWATCH_CONSEQUENCE_PERSIST_FAILED",
      };
    }
  }

  const launchState = buildLaunchStateNearSource(sourceEntity);
  let updateResult = null;
  try {
    updateResult = updateInventoryItem(targetItemID, (currentItem) => ({
      ...currentItem,
      locationID: systemID,
      flagID: 0,
      singleton:
        toInt(currentItem.categoryID, 0) === CATEGORY_SHIP
          ? 1
          : currentItem.singleton,
      spaceState: launchState,
    }));
  } catch (error) {
    updateResult = {
      success: false,
      errorMsg: error && error.message || "LAUNCH_UPDATE_FAILED",
    };
  }
  if (!updateResult || !updateResult.success) {
    const compensation = compensateSpaceLootTheft(
      session,
      theftSettlement,
      { scene },
    );
    if (compensation.errorMsg) {
      log.warn(
        `[EjectRuntime] Failed to compensate rejected launch theft ` +
          `char=${characterID} source=${sourceID} item=${targetItemID} ` +
          `error=${compensation.errorMsg}`,
      );
    }
    return updateResult || {
      success: false,
      errorMsg: "LAUNCH_UPDATE_FAILED",
    };
  }

  let spawnResult = null;
  try {
    spawnResult = spaceRuntime.spawnDynamicInventoryEntity(
      systemID,
      targetItemID,
      {
        sceneDescriptor: scene.sceneDescriptor || undefined,
      },
    );
  } catch (error) {
    spawnResult = {
      success: false,
      errorMsg: error && error.message || "SPACE_SPAWN_FAILED",
    };
  }
  if (!spawnResult || spawnResult.success !== true) {
    const rollbackResult = updateInventoryItem(
      targetItemID,
      () => updateResult.previousData || containedItem,
    );
    if (rollbackResult.success) {
      const compensation = compensateSpaceLootTheft(
        session,
        theftSettlement,
        { scene },
      );
      if (compensation.errorMsg) {
        log.warn(
          `[EjectRuntime] Failed to compensate rolled-back launch theft ` +
            `char=${characterID} source=${sourceID} item=${targetItemID} ` +
            `error=${compensation.errorMsg}`,
        );
      }
    } else {
      // The persisted launch mutation survived, so keep the prepared receipt
      // active rather than falsely clearing the suspect consequence.
      log.error(
        `[EjectRuntime] Failed to roll back unspawned launch item=${targetItemID} ` +
          `source=${sourceID}: ${rollbackResult.errorMsg || "UNKNOWN_ERROR"}`,
      );
    }
    log.warn(
      `[EjectRuntime] Launched item=${targetItemID} from source=${sourceID} but dynamic spawn failed: ${spawnResult ? spawnResult.errorMsg : "UNKNOWN_ERROR"}`,
    );
    return {
      success: false,
      errorMsg: spawnResult && spawnResult.errorMsg || "SPACE_SPAWN_FAILED",
    };
  }

  const theftCommit = commitSpaceLootTheft(
    session,
    theftSettlement,
    { scene },
  );
  if (theftCommit.errorMsg) {
    // The prepared receipt already contributes a durable suspect timer. Leave
    // it active after a successful launch if only the commit marker failed.
    log.warn(
      `[EjectRuntime] Launch theft receipt remains prepared after mutation ` +
        `char=${characterID} source=${sourceID} item=${targetItemID} ` +
        `error=${theftCommit.errorMsg}`,
    );
  }

  syncUpdatedItem(session, updateResult);

  maybeExpireEmptySpaceContainer(session, sourceID);

  return {
    success: true,
    data: {
      sourceID,
      itemID: targetItemID,
      systemID,
      entity: spawnResult.data && spawnResult.data.entity || null,
    },
  };
}

function launchShipFromMaintenanceContainer(session, sourceLocationID, itemID, options = {}) {
  const contextResult = resolveMaintenanceSourceContext(
    session,
    sourceLocationID,
    {
      ...options,
      // LaunchFromContainer is exposed as a direct remote service call. Make
      // proximity an invariant of the maintenance operation itself rather
      // than relying on the client to offer the action only while nearby.
      requireActiveRange: true,
      inventoryOperation: "viewputtake",
    },
  );
  if (!contextResult.success) {
    return contextResult;
  }
  const context = contextResult.data;
  const targetItemID = toInt(itemID, 0);
  if (!targetItemID) {
    return {
      success: false,
      errorMsg: "INVALID_SESSION_OR_ITEM",
    };
  }

  const containedResult = validateShipForMaintenanceSource(context, targetItemID);
  if (!containedResult.success) {
    return containedResult;
  }

  const launchAnchorEntity = options.launchAnchorEntity || context.sourceEntity;
  const launchState = buildLaunchStateNearSource(launchAnchorEntity);
  const updateResult = updateInventoryItem(targetItemID, (currentItem) => ({
    ...currentItem,
    locationID: context.systemID,
    flagID: 0,
    singleton: 1,
    spaceState: launchState,
  }));
  if (!updateResult.success) {
    return updateResult;
  }

  let spawnResult;
  try {
    spawnResult = spaceRuntime.spawnDynamicInventoryEntity(context.systemID, targetItemID, {
      sceneDescriptor: context.scene.sceneDescriptor || undefined,
    });
  } catch (error) {
    spawnResult = { success: false, errorMsg: error.message || "SPACE_SPAWN_FAILED" };
  }
  if (!spawnResult || spawnResult.success !== true) {
    const recovery = restoreMaintenanceLaunch(session, context, [containedResult.data]);
    log.warn(
      `[EjectRuntime] Launched maintenance ship=${targetItemID} from source=${context.sourceID} but dynamic spawn failed: ${spawnResult ? spawnResult.errorMsg : "UNKNOWN_ERROR"}`,
    );
    return {
      success: false,
      errorMsg: spawnResult && spawnResult.errorMsg || "SPACE_SPAWN_FAILED",
      data: { recovery },
    };
  }
  syncUpdatedItem(session, updateResult);

  return {
    success: true,
    data: {
      sourceID: context.sourceID,
      itemID: targetItemID,
      systemID: context.systemID,
      entity: spawnResult.data && spawnResult.data.entity || null,
      context,
    },
  };
}

function snapshotMaintenanceShipTree(ship) {
  const rows = [ship];
  const seen = new Set([Number(ship.itemID)]);
  for (let index = 0; index < rows.length; index += 1) {
    for (const child of listContainerItems(null, rows[index].itemID, null)) {
      if (!seen.has(Number(child.itemID))) {
        seen.add(Number(child.itemID));
        rows.push(child);
      }
    }
  }
  return rows;
}

// removeDynamicEntity answers SCENE_NOT_FOUND when no scene matches the
// descriptor it was given. That alone does not prove the hull left space, so
// only treat it as gone once no loaded scene still holds the entity.
function isShipAbsentFromSpace(removal, shipID) {
  if (!removal || removal.success !== false) {
    return false;
  }
  if (removal.errorMsg === "DYNAMIC_ENTITY_NOT_FOUND") {
    return true;
  }
  return removal.errorMsg === "SCENE_NOT_FOUND" &&
    !spaceRuntime.findSceneContainingDynamicEntity(shipID);
}

function attemptMaintenanceOperation(operation, errorMsg) {
  try {
    return operation() || { success: false, errorMsg };
  } catch (error) {
    log.warn(`[EjectRuntime] ${errorMsg}: ${error.message}`);
    return { success: false, errorMsg };
  }
}

function restoreMaintenanceLaunch(session, context, snapshot) {
  const shipID = snapshot[0].itemID;
  if (Number((getActiveShipRecord(session.characterID) || {}).itemID) === Number(shipID)) {
    return { success: false, errorMsg: "MAINTENANCE_RECOVERY_SHIP_ACTIVE", activeShipID: shipID };
  }
  const removal = attemptMaintenanceOperation(() => spaceRuntime.removeDynamicEntity(context.systemID, shipID, {
    forceVisibleSessions: [session], persistSpaceState: false,
    sceneDescriptor: context.scene.sceneDescriptor || undefined,
  }), "MAINTENANCE_RECOVERY_REMOVE_FAILED");
  if (removal && removal.success === false && !isShipAbsentFromSpace(removal, shipID)) return removal;
  const restored = attemptMaintenanceOperation(() => updateInventoryItemsAtomic(
    snapshot.map((item) => item.itemID), (_, index) => snapshot[index],
  ), "MAINTENANCE_RECOVERY_WRITE_FAILED");
  if (restored.success) {
    for (const change of restored.changes || []) {
      syncUpdatedItem(session, { success: true, data: change.item, previousData: change.previousData });
    }
  }
  return restored.success ? { success: true, restoredShipID: shipID } : restored;
}

function storeShipRecordInMaintenanceSource(session, shipItem, context, options = {}) {
  const shipID = toInt(shipItem && shipItem.itemID, 0);
  if (!shipID || !context || !context.sourceID) {
    return {
      success: false,
      errorMsg: "INVALID_SESSION_OR_ITEM",
    };
  }
  if (toInt(shipItem.categoryID, 0) !== CATEGORY_SHIP) {
    return {
      success: false,
      errorMsg: "ITEM_NOT_SHIP",
    };
  }
  if (toInt(shipItem.singleton, 0) !== 1) {
    return {
      success: false,
      errorMsg: "SHIP_NOT_ASSEMBLED",
    };
  }
  const contentValidation = validateShipAndContentsForMaintenanceSource(
    context,
    shipItem,
  );
  if (!contentValidation.success) {
    return contentValidation;
  }
  if (!canStoreShipInMaintenanceSource(context, shipItem)) {
    return {
      success: false,
      errorMsg: "SHIP_MAINTENANCE_BAY_FULL",
    };
  }

  const destinationFlagID = context.sourceIsShipBay ? ITEM_FLAGS.SHIP_HANGAR : 0;
  const updateResult = updateInventoryItem(shipID, (currentItem) => ({
    ...currentItem,
    locationID: context.sourceID,
    flagID: destinationFlagID,
    singleton: 1,
    spaceState: null,
  }));
  if (!updateResult.success) {
    return updateResult;
  }

  if (options.removeEntity !== false) {
    const removeResult = attemptMaintenanceOperation(() => spaceRuntime.removeDynamicEntity(
      context.systemID,
      shipID,
      {
        forceVisibleSessions: session ? [session] : [],
        // Inventory custody was already moved into the maintenance source.
        // Persisting the abandoned space entity here would overwrite that
        // committed location with its stale solar-system state.
        persistSpaceState: false,
        sceneDescriptor: context.scene.sceneDescriptor || undefined,
      },
    ), "MAINTENANCE_REMOVE_FAILED");
    if (
      removeResult &&
      removeResult.success === false &&
      !isShipAbsentFromSpace(removeResult, shipID)
    ) {
      log.warn(
        `[EjectRuntime] Stored maintenance ship=${shipID} in source=${context.sourceID} but dynamic removal failed: ${removeResult.errorMsg}`,
      );
      // A still-live hull must retain its space custody. Otherwise a retry can
      // launch a second presentation of the already visible ship.
      const recovery = updateInventoryItem(shipID, () => updateResult.previousData || shipItem);
      return { success: false, errorMsg: removeResult.errorMsg, data: { recovery } };
    }
  }

  syncUpdatedItem(session, updateResult);
  return {
    success: true,
    data: {
      sourceID: context.sourceID,
      itemID: shipID,
      storedItem: updateResult.data,
    },
  };
}

function boardStoredShipFromMaintenanceContainer(session, sourceLocationID, itemID) {
  const contextResult = resolveMaintenanceSourceContext(session, sourceLocationID, {
    rejectActiveSource: true,
    requireActiveRange: true,
    inventoryOperation: "viewputtake",
  });
  if (!contextResult.success) {
    return contextResult;
  }
  const context = contextResult.data;
  const currentShip = context.currentShip;
  if (context.sourceIsPosMaintenanceArray && currentShip && !isCapsuleTypeID(currentShip.typeID) &&
      !hasMaintenanceInventoryPermission(session,
        findItemById(context.sourceItem.spaceState.controlTowerID || context.sourceItem.controlTowerID),
        context.sourceID, "viewput")) {
    return { success: false, errorMsg: "POS_MAINTENANCE_ARRAY_ACCESS_DENIED" };
  }
  const targetShipID = toInt(itemID, 0);
  const targetResult = validateShipForMaintenanceSource(context, targetShipID);
  if (!targetResult.success) {
    return targetResult;
  }
  const strategicCruiserUseError = getStrategicCruiserTransitionUseError(
    session && session.characterID,
    targetResult.data,
  );
  if (strategicCruiserUseError) {
    return strategicCruiserUseError;
  }

  if (
    currentShip &&
    !isCapsuleTypeID(currentShip.typeID)
  ) {
    const contentValidation = validateShipAndContentsForMaintenanceSource(
      context,
      currentShip,
    );
    if (!contentValidation.success) {
      return contentValidation;
    }
    if (!canStoreShipInMaintenanceSource(context, currentShip, targetShipID)) {
      return {
        success: false,
        errorMsg: "SHIP_MAINTENANCE_BAY_FULL",
      };
    }
  }

  const targetSnapshot = snapshotMaintenanceShipTree(targetResult.data);
  if (context.sourceIsPosMaintenanceArray && Number(targetResult.data.ownerID) !== context.characterID) {
    // Configured SMA Use and Take permissions grant boarding custody. Move the
    // assembled hull and every nested fitting/cargo row together so its new
    // pilot can use them; the complete prior tree is retained for compensation.
    const ownership = updateInventoryItemsAtomic(targetSnapshot.map((item) => item.itemID), (item) => ({
      ...item, ownerID: context.characterID,
    }));
    if (!ownership.success) return ownership;
  }

  const launchResult = launchShipFromMaintenanceContainer(
    session,
    sourceLocationID,
    targetShipID,
    {
      launchAnchorEntity: context.activeEntity || context.sourceEntity,
    },
  );
  if (!launchResult.success) {
    const recovery = restoreMaintenanceLaunch(session, context, targetSnapshot);
    return { ...launchResult, data: { ...(launchResult.data || {}), recovery } };
  }

  const boardResult = attemptMaintenanceOperation(() => boardSpaceShip(session, targetShipID), "MAINTENANCE_BOARD_FAILED");
  if (!boardResult.success) {
    const activeShipID = Number((getActiveShipRecord(context.characterID) || {}).itemID) || 0;
    const recovery = activeShipID === targetShipID
      ? { success: false, errorMsg: "MAINTENANCE_RECOVERY_SHIP_ACTIVE", activeShipID }
      : restoreMaintenanceLaunch(session, context, targetSnapshot);
    return { ...boardResult, data: { ...(boardResult.data || {}), activeShipID, recovery } };
  }

  let storeResult = null;
  if (currentShip && !isCapsuleTypeID(currentShip.typeID)) {
    storeResult = attemptMaintenanceOperation(() => storeShipRecordInMaintenanceSource(
      session,
      currentShip,
      context,
      { removeEntity: true },
    ), "MAINTENANCE_STORE_FAILED");
    if (!storeResult.success) {
      log.warn(
        `[EjectRuntime] BoardStoredShip boarded ship=${targetShipID} but failed to store previous ship=${currentShip.itemID}: ${storeResult.errorMsg}`,
      );
      const boardingRecovery = attemptMaintenanceOperation(() => boardSpaceShip(session, currentShip.itemID), "MAINTENANCE_REBOARD_FAILED");
      const recovery = boardingRecovery.success
        ? restoreMaintenanceLaunch(session, context, targetSnapshot)
        : boardingRecovery;
      return { success: false, errorMsg: storeResult.errorMsg || "MAINTENANCE_SWAP_STORE_FAILED", data: {
        activeShipID: Number((getActiveShipRecord(context.characterID) || {}).itemID) || 0,
        recovery,
      } };
    }
  }

  return {
    success: true,
    data: {
      sourceID: context.sourceID,
      itemID: targetShipID,
      launchResult: launchResult.data || null,
      boardResult: boardResult.data || null,
      storeResult: storeResult && storeResult.success ? storeResult.data : null,
    },
  };
}

function storeActiveShipInMaintenanceContainer(session, sourceLocationID) {
  const contextResult = resolveMaintenanceSourceContext(session, sourceLocationID, {
    rejectActiveSource: true,
    requireActiveRange: true,
    inventoryOperation: "viewput",
  });
  if (!contextResult.success) {
    return contextResult;
  }
  const context = contextResult.data;
  const currentShip = context.currentShip;
  if (!currentShip) {
    return {
      success: false,
      errorMsg: "SHIP_NOT_FOUND",
    };
  }
  if (isCapsuleTypeID(currentShip.typeID)) {
    return {
      success: false,
      errorMsg: "CANNOT_STORE_CAPSULE",
    };
  }
  const contentValidation = validateShipAndContentsForMaintenanceSource(
    context,
    currentShip,
  );
  if (!contentValidation.success) {
    return contentValidation;
  }
  if (!canStoreShipInMaintenanceSource(context, currentShip)) {
    return {
      success: false,
      errorMsg: "SHIP_MAINTENANCE_BAY_FULL",
    };
  }

  const ejectResult = ejectSession(session);
  if (!ejectResult.success) {
    return ejectResult;
  }

  const storeResult = attemptMaintenanceOperation(() => storeShipRecordInMaintenanceSource(
    session,
    currentShip,
    context,
    { removeEntity: true },
  ), "MAINTENANCE_STORE_FAILED");
  if (!storeResult.success) {
    const recovery = attemptMaintenanceOperation(() => boardSpaceShip(session, currentShip.itemID), "MAINTENANCE_REBOARD_FAILED");
    return { ...storeResult, data: { ...(storeResult.data || {}), recovery,
      activeShipID: Number((getActiveShipRecord(context.characterID) || {}).itemID) || 0 } };
  }

  return {
    success: true,
    data: {
      sourceID: context.sourceID,
      storedShipID: currentShip.itemID,
      capsule:
        ejectResult.data && ejectResult.data.capsule
          ? ejectResult.data.capsule
          : null,
      storeResult: storeResult.data || null,
    },
  };
}

// "Recover to ship maintenance bay" on a ship in space is
// ship.ScoopToSMA(objectID) (menusvc.RealScoopSMA), offered for any ship
// that is not the pilot's own or a capsule while the active ship has a bay
// (celestialCheckers.OfferScoopToShipMaintenanceBay). The client flies to
// its 2,500 m interaction range first. The refusals owned here are the
// scoop's: own unpiloted hull, in this system, in range. The bay's contents
// and capacity rules are the shared ones storeShipRecordInMaintenanceSource
// applies.
function scoopShipIntoActiveShipMaintenanceBay(session, targetShipID) {
  const characterID = toInt(session && session.characterID, 0);
  const spaceState = session && session._space ? session._space : null;
  const systemID = toInt(spaceState && spaceState.systemID, 0);
  const activeShipID = toInt(spaceState && spaceState.shipID, 0);
  if (!characterID || !systemID || !activeShipID) {
    return { success: false, errorMsg: "NOT_IN_SPACE" };
  }

  const hostShip = findItemById(activeShipID);
  if (!hostShip || !isShipMaintenanceBaySource(hostShip)) {
    return { success: false, errorMsg: "SHIP_MAINTENANCE_BAY_NOT_AVAILABLE" };
  }

  const targetItemID = toInt(targetShipID, 0);
  const targetShip = targetItemID > 0 ? findItemById(targetItemID) : null;
  if (!targetShip || toInt(targetShip.categoryID, 0) !== CATEGORY_SHIP) {
    return { success: false, errorMsg: "SHIP_NOT_FOUND" };
  }
  if (targetItemID === activeShipID) {
    return { success: false, errorMsg: "SHIP_IS_PILOTED" };
  }
  if (toInt(targetShip.ownerID, 0) !== characterID) {
    return { success: false, errorMsg: "SHIP_NOT_OWNER" };
  }
  if (
    toInt(targetShip.locationID, 0) !== systemID ||
    toInt(targetShip.flagID, -1) !== 0
  ) {
    return { success: false, errorMsg: "SHIP_NOT_IN_SPACE" };
  }

  const scene = spaceRuntime.getSceneForSession(session);
  const hostEntity = scene ? scene.getEntityByID(activeShipID) : null;
  const targetEntity = scene ? scene.getEntityByID(targetItemID) : null;
  if (!hostEntity || !targetEntity) {
    return { success: false, errorMsg: "SHIP_NOT_IN_SPACE" };
  }
  if (targetEntity.session || toInt(targetEntity.pilotCharacterID, 0) > 0) {
    return { success: false, errorMsg: "SHIP_IS_PILOTED" };
  }
  if (
    surfaceDistanceBetweenEntities(hostEntity, targetEntity) >
    MAX_CARGO_CONTAINER_TRANSFER_DISTANCE_METERS
  ) {
    return { success: false, errorMsg: "TARGET_TOO_FAR" };
  }

  return storeShipRecordInMaintenanceSource(
    session,
    targetShip,
    {
      characterID,
      systemID,
      sourceID: activeShipID,
      sourceItem: hostShip,
      sourceEntity: hostEntity,
      sourceIsShipBay: true,
      sourceIsPosMaintenanceArray: false,
      scene,
      currentShip: hostShip,
      activeEntity: hostEntity,
    },
    { removeEntity: true },
  );
}

module.exports = {
  SHIP_FITTING_SERVICE_RANGE_METERS,
  isShipMaintenanceArraySource,
  isShipMaintenanceBaySource,
  validateMaintenanceFittingServiceAccess,
  launchShipOrContainerFromWreckOrContainer,
  launchShipFromMaintenanceContainer,
  boardStoredShipFromMaintenanceContainer,
  scoopShipIntoActiveShipMaintenanceBay,
  storeActiveShipInMaintenanceContainer,
  _testing: {
    buildLaunchStateNearSource,
    isLaunchableContainedItem,
    isShipAbsentFromSpace,
  },
};
