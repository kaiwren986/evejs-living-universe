"use strict";

// Vector math for chat commands that place things in space: normalise, add, subtract, scale,
// cross product and copy.

function normalizeSpaceVector(vector, fallback = { x: 1, y: 0, z: 0 }) {
  const resolved = {
    x: Number.isFinite(Number(vector && vector.x)) ? Number(vector.x) : fallback.x,
    y: Number.isFinite(Number(vector && vector.y)) ? Number(vector.y) : fallback.y,
    z: Number.isFinite(Number(vector && vector.z)) ? Number(vector.z) : fallback.z,
  };
  const length = Math.sqrt(
    (resolved.x ** 2) + (resolved.y ** 2) + (resolved.z ** 2),
  );
  if (!Number.isFinite(length) || length <= 0) {
    return { ...fallback };
  }
  return {
    x: resolved.x / length,
    y: resolved.y / length,
    z: resolved.z / length,
  };
}

function addVectors(left, right) {
  return {
    x: Number(left && left.x || 0) + Number(right && right.x || 0),
    y: Number(left && left.y || 0) + Number(right && right.y || 0),
    z: Number(left && left.z || 0) + Number(right && right.z || 0),
  };
}

function subtractVectors(left, right) {
  return {
    x: Number(left && left.x || 0) - Number(right && right.x || 0),
    y: Number(left && left.y || 0) - Number(right && right.y || 0),
    z: Number(left && left.z || 0) - Number(right && right.z || 0),
  };
}

function scaleVector(vector, scalar) {
  return {
    x: Number(vector && vector.x || 0) * scalar,
    y: Number(vector && vector.y || 0) * scalar,
    z: Number(vector && vector.z || 0) * scalar,
  };
}

function crossVectors(left, right) {
  return {
    x: (Number(left && left.y || 0) * Number(right && right.z || 0))
      - (Number(left && left.z || 0) * Number(right && right.y || 0)),
    y: (Number(left && left.z || 0) * Number(right && right.x || 0))
      - (Number(left && left.x || 0) * Number(right && right.z || 0)),
    z: (Number(left && left.x || 0) * Number(right && right.y || 0))
      - (Number(left && left.y || 0) * Number(right && right.x || 0)),
  };
}

function cloneSpaceVector(vector, fallback = { x: 0, y: 0, z: 0 }) {
  return {
    x: Number.isFinite(Number(vector && vector.x)) ? Number(vector.x) : fallback.x,
    y: Number.isFinite(Number(vector && vector.y)) ? Number(vector.y) : fallback.y,
    z: Number.isFinite(Number(vector && vector.z)) ? Number(vector.z) : fallback.z,
  };
}

module.exports = {
  normalizeSpaceVector,
  addVectors,
  subtractVectors,
  scaleVector,
  crossVectors,
  cloneSpaceVector,
};
