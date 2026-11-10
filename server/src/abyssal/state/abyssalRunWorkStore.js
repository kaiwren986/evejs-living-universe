"use strict";

function toPositiveInteger(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  const integer = Math.trunc(numeric);
  return integer > 0 ? integer : 0;
}

class AbyssalRunWorkStore {
  #persistenceFailuresByRunID = new Map();
  #mutationBatchesByRunID = new Map();
  #persistedStateSignaturesByRunID = new Map();

  hasPersistenceFailure(runID) {
    return this.#persistenceFailuresByRunID.has(toPositiveInteger(runID));
  }

  getPersistenceFailure(runID) {
    return this.#persistenceFailuresByRunID.get(toPositiveInteger(runID)) || null;
  }

  setPersistenceFailure(runID, failure) {
    return this.#setRunValue(this.#persistenceFailuresByRunID, runID, failure);
  }

  deletePersistenceFailure(runID) {
    return this.#persistenceFailuresByRunID.delete(toPositiveInteger(runID));
  }

  listPersistenceFailures() {
    return [...this.#persistenceFailuresByRunID.entries()];
  }

  hasMutationBatch(runID) {
    return this.#mutationBatchesByRunID.has(toPositiveInteger(runID));
  }

  getMutationBatch(runID) {
    return this.#mutationBatchesByRunID.get(toPositiveInteger(runID)) || null;
  }

  setMutationBatch(runID, batch) {
    return this.#setRunValue(this.#mutationBatchesByRunID, runID, batch);
  }

  deleteMutationBatch(runID) {
    return this.#mutationBatchesByRunID.delete(toPositiveInteger(runID));
  }

  takeMutationBatch(runID) {
    return this.#takeRunValue(this.#mutationBatchesByRunID, runID);
  }

  listMutationBatches() {
    return [...this.#mutationBatchesByRunID.entries()];
  }

  getPersistedStateSignature(runID) {
    const numericRunID = toPositiveInteger(runID);
    return this.#persistedStateSignaturesByRunID.has(numericRunID)
      ? this.#persistedStateSignaturesByRunID.get(numericRunID)
      : null;
  }

  setPersistedStateSignature(runID, signature) {
    return this.#setRunValue(
      this.#persistedStateSignaturesByRunID,
      runID,
      signature,
    );
  }

  deletePersistedStateSignature(runID) {
    return this.#persistedStateSignaturesByRunID.delete(toPositiveInteger(runID));
  }

  listPersistedStateSignatures() {
    return [...this.#persistedStateSignaturesByRunID.entries()];
  }

  cleanupRun(runID) {
    const numericRunID = toPositiveInteger(runID);
    if (numericRunID <= 0) return this.#emptyCleanupResult(numericRunID);

    const result = {
      runID: numericRunID,
      persistenceFailure: this.#takeRunValue(
        this.#persistenceFailuresByRunID,
        numericRunID,
      ),
      mutationBatch: this.#takeRunValue(this.#mutationBatchesByRunID, numericRunID),
      persistedStateSignature: this.#takeRunValue(
        this.#persistedStateSignaturesByRunID,
        numericRunID,
      ),
    };
    result.removedCount = [
      result.persistenceFailure,
      result.mutationBatch,
      result.persistedStateSignature,
    ].filter((value) => value !== null).length;
    return result;
  }

  reset() {
    const removed = {
      persistenceFailures: this.listPersistenceFailures(),
      mutationBatches: this.listMutationBatches(),
      persistedStateSignatures: this.listPersistedStateSignatures(),
    };
    this.#persistenceFailuresByRunID.clear();
    this.#mutationBatchesByRunID.clear();
    this.#persistedStateSignaturesByRunID.clear();
    return removed;
  }

  getCounts() {
    return {
      persistenceFailures: this.#persistenceFailuresByRunID.size,
      mutationBatches: this.#mutationBatchesByRunID.size,
      persistedStateSignatures: this.#persistedStateSignaturesByRunID.size,
    };
  }

  #setRunValue(index, runID, value) {
    const numericRunID = toPositiveInteger(runID);
    if (numericRunID <= 0) return null;
    index.set(numericRunID, value);
    return value;
  }

  #takeRunValue(index, runID) {
    const numericRunID = toPositiveInteger(runID);
    if (numericRunID <= 0 || !index.has(numericRunID)) return null;
    const value = index.get(numericRunID);
    index.delete(numericRunID);
    return value;
  }

  #emptyCleanupResult(runID) {
    return {
      runID,
      persistenceFailure: null,
      mutationBatch: null,
      persistedStateSignature: null,
      removedCount: 0,
    };
  }
}

function createAbyssalRunWorkStore() {
  return new AbyssalRunWorkStore();
}

module.exports = {
  AbyssalRunWorkStore,
  createAbyssalRunWorkStore,
};
