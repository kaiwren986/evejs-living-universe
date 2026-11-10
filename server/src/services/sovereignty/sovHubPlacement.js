"use strict";

const worldData = require("../../space/worldData");
const { getSunWarpInPoint } = require("../../space/destiny/simulation/warpInPointParity");

// Local placement policy: keep hubs on the sun's warp-in grid.
const HUB_ANCHOR_MAX_DISTANCE = 1_000_000;
const HUB_WARP_IN_OFFSET = 100_000;

function getHubSunWarpInPoint(solarSystemID) {
  const sun = worldData.getCelestialsForSystem(solarSystemID)
    .find((entry) => entry.kind === "sun" || Number(entry.groupID) === 6);
  return sun ? getSunWarpInPoint(sun) : null;
}

function getDefaultHubPosition(solarSystemID) {
  const point = getHubSunWarpInPoint(solarSystemID);
  return point ? { ...point, y: point.y + HUB_WARP_IN_OFFSET } : null;
}

function isHubPositionNearSun(solarSystemID, position) {
  const point = getHubSunWarpInPoint(solarSystemID);
  return Boolean(point && position && Math.hypot(
    position.x - point.x,
    position.y - point.y,
    position.z - point.z,
  ) <= HUB_ANCHOR_MAX_DISTANCE);
}

module.exports = {
  HUB_ANCHOR_MAX_DISTANCE,
  HUB_WARP_IN_OFFSET,
  getHubSunWarpInPoint,
  getDefaultHubPosition,
  isHubPositionNearSun,
};
