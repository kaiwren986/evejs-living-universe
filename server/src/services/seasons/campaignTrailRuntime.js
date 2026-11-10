"use strict";
const { getWallclockNowMs } = require("../../space/runtime/runtimeClock");

const database = require("../../gameStore");
const catalog = require("./campaignTrailCatalog");
const payloads = require("./campaignTrailPayloads");
const rewards = require("./campaignTrailRewards");
const mining = require("./gallenteMiningCatalog");
const trading = require("./gallenteTradingCatalog");
const missions = require("./gallenteMissionCatalog");
const combat = require("./gallenteCombatCatalog");
const fw = require("./gallenteFwCatalog");
const homefront = require("./gallenteHomefrontCatalog");
const exploration = require("./gallenteExplorationCatalog");
const TABLE = "campaignTrailProgress";

function getCharacterID(session) {
  const id = Number(session && (session.characterID || session.charid));
  return Number.isSafeInteger(id) && id > 0 ? id : 0;
}

function getProgress(characterID) {
  require("./eventLifecycle").concludeIfDue();
  const result = database.read(TABLE, `/${characterID}`);
  if (result.success && result.data && result.data.seasonID === catalog.SEASON_ID) {
    const state = { ...result.data, points: Math.min(catalog.MAX_POINTS, result.data.points),
      completed: { ...result.data.completed }, claimedRewards: { ...result.data.claimedRewards } };
    if (state.rewardTrackVersion !== catalog.REWARD_TRACK_VERSION) {
      // Keep the bus receipt at its original threshold; authored ship rewards
      // are not historical milestones and must not suppress new entitlements.
      state.claimedRewards = state.claimedRewards[1000] ? { 1000: true } : {};
      state.rewardTrackVersion = catalog.REWARD_TRACK_VERSION;
    }
    if ((Number(state.routeVersion) || 1) < catalog.ROUTE_VERSION) {
      // A finished short route becomes a fresh full run. An unfinished route
      // keeps its early stops, but its finish must follow the new destinations.
      const finishedShortRoute = ["start", "darieux", "kyonoke", "finish"]
        .every((key) => Boolean(state.completed[key]));
      if (finishedShortRoute) state.completed = {};
      else delete state.completed.finish;
      state.routeVersion = catalog.ROUTE_VERSION;
    }
    return state;
  }
  return { seasonID: catalog.SEASON_ID, routeVersion: catalog.ROUTE_VERSION, rewardTrackVersion: catalog.REWARD_TRACK_VERSION,
    startedAtMs: getWallclockNowMs(), points: 0, completed: {} };
}

function saveProgress(characterID, state) {
  require("./eventLifecycle").concludeIfDue();
  const previous = database.read(TABLE, `/${characterID}`).data;
  // The store may retain its argument by reference. Keep the caller's working
  // state detached so a subsequent mutation cannot bypass the next save.
  const result = database.write(TABLE, `/${characterID}`, structuredClone(state));
  if (!result.success) throw new Error(`Campaign Trail write failed: ${result.errorMsg}`);
  const flushed = database.flushTableSync(TABLE);
  if (!flushed.success) {
    // A failed flush must not leave an unannounced arrival/claim in memory,
    // otherwise the next tick/click would see it as already handled.
    if (previous) database.write(TABLE, `/${characterID}`, previous);
    else database.remove(TABLE, `/${characterID}`);
    throw new Error(`Campaign Trail flush failed: ${flushed.errorMsg}`);
  }
}

function settleRewards(session, state, notify = false) {
  const characterID = getCharacterID(session);
  if(characterID) require("../faction/fwOpenRewards").reconcileProgress(session,state);
  if(characterID) require("../homefront/homefrontHooks").rewards.reconcileProgress(session);
  if (characterID) {
    require("./gallenteMissionRuntime").reconcileProgress(session, state);
    require("./gallenteDepotRuntime").reconcileProgress(session, state);
    require("./gallenteFabricatorRuntime").reconcileProgress(session, state);
    const recovered = require("./gallenteOutreachRuntime").reconcileProgress(session, state);
    if (!recovered.success) throw new Error(`Outreach recovery failed: ${recovered.errorMsg}`);
  }
  if (!catalog.canClaim() || !characterID || !catalog.getCandidate(state)) return state;
  for (const reward of catalog.getRewards(state)) {
    if (state.points < reward.points || state.claimedRewards?.[reward.points]) continue;
    // Recover only a delivery already initiated by a claim (or the older auto-
    // claim implementation). Earning points or logging in never starts one.
    if (rewards.hasReceipt(session, characterID, reward)) {
      if (!rewards.grantOnce(session, characterID, reward)) continue;
      state.claimedRewards = { ...state.claimedRewards, [reward.points]: true };
      saveProgress(characterID, state);
      session.sendNotification?.("OnRedeemingQueueUpdated", "clientID", []);
    } else if (notify && !state.announcedRewards?.[reward.points]) {
      state.announcedRewards = { ...state.announcedRewards, [reward.points]: true };
      saveProgress(characterID, state);
      session.sendNotification?.("OnSeasonalGoalCompleted", "charid", [reward.index, payloads.buildGoal(reward, state)]);
    }
  }
  return state;
}

function claimGoalReward(session, goalIndex) {
  const characterID = getCharacterID(session);
  if (!catalog.canClaim() || !characterID || goalIndex === null || goalIndex === undefined || !Number.isInteger(Number(goalIndex))) return false;
  const state = getProgress(characterID);
  if (!catalog.getCandidate(state)) return false;
  const reward = catalog.getRewards(state).find(entry => entry.index === Number(goalIndex));
  if (!reward || state.points < reward.points) return false;
  if (state.claimedRewards?.[reward.points]) return true;
  if (!rewards.grantOnce(session, characterID, reward)) return false;
  state.claimedRewards = { ...state.claimedRewards, [reward.points]: true };
  saveProgress(characterID, state);
  session.sendNotification?.("OnRedeemingQueueUpdated", "clientID", []);
  return true;
}

function selectCandidate(session, seasonID) {
  const characterID = getCharacterID(session);
  const candidate = catalog.CANDIDATES.find((entry) => entry.seasonID === Number(seasonID));
  if (!catalog.isEnabled() || !characterID || !candidate) return null;
  const state = getProgress(characterID);
  if (state.candidateKey && state.candidateKey !== candidate.key) return null;
  state.candidateKey = candidate.key;
  state.selectedAtMs = state.selectedAtMs || getWallclockNowMs();
  saveProgress(characterID, state);
  return settleRewards(session, state);
}

function publishCompletion(session, state, step, characterID) {
  if (typeof session.sendNotification !== "function") return;
  const send = (name, args) => session.sendNotification(name, "charid", args);
  send("OnSeasonalPointsUpdated", [catalog.getSeasonID(state), state.points]);
  send("OnChallengeCompleted", [step.challengeID]);
  const next = catalog.isEnabled() ? catalog.getActiveStep(state) : null;
  send("OnChallengeExpired", [step.challengeID, next ? payloads.buildChallenge(next, state, characterID) : null]);
  if (state.points >= catalog.MAX_POINTS) {
    send("OnChallengeExpired", [91000000 + (state.mining?.claims || 0), null]);
    send("OnChallengeExpired", [92000000 + (state.trading?.claims || 0), null]);
    send("OnChallengeExpired", [93000000 + (state.missions?.claims || 0), null]);
    send("OnChallengeExpired", [95000000 + (state.combat?.claims || 0), null]);
    send("OnChallengeExpired", [97000000 + (state.homefront?.claims || 0), null]);
    send("OnChallengeExpired", [96000000 + (state.fw?.claims || 0), null]);
    send("OnChallengeExpired", [94000000 + (state.exploration?.claims || 0), null]);
  }
}

function claimChallenge(session, challengeID) {
  const characterID = getCharacterID(session);
  if (!catalog.canClaim() || !characterID) return false;
  const state = getProgress(characterID);
  require("../faction/fwOpenRewards").reconcileProgress(session, state);
  if (!require("./gallenteOutreachRuntime").reconcileProgress(session, state).success) return false;
  require("./gallenteMissionRuntime").reconcileProgress(session, state);
    require("./gallenteDepotRuntime").reconcileProgress(session, state);
    require("./gallenteFabricatorRuntime").reconcileProgress(session, state);
  require("../homefront/homefrontHooks").rewards.reconcileProgress(session);
  const homefrontStep=homefront.getActiveStep(state);
  if(homefrontStep && homefrontStep.challengeID===Number(challengeID)) return claimActivity(session,state,homefrontStep,characterID,"homefront","count",homefront,payloads.buildHomefrontChallenge);
  const fwStep = fw.getActiveStep(state);
  if (fwStep && fwStep.challengeID === Number(challengeID)) {
    return claimActivity(session,state,fwStep,characterID,"fw","count",fw,payloads.buildFwChallenge);
  }
  const combatStep = combat.getActiveStep(state);
  if (combatStep && combatStep.challengeID === Number(challengeID)) {
    return claimActivity(session, state, combatStep, characterID, "combat", "count", combat, payloads.buildCombatChallenge);
  }
  const explorationStep = exploration.getActiveStep(state);
  if (explorationStep && explorationStep.challengeID === Number(challengeID)) {
    return claimActivity(session, state, explorationStep, characterID, "exploration", "count", exploration, payloads.buildExplorationChallenge);
  }
  const missionStep = missions.getActiveStep(state);
  if (missionStep && missionStep.challengeID === Number(challengeID)) {
    return claimActivity(session, state, missionStep, characterID, "missions", "count", missions, payloads.buildMissionChallenge);
  }
  const miningStep = mining.getActiveStep(state);
  if (miningStep && miningStep.challengeID === Number(challengeID)) {
    return claimActivity(session, state, miningStep, characterID, "mining", "volume", mining, payloads.buildMiningChallenge);
  }
  const tradingStep = trading.getActiveStep(state);
  if (tradingStep && tradingStep.challengeID === Number(challengeID)) {
    return claimActivity(session, state, tradingStep, characterID, "trading", "count", trading, payloads.buildTradingChallenge);
  }
  const step = catalog.getActiveStep(state);
  if (!step || step.challengeID !== Number(challengeID) ||
      state.pendingClaim?.challengeID !== step.challengeID || state.pendingClaim.arrivedAtMs >= catalog.END_TIME) return false;
  state.completed[step.key] = {
    completedAtMs: state.pendingClaim.arrivedAtMs, itemID: step.itemID,
  };
  delete state.pendingClaim;
  state.points = Math.min(catalog.MAX_POINTS, state.points + step.points);
  saveProgress(characterID, state);
  publishCompletion(session, state, step, characterID);
  settleRewards(session, state, true);
  return true;
}

function recordMining(session, solarSystemID, typeID, quantity) {
  const characterID = getCharacterID(session);
  if (!catalog.isEnabled() || !characterID || !mining.ORE_TYPE_IDS.includes(Number(typeID)) ||
      !Number.isSafeInteger(quantity) || quantity <= 0) return false;
  const system = require("../../space/worldData").getSolarSystemByID(solarSystemID);
  if (Number(system?.factionID) !== 500004) return false;
  const state = getProgress(characterID);
  const step = catalog.getCandidate(state) && mining.getActiveStep(state);
  if (!step || state.mining?.readyAtMs) return false;
  const type = require("../inventory/itemTypeRegistry").resolveItemByTypeID(typeID);
  const volume = quantity * Number(type?.volume);
  if (!Number.isFinite(volume) || volume <= 0) return false;
  // Round below the smallest ore unit to avoid floating-point drift at a target.
  state.mining = { ...state.mining, volume: Math.min(step.volume,
    Math.round(((state.mining?.volume || 0) + volume) * 1000000) / 1000000) };
  if (state.mining.volume >= step.volume) state.mining.readyAtMs = getWallclockNowMs();
  saveProgress(characterID, state);
  if (typeof session.sendNotification === "function") {
    session.sendNotification("OnChallengeProgressUpdate", "charid", [step.challengeID, state.mining.volume]);
    if (state.mining.readyAtMs) session.sendNotification("OnChallengeRewardsGranted", "charid", [step.challengeID]);
  }
  return true;
}

function claimActivity(session, state, step, characterID, family, counter, activity, buildChallenge) {
  if (!catalog.getCandidate(state) || !state[family]?.readyAtMs || state[family].readyAtMs >= catalog.END_TIME || state[family][counter] < step[counter]) return false;
  const trailStep = catalog.getActiveStep(state);
  if (step.typeID && !rewards.grantOnce(session, characterID, {
    ...step, receiptKey: `${family}:${step.index}`, label: step.name,
  })) return false;
  state[family] = { claims: step.index + 1, [counter]: 0 };
  state.points = Math.min(catalog.MAX_POINTS, state.points + step.points);
  saveProgress(characterID, state);
  if (typeof session.sendNotification === "function") {
    session.sendNotification("OnSeasonalPointsUpdated", "charid", [catalog.getSeasonID(state), state.points]);
    session.sendNotification("OnChallengeCompleted", "charid", [step.challengeID]);
    const next = catalog.isEnabled() ? activity.getActiveStep(state) : null;
    session.sendNotification("OnChallengeExpired", "charid", [step.challengeID,
      next ? buildChallenge(next, state, characterID) : null]);
    if (state.points >= catalog.MAX_POINTS && trailStep) {
      session.sendNotification("OnChallengeExpired", "charid", [trailStep.challengeID, null]);
      for (const [other, base] of [["mining", 91000000], ["trading", 92000000], ["missions", 93000000], ["exploration", 94000000], ["combat", 95000000], ["fw",96000000], ["homefront",97000000]]) {
        if (other !== family) session.sendNotification("OnChallengeExpired", "charid", [base + (state[other]?.claims || 0), null]);
      }
    }
    if (step.typeID) session.sendNotification("OnRedeemingQueueUpdated", "clientID", []);
  }
  settleRewards(session, state, true);
  return true;
}

function checkSessionArrival(scene, session, nowMs) {
  if (!catalog.isEnabled() || !session?._space?.initialStateSent) return false;
  const characterID = getCharacterID(session);
  if (!characterID || session._campaignTrailInitialized !== characterID) return false;
  const state = getProgress(characterID);
  const step = catalog.getActiveStep(state);
  if (!step || state.pendingClaim || step.solarSystemID !== Number(scene.systemID)) return false;
  const ship = scene.getEntityByID(session._space.shipID);
  const target = scene.getEntityByID(step.itemID);
  // Never credit proximity while passing the destination in warp, or while
  // controlling an object other than this character's attached ship.
  if (!ship || ship.session !== session || !target || ship.mode === "WARP") return false;
  const position = scene.getPositionSnapshot(ship, { atSimTimeMs: nowMs, reason: "campaign-trail-arrival" });
  const destination = scene.getPositionSnapshot(target, { atSimTimeMs: nowMs, reason: "campaign-trail-destination" });
  if (!position.available || !destination.available) return false;
  const distance = Math.hypot(position.position.x - destination.position.x,
    position.position.y - destination.position.y, position.position.z - destination.position.z);
  // Match the distance displayed by the overview (surface-to-surface).
  const surfaceDistance = Math.max(0, distance - position.radius - destination.radius);
  if (!Number.isFinite(surfaceDistance) || surfaceDistance > catalog.ARRIVAL_RANGE_METERS) return false;
  // Keep the finished run until the pilot actually returns to the start.
  if (catalog.isRunComplete(state)) {
    state.completed = {};
    state.startedAtMs = getWallclockNowMs();
  }
  state.pendingClaim = { challengeID: step.challengeID, arrivedAtMs: getWallclockNowMs() };
  saveProgress(characterID, state);
  if (typeof session.sendNotification === "function") {
    session.sendNotification("OnChallengeProgressUpdate", "charid", [step.challengeID, 1]);
    // The native row uses reward_date to display its Claim Reward button.
    session.sendNotification("OnChallengeRewardsGranted", "charid", [step.challengeID]);
  }
  return true;
}

function tickScene(scene, nowMs) {
  if (!catalog.isEnabled() || !catalog.STEPS.some((step) => step.solarSystemID === scene.systemID)) return;
  for (const session of scene.sessions.values()) {
    if (session._campaignTrailRetryAtMs > getWallclockNowMs()) continue;
    try {
      checkSessionArrival(scene, session, nowMs);
      delete session._campaignTrailRetryAtMs;
    } catch (error) {
      session._campaignTrailRetryAtMs = getWallclockNowMs() + 30000;
      require("../../utils/logger").warn(
        `[CampaignTrail] Arrival for ${getCharacterID(session)} deferred: ${error.message}`,
      );
    }
  }
}

module.exports = { claimGoalReward, TABLE, getCharacterID, getProgress, saveProgress, settleRewards, selectCandidate, claimChallenge, recordMining, checkSessionArrival, tickScene };
