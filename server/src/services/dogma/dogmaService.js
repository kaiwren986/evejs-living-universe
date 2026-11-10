"use strict";

const { queueDogmaEvent } = require("../../space/runtime/dogmaEvents");

﻿/**
 * Dogma IM Service (dogmaIM)
 *
 * Handles dogma (attributes/effects) related calls.
 */
const path = require("path");
const { PROXY_NODE_ID } = require(path.join(__dirname, "../../network/protocolProfile"));
const database = require(path.join(__dirname, "../../gameStore"));
const BaseService = require(path.join(__dirname, "../baseService"));
const {
  resolveSessionCharacterID,
} = require(path.join(__dirname, "../_shared/sessionIdentity"));
const log = require(path.join(__dirname, "../../utils/logger"));
const { throwWrappedUserError } = require(path.join(
  __dirname,
  "../../common/machoErrors",
));
const {
  TABLE,
  readStaticTable,
} = require(path.join(__dirname, "../_shared/referenceData"));
const { resolveShipByTypeID } = require(path.join(
  __dirname,
  "../chat/shipTypeRegistry",
));
const {
  getCharacterRecord,
  getActiveShipRecord,
  findCharacterShip,
  activateShipForSession,
  buildItemChangePayload,
  buildChargeSublocationItem,
  syncInventoryItemForSession,
  syncChargeGodmaPrimeForSession,
  syncShipFittingStateForSession,
  buildChargeDogmaPrimeEntry,
} = require(path.join(__dirname, "../character/characterState"));
const {
  getShipConditionState,
  normalizeShipConditionState,
  ITEM_FLAGS,
  getItemMutationVersion,
  findCharacterShipByType,
  findItemById,
  grantItemToCharacterLocation,
  grantItemToOwnerLocation,
  listContainerItems,
  moveItemToLocation,
  transferItemToOwnerLocation,
  removeInventoryItem,
  updateShipItem,
  mergeItemStacks,
  isStackableInventoryItem,
} = require(path.join(__dirname, "../inventory/itemStore"));
const {
  resolveItemByTypeID,
} = require(path.join(__dirname, "../inventory/itemTypeRegistry"));
const {
  getCachedCharacterSkillMap,
  getCharacterSkills,
  getSkillMutationVersion,
} = require(path.join(__dirname, "../skills/skillState"));
const {
  injectSkillbookItems,
} = require(path.join(__dirname, "../skills/skillbooks/skillbookRuntime"));
const {
  getLocationModifierSourcesForSystem,
} = require(path.join(
  __dirname,
  "../exploration/wormholes/wormholeEnvironmentRuntime",
));
const {
  getAttributeIDByNames,
  getFittedModuleItems,
  getFittedModuleByFlag,
  getItemModuleState,
  getLoadedChargeByFlag,
  getLoadedChargeItems,
  getModuleChargeCapacity,
  getEffectIDByNames,
  isFittedChargeItem,
  isFittedModuleItem,
  isModuleOnline,
  isEffectivelyOnlineModule,
  isChargeCompatibleWithModule,
  buildChargeTupleItemID,
  buildEffectiveItemAttributeMap,
  buildSkillEffectiveAttributes,
  getTypeAttributeValue,
  getRequiredSkillRequirements,
  isShipFittingFlag,
  listHiddenModifierItems,
  applyModifierGroups,
  typeHasEffectName,
} = require(path.join(__dirname, "../fitting/liveFittingState"));
const {
  buildShipConditionAttributes,
} = require(path.join(__dirname, "./shipConditionAmounts"));
const {
  buildShipRackHeatAttributes,
} = require(path.join(__dirname, "./activationHeatState"));
const {
  getShipFittingSnapshot,
  listShipFittingAttributeChanges,
} = require(path.join(
  __dirname,
  "../../_secondary/fitting/fittingRuntime",
));
function getAbyssalMgrService() {
  return require("../../abyssal").weatherPolicy;
}

const {
  buildModuleAttributeChangeEvent,
  sendOnMultiEvent,
} = require(path.join(__dirname, "../_shared/godmaMultiEvent"));
const {
  applyActiveImplantLocationModifiersToAttributes,
} = require(path.join(__dirname, "./implants/activeImplantModifiers"));
const {
  syncCharacterDogmaState,
} = require(path.join(__dirname, "./brain/characterBrainRuntime"));
const {
  buildWeaponDogmaAttributeOverrides,
} = require(path.join(__dirname, "../../space/combat/weaponDogma"));
const {
  normalizeNumber,
  currentFileTime,
  buildPackedRow,
  buildMarshalReal,
  buildBoundObjectResponse,
  unwrapMarshalValue,
} = require(path.join(__dirname, "../_shared/serviceHelpers"));
const {
  getDockedLocationID,
  isDockedSession,
} = require(path.join(__dirname, "../structure/structureLocation"));
const {
  buildStructureServiceModuleEffectiveAttributeMap,
  isStructureServiceModuleItem,
} = require(path.join(__dirname, "../structure/structureServiceModules"));
const {
  resolveStructureEffectiveHitpoints,
} = require(path.join(__dirname, "../structure/structureFullPowerDogma"));
const {
  boardRookieShipForSession,
  isRookieShipItem,
  repairShipAndFittedItemsForSession,
  resolveRookieShipTypeID,
} = require(path.join(__dirname, "../ship/rookieShipRuntime"));
const worldData = require(path.join(__dirname, "../../space/worldData"));
const spaceRuntime = require(path.join(__dirname, "../../space/runtime"));
const commandBurstRuntime = require(path.join(
  __dirname,
  "../../space/modules/commandBurstRuntime",
));
const {
  buildLiveModuleAttributeMap,
} = require(path.join(
  __dirname,
  "../../space/modules/liveModuleAttributes",
));
const {
  ATTRIBUTE_PILOT_SECURITY_STATUS,
  ATTRIBUTE_MASS,
  ATTRIBUTE_CAPACITY,
  ATTRIBUTE_MAX_LOCKED_TARGETS,
  ATTRIBUTE_VOLUME,
  ATTRIBUTE_RADIUS,
  ATTRIBUTE_MODULE_REPAIR_RATE,
  ATTRIBUTE_SHIP_BROKEN_MODULE_REPAIR_COST_MULTIPLIER,
  GROUP_SCAN_PROBE_LAUNCHER,
  ANALYZER_EFFECT_NAME,
  clampRatio,
  DBTYPE_I4,
  DBTYPE_I8,
  EFFECT_ONLINE,
} = require(path.join(__dirname, "./dogmaService/shared"));

const REMOVED_ITEM_JUNK_LOCATION_ID = 6;
const ATTRIBUTE_ITEM_DAMAGE = 3;
const ATTRIBUTE_HP = getAttributeIDByNames("hp", "structureHP") || 9;
const ATTRIBUTE_STRUCTURE_HP = ATTRIBUTE_HP;
const ATTRIBUTE_MAX_VELOCITY = getAttributeIDByNames("maxVelocity") || 37;
const ATTRIBUTE_MAX_RANGE = getAttributeIDByNames("maxRange") || 54;
// Base ranges in meters, used only when an analyzer has no usable maxRange.
// Keep T1, T2, integrated and faction ranges distinct; valid dogma wins.
const ANALYZER_BASE_RANGE_FALLBACKS = Object.freeze({
  3581: 10000, // Purloined Sansha Data Analyzer
  22175: 5000, // Data Analyzer I
  22177: 5000, // Relic Analyzer I
  30832: 6000, // Relic Analyzer II
  30834: 6000, // Data Analyzer II
  41533: 5000, // Ligature Integrated Analyzer
  41534: 6000, // Zeugma Integrated Analyzer
  49791: 6000, // Frostline 'Clavicula' Integrated Analyzer
  85750: 6000, // Deathless Circle Relic Analyzer
  93912: 6000, // Revelli's Modified Integrated Analyzer
});
const ATTRIBUTE_MAX_TARGET_RANGE =
  getAttributeIDByNames("maxTargetRange") || 76;
const ATTRIBUTE_FALLOFF = getAttributeIDByNames("falloff") || 158;
const ATTRIBUTE_FALLOFF_EFFECTIVENESS =
  getAttributeIDByNames("falloffEffectiveness") || 2044;
const FALLOFF_EFFECTIVENESS_MODULE_GROUPS = new Set([
  71, // groupEnergyDestabilizer
  68, // groupEnergyVampire
  67, // groupEnergyTransferArray
  325, // groupArmorRepairProjector
  41, // groupShieldTransporter
  585, // groupRemoteHullRepairer
  208, // groupRemoteSensorDamper
  201, // groupElectronicCounterMeasures
  290, // groupRemoteSensorBooster
  209, // groupTrackingLink
  1672, // groupStasisGrappler
  379, // groupTargetPainter
  291, // groupTrackingDisruptor
  1697, // groupFueledRemoteShieldBooster
]);
// CCP parity: attribute 18 ("charge") is the current capacitor energy level in
// GJ.  The client reads shipItem.charge to display the capacitor gauge.
const ATTRIBUTE_CHARGE = 18;
const STRUCTURE_CATEGORY_ID = 65;
const SHIP_CATEGORY_ID = 6;
const MODULE_CATEGORY_ID = 7;
const STRUCTURE_MODULE_CATEGORY_ID = 66;
const ATTRIBUTE_IS_ONLINE = 2;
const ATTRIBUTE_POWER_LOAD = getAttributeIDByNames("powerLoad") || 15;
const ATTRIBUTE_CPU_LOAD = getAttributeIDByNames("cpuLoad") || 49;
const ATTRIBUTE_CAPACITOR_CAPACITY =
  getAttributeIDByNames("capacitorCapacity") || 482;
const ATTRIBUTE_QUANTITY = getAttributeIDByNames("quantity") || 805;
const ATTRIBUTE_RECHARGE_RATE = getAttributeIDByNames("rechargeRate") || 55;
const ATTRIBUTE_CLOAKING_TARGETING_DELAY =
  getAttributeIDByNames("cloakingTargetingDelay") || 560;
const ATTRIBUTE_SCAN_RESOLUTION =
  getAttributeIDByNames("scanResolution") || 564;
const ATTRIBUTE_SIGNATURE_RADIUS =
  getAttributeIDByNames("signatureRadius") || 552;
const ATTRIBUTE_RELOAD_TIME = getAttributeIDByNames("reloadTime") || 1795;
const ATTRIBUTE_NEXT_ACTIVATION_TIME =
  getAttributeIDByNames("nextActivationTime") || 1796;
const ATTRIBUTE_DAMAGE_MULTIPLIER_BONUS_MAX_TIMESTAMP =
  getAttributeIDByNames("damageMultiplierBonusMaxTimestamp") || 5818;
const ATTRIBUTE_SHIP_BROKEN_REPAIR_COST_MULTIPLIER_BONUS =
  getAttributeIDByNames("shipBrokenRepairCostMultiplierBonus") || 1294;
const ATTRIBUTE_MODULE_REPAIR_RATE_BONUS =
  getAttributeIDByNames("moduleRepairRateBonus") || 1295;
const INTEGER_NOTIFY_FORMATTER = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0,
});
const SKILL_NANITE_OPERATION = 28879;
const SKILL_NANITE_INTERFACING = 28880;
const ATTRIBUTE_SHIELD_CAPACITY = 263;
const ATTRIBUTE_SHIELD_CHARGE_HELPER = 264;
const ATTRIBUTE_ARMOR_HP = 265;
const ATTRIBUTE_ARMOR_DAMAGE = 266;
const ATTRIBUTE_STRUCTURE_FULL_POWER_HP_MULTIPLIER =
  getAttributeIDByNames("structureFullPowerStateHitpointMultiplier") || 2743;
const ATTRIBUTE_HIDDEN_ARMOR_HP_MULTIPLIER =
  getAttributeIDByNames("hiddenArmorHPMultiplier") || 2751;
const ATTRIBUTE_STRUCTURE_POWER_STATE_ARMOR_PLATING_MULTIPLIER =
  getAttributeIDByNames("structurePowerStateArmorPlatingMultiplier") || 2805;
const MODULE_ATTRIBUTE_CAPACITOR_NEED =
  getAttributeIDByNames("capacitorNeed") || 6;
const MODULE_ATTRIBUTE_SPEED_FACTOR = getAttributeIDByNames("speedFactor") || 20;
const MODULE_ATTRIBUTE_SPEED = getAttributeIDByNames("speed") || 51;
const MODULE_ATTRIBUTE_DURATION = getAttributeIDByNames("duration") || 73;
const DBTYPE_I2 = 0x02;
const DBTYPE_STR = 0x81;
const USER_ERROR_TYPE_ID = 4;
const EFFECT_AFTERBURNER =
  getEffectIDByNames("moduleBonusAfterburner") || 6731;
const EFFECT_MICROWARPDRIVE =
  getEffectIDByNames("moduleBonusMicrowarpdrive") || 6730;

function getTrainedSkillLevel(skillRecord) {
  return Math.max(
    0,
    Number(
      skillRecord &&
      (skillRecord.effectiveSkillLevel ??
        skillRecord.trainedSkillLevel ??
        skillRecord.skillLevel),
    ) || 0,
  );
}

function getMissingRequiredSkill(characterID, typeID) {
  const skillLevels = new Map(
    getCharacterSkills(Number(characterID) || 0).map((skillRecord) => [
      Number(skillRecord && skillRecord.typeID) || 0,
      getTrainedSkillLevel(skillRecord),
    ]),
  );
  return getRequiredSkillRequirements(Number(typeID) || 0).find((requirement) => {
    const skillTypeID = Number(requirement && requirement.skillTypeID) || 0;
    const requiredLevel = Math.max(
      1,
      Number(requirement && (requirement.requiredLevel ?? requirement.level)) || 1,
    );
    return skillTypeID > 0 && (skillLevels.get(skillTypeID) || 0) < requiredLevel;
  }) || null;
}
const INVENTORY_ROW_DESCRIPTOR_COLUMNS = [
  ["itemID", DBTYPE_I8],
  ["typeID", DBTYPE_I4],
  ["ownerID", DBTYPE_I4],
  ["locationID", DBTYPE_I8],
  ["flagID", DBTYPE_I2],
  ["quantity", DBTYPE_I4],
  ["groupID", DBTYPE_I4],
  ["categoryID", DBTYPE_I4],
  ["customInfo", DBTYPE_STR],
];
const INVENTORY_ROW_DESCRIPTOR_VIRTUAL_COLUMNS = [
  ["stacksize", { type: "token", value: "eve.common.script.sys.eveCfg.StackSize" }],
  ["singleton", { type: "token", value: "eve.common.script.sys.eveCfg.Singleton" }],
];
const pendingModuleReloads = new Map();
let pendingModuleReloadTimer = null;
const RELOAD_PUMP_POLL_MS = 50;
function isNewbieShipItem(item) {
  return isRookieShipItem(item);
}
function resolveNewbieShipTypeID(session, characterRecord = null) {
  return resolveRookieShipTypeID(
    session,
    characterRecord || getCharacterRecord(session && session.characterID) || {},
  );
}
function boardNewbieShipForSession(session, options = {}) {
  const boardResult = boardRookieShipForSession(session, {
    ...options,
    logLabel: String(options.logLabel || "BoardNewbieShip"),
  });
  if (
    boardResult &&
    boardResult.success &&
    boardResult.data &&
    boardResult.data.ship
  ) {
    log.info(
      `[DogmaIM] ${String(options.logLabel || "BoardNewbieShip")} boarded char=${Number(session && session.characterID) || 0} ship=${boardResult.data.ship.itemID} typeID=${boardResult.data.corvetteTypeID} reusedExisting=${boardResult.data.reusedExistingShip === true}`,
    );
  }
  return boardResult;
}
function marshalModuleDurationWireValue(value) {
  if (value === undefined || value === null) {
    return value;
  }
  if (value && typeof value === "object" && value.type === "real") {
    return value;
  }
  const numericValue = normalizeNumber(value, Number.NaN);
  if (!Number.isFinite(numericValue)) {
    return value;
  }
  if (numericValue < 0) {
    return Math.trunc(numericValue);
  }
  return buildMarshalReal(numericValue, 0);
}
function isModuleTimingAttribute(attributeID) {
  const numericAttributeID = Number(attributeID) || 0;
  return (
    numericAttributeID === MODULE_ATTRIBUTE_DURATION ||
    numericAttributeID === MODULE_ATTRIBUTE_SPEED
  );
}
function isMarshalRealDogmaAttribute(attributeID) {
  const numericAttributeID = Number(attributeID) || 0;
  return (
    isModuleTimingAttribute(numericAttributeID) ||
    numericAttributeID === ATTRIBUTE_RECHARGE_RATE ||
    numericAttributeID === ATTRIBUTE_CAPACITOR_CAPACITY
  );
}
function marshalDogmaAttributeValue(attributeID, value) {
  if ((Number(attributeID) || 0) === ATTRIBUTE_DAMAGE_MULTIPLIER_BONUS_MAX_TIMESTAMP) {
    if (typeof value === "bigint") {
      return value;
    }
    const numericValue = normalizeNumber(value, Number.NaN);
    if (!Number.isFinite(numericValue) || numericValue <= 0) {
      return 0;
    }
    return toFileTimeFromMs(numericValue);
  }
  return isMarshalRealDogmaAttribute(attributeID)
    ? marshalModuleDurationWireValue(value)
    : value;
}
function normalizeModuleAttributeChange(change) {
  if (!Array.isArray(change) || change.length === 0) {
    return change;
  }
  const normalized = change.slice();
  // TQ parity: every inner change is a tuple tagged with the SINGULAR
  // 'OnModuleAttributeChange' (the plural is the outer notification name), and its
  // trailing element repeats the change time at index 4 — never null.
  normalized[0] = "OnModuleAttributeChange";
  const attributeID = normalized[3];
  if (normalized.length > 5) {
    normalized[5] = marshalDogmaAttributeValue(attributeID, normalized[5]);
  }
  if (normalized.length > 6) {
    normalized[6] = marshalDogmaAttributeValue(attributeID, normalized[6]);
  }
  normalized[7] = normalized.length > 4 ? normalized[4] : null;
  return normalized;
}
function summarizeDogmaLogValue(value) {
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (Buffer.isBuffer(value)) {
    return value.toString("utf8");
  }
  if (Array.isArray(value)) {
    return value.map((entry) => summarizeDogmaLogValue(entry));
  }
  if (value && typeof value === "object") {
    if (
      Array.isArray(value.entries) ||
      Array.isArray(value.items)
    ) {
      return JSON.parse(JSON.stringify(value, (key, entryValue) => (
        typeof entryValue === "bigint"
          ? entryValue.toString()
          : entryValue
      )));
    }
    return `[${value.constructor && value.constructor.name ? value.constructor.name : "object"}]`;
  }
  return value;
}
function summarizeModuleAttributeChangeLog(change) {
  const normalized = normalizeModuleAttributeChange(change);
  if (!Array.isArray(normalized)) {
    return summarizeDogmaLogValue(normalized);
  }
  return {
    target: summarizeDogmaLogValue(normalized[2]),
    attributeID: Number(normalized[3]) || 0,
    timestamp: summarizeDogmaLogValue(normalized[4]),
    newValue: summarizeDogmaLogValue(normalized[5]),
    oldValue: summarizeDogmaLogValue(normalized[6]),
  };
}
function toFileTimeFromMs(value, fallback = currentFileTime()) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    return fallback;
  }
  return BigInt(Math.trunc(numericValue)) * 10000n + 116444736000000000n;
}
function getSessionSimulationTimeMs(session, fallback = Date.now()) {
  if (session && session._space) {
    return spaceRuntime.getSimulationTimeMsForSession(session, fallback);
  }
  return fallback;
}
function getSessionSimulationFileTime(session, fallback = currentFileTime()) {
  if (session && session._space) {
    return spaceRuntime.getSimulationFileTimeForSession(session, fallback);
  }
  return fallback;
}
function getReloadStateCurrentTimeMs(reloadState, fallback = Date.now()) {
  const session = reloadState && reloadState.session;
  if (session && session._space) {
    return getSessionSimulationTimeMs(session, fallback);
  }
  const systemID = Number(reloadState && reloadState.systemID) || 0;
  if (systemID > 0) {
    return spaceRuntime.getSimulationTimeMsForSystem(systemID, fallback);
  }
  return fallback;
}
function isPendingModuleReloadWindowOpen(reloadState, nowMs = null) {
  if (!reloadState) {
    return false;
  }
  const reloadStartAtMs = Number(reloadState.reloadStartAtMs) || 0;
  if (reloadStartAtMs <= 0) {
    return true;
  }
  const currentTimeMs = Number.isFinite(Number(nowMs))
    ? Number(nowMs)
    : getReloadStateCurrentTimeMs(reloadState, Date.now());
  return reloadStartAtMs <= currentTimeMs;
}
function normalizeReloadSourceItemIDs(rawItemIDs = []) {
  return [...new Set(
    (Array.isArray(rawItemIDs) ? rawItemIDs : [rawItemIDs])
      .map((itemID) => Number(itemID) || 0)
      .filter((itemID) => itemID > 0),
  )];
}
function schedulePendingModuleReloadPump() {
  if (pendingModuleReloadTimer) {
    clearTimeout(pendingModuleReloadTimer);
    pendingModuleReloadTimer = null;
  }
  if (pendingModuleReloads.size === 0) {
    return;
  }
  pendingModuleReloadTimer = setTimeout(() => {
    pendingModuleReloadTimer = null;
    if (
      DogmaService._testing &&
      typeof DogmaService._testing.flushPendingModuleReloads === "function"
    ) {
      DogmaService._testing.flushPendingModuleReloads();
    }
  }, RELOAD_PUMP_POLL_MS);
  if (typeof pendingModuleReloadTimer.unref === "function") {
    pendingModuleReloadTimer.unref();
  }
}
class DogmaService extends BaseService {
  constructor() {
    super("dogmaIM");
    this.reuseBoundObjectForSession = true;
    this._onlineEffectStartTimes = new WeakMap();
  }
  _getDockedItemInfoCache(session, options = {}) {
    if (!session || !isDockedSession(session)) {
      return null;
    }
    const charID = this._getCharID(session);
    const shipID = this._getShipID(session);
    if (charID <= 0 || shipID <= 0) {
      return null;
    }
    const cacheToken = [
      charID,
      shipID,
      getItemMutationVersion(),
      getSkillMutationVersion(),
    ].join(":");
    const allowCreate = options.allowCreate !== false;
    const cached =
      session._dockedDogmaItemInfoCache &&
      typeof session._dockedDogmaItemInfoCache === "object"
        ? session._dockedDogmaItemInfoCache
        : null;
    if (
      cached &&
      cached.token === cacheToken &&
      cached.entries instanceof Map
    ) {
      return cached;
    }
    if (!allowCreate) {
      return null;
    }
    const nextCache = {
      token: cacheToken,
      entries: new Map(),
    };
    session._dockedDogmaItemInfoCache = nextCache;
    return nextCache;
  }
  _buildDockedItemInfoCacheKey(requestedItemID, item = null) {
    if (Array.isArray(requestedItemID)) {
      return `tuple:${JSON.stringify(
        requestedItemID.map((value) => Number(value) || 0),
      )}`;
    }
    const numericRequestedItemID =
      Number.parseInt(String(requestedItemID), 10) || 0;
    if (numericRequestedItemID > 0) {
      return `item:${numericRequestedItemID}`;
    }
    const numericItemID = Number(item && item.itemID) || 0;
    return numericItemID > 0 ? `item:${numericItemID}` : null;
  }
  _getCachedDockedItemInfoEntry(session, requestedItemID, item = null) {
    const cache = this._getDockedItemInfoCache(session, {
      allowCreate: false,
    });
    if (!cache) {
      return null;
    }
    const cacheKey = this._buildDockedItemInfoCacheKey(requestedItemID, item);
    return cacheKey ? cache.entries.get(cacheKey) || null : null;
  }
  _cacheDockedItemInfoEntry(session, requestedItemID, item, entry) {
    if (!entry) {
      return entry;
    }
    // A ship that was stored warm is not kept here: the heat among its attributes
    // is cooled to the time of each answer, and this cache is kept until an item or
    // a skill changes. (A docked ship cannot grow warm, so one kept cold stays so.)
    if (item && item.conditionState && item.conditionState.heat) {
      return entry;
    }
    const cache = this._getDockedItemInfoCache(session, {
      allowCreate: true,
    });
    if (!cache) {
      return entry;
    }
    const cacheKeys = [];
    const requestedKey = this._buildDockedItemInfoCacheKey(requestedItemID, item);
    if (requestedKey) {
      cacheKeys.push(requestedKey);
    }
    const itemKey = this._buildDockedItemInfoCacheKey(
      Number(item && item.itemID) || 0,
      item,
    );
    if (itemKey && !cacheKeys.includes(itemKey)) {
      cacheKeys.push(itemKey);
    }
    for (const cacheKey of cacheKeys) {
      cache.entries.set(cacheKey, entry);
    }
    return entry;
  }
  _coalesce(value, fallback) {
    return value === undefined || value === null ? fallback : value;
  }
  _getCharID(session) {
    return resolveSessionCharacterID(session);
  }
  _isControllingStructureSession(session) {
    const structureID = Number(
      session && (session.structureID || session.structureid),
    ) || 0;
    const shipID = Number(session && (session.shipID || session.shipid)) || 0;
    return structureID > 0 && shipID === structureID;
  }
  _getControlledStructureInventoryOwnerID(session, locationID) {
    if (!this._isControllingStructureSession(session)) {
      return 0;
    }
    const numericLocationID = Number(locationID) || 0;
    const structureID = Number(
      session && (session.structureID || session.structureid),
    ) || 0;
    const shipID = Number(session && (session.shipID || session.shipid)) || 0;
    if (
      numericLocationID <= 0 ||
      (numericLocationID !== structureID && numericLocationID !== shipID)
    ) {
      return 0;
    }
    const structure =
      worldData.getStructureByID(numericLocationID) ||
      worldData.getStructureByID(structureID) ||
      null;
    return Number(structure && (structure.ownerCorpID || structure.ownerID)) || 0;
  }
  _getDogmaInventoryOwnerID(session, locationID) {
    const structureOwnerID = this._getControlledStructureInventoryOwnerID(
      session,
      locationID,
    );
    return structureOwnerID > 0 ? structureOwnerID : this._getCharID(session);
  }
  _getShipID(session) {
    if (this._isControllingStructureSession(session)) {
      return (
        session &&
        (session.shipID || session.shipid)
      ) || 140000101;
    }
    return (
      session &&
      (session.activeShipID || session.shipID || session.shipid)
    ) || 140000101;
  }
  _getShipTypeID(session) {
    return session && Number.isInteger(session.shipTypeID) && session.shipTypeID > 0
      ? session.shipTypeID
      : 606;
  }
  _getDogmaAttributeDefaultValue(attributeID, fallback = 0) {
    const numericAttributeID = Number(attributeID) || 0;
    if (numericAttributeID <= 0) {
      return fallback;
    }
    const typeDogma = readStaticTable(TABLE.TYPE_DOGMA);
    const attributeTypesByID =
      typeDogma && typeDogma.attributeTypesByID &&
      typeof typeDogma.attributeTypesByID === "object"
        ? typeDogma.attributeTypesByID
        : {};
    const record = attributeTypesByID[String(numericAttributeID)] ||
      attributeTypesByID[numericAttributeID] ||
      null;
    const defaultValue = Number(record && record.defaultValue);
    return Number.isFinite(defaultValue) ? defaultValue : fallback;
  }
  _getCharacterSkillEffectiveAttributes(charID, skillTypeID) {
    const numericCharID = Number(charID) || 0;
    const numericSkillTypeID = Number(skillTypeID) || 0;
    if (numericSkillTypeID <= 0) {
      return {};
    }
    const skillRecord =
      numericCharID > 0
        ? getCharacterSkills(numericCharID).find(
            (skill) => Number(skill && skill.typeID) === numericSkillTypeID,
          )
        : null;
    return buildSkillEffectiveAttributes(skillRecord || {
      typeID: numericSkillTypeID,
      skillLevel: 0,
      trainedSkillLevel: 0,
      effectiveSkillLevel: 0,
    });
  }
  _resolveCharacterNaniteRepairAttributes(charID) {
    const baseRepairRate = this._getDogmaAttributeDefaultValue(
      ATTRIBUTE_MODULE_REPAIR_RATE,
      10,
    );
    const baseRepairCostMultiplier = this._getDogmaAttributeDefaultValue(
      ATTRIBUTE_SHIP_BROKEN_MODULE_REPAIR_COST_MULTIPLIER,
      0.5,
    );
    const operationAttributes = this._getCharacterSkillEffectiveAttributes(
      charID,
      SKILL_NANITE_OPERATION,
    );
    const interfacingAttributes = this._getCharacterSkillEffectiveAttributes(
      charID,
      SKILL_NANITE_INTERFACING,
    );
    const repairCostBonus = Number(
      operationAttributes[ATTRIBUTE_SHIP_BROKEN_REPAIR_COST_MULTIPLIER_BONUS],
    ) || 0;
    const repairRateBonus = Number(
      interfacingAttributes[ATTRIBUTE_MODULE_REPAIR_RATE_BONUS],
    ) || 0;
    return {
      moduleRepairRate: Math.max(
        0.01,
        baseRepairRate * (1 + repairRateBonus / 100),
      ),
      repairCostMultiplier: Math.max(
        0.01,
        baseRepairCostMultiplier * (1 + repairCostBonus / 100),
      ),
    };
  }
  _buildStructureControlShipMetadata(structure = null) {
    if (!structure) {
      return null;
    }
    const typeID = Number(structure.typeID) || 0;
    const itemType = resolveItemByTypeID(typeID) || {};
    const effectiveHitpoints = resolveStructureEffectiveHitpoints(structure);
    const fullPowerDogma = effectiveHitpoints.fullPowerDogma || {};
    return {
      itemID: Number(structure.structureID) || 0,
      typeID,
      ownerID: Number(structure.ownerCorpID || structure.ownerID) || 0,
      // TQ keeps the controlled structure's canonical inventory identity. It
      // becomes the active shipID without becoming its own inventory location.
      locationID: Number(structure.solarSystemID || structure.locationID) || 0,
      flagID: 0,
      quantity: -1,
      singleton: 1,
      stacksize: 1,
      groupID: Number(itemType.groupID) || 0,
      categoryID: Number(itemType.categoryID) || 0,
      customInfo: "",
      mass: Number(structure.mass ?? itemType.mass) || 0,
      volume: Number(structure.volume ?? itemType.volume) || 0,
      capacity: Number(structure.capacity ?? itemType.capacity) || 0,
      radius: Number(structure.radius ?? itemType.radius) || 0,
      shieldCapacity: Number(effectiveHitpoints.effectiveShieldCapacity) || 0,
      armorHP: Number(effectiveHitpoints.effectiveArmorHP) || 0,
      structureHP: Number(effectiveHitpoints.effectiveStructureHP) || 0,
      hullHP: Number(effectiveHitpoints.effectiveStructureHP) || 0,
      dogmaAttributeOverrides: {
        [ATTRIBUTE_STRUCTURE_FULL_POWER_HP_MULTIPLIER]:
          Number(fullPowerDogma.hitpointMultiplier) || 1,
        [ATTRIBUTE_HIDDEN_ARMOR_HP_MULTIPLIER]:
          Number(fullPowerDogma.hiddenArmorHPMultiplier) || 1,
        [ATTRIBUTE_STRUCTURE_POWER_STATE_ARMOR_PLATING_MULTIPLIER]:
          Number(fullPowerDogma.armorPlatingMultiplier) || 0,
      },
      conditionState:
        structure && structure.conditionState && typeof structure.conditionState === "object"
          ? { ...structure.conditionState }
          : null,
    };
  }
  _getControlledStructureShipMetadata(session) {
    if (!this._isControllingStructureSession(session)) {
      return null;
    }
    return this._getStructureShipMetadataByID(
      session && (session.structureID || session.structureid),
    );
  }
  _getStructureShipMetadataByID(structureID) {
    const numericStructureID = Number(structureID) || 0;
    if (numericStructureID <= 0) {
      return null;
    }
    return this._buildStructureControlShipMetadata(
      worldData.getStructureByID(numericStructureID) || null,
    );
  }
  _getShipMetadata(session) {
    const controlledStructureShip = this._getControlledStructureShipMetadata(session);
    if (controlledStructureShip) {
      return controlledStructureShip;
    }
    const shipTypeID = this._getShipTypeID(session);
    return (
      resolveShipByTypeID(shipTypeID) || {
        typeID: shipTypeID,
        name: (session && session.shipName) || "Ship",
        groupID: 25,
        categoryID: 6,
      }
    );
  }
  _getCharacterRecord(session) {
    return getCharacterRecord(this._getCharID(session));
  }
  _getActiveShipRecord(session) {
    return getActiveShipRecord(this._getCharID(session));
  }
  _getCurrentDogmaShipContext(session) {
    const controlledStructureShip = this._getControlledStructureShipMetadata(session);
    if (controlledStructureShip) {
      return {
        shipID: controlledStructureShip.itemID,
        shipMetadata: controlledStructureShip,
        shipRecord: controlledStructureShip,
        controllingStructure: true,
      };
    }
    const activeShip = this._getActiveShipRecord(session);
    const shipMetadata = activeShip || this._getShipMetadata(session);
    return {
      shipID: activeShip ? activeShip.itemID : this._getShipID(session),
      shipMetadata,
      shipRecord: activeShip,
      controllingStructure: false,
    };
  }
  _getLocationID(session) {
    return (
      (getDockedLocationID(session) || (session && (session.locationid || session.solarsystemid2 || session.solarsystemid))) ||
      60003760
    );
  }
  _nowFileTime() {
    return BigInt(Date.now()) * 10000n + 116444736000000000n;
  }
  // Scene-aware filetime: returns the solar system's sim filetime when the
  // session is in space, wallclock filetime otherwise.  Use this for any
  // timestamp that is sent to the client so it stays coherent with TiDi.
  _sessionFileTime(session) {
    return getSessionSimulationFileTime(session, this._nowFileTime());
  }
  _toFileTime(value, fallback = null) {
    const fallbackValue =
      typeof fallback === "bigint" ? fallback : this._nowFileTime();
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue) || numericValue <= 0) {
      return fallbackValue;
    }
    return BigInt(Math.trunc(numericValue)) * 10000n + 116444736000000000n;
  }
  _buildInvRow({
    itemID,
    typeID,
    ownerID,
    locationID,
    flagID,
    groupID,
    categoryID,
    quantity = -1,
    singleton = 1,
    stacksize = 1,
    customInfo = "",
    preserveNullCustomInfo = false,
  }) {
    const normalizedQuantity = Number.isFinite(Number(quantity))
      ? quantity
      : -1;
    const normalizedSingleton =
      singleton === null || singleton === undefined
        ? (normalizedQuantity === -1 ? 1 : 0)
        : singleton;
    const normalizedStacksize =
      stacksize === null || stacksize === undefined
        ? (normalizedSingleton === 1
          ? 1
          : (normalizedQuantity === -1 ? 0 : normalizedQuantity))
        : stacksize;
    const normalizedCustomInfo = preserveNullCustomInfo && customInfo == null
      ? null
      : customInfo === null || customInfo === undefined
        ? ""
        : customInfo;
    return buildPackedRow(
      INVENTORY_ROW_DESCRIPTOR_COLUMNS,
      {
        itemID,
        typeID,
        ownerID,
        locationID,
        flagID,
        quantity: normalizedQuantity,
        groupID,
        categoryID,
        customInfo: normalizedCustomInfo,
        stacksize: normalizedStacksize,
        singleton: normalizedSingleton,
      },
      INVENTORY_ROW_DESCRIPTOR_VIRTUAL_COLUMNS,
    );
  }
  // The two clocks a part of an answer is stamped with.
  _getInfoEntryClocks(session = null) {
    // TQ sends the simulation and wall clocks independently. They are close
    // while docked, but are not the same field and can diverge under TiDi.
    const time = session ? this._sessionFileTime(session) : this._nowFileTime();
    let wallclockTime = this._nowFileTime();
    if (typeof time === "bigint" && wallclockTime === time) {
      // Date.now() only has millisecond precision; retain distinct clock
      // semantics at the 100ns FILETIME precision used by the wire payload.
      wallclockTime = time - 1n;
    }
    return { time, wallclockTime };
  }
  _buildCommonGetInfoEntry({
    itemID,
    typeID,
    ownerID,
    locationID,
    flagID,
    groupID,
    categoryID,
    quantity = -1,
    singleton = 1,
    stacksize = 1,
    customInfo = "",
    preserveNullCustomInfo = false,
    attributes = null,
    activeEffects = null,
    invItem,
    session = null,
  }) {
    const resolvedInvItem = invItem === undefined
      ? this._buildInvRow({
          itemID,
          typeID,
          ownerID,
          locationID,
          flagID,
          groupID,
          categoryID,
          quantity,
          singleton,
          stacksize,
          customInfo,
          preserveNullCustomInfo,
        })
      : invItem;
    const { time, wallclockTime } = this._getInfoEntryClocks(session);
    const entries = [
      ["itemID", itemID],
      ["invItem", resolvedInvItem],
      ["activeEffects", activeEffects || { type: "dict", entries: [] }],
      ["time", time],
      ["attributes", attributes || { type: "dict", entries: [] }],
      ["wallclockTime", wallclockTime],
    ];
    return {
      type: "object",
      name: "util.KeyVal",
      args: {
        type: "dict",
        entries: entries,
      },
    };
  }
  _buildStatusRow({
    itemID,
    online = false,
    damage = 0.0,
    charge = 0.0,
    skillPoints = 0,
    armorDamage = 0.0,
    shieldCharge = 0.0,
    incapacitated = false,
  }) {
    return {
      type: "object",
      name: "util.Row",
      args: {
        type: "dict",
        entries: [
          ["header", ["instanceID", "online", "damage", "charge", "skillPoints", "armorDamage", "shieldCharge", "incapacitated"]],
          ["line", [itemID, online, damage, charge, skillPoints, armorDamage, shieldCharge, incapacitated]],
        ],
      },
    };
  }
  _getShipRuntimeAttributeOverrides(session, shipData = {}) {
    if (!session || !session._space || !shipData) {
      return null;
    }
    const activeShipID = Number(
      shipData.itemID ??
      shipData.shipID ??
      this._getShipID(session),
    ) || 0;
    const runtimeState = spaceRuntime.getShipAttributeSnapshot(session);
    if (!runtimeState || Number(runtimeState.itemID) !== activeShipID) {
      return null;
    }
    return runtimeState;
  }
  _getSessionLocationModifierSources(session, shipItemID = 0) {
    const systemID = session &&
      (
        session.solarsystemid2 ||
        session.solarsystemid ||
        (session._space && session._space.systemID) ||
        0
      );
    const modifierSources = [
      ...require("../homefront/homefrontHooks").weather.locationModifiers(
        spaceRuntime.getSceneForSession(session)?.getEntityByID(Number(shipItemID)||this._getShipID(session)),
      ),
      ...getLocationModifierSourcesForSystem(systemID),
    ];
    const abyssalMgrService = getAbyssalMgrService();
    if (
      abyssalMgrService &&
      typeof abyssalMgrService.collectAbyssalLocationModifierSourcesForShipID === "function"
    ) {
      modifierSources.push(
        ...abyssalMgrService.collectAbyssalLocationModifierSourcesForShipID(
          Number(shipItemID) || 0,
        ),
      );
    }
    return modifierSources;
  }
  _getPropulsionModuleAttributeOverrides(item, session) {
    if (!item || !session || Number(item.flagID) === ITEM_FLAGS.DRONE_BAY) {
      return null;
    }
    const runtimeAttributes = spaceRuntime.getPropulsionModuleRuntimeAttributes(
      this._getCharID(session),
      item,
      {
        activeModuleContexts:
          spaceRuntime &&
          typeof spaceRuntime.getActiveModuleContextsForSession === "function"
            ? spaceRuntime.getActiveModuleContextsForSession(session, {
              excludeModuleID: Number(item && item.itemID) || 0,
              includeOverloadModuleID: Number(item && item.itemID) || 0,
            })
            : [],
      },
    );
    if (
      !runtimeAttributes ||
      !Number.isFinite(Number(runtimeAttributes.speedBoostFactor)) ||
      Number(runtimeAttributes.speedBoostFactor) <= 0
    ) {
      return null;
    }
    return runtimeAttributes;
  }
  _getGenericModuleAttributeOverrides(item, session, options = {}) {
    if (!item || !session || Number(item.flagID) === ITEM_FLAGS.DRONE_BAY) {
      return null;
    }
    const charID = this._getCharID(session);
    let shipItem = getActiveShipRecord(charID);
    if (
      !shipItem ||
      Number(shipItem.itemID) !== Number(item.locationID)
    ) {
      shipItem = findItemById(item.locationID);
    }
    if (
      !shipItem ||
      Number(shipItem.itemID) !== Number(item.locationID)
    ) {
      return null;
    }
    const chargeItem =
      this._getFittingContextChargeByFlag(
        options.fittingContext,
        charID,
        shipItem.itemID,
        item.flagID,
      ) ||
      getLoadedChargeByFlag(
        charID,
        shipItem.itemID,
        item.flagID,
      );
    const activeModuleContexts =
      spaceRuntime &&
      typeof spaceRuntime.getActiveModuleContextsForSession === "function"
        ? spaceRuntime.getActiveModuleContextsForSession(session, {
          excludeModuleID: Number(item && item.itemID) || 0,
          includeOverloadModuleID: Number(item && item.itemID) || 0,
        })
        : [];
    const additionalLocationModifierSources =
      this._getSessionLocationModifierSources(session, shipItem.itemID);
    const fittingSnapshotOptions = this._getFittingContextSnapshotOptions(
      options.fittingContext,
      charID,
      shipItem.itemID,
    );
    const runtimeAttributes = spaceRuntime.getGenericModuleRuntimeAttributes(
      charID,
      shipItem,
      item,
      chargeItem,
      null,
      {
        activeModuleContexts,
        additionalLocationModifierSources,
        ...fittingSnapshotOptions,
      },
    );
    if (!runtimeAttributes) {
      return null;
    }

    const activeEffectState =
      spaceRuntime &&
      typeof spaceRuntime.getActiveModuleEffect === "function"
        ? spaceRuntime.getActiveModuleEffect(session, Number(item && item.itemID) || 0)
        : null;
    const activeAttributeOverrides =
      activeEffectState &&
      activeEffectState.genericAttributeOverrides &&
      typeof activeEffectState.genericAttributeOverrides === "object"
        ? activeEffectState.genericAttributeOverrides
        : null;
    if (!activeAttributeOverrides) {
      return runtimeAttributes;
    }

    return {
      ...runtimeAttributes,
      attributeOverrides: {
        ...(runtimeAttributes.attributeOverrides || {}),
        ...activeAttributeOverrides,
      },
    };
  }
  _buildScannerProbeLauncherRuntimeAttributeMap(item, session) {
    if (
      !item ||
      !session ||
      Number(item.groupID) !== GROUP_SCAN_PROBE_LAUNCHER
    ) {
      return null;
    }

    const runtimeAttributes = this._getGenericModuleAttributeOverrides(item, session);
    if (!runtimeAttributes) {
      return null;
    }

    const attributes = {};
    if (Number.isFinite(Number(runtimeAttributes.capNeed))) {
      attributes[MODULE_ATTRIBUTE_CAPACITOR_NEED] = Number(
        runtimeAttributes.capNeed,
      );
    }

    const durationAttributeID =
      Number(runtimeAttributes.durationAttributeID) || MODULE_ATTRIBUTE_DURATION;
    if (Number.isFinite(Number(runtimeAttributes.durationMs))) {
      attributes[durationAttributeID] = Number(runtimeAttributes.durationMs);
    }

    const attributeOverrides =
      runtimeAttributes.attributeOverrides &&
      typeof runtimeAttributes.attributeOverrides === "object"
        ? runtimeAttributes.attributeOverrides
        : null;
    if (
      attributeOverrides &&
      Number.isFinite(Number(attributeOverrides[MODULE_ATTRIBUTE_SPEED]))
    ) {
      attributes[MODULE_ATTRIBUTE_SPEED] = Number(
        attributeOverrides[MODULE_ATTRIBUTE_SPEED],
      );
    }

    const reloadRuntimeAttributes = this._getModuleReloadAttributeOverrides(
      item,
      session,
    );
    if (
      reloadRuntimeAttributes &&
      Number.isFinite(Number(reloadRuntimeAttributes.reloadTime))
    ) {
      attributes[ATTRIBUTE_RELOAD_TIME] = Number(
        reloadRuntimeAttributes.reloadTime,
      );
    }

    return attributes;
  }
  _syncScannerProbeLauncherRuntimeAttributes(
    session,
    moduleItem,
    options = {},
  ) {
    if (!session || typeof session.sendNotification !== "function" || !moduleItem) {
      return 0;
    }

    const runtimeAttributes = this._buildScannerProbeLauncherRuntimeAttributeMap(
      moduleItem,
      session,
    );
    if (!runtimeAttributes) {
      return 0;
    }

    const numericModuleID = Number(moduleItem.itemID) || 0;
    const numericCharID = Number(moduleItem.ownerID) || this._getCharID(session);
    if (numericModuleID <= 0 || numericCharID <= 0) {
      return 0;
    }

    const forceAll = options.forceAll === true;
    const when = this._sessionFileTime(session);
    const changes = [];
    for (const [rawAttributeID, rawValue] of Object.entries(runtimeAttributes)) {
      const attributeID = Number(rawAttributeID);
      const nextValue = Number(rawValue);
      if (
        !Number.isInteger(attributeID) ||
        attributeID <= 0 ||
        !Number.isFinite(nextValue)
      ) {
        continue;
      }
      if (!forceAll && Math.abs(nextValue) <= 1e-9) {
        continue;
      }
      changes.push([
        "OnModuleAttributeChanges",
        numericCharID,
        numericModuleID,
        attributeID,
        when,
        nextValue,
        forceAll ? 0 : nextValue,
        null,
      ]);
    }

    if (changes.length <= 0) {
      return 0;
    }
    this._notifyModuleAttributeChanges(session, changes);
    return changes.length;
  }
  _refreshScannerProbeLauncherClientState(
    session,
    shipID,
    moduleItem,
    options = {},
  ) {
    if (
      !session ||
      !session._space ||
      !moduleItem ||
      Number(moduleItem.groupID) !== GROUP_SCAN_PROBE_LAUNCHER
    ) {
      return 0;
    }

    void shipID;
    if (options.forceRuntimeSync === true) {
      this._syncScannerProbeLauncherRuntimeAttributes(session, moduleItem, {
        forceAll: true,
      });
    }
    return 0;
  }
  _resolveLoadedChargeItem(item, session = null, options = {}) {
    if (!item || !session || !isShipFittingFlag(item.flagID)) {
      return null;
    }
    if (
      item.loadedChargeItem &&
      Number(item.loadedChargeItem.typeID) > 0 &&
      Number(item.loadedChargeItem.flagID) === Number(item.flagID)
    ) {
      return item.loadedChargeItem;
    }
    const charID = this._getCharID(session);
    const shipID = Number(item.locationID) || 0;
    const flagID = Number(item.flagID) || 0;
    if (charID <= 0 || shipID <= 0 || flagID <= 0) {
      return null;
    }
    const contextCharge = this._getFittingContextChargeByFlag(
      options.fittingContext,
      charID,
      shipID,
      flagID,
    );
    if (contextCharge) {
      return contextCharge;
    }
    return getLoadedChargeByFlag(charID, shipID, flagID);
  }
  _getWeaponDogmaAttributeOverrides(item, session = null, options = {}) {
    if (
      !item ||
      Number(item.flagID) === ITEM_FLAGS.DRONE_BAY ||
      !isShipFittingFlag(item.flagID)
    ) {
      return null;
    }
    const characterID = Number(item.ownerID) || this._getCharID(session);
    const shipID = Number(item.locationID) || 0;
    if (characterID <= 0 || shipID <= 0) {
      return null;
    }
    const activeShipRecord = this._getActiveShipRecord(session);
    const shipItem =
      findCharacterShip(characterID, shipID) ||
      (
        activeShipRecord &&
        Number(activeShipRecord.itemID) === shipID
          ? activeShipRecord
          : null
      );
    if (!shipItem) {
      return null;
    }
    const isChargeItem = Number(item.categoryID) === 8;
    const moduleItem = isChargeItem
      ? (
          this._getFittingContextModuleByFlag(
            options.fittingContext,
            characterID,
            shipID,
            item.flagID,
          ) ||
          getFittedModuleByFlag(characterID, shipID, item.flagID)
        )
      : item;
    const chargeItem = isChargeItem
      ? item
      : this._resolveLoadedChargeItem(item, session, options);
    if (!moduleItem) {
      return null;
    }
    return this._getWeaponDogmaAttributeOverridesForCharge(
      moduleItem,
      chargeItem,
      session,
      options,
    );
  }
  _getWeaponDogmaAttributeOverridesForCharge(
    moduleItem,
    chargeItem = null,
    session = null,
    options = {},
  ) {
    if (!moduleItem || !isShipFittingFlag(moduleItem.flagID)) {
      return null;
    }
    const characterID = Number(moduleItem.ownerID) || this._getCharID(session);
    const shipID = Number(moduleItem.locationID) || 0;
    if (characterID <= 0 || shipID <= 0) {
      return null;
    }
    const activeShipRecord = this._getActiveShipRecord(session);
    const shipItem =
      findCharacterShip(characterID, shipID) ||
      (
        activeShipRecord &&
        Number(activeShipRecord.itemID) === shipID
          ? activeShipRecord
          : null
      );
    if (!shipItem) {
      return null;
    }
    return buildWeaponDogmaAttributeOverrides({
      characterID,
      shipItem,
      moduleItem,
      chargeItem,
      activeModuleContexts: this._getWeaponActiveModuleContexts(
        session,
        moduleItem,
        activeShipRecord,
        shipID,
      ),
      ...this._getFittingContextSnapshotOptions(
        options.fittingContext,
        characterID,
        shipID,
      ),
    });
  }
  // The space runtime feeds `buildWeaponModuleSnapshot` the live active module
  // contexts, so a running Tracking Computer / Bastion / Missile Guidance
  // Computer already moves a turret's range, falloff, tracking and speed there.
  // Client-facing reads have to use the same list or they answer with cold
  // values while the module is running.  Docked sessions carry no `_space`, and
  // a module fitted to a ship other than the one being flown is not covered by
  // the flown ship's running modules, so both stay on the empty list.
  _getWeaponActiveModuleContexts(
    session,
    moduleItem,
    activeShipRecord = null,
    shipID = 0,
  ) {
    if (
      !session ||
      !session._space ||
      !activeShipRecord ||
      Number(activeShipRecord.itemID) !== Number(shipID) ||
      !spaceRuntime ||
      typeof spaceRuntime.getActiveModuleContextsForSession !== "function"
    ) {
      return [];
    }
    return spaceRuntime.getActiveModuleContextsForSession(session, {
      excludeModuleID: Number(moduleItem && moduleItem.itemID) || 0,
      includeOverloadModuleID: Number(moduleItem && moduleItem.itemID) || 0,
    });
  }
  _buildWeaponModuleAttributeMap(moduleItem, chargeItem = null, session = null) {
    const weaponDogmaAttributes = this._getWeaponDogmaAttributeOverridesForCharge(
      moduleItem,
      chargeItem,
      session,
    );
    const moduleAttributes =
      weaponDogmaAttributes &&
      weaponDogmaAttributes.moduleAttributes &&
      typeof weaponDogmaAttributes.moduleAttributes === "object"
        ? weaponDogmaAttributes.moduleAttributes
        : null;
    if (!moduleAttributes) {
      return null;
    }
    return Object.fromEntries(
      Object.entries(moduleAttributes)
        .map(([attributeID, value]) => [Number(attributeID), Number(value)])
        .filter(
          ([attributeID, value]) =>
            Number.isInteger(attributeID) && Number.isFinite(value),
        ),
    );
  }
  _getFittedModuleResourceAttributeOverrides(item, session = null, options = {}) {
    if (
      !item ||
      Number(item.categoryID) === 8 ||
      Number(item.flagID) === ITEM_FLAGS.DRONE_BAY ||
      !isShipFittingFlag(item.flagID)
    ) {
      return null;
    }
    const characterID = Number(item.ownerID) || this._getCharID(session);
    const shipID = Number(item.locationID) || 0;
    if (characterID <= 0 || shipID <= 0) {
      return null;
    }
    const activeShipRecord = this._getActiveShipRecord(session);
    const shipItem =
      findCharacterShip(characterID, shipID) ||
      (
        activeShipRecord &&
        Number(activeShipRecord.itemID) === shipID
          ? activeShipRecord
          : null
      );
    if (!shipItem) {
      return null;
    }

    const fittingSnapshot = getShipFittingSnapshot(characterID, shipID, {
      shipItem,
      reason: "dogma.module-attrs",
      ...this._getFittingContextSnapshotOptions(
        options.fittingContext,
        characterID,
        shipID,
      ),
    });
    return fittingSnapshot
      ? fittingSnapshot.getModuleAttributeOverrides(item)
      : null;
  }
  _buildShipAttributes(charData = {}, shipData = {}, session = null, options = {}) {
    const securityStatus = Number(
      charData.securityStatus ??
        charData.securityRating ??
        shipData.securityStatus ??
        shipData.securityRating ??
        0,
    );
    const shipCondition = getShipConditionState(shipData);
    const numericCharID = Number(charData.characterID ?? charData.charID ?? charData.charid ?? shipData.ownerID ?? 0) || 0;
    const fittingSnapshot = getShipFittingSnapshot(
      numericCharID,
      shipData && shipData.itemID,
      {
        shipItem: shipData,
        reason: "dogma.ship-attrs",
        ...this._getFittingContextSnapshotOptions(
          options.fittingContext,
          numericCharID,
          shipData && shipData.itemID,
        ),
      },
    );
    const attributes = fittingSnapshot
      ? { ...fittingSnapshot.shipAttributes }
      : {};
    const runtimeAttributeOverrides = this._getShipRuntimeAttributeOverrides(
      session,
      shipData,
    );
    const shipTypeID = Number(shipData.typeID);
    const shipMetadata =
      Number.isInteger(shipTypeID) && shipTypeID > 0
        ? resolveShipByTypeID(shipTypeID)
        : null;
    const resolvedMass = Number(shipData.mass ?? (shipMetadata && shipMetadata.mass));
    if (!(ATTRIBUTE_MASS in attributes) && Number.isFinite(resolvedMass)) {
      attributes[ATTRIBUTE_MASS] = resolvedMass;
    }
    const resolvedVolume = Number(shipData.volume ?? (shipMetadata && shipMetadata.volume));
    if (!(ATTRIBUTE_VOLUME in attributes) && Number.isFinite(resolvedVolume)) {
      attributes[ATTRIBUTE_VOLUME] = resolvedVolume;
    }
    const resolvedRadius = Number(shipData.radius ?? (shipMetadata && shipMetadata.radius));
    if (!(ATTRIBUTE_RADIUS in attributes) && Number.isFinite(resolvedRadius)) {
      attributes[ATTRIBUTE_RADIUS] = resolvedRadius;
    }
    if (
      runtimeAttributeOverrides &&
      runtimeAttributeOverrides.attributes &&
      typeof runtimeAttributeOverrides.attributes === "object"
    ) {
      for (const [attributeID, value] of Object.entries(runtimeAttributeOverrides.attributes)) {
        const numericAttributeID = Number(attributeID);
        const numericValue = Number(value);
        if (!Number.isInteger(numericAttributeID) || !Number.isFinite(numericValue)) {
          continue;
        }
        attributes[numericAttributeID] = numericValue;
      }
    }
    if (runtimeAttributeOverrides) {
      attributes[ATTRIBUTE_MASS] = Number(runtimeAttributeOverrides.mass);
      attributes[ATTRIBUTE_MAX_VELOCITY] = Number(
        runtimeAttributeOverrides.maxVelocity,
      );
      attributes[ATTRIBUTE_MAX_TARGET_RANGE] = Number(
        runtimeAttributeOverrides.maxTargetRange,
      );
      attributes[ATTRIBUTE_MAX_LOCKED_TARGETS] = Number(
        runtimeAttributeOverrides.maxLockedTargets,
      );
      attributes[ATTRIBUTE_SIGNATURE_RADIUS] = Number(
        runtimeAttributeOverrides.signatureRadius,
      );
      attributes[ATTRIBUTE_CLOAKING_TARGETING_DELAY] = Number(
        runtimeAttributeOverrides.cloakingTargetingDelay,
      );
      attributes[ATTRIBUTE_SCAN_RESOLUTION] = Number(
        runtimeAttributeOverrides.scanResolution,
      );
    }
    // The ship's shield charge, armor damage, hull damage and capacitor charge, each in
    // its own units: shipConditionAmounts.js.
    Object.assign(attributes, buildShipConditionAttributes(attributes, shipCondition));
    // Each rack's heat (heatHi, heatMed and heatLow), 0 for a cold rack:
    // activationHeatState.js. In space it is what the ship's rack holds, and
    // docked what was stored with the ship, cooled by the time since.
    // options.heatAtMs is the time the stored heat is cooled to, where one answer
    // tells it in more than one place.
    Object.assign(attributes, buildShipRackHeatAttributes(
      spaceRuntime.readShipRackHeat(
        session,
        shipData,
        Number.isFinite(options.heatAtMs) ? options.heatAtMs : Date.now(),
      ),
    ));
    attributes[ATTRIBUTE_PILOT_SECURITY_STATUS] = Number.isFinite(securityStatus)
      ? securityStatus
      : 0;
    return {
      ...attributes,
      [ATTRIBUTE_PILOT_SECURITY_STATUS]: Number.isFinite(securityStatus)
        ? securityStatus
        : 0,
    };
  }
  // options.realValues marks the dict for the marshaller (marshal.js): every
  // plain number among the values goes out as a float, whole or not, but for
  // those under options.integerKeys, which go as they are. The values here, and
  // the JSON the web gateway makes of them, are the numbers they were.
  _buildAttributeValueDict(attributes = {}, options = {}) {
    return {
      type: "dict",
      ...(options.realValues === true ? { realValues: true } : {}),
      ...(options.realValues === true &&
        Array.isArray(options.integerKeys) &&
        options.integerKeys.length > 0
        ? { integerKeys: options.integerKeys }
        : {}),
      entries: Object.entries(attributes).map(([attributeID, value]) => [
        Number(attributeID),
        marshalDogmaAttributeValue(attributeID, value),
      ]),
    };
  }
  // How an item's attribute values go on the wire, as _buildAttributeValueDict's
  // options: floats whatever they hold, as Tranquility sends them, for the kinds
  // of item its client's godma printed as it loaded them ("godma UpdateItem:").
  //
  // Ships and structures: 8,622 of 8,623 attribute values of 80 ships and all
  // 1,045 of 11 structures are floats.
  //
  // Modules and structure modules: 16,338 floats and 1,910 integers in 679. The
  // integers are a module's isOnline where it is 1 (an offline one's is 0.0), its
  // charge and shieldCharge, which are 0 (a module's shieldCapacity beside them is
  // 0.0), and a time, which is not a plain number here.
  //
  // Nothing was printed of any other kind of item, and those are left as they
  // were.
  _getAttributeWireKinds(item, attributes = {}) {
    const categoryID = Number(item && item.categoryID);
    if (categoryID === SHIP_CATEGORY_ID || categoryID === STRUCTURE_CATEGORY_ID) {
      return { realValues: true };
    }
    if (categoryID === MODULE_CATEGORY_ID || categoryID === STRUCTURE_MODULE_CATEGORY_ID) {
      return {
        realValues: true,
        integerKeys: [
          [ATTRIBUTE_IS_ONLINE, 1],
          [ATTRIBUTE_CHARGE, 0],
          [ATTRIBUTE_SHIELD_CHARGE_HELPER, 0],
        ]
          .filter(([attributeID, value]) => attributes[attributeID] === value)
          .map(([attributeID]) => attributeID),
      };
    }
    return {};
  }
  _getDroneBayItemAttributeOverrides(item, session = null) {
    // Tooltip bonuses apply to any owned drone item, not just bay rows: a
    // launched drone (flagID 0, launcherID = controlling ship) must keep its
    // skill/ship/module bonuses or ItemGetInfo answers with base type dogma.
    const {
      resolveDroneTooltipAttributes,
    } = require(path.join(__dirname, "../drone/droneDogma"));
    return resolveDroneTooltipAttributes(item, session);
  }
  _buildInventoryItemAttributes(item, session = null, options = {}) {
    const loadedChargeItem = this._resolveLoadedChargeItem(item, session, options);
    const typeAttributes = buildEffectiveItemAttributeMap(item, loadedChargeItem);
    const attributes = Object.fromEntries(
      Object.entries(typeAttributes || {})
        .map(([attributeID, value]) => [Number(attributeID), Number(value)])
        .filter(
          ([attributeID, value]) =>
            Number.isInteger(attributeID) && Number.isFinite(value),
        )
        .map(([attributeID, value]) => [
          attributeID,
          marshalDogmaAttributeValue(attributeID, value),
        ]),
    );
    // Inventory metadata and runtime structure state are authoritative over
    // base type dogma for these per-instance fields. In particular, Upwell
    // full-power hitpoint multipliers are already resolved onto the canonical
    // structure item before it reaches this builder.
    for (const [attributeID, value] of [
      [ATTRIBUTE_MASS, item && item.mass],
      [ATTRIBUTE_CAPACITY, item && item.capacity],
      [ATTRIBUTE_VOLUME, item && item.volume],
      [ATTRIBUTE_RADIUS, item && item.radius],
      [ATTRIBUTE_SHIELD_CAPACITY, item && item.shieldCapacity],
      [ATTRIBUTE_ARMOR_HP, item && item.armorHP],
      [ATTRIBUTE_STRUCTURE_HP, item && (item.structureHP ?? item.hullHP)],
    ]) {
      const numericValue = Number(value);
      if (Number.isFinite(numericValue)) {
        attributes[attributeID] = marshalDogmaAttributeValue(
          attributeID,
          numericValue,
        );
      }
    }
    if (
      item &&
      item.dogmaAttributeOverrides &&
      typeof item.dogmaAttributeOverrides === "object"
    ) {
      for (const [attributeID, value] of Object.entries(item.dogmaAttributeOverrides)) {
        const numericAttributeID = Number(attributeID);
        const numericValue = Number(value);
        if (
          !Number.isInteger(numericAttributeID) ||
          !Number.isFinite(numericValue)
        ) {
          continue;
        }
        attributes[numericAttributeID] = marshalDogmaAttributeValue(
          numericAttributeID,
          numericValue,
        );
      }
    }
    const droneBayAttributeOverrides =
      this._getDroneBayItemAttributeOverrides(item, session);
    if (
      droneBayAttributeOverrides &&
      typeof droneBayAttributeOverrides === "object"
    ) {
      for (const [attributeID, value] of Object.entries(droneBayAttributeOverrides)) {
        const numericAttributeID = Number(attributeID);
        const numericValue = Number(value);
        if (
          !Number.isInteger(numericAttributeID) ||
          !Number.isFinite(numericValue)
        ) {
          continue;
        }
        attributes[numericAttributeID] = marshalDogmaAttributeValue(
          numericAttributeID,
          numericValue,
        );
      }
    }
    const structureServiceAttributes =
      this._getStructureServiceModuleAttributeOverrides(item);
    if (structureServiceAttributes) {
      for (const [attributeID, value] of Object.entries(structureServiceAttributes)) {
        const numericAttributeID = Number(attributeID);
        const numericValue = Number(value);
        if (
          !Number.isInteger(numericAttributeID) ||
          !Number.isFinite(numericValue)
        ) {
          continue;
        }
        attributes[numericAttributeID] = marshalDogmaAttributeValue(
          numericAttributeID,
          numericValue,
        );
      }
    }
    const resourceAttributeOverrides =
      this._getFittedModuleResourceAttributeOverrides(item, session, options);
    if (resourceAttributeOverrides) {
      for (const [attributeID, value] of Object.entries(resourceAttributeOverrides)) {
        const numericAttributeID = Number(attributeID);
        const numericValue = Number(value);
        if (
          Number.isInteger(numericAttributeID) &&
          Number.isFinite(numericValue)
        ) {
          attributes[numericAttributeID] = marshalDogmaAttributeValue(
            numericAttributeID,
            numericValue,
          );
        }
      }
    }
    const weaponDogmaAttributes = this._getWeaponDogmaAttributeOverrides(
      item,
      session,
      options,
    );
    const overrideAttributes =
      Number(item && item.categoryID) === 8
        ? weaponDogmaAttributes && weaponDogmaAttributes.chargeAttributes
        : weaponDogmaAttributes && weaponDogmaAttributes.moduleAttributes;
    if (overrideAttributes && typeof overrideAttributes === "object") {
      for (const [attributeID, value] of Object.entries(overrideAttributes)) {
        const numericAttributeID = Number(attributeID);
        const numericValue = Number(value);
        if (
          !Number.isInteger(numericAttributeID) ||
          !Number.isFinite(numericValue)
        ) {
          continue;
        }
        attributes[numericAttributeID] = marshalDogmaAttributeValue(
          numericAttributeID,
          numericValue,
        );
      }
    }
    if (Number(item && item.categoryID) === 23 && Number(item.groupID) === 365) {
      const resistance = require("../starbase/starbaseResistanceRuntime");
      const baseShield = Object.fromEntries(Object.values(resistance.SHIELD_ATTRIBUTES).map((id) =>
        [id, this._resolveDogmaAttributeNumber(attributes, id, 1)]));
      for (const [id, value] of Object.entries(resistance.getTowerShieldAttributes(item, baseShield) || {})) {
        attributes[id] = marshalDogmaAttributeValue(Number(id), value);
      }
    }
    const quantityAttributeID = getAttributeIDByNames("quantity");
    if (quantityAttributeID && options.includeQuantityAttribute !== false) {
      attributes[quantityAttributeID] = Number(
        item && (item.stacksize ?? item.quantity ?? 0),
      ) || 0;
    }
    const isOnlineAttributeID = getAttributeIDByNames("isOnline");
    if (isOnlineAttributeID && item && item.moduleState) {
      attributes[isOnlineAttributeID] = isModuleOnline(item) ? 1 : 0;
    }
    if (item && item.moduleState) {
      if (Number.isFinite(Number(item.moduleState.damage))) {
        const structureHP = this._getItemStructureHitpoints(item.typeID);
        attributes[ATTRIBUTE_ITEM_DAMAGE] = structureHP > 0
          ? Number((structureHP * clampRatio(item.moduleState.damage, 0)).toFixed(6))
          : Number(item.moduleState.damage);
      }
      if (Number.isFinite(Number(item.moduleState.armorDamage))) {
        attributes[ATTRIBUTE_ARMOR_DAMAGE] = Number(item.moduleState.armorDamage);
      }
      if (Number.isFinite(Number(item.moduleState.shieldCharge))) {
        attributes[ATTRIBUTE_SHIELD_CHARGE_HELPER] = Number(item.moduleState.shieldCharge);
      }
      // A module's charge beside its shieldCharge: the two are of its instance
      // row, as its damage is. Tranquility lists 18: 0 wherever it lists 264: 0
      // for a module (643 of the 671 its client's godma printed as it loaded
      // them). A ship's modules alone: the structure modules it printed list
      // neither.
      if (
        Number(item.categoryID) === MODULE_CATEGORY_ID &&
        ATTRIBUTE_SHIELD_CHARGE_HELPER in attributes &&
        !(ATTRIBUTE_CHARGE in attributes) &&
        Number.isFinite(Number(item.moduleState.charge))
      ) {
        attributes[ATTRIBUTE_CHARGE] = Number(item.moduleState.charge);
      }
    }
    if (item && item.conditionState && typeof item.conditionState === "object") {
      const conditionState = normalizeShipConditionState(item.conditionState);
      const shieldCapacity = Number(
        item.shieldCapacity ??
          this._resolveDogmaAttributeNumber(attributes, ATTRIBUTE_SHIELD_CAPACITY, NaN),
      );
      if (
        Number.isFinite(shieldCapacity) &&
        shieldCapacity >= 0 &&
        Number.isFinite(conditionState.shieldCharge)
      ) {
        attributes[ATTRIBUTE_SHIELD_CHARGE_HELPER] = Number(
          (shieldCapacity * conditionState.shieldCharge).toFixed(6),
        );
      }
      const armorHP = Number(
        item.armorHP ??
          this._resolveDogmaAttributeNumber(attributes, ATTRIBUTE_ARMOR_HP, NaN),
      );
      if (
        Number.isFinite(armorHP) &&
        armorHP >= 0 &&
        Number.isFinite(conditionState.armorDamage)
      ) {
        attributes[ATTRIBUTE_ARMOR_DAMAGE] = Number(
          (armorHP * conditionState.armorDamage).toFixed(6),
        );
      }
      const structureHP = Number(
        item.structureHP ??
          item.hullHP ??
          this._resolveDogmaAttributeNumber(attributes, ATTRIBUTE_STRUCTURE_HP, NaN),
      );
      if (
        Number.isFinite(structureHP) &&
        structureHP >= 0 &&
        Number.isFinite(conditionState.damage)
      ) {
        attributes[ATTRIBUTE_ITEM_DAMAGE] = Number(
          (structureHP * conditionState.damage).toFixed(6),
        );
      }
      // A structure's capacitor charge, as the three above. Tranquility's attributes
      // of a structure taken control of have 18: 100000.0 beside 482: 100000.0
      // ("Citadel Take Control" recording). Only structures: nothing recorded says
      // what the other items that come this way carry.
      const capacitorCapacity = Number(
        this._resolveDogmaAttributeNumber(attributes, ATTRIBUTE_CAPACITOR_CAPACITY, NaN),
      );
      if (
        Number(item.categoryID) === STRUCTURE_CATEGORY_ID &&
        Number.isFinite(capacitorCapacity) &&
        capacitorCapacity > 0 &&
        Number.isFinite(conditionState.charge)
      ) {
        attributes[ATTRIBUTE_CHARGE] = Number(
          (capacitorCapacity * conditionState.charge).toFixed(6),
        );
      }
    }
    const propulsionRuntimeAttributes = this._getPropulsionModuleAttributeOverrides(
      item,
      session,
    );
    if (propulsionRuntimeAttributes) {
      attributes[MODULE_ATTRIBUTE_CAPACITOR_NEED] = Number(
        propulsionRuntimeAttributes.capNeed,
      );
      attributes[MODULE_ATTRIBUTE_SPEED_FACTOR] = Number(
        propulsionRuntimeAttributes.speedFactor,
      );
      attributes[MODULE_ATTRIBUTE_DURATION] = marshalDogmaAttributeValue(
        MODULE_ATTRIBUTE_DURATION,
        Number(propulsionRuntimeAttributes.durationMs),
      );
    } else {
      const genericRuntimeAttributes = this._getGenericModuleAttributeOverrides(
        item,
        session,
        options,
      );
      if (genericRuntimeAttributes) {
        const genericAttributeOverrides =
          genericRuntimeAttributes.attributeOverrides &&
          typeof genericRuntimeAttributes.attributeOverrides === "object"
            ? genericRuntimeAttributes.attributeOverrides
            : null;
        if (genericAttributeOverrides) {
          for (const [attributeID, value] of Object.entries(genericAttributeOverrides)) {
            const numericAttributeID = Number(attributeID);
            const numericValue = Number(value);
            if (
              !Number.isInteger(numericAttributeID) ||
              !Number.isFinite(numericValue)
            ) {
              continue;
            }
            attributes[numericAttributeID] = marshalDogmaAttributeValue(
              numericAttributeID,
              numericValue,
            );
          }
        }
        attributes[MODULE_ATTRIBUTE_CAPACITOR_NEED] = Number(
          genericRuntimeAttributes.capNeed,
        );
        const durationAttributeID = Number(
          genericRuntimeAttributes.durationAttributeID,
        ) || MODULE_ATTRIBUTE_DURATION;
        attributes[durationAttributeID] = marshalDogmaAttributeValue(
          durationAttributeID,
          Number(genericRuntimeAttributes.durationMs),
        );
        if (
          durationAttributeID !== MODULE_ATTRIBUTE_DURATION &&
          MODULE_ATTRIBUTE_DURATION in attributes
        ) {
          delete attributes[MODULE_ATTRIBUTE_DURATION];
        }
        if (
          durationAttributeID !== MODULE_ATTRIBUTE_SPEED &&
          MODULE_ATTRIBUTE_SPEED in attributes &&
          Number(item && item.groupID) !== GROUP_SCAN_PROBE_LAUNCHER
        ) {
          delete attributes[MODULE_ATTRIBUTE_SPEED];
        }
      }
    }
    const reloadRuntimeAttributes = this._getModuleReloadAttributeOverrides(
      item,
      session,
    );
    if (reloadRuntimeAttributes) {
      if (
        ATTRIBUTE_RELOAD_TIME &&
        Number.isFinite(Number(reloadRuntimeAttributes.reloadTime))
      ) {
        attributes[ATTRIBUTE_RELOAD_TIME] = Number(reloadRuntimeAttributes.reloadTime);
      }
      if (
        ATTRIBUTE_NEXT_ACTIVATION_TIME &&
        typeof reloadRuntimeAttributes.nextActivationTime === "bigint"
      ) {
        attributes[ATTRIBUTE_NEXT_ACTIVATION_TIME] =
          reloadRuntimeAttributes.nextActivationTime;
      }
    }
    return attributes;
  }
  _getStructureServiceModuleAttributeOverrides(item) {
    if (!isStructureServiceModuleItem(item)) {
      return null;
    }
    const structureID = Number(item && item.locationID) || 0;
    if (structureID <= 0) {
      return null;
    }
    return buildStructureServiceModuleEffectiveAttributeMap(structureID, item);
  }
  _getPendingModuleReload(moduleID) {
    const numericModuleID = Number(moduleID) || 0;
    if (numericModuleID <= 0) {
      return null;
    }
    const reloadState = pendingModuleReloads.get(numericModuleID) || null;
    if (!reloadState) {
      return null;
    }
    const completeAtMs = Number(reloadState.completeAtMs) || 0;
    const currentTimeMs = getReloadStateCurrentTimeMs(reloadState, Date.now());
    if (completeAtMs > 0 && completeAtMs > currentTimeMs) {
      return reloadState;
    }
    pendingModuleReloads.delete(numericModuleID);
    schedulePendingModuleReloadPump();
    return null;
  }
  // A reload is a ship-level number, not a module-level one. Six effects in the SDE write
  // `reloadTime` (1795) and every one of them is a `shipID`-domain row on a hull or on a skill, so
  // none of them can be seen from the module's own attribute map:
  //
  //   6098  shipMissileReloadTimeCaldariTacticalDestroyer2  Jackdaw, Skua        -15%/level
  //   8360  shipBonusMissileReloadTimeGC2                   Laelaps              -10%/level
  //   6620  shipBonusDreadnoughtC3ReloadBonus               Phoenix, Navy Issue  -10%/level
  //         (all three are LocationRequiredSkillModifier on skill 3319, so they reach all 143
  //          published missile launchers that declare a reload)
  //   12887 angelCartelProjectileReloadingSpeed             9 Angel hulls        -75% flat
  //         (LocationGroupModifier on group 55: 167 published projectile turrets)
  //   6782  commandBurstReloadTimeBonus                     skill 3354           -10%/level
  //   8590  launcherReloadTimeBonusPassive                  4 unpublished boosters, dead by data
  //
  // This dates every reload a PLAYER asks for. Reading the module's own map meant a Machariel's
  // 800mm autocannons took the full 10,000 ms where the hull says 2,500, and a Jackdaw's manual
  // missile reload took 35,000 where the hull says 8,750.
  //
  // `runtime.js#resolveEffectiveModuleReloadTimeMs` is the twin of this function and had the same
  // defect, fixed in 09baab96. The two are deliberately NOT one function: that one dates the
  // reloads the space runtime queues by itself and resolves its map from a live space entity, and
  // this one has to work for a DOCKED session too - see the docked announcement in
  // `Handle_LoadAmmo` - where there is no entity to resolve anything from. The map lookups differ
  // by input; the number they produce does not, and both were measured agreeing on every hull in
  // the cross-tab above. If you change the arithmetic here, change it there.
  _getModuleReloadTimeMs(session, moduleItem) {
    const effectiveAttributes = moduleItem
      ? this._resolveModuleShipDogmaAttributeMap(
        session,
        moduleItem,
        this._getCharID(session),
      ) || buildEffectiveItemAttributeMap(moduleItem)
      : null;
    const reloadTimeMs = Number(
      effectiveAttributes && effectiveAttributes[ATTRIBUTE_RELOAD_TIME] !== undefined
        ? effectiveAttributes[ATTRIBUTE_RELOAD_TIME]
        : getTypeAttributeValue(
            Number(moduleItem && moduleItem.typeID) || 0,
            "reloadTime",
          ),
    );
    if (!Number.isFinite(reloadTimeMs) || reloadTimeMs <= 0) {
      return 0;
    }
    return Math.max(0, Math.round(reloadTimeMs));
  }
  _getModuleReloadAttributeOverrides(item, _session = null) {
    const reloadState = this._getPendingModuleReload(item && item.itemID);
    if (!reloadState || !isPendingModuleReloadWindowOpen(reloadState)) {
      // The module is still finishing its current cycle; the reload has not
      // begun yet. Publishing nextActivationTime here would make the client's
      // godma.IsModuleReloading() report a reload for the whole cycle, and
      // shipmodulebutton.Click() silently no-ops while that is true.
      return null;
    }
    return {
      reloadTime: Number(reloadState.reloadTimeMs) || 0,
      nextActivationTime: toFileTimeFromMs(reloadState.completeAtMs, 0n),
    };
  }
  _notifyChargeBeingLoadedToModule(session, moduleIDs = [], chargeTypeID, reloadTimeMs) {
    if (!session || typeof session.sendNotification !== "function") {
      return;
    }
    const numericModuleIDs = (Array.isArray(moduleIDs) ? moduleIDs : [moduleIDs])
      .map((moduleID) => Number(moduleID) || 0)
      .filter((moduleID) => moduleID > 0);
    if (numericModuleIDs.length === 0) {
      return;
    }
    session.sendNotification("OnChargeBeingLoadedToModule", "charid", [
      {
        type: "list",
        items: numericModuleIDs,
      },
      Number(chargeTypeID) > 0 ? Number(chargeTypeID) : null,
      Math.max(0, Math.round(Number(reloadTimeMs) || 0)),
    ]);
    log.debug(
      `[DogmaIM] OnChargeBeingLoadedToModule modules=${JSON.stringify(
        numericModuleIDs,
      )} chargeTypeID=${Number(chargeTypeID) || 0} ` +
      `reloadTimeMs=${Math.max(0, Math.round(Number(reloadTimeMs) || 0))}`,
    );
  }
  _notifyModuleNextActivationTime(
    session,
    moduleID,
    nextActivationTime = 0n,
    previousActivationTime = 0n,
  ) {
    if (!ATTRIBUTE_NEXT_ACTIVATION_TIME) {
      return;
    }
    const numericModuleID = Number(moduleID) || 0;
    if (numericModuleID <= 0) {
      return;
    }
    this._notifyModuleAttributeChanges(session, [[
      "OnModuleAttributeChanges",
      this._getCharID(session),
      numericModuleID,
      ATTRIBUTE_NEXT_ACTIVATION_TIME,
      this._sessionFileTime(session),
      typeof nextActivationTime === "bigint" ? nextActivationTime : 0n,
      typeof previousActivationTime === "bigint" ? previousActivationTime : 0n,
      null,
    ]]);
    log.debug(
      `[DogmaIM] NextActivationTime moduleID=${numericModuleID} ` +
      `next=${typeof nextActivationTime === "bigint" ? nextActivationTime.toString() : String(nextActivationTime)} ` +
      `previous=${typeof previousActivationTime === "bigint" ? previousActivationTime.toString() : String(previousActivationTime)}`,
    );
  }
  _buildInventoryItemAttributeDict(item, session = null, options = {}) {
    const attributes = this._buildInventoryItemAttributes(item, session, options);
    return this._buildAttributeValueDict(
      attributes,
      this._getAttributeWireKinds(item, attributes),
    );
  }
  _resolveDogmaAttributeNumber(attributes, attributeID, fallback = 0) {
    const value = attributes && attributes[attributeID];
    const unwrapped = unwrapMarshalValue(value);
    const numeric = Number(unwrapped);
    if (Number.isFinite(numeric)) {
      return numeric;
    }
    return fallback;
  }
  _getOnlineEffectStartTime(item, session = null) {
    const itemID = Number(item && item.itemID) || 0;
    let cache = null;
    if (session && typeof session === "object") {
      cache = this._onlineEffectStartTimes.get(session) || null;
      if (!cache) {
        cache = new Map();
        this._onlineEffectStartTimes.set(session, cache);
      }
    }
    const moduleState = item && item.moduleState && typeof item.moduleState === "object"
      ? item.moduleState
      : {};
    const persistedStartMs = [
      moduleState.onlineEffectStartedAtMs,
      moduleState.onlineStartedAtMs,
      moduleState.serviceFuelOnlineAt,
      item && item.onlineEffectStartedAtMs,
      item && item.onlineStartedAtMs,
      item && item.createdAtMs,
    ].map(Number).find((value) => Number.isFinite(value) && value > 0);
    if (persistedStartMs) {
      const persistedStart = this._toFileTime(persistedStartMs);
      if (cache && itemID > 0) {
        cache.set(itemID, persistedStart);
      }
      return persistedStart;
    }
    if (cache && itemID > 0 && typeof cache.get(itemID) === "bigint") {
      return cache.get(itemID);
    }
    const startTime = session ? this._sessionFileTime(session) : this._nowFileTime();
    if (cache && itemID > 0) {
      cache.set(itemID, startTime);
    }
    return startTime;
  }
  _buildActiveEffectEntry(item, effectID, options = {}, session = null) {
    if (!item || effectID <= 0) {
      return null;
    }
    const now = session ? this._sessionFileTime(session) : this._nowFileTime();
    const timestamp = typeof options.startTime === "bigint"
      ? options.startTime
      : this._toFileTime(options.startedAt, now);
    const durationMs = Number.isFinite(Number(options.duration))
      ? Math.max(Number(options.duration), -1)
      : -1;
    const duration = marshalModuleDurationWireValue(durationMs);
    const repeat = options.repeat === undefined || options.repeat === null
      ? -1
      : Number(options.repeat);
    const ownerID = Object.prototype.hasOwnProperty.call(options, "ownerID")
      ? options.ownerID
      : Number(item.ownerID) || 0;
    return [
      effectID,
      [
        Number(item.itemID) || 0,
        ownerID,
        Number(item.locationID) || 0,
        Number(options.targetID) > 0 ? Number(options.targetID) : null,
        Number(options.otherID) > 0 ? Number(options.otherID) : null,
        [],
        effectID,
        timestamp,
        duration,
        Number.isFinite(repeat) ? repeat : -1,
      ],
    ];
  }
  _getPropulsionEffectID(effectName) {
    switch (String(effectName || "")) {
      case "moduleBonusAfterburner":
        return EFFECT_AFTERBURNER;
      case "moduleBonusMicrowarpdrive":
        return EFFECT_MICROWARPDRIVE;
      default:
        return 0;
    }
  }
  _buildInventoryItemActiveEffects(item, session = null, options = {}) {
    if (!item) {
      return this._buildEmptyDict();
    }
    const entries = [];
    const batteryControl = session && Number(item.categoryID) === 23
      ? require("../starbase/starbaseControlRuntime").getControlledBatteryContext(session, item) : null;
    if (isEffectivelyOnlineModule(item) || batteryControl) {
      const onlineEntry = this._buildActiveEffectEntry(item, EFFECT_ONLINE, {
        ownerID: options.controlledStructure === true
          ? null
          : Number(item.ownerID) || 0,
        startTime: this._getOnlineEffectStartTime(item, session),
        duration: -1,
        repeat: 1,
      }, session);
      if (onlineEntry) {
        entries.push(onlineEntry);
      }
    }
    if (session && session._space && options.controlledStructure !== true) {
      const activeEffect = batteryControl
        ? batteryControl.entity.activeModuleEffects.get(Number(item.itemID))
        : spaceRuntime.getActiveModuleEffect(session, item.itemID);
      if (activeEffect) {
        const activeEffectID =
          Number(activeEffect.effectID) > 0
            ? Number(activeEffect.effectID)
            : this._getPropulsionEffectID(activeEffect.effectName);
        const activeEntry = this._buildActiveEffectEntry(
          item,
          activeEffectID,
          {
            startedAt: activeEffect.startedAtMs,
            duration: activeEffect.durationMs,
            repeat: activeEffect.repeat,
            targetID: activeEffect.targetID,
          },
          session,
        );
        if (activeEntry) {
          entries.push(activeEntry);
        }
      }
      const overloadEffect =
        typeof spaceRuntime.getOverloadModuleEffect === "function"
          ? spaceRuntime.getOverloadModuleEffect(session, item.itemID)
          : null;
      if (overloadEffect && Number(overloadEffect.effectID) > 0) {
        const overloadEntry = this._buildActiveEffectEntry(
          item,
          Number(overloadEffect.effectID),
          {
            startedAt: overloadEffect.startedAtMs,
            duration: overloadEffect.durationMs,
            repeat: overloadEffect.repeat,
            targetID: overloadEffect.targetID,
          },
          session,
        );
        if (overloadEntry) {
          entries.push(overloadEntry);
        }
      }
    }
    return entries.length > 0
      ? {
          type: "dict",
          entries,
        }
      : this._buildEmptyDict();
  }
  _listLoadedChargeSublocationItems(charID, shipID, options = {}) {
    const numericShipID = Number(shipID) || 0;
    if (numericShipID <= 0) {
      return [];
    }
    if (
      this._isFittingContextMatch(
        options.fittingContext,
        charID,
        numericShipID,
        options,
      )
    ) {
      return [...options.fittingContext.chargeItems];
    }
    const rows = options.includeAllFittingOwners === true
      ? listContainerItems(null, numericShipID, null)
      : getLoadedChargeItems(charID, numericShipID);
    return (Array.isArray(rows) ? rows : [])
      .filter((item) => (
        item &&
        Number(item.locationID) === numericShipID &&
        isShipFittingFlag(item.flagID) &&
        Number(item.categoryID) === 8 &&
        Number(item.typeID) > 0
      ))
      .sort((left, right) => (
        (Number(left.flagID) || 0) - (Number(right.flagID) || 0) ||
        (Number(left.typeID) || 0) - (Number(right.typeID) || 0) ||
        (Number(left.itemID) || 0) - (Number(right.itemID) || 0)
      ));
  }
  _buildChargeSublocationData(charID, shipID, options = {}) {
    const numericShipID = Number(shipID) || 0;
    return this._listLoadedChargeSublocationItems(charID, numericShipID, options)
      .map((item) => ({
        flagID: Number(item.flagID) || 0,
        itemID: buildChargeTupleItemID(numericShipID, item.flagID, item.typeID),
        quantity: Number(item.stacksize ?? item.quantity ?? 0) || 0,
        sourceItem: item,
        typeID: Number(item.typeID) || 0,
      }))
      .filter((entry) => entry.flagID > 0 && entry.typeID > 0);
  }
  _buildShipInventoryInfoEntries(
    charID,
    shipID,
    ownerID,
    locationID,
    session = null,
    options = {},
  ) {
    const inventoryEntries = [];
    const listFittedRows = (chargeRows = false) => {
      if (
        this._isFittingContextMatch(
          options.fittingContext,
          charID,
          shipID,
          options,
        )
      ) {
        return chargeRows
          ? options.fittingContext.chargeItems
          : options.fittingContext.moduleItems;
      }
      if (options.includeAllFittingOwners === true) {
        return listContainerItems(null, shipID, null)
          .filter((item) => item && isShipFittingFlag(item.flagID))
          .filter((item) => (Number(item.categoryID) === 8) === chargeRows)
          .sort((left, right) => (
            (Number(left && left.flagID) || 0) - (Number(right && right.flagID) || 0) ||
            (Number(left && left.itemID) || 0) - (Number(right && right.itemID) || 0)
          ));
      }
      return chargeRows
        ? getLoadedChargeItems(charID, shipID)
        : getFittedModuleItems(charID, shipID);
    };
    if (options.includeFittedItems !== false) {
      const fittedItems = listFittedRows(false);
      if (Array.isArray(fittedItems)) {
        for (const item of fittedItems) {
          const hasDynamicStructureServiceAttributes = isStructureServiceModuleItem(item);
          const cachedEntry = hasDynamicStructureServiceAttributes
            ? null
            : this._getCachedDockedItemInfoEntry(
                session,
                item.itemID,
                item,
              );
          const entry =
            cachedEntry ||
            this._buildCommonGetInfoEntry({
              itemID: item.itemID,
              typeID: item.typeID,
              ownerID: item.ownerID || ownerID,
              locationID: this._coalesce(item.locationID, shipID),
              flagID: item.flagID,
              groupID: item.groupID,
              categoryID: item.categoryID,
              quantity: item.quantity,
              singleton: item.singleton,
              stacksize: item.stacksize,
              customInfo: options.controlledStructure === true
                ? (item.customInfo || "")
                : (item.customInfo || null),
              preserveNullCustomInfo: options.controlledStructure !== true,
              description: item.itemName || "item",
              activeEffects: this._buildInventoryItemActiveEffects(
                item,
                session,
                {
                  controlledStructure: options.controlledStructure === true,
                },
              ),
              attributes: this._buildInventoryItemAttributeDict(item, session, {
                fittingContext: options.fittingContext,
                includeQuantityAttribute:
                  options.includeFittedItemQuantityAttribute !== false,
              }),
              session,
            });
          inventoryEntries.push([
            item.itemID,
            entry,
          ]);
          if (!hasDynamicStructureServiceAttributes) {
            this._cacheDockedItemInfoEntry(session, item.itemID, item, entry);
          }
        }
      }
    }
    if (options.includeLoadedCharges === true) {
      const loadedCharges = listFittedRows(true);
      if (Array.isArray(loadedCharges)) {
        for (const item of loadedCharges) {
          const cachedEntry = this._getCachedDockedItemInfoEntry(
            session,
            item.itemID,
            item,
          );
          const entry =
            cachedEntry ||
            this._buildCommonGetInfoEntry({
              itemID: item.itemID,
              typeID: item.typeID,
              ownerID: item.ownerID || ownerID,
              locationID: this._coalesce(item.locationID, shipID),
              flagID: item.flagID,
              groupID: item.groupID,
              categoryID: item.categoryID,
              quantity: item.quantity,
              singleton: item.singleton,
              stacksize: item.stacksize,
              customInfo: item.customInfo || "",
              description: item.itemName || "charge",
              attributes: this._buildInventoryItemAttributeDict(item, session, {
                fittingContext: options.fittingContext,
              }),
              session,
            });
          inventoryEntries.push([
            item.itemID,
            entry,
          ]);
          this._cacheDockedItemInfoEntry(session, item.itemID, item, entry);
        }
      }
    }
    if (options.includeChargeSublocations !== false) {
      const tupleChargeEntries = this._buildChargeSublocationData(charID, shipID, options)
        .map((entry) => {
          const loadedCharge =
            entry.sourceItem || getLoadedChargeByFlag(charID, shipID, entry.flagID);
          if (!loadedCharge) {
            return null;
          }
          const quantity = Math.max(
            0,
            Number(loadedCharge.stacksize ?? loadedCharge.quantity ?? 0) || 0,
          );
          const tupleChargeItem = {
            ...loadedCharge,
            itemID: buildChargeTupleItemID(shipID, entry.flagID, entry.typeID),
            ownerID: loadedCharge.ownerID || ownerID,
            locationID: shipID,
            flagID: entry.flagID,
            typeID: entry.typeID,
            quantity,
            stacksize: quantity,
            singleton: 0,
            customInfo: loadedCharge.customInfo || "",
          };
          return [
            tupleChargeItem.itemID,
            this._buildCommonGetInfoEntry({
              itemID: tupleChargeItem.itemID,
              typeID: tupleChargeItem.typeID,
              ownerID: tupleChargeItem.ownerID || ownerID,
              locationID: shipID,
              flagID: tupleChargeItem.flagID,
              groupID: tupleChargeItem.groupID,
              categoryID: tupleChargeItem.categoryID,
              quantity,
              singleton: 0,
              stacksize: quantity,
              customInfo: tupleChargeItem.customInfo || "",
              description: "charge",
              // Login tooltip parity: the active-ship HUD resolves current-ship
              // charge DPS through `svc.godma`, not only clientDogmaLocation.
              // Stock `GetAllInfo.shipInfo` therefore has to seed the tuple
              // charge rows with the full attribute dict, not just quantity.
              attributes: this._buildInventoryItemAttributeDict(
                tupleChargeItem,
                session,
                {
                  fittingContext: options.fittingContext,
                  includeQuantityAttribute: true,
                },
              ),
              invItem: null,
              session,
            }),
          ];
        })
        .filter(Boolean);
      inventoryEntries.push(...tupleChargeEntries);
    }
    return inventoryEntries;
  }
  _notifyModuleAttributeChanges(session, changes = []) {
    if (
      !session ||
      typeof session.sendNotification !== "function" ||
      !Array.isArray(changes) ||
      changes.length === 0
    ) {
      return;
    }
    const normalizedChanges = changes.map((change) => normalizeModuleAttributeChange(change));
    queueDogmaEvent(session, "OnModuleAttributeChanges", [{
      type: "list",
      items: normalizedChanges,
    }]);
    log.debug(
      `[DogmaIM] OnModuleAttributeChanges count=${normalizedChanges.length} ` +
      `changes=${JSON.stringify(
        normalizedChanges.map((change) => summarizeModuleAttributeChangeLog(change)),
      )}`,
    );
  }
  _notifyShipFittingResourceAttributeChanges(
    session,
    shipID,
    previousSnapshot,
    nextSnapshot,
  ) {
    if (!previousSnapshot || !nextSnapshot) {
      return;
    }
    const numericShipID = Number(shipID) || this._getShipID(session);
    const charID = this._getCharID(session);
    if (numericShipID <= 0 || charID <= 0) {
      return;
    }

    const timestamp = this._sessionFileTime(session);
    const changes = listShipFittingAttributeChanges(
      previousSnapshot,
      nextSnapshot,
    ).map((change) => [
      "OnModuleAttributeChanges",
      charID,
      numericShipID,
      Number(change.attributeID) || 0,
      timestamp,
      Number(change.nextValue) || 0,
      Number(change.previousValue) || 0,
      null,
    ]);
    this._notifyModuleAttributeChanges(session, changes);
  }
  _refreshDockedFittingState(session, changes = [], options = {}) {
    if (
      !session ||
      !isDockedSession(session) ||
      !Array.isArray(changes) ||
      changes.length === 0
    ) {
      return;
    }
    const activeShipID = Number(
      session.activeShipID || session.shipID || session.shipid || 0,
    ) || 0;
    if (activeShipID <= 0) {
      return;
    }
    const touchesFittingState = changes.some((change) => {
      if (!change || !change.item) {
        return false;
      }
      const previousState = change.previousData || change.previousState || {};
      const previousLocationID = Number(previousState.locationID) || 0;
      const previousFlagID = Number(previousState.flagID) || 0;
      const nextLocationID = Number(change.item.locationID) || 0;
      const nextFlagID = Number(change.item.flagID) || 0;
      if (
        previousLocationID !== activeShipID &&
        nextLocationID !== activeShipID
      ) {
        return false;
      }
      return (
        isShipFittingFlag(previousFlagID) ||
        isShipFittingFlag(nextFlagID)
      );
    });
    if (!touchesFittingState) {
      return;
    }
    syncShipFittingStateForSession(session, activeShipID, {
      includeOfflineModules: true,
      includeCharges: true,
      // Deliberately module rows only, overriding the docked default in
      // syncFittedModulesForSession. The charge rows an operation actually
      // touched are already emitted by _syncInventoryChanges; re-listing the
      // slots that still hold ammo would only repeat unchanged rows, and a
      // list of survivors can never express "this slot is now empty".
      emitChargeInventoryRows: false,
      ...this._getFittingContextSnapshotOptions(
        options.fittingContext,
        this._getCharID(session),
        activeShipID,
      ),
    });
  }
  _captureChargeStateSnapshot(charID, shipID, flagID) {
    const chargeItem = getLoadedChargeByFlag(charID, shipID, flagID);
    if (!chargeItem) {
      return {
        typeID: 0,
        quantity: 0,
      };
    }
    return {
      typeID: Number(chargeItem.typeID) || 0,
      quantity: Math.max(
        0,
        Number(chargeItem.stacksize ?? chargeItem.quantity ?? 0) || 0,
      ),
    };
  }
  _captureChargeItemSnapshot(charID, shipID, flagID) {
    const chargeItem = getLoadedChargeByFlag(charID, shipID, flagID);
    return chargeItem ? { ...chargeItem } : null;
  }
  _buildChargeTransitionPrimeItem(
    charID,
    shipID,
    flagID,
    chargeState = null,
    chargeItem = null,
  ) {
    const typeID =
      Number(chargeState && chargeState.typeID) ||
      Number(chargeItem && chargeItem.typeID) ||
      0;
    if (typeID <= 0) {
      return null;
    }
    return buildChargeSublocationItem({
      shipID,
      flagID,
      typeID,
      quantity: 0,
      ownerID: charID,
      groupID: chargeItem && chargeItem.groupID,
      categoryID: chargeItem && chargeItem.categoryID,
    });
  }
  _primeChargeTupleForQuantityTransition(
    session,
    charID,
    shipID,
    flagID,
    chargeState = null,
    chargeItem = null,
    options = {},
  ) {
    if (options.primeNewChargeTuple === false) {
      return false;
    }
    const primeItem = this._buildChargeTransitionPrimeItem(
      charID,
      shipID,
      flagID,
      chargeState,
      chargeItem,
    );
    if (!primeItem) {
      return false;
    }
    const weaponAttributeItem =
      chargeItem &&
      Number(chargeItem.typeID) === Number(primeItem.typeID)
        ? {
            ...chargeItem,
            ...primeItem,
            customInfo: chargeItem.customInfo ?? primeItem.customInfo,
          }
        : primeItem;
    const weaponDogmaAttributes = this._getWeaponDogmaAttributeOverrides(
      weaponAttributeItem,
      session,
      options,
    );
    syncChargeGodmaPrimeForSession(session, shipID, primeItem, {
      description: "charge",
      now: options.when != null ? options.when : this._sessionFileTime(session),
      attributeOverrides:
        weaponDogmaAttributes && weaponDogmaAttributes.chargeAttributes,
    });
    return true;
  }
  _notifyWeaponModuleAttributeTransition(
    session,
    moduleItem,
    previousChargeItem = null,
    nextChargeItem = null,
  ) {
    if (!session || typeof session.sendNotification !== "function" || !moduleItem) {
      return;
    }
    const numericModuleID = Number(moduleItem.itemID) || 0;
    const numericCharID = Number(moduleItem.ownerID) || this._getCharID(session);
    if (numericModuleID <= 0 || numericCharID <= 0) {
      return;
    }
    const previousAttributes =
      this._buildWeaponModuleAttributeMap(
        moduleItem,
        previousChargeItem,
        session,
      ) || {};
    const nextAttributes =
      this._buildWeaponModuleAttributeMap(
        moduleItem,
        nextChargeItem,
        session,
      ) || {};
    const changedAttributeIDs = new Set([
      ...Object.keys(previousAttributes),
      ...Object.keys(nextAttributes),
    ]);
    const when = this._sessionFileTime(session);
    const changes = [];
    for (const rawAttributeID of changedAttributeIDs) {
      const attributeID = Number(rawAttributeID);
      if (!Number.isInteger(attributeID) || attributeID <= 0) {
        continue;
      }
      const previousValue = Object.prototype.hasOwnProperty.call(
        previousAttributes,
        attributeID,
      )
        ? Number(previousAttributes[attributeID])
        : 0;
      const nextValue = Object.prototype.hasOwnProperty.call(
        nextAttributes,
        attributeID,
      )
        ? Number(nextAttributes[attributeID])
        : 0;
      if (
        !Number.isFinite(previousValue) ||
        !Number.isFinite(nextValue) ||
        Math.abs(nextValue - previousValue) <= 1e-9
      ) {
        continue;
      }
      changes.push([
        "OnModuleAttributeChanges",
        numericCharID,
        numericModuleID,
        attributeID,
        when,
        nextValue,
        previousValue,
        null,
      ]);
    }
    if (changes.length > 0) {
      this._notifyModuleAttributeChanges(session, changes);
    }
  }
  _notifyChargeQuantityTransition(
    session,
    charID,
    shipID,
    flagID,
    previousState = null,
    nextState = null,
    options = {},
  ) {
    if (!ATTRIBUTE_QUANTITY) {
      return false;
    }
    const numericCharID = Number(charID) || this._getCharID(session);
    const numericShipID = Number(shipID) || this._getShipID(session);
    const numericFlagID = Number(flagID) || 0;
    if (
      !session ||
      typeof session.sendNotification !== "function" ||
      numericCharID <= 0 ||
      numericShipID <= 0 ||
      numericFlagID <= 0
    ) {
      return false;
    }
    // No docked guard. Retail pushes the charge-tuple 805 quantity delta while
    // DOCKED — golden "Topping Up Ammo from cargo direct to fitting while
    // docked.txt" line 350:
    //   OnMultiEvent([(('OnModuleAttributeChange', 2124510715L,
    //     (1054768634001L, 28, 222), 805, <when>, 80, 57, <ver>), <when>)])
    // That tuple 805 is how a docked slot learns its new ammo count.

    const previousTypeID = Number(previousState && previousState.typeID) || 0;
    const nextTypeID = Number(nextState && nextState.typeID) || 0;
    const previousQuantity = Math.max(
      0,
      Number(previousState && previousState.quantity) || 0,
    );
    const nextQuantity = Math.max(
      0,
      Number(nextState && nextState.quantity) || 0,
    );
    if (
      previousTypeID === nextTypeID &&
      previousQuantity === nextQuantity
    ) {
      return false;
    }

    const when = options.when != null
      ? options.when
      : this._sessionFileTime(session);
    const sendQuantityChange = (change) => {
      if (!change) {
        return false;
      }
      this._notifyModuleAttributeChanges(session, [change]);
      return true;
    };
    const buildQuantityChange = (typeID, nextValue, previousValue) => [
        "OnModuleAttributeChange",
        numericCharID,
        buildChargeTupleItemID(numericShipID, numericFlagID, typeID),
        ATTRIBUTE_QUANTITY,
        when,
        nextValue,
        previousValue,
        null,
      ];
    let notified = false;
    if (previousTypeID > 0) {
      notified = sendQuantityChange(buildQuantityChange(
        previousTypeID,
        previousTypeID === nextTypeID ? nextQuantity : 0,
        previousQuantity,
      )) || notified;
    }
    if (nextTypeID > 0 && nextTypeID !== previousTypeID) {
      this._primeChargeTupleForQuantityTransition(
        session,
        numericCharID,
        numericShipID,
        numericFlagID,
        nextState,
        options.nextChargeItem,
        {
          ...options,
          when,
        },
      );
      notified = sendQuantityChange(buildQuantityChange(
        nextTypeID,
        nextQuantity,
        0,
      )) || notified;
    }
    return notified;
  }
  _syncInventoryChanges(session, changes = [], options = {}) {
    if (!session || !Array.isArray(changes)) {
      return;
    }
    const normalizedChanges = this._normalizeInventoryChanges(changes);
    const clientFacingChanges = this._filterInventoryChangesForClient(
      session,
      normalizedChanges,
    );
    for (const change of clientFacingChanges) {
      if (!change) {
        continue;
      }
      if (change.item) {
        if (!this._syncShipInventoryItemsChangedForSession(session, change)) {
          syncInventoryItemForSession(
            session,
            change.item,
            change.previousData || change.previousState || {},
            {
              emitCfgLocation: false,
            },
          );
        }
      }
    }
    // Handlers that touch many slots in a single RPC (grouped UnloadAmmo over a
    // weapon bank) collect the changes here and run ONE docked fitting refresh
    // after their loop. Refreshing per module re-emitted the whole fitting once
    // per slot — a four-gun unload cost 4 x 16 module rows and 2281 ms of
    // blocking handler time.
    const deferredDockedFittingChanges = Array.isArray(
      options.deferredDockedFittingChanges,
    )
      ? options.deferredDockedFittingChanges
      : null;
    if (deferredDockedFittingChanges) {
      deferredDockedFittingChanges.push(...normalizedChanges);
      return;
    }
    this._refreshDockedFittingState(session, normalizedChanges, options);
  }
  _resolveShipInventoryChangeContext(session, change = {}) {
    if (!session || !session._space || !change || !change.item) {
      return null;
    }
    const activeShipID = Number(
      (session._space && session._space.shipID) ||
      session.activeShipID ||
      session.shipID ||
      session.shipid ||
      0,
    ) || 0;
    if (activeShipID <= 0) {
      return null;
    }
    const currentItem = change.item || {};
    const previousItem = change.previousData || change.previousState || {};
    const currentLocationID = Number(currentItem.locationID) || 0;
    const previousLocationID = Number(previousItem.locationID) || 0;
    const currentFlagID = Number(currentItem.flagID) || 0;
    const previousFlagID = Number(previousItem.flagID) || 0;
    if (
      (currentLocationID === activeShipID &&
        currentFlagID === ITEM_FLAGS.CARGO_HOLD) ||
      (previousLocationID === activeShipID &&
        previousFlagID === ITEM_FLAGS.CARGO_HOLD)
    ) {
      return ["Ship", activeShipID, "ShipCargo"];
    }
    return null;
  }
  _syncShipInventoryItemsChangedForSession(session, change = {}) {
    const context = this._resolveShipInventoryChangeContext(session, change);
    if (!context) {
      return false;
    }
    const payload = buildItemChangePayload(
      change.item,
      change.previousData || change.previousState || {},
    );
    const row = Array.isArray(payload) ? payload[0] : null;
    const changeDict = Array.isArray(payload) ? payload[1] : null;
    if (!row || !changeDict) {
      return false;
    }
    session.sendNotification("OnItemsChanged", "charid", [
      {
        type: "list",
        items: [row],
      },
      changeDict,
      context,
    ]);
    return true;
  }
  _buildRemovedInventoryNotificationState(item = {}) {
    return {
      ...item,
      locationID: REMOVED_ITEM_JUNK_LOCATION_ID,
      quantity:
        Number(item.singleton) === 1
          ? -1
          : Number(item.stacksize ?? item.quantity ?? 0) || 0,
      stacksize:
        Number(item.singleton) === 1
          ? 1
          : Number(item.stacksize ?? item.quantity ?? 0) || 0,
    };
  }
  _filterInventoryChangesForClient(session, changes = []) {
    if (!Array.isArray(changes)) {
      return [];
    }
    const activeShipID = Number(
      (session && session._space && session._space.shipID) ||
      (session && session.activeShipID) ||
      (session && session.shipID) ||
      (session && session.shipid) ||
      0,
    ) || 0;
    // Docked sessions run this filter too. Fitted charges are tuple-identified
    // in both states, so streaming real fitted-charge rows to a docked client
    // hands it itemIDs its invCache and godma were never given.
    if (!session || activeShipID <= 0) {
      return changes.filter((change) => Boolean(change));
    }
    return changes.flatMap((change) => {
      if (!change) {
        return [];
      }
      const currentItem = change.item || null;
      const previousItem = change.previousData || change.previousState || null;
      const candidateItem = currentItem || previousItem || null;
      if (!candidateItem || typeof candidateItem !== "object") {
        return [change];
      }
      if (Number(candidateItem.categoryID) !== 8) {
        return [change];
      }
      const currentLocationID = Number(currentItem && currentItem.locationID) || 0;
      const previousLocationID =
        Number(previousItem && previousItem.locationID) || 0;
      const currentFlagID = Number(currentItem && currentItem.flagID) || 0;
      const previousFlagID = Number(previousItem && previousItem.flagID) || 0;
      const currentFitted =
        currentLocationID === activeShipID &&
        isShipFittingFlag(currentFlagID);
      const previousFitted =
        previousLocationID === activeShipID &&
        isShipFittingFlag(previousFlagID);
      if (!currentFitted && !previousFitted) {
        return [change];
      }

      const movedWholeSourceStackIntoSlot =
        previousItem &&
        currentFitted &&
        !previousFitted &&
        previousLocationID > 0;
      if (movedWholeSourceStackIntoSlot) {
        // Keep dogma tuple-backed by suppressing the fitted charge row, but
        // still tell invCache that the source stack disappeared so it does not
        // keep stale ammo itemIDs around after repeated crystal swaps.
        // Any previous location, not just the ship's own cargo: a DOCKED load
        // pulls from the station hangar, and that row has to be retired too.
        return [{
          ...change,
          item: this._buildRemovedInventoryNotificationState(previousItem),
          previousData: previousItem,
        }];
      }

      // Do not stream real fitted charge rows into the live in-space godma
      // inventory model. They end up in shipItem.modules, override the
      // tuple-backed slot charge rows, and the HUD then hovers real charge
      // itemIDs that clientDogmaIM never loaded.
      return [];
    });
  }
  _normalizeInventoryChanges(changes = []) {
    if (!Array.isArray(changes)) {
      return [];
    }
    return changes
      .filter((change) => change && change.item)
      .map((change) => ({
        ...change,
        previousData: change.previousData || change.previousState || {},
      }));
  }
  // options.ownerID: the owner the charges take at the destination where it is not theirs (UnloadAmmo into the
  // corporation's hangar: the corporation). A stack of another owner is never merged into.
  _moveLoadedChargeToDestination(
    chargeItem,
    destinationLocationID,
    destinationFlagID,
    quantity = null,
    options = {},
  ) {
    const sourceItemID = Number(chargeItem && chargeItem.itemID) || 0;
    const ownerID = Number(chargeItem && chargeItem.ownerID) || 0;
    const destinationOwnerID = Number(options && options.ownerID) || ownerID;
    const changesOwner = destinationOwnerID !== ownerID;
    const moveOrTransfer = (locationID, flagID, movedQuantity) => (
      changesOwner
        ? transferItemToOwnerLocation(sourceItemID, destinationOwnerID, locationID, flagID, movedQuantity)
        : moveItemToLocation(sourceItemID, locationID, flagID, movedQuantity)
    );
    const sourceFlagID = Number(chargeItem && chargeItem.flagID) || 0;
    const sourceQuantity = Math.max(
      0,
      Number(chargeItem && (chargeItem.stacksize ?? chargeItem.quantity ?? 0)) || 0,
    );
    const numericDestinationLocationID = Number(destinationLocationID) || 0;
    const numericDestinationFlagID = Number(destinationFlagID) || 0;
    const requestedQuantity =
      quantity === null || quantity === undefined
        ? sourceQuantity
        : Math.max(1, Math.min(sourceQuantity, Number(quantity) || 0));
    if (
      sourceItemID <= 0 ||
      ownerID <= 0 ||
      requestedQuantity <= 0 ||
      numericDestinationLocationID <= 0
    ) {
      return {
        success: false,
        errorMsg: "ITEM_NOT_FOUND",
      };
    }
    const sourceIsLoadedCharge =
      Number(chargeItem.categoryID) === 8 &&
      isShipFittingFlag(sourceFlagID) &&
      !isShipFittingFlag(numericDestinationFlagID);
    // A worn crystal is an individual item. Merging it into reserve stock or
    // reminting it on unload would discard its durable damage.
    const wornCrystal = Number(getTypeAttributeValue(chargeItem.typeID, "crystalsGetDamaged")) > 0 &&
      Number(chargeItem.moduleState?.damage) > 0;
    if (!sourceIsLoadedCharge || wornCrystal) {
      return moveOrTransfer(
        numericDestinationLocationID,
        numericDestinationFlagID,
        requestedQuantity,
      );
    }
    const matchingDestinationCandidates = changesOwner ? [] : listContainerItems(
      ownerID,
      numericDestinationLocationID,
      numericDestinationFlagID,
    )
      .filter(
        (item) =>
          item &&
          Number(item.itemID) !== sourceItemID &&
          isStackableInventoryItem(item) &&
          Number(item.typeID) === Number(chargeItem.typeID),
      )
      .sort((left, right) => Number(left.itemID) - Number(right.itemID));
    const preferredOriginStackID = Number(chargeItem && chargeItem.stackOriginID) || 0;
    const matchingDestinationStack =
      (preferredOriginStackID > 0
        ? matchingDestinationCandidates.find(
          (item) =>
            item &&
            Number(item.itemID) === preferredOriginStackID &&
            isStackableInventoryItem(item) &&
            Number(item.typeID) === Number(chargeItem.typeID),
        )
        : null) ||
      matchingDestinationCandidates[0] ||
      null;
    if (matchingDestinationStack) {
      return mergeItemStacks(
        sourceItemID,
        matchingDestinationStack.itemID,
        requestedQuantity,
      );
    }
    if (requestedQuantity < sourceQuantity) {
      return moveOrTransfer(
        numericDestinationLocationID,
        numericDestinationFlagID,
        requestedQuantity,
      );
    }
    const grantResult = grantItemToOwnerLocation(
      destinationOwnerID,
      numericDestinationLocationID,
      numericDestinationFlagID,
      Number(chargeItem.typeID) || 0,
      requestedQuantity,
      {
        itemName: chargeItem.itemName || "",
        customInfo: chargeItem.customInfo || "",
      },
    );
    if (!grantResult.success) {
      return grantResult;
    }
    const removeResult = removeInventoryItem(sourceItemID, {
      removeContents: false,
    });
    if (!removeResult.success) {
      return removeResult;
    }
    return {
      success: true,
      data: {
        quantity: requestedQuantity,
        changes: [
          ...this._normalizeInventoryChanges(grantResult.data && grantResult.data.changes),
          ...this._normalizeInventoryChanges(removeResult.data && removeResult.data.changes),
        ],
      },
    };
  }
  _isNewbieShipItem(item) {
    return isNewbieShipItem(item);
  }
  _resolveNewbieShipTypeID(session) {
    return resolveNewbieShipTypeID(
      session,
      this._getCharacterRecord(session) || {},
    );
  }
  _repairShipAndFittedItems(session, shipItem) {
    repairShipAndFittedItemsForSession(session, shipItem);
  }
  _buildEmptyDict() {
    return { type: "dict", entries: [] };
  }
  _buildEmptyList() {
    return { type: "list", items: [] };
  }
  _compareFittingRows(left, right) {
    const flagDiff =
      (Number(left && left.flagID) || 0) - (Number(right && right.flagID) || 0);
    if (flagDiff !== 0) {
      return flagDiff;
    }
    return (Number(left && left.itemID) || 0) - (Number(right && right.itemID) || 0);
  }
  _buildFittingHydrationContext(charID, shipID, shipItem = null, options = {}) {
    const numericShipID =
      Number(shipID) || Number(shipItem && shipItem.itemID) || 0;
    if (numericShipID <= 0) {
      return null;
    }

    const includeAllFittingOwners = options.includeAllFittingOwners === true;
    const numericCharID = Number(charID) || 0;
    const ownerID = includeAllFittingOwners
      ? null
      : numericCharID > 0
        ? numericCharID
        : null;
    const fittedItems = listContainerItems(ownerID, numericShipID, null)
      .filter((item) => (
        item &&
        Number(item.locationID) === numericShipID &&
        isShipFittingFlag(item.flagID)
      ))
      .sort((left, right) => this._compareFittingRows(left, right));
    const moduleItems = fittedItems.filter((item) => isFittedModuleItem(item));
    const chargeItems = fittedItems.filter((item) => isFittedChargeItem(item));
    const moduleByFlag = new Map();
    for (const item of moduleItems) {
      const flagID = Number(item && item.flagID) || 0;
      if (flagID > 0 && !moduleByFlag.has(flagID)) {
        moduleByFlag.set(flagID, item);
      }
    }
    const chargeByFlag = new Map();
    for (const item of chargeItems) {
      const flagID = Number(item && item.flagID) || 0;
      if (flagID > 0 && !chargeByFlag.has(flagID)) {
        chargeByFlag.set(flagID, item);
      }
    }
    const hiddenModifierItems = listHiddenModifierItems(
      ownerID,
      numericShipID,
      shipItem,
    );

    return {
      charID: numericCharID,
      shipID: numericShipID,
      includeAllFittingOwners,
      fittedItems,
      moduleItems,
      chargeItems,
      moduleByFlag,
      chargeByFlag,
      hiddenModifierItems,
    };
  }
  _isFittingContextMatch(context, charID, shipID, options = {}) {
    if (!context) {
      return false;
    }
    const numericShipID = Number(shipID) || 0;
    if (numericShipID <= 0 || Number(context.shipID) !== numericShipID) {
      return false;
    }
    if (options.includeAllFittingOwners === true || context.includeAllFittingOwners === true) {
      return true;
    }
    const numericCharID = Number(charID) || 0;
    return numericCharID <= 0 || Number(context.charID) === numericCharID;
  }
  _getFittingContextSnapshotOptions(context, charID, shipID, options = {}) {
    if (!this._isFittingContextMatch(context, charID, shipID, options)) {
      return {};
    }
    return {
      fittedItems: context.fittedItems,
      hiddenModifierItems: context.hiddenModifierItems,
    };
  }
  _getFittingContextModuleByFlag(context, charID, shipID, flagID, options = {}) {
    if (!this._isFittingContextMatch(context, charID, shipID, options)) {
      return null;
    }
    return context.moduleByFlag.get(Number(flagID) || 0) || null;
  }
  _getFittingContextChargeByFlag(context, charID, shipID, flagID, options = {}) {
    if (!this._isFittingContextMatch(context, charID, shipID, options)) {
      return null;
    }
    return context.chargeByFlag.get(Number(flagID) || 0) || null;
  }
  _buildLoadedChargeTupleQuantityChanges(session, charID, shipID, options = {}) {
    if (!ATTRIBUTE_QUANTITY) {
      return [];
    }
    const numericCharID = Number(charID) || this._getCharID(session);
    const numericShipID = Number(shipID) || this._getShipID(session);
    if (numericCharID <= 0 || numericShipID <= 0) {
      return [];
    }

    const when = this._sessionFileTime(session);
    return this._listLoadedChargeSublocationItems(numericCharID, numericShipID, options)
      .map((item) => {
        const quantity = Math.max(
          0,
          Number(item.stacksize ?? item.quantity ?? 0) || 0,
        );
        return [
          "OnModuleAttributeChange",
          numericCharID,
          buildChargeTupleItemID(numericShipID, item.flagID, item.typeID),
          ATTRIBUTE_QUANTITY,
          when,
          quantity,
          quantity,
          null,
        ];
      });
  }
  _flushPostGetAllInfoChargeQuantityRefresh(session) {
    if (!session || !session._space) {
      return 0;
    }
    const changes = Array.isArray(
      session._space.pendingDogmaGetAllInfoChargeQuantityRefresh,
    )
      ? session._space.pendingDogmaGetAllInfoChargeQuantityRefresh
      : [];
    delete session._space.pendingDogmaGetAllInfoChargeQuantityRefresh;
    if (changes.length <= 0) {
      return 0;
    }
    this._notifyModuleAttributeChanges(session, changes);
    return changes.length;
  }
  _buildTargetingAttemptFailedUserErrorValues(data = null) {
    const errorData = data && typeof data === "object" ? data : {};
    const targetTypeID = Number(
      errorData.targetTypeID ??
        errorData.targetType ??
        errorData.typeID ??
        errorData.target,
    ) || 0;
    return {
      target: Math.max(0, Math.trunc(targetTypeID)),
    };
  }
  _buildTargetLockOutOfRangeUserErrorValues(data = null) {
    const errorData = data && typeof data === "object" ? data : {};
    const rangeDecision =
      errorData.rangeDecision && typeof errorData.rangeDecision === "object"
        ? errorData.rangeDecision
        : {};
    const authoredDesiredRange = Number(rangeDecision.desiredRange);
    const authoredActualDistance = Number(rangeDecision.actualDistance);
    const targetName = this._buildUserErrorTypeValue(errorData.targetTypeID);

    return {
      desiredRange: Number.isFinite(authoredDesiredRange)
        ? Math.max(0, authoredDesiredRange)
        : 0,
      targetName: targetName || "that target",
      actualDistance: Number.isFinite(authoredActualDistance)
        ? Math.max(0, authoredActualDistance)
        : 0,
    };
  }
  _throwTargetingUserError(errorMsg = "", data = null) {
    const errorData = data && typeof data === "object" ? data : {};
    switch (String(errorMsg || "").trim()) {
      case "NOT_IN_SPACE":
      case "SHIP_NOT_FOUND":
        throwWrappedUserError("DeniedShipChanged");
        break;
      case "TARGET_SELF":
        throwWrappedUserError("DeniedTargetSelf");
        break;
      case "SOURCE_WARPING":
        throwWrappedUserError("DeniedTargetSelfWarping");
        break;
      case "TARGET_WARPING":
        throwWrappedUserError("DeniedTargetOtherWarping", {
          targetName: this._buildUserErrorTypeValue(errorData.targetTypeID) || "that target",
        });
        break;
      case "TARGET_OUT_OF_RANGE":
        throwWrappedUserError(
          "TargetNotWithinRangeGeneric",
          this._buildTargetLockOutOfRangeUserErrorValues(errorData),
        );
        break;
      case "TARGET_NOT_FOUND":
        throwWrappedUserError("TargetingAttemptCancelled");
        break;
      case "TARGET_LOCK_LIMIT_REACHED":
        throwWrappedUserError("TargetingSystemsAlreadyFullyUtilized", {
          limit: Math.max(
            0,
            Number(errorData.limit ?? errorData.effectiveMaxLockedTargets) || 0,
          ),
        });
        break;
      case "TARGET_JAMMED":
        this._throwCustomNotifyUserError(
          "You cannot lock that target while jammed except against the ships currently jamming you.",
        );
        break;
      case "TARGET_INVULNERABLE":
        this._throwCustomNotifyUserError(
          "You cannot lock that target while it is still invulnerable after undocking.",
        );
        break;
      default:
        throwWrappedUserError(
          "DeniedTargetingAttemptFailed",
          this._buildTargetingAttemptFailedUserErrorValues(errorData),
        );
        break;
    }
  }
  _buildUserErrorTypeValue(typeID) {
    const numericTypeID = Number(typeID) || 0;
    return numericTypeID > 0 ? [USER_ERROR_TYPE_ID, numericTypeID] : numericTypeID;
  }
  _resolveModuleDisplayName(moduleItem, fallback = "module") {
    const typeRecord = resolveItemByTypeID(Number(moduleItem && moduleItem.typeID) || 0);
    const rawName =
      (moduleItem && moduleItem.itemName) ||
      (typeRecord && (typeRecord.name || typeRecord.typeName)) ||
      fallback;
    const normalizedName = String(rawName || fallback).trim();
    return normalizedName || fallback;
  }
  _resolveEntityDisplayName(entity, fallback = "That target") {
    const typeRecord = resolveItemByTypeID(Number(entity && entity.typeID) || 0);
    const rawName =
      (entity && (entity.itemName || entity.name)) ||
      (typeRecord && (typeRecord.name || typeRecord.typeName)) ||
      fallback;
    const normalizedName = String(rawName || fallback).trim();
    return normalizedName || fallback;
  }
  _resolveModuleActivationRangeMeters(session, moduleItem) {
    if (!moduleItem) {
      return 0;
    }
    const loadedChargeItem = this._resolveLoadedChargeItem(moduleItem, session);
    const weaponAttributes =
      this._buildWeaponModuleAttributeMap(moduleItem, loadedChargeItem, session);
    const moduleAttributes = typeHasEffectName(
      Number(moduleItem && moduleItem.typeID) || 0,
      ANALYZER_EFFECT_NAME,
    )
      ? this._resolveAnalyzerLiveModuleAttributes(session, moduleItem)
      : weaponAttributes ||
        buildEffectiveItemAttributeMap(moduleItem, loadedChargeItem);
    const maxRangeMeters = Math.max(
      0,
      Number(moduleAttributes && moduleAttributes[ATTRIBUTE_MAX_RANGE]) || 0,
    );
    const falloffAttributeID = FALLOFF_EFFECTIVENESS_MODULE_GROUPS.has(
      Number(moduleItem && moduleItem.groupID) || 0,
    )
      ? ATTRIBUTE_FALLOFF_EFFECTIVENESS
      : ATTRIBUTE_FALLOFF;
    const falloffMeters = Math.max(
      0,
      Number(moduleAttributes && moduleAttributes[falloffAttributeID]) || 0,
    );
    return Math.max(0, Math.round(maxRangeMeters + falloffMeters));
  }
  // A module's attributes with its host ship's dogma applied - hull bonuses, rigs and subsystems,
  // and the pilot's skills. Anything this service dispatches itself, instead of handing to a
  // `space/modules/*Runtime.js`, skips `buildLiveModuleAttributeMap` and so cannot see any of it,
  // because every one of those bonuses is a `shipID`-domain row on the hull or on a skill and none
  // of them are visible from the module's own attribute map.
  //
  // Two families read this. Both were once bugs of exactly this shape:
  //   - analyzers: the hull's `virusStrengthBonus` (effect 5460 `minigameVirusStrengthBonus`, on
  //     every exploration hull), the analyzer rigs' `virusCoherenceBonus` (effects 5433 / 5437) and
  //     the Hacking / Archaeology skill bonuses.
  //   - `_getModuleReloadTimeMs`: the six effects that write `reloadTime` (1795).
  // Keep new callers on this one helper rather than growing a third private copy of the lookup.
  //
  // Returns null only when there is no character or no host location to build against, in which
  // case the caller falls back to the module's own type attributes.
  _resolveModuleShipDogmaAttributeMap(session, moduleItem, characterID, options = {}) {
    const shipID = Number(moduleItem && moduleItem.locationID) || 0;
    if (!(characterID > 0) || shipID <= 0) {
      return null;
    }
    const activeShipRecord = this._getActiveShipRecord(session);
    const shipItem =
      findCharacterShip(characterID, shipID) ||
      (
        activeShipRecord && Number(activeShipRecord.itemID) === shipID
          ? activeShipRecord
          : null
      ) ||
      // No ship record (an unfitted or detached analyzer): a hull-less stub still lets the pilot's
      // skill dogma reach the module, so both branches agree on everything except hull and rigs.
      { itemID: shipID, typeID: 0, ownerID: characterID, singleton: 1 };
    const fittingSnapshot = Number(shipItem.typeID) > 0
      ? getShipFittingSnapshot(characterID, shipID, {
        shipItem,
        reason: "dogma.analyzer-attrs",
      })
      : null;
    // buildLiveModuleAttributeMap resolves its skill map from the caller's, never from the
    // characterID, so an omitted map silently reads as "no skills trained".
    const skillMap =
      (fittingSnapshot && fittingSnapshot.skillMap) ||
      getCachedCharacterSkillMap(characterID);
    return buildLiveModuleAttributeMap(
      shipItem,
      moduleItem,
      null,
      skillMap,
      (fittingSnapshot && fittingSnapshot.fittedItems) || [moduleItem],
      (fittingSnapshot && fittingSnapshot.assumedActiveModuleContexts) || [],
      options,
    );
  }
  _resolveAnalyzerLiveModuleAttributes(session, moduleItem) {
    const characterID = this._getCharID(session);
    const baseAttributes = buildEffectiveItemAttributeMap(moduleItem);
    const baseRange = Number(baseAttributes[ATTRIBUTE_MAX_RANGE]);
    const fallbackRange = ANALYZER_BASE_RANGE_FALLBACKS[Number(moduleItem && moduleItem.typeID)];
    const baseAttributeOverrides =
      (!Number.isFinite(baseRange) || baseRange <= 0) && fallbackRange > 0
        ? { [ATTRIBUTE_MAX_RANGE]: fallbackRange }
        : {};
    // Repair the base before hull/skill/rig, implant and burst modifiers, so a
    // missing SDE range does not discard bonuses or floor a valid T1 range.
    const effectiveAttributes = applyActiveImplantLocationModifiersToAttributes(
      this._resolveModuleShipDogmaAttributeMap(session, moduleItem, characterID, {
        baseAttributeOverrides,
      }) || { ...baseAttributes, ...baseAttributeOverrides },
      moduleItem,
      characterID,
    );
    const scene =
      session && typeof spaceRuntime.getSceneForSession === "function"
        ? spaceRuntime.getSceneForSession(session)
        : null;
    const sourceEntity =
      scene && typeof scene.getShipEntityForSession === "function"
        ? scene.getShipEntityForSession(session)
        : null;
    if (
      sourceEntity &&
      commandBurstRuntime &&
      typeof commandBurstRuntime.collectModifierEntriesForItem === "function"
    ) {
      const nowMs =
        typeof scene.getCurrentSimTimeMs === "function"
          ? scene.getCurrentSimTimeMs()
          : normalizeNumber(
            session && session._space && session._space.simTimeMs,
            Date.now(),
          );
      applyModifierGroups(
        effectiveAttributes,
        commandBurstRuntime.collectModifierEntriesForItem(
          sourceEntity,
          moduleItem,
          nowMs,
        ),
      );
    }
    return effectiveAttributes;
  }
  _buildModuleTargetOutOfRangeNotify(context = {}) {
    const session = context.session || null;
    const moduleItem = context.moduleItem || null;
    const moduleName = this._resolveModuleDisplayName(moduleItem);
    const targetID = Number(context.targetID) || 0;
    const scene =
      session && typeof spaceRuntime.getSceneForSession === "function"
        ? spaceRuntime.getSceneForSession(session)
        : null;
    const targetEntity =
      scene && targetID > 0 && typeof scene.getEntityByID === "function"
        ? scene.getEntityByID(targetID)
        : null;
    const targetName = this._resolveEntityDisplayName(targetEntity, "That target");
    const maxRangeMeters = this._resolveModuleActivationRangeMeters(session, moduleItem);

    if (maxRangeMeters > 0) {
      return (
        `${targetName} is too far away to use your ${moduleName} on. ` +
        `It needs to be closer than ${INTEGER_NOTIFY_FORMATTER.format(maxRangeMeters)} meters.`
      );
    }

    return `${targetName} is too far away to use your ${moduleName} on.`;
  }
  _throwCustomNotifyUserError(message) {
    throwWrappedUserError("CustomNotify", {
      notify: String(message || "The requested action could not be completed."),
    });
  }
  _getItemStructureHitpoints(typeID) {
    const hp = Number(getTypeAttributeValue(typeID, "hp", "structureHP")) || 0;
    if (hp > 0) {
      return hp;
    }
    return this._getDogmaAttributeDefaultValue(ATTRIBUTE_HP, 0);
  }
  primeControlledStarbaseBattery(session, batteryID) {
    const control = require("../starbase/starbaseControlRuntime");
    const context = control.getControlledBatteryContext(session, batteryID);
    if (!context) control.requireStarbaseControlResult({ success: false, errorMsg: "STARBASE_CONTROL_REQUIRED" });
    const item = context.item;
    const laser = Number(item.groupID) === 430;
    const entries = [[item.itemID, this.Handle_ItemGetInfo([item.itemID], session)],
      ...this._buildShipInventoryInfoEntries(this._getCharID(session), item.itemID, item.ownerID,
        item.locationID, session, { includeAllFittingOwners: true, includeFittedItems: false,
          includeLoadedCharges: laser, includeChargeSublocations: !laser })];
    // godma.py:1274-1287 and slotsContainer.py:223-245. The HUD reads a local
    // cache: prime the actual starbase row and loaded charges before Assume returns.
    session.sendNotification?.("ProcessGodmaPrimeLocation", "clientID", [item.itemID, { type: "dict", entries }]);
    return entries;
  }
  _resolvePendingReloadSourceStacks(
    charID,
    ammoLocationID,
    sourceFlagID,
    chargeTypeID,
    sourceItemIDs = [],
  ) {
    const explicitItemIDs = new Set(normalizeReloadSourceItemIDs(sourceItemIDs));
    return listContainerItems(charID, ammoLocationID, sourceFlagID)
      .filter((item) => Number(item.typeID) === Number(chargeTypeID))
      .filter((item) => (Number(item.stacksize || item.quantity || 0) || 0) > 0)
      .filter((item) => explicitItemIDs.size === 0 || explicitItemIDs.has(Number(item.itemID) || 0))
      .sort((left, right) => (Number(left.itemID) || 0) - (Number(right.itemID) || 0));
  }
  /**
   * Reloading a weapon group shares the reserve out instead of filling launchers in
   * turn: this is the highest quantity every launcher in `moduleItems` can be brought
   * up to from `reserveQuantity` charges, capped at capacity. A launcher already
   * holding more keeps it. Only charges of `chargeTypeID` count as held, since a
   * launcher holding another type is emptied before it is loaded.
   */
  resolveGroupedReloadLevel(moduleItems, chargeTypeID, reserveQuantity, inventoryOwnerID, shipID) {
    const items = (Array.isArray(moduleItems) ? moduleItems : []).filter(Boolean);
    if (items.length === 0) {
      return { level: 0, heldQuantities: [], capacity: 0 };
    }
    const heldQuantities = items.map((moduleItem) => {
      const loaded = getLoadedChargeByFlag(inventoryOwnerID, shipID, moduleItem.flagID);
      return loaded && Number(loaded.typeID) === Number(chargeTypeID)
        ? Number(loaded.stacksize || loaded.quantity || 0) || 0
        : 0;
    });
    const capacity = Math.min(
      ...items.map((moduleItem) => getModuleChargeCapacity(moduleItem.typeID, chargeTypeID)),
    );
    const reserve = Math.max(0, Math.trunc(Number(reserveQuantity) || 0));
    const shortfallAt = (level) => heldQuantities.reduce(
      (sum, held) => sum + Math.max(0, level - held),
      0,
    );
    let level = 0;
    let ceiling = Math.max(0, capacity);
    while (level < ceiling) {
      const probe = Math.ceil((level + ceiling) / 2);
      if (shortfallAt(probe) <= reserve) {
        level = probe;
      } else {
        ceiling = probe - 1;
      }
    }
    return { level, heldQuantities, capacity };
  }
  _queuePendingModuleReload(session, moduleItem, options = {}) {
    const numericModuleID = Number(moduleItem && moduleItem.itemID) || 0;
    if (numericModuleID <= 0) {
      return {
        success: false,
        errorMsg: "MODULE_NOT_FOUND",
      };
    }
    const reloadTimeMs = Math.max(
      0,
      Math.round(
        Number(options.reloadTimeMs) || this._getModuleReloadTimeMs(session, moduleItem),
      ),
    );
    if (reloadTimeMs <= 0) {
      return {
        success: false,
        errorMsg: "NO_RELOAD_TIME",
      };
    }
    const existingReload = this._getPendingModuleReload(numericModuleID);
    if (existingReload) {
      return {
        success: true,
        data: {
          reloadState: existingReload,
          alreadyPending: true,
        },
      };
    }
    const startedAtMs = getSessionSimulationTimeMs(session, Date.now());
    // Modules that apply their effect at the start of a cycle burn the charge
    // immediately but cannot begin reloading until that cycle finishes. The
    // remaining cycle time is tracked separately from the reload itself so the
    // client is only told "reloading" for the real reload window.
    const reloadStartDelayMs = Math.max(
      0,
      Math.round(Number(options.reloadStartDelayMs) || 0),
    );
    const reloadStartAtMs = startedAtMs + reloadStartDelayMs;
    const completeAtMs = reloadStartAtMs + reloadTimeMs;
    const reloadState = {
      action: String(options.action || "load"),
      moduleID: numericModuleID,
      moduleFlagID: Number(moduleItem.flagID) || 0,
      moduleTypeID: Number(moduleItem.typeID) || 0,
      shipID: Number(options.shipID) || Number(moduleItem.locationID) || 0,
      charID: this._getCharID(session),
      inventoryOwnerID:
        Number(options.inventoryOwnerID) ||
        this._getDogmaInventoryOwnerID(
          session,
          Number(options.shipID) || Number(moduleItem.locationID) || 0,
        ),
      sourceOwnerID:
        Number(options.sourceOwnerID) ||
        this._getDogmaInventoryOwnerID(
          session,
          Number(options.ammoLocationID) || Number(moduleItem.locationID) || 0,
        ),
      chargeTypeID: Number(options.chargeTypeID) || 0,
      ammoLocationID: Number(options.ammoLocationID) || 0,
      sourceFlagID: Number(options.sourceFlagID) || ITEM_FLAGS.CARGO_HOLD,
      sourceItemIDs: normalizeReloadSourceItemIDs(options.sourceItemIDs),
      destinationLocationID: Number(options.destinationLocationID) || 0,
      destinationFlagID: Number(options.destinationFlagID) || 0,
      quantity:
        options.quantity === undefined || options.quantity === null
          ? null
          : Math.max(1, Number(options.quantity) || 0),
      // Set when the reload is one share of a grouped reload: fill to this, not to capacity.
      targetQuantity:
        Number(options.targetQuantity) > 0
          ? Math.trunc(Number(options.targetQuantity))
          : null,
      reloadTimeMs,
      startedAtMs,
      reloadStartAtMs,
      completeAtMs,
      clientAnnounced: false,
      systemID: Number(session && session._space && session._space.systemID) || 0,
      session,
    };
    pendingModuleReloads.set(numericModuleID, reloadState);
    schedulePendingModuleReloadPump();
    if (isPendingModuleReloadWindowOpen(reloadState, startedAtMs)) {
      this._announcePendingModuleReload(reloadState);
    }
    return {
      success: true,
      data: {
        reloadState,
      },
    };
  }
  /**
   * Publish the reload window to the owning client.
   *
   * The V24 client treats any nextActivationTime in the future as "this module
   * is reloading" (godma.StateManager.GetReloadTimes), and
   * shipmodulebutton.Click() returns without doing anything while that holds.
   * Announcing before the reload actually starts therefore makes the module
   * button unresponsive for the whole cycle, so this is deferred until the
   * reload window opens.
   */
  _announcePendingModuleReload(reloadState) {
    if (!reloadState || reloadState.clientAnnounced === true) {
      return false;
    }
    reloadState.clientAnnounced = true;
    const numericModuleID = Number(reloadState.moduleID) || 0;
    if (numericModuleID <= 0) {
      return false;
    }
    const session = reloadState.session || null;
    const reloadTimeMs = Math.max(0, Math.round(Number(reloadState.reloadTimeMs) || 0));
    this._notifyModuleNextActivationTime(
      session,
      numericModuleID,
      toFileTimeFromMs(reloadState.completeAtMs, 0n),
      0n,
    );
    if (Number(reloadState.chargeTypeID) > 0) {
      this._notifyChargeBeingLoadedToModule(
        session,
        [numericModuleID],
        Number(reloadState.chargeTypeID),
        reloadTimeMs,
      );
    }
    return true;
  }
  queueAutomaticModuleReload(session, moduleItem, options = {}) {
    const normalizedModuleItem = moduleItem || null;
    const numericModuleID = Number(normalizedModuleItem && normalizedModuleItem.itemID) || 0;
    if (numericModuleID <= 0) {
      return {
        success: false,
        errorMsg: "MODULE_NOT_FOUND",
      };
    }
    const shipID =
      Number(options.shipID) ||
      Number(normalizedModuleItem.locationID) ||
      this._getShipID(session);
    const charID = this._getCharID(session);
    if (shipID <= 0 || charID <= 0) {
      return {
        success: false,
        errorMsg: "SHIP_NOT_FOUND",
      };
    }
    const chargeTypeID = Number(options.chargeTypeID) || 0;
    if (chargeTypeID <= 0) {
      return {
        success: false,
        errorMsg: "NO_AMMO",
      };
    }
    if (!isChargeCompatibleWithModule(normalizedModuleItem.typeID, chargeTypeID)) {
      return {
        success: false,
        errorMsg: "INCOMPATIBLE_AMMO",
      };
    }
    const ammoLocationID = Number(options.ammoLocationID) || shipID;
    const sourceFlagID = Number(options.sourceFlagID) || ITEM_FLAGS.CARGO_HOLD;
    const inventoryOwnerID = this._getDogmaInventoryOwnerID(session, shipID);
    const sourceOwnerID = this._getDogmaInventoryOwnerID(session, ammoLocationID);
    const sourceStacks = this._resolvePendingReloadSourceStacks(
      sourceOwnerID,
      ammoLocationID,
      sourceFlagID,
      chargeTypeID,
      options.sourceItemIDs,
    );
    if (sourceStacks.length === 0) {
      return {
        success: false,
        errorMsg: "NO_AMMO",
      };
    }
    const requestedQuantity =
      options.quantity === undefined || options.quantity === null
        ? getModuleChargeCapacity(normalizedModuleItem.typeID, chargeTypeID)
        : Math.max(1, Number(options.quantity) || 0);
    if (!Number.isFinite(requestedQuantity) || requestedQuantity <= 0) {
      return {
        success: false,
        errorMsg: "NO_AMMO",
      };
    }
    return this._queuePendingModuleReload(session, normalizedModuleItem, {
      action: "load",
      shipID,
      chargeTypeID,
      ammoLocationID,
      sourceFlagID,
      inventoryOwnerID,
      sourceOwnerID,
      sourceItemIDs: sourceStacks.map((item) => item.itemID),
      reloadTimeMs:
        Number(options.reloadTimeMs) ||
        this._getModuleReloadTimeMs(session, normalizedModuleItem),
      reloadStartDelayMs: Number(options.reloadStartDelayMs) || 0,
      quantity: requestedQuantity,
      targetQuantity: options.targetQuantity,
    });
  }
  _completePendingModuleReload(
    reloadState,
    nowMs = getReloadStateCurrentTimeMs(reloadState, Date.now()),
  ) {
    if (!reloadState) {
      return {
        success: false,
        errorMsg: "RELOAD_NOT_FOUND",
      };
    }
    const numericModuleID = Number(reloadState.moduleID) || 0;
    if (numericModuleID > 0) {
      pendingModuleReloads.delete(numericModuleID);
    }
    schedulePendingModuleReloadPump();
    const session =
      reloadState.session &&
      reloadState.session.socket &&
      !reloadState.session.socket.destroyed
        ? reloadState.session
        : reloadState.session || null;
    const moduleItem = findItemById(numericModuleID);
    const charID = Number(reloadState.charID) || 0;
    const inventoryOwnerID =
      Number(reloadState.inventoryOwnerID) ||
      this._getDogmaInventoryOwnerID(session, reloadState.shipID) ||
      charID;
    const sourceOwnerID =
      Number(reloadState.sourceOwnerID) ||
      this._getDogmaInventoryOwnerID(session, reloadState.ammoLocationID) ||
      inventoryOwnerID;
    const shipID = Number(reloadState.shipID) || 0;
    const moduleFlagID = Number(reloadState.moduleFlagID) || 0;
    const previousNextActivationTime = reloadState.clientAnnounced === false
      ? 0n
      : toFileTimeFromMs(Number(reloadState.completeAtMs) || nowMs, 0n);
    if (
      !moduleItem ||
      Number(moduleItem.ownerID) !== inventoryOwnerID ||
      Number(moduleItem.locationID) !== shipID ||
      Number(moduleItem.flagID) !== moduleFlagID
    ) {
      this._notifyModuleNextActivationTime(session, numericModuleID, 0n, previousNextActivationTime);
      return {
        success: false,
        errorMsg: "MODULE_NOT_FOUND",
      };
    }
    const previousChargeState = this._captureChargeStateSnapshot(
      inventoryOwnerID,
      shipID,
      moduleFlagID,
    );
    const previousChargeItem = this._captureChargeItemSnapshot(
      inventoryOwnerID,
      shipID,
      moduleFlagID,
    );
    try {
      if (reloadState.action === "load") {
        let existingCharge = getLoadedChargeByFlag(inventoryOwnerID, shipID, moduleFlagID);
        let activeChargeTypeID = existingCharge ? Number(existingCharge.typeID) || 0 : 0;
        const chargeTypeID = Number(reloadState.chargeTypeID) || 0;
        if (
          chargeTypeID > 0 &&
          isChargeCompatibleWithModule(moduleItem.typeID, chargeTypeID)
        ) {
          const sourceStacks = this._resolvePendingReloadSourceStacks(
            sourceOwnerID,
            reloadState.ammoLocationID,
            reloadState.sourceFlagID,
            chargeTypeID,
            reloadState.sourceItemIDs,
          );
          if (
            sourceStacks.length > 0 ||
            (existingCharge && activeChargeTypeID === chargeTypeID)
          ) {
            if (existingCharge && activeChargeTypeID !== chargeTypeID) {
              const unloadResult = this._moveLoadedChargeToDestination(
                existingCharge,
                reloadState.ammoLocationID,
                reloadState.sourceFlagID,
              );
              if (unloadResult.success) {
                this._syncInventoryChanges(session, unloadResult.data.changes);
              }
              existingCharge = null;
              activeChargeTypeID = 0;
            }
            const moduleCapacity = getModuleChargeCapacity(moduleItem.typeID, chargeTypeID);
            const targetQuantity = Number(reloadState.targetQuantity) > 0
              ? Math.min(moduleCapacity, Number(reloadState.targetQuantity))
              : moduleCapacity;
            const existingQuantity = existingCharge
              ? Number(existingCharge.stacksize || existingCharge.quantity || 0) || 0
              : 0;
            let neededQuantity = Math.max(0, targetQuantity - existingQuantity);
            for (const sourceCharge of sourceStacks) {
              if (neededQuantity <= 0) {
                break;
              }
              const chargeItem = findItemById(sourceCharge.itemID);
              if (
                !chargeItem ||
                Number(chargeItem.ownerID) !== sourceOwnerID ||
                Number(chargeItem.locationID) !== Number(reloadState.ammoLocationID) ||
                Number(chargeItem.flagID) !== Number(reloadState.sourceFlagID) ||
                Number(chargeItem.typeID) !== chargeTypeID
              ) {
                continue;
              }
              const availableQuantity = Number(chargeItem.stacksize || chargeItem.quantity || 0) || 0;
              if (availableQuantity <= 0) {
                continue;
              }
              const moveQuantity = Math.min(neededQuantity, availableQuantity);
              const moveResult =
                existingCharge && activeChargeTypeID === chargeTypeID
                  ? mergeItemStacks(
                    chargeItem.itemID,
                    existingCharge.itemID,
                    moveQuantity,
                  )
                  : moveItemToLocation(
                    chargeItem.itemID,
                    shipID,
                    moduleFlagID,
                    moveQuantity,
                  );
              if (!moveResult.success) {
                continue;
              }
              this._syncInventoryChanges(session, moveResult.data.changes);
              neededQuantity -= moveQuantity;
              if (existingCharge && activeChargeTypeID === chargeTypeID) {
                existingCharge = findItemById(existingCharge.itemID) || existingCharge;
              } else if (!existingCharge) {
                existingCharge = getLoadedChargeByFlag(
                  inventoryOwnerID,
                  shipID,
                  moduleFlagID,
                );
                activeChargeTypeID = existingCharge ? Number(existingCharge.typeID) || 0 : 0;
              }
            }
          }
        }
      }
    } finally {
      const nextChargeState = this._captureChargeStateSnapshot(
        inventoryOwnerID,
        shipID,
        moduleFlagID,
      );
      const nextChargeItem = this._captureChargeItemSnapshot(
        inventoryOwnerID,
        shipID,
        moduleFlagID,
      );
      this._notifyChargeQuantityTransition(
        session,
        charID,
        shipID,
        moduleFlagID,
        previousChargeState,
        nextChargeState,
        {
          previousChargeItem,
          nextChargeItem,
        },
      );
      this._notifyWeaponModuleAttributeTransition(
        session,
        moduleItem,
        previousChargeItem,
        nextChargeItem,
      );
      this._refreshScannerProbeLauncherClientState(
        session,
        shipID,
        moduleItem,
        {
          forceRuntimeSync: true,
        },
      );
      this._notifyModuleNextActivationTime(
        session,
        numericModuleID,
        0n,
        previousNextActivationTime,
      );
    }
    return {
      success: true,
      data: {
        moduleID: numericModuleID,
      },
    };
  }
  Handle_CreateNewbieShip(args, session) {
    const requestedShipID =
      args && args.length > 0 ? Number(args[0]) || 0 : this._getShipID(session);
    const requestedLocationID =
      args && args.length > 1 ? Number(args[1]) || 0 : this._getLocationID(session);
    const stationID = getDockedLocationID(session) || 0;
    log.info(
      `[DogmaIM] CreateNewbieShip(shipID=${requestedShipID}, locationID=${requestedLocationID})`,
    );
    if (!session || !session.characterID || !stationID) {
      throwWrappedUserError("MustBeDocked");
    }
    const boardResult = boardNewbieShipForSession(session, {
      emitNotifications: true,
      logSelection: false,
      repairExistingShip: true,
      logLabel: "CreateNewbieShip",
    });
    if (!boardResult.success) {
      if (boardResult.errorMsg === "DOCK_REQUIRED") {
        throwWrappedUserError("MustBeDocked");
      }
      if (boardResult.errorMsg === "ALREADY_IN_NEWBIE_SHIP") {
        throwWrappedUserError("AlreadyInNewbieShip");
      }
      throwWrappedUserError("ErrorCreatingNewbieShip");
    }
    return null;
  }
  Handle_GetLocationInfo(args, session) {
    log.debug("[DogmaIM] GetLocationInfo");
    return [
      (session && session.userid) || 1,
      this._getLocationID(session),
      0,
    ];
  }
  Handle_InjectSkillIntoBrain(args, session) {
    log.debug("[DogmaIM] InjectSkillIntoBrain");
    const rawItemIDs = args && args.length === 1 ? args[0] : args;
    return injectSkillbookItems(this._getCharID(session), rawItemIDs, session);
  }
  _sendPostUndockDogmaMultiEvent(session) {
    if (
      !session ||
      !session._space ||
      session._space.loginChargeHydrationProfile !== "undock" ||
      session._space.postUndockDogmaMultiEventSent === true
    ) {
      return false;
    }

    const charID = this._getCharID(session);
    const shipContext = this._getCurrentDogmaShipContext(session);
    const shipID = Number(shipContext && shipContext.shipID) || this._getShipID(session);
    if (!shipContext || charID <= 0 || shipID <= 0 || shipContext.controllingStructure) {
      return false;
    }

    const shipRecord =
      shipContext.shipRecord ||
      this._getActiveShipRecord(session) ||
      shipContext.shipMetadata ||
      {};
    const fittingContext = this._buildFittingHydrationContext(
      charID,
      shipID,
      shipContext.shipMetadata || shipRecord,
    );
    const shipAttributes = this._buildShipAttributes(
      this._getCharacterRecord(session) || {},
      shipRecord,
      session,
      { fittingContext },
    );
    const time = this._sessionFileTime(session);
    const subEvents = [];
    const shipAttributeIDs = [
      ATTRIBUTE_MASS,
      ATTRIBUTE_MAX_VELOCITY,
      ATTRIBUTE_CHARGE,
      ATTRIBUTE_SHIELD_CHARGE_HELPER,
      ATTRIBUTE_POWER_LOAD,
      ATTRIBUTE_CPU_LOAD,
    ];

    for (const attributeID of shipAttributeIDs) {
      const value = Number(shipAttributes && shipAttributes[attributeID]);
      if (!Number.isFinite(value)) {
        continue;
      }
      subEvents.push(
        buildModuleAttributeChangeEvent(
          charID,
          shipID,
          attributeID,
          value,
          value,
          time,
        ),
      );
    }

    const isOnlineAttributeID = getAttributeIDByNames("isOnline") || 1153;
    for (const moduleItem of getFittedModuleItems(charID, shipID)) {
      if (!isModuleOnline(moduleItem)) {
        continue;
      }
      subEvents.push(
        buildModuleAttributeChangeEvent(
          charID,
          moduleItem.itemID,
          isOnlineAttributeID,
          1,
          1,
          time,
        ),
      );
    }

    const sent = sendOnMultiEvent(session, subEvents, time);
    if (sent) {
      session._space.postUndockDogmaMultiEventSent = true;
    }
    return sent;
  }
  Handle_MachoResolveObject(args, session, kwargs) {
    const bindParameter = args && args[0];
    void bindParameter;
    log.debug("[DogmaIM] MachoResolveObject called");
    return PROXY_NODE_ID;
  }
  Handle_MachoBindObject(args, session, kwargs) {
    const bindParams = args && args.length > 0 ? args[0] : null;
    const nestedCall = args && args.length > 1 ? args[1] : null;
    log.debug(
      `[DogmaIM] MachoBindObject args.length=${args ? args.length : 0} bindParams=${JSON.stringify(bindParams, (k, v) => (typeof v === "bigint" ? v.toString() : v))} nestedCall=${JSON.stringify(nestedCall, (k, v) => (typeof v === "bigint" ? v.toString() : Buffer.isBuffer(v) ? v.toString("utf8") : v))}`,
    );
    return buildBoundObjectResponse(this, args, session, kwargs);
  }
  afterCallResponse(methodName, session, context = {}) {
    let dogmaMethodName = methodName;
    if (methodName === "MachoBindObject") {
      const bindArgs = Array.isArray(context && context.args)
        ? context.args
        : [];
      const nestedCall = bindArgs.length > 1 ? bindArgs[1] : null;
      if (Array.isArray(nestedCall) && nestedCall.length >= 1) {
        dogmaMethodName =
          typeof nestedCall[0] === "string"
            ? nestedCall[0]
            : Buffer.isBuffer(nestedCall[0])
              ? nestedCall[0].toString("utf8")
              : String(nestedCall[0]);
      }
    }
    if (dogmaMethodName !== "GetAllInfo") {
      return;
    }
    if (this._isControllingStructureSession(session)) {
      // The controlled fitting is already authoritative in GetAllInfo. TQ does
      // not replay each structure module as a synthetic inventory transition
      // after the response; its later batched recalculation concerns the prior
      // ship/character activation state.
      return;
    }
    this._flushPostGetAllInfoChargeQuantityRefresh(session);
    this._sendPostUndockDogmaMultiEvent(session);
    syncCharacterDogmaState(session, this._getCharID(session));
  }
}
/**
 * Process all pending module reloads whose timers have expired.
 * Called from the scheduled timer callback and can also be invoked
 * directly for testing.
 */
DogmaService.flushPendingModuleReloads = function flushPendingModuleReloads(
  nowMs = Date.now(),
) {
  const instance = new DogmaService();
  const completed = [];
  for (const [moduleID, reloadState] of pendingModuleReloads.entries()) {
    const completeAtMs = Number(reloadState && reloadState.completeAtMs) || 0;
    const currentTimeMs = getReloadStateCurrentTimeMs(reloadState, nowMs);
    if (
      reloadState &&
      reloadState.clientAnnounced === false &&
      isPendingModuleReloadWindowOpen(reloadState, currentTimeMs)
    ) {
      instance._announcePendingModuleReload(reloadState);
    }
    if (completeAtMs <= 0 || completeAtMs > currentTimeMs) {
      continue;
    }
    const result = instance._completePendingModuleReload(reloadState, currentTimeMs);
    completed.push({
      moduleID,
      success: result.success,
      errorMsg: result.errorMsg || null,
    });
  }
  schedulePendingModuleReloadPump();
  return completed;
};
DogmaService.boardNewbieShipForSession = boardNewbieShipForSession;
DogmaService.resolveNewbieShipTypeIDForSession = resolveNewbieShipTypeID;
DogmaService.repairShipAndFittedItemsForSession = repairShipAndFittedItemsForSession;
DogmaService._testing = {
  flushPendingModuleReloads: DogmaService.flushPendingModuleReloads,
  getPendingModuleReloads() {
    return pendingModuleReloads;
  },
  marshalDogmaAttributeValue,
  normalizeModuleAttributeChange,
  clearPendingModuleReloads() {
    pendingModuleReloads.clear();
    if (pendingModuleReloadTimer) {
      clearTimeout(pendingModuleReloadTimer);
      pendingModuleReloadTimer = null;
    }
  },
};

// Methods that belong to a system of their own live in ./dogmaService/<system>.js and are put
// back on the prototype here, non-enumerable like the class's own methods.
function attachDogmaServiceMethods(methods) {
  for (const [name, method] of Object.entries(methods)) {
    Object.defineProperty(DogmaService.prototype, name, {
      value: method,
      writable: true,
      configurable: true,
    });
  }
}

attachDogmaServiceMethods(require(path.join(__dirname, "./dogmaService/droneSettings")));
attachDogmaServiceMethods(require(path.join(__dirname, "./dogmaService/requiredSkillLevels")));
attachDogmaServiceMethods(require(path.join(__dirname, "./dogmaService/layerDamageValues")));
attachDogmaServiceMethods(require(path.join(__dirname, "./dogmaService/overload")));
attachDogmaServiceMethods(require(path.join(__dirname, "./dogmaService/moduleRepair")));
attachDogmaServiceMethods(require(path.join(__dirname, "./dogmaService/implantsAndBoosters")));
attachDogmaServiceMethods(require(path.join(__dirname, "./dogmaService/targeting")));
attachDogmaServiceMethods(require(path.join(__dirname, "./dogmaService/itemInfo")));
attachDogmaServiceMethods(require(path.join(__dirname, "./dogmaService/moduleOperation")));
attachDogmaServiceMethods(require(path.join(__dirname, "./dogmaService/weaponBanks")));

module.exports = DogmaService;
