"use strict";

const { normalizeText } = require("../domain/abyssalValueUtils");

// Existing participant, controller and maintenance authorities remain injected.
function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function getNpcRuntimePolicy(ports, source) {
  const {
    getContentProfile,
    cloneValue,
  } = ports;
  const contentProfile = getContentProfile(source) || source;
  const npcProfile = contentProfile && contentProfile.npcProfile;
  return npcProfile && npcProfile.runtimePolicy && typeof npcProfile.runtimePolicy === "object"
    ? cloneValue(npcProfile.runtimePolicy)
    : {
      suppressBounty: false,
      suppressWreck: false,
      suppressStandings: false,
      enforcementMode: "none",
    };
}

function applyAbyssalNpcRuntimeMetadata(ports, entity, pocketState, npcRuntimePolicy, roomState, contentProfile, npcEntry = null) {
  const {
    cloneValue,
    getResolvedWeatherState,
    applyAbyssalRoomEntityMetadata,
    ABYSSAL_ROOM_ENTITY_ROLES,
    getPlaceholderRoomEntry,
    resolvePerimeterRadius,
    applyAbyssalWeatherToNpcEntity,
  } = ports;
  if (!entity || typeof entity !== "object") {
    return {
      applied: false,
      bountySuppressed: false,
      weatherApplied: false,
      weatherPending: false,
    };
  }
  const weatherState = getResolvedWeatherState(pocketState);
  applyAbyssalRoomEntityMetadata(entity, {
    role: ABYSSAL_ROOM_ENTITY_ROLES.NPC,
    abyssalRunID: toInt(pocketState && pocketState.instanceID, 0),
    abyssalRoomIndex: toInt(roomState && roomState.currentRoomIndex, 0),
    abyssalDefinitionID: normalizeText(
      npcEntry && (npcEntry.npcEntryID || npcEntry.profileQuery),
      normalizeText(contentProfile && contentProfile.definitionID, ""),
    ),
    presentationEnabled: true,
    mechanicsEnabled: true,
  });
  entity.evejsAbyssalNpcRuntimePolicy = cloneValue(npcRuntimePolicy);
  entity.evejsAbyssalInstanceID = toInt(pocketState && pocketState.instanceID, 0);
  entity.evejsAbyssalTraceItemID = toInt(pocketState && pocketState.traceItemID, 0);
  entity.evejsAbyssalFilamentTypeID = toInt(contentProfile && contentProfile.filamentTypeID, 0);
  entity.evejsAbyssalDefinitionID = normalizeText(contentProfile && contentProfile.definitionID, "");
  entity.evejsAbyssalRoomIndex = toInt(roomState && roomState.currentRoomIndex, 0);
  entity.evejsAbyssalRoomCount = toInt(roomState && roomState.implementedRooms, 0);
  const roomEntry = getPlaceholderRoomEntry(pocketState, entity.evejsAbyssalRoomIndex);
  const roomOrigin = roomEntry && roomEntry.roomOriginPosition;
  entity.evejsAbyssalNpcBoundary = roomOrigin &&
    [roomOrigin.x, roomOrigin.y, roomOrigin.z].every(Number.isFinite)
    ? {
        runID: entity.evejsAbyssalInstanceID,
        roomIndex: entity.evejsAbyssalRoomIndex,
        origin: { x: roomOrigin.x, y: roomOrigin.y, z: roomOrigin.z },
        radiusMeters: resolvePerimeterRadius({ roomEntry }).perimeterRadiusMeters,
      }
    : null;
  const deliveryState = normalizeText(roomEntry && roomEntry.deliveryState, "");
  if (deliveryState) {
    entity.abyssalRoomDeliveryState = deliveryState;
    entity.evejsAbyssalRoomDeliveryState = deliveryState;
  }
  entity.abyssalTransitionToken = toInt(roomEntry && roomEntry.deliveryTransitionToken, 0);
  entity.abyssalSelectedRoomLayoutID = normalizeText(roomEntry && roomEntry.selectedRoomLayoutID, "");
  entity.evejsAbyssalWeatherType = normalizeText(weatherState && weatherState.weatherType, "");
  entity.evejsAbyssalWeatherStrengthPercent = toInt(weatherState && weatherState.strengthPercent, 0);
  entity.evejsAbyssalWeatherPenaltyStrengthPercent = toInt(
    weatherState && weatherState.penaltyStrengthPercent,
    toInt(weatherState && weatherState.strengthPercent, 0),
  );
  entity.evejsAbyssalWeatherBonusStrengthPercent = toInt(
    weatherState && weatherState.bonusStrengthPercent,
    toInt(weatherState && weatherState.strengthPercent, 0),
  );
  entity.evejsAbyssalWeatherStage = toInt(weatherState && weatherState.weatherStage, 0);
  entity.evejsAbyssalWeatherTypeID = toInt(weatherState && weatherState.weatherTypeID, 0);
  entity.evejsAbyssalEncounterProfileID = normalizeText(npcEntry && npcEntry.encounterProfileID, "");
  entity.evejsAbyssalNpcProfileQuery = normalizeText(npcEntry && npcEntry.profileQuery, "");
  entity.evejsAbyssalNpcProfileName = normalizeText(npcEntry && npcEntry.profileName, "");
  entity.evejsAbyssalObjectiveRelevant = !npcEntry || npcEntry.objectiveRelevant !== false;
  entity.evejsNpcCapabilities = Array.isArray(npcEntry && npcEntry.capabilities)
    ? cloneValue(npcEntry.capabilities)
    : [];
  entity.evejsNpcCapabilityData =
    npcEntry && npcEntry.capabilityData && typeof npcEntry.capabilityData === "object"
      ? cloneValue(npcEntry.capabilityData)
      : {};
  const capturedRetailCombat =
    npcEntry && npcEntry.capturedRetailCombat && typeof npcEntry.capturedRetailCombat === "object"
      ? npcEntry.capturedRetailCombat
      : null;
  if (capturedRetailCombat) {
    entity.evejsAbyssalNpcSpecialFxGuid = normalizeText(
      capturedRetailCombat.specialFxGuid,
      "",
    );
    entity.evejsAbyssalNpcPreserveSpecialFxGuidOrder =
      capturedRetailCombat.preserveSpecialFxGuidOrder === true;
    entity.evejsAbyssalNpcPrecursorSpoolPerCycle = Math.max(
      0,
      Number(capturedRetailCombat.precursorSpoolPerCycle) || 0,
    );
    entity.evejsAbyssalNpcPrecursorSpoolMax = Math.max(
      0,
      Number(capturedRetailCombat.precursorSpoolMax) || 0,
    );
    entity.evejsAbyssalNpcOrbitDistanceMeters = Math.max(
      0,
      Number(capturedRetailCombat.orbitDistanceMeters) || 0,
    );
  }
  if (npcEntry && npcEntry.capturedRetailObject === true) {
    const identity = npcEntry.capturedRetailIdentity &&
      typeof npcEntry.capturedRetailIdentity === "object"
        ? npcEntry.capturedRetailIdentity
        : {};
    entity.inventoryOwnerID = toInt(entity.ownerID, 0);
    entity.ownerID = toInt(
      identity.presentationOwnerID,
      toInt(npcEntry.capturedRetailOwnerID, entity.ownerID),
    );
    entity.friendlyResponseThreshold = Number.isFinite(Number(identity.friendlyResponseThreshold))
      ? Number(identity.friendlyResponseThreshold)
      : entity.friendlyResponseThreshold;
    entity.hostileResponseThreshold = Number.isFinite(Number(identity.hostileResponseThreshold))
      ? Number(identity.hostileResponseThreshold)
      : entity.hostileResponseThreshold;
    entity.suppressSlimName = normalizeText(identity.namePolicy, "type-derived") === "type-derived";
    entity.suppressSlimShipAffiliationFields = true;
    entity.evejsAbyssalCapturedRetailObject = true;
    entity.evejsAbyssalIdentityPolicy = "captured-retail";
    entity.evejsAbyssalNamePolicy = normalizeText(identity.namePolicy, "type-derived");
  }
  let bountySuppressed = false;
  if (npcRuntimePolicy && npcRuntimePolicy.suppressBounty === true) {
    entity.bounty = 0;
    bountySuppressed = true;
  }
  const weatherApplyResult = applyAbyssalWeatherToNpcEntity(entity, pocketState);
  return {
    applied: true,
    bountySuppressed,
    weatherApplied: weatherApplyResult.applied === true,
    weatherPending:
      Array.isArray(weatherApplyResult.pendingEffectKeys) &&
      weatherApplyResult.pendingEffectKeys.length > 0,
  };
}

function buildEncounterStateFromRoomEntry(ports, roomEntry = {}) {
  const {
    cloneValue,
    listUniquePositiveInts,
  } = ports;
  const hostileEntityIDs = listUniquePositiveInts(roomEntry && roomEntry.hostileEntityIDs);
  if (hostileEntityIDs.length === 0 && roomEntry.objectiveComplete !== true) {
    return null;
  }
  return {
    spawnMode: "prewarmed",
    hostileEntityIDs,
    objectiveComplete: roomEntry && roomEntry.objectiveComplete === true,
    objectiveCompletedAtMs: toInt(roomEntry && roomEntry.objectiveCompletedAtMs, 0),
    allowDebugExit: false,
    encounterSpawnFailed: false,
    encounterSpawnError: null,
    encounterSpawnedAtMs: toInt(roomEntry && roomEntry.prewarmedAtMs, 0),
    encounterProfileID: normalizeText(roomEntry && roomEntry.encounterProfileID, ""),
    encounterName: normalizeText(roomEntry && roomEntry.encounterName, ""),
    encounterTheme: normalizeText(roomEntry && roomEntry.encounterTheme, ""),
    encounterFactionTheme: normalizeText(roomEntry && roomEntry.encounterFactionTheme, ""),
    encounterWeatherTheme: normalizeText(roomEntry && roomEntry.encounterWeatherTheme, ""),
    rewardProfileOverride: cloneValue(roomEntry && roomEntry.rewardProfileOverride),
    cacheProfileOverride: cloneValue(roomEntry && roomEntry.cacheProfileOverride),
    observedObjectEntries: cloneValue(roomEntry && roomEntry.observedObjectEntries) || [],
    sourceModelID: normalizeText(roomEntry && roomEntry.sourceModelID, ""),
    sourceVariantID: normalizeText(roomEntry && roomEntry.sourceVariantID, ""),
    sourceSpawnID: normalizeText(roomEntry && roomEntry.sourceSpawnID, ""),
    sourceSpawnFamily: normalizeText(roomEntry && roomEntry.sourceSpawnFamily, ""),
    sourceObservationCount: Math.max(
      0,
      toInt(roomEntry && roomEntry.sourceObservationCount, 0),
    ),
    sourceEvidenceAuthority: normalizeText(
      roomEntry && roomEntry.sourceEvidenceAuthority,
      "",
    ),
    encounterAuthority:
      roomEntry && roomEntry.encounterAuthority &&
        typeof roomEntry.encounterAuthority === "object"
        ? cloneValue(roomEntry.encounterAuthority)
        : null,
    resolvedNpcEntries: cloneValue(roomEntry && roomEntry.resolvedNpcEntries) || [],
    spawnedNpcItemIDs: listUniquePositiveInts(roomEntry && roomEntry.spawnedNpcItemIDs),
    plannedObjectiveNpcItemIDs: listUniquePositiveInts(roomEntry && roomEntry.plannedObjectiveNpcItemIDs),
    materializedObjectiveNpcItemIDs: listUniquePositiveInts(roomEntry && roomEntry.materializedObjectiveNpcItemIDs),
    objectiveRelevantNpcItemIDs: listUniquePositiveInts(roomEntry && roomEntry.objectiveRelevantNpcItemIDs),
    controllerDependantLifecycleGroups: Array.isArray(
      roomEntry && roomEntry.controllerDependantLifecycleGroups,
    )
      ? cloneValue(roomEntry.controllerDependantLifecycleGroups)
      : [],
    dependantInactiveNpcItemIDs: listUniquePositiveInts(
      roomEntry && roomEntry.dependantInactiveNpcItemIDs,
    ),
    destroyedDependantNpcItemIDs: listUniquePositiveInts(
      roomEntry && roomEntry.destroyedDependantNpcItemIDs,
    ),
    destroyedObjectiveIDs: listUniquePositiveInts(roomEntry && roomEntry.destroyedObjectiveIDs),
    defeatedObjectiveItemIDs: listUniquePositiveInts(roomEntry && roomEntry.defeatedObjectiveItemIDs),
    objectiveTotal: toInt(roomEntry && roomEntry.objectiveTotal, 0),
    objectiveDefeatedCount: toInt(roomEntry && roomEntry.objectiveDefeatedCount, 0),
    encounterDroneCount: toInt(roomEntry && roomEntry.encounterDroneCount, 0),
    encounterShipCount: toInt(roomEntry && roomEntry.encounterShipCount, 0),
    encounterEscortTypeID: toInt(roomEntry && roomEntry.encounterEscortTypeID, 0),
    spawnRadiusMeters: toInt(roomEntry && roomEntry.spawnRadiusMeters, 0),
    spawnJitterMeters: toInt(roomEntry && roomEntry.spawnJitterMeters, 0),
    rewardMultiplier: Number(roomEntry && roomEntry.rewardMultiplier) || 0,
    rewardQuantityBonus: toInt(roomEntry && roomEntry.rewardQuantityBonus, 0),
  };
}

function listPocketHostileEntityIDs(ports, pocketState) {
  const {
    getPlaceholderRoomEntry,
    listUniquePositiveInts,
  } = ports;
  if (!pocketState) {
    return [];
  }
  const currentRoomEntry = getPlaceholderRoomEntry(pocketState);
  return listUniquePositiveInts(
    currentRoomEntry.hostileEntityIDs && currentRoomEntry.hostileEntityIDs.length > 0
      ? currentRoomEntry.hostileEntityIDs
      : pocketState.hostileEntityIDs,
  );
}

function listPocketObjectiveRelevantEntityIDs(ports, pocketState) {
  const {
    getPlaceholderRoomEntry,
    listUniquePositiveInts,
  } = ports;
  if (!pocketState) {
    return [];
  }
  const currentRoomEntry = getPlaceholderRoomEntry(pocketState);
  const objectiveRelevantIDs = listUniquePositiveInts(currentRoomEntry.objectiveRelevantNpcItemIDs);
  return objectiveRelevantIDs.length > 0
    ? objectiveRelevantIDs
    : listPocketHostileEntityIDs(ports, pocketState);
}

function listAllPocketHostileEntityIDs(ports, pocketState) {
  const {
    listUniquePositiveInts,
    buildPlaceholderRoomState,
  } = ports;
  if (!pocketState) {
    return [];
  }
  const roomState = buildPlaceholderRoomState(pocketState);
  const tracked = [];
  for (const roomEntry of Object.values(roomState.roomStatesByIndex || {})) {
    tracked.push(...listUniquePositiveInts(roomEntry && roomEntry.hostileEntityIDs));
  }
  tracked.push(...listUniquePositiveInts(pocketState.hostileEntityIDs));
  return listUniquePositiveInts(tracked);
}

function updateAbyssalRoomNpcActivationState(ports, pocketState, roomIndex, patch = {}) {
  const {
    cloneValue,
    getPlaceholderRoomEntry,
    buildPlaceholderRoomState,
    getActivePocketStateByInstanceID,
    setPlaceholderRoomEntry,
    buildPocketStateForCurrentRoom,
    updatePocketState,
  } = ports;
  const activePocketState = getActivePocketStateByInstanceID(
    toInt(pocketState && pocketState.instanceID, 0),
  ) || pocketState;
  const roomState = buildPlaceholderRoomState(activePocketState);
  const roomEntry = getPlaceholderRoomEntry(activePocketState, roomIndex);
  const nextRoomState = setPlaceholderRoomEntry(
    activePocketState,
    roomIndex,
    {
      ...roomEntry,
      ...cloneValue(patch),
    },
  );
  const nextPocketState = {
    ...cloneValue(activePocketState),
    ...buildPocketStateForCurrentRoom(activePocketState, nextRoomState),
    roomState: nextRoomState,
    encounterState: {
      ...cloneValue(activePocketState && activePocketState.encounterState),
      ...cloneValue(patch),
    },
  };
  return updatePocketState(nextPocketState.instanceID, nextPocketState) || nextPocketState;
}

function degradeAbyssalRoomNpcActivation(ports,
  pocketState,
  session,
  deps,
  options = {},
) {
  const {
    cloneValue,
    listUniquePositiveInts,
    buildPlaceholderRoomState,
    updatePocketState,
    pauseAbyssalObjectiveControllers,
    suppressAbyssalRoomRewards,
    log,
  } = ports;
  const roomIndex = toInt(options.roomIndex, buildPlaceholderRoomState(pocketState).currentRoomIndex);
  const objectiveIDs = listUniquePositiveInts(options.objectiveIDs);
  const readiness = Array.isArray(options.readiness) ? options.readiness : [];
  const nowMs = toInt(options.nowMs, toInt(deps.now && deps.now(), Date.now()));
  const npcRuntime = deps;
  pauseAbyssalObjectiveControllers(
    npcRuntime,
    objectiveIDs,
    "abyssal_room_activation_degraded",
  );
  const failures = readiness
    .filter((entry) => !entry.ready)
    .map((entry) => ({ npcID: entry.npcID, failure: entry.failure }));
  const failedIDs = listUniquePositiveInts(failures.map((entry) => entry.npcID));
  let degradedState = updateAbyssalRoomNpcActivationState(ports, pocketState, roomIndex, {
    npcControllerActivationState: "degraded",
    npcControllerActivationFailedNpcIDs: failedIDs,
    npcControllerActivationFailures: failures,
  });
  degradedState = updatePocketState(degradedState.instanceID, {
    ...degradedState,
    allowDebugExit: false,
    encounterState: {
      ...cloneValue(degradedState.encounterState),
      spawnMode: "degraded",
      encounterSpawnFailed: true,
      encounterSpawnError: normalizeText(options.reason, "ABYSSAL_NPC_ACTIVATION_FAILED"),
      npcControllerActivationState: "degraded",
      npcControllerActivationFailures: failures,
    },
  }) || {
    ...degradedState,
    allowDebugExit: false,
  };
  degradedState = suppressAbyssalRoomRewards(
    degradedState,
    roomIndex,
    deps,
    "ROOM_ENCOUNTER_DEGRADED",
  );
  log.warn(
    `[AbyssalNpcActivation] room activation failed ` +
      `run=${toInt(degradedState && degradedState.instanceID, 0)} room=${roomIndex} ` +
      `failedIDs=${failedIDs.join(",") || "none"} ` +
      `failures=${failures.map((entry) => `${entry.npcID}:${entry.failure}`).join(",") || "none"} ` +
      `degraded=true conduitFailClosed=true`,
  );
  return degradedState;
}

function createAbyssalNpcLifecycleMetadata(ports) {
  return {
    getNpcRuntimePolicy: getNpcRuntimePolicy.bind(null, ports),
    applyAbyssalNpcRuntimeMetadata: applyAbyssalNpcRuntimeMetadata.bind(null, ports),
    buildEncounterStateFromRoomEntry: buildEncounterStateFromRoomEntry.bind(null, ports),
    listPocketHostileEntityIDs: listPocketHostileEntityIDs.bind(null, ports),
    listPocketObjectiveRelevantEntityIDs: listPocketObjectiveRelevantEntityIDs.bind(null, ports),
    listAllPocketHostileEntityIDs: listAllPocketHostileEntityIDs.bind(null, ports),
    updateAbyssalRoomNpcActivationState: updateAbyssalRoomNpcActivationState.bind(null, ports),
    degradeAbyssalRoomNpcActivation: degradeAbyssalRoomNpcActivation.bind(null, ports),
  };
}

module.exports = { createAbyssalNpcLifecycleMetadata };
