"use strict";

const {
  readFiniteVector,
} = require("./scenePositionAuthority");

function toFiniteNumber(value, fallback = Number.NaN) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function resolveSampleTime(scene, options = {}) {
  const explicit = toFiniteNumber(options.nowMs);
  if (Number.isFinite(explicit)) {
    return Math.max(0, explicit);
  }
  return Math.max(0, toFiniteNumber(scene && scene.simTimeMs, 0));
}

function buildUnavailable(reason, authority, sourceEntity, targetEntity, nowMs) {
  return {
    available: false,
    projected: false,
    authority,
    reason,
    sourceEntity,
    targetEntity,
    commandSimTimeMs: nowMs,
    centerDistance: Infinity,
    surfaceDistance: Infinity,
  };
}

function buildStrictEntityFallback(sourceEntity, targetEntity, nowMs) {
  const sourcePosition = readFiniteVector(sourceEntity && sourceEntity.position);
  const targetPosition = readFiniteVector(targetEntity && targetEntity.position);
  if (!sourceEntity || !targetEntity || !sourcePosition || !targetPosition) {
    return buildUnavailable(
      "invalid-position",
      "legacy-entity-fallback",
      sourceEntity,
      targetEntity,
      nowMs,
    );
  }
  const dx = targetPosition.x - sourcePosition.x;
  const dy = targetPosition.y - sourcePosition.y;
  const dz = targetPosition.z - sourcePosition.z;
  const centerDistance = Math.sqrt((dx * dx) + (dy * dy) + (dz * dz));
  const sourceRadius = Math.max(0, toFiniteNumber(sourceEntity.radius, 0));
  const targetRadius = Math.max(0, toFiniteNumber(targetEntity.radius, 0));
  return {
    available: true,
    projected: false,
    authority: "legacy-entity-fallback",
    reason: "test-or-detached-entity",
    sourceEntity,
    targetEntity,
    commandSimTimeMs: nowMs,
    centerDistance,
    surfaceDistance: Math.max(0, centerDistance - sourceRadius - targetRadius),
  };
}

function getSceneSurfaceState(scene, sourceEntity, targetEntity, options = {}) {
  const nowMs = resolveSampleTime(scene, options);
  if (
    scene &&
    typeof scene.getEntitySurfaceState === "function"
  ) {
    const state = scene.getEntitySurfaceState(sourceEntity, targetEntity);
    return {
      ...state,
      authority: "scene-position",
      reason: options.reason || "scene-range-read",
      commandSimTimeMs: nowMs,
    };
  }
  if (
    scene &&
    scene.positionAuthority &&
    typeof scene.positionAuthority.getSurfaceState === "function"
  ) {
    const state = scene.positionAuthority.getSurfaceState(
      sourceEntity,
      targetEntity,
      {
        atSimTimeMs: nowMs,
        reason: options.reason || "scene-range-read",
      },
    );
    return {
      ...state,
      projected: false,
      authority: "scene-position",
      commandSimTimeMs: nowMs,
    };
  }
  if (options.allowDetachedEntityFallback === false) {
    return buildUnavailable(
      "position-authority-unavailable",
      "none",
      sourceEntity,
      targetEntity,
      nowMs,
    );
  }
  return buildStrictEntityFallback(sourceEntity, targetEntity, nowMs);
}

function getSceneSurfaceDistance(scene, sourceEntity, targetEntity, options = {}) {
  return getSceneSurfaceState(
    scene,
    sourceEntity,
    targetEntity,
    options,
  ).surfaceDistance;
}

module.exports = {
  getSceneSurfaceDistance,
  getSceneSurfaceState,
};
