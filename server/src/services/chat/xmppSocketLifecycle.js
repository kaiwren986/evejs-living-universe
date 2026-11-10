"use strict";

const {
  isExpectedPlayerRequestedDisconnectSocketError,
  PLAYER_REQUESTED_DISCONNECT_TIMESTAMP_KEY,
} = require("../../network/tcp/socketLifecycle");

function inheritPlayerRequestedDisconnectMarker(session, client) {
  if (!session || !client) {
    return false;
  }

  const requestedAtMs = Number(
    session[PLAYER_REQUESTED_DISCONNECT_TIMESTAMP_KEY],
  );
  if (!Number.isFinite(requestedAtMs) || requestedAtMs <= 0) {
    return false;
  }

  client[PLAYER_REQUESTED_DISCONNECT_TIMESTAMP_KEY] = requestedAtMs;
  return true;
}

function isExpectedXmppClientSocketError(error, client, nowMs = Date.now()) {
  return isExpectedPlayerRequestedDisconnectSocketError(error, client, nowMs);
}

module.exports = {
  inheritPlayerRequestedDisconnectMarker,
  isExpectedXmppClientSocketError,
};
