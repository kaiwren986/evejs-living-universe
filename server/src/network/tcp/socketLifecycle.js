"use strict";

const EXPECTED_SOCKET_RESET_ERROR_CODES = new Set([
  "ECONNRESET",
  "EPIPE",
]);
const PLAYER_REQUESTED_DISCONNECT_WINDOW_MS = 5_000;
const PLAYER_REQUESTED_DISCONNECT_TIMESTAMP_KEY =
  "_playerRequestedDisconnectAtMs";

function isExpectedSocketResetError(error) {
  return EXPECTED_SOCKET_RESET_ERROR_CODES.has(
    String(error && error.code || "").toUpperCase(),
  );
}

function isExpectedPreSessionSocketError(error, clientSession) {
  return !clientSession && isExpectedSocketResetError(error);
}

function markPlayerRequestedDisconnect(session, nowMs = Date.now()) {
  const timestamp = Number(nowMs);
  if (!session || !Number.isFinite(timestamp) || timestamp <= 0) {
    return false;
  }
  session[PLAYER_REQUESTED_DISCONNECT_TIMESTAMP_KEY] = timestamp;
  return true;
}

function isExpectedPlayerRequestedDisconnectSocketError(
  error,
  clientSession,
  nowMs = Date.now(),
) {
  if (!clientSession || !isExpectedSocketResetError(error)) {
    return false;
  }

  const requestedAtMs = Number(
    clientSession[PLAYER_REQUESTED_DISCONNECT_TIMESTAMP_KEY],
  );
  const currentTimeMs = Number(nowMs);
  if (
    !Number.isFinite(requestedAtMs) ||
    requestedAtMs <= 0 ||
    !Number.isFinite(currentTimeMs) ||
    currentTimeMs < requestedAtMs
  ) {
    return false;
  }

  return currentTimeMs - requestedAtMs <= PLAYER_REQUESTED_DISCONNECT_WINDOW_MS;
}

function createSocketLifecycle(options = {}) {
  const getSession = typeof options.getSession === "function"
    ? options.getSession
    : () => null;
  const disconnectSession = typeof options.disconnectSession === "function"
    ? options.disconnectSession
    : () => {};
  const unregisterSession = typeof options.unregisterSession === "function"
    ? options.unregisterSession
    : () => {};
  // The bound objects the session was given, let go with its connection
  // (ServiceManager.releaseSessionBoundObjects).
  const releaseBoundObjects = typeof options.releaseBoundObjects === "function"
    ? options.releaseBoundObjects
    : () => {};
  let closed = false;

  return Object.freeze({
    close() {
      if (closed) {
        return false;
      }
      closed = true;
      const session = getSession();
      if (session) {
        disconnectSession(session);
        releaseBoundObjects(session);
        unregisterSession(session);
      }
      return true;
    },
    get closed() {
      return closed;
    },
  });
}

module.exports = {
  createSocketLifecycle,
  isExpectedPlayerRequestedDisconnectSocketError,
  isExpectedPreSessionSocketError,
  markPlayerRequestedDisconnect,
  PLAYER_REQUESTED_DISCONNECT_TIMESTAMP_KEY,
  PLAYER_REQUESTED_DISCONNECT_WINDOW_MS,
};
