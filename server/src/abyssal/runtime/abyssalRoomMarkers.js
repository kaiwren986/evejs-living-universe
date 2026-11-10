"use strict";

const { normalizeText } = require("../domain/abyssalValueUtils");

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

// Inventory-backed room markers and their scene-scoped materialization.
// Activation authority and persisted room ownership remain with the caller.
function buildPocketMarkerCustomInfo({
  buildPlaceholderRoomState,
  clampRoomIndex,
  ABYSSAL_ROOM_ENTITY_ROLES,
  listAbyssalParticipantCharacterIDs,
  cloneValue,
  isFinalRoomIndex,
  toReal,
  buildCapturedRetailIdentityState,
}, pocketState, markerKind, options = {}) {
  const roomState = buildPlaceholderRoomState(pocketState);
  const roomIndex = clampRoomIndex(
    toInt(options.roomIndex, roomState.currentRoomIndex),
    roomState.implementedRooms,
  );
  return JSON.stringify({
    evejsAbyssalPocketMarker: {
      markerKind: normalizeText(markerKind, "origin"),
      abyssalEntityRole: markerKind === "exit"
        ? ABYSSAL_ROOM_ENTITY_ROLES.CONDUIT
        : ABYSSAL_ROOM_ENTITY_ROLES.ORIGIN_MARKER,
      abyssalDefinitionID: normalizeText(
        options.abyssalDefinitionID,
        markerKind === "exit"
          ? `abyssal:conduit:${normalizeText(options.conduitRole, "transfer")}`
          : "abyssal:room-origin-marker",
      ),
      presentationEnabled: true,
      mechanicsEnabled: markerKind === "exit",
      instanceID: toInt(pocketState.instanceID, 0),
      traceItemID: toInt(pocketState.traceItemID, 0),
      characterID: toInt(pocketState.characterID, 0),
      participantCharacterIDs: listAbyssalParticipantCharacterIDs(pocketState),
      shipID: toInt(pocketState.shipID, 0),
      solarSystemID: toInt(pocketState.solarSystemID, 0),
      activatedAtMs: toInt(pocketState.activatedAtMs, 0),
      roomIndex,
      totalRooms: toInt(roomState.implementedRooms, 1),
      deliveryState: normalizeText(options.deliveryState, ""),
      transitionToken: toInt(options.transitionToken, 0),
      selectedRoomLayoutID: normalizeText(options.selectedRoomLayoutID, ""),
      roomOriginPosition: cloneValue(options.roomOriginPosition) || null,
      authoredLocalPosition: cloneValue(options.authoredLocalPosition) || null,
      worldPosition: cloneValue(options.worldPosition) || null,
      conduitRole: normalizeText(
        options.conduitRole,
        markerKind === "exit" && isFinalRoomIndex(pocketState, roomIndex)
          ? "final_exit"
          : markerKind === "exit"
            ? "transfer"
            : "origin",
      ),
      conduitOpen: markerKind === "exit" && options.conduitOpen === true,
      conduitOpenedAtMs: markerKind === "exit" ? toInt(options.conduitOpenedAtMs, 0) : 0,
      dunObjectID: toInt(options.dunObjectID, 0),
      dunPosition: Array.isArray(options.dunPosition)
        ? options.dunPosition.map((entry) => toReal(entry, 0))
        : null,
      dunRotation: Array.isArray(options.dunRotation)
        ? cloneValue(options.dunRotation)
        : null,
      capturedRetailObject: options.capturedRetailObject === true,
      ...buildCapturedRetailIdentityState(options.identity, pocketState.characterID),
      // Transfer and exit conduits are live mechanics even when a specific TQ
      // capture did not supply their optional presentation identity.
      placeholderContent: false,
    },
  });
}

function readPocketMarkerStateFromItem({
  parseCustomInfo,
  normalizeLowerText,
}, item) {
  if (!item) {
    return null;
  }
  const parsed = parseCustomInfo(item.customInfo);
  const rawState = parsed && parsed.evejsAbyssalPocketMarker;
  if (!rawState || typeof rawState !== "object") {
    return null;
  }
  return {
    markerKind: normalizeLowerText(rawState.markerKind, "origin"),
    abyssalEntityRole: normalizeText(rawState.abyssalEntityRole, ""),
    abyssalDefinitionID: normalizeText(rawState.abyssalDefinitionID, ""),
    presentationEnabled: rawState.presentationEnabled !== false,
    mechanicsEnabled: rawState.mechanicsEnabled === true,
    instanceID: toInt(rawState.instanceID, 0),
    traceItemID: toInt(rawState.traceItemID, 0),
    characterID: toInt(rawState.characterID, 0),
    shipID: toInt(rawState.shipID, 0),
    solarSystemID: toInt(rawState.solarSystemID, toInt(item.locationID, 0)),
    activatedAtMs: toInt(rawState.activatedAtMs, 0),
    roomIndex: toInt(rawState.roomIndex, 1),
    totalRooms: toInt(rawState.totalRooms, 1),
    conduitRole: normalizeText(rawState.conduitRole, ""),
    placeholderContent: rawState.placeholderContent !== false,
  };
}

function spawnPocketDynamicInventoryEntity({
  getDependencies,
  usesIsolatedAbyssalScene,
  buildAbyssalSceneDescriptor,
}, pocketState, itemID, deps = getDependencies(), options = {}) {
  const runtime = deps;
  if (!runtime || typeof runtime.spawnDynamicInventoryEntity !== "function") {
    return {
      success: false,
      errorMsg: "RUNTIME_SPAWN_UNSUPPORTED",
    };
  }
  const sceneDescriptor = usesIsolatedAbyssalScene(pocketState, deps)
    ? buildAbyssalSceneDescriptor(pocketState, deps)
    : null;
  return runtime.spawnDynamicInventoryEntity(
    toInt(pocketState && pocketState.solarSystemID, 0),
    itemID,
    sceneDescriptor
      ? {
          ...options,
          sceneDescriptor,
        }
      : options,
  );
}

function ensurePocketMarker({
  buildPlaceholderRoomState,
  clampRoomIndex,
  getPlaceholderRoomEntry,
  TYPE_ABYSSAL_TRANSFER_CONDUIT,
  TYPE_ABYSSAL_TRACE,
  normalizeDirection,
  cloneValue,
  buildPocketMarkerCustomInfo,
  spawnPocketDynamicInventoryEntity,
  ABYSSAL_ROOM_ENTITY_ROLES,
  ABYSSAL_ROOM_DELIVERY_STATE,
  destroyPlaceholderTrace,
  buildAbyssalSceneDescriptor,
  syncInventoryChanges,
}, markerKind, markerLabel, position, pocketState, session, deps, options = {}) {
  const roomState = buildPlaceholderRoomState(pocketState);
  const roomIndex = clampRoomIndex(
    toInt(options.roomIndex, roomState.currentRoomIndex),
    roomState.implementedRooms,
  );
  const roomEntry = getPlaceholderRoomEntry(pocketState, roomIndex);
  const existingItemID = markerKind === "origin"
    ? toInt(roomEntry.originMarkerItemID, 0)
    : toInt(roomEntry.conduitItemID, 0);
  if (existingItemID > 0 && deps.findItemById(existingItemID)) {
    return {
      success: true,
      created: false,
      itemID: existingItemID,
      changes: [],
    };
  }

  const markerTypeID = markerKind === "exit"
    ? toInt(options.typeID, 0) || TYPE_ABYSSAL_TRANSFER_CONDUIT
    : TYPE_ABYSSAL_TRACE;
  const createResult = deps.createSpaceItemForOwner(
    pocketState.characterID,
    pocketState.solarSystemID,
    markerTypeID,
    {
      itemName: markerLabel,
      position,
      velocity: { x: 0, y: 0, z: 0 },
      direction: normalizeDirection(
        pocketState.shipSpawnState && pocketState.shipSpawnState.direction,
        { x: 1, y: 0, z: 0 },
      ),
      targetPoint: position,
      speedFraction: 0,
      mode: "STOP",
      dunPosition: cloneValue(options.dunPosition),
      dunRotation: cloneValue(options.dunRotation),
      customInfo: buildPocketMarkerCustomInfo(pocketState, markerKind, {
        roomIndex,
        conduitRole: normalizeText(options.conduitRole, ""),
        conduitOpen: roomEntry.objectiveComplete === true || options.conduitOpen === true,
        conduitOpenedAtMs: toInt(roomEntry.conduitOpenedAtMs, 0),
        dunObjectID: toInt(options.dunObjectID, 0),
        dunPosition: cloneValue(options.dunPosition),
        dunRotation: cloneValue(options.dunRotation),
        identity: cloneValue(options.identity),
        capturedRetailObject: options.capturedRetailObject === true,
        deliveryState: normalizeText(options.deliveryState, ""),
        transitionToken: toInt(options.transitionToken, 0),
        selectedRoomLayoutID: normalizeText(options.selectedRoomLayoutID, ""),
        roomOriginPosition: cloneValue(options.roomOriginPosition),
        authoredLocalPosition: cloneValue(options.authoredLocalPosition),
        worldPosition: cloneValue(position),
      }),
    },
  );
  if (!createResult || !createResult.success || !createResult.data) {
    return {
      success: false,
      errorMsg: createResult && createResult.errorMsg || `${markerKind.toUpperCase()}_MARKER_CREATE_FAILED`,
    };
  }

  const markerItemID = toInt(createResult.data.itemID, 0);
  const spawnResult = spawnPocketDynamicInventoryEntity(
    pocketState,
    markerItemID,
    deps,
    {
      initialPublication: options.prewarm === true ? "deferred" : undefined,
      suppressInitialPublication: options.prewarm === true,
      runtimeEntityMetadata: options.prewarm === true
        ? {
            abyssalRunID: toInt(pocketState && pocketState.instanceID, 0),
            abyssalRoomIndex: roomIndex,
            abyssalEntityRole: markerKind === "exit"
              ? ABYSSAL_ROOM_ENTITY_ROLES.CONDUIT
              : ABYSSAL_ROOM_ENTITY_ROLES.ORIGIN_MARKER,
            abyssalRoomDeliveryState: normalizeText(
              options.deliveryState,
              ABYSSAL_ROOM_DELIVERY_STATE.PREWARMED_HIDDEN,
            ),
            evejsAbyssalRoomDeliveryState: normalizeText(
              options.deliveryState,
              ABYSSAL_ROOM_DELIVERY_STATE.PREWARMED_HIDDEN,
            ),
            abyssalSelectedRoomLayoutID: normalizeText(options.selectedRoomLayoutID, ""),
            abyssalTransitionToken: toInt(options.transitionToken, 0),
            evejsAbyssalRoomOriginPosition: cloneValue(options.roomOriginPosition),
            evejsAbyssalAuthoredLocalPosition: cloneValue(options.authoredLocalPosition),
          }
        : undefined,
    },
  );
  if (!spawnResult || !spawnResult.success) {
    destroyPlaceholderTrace(
      pocketState.solarSystemID,
      markerItemID,
      deps,
      `${markerKind}-marker-spawn-failed`,
      "Abyssal trace",
      {
        sceneDescriptor: buildAbyssalSceneDescriptor(pocketState, deps) || undefined,
      },
    );
    return {
      success: false,
      errorMsg: spawnResult && spawnResult.errorMsg || `${markerKind.toUpperCase()}_MARKER_SPAWN_FAILED`,
    };
  }

  syncInventoryChanges(session, createResult.changes || [], deps);
  return {
    success: true,
    created: true,
    itemID: markerItemID,
    changes: createResult.changes || [],
  };
}

function createAbyssalRoomMarkers({
  buildPlaceholderRoomState,
  clampRoomIndex,
  ABYSSAL_ROOM_ENTITY_ROLES,
  listAbyssalParticipantCharacterIDs,
  cloneValue,
  isFinalRoomIndex,
  toReal,
  buildCapturedRetailIdentityState,
  parseCustomInfo,
  normalizeLowerText,
  getDependencies,
  usesIsolatedAbyssalScene,
  buildAbyssalSceneDescriptor,
  getPlaceholderRoomEntry,
  TYPE_ABYSSAL_TRANSFER_CONDUIT,
  TYPE_ABYSSAL_TRACE,
  normalizeDirection,
  ABYSSAL_ROOM_DELIVERY_STATE,
  destroyPlaceholderTrace,
  syncInventoryChanges,
}) {

  const ports = {
    buildPlaceholderRoomState,
    clampRoomIndex,
    ABYSSAL_ROOM_ENTITY_ROLES,
    listAbyssalParticipantCharacterIDs,
    cloneValue,
    isFinalRoomIndex,
    toReal,
    buildCapturedRetailIdentityState,
    parseCustomInfo,
    normalizeLowerText,
    getDependencies,
    usesIsolatedAbyssalScene,
    buildAbyssalSceneDescriptor,
    getPlaceholderRoomEntry,
    TYPE_ABYSSAL_TRANSFER_CONDUIT,
    TYPE_ABYSSAL_TRACE,
    normalizeDirection,
    ABYSSAL_ROOM_DELIVERY_STATE,
    destroyPlaceholderTrace,
    syncInventoryChanges,
  };
  ports.buildPocketMarkerCustomInfo = buildPocketMarkerCustomInfo.bind(null, ports);
  ports.readPocketMarkerStateFromItem = readPocketMarkerStateFromItem.bind(null, ports);
  ports.spawnPocketDynamicInventoryEntity = spawnPocketDynamicInventoryEntity.bind(null, ports);
  ports.ensurePocketMarker = ensurePocketMarker.bind(null, ports);
  Object.freeze(ports);
  return {
    buildPocketMarkerCustomInfo: ports.buildPocketMarkerCustomInfo,
    readPocketMarkerStateFromItem: ports.readPocketMarkerStateFromItem,
    spawnPocketDynamicInventoryEntity: ports.spawnPocketDynamicInventoryEntity,
    ensurePocketMarker: ports.ensurePocketMarker,
  };
}

module.exports = { createAbyssalRoomMarkers };
