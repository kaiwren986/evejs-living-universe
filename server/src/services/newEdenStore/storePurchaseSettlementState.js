"use strict";

const {
  cloneValue,
} = require("../../common/clone");

const path = require("node:path");

const database = require(path.join(__dirname, "../../gameStore"));
const log = require(path.join(__dirname, "../../utils/logger"));
const sessionRegistry = require(path.join(__dirname, "../chat/sessionRegistry"));
const {
  adjustCharacterPlexBalanceAsync,
  getCharacterWallet,
} = require(path.join(__dirname, "../account/walletState"));
const {
  PLEX_LOG_CATEGORY,
} = require(path.join(__dirname, "../account/plexVaultLogState"));
const {
  emitItemsChangedBatchForSession,
  getCharacterRecord,
  updateCharacterRecord,
} = require(path.join(__dirname, "../character/characterState"));
const itemStore = require(path.join(__dirname, "../inventory/itemStore"));
const {
  finalizePurchaseOnce,
  getCompletedPurchase,
  grantMctDaysToAccountIdempotent,
  grantOmegaDaysToAccountIdempotent,
} = require("./storeState");
const {
  getSubscriptionState,
} = require(path.join(__dirname, "../subscription/subscriptionState"));
const {
  notifyAccountSubscriptionChanged,
} = require(path.join(__dirname, "../subscription/subscriptionNotices"));
const {
  advanceSettlementSequenceWatermark,
  registerSettlementSequenceDomain,
} = require(path.join(__dirname, "../_shared/settlementSequenceWatermark"));

const TABLE_NAME = "newEdenStorePurchaseSettlements";
const ROOT_VERSION = 1;
const DURABLE_SETTLEMENT_JOB_TYPE = "new-eden-store.purchase-settle";
const DURABLE_SETTLEMENT_JOB_PREFIX = "new-eden-store-purchase:";
const MAX_CHARACTER_FULFILLMENT_RECEIPTS = 512;
const DEFINITIVE_WALLET_ERRORS = new Set([
  "CHARACTER_NOT_FOUND",
  "IDEMPOTENCY_KEY_INVALID",
  "IDEMPOTENCY_KEY_REUSED",
  "INSUFFICIENT_FUNDS",
]);
const settlementLanes = new Map();
let durableScheduler = null;

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
    nextOperationID: toPositiveInt(root.nextOperationID, 1),
    // Detached: gameStore.read returns the live cache object, and writeRoot's
    // change detection compares against that same object. Mutating it in place
    // makes every write look unchanged, so the table stays right in memory and
    // never reaches disk.
    byOperationID:
      root.byOperationID && typeof root.byOperationID === "object"
        ? cloneValue(root.byOperationID)
        : {},
  };
}

function writeRoot(root) {
  database.ensureTable(TABLE_NAME);
  const result = database.write(TABLE_NAME, "/", {
    version: ROOT_VERSION,
    nextOperationID: toPositiveInt(root.nextOperationID, 1),
    byOperationID: cloneValue(root.byOperationID || {}),
  });
  if (!result || result.success !== true) {
    return result || { success: false, errorMsg: "WRITE_ERROR" };
  }
  const flushResult = database.flushTableSync(TABLE_NAME);
  return flushResult && flushResult.success
    ? result
    : flushResult || { success: false, errorMsg: "FLUSH_ERROR" };
}

function getPendingStorePurchaseSettlement(operationID) {
  return cloneValue(
    readRoot().byOperationID[String(operationID || "").trim()] || null,
  );
}

function listPendingStorePurchaseSettlements() {
  return Object.values(readRoot().byOperationID)
    .filter(Boolean)
    .map(cloneValue)
    .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)));
}

function updateSettlement(operationID, updater) {
  const root = readRoot();
  const key = String(operationID || "").trim();
  const current = root.byOperationID[key];
  if (!current) {
    return { success: false, errorMsg: "STORE_PURCHASE_SETTLEMENT_NOT_FOUND" };
  }
  const next = typeof updater === "function"
    ? updater(cloneValue(current))
    : current;
  if (next === null) {
    delete root.byOperationID[key];
  } else {
    root.byOperationID[key] = cloneValue(next);
  }
  const result = writeRoot(root);
  return result && result.success
    ? { success: true, data: cloneValue(next) }
    : result || { success: false, errorMsg: "STORE_PURCHASE_SETTLEMENT_WRITE_FAILED" };
}

function buildSettlementJob(operationID) {
  const normalizedOperationID = String(operationID || "").trim();
  return normalizedOperationID
    ? {
        jobID: `${DURABLE_SETTLEMENT_JOB_PREFIX}${normalizedOperationID}`,
        type: DURABLE_SETTLEMENT_JOB_TYPE,
        dueAtMs: Date.now(),
        payload: { operationID: normalizedOperationID },
      }
    : null;
}

async function scheduleSettlement(operationID) {
  const job = buildSettlementJob(operationID);
  if (!job || !durableScheduler) {
    return null;
  }
  await durableScheduler.schedule(job);
  return job;
}

function queueSettlement(operationID) {
  if (!durableScheduler) {
    return;
  }
  void scheduleSettlement(operationID).catch((error) => {
    log.warn(
      `[NewEdenStoreSettlement] scheduling failed operation=${operationID}: ${error.message}`,
    );
  });
}

function fulfillmentRequiresAccount(fulfillment) {
  const source = fulfillment && typeof fulfillment === "object" ? fulfillment : {};
  const kind = String(source.kind || "");
  if (kind === "omega" || kind === "mct") {
    return true;
  }
  return kind === "bundle" && Array.isArray(source.grants)
    ? source.grants.some(fulfillmentRequiresAccount)
    : false;
}

function validateFulfillment(fulfillment) {
  const source = fulfillment && typeof fulfillment === "object" ? fulfillment : {};
  switch (String(source.kind || "")) {
    case "grant_plex":
      return toPositiveInt(source.plexAmount, 0)
        ? null
        : "INVALID_PLEX_AMOUNT";
    case "omega":
      return toPositiveInt(source.durationDays, 0)
        ? null
        : "INVALID_OMEGA_DURATION";
    case "mct":
      return toPositiveInt(source.durationDays, 0) &&
        toPositiveInt(source.slotCount, 1)
        ? null
        : "INVALID_MCT_DURATION";
    case "item":
      return toPositiveInt(source.typeID, 0) && toPositiveInt(source.quantity, 1)
        ? null
        : "INVALID_ITEM_TYPE";
    case "skill_points":
      return toPositiveInt(source.points, 0)
        ? null
        : "INVALID_SKILL_POINT_AMOUNT";
    case "bundle": {
      const grants = Array.isArray(source.grants) ? source.grants : [];
      if (grants.length === 0) {
        return "INVALID_BUNDLE";
      }
      for (const grant of grants) {
        const errorMsg = validateFulfillment(grant);
        if (errorMsg) {
          return errorMsg;
        }
      }
      return null;
    }
    default:
      return "UNSUPPORTED_FULFILLMENT";
  }
}

function prepareStorePurchaseSettlement(options = {}) {
  const channel = String(options.channel || "").trim();
  const payerCharacterID = toPositiveInt(
    options.payerCharacterID,
    toPositiveInt(options.characterID, 0),
  );
  const characterID = toPositiveInt(options.characterID, 0);
  const accountID = toPositiveInt(options.accountID, 0);
  const quantity = toPositiveInt(options.quantity, 1);
  const totalPlexCost = Math.max(0, Math.trunc(Number(options.totalPlexCost) || 0));
  const deliveryLocationID = toPositiveInt(options.deliveryLocationID, 0);
  const fulfillment = cloneValue(options.fulfillment || null);
  const response = cloneValue(options.response || {});
  const requestedPurchaseKey = String(options.purchaseKey || "").trim();
  if (
    !channel ||
    !payerCharacterID ||
    !characterID ||
    !deliveryLocationID ||
    !getCharacterRecord(payerCharacterID) ||
    !getCharacterRecord(characterID)
  ) {
    return { success: false, errorMsg: "CHARACTER_NOT_FOUND" };
  }
  if (fulfillmentRequiresAccount(fulfillment) && !accountID) {
    return { success: false, errorMsg: "ACCOUNT_NOT_FOUND" };
  }
  const fulfillmentError = validateFulfillment(fulfillment);
  if (fulfillmentError) {
    return { success: false, errorMsg: fulfillmentError };
  }

  const requestFingerprint = JSON.stringify({
    channel,
    payerCharacterID,
    characterID,
    accountID,
    quantity,
    totalPlexCost,
    deliveryLocationID,
    fulfillment,
    response,
  });
  const root = readRoot();
  const pending = Object.values(root.byOperationID).filter(Boolean);
  const existing = requestedPurchaseKey
    ? pending.find((entry) => entry.purchaseKey === requestedPurchaseKey)
    : pending.find((entry) => entry.requestFingerprint === requestFingerprint);
  if (existing) {
    if (existing.requestFingerprint !== requestFingerprint) {
      return { success: false, errorMsg: "PURCHASE_KEY_REUSED" };
    }
    queueSettlement(existing.operationID);
    return { success: true, duplicate: true, data: cloneValue(existing) };
  }
  const conflict = pending.find((entry) =>
    entry.payerCharacterID === payerCharacterID ||
    entry.characterID === characterID);
  if (conflict) {
    return { success: false, errorMsg: "PURCHASE_ALREADY_PENDING" };
  }

  const operationSequence = root.nextOperationID;
  const operationID = String(operationSequence);
  const purchaseKey = requestedPurchaseKey ||
    `store::${channel}::${payerCharacterID}::${operationID}`;
  const settlement = {
    operationID,
    operationSequence,
    purchaseKey,
    requestFingerprint,
    channel,
    payerCharacterID,
    characterID,
    accountID,
    quantity,
    totalPlexCost,
    deliveryLocationID,
    fulfillment,
    response,
    reason: String(options.reason || "New Eden Store purchase"),
    debitCommandID: `${DURABLE_SETTLEMENT_JOB_PREFIX}${operationID}:plex-debit`,
    debitApplied: totalPlexCost <= 0,
    debitResult: null,
    fulfillmentApplied: false,
    fulfillmentResult: null,
    createdAt: new Date().toISOString(),
  };
  root.nextOperationID = operationSequence + 1;
  root.byOperationID[operationID] = settlement;
  const result = writeRoot(root);
  if (!result || result.success !== true) {
    return result || { success: false, errorMsg: "STORE_PURCHASE_SETTLEMENT_WRITE_FAILED" };
  }
  queueSettlement(operationID);
  return { success: true, duplicate: false, data: cloneValue(settlement) };
}

function runSerialized(operationID, operation) {
  const laneKey = String(operationID || "").trim();
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

function findLiveSession(characterID) {
  return sessionRegistry.findSessionByCharacterID(characterID) || null;
}

function getSkillQueueNotifications() {
  return require(path.join(
    __dirname,
    "../skills/training/skillQueueNotifications",
  ));
}

function normalizeCharacterFulfillmentReceipts(record) {
  return Array.isArray(record && record.newEdenStoreFulfillmentReceipts)
    ? record.newEdenStoreFulfillmentReceipts.filter((entry) =>
        entry && String(entry.idempotencyKey || "").trim())
    : [];
}

function flushSkillPointFulfillment() {
  try {
    return database.flushTableSync("characters") || {
      success: false,
      errorMsg: "SKILL_POINT_FLUSH_FAILED",
    };
  } catch (_) {
    return { success: false, errorMsg: "SKILL_POINT_FLUSH_FAILED" };
  }
}

function grantSkillPointsOnce(characterID, points, idempotencyKey) {
  const normalizedPoints = toPositiveInt(points, 0);
  const fingerprint = JSON.stringify({
    kind: "skill_points",
    characterID,
    points: normalizedPoints,
  });
  const record = getCharacterRecord(characterID);
  if (!record) {
    return { success: false, errorMsg: "CHARACTER_NOT_FOUND" };
  }
  const existing = normalizeCharacterFulfillmentReceipts(record)
    .find((entry) => entry.idempotencyKey === idempotencyKey);
  if (existing) {
    if (existing.fingerprint !== fingerprint) {
      return { success: false, ambiguous: true, errorMsg: "IDEMPOTENCY_KEY_REUSED" };
    }
    // A matching receipt can still be a cached write from an interrupted
    // attempt. A caller may checkpoint its reward only after SP and receipt
    // have crossed the same durable character-table barrier.
    const flushed = flushSkillPointFulfillment();
    if (!flushed.success) return flushed;
    return { success: true, duplicate: true, data: cloneValue(existing.result) };
  }

  let receiptResult = null;
  const result = updateCharacterRecord(characterID, (current) => {
    const freeSkillPoints = Math.max(
      0,
      Math.trunc(Number(current && current.freeSkillPoints || 0) + normalizedPoints),
    );
    receiptResult = {
      type: "skill_points",
      points: normalizedPoints,
      freeSkillPoints,
    };
    current.freeSkillPoints = freeSkillPoints;
    current.newEdenStoreFulfillmentReceipts = [
      {
        idempotencyKey,
        fingerprint,
        result: cloneValue(receiptResult),
        completedAt: new Date().toISOString(),
      },
      ...normalizeCharacterFulfillmentReceipts(current)
        .filter((entry) => entry.idempotencyKey !== idempotencyKey),
    ].slice(0, MAX_CHARACTER_FULFILLMENT_RECEIPTS);
    return current;
  });
  if (!result || result.success !== true) {
    return result || { success: false, errorMsg: "WRITE_ERROR" };
  }
  const flushed = flushSkillPointFulfillment();
  if (!flushed.success) {
    // Do not let an uncommitted grant survive in the character cache or become
    // visible through the live session. Retry must start from the prior SP and
    // receipt state, using the character owner's cache invalidation path.
    try {
      const rollback = updateCharacterRecord(characterID, record);
      if (!rollback?.success) {
        return { success: false, ambiguous: true, errorMsg: "SKILL_POINT_ROLLBACK_FAILED" };
      }
    } catch (_) {
      return { success: false, ambiguous: true, errorMsg: "SKILL_POINT_ROLLBACK_FAILED" };
    }
    return flushed;
  }
  const liveSession = findLiveSession(characterID);
  if (liveSession) {
    liveSession.freeSkillPoints = receiptResult.freeSkillPoints;
  }
  // A New Eden Store skill-point grant is player-visible immediately. Daily
  // goals and crate bundles both refresh this UI value, and a durable retry
  // must not repeat that notify along with the grant.
  getSkillQueueNotifications().notifyFreeSkillPointsChanged(
    characterID,
    receiptResult.freeSkillPoints,
  );
  return { success: true, duplicate: false, data: receiptResult };
}

async function applyFulfillmentToCharacter(
  characterID,
  fulfillment,
  quantity,
  options = {},
) {
  const characterRecord = getCharacterRecord(characterID);
  if (!characterRecord) {
    return { success: false, errorMsg: "CHARACTER_NOT_FOUND" };
  }
  const source = fulfillment && typeof fulfillment === "object" ? fulfillment : {};
  const multiplier = toPositiveInt(quantity, 1);
  const operationID = String(options.operationID || "").trim();
  const pathSuffix = String(options.path || "root").trim() || "root";
  const idempotencyKey =
    `${DURABLE_SETTLEMENT_JOB_PREFIX}${operationID}:fulfillment:${pathSuffix}`;

  switch (String(source.kind || "")) {
    case "grant_plex": {
      const plexAmount = toPositiveInt(Number(source.plexAmount) * multiplier, 0);
      const result = await adjustCharacterPlexBalanceAsync(
        characterID,
        plexAmount,
        {
          idempotencyKey,
          categoryMessageID: PLEX_LOG_CATEGORY.PURCHASE,
          reason: options.reason || `New Eden Store fulfillment: ${plexAmount} PLEX`,
        },
        {
          commandID: idempotencyKey,
          source: "new-eden-store-plex-fulfillment",
        },
      );
      if (!result || result.success !== true) {
        return result || { success: false, errorMsg: "PLEX_FULFILLMENT_FAILED" };
      }
      return {
        success: true,
        data: { type: "plex", plexAmount, wallet: cloneValue(result.data) },
      };
    }
    case "omega": {
      const durationDays = toPositiveInt(Number(source.durationDays) * multiplier, 0);
      const subscriptionBefore = getSubscriptionState(options.accountID);
      const result = grantOmegaDaysToAccountIdempotent(
        options.accountID,
        durationDays,
        idempotencyKey,
      );
      if (!result || result.success !== true) {
        return result || { success: false, errorMsg: "OMEGA_FULFILLMENT_FAILED" };
      }
      // The account's clients keep the grade and the end time they were told:
      // each that is online is told what the days changed. A settlement that
      // is replayed changes nothing, and tells nothing.
      notifyAccountSubscriptionChanged(options.accountID, subscriptionBefore);
      return {
        success: true,
        data: {
          type: "omega",
          accountID: options.accountID,
          durationDays,
          expiryFileTime: result.data.expiryFileTime,
        },
      };
    }
    case "mct": {
      const durationDays = toPositiveInt(source.durationDays, 0);
      const slotCount = toPositiveInt(Number(source.slotCount || 1) * multiplier, 1);
      const result = grantMctDaysToAccountIdempotent(
        options.accountID,
        durationDays,
        slotCount,
        idempotencyKey,
      );
      if (!result || result.success !== true) {
        return result || { success: false, errorMsg: "MCT_FULFILLMENT_FAILED" };
      }
      if (!result.duplicate) {
        getSkillQueueNotifications().notifyMultipleCharacterTrainingUpdated(
          options.accountID,
        );
      }
      return {
        success: true,
        data: {
          type: "mct",
          accountID: options.accountID,
          durationDays,
          slotCount,
          grantedSlots: cloneValue(result.data.grantedSlots || []),
        },
      };
    }
    case "item": {
      const typeID = toPositiveInt(source.typeID, 0);
      const itemQuantity = toPositiveInt(Number(source.quantity || 1) * multiplier, 0);
      const result = itemStore.grantItemToOwnerLocationIdempotent(
        characterID,
        options.deliveryLocationID,
        itemStore.ITEM_FLAGS.HANGAR,
        { typeID },
        itemQuantity,
        {
          singleton: 0,
          receiptKey: idempotencyKey,
          receiptMetadata: {
            operationID,
            source: "new-eden-store",
          },
        },
      );
      if (!result || result.success !== true || result.durable !== true) {
        return result || { success: false, errorMsg: "ITEM_FULFILLMENT_FAILED" };
      }
      if (result.duplicate !== true) {
        const liveSession = findLiveSession(characterID);
        if (liveSession) {
          emitItemsChangedBatchForSession(
            liveSession,
            result.data && result.data.changes || [],
          );
        }
      }
      return {
        success: true,
        data: {
          type: "item",
          typeID,
          quantity: itemQuantity,
          grant: cloneValue(result.data),
        },
      };
    }
    case "skill_points": {
      const points = toPositiveInt(Number(source.points) * multiplier, 0);
      return grantSkillPointsOnce(characterID, points, idempotencyKey);
    }
    case "bundle": {
      const grants = Array.isArray(source.grants) ? source.grants : [];
      const results = [];
      for (let index = 0; index < grants.length; index += 1) {
        const grantResult = await applyFulfillmentToCharacter(
          characterID,
          grants[index],
          multiplier,
          {
            ...options,
            path: `${pathSuffix}.${index + 1}`,
          },
        );
        if (!grantResult || grantResult.success !== true) {
          return grantResult || { success: false, errorMsg: "BUNDLE_FULFILLMENT_FAILED" };
        }
        results.push(cloneValue(grantResult.data));
      }
      return { success: true, data: { type: "bundle", grants: results } };
    }
    default:
      return { success: false, errorMsg: "UNSUPPORTED_FULFILLMENT" };
  }
}

function buildCompletionPayload(settlement) {
  const response = settlement.response || {};
  const debitWallet = settlement.debitResult && settlement.debitResult.data;
  const balance = debitWallet
    ? Number(debitWallet.plexBalance || 0)
    : Number((getCharacterWallet(settlement.payerCharacterID) || {}).plexBalance || 0);
  const common = {
    channel: settlement.channel,
    characterID: settlement.characterID,
    accountID: settlement.accountID,
    payerCharacterID: settlement.payerCharacterID,
    payerAccountID: toPositiveInt(response.payerAccountID, 0),
    offerID: response.offerID === undefined ? null : response.offerID,
    storeOfferID: response.storeOfferID || null,
    quantity: settlement.quantity,
  };
  let result;
  if (settlement.channel === "legacy") {
    result = {
      success: true,
      offer_id: response.offerID,
      store_offer_id: response.storeOfferID || null,
      quantity: settlement.quantity,
      currency: response.currency || "PLX",
      spent: settlement.totalPlexCost,
      balance,
      payerCharacterID: settlement.payerCharacterID,
      characterID: settlement.characterID,
      fulfillment: cloneValue(settlement.fulfillmentResult),
    };
  } else if (settlement.channel === "fast-checkout") {
    result = { Message: String(response.message || "OK") };
  } else if (settlement.channel === "cash") {
    result = {
      receipt: cloneValue(response.receipt || null),
      fulfillment: cloneValue(settlement.fulfillmentResult),
    };
  } else {
    result = {
      balance,
      spentPlex: settlement.totalPlexCost,
      fulfillment: cloneValue(settlement.fulfillmentResult),
    };
  }
  return {
    ...common,
    ...(settlement.totalPlexCost > 0 ? { spentPlex: settlement.totalPlexCost } : {}),
    ...(response.receipt ? { receipt: cloneValue(response.receipt) } : {}),
    result,
  };
}

async function settleStorePurchaseInternal(operationID) {
  let settlement = getPendingStorePurchaseSettlement(operationID);
  if (!settlement) {
    return { success: true, alreadySettled: true, data: null };
  }
  const completed = getCompletedPurchase(settlement.purchaseKey);
  if (completed) {
    const removed = updateSettlement(operationID, () => null);
    return removed.success
      ? { success: true, alreadySettled: true, data: completed }
      : removed;
  }

  if (!settlement.debitApplied) {
    const debitResult = await adjustCharacterPlexBalanceAsync(
      settlement.payerCharacterID,
      -settlement.totalPlexCost,
      {
        idempotencyKey: settlement.debitCommandID,
        categoryMessageID: PLEX_LOG_CATEGORY.NES,
        reason: settlement.reason,
        requireSufficientFunds: true,
      },
      {
        commandID: settlement.debitCommandID,
        source: "new-eden-store-plex-debit",
      },
    );
    if (!debitResult || debitResult.success !== true) {
      const errorMsg = debitResult && debitResult.errorMsg || "PLEX_DEBIT_FAILED";
      if (DEFINITIVE_WALLET_ERRORS.has(errorMsg)) {
        const removed = updateSettlement(operationID, () => null);
        return removed.success
          ? { success: true, rejected: true, errorMsg }
          : removed;
      }
      queueSettlement(operationID);
      return debitResult || { success: false, errorMsg };
    }
    const checkpoint = updateSettlement(operationID, (current) => ({
      ...current,
      debitApplied: true,
      debitResult: cloneValue(debitResult),
    }));
    if (!checkpoint.success) {
      return checkpoint;
    }
  }

  settlement = getPendingStorePurchaseSettlement(operationID);
  if (!settlement.fulfillmentApplied) {
    const fulfillmentResult = await applyFulfillmentToCharacter(
      settlement.characterID,
      settlement.fulfillment,
      settlement.quantity,
      {
        operationID: settlement.operationID,
        accountID: settlement.accountID,
        deliveryLocationID: settlement.deliveryLocationID,
        reason: settlement.reason,
      },
    );
    if (!fulfillmentResult || fulfillmentResult.success !== true) {
      queueSettlement(operationID);
      return fulfillmentResult || { success: false, errorMsg: "FULFILLMENT_FAILED" };
    }
    const checkpoint = updateSettlement(operationID, (current) => ({
      ...current,
      fulfillmentApplied: true,
      fulfillmentResult: cloneValue(fulfillmentResult.data),
    }));
    if (!checkpoint.success) {
      return checkpoint;
    }
  }

  settlement = getPendingStorePurchaseSettlement(operationID);
  const payload = buildCompletionPayload(settlement);
  const finalized = finalizePurchaseOnce(settlement.purchaseKey, payload);
  if (!finalized || finalized.success !== true) {
    queueSettlement(operationID);
    return finalized || { success: false, errorMsg: "PURCHASE_FINALIZE_FAILED" };
  }
  const removed = updateSettlement(operationID, () => null);
  if (!removed.success) {
    return removed;
  }
  return { success: true, data: cloneValue(finalized.data) };
}

function settleStorePurchaseSettlement(operationID) {
  return runSerialized(operationID, () =>
    settleStorePurchaseInternal(operationID));
}

function bindDurableScheduler(scheduler) {
  if (!scheduler || typeof scheduler.schedule !== "function") {
    throw new TypeError("New Eden Store settlement scheduler requires schedule");
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

async function handleDurableStorePurchaseSettlement(job = {}) {
  const operationID = String(job.payload && job.payload.operationID || "").trim();
  if (!operationID) {
    throw new Error("New Eden Store settlement job is invalid");
  }
  const result = await settleStorePurchaseSettlement(operationID);
  if (!result || result.success !== true) {
    throw new Error(result && result.errorMsg || "New Eden Store settlement failed");
  }
  return result;
}

// `new-eden-store-purchase:<operationSequence>:<leg>` -- this settlement's
// operationID is the bare sequence, with no owner segment in front of it.
const SEQUENCE_DOMAIN = registerSettlementSequenceDomain(
  "new-eden-store-purchase",
  /^new-eden-store-purchase:(\d+):/,
);

function advanceOperationSequenceWatermark(receiptScan) {
  return advanceSettlementSequenceWatermark({
    logTag: "[NewEdenStorePurchaseSettlement]",
    counterName: "nextOperationID",
    domain: SEQUENCE_DOMAIN,
    receiptScan,
    readCounter: () => readRoot().nextOperationID,
    writeCounter: (required) => {
      const root = readRoot();
      if (root.nextOperationID >= required) {
        return { success: true };
      }
      root.nextOperationID = required;
      return writeRoot(root);
    },
    pendingSequences: () =>
      listPendingStorePurchaseSettlements().map(
        (settlement) => settlement.operationSequence,
      ),
  });
}

async function reconcileDurableStorePurchaseSettlements(options = {}) {
  advanceOperationSequenceWatermark(options.receiptScan);
  const pending = listPendingStorePurchaseSettlements();
  if (!durableScheduler) {
    return { scheduled: 0, pending: pending.length };
  }
  await Promise.all(pending.map((settlement) =>
    scheduleSettlement(settlement.operationID)));
  return { scheduled: pending.length, pending: pending.length };
}

module.exports = {
  DURABLE_SETTLEMENT_JOB_TYPE,
  TABLE_NAME,
  applyFulfillmentToCharacter,
  bindDurableScheduler,
  buildSettlementJob,
  getPendingStorePurchaseSettlement,
  handleDurableStorePurchaseSettlement,
  listPendingStorePurchaseSettlements,
  prepareStorePurchaseSettlement,
  reconcileDurableStorePurchaseSettlements,
  settleStorePurchaseSettlement,
  unbindDurableScheduler,
};
