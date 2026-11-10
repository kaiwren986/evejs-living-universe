"use strict";

module.exports = {
  clampTimeDilationFactor,
  fileTimeToMs,
  getMonotonicTimeMs,
  getWallclockNowMs,
  setWallclockNowProvider,
  toFileTimeFromMs,
};

const runtimeEntryDirname = require("path").resolve(__dirname, "..");
const path = require("path");
const {
  currentFileTime,
  buildFiletimeLong,
  buildMarshalReal,
} = require(path.join(runtimeEntryDirname, "../services/_shared/serviceHelpers"));
const {
  clamp,
  toFiniteNumber,
} = require("../../common/numbers");

const RUNTIME_TICK_INTERVAL_MS = 100;

const FILETIME_TICKS_PER_MS = 10000n;

const FILETIME_EPOCH_OFFSET = 116444736000000000n;

const MIN_TIME_DILATION = 0.1;

const MAX_TIME_DILATION = 1.0;

const SIM_CLOCK_REBASE_INTERVAL_MS = 250;

function getMonotonicTimeMs() {
  return performance.now();
}

function toFileTimeFromMs(value, fallback = currentFileTime()) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    return fallback;
  }
  return BigInt(Math.trunc(numericValue)) * FILETIME_TICKS_PER_MS + FILETIME_EPOCH_OFFSET;
}

function fileTimeToMs(value, fallback = Date.now()) {
  try {
    const numericValue =
      typeof value === "bigint"
        ? value
        : BigInt(value && value.type === "long" ? value.value : value);
    if (numericValue <= FILETIME_EPOCH_OFFSET) {
      return fallback;
    }
    return Number((numericValue - FILETIME_EPOCH_OFFSET) / FILETIME_TICKS_PER_MS);
  } catch (error) {
    return fallback;
  }
}

// One wall clock for the whole runtime. Production reads Date.now(); the
// gameplay harness owns it so scene time between ticks, scene wake-ups and the
// Abyssal timers agree with the virtual clock that drives the ticks.
let wallclockNowProvider = null;

function getWallclockNowMs() {
  if (wallclockNowProvider === null) {
    return Date.now();
  }
  return toFiniteNumber(wallclockNowProvider(), Date.now());
}

function setWallclockNowProvider(provider) {
  wallclockNowProvider = typeof provider === "function" ? provider : null;
}

function clampTimeDilationFactor(value, fallback = 1) {
  return clamp(
    toFiniteNumber(value, fallback),
    MIN_TIME_DILATION,
    MAX_TIME_DILATION,
  );
}

Object.assign(module.exports, {
  FILETIME_EPOCH_OFFSET,
  FILETIME_TICKS_PER_MS,
  MAX_TIME_DILATION,
  MIN_TIME_DILATION,
  RUNTIME_TICK_INTERVAL_MS,
  SIM_CLOCK_REBASE_INTERVAL_MS,
  wallclockNowProvider,
});
