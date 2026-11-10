"use strict";

const ABYSSAL_RUN_REGISTRY_ERROR = Object.freeze({
  INVALID_RUN: "ABYSSAL_RUN_REGISTRY_INVALID_RUN",
  DUPLICATE_RUN_ID: "ABYSSAL_RUN_REGISTRY_DUPLICATE_RUN_ID",
  RUN_NOT_FOUND: "ABYSSAL_RUN_REGISTRY_RUN_NOT_FOUND",
  TRACE_COLLISION: "ABYSSAL_RUN_REGISTRY_TRACE_COLLISION",
  PARTICIPANT_COLLISION: "ABYSSAL_RUN_REGISTRY_PARTICIPANT_COLLISION",
  MARKER_COLLISION: "ABYSSAL_RUN_REGISTRY_MARKER_COLLISION",
  INDEX_CORRUPTION: "ABYSSAL_RUN_REGISTRY_INDEX_CORRUPTION",
});

function toPositiveInteger(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  const integer = Math.trunc(numeric);
  return integer > 0 ? integer : 0;
}

class AbyssalRunRegistryError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = "AbyssalRunRegistryError";
    this.code = code;
    this.details = { ...details };
  }
}

class RunRegistry {
  #runsByInstanceID = new Map();
  #instanceIDByTraceID = new Map();
  #instanceIDByParticipantCharacterID = new Map();
  #instanceIDByMarkerID = new Map();
  #indexKeysByInstanceID = new Map();
  #getParticipantCharacterIDs;

  constructor(options = {}) {
    this.#getParticipantCharacterIDs =
      typeof options.getParticipantCharacterIDs === "function"
        ? options.getParticipantCharacterIDs
        : (run) => Array.isArray(run && run.participantRoster)
          ? run.participantRoster.map((participant) => participant && participant.characterID)
          : [];
  }

  get size() {
    return this.#runsByInstanceID.size;
  }

  hasRun(instanceID) {
    return this.#runsByInstanceID.has(toPositiveInteger(instanceID));
  }

  // Run objects remain mutable by design. Callers that change an indexed field
  // in place must call reindex(instanceID) before relying on secondary lookups.
  getByInstanceID(instanceID) {
    return this.#runsByInstanceID.get(toPositiveInteger(instanceID)) || null;
  }

  getByTraceID(traceID) {
    const instanceID = this.#instanceIDByTraceID.get(toPositiveInteger(traceID)) || 0;
    return instanceID > 0 ? this.getByInstanceID(instanceID) : null;
  }

  getByParticipantCharacterID(characterID) {
    const instanceID =
      this.#instanceIDByParticipantCharacterID.get(toPositiveInteger(characterID)) || 0;
    return instanceID > 0 ? this.getByInstanceID(instanceID) : null;
  }

  getByMarkerID(markerID) {
    const instanceID = this.#instanceIDByMarkerID.get(toPositiveInteger(markerID)) || 0;
    return instanceID > 0 ? this.getByInstanceID(instanceID) : null;
  }

  listActiveRuns() {
    return [...this.#runsByInstanceID.values()];
  }

  validateRegistration(run, options = {}) {
    const replace = options.replace === true;
    const keys = this.#buildIndexKeys(run);
    const existingRun = this.#runsByInstanceID.get(keys.instanceID) || null;
    if (replace && !existingRun) {
      throw new AbyssalRunRegistryError(
        ABYSSAL_RUN_REGISTRY_ERROR.RUN_NOT_FOUND,
        { instanceID: keys.instanceID },
      );
    }
    if (!replace && existingRun) {
      throw new AbyssalRunRegistryError(
        ABYSSAL_RUN_REGISTRY_ERROR.DUPLICATE_RUN_ID,
        { instanceID: keys.instanceID },
      );
    }
    this.#assertNoSecondaryCollisions(keys);
    return {
      instanceID: keys.instanceID,
      traceID: keys.traceID,
      participantCharacterIDs: [...keys.participantCharacterIDs],
      markerIDs: [...keys.markerIDs],
      replace,
    };
  }

  register(run) {
    const keys = this.#buildIndexKeys(run);
    this.validateRegistration(run);
    this.#install(run, keys, null);
    return run;
  }

  replace(run) {
    const keys = this.#buildIndexKeys(run);
    this.validateRegistration(run, { replace: true });
    const previousKeys = this.#indexKeysByInstanceID.get(keys.instanceID) || null;
    this.#install(run, keys, previousKeys);
    return run;
  }

  reindex(instanceID) {
    const run = this.getByInstanceID(instanceID);
    if (!run) {
      throw new AbyssalRunRegistryError(
        ABYSSAL_RUN_REGISTRY_ERROR.RUN_NOT_FOUND,
        { instanceID: toPositiveInteger(instanceID) },
      );
    }
    return this.replace(run);
  }

  remove(instanceID) {
    const numericInstanceID = toPositiveInteger(instanceID);
    const run = this.#runsByInstanceID.get(numericInstanceID) || null;
    if (!run) return null;

    const keys = this.#indexKeysByInstanceID.get(numericInstanceID) ||
      this.#buildIndexKeys(run);
    this.#removeSecondaryIndexes(keys);
    this.#indexKeysByInstanceID.delete(numericInstanceID);
    this.#runsByInstanceID.delete(numericInstanceID);
    return run;
  }

  clear() {
    this.#runsByInstanceID.clear();
    this.#instanceIDByTraceID.clear();
    this.#instanceIDByParticipantCharacterID.clear();
    this.#instanceIDByMarkerID.clear();
    this.#indexKeysByInstanceID.clear();
  }

  validateInvariants() {
    const errors = [];
    const addError = (reason, details = {}) => {
      errors.push({
        code: ABYSSAL_RUN_REGISTRY_ERROR.INDEX_CORRUPTION,
        reason,
        ...details,
      });
    };

    for (const [instanceID, run] of this.#runsByInstanceID.entries()) {
      let actualKeys;
      try {
        actualKeys = this.#buildIndexKeys(run);
      } catch (error) {
        addError("PRIMARY_RUN_INVALID", {
          instanceID,
          errorCode: error && error.code,
        });
        continue;
      }
      const storedKeys = this.#indexKeysByInstanceID.get(instanceID) || null;
      if (!storedKeys) {
        addError("INDEX_KEY_SNAPSHOT_MISSING", { instanceID });
        continue;
      }
      if (!this.#indexKeysEqual(storedKeys, actualKeys)) {
        addError("INDEXED_FIELDS_CHANGED_WITHOUT_REINDEX", { instanceID });
      }
      this.#validatePrimaryReciprocity(actualKeys, addError);
    }

    for (const instanceID of this.#indexKeysByInstanceID.keys()) {
      if (!this.#runsByInstanceID.has(instanceID)) {
        addError("ORPHANED_INDEX_KEY_SNAPSHOT", { instanceID });
      }
    }
    this.#validateSecondaryReciprocity(
      this.#instanceIDByTraceID,
      "traceID",
      (keys) => keys.traceID > 0 ? [keys.traceID] : [],
      addError,
    );
    this.#validateSecondaryReciprocity(
      this.#instanceIDByParticipantCharacterID,
      "participantCharacterID",
      (keys) => keys.participantCharacterIDs,
      addError,
    );
    this.#validateSecondaryReciprocity(
      this.#instanceIDByMarkerID,
      "markerID",
      (keys) => keys.markerIDs,
      addError,
    );

    return {
      valid: errors.length === 0,
      errors,
      counts: {
        runs: this.#runsByInstanceID.size,
        traces: this.#instanceIDByTraceID.size,
        participants: this.#instanceIDByParticipantCharacterID.size,
        markers: this.#instanceIDByMarkerID.size,
      },
    };
  }

  assertInvariants() {
    const result = this.validateInvariants();
    if (!result.valid) {
      throw new AbyssalRunRegistryError(
        ABYSSAL_RUN_REGISTRY_ERROR.INDEX_CORRUPTION,
        { errors: result.errors },
      );
    }
    return result;
  }

  getInvariantSnapshot() {
    const sortEntries = (entries) => entries.sort((left, right) =>
      left[0] - right[0] || left[1] - right[1]
    );
    return {
      runIDs: [...this.#runsByInstanceID.keys()].sort((left, right) => left - right),
      traceIndex: sortEntries([...this.#instanceIDByTraceID.entries()]),
      participantIndex: sortEntries([
        ...this.#instanceIDByParticipantCharacterID.entries(),
      ]),
      markerIndex: sortEntries([...this.#instanceIDByMarkerID.entries()]),
      validation: this.validateInvariants(),
    };
  }

  #buildIndexKeys(run) {
    if (!run || typeof run !== "object") {
      throw new AbyssalRunRegistryError(
        ABYSSAL_RUN_REGISTRY_ERROR.INVALID_RUN,
        { reason: "RUN_OBJECT_MISSING" },
      );
    }
    const instanceID = toPositiveInteger(run.instanceID);
    if (instanceID <= 0) {
      throw new AbyssalRunRegistryError(
        ABYSSAL_RUN_REGISTRY_ERROR.INVALID_RUN,
        { reason: "INSTANCE_ID_INVALID" },
      );
    }

    let rawParticipantCharacterIDs;
    try {
      rawParticipantCharacterIDs = this.#getParticipantCharacterIDs(run);
    } catch (error) {
      throw new AbyssalRunRegistryError(
        ABYSSAL_RUN_REGISTRY_ERROR.INVALID_RUN,
        {
          reason: "PARTICIPANT_INDEX_EXTRACTION_FAILED",
          instanceID,
          cause: error && error.message,
        },
      );
    }
    if (!Array.isArray(rawParticipantCharacterIDs)) {
      throw new AbyssalRunRegistryError(
        ABYSSAL_RUN_REGISTRY_ERROR.INVALID_RUN,
        { reason: "PARTICIPANT_INDEX_NOT_ARRAY", instanceID },
      );
    }

    const participantCharacterIDs = [];
    const seenParticipantCharacterIDs = new Set();
    for (const value of rawParticipantCharacterIDs) {
      const characterID = toPositiveInteger(value);
      if (characterID <= 0) {
        throw new AbyssalRunRegistryError(
          ABYSSAL_RUN_REGISTRY_ERROR.INVALID_RUN,
          { reason: "PARTICIPANT_CHARACTER_ID_INVALID", instanceID },
        );
      }
      if (!seenParticipantCharacterIDs.has(characterID)) {
        seenParticipantCharacterIDs.add(characterID);
        participantCharacterIDs.push(characterID);
      }
    }
    participantCharacterIDs.sort((left, right) => left - right);

    const markerIDs = [];
    const seenMarkerIDs = new Set();
    for (const value of [run.originMarkerItemID, run.exitMarkerItemID]) {
      const markerID = toPositiveInteger(value);
      if (markerID > 0 && !seenMarkerIDs.has(markerID)) {
        seenMarkerIDs.add(markerID);
        markerIDs.push(markerID);
      }
    }
    markerIDs.sort((left, right) => left - right);
    return {
      instanceID,
      traceID: toPositiveInteger(run.traceItemID),
      participantCharacterIDs,
      markerIDs,
    };
  }

  #assertNoSecondaryCollisions(keys) {
    this.#assertIndexAvailable(
      this.#instanceIDByTraceID,
      keys.traceID > 0 ? [keys.traceID] : [],
      keys.instanceID,
      ABYSSAL_RUN_REGISTRY_ERROR.TRACE_COLLISION,
      "traceID",
    );
    this.#assertIndexAvailable(
      this.#instanceIDByParticipantCharacterID,
      keys.participantCharacterIDs,
      keys.instanceID,
      ABYSSAL_RUN_REGISTRY_ERROR.PARTICIPANT_COLLISION,
      "characterID",
    );
    this.#assertIndexAvailable(
      this.#instanceIDByMarkerID,
      keys.markerIDs,
      keys.instanceID,
      ABYSSAL_RUN_REGISTRY_ERROR.MARKER_COLLISION,
      "markerID",
    );
  }

  #assertIndexAvailable(index, keys, instanceID, code, field) {
    for (const key of keys) {
      const conflictingInstanceID = index.get(key) || 0;
      if (conflictingInstanceID > 0 && conflictingInstanceID !== instanceID) {
        throw new AbyssalRunRegistryError(code, {
          instanceID,
          conflictingInstanceID,
          [field]: key,
        });
      }
    }
  }

  #install(run, keys, previousKeys) {
    if (previousKeys) this.#removeSecondaryIndexes(previousKeys);
    this.#runsByInstanceID.set(keys.instanceID, run);
    this.#indexKeysByInstanceID.set(keys.instanceID, keys);
    if (keys.traceID > 0) {
      this.#instanceIDByTraceID.set(keys.traceID, keys.instanceID);
    }
    for (const characterID of keys.participantCharacterIDs) {
      this.#instanceIDByParticipantCharacterID.set(characterID, keys.instanceID);
    }
    for (const markerID of keys.markerIDs) {
      this.#instanceIDByMarkerID.set(markerID, keys.instanceID);
    }
  }

  #removeSecondaryIndexes(keys) {
    this.#deleteOwnedIndexEntry(
      this.#instanceIDByTraceID,
      keys.traceID,
      keys.instanceID,
    );
    for (const characterID of keys.participantCharacterIDs) {
      this.#deleteOwnedIndexEntry(
        this.#instanceIDByParticipantCharacterID,
        characterID,
        keys.instanceID,
      );
    }
    for (const markerID of keys.markerIDs) {
      this.#deleteOwnedIndexEntry(
        this.#instanceIDByMarkerID,
        markerID,
        keys.instanceID,
      );
    }
  }

  #deleteOwnedIndexEntry(index, key, instanceID) {
    if (key > 0 && index.get(key) === instanceID) index.delete(key);
  }

  #validatePrimaryReciprocity(keys, addError) {
    const expected = [
      [this.#instanceIDByTraceID, keys.traceID > 0 ? [keys.traceID] : [], "TRACE_INDEX_MISSING"],
      [
        this.#instanceIDByParticipantCharacterID,
        keys.participantCharacterIDs,
        "PARTICIPANT_INDEX_MISSING",
      ],
      [this.#instanceIDByMarkerID, keys.markerIDs, "MARKER_INDEX_MISSING"],
    ];
    for (const [index, indexKeys, reason] of expected) {
      for (const indexKey of indexKeys) {
        if (index.get(indexKey) !== keys.instanceID) {
          addError(reason, {
            instanceID: keys.instanceID,
            indexKey,
            actualInstanceID: index.get(indexKey) || 0,
          });
        }
      }
    }
  }

  #validateSecondaryReciprocity(index, field, selectExpectedKeys, addError) {
    for (const [indexKey, instanceID] of index.entries()) {
      const run = this.#runsByInstanceID.get(instanceID) || null;
      const keys = this.#indexKeysByInstanceID.get(instanceID) || null;
      if (!run || !keys) {
        addError("ORPHANED_SECONDARY_INDEX", { field, indexKey, instanceID });
        continue;
      }
      if (!selectExpectedKeys(keys).includes(indexKey)) {
        addError("SECONDARY_INDEX_POINTS_TO_WRONG_RUN", {
          field,
          indexKey,
          instanceID,
        });
      }
    }
  }

  #indexKeysEqual(left, right) {
    return left.instanceID === right.instanceID &&
      left.traceID === right.traceID &&
      left.participantCharacterIDs.length === right.participantCharacterIDs.length &&
      left.participantCharacterIDs.every((value, index) =>
        value === right.participantCharacterIDs[index]
      ) &&
      left.markerIDs.length === right.markerIDs.length &&
      left.markerIDs.every((value, index) => value === right.markerIDs[index]);
  }
}

module.exports = {
  ABYSSAL_RUN_REGISTRY_ERROR,
  AbyssalRunRegistryError,
  RunRegistry,
};
