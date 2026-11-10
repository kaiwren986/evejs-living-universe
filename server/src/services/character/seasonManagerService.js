"use strict";

const path = require("path");

const BaseService = require(path.join(__dirname, "../baseService"));
const log = require(path.join(__dirname, "../../utils/logger"));
const {
  buildDict,
  buildFiletimeLong,
  buildKeyVal,
  buildList,
  currentFileTime,
} = require(path.join(__dirname, "../_shared/serviceHelpers"));

const DEFAULT_MAX_SEASONAL_POINTS = 1;
const DEFAULT_MAX_ACTIVE_CHALLENGES = 0;
const DEFAULT_LOGGED_CHALLENGE_ID = 192491367;
const auditEvents = [];
const campaignTrail = require("../seasons/campaignTrailCatalog");
const trailPayloads = require("../seasons/campaignTrailPayloads");
const gallenteMining = require("../seasons/gallenteMiningCatalog");
const gallenteTrading = require("../seasons/gallenteTradingCatalog");
const gallenteMissions = require("../seasons/gallenteMissionCatalog");
const gallenteCombat = require("../seasons/gallenteCombatCatalog");
const homefront = require("../seasons/gallenteHomefrontCatalog");
const gallenteFw = require("../seasons/gallenteFwCatalog");
const gallenteExploration = require("../seasons/gallenteExplorationCatalog");

function activeTrail(session) {
  if (!getCharacterID(session)) return false;
  if (campaignTrail.isEnabled()) return true;
  return campaignTrail.canClaim() && Boolean(campaignTrail.getCandidate(require("../seasons/campaignTrailRuntime").getProgress(getCharacterID(session))));
}

function trailState(session) {
  const runtime = require("../seasons/campaignTrailRuntime");
  return runtime.settleRewards(session, runtime.getProgress(getCharacterID(session)));
}

function getCharacterID(session) {
  return Number(
    session &&
      (
        session.characterID ||
        session.charid ||
        session.characterId
      ),
  ) || 0;
}

function cloneArgs(args) {
  return Array.isArray(args) ? args.slice() : [];
}

function recordAuditEvent(kind, args = [], session = null, kwargs = null) {
  auditEvents.push({
    kind,
    args: cloneArgs(args),
    kwargs: kwargs || null,
    characterID: getCharacterID(session) || null,
    timestamp: Date.now(),
  });
}

function buildEmptyChallengeDict() {
  return buildDict([]);
}

function buildNoActiveSeasonProgress(session) {
  const characterID = getCharacterID(session);
  return buildKeyVal([
    ["character_id", characterID || null],
    ["season_id", null],
    ["seasonal_points", 0],
    ["max_seasonal_points", DEFAULT_MAX_SEASONAL_POINTS],
    ["seasonal_goals", buildDict([])],
    ["next_seasonal_goal", null],
    ["last_seasonal_goal", null],
    ["challenges", buildEmptyChallengeDict()],
  ]);
}

function normalizeInteger(value, fallback = 0) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? Math.trunc(numericValue) : fallback;
}

function sendChallengeProgressUpdate(session, challengeID, progress) {
  if (!session || typeof session.sendNotification !== "function") {
    return false;
  }

  const normalizedChallengeID = normalizeInteger(
    challengeID,
    DEFAULT_LOGGED_CHALLENGE_ID,
  );
  if (normalizedChallengeID <= 0) {
    return false;
  }

  session.sendNotification("OnChallengeProgressUpdate", "charid", [
    normalizedChallengeID,
    Math.max(0, normalizeInteger(progress, 0)),
  ]);
  return true;
}

function sendChallengeRewardsGranted(session, challengeID) {
  if (!session || typeof session.sendNotification !== "function") {
    return false;
  }

  const normalizedChallengeID = normalizeInteger(
    challengeID,
    DEFAULT_LOGGED_CHALLENGE_ID,
  );
  if (normalizedChallengeID <= 0) {
    return false;
  }

  session.sendNotification("OnChallengeRewardsGranted", "charid", [
    normalizedChallengeID,
  ]);
  return true;
}

class SeasonManagerService extends BaseService {
  constructor() {
    super("seasonManager");
  }

  Handle_get_season_data_for_character(args, session) {
    log.debug("[SeasonManager] get_season_data_for_character called");
    if (activeTrail(session)) {
      trailPayloads.primeLocalization(session);
      const candidate = campaignTrail.getCandidate(trailState(session));
      return candidate ? trailPayloads.buildSeason(candidate)
        : buildList(campaignTrail.CANDIDATES.map((entry) => trailPayloads.buildSeason(entry)));
    }
    return null;
  }

  Handle_select_season(args, session) {
    recordAuditEvent("select_season", args, session);
    if (!activeTrail(session)) return null;
    const runtime = require("../seasons/campaignTrailRuntime");
    const state = runtime.selectCandidate(session, args && args[0]);
    if (!state) return false;
    trailPayloads.primeLocalization(session);
    session._campaignTrailInitialized = getCharacterID(session);
    if (typeof session.sendNotification === "function") {
      session.sendNotification("OnSeasonSelected", "charid", [getCharacterID(session),
        trailPayloads.buildSeason(campaignTrail.getCandidate(state)),
        trailPayloads.buildProgress(state, getCharacterID(session))]);
    }
    return null;
  }

  Handle_get_character_progress_by_character_id(args, session) {
    recordAuditEvent("get_character_progress_by_character_id", args, session);
    if (activeTrail(session)) {
      trailPayloads.primeLocalization(session);
      const state = trailState(session);
      if (!campaignTrail.getCandidate(state)) return buildNoActiveSeasonProgress(session);
      const progress = trailPayloads.buildProgress(state, getCharacterID(session));
      session._campaignTrailInitialized = getCharacterID(session);
      return progress;
    }
    return buildNoActiveSeasonProgress(session);
  }

  Handle_get_challenge(args, session) {
    recordAuditEvent("get_challenge", args, session);
    if (activeTrail(session)) {
      const step = campaignTrail.STEPS.find((entry) => entry.challengeID === Number(args && args[0]));
      const state = trailState(session);
      if (step && campaignTrail.getCandidate(state)) return trailPayloads.buildChallenge(step, state, getCharacterID(session));
      const miningStep = gallenteMining.getActiveStep(state);
      if (campaignTrail.getCandidate(state) && miningStep?.challengeID === Number(args && args[0])) {
        return trailPayloads.buildMiningChallenge(miningStep, state, getCharacterID(session));
      }
      const tradingStep = gallenteTrading.getActiveStep(state);
      if (tradingStep?.challengeID === Number(args && args[0])) {
        return trailPayloads.buildTradingChallenge(tradingStep, state, getCharacterID(session));
      }
      const homefrontStep=homefront.getActiveStep(state);
      if(homefrontStep && homefrontStep.challengeID===Number(args && args[0])) return trailPayloads.buildHomefrontChallenge(homefrontStep,state,getCharacterID(session));
      const fwStep = gallenteFw.getActiveStep(state);
      if(fwStep && fwStep.challengeID===Number(args && args[0])) return trailPayloads.buildFwChallenge(fwStep,state,getCharacterID(session));
      const combatStep = gallenteCombat.getActiveStep(state);
      if (combatStep && combatStep.challengeID === Number(args && args[0])) return trailPayloads.buildCombatChallenge(combatStep, state, getCharacterID(session));
      const explorationStep = gallenteExploration.getActiveStep(state);
      if (explorationStep && explorationStep.challengeID === Number(args && args[0])) return trailPayloads.buildExplorationChallenge(explorationStep, state, getCharacterID(session));
      const missionStep = gallenteMissions.getActiveStep(state);
      if (missionStep?.challengeID === Number(args && args[0])) {
        return trailPayloads.buildMissionChallenge(missionStep, state, getCharacterID(session));
      }
    }
    return null;
  }

  Handle_get_max_active_challenges() {
    if (campaignTrail.isEnabled()) return 8;
    return DEFAULT_MAX_ACTIVE_CHALLENGES;
  }

  Handle_challenge_is_dormant(args, session) {
    recordAuditEvent("challenge_is_dormant", args, session);
    if (activeTrail(session)) {
      const state = trailState(session);
      const current = campaignTrail.getActiveStep(state);
      if (campaignTrail.getCandidate(state) && gallenteMining.getActiveStep(state)?.challengeID === Number(args && args[0])) return false;
      if (gallenteTrading.getActiveStep(state)?.challengeID === Number(args && args[0])) return false;
      if (gallenteCombat.getActiveStep(state)?.challengeID === Number(args && args[0])) return false;
      if(homefront.getActiveStep(state)?.challengeID===Number(args && args[0])) return false;
      if (gallenteFw.getActiveStep(state)?.challengeID === Number(args && args[0])) return false;
      if (gallenteExploration.getActiveStep(state)?.challengeID === Number(args && args[0])) return false;
      if (gallenteMissions.getActiveStep(state)?.challengeID === Number(args && args[0])) return false;
      return !current || current.challengeID !== Number(args && args[0]);
    }
    return true;
  }

  Handle_get_challenge_expiration_date(args, session) {
    recordAuditEvent("get_challenge_expiration_date", args, session);
    return null;
  }

  Handle_get_season_end_time() {
    if (campaignTrail.isEnabled() || campaignTrail.canClaim()) return trailPayloads.filetime(campaignTrail.END_TIME);
    return buildFiletimeLong(currentFileTime());
  }

  Handle_get_loot_table_by_typeID(args, session) {
    recordAuditEvent("get_loot_table_by_typeID", args, session);
    return buildList([]);
  }

  Handle_fill_up_and_return_challenges_for_character(args, session) {
    recordAuditEvent("fill_up_and_return_challenges_for_character", args, session);
    if (activeTrail(session)) return trailPayloads.activeChallenges(trailState(session), getCharacterID(session));
    return buildEmptyChallengeDict();
  }

  Handle_claim_challenge_rewards(args, session) {
    recordAuditEvent("claim_challenge_rewards", args, session);
    // Only a persisted server-verified arrival can be claimed.
    if (activeTrail(session)) return require("../seasons/campaignTrailRuntime")
      .claimChallenge(session, args && args[0]);
    sendChallengeRewardsGranted(session, args && args[0]);
    return false;
  }

  Handle_claim_goal_reward(args, session) {
    recordAuditEvent("claim_goal_reward", args, session);
    if (activeTrail(session)) {
      if (!args || args[0] === undefined || args[0] === null) return false;
      return require("../seasons/campaignTrailRuntime").claimGoalReward(session, args[0]);
    }
    return false;
  }

  Handle_process_client_event(args, session, kwargs) {
    recordAuditEvent("process_client_event", args, session, kwargs);
    if (activeTrail(session)) return null;
    const progress =
      kwargs && Object.prototype.hasOwnProperty.call(kwargs, "amount")
        ? kwargs.amount
        : 0;
    sendChallengeProgressUpdate(session, DEFAULT_LOGGED_CHALLENGE_ID, progress);
    return null;
  }

  Handle_reload_fsd_data(args, session) {
    recordAuditEvent("reload_fsd_data", args, session);
    return false;
  }
}

SeasonManagerService._testing = {
  getAuditEvents() {
    return auditEvents.slice();
  },
  resetForTests() {
    auditEvents.length = 0;
  },
  constants: {
    DEFAULT_MAX_ACTIVE_CHALLENGES,
    DEFAULT_MAX_SEASONAL_POINTS,
    DEFAULT_LOGGED_CHALLENGE_ID,
  },
  sendChallengeProgressUpdate,
  sendChallengeRewardsGranted,
};

module.exports = SeasonManagerService;
