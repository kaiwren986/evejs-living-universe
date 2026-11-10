"use strict";

const {
  cloneValue,
} = require("../../common/clone");

const crypto = require("node:crypto");
const path = require("node:path");

const database = require(path.join(__dirname, "../../gameStore"));
const log = require(path.join(__dirname, "../../utils/logger"));
const {
  adjustCharacterBalanceAsync,
  getCharacterWallet,
} = require(path.join(__dirname, "../account/walletState"));
const {
  EVERMARK_ISSUER_CORP_ID,
  adjustCharacterWalletLPBalance,
  getCharacterWalletLPBalance,
} = require(path.join(__dirname, "../corporation/lpWalletState"));
const {
  getOwnedShipLogoEntitlementByTypeID,
  grantShipLogoEntitlementByTypeID,
} = require("./evermarksEntitlements");
const {
  publishShipLogoGrantedNotice,
} = require("./evermarksNotices");

const TABLE_NAME = "evermarkPurchases";
const ROOT_VERSION = 1;
const DURABLE_SETTLEMENT_JOB_TYPE = "evermarks.purchase-settle";
const DURABLE_SETTLEMENT_JOB_PREFIX = "evermarks-purchase:";
const settlementLanes = new Map();
let durableScheduler = null;

function normalizePositiveInteger(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : fallback;
}

function normalizeNonNegativeInteger(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric)
    ? Math.max(0, Math.trunc(numeric))
    : Math.max(0, Math.trunc(Number(fallback) || 0));
}

function normalizeOffer(offer = {}) {
  return {
    offerID: normalizePositiveInteger(offer.offerID, 0),
    corpID: normalizePositiveInteger(
      offer.corpID,
      EVERMARK_ISSUER_CORP_ID,
    ),
    typeID: normalizePositiveInteger(offer.typeID, 0),
    qty: normalizePositiveInteger(offer.qty, 1),
    lpCost: normalizeNonNegativeInteger(offer.lpCost, 0),
    iskCost: normalizeNonNegativeInteger(offer.iskCost, 0),
  };
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
  const result = database.write(TABLE_NAME, "/", {
    version: ROOT_VERSION,
    byCharacter: cloneValue(root.byCharacter || {}),
  });
  if (!result || result.success !== true) {
    return result || { success: false, errorMsg: "WRITE_ERROR" };
  }
  const flushResult = database.flushTableSync(TABLE_NAME);
  return flushResult && flushResult.success
    ? result
    : flushResult || { success: false, errorMsg: "FLUSH_ERROR" };
}

function getPendingEvermarkPurchase(characterID) {
  return cloneValue(
    readRoot().byCharacter[String(normalizePositiveInteger(characterID, 0))] ||
      null,
  );
}

function listPendingEvermarkPurchases() {
  return Object.values(readRoot().byCharacter)
    .filter(Boolean)
    .map(cloneValue)
    .sort((left, right) => left.characterID - right.characterID);
}

function updateSettlement(characterID, updater) {
  const root = readRoot();
  const key = String(normalizePositiveInteger(characterID, 0));
  const current = root.byCharacter[key];
  if (!current) {
    return { success: false, errorMsg: "PURCHASE_NOT_FOUND" };
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
    : result || { success: false, errorMsg: "PURCHASE_WRITE_FAILED" };
}

function buildSettlementJob(characterID) {
  const normalizedCharacterID = normalizePositiveInteger(characterID, 0);
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
      `[EvermarkPurchase] scheduling failed char=${characterID}: ${error.message}`,
    );
  });
}

function prepareEvermarkPurchase(options = {}) {
  const characterID = normalizePositiveInteger(options.characterID, 0);
  const offer = normalizeOffer(options.offer || {});
  if (!characterID || !offer.offerID || !offer.typeID) {
    return { success: false, errorMsg: "INVALID_PURCHASE" };
  }
  if (getOwnedShipLogoEntitlementByTypeID(characterID, offer.typeID)) {
    return { success: false, errorMsg: "ALREADY_OWNED" };
  }
  if (
    getCharacterWalletLPBalance(characterID, offer.corpID) < offer.lpCost
  ) {
    return { success: false, errorMsg: "INSUFFICIENT_EVERMARKS" };
  }
  const wallet = getCharacterWallet(characterID);
  if (!wallet) {
    return { success: false, errorMsg: "CHARACTER_NOT_FOUND" };
  }
  if (Number(wallet.balance || 0) < offer.iskCost) {
    return { success: false, errorMsg: "INSUFFICIENT_ISK" };
  }

  const requestFingerprint = JSON.stringify({ characterID, offer });
  const root = readRoot();
  const key = String(characterID);
  if (root.byCharacter[key]) {
    if (root.byCharacter[key].requestFingerprint !== requestFingerprint) {
      return { success: false, errorMsg: "PURCHASE_ALREADY_PENDING" };
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
    offer,
    requestFingerprint,
    lpDebitKey: `evermarks-purchase:${operationID}:lp-debit`,
    lpRefundKey: `evermarks-purchase:${operationID}:lp-refund`,
    iskDebitCommandID: `evermarks-purchase:${operationID}:isk-debit`,
    iskRefundCommandID: `evermarks-purchase:${operationID}:isk-refund`,
    lpApplied: false,
    iskApplied: false,
    entitlementApplied: false,
    lpRefundApplied: false,
    iskRefundApplied: false,
    entitlement: null,
    createdAt: new Date().toISOString(),
  };
  root.byCharacter[key] = settlement;
  const result = writeRoot(root);
  if (!result || result.success !== true) {
    return result || { success: false, errorMsg: "PURCHASE_WRITE_FAILED" };
  }
  queueSettlement(characterID);
  return { success: true, duplicate: false, data: cloneValue(settlement) };
}

function runSerialized(characterID, operation) {
  const laneKey = String(normalizePositiveInteger(characterID, 0));
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

async function refundPurchaseCosts(settlement) {
  let current = getPendingEvermarkPurchase(settlement.characterID);
  if (!current) {
    return { success: true, alreadySettled: true };
  }
  if (current.iskApplied && !current.iskRefundApplied) {
    const result = await adjustCharacterBalanceAsync(
      current.characterID,
      current.offer.iskCost,
      {
        idempotencyKey: current.iskRefundCommandID,
        description: "Heraldry offer purchase rollback",
        ownerID1: current.offer.corpID,
        ownerID2: current.characterID,
        referenceID: current.offer.offerID,
      },
      {
        commandID: current.iskRefundCommandID,
        source: "evermarks-purchase-refund",
      },
    );
    if (!result || result.success !== true) {
      return result || { success: false, errorMsg: "ISK_REFUND_FAILED" };
    }
    const checkpoint = updateSettlement(current.characterID, (candidate) => ({
      ...candidate,
      iskRefundApplied: true,
    }));
    if (!checkpoint.success) {
      return checkpoint;
    }
  }

  current = getPendingEvermarkPurchase(settlement.characterID);
  if (current && current.lpApplied && !current.lpRefundApplied) {
    const result = adjustCharacterWalletLPBalance(
      current.characterID,
      current.offer.corpID,
      current.offer.lpCost,
      {
        changeType: "lp_store_purchase_rollback",
        idempotencyKey: current.lpRefundKey,
      },
    );
    if (!result || result.success !== true) {
      return result || { success: false, errorMsg: "LP_REFUND_FAILED" };
    }
    const flushResult = database.flushTableSync("lpWallets");
    if (!flushResult || flushResult.success !== true) {
      return flushResult || { success: false, errorMsg: "LP_REFUND_FLUSH_FAILED" };
    }
    const checkpoint = updateSettlement(current.characterID, (candidate) => ({
      ...candidate,
      lpRefundApplied: true,
    }));
    if (!checkpoint.success) {
      return checkpoint;
    }
  }
  return { success: true };
}

async function rejectPurchase(settlement, errorMsg) {
  const refundResult = await refundPurchaseCosts(settlement);
  if (!refundResult.success) {
    return refundResult;
  }
  const removed = updateSettlement(settlement.characterID, () => null);
  return removed.success
    ? { success: true, rejected: true, errorMsg }
    : removed;
}

const DEFINITIVE_WALLET_ERRORS = new Set([
  "CHARACTER_NOT_FOUND",
  "INSUFFICIENT_FUNDS",
]);

async function settleEvermarkPurchaseInternal(characterID) {
  let settlement = getPendingEvermarkPurchase(characterID);
  if (!settlement) {
    return { success: true, alreadySettled: true };
  }

  if (!settlement.lpApplied) {
    if (settlement.offer.lpCost > 0) {
      const result = adjustCharacterWalletLPBalance(
        settlement.characterID,
        settlement.offer.corpID,
        -settlement.offer.lpCost,
        {
          changeType: "lp_store_purchase",
          idempotencyKey: settlement.lpDebitKey,
          requireSufficientFunds: true,
        },
      );
      if (!result || result.success !== true) {
        return result && result.errorMsg === "INSUFFICIENT_FUNDS"
          ? rejectPurchase(settlement, "INSUFFICIENT_EVERMARKS")
          : result || { success: false, errorMsg: "LP_DEBIT_FAILED" };
      }
      const flushResult = database.flushTableSync("lpWallets");
      if (!flushResult || flushResult.success !== true) {
        return flushResult || { success: false, errorMsg: "LP_DEBIT_FLUSH_FAILED" };
      }
    }
    const checkpoint = updateSettlement(characterID, (current) => ({
      ...current,
      lpApplied: true,
    }));
    if (!checkpoint.success) {
      return checkpoint;
    }
  }

  settlement = getPendingEvermarkPurchase(characterID);
  if (!settlement) {
    return { success: true, alreadySettled: true };
  }
  if (!settlement.iskApplied) {
    if (settlement.offer.iskCost > 0) {
      const result = await adjustCharacterBalanceAsync(
        settlement.characterID,
        -settlement.offer.iskCost,
        {
          idempotencyKey: settlement.iskDebitCommandID,
          description: "Heraldry offer purchase",
          ownerID1: settlement.offer.corpID,
          ownerID2: settlement.characterID,
          referenceID: settlement.offer.offerID,
        },
        {
          commandID: settlement.iskDebitCommandID,
          source: "evermarks-purchase",
        },
      );
      if (!result || result.success !== true) {
        const errorMsg = result && result.errorMsg || "ISK_DEBIT_FAILED";
        return DEFINITIVE_WALLET_ERRORS.has(errorMsg)
          ? rejectPurchase(settlement, errorMsg)
          : result || { success: false, errorMsg };
      }
    }
    const checkpoint = updateSettlement(characterID, (current) => ({
      ...current,
      iskApplied: true,
    }));
    if (!checkpoint.success) {
      return checkpoint;
    }
  }

  settlement = getPendingEvermarkPurchase(characterID);
  if (!settlement) {
    return { success: true, alreadySettled: true };
  }
  if (!settlement.entitlementApplied) {
    const result = grantShipLogoEntitlementByTypeID(
      settlement.characterID,
      settlement.offer.typeID,
      {
        source: "lp_store_purchase",
        offerID: settlement.offer.offerID,
        operationID: settlement.operationID,
      },
    );
    if (!result || result.success !== true) {
      const errorMsg = result && result.errorMsg || "ENTITLEMENT_FAILED";
      return ["ALREADY_OWNED", "INVALID_DATA", "LICENSE_NOT_FOUND"].includes(errorMsg)
        ? rejectPurchase(settlement, errorMsg)
        : result || { success: false, errorMsg };
    }
    const flushResult = database.flushTableSync("evermarkEntitlements");
    if (!flushResult || flushResult.success !== true) {
      return flushResult || {
        success: false,
        errorMsg: "ENTITLEMENT_FLUSH_FAILED",
      };
    }
    const checkpoint = updateSettlement(characterID, (current) => ({
      ...current,
      entitlementApplied: true,
      entitlement: cloneValue(result.data),
    }));
    if (!checkpoint.success) {
      return checkpoint;
    }
  }

  settlement = getPendingEvermarkPurchase(characterID);
  if (!settlement) {
    return { success: true, alreadySettled: true };
  }
  const completed = updateSettlement(characterID, () => null);
  if (!completed.success) {
    return completed;
  }
  publishShipLogoGrantedNotice(settlement.entitlement);
  return {
    success: true,
    data: {
      offer: cloneValue(settlement.offer),
      entitlement: cloneValue(settlement.entitlement),
      costs: {
        lpCost: settlement.offer.lpCost,
        iskCost: settlement.offer.iskCost,
      },
      operationID: settlement.operationID,
    },
  };
}

function settleEvermarkPurchase(characterID) {
  return runSerialized(characterID, () =>
    settleEvermarkPurchaseInternal(characterID));
}

function bindDurableScheduler(scheduler) {
  if (!scheduler || typeof scheduler.schedule !== "function") {
    throw new TypeError("Evermark purchase scheduler requires schedule");
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

async function handleDurableEvermarkPurchase(job = {}) {
  const characterID = normalizePositiveInteger(
    job.payload && job.payload.characterID,
    0,
  );
  if (!characterID) {
    throw new Error("Evermark purchase job is invalid");
  }
  const result = await settleEvermarkPurchase(characterID);
  if (!result || result.success !== true) {
    throw new Error(result && result.errorMsg || "Evermark purchase failed");
  }
  return result;
}

async function reconcileDurableEvermarkPurchases() {
  const pending = listPendingEvermarkPurchases();
  if (!durableScheduler) {
    return { scheduled: 0, pending: pending.length };
  }
  await Promise.all(pending.map((settlement) =>
    scheduleSettlement(settlement.characterID)));
  return { scheduled: pending.length, pending: pending.length };
}

module.exports = {
  DURABLE_SETTLEMENT_JOB_TYPE,
  TABLE_NAME,
  bindDurableScheduler,
  buildSettlementJob,
  getPendingEvermarkPurchase,
  handleDurableEvermarkPurchase,
  listPendingEvermarkPurchases,
  prepareEvermarkPurchase,
  reconcileDurableEvermarkPurchases,
  settleEvermarkPurchase,
  unbindDurableScheduler,
};
