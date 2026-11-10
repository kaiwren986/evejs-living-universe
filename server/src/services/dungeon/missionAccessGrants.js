"use strict";

const path = require("path");

const log = require(path.join(__dirname, "../../utils/logger"));
const {
  normalizeNumber,
} = require(path.join(__dirname, "../_shared/serviceHelpers"));
const dungeonRuntime = require(path.join(__dirname, "./dungeonRuntime"));
const {
  canSessionAccessDungeonInstance,
  isPrivateDungeonInstance,
  normalizeDungeonInstanceID,
} = require(path.join(__dirname, "./dungeonVisibilityPolicy"));

// Record a pilot who has acquired a route into a private mission pocket (see
// dungeonRuntime.grantCharacterMissionAccess). True when the pilot may enter
// the instance afterwards, or when there is no private instance to enter.
function grantAcquiredMissionAccess(session, instanceID, source) {
  const numericInstanceID = normalizeDungeonInstanceID(instanceID);
  if (numericInstanceID === null) {
    return true;
  }
  try {
    const instance = dungeonRuntime.getInstance(numericInstanceID);
    if (!instance || !isPrivateDungeonInstance(instance)) {
      return Boolean(instance);
    }
    if (canSessionAccessDungeonInstance(session, instance)) {
      return true;
    }
    const characterID = normalizeNumber(
      session && (session.characterID || session.charID || session.charid),
      0,
    );
    const updated = dungeonRuntime.grantCharacterMissionAccess(
      numericInstanceID,
      characterID,
      { source },
    );
    return canSessionAccessDungeonInstance(session, updated);
  } catch (error) {
    log.warn(
      `[MissionAccess] Failed to grant acquired mission access char=${normalizeNumber(
        session && session.characterID,
        0,
      )} instance=${numericInstanceID} source=${source}: ${error.message}`,
    );
    return false;
  }
}

module.exports = {
  grantAcquiredMissionAccess,
};
