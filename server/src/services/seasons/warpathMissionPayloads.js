"use strict";

const { buildDict, buildList, buildKeyVal, buildObjectEx2 } = require("../_shared/serviceHelpers");
const { filetime } = require("./campaignTrailPayloads");
const { SEASON_ID, challengeID, getStep } = require("./warpathMissionRuntime");
const { EVENT_TYPE, TIERS } = require("./warpathMissionCatalog");
const TITLE_ID = 1042469;
const ART = "res:/UI/Texture/classes/Opportunities/CapDay2026_2_Air_Window_700x242.png";
const MAX_DISPLAY_POINTS = TIERS.reduce((points, step) => points + step.points, 0);

function buildSeason(state) {
  return buildKeyVal(Object.entries({
    season_id: SEASON_ID, template_id: SEASON_ID, feature_tag_id: null,
    title: TITLE_ID, news: TITLE_ID, agency_card_title: TITLE_ID,
    agency_card_description: null, agency_card_hint: TITLE_ID,
    background_no_logo: ART, navigation_card_picture_path: ART, content_card_picture_path: ART,
    start_time: filetime(state.startsAtMs), end_time: filetime(state.endsAtMs),
    tracked_event_types: buildList([]), multiple_season_running: false, is_auto_claim_enabled: false,
  }));
}

function buildChallenge(state, characterID) {
  const step = getStep(state);
  return buildObjectEx2("seasons.common.challenge.Challenge", Object.entries({
    challenge_id: challengeID(state), challenge_type_id: step.typeID, character_id: characterID,
    event_type: EVENT_TYPE, season_id: SEASON_ID,
    name: step.nameID, message_text: step.textID, progress_text: step.progressID,
    challenge_category: "PvE", challenge_security: "Any", progress: state.count, max_progress: step.count,
    points_awarded: step.points, isk_awarded: 0, reward_type: step.rewardTypeID,
    reward_amount: step.quantity, reward_type_soul_bound: false,
    received_date: filetime(state.receivedAtMs), start_date: filetime(state.receivedAtMs),
    expiration_date: null, expiration_minutes: 0, finish_date: null,
    reward_date: state.readyAtMs === null ? null : filetime(state.readyAtMs),
    is_expired: false, is_dormant: false, is_coop: false,
    should_be_active_on_season_start: step.activeAtStart, should_only_appear_once_per_season: step.once,
    should_not_expire_at_downtime: true, is_chained: !step.activeAtStart, next_challenge: step.nextTypeID,
  }));
}

function buildChallenges(state, characterID) {
  return buildDict([[challengeID(state), buildChallenge(state, characterID)]]);
}

function buildProgress(state, characterID) {
  return buildKeyVal(Object.entries({
    character_id: characterID, season_id: SEASON_ID, seasonal_points: state.points,
    max_seasonal_points: Math.max(MAX_DISPLAY_POINTS, state.points), seasonal_goals: buildDict([]),
    next_seasonal_goal: null, last_seasonal_goal: null, challenges: buildChallenges(state, characterID),
  }));
}

module.exports = { buildSeason, buildChallenge, buildChallenges, buildProgress };
