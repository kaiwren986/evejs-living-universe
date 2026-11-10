"use strict";

const {
  toFiniteNumber,
} = require("../../../common/numbers");

const path = require("path");

const config = require(path.join(__dirname, "../../../config"));
const {
  currentFileTime,
  normalizeBigInt,
} = require(path.join(__dirname, "../../_shared/serviceHelpers"));
const {
  resolveCharacterAccountID,
  resolveOmegaLicenseState,
  getOmegaTrainingHistory,
} = require(path.join(__dirname, "../../newEdenStore/storeState"));
const { hasOmegaAt, getRateBoundaries } = require("../omegaTrainingIntervals");
const {
  getTypeAttributeValue,
} = require(path.join(__dirname, "../../fitting/liveFittingState"));
const {
  applyActiveImplantAttributeBonuses,
} = require(path.join(__dirname, "../../dogma/implants/activeImplantModifiers"));

const ATTRIBUTE_CHARISMA = 164;
const ATTRIBUTE_INTELLIGENCE = 165;
const ATTRIBUTE_MEMORY = 166;
const ATTRIBUTE_PERCEPTION = 167;
const ATTRIBUTE_WILLPOWER = 168;

const CLONE_STATE_ALPHA = 0;
const CLONE_STATE_OMEGA = 1;

const FILETIME_TICKS_PER_MINUTE = 600000000n;
const FILETIME_TICKS_PER_SECOND = 10000000n;
const DEFAULT_SKILL_RANK = 1;
const MAX_SKILL_LEVEL = 5;

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function normalizeSkillRank(value) {
  const numeric = toFiniteNumber(value, DEFAULT_SKILL_RANK);
  return numeric > 0 ? numeric : DEFAULT_SKILL_RANK;
}

function cloneValue(value) {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => cloneValue(entry));
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entryValue]) => [key, cloneValue(entryValue)]),
    );
  }
  return value;
}

function getSkillPointsForLevel(skillRank, level) {
  const normalizedLevel = Math.max(0, Math.min(MAX_SKILL_LEVEL, toInt(level, 0)));
  if (normalizedLevel <= 0) {
    return 0;
  }
  const normalizedRank = normalizeSkillRank(skillRank);
  return Math.ceil(
    normalizedRank * 250 * 2 ** (2.5 * (normalizedLevel - 1)),
  );
}

function getSkillLevelForPoints(skillRank, skillPoints) {
  const normalizedPoints = Math.max(0, toInt(skillPoints, 0));
  for (let level = MAX_SKILL_LEVEL; level >= 1; level -= 1) {
    if (normalizedPoints >= getSkillPointsForLevel(skillRank, level)) {
      return level;
    }
  }
  return 0;
}

function normalizeCharacterAttributes(characterRecord = {}) {
  const source =
    characterRecord && typeof characterRecord === "object"
      ? characterRecord.characterAttributes || {}
      : {};

  return applyActiveImplantAttributeBonuses({
    [ATTRIBUTE_CHARISMA]: toFiniteNumber(
      source[ATTRIBUTE_CHARISMA] ?? source.charisma,
      20,
    ),
    [ATTRIBUTE_INTELLIGENCE]: toFiniteNumber(
      source[ATTRIBUTE_INTELLIGENCE] ?? source.intelligence,
      20,
    ),
    [ATTRIBUTE_MEMORY]: toFiniteNumber(source[ATTRIBUTE_MEMORY] ?? source.memory, 20),
    [ATTRIBUTE_PERCEPTION]: toFiniteNumber(
      source[ATTRIBUTE_PERCEPTION] ?? source.perception,
      20,
    ),
    [ATTRIBUTE_WILLPOWER]: toFiniteNumber(
      source[ATTRIBUTE_WILLPOWER] ?? source.willpower,
      20,
    ),
  }, characterRecord);
}

function resolveCloneGrade(characterID, accountID = 0) {
  const numericAccountID =
    toInt(accountID, 0) || resolveCharacterAccountID(toInt(characterID, 0));
  const omegaState = resolveOmegaLicenseState(numericAccountID);
  return omegaState && omegaState.hasLicense
    ? CLONE_STATE_OMEGA
    : CLONE_STATE_ALPHA;
}

function getCloneTrainingMultiplier(characterID, accountID = 0, atFileTime = getNowFileTime()) {
  const id = toInt(accountID, 0) || resolveCharacterAccountID(toInt(characterID, 0));
  return hasOmegaAt(getOmegaTrainingHistory(id), normalizeBigInt(atFileTime, getNowFileTime()).toString()) ? 1 : 0.5;
}

function getPrimaryAttributeID(skillTypeID) {
  return toInt(getTypeAttributeValue(skillTypeID, "primaryAttribute"), 0);
}

function getSecondaryAttributeID(skillTypeID) {
  return toInt(getTypeAttributeValue(skillTypeID, "secondaryAttribute"), 0);
}

function getBaseSkillPointsPerMinute(characterRecord, skillTypeID, accountID = 0) {
  const primaryAttributeID = getPrimaryAttributeID(skillTypeID);
  const secondaryAttributeID = getSecondaryAttributeID(skillTypeID);
  const attributes = normalizeCharacterAttributes(characterRecord);
  const primaryValue = toFiniteNumber(attributes[primaryAttributeID], 0);
  const secondaryValue = toFiniteNumber(attributes[secondaryAttributeID], 0);
  const omegaSpPerMinute = primaryValue + secondaryValue / 2;
  return omegaSpPerMinute * getCloneTrainingMultiplier(characterRecord.characterID, accountID);
}

function getGlobalTrainingSpeedMultiplier() {
  const numeric = toFiniteNumber(config.skillTrainingSpeed, 1);
  return numeric > 0 ? numeric : 1;
}

function getEffectiveSkillPointsPerMinute(characterRecord, skillTypeID, accountID = 0) {
  return (
    getBaseSkillPointsPerMinute(characterRecord, skillTypeID, accountID) *
    getGlobalTrainingSpeedMultiplier()
  );
}

function getTrainingDurationFiletimeTicks(remainingSkillPoints, skillPointsPerMinute) {
  const normalizedRemainingSkillPoints = Math.max(0, toFiniteNumber(remainingSkillPoints, 0));
  const normalizedSpPerMinute = toFiniteNumber(skillPointsPerMinute, 0);
  if (normalizedRemainingSkillPoints <= 0 || normalizedSpPerMinute <= 0) {
    return 0n;
  }

  const durationTicks = Math.floor(
    (normalizedRemainingSkillPoints / normalizedSpPerMinute) *
      Number(FILETIME_TICKS_PER_MINUTE),
  );
  return BigInt(Math.max(0, durationTicks));
}

/**
 * The points a training has at a time: from its start at its rate, and from each change of rate on (a skill
 * accelerator running out, or before now beginning: `rateChanges`, from getTrainingAcrossBoosters) at the rate from
 * then (characterskills/skill_training.py get_skill_points_trained_at_sample_time, 147 to 167).
 */
function getEstimatedSkillPointsAtTime(
  startSkillPoints,
  destinationSkillPoints,
  startFileTime,
  sampleFileTime,
  skillPointsPerMinute,
  rateChanges = [],
) {
  const startTicks = normalizeBigInt(startFileTime, 0n);
  const sampleTicks = normalizeBigInt(sampleFileTime, 0n);
  const fromSkillPoints = Math.max(0, toInt(startSkillPoints, 0));
  const toSkillPoints = Math.max(fromSkillPoints, toInt(destinationSkillPoints, fromSkillPoints));
  if (sampleTicks <= startTicks) {
    return fromSkillPoints;
  }

  const normalizedSpPerMinute = toFiniteNumber(skillPointsPerMinute, 0);
  if (normalizedSpPerMinute <= 0) {
    return fromSkillPoints;
  }

  let gained = 0;
  let from = startTicks;
  let rate = normalizedSpPerMinute;
  for (const change of Array.isArray(rateChanges) ? rateChanges : []) {
    const at = normalizeBigInt(change && change.at, 0n);
    if (at <= from) {
      rate = toFiniteNumber(change && change.skillPointsPerMinute, rate);
      continue;
    }
    if (at >= sampleTicks) {
      break;
    }
    gained += (Number(at - from) / Number(FILETIME_TICKS_PER_MINUTE)) * rate;
    from = at;
    rate = toFiniteNumber(change && change.skillPointsPerMinute, rate);
  }
  gained += (Number(sampleTicks - from) / Number(FILETIME_TICKS_PER_MINUTE)) * rate;
  const gainedPoints = Math.floor(gained);
  return Math.max(
    fromSkillPoints,
    Math.min(toSkillPoints, fromSkillPoints + Math.max(0, gainedPoints)),
  );
}

/** characterskills/attribute.py ATTRIBUTEBONUS_BY_ATTRIBUTEID: a booster type's bonus to each attribute, by its attribute's name. */
const ATTRIBUTE_BONUS_NAMES = Object.freeze({
  [ATTRIBUTE_CHARISMA]: "charismaBonus",
  [ATTRIBUTE_INTELLIGENCE]: "intelligenceBonus",
  [ATTRIBUTE_MEMORY]: "memoryBonus",
  [ATTRIBUTE_PERCEPTION]: "perceptionBonus",
  [ATTRIBUTE_WILLPOWER]: "willpowerBonus",
});

/**
 * The character's boosters that add to an attribute, each with when it began and runs out and what it adds
 * (characterskills/skill_accelerators.py add_booster: the type's bonus attributes): those running, and those run out
 * whose records are still kept (a record stays on the character until the next booster is taken).
 */
function getSkillAcceleratorRecords(characterRecord) {
  const out = [];
  const records = characterRecord && Array.isArray(characterRecord.boosters) ? characterRecord.boosters : [];
  for (const record of records) {
    const typeID = toInt(record && (record.boosterTypeID ?? record.typeID), 0);
    const expiryTime = normalizeBigInt(record && record.expiryTime, 0n);
    if (typeID <= 0 || expiryTime <= 0n) {
      continue;
    }
    const bonus = {};
    for (const [attributeID, name] of Object.entries(ATTRIBUTE_BONUS_NAMES)) {
      const value = toFiniteNumber(getTypeAttributeValue(typeID, name), 0);
      if (value !== 0) {
        bonus[attributeID] = value;
      }
    }
    if (Object.keys(bonus).length === 0) {
      continue;
    }
    const duration = toInt(record.boosterDuration, 0);
    const startTime = normalizeBigInt(
      record.startTime,
      duration > 0 ? expiryTime - BigInt(duration) * 10000n : 0n,
    );
    out.push({ startTime, expiryTime, bonus });
  }
  return out;
}

/**
 * The character's attributes at a time (ClientCharacterSkillInterface.get_character_attribute_at_time, the server's
 * side of it): as they are now, which holds what each booster running now adds, less what one not running then adds,
 * and with what one running then and not now added.
 */
function getAttributesAtFileTime(characterRecord, atFileTime) {
  const now = getNowFileTime();
  const at = normalizeBigInt(atFileTime, now);
  const attributes = normalizeCharacterAttributes(characterRecord);
  for (const booster of getSkillAcceleratorRecords(characterRecord)) {
    const runningNow = booster.startTime <= now && booster.expiryTime > now;
    const runningThen = booster.startTime <= at && booster.expiryTime > at;
    if (runningNow === runningThen) {
      continue;
    }
    for (const [attributeID, value] of Object.entries(booster.bonus)) {
      attributes[attributeID] = toFiniteNumber(attributes[attributeID], 0) + (runningThen ? value : -value);
    }
  }
  return attributes;
}

/** The rate at a skill at a time (getEffectiveSkillPointsPerMinute, with the attributes then). */
function getEffectiveSkillPointsPerMinuteAt(characterRecord, skillTypeID, accountID, atFileTime) {
  const attributes = getAttributesAtFileTime(characterRecord, atFileTime);
  const primaryValue = toFiniteNumber(attributes[getPrimaryAttributeID(skillTypeID)], 0);
  const secondaryValue = toFiniteNumber(attributes[getSecondaryAttributeID(skillTypeID)], 0);
  return (
    (primaryValue + secondaryValue / 2) *
    getCloneTrainingMultiplier(characterRecord.characterID, accountID, atFileTime) *
    getGlobalTrainingSpeedMultiplier()
  );
}

/**
 * characterskills/skill_training.py _get_training_time_given_skill_points_to_train (115 to 130), the calculator the
 * client shares with the server: the time the points take from `startFileTime` at the rate then, the rate changing
 * where a skill accelerator runs out (or, before now, began). Answers the time, the rate it began at, and each change
 * with its time (a FILETIME's digits) and the rate from then, for the points reckoned at a time between.
 */
function getTrainingAcrossBoosters(characterRecord, skillTypeID, accountID, remainingSkillPoints, startFileTime) {
  const start = normalizeBigInt(startFileTime, getNowFileTime());
  const points = Math.max(0, toFiniteNumber(remainingSkillPoints, 0));
  const startRate = getEffectiveSkillPointsPerMinuteAt(characterRecord, skillTypeID, accountID, start);
  const rateChanges = [];
  if (points <= 0 || startRate <= 0) {
    return { durationTicks: 0n, skillPointsPerMinute: startRate, rateChanges };
  }
  const changeTimes = [...new Set(
    [...getSkillAcceleratorRecords(characterRecord)
      .flatMap((booster) => [booster.startTime, booster.expiryTime])
      .filter((time) => time > start)
      .map((time) => time.toString()),
    ...getRateBoundaries(getOmegaTrainingHistory(toInt(accountID, 0) || resolveCharacterAccountID(characterRecord.characterID)),
      start.toString(), "18446744073709551615")],
  )]
    .map((time) => BigInt(time))
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  let rate = startRate;
  let accumulatedPoints = 0;
  let at = start;
  for (const change of changeTimes) {
    const pointsUntilChange = (Number(change - at) / Number(FILETIME_TICKS_PER_MINUTE)) * rate;
    if (accumulatedPoints + pointsUntilChange >= points) {
      break;
    }
    const nextRate = getEffectiveSkillPointsPerMinuteAt(characterRecord, skillTypeID, accountID, change);
    if (nextRate <= 0) {
      break;
    }
    accumulatedPoints += pointsUntilChange;
    at = change;
    rate = nextRate;
    rateChanges.push({ at: change.toString(), skillPointsPerMinute: rate });
  }
  const remainingTicks = Math.max(
    0,
    Math.floor(((points - accumulatedPoints) / rate) * Number(FILETIME_TICKS_PER_MINUTE)),
  );
  return { durationTicks: (at - start) + BigInt(remainingTicks), skillPointsPerMinute: startRate, rateChanges };
}

function buildFiletimeString(value) {
  return normalizeBigInt(value, currentFileTime()).toString();
}

let nowOverride = null;

function getNowFileTime() {
  if (typeof nowOverride === "function") {
    return normalizeBigInt(nowOverride(), currentFileTime());
  }
  return currentFileTime();
}

function setNowFileTimeOverride(fn) {
  nowOverride = typeof fn === "function" ? fn : null;
}

function resetNowFileTimeOverride() {
  nowOverride = null;
}

module.exports = {
  ATTRIBUTE_CHARISMA,
  ATTRIBUTE_INTELLIGENCE,
  ATTRIBUTE_MEMORY,
  ATTRIBUTE_PERCEPTION,
  ATTRIBUTE_WILLPOWER,
  CLONE_STATE_ALPHA,
  CLONE_STATE_OMEGA,
  FILETIME_TICKS_PER_MINUTE,
  FILETIME_TICKS_PER_SECOND,
  MAX_SKILL_LEVEL,
  buildFiletimeString,
  cloneValue,
  getBaseSkillPointsPerMinute,
  getCloneTrainingMultiplier,
  getEffectiveSkillPointsPerMinute,
  getEffectiveSkillPointsPerMinuteAt,
  getEstimatedSkillPointsAtTime,
  getGlobalTrainingSpeedMultiplier,
  getNowFileTime,
  getTrainingAcrossBoosters,
  getPrimaryAttributeID,
  getSecondaryAttributeID,
  getSkillLevelForPoints,
  getSkillPointsForLevel,
  getTrainingDurationFiletimeTicks,
  normalizeCharacterAttributes,
  normalizeSkillRank,
  resolveCloneGrade,
  setNowFileTimeOverride,
  resetNowFileTimeOverride,
};
