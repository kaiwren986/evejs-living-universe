"use strict";
const { getObjectItemID, toInt, getObjectPosition, getObjectTypeID, getObjectRadius, getVectorDistance } = require("../domain/abyssalRuntimeValues");

function appendPlacementBlocker(ports, blockers, seenKeys, source, deps, options = {}) {
  const {
    matchesTypeList,
    FILAMENT_PROXIMITY_RESTRICTION_LIST_ID,
  } = ports;
  if (!source || typeof source !== "object") {
    return;
  }

  const itemID = getObjectItemID(source);
  if (itemID > 0 && itemID === toInt(options.excludeItemID, 0)) {
    return;
  }

  const position = getObjectPosition(source);
  if (!position) {
    return;
  }

  const typeID = getObjectTypeID(source);
  const typeRecord = typeID > 0 ? deps.resolveItemByTypeID(typeID) : null;
  const groupID = toInt(
    source.groupID,
    toInt(typeRecord && typeRecord.groupID, 0),
  );
  const categoryID = toInt(
    source.categoryID,
    toInt(typeRecord && typeRecord.categoryID, 0),
  );
  const typeListMatcher = typeof deps.matchesTypeList === "function"
    ? deps.matchesTypeList
    : matchesTypeList;
  if (!typeListMatcher({ typeID, groupID, categoryID }, FILAMENT_PROXIMITY_RESTRICTION_LIST_ID)) {
    return;
  }
  const seenKey = itemID > 0
    ? `item:${itemID}`
    : `type:${typeID}:${position.x}:${position.y}:${position.z}`;
  if (seenKeys.has(seenKey)) {
    return;
  }
  seenKeys.add(seenKey);

  blockers.push({
    itemID,
    typeID,
    groupID,
    position,
    radius: getObjectRadius(source, typeRecord),
  });
}

function collectPlacementBlockers(ports, session, context, deps, options = {}) {
  const blockers = [];
  const seenKeys = new Set();
  const systemID = toInt(context && context.systemID, 0);
  if (systemID <= 0) {
    return blockers;
  }

  const append = (source) => appendPlacementBlocker(ports,
    blockers,
    seenKeys,
    source,
    deps,
    options,
  );

  for (const source of deps.worldData.getStaticSceneForSystem(systemID)) {
    append(source);
  }

  for (const source of deps.listSystemSpaceItems(systemID)) {
    append(source);
  }

  const scene = session ? deps.getSceneForSession(session) : null;
  if (scene) {
    const dynamicEntities = typeof scene.getDynamicEntities === "function"
      ? scene.getDynamicEntities()
      : scene.dynamicEntities instanceof Map
        ? [...scene.dynamicEntities.values()]
        : [];
    for (const entity of dynamicEntities) {
      append(entity);
    }
  }

  return blockers;
}

function findPlacementConflict(ports, session, context, shipEntity, deps) {
  const {
    MIN_DISTANCE_FROM_DISALLOWED_OBJECTS_METERS,
  } = ports;
  const shipPosition = getObjectPosition(shipEntity);
  if (!shipPosition) {
    return {
      errorMsg: "ABYSSAL_SHIP_POSITION_UNAVAILABLE",
    };
  }

  const blockers = collectPlacementBlockers(ports,
    session,
    context,
    deps,
    {
      excludeItemID: context.shipID,
    },
  );

  for (const blocker of blockers) {
    const distance = getVectorDistance(shipPosition, blocker.position);
    if (distance <= MIN_DISTANCE_FROM_DISALLOWED_OBJECTS_METERS) {
      return {
        errorMsg: "ABYSSAL_TRACE_TOO_CLOSE_TO_OBJECT",
        blocker,
        distance,
        surfaceDistance: distance,
      };
    }
  }

  return null;
}

function createAbyssalDeploymentPlacement(ports) {
  return {
    appendPlacementBlocker: appendPlacementBlocker.bind(null, ports),
    collectPlacementBlockers: collectPlacementBlockers.bind(null, ports),
    findPlacementConflict: findPlacementConflict.bind(null, ports),
  };
}

module.exports = { createAbyssalDeploymentPlacement };
