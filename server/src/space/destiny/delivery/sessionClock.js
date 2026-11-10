"use strict";

// A session's sim clock: sim TIME, not Destiny stamps. A client rebased onto
// a different sim time than the scene's (a jump out of Time Dilation, a
// bootstrap that kept the clock it had) runs at the scene's time plus its
// clock offset; its DoSimClockRebase and every file time sent to it carry
// that offset. Destiny stamps carry none: the scene's nextDestinyStamp is the
// only stamp authority.

const {
  toFiniteNumber,
} = require("../../../common/numbers");

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return Math.trunc(numeric);
  }
  const fallbackNumeric = Number(fallback);
  return Number.isFinite(fallbackNumeric) ? Math.trunc(fallbackNumeric) : 0;
}

function roundNumber(value, digits = 3) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  const factor = 10 ** Math.max(0, Math.min(12, toInt(digits, 3)));
  return Math.round(numeric * factor) / factor;
}

function getSessionClockOffsetMs(session) {
  if (!session || !session._space) {
    return 0;
  }
  return toFiniteNumber(session._space.clockOffsetMs, 0);
}

function translateSimTimeForSession(session, rawSimTimeMs, fallbackRawSimTimeMs = 0) {
  const normalizedRawSimTimeMs = toFiniteNumber(rawSimTimeMs, fallbackRawSimTimeMs);
  return roundNumber(
    normalizedRawSimTimeMs + getSessionClockOffsetMs(session),
    3,
  );
}

function getCurrentSessionSimTimeMs(session, rawSimTimeMs, fallbackRawSimTimeMs = 0) {
  return translateSimTimeForSession(session, rawSimTimeMs, fallbackRawSimTimeMs);
}

module.exports = {
  getCurrentSessionSimTimeMs,
  getSessionClockOffsetMs,
  translateSimTimeForSession,
};
