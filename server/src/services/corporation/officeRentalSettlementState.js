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
  getCorporationRecord,
} = require(path.join(__dirname, "./corporationState"));
const {
  addOfficeRentalPeriod,
  createNextOfficeRentalBill,
} = require(path.join(__dirname, "./officeRentalBilling"));
const {
  JOURNAL_ENTRY_TYPE,
} = require(path.join(__dirname, "../account/walletState"));
const worldData = require(path.join(__dirname, "../../space/worldData"));
const structureState = require(path.join(__dirname, "../structure/structureState"));

const DURABLE_SETTLEMENT_JOB_TYPE = "office.rent";
const DURABLE_SETTLEMENT_JOB_PREFIX = "office-rental:";
const settlementLanes = new Map();
let durableScheduler = null;

function normalizeMoney(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  return Math.max(0, Math.round(numeric * 100) / 100);
}

function normalizeOffice(value, corporationID, stationID) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const officeID = normalizePositiveInteger(value.officeID, 0);
  if (!officeID) {
    return null;
  }
  return {
    corporationID,
    stationID,
    leaseID: normalizePositiveInteger(value.leaseID, officeID),
    officeID,
    officeFolderID: normalizePositiveInteger(value.officeFolderID, 0),
    itemID: normalizePositiveInteger(value.itemID, 0),
    solarSystemID: normalizePositiveInteger(value.solarSystemID, null),
    typeID: normalizePositiveInteger(value.typeID, null),
    stationTypeID: normalizePositiveInteger(
      value.stationTypeID,
      normalizePositiveInteger(value.typeID, null),
    ),
    rentalCost: normalizeMoney(value.rentalCost),
    startDate: String(value.startDate || "0"),
    dueDate: String(value.dueDate || value.expiryDate || "0"),
    billID: normalizePositiveInteger(value.billID, null),
    expiryDate: String(value.expiryDate || value.dueDate || "0"),
    impounded: false,
  };
}

function normalizeSettlement(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const operationID = String(value.operationID || "").trim();
  const corporationID = normalizePositiveInteger(value.corporationID, 0);
  const stationID = normalizePositiveInteger(value.stationID, 0);
  const office = normalizeOffice(value.office, corporationID, stationID);
  if (!operationID || !corporationID || !stationID || !office) {
    return null;
  }
  const ownerCorporationID = normalizePositiveInteger(
    value.ownerCorporationID,
    0,
  );
  const amount = normalizeMoney(value.amount);
  return {
    operationID,
    corporationID,
    stationID,
    ownerCorporationID,
    amount,
    accountKey: normalizePositiveInteger(
      value.accountKey,
      CORPORATION_WALLET_KEY_START,
    ),
    office,
    debitApplied: amount <= 0 || Boolean(value.debitApplied),
    creditApplied:
      amount <= 0 || !ownerCorporationID || Boolean(value.creditApplied),
    officeApplied: Boolean(value.officeApplied),
    debitCommandID: String(
      value.debitCommandID || `${DURABLE_SETTLEMENT_JOB_PREFIX}${operationID}:debit`,
    ),
    creditCommandID: String(
      value.creditCommandID || `${DURABLE_SETTLEMENT_JOB_PREFIX}${operationID}:credit`,
    ),
    billCreationKey: String(
      value.billCreationKey || `${DURABLE_SETTLEMENT_JOB_PREFIX}${operationID}:bill`,
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
      runtime.officeRentalSettlements &&
      runtime.officeRentalSettlements[String(operationID)],
  );
}

function listPendingOfficeRentalSettlements() {
  const runtimeTable = ensureRuntimeInitialized();
  const settlements = [];
  for (const runtime of Object.values(runtimeTable.corporations || {})) {
    for (const value of Object.values(
      runtime && runtime.officeRentalSettlements || {},
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

function allocateRuntimeID(runtimeTable, key) {
  const nextID = normalizePositiveInteger(
    runtimeTable._meta && runtimeTable._meta[key],
    1,
  ) || 1;
  runtimeTable._meta[key] = nextID + 1;
  return nextID;
}

function prepareOfficeRental(options = {}) {
  const corporationID = normalizePositiveInteger(options.corporationID, 0);
  const stationID = normalizePositiveInteger(options.stationID, 0);
  if (!corporationID || !stationID) {
    return { success: false, errorMsg: "INVALID_OFFICE_LOCATION" };
  }
  // An office is in an NPC station or in a structure, whatever the caller gives.
  if (
    !worldData.getStationByID(stationID) &&
    !structureState.getStructureByID(stationID, { refresh: false })
  ) {
    return { success: false, errorMsg: "INVALID_OFFICE_LOCATION" };
  }

  let settlement = null;
  let existingOffice = null;
  const writeResult = updateRuntimeState((runtimeTable) => {
    const runtime = runtimeTable.corporations[String(corporationID)];
    if (!runtime) {
      return runtimeTable;
    }
    runtime.offices = runtime.offices && typeof runtime.offices === "object"
      ? runtime.offices
      : {};
    runtime.officeRentalSettlements =
      runtime.officeRentalSettlements &&
      typeof runtime.officeRentalSettlements === "object"
        ? runtime.officeRentalSettlements
        : {};
    const pending = Object.values(runtime.officeRentalSettlements)
      .map((value) => normalizeSettlement(value))
      .find((value) => value && value.stationID === stationID);
    if (pending) {
      settlement = pending;
      return runtimeTable;
    }
    existingOffice = Object.values(runtime.offices).find((office) =>
      Number(office && office.stationID) === stationID &&
      !Boolean(office && office.impounded)) || null;
    if (existingOffice) {
      return runtimeTable;
    }

    const operationSequence = allocateRuntimeID(
      runtimeTable,
      "nextOfficeRentalOperationID",
    );
    const officeID = allocateRuntimeID(runtimeTable, "nextOfficeID");
    const startDate = String(options.startDate || currentFileTime());
    const dueDate = String(options.dueDate || addOfficeRentalPeriod(startDate));
    const operationID = `${corporationID}:${stationID}:${operationSequence}`;
    const ownerCorporationID = getCorporationRecord(options.ownerCorporationID)
      ? normalizePositiveInteger(options.ownerCorporationID, 0)
      : 0;
    const amount = normalizeMoney(options.rentalCost);
    settlement = {
      operationID,
      corporationID,
      stationID,
      ownerCorporationID,
      amount,
      accountKey: CORPORATION_WALLET_KEY_START,
      office: {
        corporationID,
        stationID,
        leaseID: officeID,
        officeID,
        officeFolderID: allocateRuntimeID(runtimeTable, "nextOfficeFolderID"),
        itemID: allocateRuntimeID(runtimeTable, "nextOfficeItemID"),
        solarSystemID: normalizePositiveInteger(options.solarSystemID, null),
        typeID: normalizePositiveInteger(options.stationTypeID, null),
        stationTypeID: normalizePositiveInteger(options.stationTypeID, null),
        rentalCost: amount,
        startDate,
        dueDate,
        billID: null,
        expiryDate: dueDate,
        impounded: false,
      },
      debitApplied: amount <= 0,
      creditApplied: amount <= 0 || !ownerCorporationID,
      officeApplied: false,
      debitCommandID: `${DURABLE_SETTLEMENT_JOB_PREFIX}${operationID}:debit`,
      creditCommandID: `${DURABLE_SETTLEMENT_JOB_PREFIX}${operationID}:credit`,
      billCreationKey: `${DURABLE_SETTLEMENT_JOB_PREFIX}${operationID}:bill`,
      createdAt: String(currentFileTime()),
    };
    runtime.officeRentalSettlements[operationID] = settlement;
    return runtimeTable;
  });
  if (!writeResult || writeResult.success !== true) {
    return writeResult || { success: false, errorMsg: "PERSISTENCE_ERROR" };
  }
  if (existingOffice) {
    return {
      success: true,
      alreadyRented: true,
      data: { office: cloneValue(existingOffice) },
    };
  }
  flushRuntimeState();
  return { success: true, data: cloneValue(settlement) };
}

function mutateSettlement(corporationID, operationID, mutate) {
  let changed = false;
  const writeResult = updateRuntimeState((runtimeTable) => {
    const runtime = runtimeTable.corporations[String(corporationID)];
    const current = normalizeSettlement(
      runtime &&
        runtime.officeRentalSettlements &&
        runtime.officeRentalSettlements[String(operationID)],
    );
    if (!runtime || !current) {
      return runtimeTable;
    }
    const next = typeof mutate === "function" ? mutate(current) : current;
    if (next) {
      runtime.officeRentalSettlements[String(operationID)] = next;
    } else {
      delete runtime.officeRentalSettlements[String(operationID)];
    }
    changed = true;
    return runtimeTable;
  });
  if (writeResult && writeResult.success && changed) {
    flushRuntimeState();
  }
  return writeResult && writeResult.success && changed;
}

async function debitRental(settlement) {
  if (settlement.debitApplied) {
    return { success: true, data: null };
  }
  return adjustCorporationWalletDivisionBalanceAsync(
    settlement.corporationID,
    settlement.accountKey,
    -settlement.amount,
    {
      entryTypeID: JOURNAL_ENTRY_TYPE.OFFICE_RENTAL_FEE,
      idempotencyKey: settlement.debitCommandID,
      ownerID1: settlement.corporationID,
      ownerID2: settlement.ownerCorporationID,
      referenceID: settlement.stationID,
      description: `Corporation office rental at ${settlement.stationID}`,
    },
    {
      commandID: settlement.debitCommandID,
      idempotencyKey: settlement.debitCommandID,
      source: "office-rental-debit",
    },
  );
}

async function creditRentalOwner(settlement) {
  if (settlement.creditApplied) {
    return { success: true, data: null };
  }
  return adjustCorporationWalletDivisionBalanceAsync(
    settlement.ownerCorporationID,
    CORPORATION_WALLET_KEY_START,
    settlement.amount,
    {
      entryTypeID: JOURNAL_ENTRY_TYPE.OFFICE_RENTAL_FEE,
      idempotencyKey: settlement.creditCommandID,
      ownerID1: settlement.corporationID,
      ownerID2: settlement.ownerCorporationID,
      referenceID: settlement.stationID,
      description: `Corporation office rental at ${settlement.stationID}`,
    },
    {
      commandID: settlement.creditCommandID,
      idempotencyKey: settlement.creditCommandID,
      source: "office-rental-credit",
    },
  );
}

function applyOffice(settlement) {
  let applied = false;
  const writeResult = updateRuntimeState((runtimeTable) => {
    const runtime = runtimeTable.corporations[String(settlement.corporationID)];
    const current = normalizeSettlement(
      runtime &&
        runtime.officeRentalSettlements &&
        runtime.officeRentalSettlements[settlement.operationID],
    );
    if (!runtime || !current) {
      return runtimeTable;
    }
    const competingOffice = Object.values(runtime.offices || {}).find((office) =>
      Number(office && office.stationID) === current.stationID &&
      Number(office && office.officeID) !== current.office.officeID &&
      !Boolean(office && office.impounded));
    if (competingOffice) {
      return runtimeTable;
    }
    runtime.offices[current.office.officeID] = cloneValue(current.office);
    current.officeApplied = true;
    runtime.officeRentalSettlements[current.operationID] = current;
    applied = true;
    return runtimeTable;
  });
  if (writeResult && writeResult.success && applied) {
    flushRuntimeState();
  }
  return Boolean(writeResult && writeResult.success && applied);
}

function finalizeRental(settlement, bill) {
  let finalizedOffice = null;
  const writeResult = updateRuntimeState((runtimeTable) => {
    const runtime = runtimeTable.corporations[String(settlement.corporationID)];
    const current = normalizeSettlement(
      runtime &&
        runtime.officeRentalSettlements &&
        runtime.officeRentalSettlements[settlement.operationID],
    );
    const office = runtime && runtime.offices &&
      runtime.offices[String(settlement.office.officeID)];
    if (!runtime || !current || !office || !current.officeApplied) {
      return runtimeTable;
    }
    if (bill) {
      office.billID = normalizePositiveInteger(bill.billID, null);
      office.dueDate = String(bill.dueDateTime || office.dueDate);
      office.expiryDate = office.dueDate;
    }
    finalizedOffice = cloneValue(office);
    delete runtime.officeRentalSettlements[settlement.operationID];
    return runtimeTable;
  });
  if (writeResult && writeResult.success && finalizedOffice) {
    flushRuntimeState();
    return finalizedOffice;
  }
  return null;
}

async function settlePendingOfficeRentalInternal(corporationID, operationID) {
  let settlement = getPendingSettlement(corporationID, operationID);
  if (!settlement) {
    return { success: true, alreadySettled: true, data: null };
  }

  if (!settlement.debitApplied) {
    const debitResult = await debitRental(settlement);
    if (!debitResult || debitResult.success !== true) {
      if (debitResult && debitResult.errorMsg === "INSUFFICIENT_FUNDS") {
        mutateSettlement(corporationID, operationID, () => null);
      }
      return debitResult || { success: false, errorMsg: "WALLET_DEBIT_FAILED" };
    }
    if (!mutateSettlement(corporationID, operationID, (current) => ({
      ...current,
      debitApplied: true,
    }))) {
      return { success: false, errorMsg: "DEBIT_CHECKPOINT_FAILED" };
    }
    settlement = getPendingSettlement(corporationID, operationID);
    if (!settlement) {
      return { success: false, errorMsg: "DEBIT_CHECKPOINT_MISSING" };
    }
  }

  if (!settlement.creditApplied) {
    const creditResult = await creditRentalOwner(settlement);
    if (!creditResult || creditResult.success !== true) {
      return creditResult || { success: false, errorMsg: "OWNER_CREDIT_FAILED" };
    }
    if (!mutateSettlement(corporationID, operationID, (current) => ({
      ...current,
      creditApplied: true,
    }))) {
      return { success: false, errorMsg: "CREDIT_CHECKPOINT_FAILED" };
    }
    settlement = getPendingSettlement(corporationID, operationID);
    if (!settlement) {
      return { success: false, errorMsg: "CREDIT_CHECKPOINT_MISSING" };
    }
  }

  if (!settlement.officeApplied) {
    if (!applyOffice(settlement)) {
      return { success: false, errorMsg: "OFFICE_CHECKPOINT_FAILED" };
    }
    settlement = getPendingSettlement(corporationID, operationID);
    if (!settlement) {
      return { success: false, errorMsg: "OFFICE_CHECKPOINT_MISSING" };
    }
  }

  const bill = createNextOfficeRentalBill(
    settlement.corporationID,
    settlement.stationID,
    settlement.amount,
    {
      baseFileTime: settlement.office.startDate,
      creationKey: settlement.billCreationKey,
    },
  );
  const office = finalizeRental(settlement, bill);
  if (!office) {
    return { success: false, errorMsg: "RENTAL_FINALIZE_FAILED" };
  }
  return {
    success: true,
    data: {
      operationID: settlement.operationID,
      office,
      bill: bill ? cloneValue(bill) : null,
    },
  };
}

function settlePendingOfficeRental(corporationID, operationID) {
  const settlement = getPendingSettlement(corporationID, operationID);
  if (!settlement) {
    return Promise.resolve({ success: true, alreadySettled: true, data: null });
  }
  return runSerialized(settlement.corporationID, settlement.stationID, () =>
    settlePendingOfficeRentalInternal(
      settlement.corporationID,
      settlement.operationID,
    ));
}

function buildDurableOfficeRentalJob(settlement) {
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

async function schedulePendingOfficeRental(settlement) {
  if (!durableScheduler) {
    return null;
  }
  const job = buildDurableOfficeRentalJob(settlement);
  if (!job) {
    return null;
  }
  await durableScheduler.schedule(job);
  return job;
}

function rentCorporationOffice(options = {}) {
  const corporationID = normalizePositiveInteger(options.corporationID, 0);
  const stationID = normalizePositiveInteger(options.stationID, 0);
  return runSerialized(corporationID, stationID, async () => {
    const prepared = prepareOfficeRental(options);
    if (!prepared.success || prepared.alreadyRented || !prepared.data) {
      return prepared;
    }
    void schedulePendingOfficeRental(prepared.data).catch((error) => {
      log.warn(
        `[OfficeRental] Durable settlement scheduling failed operation=${prepared.data.operationID}: ${error.message}`,
      );
    });
    return settlePendingOfficeRentalInternal(
      prepared.data.corporationID,
      prepared.data.operationID,
    );
  });
}

function bindDurableScheduler(scheduler) {
  if (!scheduler || typeof scheduler.schedule !== "function") {
    throw new TypeError("office rental scheduler requires a schedule function");
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

async function handleDurableOfficeRental(job = {}) {
  const corporationID = normalizePositiveInteger(
    job.payload && job.payload.corporationID,
    0,
  );
  const operationID = String(job.payload && job.payload.operationID || "").trim();
  if (!corporationID || !operationID) {
    throw new Error("office rental job is invalid");
  }
  const result = await settlePendingOfficeRental(corporationID, operationID);
  if (!result || result.success !== true) {
    if (result && result.errorMsg === "INSUFFICIENT_FUNDS") {
      return { corporationID, operationID, paymentFailed: true };
    }
    throw new Error(result && result.errorMsg || "office rental failed");
  }
  return result;
}

async function reconcileDurableOfficeRentals() {
  const pending = listPendingOfficeRentalSettlements();
  if (!durableScheduler) {
    return { scheduled: 0, pending: pending.length };
  }
  await Promise.all(pending.map((settlement) =>
    schedulePendingOfficeRental(settlement)));
  return { scheduled: pending.length, pending: pending.length };
}

function hasPendingOfficeRental(corporationID, stationID) {
  const runtime = getCorporationRuntime(corporationID);
  return Object.values(runtime && runtime.officeRentalSettlements || {})
    .map((value) => normalizeSettlement(value))
    .some((settlement) =>
      settlement && settlement.stationID === Number(stationID));
}

module.exports = {
  DURABLE_SETTLEMENT_JOB_TYPE,
  bindDurableScheduler,
  buildDurableOfficeRentalJob,
  handleDurableOfficeRental,
  hasPendingOfficeRental,
  listPendingOfficeRentalSettlements,
  reconcileDurableOfficeRentals,
  rentCorporationOffice,
  settlePendingOfficeRental,
  unbindDurableScheduler,
  _testing: {
    prepareOfficeRental,
  },
};
