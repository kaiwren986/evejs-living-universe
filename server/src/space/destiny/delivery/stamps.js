"use strict";

// A Destiny stamp is the scene's Destiny tick counter, read as
// scene.destinyTick or scene.nextDestinyStamp: a non-negative integer,
// compared and subtracted as one. Nothing derives one from a clock, and it
// never wraps (the counter, seeded from the second of sim time a scene was
// created in, stays far below 2^31 for decades). What follows is reading a
// stamp from an option or a payload.

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return Math.trunc(numeric);
  }
  const fallbackNumeric = Number(fallback);
  return Number.isFinite(fallbackNumeric) ? Math.trunc(fallbackNumeric) : 0;
}

// A stamp from `value`, or from `fallback` when `value` is absent (null or
// undefined): a whole number, never negative.
function normalizeDestinyStamp(value, fallback = 0) {
  const sourceValue = value === null || value === undefined
    ? fallback
    : value;
  return Math.max(0, toInt(sourceValue, 0));
}

function hasDestinyStamp(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

// `value` if it is a stamp, else `fallback` if that is, else null.
function resolveOptionalDestinyStamp(value, fallback = null) {
  if (hasDestinyStamp(value)) {
    return value;
  }
  return hasDestinyStamp(fallback) ? fallback : null;
}

module.exports = {
  hasDestinyStamp,
  normalizeDestinyStamp,
  resolveOptionalDestinyStamp,
};
