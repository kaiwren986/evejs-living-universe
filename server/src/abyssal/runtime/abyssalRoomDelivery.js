"use strict";

const { normalizeText } = require("../domain/abyssalValueUtils");

// Runtime/inventory delivery and retirement stay behind existing exact-scope authorities.
function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function listAbyssalRoomBootstrapEntityIDs(ports, pocketState, roomIndex = null) {
  const {
    buildPlaceholderRoomState,
    clampRoomIndex,
    getPlaceholderRoomEntry,
    listUniquePositiveInts,
  } = ports;
  if (!pocketState) {
    return [];
  }
  const roomState = buildPlaceholderRoomState(pocketState);
  const resolvedRoomIndex = clampRoomIndex(
    toInt(roomIndex, roomState.currentRoomIndex),
    roomState.implementedRooms,
  );
  const roomEntry = getPlaceholderRoomEntry(pocketState, resolvedRoomIndex);
  return listUniquePositiveInts([
    toInt(
      roomEntry && roomEntry.originMarkerItemID,
      resolvedRoomIndex === roomState.currentRoomIndex
        ? toInt(pocketState.originMarkerItemID, 0)
        : 0,
    ),
    toInt(
      roomEntry && roomEntry.conduitItemID,
      resolvedRoomIndex === roomState.currentRoomIndex
        ? toInt(pocketState.exitMarkerItemID, 0)
        : 0,
    ),
    ...listUniquePositiveInts(roomEntry && roomEntry.hostileEntityIDs),
    ...(Array.isArray(roomEntry && roomEntry.extractionNodeItemIDs)
      ? roomEntry.extractionNodeItemIDs
      : []),
    ...(Array.isArray(roomEntry && roomEntry.extractionNodeLootContainerItemIDs)
      ? roomEntry.extractionNodeLootContainerItemIDs
      : []),
    ...(Array.isArray(roomEntry && roomEntry.sceneryVisualEntityIDs)
      ? roomEntry.sceneryVisualEntityIDs
      : []),
    toInt(roomEntry && roomEntry.sceneryProbeEntityID, 0),
    ...(Array.isArray(roomEntry && roomEntry.environmentalObjectItemIDs)
      ? roomEntry.environmentalObjectItemIDs
      : []),
    toInt(roomEntry && roomEntry.cacheItemID, 0),
    toInt(roomEntry && roomEntry.cacheStructureItemID, 0),
    toInt(roomEntry && roomEntry.cacheLootContainerItemID, 0),
  ]);
}

function listCurrentRoomBootstrapEntityIDs(ports, pocketState) {
  const {
    buildPlaceholderRoomState,
  } = ports;
  const roomState = buildPlaceholderRoomState(pocketState);
  return listAbyssalRoomBootstrapEntityIDs(ports, pocketState, roomState.currentRoomIndex);
}

function listAbyssalRoomRetirementEntityIDs(ports,
  pocketState,
  roomIndex,
  session = null,
  deps = ports.getDependencies(),
) {
  const {
    buildPlaceholderRoomState,
    clampRoomIndex,
    listUniquePositiveInts,
    getPocketScene,
    listAbyssalRoomEntityRecords,
    resolveExactAbyssalRunRoomScope,
  } = ports;
  if (!pocketState) {
    return [];
  }
  const roomState = buildPlaceholderRoomState(pocketState);
  const resolvedRoomIndex = clampRoomIndex(
    toInt(roomIndex, roomState.currentRoomIndex),
    roomState.implementedRooms,
  );
  const runID = toInt(pocketState.instanceID, 0);
  const scene = getPocketScene(pocketState, deps);
  const trackedIDs = [
    ...listAbyssalRoomBootstrapEntityIDs(ports, pocketState, resolvedRoomIndex),
    ...listAbyssalRoomEntityRecords(pocketState, resolvedRoomIndex, deps)
      .filter((record) => record && record.runtimeMaterialized === true)
      .map((record) => toInt(record.runtimeItemID, 0)),
  ];
  // What the session's client has: its Grid bubble.
  const visibleIDs = session && scene && typeof scene.getVisibleEntitiesForSession === "function"
    ? scene.getVisibleEntitiesForSession(session).map((entity) => toInt(entity && entity.itemID, 0))
    : [];
  for (const entityID of visibleIDs) {
    const entity =
      scene && typeof scene.getEntityByID === "function"
        ? scene.getEntityByID(entityID)
        : null;
    const exactScope = resolveExactAbyssalRunRoomScope(entity);
    if (
      entity &&
      exactScope &&
      exactScope.runID === runID &&
      exactScope.roomIndex === resolvedRoomIndex
    ) {
      trackedIDs.push(toInt(entity.itemID, 0));
    }
  }
  return listUniquePositiveInts(trackedIDs);
}

function removeRetiredAbyssalRoomRuntimeResidue(ports,
  pocketState,
  roomIndex,
  deps = ports.getDependencies(),
) {
  const {
    buildPlaceholderRoomState,
    clampRoomIndex,
    listUniquePositiveInts,
    getPocketScene,
    listAbyssalRoomEntityRecords,
    normalizeAbyssalParticipantRoster,
    buildAbyssalSceneDescriptor,
    isRetainedAbyssalPlayerCompanion,
    destroyPlaceholderTrace,
  } = ports;
  const roomState = buildPlaceholderRoomState(pocketState);
  const resolvedRoomIndex = clampRoomIndex(
    toInt(roomIndex, roomState.currentRoomIndex),
    roomState.implementedRooms,
  );
  const runID = toInt(pocketState && pocketState.instanceID, 0);
  const participantShipIDs = new Set(
    normalizeAbyssalParticipantRoster(pocketState)
      .map((participant) => participant.shipID)
      .filter((participantShipID) => participantShipID > 0),
  );
  const scene = getPocketScene(pocketState, deps);
  const runtime = deps;
  const sceneDescriptor = buildAbyssalSceneDescriptor(pocketState, deps);
  const isRetainedCompanionEntityID = (entityID) => {
    const runtimeEntity =
      scene && typeof scene.getEntityByID === "function"
        ? scene.getEntityByID(entityID)
        : null;
    const inventoryItem =
      deps && typeof deps.findItemById === "function"
        ? deps.findItemById(entityID)
        : null;
    return isRetainedAbyssalPlayerCompanion(
      [inventoryItem, runtimeEntity].filter(Boolean),
    );
  };
  const residueIDs = listAbyssalRoomEntityRecords(
    pocketState,
    resolvedRoomIndex,
    deps,
  )
    .filter((record) =>
      record &&
      record.runtimeMaterialized === true &&
      !participantShipIDs.has(toInt(record.runtimeItemID, 0)) &&
      !isRetainedCompanionEntityID(toInt(record.runtimeItemID, 0))
    )
    .map((record) => toInt(record.runtimeItemID, 0));
  const removedIDs = [];
  const failedIDs = [];
  for (const entityID of listUniquePositiveInts(residueIDs)) {
    const entity =
      scene && typeof scene.getEntityByID === "function"
        ? scene.getEntityByID(entityID)
        : null;
    if (!entity) {
      continue;
    }
    let result = null;
    if (scene && scene.dynamicEntities instanceof Map && scene.dynamicEntities.has(entityID)) {
      if (typeof deps.findItemById === "function" && deps.findItemById(entityID)) {
        result = destroyPlaceholderTrace(
          toInt(pocketState && pocketState.solarSystemID, 0),
          entityID,
          deps,
          "room-transfer-residual-cleanup",
          "retired room entity",
          {
            broadcast: false,
            sceneDescriptor: sceneDescriptor || undefined,
          },
        );
      } else if (runtime && typeof runtime.removeDynamicEntity === "function") {
        result = runtime.removeDynamicEntity(
          toInt(pocketState && pocketState.solarSystemID, 0),
          entityID,
          {
            sceneDescriptor,
            broadcast: false,
            reason: "room-transfer-residual-cleanup",
          },
        );
      } else if (scene && typeof scene.removeDynamicEntity === "function") {
        result = scene.removeDynamicEntity(entityID, {
          broadcast: false,
          reason: "room-transfer-residual-cleanup",
        });
      }
    } else if (
      scene &&
      scene.staticEntitiesByID instanceof Map &&
      scene.staticEntitiesByID.has(entityID) &&
      typeof scene.removeStaticEntity === "function"
    ) {
      result = scene.removeStaticEntity(entityID, { broadcast: false });
    }
    if (
      result &&
      (
        result.success === true ||
        result.removed === true ||
        result.alreadyGone === true
      )
    ) {
      removedIDs.push(entityID);
    } else {
      failedIDs.push(entityID);
    }
  }
  const remainingIDs = listAbyssalRoomEntityRecords(
    pocketState,
    resolvedRoomIndex,
    deps,
  )
    .filter((record) =>
      record &&
      record.runtimeMaterialized === true &&
      !participantShipIDs.has(toInt(record.runtimeItemID, 0)) &&
      !isRetainedCompanionEntityID(toInt(record.runtimeItemID, 0))
    )
    .map((record) => toInt(record.runtimeItemID, 0));
  return {
    attemptedIDs: listUniquePositiveInts(residueIDs),
    removedIDs: listUniquePositiveInts(removedIDs),
    failedIDs: listUniquePositiveInts(failedIDs),
    remainingIDs: listUniquePositiveInts(remainingIDs),
    runID,
    roomIndex: resolvedRoomIndex,
  };
}

function updateAbyssalInventoryRoomDeliveryCustomInfo(ports,
  customInfo,
  instanceID,
  roomIndex,
  deliveryState,
  transitionToken,
  selectedRoomLayoutID,
  changedAtMs,
) {
  const {
    parseCustomInfo,
    ABYSSAL_INVENTORY_ROOM_STATE_KEYS,
  } = ports;
  const parsed = parseCustomInfo(customInfo);
  let matchedStateCount = 0;
  const nextCustomInfo = { ...parsed };
  for (const key of ABYSSAL_INVENTORY_ROOM_STATE_KEYS) {
    const state = parsed && parsed[key];
    if (!state || typeof state !== "object") continue;
    if (toInt(state.instanceID, 0) !== instanceID || toInt(state.roomIndex, 0) !== roomIndex) {
      continue;
    }
    nextCustomInfo[key] = {
      ...state,
      deliveryState,
      transitionToken,
      deliveryTransitionToken: transitionToken,
      selectedRoomLayoutID,
      deliveryStateChangedAtMs: changedAtMs,
    };
    matchedStateCount += 1;
  }
  return {
    matchedStateCount,
    customInfo: matchedStateCount > 0 ? JSON.stringify(nextCustomInfo) : customInfo,
  };
}

function persistAbyssalInventoryRoomDeliveryState(ports,
  itemID,
  instanceID,
  roomIndex,
  deliveryState,
  transitionToken,
  selectedRoomLayoutID,
  changedAtMs,
  deps = ports.getDependencies(),
) {
  const numericItemID = toInt(itemID, 0);
  if (numericItemID <= 0 || !deps || typeof deps.findItemById !== "function") {
    return { attempted: false, persisted: false, matchedStateCount: 0, reason: "ITEM_LOOKUP_UNAVAILABLE" };
  }
  const item = deps.findItemById(numericItemID);
  if (!item) {
    return { attempted: false, persisted: false, matchedStateCount: 0, reason: "ITEM_NOT_FOUND" };
  }
  const preview = updateAbyssalInventoryRoomDeliveryCustomInfo(ports,
    item.customInfo,
    instanceID,
    roomIndex,
    deliveryState,
    transitionToken,
    selectedRoomLayoutID,
    changedAtMs,
  );
  if (preview.matchedStateCount <= 0) {
    return { attempted: false, persisted: false, matchedStateCount: 0, reason: "NOT_ABYSSAL_INVENTORY_ARTIFACT" };
  }
  if (typeof deps.updateInventoryItem === "function") {
    let matchedStateCount = preview.matchedStateCount;
    const updateResult = deps.updateInventoryItem(numericItemID, (currentItem) => {
      const next = updateAbyssalInventoryRoomDeliveryCustomInfo(ports,
        currentItem && currentItem.customInfo,
        instanceID,
        roomIndex,
        deliveryState,
        transitionToken,
        selectedRoomLayoutID,
        changedAtMs,
      );
      matchedStateCount = next.matchedStateCount;
      return {
        ...currentItem,
        customInfo: next.customInfo,
      };
    });
    return {
      attempted: true,
      persisted: Boolean(updateResult && updateResult.success),
      matchedStateCount,
      reason: updateResult && updateResult.success
        ? "OK"
        : normalizeText(updateResult && updateResult.errorMsg, "UPDATE_FAILED"),
    };
  }
  item.customInfo = preview.customInfo;
  return {
    attempted: true,
    persisted: true,
    matchedStateCount: preview.matchedStateCount,
    reason: "IN_MEMORY_FALLBACK",
  };
}

function setAbyssalRoomEntityDeliveryState(ports,
  pocketState,
  roomIndex,
  deliveryState,
  session,
  deps = ports.getDependencies(),
  options = {},
) {
  const {
    buildPlaceholderRoomState,
    clampRoomIndex,
    getPlaceholderRoomEntry,
    getPocketScene,
    resolveSelectedAbyssalBaseRoomLayoutID,
    isEarlyVisibilityState,
    setPlaceholderRoomEntry,
    updatePocketState,
    log,
  } = ports;
  const instanceID = toInt(pocketState && pocketState.instanceID, 0);
  const roomState = buildPlaceholderRoomState(pocketState);
  const resolvedRoomIndex = clampRoomIndex(
    toInt(roomIndex, roomState.currentRoomIndex),
    roomState.implementedRooms,
  );
  const normalizedState = normalizeText(deliveryState, "").toLowerCase();
  const transitionToken = toInt(options.transitionToken, 0);
  const selectedLayoutID = normalizeText(
    resolveSelectedAbyssalBaseRoomLayoutID(
      pocketState || {},
      resolvedRoomIndex,
    ),
    normalizeText(
      pocketState && pocketState.selectedRoomLayoutIDs &&
        (pocketState.selectedRoomLayoutIDs[String(resolvedRoomIndex)] ||
          pocketState.selectedRoomLayoutIDs[resolvedRoomIndex]),
      "",
    ),
  );
  const scene = getPocketScene(pocketState, deps);
  const entityIDs = listAbyssalRoomBootstrapEntityIDs(ports, pocketState, resolvedRoomIndex);
  const deliveryStateChangedAtMs = toInt(deps.now(), 0);
  const entities = [];
  let inventoryDeliveryStatePersistedCount = 0;
  const inventoryDeliveryStatePersistFailedItemIDs = [];
  for (const entityID of entityIDs) {
    const entity = scene && typeof scene.getEntityByID === "function"
      ? scene.getEntityByID(entityID)
      : null;
    if (!entity) continue;
    entity.abyssalRoomDeliveryState = normalizedState;
    entity.abyssalTransitionToken = transitionToken;
    entity.abyssalSelectedRoomLayoutID = selectedLayoutID;
    entity.evejsAbyssalRoomDeliveryState = normalizedState;
    entity.evejsAbyssalTransitionToken = transitionToken;
    entities.push(entity);
  }
  for (const entityID of entityIDs) {
    const persistResult = persistAbyssalInventoryRoomDeliveryState(ports,
      entityID,
      instanceID,
      resolvedRoomIndex,
      normalizedState,
      transitionToken,
      selectedLayoutID,
      deliveryStateChangedAtMs,
      deps,
    );
    if (persistResult.persisted) {
      inventoryDeliveryStatePersistedCount += 1;
    } else if (persistResult.attempted) {
      inventoryDeliveryStatePersistFailedItemIDs.push(entityID);
    }
  }

  // Released content joins the park, hidden content leaves it.
  if (scene && typeof scene.syncAbyssalRoomEntityGridBubbles === "function") {
    scene.syncAbyssalRoomEntityGridBubbles(entities);
  }
  const earlyVisibilityState = isEarlyVisibilityState(normalizedState);
  const acquiredEntityIDs = entityIDs.filter((entityID) => {
    const entity = scene && typeof scene.getEntityByID === "function"
      ? scene.getEntityByID(entityID)
      : null;
    return Boolean(
      entity &&
      session &&
      scene.canSessionSeeDynamicEntity(session, entity),
    );
  });
  const earlyVisibleEntityIDs = earlyVisibilityState ? acquiredEntityIDs : [];
  const previousRoomEntry = getPlaceholderRoomEntry(pocketState, resolvedRoomIndex);
  const previousViolationCount = Math.max(0, toInt(previousRoomEntry.earlyVisibilityViolationCount, 0));
  const violationCount = previousViolationCount + earlyVisibleEntityIDs.length;
  const nextRoomState = setPlaceholderRoomEntry(
    pocketState,
    resolvedRoomIndex,
    {
      ...previousRoomEntry,
      deliveryState: normalizedState,
      deliveryTransitionToken: transitionToken,
      deliveryStateChangedAtMs,
      selectedRoomLayoutID: selectedLayoutID,
      earlyVisibilityViolationCount: violationCount,
    },
  );
  const updatedPocketState = updatePocketState(instanceID, {
    roomState: nextRoomState,
  }) || pocketState;
  if (earlyVisibleEntityIDs.length > 0) {
    log.warn(
      `ABYSSAL_DESTINATION_ROOM_EARLY_VISIBILITY run=${instanceID} ` +
        `room=${resolvedRoomIndex} deliveryState=${normalizedState} ` +
        `count=${earlyVisibleEntityIDs.length} ` +
        `preview=${earlyVisibleEntityIDs.slice(0, 8).join(",") || "none"}`,
    );
  }
  return {
    pocketState: updatedPocketState,
    roomIndex: resolvedRoomIndex,
    deliveryState: normalizedState,
    entityIDs,
    entities,
    count: entities.length,
    visibleCount: acquiredEntityIDs.length,
    earlyVisibleEntityIDs,
    earlyVisibilityViolationCount: violationCount,
    inventoryDeliveryStatePersistedCount,
    inventoryDeliveryStatePersistFailedItemIDs,
  };
}

function isSessionReadyForIncrementalSpaceDelivery(ports, session) {
  return Boolean(
    session &&
      session._space &&
      session._space.beyonceBound === true &&
      session._space.initialStateSent === true,
  );
}

function markAbyssalRoomContentDelivered(ports,
  pocketState,
  deliveredEntityIDs,
  deps = ports.getDependencies(),
  options = {},
) {
  const {
    buildPlaceholderRoomState,
    clampRoomIndex,
    getPlaceholderRoomEntry,
    listUniquePositiveInts,
    setPlaceholderRoomEntry,
    updatePocketState,
    buildPocketStateForCurrentRoom,
    logAbyssalRoomContentDelivered,
  } = ports;
  const roomState = buildPlaceholderRoomState(pocketState);
  const roomIndex = clampRoomIndex(
    toInt(options.roomIndex, roomState.currentRoomIndex),
    roomState.implementedRooms,
  );
  const roomEntry = getPlaceholderRoomEntry(pocketState, roomIndex);
  const payloadEntityIDs = listUniquePositiveInts(deliveredEntityIDs);
  const deliveredRoomState = setPlaceholderRoomEntry(
    pocketState,
    roomIndex,
    {
      ...roomEntry,
      deliveredEntityIDs: payloadEntityIDs,
      deliveredAtMs: toInt(deps.now(), 0),
    },
  );
  const deliveredPocketState = updatePocketState(
    toInt(pocketState && pocketState.instanceID, 0),
    buildPocketStateForCurrentRoom(pocketState, deliveredRoomState),
  ) || pocketState;
  logAbyssalRoomContentDelivered(deliveredPocketState, {
    roomIndex,
    deliveredEntityIDs: payloadEntityIDs,
    recipientCount: toInt(options.recipientCount, 0),
  });
  return deliveredPocketState;
}

function broadcastAbyssalRoomBootstrapAddBalls(ports, pocketState, session, deps = ports.getDependencies(), reason = "room-bootstrap") {
  const {
    buildPlaceholderRoomState,
    getPocketScene,
    buildAbyssalSceneDescriptor,
    log,
    listPocketHostileEntityIDs,
    summarizeAbyssalRoomEntities,
    formatAbyssalRoomEntityCountsForLog,
  } = ports;
  const scene = getPocketScene(pocketState, deps);
  if (!scene || typeof scene.getEntityByID !== "function" || typeof scene.broadcastAddBalls !== "function") {
    return {
      success: false,
      errorMsg: "SCENE_BROADCAST_UNSUPPORTED",
      entityCount: 0,
      recipientCount: 0,
      requestedEntityIDs: [],
      payloadEntityIDs: [],
    };
  }
  const entityIDs = listCurrentRoomBootstrapEntityIDs(ports, pocketState);
  const entities = entityIDs
    .map((entityID) => scene.getEntityByID(entityID))
    .filter(Boolean);
  const hostileEntityIDs = listPocketHostileEntityIDs(pocketState);
  const missingHostileEntityIDs = hostileEntityIDs.filter((entityID) => !(
    scene.getEntityByID(entityID)
  ));
  const readyForIncrementalDelivery = isSessionReadyForIncrementalSpaceDelivery(ports, session);
  const deliveries = readyForIncrementalDelivery && entities.length > 0
    ? scene.broadcastAddBalls(entities, null, {
      freshAcquire: true,
    })
    : [];
  const recipientCount = Array.isArray(deliveries)
    ? deliveries.length
    : (deliveries ? 1 : 0);
  const runtime = deps;
  const bootstrapSummary =
    runtime && typeof runtime.summarizeAbyssalBootstrapInventory === "function"
      ? runtime.summarizeAbyssalBootstrapInventory(
          entities,
          toInt(session && session.shipID, toInt(pocketState && pocketState.shipID, 0)),
        )
      : (() => {
          const roleSummary = summarizeAbyssalRoomEntities(entities);
          return {
            shipCount: 0,
            ...roleSummary,
            gateCount: roleSummary.conduitCount,
            rewardCount:
              roleSummary.rewardCacheCount +
              roleSummary.rewardWreckCount +
              roleSummary.extractionNodeCount,
            otherDynamicCount: roleSummary.unknownCount,
          };
        })();
  const slimCount = entities.filter((entity) => entity && toInt(entity.itemID, 0) > 0).length;
  const descriptor = buildAbyssalSceneDescriptor(pocketState, deps);
  const deliveryMode = recipientCount > 0
    ? "addballs"
    : (
      readyForIncrementalDelivery
        ? "skipped_zero_recipients"
        : "deferred_until_setstate"
    );
  const payloadEntityIDs = entities
    .map((entity) => toInt(entity && entity.itemID, 0))
    .filter(Boolean);
  log.info(
    `[AbyssalScene] bootstrap inventory sceneKey=${normalizeText(descriptor && descriptor.sceneKey, "n/a")} ` +
      `ego=${toInt(session && session.shipID, toInt(pocketState && pocketState.shipID, 0))} ` +
      `dynamicCount=${entities.length} shipCount=${bootstrapSummary.shipCount} ` +
      `npcCount=${bootstrapSummary.npcCount} gateCount=${bootstrapSummary.gateCount} ` +
      `rewardCount=${bootstrapSummary.rewardCount} ` +
      `${formatAbyssalRoomEntityCountsForLog(bootstrapSummary)} ` +
      `otherDynamicCount=${bootstrapSummary.otherDynamicCount} slimCount=${slimCount} ` +
      `recipientCount=${recipientCount} delivery=${deliveryMode} reason=${normalizeText(reason, "room-bootstrap")}`,
  );
  if (missingHostileEntityIDs.length > 0) {
    log.warn(
      `[AbyssalScene] bootstrap missing hostile entities ` +
        `instance=${toInt(pocketState && pocketState.instanceID, 0)} ` +
        `missing=${missingHostileEntityIDs.join(",")}`,
    );
    return {
      success: false,
      errorMsg: "ABYSSAL_BOOTSTRAP_HOSTILE_MISSING",
      entityCount: entities.length,
      recipientCount,
      requestedEntityIDs: entityIDs,
      payloadEntityIDs,
      missingHostileEntityIDs,
    };
  }
  const deliveredPocketState = markAbyssalRoomContentDelivered(ports,
    pocketState,
    payloadEntityIDs,
    deps,
    {
      roomIndex: buildPlaceholderRoomState(pocketState).currentRoomIndex,
      recipientCount,
    },
  );
  return {
    success: true,
    entityCount: entities.length,
    recipientCount,
    requestedEntityIDs: entityIDs,
    payloadEntityIDs,
    deliveryMode,
    deliveries: Array.isArray(deliveries) ? deliveries : [],
    deferred: deliveryMode === "deferred_until_setstate",
    missingHostileEntityIDs: [],
    pocketState: deliveredPocketState,
  };
}

function createAbyssalRoomDelivery(ports) {
  return {
    listAbyssalRoomBootstrapEntityIDs: listAbyssalRoomBootstrapEntityIDs.bind(null, ports),
    listCurrentRoomBootstrapEntityIDs: listCurrentRoomBootstrapEntityIDs.bind(null, ports),
    listAbyssalRoomRetirementEntityIDs: listAbyssalRoomRetirementEntityIDs.bind(null, ports),
    removeRetiredAbyssalRoomRuntimeResidue: removeRetiredAbyssalRoomRuntimeResidue.bind(null, ports),
    updateAbyssalInventoryRoomDeliveryCustomInfo: updateAbyssalInventoryRoomDeliveryCustomInfo.bind(null, ports),
    persistAbyssalInventoryRoomDeliveryState: persistAbyssalInventoryRoomDeliveryState.bind(null, ports),
    setAbyssalRoomEntityDeliveryState: setAbyssalRoomEntityDeliveryState.bind(null, ports),
    isSessionReadyForIncrementalSpaceDelivery: isSessionReadyForIncrementalSpaceDelivery.bind(null, ports),
    markAbyssalRoomContentDelivered: markAbyssalRoomContentDelivered.bind(null, ports),
    broadcastAbyssalRoomBootstrapAddBalls: broadcastAbyssalRoomBootstrapAddBalls.bind(null, ports),
  };
}

module.exports = { createAbyssalRoomDelivery };
