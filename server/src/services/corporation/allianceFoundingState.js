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
  checkAllianceFormationEligibility,
} = require(path.join(__dirname, "./allianceFormationEligibility"));
const {
  createAllianceWithRuntime,
} = require(path.join(__dirname, "./corporationRuntimeState"));
const {
  getAllianceRecord,
} = require(path.join(__dirname, "./corporationState"));
const {
  ensureAllianceMaintenanceBill,
} = require(path.join(__dirname, "./allianceMaintenanceBilling"));
const {
  buildCorporationSnapshot,
  notifyAllianceChanged,
  notifyAllianceMemberChanged,
  notifyCorporationChanged,
} = require(path.join(__dirname, "./corporationNotifications"));

const TABLE_NAME = "allianceFoundings";
const ROOT_VERSION = 1;
const ALLIANCE_FOUNDING_COST = 1_000_000_000;
const ALLIANCE_REGISTRATION_FEE_ENTRY_TYPE = Number(
  JOURNAL_ENTRY_TYPE.ALLIANCE_REGISTRATION_FEE || 48,
);
const DURABLE_SETTLEMENT_JOB_TYPE = "alliance.found";
const DURABLE_SETTLEMENT_JOB_PREFIX = "alliance-founding:";
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
    // gameStore reads expose the live cache object. Keep settlement mutations
    // detached so writeRoot can detect and durably publish every checkpoint.
    byCorporation: root.byCorporation && typeof root.byCorporation === "object"
      ? cloneValue(root.byCorporation)
      : {},
  };
}

function writeRoot(root) {
  database.ensureTable(TABLE_NAME);
  const writeResult = database.write(TABLE_NAME, "/", {
    version: ROOT_VERSION,
    byCorporation: cloneValue(root.byCorporation || {}),
  });
  if (!writeResult || writeResult.success !== true) {
    return writeResult || { success: false, errorMsg: "WRITE_ERROR" };
  }
  const flushResult = database.flushTableSync(TABLE_NAME);
  return flushResult && flushResult.success
    ? writeResult
    : flushResult || { success: false, errorMsg: "FLUSH_ERROR" };
}

function getPendingAllianceFounding(corporationID) {
  return cloneValue(
    readRoot().byCorporation[
      String(normalizePositiveInteger(corporationID))
    ] || null,
  );
}

function listPendingAllianceFoundings() {
  return Object.values(readRoot().byCorporation)
    .filter(Boolean)
    .map(cloneValue)
    .sort((left, right) => left.corporationID - right.corporationID);
}

function updateSettlement(corporationID, updater) {
  const root = readRoot();
  const key = String(normalizePositiveInteger(corporationID));
  const current = root.byCorporation[key];
  if (!current) {
    return { success: false, errorMsg: "ALLIANCE_FOUNDING_NOT_FOUND" };
  }
  const next = typeof updater === "function"
    ? updater(cloneValue(current))
    : current;
  if (next === null) {
    delete root.byCorporation[key];
  } else {
    root.byCorporation[key] = cloneValue(next);
  }
  const result = writeRoot(root);
  return result && result.success
    ? { success: true, data: cloneValue(next) }
    : result || {
        success: false,
        errorMsg: "ALLIANCE_FOUNDING_WRITE_FAILED",
      };
}

function buildSettlementJob(corporationID) {
  const normalizedCorporationID = normalizePositiveInteger(corporationID);
  return normalizedCorporationID
    ? {
        jobID: `${DURABLE_SETTLEMENT_JOB_PREFIX}${normalizedCorporationID}`,
        type: DURABLE_SETTLEMENT_JOB_TYPE,
        dueAtMs: Date.now(),
        payload: { corporationID: normalizedCorporationID },
      }
    : null;
}

async function scheduleSettlement(corporationID) {
  const job = buildSettlementJob(corporationID);
  if (!job || !durableScheduler) {
    return null;
  }
  await durableScheduler.schedule(job);
  return job;
}

function queueSettlement(corporationID) {
  if (!durableScheduler) {
    return;
  }
  void scheduleSettlement(corporationID).catch((error) => {
    log.warn(
      `[AllianceFounding] scheduling failed corp=${corporationID}: ` +
        error.message,
    );
  });
}

function prepareAllianceFounding(options = {}) {
  const characterID = normalizePositiveInteger(options.characterID);
  const corporationID = normalizePositiveInteger(options.corporationID);
  if (!characterID) {
    return { success: false, errorMsg: "INVALID_ALLIANCE_FOUNDER" };
  }
  if (!corporationID) {
    return { success: false, errorMsg: "INVALID_FOUNDING_CORPORATION" };
  }

  const root = readRoot();
  const key = String(corporationID);
  const allianceOptions = cloneValue(options.allianceOptions || {});
  const requestFingerprint = JSON.stringify({ characterID, allianceOptions });
  if (root.byCorporation[key]) {
    if (root.byCorporation[key].requestFingerprint !== requestFingerprint) {
      return {
        success: false,
        errorMsg: "ALLIANCE_FOUNDING_ALREADY_PENDING",
      };
    }
    queueSettlement(corporationID);
    return {
      success: true,
      duplicate: true,
      data: cloneValue(root.byCorporation[key]),
    };
  }

  const operationID = crypto.randomUUID();
  const settlement = {
    operationID,
    characterID,
    corporationID,
    fee: ALLIANCE_FOUNDING_COST,
    allianceOptions,
    requestFingerprint,
    debitCommandID: `alliance-founding:${operationID}:debit`,
    refundCommandID: `alliance-founding:${operationID}:refund`,
    debitApplied: false,
    creationStarted: false,
    allianceCreated: false,
    allianceID: null,
    maintenanceBillCreated: false,
    maintenanceBillID: null,
    notificationBefore: {
      corporation: buildCorporationSnapshot(corporationID),
    },
    notificationsComplete: false,
    rejectionErrorMsg: null,
    refundApplied: false,
    createdAt: new Date().toISOString(),
  };
  root.byCorporation[key] = settlement;
  const result = writeRoot(root);
  if (!result || result.success !== true) {
    return result || {
      success: false,
      errorMsg: "ALLIANCE_FOUNDING_WRITE_FAILED",
    };
  }
  queueSettlement(corporationID);
  return { success: true, duplicate: false, data: cloneValue(settlement) };
}

function runSerialized(corporationID, operation) {
  const laneKey = String(normalizePositiveInteger(corporationID));
  const active = settlementLanes.get(laneKey);
  if (active) {
    // The RPC and the due-now scheduler job can race immediately after
    // prepare. They are settling the same corporation-scoped operation, so
    // share its result; chaining a second run would see the deleted record and
    // return alreadySettled without the newly-created alliance ID.
    return active;
  }
  const current = Promise.resolve().then(operation);
  settlementLanes.set(laneKey, current);
  void current.finally(() => {
    if (settlementLanes.get(laneKey) === current) {
      settlementLanes.delete(laneKey);
    }
  }).catch(() => null);
  return current;
}

async function checkSettlementEligibility(settlement) {
  const result = await checkAllianceFormationEligibility({
    characterID: settlement.characterID,
    corporationID: settlement.corporationID,
    allianceOptions: cloneValue(settlement.allianceOptions),
    foundingOperationID: settlement.operationID,
  });
  return result && result.success === true
    ? result
    : result || { success: false, errorMsg: "ALLIANCE_FORMATION_INELIGIBLE" };
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
      entryTypeID: ALLIANCE_REGISTRATION_FEE_ENTRY_TYPE,
      ownerID1: settlement.characterID,
      ownerID2: settlement.characterID,
      referenceID: settlement.corporationID,
      description: "Alliance registration fee refund",
    },
    {
      commandID: settlement.refundCommandID,
      source: "alliance-founding-refund",
    },
  );
  if (!refundResult || refundResult.success !== true) {
    return refundResult || { success: false, errorMsg: "REFUND_FAILED" };
  }
  return updateSettlement(settlement.corporationID, (current) => ({
    ...current,
    refundApplied: true,
  }));
}

async function finishRejectedSettlement(corporationID, errorMsg) {
  let settlement = getPendingAllianceFounding(corporationID);
  if (!settlement) {
    return { success: true, alreadySettled: true };
  }

  const normalizedError = String(
    settlement.rejectionErrorMsg || errorMsg || "ALLIANCE_FORMATION_REJECTED",
  );
  if (!settlement.rejectionErrorMsg) {
    const rejectionCheckpoint = updateSettlement(corporationID, (current) => ({
      ...current,
      rejectionErrorMsg: normalizedError,
    }));
    if (!rejectionCheckpoint.success) {
      return rejectionCheckpoint;
    }
    settlement = rejectionCheckpoint.data;
  }

  if (settlement.debitApplied && !settlement.refundApplied) {
    const refundResult = await refundFoundingFee(settlement);
    if (!refundResult || refundResult.success !== true) {
      return refundResult || { success: false, errorMsg: "REFUND_FAILED" };
    }
  }

  const removed = updateSettlement(corporationID, () => null);
  return removed.success
    ? { success: true, rejected: true, errorMsg: normalizedError }
    : removed;
}

const DEFINITIVE_CREATION_ERRORS = new Set([
  "ALLIANCE_NAME_REQUIRED",
  "ALLIANCE_NAME_TAKEN",
  "ALLIANCE_NAME_INVALID_LENGTH",
  "ALLIANCE_NAME_INVALID_CHARACTERS",
  "ALLIANCE_SHORT_NAME_INVALID_LENGTH",
  "ALLIANCE_SHORT_NAME_INVALID_CHARACTERS",
  "ALLIANCE_SHORT_NAME_TAKEN",
  "ALLIANCE_DESCRIPTION_TOO_LONG",
  "ALLIANCE_URL_TOO_LONG",
  "CORPORATION_NOT_FOUND",
  "CUSTOM_CORPORATION_REQUIRED",
  "CORPORATION_ALREADY_IN_ALLIANCE",
]);

async function settleAllianceFoundingInternal(corporationID) {
  let settlement = getPendingAllianceFounding(corporationID);
  if (!settlement) {
    return { success: true, alreadySettled: true };
  }
  if (settlement.rejectionErrorMsg) {
    return finishRejectedSettlement(
      corporationID,
      settlement.rejectionErrorMsg,
    );
  }

  if (!settlement.debitApplied) {
    const eligibility = await checkSettlementEligibility(settlement);
    if (!eligibility.success) {
      return finishRejectedSettlement(
        corporationID,
        eligibility.errorMsg || "ALLIANCE_FORMATION_INELIGIBLE",
      );
    }

    const debitResult = await adjustCharacterBalanceAsync(
      settlement.characterID,
      -settlement.fee,
      {
        idempotencyKey: settlement.debitCommandID,
        entryTypeID: ALLIANCE_REGISTRATION_FEE_ENTRY_TYPE,
        ownerID1: settlement.characterID,
        ownerID2: settlement.characterID,
        referenceID: settlement.corporationID,
        description: "Alliance registration fee",
      },
      {
        commandID: settlement.debitCommandID,
        source: "alliance-founding",
      },
    );
    if (!debitResult || debitResult.success !== true) {
      if (debitResult && debitResult.errorMsg === "INSUFFICIENT_FUNDS") {
        return finishRejectedSettlement(corporationID, "INSUFFICIENT_FUNDS");
      }
      return debitResult || { success: false, errorMsg: "DEBIT_FAILED" };
    }
    const debitCheckpoint = updateSettlement(corporationID, (current) => ({
      ...current,
      debitApplied: true,
    }));
    if (!debitCheckpoint.success) {
      return debitCheckpoint;
    }
  }

  settlement = getPendingAllianceFounding(corporationID);
  if (!settlement) {
    return { success: true, alreadySettled: true };
  }
  if (!settlement.allianceCreated) {
    const eligibility = await checkSettlementEligibility(settlement);
    if (!eligibility.success) {
      return finishRejectedSettlement(
        corporationID,
        eligibility.errorMsg || "ALLIANCE_FORMATION_INELIGIBLE",
      );
    }
    if (!settlement.creationStarted) {
      const creationCheckpoint = updateSettlement(
        corporationID,
        (current) => ({ ...current, creationStarted: true }),
      );
      if (!creationCheckpoint.success) {
        return creationCheckpoint;
      }
      settlement = creationCheckpoint.data;
    }

    const createResult = await createAllianceWithRuntime(
      settlement.characterID,
      settlement.corporationID,
      {
        ...settlement.allianceOptions,
        foundingOperationID: settlement.operationID,
      },
    );
    if (!createResult || createResult.success !== true) {
      const errorMsg = createResult && createResult.errorMsg || "CREATE_FAILED";
      if (!DEFINITIVE_CREATION_ERRORS.has(errorMsg)) {
        return createResult || { success: false, errorMsg };
      }
      return finishRejectedSettlement(corporationID, errorMsg);
    }

    const flushResult = database.flushTablesSync([
      "alliances",
      "corporations",
      "characters",
      "corporationRuntime",
    ]);
    if (!flushResult || flushResult.success !== true) {
      return flushResult || {
        success: false,
        errorMsg: "ALLIANCE_CREATE_FLUSH_FAILED",
      };
    }
    const createCheckpoint = updateSettlement(corporationID, (current) => ({
      ...current,
      allianceCreated: true,
      allianceID: createResult.data.allianceID,
    }));
    if (!createCheckpoint.success) {
      return createCheckpoint;
    }
  }

  settlement = getPendingAllianceFounding(corporationID);
  if (!settlement) {
    return { success: true, alreadySettled: true };
  }
  if (!settlement.maintenanceBillCreated) {
    const alliance = getAllianceRecord(settlement.allianceID);
    const maintenance = ensureAllianceMaintenanceBill(
      settlement.allianceID,
      {
        // See allianceMaintenanceBilling: the exact TQ first-bill/calendar
        // anchor is a golden-log question. Newly founded alliances use their
        // creation filetime as the conservative 30-day cadence anchor.
        baseFileTime: alliance && (alliance.createdAt || alliance.createDate),
      },
    );
    if (!maintenance || maintenance.success !== true) {
      return maintenance || {
        success: false,
        errorMsg: "ALLIANCE_MAINTENANCE_BILL_FAILED",
      };
    }
    const maintenanceFlush = database.flushTablesSync([
      "corporationBills",
      "alliances",
      "notifications",
    ]);
    if (!maintenanceFlush || maintenanceFlush.success !== true) {
      return maintenanceFlush || {
        success: false,
        errorMsg: "ALLIANCE_MAINTENANCE_BILL_FLUSH_FAILED",
      };
    }
    const maintenanceCheckpoint = updateSettlement(
      corporationID,
      (current) => ({
        ...current,
        maintenanceBillCreated: true,
        maintenanceBillID: maintenance.data.billID,
      }),
    );
    if (!maintenanceCheckpoint.success) {
      return maintenanceCheckpoint;
    }
    settlement = maintenanceCheckpoint.data;
  }
  if (!settlement.notificationsComplete) {
    notifyAllianceChanged(settlement.allianceID, null);
    notifyAllianceMemberChanged(
      settlement.allianceID,
      settlement.corporationID,
      null,
    );
    notifyCorporationChanged(
      settlement.corporationID,
      settlement.notificationBefore &&
        settlement.notificationBefore.corporation || null,
    );
    const notificationCheckpoint = updateSettlement(
      corporationID,
      (current) => ({
        ...current,
        notificationsComplete: true,
        notificationsCompletedAt: new Date().toISOString(),
      }),
    );
    if (!notificationCheckpoint.success) {
      return notificationCheckpoint;
    }
    settlement = notificationCheckpoint.data;
  }
  const completed = updateSettlement(corporationID, () => null);
  if (!completed.success) {
    return completed;
  }
  return {
    success: true,
    data: {
      operationID: settlement.operationID,
      allianceID: settlement.allianceID,
      corporationID: settlement.corporationID,
      characterID: settlement.characterID,
    },
  };
}

function settleAllianceFounding(corporationID) {
  return runSerialized(corporationID, () =>
    settleAllianceFoundingInternal(corporationID));
}

function bindDurableScheduler(scheduler) {
  if (!scheduler || typeof scheduler.schedule !== "function") {
    throw new TypeError("alliance founding scheduler requires schedule");
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

async function handleDurableAllianceFounding(job = {}) {
  const corporationID = normalizePositiveInteger(
    job.payload && job.payload.corporationID,
  );
  if (!corporationID) {
    throw new Error("alliance founding job is invalid");
  }
  const result = await settleAllianceFounding(corporationID);
  if (!result || result.success !== true) {
    throw new Error(result && result.errorMsg ||
      "alliance founding settlement failed");
  }
  return result;
}

async function reconcileDurableAllianceFoundings() {
  const pending = listPendingAllianceFoundings();
  if (!durableScheduler) {
    return { scheduled: 0, pending: pending.length };
  }
  await Promise.all(pending.map((settlement) =>
    scheduleSettlement(settlement.corporationID)));
  return { scheduled: pending.length, pending: pending.length };
}

module.exports = {
  ALLIANCE_FOUNDING_COST,
  DURABLE_SETTLEMENT_JOB_TYPE,
  TABLE_NAME,
  bindDurableScheduler,
  buildSettlementJob,
  getPendingAllianceFounding,
  handleDurableAllianceFounding,
  listPendingAllianceFoundings,
  prepareAllianceFounding,
  reconcileDurableAllianceFoundings,
  settleAllianceFounding,
  unbindDurableScheduler,
};
