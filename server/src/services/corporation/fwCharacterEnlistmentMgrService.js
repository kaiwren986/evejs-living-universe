"use strict";

const path = require("path");

const BaseService = require(path.join(__dirname, "../baseService"));
const {
  buildFiletimeLong,
  buildList,
  currentFileTime,
} = require(path.join(__dirname, "../_shared/serviceHelpers"));
const {
  getCharacterRecord,
  updateCharacterRecord,
} = require(path.join(__dirname, "../character/characterState"));
const {
  getCorporationRecord,
} = require(path.join(__dirname, "./corporationState"));
const {
  normalizePositiveInteger,
  updateCorporationRuntime,
  getCorporationRuntime,
} = require(path.join(__dirname, "./corporationRuntimeState"));
const {
  getPersistedCorporationAuthority,
} = require(path.join(__dirname, "./corporationAuthority"));
const {
  throwWrappedUserError,
} = require(path.join(__dirname, "../../common/machoErrors"));

const FILETIME_TICKS_PER_DAY = 864000000000n;

function getPersistedCorporationFactionID(corporationID) {
  const authority = require("../faction/factionWarfareAuthority");
  if (!authority.positiveID(corporationID)) return null;
  const corporation = getCorporationRecord(corporationID);
  if (!corporation || corporation.deleted) return null;
  const explicit = Number(corporation.warFactionID || (!corporation.isNPC && corporation.factionID));
  return [500001, 500002, 500003, 500004, 500010, 500011].includes(explicit) ? explicit
    : authority.getFactionIDForMilitiaCorporationID(corporationID);
}

function resolveCharacterID(session) {
  return Number(session && (session.characterID || session.charid)) || 0;
}

function resolveCorporationID(session) {
  const character = require("../character/characterState").peekCharacterRecord(resolveCharacterID(session));
  return character && !character.deletedAt && !character.isDeleted ? Number(character.corporationID) || 0 : 0;
}

function pushWarFactionSessionChange(session, nextWarFactionID) {
  if (!session || typeof session.sendSessionChange !== "function") {
    return;
  }
  const previousWarFactionID = session.warFactionID ?? session.warfactionid ?? null;
  if (previousWarFactionID === nextWarFactionID) {
    return;
  }
  session.warFactionID = nextWarFactionID;
  session.warfactionid = nextWarFactionID;
  session.sendSessionChange({
    warfactionid: [previousWarFactionID, nextWarFactionID],
  });
}

function requireCorporationEnlistmentPolicyAuthority(session) {
  const authority = getPersistedCorporationAuthority(session);
  if (!authority || (!authority.isCEO && !authority.isDirector)) {
    throwWrappedUserError("CrpAccessDenied", {
      reason: [101, "UI/Corporations/AccessRestrictions/InsufficientRoles"],
    });
  }
  return authority;
}

class FwCharacterEnlistmentMgrService extends BaseService {
  constructor() {
    super("fwCharacterEnlistmentMgr");
  }

  Handle_GetMyEnlistment(args, session) {
    const characterID = resolveCharacterID(session);
    const corporationID = resolveCorporationID(session);
    const characterRecord = getCharacterRecord(characterID) || {};
    const directFactionID =
      normalizePositiveInteger(characterRecord.directFactionID, null) || null;
    const corpFactionID = getPersistedCorporationFactionID(corporationID);
    return [
      directFactionID || corpFactionID || null,
      directFactionID,
      corpFactionID,
    ];
  }

  Handle_GetCorpAllowedEnlistmentFactions(args) {
    const corporationID = args && args.length > 0 ? Number(args[0]) || 0 : 0;
    const runtime = getCorporationRuntime(corporationID) || {};
    return buildList((runtime.fw && runtime.fw.allowedEnlistmentFactions) || []);
  }

  Handle_SetMyCorpAllowedEnlistmentFactions(args, session) {
    const authority = requireCorporationEnlistmentPolicyAuthority(session);
    const corporationID = authority.corporationID;
    const factions = Array.isArray(args && args[0]) ? args[0] : [];
    updateCorporationRuntime(corporationID, (runtime) => {
      runtime.fw.allowedEnlistmentFactions = factions;
      return runtime;
    });
    return buildList(factions);
  }

  Handle_GetMyDirectEnlistmentCooldownTimestamp(args, session) {
    const characterRecord = getCharacterRecord(resolveCharacterID(session)) || {};
    return buildFiletimeLong(characterRecord.directEnlistmentCooldownTimestamp || "0");
  }

  Handle_CreateMyDirectEnlistment(args, session) {
    const factionID = normalizePositiveInteger(args && args[0], null);
    const characterID = resolveCharacterID(session);
    if (!(characterID > 0) || !factionID) {
      return null;
    }
    const previous = getCharacterRecord(characterID);
    const enlistedAtMs = Math.max(1, Math.trunc(require("../../space/runtime/runtimeClock").getWallclockNowMs()));
    const written = updateCharacterRecord(characterID, (record) => ({
      ...record,
      warFactionID: factionID,
      directFactionID: factionID,
      directEnlistmentCooldownTimestamp: "0",
      ...([500001, 500002, 500003, 500004, 500010, 500011].includes(factionID)
        ? { careerFwEnlistment: { factionID, enlistedAtMs } } : {}),
    }));
    if (!written?.success)
      throwWrappedUserError("CustomNotify", { notify: "Failed to save militia enlistment." });
    let flushed;
    try { flushed = require("../../gameStore").flushTableSync("characters"); }
    catch (_) { flushed = { success: false }; }
    if (!flushed?.success) {
      updateCharacterRecord(characterID, () => previous);
      throwWrappedUserError("CustomNotify", { notify: "Failed to save militia enlistment." });
    }
    try { require("../career/careerProgress").sync(characterID); }
    catch (error) { require("../../utils/logger").warn(`[Career] militia enlistment awaits projection: ${error.message}`); }
    pushWarFactionSessionChange(session, factionID);
    return null;
  }

  Handle_RemoveMyDirectEnlistment(args, session) {
    const characterID = resolveCharacterID(session);
    const corporationID = resolveCorporationID(session);
    if (!(characterID > 0)) {
      return null;
    }

    const corpFactionID = getPersistedCorporationFactionID(corporationID);
    const cooldownTimestamp = (currentFileTime() + FILETIME_TICKS_PER_DAY).toString();
    updateCharacterRecord(characterID, (record) => ({
      ...record,
      warFactionID: corpFactionID,
      directFactionID: null,
      directEnlistmentCooldownTimestamp: cooldownTimestamp,
    }));
    pushWarFactionSessionChange(session, corpFactionID);
    return null;
  }
}

FwCharacterEnlistmentMgrService.getPersistedEnlistmentFactionID = function(characterID) {
  const character = require("../character/characterState").peekCharacterRecord(characterID);
  if (!character || character.deletedAt || character.isDeleted) return null;
  const factions = [500001, 500002, 500003, 500004, 500010, 500011];
  const directFactionID = normalizePositiveInteger(character.directFactionID, null);
  if (factions.includes(directFactionID)) return directFactionID;
  const corporationFaction = getPersistedCorporationFactionID(character.corporationID);
  const explicit = normalizePositiveInteger(character.warFactionID ?? character.warfactionid, null);
  return corporationFaction || (factions.includes(explicit) ? explicit : null);
};
FwCharacterEnlistmentMgrService.getPersistedCorporationFactionID = getPersistedCorporationFactionID;
module.exports = FwCharacterEnlistmentMgrService;
