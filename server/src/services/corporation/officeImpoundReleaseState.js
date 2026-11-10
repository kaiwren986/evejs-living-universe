"use strict";

const {
  cloneValue,
} = require("../../common/clone");

const path = require("path");

const database = require(path.join(__dirname, "../../gameStore"));
const log = require(path.join(__dirname, "../../utils/logger"));
const {
  currentFileTime,
} = require(path.join(__dirname, "../_shared/serviceHelpers"));
const {
  CORPORATION_RUNTIME_TABLE,
  ensureRuntimeInitialized,
  getCorporationRuntime,
  normalizePositiveInteger,
  updateRuntimeState,
} = require(path.join(__dirname, "./corporationRuntimeState"));
const {
  CORPORATION_WALLET_KEY_START,
  adjustCorporationWalletDivisionBalanceAsync,
} = require(path.join(__dirname, "./corpWalletState"));
const {
  JOURNAL_ENTRY_TYPE,
} = require(path.join(__dirname, "../account/walletState"));

const DURABLE_SETTLEMENT_JOB_TYPE = "office.impound-release";
const DURABLE_SETTLEMENT_JOB_PREFIX = "office-impound-release:";
const settlementLanes = new Map();
let durableScheduler = null;

function normalizeMoney(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  return Math.max(0, Math.round(numeric * 100) / 100);
}

function normalizeSettlement(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const operationID = String(value.operationID || "").trim();
  const corporationID = normalizePositiveInteger(value.corporationID, 0);
  const stationID = normalizePositiveInteger(value.stationID, 0);
  if (!operationID || !corporationID || !stationID) {
    return null;
  }
  return {
    operationID,
    corporationID,
    stationID,
    officeIDs: Array.isArray(value.officeIDs)
      ? [...new Set(value.officeIDs.map((officeID) =>
          normalizePositiveInteger(officeID, 0)).filter(Boolean))]
      : [],
    amount: normalizeMoney(value.amount),
    accountKey: normalizePositiveInteger(
      value.accountKey,
      CORPORATION_WALLET_KEY_START,
    ),
    debitCommandID: String(
      value.debitCommandID || `${DURABLE_SETTLEMENT_JOB_PREFIX}${operationID}:debit`,
    ),
    createdAt: String(value.createdAt || "0"),
  };
}

function runSerialized(corporationID, stationID, operation) {
  const laneKey = `${Number(corporationID) || 0}:${Number(stationID) || 0}`;
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

function flushRuntimeState() {
  database.flushTableAsync(CORPORATION_RUNTIME_TABLE);
}

function getPendingSettlement(corporationID, operationID) {
  const runtime = getCorporationRuntime(corporationID);
  return normalizeSettlement(
    runtime &&
      runtime.impoundReleaseSettlements &&
      runtime.impoundReleaseSettlements[String(operationID)],
  );
}

function listPendingImpoundReleaseSettlements() {
  const runtimeTable = ensureRuntimeInitialized();
  const settlements = [];
  for (const runtime of Object.values(runtimeTable.corporations || {})) {
    for (const value of Object.values(
      runtime && runtime.impoundReleaseSettlements || {},
    )) {
      const settlement = normalizeSettlement(value);
      if (settlement) {
        settlements.push(settlement);
      }
    }
  }
  return settlements.sort((left, right) =>
    left.operationID.localeCompare(right.operationID));
}

function prepareImpoundRelease(corporationID, stationID, amount) {
  const normalizedCorporationID = normalizePositiveInteger(corporationID, 0);
  const normalizedStationID = normalizePositiveInteger(stationID, 0);
  if (!normalizedCorporationID || !normalizedStationID) {
    return { success: false, errorMsg: "INVALID_OFFICE_LOCATION" };
  }

  let settlement = null;
  let hasImpoundedOffice = false;
  const writeResult = updateRuntimeState((runtimeTable) => {
    const runtime = runtimeTable.corporations[String(normalizedCorporationID)];
    if (!runtime || !runtime.offices) {
      return runtimeTable;
    }
    const officeIDs = Object.values(runtime.offices)
      .filter((office) =>
        Number(office && office.stationID) === normalizedStationID &&
        Boolean(office && office.impounded))
      .map((office) => normalizePositiveInteger(office && office.officeID, 0))
      .filter(Boolean)
      .sort((left, right) => left - right);
    if (officeIDs.length === 0) {
      return runtimeTable;
    }
    hasImpoundedOffice = true;
    runtime.impoundReleaseSettlements =
      runtime.impoundReleaseSettlements &&
      typeof runtime.impoundReleaseSettlements === "object"
        ? runtime.impoundReleaseSettlements
        : {};
    const existingEntry = Object.entries(runtime.impoundReleaseSettlements)
      .map(([key, value]) => [key, normalizeSettlement(value)])
      .find(([, value]) => value && value.stationID === normalizedStationID);
    const existing = existingEntry && existingEntry[1];
    if (existing) {
      const overlappingOfficeIDs = existing.officeIDs.filter((officeID) =>
        officeIDs.includes(officeID));
      if (overlappingOfficeIDs.length > 0) {
        existing.officeIDs = [...new Set([...existing.officeIDs, ...officeIDs])]
          .sort((left, right) => left - right);
        runtime.impoundReleaseSettlements[existing.operationID] = existing;
        settlement = existing;
        return runtimeTable;
      }
      delete runtime.impoundReleaseSettlements[existingEntry[0]];
    }

    const sequence = normalizePositiveInteger(
      runtimeTable._meta && runtimeTable._meta.nextImpoundReleaseOperationID,
      1,
    ) || 1;
    runtimeTable._meta.nextImpoundReleaseOperationID = sequence + 1;
    const operationID = `${normalizedCorporationID}:${normalizedStationID}:${sequence}`;
    settlement = {
      operationID,
      corporationID: normalizedCorporationID,
      stationID: normalizedStationID,
      officeIDs,
      amount: normalizeMoney(amount),
      accountKey: CORPORATION_WALLET_KEY_START,
      debitCommandID: `${DURABLE_SETTLEMENT_JOB_PREFIX}${operationID}:debit`,
      createdAt: String(currentFileTime()),
    };
    runtime.impoundReleaseSettlements[operationID] = settlement;
    return runtimeTable;
  });
  if (!writeResult || writeResult.success !== true) {
    return writeResult || { success: false, errorMsg: "PERSISTENCE_ERROR" };
  }
  if (!hasImpoundedOffice) {
    return { success: true, alreadySettled: true, data: null };
  }
  flushRuntimeState();
  return { success: true, data: cloneValue(settlement) };
}

function discardSettlement(corporationID, operationID) {
  let discarded = false;
  const writeResult = updateRuntimeState((runtimeTable) => {
    const runtime = runtimeTable.corporations[String(corporationID)];
    if (
      runtime &&
      runtime.impoundReleaseSettlements &&
      runtime.impoundReleaseSettlements[String(operationID)]
    ) {
      delete runtime.impoundReleaseSettlements[String(operationID)];
      discarded = true;
    }
    return runtimeTable;
  });
  if (writeResult && writeResult.success && discarded) {
    flushRuntimeState();
  }
  return writeResult;
}

async function settlePendingImpoundReleaseInternal(corporationID, operationID) {
  const settlement = getPendingSettlement(corporationID, operationID);
  if (!settlement) {
    return {
      success: true,
      alreadySettled: true,
      data: null,
    };
  }

  const currentRuntime = getCorporationRuntime(settlement.corporationID);
  const stillImpounded = settlement.officeIDs.some((officeID) => {
    const office = currentRuntime && currentRuntime.offices &&
      currentRuntime.offices[String(officeID)];
    return Boolean(
      office &&
      office.impounded &&
      Number(office.stationID) === settlement.stationID,
    );
  });
  if (!stillImpounded) {
    discardSettlement(settlement.corporationID, settlement.operationID);
    return {
      success: true,
      alreadySettled: true,
      data: null,
    };
  }

  let debitResult = { success: true, data: null };
  if (settlement.amount > 0) {
    debitResult = await adjustCorporationWalletDivisionBalanceAsync(
      settlement.corporationID,
      settlement.accountKey,
      -settlement.amount,
      {
        entryTypeID: JOURNAL_ENTRY_TYPE.RELEASE_OF_IMPOUNDED_PROPERTY,
        idempotencyKey: settlement.debitCommandID,
        ownerID1: settlement.corporationID,
        ownerID2: settlement.stationID,
        referenceID: settlement.stationID,
        description: `Release impounded corporation assets at ${settlement.stationID}`,
      },
      {
        commandID: settlement.debitCommandID,
        idempotencyKey: settlement.debitCommandID,
        source: "office-impound-release",
      },
    );
  }
  if (!debitResult || debitResult.success !== true) {
    if (debitResult && debitResult.errorMsg === "INSUFFICIENT_FUNDS") {
      discardSettlement(settlement.corporationID, settlement.operationID);
    }
    return debitResult || { success: false, errorMsg: "WALLET_DEBIT_FAILED" };
  }

  let finalized = false;
  const writeResult = updateRuntimeState((runtimeTable) => {
    const runtime = runtimeTable.corporations[String(settlement.corporationID)];
    const pending = normalizeSettlement(
      runtime &&
        runtime.impoundReleaseSettlements &&
        runtime.impoundReleaseSettlements[settlement.operationID],
    );
    if (!runtime || !pending || pending.debitCommandID !== settlement.debitCommandID) {
      return runtimeTable;
    }
    for (const officeID of settlement.officeIDs) {
      const office = runtime.offices && runtime.offices[String(officeID)];
      if (office && Number(office.stationID) === settlement.stationID) {
        office.impounded = false;
      }
    }
    delete runtime.impoundReleaseSettlements[settlement.operationID];
    finalized = true;
    return runtimeTable;
  });
  if (!writeResult || writeResult.success !== true || !finalized) {
    return writeResult && writeResult.success === false
      ? writeResult
      : { success: false, errorMsg: "SETTLEMENT_CHECKPOINT_FAILED" };
  }
  flushRuntimeState();
  return {
    success: true,
    data: {
      operationID: settlement.operationID,
      amount: settlement.amount,
      officeIDs: [...settlement.officeIDs],
    },
  };
}

function settlePendingImpoundRelease(corporationID, operationID) {
  const settlement = getPendingSettlement(corporationID, operationID);
  if (!settlement) {
    return Promise.resolve({ success: true, alreadySettled: true, data: null });
  }
  return runSerialized(settlement.corporationID, settlement.stationID, () =>
    settlePendingImpoundReleaseInternal(
      settlement.corporationID,
      settlement.operationID,
    ));
}

function buildDurableImpoundReleaseJob(settlement) {
  const normalized = normalizeSettlement(settlement);
  if (!normalized) {
    return null;
  }
  return {
    jobID: `${DURABLE_SETTLEMENT_JOB_PREFIX}${normalized.operationID}`,
    type: DURABLE_SETTLEMENT_JOB_TYPE,
    dueAtMs: Date.now(),
    payload: {
      corporationID: normalized.corporationID,
      operationID: normalized.operationID,
    },
  };
}

async function schedulePendingImpoundRelease(settlement) {
  if (!durableScheduler) {
    return null;
  }
  const job = buildDurableImpoundReleaseJob(settlement);
  if (!job) {
    return null;
  }
  await durableScheduler.schedule(job);
  return job;
}

function queuePendingImpoundRelease(settlement) {
  void schedulePendingImpoundRelease(settlement).catch((error) => {
    log.warn(
      `[OfficeImpound] Durable settlement scheduling failed operation=${settlement.operationID}: ${error.message}`,
    );
  });
  return settlePendingImpoundRelease(settlement.corporationID, settlement.operationID);
}

function releaseImpoundedOfficeAssets(corporationID, stationID, amount) {
  const normalizedCorporationID = normalizePositiveInteger(corporationID, 0);
  const normalizedStationID = normalizePositiveInteger(stationID, 0);
  return runSerialized(normalizedCorporationID, normalizedStationID, async () => {
    const prepared = prepareImpoundRelease(
      normalizedCorporationID,
      normalizedStationID,
      amount,
    );
    if (!prepared.success || !prepared.data) {
      return prepared;
    }
    void schedulePendingImpoundRelease(prepared.data).catch((error) => {
      log.warn(
        `[OfficeImpound] Durable settlement scheduling failed operation=${prepared.data.operationID}: ${error.message}`,
      );
    });
    return settlePendingImpoundReleaseInternal(
      prepared.data.corporationID,
      prepared.data.operationID,
    );
  });
}

function bindDurableScheduler(scheduler) {
  if (!scheduler || typeof scheduler.schedule !== "function") {
    throw new TypeError("office impound scheduler requires a schedule function");
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

async function handleDurableImpoundRelease(job = {}) {
  const corporationID = normalizePositiveInteger(
    job.payload && job.payload.corporationID,
    0,
  );
  const operationID = String(job.payload && job.payload.operationID || "").trim();
  if (!corporationID || !operationID) {
    throw new Error("office impound release job is invalid");
  }
  const result = await settlePendingImpoundRelease(corporationID, operationID);
  if (!result || result.success !== true) {
    if (result && result.errorMsg === "INSUFFICIENT_FUNDS") {
      return { corporationID, operationID, paymentFailed: true };
    }
    throw new Error(result && result.errorMsg || "office impound release failed");
  }
  return result;
}

async function reconcileDurableImpoundReleases() {
  const pending = listPendingImpoundReleaseSettlements();
  if (!durableScheduler) {
    return { scheduled: 0, pending: pending.length };
  }
  await Promise.all(pending.map((settlement) =>
    schedulePendingImpoundRelease(settlement)));
  return { scheduled: pending.length, pending: pending.length };
}

function hasPendingImpoundRelease(corporationID, stationID) {
  const runtime = getCorporationRuntime(corporationID);
  return Object.values(runtime && runtime.impoundReleaseSettlements || {})
    .map((value) => normalizeSettlement(value))
    .some((settlement) =>
      settlement && settlement.stationID === Number(stationID));
}

module.exports = {
  DURABLE_SETTLEMENT_JOB_TYPE,
  bindDurableScheduler,
  buildDurableImpoundReleaseJob,
  handleDurableImpoundRelease,
  hasPendingImpoundRelease,
  listPendingImpoundReleaseSettlements,
  queuePendingImpoundRelease,
  reconcileDurableImpoundReleases,
  releaseImpoundedOfficeAssets,
  settlePendingImpoundRelease,
  unbindDurableScheduler,
  _testing: {
    prepareImpoundRelease,
  },
};
