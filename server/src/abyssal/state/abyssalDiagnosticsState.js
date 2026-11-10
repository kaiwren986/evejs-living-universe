"use strict";

const ABYSSAL_DIAGNOSTIC_DEDUPE_SCOPE = Object.freeze({
  AMBIGUOUS_SCENE_MODE: "ambiguous-scene-mode",
  BASE_ROOM_LAYOUT_RECOVERY: "base-room-layout-recovery",
  LAYOUT_RECOVERY: "layout-recovery",
  MISSING_AUTHORITATIVE_SCENERY: "missing-authoritative-scenery",
  RECOVERED_SCENE_MODE: "recovered-scene-mode",
  ROOM_CONTENT_LIFECYCLE: "room-content-lifecycle",
});

const EMPTY_AUDIT_METRICS = Object.freeze({
  eventsDropped: 0,
  eventsTruncated: 0,
  repeatedFailuresAggregated: 0,
});

function toInteger(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function clonePlainValue(value, seen = new WeakMap()) {
  if (value == null || typeof value !== "object") return value;
  if (seen.has(value)) return null;
  const output = Array.isArray(value) ? [] : {};
  seen.set(value, output);
  if (Array.isArray(value)) {
    for (const entry of value) output.push(clonePlainValue(entry, seen));
  } else {
    for (const [key, entry] of Object.entries(value)) {
      output[key] = clonePlainValue(entry, seen);
    }
  }
  return output;
}

class BoundedKeySet {
  #entries = new Map();

  constructor(maxEntries = 5_000, maximumAgeMs = 24 * 60 * 60 * 1_000) {
    this.maxEntries = Math.max(1, toInteger(maxEntries, 5_000));
    this.maximumAgeMs = Math.max(60_000, toInteger(maximumAgeMs, 86_400_000));
  }

  prune(nowMs = Date.now()) {
    const cutoffMs = nowMs - this.maximumAgeMs;
    for (const [key, retainedAtMs] of this.#entries) {
      if (retainedAtMs >= cutoffMs && this.#entries.size <= this.maxEntries) break;
      this.#entries.delete(key);
    }
    while (this.#entries.size > this.maxEntries) {
      this.#entries.delete(this.#entries.keys().next().value);
    }
  }

  add(key) {
    const nowMs = Date.now();
    this.#entries.delete(key);
    this.#entries.set(key, nowMs);
    this.prune(nowMs);
  }

  has(key) {
    this.prune();
    return this.#entries.has(key);
  }

  delete(key) {
    return this.#entries.delete(key);
  }

  deleteMatching(predicate) {
    if (typeof predicate !== "function") return 0;
    let deleted = 0;
    for (const key of this.#entries.keys()) {
      if (predicate(key) && this.#entries.delete(key)) deleted += 1;
    }
    return deleted;
  }

  clear() {
    this.#entries.clear();
  }

  get size() {
    this.prune();
    return this.#entries.size;
  }
}

class AbyssalDiagnosticsState {
  #auditEvents = [];

  #auditMetrics = { ...EMPTY_AUDIT_METRICS };

  #dedupeSets;

  #t0DarkLayoutCatalogWarningConsumed = false;

  #cloneValueGuardLogCount = 0;

  constructor(options = {}) {
    this.#dedupeSets = new Map(
      Object.values(ABYSSAL_DIAGNOSTIC_DEDUPE_SCOPE).map((scope) => [
        scope,
        new BoundedKeySet(
          options.dedupeMaximumEntries,
          options.dedupeMaximumAgeMs,
        ),
      ]),
    );
  }

  pruneAuditEvents(cutoffMs) {
    let dropped = 0;
    while (
      this.#auditEvents.length > 0 &&
      toInteger(this.#auditEvents[0] && this.#auditEvents[0].timestamp, 0) < cutoffMs
    ) {
      this.#auditEvents.shift();
      dropped += 1;
    }
    this.#auditMetrics.eventsDropped += dropped;
    return dropped;
  }

  updateLatestAuditEvent(predicate, update) {
    if (typeof predicate !== "function" || typeof update !== "function") return false;
    for (let index = this.#auditEvents.length - 1; index >= 0; index -= 1) {
      const event = this.#auditEvents[index];
      if (predicate(clonePlainValue(event))) {
        const updatedEvent = clonePlainValue(event);
        update(updatedEvent);
        this.#auditEvents[index] = clonePlainValue(updatedEvent);
        return true;
      }
    }
    return false;
  }

  appendAuditEvent(event, maximumEvents) {
    this.#auditEvents.push(clonePlainValue(event));
    const limit = Math.max(1, toInteger(maximumEvents, 1));
    const excess = Math.max(0, this.#auditEvents.length - limit);
    if (excess > 0) {
      this.#auditEvents.splice(0, excess);
      this.#auditMetrics.eventsDropped += excess;
    }
    return excess;
  }

  incrementAuditMetric(metricName, amount = 1) {
    if (!Object.prototype.hasOwnProperty.call(this.#auditMetrics, metricName)) {
      throw new RangeError(`unknown Abyssal audit metric: ${metricName}`);
    }
    this.#auditMetrics[metricName] += Math.max(0, toInteger(amount, 0));
  }

  listAuditEvents() {
    return this.#auditEvents.map((event) => clonePlainValue(event));
  }

  getAuditMetrics() {
    return { ...this.#auditMetrics };
  }

  hasDedupeKey(scope, key) {
    const set = this.#dedupeSets.get(scope);
    if (!set) throw new RangeError(`unknown Abyssal diagnostic scope: ${scope}`);
    return set.has(key);
  }

  recordDedupeKey(scope, key) {
    const set = this.#dedupeSets.get(scope);
    if (!set) throw new RangeError(`unknown Abyssal diagnostic scope: ${scope}`);
    set.add(key);
  }

  deleteDedupeKey(scope, key) {
    const set = this.#dedupeSets.get(scope);
    if (!set) throw new RangeError(`unknown Abyssal diagnostic scope: ${scope}`);
    return set.delete(key);
  }

  deleteDedupeKeysMatching(scope, predicate) {
    const set = this.#dedupeSets.get(scope);
    if (!set) throw new RangeError(`unknown Abyssal diagnostic scope: ${scope}`);
    return set.deleteMatching(predicate);
  }

  getDedupeCount(scope) {
    const set = this.#dedupeSets.get(scope);
    if (!set) throw new RangeError(`unknown Abyssal diagnostic scope: ${scope}`);
    return set.size;
  }

  consumeT0DarkLayoutCatalogWarning() {
    if (this.#t0DarkLayoutCatalogWarningConsumed) return false;
    this.#t0DarkLayoutCatalogWarningConsumed = true;
    return true;
  }

  consumeCloneValueGuardLog(maximumLogs) {
    const limit = Math.max(0, toInteger(maximumLogs, 0));
    if (this.#cloneValueGuardLogCount >= limit) return false;
    this.#cloneValueGuardLogCount += 1;
    return true;
  }

  reset() {
    this.#auditEvents.length = 0;
    this.#auditMetrics = { ...EMPTY_AUDIT_METRICS };
    for (const set of this.#dedupeSets.values()) set.clear();
    this.#t0DarkLayoutCatalogWarningConsumed = false;
    this.#cloneValueGuardLogCount = 0;
  }
}

function createAbyssalDiagnosticsState(options = {}) {
  return new AbyssalDiagnosticsState(options);
}

const abyssalDiagnosticsState = createAbyssalDiagnosticsState();

module.exports = {
  ABYSSAL_DIAGNOSTIC_DEDUPE_SCOPE,
  AbyssalDiagnosticsState,
  abyssalDiagnosticsState,
  createAbyssalDiagnosticsState,
};
