"use strict";
const { getWallclockNowMs } = require("../../space/runtime/runtimeClock");
const config = require("../../config");
const { ELECTION, LOGIN, DEFAULTS } = require("../../config/eventSchedules");

function get(id) {
  const entry = (config.eventSchedules || DEFAULTS)[id];
  if (!entry) return null;
  const startsAtMs = Date.parse(entry.startsAt), endsAtMs = Date.parse(entry.endsAt);
  return { ...entry, id, startsAtMs, endsAtMs, traderEndsAtMs: endsAtMs + (entry.traderGraceDays || 0) * 86400000 };
}
function phase(id, nowMs = getWallclockNowMs()) {
  const entry = get(id);
  // Keep the old emergency switch for existing installations.
  if (!entry?.enabled || config.campaignTrailEnabled !== true) return "disabled";
  if (nowMs < entry.startsAtMs) return "scheduled";
  if (nowMs < entry.endsAtMs) return "active";
  return nowMs < entry.traderEndsAtMs ? "trader-grace" : "closed";
}
const isActive = (id, nowMs) => phase(id, nowMs) === "active";
const canTrade = (nowMs) => ["active", "trader-grace"].includes(phase(ELECTION, nowMs));
// Earned entitlements survive closure and the emergency enable switch.
const canClaim = (nowMs = getWallclockNowMs()) => {
  const event = get(ELECTION) || { startsAtMs: Date.parse(DEFAULTS[ELECTION].startsAt), endsAtMs: Date.parse(DEFAULTS[ELECTION].endsAt) };
  return nowMs >= event.startsAtMs && (nowMs >= event.endsAtMs || (config.campaignTrailEnabled === true && event.enabled === true));
};
module.exports = { ELECTION, LOGIN, get, phase, isActive, canTrade, canClaim };
