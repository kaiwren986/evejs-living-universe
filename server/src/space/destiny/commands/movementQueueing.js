"use strict";

const path = require("path");
const log = require(path.join(__dirname, "../../../utils/logger"));

// How a movement command joins the Movement queue (the queue itself
// is runtime/scene/movementQueue.js). A command checks what it can check now,
// then hands itself to the queue; at the start of the next Destiny tick the
// queue runs it again from the top, and this time it goes on to change the
// Ball and tell Observers. A runtime without a queue changes the Ball at once.

// A command checks its preconditions before it is queued, against the slots
// it will apply from (nothing moves a Ball between ticks), so the
// common refusals reach the caller as they always did. One that still
// refuses when the queue applies it (a precondition changed in between: a
// disruption field anchored, a cloak) has no caller left to tell, so the
// refusal is logged; a plain `false` (a Follow or Orbit refused) is not.
function reportQueuedCommandResult(runtime, entity, label, result) {
  if (result && typeof result === "object" && result.success === false) {
    log.warn(
      `[SpaceRuntime] Queued ${label} refused when it applied for system=${runtime && runtime.systemID} ` +
      `entity=${entity && entity.itemID}: ${result.errorMsg || "UNKNOWN_ERROR"}`,
    );
  }
  return result;
}

// Returns true when the command was queued, and the caller returns.
function queueMovementCommand(runtime, entity, label, applyCommand) {
  return Boolean(
    runtime &&
    typeof runtime.queueMovementChange === "function" &&
    runtime.queueMovementChange(
      entity,
      label,
      () => reportQueuedCommandResult(runtime, entity, label, applyCommand()),
    ),
  );
}

// Whether changes still wait in the queue for `entity`, so its movement state
// is about to change and must not be used to skip or refuse a command now.
function hasQueuedMovement(runtime, entity) {
  return Boolean(
    runtime &&
    typeof runtime.hasQueuedMovementChange === "function" &&
    runtime.hasQueuedMovementChange(entity),
  );
}

// A movement change that is not a command (a tractor beam moving its target,
// a force field pushing a ship out): `applyChange(atMs)` changes the Ball and
// tells Observers. It waits in the queue and applies at the start of the next
// Destiny tick, at that tick's time; without a queue it applies now, at
// `nowMs`.
function queueOrApplyMovementChange(runtime, entity, label, nowMs, applyChange) {
  if (queueMovementCommand(
    runtime,
    entity,
    label,
    () => applyChange(runtime.getCurrentSimTimeMs()),
  )) {
    return true;
  }
  applyChange(nowMs);
  return false;
}

module.exports = {
  hasQueuedMovement,
  queueMovementCommand,
  queueOrApplyMovementChange,
};
