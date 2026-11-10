"use strict";

// The durable scheduler's side of contract settlement. The settlement store
// (contractSettlementState.js) holds pending settlements and queues their jobs; the
// contract runtime registers the step that settles one when it loads. A scheduled job
// can run before anything else has loaded the runtime, so this module loads it on
// first use. Nothing requires this module back, so it closes no require cycle.

const path = require("node:path");

const settlementState = require(path.join(__dirname, "./contractSettlementState"));

function ensureContractRuntimeLoaded() {
  require(path.join(__dirname, "./contractRuntimeState"));
}

function handleDurableContractSettlement(job = {}) {
  ensureContractRuntimeLoaded();
  return settlementState.handleDurableContractSettlement(job);
}

module.exports = {
  DURABLE_SETTLEMENT_JOB_TYPE: settlementState.DURABLE_SETTLEMENT_JOB_TYPE,
  bindDurableScheduler: settlementState.bindDurableScheduler,
  handleDurableContractSettlement,
  reconcileDurableContractSettlements: settlementState.reconcileDurableContractSettlements,
  unbindDurableScheduler: settlementState.unbindDurableScheduler,
};
