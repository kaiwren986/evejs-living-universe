"use strict";

/**
 * Subscription Manager Service (subscriptionMgr)
 *
 * Handles subscription/account status queries from the client.
 * Modern EVE clients call this during the login flow.
 */

const path = require("path");
const BaseService = require(path.join(__dirname, "../baseService"));
const log = require(path.join(__dirname, "../../utils/logger"));
const {
  buildFiletimeLong,
} = require(path.join(__dirname, "../_shared/serviceHelpers"));
const {
  subscriptionToldTo,
} = require(path.join(__dirname, "./subscriptionNotices"));

class SubscriptionMgrService extends BaseService {
  constructor() {
    super("subscriptionMgr");
  }

  _getSubscriptionState(session) {
    // An answer is a telling: the watch on the end of the account's Omega
    // time is kept from it.
    return subscriptionToldTo(session && session.userid);
  }

  Handle_GetSubscriptionTime(args, session) {
    const state = this._getSubscriptionState(session);
    log.debug(
      `[SubscriptionMgr] GetSubscriptionTime -> ${state.subscriptionEndTime !== null ? state.subscriptionEndTime.toString() : "null"}`,
    );
    return state.subscriptionEndTime !== null
      ? buildFiletimeLong(state.subscriptionEndTime)
      : null;
  }

  Handle_GetCloneGrade(args, session) {
    const state = this._getSubscriptionState(session);
    log.debug(`[SubscriptionMgr] GetCloneGrade -> ${state.cloneGrade}`);
    return state.cloneGrade;
  }
}

module.exports = SubscriptionMgrService;
