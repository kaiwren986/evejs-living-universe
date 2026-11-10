"use strict";

const path = require("node:path");

function getCrimewatchState() {
  return require(path.join(__dirname, "../security/crimewatchState"));
}

function getSessionRegistry() {
  return require(path.join(__dirname, "../chat/sessionRegistry"));
}

function getKillRightNotifications() {
  return require(path.join(__dirname, "./killRightNotifications"));
}

function uniqueSessionsForCharacters(characterIDs = [], currentSession = null) {
  const sessions = [];
  const seen = new Set();
  const addSession = (session) => {
    if (!session || typeof session.sendNotification !== "function" || seen.has(session)) {
      return;
    }
    seen.add(session);
    sessions.push(session);
  };

  addSession(currentSession);
  const sessionRegistry = getSessionRegistry();
  for (const characterID of characterIDs) {
    addSession(sessionRegistry.findSessionByCharacterID(characterID));
  }
  return sessions;
}

function applyKillRightSuspectTimer(
  killRight,
  session = null,
  nowMs = Date.now(),
  durationMs = 15 * 60 * 1000,
) {
  const targetCharacterID = Number(killRight && killRight.toID) || 0;
  if (targetCharacterID <= 0) {
    return null;
  }
  const crimewatchState = getCrimewatchState();
  const sessionRegistry = getSessionRegistry();
  const result = crimewatchState.setCharacterCrimewatchDebugState(
    targetCharacterID,
    {
      suspect: true,
      criminalTimerMs: durationMs,
    },
    {
      now: nowMs,
      systemID: session && (session.solarsystemid || session.solarSystemID),
    },
  );
  const targetSession = sessionRegistry.findSessionByCharacterID(targetCharacterID);
  if (
    targetSession &&
    typeof crimewatchState.synchronizeSessionTimerNotifications === "function"
  ) {
    crimewatchState.synchronizeSessionTimerNotifications(null, targetSession, nowMs);
  }
  return result;
}

function notifyKillRightActivated(
  killRight,
  activatorID,
  session = null,
  options = {},
) {
  for (const targetSession of uniqueSessionsForCharacters(
    [activatorID, killRight && killRight.fromID, killRight && killRight.toID],
    session,
  )) {
    if (
      Number(targetSession.characterID || targetSession.charid || 0) ===
      Number(activatorID || 0)
    ) {
      targetSession.sendNotification("OnKillRightActivated", "clientID", []);
    }
  }

  const ownerID = Number(killRight && killRight.fromID) || 0;
  const targetID = Number(killRight && killRight.toID) || 0;
  if (ownerID > 0 && Number(activatorID) !== ownerID) {
    getKillRightNotifications().notifyKillRightUsed({
      ownerID,
      targetID,
      idempotencyKey: options.idempotencyKey,
    });
  }
}

function publishPurchasedKillRight(data, options = {}) {
  if (!data || !data.killRight || !data.activation) {
    return false;
  }
  const activatorID = Number(data.activation.activatorID) || 0;
  const activatedAtMs = typeof options.filetimeToMs === "function"
    ? options.filetimeToMs(data.activation.activatedAt, Date.now())
    : Date.now();
  applyKillRightSuspectTimer(
    data.killRight,
    options.session || null,
    activatedAtMs,
    options.durationMs,
  );
  notifyKillRightActivated(
    data.killRight,
    activatorID,
    options.session || null,
    {
      idempotencyKey: data.purchase &&
        `kill-right-purchase:${data.purchase.purchaseID}:used-notification`,
    },
  );
  return true;
}

module.exports = {
  applyKillRightSuspectTimer,
  notifyKillRightActivated,
  publishPurchasedKillRight,
};
