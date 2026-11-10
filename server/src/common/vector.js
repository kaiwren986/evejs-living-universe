"use strict";

module.exports = {
  addVectors,
  buildPerpendicular,
  cloneVector,
  crossProduct,
  directionsNearlyMatch,
  distance,
  distanceSquared,
  dotProduct,
  magnitude,
  normalizeVector,
  scaleVector,
  subtractVectors,
};

const {
  toFiniteNumber,
} = require("./numbers");

const DEFAULT_UP = Object.freeze({ x: 0, y: 1, z: 0 });

const DEFAULT_RIGHT = Object.freeze({ x: 1, y: 0, z: 0 });

const DUPLICATE_DIRECTION_DOT = 0.99999;

function cloneVector(source = null, fallback = { x: 0, y: 0, z: 0 }) {
  return {
    x: toFiniteNumber(source && source.x, fallback.x),
    y: toFiniteNumber(source && source.y, fallback.y),
    z: toFiniteNumber(source && source.z, fallback.z),
  };
}

function addVectors(left, right) {
  return {
    x: left.x + right.x,
    y: left.y + right.y,
    z: left.z + right.z,
  };
}

function subtractVectors(left, right) {
  return {
    x: left.x - right.x,
    y: left.y - right.y,
    z: left.z - right.z,
  };
}

function scaleVector(vector, scalar) {
  return {
    x: vector.x * scalar,
    y: vector.y * scalar,
    z: vector.z * scalar,
  };
}

function dotProduct(left, right) {
  return (left.x * right.x) + (left.y * right.y) + (left.z * right.z);
}

function directionsNearlyMatch(
  left,
  right,
  minimumAlignment = 0.999999,
) {
  if (!left || !right) {
    return false;
  }
  return dotProduct(
    normalizeVector(left, { x: 1, y: 0, z: 0 }),
    normalizeVector(right, { x: 1, y: 0, z: 0 }),
  ) >= minimumAlignment;
}

function crossProduct(left, right) {
  return {
    x: (left.y * right.z) - (left.z * right.y),
    y: (left.z * right.x) - (left.x * right.z),
    z: (left.x * right.y) - (left.y * right.x),
  };
}

function magnitude(vector) {
  return Math.sqrt((vector.x ** 2) + (vector.y ** 2) + (vector.z ** 2));
}

function normalizeVector(vector, fallback = { x: 1, y: 0, z: 0 }) {
  const length = magnitude(vector);
  if (!Number.isFinite(length) || length <= 0) {
    return cloneVector(fallback);
  }

  return scaleVector(vector, 1 / length);
}

function distance(left, right) {
  return magnitude(subtractVectors(left, right));
}

function distanceSquared(left, right) {
  const dx = toFiniteNumber(left && left.x, 0) - toFiniteNumber(right && right.x, 0);
  const dy = toFiniteNumber(left && left.y, 0) - toFiniteNumber(right && right.y, 0);
  const dz = toFiniteNumber(left && left.z, 0) - toFiniteNumber(right && right.z, 0);
  return (dx ** 2) + (dy ** 2) + (dz ** 2);
}

function buildPerpendicular(vector) {
  const direction = normalizeVector(vector, DEFAULT_RIGHT);
  const firstPass = crossProduct(direction, DEFAULT_UP);
  if (magnitude(firstPass) > 0) {
    return normalizeVector(firstPass, DEFAULT_RIGHT);
  }

  return normalizeVector(crossProduct(direction, DEFAULT_RIGHT), DEFAULT_UP);
}

Object.assign(module.exports, {
  DEFAULT_RIGHT,
  DEFAULT_UP,
  DUPLICATE_DIRECTION_DOT,
});
