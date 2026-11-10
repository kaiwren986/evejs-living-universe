"use strict";

const { buildSetMaxSpeedPayload } = require("../stream/actions");

function captureDroneMaxVelocityPresentation(scene, droneEntity) {
  return [{
    stamp: typeof scene.nextDestinyStamp === "number" ? scene.nextDestinyStamp : 0,
    payload: buildSetMaxSpeedPayload(droneEntity.itemID, droneEntity.maxVelocity),
  }];
}

function createDroneOperationalMotionCommand({
  droneEntity,
  mass,
  inertia,
} = {}) {
  const applied = Boolean(droneEntity);
  return {
    applied,
    applyMassAndInertia() {
      if (!applied) {
        return false;
      }
      droneEntity.mass = mass;
      droneEntity.inertia = inertia;
      return true;
    },
    applyVelocityAndAgility({
      maxVelocity,
      resolveAlignTime,
      maxAccelerationTime,
      resolveAgilitySeconds,
    } = {}) {
      if (!applied) {
        return false;
      }
      droneEntity.maxVelocity = maxVelocity;
      droneEntity.alignTime = resolveAlignTime();
      droneEntity.maxAccelerationTime = maxAccelerationTime;
      droneEntity.agilitySeconds = resolveAgilitySeconds();
      return true;
    },
  };
}

module.exports = {
  captureDroneMaxVelocityPresentation,
  createDroneOperationalMotionCommand,
};
