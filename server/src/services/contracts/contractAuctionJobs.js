"use strict";

// Expiry changes eligibility; the two native claim actions still own transfers.
const { createDurableSchedulerBinding } = require("../_shared/durableSchedulerBinding");
const binding = createDurableSchedulerBinding();
const JOB_TYPE = "contracts.auction-expiry";
const runtime = () => require("./contractRuntimeState");
function expiryMs(record) {
  return Number((BigInt(record.dateExpired) - 116444736000000000n) / 10000n);
}
async function scheduleContract(record) {
  if (!binding.get() || !record || record.type !== 2 || record.status !== 0 || record.auctionEnded) return;
  await binding.get().schedule({
    jobID: `auction-expiry:${record.contractID}`, type: JOB_TYPE,
    dueAtMs: expiryMs(record), payload: { contractID: record.contractID },
  });
}
async function handleJob(job) {
  const result = await runtime().reconcileAuctionExpiry(Number(job?.payload?.contractID));
  if (!result?.success) throw new Error(result?.errorMsg || "AUCTION_EXPIRY_PENDING");
  return result;
}
async function reconcile() {
  let scheduled = 0;
  for (const record of runtime().listContractRecords()) {
    if (record.type !== 2 || record.status !== 0 || record.auctionEnded) continue;
    await scheduleContract(record);
    scheduled++;
  }
  return { scheduled };
}
module.exports = {
  JOB_TYPE, scheduleContract, handleJob, reconcile,
  bindDurableScheduler: binding.bind, unbindDurableScheduler: binding.unbind,
};
