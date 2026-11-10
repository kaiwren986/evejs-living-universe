"use strict";

const database = require("../../gameStore");
const schedule = require("../seasons/eventSchedule");
const catalog = require("./gallenteElectionLoginRewards.json");
const store = require("../newEdenStore/storeState");
const SubscriptionMgrService = require("../subscription/subscriptionMgrService");
const { buildDict, currentFileTime } = require("../_shared/serviceHelpers");
const TABLE = "newEdenStoreRuntime";
const DAY_MS = 86400000;
const RESET_MS = 11 * 3600000;
const PYTHON_UNIX_ORDINAL = 719163;

function accountID(session) {
  const value = Number(session && (session.userid || session.userID || session.accountID));
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function isActive(nowMs) {
  return schedule.isActive(schedule.LOGIN, nowMs);
}

function rewardDate(nowMs) {
  return Math.floor((nowMs - RESET_MS) / DAY_MS) + PYTHON_UNIX_ORDINAL;
}

function getState(account) {
  const stored = account.gallenteElectionLogin;
  if (!stored || stored.campaignID !== catalog.campaignID) {
    return { campaignID: catalog.campaignID, history: {}, lastTokenID: 0 };
  }
  return { ...stored, history: { ...stored.history } };
}

function getActiveCampaign(session, nowMs) {
  const id = accountID(session);
  if (!id || !isActive(nowMs)) return [null, null, null, null];
  const state = getState(store.readRuntimeAccount(id));
  return [catalog.campaignID, Math.floor(schedule.get(schedule.LOGIN).endsAtMs / DAY_MS) + PYTHON_UNIX_ORDINAL,
    "11:00:00", Math.max(0, catalog.days.length - Object.keys(state.history).length)];
}

function getClaimHistory(session, nowMs) {
  const id = accountID(session);
  if (!id || !isActive(nowMs)) return buildDict([]);
  const state = getState(store.readRuntimeAccount(id));
  return buildDict(Object.entries(state.history).map(([date, grade]) => [Number(date), grade]));
}

function flush() {
  const result = database.flushTableSync(TABLE);
  if (!result.success) throw new Error(`Election login rewards flush failed: ${result.errorMsg}`);
}

function claimReward(session, nowMs) {
  const id = accountID(session);
  if (!id || !isActive(nowMs)) return false;
  const account = store.readRuntimeAccount(id);
  const state = getState(account);
  const dates = Object.keys(state.history).map(Number).sort((a, b) => a - b);
  const today = rewardDate(nowMs);
  // Never move the claim sequence backwards if a server clock is corrected.
  if (dates.length && today < dates.at(-1)) return false;
  const grade = new SubscriptionMgrService().Handle_GetCloneGrade([], { ...session, userid: id });
  const omega = grade === 1;
  const grants = [];
  // Match the stock campaign's retroClaim behavior when an Alpha upgrades.
  if (omega && catalog.retroClaim) {
    for (const [index, date] of dates.entries()) {
      if (state.history[date] === 0 && index < catalog.days.length) {
        grants.push({ day: index + 1, track: "Omega", reward: catalog.days[index].omega });
        state.history[date] = 1;
      }
    }
  }
  if (!Object.hasOwn(state.history, today) && dates.length < catalog.days.length) {
    const day = catalog.days[dates.length];
    grants.push({ day: day.day, track: "Alpha", reward: day.alpha });
    if (omega) grants.push({ day: day.day, track: "Omega", reward: day.omega });
    state.history[today] = omega ? 1 : 0;
  }
  if (!grants.length) {
    // A previous request may have written in memory but failed its flush.
    flush();
    return false;
  }
  const tokens = [...account.redeemTokens];
  let tokenID = Math.max(Number(state.lastTokenID) || 0,
    700000000 + (nowMs % 100000000),
    ...tokens.flatMap((token) => [Number(token.tokenID) || 0, Number(token.massTokenID) || 0]));
  for (const { day, track, reward } of grants) {
    tokens.push({ tokenID: ++tokenID, massTokenID: null,
      typeID: reward.typeID, quantity: reward.quantity, stationID: 0,
      dateTime: currentFileTime().toString(), expireDateTime: "0", available: true,
      label: `Gallente Election: Day ${day} (${track})`, description: reward.name,
      addedByContext: 0, addedByExtra: null });
  }
  state.lastTokenID = tokenID;
  // Tokens and claim history commit together, including any Omega catch-up.
  const written = store.writeRewardAccount(id, {
    ...account, redeemTokens: tokens, gallenteElectionLogin: state,
  });
  store.resetStoreCaches();
  if (!written.success) throw new Error(`Election login rewards write failed: ${written.errorMsg}`);
  flush();
  if (typeof session.sendNotification === "function") {
    session.sendNotification("OnRedeemingQueueUpdated", "clientID", []);
  }
  return true;
}

module.exports = { catalog, isActive, rewardDate, getActiveCampaign, getClaimHistory, claimReward };
