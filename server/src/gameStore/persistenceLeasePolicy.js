"use strict";

// Side-effect-free timing contract shared by the journal, GameStore owners,
// and the supervisors whose startup deadline must encompass lease recovery.
const MIN_LEASE_MS = 1_000;
const MIN_CONFIGURED_LEASE_MS = 3_000;
const DEFAULT_LEASE_MS = 30_000;
const ACQUISITION_GRACE_MS = 5_000;
const ACQUISITION_POLL_MS = 100;
const OUTER_STARTUP_GRACE_MS = 10_000;

function normalizeLeaseMs(value = DEFAULT_LEASE_MS) {
  const leaseMs = Number(value);
  if (!Number.isSafeInteger(leaseMs) || leaseMs < MIN_LEASE_MS) {
    throw new TypeError(
      `persistence lease must be an integer of at least ${MIN_LEASE_MS}ms`,
    );
  }
  return leaseMs;
}

// Environment/config values use a stricter floor than direct focused journal
// tests. Invalid values converge on the same production default everywhere.
function configuredLeaseMs(value) {
  const leaseMs = Number(value);
  return Number.isSafeInteger(leaseMs) && leaseMs >= MIN_CONFIGURED_LEASE_MS
    ? leaseMs
    : DEFAULT_LEASE_MS;
}

function acquisitionWaitMs(leaseMs = DEFAULT_LEASE_MS) {
  return normalizeLeaseMs(leaseMs) + ACQUISITION_GRACE_MS;
}

function configuredAcquisitionWaitMs(value, leaseMs = DEFAULT_LEASE_MS) {
  const waitMs = Number(value);
  return Number.isSafeInteger(waitMs) && waitMs >= 0
    ? waitMs
    : acquisitionWaitMs(leaseMs);
}

function recommendedOuterStartupTimeoutMs(
  leaseMs = DEFAULT_LEASE_MS,
  acquisitionWaitValue,
) {
  return configuredAcquisitionWaitMs(acquisitionWaitValue, leaseMs) +
    OUTER_STARTUP_GRACE_MS;
}

const DEFAULT_ACQUISITION_WAIT_MS = acquisitionWaitMs();
const RECOMMENDED_OUTER_STARTUP_TIMEOUT_MS =
  recommendedOuterStartupTimeoutMs();

module.exports = Object.freeze({
  MIN_LEASE_MS,
  MIN_CONFIGURED_LEASE_MS,
  DEFAULT_LEASE_MS,
  ACQUISITION_GRACE_MS,
  ACQUISITION_POLL_MS,
  OUTER_STARTUP_GRACE_MS,
  DEFAULT_ACQUISITION_WAIT_MS,
  RECOMMENDED_OUTER_STARTUP_TIMEOUT_MS,
  acquisitionWaitMs,
  configuredAcquisitionWaitMs,
  configuredLeaseMs,
  normalizeLeaseMs,
  recommendedOuterStartupTimeoutMs,
});
