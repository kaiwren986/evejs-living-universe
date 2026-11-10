"use strict";

const { randomUUID } = require("crypto");
const path = require("path");

const database = require(path.join(__dirname, "../../gameStore"));

const TABLE = "marketEscrow";
const META_KEY = "_meta";

function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeOrderKey(orderId) {
  return String(orderId || "").trim();
}

function ensureTable() {
  const result = database.read(TABLE, "/");
  if (result.success && result.data && typeof result.data === "object") {
    return result.data;
  }

  database.write(TABLE, "/", {});
  return {};
}

function listEscrowRecords() {
  return Object.entries(ensureTable())
    .filter(([key]) => key !== META_KEY && key !== "_crewSales" && key !== "_crewPurchases")
    .map(([, entry]) => entry)
    .filter((entry) => entry && typeof entry === "object")
    .map((entry) => cloneValue(entry));
}

// This server's run's own idempotency namespace for market fills, drawn as it first allocates a saga. A GameStore
// restored from a copy brings back its saga counter and its namespace with it, and the daemon still holds the
// receipts of the fills made after that copy was taken: each fill then sends a key the daemon has answered for
// another request ("idempotency receipt does not match fill request"), and every buy and sale on the seeded market
// fails until the counter passes them. A namespace of the run's own keeps each key new. A saga carries the key it was
// given (its operationKey), and recovery and every later step go by that, so nothing of an earlier run's saga needs
// this run's namespace to agree with it.
let runIdempotencyNamespace = null;

function allocateMarketSagaIDDurable() {
  const table = ensureTable();
  const currentMeta = table && table[META_KEY] && typeof table[META_KEY] === "object"
    ? table[META_KEY]
    : {};
  const current = Number(currentMeta.nextSagaID);
  const sagaID = Number.isSafeInteger(current) && current > 0 ? current : 1;
  // The daemon persists fill receipts independently of this GameStore. A
  // counter alone can collide after restoring or replacing a GameStore while
  // retaining the daemon's market database, so the counter goes with a
  // namespace of this run's own (runIdempotencyNamespace, above), kept in the
  // meta as the one last used.
  if (!runIdempotencyNamespace) {
    runIdempotencyNamespace = randomUUID();
  }
  const idempotencyNamespace = runIdempotencyNamespace;
  const writeResult = database.write(TABLE, `/${META_KEY}`, {
    ...cloneValue(currentMeta),
    nextSagaID: sagaID + 1,
    idempotencyNamespace,
  });
  if (!writeResult.success) {
    return { success: false, errorMsg: writeResult.errorMsg || "WRITE_ERROR" };
  }
  const flushResult = flushEscrowTableSync();
  return flushResult.success
    ? { success: true, sagaID, idempotencyNamespace }
    : { success: false, errorMsg: flushResult.errorMsg || "FLUSH_ERROR" };
}

function getEscrowRecord(orderId) {
  const orderKey = normalizeOrderKey(orderId);
  if (!orderKey) {
    return null;
  }

  const result = database.read(TABLE, `/${orderKey}`);
  return result.success && result.data ? cloneValue(result.data) : null;
}

function putEscrowRecord(record) {
  const orderKey = normalizeOrderKey(record && record.orderId);
  if (!orderKey) {
    return {
      success: false,
      errorMsg: "ORDER_ID_REQUIRED",
    };
  }

  return database.write(TABLE, `/${orderKey}`, {
    ...cloneValue(record),
    orderId: orderKey,
  });
}

function flushEscrowTableSync() {
  return database.flushTableSync(TABLE);
}

function putEscrowRecordDurable(record) {
  const writeResult = putEscrowRecord(record);
  if (!writeResult.success) {
    return writeResult;
  }
  const flushResult = flushEscrowTableSync();
  return flushResult.success
    ? { success: true, errorMsg: null, flushed: true }
    : { success: false, errorMsg: flushResult.errorMsg || "FLUSH_ERROR" };
}

function removeEscrowRecord(orderId) {
  const orderKey = normalizeOrderKey(orderId);
  if (!orderKey) {
    return {
      success: false,
      errorMsg: "ORDER_ID_REQUIRED",
    };
  }

  return database.remove(TABLE, `/${orderKey}`);
}

function removeEscrowRecordDurable(orderId) {
  const removeResult = removeEscrowRecord(orderId);
  if (!removeResult.success) {
    return removeResult;
  }
  const flushResult = flushEscrowTableSync();
  return flushResult.success
    ? { success: true, errorMsg: null, flushed: true }
    : { success: false, errorMsg: flushResult.errorMsg || "FLUSH_ERROR" };
}

function getCrewSaleReceipt(ownerID) {
  if (!flushEscrowTableSync().success) throw new Error("CREW_SALE_COMPLETION_PENDING");
  const result = database.read(TABLE, `/_crewSales/${ownerID}`);
  return result.success && result.data ? cloneValue(result.data) : null;
}
function completeCrewSaleSaga(saga, rejected = false) {
  const tag = saga.crewSale, root = cloneValue(ensureTable()), receipts = root._crewSales || {};
  if (!tag || !/^[a-f0-9]{64}$/.test(tag.jobID) || !Number.isSafeInteger(tag.serial) || tag.serial < 1) return { success: false, errorMsg: "CREW_SALE_INVALID" };
  const prior = receipts[saga.sellerCharacterID];
  if (prior?.serial >= tag.serial) return prior.serial === tag.serial && prior.jobID === tag.jobID ? { success: true } : { success: false, errorMsg: "CREW_SALE_STALE" };
  if (!prior && Object.keys(receipts).length >= 128) return { success: false, errorMsg: "CREW_SALE_CAPACITY" };
  receipts[saga.sellerCharacterID] = { jobID: tag.jobID, serial: tag.serial, operationKey: saga.operationKey,
    result: { rejected, quantity: rejected ? 0 : saga.fillableQuantity, typeID: saga.typeID, stationID: tag.stationID,
      unitPrice: saga.orderPrice, gross: rejected ? 0 : saga.grossAmount, tax: rejected ? 0 : saga.salesTax,
      net: rejected ? 0 : Math.round((saga.grossAmount - saga.salesTax) * 100) / 100, orderID: saga.orderID },
    custodyKeys: saga.itemLegs.flatMap(leg => [leg.reserveKey, leg.releaseKey, leg.consumeKey]) };
  delete root[saga.anchorOrderID]; root._crewSales = receipts;
  const written = database.write(TABLE, "/", root);
  return written.success ? flushEscrowTableSync() : written;
}
function acknowledgeCrewSale(ownerID, tag) {
  const receipt = getCrewSaleReceipt(ownerID);
  if (!receipt || receipt.jobID !== tag.jobID || receipt.serial !== tag.serial) return { success: false, errorMsg: "CREW_SALE_ACK_CONFLICT" };
  const hash = key => require("node:crypto").createHash("sha256").update(key).digest("hex");
  const keys = new Set((receipt.custodyKeys || []).map(key => `item-custody:local:${hash(key)}`));
  const pruned = require("../inventory/itemStore").pruneIdempotentGrantReceipts(value => keys.has(value.receiptKey));
  if (!pruned.success || !database.flushTableSync("items").success) return { success: false, errorMsg: "CREW_SALE_ACK_PENDING" };
  delete receipt.custodyKeys;
  const written = database.write(TABLE, `/_crewSales/${ownerID}`, receipt);
  return written.success ? flushEscrowTableSync() : written;
}

module.exports = {
  TABLE,
  allocateMarketSagaIDDurable,
  listEscrowRecords,
  getEscrowRecord,
  putEscrowRecord,
  putEscrowRecordDurable,
  removeEscrowRecord,
  removeEscrowRecordDurable,
  getCrewSaleReceipt, completeCrewSaleSaga, acknowledgeCrewSale,
};

function getCrewPurchaseReceipt(ownerID) {
  if (!flushEscrowTableSync().success) throw new Error("CREW_PURCHASE_COMPLETION_PENDING");
  const result = database.read(TABLE, `/_crewPurchases/${ownerID}`);
  return result.success && result.data ? cloneValue(result.data) : null;
}
function completeCrewPurchaseSaga(saga, rejected = false) {
  const tag = saga.crewPurchase, root = cloneValue(ensureTable()), receipts = root._crewPurchases || {};
  if (!tag || !/^[a-f0-9]{64}$/.test(tag.jobID) || !Number.isSafeInteger(tag.serial) || tag.serial < 1) return { success: false, errorMsg: "CREW_PURCHASE_INVALID" };
  const prior = receipts[saga.buyerCharacterID];
  if (prior?.serial >= tag.serial) return prior.serial === tag.serial && prior.jobID === tag.jobID ? { success: true } : { success: false, errorMsg: "CREW_PURCHASE_STALE" };
  if (!prior && Object.keys(receipts).length >= 128) return { success: false, errorMsg: "CREW_PURCHASE_CAPACITY" };
  receipts[saga.buyerCharacterID] = { jobID: tag.jobID, serial: tag.serial, operationKey: saga.operationKey,
    result: { rejected, quantity: rejected ? 0 : saga.tradedQuantity, typeID: saga.typeID, stationID: saga.destinationStationID,
      unitPrice: saga.orderPrice, cost: rejected ? 0 : saga.grossCost, orderID: saga.orderID },
    custodyKey: `${saga.operationKey}:inventory:deliver` };
  delete root[saga.anchorOrderID]; root._crewPurchases = receipts;
  const written = database.write(TABLE, "/", root);
  return written.success ? flushEscrowTableSync() : written;
}
function acknowledgeCrewPurchase(ownerID, tag) {
  const receipt = getCrewPurchaseReceipt(ownerID);
  if (!receipt || receipt.jobID !== tag.jobID || receipt.serial !== tag.serial) return { success: false, errorMsg: "CREW_PURCHASE_ACK_CONFLICT" };
  const key = receipt.custodyKey ? `item-custody:local:${require("node:crypto").createHash("sha256").update(receipt.custodyKey).digest("hex")}` : null;
  const pruned = require("../inventory/itemStore").pruneIdempotentGrantReceipts(value => key && value.receiptKey === key);
  if (!pruned.success || !database.flushTableSync("items").success) return { success: false, errorMsg: "CREW_PURCHASE_ACK_PENDING" };
  delete receipt.custodyKey;
  const written = database.write(TABLE, `/_crewPurchases/${ownerID}`, receipt);
  return written.success ? flushEscrowTableSync() : written;
}
Object.assign(module.exports, { getCrewPurchaseReceipt, completeCrewPurchaseSaga, acknowledgeCrewPurchase });
