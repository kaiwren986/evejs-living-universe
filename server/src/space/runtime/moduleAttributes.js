"use strict";

module.exports = {
  getBaseGenericModuleRuntimeAttributes,
  getGenericModuleRuntimeAttributes,
  normalizeLiveModuleAttributeOverrides,
  resolveEffectiveModuleReloadTimeMs,
  resolveGenericModuleAttributeOverrides,
  resolveShipModifiedModuleAttributeMap,
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
  buildLiveModuleAttributeMap,
} = require(path.join(runtimeEntryDirname, "./modules/liveModuleAttributes"));
const {
  getActiveImplantLocationModifierSources,
  getActiveImplantShipModifierEntries,
} = require(path.join(
  runtimeEntryDirname,
  "../services/dogma/implants/activeImplantModifiers",
));
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
  resolveDefaultActivationEffect,
} = require("./moduleActivationEffectRecord");
const {
  roundNumber,
  toFiniteNumber,
  toInt,
} = require("../../common/numbers");
const {
  roundModuleFuelQuantity,
} = require("./shipModuleFuel");
const {
  isSnapshotWeaponFamily,
} = require("./weaponSnapshot");

const MODULE_ATTRIBUTE_CAPACITOR_NEED = 6;

const MODULE_ATTRIBUTE_SPEED_FACTOR = 20;

const MODULE_ATTRIBUTE_SPEED = 51;

const MODULE_ATTRIBUTE_DURATION = 73;

const MODULE_ATTRIBUTE_RELOAD_TIME = getAttributeIDByNames("reloadTime") || 1795;

const GROUP_SCAN_PROBE_LAUNCHER = 481;

const ATTRIBUTE_MAX_RANGE = getAttributeIDByNames("maxRange") || 54;

const MODULE_ATTRIBUTE_CAPACITOR_CAPACITY_MULTIPLIER = 147;

const MODULE_ATTRIBUTE_SIGNATURE_RADIUS_BONUS = 554;

const MODULE_ATTRIBUTE_SPEED_BOOST_FACTOR = 567;

const MODULE_ATTRIBUTE_MAX_GROUP_ACTIVE = 763;

const MODULE_ATTRIBUTE_MASS_ADDITION = 796;

const MODULE_ATTRIBUTE_MAX_VELOCITY_ACTIVATION_LIMIT =
  getAttributeIDByNames("maxVelocityActivationLimit") || 1334;

const MODULE_ATTRIBUTE_MAX_VELOCITY_LIMITED =
  getAttributeIDByNames("maxVelocityLimited") || 1333;

const MODULE_ATTRIBUTE_REACTIVATION_DELAY = 669;

const MODULE_ATTRIBUTE_CONSUMPTION_TYPE = 713;

const MODULE_ATTRIBUTE_CONSUMPTION_QUANTITY = 714;

// A reload is a ship-level number, not a module-level one. Six effects in the
// SDE write `reloadTime` (1795) and every one of them is a `shipID`-domain row
// on the hull or on a skill, so none of them can be seen from the module's own
// attribute map:
//
//   6098  shipMissileReloadTimeCaldariTacticalDestroyer2  Jackdaw, Skua   -15%/level
//   8360  shipBonusMissileReloadTimeGC2                   Laelaps         -10%/level
//   6620  shipBonusDreadnoughtC3ReloadBonus               Phoenix, Navy   -10%/level
//         (all three are LocationRequiredSkillModifier on skill 3319, so they
//          reach all 143 published missile launchers that declare a reload)
//   12887 angelCartelProjectileReloadingSpeed             9 hulls         -75% flat
//         (LocationGroupModifier on group 55: 167 projectile turrets)
//   6782  commandBurstReloadTimeBonus                     skill 3354      -10%/level
//   8590  launcherReloadTimeBonusPassive                  4 unpublished boosters
//
// Reading the module's own map meant a Jackdaw's -75% missile reload bonus did
// nothing at all: the ship-modified map said 8,750 ms and the timer still ran
// 35,000. `resolveGenericModuleAttributeOverrides` is the same composition the
// module's own panel is built from, so the two now agree by construction. With
// no entity - the docked/mutated-item callers - this falls back to exactly the
// old map, so nothing off a live hull changes.
function resolveEffectiveModuleReloadTimeMs(moduleItem, entity = null) {
  const effectiveAttributes = moduleItem
    ? resolveShipModifiedModuleAttributeMap(entity, moduleItem) ||
      buildEffectiveItemAttributeMap(moduleItem)
    : null;
  const reloadTime = Number(
    effectiveAttributes && effectiveAttributes[MODULE_ATTRIBUTE_RELOAD_TIME] !== undefined
      ? effectiveAttributes[MODULE_ATTRIBUTE_RELOAD_TIME]
      : getTypeAttributeValue(
          toInt(moduleItem && moduleItem.typeID, 0),
          "reloadTime",
        ),
  );
  if (!Number.isFinite(reloadTime) || reloadTime <= 0) {
    return 0;
  }
  return Math.max(0, Math.round(reloadTime));
}

// The module's attributes with its host's dogma applied - hull bonuses, skills,
// rigs and subsystems, implants, and anything the system it is sitting in adds.
// Returns null when there is no live host to build against, which is the signal
// to fall back to the module's own map.
function resolveShipModifiedModuleAttributeMap(entity, moduleItem) {
  if (!entity || !moduleItem) {
    return null;
  }
  const shipItem = getEntityRuntimeShipItem(entity);
  if (!shipItem) {
    return null;
  }
  return resolveGenericModuleAttributeOverrides(
    getShipEntityInventoryCharacterID(entity, 0),
    shipItem,
    moduleItem,
    null,
    {
      fittedItems: getEntityRuntimeFittedItems(entity),
      skillMap: getEntityRuntimeSkillMap(entity),
      activeModuleContexts: getEntityRuntimeActiveModuleContexts(entity),
      additionalLocationModifierSources:
        collectEntityWormholeLocationModifierSources(entity),
    },
  );
}

function getBaseGenericModuleRuntimeAttributes(moduleItem) {
  if (!moduleItem || !moduleItem.typeID) {
    return null;
  }
  const activationEffect = resolveDefaultActivationEffect(moduleItem.typeID);
  if (!activationEffect) {
    return null;
  }
  const moduleAttributes = buildEffectiveItemAttributeMap(moduleItem);

  const capNeed = toFiniteNumber(
    moduleAttributes[MODULE_ATTRIBUTE_CAPACITOR_NEED],
    0,
  );
  const rawDuration = moduleAttributes[MODULE_ATTRIBUTE_DURATION];
  const rawSpeed = moduleAttributes[MODULE_ATTRIBUTE_SPEED];
  const isScanProbeLauncher =
    toInt(moduleItem && moduleItem.groupID, 0) === GROUP_SCAN_PROBE_LAUNCHER;
  // Scan probe launchers are a special case on the live client contract:
  // their effect record advertises useMissiles on speed (51), but the HUD
  // cycle that keeps the launcher button stable follows the probe scan-time
  // duration lane instead. Earlier server logs that matched the client best
  // used the duration attribute here (for example 5625ms on the probe hull),
  // while the newer speed-based 1500ms contract is what left the launcher
  // cycling oddly and sticking red.
  const effectDurationAttributeID = toInt(
    activationEffect.durationAttributeID,
    0,
  );
  const durationAttributeID =
    isScanProbeLauncher && toFiniteNumber(rawDuration, 0) > 0
      ? MODULE_ATTRIBUTE_DURATION
      : effectDurationAttributeID > 0
      ? effectDurationAttributeID
      : toFiniteNumber(rawDuration, 0) > 0
        ? MODULE_ATTRIBUTE_DURATION
        : MODULE_ATTRIBUTE_SPEED;
  const durationAttributeValue = toFiniteNumber(
    moduleAttributes[durationAttributeID],
    durationAttributeID === MODULE_ATTRIBUTE_SPEED
      ? toFiniteNumber(rawSpeed, 10000)
      : toFiniteNumber(rawDuration, 10000),
  );
  const durationMs = Math.max(
    1,
    durationAttributeValue,
  );
  const speedMs = Math.max(
    1,
    isScanProbeLauncher
      ? durationMs
      : toFiniteNumber(rawSpeed, 10000),
  );
  const reactivationDelayMs = Math.max(
    0,
    toFiniteNumber(
      moduleAttributes[MODULE_ATTRIBUTE_REACTIVATION_DELAY],
      0,
    ),
  );
  const maxGroupActive = toInt(
    moduleAttributes[MODULE_ATTRIBUTE_MAX_GROUP_ACTIVE],
    0,
  );
  const fuelTypeID = toInt(
    moduleAttributes[MODULE_ATTRIBUTE_CONSUMPTION_TYPE],
    0,
  );
  const fuelPerActivation = roundModuleFuelQuantity(
    moduleAttributes[MODULE_ATTRIBUTE_CONSUMPTION_QUANTITY],
  );

  return {
    capNeed: Math.max(0, roundNumber(capNeed, 6)),
    durationMs: Math.max(1, roundNumber(durationMs, 3)),
    durationAttributeID,
    reactivationDelayMs,
    maxGroupActive,
    fuelTypeID,
    fuelPerActivation,
    speedMs,
  };
}

function normalizeLiveModuleAttributeOverrides(attributeMap) {
  if (!attributeMap || typeof attributeMap !== "object") {
    return null;
  }

  const overrides = {};
  for (const [attributeID, rawValue] of Object.entries(attributeMap)) {
    const numericAttributeID = toInt(attributeID, 0);
    const numericValue = Number(rawValue);
    if (
      numericAttributeID <= 0 ||
      !Number.isFinite(numericValue)
    ) {
      continue;
    }
    overrides[numericAttributeID] = numericValue;
  }

  return Object.keys(overrides).length > 0 ? overrides : null;
}

function resolveGenericModuleAttributeOverrides(
  characterID,
  shipItem,
  moduleItem,
  chargeItem = null,
  options = {},
) {
  if (!shipItem || !moduleItem) {
    return null;
  }

  const numericCharacterID = toInt(characterID, 0);
  const numericShipID = toInt(shipItem && shipItem.itemID, 0);
  const isStructureHost = isStructureDogmaHost(shipItem);
  const resolvedSkillMap = resolveDogmaSkillMapForHost(
    numericCharacterID,
    shipItem,
    options,
  );
  const resolvedFittedItems = Array.isArray(options.fittedItems)
    ? options.fittedItems
    : isStructureHost
      ? listFittedItemsForLocation(numericShipID)
      : getFittedModuleItems(numericCharacterID, numericShipID);
  const resolvedActiveModuleContexts = Array.isArray(options.activeModuleContexts)
    ? options.activeModuleContexts
    : [];
  const additionalLocationModifierSources = Array.isArray(
    options.additionalLocationModifierSources,
  )
    ? (isStructureHost ? [] : options.additionalLocationModifierSources)
    : [];
  const implantLocationModifierSources =
    !isStructureHost && numericCharacterID > 0
      ? getActiveImplantLocationModifierSources(characterID)
      : [];
  const additionalShipModifierEntries =
    !isStructureHost && numericCharacterID > 0
      ? getActiveImplantShipModifierEntries(characterID)
      : [];

  return normalizeLiveModuleAttributeOverrides(buildLiveModuleAttributeMap(
    shipItem,
    moduleItem,
    chargeItem,
    resolvedSkillMap,
    resolvedFittedItems,
    resolvedActiveModuleContexts,
    {
      additionalLocationModifierSources: [
        ...implantLocationModifierSources,
        ...additionalLocationModifierSources,
      ],
      additionalShipModifierEntries,
      additionalDirectModifierEntries: Array.isArray(
        options.additionalDirectModifierEntries,
      )
        ? options.additionalDirectModifierEntries
        : [],
      ...(Array.isArray(options.hiddenModifierItems)
        ? { hiddenModifierItems: options.hiddenModifierItems }
        : {}),
    },
  ));
}

function getGenericModuleRuntimeAttributes(
  characterID,
  shipItem,
  moduleItem,
  chargeItem = null,
  weaponSnapshot = null,
  options = {},
) {
  const baseRuntimeAttributes = getBaseGenericModuleRuntimeAttributes(moduleItem);
  if (!baseRuntimeAttributes) {
    return null;
  }

  const syntheticHullSuperweapon = Boolean(
    moduleItem &&
    moduleItem.npcSyntheticHullModule === true &&
    moduleItem.npcSyntheticHullSuperweapon === true,
  );

  const attributeOverrides = resolveGenericModuleAttributeOverrides(
    characterID,
    shipItem,
    moduleItem,
    chargeItem,
    options,
  );

  const weaponFamily = resolveWeaponFamily(moduleItem, chargeItem);
  if (!isSnapshotWeaponFamily(weaponFamily)) {
    const durationAttributeID = toInt(
      baseRuntimeAttributes.durationAttributeID,
      MODULE_ATTRIBUTE_DURATION,
    );
    const isScanProbeLauncher =
      toInt(moduleItem && moduleItem.groupID, 0) === GROUP_SCAN_PROBE_LAUNCHER;
    const resolvedDurationMs = roundNumber(
      toFiniteNumber(
        attributeOverrides && attributeOverrides[durationAttributeID],
        baseRuntimeAttributes.durationMs,
      ),
      3,
    );
    const resolvedSpeedMs = roundNumber(
      isScanProbeLauncher
        ? resolvedDurationMs
        : toFiniteNumber(
          attributeOverrides && attributeOverrides[MODULE_ATTRIBUTE_SPEED],
          baseRuntimeAttributes.speedMs,
        ),
      3,
    );
    const mergedAttributeOverrides =
      attributeOverrides && typeof attributeOverrides === "object"
        ? {
          ...attributeOverrides,
          ...(isScanProbeLauncher
            ? {
              [MODULE_ATTRIBUTE_SPEED]: resolvedSpeedMs,
            }
            : {}),
        }
        : (
          isScanProbeLauncher
            ? {
              [MODULE_ATTRIBUTE_SPEED]: resolvedSpeedMs,
            }
            : null
        );
    return {
      ...baseRuntimeAttributes,
      capNeed: syntheticHullSuperweapon
        ? 0
        : roundNumber(
          toFiniteNumber(
            attributeOverrides && attributeOverrides[MODULE_ATTRIBUTE_CAPACITOR_NEED],
            baseRuntimeAttributes.capNeed,
          ),
          6,
        ),
      durationMs: roundNumber(
        resolvedDurationMs,
      ),
      reactivationDelayMs: Math.max(
        0,
        roundNumber(
          toFiniteNumber(
            attributeOverrides && attributeOverrides[MODULE_ATTRIBUTE_REACTIVATION_DELAY],
            baseRuntimeAttributes.reactivationDelayMs,
          ),
          3,
        ),
      ),
      maxGroupActive: Math.max(
        0,
        toInt(
          attributeOverrides && attributeOverrides[MODULE_ATTRIBUTE_MAX_GROUP_ACTIVE],
          baseRuntimeAttributes.maxGroupActive,
        ),
      ),
      fuelTypeID: syntheticHullSuperweapon
        ? 0
        : Math.max(
          0,
          toInt(
            attributeOverrides && attributeOverrides[MODULE_ATTRIBUTE_CONSUMPTION_TYPE],
            baseRuntimeAttributes.fuelTypeID,
          ),
        ),
      fuelPerActivation: syntheticHullSuperweapon
        ? 0
        : roundModuleFuelQuantity(
          attributeOverrides && attributeOverrides[MODULE_ATTRIBUTE_CONSUMPTION_QUANTITY],
          baseRuntimeAttributes.fuelPerActivation,
        ),
      weaponFamily: weaponFamily || null,
      weaponSnapshot: null,
      attributeOverrides: mergedAttributeOverrides,
    };
  }

  const resolvedWeaponSnapshot =
    weaponSnapshot ||
    (
      shipItem &&
      (
        chargeItem ||
        isChargeOptionalTurretWeapon(moduleItem, chargeItem)
      )
        ? buildWeaponModuleSnapshot({
          characterID,
          shipItem,
          moduleItem,
          chargeItem,
          ...(Array.isArray(options.fittedItems) ? { fittedItems: options.fittedItems } : {}),
          ...(options.skillMap instanceof Map ? { skillMap: options.skillMap } : {}),
          ...(Array.isArray(options.activeModuleContexts)
            ? { activeModuleContexts: options.activeModuleContexts }
            : {}),
          ...(Array.isArray(options.additionalLocationModifierSources)
            ? { additionalLocationModifierSources: options.additionalLocationModifierSources }
            : {}),
          ...(Array.isArray(options.hiddenModifierItems)
            ? { hiddenModifierItems: options.hiddenModifierItems }
            : {}),
        })
        : null
    );
  if (!resolvedWeaponSnapshot) {
    return {
      ...baseRuntimeAttributes,
      durationAttributeID: MODULE_ATTRIBUTE_SPEED,
      weaponFamily,
      weaponSnapshot: null,
      attributeOverrides,
    };
  }

  return {
    ...baseRuntimeAttributes,
    capNeed: resolvedWeaponSnapshot.capNeed,
    durationMs: resolvedWeaponSnapshot.durationMs,
    durationAttributeID: MODULE_ATTRIBUTE_SPEED,
    fuelTypeID: Math.max(
      0,
      toInt(
        attributeOverrides && attributeOverrides[MODULE_ATTRIBUTE_CONSUMPTION_TYPE],
        baseRuntimeAttributes.fuelTypeID,
      ),
    ),
    fuelPerActivation: roundModuleFuelQuantity(
      attributeOverrides && attributeOverrides[MODULE_ATTRIBUTE_CONSUMPTION_QUANTITY],
      baseRuntimeAttributes.fuelPerActivation,
    ),
    weaponFamily,
    weaponSnapshot: resolvedWeaponSnapshot,
    attributeOverrides,
  };
}

Object.assign(module.exports, {
  ATTRIBUTE_MAX_RANGE,
  GROUP_SCAN_PROBE_LAUNCHER,
  MODULE_ATTRIBUTE_CAPACITOR_CAPACITY_MULTIPLIER,
  MODULE_ATTRIBUTE_CAPACITOR_NEED,
  MODULE_ATTRIBUTE_CONSUMPTION_QUANTITY,
  MODULE_ATTRIBUTE_CONSUMPTION_TYPE,
  MODULE_ATTRIBUTE_DURATION,
  MODULE_ATTRIBUTE_MASS_ADDITION,
  MODULE_ATTRIBUTE_MAX_GROUP_ACTIVE,
  MODULE_ATTRIBUTE_MAX_VELOCITY_ACTIVATION_LIMIT,
  MODULE_ATTRIBUTE_MAX_VELOCITY_LIMITED,
  MODULE_ATTRIBUTE_REACTIVATION_DELAY,
  MODULE_ATTRIBUTE_RELOAD_TIME,
  MODULE_ATTRIBUTE_SIGNATURE_RADIUS_BONUS,
  MODULE_ATTRIBUTE_SPEED,
  MODULE_ATTRIBUTE_SPEED_BOOST_FACTOR,
  MODULE_ATTRIBUTE_SPEED_FACTOR,
});
