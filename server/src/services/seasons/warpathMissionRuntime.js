"use strict";

const database = require("../../gameStore");
const { getWallclockNowMs } = require("../../space/runtime/runtimeClock");
const schedule = require("./eventSchedule");
const election = require("./campaignTrailCatalog");
const catalog = require("./warpathMissionCatalog");
const rewards = require("../newEdenStore/rewardRedeemTokens");
const { WARPATH_VERSION } = require("../../config/eventSchedules");

// Local wire and persistence identity for the first scheduled run.
const SEASON_ID = 9012360;
const CHALLENGE_BASE = 98000000;
const TABLE = "missionRuntimeState";
const getOwner = () => require("../agent/missionRuntimeState");
const getCharacterID = session => Number(session?.characterID || session?.charid || session?.characterId) || 0;
const getStep = state => catalog.TIERS[Math.min(state.claims, catalog.TIERS.length - 1)];
const challengeID = state => CHALLENGE_BASE + state.claims;
const ownsChallengeID = id => Number.isSafeInteger(Number(id)) && Number(id) >= CHALLENGE_BASE && Number(id) < 99000000;

function activeEvent(nowMs) {
  return election.isEnabled(nowMs) ? null : schedule.openWarpath(nowMs);
}

function newState(event) {
  return { version: WARPATH_VERSION, startsAtMs: event.startsAtMs, endsAtMs: event.endsAtMs,
    receivedAtMs: event.startsAtMs, claims: 0, count: 0, points: 0, readyAtMs: null };
}

function matchesEvent(state, event) {
  return event && state.version === WARPATH_VERSION && state.startsAtMs === event.startsAtMs && state.endsAtMs === event.endsAtMs;
}

// The mission owner calls this once while removing the active mission. Both
// mutations commit together, so completion retries cannot reapply its credit.
function stageCompletion(characterState, agent, mission) {
  const nowMs = getWallclockNowMs();
  const event = activeEvent(nowMs);
  if (!event || !catalog.isEligible(agent, mission)) return;
  const state = characterState.warpathMissionChallenge || newState(event);
  if (!matchesEvent(state, event) || state.readyAtMs !== null) return;
  state.count += 1;
  if (state.count === getStep(state).count) state.readyAtMs = nowMs;
  characterState.warpathMissionChallenge = state;
}

function readState(characterID) {
  const state = database.read(TABLE, `/charactersByID/${characterID}/warpathMissionChallenge`).data;
  return state ? { ...state } : null;
}

function observeProgress(session, state) {
  session._warpathChallenge = { characterID: getCharacterID(session), id: challengeID(state), count: state.count };
}

// Mission finalization has already flushed the owner before sending this.
function publishCompletion(session) {
  const seen = session?._warpathChallenge;
  if (!seen || seen.characterID !== getCharacterID(session)) return;
  const state = readState(seen.characterID);
  if (!state || challengeID(state) !== seen.id || state.count <= seen.count) return;
  observeProgress(session, state);
  session.sendNotification?.("OnChallengeProgressUpdate", "charid", [seen.id, state.count]);
  if (state.readyAtMs !== null) session.sendNotification?.("OnChallengeRewardsGranted", "charid", [seen.id]);
}

const receiptKey = (characterID, state) => `warpath:${state.version}:${characterID}:${challengeID(state)}`;

function saveClaim(characterID, previous, next) {
  const write = getOwner().mutateCharacterState(characterID, current => {
    current.warpathMissionChallenge = next;
    return true;
  });
  if (!write.success) throw new Error(`Warpath claim write failed: ${write.errorMsg}`);
  const flushed = database.flushTableSync(TABLE);
  if (!flushed.success) {
    getOwner().mutateCharacterState(characterID, current => {
      current.warpathMissionChallenge = previous;
      return true;
    });
    throw new Error(`Warpath claim flush failed: ${flushed.errorMsg}`);
  }
}

function advance(characterID, state, step) {
  const next = { ...state, claims: state.claims + 1, count: 0, points: state.points + step.points,
    readyAtMs: null, receivedAtMs: getWallclockNowMs() };
  saveClaim(characterID, state, next);
  return next;
}

function getModel(session) {
  const characterID = getCharacterID(session);
  if (!characterID) return null;
  const event = activeEvent(getWallclockNowMs());
  let state = readState(characterID);
  if (state?.readyAtMs != null && getStep(state).rewardTypeID && rewards.hasReceipt(characterID, receiptKey(characterID, state))) {
    // A prior claim committed its account token before advancing the mission
    // owner. Resume only that claim, including if the token was redeemed.
    state = commitClaim(characterID, state, getStep(state));
  }
  if (!state && event) state = newState(event);
  const active = Boolean(state && matchesEvent(state, event));
  return active || state?.readyAtMs != null ? { characterID, state, active } : null;
}

function commitClaim(characterID, state, step) {
  if (step.rewardTypeID) rewards.grantOnce(characterID, {
    receiptKey: receiptKey(characterID, state), typeID: step.rewardTypeID, quantity: step.quantity,
    label: "Capsuleer Day XXIII: Warpath", description: "Empire Security Missions challenge reward",
  });
  return advance(characterID, state, step);
}

function claim(session, id) {
  const characterID = getCharacterID(session);
  const state = characterID && readState(characterID);
  if (!state || state.readyAtMs === null || state.readyAtMs >= state.endsAtMs || Number(id) !== challengeID(state)) return false;
  // Fence an in-memory mission completion after an interrupted owner flush.
  const flushed = database.flushTableSync(TABLE);
  if (!flushed.success) throw new Error(`Warpath mission credit flush failed: ${flushed.errorMsg}`);
  const step = getStep(state);
  const next = commitClaim(characterID, state, step);
  const canContinue = matchesEvent(next, activeEvent(getWallclockNowMs()));
  const send = (name, args) => session.sendNotification?.(name, "charid", args);
  send("OnSeasonalPointsUpdated", [SEASON_ID, next.points]);
  send("OnChallengeCompleted", [challengeID(state)]);
  send("OnChallengeExpired", [challengeID(state), canContinue ?
    require("./warpathMissionPayloads").buildChallenge(next, characterID) : null]);
  if (canContinue) observeProgress(session, next);
  else delete session._warpathChallenge;
  if (step.rewardTypeID) require("../campaign/loginCampaignRuntime").notify(session);
  return true;
}

module.exports = { SEASON_ID, getModel, getStep, challengeID, ownsChallengeID,
  observeProgress, stageCompletion, publishCompletion, claim };
