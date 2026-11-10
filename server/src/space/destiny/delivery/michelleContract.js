"use strict";

// The client's Destiny notification: DoDestinyUpdate, addressed by clientID.
// Every Destiny update leaves as one, from doPostTick's batches.
const DESTINY_NOTIFICATION_NAME = "DoDestinyUpdate";
const DESTINY_NOTIFICATION_ID_TYPE = "clientID";

function isSessionOpenForDestinyDelivery(session) {
  if (!session || typeof session.sendNotification !== "function") {
    return false;
  }
  if (
    session.closed === true ||
    session.disconnected === true ||
    session._closed === true
  ) {
    return false;
  }
  if (
    Object.prototype.hasOwnProperty.call(session, "socket") &&
    (!session.socket || session.socket.destroyed === true)
  ) {
    return false;
  }
  return true;
}

module.exports = {
  DESTINY_NOTIFICATION_ID_TYPE,
  DESTINY_NOTIFICATION_NAME,
  isSessionOpenForDestinyDelivery,
};
