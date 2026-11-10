"use strict";

const path = require("path");

const { getDefaultHubPosition } = require(path.join(__dirname, "./sovHubPlacement"));

function normalizeInteger(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.trunc(numeric);
}

function normalizePositiveInteger(value, fallback = null) {
  const numeric = normalizeInteger(value, 0);
  return numeric > 0 ? numeric : fallback;
}

function normalizeSpacePoint(value, fallback = null) {
  if (!value || typeof value !== "object") {
    return fallback;
  }
  const x = Number(value.x);
  const y = Number(value.y);
  const z = Number(value.z);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
    return fallback;
  }
  return { x, y, z };
}

function cloneSpacePoint(value, fallback = null) {
  const point = normalizeSpacePoint(value, fallback);
  return point ? { ...point } : fallback;
}

/**
 * Where GM tooling places a system's sovereignty core: the Sovereignty Hub,
 * 100 km above the sun's warp-in point. Flex structures and automation land
 * relative to this point when the system has no Hub yet.
 */
function buildAnchorLayout(solarSystemID) {
  const hubPoint = cloneSpacePoint(
    getDefaultHubPosition(normalizePositiveInteger(solarSystemID, 0)),
    null,
  );
  return {
    positionsByKind: {
      ihub: hubPoint,
    },
    primaryPoint: cloneSpacePoint(hubPoint, null),
  };
}

module.exports = {
  buildAnchorLayout,
  cloneSpacePoint,
  normalizePositiveInteger,
  normalizeSpacePoint,
};
