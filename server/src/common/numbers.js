"use strict";

// Shared number helpers. Copies of these are still defined in many files; the
// cleanup plan (D1) replaces them with these, one directory at a time.

module.exports = {
  clamp,
  round6,
  roundNumber,
  toFiniteNumber,
  toInt,
  toNumber: toFiniteNumber,
  toPositiveInt,
};


function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function toFiniteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

// Truncates toward zero. Text that is not wholly a number ("12abc") gives the
// fallback; callers that need a leading-digits parse keep a local helper.
function toInt(value, fallback = 0) {
  return Math.trunc(toFiniteNumber(value, fallback));
}

// A whole number above zero, or the fallback. Infinity and NaN give the fallback.
function toPositiveInt(value, fallback = 0) {
  const numeric = toInt(value, 0);
  return numeric > 0 ? numeric : fallback;
}

function roundNumber(value, decimals = 1) {
  const factor = 10 ** decimals;
  return Math.round(toFiniteNumber(value, 0) * factor) / factor;
}

// Six decimal places, as the dogma and fitting code rounds attribute values.
function round6(value) {
  return Number(toFiniteNumber(value, 0).toFixed(6));
}
