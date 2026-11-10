"use strict";

const {
  toInt, toReal, normalizeText, normalizeDirection, getObjectPosition, listUniquePositiveInts,
} = require("../domain/abyssalRuntimeValues");

// Item metadata preserves the existing serialized schema and exact run ownership rules.
function parseCustomInfo(ports, customInfo) {
  const text = String(customInfo || "").trim();
  if (!text) {
    return {};
  }
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch (_) {
    return { legacyCustomInfo: text };
  }
  return {};
}

function buildTraceCustomInfo(ports, state) {
  const {
    buildAbyssalTraceSlimState,
    buildAbyssalTracePresentationState,
    ABYSSAL_PARTICIPANT_ROSTER_SCHEMA_VERSION,
    normalizeAbyssalParticipantRoster,
    normalizeAbyssalTraceLifecyclePhase,
    cloneValue,
    ABYSSAL_PARTICIPANT_RETURN_OBLIGATION_SCHEMA_VERSION,
    getAbyssalParticipantReturnObligationsByCharacterID,
    TYPE_ABYSSAL_TRACE,
    GROUP_FILAMENT_TRACE,
    buildPersistedAbyssalContentProfile,
    getContentProfile,
  } = ports;
  const capturedState = buildAbyssalTraceSlimState(state);
  const presentationState = capturedState
    ? capturedState.slimFields
    : buildAbyssalTracePresentationState(state);
  return JSON.stringify({
    evejsAbyssalTrace: {
      traceItemID: toInt(state.traceItemID, 0),
      characterID: toInt(state.characterID, 0),
      shipID: toInt(state.shipID, 0),
      solarSystemID: toInt(state.solarSystemID, 0),
      filamentItemID: toInt(state.filamentItemID, 0),
      filamentTypeID: toInt(state.filamentTypeID, 0),
      fleetID: toInt(state.fleetID, 0),
      requiredFilaments: toInt(state.requiredFilaments, 0),
      maxShips: toInt(state.maxShips, 0),
      activateForFleet: state.activateForFleet === true,
      participantRosterSchemaVersion: ABYSSAL_PARTICIPANT_ROSTER_SCHEMA_VERSION,
      participantRoster: normalizeAbyssalParticipantRoster(state),
      eligibleParticipantCharacterIDs: listUniquePositiveInts(
        state.eligibleParticipantCharacterIDs,
      ),
      rewardBeneficiaryCharacterID: toInt(
        state.rewardBeneficiaryCharacterID,
        toInt(state.characterID, 0),
      ),
      traceProfileID: normalizeText(state.traceProfileID, ""),
      lifecyclePhase: normalizeAbyssalTraceLifecyclePhase(state.lifecyclePhase),
      abyssalRunID: toInt(state.abyssalRunID, 0),
      deploymentToken: normalizeText(state.deploymentToken, ""),
      automaticActivation:
        state.automaticActivation && typeof state.automaticActivation === "object"
          ? cloneValue(state.automaticActivation)
          : null,
      filamentConsumptionState:
        state.filamentConsumptionState && typeof state.filamentConsumptionState === "object"
          ? cloneValue(state.filamentConsumptionState)
          : null,
      returnProtectionState:
        state.returnProtectionState && typeof state.returnProtectionState === "object"
          ? cloneValue(state.returnProtectionState)
          : null,
      participantReturnObligationsSchemaVersion:
        ABYSSAL_PARTICIPANT_RETURN_OBLIGATION_SCHEMA_VERSION,
      participantReturnObligationsByCharacterID:
        getAbyssalParticipantReturnObligationsByCharacterID(state),
      publicationReceipt:
        state.publicationReceipt && typeof state.publicationReceipt === "object"
          ? cloneValue(state.publicationReceipt)
          : null,
      publicationStatus: normalizeText(state.publicationStatus, ""),
      abyssalTraceRole: "source-kspace-trace",
      sourceSolarSystemID: toInt(state.sourceSolarSystemID, toInt(state.solarSystemID, 0)),
      sourceSceneKey: normalizeText(state.sourceSceneKey, ""),
      sourceTracePosition: cloneValue(getObjectPosition(state.sourceTracePosition)),
      sourceShipPosition: cloneValue(getObjectPosition(state.sourceShipPosition)),
      sourceShipDirection: cloneValue(state.sourceShipDirection),
      sourceShipRadius: toReal(state.sourceShipRadius, 0),
      traceOrientation: cloneValue(state.traceOrientation),
      ownerID: toInt(state.ownerID, 0),
      typeID: toInt(state.typeID, TYPE_ABYSSAL_TRACE),
      groupID: toInt(state.groupID, GROUP_FILAMENT_TRACE),
      returnedAtMs: toInt(state.returnedAtMs, 0),
      removalScheduled: state.removalScheduled === true,
      removalDeadlineMs: toInt(state.removalDeadlineMs, 0),
      ...presentationState,
      deployedAtMs: toInt(state.deployedAtMs, 0),
      expiresAtMs: toInt(state.expiresAtMs, 0),
      shipClass: normalizeText(state.shipClass, ""),
      filamentName: normalizeText(state.filamentName, ""),
      shipTypeID: toInt(state.shipTypeID, 0),
      securityPolicy:
        state.securityPolicy && typeof state.securityPolicy === "object"
          ? cloneValue(state.securityPolicy)
          : null,
      suspectOnReturn: state.suspectOnReturn === true,
      suspectReturnState:
        state.suspectReturnState && typeof state.suspectReturnState === "object"
          ? cloneValue(state.suspectReturnState)
          : null,
      contentProfile: buildPersistedAbyssalContentProfile(
        getContentProfile(state),
      ),
      placeholderContent: true,
    },
  });
}

function buildCapturedRetailIdentityState(ports, identity, inventoryOwnerID, options = {}) {
  const {
    cloneValue,
  } = ports;
  if (!identity || typeof identity !== "object" ||
      normalizeText(identity.identityPolicy, "") !== "captured-retail") {
    return {};
  }
  const state = {
    identityPolicy: "captured-retail",
    inventoryOwnerID: toInt(inventoryOwnerID, 0),
    presentationOwnerID: toInt(identity.presentationOwnerID, 0),
    namePolicy: normalizeText(identity.namePolicy, "type-derived"),
    displayName: normalizeText(identity.displayName, "") || null,
    retailFieldPresence: cloneValue(identity.retailFieldPresence) || {},
  };
  if (Number.isFinite(Number(identity.friendlyResponseThreshold))) {
    state.friendlyResponseThreshold = Number(identity.friendlyResponseThreshold);
  }
  if (Number.isFinite(Number(identity.hostileResponseThreshold))) {
    state.hostileResponseThreshold = Number(identity.hostileResponseThreshold);
  }
  for (const fieldName of ["corporationID", "allianceID", "warFactionID", "charID"]) {
    if (Object.prototype.hasOwnProperty.call(identity, fieldName) && identity[fieldName] !== undefined) {
      state[fieldName] = identity[fieldName];
    }
  }
  const rewardBeneficiaryCharacterID = toInt(options.rewardBeneficiaryCharacterID, 0);
  if (rewardBeneficiaryCharacterID > 0) {
    state.rewardBeneficiaryCharacterID = rewardBeneficiaryCharacterID;
  }
  return state;
}

function buildRewardCacheCustomInfo(ports, pocketState, options = {}) {
  const {
    buildPlaceholderRoomState,
    getContentProfile,
    getCacheProfile,
    clampRoomIndex,
    getPlaceholderRoomEntry,
    getCapturedT0DarkRoom,
    resolveAbyssalCachePresentationIdentity,
    ABYSSAL_ROOM_ENTITY_ROLES,
    listAbyssalParticipantCharacterIDs,
    cloneValue,
    getCacheRewardQuantityMultiplier,
  } = ports;
  const roomState = buildPlaceholderRoomState(pocketState);
  const contentProfile = getContentProfile(pocketState) || {};
  const cacheProfile = getCacheProfile(pocketState) || {};
  const roomIndex = clampRoomIndex(
    toInt(options.roomIndex, roomState.currentRoomIndex),
    roomState.implementedRooms,
  );
  const roomEntry = getPlaceholderRoomEntry(pocketState, roomIndex);
  const capturedRoom = getCapturedT0DarkRoom(pocketState, roomIndex);
  const capturedCache = capturedRoom && capturedRoom.rewardCache;
  const role = normalizeText(options.role, "cache_structure");
  const presentationIdentity = role === "cache_structure"
    ? resolveAbyssalCachePresentationIdentity(pocketState, roomIndex)
    : null;
  return JSON.stringify({
    evejsAbyssalRewardCache: {
      role,
      abyssalEntityRole: role === "cache_loot_container"
        ? ABYSSAL_ROOM_ENTITY_ROLES.REWARD_WRECK
        : ABYSSAL_ROOM_ENTITY_ROLES.REWARD_CACHE,
      abyssalDefinitionID: normalizeText(
        options.abyssalDefinitionID,
        normalizeText(options.cacheProfileID, normalizeText(options.rewardProfileID, "")),
      ),
      instanceID: toInt(pocketState.instanceID, 0),
      traceItemID: toInt(pocketState.traceItemID, 0),
      characterID: toInt(pocketState.characterID, 0),
      participantCharacterIDs: listAbyssalParticipantCharacterIDs(pocketState),
      shipID: toInt(pocketState.shipID, 0),
      solarSystemID: toInt(pocketState.solarSystemID, 0),
      tier: toInt(contentProfile.tier, toInt(options.tier, 0)),
      roomIndex,
      deliveryState: normalizeText(options.deliveryState, normalizeText(roomEntry.deliveryState, "")),
      transitionToken: toInt(options.transitionToken, toInt(roomEntry.deliveryTransitionToken, 0)),
      selectedRoomLayoutID: normalizeText(
        options.selectedRoomLayoutID,
        normalizeText(roomEntry.selectedRoomLayoutID, ""),
      ),
      roomOriginPosition: cloneValue(
        options.roomOriginPosition || roomEntry.roomOriginPosition,
      ) || null,
      authoredLocalPosition: cloneValue(options.authoredLocalPosition) || null,
      worldPosition: cloneValue(options.worldPosition) || null,
      cacheProfileID: normalizeText(options.cacheProfileID, ""),
      rewardProfileID: normalizeText(options.rewardProfileID, ""),
      rewardMultiplier: Number.isFinite(Number(options.rewardMultiplier))
        ? Number(options.rewardMultiplier)
        : getCacheRewardQuantityMultiplier(pocketState),
      roomRewardMultiplier: Number.isFinite(Number(options.roomRewardMultiplier))
        ? Number(options.roomRewardMultiplier)
        : 1,
      rewardQuantityBonus: toInt(options.rewardQuantityBonus, 0),
      allowEmptyManifest: options.allowEmptyManifest === true,
      cacheRewardMaterialized: options.cacheRewardMaterialized === true,
      sourceStructureItemID: toInt(options.sourceStructureItemID, 0),
      sourceStructureTypeID: toInt(options.sourceStructureTypeID, 0),
      dunObjectID: toInt(capturedCache && capturedCache.dunObjectID, 0),
      dunObjectNameID: capturedCache && capturedCache.dunObjectNameID,
      objectiveTargetGroup: toInt(capturedCache && capturedCache.objectiveTargetGroup, 0),
      dunPosition: capturedCache
        ? [
            toReal(capturedCache.position && capturedCache.position.x, 0),
            toReal(capturedCache.position && capturedCache.position.y, 0),
            toReal(capturedCache.position && capturedCache.position.z, 0),
          ]
        : null,
      dunRotation: capturedCache ? cloneValue(capturedCache.rotation) : null,
      capturedRetailProfile: Boolean(capturedCache),
      ...buildCapturedRetailIdentityState(ports,
        presentationIdentity,
        toInt(pocketState.rewardBeneficiaryCharacterID, pocketState.characterID),
        {
          rewardBeneficiaryCharacterID: toInt(
            pocketState.rewardBeneficiaryCharacterID,
            pocketState.characterID,
          ),
        },
      ),
      retailPresentationIdentity: Boolean(presentationIdentity),
      presentationEnabled: true,
      mechanicsEnabled: true,
      placeholderContent: cacheProfile.placeholderOnly === true,
    },
  });
}

function buildExtractionNodeCustomInfo(ports, pocketState, options = {}) {
  const {
    buildPlaceholderRoomState,
    ABYSSAL_ROOM_ENTITY_ROLES,
    listAbyssalParticipantCharacterIDs,
    clampRoomIndex,
  } = ports;
  const roomState = buildPlaceholderRoomState(pocketState);
  const role = normalizeText(options.role, "extraction_node_structure");
  const presentationIdentity = role === "extraction_node_structure"
    ? {
        // Retail captures publish both type 49661 and 49662 with the shared
        // Triglavian owner. Inventory and reward ownership remain with the
        // participant; this presentation owner selects the intended red skin.
        identityPolicy: "captured-retail",
        presentationOwnerID: 500021,
        namePolicy: "type-derived",
      }
    : null;
  return JSON.stringify({
    evejsAbyssalExtractionNode: {
      role,
      abyssalEntityRole:
        role === "extraction_node_loot_container"
          ? ABYSSAL_ROOM_ENTITY_ROLES.REWARD_WRECK
          : ABYSSAL_ROOM_ENTITY_ROLES.EXTRACTION_NODE,
      abyssalDefinitionID: normalizeText(
        options.abyssalDefinitionID,
        normalizeText(options.extractionNodeProfileID, ""),
      ),
      presentationEnabled: true,
      mechanicsEnabled: true,
      instanceID: toInt(pocketState.instanceID, 0),
      traceItemID: toInt(pocketState.traceItemID, 0),
      characterID: toInt(pocketState.characterID, 0),
      participantCharacterIDs: listAbyssalParticipantCharacterIDs(pocketState),
      shipID: toInt(pocketState.shipID, 0),
      solarSystemID: toInt(pocketState.solarSystemID, 0),
      roomIndex: clampRoomIndex(
        toInt(options.roomIndex, roomState.currentRoomIndex),
        roomState.implementedRooms,
      ),
      extractionNodeProfileID: normalizeText(options.extractionNodeProfileID, ""),
      nodeIndex: Math.max(1, toInt(options.nodeIndex, 1)),
      sourceStructureItemID: toInt(options.sourceStructureItemID, 0),
      sourceStructureTypeID: toInt(options.sourceStructureTypeID, 0),
      ...buildCapturedRetailIdentityState(ports,
        presentationIdentity,
        toInt(pocketState.rewardBeneficiaryCharacterID, pocketState.characterID),
        {
          rewardBeneficiaryCharacterID: toInt(
            pocketState.rewardBeneficiaryCharacterID,
            pocketState.characterID,
          ),
        },
      ),
      retailPresentationIdentity: Boolean(presentationIdentity),
      placeholderContent: role !== "extraction_node_structure",
    },
  });
}

function resolveTraceItemContext(ports, item) {
  const {
    GROUP_FILAMENT_TRACE,
    rehydratePersistedAbyssalContentProfile,
    getContentProfile,
    resolveAbyssalTraceProfile,
    ABYSSAL_TRACE_LIFECYCLE_PHASE,
    normalizeAbyssalTraceLifecyclePhase,
    buildAbyssalTraceSlimState,
    getAbyssalTracePhaseDefinition,
  } = ports;
  if (!item || toInt(item.groupID, 0) !== GROUP_FILAMENT_TRACE) {
    return null;
  }
  const parsed = parseCustomInfo(ports, item.customInfo);
  const rawState = parsed && parsed.evejsAbyssalTrace;
  if (!rawState || typeof rawState !== "object") {
    return null;
  }
  const activeTraceState = ports.getTraceState(
    toInt(rawState.traceItemID, toInt(item.itemID, 0)),
  ) || null;
  const contentProfile = rawState.contentProfile && typeof rawState.contentProfile === "object"
    ? rehydratePersistedAbyssalContentProfile(
        rawState.contentProfile,
        getContentProfile(activeTraceState),
      )
    : null;
  const profile = resolveAbyssalTraceProfile({
    traceProfileID: rawState.traceProfileID,
    filamentTypeID: rawState.filamentTypeID,
    contentProfile,
  });
  const fallbackPhase = toInt(rawState.activationState, 0) === 2
    ? ABYSSAL_TRACE_LIFECYCLE_PHASE.RETURNED
    : toInt(rawState.activationState, 0) === 1
      ? ABYSSAL_TRACE_LIFECYCLE_PHASE.ACTIVE
      : ABYSSAL_TRACE_LIFECYCLE_PHASE.CREATED;
  const lifecyclePhase = normalizeAbyssalTraceLifecyclePhase(
    rawState.lifecyclePhase,
    fallbackPhase,
  );
  const phaseSlimState = buildAbyssalTraceSlimState({
    ...rawState,
    contentProfile,
    lifecyclePhase,
  });
  const phaseDefinition = phaseSlimState && phaseSlimState.definition ||
    getAbyssalTracePhaseDefinition(profile, lifecyclePhase);
  const phaseSlimFields = phaseSlimState && phaseSlimState.slimFields || {};
  return { item, rawState, contentProfile, profile, lifecyclePhase, phaseDefinition, phaseSlimFields };
}

function buildTraceItemRuntimeState(ports, context) {
  const {
    ABYSSAL_PARTICIPANT_ROSTER_SCHEMA_VERSION,
    normalizeAbyssalParticipantRoster,
    cloneValue,
    ABYSSAL_PARTICIPANT_RETURN_OBLIGATION_SCHEMA_VERSION,
    getAbyssalParticipantReturnObligationsByCharacterID,
    TYPE_ABYSSAL_TRACE,
    GROUP_FILAMENT_TRACE,
  } = ports;
  const { item, rawState, contentProfile, profile, lifecyclePhase, phaseDefinition, phaseSlimFields } = context;
  return {
    traceItemID: toInt(rawState.traceItemID, toInt(item.itemID, 0)),
    characterID: toInt(rawState.characterID, 0),
    shipID: toInt(rawState.shipID, 0),
    solarSystemID: toInt(rawState.solarSystemID, toInt(item.locationID, 0)),
    filamentItemID: toInt(rawState.filamentItemID, 0),
    filamentTypeID: toInt(rawState.filamentTypeID, 0),
    fleetID: toInt(rawState.fleetID, 0),
    requiredFilaments: toInt(rawState.requiredFilaments, 0),
    maxShips: toInt(rawState.maxShips, 0),
    activateForFleet: rawState.activateForFleet === true,
    participantRosterSchemaVersion: toInt(
      rawState.participantRosterSchemaVersion,
      ABYSSAL_PARTICIPANT_ROSTER_SCHEMA_VERSION,
    ),
    participantRoster: normalizeAbyssalParticipantRoster(rawState),
    eligibleParticipantCharacterIDs: listUniquePositiveInts(
      rawState.eligibleParticipantCharacterIDs,
    ),
    rewardBeneficiaryCharacterID: toInt(
      rawState.rewardBeneficiaryCharacterID,
      toInt(rawState.characterID, 0),
    ),
    traceProfileID: normalizeText(rawState.traceProfileID, profile && profile.traceProfileID || ""),
    lifecyclePhase,
    abyssalRunID: toInt(rawState.abyssalRunID, 0),
    deploymentToken: normalizeText(rawState.deploymentToken, ""),
    automaticActivation:
      rawState.automaticActivation && typeof rawState.automaticActivation === "object"
        ? cloneValue(rawState.automaticActivation)
        : null,
    filamentConsumptionState:
      rawState.filamentConsumptionState && typeof rawState.filamentConsumptionState === "object"
        ? cloneValue(rawState.filamentConsumptionState)
        : null,
    returnProtectionState:
      rawState.returnProtectionState && typeof rawState.returnProtectionState === "object"
        ? cloneValue(rawState.returnProtectionState)
        : null,
    participantReturnObligationsSchemaVersion: toInt(
      rawState.participantReturnObligationsSchemaVersion,
      ABYSSAL_PARTICIPANT_RETURN_OBLIGATION_SCHEMA_VERSION,
    ),
    participantReturnObligationsByCharacterID:
      getAbyssalParticipantReturnObligationsByCharacterID(rawState),
    publicationReceipt:
      rawState.publicationReceipt && typeof rawState.publicationReceipt === "object"
        ? cloneValue(rawState.publicationReceipt)
        : null,
    publicationStatus: normalizeText(rawState.publicationStatus, ""),
    abyssalTraceRole: normalizeText(rawState.abyssalTraceRole, "source-kspace-trace"),
    sourceSolarSystemID: toInt(rawState.sourceSolarSystemID, toInt(rawState.solarSystemID, toInt(item.locationID, 0))),
    sourceSceneKey: normalizeText(rawState.sourceSceneKey, ""),
    sourceTracePosition: getObjectPosition(rawState.sourceTracePosition) || getObjectPosition(item.spaceState),
    sourceShipPosition: getObjectPosition(rawState.sourceShipPosition),
    sourceShipDirection: normalizeDirection(rawState.sourceShipDirection, { x: 1, y: 0, z: 0 }),
    sourceShipRadius: toReal(rawState.sourceShipRadius, 0),
    traceOrientation: cloneValue(rawState.traceOrientation),
    ownerID: toInt(rawState.ownerID, toInt(item.ownerID, 0)),
    typeID: toInt(rawState.typeID, toInt(item.typeID, TYPE_ABYSSAL_TRACE)),
    groupID: toInt(rawState.groupID, toInt(item.groupID, GROUP_FILAMENT_TRACE)),
    returnedAtMs: toInt(rawState.returnedAtMs, 0),
    removalScheduled: rawState.removalScheduled === true,
    removalDeadlineMs: toInt(rawState.removalDeadlineMs, 0),
    gameModeID: toInt(rawState.gameModeID, toInt(phaseSlimFields.gameModeID, 0)),
    abyssFilamentTypeID: toInt(rawState.abyssFilamentTypeID, toInt(rawState.filamentTypeID, 0)),
    activationState: toInt(
      rawState.activationState,
      toInt(
        phaseSlimFields.activationState,
        toInt(phaseDefinition && phaseDefinition.controllerActivationStateDefault, 0),
      ),
    ),
    isAbyssGateOpen: rawState.isAbyssGateOpen === undefined
      ? phaseSlimFields.isAbyssGateOpen === true
      : rawState.isAbyssGateOpen === true,
    deployedAtMs: toInt(rawState.deployedAtMs, 0),
    expiresAtMs: toInt(rawState.expiresAtMs, 0),
    shipClass: normalizeText(rawState.shipClass, ""),
    filamentName: normalizeText(rawState.filamentName, ""),
    shipTypeID: toInt(rawState.shipTypeID, 0),
    securityPolicy:
      rawState.securityPolicy && typeof rawState.securityPolicy === "object"
        ? cloneValue(rawState.securityPolicy)
        : null,
    suspectOnReturn: rawState.suspectOnReturn === true,
    suspectReturnState:
      rawState.suspectReturnState && typeof rawState.suspectReturnState === "object"
        ? cloneValue(rawState.suspectReturnState)
        : null,
    contentProfile,
    placeholderContent: rawState.placeholderContent !== false,
  };
}

function readTraceStateFromItem(ports, item) {
  const context = resolveTraceItemContext(ports, item);
  return context ? buildTraceItemRuntimeState(ports, context) : null;
}

function readRewardCacheStateFromItem(ports, item) {
  if (!item) {
    return null;
  }
  const parsed = parseCustomInfo(ports, item.customInfo);
  const rawState = parsed && parsed.evejsAbyssalRewardCache;
  if (!rawState || typeof rawState !== "object") {
    return null;
  }
  return {
    role: normalizeText(rawState.role, "cache_structure"),
    abyssalEntityRole: normalizeText(rawState.abyssalEntityRole, ""),
    abyssalDefinitionID: normalizeText(rawState.abyssalDefinitionID, ""),
    presentationEnabled: rawState.presentationEnabled !== false,
    mechanicsEnabled: rawState.mechanicsEnabled !== false,
    instanceID: toInt(rawState.instanceID, 0),
    traceItemID: toInt(rawState.traceItemID, 0),
    characterID: toInt(rawState.characterID, 0),
    shipID: toInt(rawState.shipID, 0),
    solarSystemID: toInt(rawState.solarSystemID, toInt(item.locationID, 0)),
    roomIndex: toInt(rawState.roomIndex, 1),
    tier: toInt(rawState.tier, 0),
    cacheProfileID: normalizeText(rawState.cacheProfileID, ""),
    rewardProfileID: normalizeText(rawState.rewardProfileID, ""),
    rewardMultiplier: Number.isFinite(Number(rawState.rewardMultiplier))
      ? Number(rawState.rewardMultiplier)
      : 1,
    roomRewardMultiplier: Number.isFinite(Number(rawState.roomRewardMultiplier))
      ? Number(rawState.roomRewardMultiplier)
      : 1,
    rewardQuantityBonus: toInt(rawState.rewardQuantityBonus, 0),
    cacheRewardMaterialized: rawState.cacheRewardMaterialized === true,
    sourceStructureItemID: toInt(rawState.sourceStructureItemID, 0),
    sourceStructureTypeID: toInt(rawState.sourceStructureTypeID, 0),
    placeholderContent: rawState.placeholderContent !== false,
  };
}

function readExtractionNodeStateFromItem(ports, item) {
  if (!item) {
    return null;
  }
  const parsed = parseCustomInfo(ports, item.customInfo);
  const rawState = parsed && parsed.evejsAbyssalExtractionNode;
  if (!rawState || typeof rawState !== "object") {
    return null;
  }
  return {
    role: normalizeText(rawState.role, "extraction_node_structure"),
    abyssalEntityRole: normalizeText(rawState.abyssalEntityRole, ""),
    abyssalDefinitionID: normalizeText(rawState.abyssalDefinitionID, ""),
    presentationEnabled: rawState.presentationEnabled !== false,
    mechanicsEnabled: rawState.mechanicsEnabled !== false,
    instanceID: toInt(rawState.instanceID, 0),
    traceItemID: toInt(rawState.traceItemID, 0),
    characterID: toInt(rawState.characterID, 0),
    shipID: toInt(rawState.shipID, 0),
    solarSystemID: toInt(rawState.solarSystemID, toInt(item.locationID, 0)),
    roomIndex: toInt(rawState.roomIndex, 1),
    extractionNodeProfileID: normalizeText(rawState.extractionNodeProfileID, ""),
    nodeIndex: Math.max(1, toInt(rawState.nodeIndex, 1)),
    sourceStructureItemID: toInt(rawState.sourceStructureItemID, 0),
    sourceStructureTypeID: toInt(rawState.sourceStructureTypeID, 0),
    placeholderContent: rawState.placeholderContent !== false,
  };
}

function inspectAbyssalTaggedSpaceItem(ports, item) {
  const {
    readPocketMarkerStateFromItem,
    readEnvironmentalObjectStateFromItem,
    resolveEntityInteractionScope,
    resolveExactAbyssalRunRoomScope,
    CATEGORY_SHIP,
    isCorpseType,
  } = ports;
  const traceState = readTraceStateFromItem(ports, item);
  if (traceState) {
    return {
      itemID: toInt(item && item.itemID, 0),
      role: "entranceTrace",
      state: traceState,
      activeKey: traceState.traceItemID,
    };
  }
  const markerState = readPocketMarkerStateFromItem(item);
  if (markerState) {
    return {
      itemID: toInt(item && item.itemID, 0),
      role: markerState.markerKind === "exit" ? "conduitOrExitMarker" : "originMarker",
      state: markerState,
      activeKey: markerState.instanceID,
    };
  }
  const rewardCacheState = readRewardCacheStateFromItem(ports, item);
  if (rewardCacheState) {
    return {
      itemID: toInt(item && item.itemID, 0),
      role: "rewardCache",
      state: rewardCacheState,
      activeKey: rewardCacheState.instanceID,
    };
  }
  const extractionNodeState = readExtractionNodeStateFromItem(ports, item);
  if (extractionNodeState) {
    return {
      itemID: toInt(item && item.itemID, 0),
      role: "extractionNode",
      state: extractionNodeState,
      activeKey: extractionNodeState.instanceID,
    };
  }
  const environmentalObjectState = readEnvironmentalObjectStateFromItem(item);
  if (environmentalObjectState) {
    return {
      itemID: toInt(item && item.itemID, 0),
      role: "environmentalObject",
      state: environmentalObjectState,
      activeKey: environmentalObjectState.instanceID,
    };
  }
  const interactionScope = resolveEntityInteractionScope(item);
  const exactAbyssalScope = resolveExactAbyssalRunRoomScope(item);
  if (exactAbyssalScope) {
    if (toInt(item && item.categoryID, 0) === CATEGORY_SHIP) {
      return {
        itemID: toInt(item && item.itemID, 0),
        role: "unknownTaggedArtifact",
        state: {
          reason: "RUN_SCOPED_PLAYER_SHIP_NOT_CLEANUP_AUTHORITY",
          runID: exactAbyssalScope.runID,
          roomIndex: exactAbyssalScope.roomIndex,
        },
        activeKey: exactAbyssalScope.runID,
      };
    }
    return {
      itemID: toInt(item && item.itemID, 0),
      role: isCorpseType(item) ? "runScopedCorpse" : "runScopedPlayerArtifact",
      state: {
        runID: exactAbyssalScope.runID,
        roomIndex: exactAbyssalScope.roomIndex,
      },
      activeKey: exactAbyssalScope.runID,
    };
  }
  const parsed = parseCustomInfo(ports, item && item.customInfo);
  const taggedKeys = parsed && typeof parsed === "object"
    ? Object.keys(parsed).filter((key) => key.startsWith("evejsAbyssal"))
    : [];
  if (
    taggedKeys.length > 0 ||
    (interactionScope && interactionScope.hasAbyssalScope === true)
  ) {
    return {
      itemID: toInt(item && item.itemID, 0),
      role: "unknownTaggedArtifact",
      state: {
        taggedKeys,
        reason:
          interactionScope && interactionScope.hasAbyssalScope === true
            ? interactionScope.valid === true
              ? "LEGACY_OR_INCOMPLETE_PLAYER_SCOPE"
              : "INVALID_OR_CONFLICTING_PLAYER_SCOPE"
            : "UNKNOWN_AUTHORED_SCOPE",
      },
      activeKey:
        interactionScope && interactionScope.valid === true
          ? toInt(interactionScope.abyssalInstanceID, 0)
          : 0,
    };
  }
  return null;
}

function createAbyssalItemMetadata(ports) {
  return {
    parseCustomInfo: parseCustomInfo.bind(null, ports),
    buildTraceCustomInfo: buildTraceCustomInfo.bind(null, ports),
    buildCapturedRetailIdentityState: buildCapturedRetailIdentityState.bind(null, ports),
    buildRewardCacheCustomInfo: buildRewardCacheCustomInfo.bind(null, ports),
    buildExtractionNodeCustomInfo: buildExtractionNodeCustomInfo.bind(null, ports),
    readTraceStateFromItem: readTraceStateFromItem.bind(null, ports),
    readRewardCacheStateFromItem: readRewardCacheStateFromItem.bind(null, ports),
    readExtractionNodeStateFromItem: readExtractionNodeStateFromItem.bind(null, ports),
    inspectAbyssalTaggedSpaceItem: inspectAbyssalTaggedSpaceItem.bind(null, ports),
  };
}

module.exports = { createAbyssalItemMetadata };
