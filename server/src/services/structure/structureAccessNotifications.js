"use strict";

const sessionRegistry = require("../chat/sessionRegistry");

// The client invalidates its local docking/bracket cache on this system-wide
// notification. ACL changes affect visiting pilots as well as the owning corp.
function notifyDockingAccessChangedForStructures(structures = []) {
  const solarSystemIDs = new Set(structures
    .map((structure) => Number(structure && structure.solarSystemID) || 0)
    .filter((id) => id > 0));
  if (!solarSystemIDs.size) {
    return 0;
  }
  let deliveredCount = 0;
  for (const session of sessionRegistry.getSessions()) {
    const systemID = Number(session.solarsystemid2 || session.solarsystemid) || 0;
    if (!solarSystemIDs.has(systemID) || typeof session.sendNotification !== "function") {
      continue;
    }
    session.sendNotification("OnDockingAccessChangedForCurrentSolarSystem", "*solarsystemid", []);
    deliveredCount += 1;
  }
  return deliveredCount;
}

module.exports = { notifyDockingAccessChangedForStructures };
