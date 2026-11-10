"use strict";

module.exports = {
  applySessionStateToShipEntity,
  buildRuntimePersistedSpaceShipEntity,
  buildRuntimeShipEntity,
  buildShipEntity,
  buildShipEntityCore,
  clearSessionStateFromShipEntity,
  getCharacterBackedShipPresentation,
  getShipEntityDebugCharacterID,
  getShipEntityVisibleCharacterID,
  isPlayerOwnedActiveSpaceShipRecord,
  isPlayerOwnedPersistedSpaceShipRecord,
  normalizeSlimShipModules,
  refreshEntitiesForSlimPayload,
  refreshShipConditionFields,
  refreshShipPresentationFields,
  resolveShipSkinMaterialSetID,
  resolveShipSlimModules,
};

const runtimeEntryDirname = require("path").resolve(__dirname, "..");
const path = require("path");
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
  findItemById,
  findShipItemById,
  listContainerItems,
  listSystemSpaceItems,
  warmSimulationInventoryProjection,
} = require(path.join(
  runtimeEntryDirname,
  "../services/inventory/simulationInventoryProjection",
));
const {
  buildFleetWarpCommandAssociationPlan,
  clearFleetWarpCommandAssociation,
  commitFleetWarpCommandAssociationPlan,
  getFleetWarpCommandAssociation,
  haveSameFleetWarpCommandAssociation,
  isFleetWarpInProgress,
} = require(path.join(
  runtimeEntryDirname,
  "../services/fleets/fleetWarpCommandAssociation.js",
));
const {
  getAppliedSkinMaterialSetID,
} = require(path.join(runtimeEntryDirname, "../services/ship/shipCosmeticsState"));
const {
  getEnabledCosmeticsEntries,
} = require(path.join(runtimeEntryDirname, "../services/ship/shipLogoFittingState"));
const shipStanceRuntime = require(path.join(runtimeEntryDirname, "../services/ship/shipStanceRuntime"));
const {
  getFittedModuleItems,
  listFittedItemsForLocation,
  buildSlimModuleTuples,
  buildCharacterTargetingState,
  buildChargeTupleItemID,
  buildShipResourceState,
  SLOT_FAMILY_FLAGS,
  getAttributeIDByNames,
  getEffectIDByNames,
  getTypeDogmaAttributes,
  getTypeDogmaEffects,
  getTypeEffectRecords,
  getPassiveModifierEffectRecords,
  getTypeAttributeValue,
  getEffectTypeRecord,
  getRequiredSkillRequirements,
  getLoadedChargeByFlag,
  isChargeCompatibleWithModule,
  isModuleOnline,
  isStructureDogmaHost,
  resolveDogmaSkillMapForHost,
  appendDirectModifierEntries,
  buildEffectiveItemAttributeMap,
  indexOverloadEffectRecordsByModuleID,
  buildProjectedModuleSourceAttributeMap,
} = require(path.join(runtimeEntryDirname, "../services/fitting/liveFittingState"));
const structureState = require(path.join(
  runtimeEntryDirname,
  "../services/structure/structureState",
));
const worldData = require(path.join(runtimeEntryDirname, "./worldData"));
const wormholeEnvironmentRuntime = require(path.join(
  runtimeEntryDirname,
  "../services/exploration/wormholes/wormholeEnvironmentRuntime",
));
const {
  resolveCharacterRecord,
  resolveCharacterRecordReadOnly,
} = require("./characterStateBridge");
const {
  ATTRIBUTE_CLOAK_STABILIZATION_STRENGTH,
} = require("./dogmaAttributeIds");
const {
  getShipEntityInventoryCharacterID,
} = require("./entityDogmaView");
const {
  applyRuntimeDungeonTrackingState,
  applyRuntimeEntityScopeMetadata,
  clearPlayerShipGenericDungeonScope,
} = require("./entityScopeTags");
const {
  buildShipSpaceState,
} = require("./entitySpacePersistence");
const {
  refreshShipCompressionFacilityState,
} = require("./industrialCore");
const {
  refreshInventoryBackedEntityPresentationFields,
} = require("./inventorySpaceEntity");
const {
  clamp,
  toFiniteNumber,
  toInt,
} = require("../../common/numbers");
const {
  buildPassiveShipResourceState,
  calculateAlignTimeSecondsFromMassInertia,
  resolveModifiedWarpSpeedAU,
} = require("./passiveDerivedState");
const {
  allocateRuntimeEntityID,
} = require("./runtimeEntityIdentity");
const {
  MAX_SUBWARP_SPEED_FRACTION,
  deriveAgilitySeconds,
  normalizeMode,
} = require("./shipMotionKinematics");
const {
  DEFAULT_RIGHT,
  addVectors,
  buildPerpendicular,
  cloneVector,
  magnitude,
  normalizeVector,
  scaleVector,
} = require("../../common/vector");
const shipCloakModule = require("./shipCloak");
const {
  convertLegacySavedWarp,
  normalizeSavedWarpLanding,
} = require("./savedWarpLanding");

function resolveShipSkinMaterialSetID(shipItem) {
  if (!shipItem) {
    return null;
  }

  return getAppliedSkinMaterialSetID(shipItem.itemID);
}

function normalizeSlimShipModules(modules) {
  if (!Array.isArray(modules)) {
    return [];
  }

  return modules
    .map((entry) => {
      if (Array.isArray(entry)) {
        return [
          toInt(entry[0], 0),
          toInt(entry[1], 0),
          toInt(entry[2], 0),
        ];
      }
      if (!entry || typeof entry !== "object") {
        return null;
      }
      return [
        toInt(entry.itemID, 0),
        toInt(entry.typeID, 0),
        toInt(entry.flagID, 0),
      ];
    })
    .filter(
      (entry) =>
        Array.isArray(entry) &&
        entry.length === 3 &&
        entry.every((value) => Number.isInteger(value) && value > 0),
    )
    .sort((left, right) => {
      if (left[2] !== right[2]) {
        return left[2] - right[2];
      }
      return left[0] - right[0];
    });
}

function getShipEntityVisibleCharacterID(entity, fallback = 0) {
  return toInt(entity && entity.characterID, fallback);
}

function getShipEntityDebugCharacterID(entity, fallback = 0) {
  const inventoryCharacterID = getShipEntityInventoryCharacterID(entity, 0);
  if (inventoryCharacterID > 0) {
    return inventoryCharacterID;
  }
  return getShipEntityVisibleCharacterID(entity, fallback);
}

function getCharacterBackedShipPresentation(entity) {
  const characterID = getShipEntityInventoryCharacterID(entity, 0);
  if (characterID <= 0) {
    return null;
  }

  return resolveCharacterRecordReadOnly(characterID) || null;
}

function resolveShipSlimModules(entity) {
  if (!entity || entity.kind !== "ship") {
    return [];
  }

  const characterID = getShipEntityInventoryCharacterID(entity, 0);
  if (characterID > 0) {
    return normalizeSlimShipModules(
      buildSlimModuleTuples(characterID, entity.itemID),
    );
  }

  return normalizeSlimShipModules(entity.modules);
}

function refreshShipConditionFields(entity) {
  if (!entity || entity.kind !== "ship") {
    return entity;
  }

  const shipItem = findShipItemById(entity.itemID) || null;
  const conditionState = shipItem
    ? getShipConditionState(shipItem)
    : normalizeShipConditionState(entity.conditionState);
  entity.conditionState = conditionState;
  entity.capacitorChargeRatio = clamp(
    toFiniteNumber(
      conditionState && conditionState.charge,
      toFiniteNumber(entity.capacitorChargeRatio, 1),
    ),
    0,
    1,
  );
  return entity;
}

function refreshShipPresentationFields(entity) {
  if (!entity || entity.kind !== "ship") {
    return entity;
  }

  const characterData = getCharacterBackedShipPresentation(entity);
  const resolvedSkinMaterialSetID = getAppliedSkinMaterialSetID(entity.itemID);
  refreshShipConditionFields(entity);
  entity.skinMaterialSetID =
    resolvedSkinMaterialSetID !== null &&
    resolvedSkinMaterialSetID !== undefined
      ? resolvedSkinMaterialSetID
      : entity.skinMaterialSetID ?? null;
  entity.modules = resolveShipSlimModules(entity);
  entity.shipStance = shipStanceRuntime.buildShipStanceSlimTuple(entity, {
    existingSlimValue: entity.shipStance,
  });
  // NOTE: pass `undefined` (not `characterData && …`) when there is no character
  // record. That expression yields `null` for NPCs, and `toFiniteNumber(null,
  // fallback)` returns 0 (Number(null) === 0 is finite), silently wiping the
  // NPC's spawned security status / bounty on every slim refresh instead of
  // falling back to the value the entity spawned with.
  entity.securityStatus = toFiniteNumber(
    characterData ? (characterData.securityStatus ?? characterData.securityRating) : undefined,
    toFiniteNumber(entity.securityStatus, 0),
  );
  entity.bounty = toFiniteNumber(
    characterData ? characterData.bounty : undefined,
    toFiniteNumber(entity.bounty, 0),
  );
  entity.cosmeticsItems = getEnabledCosmeticsEntries(entity.itemID)
    .map((entry) => Number(entry.cosmeticType || 0))
    .filter((entry) => entry > 0)
    .sort((left, right) => left - right);
  refreshShipCompressionFacilityState(entity);
  return entity;
}

function applySessionStateToShipEntity(
  entity,
  session,
  shipItem = null,
  options = {},
) {
  if (!entity || entity.kind !== "ship") {
    return entity;
  }

  const characterID = toInt(session && session.characterID, 0);
  const characterData =
    characterID > 0 ? resolveCharacterRecord(characterID) || null : null;

  entity.session = session || null;
  entity.persistSpaceState = true;
  entity.ownerID = toInt(
    shipItem && shipItem.ownerID,
    toInt(entity.ownerID, characterID),
  );
  entity.characterID = characterID;
  entity.pilotCharacterID = characterID;
  entity.corporationID = toInt(session && session.corporationID, 0);
  entity.allianceID = toInt(session && session.allianceID, 0);
  entity.warFactionID = toInt(session && session.warFactionID, 0);
  entity.itemName = String(
    (shipItem && shipItem.itemName) ||
      (session && session.shipName) ||
      entity.itemName ||
      "Ship",
  );
  entity.conditionState = normalizeShipConditionState(
    options.preserveAuthoritativeConditionState === true
      ? entity.conditionState
      : (shipItem && shipItem.conditionState) || entity.conditionState,
  );

  const resolvedSkinMaterialSetID = resolveShipSkinMaterialSetID(shipItem);
  entity.skinMaterialSetID =
    resolvedSkinMaterialSetID !== null &&
    resolvedSkinMaterialSetID !== undefined
      ? resolvedSkinMaterialSetID
      : entity.skinMaterialSetID ?? null;
  entity.modules = normalizeSlimShipModules(
    buildSlimModuleTuples(characterID, entity.itemID),
  );
  entity.shipStance = shipStanceRuntime.buildShipStanceSlimTuple(
    shipItem || entity,
    {
      existingSlimValue: entity.shipStance,
    },
  );
  entity.securityStatus = toFiniteNumber(
    characterData && (characterData.securityStatus ?? characterData.securityRating),
    0,
  );
  entity.bounty = toFiniteNumber(characterData && characterData.bounty, 0);
  refreshShipCompressionFacilityState(entity);
  return entity;
}

function clearSessionStateFromShipEntity(entity) {
  if (!entity || entity.kind !== "ship") {
    return entity;
  }

  clearFleetWarpCommandAssociation(entity);
  entity.session = null;
  entity.pendingModuleStopNotifications = [];
  entity.characterID = 0;
  entity.pilotCharacterID = 0;
  entity.corporationID = 0;
  entity.allianceID = 0;
  entity.warFactionID = 0;
  entity.securityStatus = 0;
  entity.bounty = 0;
  refreshShipCompressionFacilityState(entity);
  return entity;
}

function refreshEntitiesForSlimPayload(entities) {
  if (!Array.isArray(entities)) {
    return [];
  }

  for (const entity of entities) {
    refreshShipPresentationFields(entity);
    refreshInventoryBackedEntityPresentationFields(entity);
    if (entity && entity.kind === "structure") {
      const latestStructure = structureState.getStructureByID(entity.itemID, {
        refresh: false,
      });
      if (latestStructure) {
        entity.state = latestStructure.state;
        entity.stateStartedAt = latestStructure.stateStartedAt;
        entity.stateEndsAt = latestStructure.stateEndsAt;
        entity.timerPausedAt = latestStructure.timerPausedAt || null;
        entity.upkeepState = latestStructure.upkeepState;
        entity.deedState = latestStructure.hasQuantumCore === true ? 1 : 0;
        entity.serviceStates = latestStructure.serviceStates || {};
        entity.unanchoring = latestStructure.unanchoring || null;
        entity.repairing = structureState.resolveStructureRepairingValue(latestStructure);
        entity.conditionState = normalizeShipConditionState(latestStructure.conditionState);
      }
    }
  }

  return entities;
}

function buildShipEntityCore(source, systemID, options = {}) {
  const DEFAULT_CLOAK_STABILIZATION_STRENGTH = shipCloakModule.DEFAULT_CLOAK_STABILIZATION_STRENGTH;
  const movement =
    worldData.getMovementAttributesForType(source.typeID) || null;
  const passiveResourceState = source.passiveResourceState || null;
  if (passiveResourceState && typeof passiveResourceState === "object") {
    passiveResourceState.cloakStabilizationStrength =
      DEFAULT_CLOAK_STABILIZATION_STRENGTH;
    if (
      passiveResourceState.attributes &&
      typeof passiveResourceState.attributes === "object"
    ) {
      passiveResourceState.attributes[String(ATTRIBUTE_CLOAK_STABILIZATION_STRENGTH)] =
        DEFAULT_CLOAK_STABILIZATION_STRENGTH;
    }
  }
  // A row an older server saved in warp loads stopped, as a newer save
  // stores it (savedWarpLanding.js): a site warp keeps its savedWarpLanding
  // record for login to settle.
  const spaceState = convertLegacySavedWarp(buildShipSpaceState(source));
  const savedWarpLanding = normalizeSavedWarpLanding(spaceState.savedWarpLanding);
  const position = cloneVector(spaceState.position);
  const direction = normalizeVector(
    cloneVector(spaceState.direction, DEFAULT_RIGHT),
    DEFAULT_RIGHT,
  );
  const storedVelocity = cloneVector(spaceState.velocity);
  const targetPoint = cloneVector(
    spaceState.targetPoint,
    addVectors(position, scaleVector(direction, 1.0e16)),
  );
  const maxVelocity =
    toFiniteNumber(passiveResourceState && passiveResourceState.maxVelocity, 0) > 0
      ? toFiniteNumber(passiveResourceState.maxVelocity, 0)
      : toFiniteNumber(movement && movement.maxVelocity, 0) > 0
        ? toFiniteNumber(movement.maxVelocity, 0)
        : 200;
  // A stored speed above the ship's top speed is not one it can load at: an
  // older save kept a warp's speed with mode STOP. Clamp it, keeping the heading.
  const storedSpeed = magnitude(storedVelocity);
  const velocity = storedSpeed > maxVelocity
    ? scaleVector(storedVelocity, maxVelocity / storedSpeed)
    : storedVelocity;
  const modifiedWarpSpeedAU = resolveModifiedWarpSpeedAU(passiveResourceState);
  const warpSpeedAU =
    modifiedWarpSpeedAU > 0
      ? modifiedWarpSpeedAU
      : toFiniteNumber(movement && movement.warpSpeedMultiplier, 0) > 0
        ? toFiniteNumber(movement.warpSpeedMultiplier, 0)
        : 3;
  const resolvedMass =
    toFiniteNumber(passiveResourceState && passiveResourceState.mass, 0) > 0
      ? toFiniteNumber(passiveResourceState.mass, 0)
      : toFiniteNumber(movement && movement.mass, 0) > 0
        ? toFiniteNumber(movement.mass, 0)
        : 1_000_000;
  const resolvedInertia =
    toFiniteNumber(passiveResourceState && passiveResourceState.agility, 0) > 0
      ? toFiniteNumber(passiveResourceState.agility, 0)
      : toFiniteNumber(movement && movement.inertia, 0) > 0
        ? toFiniteNumber(movement.inertia, 0)
        : 1;
  const alignTime = calculateAlignTimeSecondsFromMassInertia(
    resolvedMass,
    resolvedInertia,
    toFiniteNumber(movement && movement.alignTime, 0) > 0
      ? toFiniteNumber(movement.alignTime, 0)
      : 3,
  );
  const maxAccelerationTime =
    toFiniteNumber(movement && movement.maxAccelerationTime, 0) > 0
      ? toFiniteNumber(movement.maxAccelerationTime, 0)
      : 6;
  const speedFraction = clamp(
    toFiniteNumber(spaceState.speedFraction, magnitude(velocity) > 0 ? 1 : 0),
    0,
    MAX_SUBWARP_SPEED_FRACTION,
  );
  // A stored warp is not resumed: the ship comes back stopped.
  const storedMode = normalizeMode(
    spaceState.mode,
    magnitude(velocity) > 0 ? "GOTO" : "STOP",
  );
  const mode = storedMode === "WARP" ? "STOP" : storedMode;
  const orbitNormal = normalizeVector(
    cloneVector(spaceState.orbitNormal, buildPerpendicular(direction)),
    buildPerpendicular(direction),
  );
  const pilotCharacterID = toInt(
    source.pilotCharacterID,
    toInt(source.characterID, 0),
  );
  const suppressSlimName = source && source.suppressSlimName === true;

  const entity = {
    kind: "ship",
    systemID,
    itemID: allocateRuntimeEntityID(source.itemID),
    typeID: source.typeID,
    groupID: toInt(source.groupID, 25),
    categoryID: toInt(source.categoryID, 6),
    itemName: String(source.itemName || source.name || "Ship"),
    ownerID: toInt(
      source.ownerID,
      toInt(source.characterID, toInt(source.corporationID, 0)),
    ),
    slimTypeID: toInt(source.slimTypeID, toInt(source.typeID, 0)),
    slimGroupID: toInt(source.slimGroupID, toInt(source.groupID, 25)),
    slimCategoryID: toInt(source.slimCategoryID, toInt(source.categoryID, 6)),
    slimName: suppressSlimName
      ? ""
      : String(
          source.slimName ||
            source.itemName ||
            source.name ||
            "Ship",
        ),
    suppressSlimName,
    nameID: toInt(source && source.nameID, 0) || null,
    characterID: toInt(source.characterID, 0),
    pilotCharacterID,
    npcEntityType: source.npcEntityType || null,
    corporationID: toInt(source.corporationID, 0),
    allianceID: toInt(source.allianceID, 0),
    warFactionID: toInt(source.warFactionID, 0),
    nativeNpc: source && source.nativeNpc === true,
    nativeNpcOccupied: source && source.nativeNpcOccupied === true,
    transient: source && source.transient === true,
    skinMaterialSetID:
      options.skinMaterialSetID !== undefined
        ? options.skinMaterialSetID
        : source.skinMaterialSetID ?? null,
    cosmeticsItems: getEnabledCosmeticsEntries(source.itemID)
      .map((entry) => Number(entry.cosmeticType || 0))
      .filter((entry) => entry > 0)
      .sort((left, right) => left - right),
    modules: normalizeSlimShipModules(source.modules),
    shipStance: shipStanceRuntime.buildShipStanceSlimTuple(source, {
      existingSlimValue: source.shipStance,
    }),
    securityStatus: toFiniteNumber(
      source.securityStatus ?? source.securityRating,
      0,
    ),
    bounty: toFiniteNumber(source.bounty, 0),
    position,
    velocity,
    direction,
    targetPoint,
    mode,
    speedFraction,
    mass: resolvedMass,
    inertia: resolvedInertia,
    radius:
      toFiniteNumber(source && source.radius, 0) > 0
        ? toFiniteNumber(source.radius, 0)
        : toFiniteNumber(movement && movement.radius, 0) > 0
          ? toFiniteNumber(movement.radius, 0)
        : 50,
    maxVelocity,
    alignTime,
    maxAccelerationTime,
    agilitySeconds: deriveAgilitySeconds(
      alignTime,
      maxAccelerationTime,
      resolvedMass,
      resolvedInertia,
    ),
    passiveDerivedState: passiveResourceState,
    maxTargetRange: toFiniteNumber(
      passiveResourceState && passiveResourceState.maxTargetRange,
      0,
    ),
    maxLockedTargets: toFiniteNumber(
      passiveResourceState && passiveResourceState.maxLockedTargets,
      0,
    ),
    signatureRadius: toFiniteNumber(
      passiveResourceState && passiveResourceState.signatureRadius,
      0,
    ),
    cloakingTargetingDelay: toFiniteNumber(
      passiveResourceState && passiveResourceState.cloakingTargetingDelay,
      0,
    ),
    cloakStabilizationStrength: DEFAULT_CLOAK_STABILIZATION_STRENGTH,
    scanResolution: toFiniteNumber(
      passiveResourceState && passiveResourceState.scanResolution,
      0,
    ),
    capacitorCapacity: toFiniteNumber(
      passiveResourceState && passiveResourceState.capacitorCapacity,
      0,
    ),
    capacitorRechargeRate: toFiniteNumber(
      passiveResourceState && passiveResourceState.capacitorRechargeRate,
      0,
    ),
    shieldCapacity: toFiniteNumber(
      passiveResourceState && passiveResourceState.shieldCapacity,
      0,
    ),
    shieldRechargeRate: toFiniteNumber(
      passiveResourceState && passiveResourceState.shieldRechargeRate,
      0,
    ),
    armorHP: toFiniteNumber(passiveResourceState && passiveResourceState.armorHP, 0),
    structureHP: toFiniteNumber(
      passiveResourceState && passiveResourceState.structureHP,
      0,
    ),
    conditionState: normalizeShipConditionState(source && source.conditionState),
    fittedItems: Array.isArray(source && source.fittedItems)
      ? source.fittedItems.map((item) => ({ ...item }))
      : undefined,
    nativeCargoItems: Array.isArray(source && source.nativeCargoItems)
      ? source.nativeCargoItems.map((item) => ({ ...item }))
      : undefined,
    skillMap: source && source.skillMap instanceof Map
      ? new Map(source.skillMap)
      : undefined,
    superweaponCycleOverrideMs: Math.max(
      0,
      toInt(source && source.superweaponCycleOverrideMs, 0),
    ) || undefined,
    capacitorChargeRatio: clamp(
      toFiniteNumber(source && source.conditionState && source.conditionState.charge, 1),
      0,
      1,
    ),
    warpSpeedAU,
    targetEntityID: toInt(spaceState.targetEntityID, 0) || null,
    followRange: toFiniteNumber(spaceState.followRange, 0),
    orbitDistance: toFiniteNumber(spaceState.orbitDistance, 0),
    orbitNormal,
    orbitSign: toFiniteNumber(spaceState.orbitSign, 1) < 0 ? -1 : 1,
    bubbleID: null,
    publicGridKey: null,
    effectStamp: 0,
    warpDestination: null,
    savedWarpLanding,
    dockingTargetID: null,
    pendingDock: null,
    session: options.session || null,
    persistSpaceState: options.persistSpaceState === true,
    lastPersistAt: 0,
    lastMovementDebugAt: 0,
    movementTrace: null,
    lockedTargets: new Map(),
    pendingTargetLocks: new Map(),
    targetedBy: new Set(),
    activeModuleEffects: new Map(),
    moduleReactivationLocks: new Map(),
  };

  applyRuntimeEntityScopeMetadata(entity, source);
  applyRuntimeEntityScopeMetadata(entity, spaceState);
  applyRuntimeDungeonTrackingState(entity, source);
  applyRuntimeDungeonTrackingState(entity, spaceState);
  clearPlayerShipGenericDungeonScope(entity);
  require("../combat/breacherPods").prepareHydration(entity, spaceState);

  return entity;
}

function buildShipEntity(session, shipItem, systemID) {
  const characterData = resolveCharacterRecord(session && session.characterID) || {};
  const passiveResourceState = buildPassiveShipResourceState(
    session && session.characterID,
    shipItem,
    {
      additionalAttributeModifierEntries:
        wormholeEnvironmentRuntime.collectShipAttributeModifierEntriesForSystem(
          systemID,
        ),
    },
  );
  const initialModules = resolveShipSlimModules({
    kind: "ship",
    itemID: shipItem && shipItem.itemID,
    characterID: session && session.characterID,
    pilotCharacterID: session && session.characterID,
    modules: shipItem && shipItem.modules,
  });
  return buildShipEntityCore({
    itemID: shipItem.itemID,
    typeID: shipItem.typeID,
    groupID: shipItem.groupID,
    categoryID: shipItem.categoryID,
    itemName: shipItem.itemName || session.shipName || "Ship",
    ownerID: shipItem.ownerID || session.characterID,
    characterID: session.characterID || 0,
    pilotCharacterID: session.characterID || 0,
    corporationID: session.corporationID || 0,
    allianceID: session.allianceID || 0,
    warFactionID: session.warFactionID || 0,
    radius: shipItem.radius,
    conditionState: shipItem.conditionState || {},
    passiveResourceState,
    spaceState: shipItem.spaceState || {},
    modules: initialModules,
    securityStatus:
      characterData.securityStatus ?? characterData.securityRating ?? 0,
    bounty: characterData.bounty ?? 0,
  }, systemID, {
    session,
    persistSpaceState: true,
    skinMaterialSetID: resolveShipSkinMaterialSetID(shipItem),
  });
}

function buildRuntimeShipEntity(shipSpec, systemID, options = {}) {
  const source = shipSpec || {};
  const passiveResourceState =
    source.passiveResourceState ||
    buildPassiveShipResourceState(
      source.pilotCharacterID ?? source.characterID,
      {
        itemID: source.itemID,
        typeID: source.typeID,
        groupID: source.groupID,
        categoryID: source.categoryID,
        itemName: source.itemName,
        radius: source.radius,
      },
      {
        fittedItems: Array.isArray(source.fittedItems) ? source.fittedItems : [],
        skillMap: source.skillMap instanceof Map ? source.skillMap : undefined,
        additionalAttributeModifierEntries:
          wormholeEnvironmentRuntime.collectShipAttributeModifierEntriesForSystem(
            systemID,
          ),
      },
    );

  return buildShipEntityCore({
    ...source,
    passiveResourceState,
  }, systemID, {
    session: options.session || null,
    persistSpaceState: options.persistSpaceState === true,
  });
}

function isPlayerOwnedActiveSpaceShipRecord(shipItem, characterData) {
  if (!shipItem || toInt(shipItem.categoryID, 0) !== 6 || !shipItem.spaceState) {
    return false;
  }
  if (!characterData) {
    return false;
  }

  const accountID = toInt(characterData.accountId ?? characterData.accountID, 0);
  if (accountID <= 0) {
    return false;
  }

  return toInt(characterData.shipID, 0) === toInt(shipItem.itemID, 0);
}

function isPlayerOwnedPersistedSpaceShipRecord(shipItem, characterData) {
  if (!shipItem || toInt(shipItem.categoryID, 0) !== 6 || !shipItem.spaceState) {
    return false;
  }
  if (!characterData) {
    return false;
  }

  return toInt(characterData.accountId ?? characterData.accountID, 0) > 0;
}

function buildRuntimePersistedSpaceShipEntity(shipItem, systemID, options = {}) {
  if (!shipItem || toInt(shipItem.categoryID, 0) !== 6 || !shipItem.spaceState) {
    return null;
  }

  const inventoryCharacterID = toInt(shipItem.ownerID, 0);
  const resolveCharacterRecordFn =
    typeof options.resolveCharacterRecord === "function"
      ? options.resolveCharacterRecord
      : resolveCharacterRecord;
  const characterData =
    inventoryCharacterID > 0
      ? resolveCharacterRecordFn(inventoryCharacterID, shipItem) || null
      : null;
  const hasActivePilot = isPlayerOwnedActiveSpaceShipRecord(
    shipItem,
    characterData,
  );
  if (
    options.includeOfflinePlayerShips === false &&
    isPlayerOwnedPersistedSpaceShipRecord(shipItem, characterData)
  ) {
    return null;
  }
  const entity = buildRuntimeShipEntity({
    itemID: shipItem.itemID,
    typeID: shipItem.typeID,
    groupID: shipItem.groupID,
    categoryID: shipItem.categoryID,
    itemName: shipItem.itemName,
    ownerID: shipItem.ownerID,
    characterID: 0,
    // Inventory ownership survives launch/ejection, but pilot identity does
    // not.  Advertising the owner as the pilot of a spare hull sets the
    // Destiny interactive bit; celestialCheckers.OfferBoardShip then hides
    // Board Ship for the otherwise valid unpiloted target.
    pilotCharacterID: hasActivePilot ? inventoryCharacterID : 0,
    corporationID: hasActivePilot
      ? toInt(characterData && characterData.corporationID, 0)
      : 0,
    allianceID: hasActivePilot
      ? toInt(characterData && characterData.allianceID, 0)
      : 0,
    warFactionID: toInt(
      hasActivePilot && characterData
        ? (characterData.factionID ?? characterData.warFactionID)
        : 0,
      0,
    ),
    // Keep the fitted turret presentation on an unpiloted hull without using
    // its owner as a dogma pilot (and therefore accidentally applying skills).
    modules: buildSlimModuleTuples(inventoryCharacterID, shipItem.itemID),
    conditionState: shipItem.conditionState || {},
    spaceState: shipItem.spaceState || {},
    securityStatus: hasActivePilot && characterData
      ? (characterData.securityStatus ?? characterData.securityRating)
      : 0,
    bounty: hasActivePilot && characterData ? characterData.bounty : 0,
  }, systemID, {
    persistSpaceState: true,
  });

  applyRuntimeEntityScopeMetadata(entity, shipItem);
  applyRuntimeEntityScopeMetadata(entity, shipItem.spaceState);
  applyRuntimeEntityScopeMetadata(entity, options.entityScopeMetadata);
  clearPlayerShipGenericDungeonScope(entity, {
    playerOwned: isPlayerOwnedPersistedSpaceShipRecord(
      shipItem,
      characterData,
    ),
  });
  return refreshShipPresentationFields(entity);
}
