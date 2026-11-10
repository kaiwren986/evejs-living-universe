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
    .filter(([key]) => key !== META_KEY)
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

module.exports = {
  TABLE,
  allocateMarketSagaIDDurable,
  listEscrowRecords,
  getEscrowRecord,
  putEscrowRecord,
  putEscrowRecordDurable,
  removeEscrowRecord,
  removeEscrowRecordDurable,
};
