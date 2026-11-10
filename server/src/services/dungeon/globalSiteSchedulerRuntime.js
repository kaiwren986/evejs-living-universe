"use strict";

const path = require("node:path");

const defaultDatabase = require(path.join(__dirname, "../../gameStore"));
const defaultLog = require(path.join(__dirname, "../../utils/logger"));
const defaultDungeonRuntime = require(path.join(__dirname, "./dungeonRuntime"));
const defaultDungeonRuntimeState = require(path.join(
  __dirname,
  "./dungeonRuntimeState",
));
const defaultDungeonUniverseRuntime = require(path.join(
  __dirname,
  "./dungeonUniverseRuntime",
));
const defaultMiningRuntimeState = require(path.join(
  __dirname,
  "../mining/miningRuntimeState",
));
const { isDeadLetteredJob } = require(path.join(
  __dirname,
  "../scheduler/scheduledJobStates",
));

const DURABLE_LIFECYCLE_JOB_TYPE = "global-site.lifecycle";
const BOUNDARY_GRACE_MS = 25;
const SYNCHRONOUS_TEARDOWN_TABLES = Object.freeze([
  "items",
  "npcEntities",
  "npcModules",
  "npcCargo",
  "npcRuntimeControllers",
  "npcWrecks",
  "npcWreckItems",
]);

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function isUniversePersistentInstance(instance) {
  return Boolean(
    instance &&
    instance.runtimeFlags &&
    instance.runtimeFlags.universePersistent === true &&
    instance.runtimeFlags.universeSeeded === true
  );
}

function normalizeBoundary(boundary) {
  const boundaryAtMs = Math.max(0, toInt(boundary && boundary.boundaryAtMs, 0));
  const instanceID = Math.max(0, toInt(boundary && boundary.instanceID, 0));
  const phase = String(boundary && boundary.phase || "").trim().toLowerCase();
  if (boundaryAtMs <= 0 || instanceID <= 0 || !phase) {
    return null;
  }
  return { boundaryAtMs, instanceID, phase };
}

function lifecycleBoundaryStateKey(instance) {
  if (!isUniversePersistentInstance(instance)) return null;
  const lifecycle = String(instance.lifecycleState || "").toLowerCase();
  const timers = instance.timers || {};
  const active = ["seeded", "active", "paused"].includes(lifecycle);
  const delayedRespawn = !active &&
    String(instance.siteOrigin || "").toLowerCase() === "generatedmining" &&
    String(instance.lifecycleReason || "").toLowerCase() === "depleted";
  const phase = active ? "expiry" : delayedRespawn ? "respawn" : "rotation";
  const transitionAtMs = lifecycle === "completed" ? timers.completedAtMs
    : lifecycle === "failed" ? timers.failedAtMs : timers.despawnAtMs;
  const boundaryAtMs = active ? timers.expiresAtMs : delayedRespawn
    ? timers.expiresAtMs || timers.completedAtMs || timers.lastUpdatedAtMs || timers.createdAtMs
    : transitionAtMs || timers.lastUpdatedAtMs || timers.createdAtMs;
  return JSON.stringify([
    toInt(instance.instanceID, 0), toInt(instance.solarSystemID, 0), phase, toInt(boundaryAtMs, 0),
  ]);
}

function earliestBoundary(boundaries) {
  let earliest = null;
  for (const boundary of boundaries) {
    const candidate = normalizeBoundary(boundary);
    if (candidate && (!earliest || candidate.boundaryAtMs < earliest.boundaryAtMs || (
      candidate.boundaryAtMs === earliest.boundaryAtMs && candidate.instanceID < earliest.instanceID
    ))) earliest = candidate;
  }
  return earliest;
}

function buildJobFromBoundary(boundary) {
  const normalized = normalizeBoundary(boundary);
  if (!normalized) {
    return null;
  }
  return {
    jobID:
      `global-site:${normalized.instanceID}:` +
      `${normalized.phase}:${normalized.boundaryAtMs}:advance`,
    type: DURABLE_LIFECYCLE_JOB_TYPE,
    dueAtMs: normalized.boundaryAtMs + BOUNDARY_GRACE_MS,
    payload: normalized,
  };
}

function createGlobalSiteSchedulerRuntime(options = {}) {
  const database = options.database || defaultDatabase;
  const log = options.log || defaultLog;
  const dungeonRuntime = options.dungeonRuntime || defaultDungeonRuntime;
  const dungeonRuntimeState =
    options.dungeonRuntimeState || defaultDungeonRuntimeState;
  const dungeonUniverseRuntime =
    options.dungeonUniverseRuntime || defaultDungeonUniverseRuntime;
  const miningRuntimeState =
    options.miningRuntimeState || defaultMiningRuntimeState;

  let durableScheduler = null;
  let durableSchedulerGeneration = 0;
  let currentJobID = null;
  let reconciliationLane = Promise.resolve();
  let registeredInstanceChangeListener = null;
  let instanceChangeReconciliationDirty = false;
  let instanceChangeReconciliationScheduled = false;
  let instanceChangeReconciliationImmediate = null;
  let instanceChangeReconciliationInFlight = null;
  let boundariesBySystem = null;
  const dirtyBoundarySystemIDs = new Set();
  const activeJobIDs = new Set();

  function flushOwnerState() {
    database.flushTableAsync(dungeonRuntimeState.DUNGEON_RUNTIME_TABLE);
    database.flushTableAsync(miningRuntimeState.MINING_RUNTIME_TABLE);
    for (const tableName of SYNCHRONOUS_TEARDOWN_TABLES) {
      database.flushTableAsync(tableName);
    }
  }

  function getCurrentBoundary(nowMs = Date.now(), options = {}) {
    const readBoundaries = dungeonUniverseRuntime.getUniversePersistentLifecycleBoundariesBySystem;
    if (typeof readBoundaries !== "function") {
      return normalizeBoundary(dungeonUniverseRuntime.getUniversePersistentLifecycleBoundary(nowMs, options));
    }
    if (Array.isArray(options.systemIDs)) {
      return earliestBoundary(readBoundaries.call(dungeonUniverseRuntime, nowMs, options));
    }
    // Initialize once from scalar owner projections. Later changes refresh only
    // their systems; reducing this dictionary never copies an instance payload.
    const dirtySystems = [...dirtyBoundarySystemIDs];
    for (const systemID of dirtySystems) dirtyBoundarySystemIDs.delete(systemID);
    try {
      if (!boundariesBySystem) {
        const entries = readBoundaries.call(dungeonUniverseRuntime, nowMs);
        boundariesBySystem = new Map(entries.map((entry) => [Number(entry.solarSystemID), entry]));
      } else if (dirtySystems.length > 0) {
        const entries = readBoundaries.call(dungeonUniverseRuntime, nowMs, { systemIDs: dirtySystems });
        for (const systemID of dirtySystems) boundariesBySystem.delete(systemID);
        for (const entry of entries) boundariesBySystem.set(Number(entry.solarSystemID), entry);
      }
    } catch (error) {
      for (const systemID of dirtySystems) dirtyBoundarySystemIDs.add(systemID);
      throw error;
    }
    return earliestBoundary(boundariesBySystem.values());
  }

  function invalidateBoundarySystems(systemIDs) {
    if (!Array.isArray(systemIDs)) {
      boundariesBySystem = null;
      dirtyBoundarySystemIDs.clear();
      return;
    }
    for (const systemID of systemIDs) {
      const numericSystemID = Math.max(0, toInt(systemID, 0));
      if (numericSystemID > 0) dirtyBoundarySystemIDs.add(numericSystemID);
    }
  }

  function buildDurableGlobalSiteLifecycleJob(nowMs = Date.now()) {
    return buildJobFromBoundary(getCurrentBoundary(nowMs));
  }

  async function reconcileNow(options = {}) {
    const scheduler = durableScheduler;
    if (!scheduler) {
      return { scheduled: 0 };
    }
    const generation = durableSchedulerGeneration;
    const isCurrent = () => scheduler === durableScheduler && generation === durableSchedulerGeneration;
    const nowMs = Math.max(0, toInt(options.nowMs, Date.now()));
    const runningJobID = String(options.runningJobID || "");
    const nextJob = buildDurableGlobalSiteLifecycleJob(nowMs);
    let existingJobs = [];
    if (options.scanExisting === true && typeof scheduler.list === "function") {
      const listed = await scheduler.list();
      if (!isCurrent()) return { scheduled: 0, stale: true };
      existingJobs = Array.isArray(listed)
        ? listed.filter((job) => job && job.type === DURABLE_LIFECYCLE_JOB_TYPE)
        : [];
    }

    const previousJobID = currentJobID;
    if (!nextJob) {
      currentJobID = null;
      const staleJobIDs = new Set([
        previousJobID,
        ...existingJobs.map((job) => String(job.jobID || "")),
      ]);
      for (const jobID of staleJobIDs) {
        if (
          jobID &&
          jobID !== runningJobID &&
          !activeJobIDs.has(jobID)
        ) {
          await scheduler.cancel(jobID);
          if (!isCurrent()) return { scheduled: 0, stale: true };
        }
      }
      return { scheduled: 0 };
    }

    const existingJob = existingJobs.find(
      (job) => String(job && job.jobID || "") === nextJob.jobID,
    ) || null;
    // A dead-lettered row is present in the listing and absent from dispatch.
    // Counting it as "already scheduled" is what makes one exhausted job
    // permanent: nothing but `schedule` revives it, and `schedule` is what we
    // would be skipping. Since this boundary is a global minimum over every
    // universe-persistent site, that freezes rotation and expiry for the whole
    // universe -- across restarts, and past the fix for whatever failed.
    //
    // Re-arming is bounded: only the startup owner reconcile passes
    // scanExisting, so a job that still cannot succeed burns its budget once
    // per boot rather than looping.
    const existingJobIsDeadLettered = isDeadLetteredJob(existingJob);
    const nextJobIsRunning = Boolean(
      runningJobID && nextJob.jobID === runningJobID,
    );
    if (existingJobIsDeadLettered) {
      log.warn(
        "[GlobalSiteScheduler] re-arming dead-lettered lifecycle job " +
          `jobID=${nextJob.jobID} attempt=${Number(existingJob.attempt) || 0} ` +
          `lastError=${String(existingJob.lastError || "(none)")}`,
      );
    }
    if (
      !nextJobIsRunning &&
      (
        existingJobIsDeadLettered ||
        (currentJobID !== nextJob.jobID && !existingJob)
      )
    ) {
      await scheduler.schedule(nextJob);
      if (!isCurrent()) return { scheduled: 0, stale: true };
    }
    currentJobID = nextJob.jobID;

    const staleJobIDs = new Set([
      previousJobID,
      ...existingJobs.map((job) => String(job && job.jobID || "")),
    ]);
    staleJobIDs.delete(nextJob.jobID);
    for (const jobID of staleJobIDs) {
      if (
        jobID &&
        jobID !== runningJobID &&
        !activeJobIDs.has(jobID)
      ) {
        await scheduler.cancel(jobID);
        if (!isCurrent()) return { scheduled: 0, stale: true };
      }
    }
    return {
      jobID: nextJob.jobID,
      scheduled: 1,
    };
  }

  function absorbPendingInstanceChangeReconciliation() {
    if (instanceChangeReconciliationImmediate) {
      clearImmediate(instanceChangeReconciliationImmediate);
    }
    instanceChangeReconciliationDirty = false;
    instanceChangeReconciliationScheduled = false;
    instanceChangeReconciliationImmediate = null;
  }

  function queueDurableGlobalSiteReconciliation(options = {}) {
    if (!durableScheduler) {
      return Promise.resolve({ scheduled: 0 });
    }
    if (Array.isArray(options.systemIDs)) {
      // An explicit empty scope adds no dirty systems; it never means all.
      invalidateBoundarySystems(options.systemIDs);
    } else if (options.absorbInstanceChanges !== false || options.scanExisting === true) {
      // Unscoped explicit/startup reconciliation also rechecks scene grid holds.
      invalidateBoundarySystems();
    }
    if (options.absorbInstanceChanges !== false) {
      absorbPendingInstanceChangeReconciliation();
    }
    const scheduler = durableScheduler;
    const generation = durableSchedulerGeneration;
    flushOwnerState();
    const lane = reconciliationLane.catch(() => null).then(() => {
      if (
        scheduler !== durableScheduler ||
        generation !== durableSchedulerGeneration
      ) {
        return { scheduled: 0, stale: true };
      }
      return reconcileNow(options);
    });
    reconciliationLane = lane;
    void lane.catch((error) => {
      log.warn(
        `[GlobalSites] Durable lifecycle reconciliation failed: ${error.message}`,
      );
    });
    return lane;
  }

  function resetInstanceChangeReconciliation() {
    absorbPendingInstanceChangeReconciliation();
    instanceChangeReconciliationInFlight = null;
  }

  function queueInstanceChangeReconciliation() {
    if (!durableScheduler) {
      return;
    }
    instanceChangeReconciliationDirty = true;
    if (
      instanceChangeReconciliationScheduled ||
      instanceChangeReconciliationInFlight
    ) {
      return;
    }

    const scheduler = durableScheduler;
    const generation = durableSchedulerGeneration;
    instanceChangeReconciliationScheduled = true;
    instanceChangeReconciliationImmediate = setImmediate(() => {
      instanceChangeReconciliationImmediate = null;
      instanceChangeReconciliationScheduled = false;
      if (
        scheduler !== durableScheduler ||
        generation !== durableSchedulerGeneration
      ) {
        instanceChangeReconciliationDirty = false;
        return;
      }
      if (!instanceChangeReconciliationDirty) {
        return;
      }

      instanceChangeReconciliationDirty = false;
      const lane = queueDurableGlobalSiteReconciliation({
        absorbInstanceChanges: false,
        scanExisting: false,
      });
      instanceChangeReconciliationInFlight = lane;
      void lane.finally(() => {
        if (instanceChangeReconciliationInFlight === lane) {
          instanceChangeReconciliationInFlight = null;
        }
        if (
          instanceChangeReconciliationDirty &&
          scheduler === durableScheduler &&
          generation === durableSchedulerGeneration
        ) {
          queueInstanceChangeReconciliation();
        }
      }).catch(() => null);
    });
  }

  function handleInstanceChange(change) {
    const before = change && change.before;
    const after = change && change.after;
    if (lifecycleBoundaryStateKey(before) === lifecycleBoundaryStateKey(after)) {
      return;
    }
    const systemIDs = [before && before.solarSystemID, after && after.solarSystemID]
      .map((systemID) => Math.max(0, toInt(systemID, 0))).filter(Boolean);
    invalidateBoundarySystems(systemIDs.length > 0 ? systemIDs : undefined);
    queueInstanceChangeReconciliation();
  }

  function bindDurableScheduler(scheduler) {
    if (
      !scheduler ||
      typeof scheduler.schedule !== "function" ||
      typeof scheduler.cancel !== "function"
    ) {
      throw new TypeError(
        "global-site scheduler requires schedule and cancel functions",
      );
    }
    if (registeredInstanceChangeListener) {
      dungeonRuntime.unregisterInstanceChangeListener(
        registeredInstanceChangeListener,
      );
    }
    durableSchedulerGeneration += 1;
    durableScheduler = scheduler;
    currentJobID = null;
    reconciliationLane = Promise.resolve();
    resetInstanceChangeReconciliation();
    invalidateBoundarySystems();
    activeJobIDs.clear();
    registeredInstanceChangeListener = handleInstanceChange;
    dungeonRuntime.registerInstanceChangeListener(
      registeredInstanceChangeListener,
    );
    return true;
  }

  function unbindDurableScheduler(scheduler = null) {
    if (scheduler && durableScheduler !== scheduler) {
      return false;
    }
    if (registeredInstanceChangeListener) {
      dungeonRuntime.unregisterInstanceChangeListener(
        registeredInstanceChangeListener,
      );
      registeredInstanceChangeListener = null;
    }
    durableSchedulerGeneration += 1;
    durableScheduler = null;
    currentJobID = null;
    reconciliationLane = Promise.resolve();
    resetInstanceChangeReconciliation();
    invalidateBoundarySystems();
    activeJobIDs.clear();
    return true;
  }

  function reconcileDurableGlobalSites(options = {}) {
    return queueDurableGlobalSiteReconciliation({
      ...options,
      scanExisting: options.scanExisting !== false,
    });
  }

  async function handleDurableGlobalSiteLifecycle(job, options = {}) {
    if (!durableScheduler) {
      throw new Error("global-site scheduler is not bound");
    }
    const generation = durableSchedulerGeneration;
    const jobID = String(job && job.jobID || "");
    const expectedJob = buildJobFromBoundary(job && job.payload);
    if (!jobID || !expectedJob || expectedJob.jobID !== jobID) {
      throw new Error("global-site lifecycle job is invalid");
    }

    activeJobIDs.add(jobID);
    try {
      if (currentJobID === jobID) {
        currentJobID = null;
      }
      const nowMs = Math.max(0, toInt(options.nowMs, Date.now()));
      const currentJob = buildDurableGlobalSiteLifecycleJob(nowMs);
      if (!currentJob) {
        flushOwnerState();
        return { missing: true, stale: false };
      }
      if (currentJob.jobID !== jobID) {
        await queueDurableGlobalSiteReconciliation({
          nowMs,
          runningJobID: jobID,
          scanExisting: false,
        });
        return { missing: false, stale: true };
      }
      if (Number(job.payload.boundaryAtMs) > nowMs) {
        throw new Error("global-site lifecycle fired before its boundary");
      }

      const boundaryInstance = dungeonRuntime.getInstance(job.payload.instanceID);
      const boundarySystemID = Math.max(
        0,
        toInt(boundaryInstance && boundaryInstance.solarSystemID, 0),
      );
      if (!boundarySystemID) {
        throw new Error("global-site lifecycle instance has no solar system");
      }

      const result = dungeonUniverseRuntime.advanceUniversePersistentSites({
        lifecycleReason: "durable-scheduler",
        nowMs,
        systemIDs: [boundarySystemID],
      });
      flushOwnerState();
      await queueDurableGlobalSiteReconciliation({
        nowMs,
        runningJobID: jobID,
        scanExisting: false,
        systemIDs: [boundarySystemID],
      });

      const remainingBoundary = getCurrentBoundary(nowMs, {
        systemIDs: [boundarySystemID],
      });
      if (
        remainingBoundary &&
        remainingBoundary.boundaryAtMs <= nowMs
      ) {
        throw new Error(
          `global-site lifecycle remains unsettled at ${remainingBoundary.boundaryAtMs}`,
        );
      }
      return {
        affectedSystemIDs: Array.isArray(result && result.affectedSystemIDs)
          ? result.affectedSystemIDs
          : [],
        expired: Math.max(0, toInt(result && result.expiredCount, 0)),
        rotated: Math.max(0, toInt(result && result.rotatedCount, 0)),
        stale: false,
      };
    } finally {
      if (generation === durableSchedulerGeneration) activeJobIDs.delete(jobID);
    }
  }

  return Object.freeze({
    DURABLE_LIFECYCLE_JOB_TYPE,
    bindDurableScheduler,
    buildDurableGlobalSiteLifecycleJob,
    handleDurableGlobalSiteLifecycle,
    queueDurableGlobalSiteReconciliation,
    reconcileDurableGlobalSites,
    unbindDurableScheduler,
  });
}

const singleton = createGlobalSiteSchedulerRuntime();

module.exports = {
  ...singleton,
  createGlobalSiteSchedulerRuntime,
};
