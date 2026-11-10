"use strict";

const { cloneValue } = require("../domain/abyssalValueUtils");

const RECOVERY_TOMBSTONE_INDEX_DEFINITIONS = Object.freeze([
  Object.freeze({ indexName: "byCharacterID", keyField: "characterID" }),
  Object.freeze({ indexName: "byShipID", keyField: "shipID" }),
  Object.freeze({ indexName: "byHostLocationID", keyField: "hostLocationID" }),
]);

const EMPTY_EVICTION_METRICS = Object.freeze({
  passCount: 0,
  totalScanned: 0,
  totalEvicted: 0,
  evictionFailureCount: 0,
  lastPassScanned: 0,
  lastPassExpired: 0,
  lastPassEligible: 0,
  lastPassEvicted: 0,
  lastPassRetainedExpired: 0,
  lastFailureAtMs: 0,
  lastFailureLoggedAtMs: 0,
});

function toPositiveInteger(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  const integer = Math.trunc(numeric);
  return integer > 0 ? integer : 0;
}

function createEmptyMetrics() {
  return { ...EMPTY_EVICTION_METRICS };
}

class AbyssalRecoveryTombstoneStore {
  #memoryIndexes = new Map(
    RECOVERY_TOMBSTONE_INDEX_DEFINITIONS.map(({ indexName }) => [indexName, new Map()]),
  );

  #scanIterator = null;

  #metrics = createEmptyMetrics();

  register(tombstone) {
    if (!tombstone || typeof tombstone !== "object") return false;
    const storedTombstone = cloneValue(tombstone);
    let registered = false;
    for (const { indexName, keyField } of RECOVERY_TOMBSTONE_INDEX_DEFINITIONS) {
      const key = toPositiveInteger(storedTombstone[keyField]);
      if (key <= 0) continue;
      this.#memoryIndexes.get(indexName).set(key, storedTombstone);
      registered = true;
    }
    return registered;
  }

  get(indexName, key) {
    const index = this.#memoryIndexes.get(indexName);
    if (!index) return null;
    const tombstone = index.get(toPositiveInteger(key)) || null;
    return tombstone ? cloneValue(tombstone) : null;
  }

  findCandidates(context = {}) {
    return RECOVERY_TOMBSTONE_INDEX_DEFINITIONS.map(({ indexName, keyField }) => {
      const key = toPositiveInteger(context[keyField]);
      return key > 0 ? this.get(indexName, key) : null;
    });
  }

  hasEntries() {
    return RECOVERY_TOMBSTONE_INDEX_DEFINITIONS.some(
      ({ indexName }) => this.#memoryIndexes.get(indexName).size > 0,
    );
  }

  *iterateValues() {
    for (const { indexName } of RECOVERY_TOMBSTONE_INDEX_DEFINITIONS) {
      for (const tombstone of this.#memoryIndexes.get(indexName).values()) {
        yield cloneValue(tombstone);
      }
    }
  }

  hasMatching(indexName, key, identity, getIdentity) {
    if (typeof getIdentity !== "function" || !identity) return false;
    return getIdentity(this.get(indexName, key)) === identity;
  }

  deleteMatching(tombstone, getIdentity) {
    if (typeof getIdentity !== "function") return 0;
    const identity = getIdentity(tombstone);
    if (!identity) return 0;
    let deleted = 0;
    for (const { indexName, keyField } of RECOVERY_TOMBSTONE_INDEX_DEFINITIONS) {
      const key = toPositiveInteger(tombstone && tombstone[keyField]);
      const index = this.#memoryIndexes.get(indexName);
      const storedTombstone = key > 0 ? index.get(key) : null;
      if (
        key > 0 &&
        getIdentity(cloneValue(storedTombstone)) === identity &&
        index.delete(key)
      ) {
        deleted += 1;
      }
    }
    return deleted;
  }

  #ensureScanIterator(createIterator) {
    if (!this.#scanIterator) {
      if (typeof createIterator !== "function") {
        throw new TypeError("createIterator must be a function");
      }
      const iterator = createIterator();
      if (!iterator || typeof iterator.next !== "function") {
        throw new TypeError("createIterator must return an iterator");
      }
      this.#scanIterator = iterator;
    }
    return this.#scanIterator;
  }

  nextScanEntry(createIterator) {
    return this.#ensureScanIterator(createIterator).next();
  }

  finishScan() {
    this.#scanIterator = null;
  }

  hasScanInProgress() {
    return this.#scanIterator !== null;
  }

  recordEvictionFailure(nowMs, failureLogIntervalMs) {
    const effectiveNowMs = Math.max(0, Number(nowMs) || 0);
    const intervalMs = Math.max(0, Number(failureLogIntervalMs) || 0);
    this.#metrics.evictionFailureCount += 1;
    this.#metrics.lastFailureAtMs = effectiveNowMs;
    const shouldLog =
      this.#metrics.lastFailureLoggedAtMs <= 0 ||
      effectiveNowMs - this.#metrics.lastFailureLoggedAtMs >= intervalMs;
    if (shouldLog) this.#metrics.lastFailureLoggedAtMs = effectiveNowMs;
    return shouldLog;
  }

  recordMaintenancePass(result = {}) {
    this.#metrics.passCount += 1;
    this.#metrics.totalScanned += Math.max(0, Number(result.scanned) || 0);
    this.#metrics.totalEvicted += Math.max(0, Number(result.evicted) || 0);
    this.#metrics.lastPassScanned = Math.max(0, Number(result.scanned) || 0);
    this.#metrics.lastPassExpired = Math.max(0, Number(result.expired) || 0);
    this.#metrics.lastPassEligible = Math.max(0, Number(result.eligible) || 0);
    this.#metrics.lastPassEvicted = Math.max(0, Number(result.evicted) || 0);
    this.#metrics.lastPassRetainedExpired = Math.max(
      0,
      Number(result.retainedExpired) || 0,
    );
  }

  getDiagnostics() {
    return {
      memory: Object.fromEntries(
        RECOVERY_TOMBSTONE_INDEX_DEFINITIONS.map(({ indexName }) => [
          indexName,
          this.#memoryIndexes.get(indexName).size,
        ]),
      ),
      scanInProgress: this.hasScanInProgress(),
      metrics: { ...this.#metrics },
    };
  }

  reset() {
    for (const index of this.#memoryIndexes.values()) index.clear();
    this.#scanIterator = null;
    this.#metrics = createEmptyMetrics();
  }
}

function createAbyssalRecoveryTombstoneStore() {
  return new AbyssalRecoveryTombstoneStore();
}

const abyssalRecoveryTombstoneStore = createAbyssalRecoveryTombstoneStore();

module.exports = {
  RECOVERY_TOMBSTONE_INDEX_DEFINITIONS,
  AbyssalRecoveryTombstoneStore,
  abyssalRecoveryTombstoneStore,
  createAbyssalRecoveryTombstoneStore,
};
