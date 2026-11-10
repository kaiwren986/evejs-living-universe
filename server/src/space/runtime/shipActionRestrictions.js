"use strict";

module.exports = {
  cynosuralModuleTypeDeclaresShipRestriction,
  findActiveBastionModuleEffectState,
  findActiveEffectStateDisallowingCloaking,
  findActiveEffectStateDisallowingEarlyDeactivation,
  hasActiveShipDockingDisallowedEffect,
  hasActiveShipEffectFlag,
  hasActiveShipImmobilizerEffect,
  hasActiveWarpDisallowingModuleEffect,
  isBastionModuleActivation,
  isBastionModuleEffectState,
  isEntityBastionLocked,
  isEntityOffensiveActivationDisallowed,
  isMobileAnalysisBeaconCloakBlocked,
  isShipCloakDisabledByRuntime,
  isMobileAnalysisBeaconMovementLocked,
  isMobileAnalysisBeaconWarpDisabled,
  isShipMovementLockedByRuntime,
  isShipWarpDisabledByRuntime,
  moduleTypeDisallowsEarlyDeactivation,
  moduleTypeDisallowsShipCloaking,
  moduleTypeDisallowsWarp,
  shipModifierEntriesImmobilizeShip,
  shipModifierEntriesSetPositiveAttribute,
  shipModifierEntrySetsPositiveValue,
};

const runtimeEntryDirname = require("path").resolve(__dirname, "..");
const path = require("path");
const { blocksShipAction } = require("../../services/spaceComponents/shipLinkRestrictions");
const starbaseDefenseRuntime = require("../../services/starbase/starbaseDefenseRuntime");
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
  buildSuperweaponFreshAcquireFxOptions,
  prepareSuperweaponActivation,
  executeSuperweaponActivation,
  finalizeSuperweaponDeactivation,
  isSuperweaponFxReplayWindowActive,
  tickScene: tickSuperweaponScene,
  isSuperweaponMovementLocked,
  isSuperweaponJumpOrCloakLocked,
  entityHasCloakDisallowingFittedModule,
} = require(path.join(runtimeEntryDirname, "./modules/superweapons/superweaponRuntime"));
const {
  isEntityDisruptiveLanceDebuffed,
} = require(path.join(runtimeEntryDirname, "./modules/superweapons/disruptiveLanceDebuff"));
const {
  ATTRIBUTE_MAX_VELOCITY,
} = require("./dogmaAttributeIds");
const {
  toFiniteNumber,
  toInt,
} = require("../../common/numbers");
const {
  getTypeDogmaAttributeValueByID,
} = require("./typeAttributeLookup");

const GROUP_SIEGE_MODULE = 515;

const EFFECT_ID_BASTION_MODULE =
  getEffectIDByNames("moduleBonusBastionModule") || 6658;

const BASTION_MODULE_EFFECT_NAMES = new Set([
  "modulebonusbastionmodule",
]);

const BASTION_MODULE_EFFECT_GUIDS = new Set([
  "effects.siegemode",
]);

const ATTRIBUTE_DISALLOW_OFFENSIVE_ACT =
  getAttributeIDByNames("disallowOffensiveAct") || 872;

function isMobileAnalysisBeaconMovementLocked(entity, nowMs = Date.now()) {
  return toFiniteNumber(entity && entity.mobileAnalysisBeaconImmobileUntilMs, 0) >
    toFiniteNumber(nowMs, 0);
}

function isMobileAnalysisBeaconWarpDisabled(entity, nowMs = Date.now()) {
  return toFiniteNumber(entity && entity.mobileAnalysisBeaconWarpDisabledUntilMs, 0) >
    toFiniteNumber(nowMs, 0);
}

function isMobileAnalysisBeaconCloakBlocked(entity, nowMs = Date.now()) {
  return toFiniteNumber(entity && entity.mobileAnalysisBeaconCloakBlockedUntilMs, 0) >
    toFiniteNumber(nowMs, 0);
}

function isShipCloakDisabledByRuntime(entity, nowMs = Date.now()) {
  return blocksShipAction(entity, "blocksCloak") || isMobileAnalysisBeaconCloakBlocked(entity, nowMs);
}

function isShipMovementLockedByRuntime(entity, nowMs = Date.now()) {
  return (
    isEntityBastionLocked(entity) ||
    isSuperweaponMovementLocked(entity, nowMs) ||
    isMobileAnalysisBeaconMovementLocked(entity, nowMs) ||
    hasActiveShipImmobilizerEffect(entity)
  );
}

// A Disruptive Lance disables the warp and jump drives of everything its beam
// touched, but it does not pin the ship in place — the target can still burn
// away under its own power. Keep it out of isShipMovementLockedByRuntime, which
// stops approach, orbit and every other sublight order as well.
function isShipWarpDisabledByRuntime(entity, nowMs = Date.now()) {
  return (
    blocksShipAction(entity, "blocksWarp") ||
    isShipMovementLockedByRuntime(entity, nowMs) ||
    isMobileAnalysisBeaconWarpDisabled(entity, nowMs) ||
    isEntityDisruptiveLanceDebuffed(entity, nowMs) ||
    hasActiveWarpDisallowingModuleEffect(entity)
  );
}

function isEntityOffensiveActivationDisallowed(entity) {
  // POS 872=1 means the battery cannot RECEIVE hostile modifiers, not that it
  // cannot fire (client dogma/effects/util.py:52). The historical ship-only
  // disallowOffensiveAct compatibility fallback must not disable batteries.
  if (starbaseDefenseRuntime.isStarbaseBattery(entity)) return false;
  if (!entity || !entity.passiveDerivedState) {
    return false;
  }
  const attributes =
    entity.passiveDerivedState.attributes &&
    typeof entity.passiveDerivedState.attributes === "object"
      ? entity.passiveDerivedState.attributes
      : {};
  return toFiniteNumber(attributes[ATTRIBUTE_DISALLOW_OFFENSIVE_ACT], 0) > 0;
}

// Active siege-family effects describe their restrictions in Dogma. Keep the
// runtime behavior data-driven so Siege, Triage, Industrial Core, Bastion, and
// future variants do not need separate type or effect whitelists.
const DOGMA_OPERATION_PRE_ASSIGNMENT = -1;

const DOGMA_OPERATION_MOD_ADD = 2;

const DOGMA_OPERATION_POST_PERCENT = 6;

const DOGMA_OPERATION_POST_ASSIGNMENT = 7;

const ATTRIBUTE_DISALLOW_DOCKING = getAttributeIDByNames("disallowDocking") || 2354;

const ATTRIBUTE_DISALLOW_TETHERING = getAttributeIDByNames("disallowTethering") || 2343;

function shipModifierEntriesImmobilizeShip(modifierEntries) {
  return (Array.isArray(modifierEntries) ? modifierEntries : []).some((entry) => (
    entry &&
    toInt(entry.modifiedAttributeID, 0) === ATTRIBUTE_MAX_VELOCITY &&
    toInt(entry.operation, -2) === DOGMA_OPERATION_POST_PERCENT &&
    toFiniteNumber(entry.value, 0) <= -100
  ));
}

function shipModifierEntrySetsPositiveValue(entry) {
  if (!entry || toFiniteNumber(entry.value, 0) <= 0) {
    return false;
  }
  const operation = toInt(entry.operation, -2);
  return (
    operation === DOGMA_OPERATION_PRE_ASSIGNMENT ||
    operation === DOGMA_OPERATION_MOD_ADD ||
    operation === DOGMA_OPERATION_POST_ASSIGNMENT
  );
}

// All three Cynosural Field Generators declare `disallowTethering` (2343) and
// `disallowDocking` (2354) on the type, and EVE University states the rule in
// so many words — "you cannot dock in a station or structure and cannot eject,
// but you can self destruct" (https://wiki.eveuniversity.org/Jump_drives) — but
// effect 2857 carries only three modifier rows (104 warpScrambleStatus, 37
// maxVelocity, 1163 canCloak) and none of them is the projection that
// `shipModifierEntriesSetPositiveAttribute` reads. Siege, triage, bastion, the
// industrial cores and the sensor arrays declare the row in the SDE; the Micro
// Jump Field Generators get theirs transcribed from the client's own
// microJumpPortalDrive.py; the cyno has neither.
//
// This is deliberately scoped to the cyno family rather than made general.
// 58 published types declare 2354 without any effect projecting it (command
// bursts, doomsdays, burst projectors, phenomena generators, gang coordinators,
// clone vat bays) and 43 do the same for 2343. That looks like one shared
// dogma gap, but only the cyno half of it has a sourced rule behind it, and
// family 20 already set the precedent of not acting on inference alone.
function cynosuralModuleTypeDeclaresShipRestriction(
  isCynosuralActivation,
  moduleItem,
  attributeID,
) {
  if (isCynosuralActivation !== true) {
    return false;
  }
  return toFiniteNumber(
    getTypeDogmaAttributeValueByID(
      toInt(moduleItem && moduleItem.typeID, 0),
      attributeID,
      0,
    ),
    0,
  ) > 0;
}

function shipModifierEntriesSetPositiveAttribute(modifierEntries, attributeID) {
  return (Array.isArray(modifierEntries) ? modifierEntries : []).some((entry) => (
    entry &&
    toInt(entry.modifiedAttributeID, 0) === attributeID &&
    shipModifierEntrySetsPositiveValue(entry)
  ));
}

function hasActiveShipEffectFlag(entity, flagName) {
  if (!entity || !(entity.activeModuleEffects instanceof Map)) {
    return false;
  }
  for (const effectState of entity.activeModuleEffects.values()) {
    if (
      effectState &&
      toFiniteNumber(effectState.deactivatedAtMs, 0) <= 0 &&
      effectState[flagName] === true
    ) {
      return true;
    }
  }
  return false;
}

function hasActiveShipImmobilizerEffect(entity) {
  return hasActiveShipEffectFlag(entity, "immobilizesShip");
}

function hasActiveShipDockingDisallowedEffect(entity) {
  return blocksShipAction(entity, "blocksJumpOrDock") || hasActiveShipEffectFlag(entity, "disallowsDocking");
}

function isBastionModuleActivation(moduleItem, effectRecord) {
  const groupID = toInt(moduleItem && moduleItem.groupID, 0);
  const effectID = toInt(effectRecord && effectRecord.effectID, 0);
  const effectName = String(effectRecord && effectRecord.name || "")
    .trim()
    .toLowerCase();
  const effectGuid = String(effectRecord && effectRecord.guid || "")
    .trim()
    .toLowerCase();
  const itemName = String(
    moduleItem && (
      moduleItem.itemName ||
      moduleItem.typeName ||
      moduleItem.name
    ) || "",
  ).trim().toLowerCase();
  return (
    effectID === EFFECT_ID_BASTION_MODULE ||
    BASTION_MODULE_EFFECT_NAMES.has(effectName) ||
    BASTION_MODULE_EFFECT_GUIDS.has(effectGuid) ||
    (
      groupID === GROUP_SIEGE_MODULE &&
      itemName.includes("bastion")
    )
  );
}

function isBastionModuleEffectState(effectState) {
  if (!effectState) {
    return false;
  }
  if (effectState.bastionModuleEffect === true) {
    return true;
  }
  const effectID = toInt(effectState.effectID, 0);
  const effectName = String(effectState.effectName || "").trim().toLowerCase();
  const effectGuid = String(effectState.guid || "").trim().toLowerCase();
  return (
    effectID === EFFECT_ID_BASTION_MODULE ||
    BASTION_MODULE_EFFECT_NAMES.has(effectName) ||
    BASTION_MODULE_EFFECT_GUIDS.has(effectGuid)
  );
}

function findActiveBastionModuleEffectState(entity) {
  if (!entity || !(entity.activeModuleEffects instanceof Map)) {
    return null;
  }
  for (const effectState of entity.activeModuleEffects.values()) {
    if (
      effectState &&
      toFiniteNumber(effectState.deactivatedAtMs, 0) <= 0 &&
      isBastionModuleEffectState(effectState)
    ) {
      return effectState;
    }
  }
  return null;
}

function isEntityBastionLocked(entity) {
  return Boolean(findActiveBastionModuleEffectState(entity));
}

const ATTRIBUTE_DISALLOW_EARLY_DEACTIVATION =
  getAttributeIDByNames("disallowEarlyDeactivation") || 906;

// Attribute 906 is named `disallowEarlyDeactivation` but its own SDE
// description is "Signifies that this module if activated, will prevent
// ejection from the ship it is fitted to and extend the log out ship removal
// timer." It is a commitment flag, NOT a "the cycle cannot be cut short" flag —
// 76 published types carry it (Siege/Triage/Bastion, doomsdays, cynos, jump
// portals, burst projectors, Micro Jump Drives, Clone Vat Bays, and all ten Gas
// Cloud Scoops / Gas Cloud Harvesters), and gas harvesters demonstrably do
// short-cycle on TQ.
//
// The V24 client's one use of it is the cloak gate in
// eve/client/script/ui/shared/fittingScreen/pythonEffects.py: FakeCloaking
// .PreStartChecks walks GetActivatedEffectsOnShip and raises
// CantCloakModuleActive for any type carrying it. That is transcribed here.
function moduleTypeDisallowsEarlyDeactivation(moduleTypeID) {
  return toInt(
    getTypeDogmaAttributeValueByID(
      toInt(moduleTypeID, 0),
      ATTRIBUTE_DISALLOW_EARLY_DEACTIVATION,
      0,
    ),
    0,
  ) === 1;
}

function findActiveEffectStateDisallowingEarlyDeactivation(entity, excludeModuleID = 0) {
  if (!entity || !(entity.activeModuleEffects instanceof Map)) {
    return null;
  }
  const normalizedExcludeModuleID = toInt(excludeModuleID, 0);
  for (const effectState of entity.activeModuleEffects.values()) {
    if (
      !effectState ||
      toInt(effectState.moduleID, 0) === normalizedExcludeModuleID
    ) {
      continue;
    }
    if (moduleTypeDisallowsEarlyDeactivation(effectState.typeID)) {
      return effectState;
    }
  }
  return null;
}

const ATTRIBUTE_CAN_CLOAK = getAttributeIDByNames("canCloak") || 1163;

// The line above the disallowEarlyDeactivation walk in the client's
// FakeCloaking.PreStartChecks is
//   if not dogmaLM.GetAttributeValue(shipID, const.attributeCanCloak):
//       raise UserError('CantCloakTooShipUnsuitable')
// — attribute 1163, read off the SHIP. Modules that ban cloaking push their own
// 1163 onto the ship with a PostAssignment modifier (cynosuralGeneration 2857,
// cloneJumpAccepting 2858, industrialCoreEffect2 4575 all declare it), and
// effect 6063 entosisLink ships with an EMPTY modifierInfo, so an Entosis Link
// never assigns it and the ship-side read can never fire. Read it off the
// active module's own type instead, exactly as the sibling gate below reads 906.
//
// Reach: of the 24 published types declaring canCloak 0, every one except the
// six Entosis Links also declares disallowEarlyDeactivation 1 and is therefore
// already refused by that gate. This adds the Entosis Link and nothing else.
function moduleTypeDisallowsShipCloaking(moduleTypeID) {
  const numericModuleTypeID = toInt(moduleTypeID, 0);
  if (numericModuleTypeID <= 0) {
    return false;
  }
  const declaredCanCloak = getTypeDogmaAttributeValueByID(
    numericModuleTypeID,
    ATTRIBUTE_CAN_CLOAK,
    null,
  );
  return declaredCanCloak !== null && toFiniteNumber(declaredCanCloak, 1) === 0;
}

function findActiveEffectStateDisallowingCloaking(entity, excludeModuleID = 0) {
  if (!entity || !(entity.activeModuleEffects instanceof Map)) {
    return null;
  }
  const normalizedExcludeModuleID = toInt(excludeModuleID, 0);
  for (const effectState of entity.activeModuleEffects.values()) {
    if (
      !effectState ||
      toInt(effectState.moduleID, 0) === normalizedExcludeModuleID
    ) {
      continue;
    }
    if (moduleTypeDisallowsShipCloaking(effectState.typeID)) {
      return effectState;
    }
  }
  return null;
}

const ATTRIBUTE_SIEGE_MODE_WARP_STATUS =
  getAttributeIDByNames("siegeModeWarpStatus") || 852;

// siegeModeWarpStatus 100 is how the SDE says "this module commits the ship".
// Its consumers declare `warpScrambleStatus (104) += siegeModeWarpStatus` on the
// ship domain — cynosuralGeneration 2857, cloneJumpAccepting 2858 and
// industrialCoreEffect2 4575 all carry that exact row, and a running Cynosural
// Field Generator does derive warpScrambleStatus 100 here today. effect 6063
// entosisLink declares 852 = 100 on all six of its types and ships with an
// EMPTY modifierInfo, so the Entosis Link is the one carrier that self-scrambles
// nothing and could warp away mid-cycle.
//
// Read it off the active module's own type, the same shape as the cloak gates
// above. Reach: 45 of the 49 published types carrying 852 are siege/triage/
// bastion/industrial-core or a cyno, all of which already return SHIP_IMMOBILE
// from the immobilizer branch of the same predicate, so their answer does not
// change. The behaviour genuinely new here is that a doomsday, lance, reaper,
// burst projector, jump portal or clone vat bay cycle now also pins the ship
// against warp — which is what all of them do on Tranquility.
function moduleTypeDisallowsWarp(moduleTypeID) {
  const numericModuleTypeID = toInt(moduleTypeID, 0);
  if (numericModuleTypeID <= 0) {
    return false;
  }
  return toFiniteNumber(
    getTypeDogmaAttributeValueByID(
      numericModuleTypeID,
      ATTRIBUTE_SIEGE_MODE_WARP_STATUS,
      0,
    ),
    0,
  ) > 0;
}

function hasActiveWarpDisallowingModuleEffect(entity) {
  if (!entity || !(entity.activeModuleEffects instanceof Map)) {
    return false;
  }
  for (const effectState of entity.activeModuleEffects.values()) {
    if (effectState && moduleTypeDisallowsWarp(effectState.typeID)) {
      return true;
    }
  }
  return false;
}

Object.assign(module.exports, {
  ATTRIBUTE_CAN_CLOAK,
  ATTRIBUTE_DISALLOW_DOCKING,
  ATTRIBUTE_DISALLOW_EARLY_DEACTIVATION,
  ATTRIBUTE_DISALLOW_OFFENSIVE_ACT,
  ATTRIBUTE_DISALLOW_TETHERING,
  ATTRIBUTE_SIEGE_MODE_WARP_STATUS,
  BASTION_MODULE_EFFECT_GUIDS,
  BASTION_MODULE_EFFECT_NAMES,
  DOGMA_OPERATION_MOD_ADD,
  DOGMA_OPERATION_POST_ASSIGNMENT,
  DOGMA_OPERATION_POST_PERCENT,
  DOGMA_OPERATION_PRE_ASSIGNMENT,
  EFFECT_ID_BASTION_MODULE,
  GROUP_SIEGE_MODULE,
});
