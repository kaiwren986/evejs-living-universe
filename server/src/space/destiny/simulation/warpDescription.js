"use strict";

// What a warp looks like to gameplay, read from the Ball.
//
// A warp is a Ball in mode WARP: its goto point (targetPoint), its warp
// factor, its minimum range and retail's effectStamp, negative while it
// aligns (one less each aligning Evolve) and the Destiny tick it entered warp
// on after. Evolve runs the whole of it (destiny/simulation/evolve.js). Beside
// the Ball, gameplay keeps the warp's destination context on
// `entity.warpDestination`: where the pilot asked to go, what is there (a
// target, a dungeon room) and when, in sim time, the order applied and the
// warp started. Nothing here moves a Ball or sends anything.

// The warp's destination context, or an empty one.
function readWarpDestination(entity) {
  return entity && entity.warpDestination && typeof entity.warpDestination === "object"
    ? entity.warpDestination
    : {};
}

module.exports = {
  readWarpDestination,
};
