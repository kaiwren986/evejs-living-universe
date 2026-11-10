"use strict";

/**
 * What a client is told of its account's subscription without asking.
 *
 * OnSubscriptionTimeUpdateServer(omegaTime) carries what GetSubscriptionTime
 * answers: the end of the account's Omega time, a long, or None for an Alpha.
 * Tranquility addresses it by clientID, and sends it as the first thing of
 * every charUnboundMgr.SelectCharacterID.
 *
 * OnSubscriptionChangedServer(new_state) carries the clone grade from now on.
 * The client's clone grade service keeps the grade it was answered at its
 * login and takes this notice's word after that (clone_grade_svc 243). No
 * recording has it: it is addressed as its recorded sibling is, and sent to
 * an account's sessions when the grade changes under them.
 *
 * The grade changes under a client in two ways: Omega days are bought, and
 * Omega time runs out. For the second a watch is kept on the end of an
 * account's Omega time, from every telling of its subscription to a client.
 */

const path = require("path");
const sessionRegistry = require(path.join(__dirname, "../chat/sessionRegistry"));
const {
  buildFiletimeLong,
  currentFileTime,
} = require(path.join(__dirname, "../_shared/serviceHelpers"));
const {
  getSubscriptionState,
} = require(path.join(__dirname, "./subscriptionState"));

const SUBSCRIPTION_TIME_NOTICE = "OnSubscriptionTimeUpdateServer";
const SUBSCRIPTION_CHANGED_NOTICE = "OnSubscriptionChangedServer";
const SUBSCRIPTION_NOTICE_ID_TYPE = "clientID";
const FILETIME_TICKS_PER_MS = 10000n;
// A timer asked to wait longer than this fires at once.
const LONGEST_TIMER_WAIT_MS = 2147483647;

const REAL_TIMERS = {
  setTimeout: (fire, waitMs) => setTimeout(fire, waitMs),
  clearTimeout: (timer) => clearTimeout(timer),
};
let timers = REAL_TIMERS;
// accountID -> the timer that waits for the end of the Omega time last told
const watches = new Map();

function canBeSentNotices(session) {
  return Boolean(session) && typeof session.sendNotification === "function";
}

/**
 * Keeps one watch for an account, on the end of the Omega time its clients
 * were just told. When the wait is over the account's sessions are told
 * what is not as it was told then, and the watch is kept on what is told
 * them: so an end beyond a timer's longest wait is waited for in parts, and
 * a timer that fires before the end waits again. An Alpha has no end, and
 * no watch.
 */
function watchSubscriptionEnd(accountID, told) {
  timers.clearTimeout(watches.get(accountID));
  watches.delete(accountID);
  if (told.subscriptionEndTime === null) {
    return;
  }
  const waitMs = Number(
    (told.subscriptionEndTime - currentFileTime()) / FILETIME_TICKS_PER_MS,
  );
  const timer = timers.setTimeout(
    () => notifyAccountSubscriptionChanged(accountID, told),
    Math.min(waitMs, LONGEST_TIMER_WAIT_MS),
  );
  // The watch is not a reason for the server to stay up.
  timer.unref();
  watches.set(accountID, timer);
}

/**
 * An account's subscription as a client of it is told it now, by an answer
 * or by a notice: the watch on its end is kept from here.
 */
function subscriptionToldTo(accountID) {
  const numericAccountID = Number(accountID) || 0;
  const state = getSubscriptionState(numericAccountID);
  if (numericAccountID > 0) {
    watchSubscriptionEnd(numericAccountID, state);
  }
  return state;
}

/** Tells one session the end of its account's Omega time. */
function sendSubscriptionTimeUpdate(
  session,
  state = subscriptionToldTo(session && session.userid),
) {
  if (!canBeSentNotices(session)) {
    return false;
  }
  session.sendNotification(SUBSCRIPTION_TIME_NOTICE, SUBSCRIPTION_NOTICE_ID_TYPE, [
    state.subscriptionEndTime !== null
      ? buildFiletimeLong(state.subscriptionEndTime)
      : null,
  ]);
  return true;
}

/**
 * Tells an account's sessions of a subscription that is not what it was:
 * the new end time, where that moved, and the new grade, where that changed.
 * `previous` is the account's state as it was read before the change; where
 * nothing of it changed, nothing is told.
 */
function notifyAccountSubscriptionChanged(accountID, previous) {
  const state = subscriptionToldTo(accountID);
  const timeChanged = state.subscriptionEndTime !== previous.subscriptionEndTime;
  const gradeChanged = state.cloneGrade !== previous.cloneGrade;

  for (const session of sessionRegistry.getSessions()) {
    if (Number(session.userid) !== Number(accountID) || !canBeSentNotices(session)) {
      continue;
    }
    if (timeChanged) {
      sendSubscriptionTimeUpdate(session, state);
    }
    if (gradeChanged) {
      session.sendNotification(
        SUBSCRIPTION_CHANGED_NOTICE,
        SUBSCRIPTION_NOTICE_ID_TYPE,
        [state.cloneGrade],
      );
    }
  }
}

module.exports = {
  SUBSCRIPTION_CHANGED_NOTICE,
  SUBSCRIPTION_TIME_NOTICE,
  notifyAccountSubscriptionChanged,
  sendSubscriptionTimeUpdate,
  subscriptionToldTo,
  _testing: {
    /** Timers of a test's own in place of the real ones; nothing given puts the real ones back. */
    setTimers(hooks) {
      timers = hooks || REAL_TIMERS;
    },
    forgetWatches() {
      for (const timer of watches.values()) {
        timers.clearTimeout(timer);
      }
      watches.clear();
    },
    watchedAccounts: () => [...watches.keys()],
  },
};
