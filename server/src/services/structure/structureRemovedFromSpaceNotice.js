"use strict";

/**
 * OnStructureRemovedFromSpace(structureID), sent when a structure leaves space
 * (destroyed, unanchored, or removed).
 *
 * The client's only handler is structureDirectory.py:171, which drops the
 * structure from `knownStructures`, a cache of structure info kept for up to
 * an hour (structureDirectory.py:29) and read by contract-location checks,
 * bookmarks and tooltips anywhere in the universe. So every connected client
 * with a character is told, not just the owner corporation or the
 * structure's system.
 *
 * No retail capture of this event exists. It goes out once per session with
 * idtype clientID, as the other structure fan-outs that walk sessions do
 * (space/runtime/structureLifecycleFanout.js).
 */

const path = require("path");

function toPositiveInt(value) {
  const numeric = Math.trunc(Number(value));
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
}

/**
 * @param {number[]} structureIDs
 * @param {object} [options]
 * @param {object[]} [options.sessions] sessions to tell (defaults to all)
 * @returns {number} notifications sent
 */
function notifyStructuresRemovedFromSpace(structureIDs = [], options = {}) {
  const ids = [...new Set((Array.isArray(structureIDs) ? structureIDs : [])
    .map(toPositiveInt)
    .filter(Boolean))];
  if (ids.length === 0) {
    return 0;
  }
  const sessions = Array.isArray(options.sessions)
    ? options.sessions
    : require(path.join(__dirname, "../chat/sessionRegistry")).getSessions();
  let sent = 0;
  for (const session of sessions) {
    if (
      !session ||
      typeof session.sendNotification !== "function" ||
      !toPositiveInt(session.characterID || session.charid)
    ) {
      continue;
    }
    for (const structureID of ids) {
      session.sendNotification("OnStructureRemovedFromSpace", "clientID", [structureID]);
      sent += 1;
    }
  }
  return sent;
}

module.exports = {
  notifyStructuresRemovedFromSpace,
};
