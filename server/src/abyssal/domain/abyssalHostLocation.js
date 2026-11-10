"use strict";

const ABYSSAL_LOCATION_ID_MIN = 32000001;
const ABYSSAL_LOCATION_ID_COUNT = 200;
const ABYSSAL_LOCATION_ID_MAX =
  ABYSSAL_LOCATION_ID_MIN + ABYSSAL_LOCATION_ID_COUNT - 1;

function toInteger(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function isAbyssalHostLocationID(locationID) {
  const numericLocationID = toInteger(locationID, 0);
  return (
    numericLocationID >= ABYSSAL_LOCATION_ID_MIN &&
    numericLocationID <= ABYSSAL_LOCATION_ID_MAX
  );
}

/**
 * Convert an internal solar-system/location identifier into a value that is
 * safe to publish outside the owning Abyssal session. Abyssal host IDs are
 * implementation details: exposing one lets unrelated services reveal that a
 * character is in a specific private run host.
 *
 * Station and structure IDs intentionally pass through. A few legacy payloads
 * call their field `locationID` even though they share this public-location
 * boundary with solar-system IDs.
 */
function toPublicSolarSystemID(solarSystemID, fallback = null) {
  const numericSolarSystemID = toInteger(solarSystemID, 0);
  if (
    numericSolarSystemID <= 0 ||
    isAbyssalHostLocationID(numericSolarSystemID)
  ) {
    if (fallback === null || fallback === undefined) {
      return null;
    }
    const numericFallback = toInteger(fallback, 0);
    if (numericFallback === 0 && Number(fallback) === 0) {
      return 0;
    }
    return numericFallback > 0 && !isAbyssalHostLocationID(numericFallback)
      ? numericFallback
      : null;
  }
  return numericSolarSystemID;
}

function classifyAbyssalHostLocation(locationID, options = {}) {
  const numericLocationID = toInteger(locationID, 0);
  if (!isAbyssalHostLocationID(numericLocationID)) {
    return {
      kind: "normal",
      locationID: numericLocationID,
    };
  }

  return {
    kind: options.activeRun ? "active-abyssal" : "orphaned-host",
    locationID: numericLocationID,
  };
}

module.exports = {
  ABYSSAL_LOCATION_ID_MIN,
  ABYSSAL_LOCATION_ID_COUNT,
  ABYSSAL_LOCATION_ID_MAX,
  classifyAbyssalHostLocation,
  isAbyssalHostLocationID,
  toPublicSolarSystemID,
};
