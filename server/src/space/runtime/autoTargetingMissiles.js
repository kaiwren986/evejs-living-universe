"use strict";

module.exports = {
  getAutoTargetingMissileRangeMeters,
  hasActiveAutoTargetingMissileAggression,
  isAutoTargetingMissileAggressorEffect,
  isAutoTargetingMissileCharge,
  isAutoTargetingMissileHostileCandidate,
  resolveAutoTargetingMissileNpcPackKey,
  resolveAutoTargetingMissileTarget,
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
  applyDamageToEntity,
  applyResolvedDamageAmountToEntity,
  buildLiveDamageState,
  hasDamageableHealth,
  getEntityCurrentHealthLayers,
  getEntityMaxHealthLayers,
  sumDamageVector,
} = require(path.join(runtimeEntryDirname, "./combat/damage"));
const {
  getEntitySurfaceDistance,
} = require("./entityDistance");
const {
  toFiniteNumber,
  toInt,
} = require("../../common/numbers");
const {
  isOffensiveWeaponFamily,
  isValidWeaponSnapshotTarget,
} = require("./weaponSnapshot");

const ATTRIBUTE_MAX_FOF_TARGET_RANGE =
  getAttributeIDByNames("maxFoFTargetRange") || 1455;

function getAutoTargetingMissileRangeMeters(chargeItem = null) {
  const chargeTypeID = toInt(chargeItem && chargeItem.typeID, 0);
  if (chargeTypeID <= 0) {
    return 0;
  }
  const chargeAttributes = buildEffectiveItemAttributeMap(chargeItem);
  return Math.max(
    0,
    toFiniteNumber(
      chargeAttributes[ATTRIBUTE_MAX_FOF_TARGET_RANGE] ??
        getTypeAttributeValue(chargeTypeID, "maxFoFTargetRange"),
      0,
    ),
  );
}

function isAutoTargetingMissileCharge(chargeItem = null) {
  return getAutoTargetingMissileRangeMeters(chargeItem) > 0;
}

function isAutoTargetingMissileAggressorEffect(effectState = null) {
  if (!effectState || typeof effectState !== "object") {
    return false;
  }
  if (isOffensiveWeaponFamily(effectState.weaponFamily)) {
    return true;
  }
  return Boolean(
    effectState.hostileModuleEffect === true ||
      effectState.jammerModuleEffect === true ||
      effectState.jammerBurstEffect === true ||
      effectState.superweaponEffect === true,
  );
}

function hasActiveAutoTargetingMissileAggression(candidateEntity, sourceEntity) {
  const sourceID = toInt(sourceEntity && sourceEntity.itemID, 0);
  if (
    sourceID <= 0 ||
    !candidateEntity ||
    !(candidateEntity.activeModuleEffects instanceof Map)
  ) {
    return false;
  }

  for (const effectState of candidateEntity.activeModuleEffects.values()) {
    if (
      toInt(effectState && effectState.targetID, 0) === sourceID &&
      isAutoTargetingMissileAggressorEffect(effectState)
    ) {
      return true;
    }
  }

  return false;
}

function resolveAutoTargetingMissileNpcPackKey(entity) {
  if (!entity || entity.nativeNpc !== true) {
    return "";
  }

  // Dungeon encounters are the authored wave/pack authority. The instance is
  // already embedded in live encounter keys, so matching this exact value
  // cannot leak hostility to another room, wave, or site instance.
  const encounterKey = String(entity.dungeonEncounterKey || "").trim();
  if (encounterKey) {
    return `dungeonEncounter:${encounterKey}`;
  }

  // Belt rats synthesize a distinct spawnSiteID for each spawned wave. Other
  // NPC-site paths reuse catalog spawnSiteID values across materializations,
  // so they are not safe pack identity. spawnGroupID is likewise only a
  // reusable catalog/template ID.
  const spawnSiteID = String(entity.spawnSiteID || "").trim();
  return (
    spawnSiteID &&
    String(entity.operatorKind || "").trim() === "asteroidBeltRat"
  )
    ? `beltRatSpawn:${spawnSiteID}`
    : "";
}

function isAutoTargetingMissileHostileCandidate(
  candidateEntity,
  sourceEntity,
  hostilePackKey = "",
) {
  if (hasActiveAutoTargetingMissileAggression(candidateEntity, sourceEntity)) {
    return true;
  }

  const rememberedPackKey = String(hostilePackKey || "").trim();
  return Boolean(
    rememberedPackKey &&
    resolveAutoTargetingMissileNpcPackKey(candidateEntity) === rememberedPackKey,
  );
}

function resolveAutoTargetingMissileTarget(
  scene,
  sourceEntity,
  weaponSnapshot,
  chargeItem,
  hostilePackKey = "",
) {
  if (
    !scene ||
    !sourceEntity ||
    !weaponSnapshot ||
    !isAutoTargetingMissileCharge(chargeItem)
  ) {
    return null;
  }

  const sourceID = toInt(sourceEntity && sourceEntity.itemID, 0);
  const maxFoFRange = getAutoTargetingMissileRangeMeters(chargeItem);
  if (sourceID <= 0 || maxFoFRange <= 0) {
    return null;
  }

  let best = null;
  for (const candidateEntity of scene.dynamicEntities.values()) {
    if (
      !candidateEntity ||
      toInt(candidateEntity.itemID, 0) === sourceID ||
      !hasDamageableHealth(candidateEntity) ||
      !isAutoTargetingMissileHostileCandidate(
        candidateEntity,
        sourceEntity,
        hostilePackKey,
      )
    ) {
      continue;
    }

    if (!isValidWeaponSnapshotTarget(sourceEntity, candidateEntity, weaponSnapshot)) {
      continue;
    }

    const surfaceDistance = getEntitySurfaceDistance(sourceEntity, candidateEntity);
    if (!Number.isFinite(surfaceDistance) || surfaceDistance > maxFoFRange + 1) {
      continue;
    }

    if (!best || surfaceDistance < best.surfaceDistance) {
      best = {
        entity: candidateEntity,
        surfaceDistance,
      };
    }
  }

  return best ? best.entity : null;
}

Object.assign(module.exports, {
  ATTRIBUTE_MAX_FOF_TARGET_RANGE,
});
