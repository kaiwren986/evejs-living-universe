"use strict";

const database = require("../../gameStore");
const TABLE = "incursionReplay";
const clone = value => value === undefined ? undefined : structuredClone(value);

function readRow(path) {
  const result = database.read(TABLE, path);
  if (result.success) return result.data;
  if (["ENTRY_NOT_FOUND", "TABLE_NOT_FOUND"].includes(result.errorMsg)) return undefined;
  throw new Error(`Incursion reward read failed: ${result.errorMsg}`);
}
function read(path) { return clone(readRow(path)); }

// Completion, its frozen economic commands and the pending index share this
// existing gameStore/SQLite owner. An uncommitted cached command cannot pay.
function transaction(changes) {
  database.ensureTable(TABLE);
  const previous = changes.map(([path]) => [path, clone(readRow(path))]);
  try {
    for (const [path, value] of changes) {
      const result = value === undefined ? database.remove(TABLE, path) : database.write(TABLE, path, clone(value));
      if (!result.success && !(value === undefined && result.errorMsg === "ENTRY_NOT_FOUND")) {
        throw new Error(`Incursion reward write failed: ${result.errorMsg}`);
      }
    }
    const result = database.flushTableSync(TABLE);
    if (!result?.success) throw new Error(`Incursion reward flush failed: ${result?.errorMsg}`);
  } catch (error) {
    for (const [path, value] of previous) {
      if (value === undefined) database.remove(TABLE, path);
      else database.write(TABLE, path, value);
    }
    throw error;
  }
}
function operationKey(value) {
  return String(value?.identity?.operationID || value?.operationID || value || "");
}
function getOperation(value) { return read(`/operations/${operationKey(value)}`) || null; }
function saveOperation(value, operation = value) {
  const key = operationKey(value);
  if (!/^[A-Za-z0-9:_-]{1,180}$/.test(key) || operation?.identity?.operationID !== key) throw new Error("INCURSION_OPERATION_INVALID");
  const current = getOperation(key);
  if (current?.receiptID) throw new Error("INCURSION_OPERATION_SEALED");
  if (operation.status === "completed") throw new Error("INCURSION_COMPLETION_REQUIRES_SEAL");
  if (current && (current.policyFingerprint !== operation.policyFingerprint ||
      JSON.stringify(current.identity) !== JSON.stringify(operation.identity) ||
      JSON.stringify(current.policy) !== JSON.stringify(operation.policy))) throw new Error("INCURSION_OPERATION_SCOPE_MISMATCH");
  transaction([[`/operations/${key}`, operation]]);
  return clone(operation);
}

module.exports = { TABLE, read, transaction, getOperation, saveOperation,
  listOperationIDs: () => Object.keys(readRow("/operations") || {}),
  listPendingCharacterIDs: () => Object.keys(readRow("/pending") || {}).map(Number),
};
