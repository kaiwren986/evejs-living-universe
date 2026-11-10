"use strict";

module.exports = {
  applyAbyssalDeliveryMetadataFromState,
  applyCapturedRetailIdentityFromState,
  classifyAbyssalBootstrapEntity,
  hydrateAbyssalPocketMarkerEntityFromInventoryItem,
  hydrateAbyssalRuntimeArtifactEntityFromInventoryItem,
  hydrateAbyssalTraceEntityFromInventoryItem,
  isAbyssalRoomEntityAwaitingRelease,
  isAbyssalRoomEntityDeliveryHidden,
  isAbyssalVisualOnlyEntity,
  shouldHydrateInventoryItemIntoScene,
  summarizeAbyssalBootstrapInventory,
};

const runtimeEntryDirname = require("path").resolve(__dirname, "..");
const path = require("path");
const {
  MAX_GATE_ACTIVATION_SURFACE_DISTANCE_METERS,
} = require("../../abyssal").engineSupport.gateActivationRange;
const {
  ABYSSAL_LOCATION_ID_MIN,
  ABYSSAL_LOCATION_ID_COUNT,
  isAbyssalHostLocationID,
} = require("../../abyssal").engineSupport.hostLocation;
const {
  ABYSSAL_ROOM_ENTITY_ROLES,
  resolveAbyssalRoomEntityRole,
  applyAbyssalRoomEntityMetadata,
  summarizeAbyssalRoomEntities,
  formatAbyssalRoomEntityCountsForLog,
} = require("../../abyssal").engineSupport.roomEntityRoles;
const {
  TYPE_ABYSSAL_TRACE,
  applyAbyssalGatePresentationState,
  applyAbyssalTracePresentationState,
} = require("../../abyssal").engineSupport.gatePresentation;
const {
  ABYSSAL_TRACE_LIFECYCLE_PHASE,
  applyAbyssalTraceProfileToEntity,
  resolveAbyssalTraceProfile,
} = require("../../abyssal").engineSupport.traceProfiles;
const {
  createAbyssalInventoryClassifier,
} = require("../../abyssal").engineSupport.inventoryClassification;
const {
  CAPSULE_TYPE_ID,
  CAPSULE_TYPE_ID_GOLDEN,
  ITEM_FLAGS,
  updateShipItem,
  updateInventoryItem,
  removeInventoryItem,
  getShipConditionState,
  normalizeShipConditionState,
  getItemMetadata,
  pruneExpiredSpaceItems,
} = require(path.join(runtimeEntryDirname, "../services/inventory/itemStore"));
const {
  resolveItemByTypeID,
} = require(path.join(runtimeEntryDirname, "../services/inventory/itemTypeRegistry"));
const {
  parseInventoryCustomInfo,
} = require("./inventoryCustomInfo");
const {
  toFiniteNumber,
  toInt,
} = require("../../common/numbers");
const {
  SCENE_KIND_ABYSSAL,
  normalizeSceneText,
} = require("./sceneIdentity");
const {
  coerceDunRotationTuple,
} = require("./staticSceneEntity");
const {
  cloneVector,
} = require("../../common/vector");

const ABYSSAL_TRACE_GATE_ACTIVATION_RANGE_METERS =
  MAX_GATE_ACTIVATION_SURFACE_DISTANCE_METERS;

const ABYSSAL_CONDUIT_GATE_ACTIVATION_RANGE_METERS =
  MAX_GATE_ACTIVATION_SURFACE_DISTANCE_METERS;

const ACCELERATION_GATE_SLIM_GROUP_ID = 366;

const TYPE_ABYSSAL_BIOCOMBINATIVE_CACHE = 49689;

const TYPE_CAPTURED_TRIGLAVIAN_BIOADAPTIVE_CACHE = 47951;

const TYPE_ABYSSAL_EXTRACTION_SUBNODE = 49661;

const TYPE_ABYSSAL_EXTRACTION_NODE = 49662;

const ABYSSAL_FORBIDDEN_PERSISTENT_PLAYER_CATEGORIES = new Set([
  22, // Deployable
  23, // Starbase
  40, // Sovereignty Structure
  46, // Orbital
  65, // Structure
]);

const ABYSSAL_TELEPORT_TRANSITION_BYPASS = Symbol(
  "abyssalTeleportTransitionBypass",
);

const ABYSSAL_ROOM_DELIVERY_STATE = Object.freeze({
  PREWARMED_HIDDEN: "prewarmed-hidden",
  TRANSITION_PENDING: "transition-pending",
  DELIVERY_COMMITTED: "delivery-committed",
  VISIBLE: "visible",
  RETIRED: "retired",
});

const ABYSSAL_HIDDEN_ROOM_DELIVERY_STATES = new Set([
  ABYSSAL_ROOM_DELIVERY_STATE.PREWARMED_HIDDEN,
  ABYSSAL_ROOM_DELIVERY_STATE.TRANSITION_PENDING,
  ABYSSAL_ROOM_DELIVERY_STATE.DELIVERY_COMMITTED,
  ABYSSAL_ROOM_DELIVERY_STATE.RETIRED,
]);

function isAbyssalRoomEntityDeliveryHidden(entity) {
  if (!entity || typeof entity !== "object") return false;
  return ABYSSAL_HIDDEN_ROOM_DELIVERY_STATES.has(
    String(
      entity.abyssalRoomDeliveryState ||
      entity.evejsAbyssalRoomDeliveryState ||
      "",
    ).trim().toLowerCase(),
  );
}

// A room's content held out until its room is released (prewarmed, or
// pending its transition): the hidden states before a release. Content still
// delivery-committed missed its release, and retired content is a room
// already left.
const ABYSSAL_AWAITING_RELEASE_DELIVERY_STATES = new Set([
  ABYSSAL_ROOM_DELIVERY_STATE.PREWARMED_HIDDEN,
  ABYSSAL_ROOM_DELIVERY_STATE.TRANSITION_PENDING,
]);

function isAbyssalRoomEntityAwaitingRelease(entity) {
  if (!entity || typeof entity !== "object") return false;
  return ABYSSAL_AWAITING_RELEASE_DELIVERY_STATES.has(
    String(
      entity.abyssalRoomDeliveryState ||
      entity.evejsAbyssalRoomDeliveryState ||
      "",
    ).trim().toLowerCase(),
  );
}

function applyAbyssalDeliveryMetadataFromState(entity, state = null) {
  if (!entity || !state || typeof state !== "object") return entity;
  const deliveryState = String(state.deliveryState || state.abyssalRoomDeliveryState || "")
    .trim().toLowerCase();
  const runtimeDeliveryState = String(
    entity.abyssalRoomDeliveryState || entity.evejsAbyssalRoomDeliveryState || "",
  ).trim().toLowerCase();
  const runtimeStateIsAuthoritative = Boolean(
    runtimeDeliveryState &&
    toInt(
      entity.abyssalRunID,
      toInt(entity.evejsAbyssalInstanceID, toInt(entity.evejsAbyssalPocketInstanceID, 0)),
    ) > 0 &&
    toInt(entity.abyssalRoomIndex, toInt(entity.evejsAbyssalRoomIndex, 0)) > 0,
  );
  const applyPersistedDeliveryMetadata = Boolean(
    !runtimeStateIsAuthoritative ||
    !deliveryState ||
    runtimeDeliveryState === deliveryState,
  );
  if (deliveryState && applyPersistedDeliveryMetadata) {
    entity.abyssalRoomDeliveryState = deliveryState;
    entity.evejsAbyssalRoomDeliveryState = deliveryState;
  }
  if (applyPersistedDeliveryMetadata) {
    entity.abyssalTransitionToken = toInt(
      state.transitionToken,
      toInt(state.deliveryTransitionToken, 0),
    );
    entity.evejsAbyssalTransitionToken = entity.abyssalTransitionToken;
    entity.abyssalSelectedRoomLayoutID = normalizeSceneText(
      state.selectedRoomLayoutID || state.selectedLayoutID,
      entity.abyssalSelectedRoomLayoutID || "",
    );
    entity.evejsAbyssalRoomOriginPosition = state.roomOriginPosition || null;
    entity.evejsAbyssalAuthoredLocalPosition = state.authoredLocalPosition || null;
  }
  return entity;
}

const ABYSSAL_TIER1_REWARD_STRUCTURE_DURABILITY = Object.freeze({
  shieldCapacity: 0,
  shieldRechargeRate: 0,
  armorHP: 0,
  structureHP: 400,
});

const {
  isInventoryAbyssalTrace,
  getInventoryAbyssalPocketMarkerInfo,
  getInventoryAbyssalPlayerCompanionInfo,
  getInventoryAbyssalRuntimeArtifactInfo,
  getInventoryAbyssalRunOwnership,
} = createAbyssalInventoryClassifier({ parseInventoryCustomInfo });

function shouldHydrateInventoryItemIntoScene(item, descriptor) {
  const ownership = getInventoryAbyssalRunOwnership(item);
  const isReservedAbyssalHostItem = [
    item && item.locationID,
    item && item.systemID,
    item && item.solarSystemID,
    item && item.spaceState && item.spaceState.systemID,
  ].some((locationID) => isAbyssalHostLocationID(locationID));

  // A reserved host is shared implementation capacity, never a public solar
  // system.  Refuse to materialize orphaned or partially tagged inventory
  // there: family-specific hydration may disable mechanics, but by then the
  // base entity has already entered the private scene and can be discovered.
  if (isReservedAbyssalHostItem) {
    if (
      ownership &&
      ownership.kind === "player_launched_entity" &&
      ABYSSAL_FORBIDDEN_PERSISTENT_PLAYER_CATEGORIES.has(
        toInt(item && item.categoryID, 0),
      )
    ) {
      return false;
    }
    return Boolean(
      ownership &&
        ownership.invalid !== true &&
        ownership.instanceID > 0 &&
        ownership.roomIndex > 0 &&
        descriptor &&
        descriptor.sceneKind === SCENE_KIND_ABYSSAL &&
        toInt(descriptor.instanceID, 0) === ownership.instanceID
    );
  }
  if (ownership && ownership.invalid === true) {
    return false;
  }
  if (!ownership || ownership.instanceID <= 0) {
    return true;
  }
  return Boolean(
    descriptor &&
      descriptor.sceneKind === SCENE_KIND_ABYSSAL &&
      toInt(descriptor.instanceID, 0) === ownership.instanceID
  );
}

function applyCapturedRetailIdentityFromState(entity, item, identityState) {
  if (!entity || !identityState || typeof identityState !== "object" ||
      normalizeSceneText(identityState.identityPolicy, "") !== "captured-retail") {
    return entity;
  }
  entity.inventoryOwnerID = Math.max(0, toInt(
    identityState.inventoryOwnerID,
    toInt(item && item.ownerID, toInt(entity.ownerID, 0)),
  ));
  const presentationOwnerID = Math.max(0, toInt(identityState.presentationOwnerID, 0));
  if (presentationOwnerID > 0) entity.ownerID = presentationOwnerID;
  if (Number.isFinite(Number(identityState.friendlyResponseThreshold))) {
    entity.friendlyResponseThreshold = Number(identityState.friendlyResponseThreshold);
  }
  if (Number.isFinite(Number(identityState.hostileResponseThreshold))) {
    entity.hostileResponseThreshold = Number(identityState.hostileResponseThreshold);
  }
  const fieldMap = {
    corporationID: "corporationID",
    allianceID: "allianceID",
    warFactionID: "warFactionID",
    charID: "characterID",
  };
  for (const [stateField, entityField] of Object.entries(fieldMap)) {
    if (Object.prototype.hasOwnProperty.call(identityState, stateField)) {
      entity[entityField] = identityState[stateField];
    }
  }
  const namePolicy = normalizeSceneText(identityState.namePolicy, "type-derived");
  const displayName = normalizeSceneText(identityState.displayName, "");
  if (namePolicy === "type-derived") {
    entity.suppressSlimName = true;
    entity.nameID = undefined;
  } else if (namePolicy === "captured-explicit" && displayName) {
    entity.suppressSlimName = false;
    entity.slimName = displayName;
    entity.itemName = displayName;
    entity.nameID = undefined;
  }
  entity.evejsAbyssalIdentityPolicy = "captured-retail";
  entity.evejsAbyssalNamePolicy = namePolicy;
  entity.evejsAbyssalCapturedRetailObject = true;
  entity.evejsAbyssalRewardBeneficiaryCharacterID = Math.max(
    0,
    toInt(identityState.rewardBeneficiaryCharacterID, 0),
  );
  return entity;
}

function hydrateAbyssalPocketMarkerEntityFromInventoryItem(entity, item) {
  const markerInfo = getInventoryAbyssalPocketMarkerInfo(item);
  if (!entity || !markerInfo) {
    return entity;
  }
  const markerKind = String(markerInfo.markerKind || "origin").trim().toLowerCase() || "origin";
  entity.evejsAbyssalPocketMarker = true;
  entity.evejsAbyssalPocketMarkerKind = markerKind;
  entity.evejsAbyssalPocketInstanceID = Math.max(0, toInt(markerInfo.instanceID, 0));
  entity.evejsAbyssalTrace = undefined;
  applyAbyssalRoomEntityMetadata(entity, {
    role: normalizeSceneText(markerInfo.abyssalEntityRole, "") || (
      markerKind === "exit"
        ? ABYSSAL_ROOM_ENTITY_ROLES.CONDUIT
        : ABYSSAL_ROOM_ENTITY_ROLES.ORIGIN_MARKER
    ),
    abyssalRunID: toInt(markerInfo.instanceID, 0),
    abyssalRoomIndex: toInt(markerInfo.roomIndex, 0),
    abyssalDefinitionID: normalizeSceneText(markerInfo.abyssalDefinitionID, ""),
    presentationEnabled: markerInfo.presentationEnabled !== false,
    mechanicsEnabled: markerInfo.mechanicsEnabled === true,
  });
  applyCapturedRetailIdentityFromState(entity, item, markerInfo);
  applyAbyssalDeliveryMetadataFromState(entity, markerInfo);
  if (markerKind !== "exit") {
    return entity;
  }
  entity.ballInteractive = true;
  entity.slimGroupID = ACCELERATION_GATE_SLIM_GROUP_ID;
  applyAbyssalGatePresentationState(entity, {
    open: markerInfo.conduitOpen === true,
    conduitOpenedAtMs: markerInfo.conduitOpenedAtMs,
  });
  entity.gateActivationRange = ABYSSAL_CONDUIT_GATE_ACTIVATION_RANGE_METERS;
  entity.interactionRadius = Math.max(
    toFiniteNumber(entity.interactionRadius, 0),
    toFiniteNumber(entity.radius, 0),
  );
  entity.dungeonObjectID =
    Math.max(0, toInt(markerInfo.dunObjectID, 0)) ||
    Math.max(0, toInt(item && item.itemID, 0)) ||
    null;
  entity.dunObjectID = entity.dungeonObjectID;
  entity.dunPosition = Array.isArray(markerInfo.dunPosition) && markerInfo.dunPosition.length === 3
    ? markerInfo.dunPosition.map((entry) => Number(entry) || 0)
    : entity.position
      ? cloneVector(entity.position)
      : undefined;
  entity.dunRotation = coerceDunRotationTuple(markerInfo.dunRotation);
  entity.evejsAbyssalCapturedRetailObject = markerInfo.capturedRetailObject === true;
  return entity;
}

function hydrateAbyssalRuntimeArtifactEntityFromInventoryItem(entity, item) {
  const artifactInfo = getInventoryAbyssalRuntimeArtifactInfo(item);
  if (!entity || !artifactInfo) {
    return entity;
  }
  const instanceID = Math.max(0, toInt(artifactInfo.info && artifactInfo.info.instanceID, 0));
  entity.evejsAbyssalInstanceID = instanceID;
  entity.evejsAbyssalArtifactKind = artifactInfo.kind;
  entity.evejsAbyssalArtifactState = artifactInfo.info;
  const artifactState = artifactInfo.info || {};
  applyAbyssalRoomEntityMetadata(entity, {
    role: normalizeSceneText(artifactState.abyssalEntityRole, "") ||
      resolveAbyssalRoomEntityRole({
        ...entity,
        role: artifactState.role,
        typeID: item && item.typeID,
      }),
    abyssalRunID: instanceID,
    abyssalRoomIndex: toInt(artifactState.roomIndex, 0),
    abyssalDefinitionID: normalizeSceneText(artifactState.abyssalDefinitionID, ""),
    presentationEnabled: artifactState.presentationEnabled !== false,
    mechanicsEnabled: artifactState.mechanicsEnabled === true,
  });
  applyCapturedRetailIdentityFromState(entity, item, artifactState);
  applyAbyssalDeliveryMetadataFromState(entity, artifactState);
  if (artifactInfo.kind === "reward_cache") {
    entity.evejsAbyssalRewardCache = true;
    const info = artifactInfo.info || {};
    if (
      String(info.role || "").trim() === "cache_loot_container" &&
      toInt(info.sourceStructureTypeID, 0) > 0
    ) {
      entity.suppressSlimName = true;
      entity.nameID = [
        "UI/Inflight/WreckNameTypeID",
        {
          WreckTypeID: toInt(info.sourceStructureTypeID, 0),
        },
      ];
    }
    entity.dungeonObjectID =
      Math.max(0, toInt(info.dunObjectID, 0)) ||
      Math.max(0, toInt(item && item.itemID, 0)) ||
      null;
    entity.dunObjectID = entity.dungeonObjectID;
    if (info.dunObjectNameID !== null && info.dunObjectNameID !== undefined) {
      entity.dunObjectNameID = toInt(info.dunObjectNameID, 0);
    }
    entity.objectiveTargetGroup = toInt(info.objectiveTargetGroup, 0);
    if (Array.isArray(info.dunPosition) && info.dunPosition.length === 3) {
      entity.dunPosition = info.dunPosition.map((entry) => Number(entry) || 0);
    } else {
      entity.dunPosition = entity.position ? cloneVector(entity.position) : undefined;
    }
    entity.dunRotation = coerceDunRotationTuple(info.dunRotation);
  }
  if (artifactInfo.kind === "extraction_node") {
    entity.evejsAbyssalExtractionNode = true;
    const info = artifactInfo.info || {};
    if (
      String(info.role || "").trim() === "extraction_node_loot_container" &&
      toInt(info.sourceStructureTypeID, 0) > 0
    ) {
      entity.suppressSlimName = true;
      entity.nameID = [
        "UI/Inflight/WreckNameTypeID",
        {
          WreckTypeID: toInt(info.sourceStructureTypeID, 0),
        },
      ];
    }
  }
  if (artifactInfo.kind === "environmental_object") {
    const info = artifactInfo.info || {};
    entity.evejsAbyssalEnvironmentalObject = true;
    entity.evejsAbyssalRoomIndex = Math.max(0, toInt(info.roomIndex, 0));
    entity.evejsAbyssalEnvironmentalProfileID = String(info.profileID || "");
    entity.evejsAbyssalEnvironmentalEffectKind = String(info.effectKind || "");
    entity.evejsAbyssalEnvironmentalPresentationEnabled = info.presentationEnabled === true;
    entity.evejsAbyssalEnvironmentalMechanicsEnabled = info.mechanicsEnabled === true;
    entity.evejsAbyssalEnvironmentalDestructible = info.destructible === true;
    entity.evejsAbyssalEnvironmentalMechanicsProfileID = String(
      info.mechanicsProfileID || "",
    );
    entity.evejsAbyssalEnvironmentalPresentationRadiusMeters = Number.isFinite(
      Number(info.presentationRadiusMeters),
    )
      ? Number(info.presentationRadiusMeters)
      : 0;
    if (
      String(info.effectKind || "") === "boundary_damage" &&
      entity.evejsAbyssalEnvironmentalPresentationRadiusMeters > 0
    ) {
      // Type 47465's boundary_bubble.red has no controller radius field. Its
      // Destiny ball radius is the presentation scale consumed by the client.
      entity.radius = entity.evejsAbyssalEnvironmentalPresentationRadiusMeters;
    }
    if (
      String(info.effectKind || "") === "boundary_presentation" &&
      Number.isFinite(Number(info.perimeterRadius)) &&
      Number(info.perimeterRadius) > 0
    ) {
      // Type 54196 drives its circle through perimeterRadius, but the client
      // still uses the Destiny ball radius as the model's presentation bounds.
      entity.radius = Number(info.perimeterRadius);
    }
    entity.evejsAbyssalEnvironmentalMechanicsRangeMeters = Number.isFinite(
      Number(info.mechanicsRangeMeters),
    )
      ? Number(info.mechanicsRangeMeters)
      : 0;
    entity.evejsAbyssalEnvironmentalActivationDurationMs = Math.max(
      0,
      toInt(info.activationDurationMs, 0),
    );
    entity.evejsAbyssalEnvironmentalDogmaEffectID = Math.max(
      0,
      toInt(info.dogmaEffectID, 0),
    );
    entity.evejsAbyssalEnvironmentalTargetTypeListID = Math.max(
      0,
      toInt(info.targetTypeListID, 0),
    );
    entity.evejsAbyssalEnvironmentalResolvedTargetClasses = Array.isArray(
      info.resolvedTargetClasses,
    )
      ? [...info.resolvedTargetClasses]
      : [];
    entity.evejsAbyssalEnvironmentProfileID = String(info.environmentProfileID || "");
    entity.evejsAbyssalEnvironmentLayoutVariant = String(info.layoutVariant || "");
    entity.evejsAbyssalSceneCubeResource = String(info.sceneCubeResource || "");
    entity.evejsAbyssalVolumetricCloudResource = String(info.volumetricCloudResource || "");
    entity.evejsAbyssalNearFieldResource = String(info.nearFieldResource || "");
    entity.evejsAbyssalLensFlareResource = String(info.lensFlareResource || "");
    entity.evejsAbyssalGradientResource = String(info.gradientResource || "");
    entity.evejsAbyssalTransitionEffect = String(info.transitionEffect || "");
    entity.evejsAbyssalRoomLayoutProfileID = String(info.roomLayoutProfileID || "");
    entity.evejsAbyssalEnvironmentalRadiusMeters = Number.isFinite(Number(info.radiusMeters))
      ? Number(info.radiusMeters)
      : 0;
    entity.ballInteractive = entity.evejsAbyssalEnvironmentalDestructible;
    entity.targetable = entity.evejsAbyssalEnvironmentalDestructible;
    entity.damageable = entity.evejsAbyssalEnvironmentalDestructible;
    entity.dungeonSiteContentDestructible = entity.evejsAbyssalEnvironmentalDestructible;
    entity.dungeonObjectID =
      Math.max(0, toInt(info.dunObjectID, 0)) ||
      Math.max(0, toInt(item && item.itemID, 0)) ||
      null;
    entity.dunObjectID = entity.dungeonObjectID;
    if (info.dunObjectNameID !== null && info.dunObjectNameID !== undefined) {
      entity.dunObjectNameID = toInt(info.dunObjectNameID, 0);
    }
    entity.objectiveTargetGroup =
      info.objectiveTargetGroup === null || info.objectiveTargetGroup === undefined
        ? null
        : toInt(info.objectiveTargetGroup, 0);
    if (Array.isArray(info.dunPosition) && info.dunPosition.length === 3) {
      entity.dunPosition = info.dunPosition.map((entry) => Number(entry) || 0);
    } else {
      entity.dunPosition = entity.position ? cloneVector(entity.position) : undefined;
    }
    entity.dunRotation = coerceDunRotationTuple(info.dunRotation);
    if (Number.isFinite(Number(info.perimeterRadius)) && Number(info.perimeterRadius) > 0) {
      entity.perimeterRadius = Number(info.perimeterRadius);
    }
    if (Number.isFinite(Number(info.perimeterLook)) && Number(info.perimeterLook) > 0) {
      entity.perimeterLook = toInt(info.perimeterLook, 0);
    }
  }
  if (artifactInfo.kind === "jettison_container") {
    entity.evejsAbyssalJettisonContainer = true;
  }
  if (
    toInt(item && item.typeID, 0) === TYPE_ABYSSAL_BIOCOMBINATIVE_CACHE ||
    toInt(item && item.typeID, 0) === TYPE_CAPTURED_TRIGLAVIAN_BIOADAPTIVE_CACHE ||
    toInt(item && item.typeID, 0) === TYPE_ABYSSAL_EXTRACTION_SUBNODE ||
    toInt(item && item.typeID, 0) === TYPE_ABYSSAL_EXTRACTION_NODE
  ) {
    entity.ballInteractive = true;
    entity.targetable = true;
    entity.shieldCapacity = ABYSSAL_TIER1_REWARD_STRUCTURE_DURABILITY.shieldCapacity;
    entity.shieldRechargeRate = ABYSSAL_TIER1_REWARD_STRUCTURE_DURABILITY.shieldRechargeRate;
    entity.armorHP = ABYSSAL_TIER1_REWARD_STRUCTURE_DURABILITY.armorHP;
    entity.structureHP = ABYSSAL_TIER1_REWARD_STRUCTURE_DURABILITY.structureHP;
    entity.passiveDerivedState = {
      ...(entity.passiveDerivedState || {}),
      shieldCapacity: entity.shieldCapacity,
      shieldRechargeRate: entity.shieldRechargeRate,
      armorHP: entity.armorHP,
      structureHP: entity.structureHP,
    };
  }
  return entity;
}

function hydrateAbyssalTraceEntityFromInventoryItem(entity, item) {
  if (!entity || !isInventoryAbyssalTrace(item)) {
    return entity;
  }

  const parsed = parseInventoryCustomInfo(item);
  const abyssalTraceInfo =
    parsed &&
    parsed.evejsAbyssalTrace &&
    typeof parsed.evejsAbyssalTrace === "object"
      ? parsed.evejsAbyssalTrace
      : {};
  const dungeonObjectID = Math.max(
    0,
    toInt(
      abyssalTraceInfo.traceItemID,
      toInt(item && item.itemID, 0),
    ),
  ) || null;
  const inventoryMetadata = getItemMetadata(item.typeID, item.itemName);
  const presentationMetadata =
    resolveItemByTypeID(TYPE_ABYSSAL_TRACE) ||
    inventoryMetadata;
  const presentationTypeID = toInt(
    presentationMetadata && presentationMetadata.typeID,
    TYPE_ABYSSAL_TRACE,
  );
  const presentationGraphicID = toInt(
    presentationMetadata && presentationMetadata.graphicID,
    toInt(inventoryMetadata && inventoryMetadata.graphicID, 0),
  );
  const presentationCategoryID = toInt(
    presentationMetadata && presentationMetadata.categoryID,
    toInt(inventoryMetadata && inventoryMetadata.categoryID, entity.categoryID),
  );

  entity.evejsAbyssalTrace = true;
  entity.traceItemID = toInt(item && item.itemID, 0);
  entity.evejsAbyssalTraceItemID = entity.traceItemID;
  entity.evejsAbyssalTracePersistedItemID = toInt(item && item.itemID, 0);
  entity.evejsAbyssalTracePersistedLocationID = toInt(item && item.locationID, 0);
  entity.evejsAbyssalTraceRole = normalizeSceneText(
    abyssalTraceInfo.abyssalTraceRole,
    "",
  );
  entity.evejsAbyssalTraceSourceSolarSystemID = toInt(
    abyssalTraceInfo.sourceSolarSystemID,
    toInt(abyssalTraceInfo.solarSystemID, 0),
  );
  entity.evejsAbyssalTraceSourceSceneKey = normalizeSceneText(
    abyssalTraceInfo.sourceSceneKey,
    "",
  );
  entity.evejsAbyssalTracePersistedIdentityValid = Boolean(
    entity.traceItemID > 0 &&
    entity.traceItemID === toInt(abyssalTraceInfo.traceItemID, 0) &&
    entity.traceItemID === entity.evejsAbyssalTracePersistedItemID &&
    (
      entity.evejsAbyssalTracePersistedLocationID <= 0 ||
      entity.evejsAbyssalTracePersistedLocationID ===
        entity.evejsAbyssalTraceSourceSolarSystemID
    )
  );
  entity.inventoryTypeID = toInt(item && item.typeID, toInt(entity.typeID, 0));
  entity.entityTypeID = entity.inventoryTypeID;
  entity.destinyBallPresentationTypeID = presentationTypeID;
  entity.presentationTypeID = presentationTypeID;
  entity.typeID = presentationTypeID;
  entity.slimTypeID = presentationTypeID;
  entity.slimCategoryID = presentationCategoryID;
  if (presentationGraphicID > 0) {
    entity.graphicID = presentationGraphicID;
    entity.slimGraphicID = presentationGraphicID;
  }
  const capturedProfile = resolveAbyssalTraceProfile(abyssalTraceInfo);
  if (capturedProfile) {
    applyAbyssalTraceProfileToEntity(entity, abyssalTraceInfo);
  } else {
    // Preserve the staged generic presentation for filament profiles whose
    // K-space Trace lifecycle has not yet been retail-captured.
    entity.ballInteractive = true;
    entity.slimGroupID = ACCELERATION_GATE_SLIM_GROUP_ID;
    entity.activityState = undefined;
    applyAbyssalTracePresentationState(entity, abyssalTraceInfo);
    entity.poseID = 0;
    entity.component_activate = [true, null];
    entity.activate_comp_durationSeconds = 0;
    entity.gateActivationRange = ABYSSAL_TRACE_GATE_ACTIVATION_RANGE_METERS;
  }
  entity.interactionRadius = Math.max(
    toFiniteNumber(entity.interactionRadius, 0),
    toFiniteNumber(entity.radius, 0),
  );
  if (!capturedProfile) {
    entity.dungeonMaterializedGate = true;
    entity.dungeonObjectID = dungeonObjectID;
    entity.dunObjectID = dungeonObjectID;
    entity.dunPosition = entity.position ? cloneVector(entity.position) : undefined;
  }
  return entity;
}

function isAbyssalVisualOnlyEntity(entity) {
  return Boolean(
    entity &&
      entity.abyssalVisualOnly === true &&
      String(entity.evejsAbyssalVisualRole || "").trim().toLowerCase() === "environment_visual"
  );
}

function classifyAbyssalBootstrapEntity(entity, egoID = 0) {
  if (!entity) {
    return "other";
  }
  const itemID = toInt(entity.itemID, 0);
  if (itemID > 0 && itemID === toInt(egoID, 0)) {
    return "ship";
  }
  const roomEntityRole = resolveAbyssalRoomEntityRole(entity);
  if (roomEntityRole !== ABYSSAL_ROOM_ENTITY_ROLES.UNKNOWN) {
    return roomEntityRole;
  }
  if (String(entity.kind || "").trim().toLowerCase() === "ship") {
    return "ship";
  }
  return ABYSSAL_ROOM_ENTITY_ROLES.UNKNOWN;
}

function summarizeAbyssalBootstrapInventory(entities, egoID = 0) {
  const sourceEntities = Array.isArray(entities) ? entities : [];
  const roomEntities = sourceEntities.filter((entity) =>
    classifyAbyssalBootstrapEntity(entity, egoID) !== "ship"
  );
  const roleSummary = summarizeAbyssalRoomEntities(roomEntities);
  return {
    shipCount: sourceEntities.length - roomEntities.length,
    ...roleSummary,
    gateCount: roleSummary.conduitCount,
    rewardCount:
      roleSummary.rewardCacheCount +
      roleSummary.rewardWreckCount +
      roleSummary.extractionNodeCount,
    otherDynamicCount: roleSummary.unknownCount,
  };
}

Object.assign(module.exports, {
  ABYSSAL_CONDUIT_GATE_ACTIVATION_RANGE_METERS,
  ABYSSAL_FORBIDDEN_PERSISTENT_PLAYER_CATEGORIES,
  ABYSSAL_HIDDEN_ROOM_DELIVERY_STATES,
  ABYSSAL_ROOM_DELIVERY_STATE,
  ABYSSAL_TELEPORT_TRANSITION_BYPASS,
  ABYSSAL_TIER1_REWARD_STRUCTURE_DURABILITY,
  ABYSSAL_TRACE_GATE_ACTIVATION_RANGE_METERS,
  ACCELERATION_GATE_SLIM_GROUP_ID,
  TYPE_ABYSSAL_BIOCOMBINATIVE_CACHE,
  TYPE_ABYSSAL_EXTRACTION_NODE,
  TYPE_ABYSSAL_EXTRACTION_SUBNODE,
  TYPE_CAPTURED_TRIGLAVIAN_BIOADAPTIVE_CACHE,
  getInventoryAbyssalPlayerCompanionInfo,
  getInventoryAbyssalPocketMarkerInfo,
  getInventoryAbyssalRunOwnership,
  getInventoryAbyssalRuntimeArtifactInfo,
  isInventoryAbyssalTrace,
});
