"use strict";
const { toInt, normalizeText, listUniquePositiveInts, getObjectPosition } = require("../domain/abyssalRuntimeValues");

function buildAbyssalSceneryVisualStatus(ports, pocketState = null, deps = ports.getDependencies()) {
  const {
    isAbyssalSceneryVisualsRequested,
    buildPlaceholderRoomState,
    getContentProfile,
    getAbyssalSceneryProfileForRoomIndex,
    resolveAbyssalSceneryPolicy,
    SCENERY_POLICY_AUTHORITATIVE,
    buildAbyssalSceneryProfileSummary,
    getPlaceholderRoomEntry,
    ABYSSAL_SCENERY_GUARD_STATUS,
    isSupportedCalmSceneryContentProfile,
  } = ports;
  const requested = isAbyssalSceneryVisualsRequested(deps);
  const roomState = pocketState ? buildPlaceholderRoomState(pocketState) : null;
  const currentRoomIndex = toInt(roomState && roomState.currentRoomIndex, 1);
  const contentProfile = pocketState ? getContentProfile(pocketState) || {} : {};
  const selectedProfile = getAbyssalSceneryProfileForRoomIndex(
    pocketState || contentProfile,
    currentRoomIndex,
  );
  const sceneryPolicy = resolveAbyssalSceneryPolicy(selectedProfile);
  const authoritative = sceneryPolicy === SCENERY_POLICY_AUTHORITATIVE;
  const materializationEnabled = requested || authoritative;
  const profileSummary = buildAbyssalSceneryProfileSummary(selectedProfile, deps);
  const currentRoomEntry =
    pocketState && roomState
      ? getPlaceholderRoomEntry(pocketState, roomState.currentRoomIndex)
      : null;
  let blockReason = materializationEnabled ? "NOT_IN_ACTIVE_RUN" : "ENV_DISABLED";
  if (materializationEnabled && pocketState) {
    if (!ABYSSAL_SCENERY_GUARD_STATUS.active) {
      blockReason = "GUARDS_INACTIVE";
    } else if (!isSupportedCalmSceneryContentProfile(contentProfile)) {
      blockReason = "PROFILE_NOT_APPLICABLE";
    } else if (!getAbyssalSceneryProfileForRoomIndex(pocketState, currentRoomIndex)) {
      blockReason = "ROOM_NOT_APPLICABLE";
    } else {
      blockReason = normalizeText(currentRoomEntry && currentRoomEntry.sceneryVisualBlockReason, "none");
    }
  }
  const artifactEntityIDs = listUniquePositiveInts(currentRoomEntry && currentRoomEntry.sceneryVisualEntityIDs);
  const artifactTypeIDs = listUniquePositiveInts(currentRoomEntry && currentRoomEntry.sceneryVisualTypeIDs);
  return {
    requested,
    sceneryConfigEnabled: requested,
    enabled: materializationEnabled && ABYSSAL_SCENERY_GUARD_STATUS.active === true,
    authoritative,
    sceneryPolicy,
    layoutID: normalizeText(selectedProfile && selectedProfile.layoutID, ""),
    profileID: normalizeText(
      currentRoomEntry && currentRoomEntry.sceneryVisualProfileID,
      selectedProfile && selectedProfile.profileID,
    ),
    artifactCount: artifactEntityIDs.length,
    profileArtifactCount: profileSummary.artifactTypeIDs.length,
    artifactEntityIDs,
    artifactTypeIDs,
    artifactTypeNames: profileSummary.artifactTypeNames,
    profileTypeIDs: profileSummary.artifactTypeIDs,
    profileTypeNames: profileSummary.artifactTypeNames,
    structureDressingProfileID: normalizeText(
      selectedProfile && selectedProfile.structureDressingProfileID,
      "none",
    ),
    structureTypeID: profileSummary.structureTypeID,
    structureTypeName: profileSummary.structureTypeName,
    cloudTypeID: profileSummary.cloudTypeID,
    cloudTypeName: profileSummary.cloudTypeName,
    cloudTypeIDs: profileSummary.cloudTypeIDs,
    cloudTypeNames: profileSummary.cloudTypeNames,
    cloudRadiusOverrideMeters: profileSummary.cloudRadiusOverrideMeters,
    blockReason: normalizeText(blockReason, "none"),
    guardsActive: ABYSSAL_SCENERY_GUARD_STATUS.active === true,
  };
}

function buildAbyssalSceneryProbeStatus(ports, pocketState = null, deps = ports.getDependencies()) {
  const {
    isAbyssalSceneryVisualsRequested,
    buildPlaceholderRoomState,
    getPlaceholderRoomEntry,
    getContentProfile,
    ABYSSAL_SCENERY_GUARD_STATUS,
    isSupportedCalmSceneryContentProfile,
    resolveAbyssalSceneryProbeCandidate,
    buildAbyssalSceneryProbeCatalogueEntry,
    getAbyssalSceneryProbeCandidateIndex,
    ABYSSAL_SCENERY_PROBE_PROFILE,
    listAbyssalSceneryProbeCandidateKeys,
  } = ports;
  const requested = isAbyssalSceneryVisualsRequested(deps);
  const roomState = pocketState ? buildPlaceholderRoomState(pocketState) : null;
  const currentRoomEntry =
    pocketState && roomState
      ? getPlaceholderRoomEntry(pocketState, roomState.currentRoomIndex)
      : null;
  const contentProfile = pocketState ? getContentProfile(pocketState) || {} : {};
  const probeEntityID = toInt(currentRoomEntry && currentRoomEntry.sceneryProbeEntityID, 0);
  let blockReason = requested ? "NOT_IN_ACTIVE_RUN" : "ENV_DISABLED";
  if (requested && pocketState) {
    if (!ABYSSAL_SCENERY_GUARD_STATUS.active) {
      blockReason = "GUARDS_INACTIVE";
    } else if (!isSupportedCalmSceneryContentProfile(contentProfile)) {
      blockReason = "PROFILE_NOT_APPLICABLE";
    } else if (toInt(roomState && roomState.currentRoomIndex, 0) !== 1) {
      blockReason = "ROOM_NOT_APPLICABLE";
    } else {
      blockReason = normalizeText(currentRoomEntry && currentRoomEntry.sceneryProbeBlockReason, "none");
    }
  }
  const candidate = resolveAbyssalSceneryProbeCandidate(currentRoomEntry && currentRoomEntry.sceneryProbeCandidateKey);
  const catalogueEntry = candidate
    ? buildAbyssalSceneryProbeCatalogueEntry(candidate, deps)
    : null;
  const candidateKey = normalizeText(currentRoomEntry && currentRoomEntry.sceneryProbeCandidateKey, "none");
  const candidateIndex = getAbyssalSceneryProbeCandidateIndex(candidateKey);
  return {
    requested,
    active: probeEntityID > 0,
    profileID: normalizeText(
      currentRoomEntry && currentRoomEntry.sceneryProbeProfileID,
      ABYSSAL_SCENERY_PROBE_PROFILE.profileID,
    ),
    candidateKey,
    presetKey: normalizeText(currentRoomEntry && currentRoomEntry.sceneryProbePresetKey, "none"),
    entityID: probeEntityID,
    typeID: toInt(currentRoomEntry && currentRoomEntry.sceneryProbeTypeID, 0),
    typeName: normalizeText(currentRoomEntry && currentRoomEntry.sceneryProbeTypeName, "none"),
    position: getObjectPosition(currentRoomEntry && currentRoomEntry.sceneryProbePosition),
    previousEntityID: toInt(currentRoomEntry && currentRoomEntry.sceneryProbePreviousEntityID, 0),
    addBallsSent: currentRoomEntry && currentRoomEntry.sceneryProbeAddBallsSent === true,
    categoryKey: normalizeText(catalogueEntry && catalogueEntry.categoryKey, "none"),
    radiusMeters: catalogueEntry && Number.isFinite(Number(catalogueEntry.effectiveRadiusMeters))
      ? Number(catalogueEntry.effectiveRadiusMeters)
      : 0,
    radiusOverrideMeters: catalogueEntry && Number.isFinite(Number(catalogueEntry.radiusOverrideMeters))
      ? Number(catalogueEntry.radiusOverrideMeters)
      : 0,
    notes: normalizeText(catalogueEntry && catalogueEntry.notes, "none"),
    catalogueIndex: candidateIndex >= 0 ? candidateIndex + 1 : 0,
    catalogueSize: listAbyssalSceneryProbeCandidateKeys().length,
    guardsActive: ABYSSAL_SCENERY_GUARD_STATUS.active === true,
    blockReason: normalizeText(blockReason, "none"),
  };
}

function buildAbyssalRoomVisualStatus(ports, pocketState = null, deps = ports.getDependencies()) {
  const {
    getContentProfile,
    buildPlaceholderRoomState,
    resolveAbyssalEnvironmentRoomProfileForPocket,
    describeAbyssalEnvironmentSource,
    usesIsolatedAbyssalScene,
    ABYSSAL_ROOM_VISUAL_PROFILE,
    isAbyssalVisualFxContentProfile,
  } = ports;
  const requested = false;
  const contentProfile = pocketState ? getContentProfile(pocketState) || {} : {};
  const roomState = pocketState ? buildPlaceholderRoomState(pocketState) : null;
  const roomIndex = toInt(roomState && roomState.currentRoomIndex, 0);
  const environmentRoomProfile = pocketState
    ? resolveAbyssalEnvironmentRoomProfileForPocket(pocketState, roomIndex)
    : null;
  const fallbackGenerated =
    Boolean(environmentRoomProfile && environmentRoomProfile.fallbackGenerated === true);
  const environmentSource = describeAbyssalEnvironmentSource(environmentRoomProfile);
  let blockReason = environmentRoomProfile
    ? (usesIsolatedAbyssalScene(pocketState, deps) ? "NONE" : "ABYSSAL_ISOLATED_SCENE_REQUIRED")
    : ABYSSAL_ROOM_VISUAL_PROFILE.blockReason;
  if (requested && pocketState) {
    if (!isAbyssalVisualFxContentProfile(contentProfile)) {
      blockReason = "PROFILE_NOT_APPLICABLE";
    } else if (!environmentRoomProfile) {
      blockReason = "ENVIRONMENT_PROFILE_NOT_AUTHORED";
    }
  }
  return {
    requested,
    enabled: Boolean(environmentRoomProfile && usesIsolatedAbyssalScene(pocketState, deps)),
    profileAuthored: environmentSource === "authored",
    fallbackGenerated,
    environmentSource,
    profileID: normalizeText(
      environmentRoomProfile && environmentRoomProfile.profileID,
      ABYSSAL_ROOM_VISUAL_PROFILE.profileID,
    ),
    layoutVariant: normalizeText(environmentRoomProfile && environmentRoomProfile.layoutVariant, "none"),
    roomIndex,
    blockReason,
    sceneCubeResource: normalizeText(environmentRoomProfile && environmentRoomProfile.sceneCubeResource, "NOT_FOUND"),
    volumetricCloudResource: normalizeText(
      environmentRoomProfile && environmentRoomProfile.volumetricCloudResource,
      "NOT_FOUND",
    ),
    nearFieldResource: normalizeText(environmentRoomProfile && environmentRoomProfile.nearFieldResource, "NOT_FOUND"),
    lensFlareResource: normalizeText(environmentRoomProfile && environmentRoomProfile.lensFlareResource, "NOT_FOUND"),
    gradientResource: normalizeText(environmentRoomProfile && environmentRoomProfile.gradientResource, "NOT_APPLICABLE"),
    weatherObjectTypeID: toInt(environmentRoomProfile && environmentRoomProfile.weatherObjectTypeID, 0),
    transitionEffect: normalizeText(environmentRoomProfile && environmentRoomProfile.transitionEffect, "NOT_FOUND"),
    roomLayoutProfileID: normalizeText(environmentRoomProfile && environmentRoomProfile.roomLayoutProfileID, "NOT_AUTHORED"),
    skybox: normalizeText(
      environmentRoomProfile && environmentRoomProfile.sceneCubeResource,
      ABYSSAL_ROOM_VISUAL_PROFILE.skybox,
    ),
    perRoomSkybox: environmentRoomProfile
      ? (environmentSource === "procedural-factual-inputs" ? "PROCEDURAL_ROOM_PROFILE_SELECTED" : fallbackGenerated
        ? "FALLBACK_GENERATED_ROOM_PROFILE_SELECTED"
        : "AUTHORED_ROOM_PROFILE_SELECTED")
      : ABYSSAL_ROOM_VISUAL_PROFILE.perRoomSkybox,
    fog: normalizeText(
      environmentRoomProfile && environmentRoomProfile.nearFieldResource,
      ABYSSAL_ROOM_VISUAL_PROFILE.fog,
    ),
    colorGrading: normalizeText(
      environmentRoomProfile && environmentRoomProfile.gradientResource,
      environmentRoomProfile ? "NOT_APPLICABLE" : ABYSSAL_ROOM_VISUAL_PROFILE.colorGrading,
    ),
    backgroundLighting: ABYSSAL_ROOM_VISUAL_PROFILE.backgroundLighting,
    ambientClientEffects: ABYSSAL_ROOM_VISUAL_PROFILE.ambientClientEffects,
  };
}

function buildAbyssalRoomOneFxStatus(ports,
  pocketState = null,
  deps = ports.getDependencies(),
  options = {},
) {
  const {
    buildAbyssalRoomOneFxSelection,
    getAbyssalRoomOneClientFxState,
    buildPlaceholderRoomState,
    getContentProfile,
    isAbyssalVisualFxContentProfile,
  } = ports;
  const selection = buildAbyssalRoomOneFxSelection();
  const state = getAbyssalRoomOneClientFxState(pocketState);
  const roomState = pocketState ? buildPlaceholderRoomState(pocketState) : null;
  const contentProfile = pocketState ? getContentProfile(pocketState) || {} : {};
  let sendStatus = normalizeText(state.sendStatus, "");
  if (!sendStatus) {
    if (!pocketState) {
      sendStatus = "NOT_IN_ACTIVE_RUN";
    } else if (selection.enabled !== true) {
      sendStatus = "DISABLED";
    } else if (
      !isAbyssalVisualFxContentProfile(contentProfile) ||
      toInt(roomState && roomState.currentRoomIndex, 0) !== 1
    ) {
      sendStatus = "NOT_APPLICABLE";
    } else {
      sendStatus = "NOT_YET_ATTEMPTED";
    }
  }
  const defaultShipID =
    options.defaultShipID != null
      ? toInt(options.defaultShipID, 0)
      : toInt(pocketState && pocketState.shipID, 0);
  return {
    ...selection,
    sendStatus,
    sendErrorMsg: normalizeText(state.sendErrorMsg, "none"),
    sourceShipID: toInt(state.sourceShipID, defaultShipID),
    roomIndex: toInt(
      state.roomIndex,
      toInt(roomState && roomState.currentRoomIndex, 0),
    ),
    attemptedAtMs: toInt(state.attemptedAtMs, 0),
    sentAtMs: toInt(state.sentAtMs, 0),
  };
}

function createAbyssalVisualDiagnostics(ports) {
  return {
    buildAbyssalSceneryVisualStatus: buildAbyssalSceneryVisualStatus.bind(null, ports),
    buildAbyssalSceneryProbeStatus: buildAbyssalSceneryProbeStatus.bind(null, ports),
    buildAbyssalRoomVisualStatus: buildAbyssalRoomVisualStatus.bind(null, ports),
    buildAbyssalRoomOneFxStatus: buildAbyssalRoomOneFxStatus.bind(null, ports),
  };
}

module.exports = { createAbyssalVisualDiagnostics };
