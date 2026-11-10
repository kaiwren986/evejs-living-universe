"use strict";

const path = require("path");

const worldData = require(path.join(__dirname, "../../space/worldData"));
const {
  INDUSTRY_INSTALLED_LOCATION_ID,
} = require(path.join(__dirname, "../industry/industryConstants"));
const structureAssetSafetyState = require(path.join(
  __dirname,
  "../structure/structureAssetSafetyState",
));

// Player structures live in structureState, required on use as worldData used to, so this
// file does not load the structure runtime and works where nothing else has loaded it.
function getStructureState() {
  return require(path.join(__dirname, "../structure/structureState"));
}

function toInteger(value, fallback = 0) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return fallback;
  }

  return Math.trunc(numericValue);
}

function getSessionCharacterId(session) {
  return toInteger(
    session && (session.characterID || session.charid || session.userid),
    0,
  );
}

function getSessionSolarSystemId(session) {
  return toInteger(session && (session.solarsystemid2 || session.solarsystemid), 0);
}

function getSessionConstellationId(session) {
  return toInteger(session && (session.constellationid || session.constellationID), 0);
}

function getSessionRegionId(session) {
  return toInteger(session && (session.regionid || session.regionID), 0);
}

function isAssetSafetyWrapLocation(locationID) {
  const numericLocationID = toInteger(locationID, 0);
  if (numericLocationID <= 0) {
    return false;
  }

  return Boolean(
    structureAssetSafetyState.getWrapByID(numericLocationID, {
      refresh: false,
    }),
  );
}

function isHiddenPersonalAssetLocation(locationID, session) {
  const numericLocationID = toInteger(locationID, 0);
  if (numericLocationID <= 0) {
    return true;
  }

  if (numericLocationID === INDUSTRY_INSTALLED_LOCATION_ID) {
    return true;
  }

  if (numericLocationID === getSessionCharacterId(session)) {
    return true;
  }

  if (worldData.getSolarSystemByID(numericLocationID)) {
    return true;
  }

  if (isAssetSafetyWrapLocation(numericLocationID)) {
    return true;
  }

  return false;
}

function buildDockableAssetLocationMetadata(locationID, session) {
  const numericLocationID = toInteger(locationID, 0);
  if (numericLocationID <= 0) {
    return null;
  }

  const station = worldData.getStationByID(numericLocationID);
  if (station) {
    return {
      locationID: numericLocationID,
      stationID: numericLocationID,
      typeID: toInteger(station.stationTypeID, 0) || null,
      stationTypeID: toInteger(station.stationTypeID, 0) || null,
      solarSystemID: toInteger(station.solarSystemID, 0),
      constellationID: toInteger(station.constellationID, 0),
      regionID: toInteger(station.regionID, 0),
      upkeepState: null,
    };
  }

  // The scene tick owns the global structure tick. Asset metadata only needs
  // the current record; without refresh:false every unique asset location ran
  // tickStructures() once (31 locations added seconds to the asset window).
  const structure = getStructureState().getStructureByID(numericLocationID, {
    refresh: false,
  });
  if (structure) {
    const structureSolarSystemID = toInteger(
      structure.solarSystemID,
      getSessionSolarSystemId(session),
    );
    const system = worldData.getSolarSystemByID(structureSolarSystemID) || null;
    const structureTypeID = toInteger(structure.typeID, 0) || null;
    return {
      locationID: numericLocationID,
      stationID: numericLocationID,
      typeID: structureTypeID,
      stationTypeID: structureTypeID,
      solarSystemID: structureSolarSystemID,
      constellationID: toInteger(
        structure.constellationID,
        toInteger(system && system.constellationID, getSessionConstellationId(session)),
      ),
      regionID: toInteger(
        structure.regionID,
        toInteger(system && system.regionID, getSessionRegionId(session)),
      ),
      upkeepState: structure.upkeepState === undefined ? null : structure.upkeepState,
    };
  }

  const sessionStructureTypeID = toInteger(session && session.structureTypeID, 0) || null;
  return {
    locationID: numericLocationID,
    stationID: numericLocationID,
    typeID: sessionStructureTypeID,
    stationTypeID: sessionStructureTypeID,
    solarSystemID: getSessionSolarSystemId(session),
    constellationID: getSessionConstellationId(session),
    regionID: getSessionRegionId(session),
    upkeepState: null,
  };
}

module.exports = {
  buildDockableAssetLocationMetadata,
  isAssetSafetyWrapLocation,
  isHiddenPersonalAssetLocation,
};
