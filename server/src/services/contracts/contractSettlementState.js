"use strict";

const {
  cloneValue,
} = require("../../common/clone");

const path = require("node:path");

const database = require(path.join(__dirname, "../../gameStore"));
const log = require(path.join(__dirname, "../../utils/logger"));

const TABLE_NAME = "contractSettlements";
const ROOT_VERSION = 1;
const DURABLE_SETTLEMENT_JOB_TYPE = "contracts.settle";
const DURABLE_SETTLEMENT_JOB_PREFIX = "contract-settlement:";
const settlementLanes = new Map();
let durableScheduler = null;
// The contract runtime's settlement step. The runtime registers it when it loads, so this store
// never requires the runtime (which requires this store). contractSettlementJobs.js loads the
// runtime before running a scheduled settlement.
let settlementExecutor = null;

function toPositiveInt(value, fallback = 0) {
  const numeric = Math.trunc(Number(value) || 0);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : fallback;
}

function readRoot() {
  database.ensureTable(TABLE_NAME);
  const result = database.read(TABLE_NAME, "/");
  const root = result && result.success && result.data &&
    typeof result.data === "object"
    ? result.data
    : {};
  return {
    version: ROOT_VERSION,
    // Detached: gameStore.read returns the live cache object, and writeRoot's
    // change detection compares against that same object. Mutating it in place
    // makes every write look unchanged, so the table stays right in memory and
    // never reaches disk.
    byContractID:
      root.byContractID && typeof root.byContractID === "object"
        ? cloneValue(root.byContractID)
        : {},
  };
}

function writeRoot(root) {
  database.ensureTable(TABLE_NAME);
  const previous = database.read(TABLE_NAME, "/");
  const backup = previous && previous.success ? cloneValue(previous.data) : {};
  const result = database.write(TABLE_NAME, "/", {
    version: ROOT_VERSION,
    byContractID: cloneValue(root.byContractID || {}),
  });
  if (!result || result.success !== true) {
    return result || { success: false, errorMsg: "WRITE_ERROR" };
  }
  try {
    const flushResult = database.flushTableSync(TABLE_NAME);
    if (flushResult && flushResult.success) return result;
    database.write(TABLE_NAME, "/", backup);
    return flushResult || { success: false, errorMsg: "FLUSH_ERROR" };
  } catch (error) {
    database.write(TABLE_NAME, "/", backup);
    throw error;
  }
}

function getPendingContractSettlement(contractID) {
  return cloneValue(
    readRoot().byContractID[String(toPositiveInt(contractID, 0))] || null,
  );
}

function listPendingContractSettlements() {
  return Object.values(readRoot().byContractID)
    .filter(Boolean)
    .map(cloneValue)
    .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)));
}

function resetForTests() {
  return writeRoot({ version: ROOT_VERSION, byContractID: {} });
}

function findPendingContractSettlement(kind, requestFingerprint) {
  const normalizedKind = String(kind || "").trim();
  const normalizedFingerprint = String(requestFingerprint || "").trim();
  return listPendingContractSettlements().find((settlement) =>
    settlement.kind === normalizedKind &&
    settlement.requestFingerprint === normalizedFingerprint) || null;
}

function updateContractSettlement(contractID, updater) {
  const root = readRoot();
  const key = String(toPositiveInt(contractID, 0));
  const current = root.byContractID[key];
  if (!current) {
    return { success: false, errorMsg: "CONTRACT_SETTLEMENT_NOT_FOUND" };
  }
  const next = typeof updater === "function"
    ? updater(cloneValue(current))
    : current;
  if (next === null) {
    delete root.byContractID[key];
  } else {
    root.byContractID[key] = cloneValue(next);
  }
  const result = writeRoot(root);
  return result && result.success
    ? { success: true, data: cloneValue(next) }
    : result || { success: false, errorMsg: "CONTRACT_SETTLEMENT_WRITE_FAILED" };
}

function buildSettlementJob(contractID) {
  const normalizedContractID = toPositiveInt(contractID, 0);
  return normalizedContractID
    ? {
        jobID: `${DURABLE_SETTLEMENT_JOB_PREFIX}${normalizedContractID}`,
        type: DURABLE_SETTLEMENT_JOB_TYPE,
        dueAtMs: Date.now(),
        payload: { contractID: normalizedContractID },
      }
    : null;
}

async function scheduleSettlement(contractID) {
  const job = buildSettlementJob(contractID);
  if (!job || !durableScheduler) {
    return null;
  }
  await durableScheduler.schedule(job);
  return job;
}

function queueSettlement(contractID) {
  if (!durableScheduler) {
    return;
  }
  void scheduleSettlement(contractID).catch((error) => {
    log.warn(
      `[ContractSettlement] scheduling failed contract=${contractID}: ${error.message}`,
    );
  });
}

function prepareContractSettlement(options = {}) {
  const contractID = toPositiveInt(options.contractID, 0);
  const kind = String(options.kind || "").trim();
  const requestFingerprint = String(options.requestFingerprint || "").trim();
  if (!contractID || !kind || !requestFingerprint) {
    return { success: false, errorMsg: "INVALID_CONTRACT_SETTLEMENT" };
  }
  const root = readRoot();
  const key = String(contractID);
  const existing = root.byContractID[key];
  if (existing) {
    if (
      existing.kind !== kind ||
      existing.requestFingerprint !== requestFingerprint
    ) {
      return { success: false, errorMsg: "CONTRACT_OPERATION_PENDING" };
    }
    queueSettlement(contractID);
    return { success: true, duplicate: true, data: cloneValue(existing) };
  }
  const settlement = {
    contractID,
    operationID: `${kind}:${contractID}`,
    kind,
    requestFingerprint,
    payload: cloneValue(options.payload || {}),
    createdAt: new Date().toISOString(),
  };
  root.byContractID[key] = settlement;
  const result = writeRoot(root);
  if (!result || result.success !== true) {
    return result || { success: false, errorMsg: "CONTRACT_SETTLEMENT_WRITE_FAILED" };
  }
  // Settlement execution returns failures to this job; the scheduler owns
  // retry/backoff while its lease is live. Runtime failure paths must not
  // reschedule this same job and supersede that lease.
  queueSettlement(contractID);
  return { success: true, duplicate: false, data: cloneValue(settlement) };
}

function runSerialized(contractID, operation) {
  const laneKey = String(toPositiveInt(contractID, 0));
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

function setSettlementExecutor(executor) {
  if (typeof executor !== "function") {
    throw new TypeError("contract settlement executor must be a function");
  }
  settlementExecutor = executor;
}

function settleContractSettlement(contractID, options = {}) {
  return runSerialized(contractID, async () => {
    if (!settlementExecutor) {
      throw new Error("contract settlement needs the contract runtime loaded (contractSettlementJobs.js loads it)");
    }
    return settlementExecutor(contractID, options);
  });
}

function bindDurableScheduler(scheduler) {
  if (!scheduler || typeof scheduler.schedule !== "function") {
    throw new TypeError("contract settlement scheduler requires schedule");
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

async function handleDurableContractSettlement(job = {}) {
  const contractID = toPositiveInt(job.payload && job.payload.contractID, 0);
  if (!contractID) {
    throw new Error("contract settlement job is invalid");
  }
  const result = await settleContractSettlement(contractID);
  if (!result || result.success !== true) {
    throw new Error(result && result.errorMsg || "contract settlement failed");
  }
  return result;
}

async function reconcileDurableContractSettlements() {
  const pending = listPendingContractSettlements();
  if (!durableScheduler) {
    return { scheduled: 0, pending: pending.length };
  }
  await Promise.all(pending.map((settlement) =>
    scheduleSettlement(settlement.contractID)));
  return { scheduled: pending.length, pending: pending.length };
}

module.exports = {
  DURABLE_SETTLEMENT_JOB_TYPE,
  TABLE_NAME,
  bindDurableScheduler,
  buildSettlementJob,
  findPendingContractSettlement,
  getPendingContractSettlement,
  handleDurableContractSettlement,
  listPendingContractSettlements,
  prepareContractSettlement,
  queueSettlement,
  reconcileDurableContractSettlements,
  resetForTests,
  runSerialized,
  setSettlementExecutor,
  settleContractSettlement,
  unbindDurableScheduler,
  updateContractSettlement,
};
