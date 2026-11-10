"use strict";

// Existing runtime coercion and geometry contracts; intentionally no engine dependency.
function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function toReal(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function round6(value) {
  return Number(toReal(value, 0).toFixed(6));
}

function toBool(value, fallback = false) {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes"].includes(normalized)) {
      return true;
    }
    if (["0", "false", "no"].includes(normalized)) {
      return false;
    }
  }
  if (value && typeof value === "object" && "value" in value) {
    return toBool(value.value, fallback);
  }
  return fallback;
}

function normalizeText(value, fallback = "") {
  const normalized = String(value == null ? "" : value).trim();
  return normalized || fallback;
}

function normalizeLowerText(value, fallback = "") {
  return normalizeText(value, fallback).toLowerCase();
}

function normalizeVector(value, fallback = { x: 0, y: 0, z: 0 }) {
  const source = value && typeof value === "object" ? value : fallback;
  return {
    x: toReal(source.x, fallback.x),
    y: toReal(source.y, fallback.y),
    z: toReal(source.z, fallback.z),
  };
}

function normalizeDirection(value, fallback = { x: 1, y: 0, z: 0 }) {
  const vector = normalizeVector(value, fallback);
  const length = Math.sqrt(
    vector.x * vector.x +
    vector.y * vector.y +
    vector.z * vector.z,
  );
  if (length <= 0) {
    return { ...fallback };
  }
  return {
    x: vector.x / length,
    y: vector.y / length,
    z: vector.z / length,
  };
}

function addVectors(left, right) {
  return {
    x: toReal(left && left.x, 0) + toReal(right && right.x, 0),
    y: toReal(left && left.y, 0) + toReal(right && right.y, 0),
    z: toReal(left && left.z, 0) + toReal(right && right.z, 0),
  };
}

function scaleVector(vector, scalar) {
  const factor = toReal(scalar, 0);
  return {
    x: toReal(vector && vector.x, 0) * factor,
    y: toReal(vector && vector.y, 0) * factor,
    z: toReal(vector && vector.z, 0) * factor,
  };
}

function hasFiniteVectorCoordinates(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      Number.isFinite(Number(value.x)) &&
      Number.isFinite(Number(value.y)) &&
      Number.isFinite(Number(value.z)),
  );
}

function getObjectPosition(source) {
  if (!source || typeof source !== "object") {
    return null;
  }

  const candidates = [
    source.spaceState && source.spaceState.position,
    source.position,
    source,
  ];

  for (const candidate of candidates) {
    if (hasFiniteVectorCoordinates(candidate)) {
      return normalizeVector(candidate);
    }
  }

  return null;
}

function getObjectItemID(source) {
  return toInt(
    source && (
      source.itemID ||
      source.stationID ||
      source.structureID ||
      source.entityID ||
      source.id
    ),
    0,
  );
}

function getObjectTypeID(source) {
  return toInt(
    source && (
      source.typeID ||
      source.stationTypeID ||
      source.entityTypeID
    ),
    0,
  );
}

function getObjectRadius(source, typeRecord = null) {
  const candidates = [
    source && source.spaceRadius,
    source && source.radius,
    source && source.interactionRadius,
    typeRecord && typeRecord.radius,
  ];
  for (const candidate of candidates) {
    const numeric = Number(candidate);
    if (Number.isFinite(numeric) && numeric > 0) {
      return numeric;
    }
  }
  return 0;
}

function listUniquePositiveInts(values) {
  return [...new Set(
    (Array.isArray(values) ? values : [])
      .map((value) => toInt(value, 0))
      .filter((value) => value > 0),
  )];
}

function listPositiveInts(values) {
  return (Array.isArray(values) ? values : [])
    .map((value) => toInt(value, 0))
    .filter((value) => value > 0);
}

function listUniqueNonNegativeInts(values) {
  return [...new Set(
    (Array.isArray(values) ? values : [])
      .map((value) => toInt(value, -1))
      .filter((value) => value >= 0),
  )];
}

function getVectorDistance(left = null, right = null) {
  const leftPosition = getObjectPosition(left);
  const rightPosition = getObjectPosition(right);
  if (!leftPosition || !rightPosition) {
    return Infinity;
  }
  const dx = Number(leftPosition.x) - Number(rightPosition.x);
  const dy = Number(leftPosition.y) - Number(rightPosition.y);
  const dz = Number(leftPosition.z) - Number(rightPosition.z);
  return Math.sqrt((dx * dx) + (dy * dy) + (dz * dz));
}

function isFinitePosition(position = null) {
  return Boolean(
    position &&
    Number.isFinite(Number(position.x)) &&
    Number.isFinite(Number(position.y)) &&
    Number.isFinite(Number(position.z)),
  );
}

function formatVectorForLog(vector) {
  if (!hasFiniteVectorCoordinates(vector)) {
    return "n/a";
  }
  const normalized = normalizeVector(vector);
  return `${Math.round(normalized.x)},${Math.round(normalized.y)},${Math.round(normalized.z)}`;
}

module.exports = {
  toInt,
  toReal,
  round6,
  toBool,
  normalizeText,
  normalizeLowerText,
  normalizeVector,
  normalizeDirection,
  addVectors,
  scaleVector,
  hasFiniteVectorCoordinates,
  getObjectPosition,
  getObjectItemID,
  getObjectTypeID,
  getObjectRadius,
  listUniquePositiveInts,
  listPositiveInts,
  listUniqueNonNegativeInts,
  getVectorDistance,
  isFinitePosition,
  formatVectorForLog,
};
