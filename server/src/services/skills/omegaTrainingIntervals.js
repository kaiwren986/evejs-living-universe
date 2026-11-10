"use strict";

// A history entry records the effective entitlement projection from that exact
// FILETIME onward. Its expiry is itself a rate boundary, including after a cold
// restart when no timer or cached skill projection survived.
const MAX_HISTORY_ENTRIES = 4096;
const INVALID = "INVALID_OMEGA_TRAINING_HISTORY";

function ticks(value) {
  if (typeof value === "bigint" && value >= 0n) return value;
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) throw new Error(INVALID);
  return BigInt(value);
}

function validateHistory(history) {
  if (!Array.isArray(history) || history.length === 0 || history.length > MAX_HISTORY_ENTRIES) throw new Error(INVALID);
  let previous = -1n;
  return history.map((entry, index) => {
    if (!entry || typeof entry !== "object") throw new Error(INVALID);
    const from = ticks(entry.fromFileTime), expiry = ticks(entry.expiryFileTime);
    if ((index === 0 && from !== 0n) || from <= previous) throw new Error(INVALID);
    previous = from;
    return { fromFileTime: from.toString(), expiryFileTime: expiry.toString() };
  });
}

function planHistory(history, previousExpiryFileTime, nextExpiryFileTime, atFileTime) {
  const previousExpiry = ticks(previousExpiryFileTime), nextExpiry = ticks(nextExpiryFileTime), at = ticks(atFileTime);
  const next = history == null
    ? [{ fromFileTime: "0", expiryFileTime: previousExpiry.toString() }]
    : validateHistory(history);
  const last = next[next.length - 1];
  if (at < ticks(last.fromFileTime) || ticks(last.expiryFileTime) !== previousExpiry) throw new Error(INVALID);
  if (previousExpiry === nextExpiry) return next;
  const entry = { fromFileTime: at.toString(), expiryFileTime: nextExpiry.toString() };
  // Multiple commits at the same instant cannot accrue time between them.
  if (ticks(last.fromFileTime) === at) next[next.length - 1] = entry;
  else {
    if (next.length === MAX_HISTORY_ENTRIES) throw new Error("OMEGA_TRAINING_HISTORY_FULL");
    next.push(entry);
  }
  return next;
}

function activeAt(history, at) {
  let low = 0, high = history.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (ticks(history[middle].fromFileTime) <= at) low = middle;
    else high = middle - 1;
  }
  return ticks(history[low].expiryFileTime) > at;
}

function hasOmegaAt(history, atFileTime) {
  const normalized = validateHistory(history), at = ticks(atFileTime);
  return activeAt(normalized, at);
}

function getRateBoundaries(history, startFileTime, endFileTime) {
  const normalized = validateHistory(history), start = ticks(startFileTime), end = ticks(endFileTime);
  if (end < start) throw new Error(INVALID);
  const candidates = new Set();
  for (const entry of normalized) {
    for (const value of [entry.fromFileTime, entry.expiryFileTime]) {
      const at = ticks(value);
      if (at > start && at < end) candidates.add(at.toString());
    }
  }
  // Superseded expiry dates and uninterrupted extensions are not rate changes.
  return [...candidates].map(BigInt)
    .filter(at => activeAt(normalized, at - 1n) !== activeAt(normalized, at))
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
    .map(String);
}

module.exports = { MAX_HISTORY_ENTRIES, validateHistory, planHistory, hasOmegaAt, getRateBoundaries };
