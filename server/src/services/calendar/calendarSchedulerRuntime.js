"use strict";

const path = require("node:path");

const database = require(path.join(__dirname, "../../gameStore"));
const log = require(path.join(__dirname, "../../utils/logger"));
const calendarRuntime = require(path.join(__dirname, "./calendarRuntimeState"));
const { isDeadLetteredJob } = require(path.join(
  __dirname,
  "../scheduler/scheduledJobStates",
));

const DURABLE_MAINTENANCE_JOB_TYPE = "calendar.global-seed-maintenance";
const BOUNDARY_GRACE_MS = 100;

let durableScheduler = null;

function normalizeDate(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : new Date();
}

function getUtcMonthBoundary(value = new Date()) {
  const date = normalizeDate(value);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function getNextUtcMonthBoundary(value = new Date()) {
  const boundary = getUtcMonthBoundary(value);
  return new Date(Date.UTC(
    boundary.getUTCFullYear(),
    boundary.getUTCMonth() + 1,
    1,
  ));
}

function buildMonthKey(value = new Date()) {
  const boundary = getUtcMonthBoundary(value);
  return (
    `${boundary.getUTCFullYear()}-` +
    String(boundary.getUTCMonth() + 1).padStart(2, "0")
  );
}

function buildDurableCalendarMaintenanceJob(targetDate, options = {}) {
  const boundary = getUtcMonthBoundary(targetDate);
  const monthKey = buildMonthKey(boundary);
  const configuredDueAtMs = Number(options.dueAtMs);
  const dueAtMs = Number.isFinite(configuredDueAtMs)
    ? Math.max(0, Math.trunc(configuredDueAtMs))
    : boundary.getTime() + BOUNDARY_GRACE_MS;
  return {
    jobID: `calendar:global-seed:${monthKey}:maintain`,
    type: DURABLE_MAINTENANCE_JOB_TYPE,
    dueAtMs,
    payload: {
      month: monthKey,
    },
  };
}

function bindDurableScheduler(scheduler) {
  if (!scheduler || typeof scheduler.schedule !== "function") {
    throw new TypeError("calendar scheduler requires a schedule function");
  }
  durableScheduler = scheduler;
  return true;
}

function unbindDurableScheduler(scheduler = null) {
  if (scheduler && durableScheduler !== scheduler) {
    return false;
  }
  durableScheduler = null;
  return true;
}

async function reconcileDurableCalendarJobs(options = {}) {
  if (!durableScheduler) {
    return { scheduled: 0 };
  }
  const nowMs = Number.isFinite(Number(options.nowMs))
    ? Math.max(0, Math.trunc(Number(options.nowMs)))
    : Date.now();
  const job = buildDurableCalendarMaintenanceJob(new Date(nowMs), {
    dueAtMs: nowMs,
  });
  if (typeof durableScheduler.list === "function") {
    const existingJobs = await durableScheduler.list();
    const existingJob = (Array.isArray(existingJobs) ? existingJobs : [])
      .find((candidate) => candidate && candidate.jobID === job.jobID) || null;
    // A dead-lettered row still answers this listing, but dispatch skips it
    // forever and only `schedule` revives it -- so treating it as "already
    // scheduled" is what makes one exhausted job permanent. See
    // scheduler/scheduledJobStates.js.
    if (isDeadLetteredJob(existingJob)) {
      log.warn(
        "[CalendarScheduler] re-arming dead-lettered maintenance job " +
          `jobID=${job.jobID} attempt=${Number(existingJob.attempt) || 0} ` +
          `lastError=${String(existingJob.lastError || "(none)")}`,
      );
    } else if (existingJob) {
      return { scheduled: 1, jobID: job.jobID, existing: true };
    }
  }
  await durableScheduler.schedule(job);
  return { scheduled: 1, jobID: job.jobID };
}

async function handleDurableCalendarMaintenance(job, options = {}) {
  if (!durableScheduler) {
    throw new Error("calendar scheduler is not bound");
  }
  const jobID = String(job && job.jobID || "");
  const month = String(job && job.payload && job.payload.month || "");
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!jobID || !match) {
    throw new Error("calendar maintenance job is invalid");
  }
  const targetYear = Number(match[1]);
  const targetMonthIndex = Number(match[2]) - 1;
  const targetBoundary = new Date(Date.UTC(targetYear, targetMonthIndex, 1));
  const expectedJobID = buildDurableCalendarMaintenanceJob(targetBoundary).jobID;
  if (expectedJobID !== jobID) {
    throw new Error("calendar maintenance job boundary is invalid");
  }

  const nowMs = Number.isFinite(Number(options.nowMs))
    ? Math.max(0, Math.trunc(Number(options.nowMs)))
    : Date.now();
  if (targetBoundary.getTime() > nowMs) {
    throw new Error("calendar maintenance fired before its month boundary");
  }

  const seedResult = calendarRuntime.ensureSeededGlobalEvents(new Date(nowMs));
  database.flushTableAsync("calendarEvents");
  database.flushTableAsync("calendarResponses");

  const nextBoundary = getNextUtcMonthBoundary(new Date(nowMs));
  const nextJob = buildDurableCalendarMaintenanceJob(nextBoundary);
  await durableScheduler.schedule(nextJob);
  return {
    created: Number(seedResult && seedResult.created) || 0,
    month,
    nextJobID: nextJob.jobID,
  };
}

module.exports = {
  DURABLE_MAINTENANCE_JOB_TYPE,
  bindDurableScheduler,
  buildDurableCalendarMaintenanceJob,
  handleDurableCalendarMaintenance,
  reconcileDurableCalendarJobs,
  unbindDurableScheduler,
};
