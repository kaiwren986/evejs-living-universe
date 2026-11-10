"use strict";

const {
  entityIDsEqual,
} = require("../../space/destiny/identity/entityID");

// Adapted from FullAbyssalEngineV2's golden-log gate range evaluator. Range
// is measured surface-to-surface at command time. A tightly bounded allowance
// is available only while the authoritative ship is already approaching this
// exact gate, which reconciles the client's continuous navigation boundary
// with the server's discrete Destiny cadence without enabling remote jumps.
const { MAX_GATE_ACTIVATION_SURFACE_DISTANCE_METERS } = require("../domain/abyssalGateActivationPolicy");
const APPROACH_COMMAND_RECONCILIATION_SECONDS = 2;
const MIN_APPROACH_COMMAND_RECONCILIATION_METERS = 500;

function toFiniteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function getEntityPosition(entity) {
  const position = entity && entity.position;
  if (!position || ![position.x, position.y, position.z].every(Number.isFinite)) {
    return null;
  }
  return position;
}

function getGateSurfaceDistance(scene, shipEntity, gateEntity) {
  const shipPosition = getEntityPosition(shipEntity);
  const gatePosition = getEntityPosition(gateEntity);
  if (!scene || !shipPosition || !gatePosition) {
    return null;
  }
  if (typeof scene.getEntitySurfaceDistance === "function") {
    const projected = Number(
      scene.getEntitySurfaceDistance(shipEntity, gateEntity),
    );
    return Number.isFinite(projected) ? Math.max(0, projected) : null;
  }
  const dx = gatePosition.x - shipPosition.x;
  const dy = gatePosition.y - shipPosition.y;
  const dz = gatePosition.z - shipPosition.z;
  return Math.max(
    0,
    Math.sqrt((dx * dx) + (dy * dy) + (dz * dz)) -
      Math.max(0, toFiniteNumber(shipEntity.radius, 0)) -
      Math.max(0, toFiniteNumber(gateEntity.radius, 0)),
  );
}

function getCommittedApproachReconciliationMeters(
  shipEntity,
  gateEntity,
  activationRangeMeters = MAX_GATE_ACTIVATION_SURFACE_DISTANCE_METERS,
) {
  const gateID = gateEntity && (gateEntity.itemID ?? gateEntity.entityID);
  const targetID = shipEntity && shipEntity.targetEntityID;
  const isCommittedApproach =
    String(shipEntity && shipEntity.mode || "").toUpperCase() === "FOLLOW" &&
    entityIDsEqual(targetID, gateID) &&
    Math.max(0, toFiniteNumber(shipEntity.followRange, Infinity)) <=
      activationRangeMeters;
  if (!isCommittedApproach) {
    return 0;
  }
  return Math.min(
    activationRangeMeters,
    Math.max(
      MIN_APPROACH_COMMAND_RECONCILIATION_METERS,
      Math.max(0, toFiniteNumber(shipEntity.maxVelocity, 0)) *
        APPROACH_COMMAND_RECONCILIATION_SECONDS,
    ),
  );
}

function evaluateGateActivationRange(
  scene,
  shipEntity,
  gateEntity,
  activationRangeMeters = MAX_GATE_ACTIVATION_SURFACE_DISTANCE_METERS,
) {
  const rangeMeters = Math.max(
    0,
    toFiniteNumber(
      activationRangeMeters,
      MAX_GATE_ACTIVATION_SURFACE_DISTANCE_METERS,
    ),
  );
  const surfaceDistance = getGateSurfaceDistance(scene, shipEntity, gateEntity);
  const reconciliationMeters = surfaceDistance === null
    ? 0
    : getCommittedApproachReconciliationMeters(
        shipEntity,
        gateEntity,
        rangeMeters,
      );
  return {
    success:
      surfaceDistance !== null &&
      surfaceDistance <= rangeMeters + reconciliationMeters,
    surfaceDistance,
    rangeMeters,
    reconciliationMeters,
  };
}

module.exports = {
  MAX_GATE_ACTIVATION_SURFACE_DISTANCE_METERS,
  evaluateGateActivationRange,
  getGateSurfaceDistance,
  _testing: {
    getCommittedApproachReconciliationMeters,
  },
};
