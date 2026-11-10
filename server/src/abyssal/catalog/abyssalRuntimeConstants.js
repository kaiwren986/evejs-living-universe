"use strict";

// These lifecycle constants are shared by the PR #38 runtime and the
// FullAbyssalEngineV2 golden-log implementation. Keep the unopened entrance
// trace lifetime separate from the lethal in-run deadline: the former is a
// deployment window, while the latter starts when the first participant
// enters Abyssal Deadspace.
const ABYSS_RUN_DURATION_MS = 20 * 60 * 1000;
const ABYSS_UNUSED_TRACE_DURATION_MS = 30 * 60 * 1000;
const ABYSS_RETURN_PROTECTION_DURATION_MS = 60 * 1000;
const ABYSS_ROOM_COUNT = 3;
const ABYSS_BOUNDARY_RADIUS_METERS = 75_000;
const ABYSS_RETURN_TRACE_SURFACE_CLEARANCE_METERS = 5_000;

module.exports = Object.freeze({
  ABYSS_BOUNDARY_RADIUS_METERS,
  ABYSS_RETURN_TRACE_SURFACE_CLEARANCE_METERS,
  ABYSS_ROOM_COUNT,
  ABYSS_RETURN_PROTECTION_DURATION_MS,
  ABYSS_RUN_DURATION_MS,
  ABYSS_UNUSED_TRACE_DURATION_MS,
});
