"use strict";

const path = require("node:path");

const killmailState = require(path.join(__dirname, "./killmailState"));
const notificationState = require(path.join(
  __dirname,
  "../notifications/notificationState",
));
const notificationConstants = require(path.join(
  __dirname,
  "../notifications/notificationConstants",
));
const sessionRegistry = require(path.join(
  __dirname,
  "../chat/sessionRegistry",
));
const {
  isOwnerKillLogVictim,
} = require(path.join(__dirname, "./killmailPreparationTasks"));

const CONCORD_CORPORATION_ID = 1000125;

function toPositiveInt(value, fallback = null) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0
    ? Math.trunc(numeric)
    : fallback;
}

function isLiveNotificationSession(session) {
  return Boolean(
    session &&
      typeof session.sendNotification === "function" &&
      (!session.socket || !session.socket.destroyed),
  );
}

function resolveKillmailNotificationSessions(characterID, extraSessions = []) {
  const targetCharacterID = toPositiveInt(characterID, 0) || 0;
  if (targetCharacterID <= 0) {
    return [];
  }

  const sessions = [];
  const seen = new Set();
  const addSession = (session) => {
    if (!isLiveNotificationSession(session) || seen.has(session)) {
      return;
    }
    const sessionCharacterID = toPositiveInt(
      session.characterID || session.charID || session.charid,
      0,
    ) || 0;
    if (sessionCharacterID !== targetCharacterID) {
      return;
    }
    seen.add(session);
    sessions.push(session);
  };

  if (sessionRegistry && typeof sessionRegistry.getSessions === "function") {
    for (const session of sessionRegistry.getSessions()) {
      addSession(session);
    }
  }
  for (const session of Array.isArray(extraSessions) ? extraSessions : []) {
    addSession(session);
  }
  return sessions;
}

function buildKillReportNotificationData(record, options = {}) {
  return {
    killMailHash: killmailState.getKillmailHashValue(record),
    killMailID: toPositiveInt(record && record.killID, 0) || 0,
    victimShipTypeID:
      toPositiveInt(record && record.victimShipTypeID, 0) ||
      toPositiveInt(options.victimShipTypeID, 0) ||
      null,
  };
}

function notifyVictimKillmailAvailable(record, options = {}) {
  const victimCharacterID = toPositiveInt(
    options.victimCharacterID ?? (record && record.victimCharacterID),
    0,
  ) || 0;
  const killID = toPositiveInt(record && record.killID, 0) || 0;
  if (victimCharacterID <= 0 || killID <= 0) {
    return null;
  }

  const extraSessions = Array.isArray(options.extraSessions)
    ? options.extraSessions.filter(Boolean)
    : [];
  const notificationResult = notificationState.createNotification(
    victimCharacterID,
    {
      typeID: notificationConstants.NOTIFICATION_TYPE.KILL_REPORT_AVAILABLE,
      senderID: CONCORD_CORPORATION_ID,
      groupID: notificationConstants.NOTIFICATION_GROUP.WAR,
      processed: false,
      created: record.killTime,
      idempotencyKey: `killmail:${killID}`,
      data: buildKillReportNotificationData(record, options),
      extraSessions,
    },
  );
  if (!notificationResult || notificationResult.success !== true) {
    return notificationResult || null;
  }

  const sessions = resolveKillmailNotificationSessions(
    victimCharacterID,
    extraSessions,
  );
  for (const session of sessions) {
    session.sendNotification("OnKillNotification", "charid", []);
    session.sendNotification("OnShipDeath", "charid", []);
  }
  return {
    ...notificationResult,
    sentSessionCount: sessions.length,
  };
}

// The killer's half of a kill report. TQ sends the victim a KillReportVictim
// (140) and whoever landed the final blow a KillReportFinalBlow (141) off the
// same killmail, which is how a kill reaches the killer's own kill log rather
// than only the victim's loss log. Only fires for kills that belong in a kill
// log at all — see isOwnerKillLogVictim — so shooting a rat does not mail the
// shooter, and never fires when the killer is the victim (self-destruct or a
// pod popped by its own pilot's ship).
function notifyFinalBlowKillmailAvailable(record, options = {}) {
  const finalCharacterID = toPositiveInt(
    options.finalCharacterID ?? (record && record.finalCharacterID),
    0,
  ) || 0;
  const victimCharacterID = toPositiveInt(
    options.victimCharacterID ?? (record && record.victimCharacterID),
    0,
  ) || 0;
  const killID = toPositiveInt(record && record.killID, 0) || 0;
  if (finalCharacterID <= 0 || killID <= 0) {
    return null;
  }
  if (finalCharacterID === victimCharacterID) {
    return null;
  }
  if (!isOwnerKillLogVictim(record)) {
    return null;
  }
  // The client names the victim from victimID. With no pilot aboard (a
  // player structure) TQ sends None, and the client names the victim's type
  // instead (KillMailFinalBlowFormatter.Format).
  const victimID = victimCharacterID || null;

  const extraSessions = Array.isArray(options.extraSessions)
    ? options.extraSessions.filter(Boolean)
    : [];
  const notificationResult = notificationState.createNotification(
    finalCharacterID,
    {
      typeID: notificationConstants.NOTIFICATION_TYPE.KILL_REPORT_FINAL_BLOW,
      senderID: CONCORD_CORPORATION_ID,
      groupID: notificationConstants.NOTIFICATION_GROUP.WAR,
      processed: false,
      created: record.killTime,
      idempotencyKey: `killmail:finalblow:${killID}`,
      data: {
        ...buildKillReportNotificationData(record, options),
        victimID,
      },
      extraSessions,
    },
  );
  if (!notificationResult || notificationResult.success !== true) {
    return notificationResult || null;
  }

  const sessions = resolveKillmailNotificationSessions(
    finalCharacterID,
    extraSessions,
  );
  for (const session of sessions) {
    session.sendNotification("OnKillNotification", "charid", []);
  }
  return {
    ...notificationResult,
    sentSessionCount: sessions.length,
  };
}

module.exports = {
  notifyVictimKillmailAvailable,
  notifyFinalBlowKillmailAvailable,
  resolveKillmailNotificationSessions,
};
