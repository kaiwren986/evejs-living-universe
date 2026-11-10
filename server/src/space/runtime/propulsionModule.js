"use strict";

module.exports = {
  applyActivePropulsionEffectStatesToEntity,
  applyPropulsionEffectStateToEntity,
  getPropulsionEffectID,
  getPropulsionModuleRuntimeAttributes,
  hasActivePropulsionEffect,
  isPropulsionModuleEffectState,
  refreshActivePropulsionEffectRuntimeAttributes,
  resolvePropulsionHostShipItem,
};

const runtimeEntryDirname = require("path").resolve(__dirname, "..");
const path = require("path");
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
  buildPropulsionSignatureModifier,
  resolveShipSignatureRadius,
} = require(path.join(runtimeEntryDirname, "../services/fitting/liveFittingState"));
const {
  getCachedCharacterSkillMap,
} = require(path.join(runtimeEntryDirname, "../services/skills/skillState"));
const {
  applyPassiveMotionBaseCommand,
  applyPassiveMotionTimingCommand,
  applyPropulsionMotionBaseCommand,
  applyPropulsionMotionTimingCommand,
  restoreCommandedSpeedFractionCommand,
} = require(path.join(runtimeEntryDirname, "./destiny/commands/shipDerivedMotion.js"));
const {
  buildNpcEffectiveModuleItem,
} = require(path.join(runtimeEntryDirname, "./npc/npcCapabilityResolver"));
const commandBurstRuntime = require(path.join(
  runtimeEntryDirname,
  "./modules/commandBurstRuntime",
));
const {
  collectNumericModuleAttributeDiffs,
  resolveModuleSnapshotDirectModifierEntries,
} = require(path.join(
  runtimeEntryDirname,
  "./modules/moduleAttributeDiff",
));
const {
  resolveActiveShipRecord,
} = require("./characterStateBridge");
const {
  getEntityRuntimeActiveModuleContexts,
  getEntityRuntimeFittedItems,
  getEntityRuntimeModuleItem,
  getEntityRuntimeShipItem,
  getEntityRuntimeSkillMap,
  getShipEntityInventoryCharacterID,
} = require("./entityDogmaView");
const {
  resolveGenericModuleAttributeOverrides,
} = require("./moduleAttributes");
const {
  roundNumber,
  toFiniteNumber,
  toInt,
} = require("../../common/numbers");
const {
  calculateAlignTimeSecondsFromMassInertia,
  clampMaxVelocityToShipSpeedLimit,
} = require("./passiveDerivedState");
const {
  deriveAgilitySeconds,
} = require("./shipMotionKinematics");
const moduleAttributesModule = require("./moduleAttributes");

const PROPULSION_EFFECT_AFTERBURNER = "moduleBonusAfterburner";

const PROPULSION_EFFECT_MICROWARPDRIVE = "moduleBonusMicrowarpdrive";

const PROPULSION_GUID_BY_EFFECT = Object.freeze({
  [PROPULSION_EFFECT_AFTERBURNER]: "effects.Afterburner",
  [PROPULSION_EFFECT_MICROWARPDRIVE]: "effects.MicroWarpDrive",
});

const EFFECT_ID_AFTERBURNER = getEffectIDByNames(PROPULSION_EFFECT_AFTERBURNER) || 6731;

const EFFECT_ID_MICROWARPDRIVE = getEffectIDByNames(PROPULSION_EFFECT_MICROWARPDRIVE) || 6730;

// The ship a propulsion module is fitted to. Every hull bonus, rig, subsystem
// and skill that reaches the module is read off it. When the host record cannot
// be found — a module addressed by itself, outside a live scene — fall back to a
// hull-less stand-in rather than to nothing, so the skills, implants and
// boosters that are keyed on the character still reach the module.
function resolvePropulsionHostShipItem(characterID, moduleItem) {
  const numericCharacterID = toInt(characterID, 0);
  const locationID = toInt(moduleItem && moduleItem.locationID, 0);
  const activeShipItem =
    numericCharacterID > 0 ? resolveActiveShipRecord(numericCharacterID) : null;
  if (
    activeShipItem &&
    (locationID <= 0 || toInt(activeShipItem.itemID, 0) === locationID)
  ) {
    return activeShipItem;
  }
  const storedShipItem =
    locationID > 0
      ? findShipItemById(locationID) || findItemById(locationID) || null
      : null;
  if (storedShipItem) {
    return storedShipItem;
  }
  return {
    itemID: locationID,
    typeID: 0,
    ownerID: numericCharacterID,
    singleton: 1,
  };
}

// Propulsion used to compose its own attribute map: the module's type
// attributes, its own overload effect, implants and command bursts, and then
// two skill bonuses written out as literals. Everything else the SDE says
// touches a propulsion module was missing, and two of the three skills were
// wrong:
//
//   - The Afterburner skill (3450) had no reader at all. It carries
//     durationBonus 66 = -5 through effect 230 and capNeedBonus 317 = -10
//     through effect 506, both `LocationRequiredSkillModifier` on skill 3450 —
//     so an afterburner cycled 10 s instead of 7.5 s at level V and cost 22 GJ
//     instead of 11.
//   - Fuel Conservation (3451) was applied to `groupID === 46`, which is every
//     published propulsion module, afterburners and microwarpdrives alike. Its
//     effect 506 is keyed on modules *requiring the Afterburner skill*, so a
//     microwarpdrive was getting -10 %/level it is not entitled to.
//   - High Speed Maneuvering (3454) hung off `groupID === 475`. No group 475
//     exists in the SDE, so its effect 244 (-5 %/level on modules requiring
//     3454) never fired for anything.
//
// `resolveGenericModuleAttributeOverrides` is the composition every other
// module family already runs through, and it reads all of that straight out of
// the SDE's own `modifierInfo`: skills, the hull's bonuses, rigs, T3
// subsystems, implants, boosters, wormhole system effects, projected modules
// and the module's own overload effect.
function getPropulsionModuleRuntimeAttributes(characterID, moduleItem, options = {}) {
  const MODULE_ATTRIBUTE_CAPACITOR_NEED = moduleAttributesModule.MODULE_ATTRIBUTE_CAPACITOR_NEED;
  const MODULE_ATTRIBUTE_DURATION = moduleAttributesModule.MODULE_ATTRIBUTE_DURATION;
  const MODULE_ATTRIBUTE_MASS_ADDITION = moduleAttributesModule.MODULE_ATTRIBUTE_MASS_ADDITION;
  const MODULE_ATTRIBUTE_MAX_GROUP_ACTIVE = moduleAttributesModule.MODULE_ATTRIBUTE_MAX_GROUP_ACTIVE;
  const MODULE_ATTRIBUTE_MAX_VELOCITY_ACTIVATION_LIMIT = moduleAttributesModule.MODULE_ATTRIBUTE_MAX_VELOCITY_ACTIVATION_LIMIT;
  const MODULE_ATTRIBUTE_REACTIVATION_DELAY = moduleAttributesModule.MODULE_ATTRIBUTE_REACTIVATION_DELAY;
  const MODULE_ATTRIBUTE_SIGNATURE_RADIUS_BONUS = moduleAttributesModule.MODULE_ATTRIBUTE_SIGNATURE_RADIUS_BONUS;
  const MODULE_ATTRIBUTE_SPEED_BOOST_FACTOR = moduleAttributesModule.MODULE_ATTRIBUTE_SPEED_BOOST_FACTOR;
  const MODULE_ATTRIBUTE_SPEED_FACTOR = moduleAttributesModule.MODULE_ATTRIBUTE_SPEED_FACTOR;
  const effectiveModuleItem = buildNpcEffectiveModuleItem(moduleItem);
  if (!effectiveModuleItem || !effectiveModuleItem.typeID) {
    return null;
  }

  const skillMap = options.skillMap instanceof Map
    ? options.skillMap
    : getCachedCharacterSkillMap(toInt(characterID, 0));
  const activeModuleContexts = Array.isArray(options.activeModuleContexts)
    ? options.activeModuleContexts
    : [];
  const shipItem =
    options.shipItem && typeof options.shipItem === "object"
      ? options.shipItem
      : resolvePropulsionHostShipItem(characterID, effectiveModuleItem);
  const composedAttributes = resolveGenericModuleAttributeOverrides(
    characterID,
    shipItem,
    effectiveModuleItem,
    null,
    {
      skillMap,
      activeModuleContexts,
      ...(Array.isArray(options.fittedItems)
        ? { fittedItems: options.fittedItems }
        : {}),
      additionalDirectModifierEntries: Array.isArray(
        options.additionalDirectModifierEntries,
      )
        ? options.additionalDirectModifierEntries
        : [],
    },
  );
  const moduleAttributes =
    composedAttributes || buildEffectiveItemAttributeMap(effectiveModuleItem);

  const speedFactor = toFiniteNumber(
    moduleAttributes[MODULE_ATTRIBUTE_SPEED_FACTOR],
    0,
  );
  const capNeed = toFiniteNumber(
    moduleAttributes[MODULE_ATTRIBUTE_CAPACITOR_NEED],
    0,
  );
  const durationMs = Math.max(
    1,
    toFiniteNumber(
      moduleAttributes[MODULE_ATTRIBUTE_DURATION],
      10000,
    ),
  );

  return {
    capNeed: Math.max(0, roundNumber(capNeed, 6)),
    durationMs: Math.max(1, roundNumber(durationMs, 3)),
    speedFactor: roundNumber(speedFactor, 6),
    speedBoostFactor: toFiniteNumber(
      moduleAttributes[MODULE_ATTRIBUTE_SPEED_BOOST_FACTOR],
      0,
    ),
    massAddition: toFiniteNumber(
      moduleAttributes[MODULE_ATTRIBUTE_MASS_ADDITION],
      0,
    ),
    signatureRadiusBonus: toFiniteNumber(
      moduleAttributes[MODULE_ATTRIBUTE_SIGNATURE_RADIUS_BONUS],
      0,
    ),
    maxGroupActive: toInt(
      moduleAttributes[MODULE_ATTRIBUTE_MAX_GROUP_ACTIVE],
      0,
    ),
    maxVelocityActivationLimit: toFiniteNumber(
      moduleAttributes[MODULE_ATTRIBUTE_MAX_VELOCITY_ACTIVATION_LIMIT],
      0,
    ),
    reactivationDelayMs: Math.max(
      0,
      toFiniteNumber(
        moduleAttributes[MODULE_ATTRIBUTE_REACTIVATION_DELAY],
        0,
      ),
    ),
  };
}

function refreshActivePropulsionEffectRuntimeAttributes(
  entity,
  effectState,
  nowMs,
) {
  if (
    !entity ||
    !effectState ||
    !(
      effectState.effectName === PROPULSION_EFFECT_AFTERBURNER ||
      effectState.effectName === PROPULSION_EFFECT_MICROWARPDRIVE
    )
  ) {
    return false;
  }

  const moduleItem = getEntityRuntimeModuleItem(
    entity,
    effectState.moduleID,
    effectState.moduleFlagID,
  );
  if (!moduleItem) {
    return false;
  }

  const runtimeAttributes = getPropulsionModuleRuntimeAttributes(
    getShipEntityInventoryCharacterID(entity, 0),
    moduleItem,
    {
      skillMap: getEntityRuntimeSkillMap(entity),
      shipItem: getEntityRuntimeShipItem(entity),
      fittedItems: getEntityRuntimeFittedItems(entity),
      activeModuleContexts: getEntityRuntimeActiveModuleContexts(entity, {
        excludeModuleID: toInt(moduleItem.itemID, 0),
        includeOverloadModuleID: toInt(moduleItem.itemID, 0),
      }),
      additionalDirectModifierEntries:
        resolveModuleSnapshotDirectModifierEntries(entity, moduleItem, {
          nowMs,
          collectModifierEntriesForItem:
            commandBurstRuntime.collectModifierEntriesForItem,
        }),
    },
  );
  if (!runtimeAttributes) {
    return false;
  }

  // These are continuous propulsion outputs. Recompute them immediately when
  // a command burst is applied or expires, but preserve the authored cycle
  // clock and its already-paid capacitor cost.
  effectState.speedFactor = runtimeAttributes.speedFactor;
  effectState.speedBoostFactor = runtimeAttributes.speedBoostFactor;
  effectState.massAddition = runtimeAttributes.massAddition;
  effectState.signatureRadiusBonus = runtimeAttributes.signatureRadiusBonus;
  return true;
}

function hasActivePropulsionEffect(entity, effectName, excludeModuleID = 0) {
  if (!entity || !(entity.activeModuleEffects instanceof Map)) {
    return false;
  }

  for (const effectState of entity.activeModuleEffects.values()) {
    if (!effectState || effectState.effectName !== effectName) {
      continue;
    }
    if (
      excludeModuleID > 0 &&
      toInt(effectState.moduleID, 0) === toInt(excludeModuleID, 0)
    ) {
      continue;
    }
    return true;
  }
  return false;
}

function applyPropulsionEffectStateToEntity(entity, effectState) {
  if (
    !entity ||
    !effectState ||
    !isPropulsionModuleEffectState(effectState)
  ) {
    return entity;
  }

  const passiveState = entity.passiveDerivedState || null;
  const passiveMass =
    toFiniteNumber(passiveState && passiveState.mass, toFiniteNumber(entity.mass, 0));
  const passiveMaxVelocity =
    toFiniteNumber(
      passiveState && passiveState.maxVelocity,
      toFiniteNumber(entity.maxVelocity, 0),
    );
  const massAfterAddition = passiveMass + toFiniteNumber(effectState.massAddition, 0);
  const speedMultiplier =
    1 +
    (0.01 *
      toFiniteNumber(effectState.speedFactor, 0) *
      toFiniteNumber(effectState.speedBoostFactor, 0) /
      Math.max(massAfterAddition, 1));

  applyPropulsionMotionBaseCommand(
    entity,
    () => roundNumber(massAfterAddition, 6),
    () => clampMaxVelocityToShipSpeedLimit(
      entity,
      roundNumber(passiveMaxVelocity * Math.max(speedMultiplier, 0), 6),
    ),
  );
  if (effectState.effectName === PROPULSION_EFFECT_MICROWARPDRIVE) {
    entity.signatureRadius = resolveShipSignatureRadius(
      passiveState || entity,
      [buildPropulsionSignatureModifier(effectState)],
      toFiniteNumber(entity.signatureRadius, 0),
    );
  }
  applyPropulsionMotionTimingCommand(
    entity,
    () => calculateAlignTimeSecondsFromMassInertia(
      entity.mass,
      entity.inertia,
      entity.alignTime,
    ),
    () => deriveAgilitySeconds(
      entity.alignTime,
      entity.maxAccelerationTime,
      entity.mass,
      entity.inertia,
    ),
  );
  return entity;
}

function getPropulsionEffectID(effectName) {
  if (effectName === PROPULSION_EFFECT_AFTERBURNER) {
    return EFFECT_ID_AFTERBURNER;
  }
  if (effectName === PROPULSION_EFFECT_MICROWARPDRIVE) {
    return EFFECT_ID_MICROWARPDRIVE;
  }
  return 0;
}

function isPropulsionModuleEffectState(effectState) {
  if (!effectState) {
    return false;
  }
  const effectName = String(effectState.effectName || "");
  const effectID =
    toInt(effectState.effectID, 0) ||
    getPropulsionEffectID(effectName);
  return (
    effectName === PROPULSION_EFFECT_AFTERBURNER ||
    effectName === PROPULSION_EFFECT_MICROWARPDRIVE ||
    effectID === EFFECT_ID_AFTERBURNER ||
    effectID === EFFECT_ID_MICROWARPDRIVE
  );
}

function applyActivePropulsionEffectStatesToEntity(entity, nowMs = Date.now()) {
  if (!entity || !(entity.activeModuleEffects instanceof Map)) {
    return entity;
  }

  for (const effectState of entity.activeModuleEffects.values()) {
    if (!isPropulsionModuleEffectState(effectState)) {
      continue;
    }
    refreshActivePropulsionEffectRuntimeAttributes(entity, effectState, nowMs);
    applyPropulsionEffectStateToEntity(entity, effectState);
  }
  return entity;
}

Object.assign(module.exports, {
  EFFECT_ID_AFTERBURNER,
  EFFECT_ID_MICROWARPDRIVE,
  PROPULSION_EFFECT_AFTERBURNER,
  PROPULSION_EFFECT_MICROWARPDRIVE,
  PROPULSION_GUID_BY_EFFECT,
});
