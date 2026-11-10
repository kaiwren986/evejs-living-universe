"use strict";

const { normalizeText } = require("../domain/abyssalValueUtils");

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

// Room environment metadata and profile selection; caller-owned inputs only.
function buildEnvironmentalObjectCustomInfo({
  buildPlaceholderRoomState,
  ABYSSAL_ENVIRONMENTAL_OBJECT_ROLE,
  resolveAbyssalRoomEntityRole,
  clampRoomIndex,
  cloneValue,
  buildCapturedRetailIdentityState,
}, pocketState, options = {}) {
  const roomState = buildPlaceholderRoomState(pocketState);
  const definition = options.definition && typeof options.definition === "object"
    ? options.definition
    : {};
  return JSON.stringify({
    evejsAbyssalEnvironmentalObject: {
      role: ABYSSAL_ENVIRONMENTAL_OBJECT_ROLE,
      abyssalEntityRole: resolveAbyssalRoomEntityRole({
        sourceRole: options.sourceRole,
        typeID: options.typeID,
        effectKind: definition.effectKind,
        environmentalObject: true,
      }),
      abyssalDefinitionID: normalizeText(
        options.abyssalDefinitionID,
        normalizeText(options.profileID, normalizeText(definition.profileID, "")),
      ),
      instanceID: toInt(pocketState.instanceID, 0),
      traceItemID: toInt(pocketState.traceItemID, 0),
      characterID: toInt(pocketState.characterID, 0),
      shipID: toInt(pocketState.shipID, 0),
      solarSystemID: toInt(pocketState.solarSystemID, 0),
      roomIndex: clampRoomIndex(
        toInt(options.roomIndex, roomState.currentRoomIndex),
        roomState.implementedRooms,
      ),
      deliveryState: normalizeText(options.deliveryState, ""),
      transitionToken: toInt(options.transitionToken, 0),
      selectedRoomLayoutID: normalizeText(options.selectedRoomLayoutID, ""),
      roomOriginPosition: cloneValue(options.roomOriginPosition) || null,
      authoredLocalPosition: cloneValue(options.authoredLocalPosition) || null,
      worldPosition: cloneValue(options.worldPosition) || null,
      profileID: normalizeText(options.profileID, normalizeText(definition.profileID, "")),
      slot: Math.max(1, toInt(options.slot, 1)),
      effectKind: normalizeText(definition.effectKind, ""),
      presentationEnabled:
        options.presentationEnabled === true || definition.presentationEnabled === true,
      mechanicsEnabled: options.mechanicsEnabled === undefined
        ? definition.mechanicsEnabled === true
        : options.mechanicsEnabled === true,
      destructible: definition.destructible === true,
      mechanicsProfileID: normalizeText(definition.mechanicsProfileID, ""),
      presentationRadiusMeters: Number.isFinite(Number(definition.presentationRadiusMeters))
        ? Number(definition.presentationRadiusMeters)
        : 0,
      mechanicsRangeMeters: Number.isFinite(Number(definition.mechanicsRangeMeters))
        ? Number(definition.mechanicsRangeMeters)
        : Number.isFinite(Number(definition.radiusMeters))
          ? Number(definition.radiusMeters)
          : 0,
      activationDurationMs: toInt(definition.activationDurationMs, 0),
      dogmaEffectID: toInt(definition.dogmaEffectID, 0),
      targetTypeListID: toInt(definition.targetTypeListID, 0),
      resolvedTargetClasses: Array.isArray(definition.resolvedTargetClasses)
        ? [...definition.resolvedTargetClasses]
        : [],
      radiusMeters: Number.isFinite(Number(definition.radiusMeters))
        ? Number(definition.radiusMeters)
        : 0,
      perimeterRadius:
        Number.isFinite(Number(options.perimeterRadius)) &&
        Number(options.perimeterRadius) > 0
          ? Number(options.perimeterRadius)
          : Number.isFinite(Number(definition.perimeterRadius))
            ? Number(definition.perimeterRadius)
            : 0,
      perimeterLook: toInt(definition.perimeterLook, 0),
      dunObjectID: toInt(options.dunObjectID, 0),
      dunObjectNameID: options.dunObjectNameID == null ? null : toInt(options.dunObjectNameID, 0),
      objectiveTargetGroup: options.objectiveTargetGroup == null
        ? null
        : toInt(options.objectiveTargetGroup, 0),
      dunPosition: Array.isArray(options.dunPosition) ? cloneValue(options.dunPosition) : null,
      dunRotation: Array.isArray(options.dunRotation) ? cloneValue(options.dunRotation) : null,
      evidence: normalizeText(definition.evidence, ""),
      environmentProfileID: normalizeText(options.environmentProfileID, ""),
      layoutVariant: normalizeText(options.layoutVariant, ""),
      sceneCubeResource: normalizeText(options.sceneCubeResource, ""),
      volumetricCloudResource: normalizeText(options.volumetricCloudResource, ""),
      nearFieldResource: normalizeText(options.nearFieldResource, ""),
      lensFlareResource: normalizeText(options.lensFlareResource, ""),
      gradientResource: normalizeText(options.gradientResource, ""),
      transitionEffect: normalizeText(options.transitionEffect, ""),
      roomLayoutProfileID: normalizeText(options.roomLayoutProfileID, ""),
      capturedRetailObject: options.capturedRetailObject === true,
      ...buildCapturedRetailIdentityState(options.identity, pocketState.characterID),
      placeholderContent: options.capturedRetailObject !== true,
    },
  });
}

function readEnvironmentalObjectStateFromItem({
  parseCustomInfo,
  ABYSSAL_ENVIRONMENTAL_OBJECT_ROLE,
  cloneValue,
}, item) {
  if (!item) {
    return null;
  }
  const parsed = parseCustomInfo(item.customInfo);
  const rawState = parsed && parsed.evejsAbyssalEnvironmentalObject;
  if (!rawState || typeof rawState !== "object") {
    return null;
  }
  return {
    role: normalizeText(rawState.role, ABYSSAL_ENVIRONMENTAL_OBJECT_ROLE),
    abyssalEntityRole: normalizeText(rawState.abyssalEntityRole, ""),
    abyssalDefinitionID: normalizeText(rawState.abyssalDefinitionID, ""),
    instanceID: toInt(rawState.instanceID, 0),
    traceItemID: toInt(rawState.traceItemID, 0),
    characterID: toInt(rawState.characterID, 0),
    shipID: toInt(rawState.shipID, 0),
    solarSystemID: toInt(rawState.solarSystemID, toInt(item.locationID, 0)),
    roomIndex: toInt(rawState.roomIndex, 1),
    profileID: normalizeText(rawState.profileID, ""),
    slot: Math.max(1, toInt(rawState.slot, 1)),
    effectKind: normalizeText(rawState.effectKind, ""),
    presentationEnabled: rawState.presentationEnabled === true,
    mechanicsEnabled: rawState.mechanicsEnabled === true,
    mechanicsProfileID: normalizeText(rawState.mechanicsProfileID, ""),
    presentationRadiusMeters: Number.isFinite(Number(rawState.presentationRadiusMeters))
      ? Number(rawState.presentationRadiusMeters)
      : 0,
    mechanicsRangeMeters: Number.isFinite(Number(rawState.mechanicsRangeMeters))
      ? Number(rawState.mechanicsRangeMeters)
      : Number.isFinite(Number(rawState.radiusMeters))
        ? Number(rawState.radiusMeters)
        : 0,
    activationDurationMs: toInt(rawState.activationDurationMs, 0),
    dogmaEffectID: toInt(rawState.dogmaEffectID, 0),
    targetTypeListID: toInt(rawState.targetTypeListID, 0),
    resolvedTargetClasses: Array.isArray(rawState.resolvedTargetClasses)
      ? cloneValue(rawState.resolvedTargetClasses)
      : [],
    radiusMeters: Number.isFinite(Number(rawState.radiusMeters)) ? Number(rawState.radiusMeters) : 0,
    perimeterRadius: Number.isFinite(Number(rawState.perimeterRadius)) ? Number(rawState.perimeterRadius) : 0,
    perimeterLook: toInt(rawState.perimeterLook, 0),
    dunObjectID: toInt(rawState.dunObjectID, toInt(item.itemID, 0)),
    dunObjectNameID: rawState.dunObjectNameID == null ? null : toInt(rawState.dunObjectNameID, 0),
    objectiveTargetGroup: rawState.objectiveTargetGroup == null
      ? null
      : toInt(rawState.objectiveTargetGroup, 0),
    dunPosition: Array.isArray(rawState.dunPosition) ? cloneValue(rawState.dunPosition) : null,
    dunRotation: Array.isArray(rawState.dunRotation) ? cloneValue(rawState.dunRotation) : null,
    evidence: normalizeText(rawState.evidence, ""),
    environmentProfileID: normalizeText(rawState.environmentProfileID, ""),
    layoutVariant: normalizeText(rawState.layoutVariant, ""),
    sceneCubeResource: normalizeText(rawState.sceneCubeResource, ""),
    volumetricCloudResource: normalizeText(rawState.volumetricCloudResource, ""),
    nearFieldResource: normalizeText(rawState.nearFieldResource, ""),
    lensFlareResource: normalizeText(rawState.lensFlareResource, ""),
    gradientResource: normalizeText(rawState.gradientResource, ""),
    transitionEffect: normalizeText(rawState.transitionEffect, ""),
    roomLayoutProfileID: normalizeText(rawState.roomLayoutProfileID, ""),
    placeholderContent: rawState.placeholderContent !== false,
  };
}

function resolveAbyssalEnvironmentRoomProfileForPocket({
  buildPlaceholderRoomState,
  getCapturedT0DarkRoom,
  getContentProfile,
  cloneValue,
  resolveAbyssalEnvironmentRoomProfile,
  resolveSelectedAbyssalBaseRoomLayoutID,
  getResolvedWeatherState,
  normalizeLowerText,
}, source, roomIndex = null) {
  const resolvedRoomIndex = roomIndex == null
    ? toInt(buildPlaceholderRoomState(source).currentRoomIndex, 1)
    : toInt(roomIndex, 1);
  const selectedRoom = getCapturedT0DarkRoom(source, resolvedRoomIndex);
  const contentProfile = getContentProfile(source) || source || {};
  const resolvedProfile = selectedRoom && selectedRoom.environmentProfile
    ? cloneValue(selectedRoom.environmentProfile)
    : resolveAbyssalEnvironmentRoomProfile({
      tier: contentProfile.tier,
      weatherType: contentProfile.weatherType,
      layoutVariant: contentProfile.environmentLayoutVariant,
      roomIndex: resolvedRoomIndex,
      baseRoomLayoutID: resolveSelectedAbyssalBaseRoomLayoutID(source || {}, resolvedRoomIndex),
      seed: toInt(source && source.instanceID, toInt(source && source.traceItemID, 0)),
    });
  const weatherState = getResolvedWeatherState(source);
  if (
    resolvedProfile &&
    normalizeLowerText(weatherState && weatherState.weatherType, "") ===
      normalizeLowerText(contentProfile.weatherType, "") &&
    toInt(weatherState && weatherState.weatherTypeID, 0) > 0
  ) {
    return {
      ...resolvedProfile,
      weatherObjectTypeID: toInt(weatherState.weatherTypeID, 0),
      weatherStage: toInt(weatherState.weatherStage, 0),
      weatherPenaltyStrengthPercent: toInt(
        weatherState.penaltyStrengthPercent,
        toInt(weatherState.strengthPercent, 0),
      ),
      weatherBonusStrengthPercent: toInt(
        weatherState.bonusStrengthPercent,
        toInt(weatherState.strengthPercent, 0),
      ),
    };
  }
  return resolvedProfile;
}

function buildEnvironmentalObjectSpawnState({
  getObjectPosition,
  resolveRoomOriginPosition,
  TYPE_ABYSSAL_PERIMETER_LIGHTS,
  buildRoomConduitState,
  addVectors,
  TYPE_UNSTABLE_ABYSSAL_DEPTHS,
  toReal,
}, pocketState, roomEntry, environmentalEntry) {
  const roomOrigin = getObjectPosition(roomEntry && roomEntry.roomOriginPosition) ||
    resolveRoomOriginPosition(pocketState, roomEntry && roomEntry.roomIndex);
  const typeID = toInt(environmentalEntry && environmentalEntry.typeID, 0);
  const conduitState = typeID === TYPE_ABYSSAL_PERIMETER_LIGHTS
    ? buildRoomConduitState(pocketState, roomEntry && roomEntry.roomIndex)
    : null;
  const conduitPosition = getObjectPosition(conduitState && conduitState.position);
  const offset = conduitPosition
    ? {
      x: conduitPosition.x - roomOrigin.x,
      y: conduitPosition.y - roomOrigin.y,
      z: conduitPosition.z - roomOrigin.z,
    }
    : environmentalEntry && environmentalEntry.offset || { x: 0, y: 0, z: 0 };
  const position = addVectors(roomOrigin, offset);
  const rotation = Array.isArray(environmentalEntry && environmentalEntry.rotation)
    ? environmentalEntry.rotation.map((entry) => Number(entry) || 0)
    : [0, 0, 0];
  const presentationRadiusMeters = typeID === TYPE_UNSTABLE_ABYSSAL_DEPTHS
    ? Number(
      environmentalEntry &&
      environmentalEntry.definition &&
      environmentalEntry.definition.presentationRadiusMeters,
    ) || 0
    : typeID === TYPE_ABYSSAL_PERIMETER_LIGHTS
      ? Number(
        environmentalEntry && environmentalEntry.perimeterRadius ||
        environmentalEntry &&
        environmentalEntry.definition &&
        environmentalEntry.definition.perimeterRadius,
      ) || 0
      : 0;
  return {
    position,
    velocity: { x: 0, y: 0, z: 0 },
    direction: { x: 0, y: 1, z: 0 },
    targetPoint: position,
    mode: "STOP",
    speedFraction: 0,
    dunPosition: [toReal(offset.x, 0), toReal(offset.y, 0), toReal(offset.z, 0)],
    dunRotation: rotation,
    ...(presentationRadiusMeters > 0
      ? { spaceRadius: presentationRadiusMeters }
      : {}),
  };
}

function listAuthoredAbyssalEnvironmentalEntries({
  getContentProfile,
  getPlaceholderRoomEntry,
  listAbyssalEnvironmentalObjectsForRoom,
  isProceduralEnvironment,
  cloneValue,
  resolveSelectedAbyssalBaseRoomLayoutID,
  getResolvedWeatherState,
},
  pocketState,
  roomIndex,
  options = {},
) {
  const contentProfile = getContentProfile(pocketState) || {};
  const roomEntry = getPlaceholderRoomEntry(pocketState, roomIndex);
  return listAbyssalEnvironmentalObjectsForRoom(roomIndex, {
    tier: contentProfile.tier,
    weatherType: contentProfile.weatherType,
    seed: toInt(
      pocketState && pocketState.instanceID,
      toInt(pocketState && pocketState.traceItemID, 0),
    ),
    layoutVariant: isProceduralEnvironment(contentProfile.environmentLayoutVariant) ? contentProfile.environmentLayoutVariant : normalizeText(
      options && options.layoutVariant,
      normalizeText(contentProfile.environmentLayoutVariant, ""),
    ),
    selectedRoomLayoutIDs: cloneValue(pocketState && pocketState.selectedRoomLayoutIDs),
    baseRoomLayoutID: resolveSelectedAbyssalBaseRoomLayoutID(pocketState || {}, roomIndex),
    weatherState: getResolvedWeatherState(pocketState),
    observedObjectEntries: cloneValue(roomEntry && roomEntry.observedObjectEntries) || [],
  });
}

// Capture supplied capabilities once, as the original closure did. Internal
// callbacks are bound once per instance; no runtime state lives in this wiring.
function createAbyssalEnvironmentModel({
  buildPlaceholderRoomState,
  ABYSSAL_ENVIRONMENTAL_OBJECT_ROLE,
  resolveAbyssalRoomEntityRole,
  clampRoomIndex,
  cloneValue,
  buildCapturedRetailIdentityState,
  parseCustomInfo,
  getCapturedT0DarkRoom,
  getContentProfile,
  resolveAbyssalEnvironmentRoomProfile,
  resolveSelectedAbyssalBaseRoomLayoutID,
  getResolvedWeatherState,
  normalizeLowerText,
  getObjectPosition,
  resolveRoomOriginPosition,
  TYPE_ABYSSAL_PERIMETER_LIGHTS,
  buildRoomConduitState,
  addVectors,
  TYPE_UNSTABLE_ABYSSAL_DEPTHS,
  toReal,
  getPlaceholderRoomEntry,
  listAbyssalEnvironmentalObjectsForRoom,
  isProceduralEnvironment,
}) {

  const ports = {
    buildPlaceholderRoomState,
    ABYSSAL_ENVIRONMENTAL_OBJECT_ROLE,
    resolveAbyssalRoomEntityRole,
    clampRoomIndex,
    cloneValue,
    buildCapturedRetailIdentityState,
    parseCustomInfo,
    getCapturedT0DarkRoom,
    getContentProfile,
    resolveAbyssalEnvironmentRoomProfile,
    resolveSelectedAbyssalBaseRoomLayoutID,
    getResolvedWeatherState,
    normalizeLowerText,
    getObjectPosition,
    resolveRoomOriginPosition,
    TYPE_ABYSSAL_PERIMETER_LIGHTS,
    buildRoomConduitState,
    addVectors,
    TYPE_UNSTABLE_ABYSSAL_DEPTHS,
    toReal,
    getPlaceholderRoomEntry,
    listAbyssalEnvironmentalObjectsForRoom,
    isProceduralEnvironment,
  };
  ports.buildEnvironmentalObjectCustomInfo = buildEnvironmentalObjectCustomInfo.bind(null, ports);
  ports.readEnvironmentalObjectStateFromItem = readEnvironmentalObjectStateFromItem.bind(null, ports);
  ports.resolveAbyssalEnvironmentRoomProfileForPocket = resolveAbyssalEnvironmentRoomProfileForPocket.bind(null, ports);
  ports.buildEnvironmentalObjectSpawnState = buildEnvironmentalObjectSpawnState.bind(null, ports);
  ports.listAuthoredAbyssalEnvironmentalEntries = listAuthoredAbyssalEnvironmentalEntries.bind(null, ports);
  Object.freeze(ports);
  return Object.freeze({
    buildEnvironmentalObjectCustomInfo: ports.buildEnvironmentalObjectCustomInfo,
    readEnvironmentalObjectStateFromItem: ports.readEnvironmentalObjectStateFromItem,
    resolveAbyssalEnvironmentRoomProfileForPocket: ports.resolveAbyssalEnvironmentRoomProfileForPocket,
    buildEnvironmentalObjectSpawnState: ports.buildEnvironmentalObjectSpawnState,
    listAuthoredAbyssalEnvironmentalEntries: ports.listAuthoredAbyssalEnvironmentalEntries,
  });
}

module.exports = Object.freeze({ createAbyssalEnvironmentModel });
