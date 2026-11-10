"use strict";
const { getObjectPosition, addVectors, normalizeDirection, toInt, scaleVector, isFinitePosition, getVectorDistance, normalizeText, toReal, normalizeVector, listPositiveInts, listUniquePositiveInts } = require("../domain/abyssalRuntimeValues");

function buildAbyssalNpcSpawnPosition(ports, {
  pocketState,
  roomIndex,
  npcProfile,
  npcEntry,
  spawnOrdinal,
  existingPositions,
  deps,
}) {
  const {
    resolveRoomOriginPosition,
    buildRoomConduitState,
    buildRoomLateralDirection,
    getPlaceholderRoomEntry,
    PLACEHOLDER_ROOM_CLEANUP_RADIUS_METERS,
    nextAbyssalEncounterRandom,
  } = ports;
  const capturedRelativePosition = getObjectPosition(
    npcEntry && npcEntry.capturedRoomRelativePosition,
  );
  if (capturedRelativePosition && npcEntry && npcEntry.capturedRetailObject === true) {
    return addVectors(
      resolveRoomOriginPosition(pocketState, roomIndex),
      capturedRelativePosition,
    );
  }
  const conduitState = buildRoomConduitState(pocketState, roomIndex);
  const direction = normalizeDirection(conduitState.direction, { x: 1, y: 0, z: 0 });
  const lateralDirection = buildRoomLateralDirection(pocketState, roomIndex);
  const roomEntry = getPlaceholderRoomEntry(pocketState, roomIndex);
  const playerLandingPosition =
    getObjectPosition(pocketState && pocketState.shipSpawnState && pocketState.shipSpawnState.position) ||
    getObjectPosition(roomEntry && roomEntry.shipSpawnState) ||
    resolveRoomOriginPosition(pocketState, roomIndex);
  const baseRadius = Math.max(
    5_000,
    Math.min(
      20_000,
      toInt(
        npcEntry && npcEntry.spawnRadiusMeters,
        toInt(npcEntry && npcEntry.spawnOffsetMeters, toInt(npcProfile && npcProfile.spawnRadiusMeters, 10_000)),
      ),
    ),
  );
  const jitter = Math.max(0, Math.min(5_000, toInt(npcProfile && npcProfile.spawnJitterMeters, 0)));
  const minimumConduitSeparation = 4_500;
  const minimumPlayerSeparation = 5_000;
  const minimumNpcSeparation = 1_500;
  const roomEnvelopeRadius = Math.max(60_000, PLACEHOLDER_ROOM_CLEANUP_RADIUS_METERS);
  const positions = Array.isArray(existingPositions) ? existingPositions : [];
  const fallbackAngle = ((spawnOrdinal % 12) / 12) * Math.PI * 2;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const randomAngle = nextAbyssalEncounterRandom(deps) * Math.PI * 2;
    const angle = attempt === 7
      ? fallbackAngle
      : randomAngle + (((spawnOrdinal + attempt) % 5) * 0.37);
    const radius = attempt === 7
      ? baseRadius
      : Math.max(5_000, Math.min(20_000, baseRadius + ((nextAbyssalEncounterRandom(deps) - 0.5) * jitter * 2)));
    const verticalOffset = attempt === 7
      ? 0
      : Math.trunc((nextAbyssalEncounterRandom(deps) - 0.5) * Math.min(1_000, jitter));
    const candidate = addVectors(
      addVectors(
        addVectors(
          conduitState.position,
          scaleVector(direction, Math.cos(angle) * radius),
        ),
        scaleVector(lateralDirection, Math.sin(angle) * radius),
      ),
      { x: 0, y: 0, z: verticalOffset },
    );
    if (!isFinitePosition(candidate)) {
      continue;
    }
    if (getVectorDistance(candidate, conduitState.position) < minimumConduitSeparation) {
      continue;
    }
    if (getVectorDistance(candidate, playerLandingPosition) < minimumPlayerSeparation) {
      continue;
    }
    if (getVectorDistance(candidate, resolveRoomOriginPosition(pocketState, roomIndex)) > roomEnvelopeRadius) {
      continue;
    }
    if (positions.some((position) => getVectorDistance(candidate, position) < minimumNpcSeparation)) {
      continue;
    }
    return candidate;
  }
  return addVectors(
    addVectors(
      conduitState.position,
      scaleVector(direction, Math.cos(fallbackAngle) * baseRadius),
    ),
    scaleVector(lateralDirection, Math.sin(fallbackAngle) * baseRadius),
  );
}

function buildSourceTransitionState(ports, validation) {
  const sourceShipEntity = validation && validation.data && validation.data.shipEntity;
  const sourceShipItem = validation && validation.data && validation.data.shipItem;
  const traceState = validation && validation.data && validation.data.traceState;
  const context = validation && validation.data && validation.data.context;
  return {
    sourceTraceItemID: toInt(traceState && traceState.traceItemID, 0),
    sourceSolarSystemID: toInt(traceState && traceState.solarSystemID, toInt(context && context.systemID, 0)),
    sourceLocationID: toInt(sourceShipItem && sourceShipItem.locationID, toInt(context && context.systemID, 0)),
    sourceTracePosition: getObjectPosition(traceState && traceState.sourceTracePosition) ||
      getObjectPosition(validation && validation.data && validation.data.tracePosition),
    sourceShipPosition: getObjectPosition(validation && validation.data && validation.data.shipPosition) ||
      getObjectPosition(sourceShipEntity) ||
      getObjectPosition(sourceShipItem),
    sourceShipDirection: normalizeDirection(
      sourceShipEntity && sourceShipEntity.direction ||
        sourceShipItem && sourceShipItem.spaceState && sourceShipItem.spaceState.direction,
      { x: 1, y: 0, z: 0 },
    ),
    sourceBallID: toInt(sourceShipEntity && sourceShipEntity.itemID, toInt(context && context.shipID, 0)),
    sourceBubbleID: toInt(sourceShipEntity && sourceShipEntity.bubbleID, 0),
    sourcePublicGridClusterKey:
      sourceShipEntity && sourceShipEntity.bubbleID
        ? String(sourceShipEntity.bubbleID)
        : null,
    sourceSceneKey: normalizeText(
      traceState && traceState.sourceSceneKey,
      `solar-system:${toInt(traceState && traceState.sourceSolarSystemID, toInt(context && context.systemID, 0))}`,
    ),
    sourceShipRadius: toReal(traceState && traceState.sourceShipRadius, 0),
    traceProfileID: normalizeText(traceState && traceState.traceProfileID, ""),
  };
}

function buildDeployStateFromShipEntity(ports, context, shipEntity, filamentDefinition = null) {
  const {
    resolveAbyssalTraceProfile,
    DEPLOY_DISTANCE_METERS,
  } = ports;
  const shipPosition = getObjectPosition(shipEntity);
  if (!shipPosition) {
    return null;
  }
  const direction = normalizeDirection(
    shipEntity && shipEntity.direction,
    { x: 1, y: 0, z: 0 },
  );
  const traceProfile = resolveAbyssalTraceProfile({
    filamentTypeID: toInt(filamentDefinition && filamentDefinition.filamentTypeID, 0),
    contentProfile: filamentDefinition,
  });
  const capturedOffset = traceProfile && traceProfile.spawnOffsetPolicy &&
    traceProfile.spawnOffsetPolicy.kind === "captured-fixed-source-vector"
      ? normalizeVector(traceProfile.spawnOffsetPolicy.vectorMeters)
      : null;
  const deployedPosition = addVectors(
    shipPosition,
    capturedOffset || scaleVector(direction, DEPLOY_DISTANCE_METERS),
  );
  return {
    systemID: context.systemID,
    position: deployedPosition,
    velocity: { x: 0, y: 0, z: 0 },
    direction,
    targetPoint: deployedPosition,
    mode: "STOP",
    speedFraction: 0,
  };
}

function buildPlaceholderPocketPosition(ports, validation) {
  const {
    PLACEHOLDER_POCKET_OFFSET_METERS,
  } = ports;
  const traceState = validation && validation.data && validation.data.traceState;
  const anchor =
    validation && validation.data && validation.data.tracePosition ||
    validation && validation.data && validation.data.shipPosition ||
    getObjectPosition(validation && validation.data && validation.data.shipEntity) ||
    { x: 0, y: 0, z: 0 };
  const traceOffset = toInt(traceState && traceState.traceItemID, 0) % 1000;
  const characterOffset = toInt(traceState && traceState.characterID, 0) % 1000;
  return {
    x: anchor.x + PLACEHOLDER_POCKET_OFFSET_METERS + (traceOffset * 1_000),
    y: anchor.y + (characterOffset * 1_000),
    z: anchor.z + (traceOffset * 250),
  };
}

function buildPlaceholderShipSpaceState(ports, validation, pocketPosition) {
  const {
    PLACEHOLDER_POCKET_SHIP_OFFSET_METERS,
  } = ports;
  const direction = normalizeDirection(
    validation &&
      validation.data &&
      validation.data.shipEntity &&
      validation.data.shipEntity.direction,
    { x: 1, y: 0, z: 0 },
  );
  const spawnPosition = addVectors(
    normalizeVector(pocketPosition),
    scaleVector(direction, PLACEHOLDER_POCKET_SHIP_OFFSET_METERS),
  );
  return {
    systemID: toInt(validation && validation.data && validation.data.context.systemID, 0),
    position: spawnPosition,
    velocity: { x: 0, y: 0, z: 0 },
    direction,
    targetPoint: spawnPosition,
    mode: "STOP",
    speedFraction: 0,
  };
}


function buildPlaceholderReturnSpaceState(ports, pocketState, currentShipEntity = null) {
  const {
    resolveAbyssalTraceProfile,
    getContentProfile,
    PLACEHOLDER_RETURN_OFFSET_METERS,
  } = ports;
  const sourcePosition = getObjectPosition(pocketState && pocketState.sourceTracePosition) ||
    getObjectPosition(pocketState && pocketState.sourceShipPosition) ||
    { x: 0, y: 0, z: 0 };
  const sourceDirection = normalizeDirection(
    currentShipEntity && currentShipEntity.direction ||
      pocketState && pocketState.sourceShipDirection,
    { x: 1, y: 0, z: 0 },
  );
  const traceProfile = resolveAbyssalTraceProfile({
    traceProfileID: pocketState && pocketState.traceProfileID,
    contentProfile: getContentProfile(pocketState),
  });
  const returnPolicy = traceProfile && traceProfile.returnOffsetPolicy;
  const shipRadius = Math.max(
    0,
    currentShipEntity && currentShipEntity.radius !== undefined && currentShipEntity.radius !== null
      ? toReal(currentShipEntity.radius, 0)
      : toReal(pocketState && pocketState.sourceShipRadius, 0),
  );
  const returnDirection = returnPolicy && returnPolicy.kind === "captured-direction-with-surface-clearance"
    ? normalizeDirection(returnPolicy.unitVector, sourceDirection)
    : sourceDirection;
  const returnCenterDistance = returnPolicy
    ? toReal(returnPolicy.surfaceDistanceMeters, 0) +
      toReal(traceProfile.radiusMeters, 0) +
      shipRadius
    : PLACEHOLDER_RETURN_OFFSET_METERS;
  const returnPosition = addVectors(
    sourcePosition,
    scaleVector(returnDirection, returnCenterDistance),
  );
  return {
    systemID: toInt(pocketState && pocketState.sourceSolarSystemID, 0),
    position: returnPosition,
    velocity: { x: 0, y: 0, z: 0 },
    direction: sourceDirection,
    targetPoint: returnPosition,
    mode: "STOP",
    speedFraction: 0,
  };
}

function isPointWithinPocketRecoveryRadius(ports, point, pocketState) {
  const {
    PLACEHOLDER_RELOG_RECOVERY_RADIUS_METERS,
  } = ports;
  const currentPosition = getObjectPosition(point);
  const pocketPosition = getObjectPosition(pocketState && pocketState.pocketPosition);
  if (!currentPosition || !pocketPosition) {
    return false;
  }
  return getVectorDistance(currentPosition, pocketPosition) <= PLACEHOLDER_RELOG_RECOVERY_RADIUS_METERS;
}

function buildRewardCacheSpawnState(ports, pocketState, deps = ports.getDependencies()) {
  const {
    getCacheProfile,
    buildPlaceholderRoomState,
    getCapturedT0DarkRoom,
    resolveRoomOriginPosition,
    cloneValue,
    getCapturedAuthoredRoom,
    getCapturedAuthoredRoomEntity,
    buildCapturedAuthoredDunRotation,
    buildRoomOffsetFromConduitState,
    PLACEHOLDER_REWARD_CACHE_OFFSET_METERS,
  } = ports;
  const cacheProfile = getCacheProfile(pocketState);
  const roomState = buildPlaceholderRoomState(pocketState);
  const capturedRoom = getCapturedT0DarkRoom(
    pocketState,
    roomState.currentRoomIndex,
  );
  if (capturedRoom && capturedRoom.rewardCache) {
    const position = addVectors(
      resolveRoomOriginPosition(pocketState, roomState.currentRoomIndex),
      capturedRoom.rewardCache.position,
    );
    return {
      position,
      velocity: { x: 0, y: 0, z: 0 },
      direction: normalizeDirection(
        pocketState && pocketState.shipSpawnState && pocketState.shipSpawnState.direction,
        { x: 1, y: 0, z: 0 },
      ),
      targetPoint: position,
      mode: "STOP",
      speedFraction: 0,
      dunPosition: [
        toReal(capturedRoom.rewardCache.position.x, 0),
        toReal(capturedRoom.rewardCache.position.y, 0),
        toReal(capturedRoom.rewardCache.position.z, 0),
      ],
      dunRotation: cloneValue(capturedRoom.rewardCache.rotation),
    };
  }
  const capturedAuthoredRoom = getCapturedAuthoredRoom(
    pocketState,
    roomState.currentRoomIndex,
  );
  const capturedAuthoredCache = getCapturedAuthoredRoomEntity(
    capturedAuthoredRoom,
    "mainCacheEntityID",
    ["main-cache"],
  );
  if (capturedAuthoredCache) {
    const relativePosition = getObjectPosition(capturedAuthoredCache.position);
    const position = addVectors(
      resolveRoomOriginPosition(pocketState, roomState.currentRoomIndex),
      relativePosition,
    );
    return {
      position,
      velocity: { x: 0, y: 0, z: 0 },
      direction: normalizeDirection(
        pocketState && pocketState.shipSpawnState && pocketState.shipSpawnState.direction,
        { x: 1, y: 0, z: 0 },
      ),
      targetPoint: position,
      mode: "STOP",
      speedFraction: 0,
      dunPosition: [
        toReal(relativePosition.x, 0),
        toReal(relativePosition.y, 0),
        toReal(relativePosition.z, 0),
      ],
      dunRotation: buildCapturedAuthoredDunRotation(capturedAuthoredCache),
      dunObjectID: toInt(capturedAuthoredCache.dunObjectID, 0) || null,
      capturedRetailObject: true,
      authoredEntityID: normalizeText(capturedAuthoredCache.entityID, "") || null,
    };
  }
  return buildRoomOffsetFromConduitState(
    pocketState,
    roomState.currentRoomIndex,
    0,
    toInt(
      cacheProfile && cacheProfile.cacheOffsetMeters,
      PLACEHOLDER_REWARD_CACHE_OFFSET_METERS,
    ),
    0,
  );
}

function buildExtractionNodeSpawnStates(ports,
  pocketState,
  extractionNodeProfile,
  roomIndex,
  deps = ports.getDependencies(),
) {
  const {
    TYPE_ABYSSAL_EXTRACTION_NODE,
    MIN_EXTRACTION_NODE_FROM_CONDUIT_METERS,
    PLACEHOLDER_EXTRACTION_NODE_FROM_CONDUIT_METERS,
    buildRoomOffsetFromConduitState,
  } = ports;
  const selectionKey = [
    toInt(pocketState && pocketState.instanceID, 0),
    toInt(roomIndex, 0),
    normalizeText(extractionNodeProfile && extractionNodeProfile.extractionNodeProfileID, ""),
  ].join(":");
  const deterministicValue = (suffix) => {
    let hash = 2_166_136_261;
    for (const character of `${selectionKey}:${suffix}`) {
      hash ^= character.charCodeAt(0);
      hash = Math.imul(hash, 16_777_619) >>> 0;
    }
    return (hash >>> 0) / 4_294_967_296;
  };
  const observedStructureTypeIDs = listPositiveInts(
    extractionNodeProfile && extractionNodeProfile.observedStructureTypeIDs,
  );
  const minimumSpawnCount = Math.max(0, toInt(
    extractionNodeProfile && extractionNodeProfile.minimumSpawnCount,
    toInt(extractionNodeProfile && extractionNodeProfile.spawnCount, 0),
  ));
  const maximumSpawnCount = Math.max(minimumSpawnCount, toInt(
    extractionNodeProfile && extractionNodeProfile.maximumSpawnCount,
    minimumSpawnCount,
  ));
  const spawnCount = observedStructureTypeIDs.length > 0
    ? observedStructureTypeIDs.length
    : minimumSpawnCount + Math.floor(
      deterministicValue("count") * (maximumSpawnCount - minimumSpawnCount + 1),
    );
  const structureTypeIDs = observedStructureTypeIDs.length > 0
    ? observedStructureTypeIDs
    : listUniquePositiveInts(
      extractionNodeProfile && extractionNodeProfile.structureTypeIDs,
    );
  if (structureTypeIDs.length === 0) {
    structureTypeIDs.push(TYPE_ABYSSAL_EXTRACTION_NODE);
  }
  const spawnOffsetMeters = Math.max(
    MIN_EXTRACTION_NODE_FROM_CONDUIT_METERS,
    toInt(extractionNodeProfile && extractionNodeProfile.spawnOffsetMeters, PLACEHOLDER_EXTRACTION_NODE_FROM_CONDUIT_METERS),
  );
  const spawnStates = [];
  for (let index = 0; index < spawnCount; index += 1) {
    const lateralOffsetMeters = (index - ((spawnCount - 1) / 2)) * 1_500;
    spawnStates.push({
      nodeIndex: index + 1,
      structureTypeID: observedStructureTypeIDs.length > 0
        ? observedStructureTypeIDs[index]
        : structureTypeIDs[Math.floor(
          deterministicValue(`type:${index}`) * structureTypeIDs.length,
        ) % structureTypeIDs.length],
      ...buildRoomOffsetFromConduitState(
        pocketState,
        roomIndex,
        0,
        spawnOffsetMeters + lateralOffsetMeters,
        index % 2 === 0 ? 0 : 500,
      ),
    });
  }
  return spawnStates;
}

function createAbyssalSpawnGeometry(ports) {
  return {
    buildAbyssalNpcSpawnPosition: buildAbyssalNpcSpawnPosition.bind(null, ports),
    buildSourceTransitionState: buildSourceTransitionState.bind(null, ports),
    buildDeployStateFromShipEntity: buildDeployStateFromShipEntity.bind(null, ports),
    buildPlaceholderPocketPosition: buildPlaceholderPocketPosition.bind(null, ports),
    buildPlaceholderShipSpaceState: buildPlaceholderShipSpaceState.bind(null, ports),
    buildPlaceholderReturnSpaceState: buildPlaceholderReturnSpaceState.bind(null, ports),
    isPointWithinPocketRecoveryRadius: isPointWithinPocketRecoveryRadius.bind(null, ports),
    buildRewardCacheSpawnState: buildRewardCacheSpawnState.bind(null, ports),
    buildExtractionNodeSpawnStates: buildExtractionNodeSpawnStates.bind(null, ports),
  };
}

module.exports = { createAbyssalSpawnGeometry };
