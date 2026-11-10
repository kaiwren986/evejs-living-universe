"use strict";

// The durable scheduler parks a job that exhausted its attempt budget in
// "dead-letter" and never dispatches it again. Reviving it is an explicit act:
// `schedule` (which resets the attempt count) or `cancel`.
//
// That makes the state a value OWNERS have to understand, not just the worker.
// An owner that reconciles its persisted work at startup typically asks
// `list()` whether its job already exists and skips scheduling when it does --
// and a dead-lettered row answers "yes" while being, in every way that
// matters, absent. The job is then never revived, because scheduling it is the
// only thing that would, and the owner has just decided not to. One failure
// that has since been fixed in code stays fatal across every restart.
//
// So the constant lives here rather than inside the worker: the worker writes
// the state, owners read it, and there must be exactly one spelling of it.
const DEAD_LETTER_JOB_STATE = "dead-letter";

/**
 * True when a persisted job row is parked in dead-letter, i.e. the scheduler
 * will never dispatch it again on its own. Callers that treat an existing job
 * as "already armed" must exclude these.
 */
function isDeadLetteredJob(job) {
  return Boolean(job) && String(job.state || "") === DEAD_LETTER_JOB_STATE;
}

module.exports = {
  DEAD_LETTER_JOB_STATE,
  isDeadLetteredJob,
};
