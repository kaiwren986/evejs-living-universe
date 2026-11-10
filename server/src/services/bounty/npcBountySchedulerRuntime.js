"use strict";

const path = require("node:path");
const bountyRuntime = require(path.join(__dirname, "bountyRuntime"));
const { createDurableScheduler } = require(path.join(
  __dirname,
  "../scheduler/durableScheduler",
));

function createNpcBountyPayoutHandler(owner = bountyRuntime) {
  return async function handlePayoutJob(job) {
    const bucketKey = String(
      job && job.payload && job.payload.bucketKey || "",
    ).trim();
    if (!bucketKey) {
      throw new Error("NPC bounty payout job is missing its bucket key");
    }

    const pendingBefore = owner.listPendingBuckets().find(
      (bucket) => bucket && bucket.key === bucketKey,
    );
    if (!pendingBefore) {
      return { alreadySettled: true, bucketKey };
    }

    const flush = await owner.flushDuePayouts(Date.now());
    const stillPending = owner.listPendingBuckets().some(
      (bucket) => bucket && bucket.key === bucketKey,
    );
    if (stillPending) {
      const bucketResult = Array.isArray(flush && flush.results)
        ? flush.results.find((entry) => entry && entry.key === bucketKey)
        : null;
      const reason = bucketResult && bucketResult.result && bucketResult.result.errorMsg
        || "NPC bounty payout remains pending";
      throw new Error(reason);
    }

    return {
      alreadySettled: false,
      amount: pendingBefore.amount,
      bucketKey,
    };
  };
}

function createNpcBountySchedulerRuntime(options = {}) {
  const owner = options.bountyRuntime || bountyRuntime;
  const scheduler = options.scheduler || createDurableScheduler(
    options.schedulerOptions,
  );
  let state = "idle";
  let startPromise = null;
  let shutdownPromise = null;
  let unregisterHandler = null;
  let startResult = null;
  const handlePayoutJob = createNpcBountyPayoutHandler(owner);

  function start() {
    if (state === "started") {
      return Promise.resolve(startResult);
    }
    if (startPromise) {
      return startPromise;
    }
    if (state === "closing" || state === "closed") {
      return Promise.reject(
        new Error("NPC bounty scheduler runtime is shutting down"),
      );
    }

    state = "starting";
    unregisterHandler = scheduler.register(owner.DURABLE_PAYOUT_JOB_TYPE, handlePayoutJob);
    startPromise = (async () => {
      try {
        const reconciliation = await owner.attachDurableScheduler(scheduler);
        await scheduler.start();
        state = "started";
        startResult = Object.freeze({
          reconciledJobs: Number(reconciliation && reconciliation.scheduled) || 0,
        });
        return startResult;
      } catch (error) {
        owner.detachDurableScheduler(scheduler);
        if (unregisterHandler) unregisterHandler();
        unregisterHandler = null;
        await scheduler.shutdown().catch(() => null);
        state = "closed";
        throw error;
      } finally {
        startPromise = null;
      }
    })();
    return startPromise;
  }

  function shutdown() {
    if (shutdownPromise) {
      return shutdownPromise;
    }
    state = "closing";
    shutdownPromise = (async () => {
      if (startPromise) {
        await startPromise.catch(() => null);
      }
      owner.detachDurableScheduler(scheduler);
      if (unregisterHandler) unregisterHandler();
      unregisterHandler = null;
      await scheduler.shutdown();
      state = "closed";
      return true;
    })();
    return shutdownPromise;
  }

  return Object.freeze({
    getState: () => state,
    handlePayoutJob,
    shutdown,
    start,
  });
}

module.exports = {
  createNpcBountyPayoutHandler,
  createNpcBountySchedulerRuntime,
};
