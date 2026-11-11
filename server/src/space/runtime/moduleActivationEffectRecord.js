"use strict";

module.exports = {
  isActivatableEffectRecord,
  resolveChargeDefaultActivationEffectForModule,
  resolveDefaultActivationEffect,
  resolveEffectByName,
  resolveNpcSyntheticHullEffectRecord,
};

const runtimeEntryDirname = require("path").resolve(__dirname, "..");
const path = require("path");
const warpDisruptFieldGeneratorRuntime = require(path.join(
  runtimeEntryDirname,
  "../services/ship/warpDisruptFieldGeneratorRuntime",
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
  toInt,
} = require("../../common/numbers");

// -----------------------------------------------------------------------
// Generic module activation — supports any module with an activatable
// effect (effectCategoryID 1=activation, 2=targeted, 3=area).  This gives
// all modules proper cycle timing so the HUD radial ring works.
// -----------------------------------------------------------------------

const ACTIVATABLE_EFFECT_CATEGORIES = new Set([1, 2, 3]);

const PASSIVE_SLOT_EFFECTS = new Set(["online", "hipower", "medpower", "lopower",
  "rigslot", "subsystem", "turretfitted", "launcherfitted"]);

// An effect that declares both a cycle time and a capacitor cost is something
// the pilot switches on, whatever category the SDE files it under.
//
// warpCoreStabilizerActive (8121) is the reason this exists: CCP made the Warp
// Core Stabilizer an active module but left its effect in category 4 (online),
// so a categories-only gate refused to activate it at all — the module could
// never be used. It is the only effect in the SDE carrying category 4 together
// with a duration, so this rule reaches exactly that one module and nothing
// else.
function isActivatableEffectRecord(record) {
  if (!record) {
    return false;
  }
  if (PASSIVE_SLOT_EFFECTS.has(String(record.name || "").toLowerCase())) {
    return false;
  }
  if (ACTIVATABLE_EFFECT_CATEGORIES.has(toInt(record.effectCategoryID, 0))) {
    return true;
  }
  return (
    toInt(record.durationAttributeID, 0) > 0 &&
    toInt(record.dischargeAttributeID, 0) > 0
  );
}

function resolveDefaultActivationEffect(typeID) {
  const numericTypeID = toInt(typeID, 0);
  if (numericTypeID <= 0) {
    return null;
  }

  const effectIDs = getTypeDogmaEffects(numericTypeID);
  for (const effectID of effectIDs) {
    const record = getEffectTypeRecord(effectID);
    if (!isActivatableEffectRecord(record)) {
      continue;
    }
    return record;
  }
  return null;
}

function resolveEffectByName(typeID, effectName) {
  const numericTypeID = toInt(typeID, 0);
  if (numericTypeID <= 0 || !effectName) {
    return null;
  }

  const normalized = String(effectName).toLowerCase()
    .replace(/^effects\./, "").replace(/^dogmaxp\./, "");
  const effectIDs = getTypeDogmaEffects(numericTypeID);
  for (const effectID of effectIDs) {
    const record = getEffectTypeRecord(effectID);
    if (!record) {
      continue;
    }
    const recordName = String(record.name || "").toLowerCase();
    if (recordName === normalized) {
      return record;
    }
    const guidSuffix = String(record.guid || "").toLowerCase()
      .replace(/^effects\./, "");
    if (guidSuffix && guidSuffix === normalized) {
      return record;
    }
  }
  return null;
}

// A synthetic NPC hull module's typeID is the rat hull, so `resolveEffectByName` can only ever
// find the families the hull declares as dogma effects. The entity-EWAR families are declared as
// ATTRIBUTES with no matching effect (327 rows over 219 types, 0 resolvable by name or by guid),
// and the fallback below — the type's FIRST activatable effect — is a rat's `targetAttack`. That
// is how an attribute-only rat came to fire a phantom gun at `targetID` 0 instead of webbing.
//
// So the synthesizer stamps the SDE effect the module IS, and it is bound here. The name still
// has to agree with what the caller asked for: this is a binding, not an override, and a module
// whose stamped effect and requested effect disagree is a bug worth failing on.
function resolveNpcSyntheticHullEffectRecord(moduleItem, effectName) {
  if (!moduleItem || moduleItem.npcSyntheticHullModule !== true) {
    return null;
  }
  const record = getEffectTypeRecord(toInt(moduleItem.npcSyntheticHullEffectID, 0));
  if (!record) {
    return null;
  }
  const normalized = String(effectName || "").toLowerCase()
    .replace(/^effects\./, "").replace(/^dogmaxp\./, "");
  const guidSuffix = String(record.guid || "").toLowerCase().replace(/^effects\./, "");
  if (
    String(record.name || "").toLowerCase() !== normalized &&
    (!guidSuffix || guidSuffix !== normalized)
  ) {
    return null;
  }
  // The SDE's entity neutralizer binds range to 98 `energyNeutralizerRangeOptimal`, which the
  // `entityCapacitorDrainAmount` rats do not declare. The synthesizer names the range attribute
  // the hull actually carries; everything else stays the SDE's record.
  const rangeAttributeID = toInt(moduleItem.npcSyntheticHullRangeAttributeID, 0);
  return rangeAttributeID > 0 && rangeAttributeID !== toInt(record.rangeAttributeID, 0)
    ? { ...record, rangeAttributeID }
    : record;
}

function resolveChargeDefaultActivationEffectForModule(
  moduleItem,
  effectRecord,
  chargeItem,
) {
  if (!moduleItem || !effectRecord || !chargeItem) {
    return effectRecord;
  }
  if (
    toInt(effectRecord.effectID, 0) !==
      warpDisruptFieldGeneratorRuntime.EFFECT_WARP_DISRUPT_SPHERE ||
    !warpDisruptFieldGeneratorRuntime.isWarpDisruptFieldGeneratorType(moduleItem) ||
    !warpDisruptFieldGeneratorRuntime.isSupportedFocusedWarpDisruptionScriptType(chargeItem)
  ) {
    return effectRecord;
  }
  return resolveDefaultActivationEffect(chargeItem.typeID) || effectRecord;
}

// Living Universe: the mod's one-call form of activation effect resolution,
// kept for its verify script (runtime._testing). A named effect on the type,
// then a synthetic NPC hull module's stamped or globally named effect, then
// the type's default activation.
function resolveGenericModuleActivationEffect(
  moduleItem,
  effectiveModuleItem,
  effectName,
) {
  let effectRecord = effectName
    ? resolveEffectByName(effectiveModuleItem && effectiveModuleItem.typeID, effectName)
    : null;
  if (!effectRecord && effectName) {
    effectRecord = resolveNpcSyntheticHullEffectRecord(moduleItem, effectName);
  }
  if (
    !effectRecord &&
    effectName &&
    moduleItem &&
    moduleItem.npcSyntheticHullModule === true
  ) {
    const syntheticEffectID = toInt(getEffectIDByNames(effectName), 0);
    effectRecord = syntheticEffectID > 0
      ? getEffectTypeRecord(syntheticEffectID)
      : null;
  }
  return effectRecord || resolveDefaultActivationEffect(
    effectiveModuleItem && effectiveModuleItem.typeID,
  );
}

Object.assign(module.exports, {
  resolveGenericModuleActivationEffect, // Living Universe
  ACTIVATABLE_EFFECT_CATEGORIES,
  PASSIVE_SLOT_EFFECTS,
});
