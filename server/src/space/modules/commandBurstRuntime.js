"use strict";

const {
  round6,
  toFiniteNumber,
} = require("../../common/numbers");

const path = require("path");

const database = require(path.join(__dirname, "../../gameStore"));
const {
  roundToWholeUnits,
} = require(path.join(__dirname, "../../services/_shared/floatPrecision"));
const {
  getAttributeIDByNames,
  getModuleChargeGroupIDs,
  getRequiredSkillRequirements,
  isChargeCompatibleWithModule,
  applyOtherItemModifiersToAttributes,
  shouldApplyStackingPenalty,
} = require(path.join(__dirname, "../../services/fitting/liveFittingState"));
const {
  buildLocationModifiedAttributeMap,
  collectShipModifierAttributes,
} = require(path.join(__dirname, "../combat/weaponDogma"));
const {
  buildNpcEffectiveModuleItem,
} = require(path.join(__dirname, "../npc/npcCapabilityResolver"));
const {
  getActiveImplantLocationModifierSources,
  getActiveImplantShipModifierEntries,
} = require(path.join(
  __dirname,
  "../../services/dogma/implants/activeImplantModifiers",
));
const {
  canEntitiesInteractLocally,
} = require(path.join(__dirname, "../destiny/identity/interactionScope"));
function isInSameFleet(leftCharacterID, rightCharacterID) {
  const fleetHelpers = require(path.join(
    __dirname,
    "../../services/fleets/fleetHelpers",
  ));
  return fleetHelpers && typeof fleetHelpers.isInSameFleet === "function"
    ? fleetHelpers.isInSameFleet(leftCharacterID, rightCharacterID)
    : false;
}

const DBUFF_COLLECTIONS_TABLE = "dbuffCollections";

const ATTRIBUTE_CAPACITOR_NEED = getAttributeIDByNames("capacitorNeed") || 6;
const ATTRIBUTE_DURATION = getAttributeIDByNames("duration") || 73;
const ATTRIBUTE_MAX_RANGE = getAttributeIDByNames("maxRange") || 54;
const ATTRIBUTE_MAX_GROUP_ACTIVE = getAttributeIDByNames("maxGroupActive") || 763;
const ATTRIBUTE_REACTIVATION_DELAY =
  getAttributeIDByNames("moduleReactivationDelay", "reactivationDelay") || 669;
const ATTRIBUTE_RELOAD_TIME = getAttributeIDByNames("reloadTime") || 1795;
const ATTRIBUTE_BUFF_DURATION = getAttributeIDByNames("buffDuration") || 2535;
const ATTRIBUTE_WARFARE_BUFF_1_ID = getAttributeIDByNames("warfareBuff1ID") || 2468;
const ATTRIBUTE_WARFARE_BUFF_1_VALUE = getAttributeIDByNames("warfareBuff1Value") || 2469;
const ATTRIBUTE_WARFARE_BUFF_2_ID = getAttributeIDByNames("warfareBuff2ID") || 2470;
const ATTRIBUTE_WARFARE_BUFF_2_VALUE = getAttributeIDByNames("warfareBuff2Value") || 2471;
const ATTRIBUTE_WARFARE_BUFF_3_ID = getAttributeIDByNames("warfareBuff3ID") || 2472;
const ATTRIBUTE_WARFARE_BUFF_3_VALUE = getAttributeIDByNames("warfareBuff3Value") || 2473;
const ATTRIBUTE_WARFARE_BUFF_4_ID = getAttributeIDByNames("warfareBuff4ID") || 2536;
const ATTRIBUTE_WARFARE_BUFF_4_VALUE = getAttributeIDByNames("warfareBuff4Value") || 2537;

const GROUP_EXPEDITION_COMMAND_BURST_CHARGES = 4905;
const EXPEDITION_DBUFF_COLLECTION_IDS = Object.freeze(new Set([
  2464,
  2465,
  2466,
  2468,
  2481,
]));

const DOGMA_OP_PRE_MUL = 0;
const DOGMA_OP_MOD_ADD = 2;
const DOGMA_OP_POST_MUL = 4;
const ATTRIBUTE_CONSUMPTION_TYPE = getAttributeIDByNames("consumptionType") || 713;
const ATTRIBUTE_CONSUMPTION_QUANTITY =
  getAttributeIDByNames("consumptionQuantity") || 714;
const DOGMA_OP_POST_PERCENT = 6;
const DOGMA_OP_PRE_ASSIGNMENT = 7;
const DOGMA_OP_POST_ASSIGNMENT = 8;

const COMMAND_BURST_DEFINITIONS = Object.freeze({
  moduleBonusWarfareLinkArmor: Object.freeze({
    family: "armor",
    sourceFxGuid: "effects.WarfareLinkSphereArmor",
    targetFxGuid: "effects.WarfareLinkArmor",
  }),
  moduleBonusWarfareLinkInfo: Object.freeze({
    family: "information",
    sourceFxGuid: "effects.WarfareLinkSphereInformation",
    targetFxGuid: "effects.WarfareLinkInformation",
  }),
  moduleBonusWarfareLinkMining: Object.freeze({
    family: "mining",
    sourceFxGuid: "effects.WarfareLinkSphereMining",
    targetFxGuid: "effects.WarfareLinkMining",
  }),
  moduleBonusWarfareLinkShield: Object.freeze({
    family: "shield",
    sourceFxGuid: "effects.WarfareLinkSphereShield",
    targetFxGuid: "effects.WarfareLinkShield",
  }),
  moduleBonusWarfareLinkSkirmish: Object.freeze({
    family: "skirmish",
    sourceFxGuid: "effects.WarfareLinkSphereSkirmish",
    targetFxGuid: "effects.WarfareLinkSkirmish",
  }),
  // A titan's Phenomena Generator is warfare-buff plumbing like the bursts
  // above, and reuses all of it, but it is not a command burst: it bends local
  // space rather than co-ordinating a fleet, so it lands on EVERY ship inside
  // its 20,000 km radius — the titan itself, its fleet, and its enemies alike.
  // Each generator carries two bonuses and two penalties for exactly that
  // reason. Leaving it out of this table left it applying nothing to anybody
  // while still burning 40,000 isotopes and 25,000 GJ every five minutes.
  moduleTitanEffectGenerator: Object.freeze({
    family: "phenomena",
    sourceFxGuid: "effects.TitanEffectGenerator",
    targetFxGuid: "effects.TitanEffectGenerator",
    affectsAllShipsInRange: true,
    // A command burst reads its warfare buffs off the loaded charge. This one
    // declares them on the module itself and takes no charge at all — it runs
    // on isotopes, which the generic fuel path already consumes.
    carriesOwnBuffs: true,
  }),
});

const OPERATION_NAME_TO_CODE = Object.freeze({
  ModAdd: DOGMA_OP_MOD_ADD,
  PostMul: DOGMA_OP_POST_MUL,
  PostPercent: DOGMA_OP_POST_PERCENT,
  PreAssignment: DOGMA_OP_PRE_ASSIGNMENT,
  PostAssignment: DOGMA_OP_POST_ASSIGNMENT,
});

let cachedDbuffCollectionsByID = null;
const timedCommandBurstHistoryByEntity = new WeakMap();

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function cloneVector(source = null) {
  return {
    x: toFiniteNumber(source && source.x, 0),
    y: toFiniteNumber(source && source.y, 0),
    z: toFiniteNumber(source && source.z, 0),
  };
}

function subtractVectors(left, right) {
  return {
    x: toFiniteNumber(left && left.x, 0) - toFiniteNumber(right && right.x, 0),
    y: toFiniteNumber(left && left.y, 0) - toFiniteNumber(right && right.y, 0),
    z: toFiniteNumber(left && left.z, 0) - toFiniteNumber(right && right.z, 0),
  };
}

function magnitude(vector) {
  return Math.sqrt(
    (toFiniteNumber(vector && vector.x, 0) ** 2) +
    (toFiniteNumber(vector && vector.y, 0) ** 2) +
    (toFiniteNumber(vector && vector.z, 0) ** 2),
  );
}

function distance(left, right) {
  return magnitude(subtractVectors(left, right));
}

function getSurfaceDistance(left, right) {
  return Math.max(
    0,
    distance(left && left.position, right && right.position) -
      Math.max(0, toFiniteNumber(left && left.radius, 0)) -
      Math.max(0, toFiniteNumber(right && right.radius, 0)),
  );
}

function normalizeEffectName(effectRecord) {
  return String(effectRecord && effectRecord.name || "").trim();
}

function resolveCommandBurstDefinition(effectRecord) {
  return COMMAND_BURST_DEFINITIONS[normalizeEffectName(effectRecord)] || null;
}

function isCommandBurstEffectRecord(effectRecord) {
  return Boolean(resolveCommandBurstDefinition(effectRecord));
}

function freezePlainEntries(entries = [], extraPredicate = null) {
  const normalizedEntries = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const nextEntry = {
      dogmaAttributeID: toInt(entry && entry.dogmaAttributeID, 0),
      groupID: toInt(entry && entry.groupID, 0),
      categoryID: toInt(entry && entry.categoryID, 0),
      skillID: toInt(entry && entry.skillID, 0),
    };
    if (nextEntry.dogmaAttributeID <= 0) {
      continue;
    }
    if (typeof extraPredicate === "function" && extraPredicate(nextEntry) !== true) {
      continue;
    }
    normalizedEntries.push(Object.freeze(nextEntry));
  }
  return Object.freeze(normalizedEntries);
}

function normalizeDbuffCollectionEntry(entry, fallbackCollectionID = 0) {
  if (!entry || typeof entry !== "object") {
    return null;
  }

  const collectionID = toInt(
    entry.collectionID,
    fallbackCollectionID,
  );
  const operation =
    toInt(entry.operation, 0) > 0
      ? toInt(entry.operation, 0)
      : OPERATION_NAME_TO_CODE[String(entry.operationName || "")];
  if (collectionID <= 0 || operation === undefined) {
    return null;
  }

  return Object.freeze({
    collectionID,
    aggregateMode: String(entry.aggregateMode || "Maximum"),
    operation,
    operationName: String(entry.operationName || ""),
    developerDescription: String(entry.developerDescription || ""),
    itemModifiers: freezePlainEntries(entry.itemModifiers),
    locationModifiers: freezePlainEntries(entry.locationModifiers),
    locationGroupModifiers: freezePlainEntries(
      entry.locationGroupModifiers,
      (candidate) => candidate.groupID > 0,
    ),
    locationCategoryModifiers: freezePlainEntries(
      entry.locationCategoryModifiers,
      (candidate) => candidate.categoryID > 0,
    ),
    locationRequiredSkillModifiers: freezePlainEntries(
      entry.locationRequiredSkillModifiers,
      (candidate) => candidate.skillID > 0,
    ),
  });
}

function buildDbuffCollectionsByID() {
  const collectionsByID = new Map();
  const result = database.read(DBUFF_COLLECTIONS_TABLE, "/");
  const rawRoot =
    result && result.success && result.data && typeof result.data === "object"
      ? result.data
      : null;
  const rawCollections =
    rawRoot &&
    typeof rawRoot === "object" &&
    rawRoot.collectionsByID &&
    typeof rawRoot.collectionsByID === "object"
      ? rawRoot.collectionsByID
      : rawRoot &&
          typeof rawRoot === "object" &&
          rawRoot.records &&
          typeof rawRoot.records === "object"
        ? rawRoot.records
        : rawRoot;
  if (!rawCollections) {
    return collectionsByID;
  }

  for (const [collectionID, entry] of Object.entries(rawCollections)) {
    const normalizedEntry = normalizeDbuffCollectionEntry(entry, collectionID);
    if (!normalizedEntry) {
      continue;
    }
    collectionsByID.set(normalizedEntry.collectionID, normalizedEntry);
  }

  return collectionsByID;
}

function getDbuffCollectionsByID() {
  if (!cachedDbuffCollectionsByID) {
    cachedDbuffCollectionsByID = buildDbuffCollectionsByID();
  }
  return cachedDbuffCollectionsByID;
}

class Aggregator {
  constructor(expiryTime, outputValue) {
    if (expiryTime === undefined || expiryTime === null) {
      this._continuousInput = outputValue;
      this._sortedInputs = [];
    } else {
      this._continuousInput = null;
      this._sortedInputs = [[expiryTime, outputValue]];
    }
  }

  hasInputs() {
    return this._sortedInputs.length > 0 || this._continuousInput !== null;
  }

  getNextExpiryTime() {
    if (this._sortedInputs.length > 0) {
      return this._sortedInputs[0][0];
    }
    if (this._continuousInput === null) {
      return 0;
    }
    return null;
  }

  getFinalExpiryTime() {
    if (this._continuousInput !== null) {
      return null;
    }
    if (this._sortedInputs.length > 0) {
      return this._sortedInputs[this._sortedInputs.length - 1][0];
    }
    return null;
  }

  getCurrentOutputValue() {
    if (this._sortedInputs.length > 0 && this._continuousInput !== null) {
      return this._pickValue(this._continuousInput, this._sortedInputs[0][1]);
    }
    if (this._continuousInput !== null) {
      return this._continuousInput;
    }
    if (this._sortedInputs.length > 0) {
      return this._sortedInputs[0][1];
    }
    return null;
  }

  setContinuousInput(newValue) {
    if (this._continuousInput === null) {
      this._continuousInput = newValue;
      return;
    }
    this._continuousInput = this._pickValue(this._continuousInput, newValue);
  }

  clearContinuousInput() {
    this._continuousInput = null;
  }

  discardExpiredTimedInputs(now) {
    while (this._sortedInputs.length > 0 && this._sortedInputs[0][0] < now) {
      this._sortedInputs.shift();
    }
  }
}

class AggregatorMinimum extends Aggregator {
  mergeNewTimedInput(newExpiryTime, newValue) {
    for (const [expiryTime, value] of this._sortedInputs) {
      if (expiryTime >= newExpiryTime && value <= newValue) {
        return;
      }
    }

    const result = [];
    for (const [expiryTime, value] of this._sortedInputs) {
      if (expiryTime < newExpiryTime && value < newValue) {
        result.push([expiryTime, value]);
      }
    }
    result.push([newExpiryTime, newValue]);
    for (const [expiryTime, value] of this._sortedInputs) {
      if (expiryTime > newExpiryTime && value > newValue) {
        result.push([expiryTime, value]);
      }
    }
    this._sortedInputs = result;
  }

  _pickValue(...values) {
    return Math.min(...values);
  }
}

class AggregatorMaximum extends Aggregator {
  mergeNewTimedInput(newExpiryTime, newValue) {
    for (const [expiryTime, value] of this._sortedInputs) {
      if (expiryTime >= newExpiryTime && value >= newValue) {
        return;
      }
    }

    const result = [];
    for (const [expiryTime, value] of this._sortedInputs) {
      if (expiryTime < newExpiryTime && value > newValue) {
        result.push([expiryTime, value]);
      }
    }
    result.push([newExpiryTime, newValue]);
    for (const [expiryTime, value] of this._sortedInputs) {
      if (expiryTime > newExpiryTime && value < newValue) {
        result.push([expiryTime, value]);
      }
    }
    this._sortedInputs = result;
  }

  _pickValue(...values) {
    return Math.max(...values);
  }
}

function createAggregator(collectionDefinition, expiryTime, outputValue) {
  if (collectionDefinition && collectionDefinition.aggregateMode === "Minimum") {
    return new AggregatorMinimum(expiryTime, outputValue);
  }
  return new AggregatorMaximum(expiryTime, outputValue);
}

function getCommandBurstBucketMap(entity, create = true) {
  if (!entity || typeof entity !== "object") {
    return null;
  }
  if (!(entity.commandBurstDynamicBuffs instanceof Map) && create) {
    entity.commandBurstDynamicBuffs = new Map();
  }
  return entity.commandBurstDynamicBuffs instanceof Map
    ? entity.commandBurstDynamicBuffs
    : null;
}

function getTimedCommandBurstHistoryMap(entity, create = true) {
  if (!entity || typeof entity !== "object") {
    return null;
  }
  if (!timedCommandBurstHistoryByEntity.has(entity) && create) {
    timedCommandBurstHistoryByEntity.set(entity, new Map());
  }
  return timedCommandBurstHistoryByEntity.get(entity) || null;
}

function recordTimedCommandBurstInput(
  entity,
  collectionID,
  startsAtMs,
  expiresAtMs,
  value,
) {
  const numericCollectionID = toInt(collectionID, 0);
  const numericStartsAtMs = Math.max(0, toFiniteNumber(startsAtMs, 0));
  const numericExpiresAtMs = Math.max(
    numericStartsAtMs,
    toFiniteNumber(expiresAtMs, numericStartsAtMs),
  );
  const numericValue = Number(value);
  if (numericCollectionID <= 0 || !Number.isFinite(numericValue)) {
    return false;
  }

  const historyByCollectionID = getTimedCommandBurstHistoryMap(entity, true);
  if (!(historyByCollectionID instanceof Map)) {
    return false;
  }
  if (!historyByCollectionID.has(numericCollectionID)) {
    historyByCollectionID.set(numericCollectionID, []);
  }
  historyByCollectionID.get(numericCollectionID).push({
    startsAtMs: numericStartsAtMs,
    expiresAtMs: numericExpiresAtMs,
    value: round6(numericValue),
  });
  return true;
}

function discardTimedCommandBurstHistoryBefore(entity, beforeMs) {
  const historyByCollectionID = getTimedCommandBurstHistoryMap(entity, false);
  if (!(historyByCollectionID instanceof Map) || historyByCollectionID.size <= 0) {
    return 0;
  }

  const numericBeforeMs = Math.max(0, toFiniteNumber(beforeMs, 0));
  let discardedCount = 0;
  for (const [collectionID, history] of [...historyByCollectionID.entries()]) {
    if (!Array.isArray(history) || history.length <= 0) {
      historyByCollectionID.delete(collectionID);
      continue;
    }
    const retainedHistory = history.filter((entry) => {
      const retain = toFiniteNumber(entry && entry.expiresAtMs, -1) >= numericBeforeMs;
      if (!retain) {
        discardedCount += 1;
      }
      return retain;
    });
    if (retainedHistory.length > 0) {
      historyByCollectionID.set(collectionID, retainedHistory);
    } else {
      historyByCollectionID.delete(collectionID);
    }
  }
  if (historyByCollectionID.size <= 0) {
    timedCommandBurstHistoryByEntity.delete(entity);
  }
  return discardedCount;
}

function getNextCommandBurstExpiryTime(entity) {
  const buckets = getCommandBurstBucketMap(entity, false);
  if (!(buckets instanceof Map) || buckets.size <= 0) {
    return null;
  }

  let nextExpiryTime = null;
  for (const aggregator of buckets.values()) {
    if (!aggregator || typeof aggregator.getNextExpiryTime !== "function") {
      continue;
    }
    const expiryTime = aggregator.getNextExpiryTime();
    if (expiryTime === null || expiryTime === undefined) {
      continue;
    }
    const numericExpiryTime = toFiniteNumber(expiryTime, NaN);
    if (!Number.isFinite(numericExpiryTime)) {
      continue;
    }
    if (nextExpiryTime === null || numericExpiryTime < nextExpiryTime) {
      nextExpiryTime = numericExpiryTime;
    }
  }
  return nextExpiryTime;
}

function buildCollectionValuesFromAttributes(attributes = {}) {
  const entries = [
    [
      toInt(attributes[ATTRIBUTE_WARFARE_BUFF_1_ID], 0),
      toFiniteNumber(attributes[ATTRIBUTE_WARFARE_BUFF_1_VALUE], NaN),
    ],
    [
      toInt(attributes[ATTRIBUTE_WARFARE_BUFF_2_ID], 0),
      toFiniteNumber(attributes[ATTRIBUTE_WARFARE_BUFF_2_VALUE], NaN),
    ],
    [
      toInt(attributes[ATTRIBUTE_WARFARE_BUFF_3_ID], 0),
      toFiniteNumber(attributes[ATTRIBUTE_WARFARE_BUFF_3_VALUE], NaN),
    ],
    [
      toInt(attributes[ATTRIBUTE_WARFARE_BUFF_4_ID], 0),
      toFiniteNumber(attributes[ATTRIBUTE_WARFARE_BUFF_4_VALUE], NaN),
    ],
  ];

  const collectionValues = new Map();
  for (const [collectionID, rawValue] of entries) {
    if (collectionID <= 0 || !Number.isFinite(rawValue)) {
      continue;
    }
    collectionValues.set(collectionID, round6(rawValue));
  }
  return collectionValues;
}

function collectionValuesContainExpeditionDbuffs(collectionValues) {
  if (!(collectionValues instanceof Map) || collectionValues.size <= 0) {
    return false;
  }
  for (const collectionID of collectionValues.keys()) {
    if (EXPEDITION_DBUFF_COLLECTION_IDS.has(toInt(collectionID, 0))) {
      return true;
    }
  }
  return false;
}

function moduleUsesExpeditionChargeGroup(moduleItem) {
  const moduleTypeID = toInt(moduleItem && moduleItem.typeID, 0);
  if (moduleTypeID <= 0) {
    return false;
  }
  const chargeGroups = getModuleChargeGroupIDs(moduleTypeID);
  return (
    chargeGroups instanceof Set &&
    chargeGroups.has(GROUP_EXPEDITION_COMMAND_BURST_CHARGES)
  );
}

function isExpeditionCommandBurst(moduleItem, chargeItem, collectionValues) {
  if (
    toInt(chargeItem && chargeItem.groupID, 0) ===
      GROUP_EXPEDITION_COMMAND_BURST_CHARGES
  ) {
    return true;
  }
  if (moduleUsesExpeditionChargeGroup(moduleItem)) {
    return true;
  }
  return collectionValuesContainExpeditionDbuffs(collectionValues);
}

function resolveCommandBurstRuntimeFamily(definition, moduleItem, chargeItem, collectionValues) {
  if (isExpeditionCommandBurst(moduleItem, chargeItem, collectionValues)) {
    return "expedition";
  }
  return String(definition && definition.family || "");
}

function moduleRequiresSkillType(moduleItem, skillTypeID) {
  return getRequiredSkillRequirements(toInt(moduleItem && moduleItem.typeID, 0))
    .some((entry) => toInt(entry && entry.skillTypeID, 0) === toInt(skillTypeID, 0));
}

function collectDefinitionModifierEntries(destination, collectionDefinition, targetItem, outputValue) {
  if (!collectionDefinition || !targetItem || !Number.isFinite(outputValue)) {
    return destination;
  }

  for (const modifier of collectionDefinition.itemModifiers) {
    destination.push({
      modifiedAttributeID: modifier.dogmaAttributeID,
      operation: collectionDefinition.operation,
      value: round6(outputValue),
      stackingPenalized: shouldApplyStackingPenalty(
        modifier.dogmaAttributeID,
        true,
      ),
      dbuffCollectionID: collectionDefinition.collectionID,
    });
  }

  for (const modifier of collectionDefinition.locationModifiers) {
    destination.push({
      modifiedAttributeID: modifier.dogmaAttributeID,
      operation: collectionDefinition.operation,
      value: round6(outputValue),
      stackingPenalized: shouldApplyStackingPenalty(
        modifier.dogmaAttributeID,
        true,
      ),
      dbuffCollectionID: collectionDefinition.collectionID,
    });
  }

  const matchedGroupAttributes = new Set();
  for (const modifier of collectionDefinition.locationGroupModifiers) {
    if (
      toInt(targetItem && targetItem.groupID, 0) !== modifier.groupID ||
      matchedGroupAttributes.has(modifier.dogmaAttributeID)
    ) {
      continue;
    }
    matchedGroupAttributes.add(modifier.dogmaAttributeID);
    destination.push({
      modifiedAttributeID: modifier.dogmaAttributeID,
      operation: collectionDefinition.operation,
      value: round6(outputValue),
      stackingPenalized: shouldApplyStackingPenalty(
        modifier.dogmaAttributeID,
        true,
      ),
      dbuffCollectionID: collectionDefinition.collectionID,
    });
  }

  const matchedCategoryAttributes = new Set();
  for (const modifier of collectionDefinition.locationCategoryModifiers) {
    if (
      toInt(targetItem && targetItem.categoryID, 0) !== modifier.categoryID ||
      matchedCategoryAttributes.has(modifier.dogmaAttributeID)
    ) {
      continue;
    }
    matchedCategoryAttributes.add(modifier.dogmaAttributeID);
    destination.push({
      modifiedAttributeID: modifier.dogmaAttributeID,
      operation: collectionDefinition.operation,
      value: round6(outputValue),
      stackingPenalized: shouldApplyStackingPenalty(
        modifier.dogmaAttributeID,
        true,
      ),
      dbuffCollectionID: collectionDefinition.collectionID,
    });
  }

  const matchedSkillAttributes = new Set();
  for (const modifier of collectionDefinition.locationRequiredSkillModifiers) {
    if (
      matchedSkillAttributes.has(modifier.dogmaAttributeID) ||
      !moduleRequiresSkillType(targetItem, modifier.skillID)
    ) {
      continue;
    }
    matchedSkillAttributes.add(modifier.dogmaAttributeID);
    destination.push({
      modifiedAttributeID: modifier.dogmaAttributeID,
      operation: collectionDefinition.operation,
      value: round6(outputValue),
      stackingPenalized: shouldApplyStackingPenalty(
        modifier.dogmaAttributeID,
        true,
      ),
      dbuffCollectionID: collectionDefinition.collectionID,
    });
  }

  return destination;
}

function buildCommandBurstStateSignature(entity) {
  const buckets = getCommandBurstBucketMap(entity, false);
  if (!(buckets instanceof Map) || buckets.size <= 0) {
    return "[]";
  }

  return JSON.stringify(
    [...buckets.entries()]
      .map(([collectionID, aggregator]) => ({
        collectionID,
        currentValue: round6(aggregator.getCurrentOutputValue()),
        finalExpiryTime: aggregator.getFinalExpiryTime(),
        timedInputs: aggregator._sortedInputs.map(([expiryTime, value]) => [
          expiryTime,
          round6(value),
        ]),
      }))
      .sort((left, right) => left.collectionID - right.collectionID),
  );
}

function buildClientDbuffStateEntriesInternal(entity, buildExpiry) {
  const buckets = getCommandBurstBucketMap(entity, false);
  if (!(buckets instanceof Map) || buckets.size <= 0) {
    return [];
  }

  return [...buckets.entries()]
    .map(([collectionID, aggregator]) => {
      const outputValue = aggregator.getCurrentOutputValue();
      if (!Number.isFinite(outputValue)) {
        return null;
      }
      const finalExpiryTime = aggregator.getFinalExpiryTime();
      return [
        toInt(collectionID, 0),
        [
          round6(outputValue),
          finalExpiryTime === null || finalExpiryTime === undefined
            ? null
            : buildExpiry(finalExpiryTime),
        ],
      ];
    })
    .filter(Boolean)
    .sort((left, right) => left[0] - right[0]);
}

function pruneExpiredCommandBursts(entity, nowMs) {
  const buckets = getCommandBurstBucketMap(entity, false);
  if (!(buckets instanceof Map) || buckets.size <= 0) {
    return {
      changed: false,
      clientState: [],
    };
  }

  const beforeSignature = buildCommandBurstStateSignature(entity);
  for (const [collectionID, aggregator] of [...buckets.entries()]) {
    aggregator.discardExpiredTimedInputs(nowMs);
    if (!aggregator.hasInputs()) {
      buckets.delete(collectionID);
    }
  }
  const afterSignature = buildCommandBurstStateSignature(entity);
  return {
    changed: beforeSignature !== afterSignature,
    clientState: buildClientDbuffStateEntriesInternal(entity, (expiryTime) => expiryTime),
  };
}

function buildClientDbuffStateEntries(entity, options = {}) {
  const nowMs = options.nowMs == null
    ? Date.now()
    : Math.max(0, toFiniteNumber(options.nowMs, Date.now()));
  pruneExpiredCommandBursts(entity, nowMs);
  const buckets = getCommandBurstBucketMap(entity, false);
  if (!(buckets instanceof Map) || buckets.size <= 0) {
    return [];
  }

  const buildExpiry =
    typeof options.buildExpiry === "function"
      ? options.buildExpiry
      : (expiryTime) => expiryTime;

  return buildClientDbuffStateEntriesInternal(entity, buildExpiry);
}

function applyTimedCommandBurstToEntity(entity, collectionValues, durationMs, nowMs) {
  const appliedAtMs = nowMs == null
    ? Date.now()
    : Math.max(0, toFiniteNumber(nowMs, Date.now()));
  if (!entity || !(collectionValues instanceof Map) || collectionValues.size <= 0) {
    return {
      changed: false,
      clientState: buildClientDbuffStateEntries(entity, { nowMs: appliedAtMs }),
    };
  }

  const clampedDurationMs = Math.max(0, toFiniteNumber(durationMs, 0));
  if (clampedDurationMs <= 0) {
    return {
      changed: false,
      clientState: buildClientDbuffStateEntries(entity, { nowMs: appliedAtMs }),
    };
  }

  const buckets = getCommandBurstBucketMap(entity, true);
  const beforeSignature = buildCommandBurstStateSignature(entity);
  for (const [collectionID, value] of collectionValues.entries()) {
    const numericCollectionID = toInt(collectionID, 0);
    const collectionDefinition = getDbuffCollectionsByID().get(numericCollectionID) || null;
    if (!collectionDefinition || !Number.isFinite(value)) {
      continue;
    }

    const expiryTime = appliedAtMs + clampedDurationMs;
    const roundedValue = round6(value);
    recordTimedCommandBurstInput(
      entity,
      numericCollectionID,
      appliedAtMs,
      expiryTime,
      roundedValue,
    );
    const existing = buckets.get(numericCollectionID) || null;
    if (!existing) {
      buckets.set(
        numericCollectionID,
        createAggregator(collectionDefinition, expiryTime, roundedValue),
      );
      continue;
    }

    existing.discardExpiredTimedInputs(appliedAtMs);
    existing.mergeNewTimedInput(expiryTime, roundedValue);
  }

  const afterSignature = buildCommandBurstStateSignature(entity);
  return {
    changed: beforeSignature !== afterSignature,
    clientState: buildClientDbuffStateEntries(entity, { nowMs: appliedAtMs }),
  };
}

function getContinuousDbuffSourceMap(entity, create = true) {
  if (!entity || typeof entity !== "object") {
    return null;
  }
  if (!(entity.commandBurstContinuousSources instanceof Map) && create) {
    entity.commandBurstContinuousSources = new Map();
  }
  return entity.commandBurstContinuousSources instanceof Map
    ? entity.commandBurstContinuousSources
    : null;
}

function normalizeCollectionValueMap(collectionValues) {
  const normalized = new Map();
  const entries = collectionValues instanceof Map
    ? collectionValues.entries()
    : Array.isArray(collectionValues)
      ? collectionValues.map((entry) => [entry && entry.collectionID, entry && entry.value])
      : Object.entries(collectionValues && typeof collectionValues === "object" ? collectionValues : {});
  for (const [collectionID, value] of entries) {
    const numericCollectionID = toInt(collectionID, 0);
    const numericValue = toFiniteNumber(value, NaN);
    if (numericCollectionID > 0 && Number.isFinite(numericValue)) {
      normalized.set(numericCollectionID, round6(numericValue));
    }
  }
  return normalized;
}

function resolveContinuousCollectionValue(collectionDefinition, sourceMap, collectionID) {
  const values = [];
  for (const collectionValues of sourceMap.values()) {
    if (collectionValues instanceof Map && collectionValues.has(collectionID)) {
      values.push(collectionValues.get(collectionID));
    }
  }
  if (values.length <= 0) {
    return null;
  }
  return collectionDefinition && collectionDefinition.aggregateMode === "Minimum"
    ? Math.min(...values)
    : Math.max(...values);
}

function hasContinuousSourceValue(sourceMap, collectionID) {
  for (const collectionValues of sourceMap.values()) {
    if (collectionValues instanceof Map && collectionValues.has(collectionID)) {
      return true;
    }
  }
  return false;
}

function rebuildContinuousDbuffCollections(entity, affectedCollectionIDs, nowMs) {
  const sourceMap = getContinuousDbuffSourceMap(entity, false) || new Map();
  const buckets = getCommandBurstBucketMap(entity, true);
  const definitions = getDbuffCollectionsByID();
  const unresolvedCollectionIDs = [];
  for (const collectionID of affectedCollectionIDs) {
    const numericCollectionID = toInt(collectionID, 0);
    const existing = buckets.get(numericCollectionID) || null;
    const sourceValuePresent = hasContinuousSourceValue(sourceMap, numericCollectionID);
    const definition = definitions.get(numericCollectionID) || null;
    if (!definition) {
      if (sourceValuePresent) {
        unresolvedCollectionIDs.push(numericCollectionID);
      } else if (existing) {
        existing.clearContinuousInput();
        existing.discardExpiredTimedInputs(nowMs);
        if (!existing.hasInputs()) {
          buckets.delete(numericCollectionID);
        }
      }
      continue;
    }
    const outputValue = resolveContinuousCollectionValue(
      definition,
      sourceMap,
      numericCollectionID,
    );
    if (outputValue === null) {
      if (existing) {
        existing.clearContinuousInput();
        existing.discardExpiredTimedInputs(nowMs);
        if (!existing.hasInputs()) {
          buckets.delete(numericCollectionID);
        }
      }
      continue;
    }
    if (!existing) {
      buckets.set(numericCollectionID, createAggregator(definition, null, outputValue));
      continue;
    }
    existing.clearContinuousInput();
    existing.setContinuousInput(outputValue);
  }
  return unresolvedCollectionIDs;
}

function setContinuousDbuffSource(entity, sourceKey, collectionValues, nowMs = Date.now()) {
  const normalizedSourceKey = String(sourceKey == null ? "" : sourceKey).trim();
  const normalizedValues = normalizeCollectionValueMap(collectionValues);
  if (!entity || !normalizedSourceKey || normalizedValues.size <= 0) {
    return {
      changed: false,
      unresolvedCollectionIDs: [],
      clientState: buildClientDbuffStateEntries(entity, { nowMs }),
    };
  }
  const definitions = getDbuffCollectionsByID();
  const unresolvedCollectionIDs = [...normalizedValues.keys()]
    .filter((collectionID) => !definitions.has(collectionID));
  if (unresolvedCollectionIDs.length > 0) {
    return {
      changed: false,
      unresolvedCollectionIDs,
      clientState: buildClientDbuffStateEntries(entity, { nowMs }),
    };
  }
  const sourceMap = getContinuousDbuffSourceMap(entity, true);
  const previousValues = sourceMap.get(normalizedSourceKey) || new Map();
  const affectedCollectionIDs = new Set([...previousValues.keys(), ...normalizedValues.keys()]);
  const beforeSignature = buildCommandBurstStateSignature(entity);
  sourceMap.set(normalizedSourceKey, normalizedValues);
  const rebuildUnresolvedCollectionIDs = rebuildContinuousDbuffCollections(
    entity,
    affectedCollectionIDs,
    nowMs,
  );
  const afterSignature = buildCommandBurstStateSignature(entity);
  return {
    changed: beforeSignature !== afterSignature,
    unresolvedCollectionIDs: rebuildUnresolvedCollectionIDs,
    clientState: buildClientDbuffStateEntries(entity, { nowMs }),
  };
}

function clearContinuousDbuffSource(entity, sourceKey, nowMs = Date.now()) {
  const normalizedSourceKey = String(sourceKey == null ? "" : sourceKey).trim();
  const sourceMap = getContinuousDbuffSourceMap(entity, false);
  if (!entity || !normalizedSourceKey || !(sourceMap instanceof Map) || !sourceMap.has(normalizedSourceKey)) {
    return {
      changed: false,
      unresolvedCollectionIDs: [],
      clientState: buildClientDbuffStateEntries(entity, { nowMs }),
    };
  }
  const previousValues = sourceMap.get(normalizedSourceKey) || new Map();
  const beforeSignature = buildCommandBurstStateSignature(entity);
  sourceMap.delete(normalizedSourceKey);
  if (sourceMap.size <= 0) {
    delete entity.commandBurstContinuousSources;
  }
  const unresolvedCollectionIDs = rebuildContinuousDbuffCollections(
    entity,
    new Set(previousValues.keys()),
    nowMs,
  );
  const afterSignature = buildCommandBurstStateSignature(entity);
  return {
    changed: beforeSignature !== afterSignature,
    unresolvedCollectionIDs,
    clientState: buildClientDbuffStateEntries(entity, { nowMs }),
  };
}

function resolveEntityCharacterID(entity) {
  if (!entity || entity.kind !== "ship") {
    return 0;
  }
  return toInt(
    entity.session && entity.session.characterID
      ? entity.session.characterID
      : entity.characterID ?? entity.pilotCharacterID,
    0,
  );
}

function resolveBurstAffinityGroupID(entity) {
  if (!entity || entity.kind !== "ship") {
    return 0;
  }
  const remoteRepairShowAffinityID = toInt(
    entity.remoteRepairBurstAffinityGroupID,
    0,
  );
  if (remoteRepairShowAffinityID > 0) {
    // The /rr presentation fleet is intentionally synthetic and has no real
    // fleet membership. Its dedicated marker is the only production bypass.
    return remoteRepairShowAffinityID;
  }
  return entity.commandBurstAffinityExplicit === true
    ? toInt(entity.commandBurstAffinityGroupID, 0)
    : 0;
}

function resolveBurstRecipientSurfaceDistance(
  sourceEntity,
  targetEntity,
  options = {},
) {
  if (Object.prototype.hasOwnProperty.call(options, "surfaceDistanceMeters")) {
    const explicitDistance = Number(options.surfaceDistanceMeters);
    return Number.isNaN(explicitDistance)
      ? Number.POSITIVE_INFINITY
      : explicitDistance;
  }
  if (typeof options.getSurfaceDistance === "function") {
    const resolvedDistance = Number(
      options.getSurfaceDistance(
        sourceEntity,
        targetEntity,
        options.nowMs,
      ),
    );
    return Number.isNaN(resolvedDistance)
      ? Number.POSITIVE_INFINITY
      : resolvedDistance;
  }
  return getSurfaceDistance(sourceEntity, targetEntity);
}

function isBurstRecipient(sourceEntity, targetEntity, rangeMeters, options = {}) {
  if (
    !sourceEntity ||
    !targetEntity ||
    targetEntity.kind !== "ship" ||
    !canEntitiesInteractLocally(sourceEntity, targetEntity)
  ) {
    return false;
  }
  const sameEntity =
    toInt(sourceEntity.itemID, 0) === toInt(targetEntity.itemID, 0);

  const sourceAffinityGroupID = resolveBurstAffinityGroupID(sourceEntity);
  const targetAffinityGroupID = resolveBurstAffinityGroupID(targetEntity);
  const sharesExplicitAffinity =
    !sameEntity &&
    sourceAffinityGroupID > 0 &&
    sourceAffinityGroupID === targetAffinityGroupID;

  const sourceCharacterID = resolveEntityCharacterID(sourceEntity);
  const targetCharacterID = resolveEntityCharacterID(targetEntity);
  const sharesFleet =
    !sameEntity &&
    !sharesExplicitAffinity &&
    sourceCharacterID > 0 &&
    targetCharacterID > 0 &&
    sourceCharacterID !== targetCharacterID &&
    isInSameFleet(sourceCharacterID, targetCharacterID);
  // A Phenomena Generator has no notion of "us": range and local scope are the
  // only things standing between it and any given hull.
  if (
    options.affectsAllShipsInRange !== true &&
    !sameEntity &&
    !sharesExplicitAffinity &&
    !sharesFleet
  ) {
    return false;
  }

  if (
    typeof options.isRecipientEligible === "function" &&
    options.isRecipientEligible(
      sourceEntity,
      targetEntity,
      options.nowMs,
    ) !== true
  ) {
    return false;
  }
  if (sameEntity) {
    return true;
  }

  const surfaceDistanceMeters = resolveBurstRecipientSurfaceDistance(
    sourceEntity,
    targetEntity,
    options,
  );

  return surfaceDistanceMeters <=
    Math.max(0, toFiniteNumber(rangeMeters, 0)) + 1;
}

function resolveCommandBurstRecipients(
  scene,
  sourceEntity,
  effectState,
  nowMs = null,
  options = {},
) {
  if (!scene || !sourceEntity || !effectState) {
    return [];
  }

  const rangeMeters = Math.max(0, toFiniteNumber(effectState.commandBurstRangeMeters, 0));
  const resolvedNowMs = nowMs == null
    ? typeof scene.getCurrentSimTimeMs === "function"
      ? scene.getCurrentSimTimeMs()
      : Date.now()
    : nowMs;
  const getSurfaceDistanceForRecipient =
    typeof options.getSurfaceDistance === "function"
      ? options.getSurfaceDistance
      : typeof scene.getEntitySurfaceDistance === "function"
        ? (source, target, commandNowMs) =>
          scene.getEntitySurfaceDistance(source, target)
        : getSurfaceDistance;
  const recipients = [];
  for (const entity of scene.dynamicEntities.values()) {
    if (!isBurstRecipient(sourceEntity, entity, rangeMeters, {
      nowMs: resolvedNowMs,
      getSurfaceDistance: getSurfaceDistanceForRecipient,
      isRecipientEligible: options.isRecipientEligible,
      affectsAllShipsInRange:
        effectState.commandBurstAffectsAllShipsInRange === true,
    })) {
      continue;
    }
    recipients.push(entity);
  }

  recipients.sort((left, right) => (
    toInt(left && left.itemID, 0) - toInt(right && right.itemID, 0)
  ));
  return recipients;
}

function collectModifierEntriesForItem(entity, targetItem, nowMs = null) {
  if (!entity || !targetItem) {
    return [];
  }

  const now = nowMs == null
    ? Date.now()
    : Math.max(0, toFiniteNumber(nowMs, Date.now()));
  const buckets = getCommandBurstBucketMap(entity, false);
  const historyByCollectionID = getTimedCommandBurstHistoryMap(entity, false);
  if (
    (!(buckets instanceof Map) || buckets.size <= 0) &&
    (!(historyByCollectionID instanceof Map) || historyByCollectionID.size <= 0)
  ) {
    return [];
  }

  const collectionIDs = new Set();
  if (buckets instanceof Map) {
    for (const collectionID of buckets.keys()) {
      const numericCollectionID = toInt(collectionID, 0);
      if (numericCollectionID > 0) {
        collectionIDs.add(numericCollectionID);
      }
    }
  }
  if (historyByCollectionID instanceof Map) {
    for (const collectionID of historyByCollectionID.keys()) {
      const numericCollectionID = toInt(collectionID, 0);
      if (numericCollectionID > 0) {
        collectionIDs.add(numericCollectionID);
      }
    }
  }

  const modifierEntries = [];
  for (const collectionID of [...collectionIDs].sort((left, right) => left - right)) {
    const collectionDefinition = getDbuffCollectionsByID().get(collectionID) || null;
    if (!collectionDefinition) {
      continue;
    }

    const aggregator = buckets instanceof Map
      ? buckets.get(collectionID) || buckets.get(String(collectionID)) || null
      : null;
    const trackedHistory = historyByCollectionID instanceof Map
      ? historyByCollectionID.get(collectionID) || null
      : null;
    const activeValues = [];
    if (Array.isArray(trackedHistory)) {
      for (const entry of trackedHistory) {
        const startsAtMs = toFiniteNumber(
          entry && entry.startsAtMs,
          Number.POSITIVE_INFINITY,
        );
        const expiresAtMs = toFiniteNumber(
          entry && entry.expiresAtMs,
          Number.NEGATIVE_INFINITY,
        );
        const value = Number(entry && entry.value);
        if (startsAtMs <= now && expiresAtMs >= now && Number.isFinite(value)) {
          activeValues.push(value);
        }
      }
    } else if (aggregator && Array.isArray(aggregator._sortedInputs)) {
      // Compatibility for runtime state created before timed history was added,
      // and for focused tests that construct aggregators directly.
      for (const [expiresAtMs, value] of aggregator._sortedInputs) {
        if (toFiniteNumber(expiresAtMs, -1) >= now && Number.isFinite(value)) {
          activeValues.push(value);
        }
      }
    }
    if (aggregator && Number.isFinite(aggregator._continuousInput)) {
      activeValues.push(aggregator._continuousInput);
    }
    if (activeValues.length <= 0) {
      continue;
    }

    const outputValue = collectionDefinition.aggregateMode === "Minimum"
      ? Math.min(...activeValues)
      : Math.max(...activeValues);
    collectDefinitionModifierEntries(
      modifierEntries,
      collectionDefinition,
      targetItem,
      outputValue,
    );
  }
  return modifierEntries;
}

function resolveCommandBurstActivation({
  characterID = 0,
  effectRecord,
  moduleItem,
  chargeItem = null,
  shipItem,
  skillMap = null,
  fittedItems = null,
  activeModuleContexts = null,
} = {}) {
  const definition = resolveCommandBurstDefinition(effectRecord);
  if (!definition) {
    return { matched: false };
  }
  if (!shipItem || !moduleItem) {
    return { matched: true, success: false, errorMsg: "UNSUPPORTED_MODULE" };
  }
  const carriesOwnBuffs = definition.carriesOwnBuffs === true;
  if (!carriesOwnBuffs) {
    if (!chargeItem) {
      return { matched: true, success: false, errorMsg: "NO_AMMO" };
    }
    if (!isChargeCompatibleWithModule(moduleItem.typeID, chargeItem.typeID)) {
      return { matched: true, success: false, errorMsg: "CHARGE_NOT_COMPATIBLE" };
    }
  }

  const effectiveModuleItem = buildNpcEffectiveModuleItem(moduleItem);
  const resolvedFittedItems = Array.isArray(fittedItems) ? fittedItems : [];
  const resolvedSkillMap = skillMap instanceof Map ? skillMap : new Map();
  const resolvedActiveModuleContexts = Array.isArray(activeModuleContexts)
    ? activeModuleContexts
    : [];
  const implantShipModifierEntries =
    toInt(characterID, 0) > 0
      ? getActiveImplantShipModifierEntries(characterID)
      : [];
  const implantLocationModifierSources =
    toInt(characterID, 0) > 0
      ? getActiveImplantLocationModifierSources(characterID)
      : [];
  const shipModifierAttributes = collectShipModifierAttributes(
    shipItem,
    resolvedSkillMap,
    resolvedActiveModuleContexts,
    {
      additionalDirectModifierEntries: implantShipModifierEntries,
    },
  );
  const moduleAttributes = buildLocationModifiedAttributeMap(
    effectiveModuleItem,
    shipItem,
    resolvedSkillMap,
    shipModifierAttributes,
    resolvedFittedItems,
    resolvedActiveModuleContexts,
    {
      excludeItemID: toInt(moduleItem && moduleItem.itemID, 0),
      additionalLocationModifierSources: implantLocationModifierSources,
    },
  );
  if (chargeItem) {
    applyOtherItemModifiersToAttributes(moduleAttributes, chargeItem);
  }

  const collectionValues = buildCollectionValuesFromAttributes(moduleAttributes);
  if (collectionValues.size <= 0) {
    return {
      matched: true,
      success: false,
      // With no charge in the picture an empty buff set means the module's own
      // warfare buff attributes are missing, not that the wrong charge is in it.
      errorMsg: carriesOwnBuffs ? "UNSUPPORTED_MODULE" : "CHARGE_NOT_COMPATIBLE",
    };
  }
  const runtimeFamily = resolveCommandBurstRuntimeFamily(
    definition,
    moduleItem,
    chargeItem,
    collectionValues,
  );

  return {
    matched: true,
    success: true,
    data: {
      runtimeAttrs: {
        capNeed: Math.max(0, round6(toFiniteNumber(moduleAttributes[ATTRIBUTE_CAPACITOR_NEED], 0))),
        durationMs: Math.max(1, round6(toFiniteNumber(moduleAttributes[ATTRIBUTE_DURATION], 0))),
        durationAttributeID: ATTRIBUTE_DURATION,
        reactivationDelayMs: Math.max(
          0,
          round6(toFiniteNumber(moduleAttributes[ATTRIBUTE_REACTIVATION_DELAY], 0)),
        ),
        maxGroupActive: Math.max(0, toInt(moduleAttributes[ATTRIBUTE_MAX_GROUP_ACTIVE], 0)),
        // Command bursts pay in charges and declare none of this; a Phenomena
        // Generator pays in isotopes, and the generic activation path only
        // consumes fuel it is told about here.
        fuelTypeID: Math.max(
          0,
          toInt(moduleAttributes[ATTRIBUTE_CONSUMPTION_TYPE], 0),
        ),
        // Fifth copy of the consumptionQuantity (714) expression that
        // runtime.js#roundModuleFuelQuantity repaired: round the bonused
        // quantity rather than truncating it, so a percentage chain landing on
        // 4.999999999999999 bills 5 isotopes and not 4.
        fuelPerActivation: roundToWholeUnits(
          moduleAttributes[ATTRIBUTE_CONSUMPTION_QUANTITY],
        ),
        weaponFamily: null,
        attributeOverrides: {
          ...moduleAttributes,
        },
        commandBurstSnapshot: {
          family: runtimeFamily,
          sourceFxGuid: definition.sourceFxGuid,
          targetFxGuid: definition.targetFxGuid,
          rangeMeters: Math.max(0, round6(toFiniteNumber(moduleAttributes[ATTRIBUTE_MAX_RANGE], 0))),
          durationMs: Math.max(1, round6(toFiniteNumber(moduleAttributes[ATTRIBUTE_DURATION], 0))),
          buffDurationMs: Math.max(
            1,
            round6(toFiniteNumber(moduleAttributes[ATTRIBUTE_BUFF_DURATION], 0)),
          ),
          reloadTimeMs: Math.max(0, round6(toFiniteNumber(moduleAttributes[ATTRIBUTE_RELOAD_TIME], 0))),
          collectionValues,
          moduleAttributes,
        },
      },
      effectStatePatch: {
        commandBurstEffect: true,
        commandBurstFamily: runtimeFamily,
        commandBurstSourceFxGuid: definition.sourceFxGuid,
        commandBurstTargetFxGuid: definition.targetFxGuid,
        commandBurstRangeMeters: Math.max(
          0,
          round6(toFiniteNumber(moduleAttributes[ATTRIBUTE_MAX_RANGE], 0)),
        ),
        commandBurstBuffDurationMs: Math.max(
          1,
          round6(toFiniteNumber(moduleAttributes[ATTRIBUTE_BUFF_DURATION], 0)),
        ),
        commandBurstReloadTimeMs: Math.max(
          0,
          round6(toFiniteNumber(moduleAttributes[ATTRIBUTE_RELOAD_TIME], 0)),
        ),
        commandBurstDbuffValues: collectionValues,
        commandBurstAffectsAllShipsInRange:
          definition.affectsAllShipsInRange === true,
        commandBurstCarriesOwnBuffs: carriesOwnBuffs,
        suppressStartSpecialFx: true,
        suppressStopSpecialFx: true,
      },
    },
  };
}

function refreshCommandBurstStaticData() {
  cachedDbuffCollectionsByID = null;
  return getDbuffCollectionsByID();
}

function setDbuffCollectionsForTests(entries = []) {
  cachedDbuffCollectionsByID = new Map(
    Array.from(entries, (entry) => [toInt(entry && entry.collectionID, 0), entry])
      .filter(([collectionID, entry]) => collectionID > 0 && entry),
  );
  return cachedDbuffCollectionsByID;
}

module.exports = {
  isCommandBurstEffectRecord,
  resolveCommandBurstDefinition,
  resolveCommandBurstActivation,
  resolveCommandBurstRecipients,
  applyTimedCommandBurstToEntity,
  setContinuousDbuffSource,
  clearContinuousDbuffSource,
  pruneExpiredCommandBursts,
  discardTimedCommandBurstHistoryBefore,
  getNextCommandBurstExpiryTime,
  buildClientDbuffStateEntries,
  collectModifierEntriesForItem,
  refreshCommandBurstStaticData,
  _testing: {
    createAggregator,
    getDbuffCollectionsByID,
    getTimedCommandBurstHistoryMap,
    buildCollectionValuesFromAttributes,
    buildCommandBurstStateSignature,
    getContinuousDbuffSourceMap,
    normalizeCollectionValueMap,
    setDbuffCollectionsForTests,
    moduleRequiresSkillType,
    getSurfaceDistance,
    resolveEntityCharacterID,
    resolveBurstAffinityGroupID,
    isBurstRecipient,
    resolveBurstRecipientSurfaceDistance,
    cloneVector,
  },
};
