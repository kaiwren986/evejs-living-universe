"use strict";

const path = require("node:path");

const database = require(path.join(__dirname, "../../gameStore"));
const log = require(path.join(__dirname, "../../utils/logger"));
const {
  currentFileTime,
} = require(path.join(__dirname, "../_shared/serviceHelpers"));
const {
  NOTIFICATION_GROUP,
  NOTIFICATION_TYPE,
} = require(path.join(__dirname, "../notifications/notificationConstants"));
const {
  createNotification,
} = require(path.join(__dirname, "../notifications/notificationState"));
const {
  BILL_TYPE_ALLIANCE_MAINTENANCE,
  createBill,
  getBillRecord,
  listBillsForDebtor,
  listDueBills,
  markBillProcessed,
  runSerializedBillSettlement,
  tryAutoPayBill,
} = require(path.join(__dirname, "../account/billRuntimeState"));
const {
  ensureAlliancesInitialized,
  getAllianceCorporationIDs,
  getAllianceRecord,
  getCharacterIDsInCorporation,
} = require(path.join(__dirname, "./corporationState"));
const {
  updateAllianceRecord,
} = require(path.join(__dirname, "./corporationRuntimeState"));

const CONCORD_CORPORATION_ID = 1000125;
const ALLIANCE_MAINTENANCE_FEE_PER_CORPORATION = 2_000_000;

// Public sources call the charge "monthly" but neither the V24.01 client nor
// CCP's support article exposes the server's first-bill anchor or whether a
// month is a calendar boundary. Until a small TQ golden resolves that contract,
// use the emulator's established recurring-bill convention: a fixed 30-day
// period anchored to the preceding due date. Keeping the assumption here makes
// it straightforward to replace without changing bill settlement semantics.
const ALLIANCE_MAINTENANCE_PERIOD_DAYS = 30n;
const FILETIME_EPOCH_OFFSET = 116444736000000000n;
const FILETIME_TICKS_PER_MILLISECOND = 10000n;
const FILETIME_TICKS_PER_DAY = 24n * 60n * 60n * 10000000n;
const ALLIANCE_MAINTENANCE_PERIOD_TICKS =
  ALLIANCE_MAINTENANCE_PERIOD_DAYS * FILETIME_TICKS_PER_DAY;
const CLOSURE_REASON_UNPAID_MAINTENANCE = "maintenance-bill-unpaid";

function normalizePositiveInteger(value, fallback = 0) {
  const numeric = Math.trunc(Number(value));
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

function normalizeFiletime(value, fallback = currentFileTime()) {
  try {
    const normalized = BigInt(String(value === undefined ? fallback : value));
    return normalized > 0n ? normalized : BigInt(fallback);
  } catch (_error) {
    return BigInt(fallback);
  }
}

function filetimeFromUnixMs(value) {
  const numeric = Number(value);
  const nowMs = Number.isFinite(numeric) ? Math.trunc(numeric) : Date.now();
  return BigInt(nowMs) * FILETIME_TICKS_PER_MILLISECOND + FILETIME_EPOCH_OFFSET;
}

function unixMsFromFiletime(value) {
  const filetime = normalizeFiletime(value, FILETIME_EPOCH_OFFSET);
  if (filetime <= FILETIME_EPOCH_OFFSET) {
    return 0;
  }
  return Number((filetime - FILETIME_EPOCH_OFFSET) / FILETIME_TICKS_PER_MILLISECOND);
}

function resolveNow(options = {}) {
  const hasNowMs = Number.isFinite(Number(options.nowMs));
  const nowMs = hasNowMs ? Math.trunc(Number(options.nowMs)) : Date.now();
  const nowFiletime = options.nowFileTime === undefined
    ? filetimeFromUnixMs(nowMs)
    : normalizeFiletime(options.nowFileTime);
  return {
    nowMs: hasNowMs || options.nowFileTime === undefined
      ? nowMs
      : unixMsFromFiletime(nowFiletime),
    nowFiletime,
  };
}

function addAllianceMaintenancePeriod(filetime) {
  return normalizeFiletime(filetime) + ALLIANCE_MAINTENANCE_PERIOD_TICKS;
}

function getAllianceMaintenanceAmount(allianceID) {
  return getAllianceCorporationIDs(allianceID).length *
    ALLIANCE_MAINTENANCE_FEE_PER_CORPORATION;
}

function listAllianceMaintenanceBills(allianceID) {
  return listBillsForDebtor(allianceID)
    .filter(
      (bill) =>
        Number(bill.billTypeID) === BILL_TYPE_ALLIANCE_MAINTENANCE &&
        !bill.processingStatus,
    )
    .sort((left, right) => {
      const dueDelta = normalizeFiletime(left.dueDateTime, 0n) -
        normalizeFiletime(right.dueDateTime, 0n);
      if (dueDelta !== 0n) {
        return dueDelta > 0n ? 1 : -1;
      }
      return Number(left.billID) - Number(right.billID);
    });
}

function notifyAllianceMaintenanceBillIssued(bill, options = {}) {
  const alliance = getAllianceRecord(bill && bill.debtorID);
  const executorCorporationID = normalizePositiveInteger(
    alliance && alliance.executorCorporationID,
    0,
  );
  if (!alliance || alliance.deleted || !executorCorporationID) {
    return [];
  }
  const recipients = [...new Set(
    getCharacterIDsInCorporation(executorCorporationID)
      .map((characterID) => normalizePositiveInteger(characterID, 0))
      .filter(Boolean),
  )];
  const delivered = [];
  for (const characterID of recipients) {
    const result = createNotification(characterID, {
      typeID: NOTIFICATION_TYPE.ALLIANCE_MAINTENANCE_BILL,
      senderID: CONCORD_CORPORATION_ID,
      groupID: NOTIFICATION_GROUP.BILLS,
      processed: false,
      idempotencyKey:
        `alliance-maintenance-bill:${bill.billID}:receiver:${characterID}`,
      // The V24.01 formatter for notification type 4 consumes only allianceID.
      data: { allianceID: alliance.allianceID },
      emitLive: options.emitLive !== false,
    });
    if (result && result.success === true) {
      delivered.push(characterID);
    }
  }
  return delivered;
}

function updateAllianceMaintenanceProjection(allianceID, bill, changes = {}) {
  const update = updateAllianceRecord(allianceID, {
    maintenanceBillID: bill ? Number(bill.billID) || null : null,
    maintenanceBillDueDateTime: bill ? String(bill.dueDateTime) : null,
    maintenanceFeePerCorporation: ALLIANCE_MAINTENANCE_FEE_PER_CORPORATION,
    maintenanceBillingPeriodDays: Number(ALLIANCE_MAINTENANCE_PERIOD_DAYS),
    ...changes,
  });
  if (update && update.success === true) {
    database.flushTableAsync("alliances");
  }
  return update;
}

function buildMaintenanceCreationKey(allianceID, dueDateTime) {
  return `alliance-maintenance:${Number(allianceID)}:${String(dueDateTime)}`;
}

function createAllianceMaintenanceBill(allianceID, options = {}) {
  const numericAllianceID = normalizePositiveInteger(allianceID, 0);
  const alliance = getAllianceRecord(numericAllianceID);
  const amount = getAllianceMaintenanceAmount(numericAllianceID);
  if (
    !numericAllianceID ||
    !alliance ||
    alliance.deleted ||
    alliance.isNPC === true ||
    amount <= 0
  ) {
    return null;
  }
  const dueDateTime = options.dueDateTime === undefined
    ? addAllianceMaintenancePeriod(
        options.baseFileTime === undefined
          ? currentFileTime()
          : options.baseFileTime,
      ).toString()
    : normalizeFiletime(options.dueDateTime).toString();
  const bill = createBill({
    billTypeID: BILL_TYPE_ALLIANCE_MAINTENANCE,
    amount,
    debtorID: numericAllianceID,
    creditorID: CONCORD_CORPORATION_ID,
    dueDateTime,
    externalID: numericAllianceID,
    externalID2: -1,
    creationKey: buildMaintenanceCreationKey(numericAllianceID, dueDateTime),
    onCreated: notifyAllianceMaintenanceBillIssued,
  });
  if (!bill) {
    return null;
  }
  const projection = updateAllianceMaintenanceProjection(
    numericAllianceID,
    bill,
    {
      maintenanceDefaultedBillID: null,
    },
  );
  if (!projection || projection.success !== true) {
    log.warn(
      `[AllianceMaintenance] Bill projection failed alliance=${numericAllianceID} ` +
      `bill=${bill.billID}: ${projection && projection.errorMsg || "UNKNOWN"}`,
    );
  }
  return bill;
}

function ensureAllianceMaintenanceBill(allianceID, options = {}) {
  const numericAllianceID = normalizePositiveInteger(allianceID, 0);
  const alliance = getAllianceRecord(numericAllianceID);
  if (!alliance || alliance.deleted || alliance.isNPC === true) {
    return { success: false, errorMsg: "ALLIANCE_NOT_ACTIVE" };
  }
  if (alliance.closurePendingAtMs || alliance.closureDueAtMs) {
    return { success: false, errorMsg: "ALLIANCE_CLOSING" };
  }
  const existing = listAllianceMaintenanceBills(numericAllianceID)[0] || null;
  if (existing) {
    updateAllianceMaintenanceProjection(numericAllianceID, existing);
    // Repair the persistent warning if a crash landed after the bill commit but
    // before its producer callback. The idempotency key prevents a duplicate.
    notifyAllianceMaintenanceBillIssued(existing, { emitLive: false });
    return { success: true, created: false, data: existing };
  }
  const bill = createAllianceMaintenanceBill(numericAllianceID, options);
  return bill
    ? { success: true, created: true, data: bill }
    : { success: false, errorMsg: "ALLIANCE_MAINTENANCE_BILL_NOT_CREATED" };
}

function getClosurePreparer(options = {}) {
  if (typeof options.prepareAllianceClosure === "function") {
    return options.prepareAllianceClosure;
  }
  return require(path.join(__dirname, "./allianceDepartureState"))
    .prepareAllianceClosure;
}

function renewPaidMaintenanceBill(alliance, bill) {
  const nextBill = createAllianceMaintenanceBill(alliance.allianceID, {
    baseFileTime: bill.dueDateTime,
  });
  if (!nextBill) {
    return { billID: bill.billID, allianceID: alliance.allianceID, action: "blocked" };
  }
  markBillProcessed(bill.billID, "renewed", {
    renewedBillID: nextBill.billID,
  });
  return {
    billID: bill.billID,
    allianceID: alliance.allianceID,
    action: "renewed",
    renewedBillID: nextBill.billID,
  };
}

async function defaultUnpaidMaintenanceBill(alliance, bill, now, options = {}) {
  const prepareAllianceClosure = getClosurePreparer(options);
  if (typeof prepareAllianceClosure !== "function") {
    return {
      billID: bill.billID,
      allianceID: alliance.allianceID,
      action: "blocked",
      errorMsg: "ALLIANCE_CLOSURE_UNAVAILABLE",
    };
  }
  const triggerID = `maintenance-bill:${bill.billID}:${bill.dueDateTime}`;
  // Closure belongs to the first downtime after the payment deadline, not the
  // next downtime after a late scheduler restart. A past dueAt is intentional:
  // the durable closure scheduler will then catch it up immediately.
  const billDueAtMs = unixMsFromFiletime(bill.dueDateTime);
  const closure = await Promise.resolve(prepareAllianceClosure({
    allianceID: alliance.allianceID,
    reason: CLOSURE_REASON_UNPAID_MAINTENANCE,
    triggerID,
    nowMs: billDueAtMs || now.nowMs,
    requireEmpty: false,
  }));
  if (!closure || closure.success !== true) {
    return {
      billID: bill.billID,
      allianceID: alliance.allianceID,
      action: "blocked",
      errorMsg: closure && closure.errorMsg || "ALLIANCE_CLOSURE_PREPARE_FAILED",
    };
  }
  markBillProcessed(bill.billID, "defaulted", {
    processedDateTime: now.nowFiletime.toString(),
  });
  updateAllianceMaintenanceProjection(alliance.allianceID, null, {
    maintenanceDefaultedBillID: bill.billID,
    maintenanceDefaultedAt: now.nowFiletime.toString(),
  });
  return {
    billID: bill.billID,
    allianceID: alliance.allianceID,
    action: "defaulted",
    closureID: closure.data && closure.data.closureID || closure.closureID || null,
  };
}

async function processDueAllianceMaintenanceBills(options = {}) {
  const now = resolveNow(options);
  const targetBillID = normalizePositiveInteger(options.billID, 0);
  const dueBills = listDueBills({
    nowFileTime: now.nowFiletime,
    billTypeID: BILL_TYPE_ALLIANCE_MAINTENANCE,
  }).filter((bill) => !targetBillID || Number(bill.billID) === targetBillID);
  const processed = [];
  for (const dueBill of dueBills) {
    const initialAlliance = getAllianceRecord(dueBill.debtorID);
    const isCurrentActiveBill = Boolean(
      initialAlliance &&
      !initialAlliance.deleted &&
      initialAlliance.isNPC !== true &&
      getAllianceCorporationIDs(initialAlliance.allianceID).length > 0 &&
      (!initialAlliance.maintenanceBillID ||
        Number(initialAlliance.maintenanceBillID) === Number(dueBill.billID)),
    );
    const autoPayResult = !dueBill.paid && isCurrentActiveBill
      ? await tryAutoPayBill(dueBill.billID)
      : null;

    const settlement = await runSerializedBillSettlement(
      dueBill.billID,
      async () => {
        const bill = getBillRecord(dueBill.billID) || dueBill;
        if (bill.processingStatus) {
          return {
            billID: bill.billID,
            allianceID: bill.debtorID,
            action: "stale",
            status: bill.processingStatus,
          };
        }
        const alliance = getAllianceRecord(bill.debtorID);
        if (!alliance || alliance.deleted || alliance.isNPC === true) {
          markBillProcessed(bill.billID, "orphaned", {
            processedDateTime: now.nowFiletime.toString(),
          });
          return {
            billID: bill.billID,
            allianceID: bill.debtorID,
            action: "orphaned",
          };
        }
        if (getAllianceCorporationIDs(alliance.allianceID).length === 0) {
          markBillProcessed(bill.billID, "inactive", {
            processedDateTime: now.nowFiletime.toString(),
          });
          updateAllianceMaintenanceProjection(alliance.allianceID, null);
          return {
            billID: bill.billID,
            allianceID: alliance.allianceID,
            action: "inactive",
          };
        }
        if (
          alliance.maintenanceBillID &&
          Number(alliance.maintenanceBillID) !== Number(bill.billID)
        ) {
          markBillProcessed(bill.billID, "superseded", {
            processedDateTime: now.nowFiletime.toString(),
          });
          return {
            billID: bill.billID,
            allianceID: alliance.allianceID,
            action: "superseded",
          };
        }
      // A durable payment saga may have debited the executor but not yet
      // checkpointed its credit/finalization. Never turn that transient into an
      // alliance default; the bill's own durable payment job will resume it.
        if (bill.paymentSaga) {
          return {
            billID: bill.billID,
            allianceID: alliance.allianceID,
            action: "blocked",
            errorMsg:
              autoPayResult && autoPayResult.errorMsg || "PAYMENT_IN_PROGRESS",
          };
        }
        if (bill.paid) {
          return renewPaidMaintenanceBill(alliance, bill);
        }
        if (
          autoPayResult &&
          autoPayResult.success !== true &&
          autoPayResult.errorMsg &&
          autoPayResult.errorMsg !== "INSUFFICIENT_FUNDS"
        ) {
          return {
            billID: bill.billID,
            allianceID: alliance.allianceID,
            action: "blocked",
            errorMsg: autoPayResult.errorMsg,
          };
        }
        return defaultUnpaidMaintenanceBill(
          alliance,
          bill,
          now,
          options,
        );
      },
    );
    processed.push(settlement);
  }
  return {
    processedCount: processed.length,
    processed,
  };
}

function listActivePlayerAlliances() {
  const table = ensureAlliancesInitialized();
  return Object.values(table.records || {})
    .map((record) => getAllianceRecord(record && record.allianceID))
    .filter(
      (alliance) =>
        alliance &&
        !alliance.deleted &&
        alliance.isNPC !== true &&
        !alliance.closurePendingAtMs &&
        !alliance.closureDueAtMs,
    );
}

function reconcileAllianceMaintenanceBills(options = {}) {
  const now = resolveNow(options);
  let created = 0;
  let existing = 0;
  let skipped = 0;
  const bills = [];
  for (const alliance of listActivePlayerAlliances()) {
    const result = ensureAllianceMaintenanceBill(alliance.allianceID, {
      // Migration safety: an existing emulator alliance with no maintenance
      // projection receives a full initial period rather than being closed
      // immediately based on a historical creation timestamp.
      baseFileTime: now.nowFiletime,
    });
    if (!result.success) {
      skipped += 1;
      continue;
    }
    if (result.created) {
      created += 1;
    } else {
      existing += 1;
    }
    bills.push(result.data);
  }
  return {
    created,
    existing,
    skipped,
    bills,
  };
}

module.exports = {
  ALLIANCE_MAINTENANCE_FEE_PER_CORPORATION,
  ALLIANCE_MAINTENANCE_PERIOD_DAYS,
  ALLIANCE_MAINTENANCE_PERIOD_TICKS,
  CLOSURE_REASON_UNPAID_MAINTENANCE,
  CONCORD_CORPORATION_ID,
  addAllianceMaintenancePeriod,
  buildMaintenanceCreationKey,
  createAllianceMaintenanceBill,
  ensureAllianceMaintenanceBill,
  getAllianceMaintenanceAmount,
  listAllianceMaintenanceBills,
  notifyAllianceMaintenanceBillIssued,
  processDueAllianceMaintenanceBills,
  reconcileAllianceMaintenanceBills,
  _testing: {
    filetimeFromUnixMs,
    resolveNow,
    unixMsFromFiletime,
  },
};
