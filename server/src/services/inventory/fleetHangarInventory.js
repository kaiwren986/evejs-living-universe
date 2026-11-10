"use strict";

const {
  toFiniteNumber,
} = require("../../common/numbers");

const FLEET_HANGAR_ATTRIBUTE_ID = 912;
const FLEET_HANGAR_ATTRIBUTE_NAMES = Object.freeze(["fleetHangarCapacity"]);
const FLEET_HANGAR_RESOURCE_KEY = "fleetHangarCapacity";

function getFleetHangarCapacity(resourceState) {
  if (!resourceState || typeof resourceState !== "object") {
    return 0;
  }

  const directValue = toFiniteNumber(
    resourceState[FLEET_HANGAR_RESOURCE_KEY],
    NaN,
  );
  if (Number.isFinite(directValue)) {
    return Math.max(0, directValue);
  }

  const attributes =
    resourceState.attributes && typeof resourceState.attributes === "object"
      ? resourceState.attributes
      : null;
  if (!attributes) {
    return 0;
  }

  return Math.max(
    0,
    toFiniteNumber(attributes[FLEET_HANGAR_ATTRIBUTE_ID], 0),
  );
}

module.exports = {
  FLEET_HANGAR_ATTRIBUTE_ID,
  FLEET_HANGAR_ATTRIBUTE_NAMES,
  FLEET_HANGAR_RESOURCE_KEY,
  getFleetHangarCapacity,
};
