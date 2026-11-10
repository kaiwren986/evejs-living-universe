"use strict";

const path = require("path");

const database = require(path.join(__dirname, "../../../gameStore"));
const log = require(path.join(__dirname, "../../../utils/logger"));
const { getCharacterSkillMap } = require(path.join(__dirname, "../skillState"));
const {
  CHARACTER_EXPERT_SYSTEMS_TABLE,
  getCharacterExpertSystemEntries,
  removeCharacterExpertSystem,
} = require("./expertSystemState");
const {
  emitExpertSystemsUpdated,
  notifyExpertSystemExpired,
} = require("./expertSystemNotifications");

const DURABLE_EXPIRY_JOB_TYPE = "expert-system.expire";
const EXPIRY_GRACE_MS = 25;

let durableScheduler = null;
let durableSchedulerGeneration = 0;
const durableJobIDs = new Map();
const durableScheduleLanes = new Map();
const activeDurableExpiryJobs = new Set();

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function readStateTable() {
  const result = database.read(CHARACTER_EXPERT_SYSTEMS_TABLE, "/");
  if (!result.success || !result.data || typeof result.data !== "object") {
    return {};
  }
  return result.data;
}

function buildDurableExpertSystemExpiryJob(characterID) {
  const numericCharacterID = toInt(characterID, 0);
  if (numericCharacterID <= 0) {
    return null;
  }
  const expiresAtMs = getCharacterExpertSystemEntries(numericCharacterID, {
    includeExpired: true,
    pruneExpired: false,
  })
    .map((entry) => Math.max(0, toInt(entry && entry.expiresAtMs, 0)))
    .filter((value) => value > 0)
    .sort((left, right) => left - right)[0];
  if (!expiresAtMs) {
    return null;
  }
  return {
    jobID: `expert-system:${numericCharacterID}:${expiresAtMs}:expire`,
    type: DURABLE_EXPIRY_JOB_TYPE,
    dueAtMs: expiresAtMs + EXPIRY_GRACE_MS,
    payload: {
      characterID: numericCharacterID,
      expiresAtMs,
    },
  };
}

async function reconcileDurableExpertSystemExpiry(characterID, options = {}) {
  const numericCharacterID = toInt(characterID, 0);
  if (!durableScheduler || numericCharacterID <= 0) {
    return null;
  }
  const runningJobID = String(options.runningJobID || "");
  const previousJobID = durableJobIDs.get(numericCharacterID) || null;
  const nextJob = buildDurableExpertSystemExpiryJob(numericCharacterID);
  if (!nextJob) {
    durableJobIDs.delete(numericCharacterID);
    if (
      previousJobID &&
      previousJobID !== runningJobID &&
      !activeDurableExpiryJobs.has(previousJobID)
    ) {
      await durableScheduler.cancel(previousJobID);
    }
    return null;
  }
  if (previousJobID === nextJob.jobID) {
    return nextJob;
  }
  if (
    previousJobID &&
    previousJobID !== runningJobID &&
    !activeDurableExpiryJobs.has(previousJobID)
  ) {
    await durableScheduler.cancel(previousJobID);
  }
  await durableScheduler.schedule(nextJob);
  durableJobIDs.set(numericCharacterID, nextJob.jobID);
  return nextJob;
}

function scheduleExpertSystemExpiry(characterID, options = {}) {
  const numericCharacterID = toInt(characterID, 0);
  if (!durableScheduler || numericCharacterID <= 0) {
    return Promise.resolve(null);
  }
  const scheduler = durableScheduler;
  const generation = durableSchedulerGeneration;
  const runningJobID = String(options.runningJobID || "");
  let commitError = null;
  try {
    database.flushTableAsync(CHARACTER_EXPERT_SYSTEMS_TABLE);
  } catch (error) {
    commitError = error;
  }
  const previousLane = durableScheduleLanes.get(numericCharacterID) || Promise.resolve();
  const lane = previousLane.catch(() => null).then(() => {
    if (
      scheduler !== durableScheduler ||
      generation !== durableSchedulerGeneration
    ) {
      return null;
    }
    if (commitError) {
      throw commitError;
    }
    return reconcileDurableExpertSystemExpiry(numericCharacterID, {
      runningJobID,
    });
  });
  durableScheduleLanes.set(numericCharacterID, lane);
  void lane.finally(() => {
    if (durableScheduleLanes.get(numericCharacterID) === lane) {
      durableScheduleLanes.delete(numericCharacterID);
    }
  }).catch(() => null);
  void lane.catch((error) => {
    log.warn(
      `[ExpertSystems] Durable expiry scheduling failed character=${numericCharacterID}: ${error.message}`,
    );
  });
  return lane;
}

function clearExpertSystemExpiryScheduler(characterID = 0) {
  const numericCharacterID = toInt(characterID, 0);
  if (numericCharacterID <= 0) {
    durableJobIDs.clear();
    durableScheduleLanes.clear();
    activeDurableExpiryJobs.clear();
    return Promise.resolve(false);
  }
  const jobID = durableJobIDs.get(numericCharacterID) || null;
  durableJobIDs.delete(numericCharacterID);
  durableScheduleLanes.delete(numericCharacterID);
  if (
    !durableScheduler ||
    !jobID ||
    activeDurableExpiryJobs.has(jobID)
  ) {
    return Promise.resolve(false);
  }
  const cancellation = durableScheduler.cancel(jobID);
  void cancellation.catch((error) => {
    log.warn(
      `[ExpertSystems] Durable expiry cancellation deferred character=${numericCharacterID}: ${error.message}`,
    );
  });
  return cancellation;
}

function expireDueExpertSystems(characterID, options = {}) {
  const numericCharacterID = toInt(characterID, 0);
  if (numericCharacterID <= 0) {
    return {
      expired: [],
      scheduling: Promise.resolve(null),
    };
  }

  const nowMs = Math.max(0, toInt(options.nowMs, Date.now()));
  const activeAndExpiredEntries = getCharacterExpertSystemEntries(numericCharacterID, {
    nowMs,
    includeExpired: true,
    pruneExpired: false,
  });
  const dueEntries = activeAndExpiredEntries.filter((entry) => (
    toInt(entry && entry.expiresAtMs, 0) > 0 &&
    toInt(entry && entry.expiresAtMs, 0) <= nowMs
  ));
  if (dueEntries.length === 0) {
    return {
      expired: [],
      scheduling: scheduleExpertSystemExpiry(numericCharacterID, options),
    };
  }

  const previousSkillMap = getCharacterSkillMap(numericCharacterID);
  const expiredEntries = [];
  for (const dueEntry of dueEntries) {
    const removeResult = removeCharacterExpertSystem(numericCharacterID, dueEntry.typeID);
    if (removeResult && removeResult.removed) {
      expiredEntries.push(dueEntry);
    }
  }
  database.flushTableAsync(CHARACTER_EXPERT_SYSTEMS_TABLE);

  if (expiredEntries.length > 0 && options.emitNotifications !== false) {
    emitExpertSystemsUpdated(numericCharacterID, {
      session: options.session || null,
      expertSystemAdded: false,
      expertSystemTypeID: expiredEntries[0].typeID,
      previousSkillMap,
      expired: true,
    });
    for (const expiredEntry of expiredEntries) {
      notifyExpertSystemExpired(numericCharacterID, expiredEntry.typeID);
    }
    database.flushTableAsync("notifications");
  }

  return {
    expired: expiredEntries,
    scheduling: scheduleExpertSystemExpiry(numericCharacterID, options),
  };
}

function bindDurableScheduler(scheduler) {
  if (
    !scheduler ||
    typeof scheduler.schedule !== "function" ||
    typeof scheduler.cancel !== "function"
  ) {
    throw new TypeError("expert-system scheduler requires schedule and cancel functions");
  }
  durableSchedulerGeneration += 1;
  durableScheduler = scheduler;
  durableJobIDs.clear();
  durableScheduleLanes.clear();
  activeDurableExpiryJobs.clear();
  return true;
}

function unbindDurableScheduler(scheduler = null) {
  if (scheduler && durableScheduler !== scheduler) {
    return false;
  }
  durableSchedulerGeneration += 1;
  durableScheduler = null;
  durableJobIDs.clear();
  durableScheduleLanes.clear();
  activeDurableExpiryJobs.clear();
  return true;
}

async function reconcileDurableExpertSystemExpiries() {
  if (!durableScheduler) {
    return { scheduled: 0 };
  }
  let scheduled = 0;
  for (const characterID of Object.keys(readStateTable())) {
    const job = await reconcileDurableExpertSystemExpiry(characterID);
    if (job) scheduled += 1;
  }
  return { scheduled };
}

function primeExpertSystemExpirySchedulers() {
  return reconcileDurableExpertSystemExpiries();
}

async function handleDurableExpertSystemExpiry(job) {
  const jobID = String(job && job.jobID || "");
  const characterID = toInt(job && job.payload && job.payload.characterID, 0);
  const expectedExpiryMs = Math.max(
    0,
    toInt(job && job.payload && job.payload.expiresAtMs, 0),
  );
  if (!jobID || characterID <= 0 || expectedExpiryMs <= 0) {
    throw new Error("expert-system expiry job is invalid");
  }

  activeDurableExpiryJobs.add(jobID);
  try {
    if (durableJobIDs.get(characterID) === jobID) {
      durableJobIDs.delete(characterID);
    }
    const currentJob = buildDurableExpertSystemExpiryJob(characterID);
    if (!currentJob) {
      database.flushTableAsync(CHARACTER_EXPERT_SYSTEMS_TABLE);
      return { characterID, expired: 0, missing: true };
    }
    if (
      currentJob.jobID !== jobID ||
      Number(currentJob.payload.expiresAtMs) !== expectedExpiryMs
    ) {
      database.flushTableAsync(CHARACTER_EXPERT_SYSTEMS_TABLE);
      await reconcileDurableExpertSystemExpiry(characterID, {
        runningJobID: jobID,
      });
      return { characterID, expired: 0, stale: true };
    }

    const nowMs = Date.now();
    if (expectedExpiryMs > nowMs) {
      throw new Error(
        `expert-system expiry fired before character ${characterID} boundary`,
      );
    }
    const result = expireDueExpertSystems(characterID, {
      nowMs,
      runningJobID: jobID,
    });
    await result.scheduling;
    database.flushTableAsync(CHARACTER_EXPERT_SYSTEMS_TABLE);
    database.flushTableAsync("notifications");

    const remainingDueEntries = getCharacterExpertSystemEntries(characterID, {
      nowMs,
      includeExpired: true,
      pruneExpired: false,
    }).filter((entry) => toInt(entry && entry.expiresAtMs, 0) <= nowMs);
    if (remainingDueEntries.length > 0) {
      throw new Error(
        `expert-system expiry remains unsettled for character ${characterID}`,
      );
    }
    return {
      characterID,
      expired: result.expired.length,
      stale: false,
    };
  } finally {
    activeDurableExpiryJobs.delete(jobID);
  }
}

module.exports = {
  DURABLE_EXPIRY_JOB_TYPE,
  bindDurableScheduler,
  buildDurableExpertSystemExpiryJob,
  clearExpertSystemExpiryScheduler,
  expireDueExpertSystems,
  handleDurableExpertSystemExpiry,
  primeExpertSystemExpirySchedulers,
  reconcileDurableExpertSystemExpiries,
  scheduleExpertSystemExpiry,
  unbindDurableScheduler,
};
