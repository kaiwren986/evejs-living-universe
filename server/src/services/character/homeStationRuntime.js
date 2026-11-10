"use strict";

const path = require("path");

const log = require(path.join(__dirname, "../../utils/logger"));
const worldData = require(path.join(__dirname, "../../space/worldData"));
const {
  getStationRecord,
} = require(path.join(__dirname, "../_shared/stationStaticData"));
const {
  getCorporationRecord,
} = require(path.join(__dirname, "../corporation/corporationState"));
const {
  getCharacterRecord,
  listCharacterIDs,
  peekCharacterRecord,
  updateCharacterRecord,
} = require(path.join(__dirname, "./characterState"));
const {
  resolveCharacterCreationSchoolProfile,
} = require(path.join(__dirname, "./characterCreationData"));
const sessionRegistry = require(path.join(__dirname, "../chat/sessionRegistry"));

const DEFAULT_HOME_STATION_ID = 60003760;
// Wormhole space: J-space, Thera and the other special wormhole systems.
const WORMHOLE_SOLAR_SYSTEM_ID_MIN = 31000000;
const WORMHOLE_SOLAR_SYSTEM_ID_MAX = 31999999;
// Thera has NPC stations and counts as known space for home stations.
const THERA_SOLAR_SYSTEM_ID = 31000005;

// The school's station is the home a character can always go back to: it can
// be picked remotely at any time, and retail falls back to it when a home is
// no longer available.
function resolveSchoolHQStationID(charData = {}, session = null) {
  const schoolID = Number(
    charData.schoolID ||
      (session && (session.schoolID || session.schoolid)) ||
      0,
  ) || 0;
  const schoolProfile = resolveCharacterCreationSchoolProfile(schoolID, {
    raceID: charData.raceID || (session && (session.raceID || session.raceid)),
    corporationID: charData.corporationID,
  });
  const startingStationID = Number(
    schoolProfile.startingStations && schoolProfile.startingStations[0],
  ) || 0;
  if (startingStationID && getStationRecord(session, startingStationID)) {
    return startingStationID;
  }
  const schoolCorporationID = Number(schoolProfile.corporationID) || 0;
  if (!schoolCorporationID) {
    return 0;
  }
  const schoolCorporation = getCorporationRecord(schoolCorporationID);
  return Number(schoolCorporation && schoolCorporation.stationID || 0) || 0;
}

// Retail refuses a home station in wormhole space, except in Thera
// (ChangeHomeStationValidationError.STATION_IN_WORMHOLE).
function isWormholeHomeStationSystem(solarSystemID) {
  const numericSolarSystemID = Number(solarSystemID) || 0;
  return (
    numericSolarSystemID >= WORMHOLE_SOLAR_SYSTEM_ID_MIN &&
    numericSolarSystemID <= WORMHOLE_SOLAR_SYSTEM_ID_MAX &&
    numericSolarSystemID !== THERA_SOLAR_SYSTEM_ID
  );
}

// A home is lost when its ID names neither an NPC station nor a structure that
// still stands. A destroyed structure keeps its row, marked with destroyedAt.
function isHomeStationLost(stationID) {
  const numericStationID = Number(stationID) || 0;
  if (!numericStationID || worldData.getStationByID(numericStationID)) {
    return false;
  }
  const structure = worldData.getStructureByID(numericStationID);
  return !structure || Boolean(structure.destroyedAt);
}

// Move every home station held by a structure that is going away to that
// character's school station, and tell a live client, which reloads its home
// station on OnHomeStationMovedFromStructure.
function moveHomeStationsOutOfStructure(structureID) {
  const locationID = Number(structureID) || 0;
  if (!locationID) {
    return {
      success: false,
      errorMsg: "STRUCTURE_REQUIRED",
      movedCharacterIDs: [],
    };
  }

  const movedCharacterIDs = [];
  const failedCharacterIDs = [];
  for (const charID of listCharacterIDs()) {
    // A raw read first, so only the characters who live here get rewritten.
    const storedRecord = peekCharacterRecord(charID);
    if (
      !storedRecord ||
      (
        Number(storedRecord.homeStationID) !== locationID &&
        Number(storedRecord.cloneStationID) !== locationID
      )
    ) {
      continue;
    }

    const schoolStationID =
      resolveSchoolHQStationID(getCharacterRecord(charID) || storedRecord) ||
      DEFAULT_HOME_STATION_ID;
    const result = updateCharacterRecord(charID, (record) => ({
      ...record,
      homeStationID:
        Number(record.homeStationID) === locationID ? schoolStationID : record.homeStationID,
      cloneStationID:
        Number(record.cloneStationID) === locationID ? schoolStationID : record.cloneStationID,
    }));
    if (!result || result.success !== true) {
      failedCharacterIDs.push(charID);
      log.warn(
        `[HomeStationRuntime] Failed to move home station char=${charID} structure=${locationID} error=${(result && result.errorMsg) || "UNKNOWN"}`,
      );
      continue;
    }
    movedCharacterIDs.push(charID);

    const session = sessionRegistry.findSessionByCharacterID(charID);
    if (session) {
      session.homeStationID = schoolStationID;
      session.homestationid = schoolStationID;
      session.cloneStationID = schoolStationID;
      session.clonestationid = schoolStationID;
      if (typeof session.sendNotification === "function") {
        session.sendNotification("OnHomeStationMovedFromStructure", "charid", []);
      }
    }
  }

  return {
    success: failedCharacterIDs.length === 0,
    errorMsg: failedCharacterIDs.length > 0 ? "HOME_STATION_MOVE_PARTIAL_FAILURE" : null,
    movedCharacterIDs,
  };
}

module.exports = {
  isHomeStationLost,
  isWormholeHomeStationSystem,
  moveHomeStationsOutOfStructure,
  resolveSchoolHQStationID,
};
