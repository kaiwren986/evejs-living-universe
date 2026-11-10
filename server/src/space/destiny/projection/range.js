"use strict";

// Range checks read the Balls as the last Evolve left them: the
// live surface distance, with no projection to a command time.

function toFiniteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function magnitude(vector) {
  const x = toFiniteNumber(vector && vector.x, 0);
  const y = toFiniteNumber(vector && vector.y, 0);
  const z = toFiniteNumber(vector && vector.z, 0);
  return Math.sqrt((x * x) + (y * y) + (z * z));
}

function subtractVectors(left, right) {
  return {
    x: toFiniteNumber(left && left.x, 0) - toFiniteNumber(right && right.x, 0),
    y: toFiniteNumber(left && left.y, 0) - toFiniteNumber(right && right.y, 0),
    z: toFiniteNumber(left && left.z, 0) - toFiniteNumber(right && right.z, 0),
  };
}

function getEntityTargetingRadius(entity) {
  return Math.max(0, toFiniteNumber(entity && entity.radius, 0));
}

function getEntitySurfaceDistance(sourceEntity, targetEntity) {
  if (!sourceEntity || !targetEntity) {
    return Infinity;
  }

  return Math.max(
    0,
    magnitude(subtractVectors(
      targetEntity && targetEntity.position,
      sourceEntity && sourceEntity.position,
    )) -
      getEntityTargetingRadius(sourceEntity) -
      getEntityTargetingRadius(targetEntity),
  );
}

function isWithinSurfaceRange(surfaceDistance, rangeMeters, graceMeters = 0) {
  return (
    Math.max(0, toFiniteNumber(surfaceDistance, Infinity)) <=
    Math.max(0, toFiniteNumber(rangeMeters, 0)) +
      Math.max(0, toFiniteNumber(graceMeters, 0))
  );
}

module.exports = {
  getEntitySurfaceDistance,
  getEntityTargetingRadius,
  isWithinSurfaceRange,
};
