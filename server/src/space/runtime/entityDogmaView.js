"use strict";

module.exports = {
  buildRuntimeShipItemFromEntity,
  getEntityRuntimeActiveModuleContexts,
  getEntityRuntimeFittedItems,
  getEntityRuntimeLoadedCharge,
  getEntityRuntimeLoadedChargeFromFittedItems,
  getEntityRuntimeModuleItem,
  getEntityRuntimeModuleOwnerItems,
  getEntityRuntimeShipItem,
  getEntityRuntimeSkillMap,
  getShipEntityInventoryCharacterID,
  getSkillLevel,
  isRuntimeDogmaHostEntity,
  isRuntimeStructureDogmaHostEntity,
  isShipFittingFlag,
};

const runtimeEntryDirname = require("path").resolve(__dirname, "..");
const path = require("path");
const starbaseDefenseRuntime = require("../../services/starbase/starbaseDefenseRuntime");
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
  isNativeNpcEntity,
  getNpcFittedModuleItems,
  getNpcLoadedChargeForModule,
  getNpcWeaponModules,
  buildNpcWeaponModuleSnapshot,
  getNpcHostileModules,
  getNpcAssistanceModules,
  getNpcSelfModules,
  getNpcSuperweaponModules,
  getNpcPropulsionModules,
} = require(path.join(runtimeEntryDirname, "./npc/npcEquipment"));
const structureState = require(path.join(
  runtimeEntryDirname,
  "../services/structure/structureState",
));
const {
  resolveActiveShipRecord,
} = require("./characterStateBridge");
const {
  toFiniteNumber,
  toInt,
} = require("../../common/numbers");

const SHIP_FITTING_FLAG_RANGES = Object.freeze([
  Object.freeze([11, 34]),
  Object.freeze([92, 99]),
  Object.freeze([125, 132]),
]);

function isShipFittingFlag(flagID) {
  const numericFlagID = toInt(flagID, 0);
  return SHIP_FITTING_FLAG_RANGES.some(
    ([minimum, maximum]) =>
      numericFlagID >= minimum && numericFlagID <= maximum,
  );
}

function getShipEntityInventoryCharacterID(entity, fallback = 0) {
  if (starbaseDefenseRuntime.isStarbaseBattery(entity)) return 0;
  return toInt(
    entity && (
      entity.pilotCharacterID ??
      entity.characterID
    ),
    fallback,
  );
}

function isRuntimeDogmaHostEntity(entity) {
  return Boolean(
    entity &&
    (
      entity.kind === "ship" ||
      entity.kind === "structure" ||
      starbaseDefenseRuntime.isStarbaseBattery(entity)
    ),
  );
}

function isRuntimeStructureDogmaHostEntity(entity) {
  if (!isRuntimeDogmaHostEntity(entity)) {
    return false;
  }
  if (entity.kind === "structure" || isStructureDogmaHost(entity)) {
    return true;
  }

  const entityID = toInt(entity.itemID, 0);
  return entityID > 0 && Boolean(
    structureState.getStructureByID(entityID, { refresh: false }),
  );
}

function buildRuntimeShipItemFromEntity(entity) {
  if (!isRuntimeDogmaHostEntity(entity)) {
    return null;
  }

  return {
    itemID: toInt(entity.itemID, 0),
    typeID: toInt(entity.typeID, 0),
    groupID: toInt(entity.groupID, 0),
    categoryID: toInt(entity.categoryID, 0),
    itemName: String(entity.itemName || entity.slimName || "Ship"),
    ownerID: toInt(entity.ownerID, 0),
    radius: toFiniteNumber(entity.radius, 0),
    conditionState: normalizeShipConditionState(entity.conditionState),
  };
}

function getEntityRuntimeSkillMap(entity) {
  if (starbaseDefenseRuntime.isStarbaseBattery(entity)) return new Map();
  if (!isRuntimeDogmaHostEntity(entity)) {
    return new Map();
  }

  if (entity.skillMap instanceof Map) {
    return resolveDogmaSkillMapForHost(
      getShipEntityInventoryCharacterID(entity, 0),
      buildRuntimeShipItemFromEntity(entity),
      { skillMap: entity.skillMap },
    );
  }

  const characterID = getShipEntityInventoryCharacterID(entity, 0);
  if (characterID <= 0) {
    return new Map();
  }
  // resolveDogmaSkillMapForHost falls back to the cached skill map when none is
  // supplied, so pass none rather than re-fetching it here.
  return resolveDogmaSkillMapForHost(
    characterID,
    buildRuntimeShipItemFromEntity(entity),
    {},
  );
}

function getEntityRuntimeShipItem(entity) {
  if (!isRuntimeDogmaHostEntity(entity)) {
    return null;
  }
  if (starbaseDefenseRuntime.isStarbaseBattery(entity)) {
    return findItemById(entity.itemID) || null;
  }

  const structureDogmaHost = isRuntimeStructureDogmaHostEntity(entity);
  const characterID = getShipEntityInventoryCharacterID(entity, 0);
  if (characterID > 0) {
    return structureDogmaHost
      ? buildRuntimeShipItemFromEntity(entity)
      : resolveActiveShipRecord(characterID) ||
        findShipItemById(entity.itemID) ||
        buildRuntimeShipItemFromEntity(entity);
  }

  return buildRuntimeShipItemFromEntity(entity);
}

function getEntityRuntimeFittedItems(entity) {
  if (!isRuntimeDogmaHostEntity(entity)) {
    return [];
  }
  if (starbaseDefenseRuntime.isStarbaseBattery(entity)) {
    return starbaseDefenseRuntime.getBatteryFittedItems(entity.itemID);
  }

  if (isNativeNpcEntity(entity)) {
    return getNpcFittedModuleItems(entity);
  }

  if (isRuntimeStructureDogmaHostEntity(entity)) {
    const locationItems = listFittedItemsForLocation(toInt(entity.itemID, 0));
    if (locationItems.length > 0) {
      return locationItems;
    }
    if (Array.isArray(entity.fittedItems)) {
      return entity.fittedItems.map((item) => ({ ...item }));
    }
  }

  const characterID = getShipEntityInventoryCharacterID(entity, 0);
  if (characterID > 0) {
    return getFittedModuleItems(characterID, entity.itemID);
  }

  return Array.isArray(entity.fittedItems)
    ? entity.fittedItems.map((item) => ({ ...item }))
    : [];
}

function getEntityRuntimeModuleOwnerItems(entity) {
  const candidateItems = [
    ...getEntityRuntimeFittedItems(entity),
    ...(isNativeNpcEntity(entity)
      ? [
        ...getNpcWeaponModules(entity),
        ...getNpcHostileModules(entity).map((entry) => entry && entry.moduleItem).filter(Boolean),
        ...getNpcAssistanceModules(entity).map((entry) => entry && entry.moduleItem).filter(Boolean),
        ...getNpcSelfModules(entity).map((entry) => entry && entry.moduleItem).filter(Boolean),
        ...getNpcSuperweaponModules(entity),
        ...getNpcPropulsionModules(entity).map((entry) => entry && entry.moduleItem).filter(Boolean),
      ]
      : []),
  ];
  const seenModuleIDs = new Set();
  const moduleOwnerItems = [];
  for (const moduleItem of candidateItems) {
    if (!moduleItem) {
      continue;
    }
    const candidateModuleID = toInt(moduleItem && moduleItem.itemID, 0);
    if (candidateModuleID > 0) {
      if (seenModuleIDs.has(candidateModuleID)) {
        continue;
      }
      seenModuleIDs.add(candidateModuleID);
    }
    moduleOwnerItems.push(moduleItem);
  }
  return moduleOwnerItems;
}

function getEntityRuntimeModuleItem(entity, moduleID = 0, moduleFlagID = 0) {
  const normalizedModuleID = toInt(moduleID, 0);
  const normalizedModuleFlagID = toInt(moduleFlagID, 0);
  for (const moduleItem of getEntityRuntimeModuleOwnerItems(entity)) {
    const candidateModuleID = toInt(moduleItem && moduleItem.itemID, 0);
    if (
      (normalizedModuleID > 0 && candidateModuleID === normalizedModuleID) ||
      (normalizedModuleFlagID > 0 && toInt(moduleItem && moduleItem.flagID, 0) === normalizedModuleFlagID)
    ) {
      return moduleItem;
    }
  }
  return null;
}

function getEntityRuntimeLoadedChargeFromFittedItems(
  entity,
  resolvedModuleItem,
  resolvedFlagID,
) {
  const normalizedFlagID = toInt(resolvedFlagID, 0);
  if (!entity || normalizedFlagID <= 0) {
    return null;
  }

  const resolvedModuleID = toInt(resolvedModuleItem && resolvedModuleItem.itemID, 0);
  const resolvedModuleTypeID = toInt(resolvedModuleItem && resolvedModuleItem.typeID, 0);
  const resolvedModuleOwnerID = toInt(resolvedModuleItem && resolvedModuleItem.ownerID, 0);
  const fittedItems = getEntityRuntimeFittedItems(entity);
  const chargeItem = fittedItems.find((candidate) => {
    if (!candidate || toInt(candidate.itemID, 0) === resolvedModuleID) {
      return false;
    }
    if (toInt(candidate.flagID, 0) !== normalizedFlagID) {
      return false;
    }
    if (
      resolvedModuleOwnerID > 0 &&
      toInt(candidate.ownerID, 0) > 0 &&
      toInt(candidate.ownerID, 0) !== resolvedModuleOwnerID
    ) {
      return false;
    }
    const candidateTypeID = toInt(candidate.typeID, 0);
    return resolvedModuleTypeID > 0
      ? isChargeCompatibleWithModule(resolvedModuleTypeID, candidateTypeID)
      : candidateTypeID > 0;
  });

  return chargeItem ? { ...chargeItem } : null;
}

function getEntityRuntimeLoadedCharge(entity, moduleItem = null, moduleFlagID = 0) {
  if (!isRuntimeDogmaHostEntity(entity)) {
    return null;
  }

  const resolvedModuleItem =
    moduleItem ||
    getEntityRuntimeModuleItem(entity, 0, moduleFlagID);
  const resolvedFlagID = toInt(
    resolvedModuleItem && resolvedModuleItem.flagID,
    moduleFlagID,
  );
  if (resolvedFlagID <= 0) {
    return null;
  }

  if (isNativeNpcEntity(entity)) {
    return resolvedModuleItem
      ? getNpcLoadedChargeForModule(entity, resolvedModuleItem)
      : null;
  }

  if (isRuntimeStructureDogmaHostEntity(entity)) {
    if (
      resolvedModuleItem &&
      resolvedModuleItem.loadedChargeItem &&
      toInt(resolvedModuleItem.loadedChargeItem.typeID, 0) > 0
    ) {
      return {
        ...resolvedModuleItem.loadedChargeItem,
      };
    }

    return getEntityRuntimeLoadedChargeFromFittedItems(
      entity,
      resolvedModuleItem,
      resolvedFlagID,
    );
  }

  const characterID = getShipEntityInventoryCharacterID(entity, 0);
  if (characterID <= 0) {
    if (
      resolvedModuleItem &&
      resolvedModuleItem.loadedChargeItem &&
      toInt(resolvedModuleItem.loadedChargeItem.typeID, 0) > 0
    ) {
      return {
        ...resolvedModuleItem.loadedChargeItem,
      };
    }

    return getEntityRuntimeLoadedChargeFromFittedItems(
      entity,
      resolvedModuleItem,
      resolvedFlagID,
    );
  }
  return getLoadedChargeByFlag(characterID, toInt(entity.itemID, 0), resolvedFlagID);
}

function getEntityRuntimeActiveModuleContexts(entity, options = {}) {
  if (
    !entity ||
    (
      !(entity.activeModuleEffects instanceof Map) &&
      !(entity.overloadModuleEffects instanceof Map)
    )
  ) {
    return [];
  }

  const excludeModuleID = toInt(options.excludeModuleID, 0);
  const includeOverloadModuleID = toInt(options.includeOverloadModuleID, 0);
  const genericOnly = options.genericOnly !== false;
  const contexts = [];

  const appendContextForEffectState = (effectState) => {
    if (!effectState) {
      return;
    }
    if (genericOnly && effectState.isGeneric !== true) {
      return;
    }
    const moduleID = toInt(effectState.moduleID, 0);
    if (
      excludeModuleID > 0 &&
      moduleID === excludeModuleID &&
      !(
        effectState.isOverload === true &&
        includeOverloadModuleID === moduleID
      )
    ) {
      return;
    }

    const moduleItem =
      getEntityRuntimeModuleItem(
        entity,
        effectState.moduleID,
        effectState.moduleFlagID,
      ) ||
      (
        effectState.moduleItemSnapshot &&
        typeof effectState.moduleItemSnapshot === "object"
          ? { ...effectState.moduleItemSnapshot }
          : null
      );
    const effectRecord =
      effectState.effectRecord ||
      getEffectTypeRecord(effectState.effectID);
    if (!moduleItem || !effectRecord) {
      return;
    }

    contexts.push({
      effectState,
      effectRecord,
      moduleItem,
      chargeItem: getEntityRuntimeLoadedCharge(entity, moduleItem),
    });
  };

  if (entity.activeModuleEffects instanceof Map) {
    for (const effectState of entity.activeModuleEffects.values()) {
      appendContextForEffectState(effectState);
    }
  }

  if (entity.overloadModuleEffects instanceof Map) {
    for (const effectState of entity.overloadModuleEffects.values()) {
      appendContextForEffectState(effectState);
    }
  }

  return contexts;
}

function getSkillLevel(skillMap, skillTypeID) {
  const skill = skillMap instanceof Map ? skillMap.get(skillTypeID) : null;
  if (!skill) {
    return 0;
  }

  return Math.max(
    0,
    toInt(
      skill.effectiveSkillLevel ??
        skill.trainedSkillLevel ??
        skill.skillLevel,
      0,
    ),
  );
}

Object.assign(module.exports, {
  SHIP_FITTING_FLAG_RANGES,
});
