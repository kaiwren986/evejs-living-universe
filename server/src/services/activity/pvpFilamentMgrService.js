"use strict";

const path = require("path");

const BaseService = require(path.join(__dirname, "../baseService"));
const log = require(path.join(__dirname, "../../utils/logger"));
const { throwWrappedUserError } = require(path.join(
  __dirname,
  "../../common/machoErrors",
));
const {
  buildDict,
  buildList,
  unwrapMarshalValue,
} = require(path.join(__dirname, "../_shared/serviceHelpers"));
const catalog = require("./pvpEventCatalog");

// Values come from the shipped V24.01 client enum `pvpFilaments.error.PVPJumpError`
// (tools/ClientCodeGrabber/Latest/pvpFilaments/error.py), which the client renders
// through pvpFilaments.get_error_label().
//
// This enum is NOT the same numbering as abyss/error.py: pvpFilaments has no
// ABYSS_CONTENT_ACTIVE, so 1..10 are shifted down by one and 11 is
// INVALID_KEY_AMOUNT rather than SESSION_CHANGE_IN_PROGRESS. Never source a code
// for this service from the abyss table.
const PVP_JUMP_ERROR = require("./pvpJumpErrors");

const CHARACTER_STATISTIC_FIELDS = Object.freeze([
  ["rank", 0],
  ["wins", 0],
  ["losses", 0],
  ["draws", 0],
]);

const auditEvents = [];

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function getCharacterID(session = null) {
  return toInt(
    session &&
      (
        session.characterID ||
        session.charid ||
        session.characterId
      ),
    0,
  );
}

function cloneArgs(args) {
  return Array.isArray(args) ? args.slice() : [];
}

function recordAuditEvent(kind, args = [], session = null) {
  auditEvents.push({
    kind,
    args: cloneArgs(args),
    characterID: getCharacterID(session) || null,
    timestamp: Date.now(),
  });
}

function buildErrorList(errors) {
  return buildList(
    (Array.isArray(errors) ? errors : [])
      .map(([code, args]) => [
        toInt(code, PVP_JUMP_ERROR.UNKNOWN_ERROR),
        Array.isArray(args) ? args : [],
      ]),
  );
}

function throwPvpJumpError(errors) {
  throwWrappedUserError("PVPJumpError", {
    errors: buildErrorList(errors),
  });
}

function getMatchTypeID(args = []) {
  return toInt(args && args.length > 0 ? args[0] : 0, 0);
}

function getScheduleID(args = []) {
  return toInt(args && args.length > 1 ? args[1] : 0, 0);
}

function buildLeaderboardInfo(args = []) {
  return buildDict([
    ["matchTypeID", getMatchTypeID(args)],
    ["scheduleID", getScheduleID(args)],
    ["entries", buildList([])],
  ]);
}

function buildCharacterStatisticsInfo(args = []) {
  return buildDict([
    ["matchTypeID", getMatchTypeID(args)],
    ["scheduleID", getScheduleID(args)],
    ["statistics", buildDict(CHARACTER_STATISTIC_FIELDS)],
  ]);
}

function notify(session, notificationName, payload) {
  if (!session || typeof session.sendNotification !== "function") {
    return;
  }
  session.sendNotification(notificationName, "clientID", [payload]);
}

class PvpFilamentMgrService extends BaseService {
  constructor() {
    super("pvpFilamentMgr");
  }

  Handle_GetAllEvents(args, session) {
    recordAuditEvent("get_all_events", args, session);
    return catalog.buildEventDict(catalog.listAllEvents());
  }

  Handle_GetActiveEvents(args, session) {
    recordAuditEvent("get_active_events", args, session);
    return catalog.buildEventDict(catalog.listActiveEvents());
  }

  Handle_GetMostRecentEvent(args, session) {
    recordAuditEvent("get_most_recent_event", args, session);
    const event = catalog.getMostRecentEvent();
    return event ? catalog.buildEventPayload(event) : null;
  }

  Handle_GetNextEventDate(args, session) {
    recordAuditEvent("get_next_event_date", args, session);
    const nextDate = catalog.getNextEventDate();
    return nextDate ? catalog.buildPythonDate(nextDate) : null;
  }

  Handle_GetLeaderboard(args, session) {
    recordAuditEvent("get_leaderboard", args, session);
    notify(session, "OnPVPFilamentsLeaderboard", buildLeaderboardInfo(args));
    return null;
  }

  Handle_GetCharacterStatistics(args, session) {
    recordAuditEvent("get_character_statistics", args, session);
    notify(
      session,
      "OnPVPFilamentsCharacterStatistics",
      buildCharacterStatisticsInfo(args),
    );
    return null;
  }

  Handle_JoinPVPQueue(args, session) {
    const result = require("./pvpFilamentQueueRuntime").join(
      Number(unwrapMarshalValue(args?.[0])), Number(unwrapMarshalValue(args?.[1])), session,
    );
    recordAuditEvent(result.success ? "join_pvp_queue" : "join_pvp_queue_rejected", args, session);
    if (!result.success) throwPvpJumpError(result.errors);
    return result.estimatedQueueTime;
  }

  Handle_LeavePVPQueue(args, session) {
    recordAuditEvent("leave_pvp_queue", args, session);
    require("./pvpFilamentQueueRuntime").leave(session);
    return null;
  }

  Handle_AbyssalPVPEndGateActivation(args, session) {
    recordAuditEvent("abyssal_pvp_end_gate_activation_rejected", args, session);
    log.debug(
      "[PvpFilamentMgr] AbyssalPVPEndGateActivation rejected: no active Proving Grounds origin trace",
    );
    throwWrappedUserError("DeniedTargetAttemptFailed");
  }
}

PvpFilamentMgrService._testing = {
  constants: {
    PVP_JUMP_ERROR,
  },
  buildCharacterStatisticsInfo,
  buildLeaderboardInfo,
  getAuditEvents() {
    return auditEvents.slice();
  },
  resetForTests() {
    auditEvents.length = 0;
  },
};

module.exports = PvpFilamentMgrService;
