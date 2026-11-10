"use strict";

const {
  round6,
  toFiniteNumber,
} = require("../../common/numbers");
const { random } = require("../../common/random");

const path = require("path");

const {
  normalizeDamageVector,
  sumDamageVector,
} = require(path.join(__dirname, "./damage"));

function clamp(value, min, max) {
  return Math.min(Math.max(toFiniteNumber(value, min), min), max);
}

function subtractVectors(left, right) {
  return {
    x: toFiniteNumber(left && left.x, 0) - toFiniteNumber(right && right.x, 0),
    y: toFiniteNumber(left && left.y, 0) - toFiniteNumber(right && right.y, 0),
    z: toFiniteNumber(left && left.z, 0) - toFiniteNumber(right && right.z, 0),
  };
}

function dot(left, right) {
  return (
    (toFiniteNumber(left && left.x, 0) * toFiniteNumber(right && right.x, 0)) +
    (toFiniteNumber(left && left.y, 0) * toFiniteNumber(right && right.y, 0)) +
    (toFiniteNumber(left && left.z, 0) * toFiniteNumber(right && right.z, 0))
  );
}

function magnitude(vector) {
  return Math.sqrt(dot(vector, vector));
}

function getSurfaceDistance(sourceEntity, targetEntity) {
  const delta = subtractVectors(targetEntity && targetEntity.position, sourceEntity && sourceEntity.position);
  return Math.max(
    0,
    magnitude(delta) -
      Math.max(0, toFiniteNumber(sourceEntity && sourceEntity.radius, 0)) -
      Math.max(0, toFiniteNumber(targetEntity && targetEntity.radius, 0)),
  );
}

function getAngularVelocity(sourceEntity, targetEntity) {
  const relativePosition = subtractVectors(
    targetEntity && targetEntity.position,
    sourceEntity && sourceEntity.position,
  );
  const centerDistance = Math.max(magnitude(relativePosition), 1);
  const relativeVelocity = subtractVectors(
    targetEntity && targetEntity.velocity,
    sourceEntity && sourceEntity.velocity,
  );
  const radialUnit = {
    x: relativePosition.x / centerDistance,
    y: relativePosition.y / centerDistance,
    z: relativePosition.z / centerDistance,
  };
  const radialSpeed = dot(relativeVelocity, radialUnit);
  const tangentialVelocity = {
    x: relativeVelocity.x - (radialUnit.x * radialSpeed),
    y: relativeVelocity.y - (radialUnit.y * radialSpeed),
    z: relativeVelocity.z - (radialUnit.z * radialSpeed),
  };
  return magnitude(tangentialVelocity) / centerDistance;
}

function getTargetSignatureRadius(entity) {
  const signatureRadius = Math.max(0, toFiniteNumber(entity && entity.signatureRadius, 0));
  if (signatureRadius > 0) {
    return signatureRadius;
  }
  return Math.max(1, toFiniteNumber(entity && entity.radius, 1));
}

function scaleDamageVector(vector, scale) {
  const resolvedScale = toFiniteNumber(scale, 0);
  return {
    em: round6(toFiniteNumber(vector && vector.em, 0) * resolvedScale),
    thermal: round6(toFiniteNumber(vector && vector.thermal, 0) * resolvedScale),
    kinetic: round6(toFiniteNumber(vector && vector.kinetic, 0) * resolvedScale),
    explosive: round6(toFiniteNumber(vector && vector.explosive, 0) * resolvedScale),
  };
}

function resolveTurretShot({
  attackerEntity,
  targetEntity,
  weaponSnapshot,
  randomValue = random(),
  // Server tuning lean (config: gameplay combat.turretHitChanceAdditive).
  // Added to the formula's chance and clamped to 1. Zero is TQ-exact. The
  // runtime call sites inject the configured value; direct callers (tests,
  // sims) get 0 unless they pass one, so the pinned formula stays pinned.
  hitChanceAdditive = 0,
} = {}) {
  const resolvedRawDamage = normalizeDamageVector(
    weaponSnapshot && weaponSnapshot.rawShotDamage,
  );
  const surfaceDistance = getSurfaceDistance(attackerEntity, targetEntity);
  const angularVelocity = getAngularVelocity(attackerEntity, targetEntity);
  const targetSignatureRadius = getTargetSignatureRadius(targetEntity);
  const trackingSpeed = Math.max(0, toFiniteNumber(
    weaponSnapshot && weaponSnapshot.trackingSpeed,
    0,
  ));
  const optimalSigRadius = Math.max(1, toFiniteNumber(
    weaponSnapshot && weaponSnapshot.optimalSigRadius,
    40000,
  ));
  const optimalRange = Math.max(0, toFiniteNumber(
    weaponSnapshot && weaponSnapshot.optimalRange,
    0,
  ));
  const falloff = Math.max(0, toFiniteNumber(
    weaponSnapshot && weaponSnapshot.falloff,
    0,
  ));
  const trackingTerm =
    trackingSpeed > 0
      ? (angularVelocity * optimalSigRadius) / (trackingSpeed * Math.max(targetSignatureRadius, 1))
      : Number.POSITIVE_INFINITY;
  let rangeTerm = 0;
  if (surfaceDistance > optimalRange) {
    if (falloff > 0) {
      rangeTerm = (surfaceDistance - optimalRange) / falloff;
    } else {
      rangeTerm = Number.POSITIVE_INFINITY;
    }
  }

  const formulaIsFinite = Number.isFinite(trackingTerm) && Number.isFinite(rangeTerm);
  const baseHitChance = formulaIsFinite
    ? clamp(0.5 ** ((trackingTerm ** 2) + (rangeTerm ** 2)), 0, 1)
    : 0;
  // The additive lean raises every shot the formula allows at all. It must NOT
  // resurrect a structurally impossible shot: past optimal with no falloff
  // (the disintegrator hard cut-off) and a zero-tracking weapon stay at zero.
  const resolvedAdditive = clamp(hitChanceAdditive, 0, 1);
  const hitChance = formulaIsFinite
    ? clamp(baseHitChance + resolvedAdditive, 0, 1)
    : 0;
  const roll = clamp(randomValue, 0, 0.999999999);

  // The roll must be strictly BELOW the chance to hit. The distinction only
  // matters at the ends, and it matters there: a turret with no tracking speed,
  // and one firing past optimal with no falloff, both resolve to a chance of
  // exactly 0, and a non-strict test let a roll of 0 through as a wrecking shot
  // on a weapon the same call had just declared could not hit at all.
  if (sumDamageVector(resolvedRawDamage) <= 0 || roll >= hitChance) {
    return {
      hit: false,
      wrecking: false,
      quality: 0,
      chanceToHit: round6(hitChance),
      baseChanceToHit: round6(baseHitChance),
      hitChanceAdditive: round6(resolvedAdditive),
      roll: round6(roll),
      surfaceDistance: round6(surfaceDistance),
      angularVelocity: round6(angularVelocity),
      targetSignatureRadius: round6(targetSignatureRadius),
      trackingTerm: Number.isFinite(trackingTerm) ? round6(trackingTerm) : trackingTerm,
      rangeTerm: Number.isFinite(rangeTerm) ? round6(rangeTerm) : rangeTerm,
      shotDamage: scaleDamageVector(resolvedRawDamage, 0),
    };
  }

  const wrecking = roll < 0.01;
  const quality = wrecking ? 3.0 : round6(0.49 + roll);

  return {
    hit: true,
    wrecking,
    quality,
    chanceToHit: round6(hitChance),
    baseChanceToHit: round6(baseHitChance),
    hitChanceAdditive: round6(resolvedAdditive),
    roll: round6(roll),
    surfaceDistance: round6(surfaceDistance),
    angularVelocity: round6(angularVelocity),
    targetSignatureRadius: round6(targetSignatureRadius),
    trackingTerm: Number.isFinite(trackingTerm) ? round6(trackingTerm) : trackingTerm,
    rangeTerm: Number.isFinite(rangeTerm) ? round6(rangeTerm) : rangeTerm,
    shotDamage: scaleDamageVector(resolvedRawDamage, quality),
  };
}

// The combat log's hit-quality word, and the client's per-barrel hit/miss
// visual, are both driven by a single integer 0-6 sent in the damage message.
// The V24 client only maps it to a localization label
// (eve/client/script/ui/shared/uilog.py#GetHitQualityMessage: 0 -> AttackMiss,
// 1..6 -> UI/Inflight/HitQuality1..6) and to the fraction of turret barrels
// drawn missing (environment/godma.py#DamageMessageGrouped: quality 1 hides
// half the barrels, 2 a quarter, >=3 none), so the band boundaries are server
// authority.
//
// The published mapping from damage multiplier to band is EVE University's
// "Turret mechanics" table:
//   1 Grazes       0.500 - 0.625
//   2 Glances off  0.625 - 0.750
//   3 Hits         0.750 - 1.000
//   4 Penetrates   1.000 - 1.250
//   5 Smashes      1.250 - 1.490
//   6 Wrecks       3.000
// The boundaries are eighths of the 1.0-wide multiplier range that
// resolveTurretShot produces (0.49 + roll, roll in [0.01, 1)), which is what
// makes them 0.5 + 1/8, + 2/8, + 4/8, + 6/8 rather than round decimals.
//
// A vorton projector and a fighter missile report a flat quality of 1, which
// lands in band 4 in both the old and the corrected table.
const TURRET_HIT_QUALITY_BANDS = Object.freeze([
  Object.freeze({ tier: 6, minimumQuality: 3 }),
  Object.freeze({ tier: 5, minimumQuality: 1.25 }),
  Object.freeze({ tier: 4, minimumQuality: 1 }),
  Object.freeze({ tier: 3, minimumQuality: 0.75 }),
  Object.freeze({ tier: 2, minimumQuality: 0.625 }),
  Object.freeze({ tier: 1, minimumQuality: 0 }),
]);

function resolveTurretHitQualityTier(shotResult) {
  if (!shotResult || shotResult.hit !== true) {
    return 0;
  }

  const quality = toFiniteNumber(shotResult.quality, 0);
  for (const band of TURRET_HIT_QUALITY_BANDS) {
    if (quality >= band.minimumQuality) {
      return band.tier;
    }
  }
  return 1;
}

module.exports = {
  TURRET_HIT_QUALITY_BANDS,
  resolveTurretShot,
  resolveTurretHitQualityTier,
  resolveLaserTurretShot: resolveTurretShot,
};
