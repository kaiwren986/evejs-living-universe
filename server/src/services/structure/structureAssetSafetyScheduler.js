"use strict";

// The durable worker owns the clock/jobs; this adapter and wrap authority run
// in the world process. No loaded solar-system scene or client polling needed.
const { createDurableSchedulerBinding } = require("../_shared/durableSchedulerBinding");
const state = require("./structureAssetSafetyState");
const log = require("../../utils/logger");

const JOB_TYPE = "structure.asset-safety";
const JOB_PREFIX = "asset-safety:";
const DAY_MS = 24 * 60 * 60 * 1000;
const binding = createDurableSchedulerBinding({ requires: ["schedule", "cancel", "list"] });
const lanes = new Map();
const knownJobs = new Map();
const runningJobs = new Map();
let bindingGeneration = 0;

function check(result) {
  if (!result || result.success !== true) {
    throw new Error(result && result.errorMsg || "ASSET_SAFETY_WORK_FAILED");
  }
  return result;
}

function buildJob(wrap) {
  if (!wrap || wrap.assetSafetyDisabled) return null;
  const assetWrapID = Number(wrap.assetWrapID);
  let phase;
  let boundaryMs;
  if (wrap.deliveredAt) {
    if (wrap.deliveryNotificationStatus !== "pending") return null;
    phase = "notice";
    boundaryMs = wrap.deliveredAt;
  } else if (wrap.collectionState === "collecting" ||
      (wrap.deliverySaga && wrap.deliverySaga.status !== "completed")) {
    phase = "recover";
    boundaryMs = wrap.createdAt;
  } else {
    phase = "auto";
    boundaryMs = wrap.ejectTimeMs + state.DAYS_UNTIL_AUTO_MOVE * DAY_MS;
  }
  if (!Number.isSafeInteger(assetWrapID) || assetWrapID <= 0 ||
      !Number.isSafeInteger(boundaryMs) || boundaryMs <= 0) {
    throw new Error("ASSET_SAFETY_JOB_BOUNDARY_INVALID");
  }
  return {
    jobID: `${JOB_PREFIX}${assetWrapID}:${phase}:${boundaryMs}`,
    type: JOB_TYPE,
    dueAtMs: boundaryMs,
    payload: { assetWrapID, phase, boundaryMs },
  };
}

function inLane(assetWrapID, operation) {
  const previous = lanes.get(assetWrapID) || Promise.resolve();
  const work = previous.catch(() => null).then(operation);
  lanes.set(assetWrapID, work);
  void work.then(
    () => { if (lanes.get(assetWrapID) === work) lanes.delete(assetWrapID); },
    () => { if (lanes.get(assetWrapID) === work) lanes.delete(assetWrapID); },
  );
  return work;
}

async function reconcileWrap(assetWrapID, protectedJobID = null) {
  const scheduler = binding.get();
  if (!scheduler) return null;
  check(state.ensureWrapTableDurable());
  const job = buildJob(state.getWrapByID(assetWrapID, { refresh: false }));
  for (const oldID of knownJobs.get(assetWrapID) || []) {
    if (oldID !== job?.jobID && oldID !== protectedJobID &&
        oldID !== runningJobs.get(assetWrapID)) {
      await scheduler.cancel(oldID);
    }
  }
  // A running handler will ack its own ID after returning. Do not retain it
  // for a later queued cancellation that would invalidate that ack's lease.
  knownJobs.set(assetWrapID, new Set(job ? [job.jobID] : []));
  if (job && job.jobID !== protectedJobID && job.jobID !== runningJobs.get(assetWrapID)) {
    await scheduler.schedule(job);
  }
  return job;
}

function queueWrap(assetWrapID) {
  const id = Number(assetWrapID);
  const scheduler = binding.get();
  if (!scheduler || !Number.isSafeInteger(id) || id <= 0) return Promise.resolve(null);
  const generation = bindingGeneration;
  // Preserve protection even after the handler returns but before its queued
  // mutation reconciliation runs; durableScheduler still owns the final ack.
  const protectedJobID = runningJobs.get(id) || null;
  const work = inLane(id, () => {
    if (generation !== bindingGeneration || scheduler !== binding.get()) return null;
    return reconcileWrap(id, protectedJobID);
  });
  void work.catch(error => log.warn(`[StructureAssetSafety] Scheduling wrap ${id}: ${error.message}`));
  return work;
}

function handleJob(job) {
  const id = Number(job?.payload?.assetWrapID);
  if (!Number.isSafeInteger(id) || id <= 0 || job?.type !== JOB_TYPE) {
    throw new Error("ASSET_SAFETY_JOB_INVALID");
  }
  return inLane(id, async () => {
    runningJobs.set(id, job.jobID);
    try {
      check(state.ensureWrapTableDurable());
      const current = buildJob(state.getWrapByID(id, { refresh: false }));
      if (!current || current.jobID !== job.jobID ||
          current.payload.phase !== job.payload.phase ||
          current.payload.boundaryMs !== job.payload.boundaryMs) {
        await reconcileWrap(id, job.jobID);
        return { success: true, stale: true };
      }
      if (Date.now() < current.dueAtMs) {
        throw new Error("ASSET_SAFETY_JOB_BEFORE_BOUNDARY");
      }
      if (current.payload.phase === "notice") {
        check(state.publishPendingDeliveryInvalidation(id));
      } else {
        check(state.recoverAssetSafetyWrap(id));
        if (current.payload.phase === "auto") {
          const wrap = state.getWrapByID(id, { refresh: false });
          if (!wrap?.nearestNPCStationInfo) {
            throw new Error("ASSET_SAFETY_DESTINATION_NOT_FOUND");
          }
          check(state.deliverWrapToDestination(id, wrap.nearestNPCStationInfo.itemID, {
            skipAccessCheck: true, ignoreTimer: true, autoMove: true, nowMs: Date.now(),
          }));
        }
      }
      await reconcileWrap(id, job.jobID);
      log.debug(`[StructureAssetSafety] Completed scheduled ${current.payload.phase} wrap=${id}`);
      return { success: true, assetWrapID: id, phase: current.payload.phase };
    } finally {
      runningJobs.delete(id);
    }
  });
}

async function reconcile() {
  const scheduler = binding.get();
  if (!scheduler) return { scheduled: 0 };
  const saved = await scheduler.list();
  for (const job of saved) {
    if (job?.type !== JOB_TYPE || !String(job.jobID).startsWith(JOB_PREFIX)) continue;
    const id = Number(job.payload?.assetWrapID);
    if (!Number.isSafeInteger(id) || id <= 0) continue;
    const ids = knownJobs.get(id) || new Set();
    ids.add(job.jobID);
    knownJobs.set(id, ids);
  }
  const ids = new Set([...knownJobs.keys(), ...state.listWraps({
    includeDelivered: true, refresh: false,
  }).map(wrap => wrap.assetWrapID)]);
  let scheduled = 0;
  for (const id of ids) {
    if (await queueWrap(id)) scheduled += 1;
  }
  return { scheduled };
}

async function idle() {
  while (lanes.size) await Promise.all([...lanes.values()].map(work => work.catch(() => null)));
}

function bindDurableScheduler(scheduler) {
  bindingGeneration += 1;
  knownJobs.clear();
  return binding.bind(scheduler);
}
function unbindDurableScheduler(scheduler) {
  if (!binding.unbind(scheduler)) return false;
  bindingGeneration += 1;
  knownJobs.clear();
  return true;
}

module.exports = { JOB_TYPE, buildJob, queueWrap, handleJob, reconcile, idle,
  bindDurableScheduler, unbindDurableScheduler };
