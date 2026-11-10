"use strict";

const { UNSTABLE_ABYSSAL_DEPTHS_BOUNDARY_PROFILE } = require("./abyssalBoundaryProfile");
const { normalizeText } = require("./abyssalValueUtils");

function toFinite(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

// Movement and damage use the same mechanical radius. Presentation lights do
// not define the room perimeter.
function resolvePerimeterRadius(context, profile = UNSTABLE_ABYSSAL_DEPTHS_BOUNDARY_PROFILE) {
  const roomEntry = context && context.roomEntry || {};
  const authoredRadius = toFinite(
    roomEntry.boundaryRadiusMeters,
    toFinite(roomEntry.authoredBoundaryRadiusMeters, 0),
  );
  if (authoredRadius > 0) {
    return {
      perimeterRadiusMeters: authoredRadius,
      perimeterRadiusSource: normalizeText(
        roomEntry.boundaryRadiusSource,
        "room-specific-mechanical",
      ),
    };
  }

  const fallbackRadius = toFinite(profile && profile.perimeterFallbackRadiusMeters, 0);
  return {
    perimeterRadiusMeters: fallbackRadius,
    perimeterRadiusSource: fallbackRadius > 0 ? "central-profile-fallback" : "unresolved",
  };
}

module.exports = { resolvePerimeterRadius };
