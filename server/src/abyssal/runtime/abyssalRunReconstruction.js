"use strict";

const { normalizeText } = require("../domain/abyssalValueUtils");

// Rebuild live identity first; merge saved lifecycle evidence without rerolling content.
function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function readRunReconstructionEvidence(ports, work) {
  const {
    ABYSSAL_RUNTIME_STATE_SCHEMA_VERSION, cloneValue,
  } = ports;
  const {
    instance,
  } = work;
  const metadata = instance && instance.metadata && typeof instance.metadata === "object"
    ? instance.metadata
    : {};
  const persistedRuntimeState =
    instance &&
    instance.environmentState &&
    instance.environmentState.abyssalRuntimeState &&
    typeof instance.environmentState.abyssalRuntimeState === "object"
      ? instance.environmentState.abyssalRuntimeState
      : null;
  const persistedPocketState =
    persistedRuntimeState &&
    toInt(persistedRuntimeState.schemaVersion, 0) ===
      ABYSSAL_RUNTIME_STATE_SCHEMA_VERSION &&
    persistedRuntimeState.pocketState &&
    typeof persistedRuntimeState.pocketState === "object"
      ? cloneValue(persistedRuntimeState.pocketState)
      : null;
  Object.assign(work, { metadata, persistedPocketState });
}

function resolveReconstructionPlacement(ports, work) {
  const {
    cloneValue, getObjectPosition, normalizeVector,
  } = ports;
  const {
    instance, options, metadata,
  } = work;
  const storedShipSpawnState =
    metadata.shipSpawnState && typeof metadata.shipSpawnState === "object"
      ? cloneValue(metadata.shipSpawnState)
      : null;
  const pocketPosition =
    getObjectPosition(instance && instance.position) ||
    getObjectPosition(metadata.pocketPosition) ||
    getObjectPosition(storedShipSpawnState) ||
    normalizeVector(options.pocketPosition || options.shipSpawnState || { x: 0, y: 0, z: 0 });
  const shipSpawnState = storedShipSpawnState || cloneValue(options.shipSpawnState) || {
    systemID: toInt(instance && instance.solarSystemID, 0),
    position: pocketPosition,
    velocity: { x: 0, y: 0, z: 0 },
    direction: { x: 1, y: 0, z: 0 },
    targetPoint: pocketPosition,
    mode: "STOP",
    speedFraction: 0,
  };
  Object.assign(work, { pocketPosition, shipSpawnState });
}

function resolveReconstructionContent(ports, work) {
  const {
    cloneValue, getContentProfile, rehydratePersistedAbyssalContentProfile,
    isPersistedAbyssalContentProfileReference, buildAbyssalWeatherState,
  } = ports;
  const {
    traceState, metadata, persistedPocketState,
  } = work;
  const traceContentProfile = getContentProfile(traceState);
  const contentProfile = metadata.contentProfile && typeof metadata.contentProfile === "object"
    ? rehydratePersistedAbyssalContentProfile(
        metadata.contentProfile,
        traceContentProfile,
      )
    : traceContentProfile;
  if (
    persistedPocketState &&
    isPersistedAbyssalContentProfileReference(persistedPocketState.contentProfile)
  ) {
    persistedPocketState.contentProfile = rehydratePersistedAbyssalContentProfile(
      persistedPocketState.contentProfile,
      contentProfile,
    );
  }
  const weatherState = metadata.weatherState && typeof metadata.weatherState === "object"
    ? cloneValue(metadata.weatherState)
    : buildAbyssalWeatherState(contentProfile, {
      traceItemID: toInt(
        metadata.sourceTraceItemID,
        toInt(traceState && traceState.traceItemID, 0),
      ),
      selectionSeed: toInt(
        metadata.sourceTraceItemID,
        toInt(traceState && traceState.traceItemID, 0),
      ),
    });
  Object.assign(work, { contentProfile, weatherState });
}

function resolveReconstructionLayouts(ports, work) {
  const {
    normalizeT0DarkLayoutSelectionState, normalizeLowerText,
    normalizeAbyssalBaseRoomLayoutSelectionState,
  } = ports;
  const {
    instance, metadata, persistedPocketState, contentProfile,
  } = work;
  const layoutSelectionState = normalizeT0DarkLayoutSelectionState({
    contentProfile,
    layoutSelectionSchemaVersion: metadata.layoutSelectionSchemaVersion,
    layoutCatalogVersion: metadata.layoutCatalogVersion,
    layoutSelectionModel: metadata.layoutSelectionModel,
    layoutSelectionSeed: metadata.layoutSelectionSeed,
    selectedLayoutSetID: metadata.selectedLayoutSetID,
    selectedRoomLayoutIDs: metadata.selectedRoomLayoutIDs,
    layoutSelectionSource: metadata.layoutSelectionSource,
    layoutSelectionWeightsSummary: metadata.layoutSelectionWeightsSummary,
  }, {
    legacySource: "legacy-migration",
  });
  const baseRoomLayoutSelectionOptions = {
    runID: toInt(instance && instance.instanceID, 0),
    filamentTypeID: toInt(contentProfile && contentProfile.filamentTypeID, 0),
    tier: toInt(contentProfile && contentProfile.tier, -1),
    weatherType: normalizeLowerText(contentProfile && contentProfile.weatherType, ""),
  };
  const baseRoomLayoutSelectionSource =
    metadata.selectedBaseRoomLayoutIDs &&
      typeof metadata.selectedBaseRoomLayoutIDs === "object"
      ? metadata
      : persistedPocketState &&
          persistedPocketState.selectedBaseRoomLayoutIDs &&
          typeof persistedPocketState.selectedBaseRoomLayoutIDs === "object"
        ? persistedPocketState
        : null;
  const baseRoomLayoutSelectionState = normalizeAbyssalBaseRoomLayoutSelectionState(
    baseRoomLayoutSelectionSource || {},
    baseRoomLayoutSelectionOptions,
  );
  Object.assign(work, { layoutSelectionState, baseRoomLayoutSelectionOptions, baseRoomLayoutSelectionState });
}

function buildReconstructedRunIdentity(ports, work) {
  const {
    cloneValue, ABYSSAL_PARTICIPANT_ROSTER_SCHEMA_VERSION, normalizeAbyssalParticipantRoster,
    listUniquePositiveInts,
  } = ports;
  const {
    instance, traceState, metadata, persistedPocketState, contentProfile,
  } = work;
  return {
    instanceID: toInt(instance && instance.instanceID, 0),
    contentID: normalizeText(
      metadata.contentID,
      normalizeText(persistedPocketState && persistedPocketState.contentID, ""),
    ),
    traceItemID: toInt(
      metadata.sourceTraceItemID,
      toInt(traceState && traceState.traceItemID, 0),
    ),
    characterID: toInt(
      metadata.characterID,
      toInt(traceState && traceState.characterID, 0),
    ),
    shipID: toInt(
      metadata.shipID,
      toInt(traceState && traceState.shipID, 0),
    ),
    shipClass: normalizeText(
      metadata.shipClass,
      normalizeText(traceState && traceState.shipClass, normalizeText(contentProfile && contentProfile.hullMode, "")),
    ),
    requiredFilaments: Math.max(
      1,
      toInt(
        metadata.requiredFilaments,
        toInt(traceState && traceState.requiredFilaments, toInt(contentProfile && contentProfile.requiredFilaments, 1)),
      ),
    ),
    maxShips: Math.max(
      1,
      toInt(
        metadata.maxShips,
        toInt(traceState && traceState.maxShips, toInt(contentProfile && contentProfile.maxShips, 1)),
      ),
    ),
    fleetID: toInt(metadata.fleetID, toInt(traceState && traceState.fleetID, 0)),
    participantRosterSchemaVersion: ABYSSAL_PARTICIPANT_ROSTER_SCHEMA_VERSION,
    participantRoster: normalizeAbyssalParticipantRoster({
      ...cloneValue(traceState || {}),
      ...cloneValue(metadata || {}),
      characterID: toInt(metadata.characterID, toInt(traceState && traceState.characterID, 0)),
      shipID: toInt(metadata.shipID, toInt(traceState && traceState.shipID, 0)),
    }),
    eligibleParticipantCharacterIDs: listUniquePositiveInts(
      metadata.eligibleParticipantCharacterIDs ||
        traceState && traceState.eligibleParticipantCharacterIDs,
    ),
    rewardBeneficiaryCharacterID: toInt(
      metadata.rewardBeneficiaryCharacterID,
      toInt(traceState && traceState.rewardBeneficiaryCharacterID, toInt(traceState && traceState.characterID, 0)),
    ),
  };
}

function buildReconstructedRunLocation(ports, work) {
  const {
    cloneValue, getObjectPosition, normalizeDirection, toReal,
  } = ports;
  const {
    instance, traceState, options, metadata,
  } = work;
  return {
    solarSystemID: toInt(
      instance && instance.solarSystemID,
      toInt(traceState && traceState.solarSystemID, 0),
    ),
    abyssalLocationID: toInt(metadata.abyssalLocationID, 0),
    abyssalSlotID:
      metadata.abyssalSlotID === undefined
        ? undefined
        : toInt(metadata.abyssalSlotID, -1),
    abyssalSpatialOrigin: getObjectPosition(metadata.abyssalSpatialOrigin),
    abyssalSpatialReservation:
      metadata.abyssalSpatialReservation &&
      typeof metadata.abyssalSpatialReservation === "object"
        ? cloneValue(metadata.abyssalSpatialReservation)
        : undefined,
    activatedAtMs: toInt(
      metadata.activatedAtMs,
      toInt(options.activatedAtMs, 0),
    ),
    sourceTraceItemID: toInt(
      metadata.sourceTraceItemID,
      toInt(traceState && traceState.traceItemID, 0),
    ),
    sourceSolarSystemID: toInt(
      metadata.sourceSolarSystemID,
      toInt(traceState && traceState.solarSystemID, 0),
    ),
    sourceLocationID: toInt(
      metadata.sourceLocationID,
      toInt(traceState && traceState.solarSystemID, 0),
    ),
    sourceTracePosition: getObjectPosition(metadata.sourceTracePosition),
    sourceShipPosition: getObjectPosition(metadata.sourceShipPosition),
    sourceShipDirection: normalizeDirection(metadata.sourceShipDirection, {
      x: 1,
      y: 0,
      z: 0,
    }),
    sourceBallID: toInt(metadata.sourceBallID, 0),
    sourceBubbleID: toInt(metadata.sourceBubbleID, 0),
    sourcePublicGridClusterKey: normalizeText(metadata.sourcePublicGridClusterKey, "") || null,
    sourceSceneKey: normalizeText(metadata.sourceSceneKey, normalizeText(traceState && traceState.sourceSceneKey, "")),
    sourceShipRadius: toReal(metadata.sourceShipRadius, toReal(traceState && traceState.sourceShipRadius, 0)),
    traceProfileID: normalizeText(metadata.traceProfileID, normalizeText(traceState && traceState.traceProfileID, "")),
    securityPolicy:
      metadata.securityPolicy && typeof metadata.securityPolicy === "object"
        ? cloneValue(metadata.securityPolicy)
        : cloneValue(traceState && traceState.securityPolicy),
    suspectOnReturn: Boolean(
      metadata.suspectOnReturn === true ||
      traceState && traceState.suspectOnReturn === true,
    ),
    suspectReturnState:
      metadata.suspectReturnState && typeof metadata.suspectReturnState === "object"
        ? cloneValue(metadata.suspectReturnState)
        : cloneValue(traceState && traceState.suspectReturnState),
  };
}

function buildReconstructedRoomState(ports, work) {
  const {
    cloneValue, getObjectPosition, buildPocketSiteKey, buildPlaceholderRoomState,
    getNpcRuntimePolicy, PLACEHOLDER_POCKET_MODE, PLACEHOLDER_POCKET_ISOLATION,
    normalizeAbyssalSceneMode,
  } = ports;
  const {
    instance, traceState, metadata, pocketPosition, shipSpawnState, contentProfile, weatherState,
    layoutSelectionState, baseRoomLayoutSelectionState,
  } = work;
  return {
    contentProfile,
    weatherState,
    ...cloneValue(layoutSelectionState),
    ...(baseRoomLayoutSelectionState
      ? cloneValue(baseRoomLayoutSelectionState)
      : {}),
    templateID: normalizeText(instance && instance.templateID, ""),
    siteKey: normalizeText(instance && instance.siteKey, buildPocketSiteKey(traceState)),
    pocketPosition,
    roomOneOriginPosition: getObjectPosition(metadata.roomOneOriginPosition) || pocketPosition,
    shipSpawnState,
    roomState: metadata.roomState && typeof metadata.roomState === "object"
      ? cloneValue(metadata.roomState)
      : buildPlaceholderRoomState(contentProfile),
    npcRuntimePolicy: metadata.npcRuntimePolicy && typeof metadata.npcRuntimePolicy === "object"
      ? cloneValue(metadata.npcRuntimePolicy)
      : getNpcRuntimePolicy(contentProfile),
    originMarkerItemID: toInt(metadata.originMarkerItemID, 0),
    exitMarkerItemID: toInt(metadata.exitMarkerItemID, 0),
    placeholderMode: normalizeText(metadata.placeholderMode, PLACEHOLDER_POCKET_MODE),
    isolationMode: normalizeText(metadata.isolationMode, PLACEHOLDER_POCKET_ISOLATION),
    sceneMode: normalizeAbyssalSceneMode(metadata.sceneMode),
    sceneKey: normalizeText(metadata.sceneKey, ""),
    sceneModeSource: normalizeText(metadata.sceneModeSource, ""),
    instance: cloneValue(instance),
  };
}

function mergeReconstructedRunEvidence(ports, work) {
  const {
    cloneValue, normalizeAbyssalBaseRoomLayoutSelectionState, buildPocketStateForCurrentRoom,
  } = ports;
  const {
    instance, traceState, metadata, persistedPocketState, baseRoomLayoutSelectionOptions,
    rebuiltState,
  } = work;
  if (!persistedPocketState) {
    return rebuiltState;
  }
  const mergedPocketState = {
    ...rebuiltState,
    ...persistedPocketState,
  };
  const recoveredBaseRoomLayoutSelectionState =
    mergedPocketState.selectedBaseRoomLayoutIDs &&
      typeof mergedPocketState.selectedBaseRoomLayoutIDs === "object"
      ? normalizeAbyssalBaseRoomLayoutSelectionState(
          mergedPocketState,
          baseRoomLayoutSelectionOptions,
        )
      : null;
  return buildPocketStateForCurrentRoom({
    ...mergedPocketState,
    ...(recoveredBaseRoomLayoutSelectionState
      ? cloneValue(recoveredBaseRoomLayoutSelectionState)
      : {}),
    // Persistent run data may not redirect ownership to a different dungeon
    // row; the live instance remains the identity authority.
    instanceID: toInt(instance && instance.instanceID, 0),
    traceItemID: toInt(
      metadata.sourceTraceItemID,
      toInt(traceState && traceState.traceItemID, rebuiltState.traceItemID),
    ),
    sourceTraceItemID: toInt(
      metadata.sourceTraceItemID,
      toInt(traceState && traceState.traceItemID, rebuiltState.sourceTraceItemID),
    ),
    characterID: toInt(
      metadata.characterID,
      toInt(traceState && traceState.characterID, rebuiltState.characterID),
    ),
    shipID: toInt(
      metadata.shipID,
      toInt(traceState && traceState.shipID, rebuiltState.shipID),
    ),
    shipClass: rebuiltState.shipClass,
    requiredFilaments: rebuiltState.requiredFilaments,
    solarSystemID: toInt(instance && instance.solarSystemID, rebuiltState.solarSystemID),
    sourceSolarSystemID: toInt(
      metadata.sourceSolarSystemID,
      rebuiltState.sourceSolarSystemID,
    ),
    sourceLocationID: toInt(metadata.sourceLocationID, rebuiltState.sourceLocationID),
    templateID: normalizeText(instance && instance.templateID, rebuiltState.templateID),
    siteKey: normalizeText(instance && instance.siteKey, rebuiltState.siteKey),
    instance: cloneValue(instance),
  });
}

function buildPocketStateFromInstance(ports, instance, traceState, options = {}) {
  const work = { instance, traceState, options };
  readRunReconstructionEvidence(ports, work);
  resolveReconstructionPlacement(ports, work);
  resolveReconstructionContent(ports, work);
  resolveReconstructionLayouts(ports, work);
  work.rebuiltState = ports.buildPocketStateForCurrentRoom({
    ...buildReconstructedRunIdentity(ports, work),
    ...buildReconstructedRunLocation(ports, work),
    ...buildReconstructedRoomState(ports, work),
  });
  return mergeReconstructedRunEvidence(ports, work);
}

function createAbyssalRunReconstruction(ports) {
  return { buildPocketStateFromInstance: buildPocketStateFromInstance.bind(null, ports) };
}

module.exports = { createAbyssalRunReconstruction };
