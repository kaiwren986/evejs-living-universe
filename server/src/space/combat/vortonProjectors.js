"use strict";

const {
  round6,
  toFiniteNumber,
} = require("../../common/numbers");

const path = require("path");

const {
  normalizeDamageVector,
  sumDamageVector,
} = require(path.join(__dirname, "./damage"));
const {
  resolveMissileAppliedDamage,
} = require(path.join(__dirname, "./missiles/missileSolver"));

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
  const delta = subtractVectors(
    targetEntity && targetEntity.position,
    sourceEntity && sourceEntity.position,
  );
  return Math.max(
    0,
    magnitude(delta) -
      Math.max(0, toFiniteNumber(sourceEntity && sourceEntity.radius, 0)) -
      Math.max(0, toFiniteNumber(targetEntity && targetEntity.radius, 0)),
  );
}

function toEntityID(entity) {
  return Math.trunc(toFiniteNumber(entity && entity.itemID, 0));
}

/**
 * A vorton projector never rolls to hit.  It has no trackingSpeed, so there is no
 * angular error term at all: inside optimal it always connects, and damage is
 * scaled by the same signature/velocity application curve missiles use.  Outside
 * optimal it does nothing — the module declares no falloff.
 */
function resolveVortonShot({
  attackerEntity,
  targetEntity,
  weaponSnapshot,
} = {}) {
  const rawShotDamage = normalizeDamageVector(
    weaponSnapshot && weaponSnapshot.rawShotDamage,
  );
  const surfaceDistance = getSurfaceDistance(attackerEntity, targetEntity);
  const optimalRange = Math.max(
    0,
    toFiniteNumber(weaponSnapshot && weaponSnapshot.optimalRange, 0),
  );
  const outOfRange = surfaceDistance > optimalRange + 1e-6;

  if (outOfRange || sumDamageVector(rawShotDamage) <= 0) {
    return {
      hit: false,
      wrecking: false,
      quality: 0,
      chanceToHit: outOfRange ? 0 : 1,
      surfaceDistance: round6(surfaceDistance),
      optimalRange: round6(optimalRange),
      outOfRange,
      applicationFactor: 0,
      shotDamage: {
        em: 0, thermal: 0, kinetic: 0, explosive: 0,
      },
    };
  }

  const applied = resolveMissileAppliedDamage(weaponSnapshot, targetEntity);

  return {
    hit: true,
    wrecking: false,
    quality: 1,
    chanceToHit: 1,
    surfaceDistance: round6(surfaceDistance),
    optimalRange: round6(optimalRange),
    outOfRange: false,
    applicationFactor: round6(
      applied.application && applied.application.applicationFactor,
    ),
    targetSignatureRadius: round6(
      applied.impactState && applied.impactState.signatureRadius,
    ),
    shotDamage: applied.appliedDamage,
  };
}

// Chain lightning arcs only to combat entities and large collidable structures -
// the same things a vorton can meaningfully engage.  It must NOT arc to wrecks,
// jetcans or other inert loot, which carry structure HP (so pilots can shoot
// them) and would otherwise read as valid via hasDamageableHealth alone.
const VORTON_ARC_TARGET_KINDS = new Set([
  "ship", // enemy ships
  "drone", // enemy drones
  "fighter", // enemy fighters: launched combat craft, same intent as drones
  "structure", // large collidable Upwell structures
  "orbital", // customs offices and other planetary orbitals
]);

function isVortonArcTargetKind(kind) {
  return VORTON_ARC_TARGET_KINDS.has(String(kind || ""));
}

/**
 * VortonArcTargets (3037) is the TOTAL number of ships a shot strikes, the
 * primary included - "Maximum number of arc targets hit" in the SDE, and EVE
 * University describes a shot as arcing "across up to nine additional random
 * ships (or drones) within 10km of the first" for the declared value of 10.
 * CCP's own 19.05 note ("increased the number of chained targets from 5 to 10")
 * counts the same way. So the number of ARC LINKS is one less than the
 * attribute, and a projector declaring 1 arcs to nobody.
 */
function resolveVortonArcLinkBudget(weaponSnapshot) {
  const arcTargets = Math.max(
    0,
    Math.trunc(toFiniteNumber(weaponSnapshot && weaponSnapshot.arcTargets, 0)),
  );
  return Math.max(0, arcTargets - 1);
}

/**
 * Chain lightning does NOT cascade. Every arc victim is chosen by its distance
 * to the PRIMARY target: VortonArcRange (3036) is defined in the SDE as "the
 * maximum distance from the original target from which additional targets can
 * receive arc damage", and EVE University states that despite the daisy-chain
 * animation the client draws, the arcs do not bounce onward to chain further
 * entities. A link-to-link walk gets this wrong in both directions - it lets a
 * line of ships carry the bolt indefinitely past the primary, and it stops dead
 * in a cluster whose members are all near the primary but far from each other.
 *
 * Selection among eligible candidates is random once there are more of them
 * than the budget allows; the emitted chain is then ordered by distance from
 * the primary, which is the order the client draws its stretch effects in.
 * Candidate supply is the caller's business - it decides what is a legal target.
 */
function selectVortonArcTargets({
  attackerEntity,
  primaryTargetEntity,
  candidateEntities = [],
  weaponSnapshot,
  random = Math.random,
} = {}) {
  const arcRange = Math.max(
    0,
    toFiniteNumber(weaponSnapshot && weaponSnapshot.arcRange, 0),
  );
  const arcLinkBudget = resolveVortonArcLinkBudget(weaponSnapshot);
  if (arcRange <= 0 || arcLinkBudget <= 0 || !primaryTargetEntity) {
    return [];
  }

  const struck = new Set([
    toEntityID(attackerEntity),
    toEntityID(primaryTargetEntity),
  ]);
  const eligible = [];
  const seen = new Set();
  for (const entity of (Array.isArray(candidateEntities) ? candidateEntities : [])) {
    const entityID = toEntityID(entity);
    if (!entity || struck.has(entityID) || seen.has(entityID)) {
      continue;
    }
    const distanceFromPrimaryTarget = getSurfaceDistance(primaryTargetEntity, entity);
    if (distanceFromPrimaryTarget > arcRange + 1e-6) {
      continue;
    }
    seen.add(entityID);
    eligible.push({
      entity,
      distanceFromPrimaryTarget: round6(distanceFromPrimaryTarget),
    });
  }

  const selected = eligible.length <= arcLinkBudget
    ? eligible
    : sampleWithoutReplacement(eligible, arcLinkBudget, random);

  // Distance order, with the entity ID as the tiebreak so two candidates at the
  // same range never swap places between cycles.
  selected.sort((left, right) => (
    left.distanceFromPrimaryTarget - right.distanceFromPrimaryTarget ||
    toEntityID(left.entity) - toEntityID(right.entity)
  ));

  return selected.map((row, index) => ({
    entity: row.entity,
    linkIndex: index + 1,
    distanceFromPrimaryTarget: row.distanceFromPrimaryTarget,
  }));
}

// Partial Fisher-Yates: draws `count` distinct rows without disturbing the
// caller's array, and consumes exactly `count` random draws so a seeded or
// stubbed generator stays predictable.
function sampleWithoutReplacement(rows, count, random) {
  const pool = rows.slice();
  const drawn = [];
  const draw = typeof random === "function" ? random : Math.random;
  for (let index = 0; index < count && pool.length > 0; index += 1) {
    const rolled = Number(draw());
    const normalized = Number.isFinite(rolled) ? Math.min(Math.max(rolled, 0), 0.999999999) : 0;
    const pickIndex = Math.floor(normalized * pool.length);
    drawn.push(pool.splice(Math.min(pickIndex, pool.length - 1), 1)[0]);
  }
  return drawn;
}

/**
 * Arc damage is resolved per link against that entity's own signature and
 * velocity, so a fast frigate shrugs off an arc that guts the battleship next to
 * it.  There is deliberately NO per-jump damage decay: ship-mounted vorton
 * projectors declare no such attribute, and the structure version proves the
 * omission is intentional - the Standup Arcing Vorton Projector I (35928)
 * carries lightningWeaponDamageLossTarget (2106) = 0.85 alongside its own
 * target-count and range attributes, and no module in group 4060 carries 2106
 * at all.  Range to the firing ship is deliberately not rechecked either: the
 * arc reaches out from the primary target, which may itself sit at optimal.
 */
function resolveVortonArcShot({ targetEntity, weaponSnapshot } = {}) {
  const rawShotDamage = normalizeDamageVector(
    weaponSnapshot && weaponSnapshot.rawShotDamage,
  );
  if (sumDamageVector(rawShotDamage) <= 0) {
    return {
      hit: false,
      wrecking: false,
      quality: 0,
      applicationFactor: 0,
      shotDamage: {
        em: 0, thermal: 0, kinetic: 0, explosive: 0,
      },
    };
  }

  const applied = resolveMissileAppliedDamage(weaponSnapshot, targetEntity);
  return {
    hit: true,
    wrecking: false,
    quality: 1,
    chanceToHit: 1,
    applicationFactor: round6(
      applied.application && applied.application.applicationFactor,
    ),
    shotDamage: applied.appliedDamage,
  };
}

module.exports = {
  resolveVortonShot,
  resolveVortonArcShot,
  selectVortonArcTargets,
  resolveVortonArcLinkBudget,
  isVortonArcTargetKind,
  getSurfaceDistance,
};
