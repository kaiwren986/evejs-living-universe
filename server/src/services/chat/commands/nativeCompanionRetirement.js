"use strict";

const {
  handleDroneDestroyedSafe,
  handleFighterDestroyedSafe,
} = require("../../../space/runtime/squadronRuntimeBridge");

// Native GM removal skips targetDamageApplication, which normally tells the
// companion owner after a successful destruction. Keep these notices on this
// command path: generic entity removal is also used by recall and movement.
function finishNativeGmCompanionRetirement(scene, entity, result) {
  if (!result || result.success !== true) return result;
  if (entity.kind === "drone") handleDroneDestroyedSafe(scene, entity);
  if (entity.kind === "fighter") handleFighterDestroyedSafe(scene, entity);
  return result;
}

module.exports = { finishNativeGmCompanionRetirement };
