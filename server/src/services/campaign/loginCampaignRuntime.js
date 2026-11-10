"use strict";
const database = require("../../gameStore");
const store = require("../newEdenStore/storeState");
const catalog = require("./loginCampaignCatalog");
const { currentFileTime } = require("../_shared/serviceHelpers");
const { getWallclockNowMs, toFileTimeFromMs } = require("../../space/runtime/runtimeClock");
const key = row => `${row.id}:${row.version}`;
function accountID(session) {
  const id = Number(session?.userid || session?.userID || session?.accountID);
  return Number.isSafeInteger(id) && id > 0 ? id : 0;
}
function flush() {
  const result = database.flushTableSync("newEdenStoreRuntime");
  if (!result?.success) throw new Error(result?.errorMsg || "CAMPAIGN_FLUSH_FAILED");
}
function save(id, account) {
  const result = store.writeRewardAccount(id, account);
  if (!result?.success) throw new Error(result?.errorMsg || "CAMPAIGN_WRITE_FAILED");
  flush();
}
function progress(row, account) {
  const stored = account.loginCampaignProgress?.[key(row)];
  if (stored && !row.legacy && stored.fingerprint !== row.fingerprint) throw new Error("CAMPAIGN_CONTENT_CHANGED_INCREMENT_VERSION");
  let state = { day: 0, lastOrdinal: null, history: {}, ...stored };
  if (row.id === 2187) {
    const old = account.dailyLoginCampaign || {};
    state.day = Number(old.day) || 0;
    if (old.lastClaimReset) {
      const ms = Date.parse(`${old.lastClaimReset}T${String(row.turnoverHourUTC).padStart(2, "0")}:00:00Z`);
      if (Number.isFinite(ms)) state.lastOrdinal = catalog.ordinal(ms, row);
    }
  }
  if (row.id === 2356 && account.gallenteElectionLogin?.campaignID === row.id) {
    state.history = { ...account.gallenteElectionLogin.history };
  }
  return state;
}
function authorizedAccountID(session) {
  const id = accountID(session);
  if (!id) return null;
  const characterID = Number(session?.characterID || session?.charid || 0);
  if (characterID) {
    const character = database.read("characters", `/${characterID}`).data;
    if (character && Number(character.accountId) !== id) return null;
  }
  return id;
}
function get(kind, session, nowMs) {
  const id = authorizedAccountID(session);
  if (!id) return null;
  const account = store.readRuntimeAccount(id);
  const row = catalog.select(kind, id, nowMs, account.loginCampaignProgress);
  return row ? { accountID: id, account, row, progress: progress(row, account) } : null;
}
function nextTokenID(account) {
  const id = Math.max(700000000, Number(account.campaignTokenSequence) || 0,
    ...(account.redeemTokens || []).flatMap(token => [Number(token.tokenID) || 0, Number(token.massTokenID) || 0])) + 1;
  if (!Number.isSafeInteger(id) || id > 2147483647) throw new Error("CAMPAIGN_TOKEN_ID_LIMIT");
  account.campaignTokenSequence = id;
  return id;
}
function notify(session) {
  const id = accountID(session);
  const recipients = new Set([session, ...require("../chat/sessionRegistry").getSessions().filter(other => accountID(other) === id)]);
  for (const target of recipients) if (id && typeof target?.sendNotification === "function" && !target.socket?.destroyed) {
    target.sendNotification("OnRedeemingQueueUpdated", "clientID", []);
  }
}
function isExpired(token, nowMs = getWallclockNowMs()) {
  const value = token.expireDateTime;
  const expiry = typeof value === "string" && /^\d+$/.test(value) ? BigInt(value) : 0n;
  return expiry > 0n && expiry <= toFileTimeFromMs(nowMs);
}
function claim(kind, session, nowMs) {
  const model = get(kind, session, nowMs);
  if (!model) return null;
  const { accountID: id, account, row } = model;
  const state = { ...model.progress, history: { ...model.progress.history } };
  const today = catalog.ordinal(nowMs, row), grants = [];
  if (kind === "daily") {
    if (state.lastOrdinal !== null && today <= state.lastOrdinal || !row.repeat && state.day >= row.rewards.length) { flush(); return null; }
    state.day = state.day >= row.rewards.length ? 1 : state.day + 1;
    state.lastOrdinal = today;
    grants.push({ reward: row.rewards[state.day - 1], day: state.day, track: "daily", grantID: `campaign:${id}:${key(row)}:${today}:daily` });
  } else {
    const dates = Object.keys(state.history).map(Number).sort((a, b) => a - b);
    if (dates.length && today < dates.at(-1)) { flush(); return null; }
    const grade = new (require("../subscription/subscriptionMgrService"))().Handle_GetCloneGrade([], { userid: id });
    if (grade === 1) for (const [index, date] of dates.entries()) {
      if (state.history[date] === 0 && (row.retroClaim || date === today) && index < row.days.length) {
        grants.push({ reward: row.days[index].omega, day: index + 1, track: "Omega", grantID: `campaign:${id}:${key(row)}:${index + 1}:Omega` });
        state.history[date] = 1;
      }
    }
    if (!Object.hasOwn(state.history, today) && dates.length < row.days.length) {
      const day = dates.length + 1;
      grants.push({ reward: row.days[day - 1].alpha, day, track: "Alpha", grantID: `campaign:${id}:${key(row)}:${day}:Alpha` });
      if (grade === 1) grants.push({ reward: row.days[day - 1].omega, day, track: "Omega", grantID: `campaign:${id}:${key(row)}:${day}:Omega` });
      state.history[today] = grade === 1 ? 1 : 0;
    }
    if (!grants.length) { flush(); return null; }
  }
  account.redeemTokens ||= [];
  for (const { reward, day, track, grantID } of grants) {
    const tokenID = nextTokenID(account);
    const expiry = row.honorRedeemExpiry && reward.redeemedExpiryDays > 0
      ? nowMs + reward.redeemedExpiryDays * catalog.DAY_MS : 0;
    const campaignGrant = { grantID, campaignID: row.id, version: row.version };
    if (reward.injection) {
      campaignGrant.injection = reward.injection;
      if (reward.injection === "booster") campaignGrant.injectionEndsAtMs = row.boosterInjectionEndsAtMs;
    }
    // A booster token stops being useful when either its redeem window or its
    // injection window closes. The accepted operation keeps its frozen terms.
    const expiryMs = campaignGrant.injectionEndsAtMs ? Math.min(expiry || Infinity, campaignGrant.injectionEndsAtMs) : expiry;
    account.redeemTokens.push({ tokenID, massTokenID: 0, typeID: reward.typeID, quantity: reward.quantity,
      blueprintRuns: reward.blueprintRuns || 0, blueprintMaterialLevel: reward.blueprintMaterialLevel || 0,
      blueprintProductivityLevel: reward.blueprintProductivityLevel || 0,
      stationID: 0, dateTime: (row.honorRedeemExpiry ? toFileTimeFromMs(nowMs) : currentFileTime()).toString(),
      expireDateTime: expiryMs ? toFileTimeFromMs(expiryMs).toString() : "0", available: true,
      soulbound: Boolean(reward.injection),
      label: kind === "daily" ? "Daily Login Reward" : `${row.name || "Gallente Election"}: Day ${day} (${track})`,
      description: reward.name || "Login campaign reward", campaignGrant });
  }
  state.fingerprint = row.fingerprint;
  state.eligibility ||= catalog.eligibility(row, id, nowMs);
  account.loginCampaignProgress ||= {};
  account.loginCampaignProgress[key(row)] = state;
  if (row.id === 2187) account.dailyLoginCampaign = { day: state.day,
    lastClaimReset: new Date(nowMs - row.turnoverHourUTC * 3600000).toISOString().slice(0, 10) };
  if (row.id === 2356) account.gallenteElectionLogin = { ...(account.gallenteElectionLogin || {}),
    campaignID: row.id, history: state.history, lastTokenID: account.campaignTokenSequence };
  // One account write contains progress, token IDs, frozen reward terms and queue.
  save(id, account);
  notify(session);
  return { ...model, account, progress: state, grants };
}
module.exports = { key, accountID, authorizedAccountID, get, claim, progress, flush, save, notify, isExpired };
