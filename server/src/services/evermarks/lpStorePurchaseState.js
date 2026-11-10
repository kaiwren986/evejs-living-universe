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
  adjustCharacterWalletLPBalance,
  adjustCorporationWalletLPBalance,
  getCharacterWalletLPBalance,
  getCorporationWalletLPBalance,
} = require(path.join(__dirname, "../corporation/lpWalletState"));
const {
  adjustCorporationWalletDivisionBalanceAsync,
  getCorporationWalletBalance,
  normalizeCorporationWalletKey,
} = require(path.join(__dirname, "../corporation/corpWalletState"));
const itemStore = require(path.join(__dirname, "../inventory/itemStore"));
const { isBlueprintCopyRewardType } = require("../inventory/blueprintRewardState");
const lpStoreItemCustody = require(path.join(
  __dirname,
  "../inventory/lpStoreItemCustody",
));

const TABLE_NAME = "lpStorePurchases";
const ROOT_VERSION = 1;
const DURABLE_SETTLEMENT_JOB_TYPE = "lp-store.purchase-settle";
const DURABLE_SETTLEMENT_JOB_PREFIX = "lp-store-purchase:";
const settlementLanes = new Map();
let durableScheduler = null;

const DEFINITIVE_WALLET_ERRORS = new Set([
  "CHARACTER_NOT_FOUND",
  "CORPORATION_NOT_FOUND",
  "INSUFFICIENT_FUNDS",
]);

function normalizePositiveInteger(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : fallback;
}

function normalizeNonNegativeInteger(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric)
    ? Math.max(0, Math.trunc(numeric))
    : Math.max(0, Math.trunc(Number(fallback) || 0));
}

function normalizeRequirementPairs(reqItems = [], numberOfOffers = 1) {
  const quantitiesByTypeID = new Map();
  for (const pair of Array.isArray(reqItems) ? reqItems : []) {
    const typeID = normalizePositiveInteger(Array.isArray(pair) ? pair[0] : 0, 0);
    const quantity = normalizePositiveInteger(Array.isArray(pair) ? pair[1] : 0, 0);
    if (!typeID || !quantity) {
      continue;
    }
    quantitiesByTypeID.set(
      typeID,
      (quantitiesByTypeID.get(typeID) || 0) + (quantity * numberOfOffers),
    );
  }
  return [...quantitiesByTypeID.entries()];
}

function normalizeOffer(offer = {}, corpID, numberOfOffers) {
  const offerCorpID = normalizePositiveInteger(offer.corpID, corpID);
  const perOfferQuantity = normalizePositiveInteger(offer.qty, 1);
  const blueprintCopy = isBlueprintCopyRewardType(itemStore.getItemMetadata(offer.typeID));
  return {
    offerID: normalizePositiveInteger(offer.offerID, 0),
    corpID: offerCorpID,
    typeID: normalizePositiveInteger(offer.typeID, 0),
    qty: perOfferQuantity,
    lpCost: normalizeNonNegativeInteger(offer.lpCost, 0),
    iskCost: normalizeNonNegativeInteger(offer.iskCost, 0),
    akCost: normalizeNonNegativeInteger(offer.akCost, 0),
    reqItems: normalizeRequirementPairs(offer.reqItems, 1),
    requiredStandings: offer.requiredStandings ?? null,
    numberOfOffers,
    grantedQuantity: blueprintCopy ? numberOfOffers : perOfferQuantity * numberOfOffers,
    totalLpCost:
      normalizeNonNegativeInteger(offer.lpCost, 0) * numberOfOffers,
    totalIskCost:
      normalizeNonNegativeInteger(offer.iskCost, 0) * numberOfOffers,
  };
}

function getItemStackQuantity(item) {
  if (!item || typeof item !== "object") {
    return 0;
  }
  if (Number(item.singleton || 0) === 1) {
    return 1;
  }
  return normalizeNonNegativeInteger(item.stacksize ?? item.quantity, 0);
}

function selectRequiredItemLegs(characterID, locationID, requirements = []) {
  const items = itemStore.listContainerItems(
    characterID,
    locationID,
    itemStore.ITEM_FLAGS.HANGAR,
  ).slice().sort((left, right) => Number(left.itemID) - Number(right.itemID));
  const legs = [];
  for (const [typeID, requiredQuantity] of requirements) {
    let remaining = requiredQuantity;
    for (const item of items) {
      if (remaining <= 0 || Number(item && item.typeID) !== typeID) {
        continue;
      }
      const available = getItemStackQuantity(item);
      if (available <= 0) {
        continue;
      }
      const quantity = Math.min(available, remaining);
      legs.push({
        itemID: normalizePositiveInteger(item.itemID, 0),
        typeID,
        quantity,
      });
      remaining -= quantity;
    }
    if (remaining > 0) {
      return {
        success: false,
        errorMsg: "INSUFFICIENT_REQUIRED_ITEMS",
      };
    }
  }
  return { success: true, data: legs };
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

function getPendingLpStorePurchase(characterID) {
  return cloneValue(
    readRoot().byCharacter[String(normalizePositiveInteger(characterID, 0))] ||
      null,
  );
}

function listPendingLpStorePurchases() {
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
      `[LPStorePurchase] scheduling failed char=${characterID}: ${error.message}`,
    );
  });
}

function prepareLpStorePurchase(options = {}) {
  const characterID = normalizePositiveInteger(options.characterID, 0);
  const corpID = normalizePositiveInteger(options.corpID, 0);
  const locationID = normalizePositiveInteger(options.locationID, 0);
  const numberOfOffers = normalizePositiveInteger(options.numberOfOffers, 1);
  const offer = normalizeOffer(options.offer || {}, corpID, numberOfOffers);
  if (
    !characterID ||
    !corpID ||
    !locationID ||
    !offer.offerID ||
    !offer.typeID ||
    offer.corpID !== corpID ||
    offer.akCost > 0
  ) {
    return { success: false, errorMsg: "INVALID_PURCHASE" };
  }

  // A corporation-funded purchase is authorized once, by the caller, and then carried on
  // the settlement: a durable replay after a restart has no session to re-derive the payer
  // from, and must not spend a different corporation or division than the one authorized.
  const payerCorporationID = normalizePositiveInteger(options.payerCorporationID, 0);
  const payer = payerCorporationID
    ? {
        payerCorporationID,
        accountKey: normalizeCorporationWalletKey(options.accountKey),
      }
    : {};

  const requirements = normalizeRequirementPairs(
    offer.reqItems,
    numberOfOffers,
  );
  const requestFingerprint = JSON.stringify({
    ...payer,
    characterID,
    corpID,
    locationID,
    offer,
    numberOfOffers,
  });
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

  const availableLp = payerCorporationID
    ? getCorporationWalletLPBalance(payerCorporationID, corpID)
    : getCharacterWalletLPBalance(characterID, corpID);
  if (availableLp < offer.totalLpCost) {
    return { success: false, errorMsg: "INSUFFICIENT_LP" };
  }
  // The reward and the required items are the character's either way, so the character
  // still has to exist for a corporation-funded purchase -- only the money moves.
  const wallet = getCharacterWallet(characterID);
  if (!wallet) {
    return { success: false, errorMsg: "CHARACTER_NOT_FOUND" };
  }
  const availableIsk = payerCorporationID
    ? getCorporationWalletBalance(payerCorporationID, payer.accountKey)
    : Number(wallet.balance || 0);
  if (availableIsk < offer.totalIskCost) {
    return { success: false, errorMsg: "INSUFFICIENT_ISK" };
  }
  const selected = selectRequiredItemLegs(
    characterID,
    locationID,
    requirements,
  );
  if (!selected.success) {
    return selected;
  }

  const operationID = crypto.randomUUID();
  const settlement = {
    ...payer,
    operationID,
    characterID,
    corpID,
    locationID,
    offer,
    requirements,
    requestFingerprint,
    lpDebitKey: `lp-store-purchase:${operationID}:lp-debit`,
    lpRefundKey: `lp-store-purchase:${operationID}:lp-refund`,
    iskDebitCommandID: `lp-store-purchase:${operationID}:isk-debit`,
    iskRefundCommandID: `lp-store-purchase:${operationID}:isk-refund`,
    rewardGrantKey: `lp-store-purchase:${operationID}:reward-grant`,
    requiredItemLegs: selected.data.map((leg, index) => ({
      ...leg,
      legID: index + 1,
      consumeKey: `lp-store-purchase:${operationID}:required:${index + 1}:consume`,
      refundKey: `lp-store-purchase:${operationID}:required:${index + 1}:refund`,
      applied: false,
      refundApplied: false,
    })),
    lpApplied: false,
    iskApplied: false,
    rewardApplied: false,
    lpRefundApplied: false,
    iskRefundApplied: false,
    rejectionError: null,
    inventoryChanges: [],
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

function durableCustodyFailure(result, fallbackError) {
  if (!result || result.success !== true) {
    return result || { success: false, errorMsg: fallbackError };
  }
  if (result.durable !== true) {
    return {
      success: false,
      ambiguous: true,
      errorMsg: "ITEM_CUSTODY_NOT_DURABLE",
    };
  }
  return null;
}

// Both money legs read the payer off the settlement rather than off a session, so a debit
// and its rollback can never end up on different wallets when the durable scheduler
// resumes a purchase that was interrupted between them.
function adjustPurchaseLP(settlement, delta, options) {
  return settlement.payerCorporationID
    ? adjustCorporationWalletLPBalance(
        settlement.payerCorporationID,
        settlement.corpID,
        delta,
        { ...options, reason: options.changeType },
      )
    : adjustCharacterWalletLPBalance(
        settlement.characterID,
        settlement.corpID,
        delta,
        options,
      );
}

function adjustPurchaseISK(settlement, delta, options, metadata) {
  return settlement.payerCorporationID
    ? adjustCorporationWalletDivisionBalanceAsync(
        settlement.payerCorporationID,
        settlement.accountKey,
        delta,
        options,
        metadata,
      )
    : adjustCharacterBalanceAsync(settlement.characterID, delta, options, metadata);
}

async function compensateRejectedPurchase(characterID) {
  let settlement = getPendingLpStorePurchase(characterID);
  if (!settlement) {
    return { success: true, alreadySettled: true };
  }

  for (const candidate of settlement.requiredItemLegs) {
    settlement = getPendingLpStorePurchase(characterID);
    const leg = settlement && settlement.requiredItemLegs.find(
      (entry) => entry.legID === candidate.legID,
    );
    if (!settlement || !leg || !leg.applied || leg.refundApplied) {
      continue;
    }
    const result = lpStoreItemCustody.refundRequiredItem({
      operationID: settlement.operationID,
      characterID: settlement.characterID,
      locationID: settlement.locationID,
      typeID: leg.typeID,
      quantity: leg.quantity,
      idempotencyKey: leg.refundKey,
    });
    const failure = durableCustodyFailure(result, "ITEM_REFUND_FAILED");
    if (failure) {
      return failure;
    }
    const checkpoint = updateSettlement(characterID, (current) => ({
      ...current,
      requiredItemLegs: current.requiredItemLegs.map((entry) =>
        entry.legID === leg.legID
          ? { ...entry, refundApplied: true }
          : entry),
      inventoryChanges: [
        ...(current.inventoryChanges || []),
        ...((result.data && result.data.changes) || []),
      ],
    }));
    if (!checkpoint.success) {
      return checkpoint;
    }
  }

  settlement = getPendingLpStorePurchase(characterID);
  if (settlement && settlement.iskApplied && !settlement.iskRefundApplied) {
    if (settlement.offer.totalIskCost > 0) {
      const result = await adjustPurchaseISK(
        settlement,
        settlement.offer.totalIskCost,
        {
          idempotencyKey: settlement.iskRefundCommandID,
          description: "LP store purchase rollback",
          ownerID1: settlement.corpID,
          ownerID2: settlement.characterID,
          referenceID: settlement.offer.offerID,
        },
        {
          commandID: settlement.iskRefundCommandID,
          source: "lp-store-purchase-refund",
        },
      );
      if (!result || result.success !== true) {
        return result || { success: false, errorMsg: "ISK_REFUND_FAILED" };
      }
    }
    const checkpoint = updateSettlement(characterID, (current) => ({
      ...current,
      iskRefundApplied: true,
    }));
    if (!checkpoint.success) {
      return checkpoint;
    }
  }

  settlement = getPendingLpStorePurchase(characterID);
  if (settlement && settlement.lpApplied && !settlement.lpRefundApplied) {
    if (settlement.offer.totalLpCost > 0) {
      const result = adjustPurchaseLP(
        settlement,
        settlement.offer.totalLpCost,
        {
          changeType: "lp_store_purchase_rollback",
          idempotencyKey: settlement.lpRefundKey,
        },
      );
      if (!result || result.success !== true) {
        return result || { success: false, errorMsg: "LP_REFUND_FAILED" };
      }
      const flushResult = database.flushTableSync("lpWallets");
      if (!flushResult || flushResult.success !== true) {
        return flushResult || { success: false, errorMsg: "LP_REFUND_FLUSH_FAILED" };
      }
    }
    const checkpoint = updateSettlement(characterID, (current) => ({
      ...current,
      lpRefundApplied: true,
    }));
    if (!checkpoint.success) {
      return checkpoint;
    }
  }

  settlement = getPendingLpStorePurchase(characterID);
  if (!settlement) {
    return { success: true, alreadySettled: true };
  }
  const errorMsg = settlement.rejectionError || "PURCHASE_REJECTED";
  const removed = updateSettlement(characterID, () => null);
  return removed.success
    ? { success: true, rejected: true, errorMsg }
    : removed;
}

async function rejectPurchase(characterID, errorMsg) {
  const checkpoint = updateSettlement(characterID, (current) => ({
    ...current,
    rejectionError: current.rejectionError || errorMsg,
  }));
  if (!checkpoint.success) {
    return checkpoint;
  }
  return compensateRejectedPurchase(characterID);
}

async function settleLpStorePurchaseInternal(characterID) {
  let settlement = getPendingLpStorePurchase(characterID);
  if (!settlement) {
    return { success: true, alreadySettled: true };
  }
  if (settlement.rejectionError) {
    return compensateRejectedPurchase(characterID);
  }

  if (!settlement.lpApplied) {
    if (settlement.offer.totalLpCost > 0) {
      const result = adjustPurchaseLP(
        settlement,
        -settlement.offer.totalLpCost,
        {
          changeType: "lp_store_purchase",
          idempotencyKey: settlement.lpDebitKey,
          requireSufficientFunds: true,
        },
      );
      if (!result || result.success !== true) {
        return result && result.errorMsg === "INSUFFICIENT_FUNDS"
          ? rejectPurchase(characterID, "INSUFFICIENT_LP")
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

  settlement = getPendingLpStorePurchase(characterID);
  if (!settlement) {
    return { success: true, alreadySettled: true };
  }
  if (!settlement.iskApplied) {
    if (settlement.offer.totalIskCost > 0) {
      const result = await adjustPurchaseISK(
        settlement,
        -settlement.offer.totalIskCost,
        {
          idempotencyKey: settlement.iskDebitCommandID,
          description: `LP store purchase: offer ${settlement.offer.offerID}`,
          ownerID1: settlement.corpID,
          ownerID2: settlement.characterID,
          referenceID: settlement.offer.offerID,
        },
        {
          commandID: settlement.iskDebitCommandID,
          source: "lp-store-purchase",
        },
      );
      if (!result || result.success !== true) {
        const errorMsg = result && result.errorMsg || "ISK_DEBIT_FAILED";
        return DEFINITIVE_WALLET_ERRORS.has(errorMsg)
          ? rejectPurchase(
              characterID,
              errorMsg === "INSUFFICIENT_FUNDS"
                ? "INSUFFICIENT_ISK"
                : errorMsg,
            )
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

  settlement = getPendingLpStorePurchase(characterID);
  for (const candidate of settlement.requiredItemLegs) {
    settlement = getPendingLpStorePurchase(characterID);
    if (!settlement || settlement.rejectionError) {
      return settlement
        ? compensateRejectedPurchase(characterID)
        : { success: true, alreadySettled: true };
    }
    const leg = settlement.requiredItemLegs.find(
      (entry) => entry.legID === candidate.legID,
    );
    if (!leg || leg.applied) {
      continue;
    }
    const result = lpStoreItemCustody.consumeRequiredItem({
      operationID: settlement.operationID,
      characterID: settlement.characterID,
      locationID: settlement.locationID,
      itemID: leg.itemID,
      typeID: leg.typeID,
      quantity: leg.quantity,
      idempotencyKey: leg.consumeKey,
    });
    const failure = durableCustodyFailure(result, "ITEM_CONSUME_FAILED");
    if (failure) {
      return failure.ambiguous === true
        ? failure
        : rejectPurchase(characterID, "INSUFFICIENT_REQUIRED_ITEMS");
    }
    const checkpoint = updateSettlement(characterID, (current) => ({
      ...current,
      requiredItemLegs: current.requiredItemLegs.map((entry) =>
        entry.legID === leg.legID ? { ...entry, applied: true } : entry),
      inventoryChanges: [
        ...(current.inventoryChanges || []),
        ...((result.data && result.data.changes) || []),
      ],
    }));
    if (!checkpoint.success) {
      return checkpoint;
    }
  }

  settlement = getPendingLpStorePurchase(characterID);
  if (!settlement) {
    return { success: true, alreadySettled: true };
  }
  if (!settlement.rewardApplied) {
    const result = lpStoreItemCustody.grantReward({
      operationID: settlement.operationID,
      characterID: settlement.characterID,
      locationID: settlement.locationID,
      typeID: settlement.offer.typeID,
      quantity: settlement.offer.grantedQuantity,
      numberOfOffers: settlement.offer.numberOfOffers,
      blueprintRuns: settlement.offer.qty,
      idempotencyKey: settlement.rewardGrantKey,
    });
    const failure = durableCustodyFailure(result, "ITEM_GRANT_FAILED");
    if (failure) {
      return failure.ambiguous === true
        ? failure
        : rejectPurchase(characterID, "ITEM_GRANT_FAILED");
    }
    const checkpoint = updateSettlement(characterID, (current) => ({
      ...current,
      rewardApplied: true,
      inventoryChanges: [
        ...(current.inventoryChanges || []),
        ...((result.data && result.data.changes) || []),
      ],
    }));
    if (!checkpoint.success) {
      return checkpoint;
    }
  }

  settlement = getPendingLpStorePurchase(characterID);
  if (!settlement) {
    return { success: true, alreadySettled: true };
  }
  if (!settlement.payerCorporationID && settlement.offer.totalLpCost > 0 && Number(settlement.corpID) !== 1000419) {
    const career = require("../career/careerEventLedger").record(settlement.characterID,
      { kind: "economy", action: "lp-spent", id: `lp-store:${settlement.operationID}`,
        amount: settlement.offer.totalLpCost });
    if (!career.success) return career;
  }
  const completed = updateSettlement(characterID, () => null);
  if (!completed.success) {
    return completed;
  }
  return {
    success: true,
    data: {
      offer: cloneValue(settlement.offer),
      quantity: isBlueprintCopyRewardType(itemStore.getItemMetadata(settlement.offer.typeID))
        ? settlement.offer.numberOfOffers
        : settlement.offer.grantedQuantity,
      lpCost: settlement.offer.totalLpCost,
      iskCost: settlement.offer.totalIskCost,
      requirements: cloneValue(settlement.requirements),
      inventoryChanges: cloneValue(settlement.inventoryChanges || []),
      operationID: settlement.operationID,
    },
  };
}

function settleLpStorePurchase(characterID) {
  return runSerialized(characterID, () =>
    settleLpStorePurchaseInternal(characterID));
}

function bindDurableScheduler(scheduler) {
  if (!scheduler || typeof scheduler.schedule !== "function") {
    throw new TypeError("LP store purchase scheduler requires schedule");
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

async function handleDurableLpStorePurchase(job = {}) {
  const characterID = normalizePositiveInteger(
    job.payload && job.payload.characterID,
    0,
  );
  if (!characterID) {
    throw new Error("LP store purchase job is invalid");
  }
  const result = await settleLpStorePurchase(characterID);
  if (!result || result.success !== true) {
    throw new Error(result && result.errorMsg || "LP store purchase failed");
  }
  return result;
}

async function reconcileDurableLpStorePurchases() {
  const pending = listPendingLpStorePurchases();
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
  getPendingLpStorePurchase,
  handleDurableLpStorePurchase,
  listPendingLpStorePurchases,
  prepareLpStorePurchase,
  reconcileDurableLpStorePurchases,
  settleLpStorePurchase,
  unbindDurableScheduler,
};
