"use strict";

// A login closes its account's other client sessions, as CCP's shared session
// code has it: sessionMgr.CloseUserSessions(userIDs, reason, clientID) closes
// every session of the user but the given client's
// (carbon/common/script/sys/sessions.py 764). The transport goes as
// machoNet.DisconnectUsers closes a user's (carbon/common/script/net/machoNet.py
// 2513): a GPSTransportClosed with the code CLIENTDISCONNECTED. The client reads
// that packet mid-session as at the handshake (machoNetTransport.py 418-421),
// passes the code to OnDisconnect (machoNetTransport.Close), and shows its own
// words for the code in the connection-lost notice (disconnectNotice.py,
// ExceptionMappingGPCS.MESSAGES). Neither the client's code nor a recording says
// which close Tranquility sends a client whose account logs in again; this is
// the one close CCP's code makes of all of a user's transports.

const path = require("path");
const log = require(path.join(__dirname, "../../utils/logger"));
const { marshalEncode } = require(path.join(__dirname, "./utils/marshal"));
const { buildGPSTransportClosedPayload } = require(path.join(__dirname, "./handshake"));
const sessionRegistry = require(path.join(
  __dirname,
  "../../services/chat/sessionRegistry",
));

const ACCOUNT_LOGIN_CLOSE_CODE = "CLIENTDISCONNECTED";
// The close's own text (GPSTransportClosed.reason, CloseUserSessions' reason):
// in the session's history and this server's log, never shown by the client.
const ACCOUNT_LOGIN_CLOSE_REASON = "Another client logged in to this account";
// A client that does not close its end after the notice is cut off.
const ACCOUNT_LOGIN_CLOSE_GRACE_MS = 5000;

function closeSessionTransport(session, reason) {
  const socket = session.socket;
  const cutOff = () => {
    if (socket && !socket.destroyed) {
      socket.destroy();
    }
  };
  const end = () => {
    if (socket && !socket.destroyed) {
      socket.end();
      const timer = setTimeout(cutOff, ACCOUNT_LOGIN_CLOSE_GRACE_MS);
      if (typeof timer.unref === "function") {
        timer.unref();
      }
    }
  };
  try {
    const sent = session.sendRawPayload(
      marshalEncode(
        buildGPSTransportClosedPayload(ACCOUNT_LOGIN_CLOSE_CODE, {}, reason),
      ),
      { label: "transport-closed" },
    );
    Promise.resolve(sent).then(end, end);
  } catch (error) {
    log.warn(
      `[Login] Could not send the close to client=${session.clientID || 0}: ${error.message}`,
    );
    cutOff();
  }
}

function closeOtherSessionsOfUser(newSession, reason = ACCOUNT_LOGIN_CLOSE_REASON) {
  const userID = Number(newSession && newSession.userid) || 0;
  if (userID <= 0) {
    return 0;
  }
  let closed = 0;
  for (const other of sessionRegistry.getSessions()) {
    if (
      other === newSession ||
      (Number(other.userid) || 0) !== userID ||
      (newSession.clientID && other.clientID === newSession.clientID)
    ) {
      continue;
    }
    log.info(
      `[Login] ${reason}: closing user=${other.userName || userID}(${userID}) ` +
        `client=${other.clientID || 0} char=${other.characterID || 0}; ` +
        `the new client is ${newSession.clientID || 0}`,
    );
    closeSessionTransport(other, reason);
    closed += 1;
  }
  return closed;
}

module.exports = {
  ACCOUNT_LOGIN_CLOSE_CODE,
  ACCOUNT_LOGIN_CLOSE_REASON,
  closeOtherSessionsOfUser,
};
