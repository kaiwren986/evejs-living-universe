"use strict";

/**
 * What a session is told of tales without asking.
 *
 * Tranquility sends a session the tales of the solar system it has come to:
 * OnTaleData(solarSystemID, {taleID: KeyVal}) addressed by charid, a few
 * packets after each session change of solarsystemid2 (a login, a jump). A
 * system with no tales is followed by no notice.
 */

const path = require("path");
const {
  buildObservedTalesDict,
  getObservedTaleIDsForSolarSystem,
} = require(path.join(__dirname, "./observedTaleData"));

/**
 * To be called by a session when it has sent a session change, with the
 * changes it sent ({attribute: [old, new]}).
 */
function sendTaleDataAfterSessionChange(session, changes) {
  const solarSystemID = Number(changes.solarsystemid2 && changes.solarsystemid2[1]) || 0;
  if (getObservedTaleIDsForSolarSystem(solarSystemID).length === 0) {
    return;
  }
  session.sendNotification("OnTaleData", "charid", [
    solarSystemID,
    buildObservedTalesDict(solarSystemID),
  ]);
}

module.exports = {
  sendTaleDataAfterSessionChange,
};
