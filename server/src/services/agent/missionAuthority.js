"use strict";

const {
  toInt,
} = require("../../common/numbers");

const path = require("path");

const {
  TABLE,
  readStaticTable,
} = require(path.join(__dirname, "../_shared/referenceData"));
const {
  getAgentByID,
  listAgents,
  listMissionTemplateIDsForAgent,
} = require(path.join(__dirname, "./agentAuthority"));
const dungeonAuthority = require(path.join(__dirname, "../dungeon/dungeonAuthority"));
const { matchesCanonicalMission } = require("../../contentPacks/securityMissionBinding");
const {
  getChainContinuationMissionID: getGoldenChainContinuationMissionID,
  isChainContinuationMissionID,
  isDisabledMissionIdentifier,
  isDisabledMissionSourceURL,
  isDisabledMissionTemplateIdentifier,
  isGeneratedMissionIdentifier,
  isRetiredMissionTemplateIdentifier,
  normalizeStableMissionIdentity,
  productionMissionPolicy,
} = require(path.join(__dirname, "../../config/productionMissionPolicy"));

const randomSource = require("../../common/random");
const pirateFactionPolicy = require("../../space/npc/pirateFactionPolicy");
const regionalOfferPolicy = require("../../config/securityMissionOfferPolicy.json");
const offerEvidence = require("../../config/securityMissionOfferEvidence");
const baselineChains = require("../../config/securityMissionChains");
const offerProjection = require("../../config/securityMissionOfferProjection");

let cache = null;
let retirementGeneration = 0;
const EPIC_ARC_MESSAGE_TYPES = Object.freeze([
  "messages.epicMission.journalText.chapterTitle",
  "messages.epicMission.journalText.inProgressMessage",
  "messages.epicMission.journalText.completedMessage",
]);
const PERMANENTLY_DISABLED_MISSION_IDS = Object.freeze(
  productionMissionPolicy.disabledMissions.map(({ missionID }) => missionID),
);
function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeText(value, fallback = "") {
  const text = String(value || "").trim();
  return text.length > 0 ? text : fallback;
}

function normalizeMissionID(value, fallback = null) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }

  const text = normalizeText(value, "");
  if (!text) {
    return fallback;
  }
  if (/^-?\d+$/.test(text)) {
    return Number.parseInt(text, 10);
  }
  return text;
}

function normalizeMissionIDList(values) {
  const source = Array.isArray(values) ? values : [];
  const seen = new Set();
  const result = [];
  for (const value of source) {
    const missionID = normalizeMissionID(value, null);
    const key = missionID === null ? "" : String(missionID);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(missionID);
  }
  return result;
}

function normalizeIntegerList(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((entry) => toInt(entry, 0))
    .filter((entry) => entry > 0))].sort((left, right) => left - right);
}

function normalizeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function normalizeOptionalMissionObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? cloneValue(value)
    : null;
}

function normalizeMissionRewardEntry(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const hasRewardType =
    Object.prototype.hasOwnProperty.call(value, "rewardTypeID") ||
    Object.prototype.hasOwnProperty.call(value, "typeID");
  const hasRewardQuantity =
    Object.prototype.hasOwnProperty.call(value, "rewardQuantity") ||
    Object.prototype.hasOwnProperty.call(value, "quantity");
  if (!hasRewardType && !hasRewardQuantity) {
    return null;
  }
  return {
    rewardTypeID: toInt(value.rewardTypeID ?? value.typeID, 0) || null,
    rewardQuantity: toInt(value.rewardQuantity ?? value.quantity, 0) || null,
  };
}

function normalizeNullableInteger(value) {
  return value === undefined || value === null
    ? null
    : toInt(value, 0) || null;
}

function normalizeMissionRewards(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  if (
    Object.prototype.hasOwnProperty.call(value, "reward") ||
    Object.prototype.hasOwnProperty.call(value, "bonusReward") ||
    Object.prototype.hasOwnProperty.call(value, "bonusTimeInterval")
  ) {
    return {
      reward: normalizeMissionRewardEntry(value.reward),
      bonusReward: normalizeMissionRewardEntry(value.bonusReward),
      bonusTimeInterval: normalizeNullableInteger(value.bonusTimeInterval),
    };
  }
  return cloneValue(value);
}

function normalizeLocalizedMessageEntry(value, fallbackMessageID = null) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const messageID = toInt(value.messageID ?? fallbackMessageID, 0) || null;
  const text = normalizeText(value.text, "");
  if (!messageID && !text) {
    return null;
  }
  return {
    messageID,
    text,
    metadata:
      Object.prototype.hasOwnProperty.call(value, "metadata")
        ? cloneValue(value.metadata)
        : null,
    tokens:
      Object.prototype.hasOwnProperty.call(value, "tokens")
        ? cloneValue(value.tokens)
        : null,
  };
}

function normalizeLocalizedMessageMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const result = {};
  for (const [messageKey, entry] of Object.entries(value)) {
    const normalizedEntry = normalizeLocalizedMessageEntry(entry, null);
    if (!normalizedEntry) {
      continue;
    }
    result[String(messageKey)] = normalizedEntry;
  }
  return result;
}

function normalizeMissionRecord(record = {}, missionID) {
  return {
    missionID: normalizeMissionID(record.missionID ?? missionID, missionID),
    contentTemplate: normalizeText(record.contentTemplate, ""),
    nameID: toInt(record.nameID, 0),
    contentTags: normalizeMissionIDList(record.contentTags),
    messages: normalizeObject(record.messages),
    localizedName: normalizeLocalizedMessageEntry(record.localizedName, record.nameID),
    localizedMessages: normalizeLocalizedMessageMap(record.localizedMessages),
    hasStandingRewards:
      Object.prototype.hasOwnProperty.call(record, "hasStandingRewards")
        ? record.hasStandingRewards === true
        : true,
    fixedLpRewardAlpha: toInt(record.fixedLpRewardAlpha, 0),
    fixedLpRewardOmega: toInt(record.fixedLpRewardOmega, 0),
    expirationTime:
      record.expirationTime === undefined || record.expirationTime === null
        ? null
        : Math.max(0, toInt(record.expirationTime, 0)),
    agentTypeID: toInt(record.agentTypeID, 0) || null,
    corporationID: toInt(record.corporationID, 0) || null,
    factionID: toInt(record.factionID, 0) || null,
    initialAgentGiftTypeID: toInt(record.initialAgentGiftTypeID, 0) || null,
    initialAgentGiftQuantity: toInt(record.initialAgentGiftQuantity, 0) || null,
    nodeGraphID: toInt(record.nodeGraphID, 0) || null,
    missionTemplateID: normalizeText(record.missionTemplateID, ""),
    dungeonTemplateID: normalizeText(record.dungeonTemplateID, ""),
    generatedFromTemplateID: normalizeText(record.generatedFromTemplateID, ""),
    generatedFromSource: normalizeText(record.generatedFromSource, ""),
    killMission: normalizeOptionalMissionObject(record.killMission),
    courierMission: normalizeOptionalMissionObject(record.courierMission),
    missionRewards: normalizeMissionRewards(record.missionRewards),
    estimatedRewardFields: Array.isArray(record.estimatedRewardFields) ? [...record.estimatedRewardFields] : [],
    clientObjectives: normalizeOptionalMissionObject(record.clientObjectives),
    extraStandings: normalizeOptionalMissionObject(record.extraStandings),
    remoteCompletable:
      Object.prototype.hasOwnProperty.call(record, "remoteCompletable")
        ? record.remoteCompletable === true
        : null,
    remoteOfferable:
      Object.prototype.hasOwnProperty.call(record, "remoteOfferable")
        ? record.remoteOfferable === true
        : null,
    epicArcID: toInt(record.epicArcID, 0) || null,
    sourceAgentID: toInt(record.sourceAgentID, 0) || null,
    nextMissionIDs: normalizeMissionIDList(record.nextMissionIDs),
    nextAgentIDs: normalizeIntegerList(record.nextAgentIDs),
    targetAgentID: toInt(record.targetAgentID, 0) || null,
    missionKind: normalizeText(record.missionKind, "encounter"),
    missionFlavor: normalizeText(record.missionFlavor, "basic"),
    isEpicArc: record.isEpicArc === true,
    isHeraldry: record.isHeraldry === true,
    isResearch: record.isResearch === true,
    isStoryline: record.isStoryline === true,
    isGenericStoryline: record.isGenericStoryline === true,
    isAgentInteraction: record.isAgentInteraction === true,
    isTalkToAgent: record.isTalkToAgent === true,
  };
}

function normalizePayload(payload = {}) {
  return {
    version: toInt(payload.version, 0),
    generatedAt: normalizeText(payload.generatedAt, ""),
    source: normalizeObject(payload.source),
    counts: normalizeObject(payload.counts),
    missionsByID: normalizeObject(payload.missionsByID),
    indexes: normalizeObject(payload.indexes),
  };
}

function isPermanentlyDisabledMissionID(missionID) {
  return isDisabledMissionIdentifier(missionID);
}

function isPermanentlyDisabledMissionRecord(record = null, missionID = null) {
  if (
    isPermanentlyDisabledMissionID(missionID) ||
    isPermanentlyDisabledMissionID(record && record.missionID)
  ) {
    return true;
  }

  return [
    record && record.missionTemplateID,
    record && record.dungeonTemplateID,
    record && record.generatedFromTemplateID,
    record && record.sourceMissionID,
    record && record.adminMetadata && record.adminMetadata.sourceMissionID,
  ].some((templateID) => {
    const normalizedTemplateID = normalizeText(templateID, "").toLowerCase();
    return isDisabledMissionTemplateIdentifier(normalizedTemplateID) ||
      isDisabledMissionIdentifier(normalizedTemplateID);
  }) || [
    record && record.sourceUrl,
    record && record.sourceURL,
    record && record.adminMetadata && record.adminMetadata.sourceUrl,
    record && record.adminMetadata && record.adminMetadata.sourceURL,
  ].some(isDisabledMissionSourceURL);
}

function isMissionDungeonAvailable(record = null) {
  const sourceDungeonID = toInt(record && record.killMission && record.killMission.dungeonID, 0);
  if ([17130, 17131, 17132].includes(Number(record?.missionID))) {
    return Boolean(require("../dungeon/fracturedLegacyRuntime").contract(
      dungeonAuthority.getTemplateByID(`client-dungeon:${sourceDungeonID}`)));
  }
  if (sourceDungeonID <= 0) {
    return true;
  }
  return dungeonAuthority.hasClientDungeonTemplate(sourceDungeonID);
}

function filterAvailableMissionIDs(values, availableMissionKeys) {
  return normalizeMissionIDList(values).filter((missionID) =>
    availableMissionKeys.has(String(missionID)));
}

function sanitizePayload(payload = {}) {
  const missionsByID = {};
  for (const [missionID, record] of Object.entries(payload.missionsByID || {})) {
    if (
      isPermanentlyDisabledMissionRecord(record, missionID) ||
      isGeneratedScrapedMissionRecord(record, missionID) ||
      !isMissionDungeonAvailable(record)
    ) {
      continue;
    }
    missionsByID[missionID] = record;
  }

  const availableMissionKeys = new Set(Object.keys(missionsByID));
  const indexes = {};
  for (const [indexName, rawIndex] of Object.entries(normalizeObject(payload.indexes))) {
    const index = normalizeObject(rawIndex);
    if (indexName === "preferredMissionIDs") {
      indexes[indexName] = Object.fromEntries(
        Object.entries(index).filter(([, missionID]) => {
          const normalizedMissionID = normalizeMissionID(missionID, null);
          return normalizedMissionID !== null &&
            availableMissionKeys.has(String(normalizedMissionID));
        }),
      );
      continue;
    }
    indexes[indexName] = Object.fromEntries(
      Object.entries(index).map(([key, missionIDs]) => [
        key,
        filterAvailableMissionIDs(missionIDs, availableMissionKeys),
      ]),
    );
  }

  const normalizedMissions = Object.entries(missionsByID).map(([missionID, record]) =>
    normalizeMissionRecord(record, normalizeMissionID(missionID, missionID)));
  const preferredMissionIDs = normalizeObject(indexes.preferredMissionIDs);

  return {
    ...payload,
    counts: {
      ...payload.counts,
      missionCount: normalizedMissions.length,
      missionKindCount: new Set(normalizedMissions.map((record) => record.missionKind)).size,
      missionFlavorCount: new Set(normalizedMissions.map((record) => record.missionFlavor)).size,
      missionTemplateCount: new Set(
        normalizedMissions.map((record) => record.contentTemplate).filter(Boolean),
      ).size,
      epicArcMissionCount: normalizedMissions.filter((record) => record.isEpicArc).length,
      preferredMissionCount: Object.keys(preferredMissionIDs).length,
      localizedMissionCount: normalizedMissions.filter((record) => record.localizedName).length,
      localizedMissionMessageCount: normalizedMissions.reduce(
        (count, record) => count + Object.keys(record.localizedMessages || {}).length,
        0,
      ),
      generatedEveSurvivalMissionCount: normalizedMissions.filter((record) =>
        record.generatedFromSource === "eve-survival-generated").length,
    },
    missionsByID,
    indexes,
  };
}

function isResearchAgentRecord(agentRecord = null) {
  const missionKind = normalizeText(agentRecord && agentRecord.missionKind, "encounter")
    .toLowerCase();
  const missionTypeLabel = normalizeText(
    agentRecord && agentRecord.missionTypeLabel,
    "",
  ).toLowerCase();
  const agentTypeID = toInt(agentRecord && agentRecord.agentTypeID, 0);
  return (
    missionKind === "research" ||
    missionTypeLabel.includes("research") ||
    agentTypeID === 4
  );
}

function buildAgentPreferenceKeys(agentRecord = null) {
  const missionKind = normalizeText(agentRecord && agentRecord.missionKind, "encounter")
    .toLowerCase();
  const importantMission = agentRecord && agentRecord.importantMission === true;

  if (isResearchAgentRecord(agentRecord)) {
    return [
      "researchTrade",
      "researchCourier",
      "basicTrade",
      "basicCourier",
    ];
  }

  if (missionKind === "courier" || missionKind === "distribution") {
    return importantMission
      ? [
          "storylineCourier",
          "genericStorylineCourier",
          "basicCourier",
        ]
      : ["basicCourier"];
  }

  if (missionKind === "trade") {
    return importantMission
      ? [
          "storylineTrade",
          "genericStorylineTrade",
          "basicTrade",
        ]
      : ["basicTrade"];
  }

  if (missionKind === "mining") {
    return ["basicMining"];
  }

  return importantMission
    ? [
        "storylineEncounter",
        "genericStorylineEncounter",
        "basicEncounter",
      ]
    : ["basicEncounter"];
}

function addMissionTemplateIndex(missionTemplateToMissionIDs, templateID, missionID) {
  const normalizedTemplateID = normalizeText(templateID, "");
  const normalizedMissionID = normalizeMissionID(missionID, null);
  if (!normalizedTemplateID || normalizedMissionID === null) {
    return;
  }
  const current = missionTemplateToMissionIDs.get(normalizedTemplateID) || [];
  const key = String(normalizedMissionID);
  if (!current.some((entry) => String(entry) === key)) {
    current.push(normalizedMissionID);
  }
  missionTemplateToMissionIDs.set(normalizedTemplateID, current);
}

function buildCache() {
  // Career agents offer their factions' career chains (careerAgentMissions).
  const careerPayload = require(path.join(__dirname, "./careerAgentMissions")).applyToMissionAuthorityPayload(
    require("./visionsOfGreatness").applyToMissionAuthorityPayload(readStaticTable(TABLE.MISSION_AUTHORITY)),
    (readStaticTable(TABLE.AGENT_AUTHORITY) || {}).agentsByID,
  );
  const payload = sanitizePayload(
    normalizePayload(require(path.join(__dirname, "./careerRetailMissionData")).applyToMissionAuthorityPayload(careerPayload)),
  );
  const missionsByID = new Map();
  const epicArcMessageMaps = Object.fromEntries(
    EPIC_ARC_MESSAGE_TYPES.map((messageType) => [messageType, {}]),
  );
  for (const [missionID, record] of Object.entries(payload.missionsByID || {})) {
    const normalizedMission = normalizeMissionRecord(record, normalizeMissionID(missionID, missionID));
    const missionKey = String(normalizedMission.missionID);
    missionsByID.set(missionKey, normalizedMission);
    if (normalizedMission.isEpicArc || normalizedMission.missionFlavor === "epicArc") {
      for (const messageType of EPIC_ARC_MESSAGE_TYPES) {
        const messageID = toInt(normalizedMission.messages[messageType], 0);
        if (messageID > 0) {
          epicArcMessageMaps[messageType][missionKey] = messageID;
        }
      }
    }
  }

  const missionTemplateToMissionIDs = new Map();
  const agentIDToMissionIDs = new Map();
  const preferredMissionIDs = new Map();

  const indexPayload = normalizeObject(payload.indexes);
  for (const [templateID, missionIDs] of Object.entries(
    normalizeObject(indexPayload.missionTemplateToMissionIDs),
  )) {
    missionTemplateToMissionIDs.set(
      templateID,
      normalizeMissionIDList(missionIDs),
    );
  }

  for (const missionRecord of missionsByID.values()) {
    addMissionTemplateIndex(
      missionTemplateToMissionIDs,
      missionRecord.dungeonTemplateID || missionRecord.missionTemplateID,
      missionRecord.missionID,
    );
  }

  for (const [agentID, missionIDs] of Object.entries(
    normalizeObject(indexPayload.agentIDToMissionIDs),
  )) {
    agentIDToMissionIDs.set(
      String(toInt(agentID, 0)),
      normalizeMissionIDList(missionIDs),
    );
  }

  for (const [preferenceKey, missionID] of Object.entries(
    normalizeObject(indexPayload.preferredMissionIDs),
  )) {
    const normalizedMissionID = normalizeMissionID(missionID, null);
    if (normalizedMissionID === null) {
      continue;
    }
    preferredMissionIDs.set(preferenceKey, normalizedMissionID);
  }

  return {
    payload,
    missionsByID,
    missionTemplateToMissionIDs,
    agentIDToMissionIDs,
    preferredMissionIDs,
    preferredCandidateIDsBySignature: new Map(),
    epicArcMessageMaps,
  };
}

function ensureCache() {
  if (!cache) {
    cache = buildCache();
  }
  return cache;
}

function clearCache() {
  cache = null;
  retirementGeneration += 1;
  // Which mission dungeons hold ore depends on the installed content packs, so
  // it is recomputed alongside the mission payload.
  clearMinableDungeonIDCache();
}

function getRetirementGeneration() {
  return retirementGeneration;
}

function getPayload() {
  return cloneValue(ensureCache().payload);
}

function listDisabledMissionIDs() {
  return cloneValue(PERMANENTLY_DISABLED_MISSION_IDS);
}

function getMissionByID(missionID) {
  const record = ensureCache().missionsByID.get(String(normalizeMissionID(missionID, missionID)));
  return record ? cloneValue(record) : null;
}

function listMissionIDsByTemplate(contentTemplateID) {
  const templateID = normalizeText(contentTemplateID, "");
  if (!templateID) {
    return [];
  }
  const missionIDs = ensureCache().missionTemplateToMissionIDs.get(templateID);
  return missionIDs ? cloneValue(missionIDs) : [];
}

function getPreferredMissionID(preferenceKey) {
  const missionID = ensureCache().preferredMissionIDs.get(normalizeText(preferenceKey, ""));
  return missionID === undefined ? null : cloneValue(missionID);
}

// Ordinary Security agents are intentionally deny-by-default. A dungeon ID is not
// sufficient here: generated missions at other levels can reuse the same dungeon.
const GOLDEN_SECURITY_MISSIONS = productionMissionPolicy.goldenSecurityMissions;
const GOLDEN_SECURITY_MISSION_BY_ID = new Map(
  GOLDEN_SECURITY_MISSIONS.map((mission) => [String(mission.missionID), mission]),
);
// Mining missions used to be gated by a hardcoded list of five level 1
// dungeons, because those five were the only ones with real asteroids in them.
// The evejs.mining-missions pack supplies the client's own rocks for every
// mining mission across levels 1-4, so the gate asks the installed dungeon
// authority instead: a mining mission is offered when its site actually holds
// something to mine.
//
// There is deliberately no hardcoded floor. The mission sites live in the pack
// now, so with the pack removed there is nothing to mine and nothing to offer,
// and a list of ids would only promise sites that are not installed.
const SUPPORTED_GOLDEN_SECURITY_DUNGEON_IDS = new Set(
  GOLDEN_SECURITY_MISSIONS.map(({ dungeonID }) => dungeonID),
);

let minableDungeonIDCache = null;
let minableDungeonLevelCache = null;
const minableDungeonIDsByLevelCache = new Map();

function listMinableMissionDungeonIDs() {
  if (minableDungeonIDCache) {
    return minableDungeonIDCache;
  }
  const ids = new Set();
  const levels = new Map();
  for (const template of dungeonAuthority.listTemplatesBySource("client") || []) {
    const sourceDungeonID = toInt(template && template.sourceDungeonID, 0);
    if (sourceDungeonID <= 0) {
      continue;
    }
    // A mining mission site is one whose rocks hold the very thing the mission
    // asks for. That rules out both an ore anomaly, which has rocks but no
    // objective, and a fetch mission whose room happens to be decorated with
    // scenery asteroids that have nothing to do with the objective.
    const hints = (template && template.populationHints) || {};
    const rocks = Array.isArray(hints.miningRocks) ? hints.miningRocks : [];
    const objectiveTypeID = toInt(hints.objectiveTypeID, 0);
    if (rocks.length > 0 &&
      objectiveTypeID > 0 &&
      rocks.every((rock) => toInt(rock && (rock.typeID || rock.oreTypeID), 0) === objectiveTypeID)) {
      ids.add(sourceDungeonID);
      levels.set(sourceDungeonID, toInt(hints.missionLevel, 0));
    }
  }
  minableDungeonLevelCache = levels;
  minableDungeonIDCache = ids;
  return minableDungeonIDCache;
}

// The sites span 1,080 m3 to 44,800 m3 of ore, so an agent offers only the
// ones published at its own level; offering the pool flat hands a level 1
// agent a level 4 haul. The pack states each site's missionLevel. A site that
// does not state one stays offerable at every level rather than at none, and a
// level the pack has no sites for (the client's mining dungeons stop at level
// 4, but there are level 5 mining agents) keeps drawing on the whole set.
function listMinableMissionDungeonIDsForLevel(agentLevel) {
  const ids = listMinableMissionDungeonIDs();
  const level = toInt(agentLevel, 0);
  if (level <= 0) {
    return ids;
  }
  if (!minableDungeonIDsByLevelCache.has(level)) {
    const atLevel = new Set([...ids].filter((dungeonID) => {
      const siteLevel = minableDungeonLevelCache.get(dungeonID) || 0;
      return siteLevel <= 0 || siteLevel === level;
    }));
    const publishedAtLevel = [...atLevel].some((dungeonID) =>
      (minableDungeonLevelCache.get(dungeonID) || 0) === level);
    minableDungeonIDsByLevelCache.set(level, publishedAtLevel ? atLevel : ids);
  }
  return minableDungeonIDsByLevelCache.get(level);
}

function clearMinableDungeonIDCache() {
  minableDungeonIDCache = null;
  minableDungeonLevelCache = null;
  minableDungeonIDsByLevelCache.clear();
}

function isSupportedLevelOneClientDungeonID(dungeonID) {
  const normalized = toInt(dungeonID, 0);
  return SUPPORTED_GOLDEN_SECURITY_DUNGEON_IDS.has(normalized) ||
    listMinableMissionDungeonIDs().has(normalized);
}

function isGeneratedScrapedMissionRecord(record, fallbackMissionID = null) {
  const missionIdentifiers = [
    record && record.missionID,
    fallbackMissionID,
    record && record.missionTemplateID,
    record && record.dungeonTemplateID,
    record && record.generatedFromTemplateID,
  ];
  return missionIdentifiers.some(isGeneratedMissionIdentifier) ||
    normalizeText(record && record.generatedFromSource, "").toLowerCase() === "eve-survival-generated" ||
    [
      record && record.generatedFromTemplateID,
      record && record.missionTemplateID,
      record && record.dungeonTemplateID,
    ].some(isRetiredMissionTemplateIdentifier);
}

function isScriptedStorylineMissionRecord(record = null) {
  return Boolean(
    record && (record.isStoryline === true || record.isGenericStoryline === true),
  );
}

function hasAgentSpecificMissionIDs(agentRecord = null) {
  const agentID = toInt(agentRecord && agentRecord.agentID, 0);
  const missionIDs = agentID > 0
    ? ensureCache().agentIDToMissionIDs.get(String(agentID))
    : null;
  return Array.isArray(missionIDs) && missionIDs.length > 0;
}

function isAgentSpecificMissionIDForAgent(agentID, missionID) {
  const normalizedAgentID = toInt(agentID, 0);
  const normalizedMissionID = normalizeStableMissionIdentity(missionID);
  const missionIDs = normalizedAgentID > 0
    ? ensureCache().agentIDToMissionIDs.get(String(normalizedAgentID))
    : null;
  return Boolean(
    normalizedMissionID &&
      Array.isArray(missionIDs) &&
      missionIDs.some((candidateMissionID) => String(candidateMissionID) === normalizedMissionID),
  );
}

function isScriptedMissionRecord(record = null) {
  return Boolean(
    record && (
      record.isEpicArc === true ||
      record.isHeraldry === true ||
      record.isResearch === true ||
      record.isStoryline === true ||
      record.isGenericStoryline === true ||
      record.isAgentInteraction === true ||
      record.isTalkToAgent === true
    ),
  );
}

function isExplicitStorylineAgent(agentRecord = null) {
  return Boolean(
    agentRecord && agentRecord.importantMission === true ||
      normalizeText(agentRecord && agentRecord.missionTypeLabel, "")
        .toLowerCase()
        .includes("storyline"),
  );
}

function isOrdinarySecurityAgent(agentRecord = null) {
  return normalizeText(agentRecord && agentRecord.missionKind, "").toLowerCase() === "encounter" &&
    !isExplicitStorylineAgent(agentRecord) &&
    !hasAgentSpecificMissionIDs(agentRecord);
}

function isGoldenSecurityMissionRecord(record = null, agentLevel = 0) {
  const missionID = normalizeMissionID(record && record.missionID, null);
  if (missionID === null) {
    return false;
  }
  const goldenMission = GOLDEN_SECURITY_MISSION_BY_ID.get(String(missionID));
  const actualDungeonID = toInt(
    record && record.killMission && record.killMission.dungeonID,
    0,
  );
  return Boolean(
    goldenMission &&
      goldenMission.agentLevel === toInt(agentLevel, 0) &&
      actualDungeonID === goldenMission.dungeonID,
  );
}

function isExactConfiguredGoldenMissionRecord(record = null, runtimeRecord = null) {
  const missionID = normalizeMissionID(record && record.missionID, null);
  const goldenMission = missionID === null
    ? null
    : GOLDEN_SECURITY_MISSION_BY_ID.get(String(missionID));
  const canonicalDungeonID = toInt(
    record && record.killMission && record.killMission.dungeonID,
    0,
  );
  if (!goldenMission || canonicalDungeonID !== goldenMission.dungeonID) {
    return false;
  }
  if (!runtimeRecord || typeof runtimeRecord !== "object") {
    return true;
  }
  const runtimeDungeonID = toInt(runtimeRecord.dungeonID, 0);
  if (runtimeDungeonID > 0 && runtimeDungeonID !== goldenMission.dungeonID) {
    return false;
  }
  const runtimeDungeonTemplateID = normalizeText(runtimeRecord.dungeonTemplateID, "");
  if (
    runtimeDungeonTemplateID &&
    runtimeDungeonTemplateID.toLowerCase() !== goldenMission.templateID.toLowerCase()
  ) {
    return false;
  }
  const presentationTemplateID = normalizeText(runtimeRecord.missionTemplateID, "");
  if (
    presentationTemplateID.toLowerCase().startsWith("client-dungeon:") &&
    presentationTemplateID.toLowerCase() !== goldenMission.templateID.toLowerCase()
  ) {
    return false;
  }
  return true;
}

function isRetiredOrdinaryEncounterMissionForAgent(
  agentID,
  missionIdentifier,
  runtimeRecord = null,
) {
  const normalizedMissionID = normalizeStableMissionIdentity(missionIdentifier);
  if (!normalizedMissionID) {
    return false;
  }
  const missionRecord = getMissionByID(normalizedMissionID);
  const hasRuntimeAlias = [runtimeRecord && runtimeRecord.dungeonTemplateID, runtimeRecord && runtimeRecord.missionTemplateID]
    .some((id) => String(id || "").startsWith("security-mission:"));
  if (hasRuntimeAlias) {
    const binding = getSecurityMissionBindingForAgent(getAgentByID(agentID), missionRecord);
    return !(binding && runtimeRecord.dungeonTemplateID === binding.templateID &&
      runtimeRecord.missionTemplateID === binding.templateID && runtimeRecord.dungeonID === binding.dungeonID);
  }
  if (
    !missionRecord ||
    normalizeText(missionRecord.missionKind, "").toLowerCase() !== "encounter"
  ) {
    return false;
  }
  if (isExactConfiguredGoldenMissionRecord(missionRecord, runtimeRecord)) {
    return false;
  }
  if (
    isScriptedMissionRecord(missionRecord) ||
    isAgentSpecificMissionIDForAgent(agentID, normalizedMissionID) ||
    isChainContinuationMissionID(normalizedMissionID)
  ) {
    return false;
  }
  return true;
}

function getSecurityMissionBindingForAgent(agentRecord, missionRecord) {
  if (!isOrdinarySecurityAgent(agentRecord) || !missionRecord ||
    isPermanentlyDisabledMissionRecord(missionRecord) ||
    GOLDEN_SECURITY_MISSION_BY_ID.has(String(missionRecord.missionID)) ||
    isScriptedMissionRecord(missionRecord) || isChainContinuationMissionID(missionRecord.missionID)) return null;
  const binding = dungeonAuthority.getSecurityMissionBinding(missionRecord.missionID);
  // Only established canonical mission membership can gain a pack binding.
  // Raw client QA/test records omitted by the canonical table stay unavailable.
  const canonical = ensureCache().missionsByID.get(String(missionRecord.missionID));
  const chainPart = baselineChains.getPart(missionRecord);
  const chainLevel = chainPart?.part > 1 && chainPart.agentLevels.includes(toInt(agentRecord.level, 0));
  if (!matchesCanonicalMission(binding, canonical) || !matchesCanonicalMission(binding, missionRecord) ||
    (binding.agentLevel !== toInt(agentRecord.level, 0) && !chainLevel)) return null;
  for (const key of ["factionID", "corporationID", "agentTypeID"]) {
    if (binding[key] > 0 && binding[key] !== toInt(agentRecord[key], 0)) return null;
  }
  return binding;
}

function isBaselineChainPartAvailable(agentRecord, missionRecord) {
  const part = baselineChains.getPart(missionRecord);
  if (!part || !isOrdinarySecurityAgent(agentRecord) || isPermanentlyDisabledMissionRecord(missionRecord) ||
      !part.agentLevels.includes(toInt(agentRecord.level, 0)) ||
      !["factionID", "corporationID", "agentTypeID"].every((field) => !part[field] || part[field] === toInt(agentRecord[field], 0))) return false;
  if (missionRecord.contentTemplate === "agent.missionTemplatizedContent_BasicKillMission") {
    return Boolean(getSecurityMissionBindingForAgent(agentRecord, missionRecord));
  }
  const canonical = getMissionByID(missionRecord.missionID);
  if (!baselineChains.getPart(canonical)) return false;
  const goalField = missionRecord.courierMission ? "courierMission" : "killMission";
  if (!["objectiveTypeID", "objectiveQuantity", "objectiveSingleton"].every((field) =>
    missionRecord[goalField]?.[field] === canonical[goalField]?.[field])) return false;
  if (["agent.missionTemplatizedContent_BasicCourierMission",
    "agent.missionTemplatizedContent_BasicTradeMission"].includes(missionRecord.contentTemplate)) {
    return toInt(missionRecord.courierMission?.objectiveTypeID, 0) > 0 && toInt(missionRecord.courierMission?.objectiveQuantity, 0) > 0;
  }
  return missionRecord.contentTemplate === "agent.missionTemplatizedContent_BasicMiningMission" &&
    listMinableMissionDungeonIDs().has(part.dungeonID);
}

function getChainContinuationMissionID(missionID, agentRecord = null) {
  if (require("./visionsOfGreatness").isMission(missionID)) {
    const source = getMissionByID(missionID);
    return source && Number(source.sourceAgentID) === Number(agentRecord?.agentID)
      ? source.nextMissionIDs[0] ?? null : null;
  }
  const golden = getGoldenChainContinuationMissionID(missionID);
  if (golden !== null) return golden;
  const source = getMissionByID(missionID);
  if (!isBaselineChainPartAvailable(agentRecord, source)) return null;
  const part = baselineChains.getPart(source);
  // TODO: Client-title/wiki pairing is a baseline. Golden logs replace these
  // ordered candidates; never skip a numbered stage or randomize the next part.
  for (const nextID of baselineChains.getCandidateMissionIDs(part, toInt(agentRecord.level, 0))) {
    const next = getMissionByID(nextID);
    const nextPart = baselineChains.getPart(next);
    if (nextPart?.family === part.family && nextPart.total === part.total && nextPart.part === part.part + 1 &&
        isBaselineChainPartAvailable(agentRecord, next)) return nextID;
  }
  return null;
}

function isMissionOfferAllowedForAgent(agentRecord = null, missionRecord = null) {
  if (!missionRecord || isPermanentlyDisabledMissionRecord(missionRecord)) {
    return false;
  }
  // Chain continuations are golden content reachable only by completing the previous part;
  // any ordinary agent that ran part N may hand out part N+1 regardless of the random pool.
  if (isChainContinuationMissionID(missionRecord.missionID)) {
    return true;
  }
  if (baselineChains.getPart(missionRecord)?.part > 1) {
    return isBaselineChainPartAvailable(agentRecord, missionRecord);
  }
  if (
    isOrdinarySecurityAgent(agentRecord) &&
    !isGoldenSecurityMissionRecord(
      missionRecord,
      toInt(agentRecord && agentRecord.level, 0),
    ) && !getSecurityMissionBindingForAgent(agentRecord, missionRecord)
  ) {
    return false;
  }
  const missionKey = String(normalizeMissionID(missionRecord.missionID, null));
  return listMissionIDsForAgent(agentRecord).some((missionID) =>
    String(missionID) === missionKey);
}

function listGoldenSecurityMissionIDsForAgent(agentRecord = null) {
  const agentLevel = toInt(agentRecord && agentRecord.level, 0);
  return GOLDEN_SECURITY_MISSIONS
    .filter((mission) => mission.agentLevel === agentLevel)
    .map((mission) => mission.missionID)
    .filter((missionID) => {
      const record = getMissionByID(missionID);
      return isGoldenSecurityMissionRecord(record, agentLevel) &&
        ["factionID", "corporationID", "agentTypeID"].every((key) =>
          !(record[key] > 0) || record[key] === toInt(agentRecord[key], 0));
    });
}

function hasCapturedAgentOffer(agentRecord, candidate) {
  if (offerEvidence.getMissionObservation?.(agentRecord, candidate.record)) return true;
  const matchesAgent = (row) => row &&
    row.sourceAgentID === toInt(agentRecord.agentID, 0) &&
    row.sourceSolarSystemID === toInt(agentRecord.solarSystemID, 0);
  const captured = candidate.binding?.rewards?.tqReportedMetadata || [];
  if (captured.some((row) => !row.observationKind && matchesAgent(row) &&
      row.missionID === candidate.record.missionID &&
      row.dungeonID === candidate.record.killMission?.dungeonID &&
      row.agentLevel === toInt(agentRecord.level, 0) &&
      row.sourceRefs?.some((ref) => ["TQ_ParityCapture_briefing", "TQ_decoded_log"].includes(ref.source)))) return true;
  if (candidate.binding) return false;
  const template = dungeonAuthority.getTemplateByIDReadOnly(candidate.templateID);
  return matchesAgent(template?.missionSetupByMissionID?.[candidate.record.missionID]);
}


function filterRegionalPirateVariants(agentRecord, missionIDs) {
  if (toInt(agentRecord.level, 0) > regionalOfferPolicy.maximumAgentLevel) return missionIDs;
  const supported = new Set(regionalOfferPolicy.pirateFactionKeys);
  const families = new Map();
  const candidates = missionIDs.map((missionID) => {
    const record = getMissionByID(missionID);
    const binding = dungeonAuthority.getSecurityMissionBinding(missionID);
    const templateID = binding?.templateID || `client-dungeon:${record.killMission?.dungeonID}`;
    const template = dungeonAuthority.getTemplateSelectionDescriptorByID(templateID);
    // Use the native dungeon faction, never the offering-agent faction or an
    // estimated wiki fallback enemy. Missing native evidence remains unknown.
    const enemy = pirateFactionPolicy.PIRATE_FACTION_BY_FACTION_ID[template?.factionID];
    const family = normalizeText(record.localizedName?.text, "").toLowerCase().replace(/\s+/g, " ");
    const candidate = { record, binding, templateID, family, enemy, enemyFactionID: template?.factionID };
    if (family && supported.has(enemy)) {
      if (!families.has(family)) families.set(family, new Set());
      families.get(family).add(enemy);
    }
    return candidate;
  });
  if (![...families.values()].some((enemies) => enemies.size > 1)) return missionIDs;
  const region = pirateFactionPolicy.resolvePirateFactionForSystem(agentRecord.solarSystemID);
  const localPirateFactionID = Number(Object.keys(pirateFactionPolicy.PIRATE_FACTION_BY_FACTION_ID)
    .find((id) => pirateFactionPolicy.PIRATE_FACTION_BY_FACTION_ID[id] === region.factionKey)) || 0;
  // TODO: security-regional-pirate-variants-v1 in securityMissionOfferPolicy.json
  // records the source, per-level limits, exact-agent exceptions and unknowns.
  return candidates.filter((candidate) => {
    if (hasCapturedAgentOffer(agentRecord, candidate)) return true;
    const desired = offerProjection.desiredEnemyFactionIDs(agentRecord, region, candidate.record.localizedName?.text, localPirateFactionID);
    // Captured family patterns outrank the older blanket regional guess. Only
    // select among variants actually available at this level; unknown enemies
    // and families with no matching native alternative remain unresolved.
    if (supported.has(candidate.enemy) && desired?.length && candidates.some((other) =>
      other.family === candidate.family && desired.includes(other.enemyFactionID))) {
      return desired.includes(candidate.enemyFactionID);
    }
    if (region.specialSpace || region.wormholeSpace || !supported.has(region.factionKey) ||
        !["region", "faction_id"].includes(region.source)) return true;
    const enemies = families.get(candidate.family);
    return !supported.has(candidate.enemy) || !enemies || enemies.size < 2 ||
      !enemies.has(region.factionKey) || candidate.enemy === region.factionKey ||
      hasCapturedAgentOffer(agentRecord, candidate);
  }).map((candidate) => candidate.record.missionID);
}


function listSelectableMissionIDsForAgent(agentRecord = null) {
  const admitted = listMissionIDsForAgent(agentRecord);
  const profile = offerEvidence.getProfile?.(agentRecord);
  if (!isOrdinarySecurityAgent(agentRecord)) return admitted;
  if (!profile) {
    const space = pirateFactionPolicy.resolvePirateFactionForSystem(agentRecord.solarSystemID);
    const cohort = offerProjection.getCohort(agentRecord, space);
    return admitted.filter((missionID) => {
      const record = getMissionByID(missionID);
      return offerProjection.allowsFamily(cohort, record.localizedName?.text, toInt(agentRecord.level, 0)) ||
        hasCapturedAgentOffer(agentRecord, { record, binding: dungeonAuthority.getSecurityMissionBinding(missionID),
          templateID: `client-dungeon:${record.killMission?.dungeonID}` });
    });
  }
  // TODO: This finite observed pool is provisional. Keep the broader admitted
  // catalogue for restoring accepted missions and explicit test offers. Retain
  // older exact-context captures even when this newer sample did not draw them.
  return admitted.filter((missionID) => {
    const record = getMissionByID(missionID);
    return hasCapturedAgentOffer(agentRecord, { record,
      binding: dungeonAuthority.getSecurityMissionBinding(missionID),
      templateID: `client-dungeon:${record.killMission?.dungeonID}` });
  });
}


function supportedDungeonIDsForAgent(agentRecord) {
  const missionKind = normalizeText(agentRecord && agentRecord.missionKind, "").toLowerCase();
  if (missionKind === "mining") {
    return listMinableMissionDungeonIDsForLevel(agentRecord && agentRecord.level);
  }
  return null;
}

// A storyline mining agent also hands out storyline missions with other
// objectives, which the mining gate does not govern, so only its mining-site
// candidates are held to its level. Unfiltered, every level's sites reached
// level 1 storyline agents.
function filterMiningSitesToAgentLevel(agentRecord, missionIDs) {
  const supportedDungeonIDs = supportedDungeonIDsForAgent(agentRecord);
  if (!supportedDungeonIDs) {
    return missionIDs;
  }
  const minableDungeonIDs = listMinableMissionDungeonIDs();
  return missionIDs.filter((missionID) => {
    const record = getMissionByID(missionID);
    const dungeonID = toInt(record && record.killMission && record.killMission.dungeonID, 0);
    return !minableDungeonIDs.has(dungeonID) || supportedDungeonIDs.has(dungeonID);
  });
}

function filterUnsupportedAgentMissions(agentRecord, missionIDs) {
  const supportedDungeonIDs = supportedDungeonIDsForAgent(agentRecord);
  if (!supportedDungeonIDs) {
    return missionIDs;
  }
  return missionIDs.filter((missionID) => {
    const record = getMissionByID(missionID);
    const dungeonID = toInt(record && record.killMission && record.killMission.dungeonID, 0);
    return supportedDungeonIDs.has(dungeonID);
  });
}

function uniqueMissionIDs(missionIDs) {
  const seen = new Set();
  const result = [];
  for (const missionID of Array.isArray(missionIDs) ? missionIDs : []) {
    const normalizedMissionID = normalizeMissionID(missionID, null);
    const key = normalizedMissionID === null ? "" : String(normalizedMissionID);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(normalizedMissionID);
  }
  return result;
}

function listTemplateBoundMissionIDsForAgent(agentRecord = null) {
  const missionKind = normalizeText(agentRecord && agentRecord.missionKind, "").toLowerCase();
  if (missionKind !== "encounter") {
    return [];
  }
  const agentID = toInt(agentRecord && agentRecord.agentID, 0);
  if (agentID <= 0) {
    return [];
  }
  const missionIDs = [];
  for (const templateID of listMissionTemplateIDsForAgent(agentID)) {
    for (const missionID of listMissionIDsByTemplate(templateID)) {
      const record = getMissionByID(missionID);
      if (isGeneratedScrapedMissionRecord(record)) {
        missionIDs.push(missionID);
      }
    }
  }
  return uniqueMissionIDs(missionIDs);
}

function listPreferredMissionCandidateIDs(agentRecord = null) {
  const preferenceKeys = buildAgentPreferenceKeys(agentRecord);
  const preferenceSignature = preferenceKeys.join("\u0000");
  const authorityCache = ensureCache();
  const cachedMissionIDs = authorityCache.preferredCandidateIDsBySignature.get(
    preferenceSignature,
  );
  if (cachedMissionIDs) {
    return cloneValue(cachedMissionIDs);
  }
  const candidateMissionIDs = [];
  const seen = new Set();
  for (const preferenceKey of preferenceKeys) {
    const missionID = getPreferredMissionID(preferenceKey);
    if (missionID !== null && missionID !== undefined) {
      const preferredTemplateMission = getMissionByID(missionID);
      if (preferredTemplateMission && preferredTemplateMission.contentTemplate) {
        for (const templateMissionID of listMissionIDsByTemplate(
          preferredTemplateMission.contentTemplate,
        )) {
          const key = String(templateMissionID);
          if (seen.has(key)) {
            continue;
          }
          seen.add(key);
          candidateMissionIDs.push(templateMissionID);
        }
        continue;
      }
    }

    const fallbackMissionID = ensureCache().preferredMissionIDs.get(preferenceKey);
    if (fallbackMissionID !== undefined && fallbackMissionID !== null) {
      const key = String(fallbackMissionID);
      if (!seen.has(key)) {
        seen.add(key);
        candidateMissionIDs.push(fallbackMissionID);
      }
    }
  }
  authorityCache.preferredCandidateIDsBySignature.set(
    preferenceSignature,
    cloneValue(candidateMissionIDs),
  );
  return candidateMissionIDs;
}

function listMissionIDsForAgent(agentRecord = null) {
  const normalizedAgentID = toInt(agentRecord && agentRecord.agentID, 0);
  const agentSpecificMissionIDs = ensureCache().agentIDToMissionIDs.get(String(normalizedAgentID));
  if (agentSpecificMissionIDs && agentSpecificMissionIDs.length > 0) {
    return cloneValue(agentSpecificMissionIDs).filter((missionID) =>
      !isOrdinarySecurityAgent(agentRecord) || !(baselineChains.getPart(getMissionByID(missionID))?.part > 1));
  }

  if (isOrdinarySecurityAgent(agentRecord)) {
    return filterRegionalPirateVariants(agentRecord, uniqueMissionIDs([
      ...listGoldenSecurityMissionIDsForAgent(agentRecord),
      ...dungeonAuthority.listSecurityMissionBindings()
        .filter((binding) => getSecurityMissionBindingForAgent(agentRecord, getMissionByID(binding.missionID)) &&
          !(baselineChains.getPart(getMissionByID(binding.missionID))?.part > 1))
        .map((binding) => binding.missionID),
    ]));
  }

  const templateBoundMissionIDs = listTemplateBoundMissionIDsForAgent(agentRecord);
  const preferredMissionIDs = listPreferredMissionCandidateIDs(agentRecord);
  if (isResearchAgentRecord(agentRecord)) {
    return uniqueMissionIDs(preferredMissionIDs).filter((missionID) => {
      const missionRecord = getMissionByID(missionID);
      return missionRecord &&
        normalizeText(missionRecord.missionKind, "").toLowerCase() !== "encounter";
    });
  }
  if (isExplicitStorylineAgent(agentRecord)) {
    const storylineCandidateIDs = uniqueMissionIDs([
      ...templateBoundMissionIDs,
      ...preferredMissionIDs,
    ]);
    const missionKind = normalizeText(agentRecord && agentRecord.missionKind, "").toLowerCase();
    return missionKind === "encounter"
      ? storylineCandidateIDs.filter((missionID) =>
        isScriptedStorylineMissionRecord(getMissionByID(missionID)))
      : filterMiningSitesToAgentLevel(agentRecord, storylineCandidateIDs);
  }
  if (templateBoundMissionIDs.length > 0) {
    return filterUnsupportedAgentMissions(
      agentRecord,
      uniqueMissionIDs([...templateBoundMissionIDs, ...preferredMissionIDs]),
    );
  }
  return filterUnsupportedAgentMissions(agentRecord, preferredMissionIDs);
}

function pickMissionForAgent(agentRecord = null, selectionIndex = 0, lastMissionID = 0) {
  let missionIDs = listSelectableMissionIDsForAgent(agentRecord);
  if (!missionIDs.length) {
    return null;
  }

  if (isOrdinarySecurityAgent(agentRecord)) {
    // TODO: L1 captures show no adjacent identical IDs, but do show adjacent
    // variants sharing a title. Validate per-character/agent history scope and
    // exceptions. Apply the same rule to L2-5 as a TODO-marked extrapolation.
    if (missionIDs.length > 1) {
      missionIDs = missionIDs.filter((id) => id !== toInt(lastMissionID, 0));
    }
    // TODO: Equal weight per admitted mission ID remains provisional. Counts
    // in a finite capture do not establish TQ weights or family weighting.
    const index = Math.floor(randomSource.random() * missionIDs.length);
    return getMissionByID(missionIDs[index]);
  }

  const poolKey = normalizeText(agentRecord && agentRecord.missionPoolKey, "");
  const poolAgentOffset = poolKey
    ? listAgents()
      .filter((candidate) => normalizeText(candidate && candidate.missionPoolKey, "") === poolKey)
      .sort((left, right) => (
        toInt(left && left.agentID, 0) - toInt(right && right.agentID, 0)
      ))
      .findIndex((candidate) => toInt(candidate && candidate.agentID, 0) === toInt(agentRecord && agentRecord.agentID, 0))
    : -1;
  const index = Math.max(0, toInt(selectionIndex, 0)) + Math.max(0, poolAgentOffset);
  return getMissionByID(missionIDs[index % missionIDs.length]);
}

function getEpicArcMessageMaps() {
  return cloneValue(ensureCache().epicArcMessageMaps);
}

function getMissionArcInfo(missionID) {
  const missionRecord = getMissionByID(missionID);
  if (!missionRecord) {
    return null;
  }
  return {
    epicArcID: missionRecord.epicArcID,
    sourceAgentID: missionRecord.sourceAgentID,
    nextMissionIDs: cloneValue(missionRecord.nextMissionIDs || []),
    nextAgentIDs: cloneValue(missionRecord.nextAgentIDs || []),
    targetAgentID: missionRecord.targetAgentID,
  };
}

module.exports = {
  getRetirementGeneration,
  getSecurityMissionBindingForAgent,
  buildAgentPreferenceKeys,
  clearCache,
  getEpicArcMessageMaps,
  getMissionArcInfo,
  getMissionByID,
  getPayload,
  getPreferredMissionID,
  isAgentSpecificMissionIDForAgent,
  isExactConfiguredGoldenMissionRecord,
  getChainContinuationMissionID,
  isChainContinuationMissionID,
  isGeneratedScrapedMissionRecord,
  isMissionOfferAllowedForAgent,
  isOrdinarySecurityAgent,
  isPermanentlyDisabledMissionID,
  isPermanentlyDisabledMissionRecord,
  isResearchAgentRecord,
  isRetiredOrdinaryEncounterMissionForAgent,
  isScriptedMissionRecord,
  isSupportedLevelOneClientDungeonID,
  listMinableMissionDungeonIDs,
  listDisabledMissionIDs,
  listMissionIDsByTemplate,
  listMissionIDsForAgent,
  listSelectableMissionIDsForAgent,
  pickMissionForAgent,
};
