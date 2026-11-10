"use strict";

const {
  cloneValue,
} = require("../../common/clone");

const path = require("path");

const {
  createTableRepository,
} = require(path.join(__dirname, "../../gameStore/tableRepository"));

const TABLE_NAME = "tradeRuntime";
const META_KEY = "_meta";
const TRADE_CONTAINER_ID_BASE = 910000000000;
const repo = createTableRepository("service:trade", { strict: true });

function normalizeTradeContainerID(value) {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric > TRADE_CONTAINER_ID_BASE
    ? numeric
    : 0;
}

function ensureTable() {
  const result = repo.read(TABLE_NAME, "/");
  if (result && result.success && result.data && typeof result.data === "object") {
    return result.data;
  }
  repo.ensureTable(TABLE_NAME);
  const writeResult = repo.write(TABLE_NAME, "/", {}, { force: true });
  return writeResult && writeResult.success ? {} : null;
}

function flushTableSync() {
  return repo.flushTableSync(TABLE_NAME);
}

function allocateTradeContainerIDDurable() {
  const table = ensureTable();
  if (!table) {
    return { success: false, errorMsg: "TRADE_RUNTIME_UNAVAILABLE" };
  }
  const configuredNext = Number(table[META_KEY] && table[META_KEY].nextTradeContainerID);
  const nextTradeContainerID = normalizeTradeContainerID(configuredNext) ||
    (TRADE_CONTAINER_ID_BASE + 1);
  const writeResult = repo.write(TABLE_NAME, `/${META_KEY}`, {
    ...(table[META_KEY] && typeof table[META_KEY] === "object"
      ? cloneValue(table[META_KEY])
      : {}),
    nextTradeContainerID: nextTradeContainerID + 1,
  });
  if (!writeResult || writeResult.success !== true) {
    return {
      success: false,
      errorMsg: writeResult && writeResult.errorMsg || "TRADE_RUNTIME_WRITE_FAILED",
    };
  }
  const flushResult = flushTableSync();
  return flushResult && flushResult.success
    ? { success: true, tradeContainerID: nextTradeContainerID }
    : {
        success: false,
        ambiguous: true,
        errorMsg: flushResult && flushResult.errorMsg || "TRADE_RUNTIME_FLUSH_FAILED",
      };
}

function listTradeRecords() {
  const table = ensureTable();
  if (!table) {
    return [];
  }
  return Object.entries(table)
    .filter(([key]) => key !== META_KEY)
    .map(([, record]) => record)
    .filter((record) => record && typeof record === "object")
    .map((record) => cloneValue(record));
}

function putTradeRecordDurable(record) {
  const tradeContainerID = normalizeTradeContainerID(
    record && record.tradeContainerID,
  );
  if (!tradeContainerID) {
    return { success: false, errorMsg: "TRADE_CONTAINER_ID_REQUIRED" };
  }
  const writeResult = repo.write(
    TABLE_NAME,
    `/${tradeContainerID}`,
    {
      ...cloneValue(record),
      tradeContainerID,
    },
  );
  if (!writeResult || writeResult.success !== true) {
    return {
      success: false,
      errorMsg: writeResult && writeResult.errorMsg || "TRADE_RUNTIME_WRITE_FAILED",
    };
  }
  const flushResult = flushTableSync();
  return flushResult && flushResult.success
    ? { success: true, durable: true }
    : {
        success: false,
        durable: false,
        ambiguous: true,
        errorMsg: flushResult && flushResult.errorMsg || "TRADE_RUNTIME_FLUSH_FAILED",
      };
}

function removeTradeRecordDurable(tradeContainerID) {
  const numericTradeContainerID = normalizeTradeContainerID(tradeContainerID);
  if (!numericTradeContainerID) {
    return { success: false, errorMsg: "TRADE_CONTAINER_ID_REQUIRED" };
  }
  const removeResult = repo.remove(TABLE_NAME, `/${numericTradeContainerID}`);
  if (removeResult && removeResult.errorMsg === "ENTRY_NOT_FOUND") {
    return { success: true, durable: true, alreadyRemoved: true };
  }
  if (!removeResult || removeResult.success !== true) {
    return {
      success: false,
      errorMsg: removeResult && removeResult.errorMsg || "TRADE_RUNTIME_REMOVE_FAILED",
    };
  }
  const flushResult = flushTableSync();
  return flushResult && flushResult.success
    ? { success: true, durable: true }
    : {
        success: false,
        durable: false,
        ambiguous: true,
        errorMsg: flushResult && flushResult.errorMsg || "TRADE_RUNTIME_FLUSH_FAILED",
      };
}

module.exports = {
  TABLE_NAME,
  TRADE_CONTAINER_ID_BASE,
  allocateTradeContainerIDDurable,
  listTradeRecords,
  putTradeRecordDurable,
  removeTradeRecordDurable,
};
