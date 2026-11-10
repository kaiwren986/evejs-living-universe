"use strict";

const { normalizeText } = require("../domain/abyssalValueUtils");

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

// Scenery selection and entity construction from caller-supplied factual profiles.
function isAbyssalEnvironmentVisualEntity({
  ABYSSAL_SCENERY_VISUAL_ROLE,
}, entity) {
  return Boolean(
    entity &&
      entity.abyssalVisualOnly === true &&
      normalizeText(entity.evejsAbyssalVisualRole, "") === ABYSSAL_SCENERY_VISUAL_ROLE,
  );
}

function buildAbyssalSceneryVisualItemID({
  ABYSSAL_SCENERY_STATIC_ITEM_ID_BASE,
},
  instanceID,
  roomIndex,
  slot = 1,
  capturedRetailObject = false,
) {
  if (capturedRetailObject === true) {
    return (
      ABYSSAL_SCENERY_STATIC_ITEM_ID_BASE +
      1_000_000_000 +
      (Math.max(0, toInt(instanceID, 0)) * 1_000) +
      (Math.max(0, toInt(roomIndex, 0)) * 100) +
      Math.max(0, toInt(slot, 0))
    );
  }
  return (
    ABYSSAL_SCENERY_STATIC_ITEM_ID_BASE +
    (Math.max(0, toInt(instanceID, 0)) * 100) +
    (Math.max(0, toInt(roomIndex, 0)) * 10) +
    Math.max(0, toInt(slot, 0))
  );
}

function buildAbyssalSceneryProbeItemID({
  ABYSSAL_SCENERY_STATIC_ITEM_ID_BASE,
}, instanceID, roomIndex, ordinal = 1) {
  return (
    ABYSSAL_SCENERY_STATIC_ITEM_ID_BASE +
    (Math.max(0, toInt(instanceID, 0)) * 1_000) +
    (Math.max(0, toInt(roomIndex, 0)) * 100) +
    50 +
    Math.max(0, toInt(ordinal, 0))
  );
}

function getAbyssalSceneryProfileForRoomIndex({
  getContentProfile,
  resolveSelectedAbyssalBaseRoomLayoutID,
  resolveAbyssalBaseRoomSceneryProfile,
  isCapturedT0DarkContent,
  getCapturedT0DarkRoom,
  T0_DARK_RETAIL_CAPTURED_PROFILE_ID,
  normalizeLowerText,
  SCENERY_POLICY_EXPERIMENTAL,
  T0_DARK_RETAIL_CAPTURED_LAYOUT_VARIANT,
  cloneValue,
  toReal,
  resolveGeneratedAuthoredAbyssalSceneryProfile,
  resolveT0TranquilRetailCapturedSceneryProfile,
}, source = null, roomIndex = 1) {
  const contentProfile = getContentProfile(source) || source || {};
  const selectedBaseRoomLayoutID = resolveSelectedAbyssalBaseRoomLayoutID(
    source || {},
    roomIndex,
  );
  const selectedBaseRoomSceneryProfile = resolveAbyssalBaseRoomSceneryProfile(
    selectedBaseRoomLayoutID,
    contentProfile && contentProfile.weatherType,
  );
  if (selectedBaseRoomSceneryProfile) {
    return selectedBaseRoomSceneryProfile;
  }
  if (isCapturedT0DarkContent(source)) {
    const capturedRoom = getCapturedT0DarkRoom(source, roomIndex);
    if (capturedRoom) {
      return {
        profileID: `${T0_DARK_RETAIL_CAPTURED_PROFILE_ID}:room-${toInt(roomIndex, 1)}:props`,
        layoutID: normalizeText(capturedRoom.layoutID, ""),
        evidenceStatus: normalizeText(capturedRoom.evidenceStatus, ""),
        sceneryPolicy: normalizeLowerText(
          capturedRoom.sceneryPolicy,
          SCENERY_POLICY_EXPERIMENTAL,
        ),
        layoutVariant: T0_DARK_RETAIL_CAPTURED_LAYOUT_VARIANT,
        capturedRetailProfile: true,
        maxEntries: capturedRoom.props.length,
        entries: capturedRoom.props.map((entry, index) => ({
          slot: index + 1,
          entryRole: entry.role,
          candidateTypeID: entry.typeID,
          candidateName: entry.name,
          exactRelativePosition: cloneValue(entry.position),
          exactRetailRotation: cloneValue(entry.rotation),
          dunObjectID: toInt(entry.dunObjectID, 0),
          dunObjectNameID: entry.dunObjectNameID,
          objectiveTargetGroup: entry.objectiveTargetGroup,
          retailBallID: String(entry.retailBallID || ""),
          capturedRetailOwnerID: toInt(entry.presentationOwnerID, toInt(entry.ownerID, 0)),
          identity: cloneValue(entry.identity),
          radiusOverrideMeters: toReal(entry.radius, 1),
          massOverride: toReal(entry.mass, 0),
          graphicID: toInt(entry.graphicID, 0),
          capturedRetailObject: true,
          sourceEvidence: cloneValue(entry.sourceEvidence),
        })),
      };
    }
  }
  const weatherType = normalizeText(contentProfile && contentProfile.weatherType, "dark");
  const generatedAuthoredProfile = resolveGeneratedAuthoredAbyssalSceneryProfile(
    contentProfile && contentProfile.environmentLayoutVariant,
    roomIndex,
  );
  if (generatedAuthoredProfile) {
    return generatedAuthoredProfile;
  }
  if (toInt(contentProfile && contentProfile.tier, -1) === 0) {
    const tranquilCapturedProfile =
      resolveT0TranquilRetailCapturedSceneryProfile(
        weatherType,
        roomIndex,
        contentProfile.environmentLayoutVariant,
      );
    if (tranquilCapturedProfile) {
      return tranquilCapturedProfile;
    }
  }
  return null;
}

function resolveAbyssalSceneryPolicy({
  normalizeLowerText,
  SCENERY_POLICY_EXPERIMENTAL,
  SCENERY_POLICY_AUTHORITATIVE,
}, profile = null) {
  return normalizeLowerText(profile && profile.sceneryPolicy, SCENERY_POLICY_EXPERIMENTAL) ===
    SCENERY_POLICY_AUTHORITATIVE
    ? SCENERY_POLICY_AUTHORITATIVE
    : SCENERY_POLICY_EXPERIMENTAL;
}

function isAuthoritativeAbyssalSceneryProfile({
  resolveAbyssalSceneryPolicy,
  SCENERY_POLICY_AUTHORITATIVE,
}, profile = null) {
  return resolveAbyssalSceneryPolicy(profile) === SCENERY_POLICY_AUTHORITATIVE;
}

function resolveAbyssalSceneryProfile({
  getDependencies,
  buildPlaceholderRoomState,
  getContentProfile,
  getAbyssalSceneryProfileForRoomIndex,
  resolveAbyssalSceneryPolicy,
  isAuthoritativeAbyssalSceneryProfile,
  isAbyssalSceneryVisualsRequested,
  ABYSSAL_SCENERY_GUARD_STATUS,
  isSupportedCalmSceneryContentProfile,
  cloneValue,
}, pocketState, deps = getDependencies()) {
  const roomState = buildPlaceholderRoomState(pocketState);
  const currentRoomIndex = toInt(roomState && roomState.currentRoomIndex, 0);
  const contentProfile = getContentProfile(pocketState) || {};
  const selectedProfile = getAbyssalSceneryProfileForRoomIndex(pocketState, currentRoomIndex);
  const sceneryPolicy = resolveAbyssalSceneryPolicy(selectedProfile);
  const authoritative = isAuthoritativeAbyssalSceneryProfile(selectedProfile);
  const requested = isAbyssalSceneryVisualsRequested(deps);
  if (!requested && !authoritative) {
    return {
      requested: false,
      enabled: false,
      applicable: false,
      authoritative: false,
      sceneryPolicy,
      layoutID: normalizeText(selectedProfile && selectedProfile.layoutID, ""),
      profileID: normalizeText(selectedProfile && selectedProfile.profileID, ""),
      blockReason: "ENV_DISABLED",
      profile: null,
    };
  }
  if (!ABYSSAL_SCENERY_GUARD_STATUS.active) {
    return {
      requested,
      enabled: false,
      applicable: false,
      authoritative,
      sceneryPolicy,
      layoutID: normalizeText(selectedProfile && selectedProfile.layoutID, ""),
      profileID: normalizeText(selectedProfile && selectedProfile.profileID, ""),
      blockReason: "GUARDS_INACTIVE",
      profile: null,
    };
  }
  if (!isSupportedCalmSceneryContentProfile(contentProfile)) {
    return {
      requested,
      enabled: true,
      applicable: false,
      authoritative,
      sceneryPolicy,
      layoutID: normalizeText(selectedProfile && selectedProfile.layoutID, ""),
      profileID: normalizeText(selectedProfile && selectedProfile.profileID, ""),
      blockReason: "PROFILE_NOT_APPLICABLE",
      profile: null,
    };
  }
  if (!selectedProfile) {
    return {
      requested,
      enabled: true,
      applicable: false,
      authoritative: false,
      sceneryPolicy,
      layoutID: "",
      profileID: "",
      blockReason: "ROOM_NOT_APPLICABLE",
      profile: null,
    };
  }
  return {
    requested,
    enabled: true,
    applicable: true,
    authoritative,
    sceneryPolicy,
    layoutID: normalizeText(selectedProfile.layoutID, ""),
    profileID: selectedProfile.profileID,
    blockReason: "none",
    profile: cloneValue(selectedProfile),
  };
}

function listAbyssalSceneryProfileEntries({
  cloneValue,
}, profile) {
  if (!profile || !Array.isArray(profile.entries)) {
    return [];
  }
  const maxEntries = profile && profile.capturedRetailProfile === true
    ? Math.max(1, Math.min(256, toInt(profile && profile.maxEntries, 3)))
    : Math.max(1, Math.min(6, toInt(profile && profile.maxEntries, 3)));
  return profile.entries
    .map((entry, index) => ({
      ...cloneValue(entry),
      slot: Math.max(1, toInt(entry && entry.slot, index + 1)),
    }))
    .filter((entry) => toInt(entry && entry.candidateTypeID, 0) > 0)
    .slice(0, maxEntries);
}

function buildAbyssalSceneryProfileSummary({
  getDependencies,
  listAbyssalSceneryProfileEntries,
}, profile, deps = getDependencies()) {
  const profileEntries = listAbyssalSceneryProfileEntries(profile);
  const artifactTypeIDs = [];
  const artifactTypeNames = [];
  let structureTypeID = 0;
  let structureTypeName = "none";
  const cloudTypeIDs = [];
  const cloudTypeNames = [];
  const cloudRadiusOverrideMeters = [];
  let cloudTypeID = 0;
  let cloudTypeName = "none";
  for (const profileEntry of profileEntries) {
    const typeID = toInt(profileEntry && profileEntry.candidateTypeID, 0);
    if (typeID <= 0) {
      continue;
    }
    const typeRecord = deps.resolveItemByTypeID(typeID);
    const typeName = normalizeText(
      profileEntry && profileEntry.candidateName,
      normalizeText(typeRecord && typeRecord.name, "Unknown Type"),
    );
    artifactTypeIDs.push(typeID);
    artifactTypeNames.push(typeName);
    const entryRole = normalizeText(profileEntry && profileEntry.entryRole, "");
    if (entryRole === "structure" && structureTypeID <= 0) {
      structureTypeID = typeID;
      structureTypeName = typeName;
    }
    if (entryRole === "cloud") {
      cloudTypeIDs.push(typeID);
      cloudTypeNames.push(typeName);
      cloudRadiusOverrideMeters.push(toInt(profileEntry && profileEntry.radiusOverrideMeters, 0));
      if (cloudTypeID <= 0) {
        cloudTypeID = typeID;
        cloudTypeName = typeName;
      }
    }
  }
  return {
    artifactTypeIDs,
    artifactTypeNames,
    structureTypeID,
    structureTypeName,
    cloudTypeID,
    cloudTypeName,
    cloudTypeIDs,
    cloudTypeNames,
    cloudRadiusOverrideMeters,
  };
}

function buildAbyssalSceneryVisualPosition({
  cloneValue,
  getObjectPosition,
  addVectors,
  normalizeDirection,
  scaleVector,
}, roomEntry, profileEntry) {
  const shipSpawnState = cloneValue(roomEntry && roomEntry.shipSpawnState) || {};
  const origin = getObjectPosition(roomEntry && roomEntry.roomOriginPosition) || { x: 0, y: 0, z: 0 };
  const exactRelativePosition = getObjectPosition(
    profileEntry && profileEntry.exactRelativePosition,
  );
  if (exactRelativePosition) {
    return addVectors(origin, exactRelativePosition);
  }
  const forward = normalizeDirection(shipSpawnState.direction, { x: 1, y: 0, z: 0 });
  const lateral = normalizeDirection(
    {
      x: -forward.y,
      y: forward.x,
      z: 0,
    },
    { x: 0, y: 1, z: 0 },
  );
  return addVectors(
    addVectors(
      origin,
      scaleVector(forward, toInt(profileEntry && profileEntry.forwardOffsetMeters, 0)),
    ),
    {
      x: scaleVector(lateral, toInt(profileEntry && profileEntry.lateralOffsetMeters, 0)).x,
      y: scaleVector(lateral, toInt(profileEntry && profileEntry.lateralOffsetMeters, 0)).y,
      z: toInt(profileEntry && profileEntry.verticalOffsetMeters, 0),
    },
  );
}

function buildAbyssalSceneryVisualEntity({
  getDependencies,
  getContentProfile,
  buildAbyssalSceneryVisualPosition,
  toReal,
  buildAbyssalSceneryVisualItemID,
  normalizeDirection,
  ABYSSAL_ROOM_DELIVERY_STATE,
  cloneValue,
  resolveAbyssalRoomEntityRole,
  ABYSSAL_SCENERY_VISUAL_ROLE,
},
  pocketState,
  roomEntry,
  profile,
  profileEntry,
  deps = getDependencies(),
) {
  const typeRecord = deps.resolveItemByTypeID(toInt(profileEntry && profileEntry.candidateTypeID, 0));
  if (!typeRecord) {
    return null;
  }
  const roomIndex = toInt(roomEntry && roomEntry.roomIndex, 0);
  const contentProfile = getContentProfile(pocketState) || {};
  const position = buildAbyssalSceneryVisualPosition(roomEntry, profileEntry);
  const resolvedRadius = Math.max(
    1,
    toReal(
      profileEntry && profileEntry.radiusOverrideMeters,
      toReal(typeRecord.radius, 1),
    ),
  );
  return {
    kind: "abyssalVisual",
    itemID: buildAbyssalSceneryVisualItemID(
      pocketState && pocketState.instanceID,
      roomIndex,
      profileEntry && profileEntry.slot,
      profileEntry && profileEntry.capturedRetailObject === true,
    ),
    typeID: toInt(typeRecord.typeID, 0),
    groupID: toInt(typeRecord.groupID, 0),
    categoryID: toInt(typeRecord.categoryID, 0),
    slimTypeID: toInt(typeRecord.typeID, 0),
    slimGroupID: toInt(typeRecord.groupID, 0),
    slimCategoryID: toInt(typeRecord.categoryID, 0),
    itemName: normalizeText(typeRecord.name, "Abyssal Scenery"),
    slimName: normalizeText(typeRecord.name, "Abyssal Scenery"),
    suppressSlimName: true,
    inventoryOwnerID: toInt(pocketState && pocketState.characterID, 0),
    ownerID: profileEntry && profileEntry.capturedRetailObject === true
      ? toInt(profileEntry.capturedRetailOwnerID, toInt(pocketState && pocketState.characterID, 0))
      : toInt(pocketState && pocketState.characterID, 0),
    corporationID: 0,
    allianceID: 0,
    factionID: 0,
    graphicID: toInt(typeRecord.graphicID, 0) || null,
    slimGraphicID: toInt(typeRecord.graphicID, 0) || null,
    radius: resolvedRadius,
    staticVisibilityScope: "publicgrid",
    position,
    velocity: { x: 0, y: 0, z: 0 },
    direction: normalizeDirection(roomEntry && roomEntry.shipSpawnState && roomEntry.shipSpawnState.direction, { x: 1, y: 0, z: 0 }),
    targetPoint: position,
    mode: "STOP",
    speedFraction: 1,
    destinyBallMode: "STOP",
    destinyForceFree: true,
    destinyBallFlags: 32,
    mass: profileEntry && profileEntry.capturedRetailObject === true
      ? Math.max(0, toReal(profileEntry.massOverride, 0))
      : 1_000_000,
    maxVelocity: 1,
    inertia: 1,
    ballInteractive: false,
    hostileResponseThreshold: -11,
    friendlyResponseThreshold: 11,
    abyssalVisualOnly: true,
    abyssalRunID: toInt(pocketState && pocketState.instanceID, 0),
    abyssalRoomIndex: roomIndex,
    abyssalRoomDeliveryState: normalizeText(roomEntry && roomEntry.deliveryState, ""),
    evejsAbyssalRoomDeliveryState: normalizeText(roomEntry && roomEntry.deliveryState, ""),
    evejsInitialPublicationDeferred:
      normalizeText(roomEntry && roomEntry.deliveryState, "") ===
        ABYSSAL_ROOM_DELIVERY_STATE.PREWARMED_HIDDEN,
    abyssalTransitionToken: toInt(roomEntry && roomEntry.deliveryTransitionToken, 0),
    abyssalSelectedRoomLayoutID: normalizeText(roomEntry && roomEntry.selectedRoomLayoutID, ""),
    evejsAbyssalRoomOriginPosition: cloneValue(roomEntry && roomEntry.roomOriginPosition),
    evejsAbyssalAuthoredLocalPosition: cloneValue(profileEntry && profileEntry.exactRelativePosition),
    sceneKey: normalizeText(
      pocketState && pocketState.sceneKey,
      normalizeText(pocketState && pocketState.sceneDescriptor && pocketState.sceneDescriptor.sceneKey, ""),
    ),
    abyssalEntityRole: resolveAbyssalRoomEntityRole({
      entryRole: profileEntry && profileEntry.entryRole,
      typeID: typeRecord.typeID,
    }),
    abyssalDefinitionID: `${normalizeText(profile && profile.profileID, "abyssal:scenery")}:slot-${Math.max(1, toInt(profileEntry && profileEntry.slot, 1))}`,
    presentationEnabled: true,
    mechanicsEnabled: false,
    evejsAbyssalVisualRole: ABYSSAL_SCENERY_VISUAL_ROLE,
    evejsAbyssalInstanceID: toInt(pocketState && pocketState.instanceID, 0),
    evejsAbyssalCharacterID: toInt(pocketState && pocketState.characterID, 0),
    evejsAbyssalTraceItemID: toInt(pocketState && pocketState.traceItemID, 0),
    evejsAbyssalFilamentTypeID: toInt(contentProfile && contentProfile.filamentTypeID, 0),
    evejsAbyssalDefinitionID: normalizeText(contentProfile && contentProfile.definitionID, ""),
    evejsAbyssalRoomIndex: roomIndex,
    evejsAbyssalVisualSlot: Math.max(1, toInt(profileEntry && profileEntry.slot, 1)),
    evejsAbyssalVisualProfileID: normalizeText(profile && profile.profileID, ""),
    dunObjectID: toInt(profileEntry && profileEntry.dunObjectID, 0) || null,
    dunObjectNameID: profileEntry && profileEntry.dunObjectNameID || null,
    objectiveTargetGroup: profileEntry && profileEntry.objectiveTargetGroup || null,
    dunPosition: profileEntry && profileEntry.capturedRetailObject === true
      ? [
          toReal(profileEntry.exactRelativePosition && profileEntry.exactRelativePosition.x, 0),
          toReal(profileEntry.exactRelativePosition && profileEntry.exactRelativePosition.y, 0),
          toReal(profileEntry.exactRelativePosition && profileEntry.exactRelativePosition.z, 0),
        ]
      : null,
    dunRotation: Array.isArray(profileEntry && profileEntry.exactRetailRotation)
      ? cloneValue(profileEntry.exactRetailRotation)
      : null,
    evejsAbyssalCapturedRetailBallID: normalizeText(
      profileEntry && profileEntry.retailBallID,
      "",
    ),
    evejsAbyssalCapturedRetailOwnerID: toInt(
      profileEntry && profileEntry.capturedRetailOwnerID,
      0,
    ),
    evejsAbyssalCapturedRetailObject:
      profileEntry && profileEntry.capturedRetailObject === true,
    evejsAbyssalIdentityPolicy: normalizeText(
      profileEntry && profileEntry.identity && profileEntry.identity.identityPolicy,
      profileEntry && profileEntry.capturedRetailObject === true ? "captured-retail" : "legacy",
    ),
    evejsAbyssalNamePolicy: normalizeText(
      profileEntry && profileEntry.identity && profileEntry.identity.namePolicy,
      "type-derived",
    ),
  };
}

function buildAbyssalSceneryProbeEntity({
  getDependencies,
  buildAbyssalSceneryVisualEntity,
  ABYSSAL_SCENERY_PROBE_PROFILE,
  toReal,
  buildAbyssalSceneryProbeItemID,
  ABYSSAL_ROOM_ENTITY_ROLES,
},
  pocketState,
  roomEntry,
  candidate,
  preset,
  ordinal,
  deps = getDependencies(),
) {
  const entity = buildAbyssalSceneryVisualEntity(
    pocketState,
    roomEntry,
    {
      profileID: ABYSSAL_SCENERY_PROBE_PROFILE.profileID,
    },
    {
      slot: ABYSSAL_SCENERY_PROBE_PROFILE.itemSlot,
      candidateTypeID: toInt(candidate && candidate.typeID, 0),
      candidateName: normalizeText(candidate && candidate.typeName, "Abyssal Scenery Probe"),
      forwardOffsetMeters: toInt(preset && preset.forwardOffsetMeters, 0),
      lateralOffsetMeters: toInt(preset && preset.lateralOffsetMeters, 0),
      verticalOffsetMeters: toInt(preset && preset.verticalOffsetMeters, 0),
      radiusOverrideMeters: toReal(candidate && candidate.radiusOverrideMeters, 0) || undefined,
    },
    deps,
  );
  if (!entity) {
    return null;
  }
  return {
    ...entity,
    itemID: buildAbyssalSceneryProbeItemID(
      pocketState && pocketState.instanceID,
      roomEntry && roomEntry.roomIndex,
      ordinal,
    ),
    abyssalEntityRole: ABYSSAL_ROOM_ENTITY_ROLES.PROBE,
    abyssalDefinitionID: `${ABYSSAL_SCENERY_PROBE_PROFILE.profileID}:${normalizeText(candidate && candidate.key, "unknown")}`,
    presentationEnabled: true,
    mechanicsEnabled: false,
    evejsAbyssalVisualProbe: true,
    evejsAbyssalVisualProbeKey: normalizeText(candidate && candidate.key, ""),
    evejsAbyssalVisualProbePreset: normalizeText(preset && preset.key, ""),
    evejsAbyssalVisualProbeDiagnosticTag: normalizeText(candidate && candidate.diagnosticTag, ""),
  };
}

// Capture supplied capabilities once, as the original closure did. Internal
// callbacks are bound once per instance; no runtime state lives in this wiring.
function createAbyssalSceneryModel({
  ABYSSAL_SCENERY_VISUAL_ROLE,
  ABYSSAL_SCENERY_STATIC_ITEM_ID_BASE,
  getContentProfile,
  resolveSelectedAbyssalBaseRoomLayoutID,
  resolveAbyssalBaseRoomSceneryProfile,
  isCapturedT0DarkContent,
  getCapturedT0DarkRoom,
  T0_DARK_RETAIL_CAPTURED_PROFILE_ID,
  normalizeLowerText,
  SCENERY_POLICY_EXPERIMENTAL,
  T0_DARK_RETAIL_CAPTURED_LAYOUT_VARIANT,
  cloneValue,
  toReal,
  resolveGeneratedAuthoredAbyssalSceneryProfile,
  resolveT0TranquilRetailCapturedSceneryProfile,
  SCENERY_POLICY_AUTHORITATIVE,
  getDependencies,
  buildPlaceholderRoomState,
  isAbyssalSceneryVisualsRequested,
  ABYSSAL_SCENERY_GUARD_STATUS,
  isSupportedCalmSceneryContentProfile,
  getObjectPosition,
  addVectors,
  normalizeDirection,
  scaleVector,
  ABYSSAL_ROOM_DELIVERY_STATE,
  resolveAbyssalRoomEntityRole,
  ABYSSAL_SCENERY_PROBE_PROFILE,
  ABYSSAL_ROOM_ENTITY_ROLES,
}) {

  const ports = {
    ABYSSAL_SCENERY_VISUAL_ROLE,
    ABYSSAL_SCENERY_STATIC_ITEM_ID_BASE,
    getContentProfile,
    resolveSelectedAbyssalBaseRoomLayoutID,
    resolveAbyssalBaseRoomSceneryProfile,
    isCapturedT0DarkContent,
    getCapturedT0DarkRoom,
    T0_DARK_RETAIL_CAPTURED_PROFILE_ID,
    normalizeLowerText,
    SCENERY_POLICY_EXPERIMENTAL,
    T0_DARK_RETAIL_CAPTURED_LAYOUT_VARIANT,
    cloneValue,
    toReal,
    resolveGeneratedAuthoredAbyssalSceneryProfile,
    resolveT0TranquilRetailCapturedSceneryProfile,
    SCENERY_POLICY_AUTHORITATIVE,
    getDependencies,
    buildPlaceholderRoomState,
    isAbyssalSceneryVisualsRequested,
    ABYSSAL_SCENERY_GUARD_STATUS,
    isSupportedCalmSceneryContentProfile,
    getObjectPosition,
    addVectors,
    normalizeDirection,
    scaleVector,
    ABYSSAL_ROOM_DELIVERY_STATE,
    resolveAbyssalRoomEntityRole,
    ABYSSAL_SCENERY_PROBE_PROFILE,
    ABYSSAL_ROOM_ENTITY_ROLES,
  };
  ports.isAbyssalEnvironmentVisualEntity = isAbyssalEnvironmentVisualEntity.bind(null, ports);
  ports.buildAbyssalSceneryVisualItemID = buildAbyssalSceneryVisualItemID.bind(null, ports);
  ports.buildAbyssalSceneryProbeItemID = buildAbyssalSceneryProbeItemID.bind(null, ports);
  ports.getAbyssalSceneryProfileForRoomIndex = getAbyssalSceneryProfileForRoomIndex.bind(null, ports);
  ports.resolveAbyssalSceneryPolicy = resolveAbyssalSceneryPolicy.bind(null, ports);
  ports.isAuthoritativeAbyssalSceneryProfile = isAuthoritativeAbyssalSceneryProfile.bind(null, ports);
  ports.resolveAbyssalSceneryProfile = resolveAbyssalSceneryProfile.bind(null, ports);
  ports.listAbyssalSceneryProfileEntries = listAbyssalSceneryProfileEntries.bind(null, ports);
  ports.buildAbyssalSceneryProfileSummary = buildAbyssalSceneryProfileSummary.bind(null, ports);
  ports.buildAbyssalSceneryVisualPosition = buildAbyssalSceneryVisualPosition.bind(null, ports);
  ports.buildAbyssalSceneryVisualEntity = buildAbyssalSceneryVisualEntity.bind(null, ports);
  ports.buildAbyssalSceneryProbeEntity = buildAbyssalSceneryProbeEntity.bind(null, ports);
  Object.freeze(ports);
  return Object.freeze({
    buildAbyssalSceneryVisualItemID: ports.buildAbyssalSceneryVisualItemID,
    buildAbyssalSceneryProbeItemID: ports.buildAbyssalSceneryProbeItemID,
    isAbyssalEnvironmentVisualEntity: ports.isAbyssalEnvironmentVisualEntity,
    getAbyssalSceneryProfileForRoomIndex: ports.getAbyssalSceneryProfileForRoomIndex,
    resolveAbyssalSceneryPolicy: ports.resolveAbyssalSceneryPolicy,
    isAuthoritativeAbyssalSceneryProfile: ports.isAuthoritativeAbyssalSceneryProfile,
    resolveAbyssalSceneryProfile: ports.resolveAbyssalSceneryProfile,
    listAbyssalSceneryProfileEntries: ports.listAbyssalSceneryProfileEntries,
    buildAbyssalSceneryProfileSummary: ports.buildAbyssalSceneryProfileSummary,
    buildAbyssalSceneryVisualPosition: ports.buildAbyssalSceneryVisualPosition,
    buildAbyssalSceneryVisualEntity: ports.buildAbyssalSceneryVisualEntity,
    buildAbyssalSceneryProbeEntity: ports.buildAbyssalSceneryProbeEntity,
  });
}

module.exports = Object.freeze({ createAbyssalSceneryModel });
