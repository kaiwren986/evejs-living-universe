"use strict";

module.exports = {
  advancePassiveRechargeRatio,
  applyPassiveResourceStateToEntity,
  buildPassiveShipResourceState,
  calculateAlignTimeSecondsFromMassInertia,
  clampMaxVelocityToShipSpeedLimit,
  resolveModifiedWarpSpeedAU,
  settlePassiveRechargeRatio,
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
  applyPassiveMotionBaseCommand,
  applyPassiveMotionTimingCommand,
  applyPropulsionMotionBaseCommand,
  applyPropulsionMotionTimingCommand,
  restoreCommandedSpeedFractionCommand,
} = require(path.join(runtimeEntryDirname, "./destiny/commands/shipDerivedMotion.js"));
const worldData = require(path.join(runtimeEntryDirname, "./worldData"));
const {
  clamp,
  toFiniteNumber,
  toInt,
} = require("../../common/numbers");
const {
  hasActiveShipImmobilizerEffect,
} = require("./shipActionRestrictions");
const {
  setEntityCloakStabilizationState,
} = require("./shipCloak");
const {
  DESTINY_ALIGN_LOG_DENOMINATOR,
  deriveAgilitySeconds,
  getActualSpeedFraction,
} = require("./shipMotionKinematics");

const PASSIVE_RECHARGE_FULL_SNAP_UNITS = 1;

const ATTRIBUTE_WARP_SPEED_MULTIPLIER =
  getAttributeIDByNames("warpSpeedMultiplier") || 600;

const ATTRIBUTE_BASE_WARP_SPEED =
  getAttributeIDByNames("baseWarpSpeed") || 1281;

function advancePassiveRechargeRatio(currentRatio, deltaSeconds, rechargeSeconds) {
  const isValidExactZero =
    typeof currentRatio === "number" &&
    Number.isFinite(currentRatio) &&
    currentRatio === 0;
  const clampedRatio = clamp(toFiniteNumber(currentRatio, 0), 0, 1);
  const elapsedSeconds = Math.max(0, toFiniteNumber(deltaSeconds, 0));
  const totalRechargeSeconds = Math.max(0, toFiniteNumber(rechargeSeconds, 0));
  if (
    (clampedRatio <= 0 && !isValidExactZero) ||
    clampedRatio >= 1 ||
    elapsedSeconds <= 0 ||
    totalRechargeSeconds <= 0
  ) {
    return clampedRatio;
  }

  // Closed-form progression of CCP's published capacitor curve:
  //   C1/Cmax = (1 + (sqrt(C0/Cmax) - 1) * e^(-5 * dt / T))^2
  const nextRoot =
    1 + ((Math.sqrt(clampedRatio) - 1) * Math.exp((-5 * elapsedSeconds) / totalRechargeSeconds));
  return clamp(nextRoot * nextRoot, 0, 1);
}

function settlePassiveRechargeRatio(nextRatio, capacity) {
  const clampedRatio = clamp(toFiniteNumber(nextRatio, 0), 0, 1);
  const maxCapacity = Math.max(0, toFiniteNumber(capacity, 0));
  if (clampedRatio >= 1 || maxCapacity <= 0) {
    return clampedRatio >= 1 ? 1 : clampedRatio;
  }

  const remainingUnits = maxCapacity * (1 - clampedRatio);
  return remainingUnits <= PASSIVE_RECHARGE_FULL_SNAP_UNITS ? 1 : clampedRatio;
}

function calculateAlignTimeSecondsFromMassInertia(mass, inertia, fallback = 0) {
  const numericMass = toFiniteNumber(mass, 0);
  const numericInertia = toFiniteNumber(inertia, 0);
  if (numericMass > 0 && numericInertia > 0) {
    return (DESTINY_ALIGN_LOG_DENOMINATOR * numericMass * numericInertia) / 1_000_000;
  }
  return toFiniteNumber(fallback, 0);
}

function buildPassiveShipResourceState(characterID, shipItem, options = {}) {
  if (!shipItem || !shipItem.typeID) {
    return null;
  }

  const numericCharacterID = toInt(characterID, 0);
  if (numericCharacterID <= 0) {
    // Sessionless runtime ships such as `/fire` dummies still need a real
    // dogma-derived health envelope so targeting, damage, death, and damage
    // state updates all follow the same authoritative combat path.
    return buildShipResourceState(0, shipItem, {
      ...options,
      fittedItems: Array.isArray(options.fittedItems) ? options.fittedItems : [],
      skillMap: options.skillMap instanceof Map ? options.skillMap : new Map(),
    });
  }

  if (!shipItem.itemID) {
    return null;
  }

  return buildShipResourceState(numericCharacterID, shipItem, options);
}

const ATTRIBUTE_SPEED_LIMIT = getAttributeIDByNames("speedLimit") || 2033;

// speedLimit (2033) is a hard sublight ceiling, not a bonus: effect 6163
// `passiveSpeedLimit` PostAssignments the module's own 2033 onto the ship, and
// the dogma pipeline already derives it — a ship with an Entosis Link fitted
// reads 4000 (4200 on the Noir. Modified) in passiveDerivedState.attributes.
// Nothing consumed it, so the ceiling did not exist. The SDE default is
// 1,000,000 m/s and only the six Entosis Links declare the attribute at all, so
// every other hull is untouched.
//
// It has to be applied at BOTH maxVelocity writers: the passive one below and
// applyPropulsionEffectStateToEntity, which recomputes maxVelocity from
// passiveMaxVelocity * speedMultiplier and would otherwise let an afterburner
// or microwarpdrive walk straight through the cap.
function clampMaxVelocityToShipSpeedLimit(entity, maxVelocity) {
  const numericMaxVelocity = require("../../services/spaceComponents/shipLinkRestrictions")
    .clampShipLinkMaxVelocity(entity, toFiniteNumber(maxVelocity, 0));
  const attributes =
    entity && entity.passiveDerivedState && entity.passiveDerivedState.attributes;
  if (!attributes) {
    return numericMaxVelocity;
  }
  const speedLimit = toFiniteNumber(attributes[ATTRIBUTE_SPEED_LIMIT], 0);
  if (speedLimit <= 0 || numericMaxVelocity <= speedLimit) {
    return numericMaxVelocity;
  }
  return speedLimit;
}

function applyPassiveResourceStateToEntity(entity, resourceState, options = {}) {
  if (!entity || !resourceState) {
    return entity;
  }

  const previousConditionState = normalizeShipConditionState(entity.conditionState);
  const previousArmorHP = Math.max(0, toFiniteNumber(entity.armorHP, 0));
  const previousArmorDamageAmount = previousArmorHP > 0
    ? previousArmorHP * Math.max(
      0,
      toFiniteNumber(previousConditionState.armorDamage, 0),
    )
    : null;
  const movement =
    worldData.getMovementAttributesForType(entity.typeID) || null;
  const nextMass =
    toFiniteNumber(resourceState.mass, 0) > 0
      ? toFiniteNumber(resourceState.mass, 0)
      : toFiniteNumber(entity.mass, 0);
  const nextInertia =
    toFiniteNumber(resourceState.agility, 0) > 0
      ? toFiniteNumber(resourceState.agility, 0)
      : toFiniteNumber(entity.inertia, 0);
  const fallbackAlignTime =
    toFiniteNumber(movement && movement.alignTime, 0) > 0
      ? toFiniteNumber(movement.alignTime, 0)
      : toFiniteNumber(entity.alignTime, 0);
  // A derived maxVelocity of zero is normally read as "this hull declares no
  // speed" — structures and NPC types with incomplete Dogma must keep the
  // speed they were spawned with rather than be pinned by a missing attribute.
  // The siege family is the exception: Bastion, Siege, Triage and Industrial
  // Core all carry a -100% speedFactor, so zero is precisely the answer Dogma
  // computed and it has to reach the entity. Gate on the immobilizer flag the
  // effect state already derives from the module's own modifiers, so this
  // stays data-driven rather than a type whitelist.
  const derivedMaxVelocity = toFiniteNumber(resourceState.maxVelocity, 0);
  const immobilized = hasActiveShipImmobilizerEffect(entity);

  entity.passiveDerivedState = resourceState;
  applyPassiveMotionBaseCommand(
    entity,
    () => (nextMass > 0 ? nextMass : entity.mass),
    () => (nextInertia > 0 ? nextInertia : entity.inertia),
    () => {
      if (derivedMaxVelocity > 0) {
        return clampMaxVelocityToShipSpeedLimit(entity, derivedMaxVelocity);
      }
      return immobilized
        ? 0
        : clampMaxVelocityToShipSpeedLimit(entity, entity.maxVelocity);
    },
  );
  const refreshedWarpSpeedAU = resolveModifiedWarpSpeedAU(resourceState);
  if (refreshedWarpSpeedAU > 0) {
    entity.warpSpeedAU = refreshedWarpSpeedAU;
  }
  entity.maxTargetRange = toFiniteNumber(
    resourceState.maxTargetRange,
    toFiniteNumber(entity.maxTargetRange, 0),
  );
  entity.maxLockedTargets = toFiniteNumber(
    resourceState.maxLockedTargets,
    toFiniteNumber(entity.maxLockedTargets, 0),
  );
  entity.signatureRadius = toFiniteNumber(
    resourceState.signatureRadius,
    toFiniteNumber(entity.signatureRadius, 0),
  );
  entity.cloakingTargetingDelay = toFiniteNumber(
    resourceState.cloakingTargetingDelay,
    toFiniteNumber(entity.cloakingTargetingDelay, 0),
  );
  setEntityCloakStabilizationState(
    entity,
    entity.cloakStabilizationUntilMs,
    Date.now(),
  );
  entity.scanResolution = toFiniteNumber(
    resourceState.scanResolution,
    toFiniteNumber(entity.scanResolution, 0),
  );
  entity.capacitorCapacity = toFiniteNumber(
    resourceState.capacitorCapacity,
    toFiniteNumber(entity.capacitorCapacity, 0),
  );
  entity.capacitorRechargeRate = toFiniteNumber(
    resourceState.capacitorRechargeRate,
    toFiniteNumber(entity.capacitorRechargeRate, 0),
  );
  entity.shieldCapacity = toFiniteNumber(
    resourceState.shieldCapacity,
    toFiniteNumber(entity.shieldCapacity, 0),
  );
  entity.shieldRechargeRate = toFiniteNumber(
    resourceState.shieldRechargeRate,
    toFiniteNumber(entity.shieldRechargeRate, 0),
  );
  entity.armorHP = toFiniteNumber(
    resourceState.armorHP,
    toFiniteNumber(entity.armorHP, 0),
  );
  if (previousArmorDamageAmount !== null) {
    const nextArmorHP = Math.max(0, toFiniteNumber(entity.armorHP, 0));

    // Armor HP modifiers change the size of the layer, not the absolute damage
    // already sustained. The resulting damage ratio may exceed 1 after a max-HP
    // bonus expires; that deficit must be repaired before armor rises above 0.
    if (
      nextArmorHP > 0 &&
      Math.abs(nextArmorHP - previousArmorHP) > 1e-9
    ) {
      entity.conditionState = normalizeShipConditionState({
        ...previousConditionState,
        armorDamage: previousArmorDamageAmount / nextArmorHP,
      });
    }
  }
  entity.structureHP = toFiniteNumber(
    resourceState.structureHP,
    toFiniteNumber(entity.structureHP, 0),
  );
  applyPassiveMotionTimingCommand(
    entity,
    () => calculateAlignTimeSecondsFromMassInertia(
      entity.mass,
      entity.inertia,
      fallbackAlignTime,
    ),
    () => deriveAgilitySeconds(
      entity.alignTime,
      entity.maxAccelerationTime,
      entity.mass,
      entity.inertia,
    ),
  );
  if (options.recalculateSpeedFraction === true) {
    entity.speedFraction = getActualSpeedFraction(entity);
  }
  return entity;
}

function resolveModifiedWarpSpeedAU(passiveResourceState) {
  const attributes =
    passiveResourceState && typeof passiveResourceState === "object"
      ? passiveResourceState.attributes
      : null;
  if (!attributes || typeof attributes !== "object") {
    return 0;
  }

  const multiplier = toFiniteNumber(
    attributes[String(ATTRIBUTE_WARP_SPEED_MULTIPLIER)],
    0,
  );
  if (multiplier <= 0) {
    return 0;
  }

  const base = toFiniteNumber(
    attributes[String(ATTRIBUTE_BASE_WARP_SPEED)],
    0,
  );
  return multiplier * (base > 0 ? base : 1);
}

Object.assign(module.exports, {
  ATTRIBUTE_BASE_WARP_SPEED,
  ATTRIBUTE_SPEED_LIMIT,
  ATTRIBUTE_WARP_SPEED_MULTIPLIER,
  PASSIVE_RECHARGE_FULL_SNAP_UNITS,
});
