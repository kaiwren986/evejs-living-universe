"use strict";

const database = require("../../gameStore");

const TABLE = "homefrontReplay";
const operations = new Map();
const dirtyOperations = new Set();
let initialized = false;

function readRow(path) {
  const result = database.read(TABLE, path);
  if (result.success) return result.data;
  if (["ENTRY_NOT_FOUND", "TABLE_NOT_FOUND"].includes(result.errorMsg))
    return undefined;
  throw new Error(`Homefront read failed: ${result.errorMsg}`);
}

// SQLite flushes all touched rows in one transaction. Restore the cached rows
// too if persistence fails; an uncommitted receipt must never authorize payment.
function writeRows(changes) {
  const previous = changes.map(([path]) => [path, readRow(path)]);
  try {
    for (const [path, value] of changes) {
      const result =
        value === undefined
          ? database.remove(TABLE, path)
          : database.write(TABLE, path, structuredClone(value));
      if (
        !result.success &&
        !(value === undefined && result.errorMsg === "ENTRY_NOT_FOUND")
      ) {
        throw new Error(`Homefront persistence failed: ${result.errorMsg}`);
      }
    }
    const result = database.flushTableSync(TABLE);
    if (!result.success)
      throw new Error(`Homefront flush failed: ${result.errorMsg}`);
  } catch (error) {
    for (const [path, value] of previous) {
      if (value === undefined) database.remove(TABLE, path);
      else database.write(TABLE, path, value);
    }
    throw error;
  }
}

function initialize() {
  if (initialized) return;
  const legacy = readRow("/state");
  if (legacy) {
    const migratedOperations = structuredClone(legacy.operations || {});
    for (const receipt of Object.values(legacy.receipts || {})) {
      // Retain orphaned receipts until their pending payouts are reconciled.
      const operation = (migratedOperations[receipt.instanceID] ||= {
        status: "completed",
      });
      if (operation) {
        operation.receiptIDs ||= [];
        if (!operation.receiptIDs.includes(receipt.id))
          operation.receiptIDs.push(receipt.id);
      }
    }
    // This one-time conversion preserves pending command fingerprints exactly.
    writeRows([
      ["/operations", migratedOperations],
      ["/receipts", legacy.receipts || {}],
      ["/pending", legacy.pending || {}],
      ["/version", 2],
      ["/state", undefined],
    ]);
  }
  initialized = true;
}

function read(path) {
  initialize();
  return structuredClone(readRow(path));
}

function transaction(changes) {
  initialize();
  writeRows(changes);
}

function getOperation(instance) {
  if (!instance) return null;
  initialize();
  const id = String(instance.instanceID);
  if (!operations.has(id)) {
    const operation = read(`/operations/${id}`);
    if (!operation) return null;
    operations.set(id, { instance, operation });
  }
  return operations.get(id).operation;
}

function markOperationDirty(instance, operation) {
  const id = String(instance.instanceID);
  operations.set(id, { instance, operation });
  dirtyOperations.add(id);
}

function markOperationSaved(instance, operation) {
  const id = String(instance.instanceID);
  operations.set(id, { instance, operation });
  dirtyOperations.delete(id);
}

function saveOperation(instance, operation) {
  transaction([[`/operations/${instance.instanceID}`, operation]]);
  markOperationSaved(instance, operation);
}

function flushOperations(systemID = null) {
  const ids = [...dirtyOperations].filter(
    (id) =>
      systemID === null ||
      operations.get(id).instance.solarSystemID === systemID,
  );
  if (!ids.length) return;
  transaction(
    ids.map((id) => [`/operations/${id}`, operations.get(id).operation]),
  );
  for (const id of ids) dirtyOperations.delete(id);
}

function releaseSystem(systemID) {
  flushOperations(systemID);
  for (const [id, entry] of operations) {
    if (entry.instance.solarSystemID === systemID) operations.delete(id);
  }
}

function forgetOperation(instanceID) {
  operations.delete(String(instanceID));
  dirtyOperations.delete(String(instanceID));
}

function listOperationIDs() {
  initialize();
  // Keys only, used at startup/maintenance, never on combat or weather paths.
  return Object.keys(readRow("/operations") || {});
}

database.registerShutdownHook("homefront-operations", () => flushOperations());

module.exports = {
  read,
  transaction,
  getOperation,
  saveOperation,
  markOperationDirty,
  markOperationSaved,
  flushOperations,
  releaseSystem,
  forgetOperation,
  listOperationIDs,
  resetCache() {
    operations.clear();
    dirtyOperations.clear();
    initialized = false;
  },
};
