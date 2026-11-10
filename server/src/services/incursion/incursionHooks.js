"use strict";

// Stable inbound ports: world composition installs the implementation before
// native combat or dungeon materialization can process an admitted site.
let installed = null;
const scoped = value => value && typeof value === "object" &&
  (value.incursionOperationID || value.runtimeFlags?.incursionRuntime === true);
function missing(args) {
  if (args.some(scoped)) throw new Error("INCURSION_RUNTIME_NOT_INSTALLED");
}
const defaults = {
  isDamageInProgress: () => false,
  tick: (...args) => { missing(args); return false; },
  canSpawnEncounter: (...args) => { missing(args); return true; },
  initializeActor: (...args) => { missing(args); return false; },
  commitDamage: (...args) => { missing(args); return { success: true, handled: false }; },
  commitRepair: (...args) => { missing(args); return { success: true, handled: false }; },
  canComplete: (...args) => { missing(args); return true; },
};
function install(runtime) {
  if (Object.keys(defaults).some(key => typeof runtime?.[key] !== "function")) throw new Error("INCURSION_HOOKS_INCOMPLETE");
  if (installed && installed !== runtime) throw new Error("INCURSION_HOOKS_ALREADY_INSTALLED");
  installed = runtime;
}
module.exports = { install, ...Object.fromEntries(Object.entries(defaults)
  .map(([key, fallback]) => [key, (...args) => installed ? installed[key](...args) : fallback(...args)])) };
