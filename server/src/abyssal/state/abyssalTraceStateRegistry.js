"use strict";

function toPositiveInteger(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  const integer = Math.trunc(numeric);
  return integer > 0 ? integer : 0;
}

function getTraceItemID(traceState) {
  return toPositiveInteger(traceState && traceState.traceItemID);
}

function getCharacterID(traceState) {
  return toPositiveInteger(traceState && traceState.characterID);
}

function cancelSchedule(schedule, clearScheduledTimeout) {
  if (
    !schedule ||
    schedule.handle === null ||
    schedule.handle === undefined
  ) {
    return;
  }
  if (typeof clearScheduledTimeout !== "function") {
    throw new Error("trace timer cancellation is unavailable");
  }
  clearScheduledTimeout(schedule.handle);
}

class AbyssalTraceStateRegistry {
  #traceStatesByTraceID = new Map();
  #traceIDsByCharacterID = new Map();
  #pendingDeploymentsByCharacterID = new Set();
  #pendingActivationsByTraceID = new Map();
  #removalSchedulesByTraceID = new Map();
  #createdExpirySchedulesByTraceID = new Map();

  registerTrace(traceState, options = {}) {
    const traceItemID = getTraceItemID(traceState);
    if (traceItemID <= 0) return null;

    const previousState = this.#traceStatesByTraceID.get(traceItemID) || null;
    const previousCharacterID = getCharacterID(previousState);
    const characterID = getCharacterID(traceState);
    const ownsCharacterLock = options.ownsCharacterLock === true;
    const storedState = { ...traceState, traceItemID };

    if (
      previousCharacterID > 0 &&
      previousCharacterID !== characterID &&
      this.#traceIDsByCharacterID.get(previousCharacterID) === traceItemID
    ) {
      this.#traceIDsByCharacterID.delete(previousCharacterID);
    }

    this.#traceStatesByTraceID.set(traceItemID, storedState);
    if (characterID > 0 && ownsCharacterLock) {
      this.#traceIDsByCharacterID.set(characterID, traceItemID);
    } else if (
      characterID > 0 &&
      this.#traceIDsByCharacterID.get(characterID) === traceItemID
    ) {
      this.#traceIDsByCharacterID.delete(characterID);
    }
    return storedState;
  }

  removeTrace(traceItemID) {
    const numericTraceItemID = toPositiveInteger(traceItemID);
    const traceState = this.#traceStatesByTraceID.get(numericTraceItemID) || null;
    if (!traceState) return null;

    this.#traceStatesByTraceID.delete(numericTraceItemID);
    const characterID = getCharacterID(traceState);
    if (
      characterID > 0 &&
      this.#traceIDsByCharacterID.get(characterID) === numericTraceItemID
    ) {
      this.#traceIDsByCharacterID.delete(characterID);
    }
    return traceState;
  }

  hasTrace(traceItemID) {
    return this.#traceStatesByTraceID.has(toPositiveInteger(traceItemID));
  }

  getTrace(traceItemID) {
    return this.#traceStatesByTraceID.get(toPositiveInteger(traceItemID)) || null;
  }

  getTraceIDForCharacter(characterID) {
    return this.#traceIDsByCharacterID.get(toPositiveInteger(characterID)) || 0;
  }

  getTraceForCharacter(characterID) {
    const traceItemID = this.getTraceIDForCharacter(characterID);
    return traceItemID > 0 ? this.getTrace(traceItemID) : null;
  }

  listTraces() {
    return [...this.#traceStatesByTraceID.values()];
  }

  findTrace(predicate) {
    if (typeof predicate !== "function") return null;
    for (const traceState of this.#traceStatesByTraceID.values()) {
      if (predicate(traceState)) return traceState;
    }
    return null;
  }

  hasPendingDeployment(characterID) {
    return this.#pendingDeploymentsByCharacterID.has(
      toPositiveInteger(characterID),
    );
  }

  beginPendingDeployment(characterID) {
    const numericCharacterID = toPositiveInteger(characterID);
    if (
      numericCharacterID <= 0 ||
      this.#pendingDeploymentsByCharacterID.has(numericCharacterID)
    ) {
      return false;
    }
    this.#pendingDeploymentsByCharacterID.add(numericCharacterID);
    return true;
  }

  endPendingDeployment(characterID) {
    return this.#pendingDeploymentsByCharacterID.delete(
      toPositiveInteger(characterID),
    );
  }

  getPendingActivation(traceItemID) {
    return this.#pendingActivationsByTraceID.get(
      toPositiveInteger(traceItemID),
    ) || null;
  }

  setPendingActivation(traceItemID, record) {
    const numericTraceItemID = toPositiveInteger(traceItemID);
    if (numericTraceItemID <= 0 || !record || typeof record !== "object") {
      return null;
    }
    this.#pendingActivationsByTraceID.set(numericTraceItemID, record);
    return record;
  }

  pendingActivationIsCurrent(traceItemID, record) {
    return Boolean(
      record && this.getPendingActivation(traceItemID) === record,
    );
  }

  deletePendingActivation(traceItemID) {
    const numericTraceItemID = toPositiveInteger(traceItemID);
    const record = this.#pendingActivationsByTraceID.get(numericTraceItemID) || null;
    this.#pendingActivationsByTraceID.delete(numericTraceItemID);
    return record;
  }

  clearPendingActivation(traceItemID, clearPendingActivation = null) {
    const numericTraceItemID = toPositiveInteger(traceItemID);
    const record = this.getPendingActivation(numericTraceItemID);
    if (record && typeof clearPendingActivation === "function") {
      clearPendingActivation(record);
    } else {
      cancelSchedule(record, null);
    }
    if (this.getPendingActivation(numericTraceItemID) === record) {
      this.#pendingActivationsByTraceID.delete(numericTraceItemID);
    }
    return record;
  }

  listPendingActivations() {
    return [...this.#pendingActivationsByTraceID.values()];
  }

  findPendingActivation(predicate) {
    if (typeof predicate !== "function") return null;
    for (const record of this.#pendingActivationsByTraceID.values()) {
      if (predicate(record)) return record;
    }
    return null;
  }

  hasRemovalSchedule(traceItemID) {
    return this.#removalSchedulesByTraceID.has(
      toPositiveInteger(traceItemID),
    );
  }

  getRemovalSchedule(traceItemID) {
    return this.#removalSchedulesByTraceID.get(
      toPositiveInteger(traceItemID),
    ) || null;
  }

  setRemovalSchedule(traceItemID, schedule) {
    const numericTraceItemID = toPositiveInteger(traceItemID);
    if (numericTraceItemID <= 0 || !schedule || typeof schedule !== "object") {
      return null;
    }
    this.#removalSchedulesByTraceID.set(numericTraceItemID, schedule);
    return schedule;
  }

  listRemovalSchedules() {
    return [...this.#removalSchedulesByTraceID.values()];
  }

  deleteRemovalSchedule(traceItemID) {
    const numericTraceItemID = toPositiveInteger(traceItemID);
    const schedule = this.#removalSchedulesByTraceID.get(numericTraceItemID) || null;
    this.#removalSchedulesByTraceID.delete(numericTraceItemID);
    return schedule;
  }

  takeRemovalScheduleIfCurrent(traceItemID, expectedSchedule) {
    const numericTraceItemID = toPositiveInteger(traceItemID);
    const schedule = this.getRemovalSchedule(numericTraceItemID);
    if (!schedule || schedule !== expectedSchedule) return null;
    this.#removalSchedulesByTraceID.delete(numericTraceItemID);
    return schedule;
  }

  clearRemovalSchedule(traceItemID, clearScheduledTimeout = null) {
    const numericTraceItemID = toPositiveInteger(traceItemID);
    const schedule = this.getRemovalSchedule(numericTraceItemID);
    cancelSchedule(schedule, clearScheduledTimeout);
    if (this.getRemovalSchedule(numericTraceItemID) === schedule) {
      this.#removalSchedulesByTraceID.delete(numericTraceItemID);
    }
    return schedule;
  }

  hasCreatedExpirySchedule(traceItemID) {
    return this.#createdExpirySchedulesByTraceID.has(
      toPositiveInteger(traceItemID),
    );
  }

  getCreatedExpirySchedule(traceItemID) {
    return this.#createdExpirySchedulesByTraceID.get(
      toPositiveInteger(traceItemID),
    ) || null;
  }

  setCreatedExpirySchedule(traceItemID, schedule) {
    const numericTraceItemID = toPositiveInteger(traceItemID);
    if (numericTraceItemID <= 0 || !schedule || typeof schedule !== "object") {
      return null;
    }
    this.#createdExpirySchedulesByTraceID.set(numericTraceItemID, schedule);
    return schedule;
  }

  listCreatedExpirySchedules() {
    return [...this.#createdExpirySchedulesByTraceID.values()];
  }

  deleteCreatedExpirySchedule(traceItemID) {
    const numericTraceItemID = toPositiveInteger(traceItemID);
    const schedule = this.#createdExpirySchedulesByTraceID.get(numericTraceItemID) || null;
    this.#createdExpirySchedulesByTraceID.delete(numericTraceItemID);
    return schedule;
  }

  takeCreatedExpiryScheduleIfCurrent(traceItemID, expectedSchedule) {
    const numericTraceItemID = toPositiveInteger(traceItemID);
    const schedule = this.getCreatedExpirySchedule(numericTraceItemID);
    if (!schedule || schedule !== expectedSchedule) return null;
    this.#createdExpirySchedulesByTraceID.delete(numericTraceItemID);
    return schedule;
  }

  clearCreatedExpirySchedule(traceItemID, clearScheduledTimeout = null) {
    const numericTraceItemID = toPositiveInteger(traceItemID);
    const schedule = this.getCreatedExpirySchedule(numericTraceItemID);
    cancelSchedule(schedule, clearScheduledTimeout);
    if (this.getCreatedExpirySchedule(numericTraceItemID) === schedule) {
      this.#createdExpirySchedulesByTraceID.delete(numericTraceItemID);
    }
    return schedule;
  }

  getDiagnostics() {
    return {
      traceCount: this.#traceStatesByTraceID.size,
      characterIndexCount: this.#traceIDsByCharacterID.size,
      pendingDeploymentCount: this.#pendingDeploymentsByCharacterID.size,
      pendingActivationCount: this.#pendingActivationsByTraceID.size,
      removalScheduleCount: this.#removalSchedulesByTraceID.size,
      createdExpiryScheduleCount: this.#createdExpirySchedulesByTraceID.size,
    };
  }

  cleanupTrace(traceItemID, options = {}) {
    const numericTraceItemID = toPositiveInteger(traceItemID);
    const clearPendingActivation = typeof options.clearPendingActivation === "function"
      ? options.clearPendingActivation
      : null;
    const clearScheduledTimeout = typeof options.clearScheduledTimeout === "function"
      ? options.clearScheduledTimeout
      : null;
    const pendingActivationCanceller = clearPendingActivation || (
      clearScheduledTimeout
        ? (record) => cancelSchedule(record, clearScheduledTimeout)
        : null
    );
    const cancellationErrors = [];
    const attemptCancellation = (cancel) => {
      try {
        cancel();
      } catch (error) {
        cancellationErrors.push(error);
      }
    };
    attemptCancellation(() => this.clearPendingActivation(
      numericTraceItemID,
      pendingActivationCanceller,
    ));
    attemptCancellation(() => this.clearCreatedExpirySchedule(
      numericTraceItemID,
      clearScheduledTimeout,
    ));
    attemptCancellation(() => this.clearRemovalSchedule(
      numericTraceItemID,
      clearScheduledTimeout,
    ));
    const traceState = this.removeTrace(numericTraceItemID);
    if (cancellationErrors.length > 0) {
      throw new AggregateError(
        cancellationErrors,
        "one or more Abyssal Trace timers could not be cancelled during cleanup",
      );
    }
    return traceState;
  }

  reset(options = {}) {
    const clearPendingActivation = typeof options.clearPendingActivation === "function"
      ? options.clearPendingActivation
      : null;
    const clearScheduledTimeout = typeof options.clearScheduledTimeout === "function"
      ? options.clearScheduledTimeout
      : null;
    const cleared = this.getDiagnostics();
    const cancellationErrors = [];

    const attemptCancellation = (cancel) => {
      try {
        cancel();
      } catch (error) {
        cancellationErrors.push(error);
      }
    };

    for (const [traceItemID, record] of this.#pendingActivationsByTraceID.entries()) {
      attemptCancellation(() => {
        if (clearPendingActivation) {
          clearPendingActivation(record);
        } else {
          cancelSchedule(record, clearScheduledTimeout);
        }
        if (this.#pendingActivationsByTraceID.get(traceItemID) === record) {
          this.#pendingActivationsByTraceID.delete(traceItemID);
        }
      });
    }
    for (const [traceItemID, schedule] of this.#removalSchedulesByTraceID.entries()) {
      attemptCancellation(() => {
        cancelSchedule(schedule, clearScheduledTimeout);
        if (this.#removalSchedulesByTraceID.get(traceItemID) === schedule) {
          this.#removalSchedulesByTraceID.delete(traceItemID);
        }
      });
    }
    for (const [traceItemID, schedule] of this.#createdExpirySchedulesByTraceID.entries()) {
      attemptCancellation(() => {
        cancelSchedule(schedule, clearScheduledTimeout);
        if (this.#createdExpirySchedulesByTraceID.get(traceItemID) === schedule) {
          this.#createdExpirySchedulesByTraceID.delete(traceItemID);
        }
      });
    }

    this.#traceStatesByTraceID.clear();
    this.#traceIDsByCharacterID.clear();
    this.#pendingDeploymentsByCharacterID.clear();
    if (cancellationErrors.length > 0) {
      throw new AggregateError(
        cancellationErrors,
        "one or more Abyssal Trace timers could not be cancelled during reset",
      );
    }
    return cleared;
  }
}

module.exports = {
  AbyssalTraceStateRegistry,
};
