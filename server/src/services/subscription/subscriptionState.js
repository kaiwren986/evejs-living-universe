"use strict";

/**
 * An account's subscription as the server reckons it: its clone grade and the
 * end of its Omega time. subscriptionMgr answers from this, and so does
 * anything that tells a client of its account's subscription.
 */

const path = require("path");
const config = require(path.join(__dirname, "../../config"));
const log = require(path.join(__dirname, "../../utils/logger"));
const {
  currentFileTime,
} = require(path.join(__dirname, "../_shared/serviceHelpers"));
const {
  resolveOmegaLicenseState,
} = require(path.join(__dirname, "../newEdenStore/storeState"));

const CLONE_STATE_ALPHA = 0;
const CLONE_STATE_OMEGA = 1;
const FILETIME_TICKS_PER_DAY = 864000000000n;
const OMEGA_EXPIRY_FILETIME = 157469184000000000n; // 2100-01-01T00:00:00Z

function readCloneGradeOverride() {
  const raw = process.env.EVE_CLONE_GRADE;
  if (!raw) {
    return null;
  }

  const val = String(raw).trim().toLowerCase();
  if (val === "omega") return CLONE_STATE_OMEGA;
  if (val === "alpha" || val === "trial") return CLONE_STATE_ALPHA;

  const parsed = Number.parseInt(val, 10);
  if (parsed === CLONE_STATE_ALPHA || parsed === CLONE_STATE_OMEGA) {
    return parsed;
  }

  log.warn(
    `[SubscriptionMgr] Unsupported EVE_CLONE_GRADE="${raw}", defaulting to config-driven state`,
  );
  return null;
}

function resolveCloneGrade(accountID) {
  // This client build only cleanly recognizes Alpha (0) and Omega (1).
  const override = readCloneGradeOverride();
  if (override !== null) {
    return override;
  }

  const omegaState = resolveOmegaLicenseState(accountID);
  if (omegaState && omegaState.hasLicense) {
    return CLONE_STATE_OMEGA;
  }

  return config.omegaLicenseEnabled === false
    ? CLONE_STATE_ALPHA
    : CLONE_STATE_OMEGA;
}

function getSubscriptionState(accountID) {
  const cloneGrade = resolveCloneGrade(accountID);
  const isSubscribed = cloneGrade === CLONE_STATE_OMEGA;
  const omegaState = resolveOmegaLicenseState(accountID);
  const subscriptionEndTime =
    isSubscribed && omegaState && omegaState.expiryFileTime
      ? BigInt(omegaState.expiryFileTime)
      : isSubscribed
        ? OMEGA_EXPIRY_FILETIME
        : null;
  let subscriptionDaysRemaining = 0;

  if (subscriptionEndTime !== null) {
    const ticksRemaining = subscriptionEndTime - currentFileTime();
    if (ticksRemaining > 0n) {
      subscriptionDaysRemaining = Number(
        (ticksRemaining + FILETIME_TICKS_PER_DAY - 1n) / FILETIME_TICKS_PER_DAY,
      );
    }
  }

  return {
    cloneGrade,
    isSubscribed,
    subscriptionEndTime,
    subscriptionDaysRemaining,
  };
}

module.exports = {
  CLONE_STATE_ALPHA,
  CLONE_STATE_OMEGA,
  getSubscriptionState,
  readCloneGradeOverride,
  resolveCloneGrade,
};
