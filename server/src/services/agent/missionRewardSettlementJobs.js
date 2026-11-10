"use strict";

// The durable scheduler's side of mission reward settlement. The settlement store
// (missionRewardSettlementState.js) holds pending settlements and queues their jobs; the
// startup recovery pass (missionRewardSettlementRecovery.js) registers itself with the
// store when it loads. The scheduler's reconcile can run before anything else has loaded
// that pass, so this module loads it first. Nothing requires this module back, so it
// closes no require cycle.

const path = require("node:path");

const settlementState = require(path.join(__dirname, "./missionRewardSettlementState"));

function ensureStartupRecoveryLoaded() {
  require(path.join(__dirname, "./missionRewardSettlementRecovery"));
}

function reconcileDurableMissionRewardSettlements(options = {}) {
  if (options.heal !== false && !options.recovery) {
    ensureStartupRecoveryLoaded();
  }
  return settlementState.reconcileDurableMissionRewardSettlements(options);
}

module.exports = {
  DURABLE_SETTLEMENT_JOB_TYPE: settlementState.DURABLE_SETTLEMENT_JOB_TYPE,
  bindDurableScheduler: settlementState.bindDurableScheduler,
  handleDurableMissionRewardSettlement: settlementState.handleDurableMissionRewardSettlement,
  reconcileDurableMissionRewardSettlements,
  unbindDurableScheduler: settlementState.unbindDurableScheduler,
};
