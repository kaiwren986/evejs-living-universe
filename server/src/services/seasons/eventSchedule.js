"use strict";
const { getWallclockNowMs } = require("../../space/runtime/runtimeClock");
const config = require("../../config");
const { ELECTION, LOGIN, WARPATH, WARPATH_VERSION, DEFAULTS } = require("../../config/eventSchedules");

function get(id) {
  const entry = (config.eventSchedules || DEFAULTS)[id];
  if (!entry) return null;
  const window = id === WARPATH && entry.enabled
    ? require("./eventLifecycle").read(WARPATH).runWindow : null;
  const dates = window?.version === WARPATH_VERSION ? window : entry;
  const startsAtMs = Date.parse(dates.startsAt), endsAtMs = Date.parse(dates.endsAt);
  return { ...entry, id, startsAt: dates.startsAt, endsAt: dates.endsAt,
    startsAtMs, endsAtMs, traderEndsAtMs: endsAtMs + (entry.traderGraceDays || 0) * 86400000 };
}
function isEnabled(id) {
  return (config.eventSchedules || DEFAULTS)[id]?.enabled === true && (id === WARPATH || config.campaignTrailEnabled === true);
}

function phase(id, nowMs = getWallclockNowMs()) {
  const entry = get(id);
  // Keep the old emergency switch for existing installations.
  if (!isEnabled(id)) return "disabled";
  if (nowMs < entry.startsAtMs) return "scheduled";
  if (nowMs < entry.endsAtMs) return "active";
  return nowMs < entry.traderEndsAtMs ? "trader-grace" : "closed";
}
const isActive = (id, nowMs) => phase(id, nowMs) === "active";
function openWarpath(nowMs = getWallclockNowMs()) {
  const event = get(WARPATH);
  if (!event?.enabled || nowMs < event.startsAtMs || nowMs >= event.endsAtMs) return null;
  require("./eventLifecycle").pinWarpathWindow(event);
  return event;
}
const canTrade = (nowMs) => ["active", "trader-grace"].includes(phase(ELECTION, nowMs));
// Earned entitlements survive closure and the emergency enable switch.
const canClaim = (nowMs = getWallclockNowMs()) => {
  const event = get(ELECTION) || { startsAtMs: Date.parse(DEFAULTS[ELECTION].startsAt), endsAtMs: Date.parse(DEFAULTS[ELECTION].endsAt) };
  return nowMs >= event.startsAtMs && (nowMs >= event.endsAtMs || (config.campaignTrailEnabled === true && event.enabled === true));
};
module.exports = { ELECTION, LOGIN, WARPATH, get, isEnabled, phase, isActive, openWarpath, canTrade, canClaim };
