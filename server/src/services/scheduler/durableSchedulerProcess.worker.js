"use strict";

process.env.EVEJS_GAMESTORE_OWNER_ROLE = "scheduler";

const crypto = require("node:crypto");
const path = require("node:path");
const { isDeepStrictEqual } = require("node:util");

const {
  installProcessLifecycleLogging,
} = require(path.join(__dirname, "../../utils/processLifecycle"));

installProcessLifecycleLogging({
  appName: "eve.js durable scheduler",
  signals: [],
});

const database = require(path.join(__dirname, "../../gameStore"));
require(path.join(__dirname, "../../gameStore/ownerProcessShutdown"))
  .installOwnerProcessShutdown(database);
const { createOrderedProcessHost } = require(path.join(
  __dirname,
  "../_shared/orderedProcessHost",
));

const TABLE_NAME = "scheduledJobs";
const DEFAULT_LEASE_MS = 30_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
// A job that cannot succeed used to retry forever. With the backoff capped at
// 256s that is ~15 attempts/hour of invisible failure -- one settlement job
// reached attempt 297 over 20 hours without a single log line, while its
// pending record silently blocked every later operation for that character.
// Past this ceiling a job stops being rescheduled and parks in "dead-letter",
// where it keeps its payload and lastError for a recovery pass to inspect.
// Nothing revives a dead-lettered job automatically: re-`schedule` (which
// resets attempt) or `cancel` are the only ways out, so the ceiling cannot
// become a retry loop of its own.
// Overridable so a test can reach the ceiling without paying 25 durable
// round-trips; production never sets it.
const DEAD_LETTER_ATTEMPT_CEILING = Math.max(
  1,
  Math.trunc(Number(process.env.EVEJS_SCHEDULER_DEAD_LETTER_ATTEMPTS)) || 25,
);
// Shared with the owners that read this state back out of `list()`; see
// scheduledJobStates.js for why it cannot be spelled twice.
const { DEAD_LETTER_JOB_STATE: DEAD_LETTER_STATE } = require(path.join(
  __dirname,
  "./scheduledJobStates",
));
let publishEvent = null;
let timer = null;

function cloneValue(value) {
  return value === undefined || value === null
    ? value
    : typeof structuredClone === "function"
      ? structuredClone(value)
      : JSON.parse(JSON.stringify(value));
}

function normalizeJobID(value) {
  const jobID = String(value || "").trim();
  if (!jobID || jobID.length > 320) {
    const error = new Error("Scheduled job ID is invalid");
    error.code = "SCHEDULED_JOB_ID_INVALID";
    throw error;
  }
  return jobID;
}

function normalizeType(value) {
  const type = String(value || "").trim();
  if (!type || type.length > 160) {
    const error = new Error("Scheduled job type is invalid");
    error.code = "SCHEDULED_JOB_TYPE_INVALID";
    throw error;
  }
  return type;
}

function normalizeDueAtMs(value) {
  const dueAtMs = Math.trunc(Number(value));
  if (!Number.isSafeInteger(dueAtMs) || dueAtMs < 0) {
    const error = new Error("Scheduled job due time is invalid");
    error.code = "SCHEDULED_JOB_DUE_INVALID";
    throw error;
  }
  return dueAtMs;
}

function readJobs() {
  database.ensureTable(TABLE_NAME);
  const result = database.read(TABLE_NAME, "/");
  return result && result.success && result.data && typeof result.data === "object"
    ? result.data
    : {};
}

function writeJob(jobID, job, { commit = true } = {}) {
  const result = database.write(TABLE_NAME, `/${jobID}`, cloneValue(job));
  if (!result || result.success !== true) {
    const error = new Error(result && result.errorMsg || "Scheduled job write failed");
    error.code = "SCHEDULED_JOB_WRITE_FAILED";
    throw error;
  }
  if (commit) commitJobs();
  return job;
}

function commitJobs() {
  const flush = database.flushTableSync(TABLE_NAME);
  if (!flush || flush.success !== true) {
    const error = new Error(flush && flush.errorMsg || "Scheduled job flush failed");
    error.code = "SCHEDULED_JOB_COMMIT_AMBIGUOUS";
    throw error;
  }
}

function removeJob(jobID) {
  const result = database.remove(TABLE_NAME, `/${jobID}`);
  if (result && result.success === false && result.errorMsg !== "ENTRY_NOT_FOUND") {
    const error = new Error(result.errorMsg || "Scheduled job remove failed");
    error.code = "SCHEDULED_JOB_REMOVE_FAILED";
    throw error;
  }
  const flush = database.flushTableSync(TABLE_NAME);
  if (!flush || flush.success !== true) {
    const error = new Error(flush && flush.errorMsg || "Scheduled job remove flush failed");
    error.code = "SCHEDULED_JOB_COMMIT_AMBIGUOUS";
    throw error;
  }
  return true;
}

function nextWakeAtMs(nowMs = Date.now()) {
  let next = Number.POSITIVE_INFINITY;
  for (const job of Object.values(readJobs())) {
    if (!job || job.state === DEAD_LETTER_STATE) continue;
    const candidate = job.state === "running"
      ? Number(job.leaseUntilMs || 0)
      : Number(job.dueAtMs || 0);
    if (candidate >= 0 && candidate < next) next = candidate;
  }
  return Number.isFinite(next) ? Math.max(nowMs, next) : null;
}

let armedWakeAtMs = null;

function setWakeTimer(wakeAtMs) {
  if (timer) clearTimeout(timer);
  timer = null;
  armedWakeAtMs = null;
  if (wakeAtMs === null) return;
  const delayMs = Math.max(1, Math.min(MAX_TIMER_DELAY_MS, wakeAtMs - Date.now()));
  armedWakeAtMs = Date.now() + delayMs;
  timer = setTimeout(dispatchDueJobs, delayMs);
  if (typeof timer.unref === "function") timer.unref();
}

// Full scan: startup and after each dispatch pass.
function armTimer() {
  setWakeTimer(nextWakeAtMs());
}

// A new or changed job can only move the wake earlier. A removed or postponed
// job leaves the timer where it is; that wake finds nothing due and rescans.
function armTimerAt(wakeAtMs) {
  if (timer && armedWakeAtMs !== null && armedWakeAtMs <= wakeAtMs) return;
  setWakeTimer(Math.max(Date.now(), wakeAtMs));
}

function dispatchDueJobs() {
  timer = null;
  armedWakeAtMs = null;
  const leasedJobs = [];
  const nowMs = Date.now();
  const jobs = Object.values(readJobs())
    .filter(Boolean)
    .sort((left, right) => Number(left.dueAtMs) - Number(right.dueAtMs));
  for (const current of jobs) {
    let job = current;
    if (job.state === DEAD_LETTER_STATE) continue;
    if (job.state === "running") {
      if (Number(job.leaseUntilMs || 0) > nowMs) continue;
      job = {
        ...job,
        state: "scheduled",
        dueAtMs: nowMs,
        leaseToken: null,
        leaseUntilMs: 0,
      };
    }
    if (job.state !== "scheduled" || Number(job.dueAtMs) > nowMs) continue;
    const leased = {
      ...job,
      state: "running",
      attempt: Math.max(0, Math.trunc(Number(job.attempt) || 0)) + 1,
      leaseToken: crypto.randomUUID(),
      leaseUntilMs: nowMs + DEFAULT_LEASE_MS,
      updatedAtMs: nowMs,
    };
    writeJob(leased.jobID, leased, { commit: false });
    leasedJobs.push(leased);
  }
  // One commit for the whole pass, still before any lease is published.
  if (leasedJobs.length > 0) commitJobs();
  for (const leased of leasedJobs) {
    if (publishEvent) publishEvent("scheduler.due", cloneValue(leased));
  }
  armTimer();
}

function requireLease(payload = {}) {
  const jobID = normalizeJobID(payload.jobID);
  const current = readJobs()[jobID];
  if (!current || current.state !== "running" || current.leaseToken !== payload.leaseToken) {
    const error = new Error("Scheduled job lease is stale");
    error.code = "SCHEDULED_JOB_LEASE_STALE";
    throw error;
  }
  return current;
}

createOrderedProcessHost({
  authorityName: "scheduler",
  onStart({ publish }) {
    database.ensureTable(TABLE_NAME);
    publishEvent = publish;
    armTimer();
  },
  handleCommand(command, payload = {}) {
    if (command === "schedule") {
      const jobID = normalizeJobID(payload.jobID);
      const type = normalizeType(payload.type);
      const dueAtMs = normalizeDueAtMs(payload.dueAtMs);
      const jobPayload = cloneValue(payload.payload || {});
      const current = readJobs()[jobID];
      // Owners reconcile persisted work after dispatch has already started.
      // Reasserting the same job must not revoke an active handler's lease:
      // its ack/retry still owns this execution. Do not extend the deadline;
      // changed work and expired leases must retain normal rescheduling.
      if (
        current && current.state === "running" && current.leaseToken &&
        Number(current.leaseUntilMs || 0) > Date.now() &&
        current.type === type && current.dueAtMs === dueAtMs &&
        isDeepStrictEqual(current.payload, jobPayload)
      ) {
        return cloneValue(current);
      }
      // Owner reconciliation reasserts every saved deadline at startup. An
      // identical scheduled job is already durable; rewriting it only to bump
      // updatedAtMs cost a committed SQLite write per job.
      if (
        current && current.state === "scheduled" &&
        current.type === type && current.dueAtMs === dueAtMs &&
        isDeepStrictEqual(current.payload, jobPayload)
      ) {
        return cloneValue(current);
      }
      // Scheduling a job that is parked in dead-letter is the deliberate act of
      // re-arming it -- a restart after the fix, or a recovery pass handing the
      // work back. Carrying the exhausted attempt count over would burn the new
      // budget on the first failure, so a dead-lettered job starts clean. This
      // cannot loop: nothing schedules on a timer, only on an explicit request.
      const revived = Boolean(current && current.state === DEAD_LETTER_STATE);
      const next = {
        jobID,
        type,
        dueAtMs,
        payload: jobPayload,
        state: "scheduled",
        attempt: current && current.type === type && !revived
          ? Number(current.attempt || 0)
          : 0,
        leaseToken: null,
        leaseUntilMs: 0,
        lastError: null,
        deadLetteredAtMs: 0,
        createdAtMs: current && current.createdAtMs || Date.now(),
        updatedAtMs: Date.now(),
      };
      writeJob(jobID, next);
      armTimerAt(dueAtMs);
      return cloneValue(next);
    }
    if (command === "cancel") {
      removeJob(normalizeJobID(payload.jobID));
      return true;
    }
    if (command === "ack") {
      const current = requireLease(payload);
      removeJob(current.jobID);
      return true;
    }
    if (command === "validateLease") {
      requireLease(payload);
      return true;
    }
    if (command === "retry") {
      const current = requireLease(payload);
      const attempt = Math.max(0, Math.trunc(Number(current.attempt) || 0));
      const deadLettered = attempt >= DEAD_LETTER_ATTEMPT_CEILING;
      const next = {
        ...current,
        state: deadLettered ? DEAD_LETTER_STATE : "scheduled",
        dueAtMs: deadLettered
          ? Number(current.dueAtMs) || Date.now()
          : normalizeDueAtMs(payload.dueAtMs),
        leaseToken: null,
        leaseUntilMs: 0,
        lastError: String(payload.error || "").slice(0, 1000),
        deadLetteredAtMs: deadLettered
          ? Number(current.deadLetteredAtMs) || Date.now()
          : 0,
        updatedAtMs: Date.now(),
      };
      writeJob(current.jobID, next);
      if (!deadLettered) armTimerAt(next.dueAtMs);
      return cloneValue(next);
    }
    if (command === "get") {
      return cloneValue(readJobs()[normalizeJobID(payload.jobID)] || null);
    }
    if (command === "list") {
      return Object.values(readJobs()).filter(Boolean).map(cloneValue);
    }
    const error = new Error(`Unknown scheduler command: ${command}`);
    error.code = "SCHEDULER_COMMAND_UNKNOWN";
    throw error;
  },
  onShutdown() {
    if (timer) clearTimeout(timer);
    timer = null;
    return database.shutdown("scheduler-host");
  },
});
