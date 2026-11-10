"use strict";

// The character owner stores a projection of completed gameplay receipts. The
// gateway may read it, but there is no client-facing progress mutation API.
const { EventEmitter } = require("node:events");
const { cloneValue } = require("../../common/clone");
const characters = require("../character/characterState");
const database = require("../../gameStore");
const { getWallclockNowMs } = require("../../space/runtime/runtimeClock");
const catalog = require("./careerCatalog");
const sources = require("./careerGameplaySources");
const { migrateProgress } = require("./careerIdentityMigration");
const events = new EventEmitter();
const activeSyncs = new Set();

function characterID(value) {
  return Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : 0;
}
function empty(definition) {
  return { goalID: definition.id, progress: 0, completedAtMs: 0, source: null };
}
function projectedGoals(record) {
  try { return migrateProgress(record?.careerProgramProgress, catalog.list()).goals; }
  catch (_) { return {}; }
}
function entry(record, definition, goals = projectedGoals(record)) {
  const stored = goals[definition.id];
  if (!stored || stored.goalID !== definition.id || !Number.isSafeInteger(stored.progress) ||
      stored.progress < 0 || stored.progress > definition.target ||
      stored.source?.kind !== definition.source?.kind || typeof stored.source?.id !== "string") return empty(definition);
  return cloneValue(stored);
}
function list(value) {
  const id = characterID(value), record = id && characters.getCharacterRecord(id);
  const goals = record ? projectedGoals(record) : {};
  return record ? catalog.list().map(definition => entry(record, definition, goals)) : [];
}
function get(value, goalID) {
  const definition = catalog.get(goalID), id = characterID(value);
  const record = definition && id && characters.getCharacterRecord(id);
  return record ? entry(record, definition) : null;
}
function flush() {
  try { return database.flushTableSync("characters") || { success: false, errorMsg: "CAREER_PROGRESS_FLUSH_FAILED" }; }
  catch (error) { return { success: false, errorMsg: error.message || "CAREER_PROGRESS_FLUSH_FAILED" }; }
}
function sync(value) {
  const id = characterID(value);
  // Replaying a durable owner outbox may publish a source notice inside this
  // same projection. Only the outer call commits and announces career state.
  if (activeSyncs.has(id)) return { success: true, changed: false, data: list(id) };
  activeSyncs.add(id);
  try { return syncCharacter(id); }
  finally { activeSyncs.delete(id); }
}
function syncCharacter(id) {
  let record = id && characters.getCharacterRecord(id);
  if (!record) return { success: false, errorMsg: "CHARACTER_NOT_FOUND" };
  if (record.careerPendingGateArrival) {
    const recovered = require("./careerExplorationSources").reconcileGateArrival(id);
    if (!recovered?.success) return recovered || { success: false, errorMsg: "CAREER_GATE_RECOVERY_FAILED" };
    record = characters.getCharacterRecord(id);
  }
  const abyssal = require("./careerAbyssalSources").reconcile(id);
  if (!abyssal?.success) return abyssal || { success: false, errorMsg: "CAREER_ABYSSAL_RECOVERY_FAILED" };
  const combat = require("../inventory/careerCombatOutcomes").reconcile(id);
  if (!combat?.success) return combat || { success: false, errorMsg: "CAREER_COMBAT_RECOVERY_FAILED" };
  record = characters.getCharacterRecord(id);
  const definitions = catalog.list();
  let identityMigration;
  try { identityMigration = migrateProgress(record.careerProgramProgress, definitions); }
  catch (error) { return { success: false, errorMsg: error.message }; }
  const context = sources.createContext(id);
  const ownerContext = {};
  const goals = identityMigration.goals, notices = [...identityMigration.migrated];
  let observed = false;
  function project(definition, source) {
    if (!source || !Number.isSafeInteger(source.progress) || source.progress <= 0) return null;
    observed = true;
    const existing = entry(record, definition, goals);
    if (existing.source && existing.source.id !== source.id)
      return { success: false, errorMsg: "CAREER_SOURCE_CONFLICT" };
    // Career completions remain earned when a source owner prunes old receipts
    // or is explicitly reset. Re-reading a lifetime owner never adds it again.
    const progress = Math.max(existing.progress, Math.min(source.progress, definition.target));
    if (progress === existing.progress) return null;
    const next = {
      goalID: definition.id,
      progress,
      completedAtMs: progress >= definition.target
        ? existing.completedAtMs || source.updatedAtMs || Math.max(1, Math.trunc(getWallclockNowMs())) : 0,
      source: { kind: source.kind, id: source.id },
      ...(definition.symbol ? { goalSymbol: definition.symbol } : {}),
    };
    goals[definition.id] = next;
    notices.push(next);
    return null;
  }
  // Finish activities first so a single query can also project graduation. A
  // graduation reward never contributes points toward itself or another tier.
  for (const definition of definitions) {
    if (definition.source?.kind === "career-points") continue;
    const source = ["tutorial-completed", "achievement"].includes(definition.source?.kind)
      ? sources.observe(id, record, definition, context)
      : require("./careerOwnerSources").observe(id, record, definition, ownerContext);
    const failed = project(definition, source);
    if (failed) return failed;
  }
  for (const definition of definitions) {
    if (definition.source?.kind !== "career-points") continue;
    const failed = project(definition, sources.careerPoints(id, definition, definitions, goals));
    if (failed) return failed;
  }
  if (!observed && !notices.length) return { success: true, changed: false, data: list(id) };
  if (notices.length) {
    const written = characters.updateCharacterRecord(id, current => ({ ...current,
      careerProgramProgress: { version: 2, goals },
    }));
    if (!written?.success) return written || { success: false, errorMsg: "CAREER_PROGRESS_WRITE_FAILED" };
  }
  // A matching cached projection cannot acknowledge an earlier failed flush.
  const durable = flush();
  if (!durable.success) {
    if (notices.length) {
      const rollback = characters.updateCharacterRecord(id, () => record);
      if (!rollback?.success) return { success: false, ambiguous: true, errorMsg: "CAREER_PROGRESS_ROLLBACK_FAILED" };
    }
    return durable;
  }
  for (const notice of new Map(notices.map(row => [row.goalID, row])).values())
    events.emit("progressed", { characterID: id, ...cloneValue(notice) });
  return { success: true, changed: notices.length > 0, data: list(id) };
}

module.exports = { events, sync, get, list };
