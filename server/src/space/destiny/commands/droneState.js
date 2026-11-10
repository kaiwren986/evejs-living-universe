"use strict";

// Drone state notices ride the Destiny stream. The drone code hands over its
// state tuples and queues the result in the Observer's character history,
// which stamps it with the scene's next Destiny stamp, so no
// service outside Destiny chooses one (RB-008).

function canPresentDroneStateOnDestiny(scene) {
  return Boolean(
    scene &&
    typeof scene.queueCharacterHistory === "function" &&
    typeof scene.nextDestinyStamp === "number",
  );
}

function buildDroneStateChangePresentation({ scene, stateTuples = [] } = {}) {
  const stamp = scene.nextDestinyStamp;
  return {
    updates: stateTuples.map((stateTuple) => ({
      stamp,
      payload: ["OnDroneStateChange", stateTuple],
    })),
  };
}

module.exports = {
  buildDroneStateChangePresentation,
  canPresentDroneStateOnDestiny,
};
