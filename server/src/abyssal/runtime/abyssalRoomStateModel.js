"use strict";

const {
  toInt, toReal, normalizeText, normalizeVector, normalizeDirection, addVectors, scaleVector,
  getObjectPosition, listUniquePositiveInts, listPositiveInts, formatVectorForLog,
} = require("../domain/abyssalRuntimeValues");

// Room-state normalization is separate from durable mutation and runtime materialization.
function getRoomProfile(ports, source) {
  const {
    getContentProfile,
    cloneValue,
  } = ports;
  const contentProfile = getContentProfile(source) || source;
  return contentProfile && contentProfile.roomProfile && typeof contentProfile.roomProfile === "object"
    ? cloneValue(contentProfile.roomProfile)
    : null;
}

function getRoomEncounterProfilesByIndex(ports, source) {
  const {
    getContentProfile,
  } = ports;
  const contentProfile = getContentProfile(source) || source;
  return contentProfile && contentProfile.roomEncounterProfilesByIndex &&
    typeof contentProfile.roomEncounterProfilesByIndex === "object"
    ? contentProfile.roomEncounterProfilesByIndex
    : {};
}

function listActiveAbyssalRoomNpcIDs(ports, roomEntry = {}) {
  const inactiveDependantIDs = new Set(
    listUniquePositiveInts(roomEntry && roomEntry.dependantInactiveNpcItemIDs),
  );
  return listUniquePositiveInts(
    roomEntry && roomEntry.hostileEntityIDs,
  ).filter((npcID) => !inactiveDependantIDs.has(npcID));
}

function clampRoomIndex(ports, roomIndex, implementedRooms) {
  return Math.max(1, Math.min(Math.max(1, toInt(implementedRooms, 1)), toInt(roomIndex, 1)));
}

function getRoomOffsetVectors(ports, source) {
  const {
    PLACEHOLDER_ROOM_OFFSET_VECTORS,
  } = ports;
  const roomProfile = getRoomProfile(ports, source) || {};
  const authoredOffsets = Array.isArray(roomProfile.roomOffsetsMeters)
    ? roomProfile.roomOffsetsMeters
    : PLACEHOLDER_ROOM_OFFSET_VECTORS;
  return authoredOffsets.map((entry, index) => {
    const fallback = PLACEHOLDER_ROOM_OFFSET_VECTORS[index] || PLACEHOLDER_ROOM_OFFSET_VECTORS.at(-1);
    return normalizeVector(entry, fallback);
  });
}

function getRoomOffsetForIndex(ports, source, roomIndex) {
  const {
    PLACEHOLDER_ROOM_OFFSET_VECTORS,
  } = ports;
  const offsets = getRoomOffsetVectors(ports, source);
  return normalizeVector(
    offsets[Math.max(0, clampRoomIndex(ports, roomIndex, offsets.length) - 1)],
    PLACEHOLDER_ROOM_OFFSET_VECTORS[0],
  );
}

function getImplementedRoomCount(ports, source) {
  const roomProfile = getRoomProfile(ports, source) || {};
  return Math.max(1, toInt(roomProfile.implementedRooms, 1));
}

function getRetailTargetRoomCount(ports, source) {
  const roomProfile = getRoomProfile(ports, source) || {};
  return Math.max(getImplementedRoomCount(ports, source), toInt(roomProfile.retailTargetRooms, 3));
}

function getRoomOriginLabel(ports, source) {
  const roomProfile = getRoomProfile(ports, source) || {};
  return normalizeText(roomProfile.roomOriginLabel, "Abyssal Origin Marker (Placeholder)");
}

function getTransferConduitLabel(ports, source) {
  const roomProfile = getRoomProfile(ports, source) || {};
  return normalizeText(roomProfile.transferConduitLabel, "Transfer Conduit (Triglavian)");
}

function getFinalExitConduitLabel(ports, source) {
  const roomProfile = getRoomProfile(ports, source) || {};
  return normalizeText(roomProfile.finalExitConduitLabel, "Origin Conduit (Triglavian)");
}

function isFinalRoomIndex(ports, source, roomIndex) {
  const {
    isAbyssalFinalRoomIndex,
  } = ports;
  return isAbyssalFinalRoomIndex({
    roomIndex,
    roomCount: getImplementedRoomCount(ports, source),
  });
}

function resolveRoomOriginPosition(ports, source, roomIndex) {
  const basePosition =
    getObjectPosition(source && source.roomOneOriginPosition) ||
    getObjectPosition(source && source.pocketPosition) ||
    { x: 0, y: 0, z: 0 };
  return addVectors(
    normalizeVector(basePosition),
    getRoomOffsetForIndex(ports, source, roomIndex),
  );
}

function buildRoomShipSpawnState(ports, source, roomIndex) {
  const {
    PLACEHOLDER_POCKET_SHIP_OFFSET_METERS,
  } = ports;
  const direction = normalizeDirection(
    source && source.shipSpawnState && source.shipSpawnState.direction ||
      source && source.sourceShipDirection,
    { x: 1, y: 0, z: 0 },
  );
  const roomOriginPosition = resolveRoomOriginPosition(ports, source, roomIndex);
  const spawnPosition = addVectors(
    roomOriginPosition,
    scaleVector(direction, PLACEHOLDER_POCKET_SHIP_OFFSET_METERS),
  );
  return {
    systemID: toInt(source && source.solarSystemID, 0),
    position: spawnPosition,
    velocity: { x: 0, y: 0, z: 0 },
    direction,
    targetPoint: spawnPosition,
    mode: "STOP",
    speedFraction: 0,
  };
}

function buildRoomConduitState(ports, source, roomIndex) {
  const {
    getCapturedT0DarkRoom,
    cloneValue,
    normalizeTranquilPresentationIdentity,
    getCapturedAuthoredRoom,
    getCapturedAuthoredRoomEntity,
    buildCapturedAuthoredDunRotation,
    resolveTranquilConduitPresentationIdentity,
    PLACEHOLDER_ROOM_CONDUIT_DISTANCE_METERS,
  } = ports;
  const roomOriginPosition = resolveRoomOriginPosition(ports, source, roomIndex);
  const capturedRoom = getCapturedT0DarkRoom(source, roomIndex);
  if (capturedRoom && capturedRoom.conduit) {
    const relativePosition = capturedRoom.conduit.position;
    const position = addVectors(roomOriginPosition, relativePosition);
    const direction = normalizeDirection(
      {
        x: toReal(relativePosition.x, 0),
        y: toReal(relativePosition.y, 0),
        z: toReal(relativePosition.z, 0),
      },
      source && source.shipSpawnState && source.shipSpawnState.direction ||
        source && source.sourceShipDirection ||
        { x: 1, y: 0, z: 0 },
    );
    return {
      systemID: toInt(source && source.solarSystemID, 0),
      position,
      velocity: { x: 0, y: 0, z: 0 },
      direction,
      targetPoint: position,
      mode: "STOP",
      speedFraction: 0,
      dunObjectID: toInt(capturedRoom.conduit.dunObjectID, 0) || null,
      dunPosition: [
        toReal(relativePosition.x, 0),
        toReal(relativePosition.y, 0),
        toReal(relativePosition.z, 0),
      ],
      dunRotation: cloneValue(capturedRoom.conduit.rotation),
      identity: normalizeTranquilPresentationIdentity(
        capturedRoom.conduit.identity,
      ),
      capturedRetailObject: true,
    };
  }
  const capturedAuthoredRoom = getCapturedAuthoredRoom(source, roomIndex);
  const capturedAuthoredConduit = getCapturedAuthoredRoomEntity(
    capturedAuthoredRoom,
    isFinalRoomIndex(ports, source, roomIndex)
      ? "originConduitEntityID"
      : "transferConduitEntityID",
    isFinalRoomIndex(ports, source, roomIndex)
      ? ["origin-conduit"]
      : ["transfer-conduit"],
  );
  if (capturedAuthoredConduit) {
    const relativePosition = getObjectPosition(capturedAuthoredConduit.position);
    const position = addVectors(roomOriginPosition, relativePosition);
    const direction = normalizeDirection(
      relativePosition,
      source && source.shipSpawnState && source.shipSpawnState.direction ||
        source && source.sourceShipDirection ||
        { x: 1, y: 0, z: 0 },
    );
    return {
      systemID: toInt(source && source.solarSystemID, 0),
      position,
      velocity: { x: 0, y: 0, z: 0 },
      direction,
      targetPoint: position,
      mode: "STOP",
      speedFraction: 0,
      dunObjectID: toInt(capturedAuthoredConduit.dunObjectID, 0) || null,
      dunPosition: [
        toReal(relativePosition.x, 0),
        toReal(relativePosition.y, 0),
        toReal(relativePosition.z, 0),
      ],
      dunRotation: buildCapturedAuthoredDunRotation(capturedAuthoredConduit),
      identity: resolveTranquilConduitPresentationIdentity(source, roomIndex),
      capturedRetailObject: true,
      authoredEntityID: normalizeText(capturedAuthoredConduit.entityID, "") || null,
    };
  }
  const direction = normalizeDirection(
    source && source.shipSpawnState && source.shipSpawnState.direction ||
      source && source.sourceShipDirection,
    { x: 1, y: 0, z: 0 },
  );
  const position = addVectors(
    roomOriginPosition,
    scaleVector(direction, PLACEHOLDER_ROOM_CONDUIT_DISTANCE_METERS),
  );
  return {
    systemID: toInt(source && source.solarSystemID, 0),
    position,
    velocity: { x: 0, y: 0, z: 0 },
    direction,
    targetPoint: position,
    mode: "STOP",
    speedFraction: 0,
    identity: resolveTranquilConduitPresentationIdentity(source, roomIndex),
  };
}

function buildRoomLateralDirection(ports, source, roomIndex) {
  const conduitState = buildRoomConduitState(ports, source, roomIndex);
  const direction = normalizeDirection(conduitState.direction, { x: 1, y: 0, z: 0 });
  return normalizeDirection({
    x: -direction.y,
    y: direction.x,
    z: 0,
  }, { x: 0, y: 1, z: 0 });
}

function buildRoomOffsetFromConduitState(ports, source, roomIndex, forwardMeters, lateralMeters = 0, verticalMeters = 0) {
  const conduitState = buildRoomConduitState(ports, source, roomIndex);
  const direction = normalizeDirection(conduitState.direction, { x: 1, y: 0, z: 0 });
  const lateral = buildRoomLateralDirection(ports, source, roomIndex);
  const position = addVectors(
    addVectors(
      addVectors(
        conduitState.position,
        scaleVector(direction, toInt(forwardMeters, 0)),
      ),
      scaleVector(lateral, toInt(lateralMeters, 0)),
    ),
    { x: 0, y: 0, z: toInt(verticalMeters, 0) },
  );
  return {
    systemID: toInt(source && source.solarSystemID, 0),
    position,
    velocity: { x: 0, y: 0, z: 0 },
    direction,
    targetPoint: position,
    mode: "STOP",
    speedFraction: 0,
  };
}

function buildRoomEntryPlacement(ports, source, numericRoomIndex, shipSpawnState, overrides) {
  const {
    cloneValue,
    resolveSelectedAbyssalBaseRoomLayoutID,
  } = ports;
  return {
    roomIndex: numericRoomIndex,
    roomOriginPosition: getObjectPosition(overrides.roomOriginPosition) ||
      resolveRoomOriginPosition(ports, source, numericRoomIndex),
    shipSpawnState,
    hostileEntityIDs: listUniquePositiveInts(overrides.hostileEntityIDs),
    cacheItemID: toInt(overrides.cacheItemID, 0),
    cacheStructureItemID: toInt(overrides.cacheStructureItemID, toInt(overrides.cacheItemID, 0)),
    cacheLootContainerItemID: toInt(overrides.cacheLootContainerItemID, 0),
    cacheRewardEntries: Array.isArray(overrides.cacheRewardEntries)
      ? cloneValue(overrides.cacheRewardEntries)
      : [],
    cacheRewardPlan:
      overrides.cacheRewardPlan && typeof overrides.cacheRewardPlan === "object"
        ? cloneValue(overrides.cacheRewardPlan)
        : null,
    cacheRewardMaterialized: overrides.cacheRewardMaterialized === true,
    cacheSpawnedAtMs: toInt(overrides.cacheSpawnedAtMs, 0),
    cacheLifecycleState: normalizeText(overrides.cacheLifecycleState, ""),
    cacheRewardRetryIntent:
      overrides.cacheRewardRetryIntent &&
      typeof overrides.cacheRewardRetryIntent === "object"
        ? cloneValue(overrides.cacheRewardRetryIntent)
        : null,
    cacheRewardRetryError: normalizeText(overrides.cacheRewardRetryError, ""),
    unavailableReason: normalizeText(overrides.unavailableReason, ""),
    suppressedReason: normalizeText(overrides.suppressedReason, ""),
    conduitItemID: toInt(overrides.conduitItemID, 0),
    conduitLabel: normalizeText(
      overrides.conduitLabel,
      isFinalRoomIndex(ports, source, numericRoomIndex)
        ? getFinalExitConduitLabel(ports, source)
        : getTransferConduitLabel(ports, source),
    ),
    conduitOpen: overrides.conduitOpen === true,
    conduitOpenedAtMs: toInt(overrides.conduitOpenedAtMs, 0),
    conduitOpenFxStatus: normalizeText(overrides.conduitOpenFxStatus, ""),
    originMarkerItemID: toInt(overrides.originMarkerItemID, 0),
    objectiveComplete: overrides.objectiveComplete === true,
    objectiveCompletedAtMs: toInt(overrides.objectiveCompletedAtMs, 0),
    enteredAtMs: toInt(overrides.enteredAtMs, 0),
    prewarmedAtMs: toInt(overrides.prewarmedAtMs, 0),
    deliveredEntityIDs: listUniquePositiveInts(overrides.deliveredEntityIDs),
    deliveredAtMs: toInt(overrides.deliveredAtMs, 0),
    deliveryState: normalizeText(overrides.deliveryState, ""),
    deliveryTransitionToken: toInt(overrides.deliveryTransitionToken, 0),
    deliveryStateChangedAtMs: toInt(overrides.deliveryStateChangedAtMs, 0),
    selectedRoomLayoutID: normalizeText(
      overrides.selectedRoomLayoutID,
      resolveSelectedAbyssalBaseRoomLayoutID(source || {}, numericRoomIndex),
    ),
    earlyVisibilityViolationCount: Math.max(0, toInt(overrides.earlyVisibilityViolationCount, 0)),
  };
}

function buildRoomEntryEncounter(ports, source, numericRoomIndex, shipSpawnState, overrides) {
  const {
    cloneRuntimeRewardProfileOverride,
    cloneValue,
  } = ports;
  return {
    encounterProfileID: normalizeText(overrides.encounterProfileID, ""),
    encounterName: normalizeText(overrides.encounterName, ""),
    encounterTheme: normalizeText(overrides.encounterTheme, ""),
    encounterFactionTheme: normalizeText(overrides.encounterFactionTheme, ""),
    encounterWeatherTheme: normalizeText(overrides.encounterWeatherTheme, ""),
    rewardProfileOverride: cloneRuntimeRewardProfileOverride(
      overrides.rewardProfileOverride,
    ),
    cacheProfileOverride:
      overrides.cacheProfileOverride &&
        typeof overrides.cacheProfileOverride === "object"
        ? cloneValue(overrides.cacheProfileOverride)
        : null,
    observedObjectEntries: Array.isArray(overrides.observedObjectEntries)
      ? cloneValue(overrides.observedObjectEntries)
      : [],
    sourceModelID: normalizeText(overrides.sourceModelID, ""),
    sourceVariantID: normalizeText(overrides.sourceVariantID, ""),
    sourceSpawnID: normalizeText(overrides.sourceSpawnID, ""),
    sourceSpawnFamily: normalizeText(overrides.sourceSpawnFamily, ""),
    sourceObservationCount: Math.max(0, toInt(overrides.sourceObservationCount, 0)),
    sourceEvidenceAuthority: normalizeText(overrides.sourceEvidenceAuthority, ""),
    encounterAuthority:
      overrides.encounterAuthority &&
        typeof overrides.encounterAuthority === "object"
        ? cloneValue(overrides.encounterAuthority)
        : null,
    resolvedNpcEntries: Array.isArray(overrides.resolvedNpcEntries)
      ? cloneValue(overrides.resolvedNpcEntries)
      : [],
    spawnedNpcItemIDs: listUniquePositiveInts(overrides.spawnedNpcItemIDs),
    plannedObjectiveNpcItemIDs: listUniquePositiveInts(
      overrides.plannedObjectiveNpcItemIDs ||
      overrides.objectivePlannedNpcItemIDs ||
      overrides.objectiveRelevantNpcItemIDs,
    ),
    materializedObjectiveNpcItemIDs: listUniquePositiveInts(
      overrides.materializedObjectiveNpcItemIDs ||
      overrides.objectiveMaterializedNpcItemIDs ||
      overrides.objectiveRelevantNpcItemIDs,
    ),
    objectiveRelevantNpcItemIDs: listUniquePositiveInts(overrides.objectiveRelevantNpcItemIDs),
    controllerDependantLifecycleGroups: Array.isArray(
      overrides.controllerDependantLifecycleGroups,
    )
      ? cloneValue(overrides.controllerDependantLifecycleGroups)
      : [],
    dependantInactiveNpcItemIDs: listUniquePositiveInts(
      overrides.dependantInactiveNpcItemIDs,
    ),
    destroyedDependantNpcItemIDs: listUniquePositiveInts(
      overrides.destroyedDependantNpcItemIDs,
    ),
    destroyedObjectiveIDs: listUniquePositiveInts(overrides.destroyedObjectiveIDs),
    defeatedObjectiveItemIDs: listUniquePositiveInts(overrides.defeatedObjectiveItemIDs),
    objectiveTotal: Math.max(0, toInt(overrides.objectiveTotal, 0)),
    objectiveDefeatedCount: Math.max(0, toInt(overrides.objectiveDefeatedCount, 0)),
    npcControllerActivationState: normalizeText(overrides.npcControllerActivationState, ""),
    npcControllerActivationAttemptCount: Math.max(0, toInt(overrides.npcControllerActivationAttemptCount, 0)),
    npcControllerActivationAttemptedAtMs: toInt(overrides.npcControllerActivationAttemptedAtMs, 0),
    npcControllerActivatedAtMs: toInt(overrides.npcControllerActivatedAtMs, 0),
    npcControllerWatchdogRetryAttempted: overrides.npcControllerWatchdogRetryAttempted === true,
    npcControllerWatchdogRetryAttemptedAtMs: toInt(overrides.npcControllerWatchdogRetryAttemptedAtMs, 0),
    npcControllerActivationFailedNpcIDs: listUniquePositiveInts(overrides.npcControllerActivationFailedNpcIDs),
    npcControllerActivationFailures: Array.isArray(overrides.npcControllerActivationFailures)
      ? cloneValue(overrides.npcControllerActivationFailures)
      : [],
    encounterDroneCount: Math.max(0, toInt(overrides.encounterDroneCount, 0)),
    encounterShipCount: Math.max(0, toInt(overrides.encounterShipCount, 0)),
    encounterEscortTypeID: Math.max(0, toInt(overrides.encounterEscortTypeID, 0)),
    spawnRadiusMeters: Math.max(0, toInt(overrides.spawnRadiusMeters, 0)),
    spawnJitterMeters: Math.max(0, toInt(overrides.spawnJitterMeters, 0)),
    rewardMultiplier: Number.isFinite(Number(overrides.rewardMultiplier))
      ? Number(overrides.rewardMultiplier)
      : 0,
    rewardQuantityBonus: toInt(overrides.rewardQuantityBonus, 0),
    combatBudget: overrides.combatBudget && typeof overrides.combatBudget === "object"
      ? cloneValue(overrides.combatBudget)
      : null,
    rewardTypeID: toInt(overrides.rewardTypeID, 0),
    rewardQuantity: toInt(overrides.rewardQuantity, 0),
    contentsGranted: overrides.contentsGranted === true,
  };
}

function buildRoomEntryArtifacts(ports, source, numericRoomIndex, shipSpawnState, overrides) {
  const {
    cloneValue,
  } = ports;
  return {
    extractionNodeItemIDs: listUniquePositiveInts(overrides.extractionNodeItemIDs),
    extractionNodeHistoricalItemIDs: listUniquePositiveInts(overrides.extractionNodeHistoricalItemIDs),
    extractionNodeLootContainerItemIDs: listUniquePositiveInts(overrides.extractionNodeLootContainerItemIDs),
    extractionNodeRewardMaterializedItemIDs: listUniquePositiveInts(overrides.extractionNodeRewardMaterializedItemIDs),
    extractionNodeRewardPlansByItemID:
      overrides.extractionNodeRewardPlansByItemID &&
      typeof overrides.extractionNodeRewardPlansByItemID === "object"
        ? cloneValue(overrides.extractionNodeRewardPlansByItemID)
        : {},
    extractionNodeRewardRetryIntentsByItemID:
      overrides.extractionNodeRewardRetryIntentsByItemID &&
      typeof overrides.extractionNodeRewardRetryIntentsByItemID === "object"
        ? cloneValue(overrides.extractionNodeRewardRetryIntentsByItemID)
        : {},
    extractionNodeRewardRetryItemID: toInt(overrides.extractionNodeRewardRetryItemID, 0),
    extractionNodeRewardRetryError: normalizeText(overrides.extractionNodeRewardRetryError, ""),
    rewardSuppressionPendingRemovalItemIDs: listUniquePositiveInts(
      overrides.rewardSuppressionPendingRemovalItemIDs,
    ),
    extractionNodePlannedCount: Math.max(0, toInt(overrides.extractionNodePlannedCount, 0)),
    extractionNodePlannedTypeIDs: listUniquePositiveInts(overrides.extractionNodePlannedTypeIDs),
    extractionNodeSelectionKey: normalizeText(overrides.extractionNodeSelectionKey, ""),
    extractionNodeSpawnedAtMs: toInt(overrides.extractionNodeSpawnedAtMs, 0),
    extractionNodeLifecycleState: normalizeText(overrides.extractionNodeLifecycleState, ""),
    extractionNodeProfileID: normalizeText(overrides.extractionNodeProfileID, ""),
    sceneryVisualEntityIDs: listUniquePositiveInts(overrides.sceneryVisualEntityIDs),
    sceneryVisualTypeIDs: listUniquePositiveInts(overrides.sceneryVisualTypeIDs),
    sceneryVisualProfileID: normalizeText(overrides.sceneryVisualProfileID, ""),
    sceneryVisualSpawnedAtMs: toInt(overrides.sceneryVisualSpawnedAtMs, 0),
    sceneryVisualLifecycleState: normalizeText(overrides.sceneryVisualLifecycleState, ""),
    sceneryVisualBlockReason: normalizeText(overrides.sceneryVisualBlockReason, ""),
    sceneryProbeEntityID: toInt(overrides.sceneryProbeEntityID, 0),
    sceneryProbeTypeID: toInt(overrides.sceneryProbeTypeID, 0),
    sceneryProbeTypeName: normalizeText(overrides.sceneryProbeTypeName, ""),
    sceneryProbeCandidateKey: normalizeText(overrides.sceneryProbeCandidateKey, ""),
    sceneryProbePresetKey: normalizeText(overrides.sceneryProbePresetKey, ""),
    sceneryProbeProfileID: normalizeText(overrides.sceneryProbeProfileID, ""),
    sceneryProbeSpawnedAtMs: toInt(overrides.sceneryProbeSpawnedAtMs, 0),
    sceneryProbeLifecycleState: normalizeText(overrides.sceneryProbeLifecycleState, ""),
    sceneryProbeBlockReason: normalizeText(overrides.sceneryProbeBlockReason, ""),
    sceneryProbePosition: getObjectPosition(overrides.sceneryProbePosition),
    sceneryProbeOrdinal: Math.max(0, toInt(overrides.sceneryProbeOrdinal, 0)),
    sceneryProbePreviousEntityID: toInt(overrides.sceneryProbePreviousEntityID, 0),
    sceneryProbeAddBallsSent: overrides.sceneryProbeAddBallsSent === true,
  };
}

function buildRoomEntryEnvironment(ports, source, numericRoomIndex, shipSpawnState, overrides) {
  const {
    cloneValue,
  } = ports;
  return {
    environmentalObjectItemIDs: listUniquePositiveInts(overrides.environmentalObjectItemIDs),
    // Environmental slots are positional and may legitimately contain more
    // than one object of the same observed type.
    environmentalObjectTypeIDs: listPositiveInts(overrides.environmentalObjectTypeIDs),
    environmentalObjectProfileIDs: Array.isArray(overrides.environmentalObjectProfileIDs)
      ? overrides.environmentalObjectProfileIDs
        .map((profileID) => normalizeText(profileID, ""))
        .filter(Boolean)
      : [],
    environmentalObjectDestroyedReceiptsBySlot:
      overrides.environmentalObjectDestroyedReceiptsBySlot &&
      typeof overrides.environmentalObjectDestroyedReceiptsBySlot === "object"
        ? cloneValue(overrides.environmentalObjectDestroyedReceiptsBySlot)
        : {},
    environmentalObjectSpawnedAtMs: toInt(overrides.environmentalObjectSpawnedAtMs, 0),
    environmentalObjectLifecycleState: normalizeText(overrides.environmentalObjectLifecycleState, ""),
    environmentalObjectBlockReason: normalizeText(overrides.environmentalObjectBlockReason, ""),
    environmentalMechanicsState: normalizeText(overrides.environmentalMechanicsState, ""),
    environmentalMechanicsFailureReason: normalizeText(
      overrides.environmentalMechanicsFailureReason,
      "",
    ),
    environmentalMechanicsFailureCount: Math.max(
      0,
      toInt(overrides.environmentalMechanicsFailureCount, 0),
    ),
    environmentalMechanicsLastCheckedAtMs: toInt(
      overrides.environmentalMechanicsLastCheckedAtMs,
      0,
    ),
    environmentalMechanicsUnresolvedCollectionIDs: listUniquePositiveInts(
      overrides.environmentalMechanicsUnresolvedCollectionIDs,
    ),
    perimeterRadiusMeters: Number.isFinite(Number(overrides.perimeterRadiusMeters))
      ? Number(overrides.perimeterRadiusMeters)
      : 0,
    perimeterRadiusSource: normalizeText(overrides.perimeterRadiusSource, ""),
    boundaryRadiusMeters: Number.isFinite(Number(overrides.boundaryRadiusMeters))
      ? Number(overrides.boundaryRadiusMeters)
      : 0,
    boundaryRadiusSource: normalizeText(overrides.boundaryRadiusSource, ""),
    environmentalEffectLastEvaluatedAtMs: toInt(overrides.environmentalEffectLastEvaluatedAtMs, 0),
    environmentalEffectEvaluationCount: Math.max(0, toInt(overrides.environmentalEffectEvaluationCount, 0)),
  };
}

function buildPlaceholderRoomEntry(ports, source, roomIndex, overrides = {}) {
  const {
    cloneValue,
  } = ports;
  const numericRoomIndex = clampRoomIndex(ports, roomIndex, getImplementedRoomCount(ports, source));
  const shipSpawnState = cloneValue(
    overrides.shipSpawnState,
  ) || buildRoomShipSpawnState(ports, source, numericRoomIndex);
  return {
    ...buildRoomEntryPlacement(ports, source, numericRoomIndex, shipSpawnState, overrides),
    ...buildRoomEntryEncounter(ports, source, numericRoomIndex, shipSpawnState, overrides),
    ...buildRoomEntryArtifacts(ports, source, numericRoomIndex, shipSpawnState, overrides),
    ...buildRoomEntryEnvironment(ports, source, numericRoomIndex, shipSpawnState, overrides),
  };
}

function isAbyssalPocketMutationBatchActive(ports, source) {
  const instanceID = toInt(source && source.instanceID, 0);
  return instanceID > 0 && ports.hasMutationBatch(instanceID);
}

function buildPlaceholderRoomState(ports, source, overrides = {}) {
  const {
    getContentProfile,
    cloneValue,
  } = ports;
  const contentProfile = getContentProfile(source) || source || {};
  const roomProfile = getRoomProfile(ports, contentProfile) || {};
  const useStructuralSharing = isAbyssalPocketMutationBatchActive(ports, source);
  const sourceRoomState = source && source.roomState && typeof source.roomState === "object"
    ? (useStructuralSharing ? source.roomState : cloneValue(source.roomState))
    : {};
  const mergedRoomState = {
    ...(useStructuralSharing ? roomProfile : cloneValue(roomProfile)),
    ...sourceRoomState,
    ...(useStructuralSharing ? overrides : cloneValue(overrides)),
  };
  const implementedRooms = Math.max(1, toInt(mergedRoomState.implementedRooms, 3));
  const retailTargetRooms = Math.max(implementedRooms, toInt(mergedRoomState.retailTargetRooms, 3));
  const currentRoomIndex = clampRoomIndex(ports, mergedRoomState.currentRoomIndex, implementedRooms);
  const rawRoomStates = mergedRoomState.roomStatesByIndex && typeof mergedRoomState.roomStatesByIndex === "object"
    ? mergedRoomState.roomStatesByIndex
    : {};
  const roomStatesByIndex = useStructuralSharing ? { ...rawRoomStates } : {};
  for (let roomIndex = 1; roomIndex <= implementedRooms; roomIndex += 1) {
    const rawEntry = rawRoomStates[String(roomIndex)] || rawRoomStates[roomIndex] || {};
    if (
      useStructuralSharing &&
      rawEntry &&
      typeof rawEntry === "object" &&
      toInt(rawEntry.roomIndex, 0) === roomIndex
    ) {
      roomStatesByIndex[String(roomIndex)] = rawEntry;
    } else {
      roomStatesByIndex[String(roomIndex)] = buildPlaceholderRoomEntry(ports,
        source || contentProfile,
        roomIndex,
        rawEntry,
      );
    }
  }
  const currentRoomEntry = roomStatesByIndex[String(currentRoomIndex)] || buildPlaceholderRoomEntry(ports,
    source || contentProfile,
    currentRoomIndex,
  );
  const completedRooms = Object.values(roomStatesByIndex)
    .filter((entry) => entry && entry.objectiveComplete === true)
    .length;
  return {
    retailTargetRooms,
    implementedRooms,
    currentRoomIndex,
    completedRooms,
    currentRoomComplete: currentRoomEntry.objectiveComplete === true,
    currentRoomHostileIDs: listUniquePositiveInts(currentRoomEntry.hostileEntityIDs),
    currentRoomCacheItemID: toInt(currentRoomEntry.cacheItemID, 0),
    currentRoomExtractionNodeItemIDs: listUniquePositiveInts(currentRoomEntry.extractionNodeItemIDs),
    currentRoomSceneryVisualEntityIDs: listUniquePositiveInts(currentRoomEntry.sceneryVisualEntityIDs),
    currentRoomSceneryProbeEntityID: toInt(currentRoomEntry.sceneryProbeEntityID, 0),
    currentRoomEnvironmentalObjectItemIDs: listUniquePositiveInts(currentRoomEntry.environmentalObjectItemIDs),
    currentRoomConduitItemID: toInt(currentRoomEntry.conduitItemID, 0),
    currentRoomOriginMarkerItemID: toInt(currentRoomEntry.originMarkerItemID, 0),
    currentRoomOriginPosition: getObjectPosition(currentRoomEntry.roomOriginPosition),
    finalExitAvailable:
      mergedRoomState.finalExitAvailable === true ||
      (currentRoomEntry.objectiveComplete === true && isFinalRoomIndex(ports, source || contentProfile, currentRoomIndex)),
    finalExitAvailableOnCompletion: mergedRoomState.finalExitAvailableOnCompletion !== false,
    placeholderSingleRoomMode: mergedRoomState.placeholderSingleRoomMode === true,
    roomStatesByIndex,
  };
}

function getPlaceholderRoomEntry(ports, source, roomIndex = null) {
  const {
    cloneValue,
  } = ports;
  const roomState = buildPlaceholderRoomState(ports, source);
  const resolvedRoomIndex = clampRoomIndex(ports,
    roomIndex == null ? roomState.currentRoomIndex : roomIndex,
    roomState.implementedRooms,
  );
  const roomEntry = roomState.roomStatesByIndex[String(resolvedRoomIndex)] ||
    buildPlaceholderRoomEntry(ports, source, resolvedRoomIndex);
  return isAbyssalPocketMutationBatchActive(ports, source)
    ? { ...roomEntry }
    : cloneValue(roomEntry);
}

function hasPrewarmedPlaceholderRoomContent(ports, roomEntry) {
  if (!roomEntry || typeof roomEntry !== "object") {
    return false;
  }
  return toInt(roomEntry.prewarmedAtMs, 0) > 0 ||
    toInt(roomEntry.originMarkerItemID, 0) > 0 ||
    toInt(roomEntry.conduitItemID, 0) > 0 ||
    listUniquePositiveInts(roomEntry.hostileEntityIDs).length > 0 ||
    listUniquePositiveInts(roomEntry.extractionNodeItemIDs).length > 0 ||
    listUniquePositiveInts(roomEntry.sceneryVisualEntityIDs).length > 0 ||
    toInt(roomEntry.sceneryProbeEntityID, 0) > 0 ||
    listUniquePositiveInts(roomEntry.environmentalObjectItemIDs).length > 0;
}

function setPlaceholderRoomEntry(ports, source, roomIndex, nextEntry, roomStateOverrides = {}) {
  const {
    cloneValue,
  } = ports;
  const roomState = buildPlaceholderRoomState(ports, source, roomStateOverrides);
  const resolvedRoomIndex = clampRoomIndex(ports, roomIndex, roomState.implementedRooms);
  const roomStatesByIndex = isAbyssalPocketMutationBatchActive(ports, source)
    ? { ...roomState.roomStatesByIndex }
    : cloneValue(roomState.roomStatesByIndex) || {};
  roomStatesByIndex[String(resolvedRoomIndex)] = buildPlaceholderRoomEntry(ports,
    source,
    resolvedRoomIndex,
    nextEntry,
  );
  return buildPlaceholderRoomState(ports, source, {
    ...(isAbyssalPocketMutationBatchActive(ports, source)
      ? roomStateOverrides
      : cloneValue(roomStateOverrides)),
    ...roomState,
    roomStatesByIndex,
  });
}

function buildPocketStateForCurrentRoom(ports, pocketState, roomState = null) {
  const {
    cloneValue,
  } = ports;
  const nextRoomState = roomState
    ? buildPlaceholderRoomState(ports, pocketState, roomState)
    : buildPlaceholderRoomState(ports, pocketState);
  const currentRoomEntry = getPlaceholderRoomEntry(ports,
    {
      ...(isAbyssalPocketMutationBatchActive(ports, pocketState)
        ? pocketState
        : cloneValue(pocketState)),
      roomState: nextRoomState,
    },
    nextRoomState.currentRoomIndex,
  );
  return {
    ...(isAbyssalPocketMutationBatchActive(ports, pocketState)
      ? pocketState
      : cloneValue(pocketState)),
    pocketPosition: getObjectPosition(currentRoomEntry.roomOriginPosition) ||
      getObjectPosition(pocketState && pocketState.pocketPosition),
    shipSpawnState: cloneValue(currentRoomEntry.shipSpawnState) ||
      cloneValue(pocketState && pocketState.shipSpawnState),
    hostileEntityIDs: listUniquePositiveInts(currentRoomEntry.hostileEntityIDs),
    objectiveComplete: currentRoomEntry.objectiveComplete === true,
    objectiveCompletedAtMs: toInt(currentRoomEntry.objectiveCompletedAtMs, 0),
    originMarkerItemID: toInt(currentRoomEntry.originMarkerItemID, 0),
    exitMarkerItemID: toInt(currentRoomEntry.conduitItemID, 0),
    environmentalObjectItemIDs: listUniquePositiveInts(currentRoomEntry.environmentalObjectItemIDs),
    rewardState: currentRoomEntry.cacheItemID > 0 ||
      currentRoomEntry.cacheStructureItemID > 0 ||
      currentRoomEntry.cacheLootContainerItemID > 0 ||
      currentRoomEntry.cacheSpawnedAtMs > 0 ||
      currentRoomEntry.suppressedReason ||
      currentRoomEntry.unavailableReason
      ? {
        cacheItemID: toInt(currentRoomEntry.cacheItemID, 0),
        cacheStructureItemID: toInt(currentRoomEntry.cacheStructureItemID, 0),
        cacheLootContainerItemID: toInt(currentRoomEntry.cacheLootContainerItemID, 0),
        cacheRewardMaterialized: currentRoomEntry.cacheRewardMaterialized === true,
        cacheSpawnedAtMs: toInt(currentRoomEntry.cacheSpawnedAtMs, 0),
        cacheLifecycleState: normalizeText(currentRoomEntry.cacheLifecycleState, ""),
        unavailableReason: normalizeText(currentRoomEntry.unavailableReason, ""),
        suppressedReason: normalizeText(currentRoomEntry.suppressedReason, ""),
        rewardTypeID: toInt(currentRoomEntry.rewardTypeID, 0),
        rewardQuantity: toInt(currentRoomEntry.rewardQuantity, 0),
        contentsGranted: currentRoomEntry.contentsGranted === true,
      }
      : null,
    sceneryVisualArtifactCount: listUniquePositiveInts(currentRoomEntry.sceneryVisualEntityIDs).length,
    roomState: nextRoomState,
  };
}

function getTimerRemainingMs(ports, pocketState, deps = ports.getDependencies()) {
  const {
    calculateAbyssalRemainingDuration,
  } = ports;
  return calculateAbyssalRemainingDuration({
    nowMs: toInt(deps.now(), 0),
    deadlineAtMs: toInt(
      pocketState && pocketState.timerState && pocketState.timerState.expiresAtMs,
      0,
    ),
  });
}

function buildRoomLogContext(ports, pocketState, deps = ports.getDependencies(), extra = {}) {
  const {
    getContentProfile,
  } = ports;
  const roomState = buildPlaceholderRoomState(ports, pocketState);
  const currentRoomEntry = getPlaceholderRoomEntry(ports, pocketState, roomState.currentRoomIndex);
  const contentProfile = getContentProfile(pocketState) || {};
  return {
    characterID: toInt(pocketState && pocketState.characterID, 0),
    shipID: toInt(pocketState && pocketState.shipID, 0),
    filamentTypeID: toInt(contentProfile && contentProfile.filamentTypeID, 0),
    filamentName: normalizeText(contentProfile && contentProfile.filamentName, ""),
    tier: toInt(contentProfile && contentProfile.tier, 0),
    weather: normalizeText(contentProfile && contentProfile.weatherType, ""),
    roomIndex: toInt(roomState.currentRoomIndex, 1),
    totalRooms: toInt(roomState.implementedRooms, 1),
    roomOrigin: formatVectorForLog(currentRoomEntry.roomOriginPosition),
    finalShip: formatVectorForLog(
      currentRoomEntry && currentRoomEntry.shipSpawnState && currentRoomEntry.shipSpawnState.position,
    ),
    hostileCount: listUniquePositiveInts(currentRoomEntry.hostileEntityIDs).length,
    cacheID: toInt(currentRoomEntry.cacheItemID, 0),
    conduitID: toInt(currentRoomEntry.conduitItemID, 0),
    encounterProfileID: normalizeText(currentRoomEntry.encounterProfileID, ""),
    timerRemainingMs: getTimerRemainingMs(ports, pocketState, deps),
    ...extra,
  };
}

function isPocketObjectiveComplete(ports, pocketState) {
  return pocketState && pocketState.objectiveComplete === true;
}

function buildAbyssalRoomObjectivePolicyInput(ports, pocketState) {
  const {
    hasFailedTimeoutOutcome,
  } = ports;
  const roomState = buildPlaceholderRoomState(ports, pocketState);
  const currentRoomEntry = getPlaceholderRoomEntry(ports,
    pocketState,
    roomState.currentRoomIndex,
  );
  return {
    failedTimeout: hasFailedTimeoutOutcome(pocketState),
    npcActivationDegraded: normalizeText(
      currentRoomEntry && currentRoomEntry.npcControllerActivationState,
      "",
    ) === "degraded",
    roomEncounterSpawnFailed: Boolean(
      currentRoomEntry && currentRoomEntry.encounterSpawnFailed === true,
    ),
    runEncounterSpawnFailed: Boolean(
      pocketState && pocketState.encounterState &&
        pocketState.encounterState.encounterSpawnFailed === true,
    ),
    objectiveComplete: isPocketObjectiveComplete(ports, pocketState),
    allowDebugExit: Boolean(pocketState && pocketState.allowDebugExit === true),
  };
}

function buildAbyssalRoomProgressionPolicyInput(ports, pocketState) {
  const {
    hasFailedTimeoutOutcome,
    hasTerminalFailureOutcome,
  } = ports;
  const roomState = buildPlaceholderRoomState(ports, pocketState);
  const currentRoomEntry = getPlaceholderRoomEntry(ports,
    pocketState,
    roomState.currentRoomIndex,
  );
  return {
    currentRoomIndex: roomState.currentRoomIndex,
    roomCount: roomState.implementedRooms,
    failedTimeout: hasFailedTimeoutOutcome(pocketState),
    finalExitAvailable: roomState.finalExitAvailable === true,
    allowDebugExit: Boolean(pocketState && pocketState.allowDebugExit === true),
    npcActivationDegraded: normalizeText(
      currentRoomEntry && currentRoomEntry.npcControllerActivationState,
      "",
    ) === "degraded",
    terminalFailure: hasTerminalFailureOutcome(pocketState),
  };
}

function canExitPlaceholderPocket(ports, pocketState) {
  const {
    evaluateAbyssalRoomObjectiveEligibility,
  } = ports;
  return evaluateAbyssalRoomObjectiveEligibility(
    buildAbyssalRoomObjectivePolicyInput(ports, pocketState),
  ).allowed;
}

function shouldUseFinalExitConduit(ports, pocketState) {
  const {
    resolveAbyssalRoomProgression,
  } = ports;
  return resolveAbyssalRoomProgression(
    buildAbyssalRoomProgressionPolicyInput(ports, pocketState),
  ).activationMode === "final_exit";
}

function createAbyssalRoomStateModel(ports) {
  return {
    getRoomProfile: getRoomProfile.bind(null, ports),
    getRoomEncounterProfilesByIndex: getRoomEncounterProfilesByIndex.bind(null, ports),
    listActiveAbyssalRoomNpcIDs: listActiveAbyssalRoomNpcIDs.bind(null, ports),
    clampRoomIndex: clampRoomIndex.bind(null, ports),
    getRoomOffsetVectors: getRoomOffsetVectors.bind(null, ports),
    getRoomOffsetForIndex: getRoomOffsetForIndex.bind(null, ports),
    getImplementedRoomCount: getImplementedRoomCount.bind(null, ports),
    getRetailTargetRoomCount: getRetailTargetRoomCount.bind(null, ports),
    getRoomOriginLabel: getRoomOriginLabel.bind(null, ports),
    getTransferConduitLabel: getTransferConduitLabel.bind(null, ports),
    getFinalExitConduitLabel: getFinalExitConduitLabel.bind(null, ports),
    isFinalRoomIndex: isFinalRoomIndex.bind(null, ports),
    resolveRoomOriginPosition: resolveRoomOriginPosition.bind(null, ports),
    buildRoomShipSpawnState: buildRoomShipSpawnState.bind(null, ports),
    buildRoomConduitState: buildRoomConduitState.bind(null, ports),
    buildRoomLateralDirection: buildRoomLateralDirection.bind(null, ports),
    buildRoomOffsetFromConduitState: buildRoomOffsetFromConduitState.bind(null, ports),
    buildPlaceholderRoomEntry: buildPlaceholderRoomEntry.bind(null, ports),
    isAbyssalPocketMutationBatchActive: isAbyssalPocketMutationBatchActive.bind(null, ports),
    buildPlaceholderRoomState: buildPlaceholderRoomState.bind(null, ports),
    getPlaceholderRoomEntry: getPlaceholderRoomEntry.bind(null, ports),
    hasPrewarmedPlaceholderRoomContent: hasPrewarmedPlaceholderRoomContent.bind(null, ports),
    setPlaceholderRoomEntry: setPlaceholderRoomEntry.bind(null, ports),
    buildPocketStateForCurrentRoom: buildPocketStateForCurrentRoom.bind(null, ports),
    getTimerRemainingMs: getTimerRemainingMs.bind(null, ports),
    buildRoomLogContext: buildRoomLogContext.bind(null, ports),
    isPocketObjectiveComplete: isPocketObjectiveComplete.bind(null, ports),
    buildAbyssalRoomObjectivePolicyInput: buildAbyssalRoomObjectivePolicyInput.bind(null, ports),
    buildAbyssalRoomProgressionPolicyInput: buildAbyssalRoomProgressionPolicyInput.bind(null, ports),
    canExitPlaceholderPocket: canExitPlaceholderPocket.bind(null, ports),
    shouldUseFinalExitConduit: shouldUseFinalExitConduit.bind(null, ports),
  };
}

module.exports = { createAbyssalRoomStateModel };
