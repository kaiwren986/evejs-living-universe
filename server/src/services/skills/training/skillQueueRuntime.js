"use strict";

const {
  toFiniteNumber,
} = require("../../../common/numbers");

const path = require("path");
const log = require(path.join(__dirname, "../../../utils/logger"));
const database = require(path.join(__dirname, "../../../gameStore"));

const {
  throwWrappedUserError,
} = require(path.join(__dirname, "../../../common/machoErrors"));
const {
  getCharacterRecord,
  updateCharacterRecord,
} = require(path.join(__dirname, "../../character/characterState"));
const {
  buildSkillRecord,
  getCharacterBaseSkillMap,
  getCharacterBaseSkills,
  getSkillMutationVersion,
  getSkillTypeByID,
  replaceCharacterSkillRecords,
} = require(path.join(__dirname, "../skillState"));
const {
  getRequiredSkillRequirements,
} = require(path.join(__dirname, "../../fitting/liveFittingState"));
const {
  resolveCharacterAccountID,
  getTrainingSlotsForAccount,
  getOmegaTrainingHistory,
} = require(path.join(__dirname, "../../newEdenStore/storeState"));
const {
  buildFiletimeLong,
  normalizeBigInt,
} = require(path.join(__dirname, "../../_shared/serviceHelpers"));
const { strVal } = require(path.join(
  __dirname,
  "../../../network/tcp/utils/marshal",
));
const {
  buildFiletimeString,
  cloneValue,
  FILETIME_TICKS_PER_SECOND,
  getEffectiveSkillPointsPerMinute,
  getEstimatedSkillPointsAtTime,
  getGlobalTrainingSpeedMultiplier,
  getNowFileTime,
  getSkillLevelForPoints,
  getSkillPointsForLevel,
  getTrainingAcrossBoosters,
} = require("./skillTrainingMath");
const {
  getAllQueueStates,
  getCharacterQueueState,
  getQueueMutationVersion,
  setCharacterQueueState,
} = require("./skillQueueState");
const {
  notifyFreeSkillPointsChanged,
  notifyMultipleCharacterTrainingUpdated,
  notifySkillDogmaAttributesChangedAsMultiEvent,
  notifySkillDogmaBrainChanged,
  notifySkillQueuePaused,
  notifySkillQueueSaved,
  notifySkillStateChanged,
} = require("./skillQueueNotifications");
const {
  ALPHA_MAX_TRAINING_SP,
  getAlphaTrainingCapBreakdown,
  getMaxTrainableLevelForClone,
  isSkillLevelRestrictedForClone,
  resolveCharacterCloneGrade,
} = require("./skillCloneRestrictions");
const {
  recordRecentSkillPointChanges,
} = require(path.join(__dirname, "../certificates/skillChangeTracker"));

const SKILLQUEUE_MAX_NUM_SKILLS = 150;
const SKILLQUEUE_TIME_LIMIT_TICKS = 10n * 365n * 24n * 60n * 60n * FILETIME_TICKS_PER_SECOND;

const SKILL_EVENT_TRAINING_COMPLETE = 37;
const SKILL_EVENT_TRAINING_CANCELLED = 38;
const SKILL_EVENT_QUEUE_TRAINING_COMPLETED = 53;
const SKILL_EVENT_FREE_SKILL_POINTS_USED = 307;
const DURABLE_COMPLETION_JOB_TYPE = "skill-queue.complete";
const DURABLE_COMPLETION_JOB_PREFIX = "skill-queue:";

const snapshotCache = new Map();
const schedulerHandles = new Map();
const durableJobIDs = new Map();
const durableScheduleLanes = new Map();
const slotChecks = new Map();
const slotTimers = new Map();
let enforcingTrainingSlots = false;
let durableScheduler = null;
let durableSchedulerGeneration = 0;
const DURABLE_SKILL_TABLES = Object.freeze([
  "characters",
  "skillQueues",
  "skills",
]);

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function buildKeyVal(entries) {
  return {
    type: "object",
    name: "utillib.KeyVal",
    args: {
      type: "dict",
      entries,
    },
  };
}

function buildDict(entries = []) {
  return {
    type: "dict",
    entries,
  };
}

function unwrapValue(value) {
  if (Buffer.isBuffer(value)) {
    return value.toString("utf8");
  }
  if (value && typeof value === "object") {
    if (Object.prototype.hasOwnProperty.call(value, "value")) {
      return unwrapValue(value.value);
    }
    if (value.type === "int" || value.type === "long") {
      return unwrapValue(value.value);
    }
  }
  return value;
}

function readBooleanKwarg(kwargs, key, fallback = false) {
  if (!kwargs) {
    return fallback;
  }

  if (kwargs.type === "dict" && Array.isArray(kwargs.entries)) {
  // A decoded dict key keeps the form the wire used, and the pause flags read here sit outside
  // the marshal string table, so they arrive as raw Buffers and a raw comparison
  // drops them. See the note on accountService.extractKwarg.
    const entry = kwargs.entries.find(
      ([entryKey]) => strVal(entryKey) === key,
    );
    if (!entry) {
      return fallback;
    }
    return Boolean(unwrapValue(entry[1]));
  }

  if (typeof kwargs === "object" && Object.prototype.hasOwnProperty.call(kwargs, key)) {
    return Boolean(unwrapValue(kwargs[key]));
  }

  return fallback;
}

function normalizeQueueInput(queueInfo) {
  if (!queueInfo) {
    return [];
  }

  const entries = [];
  const sourceEntries =
    queueInfo instanceof Map
      ? [...queueInfo.entries()]
      : queueInfo && queueInfo.type === "dict" && Array.isArray(queueInfo.entries)
        ? queueInfo.entries
        : Array.isArray(queueInfo)
          ? queueInfo.map((value, index) => [index, value])
          : Object.entries(queueInfo);

  for (const [rawPosition, rawValue] of sourceEntries) {
    const queuePosition = toInt(unwrapValue(rawPosition), -1);
    let normalizedValue = rawValue;
    if (
      Array.isArray(rawValue) &&
      rawValue.length >= 2 &&
      typeof rawValue[0] !== "string"
    ) {
      normalizedValue = {
        trainingTypeID: unwrapValue(rawValue[0]),
        trainingToLevel: unwrapValue(rawValue[1]),
      };
    }

    const typeID = toInt(
      unwrapValue(
        normalizedValue &&
          typeof normalizedValue === "object" &&
          !Array.isArray(normalizedValue)
          ? normalizedValue.trainingTypeID ?? normalizedValue.typeID
          : Array.isArray(normalizedValue)
            ? normalizedValue[0]
            : null,
      ),
      0,
    );
    const toLevel = toInt(
      unwrapValue(
        normalizedValue &&
          typeof normalizedValue === "object" &&
          !Array.isArray(normalizedValue)
          ? normalizedValue.trainingToLevel ?? normalizedValue.toLevel
          : Array.isArray(normalizedValue)
            ? normalizedValue[1]
            : null,
      ),
      0,
    );
    if (queuePosition < 0 || typeID <= 0 || toLevel <= 0) {
      continue;
    }
    entries.push({
      queuePosition,
      typeID,
      toLevel,
    });
  }

  return entries.sort((left, right) => left.queuePosition - right.queuePosition);
}

function getCharacterIDFromSession(session) {
  return toInt(
    session && (session.characterID || session.charid || session.userid),
    0,
  );
}

function getCharacterAccountID(characterID, session = null) {
  return (
    toInt(session && session.userid, 0) ||
    resolveCharacterAccountID(toInt(characterID, 0))
  );
}

function getAvailableTrainingSlotCount(accountID) {
  const numericAccountID = toInt(accountID, 0);
  let slotCount = 1;
  const now = getNowFileTime();
  const extraSlots = getTrainingSlotsForAccount(numericAccountID);
  for (const expiryValue of Object.values(extraSlots || {})) {
    const expiry = normalizeBigInt(expiryValue, 0n);
    if (expiry > now) {
      slotCount += 1;
    }
  }
  return slotCount;
}

function getActiveTrainingCharacterIDsForAccount(accountID) {
  const numericAccountID = toInt(accountID, 0);
  if (numericAccountID <= 0) {
    return [];
  }

  const activeCharacterIDs = [];
  for (const characterID of Object.keys(getAllQueueStates())) {
    const numericCharacterID = toInt(characterID, 0);
    if (numericCharacterID <= 0) {
      continue;
    }
    if (getCharacterAccountID(numericCharacterID) !== numericAccountID) {
      continue;
    }
    const state = getCharacterQueueState(numericCharacterID);
    if (state.active && state.queue.length > 0) {
      activeCharacterIDs.push(numericCharacterID);
    }
  }

  return activeCharacterIDs;
}

// One row of a pilot's skill history, with what Tranquility's rows have
// (recorded at three logins, GetSkillHistory(10): logDate, eventTypeID,
// skillTypeID, relativePoints, absolutePoints): when it happened, to the
// second, as every recorded date is; what happened; the points it gave the
// skill; and the points the skill had then.
function appendSkillHistoryEntry(
  characterID,
  eventTypeID,
  skillTypeID,
  relativePoints,
  absolutePoints,
  at = getNowFileTime(),
) {
  const wholeSecond =
    (normalizeBigInt(at, 0n) / FILETIME_TICKS_PER_SECOND) * FILETIME_TICKS_PER_SECOND;
  updateCharacterRecord(characterID, (record) => {
    const skillHistory = Array.isArray(record.skillHistory) ? [...record.skillHistory] : [];
    skillHistory.unshift({
      logDate: buildFiletimeString(wholeSecond),
      eventTypeID: toInt(eventTypeID, 0),
      skillTypeID: toInt(skillTypeID, 0),
      relativePoints: Math.max(0, toInt(relativePoints, 0)),
      absolutePoints: Math.max(0, toInt(absolutePoints, 0)),
    });
    return {
      ...record,
      skillHistory: skillHistory.slice(0, 100),
    };
  });
}

function updateFinishedSkills(characterID, finishedSkills = []) {
  updateCharacterRecord(characterID, (record) => ({
    ...record,
    finishedSkills: Array.isArray(finishedSkills) ? cloneValue(finishedSkills) : [],
  }));
}

function clearSnapshotCache(characterID) {
  if (characterID) {
    snapshotCache.delete(String(characterID));
    return;
  }
  snapshotCache.clear();
  slotChecks.clear();
  for (const watch of slotTimers.values()) clearTimeout(watch.timer);
  slotTimers.clear();
}

function getTotalSkillPoints(characterID) {
  return getCharacterBaseSkills(characterID)
    .reduce((total, record) => total + Math.max(0, toInt(record.trainedSkillPoints, 0)), 0);
}

// When an extra training queue (Multiple Character Training) runs out, the character with the
// fewest skill points has its queue paused (CCP, "Multiple character training",
// eveonline.com/news/view/multiple-character-training). saveQueue never lets more characters
// start than the account has queues, so an excess can only come from expiries since the last
// check: the most recent expired queues are the ones that ran out, and the lowest-SP characters
// pause at those times, the earliest expiry for the fewest points. This runs at the top of
// settlement, where skill points are finalized, so a pause takes effect at the expiry even
// when nothing read the queue then (the server was off). A timer at the next expiry tells the
// client then.
function enforceAccountTrainingSlots(accountID) {
  const numericAccountID = toInt(accountID, 0);
  if (numericAccountID <= 0 || enforcingTrainingSlots) {
    return;
  }
  const now = getNowFileTime();
  const slots = getTrainingSlotsForAccount(numericAccountID) || {};
  const fingerprint = JSON.stringify(slots);
  const checked = slotChecks.get(numericAccountID);
  if (
    checked &&
    checked.fingerprint === fingerprint &&
    checked.checkedAt <= now &&
    (checked.nextExpiry === null || checked.nextExpiry > now)
  ) {
    return;
  }

  enforcingTrainingSlots = true;
  try {
    const expiries = Object.values(slots).map((value) => normalizeBigInt(value, 0n));
    const running = expiries.filter((expiry) => expiry > now);
    const activeCharacterIDs = getActiveTrainingCharacterIDsForAccount(numericAccountID);
    const excess = activeCharacterIDs.length - (1 + running.length);
    if (excess > 0) {
      const pauseTimes = expiries
        .filter((expiry) => expiry <= now)
        .sort((left, right) => (left < right ? 1 : left > right ? -1 : 0))
        .slice(0, excess)
        .reverse();
      const paused = activeCharacterIDs
        .map((characterID) => ({ characterID, points: getTotalSkillPoints(characterID) }))
        .sort((left, right) => left.points - right.points || left.characterID - right.characterID)
        .slice(0, excess);
      paused.forEach(({ characterID }, index) => {
        const startTime = normalizeBigInt(
          getCharacterQueueState(characterID).activeStartTime,
          0n,
        );
        let atTime = pauseTimes[index] === undefined ? now : pauseTimes[index];
        if (atTime < startTime) atTime = startTime;
        abortTraining(characterID, { atTime });
        log.info(
          `[SkillQueue] character ${characterID}: training paused at ${atTime} when an ` +
            `extra training queue of account ${numericAccountID} ran out`,
        );
      });
    }
    const nextExpiry = running.length > 0
      ? running.reduce((least, expiry) => (expiry < least ? expiry : least))
      : null;
    slotChecks.set(numericAccountID, { fingerprint, checkedAt: now, nextExpiry });
    watchTrainingSlotExpiry(numericAccountID, nextExpiry);
  } finally {
    enforcingTrainingSlots = false;
  }
}

function watchTrainingSlotExpiry(accountID, nextExpiry) {
  const existing = slotTimers.get(accountID);
  if (existing && existing.at === nextExpiry) {
    return;
  }
  if (existing) {
    clearTimeout(existing.timer);
    slotTimers.delete(accountID);
  }
  if (nextExpiry === null) {
    return;
  }
  const diffMs = Number((nextExpiry - getNowFileTime()) / 10000n);
  const timer = setTimeout(() => {
    slotTimers.delete(accountID);
    slotChecks.delete(accountID);
    try {
      enforceAccountTrainingSlots(accountID);
    } catch (error) {
      log.warn(`[SkillQueue] training slot check failed account=${accountID}: ${error.message}`);
    }
  }, Math.max(1000, Math.min(diffMs + 100, 2147483647)));
  if (typeof timer.unref === "function") {
    timer.unref();
  }
  slotTimers.set(accountID, { at: nextExpiry, timer });
}

function getSkillRecordForProjection(characterID, skillMap, typeID, options = {}) {
  const existingSkillRecord = skillMap.get(typeID);
  if (existingSkillRecord) {
    return cloneValue(existingSkillRecord);
  }

  if (options.allowSynthetic !== true) {
    return null;
  }

  const skillType = getSkillTypeByID(typeID);
  if (!skillType) {
    return null;
  }

  return buildSkillRecord(characterID, skillType, 0);
}

function buildSatisfiedSkillRecord(characterID, skillRecord, toLevel, skillPoints) {
  const nextSkillPoints = Math.max(0, toInt(skillPoints, 0));
  const nextSkillLevel = getSkillLevelForPoints(skillRecord.skillRank, nextSkillPoints);
  return {
    ...cloneValue(skillRecord),
    skillLevel: nextSkillLevel,
    trainedSkillLevel: nextSkillLevel,
    effectiveSkillLevel: nextSkillLevel,
    skillPoints: nextSkillPoints,
    trainedSkillPoints: nextSkillPoints,
    inTraining: false,
    trainingStartSP: nextSkillPoints,
    trainingDestinationSP: nextSkillPoints,
    trainingStartTime: null,
    trainingEndTime: null,
  };
}

function buildModifierCacheEntry(entry, typeKeys = ["typeID"]) {
  if (!entry || typeof entry !== "object") {
    return {
      typeID: toInt(entry, 0),
    };
  }

  const typeID = toInt(
    typeKeys.map((key) => entry[key]).find((value) => toInt(value, 0) > 0),
    0,
  );
  return {
    typeID,
    itemID: toInt(entry.itemID ?? entry.implantID ?? entry.boosterID, 0),
    slot: toInt(entry.slot ?? entry.implantness ?? entry.boosterness, 0),
    startTime: entry.startTime ? String(entry.startTime) : null,
    expiryTime: entry.expiryTime ? String(entry.expiryTime) : null,
    sideEffectIDs: Array.isArray(entry.sideEffectIDs)
      ? entry.sideEffectIDs.map((effectID) => toInt(effectID, 0)).filter(Boolean)
      : [],
  };
}

function sortModifierCacheEntries(left, right) {
  return (
    toInt(left.slot, 0) - toInt(right.slot, 0) ||
    toInt(left.typeID, 0) - toInt(right.typeID, 0) ||
    toInt(left.itemID, 0) - toInt(right.itemID, 0)
  );
}

function buildTrainingModifierCacheToken(characterRecord) {
  const now = getNowFileTime();
  const implants = (Array.isArray(characterRecord && characterRecord.implants)
    ? characterRecord.implants
    : [])
    .map((entry) => buildModifierCacheEntry(entry, ["typeID", "implantTypeID"]))
    .filter((entry) => entry.typeID > 0)
    .sort(sortModifierCacheEntries);
  const boosters = (Array.isArray(characterRecord && characterRecord.boosters)
    ? characterRecord.boosters
    : [])
    .map((entry) => buildModifierCacheEntry(entry, ["boosterTypeID", "typeID"]))
    .filter((entry) => {
      if (entry.typeID <= 0) {
        return false;
      }
      const expiryTime = normalizeBigInt(entry.expiryTime, 0n);
      return expiryTime <= 0n || expiryTime > now;
    })
    .sort(sortModifierCacheEntries);
  return {
    implants,
    boosters,
  };
}

function buildQueueCacheKey(characterRecord, characterID) {
  return JSON.stringify([
    getQueueMutationVersion(),
    getSkillMutationVersion(),
    getGlobalTrainingSpeedMultiplier(),
    characterRecord && characterRecord.freeSkillPoints,
    characterRecord && characterRecord.characterAttributes,
    buildTrainingModifierCacheToken(characterRecord),
    getOmegaTrainingHistory(getCharacterAccountID(characterID)),
  ]);
}

function persistSkillMap(characterID, skillMap) {
  return replaceCharacterSkillRecords(
    characterID,
    [...skillMap.values()].map((record) => cloneValue(record)),
  );
}

function buildProjectedQueueEntries(characterID, characterRecord, queueState, skillMap, accountID) {
  const entries = [];
  if (!queueState.queue.length) {
    return {
      entries,
      queueEndTime: null,
      projectedSkillMap: new Map(
        [...skillMap.entries()].map(([typeID, record]) => [typeID, cloneValue(record)]),
      ),
    };
  }

  const projectedSkillMap = new Map(
    [...skillMap.entries()].map(([typeID, record]) => [typeID, cloneValue(record)]),
  );
  const queueActive = queueState.active === true;
  let nextStartTime = queueActive
    ? normalizeBigInt(queueState.activeStartTime, getNowFileTime())
    : null;

  for (let index = 0; index < queueState.queue.length; index += 1) {
    const entry = queueState.queue[index];
    const skillRecord = getSkillRecordForProjection(characterID, projectedSkillMap, entry.typeID);
    if (!skillRecord) {
      continue;
    }

    const trainingStartSP =
      toInt(skillRecord.trainedSkillLevel, 0) === entry.toLevel - 1
        ? Math.max(
            getSkillPointsForLevel(skillRecord.skillRank, entry.toLevel - 1),
            toInt(skillRecord.trainedSkillPoints, 0),
          )
        : getSkillPointsForLevel(skillRecord.skillRank, entry.toLevel - 1);
    const trainingDestinationSP = getSkillPointsForLevel(skillRecord.skillRank, entry.toLevel);
    // Each level from where the one before ends, the rate changing where a skill accelerator runs out on the way, as
    // the shared calculator reckons it (skillTrainingMath.getTrainingAcrossBoosters).
    const across = queueActive
      ? getTrainingAcrossBoosters(
          { ...characterRecord, characterID },
          entry.typeID,
          accountID,
          trainingDestinationSP - trainingStartSP,
          nextStartTime,
        )
      : null;
    const skillPointsPerMinute = across
      ? across.skillPointsPerMinute
      : getEffectiveSkillPointsPerMinute(
          {
            ...characterRecord,
            characterID,
          },
          entry.typeID,
          accountID,
        );
    const durationTicks = across ? across.durationTicks : 0n;
    const trainingStartTime = queueActive ? nextStartTime : null;
    const trainingEndTime = queueActive && trainingStartTime !== null
      ? trainingStartTime + durationTicks
      : null;

    entries.push({
      queuePosition: index,
      trainingTypeID: entry.typeID,
      trainingToLevel: entry.toLevel,
      trainingStartSP,
      trainingDestinationSP,
      trainingStartTime,
      trainingEndTime,
      skillPointsPerMinute,
      rateChanges: across ? across.rateChanges : [],
    });

    projectedSkillMap.set(
      entry.typeID,
      buildSatisfiedSkillRecord(
        characterID,
        skillRecord,
        entry.toLevel,
        trainingDestinationSP,
      ),
    );

    if (queueActive) {
      nextStartTime = trainingEndTime;
    }
  }

  return {
    entries,
    queueEndTime:
      entries.length > 0 ? entries[entries.length - 1].trainingEndTime : null,
    projectedSkillMap,
  };
}

function validateQueueEntries(characterID, characterRecord, queueEntries) {
  if (queueEntries.length > SKILLQUEUE_MAX_NUM_SKILLS) {
    throwWrappedUserError("QueueTooManySkills", {
      num: SKILLQUEUE_MAX_NUM_SKILLS,
    });
  }

  const skillMap = getCharacterBaseSkillMap(characterID);
  const projectedLevels = new Map(
    [...skillMap.entries()].map(([typeID, record]) => [
      typeID,
      {
        level: toInt(record.trainedSkillLevel, 0),
        points: toInt(record.trainedSkillPoints, 0),
        rank: toFiniteNumber(record.skillRank, 1),
      },
    ]),
  );

  const normalizedQueueState = {
    queue: queueEntries.map((entry) => ({
      typeID: entry.typeID,
      toLevel: entry.toLevel,
    })),
    active: true,
    activeStartTime: buildFiletimeString(getNowFileTime()),
  };
  const projectedQueue = buildProjectedQueueEntries(
    characterID,
    characterRecord,
    normalizedQueueState,
    skillMap,
    getCharacterAccountID(characterID),
  );
  const queueStartTime = normalizeBigInt(normalizedQueueState.activeStartTime, 0n);
  if (
    projectedQueue.queueEndTime &&
    projectedQueue.queueEndTime - queueStartTime > SKILLQUEUE_TIME_LIMIT_TICKS
  ) {
    throwWrappedUserError("QueueTooLong");
  }

  for (const entry of queueEntries) {
    const skillRecord = getSkillRecordForProjection(
      characterID,
      skillMap,
      entry.typeID,
    );
    if (!skillRecord) {
      throwWrappedUserError("QueueSkillNotUploaded");
    }
    if (entry.toLevel > 5) {
      throwWrappedUserError("QueueCannotTrainPastMaximumLevel");
    }
    if (
      isSkillLevelRestrictedForClone(entry.typeID, entry.toLevel, {
        characterID,
      })
    ) {
      throwWrappedUserError("QueueCannotTrainOmegaRestrictedSkill", {
        skillID: entry.typeID,
      });
    }

    const projectedState = projectedLevels.get(entry.typeID) || {
      level: 0,
      points: 0,
      rank: toFiniteNumber(skillRecord.skillRank, 1),
    };
    if (projectedState.level >= entry.toLevel) {
      throwWrappedUserError("QueueCannotTrainPreviouslyTrainedSkills");
    }
    if (projectedState.level < entry.toLevel - 1) {
      throwWrappedUserError("QueueCannotPlaceSkillLevelsOutOfOrder");
    }

    for (const requirement of getRequiredSkillRequirements(entry.typeID)) {
      const requirementState = projectedLevels.get(requirement.skillTypeID) || {
        level: 0,
      };
      if (toInt(requirementState.level, 0) < toInt(requirement.level, 0)) {
        throwWrappedUserError("QueueCannotPlaceSkillBeforeRequirements");
      }
    }

    projectedLevels.set(entry.typeID, {
      level: entry.toLevel,
      points: getSkillPointsForLevel(projectedState.rank, entry.toLevel),
      rank: projectedState.rank,
    });
  }
}

// options.untilTime settles only up to that moment (a pause at an MCT expiry); by default up
// to now, after the account's training-slot check.
function settleCharacterTraining(characterID, options = {}) {
  const numericCharacterID = toInt(characterID, 0);
  const untilTime = options.untilTime === undefined
    ? null
    : normalizeBigInt(options.untilTime, getNowFileTime());
  if (numericCharacterID <= 0) {
    return {
      settled: false,
      changedSkills: [],
      queueState: getCharacterQueueState(numericCharacterID),
    };
  }

  const characterRecord = getCharacterRecord(numericCharacterID);
  if (!characterRecord) {
    return {
      settled: false,
      changedSkills: [],
      queueState: getCharacterQueueState(numericCharacterID),
    };
  }

  const accountID = getCharacterAccountID(numericCharacterID);
  if (untilTime === null) {
    enforceAccountTrainingSlots(accountID);
  }
  const queueState = getCharacterQueueState(numericCharacterID);
  const skillMap = getCharacterBaseSkillMap(numericCharacterID);
  const finishedSkills = [];
  const changedSkills = [];
  const recentSkillPointChanges = [];
  let queueDirty = false;
  let skillsDirty = false;
  const now = untilTime === null ? getNowFileTime() : untilTime;

  while (queueState.queue.length > 0) {
    const projectedQueue = buildProjectedQueueEntries(
      numericCharacterID,
      characterRecord,
      queueState,
      skillMap,
      accountID,
    );
    const currentEntry = projectedQueue.entries[0];
    if (!currentEntry) {
      break;
    }

    const currentSkillRecord = getSkillRecordForProjection(
      numericCharacterID,
      skillMap,
      currentEntry.trainingTypeID,
    );
    if (!currentSkillRecord) {
      queueState.queue.shift();
      queueState.active = queueState.queue.length > 0;
      queueState.activeStartTime =
        queueState.active && queueState.queue.length > 0
          ? buildFiletimeString(now)
          : null;
      queueDirty = true;
      continue;
    }

    const alreadySatisfied =
      toInt(currentSkillRecord.trainedSkillLevel, 0) >= currentEntry.trainingToLevel ||
      toInt(currentSkillRecord.trainedSkillPoints, 0) >= currentEntry.trainingDestinationSP;
    if (alreadySatisfied) {
      queueState.queue.shift();
      queueState.active = queueState.queue.length > 0;
      queueState.activeStartTime =
        queueState.active && queueState.queue.length > 0
          ? buildFiletimeString(now)
          : null;
      queueDirty = true;
      continue;
    }

    if (!queueState.active || !currentEntry.trainingEndTime || currentEntry.trainingEndTime > now) {
      break;
    }

    const completedRecord = buildSatisfiedSkillRecord(
      numericCharacterID,
      currentSkillRecord,
      currentEntry.trainingToLevel,
      currentEntry.trainingDestinationSP,
    );
    skillMap.set(currentEntry.trainingTypeID, completedRecord);
    changedSkills.push(cloneValue(completedRecord));
    recentSkillPointChanges.push({
      typeID: currentEntry.trainingTypeID,
      pointChange:
        Math.max(0, toInt(currentEntry.trainingDestinationSP, 0)) -
        Math.max(0, toInt(currentSkillRecord.trainedSkillPoints, 0)),
    });
    finishedSkills.push({
      skillTypeID: currentEntry.trainingTypeID,
      level: currentEntry.trainingToLevel,
    });
    // The row is of the moment the training ended, not of the moment this
    // server came to it: Tranquility's rows of two levels trained one after
    // the other are the second one's training time apart, to the second.
    appendSkillHistoryEntry(
      numericCharacterID,
      queueState.queue.length > 1
        ? SKILL_EVENT_QUEUE_TRAINING_COMPLETED
        : SKILL_EVENT_TRAINING_COMPLETE,
      currentEntry.trainingTypeID,
      Math.max(0, toInt(currentEntry.trainingDestinationSP, 0)) -
        Math.max(0, toInt(currentSkillRecord.trainedSkillPoints, 0)),
      currentEntry.trainingDestinationSP,
      currentEntry.trainingEndTime,
    );

    queueState.queue.shift();
    queueState.active = queueState.queue.length > 0;
    queueState.activeStartTime = queueState.active
      ? buildFiletimeString(currentEntry.trainingEndTime)
      : null;
    queueDirty = true;
    skillsDirty = true;
  }

  if (skillsDirty) {
    persistSkillMap(numericCharacterID, skillMap);
  }

  if (queueDirty) {
    setCharacterQueueState(numericCharacterID, queueState);
    clearSnapshotCache(numericCharacterID);
  }

  if (finishedSkills.length > 0) {
    updateFinishedSkills(numericCharacterID, finishedSkills);
    recordRecentSkillPointChanges(numericCharacterID, recentSkillPointChanges);
    notifySkillStateChanged(numericCharacterID, changedSkills, {
      timeStamp: buildFiletimeString(getNowFileTime()),
    });
    const updatedProjection = buildProjectedQueueEntries(
      numericCharacterID,
      characterRecord,
      queueState,
      skillMap,
      accountID,
    );
    notifySkillQueueSaved(numericCharacterID, updatedProjection.entries);
    if (!queueState.active || queueState.queue.length === 0) {
      notifySkillQueuePaused(numericCharacterID);
    }
  }

  return {
    settled: queueDirty || skillsDirty,
    changedSkills,
    finishedSkills,
    queueState,
  };
}

function buildSkillRecordProjection(characterID, snapshotEntry, baseSkillMap) {
  const skillRecord = getSkillRecordForProjection(
    characterID,
    baseSkillMap,
    snapshotEntry.trainingTypeID,
  );
  if (!skillRecord) {
    return null;
  }

  const now = getNowFileTime();
  const estimatedPoints = snapshotEntry.trainingStartTime && snapshotEntry.trainingEndTime
    ? getEstimatedSkillPointsAtTime(
        snapshotEntry.trainingStartSP,
        snapshotEntry.trainingDestinationSP,
        snapshotEntry.trainingStartTime,
        now,
        snapshotEntry.skillPointsPerMinute,
        snapshotEntry.rateChanges,
      )
    : snapshotEntry.trainingStartSP;
  const estimatedLevel = getSkillLevelForPoints(skillRecord.skillRank, estimatedPoints);

  return {
    ...cloneValue(skillRecord),
    skillLevel: estimatedLevel,
    trainedSkillLevel: estimatedLevel,
    effectiveSkillLevel: estimatedLevel,
    skillPoints: estimatedPoints,
    trainedSkillPoints: estimatedPoints,
    inTraining: true,
    trainingStartSP: snapshotEntry.trainingStartSP,
    trainingDestinationSP: snapshotEntry.trainingDestinationSP,
    trainingStartTime: buildFiletimeString(snapshotEntry.trainingStartTime),
    trainingEndTime: buildFiletimeString(snapshotEntry.trainingEndTime),
  };
}

function getQueueSnapshot(characterID, options = {}) {
  const numericCharacterID = toInt(characterID, 0);
  if (numericCharacterID <= 0) {
    return {
      characterID: 0,
      queueEntries: [],
      queuePayload: {
        type: "list",
        items: [],
      },
      queueEndTime: null,
      currentEntry: null,
      active: false,
      freeSkillPoints: 0,
      projectedSkills: [],
      projectedSkillMap: new Map(),
    };
  }

  // options.settleUntil: the snapshot of a queue paused at that moment (abortTraining atTime).
  const settleUntil = options.settleUntil;
  settleCharacterTraining(
    numericCharacterID,
    settleUntil === undefined ? {} : { untilTime: settleUntil },
  );
  const characterRecord = getCharacterRecord(numericCharacterID) || {};
  const cacheKey = buildQueueCacheKey(characterRecord, numericCharacterID);
  const cached = snapshotCache.get(String(numericCharacterID));
  const now = getNowFileTime();
  if (
    settleUntil === undefined &&
    cached &&
    cached.cacheKey === cacheKey &&
    (!cached.nextBoundary || cached.nextBoundary > now)
  ) {
    const snapshot = cloneValue(cached.snapshot);
    const projectedSkillMap = new Map(
      (cached.projectedSkills || []).map((record) => [record.typeID, cloneValue(record)]),
    );
    if (snapshot.currentEntry && snapshot.active) {
      const liveProjection = buildSkillRecordProjection(
        numericCharacterID,
        {
          ...snapshot.currentEntry,
          trainingStartTime: normalizeBigInt(snapshot.currentEntry.trainingStartTime, 0n),
          trainingEndTime: normalizeBigInt(snapshot.currentEntry.trainingEndTime, 0n),
        },
        getCharacterBaseSkillMap(numericCharacterID),
      );
      if (liveProjection) {
        projectedSkillMap.set(liveProjection.typeID, liveProjection);
      }
    }
    return {
      ...snapshot,
      projectedSkillMap,
      projectedSkills: [...projectedSkillMap.values()].map((record) => cloneValue(record)),
    };
  }

  const accountID = getCharacterAccountID(numericCharacterID);
  const queueState = getCharacterQueueState(numericCharacterID);
  const skillMap = getCharacterBaseSkillMap(numericCharacterID);
  const projection = buildProjectedQueueEntries(
    numericCharacterID,
    characterRecord,
    queueState,
    skillMap,
    accountID,
  );
  const queueEntries = projection.entries.map((entry) => ({
    queuePosition: entry.queuePosition,
    trainingTypeID: entry.trainingTypeID,
    trainingToLevel: entry.trainingToLevel,
    trainingStartSP: entry.trainingStartSP,
    trainingDestinationSP: entry.trainingDestinationSP,
    trainingStartTime: entry.trainingStartTime
      ? buildFiletimeString(entry.trainingStartTime)
      : null,
    trainingEndTime: entry.trainingEndTime ? buildFiletimeString(entry.trainingEndTime) : null,
  }));
  const projectedSkillMap = new Map(
    getCharacterBaseSkills(numericCharacterID).map((record) => [record.typeID, record]),
  );
  const currentEntry = projection.entries[0] || null;
  if (currentEntry) {
    const projectedRecord = buildSkillRecordProjection(
      numericCharacterID,
      currentEntry,
      skillMap,
    );
    if (projectedRecord) {
      projectedSkillMap.set(projectedRecord.typeID, projectedRecord);
    }
  }

  const projectedSkills = [...projectedSkillMap.values()].map((record) => cloneValue(record));
  const snapshot = {
    characterID: numericCharacterID,
    accountID,
    active: queueState.active && queueEntries.length > 0,
    queueEntries,
    queuePayload: {
      type: "list",
      items: queueEntries.map((entry) =>
        buildKeyVal([
          ["trainingStartSP", entry.trainingStartSP],
          ["queuePosition", entry.queuePosition],
          ["trainingTypeID", entry.trainingTypeID],
          ["trainingDestinationSP", entry.trainingDestinationSP],
          [
            "trainingEndTime",
            entry.trainingEndTime ? buildFiletimeLong(entry.trainingEndTime) : null,
          ],
          [
            "trainingStartTime",
            entry.trainingStartTime ? buildFiletimeLong(entry.trainingStartTime) : null,
          ],
          ["trainingToLevel", entry.trainingToLevel],
        ]),
      ),
    },
    queueEndTime:
      queueEntries.length > 0 ? queueEntries[queueEntries.length - 1].trainingEndTime : null,
    currentEntry:
      currentEntry && queueEntries.length > 0
        ? {
            ...queueEntries[0],
            skillPointsPerMinute: currentEntry.skillPointsPerMinute,
            rateChanges: currentEntry.rateChanges || [],
          }
        : null,
    freeSkillPoints: Math.max(0, toInt(characterRecord.freeSkillPoints, 0)),
    projectedSkills,
    projectedSkillMap,
  };

  if (settleUntil === undefined) {
    snapshotCache.set(String(numericCharacterID), {
      cacheKey,
      nextBoundary: currentEntry && currentEntry.trainingEndTime ? currentEntry.trainingEndTime : null,
      snapshot: cloneValue({
        ...snapshot,
        projectedSkillMap: undefined,
      }),
      projectedSkills: cloneValue(projectedSkills),
    });
  }

  return snapshot;
}

function buildRebasedTrainingRecord(characterID, currentEntry, skillRecord, atTime = getNowFileTime()) {
  const trainingStartTime = normalizeBigInt(currentEntry.trainingStartTime, 0n);
  const trainingEndTime = normalizeBigInt(currentEntry.trainingEndTime, 0n);
  const trainingStartSP = toInt(currentEntry.trainingStartSP, 0);
  const trainingDestinationSP = toInt(currentEntry.trainingDestinationSP, trainingStartSP);
  const estimatedPoints = trainingStartTime > 0n && trainingEndTime > 0n
    ? getEstimatedSkillPointsAtTime(
        trainingStartSP,
        trainingDestinationSP,
        trainingStartTime,
        atTime,
        currentEntry.skillPointsPerMinute,
        currentEntry.rateChanges,
      )
    : trainingStartSP;
  const nextSkillPoints = Math.max(
    trainingStartSP,
    Math.min(trainingDestinationSP, toInt(estimatedPoints, trainingStartSP)),
  );
  const nextSkillLevel = getSkillLevelForPoints(skillRecord.skillRank, nextSkillPoints);

  return {
    ...cloneValue(skillRecord),
    skillLevel: nextSkillLevel,
    trainedSkillLevel: nextSkillLevel,
    effectiveSkillLevel: nextSkillLevel,
    skillPoints: nextSkillPoints,
    trainedSkillPoints: nextSkillPoints,
    inTraining: false,
    trainingStartSP: nextSkillPoints,
    trainingDestinationSP,
    trainingStartTime: null,
    trainingEndTime: null,
  };
}

function cloneSkillMap(skillMap) {
  return new Map(
    [...skillMap.entries()].map(([typeID, record]) => [typeID, cloneValue(record)]),
  );
}

function skillProgressChanged(previousRecord, nextRecord) {
  if (!previousRecord || !nextRecord) {
    return Boolean(nextRecord);
  }
  return (
    toInt(previousRecord.trainedSkillPoints, 0) !==
      toInt(nextRecord.trainedSkillPoints, 0) ||
    toInt(previousRecord.skillPoints, 0) !== toInt(nextRecord.skillPoints, 0) ||
    toInt(previousRecord.trainedSkillLevel, 0) !==
      toInt(nextRecord.trainedSkillLevel, 0) ||
    toInt(previousRecord.skillLevel, 0) !== toInt(nextRecord.skillLevel, 0)
  );
}

function sameQueueEntry(left, right) {
  return (
    left &&
    right &&
    toInt(left.typeID, 0) === toInt(right.typeID, 0) &&
    toInt(left.toLevel, 0) === toInt(right.toLevel, 0)
  );
}

function rebaseActiveTrainingProgress(characterID, options = {}) {
  const numericCharacterID = toInt(characterID, 0);
  if (numericCharacterID <= 0) {
    return {
      success: false,
      active: false,
      changed: false,
      errorMsg: "CHARACTER_NOT_FOUND",
    };
  }

  const snapshot = options.snapshot || getQueueSnapshot(numericCharacterID);
  const currentEntry = snapshot.currentEntry;
  if (!snapshot.active || !currentEntry) {
    clearSnapshotCache(numericCharacterID);
    return {
      success: true,
      active: false,
      changed: false,
      snapshot,
    };
  }

  const skillMap = getCharacterBaseSkillMap(numericCharacterID);
  const previousSkillMap = cloneSkillMap(skillMap);
  const skillRecord = getSkillRecordForProjection(
    numericCharacterID,
    skillMap,
    currentEntry.trainingTypeID,
  );
  if (!skillRecord) {
    clearSnapshotCache(numericCharacterID);
    return {
      success: false,
      active: true,
      changed: false,
      errorMsg: "SKILL_NOT_FOUND",
      snapshot,
      previousSkillMap,
    };
  }

  const rebasedRecord = buildRebasedTrainingRecord(
    numericCharacterID,
    currentEntry,
    skillRecord,
    options.atTime === undefined ? getNowFileTime() : options.atTime,
  );
  const changed = skillProgressChanged(
    previousSkillMap.get(currentEntry.trainingTypeID),
    rebasedRecord,
  );

  skillMap.set(currentEntry.trainingTypeID, rebasedRecord);
  persistSkillMap(numericCharacterID, skillMap);

  if (options.resetActiveStartTime !== false) {
    const queueState = getCharacterQueueState(numericCharacterID);
    if (queueState.active && queueState.queue.length > 0) {
      queueState.activeStartTime = buildFiletimeString(getNowFileTime());
      setCharacterQueueState(numericCharacterID, queueState);
    }
  }
  clearSnapshotCache(numericCharacterID);

  return {
    success: true,
    active: true,
    changed,
    snapshot,
    previousSkillMap,
    rebasedSkill: cloneValue(rebasedRecord),
  };
}

function prepareQueueForAttributeChange(characterID, options = {}) {
  const numericCharacterID = toInt(characterID, 0);
  if (numericCharacterID <= 0) {
    return {
      success: false,
      active: false,
      errorMsg: "CHARACTER_NOT_FOUND",
    };
  }

  return rebaseActiveTrainingProgress(numericCharacterID, options);
}

function syncQueueAfterAttributeChange(characterID, options = {}) {
  const numericCharacterID = toInt(characterID, 0);
  if (numericCharacterID <= 0) {
    return getQueueSnapshot(numericCharacterID);
  }

  clearSnapshotCache(numericCharacterID);
  const snapshot = getQueueSnapshot(numericCharacterID);
  const emitNotifications = options.emitNotifications !== false;
  if (emitNotifications) {
    notifySkillQueueSaved(numericCharacterID, snapshot.queueEntries);
    if (!snapshot.active) {
      notifySkillQueuePaused(numericCharacterID);
    }
  }
  if (options.schedule !== false) scheduleQueueCompletion(numericCharacterID);
  notifyMultipleCharacterTrainingUpdated(getCharacterAccountID(numericCharacterID));
  return snapshot;
}

async function refreshAccountEntitlement(accountID) {
  let affected = false;
  for (const [key, state] of Object.entries(getAllQueueStates())) {
    const characterID = toInt(key, 0);
    if (!characterID || !state?.queue?.length || getCharacterAccountID(characterID) !== Number(accountID)) continue;
    affected = true;
    // Historical entitlement intervals already preserve the rate before the
    // change, including a cold overdue expiry. Do not rebase it at today's rate.
    syncQueueAfterAttributeChange(characterID, { schedule: false });
    await scheduleQueueCompletion(characterID);
  }
  for (const table of affected ? DURABLE_SKILL_TABLES : []) {
    const result = database.flushTableSync(table);
    if (!result?.success) throw new Error(result?.errorMsg || "SKILL_ENTITLEMENT_REFRESH_FAILED");
  }
}

function clearLocalQueueTimer(characterID) {
  const numericCharacterID = toInt(characterID, 0);
  const existingTimer = schedulerHandles.get(numericCharacterID);
  if (existingTimer) {
    clearTimeout(existingTimer);
    schedulerHandles.delete(numericCharacterID);
  }
}

function buildDurableQueueJobID(characterID, trainingEndTime) {
  return (
    `${DURABLE_COMPLETION_JOB_PREFIX}${toInt(characterID, 0)}:` +
    String(trainingEndTime || "")
  );
}

function buildDurableQueueJob(characterID, snapshot) {
  if (!snapshot || !snapshot.currentEntry || !snapshot.currentEntry.trainingEndTime) {
    return null;
  }
  const trainingEndTime = normalizeBigInt(
    snapshot.currentEntry.trainingEndTime,
    0n,
  );
  const remainingTicks = trainingEndTime - getNowFileTime();
  const remainingMs = remainingTicks > 0n
    ? Number((remainingTicks + 9999n) / 10000n)
    : 0;
  return {
    jobID: buildDurableQueueJobID(characterID, trainingEndTime),
    type: DURABLE_COMPLETION_JOB_TYPE,
    dueAtMs: Date.now() + Math.max(0, remainingMs) + 100,
    payload: {
      characterID: toInt(characterID, 0),
      trainingEndTime: trainingEndTime.toString(),
    },
  };
}

async function reconcileDurableQueueJob(characterID, options = {}) {
  const numericCharacterID = toInt(characterID, 0);
  if (!durableScheduler || numericCharacterID <= 0) {
    return null;
  }
  clearLocalQueueTimer(numericCharacterID);

  const runningJobID = String(options.runningJobID || "");
  const previousJobID = durableJobIDs.get(numericCharacterID) || null;
  const snapshot = getQueueSnapshot(numericCharacterID);
  const job = buildDurableQueueJob(numericCharacterID, snapshot);

  if (!job) {
    durableJobIDs.delete(numericCharacterID);
    if (previousJobID && previousJobID !== runningJobID) {
      await durableScheduler.cancel(previousJobID);
    }
    return null;
  }
  if (previousJobID === job.jobID) {
    return job;
  }
  if (previousJobID && previousJobID !== runningJobID) {
    await durableScheduler.cancel(previousJobID);
  }
  await durableScheduler.schedule(job);
  durableJobIDs.set(numericCharacterID, job.jobID);
  return job;
}

function commitDurableSkillState() {
  for (const tableName of DURABLE_SKILL_TABLES) {
    database.flushTableAsync(tableName);
  }
}

function queueDurableQueueReconciliation(characterID) {
  const numericCharacterID = toInt(characterID, 0);
  if (!durableScheduler || numericCharacterID <= 0) {
    return Promise.resolve(null);
  }
  const scheduler = durableScheduler;
  const generation = durableSchedulerGeneration;
  let commitError = null;
  try {
    commitDurableSkillState();
  } catch (error) {
    commitError = error;
  }
  const previousLane = durableScheduleLanes.get(numericCharacterID)
    || Promise.resolve();
  const lane = previousLane.catch(() => null).then(() => {
    if (
      scheduler !== durableScheduler ||
      generation !== durableSchedulerGeneration
    ) {
      return null;
    }
    if (commitError) {
      throw commitError;
    }
    return reconcileDurableQueueJob(numericCharacterID);
  });
  durableScheduleLanes.set(numericCharacterID, lane);
  void lane.finally(() => {
    if (durableScheduleLanes.get(numericCharacterID) === lane) {
      durableScheduleLanes.delete(numericCharacterID);
    }
  }).catch(() => null);
  void lane.catch((error) => {
    log.warn(
      `[SkillQueue] durable completion scheduling failed character=${numericCharacterID}: ${error.message}`,
    );
  });
  return lane;
}

function scheduleQueueCompletion(characterID) {
  const numericCharacterID = toInt(characterID, 0);
  if (numericCharacterID <= 0) {
    return null;
  }

  clearLocalQueueTimer(numericCharacterID);
  if (durableScheduler) {
    return queueDurableQueueReconciliation(numericCharacterID);
  }

  const snapshot = getQueueSnapshot(numericCharacterID);
  if (!snapshot.currentEntry || !snapshot.currentEntry.trainingEndTime) {
    return null;
  }

  const now = getNowFileTime();
  const endTime = normalizeBigInt(snapshot.currentEntry.trainingEndTime, 0n);
  const diffMs = Number((endTime - now) / 10000n);
  const delayMs = Math.max(1000, Math.min(diffMs + 100, 2147483647));
  const timer = setTimeout(() => {
    schedulerHandles.delete(numericCharacterID);
    clearSnapshotCache(numericCharacterID);
    settleCharacterTraining(numericCharacterID);
    scheduleQueueCompletion(numericCharacterID);
  }, delayMs);
  if (typeof timer.unref === "function") {
    timer.unref();
  }
  schedulerHandles.set(numericCharacterID, timer);
  return timer;
}

function saveQueue(characterID, queueEntries, options = {}) {
  const numericCharacterID = toInt(characterID, 0);
  const characterRecord = getCharacterRecord(numericCharacterID);
  if (!characterRecord) {
    throwWrappedUserError("QueueSkillNotUploaded");
  }

  const activate = options.activate !== false;
  const accountID = getCharacterAccountID(numericCharacterID);
  const nextQueue = queueEntries.map((entry) => ({
    typeID: entry.typeID,
    toLevel: entry.toLevel,
  }));
  let currentState = getCharacterQueueState(numericCharacterID);
  const requestedActive = Boolean(activate && nextQueue.length > 0);
  const shouldRebaseCurrentSkill =
    currentState.active &&
    currentState.queue.length > 0 &&
    (!requestedActive || !sameQueueEntry(currentState.queue[0], nextQueue[0]));
  const rebaseResult = shouldRebaseCurrentSkill
    ? rebaseActiveTrainingProgress(numericCharacterID)
    : null;
  if (rebaseResult) {
    currentState = getCharacterQueueState(numericCharacterID);
  }

  validateQueueEntries(numericCharacterID, characterRecord, queueEntries);
  const cloneGrade = resolveCharacterCloneGrade(numericCharacterID, accountID);

  const nextActive = requestedActive;
  if (nextActive && cloneGrade !== undefined) {
    for (const entry of nextQueue) {
      if (
        isSkillLevelRestrictedForClone(entry.typeID, entry.toLevel, {
          characterID: numericCharacterID,
          accountID,
          cloneGrade,
        })
      ) {
        throwWrappedUserError("SkillInQueueRequiresOmegaCloneState");
      }
    }

    const currentSnapshot = getQueueSnapshot(numericCharacterID);
    const capBreakdown = getAlphaTrainingCapBreakdown(
      numericCharacterID,
      nextQueue.map((entry) => {
        const skillRecord =
          currentSnapshot.projectedSkillMap.get(entry.typeID) ||
          getCharacterBaseSkillMap(numericCharacterID).get(entry.typeID);
        return {
          ...entry,
          skillRank: Number(skillRecord && skillRecord.skillRank) || 1,
        };
      }),
      {
        accountID,
        cloneGrade,
        skillRecords: currentSnapshot.projectedSkills,
      },
    );
    if (capBreakdown.firstBlocked && capBreakdown.firstBlocked.overAlphaTrainingCap) {
      throwWrappedUserError("SkillInQueueOverAlphaSpTrainingSize", {
        limit: ALPHA_MAX_TRAINING_SP,
      });
    }
  }

  // Validate skills, clone restrictions and the training cap before changing
  // another pilot's queue. A paused save never requests a slot. Tutorial
  // priority displaces only the busy slots this activation actually needs;
  // idle licensed MCT capacity and an already-active pilot need no preemption.
  const availableSlotCount = getAvailableTrainingSlotCount(accountID);
  let activeCharacters = getActiveTrainingCharacterIDsForAccount(accountID);
  const alreadyActive = activeCharacters.includes(numericCharacterID);
  if (nextActive && !alreadyActive && activeCharacters.length >= availableSlotCount) {
    if (require("../../npe/airNpeRuntime").isTutorialActive(numericCharacterID)) {
      const requiredSlots = activeCharacters.length - availableSlotCount + 1;
      const displaced = activeCharacters
        .filter(otherCharacterID => otherCharacterID !== numericCharacterID)
        .sort((left, right) => left - right)
        .slice(0, requiredSlots);
      for (const otherCharacterID of displaced) {
        abortTraining(otherCharacterID);
        log.info(
          `[SkillQueue] character ${otherCharacterID}: training paused for character ` +
            `${numericCharacterID} in the AIR tutorial (account ${accountID})`,
        );
      }
      activeCharacters = getActiveTrainingCharacterIDsForAccount(accountID);
    }
    if (activeCharacters.length >= availableSlotCount) {
      throwWrappedUserError("UserAlreadyHasSkillInTraining", {
        charactersTrainingCount: activeCharacters.length,
      });
    }
  }

  const preserveActiveStart =
    currentState.active &&
    nextActive &&
    currentState.queue.length > 0 &&
    nextQueue.length > 0 &&
    currentState.queue[0].typeID === nextQueue[0].typeID &&
    currentState.queue[0].toLevel === nextQueue[0].toLevel &&
    currentState.activeStartTime;

  const nextState = {
    queue: nextQueue,
    active: nextActive,
    activeStartTime: nextActive
      ? preserveActiveStart || buildFiletimeString(getNowFileTime())
      : null,
  };
  setCharacterQueueState(numericCharacterID, nextState);
  clearSnapshotCache(numericCharacterID);

  const snapshot = getQueueSnapshot(numericCharacterID);
  const emitNotifications = options.emitNotifications !== false;
  if (emitNotifications) {
    if (rebaseResult && rebaseResult.changed && rebaseResult.rebasedSkill) {
      notifySkillStateChanged(numericCharacterID, [rebaseResult.rebasedSkill], {
        previousSkillMap: rebaseResult.previousSkillMap,
        timeStamp: buildFiletimeString(getNowFileTime()),
        emitLocalSkillScatters: false,
        emitSkillLevelsTrained: false,
        includeMetadata: false,
      });
    }
    notifySkillQueueSaved(numericCharacterID, snapshot.queueEntries);
  }
  if (nextActive && snapshot.currentEntry) {
    // A start of training writes no row of the history. Tranquility's has
    // none: eighteen rows one after the other over ten days (three logins'
    // GetSkillHistory(10), overlapping) are seventeen levels trained and one
    // use of free points, and among them a level of 500 points trained seven
    // days after the row before it, whose training had then to be started.
    scheduleQueueCompletion(numericCharacterID);
  } else if (!nextActive) {
    scheduleQueueCompletion(numericCharacterID);
    if (emitNotifications) {
      notifySkillQueuePaused(numericCharacterID);
    }
  }
  // No OnMultipleCharactersTrainingUpdated: Tranquility sends none after SaveNewQueue, even
  // one that starts a paused queue (doc/Apply Skill Points Flow.md, Save Queue). The client
  // counts only the account's other characters in its training-slot check, which this save
  // doesn't change; a stray one costs every move of a multi-skill drag an extra
  // GetMultiCharactersTrainingSlots call.
  return snapshot;
}

// options.atTime pauses as of that past moment (an MCT expiry): skills due by then complete,
// and the skill in training keeps only the points it had then.
function abortTraining(characterID, options = {}) {
  const numericCharacterID = toInt(characterID, 0);
  const atTime = options.atTime;
  if (atTime !== undefined) {
    clearSnapshotCache(numericCharacterID);
    settleCharacterTraining(numericCharacterID, { untilTime: atTime });
  }
  const queueState = getCharacterQueueState(numericCharacterID);
  if (!queueState.active || queueState.queue.length === 0) {
    return getQueueSnapshot(numericCharacterID);
  }

  const snapshot = getQueueSnapshot(
    numericCharacterID,
    atTime === undefined ? {} : { settleUntil: atTime },
  );
  const currentEntry = snapshot.currentEntry;
  const rebaseResult = currentEntry
    ? rebaseActiveTrainingProgress(numericCharacterID, { snapshot, atTime })
    : null;
  queueState.active = false;
  queueState.activeStartTime = null;
  setCharacterQueueState(numericCharacterID, queueState);
  clearSnapshotCache(numericCharacterID);
  scheduleQueueCompletion(numericCharacterID);
  if (currentEntry) {
    const cancelPoints = rebaseResult && rebaseResult.rebasedSkill
      ? rebaseResult.rebasedSkill.trainedSkillPoints
      : currentEntry.trainingStartSP;
    // No recording has a training stopped: its points are reckoned as the
    // recorded rows' are, what the stop gave the skill and what it has.
    appendSkillHistoryEntry(
      numericCharacterID,
      SKILL_EVENT_TRAINING_CANCELLED,
      currentEntry.trainingTypeID,
      toInt(cancelPoints, 0) - toInt(currentEntry.trainingStartSP, 0),
      cancelPoints,
      atTime,
    );
  }
  if (options.emitNotifications !== false) {
    if (rebaseResult && rebaseResult.rebasedSkill) {
      notifySkillStateChanged(numericCharacterID, [rebaseResult.rebasedSkill], {
        previousSkillMap: rebaseResult.previousSkillMap,
        serverReason: "OnSkillQueuePausedServer",
        timeStamp: buildFiletimeString(getNowFileTime()),
        emitLocalSkillScatters: false,
        emitSkillLevelsTrained: false,
        includeMetadata: false,
      });
    } else {
      notifySkillQueuePaused(numericCharacterID);
    }
  }
  notifyMultipleCharacterTrainingUpdated(getCharacterAccountID(numericCharacterID));
  return getQueueSnapshot(numericCharacterID);
}

// options.fromClientSkillEntries: the preview the Apply Skill Points window shows. The client adds these points
// to its own skill entry (skillQueueSvc.GetSkillLevelAndProgressWithFreePoints: MySkillPoints, the stored
// trainedSkillPoints), and for the skill in training that entry holds the points its queue entry started from
// (GetSkills), not the points trained since. Counted from the projected points, the window showed the skill short
// by what had trained (Mining Upgrades I at 99.2 %). Applying counts from the trained points (it writes them into
// the skill first), so it spends only what is still missing.
function previewFreeSkillPointsApplication(characterID, entries = [], options = {}) {
  const snapshot = getQueueSnapshot(characterID);
  const clientEntry = options.fromClientSkillEntries === true && snapshot.currentEntry
    ? snapshot.currentEntry
    : null;
  let remainingPoints = snapshot.freeSkillPoints;
  const pointsBySkillTypeID = new Map();
  const projectedPoints = new Map();
  const sourceEntries = Array.isArray(entries) && entries.length > 0
    ? entries
    : snapshot.queueEntries.map((entry) => ({
        typeID: entry.trainingTypeID,
        toLevel: entry.trainingToLevel,
      }));

  for (const entry of sourceEntries) {
    if (remainingPoints <= 0) {
      break;
    }
    const typeID = toInt(entry.typeID, 0);
    const skillRecord =
      snapshot.projectedSkillMap.get(typeID) ||
      getSkillRecordForProjection(characterID, getCharacterBaseSkillMap(characterID), typeID);
    if (!skillRecord) {
      continue;
    }
    const maxLevel = getMaxTrainableLevelForClone(typeID, {
      characterID,
      accountID: snapshot.accountID,
    });
    if (maxLevel <= 0) {
      continue;
    }
    const currentPoints = projectedPoints.has(typeID)
      ? projectedPoints.get(typeID)
      : clientEntry && toInt(clientEntry.trainingTypeID, 0) === typeID
        ? Math.max(0, toInt(clientEntry.trainingStartSP, 0))
        : Math.max(0, toInt(skillRecord.trainedSkillPoints, 0));
    const targetPoints = getSkillPointsForLevel(
      skillRecord.skillRank,
      Math.min(toInt(entry.toLevel, 0), maxLevel),
    );
    if (currentPoints >= targetPoints) {
      continue;
    }
    const appliedPoints = Math.min(remainingPoints, targetPoints - currentPoints);
    remainingPoints -= appliedPoints;
    projectedPoints.set(typeID, currentPoints + appliedPoints);
    pointsBySkillTypeID.set(typeID, (pointsBySkillTypeID.get(typeID) || 0) + appliedPoints);
  }

  return pointsBySkillTypeID;
}

function buildPointsDict(pointsBySkillTypeID) {
  return buildDict(
    [...pointsBySkillTypeID.entries()].map(([typeID, points]) => [typeID, points]),
  );
}

function applyFreeSkillPointsInternal(characterID, entries = []) {
  let requestedPointsBySkillTypeID = null;
  let requestedEntries = entries;
  if (entries && !Array.isArray(entries) && typeof entries === "object") {
    requestedEntries = Array.isArray(entries.entries) ? entries.entries : [];
    if (entries.pointsBySkillTypeID instanceof Map) {
      requestedPointsBySkillTypeID = entries.pointsBySkillTypeID;
    } else if (entries.pointsBySkillTypeID && typeof entries.pointsBySkillTypeID === "object") {
      requestedPointsBySkillTypeID = new Map(
        Object.entries(entries.pointsBySkillTypeID).map(([typeID, points]) => [
          toInt(typeID, 0),
          toInt(points, 0),
        ]),
      );
    }
  }

  const numericCharacterID = toInt(characterID, 0);
  // The points the active queue has trained since it started are only projected until the skill finishes.
  // The client asks for what is missing from the projected progress (skillQueueSvc applies exactly that), so
  // write the progress into the skill first; added to the stored points alone, the skill fell short by what had
  // been trained (Mining Upgrades I at 98.4 % after applying the 984 points the client asked for).
  rebaseActiveTrainingProgress(numericCharacterID);
  const snapshot = getQueueSnapshot(numericCharacterID);
  const pointsBySkillTypeID =
    requestedPointsBySkillTypeID ||
    previewFreeSkillPointsApplication(numericCharacterID, requestedEntries);
  if (pointsBySkillTypeID.size === 0) {
    return {
      newFreeSkillPoints: snapshot.freeSkillPoints,
      changedSkills: [],
    };
  }

  const queueState = getCharacterQueueState(numericCharacterID);
  const skillMap = getCharacterBaseSkillMap(numericCharacterID);
  const previousSkillMap = cloneSkillMap(skillMap);
  const wasActive = queueState.active === true;
  let remainingFreeSkillPoints = snapshot.freeSkillPoints;
  const changedSkills = [];
  const recentSkillPointChanges = [];

  for (const [typeID, appliedPoints] of pointsBySkillTypeID.entries()) {
    if (appliedPoints <= 0 || remainingFreeSkillPoints <= 0) {
      continue;
    }
    const skillRecord = getSkillRecordForProjection(numericCharacterID, skillMap, typeID);
    if (!skillRecord) {
      continue;
    }
    const pointsUsed = Math.min(remainingFreeSkillPoints, appliedPoints);
    const nextSkillPoints = Math.max(
      0,
      toInt(skillRecord.trainedSkillPoints, 0) + pointsUsed,
    );
    const nextSkillLevel = getSkillLevelForPoints(skillRecord.skillRank, nextSkillPoints);
    const nextRecord = {
      ...cloneValue(skillRecord),
      skillLevel: nextSkillLevel,
      trainedSkillLevel: nextSkillLevel,
      effectiveSkillLevel: nextSkillLevel,
      skillPoints: nextSkillPoints,
      trainedSkillPoints: nextSkillPoints,
      inTraining: false,
      trainingStartSP: nextSkillPoints,
      trainingDestinationSP: nextSkillPoints,
      trainingStartTime: null,
      trainingEndTime: null,
    };
    skillMap.set(typeID, nextRecord);
    changedSkills.push(cloneValue(nextRecord));
    recentSkillPointChanges.push({
      typeID,
      pointChange: pointsUsed,
    });
    remainingFreeSkillPoints -= pointsUsed;
    // Recorded: (307, the skill, 908, 1000), the points used and what the
    // skill then had.
    appendSkillHistoryEntry(
      numericCharacterID,
      SKILL_EVENT_FREE_SKILL_POINTS_USED,
      typeID,
      pointsUsed,
      nextSkillPoints,
    );
  }

  queueState.queue = queueState.queue.filter((entry) => {
    const skillRecord = skillMap.get(toInt(entry.typeID, 0));
    return !skillRecord || toInt(skillRecord.trainedSkillLevel, 0) < toInt(entry.toLevel, 0);
  });
  if (queueState.active) {
    if (queueState.queue.length > 0) {
      queueState.activeStartTime = buildFiletimeString(getNowFileTime());
    } else {
      queueState.active = false;
      queueState.activeStartTime = null;
    }
  }

  persistSkillMap(numericCharacterID, skillMap);
  updateCharacterRecord(numericCharacterID, (record) => ({
    ...record,
    freeSkillPoints: remainingFreeSkillPoints,
  }));
  setCharacterQueueState(numericCharacterID, queueState);
  clearSnapshotCache(numericCharacterID);
  recordRecentSkillPointChanges(numericCharacterID, recentSkillPointChanges);
  const updatedSnapshot = getQueueSnapshot(numericCharacterID);
  notifySkillDogmaBrainChanged(numericCharacterID, {
    idType: "charid",
  });
  notifySkillStateChanged(numericCharacterID, changedSkills, {
    previousSkillMap,
    timeStamp: buildFiletimeString(getNowFileTime()),
    emitLocalSkillScatters: false,
    includeMetadata: false,
    syncDogmaState: false,
  });
  notifySkillQueueSaved(numericCharacterID, updatedSnapshot.queueEntries);
  notifyFreeSkillPointsChanged(numericCharacterID, remainingFreeSkillPoints);
  notifySkillDogmaAttributesChangedAsMultiEvent(numericCharacterID, {
    defer: true,
  });
  if (updatedSnapshot.active) {
    scheduleQueueCompletion(numericCharacterID);
  } else if (wasActive) {
    notifySkillQueuePaused(numericCharacterID);
  }

  return {
    newFreeSkillPoints: remainingFreeSkillPoints,
    changedSkills,
  };
}

function applyFreeSkillPoints(characterID, skillTypeID, pointsToApply) {
  const numericCharacterID = toInt(characterID, 0);
  const typeID = toInt(skillTypeID, 0);
  const requestedPoints = Math.max(0, toInt(pointsToApply, 0));
  if (typeID <= 0 || requestedPoints <= 0) {
    return getQueueSnapshot(numericCharacterID).freeSkillPoints;
  }

  const snapshot = getQueueSnapshot(numericCharacterID);
  if (
    snapshot.currentEntry &&
    toInt(snapshot.currentEntry.trainingTypeID, 0) === typeID &&
    snapshot.active
  ) {
    throwWrappedUserError("CannotApplyFreePointsWhileTrainingSkill");
  }

  const skillRecord =
    snapshot.projectedSkillMap.get(typeID) ||
    getSkillRecordForProjection(numericCharacterID, getCharacterBaseSkillMap(numericCharacterID), typeID);
  if (!skillRecord) {
    throwWrappedUserError("CannotApplyFreePointsDoNotHaveSkill");
  }
  const maxTrainableLevel = getMaxTrainableLevelForClone(typeID, {
    characterID: numericCharacterID,
    accountID: snapshot.accountID,
  });
  const maxPoints = getSkillPointsForLevel(skillRecord.skillRank, maxTrainableLevel);
  const missingPoints = Math.max(0, maxPoints - toInt(skillRecord.trainedSkillPoints, 0));
  const cappedPointsToApply = Math.min(requestedPoints, missingPoints);
  if (cappedPointsToApply > snapshot.freeSkillPoints) {
    throwWrappedUserError("CannotApplyFreePointsNotEnoughRemaining", {
      pointsRequested: cappedPointsToApply,
      pointsRemaining: snapshot.freeSkillPoints,
    });
  }
  if (cappedPointsToApply <= 0) {
    return snapshot.freeSkillPoints;
  }

  const result = applyFreeSkillPointsInternal(numericCharacterID, {
    pointsBySkillTypeID: new Map([[typeID, cappedPointsToApply]]),
  });
  return result.newFreeSkillPoints;
}

function buildTrainingSelectionInfo(characterID) {
  const snapshot = getQueueSnapshot(characterID);
  const currentEntry = snapshot.currentEntry;
  const characterRecord = getCharacterRecord(characterID) || {};
  const finishedSkills = Array.isArray(characterRecord.finishedSkills)
    ? cloneValue(characterRecord.finishedSkills)
    : [];
  if (!snapshot.active || !currentEntry) {
    return {
      skillTypeID: null,
      currentSkill: null,
      toLevel: null,
      trainingStartTime: null,
      trainingEndTime: null,
      queueEndTime: null,
      fromSP: null,
      finishSP: null,
      trainedSP: null,
      finishedSkills,
    };
  }

  return {
    skillTypeID: currentEntry.trainingTypeID,
    currentSkill: currentEntry.trainingTypeID,
    toLevel: currentEntry.trainingToLevel,
    trainingStartTime: currentEntry.trainingStartTime,
    trainingEndTime: currentEntry.trainingEndTime,
    queueEndTime: snapshot.queueEndTime,
    fromSP: getSkillPointsForLevel(
      snapshot.projectedSkillMap.get(currentEntry.trainingTypeID)?.skillRank || 1,
      Math.max(0, currentEntry.trainingToLevel - 1),
    ),
    finishSP: currentEntry.trainingDestinationSP,
    trainedSP: getEstimatedSkillPointsAtTime(
      currentEntry.trainingStartSP,
      currentEntry.trainingDestinationSP,
      currentEntry.trainingStartTime,
      getNowFileTime(),
      currentEntry.skillPointsPerMinute,
      currentEntry.rateChanges,
    ),
    finishedSkills,
  };
}

function bindDurableScheduler(scheduler) {
  if (
    !scheduler ||
    typeof scheduler.schedule !== "function" ||
    typeof scheduler.cancel !== "function"
  ) {
    throw new TypeError("skill queue scheduler requires schedule and cancel functions");
  }
  durableSchedulerGeneration += 1;
  durableScheduler = scheduler;
  durableJobIDs.clear();
  durableScheduleLanes.clear();
  for (const characterID of [...schedulerHandles.keys()]) {
    clearLocalQueueTimer(characterID);
  }
  return true;
}

function unbindDurableScheduler(scheduler = null) {
  if (scheduler && durableScheduler !== scheduler) {
    return false;
  }
  durableSchedulerGeneration += 1;
  durableScheduler = null;
  durableJobIDs.clear();
  durableScheduleLanes.clear();
  for (const characterID of [...schedulerHandles.keys()]) {
    clearLocalQueueTimer(characterID);
  }
  return true;
}

async function reconcileDurableQueueJobs() {
  if (!durableScheduler) {
    return { scheduled: 0 };
  }
  let scheduled = 0;
  for (const characterID of Object.keys(getAllQueueStates())) {
    const job = await reconcileDurableQueueJob(characterID);
    if (job) scheduled += 1;
  }
  return { scheduled };
}

async function handleDurableQueueCompletion(job) {
  const characterID = toInt(job && job.payload && job.payload.characterID, 0);
  const jobID = String(job && job.jobID || "");
  if (characterID <= 0 || !jobID) {
    throw new Error("skill queue completion job is invalid");
  }

  if (durableJobIDs.get(characterID) === jobID) {
    durableJobIDs.delete(characterID);
  }
  const settlement = settleCharacterTraining(characterID);
  const snapshot = getQueueSnapshot(characterID);
  commitDurableSkillState();
  const currentJob = buildDurableQueueJob(characterID, snapshot);
  if (currentJob && currentJob.jobID === jobID) {
    throw new Error("skill queue completion fired before its training boundary");
  }
  const nextJob = await reconcileDurableQueueJob(characterID, {
    runningJobID: jobID,
  });
  return {
    characterID,
    finishedSkills: settlement.finishedSkills,
    nextJobID: nextJob && nextJob.jobID || null,
    settled: settlement.settled,
  };
}

function primeQueueSchedulers() {
  // This runs on the tick after the module loads. If the store has started
  // shutting down by then, settling a finished skill would write and throw.
  if (database.isShutdownInProgress()) {
    return;
  }
  for (const characterID of Object.keys(getAllQueueStates())) {
    const state = getCharacterQueueState(characterID);
    if (!state.active || state.queue.length <= 0) {
      continue;
    }
    scheduleQueueCompletion(characterID);
  }
}

setImmediate(primeQueueSchedulers);

module.exports = {
  refreshAccountEntitlement,
  DURABLE_COMPLETION_JOB_TYPE,
  SKILLQUEUE_MAX_NUM_SKILLS,
  abortTraining,
  applyFreeSkillPoints,
  applyFreeSkillPointsInternal,
  buildPointsDict,
  buildTrainingSelectionInfo,
  bindDurableScheduler,
  // Exported so a caller that replaces the skill tables underneath this module
  // can drop the memoised queue snapshots with them. Nothing else invalidates
  // them: the cache key is built from the character record, which a restore
  // puts back unchanged, so a stale snapshot survives a restore and reports a
  // queue the store no longer holds.
  clearSnapshotCache,
  buildDurableQueueJob,
  buildDurableQueueJobID,
  getCharacterIDFromSession,
  getQueueSnapshot,
  normalizeQueueInput,
  handleDurableQueueCompletion,
  prepareQueueForAttributeChange,
  previewFreeSkillPointsApplication,
  primeQueueSchedulers,
  reconcileDurableQueueJobs,
  readBooleanKwarg,
  saveQueue,
  scheduleQueueCompletion,
  settleCharacterTraining,
  syncQueueAfterAttributeChange,
  unbindDurableScheduler,
};
