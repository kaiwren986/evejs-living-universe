"use strict";
const store = require("./storeState");
const { events, OFFSET } = require("./licenseLifecycle");
const { createDurableSchedulerBinding } = require("../_shared/durableSchedulerBinding");
const log = require("../../utils/logger");
const JOB_TYPE = "account.license.lifecycle";
const binding = createDurableSchedulerBinding();
const publishers = new Set(), lanes = new Map(), dirty = new Set(), jobsRunning = new Set();
let listening = false;
function ensure(result) { if (!result?.success) throw new Error(result?.errorMsg || "LICENSE_LIFECYCLE_WRITE_FAILED"); return result.data; }
function lifecycle(accountID) { return store.readRuntimeAccount(accountID).licenseLifecycle; }
async function schedule(accountID, state) {
  const scheduler = binding.get();
  if (!scheduler || !state) return;
  if (state.outbox.length && !jobsRunning.has(accountID)) {
    await scheduler.schedule({ jobID: `license:${accountID}:notice:${state.outbox[0].revision}`,
      type: JOB_TYPE, dueAtMs: Date.now(), payload: { accountID } });
  }
  if (state.active) {
    const dueAtMs = Number((BigInt(state.expiryFileTime) - OFFSET) / 10000n) + 1;
    await scheduler.schedule({ jobID: `license:${accountID}:expiry:${state.expiryFileTime}`,
      type: JOB_TYPE, dueAtMs, payload: { accountID } });
  }
}
async function run(accountID) {
  ensure(store.reconcileLicenseAccount(accountID));
  // Persist a retry and expiry deadline before calling fallible publishers.
  await schedule(accountID, lifecycle(accountID));
  while (lifecycle(accountID).outbox.length) {
    const event = structuredClone(lifecycle(accountID).outbox[0]);
    await require("../skills/training/skillQueueRuntime").refreshAccountEntitlement(accountID);
    if (require("../chat/sessionRegistry").getSessions().some(session => Number(session.userid) === accountID)) {
      require("../subscription/subscriptionNotices").notifyAccountSubscriptionChanged(accountID, {
        cloneGrade: ["CreatedNotice", "ActivatedNotice"].includes(event.kind) ? 0 : 1,
        subscriptionEndTime: ["CreatedNotice", "ActivatedNotice"].includes(event.kind) ? null : BigInt(event.previousExpiryFileTime || event.expiryFileTime),
      });
    }
    if (!publishers.size) break;
    for (const publish of [...publishers]) {
      if (await publish({ accountID, ...event }) === false) throw new Error("LICENSE_NOTICE_PUBLICATION_FAILED");
    }
    ensure(store.acknowledgeLicenseNotice(accountID, event.revision));
  }
  await schedule(accountID, lifecycle(accountID));
  return { pending: lifecycle(accountID).outbox.length };
}
function reconcileAccount(accountID) {
  const id = Number(accountID);
  if (!Number.isSafeInteger(id) || id <= 0) return Promise.reject(new Error("INVALID_LICENSE_ACCOUNT"));
  if (lanes.has(id)) { dirty.add(id); return lanes.get(id); }
  const work = Promise.resolve().then(async () => {
    let result;
    do { dirty.delete(id); result = await run(id); } while (dirty.has(id));
    return result;
  }).finally(() => { lanes.delete(id); dirty.delete(id); });
  lanes.set(id, work);
  return work;
}
function wake(accountID) {
  void reconcileAccount(accountID).catch(error => log.warn(`[LicenseLifecycle] recovery pending: ${error.message}`));
}
function updateListener() {
  const needed = publishers.size > 0 || binding.get() !== null;
  if (needed && !listening) { events.on("changed", wake); listening = true; }
  else if (!needed && listening) { events.off("changed", wake); listening = false; }
}
function subscribe(publish) {
  if (typeof publish !== "function") throw new TypeError("license notice publisher must be a function");
  publishers.add(publish); updateListener();
  return () => { publishers.delete(publish); updateListener(); };
}
function bindDurableScheduler(scheduler) { binding.bind(scheduler); updateListener(); return true; }
function unbindDurableScheduler(scheduler) { const result = binding.unbind(scheduler); updateListener(); return result; }
async function reconcile() {
  for (const id of store.listLicenseAccountIDs()) await reconcileAccount(id);
  return { accounts: store.listLicenseAccountIDs().length };
}
async function handleJob(job) {
  const accountID = Number(job?.payload?.accountID);
  jobsRunning.add(accountID);
  try {
    const result = await reconcileAccount(accountID);
    if (result.pending) throw new Error("LICENSE_NOTICE_PUBLISHER_UNAVAILABLE");
    return { success: true };
  } finally { jobsRunning.delete(accountID); }
}
async function whenIdle() { await Promise.allSettled([...lanes.values()]); }
module.exports = { JOB_TYPE, subscribe, bindDurableScheduler, unbindDurableScheduler,
  reconcileAccount, reconcile, handleJob, whenIdle };
