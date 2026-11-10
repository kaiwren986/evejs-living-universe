"use strict";

// structureState puts its exports here when it loads. worldData, the static universe data,
// reads player structures through it for its structure lookups and static scenes, without
// requiring structureState, so the static data layer does not depend on the structure runtime.
// The server loads structureState at startup; code that may run where it is not loaded
// requires structureState itself. This module requires nothing.

let structureState = null;

function setLoadedStructureState(nextStructureState) {
  if (!nextStructureState || typeof nextStructureState !== "object") {
    throw new TypeError("structure state must be the structureState module's exports");
  }
  structureState = nextStructureState;
}

// structureState's exports; throws when it is not loaded in this process, so a missing
// structure lookup is loud instead of looking like a system with no structures.
function getLoadedStructureState() {
  if (!structureState) {
    throw new Error("structureState is not loaded in this process; require it before looking up structures");
  }
  return structureState;
}

module.exports = {
  getLoadedStructureState,
  setLoadedStructureState,
};
