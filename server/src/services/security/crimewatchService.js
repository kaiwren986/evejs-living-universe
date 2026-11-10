"use strict";

const path = require("path");
const BaseService = require(path.join(__dirname, "../baseService"));
const log = require(path.join(__dirname, "../../utils/logger"));
const { PROXY_NODE_ID } = require(path.join(__dirname, "../../network/protocolProfile"));
const {
  getCharacterRecord,
} = require(path.join(__dirname, "../character/characterState"));
const crimewatchState = require(path.join(__dirname, "./crimewatchState"));
const sessionRegistry = require(path.join(__dirname, "../chat/sessionRegistry"));
const worldData = require(path.join(__dirname, "../../space/worldData"));
const { throwWrappedUserError } = require(path.join(__dirname, "../../common/machoErrors"));
const { getCharacterSetting } = require(path.join(__dirname, "../character/characterSettingsState"));
const { getSessionStationID, isStructureDockedSession } = require(path.join(__dirname, "../structure/structureLocation"));
const { isHighSecuritySystem, isLowSecuritySystem } = require(path.join(__dirname, "./systemSecurity"));
const {
  buildDict,
  buildFiletimeLong,
  buildList,
  buildBoundObjectResponse,
  currentFileTime,
  unwrapMarshalValue,
} = require(path.join(__dirname, "../_shared/serviceHelpers"));

const DUEL_OFFER_DURATION = 30n * 10_000_000n;

function duelCharacterID(value) {
  const numeric = Number(unwrapMarshalValue(value));
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : 0;
}

function duelSessionCharacterID(session) {
  return duelCharacterID(session && (session.characterID || session.charID || session.charid));
}

function duelLocation(session) {
  if (!session || isStructureDockedSession(session)) return null;
  const stationID = getSessionStationID(session);
  if (stationID) return `station:${stationID}`;
  const systemID = duelCharacterID(session.solarsystemid || session.solarSystemID);
  return systemID ? `space:${systemID}` : null;
}

function duelExpiry(value) {
  const unwrapped = unwrapMarshalValue(value);
  if (typeof unwrapped === "bigint") return unwrapped;
  if (typeof unwrapped === "number" && Number.isSafeInteger(unwrapped)) return BigInt(unwrapped);
  if (typeof unwrapped === "string" && /^\d+$/.test(unwrapped)) return BigInt(unwrapped);
  return null;
}

function hasBlockedDuelSource(character, sourceCharacterID) {
  return Object.entries(character.blockedOwners || {}).some(([key, owner]) =>
    duelCharacterID(owner && (owner.senderID ?? owner.contactID) || key) === sourceCharacterID);
}

class CrimewatchService extends BaseService {
  constructor() {
    super("crimewatch");
    // TQ keeps one crimewatch remote object alive for the client session and
    // returns that same OID on subsequent binds until the client releases it.
    this.reuseBoundObjectForSession = true;
    this._duelChallengesBySource = new Map();
    this._lastDuelExpiryTime = 0n;
    this._recoverDuelAchievements();
  }

  _recoverDuelAchievements() {
    require("./duelAchievementRuntime").recoverPendingDuelAchievements();
  }

  _pruneDuelChallenges(now) {
    for (const [sourceCharacterID, offer] of this._duelChallengesBySource) {
      if (offer.expiryTime <= now
        || sessionRegistry.findSessionByCharacterID(sourceCharacterID) !== offer.sourceSession
        || sessionRegistry.findSessionByCharacterID(offer.targetCharacterID) !== offer.targetSession) {
        this._duelChallengesBySource.delete(sourceCharacterID);
      }
    }
  }

  Handle_StartDuelChallenge(args, session) {
    this._recoverDuelAchievements();
    const sourceCharacterID = duelSessionCharacterID(session);
    const targetCharacterID = duelCharacterID(args && args[0]);
    if (!sourceCharacterID || !targetCharacterID || sourceCharacterID === targetCharacterID) return null;
    const now = currentFileTime();
    this._pruneDuelChallenges(now);
    const targetSession = sessionRegistry.findSessionByCharacterID(targetCharacterID);
    const location = duelLocation(session);
    if (!targetSession || !location || location !== duelLocation(targetSession)) {
      throwWrappedUserError("DuelChallengeFailNoSesssionForTarget", { targetCharID: targetCharacterID });
    }
    const station = getSessionStationID(session);
    const systemID = duelCharacterID(session.solarsystemid2 || session.solarsystemid || session.solarSystemID
      || (station && worldData.getStationByID(station)?.solarSystemID));
    const system = worldData.getSolarSystemByID(systemID);
    // CCP's Duel rules and native OfferDuelMenuEntry exclude zero-security space.
    // No installed zone-specific refusal is established, so leave this quiet.
    if (!isHighSecuritySystem(system) && !isLowSecuritySystem(system)) return null;
    if (crimewatchState.hasActiveLimitedEngagement(sourceCharacterID, targetCharacterID)) return null;
    const target = getCharacterRecord(targetCharacterID) || {};
    const autoReject = unwrapMarshalValue(getCharacterSetting(targetCharacterID, "autoRejectDuelInvitations", "0"));
    if (autoReject === "1" || autoReject === 1 || autoReject === true
      || hasBlockedDuelSource(target, sourceCharacterID)) {
      throwWrappedUserError("DuelChallengeFailBlockedByTarget", { targetCharID: targetCharacterID });
    }
    const previous = this._duelChallengesBySource.get(sourceCharacterID);
    if (previous) {
      throwWrappedUserError("DuelChallengeFailTooManyOutgoingRequests", {
        newTargetCharID: targetCharacterID,
        outstandingTargetCharID: previous.targetCharacterID,
      });
    }
    for (const offer of this._duelChallengesBySource.values()) {
      if (offer.targetCharacterID === targetCharacterID) {
        throwWrappedUserError("DuelChallengeFailTooManyIncomingRequests", { targetCharID: targetCharacterID });
      }
    }
    const requestedExpiry = now + DUEL_OFFER_DURATION;
    // Keep the echoed token unique even if consecutive offers start in one ms.
    const expiryTime = requestedExpiry > this._lastDuelExpiryTime
      ? requestedExpiry : this._lastDuelExpiryTime + 1n;
    const careerChallenge = require("../career/careerEventLedger").record(sourceCharacterID,
      { kind: "social", action: "duel-challenge", id: "duel:issued-challenge" });
    if (!careerChallenge.success) throw new Error(careerChallenge.errorMsg || "CAREER_DUEL_EVIDENCE_FAILED");
    this._lastDuelExpiryTime = expiryTime;
    this._duelChallengesBySource.set(sourceCharacterID, {
      targetCharacterID, expiryTime, sourceSession: session, targetSession,
    });
    const source = getCharacterRecord(sourceCharacterID) || {};
    try {
      targetSession.sendNotification("OnDuelChallenge", "clientID", [
        sourceCharacterID,
        duelCharacterID(session.corpid || session.corporationID || source.corporationID),
        duelCharacterID(session.allianceid || session.allianceID || source.allianceID) || null,
        buildFiletimeLong(expiryTime),
      ]);
    } catch (error) {
      this._duelChallengesBySource.delete(sourceCharacterID);
      throw error;
    }
    return null;
  }

  Handle_RespondToDuelChallenge(args, session) {
    this._recoverDuelAchievements();
    const targetCharacterID = duelSessionCharacterID(session);
    const sourceCharacterID = duelCharacterID(args && args[0]);
    const expiryTime = duelExpiry(args && args[1]);
    const accept = unwrapMarshalValue(args && args[2]);
    if (!targetCharacterID || !sourceCharacterID || expiryTime === null || typeof accept !== "boolean") return null;
    this._pruneDuelChallenges(currentFileTime());
    const offer = this._duelChallengesBySource.get(sourceCharacterID);
    // Authenticate the echoed expiry against the exact outstanding directed offer.
    // Stale/unsolicited/malformed responses are quiet, not invented retail errors.
    if (!offer || offer.targetCharacterID !== targetCharacterID
      || offer.targetSession !== session || offer.expiryTime !== expiryTime) return null;
    if (accept) {
      const result = crimewatchState.createOrRefreshLimitedEngagement(sourceCharacterID, targetCharacterID, {
        reason: "DUEL",
        duelReceiptID: `duel-v1:${sourceCharacterID}:${targetCharacterID}:${expiryTime}`,
      });
      if (!result?.success) return null;
      this._duelChallengesBySource.delete(sourceCharacterID);
      this._recoverDuelAchievements();
    } else {
      this._duelChallengesBySource.delete(sourceCharacterID);
      offer.sourceSession.sendNotification("OnRemoteMessage", "clientID", [
        "DuelChallengeDeclined", buildDict([["targetCharID", targetCharacterID]]),
      ]);
    }
    return null;
  }

  _resolveReferenceMs(session, fallback = Date.now()) {
    return (
      session &&
      session._space &&
      Number.isFinite(Number(session._space.simTimeMs))
    )
      ? Number(session._space.simTimeMs)
      : fallback;
  }

  _resolveSessionCharacterID(session) {
    return (
      session &&
      (session.characterID || session.charID || session.charid || session.userid)
    ) || 0;
  }

  Handle_MachoResolveObject(args, session, kwargs) {
    const bindParameter = args && args[0];
    void bindParameter;
    log.debug("[CrimewatchService] MachoResolveObject called");
    // The EVE client requests a bound object from this service.
    // In EVEmu, this returns the Node ID (e.g. 888444).
    // We return our configured proxy node ID.
    return PROXY_NODE_ID;
  }

  Handle_MachoBindObject(args, session, kwargs) {
    log.debug(
      `[CrimewatchService] MachoBindObject args=${args ? args.length : 0}`,
    );
    return buildBoundObjectResponse(this, args, session, kwargs);
  }

  Handle_GetClientStates(args, session, kwargs) {
    this._recoverDuelAchievements();
    log.debug("[CrimewatchService] GetClientStates called");
    const now = this._resolveReferenceMs(session, Date.now());
    return crimewatchState.buildClientStatesForSession(session, now);
  }

  Handle_GetSafetyLevel(args, session) {
    const characterID = this._resolveSessionCharacterID(session);
    return crimewatchState.getSafetyLevel(characterID);
  }

  Handle_SetSafetyLevel(args, session) {
    const characterID = this._resolveSessionCharacterID(session);
    const rawSafetyLevel = Array.isArray(args) && args.length > 0
      ? Number(args[0])
      : crimewatchState.SAFETY_LEVEL_FULL;
    const requestedSafetyLevel = Number.isFinite(rawSafetyLevel)
      ? rawSafetyLevel
      : crimewatchState.SAFETY_LEVEL_FULL;
    const result = crimewatchState.setSafetyLevel(
      characterID,
      requestedSafetyLevel,
    );
    return result.success ? result.data.safetyLevel : crimewatchState.SAFETY_LEVEL_FULL;
  }

  Handle_GetMySecurityStatus(args, session) {
    const charID =
      (session && (session.characterID || session.charid || session.userid)) || 0;
    const charData = charID ? getCharacterRecord(charID) || {} : {};
    const securityStatus = Number(
      charData.securityStatus ?? charData.securityRating ?? 0,
    );
    const normalizedStatus = Number.isFinite(securityStatus) ? securityStatus : 0;

    log.debug(
      `[CrimewatchService] GetMySecurityStatus(charID=${charID}) -> ${normalizedStatus}`,
    );

    return normalizedStatus;
  }

  Handle_GetCharacterSecurityStatus(args, session) {
    const charID =
      (args && args.length > 0 ? Number(args[0]) || 0 : 0) ||
      (session && (session.characterID || session.charid || session.userid)) ||
      0;
    const charData = charID ? getCharacterRecord(charID) || {} : {};
    const securityStatus = Number(
      charData.securityStatus ?? charData.securityRating ?? 0,
    );
    const normalizedStatus = Number.isFinite(securityStatus) ? securityStatus : 0;

    log.debug(
      `[CrimewatchService] GetCharacterSecurityStatus(charID=${charID}) -> ${normalizedStatus}`,
    );

    return normalizedStatus;
  }

  Handle_GetSecurityStatusTransactions() {
    log.debug("[CrimewatchService] GetSecurityStatusTransactions -> []");
    return buildList([]);
  }
}

module.exports = CrimewatchService;
