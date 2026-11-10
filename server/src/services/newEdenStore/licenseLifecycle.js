"use strict";

// Pure lifecycle projection. Entitlement authority remains storeState's
// effective Omega expiry (including the explicit configured development floor).
const { EventEmitter } = require("node:events");
const { planHistory } = require("../skills/omegaTrainingIntervals");
const events = new EventEmitter();
const OMEGA = "eve_clonestate_omega";
const OFFSET = 116444736000000000n;
const INITIAL_MODIFIED = OFFSET.toString();
function fileTime(value) {
  try { const number = BigInt(value || 0); return number > 0n ? number : 0n; }
  catch (_) { return 0n; }
}
function timestamp(value) {
  const ticks = fileTime(value) - OFFSET;
  if (ticks < 0n) return { seconds: 0, nanos: 0 };
  return { seconds: Number(ticks / 10000000n), nanos: Number(ticks % 10000000n) * 100 };
}
function plan(previousAccount, nextAccount, configuredExpiry, nowMs = Date.now()) {
  const floor = fileTime(configuredExpiry);
  const effective = account => {
    const expiry = fileTime(account?.omegaExpiryFileTime);
    return expiry > floor ? expiry : floor;
  };
  const now = BigInt(nowMs) * 10000n + OFFSET;
  const oldExpiry = effective(previousAccount), nextExpiry = effective(nextAccount);
  const saved = previousAccount?.licenseLifecycle;
  if (saved && (saved.version !== 1 || !Number.isSafeInteger(saved.revision) || saved.revision < 0 || !Array.isArray(saved.outbox))) {
    throw new Error("INVALID_LICENSE_LIFECYCLE_STATE");
  }
  const lifecycle = saved ? structuredClone(saved) : {
    version: 1, revision: 0, expiryFileTime: oldExpiry.toString(), active: oldExpiry > now,
    lastModifiedFileTime: INITIAL_MODIFIED, outbox: [],
  };
  const beforeExpiry = fileTime(lifecycle.expiryFileTime), wasActive = lifecycle.active === true;
  lifecycle.history = planHistory(lifecycle.history, beforeExpiry.toString(), nextExpiry.toString(), now.toString());
  const active = nextExpiry > now;
  const kinds = [];
  // Expiry followed by reactivation can happen before an overdue job runs.
  // Preserve both facts rather than classifying it as an uninterrupted extension.
  if (wasActive && beforeExpiry <= now) kinds.push("ExpiredNotice");
  const previouslyActiveNow = wasActive && beforeExpiry > now;
  if (active && !previouslyActiveNow) kinds.push(beforeExpiry > 0n ? "ActivatedNotice" : "CreatedNotice");
  else if (active && nextExpiry !== beforeExpiry) kinds.push(nextExpiry > beforeExpiry ? "ExpiryDateExtendedNotice" : "ExpiryDateReducedNotice");
  else if (!active && previouslyActiveNow) {
    if (nextExpiry !== beforeExpiry) kinds.push("ExpiryDateReducedNotice");
    kinds.push("ExpiredNotice");
  }
  if (kinds.length) {
    if (lifecycle.outbox.length + kinds.length > 512) throw new Error("LICENSE_NOTICE_OUTBOX_FULL");
    // Stable across reads/replays; advance even when two changes share a clock tick.
    lifecycle.lastModifiedFileTime = (now > fileTime(lifecycle.lastModifiedFileTime)
      ? now : fileTime(lifecycle.lastModifiedFileTime) + 1n).toString();
    for (const kind of kinds) {
      lifecycle.revision++;
      const expired = kind === "ExpiredNotice";
      lifecycle.outbox.push({ revision: lifecycle.revision, kind, licenseType: OMEGA,
        previousExpiryFileTime: beforeExpiry.toString(), previousActive: wasActive,
        expiryFileTime: expired ? (beforeExpiry < now ? beforeExpiry : now).toString() : nextExpiry.toString(),
        lastModifiedFileTime: lifecycle.lastModifiedFileTime });
    }
  }
  lifecycle.active = active; lifecycle.expiryFileTime = nextExpiry.toString();
  return lifecycle;
}
function signalAccount(accountID) {
  // Event listeners only wake recovery work. A publisher failure cannot turn a
  // committed funded entitlement into a failed or repeated economic operation.
  for (const listener of events.listeners("changed")) {
    try { listener(accountID); } catch (_) { /* Durable outbox remains pending. */ }
  }
}
module.exports = { events, OMEGA, OFFSET, INITIAL_MODIFIED, fileTime, timestamp, plan, signalAccount };
