"use strict";

const DEFAULT_CLUSTER_DOWNTIME_STARTS_UTC = "11:00:00";
const DAY_MS = 24 * 60 * 60 * 1000;

function parseClusterDowntimeStartsUtc(value) {
  const match = /^(\d{2}):(\d{2}):(\d{2})$/.exec(
    String(value || "").trim(),
  );
  if (!match) {
    return { hours: 11, minutes: 0, seconds: 0 };
  }
  const hours = Math.trunc(Number(match[1]));
  const minutes = Math.trunc(Number(match[2]));
  const seconds = Math.trunc(Number(match[3]));
  if (
    hours < 0 ||
    hours > 23 ||
    minutes < 0 ||
    minutes > 59 ||
    seconds < 0 ||
    seconds > 59
  ) {
    return { hours: 11, minutes: 0, seconds: 0 };
  }
  return { hours, minutes, seconds };
}

function getNextClusterDowntimeAtMs(
  nowMs = Date.now(),
  configuredStarts = DEFAULT_CLUSTER_DOWNTIME_STARTS_UTC,
) {
  const numericNow = Number.isFinite(Number(nowMs))
    ? Number(nowMs)
    : Date.now();
  const { hours, minutes, seconds } = parseClusterDowntimeStartsUtc(
    configuredStarts || DEFAULT_CLUSTER_DOWNTIME_STARTS_UTC,
  );
  const now = new Date(numericNow);
  let nextDowntimeAtMs = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    hours,
    minutes,
    seconds,
    0,
  );
  if (nextDowntimeAtMs <= numericNow) {
    nextDowntimeAtMs += DAY_MS;
  }
  return nextDowntimeAtMs;
}

module.exports = {
  DEFAULT_CLUSTER_DOWNTIME_STARTS_UTC,
  getNextClusterDowntimeAtMs,
  parseClusterDowntimeStartsUtc,
};
