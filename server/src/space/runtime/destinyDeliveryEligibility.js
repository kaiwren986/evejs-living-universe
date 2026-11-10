"use strict";

// A leaf with no requires, loaded before the exports below so they can name it.
const {
  sessionMatchesIdentity,
} = require("./sessionIdentity");

module.exports = {
  canSessionReceiveEntityDependentDestinyUpdate,
  getPayloadPrimaryEntityID,
  isAwaitingUndockEntry,
  isAwaitingUndockSetState,
  isReadyForDestiny,
  sessionMatchesIdentity,
};

const runtimeEntryDirname = require("path").resolve(__dirname, "..");
const path = require("path");
const {
  entityIDsEqual,
  getEntityMapKey,
  normalizeEntityID,
  normalizeEntityIDSet,
  normalizeNonNegativeInt64,
  normalizePersistentEntityID,
  toJSONSafeEntityID,
} = require(path.join(runtimeEntryDirname, "./destiny/identity/entityID.js"));
const {
  toInt,
} = require("../../common/numbers");

const DESTINY_CRITICAL_PAYLOAD_NAMES = new Set([
  "GotoDirection", "GotoPoint", "AddBalls2", "RemoveBalls",
  "LaunchMissile",
  "Orbit", "FollowBall", "Stop", "WarpTo",
  "SetBallAgility", "SetBallMass", "SetMaxSpeed", "SetBallMassive",
  "SetSpeedFraction", "SetBallPosition", "SetBallVelocity",
]);

function isReadyForDestiny(session) {
  return Boolean(
    session &&
      session._space &&
      session._space.initialStateSent &&
      session.socket &&
      !session.socket.destroyed,
  );
}

// An undocking pilot waiting for its SetState (scene beginUndockEntry): an
// Observer of its Grid bubble already, as on TQ.
function isAwaitingUndockSetState(session) {
  return Boolean(
    session &&
      session._space &&
      session._space.undockEntry &&
      !session._space.initialStateSent &&
      session.socket &&
      !session.socket.destroyed,
  );
}

// One whose first bubble update has not run yet.
function isAwaitingUndockEntry(session) {
  return isAwaitingUndockSetState(session) &&
    session._space.undockEntry.entryStamp === null;
}

// Whether a session's client has the Ball an update depends on: Grid bubble
// membership as its client knows it (scene/visibility.js).
function canSessionReceiveEntityDependentDestinyUpdate(scene, session, entity) {
  if (!scene || !session || !session._space || !entity) {
    return false;
  }
  if (entity.session && sessionMatchesIdentity(session, entity.session)) {
    return true;
  }
  return typeof scene.canSessionSeeDynamicEntity === "function" &&
    scene.canSessionSeeDynamicEntity(session, entity) === true;
}

function getPayloadPrimaryEntityID(payload) {
  if (!Array.isArray(payload) || payload.length < 2) {
    return 0;
  }
  const [name, args] = payload;
  switch (name) {
    case "GotoDirection":
    case "GotoPoint":
    case "SetBallVelocity":
    case "SetBallPosition":
    case "SetSpeedFraction":
    case "LaunchMissile":
    case "FollowBall":
    case "Orbit":
    case "Stop":
    case "WarpTo":
    case "EntityWarpIn":
    case "OnSpecialFX":
    case "OnDbuffUpdated":
    case "CloakBall":
    case "UncloakBall":
    case "SetBallMassive":
    case "SetMaxSpeed":
    case "SetBallMass":
    case "SetBallAgility":
      return toInt(args && args[0], 0);
    default:
      return 0;
  }
}

Object.assign(module.exports, {
  DESTINY_CRITICAL_PAYLOAD_NAMES,
});
