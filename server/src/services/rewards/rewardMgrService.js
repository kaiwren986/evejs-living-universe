"use strict";

const path = require("path");

const BaseService = require(path.join(__dirname, "../baseService"));
const log = require(path.join(__dirname, "../../utils/logger"));
const {
  buildDict,
  buildList,
  buildKeyVal,
  buildFiletimeLong,
  extractList,
  normalizeNumber,
} = require(path.join(__dirname, "../_shared/serviceHelpers"));
const { resolveSessionCharacterID } = require("../_shared/sessionIdentity");
const incursionRewards = require("../incursion/incursionRewards");

const MAX_AUDIT_EVENTS = 100;
const auditEvents = [];

function normalizeGroupIDs(args) {
  return extractList(args && args[0])
    .map((value) => normalizeNumber(value, 0))
    .filter((value) => Number.isSafeInteger(value) && value > 0);
}

function recordAuditEvent(kind, session, extra = {}) {
  auditEvents.push({
    kind,
    characterID: resolveSessionCharacterID(session),
    accountID: Number(session && (session.userid || session.userID)) || 0,
    recordedAt: new Date().toISOString(),
    ...extra,
  });
  if (auditEvents.length > MAX_AUDIT_EVENTS) {
    auditEvents.splice(0, auditEvents.length - MAX_AUDIT_EVENTS);
  }
}

class RewardMgrService extends BaseService {
  constructor() {
    super("rewardMgr");
  }

  Handle_GetDelayedRewardsByGroupIDs(args, session) {
    const rewardGroupIDs = normalizeGroupIDs(args);
    const rewards = incursionRewards.getDelayedRewards(resolveSessionCharacterID(session), rewardGroupIDs);
    const entries = Object.entries(rewards);
    recordAuditEvent(entries.length ? "get_delayed_rewards" : "get_delayed_rewards_empty", session, {
      rewardGroupIDs,
    });
    log.debug(
      `[RewardMgr] GetDelayedRewardsByGroupIDs groups=${rewardGroupIDs.length} -> ${entries.length} pools`,
    );
    return buildDict(entries.map(([id, rows]) => [Number(id), buildList(rows.map(row => buildKeyVal(Object.entries(row))))]));
  }

  Handle_GetRewardLPLogs(_args, session) {
    const rows = incursionRewards.getRewardLPLogs(resolveSessionCharacterID(session));
    recordAuditEvent(rows.length ? "get_reward_lp_logs" : "get_reward_lp_logs_empty", session);
    log.debug(`[RewardMgr] GetRewardLPLogs -> ${rows.length} rows`);
    return buildList(rows.map(row => {
      const { dateMs, characterID: _characterID, ...fields } = row;
      return buildKeyVal([...Object.entries(fields).map(([key, value]) => [key,
        key === "dungeonName" ? { type: "wstring", value } : value]),
      ["date", buildFiletimeLong(116444736000000000n + BigInt(dateMs) * 10000n)]]);
    }));
  }
}

RewardMgrService._testing = {
  getAuditEvents() {
    return auditEvents.map((entry) => ({ ...entry }));
  },
  resetForTests() {
    auditEvents.length = 0;
  },
};

module.exports = RewardMgrService;
