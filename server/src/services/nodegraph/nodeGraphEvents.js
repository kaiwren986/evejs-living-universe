"use strict";

// A leaf channel for committed player actions; never a client RPC.
const listeners = new Set();
function subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }
function publish(session, atomID, parameters = {}) {
  for (const listener of listeners) {
    try { Promise.resolve(listener(session, atomID, parameters)).catch(error => require("../../utils/logger").warn(`[NodeGraph] event ${atomID} failed: ${error.message}`)); }
    catch (error) { require("../../utils/logger").warn(`[NodeGraph] event ${atomID} failed: ${error.message}`); }
  }
}
module.exports = { subscribe, publish };
