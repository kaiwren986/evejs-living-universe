"use strict";

// The abyssal work that must reach the client after its SetState (the room's
// environment notification, NPC activation, arrival effects, a K-space
// arrival). A bootstrap only requests the SetState; the scene's next
// doPreTick builds it and that tick's doPostTick sends it
// (destinyHistory.requestSetState), so work asked for while the request is
// pending runs right after the batch that carries it (afterDestinyBatch).
// Otherwise it runs now.

// Runs `run` once the session's SetState is out. Returns { deferred: true }
// when it waits for the batch, else { deferred: false, result }.
function runAfterSessionSetState(runtime, session, run) {
  const scene = runtime && typeof runtime.getSceneForSession === "function"
    ? runtime.getSceneForSession(session)
    : null;
  if (
    scene &&
    typeof scene.hasPendingSetState === "function" &&
    typeof scene.afterDestinyBatch === "function" &&
    scene.hasPendingSetState(session) &&
    scene.afterDestinyBatch(session, run)
  ) {
    return { deferred: true };
  }
  return { deferred: false, result: run() };
}

module.exports = { runAfterSessionSetState };
