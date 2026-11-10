"use strict";

// Starbase force-field presentation: the harmonic a ball shows, and the
// correction sent when a ship is pushed back out of a field. The starbase
// services hand over the ball state and broadcast the result; this module
// picks the stamp, so no service outside Destiny chooses one (RB-008).

const {
  buildSetBallHarmonicPayload,
  buildSetBallPositionPayload,
  buildSetBallVelocityPayload,
  buildSetSpeedFractionPayload,
  buildStopPayload,
} = require("../stream/actions");

// The stamp a starbase movement change carries: the scene's nextDestinyStamp.
function captureStarbaseMovementStamp(scene, nowMs) {
  return scene.nextDestinyStamp;
}

function buildStarbaseHarmonicUpdates({
  scene,
  nowMs,
  entityID,
  harmonic,
  corporationID,
  allianceID,
  isForcefield,
} = {}) {
  return [{
    stamp: captureStarbaseMovementStamp(scene, nowMs),
    payload: buildSetBallHarmonicPayload(
      entityID,
      harmonic,
      corporationID,
      allianceID,
      isForcefield,
    ),
  }];
}

function buildForceFieldBoundaryCorrectionUpdates({
  scene,
  nowMs,
  shipID,
  position,
  velocity,
  cancelledCommand,
  positionCorrected,
} = {}) {
  const stamp = captureStarbaseMovementStamp(scene, nowMs);
  return [
    ...(cancelledCommand ? [
      buildSetSpeedFractionPayload(shipID, 0),
      buildStopPayload(shipID),
    ] : []),
    ...(positionCorrected ? [
      buildSetBallPositionPayload(shipID, position),
    ] : []),
    buildSetBallVelocityPayload(shipID, velocity),
  ].map((payload) => ({ stamp, payload }));
}

module.exports = {
  buildForceFieldBoundaryCorrectionUpdates,
  buildStarbaseHarmonicUpdates,
};
