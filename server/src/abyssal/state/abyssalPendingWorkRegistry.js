"use strict";

const TOKEN_NAMES = Object.freeze([
  "participantAdmission",
  "clientEnvironmentDelivery",
  "freshEntryBootstrap",
  "kSpaceArrivalSessionIdentity",
]);

function toPositiveInteger(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  const integer = Math.trunc(numeric);
  return integer > 0 ? integer : 0;
}

function normalizeKey(value) {
  return String(value || "").trim();
}

function buildParticipantAdmissionKey(runID, characterID) {
  const numericRunID = toPositiveInteger(runID);
  const numericCharacterID = toPositiveInteger(characterID);
  return numericRunID > 0 && numericCharacterID > 0
    ? `${numericRunID}:${numericCharacterID}`
    : "";
}

class AbyssalPendingWorkRegistry {
  #participantDestructionReceiptsByOperationID = new Map();
  #transitionHandlesByRunID = new Map();
  #participantAdmissionHandlesByKey = new Map();
  #staleCleanupSystemIDs = new Set();
  #t0DarkLayoutOverridesByCharacterID = new Map();
  #objectiveDeathsByRunID = new Map();
  #nextTokens = {
    participantAdmission: 1,
    clientEnvironmentDelivery: 1,
    freshEntryBootstrap: 1,
    kSpaceArrivalSessionIdentity: 1,
  };

  getParticipantDestructionReceipt(operationID) {
    return this.#participantDestructionReceiptsByOperationID.get(
      normalizeKey(operationID),
    ) || null;
  }

  setParticipantDestructionReceipt(operationID, receipt) {
    const key = normalizeKey(operationID);
    if (!key) return null;
    this.#participantDestructionReceiptsByOperationID.set(key, receipt);
    return receipt;
  }

  deleteParticipantDestructionReceipt(operationID) {
    return this.#participantDestructionReceiptsByOperationID.delete(
      normalizeKey(operationID),
    );
  }

  listParticipantDestructionReceipts() {
    return [...this.#participantDestructionReceiptsByOperationID.entries()];
  }

  listParticipantDestructionReceiptsForRun(runID, characterID = 0) {
    const numericRunID = toPositiveInteger(runID);
    const numericCharacterID = toPositiveInteger(characterID);
    if (numericRunID <= 0) return [];
    return this.listParticipantDestructionReceipts().filter(([, receipt]) => (
      toPositiveInteger(receipt && receipt.instanceID) === numericRunID &&
      (
        numericCharacterID <= 0 ||
        toPositiveInteger(receipt && receipt.characterID) === numericCharacterID
      )
    ));
  }

  hasParticipantDestructionReceiptForRun(runID) {
    return this.listParticipantDestructionReceiptsForRun(runID).length > 0;
  }

  clearParticipantDestructionReceiptsForRun(runID, characterID = 0) {
    const removed = this.listParticipantDestructionReceiptsForRun(
      runID,
      characterID,
    );
    for (const [operationID] of removed) {
      this.#participantDestructionReceiptsByOperationID.delete(operationID);
    }
    return removed;
  }

  getTransitionHandle(runID) {
    return this.#transitionHandlesByRunID.get(toPositiveInteger(runID)) || null;
  }

  setTransitionHandle(runID, entry) {
    const numericRunID = toPositiveInteger(runID);
    if (numericRunID <= 0) return null;
    this.#transitionHandlesByRunID.set(numericRunID, entry);
    return entry;
  }

  deleteTransitionHandle(runID) {
    return this.#transitionHandlesByRunID.delete(toPositiveInteger(runID));
  }

  takeTransitionHandle(runID) {
    return this.#takeValue(this.#transitionHandlesByRunID, toPositiveInteger(runID));
  }

  cancelTransitionHandle(runID, clearScheduledTimeout = null) {
    const numericRunID = toPositiveInteger(runID);
    const entry = this.getTransitionHandle(numericRunID);
    if (!entry) return null;
    const handle = entry.handle;
    if (handle !== null && handle !== undefined) {
      if (typeof clearScheduledTimeout !== "function") {
        throw new Error("scheduled timeout cancellation is unavailable");
      }
      clearScheduledTimeout(handle);
    }
    if (this.getTransitionHandle(numericRunID) === entry) {
      this.#transitionHandlesByRunID.delete(numericRunID);
    }
    return entry;
  }

  listTransitionHandles() {
    return [...this.#transitionHandlesByRunID.entries()];
  }

  getParticipantAdmissionHandle(runID, characterID) {
    return this.#participantAdmissionHandlesByKey.get(
      buildParticipantAdmissionKey(runID, characterID),
    ) || null;
  }

  setParticipantAdmissionHandle(runID, characterID, entry) {
    const key = buildParticipantAdmissionKey(runID, characterID);
    if (!key) return null;
    this.#participantAdmissionHandlesByKey.set(key, entry);
    return entry;
  }

  deleteParticipantAdmissionHandle(runID, characterID) {
    return this.#participantAdmissionHandlesByKey.delete(
      buildParticipantAdmissionKey(runID, characterID),
    );
  }

  takeParticipantAdmissionHandle(runID, characterID) {
    return this.#takeValue(
      this.#participantAdmissionHandlesByKey,
      buildParticipantAdmissionKey(runID, characterID),
    );
  }

  cancelParticipantAdmissionHandle(
    runID,
    characterID,
    clearScheduledTimeout = null,
  ) {
    const key = buildParticipantAdmissionKey(runID, characterID);
    const entry = this.#participantAdmissionHandlesByKey.get(key) || null;
    if (!entry) return null;
    const handle = entry.handle;
    if (handle !== null && handle !== undefined) {
      if (typeof clearScheduledTimeout !== "function") {
        throw new Error("scheduled timeout cancellation is unavailable");
      }
      clearScheduledTimeout(handle);
    }
    if (this.#participantAdmissionHandlesByKey.get(key) === entry) {
      this.#participantAdmissionHandlesByKey.delete(key);
    }
    return entry;
  }

  listParticipantAdmissionHandles(runID = 0) {
    const numericRunID = toPositiveInteger(runID);
    const entries = [...this.#participantAdmissionHandlesByKey.entries()];
    if (numericRunID <= 0) return entries;
    const prefix = `${numericRunID}:`;
    return entries.filter(([key]) => key.startsWith(prefix));
  }

  allocateParticipantAdmissionToken() {
    return this.#allocateToken("participantAdmission");
  }

  allocateClientEnvironmentDeliveryToken() {
    return this.#allocateToken("clientEnvironmentDelivery");
  }

  allocateFreshEntryBootstrapToken() {
    return this.#allocateToken("freshEntryBootstrap");
  }

  allocateKSpaceArrivalSessionIdentity() {
    return this.#allocateToken("kSpaceArrivalSessionIdentity");
  }

  hasStaleCleanupSystem(systemID) {
    return this.#staleCleanupSystemIDs.has(toPositiveInteger(systemID));
  }

  markStaleCleanupSystem(systemID) {
    const numericSystemID = toPositiveInteger(systemID);
    if (numericSystemID <= 0) return false;
    this.#staleCleanupSystemIDs.add(numericSystemID);
    return true;
  }

  deleteStaleCleanupSystem(systemID) {
    return this.#staleCleanupSystemIDs.delete(toPositiveInteger(systemID));
  }

  listStaleCleanupSystems() {
    return [...this.#staleCleanupSystemIDs.values()];
  }

  getT0DarkLayoutOverride(characterID) {
    return this.#t0DarkLayoutOverridesByCharacterID.get(
      toPositiveInteger(characterID),
    ) || null;
  }

  setT0DarkLayoutOverride(characterID, override) {
    const numericCharacterID = toPositiveInteger(characterID);
    if (numericCharacterID <= 0) return null;
    this.#t0DarkLayoutOverridesByCharacterID.set(numericCharacterID, override);
    return override;
  }

  deleteT0DarkLayoutOverride(characterID) {
    return this.#t0DarkLayoutOverridesByCharacterID.delete(
      toPositiveInteger(characterID),
    );
  }

  listT0DarkLayoutOverrides() {
    return [...this.#t0DarkLayoutOverridesByCharacterID.entries()];
  }

  getObjectiveDeath(runID, npcID) {
    const deathsByNpcID = this.#objectiveDeathsByRunID.get(toPositiveInteger(runID));
    return deathsByNpcID
      ? deathsByNpcID.get(toPositiveInteger(npcID)) || null
      : null;
  }

  setObjectiveDeath(runID, npcID, event) {
    const numericRunID = toPositiveInteger(runID);
    const numericNpcID = toPositiveInteger(npcID);
    if (numericRunID <= 0 || numericNpcID <= 0) return null;
    let deathsByNpcID = this.#objectiveDeathsByRunID.get(numericRunID);
    if (!deathsByNpcID) {
      deathsByNpcID = new Map();
      this.#objectiveDeathsByRunID.set(numericRunID, deathsByNpcID);
    }
    deathsByNpcID.set(numericNpcID, event);
    return event;
  }

  hasObjectiveDeaths(runID) {
    const deathsByNpcID = this.#objectiveDeathsByRunID.get(toPositiveInteger(runID));
    return Boolean(deathsByNpcID && deathsByNpcID.size > 0);
  }

  deleteObjectiveDeath(runID, npcID) {
    const numericRunID = toPositiveInteger(runID);
    const deathsByNpcID = this.#objectiveDeathsByRunID.get(numericRunID);
    if (!deathsByNpcID) return false;
    const removed = deathsByNpcID.delete(toPositiveInteger(npcID));
    if (deathsByNpcID.size <= 0) this.#objectiveDeathsByRunID.delete(numericRunID);
    return removed;
  }

  clearObjectiveDeaths(runID) {
    const numericRunID = toPositiveInteger(runID);
    const removed = this.listObjectiveDeaths(numericRunID);
    this.#objectiveDeathsByRunID.delete(numericRunID);
    return removed;
  }

  listObjectiveDeaths(runID) {
    const deathsByNpcID = this.#objectiveDeathsByRunID.get(toPositiveInteger(runID));
    return deathsByNpcID ? [...deathsByNpcID.entries()] : [];
  }

  listScheduledHandles(runID = 0) {
    const numericRunID = toPositiveInteger(runID);
    const transitionHandles = this.listTransitionHandles()
      .filter(([candidateRunID]) => numericRunID <= 0 || candidateRunID === numericRunID)
      .map(([candidateRunID, entry]) => ({
        kind: "transition",
        runID: candidateRunID,
        characterID: 0,
        entry,
        handle: entry ? entry.handle : null,
      }));
    const participantAdmissionHandles = this.listParticipantAdmissionHandles(numericRunID)
      .map(([key, entry]) => {
        const [candidateRunID, characterID] = key.split(":").map(Number);
        return {
          kind: "participant-admission",
          runID: candidateRunID,
          characterID,
          entry,
          handle: entry ? entry.handle : null,
        };
      });
    return [...transitionHandles, ...participantAdmissionHandles];
  }

  cancelScheduledHandles(runID = 0, clearScheduledTimeout = null) {
    const scheduledHandles = this.listScheduledHandles(runID);
    const cancelled = [];
    const failures = [];
    for (const scheduled of scheduledHandles) {
      if (
        scheduled.handle !== null &&
        scheduled.handle !== undefined &&
        typeof clearScheduledTimeout !== "function"
      ) {
        failures.push({
          ...scheduled,
          error: new Error("scheduled timeout cancellation is unavailable"),
        });
        continue;
      }
      try {
        if (
          scheduled.handle !== null &&
          scheduled.handle !== undefined &&
          typeof clearScheduledTimeout === "function"
        ) {
          clearScheduledTimeout(scheduled.handle);
        }
      } catch (error) {
        failures.push({ ...scheduled, error });
        continue;
      }

      if (scheduled.kind === "transition") {
        if (this.getTransitionHandle(scheduled.runID) === scheduled.entry) {
          this.#transitionHandlesByRunID.delete(scheduled.runID);
        }
      } else if (scheduled.kind === "participant-admission") {
        if (
          this.getParticipantAdmissionHandle(
            scheduled.runID,
            scheduled.characterID,
          ) === scheduled.entry
        ) {
          this.#participantAdmissionHandlesByKey.delete(
            buildParticipantAdmissionKey(
              scheduled.runID,
              scheduled.characterID,
            ),
          );
        }
      }
      cancelled.push(scheduled);
    }
    return {
      attempted: scheduledHandles,
      cancelled,
      failures,
    };
  }

  cleanupRun(runID, clearScheduledTimeout = null) {
    const numericRunID = toPositiveInteger(runID);
    if (numericRunID <= 0) return this.#emptyRunCleanup(numericRunID);
    const cancellation = this.cancelScheduledHandles(
      numericRunID,
      clearScheduledTimeout,
    );
    const transitionHandle = cancellation.cancelled.find(
      ({ kind }) => kind === "transition",
    );
    const participantAdmissionHandles = cancellation.cancelled
      .filter(({ kind }) => kind === "participant-admission")
      .map(({ runID: cancelledRunID, characterID, entry }) => [
        buildParticipantAdmissionKey(cancelledRunID, characterID),
        entry,
      ]);
    const participantDestructionReceipts =
      this.clearParticipantDestructionReceiptsForRun(numericRunID);
    const objectiveDeaths = this.clearObjectiveDeaths(numericRunID);
    return {
      runID: numericRunID,
      transitionHandle: transitionHandle ? transitionHandle.entry : null,
      participantAdmissionHandles,
      participantDestructionReceipts,
      objectiveDeaths,
      scheduledHandles: cancellation.cancelled,
      failedScheduledHandles: cancellation.failures,
    };
  }

  reset(options = {}) {
    const preserveScheduledHandles = options.preserveScheduledHandles === true;
    const removed = {
      participantDestructionReceipts: this.listParticipantDestructionReceipts(),
      transitionHandles: preserveScheduledHandles ? [] : this.listTransitionHandles(),
      participantAdmissionHandles: preserveScheduledHandles
        ? []
        : this.listParticipantAdmissionHandles(),
      staleCleanupSystemIDs: this.listStaleCleanupSystems(),
      t0DarkLayoutOverrides: this.listT0DarkLayoutOverrides(),
      objectiveDeaths: [...this.#objectiveDeathsByRunID.entries()].map(
        ([runID, deathsByNpcID]) => [runID, [...deathsByNpcID.entries()]],
      ),
      scheduledHandles: preserveScheduledHandles ? [] : this.listScheduledHandles(),
      preservedScheduledHandles: preserveScheduledHandles
        ? this.listScheduledHandles()
        : [],
    };
    this.#participantDestructionReceiptsByOperationID.clear();
    if (!preserveScheduledHandles) {
      this.#transitionHandlesByRunID.clear();
      this.#participantAdmissionHandlesByKey.clear();
    }
    this.#staleCleanupSystemIDs.clear();
    this.#t0DarkLayoutOverridesByCharacterID.clear();
    this.#objectiveDeathsByRunID.clear();
    if (!preserveScheduledHandles) {
      for (const name of TOKEN_NAMES) this.#nextTokens[name] = 1;
    }
    return removed;
  }

  getCounts() {
    let objectiveDeaths = 0;
    for (const deathsByNpcID of this.#objectiveDeathsByRunID.values()) {
      objectiveDeaths += deathsByNpcID.size;
    }
    return {
      participantDestructionReceipts:
        this.#participantDestructionReceiptsByOperationID.size,
      transitionHandles: this.#transitionHandlesByRunID.size,
      participantAdmissionHandles: this.#participantAdmissionHandlesByKey.size,
      staleCleanupSystemIDs: this.#staleCleanupSystemIDs.size,
      t0DarkLayoutOverrides: this.#t0DarkLayoutOverridesByCharacterID.size,
      objectiveDeathRuns: this.#objectiveDeathsByRunID.size,
      objectiveDeaths,
    };
  }

  #allocateToken(name) {
    const token = this.#nextTokens[name];
    this.#nextTokens[name] += 1;
    return token;
  }

  #takeValue(index, key) {
    if (!key || !index.has(key)) return null;
    const value = index.get(key);
    index.delete(key);
    return value;
  }

  #emptyRunCleanup(runID) {
    return {
      runID,
      transitionHandle: null,
      participantAdmissionHandles: [],
      participantDestructionReceipts: [],
      objectiveDeaths: [],
      scheduledHandles: [],
      failedScheduledHandles: [],
    };
  }
}

function createAbyssalPendingWorkRegistry() {
  return new AbyssalPendingWorkRegistry();
}

module.exports = {
  AbyssalPendingWorkRegistry,
  createAbyssalPendingWorkRegistry,
};
