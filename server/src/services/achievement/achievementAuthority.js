"use strict";

const {
  cloneValue,
} = require("../../common/clone");

// The definitions are a normalized, reviewable projection of the client
// achievement catalog.  Keep it separate from character progress: it is
// static content, while progress belongs in gameStore.
const fs = require("fs");
const path = require("path");

const DATA_DIRECTORY = path.join(__dirname, "data");
const DEFINITIONS_PATH = path.join(DATA_DIRECTORY, "definitions.json");
const TITLES_PATH = path.join(DATA_DIRECTORY, "titles.json");
const ACHIEVEMENT_CDN_PATH = "/elysian-eve/achievements/latest.achv";
const CHARACTER_TITLE_CDN_PATH = "/elysian-eve/character-titles/latest.chti";

let cache = null;
let crcTable = null;

function normalizeUUID(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(normalized)
    ? normalized
    : "";
}

function normalizeVersion(value) {
  const parts = String(value || "0.0.0").trim().match(/^(\d+)\.(\d+)\.(\d+)$/);
  return {
    major: parts ? Number(parts[1]) : 0,
    minor: parts ? Number(parts[2]) : 0,
    patch: parts ? Number(parts[3]) : 0,
    prerelease_tags: [],
    build_tags: [],
  };
}

function buildCrcTable() {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    }
    table[index] = value >>> 0;
  }
  return table;
}

function crc32(buffer) {
  if (!crcTable) {
    crcTable = buildCrcTable();
  }
  let crc = 0xffffffff;
  for (const byte of Buffer.from(buffer || [])) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function loadAuthority() {
  const definitions = readJson(DEFINITIONS_PATH);
  const titles = readJson(TITLES_PATH);
  const achievementAsset = fs.readFileSync(path.join(DATA_DIRECTORY, "latest.achv"));
  const titleAsset = fs.readFileSync(path.join(DATA_DIRECTORY, "latest.chti"));
  const achievements = Array.isArray(definitions.achievements) ? definitions.achievements : [];
  const categories = Array.isArray(definitions.categories) ? definitions.categories : [];
  const contributionMethods = Array.isArray(definitions.contributionMethods)
    ? definitions.contributionMethods
    : [];
  const titleEntries = Array.isArray(titles.titles) ? titles.titles : [];
  const rewards = definitions.indexes && definitions.indexes.rewardPayloadsByRewardId
    ? definitions.indexes.rewardPayloadsByRewardId
    : {};
  return {
    definitions,
    titles,
    achievementAsset,
    titleAsset,
    achievementVersion: normalizeVersion(
      definitions.source && definitions.source.publishedAchievementVersion,
    ),
    titleVersion: normalizeVersion("1.0.0"),
    achievementCrc: crc32(achievementAsset),
    titleCrc: crc32(titleAsset),
    achievementsById: new Map(
      achievements.map((entry) => [normalizeUUID(entry && entry.id), entry]).filter(([id]) => id),
    ),
    categoriesById: new Map(
      categories.map((entry) => [normalizeUUID(entry && entry.id), entry]).filter(([id]) => id),
    ),
    contributionMethodsById: new Map(
      contributionMethods
        .map((entry) => [normalizeUUID(entry && entry.id), entry])
        .filter(([id]) => id),
    ),
    rewardsById: new Map(
      Object.entries(rewards)
        .map(([id, entry]) => [normalizeUUID(id), entry])
        .filter(([id]) => id),
    ),
    titlesById: new Map(
      titleEntries.map((entry) => [normalizeUUID(entry && entry.id), entry]).filter(([id]) => id),
    ),
  };
}

function getCache() {
  if (!cache) {
    cache = loadAuthority();
  }
  return cache;
}

function clearCacheForTesting() {
  cache = null;
}

function getAchievementById(achievementID) {
  const value = getCache().achievementsById.get(normalizeUUID(achievementID));
  return cloneValue(value || null);
}

function getCategoryById(categoryID) {
  const value = getCache().categoriesById.get(normalizeUUID(categoryID));
  return cloneValue(value || null);
}

function getContributionMethodById(methodID) {
  const value = getCache().contributionMethodsById.get(normalizeUUID(methodID));
  return cloneValue(value || null);
}

function getRewardById(rewardID) {
  const value = getCache().rewardsById.get(normalizeUUID(rewardID));
  return cloneValue(value || null);
}

function getTitleById(titleID) {
  const value = getCache().titlesById.get(normalizeUUID(titleID));
  return cloneValue(value || null);
}

function getAchievementDefinitions() {
  return cloneValue(getCache().definitions);
}

function getCharacterTitleDefinitions() {
  return cloneValue(getCache().titles);
}

function getAchievementAsset() {
  return Buffer.from(getCache().achievementAsset);
}

function getCharacterTitleAsset() {
  return Buffer.from(getCache().titleAsset);
}

function getAchievementAssetMetadata() {
  const authority = getCache();
  return {
    path: ACHIEVEMENT_CDN_PATH,
    version: cloneValue(authority.achievementVersion),
    crc: authority.achievementCrc,
  };
}

function getCharacterTitleAssetMetadata() {
  const authority = getCache();
  return {
    path: CHARACTER_TITLE_CDN_PATH,
    version: cloneValue(authority.titleVersion),
    crc: authority.titleCrc,
  };
}

module.exports = {
  ACHIEVEMENT_CDN_PATH,
  CHARACTER_TITLE_CDN_PATH,
  clearCacheForTesting,
  crc32,
  getAchievementAsset,
  getAchievementAssetMetadata,
  getAchievementById,
  getAchievementDefinitions,
  getCategoryById,
  getCharacterTitleAsset,
  getCharacterTitleAssetMetadata,
  getCharacterTitleDefinitions,
  getContributionMethodById,
  getRewardById,
  getTitleById,
  normalizeUUID,
};
