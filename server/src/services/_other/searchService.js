"use strict";

const path = require("path");

const BaseService = require(path.join(__dirname, "../baseService"));
const database = require(path.join(__dirname, "../../gameStore"));
const worldData = require(path.join(__dirname, "../../space/worldData"));
const {
  buildDict,
  buildKeyVal,
  buildList,
  extractList,
  normalizeText,
} = require(path.join(__dirname, "../_shared/serviceHelpers"));
const { strVal } = require(path.join(
  __dirname,
  "../../network/tcp/utils/marshal",
));
const {
  ensureAlliancesInitialized,
  ensureCorporationsInitialized,
  getAllianceRecord,
  getCorporationRecord,
} = require(path.join(__dirname, "../corporation/corporationState"));
const {
  getAllFactionRecords,
} = require(path.join(__dirname, "../faction/factionState"));
const {
  listAgents,
} = require(path.join(__dirname, "../agent/agentAuthority"));
const {
  TABLE,
  readStaticRows,
} = require(path.join(__dirname, "../_shared/referenceData"));

const MATCH_BY = {
  PARTIAL_TERMS: 0,
  EXACT_TERMS: 1,
  EXACT_PHRASE: 2,
  EXACT_PHRASE_ONLY: 3,
};
// The least a partial term may be for the terms to be read as partial (eve/common/script/search/const.py,
// min_wildcard_length).
const MIN_WILDCARD_LENGTH = 3;

const RESULT_TYPE = {
  AGENT: 1,
  CHARACTER: 2,
  CORPORATION: 3,
  ALLIANCE: 4,
  FACTION: 5,
  CONSTELLATION: 6,
  SOLAR_SYSTEM: 7,
  REGION: 8,
  STATION: 9,
  ITEM_TYPE: 10,
  STRUCTURE: 12,
  STRUCTURE_WITH_INLINED_DATA: 13,
};

const MAX_RESULT_COUNT = 500;
const STATIC_QUERY_CACHE_LIMIT = 512;
const staticSearchIndexCache = new Map();
const staticQueryResultCache = new Map();

function extractKwargValue(kwargs, key, fallback = undefined) {
  if (!kwargs) {
    return fallback;
  }

  if (kwargs.type === "dict" && Array.isArray(kwargs.entries)) {
  // A decoded dict key keeps the form the wire used, and `exact` and `hideNPC` sit outside
  // the marshal string table, so they arrive as raw Buffers and a raw comparison
  // drops them. See the note on accountService.extractKwarg.
    const entry = kwargs.entries.find(
      ([entryKey]) => strVal(entryKey) === key,
    );
    return entry ? entry[1] : fallback;
  }

  if (typeof kwargs === "object" && Object.prototype.hasOwnProperty.call(kwargs, key)) {
    return kwargs[key];
  }

  return fallback;
}

function normalizeSearchString(value) {
  return normalizeText(value, "").trim().toLowerCase();
}

function collapseSearchString(value) {
  return normalizeSearchString(value).replace(/[^a-z0-9]+/g, "");
}

// The client's own reading of the three exact modes (eve/client/script/ui/util/searchUtil.py IsMatch, 383 to 427),
// on a name and what is typed, each in lower case and trimmed, split on whitespace: exact terms, each word typed a
// whole word of the name; exact phrase, the words typed together and in order as whole words of the name; only exact
// phrase, the name what is typed. Until 2026-10-14 all three were the name as a whole.
function matchesWordsExactly(rawName, rawSearch, exactMode) {
  const typedWords = rawSearch.split(/\s+/).filter(Boolean);
  const nameWords = rawName.split(/\s+/).filter(Boolean);
  switch (Number(exactMode) || 0) {
    case MATCH_BY.EXACT_TERMS:
      return typedWords.every((word) => nameWords.includes(word));
    case MATCH_BY.EXACT_PHRASE:
      for (let start = 0; start + typedWords.length <= nameWords.length; start += 1) {
        if (typedWords.every((word, place) => nameWords[start + place] === word)) {
          return true;
        }
      }
      return false;
    default:
      return rawName === rawSearch;
  }
}

// Partial terms as the client reads them (searchUtil.IsMatch, 383 to 401): each term typed the start of a word of
// the name; where no term is of three letters or more, exact terms. Until 2026-10-14 each term, its punctuation taken
// out, was any part of the name run together.
function matchesPartialTerms(rawName, rawSearch) {
  const typedWords = rawSearch.split(/\s+/).filter(Boolean);
  if (!typedWords.some((word) => word.length >= MIN_WILDCARD_LENGTH)) {
    return matchesWordsExactly(rawName, rawSearch, MATCH_BY.EXACT_TERMS);
  }
  const nameWords = rawName.split(/\s+/).filter(Boolean);
  return typedWords.every((term) => nameWords.some((word) => word.startsWith(term)));
}

function appendMapListEntry(map, key, value) {
  if (!key) {
    return;
  }
  const existing = map.get(key);
  if (existing) {
    existing.push(value);
    return;
  }
  map.set(key, [value]);
}

function getStaticGroupSourceRows(groupID) {
  switch (Number(groupID) || 0) {
    case RESULT_TYPE.SOLAR_SYSTEM:
      return worldData.ensureLoaded().solarSystems;
    case RESULT_TYPE.STATION:
    case RESULT_TYPE.CONSTELLATION:
    case RESULT_TYPE.REGION:
      return worldData.ensureLoaded().stations;
    case RESULT_TYPE.ITEM_TYPE:
      return readStaticRows(TABLE.ITEM_TYPES);
    default:
      return null;
  }
}

function getStaticGroupEntryName(groupID, row) {
  switch (Number(groupID) || 0) {
    case RESULT_TYPE.SOLAR_SYSTEM:
      return String(row && row.solarSystemName || "");
    case RESULT_TYPE.STATION:
      return String(row && (row.stationName || row.itemName) || "");
    case RESULT_TYPE.CONSTELLATION:
      return String(row && row.constellationName || "");
    case RESULT_TYPE.REGION:
      return String(row && row.regionName || "");
    case RESULT_TYPE.ITEM_TYPE:
      return String(row && (row.name || row.typeName) || "");
    default:
      return "";
  }
}

function getStaticGroupEntryID(groupID, row) {
  switch (Number(groupID) || 0) {
    case RESULT_TYPE.SOLAR_SYSTEM:
      return Number(row && row.solarSystemID) || 0;
    case RESULT_TYPE.STATION:
      return Number(row && row.stationID) || 0;
    case RESULT_TYPE.CONSTELLATION:
      return Number(row && row.constellationID) || 0;
    case RESULT_TYPE.REGION:
      return Number(row && row.regionID) || 0;
    case RESULT_TYPE.ITEM_TYPE:
      return Number(row && row.typeID) || 0;
    default:
      return 0;
  }
}

function buildStaticSearchIndex(groupID) {
  const rows = getStaticGroupSourceRows(groupID);
  if (!rows) {
    return null;
  }

  const exactRawNameMap = new Map();
  const exactCollapsedNameMap = new Map();
  const seenEntryIDs = new Set();
  const entries = rows
    .map((row) => {
      const id = getStaticGroupEntryID(groupID, row);
      const name = getStaticGroupEntryName(groupID, row);
      const rawName = normalizeSearchString(name);
      const collapsedName = collapseSearchString(name);
      if (!id || !name || !collapsedName || seenEntryIDs.has(id)) {
        return null;
      }
      seenEntryIDs.add(id);
      const entry = {
        id,
        rawName,
        collapsedName,
      };
      appendMapListEntry(exactRawNameMap, rawName, id);
      appendMapListEntry(exactCollapsedNameMap, collapsedName, id);
      return entry;
    })
    .filter(Boolean);

  const index = {
    entries,
    exactRawNameMap,
    exactCollapsedNameMap,
  };
  staticSearchIndexCache.set(Number(groupID) || 0, index);
  return index;
}

function getStaticSearchIndex(groupID) {
  const normalizedGroupID = Number(groupID) || 0;
  if (staticSearchIndexCache.has(normalizedGroupID)) {
    return staticSearchIndexCache.get(normalizedGroupID);
  }
  return buildStaticSearchIndex(normalizedGroupID);
}

function getCachedStaticQueryResult(key) {
  if (!staticQueryResultCache.has(key)) {
    return null;
  }
  const cached = staticQueryResultCache.get(key);
  staticQueryResultCache.delete(key);
  staticQueryResultCache.set(key, cached);
  return [...cached];
}

function setCachedStaticQueryResult(key, resultIDs) {
  staticQueryResultCache.set(key, [...resultIDs]);
  if (staticQueryResultCache.size <= STATIC_QUERY_CACHE_LIMIT) {
    return;
  }
  const oldestKey = staticQueryResultCache.keys().next().value;
  if (oldestKey !== undefined) {
    staticQueryResultCache.delete(oldestKey);
  }
}

function searchStaticGroup(groupID, search, exactMode) {
  const index = getStaticSearchIndex(groupID);
  if (!index) {
    return null;
  }

  const rawSearch = normalizeSearchString(search);
  const collapsedSearch = collapseSearchString(search);
  const cacheKey = `${Number(groupID) || 0}|${Number(exactMode) || 0}|${rawSearch}`;
  const cached = getCachedStaticQueryResult(cacheKey);
  if (cached) {
    return cached;
  }
  if (!collapsedSearch) {
    return [];
  }

  let results = [];
  switch (Number(exactMode) || 0) {
    case MATCH_BY.EXACT_TERMS:
    case MATCH_BY.EXACT_PHRASE:
    case MATCH_BY.EXACT_PHRASE_ONLY: {
      // The names that are what is typed first, then those the mode takes as the client reads it.
      const named = (index.exactRawNameMap.get(rawSearch) || []).filter(Boolean);
      const seen = new Set(named);
      results = [
        ...named,
        ...index.entries
          .filter((entry) => !seen.has(entry.id) && matchesWordsExactly(entry.rawName, rawSearch, exactMode))
          .map((entry) => entry.id),
      ];
      break;
    }
    case MATCH_BY.PARTIAL_TERMS:
    default: {
      // The whole name first, then names beginning with what is typed, then the rest the terms take.
      const exactMatches = [];
      const prefixMatches = [];
      const substringMatches = [];
      for (const entry of index.entries) {
        if (!matchesPartialTerms(entry.rawName, rawSearch)) {
          continue;
        }
        if (
          entry.rawName === rawSearch ||
          entry.collapsedName === collapsedSearch
        ) {
          exactMatches.push(entry.id);
          continue;
        }
        if (
          entry.rawName.startsWith(rawSearch) ||
          entry.collapsedName.startsWith(collapsedSearch)
        ) {
          prefixMatches.push(entry.id);
          continue;
        }
        substringMatches.push(entry.id);
      }
      results = [...exactMatches, ...prefixMatches, ...substringMatches];
      break;
    }
  }

  const limitedResults = results.slice(0, MAX_RESULT_COUNT);
  setCachedStaticQueryResult(cacheKey, limitedResults);
  return limitedResults;
}

function matchesSearch(name, search, exactMode = MATCH_BY.PARTIAL_TERMS) {
  const rawTarget = normalizeSearchString(name);
  const rawSearch = normalizeSearchString(search);
  const collapsedSearch = collapseSearchString(search);
  if (!collapsedSearch) {
    return false;
  }

  switch (Number(exactMode) || 0) {
    case MATCH_BY.EXACT_TERMS:
    case MATCH_BY.EXACT_PHRASE:
    case MATCH_BY.EXACT_PHRASE_ONLY:
      return matchesWordsExactly(rawTarget, rawSearch, exactMode);
    case MATCH_BY.PARTIAL_TERMS:
    default:
      return matchesPartialTerms(rawTarget, rawSearch);
  }
}

function collectSearchableOwners(groupID, options = {}) {
  const hideNPC = options.hideNPC === true;
  switch (Number(groupID) || 0) {
    case RESULT_TYPE.AGENT:
      if (hideNPC) {
        return [];
      }
      return listAgents()
        .map((record) => ({
          id: Number(record && record.agentID) || 0,
          name: record && (record.ownerName || `Agent ${record.agentID}`),
        }))
        .filter((entry) => entry.id > 0 && entry.name);
    case RESULT_TYPE.CHARACTER: {
      const tableResult = database.read("characters", "/");
      const characters =
        tableResult && tableResult.success && tableResult.data && typeof tableResult.data === "object"
          ? tableResult.data
          : {};
      // Player search is a LIKE scan over every character, so it must stay
      // cheap. Read the raw stored name directly instead of getCharacterRecord,
      // which runs the full normalization pipeline and re-writes the entire
      // characters table to disk per record on a cold cache.
      return Object.entries(characters)
        .filter(([, record]) => record && typeof record === "object")
        .map(([characterID, record]) => {
          const id = Number(record.characterID || characterID) || 0;
          return {
            id,
            name: record.characterName || `Character ${id}`,
          };
        })
        .filter((entry) => entry.id > 0 && entry.name);
    }
    case RESULT_TYPE.CORPORATION: {
      const corporations = ensureCorporationsInitialized();
      return Object.keys((corporations && corporations.records) || {})
        .map((corporationID) => getCorporationRecord(corporationID))
        .filter((record) => record && (!hideNPC || record.isNPC !== true))
        .map((record) => ({
          id: Number(record.corporationID || 0) || 0,
          name: record.corporationName || `Corporation ${record.corporationID}`,
        }))
        .filter((entry) => entry.id > 0 && entry.name);
    }
    case RESULT_TYPE.ALLIANCE: {
      const alliances = ensureAlliancesInitialized();
      return Object.keys((alliances && alliances.records) || {})
        .map((allianceID) => getAllianceRecord(allianceID))
        .filter(Boolean)
        .map((record) => ({
          id: Number(record.allianceID || 0) || 0,
          name: record.allianceName || `Alliance ${record.allianceID}`,
        }))
        .filter((entry) => entry.id > 0 && entry.name);
    }
    case RESULT_TYPE.FACTION:
      return getAllFactionRecords()
        .map((record) => ({
          id: Number(record && record.factionID) || 0,
          name: record && (record.name || `Faction ${record.factionID}`),
        }))
        .filter((entry) => entry.id > 0 && entry.name);
    default:
      return [];
  }
}

/**
 * The structures a search names (ResultType structure 12 and structure_with_inlined_data 13). The client reads a 12's
 * results as structures' numbers, each then asked of its structure directory, and a 13's each as a structure's
 * structureID, typeID and itemName (searchUtil.py GetScrollEntryData, 208 to 225). Every structure kept that is not
 * destroyed is searched by its name; which structures Tranquility's search lists, and the form of a 13's results on
 * the wire, are not recorded: each is a KeyVal here, whose attributes the client reads.
 */
function searchStructures(groupID, search, exactMode) {
  const { listStructures } = require(path.join(__dirname, "../structure/structureState"));
  const found = listStructures({ refresh: false })
    .filter((entry) => matchesSearch(entry.itemName || entry.name, search, exactMode))
    .slice(0, MAX_RESULT_COUNT);
  if (groupID === RESULT_TYPE.STRUCTURE) {
    return found.map((entry) => entry.structureID);
  }
  return found.map((entry) => buildKeyVal([
    ["structureID", entry.structureID],
    ["typeID", entry.typeID],
    ["itemName", entry.itemName || entry.name],
    ["solarSystemID", entry.solarSystemID],
  ]));
}

function searchGroup(groupID, search, exactMode, options = {}) {
  if (groupID === RESULT_TYPE.STRUCTURE || groupID === RESULT_TYPE.STRUCTURE_WITH_INLINED_DATA) {
    return searchStructures(groupID, search, exactMode);
  }
  const staticMatches = searchStaticGroup(groupID, search, exactMode);
  if (staticMatches) {
    return staticMatches;
  }

  return collectSearchableOwners(groupID, options)
    .filter((entry) => matchesSearch(entry.name, search, exactMode))
    .map((entry) => entry.id)
    .slice(0, MAX_RESULT_COUNT);
}

function clearSearchCaches() {
  staticSearchIndexCache.clear();
  staticQueryResultCache.clear();
}

class SearchService extends BaseService {
  constructor() {
    super("search");
  }

  Handle_Query(args, session, kwargs) {
    const search = normalizeText(args && args[0], "");
    const groupIDs = extractList(args && args[1])
      .map((groupID) => Number(groupID))
      .filter((groupID) => Number.isFinite(groupID));
    const exactMode = Number(extractKwargValue(kwargs, "exact", 0)) || 0;
    const hideNPC = Boolean(Number(extractKwargValue(kwargs, "hideNPC", 0)) || 0);

    return buildDict(
      groupIDs.map((groupID) => [
        groupID,
        buildList(searchGroup(groupID, search, exactMode, { hideNPC })),
      ]),
    );
  }

  Handle_QuickQuery(args, session, kwargs) {
    const search = normalizeText(args && args[0], "");
    const groupIDs = extractList(args && args[1])
      .map((groupID) => Number(groupID))
      .filter((groupID) => Number.isFinite(groupID));
    const exactMode = Number(extractKwargValue(kwargs, "exact", 0)) || 0;
    const hideNPC = Boolean(Number(extractKwargValue(kwargs, "hideNPC", 0)) || 0);
    const matches = [];
    const seen = new Set();

    for (const groupID of groupIDs) {
      for (const ownerID of searchGroup(groupID, search, exactMode, { hideNPC })) {
        const numericOwnerID = Number(ownerID) || 0;
        if (numericOwnerID > 0 && !seen.has(numericOwnerID)) {
          seen.add(numericOwnerID);
          matches.push(numericOwnerID);
        }
      }
    }

    return buildList(matches);
  }
}

module.exports = SearchService;
module.exports._testing = {
  clearSearchCaches,
  searchStaticGroup,
};
