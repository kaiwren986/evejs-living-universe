"use strict";

const {
  cloneValue,
} = require("../../common/clone");

const path = require("node:path");

const database = require(path.join(__dirname, "../../gameStore"));

const TABLE_NAME = "crimewatchRuntime";
const SCHEMA_VERSION = 1;
const CHARACTER_ROW_PREFIX = "character:";
const LIMITED_ENGAGEMENT_ROW_PREFIX = "engagement:";
const DUEL_ACHIEVEMENT_ROW_PREFIX = "duel-achievement:";

function toPositiveInt(value, fallback = 0) {
  const numeric = Math.trunc(Number(value) || 0);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : fallback;
}

function buildCharacterRowKey(characterID) {
  const normalizedCharacterID = toPositiveInt(characterID, 0);
  return normalizedCharacterID > 0
    ? `${CHARACTER_ROW_PREFIX}${normalizedCharacterID}`
    : "";
}

function normalizeLimitedEngagementPair(firstCharacterID, secondCharacterID) {
  const first = toPositiveInt(firstCharacterID, 0);
  const second = toPositiveInt(secondCharacterID, 0);
  if (!first || !second || first === second) {
    return null;
  }
  return first < second
    ? [first, second]
    : [second, first];
}

function buildLimitedEngagementRowKey(firstCharacterID, secondCharacterID) {
  const pair = normalizeLimitedEngagementPair(
    firstCharacterID,
    secondCharacterID,
  );
  return pair
    ? `${LIMITED_ENGAGEMENT_ROW_PREFIX}${pair[0]}:${pair[1]}`
    : "";
}

function ensureTable() {
  database.ensureTable(TABLE_NAME);
}

function flushBoundary(result) {
  if (!result || result.success !== true) {
    return result || { success: false, errorMsg: "WRITE_ERROR" };
  }
  const flushResult = database.flushTableSync(TABLE_NAME);
  return flushResult && flushResult.success === true
    ? result
    : flushResult || { success: false, errorMsg: "FLUSH_ERROR" };
}

function getCharacterState(characterID) {
  const rowKey = buildCharacterRowKey(characterID);
  if (!rowKey) {
    return null;
  }

  ensureTable();
  const result = database.read(TABLE_NAME, `/${rowKey}`);
  if (!result || result.success !== true || !result.data) {
    return null;
  }
  const row = result.data;
  if (
    typeof row !== "object" ||
    row.kind !== "character" ||
    toPositiveInt(row.characterID, 0) !== toPositiveInt(characterID, 0)
  ) {
    return null;
  }
  const state = cloneValue(row.state);
  return state && typeof state === "object" ? state : null;
}

function listCharacterStates() {
  ensureTable();
  const result = database.read(TABLE_NAME, "/");
  const root = result && result.success === true && result.data &&
    typeof result.data === "object"
    ? result.data
    : {};

  return Object.entries(root)
    .filter(([rowKey, row]) =>
      rowKey.startsWith(CHARACTER_ROW_PREFIX) &&
      row &&
      typeof row === "object" &&
      row.kind === "character" &&
      toPositiveInt(row.characterID, 0) > 0 &&
      row.state &&
      typeof row.state === "object")
    .map(([, row]) => cloneValue(row.state));
}

function upsertCharacterState(state) {
  const characterID = toPositiveInt(state && state.characterID, 0);
  const rowKey = buildCharacterRowKey(characterID);
  if (!rowKey || !state || typeof state !== "object") {
    return { success: false, errorMsg: "INVALID_CHARACTER_STATE" };
  }

  ensureTable();
  return flushBoundary(database.write(TABLE_NAME, `/${rowKey}`, {
    schemaVersion: SCHEMA_VERSION,
    kind: "character",
    characterID,
    state: cloneValue(state),
  }));
}

function removeCharacterState(characterID) {
  const rowKey = buildCharacterRowKey(characterID);
  if (!rowKey) {
    return { success: false, errorMsg: "INVALID_CHARACTER_ID" };
  }

  ensureTable();
  const result = database.remove(TABLE_NAME, `/${rowKey}`);
  if (result && result.errorMsg === "ENTRY_NOT_FOUND") {
    return { success: true, errorMsg: null, removed: false };
  }
  return flushBoundary(result);
}

function getLimitedEngagement(firstCharacterID, secondCharacterID) {
  const pair = normalizeLimitedEngagementPair(
    firstCharacterID,
    secondCharacterID,
  );
  const rowKey = buildLimitedEngagementRowKey(
    firstCharacterID,
    secondCharacterID,
  );
  if (!pair || !rowKey) {
    return null;
  }

  ensureTable();
  const result = database.read(TABLE_NAME, `/${rowKey}`);
  if (!result || result.success !== true || !result.data) {
    return null;
  }
  const row = result.data;
  if (
    typeof row !== "object" ||
    row.kind !== "limitedEngagement" ||
    toPositiveInt(row.firstCharacterID, 0) !== pair[0] ||
    toPositiveInt(row.secondCharacterID, 0) !== pair[1]
  ) {
    return null;
  }
  const engagement = cloneValue(row.engagement);
  return engagement && typeof engagement === "object" ? engagement : null;
}

function listLimitedEngagements() {
  ensureTable();
  const result = database.read(TABLE_NAME, "/");
  const root = result && result.success === true && result.data &&
    typeof result.data === "object"
    ? result.data
    : {};

  return Object.entries(root)
    .filter(([rowKey, row]) =>
      rowKey.startsWith(LIMITED_ENGAGEMENT_ROW_PREFIX) &&
      row &&
      typeof row === "object" &&
      row.kind === "limitedEngagement" &&
      normalizeLimitedEngagementPair(
        row.firstCharacterID,
        row.secondCharacterID,
      ) &&
      row.engagement &&
      typeof row.engagement === "object")
    .map(([, row]) => cloneValue(row.engagement));
}

function upsertLimitedEngagement(engagement) {
  const pair = normalizeLimitedEngagementPair(
    engagement && engagement.firstCharacterID,
    engagement && engagement.secondCharacterID,
  );
  const rowKey = pair
    ? buildLimitedEngagementRowKey(pair[0], pair[1])
    : "";
  if (!pair || !rowKey || !engagement || typeof engagement !== "object") {
    return { success: false, errorMsg: "INVALID_LIMITED_ENGAGEMENT" };
  }

  const normalizedEngagement = {
    ...cloneValue(engagement),
    firstCharacterID: pair[0],
    secondCharacterID: pair[1],
  };
  ensureTable();
  return flushBoundary(database.write(TABLE_NAME, `/${rowKey}`, {
    schemaVersion: SCHEMA_VERSION,
    kind: "limitedEngagement",
    firstCharacterID: pair[0],
    secondCharacterID: pair[1],
    engagement: normalizedEngagement,
  }));
}

function mutateDuelRows(updater) {
  ensureTable();
  const current = database.read(TABLE_NAME, "/");
  if (!current?.success) return current;
  const previous = cloneValue(current.data || {});
  const root = cloneValue(previous);
  updater(root);
  try {
    const written = database.write(TABLE_NAME, "/", root);
    const result = flushBoundary(written);
    if (!result?.success) database.write(TABLE_NAME, "/", previous);
    return result;
  } catch (error) {
    database.write(TABLE_NAME, "/", previous);
    throw error;
  }
}

function upsertDuelEngagement(engagement, receiptID) {
  const pair = normalizeLimitedEngagementPair(engagement?.firstCharacterID, engagement?.secondCharacterID);
  const id = String(receiptID || "").trim();
  if (!pair || !/^duel-v1:\d+:\d+:\d+$/.test(id) || engagement.reason !== "DUEL") {
    return { success: false, errorMsg: "INVALID_DUEL_RECEIPT" };
  }
  return mutateDuelRows(root => {
    root[buildLimitedEngagementRowKey(...pair)] = {
      schemaVersion: SCHEMA_VERSION,
      kind: "limitedEngagement",
      firstCharacterID: pair[0],
      secondCharacterID: pair[1],
      engagement: cloneValue(engagement),
    };
    const key = DUEL_ACHIEVEMENT_ROW_PREFIX + id;
    root[key] ||= {
      schemaVersion: SCHEMA_VERSION,
      kind: "duelAchievement",
      receiptID: id,
      firstCharacterID: pair[0],
      secondCharacterID: pair[1],
    };
  });
}

function listPendingDuelAchievements() {
  ensureTable();
  const result = database.read(TABLE_NAME, "/");
  if (!result?.success) return [];
  return Object.entries(result.data || {})
    .filter(([key, row]) => key.startsWith(DUEL_ACHIEVEMENT_ROW_PREFIX)
      && row?.kind === "duelAchievement"
      && key === DUEL_ACHIEVEMENT_ROW_PREFIX + row.receiptID
      && normalizeLimitedEngagementPair(row.firstCharacterID, row.secondCharacterID))
    .map(([, row]) => cloneValue(row));
}

function acknowledgeDuelAchievement(receiptID) {
  return mutateDuelRows(root => { delete root[DUEL_ACHIEVEMENT_ROW_PREFIX + receiptID]; });
}

function removeLimitedEngagement(firstCharacterID, secondCharacterID) {
  const rowKey = buildLimitedEngagementRowKey(
    firstCharacterID,
    secondCharacterID,
  );
  if (!rowKey) {
    return { success: false, errorMsg: "INVALID_LIMITED_ENGAGEMENT" };
  }

  ensureTable();
  const result = database.remove(TABLE_NAME, `/${rowKey}`);
  if (result && result.errorMsg === "ENTRY_NOT_FOUND") {
    return { success: true, errorMsg: null, removed: false };
  }
  return flushBoundary(result);
}

function clearAll() {
  ensureTable();
  return flushBoundary(database.write(TABLE_NAME, "/", {}));
}

module.exports = {
  TABLE_NAME,
  clearAll,
  acknowledgeDuelAchievement,
  getCharacterState,
  getLimitedEngagement,
  listCharacterStates,
  listLimitedEngagements,
  listPendingDuelAchievements,
  removeCharacterState,
  removeLimitedEngagement,
  upsertCharacterState,
  upsertLimitedEngagement,
  upsertDuelEngagement,
};
