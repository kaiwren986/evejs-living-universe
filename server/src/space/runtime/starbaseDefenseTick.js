"use strict";

module.exports = {
  tickStarbaseDefenseForScene,
};

const {
  lazyRequire,
} = require("./runtimeModuleBoundary");

// A failed final cleanup pulse retries on the following ticks, but not
// forever. An unbounded retry ran the whole starbase pulse ten times a second
// in a system that no longer has a starbase.
const STARBASE_DEFENSE_CLEANUP_RETRY_LIMIT = 50;

function tickStarbaseDefenseForScene(scene, nowMs) {
  const hasStarbases = lazyRequire("../services/inventory/itemStore").hasStarbaseItems({ systemID: scene.systemID });
  if (!hasStarbases && !scene._hadStarbasesForDefense) return;
  // Retain one final cleanup pulse for automatic assignments and manual grants
  // when the last persisted POS disappears. A failed cleanup retries next tick.
  let completed = false;
  try {
    lazyRequire("../services/starbase/starbaseCombatRuntime")
      .reconcileStarbaseDestructions(scene.systemID, { scene });
    lazyRequire("../services/starbase/starbaseControlRuntime").refreshStarbaseControlGrants(scene, { nowMs });
    lazyRequire("../services/starbase/starbaseDefenseController").tickScene(scene, nowMs);
    completed = true;
  } finally {
    if (hasStarbases || completed) {
      scene._hadStarbasesForDefense = hasStarbases;
      scene._starbaseDefenseCleanupFailures = 0;
    } else {
      const failures = (scene._starbaseDefenseCleanupFailures || 0) + 1;
      scene._starbaseDefenseCleanupFailures = failures;
      scene._hadStarbasesForDefense = failures < STARBASE_DEFENSE_CLEANUP_RETRY_LIMIT;
    }
  }
}

Object.assign(module.exports, {
  STARBASE_DEFENSE_CLEANUP_RETRY_LIMIT,
});
