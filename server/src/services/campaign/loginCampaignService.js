"use strict";

// All native campaign reads and claims project the same account-owned state.
const BaseService = require("../baseService");
const log = require("../../utils/logger");
const campaignRuntime = require("./loginCampaignRuntime");
const campaignPayloads = require("./loginCampaignPayloads");
const { getWallclockNowMs } = require("../../space/runtime/runtimeClock");
const { buildDict } = require("../_shared/serviceHelpers");
const MAX_AUDIT_EVENTS = 100;
const auditEvents = [];
let nowForTests = null;
function now() { return nowForTests ? new Date(nowForTests) : new Date(getWallclockNowMs()); }
function stamp(model) { return model ? campaignRuntime.key(model.row) : null; }
function remember(session, model) { if (session) session._loginCampaignEnrollment = stamp(model); return model; }
function safeClone(value) {
  try {
    return value === undefined ? null : JSON.parse(JSON.stringify(value));
  } catch (error) {
    // ignored: a value JSON cannot copy is cloned as null
    return null;
  }
}

function recordCampaignAuditEvent(kind, args, session) {
  auditEvents.push({
    kind,
    args: safeClone(args),
    characterID: Number(session && (session.characterID || session.charid)) || 0,
    accountID: Number(session && (session.userid || session.userID)) || 0,
    recordedAt: new Date().toISOString(),
  });
  if (auditEvents.length > MAX_AUDIT_EVENTS) {
    auditEvents.splice(0, auditEvents.length - MAX_AUDIT_EVENTS);
  }
}

const testing = {
  getAuditEvents() {
    return auditEvents.map((entry) => ({ ...entry }));
  },
  resetForTests() {
    auditEvents.length = 0;
    nowForTests = null;
  },
  setNowForTests(value) {
    nowForTests = value ? new Date(value) : null;
  },
};

class LoginCampaignMgrService extends BaseService {
  constructor() {
    super("loginCampaignManager");
  }

  Handle_get_client_campaign_state(args, session) {
    const nowMs = now().getTime();
    return campaignPayloads.dailyState(remember(session, campaignRuntime.get("daily", session, nowMs)), nowMs);
  }

  Handle_claim_reward(args, session) {
    const nowMs = now().getTime(), selected = campaignRuntime.get("daily", session, nowMs);
    if (session && session._loginCampaignEnrollment !== undefined && session._loginCampaignEnrollment !== stamp(selected)) {
      // The stock claim RPC has no campaign ID. Refuse the stale UI's claim
      // instead of silently granting a different track's reward.
      remember(session, selected);
      if (typeof session.sendNotification === "function") session.sendNotification("OnCampaignEnrollmentChanged", "clientID", []);
      return null;
    }
    const result = campaignRuntime.claim("daily", session, nowMs);
    if (result) remember(session, result);
    recordCampaignAuditEvent(result ? "login_campaign_claim_reward" : "login_campaign_claim_reward_rejected", args, session);
    return campaignPayloads.dailyClaim(result, nowMs);
  }
}

class SeasonalLoginCampaignMgrService extends BaseService {
  constructor() {
    super("seasonalLoginCampaignManager");
  }

  Handle_get_active_campaign(args, session) {
    log.debug("[SeasonalLoginCampaignMgr] get_active_campaign");
    const selected = campaignRuntime.get("seasonal", session, now().getTime());
    if (session) session._seasonalLoginCampaignEnrollment = stamp(selected);
    return campaignPayloads.seasonalTuple(selected);
  }

  Handle_claim_reward(args, session) {
    const nowMs = now().getTime(), selected = campaignRuntime.get("seasonal", session, nowMs);
    const enrollment = session?._seasonalLoginCampaignEnrollment;
    if (selected && (enrollment === undefined || enrollment === stamp(selected))) {
      const result = Boolean(campaignRuntime.claim("seasonal", session, nowMs));
      const event = selected.row.id === 2356 ? "election_login" : "seasonal_login";
      recordCampaignAuditEvent(result ? `${event}_claim_reward` : `${event}_claim_rejected`, args, session);
      return result;
    }
    recordCampaignAuditEvent("seasonal_login_claim_reward_no_active_campaign", args, session);
    log.info("[SeasonalLoginCampaignMgr] claim_reward -> false");
    return false;
  }

  Handle_get_claim_history(args, session) {
    const active = campaignRuntime.get("seasonal", session, now().getTime());
    if (active) return buildDict(Object.entries(active.progress.history).map(([date, grade]) => [Number(date), grade]));
    recordCampaignAuditEvent("seasonal_login_get_claim_history_empty", args, session);
    log.debug("[SeasonalLoginCampaignMgr] get_claim_history -> empty dict");
    return buildDict([]);
  }
}

LoginCampaignMgrService._testing = testing;
SeasonalLoginCampaignMgrService._testing = testing;

module.exports = { LoginCampaignMgrService, SeasonalLoginCampaignMgrService };
