"use strict";

const path = require("node:path");
const { performance } = require("node:perf_hooks");

const log = require(path.join(__dirname, "../../utils/logger"));
const defaultWorkerPool = require(path.join(__dirname, "./killmailWorkerPool"));
const defaultKillmailState = require(path.join(__dirname, "./killmailState"));
const {
  prepareKillmailRecord,
} = require(path.join(__dirname, "./killmailPreparationTasks"));

function cloneTerminalEvent(record) {
  if (typeof structuredClone === "function") {
    return structuredClone(record);
  }
  return JSON.parse(JSON.stringify(record));
}

function createPipeline(options = {}) {
  const workerPool = options.workerPool || defaultWorkerPool;
  const killmailState = options.killmailState || defaultKillmailState;
  const prepare = options.prepareKillmailRecord || prepareKillmailRecord;
  let commitTail = null;
  let pendingCommits = 0;
  let accepting = true;
  let recoveryStarted = false;
  const stats = {
    accepted: 0,
    committed: 0,
    commitFailed: 0,
    fanoutFailed: 0,
    inline: 0,
    worker: 0,
    workerFallback: 0,
    recovered: 0,
    pendingFinalizeFailed: 0,
    reservationFailed: 0,
    mainSubmitMs: 0,
    mainSubmitMaxMs: 0,
  };

  function snapshotStats() {
    return {
      ...stats,
      pendingCommits,
      accepting,
      worker: {
        selected: stats.worker,
        ...workerPool.getStats(),
      },
    };
  }

  function enqueue(recordInput, enqueueOptions = {}) {
    const submitStartedAtMs = performance.now();
    if (!accepting) {
      return {
        success: false,
        errorMsg: "KILLMAIL_PIPELINE_SHUTTING_DOWN",
        killID: null,
        completion: Promise.resolve(null),
      };
    }

    let reservation = enqueueOptions._reservation || null;
    if (!reservation) {
      if (typeof killmailState.reserveKillmailEvent === "function") {
        reservation = killmailState.reserveKillmailEvent(recordInput);
      } else {
        const legacyKillID = killmailState.reserveKillmailID();
        reservation = legacyKillID
          ? {
              killID: legacyKillID,
              record: cloneTerminalEvent(recordInput),
              preparationOptions: killmailState.buildKillmailPreparationOptions(
                recordInput,
                legacyKillID,
              ),
            }
          : null;
      }
    }
    const killID = reservation && Number(reservation.killID) > 0
      ? Math.trunc(Number(reservation.killID))
      : null;
    if (!killID) {
      stats.reservationFailed += 1;
      return {
        success: false,
        errorMsg: "KILLMAIL_ID_RESERVATION_FAILED",
        killID: null,
        completion: Promise.resolve(null),
      };
    }

    // Reservations already own a detached snapshot. `postMessage` performs the
    // worker handoff clone synchronously, so another full clone here would add
    // main-thread cost without strengthening isolation.
    const terminalEvent = reservation.record || cloneTerminalEvent(recordInput);
    const preparationOptions = reservation.preparationOptions ||
      killmailState.buildKillmailPreparationOptions(terminalEvent, killID);
    const plan = workerPool.plan(terminalEvent, preparationOptions);
    const submitMs = performance.now() - submitStartedAtMs;
    stats.mainSubmitMs += submitMs;
    stats.mainSubmitMaxMs = Math.max(stats.mainSubmitMaxMs, submitMs);
    let preparedOutcome;
    if (plan.mode === "worker") {
      stats.worker += 1;
      preparedOutcome = plan.promise.then(
        (prepared) => ({ prepared, error: null, mode: "worker" }),
        (error) => ({ prepared: null, error, mode: "worker-fallback" }),
      );
    } else {
      stats.inline += 1;
      preparedOutcome = Promise.resolve({
        prepared: null,
        error: null,
        mode: `inline-${plan.reason}`,
      });
    }

    stats.accepted += 1;
    if (enqueueOptions._recovered === true) {
      stats.recovered += 1;
    }
    pendingCommits += 1;
    const previous = commitTail || Promise.resolve();
    const completion = previous.catch(() => null).then(async () => {
      let outcome = await preparedOutcome;
      if (!outcome.prepared) {
        if (outcome.error) {
          stats.workerFallback += 1;
          log.warn(
            `[KillmailWorker] Falling back inline for killID=${killID}: ` +
            `${outcome.error.message}`,
          );
        }
        try {
          outcome = {
            ...outcome,
            prepared: prepare(terminalEvent, preparationOptions),
          };
        } catch (error) {
          stats.commitFailed += 1;
          log.err(
            `[KillmailWorker] Failed to prepare killID=${killID}: ${error.message}`,
          );
          return null;
        }
      }

      const record = killmailState.commitPreparedKillmailRecord(
        outcome.prepared.record,
        outcome.prepared.projection,
      );
      if (!record) {
        stats.commitFailed += 1;
        log.err(`[KillmailWorker] Failed to commit killID=${killID}`);
        return null;
      }
      stats.committed += 1;

      let fanoutSucceeded = true;
      if (typeof enqueueOptions.onCommitted === "function") {
        try {
          const fanoutResult = await enqueueOptions.onCommitted(record, {
            mode: outcome.mode,
            prepareMs: Number(outcome.prepared.prepareMs) || 0,
            queueMs: Number(outcome.prepared.queueMs) || 0,
            wallMs: Number(outcome.prepared.wallMs) || 0,
          });
          if (fanoutResult && fanoutResult.success === false) {
            throw new Error(
              fanoutResult.errorMsg || "post-commit fan-out was not accepted",
            );
          }
        } catch (error) {
          fanoutSucceeded = false;
          stats.fanoutFailed += 1;
          log.warn(
            `[KillmailWorker] Post-commit fan-out failed for killID=${killID}: ` +
            `${error.message}`,
          );
        }
      }
      if (
        fanoutSucceeded &&
        typeof killmailState.completePendingKillmailEvent === "function" &&
        killmailState.completePendingKillmailEvent(killID) !== true
      ) {
        stats.pendingFinalizeFailed += 1;
        log.warn(
          `[KillmailWorker] Could not finalize durable pending killID=${killID}`,
        );
      }
      return record;
    }).catch((error) => {
      stats.commitFailed += 1;
      log.err(
        `[KillmailWorker] Ordered commit failed for killID=${killID}: ${error.message}`,
      );
      return null;
    });

    const trackedCompletion = completion.finally(() => {
      pendingCommits -= 1;
      if (commitTail === trackedCompletion) {
        commitTail = null;
      }
    });
    commitTail = trackedCompletion;
    // Product callers intentionally fire-and-forget; attach a rejection
    // observer immediately even though completion is also returned for drains
    // and tests.
    trackedCompletion.catch(() => {});

    return {
      success: true,
      killID,
      mode: plan.mode === "worker" ? "worker" : `inline-${plan.reason}`,
      submitMs,
      completion: trackedCompletion,
    };
  }

  async function drain() {
    const tail = commitTail;
    if (tail) {
      await tail;
    }
    await workerPool.drain();
    return snapshotStats();
  }

  function recoverPending(recoveryOptions = {}) {
    if (recoveryStarted) {
      return [];
    }
    recoveryStarted = true;
    if (typeof killmailState.listPendingKillmailEvents !== "function") {
      return [];
    }
    let reservations;
    try {
      reservations = killmailState.listPendingKillmailEvents();
    } catch (error) {
      log.err(`[KillmailWorker] Could not read pending recovery work: ${error.message}`);
      return [];
    }
    const receipts = [];
    for (const reservation of reservations) {
      try {
        receipts.push(enqueue(reservation.record || {}, {
          onCommitted: recoveryOptions.onCommitted,
          _reservation: reservation,
          _recovered: true,
        }));
      } catch (error) {
        log.err(
          `[KillmailWorker] Could not recover killID=${reservation.killID}: ` +
          `${error.message}`,
        );
      }
    }
    return receipts;
  }

  async function shutdown() {
    accepting = false;
    await drain();
    await workerPool.shutdown();
    return snapshotStats();
  }

  return {
    enqueue,
    recoverPending,
    drain,
    shutdown,
    getStats: snapshotStats,
  };
}

const pipeline = createPipeline();

module.exports = {
  enqueue: pipeline.enqueue,
  recoverPending: pipeline.recoverPending,
  drain: pipeline.drain,
  shutdown: pipeline.shutdown,
  getStats: pipeline.getStats,
  _createPipelineForTests: createPipeline,
};
