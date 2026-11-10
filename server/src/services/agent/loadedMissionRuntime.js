"use strict";

// agentMissionRuntime puts its exports here when it loads. The dungeon site service reads them
// to sync a mission record when a mission dungeon's objective completes and to report items it
// grants for a fetch objective, without requiring the mission runtime, so neither side requires
// the other. Mission dungeons are made by the mission runtime, and the server loads it at
// startup. This module requires nothing.

let missionRuntime = null;

function setLoadedMissionRuntime(nextMissionRuntime) {
  if (!nextMissionRuntime || typeof nextMissionRuntime !== "object") {
    throw new TypeError("mission runtime must be the agentMissionRuntime module's exports");
  }
  missionRuntime = nextMissionRuntime;
}

// The mission runtime's exports, or null when it is not loaded in this process.
function getLoadedMissionRuntime() {
  return missionRuntime;
}

module.exports = {
  getLoadedMissionRuntime,
  setLoadedMissionRuntime,
};
