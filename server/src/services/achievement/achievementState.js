"use strict";

const {
  cloneValue,
} = require("../../common/clone");

const { EventEmitter } = require("events");
const path = require("path");

const {
  createTableRepository,
} = require(path.join(__dirname, "../../gameStore/tableRepository"));
const {
  getAchievementById,
  getAchievementDefinitions,
  getCategoryById,
  getContributionMethodById,
  getRewardById,
  getTitleById,
  normalizeUUID,
} = require("./achievementAuthority");

const TABLE_NAME = "achievements";
const ROOT_VERSION = 1;
const CHECKLIST_ACHIEVEMENT_METHOD_ID = "5f290484-2864-5562-ab89-3e4f89e81464";
const events = new EventEmitter();
const repo = createTableRepository("service:achievement", { strict: true });

function positiveInteger(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : fallback;
}

function nonNegativeInteger(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? Math.trunc(numeric) : fallback;
}

function isEnabled() {
  return String(process.env.ELYSIAN_EVE_NATIVE_ACHIEVEMENTS_ENABLED || "true")
    .trim()
    .toLowerCase() !== "false";
}

function defaultCharacterState(characterID) {
  return {
    version: 1,
    characterID,
    achievementsById: {},
    categoryScoresById: {},
    totalScore: 0,
    unclaimedSourcesByKey: {},
    claimedRewardKeys: {},
    ownedTitleIds: [],
    equippedTitleId: null,
    legacyTracker: {
      completedByAchievementId: {},
      eventCountsByName: {},
      hasEverWarped: false,
    },
    createdAtMs: Date.now(),
    updatedAtMs: Date.now(),
  };
}

function readRoot() {
  const result = repo.read(TABLE_NAME, "/");
  const root = result && result.success && result.data && typeof result.data === "object"
    ? cloneValue(result.data)
    : {};
  return {
    version: ROOT_VERSION,
    characters: root.characters && typeof root.characters === "object"
      ? root.characters
      : {},
  };
}

function writeRoot(root) {
  const previous = readRoot();
  const written = repo.write(TABLE_NAME, "/", {
    version: ROOT_VERSION,
    characters: root.characters || {},
  });
  if (!written?.success) return written;
  let flushed;
  try { flushed = repo.flushTableSync(TABLE_NAME); }
  catch (error) { flushed = { success: false, errorMsg: error.message || "ACHIEVEMENT_FLUSH_FAILED" }; }
  if (!flushed?.success) {
    repo.write(TABLE_NAME, "/", previous, { force: true });
    return flushed || { success: false, errorMsg: "ACHIEVEMENT_FLUSH_FAILED" };
  }
  return written;
}

function normalizeStringList(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value === undefined || value === null ? "" : value).trim())
    .filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
}

function defaultAchievementState() {
  return {
    progressValue: 0,
    checklistValuesByType: {},
    hiddenUniqueValuesByType: {},
    reachedMilestonesById: {},
    completedAtMs: 0,
    updatedAtMs: 0,
  };
}

function normalizeAchievementState(value) {
  const source = value && typeof value === "object" ? value : {};
  const normalizeValueMap = (map) => Object.fromEntries(
    Object.entries(map && typeof map === "object" ? map : {})
      .map(([key, values]) => [String(key), normalizeStringList(values)])
      .filter(([key]) => key),
  );
  return {
    progressValue: nonNegativeInteger(source.progressValue),
    checklistValuesByType: normalizeValueMap(source.checklistValuesByType),
    hiddenUniqueValuesByType: normalizeValueMap(source.hiddenUniqueValuesByType),
    reachedMilestonesById: Object.fromEntries(
      Object.entries(source.reachedMilestonesById || {})
        .map(([id, entry]) => [normalizeUUID(id), {
          reachedAtMs: nonNegativeInteger(entry && entry.reachedAtMs),
          categoryPointsAwarded: nonNegativeInteger(entry && entry.categoryPointsAwarded),
        }])
        .filter(([id]) => id),
    ),
    completedAtMs: nonNegativeInteger(source.completedAtMs),
    updatedAtMs: nonNegativeInteger(source.updatedAtMs),
  };
}

function normalizeCharacterState(value, characterID) {
  const source = value && typeof value === "object" ? value : defaultCharacterState(characterID);
  return {
    ...defaultCharacterState(characterID),
    ...source,
    version: 1,
    characterID,
    achievementsById: Object.fromEntries(
      Object.entries(source.achievementsById || {})
        .map(([id, state]) => [normalizeUUID(id), normalizeAchievementState(state)])
        .filter(([id]) => id),
    ),
    categoryScoresById: Object.fromEntries(
      Object.entries(source.categoryScoresById || {})
        .map(([id, score]) => [normalizeUUID(id), nonNegativeInteger(score)])
        .filter(([id]) => id),
    ),
    totalScore: nonNegativeInteger(source.totalScore),
    unclaimedSourcesByKey: source.unclaimedSourcesByKey && typeof source.unclaimedSourcesByKey === "object"
      ? cloneValue(source.unclaimedSourcesByKey)
      : {},
    claimedRewardKeys: source.claimedRewardKeys && typeof source.claimedRewardKeys === "object"
      ? cloneValue(source.claimedRewardKeys)
      : {},
    ownedTitleIds: normalizeStringList(source.ownedTitleIds)
      .map(normalizeUUID)
      .filter(Boolean),
    equippedTitleId: normalizeUUID(source.equippedTitleId) || null,
    legacyTracker: {
      completedByAchievementId: Object.fromEntries(
        Object.entries(source.legacyTracker && source.legacyTracker.completedByAchievementId || {})
          .map(([id, value]) => [String(positiveInteger(id)), String(value || "")])
          .filter(([id, value]) => id !== "0" && /^\d+$/.test(value)),
      ),
      eventCountsByName: Object.fromEntries(
        Object.entries(source.legacyTracker && source.legacyTracker.eventCountsByName || {})
          .map(([name, value]) => [String(name || "").trim(), nonNegativeInteger(value)])
          .filter(([name]) => name),
      ),
      hasEverWarped: Boolean(source.legacyTracker && source.legacyTracker.hasEverWarped),
    },
  };
}

function getCharacterState(characterID) {
  const numericCharacterID = positiveInteger(characterID);
  if (!numericCharacterID) {
    return null;
  }
  const root = readRoot();
  return normalizeCharacterState(root.characters[String(numericCharacterID)], numericCharacterID);
}

function updateCharacterState(characterID, updater) {
  const numericCharacterID = positiveInteger(characterID);
  if (!numericCharacterID || typeof updater !== "function") {
    return { success: false, errorMsg: "INVALID_CHARACTER" };
  }
  const root = readRoot();
  const current = normalizeCharacterState(root.characters[String(numericCharacterID)], numericCharacterID);
  const updated = updater(cloneValue(current));
  const next = normalizeCharacterState(updated, numericCharacterID);
  next.updatedAtMs = Date.now();
  root.characters[String(numericCharacterID)] = next;
  const result = writeRoot(root);
  return result && result.success
    ? { success: true, data: cloneValue(next) }
    : (result || { success: false, errorMsg: "WRITE_ERROR" });
}

function getProgressMode(achievement) {
  const method = getContributionMethodById(
    achievement && achievement.contribution && achievement.contribution.method_id,
  );
  return String(method && method.progress && method.progress.progress_type || "CUMULATIVE").toUpperCase();
}

function getTargetParameter(achievement) {
  const method = getContributionMethodById(
    achievement && achievement.contribution && achievement.contribution.method_id,
  );
  return String(method && method.progress && method.progress.target_parameter || "").trim();
}

function getProgressCount(achievement, state) {
  const mode = getProgressMode(achievement);
  if (mode === "SET" || mode === "CHECKLIST") {
    const parameter = getTargetParameter(achievement);
    return normalizeStringList(state.checklistValuesByType[parameter]).length;
  }
  return nonNegativeInteger(state.progressValue);
}

// The native definition asset uses an int64 extension for targets that do not
// fit the legacy 32-bit field.  Keep the full target for server-side reward
// eligibility; the client reads the matching int64 from the binary asset.
function getMilestoneTarget(milestone) {
  const rawTarget = milestone && milestone.raw_cumulated_target;
  const numericRawTarget = Number(rawTarget);
  if (
    rawTarget !== undefined &&
    rawTarget !== null &&
    String(rawTarget).trim() !== "" &&
    Number.isSafeInteger(numericRawTarget) &&
    numericRawTarget >= 0
  ) {
    return numericRawTarget;
  }
  return nonNegativeInteger(milestone && milestone.cumulated_target);
}

function isAvailable(achievement, nowMs) {
  if (!achievement || achievement.archived === true) {
    return false;
  }
  const release = nonNegativeInteger(achievement.release_date_unix_ms);
  const expiry = nonNegativeInteger(achievement.expiration_date_unix_ms);
  return (!release || nowMs >= release) && (!expiry || nowMs <= expiry);
}

function normalizeValueMap(value) {
  return Object.fromEntries(Object.entries(value && typeof value === "object" ? value : {})
    .map(([key, entries]) => [String(key).trim(), normalizeStringList(entries)])
    .filter(([key, entries]) => key && entries.length > 0));
}

function matcherMatches(valuesByType, matcher) {
  const values = valuesByType[String(matcher && matcher.value_type || "").trim()] || [];
  const expected = new Set(normalizeStringList(matcher && matcher.values));
  return values.some((value) => expected.has(value));
}

function contributionMatches(achievement, valuesByType) {
  const parameters = Array.isArray(achievement && achievement.contribution && achievement.contribution.parameters)
    ? achievement.contribution.parameters
    : [];
  return parameters.every((parameter) => {
    const matchers = Array.isArray(parameter && parameter.matchers) ? parameter.matchers : [];
    return matchers.length === 0 || matchers.some((matcher) => matcherMatches(valuesByType, matcher));
  });
}

function sourceKey(sourceKind, sourceID, milestoneID) {
  return `${sourceKind}:${normalizeUUID(sourceID)}:${normalizeUUID(milestoneID)}`;
}

function rewardKey(sourceKind, sourceID, milestoneID, rewardID) {
  return `${sourceKey(sourceKind, sourceID, milestoneID)}:${normalizeUUID(rewardID)}`;
}

function enqueueMilestoneRewards(characterState, achievement, milestone, nowMs) {
  const key = sourceKey("achievement", achievement.id, milestone && milestone.id);
  const entry = characterState.unclaimedSourcesByKey[key] || {
    sourceKind: "achievement",
    sourceID: normalizeUUID(achievement.id),
    milestoneID: normalizeUUID(milestone && milestone.id),
    rewardIds: [],
    createdAtMs: nowMs,
  };
  for (const reward of Array.isArray(milestone && milestone.rewards) ? milestone.rewards : []) {
    const rewardID = normalizeUUID(reward && reward.id);
    if (rewardID && !characterState.claimedRewardKeys[rewardKey("achievement", achievement.id, milestone.id, rewardID)]) {
      entry.rewardIds.push(rewardID);
    }
  }
  entry.rewardIds = normalizeStringList(entry.rewardIds);
  if (entry.rewardIds.length > 0) {
    characterState.unclaimedSourcesByKey[key] = entry;
  }
}

function applyMilestones(characterState, achievement, state, nowMs, newlyReached) {
  for (const milestone of Array.isArray(achievement.milestones) ? achievement.milestones : []) {
    const milestoneID = normalizeUUID(milestone && milestone.id);
    if (!milestoneID || state.reachedMilestonesById[milestoneID]) {
      continue;
    }
    if (getProgressCount(achievement, state) < getMilestoneTarget(milestone)) {
      continue;
    }
    const categoryPoints = nonNegativeInteger(milestone && milestone.category_points);
    state.reachedMilestonesById[milestoneID] = {
      reachedAtMs: nowMs,
      categoryPointsAwarded: categoryPoints,
    };
    for (const categoryID of Array.isArray(achievement.category_path_ids) ? achievement.category_path_ids : []) {
      const normalizedCategoryID = normalizeUUID(categoryID);
      if (!normalizedCategoryID) {
        continue;
      }
      characterState.categoryScoresById[normalizedCategoryID] = nonNegativeInteger(
        characterState.categoryScoresById[normalizedCategoryID],
      ) + categoryPoints;
    }
    characterState.totalScore += categoryPoints;
    enqueueMilestoneRewards(characterState, achievement, milestone, nowMs);
    newlyReached.push(milestoneID);
  }
}

function completeIfReady(achievement, state, nowMs) {
  const milestones = Array.isArray(achievement.milestones) ? achievement.milestones : [];
  if (!state.completedAtMs && milestones.length > 0 && milestones.every((milestone) =>
    Boolean(state.reachedMilestonesById[normalizeUUID(milestone && milestone.id)]))) {
    state.completedAtMs = nowMs;
    return true;
  }
  return false;
}

function recordContribution(characterID, methodID, contribution = {}) {
  const numericCharacterID = positiveInteger(characterID);
  const normalizedMethodID = normalizeUUID(methodID);
  if (!numericCharacterID || !normalizedMethodID || !isEnabled()) {
    return { success: true, data: { changed: false } };
  }
  const authority = getAchievementDefinitions();
  const candidates = authority.indexes && authority.indexes.achievementIdsByMethodId &&
    authority.indexes.achievementIdsByMethodId[normalizedMethodID];
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return { success: true, data: { changed: false } };
  }
  const valuesByType = normalizeValueMap(contribution.valuesByType);
  const delta = nonNegativeInteger(contribution.delta);
  const uniqueValueType = String(contribution.uniqueValueType || "").trim();
  const nowMs = nonNegativeInteger(contribution.nowMs, Date.now()) || Date.now();
  const notices = [];
  const result = updateCharacterState(numericCharacterID, (characterState) => {
    for (const achievementID of candidates) {
      const achievement = getAchievementById(achievementID);
      if (!isAvailable(achievement, nowMs) || !contributionMatches(achievement, valuesByType)) {
        continue;
      }
      const state = normalizeAchievementState(
        characterState.achievementsById[achievement.id] || defaultAchievementState(),
      );
      const before = getProgressCount(achievement, state);
      const mode = getProgressMode(achievement);
      if (mode === "SET" || mode === "CHECKLIST") {
        const parameter = getTargetParameter(achievement);
        const values = valuesByType[parameter] || [];
        state.checklistValuesByType[parameter] = normalizeStringList([
          ...(state.checklistValuesByType[parameter] || []),
          ...values,
        ]);
      } else if (delta > 0) {
        if (uniqueValueType) {
          const priorValues = state.hiddenUniqueValuesByType[uniqueValueType] || [];
          const nextValues = normalizeStringList([
            ...priorValues,
            ...(valuesByType[uniqueValueType] || []),
          ]);
          const addedCount = nextValues.length - priorValues.length;
          if (addedCount <= 0) {
            continue;
          }
          state.hiddenUniqueValuesByType[uniqueValueType] = nextValues;
          state.progressValue += delta * addedCount;
        } else {
          state.progressValue += delta;
        }
      }
      const after = getProgressCount(achievement, state);
      if (after === before) {
        continue;
      }
      const reached = [];
      applyMilestones(characterState, achievement, state, nowMs, reached);
      const completed = completeIfReady(achievement, state, nowMs);
      state.updatedAtMs = nowMs;
      characterState.achievementsById[achievement.id] = state;
      notices.push({
        achievementID: achievement.id,
        progressValue: state.progressValue,
        checklistValuesByType: cloneValue(state.checklistValuesByType),
        reached,
        completed,
      });
    }
    return characterState;
  });
  if (!result.success) {
    return result;
  }
  const progressedCategories = new Set();
  for (const notice of notices) {
    if (notice.reached.length > 0) {
      for (const id of getAchievementById(notice.achievementID).category_path_ids || []) {
        progressedCategories.add(normalizeUUID(id));
      }
    }
  }
  // Publish the committed scores before completion propagation can earn an
  // additional checklist milestone in the same category.
  for (const categoryID of progressedCategories) {
    events.emit("category-progressed", {
      characterID: numericCharacterID,
      categoryID,
      score: nonNegativeInteger(result.data.categoryScoresById[categoryID]),
    });
  }
  for (const notice of notices) {
    events.emit("achievement-progressed", { characterID: numericCharacterID, ...notice });
    for (const milestoneID of notice.reached) {
      events.emit("achievement-milestone-reached", {
        characterID: numericCharacterID,
        achievementID: notice.achievementID,
        milestoneID,
      });
    }
    if (notice.completed) {
      events.emit("achievement-completed", {
        characterID: numericCharacterID,
        achievementID: notice.achievementID,
      });
      // Completion-checklist achievements consume authoritative completion
      // transitions, never client-reported progress.  Their SET/CHECKLIST
      // storage makes repeated delivery harmless.
      recordContribution(numericCharacterID, CHECKLIST_ACHIEVEMENT_METHOD_ID, {
        delta: 1,
        valuesByType: { achievement: [notice.achievementID] },
        nowMs,
      });
    }
  }
  return { success: true, data: { changed: notices.length > 0, notices } };
}

function getAchievementState(characterID, achievementID) {
  const achievement = getAchievementById(achievementID);
  const state = getCharacterState(characterID);
  if (!achievement || !state) {
    return null;
  }
  const achievementState = normalizeAchievementState(
    state.achievementsById[achievement.id] || defaultAchievementState(),
  );
  return {
    achievementID: achievement.id,
    completedAtMs: achievementState.completedAtMs,
    progressValue: achievementState.progressValue,
    checklistValuesByType: cloneValue(achievementState.checklistValuesByType),
    reachedMilestonesById: cloneValue(achievementState.reachedMilestonesById),
  };
}

function getCategoryState(characterID, categoryID) {
  const category = getCategoryById(categoryID);
  const state = getCharacterState(characterID);
  if (!category || !state) {
    return null;
  }
  return {
    categoryID: category.id,
    score: nonNegativeInteger(state.categoryScoresById[category.id]),
    reachedMilestones: [],
  };
}

function getCharacterScore(characterID) {
  const state = getCharacterState(characterID);
  return state ? nonNegativeInteger(state.totalScore) : 0;
}

function getUnclaimedRewardSources(characterID) {
  const state = getCharacterState(characterID);
  if (!state) {
    return [];
  }
  return Object.values(state.unclaimedSourcesByKey)
    .filter((entry) => Array.isArray(entry && entry.rewardIds) && entry.rewardIds.length > 0)
    .sort((left, right) => nonNegativeInteger(left.createdAtMs) - nonNegativeInteger(right.createdAtMs))
    .map(cloneValue);
}

function resetAchievement(characterID, achievementID) {
  const achievement = getAchievementById(achievementID);
  if (!achievement) {
    return { success: false, errorMsg: "ACHIEVEMENT_NOT_FOUND" };
  }
  return updateCharacterState(characterID, (state) => {
    delete state.achievementsById[achievement.id];
    for (const key of Object.keys(state.unclaimedSourcesByKey)) {
      if (key.startsWith(`achievement:${achievement.id}:`)) {
        delete state.unclaimedSourcesByKey[key];
      }
    }
    state.categoryScoresById = {};
    state.totalScore = 0;
    for (const [id, entry] of Object.entries(state.achievementsById)) {
      const definition = getAchievementById(id);
      const normalized = normalizeAchievementState(entry);
      for (const milestone of Object.values(normalized.reachedMilestonesById)) {
        for (const categoryID of Array.isArray(definition && definition.category_path_ids) ? definition.category_path_ids : []) {
          const normalizedCategoryID = normalizeUUID(categoryID);
          state.categoryScoresById[normalizedCategoryID] = nonNegativeInteger(
            state.categoryScoresById[normalizedCategoryID],
          ) + nonNegativeInteger(milestone.categoryPointsAwarded);
        }
        state.totalScore += nonNegativeInteger(milestone.categoryPointsAwarded);
      }
    }
    return state;
  });
}

function resetAll(characterID) {
  const numericCharacterID = positiveInteger(characterID);
  return updateCharacterState(numericCharacterID, () => defaultCharacterState(numericCharacterID));
}

function getOwnedTitles(characterID) {
  const state = getCharacterState(characterID);
  return state ? [...state.ownedTitleIds] : [];
}

function getEquippedTitle(characterID) {
  const state = getCharacterState(characterID);
  return state && state.equippedTitleId ? state.equippedTitleId : null;
}

function grantTitle(characterID, titleID, options = {}) {
  const normalizedTitleID = normalizeUUID(titleID);
  if (!normalizedTitleID || !getTitleById(normalizedTitleID)) {
    return { success: false, errorMsg: "TITLE_NOT_FOUND" };
  }
  let granted = false;
  const result = updateCharacterState(characterID, (state) => {
    granted = !state.ownedTitleIds.includes(normalizedTitleID);
    state.ownedTitleIds = normalizeStringList([...state.ownedTitleIds, normalizedTitleID]);
    return state;
  });
  if (result.success && granted) {
    events.emit("title-granted", {
      characterID: positiveInteger(characterID),
      titleID: normalizedTitleID,
      reason: String(options.reason || "grant"),
    });
  }
  return result;
}

function revokeTitle(characterID, titleID, options = {}) {
  const normalizedTitleID = normalizeUUID(titleID);
  if (!normalizedTitleID) {
    return { success: false, errorMsg: "TITLE_NOT_FOUND" };
  }
  let revoked = false;
  let unset = false;
  const result = updateCharacterState(characterID, (state) => {
    revoked = state.ownedTitleIds.includes(normalizedTitleID);
    unset = state.equippedTitleId === normalizedTitleID;
    state.ownedTitleIds = state.ownedTitleIds.filter((id) => id !== normalizedTitleID);
    if (unset) {
      state.equippedTitleId = null;
    }
    return state;
  });
  const numericCharacterID = positiveInteger(characterID);
  if (result.success && revoked) {
    events.emit("title-revoked", {
      characterID: numericCharacterID,
      titleID: normalizedTitleID,
      reason: String(options.reason || "revoke"),
    });
  }
  if (result.success && unset) {
    events.emit("title-set", { characterID: numericCharacterID, titleID: null });
  }
  return result;
}

function equipTitle(characterID, titleID) {
  const normalizedTitleID = normalizeUUID(titleID);
  if (!normalizedTitleID || !getTitleById(normalizedTitleID)) {
    return { success: false, errorMsg: "TITLE_NOT_FOUND" };
  }
  let owned = false;
  const result = updateCharacterState(characterID, (state) => {
    owned = state.ownedTitleIds.includes(normalizedTitleID);
    if (owned) {
      state.equippedTitleId = normalizedTitleID;
    }
    return state;
  });
  if (!result.success) {
    return result;
  }
  if (!owned) {
    return { success: false, errorMsg: "TITLE_NOT_OWNED" };
  }
  events.emit("title-set", {
    characterID: positiveInteger(characterID),
    titleID: normalizedTitleID,
  });
  return result;
}

function unequipTitle(characterID) {
  const result = updateCharacterState(characterID, (state) => {
    state.equippedTitleId = null;
    return state;
  });
  if (result.success) {
    events.emit("title-set", { characterID: positiveInteger(characterID), titleID: null });
  }
  return result;
}

function normalizeTrackerEntries(value, keyNormalizer, valueNormalizer) {
  const entries = value && value.type === "dict" && Array.isArray(value.entries)
    ? value.entries
    : (value && typeof value === "object" && !Array.isArray(value)
      ? Object.entries(value)
      : []);
  return Object.fromEntries(entries
    .map(([key, entry]) => [keyNormalizer(key), valueNormalizer(entry)])
    .filter(([key]) => key));
}

function getLegacyTrackerState(characterID) {
  const state = getCharacterState(characterID);
  return state ? cloneValue(state.legacyTracker) : null;
}

function updateLegacyTracker(characterID, completedDict, eventDict) {
  return updateCharacterState(characterID, (state) => {
    state.legacyTracker.completedByAchievementId = normalizeTrackerEntries(
      completedDict,
      (key) => String(positiveInteger(key) || ""),
      (value) => String(value && value.value !== undefined ? value.value : value || ""),
    );
    state.legacyTracker.eventCountsByName = normalizeTrackerEntries(
      eventDict,
      (key) => String(key || "").trim(),
      (value) => nonNegativeInteger(value && value.value !== undefined ? value.value : value),
    );
    return state;
  });
}

function recordLegacyWarp(characterID) {
  return updateCharacterState(characterID, (state) => {
    state.legacyTracker.hasEverWarped = true;
    return state;
  });
}

function hasEverWarped(characterID) {
  const state = getCharacterState(characterID);
  return Boolean(state && state.legacyTracker && state.legacyTracker.hasEverWarped);
}

function rewardPayload(reward) {
  const kind = String(reward && reward.payload_type || "").trim().toUpperCase();
  if (kind === "ITEM") {
    return {
      kind: "item",
      typeID: positiveInteger(reward.type_id),
      quantity: Math.max(1, nonNegativeInteger(reward.amount, 1)),
    };
  }
  if (kind === "SP") {
    return {
      kind: "skill_points",
      points: positiveInteger(reward.amount),
    };
  }
  if (kind === "TITLE") {
    return {
      kind: "character_title",
      titleID: normalizeUUID(reward.title_id),
    };
  }
  return null;
}

async function claimRewards(characterID, source) {
  const numericCharacterID = positiveInteger(characterID);
  const sourceKind = String(source && source.sourceKind || "").trim();
  const sourceID = normalizeUUID(source && source.sourceID);
  const milestoneID = normalizeUUID(source && source.milestoneID);
  const key = sourceKey(sourceKind, sourceID, milestoneID);
  const state = getCharacterState(numericCharacterID);
  const entry = state && state.unclaimedSourcesByKey[key];
  if (!entry) {
    return { success: false, errorMsg: "REWARD_SOURCE_NOT_FOUND" };
  }

  const { grantFulfillmentToCharacter } = require(path.join(
    __dirname,
    "../newEdenStore/storeFulfillment",
  ));
  const claimedRewardIDs = [];
  for (const rewardID of normalizeStringList(entry.rewardIds)) {
    const claimKey = rewardKey(sourceKind, sourceID, milestoneID, rewardID);
    if (state.claimedRewardKeys[claimKey]) {
      claimedRewardIDs.push(rewardID);
      continue;
    }
    const payload = rewardPayload(getRewardById(rewardID));
    if (!payload || (payload.kind !== "character_title" && !payload.typeID && !payload.points)) {
      return { success: false, errorMsg: "UNSUPPORTED_REWARD" };
    }
    const grantResult = payload.kind === "character_title"
      ? grantTitle(numericCharacterID, payload.titleID, { reason: `achievement:${rewardID}` })
      : await grantFulfillmentToCharacter(numericCharacterID, payload, 1, {
        idempotencyKey: `achievement:${numericCharacterID}:${claimKey}`,
        reason: `Achievement reward ${rewardID}`,
      });
    if (!grantResult || grantResult.success !== true) {
      return grantResult || { success: false, errorMsg: "REWARD_GRANT_FAILED" };
    }
    const checkpoint = updateCharacterState(numericCharacterID, (current) => {
      current.claimedRewardKeys[claimKey] = { claimedAtMs: Date.now() };
      const currentEntry = current.unclaimedSourcesByKey[key];
      if (currentEntry) {
        currentEntry.rewardIds = currentEntry.rewardIds.filter((id) => id !== rewardID);
        if (currentEntry.rewardIds.length === 0) {
          delete current.unclaimedSourcesByKey[key];
        }
      }
      return current;
    });
    if (!checkpoint.success) {
      return checkpoint;
    }
    claimedRewardIDs.push(rewardID);
  }
  return { success: true, data: { rewardIDs: claimedRewardIDs } };
}

module.exports = {
  TABLE_NAME,
  events,
  getAchievementState,
  getCategoryState,
  getCharacterScore,
  getCharacterState,
  getEquippedTitle,
  getLegacyTrackerState,
  getOwnedTitles,
  getUnclaimedRewardSources,
  grantTitle,
  hasEverWarped,
  isEnabled,
  claimRewards,
  equipTitle,
  recordContribution,
  recordLegacyWarp,
  revokeTitle,
  resetAchievement,
  resetAll,
  unequipTitle,
  updateLegacyTracker,
};
