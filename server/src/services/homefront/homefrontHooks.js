"use strict";

// Inbound ports for engine services. Only the composition root installs the
// implementation; this module must not import Homefront or engine services.
// Stable facades also work for callers loaded before world bootstrap.
let installed = null;

function unavailable(...args) {
  if (
    args.some(
      (value) =>
        value &&
        typeof value === "object" &&
        (value.homefrontKey ||
          value.homefrontWeatherInstanceID ||
          String(value.templateID || "").startsWith("evejs-homefront:")),
    )
  ) {
    throw new Error(
      "Homefront hooks are not installed; initialize world gameplay before processing Homefront content",
    );
  }
}

const defaults = {
  runtime: {
    config: (...args) => {
      unavailable(...args);
      return null;
    },
    restoreHackingContainer: (...args) => {
      unavailable(...args);
      return null;
    },
    prepareHackOutcome: (...args) => {
      unavailable(...args);
      return null;
    },
    isSite: (...args) => {
      unavailable(...args);
      return false;
    },
    tick: () => {
      throw new Error("Homefront hooks are not installed");
    },
    releaseScene: () => {},
    closeOperation: unavailable,
    parkSite: unavailable,
    noteContribution: unavailable,
    noteAggression: unavailable,
    destroyed: unavailable,
    destroyArtifact: () => {
      throw new Error("Homefront hooks are not installed");
    },
    objectiveEvent: (...args) => {
      unavailable(...args);
      return false;
    },
    noteMining: unavailable,
    canDamage: (...args) => {
      unavailable(...args);
      return true;
    },
    acceptsAssistance: (...args) => {
      unavailable(...args);
      return false;
    },
    isWarpBlocked: (...args) => {
      unavailable(...args);
      return false;
    },
  },
  weather: {
    shipModifiers: (...args) => {
      unavailable(...args);
      return [];
    },
    locationModifiers: (...args) => {
      unavailable(...args);
      return [];
    },
    mergeClientDbuffState: (entity, entries) => {
      unavailable(entity);
      return entries;
    },
    cleanupSite: unavailable,
  },
  admission: {
    preflight: (...args) => {
      unavailable(...args);
      return null;
    },
    claim: unavailable,
    gateFields: () => ({}),
  },
  cargo: {
    isReceiver: () => false,
    tryDeliver: () => null,
    cleanup: unavailable,
  },
  client: {
    values: (...args) => {
      unavailable(...args);
      return null;
    },
  },
  rewards: {
    flushOperations: () => {},
    reconcileProgress: () => Promise.resolve(),
    recoverPending: () => Promise.resolve(),
  },
};

function install(implementation) {
  const next = {};
  for (const [group, methods] of Object.entries(defaults)) {
    next[group] = {};
    for (const name of Object.keys(methods)) {
      const callback = implementation?.[group]?.[name];
      if (typeof callback !== "function")
        throw new TypeError(`Missing Homefront hook ${group}.${name}`);
      if (installed && installed[group][name] !== callback)
        throw new Error("Homefront hooks are already installed");
      next[group][name] = callback;
    }
    Object.freeze(next[group]);
  }
  // Publish only after the complete contract has been checked.
  installed = Object.freeze(next);
}

module.exports = Object.freeze({
  install,
  ...Object.fromEntries(
    Object.entries(defaults).map(([group, methods]) => [
      group,
      Object.freeze(
        Object.fromEntries(
          Object.entries(methods).map(([name, fallback]) => [
            name,
            (...args) =>
              (installed ? installed[group][name] : fallback)(...args),
          ]),
        ),
      ),
    ]),
  ),
});
