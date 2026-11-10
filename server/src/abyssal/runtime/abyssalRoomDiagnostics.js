"use strict";

const { toInt, normalizeText, normalizeLowerText, listUniquePositiveInts } = require("../domain/abyssalRuntimeValues");

function buildAbyssalRoomEntityRecord(ports,
  pocketState,
  runtimeItemID,
  fallback = {},
  deps = ports.getDependencies(),
) {
  const {
    getPocketScene,
    readEnvironmentalObjectStateFromItem,
    readPocketMarkerStateFromItem,
    readRewardCacheStateFromItem,
    readExtractionNodeStateFromItem,
    resolveAbyssalRoomEntityRole,
    getSuppressorController,
  } = ports;
  const numericRuntimeItemID = toInt(runtimeItemID, 0);
  const scene = getPocketScene(pocketState, deps);
  const sceneEntity = numericRuntimeItemID > 0 && scene && typeof scene.getEntityByID === "function"
    ? scene.getEntityByID(numericRuntimeItemID)
    : null;
  const item = numericRuntimeItemID > 0 && deps && typeof deps.findItemById === "function"
    ? deps.findItemById(numericRuntimeItemID)
    : null;
  const metadataState =
    readEnvironmentalObjectStateFromItem(item) ||
    readPocketMarkerStateFromItem(item) ||
    readRewardCacheStateFromItem(item) ||
    readExtractionNodeStateFromItem(item) ||
    {};
  const record = {
    ...(item || {}),
    ...(sceneEntity || {}),
    ...metadataState,
    ...fallback,
    runtimeItemID: numericRuntimeItemID,
    itemID: numericRuntimeItemID,
    typeID: toInt(
      fallback.typeID,
      toInt(sceneEntity && sceneEntity.typeID, toInt(item && item.typeID, 0)),
    ),
  };
  record.abyssalEntityRole = normalizeText(
    fallback.abyssalEntityRole,
    normalizeText(
      metadataState.abyssalEntityRole,
      normalizeText(sceneEntity && sceneEntity.abyssalEntityRole, ""),
    ),
  ) || resolveAbyssalRoomEntityRole(record);
  record.abyssalDefinitionID = normalizeText(
    fallback.abyssalDefinitionID,
    normalizeText(
      metadataState.abyssalDefinitionID,
      normalizeText(sceneEntity && sceneEntity.abyssalDefinitionID, ""),
    ),
  );
  record.name = normalizeText(
    fallback.name,
    normalizeText(sceneEntity && sceneEntity.itemName, normalizeText(item && item.itemName, "")),
  );
  record.presentationEnabled = fallback.presentationEnabled === undefined
    ? metadataState.presentationEnabled !== false && (!sceneEntity || sceneEntity.presentationEnabled !== false)
    : fallback.presentationEnabled === true;
  record.mechanicsEnabled = fallback.mechanicsEnabled === undefined
    ? metadataState.mechanicsEnabled === true || Boolean(sceneEntity && sceneEntity.mechanicsEnabled === true)
    : fallback.mechanicsEnabled === true;
  record.rangeMeters = Number.isFinite(Number(fallback.rangeMeters))
    ? Number(fallback.rangeMeters)
    : Number.isFinite(Number(metadataState.radiusMeters))
      ? Number(metadataState.radiusMeters)
      : Number.isFinite(Number(sceneEntity && sceneEntity.evejsAbyssalEnvironmentalRadiusMeters))
        ? Number(sceneEntity && sceneEntity.evejsAbyssalEnvironmentalRadiusMeters)
        : 0;
  const suppressorController = getSuppressorController(
    toInt(record.abyssalRunID, toInt(pocketState && pocketState.instanceID, 0)),
    toInt(record.abyssalRoomIndex, 0),
    numericRuntimeItemID,
  );
  if (suppressorController) {
    record.suppressorController = suppressorController;
  }
  record.runtimeMaterialized = Boolean(sceneEntity);
  return record;
}

function listAbyssalRoomEntityRecords(ports,
  pocketState = null,
  roomIndex = null,
  deps = ports.getDependencies(),
) {
  const {
    buildPlaceholderRoomState,
    clampRoomIndex,
    getPlaceholderRoomEntry,
    getCapturedT0DarkRoom,
    getAbyssalSceneryProfileForRoomIndex,
    listAbyssalSceneryProfileEntries,
    listAuthoredAbyssalEnvironmentalEntries,
    ABYSSAL_ROOM_ENTITY_ROLES,
    getPocketScene,
    normalizeAbyssalParticipantRoster,
    resolveExactAbyssalRunRoomScope,
  } = ports;
  const roomState = buildPlaceholderRoomState(pocketState);
  const resolvedRoomIndex = clampRoomIndex(
    roomIndex == null ? roomState.currentRoomIndex : roomIndex,
    roomState.implementedRooms,
  );
  const roomEntry = getPlaceholderRoomEntry(pocketState, resolvedRoomIndex);
  const capturedRoom = getCapturedT0DarkRoom(pocketState, resolvedRoomIndex);
  const sceneryProfile = getAbyssalSceneryProfileForRoomIndex(pocketState, resolvedRoomIndex);
  const sceneryEntries = listAbyssalSceneryProfileEntries(sceneryProfile);
  const environmentalEntries = listAuthoredAbyssalEnvironmentalEntries(
    pocketState,
    resolvedRoomIndex,
  );
  const records = [];
  const addRecord = (runtimeItemID, fallback = {}) => {
    const numericRuntimeItemID = toInt(runtimeItemID, 0);
    if (numericRuntimeItemID <= 0) return;
    records.push(buildAbyssalRoomEntityRecord(ports,
      pocketState,
      numericRuntimeItemID,
      {
        abyssalRunID: toInt(pocketState && pocketState.instanceID, 0),
        abyssalRoomIndex: resolvedRoomIndex,
        ...fallback,
      },
      deps,
    ));
  };

  addRecord(roomEntry.originMarkerItemID, {
    abyssalEntityRole: ABYSSAL_ROOM_ENTITY_ROLES.ORIGIN_MARKER,
    abyssalDefinitionID: "abyssal:room-origin-marker",
    presentationEnabled: true,
    mechanicsEnabled: false,
  });
  addRecord(roomEntry.conduitItemID, {
    abyssalEntityRole: ABYSSAL_ROOM_ENTITY_ROLES.CONDUIT,
    abyssalDefinitionID: normalizeText(
      capturedRoom && capturedRoom.conduit && capturedRoom.conduit.dunObjectID,
      `abyssal:room-${resolvedRoomIndex}:conduit`,
    ),
    presentationEnabled: true,
    mechanicsEnabled: true,
  });
  for (const hostileEntityID of listUniquePositiveInts(roomEntry.hostileEntityIDs)) {
    addRecord(hostileEntityID, {
      abyssalEntityRole: ABYSSAL_ROOM_ENTITY_ROLES.NPC,
      abyssalDefinitionID: normalizeText(roomEntry.encounterProfileID, ""),
      presentationEnabled: true,
      mechanicsEnabled: true,
    });
  }

  appendSceneryEnvironmentRecords(ports, roomEntry, sceneryProfile, sceneryEntries, environmentalEntries, addRecord);

  for (const cacheStructureID of listUniquePositiveInts([
    roomEntry.cacheItemID,
    roomEntry.cacheStructureItemID,
  ]).filter((itemID) => itemID !== toInt(roomEntry.cacheLootContainerItemID, 0))) {
    addRecord(cacheStructureID, {
      abyssalEntityRole: ABYSSAL_ROOM_ENTITY_ROLES.REWARD_CACHE,
      presentationEnabled: true,
      mechanicsEnabled: true,
    });
  }
  addRecord(roomEntry.cacheLootContainerItemID, {
    abyssalEntityRole: ABYSSAL_ROOM_ENTITY_ROLES.REWARD_WRECK,
    presentationEnabled: true,
    mechanicsEnabled: true,
  });
  for (const extractionNodeItemID of listUniquePositiveInts(roomEntry.extractionNodeItemIDs)) {
    addRecord(extractionNodeItemID, {
      abyssalEntityRole: ABYSSAL_ROOM_ENTITY_ROLES.EXTRACTION_NODE,
      abyssalDefinitionID: normalizeText(roomEntry.extractionNodeProfileID, ""),
      presentationEnabled: true,
      mechanicsEnabled: true,
    });
  }
  for (const extractionNodeLootContainerItemID of listUniquePositiveInts(
    roomEntry.extractionNodeLootContainerItemIDs,
  )) {
    addRecord(extractionNodeLootContainerItemID, {
      abyssalEntityRole: ABYSSAL_ROOM_ENTITY_ROLES.REWARD_WRECK,
      abyssalDefinitionID: normalizeText(roomEntry.extractionNodeProfileID, ""),
      presentationEnabled: true,
      mechanicsEnabled: true,
    });
  }
  addRecord(roomEntry.sceneryProbeEntityID, {
    typeID: toInt(roomEntry.sceneryProbeTypeID, 0),
    name: normalizeText(roomEntry.sceneryProbeTypeName, ""),
    abyssalEntityRole: ABYSSAL_ROOM_ENTITY_ROLES.PROBE,
    abyssalDefinitionID: normalizeText(roomEntry.sceneryProbeProfileID, ""),
    presentationEnabled: true,
    mechanicsEnabled: false,
  });

  const scene = getPocketScene(pocketState, deps);
  const sceneEntities = [
    ...(scene && scene.dynamicEntities instanceof Map
      ? scene.dynamicEntities.values()
      : []),
    ...(scene && Array.isArray(scene.staticEntities) ? scene.staticEntities : []),
  ];
  const trackedRuntimeIDs = new Set(records.map((record) => toInt(record.runtimeItemID, 0)));
  const participantShipIDs = new Set(
    normalizeAbyssalParticipantRoster(pocketState)
      .map((participant) => toInt(participant.shipID, 0))
      .filter((shipID) => shipID > 0),
  );
  for (const entity of sceneEntities) {
    const runtimeItemID = toInt(entity && entity.itemID, 0);
    const exactScope = resolveExactAbyssalRunRoomScope(entity);
    if (
      runtimeItemID <= 0 ||
      trackedRuntimeIDs.has(runtimeItemID) ||
      participantShipIDs.has(runtimeItemID) ||
      !exactScope ||
      exactScope.runID !== toInt(pocketState && pocketState.instanceID, 0) ||
      exactScope.roomIndex !== resolvedRoomIndex
    ) {
      continue;
    }
    records.push(buildAbyssalRoomEntityRecord(ports, pocketState, runtimeItemID, {}, deps));
    trackedRuntimeIDs.add(runtimeItemID);
  }
  return records;
}

function countAbyssalRoomContent(ports,
  pocketState = null,
  roomIndex = null,
  deps = ports.getDependencies(),
  options = {},
) {
  const {
    buildPlaceholderRoomState,
    clampRoomIndex,
    getPlaceholderRoomEntry,
    summarizeAbyssalRoomEntities,
  } = ports;
  const roomState = buildPlaceholderRoomState(pocketState);
  const resolvedRoomIndex = clampRoomIndex(
    roomIndex == null ? roomState.currentRoomIndex : roomIndex,
    roomState.implementedRooms,
  );
  const roomEntry = getPlaceholderRoomEntry(pocketState, resolvedRoomIndex);
  let records = listAbyssalRoomEntityRecords(ports, pocketState, resolvedRoomIndex, deps);
  const deliveredEntityIDs = listUniquePositiveInts(
    options.deliveredEntityIDs === undefined
      ? roomEntry.deliveredEntityIDs
      : options.deliveredEntityIDs,
  );
  if (options.deliveredOnly === true) {
    const deliveredEntityIDSet = new Set(deliveredEntityIDs);
    records = records.filter((record) => deliveredEntityIDSet.has(toInt(record.runtimeItemID, 0)));
  }
  if (options.existingOnly === true) {
    records = records.filter((record) => record.runtimeMaterialized === true);
  }
  const counts = summarizeAbyssalRoomEntities(records);
  if (!counts.primaryRoleIntegrity) {
    throw new Error(
      `ABYSSAL_ROOM_ENTITY_ROLE_COUNT_MISMATCH run=${toInt(pocketState && pocketState.instanceID, 0)} ` +
        `room=${resolvedRoomIndex} primary=${counts.primaryRoleCountSum} total=${counts.totalRoomEntityCount}`,
    );
  }
  return counts;
}

function buildAbyssalSceneryAuthorityDiagnostics(ports,
  pocketState = null,
  roomIndex = null,
  deps = ports.getDependencies(),
) {
  const {
    buildPlaceholderRoomState,
    clampRoomIndex,
    getAbyssalSceneryProfileForRoomIndex,
    listAbyssalSceneryProfileEntries,
    resolveAbyssalSceneryPolicy,
    SCENERY_POLICY_AUTHORITATIVE,
    buildAbyssalSceneryVisualItemID,
    getPocketScene,
    isAbyssalSceneryVisualsRequested,
  } = ports;
  const roomState = buildPlaceholderRoomState(pocketState);
  const resolvedRoomIndex = clampRoomIndex(
    roomIndex == null ? roomState.currentRoomIndex : roomIndex,
    roomState.implementedRooms,
  );
  const runID = toInt(pocketState && pocketState.instanceID, 0);
  const profile = getAbyssalSceneryProfileForRoomIndex(pocketState, resolvedRoomIndex);
  const entries = listAbyssalSceneryProfileEntries(profile);
  const sceneryPolicy = resolveAbyssalSceneryPolicy(profile);
  const authoritative = sceneryPolicy === SCENERY_POLICY_AUTHORITATIVE;
  const expectedEntityIDs = entries.map((entry) => buildAbyssalSceneryVisualItemID(
    runID,
    resolvedRoomIndex,
    entry && entry.slot,
    entry && entry.capturedRetailObject === true,
  ));
  const scene = getPocketScene(pocketState, deps);
  const isExpectedMaterializedEntity = (entity) => Boolean(
    entity &&
    toInt(entity.abyssalRunID, toInt(entity.evejsAbyssalInstanceID, 0)) === runID &&
    toInt(entity.abyssalRoomIndex, toInt(entity.evejsAbyssalRoomIndex, 0)) === resolvedRoomIndex &&
    entity.abyssalVisualOnly === true &&
    entity.evejsAbyssalVisualProbe !== true
  );
  const materializedDecorationCount = expectedEntityIDs.filter((entityID) =>
    isExpectedMaterializedEntity(
      scene && typeof scene.getEntityByID === "function" ? scene.getEntityByID(entityID) : null,
    )
  ).length;
  const sceneEntities = [
    ...(scene && Array.isArray(scene.staticEntities) ? scene.staticEntities : []),
    ...(scene && scene.dynamicEntities instanceof Map ? scene.dynamicEntities.values() : []),
  ];
  const expectedSlots = new Set(entries.map((entry) => Math.max(1, toInt(entry && entry.slot, 1))));
  const materializedSlotCounts = new Map();
  for (const entity of sceneEntities) {
    if (
      !isExpectedMaterializedEntity(entity) ||
      normalizeText(entity.evejsAbyssalVisualProfileID, "") !== normalizeText(profile && profile.profileID, "")
    ) {
      continue;
    }
    const slot = Math.max(1, toInt(entity.evejsAbyssalVisualSlot, 1));
    if (!expectedSlots.has(slot)) continue;
    materializedSlotCounts.set(slot, (materializedSlotCounts.get(slot) || 0) + 1);
  }
  const duplicateSceneryCount = [...materializedSlotCounts.values()]
    .reduce((total, count) => total + Math.max(0, count - 1), 0);
  return {
    layoutID: normalizeText(profile && profile.layoutID, ""),
    sceneryPolicy,
    sceneryConfigEnabled: isAbyssalSceneryVisualsRequested(deps),
    authoritativeSceneryCount: authoritative ? entries.length : 0,
    experimentalSceneryCount: authoritative ? 0 : entries.length,
    expectedDecorationCount: entries.length,
    materializedDecorationCount,
    missingAuthoritativeSceneryCount: authoritative
      ? Math.max(0, entries.length - materializedDecorationCount)
      : 0,
    duplicateAuthoritativeSceneryCount: authoritative ? duplicateSceneryCount : 0,
  };
}

function warnIfAuthoritativeSceneryMissing(ports, pocketState, roomIndex, diagnostics) {
  const {
    ABYSSAL_DIAGNOSTIC_DEDUPE_SCOPE,
    log,
  } = ports;
  const missingCount = toInt(diagnostics && diagnostics.missingAuthoritativeSceneryCount, 0);
  const runID = toInt(pocketState && pocketState.instanceID, 0);
  const resolvedRoomIndex = toInt(roomIndex, 0);
  if (runID <= 0 || resolvedRoomIndex <= 0 || missingCount <= 0) return;
  const warningKey = `${runID}:${resolvedRoomIndex}`;
  if (
    ports.hasDiagnosticDedupeKey(
      ABYSSAL_DIAGNOSTIC_DEDUPE_SCOPE.MISSING_AUTHORITATIVE_SCENERY,
      warningKey,
    )
  ) return;
  ports.recordDiagnosticDedupeKey(
    ABYSSAL_DIAGNOSTIC_DEDUPE_SCOPE.MISSING_AUTHORITATIVE_SCENERY,
    warningKey,
  );
  log.warn(
    `ABYSSAL_AUTHORITATIVE_SCENERY_MISSING run=${runID} room=${resolvedRoomIndex} ` +
      `layoutID=${normalizeText(diagnostics && diagnostics.layoutID, "none")} ` +
      `missingCount=${missingCount}`,
  );
}

function buildAbyssalRoomContentDiagnostics(ports,
  pocketState = null,
  roomIndex = null,
  deps = ports.getDependencies(),
) {
  const {
    buildPlaceholderRoomState,
    clampRoomIndex,
    listSuppressorControllersForRun,
    listSuppressorPresentationStatesForRun,
  } = ports;
  const roomState = buildPlaceholderRoomState(pocketState);
  const resolvedRoomIndex = clampRoomIndex(
    roomIndex == null ? roomState.currentRoomIndex : roomIndex,
    roomState.implementedRooms,
  );
  const preparedEntityCounts = countAbyssalRoomContent(ports, pocketState, roomIndex, deps);
  const deliveredEntityCounts = countAbyssalRoomContent(ports, pocketState, roomIndex, deps, {
    deliveredOnly: true,
  });
  const sceneryAuthorityDiagnostics = buildAbyssalSceneryAuthorityDiagnostics(ports,
    pocketState,
    resolvedRoomIndex,
    deps,
  );
  warnIfAuthoritativeSceneryMissing(ports,
    pocketState,
    resolvedRoomIndex,
    sceneryAuthorityDiagnostics,
  );
  return {
    ...preparedEntityCounts,
    ...sceneryAuthorityDiagnostics,
    preparedEntityCounts,
    deliveredEntityCounts,
    suppressorControllers: listSuppressorControllersForRun(
      toInt(pocketState && pocketState.instanceID, 0),
      resolvedRoomIndex,
    ),
    suppressorPresentations: listSuppressorPresentationStatesForRun(
      toInt(pocketState && pocketState.instanceID, 0),
      resolvedRoomIndex,
    ),
  };
}

function buildAbyssalEntityIdentityDiagnostics(ports,
  pocketState = null,
  roomIndex = null,
  deps = ports.getDependencies(),
) {
  const {
    buildPlaceholderRoomState,
    clampRoomIndex,
    resolveSelectedAbyssalBaseRoomLayoutID,
    resolveAbyssalBaseRoomSceneryProfile,
    getContentProfile,
    isCapturedT0DarkContent,
    getCapturedT0DarkRoom,
    getPocketScene,
    ABYSSAL_ROOM_ENTITY_ROLES,
  } = ports;
  const roomState = buildPlaceholderRoomState(pocketState);
  const resolvedRoomIndex = clampRoomIndex(
    roomIndex == null ? roomState.currentRoomIndex : roomIndex,
    roomState.implementedRooms,
  );
  const selectedBaseRoomLayoutID = resolveSelectedAbyssalBaseRoomLayoutID(
    pocketState || {},
    resolvedRoomIndex,
  );
  const baseRoomSceneryProfile = resolveAbyssalBaseRoomSceneryProfile(
    selectedBaseRoomLayoutID,
    getContentProfile(pocketState) && getContentProfile(pocketState).weatherType,
  );
  const capturedRoom = !baseRoomSceneryProfile && isCapturedT0DarkContent(pocketState)
    ? getCapturedT0DarkRoom(pocketState, resolvedRoomIndex)
    : null;
  if (!baseRoomSceneryProfile && !capturedRoom) return null;
  const identityPolicy = baseRoomSceneryProfile
    ? "captured-retail-layout-base"
    : "captured-retail";
  const runID = toInt(pocketState && pocketState.instanceID, 0);
  const characterID = toInt(pocketState && pocketState.characterID, 0);
  const scene = getPocketScene(pocketState, deps);
  const entities = [
    ...(scene && Array.isArray(scene.staticEntities) ? scene.staticEntities : []),
    ...(scene && scene.dynamicEntities instanceof Map ? scene.dynamicEntities.values() : []),
  ].filter((entity) =>
    entity &&
    toInt(entity.abyssalRunID, toInt(entity.evejsAbyssalInstanceID, 0)) === runID &&
    toInt(entity.abyssalRoomIndex, toInt(entity.evejsAbyssalRoomIndex, 0)) === resolvedRoomIndex
  );
  const expectedCapturedIdentityCount = baseRoomSceneryProfile
    ? baseRoomSceneryProfile.entries.length
    : capturedRoom.objects.length;
  const capturedEntities = entities.filter((entity) =>
    normalizeText(entity.evejsAbyssalIdentityPolicy, "") === identityPolicy
  );
  const resolvedCapturedIdentityCount = capturedEntities.filter((entity) =>
    toInt(entity.ownerID, 0) > 0
  ).length;
  const placeholderNameCount = capturedEntities.filter((entity) =>
    [entity.slimName, entity.itemName]
      .some((value) => normalizeText(value, "").toLowerCase().includes("placeholder"))
  ).length;
  const playerOwnedFunctionalEntityCount = capturedEntities.filter((entity) => {
    if (toInt(entity.ownerID, 0) !== characterID) return false;
    return normalizeText(entity.abyssalEntityRole, "") !== ABYSSAL_ROOM_ENTITY_ROLES.DECORATION;
  }).length;
  const fallbackIdentityCount = Math.max(
    0,
    expectedCapturedIdentityCount - resolvedCapturedIdentityCount,
  );
  const failed = placeholderNameCount > 0 || playerOwnedFunctionalEntityCount > 0;
  return {
    runID,
    roomIndex: resolvedRoomIndex,
    layoutID: normalizeText(
      baseRoomSceneryProfile && baseRoomSceneryProfile.layoutID,
      normalizeText(capturedRoom && capturedRoom.layoutID, "none"),
    ),
    identityPolicy,
    expectedCapturedIdentityCount,
    resolvedCapturedIdentityCount,
    fallbackIdentityCount,
    placeholderNameCount,
    playerOwnedFunctionalEntityCount,
    status: failed ? "failed" : fallbackIdentityCount > 0 ? "fallback" : "resolved",
    reason: placeholderNameCount > 0
      ? "PLACEHOLDER_NAME_PRESENT"
      : playerOwnedFunctionalEntityCount > 0
        ? "PLAYER_OWNED_FUNCTIONAL_ENTITY"
        : fallbackIdentityCount > 0
          ? "IDENTITY_NOT_MATERIALIZED"
          : "OK",
  };
}

function logAbyssalEntityIdentityDiagnostics(ports, pocketState, roomIndex, deps = ports.getDependencies()) {
  const {
    log,
  } = ports;
  const diagnostics = buildAbyssalEntityIdentityDiagnostics(ports, pocketState, roomIndex, deps);
  if (!diagnostics) return null;
  const message =
    `[AbyssalEntityIdentity] run=${diagnostics.runID} room=${diagnostics.roomIndex} ` +
    `layoutID=${diagnostics.layoutID} identityPolicy=${diagnostics.identityPolicy} ` +
    `status=${diagnostics.status} reason=${diagnostics.reason} ` +
    `expectedCapturedIdentityCount=${diagnostics.expectedCapturedIdentityCount} ` +
    `resolvedCapturedIdentityCount=${diagnostics.resolvedCapturedIdentityCount} ` +
    `fallbackIdentityCount=${diagnostics.fallbackIdentityCount} ` +
    `placeholderNameCount=${diagnostics.placeholderNameCount} ` +
    `playerOwnedFunctionalEntityCount=${diagnostics.playerOwnedFunctionalEntityCount}`;
  if (diagnostics.status === "failed") log.warn(message);
  else log.info(message);
  return diagnostics;
}

function logAbyssalRoomContentLifecycle(ports, pocketState = null, options = {}) {
  const {
    buildPlaceholderRoomState,
    clampRoomIndex,
    ABYSSAL_DIAGNOSTIC_DEDUPE_SCOPE,
    getContentProfile,
    log,
    formatAbyssalRoomEntityCountsForLog,
  } = ports;
  const roomState = buildPlaceholderRoomState(pocketState);
  const roomIndex = clampRoomIndex(
    toInt(options && options.roomIndex, roomState.currentRoomIndex),
    roomState.implementedRooms,
  );
  const phase = normalizeLowerText(options.phase, "prepared");
  const instanceID = toInt(pocketState && pocketState.instanceID, 0);
  const lifecycleKey = `${instanceID}:${roomIndex}:${phase}`;
  if (
    options.force !== true &&
    ports.hasDiagnosticDedupeKey(
      ABYSSAL_DIAGNOSTIC_DEDUPE_SCOPE.ROOM_CONTENT_LIFECYCLE,
      lifecycleKey,
    )
  ) {
    return null;
  }
  const counts = countAbyssalRoomContent(ports, pocketState, roomIndex, ports.getDependencies(), {
    deliveredOnly: phase === "delivered" || phase === "activated",
    deliveredEntityIDs: options.deliveredEntityIDs,
    existingOnly: options.existingOnly === true,
  });
  const sceneryDiagnostics = buildAbyssalSceneryAuthorityDiagnostics(ports,
    pocketState,
    roomIndex,
    ports.getDependencies(),
  );
  if (phase === "prepared" || phase === "delivered" || phase === "activated") {
    warnIfAuthoritativeSceneryMissing(ports, pocketState, roomIndex, sceneryDiagnostics);
  }
  ports.recordDiagnosticDedupeKey(
    ABYSSAL_DIAGNOSTIC_DEDUPE_SCOPE.ROOM_CONTENT_LIFECYCLE,
    lifecycleKey,
  );
  const contentProfile = getContentProfile(pocketState) || {};
  const remainingSuffix = phase === "cleaned"
    ? ` remainingRoomEntityCount=${counts.totalRoomEntityCount}` +
      ` remainingDecorationCount=${counts.decorationCount}` +
      ` remainingFunctionalEnvironmentCount=${counts.functionalEnvironmentCount}` +
      ` remainingPerimeterCount=${counts.perimeterCount}` +
      ` remainingWeatherCount=${counts.weatherCount}` +
      ` remainingVolumetricCloudCount=${counts.volumetricCloudCount}` +
      ` remainingUnknownCount=${counts.unknownCount}`
    : "";
  const scenerySuffix = phase === "cleaned"
    ? ""
    : ` layoutID=${normalizeText(sceneryDiagnostics.layoutID, "none")}` +
      ` sceneryPolicy=${sceneryDiagnostics.sceneryPolicy}` +
      ` sceneryConfigEnabled=${sceneryDiagnostics.sceneryConfigEnabled}` +
      ` authoritativeSceneryCount=${sceneryDiagnostics.authoritativeSceneryCount}` +
      ` experimentalSceneryCount=${sceneryDiagnostics.experimentalSceneryCount}` +
      ` expectedDecorationCount=${sceneryDiagnostics.expectedDecorationCount}` +
      ` materializedDecorationCount=${sceneryDiagnostics.materializedDecorationCount}` +
      ` missingAuthoritativeSceneryCount=${sceneryDiagnostics.missingAuthoritativeSceneryCount}` +
      ` duplicateAuthoritativeSceneryCount=${sceneryDiagnostics.duplicateAuthoritativeSceneryCount}`;
  log.info(
    `[AbyssalRoomContent] run=${instanceID} ` +
      `tier=${toInt(contentProfile.tier, 0)} room=${roomIndex} phase=${phase} ` +
      `${formatAbyssalRoomEntityCountsForLog(counts)}${scenerySuffix}${remainingSuffix}`,
  );
  if (phase === "prepared" || phase === "delivered" || phase === "activated") {
    logAbyssalEntityIdentityDiagnostics(ports, pocketState, roomIndex, ports.getDependencies());
  }
  if (phase === "prepared" && counts.unknownCount > 0) {
    log.warn(
      `[AbyssalRoomContent] unclassified room entities run=${instanceID} room=${roomIndex} ` +
        `unknownCount=${counts.unknownCount} ` +
        `unknownEntityIDs=${counts.unknownEntityIDs.join(",") || "none"} ` +
        `unknownTypeIDs=${counts.unknownTypeIDs.join(",") || "none"}`,
    );
  }
  return counts;
}

function logAbyssalRoomContentPrepared(ports, pocketState = null, options = {}) {
  return logAbyssalRoomContentLifecycle(ports, pocketState, { ...options, phase: "prepared" });
}

function logAbyssalRoomContentDelivered(ports, pocketState = null, options = {}) {
  return logAbyssalRoomContentLifecycle(ports, pocketState, { ...options, phase: "delivered" });
}

function logAbyssalRoomContentActivated(ports, pocketState = null, options = {}) {
  return logAbyssalRoomContentLifecycle(ports, pocketState, { ...options, phase: "activated" });
}

function logAbyssalRoomContentCleaned(ports, pocketState = null, options = {}) {
  return logAbyssalRoomContentLifecycle(ports, pocketState, { ...options, phase: "cleaned" });
}

function appendSceneryEnvironmentRecords(ports, roomEntry, sceneryProfile, sceneryEntries, environmentalEntries, addRecord) {
  const {
    resolveAbyssalRoomEntityRole,
  } = ports;
  for (const [index, sceneryEntityID] of listUniquePositiveInts(
    roomEntry.sceneryVisualEntityIDs,
  ).entries()) {
    const definition = sceneryEntries[index] || {};
    addRecord(sceneryEntityID, {
      typeID: toInt(definition.candidateTypeID, 0),
      name: normalizeText(definition.candidateName, ""),
      entryRole: definition.entryRole,
      abyssalEntityRole: resolveAbyssalRoomEntityRole({
        entryRole: definition.entryRole,
        typeID: definition.candidateTypeID,
      }),
      abyssalDefinitionID: `${normalizeText(sceneryProfile && sceneryProfile.profileID, "abyssal:scenery")}:slot-${Math.max(1, toInt(definition.slot, index + 1))}`,
      presentationEnabled: true,
      mechanicsEnabled: false,
    });
  }

  for (const [index, environmentalObjectItemID] of listUniquePositiveInts(
    roomEntry.environmentalObjectItemIDs,
  ).entries()) {
    const definition = environmentalEntries[index] || {};
    const environmentalDefinition = definition.definition || {};
    addRecord(environmentalObjectItemID, {
      typeID: toInt(definition.typeID, 0),
      name: normalizeText(environmentalDefinition.name, ""),
      sourceRole: definition.sourceRole,
      effectKind: definition.effectKind,
      environmentalObject: true,
      abyssalEntityRole: resolveAbyssalRoomEntityRole({
        sourceRole: definition.sourceRole,
        typeID: definition.typeID,
        effectKind: definition.effectKind,
        environmentalObject: true,
      }),
      abyssalDefinitionID: normalizeText(definition.profileID, ""),
      presentationEnabled: definition.presentationEnabled === true,
      mechanicsEnabled: definition.mechanicsEnabled === true,
      rangeMeters: Number(environmentalDefinition.radiusMeters) || 0,
    });
  }
}

function createAbyssalRoomDiagnostics(ports) {
  return {
    buildAbyssalRoomEntityRecord: buildAbyssalRoomEntityRecord.bind(null, ports),
    listAbyssalRoomEntityRecords: listAbyssalRoomEntityRecords.bind(null, ports),
    countAbyssalRoomContent: countAbyssalRoomContent.bind(null, ports),
    buildAbyssalSceneryAuthorityDiagnostics: buildAbyssalSceneryAuthorityDiagnostics.bind(null, ports),
    warnIfAuthoritativeSceneryMissing: warnIfAuthoritativeSceneryMissing.bind(null, ports),
    buildAbyssalRoomContentDiagnostics: buildAbyssalRoomContentDiagnostics.bind(null, ports),
    buildAbyssalEntityIdentityDiagnostics: buildAbyssalEntityIdentityDiagnostics.bind(null, ports),
    logAbyssalEntityIdentityDiagnostics: logAbyssalEntityIdentityDiagnostics.bind(null, ports),
    logAbyssalRoomContentLifecycle: logAbyssalRoomContentLifecycle.bind(null, ports),
    logAbyssalRoomContentPrepared: logAbyssalRoomContentPrepared.bind(null, ports),
    logAbyssalRoomContentDelivered: logAbyssalRoomContentDelivered.bind(null, ports),
    logAbyssalRoomContentActivated: logAbyssalRoomContentActivated.bind(null, ports),
    logAbyssalRoomContentCleaned: logAbyssalRoomContentCleaned.bind(null, ports),
  };
}

module.exports = { createAbyssalRoomDiagnostics };
