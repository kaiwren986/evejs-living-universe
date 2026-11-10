"use strict";

module.exports = {
  deriveAgilitySeconds,
  deriveOfficialTauSeconds,
  getActualSpeedFraction,
  getCurrentAlignmentDirection,
  getTurnMetrics,
  normalizeMode,
  resolveNativeNpcPolicyMaxVelocityBase,
};

const {
  clamp,
  toFiniteNumber,
} = require("../../common/numbers");
const {
  DEFAULT_RIGHT,
  cloneVector,
  dotProduct,
  magnitude,
  normalizeVector,
} = require("../../common/vector");

const VALID_MODES = new Set(["STOP", "GOTO", "FOLLOW", "WARP", "ORBIT", "MISSILE"]);

const MAX_SUBWARP_SPEED_FRACTION = 1.0;

const DESTINY_ACCEL_LOG_DENOMINATOR = Math.log(10000);

const DESTINY_ALIGN_LOG_DENOMINATOR = Math.log(4);

const TURN_ALIGNMENT_RADIANS = 4 * (Math.PI / 180);

function getTurnMetrics(currentDirection, targetDirection) {
  const current = normalizeVector(currentDirection, targetDirection);
  const target = normalizeVector(targetDirection, current);
  const alignment = clamp(dotProduct(current, target), -1, 1);
  const radians = Math.acos(alignment);
  const turnFraction = Math.sqrt(Math.max(0, (alignment + 1) * 0.5));
  return {
    alignment,
    radians: Number.isFinite(radians) ? radians : 0,
    turnFraction: Number.isFinite(turnFraction) ? turnFraction : 1,
  };
}

function normalizeMode(value, fallback = "STOP") {
  return VALID_MODES.has(value) ? value : fallback;
}

function deriveAgilitySeconds(alignTime, maxAccelerationTime, mass = 0, inertia = 0) {
  const officialTauSeconds = deriveOfficialTauSeconds(mass, inertia);
  if (officialTauSeconds > 0) {
    return Math.max(officialTauSeconds, 0.05);
  }

  const accelSeconds =
    toFiniteNumber(maxAccelerationTime, 0) / DESTINY_ACCEL_LOG_DENOMINATOR;
  if (accelSeconds > 0) {
    return Math.max(accelSeconds, 0.05);
  }

  const alignSeconds =
    toFiniteNumber(alignTime, 0) / DESTINY_ALIGN_LOG_DENOMINATOR;
  if (alignSeconds > 0) {
    return Math.max(alignSeconds, 0.05);
  }

  return 1;
}

function deriveOfficialTauSeconds(mass = 0, inertia = 0) {
  const numericMass = toFiniteNumber(mass, 0);
  const numericInertia = toFiniteNumber(inertia, 0);
  const tauSeconds = (numericMass * numericInertia) / 1_000_000;
  return tauSeconds > 0 ? tauSeconds : 0;
}

function getCurrentAlignmentDirection(entity, fallbackDirection = DEFAULT_RIGHT) {
  const resolvedFallback = normalizeVector(
    fallbackDirection,
    normalizeVector(entity && entity.direction, DEFAULT_RIGHT),
  );
  const currentVelocity = cloneVector(entity && entity.velocity);
  const currentSpeed = magnitude(currentVelocity);
  const maxVelocity = Math.max(toFiniteNumber(entity && entity.maxVelocity, 0), 0);
  const minimumAlignmentSpeed = Math.max(0.5, maxVelocity * 0.01);
  if (currentSpeed > minimumAlignmentSpeed) {
    return normalizeVector(currentVelocity, resolvedFallback);
  }
  return normalizeVector(entity && entity.direction, resolvedFallback);
}

function getActualSpeedFraction(entity) {
  if (!entity) {
    return 0;
  }

  const maxVelocity = Math.max(toFiniteNumber(entity.maxVelocity, 0), 0.001);
  return clamp(magnitude(entity.velocity) / maxVelocity, 0, 1);
}

function resolveNativeNpcPolicyMaxVelocityBase(entity) {
  if (!entity || entity.nativeNpc !== true) {
    return 0;
  }
  const mode = String(entity._npcSdeChaseVelocityMode || "");
  const policyMaxVelocity = mode === "chase"
    ? entity._npcSdeChaseMaxVelocityMetersPerSecond
    : mode === "cruise"
      ? entity._npcSdeCruiseSpeedMetersPerSecond
      : 0;
  return Math.max(0, toFiniteNumber(policyMaxVelocity, 0));
}

Object.assign(module.exports, {
  DESTINY_ACCEL_LOG_DENOMINATOR,
  DESTINY_ALIGN_LOG_DENOMINATOR,
  MAX_SUBWARP_SPEED_FRACTION,
  TURN_ALIGNMENT_RADIANS,
  VALID_MODES,
});
