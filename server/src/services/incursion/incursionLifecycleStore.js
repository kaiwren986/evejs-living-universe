"use strict";

const database = require("../../gameStore");
const { fail } = require("./incursionLifecycleContract");
const TABLE = "incursionLifecycle";
const SCHEMA = "evejs.incursion-lifecycle-state.v1";
let recoveryRequired = false;

function empty() { return { schema: SCHEMA, nextSerial: 1, tales: {}, requests: {} }; }
function read() {
  if (recoveryRequired) fail("INCURSION_LIFECYCLE_STORE_RECOVERY_REQUIRED");
  const result = database.read(TABLE, "/");
  if (!result.success) {
    if (["ENTRY_NOT_FOUND", "TABLE_NOT_FOUND"].includes(result.errorMsg)) return empty();
    throw new Error(`Incursion lifecycle read failed: ${result.errorMsg}`);
  }
  const state = structuredClone(result.data);
  if (!state || typeof state !== "object" || Array.isArray(state)) fail("INCURSION_LIFECYCLE_STATE_INVALID");
  if (!Object.keys(state).length) return empty();
  if (state.schema !== SCHEMA || !Number.isSafeInteger(state.nextSerial) || state.nextSerial < 1 ||
      !state.tales || !state.requests) fail("INCURSION_LIFECYCLE_STATE_INVALID");
  return state;
}

// All identity reservations, tale changes and publication intents belong to one
// world-owned SQLite table. Synchronous reducers cannot interleave across await.
// A failed durable write never returns a new identity or publishes a transition.
function mutate(reducer) {
  database.ensureTable(TABLE);
  const before = read(), next = structuredClone(before);
  const result = reducer(next);
  if (JSON.stringify(before) === JSON.stringify(next)) return structuredClone(result);
  try {
    const write = database.write(TABLE, "/", next);
    if (!write.success) throw new Error(`Incursion lifecycle write failed: ${write.errorMsg}`);
    const flushed = database.flushTableSync(TABLE);
    if (!flushed.success) throw new Error(`Incursion lifecycle flush failed: ${flushed.errorMsg}`);
  } catch (error) {
    // A lost flush acknowledgement can follow an actual durable commit. Never
    // overwrite it with an older reservation counter, or serve the uncertain
    // cached view. A fresh owner reconciles through gameStore and replays the
    // original request ID; this owner stops mutating/publishing until restart.
    recoveryRequired = true;
    throw error;
  }
  return structuredClone(result);
}

module.exports = { TABLE, SCHEMA, read, mutate };
