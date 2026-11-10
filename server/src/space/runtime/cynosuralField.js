"use strict";

module.exports = {
  clearCynosuralFieldForEffect,
  getFleetRuntime,
  isCynosuralGenerationEffect,
  resolveCynosuralFieldTypeID,
  setFleetCynoBeaconState,
  spawnCynosuralFieldForEffect,
};

const runtimeEntryDirname = require("path").resolve(__dirname, "..");
const path = require("path");
const log = require(path.join(runtimeEntryDirname, "../utils/logger"));
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
const {
  toFiniteNumber,
  toInt,
} = require("../../common/numbers");
const {
  allocateRuntimeEntityID,
} = require("./runtimeEntityIdentity");
const {
  lazyRequire,
} = require("./runtimeModuleBoundary");
const {
  DEFAULT_RIGHT,
  cloneVector,
} = require("../../common/vector");

const CYNO_EFFECT_GENERATION = "cynosuralGeneration";

const TYPE_CYNOSURAL_FIELD = 21094;

const TYPE_COVERT_CYNOSURAL_FIELD = 28650;

const TYPE_INDUSTRIAL_CYNOSURAL_FIELD = 52696;

const TYPE_COVERT_CYNOSURAL_FIELD_GENERATOR = 28646;

const TYPE_INDUSTRIAL_CYNOSURAL_FIELD_GENERATOR = 52694;

function isCynosuralGenerationEffect(effectRecordOrState) {
  return String(
    effectRecordOrState && (
      effectRecordOrState.name ||
      effectRecordOrState.effectName
    ) || "",
  ).trim() === CYNO_EFFECT_GENERATION;
}

function resolveCynosuralFieldTypeID(moduleItem) {
  const moduleTypeID = toInt(moduleItem && moduleItem.typeID, 0);
  if (moduleTypeID === TYPE_COVERT_CYNOSURAL_FIELD_GENERATOR) {
    return TYPE_COVERT_CYNOSURAL_FIELD;
  }
  if (moduleTypeID === TYPE_INDUSTRIAL_CYNOSURAL_FIELD_GENERATOR) {
    return TYPE_INDUSTRIAL_CYNOSURAL_FIELD;
  }
  return TYPE_CYNOSURAL_FIELD;
}

function getFleetRuntime() {
  return lazyRequire("../services/fleets/fleetRuntime");
}

function setFleetCynoBeaconState(session, fieldEntity, fieldTypeID, active) {
  const fleetID = toInt(session && session.fleetid, 0);
  const characterID = toInt(session && session.characterID, 0);
  const solarSystemID = toInt(
    fieldEntity && fieldEntity.systemID,
    toInt(session && (session.solarsystemid2 || session.solarsystemid), 0),
  );
  const beaconID = toInt(fieldEntity && fieldEntity.itemID, 0);
  if (fleetID <= 0 || characterID <= 0 || solarSystemID <= 0 || beaconID <= 0) {
    return false;
  }

  try {
    return getFleetRuntime().setJumpBeaconModuleState(
      fleetID,
      characterID,
      solarSystemID,
      beaconID,
      fieldTypeID,
      active === true,
    );
  } catch (error) {
    log.warn(
      `[SpaceRuntime] Failed to update fleet cyno beacon state ` +
        `fleet=${fleetID} char=${characterID} beacon=${beaconID}: ${error.message}`,
    );
    return false;
  }
}

function spawnCynosuralFieldForEffect(
  scene,
  session,
  shipEntity,
  moduleItem,
  effectRecord,
  nowMs,
  options = {},
) {
  if (!scene || !shipEntity || !moduleItem || !isCynosuralGenerationEffect(effectRecord)) {
    return { success: true, data: null };
  }

  const fieldTypeID = resolveCynosuralFieldTypeID(moduleItem);
  const metadata = getItemMetadata(fieldTypeID, "Cynosural Field");
  const durationMs = Math.max(
    1,
    toFiniteNumber(
      options.durationMs,
      toFiniteNumber(getTypeAttributeValue(moduleItem.typeID, "duration"), 0),
    ),
  );
  const fieldEntity = {
    kind: "cynoField",
    itemID: allocateRuntimeEntityID(),
    typeID: fieldTypeID,
    groupID: toInt(metadata && metadata.groupID, fieldTypeID === TYPE_COVERT_CYNOSURAL_FIELD ? 897 : 2020),
    categoryID: toInt(metadata && metadata.categoryID, 2),
    ownerID: toInt(shipEntity.ownerID || shipEntity.characterID || session && session.characterID, 0),
    corporationID: toInt(shipEntity.corporationID || session && session.corporationID, 0),
    allianceID: toInt(shipEntity.allianceID || session && session.allianceID, 0),
    itemName: String(metadata && metadata.name || "Cynosural Field"),
    position: cloneVector(shipEntity.position),
    velocity: { x: 0, y: 0, z: 0 },
    direction: cloneVector(shipEntity.direction, DEFAULT_RIGHT),
    targetPoint: cloneVector(shipEntity.position),
    radius: Math.max(1, toFiniteNumber(metadata && metadata.radius, 250)),
    mode: "STOP",
    createdAtMs: nowMs,
    expiresAtMs: nowMs + durationMs,
    sourceShipID: toInt(shipEntity.itemID, 0),
    sourceCharacterID: toInt(session && session.characterID, toInt(shipEntity.characterID, 0)),
    sourceModuleID: toInt(moduleItem.itemID, 0),
    cynosuralFieldSpawnRadius: Math.max(
      0,
      toFiniteNumber(
        getTypeAttributeValue(moduleItem.typeID, "cynosuralFieldSpawnRadius"),
        0,
      ),
    ),
  };

  const spawnResult = scene.spawnDynamicEntity(fieldEntity, {
    broadcast: true,
  });
  if (!spawnResult.success) {
    return spawnResult;
  }

  setFleetCynoBeaconState(session, fieldEntity, fieldTypeID, true);
  return {
    success: true,
    data: {
      fieldEntity,
      fieldTypeID,
    },
  };
}

function clearCynosuralFieldForEffect(scene, session, effectState, options = {}) {
  if (!scene || !effectState || effectState.cynosuralGeneration !== true) {
    return false;
  }

  const fieldEntityID = toInt(effectState.cynosuralFieldEntityID, 0);
  const fieldTypeID = toInt(effectState.cynosuralFieldTypeID, TYPE_CYNOSURAL_FIELD);
  const fieldEntity =
    fieldEntityID > 0 && typeof scene.getEntityByID === "function"
      ? scene.getEntityByID(fieldEntityID)
      : null;
  const stateSession = session || {
    fleetid: effectState.cynosuralFleetID || 0,
    characterID: effectState.cynosuralCharacterID || 0,
    solarsystemid2: effectState.cynosuralSolarSystemID || 0,
  };
  const stateEntity = fieldEntity || {
    itemID: fieldEntityID,
    systemID: effectState.cynosuralSolarSystemID || 0,
  };

  setFleetCynoBeaconState(stateSession, stateEntity, fieldTypeID, false);

  if (fieldEntityID > 0) {
    scene.removeDynamicEntity(fieldEntityID, {
      broadcast: options.broadcast !== false,
      nowMs: options.nowMs,
    });
  }
  return true;
}

Object.assign(module.exports, {
  CYNO_EFFECT_GENERATION,
  TYPE_COVERT_CYNOSURAL_FIELD,
  TYPE_COVERT_CYNOSURAL_FIELD_GENERATOR,
  TYPE_CYNOSURAL_FIELD,
  TYPE_INDUSTRIAL_CYNOSURAL_FIELD,
  TYPE_INDUSTRIAL_CYNOSURAL_FIELD_GENERATOR,
});
