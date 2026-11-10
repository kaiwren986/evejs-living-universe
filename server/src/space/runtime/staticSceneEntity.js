"use strict";

module.exports = {
  buildDunRotationFromDirection,
  buildObserverStargateJumpFxOptions,
  buildPlanetOrbitalPosition,
  buildStaticAsteroidBeltEntity,
  buildStaticCelestialEntity,
  buildStaticMoonMiningBeaconEntity,
  buildStaticPlanetOrbitalEntity,
  buildStaticStargateEntity,
  buildStaticStationEntity,
  buildStaticStructureEntity,
  coerceActivationState,
  coerceDunRotationTuple,
  coerceStableActivationState,
  coerceStageTuple,
  getResolvedStargateDunRotation,
  getSharedWorldPosition,
  getStargateAuthoredDunRotation,
  getStargateDerivedDunRotation,
  getStargateInteractionRadius,
  getStargateRenderMetadata,
  getStargateStatusIcons,
  getStargateTypeMetadata,
  getStargateWarningIcon,
  getStationAuthoredDunRotation,
  getStationRenderMetadata,
  getSystemOwnerID,
};

const runtimeEntryDirname = require("path").resolve(__dirname, "..");
const { TYPE_TERRITORIAL_CLAIM_UNIT, TYPE_INFRASTRUCTURE_HUB } = require("../../services/sovereignty/sovConstants");
const {
  isAnsiblexStructure,
  getActiveJumpBridgeDestination,
  getJumpBridgeDestinationSolarSystemID,
  isJumpBridgeServiceAvailable,
} = require("../../services/structure/structureJumpBridgeLinks");
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
  resolveStargatePhysicalRadius,
} = require(path.join(runtimeEntryDirname, "./stargateRadius"));
const {
  getStargateVisualOverrideField,
} = require(path.join(runtimeEntryDirname, "./stargateVisualOverrides"));
const {
  buildDunRotationFromNormalizedDirection: buildStargateDunRotationFromDirection,
  getStargateSystemForwardDirection,
} = require(path.join(runtimeEntryDirname, "./stargateOrientation"));
const planetOrbitalState = require(path.join(runtimeEntryDirname, "../services/planet/planetOrbitalState"));
const { buildOrbitalPosition } = require("../../services/planet/planetOrbitalPlacement");
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
const {
  STRUCTURE_SERVICE_ID,
  STRUCTURE_SERVICE_STATE,
  STRUCTURE_STATE,
} = require(path.join(
  runtimeEntryDirname,
  "../services/structure/structureConstants",
));
const {
  resolveStructureEffectiveHitpoints,
} = require(path.join(
  runtimeEntryDirname,
  "../services/structure/structureFullPowerDogma",
));
const structureLocatorGeometry = require(path.join(
  runtimeEntryDirname,
  "../services/structure/structureLocatorGeometry",
));
const stationLocatorGeometry = require(path.join(
  runtimeEntryDirname,
  "../services/station/stationLocatorGeometry",
));
const worldData = require(path.join(runtimeEntryDirname, "./worldData"));
const wormholeEnvironmentRuntime = require(path.join(
  runtimeEntryDirname,
  "../services/exploration/wormholes/wormholeEnvironmentRuntime",
));
const {
  clamp,
  roundNumber,
  toFiniteNumber,
  toInt,
} = require("../../common/numbers");
const {
  buildPassiveShipResourceState,
} = require("./passiveDerivedState");
const {
  DEFAULT_STARGATE_INTERACTION_RADIUS,
} = require("./stargateJumpRange");
const {
  getStationInteractionRadius,
} = require("./stationDockingGeometry");
const {
  getSecurityStatusIconKey,
  isHazardousSecurityTransition,
} = require("./systemSecurityBand");
const {
  DEFAULT_RIGHT,
  cloneVector,
  magnitude,
  normalizeVector,
  scaleVector,
} = require("../../common/vector");

const INCLUDE_STARGATES_IN_SCENE = true;

const STARGATE_ACTIVATION_STATE = Object.freeze({
  CLOSED: 0,
  ACTIVATING: 1,
  OPEN: 2,
});

const STARGATE_ACTIVATION_TRANSITION_MS = 3000;

function getStargateInteractionRadius(stargate) {
  const configuredRadius = toFiniteNumber(
    stargate && stargate.interactionRadius,
    0,
  );
  if (configuredRadius > 0) {
    return configuredRadius;
  }

  return DEFAULT_STARGATE_INTERACTION_RADIUS;
}

function coerceDunRotationTuple(source) {
  if (!Array.isArray(source) || source.length !== 3) {
    return null;
  }

  const tuple = source.map((value) => roundNumber(value, 6));
  return tuple.every((value) => Number.isFinite(value)) ? tuple : null;
}

function getStationRenderMetadata(station, fieldName) {
  if (!station || !fieldName) {
    return undefined;
  }

  if (Object.prototype.hasOwnProperty.call(station, fieldName)) {
    return station[fieldName];
  }

  const stationType = worldData.getStationTypeByID(station.stationTypeID);
  if (
    stationType &&
    Object.prototype.hasOwnProperty.call(stationType, fieldName)
  ) {
    return stationType[fieldName];
  }

  return undefined;
}

function getStationAuthoredDunRotation(station) {
  return coerceDunRotationTuple(
    getStationRenderMetadata(station, "dunRotation"),
  );
}

function coerceStageTuple(source) {
  if (!Array.isArray(source) || source.length !== 2) {
    return [0, 1];
  }

  const stage = roundNumber(source[0], 6);
  const maximum = Math.max(roundNumber(source[1], 6), 1);
  return Number.isFinite(stage) && Number.isFinite(maximum)
    ? [stage, maximum]
    : [0, 1];
}

function coerceActivationState(value, fallback = STARGATE_ACTIVATION_STATE.CLOSED) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function coerceStableActivationState(
  value,
  fallback = STARGATE_ACTIVATION_STATE.CLOSED,
) {
  const state = coerceActivationState(value, fallback);
  if (state <= STARGATE_ACTIVATION_STATE.CLOSED) {
    return STARGATE_ACTIVATION_STATE.CLOSED;
  }
  if (state === STARGATE_ACTIVATION_STATE.ACTIVATING) {
    return STARGATE_ACTIVATION_STATE.OPEN;
  }
  return state;
}

function getSystemOwnerID(system) {
  const factionID = toInt(system && system.factionID, 0);
  return factionID > 0 ? factionID : null;
}

function getStargateAuthoredDunRotation(stargate) {
  return coerceDunRotationTuple(stargate && stargate.dunRotation);
}

function getSharedWorldPosition(systemPosition, localPosition) {
  if (!systemPosition || !localPosition) {
    return null;
  }

  return {
    x: toFiniteNumber(systemPosition.x, 0) - toFiniteNumber(localPosition.x, 0),
    y: toFiniteNumber(systemPosition.y, 0) + toFiniteNumber(localPosition.y, 0),
    z: toFiniteNumber(systemPosition.z, 0) + toFiniteNumber(localPosition.z, 0),
  };
}

function buildDunRotationFromDirection(direction) {
  if (!direction || magnitude(direction) <= 0) {
    return null;
  }

  const forward = scaleVector(direction, 1 / magnitude(direction));
  const yawDegrees = Math.atan2(forward.x, forward.z) * (180 / Math.PI);
  const pitchDegrees = -Math.asin(clamp(forward.y, -1, 1)) * (180 / Math.PI);
  return coerceDunRotationTuple([yawDegrees, pitchDegrees, 0]);
}

function getStargateDerivedDunRotation(stargate) {
  if (!stargate) {
    return null;
  }

  const sourceSystem = worldData.getSolarSystemByID(stargate.solarSystemID);
  const destinationGate =
    worldData.getStargateByID(stargate.destinationID) || null;
  const destinationSystemID =
    toInt(stargate.destinationSolarSystemID, 0) ||
    toInt(destinationGate && destinationGate.solarSystemID, 0);
  const destinationSystem = worldData.getSolarSystemByID(destinationSystemID);
  if (!sourceSystem || !destinationSystem) {
    return null;
  }

  return buildStargateDunRotationFromDirection(
    getStargateSystemForwardDirection(stargate, sourceSystem, destinationSystem),
  );
}

function getResolvedStargateDunRotation(stargate) {
  return (
    getStargateAuthoredDunRotation(stargate) ||
    getStargateDerivedDunRotation(stargate)
  );
}

function getStargateTypeMetadata(stargate, fieldName) {
  if (!stargate || !fieldName) {
    return undefined;
  }

  if (Object.prototype.hasOwnProperty.call(stargate, fieldName)) {
    return stargate[fieldName];
  }

  const stargateType = worldData.getStargateTypeByID(stargate.typeID);
  if (
    stargateType &&
    Object.prototype.hasOwnProperty.call(stargateType, fieldName)
  ) {
    return stargateType[fieldName];
  }

  return undefined;
}

function getStargateRenderMetadata(stargate, fieldName) {
  if (!stargate || !fieldName) {
    return undefined;
  }

  if (Object.prototype.hasOwnProperty.call(stargate, fieldName)) {
    return stargate[fieldName];
  }

  const authoredValue = getStargateVisualOverrideField(
    stargate,
    fieldName,
  );
  if (authoredValue !== undefined) {
    return authoredValue;
  }

  return getStargateTypeMetadata(stargate, fieldName);
}

function getStargateStatusIcons(stargate, destinationSystem) {
  const configuredIcons = Array.isArray(stargate && stargate.destinationSystemStatusIcons)
    ? stargate.destinationSystemStatusIcons
        .map((value) => String(value || "").trim())
        .filter(Boolean)
    : [];
  if (configuredIcons.length > 0) {
    return configuredIcons;
  }

  if (!destinationSystem) {
    return [];
  }

  return [getSecurityStatusIconKey(destinationSystem)];
}

function getStargateWarningIcon(stargate, sourceSystem, destinationSystem) {
  if (stargate && stargate.destinationSystemWarningIcon) {
    return String(stargate.destinationSystemWarningIcon);
  }

  return isHazardousSecurityTransition(sourceSystem, destinationSystem)
    ? "stargate_travelwarning3.dds"
    : null;
}

function buildObserverStargateJumpFxOptions(options = {}) {
  return {
    start: true,
    active: false,
    ...options,
  };
}

function buildStaticStationEntity(station) {
  const dunRotation = getStationAuthoredDunRotation(station);
  const dockingGeometry = station
    ? stationLocatorGeometry.buildStationDockingGeometry(station, {
      selectionStrategy: "first",
    })
    : null;
  return {
    kind: "station",
    itemID: station.stationID,
    typeID: station.stationTypeID,
    groupID: station.groupID,
    categoryID: station.categoryID,
    itemName: station.stationName,
    ownerID: station.corporationID || 1,
    corporationID: station.corporationID || 0,
    allianceID: 0,
    warFactionID: 0,
    radius: getStationInteractionRadius(station),
    position: cloneVector(station.position),
    dockPosition: dockingGeometry && dockingGeometry.dockPosition
      ? cloneVector(dockingGeometry.dockPosition)
      : station.dockPosition
        ? cloneVector(station.dockPosition)
        : null,
    dockOrientation: dockingGeometry && dockingGeometry.dockOrientation
      ? normalizeVector(dockingGeometry.dockOrientation, DEFAULT_RIGHT)
      : station.dockOrientation
        ? normalizeVector(station.dockOrientation, station.undockDirection || DEFAULT_RIGHT)
        : normalizeVector(station.undockDirection, DEFAULT_RIGHT),
    undockDirection: dockingGeometry && dockingGeometry.undockDirection
      ? cloneVector(dockingGeometry.undockDirection)
      : station.undockDirection
        ? cloneVector(station.undockDirection)
        : null,
    undockPosition: dockingGeometry && dockingGeometry.undockPosition
      ? cloneVector(dockingGeometry.undockPosition)
      : station.undockPosition
        ? cloneVector(station.undockPosition)
        : null,
    dunRotation,
    activityLevel: getStationRenderMetadata(station, "activityLevel") ?? null,
    skinMaterialSetID: getStationRenderMetadata(station, "skinMaterialSetID") ?? null,
    celestialEffect: getStationRenderMetadata(station, "celestialEffect") ?? null,
    velocity: { x: 0, y: 0, z: 0 },
  };
}

// A reciprocal gate can only stand in the system this gate points at, and a
// service proximity conflict can only come from the gate's own system, so these
// two systems are the whole candidate set. Reading them live keeps the 10 Hz
// entity rebuild off listStructures, which clones every structure record.
function listJumpBridgeLinkCandidates(structure) {
  const sourceSystemID = Number(structure && structure.solarSystemID) || 0;
  const destinationSystemID = getJumpBridgeDestinationSolarSystemID(structure);
  const candidates = structureState.peekStructuresForSystem(sourceSystemID);
  if (!destinationSystemID || destinationSystemID === sourceSystemID) {
    return candidates;
  }
  return candidates.concat(
    structureState.peekStructuresForSystem(destinationSystemID),
  );
}

// A FLEX structure's graphic animates on the slim's activationState, which the
// client copies into the ActivationState controller variable
// (clientControllerRegistry.py DefaultSetup), on load and on every slim change.
// The Ansiblex's Structure_Gate controller plays Inactive (0), Active_Unlinked
// (1) or Active_Linked (2); the Tenebrex's Generic_ActivationState_TwoState_01a
// plays Inactive (0) or Active (1). Without the field the client sets 0, so an
// online, linked gate stays dark. Other structures send none.
const FLEX_ACTIVATION_SERVICE_ID_BY_TYPE_ID = Object.freeze({
  35840: STRUCTURE_SERVICE_ID.CYNO_BEACON,
  35841: STRUCTURE_SERVICE_ID.JUMP_BRIDGE,
  37534: STRUCTURE_SERVICE_ID.CYNO_JAMMER,
});

function resolveFlexActivationState(structure, jumpBridgeCandidates, jumpDestination) {
  const serviceID = FLEX_ACTIVATION_SERVICE_ID_BY_TYPE_ID[toInt(structure && structure.typeID, 0)];
  if (!serviceID) {
    return null;
  }
  if (isAnsiblexStructure(structure)) {
    if (jumpDestination) {
      return 2;
    }
    return isJumpBridgeServiceAvailable(structure, jumpBridgeCandidates) ? 1 : 0;
  }
  return toInt(structure.serviceStates && structure.serviceStates[serviceID], 0) ===
    STRUCTURE_SERVICE_STATE.ONLINE
    ? 1
    : 0;
}

// An Upwell structure's slim lists its fitted modules as (itemID, typeID,
// flagID), the way a ship's does: every low, medium and high slot module, and
// of the service modules only the Standup Moon Drill. TQ golden logs (every
// categoryID 65 slimItem in LOGS, e.g. CONCORD\0.5 Sec Space.lsw: Athanor
// modules=[(1055752106020, 45009, 164)]) never list another service module,
// a rig or a charge. The client fits hardpoints from this list, and the moon
// extraction effect fires from the drill found here (MultiEffect.py
// EvePhasePlayer.GetTurretSet looks the module up in ball.modules).
const STRUCTURE_SLIM_SERVICE_MODULE_TYPE_IDS = new Set([45009]);
const CHARGE_CATEGORY_ID = 8;

function buildStructureSlimModuleTuples(structureID) {
  const numericStructureID = toInt(structureID, 0);
  if (numericStructureID <= 0) {
    return [];
  }
  const isSlotFlag = (flagID) => (
    SLOT_FAMILY_FLAGS.low.includes(flagID) ||
    SLOT_FAMILY_FLAGS.med.includes(flagID) ||
    SLOT_FAMILY_FLAGS.high.includes(flagID)
  );
  return listFittedItemsForLocation(numericStructureID)
    .filter((item) => {
      const flagID = toInt(item && item.flagID, 0);
      if (isSlotFlag(flagID)) {
        return toInt(item.categoryID, 0) !== CHARGE_CATEGORY_ID;
      }
      return SLOT_FAMILY_FLAGS.service.includes(flagID) &&
        STRUCTURE_SLIM_SERVICE_MODULE_TYPE_IDS.has(toInt(item.typeID, 0));
    })
    .map((item) => [
      toInt(item.itemID, 0),
      toInt(item.typeID, 0),
      toInt(item.flagID, 0),
    ]);
}

function buildStaticStructureEntity(structure) {
  const typeRecord = structureState.getStructureTypeByID(structure && structure.typeID);
  const jumpBridgeCandidates = isAnsiblexStructure(structure)
    ? listJumpBridgeLinkCandidates(structure)
    : null;
  const jumpDestination = jumpBridgeCandidates
    ? getActiveJumpBridgeDestination(structure, jumpBridgeCandidates)
    : null;
  const effectiveHitpoints = resolveStructureEffectiveHitpoints(structure);
  const entosisCapture =
    structure &&
    structure.devFlags &&
    typeof structure.devFlags.entosisCapture === "object"
      ? structure.devFlags.entosisCapture
      : structure && typeof structure.entosisCapture === "object"
        ? structure.entosisCapture
        : structure && typeof structure.entosisCaptureProjection === "object"
          ? structure.entosisCaptureProjection
          : null;
  const campaignSourceInfo =
    structure && structure.devFlags && Array.isArray(structure.devFlags.campaignSourceInfo)
      ? structure.devFlags.campaignSourceInfo
      : structure && Array.isArray(structure.campaignSourceInfo)
        ? structure.campaignSourceInfo
        : null;
  const dockingGeometry = structureLocatorGeometry.buildStructureDockingGeometry(
    structure,
    {
      selectionStrategy: "first",
    },
  );
  const passiveResourceState = buildPassiveShipResourceState(
    0,
    {
      itemID: structure && structure.structureID,
      typeID: structure && structure.typeID,
      groupID: typeRecord && typeRecord.groupID,
      categoryID: typeRecord && typeRecord.categoryID,
      itemName: structure && (structure.itemName || structure.name),
      radius: structure && structure.radius,
      conditionState: structure && structure.conditionState,
    },
    {
      fittedItems: [],
      skillMap: new Map(),
      additionalAttributeModifierEntries:
        wormholeEnvironmentRuntime.collectShipAttributeModifierEntriesForSystem(
          structure && structure.solarSystemID,
        ),
    },
  );
  return {
    kind: "structure",
    itemID: structure.structureID,
    typeID: structure.typeID,
    groupID:
      (typeRecord && typeRecord.groupID) ||
      toInt(structure && structure.groupID, 1657),
    categoryID:
      (typeRecord && typeRecord.categoryID) ||
      toInt(structure && structure.categoryID, 65),
    itemName: structure.itemName || structure.name || `Structure ${structure.structureID}`,
    ownerID: structure.ownerCorpID || structure.ownerID || 1,
    corporationID: structure.ownerCorpID || 0,
    allianceID: structure.allianceID || 0,
    warFactionID: 0,
    radius: Math.max(getStationInteractionRadius(structure), toFiniteNumber(structure.radius, 0)),
    interactionRadius: Math.max(getStationInteractionRadius(structure), toFiniteNumber(structure.radius, 0)),
    position: cloneVector(structure.position),
    dockPosition: cloneVector(dockingGeometry.dockPosition),
    dockOrientation: cloneVector(dockingGeometry.dockOrientation),
    undockDirection: cloneVector(dockingGeometry.undockDirection),
    undockPosition: cloneVector(dockingGeometry.undockPosition),
    rotation: Array.isArray(dockingGeometry.dunRotation)
      ? [...dockingGeometry.dunRotation]
      : coerceDunRotationTuple(structure && structure.rotation),
    dunRotation: Array.isArray(dockingGeometry.dunRotation)
      ? [...dockingGeometry.dunRotation]
      : coerceDunRotationTuple(structure && structure.rotation),
    velocity: { x: 0, y: 0, z: 0 },
    state: structure.state,
    ...([TYPE_TERRITORIAL_CLAIM_UNIT, TYPE_INFRASTRUCTURE_HUB].includes(structure.typeID) ? {
      selfDestructTime: structure.selfDestructAt
        ? require("./runtimeClock").toFileTimeFromMs(structure.selfDestructAt) : null,
    } : {}),
    initialStructureBundle:
      structure &&
      structure.devFlags &&
      structure.devFlags.structureDeployment === true &&
      toInt(structure.state, 0) === STRUCTURE_STATE.ANCHOR_VULNERABLE,
    stateStartedAt: structure.stateStartedAt || null,
    stateEndsAt: structure.stateEndsAt || null,
    deployStartedAt: structure.deployStartedAt || null,
    deployEndsAt: structure.deployEndsAt || null,
    timerPausedAt: structure.timerPausedAt || null,
    upkeepState: structure.upkeepState,
    deedState: structure.hasQuantumCore === true ? 1 : 0,
    serviceStates: structure.serviceStates || {},
    // The client gates Jump and local autopilot routing on this slim field.
    targetSolarsystemID: jumpDestination ? jumpDestination.solarSystemID : null,
    destinationID: jumpDestination ? jumpDestination.structureID : null,
    destinationSolarSystemID: jumpDestination ? jumpDestination.solarSystemID : null,
    activationState: resolveFlexActivationState(structure, jumpBridgeCandidates, jumpDestination),
    unanchoring: structure.unanchoring || null,
    repairing: structureState.resolveStructureRepairingValue(structure),
    docked: structureState.countCharactersDockedInStructure(structure.structureID),
    modules: buildStructureSlimModuleTuples(structure.structureID),
    // The moon a refinery or Metenox is bound to, and the Metenox's last
    // harvest (the hour its fuel cycle last ran). destiny sends them as the
    // drill slim fields.
    moonID: toInt(structure.moonID, 0) || null,
    autoMoonMinerLastHarvestAt:
      toInt(
        structure.devFlags &&
          structure.devFlags.autoMoonFuelState &&
          structure.devFlags.autoMoonFuelState.lastCycleAt,
        0,
      ) || null,
    dockable: structure.dockable === true,
    accessProfile:
      structure && structure.accessProfile && typeof structure.accessProfile === "object"
        ? { ...structure.accessProfile }
        : null,
    destroyedAt: structure.destroyedAt || null,
    capacitorCapacity: toFiniteNumber(passiveResourceState.capacitorCapacity, 0),
    capacitorRechargeRate: toFiniteNumber(
      passiveResourceState.capacitorRechargeRate,
      0,
    ),
    capacitorChargeRatio: clamp(
      toFiniteNumber(
        structure && structure.conditionState && structure.conditionState.charge,
        1,
      ),
      0,
      1,
    ),
    shieldCapacity: toFiniteNumber(
      effectiveHitpoints.effectiveShieldCapacity,
      toFiniteNumber(passiveResourceState.shieldCapacity, 0),
    ),
    armorHP: toFiniteNumber(
      effectiveHitpoints.effectiveArmorHP,
      toFiniteNumber(passiveResourceState.armorHP, 0),
    ),
    structureHP: toFiniteNumber(
      effectiveHitpoints.effectiveStructureHP,
      toFiniteNumber(passiveResourceState.structureHP, 0),
    ),
    conditionState: normalizeShipConditionState(structure.conditionState),
    passiveDerivedState: passiveResourceState,
    // Combat and locking read the live signature, independently of geometry.
    signatureRadius: toFiniteNumber(passiveResourceState.signatureRadius, 0),
    tetheringRange: toFiniteNumber(structure.tetheringRange, 0),
    tetherRepairEffectMode:
      structure &&
      structure.tetherRepairEffectMode !== undefined &&
      structure.tetherRepairEffectMode !== null
        ? String(structure.tetherRepairEffectMode)
        : null,
    maxTargetRange: toFiniteNumber(structure.maxTargetRange, 0),
    maxLockedTargets: toFiniteNumber(structure.maxLockedTargets, 0),
    entosisCapture:
      entosisCapture && typeof entosisCapture === "object"
        ? { ...entosisCapture }
        : null,
    campaignSourceInfo:
      campaignSourceInfo && campaignSourceInfo.length >= 4
        ? campaignSourceInfo.slice(0, 4)
        : null,
  };
}

function buildStaticCelestialEntity(celestial) {
  return {
    kind: celestial.kind || "celestial",
    itemID: celestial.itemID,
    typeID: celestial.typeID,
    groupID: celestial.groupID,
    categoryID: celestial.categoryID,
    itemName: celestial.itemName,
    ownerID: 1,
    radius: celestial.radius || (celestial.groupID === 10 ? 15000 : 1000),
    position: cloneVector(celestial.position),
    velocity: { x: 0, y: 0, z: 0 },
  };
}

function buildStaticMoonMiningBeaconEntity(point) {
  return {
    kind: "moonMiningBeacon",
    itemID: point.beaconID,
    typeID: point.typeID,
    groupID: point.groupID,
    categoryID: 2,
    itemName: `Moon Mining Beacon (${point.moonID})`,
    ownerID: 1,
    radius: 0,
    position: cloneVector(point.position),
    velocity: { x: 0, y: 0, z: 0 },
    moonID: point.moonID,
    solarSystemID: point.solarSystemID,
    moonMiningPointDatasetVersion: point.datasetVersion,
  };
}

function buildPlanetOrbitalPosition(orbital) {
  const planet = worldData.getCelestialByID(orbital && orbital.planetID);
  return buildOrbitalPosition(planet, orbital);
}

function buildStaticPlanetOrbitalEntity(orbital) {
  const typeID = toInt(orbital && orbital.typeID, 0);
  const metadata = getItemMetadata(typeID, orbital && orbital.itemName);
  const radius = Math.max(
    1,
    toFiniteNumber(orbital && orbital.radius, toFiniteNumber(metadata && metadata.radius, 7_500)),
  );
  const position = buildPlanetOrbitalPosition(orbital);
  const resolvedTypeID = toInt(metadata && metadata.typeID, typeID);
  return {
    kind: "orbital",
    itemID: toInt(orbital && orbital.itemID, 0),
    typeID: toInt(metadata && metadata.typeID, typeID),
    groupID: toInt(orbital && orbital.groupID, toInt(metadata && metadata.groupID, 0)),
    categoryID: planetOrbitalState.CATEGORY_ORBITAL,
    itemName: String(orbital && orbital.itemName || (metadata && metadata.name) || "Customs Office"),
    ownerID: toInt(orbital && orbital.ownerID, 0),
    corporationID: toInt(orbital && orbital.corporationID, toInt(orbital && orbital.ownerID, 0)),
    allianceID: toInt(orbital && orbital.allianceID, 0),
    warFactionID: toInt(orbital && orbital.warFactionID, 0),
    locationID: toInt(orbital && orbital.solarSystemID, 0),
    systemID: toInt(orbital && orbital.solarSystemID, 0),
    planetID: toInt(orbital && orbital.planetID, 0),
    level: Math.max(0, toInt(orbital && orbital.level, 0)),
    orbitalState: toInt(orbital && orbital.state, planetOrbitalState.ORBITAL_STATE.ANCHORED),
    ...(typeID === 81080 ? {
      ...require("../../services/planet/planetOrbitalReinforcement").getSkyhookPresentation(
        orbital,
        [planetOrbitalState.ORBITAL_STATE.IDLE, planetOrbitalState.ORBITAL_STATE.OPERATING]
          .includes(Number(orbital && orbital.state)) && !orbital.destroyedAtMs,
      ),
      component_activate: [
        [planetOrbitalState.ORBITAL_STATE.IDLE, planetOrbitalState.ORBITAL_STATE.OPERATING]
          .includes(Number(orbital && orbital.state)) && !orbital.destroyedAtMs,
        Number(orbital && orbital.state) === planetOrbitalState.ORBITAL_STATE.ONLINING
          ? toFiniteNumber(orbital && orbital.stateEndsAtMs, 0) || null : null,
      ],
    } : {}),
    orbitalTimestampMs: toFiniteNumber(orbital && orbital.stateEndsAtMs, 0) || null,
    orbitalHackerID: null,
    orbitalHackerProgress: null,
    radius,
    signatureRadius: radius,
    position,
    velocity: { x: 0, y: 0, z: 0 },
    direction: cloneVector(DEFAULT_RIGHT),
    targetPoint: cloneVector(position),
    mode: "STOP",
    speedFraction: 0,
    // A Customs Office is a combat target, so it needs the same dogma-derived
    // health envelope the inventory-backed and Upwell builders provide.  Without
    // it hasDamageableHealth() reports false and every weapon activation against
    // the office is rejected with TARGET_NOT_FOUND.
    passiveDerivedState: {
      attributes: getTypeDogmaAttributes(resolvedTypeID),
    },
    shieldCapacity: Math.max(0, toFiniteNumber(
      getTypeAttributeValue(resolvedTypeID, "shieldCapacity"),
      0,
    )),
    shieldRechargeRate: Math.max(0, toFiniteNumber(
      getTypeAttributeValue(resolvedTypeID, "shieldRechargeRate"),
      0,
    )),
    armorHP: Math.max(0, toFiniteNumber(
      getTypeAttributeValue(resolvedTypeID, "armorHP"),
      0,
    )),
    structureHP: Math.max(0, toFiniteNumber(
      getTypeAttributeValue(resolvedTypeID, "hp", "structureHP"),
      0,
    )),
    conditionState: normalizeShipConditionState(orbital && orbital.conditionState),
    dunRotation: Array.isArray(orbital && orbital.dunRotation)
      ? [...orbital.dunRotation]
      : [0, 0, 0],
  };
}

function buildStaticAsteroidBeltEntity(asteroidBelt) {
  return {
    kind: asteroidBelt.kind || "asteroidBelt",
    nonPhysicalDecloakExempt: true,
    itemID: asteroidBelt.itemID,
    typeID: asteroidBelt.typeID,
    groupID: asteroidBelt.groupID,
    categoryID: asteroidBelt.categoryID,
    itemName: asteroidBelt.itemName,
    ownerID: 1,
    radius: asteroidBelt.radius || 15_000,
    position: cloneVector(asteroidBelt.position),
    velocity: { x: 0, y: 0, z: 0 },
  };
}

function buildStaticStargateEntity(stargate) {
  const sourceSystem = worldData.getSolarSystemByID(stargate && stargate.solarSystemID);
  const destinationSystem = worldData.getSolarSystemByID(
    stargate && stargate.destinationSolarSystemID,
  );
  const originSystemOwnerID = getSystemOwnerID(sourceSystem);
  const destinationSystemOwnerID = getSystemOwnerID(destinationSystem);
  const destinationSystemStatusIcons = getStargateStatusIcons(
    stargate,
    destinationSystem,
  );
  const destinationSystemWarningIcon = getStargateWarningIcon(
    stargate,
    sourceSystem,
    destinationSystem,
  );
  const dunRotation = getResolvedStargateDunRotation(stargate);
  const groupID = toInt(getStargateTypeMetadata(stargate, "groupID"), 10);
  const categoryID = toInt(getStargateTypeMetadata(stargate, "categoryID"), 2);
  const skinMaterialSetID = getStargateRenderMetadata(
    stargate,
    "skinMaterialSetID",
  );

  return {
    kind: "stargate",
    itemID: stargate.itemID,
    typeID: stargate.typeID,
    groupID,
    categoryID,
    itemName: stargate.itemName,
    ownerID: originSystemOwnerID || 1,
    radius: resolveStargatePhysicalRadius(stargate),
    interactionRadius: getStargateInteractionRadius(stargate),
    position: cloneVector(stargate.position),
    velocity: { x: 0, y: 0, z: 0 },
    typeName: getStargateTypeMetadata(stargate, "typeName") || null,
    groupName: getStargateTypeMetadata(stargate, "groupName") || null,
    graphicID: toInt(getStargateTypeMetadata(stargate, "graphicID"), 0) || null,
    raceID: toInt(getStargateTypeMetadata(stargate, "raceID"), 0) || null,
    destinationID: stargate.destinationID,
    destinationSolarSystemID: stargate.destinationSolarSystemID,
    activationState: coerceStableActivationState(
      stargate.activationState,
      STARGATE_ACTIVATION_STATE.OPEN,
    ),
    activationTransitionAtMs: 0,
    poseID: toInt(stargate.poseID, 0),
    localCorruptionStageAndMaximum: coerceStageTuple(
      stargate.localCorruptionStageAndMaximum,
    ),
    destinationCorruptionStageAndMaximum: coerceStageTuple(
      stargate.destinationCorruptionStageAndMaximum,
    ),
    localSuppressionStageAndMaximum: coerceStageTuple(
      stargate.localSuppressionStageAndMaximum,
    ),
    destinationSuppressionStageAndMaximum: coerceStageTuple(
      stargate.destinationSuppressionStageAndMaximum,
    ),
    hasVolumetricDrifterCloud: Boolean(stargate.hasVolumetricDrifterCloud),
    originSystemOwnerID,
    destinationSystemOwnerID,
    destinationSystemWarning: destinationSystemWarningIcon,
    destinationSystemWarningIcon,
    destinationSystemStatusIcons,
    dunRotation,
    ...(skinMaterialSetID !== undefined && skinMaterialSetID !== null
      ? { skinMaterialSetID }
      : {}),
  };
}

Object.assign(module.exports, {
  INCLUDE_STARGATES_IN_SCENE,
  STARGATE_ACTIVATION_STATE,
  STARGATE_ACTIVATION_TRANSITION_MS,
});
