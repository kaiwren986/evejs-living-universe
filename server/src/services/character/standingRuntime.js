"use strict";

const {
  toNumber,
} = require("../../common/numbers");

const path = require("path");

const config = require(path.join(__dirname, "../../config"));
const database = require(path.join(__dirname, "../../gameStore"));
const sessionRegistry = require(path.join(__dirname, "../chat/sessionRegistry"));
const {
  buildList,
  buildMarshalReal,
} = require(path.join(__dirname, "../_shared/serviceHelpers"));
const {
  getCharacterRecord,
  updateCharacterRecord,
} = require(path.join(__dirname, "./characterState"));
const {
  getCachedCharacterSkillMap,
} = require(path.join(__dirname, "../skills/skillState"));
const {
  getAgentByID,
  listAgents,
} = require(path.join(__dirname, "../agent/agentAuthority"));
const {
  clearCache: clearNpcStandingsAuthorityCache,
  getRelationsForOwner,
  listClientNpcStandings,
  listNpcStandings: listNpcStandingsFromAuthority,
} = require(path.join(__dirname, "./npcStandingsAuthority"));
const {
  getCharacterIDsInCorporation,
  getCorporationRecord,
  getOwnerLookupRecord,
} = require(path.join(__dirname, "../corporation/corporationState"));
const {
  getAllFactionRecords,
  getFactionIDForCorporation,
  isFactionID,
} = require(path.join(__dirname, "../faction/factionState"));

const MAX_STANDING = 10.0;
const MIN_STANDING = -10.0;
const ZERO_STANDING_EPSILON = 1e-9;
const STANDING_TRANSACTION_LIMIT = 512;
const TYPE_SOCIAL = 3355;
const TYPE_NEGOTIATION = 3356;
const TYPE_DIPLOMACY = 3357;
const TYPE_FAST_TALK = 3358;
const TYPE_CONNECTIONS = 3359;
const TYPE_CRIMINAL_CONNECTIONS = 3361;
// Division Connections skills: +10% mission loyalty point gain per level, but only for
// agents in the matching corporation division. Unlike the standing skills these carry no
// dogma attribute for the bonus — TQ applies it server-side — so the level is read directly.
const TYPE_MINING_CONNECTIONS = 3893;
const TYPE_DISTRIBUTION_CONNECTIONS = 3894;
const TYPE_SECURITY_CONNECTIONS = 3895;
const DIVISION_CONNECTIONS_LP_BONUS_PER_LEVEL = 0.1;
const DIVISION_CONNECTIONS_SKILL_BY_MISSION_KIND = Object.freeze({
  mining: TYPE_MINING_CONNECTIONS,
  courier: TYPE_DISTRIBUTION_CONNECTIONS,
  distribution: TYPE_DISTRIBUTION_CONNECTIONS,
  encounter: TYPE_SECURITY_CONNECTIONS,
  security: TYPE_SECURITY_CONNECTIONS,
});
const SOCIAL_GAIN_BONUS_PER_LEVEL = 0.05;
const STANDING_BONUS_PER_LEVEL = 0.4;
const NEGOTIATION_BONUS_PER_LEVEL = 0.05;
const FAST_TALK_BONUS_PER_LEVEL = 0.05;
const ATTRIBUTE_NEGOTIATION_PERCENTAGE = 355;
const ATTRIBUTE_DIPLOMACY_BONUS = 356;
const ATTRIBUTE_FAST_TALK_PERCENTAGE = 359;
const ATTRIBUTE_CONNECTIONS_BONUS = 360;
const ATTRIBUTE_CRIMINAL_CONNECTIONS_BONUS = 361;
const ATTRIBUTE_SOCIAL_BONUS = 362;
const SOCIAL_CHARACTER_ATTRIBUTE_IDS = Object.freeze([
  ATTRIBUTE_NEGOTIATION_PERCENTAGE,
  ATTRIBUTE_DIPLOMACY_BONUS,
  ATTRIBUTE_FAST_TALK_PERCENTAGE,
  ATTRIBUTE_CONNECTIONS_BONUS,
  ATTRIBUTE_CRIMINAL_CONNECTIONS_BONUS,
  ATTRIBUTE_SOCIAL_BONUS,
]);
const STANDING_BONUS_ATTRIBUTE_BY_SKILL_TYPE = Object.freeze({
  [TYPE_CONNECTIONS]: ATTRIBUTE_CONNECTIONS_BONUS,
  [TYPE_DIPLOMACY]: ATTRIBUTE_DIPLOMACY_BONUS,
  [TYPE_CRIMINAL_CONNECTIONS]: ATTRIBUTE_CRIMINAL_CONNECTIONS_BONUS,
});

const EVENT_STANDING_RESET = 25;
const EVENT_STANDING_PLAYER_SET = 65;
const EVENT_STANDING_PLAYER_CORP_SET = 68;
const EVENT_STANDING_AGENT_MISSION_COMPLETED = 73;
const EVENT_STANDING_AGENT_MISSION_FAILED = 74;
const EVENT_STANDING_AGENT_MISSION_DECLINED = 75;
const EVENT_STANDING_AGENT_MISSION_BONUS = 80;
const EVENT_STANDING_DERIVED_POSITIVE = 82;
const EVENT_STANDING_DERIVED_NEGATIVE = 83;
const EVENT_STANDING_SLASH_SET = 84;
const EVENT_STANDING_AGENT_MISSION_OFFER_EXPIRED = 90;
const EVENT_STANDING_COMBAT_AGGRESSION = 76;
const EVENT_STANDING_CONTRABAND_TRAFFICKING = 126;
const EVENT_STANDING_GROUP_REWARD_CORPORATION = 485;
const EVENT_STANDING_GROUP_REWARD_FACTION = 486;

const DERIVED_STANDINGS_MESSAGE = "Derived standings";
const MISSION_DERIVED_FACTION_FACTOR = 0.04;

const MISSION_STANDING_EVENT_TYPE_BY_OUTCOME = Object.freeze({
  completed: EVENT_STANDING_AGENT_MISSION_COMPLETED,
  declined: EVENT_STANDING_AGENT_MISSION_DECLINED,
  failed: EVENT_STANDING_AGENT_MISSION_FAILED,
  offerExpired: EVENT_STANDING_AGENT_MISSION_OFFER_EXPIRED,
  bonus: EVENT_STANDING_AGENT_MISSION_BONUS,
});

const MISSION_STANDING_SOCIAL_BY_OUTCOME = Object.freeze({
  completed: true,
  declined: false,
  failed: false,
  offerExpired: false,
  bonus: true,
});

const PIRATE_FACTION_IDS = new Set([
  500010,
  500011,
  500012,
  500019,
  500020,
  500029,
]);

const NO_BONUS_FACTION_IDS = new Set([
  500024,
  500025,
  500026,
  500027,
]);

let cachedAgentStandingOwnerIDs = null;
let cachedFactionRecordsByName = null;
const characterStandingBucketsCache = new Map();
const corporationStandingsCache = new Map();
const standingCompositionCache = new Map();
const standingTransactionCache = new Map();
let activeImplantModifiersModule = null;

function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function getActiveImplantModifiersModule() {
  if (!activeImplantModifiersModule) {
    activeImplantModifiersModule = require(path.join(__dirname, "../dogma/implants/activeImplantModifiers"));
  }
  return activeImplantModifiersModule;
}

function normalizePositiveInteger(value, fallback = 0) {
  const numeric = toInt(value, fallback);
  return numeric > 0 ? numeric : fallback;
}

function normalizeText(value, fallback = "") {
  const text = String(value || "").trim();
  return text.length > 0 ? text : fallback;
}

function clampStanding(value) {
  return Math.max(MIN_STANDING, Math.min(MAX_STANDING, toNumber(value, 0)));
}

function roundStandingValue(value) {
  return Math.round(toNumber(value, 0) * 1000) / 1000;
}

function roundSocialAttributeValue(value) {
  return Math.round(toNumber(value, 0) * 1000000) / 1000000;
}

function applyPercentPerLevel(baseValue, percentPerLevel, level) {
  const base = toNumber(baseValue, 0);
  const normalizedLevel = Math.max(0, toInt(level, 0));
  if (!(base > 0) || !(normalizedLevel > 0) || !Number.isFinite(percentPerLevel)) {
    return base;
  }
  return base * Math.max(0, 1 + percentPerLevel * normalizedLevel);
}

function nowFileTimeString() {
  return (BigInt(Date.now()) * 10000n + 116444736000000000n).toString();
}

function normalizeStandingOwnerID(value) {
  const numeric = normalizePositiveInteger(value, 0);
  return numeric > 0 ? numeric : null;
}

function normalizeStandingEntry(entry) {
  if (!entry || typeof entry !== "object") {
    return null;
  }

  const fromID = normalizeStandingOwnerID(entry.fromID);
  const toID = normalizeStandingOwnerID(entry.toID);
  if (!fromID || !toID || fromID === toID) {
    return null;
  }

  return {
    fromID,
    toID,
    standing: clampStanding(entry.standing),
  };
}

function ensureStandingData(record) {
  if (!record.standingData || typeof record.standingData !== "object") {
    record.standingData = {};
  }
  if (!Array.isArray(record.standingData.char)) {
    record.standingData.char = [];
  }
  if (!Array.isArray(record.standingData.corp)) {
    record.standingData.corp = [];
  }
  if (!Array.isArray(record.standingData.npc)) {
    record.standingData.npc = [];
  }
  return record.standingData;
}

function ensureStandingTransactions(record) {
  if (!Array.isArray(record.standingTransactions)) {
    record.standingTransactions = [];
  }
  return record.standingTransactions;
}

function buildCharacterStandingBuckets(record) {
  return {
    charRows: getLegacyOrBucketStandingRows(record, "char")
      .map((entry) => normalizeStandingEntry(entry))
      .filter(Boolean),
    corpRows: getLegacyOrBucketStandingRows(record, "corp")
      .map((entry) => normalizeStandingEntry(entry))
      .filter(Boolean),
    npcRows: getLegacyOrBucketStandingRows(record, "npc")
      .map((entry) => normalizeStandingEntry(entry))
      .filter(Boolean),
  };
}

function getCharacterStandingBuckets(characterID) {
  const normalizedCharacterID = normalizePositiveInteger(characterID, 0);
  if (!normalizedCharacterID) {
    return {
      charRows: [],
      corpRows: [],
      npcRows: [],
    };
  }

  if (characterStandingBucketsCache.has(normalizedCharacterID)) {
    return characterStandingBucketsCache.get(normalizedCharacterID);
  }

  const record = getCharacterRecord(normalizedCharacterID);
  const buckets = buildCharacterStandingBuckets(record);
  // Composition queries ask for many owners in the same member list. Index
  // each member once instead of cloning and normalizing its full character
  // record again for every owner. Keep the first direct row ahead of legacy
  // NPC rows, exactly as getCharacterRawStandingFromRecord does.
  buckets.rawRowsByOwnerID = new Map();
  for (const row of [...buckets.charRows, ...buckets.npcRows]) {
    if (
      row.toID === normalizedCharacterID &&
      !buckets.rawRowsByOwnerID.has(row.fromID)
    ) {
      buckets.rawRowsByOwnerID.set(row.fromID, row);
    }
  }
  characterStandingBucketsCache.set(normalizedCharacterID, buckets);
  return buckets;
}

function clearStandingTransactionCacheForCharacter(characterID) {
  const normalizedCharacterID = normalizePositiveInteger(characterID, 0);
  if (!normalizedCharacterID) {
    return;
  }

  for (const key of standingTransactionCache.keys()) {
    const [, toID] = String(key).split(":");
    if (toInt(toID, 0) === normalizedCharacterID) {
      standingTransactionCache.delete(key);
    }
  }
}

function clearStandingCompositionCacheForCorporation(corporationID) {
  const normalizedCorporationID = normalizePositiveInteger(corporationID, 0);
  if (!normalizedCorporationID) {
    return;
  }

  corporationStandingsCache.delete(normalizedCorporationID);
  for (const key of standingCompositionCache.keys()) {
    const [, toID] = String(key).split(":");
    if (toInt(toID, 0) === normalizedCorporationID) {
      standingCompositionCache.delete(key);
    }
  }
}

function clearStandingRuntimeCaches(options = {}) {
  const includeStaticCaches = options && options.includeStaticCaches === true;
  characterStandingBucketsCache.clear();
  corporationStandingsCache.clear();
  standingCompositionCache.clear();
  standingTransactionCache.clear();
  if (includeStaticCaches) {
    cachedAgentStandingOwnerIDs = null;
    cachedFactionRecordsByName = null;
    clearNpcStandingsAuthorityCache();
  }
}

function invalidateStandingCachesForCharacter(characterID, record = null) {
  const normalizedCharacterID = normalizePositiveInteger(characterID, 0);
  if (!normalizedCharacterID) {
    return;
  }

  characterStandingBucketsCache.delete(normalizedCharacterID);
  clearStandingTransactionCacheForCharacter(normalizedCharacterID);
  const characterRecord = record || getCharacterRecord(normalizedCharacterID);
  clearStandingCompositionCacheForCorporation(
    normalizePositiveInteger(characterRecord && characterRecord.corporationID, 0),
  );
}

function isNpcOwner(ownerID) {
  return Boolean(getOwnerLookupRecord(normalizePositiveInteger(ownerID, 0)));
}

function readAllCharacterRecords() {
  const result = database.read("characters", "/");
  const records =
    result.success && result.data && typeof result.data === "object"
      ? result.data
      : {};
  return Object.entries(records).map(([characterID, record]) => ({
    characterID: normalizePositiveInteger(characterID, 0),
    record,
  }));
}

function getLegacyOrBucketStandingRows(record, bucketName) {
  const standingData =
    record && record.standingData && typeof record.standingData === "object"
      ? record.standingData
      : {};
  return Array.isArray(standingData[bucketName]) ? standingData[bucketName] : [];
}

function getCharacterRawStandingFromRecord(record, ownerID, characterID) {
  const normalizedOwnerID = normalizePositiveInteger(ownerID, 0);
  const normalizedCharacterID = normalizePositiveInteger(characterID, 0);
  if (!record || !normalizedOwnerID || !normalizedCharacterID) {
    return null;
  }

  const buckets = buildCharacterStandingBuckets(record);

  const directMatch = buckets.charRows.find(
    (entry) =>
      entry.fromID === normalizedOwnerID &&
      entry.toID === normalizedCharacterID,
  );
  if (directMatch) {
    return directMatch;
  }

  return buckets.npcRows.find(
    (entry) =>
      entry.fromID === normalizedOwnerID &&
      entry.toID === normalizedCharacterID,
  ) || null;
}

function listCharacterStandings(characterID) {
  const normalizedCharacterID = normalizePositiveInteger(characterID, 0);
  if (!normalizedCharacterID) {
    return [];
  }

  const buckets = getCharacterStandingBuckets(normalizedCharacterID);
  const directRows = buckets.charRows
    .filter(
      (entry) =>
        entry !== null &&
        entry.toID === normalizedCharacterID,
    );
  const legacyRows = buckets.npcRows
    .filter(
      (entry) =>
        entry !== null &&
        entry.toID === normalizedCharacterID,
    );
  const rows = directRows.length > 0 ? directRows : legacyRows;

  const deduped = new Map();
  for (const row of rows) {
    if (!deduped.has(row.fromID)) {
      deduped.set(row.fromID, row);
    }
  }

  return [...deduped.values()].sort((left, right) => left.fromID - right.fromID);
}

function listNpcStandings() {
  // standingMgr.GetNPCNPCStandings: Tranquility's own answer where the table keeps it (390 rows, the factions' with
  // each other alone; standingsvc.py 115 keeps it as npcnpcstandingsfrom), else what the relations make.
  const clientRows = listClientNpcStandings();
  if (clientRows.length) {
    return clientRows;
  }
  const authorityRows = listNpcStandingsFromAuthority();
  if (authorityRows.length) {
    return authorityRows.sort(
      (left, right) =>
        left.fromID - right.fromID ||
        left.toID - right.toID,
    );
  }

  const deduped = new Map();
  for (const { record } of readAllCharacterRecords()) {
    for (const row of getLegacyOrBucketStandingRows(record, "npc")) {
      const normalizedRow = normalizeStandingEntry(row);
      if (
        !normalizedRow ||
        !isNpcOwner(normalizedRow.fromID) ||
        !isNpcOwner(normalizedRow.toID)
      ) {
        continue;
      }
      deduped.set(
        `${normalizedRow.fromID}:${normalizedRow.toID}`,
        normalizedRow,
      );
    }
  }

  return [...deduped.values()].sort(
    (left, right) =>
      left.fromID - right.fromID ||
      left.toID - right.toID,
  );
}

function getExplicitCorporationStandingRows(corporationID) {
  const normalizedCorporationID = normalizePositiveInteger(corporationID, 0);
  if (!normalizedCorporationID) {
    return [];
  }

  const deduped = new Map();
  for (const characterID of getCharacterIDsInCorporation(normalizedCorporationID)) {
    for (const row of getCharacterStandingBuckets(characterID).corpRows) {
      if (row.toID !== normalizedCorporationID) {
        continue;
      }
      deduped.set(row.fromID, row);
    }
  }

  return [...deduped.values()].sort((left, right) => left.fromID - right.fromID);
}

function getStandingCompositions(fromID, toID) {
  const normalizedFromID = normalizePositiveInteger(fromID, 0);
  const normalizedCorporationID = normalizePositiveInteger(toID, 0);
  const corporationRecord = getCorporationRecord(normalizedCorporationID);
  if (!normalizedFromID || !corporationRecord || corporationRecord.isNPC) {
    return [];
  }

  const cacheKey = `${normalizedFromID}:${normalizedCorporationID}`;
  if (standingCompositionCache.has(cacheKey)) {
    return cloneValue(standingCompositionCache.get(cacheKey));
  }

  const rows = [];
  for (const characterID of getCharacterIDsInCorporation(normalizedCorporationID)) {
    const standingRow = getCharacterStandingBuckets(characterID)
      .rawRowsByOwnerID.get(normalizedFromID);
    if (!standingRow) {
      continue;
    }
    rows.push({
      ownerID: characterID,
      standing: roundStandingValue(standingRow.standing),
    });
  }

  rows.sort(
    (left, right) =>
      right.standing - left.standing ||
      left.ownerID - right.ownerID,
  );
  standingCompositionCache.set(cacheKey, cloneValue(rows));
  return rows;
}

function listCorporationStandings(corporationID) {
  const normalizedCorporationID = normalizePositiveInteger(corporationID, 0);
  if (!normalizedCorporationID) {
    return [];
  }

  if (corporationStandingsCache.has(normalizedCorporationID)) {
    return cloneValue(corporationStandingsCache.get(normalizedCorporationID));
  }

  const explicitRows = getExplicitCorporationStandingRows(normalizedCorporationID);
  if (explicitRows.length > 0) {
    const rows = explicitRows.map((row) => ({
      fromID: row.fromID,
      standing: roundStandingValue(row.standing),
    }));
    corporationStandingsCache.set(normalizedCorporationID, cloneValue(rows));
    return rows;
  }

  const rowsByOwnerID = new Map(
    [],
  );

  const memberStandingOwnerIDs = new Set();
  for (const characterID of getCharacterIDsInCorporation(normalizedCorporationID)) {
    for (const row of listCharacterStandings(characterID)) {
      memberStandingOwnerIDs.add(row.fromID);
    }
  }

  for (const ownerID of memberStandingOwnerIDs) {
    const compositions = getStandingCompositions(ownerID, normalizedCorporationID);
    if (!compositions.length) {
      continue;
    }
    const average =
      compositions.reduce((sum, row) => sum + toNumber(row.standing, 0), 0) /
      compositions.length;
    rowsByOwnerID.set(ownerID, {
      fromID: ownerID,
      standing: roundStandingValue(average),
    });
  }

  const rows = [...rowsByOwnerID.values()].sort((left, right) => left.fromID - right.fromID);
  corporationStandingsCache.set(normalizedCorporationID, cloneValue(rows));
  return rows;
}

function getCharacterRawStanding(characterID, ownerID) {
  const normalizedCharacterID = normalizePositiveInteger(characterID, 0);
  const normalizedOwnerID = normalizePositiveInteger(ownerID, 0);
  if (!normalizedCharacterID || !normalizedOwnerID) {
    return 0;
  }

  const characterRecord = getCharacterRecord(normalizedCharacterID);
  const row = getCharacterRawStandingFromRecord(
    characterRecord,
    normalizedOwnerID,
    normalizedCharacterID,
  );
  return row ? clampStanding(row.standing) : 0;
}

function getStandingBonusSkillTypeID(ownerID, rawStanding) {
  const factionID = getOwnerFactionID(ownerID);
  if (factionID && NO_BONUS_FACTION_IDS.has(factionID)) {
    return null;
  }

  if (toNumber(rawStanding, 0) < 0) {
    return TYPE_DIPLOMACY;
  }

  if (factionID && PIRATE_FACTION_IDS.has(factionID)) {
    return TYPE_CRIMINAL_CONNECTIONS;
  }

  return TYPE_CONNECTIONS;
}

function getOwnerFactionID(ownerID) {
  const normalizedOwnerID = normalizePositiveInteger(ownerID, 0);
  if (!normalizedOwnerID) {
    return null;
  }

  if (isFactionID(normalizedOwnerID)) {
    return normalizedOwnerID;
  }

  const agentRecord = getAgentByID(normalizedOwnerID);
  if (agentRecord && normalizePositiveInteger(agentRecord.factionID, 0)) {
    return normalizePositiveInteger(agentRecord.factionID, 0);
  }

  return getFactionIDForCorporation(normalizedOwnerID);
}

function getSkillLevel(skillMap, skillTypeID) {
  if (!(skillMap instanceof Map)) {
    return 0;
  }
  const skillRecord = skillMap.get(normalizePositiveInteger(skillTypeID, 0));
  if (!skillRecord) {
    return 0;
  }
  return Math.max(
    0,
    toInt(
      skillRecord.effectiveSkillLevel ??
        skillRecord.trainedSkillLevel ??
        skillRecord.skillLevel,
      0,
    ),
  );
}

function resolveCharacterSocialAttributes(characterID) {
  const normalizedCharacterID = normalizePositiveInteger(characterID, 0);
  if (!normalizedCharacterID) {
    return {};
  }

  const skillMap = getCachedCharacterSkillMap(normalizedCharacterID);
  const attributes = {
    [ATTRIBUTE_NEGOTIATION_PERCENTAGE]: roundSocialAttributeValue(
      applyPercentPerLevel(
        1,
        NEGOTIATION_BONUS_PER_LEVEL,
        getSkillLevel(skillMap, TYPE_NEGOTIATION),
      ),
    ),
    [ATTRIBUTE_DIPLOMACY_BONUS]: roundSocialAttributeValue(
      getSkillLevel(skillMap, TYPE_DIPLOMACY) * STANDING_BONUS_PER_LEVEL,
    ),
    [ATTRIBUTE_FAST_TALK_PERCENTAGE]: roundSocialAttributeValue(
      applyPercentPerLevel(
        1,
        FAST_TALK_BONUS_PER_LEVEL,
        getSkillLevel(skillMap, TYPE_FAST_TALK),
      ),
    ),
    [ATTRIBUTE_CONNECTIONS_BONUS]: roundSocialAttributeValue(
      getSkillLevel(skillMap, TYPE_CONNECTIONS) * STANDING_BONUS_PER_LEVEL,
    ),
    [ATTRIBUTE_CRIMINAL_CONNECTIONS_BONUS]: roundSocialAttributeValue(
      getSkillLevel(skillMap, TYPE_CRIMINAL_CONNECTIONS) * STANDING_BONUS_PER_LEVEL,
    ),
    [ATTRIBUTE_SOCIAL_BONUS]: roundSocialAttributeValue(
      applyPercentPerLevel(
        1,
        SOCIAL_GAIN_BONUS_PER_LEVEL,
        getSkillLevel(skillMap, TYPE_SOCIAL),
      ),
    ),
  };

  const {
    applyDogmaModifierGroups,
    getActiveImplantCharacterModifierEntries,
  } = getActiveImplantModifiersModule();
  applyDogmaModifierGroups(
    attributes,
    getActiveImplantCharacterModifierEntries(normalizedCharacterID).filter((entry) =>
      SOCIAL_CHARACTER_ATTRIBUTE_IDS.includes(toInt(entry && entry.modifiedAttributeID, 0)),
    ),
  );
  return attributes;
}

function getCharacterSocialAttribute(characterID, attributeID, fallback = 0) {
  const attributes = resolveCharacterSocialAttributes(characterID);
  return toNumber(attributes && attributes[attributeID], fallback);
}

function getCharacterNegotiationRewardMultiplier(characterID) {
  const multiplier = getCharacterSocialAttribute(
    characterID,
    ATTRIBUTE_NEGOTIATION_PERCENTAGE,
    1,
  );
  return multiplier > 0 ? multiplier : 1;
}

function getCharacterDivisionConnectionsLpMultiplier(characterID, missionKind) {
  const normalizedCharacterID = normalizePositiveInteger(characterID, 0);
  if (!normalizedCharacterID) {
    return 1;
  }

  const skillTypeID =
    DIVISION_CONNECTIONS_SKILL_BY_MISSION_KIND[
      String(missionKind || "").trim().toLowerCase()
    ] || 0;
  if (!skillTypeID) {
    return 1;
  }

  const skillLevel = getSkillLevel(
    getCachedCharacterSkillMap(normalizedCharacterID),
    skillTypeID,
  );
  return 1 + Math.min(5, skillLevel) * DIVISION_CONNECTIONS_LP_BONUS_PER_LEVEL;
}

function getStandingBonusForCharacter(characterID, ownerID, rawStanding) {
  const bonusSkillTypeID = getStandingBonusSkillTypeID(ownerID, rawStanding);
  if (!bonusSkillTypeID) {
    return {
      skillTypeID: null,
      bonus: 0,
    };
  }

  const attributeID = STANDING_BONUS_ATTRIBUTE_BY_SKILL_TYPE[bonusSkillTypeID] || 0;
  return {
    skillTypeID: bonusSkillTypeID,
    bonus: Math.max(0, getCharacterSocialAttribute(characterID, attributeID, 0)),
  };
}

function applyStandingBonusToValue(rawStanding, bonus) {
  const numericStanding = clampStanding(rawStanding);
  const numericBonus = Math.max(0, toNumber(bonus, 0));
  if (!(numericBonus > 0)) {
    return numericStanding;
  }

  return clampStanding(
    (1 - (1 - numericStanding / 10) * (1 - numericBonus / 10)) * 10,
  );
}

function getCharacterEffectiveStanding(characterID, ownerID) {
  const rawStanding = getCharacterRawStanding(characterID, ownerID);
  const { bonus, skillTypeID } = getStandingBonusForCharacter(
    characterID,
    ownerID,
    rawStanding,
  );
  return {
    rawStanding,
    bonus,
    skillTypeID,
    standing: applyStandingBonusToValue(rawStanding, bonus),
  };
}

function calculateStandingsByRawChange(currentStanding, rawChange) {
  const standing = clampStanding(currentStanding);
  const change = toNumber(rawChange, 0);
  if (change > 0) {
    if (standing < MAX_STANDING) {
      return roundStandingValue(
        Math.min(
          MAX_STANDING,
          10 * (1 - (1 - standing / 10) * (1 - change)),
        ),
      );
    }
    return standing;
  }

  if (change < 0) {
    if (standing > MIN_STANDING) {
      return roundStandingValue(
        Math.max(
          MIN_STANDING,
          10 * (standing / 10 + (1 + standing / 10) * change),
        ),
      );
    }
    return standing;
  }

  return standing;
}

function calculateNewStandings(rawChange) {
  return roundStandingValue(
    Math.max(Math.min(10 * toNumber(rawChange, 0), MAX_STANDING), MIN_STANDING),
  );
}

function calculateStandingsByRawChangeUnrounded(currentStanding, rawChange) {
  const standing = clampStanding(currentStanding);
  const change = toNumber(rawChange, 0);
  if (change > 0 && standing < MAX_STANDING) {
    return clampStanding(10 * (1 - (1 - standing / 10) * (1 - change)));
  }
  if (change < 0 && standing > MIN_STANDING) {
    return clampStanding(10 * (standing / 10 + (1 + standing / 10) * change));
  }
  return standing;
}

function calculateNewStandingsUnrounded(rawChange) {
  return clampStanding(10 * toNumber(rawChange, 0));
}

// The server-wide mission standing gain multiplier. Read per call so a config reload or a test
// override takes effect without a restart. An unset, blank or invalid value is 1, never 0.
function resolveMissionStandingGainMultiplier() {
  const configuredValue = config.missionStandingGainMultiplier;
  if (configuredValue === null || configuredValue === undefined || configuredValue === "") {
    return 1;
  }
  const multiplier = Number(configuredValue);
  return Number.isFinite(multiplier) && multiplier >= 0 ? multiplier : 1;
}

// A mission change carries the gain multiplier it was built with (gainMultiplier); it scales
// that change's gains, never its losses. Any other change has none and passes through. The
// value is checked again here because a pending settlement's changes are read back from storage.
function scaleMissionStandingGain(rawChange, change) {
  const gainMultiplier = change && change.gainMultiplier;
  return rawChange > 0 && Number.isFinite(gainMultiplier) && gainMultiplier >= 0
    ? rawChange * gainMultiplier
    : rawChange;
}

// The gain multiplier is server policy, not part of the operation: a retry under a changed
// setting is the same operation and reuses its receipt, so the fingerprint leaves it out.
function withoutGainMultiplier(change) {
  if (!change || !Object.prototype.hasOwnProperty.call(change, "gainMultiplier")) {
    return change;
  }
  const { gainMultiplier: _gainMultiplier, ...operation } = change;
  return operation;
}

function calculateSocialAdjustedRawChange(characterID, rawChange) {
  const baseRawChange = toNumber(rawChange, 0);
  if (baseRawChange === 0) {
    return 0;
  }

  return baseRawChange *
    Math.max(0, getCharacterSocialAttribute(characterID, ATTRIBUTE_SOCIAL_BONUS, 1));
}

function buildStandingPreview(characterID, entries = [], options = {}) {
  const normalizedCharacterID = normalizePositiveInteger(characterID, 0);
  if (!normalizedCharacterID) {
    return {};
  }

  const preview = {};
  // Per owner, the standing before the first entry and after the latest one, so
  // a second entry for an owner (a direct and a derived faction change) builds
  // on the first, as application does.
  const standingsByOwnerID = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const ownerID = normalizePositiveInteger(entry && entry.ownerID, 0);
    if (!ownerID) {
      continue;
    }
    const rawChange = scaleMissionStandingGain(
      options.applySocial === false || entry && entry.applySocial === false
        ? toNumber(entry && entry.rawChange, 0)
        : calculateSocialAdjustedRawChange(
            normalizedCharacterID,
            entry && entry.rawChange,
          ),
      entry,
    );
    if (rawChange === 0) {
      continue;
    }
    if (!standingsByOwnerID.has(ownerID)) {
      const currentRow = getCharacterRawStandingFromRecord(
        getCharacterRecord(normalizedCharacterID), ownerID, normalizedCharacterID,
      );
      const standing = currentRow ? clampStanding(currentRow.standing) : null;
      standingsByOwnerID.set(ownerID, { initial: standing || 0, current: standing });
    }
    const standings = standingsByOwnerID.get(ownerID);
    // Match application: no standing row uses the client's new-standing
    // formula; an existing row (including zero) uses its update formula.
    standings.current = standings.current === null
      ? calculateNewStandingsUnrounded(rawChange)
      : calculateStandingsByRawChangeUnrounded(standings.current, rawChange);
    // Round only the displayed delta, never the authoritative next standing.
    preview[ownerID] = roundStandingValue(standings.current - standings.initial);
  }
  return preview;
}

function buildStandingSourceIDs(characterRecord, characterID) {
  const sourceIDs = new Set([
    normalizePositiveInteger(characterID, 0),
    normalizePositiveInteger(characterRecord && characterRecord.corporationID, 0),
    normalizePositiveInteger(characterRecord && characterRecord.allianceID, 0),
    normalizePositiveInteger(characterRecord && characterRecord.factionID, 0),
    normalizePositiveInteger(characterRecord && characterRecord.warFactionID, 0),
  ]);
  sourceIDs.delete(0);
  return sourceIDs;
}

function resolveBestStandingValue(characterID, targetOwnerIDs = []) {
  const normalizedCharacterID = normalizePositiveInteger(characterID, 0);
  if (!normalizedCharacterID) {
    return {
      standing: 0,
      matchedOwnerID: 0,
      matchedSourceID: 0,
      matchedEntry: null,
    };
  }

  const characterRecord = getCharacterRecord(normalizedCharacterID);
  if (!characterRecord) {
    return {
      standing: 0,
      matchedOwnerID: 0,
      matchedSourceID: 0,
      matchedEntry: null,
    };
  }

  const sourceIDs = buildStandingSourceIDs(characterRecord, normalizedCharacterID);
  const targetSet = new Set(
    (Array.isArray(targetOwnerIDs) ? targetOwnerIDs : [targetOwnerIDs])
      .map((ownerID) => normalizePositiveInteger(ownerID, 0))
      .filter((ownerID) => ownerID > 0),
  );
  const buckets = getCharacterStandingBuckets(normalizedCharacterID);
  let bestMatch = null;
  let bestPriority = -1;
  let bestAbsoluteStanding = -1;

  for (const [priorityFloor, rows] of [
    [3, buckets.charRows],
    [2, buckets.corpRows],
    [2, buckets.npcRows],
  ]) {
    for (const entry of rows) {
      if (!entry || !sourceIDs.has(entry.fromID) || !targetSet.has(entry.toID)) {
        continue;
      }
      const priority =
        entry.fromID === normalizedCharacterID
          ? 3
          : priorityFloor;
      const absoluteStanding = Math.abs(entry.standing);
      if (
        !bestMatch ||
        priority > bestPriority ||
        (priority === bestPriority && absoluteStanding > bestAbsoluteStanding)
      ) {
        bestMatch = {
          standing: roundStandingValue(entry.standing),
          matchedOwnerID: entry.toID,
          matchedSourceID: entry.fromID,
          matchedEntry: entry,
        };
        bestPriority = priority;
        bestAbsoluteStanding = absoluteStanding;
      }
    }
  }

  return bestMatch || {
    standing: 0,
    matchedOwnerID: 0,
    matchedSourceID: 0,
    matchedEntry: null,
  };
}

function canCharacterUseAgent(characterID, agentRecord) {
  const normalizedCharacterID = normalizePositiveInteger(characterID, 0);
  const level = Math.max(1, toInt(agentRecord && agentRecord.level, 1));
  const agentTypeID = normalizePositiveInteger(agentRecord && agentRecord.agentTypeID, 0);
  if (!normalizedCharacterID || !agentTypeID) {
    return false;
  }

  // Match CCP eveCfg.CanUseAgent: Aura is always usable.
  if (agentTypeID === 11) {
    return true;
  }

  // Retail allows level 1 agents without a standings gate except research agents.
  if (level === 1 && agentTypeID !== 4) {
    return true;
  }

  const factionStanding = getCharacterEffectiveStanding(
    normalizedCharacterID,
    agentRecord && agentRecord.factionID,
  ).standing;
  const corporationStanding = getCharacterEffectiveStanding(
    normalizedCharacterID,
    agentRecord && agentRecord.corporationID,
  ).standing;
  const agentStanding = getCharacterEffectiveStanding(
    normalizedCharacterID,
    agentRecord && agentRecord.agentID,
  ).standing;
  const threshold = (level - 1) * 2.0 - 1.0;

  if (
    Math.max(factionStanding, corporationStanding, agentStanding) >= threshold &&
    Math.min(factionStanding, corporationStanding, agentStanding) > -2.0
  ) {
    if (agentTypeID === 4 && corporationStanding < threshold - 2.0) {
      return false;
    }
    return true;
  }

  return false;
}

function normalizeStandingTransaction(entry) {
  if (!entry || typeof entry !== "object") {
    return null;
  }

  const fromID = normalizePositiveInteger(entry.fromID, 0);
  const toID = normalizePositiveInteger(entry.toID, 0);
  const eventTypeID = toInt(entry.eventTypeID, 0);
  if (!fromID || !toID || !eventTypeID) {
    return null;
  }

  return {
    fromID,
    toID,
    eventTypeID,
    eventDateTime: normalizeText(entry.eventDateTime, nowFileTimeString()),
    modification: toNumber(entry.modification, 0),
    msg: normalizeText(entry.msg, ""),
    int_1: entry.int_1 == null ? null : toInt(entry.int_1, 0),
    int_2: entry.int_2 == null ? null : toInt(entry.int_2, 0),
    int_3: entry.int_3 == null ? null : toInt(entry.int_3, 0),
  };
}

function appendStandingTransaction(record, transaction) {
  const transactions = ensureStandingTransactions(record);
  const normalized = normalizeStandingTransaction(transaction);
  if (!normalized) {
    return;
  }
  transactions.unshift(normalized);
  if (transactions.length > STANDING_TRANSACTION_LIMIT) {
    transactions.length = STANDING_TRANSACTION_LIMIT;
  }
}

function getStandingTransactions(fromID, toID) {
  const normalizedFromID = normalizePositiveInteger(fromID, 0);
  const normalizedToID = normalizePositiveInteger(toID, 0);
  const characterRecord = getCharacterRecord(normalizedToID);
  if (!normalizedFromID || !characterRecord) {
    return [];
  }

  const cacheKey = `${normalizedFromID}:${normalizedToID}`;
  if (standingTransactionCache.has(cacheKey)) {
    return cloneValue(standingTransactionCache.get(cacheKey));
  }

  const rows = ensureStandingTransactions(characterRecord)
    .map((entry) => normalizeStandingTransaction(entry))
    .filter(
      (entry) =>
        entry &&
        entry.fromID === normalizedFromID &&
        entry.toID === normalizedToID,
    )
    .sort((left, right) =>
      String(right.eventDateTime).localeCompare(String(left.eventDateTime)),
    );
  standingTransactionCache.set(cacheKey, cloneValue(rows));
  return rows;
}

function upsertStandingRow(rows, fromID, toID, standing, options = {}) {
  const normalizedFromID = normalizePositiveInteger(fromID, 0);
  const normalizedToID = normalizePositiveInteger(toID, 0);
  const normalizedStanding = options.preservePrecision === true
    ? clampStanding(standing)
    : roundStandingValue(standing);
  if (!normalizedFromID || !normalizedToID || normalizedFromID === normalizedToID) {
    return;
  }

  const index = rows.findIndex((row) => {
    const normalizedRow = normalizeStandingEntry(row);
    return (
      normalizedRow &&
      normalizedRow.fromID === normalizedFromID &&
      normalizedRow.toID === normalizedToID
    );
  });

  if (Math.abs(normalizedStanding) <= ZERO_STANDING_EPSILON) {
    if (index >= 0) {
      rows.splice(index, 1);
    }
    return;
  }

  const nextRow = {
    fromID: normalizedFromID,
    toID: normalizedToID,
    standing: clampStanding(normalizedStanding),
  };
  if (index >= 0) {
    rows[index] = nextRow;
    return;
  }
  rows.push(nextRow);
}

function notifyStandingSet(characterID, fromID, toID, standing) {
  const normalizedCharacterID = normalizePositiveInteger(characterID, 0);
  if (!normalizedCharacterID) {
    return;
  }

  for (const session of sessionRegistry.getSessions()) {
    if (
      normalizePositiveInteger(session && session.characterID, 0) !== normalizedCharacterID ||
      typeof session.sendNotification !== "function"
    ) {
      continue;
    }
    session.sendNotification("OnStandingSet", "clientID", [
      normalizePositiveInteger(fromID, 0),
      normalizePositiveInteger(toID, 0),
      toNumber(standing, 0),
    ]);
  }
}

function notifyStandingsModified(characterID, modifications) {
  const normalizedCharacterID = normalizePositiveInteger(characterID, 0);
  if (!normalizedCharacterID || !Array.isArray(modifications) || !modifications.length) {
    return;
  }

  for (const session of sessionRegistry.getSessions()) {
    if (
      normalizePositiveInteger(session && session.characterID, 0) !== normalizedCharacterID ||
      typeof session.sendNotification !== "function"
    ) {
      continue;
    }
    const wireRows = modifications.map((entry) => buildList([
      normalizePositiveInteger(entry && entry[0], 0),
      normalizePositiveInteger(entry && entry[1], 0),
      buildMarshalReal(entry && entry[2]),
      buildMarshalReal(entry && entry[3]),
      buildMarshalReal(entry && entry[4]),
    ]));
    session.sendNotification("OnStandingsModified", "charid", [
      buildList(wireRows),
    ]);
  }
}

// Whether an apply under the key was recorded. Own keys only: "constructor" or
// "__proto__" is no receipt unless an apply recorded it. A failed store read
// reaches the caller, so it never passes for an unused key.
function hasStandingOperationReceipt(characterID, idempotencyKey) {
  const record = getCharacterRecord(characterID);
  const receipts = record && record.standingOperationReceipts &&
    typeof record.standingOperationReceipts === "object"
    ? record.standingOperationReceipts
    : {};
  return Object.prototype.hasOwnProperty.call(receipts, idempotencyKey);
}

function applyStandingChanges(characterID, changes = [], options = {}) {
  const normalizedCharacterID = normalizePositiveInteger(characterID, 0);
  if (!normalizedCharacterID || !Array.isArray(changes) || !changes.length) {
    return {
      success: false,
      errorMsg: "STANDING_CHANGE_REQUIRED",
    };
  }

  const hasIdempotencyKey = Object.prototype.hasOwnProperty.call(
    options,
    "idempotencyKey",
  );
  const idempotencyKey = hasIdempotencyKey
    ? String(options.idempotencyKey || "").trim()
    : "";
  if (hasIdempotencyKey && !idempotencyKey) {
    return { success: false, errorMsg: "IDEMPOTENCY_KEY_INVALID" };
  }
  const idempotencyFingerprint = idempotencyKey
    ? JSON.stringify({
        characterID: normalizedCharacterID,
        changes: changes.map(withoutGainMultiplier),
        disableDerived: options.disableDerived === true,
        preservePrecision: options.preservePrecision === true,
      })
    : "";
  if (idempotencyKey) {
    const currentRecord = getCharacterRecord(normalizedCharacterID);
    const receipts = currentRecord && currentRecord.standingOperationReceipts &&
      typeof currentRecord.standingOperationReceipts === "object"
      ? currentRecord.standingOperationReceipts
      : {};
    const existingReceipt = receipts[idempotencyKey];
    if (existingReceipt) {
      if (existingReceipt.fingerprint !== idempotencyFingerprint) {
        return { success: false, errorMsg: "IDEMPOTENCY_KEY_REUSED" };
      }
      return {
        success: true,
        duplicate: true,
        data: cloneValue(existingReceipt.result || {
          modifications: [],
          appliedChanges: [],
        }),
      };
    }
  }

  const modifications = [];
  const appliedChanges = [];
  const notificationBatches = new Map();
  const derivedAccumulator = new Map();
  const writeResult = updateCharacterRecord(normalizedCharacterID, (record) => {
    const standingData = ensureStandingData(record);
    for (const change of changes) {
      const ownerID = normalizePositiveInteger(change && change.ownerID, 0);
      if (!ownerID) {
        continue;
      }
      const socialAdjustedRawChange = change && change.applySocial === false
        ? toNumber(change.rawChange, 0)
        : calculateSocialAdjustedRawChange(normalizedCharacterID, change && change.rawChange);
      const scaledRawChange = scaleMissionStandingGain(socialAdjustedRawChange, change);
      // Pending pre-precision settlements retain their accepted arithmetic as
      // well as their receipt fingerprint. New settlements freeze true.
      const keepPrecision = options.preservePrecision === true || change && change.applySocial === false;
      const rawChange = keepPrecision ? scaledRawChange : roundStandingValue(scaledRawChange);
      // Derived standings start from the unscaled change, and each is scaled only if it is a
      // gain: a mission gain's derived loss is not multiplied.
      const unscaledRawChange = keepPrecision
        ? socialAdjustedRawChange
        : roundStandingValue(socialAdjustedRawChange);
      if (Math.abs(unscaledRawChange) <= ZERO_STANDING_EPSILON) {
        continue;
      }

      if (!options.disableDerived && change.propagate !== false) {
        for (const relation of getRelationsForOwner(ownerID)) {
          const targetID = normalizePositiveInteger(relation && relation.toID, 0);
          const relationValue = toNumber(
            relation && (
              Object.prototype.hasOwnProperty.call(relation, "propagationMultiplier")
                ? relation.propagationMultiplier
                : relation.standing
            ),
            0,
          );
          if (!targetID || targetID === ownerID || !Number.isFinite(relationValue)) {
            continue;
          }
          const derivedRawChange = scaleMissionStandingGain(unscaledRawChange * relationValue, change);
          if (Math.abs(derivedRawChange) <= ZERO_STANDING_EPSILON) {
            continue;
          }
          const existing = derivedAccumulator.get(targetID);
          if (existing) {
            existing.rawChange += derivedRawChange;
            continue;
          }
          derivedAccumulator.set(targetID, {
            rawChange: derivedRawChange,
            sourceOwnerID: ownerID,
          });
        }
      }

      // A gain the multiplier takes to zero writes no row of its own, but its derived losses
      // above still apply.
      if (Math.abs(rawChange) <= ZERO_STANDING_EPSILON) {
        continue;
      }

      const currentRow = getCharacterRawStandingFromRecord(
        record,
        ownerID,
        normalizedCharacterID,
      );
      const currentStanding = currentRow ? currentRow.standing : 0;
      const nextStanding = options.preservePrecision === true
        ? currentRow
          ? calculateStandingsByRawChangeUnrounded(currentStanding, rawChange)
          : calculateNewStandingsUnrounded(rawChange)
        : currentRow
          ? calculateStandingsByRawChange(currentStanding, rawChange)
          : calculateNewStandings(rawChange);

      upsertStandingRow(
        standingData.char,
        ownerID,
        normalizedCharacterID,
        nextStanding,
        { preservePrecision: options.preservePrecision === true },
      );
      const modification = [
        ownerID,
        normalizedCharacterID,
        rawChange,
        toNumber(change && change.notificationMin, MIN_STANDING),
        toNumber(change && change.notificationMax, MAX_STANDING),
      ];
      modifications.push(modification);
      const notificationGroup = normalizeText(
        change && change.notificationGroup,
        "",
      );
      if (notificationGroup) {
        if (!notificationBatches.has(notificationGroup)) {
          notificationBatches.set(notificationGroup, []);
        }
        notificationBatches.get(notificationGroup).push(modification);
      }
      appliedChanges.push({
        fromID: ownerID,
        toID: normalizedCharacterID,
        rawChange,
        previousStanding: currentStanding,
        standing: nextStanding,
      });

      appendStandingTransaction(record, {
        fromID: ownerID,
        toID: normalizedCharacterID,
        eventTypeID: toInt(
          change && change.eventTypeID,
          EVENT_STANDING_AGENT_MISSION_COMPLETED,
        ),
        eventDateTime: nowFileTimeString(),
        modification: rawChange,
        msg: normalizeText(change && change.msg, ""),
        int_1:
          change && Object.prototype.hasOwnProperty.call(change, "int_1")
            ? change.int_1
            : null,
        int_2:
          change && Object.prototype.hasOwnProperty.call(change, "int_2")
            ? change.int_2
            : null,
        int_3:
          change && Object.prototype.hasOwnProperty.call(change, "int_3")
            ? change.int_3
            : null,
      });
    }

    for (const [targetOwnerID, derived] of derivedAccumulator.entries()) {
      const derivedRawChange = toNumber(derived && derived.rawChange, 0);
      if (Math.abs(derivedRawChange) <= ZERO_STANDING_EPSILON) {
        continue;
      }

      const currentRow = getCharacterRawStandingFromRecord(
        record,
        targetOwnerID,
        normalizedCharacterID,
      );
      const currentStanding = currentRow ? currentRow.standing : 0;
      const nextStanding = options.preservePrecision === true
        ? currentRow
          ? calculateStandingsByRawChangeUnrounded(currentStanding, derivedRawChange)
          : calculateNewStandingsUnrounded(derivedRawChange)
        : currentRow
          ? calculateStandingsByRawChange(currentStanding, derivedRawChange)
          : calculateNewStandings(derivedRawChange);

      upsertStandingRow(
        standingData.char,
        targetOwnerID,
        normalizedCharacterID,
        nextStanding,
        { preservePrecision: options.preservePrecision === true },
      );

      const modification = [
        targetOwnerID,
        normalizedCharacterID,
        derivedRawChange,
        MIN_STANDING,
        MAX_STANDING,
      ];
      modifications.push(modification);
      if (!notificationBatches.has("derived")) {
        notificationBatches.set("derived", []);
      }
      notificationBatches.get("derived").push(modification);
      appliedChanges.push({
        fromID: targetOwnerID,
        toID: normalizedCharacterID,
        rawChange: derivedRawChange,
        previousStanding: currentStanding,
        standing: nextStanding,
      });

      appendStandingTransaction(record, {
        fromID: targetOwnerID,
        toID: normalizedCharacterID,
        eventTypeID:
          derivedRawChange >= 0
            ? EVENT_STANDING_DERIVED_POSITIVE
            : EVENT_STANDING_DERIVED_NEGATIVE,
        eventDateTime: nowFileTimeString(),
        modification: derivedRawChange,
        msg: DERIVED_STANDINGS_MESSAGE,
        int_1: derived && derived.sourceOwnerID ? derived.sourceOwnerID : null,
        int_2: null,
        int_3: null,
      });
    }

    if (idempotencyKey) {
      const receipts = record.standingOperationReceipts &&
        typeof record.standingOperationReceipts === "object"
        ? { ...record.standingOperationReceipts }
        : {};
      receipts[idempotencyKey] = {
        fingerprint: idempotencyFingerprint,
        result: cloneValue({ modifications, appliedChanges }),
        createdAt: new Date().toISOString(),
      };
      record.standingOperationReceipts = receipts;
    }

    return record;
  });

  if (!writeResult.success) {
    return writeResult;
  }

  invalidateStandingCachesForCharacter(normalizedCharacterID);

  if (modifications.length) {
    if (options.splitNotificationGroups === true && notificationBatches.size) {
      for (const batch of notificationBatches.values()) {
        notifyStandingsModified(normalizedCharacterID, batch);
      }
    } else {
      notifyStandingsModified(normalizedCharacterID, modifications);
    }
  }

  return {
    success: true,
    data: {
      modifications,
      appliedChanges,
    },
  };
}

function setCharacterStandings(characterID, entries = [], options = {}) {
  const normalizedCharacterID = normalizePositiveInteger(characterID, 0);
  if (!normalizedCharacterID || !Array.isArray(entries) || !entries.length) {
    return {
      success: false,
      errorMsg: "STANDING_ENTRY_REQUIRED",
    };
  }

  const appliedChanges = [];
  const writeResult = updateCharacterRecord(normalizedCharacterID, (record) => {
    const standingData = ensureStandingData(record);
    for (const entry of entries) {
      const ownerID = normalizePositiveInteger(entry && entry.ownerID, 0);
      if (!ownerID) {
        continue;
      }
      const currentRow = getCharacterRawStandingFromRecord(
        record,
        ownerID,
        normalizedCharacterID,
      );
      const currentStanding = currentRow ? currentRow.standing : 0;
      const nextStanding = clampStanding(entry && entry.standing);

      if (
        currentRow &&
        Math.abs(currentStanding - nextStanding) <= ZERO_STANDING_EPSILON
      ) {
        continue;
      }

      upsertStandingRow(
        standingData.char,
        ownerID,
        normalizedCharacterID,
        nextStanding,
      );

      const eventTypeID =
        Math.abs(nextStanding) <= ZERO_STANDING_EPSILON
          ? EVENT_STANDING_RESET
          : toInt(options.eventTypeID, EVENT_STANDING_SLASH_SET);
      appendStandingTransaction(record, {
        fromID: ownerID,
        toID: normalizedCharacterID,
        eventTypeID,
        eventDateTime: nowFileTimeString(),
        modification: roundStandingValue((nextStanding - currentStanding) / 10),
        msg: normalizeText(options.message, ""),
        int_1: ownerID,
        int_2: null,
        int_3: null,
      });

      appliedChanges.push({
        fromID: ownerID,
        toID: normalizedCharacterID,
        previousStanding: roundStandingValue(currentStanding),
        standing: roundStandingValue(nextStanding),
      });
    }

    return record;
  });

  if (!writeResult.success) {
    return writeResult;
  }

  invalidateStandingCachesForCharacter(normalizedCharacterID);

  for (const entry of appliedChanges) {
    notifyStandingSet(
      normalizedCharacterID,
      entry.fromID,
      entry.toID,
      entry.standing,
    );
  }

  return {
    success: true,
    data: {
      appliedChanges,
    },
  };
}

function setCharacterStanding(characterID, ownerID, standing, options = {}) {
  return setCharacterStandings(
    characterID,
    [{ ownerID, standing }],
    options,
  );
}

function escapeProtocolZeroPickleString(value) {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/'/g, "\\'");
}

function buildProtocolZeroPickleHexFromDict(payload = {}) {
  const entries = Object.entries(payload)
    .map(([key, value]) => [
      normalizeText(key, ""),
      value == null ? "" : String(value),
    ])
    .filter(([key]) => key.length > 0);
  if (entries.length <= 0) {
    return "";
  }

  const lines = ["(dp0"];
  let pointer = 1;
  for (const [key, value] of entries) {
    lines.push(`S'${escapeProtocolZeroPickleString(key)}'`);
    lines.push(`p${pointer}`);
    pointer += 1;
    lines.push(`S'${escapeProtocolZeroPickleString(value)}'`);
    lines.push(`p${pointer}`);
    pointer += 1;
    lines.push("s");
  }
  lines.push(".");
  return Buffer.from(`${lines.join("\n")}\n`, "ascii").toString("hex");
}

function normalizeMissionStandingOutcome(outcome = "completed") {
  const normalizedOutcome = normalizeText(outcome, "completed");
  return Object.prototype.hasOwnProperty.call(
    MISSION_STANDING_EVENT_TYPE_BY_OUTCOME,
    normalizedOutcome,
  )
    ? normalizedOutcome
    : "completed";
}

function resolveMissionStandingEventDefinition(rewards, outcome) {
  const normalizedOutcome = normalizeMissionStandingOutcome(outcome);
  if (
    rewards &&
    rewards.standingEvents &&
    typeof rewards.standingEvents === "object" &&
    rewards.standingEvents[normalizedOutcome] &&
    typeof rewards.standingEvents[normalizedOutcome] === "object"
  ) {
    return rewards.standingEvents[normalizedOutcome];
  }

  if (normalizedOutcome === "completed") {
    return rewards && rewards.rawStandings && typeof rewards.rawStandings === "object"
      ? rewards.rawStandings
      : {};
  }

  const legacyKey = `${normalizedOutcome}RawStandings`;
  return rewards && rewards[legacyKey] && typeof rewards[legacyKey] === "object"
    ? rewards[legacyKey]
    : {};
}

function buildMissionStandingMessage(outcome, missionName, eventDefinition = {}) {
  if (normalizeMissionStandingOutcome(outcome) !== "bonus") {
    return normalizeText(eventDefinition.msg, missionName);
  }

  const explicitMessage = normalizeText(eventDefinition.msg, "");
  if (explicitMessage) {
    return explicitMessage;
  }

  const header = normalizeText(eventDefinition.messageHeader, missionName);
  const body = normalizeText(
    eventDefinition.messageBody,
    `${missionName} bonus standing adjustment`,
  );
  return buildProtocolZeroPickleHexFromDict({
    header,
    body,
  });
}

// `share`, for a completion only, builds one fleet share recipient's part instead of the whole
// gain: { completingPilot, partOf(rawChange) }, as Mission turn-in divides it.
function buildMissionOutcomeStandingChanges(
  agentRecord,
  missionRecord,
  outcome = "completed",
  share = null,
) {
  const rewards =
    missionRecord && missionRecord.rewards && typeof missionRecord.rewards === "object"
      ? missionRecord.rewards
      : {};
  const normalizedOutcome = normalizeMissionStandingOutcome(outcome);
  const eventDefinition = resolveMissionStandingEventDefinition(
    rewards,
    normalizedOutcome,
  );
  const rawStandings =
    eventDefinition && eventDefinition.rawStandings && typeof eventDefinition.rawStandings === "object"
      ? eventDefinition.rawStandings
      : eventDefinition;
  const missionName = normalizeText(
    missionRecord && missionRecord.missionTitle,
    normalizeText(missionRecord && missionRecord.contentID, "Placeholder Mission"),
  );
  const eventTypeID =
    toInt(eventDefinition && eventDefinition.eventTypeID, 0) ||
    MISSION_STANDING_EVENT_TYPE_BY_OUTCOME[normalizedOutcome];
  const applySocial =
    eventDefinition && Object.prototype.hasOwnProperty.call(eventDefinition, "applySocial")
      ? eventDefinition.applySocial === true
      : MISSION_STANDING_SOCIAL_BY_OUTCOME[normalizedOutcome] === true;
  const msg = buildMissionStandingMessage(
    normalizedOutcome,
    missionName,
    eventDefinition,
  );
  const notificationMin = toNumber(
    eventDefinition && eventDefinition.notificationMin,
    MIN_STANDING,
  );
  const notificationMax = toNumber(
    eventDefinition && eventDefinition.notificationMax,
    MAX_STANDING,
  );
  const notificationGroup = normalizeText(
    eventDefinition && eventDefinition.notificationGroup,
    "",
  );

  const directChanges = [
    {
      ownerID: normalizePositiveInteger(agentRecord && agentRecord.corporationID, 0),
      rawChange: toNumber(rawStandings.corporation, 0),
      eventTypeID,
      applySocial,
      msg,
      notificationMin,
      notificationMax,
      notificationGroup,
      int_1:
        eventDefinition && Object.prototype.hasOwnProperty.call(eventDefinition, "int_1")
          ? eventDefinition.int_1
          : null,
      int_2:
        eventDefinition && Object.prototype.hasOwnProperty.call(eventDefinition, "int_2")
          ? eventDefinition.int_2
          : null,
      int_3:
        eventDefinition && Object.prototype.hasOwnProperty.call(eventDefinition, "int_3")
          ? eventDefinition.int_3
          : null,
    },
    {
      ownerID: normalizePositiveInteger(agentRecord && agentRecord.factionID, 0),
      rawChange: toNumber(rawStandings.faction, 0),
      eventTypeID,
      applySocial,
      msg,
      notificationMin,
      notificationMax,
      notificationGroup,
      int_1:
        eventDefinition && Object.prototype.hasOwnProperty.call(eventDefinition, "int_1")
          ? eventDefinition.int_1
          : null,
      int_2:
        eventDefinition && Object.prototype.hasOwnProperty.call(eventDefinition, "int_2")
          ? eventDefinition.int_2
          : null,
      int_3:
        eventDefinition && Object.prototype.hasOwnProperty.call(eventDefinition, "int_3")
          ? eventDefinition.int_3
          : null,
    },
    {
      ownerID: normalizePositiveInteger(agentRecord && agentRecord.agentID, 0),
      rawChange: toNumber(rawStandings.agent, 0),
      eventTypeID,
      applySocial,
      msg,
      notificationMin,
      notificationMax,
      notificationGroup,
      int_1:
        eventDefinition && Object.prototype.hasOwnProperty.call(eventDefinition, "int_1")
          ? eventDefinition.int_1
          : null,
      int_2:
        eventDefinition && Object.prototype.hasOwnProperty.call(eventDefinition, "int_2")
          ? eventDefinition.int_2
          : null,
      int_3:
        eventDefinition && Object.prototype.hasOwnProperty.call(eventDefinition, "int_3")
          ? eventDefinition.int_3
          : null,
    },
  ];
  const derivedChanges = Array.isArray(eventDefinition && eventDefinition.derivedStandings)
    ? eventDefinition.derivedStandings.map((entry) => ({
        ownerID: normalizePositiveInteger(entry && entry.ownerID, 0),
        rawChange: toNumber(entry && entry.rawChange, 0),
        eventTypeID: toInt(
          entry && entry.eventTypeID,
          EVENT_STANDING_DERIVED_NEGATIVE,
        ),
        applySocial: entry && entry.applySocial === true,
        msg: normalizeText(entry && entry.msg, msg),
        notificationMin: toNumber(
          entry && entry.notificationMin,
          MIN_STANDING,
        ),
        notificationMax: toNumber(
          entry && entry.notificationMax,
          MAX_STANDING,
        ),
        notificationGroup: normalizeText(
          entry && entry.notificationGroup,
          "derived",
        ),
        int_1:
          entry && Object.prototype.hasOwnProperty.call(entry, "int_1")
            ? entry.int_1
            : null,
        int_2:
          entry && Object.prototype.hasOwnProperty.call(entry, "int_2")
            ? entry.int_2
            : null,
        int_3:
          entry && Object.prototype.hasOwnProperty.call(entry, "int_3")
            ? entry.int_3
            : null,
      }))
    : [];

  // A mission's faction standing bonus (extraStandings): a direct gain that triggers no derived
  // standings.
  const extraChanges = Array.isArray(eventDefinition && eventDefinition.extraStandings)
    ? eventDefinition.extraStandings.map((entry) => ({
        ownerID: normalizePositiveInteger(entry && entry.ownerID, 0),
        rawChange: toNumber(entry && entry.rawChange, 0),
        eventTypeID,
        applySocial,
        msg,
        notificationMin,
        notificationMax,
        notificationGroup,
        propagate: false,
        int_1: null,
        int_2: null,
        int_3: null,
      }))
    : [];

  const orderedDirectChanges = normalizedOutcome === "failed" ||
    normalizedOutcome === "declined" && eventDefinition.notificationGroup === "direct"
    ? [directChanges[2], directChanges[0], directChanges[1]]
    : directChanges;
  // Each change carries the gain multiplier it is built with, so a settlement that stores its
  // changes keeps the value it was prepared under. At 1 the changes carry nothing, exactly as
  // before the setting existed.
  const gainMultiplier = resolveMissionStandingGainMultiplier();
  if (normalizedOutcome === "completed") {
    const keepsWhole = !share || share.completingPilot === true;
    return buildMissionCompletionStandingChanges(
      agentRecord,
      eventDefinition,
      [
        ...shareMissionCompletionDirectChanges(agentRecord, orderedDirectChanges, share),
        ...(keepsWhole ? extraChanges : []),
      ],
      keepsWhole ? derivedChanges : [],
    ).map((entry) => (gainMultiplier === 1 ? entry : { ...entry, gainMultiplier }));
  }
  return [...orderedDirectChanges, ...extraChanges, ...derivedChanges].filter(
    (entry) =>
      entry.ownerID > 0 &&
      Math.abs(entry.rawChange) > ZERO_STANDING_EPSILON,
  ).map((entry) => (gainMultiplier === 1 ? entry : { ...entry, gainMultiplier }));
}

// A fleet share recipient's direct changes (doc/FLEET_SHARES.md -> Mission turn-in): their part
// of the agent's, the corporation's and the faction's gains (an important mission's direct
// faction gain), as `share.partOf` divides them. Any other direct change stays whole with the
// completing pilot. The faction change derived from the corporation then follows the
// recipient's own part.
function shareMissionCompletionDirectChanges(agentRecord, directChanges, share) {
  if (!share) {
    return directChanges;
  }
  const sharedOwnerIDs = new Set([
    normalizePositiveInteger(agentRecord && agentRecord.agentID, 0),
    normalizePositiveInteger(agentRecord && agentRecord.corporationID, 0),
    normalizePositiveInteger(agentRecord && agentRecord.factionID, 0),
  ].filter((ownerID) => ownerID > 0));
  return directChanges.flatMap((entry) => {
    if (sharedOwnerIDs.has(entry.ownerID)) {
      return [{ ...entry, rawChange: share.partOf(entry.rawChange) }];
    }
    return share.completingPilot === true ? [entry] : [];
  });
}

// A completion moves the agent and its corporation directly, and the faction by
// one derived change of the corporation's gain x 0.04. Nothing spreads through
// the NPC relation graph, whose x1 multipliers would hand the faction the
// corporation's whole gain and move friend and enemy corporations.
// A captured completion that lists its own derived rows keeps them as captured.
function buildMissionCompletionStandingChanges(
  agentRecord,
  eventDefinition,
  directChanges,
  derivedChanges,
) {
  const corporationID = normalizePositiveInteger(agentRecord && agentRecord.corporationID, 0);
  const corporationChange = directChanges.find((entry) => entry.ownerID === corporationID);
  const capturedDerived = Array.isArray(eventDefinition && eventDefinition.derivedStandings);
  const derivedRawChange = corporationChange
    ? corporationChange.rawChange * MISSION_DERIVED_FACTION_FACTOR
    : 0;
  const factionDerivedChanges = capturedDerived || !corporationChange
    ? derivedChanges
    : [{
        ownerID: normalizePositiveInteger(agentRecord && agentRecord.factionID, 0),
        rawChange: derivedRawChange,
        eventTypeID: derivedRawChange >= 0
          ? EVENT_STANDING_DERIVED_POSITIVE
          : EVENT_STANDING_DERIVED_NEGATIVE,
        // Social boosts the corporation's gain, so the change derived from it
        // carries the same boost.
        applySocial: corporationChange.applySocial,
        msg: DERIVED_STANDINGS_MESSAGE,
        notificationMin: MIN_STANDING,
        notificationMax: MAX_STANDING,
        notificationGroup: "derived",
        int_1: corporationID,
        int_2: null,
        int_3: null,
      }];
  return [...directChanges, ...factionDerivedChanges]
    .map((entry) => ({ ...entry, propagate: false }))
    .filter(
      (entry) =>
        entry.ownerID > 0 &&
        Math.abs(entry.rawChange) > ZERO_STANDING_EPSILON,
    );
}

function buildMissionRewardStandingChanges(agentRecord, missionRecord, share = null) {
  return buildMissionOutcomeStandingChanges(
    agentRecord,
    missionRecord,
    "completed",
    share,
  );
}

function applyMissionStandingChanges(
  characterID,
  agentRecord,
  missionRecord,
  outcome = "completed",
  options = {},
) {
  const changes = buildMissionOutcomeStandingChanges(
    agentRecord,
    missionRecord,
    outcome,
  );
  if (!changes.length) {
    return {
      success: true,
      data: {
        modifications: [],
        appliedChanges: [],
      },
    };
  }

  const decline = normalizeMissionStandingOutcome(outcome) === "declined"
    ? resolveMissionStandingEventDefinition(missionRecord?.rewards || {}, "declined") : null;
  // This captured ripple already contains the intended recipients and fractions.
  // Generic relationship propagation would apply a second, unobserved loss.
  const applyOptions = decline?.notificationGroup === "direct" && Array.isArray(decline.derivedStandings)
    ? { ...options, disableDerived: true, preservePrecision: true, splitNotificationGroups: true }
    : options;
  return applyStandingChanges(characterID, changes, applyOptions);
}

function getAllAgentStandingOwners() {
  if (cachedAgentStandingOwnerIDs) {
    return cloneValue(cachedAgentStandingOwnerIDs);
  }

  const corporationIDs = new Set();
  const factionIDs = new Set();
  for (const agentRecord of listAgents()) {
    const corporationID = normalizePositiveInteger(agentRecord && agentRecord.corporationID, 0);
    const factionID = normalizePositiveInteger(agentRecord && agentRecord.factionID, 0);
    if (corporationID) {
      corporationIDs.add(corporationID);
    }
    if (factionID) {
      factionIDs.add(factionID);
    }
  }

  cachedAgentStandingOwnerIDs = {
    corporationIDs: [...corporationIDs].sort((left, right) => left - right),
    factionIDs: [...factionIDs].sort((left, right) => left - right),
  };
  return cloneValue(cachedAgentStandingOwnerIDs);
}

function getFactionRecordsByName() {
  if (cachedFactionRecordsByName) {
    return cachedFactionRecordsByName;
  }

  cachedFactionRecordsByName = new Map();
  for (const record of getAllFactionRecords()) {
    const name = normalizeText(record && record.name, "").toLowerCase();
    if (name) {
      cachedFactionRecordsByName.set(name, cloneValue(record));
    }
  }
  return cachedFactionRecordsByName;
}

module.exports = {
  EVENT_STANDING_AGENT_MISSION_BONUS,
  EVENT_STANDING_AGENT_MISSION_COMPLETED,
  EVENT_STANDING_AGENT_MISSION_DECLINED,
  EVENT_STANDING_AGENT_MISSION_FAILED,
  EVENT_STANDING_AGENT_MISSION_OFFER_EXPIRED,
  EVENT_STANDING_COMBAT_AGGRESSION,
  EVENT_STANDING_CONTRABAND_TRAFFICKING,
  EVENT_STANDING_DERIVED_NEGATIVE,
  EVENT_STANDING_DERIVED_POSITIVE,
  EVENT_STANDING_GROUP_REWARD_CORPORATION,
  EVENT_STANDING_GROUP_REWARD_FACTION,
  EVENT_STANDING_PLAYER_CORP_SET,
  EVENT_STANDING_PLAYER_SET,
  EVENT_STANDING_RESET,
  EVENT_STANDING_SLASH_SET,
  TYPE_CONNECTIONS,
  TYPE_CRIMINAL_CONNECTIONS,
  TYPE_DIPLOMACY,
  TYPE_DISTRIBUTION_CONNECTIONS,
  TYPE_FAST_TALK,
  TYPE_MINING_CONNECTIONS,
  TYPE_NEGOTIATION,
  TYPE_SECURITY_CONNECTIONS,
  TYPE_SOCIAL,
  applyMissionStandingChanges,
  hasStandingOperationReceipt,
  applyStandingBonusToValue,
  applyStandingChanges,
  buildMissionRewardStandingChanges,
  buildMissionOutcomeStandingChanges,
  buildStandingPreview,
  calculateNewStandings,
  calculateSocialAdjustedRawChange,
  calculateStandingsByRawChange,
  canCharacterUseAgent,
  clearStandingRuntimeCaches,
  getAllAgentStandingOwners,
  getCharacterDivisionConnectionsLpMultiplier,
  getCharacterEffectiveStanding,
  getCharacterNegotiationRewardMultiplier,
  getCharacterRawStanding,
  getCharacterRawStandingFromRecord,
  getCharacterSocialAttribute,
  getFactionRecordsByName,
  getOwnerFactionID,
  getStandingBonusForCharacter,
  getStandingBonusSkillTypeID,
  getStandingCompositions,
  getStandingTransactions,
  isNpcOwner,
  listCharacterStandings,
  listCorporationStandings,
  listNpcStandings,
  resolveBestStandingValue,
  resolveCharacterSocialAttributes,
  roundStandingValue,
  setCharacterStanding,
  setCharacterStandings,
};
