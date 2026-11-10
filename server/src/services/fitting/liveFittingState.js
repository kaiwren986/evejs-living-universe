"use strict";

const {
  round6,
  toFiniteNumber,
} = require("../../common/numbers");

const path = require("path");

const {
  TABLE,
  readStaticTable,
} = require(path.join(__dirname, "../_shared/referenceData"));
const {
  normalizeDogmaFloat,
} = require(path.join(__dirname, "../_shared/floatPrecision"));
const {
  ITEM_FLAGS,
} = require(path.join(__dirname, "../inventory/itemStore"));
const {
  listContainerItems,
  findItemById,
} = require(path.join(__dirname, "../inventory/simulationInventoryProjection"));
const {
  getCachedCharacterSkillMap,
} = require(path.join(__dirname, "../skills/skillState"));
const {
  resolveItemByTypeID,
} = require(path.join(__dirname, "../inventory/itemTypeRegistry"));
const {
  MINING_HOLD_DEFINITIONS,
} = require(path.join(__dirname, "../mining/miningConstants"));
const {
  FUEL_BAY_ATTRIBUTE_ID,
  FUEL_BAY_RESOURCE_KEY,
} = require(path.join(__dirname, "../inventory/fuelBayInventory"));
const {
  FLEET_HANGAR_ATTRIBUTE_ID,
  FLEET_HANGAR_RESOURCE_KEY,
} = require(path.join(__dirname, "../inventory/fleetHangarInventory"));
const {
  getActiveImplantLocationModifierSources,
  getActiveImplantShipModifierEntries,
} = require(path.join(__dirname, "../dogma/implants/activeImplantModifiers"));
const {
  evaluateChargeCompatibility,
} = require(path.join(__dirname, "chargeCompatibilityPolicy"));
const {
  getHullBonusSkillTypeIDs,
} = require(path.join(__dirname, "hullBonusSkillAuthority"));

const CHARGE_CATEGORY_ID = 8;
const SHIP_CATEGORY_ID = 6;
const STRUCTURE_CATEGORY_ID = 65;
const STRUCTURE_MODULE_CATEGORY_ID = 66;
const FIGHTER_CATEGORY_ID = 87;
const STRUCTURE_DOGMA_SKILL_TYPE_IDS = new Set([
  37796, // Structure Missile Systems
  37797, // Structure Doomsday Operation
  37798, // Structure Electronic Systems
  37799, // Structure Engineering Systems
]);
const HIDDEN_MODIFIERS_FLAG = ITEM_FLAGS.HIDDEN_MODIFIERS || 156;
const GROUP_SCAN_PROBE_LAUNCHER = 481;
const STRATEGIC_CRUISER_GROUP_ID = 963;
const STRATEGIC_CRUISER_SUBSYSTEM_FLAGS = Object.freeze([125, 126, 127, 128]);
const SLOT_FAMILY_FLAGS = Object.freeze({
  low: Object.freeze([11, 12, 13, 14, 15, 16, 17, 18]),
  med: Object.freeze([19, 20, 21, 22, 23, 24, 25, 26]),
  high: Object.freeze([27, 28, 29, 30, 31, 32, 33, 34]),
  rig: Object.freeze([92, 93, 94, 95, 96, 97, 98, 99]),
  subsystem: Object.freeze([125, 126, 127, 128, 129, 130, 131, 132]),
  service: Object.freeze([164, 165, 166, 167, 168, 169, 170, 171]),
});
const SHIP_FITTING_FLAG_RANGES = Object.freeze([
  Object.freeze([11, 34]),
  Object.freeze([92, 99]),
  Object.freeze([125, 132]),
  Object.freeze([164, 171]),
]);
const EFFECT_ID_FALLBACK = Object.freeze({
  loPower: 11,
  hiPower: 12,
  medPower: 13,
  online: 16,
  launcherFitted: 40,
  turretFitted: 42,
  rigSlot: 2663,
  subSystem: 3772,
  serviceSlot: 6306,
});
const ATTRIBUTE_ID_FALLBACK = Object.freeze({
  lowSlots: 12,
  medSlots: 13,
  hiSlots: 14,
  capacity: 38,
  maxSubSystems: 136,
  rigSlots: 1137,
  serviceSlots: 2056,
  isOnline: 1153,
  quantity: 20,
});
const DEFAULT_MODULE_STATE = Object.freeze({
  online: false,
  damage: 0.0,
  charge: 0.0,
  skillPoints: 0,
  armorDamage: 0.0,
  shieldCharge: 0.0,
  incapacitated: false,
});
const DYNAMIC_ITEM_CUSTOM_INFO_KEY = "evejsDynamicItem";
const { getAttributeOverrides: getGmDogmaOverrides, hasItemOverrides } = require("../dogma/gmDogmaOverrides");

let cachedDogmaLookups = null;
let cachedNormalizedTypeAttributeMaps = null;
let cachedTypeEffectRecords = null;
// Three memos over the same frozen dogma tables the caches above already treat as
// immutable for the life of the process: nothing in this file ever clears them, and
// a reload would have to rebuild all of them together. They exist because the
// passive-modifier collection asks these questions per skill x per module x per
// rebuild, and a rebuild happens on every module activation and deactivation --
// including an NPC's, once per weapon cycle in a fight.
let cachedRequiredSkillTypeIDsByTypeID = null;
let cachedTypeHasEffectNameByKey = null;
let cachedSkillEffectiveAttributes = null;
let cachedSkillExplicitShipAttributeModifiers = null;
let cachedSkillFallbackShipEligibility = null;

function getShipStanceRuntime() {
  return require(path.join(__dirname, "../ship/shipStanceRuntime"));
}

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function normalizeNumericAttributeMap(attributes = {}) {
  return Object.fromEntries(
    Object.entries(attributes || {})
      .map(([attributeID, value]) => [Number(attributeID), Number(value)])
      .filter(
        ([attributeID, value]) =>
          Number.isInteger(attributeID) && Number.isFinite(value),
      ),
  );
}

function isShipFittingFlag(flagID) {
  const numericFlagID = toInt(flagID, 0);
  return SHIP_FITTING_FLAG_RANGES.some(
    ([start, end]) => numericFlagID >= start && numericFlagID <= end,
  );
}

function isChargeItem(item) {
  return item && toInt(item.categoryID, 0) === CHARGE_CATEGORY_ID;
}

function isFittedChargeItem(item) {
  return Boolean(item) && isShipFittingFlag(item.flagID) && isChargeItem(item);
}

function isFittedModuleItem(item) {
  return Boolean(item) && isShipFittingFlag(item.flagID) && !isChargeItem(item);
}

function isHiddenModifierItem(item) {
  return Boolean(item) && toInt(item.flagID, 0) === HIDDEN_MODIFIERS_FLAG;
}

function normalizeModuleState(rawState) {
  const source =
    rawState && typeof rawState === "object" ? rawState : DEFAULT_MODULE_STATE;

  return {
    online: Boolean(source.online),
    damage: toFiniteNumber(source.damage, DEFAULT_MODULE_STATE.damage),
    charge: toFiniteNumber(source.charge, DEFAULT_MODULE_STATE.charge),
    skillPoints: toInt(source.skillPoints, DEFAULT_MODULE_STATE.skillPoints),
    armorDamage: toFiniteNumber(
      source.armorDamage,
      DEFAULT_MODULE_STATE.armorDamage,
    ),
    shieldCharge: toFiniteNumber(
      source.shieldCharge,
      DEFAULT_MODULE_STATE.shieldCharge,
    ),
    incapacitated: Boolean(source.incapacitated),
  };
}

function getItemModuleState(item) {
  return normalizeModuleState(item && item.moduleState);
}

function isModuleOnline(item) {
  return getItemModuleState(item).online;
}

function hasExplicitModuleOnlineState(item) {
  return Boolean(
    item &&
    item.moduleState &&
    typeof item.moduleState === "object" &&
    Object.prototype.hasOwnProperty.call(item.moduleState, "online"),
  );
}

function isEffectivelyOnlineModule(item) {
  if (!item || !isFittedModuleItem(item)) {
    return false;
  }

  if (!item.moduleState || typeof item.moduleState !== "object") {
    return true;
  }

  if (!hasExplicitModuleOnlineState(item)) {
    return true;
  }

  return isModuleOnline(item);
}

function buildNameIndex(entries = {}) {
  const byName = new Map();
  for (const entry of Object.values(entries || {})) {
    if (!entry || typeof entry !== "object") {
      continue;
    }

    for (const candidate of [entry.name, entry.attributeName, entry.displayName]) {
      const normalized = String(candidate || "").trim().toLowerCase();
      if (!normalized) {
        continue;
      }

      const numericID = toInt(entry.effectID ?? entry.attributeID, 0);
      if (numericID > 0 && !byName.has(normalized)) {
        byName.set(normalized, numericID);
      }
    }
  }
  return byName;
}

function getDogmaLookups() {
  if (cachedDogmaLookups) {
    return cachedDogmaLookups;
  }

  const shipDogmaRoot = readStaticTable(TABLE.SHIP_DOGMA_ATTRIBUTES);
  const typeDogmaRoot = readStaticTable(TABLE.TYPE_DOGMA);
  const attributeTypesByID =
    (typeDogmaRoot && typeDogmaRoot.attributeTypesByID) ||
    (shipDogmaRoot && shipDogmaRoot.attributeTypesByID) ||
    {};
  const effectTypesByID =
    (typeDogmaRoot && typeDogmaRoot.effectTypesByID) || {};
  const attributeIDsByName = buildNameIndex(attributeTypesByID);
  const effectIDsByName = buildNameIndex(effectTypesByID);

  for (const [name, effectID] of Object.entries(EFFECT_ID_FALLBACK)) {
    const normalized = name.toLowerCase();
    if (!effectIDsByName.has(normalized)) {
      effectIDsByName.set(normalized, effectID);
    }
  }

  for (const [name, attributeID] of Object.entries(ATTRIBUTE_ID_FALLBACK)) {
    const normalized = name.toLowerCase();
    if (!attributeIDsByName.has(normalized)) {
      attributeIDsByName.set(normalized, attributeID);
    }
  }

  cachedDogmaLookups = {
    attributeIDsByName,
    effectIDsByName,
  };
  return cachedDogmaLookups;
}

function ensureNormalizedTypeAttributeMapCache() {
  if (!cachedNormalizedTypeAttributeMaps) {
    cachedNormalizedTypeAttributeMaps = new Map();
  }
  return cachedNormalizedTypeAttributeMaps;
}

function ensureTypeEffectRecordCache() {
  if (!cachedTypeEffectRecords) {
    cachedTypeEffectRecords = new Map();
  }
  return cachedTypeEffectRecords;
}

function ensureSkillEffectiveAttributeCache() {
  if (!cachedSkillEffectiveAttributes) {
    cachedSkillEffectiveAttributes = new Map();
  }
  return cachedSkillEffectiveAttributes;
}

function ensureSkillExplicitShipAttributeModifierCache() {
  if (!cachedSkillExplicitShipAttributeModifiers) {
    cachedSkillExplicitShipAttributeModifiers = new Map();
  }
  return cachedSkillExplicitShipAttributeModifiers;
}

function ensureSkillFallbackShipEligibilityCache() {
  if (!cachedSkillFallbackShipEligibility) {
    cachedSkillFallbackShipEligibility = new Map();
  }
  return cachedSkillFallbackShipEligibility;
}

// Deliberately NOT memoised. It looks like the obvious candidate -- 56 call sites,
// ~4% of stall samples -- but it is already one Map lookup behind a cheap normalize,
// and a memo measured 0.111 -> 0.113 us/call: building the key costs what it saves.
// The calls that put it in the profile were the six per getRequiredSkillTypeIDs, and
// memoising that removes them at the source instead of caching them here.
function getAttributeIDByNames(...names) {
  const { attributeIDsByName } = getDogmaLookups();
  for (const name of names) {
    const normalized = String(name || "").trim().toLowerCase();
    if (attributeIDsByName.has(normalized)) {
      return attributeIDsByName.get(normalized);
    }
  }
  return null;
}

function getEffectIDByNames(...names) {
  const { effectIDsByName } = getDogmaLookups();
  for (const name of names) {
    const normalized = String(name || "").trim().toLowerCase();
    if (effectIDsByName.has(normalized)) {
      return effectIDsByName.get(normalized);
    }
  }
  return null;
}

function getTypeDogmaRoot() {
  return readStaticTable(TABLE.TYPE_DOGMA) || {};
}

function getTypeDogmaRecord(typeID) {
  const numericTypeID = toInt(typeID, 0);
  if (numericTypeID <= 0) {
    return null;
  }

  const root = getTypeDogmaRoot();
  return (
    (root.typesByTypeID && root.typesByTypeID[String(numericTypeID)]) || null
  );
}

function getTypeDogmaAttributes(typeID) {
  const record = getTypeDogmaRecord(typeID);
  if (!record || !record.attributes || typeof record.attributes !== "object") {
    return {};
  }

  return record.attributes;
}

function getNormalizedTypeAttributeMap(typeID) {
  const numericTypeID = toInt(typeID, 0);
  if (numericTypeID <= 0) {
    return Object.freeze({});
  }

  const cache = ensureNormalizedTypeAttributeMapCache();
  const cached = cache.get(numericTypeID);
  if (cached) {
    return cached;
  }

  const normalized = Object.freeze(
    normalizeNumericAttributeMap(getTypeDogmaAttributes(numericTypeID)),
  );
  cache.set(numericTypeID, normalized);
  return normalized;
}

function getTypeAttributeValue(typeID, ...names) {
  const attributes = getNormalizedTypeAttributeMap(typeID);
  for (const name of names) {
    const attributeID = getAttributeIDByNames(name);
    if (!attributeID || !attributes || attributes[attributeID] === undefined) {
      continue;
    }

    const numericValue = Number(attributes[attributeID]);
    if (Number.isFinite(numericValue)) {
      return numericValue;
    }
  }

  return null;
}

function getSkillAttributeValue(typeID, ...names) {
  const directValue = getTypeAttributeValue(typeID, ...names);
  if (directValue !== null && directValue !== undefined) {
    return directValue;
  }

  const fallback = SKILL_ATTRIBUTE_BONUS_FALLBACKS[toInt(typeID, 0)] || null;
  if (!fallback) {
    return null;
  }

  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(fallback, name)) {
      return fallback[name];
    }
  }

  return null;
}

function getTypeDogmaEffects(typeID) {
  const record = getTypeDogmaRecord(typeID);
  const effects = Array.isArray(record && record.effects) ? record.effects : [];
  return new Set(
    effects
      .map((effectID) => toInt(effectID, 0))
      .filter((effectID) => effectID > 0),
  );
}

function typeHasEffectName(typeID, effectName) {
  if (!cachedTypeHasEffectNameByKey) {
    cachedTypeHasEffectNameByKey = new Map();
  }
  const cacheKey = `${toInt(typeID, 0)} ${effectName}`;
  if (cachedTypeHasEffectNameByKey.has(cacheKey)) {
    return cachedTypeHasEffectNameByKey.get(cacheKey);
  }
  const effectID = getEffectIDByNames(effectName);
  const answer = effectID
    ? getTypeDogmaEffects(typeID).has(effectID)
    : false;
  cachedTypeHasEffectNameByKey.set(cacheKey, answer);
  return answer;
}

function getRequiredSlotFamily(typeID) {
  if (typeHasEffectName(typeID, "hiPower")) {
    return "high";
  }
  if (typeHasEffectName(typeID, "medPower")) {
    return "med";
  }
  if (typeHasEffectName(typeID, "loPower")) {
    return "low";
  }
  if (typeHasEffectName(typeID, "rigSlot")) {
    return "rig";
  }
  if (typeHasEffectName(typeID, "subSystem")) {
    return "subsystem";
  }
  if (typeHasEffectName(typeID, "serviceSlot")) {
    return "service";
  }
  return null;
}

function isStrategicCruiserType(typeID) {
  const typeRecord = resolveItemByTypeID(toInt(typeID, 0)) || null;
  return toInt(typeRecord && typeRecord.groupID, 0) === STRATEGIC_CRUISER_GROUP_ID;
}

function getSubsystemSlotFlag(typeID) {
  if (getRequiredSlotFamily(typeID) !== "subsystem") {
    return 0;
  }
  const flagID = toInt(getTypeAttributeValue(typeID, "subSystemSlot"), 0);
  return STRATEGIC_CRUISER_SUBSYSTEM_FLAGS.includes(flagID) ? flagID : 0;
}

function isSubsystemCompatibleWithStrategicCruiser(subsystem, shipTypeID) {
  const subsystemTypeID = toInt(subsystem && subsystem.typeID, 0);
  const numericShipTypeID = toInt(shipTypeID, 0);
  if (
    subsystemTypeID <= 0 ||
    numericShipTypeID <= 0 ||
    getRequiredSlotFamily(subsystemTypeID) !== "subsystem"
  ) {
    return false;
  }

  const fittedShipTypeID = toInt(
    getTypeAttributeValue(subsystemTypeID, "fitsToShipType"),
    0,
  );
  if (fittedShipTypeID > 0) {
    return fittedShipTypeID === numericShipTypeID;
  }

  const shipType = resolveItemByTypeID(numericShipTypeID) || null;
  const subsystemType = resolveItemByTypeID(subsystemTypeID) || null;
  const shipName = String(shipType && shipType.name || "").trim().toLowerCase();
  const subsystemName = String(subsystemType && subsystemType.name || "").trim().toLowerCase();
  return Boolean(shipName && subsystemName.startsWith(`${shipName} `));
}

function getStrategicCruiserSubsystemStatus(shipItem, fittedItems = []) {
  const shipID = toInt(shipItem && shipItem.itemID, 0);
  const shipTypeID = toInt(shipItem && shipItem.typeID, 0);
  const requiredFlags = isStrategicCruiserType(shipTypeID)
    ? [...STRATEGIC_CRUISER_SUBSYSTEM_FLAGS]
    : [];
  const fittedByFlag = new Map();
  const duplicateFlags = [];
  const invalidItems = [];

  for (const item of Array.isArray(fittedItems) ? fittedItems : []) {
    if (!item || getRequiredSlotFamily(item.typeID) !== "subsystem") {
      continue;
    }
    if (!isFittedModuleItem(item)) {
      continue;
    }
    const itemLocationID = toInt(item.locationID, 0);
    const flagID = toInt(item.flagID, 0);
    if (
      (shipID > 0 && itemLocationID > 0 && itemLocationID !== shipID) ||
      !requiredFlags.includes(flagID) ||
      getSubsystemSlotFlag(item.typeID) !== flagID ||
      !isSubsystemCompatibleWithStrategicCruiser(item, shipTypeID)
    ) {
      invalidItems.push(item);
      continue;
    }
    if (fittedByFlag.has(flagID)) {
      if (!duplicateFlags.includes(flagID)) {
        duplicateFlags.push(flagID);
      }
      continue;
    }
    fittedByFlag.set(flagID, item);
  }

  const missingFlags = requiredFlags.filter((flagID) => !fittedByFlag.has(flagID));
  return {
    requiredFlags,
    fittedByFlag,
    missingFlags,
    duplicateFlags,
    invalidItems,
    complete:
      requiredFlags.length > 0 &&
      missingFlags.length === 0 &&
      duplicateFlags.length === 0 &&
      invalidItems.length === 0,
  };
}

function getValidStrategicCruiserSubsystems(
  shipTypeID,
  fittedItems = [],
  shipID = 0,
) {
  if (!isStrategicCruiserType(shipTypeID)) {
    return [];
  }
  const status = getStrategicCruiserSubsystemStatus(
    {
      itemID: toInt(shipID, 0),
      typeID: toInt(shipTypeID, 0),
    },
    fittedItems,
  );
  return status.requiredFlags
    .map((flagID) => status.fittedByFlag.get(flagID) || null)
    .filter(Boolean);
}

function readShipBaseAttributes(shipTypeID) {
  const numericTypeID = toInt(shipTypeID, 0);
  const shipDogmaRoot = readStaticTable(TABLE.SHIP_DOGMA_ATTRIBUTES);
  const entry =
    shipDogmaRoot &&
    shipDogmaRoot.shipAttributesByTypeID &&
    shipDogmaRoot.shipAttributesByTypeID[String(numericTypeID)];
  if (entry && typeof entry.attributes === "object") {
    return entry.attributes;
  }

  return getTypeDogmaAttributes(numericTypeID);
}

function readShipFittingBaseAttributes(shipTypeID, shipID) {
  const attributes = readShipBaseAttributes(shipTypeID);
  // Ordinary fitting reads retain the static-map fast path. Only a ship with
  // a live staff edit needs an inventory identity check and a detached map.
  if (!hasItemOverrides(shipID)) return attributes;
  const item = findItemById(shipID);
  if (!item || toInt(item.typeID, 0) !== toInt(shipTypeID, 0)) return attributes;
  return { ...attributes, ...getGmDogmaOverrides(item) };
}

function getShipBaseAttributeValue(shipTypeID, ...names) {
  const attributes = readShipBaseAttributes(shipTypeID);
  for (const name of names) {
    const attributeID = getAttributeIDByNames(name);
    if (!attributeID || !attributes || attributes[String(attributeID)] === undefined) {
      continue;
    }

    const numericValue = Number(attributes[String(attributeID)]);
    if (Number.isFinite(numericValue)) {
      return numericValue;
    }
  }

  return null;
}

function getShipSlotCounts(shipTypeID, fittedItems = [], shipID = 0) {
  const attributes = readShipFittingBaseAttributes(shipTypeID, shipID);
  const lowSlotsID = getAttributeIDByNames("lowSlots");
  const medSlotsID = getAttributeIDByNames("medSlots");
  const hiSlotsID = getAttributeIDByNames("hiSlots");
  const rigSlotsID = getAttributeIDByNames("rigSlots");
  const maxSubSystemsID = getAttributeIDByNames("maxSubSystems");
  const serviceSlotsID = getAttributeIDByNames("serviceSlots");

  const isStrategicCruiser = isStrategicCruiserType(shipTypeID);
  const compatibleSubsystems = isStrategicCruiser
    ? getValidStrategicCruiserSubsystems(shipTypeID, fittedItems, shipID)
    : [];
  const sumSubsystemModifier = (...attributeNames) => compatibleSubsystems.reduce(
    (sum, item) => sum + toInt(
      getEffectiveItemAttributeValue(item, ...attributeNames),
      0,
    ),
    0,
  );

  return {
    low:
      (lowSlotsID ? toInt(attributes[String(lowSlotsID)], 0) : 0) +
      sumSubsystemModifier("lowSlotModifier"),
    med:
      (medSlotsID ? toInt(attributes[String(medSlotsID)], 0) : 0) +
      sumSubsystemModifier("medSlotModifier"),
    high:
      (hiSlotsID ? toInt(attributes[String(hiSlotsID)], 0) : 0) +
      sumSubsystemModifier("hiSlotModifier", "highSlotModifier"),
    rig: rigSlotsID ? toInt(attributes[String(rigSlotsID)], 0) : 0,
    subsystem: isStrategicCruiser
      ? STRATEGIC_CRUISER_SUBSYSTEM_FLAGS.length
      : maxSubSystemsID ? toInt(attributes[String(maxSubSystemsID)], 0) : 0,
    service: serviceSlotsID ? toInt(attributes[String(serviceSlotsID)], 0) : 0,
  };
}

function getShipRigSlotCapacity(shipTypeID, shipID = 0) {
  const attributes = readShipFittingBaseAttributes(shipTypeID, shipID);
  return Math.max(0, toInt(attributes[1154] ?? attributes[1137], 0));
}

function getSlotFlagsForFamily(
  family,
  shipTypeID = null,
  fittedItems = [],
  shipID = 0,
) {
  const baseFlags = SLOT_FAMILY_FLAGS[family];
  if (!Array.isArray(baseFlags)) {
    return [];
  }

  if (!shipTypeID) {
    return [...baseFlags];
  }

  if (family === "subsystem" && isStrategicCruiserType(shipTypeID)) {
    return [...STRATEGIC_CRUISER_SUBSYSTEM_FLAGS];
  }

  const slotCounts = getShipSlotCounts(shipTypeID, fittedItems, shipID);
  const limit = toInt(slotCounts[family], 0);
  if (limit > 0) {
    return baseFlags.slice(0, limit);
  }
  if (isStrategicCruiserType(shipTypeID)) {
    return [];
  }
  if (family === "rig") {
    return [];
  }
  if (family === "high" || family === "med" || family === "low") {
    const categoryID = resolveItemByTypeID(shipTypeID)?.categoryID;
    if (categoryID === SHIP_CATEGORY_ID || categoryID === STRUCTURE_CATEGORY_ID) {
      return [];
    }
  }
  // NPC entity types can omit rack counts and still have authored loadouts.
  return [...baseFlags];
}

function sortFittedItems(left, right) {
  const leftFlag = toInt(left && left.flagID, 0);
  const rightFlag = toInt(right && right.flagID, 0);
  if (leftFlag !== rightFlag) {
    return leftFlag - rightFlag;
  }
  return toInt(left && left.itemID, 0) - toInt(right && right.itemID, 0);
}

function listFittedItems(charID, shipID) {
  return listContainerItems(charID, shipID, null)
    .filter((item) => isShipFittingFlag(item && item.flagID))
    .sort(sortFittedItems);
}

function listFittedItemsForLocation(shipID) {
  return listContainerItems(null, shipID, null)
    .filter((item) => isShipFittingFlag(item && item.flagID))
    .sort(sortFittedItems);
}

function buildVirtualHiddenModifierItem(shipItem, modifierTypeID, customInfo = "hiddenModifier") {
  const numericModifierTypeID = toInt(modifierTypeID, 0);
  const typeRecord = resolveItemByTypeID(numericModifierTypeID) || {};
  return {
    itemID: `virtual-hidden-modifier:${toInt(shipItem && shipItem.itemID, 0)}:${numericModifierTypeID}`,
    typeID: numericModifierTypeID,
    ownerID: toInt(shipItem && shipItem.ownerID, 0) || null,
    locationID: toInt(shipItem && shipItem.itemID, 0) || null,
    flagID: HIDDEN_MODIFIERS_FLAG,
    groupID: toInt(typeRecord.groupID, 0),
    categoryID: toInt(typeRecord.categoryID, 0),
    quantity: 1,
    singleton: 1,
    stacksize: 1,
    customInfo,
  };
}

function listHiddenModifierItems(ownerID, shipID, shipItem = null) {
  const numericShipID = toInt(shipID || shipItem && shipItem.itemID, 0);
  if (numericShipID <= 0) {
    return [];
  }

  const numericOwnerID = toInt(ownerID || shipItem && shipItem.ownerID, 0);
  const hiddenItems = listContainerItems(
    numericOwnerID > 0 ? numericOwnerID : null,
    numericShipID,
    HIDDEN_MODIFIERS_FLAG,
  )
    .filter((item) => item && toInt(item.typeID, 0) > 0)
    .sort(sortFittedItems);

  const shipStanceRuntime = getShipStanceRuntime();
  const stanceState = shipStanceRuntime.resolveCurrentShipStance(
    shipItem && typeof shipItem === "object"
      ? shipItem
      : numericShipID,
  );
  if (
    stanceState.supported === true &&
    toInt(stanceState.modifierTypeID, 0) > 0 &&
    !hiddenItems.some((item) => (
      shipStanceRuntime.ALL_STANCE_MODIFIER_TYPE_IDS.includes(toInt(item && item.typeID, 0))
    ))
  ) {
    hiddenItems.push(
      buildVirtualHiddenModifierItem(
        stanceState.shipItem || shipItem || {
          itemID: numericShipID,
          ownerID: numericOwnerID,
        },
        stanceState.modifierTypeID,
        `shipStance:${stanceState.stanceID}:default`,
      ),
    );
  }

  return hiddenItems;
}

function getPassiveModifierSourceItems(shipItem, fittedItems = [], options = {}) {
  const visibleSources = Array.isArray(fittedItems) ? fittedItems : [];
  const hiddenSources = Array.isArray(options.hiddenModifierItems)
    ? options.hiddenModifierItems
    : listHiddenModifierItems(
      toInt(shipItem && shipItem.ownerID, 0),
      toInt(shipItem && shipItem.itemID, 0),
      shipItem,
    );
  const byKey = new Map();
  for (const item of [...visibleSources, ...hiddenSources]) {
    if (!item || toInt(item.typeID, 0) <= 0) {
      continue;
    }
    const key = `${String(item.itemID)}:${toInt(item.typeID, 0)}:${toInt(item.flagID, 0)}`;
    if (!byKey.has(key)) {
      byKey.set(key, item);
    }
  }
  return [...byKey.values()];
}

function getFittedModuleItems(charID, shipID) {
  return listFittedItems(charID, shipID).filter((item) => isFittedModuleItem(item));
}

function getLoadedChargeItems(charID, shipID) {
  return listFittedItems(charID, shipID).filter((item) => isFittedChargeItem(item));
}

function getFittedModuleByFlag(charID, shipID, flagID) {
  const numericFlagID = toInt(flagID, 0);
  return (
    getFittedModuleItems(charID, shipID).find(
      (item) => toInt(item.flagID, 0) === numericFlagID,
    ) || null
  );
}

function getLoadedChargeByFlag(charID, shipID, flagID) {
  const numericFlagID = toInt(flagID, 0);
  return (
    getLoadedChargeItems(charID, shipID).find(
      (item) => toInt(item.flagID, 0) === numericFlagID,
    ) || null
  );
}

function hasLoadedScanProbeLauncherCharge(charID, shipID) {
  return getLoadedChargeItems(charID, shipID).some((chargeItem) => {
    const moduleItem = getFittedModuleByFlag(charID, shipID, chargeItem.flagID);
    return Number(moduleItem && moduleItem.groupID) === GROUP_SCAN_PROBE_LAUNCHER;
  });
}

// baseDogmaLocation.GetMissingSkills: each of a type's own required skills the
// character has not at its level (the level a skill counts at: its effective
// one, which an expert system's gives), in the type's order.
function getMissingRequiredSkills(characterID, typeID) {
  const skillMap = getCachedCharacterSkillMap(toInt(characterID, 0));
  const missing = [];
  for (const requirement of getRequiredSkillRequirements(typeID)) {
    const skillRecord = skillMap.get(requirement.skillTypeID) || null;
    const trainedLevel = Math.max(
      0,
      toInt(
        skillRecord && (
          skillRecord.effectiveSkillLevel ??
          skillRecord.trainedSkillLevel ??
          skillRecord.skillLevel
        ),
        0,
      ),
    );
    if (trainedLevel < requirement.level) {
      missing.push({
        skillTypeID: requirement.skillTypeID,
        requiredLevel: requirement.level,
        currentLevel: trainedLevel,
      });
    }
  }
  return missing;
}

function getRequiredSkillRequirements(typeID) {
  const requirements = [];

  for (let index = 1; index <= 6; index += 1) {
    const requiredSkill = getTypeAttributeValue(typeID, `requiredSkill${index}`);
    const requiredLevel = getTypeAttributeValue(typeID, `requiredSkill${index}Level`);
    if (!Number.isInteger(requiredSkill) || requiredSkill <= 0) {
      continue;
    }

    requirements.push({
      skillTypeID: requiredSkill,
      level: Math.max(1, toInt(requiredLevel, 1)),
    });
  }

  return requirements;
}

function getShipRestrictionValues(typeID, prefix, maxCount, padWidth = 0) {
  const values = [];
  for (let index = 1; index <= maxCount; index += 1) {
    const suffix = padWidth > 0 ? String(index).padStart(padWidth, "0") : String(index);
    const value = getTypeAttributeValue(typeID, `${prefix}${suffix}`);
    if (Number.isInteger(value) && value > 0) {
      values.push(value);
    }
  }
  return values;
}

function validateShipTypeOrGroupRestriction(moduleTypeID, shipItem) {
  const allowedShipTypes = getShipRestrictionValues(
    moduleTypeID,
    "canFitShipType",
    12,
  );
  const allowedShipGroups = getShipRestrictionValues(
    moduleTypeID,
    "canFitShipGroup",
    20,
    2,
  );
  if (allowedShipTypes.length <= 0 && allowedShipGroups.length <= 0) {
    return { success: true };
  }

  const shipTypeID = toInt(shipItem && shipItem.typeID, 0);
  const shipGroupID = toInt(shipItem && shipItem.groupID, 0);
  const shipTypeAllowed =
    allowedShipTypes.length > 0 && allowedShipTypes.includes(shipTypeID);
  const shipGroupAllowed =
    allowedShipGroups.length > 0 && allowedShipGroups.includes(shipGroupID);
  if (shipTypeAllowed || shipGroupAllowed) {
    return { success: true };
  }

  if (allowedShipGroups.length > 0) {
    return {
      success: false,
      errorMsg: "INVALID_SHIP_GROUP",
      data: {
        allowedShipGroups,
        ...(allowedShipTypes.length > 0 ? { allowedShipTypes } : {}),
      },
    };
  }

  return {
    success: false,
    errorMsg: "INVALID_SHIP_TYPE",
    data: { allowedShipTypes },
  };
}

function getTypeCategoryID(typeID) {
  const typeRecord = resolveItemByTypeID(toInt(typeID, 0)) || null;
  return toInt(typeRecord && typeRecord.categoryID, 0);
}

function resolveItemCategoryID(item) {
  return toInt(item && item.categoryID, 0) || getTypeCategoryID(item && item.typeID);
}

function isStructureDogmaHost(shipItem) {
  return resolveItemCategoryID(shipItem) === STRUCTURE_CATEGORY_ID;
}

function filterStructureDogmaSkillMap(skillMap) {
  if (!(skillMap instanceof Map) || skillMap.size <= 0) {
    return new Map();
  }
  return new Map(
    [...skillMap.entries()].filter(([, skillRecord]) => (
      STRUCTURE_DOGMA_SKILL_TYPE_IDS.has(toInt(skillRecord && skillRecord.typeID, 0))
    )),
  );
}

function resolveDogmaSkillMapForHost(charID, shipItem, options = {}) {
  const baseSkillMap = options.skillMap instanceof Map
    ? options.skillMap
    : getCachedCharacterSkillMap(toInt(charID, 0));
  return isStructureDogmaHost(shipItem)
    ? filterStructureDogmaSkillMap(baseSkillMap)
    : baseSkillMap;
}

function validateHostFittingCategoryRestriction(hostItem, fittedItem) {
  const hostCategoryID = resolveItemCategoryID(hostItem);
  const fittedCategoryID = resolveItemCategoryID(fittedItem);

  if (hostCategoryID === STRUCTURE_CATEGORY_ID) {
    if (
      fittedCategoryID === STRUCTURE_MODULE_CATEGORY_ID ||
      fittedCategoryID === FIGHTER_CATEGORY_ID
    ) {
      return { success: true };
    }
    return {
      success: false,
      errorMsg: "MODULE_NOT_APPROPRIATE_FOR_CATEGORY",
      data: {
        hostCategoryID,
        fittedCategoryID,
      },
    };
  }

  if (fittedCategoryID === STRUCTURE_MODULE_CATEGORY_ID) {
    return {
      success: false,
      errorMsg: "MODULE_NOT_APPROPRIATE_FOR_CATEGORY",
      data: {
        hostCategoryID,
        fittedCategoryID,
      },
    };
  }

  return { success: true };
}

function itemConsumesTurretHardpoint(item) {
  return typeHasEffectName(item && item.typeID, "turretFitted");
}

function itemConsumesLauncherHardpoint(item) {
  return typeHasEffectName(item && item.typeID, "launcherFitted");
}

function itemAppliesPassiveStats(item) {
  if (isHiddenModifierItem(item)) {
    return getPassiveModifierEffectRecords(item.typeID).length > 0;
  }
  return isPassiveModifierSource(item);
}

function countMatchingFittedItems(fittedItems, predicate, excludeItemID = null) {
  return (Array.isArray(fittedItems) ? fittedItems : []).filter((item) => {
    if (!item || !isFittedModuleItem(item)) {
      return false;
    }
    if (excludeItemID && toInt(item.itemID, 0) === excludeItemID) {
      return false;
    }
    return predicate(item);
  }).length;
}

// Native fitting.py subtracts the module's "slots" attribute, including for
// offline modules. This is independent of CPU, powergrid and calibration.
function getItemEffectSlotUsage(item, effectName) {
  return item && typeHasEffectName(item.typeID, effectName)
    ? Math.max(0, toInt(getEffectiveItemAttributeValue(item, "slots"), 1)) : 0;
}

function getFittedEffectSlotsUsed(fittedItems, effectName, excludeItemID = 0) {
  return (Array.isArray(fittedItems) ? fittedItems : []).reduce((used, item) =>
    item && isFittedModuleItem(item) && toInt(item.itemID, 0) !== excludeItemID &&
      typeHasEffectName(item.typeID, effectName)
      ? used + getItemEffectSlotUsage(item, effectName)
      : used, 0);
}

const ATTRIBUTE_CPU_OUTPUT = getAttributeIDByNames("cpuOutput") || 48;
const ATTRIBUTE_POWER_OUTPUT = getAttributeIDByNames("powerOutput") || 11;
const ATTRIBUTE_CPU_LOAD = getAttributeIDByNames("cpuLoad") || 49;
const ATTRIBUTE_POWER_LOAD = getAttributeIDByNames("powerLoad") || 15;
const ATTRIBUTE_MODULE_CPU_NEED = getAttributeIDByNames("cpu") || 50;
const ATTRIBUTE_MODULE_POWER_NEED = getAttributeIDByNames("power") || 30;
const ATTRIBUTE_CAPACITY = getAttributeIDByNames("capacity") || 38;
const ATTRIBUTE_MAX_VELOCITY = getAttributeIDByNames("maxVelocity") || 37;
const ATTRIBUTE_AGILITY = getAttributeIDByNames("agility") || 70;
const ATTRIBUTE_MASS = getAttributeIDByNames("mass") || 4;
const ATTRIBUTE_SPEED_FACTOR = getAttributeIDByNames("speedFactor") || 20;
const ATTRIBUTE_SPEED_BOOST_FACTOR =
  getAttributeIDByNames("speedBoostFactor") || 567;
const ATTRIBUTE_MASS_ADDITION = getAttributeIDByNames("massAddition") || 796;
const ATTRIBUTE_SIGNATURE_RADIUS_BONUS =
  getAttributeIDByNames("signatureRadiusBonus") || 554;
const ATTRIBUTE_MAX_TARGET_RANGE = getAttributeIDByNames("maxTargetRange") || 76;
const ATTRIBUTE_MAX_LOCKED_TARGETS =
  getAttributeIDByNames("maxLockedTargets") || 192;
const ATTRIBUTE_SIGNATURE_RADIUS = getAttributeIDByNames("signatureRadius") || 552;
const ATTRIBUTE_CLOAKING_TARGETING_DELAY =
  getAttributeIDByNames("cloakingTargetingDelay") || 560;
const PROPULSION_EFFECT_AFTERBURNER = "modulebonusafterburner";
const PROPULSION_EFFECT_MICROWARPDRIVE = "modulebonusmicrowarpdrive";
const ATTRIBUTE_SCAN_RESOLUTION =
  getAttributeIDByNames("scanResolution") || 564;
const ATTRIBUTE_CAPACITOR_CAPACITY =
  getAttributeIDByNames("capacitorCapacity") || 482;
const ATTRIBUTE_CAPACITOR_RECHARGE_RATE =
  getAttributeIDByNames("rechargerate", "capacitorRechargeRate") || 55;
const ATTRIBUTE_SHIELD_CAPACITY =
  getAttributeIDByNames("shieldCapacity") || 263;
const ATTRIBUTE_SHIELD_RECHARGE_RATE =
  getAttributeIDByNames("shieldRechargeRate") || 479;
const ATTRIBUTE_ARMOR_HP = getAttributeIDByNames("armorHP") || 265;
const ATTRIBUTE_STRUCTURE_HP = getAttributeIDByNames("hp", "structureHP") || 9;
const ATTRIBUTE_UPGRADE_CAPACITY =
  getAttributeIDByNames("upgradeCapacity") || 1132;
const ATTRIBUTE_UPGRADE_LOAD = getAttributeIDByNames("upgradeLoad") || 1154;
const ATTRIBUTE_TURRET_SLOTS_LEFT =
  getAttributeIDByNames("turretSlotsLeft") || 102;
const ATTRIBUTE_LAUNCHER_SLOTS_LEFT =
  getAttributeIDByNames("launcherSlotsLeft") || 101;
const ATTRIBUTE_LOW_SLOTS = getAttributeIDByNames("lowSlots") || 12;
const ATTRIBUTE_MED_SLOTS = getAttributeIDByNames("medSlots") || 13;
const ATTRIBUTE_HIGH_SLOTS = getAttributeIDByNames("hiSlots") || 14;
const ATTRIBUTE_DRONE_CAPACITY = getAttributeIDByNames("droneCapacity") || 283;
const ATTRIBUTE_MAX_ACTIVE_DRONES = getAttributeIDByNames("maxActiveDrones") || 352;
const ATTRIBUTE_DRONE_CONTROL_DISTANCE =
  getAttributeIDByNames("droneControlDistance") || 458;
const ATTRIBUTE_FIGHTER_CAPACITY = getAttributeIDByNames("fighterCapacity") || 2055;
// charID-domain hull/skill ItemModifier effects are dropped by default because
// their modifier target lives on the pilot rather than the ship. A few of them
// nonetheless resolve to a real ship attribute through the character and must be
// honoured, so they are allow-listed by attribute ID here:
//   * maxActiveDrones (352): the Drones skill's per-level base (effect 316,
//     352 <- maxActiveDroneBonus 353) and the Gallente-Cruiser hull "deploy one
//     additional drone" trait (effect 918, 352 <- shipBonusGC2 658) both ModAdd
//     onto it via charID.
//   * droneControlDistance (458): the Drone Avionics / Advanced Drone Avionics
//     skills and additive hull traits (e.g. the Ishtar's +5 km per Heavy Assault
//     Cruiser level) ModAdd onto it via charID; some hulls instead apply a
//     PostPercent (e.g. the Griffin Navy Issue's -50%). The 20 km base rides
//     along through the attribute's defaultValue once the first bonus introduces
//     458. Fitted drone-control-range modules and rigs (Drone Link Augmentor,
//     the Drone Control Range Augmentor rigs) ModAdd onto it the same way; the
//     passive-module collector consults this allowlist too so they are honoured.
// Scoping the allowance to these exact attributes keeps every other
// currently-dropped charID effect dropped (mining-drone speed 428, module repair
// rate 1267, Fast Talk 359).
const CHAR_DOMAIN_SHIP_ATTRIBUTE_ALLOWLIST = new Set([
  ATTRIBUTE_MAX_ACTIVE_DRONES,
  ATTRIBUTE_DRONE_CONTROL_DISTANCE,
]);
const ATTRIBUTE_SPEED = getAttributeIDByNames("speed") || 51;
const ATTRIBUTE_EM_DAMAGE = getAttributeIDByNames("emDamage") || 114;
const ATTRIBUTE_EXPLOSIVE_DAMAGE = getAttributeIDByNames("explosiveDamage") || 116;
const ATTRIBUTE_KINETIC_DAMAGE = getAttributeIDByNames("kineticDamage") || 117;
const ATTRIBUTE_THERMAL_DAMAGE = getAttributeIDByNames("thermalDamage") || 118;
const ATTRIBUTE_SKILL_LEVEL = getAttributeIDByNames("skillLevel") || 280;
const ATTRIBUTE_DAMAGE_MULTIPLIER = getAttributeIDByNames("damageMultiplier") || 64;
const ATTRIBUTE_DAMAGE_MULTIPLIER_BONUS =
  getAttributeIDByNames("damageMultiplierBonus") || 292;
const ATTRIBUTE_ROF_BONUS = getAttributeIDByNames("rofBonus") || 293;
const MINING_HOLD_ATTRIBUTE_IDS = Object.freeze(
  MINING_HOLD_DEFINITIONS.map((definition) => ({
    resourceKey: definition.resourceKey,
    attributeID: getAttributeIDByNames(...definition.attributeNames) || 0,
  })).filter((entry) => entry.attributeID > 0),
);
const CHARACTER_TYPE_ID = 1373;
// These retail targeting skills grant +1 max locked target per level, but
// that bonus is not present in the simplified local skill/type data we read
// here. Keep targeting parity by filling in the missing attribute metadata.
const SKILL_ATTRIBUTE_BONUS_FALLBACKS = Object.freeze({
  3429: Object.freeze({ maxLockedTargetsBonus: 1 }), // Target Management
  3430: Object.freeze({ maxLockedTargetsBonus: 1 }), // Advanced Target Management
});
const PASSIVE_MODIFIER_EFFECT_CATEGORIES = new Set([0, 4]);
const DOGMA_OP_PRE_ASSIGNMENT = -1;
const DOGMA_OP_PRE_MUL = 0;
const DOGMA_OP_MOD_ADD = 2;
const DOGMA_OP_MOD_SUB = 3;
const DOGMA_OP_POST_MUL = 4;
const DOGMA_OP_POST_PERCENT = 6;
const DOGMA_OP_POST_ASSIGNMENT = 7;
const DOGMA_OP_POST_PERCENT_UNNERFED = 8;
const STACKING_DENOMINATORS = Object.freeze(
  Array.from({ length: 8 }, (_, index) => Math.exp((index / 2.67) ** 2)),
);
const DAMAGE_ATTRIBUTE_BY_SKILL_EFFECT_NAME = Object.freeze({
  missileemdmgbonus: ATTRIBUTE_EM_DAMAGE,
  missileexplosivedmgbonus: ATTRIBUTE_EXPLOSIVE_DAMAGE,
  missilekineticdmgbonus2: ATTRIBUTE_KINETIC_DAMAGE,
  missilethermaldmgbonus: ATTRIBUTE_THERMAL_DAMAGE,
});

function getAttributeTypeRecord(attributeID) {
  const numericAttributeID = toInt(attributeID, 0);
  if (numericAttributeID <= 0) {
    return null;
  }

  const root = getTypeDogmaRoot();
  return (
    (root.attributeTypesByID &&
      root.attributeTypesByID[String(numericAttributeID)]) ||
    null
  );
}

function getShipHardpointCounts(shipTypeID, fittedItems = [], shipID = 0) {
  const numericShipTypeID = toInt(shipTypeID, 0);
  const attributes = readShipFittingBaseAttributes(numericShipTypeID, shipID);
  let turret = toInt(
    attributes[ATTRIBUTE_TURRET_SLOTS_LEFT],
    0,
  );
  let launcher = toInt(
    attributes[ATTRIBUTE_LAUNCHER_SLOTS_LEFT],
    0,
  );
  if (isStrategicCruiserType(numericShipTypeID)) {
    for (const item of getValidStrategicCruiserSubsystems(
      numericShipTypeID,
      fittedItems,
      shipID,
    )) {
      turret += toInt(
        getEffectiveItemAttributeValue(
          item,
          "turretHardPointModifier",
          "turretHardpointModifier",
        ),
        0,
      );
      launcher += toInt(
        getEffectiveItemAttributeValue(
          item,
          "launcherHardPointModifier",
          "launcherHardpointModifier",
        ),
        0,
      );
    }
  }
  return {
    turret: Math.max(0, turret),
    launcher: Math.max(0, launcher),
  };
}

function getStrategicCruiserUseStatus(charID, shipItem, fittedItems = []) {
  const shipID = toInt(shipItem && shipItem.itemID, 0);
  const shipTypeID = toInt(shipItem && shipItem.typeID, 0);
  if (!isStrategicCruiserType(shipTypeID)) {
    return {
      complete: true,
      subsystemStatus: null,
      invalidRegularSlotItems: [],
      turretOverload: 0,
      launcherOverload: 0,
      cpuOverload: 0,
      powerOverload: 0,
      droneBayOverload: 0,
      fighterBayOverload: 0,
    };
  }

  const subsystemStatus = getStrategicCruiserSubsystemStatus(
    shipItem,
    fittedItems,
  );
  const invalidRegularSlotItems = [];
  const occupiedRegularFlags = new Set();
  for (const item of Array.isArray(fittedItems) ? fittedItems : []) {
    if (!item || !isFittedModuleItem(item)) {
      continue;
    }
    const family = getRequiredSlotFamily(item.typeID);
    if (!family || family === "subsystem") {
      continue;
    }
    const flagID = toInt(item.flagID, 0);
    const allowedFlags = getSlotFlagsForFamily(
      family,
      shipTypeID,
      fittedItems,
      shipID,
    );
    if (!allowedFlags.includes(flagID) || occupiedRegularFlags.has(flagID)) {
      invalidRegularSlotItems.push(item);
      continue;
    }
    occupiedRegularFlags.add(flagID);
  }

  const hardpointCounts = getShipHardpointCounts(
    shipTypeID,
    fittedItems,
    shipID,
  );
  const usedTurrets = getFittedEffectSlotsUsed(
    fittedItems,
    "turretFitted",
  );
  const usedLaunchers = getFittedEffectSlotsUsed(
    fittedItems,
    "launcherFitted",
  );
  const resourceState = buildShipResourceState(charID, shipItem, {
    fittedItems,
  });
  const turretOverload = Math.max(0, usedTurrets - hardpointCounts.turret);
  const launcherOverload = Math.max(0, usedLaunchers - hardpointCounts.launcher);
  const cpuOverload = Math.max(
    0,
    round6(
      toFiniteNumber(resourceState.cpuLoad, 0) -
      toFiniteNumber(resourceState.cpuOutput, 0),
    ),
  );
  const powerOverload = Math.max(
    0,
    round6(
      toFiniteNumber(resourceState.powerLoad, 0) -
      toFiniteNumber(resourceState.powerOutput, 0),
    ),
  );
  const getBayUsedVolume = (flagID) => round6(
    (Array.isArray(fittedItems) ? fittedItems : [])
      .filter((item) => toInt(item && item.flagID, 0) === flagID)
      .reduce((sum, item) => {
        const typeRecord = resolveItemByTypeID(toInt(item && item.typeID, 0)) || {};
        const unitVolume = Math.max(
          0,
          toFiniteNumber(item && item.volume, toFiniteNumber(typeRecord.volume, 0)),
        );
        const quantity = toInt(item && item.singleton, 0) === 1
          ? 1
          : Math.max(0, toInt(item && (item.stacksize ?? item.quantity), 0));
        return sum + unitVolume * quantity;
      }, 0),
  );
  const droneBayOverload = Math.max(
    0,
    round6(
      getBayUsedVolume(ITEM_FLAGS.DRONE_BAY) -
      toFiniteNumber(resourceState.droneCapacity, 0),
    ),
  );
  const fighterBayOverload = Math.max(
    0,
    round6(
      getBayUsedVolume(ITEM_FLAGS.FIGHTER_BAY) -
      toFiniteNumber(resourceState.fighterCapacity, 0),
    ),
  );

  return {
    complete:
      subsystemStatus.complete &&
      invalidRegularSlotItems.length === 0 &&
      turretOverload === 0 &&
      launcherOverload === 0 &&
      cpuOverload === 0 &&
      powerOverload === 0 &&
      droneBayOverload === 0 &&
      fighterBayOverload === 0,
    subsystemStatus,
    invalidRegularSlotItems,
    turretOverload,
    launcherOverload,
    cpuOverload,
    powerOverload,
    droneBayOverload,
    fighterBayOverload,
  };
}

function isDogmaAttributeStackable(attributeID) {
  const attributeRecord = getAttributeTypeRecord(attributeID);
  return attributeRecord ? attributeRecord.stackable === true : false;
}

function shouldApplyStackingPenalty(modifiedAttributeID, stackingPenalized) {
  return stackingPenalized === true && !isDogmaAttributeStackable(modifiedAttributeID);
}

// A handful of effects carry no modifierInfo in the SDE because the client
// hardcodes their modifiers in Python instead of declaring them as data. The
// dogma engine here is data-driven, so those effects apply nothing at all
// unless the missing rows are supplied.
//
// Each entry below is transcribed from the decompiled client's own effect
// class, not inferred. Keep the citation with the entry — it is the only
// evidence that these values are right.
const CLIENT_PYTHON_EFFECT_MODIFIER_INFO = Object.freeze({
  // eve/common/script/dogma/pythonEffects/adaptiveHardener.py
  //   class BaseAdaptiveHardener, MODIFIER_CHANGES:
  //     (dgmAssPreMul, attributeArmor<Type>DamageResonance,
  //      attributeArmor<Type>DamageResonance) for EM, Explosive, Kinetic, Thermal
  // dgmAssPreMul is dogma operation 0 — the same operation the Damage Control
  // uses for these four attributes, which is how the pathway is known to work.
  4928: Object.freeze([
    Object.freeze({
      domain: "shipID", modifiedAttributeID: 267, operation: 0,
      modifyingAttributeID: 267, func: "ItemModifier",
    }),
    Object.freeze({
      domain: "shipID", modifiedAttributeID: 268, operation: 0,
      modifyingAttributeID: 268, func: "ItemModifier",
    }),
    Object.freeze({
      domain: "shipID", modifiedAttributeID: 269, operation: 0,
      modifyingAttributeID: 269, func: "ItemModifier",
    }),
    Object.freeze({
      domain: "shipID", modifiedAttributeID: 270, operation: 0,
      modifyingAttributeID: 270, func: "ItemModifier",
    }),
  ]),
  // eve/common/script/dogma/pythonEffects/emergencyHullEnergizer.py
  //   class EmergencyHullEnergizer, MODIFIER_CHANGES:
  //     (dgmAssPostMul, attribute<Type>DamageResonance,
  //      attributeHull<Type>DamageResonance) for EM, Thermal, Kinetic, Explosive
  // Note the asymmetry, which is the whole point of the module: the SOURCE is
  // the module's hull resonance and the TARGET is the ship's structure
  // resonance, so a 0.05 hull figure becomes 95% structure resistance.
  // dgmAssPostMul is dogma operation 4 — both the operation numbering and every
  // attribute ID below are read from the client's own dogma/const.py.
  6484: Object.freeze([
    Object.freeze({
      domain: "shipID", modifiedAttributeID: 113, operation: 4,
      modifyingAttributeID: 974, func: "ItemModifier",
    }),
    Object.freeze({
      domain: "shipID", modifiedAttributeID: 110, operation: 4,
      modifyingAttributeID: 977, func: "ItemModifier",
    }),
    Object.freeze({
      domain: "shipID", modifiedAttributeID: 109, operation: 4,
      modifyingAttributeID: 976, func: "ItemModifier",
    }),
    Object.freeze({
      domain: "shipID", modifiedAttributeID: 111, operation: 4,
      modifyingAttributeID: 975, func: "ItemModifier",
    }),
  ]),
  // eve/common/script/dogma/pythonEffects/warpDisruptSphere.py
  //   class BaseWarpDisruptSphere:
  //     MODIFIER_CHANGES = [
  //       (dgmAssPostPercent, attributeMass, attributeMassBonusPercentage),
  //       (dgmAssPostPercent, attributeMaxVelocity, attributeVelocityModifier),
  //       (dgmAssPostPercent, attributeSignatureRadius, attributeSignatureRadiusBonus)]
  //     LOCATION_AND_GROUP_MODIFIER_CHANGES = [
  //       (dgmAssPostPercent, groupPropulsionModule,
  //        attributeSpeedBoostFactor, attributeSpeedBoostFactorBonus),
  //       (dgmAssPostPercent, groupPropulsionModule,
  //        attributeSpeedFactor, attributeSpeedFactorBonus)]
  //   Start() runs AddModifiersOnStart -> AddLocationGroupModifiers +
  //   AddModifiers against shipID, and Stop() removes them again, so these are
  //   ship-domain modifiers that live exactly as long as the cycle.
  //   dgmAssPostPercent is dogma operation 6. Attribute IDs are read from the
  //   client's own dogma/const.py: mass 4, maxVelocity 37, signatureRadius 552,
  //   speedFactor 20, speedBoostFactor 567, massBonusPercentage 1131,
  //   velocityModifier 1076, signatureRadiusBonus 554, speedFactorBonus 1164,
  //   speedBoostFactorBonus 1270; groupPropulsionModule is group 46.
  //   Only signatureRadiusBonus is non-zero on any of the eight published
  //   warp disruption field generators today (+50%, +40% on the Clutch
  //   Restrained) — that penalty is the module's entire drawback in bubble
  //   mode. The other four are transcribed because the effect declares them,
  //   not because they currently bite.
  3380: Object.freeze([
    Object.freeze({
      domain: "shipID", modifiedAttributeID: 4, operation: 6,
      modifyingAttributeID: 1131, func: "ItemModifier",
    }),
    Object.freeze({
      domain: "shipID", modifiedAttributeID: 37, operation: 6,
      modifyingAttributeID: 1076, func: "ItemModifier",
    }),
    Object.freeze({
      domain: "shipID", modifiedAttributeID: 552, operation: 6,
      modifyingAttributeID: 554, func: "ItemModifier",
    }),
    Object.freeze({
      domain: "shipID", modifiedAttributeID: 567, operation: 6,
      modifyingAttributeID: 1270, func: "LocationGroupModifier", groupID: 46,
    }),
    Object.freeze({
      domain: "shipID", modifiedAttributeID: 20, operation: 6,
      modifyingAttributeID: 1164, func: "LocationGroupModifier", groupID: 46,
    }),
  ]),
  // eve/client/script/ui/shared/fittingScreen/pythonEffects.py
  //   class FakeEntosisLinkEffect, __guid__ 'dogmaXP.Effect_6063',
  //   __effectIDs__ [6063], MODIFIER_CHANGES:
  //     (dgmAssPostPercent, attributeScanRadarStrength,
  //      attributeScanRadarStrengthPercent)
  //     (dgmAssPostPercent, attributeScanMagnetometricStrength,
  //      attributeScanMagnetometricStrengthPercent)
  //     (dgmAssPostPercent, attributeScanGravimetricStrength,
  //      attributeScanGravimetricStrengthPercent)
  //     (dgmAssPostPercent, attributeScanLadarStrength,
  //      attributeScanLadarStrengthPercent)
  //   Start() calls AddModifiers(dogmaLM, shipID, itemID) and Stop() removes
  //   them, so these are ship-domain modifiers that live exactly as long as the
  //   cycle. dgmAssPostPercent is dogma operation 6. Attribute IDs from the
  //   client's own dogma/const.py: scanRadarStrength 208, scanLadarStrength 209,
  //   scanMagnetometricStrength 210, scanGravimetricStrength 211, and the four
  //   *Percent sources 1027 (gravimetric), 1028 (ladar), 1029 (magnetometric),
  //   1030 (radar).
  //   All six published Entosis Links declare 100 on all four percentages, which
  //   is CCP's March 2018 anti-ECM change: +100% sensor strength while the link
  //   is cycling. The class is marked isPythonEffect = False because the live
  //   effect is data-driven dogma server-side; this copy exists so the fitting
  //   simulator can preview it, and it is the only surviving statement of the
  //   rows the SDE ships empty.
  6063: Object.freeze([
    Object.freeze({
      domain: "shipID", modifiedAttributeID: 208, operation: 6,
      modifyingAttributeID: 1030, func: "ItemModifier",
    }),
    Object.freeze({
      domain: "shipID", modifiedAttributeID: 210, operation: 6,
      modifyingAttributeID: 1029, func: "ItemModifier",
    }),
    Object.freeze({
      domain: "shipID", modifiedAttributeID: 211, operation: 6,
      modifyingAttributeID: 1027, func: "ItemModifier",
    }),
    Object.freeze({
      domain: "shipID", modifiedAttributeID: 209, operation: 6,
      modifyingAttributeID: 1028, func: "ItemModifier",
    }),
  ]),
  // eve/common/script/dogma/pythonEffects/microJumpDrive.py
  //   class BaseMicroJumpDrive, __effectIDs__ ['effectMicroJumpDrive',
  //   'effectFighterMicroJumpDrive'], Start() calls
  //     AddSignatureRadiusBonusPercentModifier(dogmaLM, itemID, shipID)
  //   which is
  //     dogmaLM.AddModifier(dgmAssPostPercent, shipID, attributeSignatureRadius,
  //                         itemID, attributeSignatureRadiusBonusPercent)
  //   and Stop()/RestrictedStop() remove it, so this is a ship-domain modifier
  //   that lives exactly as long as the spool. dgmAssPostPercent is dogma
  //   operation 6; attributeSignatureRadius is 552 and
  //   attributeSignatureRadiusBonusPercent is 973, both read from the client's
  //   own dogma/const.py.
  //
  //   Every published Micro Jump Drive and Micro Jump Field Generator declares
  //   973: 150 on the five tech-1 types and 120 on the three Xarasier ones, so a
  //   spooling ship blooms to 2.5x (2.2x) its signature radius for the whole
  //   spool and shrinks back the instant the jump lands. EVE University states
  //   it in the same terms: "The signature radius of the ship is also increased
  //   by 150% during the spool-up time."
  //   (https://wiki.eveuniversity.org/Propulsion_equipment)
  4921: Object.freeze([
    Object.freeze({
      domain: "shipID", modifiedAttributeID: 552, operation: 6,
      modifyingAttributeID: 973, func: "ItemModifier",
    }),
  ]),
  // eve/common/script/dogma/pythonEffects/microJumpPortalDrive.py
  //   class BaseMicroJumpPortalDrive, __effectIDs__
  //   ['effectMicroJumpPortalDrive', 'effectMicroJumpPortalDriveCapital'] — one
  //   class for BOTH portal effects, which is why 6208 and 12126 carry
  //   identical rows below. Start() calls
  //     AddDisallowTetheringModifier(dogmaLM, itemID, shipID)
  //     AddSignatureRadiusBonusPercentModifier(dogmaLM, itemID, shipID)
  //   the second being imported verbatim from microJumpDrive.py, the first being
  //     dogmaLM.AddModifier(dgmAssModAdd, shipID, attributeDisallowTethering,
  //                         itemID, attributeDisallowTethering)
  //   dgmAssModAdd is dogma operation 2 and attributeDisallowTethering is 2343,
  //   both from dogma/const.py. Note the modifier is self-sourced: the module's
  //   own 2343 (declared 1 on both Micro Jump Field Generators and on no Micro
  //   Jump Drive) is added onto the ship's, which is what
  //   shipModifierEntriesSetPositiveAttribute reads to raise disallowsTethering.
  6208: Object.freeze([
    Object.freeze({
      domain: "shipID", modifiedAttributeID: 552, operation: 6,
      modifyingAttributeID: 973, func: "ItemModifier",
    }),
    Object.freeze({
      domain: "shipID", modifiedAttributeID: 2343, operation: 2,
      modifyingAttributeID: 2343, func: "ItemModifier",
    }),
  ]),
  // Same class, same rows — see 6208 above.
  12126: Object.freeze([
    Object.freeze({
      domain: "shipID", modifiedAttributeID: 552, operation: 6,
      modifyingAttributeID: 973, func: "ItemModifier",
    }),
    Object.freeze({
      domain: "shipID", modifiedAttributeID: 2343, operation: 2,
      modifyingAttributeID: 2343, func: "ItemModifier",
    }),
  ]),
  // eve/common/script/dogma/pythonEffects/migratedeffects.py
  //   class CloakingTargetingDelayBonusPostPercentCloakingTargetingDelayBonus
  //         ForShipModulesRequiringCloaking, __effectIDs__ [848]:
  //     modifyingAttributeID = attributeCloakingTargetingDelayBonus
  //     modifiedAttributeID  = attributeCloakingTargetingDelay
  //     operation            = dgmAssPostPercent
  //     Start() -> env.dogmaLM.AddLocationRequiredSkillModifier(
  //                  self.operation, shipID, affectedSkillID,
  //                  self.modifiedAttributeID, affectingModuleID,
  //                  self.modifyingAttributeID)
  //   with affectedSkillID = env.itemTypeID — the item carrying the effect is
  //   the Cloaking skill itself, type 11579, so the required skill IS 11579.
  //   dgmAssPostPercent is dogma operation 6; attributeCloakingTargetingDelay is
  //   560 and attributeCloakingTargetingDelayBonus 619, both from dogma/const.py.
  //
  //   The Cloaking skill is the only carrier of 848. It declares 619 = -10 and
  //   effect 850 pre-multiplies that by the trained level, so this is the skill's
  //   own in-game line: "10% reduction in targeting delay after uncloaking per
  //   skill level" (https://everef.net/types/11579). At Cloaking V an Improved
  //   Cloaking Device II goes 20 s -> 10 s. Reach is exactly the 14 published
  //   cloaking devices: nothing else in the SDE requires skill 11579.
  848: Object.freeze([
    Object.freeze({
      domain: "shipID", modifiedAttributeID: 560, operation: 6,
      modifyingAttributeID: 619, func: "LocationRequiredSkillModifier",
      skillTypeID: 11579,
    }),
  ]),
});

const patchedClientPythonEffectRecords = new Map();

function getEffectTypeRecord(effectID) {
  const numericEffectID = toInt(effectID, 0);
  if (numericEffectID <= 0) {
    return null;
  }

  const root = getTypeDogmaRoot();
  const record =
    (root.effectTypesByID && root.effectTypesByID[String(numericEffectID)]) ||
    null;
  if (!record) {
    return null;
  }

  const clientModifierInfo = CLIENT_PYTHON_EFFECT_MODIFIER_INFO[numericEffectID];
  // Only fill in for an effect the SDE really left empty. If CCP ever ships the
  // rows, theirs win and this becomes a no-op rather than an override.
  if (!clientModifierInfo || (record.modifierInfo || []).length > 0) {
    return record;
  }

  const patched = patchedClientPythonEffectRecords.get(numericEffectID);
  if (patched && patched.source === record) {
    return patched.value;
  }
  const value = Object.freeze({ ...record, modifierInfo: clientModifierInfo });
  patchedClientPythonEffectRecords.set(numericEffectID, { source: record, value });
  return value;
}

function getTypeEffectRecords(typeID) {
  const numericTypeID = toInt(typeID, 0);
  if (numericTypeID <= 0) {
    return [];
  }

  const cache = ensureTypeEffectRecordCache();
  const cached = cache.get(numericTypeID);
  if (cached) {
    return cached;
  }

  const effectRecords = Object.freeze(
    [...getTypeDogmaEffects(numericTypeID)]
      .map((effectID) => getEffectTypeRecord(effectID))
      .filter(Boolean),
  );
  cache.set(numericTypeID, effectRecords);
  return effectRecords;
}

function getTypeAttributeMap(typeID) {
  return cloneAttributeMap(getNormalizedTypeAttributeMap(typeID));
}

function cloneAttributeMap(source = {}) {
  return Object.fromEntries(
    Object.entries(source || {}).map(([attributeID, value]) => [
      Number(attributeID),
      Number(value),
    ]),
  );
}

function parseDynamicItemCustomInfo(item) {
  if (!item || typeof item !== "object" || !item.customInfo) {
    return null;
  }
  try {
    const parsed = JSON.parse(String(item.customInfo || ""));
    const metadata = parsed && parsed[DYNAMIC_ITEM_CUSTOM_INFO_KEY];
    return metadata && typeof metadata === "object" ? metadata : null;
  } catch (error) {
    // ignored: customInfo that is not JSON holds no dynamic item data (null)
    return null;
  }
}

function getDynamicItemSourceTypeID(item) {
  const metadata = parseDynamicItemCustomInfo(item);
  return toInt(metadata && metadata.sourceTypeID, 0);
}

function getDynamicItemAttributeOverrides(item) {
  const metadata = parseDynamicItemCustomInfo(item);
  const source = metadata && typeof metadata.attributes === "object"
    ? metadata.attributes
    : null;
  if (!source) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(source)
      .map(([attributeID, value]) => [
        toInt(attributeID, 0),
        toFiniteNumber(value, NaN),
      ])
      .filter(([attributeID, value]) => attributeID > 0 && Number.isFinite(value)),
  );
}

function getRequiredSkillTypeIDs(itemOrTypeID) {
  // requiredSkill1..6 are intrinsic TYPE attributes — dynamic (mutaplasmid)
  // overrides and other-item modifiers never change skill requirements — so read
  // the frozen, cached normalized type map directly. The previous object path
  // cloned a full effective attribute map per call, and this is invoked per skill
  // x per module by moduleRequiresSkillType during passive-modifier collection,
  // which made cloneAttributeMap ~50% of buildShipResourceState.
  const typeID =
    itemOrTypeID && typeof itemOrTypeID === "object"
      ? (getDynamicItemSourceTypeID(itemOrTypeID) || toInt(itemOrTypeID.typeID, 0))
      : toInt(itemOrTypeID, 0);
  // Memoised on the RESOLVED typeID, which is what the dynamic-item branch above
  // exists to produce, so a mutaplasmid-rolled module keys off the source type it
  // inherits its skill requirements from. Frozen because the array is shared now:
  // the sole caller (`moduleRequiresSkillType`) only reads it, and freezing keeps
  // it that way.
  if (!cachedRequiredSkillTypeIDsByTypeID) {
    cachedRequiredSkillTypeIDsByTypeID = new Map();
  }
  if (cachedRequiredSkillTypeIDsByTypeID.has(typeID)) {
    return cachedRequiredSkillTypeIDsByTypeID.get(typeID);
  }
  const attributeMap = getNormalizedTypeAttributeMap(typeID);
  const requiredSkillTypeIDs = [];
  for (let index = 1; index <= 6; index += 1) {
    const requiredSkillTypeID = toInt(
      attributeMap[getAttributeIDByNames(`requiredSkill${index}`)],
      0,
    );
    if (requiredSkillTypeID > 0) {
      requiredSkillTypeIDs.push(requiredSkillTypeID);
    }
  }
  const frozen = Object.freeze(requiredSkillTypeIDs);
  cachedRequiredSkillTypeIDsByTypeID.set(typeID, frozen);
  return frozen;
}

function buildHullBonusSkillMap(shipTypeID, skillMap = new Map()) {
  const resolvedSkillMap = skillMap instanceof Map ? skillMap : new Map();
  const missingBonusSkillTypeIDs = getHullBonusSkillTypeIDs(shipTypeID)
    .filter((skillTypeID) => !resolvedSkillMap.has(skillTypeID));
  if (missingBonusSkillTypeIDs.length <= 0) {
    return resolvedSkillMap;
  }

  // Hull source attributes store the per-level bonus magnitude. Every declared
  // typeBonus skill must therefore participate as level zero when it is absent;
  // otherwise the raw source value leaks through and behaves like level I.
  // Keep these synthetic records local to hull-bonus evaluation so support and
  // module skills, validation, and the authoritative character map are unchanged.
  const hullBonusSkillMap = new Map(resolvedSkillMap);
  for (const skillTypeID of missingBonusSkillTypeIDs) {
    hullBonusSkillMap.set(skillTypeID, {
      typeID: skillTypeID,
      skillLevel: 0,
      trainedSkillLevel: 0,
      effectiveSkillLevel: 0,
    });
  }
  return hullBonusSkillMap;
}

function moduleRequiresSkillType(moduleItem, skillTypeID) {
  if (!moduleItem || !skillTypeID) {
    return false;
  }
  return getRequiredSkillTypeIDs(moduleItem).includes(toInt(skillTypeID, 0));
}

// An effect that declares both a cycle time and a capacitor cost is paid for
// per activation, so it must not also be handed out for free while the module
// merely sits online. warpCoreStabilizerActive is the case in point: the SDE
// files it under category 4 (online) but it is a manually activated 10 s cycle,
// and treating it as passive gave the ship its +2 warp core strength
// permanently instead of only while the module was running.
function isActivationPricedEffectRecord(effectRecord) {
  return (
    toInt(effectRecord && effectRecord.durationAttributeID, 0) > 0 &&
    toInt(effectRecord && effectRecord.dischargeAttributeID, 0) > 0
  );
}

function getPassiveModifierEffectRecords(typeID) {
  return getTypeEffectRecords(typeID).filter((effectRecord) => (
    PASSIVE_MODIFIER_EFFECT_CATEGORIES.has(
      toInt(effectRecord && effectRecord.effectCategoryID, 0),
    ) &&
    !isActivationPricedEffectRecord(effectRecord) &&
    Array.isArray(effectRecord && effectRecord.modifierInfo) &&
    effectRecord.modifierInfo.some(Boolean)
  ));
}

function isPassiveModifierSource(item) {
  if (!item || !isFittedModuleItem(item)) {
    return false;
  }

  const family = getRequiredSlotFamily(item.typeID);
  if (family === "rig" || family === "subsystem") {
    return true;
  }

  return (
    isEffectivelyOnlineModule(item) &&
    getPassiveModifierEffectRecords(item.typeID).length > 0
  );
}

function buildEffectiveItemAttributeMap(itemOrTypeID, otherItem = null) {
  const typeID =
    itemOrTypeID && typeof itemOrTypeID === "object"
      ? toInt(itemOrTypeID.typeID, 0)
      : toInt(itemOrTypeID, 0);
  const sourceTypeID =
    itemOrTypeID && typeof itemOrTypeID === "object"
      ? getDynamicItemSourceTypeID(itemOrTypeID)
      : 0;
  const attributes = getTypeAttributeMap(sourceTypeID || typeID);
  if (itemOrTypeID && typeof itemOrTypeID === "object") {
    Object.assign(attributes, getDynamicItemAttributeOverrides(itemOrTypeID));
  }
  applyOtherItemModifiersToAttributes(attributes, otherItem);
  return attributes;
}

function getEffectiveItemAttributeValue(itemOrTypeID, ...attributeNames) {
  const attributeID = getAttributeIDByNames(...attributeNames);
  if (!attributeID) {
    return undefined;
  }
  const attributeMap =
    itemOrTypeID && typeof itemOrTypeID === "object"
      ? buildEffectiveItemAttributeMap(itemOrTypeID)
      : getTypeAttributeMap(itemOrTypeID);
  return attributeMap[attributeID];
}

function applyOtherItemModifiersToAttributes(attributes, otherItem) {
  if (!attributes || !otherItem || toInt(otherItem.typeID, 0) <= 0) {
    return attributes;
  }

  const otherAttributes = buildEffectiveItemAttributeMap(otherItem);
  const modifiedAttributeIDs = new Set();
  for (const effectRecord of getTypeEffectRecords(otherItem.typeID)) {
    for (const modifierInfo of effectRecord.modifierInfo || []) {
      if (
        !modifierInfo ||
        modifierInfo.func !== "ItemModifier" ||
        modifierInfo.domain !== "otherID"
      ) {
        continue;
      }

      applyDogmaModifier(
        attributes,
        modifierInfo.modifiedAttributeID,
        modifierInfo.operation,
        otherAttributes[toInt(modifierInfo.modifyingAttributeID, 0)],
      );
      modifiedAttributeIDs.add(toInt(modifierInfo.modifiedAttributeID, 0));
    }
  }

  // DELIBERATE — repo owner's decision, 2026-08-10. Dogma chain outputs are
  // normalized to 6 dp, guarded by two conditions: |value| >= 1e-2 rounds
  // unconditionally, and below that floor a 6-dp round is declined if it would
  // move the value by more than 1e-6 relative. See the sibling block at the end
  // of applyModifierGroups for the full rationale; this second call site is the
  // non-obvious one. Charge-on-module modifiers are a complete chain in their
  // own right: a script's duration multiplier arrives via
  // buildEffectiveItemAttributeMap and never reaches applyModifierGroups, which
  // is why the Focused Warp Disruption Script cycle stayed dirty when only the
  // other call site was present. Normalizing inside the loop instead would
  // round between a type's stacked modifierInfo rows, which is a different
  // number. Do not remove: this has already been reverted once (68dfc49d) and
  // restored by owner decision.
  for (const attributeID of modifiedAttributeIDs) {
    if (attributeID <= 0) {
      continue;
    }
    const value = attributes[attributeID];
    if (typeof value === "number") {
      attributes[attributeID] = normalizeDogmaFloat(value);
    }
  }

  return attributes;
}

function appendDirectModifierEntries(
  destination,
  sourceAttributes,
  sourceEffects,
  sourceKind,
  options = {},
) {
  const allowedDomains = options.allowedDomains instanceof Set
    ? options.allowedDomains
    : new Set(["shipID"]);
  const allowedFuncs = options.allowedFuncs instanceof Set
    ? options.allowedFuncs
    : new Set(["ItemModifier"]);
  // Opt-in: charID-domain modifiers are dropped unless their modified attribute
  // is explicitly allow-listed here (see CHAR_DOMAIN_SHIP_ATTRIBUTE_ALLOWLIST).
  const charDomainAllowedAttributeIDs =
    options.charDomainAllowedAttributeIDs instanceof Set
      ? options.charDomainAllowedAttributeIDs
      : null;
  const stackingPenalized = options.stackingPenalized !== undefined
    ? options.stackingPenalized === true
    : sourceKind === "fittedModule";

  for (const effectRecord of Array.isArray(sourceEffects) ? sourceEffects : []) {
    for (const modifierInfo of effectRecord.modifierInfo || []) {
      if (!modifierInfo || !allowedFuncs.has(String(modifierInfo.func || ""))) {
        continue;
      }
      const domain = String(modifierInfo.domain || "");
      const domainAllowed =
        allowedDomains.has(domain) ||
        (domain === "charID" &&
          charDomainAllowedAttributeIDs !== null &&
          charDomainAllowedAttributeIDs.has(
            toInt(modifierInfo.modifiedAttributeID, 0),
          ));
      if (!domainAllowed) {
        continue;
      }

      const value = toFiniteNumber(
        sourceAttributes && sourceAttributes[modifierInfo.modifyingAttributeID],
        NaN,
      );
      if (!Number.isFinite(value)) {
        continue;
      }

      destination.push({
        modifiedAttributeID: modifierInfo.modifiedAttributeID,
        operation: modifierInfo.operation,
        value,
        stackingPenalized: shouldApplyStackingPenalty(
          modifierInfo.modifiedAttributeID,
          stackingPenalized,
        ),
      });
    }
  }
}

function appendSelfItemModifierEntries(
  destination,
  sourceAttributes,
  sourceEffects,
  sourceKind,
) {
  appendDirectModifierEntries(
    destination,
    sourceAttributes,
    sourceEffects,
    sourceKind,
    {
      allowedDomains: new Set(["itemID"]),
      allowedFuncs: new Set(["ItemModifier"]),
      stackingPenalized: false,
    },
  );
}

const OVERLOAD_EFFECT_CATEGORY_ID = 5;

// Overload rides in the same active-module-context list as a module's ordinary
// active effect, tagged either by effectState.isOverload or by its own effect
// category. Index those records by the module they belong to so a projection can
// find the ones that raise its source strength.
function indexOverloadEffectRecordsByModuleID(activeModuleContexts) {
  const recordsByModuleID = new Map();
  for (const context of Array.isArray(activeModuleContexts) ? activeModuleContexts : []) {
    if (!context) {
      continue;
    }
    const effectRecord = context.effectRecord || null;
    if (!effectRecord) {
      continue;
    }
    const isOverload =
      (context.effectState && context.effectState.isOverload === true) ||
      toInt(effectRecord.effectCategoryID, 0) === OVERLOAD_EFFECT_CATEGORY_ID;
    if (!isOverload) {
      continue;
    }
    const moduleID = toInt(
      (context.moduleItem && context.moduleItem.itemID) ||
        (context.effectState && context.effectState.moduleID),
      0,
    );
    if (moduleID <= 0) {
      continue;
    }
    if (!recordsByModuleID.has(moduleID)) {
      recordsByModuleID.set(moduleID, []);
    }
    recordsByModuleID.get(moduleID).push(effectRecord);
  }
  return recordsByModuleID;
}

// Source attributes for projecting a fitted module's bonus onto something else —
// a drone, a fighter, or another module.
//
// buildEffectiveItemAttributeMap on its own is base type attributes plus charge
// overrides, so an overloaded module would keep projecting its cold strength for
// ever: overload raises the bonus through the module's own ItemModifier
// self-effects, and those have to be folded in before the projection reads them.
// Scripts were never affected because they arrive through chargeItem, which
// buildEffectiveItemAttributeMap already applies.
function buildProjectedModuleSourceAttributeMap(
  moduleItem,
  chargeItem = null,
  overloadEffectRecords = null,
) {
  const sourceAttributes = buildEffectiveItemAttributeMap(moduleItem, chargeItem);
  if (!Array.isArray(overloadEffectRecords) || overloadEffectRecords.length === 0) {
    return sourceAttributes;
  }
  const selfModifierEntries = [];
  appendSelfItemModifierEntries(
    selfModifierEntries,
    sourceAttributes,
    overloadEffectRecords,
    "fittedModule",
  );
  applyModifierGroups(sourceAttributes, selfModifierEntries);
  return sourceAttributes;
}

function appendLocationModifierEntries(
  destination,
  sourceAttributes,
  sourceEffects,
  sourceKind,
  moduleItem,
  options = {},
) {
  const allowedDomains = options.allowedDomains instanceof Set
    ? options.allowedDomains
    : new Set(["shipID", "charID"]);
  const sourceTypeID = toInt(options.sourceTypeID, 0);
  for (const effectRecord of Array.isArray(sourceEffects) ? sourceEffects : []) {
    const normalizedEffectName = String(effectRecord && effectRecord.name || "")
      .trim()
      .toLowerCase();
    if (
      normalizedEffectName === "dronedmgbonus" &&
      sourceTypeID > 0 &&
      moduleRequiresSkillType(moduleItem, sourceTypeID)
    ) {
      const value = toFiniteNumber(
        sourceAttributes && sourceAttributes[ATTRIBUTE_DAMAGE_MULTIPLIER_BONUS],
        NaN,
      );
      if (Number.isFinite(value)) {
        destination.push({
          modifiedAttributeID: ATTRIBUTE_DAMAGE_MULTIPLIER,
          operation: DOGMA_OP_POST_PERCENT,
          value,
          stackingPenalized: false,
        });
      }
    }
    const missileDamageAttributeID =
      DAMAGE_ATTRIBUTE_BY_SKILL_EFFECT_NAME[normalizedEffectName] || 0;
    if (
      missileDamageAttributeID > 0 &&
      sourceTypeID > 0 &&
      moduleRequiresSkillType(moduleItem, sourceTypeID)
    ) {
      const value = toFiniteNumber(
        sourceAttributes && sourceAttributes[ATTRIBUTE_DAMAGE_MULTIPLIER_BONUS],
        NaN,
      );
      if (Number.isFinite(value)) {
        destination.push({
          modifiedAttributeID: missileDamageAttributeID,
          operation: DOGMA_OP_POST_PERCENT,
          value,
          stackingPenalized: false,
        });
      }
    }
    if (
      normalizedEffectName === "selfrof" &&
      sourceTypeID > 0 &&
      moduleRequiresSkillType(moduleItem, sourceTypeID) &&
      typeHasEffectName(moduleItem && moduleItem.typeID, "launcherFitted")
    ) {
      const value = toFiniteNumber(
        sourceAttributes && sourceAttributes[ATTRIBUTE_ROF_BONUS],
        NaN,
      );
      if (Number.isFinite(value)) {
        destination.push({
          modifiedAttributeID: ATTRIBUTE_SPEED,
          operation: DOGMA_OP_POST_PERCENT,
          value,
          stackingPenalized: false,
        });
      }
    }

    for (const modifierInfo of effectRecord.modifierInfo || []) {
      const func = String(modifierInfo.func || "");
      if (
        func !== "LocationRequiredSkillModifier" &&
        func !== "LocationGroupModifier" &&
        func !== "LocationModifier" &&
        func !== "OwnerRequiredSkillModifier"
      ) {
        continue;
      }

      const domain = String(modifierInfo.domain || "");
      if (!allowedDomains.has(domain)) {
        continue;
      }
      if (
        modifierInfo.skillTypeID &&
        !moduleRequiresSkillType(moduleItem, modifierInfo.skillTypeID)
      ) {
        continue;
      }
      if (
        modifierInfo.groupID &&
        toInt(moduleItem && moduleItem.groupID, 0) !== toInt(modifierInfo.groupID, 0)
      ) {
        continue;
      }

      const value = toFiniteNumber(
        sourceAttributes && sourceAttributes[modifierInfo.modifyingAttributeID],
        NaN,
      );
      if (!Number.isFinite(value)) {
        continue;
      }

      destination.push({
        modifiedAttributeID: modifierInfo.modifiedAttributeID,
        operation: modifierInfo.operation,
        value,
        stackingPenalized: shouldApplyStackingPenalty(
          modifierInfo.modifiedAttributeID,
          sourceKind === "fittedModule",
        ),
      });
    }
  }
}

function readShipBaseAttributeMap(shipTypeID, shipItem = null, shipMetadata = null) {
  const baseAttributes = Object.fromEntries(
    Object.entries(readShipBaseAttributes(shipTypeID))
      .map(([attributeID, value]) => [Number(attributeID), Number(value)])
      .filter(
        ([attributeID, value]) =>
          Number.isInteger(attributeID) && Number.isFinite(value),
      ),
  );

  const resolvedMetadata =
    shipMetadata || resolveItemByTypeID(toInt(shipTypeID, 0)) || null;
  const fallbackFields = [
    [ATTRIBUTE_CAPACITY, shipItem && shipItem.capacity, resolvedMetadata && resolvedMetadata.capacity],
    [ATTRIBUTE_MASS, shipItem && shipItem.mass, resolvedMetadata && resolvedMetadata.mass],
    [ATTRIBUTE_STRUCTURE_HP, shipItem && shipItem.hp, resolvedMetadata && resolvedMetadata.hp],
  ];
  for (const [attributeID, firstValue, secondValue] of fallbackFields) {
    if (baseAttributes[attributeID] !== undefined) {
      continue;
    }
    const resolvedValue = toFiniteNumber(firstValue, NaN);
    if (Number.isFinite(resolvedValue)) {
      baseAttributes[attributeID] = resolvedValue;
      continue;
    }
    const metadataValue = toFiniteNumber(secondValue, NaN);
    if (Number.isFinite(metadataValue)) {
      baseAttributes[attributeID] = metadataValue;
    }
  }

  return baseAttributes;
}

function applyAdditiveModifier(attributes, attributeID, value) {
  const numericAttributeID = toInt(attributeID, 0);
  const baseValue = toFiniteNumber(attributes[numericAttributeID], NaN);
  const additiveValue = toFiniteNumber(value, NaN);
  if (
    numericAttributeID <= 0 ||
    !Number.isFinite(baseValue) ||
    !Number.isFinite(additiveValue)
  ) {
    return;
  }

  attributes[numericAttributeID] = baseValue + additiveValue;
}

function applyDirectMultiplier(attributes, attributeID, multiplier) {
  const numericAttributeID = toInt(attributeID, 0);
  const baseValue = toFiniteNumber(attributes[numericAttributeID], NaN);
  const multiplierValue = toFiniteNumber(multiplier, NaN);
  if (
    numericAttributeID <= 0 ||
    !Number.isFinite(baseValue) ||
    !Number.isFinite(multiplierValue)
  ) {
    return;
  }

  attributes[numericAttributeID] = baseValue * multiplierValue;
}

function applyDogmaModifier(attributes, attributeID, operation, value) {
  const numericAttributeID = toInt(attributeID, 0);
  const numericOperation = toInt(operation, -1);
  const numericValue = toFiniteNumber(value, NaN);
  if (
    numericAttributeID <= 0 ||
    (numericOperation < 0 && numericOperation !== DOGMA_OP_PRE_ASSIGNMENT) ||
    !Number.isFinite(numericValue)
  ) {
    return;
  }

  const currentValue = toFiniteNumber(attributes[numericAttributeID], NaN);
  switch (numericOperation) {
    case DOGMA_OP_PRE_ASSIGNMENT: {
      attributes[numericAttributeID] = numericValue;
      break;
    }
    case DOGMA_OP_PRE_MUL:
    case DOGMA_OP_POST_MUL: {
      const baseValue = resolveModifierBaseValue(currentValue, numericAttributeID, 1);
      attributes[numericAttributeID] = baseValue * numericValue;
      break;
    }
    case DOGMA_OP_MOD_ADD: {
      const baseValue = resolveModifierBaseValue(currentValue, numericAttributeID, 0);
      attributes[numericAttributeID] = baseValue + numericValue;
      break;
    }
    case DOGMA_OP_MOD_SUB: {
      const baseValue = resolveModifierBaseValue(currentValue, numericAttributeID, 0);
      attributes[numericAttributeID] = baseValue - numericValue;
      break;
    }
    case 5: {
      const baseValue = resolveModifierBaseValue(currentValue, numericAttributeID, 1);
      if (Math.abs(numericValue) > 1e-9) {
        attributes[numericAttributeID] = baseValue / numericValue;
      }
      break;
    }
    case DOGMA_OP_POST_PERCENT: {
      const baseValue = resolveModifierBaseValue(currentValue, numericAttributeID, 0);
      attributes[numericAttributeID] = baseValue * (1 + numericValue / 100);
      break;
    }
    case DOGMA_OP_POST_ASSIGNMENT: {
      attributes[numericAttributeID] = numericValue;
      break;
    }
    case DOGMA_OP_POST_PERCENT_UNNERFED: {
      const baseValue = resolveModifierBaseValue(currentValue, numericAttributeID, 0);
      attributes[numericAttributeID] = baseValue * (1 + numericValue / 100);
      break;
    }
    default:
      break;
  }
}

// Returns the FROZEN, cached effective-attribute map for a skill (no clone).
// READ-ONLY callers must not mutate it. The map is the dominant allocation in
// ship-resource/dogma builds: a maxed character runs hundreds of skills, and
// per-module passive-modifier collection re-walks all of them, so cloning the
// map on every lookup (skills x modules) was ~73% of buildShipResourceState
// (~195ms of 268ms on a real mining barge). buildSkillEffectiveAttributes keeps
// returning a mutable clone for external/unaudited callers.
function peekSkillEffectiveAttributes(skill) {
  const skillTypeID = toInt(skill && skill.typeID, 0);
  const level = Math.max(
    0,
    toInt(
      skill && (
        skill.effectiveSkillLevel ??
        skill.trainedSkillLevel ??
        skill.skillLevel
      ),
      0,
    ),
  );
  const cacheKey = `${skillTypeID}:${level}`;
  const cache = ensureSkillEffectiveAttributeCache();
  const cached = cache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const attributes = cloneAttributeMap(getNormalizedTypeAttributeMap(skillTypeID));
  attributes[ATTRIBUTE_SKILL_LEVEL] = level;

  for (const effect of getTypeDogmaEffects(skillTypeID)) {
    const effectRecord = getEffectTypeRecord(effect);
    if (!effectRecord || !Array.isArray(effectRecord.modifierInfo)) {
      continue;
    }
    if (String(effectRecord.name || "").toLowerCase() === "skilleffect") {
      continue;
    }

    for (const modifierInfo of effectRecord.modifierInfo) {
      if (
        !modifierInfo ||
        modifierInfo.domain !== "itemID" ||
        modifierInfo.func !== "ItemModifier" ||
        toInt(modifierInfo.modifiedAttributeID, 0) === ATTRIBUTE_SKILL_LEVEL
      ) {
        continue;
      }

      applyDogmaModifier(
        attributes,
        modifierInfo.modifiedAttributeID,
        modifierInfo.operation,
        attributes[toInt(modifierInfo.modifyingAttributeID, 0)],
      );
    }
  }

  const frozen = Object.freeze(attributes);
  cache.set(cacheKey, frozen);
  return frozen;
}

function buildSkillEffectiveAttributes(skill) {
  return cloneAttributeMap(peekSkillEffectiveAttributes(skill));
}

function collectSkillDrivenShipAttributeModifiers(skillMap) {
  const modifierEntries = [];
  for (const skill of skillMap.values()) {
    const skillAttributes = peekSkillEffectiveAttributes(skill);
    const skillTypeID = toInt(skill && skill.typeID, 0);
    appendDirectModifierEntries(
      modifierEntries,
      skillAttributes,
      getTypeEffectRecords(skillTypeID),
      "skill",
      {
        charDomainAllowedAttributeIDs: CHAR_DOMAIN_SHIP_ATTRIBUTE_ALLOWLIST,
      },
    );
  }
  return modifierEntries;
}

function applySkillDrivenShipAttributeModifiers(attributes, skillMap) {
  return applyModifierGroups(
    attributes,
    collectSkillDrivenShipAttributeModifiers(skillMap),
  );
}

function getSkillExplicitShipAttributeModifierSet(skillTypeID) {
  const numericSkillTypeID = toInt(skillTypeID, 0);
  if (numericSkillTypeID <= 0) {
    return new Set();
  }

  const cache = ensureSkillExplicitShipAttributeModifierCache();
  const cached = cache.get(numericSkillTypeID);
  if (cached) {
    return cached;
  }

  const explicitAttributeIDs = new Set();
  for (const effectID of getTypeDogmaEffects(numericSkillTypeID)) {
    const effect = getEffectTypeRecord(effectID);
    if (!effect || !Array.isArray(effect.modifierInfo)) {
      continue;
    }

    for (const modifierInfo of effect.modifierInfo) {
      if (
        modifierInfo &&
        modifierInfo.domain === "shipID" &&
        modifierInfo.func === "ItemModifier"
      ) {
        const modifiedAttributeID = toInt(modifierInfo.modifiedAttributeID, 0);
        if (modifiedAttributeID > 0) {
          explicitAttributeIDs.add(modifiedAttributeID);
        }
      }
    }
  }

  cache.set(numericSkillTypeID, explicitAttributeIDs);
  return explicitAttributeIDs;
}

function skillHasExplicitShipAttributeModifier(skillTypeID, targetAttributeID) {
  const numericSkillTypeID = toInt(skillTypeID, 0);
  const numericTargetAttributeID = toInt(targetAttributeID, 0);
  if (numericSkillTypeID <= 0 || numericTargetAttributeID <= 0) {
    return false;
  }

  return getSkillExplicitShipAttributeModifierSet(numericSkillTypeID).has(
    numericTargetAttributeID,
  );
}

function skillSupportsFallbackShipAttributeModifier(skillTypeID) {
  const numericSkillTypeID = toInt(skillTypeID, 0);
  if (numericSkillTypeID <= 0) {
    return false;
  }

  const cache = ensureSkillFallbackShipEligibilityCache();
  if (cache.has(numericSkillTypeID)) {
    return cache.get(numericSkillTypeID) === true;
  }

  let supportsFallback = true;
  for (const effectID of getTypeDogmaEffects(numericSkillTypeID)) {
    const effect = getEffectTypeRecord(effectID);
    if (!effect || !Array.isArray(effect.modifierInfo)) {
      continue;
    }

    for (const modifierInfo of effect.modifierInfo) {
      if (
        !modifierInfo ||
        (modifierInfo.domain === "itemID" &&
          modifierInfo.func === "ItemModifier") ||
        (modifierInfo.domain === "shipID" &&
          modifierInfo.func === "ItemModifier")
      ) {
        continue;
      }

      supportsFallback = false;
      break;
    }

    if (!supportsFallback) {
      break;
    }
  }

  cache.set(numericSkillTypeID, supportsFallback);
  return supportsFallback;
}

function appendSkillFallbackPercentModifier(
  destination,
  skillTypeID,
  level,
  targetAttributeID,
  ...sourceAttributeNames
) {
  if (
    skillHasExplicitShipAttributeModifier(skillTypeID, targetAttributeID) ||
    !skillSupportsFallbackShipAttributeModifier(skillTypeID)
  ) {
    return;
  }

  const value =
    toFiniteNumber(getTypeAttributeValue(skillTypeID, ...sourceAttributeNames), 0) *
    level;
  if (!Number.isFinite(value) || Math.abs(value) <= 1e-9) {
    return;
  }

  destination.push({
    modifiedAttributeID: targetAttributeID,
    operation: DOGMA_OP_POST_PERCENT,
    value,
    stackingPenalized: false,
  });
}

function collectShipTypeSelfModifiers(attributes, shipTypeID) {
  const modifierEntries = [];
  appendDirectModifierEntries(
    modifierEntries,
    attributes,
    getTypeEffectRecords(shipTypeID),
    "ship",
    {
      allowedDomains: new Set(["shipID", "itemID"]),
      allowedFuncs: new Set(["ItemModifier"]),
      charDomainAllowedAttributeIDs: CHAR_DOMAIN_SHIP_ATTRIBUTE_ALLOWLIST,
      stackingPenalized: false,
    },
  );
  return modifierEntries;
}

function collectShipLocationModifierSourceAttributes(shipItem, skillMap = new Map()) {
  const shipTypeID = toInt(shipItem && shipItem.typeID, 0);
  const attributes = normalizeNumericAttributeMap(getTypeDogmaAttributes(shipTypeID));
  if (shipTypeID <= 0) {
    return attributes;
  }

  const hullBonusSkillMap = buildHullBonusSkillMap(shipTypeID, skillMap);
  for (const skillRecord of hullBonusSkillMap.values()) {
    const effectiveSkillAttributes = peekSkillEffectiveAttributes(skillRecord);
    for (const effectRecord of getTypeEffectRecords(skillRecord.typeID)) {
      for (const modifierInfo of effectRecord.modifierInfo || []) {
        if (
          !modifierInfo ||
          modifierInfo.func !== "ItemModifier" ||
          modifierInfo.domain !== "shipID"
        ) {
          continue;
        }

        applyDogmaModifier(
          attributes,
          modifierInfo.modifiedAttributeID,
          modifierInfo.operation,
          effectiveSkillAttributes[toInt(modifierInfo.modifyingAttributeID, 0)],
        );
      }
    }
  }

  return attributes;
}

function buildPassiveModuleAttributeMap(
  shipItem,
  moduleItem,
  skillMap = new Map(),
  options = {},
) {
  // One rebuild of a ship's resource state passes one memo
  // (buildShipResourceState): an item's passive attributes depend only on
  // the item, the ship, the skills and the options, all fixed for the rebuild,
  // and every module's load reads every other item's. Callers may change the
  // map they get, so the memo keeps its own copy.
  const memo = options.passiveAttributeMemo instanceof Map
    ? options.passiveAttributeMemo
    : null;
  const memoKey = memo && moduleItem
    ? `item:${String(moduleItem.itemID)}:${toInt(moduleItem.typeID, 0)}:${toInt(moduleItem.flagID, 0)}`
    : null;
  if (memoKey !== null && memo.has(memoKey)) {
    return cloneAttributeMap(memo.get(memoKey));
  }
  const attributes = buildEffectiveItemAttributeMap(moduleItem);
  if (!moduleItem) {
    return attributes;
  }

  const modifierEntries = [];
  const resolvedSkillMap = buildHullBonusSkillMap(
    toInt(shipItem && shipItem.typeID, 0),
    skillMap,
  );
  const additionalLocationModifierSources = Array.isArray(
    options.additionalLocationModifierSources,
  )
    ? options.additionalLocationModifierSources
    : [];
  const additionalShipAttributeModifierEntries = Array.isArray(
    options.additionalShipAttributeModifierEntries,
  )
    ? options.additionalShipAttributeModifierEntries
    : [];
  const locationModifierDomains = isStructureDogmaHost(shipItem)
    ? new Set(["structureID", "charID"])
    : new Set(["shipID", "charID"]);
  for (const skillRecord of resolvedSkillMap.values()) {
    appendLocationModifierEntries(
      modifierEntries,
      peekSkillEffectiveAttributes(skillRecord),
      getTypeEffectRecords(skillRecord.typeID),
      "skill",
      moduleItem,
      {
        allowedDomains: locationModifierDomains,
        sourceTypeID: skillRecord.typeID,
      },
    );
  }

  const shipTypeID = toInt(shipItem && shipItem.typeID, 0);
  if (shipTypeID > 0) {
    // The hull's skill-adjusted attributes are the same for every item; read
    // only below, so the memo hands out its own map.
    let shipLocationAttributes = memo ? memo.get("ship") : undefined;
    if (!shipLocationAttributes) {
      shipLocationAttributes = collectShipLocationModifierSourceAttributes(
        shipItem,
        resolvedSkillMap,
      );
      if (additionalShipAttributeModifierEntries.length > 0) {
        applyModifierGroups(shipLocationAttributes, additionalShipAttributeModifierEntries);
      }
      if (memo) {
        memo.set("ship", shipLocationAttributes);
      }
    }
    appendLocationModifierEntries(
      modifierEntries,
      shipLocationAttributes,
      getTypeEffectRecords(shipTypeID),
      "ship",
      moduleItem,
      { allowedDomains: locationModifierDomains },
    );
  }

  for (const source of additionalLocationModifierSources) {
    if (!source || typeof source !== "object") {
      continue;
    }
    appendLocationModifierEntries(
      modifierEntries,
      source.sourceAttributes,
      source.sourceEffects,
      String(source.sourceKind || "system"),
      moduleItem,
      { allowedDomains: locationModifierDomains },
    );
  }

  if (modifierEntries.length > 0) {
    applyModifierGroups(attributes, modifierEntries);
  }
  if (memoKey !== null) {
    memo.set(memoKey, cloneAttributeMap(attributes));
  }
  return attributes;
}

function buildEffectiveFittedModuleAttributeMap(
  shipItem,
  moduleItem,
  skillMap = new Map(),
  fittedItems = [],
  options = {},
) {
  const attributes = buildPassiveModuleAttributeMap(
    shipItem,
    moduleItem,
    skillMap,
    options,
  );
  if (!moduleItem) {
    return attributes;
  }

  const modifierEntries = [];
  for (const sourceItem of getPassiveModifierSourceItems(shipItem, fittedItems, options)) {
    if (
      !itemAppliesPassiveStats(sourceItem) ||
      toInt(sourceItem && sourceItem.itemID, 0) === toInt(moduleItem.itemID, 0)
    ) {
      continue;
    }

    const passiveSourceEffects = getPassiveModifierEffectRecords(sourceItem.typeID);
    if (passiveSourceEffects.length <= 0) {
      continue;
    }

    appendLocationModifierEntries(
      modifierEntries,
      buildPassiveModuleAttributeMap(shipItem, sourceItem, skillMap, options),
      passiveSourceEffects,
      toInt(sourceItem.categoryID, 0) === 32 ? "subsystem" : "fittedModule",
      moduleItem,
    );
  }

  if (modifierEntries.length > 0) {
    applyModifierGroups(attributes, modifierEntries);
  }

  applySelfAdditiveModifiersFromLocationSources(attributes, moduleItem);

  return attributes;
}

// A module's own always-on ItemModifier rows are normally already baked into
// the attributes the SDE ships, so this map does not re-run them. The exception
// is an ADDITIVE self-modifier whose source is not the module's own datum at
// all: the three `*CPUAddition` effects read a `*CPUAdd` attribute that is 0 on
// every module in the game and is only ever raised by a hull or subsystem
// `*CPUPenalty` LocationRequiredSkillModifier — the location pass that just
// ran. Those effects are the entire mechanism behind three fitting rules:
//
//   - a Strategic Cruiser needs the Offensive Support Processor to mount a
//     Command Burst. The other eight offensive subsystems declare
//     `warfareLinkCPUPenalty` (1883) = 10000, effect 5265 adds it to
//     `warfareLinkCPUAdd` (1882) for every Leadership module on the hull, and
//     effect 5264 adds that to the burst's own `cpu` (50).
//     "All Strategic Cruisers have one Support Processor option which ... allows
//     fitting Command Bursts" — https://wiki.eveuniversity.org/Strategic_Cruisers
//   - the same shape gates Covert Ops Cloaking Devices and Covert Cynosural
//     Field Generators on T3 defensive subsystems (5262 / 5263 -> 5261), and
//   - Entosis Links on the ten interceptors (6170 -> 6171).
//
// Across the whole SDE exactly four effects carry a self `itemID` ItemModifier
// with ModAdd; three are those gates and the fourth (`skillEffect`) is on skills,
// not modules. Re-running them here therefore adds 0 to every module that is not
// sitting under one of the penalties, and a zero contribution is skipped
// outright so no untouched attribute is even rewritten.
function applySelfAdditiveModifiersFromLocationSources(attributes, moduleItem) {
  if (!attributes || !moduleItem || toInt(moduleItem.typeID, 0) <= 0) {
    return attributes;
  }

  const selfAdditiveEntries = [];
  for (const effectRecord of getPassiveModifierEffectRecords(moduleItem.typeID)) {
    for (const modifierInfo of effectRecord.modifierInfo || []) {
      if (
        !modifierInfo ||
        String(modifierInfo.func || "") !== "ItemModifier" ||
        String(modifierInfo.domain || "") !== "itemID" ||
        toInt(modifierInfo.operation, -1) !== DOGMA_OP_MOD_ADD
      ) {
        continue;
      }
      const value = toFiniteNumber(
        attributes[toInt(modifierInfo.modifyingAttributeID, 0)],
        NaN,
      );
      if (!Number.isFinite(value) || value === 0) {
        continue;
      }
      selfAdditiveEntries.push({
        modifiedAttributeID: modifierInfo.modifiedAttributeID,
        operation: modifierInfo.operation,
        value,
        stackingPenalized: false,
      });
    }
  }

  if (selfAdditiveEntries.length > 0) {
    applyModifierGroups(attributes, selfAdditiveEntries);
  }
  return attributes;
}

function getEffectiveModuleResourceLoad(
  shipItem,
  moduleItem,
  skillMap = new Map(),
  fittedItems = [],
  options = {},
) {
  const attributes = buildEffectiveFittedModuleAttributeMap(
    shipItem,
    moduleItem,
    skillMap,
    fittedItems,
    options,
  );

  return {
    cpuLoad: round6(
      toFiniteNumber(
        attributes[ATTRIBUTE_MODULE_CPU_NEED],
        getTypeAttributeValue(moduleItem && moduleItem.typeID, "cpuLoad", "cpu"),
      ),
    ),
    powerLoad: round6(
      toFiniteNumber(
        attributes[ATTRIBUTE_MODULE_POWER_NEED],
        getTypeAttributeValue(moduleItem && moduleItem.typeID, "powerLoad", "power"),
      ),
    ),
  };
}

// Some modules carry an activation effect that rewrites their OWN attributes
// (domain itemID) and a separate always-on effect that projects those same
// attributes onto the ship. The Assault Damage Control is the clear case: while
// running, effect 7012 post-assigns resistanceMultiplier onto its own twelve
// resonances, and the ordinary damageControl effect then multiplies whatever it
// finds there onto the hull. Read the module's declared attributes instead of
// its live ones and the activation does nothing at all.
function applyActiveSelfModifiersToSourceAttributes(sourceAttributes, activeEffectRecords) {
  if (!Array.isArray(activeEffectRecords) || activeEffectRecords.length === 0) {
    return sourceAttributes;
  }
  const selfModifierEntries = [];
  appendSelfItemModifierEntries(
    selfModifierEntries,
    sourceAttributes,
    activeEffectRecords,
    "fittedModule",
  );
  if (selfModifierEntries.length === 0) {
    return sourceAttributes;
  }
  applyModifierGroups(sourceAttributes, selfModifierEntries);
  return sourceAttributes;
}

function hasLocationModifier(effectRecords) {
  for (const effectRecord of Array.isArray(effectRecords) ? effectRecords : []) {
    for (const modifierInfo of (effectRecord && effectRecord.modifierInfo) || []) {
      const func = String((modifierInfo && modifierInfo.func) || "");
      if (
        func === "LocationRequiredSkillModifier" ||
        func === "LocationGroupModifier" ||
        func === "LocationModifier" ||
        func === "OwnerRequiredSkillModifier"
      ) {
        return true;
      }
    }
  }
  return false;
}

function collectPassiveShipAttributeModifiers(fittedItems = [], options = {}) {
  const modifiers = [];
  const shipItem = options.shipItem || null;
  const skillMap = options.skillMap instanceof Map
    ? options.skillMap
    : new Map();
  const activeSelfModifierEffectsByItemID =
    options.activeSelfModifierEffectsByItemID instanceof Map
      ? options.activeSelfModifierEffectsByItemID
      : null;

  const passiveSources = [];
  for (const item of getPassiveModifierSourceItems(shipItem, fittedItems, options)) {
    if (!itemAppliesPassiveStats(item)) {
      continue;
    }
    const effectRecords = getPassiveModifierEffectRecords(item.typeID);
    if (effectRecords.length <= 0) {
      continue;
    }
    passiveSources.push({ item, effectRecords });
  }

  // One fitted item can raise another fitted item's own modifier strength
  // before that one projects passively onto the ship. buildPassiveModuleAttribute-
  // Map folds in only the hull and the pilot's skills, so those projections were
  // computed from the module's unbonused attributes: a T3 cruiser's
  // "Propulsion - Interdiction Nullifier" subsystem (effect 8120,
  // LocationGroupModifier onto group 4117's maxTargetRangeBonus) left the
  // nullifier costing the full -50% targeting range instead of -10%, and the
  // Proteus "Defensive - Augmented Plating" subsystem left armour plates
  // carrying their full mass penalty. Only items that actually carry a
  // Location*/Owner* modifier can do this, which on the whole SDE is the four
  // T3 propulsion nullifier subsystems and one Proteus defensive subsystem —
  // so the extra attribute maps are built only when such an item is fitted.
  const locationModifierSources = passiveSources.filter(
    (source) => hasLocationModifier(source.effectRecords),
  );
  const locationSourceAttributeCache = new Map();
  // Read-only: appendLocationModifierEntries never mutates the source map, so
  // one build per source item is enough however many modules it reaches.
  const locationSourceAttributes = (source) => {
    const key = toInt(source.item && source.item.itemID, 0);
    if (!locationSourceAttributeCache.has(key)) {
      locationSourceAttributeCache.set(
        key,
        buildPassiveModuleAttributeMap(shipItem, source.item, skillMap, options),
      );
    }
    return locationSourceAttributeCache.get(key);
  };

  for (const { item, effectRecords: passiveSourceEffects } of passiveSources) {
    const sourceAttributes = buildPassiveModuleAttributeMap(
      shipItem,
      item,
      skillMap,
      options,
    );
    if (locationModifierSources.length > 0) {
      const locationModifierEntries = [];
      for (const source of locationModifierSources) {
        if (toInt(source.item.itemID, 0) === toInt(item.itemID, 0)) {
          continue;
        }
        appendLocationModifierEntries(
          locationModifierEntries,
          locationSourceAttributes(source),
          source.effectRecords,
          toInt(source.item.categoryID, 0) === 32 ? "subsystem" : "fittedModule",
          item,
        );
      }
      if (locationModifierEntries.length > 0) {
        applyModifierGroups(sourceAttributes, locationModifierEntries);
      }
    }
    appendDirectModifierEntries(
      modifiers,
      activeSelfModifierEffectsByItemID
        ? applyActiveSelfModifiersToSourceAttributes(
          sourceAttributes,
          activeSelfModifierEffectsByItemID.get(toInt(item && item.itemID, 0)),
        )
        : sourceAttributes,
      passiveSourceEffects,
      toInt(item.categoryID, 0) === 32 ? "subsystem" : "fittedModule",
      // Honour a fitted module's charID-domain effect on an allow-listed
      // attribute (droneControlDistance 458): drone-control-range modules and
      // rigs raise the pilot's drone control range through charID, exactly like
      // the Drone Avionics skills do.
      { charDomainAllowedAttributeIDs: CHAR_DOMAIN_SHIP_ATTRIBUTE_ALLOWLIST },
    );
  }

  return modifiers;
}

function resolveAssumedActivePropulsionEffectState(moduleItem, skillMap = new Map(), options = {}) {
  if (!moduleItem || !isEffectivelyOnlineModule(moduleItem)) {
    return null;
  }

  let effectName = "";
  if (typeHasEffectName(moduleItem.typeID, PROPULSION_EFFECT_AFTERBURNER)) {
    effectName = PROPULSION_EFFECT_AFTERBURNER;
  } else if (typeHasEffectName(moduleItem.typeID, PROPULSION_EFFECT_MICROWARPDRIVE)) {
    effectName = PROPULSION_EFFECT_MICROWARPDRIVE;
  } else {
    return null;
  }

  const moduleAttributes = buildEffectiveFittedModuleAttributeMap(
    options.shipItem,
    moduleItem,
    skillMap,
    options.fittedItems,
    options,
  );
  const speedFactor = toFiniteNumber(
    moduleAttributes[ATTRIBUTE_SPEED_FACTOR],
    0,
  );
  const speedBoostFactor = toFiniteNumber(
    moduleAttributes[ATTRIBUTE_SPEED_BOOST_FACTOR],
    0,
  );
  if (!(speedBoostFactor > 0)) {
    return null;
  }

  return {
    effectName,
    speedFactor: round6(speedFactor),
    speedBoostFactor: round6(speedBoostFactor),
    massAddition: round6(
      toFiniteNumber(moduleAttributes[ATTRIBUTE_MASS_ADDITION], 0),
    ),
    signatureRadiusBonus: round6(
      toFiniteNumber(moduleAttributes[ATTRIBUTE_SIGNATURE_RADIUS_BONUS], 0),
    ),
  };
}

function buildPropulsionSignatureModifier(effectState) {
  return {
    modifiedAttributeID: ATTRIBUTE_SIGNATURE_RADIUS,
    operation: DOGMA_OP_POST_PERCENT,
    value: toFiniteNumber(effectState && effectState.signatureRadiusBonus, 0),
    stackingPenalized: shouldApplyStackingPenalty(ATTRIBUTE_SIGNATURE_RADIUS, true),
  };
}

function resolveShipSignatureRadius(resourceState, additionalModifierEntries = [], fallbackSignatureRadius = 0) {
  const calculation = resourceState && resourceState.signatureRadiusCalculation;
  const attributes = {
    [ATTRIBUTE_SIGNATURE_RADIUS]: calculation
      ? calculation.baseValue
      : toFiniteNumber(resourceState && resourceState.signatureRadius, fallbackSignatureRadius),
  };
  // Re-run the entire signature chain from its base. Multiplying an MWD onto
  // an already stacked result gives rigs and painters the wrong penalty rank.
  applyModifierGroups(attributes, [
    ...(calculation ? calculation.modifierEntries : []),
    ...additionalModifierEntries,
  ]);
  return attributes[ATTRIBUTE_SIGNATURE_RADIUS];
}

function applyAssumedActivePropulsionEffect(attributes, effectState, signatureRadiusCalculation) {
  if (!attributes || !effectState) {
    return;
  }

  const passiveMass = toFiniteNumber(attributes[ATTRIBUTE_MASS], NaN);
  const passiveMaxVelocity = toFiniteNumber(attributes[ATTRIBUTE_MAX_VELOCITY], NaN);
  if (!Number.isFinite(passiveMass) || !Number.isFinite(passiveMaxVelocity)) {
    return;
  }

  const massAfterAddition =
    passiveMass + toFiniteNumber(effectState.massAddition, 0);
  const speedMultiplier =
    1 +
    (0.01 *
      toFiniteNumber(effectState.speedFactor, 0) *
      toFiniteNumber(effectState.speedBoostFactor, 0) /
      Math.max(massAfterAddition, 1));

  attributes[ATTRIBUTE_MASS] = round6(massAfterAddition);
  attributes[ATTRIBUTE_MAX_VELOCITY] = round6(
    passiveMaxVelocity * Math.max(speedMultiplier, 0),
  );

  if (effectState.effectName === PROPULSION_EFFECT_MICROWARPDRIVE) {
    attributes[ATTRIBUTE_SIGNATURE_RADIUS] = resolveShipSignatureRadius(
      { signatureRadiusCalculation, signatureRadius: attributes[ATTRIBUTE_SIGNATURE_RADIUS] },
      [buildPropulsionSignatureModifier(effectState)],
    );
  }
}

function applyAssumedActiveShipModuleEffects(
  attributes,
  fittedItems = [],
  skillMap = new Map(),
  options = {},
) {
  const candidateModules = (Array.isArray(fittedItems) ? fittedItems : [])
    .filter((item) => resolveAssumedActivePropulsionEffectState(item, skillMap, options))
    .sort((left, right) => {
      const flagDiff = toInt(left && left.flagID, 0) - toInt(right && right.flagID, 0);
      if (flagDiff !== 0) {
        return flagDiff;
      }
      return toInt(left && left.itemID, 0) - toInt(right && right.itemID, 0);
    });

  const propulsionModule = candidateModules[0] || null;
  if (!propulsionModule) {
    return;
  }

  applyAssumedActivePropulsionEffect(
    attributes,
    resolveAssumedActivePropulsionEffectState(propulsionModule, skillMap, options),
    options.signatureRadiusCalculation,
  );
}

function getStackedMultiplierFactor(entries = []) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return 1;
  }

  const factors = entries
    .map((entry) => (
      typeof entry === "number"
        ? toFiniteNumber(entry, NaN)
        : toFiniteNumber(entry && entry.factor, NaN)
    ))
    .filter((factor) => Number.isFinite(factor) && factor >= 0);
  if (factors.length === 0) {
    return 1;
  }

  const sortedFactors = [...factors].sort((left, right) => left - right);
  const splitPoint = sortedFactors.findIndex((factor) => factor > 1);
  const belowOrEqual = splitPoint === -1 ? sortedFactors : sortedFactors.slice(0, splitPoint);
  const above = splitPoint === -1 ? [] : sortedFactors.slice(splitPoint).reverse();
  let combined = 1;

  belowOrEqual.forEach((factor, index) => {
    const denominator = STACKING_DENOMINATORS[index];
    if (!denominator) {
      return;
    }
    combined *= ((factor - 1) * (1 / denominator)) + 1;
  });
  above.forEach((factor, index) => {
    const denominator = STACKING_DENOMINATORS[index];
    if (!denominator) {
      return;
    }
    combined *= ((factor - 1) * (1 / denominator)) + 1;
  });

  return combined;
}

function applyPassiveShipAttributeModifiers(attributes, modifiers) {
  return applyModifierGroups(attributes, modifiers);
}

let cachedDogmaAttributeDefaultValues = null;

function getDogmaAttributeDefaultValue(attributeID) {
  if (!cachedDogmaAttributeDefaultValues) {
    cachedDogmaAttributeDefaultValues = new Map();
    const typeDogmaRoot = readStaticTable(TABLE.TYPE_DOGMA) || {};
    const attributeTypesByID = typeDogmaRoot.attributeTypesByID || {};
    for (const [id, record] of Object.entries(attributeTypesByID)) {
      const defaultValue = Number(record && record.defaultValue);
      if (Number.isFinite(defaultValue)) {
        cachedDogmaAttributeDefaultValues.set(Number(id), defaultValue);
      }
    }
  }
  const defaultValue = cachedDogmaAttributeDefaultValues.get(toInt(attributeID, 0));
  return Number.isFinite(defaultValue) ? defaultValue : NaN;
}

// The base a modifier works from is the value the item declares — and when it
// declares none, the SDE's own defaultValue for that attribute. A type only
// lists attributes where it differs from the default, so "absent" means "the
// default", not "zero".
//
// Falling back to a per-operation constant instead meant a PostPercent onto an
// undeclared attribute computed from 0: Bastion's "-95% remote assistance
// impedance" landed on 0 rather than on 5% of the default of 1, and the module
// blocked remote electronic assistance outright instead of throttling it. The
// per-operation constant is kept only for attributes the SDE gives no default.
function resolveModifierBaseValue(currentValue, attributeID, operationFallback) {
  if (Number.isFinite(currentValue)) {
    return currentValue;
  }
  const defaultValue = getDogmaAttributeDefaultValue(attributeID);
  return Number.isFinite(defaultValue) ? defaultValue : operationFallback;
}

let cachedBoundedAttributeIDs = null;
function clampDogmaAttributes(attributes) {
  const definitions = getTypeDogmaRoot().attributeTypesByID || {};
  const resolving = new Set();
  const resolved = new Set();
  function bounded(id) {
    if (resolved.has(id) || resolving.has(id)) return attributes[id] ?? getDogmaAttributeDefaultValue(id);
    resolving.add(id);
    const definition = definitions[id] || {};
    let value = attributes[id] ?? getDogmaAttributeDefaultValue(id);
    if (definition.minAttributeID) value = Math.max(value, bounded(String(definition.minAttributeID)));
    if (definition.maxAttributeID) value = Math.min(value, bounded(String(definition.maxAttributeID)));
    if (Object.hasOwn(attributes, id)) attributes[id] = value;
    resolving.delete(id);
    resolved.add(id);
    return value;
  }
  cachedBoundedAttributeIDs ||= Object.keys(definitions).filter((id) =>
    definitions[id].minAttributeID || definitions[id].maxAttributeID);
  for (const id of cachedBoundedAttributeIDs) {
    if (Object.hasOwn(attributes, id)) bounded(id);
  }
  return attributes;
}

function applyModifierGroups(attributes, modifierEntries = []) {
  clampDogmaAttributes(attributes);
  const groups = new Map();
  const modifiedAttributeIDs = new Set();
  for (const modifierEntry of modifierEntries) {
    if (!modifierEntry) {
      continue;
    }
    const attributeID = toInt(modifierEntry.modifiedAttributeID, 0);
    const operation = toInt(modifierEntry.operation, 0);
    const value = toFiniteNumber(modifierEntry.value, NaN);
    if (attributeID <= 0 || !Number.isFinite(value)) {
      continue;
    }
    const key = `${attributeID}:${operation}`;
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(modifierEntry);
    modifiedAttributeIDs.add(attributeID);
  }

  const operationOrder = [
    DOGMA_OP_PRE_ASSIGNMENT,
    DOGMA_OP_PRE_MUL,
    DOGMA_OP_MOD_ADD,
    DOGMA_OP_MOD_SUB,
    DOGMA_OP_POST_MUL,
    DOGMA_OP_POST_PERCENT,
    5,
    DOGMA_OP_POST_PERCENT_UNNERFED,
    DOGMA_OP_POST_ASSIGNMENT,
  ];
  for (const operation of operationOrder) {
    for (const [key, entries] of groups.entries()) {
      const [, rawOperation] = key.split(":");
      if (Number(rawOperation) !== operation) {
        continue;
      }

      const attributeID = toInt(entries[0] && entries[0].modifiedAttributeID, 0);
      const currentValue = toFiniteNumber(attributes[attributeID], NaN);
      if (attributeID <= 0) {
        continue;
      }

      switch (operation) {
        case DOGMA_OP_PRE_ASSIGNMENT: {
          const lastEntry = entries[entries.length - 1] || null;
          if (lastEntry) {
            attributes[attributeID] = Number(lastEntry.value);
          }
          break;
        }
        case DOGMA_OP_PRE_MUL:
        case DOGMA_OP_POST_MUL:
        case 5:
        case DOGMA_OP_POST_PERCENT:
        case DOGMA_OP_POST_PERCENT_UNNERFED: {
          const directFactors = [];
          const penalizedFactors = [];
          for (const entry of entries) {
            let factor = 1;
            if (
              operation === DOGMA_OP_POST_PERCENT ||
              operation === DOGMA_OP_POST_PERCENT_UNNERFED
            ) {
              factor = 1 + (toFiniteNumber(entry.value, 0) / 100);
            } else if (operation === 5) {
              const divisor = toFiniteNumber(entry.value, NaN);
              factor = Number.isFinite(divisor) && Math.abs(divisor) > 1e-9
                ? 1 / divisor
                : 1;
            } else {
              factor = toFiniteNumber(entry.value, 1);
            }
            if (!Number.isFinite(factor) || factor < 0) {
              continue;
            }
            if (
              operation !== DOGMA_OP_POST_PERCENT_UNNERFED &&
              entry.stackingPenalized
            ) {
              penalizedFactors.push(factor);
            } else {
              directFactors.push(factor);
            }
          }

          const base = resolveModifierBaseValue(
            currentValue,
            attributeID,
            (
              operation === DOGMA_OP_POST_PERCENT ||
              operation === DOGMA_OP_POST_PERCENT_UNNERFED
            )
              ? 0
              : 1,
          );
          const directFactor = directFactors.reduce(
            (result, factor) => result * factor,
            1,
          );
          const penalizedFactor = getStackedMultiplierFactor(penalizedFactors);
          attributes[attributeID] = base * directFactor * penalizedFactor;
          break;
        }
        case DOGMA_OP_MOD_ADD: {
          const base = resolveModifierBaseValue(currentValue, attributeID, 0);
          const totalAdd = entries.reduce(
            (sum, entry) => sum + toFiniteNumber(entry.value, 0),
            0,
          );
          attributes[attributeID] = base + totalAdd;
          break;
        }
        case DOGMA_OP_MOD_SUB: {
          const base = resolveModifierBaseValue(currentValue, attributeID, 0);
          const totalSub = entries.reduce(
            (sum, entry) => sum + toFiniteNumber(entry.value, 0),
            0,
          );
          attributes[attributeID] = base - totalSub;
          break;
        }
        case DOGMA_OP_POST_ASSIGNMENT: {
          const lastEntry = entries[entries.length - 1] || null;
          if (lastEntry) {
            attributes[attributeID] = Number(lastEntry.value);
          }
          break;
        }
        default:
          break;
      }
    }
  }

  clampDogmaAttributes(attributes);

  // DELIBERATE — repo owner's decision, 2026-08-10. Every operation in
  // `operationOrder` has now run, so each attribute's chain is finished and this
  // is its output boundary: normalize here and nowhere earlier. Rounding between
  // operations would change the result instead of tidying it, because a later
  // operation reads the value a previous one wrote.
  //
  // What this removes is IEEE-754 representation error, not gameplay data:
  // 22400.000000000004 for 22400, 5999.999999999999 for a 6000 ms script cycle,
  // 0.36800000000000005 for a boosted resonance. It also collapses -0 to +0.
  //
  // normalizeDogmaFloat is GUARDED, and the guard is the load-bearing part. It
  // has TWO conditions, not one (4e818e08):
  //
  //   * |value| >= DOGMA_RELATIVE_GUARD_FLOOR (1e-2) — round unconditionally.
  //   * below that floor — decline to round whenever the 6-dp round would move
  //     the value by more than 1e-6 relative, so legitimately sub-micro
  //     attributes survive untouched: warpCapacitorNeed (564 types, down to
  //     1.38e-7, would otherwise become 0 and let those hulls warp free),
  //     jumpPortalConsumptionMassFactor (20 types, 1e-9), agility (287 types,
  //     4.363462e-6, would shift 8.3%). That is why referenceDataDogma-
  //     Precision's 3.369275e-7 chain output passes with this in place.
  //
  // The absolute floor is not belt-and-braces, it is what makes the relative
  // test mean what it says. A 6-dp round moves a value by at most 5e-7
  // absolute, so the RELATIVE move it produces is 5e-7 / |value|, which crosses
  // 1e-6 at |value| = 0.5. A relative-only guard therefore never selected
  // sub-micro attributes at all — it preserved *everything below a half* whose
  // seventh decimal was nonzero (1,357 values across 52 attributes, ordinary
  // multipliers like the damage resonances among them), which is the opposite
  // of the intent. The floor of 1e-2 is derived rather than chosen: it is the
  // only power of ten between the largest value the repo pins as protected
  // (trackingSpeed 0.001633333) and the smallest ordinary chain output that has
  // to be cleaned (a precursor turret spool of 0.06579388600947744). See
  // floatPrecision.js for the full derivation.
  //
  // Removing this regresses seven suites to a `22400.000000000004 !== 22400`
  // signature: armorCommandBurstGameplayParity, informationCommandBurst-
  // GameplayParity, shieldCommandBurstGameplayParity, skirmishCommandBurst-
  // GameplayParity, commandBurstParity, dogmaModuleParityView and
  // structureBurstProjectorParity. It has already been reverted once (68dfc49d)
  // and restored by owner decision. Do not remove it again without one.
  for (const attributeID of modifiedAttributeIDs) {
    const value = attributes[attributeID];
    if (typeof value === "number") {
      attributes[attributeID] = normalizeDogmaFloat(value);
    }
  }

  return attributes;
}

function synchronizeShipResourceStateSummary(resourceState) {
  if (
    !resourceState ||
    !resourceState.attributes ||
    typeof resourceState.attributes !== "object"
  ) {
    return resourceState;
  }

  const attributes = resourceState.attributes;
  resourceState.cpuOutput = round6(toFiniteNumber(attributes[ATTRIBUTE_CPU_OUTPUT], 0));
  resourceState.powerOutput = round6(toFiniteNumber(attributes[ATTRIBUTE_POWER_OUTPUT], 0));
  resourceState.cargoCapacity = round6(toFiniteNumber(attributes[ATTRIBUTE_CAPACITY], 0));
  resourceState.droneCapacity = round6(
    toFiniteNumber(attributes[ATTRIBUTE_DRONE_CAPACITY], 0),
  );
  resourceState.fighterCapacity = round6(
    toFiniteNumber(attributes[ATTRIBUTE_FIGHTER_CAPACITY], 0),
  );
  resourceState[FLEET_HANGAR_RESOURCE_KEY] = round6(
    toFiniteNumber(attributes[FLEET_HANGAR_ATTRIBUTE_ID], 0),
  );
  resourceState.maxVelocity = round6(toFiniteNumber(attributes[ATTRIBUTE_MAX_VELOCITY], 0));
  resourceState.agility = round6(toFiniteNumber(attributes[ATTRIBUTE_AGILITY], 0));
  resourceState.mass = round6(toFiniteNumber(attributes[ATTRIBUTE_MASS], 0));
  resourceState.maxTargetRange = round6(
    toFiniteNumber(attributes[ATTRIBUTE_MAX_TARGET_RANGE], 0),
  );
  resourceState.maxLockedTargets = round6(
    toFiniteNumber(attributes[ATTRIBUTE_MAX_LOCKED_TARGETS], 0),
  );
  resourceState.signatureRadius = round6(
    toFiniteNumber(attributes[ATTRIBUTE_SIGNATURE_RADIUS], 0),
  );
  resourceState.cloakingTargetingDelay = round6(
    toFiniteNumber(attributes[ATTRIBUTE_CLOAKING_TARGETING_DELAY], 0),
  );
  resourceState.scanResolution = round6(
    toFiniteNumber(attributes[ATTRIBUTE_SCAN_RESOLUTION], 0),
  );
  resourceState.capacitorCapacity = round6(
    toFiniteNumber(attributes[ATTRIBUTE_CAPACITOR_CAPACITY], 0),
  );
  resourceState.capacitorRechargeRate = round6(
    toFiniteNumber(attributes[ATTRIBUTE_CAPACITOR_RECHARGE_RATE], 0),
  );
  resourceState.shieldCapacity = round6(
    toFiniteNumber(attributes[ATTRIBUTE_SHIELD_CAPACITY], 0),
  );
  resourceState.shieldRechargeRate = round6(
    toFiniteNumber(attributes[ATTRIBUTE_SHIELD_RECHARGE_RATE], 0),
  );
  resourceState.armorHP = round6(toFiniteNumber(attributes[ATTRIBUTE_ARMOR_HP], 0));
  resourceState.structureHP = round6(
    toFiniteNumber(attributes[ATTRIBUTE_STRUCTURE_HP], 0),
  );
  resourceState.upgradeCapacity = round6(
    toFiniteNumber(attributes[ATTRIBUTE_UPGRADE_CAPACITY], 0),
  );
  resourceState[FUEL_BAY_RESOURCE_KEY] = round6(
    toFiniteNumber(attributes[FUEL_BAY_ATTRIBUTE_ID], 0),
  );
  for (const miningHold of MINING_HOLD_ATTRIBUTE_IDS) {
    resourceState[miningHold.resourceKey] = round6(
      toFiniteNumber(attributes[miningHold.attributeID], 0),
    );
  }
  return resourceState;
}

function collectSkillFallbackShipAttributeModifiers(skillMap) {
  const modifierEntries = [];
  for (const skill of skillMap.values()) {
    const skillTypeID = toInt(skill && skill.typeID, 0);
    const level = Math.max(
      0,
      toInt(
        skill && (
          skill.effectiveSkillLevel ??
          skill.trainedSkillLevel ??
          skill.skillLevel
        ),
        0,
      ),
    );
    if (skillTypeID <= 0 || level <= 0) {
      continue;
    }

    appendSkillFallbackPercentModifier(
      modifierEntries,
      skillTypeID,
      level,
      ATTRIBUTE_CPU_OUTPUT,
      "cpuOutputBonus",
      "cpuOutputBonus2",
    );
    appendSkillFallbackPercentModifier(
      modifierEntries,
      skillTypeID,
      level,
      ATTRIBUTE_POWER_OUTPUT,
      "powerOutputBonus",
      "powerEngineeringOutputBonus",
    );
    appendSkillFallbackPercentModifier(
      modifierEntries,
      skillTypeID,
      level,
      ATTRIBUTE_MAX_VELOCITY,
      "maxVelocityBonus",
      "velocityBonus",
    );
    // Leave agility on the explicit dogma lane only. Generic fallback on the
    // raw `agilityBonus` attribute over-applies Advanced Spaceship Command and
    // Capital Ships to subcapital hulls, which is how normal fitting drifted
    // below ghost fitting on the same fit.
    appendSkillFallbackPercentModifier(
      modifierEntries,
      skillTypeID,
      level,
      ATTRIBUTE_MAX_TARGET_RANGE,
      "maxTargetRangeBonus",
    );
    appendSkillFallbackPercentModifier(
      modifierEntries,
      skillTypeID,
      level,
      ATTRIBUTE_SCAN_RESOLUTION,
      "scanResolutionBonus",
    );
    // No fallback row for `cloakingTargetingDelay` (560). It is a MODULE
    // attribute — the client's own dogma/attributes/groups.py files it under
    // `module_operation_attribute_ids` — and the SDE bears that out: exactly 14
    // published types declare it and all 14 are the cloaking devices. **No ship
    // declares it and no effect writes it onto a ship**; the only three effects
    // that touch 560 (848 the Cloaking skill, 2253 the hull role bonus, 2853 the
    // Targeting Systems Stabilizer rigs) are all LocationRequiredSkillModifiers
    // aimed at the items in the ship that require Cloaking, never at the hull.
    // So a ship-domain fallback on 560 had nothing to multiply, and the skill's
    // real -10%/level now reaches the module through effect 848 in
    // CLIENT_PYTHON_EFFECT_MODIFIER_INFO. The Cloaking skill is also the only
    // skill in the game declaring `cloakingTargetingDelayBonus` (619) — every
    // other carrier is a rig — so this row had exactly one possible caller and
    // no possible effect.
  }
  return modifierEntries;
}

function applySkillFallbackAttributeBonuses(attributes, skillMap) {
  return applyModifierGroups(
    attributes,
    collectSkillFallbackShipAttributeModifiers(skillMap),
  );
}

function buildCharacterTargetingState(charID, options = {}) {
  const numericCharID = toInt(charID, 0);
  // getCachedCharacterSkillMap returns the SHARED, read-only skill map; this
  // removes the ~6ms getCharacterSkillMap deep clone (511 skills for a maxed pilot)
  // that validateAllTargetLocks -> getEntityTargetingStats ->
  // buildCharacterTargetingState paid EVERY tick for any locked entity (the
  // dominant scene-tick movement/destiny cost). Read-only here (verified).
  const skillMap = options.skillMap instanceof Map
    ? options.skillMap
    : numericCharID > 0
      ? getCachedCharacterSkillMap(numericCharID)
      : new Map();
  const baseAttributes = Object.fromEntries(
    Object.entries(getTypeDogmaAttributes(CHARACTER_TYPE_ID))
      .map(([attributeID, value]) => [Number(attributeID), Number(value)])
      .filter(
        ([attributeID, value]) =>
          Number.isInteger(attributeID) && Number.isFinite(value),
      ),
  );
  const sourceAttributes =
    options.characterAttributes && typeof options.characterAttributes === "object"
      ? options.characterAttributes
      : null;
  if (sourceAttributes) {
    for (const [attributeID, value] of Object.entries(sourceAttributes)) {
      const numericAttributeID = Number(attributeID);
      const numericValue = Number(value);
      if (!Number.isInteger(numericAttributeID) || !Number.isFinite(numericValue)) {
        continue;
      }
      baseAttributes[numericAttributeID] = numericValue;
    }
  }

  if (baseAttributes[ATTRIBUTE_MAX_LOCKED_TARGETS] === undefined) {
    baseAttributes[ATTRIBUTE_MAX_LOCKED_TARGETS] = 0;
  }

  for (const skill of skillMap.values()) {
    const skillTypeID = toInt(skill && skill.typeID, 0);
    const level = Math.max(
      0,
      toInt(
        skill && (
          skill.effectiveSkillLevel ??
          skill.trainedSkillLevel ??
          skill.skillLevel
        ),
        0,
      ),
    );
    if (skillTypeID <= 0 || level <= 0) {
      continue;
    }

    applyAdditiveModifier(
      baseAttributes,
      ATTRIBUTE_MAX_LOCKED_TARGETS,
      toFiniteNumber(getSkillAttributeValue(skillTypeID, "maxLockedTargetsBonus"), 0) * level,
    );
  }

  return {
    attributes: baseAttributes,
    maxLockedTargets: Math.max(
      0,
      Math.trunc(toFiniteNumber(baseAttributes[ATTRIBUTE_MAX_LOCKED_TARGETS], 0)),
    ),
  };
}

// What a ship's passive fitting is built from, as one string: the hull, each
// fitted and hidden modifier item with its slot and online state (a charge's
// quantity is not in it: a shot changes nothing passive), the implant and
// booster modifiers, the active self-modifiers (heat) and the base overrides.
// The skills are compared by identity: the cached skill map is a new map once
// a skill changes.
function buildPassiveFittingKey(parts) {
  const itemKey = (item) => [
    String(item && item.itemID),
    toInt(item && item.typeID, 0),
    toInt(item && item.flagID, 0),
    isFittedModuleItem(item) ? (isEffectivelyOnlineModule(item) ? 1 : 0) : "-",
  ].join(":");
  const activeSelf = parts.activeSelfModifierEffectsByItemID instanceof Map
    ? [...parts.activeSelfModifierEffectsByItemID.entries()].map(([itemID, records]) => [
      String(itemID),
      (Array.isArray(records) ? records : []).map((record) => (
        record && (record.effectID ?? record.name ?? null)
      )),
    ])
    : null;
  return JSON.stringify([
    parts.charID,
    parts.shipID,
    parts.shipTypeID,
    parts.fittedItems.map(itemKey),
    parts.hiddenModifierItems.map(itemKey),
    parts.implantShipAttributeModifierEntries,
    parts.additionalLocationModifierSources.map((source) => [
      source && source.sourceKind,
      source && source.sourceTypeID,
      source && source.implantSlot,
      source && source.sourceAttributes,
    ]),
    activeSelf,
    parts.baseAttributeOverrides,
  ]);
}

function buildShipResourceState(charID, shipItem, options = {}) {
  const numericCharID = toInt(charID, 0);
  const numericShipID = toInt(shipItem && shipItem.itemID, 0);
  const shipTypeID = toInt(shipItem && shipItem.typeID, 0);
  const shipMetadata = resolveItemByTypeID(shipTypeID) || null;
  const isStructureHost = isStructureDogmaHost(shipItem || shipMetadata);
  const fittedItems = Array.isArray(options.fittedItems)
    ? options.fittedItems
    : isStructureHost
      ? listFittedItemsForLocation(numericShipID)
      : listFittedItems(numericCharID, numericShipID);
  const validStrategicSubsystemItems = new Set(
    getValidStrategicCruiserSubsystems(shipTypeID, fittedItems, numericShipID),
  );
  const dogmaFittedItems = isStrategicCruiserType(shipTypeID)
    ? fittedItems.filter((item) => (
        getRequiredSlotFamily(item && item.typeID) !== "subsystem" ||
        validStrategicSubsystemItems.has(item)
      ))
    : fittedItems;
  const skillMap = resolveDogmaSkillMapForHost(
    numericCharID,
    shipItem || shipMetadata,
    options,
  );
  const includeActiveImplantModifiers =
    !isStructureHost && options.includeActiveImplantModifiers !== false && numericCharID > 0;
  const implantShipAttributeModifierEntries = includeActiveImplantModifiers
    ? getActiveImplantShipModifierEntries(numericCharID)
    : [];
  const implantLocationModifierSources = includeActiveImplantModifiers
    ? getActiveImplantLocationModifierSources(numericCharID)
    : [];
  const additionalLocationModifierSources = [
    ...implantLocationModifierSources,
    ...(!isStructureHost && Array.isArray(options.additionalLocationModifierSources)
      ? options.additionalLocationModifierSources
      : []),
  ];
  const derivedAttributes = readShipBaseAttributeMap(
    shipTypeID,
    shipItem,
    shipMetadata,
  );
  const shipTypeAttributes = normalizeNumericAttributeMap(getTypeDogmaAttributes(shipTypeID));
  for (const [attributeID, value] of Object.entries(shipTypeAttributes)) {
    if (derivedAttributes[attributeID] === undefined) {
      derivedAttributes[attributeID] = value;
    }
  }
  // Some runtime-authored NPC hulls intentionally replace incomplete SDE
  // bases. Apply those bases before all Dogma modifiers so hostile effects
  // reduce them normally instead of being erased by a post-refresh floor.
  const baseAttributeOverrides = normalizeNumericAttributeMap(
    { ...options.baseAttributeOverrides, ...getGmDogmaOverrides(shipItem) },
  );
  for (const [attributeID, value] of Object.entries(baseAttributeOverrides)) {
    derivedAttributes[attributeID] = value;
  }
  // The passive modifiers and every module's load below read the same hidden
  // modifier items and every item's passive attributes: both are resolved
  // once for this rebuild (buildPassiveModuleAttributeMap).
  const hiddenModifierItems = Array.isArray(options.hiddenModifierItems)
    ? options.hiddenModifierItems
    : listHiddenModifierItems(
      toInt(shipItem && shipItem.ownerID, 0),
      numericShipID,
      shipItem,
    );
  const passiveAttributeMemo = new Map();
  // A ship Ball's passive fitting (options.passiveFittingCache, kept on each
  // ship Ball by the space runtime): the passive modifiers and the CPU,
  // powergrid and upgrade loads, which come from the fit, the skills, the
  // implants and boosters and the hull alone. A rebuild for anything else (a
  // module turning on or off, a boost, EWAR) reuses them. They are kept by
  // what they were built from (buildPassiveFittingKey): a refit, an online or
  // offline, a charge change, a skill, an implant or booster, heat, a mode or
  // a hull change builds them again; undocking or boarding starts a new Ball
  // with none.
  const passiveFittingCache =
    options.passiveFittingCache && typeof options.passiveFittingCache === "object"
      ? options.passiveFittingCache
      : null;
  const passiveFittingKey = passiveFittingCache
    ? buildPassiveFittingKey({
      charID: numericCharID,
      shipID: numericShipID,
      shipTypeID,
      fittedItems: dogmaFittedItems,
      hiddenModifierItems,
      implantShipAttributeModifierEntries,
      additionalLocationModifierSources,
      activeSelfModifierEffectsByItemID: options.activeSelfModifierEffectsByItemID,
      baseAttributeOverrides,
    })
    : null;
  const cachedPassiveFitting =
    passiveFittingCache &&
    passiveFittingCache.key === passiveFittingKey &&
    passiveFittingCache.skillMap === skillMap
      ? passiveFittingCache.value
      : null;
  const passiveAttributeModifierEntries =
    Array.isArray(options.passiveAttributeModifierEntries)
      ? options.passiveAttributeModifierEntries
      : cachedPassiveFitting
        ? cachedPassiveFitting.passiveAttributeModifierEntries
        : collectPassiveShipAttributeModifiers(dogmaFittedItems, {
          shipItem,
          skillMap,
          hiddenModifierItems,
          additionalLocationModifierSources,
          additionalShipAttributeModifierEntries: implantShipAttributeModifierEntries,
          activeSelfModifierEffectsByItemID: options.activeSelfModifierEffectsByItemID,
          passiveAttributeMemo,
        });
  const additionalAttributeModifierEntries = [
    ...implantShipAttributeModifierEntries,
    ...(Array.isArray(options.additionalAttributeModifierEntries)
      ? options.additionalAttributeModifierEntries
      : []),
  ];
  // Dogma operation order is global across modifier sources. Applying skills
  // before fitted modules would let a post-percent skill miss a later additive
  // module bonus (for example Shield Management and shield extenders).
  const skillFallbackShipAttributeModifierEntries =
    collectSkillFallbackShipAttributeModifiers(skillMap);
  const hullBonusSkillMap = buildHullBonusSkillMap(shipTypeID, skillMap);
  const skillDrivenShipAttributeModifierEntries =
    collectSkillDrivenShipAttributeModifiers(hullBonusSkillMap);
  // Ship effects frequently read per-level bonus attributes from the hull
  // (for example shipBonusCC2). Skills first pre-multiply those source
  // attributes by the pilot's level, then the ship effect applies the resolved
  // value to a real ship attribute. Snapshotting the raw source value here
  // would silently reduce every such hull bonus to level I.
  const skillAdjustedShipSelfModifierAttributes = cloneAttributeMap(derivedAttributes);
  applyModifierGroups(
    skillAdjustedShipSelfModifierAttributes,
    skillDrivenShipAttributeModifierEntries,
  );
  const combinedShipAttributeModifierEntries = [
    ...skillFallbackShipAttributeModifierEntries,
    ...skillDrivenShipAttributeModifierEntries,
    ...collectShipTypeSelfModifiers(
      skillAdjustedShipSelfModifierAttributes,
      shipTypeID,
    ),
    ...passiveAttributeModifierEntries,
    ...additionalAttributeModifierEntries,
  ];
  const signatureRadiusCalculation = {
    baseValue: toFiniteNumber(derivedAttributes[ATTRIBUTE_SIGNATURE_RADIUS], 0),
    modifierEntries: combinedShipAttributeModifierEntries.filter(
      (entry) => toInt(entry && entry.modifiedAttributeID, 0) === ATTRIBUTE_SIGNATURE_RADIUS,
    ),
  };
  applyPassiveShipAttributeModifiers(
    derivedAttributes,
    combinedShipAttributeModifierEntries,
  );
  if (options.assumeActiveShipModules === true) {
    applyAssumedActiveShipModuleEffects(
      derivedAttributes,
      dogmaFittedItems,
      skillMap,
      {
        shipItem,
        fittedItems: dogmaFittedItems,
        hiddenModifierItems,
        additionalLocationModifierSources,
        passiveAttributeMemo,
        signatureRadiusCalculation,
      },
    );
  }
  const hardpointCounts = getShipHardpointCounts(
    shipTypeID,
    fittedItems,
    numericShipID,
  );
  const turretHardpoints = hardpointCounts.turret;
  const launcherHardpoints = hardpointCounts.launcher;
  if (isStrategicCruiserType(shipTypeID)) {
    const slotCounts = getShipSlotCounts(shipTypeID, fittedItems, numericShipID);
    derivedAttributes[ATTRIBUTE_LOW_SLOTS] = slotCounts.low;
    derivedAttributes[ATTRIBUTE_MED_SLOTS] = slotCounts.med;
    derivedAttributes[ATTRIBUTE_HIGH_SLOTS] = slotCounts.high;
  }

  let cpuLoad = 0;
  let powerLoad = 0;
  let upgradeLoad = 0;
  const loadOptions = {
    additionalLocationModifierSources,
    additionalShipAttributeModifierEntries: implantShipAttributeModifierEntries,
    hiddenModifierItems,
    passiveAttributeMemo,
  };

  for (const item of cachedPassiveFitting ? [] : dogmaFittedItems) {
    if (!item || !isFittedModuleItem(item)) {
      continue;
    }

    if (isEffectivelyOnlineModule(item)) {
      const effectiveResourceLoad = getEffectiveModuleResourceLoad(
        shipItem,
        item,
        skillMap,
        dogmaFittedItems,
        loadOptions,
      );
      cpuLoad += effectiveResourceLoad.cpuLoad;
      powerLoad += effectiveResourceLoad.powerLoad;
    }

    if (!itemAppliesPassiveStats(item)) {
      continue;
    }
    upgradeLoad += toFiniteNumber(getEffectiveItemAttributeValue(item, "upgradeCost"), 0);
  }
  if (cachedPassiveFitting) {
    ({ cpuLoad, powerLoad, upgradeLoad } = cachedPassiveFitting);
  } else if (passiveFittingCache) {
    passiveFittingCache.key = passiveFittingKey;
    passiveFittingCache.skillMap = skillMap;
    passiveFittingCache.value = {
      passiveAttributeModifierEntries,
      cpuLoad,
      powerLoad,
      upgradeLoad,
    };
  }
  const usedTurrets = getFittedEffectSlotsUsed(
    dogmaFittedItems,
    "turretFitted",
  );
  const usedLaunchers = getFittedEffectSlotsUsed(
    dogmaFittedItems,
    "launcherFitted",
  );

  derivedAttributes[ATTRIBUTE_CPU_LOAD] = round6(cpuLoad);
  derivedAttributes[ATTRIBUTE_POWER_LOAD] = round6(powerLoad);
  derivedAttributes[ATTRIBUTE_UPGRADE_LOAD] = round6(upgradeLoad);
  if (derivedAttributes[ATTRIBUTE_UPGRADE_CAPACITY] === undefined) {
    derivedAttributes[ATTRIBUTE_UPGRADE_CAPACITY] = round6(
      toFiniteNumber(getShipBaseAttributeValue(shipTypeID, "upgradeCapacity"), 0),
    );
  }
  derivedAttributes[ATTRIBUTE_TURRET_SLOTS_LEFT] = Math.max(
    0,
    turretHardpoints - usedTurrets,
  );
  derivedAttributes[ATTRIBUTE_LAUNCHER_SLOTS_LEFT] = Math.max(
    0,
    launcherHardpoints - usedLaunchers,
  );
  derivedAttributes[1154] = Math.max(0,
    getShipRigSlotCapacity(shipTypeID, numericShipID) - getFittedEffectSlotsUsed(dogmaFittedItems, "rigSlot"));

  const resourceState = {
    fittedItems,
    skillMap,
    attributes: derivedAttributes,
    signatureRadiusCalculation,
    cpuLoad: round6(cpuLoad),
    powerLoad: round6(powerLoad),
    upgradeLoad: round6(upgradeLoad),
    turretSlotsLeft: Math.max(0, turretHardpoints - usedTurrets),
    launcherSlotsLeft: Math.max(0, launcherHardpoints - usedLaunchers),
    baseTurretSlots: turretHardpoints,
    baseLauncherSlots: launcherHardpoints,
    passiveAttributeModifierEntries,
    appliedAttributeModifierEntries: [
      ...passiveAttributeModifierEntries,
      ...additionalAttributeModifierEntries,
    ],
  };

  return synchronizeShipResourceStateSummary(resourceState);
}

function calculateShipDerivedAttributes(charID, shipItem, options = {}) {
  const resourceState = buildShipResourceState(charID, shipItem, options);

  return {
    attributes: {
      ...resourceState.attributes,
    },
    resourceState,
  };
}

// Low (11-18), medium (19-26) and high (27-34) slots.
function isModuleSlotFlag(flagID) {
  return flagID >= 11 && flagID <= 34;
}

function validateFitForShip(charID, shipItem, item, targetFlagID, fittedItems = null) {
  const numericCharID = toInt(charID, 0);
  const numericTargetFlagID = toInt(targetFlagID, 0);
  if (numericCharID <= 0 || !shipItem || !item || numericTargetFlagID <= 0) {
    return { success: false, errorMsg: "INVALID_FIT_REQUEST" };
  }

  if (!isShipFittingFlag(numericTargetFlagID)) {
    return { success: false, errorMsg: "INVALID_FIT_FLAG" };
  }

  if (isChargeItem(item)) {
    return { success: false, errorMsg: "CHARGES_USE_LOAD_AMMO" };
  }

  const shipTypeID = toInt(shipItem.typeID, 0);
  const categoryRestriction = validateHostFittingCategoryRestriction(shipItem, item);
  if (!categoryRestriction.success) {
    return categoryRestriction;
  }

  const family = getRequiredSlotFamily(item.typeID);
  if (!family) {
    return { success: false, errorMsg: "TYPE_NOT_FITTABLE" };
  }

  const shipTypeRecord = resolveItemByTypeID(shipTypeID) || {};
  const currentFittedItems = Array.isArray(fittedItems)
    ? fittedItems
    : toInt(shipTypeRecord.categoryID, 0) === STRUCTURE_CATEGORY_ID
      ? listFittedItemsForLocation(toInt(shipItem.itemID, 0))
      : listFittedItems(numericCharID, toInt(shipItem.itemID, 0));
  const candidateFlags = getSlotFlagsForFamily(
    family,
    shipTypeID,
    currentFittedItems,
    toInt(shipItem && shipItem.itemID, 0),
  );
  if (candidateFlags.length === 0) {
    return { success: false, errorMsg: "NO_FITTING_SLOTS_FOR_FAMILY", data: { family } };
  }
  if (!candidateFlags.includes(numericTargetFlagID)) {
    return { success: false, errorMsg: "INVALID_FIT_SLOT" };
  }
  if (family === "subsystem") {
    const requiredFlagID = getSubsystemSlotFlag(item.typeID);
    if (
      !isStrategicCruiserType(shipTypeID) ||
      requiredFlagID <= 0 ||
      requiredFlagID !== numericTargetFlagID
    ) {
      return { success: false, errorMsg: "INVALID_FIT_SLOT" };
    }
    if (!isSubsystemCompatibleWithStrategicCruiser(item, shipTypeID)) {
      return {
        success: false,
        errorMsg: "INVALID_SHIP_TYPE",
        data: {
          allowedShipTypes: [
            toInt(getTypeAttributeValue(item.typeID, "fitsToShipType"), 0),
          ].filter((typeID) => typeID > 0),
        },
      };
    }
  }
  const conflictingItem = currentFittedItems.find(
    (fittedItem) =>
      fittedItem &&
      isFittedModuleItem(fittedItem) &&
      toInt(fittedItem.flagID, 0) === numericTargetFlagID &&
      toInt(fittedItem.itemID, 0) !== toInt(item.itemID, 0) &&
      toInt(fittedItem.stacksize ?? 1, 1) > 0,
  );
  if (conflictingItem) {
    return { success: false, errorMsg: "SLOT_OCCUPIED" };
  }

  // Every one of the type's own required skills the pilot has not at the level
  // (baseDogmaLocation.GetMissingSkills): the client's refusal names them all.
  // A module in a high, medium or low slot fits without them and stays offline:
  // the skill check is the online effect's (dogma online.py OnlineEffect.Start:
  // OnlineHasSkillPrerequisites; the client checks fitting skills only for
  // charges, tryFit.py). The AIR tutorial's 1.5.02 relies on it: fit the
  // Civilian Mining Laser Upgrade, then fail to online it.
  const missingSkills = isModuleSlotFlag(numericTargetFlagID)
    ? []
    : getMissingRequiredSkills(numericCharID, item.typeID);
  if (missingSkills.length > 0) {
    return {
      success: false,
      errorMsg: "SKILL_REQUIRED",
      data: {
        skillTypeID: missingSkills[0].skillTypeID,
        requiredLevel: missingSkills[0].requiredLevel,
        currentLevel: missingSkills[0].currentLevel,
        missingSkills,
      },
    };
  }

  const shipRestriction = validateShipTypeOrGroupRestriction(
    item.typeID,
    shipItem,
  );
  if (!shipRestriction.success) {
    return shipRestriction;
  }

  const maxTypeFitted = toInt(getEffectiveItemAttributeValue(item, "maxTypeFitted"), 0);
  if (maxTypeFitted > 0) {
    const moduleTypeID = toInt(item.typeID, 0);
    const existingTypeCount = countMatchingFittedItems(
      currentFittedItems,
      (fittedItem) => toInt(fittedItem.typeID, 0) === moduleTypeID,
      toInt(item.itemID, 0),
    );
    if (existingTypeCount >= maxTypeFitted) {
      return {
        success: false,
        errorMsg: "MAX_TYPE_FITTED",
        data: {
          maxTypeFitted,
          existingTypeCount,
          noOfModules: maxTypeFitted,
          noOfModulesFitted: existingTypeCount,
          shipTypeID,
          moduleTypeID,
        },
      };
    }
  }

  const maxGroupFitted = toInt(getEffectiveItemAttributeValue(item, "maxGroupFitted"), 0);
  if (maxGroupFitted > 0) {
    const moduleTypeID = toInt(item.typeID, 0);
    const moduleGroupID = toInt(item.groupID, 0);
    const moduleTypeRecord = resolveItemByTypeID(moduleTypeID);
    const existingGroupCount = countMatchingFittedItems(
      currentFittedItems,
      (fittedItem) => toInt(fittedItem.groupID, 0) === moduleGroupID,
      toInt(item.itemID, 0),
    );
    if (existingGroupCount >= maxGroupFitted) {
      return {
        success: false,
        errorMsg: "MAX_GROUP_FITTED",
        data: {
          maxGroupFitted,
          existingGroupCount,
          noOfModules: maxGroupFitted,
          noOfModulesFitted: existingGroupCount,
          shipTypeID,
          moduleTypeID,
          groupName:
            item.groupName ||
            (moduleTypeRecord && moduleTypeRecord.groupName) ||
            "",
        },
      };
    }
  }

  if (family === "rig") {
    const usedRigSlots = getFittedEffectSlotsUsed(currentFittedItems, "rigSlot", toInt(item.itemID, 0));
    if (usedRigSlots + getItemEffectSlotUsage(item, "rigSlot") >
        getShipRigSlotCapacity(shipTypeID, toInt(shipItem.itemID, 0))) {
      return { success: false, errorMsg: "NO_FITTING_SLOTS_FOR_FAMILY", data: { family: "rig" } };
    }
    const shipRigSize = toInt(getShipBaseAttributeValue(shipTypeID, "rigSize"), 0);
    const moduleRigSize = toInt(getTypeAttributeValue(item.typeID, "rigSize"), 0);
    if (shipRigSize > 0 && moduleRigSize > 0 && shipRigSize !== moduleRigSize) {
      return {
        success: false,
        errorMsg: "RIG_SIZE_MISMATCH",
        data: { shipRigSize, moduleRigSize },
      };
    }

    const shipUpgradeCapacity = toFiniteNumber(
      getGmDogmaOverrides(shipItem)[ATTRIBUTE_UPGRADE_CAPACITY] ?? getShipBaseAttributeValue(shipTypeID, "upgradeCapacity"),
      0,
    );
    const currentUpgradeLoad = currentFittedItems
      .filter((fittedItem) => getRequiredSlotFamily(fittedItem && fittedItem.typeID) === "rig")
      .filter((fittedItem) => toInt(fittedItem.itemID, 0) !== toInt(item.itemID, 0))
      .reduce(
        (sum, fittedItem) =>
          sum + toFiniteNumber(getEffectiveItemAttributeValue(fittedItem, "upgradeCost"), 0),
        0,
      );
    const nextUpgradeLoad =
      currentUpgradeLoad + toFiniteNumber(getEffectiveItemAttributeValue(item, "upgradeCost"), 0);
    if (shipUpgradeCapacity > 0 && nextUpgradeLoad > shipUpgradeCapacity) {
      return {
        success: false,
        errorMsg: "INSUFFICIENT_CALIBRATION",
        data: {
          upgradeCapacity: shipUpgradeCapacity,
          upgradeLoad: nextUpgradeLoad,
        },
      };
    }
  }

  const hardpointCounts = getShipHardpointCounts(
    shipTypeID,
    currentFittedItems,
    toInt(shipItem && shipItem.itemID, 0),
  );
  if (itemConsumesTurretHardpoint(item)) {
    const turretHardpoints = hardpointCounts.turret;
    const usedTurrets = getFittedEffectSlotsUsed(
      currentFittedItems,
      "turretFitted",
      toInt(item.itemID, 0),
    );
    if (usedTurrets + getItemEffectSlotUsage(item, "turretFitted") > turretHardpoints) {
      return {
        success: false,
        errorMsg: "NO_TURRET_HARDPOINTS",
        data: { turretHardpoints, usedTurrets },
      };
    }
  }

  if (itemConsumesLauncherHardpoint(item)) {
    const launcherHardpoints = hardpointCounts.launcher;
    const usedLaunchers = getFittedEffectSlotsUsed(
      currentFittedItems,
      "launcherFitted",
      toInt(item.itemID, 0),
    );
    if (usedLaunchers + getItemEffectSlotUsage(item, "launcherFitted") > launcherHardpoints) {
      return {
        success: false,
        errorMsg: "NO_LAUNCHER_HARDPOINTS",
        data: { launcherHardpoints, usedLaunchers },
      };
    }
  }

  return {
    success: true,
    data: {
      family,
      targetFlagID: numericTargetFlagID,
    },
  };
}

const ONLINE_RESOURCE_EPSILON = 1e-6;

// Rigs, subsystems and service slots are always-on passives with no online
// toggle. Only modules carrying the `online` effect (hi/med/lo power) draw CPU
// and powergrid and can be left offline when the ship cannot supply them.
function moduleParticipatesInOnlineState(item) {
  return (
    Boolean(item) &&
    isFittedModuleItem(item) &&
    typeHasEffectName(item.typeID, "online")
  );
}

// Decide whether a freshly fitted module may come online given the ship's
// remaining CPU/powergrid. Mirrors the online gate already enforced on an
// explicit offline->online transition in dogmaService._setModuleOnlineState, so
// that fitting a module the ship cannot power results in it being fitted
// OFFLINE rather than silently left online over budget (EVE parity).
function resolveFitOnlineState(charID, shipItem, moduleItem, fittedItems, options = {}) {
  if (!moduleParticipatesInOnlineState(moduleItem)) {
    return { applies: false };
  }

  // Fitted without its skills: offline until they are trained.
  if (getMissingRequiredSkills(toInt(charID, 0), moduleItem && moduleItem.typeID).length > 0) {
    return { applies: true, online: false, reason: "SKILL_REQUIRED" };
  }

  const moduleID = toInt(moduleItem && moduleItem.itemID, 0);
  const baselineItems = (Array.isArray(fittedItems) ? fittedItems : []).filter(
    (item) => toInt(item && item.itemID, 0) !== moduleID,
  );
  // Evaluate the candidate as if it were online so its load is included.
  const candidateOnline = {
    ...moduleItem,
    moduleState: { ...(moduleItem && moduleItem.moduleState), online: true },
  };
  const resourceState = buildShipResourceState(charID, shipItem, {
    ...(options.resourceStateOptions || {}),
    fittedItems: [...baselineItems, candidateOnline],
  });

  const cpuOverloaded =
    toFiniteNumber(resourceState.cpuLoad, 0) >
    toFiniteNumber(resourceState.cpuOutput, 0) + ONLINE_RESOURCE_EPSILON;
  if (cpuOverloaded) {
    return { applies: true, online: false, reason: "NOT_ENOUGH_CPU", resourceState };
  }

  const powerOverloaded =
    toFiniteNumber(resourceState.powerLoad, 0) >
    toFiniteNumber(resourceState.powerOutput, 0) + ONLINE_RESOURCE_EPSILON;
  if (powerOverloaded) {
    return { applies: true, online: false, reason: "NOT_ENOUGH_POWER", resourceState };
  }

  return { applies: true, online: true, resourceState };
}

function buildSlimModuleTuples(charID, shipID) {
  return getFittedModuleItems(charID, shipID).map((item) => [
    toInt(item.itemID, 0),
    toInt(item.typeID, 0),
    toInt(item.flagID, 0),
  ]);
}

function buildModuleStatusSnapshot(item) {
  const moduleState = getItemModuleState(item);
  return {
    itemID: toInt(item && item.itemID, 0),
    online: isEffectivelyOnlineModule(item),
    damage: moduleState.damage,
    charge: moduleState.charge,
    skillPoints: moduleState.skillPoints,
    armorDamage: moduleState.armorDamage,
    shieldCharge: moduleState.shieldCharge,
    incapacitated: moduleState.incapacitated,
  };
}

function buildChargeTupleItemID(shipID, flagID, typeID) {
  return [toInt(shipID, 0), toInt(flagID, 0), toInt(typeID, 0)];
}

function buildChargeSublocationData(charID, shipID) {
  return getLoadedChargeItems(charID, shipID)
    .map((item) => ({
      flagID: toInt(item.flagID, 0),
      itemID: buildChargeTupleItemID(shipID, item.flagID, item.typeID),
      quantity: Number(item.stacksize ?? item.quantity ?? 0) || 0,
      typeID: toInt(item.typeID, 0),
    }))
    .filter((entry) => entry.flagID > 0 && entry.typeID > 0);
}

function evaluateModuleChargeCompatibility(moduleTypeID, chargeTypeID) {
  const numericModuleTypeID = toInt(moduleTypeID, 0);
  const numericChargeTypeID = toInt(chargeTypeID, 0);
  if (numericModuleTypeID <= 0 || numericChargeTypeID <= 0) {
    return {
      accepted: false,
      rejectionReason: "invalid-type-id",
      maximumQuantity: 0,
    };
  }

  const capacityAttributeID = getAttributeIDByNames("capacity");
  const moduleAttributes = getTypeDogmaAttributes(numericModuleTypeID);
  const chargeMetadata = resolveItemByTypeID(numericChargeTypeID) || null;
  const moduleMetadata = resolveItemByTypeID(numericModuleTypeID) || null;
  const rawCapacity =
    (capacityAttributeID &&
      toFiniteNumber(moduleAttributes[String(capacityAttributeID)], NaN)) ||
    toFiniteNumber(moduleMetadata && moduleMetadata.capacity, NaN);

  return evaluateChargeCompatibility({
    declaredChargeGroupIDs: getModuleChargeGroupIDs(numericModuleTypeID),
    chargeGroupID: chargeMetadata && chargeMetadata.groupID,
    moduleChargeSize: getTypeAttributeValue(numericModuleTypeID, "chargeSize"),
    chargeSize: getTypeAttributeValue(numericChargeTypeID, "chargeSize"),
    moduleCapacity: rawCapacity,
    chargeVolume: chargeMetadata && chargeMetadata.volume,
  });
}

function getModuleChargeCapacity(moduleTypeID, chargeTypeID) {
  return evaluateModuleChargeCompatibility(moduleTypeID, chargeTypeID).maximumQuantity;
}

function getModuleChargeGroupIDs(moduleTypeID) {
  const chargeGroupIDs = new Set();

  for (let index = 1; index <= 5; index += 1) {
    const chargeGroupID = getTypeAttributeValue(moduleTypeID, `chargeGroup${index}`);
    if (Number.isInteger(chargeGroupID) && chargeGroupID > 0) {
      chargeGroupIDs.add(chargeGroupID);
    }
  }

  return chargeGroupIDs;
}

function isChargeCompatibleWithModule(moduleTypeID, chargeTypeID) {
  return evaluateModuleChargeCompatibility(moduleTypeID, chargeTypeID).accepted;
}

function getTurretLikeModuleItems(charID, shipID) {
  return getFittedModuleItems(charID, shipID).filter(
    (item) =>
      typeHasEffectName(item.typeID, "turretFitted") ||
      typeHasEffectName(item.typeID, "launcherFitted"),
  );
}

function selectAutoFitFlagForType(shipItem, fittedItems, typeID) {
  const family = getRequiredSlotFamily(typeID);
  if (!family) {
    return null;
  }

  const shipTypeID = toInt(shipItem && shipItem.typeID, 0);
  if (family === "subsystem") {
    const requiredFlagID = getSubsystemSlotFlag(typeID);
    if (
      requiredFlagID <= 0 ||
      !isStrategicCruiserType(shipTypeID) ||
      !isSubsystemCompatibleWithStrategicCruiser({ typeID }, shipTypeID)
    ) {
      return null;
    }
    const occupied = (Array.isArray(fittedItems) ? fittedItems : []).some(
      (item) =>
        isFittedModuleItem(item) &&
        toInt(item.flagID, 0) === requiredFlagID,
    );
    return occupied ? null : requiredFlagID;
  }

  const candidateFlags = getSlotFlagsForFamily(
    family,
    shipTypeID,
    fittedItems,
    toInt(shipItem && shipItem.itemID, 0),
  );
  const occupiedFlags = new Set(
    (Array.isArray(fittedItems) ? fittedItems : [])
      .filter((item) => isFittedModuleItem(item))
      .map((item) => toInt(item.flagID, 0))
      .filter((flagID) => flagID > 0),
  );

  return candidateFlags.find((flagID) => !occupiedFlags.has(flagID)) || null;
}

module.exports = {
  applyPassiveShipAttributeModifiers,
  SLOT_FAMILY_FLAGS,
  STRATEGIC_CRUISER_GROUP_ID,
  STRATEGIC_CRUISER_SUBSYSTEM_FLAGS,
  DEFAULT_MODULE_STATE,
  normalizeModuleState,
  getItemModuleState,
  isModuleOnline,
  isEffectivelyOnlineModule,
  isShipFittingFlag,
  isHiddenModifierItem,
  isChargeItem,
  isFittedChargeItem,
  isFittedModuleItem,
  getAttributeIDByNames,
  getEffectIDByNames,
  getTypeDogmaRecord,
  getTypeDogmaAttributes,
  getTypeAttributeValue,
  getDynamicItemAttributeOverrides,
  getDynamicItemSourceTypeID,
  getShipBaseAttributeValue,
  getDogmaAttributeDefaultValue,
  getTypeDogmaEffects,
  getTypeEffectRecords,
  getPassiveModifierEffectRecords,
  getTypeAttributeMap,
  cloneAttributeMap,
  typeHasEffectName,
  getRequiredSlotFamily,
  isStrategicCruiserType,
  getSubsystemSlotFlag,
  isSubsystemCompatibleWithStrategicCruiser,
  getStrategicCruiserSubsystemStatus,
  getValidStrategicCruiserSubsystems,
  getRequiredSkillRequirements,
  getMissingRequiredSkills,
  getShipSlotCounts,
  getFittedEffectSlotsUsed,
  getItemEffectSlotUsage,
  getSlotFlagsForFamily,
  getShipHardpointCounts,
  getStrategicCruiserUseStatus,
  listFittedItems,
  listFittedItemsForLocation,
  listHiddenModifierItems,
  getPassiveModifierSourceItems,
  getFittedModuleItems,
  getLoadedChargeItems,
  getFittedModuleByFlag,
  getLoadedChargeByFlag,
  hasLoadedScanProbeLauncherCharge,
  buildSlimModuleTuples,
  buildModuleStatusSnapshot,
  buildCharacterTargetingState,
  buildChargeTupleItemID,
  buildChargeSublocationData,
  isStructureDogmaHost,
  filterStructureDogmaSkillMap,
  resolveDogmaSkillMapForHost,
  evaluateModuleChargeCompatibility,
  getModuleChargeCapacity,
  getModuleChargeGroupIDs,
  getTurretLikeModuleItems,
  isPassiveModifierSource,
  appendDirectModifierEntries,
  appendSelfItemModifierEntries,
  indexOverloadEffectRecordsByModuleID,
  buildProjectedModuleSourceAttributeMap,
  appendLocationModifierEntries,
  buildEffectiveItemAttributeMap,
  // Exported for read-only consumers that need a fitted module's attributes
  // WITH its ship and skill context applied. `buildEffectiveItemAttributeMap`
  // ignores both, so it reports e.g. a Rifter autocannon's damageMultiplier as
  // 3.465 where the true fitted value is 6.5507 — which makes it unusable as a
  // basis for fit-level damage aggregation. Export only; no behaviour change.
  buildEffectiveFittedModuleAttributeMap,
  buildSkillEffectiveAttributes,
  applySkillDrivenShipAttributeModifiers,
  applySkillFallbackAttributeBonuses,
  getEffectiveModuleResourceLoad,
  applyOtherItemModifiersToAttributes,
  applyModifierGroups,
  buildPropulsionSignatureModifier,
  resolveShipSignatureRadius,
  shouldApplyStackingPenalty,
  synchronizeShipResourceStateSummary,
  buildShipResourceState,
  calculateShipDerivedAttributes,
  isChargeCompatibleWithModule,
  validateFitForShip,
  resolveFitOnlineState,
  moduleParticipatesInOnlineState,
  validateShipTypeOrGroupRestriction,
  selectAutoFitFlagForType,
  getEffectTypeRecord,
};
