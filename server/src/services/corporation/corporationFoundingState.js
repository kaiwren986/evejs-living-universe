"use strict";

const crypto = require("node:crypto");
const path = require("path");

const database = require(path.join(__dirname, "../../gameStore"));
const log = require(path.join(__dirname, "../../utils/logger"));
const {
  JOURNAL_ENTRY_TYPE,
  adjustCharacterBalanceAsync,
} = require(path.join(__dirname, "../account/walletState"));
const {
  createCorporationWithRuntime,
} = require(path.join(__dirname, "./corporationRuntimeState"));

const TABLE_NAME = "corporationFoundings";
const ROOT_VERSION = 1;
const CORPORATION_FOUNDING_COST = 1599800;
const DURABLE_SETTLEMENT_JOB_TYPE = "corporation.found";
const DURABLE_SETTLEMENT_JOB_PREFIX = "corporation-founding:";
const settlementLanes = new Map();
let durableScheduler = null;

function cloneValue(value) {
  if (value === undefined || value === null) {
    return value;
  }
  return JSON.parse(JSON.stringify(
    value,
    (_key, candidate) =>
      typeof candidate === "bigint" ? candidate.toString() : candidate,
  ));
}

function normalizePositiveInteger(value) {
  const numeric = Math.trunc(Number(value) || 0);
  return numeric > 0 ? numeric : 0;
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
    byCharacter: root.byCharacter && typeof root.byCharacter === "object"
      ? cloneValue(root.byCharacter)
      : {},
  };
}

function writeRoot(root) {
  database.ensureTable(TABLE_NAME);
  const writeResult = database.write(TABLE_NAME, "/", {
    version: ROOT_VERSION,
    byCharacter: cloneValue(root.byCharacter || {}),
  });
  if (!writeResult || writeResult.success !== true) {
    return writeResult || { success: false, errorMsg: "WRITE_ERROR" };
  }
  const flushResult = database.flushTableSync(TABLE_NAME);
  return flushResult && flushResult.success
    ? writeResult
    : flushResult || { success: false, errorMsg: "FLUSH_ERROR" };
}

function getPendingCorporationFounding(characterID) {
  return cloneValue(
    readRoot().byCharacter[String(normalizePositiveInteger(characterID))] || null,
  );
}

function listPendingCorporationFoundings() {
  return Object.values(readRoot().byCharacter)
    .filter(Boolean)
    .map(cloneValue)
    .sort((left, right) => left.characterID - right.characterID);
}

function updateSettlement(characterID, updater) {
  const root = readRoot();
  const key = String(normalizePositiveInteger(characterID));
  const current = root.byCharacter[key];
  if (!current) {
    return { success: false, errorMsg: "FOUNDING_NOT_FOUND" };
  }
  const next = typeof updater === "function"
    ? updater(cloneValue(current))
    : current;
  if (next === null) {
    delete root.byCharacter[key];
  } else {
    root.byCharacter[key] = cloneValue(next);
  }
  const result = writeRoot(root);
  return result && result.success
    ? { success: true, data: cloneValue(next) }
    : result || { success: false, errorMsg: "FOUNDING_WRITE_FAILED" };
}

function buildSettlementJob(characterID) {
  const normalizedCharacterID = normalizePositiveInteger(characterID);
  return normalizedCharacterID
    ? {
        jobID: `${DURABLE_SETTLEMENT_JOB_PREFIX}${normalizedCharacterID}`,
        type: DURABLE_SETTLEMENT_JOB_TYPE,
        dueAtMs: Date.now(),
        payload: { characterID: normalizedCharacterID },
      }
    : null;
}

async function scheduleSettlement(characterID) {
  const job = buildSettlementJob(characterID);
  if (!job || !durableScheduler) {
    return null;
  }
  await durableScheduler.schedule(job);
  return job;
}

function queueSettlement(characterID) {
  if (!durableScheduler) {
    return;
  }
  void scheduleSettlement(characterID).catch((error) => {
    log.warn(
      `[CorporationFounding] scheduling failed char=${characterID}: ${error.message}`,
    );
  });
}

function prepareCorporationFounding(options = {}) {
  const characterID = normalizePositiveInteger(options.characterID);
  if (!characterID) {
    return { success: false, errorMsg: "INVALID_FOUNDER" };
  }
  const root = readRoot();
  const key = String(characterID);
  const corporationOptions = cloneValue(options.corporationOptions || {});
  const requestFingerprint = JSON.stringify(corporationOptions);
  if (root.byCharacter[key]) {
    if (root.byCharacter[key].requestFingerprint !== requestFingerprint) {
      return { success: false, errorMsg: "FOUNDING_ALREADY_PENDING" };
    }
    queueSettlement(characterID);
    return {
      success: true,
      duplicate: true,
      data: cloneValue(root.byCharacter[key]),
    };
  }
  const operationID = crypto.randomUUID();
  const settlement = {
    operationID,
    characterID,
    fee: CORPORATION_FOUNDING_COST,
    corporationOptions,
    requestFingerprint,
    previousCorporationID: normalizePositiveInteger(
      options.previousCorporationID,
    ) || null,
    previousCreatorMember: cloneValue(options.previousCreatorMember || null),
    previousCreatorCorporation: cloneValue(
      options.previousCreatorCorporation || null,
    ),
    debitCommandID: `corporation-founding:${operationID}:debit`,
    refundCommandID: `corporation-founding:${operationID}:refund`,
    debitApplied: false,
    corporationCreated: false,
    corporationID: null,
    refundApplied: false,
    createdAt: new Date().toISOString(),
  };
  root.byCharacter[key] = settlement;
  const result = writeRoot(root);
  if (!result || result.success !== true) {
    return result || { success: false, errorMsg: "FOUNDING_WRITE_FAILED" };
  }
  queueSettlement(characterID);
  return { success: true, duplicate: false, data: cloneValue(settlement) };
}

function runSerialized(characterID, operation) {
  const laneKey = String(normalizePositiveInteger(characterID));
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

async function refundFoundingFee(settlement) {
  if (settlement.refundApplied) {
    return { success: true };
  }
  const refundResult = await adjustCharacterBalanceAsync(
    settlement.characterID,
    settlement.fee,
    {
      idempotencyKey: settlement.refundCommandID,
      entryTypeID: JOURNAL_ENTRY_TYPE.CORPORATION_REGISTRATION_FEE,
      ownerID1: settlement.characterID,
      ownerID2: settlement.characterID,
      referenceID: settlement.characterID,
      description: "Corporation registration fee refund",
    },
    {
      commandID: settlement.refundCommandID,
      source: "corporation-founding-refund",
    },
  );
  if (!refundResult || refundResult.success !== true) {
    return refundResult || { success: false, errorMsg: "REFUND_FAILED" };
  }
  return updateSettlement(settlement.characterID, (current) => ({
    ...current,
    refundApplied: true,
  }));
}

const DEFINITIVE_CREATION_ERRORS = new Set([
  "CORPORATION_NAME_REQUIRED",
  "CORPORATION_NAME_TAKEN",
  "CORPORATION_TICKER_TAKEN",
]);

async function settleCorporationFoundingInternal(characterID) {
  let settlement = getPendingCorporationFounding(characterID);
  if (!settlement) {
    return { success: true, alreadySettled: true };
  }
  if (!settlement.debitApplied) {
    const debitResult = await adjustCharacterBalanceAsync(
      settlement.characterID,
      -settlement.fee,
      {
        idempotencyKey: settlement.debitCommandID,
        entryTypeID: JOURNAL_ENTRY_TYPE.CORPORATION_REGISTRATION_FEE,
        ownerID1: settlement.characterID,
        ownerID2: settlement.characterID,
        referenceID: settlement.characterID,
        description: "Corporation registration fee",
      },
      {
        commandID: settlement.debitCommandID,
        source: "corporation-founding",
      },
    );
    if (!debitResult || debitResult.success !== true) {
      if (debitResult && debitResult.errorMsg === "INSUFFICIENT_FUNDS") {
        const removed = updateSettlement(characterID, () => null);
        return removed.success
          ? { success: true, rejected: true, errorMsg: "INSUFFICIENT_FUNDS" }
          : removed;
      }
      return debitResult || { success: false, errorMsg: "DEBIT_FAILED" };
    }
    const checkpoint = updateSettlement(characterID, (current) => ({
      ...current,
      debitApplied: true,
    }));
    if (!checkpoint.success) {
      return checkpoint;
    }
  }

  settlement = getPendingCorporationFounding(characterID);
  if (!settlement) {
    return { success: true, alreadySettled: true };
  }
  if (!settlement.corporationCreated) {
    const createResult = createCorporationWithRuntime(
      settlement.characterID,
      {
        ...settlement.corporationOptions,
        foundingOperationID: settlement.operationID,
      },
    );
    if (!createResult || createResult.success !== true) {
      const errorMsg = createResult && createResult.errorMsg || "CREATE_FAILED";
      if (!DEFINITIVE_CREATION_ERRORS.has(errorMsg)) {
        return createResult || { success: false, errorMsg };
      }
      const refundResult = await refundFoundingFee(settlement);
      if (!refundResult.success) {
        return refundResult;
      }
      const removed = updateSettlement(characterID, () => null);
      return removed.success
        ? { success: true, rejected: true, errorMsg }
        : removed;
    }
    const flushResult = database.flushTablesSync([
      "characters",
      "corporations",
      "corporationRuntime",
    ]);
    if (!flushResult || flushResult.success !== true) {
      return flushResult || { success: false, errorMsg: "CREATE_FLUSH_FAILED" };
    }
    const checkpoint = updateSettlement(characterID, (current) => ({
      ...current,
      corporationCreated: true,
      corporationID: createResult.data.corporationID,
    }));
    if (!checkpoint.success) {
      return checkpoint;
    }
  }

  settlement = getPendingCorporationFounding(characterID);
  if (!settlement) {
    return { success: true, alreadySettled: true };
  }
  const completed = updateSettlement(characterID, () => null);
  if (!completed.success) {
    return completed;
  }
  return {
    success: true,
    data: {
      corporationID: settlement.corporationID,
      characterID: settlement.characterID,
      previousCorporationID: settlement.previousCorporationID,
      previousCreatorMember: settlement.previousCreatorMember,
      previousCreatorCorporation: settlement.previousCreatorCorporation,
    },
  };
}

function settleCorporationFounding(characterID) {
  return runSerialized(characterID, () =>
    settleCorporationFoundingInternal(characterID));
}

function bindDurableScheduler(scheduler) {
  if (!scheduler || typeof scheduler.schedule !== "function") {
    throw new TypeError("corporation founding scheduler requires schedule");
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

async function handleDurableCorporationFounding(job = {}) {
  const characterID = normalizePositiveInteger(
    job.payload && job.payload.characterID,
  );
  if (!characterID) {
    throw new Error("corporation founding job is invalid");
  }
  const result = await settleCorporationFounding(characterID);
  if (!result || result.success !== true) {
    throw new Error(result && result.errorMsg ||
      "corporation founding settlement failed");
  }
  return result;
}

async function reconcileDurableCorporationFoundings() {
  const pending = listPendingCorporationFoundings();
  if (!durableScheduler) {
    return { scheduled: 0, pending: pending.length };
  }
  await Promise.all(pending.map((settlement) =>
    scheduleSettlement(settlement.characterID)));
  return { scheduled: pending.length, pending: pending.length };
}

module.exports = {
  CORPORATION_FOUNDING_COST,
  DURABLE_SETTLEMENT_JOB_TYPE,
  TABLE_NAME,
  bindDurableScheduler,
  buildSettlementJob,
  getPendingCorporationFounding,
  handleDurableCorporationFounding,
  listPendingCorporationFoundings,
  prepareCorporationFounding,
  reconcileDurableCorporationFoundings,
  settleCorporationFounding,
  unbindDurableScheduler,
};
