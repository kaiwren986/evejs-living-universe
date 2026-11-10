"use strict";

// Where the caller of a chat command is: whether their ship is in space, their docked station,
// their solar system, their ship's space entity, and whether they are in Abyssal Deadspace.

const path = require("path");

const worldData = require("../../../space/worldData");
const spaceRuntime = require("../../../space/runtime");
const {
  isDockedSession,
  getDockedLocationID,
} = require(path.join(__dirname, "../../structure/structureLocation"));
const {
  isAbyssalHostLocationID,
} = require("../../../abyssal").engineSupport.hostLocation;
const {
  normalizePositiveInteger,
} = require(path.join(__dirname, "./commandArguments"));

function isSpaceSessionReady(session) {
  return Boolean(
    session &&
    session.characterID &&
    session._space &&
    !isDockedSession(session),
  );
}

function resolveSessionSolarSystemID(session) {
  return normalizePositiveInteger(
    session &&
      (
        (session._space && session._space.systemID) ||
        session.solarsystemid2 ||
        session.solarsystemid
      ),
    0,
  );
}

function resolveSessionShipEntity(session) {
  if (!session || !session._space || !session._space.shipID) {
    return null;
  }

  return spaceRuntime.getEntity(session, session._space.shipID) || null;
}

function getSessionDockedStationID(session) {
  return normalizePositiveInteger(getDockedLocationID(session));
}

function getSessionCurrentSolarSystemID(session) {
  const dockedStationID = getSessionDockedStationID(session);
  if (dockedStationID) {
    const station =
      worldData.getStationByID(dockedStationID) ||
      worldData.getStructureByID(dockedStationID);
    return normalizePositiveInteger(station && station.solarSystemID);
  }

  return normalizePositiveInteger(
    session &&
      (
        session.solarsystemid2 ||
        session.solarsystemid ||
        (session._space && session._space.systemID) ||
        0
      ),
  );
}

function isConnectedSessionInAbyssalDeadspace(session) {
  const sceneKind = String(
    session && session._space && session._space.sceneKind || "",
  ).trim();
  const sceneKey = String(
    session && session._space && session._space.sceneKey ||
      session && session.spaceSceneKey ||
      "",
  ).trim();
  const systemID = getSessionCurrentSolarSystemID(session);
  return Boolean(
    sceneKind === "abyssal" ||
    /^abyssal-run:\d+$/.test(sceneKey) ||
    isAbyssalHostLocationID(systemID)
  );
}

module.exports = {
  isSpaceSessionReady,
  resolveSessionSolarSystemID,
  resolveSessionShipEntity,
  getSessionDockedStationID,
  getSessionCurrentSolarSystemID,
  isConnectedSessionInAbyssalDeadspace,
};
