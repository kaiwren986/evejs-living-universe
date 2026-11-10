"use strict";

module.exports = {
  advanceEntityRackHeat,
  applyHeatDamageHPToModule,
  applyOverloadHeatDamageToModule,
  buildOverloadEffectState,
  burnOutModuleOnActivation,
  clearPendingOverloadModuleTransition,
  deactivateBurnedOutModuleEffect,
  ensureEntityOverloadModuleEffects,
  ensureEntityPendingOverloadModuleEffects,
  ensureEntityRackHeatState,
  getModuleHeatAbsorbtionRate,
  getModuleOverloadEffectRecord,
  getModuleStructureHitpoints,
  getOverloadRackModuleItems,
  getRackFamilyForFlagID,
  getRackHeatIncomingRate,
  getShipHeatTypeID,
  getThermodynamicsHeatDamageMultiplier,
  isEmergencyHullEnergizerEffect,
  isMiningModuleItem,
  isModuleIncapacitated,
  isModuleOverloadCycling,
  isOverloadEffectRecord,
  notifyEntityRackHeatSourcesToOwner,
  notifyEntityRackHeatToOwner,
  notifyModuleDamageChangeToSession,
  readEntityRackHeat,
  readStoredShipRackHeat,
  repairEntityFittedModules,
  resetEntityRackHeat,
  replaceRuntimeFittedModuleSnapshot,
  settlePendingOverloadModuleTransition,
  stopOverloadStateForUnavailableModule,
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
  normalizeStoredRackHeat,
  withStoredRackHeat,
} = require(path.join(runtimeEntryDirname, "../services/inventory/shipRackHeatState"));
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
  buildAttributeChange,
  notifyAttributeChanges,
} = require("./attributeChangeNotification");
const {
  isReadyForDestiny,
} = require("./destinyDeliveryEligibility");
const {
  queueDogmaEvent,
} = require("./dogmaEvents");
const {
  ATTRIBUTE_HEAT_DAMAGE,
  ATTRIBUTE_ITEM_DAMAGE,
  ATTRIBUTE_THERMODYNAMICS_HEAT_DAMAGE,
} = require("./dogmaAttributeIds");
const {
  getEntityRuntimeFittedItems,
  getEntityRuntimeShipItem,
  getEntityRuntimeSkillMap,
  getSkillLevel,
} = require("./entityDogmaView");
const {
  getOwningSessionForEntity,
} = require("./entityOwnerSession");
const {
  notifyGenericModuleEffectState,
} = require("./godmaShipEffectNotification");
const {
  finalizeGenericModuleDeactivationWithoutSession,
  finalizePropulsionModuleDeactivationWithoutSession,
} = require("./moduleEffectShutdown");
const {
  clamp,
  roundNumber,
  toFiniteNumber,
  toInt,
} = require("../../common/numbers");
const { random } = require("../../common/random");
const {
  isPropulsionModuleEffectState,
} = require("./propulsionModule");
const {
  resolveSessionNotificationFileTime,
} = require("./sessionNotificationTime");
const {
  getTypeDogmaAttributeValueByID,
} = require("./typeAttributeLookup");

const OVERLOAD_EFFECT_CATEGORY_ID = 5;

// TQ parity: mining modules have no heat system. They cannot be overloaded and
// they never take heat damage, so they stay out of every overload/heat path.
const ATTRIBUTE_MINING_AMOUNT_FOR_HEAT = getAttributeIDByNames("miningAmount") || 77;

const MINING_EFFECT_NAMES_FOR_HEAT = Object.freeze(new Set([
  "mininglaser",
  "miningclouds",
]));

function isMiningModuleItem(moduleItem) {
  const typeID = toInt(moduleItem && moduleItem.typeID, 0);
  if (typeID <= 0) {
    return false;
  }

  const hasMiningEffect = getTypeEffectRecords(typeID).some((effectRecord) => (
    MINING_EFFECT_NAMES_FOR_HEAT.has(
      String(effectRecord && effectRecord.name || "").trim().toLowerCase(),
    )
  ));
  if (hasMiningEffect) {
    return true;
  }

  return toFiniteNumber(
    getTypeDogmaAttributeValueByID(typeID, ATTRIBUTE_MINING_AMOUNT_FOR_HEAT, 0),
    0,
  ) > 0;
}

function isOverloadEffectRecord(effectRecord) {
  return toInt(effectRecord && effectRecord.effectCategoryID, 0) ===
    OVERLOAD_EFFECT_CATEGORY_ID;
}

function getModuleOverloadEffectRecord(moduleItem, requestedEffectID = 0) {
  const typeID = toInt(moduleItem && moduleItem.typeID, 0);
  if (typeID <= 0 || isMiningModuleItem(moduleItem)) {
    return null;
  }

  const availableEffectIDs = getTypeDogmaEffects(typeID);
  const normalizedRequestedEffectID = toInt(requestedEffectID, 0);
  if (normalizedRequestedEffectID > 0) {
    const requestedRecord = getEffectTypeRecord(normalizedRequestedEffectID);
    return requestedRecord &&
      availableEffectIDs.has(normalizedRequestedEffectID) &&
      isOverloadEffectRecord(requestedRecord)
      ? requestedRecord
      : null;
  }

  return getTypeEffectRecords(typeID).find(isOverloadEffectRecord) || null;
}

function ensureEntityOverloadModuleEffects(entity) {
  if (!entity) {
    return null;
  }
  if (!(entity.overloadModuleEffects instanceof Map)) {
    entity.overloadModuleEffects = new Map();
  }
  return entity.overloadModuleEffects;
}

// TQ parity: overload is not a switch the pilot throws on a running module, it
// is an effect the server starts as part of a cycle start. EVE University's
// Overheating page: "A module that's already active and receives an overheat
// command won't begin overheating until it starts its next cycle. A module
// that's already overheating that's commanded to stop won't cease overheating
// until the end of its current cycle." The client's own dogma agrees — the
// overload effect is started from `_StartEffect`
// (`PossiblyStartOverloadingEffects`), never by the user, and `godma` parks the
// module in `pendingOverloading` / `pendingStopOverloading` and flashes the
// green light until the server publishes the effect. So a request that lands
// mid-cycle is held here and settled at the module's next cycle boundary; only
// a module that is not cycling flips immediately (the pilot "pre-heating" a
// module so its first cycle runs hot).
function ensureEntityPendingOverloadModuleEffects(entity) {
  if (!entity) {
    return null;
  }
  if (!(entity.pendingOverloadModuleEffects instanceof Map)) {
    entity.pendingOverloadModuleEffects = new Map();
  }
  return entity.pendingOverloadModuleEffects;
}

function clearPendingOverloadModuleTransition(entity, moduleID) {
  if (!entity || !(entity.pendingOverloadModuleEffects instanceof Map)) {
    return false;
  }
  return entity.pendingOverloadModuleEffects.delete(toInt(moduleID, 0));
}

function getRackFamilyForFlagID(flagID) {
  const normalizedFlagID = toInt(flagID, 0);
  if (normalizedFlagID <= 0) {
    return null;
  }

  for (const [family, flags] of Object.entries(SLOT_FAMILY_FLAGS || {})) {
    if (
      (family === "high" || family === "med" || family === "low") &&
      Array.isArray(flags) &&
      flags.includes(normalizedFlagID)
    ) {
      return family;
    }
  }

  return null;
}

function getOverloadRackModuleItems(entity, anchorModuleItem) {
  const rackFamily = getRackFamilyForFlagID(anchorModuleItem && anchorModuleItem.flagID);
  const rackFlags = rackFamily ? SLOT_FAMILY_FLAGS[rackFamily] : null;
  if (!entity || !Array.isArray(rackFlags)) {
    return [];
  }

  return getEntityRuntimeFittedItems(entity)
    .filter((moduleItem) => (
      moduleItem &&
      rackFlags.includes(toInt(moduleItem.flagID, 0)) &&
      isModuleOnline(moduleItem) &&
      getModuleOverloadEffectRecord(moduleItem)
    ))
    .sort((a, b) => toInt(a.flagID, 0) - toInt(b.flagID, 0));
}

function buildOverloadEffectState(moduleItem, effectRecord, nowMs) {
  return {
    moduleID: toInt(moduleItem && moduleItem.itemID, 0),
    moduleFlagID: toInt(moduleItem && moduleItem.flagID, 0),
    effectName: String(effectRecord && effectRecord.name || ""),
    effectID: toInt(effectRecord && effectRecord.effectID, 0),
    effectCategoryID: OVERLOAD_EFFECT_CATEGORY_ID,
    groupID: toInt(moduleItem && moduleItem.groupID, 0),
    typeID: toInt(moduleItem && moduleItem.typeID, 0),
    startedAtMs: Math.max(0, toFiniteNumber(nowMs, Date.now())),
    durationMs: -1,
    repeat: -1,
    targetID: 0,
    chargeTypeID: 0,
    isGeneric: true,
    isOverload: true,
  };
}

const TYPE_THERMODYNAMICS = 28164;

function isModuleIncapacitated(moduleItem) {
  if (!moduleItem || typeof moduleItem !== "object") {
    return false;
  }
  if (moduleItem.moduleState && moduleItem.moduleState.incapacitated === true) {
    return true;
  }
  return clamp(toFiniteNumber(
    moduleItem.moduleState && moduleItem.moduleState.damage,
    0,
  ), 0, 1) >= 1;
}

function getModuleStructureHitpoints(moduleItem) {
  const typeID = toInt(moduleItem && moduleItem.typeID, 0);
  const structureHP = Math.max(
    0,
    toFiniteNumber(getTypeAttributeValue(typeID, "hp", "structureHP"), 0),
  );
  return structureHP > 0 ? structureHP : 40;
}

function getThermodynamicsHeatDamageMultiplier(skillMap) {
  const thermodynamicsLevel = getSkillLevel(skillMap, TYPE_THERMODYNAMICS);
  if (thermodynamicsLevel <= 0) {
    return 1;
  }

  const thermodynamicsAttributes = buildEffectiveItemAttributeMap(TYPE_THERMODYNAMICS);
  const perLevelBonus = toFiniteNumber(
    thermodynamicsAttributes[ATTRIBUTE_THERMODYNAMICS_HEAT_DAMAGE],
    -5,
  );
  return Math.max(0, 1 + ((perLevelBonus * thermodynamicsLevel) / 100));
}

// ---------------------------------------------------------------------------
// Rack heat model (TQ parity).
//
// Each of the high/med/low racks carries a heat level 0..heatCapacity (100).
// Heat builds toward capacity while any overloaded module in the rack is
// actively cycling, dissipates otherwise, and every overloaded cycle
// completion rolls probabilistic heat damage against every module in the
// rack: chance = rackHeatFraction * attenuation^slotDistance, damage = the
// cycling module's heatDamage HP (Thermodynamics-reduced).  The client heat
// gauges are driven by the ship heatHi/heatMed/heatLow attributes.
// ---------------------------------------------------------------------------

const ATTRIBUTE_HEAT_GENERATION_MULTIPLIER =
  getAttributeIDByNames("heatGenerationMultiplier") || 1224;

const ATTRIBUTE_HEAT_ABSORBTION_RATE_MODIFIER =
  getAttributeIDByNames("heatAbsorbtionRateModifier") || 1180;

const RACK_HEAT_FAMILY_ATTRIBUTES = Object.freeze({
  high: Object.freeze({
    gaugeAttributeID: getAttributeIDByNames("heatHi") || 1175,
    capacityAttributeID: getAttributeIDByNames("heatCapacityHi") || 1178,
    dissipationAttributeID: getAttributeIDByNames("heatDissipationRateHi") || 1179,
    attenuationAttributeID: getAttributeIDByNames("heatAttenuationHi") || 1259,
  }),
  med: Object.freeze({
    gaugeAttributeID: getAttributeIDByNames("heatMed") || 1176,
    capacityAttributeID: getAttributeIDByNames("heatCapacityMed") || 1199,
    dissipationAttributeID: getAttributeIDByNames("heatDissipationRateMed") || 1196,
    attenuationAttributeID: getAttributeIDByNames("heatAttenuationMed") || 1261,
  }),
  low: Object.freeze({
    gaugeAttributeID: getAttributeIDByNames("heatLow") || 1177,
    capacityAttributeID: getAttributeIDByNames("heatCapacityLow") || 1200,
    dissipationAttributeID: getAttributeIDByNames("heatDissipationRateLow") || 1198,
    attenuationAttributeID: getAttributeIDByNames("heatAttenuationLow") || 1262,
  }),
});

const CHARGE_CATEGORY_ID_FOR_HEAT = 8;

const DEFAULT_RACK_HEAT_CAPACITY = 100;

const DEFAULT_RACK_HEAT_DISSIPATION_RATE = 0.01;

const DEFAULT_RACK_HEAT_ATTENUATION = 0.63;

const RACK_HEAT_NOTIFY_MIN_DELTA = 1;

const RACK_HEAT_NOTIFY_INTERVAL_MS = 5_000;

const RACK_HEAT_NOTIFY_INTERVAL_MIN_DELTA = 0.2;

const RACK_HEAT_MAX_ADVANCE_SECONDS = 60;

function ensureEntityRackHeatState(entity) {
  if (!entity) {
    return null;
  }
  if (!entity.rackHeatState || typeof entity.rackHeatState !== "object") {
    entity.rackHeatState = {
      levels: { high: 0, med: 0, low: 0 },
      notifiedLevels: { high: 0, med: 0, low: 0 },
      updatedAtMs: 0,
      lastNotifyAtMs: 0,
    };
    // The heat that was stored with the ship, cooled by the time since, is the
    // entity's own from here on (see takeUpStoredRackHeat).
    const storedHeat = entity.conditionState && entity.conditionState.heat;
    if (storedHeat) {
      entity.conditionState = withStoredRackHeat(entity.conditionState, null);
      const levels = ageStoredRackHeat(storedHeat, getShipHeatTypeID(entity), Date.now());
      if (levels) {
        Object.assign(entity.rackHeatState.levels, levels);
      }
    }
  }
  return entity.rackHeatState;
}

function getShipHeatTypeID(entity) {
  const shipItem = getEntityRuntimeShipItem(entity);
  return toInt(shipItem && shipItem.typeID, toInt(entity && entity.typeID, 0));
}

// How fast one overloaded module drives its rack, per second.
//
// TQ contract, verbatim from the client: clientDogmaLocation.OnHeatAdded
// ModAdds the module's own `heatAbsorbtionRateModifier` (1180) into the rack
// heat attribute's `incomingHeat`, and heatAttribute.CalculateHeat then runs
// the rack at `incomingHeat * heatGenerationMultiplier`. The attribute takes
// three values across the 2074 published overheatable types — 0.01 for T1,
// meta, faction, deadspace and officer, 0.02 for T2, 0.04 for propulsion
// modules — and nothing in the SDE modifies it, so the type value is the
// live value.
function getModuleHeatAbsorbtionRate(moduleTypeID) {
  const typeID = toInt(moduleTypeID, 0);
  if (typeID <= 0) {
    return 0;
  }
  return Math.max(
    0,
    toFiniteNumber(
      getTypeDogmaAttributeValueByID(
        typeID,
        ATTRIBUTE_HEAT_ABSORBTION_RATE_MODIFIER,
        0,
      ),
      0,
    ),
  );
}

// The modules that are heating a rack right now, each with the rack it heats.
function listRackHeatSources(entity) {
  const sources = [];
  if (
    !(entity.activeModuleEffects instanceof Map) ||
    entity.activeModuleEffects.size <= 0 ||
    !(entity.overloadModuleEffects instanceof Map) ||
    entity.overloadModuleEffects.size <= 0
  ) {
    return sources;
  }
  // TQ parity: heat follows the overloaded CYCLE — a rack only builds heat
  // while an overloaded module in it is actively cycling, not merely while
  // the overload toggle is lit on an idle module.
  for (const effectState of entity.activeModuleEffects.values()) {
    if (!effectState) {
      continue;
    }
    const moduleID = toInt(effectState.moduleID, 0);
    const overloadState = entity.overloadModuleEffects.get(moduleID);
    const family = overloadState
      ? getRackFamilyForFlagID(effectState.moduleFlagID)
      : null;
    if (!family) {
      continue;
    }
    sources.push({
      moduleID,
      family,
      typeID: toInt(overloadState.typeID, 0) || toInt(effectState.typeID, 0),
    });
  }
  return sources;
}

// The rack's incoming heat is the SUM of those rates, not a flag: four
// overloaded modules in one rack heat it four times as fast as one, and a T2
// module twice as fast as its T1 sibling.
function getRackHeatIncomingRate(entity, family) {
  let incomingRate = 0;
  for (const source of listRackHeatSources(entity)) {
    if (source.family === family) {
      incomingRate += getModuleHeatAbsorbtionRate(source.typeID);
    }
  }
  return incomingRate;
}

// A ship's heat stays with the ship when the ship leaves space, and goes on
// cooling while nothing works it out: Tranquility's answer for a docked Caracal
// has 17.14 in its medium rack sixteen seconds after the rack stopped heating
// ("Cargo Delivery" recording). It is kept with the ship's stored condition
// (services/inventory/shipRackHeatState.js) as it was at a time by the wall
// clock.
//
// What each rack stored so holds at nowMs, by rack family, cooled as a rack in
// space cools; null where every rack is cold by now.
function ageStoredRackHeat(storedHeat, shipTypeID, nowMs) {
  const stored = normalizeStoredRackHeat(storedHeat);
  if (!stored) {
    return null;
  }
  const seconds = Math.max(0, (toFiniteNumber(nowMs, 0) - stored.atMs) / 1000);
  const levels = {};
  for (const [family, familyAttributes] of Object.entries(RACK_HEAT_FAMILY_ATTRIBUTES)) {
    levels[family] = coolRackHeat(
      stored[family],
      getRackHeatDissipationRate(shipTypeID, familyAttributes),
      seconds,
    );
  }
  return Object.values(levels).some((level) => level > 0) ? levels : null;
}

// A ship entity takes up the heat that was stored with its ship. The entity is
// built with the ship's stored condition and the heat's part in it, and has no
// rackHeatState until something asks for one; making it (ensureEntityRackHeatState)
// brings the stored heat in, cooled by the time since. From there on the heat is
// the entity's own, and the persistence writes it back from the state.
//
// An entity that is warm from the store and has no state yet is given one here:
// called by whoever reads or advances an entity's heat.
function takeUpStoredRackHeat(entity) {
  if (
    entity &&
    entity.kind === "ship" &&
    !entity.rackHeatState &&
    entity.conditionState &&
    entity.conditionState.heat
  ) {
    ensureEntityRackHeatState(entity);
  }
}

// What was stored with a ship that is not in space, as readEntityRackHeat tells
// an entity's: each rack's heat at nowMs by the rack's heat attribute, with
// nothing heating it. Null for a ship that is cold.
function readStoredShipRackHeat(shipItem, nowMs = Date.now()) {
  const levels = ageStoredRackHeat(
    shipItem && shipItem.conditionState && shipItem.conditionState.heat,
    toInt(shipItem && shipItem.typeID, 0),
    nowMs,
  );
  if (!levels) {
    return null;
  }
  const rackHeat = {};
  for (const [family, familyAttributes] of Object.entries(RACK_HEAT_FAMILY_ATTRIBUTES)) {
    rackHeat[familyAttributes.gaugeAttributeID] = {
      heat: levels[family],
      incomingHeat: 0,
    };
  }
  return rackHeat;
}

// What each rack of a ship holds now and what is heating it, by the rack's heat
// attribute: the two of a rack's entry in the heat part of the ship's state
// that are not the ship's attributes (services/dogma/activationHeatState.js).
// Null for anything that is not a ship in space.
function readEntityRackHeat(entity) {
  if (!entity || entity.kind !== "ship") {
    return null;
  }
  takeUpStoredRackHeat(entity);
  const levels = (entity.rackHeatState && entity.rackHeatState.levels) || {};
  const rackHeat = {};
  for (const [family, familyAttributes] of Object.entries(RACK_HEAT_FAMILY_ATTRIBUTES)) {
    rackHeat[familyAttributes.gaugeAttributeID] = {
      heat: Math.max(0, toFiniteNumber(levels[family], 0)),
      incomingHeat: getRackHeatIncomingRate(entity, family),
    };
  }
  return rackHeat;
}

function isModuleOverloadCycling(entity, moduleID) {
  const normalizedModuleID = toInt(moduleID, 0);
  return (
    normalizedModuleID > 0 &&
    entity &&
    entity.activeModuleEffects instanceof Map &&
    entity.activeModuleEffects.has(normalizedModuleID) &&
    entity.overloadModuleEffects instanceof Map &&
    entity.overloadModuleEffects.has(normalizedModuleID)
  );
}

// A rack's dissipation rate, per second: the ship type's own.
function getRackHeatDissipationRate(shipTypeID, familyAttributes) {
  return Math.max(
    0,
    toFiniteNumber(
      getTypeDogmaAttributeValueByID(
        shipTypeID,
        familyAttributes.dissipationAttributeID,
        DEFAULT_RACK_HEAT_DISSIPATION_RATE,
      ),
      DEFAULT_RACK_HEAT_DISSIPATION_RATE,
    ),
  );
}

// What a rack that nothing heats holds after so many seconds, as the client
// reckons it (heatAttribute.py, CalculateHeat): heat * exp(-seconds * rate), and
// nought once that rounds to nought.
function coolRackHeat(level, dissipationRate, seconds) {
  const cooled = level * Math.exp(-dissipationRate * seconds);
  return Math.round(cooled) <= 0 ? 0 : cooled;
}

function advanceEntityRackHeat(scene, entity, nowMs, options = {}) {
  if (!entity || entity.kind !== "ship") {
    return;
  }
  takeUpStoredRackHeat(entity);
  // Every tick comes through here, so whichever way a module stopped or
  // started heating, the pilot has been told by the time its heat is next
  // worked out.
  notifyEntityRackHeatSourcesToOwner(scene, entity);
  // Cycle handlers may finalize an effect (depletion, target loss) before the
  // owed heat settles; the caller then vouches that this rack's overloaded
  // cycle was running for the elapsed window even though the effect is gone.
  // A vouched module carries its own incoming rate, and it is added only when
  // the live scan can no longer see it — otherwise the same module would heat
  // its rack twice.
  const forcedGeneratingModules = Array.isArray(options.forceGeneratingModules)
    ? options.forceGeneratingModules
    : [];
  const hasOverloads =
    entity.overloadModuleEffects instanceof Map &&
    entity.overloadModuleEffects.size > 0;
  const existingState =
    entity.rackHeatState && typeof entity.rackHeatState === "object"
      ? entity.rackHeatState
      : null;
  const hasResidualHeat =
    existingState &&
    (
      toFiniteNumber(existingState.levels && existingState.levels.high, 0) > 0 ||
      toFiniteNumber(existingState.levels && existingState.levels.med, 0) > 0 ||
      toFiniteNumber(existingState.levels && existingState.levels.low, 0) > 0
    );
  if (!hasOverloads && !hasResidualHeat) {
    if (existingState) {
      existingState.updatedAtMs = nowMs;
    }
    return;
  }

  const heatState = ensureEntityRackHeatState(entity);
  const previousUpdatedAtMs = toFiniteNumber(heatState.updatedAtMs, 0);
  if (previousUpdatedAtMs <= 0) {
    heatState.updatedAtMs = nowMs;
    return;
  }
  // Cycle boundaries are processed after the fact; never move the heat clock
  // backwards or the next tick would re-apply time that already elapsed.
  if (nowMs <= previousUpdatedAtMs) {
    return;
  }
  heatState.updatedAtMs = nowMs;
  const deltaSeconds = Math.min(
    (nowMs - previousUpdatedAtMs) / 1000,
    RACK_HEAT_MAX_ADVANCE_SECONDS,
  );

  const shipTypeID = getShipHeatTypeID(entity);
  const generationMultiplier = Math.max(
    0,
    toFiniteNumber(
      getTypeDogmaAttributeValueByID(shipTypeID, ATTRIBUTE_HEAT_GENERATION_MULTIPLIER, 1),
      1,
    ),
  );
  for (const [family, familyAttributes] of Object.entries(RACK_HEAT_FAMILY_ATTRIBUTES)) {
    const capacity = Math.max(
      1,
      toFiniteNumber(
        getTypeDogmaAttributeValueByID(
          shipTypeID,
          familyAttributes.capacityAttributeID,
          DEFAULT_RACK_HEAT_CAPACITY,
        ),
        DEFAULT_RACK_HEAT_CAPACITY,
      ),
    );
    const previousLevel = clamp(toFiniteNumber(heatState.levels[family], 0), 0, capacity);
    let nextLevel = previousLevel;
    let incomingRate = getRackHeatIncomingRate(entity, family);
    for (const forcedModule of forcedGeneratingModules) {
      if (
        !forcedModule ||
        forcedModule.family !== family ||
        isModuleOverloadCycling(entity, forcedModule.moduleID)
      ) {
        continue;
      }
      incomingRate += Math.max(0, toFiniteNumber(forcedModule.incomingRate, 0));
    }
    if (incomingRate > 0) {
      const generationRate = incomingRate * generationMultiplier;
      nextLevel =
        capacity - (capacity - previousLevel) * Math.exp(-generationRate * deltaSeconds);
    } else if (previousLevel > 0) {
      nextLevel = coolRackHeat(
        previousLevel,
        getRackHeatDissipationRate(shipTypeID, familyAttributes),
        deltaSeconds,
      );
    }
    heatState.levels[family] = nextLevel;
  }
  notifyEntityRackHeatToOwner(scene, entity, nowMs);
}

function notifyEntityRackHeatToOwner(scene, entity, whenMs, options = {}) {
  const heatState = entity && entity.rackHeatState;
  if (!heatState) {
    return false;
  }
  const ownerSession = getOwningSessionForEntity(scene, entity);
  if (!ownerSession || !isReadyForDestiny(ownerSession)) {
    return false;
  }
  const force = options.force === true;
  const intervalDue =
    toFiniteNumber(whenMs, 0) - toFiniteNumber(heatState.lastNotifyAtMs, 0) >=
    RACK_HEAT_NOTIFY_INTERVAL_MS;
  const shipID = toInt(entity.itemID, 0);
  const when = resolveSessionNotificationFileTime(ownerSession, whenMs);
  const changes = [];
  for (const [family, familyAttributes] of Object.entries(RACK_HEAT_FAMILY_ATTRIBUTES)) {
    const level = toFiniteNumber(heatState.levels[family], 0);
    const notifiedLevel = toFiniteNumber(heatState.notifiedLevels[family], 0);
    const delta = Math.abs(level - notifiedLevel);
    const zeroedOut = level <= 0 && notifiedLevel > 0;
    const due =
      force ||
      zeroedOut ||
      delta >= RACK_HEAT_NOTIFY_MIN_DELTA ||
      (intervalDue && delta >= RACK_HEAT_NOTIFY_INTERVAL_MIN_DELTA);
    if (!due) {
      continue;
    }
    heatState.notifiedLevels[family] = level;
    changes.push(buildAttributeChange(
      ownerSession,
      shipID,
      familyAttributes.gaugeAttributeID,
      roundNumber(level, 3),
      null,
      when,
    ));
  }
  if (changes.length <= 0) {
    return false;
  }
  heatState.lastNotifyAtMs = toFiniteNumber(whenMs, 0);
  return notifyAttributeChanges(ownerSession, changes);
}

// Between the gauge values above, the owner's client works each rack's heat
// out for itself, and it only carries a rack upward for the modules it has
// been told are heating it: its clientDogmaLocation.OnHeatAdded puts a
// module's heatAbsorbtionRateModifier on the rack's incoming heat, and
// OnHeatRemoved takes it off again. Told nothing, it cools a rack the server
// is heating.
//
// So the pilot is told as modules enter and leave the set
// getRackHeatIncomingRate sums, once each way; entity.rackHeatSourcesTold is
// what his client then holds. It belongs to one space generation of one pilot
// (session._space): a pilot who boards a hull that is still heating has been
// told nothing yet.
//
// `ownerLeaving` is the pilot going out of the ship's ballpark. His client may
// go on holding the ship item it has (it only builds a new one when it changes
// ship, not when the same ship docks or jumps), so it is told that everything
// it holds has stopped; what a pilot who can no longer be reached was told is
// dropped unsaid. A module that has left the ship is dropped unsaid too, since
// both client handlers look it up among the items the client has loaded, and
// the client unloaded it when it moved.
//
// Both are Dogma events, queued with queueDogmaEvent: they leave from the next
// doPostTick in the owner's Character batch,
// and nothing here is sent directly. The `ownerLeaving` clear comes from
// Scene feature hooks' session-leaving point, while the pilot is still an
// Observer, so it leaves in his Character batch or his final flush.
function notifyEntityRackHeatSourcesToOwner(scene, entity, options = {}) {
  if (!entity || entity.kind !== "ship") {
    return false;
  }
  const sources = options.ownerLeaving === true ? [] : listRackHeatSources(entity);
  const previouslyTold = entity.rackHeatSourcesTold || null;
  if (!previouslyTold && sources.length <= 0) {
    return false;
  }

  const ownerSession = getOwningSessionForEntity(scene, entity);
  const spaceGeneration =
    ownerSession && isReadyForDestiny(ownerSession)
      ? ownerSession._space
      : null;
  if (!spaceGeneration) {
    entity.rackHeatSourcesTold = null;
    return false;
  }

  const toldState =
    previouslyTold && previouslyTold.spaceGeneration === spaceGeneration
      ? previouslyTold
      : { spaceGeneration, modules: new Map() };
  const told = toldState.modules;
  // The common tick: the same modules are heating as when he was last told.
  const unchanged =
    told.size === sources.length &&
    sources.every((source) => (
      told.get(source.moduleID) ===
        RACK_HEAT_FAMILY_ATTRIBUTES[source.family].gaugeAttributeID
    ));
  let notified = false;
  if (!unchanged) {
    const fittedModuleIDs = new Set(
      getEntityRuntimeFittedItems(entity)
        .map((moduleItem) => toInt(moduleItem && moduleItem.itemID, 0)),
    );
    const heating = new Map();
    for (const source of sources) {
      if (fittedModuleIDs.has(source.moduleID)) {
        heating.set(
          source.moduleID,
          RACK_HEAT_FAMILY_ATTRIBUTES[source.family].gaugeAttributeID,
        );
      }
    }
    for (const [moduleID, heatID] of told) {
      if (heating.get(moduleID) === heatID) {
        continue;
      }
      told.delete(moduleID);
      if (fittedModuleIDs.has(moduleID)) {
        queueDogmaEvent(ownerSession, "OnHeatRemoved", [heatID, moduleID]);
        notified = true;
      }
    }
    for (const [moduleID, heatID] of heating) {
      if (told.has(moduleID)) {
        continue;
      }
      told.set(moduleID, heatID);
      queueDogmaEvent(ownerSession, "OnHeatAdded", [heatID, moduleID]);
      notified = true;
    }
  }
  entity.rackHeatSourcesTold = told.size > 0 ? toldState : null;
  return notified;
}

function resetEntityRackHeat(scene, entity, whenMs = null) {
  if (!entity || entity.kind !== "ship") {
    return false;
  }

  const heatState = ensureEntityRackHeatState(entity);
  const hadHeat = Object.values(heatState.levels).some(
    (level) => toFiniteNumber(level, 0) > 0,
  );
  heatState.levels.high = 0;
  heatState.levels.med = 0;
  heatState.levels.low = 0;
  const nowMs = Math.max(
    0,
    toFiniteNumber(
      whenMs,
      scene && typeof scene.getCurrentSimTimeMs === "function"
        ? scene.getCurrentSimTimeMs()
        : 0,
    ),
  );
  heatState.updatedAtMs = nowMs;
  notifyEntityRackHeatToOwner(scene, entity, nowMs, { force: true });
  return hadHeat;
}

function deactivateBurnedOutModuleEffect(scene, entity, moduleID, whenMs) {
  if (!(entity && entity.activeModuleEffects instanceof Map)) {
    return false;
  }
  const normalizedModuleID = toInt(moduleID, 0);
  const effectState = entity.activeModuleEffects.get(normalizedModuleID) || null;
  if (!effectState) {
    return false;
  }
  const ownerSession = getOwningSessionForEntity(scene, entity);
  const isPropulsion =
    isPropulsionModuleEffectState(effectState) && effectState.isGeneric !== true;
  if (ownerSession && isReadyForDestiny(ownerSession)) {
    if (isPropulsion) {
      scene.finalizePropulsionModuleDeactivation(ownerSession, normalizedModuleID, {
        reason: "heat",
        nowMs: whenMs,
      });
    } else {
      scene.finalizeGenericModuleDeactivation(ownerSession, normalizedModuleID, {
        reason: "heat",
        nowMs: whenMs,
      });
    }
  } else if (isPropulsion) {
    finalizePropulsionModuleDeactivationWithoutSession(scene, entity, effectState, {
      reason: "heat",
      nowMs: whenMs,
    });
  } else if (effectState.isGeneric === true) {
    finalizeGenericModuleDeactivationWithoutSession(scene, entity, effectState, {
      reason: "heat",
      nowMs: whenMs,
    });
  } else {
    entity.activeModuleEffects.delete(normalizedModuleID);
  }
  return true;
}

function replaceRuntimeFittedModuleSnapshot(entity, updatedModuleItem) {
  if (
    !entity ||
    !updatedModuleItem ||
    !Array.isArray(entity.fittedItems)
  ) {
    return false;
  }

  const moduleID = toInt(updatedModuleItem.itemID, 0);
  if (moduleID <= 0) {
    return false;
  }

  let changed = false;
  entity.fittedItems = entity.fittedItems.map((candidate) => {
    if (toInt(candidate && candidate.itemID, 0) !== moduleID) {
      return candidate;
    }
    changed = true;
    return {
      ...candidate,
      ...updatedModuleItem,
      moduleState: {
        ...(candidate && candidate.moduleState ? candidate.moduleState : {}),
        ...(updatedModuleItem.moduleState || {}),
      },
    };
  });
  return changed;
}

function notifyModuleDamageChangeToSession(
  session,
  moduleItem,
  nextDamageRatio,
  previousDamageRatio,
  whenMs = null,
) {
  if (!session || !moduleItem) {
    return false;
  }

  const structureHP = getModuleStructureHitpoints(moduleItem);
  const when = resolveSessionNotificationFileTime(session, whenMs);
  return notifyAttributeChanges(session, [buildAttributeChange(
    session,
    toInt(moduleItem.itemID, 0),
    ATTRIBUTE_ITEM_DAMAGE,
    roundNumber(structureHP * clamp(toFiniteNumber(nextDamageRatio, 0), 0, 1), 6),
    roundNumber(structureHP * clamp(toFiniteNumber(previousDamageRatio, 0), 0, 1), 6),
    when,
  )]);
}

function repairEntityFittedModules(entity, options = {}) {
  if (!entity || entity.kind !== "ship") {
    return [];
  }

  const session = options.session || entity.session || null;
  const whenMs = Object.prototype.hasOwnProperty.call(options, "whenMs")
    ? options.whenMs
    : null;
  const repairedModuleIDs = [];
  const selectedIDs = Array.isArray(options.moduleIDs) ? new Set(options.moduleIDs.map(Number)) : null;
  for (const moduleItem of getEntityRuntimeFittedItems(entity)) {
    if (selectedIDs && !selectedIDs.has(Number(moduleItem.itemID))) continue;
    const moduleState =
      moduleItem && moduleItem.moduleState && typeof moduleItem.moduleState === "object"
        ? moduleItem.moduleState
        : null;
    if (!moduleState) {
      continue;
    }
    const previousDamage = clamp(toFiniteNumber(moduleState.damage, 0), 0, 1);
    const needsRepair =
      previousDamage > 0 ||
      toFiniteNumber(moduleState.armorDamage, 0) > 0 ||
      toFiniteNumber(moduleState.shieldCharge, 1) < 1 ||
      moduleState.incapacitated === true;
    if (!needsRepair) {
      continue;
    }

    const updateResult = updateInventoryItem(moduleItem.itemID, (currentItem) => ({
      ...currentItem,
      moduleState: {
        ...(currentItem.moduleState || {}),
        damage: 0,
        armorDamage: 0,
        shieldCharge: 1,
        incapacitated: false,
      },
    }));
    if (!updateResult || updateResult.success !== true) {
      continue;
    }

    const updatedModuleItem = updateResult.data || {
      ...moduleItem,
      moduleState: {
        ...(moduleItem.moduleState || {}),
        damage: 0,
        armorDamage: 0,
        shieldCharge: 1,
        incapacitated: false,
      },
    };
    replaceRuntimeFittedModuleSnapshot(entity, updatedModuleItem);
    if (previousDamage > 0 && session && isReadyForDestiny(session)) {
      notifyModuleDamageChangeToSession(
        session,
        updatedModuleItem,
        0,
        previousDamage,
        whenMs,
      );
    }
    repairedModuleIDs.push(toInt(moduleItem.itemID, 0));
  }

  return repairedModuleIDs;
}

// Settle a held overload request at the moment its wait is over: the module's
// next cycle start, or — for a module the pilot switched off before that
// boundary arrived — the tick that finds it no longer cycling. Heat is advanced
// to that moment first so the cycle that ran cold (or hot) is charged at the
// rate it actually ran at, and the client only learns the overload effect
// started/stopped here, which is what turns its flashing indicator solid.
function settlePendingOverloadModuleTransition(scene, entity, moduleID, whenMs) {
  const normalizedModuleID = toInt(moduleID, 0);
  const pending =
    scene &&
    entity &&
    entity.pendingOverloadModuleEffects instanceof Map
      ? entity.pendingOverloadModuleEffects.get(normalizedModuleID) || null
      : null;
  if (!pending) {
    return {
      applied: false,
      active: false,
    };
  }

  entity.pendingOverloadModuleEffects.delete(normalizedModuleID);
  const overloadEffects = ensureEntityOverloadModuleEffects(entity);
  const active = pending.active === true;
  if (active === overloadEffects.has(normalizedModuleID)) {
    return {
      applied: false,
      active,
    };
  }

  advanceEntityRackHeat(scene, entity, whenMs);
  const effectState = active
    ? {
      ...pending.effectState,
      startedAtMs: toFiniteNumber(whenMs, 0),
    }
    : overloadEffects.get(normalizedModuleID) || pending.effectState;
  if (active) {
    overloadEffects.set(normalizedModuleID, effectState);
  } else {
    overloadEffects.delete(normalizedModuleID);
  }

  const ownerSession = getOwningSessionForEntity(scene, entity);
  if (ownerSession && isReadyForDestiny(ownerSession)) {
    notifyGenericModuleEffectState(ownerSession, entity, effectState, active, {
      whenMs,
      startTimeMs: toFiniteNumber(effectState.startedAtMs, whenMs),
      actualStopTimeMs: active ? null : whenMs,
    });
    notifyEntityRackHeatToOwner(scene, entity, whenMs, { force: true });
  }
  notifyEntityRackHeatSourcesToOwner(scene, entity);
  scene.refreshShipEntityDerivedState(entity, {
    session: ownerSession,
    notifyGenericModuleAttributes: true,
  });

  return {
    applied: true,
    active,
  };
}

function stopOverloadStateForUnavailableModule(scene, entity, moduleID, whenMs = null) {
  if (
    !scene ||
    !entity ||
    !(entity.overloadModuleEffects instanceof Map)
  ) {
    return false;
  }

  const normalizedModuleID = toInt(moduleID, 0);
  clearPendingOverloadModuleTransition(entity, normalizedModuleID);
  const overloadEffectState =
    entity.overloadModuleEffects.get(normalizedModuleID) || null;
  if (!overloadEffectState) {
    return false;
  }

  entity.overloadModuleEffects.delete(normalizedModuleID);
  const ownerSession = getOwningSessionForEntity(scene, entity);
  if (ownerSession && isReadyForDestiny(ownerSession)) {
    notifyGenericModuleEffectState(ownerSession, entity, overloadEffectState, false, {
      whenMs,
      actualStopTimeMs: whenMs,
    });
  }
  notifyEntityRackHeatSourcesToOwner(scene, entity);
  return true;
}

const EFFECT_NAME_EMERGENCY_HULL_ENERGIZER = "emergencyhullenergizer";

function isEmergencyHullEnergizerEffect(effectRecord) {
  return Boolean(effectRecord) &&
    String(effectRecord.name || "").toLowerCase() ===
      EFFECT_NAME_EMERGENCY_HULL_ENERGIZER;
}

// Wreck the module outright, the way the client's Start() does by assigning its
// own hp onto its damage. Routed through the heat-damage path so the burnout
// persists, marks the module incapacitated and reaches the client exactly as an
// overload burnout does — there is no second notion of a dead module to invent.
function burnOutModuleOnActivation(scene, entity, moduleItem, whenMs) {
  const structureHP = getModuleStructureHitpoints(moduleItem);
  if (!(structureHP > 0)) {
    return false;
  }
  const result = applyHeatDamageHPToModule(
    scene,
    entity,
    moduleItem,
    structureHP,
    whenMs,
  );
  return Boolean(result && result.success && result.data && result.data.burnedOut);
}

function applyHeatDamageHPToModule(scene, entity, moduleItem, damageHP, whenMs) {
  const moduleID = toInt(moduleItem && moduleItem.itemID, 0);
  if (!moduleItem || moduleID <= 0) {
    return {
      success: true,
      data: {
        damaged: false,
        burnedOut: false,
      },
    };
  }

  const structureHP = getModuleStructureHitpoints(moduleItem);
  const damageRatio = Math.max(0, toFiniteNumber(damageHP, 0) / structureHP);
  const previousDamage = clamp(toFiniteNumber(
    moduleItem.moduleState && moduleItem.moduleState.damage,
    0,
  ), 0, 1);
  const nextDamage = clamp(previousDamage + damageRatio, 0, 1);
  if (nextDamage <= previousDamage + 1e-9) {
    return {
      success: true,
      data: {
        damaged: false,
        burnedOut: false,
      },
    };
  }

  const burnedOut = nextDamage >= 1 - 1e-9;
  const updateResult = updateInventoryItem(moduleID, (currentItem) => ({
    ...currentItem,
    moduleState: {
      ...(currentItem.moduleState || {}),
      damage: nextDamage,
      incapacitated: burnedOut || (
        currentItem.moduleState &&
        currentItem.moduleState.incapacitated === true
      ),
    },
  }));
  if (!updateResult.success) {
    return updateResult;
  }

  const updatedModuleItem = updateResult.data || {
    ...moduleItem,
    moduleState: {
      ...(moduleItem.moduleState || {}),
      damage: nextDamage,
      incapacitated: burnedOut,
    },
  };
  replaceRuntimeFittedModuleSnapshot(entity, updatedModuleItem);

  const ownerSession = getOwningSessionForEntity(scene, entity);
  if (ownerSession && isReadyForDestiny(ownerSession)) {
    notifyModuleDamageChangeToSession(
      ownerSession,
      updatedModuleItem,
      nextDamage,
      previousDamage,
      whenMs,
    );
  }

  if (burnedOut) {
    stopOverloadStateForUnavailableModule(scene, entity, moduleID, whenMs);
  }

  return {
    success: true,
    data: {
      moduleItem: updatedModuleItem,
      moduleID,
      damaged: true,
      burnedOut,
      previousDamage,
      nextDamage,
    },
  };
}

function applyOverloadHeatDamageToModule(
  scene,
  entity,
  moduleItem,
  effectState,
  cycleBoundaryMs,
  options = {},
) {
  const moduleID = toInt(effectState && effectState.moduleID, 0);
  // The roll belongs to the cycle that just ended, so it follows the state that
  // cycle ran at, not the state the module is in now. They differ at exactly the
  // boundary where a held overload request settles: a cycle that ran cold rolls
  // nothing even though the module is hot from here on, and the last hot cycle
  // of a module the pilot switched back to normal still rolls.
  const overloadedForCompletedCycle =
    options.overloadedForCompletedCycle === undefined
      ? entity &&
        entity.overloadModuleEffects instanceof Map &&
        entity.overloadModuleEffects.has(moduleID)
      : options.overloadedForCompletedCycle === true;
  if (
    !scene ||
    !entity ||
    !moduleItem ||
    moduleID <= 0 ||
    !overloadedForCompletedCycle
  ) {
    return {
      success: true,
      data: {
        damaged: false,
        burnedOut: false,
      },
    };
  }

  // Bring the rack heat up to date before rolling damage for this cycle.
  // The completing module's own rack is vouched as generating: some cycle
  // handlers finalize the effect before the owed heat settles, which would
  // otherwise retroactively hide the just-completed overloaded cycle.
  const rackFamily = getRackFamilyForFlagID(moduleItem.flagID);
  // Cold-start backstop: if this entity's rack-heat clock has never advanced
  // (an overloaded module can complete its very first cycle before any tick or
  // overload-transition advance has warmed the clock — e.g. a repeat=0 cycle
  // that depletes its target), seed the clock to this cycle's start so the
  // forced advance below accrues heat for the overloaded cycle that just ran
  // instead of silently initializing to zero and rolling no damage.
  const coldStartHeatState = ensureEntityRackHeatState(entity);
  if (toFiniteNumber(coldStartHeatState.updatedAtMs, 0) <= 0) {
    const cycleDurationMs = Math.max(
      0,
      toFiniteNumber(effectState && effectState.durationMs, 0),
    );
    coldStartHeatState.updatedAtMs = Math.max(
      1,
      toFiniteNumber(cycleBoundaryMs, 0) - cycleDurationMs,
    );
  }
  advanceEntityRackHeat(scene, entity, cycleBoundaryMs, {
    forceGeneratingModules: rackFamily
      ? [{
        family: rackFamily,
        moduleID,
        incomingRate: getModuleHeatAbsorbtionRate(moduleItem.typeID),
      }]
      : [],
  });

  const moduleAttributes = buildEffectiveItemAttributeMap(moduleItem);
  const heatDamageHP = Math.max(
    0,
    toFiniteNumber(moduleAttributes[ATTRIBUTE_HEAT_DAMAGE], 0),
  );
  if (heatDamageHP <= 0) {
    return {
      success: true,
      data: {
        damaged: false,
        burnedOut: false,
      },
    };
  }
  const damageHP = heatDamageHP * getThermodynamicsHeatDamageMultiplier(
    getEntityRuntimeSkillMap(entity),
  );

  const familyAttributes = rackFamily
    ? RACK_HEAT_FAMILY_ATTRIBUTES[rackFamily]
    : null;
  const heatState = ensureEntityRackHeatState(entity);
  const shipTypeID = getShipHeatTypeID(entity);
  const capacity = familyAttributes
    ? Math.max(
      1,
      toFiniteNumber(
        getTypeDogmaAttributeValueByID(
          shipTypeID,
          familyAttributes.capacityAttributeID,
          DEFAULT_RACK_HEAT_CAPACITY,
        ),
        DEFAULT_RACK_HEAT_CAPACITY,
      ),
    )
    : DEFAULT_RACK_HEAT_CAPACITY;
  const heatFraction = clamp(
    toFiniteNumber(rackFamily ? heatState.levels[rackFamily] : 0, 0) / capacity,
    0,
    1,
  );
  if (heatFraction <= 0) {
    return {
      success: true,
      data: {
        damaged: false,
        burnedOut: false,
      },
    };
  }

  const attenuation = familyAttributes
    ? clamp(
      toFiniteNumber(
        getTypeDogmaAttributeValueByID(
          shipTypeID,
          familyAttributes.attenuationAttributeID,
          DEFAULT_RACK_HEAT_ATTENUATION,
        ),
        DEFAULT_RACK_HEAT_ATTENUATION,
      ),
      0,
      1,
    )
    : 0;
  const rackFlags = rackFamily ? SLOT_FAMILY_FLAGS[rackFamily] : null;
  const sourceSlotIndex = Array.isArray(rackFlags)
    ? rackFlags.indexOf(toInt(moduleItem.flagID, 0))
    : -1;

  // Every fitted module in the rack rolls against the heat level, with
  // splash falling off by slot distance (empty slots count for distance).
  const candidates = [];
  if (Array.isArray(rackFlags) && sourceSlotIndex >= 0) {
    for (const candidateItem of getEntityRuntimeFittedItems(entity)) {
      if (
        !candidateItem ||
        toInt(candidateItem.categoryID, 0) === CHARGE_CATEGORY_ID_FOR_HEAT ||
        // Mining modules have no heat system: they neither overload nor take
        // splash heat damage from an overloaded neighbour in the same rack.
        isMiningModuleItem(candidateItem)
      ) {
        continue;
      }
      const slotIndex = rackFlags.indexOf(toInt(candidateItem.flagID, 0));
      if (slotIndex < 0) {
        continue;
      }
      candidates.push({
        candidateItem,
        slotDistance: Math.abs(slotIndex - sourceSlotIndex),
      });
    }
  }
  if (candidates.length <= 0) {
    candidates.push({
      candidateItem: moduleItem,
      slotDistance: 0,
    });
  }

  const damagedModules = [];
  let cyclingModuleBurnedOut = false;
  for (const { candidateItem, slotDistance } of candidates) {
    if (isModuleIncapacitated(candidateItem)) {
      continue;
    }
    const chance = heatFraction * Math.pow(attenuation, slotDistance);
    if (chance <= 0 || random() >= chance) {
      continue;
    }
    const damageResult = applyHeatDamageHPToModule(
      scene,
      entity,
      candidateItem,
      damageHP,
      cycleBoundaryMs,
    );
    if (
      !damageResult.success ||
      !damageResult.data ||
      damageResult.data.damaged !== true
    ) {
      continue;
    }
    damagedModules.push(damageResult.data);
    if (damageResult.data.burnedOut === true) {
      const candidateModuleID = toInt(candidateItem.itemID, 0);
      if (candidateModuleID === moduleID) {
        // The cycling module's own deactivation is handled by the caller via
        // the burnedOut flag; deactivating it here would double-finalize.
        cyclingModuleBurnedOut = true;
      } else {
        deactivateBurnedOutModuleEffect(scene, entity, candidateModuleID, cycleBoundaryMs);
      }
    }
  }

  return {
    success: true,
    data: {
      damaged: damagedModules.length > 0,
      burnedOut: cyclingModuleBurnedOut,
      damagedModules,
    },
  };
}

Object.assign(module.exports, {
  ATTRIBUTE_HEAT_ABSORBTION_RATE_MODIFIER,
  ATTRIBUTE_HEAT_GENERATION_MULTIPLIER,
  ATTRIBUTE_MINING_AMOUNT_FOR_HEAT,
  CHARGE_CATEGORY_ID_FOR_HEAT,
  DEFAULT_RACK_HEAT_ATTENUATION,
  DEFAULT_RACK_HEAT_CAPACITY,
  DEFAULT_RACK_HEAT_DISSIPATION_RATE,
  EFFECT_NAME_EMERGENCY_HULL_ENERGIZER,
  MINING_EFFECT_NAMES_FOR_HEAT,
  OVERLOAD_EFFECT_CATEGORY_ID,
  RACK_HEAT_FAMILY_ATTRIBUTES,
  RACK_HEAT_MAX_ADVANCE_SECONDS,
  RACK_HEAT_NOTIFY_INTERVAL_MIN_DELTA,
  RACK_HEAT_NOTIFY_INTERVAL_MS,
  RACK_HEAT_NOTIFY_MIN_DELTA,
  TYPE_THERMODYNAMICS,
});
