"use strict";
// Plain persisted payload validation. No live scene, data or service imports:
// inventory can retain this domain-owned record without an ownership cycle.
const object = (value) => value && typeof value === "object" && !Array.isArray(value);
const finite = (value) => Number.isFinite(value);
const positiveID = (value) => Number.isSafeInteger(value) && value > 0;
function validApplication(app) {
  return Boolean(object(app) && object(app.source) && positiveID(app.source.itemID) && positiveID(app.source.typeID) &&
    positiveID(app.moduleID) && positiveID(app.moduleTypeID) && positiveID(app.chargeTypeID) &&
    [app.startedAtMs, app.expiresAtMs, app.flat, app.percentage].every(finite) &&
    app.expiresAtMs > app.startedAtMs && app.flat > 0 && app.percentage > 0);
}
function normalizeBreacherPodRuntimeRecord(record) {
  if (!object(record) || record.version !== 1 || !positiveID(record.targetID) ||
      typeof record.sceneKey !== "string" || !record.sceneKey || !object(record.scope) ||
      !finite(record.savedAtMs) || !finite(record.nextTickInMs) || record.nextTickInMs > 1000 ||
      !Array.isArray(record.applications) || !record.applications.every((app) => validApplication(app) &&
        finite(app.startedAgoMs) && app.startedAgoMs >= 0 && finite(app.remainingMs) &&
        // An overdue due time (nextTickInMs < 0) keeps the applications still
        // owed its tick, whose expiry may have passed by as much.
        app.remainingMs >= Math.min(0, record.nextTickInMs) &&
        app.remainingMs <= app.expiresAtMs - app.startedAtMs)) return null;
  if (record.pendingKill && (!object(record.pendingKill) || !validApplication(record.pendingKill.application) ||
      !finite(record.pendingKill.atMs) || !finite(record.pendingKill.amount) || record.pendingKill.amount <= 0)) return null;
  return structuredClone(record);
}
module.exports = { validApplication, normalizeBreacherPodRuntimeRecord };
