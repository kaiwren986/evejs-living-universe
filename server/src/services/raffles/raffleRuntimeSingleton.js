"use strict";

const path = require("path");

const RaffleRuntime = require(path.join(__dirname, "./raffleRuntime"));

const runtime = new RaffleRuntime();

function getRaffleRuntime() {
  return runtime;
}

function resetRaffleRuntime() {
  runtime.reset();
  return runtime;
}

function bindDurableScheduler(scheduler) {
  return runtime.bindDurableScheduler(scheduler);
}

function unbindDurableScheduler(scheduler = null) {
  return runtime.unbindDurableScheduler(scheduler);
}

function reconcileDurableRaffles() {
  return runtime.reconcileDurableRaffles();
}

function handleDurableRaffleExpiry(job) {
  return runtime.handleDurableRaffleExpiry(job);
}

function handleDurableRaffleSettlement(job) {
  return runtime.handleDurableRaffleSettlement(job);
}

module.exports = {
  DURABLE_EXPIRY_JOB_TYPE: RaffleRuntime.DURABLE_EXPIRY_JOB_TYPE,
  DURABLE_SETTLEMENT_JOB_TYPE: RaffleRuntime.DURABLE_SETTLEMENT_JOB_TYPE,
  bindDurableScheduler,
  getRaffleRuntime,
  handleDurableRaffleExpiry,
  handleDurableRaffleSettlement,
  reconcileDurableRaffles,
  resetRaffleRuntime,
  unbindDurableScheduler,
};
