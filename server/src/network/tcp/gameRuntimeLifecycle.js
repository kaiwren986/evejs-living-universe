"use strict";

function requireStop(target, methodName, label) {
  if (!target || typeof target[methodName] !== "function") {
    throw new TypeError(`${label} requires ${methodName}()`);
  }
  return () => target[methodName]();
}

/**
 * Owns the long-lived schedulers started by the game TCP bootstrap.
 *
 * Shutdown runs in reverse scheduler startup order. It is deliberately
 * separate from native socket shutdown so GameStore can quiesce ingress and
 * disconnect sessions first, stop background writers second, and only then
 * perform its durable flush.
 */
function createGameRuntimeLifecycle(options = {}) {
  const stopSteps = [
    [
      "tidi-autoscaler",
      requireStop(options.tidiAutoscaler, "stop", "TiDi autoscaler"),
    ],
    [
      "wormhole-lifecycle",
      requireStop(
        options.wormholeRuntime,
        "stopLifecycleScheduler",
        "wormhole runtime",
      ),
    ],
    [
      "dungeon-runtime-ticker",
      requireStop(options.dungeonRuntime, "stopTicker", "dungeon runtime"),
    ],
    [
      "dungeon-universe-sync",
      requireStop(
        options.dungeonUniverseSiteService,
        "stopRuntimeSync",
        "dungeon universe site service",
      ),
    ],
  ];
  let shutdownPromise = null;

  return Object.freeze({
    shutdown() {
      if (shutdownPromise) return shutdownPromise;
      shutdownPromise = (async () => {
        const stopped = [];
        const failures = [];
        for (const [name, stop] of stopSteps) {
          try {
            await stop();
            stopped.push(name);
          } catch (error) {
            failures.push(new Error(
              `${name} stop failed: ${error && error.message || error}`,
              { cause: error },
            ));
          }
        }
        if (failures.length > 0) {
          throw new AggregateError(
            failures,
            "one or more game runtimes failed to stop",
          );
        }
        return Object.freeze({
          stopped: Object.freeze(stopped),
        });
      })();
      return shutdownPromise;
    },
  });
}

module.exports = {
  createGameRuntimeLifecycle,
};
