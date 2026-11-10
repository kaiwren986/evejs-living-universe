"use strict";
const incursionClock = require("./incursionClock");

const { createDurableSchedulerBinding } = require("../_shared/durableSchedulerBinding");
const { isDeadLetteredJob } = require("../scheduler/scheduledJobStates");
const JOB_TYPE = "incursion.lifecycle";
function jobID(boundary) {
  if (boundary.kind === "focus") return `incursion-focus:${boundary.configurationID}:${boundary.slotID}:g${boundary.generation}:r${boundary.revision}:${boundary.dueAtMs}`;
  return `incursion-lifecycle:${boundary.taleID}:g${boundary.generation}:r${boundary.revision}:${boundary.kind}:${boundary.dueAtMs}${boundary.kind === "site" ? `:${boundary.slotID}:${boundary.incarnation}` : ""}`;
}

function createIncursionLifecycleScheduler(options = {}) {
  const lifecycle = options.lifecycle || require("./incursionLifecycle");
  const focuses = options.focusRuntime || (!options.lifecycle ? require("./incursionFocusRuntime") : null);
  const log = options.log || require("../../utils/logger");
  const now = options.now || (() => incursionClock.now());
  let epoch = 0, unsubscribe = null, unsubscribeFocus = null, lane = Promise.resolve();
  const pending = new Set(), deliveries = new Set();
  const binding = createDurableSchedulerBinding({ requires: ["schedule", "cancel", "list"],
    beforeBind() { epoch++; unsubscribe?.(); unsubscribeFocus?.(); },
    afterBind() { unsubscribe = lifecycle.subscribe(recoverPending); unsubscribeFocus = focuses?.subscribe(recoverPending); },
    afterUnbind() { epoch++; unsubscribe?.(); unsubscribeFocus?.(); unsubscribe = null; unsubscribeFocus = null; },
  });

  function reconcile({ startup = false, runningJobID = "" } = {}) {
    const scheduler = binding.get(), generation = epoch;
    if (!scheduler) return Promise.resolve({ scheduled: 0, bound: false });
    const current = () => scheduler === binding.get() && generation === epoch;
    const work = lane.catch(() => null).then(async () => {
      if (!current()) return { scheduled: 0, bound: false };
      if (startup) focuses?.initializeOrganic();
      focuses?.reconcile();
      // Projection recovery belongs to the same world owner and startup pass.
      // An injected lifecycle used by isolated scheduler tests has its own scope.
      if (!options.lifecycle) {
        require("./incursionSiteRuntime").reconcile({ nowMs: now() });
        require("./incursionFinalSiteRuntime").reconcile({ nowMs: now() });
        require("./incursionProjectionRuntime").reconcile();
        focuses?.reconcile();
      }
      const existing = (await scheduler.list()).filter(job => job.type === JOB_TYPE);
      if (!current()) return { scheduled: 0, bound: false };
      const boundaries = [...lifecycle.listBoundaries(), ...(focuses?.listBoundaries() || [])];
      const desired = new Set(boundaries.map(jobID));
      let scheduled = 0;
      for (const boundary of boundaries) {
        const id = jobID(boundary), found = existing.find(job => job.jobID === id);
        if (id === runningJobID) continue;
        // Normal reconciliation preserves retries/dead letters. Only an explicit
        // startup pass revives exhausted work, once per owner startup.
        if (!found || (startup && isDeadLetteredJob(found))) {
          await scheduler.schedule({ jobID: id, type: JOB_TYPE, dueAtMs: boundary.dueAtMs, payload: boundary });
          if (!current()) return { scheduled, bound: false };
          scheduled++;
        }
      }
      for (const job of existing) {
        if (!desired.has(job.jobID) && job.jobID !== runningJobID && !deliveries.has(job.jobID)) {
          await scheduler.cancel(job.jobID);
          if (!current()) return { scheduled, bound: false };
        }
      }
      return { scheduled, bound: true };
    });
    lane = work;
    pending.add(work);
    work.then(() => pending.delete(work), () => pending.delete(work));
    return work;
  }

  function recoverPending() {
    if (!binding.get()) return false;
    void reconcile().catch(error => log.warn(`[Incursion] Lifecycle scheduling pending: ${error.message}`));
    return true;
  }

  async function handleJob(job) {
    if (job?.type !== JOB_TYPE || !job.payload || job.jobID !== jobID(job.payload)) return { applied: false, reason: "foreign-job" };
    deliveries.add(job.jobID);
    try {
      const result = job.payload.kind === "focus"
        ? focuses?.advanceBoundary(job.payload, now()) || { applied: false, reason: "disabled" }
        : job.payload.kind === "terminal"
        ? await (options.terminalRuntime || require("./incursionTerminalRuntime")).reconcileTale(job.payload, now())
        : lifecycle.advanceBoundary(job.payload, now());
      if (result.reason === "early") throw new Error("INCURSION_BOUNDARY_NOT_DUE");
      // Never reuse the current job ID for next work: its lease ACK must not
      // erase the next boundary, even when multiple deadlines passed offline.
      await reconcile({ runningJobID: job.jobID });
      return result;
    } finally { deliveries.delete(job.jobID); }
  }

  async function idle() {
    while (pending.size || deliveries.size) {
      if (pending.size) await Promise.allSettled([...pending]);
      else await new Promise(resolve => setImmediate(resolve));
    }
  }

  return { JOB_TYPE, reconcile, recoverPending, handleJob, idle, jobID,
    bindDurableScheduler: binding.bind, unbindDurableScheduler: binding.unbind };
}

module.exports = { ...createIncursionLifecycleScheduler(), createIncursionLifecycleScheduler };
