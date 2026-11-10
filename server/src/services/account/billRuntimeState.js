"use strict";

const path = require("path");
const crypto = require("crypto");

const database = require(path.join(__dirname, "../../gameStore"));
const log = require(path.join(__dirname, "../../utils/logger"));
const sessionRegistry = require(path.join(
  __dirname,
  "../chat/sessionRegistry",
));
const {
  currentFileTime,
} = require(path.join(__dirname, "../_shared/serviceHelpers"));
const {
  adjustCharacterBalanceAsync,
  JOURNAL_ENTRY_TYPE,
} = require(path.join(__dirname, "./walletState"));
const {
  adjustCorporationWalletDivisionBalanceAsync,
  normalizeCorporationWalletKey,
} = require(path.join(__dirname, "../corporation/corpWalletState"));
const {
  getAllianceRecord,
  getCorporationRecord,
} = require(path.join(__dirname, "../corporation/corporationState"));
const {
  getActiveExecutorCorporationID,
} = require(path.join(__dirname, "../corporation/allianceGovernanceState"));

const BILLS_TABLE = "corporationBills";

const BILL_TYPE_MARKET_FINE = 1;
const BILL_TYPE_RENTAL = 2;
const BILL_TYPE_BROKER = 3;
const BILL_TYPE_WAR = 4;
const BILL_TYPE_ALLIANCE_MAINTENANCE = 5;
const DEFAULT_DIVISION_ID = 1000;
const TYPE_OFFICE_RENTAL = 26;
const DURABLE_DUE_JOB_TYPE = "corporation-bill.due";
const FILETIME_UNIX_EPOCH_OFFSET = 116444736000000000n;
const FILETIME_TICKS_PER_MILLISECOND = 10000n;
const BILL_DUE_GRACE_MS = 100;
let durableBillScheduler = null;
const activeDurableBillJobs = new Set();
const billPaymentLanes = new Map();

function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function readTable() {
  const result = database.read(BILLS_TABLE, "/");
  if (!result.success || !result.data || typeof result.data !== "object") {
    return {
      _meta: {
        nextBillID: 1,
      },
      bills: {},
      automaticPaySettingsByOwner: {},
    };
  }
  return cloneValue(result.data);
}

function writeTable(table) {
  return database.write(BILLS_TABLE, "/", table);
}

function ensureTable() {
  const table = readTable();
  table._meta =
    table._meta && typeof table._meta === "object" ? table._meta : {};
  table._meta.nextBillID = Number(table._meta.nextBillID || 1) || 1;
  table.bills = table.bills && typeof table.bills === "object" ? table.bills : {};
  table.automaticPaySettingsByOwner =
    table.automaticPaySettingsByOwner &&
    typeof table.automaticPaySettingsByOwner === "object"
      ? table.automaticPaySettingsByOwner
      : {};
  return table;
}

function updateBillTable(updater) {
  const table = ensureTable();
  const nextTable =
    typeof updater === "function" ? updater(table) || table : table;
  writeTable(nextTable);
  return nextTable;
}

function commitBillTable() {
  database.flushTableAsync(BILLS_TABLE);
}

function normalizeOwnerID(value) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : 0;
}

function normalizeBillTypeID(value) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : BILL_TYPE_WAR;
}

function normalizeMoney(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.round(numeric * 100) / 100;
}

function normalizeBillPaymentSaga(paymentSaga) {
  if (!paymentSaga || typeof paymentSaga !== "object") {
    return null;
  }
  const paymentID = String(paymentSaga.paymentID || "").trim();
  const payerKind = paymentSaga.payerKind === "character"
    ? "character"
    : paymentSaga.payerKind === "corporation"
      ? "corporation"
      : null;
  const payerOwnerID = normalizeOwnerID(paymentSaga.payerOwnerID);
  if (!paymentID || !payerKind || !payerOwnerID) {
    return null;
  }
  return {
    paymentID,
    payerKind,
    payerOwnerID,
    accountKey: payerKind === "corporation"
      ? normalizeCorporationWalletKey(paymentSaga.accountKey)
      : 0,
    amount: normalizeMoney(paymentSaga.amount, 0),
    creditorCorporationID: normalizeOwnerID(
      paymentSaga.creditorCorporationID,
    ),
    debitCommandID: String(paymentSaga.debitCommandID || "").trim(),
    creditCommandID: String(paymentSaga.creditCommandID || "").trim(),
    debitApplied: Boolean(paymentSaga.debitApplied),
    creditApplied: Boolean(paymentSaga.creditApplied),
    requestedDateTime: String(
      paymentSaga.requestedDateTime || currentFileTime(),
    ),
  };
}

function defaultAutomaticPaySettings() {
  return {
    [BILL_TYPE_MARKET_FINE]: false,
    [BILL_TYPE_RENTAL]: false,
    [BILL_TYPE_BROKER]: false,
    [BILL_TYPE_WAR]: false,
    [BILL_TYPE_ALLIANCE_MAINTENANCE]: false,
    divisionID: DEFAULT_DIVISION_ID,
  };
}

function normalizeAutomaticPaySettings(settings = {}) {
  const normalized = defaultAutomaticPaySettings();
  for (const [key, value] of Object.entries(settings || {})) {
    if (key === "divisionID") {
      normalized.divisionID = normalizeCorporationWalletKey(value);
      continue;
    }
    const billTypeID = normalizeBillTypeID(key);
    normalized[billTypeID] = Boolean(value);
  }
  return normalized;
}

function getAutomaticPaySettingsForOwner(ownerID) {
  const table = ensureTable();
  return normalizeAutomaticPaySettings(
    table.automaticPaySettingsByOwner[String(ownerID)] || {},
  );
}

function setAutomaticPaySettingsForOwner(ownerID, settings) {
  const numericOwnerID = normalizeOwnerID(ownerID);
  if (!numericOwnerID) {
    return;
  }
  updateBillTable((table) => {
    table.automaticPaySettingsByOwner[String(numericOwnerID)] =
      normalizeAutomaticPaySettings(settings);
    return table;
  });
}

function buildAutomaticPaySettingsSnapshot(ownerIDs = []) {
  const uniqueOwnerIDs = Array.from(
    new Set(
      ownerIDs
        .map((ownerID) => normalizeOwnerID(ownerID))
        .filter((ownerID) => ownerID > 0),
    ),
  );
  const snapshot = {};
  for (const ownerID of uniqueOwnerIDs) {
    snapshot[ownerID] = getAutomaticPaySettingsForOwner(ownerID);
  }
  return snapshot;
}

function normalizeBillRecord(bill) {
  const record = {
    billID: Number(bill && bill.billID ? bill.billID : 0) || 0,
    billTypeID: normalizeBillTypeID(bill && bill.billTypeID),
    amount: normalizeMoney(bill && bill.amount, 0),
    interest: normalizeMoney(bill && bill.interest, 0),
    debtorID: normalizeOwnerID(bill && bill.debtorID),
    creditorID: normalizeOwnerID(bill && bill.creditorID),
    dueDateTime: String(
      bill && bill.dueDateTime ? bill.dueDateTime : currentFileTime(),
    ),
    paid: Boolean(bill && bill.paid),
    paidDateTime: bill && bill.paidDateTime ? String(bill.paidDateTime) : null,
    paidByOwnerID: normalizeOwnerID(bill && bill.paidByOwnerID),
    externalID:
      bill && bill.externalID !== undefined && bill.externalID !== null
        ? Number(bill.externalID) || -1
        : -1,
    externalID2:
      bill && bill.externalID2 !== undefined && bill.externalID2 !== null
        ? Number(bill.externalID2) || -1
        : -1,
    processingStatus:
      bill && typeof bill.processingStatus === "string"
        ? bill.processingStatus
        : null,
    processedDateTime:
      bill && bill.processedDateTime ? String(bill.processedDateTime) : null,
    renewedBillID:
      Number(bill && bill.renewedBillID ? bill.renewedBillID : 0) || 0,
    paymentSaga: normalizeBillPaymentSaga(bill && bill.paymentSaga),
  };
  const creationKey = String(bill && bill.creationKey || "").trim();
  if (creationKey) {
    record.creationKey = creationKey;
  }
  return record;
}

function getBillRecord(billID) {
  const table = ensureTable();
  const bill = table.bills[String(Number(billID) || 0)];
  return bill ? normalizeBillRecord(bill) : null;
}

function listBillsForDebtor(ownerID) {
  const numericOwnerID = normalizeOwnerID(ownerID);
  if (!numericOwnerID) {
    return [];
  }
  const table = ensureTable();
  return Object.values(table.bills || {})
    .map((bill) => normalizeBillRecord(bill))
    .filter((bill) => bill.debtorID === numericOwnerID && !bill.processingStatus)
    .sort((left, right) => {
      const paidDelta = Number(left.paid) - Number(right.paid);
      if (paidDelta !== 0) {
        return paidDelta;
      }
      const leftDue = BigInt(left.dueDateTime);
      const rightDue = BigInt(right.dueDateTime);
      if (leftDue === rightDue) {
        return Number(right.billID) - Number(left.billID);
      }
      return rightDue > leftDue ? 1 : -1;
    });
}

// The payable listings the client actually renders (billMgr.GetCorporationBills and
// allianceRegistry.GetBills) must never contain a bill that is already settled: no
// consumer in the V24.01 client hides one. corpBillsPayablePanel.PopulateScroll and
// corpBillsAutoPaidPanel.PopulateScroll render every row they are handed apart from the
// auto-pay split, and warLandingPage.GetUnpaidWarBills discards paid rows itself, so a
// paid bill that survives the response sits in the payable panel forever (EW-0402).
//
// listBillsForDebtor itself stays inclusive on purpose: cancelOfficeRentalBillsForOffice
// has to find the rental bill a corporation paid in advance so it can cancel it when the
// office is dropped or the structure is unanchored, and structureAssetSafetyState treats
// a rental bill it cannot cancel as a hard failure.
function listUnpaidBillsForDebtor(ownerID) {
  return listBillsForDebtor(ownerID).filter((bill) => !bill.paid);
}

function listBillsForCreditor(ownerID) {
  const numericOwnerID = normalizeOwnerID(ownerID);
  if (!numericOwnerID) {
    return [];
  }
  const table = ensureTable();
  return Object.values(table.bills || {})
    .map((bill) => normalizeBillRecord(bill))
    .filter((bill) => bill.creditorID === numericOwnerID && !bill.processingStatus)
    .sort((left, right) => {
      const leftDue = BigInt(left.dueDateTime);
      const rightDue = BigInt(right.dueDateTime);
      if (leftDue === rightDue) {
        return Number(right.billID) - Number(left.billID);
      }
      return rightDue > leftDue ? 1 : -1;
    });
}

function notifyBillReceived(ownerID, billID) {
  const numericOwnerID = normalizeOwnerID(ownerID);
  const numericBillID = Number(billID) || 0;
  if (!numericOwnerID || !numericBillID) {
    return;
  }
  for (const session of sessionRegistry.getSessions()) {
    if (
      Number(session && (session.corporationID || session.corpid)) !== numericOwnerID &&
      Number(session && (session.allianceID || session.allianceid)) !== numericOwnerID &&
      Number(session && (session.characterID || session.charid)) !== numericOwnerID
    ) {
      continue;
    }
    if (typeof session.sendNotification === "function") {
      // TQ sends no arguments; the client refreshes its bills (walletSvc.OnBillReceived).
      session.sendNotification("OnBillReceived", "*corpid&corprole", []);
    }
  }
}

function createBill({
  billTypeID,
  amount,
  debtorID,
  creditorID,
  interest = 0,
  dueDateTime = null,
  externalID = -1,
  externalID2 = -1,
  emitBillReceived = true,
  creationKey = null,
  onCreated = null,
} = {}) {
  const normalizedDebtorID = normalizeOwnerID(debtorID);
  const normalizedCreditorID = normalizeOwnerID(creditorID);
  if (!normalizedDebtorID || !normalizedCreditorID) {
    return null;
  }

  const normalizedCreationKey = String(creationKey || "").trim();
  const resolvedDueDateTime = String(dueDateTime || currentFileTime());
  let createdBillID = null;
  let wasCreated = false;
  updateBillTable((table) => {
    if (normalizedCreationKey) {
      const existing = Object.values(table.bills || {}).find(
        (bill) => String(bill && bill.creationKey || "") === normalizedCreationKey,
      );
      if (existing) {
        const normalizedExisting = normalizeBillRecord(existing);
        const fingerprintMatches =
          normalizedExisting.billTypeID === normalizeBillTypeID(billTypeID) &&
          normalizedExisting.amount === normalizeMoney(amount, 0) &&
          normalizedExisting.interest === normalizeMoney(interest, 0) &&
          normalizedExisting.debtorID === normalizedDebtorID &&
          normalizedExisting.creditorID === normalizedCreditorID &&
          normalizedExisting.dueDateTime === resolvedDueDateTime &&
          normalizedExisting.externalID === (Number(externalID) || -1) &&
          normalizedExisting.externalID2 === (Number(externalID2) || -1);
        if (!fingerprintMatches) {
          throw new Error(
            `bill creation key ${normalizedCreationKey} was reused with a different payload`,
          );
        }
        createdBillID = Number(existing.billID) || null;
        return table;
      }
    }
    createdBillID = Number(table._meta.nextBillID || 1) || 1;
    table._meta.nextBillID = createdBillID + 1;
    table.bills[String(createdBillID)] = normalizeBillRecord({
      billID: createdBillID,
      billTypeID,
      amount,
      interest,
      debtorID: normalizedDebtorID,
      creditorID: normalizedCreditorID,
      dueDateTime: resolvedDueDateTime,
      externalID,
      externalID2,
      paid: false,
      creationKey: normalizedCreationKey,
    });
    wasCreated = true;
    return table;
  });
  if (wasCreated) {
    commitBillTable();
  }

  const createdBill = getBillRecord(createdBillID);
  if (createdBill && wasCreated) {
    queueDurableBillReconciliation(createdBill);
    if (emitBillReceived !== false) {
      notifyBillReceived(createdBill.debtorID, createdBill.billID);
    }
    // CharBillMsg (9): persistent center row for a character debtor (corp/alliance
    // debtors are notified by their own issuing producers). Lazy-required to avoid
    // a load-time cycle through the notification/corporation services.
    require(path.join(__dirname, "./billNotifications")).notifyBillIssued(createdBill);
    if (typeof onCreated === "function") {
      onCreated(createdBill);
    }
  }
  return createdBill;
}

function markBillPaid(billID, paidByOwnerID) {
  const numericBillID = Number(billID) || 0;
  const numericPaidByOwnerID = normalizeOwnerID(paidByOwnerID);
  if (!numericBillID) {
    return null;
  }
  let alreadyPaid = false;
  updateBillTable((table) => {
    const existing = table.bills[String(numericBillID)];
    if (!existing) {
      return table;
    }
    if (existing.paid) {
      alreadyPaid = true;
    }
    table.bills[String(numericBillID)] = normalizeBillRecord({
      ...existing,
      paid: true,
      paidDateTime: currentFileTime(),
      paidByOwnerID: numericPaidByOwnerID,
    });
    return table;
  });
  commitBillTable();
  const bill = getBillRecord(numericBillID);
  // BillPaidCharMsg (12) / BillPaidCorpAllMsg (13): receipt to the debtor, once
  // per payment. Lazy-required to avoid a load-time cycle through the
  // notification/corporation services.
  if (bill && !alreadyPaid) {
    require(path.join(__dirname, "./billNotifications")).notifyBillPaid(bill);
  }
  return bill;
}

function markBillProcessed(billID, processingStatus, options = {}) {
  const numericBillID = Number(billID) || 0;
  const normalizedStatus =
    typeof processingStatus === "string" && processingStatus.trim() !== ""
      ? processingStatus.trim()
      : null;
  if (!numericBillID || !normalizedStatus) {
    return null;
  }
  const existingBill = getBillRecord(numericBillID);
  updateBillTable((table) => {
    if (!table.bills[String(numericBillID)]) {
      return table;
    }
    table.bills[String(numericBillID)] = normalizeBillRecord({
      ...table.bills[String(numericBillID)],
      processingStatus: normalizedStatus,
      processedDateTime: options.processedDateTime || currentFileTime(),
      renewedBillID: Number(options.renewedBillID || 0) || 0,
    });
    return table;
  });
  commitBillTable();
  if (existingBill) {
    queueDurableBillCancellation(existingBill);
  }
  return getBillRecord(numericBillID);
}

function getBillPaymentEntryTypeID(bill) {
  if (
    Number(bill && bill.billTypeID) === BILL_TYPE_RENTAL &&
    Number(bill && bill.externalID) === TYPE_OFFICE_RENTAL
  ) {
    return JOURNAL_ENTRY_TYPE.OFFICE_RENTAL_FEE;
  }
  if (Number(bill && bill.billTypeID) === BILL_TYPE_ALLIANCE_MAINTENANCE) {
    return JOURNAL_ENTRY_TYPE.ALLIANCE_MAINTENANCE_FEE;
  }
  return JOURNAL_ENTRY_TYPE.PLAYER_DONATION;
}

function getBillPaymentReferenceID(bill) {
  // FmtWalletEntry(refAllianceMaintainanceFee) resolves arg1 as an owner name.
  // Type-5 bills carry that alliance owner in externalID; externalID2 is -1.
  if (Number(bill && bill.billTypeID) === BILL_TYPE_ALLIANCE_MAINTENANCE) {
    return Number(bill && bill.externalID) || Number(bill && bill.debtorID) || 0;
  }
  return Number(bill && (bill.externalID2 || bill.billID)) ||
    Number(bill && bill.billID) || 0;
}

function runSerializedBillPayment(billID, operation) {
  const laneKey = String(Number(billID) || 0);
  const previous = billPaymentLanes.get(laneKey) || Promise.resolve();
  const current = previous.catch(() => null).then(operation);
  billPaymentLanes.set(laneKey, current);
  void current.finally(() => {
    if (billPaymentLanes.get(laneKey) === current) {
      billPaymentLanes.delete(laneKey);
    }
  }).catch(() => null);
  return current;
}

function persistBillPaymentCheckpoint(billID, paymentID, mutate) {
  const numericBillID = Number(billID) || 0;
  let changed = false;
  updateBillTable((table) => {
    const existing = table.bills[String(numericBillID)];
    const saga = normalizeBillPaymentSaga(existing && existing.paymentSaga);
    if (!existing || !saga || saga.paymentID !== paymentID) {
      return table;
    }
    const nextSaga = mutate({ ...saga });
    table.bills[String(numericBillID)] = normalizeBillRecord({
      ...existing,
      paymentSaga: nextSaga,
    });
    changed = true;
    return table;
  });
  if (changed) {
    commitBillTable();
  }
  return changed ? getBillRecord(numericBillID) : null;
}

async function debitPendingBillPayment(bill, saga) {
  const journalOptions = {
    entryTypeID: getBillPaymentEntryTypeID(bill),
    idempotencyKey: saga.debitCommandID,
    ownerID1: saga.payerOwnerID,
    ownerID2: bill.creditorID,
    referenceID: getBillPaymentReferenceID(bill),
    description: `Bill payment ${bill.billID}`,
  };
  const commandMetadata = {
    commandID: saga.debitCommandID,
    idempotencyKey: saga.debitCommandID,
    source: "bill-payment-debit",
  };
  if (saga.payerKind === "character") {
    return adjustCharacterBalanceAsync(
      saga.payerOwnerID,
      -saga.amount,
      journalOptions,
      commandMetadata,
    );
  }
  return adjustCorporationWalletDivisionBalanceAsync(
    saga.payerOwnerID,
    saga.accountKey,
    -saga.amount,
    journalOptions,
    commandMetadata,
  );
}

async function creditPendingBillPayment(bill, saga) {
  if (!saga.creditorCorporationID) {
    return { success: true, data: null };
  }
  return adjustCorporationWalletDivisionBalanceAsync(
    saga.creditorCorporationID,
    DEFAULT_DIVISION_ID,
    saga.amount,
    {
      entryTypeID: getBillPaymentEntryTypeID(bill),
      idempotencyKey: saga.creditCommandID,
      ownerID1: saga.payerOwnerID,
      ownerID2: saga.creditorCorporationID,
      referenceID: getBillPaymentReferenceID(bill),
      description: `Bill payment ${bill.billID}`,
    },
    {
      commandID: saga.creditCommandID,
      idempotencyKey: saga.creditCommandID,
      source: "bill-payment-credit",
    },
  );
}

function finalizePendingBillPayment(billID, paymentID) {
  const numericBillID = Number(billID) || 0;
  let finalized = false;
  updateBillTable((table) => {
    const existing = table.bills[String(numericBillID)];
    const saga = normalizeBillPaymentSaga(existing && existing.paymentSaga);
    if (
      !existing ||
      !saga ||
      saga.paymentID !== paymentID ||
      !saga.debitApplied ||
      !saga.creditApplied
    ) {
      return table;
    }
    table.bills[String(numericBillID)] = normalizeBillRecord({
      ...existing,
      paid: true,
      paidDateTime: currentFileTime(),
      paidByOwnerID: saga.payerOwnerID,
      paymentSaga: null,
    });
    finalized = true;
    return table;
  });
  if (!finalized) {
    return null;
  }
  commitBillTable();
  const bill = getBillRecord(numericBillID);
  if (bill) {
    require(path.join(__dirname, "./billNotifications")).notifyBillPaid(bill);
    queueDurableBillReconciliation(bill);
  }
  return bill;
}

async function settlePendingBillPaymentInternal(billID) {
  let bill = getBillRecord(billID);
  if (!bill) {
    return { success: false, errorMsg: "BILL_NOT_FOUND" };
  }
  if (bill.paid && !bill.paymentSaga) {
    return { success: true, alreadySettled: true, data: bill };
  }
  let saga = bill.paymentSaga;
  if (!saga) {
    return { success: false, errorMsg: "BILL_PAYMENT_NOT_PENDING" };
  }

  if (!saga.debitApplied) {
    const debitResult = await debitPendingBillPayment(bill, saga);
    if (!debitResult || debitResult.success !== true) {
      if (debitResult && debitResult.errorMsg === "INSUFFICIENT_FUNDS") {
        const clearedBill = persistBillPaymentCheckpoint(
          bill.billID,
          saga.paymentID,
          () => null,
        );
        if (clearedBill) {
          queueDurableBillReconciliation(clearedBill);
        }
      }
      return debitResult || { success: false, errorMsg: "WALLET_DEBIT_FAILED" };
    }
    bill = persistBillPaymentCheckpoint(
      bill.billID,
      saga.paymentID,
      (nextSaga) => ({ ...nextSaga, debitApplied: true }),
    );
    if (!bill) {
      throw new Error(`bill ${Number(billID) || 0} debit checkpoint was lost`);
    }
    saga = bill.paymentSaga;
  }

  if (!saga.creditApplied) {
    const creditResult = await creditPendingBillPayment(bill, saga);
    if (!creditResult || creditResult.success !== true) {
      return creditResult || { success: false, errorMsg: "WALLET_CREDIT_FAILED" };
    }
    bill = persistBillPaymentCheckpoint(
      bill.billID,
      saga.paymentID,
      (nextSaga) => ({ ...nextSaga, creditApplied: true }),
    );
    if (!bill) {
      throw new Error(`bill ${Number(billID) || 0} credit checkpoint was lost`);
    }
    saga = bill.paymentSaga;
  }

  const paidBill = finalizePendingBillPayment(bill.billID, saga.paymentID);
  if (!paidBill) {
    throw new Error(`bill ${bill.billID} payment finalization was lost`);
  }
  return { success: true, data: paidBill };
}

function settlePendingBillPayment(billID) {
  return runSerializedBillPayment(
    billID,
    () => settlePendingBillPaymentInternal(billID),
  );
}

// Due-date producers and interactive payments must make their terminal decision
// in the same lane. Otherwise PayBill can debit a bill while its producer is
// concurrently defaulting it (catastrophic for alliance-maintenance closure).
function runSerializedBillSettlement(billID, operation) {
  if (typeof operation !== "function") {
    return Promise.reject(new TypeError("bill settlement operation is required"));
  }
  return runSerializedBillPayment(billID, operation);
}

function beginBillPayment(billID, payerKind, payerOwnerID, accountKey = 0) {
  return runSerializedBillPayment(billID, async () => {
    const bill = getBillRecord(billID);
    const normalizedPayerOwnerID = normalizeOwnerID(payerOwnerID);
    const normalizedAccountKey = payerKind === "corporation"
      ? normalizeCorporationWalletKey(accountKey)
      : 0;
    if (!bill || bill.paid || bill.processingStatus || !normalizedPayerOwnerID) {
      return { success: false, errorMsg: "BILL_NOT_PAYABLE" };
    }

    if (bill.paymentSaga) {
      const pending = bill.paymentSaga;
      if (
        pending.payerKind !== payerKind ||
        pending.payerOwnerID !== normalizedPayerOwnerID ||
        pending.accountKey !== normalizedAccountKey
      ) {
        return { success: false, errorMsg: "BILL_PAYMENT_IN_PROGRESS" };
      }
      return settlePendingBillPaymentInternal(bill.billID);
    }

    if (payerKind === "character") {
      if (bill.debtorID !== normalizedPayerOwnerID) {
        return { success: false, errorMsg: "BILL_NOT_PAYABLE" };
      }
    } else if (bill.debtorID === normalizedPayerOwnerID) {
      if (!getCorporationRecord(normalizedPayerOwnerID)) {
        return { success: false, errorMsg: "CORPORATION_NOT_FOUND" };
      }
    } else {
      const alliance = getAllianceRecord(bill.debtorID);
      if (!alliance) {
        return { success: false, errorMsg: "ALLIANCE_NOT_FOUND" };
      }
      if (
        Number(getActiveExecutorCorporationID(bill.debtorID) || 0) !==
        normalizedPayerOwnerID
      ) {
        return { success: false, errorMsg: "ONLY_EXECUTOR_CAN_PAY" };
      }
    }

    const paymentID = crypto.randomUUID();
    const paymentSaga = normalizeBillPaymentSaga({
      paymentID,
      payerKind,
      payerOwnerID: normalizedPayerOwnerID,
      accountKey: normalizedAccountKey,
      amount: bill.amount,
      creditorCorporationID: getCorporationRecord(bill.creditorID)
        ? bill.creditorID
        : 0,
      debitCommandID: `bill:${bill.billID}:payment:${paymentID}:debit`,
      creditCommandID: `bill:${bill.billID}:payment:${paymentID}:credit`,
      requestedDateTime: currentFileTime(),
    });
    updateBillTable((table) => {
      const existing = table.bills[String(bill.billID)];
      table.bills[String(bill.billID)] = normalizeBillRecord({
        ...existing,
        paymentSaga,
      });
      return table;
    });
    commitBillTable();
    const pendingBill = getBillRecord(bill.billID);
    await queueDurableBillReconciliation(pendingBill);
    return settlePendingBillPaymentInternal(bill.billID);
  });
}

function payBillFromCharacter(billID, characterID) {
  return beginBillPayment(billID, "character", characterID);
}

function payBillFromCorporation(billID, corporationID, accountKey) {
  return beginBillPayment(billID, "corporation", corporationID, accountKey);
}

async function tryAutoPayBill(billID) {
  const bill = getBillRecord(billID);
  if (!bill || bill.paid) {
    return null;
  }

  const debtorSettings = getAutomaticPaySettingsForOwner(bill.debtorID);
  if (!debtorSettings[bill.billTypeID]) {
    return null;
  }

  if (getCorporationRecord(bill.debtorID)) {
    return payBillFromCorporation(
      bill.billID,
      bill.debtorID,
      debtorSettings.divisionID || DEFAULT_DIVISION_ID,
    );
  }

  const alliance = getAllianceRecord(bill.debtorID);
  if (!alliance) {
    return null;
  }
  const executorCorporationID = normalizeOwnerID(
    getActiveExecutorCorporationID(bill.debtorID),
  );
  if (!executorCorporationID) {
    return null;
  }
  const executorSettings = getAutomaticPaySettingsForOwner(executorCorporationID);
  return payBillFromCorporation(
    bill.billID,
    executorCorporationID,
    executorSettings.divisionID || DEFAULT_DIVISION_ID,
  );
}

function normalizeFileTimeBoundary(value) {
  try {
    const filetime = BigInt(String(value || currentFileTime()));
    return filetime > 0n ? filetime : currentFileTime();
  } catch (_error) {
    return currentFileTime();
  }
}

function listDueBills({
  nowFileTime = currentFileTime(),
  billTypeID = null,
  externalID = null,
} = {}) {
  const now = normalizeFileTimeBoundary(nowFileTime);
  const normalizedBillTypeID =
    billTypeID === null || billTypeID === undefined
      ? null
      : normalizeBillTypeID(billTypeID);
  const normalizedExternalID =
    externalID === null || externalID === undefined
      ? null
      : Number(externalID) || -1;
  const table = ensureTable();
  return Object.values(table.bills || {})
    .map((bill) => normalizeBillRecord(bill))
    .filter((bill) => {
      if (bill.processingStatus) {
        return false;
      }
      if (normalizedBillTypeID !== null && bill.billTypeID !== normalizedBillTypeID) {
        return false;
      }
      if (normalizedExternalID !== null && bill.externalID !== normalizedExternalID) {
        return false;
      }
      try {
        return BigInt(String(bill.dueDateTime || "0")) <= now;
      } catch (_error) {
        // ignored: an unreadable due date is not due yet (false)
        return false;
      }
    })
    .sort((left, right) => {
      const leftDue = BigInt(left.dueDateTime);
      const rightDue = BigInt(right.dueDateTime);
      if (leftDue === rightDue) {
        return Number(left.billID) - Number(right.billID);
      }
      return leftDue > rightDue ? 1 : -1;
    });
}

function listPendingBills() {
  const table = ensureTable();
  return Object.values(table.bills || {})
    .map((bill) => normalizeBillRecord(bill))
    .filter((bill) => !bill.processingStatus)
    .sort((left, right) => Number(left.billID) - Number(right.billID));
}

function isDurableBillType(bill) {
  return Boolean(
    bill &&
      (
        Number(bill.billTypeID) === BILL_TYPE_WAR ||
        Number(bill.billTypeID) === BILL_TYPE_ALLIANCE_MAINTENANCE ||
        (
          Number(bill.billTypeID) === BILL_TYPE_RENTAL &&
          Number(bill.externalID) === TYPE_OFFICE_RENTAL
        )
      ),
  );
}

function normalizeBillDueFileTime(value) {
  try {
    const dueFileTime = BigInt(String(value || "0"));
    return dueFileTime > 0n ? dueFileTime : 0n;
  } catch (_error) {
    return 0n;
  }
}

function billDueFileTimeToUnixMs(value) {
  const dueFileTime = normalizeBillDueFileTime(value);
  if (dueFileTime <= FILETIME_UNIX_EPOCH_OFFSET) {
    return 0;
  }
  const unixTicks = dueFileTime - FILETIME_UNIX_EPOCH_OFFSET;
  const unixMs = (
    unixTicks + FILETIME_TICKS_PER_MILLISECOND - 1n
  ) / FILETIME_TICKS_PER_MILLISECOND;
  const numericUnixMs = Number(unixMs);
  return Number.isSafeInteger(numericUnixMs) && numericUnixMs > 0
    ? numericUnixMs
    : 0;
}

function buildDurableBillJobID(bill) {
  const billID = Number(bill && bill.billID) || 0;
  const paymentSaga = normalizeBillPaymentSaga(bill && bill.paymentSaga);
  if (paymentSaga) {
    return `corporation-bill:${billID}:payment:${paymentSaga.paymentID}`;
  }
  const dueDateTime = normalizeBillDueFileTime(bill && bill.dueDateTime);
  return `corporation-bill:${billID}:${dueDateTime}:due`;
}

function buildDurableBillJob(bill) {
  const billID = Number(bill && bill.billID) || 0;
  const paymentSaga = normalizeBillPaymentSaga(bill && bill.paymentSaga);
  if (billID <= 0 || bill && bill.processingStatus) {
    return null;
  }
  if (paymentSaga) {
    return {
      jobID: buildDurableBillJobID(bill),
      type: DURABLE_DUE_JOB_TYPE,
      dueAtMs: Date.now(),
      payload: {
        billID,
        paymentID: paymentSaga.paymentID,
      },
    };
  }
  const dueDateTime = normalizeBillDueFileTime(bill && bill.dueDateTime);
  const dueAtMs = billDueFileTimeToUnixMs(dueDateTime);
  if (
    dueDateTime <= 0n ||
    dueAtMs < 0 ||
    !isDurableBillType(bill)
  ) {
    return null;
  }
  return {
    jobID: buildDurableBillJobID(bill),
    type: DURABLE_DUE_JOB_TYPE,
    dueAtMs: dueAtMs + BILL_DUE_GRACE_MS,
    payload: {
      billID,
      dueDateTime: dueDateTime.toString(),
    },
  };
}

async function scheduleDurableBill(bill) {
  if (!durableBillScheduler) {
    return null;
  }
  const job = buildDurableBillJob(bill);
  if (!job) {
    return null;
  }
  await durableBillScheduler.schedule(job);
  return job;
}

async function cancelDurableBill(bill) {
  if (!durableBillScheduler || !bill) {
    return false;
  }
  const jobID = buildDurableBillJobID(bill);
  if (activeDurableBillJobs.has(jobID)) {
    return false;
  }
  await durableBillScheduler.cancel(jobID);
  return true;
}

function queueDurableBillReconciliation(bill) {
  if (!durableBillScheduler) {
    return Promise.resolve(null);
  }
  const promise = scheduleDurableBill(bill);
  void promise.catch((error) => {
    log.warn(
      `[BillRuntime] Durable due-date scheduling failed bill=${Number(bill && bill.billID) || 0}: ${error.message}`,
    );
  });
  return promise;
}

function queueDurableBillCancellation(bill) {
  if (!durableBillScheduler) {
    return Promise.resolve(false);
  }
  const promise = cancelDurableBill(bill);
  void promise.catch((error) => {
    log.warn(
      `[BillRuntime] Durable due-date cancellation deferred bill=${Number(bill && bill.billID) || 0}: ${error.message}`,
    );
  });
  return promise;
}

function bindDurableScheduler(scheduler) {
  if (
    !scheduler ||
    typeof scheduler.schedule !== "function" ||
    typeof scheduler.cancel !== "function"
  ) {
    throw new TypeError("bill scheduler requires schedule and cancel functions");
  }
  durableBillScheduler = scheduler;
  return true;
}

function unbindDurableScheduler(scheduler = null) {
  if (scheduler && durableBillScheduler !== scheduler) {
    return false;
  }
  durableBillScheduler = null;
  activeDurableBillJobs.clear();
  return true;
}

async function reconcileDurableBills() {
  if (!durableBillScheduler) {
    return { scheduled: 0 };
  }
  // Maintenance billing is itself represented by durable corporation-bill due
  // jobs. Materialize or repair the single open bill per active alliance before
  // scanning, so the ordinary bill scheduler owns both restart recovery and
  // monthly renewal without a second timer domain.
  const maintenanceReconciliation = require(path.join(
    __dirname,
    "../corporation/allianceMaintenanceBilling",
  )).reconcileAllianceMaintenanceBills();
  let scheduled = 0;
  for (const bill of listPendingBills()) {
    const job = await scheduleDurableBill(bill);
    if (job) scheduled += 1;
  }
  return {
    scheduled,
    allianceMaintenanceCreated:
      Number(maintenanceReconciliation && maintenanceReconciliation.created) || 0,
    allianceMaintenanceExisting:
      Number(maintenanceReconciliation && maintenanceReconciliation.existing) || 0,
  };
}

function flushDurableBillingOwnerState() {
  for (const table of [
    BILLS_TABLE,
    "alliances",
    "allianceDepartures",
    "corporationRuntime",
    "items",
    "notifications",
    "structureAssetSafety",
  ]) {
    database.flushTableAsync(table);
  }
}

async function handleDurableBillDue(job) {
  const jobID = String(job && job.jobID || "");
  const billID = Number(job && job.payload && job.payload.billID) || 0;
  const expectedPaymentID = String(
    job && job.payload && job.payload.paymentID || "",
  );
  const expectedDueDateTime = String(
    job && job.payload && job.payload.dueDateTime || "",
  );
  if (!jobID || billID <= 0 || (!expectedPaymentID && !expectedDueDateTime)) {
    throw new Error("corporation bill due job is invalid");
  }

  activeDurableBillJobs.add(jobID);
  try {
    const bill = getBillRecord(billID);
    if (!bill) {
      return { billID, missing: true };
    }
    if (bill.processingStatus) {
      return { billID, status: bill.processingStatus, stale: true };
    }
    if (expectedPaymentID) {
      if (
        !bill.paymentSaga ||
        bill.paymentSaga.paymentID !== expectedPaymentID
      ) {
        await scheduleDurableBill(bill);
        return { billID, stale: true };
      }
      const paymentResult = await settlePendingBillPayment(billID);
      const settledBill = getBillRecord(billID);
      if (!paymentResult || paymentResult.success !== true) {
        if (settledBill && settledBill.paymentSaga) {
          throw new Error(
            `corporation bill ${billID} payment settlement is incomplete`,
          );
        }
        await scheduleDurableBill(settledBill);
        return {
          billID,
          paymentFailed: true,
          errorMsg: paymentResult && paymentResult.errorMsg || "PAYMENT_FAILED",
        };
      }
      await scheduleDurableBill(settledBill);
      return { billID, paymentSettled: true };
    }
    if (bill.paymentSaga) {
      await scheduleDurableBill(bill);
      return { billID, stale: true };
    }
    if (String(bill.dueDateTime) !== expectedDueDateTime) {
      await scheduleDurableBill(bill);
      return { billID, stale: true };
    }
    if (normalizeBillDueFileTime(bill.dueDateTime) > currentFileTime()) {
      throw new Error(`corporation bill ${billID} fired before its due date`);
    }

    let result = null;
    if (
      Number(bill.billTypeID) === BILL_TYPE_RENTAL &&
      Number(bill.externalID) === TYPE_OFFICE_RENTAL
    ) {
      const { processDueOfficeRentalBills } = require(path.join(
        __dirname,
        "../corporation/officeRentalBilling",
      ));
      result = await processDueOfficeRentalBills({
        billID,
        nowFileTime: currentFileTime(),
        reason: "durable-scheduler",
      });
    } else if (Number(bill.billTypeID) === BILL_TYPE_WAR) {
      const { processDueWarBills } = require(path.join(
        __dirname,
        "../corporation/warRuntimeState",
      ));
      result = await processDueWarBills({
        billID,
        nowFileTime: currentFileTime(),
        reason: "durable-scheduler",
      });
    } else if (
      Number(bill.billTypeID) === BILL_TYPE_ALLIANCE_MAINTENANCE
    ) {
      const { processDueAllianceMaintenanceBills } = require(path.join(
        __dirname,
        "../corporation/allianceMaintenanceBilling",
      ));
      result = await processDueAllianceMaintenanceBills({
        billID,
        nowFileTime: currentFileTime(),
        reason: "durable-scheduler",
      });
    } else {
      return { billID, unsupported: true };
    }

    flushDurableBillingOwnerState();
    const settledBill = getBillRecord(billID);
    if (!settledBill || !settledBill.processingStatus) {
      const action = result && result.processed && result.processed[0] &&
        result.processed[0].action;
      throw new Error(
        `corporation bill ${billID} settlement is incomplete${action ? ` (${action})` : ""}`,
      );
    }
    return {
      billID,
      status: settledBill.processingStatus,
      renewedBillID: Number(settledBill.renewedBillID) || 0,
    };
  } finally {
    activeDurableBillJobs.delete(jobID);
  }
}

module.exports = {
  BILL_TYPE_ALLIANCE_MAINTENANCE,
  BILL_TYPE_BROKER,
  BILL_TYPE_MARKET_FINE,
  BILL_TYPE_RENTAL,
  BILL_TYPE_WAR,
  DEFAULT_DIVISION_ID,
  DURABLE_DUE_JOB_TYPE,
  bindDurableScheduler,
  buildDurableBillJob,
  buildAutomaticPaySettingsSnapshot,
  createBill,
  getAutomaticPaySettingsForOwner,
  getBillRecord,
  handleDurableBillDue,
  listDueBills,
  listBillsForCreditor,
  listBillsForDebtor,
  listPendingBills,
  listUnpaidBillsForDebtor,
  markBillPaid,
  markBillProcessed,
  payBillFromCharacter,
  payBillFromCorporation,
  reconcileDurableBills,
  runSerializedBillSettlement,
  setAutomaticPaySettingsForOwner,
  settlePendingBillPayment,
  tryAutoPayBill,
  unbindDurableScheduler,
};
