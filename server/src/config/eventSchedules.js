"use strict";

const ELECTION = "gallente-election-yc128";
const LOGIN = "gallente-election-login-yc128";
const DEFAULTS = {
  [ELECTION]: { enabled: false, startsAt: "2026-09-15T00:00:00Z", endsAt: "2036-09-15T00:00:00Z", traderGraceDays: 7,
    bonuses: { warpSpeedPercent: 10, hybridTrackingPercent: 7.5, localArmorRepairPercent: 7.5 } },
  [LOGIN]: { enabled: false, startsAt: "2026-09-15T00:00:00Z", endsAt: "2036-09-15T00:00:00Z" },
};

function timestamp(value, name) {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${name} must be an ISO UTC timestamp ending in Z.`);
  }
  if (new Date(value).toISOString().slice(0, 19) !== value.slice(0, 19)) throw new Error(`${name} is not a valid calendar date.`);
  return Date.parse(value);
}

function validateSchedules(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("eventSchedules must be an object keyed by event ID.");
  for (const [id, entry] of Object.entries(value)) {
    if (!Object.hasOwn(DEFAULTS, id)) throw new Error(`Unknown event ${id}; a content adapter must be implemented before scheduling it.`);
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`Invalid schedule for ${id}.`);
    const allowed = id === ELECTION ? ["enabled", "startsAt", "endsAt", "traderGraceDays", "bonuses"] : ["enabled", "startsAt", "endsAt"];
    if (Object.keys(entry).some(key => !allowed.includes(key))) throw new Error(`Unknown schedule option for ${id}.`);
    if (typeof entry.enabled !== "boolean") throw new Error(`${id}.enabled must be boolean.`);
    if (timestamp(entry.endsAt, `${id}.endsAt`) <= timestamp(entry.startsAt, `${id}.startsAt`)) throw new Error(`${id}.endsAt must follow startsAt.`);
    if (id === ELECTION) {
      if (!Number.isInteger(entry.traderGraceDays) || entry.traderGraceDays < 0 || entry.traderGraceDays > 365) throw new Error("traderGraceDays must be an integer from 0 to 365.");
      const keys = Object.keys(DEFAULTS[ELECTION].bonuses);
      if (!entry.bonuses || Object.keys(entry.bonuses).length !== keys.length || keys.some(key => typeof entry.bonuses[key] !== "number" || !Number.isFinite(entry.bonuses[key]) || entry.bonuses[key] < 0 || entry.bonuses[key] > 100)) throw new Error("Election bonuses must contain all three percentages, each from 0 to 100.");
    }
  }
  return value;
}

module.exports = { ELECTION, LOGIN, DEFAULTS, validateSchedules };
