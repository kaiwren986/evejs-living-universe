"use strict";

const {
  toNumber,
} = require("../../../common/numbers");

const path = require("path");

const {
  TABLE,
  readStaticTable,
} = require(path.join(__dirname, "../../_shared/referenceData"));
const {
  buildDict,
  buildKeyVal,
  buildList,
  buildFiletimeLong,
} = require(path.join(__dirname, "../../_shared/serviceHelpers"));
const {
  getCharacterRecord,
  updateCharacterRecord,
} = require(path.join(__dirname, "../../character/characterState"));
const {
  consumeInventoryItemQuantity,
  findItemById,
} = require(path.join(__dirname, "../../inventory/itemStore"));
const {
  resolveItemByTypeID,
} = require(path.join(__dirname, "../../inventory/itemTypeRegistry"));
const {
  getAttributeIDByNames,
  getTypeDogmaRecord,
} = require(path.join(__dirname, "../../fitting/liveFittingState"));
const {
  applyBoosterSkillModifiersToAttributes,
} = require(path.join(__dirname, "./boosterSkillRuntime"));
const {
  applyActiveImplantLocationModifiersToAttributes,
} = require(path.join(__dirname, "../../dogma/implants/activeImplantModifiers"));
const {
  bumpDogmaInvalidationVersion,
} = require(path.join(__dirname, "../../character/dogmaInvalidationVersion"));

const BOOSTER_GROUP_ID = 303;
const BOOSTER_CATEGORY_ID = 20;
const WINDOWS_EPOCH_OFFSET = 116444736000000000n;

const ATTRIBUTE_BOOSTER_DURATION =
  getAttributeIDByNames("boosterDuration") || 330;
const ATTRIBUTE_BOOSTERNESS =
  getAttributeIDByNames("boosterness") || 1087;
const ATTRIBUTE_LAST_INJECTION =
  getAttributeIDByNames("boosterLastInjectionDatetime") || 2422;
const ATTRIBUTE_MAX_CHAR_AGE_HOURS =
  getAttributeIDByNames("boosterMaxCharAgeHours") || 1647;

let nowMsOverride = null;
const expiryTimers = new Map();

function getNowMs() {
  if (nowMsOverride) {
    try {
      const overridden = Number(nowMsOverride());
      if (Number.isFinite(overridden)) {
        return overridden;
      }
    } catch (_error) {
      // ignored: keep production behavior if a test clock becomes unavailable.
    }
  }
  return Date.now();
}

function setNowMsOverride(override) {
  nowMsOverride = typeof override === "function" ? override : null;
}

function resetNowMsOverride() {
  clearExpiryTimers();
  nowMsOverride = null;
}

function toInt(value, fallback = 0) {
  const numeric = Number.parseInt(String(value), 10);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function getTypeAttribute(attributes, attributeID, fallback = null) {
  if (!attributes || typeof attributes !== "object") {
    return fallback;
  }
  if (Object.prototype.hasOwnProperty.call(attributes, String(attributeID))) {
    return attributes[String(attributeID)];
  }
  if (Object.prototype.hasOwnProperty.call(attributes, attributeID)) {
    return attributes[attributeID];
  }
  return fallback;
}

function msToFileTime(ms = getNowMs()) {
  return BigInt(Math.trunc(toNumber(ms, getNowMs()))) * 10000n + WINDOWS_EPOCH_OFFSET;
}

function fileTimeToMs(value) {
  const fileTime = normalizeFileTime(value, 0n);
  if (fileTime <= 0n) {
    return null;
  }
  const ms = Number((fileTime - WINDOWS_EPOCH_OFFSET) / 10000n);
  return Number.isFinite(ms) ? ms : null;
}

function normalizeFileTime(value, fallback = 0n) {
  try {
    if (typeof value === "bigint") {
      return value;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return BigInt(Math.trunc(value));
    }
    if (typeof value === "string" && value.trim() !== "") {
      return BigInt(value);
    }
    if (value && typeof value === "object" && value.type === "long") {
      return normalizeFileTime(value.value, fallback);
    }
  } catch (error) {
    return fallback;
  }
  return fallback;
}

function getDogmaRoot() {
  return readStaticTable(TABLE.TYPE_DOGMA) || {};
}

function getEffectType(effectID) {
  const root = getDogmaRoot();
  return root.effectTypesByID && root.effectTypesByID[String(effectID)]
    ? root.effectTypesByID[String(effectID)]
    : null;
}

function isBoosterType(typeID) {
  const itemType = resolveItemByTypeID(typeID);
  if (!itemType) {
    return false;
  }
  return (
    Number(itemType.groupID) === BOOSTER_GROUP_ID ||
    Number(itemType.categoryID) === BOOSTER_CATEGORY_ID
  );
}

function normalizeChance(value) {
  const numeric = toNumber(value, 0);
  if (numeric <= 0) {
    return 0;
  }
  if (numeric > 1 && numeric <= 100) {
    return Math.min(1, numeric / 100);
  }
  return Math.min(1, numeric);
}

function getRandomFraction(options = {}) {
  const random = typeof options.random === "function"
    ? Number(options.random())
    : Math.random();
  return Number.isFinite(random) ? Math.max(0, Math.min(1, random)) : 0;
}

function getBoosterTypeInfo(typeID) {
  const numericTypeID = toInt(typeID, 0);
  const record = getTypeDogmaRecord(numericTypeID);
  if (numericTypeID <= 0 || !record || !record.attributes) {
    return null;
  }

  const attributes = record.attributes;
  const durationMs = toInt(
    getTypeAttribute(attributes, ATTRIBUTE_BOOSTER_DURATION, 0),
    0,
  );
  const boosterness = toInt(
    getTypeAttribute(attributes, ATTRIBUTE_BOOSTERNESS, 0),
    0,
  );
  const maxCharAgeHours = toNumber(
    getTypeAttribute(attributes, ATTRIBUTE_MAX_CHAR_AGE_HOURS, 0),
    0,
  );

  if (!isBoosterType(numericTypeID) || (durationMs <= 0 && maxCharAgeHours <= 0)) {
    return null;
  }

  return {
    typeID: numericTypeID,
    durationMs,
    boosterness,
    maxCharAgeHours,
    lastInjectionLimitMs: parseLimitDate(
      getTypeAttribute(attributes, ATTRIBUTE_LAST_INJECTION, null),
    ),
    attributes,
    effects: Array.isArray(record.effects) ? record.effects.map((effectID) => toInt(effectID, 0)).filter(Boolean) : [],
  };
}

function getBoosterSideEffectIDs(typeInfo, options = {}) {
  if (!typeInfo || !Array.isArray(typeInfo.effects)) {
    return [];
  }

  const sideEffectIDs = [];
  for (const effectID of typeInfo.effects) {
    const effect = getEffectType(effectID);
    const chanceAttributeID = toInt(effect && effect.fittingUsageChanceAttributeID, 0);
    if (chanceAttributeID <= 0) {
      continue;
    }

    const chance = normalizeChance(getTypeAttribute(
      options.effectiveAttributes || typeInfo.attributes,
      chanceAttributeID,
      0,
    ));
    if (chance <= 0) {
      continue;
    }

    if (getRandomFraction(options) < chance) {
      sideEffectIDs.push(effectID);
    }
  }
  return sideEffectIDs;
}

function parseLimitDate(value) {
  if (value === undefined || value === null) {
    return null;
  }

  if (value && typeof value === "object" && value.type === "long") {
    return parseLimitDate(value.value);
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) {
      return null;
    }
    if (value > 100000000000000) {
      return fileTimeToMs(value);
    }
    if (value > 1000000000000) {
      return Math.trunc(value);
    }
    if (value > 1000 && value < 1000000) {
      return Math.trunc(value * 86400000);
    }
    return null;
  }

  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (trimmed === "") {
    return null;
  }

  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
    return parseLimitDate(Number(trimmed));
  }

  const dotDate = trimmed.match(
    /^(\d{4})\.(\d{2})\.(\d{2})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?$/,
  );
  if (dotDate) {
    return Date.UTC(
      Number(dotDate[1]),
      Number(dotDate[2]) - 1,
      Number(dotDate[3]),
      Number(dotDate[4] || 0),
      Number(dotDate[5] || 0),
      Number(dotDate[6] || 0),
    );
  }

  const timestamp = Date.parse(trimmed);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function getCharacterCreatedAtMs(characterRecord) {
  if (!characterRecord || typeof characterRecord !== "object") {
    return null;
  }
  return (
    fileTimeToMs(characterRecord.createDateTime) ??
    fileTimeToMs(characterRecord.startDateTime) ??
    parseLimitDate(characterRecord.createdAt) ??
    parseLimitDate(characterRecord.createdDate)
  );
}

function getBoosterAgeLimitRemainingMs(typeInfo, characterRecord, nowMs) {
  const maxCharAgeHours = toNumber(typeInfo && typeInfo.maxCharAgeHours, 0);
  if (maxCharAgeHours <= 0) {
    return null;
  }
  const createdAtMs = getCharacterCreatedAtMs(characterRecord);
  if (createdAtMs === null) {
    return null;
  }
  return Math.max(0, Math.trunc(
    createdAtMs + maxCharAgeHours * 60 * 60 * 1000 - nowMs,
  ));
}

function resolveBoosterDurationMs(typeInfo, characterRecord, nowMs, effectiveAttributes = null) {
  if (!typeInfo) {
    return 0;
  }
  const baseDurationMs = Math.max(
    0,
    toInt(
      getTypeAttribute(
        effectiveAttributes || typeInfo.attributes,
        ATTRIBUTE_BOOSTER_DURATION,
        typeInfo.durationMs,
      ),
      typeInfo.durationMs,
    ),
  );
  const remainingAgeMs = getBoosterAgeLimitRemainingMs(typeInfo, characterRecord, nowMs);
  if (remainingAgeMs === null) {
    return baseDurationMs;
  }
  if (baseDurationMs <= 0) {
    return remainingAgeMs;
  }
  return Math.min(baseDurationMs, remainingAgeMs);
}

function normalizeBoosterRecord(record, options = {}) {
  if (!record || typeof record !== "object") {
    return null;
  }

  const boosterTypeID = toInt(record.boosterTypeID ?? record.typeID, 0);
  const typeInfo = getBoosterTypeInfo(boosterTypeID);
  if (!typeInfo) {
    return null;
  }

  const nowFileTime = normalizeFileTime(options.nowFileTime, msToFileTime());
  const expiryTime = normalizeFileTime(record.expiryTime, 0n);
  if (expiryTime <= nowFileTime) {
    return null;
  }

  const boosterID = toInt(record.boosterID ?? record.itemID ?? record.sourceItemID, boosterTypeID);
  return {
    boosterID,
    itemID: boosterID,
    typeID: boosterTypeID,
    boosterTypeID,
    boosterness: toInt(record.boosterness ?? record.slot, typeInfo.boosterness),
    slot: toInt(record.slot ?? record.boosterness, typeInfo.boosterness),
    boosterDuration: toInt(record.boosterDuration, typeInfo.durationMs),
    startTime: String(normalizeFileTime(record.startTime, expiryTime - BigInt(typeInfo.durationMs) * 10000n)),
    expiryTime: String(expiryTime),
    sideEffectIDs: Array.isArray(record.sideEffectIDs)
      ? record.sideEffectIDs.map((effectID) => toInt(effectID, 0)).filter(Boolean)
      : [],
  };
}

function normalizeActiveBoosters(boosters, options = {}) {
  const active = [];
  for (const record of Array.isArray(boosters) ? boosters : []) {
    const normalized = normalizeBoosterRecord(record, options);
    if (normalized) {
      active.push(normalized);
    }
  }
  return active.sort((left, right) => {
    const leftSlot = toInt(left.boosterness, 0);
    const rightSlot = toInt(right.boosterness, 0);
    if (leftSlot !== rightSlot) {
      return leftSlot - rightSlot;
    }
    return toInt(left.boosterTypeID, 0) - toInt(right.boosterTypeID, 0);
  });
}

function getActiveBoostersForCharacter(characterID, options = {}) {
  const charData = getCharacterRecord(characterID);
  if (!charData) {
    return [];
  }
  return normalizeActiveBoosters(charData.boosters, options);
}

function buildBoosterPayload(record) {
  return buildKeyVal([
    ["boosterID", Number(record.boosterID)],
    ["itemID", Number(record.itemID)],
    ["typeID", Number(record.typeID)],
    ["boosterTypeID", Number(record.boosterTypeID)],
    ["boosterness", Number(record.boosterness)],
    ["slot", Number(record.slot)],
    ["boosterSlot", Number(record.slot)],
    ["boosterDuration", Number(record.boosterDuration)],
    ["startTime", buildFiletimeLong(record.startTime)],
    ["expiryTime", buildFiletimeLong(record.expiryTime)],
    ["sideEffectIDs", buildList(record.sideEffectIDs || [])],
  ]);
}

// The client caches GetBoosters and its Consume menu does not check expiryTime.
// Re-arm on a fetch (including login) and on consumption so persisted boosters
// also refresh the client after a server restart. These timers only deliver live
// notifications; the persisted expiry remains authoritative for all reads.
function clearExpiryTimers() {
  for (const { handle } of expiryTimers.values()) clearTimeout(handle);
  expiryTimers.clear();
}

function scheduleBoosterExpiryNotification(characterID) {
  const numericCharacterID = toInt(characterID, 0);
  const boosters = getActiveBoostersForCharacter(numericCharacterID);
  const expiryMs = boosters.reduce(
    (earliest, booster) => Math.min(earliest, fileTimeToMs(booster.expiryTime)),
    Infinity,
  );
  const previous = expiryTimers.get(numericCharacterID);
  if (previous && previous.expiryMs === expiryMs) return;
  if (previous) clearTimeout(previous.handle);
  expiryTimers.delete(numericCharacterID);
  if (!Number.isFinite(expiryMs)) return;

  const handle = setTimeout(() => {
    expiryTimers.delete(numericCharacterID);
    // Long-lived accelerators may exceed Node's maximum timer delay.
    if (getNowMs() < expiryMs) {
      scheduleBoosterExpiryNotification(numericCharacterID);
      return;
    }
    // Nothing is written when a booster runs out, so the fittings built with
    // it are told here (dogmaInvalidationVersion).
    bumpDogmaInvalidationVersion();
    const { findSessionByCharacterID } = require("../../chat/sessionRegistry");
    const session = findSessionByCharacterID(numericCharacterID);
    if (!session || typeof session.sendNotification !== "function") return;
    scheduleBoosterExpiryNotification(numericCharacterID);
    try {
      const { syncCharacterDogmaState } = require("../../dogma/brain/characterBrainRuntime");
      session.sendNotification("OnServerBoostersChanged", "charid", []);
      syncCharacterDogmaState(session, numericCharacterID, { refreshLiveShip: true });
    } catch (error) {
      const log = require("../../../utils/logger");
      log.warn(`[Boosters] Failed to notify expiry char=${numericCharacterID}: ${error.message}`);
    }
  }, Math.max(1, Math.min(2_147_483_647, expiryMs - getNowMs())));
  if (typeof handle.unref === "function") handle.unref();
  expiryTimers.set(numericCharacterID, { handle, expiryMs });
}

function buildCharacterBoostersDict(characterID, options = {}) {
  const boosters = getActiveBoostersForCharacter(characterID, options);
  scheduleBoosterExpiryNotification(characterID);
  return buildDict(
    boosters.map((record) => [
      Number(record.boosterTypeID),
      buildBoosterPayload(record),
    ]),
  );
}

function validateBoosterItem(characterID, itemID, locationID = null, options = {}) {
  const item = findItemById(itemID);
  if (!item) {
    return { success: false, errorMsg: "ITEM_NOT_FOUND" };
  }
  if (Number(item.ownerID) !== Number(characterID)) {
    return { success: false, errorMsg: "ITEM_NOT_OWNED" };
  }
  if (
    locationID !== null &&
    locationID !== undefined &&
    Number(locationID) > 0 &&
    Number(item.locationID) !== Number(locationID)
  ) {
    return { success: false, errorMsg: "ITEM_LOCATION_MISMATCH" };
  }

  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : getNowMs();
  const typeInfo = getBoosterTypeInfo(item.typeID);
  const nativeLimit = typeInfo?.lastInjectionLimitMs;
  const injectionLimitMs = nativeLimit != null && nowMs > nativeLimit &&
    require("../../seasons/gallenteCrateRewards").ignoresInjectionDeadline(item.typeID) ? null : nativeLimit;
  const validation = validateBoosterType(characterID, typeInfo, nowMs, injectionLimitMs);
  return validation.success ? { ...validation, item } : validation;
}

function validateBoosterType(characterID, typeInfo, nowMs, injectionLimitMs) {
  if (!typeInfo) {
    return { success: false, errorMsg: "NOT_A_CONSUMABLE_BOOSTER" };
  }

  if (injectionLimitMs != null && nowMs > injectionLimitMs) {
    return { success: false, errorMsg: "BOOSTER_EXPIRED" };
  }

  const maxCharAgeHours = toNumber(typeInfo.maxCharAgeHours, 0);
  let characterRecord = null;
  if (maxCharAgeHours > 0) {
    characterRecord = getCharacterRecord(characterID);
    const createdAtMs = getCharacterCreatedAtMs(characterRecord);
    if (createdAtMs === null) {
      return { success: false, errorMsg: "BOOSTER_CHARACTER_AGE_UNKNOWN" };
    }
    if (nowMs - createdAtMs >= maxCharAgeHours * 60 * 60 * 1000) {
      return { success: false, errorMsg: "BOOSTER_CHARACTER_TOO_OLD" };
    }
  }

  return {
    success: true,
    typeInfo,
    characterRecord,
  };
}

function prepareBoosterActivation(characterID, itemID, validation, nowMs, options = {}) {
  const nowFileTime = msToFileTime(nowMs);
  const skillModifiedAttributes = applyBoosterSkillModifiersToAttributes(
    validation.typeInfo.attributes,
    characterID,
  );
  const effectiveAttributes = applyActiveImplantLocationModifiersToAttributes(
    skillModifiedAttributes,
    {
      typeID: validation.typeInfo.typeID,
      groupID: BOOSTER_GROUP_ID,
    },
    characterID,
    { includeBoosters: false },
  );
  const boosterDurationMs = resolveBoosterDurationMs(
    validation.typeInfo,
    validation.characterRecord || getCharacterRecord(characterID),
    nowMs,
    effectiveAttributes,
  );
  if (boosterDurationMs <= 0) {
    return { success: false, errorMsg: "NOT_A_CONSUMABLE_BOOSTER" };
  }
  if (boosterSlotOccupied(characterID, validation.typeInfo.boosterness, nowFileTime)) {
    return {
      success: false,
      errorMsg: "BOOSTER_SLOT_OCCUPIED",
    };
  }

  const record = {
    boosterID: itemID,
    itemID,
    typeID: validation.typeInfo.typeID,
    boosterTypeID: validation.typeInfo.typeID,
    boosterness: validation.typeInfo.boosterness,
    slot: validation.typeInfo.boosterness,
    boosterDuration: boosterDurationMs,
    startTime: String(nowFileTime),
    expiryTime: String(nowFileTime + BigInt(boosterDurationMs) * 10000n),
    sideEffectIDs: getBoosterSideEffectIDs(validation.typeInfo, {
      ...options,
      effectiveAttributes,
    }),
  };
  return { success: true, data: record };
}

function boosterSlotOccupied(characterID, slot, nowFileTime) {
  return slot > 0 && getActiveBoostersForCharacter(characterID, { nowFileTime })
    .some(record => Number(record.boosterness) === Number(slot));
}

function useBoosterItem(characterID, itemID, locationID = null, options = {}) {
  const numericCharacterID = toInt(characterID, 0);
  const numericItemID = toInt(itemID, 0);
  if (numericCharacterID <= 0 || numericItemID <= 0) {
    return { success: false, errorMsg: "ITEM_NOT_FOUND" };
  }
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : getNowMs();
  const validation = validateBoosterItem(numericCharacterID, numericItemID, locationID, { nowMs });
  if (!validation.success) return validation;
  const plan = prepareBoosterActivation(numericCharacterID, numericItemID, validation, nowMs, options);
  if (!plan.success) return plan;
  const consumeResult = consumeInventoryItemQuantity(numericItemID, 1, { removeContents: true });
  if (!consumeResult.success) return consumeResult;
  const record = plan.data;
  const nowFileTime = msToFileTime(nowMs);

  const updateResult = updateCharacterRecord(numericCharacterID, (charData) => {
    const active = normalizeActiveBoosters(charData.boosters, { nowFileTime });
    charData.boosters = [...active, record];
    return charData;
  });
  if (!updateResult.success) {
    return updateResult;
  }

  scheduleBoosterExpiryNotification(numericCharacterID);
  return {
    success: true,
    data: {
      booster: record,
      inventoryChanges: (
        consumeResult.data && Array.isArray(consumeResult.data.changes)
          ? consumeResult.data.changes
          : []
      ),
    },
  };
}

function prepareRedeemedBooster(characterID, tokenID, typeID, nowMs, injectionLimitMs) {
  const validation = validateBoosterType(characterID, getBoosterTypeInfo(typeID), nowMs, injectionLimitMs);
  return validation.success ? prepareBoosterActivation(characterID, tokenID, validation, nowMs) : validation;
}

function applyRedeemedBoosterOnce(characterID, receiptID, record) {
  const database = require("../../../gameStore");
  const character = getCharacterRecord(characterID);
  if (!character) return { success: false, errorMsg: "CHARACTER_NOT_FOUND" };
  const previous = character.boosterGrantReceipts?.[receiptID];
  if (previous !== undefined) {
    if (previous !== record.typeID) return { success: false, errorMsg: "BOOSTER_GRANT_CONFLICT" };
    return database.flushTableSync("characters");
  }
  const nowFileTime = msToFileTime(getNowMs());
  if (boosterSlotOccupied(characterID, record.boosterness, nowFileTime)) {
    return { success: false, errorMsg: "BOOSTER_SLOT_OCCUPIED" };
  }
  // Preserve training earned at the old rate before changing the character's
  // attributes. A retry with a character receipt never rebases it again.
  const queue = require("../training/skillQueueRuntime");
  const rebase = queue.prepareQueueForAttributeChange(characterID);
  if (!rebase.success) return rebase;
  for (const table of ["skills", "skillQueues"]) {
    const flushed = database.flushTableSync(table);
    if (!flushed.success) return flushed;
  }
  // An accepted but unapplied delivery starts at its first effect commit. A
  // cold retry of an already applied booster keeps the stored duration.
  const active = { ...record, startTime: String(nowFileTime),
    expiryTime: String(nowFileTime + BigInt(record.boosterDuration) * 10000n) };
  const updated = updateCharacterRecord(characterID, current => ({
    ...current,
    boosters: [...normalizeActiveBoosters(current.boosters, { nowFileTime }), active],
    boosterGrantReceipts: { ...current.boosterGrantReceipts, [receiptID]: record.typeID },
  }));
  if (!updated.success) return updated;
  return database.flushTableSync("characters");
}

function refreshRedeemedBooster(characterID) {
  scheduleBoosterExpiryNotification(characterID);
  require("../training/skillQueueRuntime").syncQueueAfterAttributeChange(characterID);
}

module.exports = {
  BOOSTER_CATEGORY_ID,
  BOOSTER_GROUP_ID,
  buildCharacterBoostersDict,
  buildBoosterPayload,
  getActiveBoostersForCharacter,
  getBoosterTypeInfo,
  normalizeActiveBoosters,
  useBoosterItem,
  prepareRedeemedBooster,
  applyRedeemedBoosterOnce,
  refreshRedeemedBooster,
  _testing: {
    clearExpiryTimers,
    setNowMsOverride,
    resetNowMsOverride,
  },
};
