"use strict";

// chatHub puts its local-channel move here when it loads. Code that must move a session
// between local channels without requiring chatHub (commandSessionEffects, which the space
// runtime reaches) reads it back, so neither side requires the other. This module
// requires nothing.

let mover = null;

function setLocalChannelMover(nextMover) {
  if (typeof nextMover !== "function") {
    throw new TypeError("local channel mover must be a function");
  }
  mover = nextMover;
}

// Moves the session's local channel membership; false when chatHub is not loaded.
function moveLocalSession(session, previousChannelID = 0) {
  if (!mover) {
    return false;
  }
  mover(session, previousChannelID);
  return true;
}

module.exports = {
  moveLocalSession,
  setLocalChannelMover,
};
