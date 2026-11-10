"use strict";

const path = require("path");

const BaseService = require(path.join(__dirname, "../baseService"));
const log = require(path.join(__dirname, "../../utils/logger"));
const { getCharacterRecord } = require(path.join(
  __dirname,
  "../character/characterState",
));
const {
  buildKeyVal,
  buildList,
} = require(path.join(__dirname, "../_shared/serviceHelpers"));

const { getCorporationRecord } = require("../corporation/corporationState");
const { buildCachedMethodCallResult } = require("../cache/objectCacheRuntime");
const authority = require("./factionWarfareAuthority");
const { buildZoneInfo } = require("./fwQueryPayloads");
const { buildDict, buildFiletimeLong } = require("../_shared/serviceHelpers");
const { resolveSessionCharacterID } = require("../_shared/sessionIdentity");

function resolveCharacterID(args, session) {
  return args?.length ? authority.positiveID(args[0]) || 0 : resolveSessionCharacterID(session);
}

function enlistmentOwner() { return require("../corporation/fwCharacterEnlistmentMgrService"); }

function resolveCorporationID(args, session) {
  if (args?.length) return authority.positiveID(args[0]) || 0;
  const character = require("../character/characterState").peekCharacterRecord(resolveSessionCharacterID(session));
  return character && !character.deletedAt && !character.isDeleted ? Number(character.corporationID) || 0 : 0;
}

function buildFactionStats() {
  const database = require("../../gameStore");
  const characters = database.read("characters", "/").data || {};
  const stats = Object.fromEntries(Object.keys(authority.MILITIAS).map(id => [id, {
    topCorporation: 0, topMemberCount: 0, militiaMembersCount: 0,
    corporationsCount: 0, systemsCount: 0, totalMembersCount: 0,
  }]));
  const corporations = new Map();
  for (const [key, character] of Object.entries(characters)) {
    const id = authority.positiveID(Number(key));
    if (!id || !character || character.deletedAt || character.isDeleted) continue;
    const faction = enlistmentOwner().getPersistedEnlistmentFactionID(id);
    const entry = stats[faction];
    if (!entry) continue;
    entry.totalMembersCount++;
    const corporationID = Number(character.corporationID) || 0;
    if (corporationID === authority.getMilitiaCorporationID(faction)) entry.militiaMembersCount++;
    if (enlistmentOwner().getPersistedCorporationFactionID(corporationID) !== faction) continue;
    const members = corporations.get(faction) || new Map();
    members.set(corporationID, (members.get(corporationID) || 0) + 1); corporations.set(faction, members);
  }
  for (const system of authority.listSystems()) stats[system.occupierID].systemsCount++;
  for (const [faction, members] of corporations) {
    const top = [...members].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
    Object.assign(stats[faction], { corporationsCount: members.size, topCorporation: top[0], topMemberCount: top[1] });
  }
  return buildDict(Object.entries(stats).map(([id, values]) => [Number(id), buildKeyVal(Object.entries(values))]));
}

function normalizePositiveInteger(value, fallback = null) {
  const numericValue = Number(value);
  return Number.isInteger(numericValue) && numericValue > 0
    ? numericValue
    : fallback;
}

function normalizeRank(value, fallback = null) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return fallback;
  }

  return Math.max(0, Math.min(9, Math.trunc(numericValue)));
}

function resolveWarFactionID(charData = {}) {
  return normalizePositiveInteger(
    (charData.characterID && enlistmentOwner().getPersistedEnlistmentFactionID(charData.characterID)) ??
      charData.warFactionID ?? charData.warfactionid,
    null,
  );
}

function resolveCurrentRank(charData = {}, fallback = null) {
  const directCandidates = [
    charData.facWarCurrentRank,
    charData.currentRank,
    charData.factionRank,
    charData.factionWarRank,
    charData.militiaRank,
    charData.warFactionRank,
  ];

  for (const candidate of directCandidates) {
    const normalized = normalizeRank(candidate, null);
    if (normalized !== null) {
      return normalized;
    }
  }

  if (charData.facWar && typeof charData.facWar === "object") {
    const nestedRank = normalizeRank(charData.facWar.currentRank, null);
    if (nestedRank !== null) {
      return nestedRank;
    }
  }

  if (charData.rankInfo && typeof charData.rankInfo === "object") {
    const nestedRank = normalizeRank(charData.rankInfo.currentRank, null);
    if (nestedRank !== null) {
      return nestedRank;
    }
  }

  return fallback;
}

function buildRankInfoPayload(characterID, factionID, currentRank) {
  return buildKeyVal([
    ["characterID", characterID || null],
    ["factionID", factionID],
    ["warFactionID", factionID],
    ["currentRank", currentRank],
  ]);
}

function normalizeRankOverviewEntry(entry, fallbackFactionID) {
  if (!entry || typeof entry !== "object") {
    return null;
  }

  const factionID = normalizePositiveInteger(
    entry.factionID ?? entry.warFactionID,
    fallbackFactionID,
  );
  const currentRank = normalizeRank(entry.currentRank, null);
  if (!factionID || currentRank === null) {
    return null;
  }

  return { factionID, currentRank };
}

function buildRankOverviewPayload(characterID, charData, session) {
  const factionID = resolveWarFactionID(charData, session);
  if (!factionID) {
    return buildList([]);
  }

  const sourceCandidates = [
    charData.facWarRankOverview,
    charData.rankOverview,
    charData.characterRankOverview,
    charData.factionRankOverview,
  ];
  const overviewSource = sourceCandidates.find(Array.isArray);
  const normalizedEntries = [];

  if (overviewSource) {
    for (const entry of overviewSource) {
      const normalized = normalizeRankOverviewEntry(entry, factionID);
      if (normalized) {
        normalizedEntries.push(normalized);
      }
    }
  } else {
    const currentRank = resolveCurrentRank(charData, 0);
    if (currentRank > 0) {
      normalizedEntries.push({ factionID, currentRank });
    }
  }

  return buildList(
    normalizedEntries.map((entry) =>
      buildRankInfoPayload(characterID, entry.factionID, entry.currentRank)
    ),
  );
}

function buildSingleRankInfo(characterID, charData, session) {
  const factionID = resolveWarFactionID(charData, session);
  if (!factionID) {
    return null;
  }

  return buildRankInfoPayload(
    characterID,
    factionID,
    resolveCurrentRank(charData, 0),
  );
}

class FacWarMgrService extends BaseService {
  constructor() {
    super("facWarMgr");
  }

  Handle_GetCorporationWarFactionID(args) {
    const corporationID = authority.positiveID(args && args[0]) || 0;
    const factionID = enlistmentOwner().getPersistedCorporationFactionID(corporationID);
    // Applying and accepting a corp invite.txt 355-373: run-cached, via a shared CachedObject; 0 when unaffiliated.
    return buildCachedMethodCallResult(factionID || 0, {
      serviceName: "facWarMgr", method: "GetCorporationWarFactionID", args: [corporationID],
      versionCheck: "run", proxyCache: true,
    });
  }

  Handle_GetCharacterEnrolledFaction(args, session) {
    const characterID = resolveCharacterID(args, session);
    return characterID ? enlistmentOwner().getPersistedEnlistmentFactionID(characterID) : null;
  }

  Handle_GetFactionMilitiaCorporation(args) {
    return authority.getMilitiaCorporationID(authority.positiveID(args?.[0]));
  }

  Handle_GetCorpFactionalWarStatus(args, session) {
    const corporationID = resolveCorporationID(args, session);
    const factionID = enlistmentOwner().getPersistedCorporationFactionID(corporationID);
    const corporation = corporationID ? getCorporationRecord(corporationID) : null;
    const rawDate = corporation?.factionalWarStartDate || corporation?.fw?.startDate;
    const date = authority.normalizeDateTaken(rawDate);
    const startDate = factionID && date ? buildFiletimeLong(date) : null;
    const result = buildKeyVal([["status", factionID ? 1 : null], ["factionID", factionID], ["startDate", startDate]]);
    const explicit = Boolean(args?.length);
    return buildCachedMethodCallResult(result, {
      serviceName: this.name, method: "GetCorpFactionalWarStatus", args: explicit ? [corporationID] : [],
      versionCheck: "15 seconds", sessionInfo: explicit ? null : "corpid",
      sessionInfoValue: explicit ? undefined : corporationID,
    });
  }

  Handle_GetStats_FactionInfo() {
    return buildCachedMethodCallResult(buildFactionStats(), {
      serviceName: this.name, method: "GetStats_FactionInfo", versionCheck: "1 minute",
    });
  }

  Handle_GetSolarSystemLPs(args, session) {
    const systemID = authority.positiveID(args?.length ? args[0] : session?.solarsystemid2 || session?.solarsystemid);
    return authority.getSystem(systemID)?.systemLP || 0;
  }

  Handle_GetSolarSystemLPsEx(args, session) { return this.Handle_GetSolarSystemLPs(args, session); }
  Handle_GetFacWarZoneInfo(args) { return buildZoneInfo(authority.positiveID(args?.[0])); }

  Handle_GetMyCharacterRankOverview(args, session) {
    const characterID = resolveCharacterID(args, session);
    const charData = characterID ? getCharacterRecord(characterID) || {} : {};
    const result = buildRankOverviewPayload(characterID, charData, session);

    log.debug(
      `[FacWarMgr] GetMyCharacterRankOverview(charID=${characterID}) -> ${result.items.length}`,
    );

    return result;
  }

  Handle_GetCharacterRankOverview(args, session) {
    const characterID = resolveCharacterID(args, session);
    const charData = characterID ? getCharacterRecord(characterID) || {} : {};
    const result = buildRankOverviewPayload(characterID, charData, session);

    log.debug(
      `[FacWarMgr] GetCharacterRankOverview(charID=${characterID}) -> ${result.items.length}`,
    );

    return result;
  }

  Handle_GetMyCharacterRankInfo(args, session) {
    const characterID = resolveCharacterID(args, session);
    const charData = characterID ? getCharacterRecord(characterID) || {} : {};
    const result = buildSingleRankInfo(characterID, charData, session);

    log.debug(
      `[FacWarMgr] GetMyCharacterRankInfo(charID=${characterID}) -> ${result ? "rank" : "none"}`,
    );

    return result;
  }

  Handle_GetCharacterRankInfo(args, session) {
    const characterID = resolveCharacterID(args, session);
    const charData = characterID ? getCharacterRecord(characterID) || {} : {};
    const result = buildSingleRankInfo(characterID, charData, session);

    log.debug(
      `[FacWarMgr] GetCharacterRankInfo(charID=${characterID}) -> ${result ? "rank" : "none"}`,
    );

    return result;
  }
}

// Admission reads persisted membership only. UI projections above retain their
// existing session fallback, but a client's session claim grants no capability.
FacWarMgrService.getPersistedCaptureFaction = function(characterID) {
  const character = require("../character/characterState").peekCharacterRecord(characterID);
  if (!character || character.deletedAt || character.isDeleted) return null;
  const factionID = require("../corporation/fwCharacterEnlistmentMgrService")
    .getPersistedEnlistmentFactionID(characterID);
  if ([500001, 500002, 500003, 500004].includes(factionID)) return 500018;
  return [500010, 500011].includes(factionID) ? factionID : null;
};
module.exports = FacWarMgrService;
