"use strict";

const {
  cloneValue,
} = require("../../common/clone");

const path = require("path");

const {
  createTableRepository,
} = require(path.join(__dirname, "../../gameStore/tableRepository"));

const TABLE_NAME = "structureDeliveryRuntime";
const META_KEY = "_meta";
const repo = createTableRepository("service:structure", { strict: true });

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

function allocateOperationIDDurable() {
  const table = ensureTable();
  if (!table) {
    return { success: false, errorMsg: "STRUCTURE_DELIVERY_RUNTIME_UNAVAILABLE" };
  }
  const configuredNext = Number(table[META_KEY] && table[META_KEY].nextOperationID);
  const operationID = Number.isSafeInteger(configuredNext) && configuredNext > 0
    ? configuredNext
    : 1;
  const writeResult = repo.write(TABLE_NAME, `/${META_KEY}`, {
    ...(table[META_KEY] && typeof table[META_KEY] === "object"
      ? cloneValue(table[META_KEY])
      : {}),
    nextOperationID: operationID + 1,
  });
  if (!writeResult || writeResult.success !== true) {
    return {
      success: false,
      errorMsg: writeResult && writeResult.errorMsg || "STRUCTURE_DELIVERY_RUNTIME_WRITE_FAILED",
    };
  }
  const flushResult = flushTableSync();
  return flushResult && flushResult.success
    ? { success: true, operationID }
    : {
        success: false,
        ambiguous: true,
        errorMsg: flushResult && flushResult.errorMsg || "STRUCTURE_DELIVERY_RUNTIME_FLUSH_FAILED",
      };
}

function listOperations() {
  const table = ensureTable();
  if (!table) {
    return [];
  }
  return Object.entries(table)
    .filter(([key]) => key !== META_KEY)
    .map(([, operation]) => operation)
    .filter((operation) => operation && typeof operation === "object")
    .map((operation) => cloneValue(operation));
}

function putOperationDurable(operation) {
  const operationID = Number(operation && operation.operationID);
  if (!Number.isSafeInteger(operationID) || operationID <= 0) {
    return { success: false, errorMsg: "STRUCTURE_DELIVERY_OPERATION_ID_REQUIRED" };
  }
  const writeResult = repo.write(TABLE_NAME, `/${operationID}`, {
    ...cloneValue(operation),
    operationID,
  });
  if (!writeResult || writeResult.success !== true) {
    return {
      success: false,
      errorMsg: writeResult && writeResult.errorMsg || "STRUCTURE_DELIVERY_RUNTIME_WRITE_FAILED",
    };
  }
  const flushResult = flushTableSync();
  return flushResult && flushResult.success
    ? { success: true, durable: true }
    : {
        success: false,
        durable: false,
        ambiguous: true,
        errorMsg: flushResult && flushResult.errorMsg || "STRUCTURE_DELIVERY_RUNTIME_FLUSH_FAILED",
      };
}

function removeOperationDurable(operationID) {
  const numericOperationID = Number(operationID);
  if (!Number.isSafeInteger(numericOperationID) || numericOperationID <= 0) {
    return { success: false, errorMsg: "STRUCTURE_DELIVERY_OPERATION_ID_REQUIRED" };
  }
  const removeResult = repo.remove(TABLE_NAME, `/${numericOperationID}`);
  if (removeResult && removeResult.errorMsg === "ENTRY_NOT_FOUND") {
    return { success: true, durable: true, alreadyRemoved: true };
  }
  if (!removeResult || removeResult.success !== true) {
    return {
      success: false,
      errorMsg: removeResult && removeResult.errorMsg || "STRUCTURE_DELIVERY_RUNTIME_REMOVE_FAILED",
    };
  }
  const flushResult = flushTableSync();
  return flushResult && flushResult.success
    ? { success: true, durable: true }
    : {
        success: false,
        durable: false,
        ambiguous: true,
        errorMsg: flushResult && flushResult.errorMsg || "STRUCTURE_DELIVERY_RUNTIME_FLUSH_FAILED",
      };
}

module.exports = {
  TABLE_NAME,
  allocateOperationIDDurable,
  listOperations,
  putOperationDurable,
  removeOperationDurable,
};
