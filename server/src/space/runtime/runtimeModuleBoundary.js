"use strict";

module.exports = {
  lazyRequire,
};

const runtimeEntryDirname = require("path").resolve(__dirname, "..");
const path = require("path");
const persistenceRoles = require(path.join(
  runtimeEntryDirname,
  "../gameStore/persistenceRoles",
));

// Memoized resolver for the lazy (circular-dependency-safe) requires that run on
// the hot tick path. Calling `require(path.join(__dirname, id))` every tick
// rebuilds the path string and re-runs Node's module resolver (~1.8us/call even
// when cached); caching the already-resolved module reference turns that into a
// Map lookup (~4ns). Safe because every target assigns module.exports once at
// load (verified) — the reference never goes stale. Only use this for modules
// that are lazy to break a require cycle; plain top-level requires are cheaper.
const _lazyModuleCache = new Map();

function lazyRequire(relativeId) {
  let resolved = _lazyModuleCache.get(relativeId);
  if (resolved === undefined) {
    resolved = require(path.join(runtimeEntryDirname, relativeId));
    _lazyModuleCache.set(relativeId, resolved);
  }
  return resolved;
}

// The space runtime singleton is built at module load, and both the startup
// expiry sweep and the tick loop write world-owned tables. Anything that only
// READS through this module — the parity/reporting scripts, the passive edge
// workers — imports it under a role the store will not let write, so simulating
// there is not "degraded", it is guaranteed to throw. Resolve the role once
// (it is fixed for the life of the process) and stay passive when it is not
// ours to drive.
const OWNS_WORLD_SIMULATION = persistenceRoles.roleMayDriveWorldState(
  lazyRequire("../gameStore")._processRole,
);

Object.assign(module.exports, {
  OWNS_WORLD_SIMULATION,
  _lazyModuleCache,
});
