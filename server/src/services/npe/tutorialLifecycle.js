"use strict";
const listeners = new Set();
const pending = new Set();
function subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }
function stopped(characterID) {
  for (const listener of listeners) {
    try {
      const operation = Promise.resolve(listener(characterID)); pending.add(operation);
      operation.then(() => pending.delete(operation), error => { pending.delete(operation); require("../../utils/logger").warn(`[Tutorial] cleanup requires retry: ${error.message}`); });
    }
    catch (error) { require("../../utils/logger").warn(`[Tutorial] cleanup requires retry: ${error.message}`); }
  }
}
async function flushPending() { while (pending.size) await Promise.allSettled([...pending]); }
module.exports = { subscribe, stopped, flushPending };
