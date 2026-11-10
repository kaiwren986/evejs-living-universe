"use strict";

// A ship's derived movement values (mass, max speed and so on) change on the
// Ball at the next Destiny tick, but its Dogma has the new ones at
// once. While they wait in the Movement queue they are kept on the entity as
// pendingShipMotion (runtime/scene/movementQueue.js).

// The value of a derived movement field as the ship's Dogma has it, for what
// the pilot is told (HUD attributes, the cloak and propulsion bundles): the
// value waiting in the Movement queue, else the Ball's own.
function getShipDogmaMotionValue(entity, field) {
  const pending = entity && entity.pendingShipMotion;
  if (pending && Object.prototype.hasOwnProperty.call(pending, field)) {
    return pending[field];
  }
  return entity ? entity[field] : undefined;
}

module.exports = {
  getShipDogmaMotionValue,
};
