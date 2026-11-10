"use strict";

// A copy of a Ball for building what an Observer is sent, so the send never
// writes the Ball. Nothing projects a Ball in time any more: an Observer gets
// it as the last Evolve left it, and its own Evolve takes it
// on from there.

function toFiniteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function cloneVector(source = null, fallback = { x: 0, y: 0, z: 0 }) {
  return {
    x: toFiniteNumber(source && source.x, fallback.x),
    y: toFiniteNumber(source && source.y, fallback.y),
    z: toFiniteNumber(source && source.z, fallback.z),
  };
}

function cloneDynamicEntityForDestinyPresentation(entity) {
  if (!entity || typeof entity !== "object") {
    return entity;
  }

  const clone = {
    ...entity,
    position: cloneVector(entity.position),
    velocity: cloneVector(entity.velocity),
    direction: cloneVector(entity.direction, { x: 1, y: 0, z: 0 }),
    targetPoint: cloneVector(entity.targetPoint, entity.position),
  };
  if (entity.warpDestination && typeof entity.warpDestination === "object") {
    clone.warpDestination = { ...entity.warpDestination };
  }
  return clone;
}

module.exports = {};

Object.defineProperty(
  module.exports,
  "cloneDynamicEntityForDestinyPresentation",
  {
    value: cloneDynamicEntityForDestinyPresentation,
    enumerable: false,
  },
);
