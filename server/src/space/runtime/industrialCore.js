"use strict";

module.exports = {
  areCompressionFacilityTypelistsEqual,
  getIndustrialCoreDependentModuleIDs,
  hasActiveIndustrialCoreEffect,
  isIndustrialCompressionEffectName,
  isIndustrialCoreEffectName,
  moduleActivationRequiresActiveIndustrialCore,
  normalizeModuleEffectName,
  refreshShipCompressionFacilityState,
  resolveCompressionFacilityRangeMeters,
  resolveCompressionFacilityTypeListID,
  resolveCompressionFacilityTypelistsForEntity,
};

const runtimeEntryDirname = require("path").resolve(__dirname, "..");
const path = require("path");
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
  getEntityRuntimeFittedItems,
  getEntityRuntimeShipItem,
  getEntityRuntimeSkillMap,
  getShipEntityInventoryCharacterID,
} = require("./entityDogmaView");
const {
  resolveGenericModuleAttributeOverrides,
} = require("./moduleAttributes");
const {
  toFiniteNumber,
  toInt,
} = require("../../common/numbers");
const {
  getTypeDogmaAttributeValueByID,
} = require("./typeAttributeLookup");
const moduleAttributesModule = require("./moduleAttributes");

const MODULE_ATTRIBUTE_COMPRESSIBLE_ITEMS_TYPELIST = 3255;

const MODULE_ATTRIBUTE_ACTIVATION_REQUIRES_ACTIVE_INDUSTRIAL_CORE = 3265;

const MAX_IN_SPACE_COMPRESSION_RANGE_METERS = 250_000;

function normalizeModuleEffectName(effectName) {
  return String(effectName || "").trim().toLowerCase();
}

function isIndustrialCoreEffectName(effectName) {
  const normalizedEffectName = normalizeModuleEffectName(effectName);
  return normalizedEffectName.includes("industrial") &&
    normalizedEffectName.includes("core");
}

function isIndustrialCompressionEffectName(effectName) {
  return normalizeModuleEffectName(effectName) === "industrialitemcompression";
}

function resolveCompressionFacilityTypeListID(moduleTypeID) {
  return toInt(
    getTypeAttributeValue(moduleTypeID, "compressibleItemsTypeList") ??
      getTypeDogmaAttributeValueByID(
        moduleTypeID,
        MODULE_ATTRIBUTE_COMPRESSIBLE_ITEMS_TYPELIST,
        0,
      ),
    0,
  );
}

function moduleActivationRequiresActiveIndustrialCore(moduleTypeID) {
  return toInt(
    getTypeAttributeValue(moduleTypeID, "activationRequiresActiveIndustrialCore") ??
      getTypeDogmaAttributeValueByID(
        moduleTypeID,
        MODULE_ATTRIBUTE_ACTIVATION_REQUIRES_ACTIVE_INDUSTRIAL_CORE,
        0,
      ),
    0,
  ) > 0;
}

function hasActiveIndustrialCoreEffect(entity) {
  if (!entity || !(entity.activeModuleEffects instanceof Map)) {
    return false;
  }

  for (const effectState of entity.activeModuleEffects.values()) {
    if (
      effectState &&
      toFiniteNumber(effectState.deactivatedAtMs, 0) <= 0 &&
      isIndustrialCoreEffectName(effectState.effectName)
    ) {
      return true;
    }
  }

  return false;
}

// A compressor's fleet reach is the module's own `maxRange`: 44 km medium
// (Porpoise), 83 km large (Orca), 144 km capital (Rorqual). Fleet Compression
// Logistics does NOT need to be applied by hand here — the SDE declares it as
// ordinary dogma (effect 8372 on the skill: a PostPercent of
// `fleetCompressionLogisticsRangeBonus` onto the `maxRange` of every module on
// the ship requiring skill 62450/62451), so the live module attribute map
// already carries the +10%/level. `MAX_IN_SPACE_COMPRESSION_RANGE_METERS` is
// the client's own ceiling (itemcompression.MAX_FACILITY_ACTIVATION_RANGE).
function resolveCompressionFacilityRangeMeters(entity, moduleItem = null, moduleTypeID = 0) {
  const ATTRIBUTE_MAX_RANGE = moduleAttributesModule.ATTRIBUTE_MAX_RANGE;
  if (!entity || entity.kind !== "ship") {
    return 0;
  }

  const shipItem = getEntityRuntimeShipItem(entity);
  const resolvedModuleItem = moduleItem || null;
  const liveAttributes = shipItem && resolvedModuleItem
    ? resolveGenericModuleAttributeOverrides(
      getShipEntityInventoryCharacterID(entity, 0),
      shipItem,
      resolvedModuleItem,
      null,
      {
        skillMap: getEntityRuntimeSkillMap(entity),
        fittedItems: getEntityRuntimeFittedItems(entity),
      },
    )
    : null;
  // Falling back to the declared type attribute keeps a live facility
  // advertised at its cold reach if the fitted item cannot be resolved,
  // rather than silently withdrawing it from the fleet.
  const fallbackTypeID = toInt(
    (resolvedModuleItem && resolvedModuleItem.typeID) || moduleTypeID,
    0,
  );
  const baseRangeMeters = toFiniteNumber(
    liveAttributes && liveAttributes[ATTRIBUTE_MAX_RANGE],
    fallbackTypeID > 0
      ? toFiniteNumber(getTypeAttributeValue(fallbackTypeID, "maxRange"), 0)
      : 0,
  );
  if (!(baseRangeMeters > 0)) {
    return 0;
  }

  return Math.max(
    1,
    Math.min(
      MAX_IN_SPACE_COMPRESSION_RANGE_METERS,
      Math.round(baseRangeMeters),
    ),
  );
}

function resolveCompressionFacilityTypelistsForEntity(entity) {
  if (
    !entity ||
    entity.kind !== "ship" ||
    !(entity.activeModuleEffects instanceof Map) ||
    !hasActiveIndustrialCoreEffect(entity)
  ) {
    return null;
  }

  let fittedItemsByID = null;
  const typelistEntries = new Map();
  for (const effectState of entity.activeModuleEffects.values()) {
    if (
      !effectState ||
      toFiniteNumber(effectState.deactivatedAtMs, 0) > 0 ||
      !isIndustrialCompressionEffectName(effectState.effectName)
    ) {
      continue;
    }

    const typeListID = resolveCompressionFacilityTypeListID(effectState.typeID);
    if (typeListID <= 0) {
      continue;
    }

    if (!fittedItemsByID) {
      fittedItemsByID = new Map(
        getEntityRuntimeFittedItems(entity)
          .filter((item) => item && toInt(item.itemID, 0) > 0)
          .map((item) => [toInt(item.itemID, 0), item]),
      );
    }
    const activationRangeMeters = resolveCompressionFacilityRangeMeters(
      entity,
      fittedItemsByID.get(toInt(effectState.moduleID, 0)) || null,
      toInt(effectState.typeID, 0),
    );
    if (activationRangeMeters <= 0) {
      continue;
    }

    const previousRangeMeters = Math.max(
      0,
      toFiniteNumber(typelistEntries.get(typeListID), 0),
    );
    typelistEntries.set(
      typeListID,
      Math.max(previousRangeMeters, activationRangeMeters),
    );
  }

  return typelistEntries.size > 0
    ? [...typelistEntries.entries()].sort((left, right) => left[0] - right[0])
    : null;
}

function areCompressionFacilityTypelistsEqual(left, right) {
  const normalizedLeft = Array.isArray(left) ? left : [];
  const normalizedRight = Array.isArray(right) ? right : [];
  if (normalizedLeft.length !== normalizedRight.length) {
    return false;
  }

  for (let index = 0; index < normalizedLeft.length; index += 1) {
    const leftEntry = Array.isArray(normalizedLeft[index]) ? normalizedLeft[index] : [];
    const rightEntry = Array.isArray(normalizedRight[index]) ? normalizedRight[index] : [];
    if (
      toInt(leftEntry[0], 0) !== toInt(rightEntry[0], 0) ||
      toInt(leftEntry[1], 0) !== toInt(rightEntry[1], 0)
    ) {
      return false;
    }
  }

  return true;
}

function refreshShipCompressionFacilityState(entity) {
  if (!entity || entity.kind !== "ship") {
    return false;
  }

  const previousTypelists = Array.isArray(entity.compressionFacilityTypelists)
    ? entity.compressionFacilityTypelists.map((entry) => [
        toInt(entry && entry[0], 0),
        Math.max(1, toInt(entry && entry[1], 0)),
      ])
    : null;
  const nextTypelists = resolveCompressionFacilityTypelistsForEntity(entity);
  if (areCompressionFacilityTypelistsEqual(previousTypelists, nextTypelists)) {
    return false;
  }

  entity.compressionFacilityTypelists = nextTypelists;
  return true;
}

function getIndustrialCoreDependentModuleIDs(entity, excludedModuleID = 0) {
  if (!entity || !(entity.activeModuleEffects instanceof Map)) {
    return [];
  }

  const normalizedExcludedModuleID = toInt(excludedModuleID, 0);
  return [...entity.activeModuleEffects.values()]
    .map((effectState) => ({
      effectState,
      moduleID: toInt(effectState && effectState.moduleID, 0),
    }))
    .filter(({ effectState, moduleID }) => (
      moduleID > 0 &&
      moduleID !== normalizedExcludedModuleID &&
      toFiniteNumber(effectState && effectState.deactivatedAtMs, 0) <= 0 &&
      moduleActivationRequiresActiveIndustrialCore(
        toInt(effectState && effectState.typeID, 0),
      )
    ))
    .map(({ moduleID }) => moduleID);
}

Object.assign(module.exports, {
  MAX_IN_SPACE_COMPRESSION_RANGE_METERS,
  MODULE_ATTRIBUTE_ACTIVATION_REQUIRES_ACTIVE_INDUSTRIAL_CORE,
  MODULE_ATTRIBUTE_COMPRESSIBLE_ITEMS_TYPELIST,
});
