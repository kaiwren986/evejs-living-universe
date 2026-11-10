"use strict";

const { clamp, toFiniteNumber, toPositiveInt } = require("../common/numbers");
const { addVectors, cloneVector, scaleVector } = require("../common/vector");

const DEFAULT_CYNO_SPAWN_RADIUS_METERS = 5000;

function buildCynoArrivalSpawnState(fieldEntity, _shipItem, _shipEntity = null, options = {}) {
  const anchorPosition = cloneVector(fieldEntity && fieldEntity.position);
  const configuredRadius = toFiniteNumber(fieldEntity && fieldEntity.cynosuralFieldSpawnRadius, 0);
  const spawnRadius = configuredRadius > 0 ? configuredRadius : DEFAULT_CYNO_SPAWN_RADIUS_METERS;
  const random = typeof options.random === "function" ? options.random : Math.random;
  const draw = () => clamp(toFiniteNumber(random(), 0), 0, 1);

  // Equal ranges of z and azimuth cover equal solid angles. The cube root
  // spreads arrivals through the volume, rather than crowding the center.
  const z = (2 * draw()) - 1;
  const azimuth = 2 * Math.PI * draw();
  const planarLength = Math.sqrt(Math.max(0, 1 - (z ** 2)));
  const direction = {
    x: planarLength * Math.cos(azimuth),
    y: planarLength * Math.sin(azimuth),
    z,
  };
  const offset = spawnRadius * Math.cbrt(draw());

  return {
    anchorType: options.anchorType || "fleetModuleCynoBeacon",
    anchorID: toPositiveInt(fieldEntity && (fieldEntity.itemID || fieldEntity.structureID), 0),
    anchorName: String(
      (fieldEntity && (fieldEntity.itemName || fieldEntity.name)) ||
        options.fallbackName ||
        "Cynosural Field",
    ),
    direction,
    position: addVectors(anchorPosition, scaleVector(direction, offset)),
  };
}

module.exports = { buildCynoArrivalSpawnState };
