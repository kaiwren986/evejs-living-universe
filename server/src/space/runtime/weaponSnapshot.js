"use strict";

module.exports = {
  buildWeaponSnapshotForEntity,
  getConfiguredTurretHitChanceAdditive,
  isDefenderMissileTarget,
  isDefenderMissileTargetForSource,
  isOffensiveWeaponFamily,
  isSnapshotWeaponFamily,
  isValidWeaponSnapshotTarget,
  resolveTurretShotWithConfiguredAdditive,
};

const runtimeEntryDirname = require("path").resolve(__dirname, "..");
const path = require("path");
const starbaseDefenseRuntime = require("../../services/starbase/starbaseDefenseRuntime");
const config = require(path.join(runtimeEntryDirname, "../config"));
const {
  canEntitiesInteractLocally,
  isSharedPveTarget,
  resolveEntityInteractionScope,
} = require(path.join(runtimeEntryDirname, "./destiny/identity/interactionScope.js"));
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
const assistanceModuleRuntime = require(path.join(
  runtimeEntryDirname,
  "./modules/assistanceModuleRuntime",
));
const hostileModuleRuntime = require(path.join(
  runtimeEntryDirname,
  "./modules/hostileModuleRuntime",
));
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
  buildWeaponModuleSnapshot,
  isChargeOptionalTurretWeapon,
  isMissileWeaponFamily,
  isVortonWeaponFamily,
  isTurretCycleWeaponFamily,
  isDefenderMissileWeaponSnapshot,
  resolveWeaponFamily,
  resolveWeaponSpecialFxGUID,
} = require(path.join(runtimeEntryDirname, "./combat/weaponDogma"));
const {
  resolveTurretShot,
  resolveTurretHitQualityTier,
} = require(path.join(runtimeEntryDirname, "./combat/laserTurrets"));
const {
  collectEntityWormholeLocationModifierSources,
} = require("./activeShipModifiers");
const {
  getEntityRuntimeActiveModuleContexts,
  getEntityRuntimeFittedItems,
  getEntityRuntimeShipItem,
  getEntityRuntimeSkillMap,
  getShipEntityInventoryCharacterID,
} = require("./entityDogmaView");
const {
  toInt,
} = require("../../common/numbers");

// Server tuning lean (config: gameplay combat.turretHitChanceAdditive, env
// EVEJS_TURRET_HIT_CHANCE_ADDITIVE). Every runtime turret shot — player, NPC,
// drone, fighter — resolves through this wrapper so the configured additive
// reaches them all in one place. The resolver itself defaults the additive to
// 0, which keeps the pinned TQ formula intact for direct callers like the
// parity tests and the tools/TurretHitChanceSim harnesses.
function getConfiguredTurretHitChanceAdditive() {
  const configured = Number(config.turretHitChanceAdditive);
  if (!Number.isFinite(configured)) {
    return 0;
  }
  return Math.min(Math.max(configured, 0), 1);
}

function resolveTurretShotWithConfiguredAdditive(options = {}) {
  return resolveTurretShot({
    hitChanceAdditive: getConfiguredTurretHitChanceAdditive(),
    ...options,
  });
}

function buildWeaponSnapshotForEntity(entity, moduleItem, chargeItem = null, options = {}) {
  const shipItem = options.shipItem || getEntityRuntimeShipItem(entity);
  if (!shipItem || !moduleItem) {
    return null;
  }
  const hostileWeaponModifiers =
    options.directModuleModifierEntries || options.directChargeModifierEntries
      ? {
        moduleEntries: Array.isArray(options.directModuleModifierEntries)
          ? options.directModuleModifierEntries
          : [],
        chargeEntries: Array.isArray(options.directChargeModifierEntries)
          ? options.directChargeModifierEntries
          : [],
      }
      : hostileModuleRuntime.collectWeaponModifierEntriesForTarget(entity, moduleItem);
  const assistanceWeaponModifiers =
    options.directModuleModifierEntries || options.directChargeModifierEntries
      ? {
        moduleEntries: [],
        chargeEntries: [],
      }
      // The weapon is passed so the skill-keyed rows a Remote Tracking Computer
      // and a Tracking Disruptor declare (Gunnery, per the client's own
      // SKILL_MODIFIER_CHANGES_FOR_LOCATION) only reach Gunnery weapons.
      : assistanceModuleRuntime.collectWeaponModifierEntriesForTarget(entity, moduleItem);

  const snapshotOptions = {
    characterID: getShipEntityInventoryCharacterID(entity, 0),
    shipItem,
    moduleItem,
    chargeItem,
    fittedItems: options.fittedItems || getEntityRuntimeFittedItems(entity),
    skillMap: options.skillMap || getEntityRuntimeSkillMap(entity),
    activeModuleContexts:
      options.activeModuleContexts ||
      getEntityRuntimeActiveModuleContexts(entity, {
        excludeModuleID: toInt(moduleItem && moduleItem.itemID, 0),
        includeOverloadModuleID: toInt(moduleItem && moduleItem.itemID, 0),
      }),
    additionalLocationModifierSources:
      isStructureDogmaHost(shipItem) || starbaseDefenseRuntime.isStarbaseBattery(entity)
        ? []
        : (
            options.additionalLocationModifierSources ||
            collectEntityWormholeLocationModifierSources(entity)
          ),
    ...(Array.isArray(options.hiddenModifierItems)
      ? { hiddenModifierItems: options.hiddenModifierItems }
      : {}),
    directModuleModifierEntries: [
      ...hostileWeaponModifiers.moduleEntries,
      ...assistanceWeaponModifiers.moduleEntries,
    ],
    directChargeModifierEntries: [
      ...hostileWeaponModifiers.chargeEntries,
      ...assistanceWeaponModifiers.chargeEntries,
    ],
  };
  if (
    isNativeNpcEntity(entity) &&
    moduleItem.npcCapitalHullDamageAuthority === true
  ) {
    return buildNpcWeaponModuleSnapshot(entity, moduleItem, {
      ...snapshotOptions,
      chargeItem,
    });
  }
  return buildWeaponModuleSnapshot(snapshotOptions);
}

function isSnapshotWeaponFamily(family) {
  return isTurretCycleWeaponFamily(family) || isMissileWeaponFamily(family);
}

function isDefenderMissileTargetForSource(sourceShipID, targetEntity) {
  return Boolean(
    targetEntity &&
    targetEntity.kind === "missile" &&
    toInt(targetEntity.itemID, 0) > 0 &&
    (
      toInt(sourceShipID, 0) <= 0 ||
      toInt(targetEntity.sourceShipID, 0) !== toInt(sourceShipID, 0)
    ),
  );
}

function isDefenderMissileTarget(attackerEntity, targetEntity) {
  return isDefenderMissileTargetForSource(
    toInt(attackerEntity && attackerEntity.itemID, 0),
    targetEntity,
  );
}

function isValidWeaponSnapshotTarget(attackerEntity, targetEntity, weaponSnapshot) {
  if (!targetEntity || !weaponSnapshot) {
    return false;
  }
  // A moribund Ball is gone to gameplay: only a hit missile outlives
  // its mark, for its removal delay, so each client can draw its explosion.
  // Evolve already treats it as no target, and the movement engine refuses a
  // Follow or Orbit at it.
  if (targetEntity.isMoribund === true) {
    return false;
  }
  if (!canEntitiesInteractLocally(attackerEntity, targetEntity)) {
    return false;
  }
  if (weaponSnapshot.family === "breacherPodLauncher") {
    const breacher = require("../combat/breacherPods");
    return breacher.validSnapshot(weaponSnapshot) &&
      breacher.isBreacherPodTarget(targetEntity, weaponSnapshot.targetTypeListID) && hasDamageableHealth(targetEntity);
  }
  if (isDefenderMissileWeaponSnapshot(weaponSnapshot)) {
    return isDefenderMissileTarget(attackerEntity, targetEntity);
  }
  return hasDamageableHealth(targetEntity);
}

function isOffensiveWeaponFamily(family) {
  return family !== "festivalLauncher" && isSnapshotWeaponFamily(family);
}
