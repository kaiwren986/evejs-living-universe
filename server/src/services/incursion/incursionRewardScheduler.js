"use strict";
const incursionClock = require("./incursionClock");

const { createHash } = require("node:crypto");
const { createDurableSchedulerBinding } = require("../_shared/durableSchedulerBinding");
const { isDeadLetteredJob } = require("../scheduler/scheduledJobStates");

const JOB_TYPE = "incursion.reward-settlement";

function createIncursionRewardScheduler(options = {}) {
  const store = options.store || require("./incursionRewardStore");
  const rewards = options.rewards || require("./incursionRewards");
  const log = options.log || require("../../utils/logger");
  const now = options.now || incursionClock.now;
  const binding = createDurableSchedulerBinding();
  let enqueuing = null;
  let requested = false;
  const deliveries = new Set();

  function recoveryKeys() {
    const keys = [];
    for (const [characterID, pending] of Object.entries(store.read("/pending") || {})) {
      for (const legID of Object.keys(pending || {})) keys.push(`leg:${characterID}:${legID}`);
    }
    // Money can already be acknowledged when a crash interrupts LP history.
    for (const [releaseID, release] of Object.entries(store.read("/releases") || {})) {
      for (const participant of Object.values(release.participants || {})) {
        if (!participant.historyPublished) keys.push(`history:${releaseID}:${participant.characterID}`);
      }
    }
    return keys.sort();
  }

  function jobID(workKey) {
    return `incursion-reward:${createHash("sha256").update(workKey).digest("hex")}`;
  }

  async function schedulePass(scheduler) {
    const keys = recoveryKeys();
    if (!keys.length) return 0;
    const existing = typeof scheduler.list === "function" ? await scheduler.list() : [];
    const armed = new Set(existing.filter(job => job.type === JOB_TYPE && !isDeadLetteredJob(job))
      .map(job => job.jobID));
    let scheduled = 0;
    for (const workKey of keys) {
      if (binding.get() !== scheduler) break;
      const id = jobID(workKey);
      if (armed.has(id)) continue;
      // Each frozen command has its own ID. Work arriving while an earlier
      // handler finishes cannot be erased by that earlier job's lease ACK.
      await scheduler.schedule({ jobID: id, type: JOB_TYPE, dueAtMs: now(), payload: { workKey } });
      scheduled++;
    }
    return scheduled;
  }

  function reconcile() {
    const scheduler = binding.get();
    if (!scheduler) return Promise.resolve({ scheduled: 0, bound: false });
    requested = true;
    if (enqueuing) return enqueuing;
    enqueuing = Promise.resolve().then(async () => {
      let scheduled = 0;
      while (requested && binding.get() === scheduler) {
        requested = false;
        scheduled += await schedulePass(scheduler);
      }
      return { scheduled, bound: binding.get() === scheduler };
    }).finally(() => { enqueuing = null; });
    return enqueuing;
  }

  // Encounter reducers call this after their durable seal. Scheduling failure
  // cannot roll back a completed site or become an unhandled rejection; startup
  // and subsequent ticks can arm the same persisted commands again.
  function recoverPending() {
    if (!binding.get()) return false;
    reconcile().catch(error => log.warn(`[Incursion] Reward scheduling pending: ${error.message}`));
    return true;
  }

  function handleJob() {
    const delivery = Promise.resolve().then(() => rewards.recoverPending());
    deliveries.add(delivery);
    delivery.then(() => deliveries.delete(delivery), () => deliveries.delete(delivery));
    return delivery;
  }

  async function idle() {
    for (;;) {
      const pending = [enqueuing, ...deliveries].filter(Boolean);
      if (!pending.length) return;
      await Promise.allSettled(pending);
    }
  }

  return { JOB_TYPE, reconcile, recoverPending, enqueuePending: recoverPending, handleJob, idle,
    bindDurableScheduler: binding.bind, unbindDurableScheduler: binding.unbind };
}

module.exports = { ...createIncursionRewardScheduler(), createIncursionRewardScheduler };
