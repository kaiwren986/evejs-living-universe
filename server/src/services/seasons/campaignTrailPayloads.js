"use strict";

const { buildDict, buildList, buildKeyVal, buildObjectEx2, buildFiletimeLong } = require("../_shared/serviceHelpers");
const catalog = require("./campaignTrailCatalog");
const mining = require("./gallenteMiningCatalog");
const trading = require("./gallenteTradingCatalog");
const missions = require("./gallenteMissionCatalog");
const combat = require("./gallenteCombatCatalog");
const fw = require("./gallenteFwCatalog");
const homefront = require("./gallenteHomefrontCatalog");
const exploration = require("./gallenteExplorationCatalog");
const filetime = (ms) => buildFiletimeLong(BigInt(Math.trunc(ms)) * 10000n + 116444736000000000n);
const entries = (object) => Object.entries(object);

function primeLocalization(session) {
  if (!session || typeof session.sendNotification !== "function" || session._campaignTrailTextPrimed) return;
  // Localization.UpdateTextCache passes each value straight to the native
  // LoadMessageData API, which requires Python unicode even for ASCII text.
  const messages = buildDict(entries({ ...catalog.MESSAGES, ...mining.MESSAGES, ...trading.MESSAGES, ...missions.MESSAGES, ...exploration.MESSAGES, ...combat.MESSAGES, ...fw.MESSAGES, ...homefront.MESSAGES }).map(([id, value]) =>
    [Number(id), { type: "wstring", value }]));
  const languages = ["en-us", "de", "fr", "ru", "ja", "ko", "zh", "es"];
  session.sendNotification("OnUpdateLocalizationTextCache", "charid", [[
    buildDict(languages.map((language) => [language, messages])), buildDict([]), buildDict([]),
  ]]);
  session._campaignTrailTextPrimed = true;
}

function buildSeason(candidate) {
  return buildKeyVal(entries({
    season_id: candidate.seasonID, template_id: catalog.SEASON_ID,
    // Optional Job Board integration; this prototype uses the Agency season UI.
    feature_tag_id: null,
    title: candidate.titleID, news: candidate.newsID,
    // The native selection card exposes its information through the info icon.
    // Keep its optional footer disabled, as in the reference candidate cards.
    agency_card_title: candidate.titleID, agency_card_description: null,
    agency_card_hint: candidate.infoID, background_no_logo: catalog.EVENT_ART.content,
    navigation_card_picture_path: candidate.image, content_card_picture_path: catalog.EVENT_ART.content,
    start_time: filetime(catalog.START_TIME), end_time: filetime(catalog.END_TIME),
    tracked_event_types: buildList([]), multiple_season_running: true,
    is_auto_claim_enabled: false,
  }));
}

function buildChallenge(step, state, characterID) {
  const completion = step.key === "start" && catalog.isRunComplete(state)
    ? null : state.completed[step.key];
  const date = completion ? filetime(completion.completedAtMs) : null;
  const pending = state.pendingClaim?.challengeID === step.challengeID ? state.pendingClaim : null;
  // Challenge inherits from object (a Python 2 new-style class). PyObject is
  // only for old-style classes such as util.KeyVal and fails in blue.Unmarshal.
  // ObjectEx2 constructs via __new__ and restores the state without __init__.
  return buildObjectEx2("seasons.common.challenge.Challenge", entries({
    challenge_id: step.challengeID, challenge_type_id: step.challengeID,
    character_id: characterID, event_type: "dungeonEntered", season_id: catalog.getSeasonID(state),
    name: step.nameID, message_text: step.textID, progress_text: step.progressID,
    challenge_category: "Exploration", challenge_security: null,
    progress: completion || pending ? 1 : 0, max_progress: 1,
    points_awarded: step.points, isk_awarded: 0, reward_type: null,
    reward_amount: 0, reward_type_soul_bound: false,
    received_date: filetime(state.startedAtMs), start_date: filetime(state.startedAtMs),
    expiration_date: null, expiration_minutes: 0, finish_date: date,
    reward_date: pending ? filetime(pending.arrivedAtMs) : date,
    is_expired: false, is_dormant: Boolean(completion), is_coop: false,
    should_be_active_on_season_start: step.key === "start",
    should_only_appear_once_per_season: false, should_not_expire_at_downtime: true,
    is_chained: true, next_challenge: catalog.STEPS[(catalog.STEPS.indexOf(step) + 1) % catalog.STEPS.length].challengeID,
  }));
}

function activeChallenges(state, characterID) {
  const step = catalog.getActiveStep(state);
  const challenges = step ? [[step.challengeID, buildChallenge(step, state, characterID)]] : [];
  const miningStep = catalog.getCandidate(state) && mining.getActiveStep(state);
  if (miningStep) challenges.push([miningStep.challengeID, buildMiningChallenge(miningStep, state, characterID)]);
  const tradingStep = trading.getActiveStep(state);
  if (tradingStep) challenges.push([tradingStep.challengeID, buildTradingChallenge(tradingStep, state, characterID)]);
  const combatStep = combat.getActiveStep(state);
  const homefrontStep=homefront.getActiveStep(state);
  if(homefrontStep && (homefront.isAvailable() || state.homefront?.readyAtMs)) challenges.push([homefrontStep.challengeID,buildHomefrontChallenge(homefrontStep,state,characterID)]);
  const fwStep = fw.getActiveStep(state);
  if(fwStep) challenges.push([fwStep.challengeID,buildFwChallenge(fwStep,state,characterID)]);
  if (combatStep) challenges.push([combatStep.challengeID, buildCombatChallenge(combatStep, state, characterID)]);
  const explorationStep = exploration.getActiveStep(state);
  if (explorationStep) challenges.push([explorationStep.challengeID, buildExplorationChallenge(explorationStep, state, characterID)]);
  const missionStep = missions.getActiveStep(state);
  if (missionStep) challenges.push([missionStep.challengeID, buildMissionChallenge(missionStep, state, characterID)]);
  if (!catalog.isEnabled()) {
    const claimable = new Set();
    if (state.pendingClaim?.arrivedAtMs < catalog.END_TIME) claimable.add(state.pendingClaim.challengeID);
    for (const [family, base] of [["mining",91000000],["trading",92000000],["missions",93000000],["exploration",94000000],["combat",95000000],["fw",96000000],["homefront",97000000]]) {
      if (state[family]?.readyAtMs && state[family].readyAtMs < catalog.END_TIME) claimable.add(base + (state[family].claims || 0));
    }
    return buildDict(challenges.filter(([id]) => claimable.has(id)));
  }
  return buildDict(challenges);
}

function buildActivityChallenge(step, state, characterID, family, counter, eventType, baseID) {
  return buildObjectEx2("seasons.common.challenge.Challenge", entries({
    challenge_id: step.challengeID, challenge_type_id: baseID + Math.min(step.index, 5),
    character_id: characterID, event_type: eventType, season_id: catalog.getSeasonID(state),
    name: step.nameID, message_text: step.textID, progress_text: step.progressID,
    challenge_category: ["combat","fw","homefront"].includes(family) ? "Combat" : family === "mining" ? "Mining" : family === "missions" ? "Missions" : family === "exploration" ? "Exploration" : "Trading", challenge_security: null,
    progress: state[family]?.[counter] || 0, max_progress: step[counter],
    points_awarded: step.points, isk_awarded: 0, reward_type: step.typeID,
    reward_amount: step.quantity, reward_type_soul_bound: false,
    received_date: filetime(state.startedAtMs), start_date: filetime(state.startedAtMs),
    expiration_date: null, expiration_minutes: 0, finish_date: null,
    reward_date: state[family]?.readyAtMs ? filetime(state[family].readyAtMs) : null,
    is_expired: false, is_dormant: false, is_coop: false,
    should_be_active_on_season_start: step.index === 0,
    should_only_appear_once_per_season: step.index < 5, should_not_expire_at_downtime: true,
    is_chained: true,
    next_challenge: step.challengeID + 1,
  }));
}

function buildMiningChallenge(step, state, characterID) {
  return buildActivityChallenge(step, state, characterID, "mining", "volume", "mining", 91000000);
}

function buildTradingChallenge(step, state, characterID) {
  return buildActivityChallenge(step, state, characterID, "trading", "count", "itemTrader", 92000000);
}

function buildGoal(reward, state) {
  return buildDict(entries({
    points_required: reward.points, reward_type_id: reward.typeID, reward_amount: reward.quantity ?? 1,
    omega_only: false, completed: state.points >= reward.points,
    claimed: Boolean(state.claimedRewards?.[reward.points]),
  }));
}

function buildProgress(state, characterID) {
  const rewards = catalog.getRewards(state);
  const next = rewards.find((reward) => state.points < reward.points);
  return buildKeyVal(entries({
    character_id: characterID, season_id: catalog.getSeasonID(state),
    seasonal_points: state.points,
    max_seasonal_points: catalog.MAX_POINTS,
    seasonal_goals: buildDict(rewards.map((reward) => [reward.index, buildGoal(reward, state)])),
    next_seasonal_goal: next ? buildGoal(next, state) : null,
    last_seasonal_goal: buildGoal(rewards.at(-1), state),
    challenges: activeChallenges(state, characterID),
  }));
}

function buildMissionChallenge(step, state, characterID) {
  return buildActivityChallenge(step, state, characterID, "missions", "count", "missionCompleted", 93000000);
}
function buildExplorationChallenge(step, state, characterID) {
  return buildActivityChallenge(step, state, characterID, "exploration", "count", "containerHacked", 94000000);
}
function buildCombatChallenge(step, state, characterID) {
  return buildActivityChallenge(step, state, characterID, "combat", "count", "npcKilled", 95000000);
}
function buildFwChallenge(step,state,characterID) {
  return buildActivityChallenge(step,state,characterID,"fw","count","fwComplexCompleted",96000000);
}
function buildHomefrontChallenge(step,state,characterID) {
  return buildActivityChallenge(step,state,characterID,"homefront","count","homefrontCompleted",97000000);
}
module.exports = { buildHomefrontChallenge, buildFwChallenge, buildCombatChallenge, buildExplorationChallenge, filetime, primeLocalization, buildSeason, buildChallenge, buildMiningChallenge, buildTradingChallenge, buildMissionChallenge, activeChallenges, buildGoal, buildProgress };
