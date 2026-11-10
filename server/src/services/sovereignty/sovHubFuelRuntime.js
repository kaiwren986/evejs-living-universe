"use strict";

const modern = require("./sovModernState");
const { createDurableSchedulerBinding } = require("../_shared/durableSchedulerBinding");
const log = require("../../utils/logger");
const { getWallclockNowMs } = require("../../space/runtime/runtimeClock");

const DURABLE_FUEL_JOB_TYPE = "sovereignty.hub-fuel";
const JOB_ID = "sovereignty:hub-fuel";
const JOB_IDS = [`${JOB_ID}:0`, `${JOB_ID}:1`];
const binding = createDurableSchedulerBinding({ requires: ["schedule", "cancel"] });
const admissions = new Set();
let closing = false;
let reconciling = false;
let nextJobIndex = 0;

async function schedule() {
  const scheduler = binding.get();
  if (!scheduler || closing || reconciling) return;
  // Keep a durable wake-up even while every Hub is idle. If scheduling a newly
  // activated Hub fails after its owner write commits, this existing job still
  // discovers it; a transient admission failure cannot stop upkeep forever.
  const dueAtMs = modern.getHubFuelNextDueAtMs() ?? getWallclockNowMs() + 60_000;
  return scheduler.schedule({ jobID: JOB_IDS[nextJobIndex], type: DURABLE_FUEL_JOB_TYPE, dueAtMs, payload: {} });
}

function kick() {
  if (!binding.get() || closing || reconciling) return;
  const admission = Promise.resolve().then(schedule).catch((error) => {
    log.warn(`[SovHubFuel] scheduling failed: ${error.message}`);
  });
  admissions.add(admission);
  void admission.finally(() => admissions.delete(admission));
}

function bindDurableScheduler(scheduler) {
  closing = false;
  binding.bind(scheduler);
  modern.registerHubFuelSchedulePublisher(kick);
  return true;
}

function unbindDurableScheduler(scheduler) {
  const unbound = binding.unbind(scheduler);
  if (unbound) modern.registerHubFuelSchedulePublisher(null);
  return unbound;
}

async function reconcileDurableFuel(options = {}) {
  // Wall-clock catch-up deliberately includes downtime. The same persistent
  // cursor handles ordinary ticks, graceful restarts and abrupt crashes, so a
  // restart cannot discard a partly consumed hour or grant free startup.
  reconciling = true;
  try {
    await Promise.allSettled([...admissions]);
    const scheduler = binding.get();
    if (scheduler) {
      // Startup replaces the old fixed-ID job and both possible alternating
      // slots. A running old delivery is harmless: settlement is idempotent,
      // and handleDurableFuel does not admit successors during reconciliation.
      for (const jobID of [JOB_ID, ...JOB_IDS]) await scheduler.cancel(jobID);
    }
    nextJobIndex = 0;
    const summary = modern.settleAllHubFuel(options);
    reconciling = false;
    await schedule();
    return summary;
  } finally { reconciling = false; }
}

async function handleDurableFuel(job = {}) {
  if (reconciling || closing) return { hubs: 0, changed: 0 };
  // The next tick must have a different ID so dispatch can acknowledge this
  // successful tick. Replacing the running ID keeps its attempt counter and
  // eventually spends the retry budget on successful recurring executions.
  const currentIndex = JOB_IDS.indexOf(String(job.jobID || ""));
  const summary = modern.settleAllHubFuel();
  nextJobIndex = currentIndex >= 0 ? 1 - currentIndex : 1 - nextJobIndex;
  await schedule();
  return summary;
}

async function shutdown() {
  closing = true;
  modern.settleAllHubFuel();
  await Promise.allSettled([...admissions]);
}

module.exports = { DURABLE_FUEL_JOB_TYPE, bindDurableScheduler, unbindDurableScheduler,
  reconcileDurableFuel, handleDurableFuel, shutdown };
