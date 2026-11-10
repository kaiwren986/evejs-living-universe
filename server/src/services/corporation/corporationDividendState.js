"use strict";

const {
  cloneValue,
} = require("../../common/clone");

const path = require("path");

const database = require(path.join(__dirname, "../../gameStore"));
const log = require(path.join(__dirname, "../../utils/logger"));
const { NOTIFICATIONS_TABLE } = require(path.join(
  __dirname,
  "../notifications/notificationState",
));
const {
  CORPORATION_RUNTIME_TABLE,
  ensureRuntimeInitialized,
  getCorporationRuntime,
  normalizePositiveInteger,
  updateCorporationRuntime,
  updateRuntimeState,
} = require(path.join(__dirname, "./corporationRuntimeState"));
const {
  CORPORATION_WALLET_KEY_START,
  distributeCorporationWalletAsync,
} = require(path.join(__dirname, "./corpWalletState"));
const {
  notifyCorporationDividendPaid,
} = require(path.join(__dirname, "./corpLifecycleNotifications"));

const DURABLE_SETTLEMENT_JOB_TYPE = "corporation.dividend-settle";
const DURABLE_SETTLEMENT_JOB_PREFIX = "corporation-dividend:";
const settlementLanes = new Map();
let durableScheduler = null;

function roundIsk(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.round(numeric * 100) / 100 : 0;
}

function settlementKey(settlementID) {
  return String(normalizePositiveInteger(settlementID, 0) || 0);
}

function getPendingCorporationDividend(corporationID, settlementID) {
  const runtime = getCorporationRuntime(corporationID);
  return cloneValue(
    runtime && runtime.dividendSettlements &&
      runtime.dividendSettlements[settlementKey(settlementID)] || null,
  );
}

function listPendingCorporationDividends() {
  const table = ensureRuntimeInitialized();
  const pending = [];
  for (const runtime of Object.values(table.corporations || {})) {
    for (const settlement of Object.values(
      runtime && runtime.dividendSettlements || {},
    )) {
      if (settlement) {
        pending.push(cloneValue(settlement));
      }
    }
  }
  return pending.sort((left, right) => left.settlementID - right.settlementID);
}

function flushRuntime() {
  const result = database.flushTableSync(CORPORATION_RUNTIME_TABLE);
  return Boolean(result && result.success);
}

function updateSettlement(corporationID, settlementID, updater) {
  let nextSettlement = null;
  const result = updateCorporationRuntime(corporationID, (runtime) => {
    runtime.dividendSettlements = runtime.dividendSettlements &&
      typeof runtime.dividendSettlements === "object"
      ? runtime.dividendSettlements
      : {};
    const key = settlementKey(settlementID);
    const current = runtime.dividendSettlements[key];
    if (!current) {
      return runtime;
    }
    const next = typeof updater === "function"
      ? updater(cloneValue(current))
      : current;
    if (next === null) {
      delete runtime.dividendSettlements[key];
    } else {
      runtime.dividendSettlements[key] = cloneValue(next);
      nextSettlement = cloneValue(next);
    }
    return runtime;
  });
  if (!result || result.success !== true || !flushRuntime()) {
    return { success: false, errorMsg: "DIVIDEND_WRITE_FAILED" };
  }
  return { success: true, data: nextSettlement };
}

function buildSettlementJob(corporationID, settlementID) {
  const normalizedCorporationID = normalizePositiveInteger(corporationID, 0);
  const normalizedSettlementID = normalizePositiveInteger(settlementID, 0);
  return normalizedCorporationID && normalizedSettlementID
    ? {
        jobID:
          `${DURABLE_SETTLEMENT_JOB_PREFIX}${normalizedSettlementID}`,
        type: DURABLE_SETTLEMENT_JOB_TYPE,
        dueAtMs: Date.now(),
        payload: {
          corporationID: normalizedCorporationID,
          settlementID: normalizedSettlementID,
        },
      }
    : null;
}

async function scheduleSettlement(corporationID, settlementID) {
  const job = buildSettlementJob(corporationID, settlementID);
  if (!job || !durableScheduler) {
    return null;
  }
  await durableScheduler.schedule(job);
  return job;
}

function queueSettlement(corporationID, settlementID) {
  if (!durableScheduler) {
    return;
  }
  void scheduleSettlement(corporationID, settlementID).catch((error) => {
    log.warn(
      `[CorporationDividend] scheduling failed settlement=${settlementID}: ${error.message}`,
    );
  });
}

function prepareCorporationDividend(options = {}) {
  const corporationID = normalizePositiveInteger(options.corporationID, 0);
  const totalAmount = roundIsk(options.totalAmount);
  const allocations = (Array.isArray(options.allocations)
    ? options.allocations
    : [])
    .map((allocation) => ({
      kind: allocation && allocation.kind === "corporation"
        ? "corporation"
        : "character",
      ownerID: normalizePositiveInteger(allocation && allocation.ownerID, 0),
      amount: roundIsk(allocation && allocation.amount),
    }))
    .filter((allocation) => allocation.ownerID > 0 && allocation.amount > 0);
  const allocatedTotal = roundIsk(
    allocations.reduce((total, allocation) => total + allocation.amount, 0),
  );
  if (
    !corporationID ||
    !(totalAmount > 0) ||
    allocations.length === 0 ||
    Math.abs(allocatedTotal - totalAmount) > 0.0001
  ) {
    return { success: false, errorMsg: "INVALID_DIVIDEND" };
  }

  let settlement = null;
  const writeResult = updateRuntimeState((table) => {
    const runtime = table.corporations[String(corporationID)];
    if (!runtime) {
      return table;
    }
    const settlementID = normalizePositiveInteger(
      table._meta.nextDividendSettlementID,
      1,
    ) || 1;
    table._meta.nextDividendSettlementID = settlementID + 1;
    runtime.dividendSettlements = runtime.dividendSettlements &&
      typeof runtime.dividendSettlements === "object"
      ? runtime.dividendSettlements
      : {};
    settlement = {
      settlementID,
      corporationID,
      totalAmount,
      allocations: cloneValue(allocations),
      payShareholders: options.payShareholders === true,
      walletCommandID:
        `corporation-dividend:${settlementID}:wallet`,
      walletApplied: false,
      notificationsApplied: false,
      createdAt: new Date().toISOString(),
    };
    runtime.dividendSettlements[String(settlementID)] = cloneValue(settlement);
    return table;
  });
  if (!writeResult || writeResult.success !== true || !settlement) {
    return { success: false, errorMsg: "CORPORATION_NOT_FOUND" };
  }
  if (!flushRuntime()) {
    return { success: false, errorMsg: "DIVIDEND_FLUSH_FAILED" };
  }
  queueSettlement(corporationID, settlement.settlementID);
  return { success: true, data: cloneValue(settlement) };
}

function runSerialized(corporationID, settlementID, operation) {
  const laneKey = `${corporationID}:${settlementID}`;
  const previous = settlementLanes.get(laneKey) || Promise.resolve();
  const current = previous.catch(() => null).then(operation);
  settlementLanes.set(laneKey, current);
  void current.finally(() => {
    if (settlementLanes.get(laneKey) === current) {
      settlementLanes.delete(laneKey);
    }
  }).catch(() => null);
  return current;
}

function publishDividendNotifications(settlement, emitLive) {
  for (let index = 0; index < settlement.allocations.length; index += 1) {
    const allocation = settlement.allocations[index];
    if (allocation.kind !== "character") {
      continue;
    }
    const result = notifyCorporationDividendPaid(
      settlement.corporationID,
      allocation.ownerID,
      allocation.amount,
      !settlement.payShareholders,
      {
        idempotencyKey:
          `corporation-dividend:${settlement.settlementID}:recipient:${index}`,
        emitLive,
      },
    );
    if (!result || result.success !== true) {
      return result || { success: false, errorMsg: "NOTIFICATION_FAILED" };
    }
  }
  return { success: true };
}

async function settleCorporationDividendInternal(corporationID, settlementID) {
  let settlement = getPendingCorporationDividend(corporationID, settlementID);
  if (!settlement) {
    return { success: true, alreadySettled: true };
  }
  if (!settlement.walletApplied) {
    const walletResult = await distributeCorporationWalletAsync(
      settlement.corporationID,
      CORPORATION_WALLET_KEY_START,
      settlement.totalAmount,
      settlement.allocations,
      {
        entryTypeID: 10,
        sourceOwnerID2: settlement.payShareholders
          ? 0
          : settlement.corporationID,
        referenceID: settlement.settlementID,
        debitDescription: settlement.payShareholders
          ? "Corporation dividend paid to shareholders"
          : "Corporation dividend paid to members",
        creditDescription:
          `Corporation dividend from ${settlement.corporationID}`,
      },
      {
        commandID: settlement.walletCommandID,
        source: "corporation-dividend",
      },
    );
    if (!walletResult || walletResult.success !== true) {
      if ([
        "INSUFFICIENT_FUNDS",
        "RECIPIENT_NOT_FOUND",
        "CORPORATION_NOT_FOUND",
        "INVALID_DISTRIBUTION",
      ].includes(walletResult && walletResult.errorMsg)) {
        const removed = updateSettlement(
          corporationID,
          settlementID,
          () => null,
        );
        return removed.success
          ? { success: true, rejected: true, errorMsg: walletResult.errorMsg }
          : removed;
      }
      return walletResult || { success: false, errorMsg: "WALLET_FAILED" };
    }
    const checkpoint = updateSettlement(
      corporationID,
      settlementID,
      (current) => ({ ...current, walletApplied: true }),
    );
    if (!checkpoint.success) {
      return checkpoint;
    }
  }

  settlement = getPendingCorporationDividend(corporationID, settlementID);
  if (!settlement) {
    return { success: true, alreadySettled: true };
  }
  if (!settlement.notificationsApplied) {
    const notificationResult = publishDividendNotifications(settlement, false);
    if (!notificationResult.success) {
      return notificationResult;
    }
    const flushResult = database.flushTableSync(NOTIFICATIONS_TABLE);
    if (!flushResult || flushResult.success !== true) {
      return flushResult || { success: false, errorMsg: "NOTIFICATION_FLUSH_FAILED" };
    }
    const checkpoint = updateSettlement(
      corporationID,
      settlementID,
      (current) => ({ ...current, notificationsApplied: true }),
    );
    if (!checkpoint.success) {
      return checkpoint;
    }
  }

  settlement = getPendingCorporationDividend(corporationID, settlementID);
  if (!settlement) {
    return { success: true, alreadySettled: true };
  }
  const completed = updateSettlement(corporationID, settlementID, () => null);
  if (!completed.success) {
    return completed;
  }
  publishDividendNotifications(settlement, true);
  return {
    success: true,
    data: {
      corporationID: settlement.corporationID,
      settlementID: settlement.settlementID,
      totalAmount: settlement.totalAmount,
    },
  };
}

function settleCorporationDividend(corporationID, settlementID) {
  return runSerialized(corporationID, settlementID, () =>
    settleCorporationDividendInternal(corporationID, settlementID));
}

function bindDurableScheduler(scheduler) {
  if (!scheduler || typeof scheduler.schedule !== "function") {
    throw new TypeError("corporation dividend scheduler requires schedule");
  }
  durableScheduler = scheduler;
  return true;
}

function unbindDurableScheduler(scheduler = null) {
  if (scheduler && durableScheduler !== scheduler) {
    return false;
  }
  durableScheduler = null;
  return true;
}

async function handleDurableCorporationDividend(job = {}) {
  const corporationID = normalizePositiveInteger(
    job.payload && job.payload.corporationID,
    0,
  );
  const settlementID = normalizePositiveInteger(
    job.payload && job.payload.settlementID,
    0,
  );
  if (!corporationID || !settlementID) {
    throw new Error("corporation dividend job is invalid");
  }
  const result = await settleCorporationDividend(corporationID, settlementID);
  if (!result || result.success !== true) {
    throw new Error(result && result.errorMsg ||
      "corporation dividend settlement failed");
  }
  return result;
}

async function reconcileDurableCorporationDividends() {
  const pending = listPendingCorporationDividends();
  if (!durableScheduler) {
    return { scheduled: 0, pending: pending.length };
  }
  await Promise.all(pending.map((settlement) =>
    scheduleSettlement(settlement.corporationID, settlement.settlementID)));
  return { scheduled: pending.length, pending: pending.length };
}

module.exports = {
  DURABLE_SETTLEMENT_JOB_TYPE,
  bindDurableScheduler,
  buildSettlementJob,
  getPendingCorporationDividend,
  handleDurableCorporationDividend,
  listPendingCorporationDividends,
  prepareCorporationDividend,
  reconcileDurableCorporationDividends,
  settleCorporationDividend,
  unbindDurableScheduler,
};
