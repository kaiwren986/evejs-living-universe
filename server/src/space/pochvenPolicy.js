"use strict";

const path = require("path");

const worldData = require(path.join(__dirname, "./worldData"));

const POCHVEN_REGION_ID = 10000070;

function toPositiveInteger(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  const integer = Math.trunc(numeric);
  return integer > 0 ? integer : 0;
}

function isPochvenSystem(solarSystemID, systemRecord = null) {
  const systemID = toPositiveInteger(solarSystemID);
  const system = systemRecord && typeof systemRecord === "object"
    ? systemRecord
    : systemID
      ? worldData.getSolarSystemByID(systemID)
      : null;
  return toPositiveInteger(system && system.regionID) === POCHVEN_REGION_ID;
}

module.exports = {
  POCHVEN_REGION_ID,
  isPochvenSystem,
};
