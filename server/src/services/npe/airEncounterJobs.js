"use strict";

const characters = require("../character/characterState");
const { createDurableSchedulerBinding } = require("../_shared/durableSchedulerBinding");
const { cloneValue } = require("../../common/clone");
const { graphError } = require("../nodegraph/nodeGraphCompiler");
const JOB_TYPE = "air.encounter";
const binding = createDurableSchedulerBinding({ requires: ["schedule", "cancel"] });
const pending = new Set(), lanes = new Map();
let now = Date.now, handler, recoverAccepted;
function ok(result) { if (!result?.success) throw graphError("AIR_ENCOUNTER_WRITE_FAILED", result?.errorMsg); return result; }
function state(characterID) { return characters.getCharacterRecord(characterID)?.authoredAirTutorial; }
function update(characterID, mutate) {
  const previous = cloneValue(state(characterID));
  try {
    ok(characters.updateCharacterRecord(characterID, record => ({ ...record, authoredAirTutorial: mutate(cloneValue(record.authoredAirTutorial)) })));
    ok(require("../../gameStore").flushTableSync("characters"));
  } catch (error) {
    ok(characters.updateCharacterRecord(characterID, record => ({ ...record, authoredAirTutorial: previous })));
    throw error;
  }
}
function jobID(characterID, runID, key) { return `air:${characterID}:${runID}:${key}`; }
async function schedule(characterID, key) {
  const current = state(characterID), job = current?.encounter?.jobs?.[key];
  if (!job || !["pending", "ready"].includes(job.status) || current.status !== "active" && !job.critical) return;
  if (!binding.get()) throw graphError("AIR_ENCOUNTER_SCHEDULER_REQUIRED");
  await binding.get().schedule({ jobID: jobID(characterID, current.runID, key), type: JOB_TYPE,
    dueAtMs: Math.max(job.status === "ready" ? now() : job.dueAtMs, job.nextAttemptAtMs || 0), payload: { characterID, runID: current.runID, key } });
}
async function enqueue(characterID, key, delayMs, context, dueAtMs = now() + delayMs) {
  const previous = state(characterID)?.encounter?.jobs?.[key];
  if (!previous) update(characterID, current => {
    current.encounter.jobs ||= {};
    if (Object.keys(current.encounter.jobs).length >= 128) throw graphError("AIR_ENCOUNTER_JOB_LIMIT");
    current.encounter.jobs[key] = { ...cloneValue(context), dueAtMs, status: "pending" }; return current;
  });
  await schedule(characterID, key);
}
async function handle(job) {
  const { characterID, runID, key } = job.payload || {};
  const current = state(characterID), entry = current?.encounter?.jobs?.[key];
  if (current?.runID !== runID || !entry || current.status !== "active" && !entry.critical || !["pending", "ready"].includes(entry.status)) return { success: true, stale: true };
  if (entry.status === "pending" && entry.dueAtMs > now()) { await schedule(characterID, key); return { success: true, early: true }; }
  const session = require("../chat/sessionRegistry").findSessionByCharacterID(characterID);
  if ((!session || session.socket?.destroyed) && !entry.critical) {
    update(characterID, value => { value.encounter.jobs[key].status = "ready"; return value; });
    return { success: true, offline: true };
  }
  if (!handler) throw graphError("AIR_ENCOUNTER_HANDLER_REQUIRED");
  const result = await handler(session?.socket?.destroyed ? null : session, key, entry);
  if (result?.success === false) throw graphError("AIR_ENCOUNTER_ACTION_FAILED", result.errorMsg);
  if (result?.deferred) {
    update(characterID, value => { value.encounter.jobs[key].status = "ready"; return value; });
    return { success: true, deferred: true };
  }
  if (result?.retry) {
    update(characterID, value => { value.encounter.jobs[key].nextAttemptAtMs = now() + 1000; return value; });
    await schedule(characterID, key); return { success: true, retry: true };
  }
  update(characterID, value => {
    if ((value.status === "active" || entry.critical) && value.runID === runID && ["pending", "ready"].includes(value.encounter.jobs[key]?.status)) value.encounter.jobs[key].status = result?.stale ? "cancelled" : "complete";
    return value;
  });
  return { success: true };
}
function handleJob(job) {
  const id = Number(job.payload?.characterID), prior = lanes.get(id) || Promise.resolve();
  const work = prior.catch(() => {}).then(() => handle(job)); lanes.set(id, work); pending.add(work);
  work.then(() => { pending.delete(work); if (lanes.get(id) === work) lanes.delete(id); }, () => { pending.delete(work); if (lanes.get(id) === work) lanes.delete(id); });
  return work;
}
async function resume(characterID) {
  for (const key of Object.keys(state(characterID)?.encounter?.jobs || {})) await schedule(characterID, key);
}
async function cancel(characterID) {
  const current = state(characterID); if (!current?.encounter) return;
  update(characterID, value => { for (const entry of Object.values(value.encounter.jobs || {})) if (!entry.critical && ["pending", "ready"].includes(entry.status)) entry.status = "cancelled"; return value; });
  if (binding.get()) for (const [key, entry] of Object.entries(current.encounter.jobs || {})) if (!entry.critical) await binding.get().cancel(jobID(characterID, current.runID, key));
}
async function reconcile() {
  const records = require("../../gameStore").read("characters", "/").data || {};
  for (const [key, record] of Object.entries(records)) if (record.authoredAirTutorial?.encounter) {
    const characterID = Number(record.characterID || key);
    if (recoverAccepted) await recoverAccepted(characterID);
    await resume(characterID);
  }
}
async function flushPending() { while (pending.size) await Promise.allSettled([...pending]); }
module.exports = { JOB_TYPE, enqueue, resume, cancel, reconcile, handleJob, flushPending, update, state,
  registerHandler(callback) { handler = callback; }, now: () => now(), setNowProvider(provider) { now = provider || Date.now; },
  registerRecovery(callback) { recoverAccepted = callback; },
  bindDurableScheduler: binding.bind, unbindDurableScheduler: binding.unbind };
