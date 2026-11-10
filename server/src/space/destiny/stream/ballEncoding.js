"use strict";

const {
  BALL_FLAG,
  BALL_MODE,
  RUNTIME_CORPSE_KIND,
  RUNTIME_UNANCHORED_STRUCTURE_HULL_KIND,
} = require("../constants");
const {
  parseEntityIDBigInt,
  requireEntityID,
  toJSONSafeEntityID,
} = require("../identity/entityID");
const {
  getEntityBallRadius,
  resolveConfiguredBallFlags,
  resolveConfiguredBallMode,
  resolveDestinyPhysicalMass,
} = require("./ballConfig");
const {
  appendFreeBallOwnershipHeader,
  resolveDestinyHarmonic,
  resolveFreeBallAllianceID,
  resolveFreeBallCorporationID,
} = require("./freeBallHeader");
const {
  getStaticBallFlags,
  getStaticBallMode,
  resolveStaticBallTail,
} = require("./staticBallTail");
const {
  buildVector,
  normalizeVector,
  pushBigInt64,
  pushDouble,
  pushFloat,
  pushInt32,
  pushUInt8,
  toFiniteNumber,
  toInt32,
} = require("./primitives");
const {
  ENTITY_TYPE,
} = require("../../entityConstants");

const FREE_MODE_BY_NAME = Object.freeze({
  GOTO: BALL_MODE.GOTO,
  FOLLOW: BALL_MODE.FOLLOW,
  STOP: BALL_MODE.STOP,
  WARP: BALL_MODE.WARP,
  ORBIT: BALL_MODE.ORBIT,
  MISSILE: BALL_MODE.MISSILE,
  MUSHROOM: BALL_MODE.MUSHROOM,
  TROLL: BALL_MODE.TROLL,
  FIELD: BALL_MODE.FIELD,
  FORMATION: BALL_MODE.FORMATION,
});

const SUPPORTED_FREE_MODES = new Set(Object.values(FREE_MODE_BY_NAME));
// INTERIM: until collision handling in Evolve no ship is sent
// INTERIM: massive, so no client bounces one off a station that Server
// INTERIM: flies through; collision handling sets this back to true with its
// INTERIM: response.
const SHIPS_MASSIVE_ON_THE_WIRE = false; // INTERIM: until collision handling in Evolve
const FREE_WIRE_CONFIG_FLAGS = (
  BALL_FLAG.IS_GLOBAL |
  BALL_FLAG.IS_MASSIVE |
  BALL_FLAG.IS_INTERACTIVE |
  BALL_FLAG.IS_SPACEJUNK
);

function getLegacyFreeBallMode(entity) {
  const name = entity && typeof entity.mode === "string"
    ? entity.mode.trim().toUpperCase()
    : "";
  return Object.prototype.hasOwnProperty.call(FREE_MODE_BY_NAME, name)
    ? FREE_MODE_BY_NAME[name]
    : BALL_MODE.STOP;
}

function getFollowIdentityValue(entity) {
  return entity && (
    entity.targetEntityID ??
    entity.followTargetID ??
    entity.followID ??
    entity.followId ??
    entity.parentEntityID
  );
}

function isTargetedLiveMissile(entity) {
  if (!entity || entity.kind !== "missile") {
    return false;
  }
  const legacyMode = getLegacyFreeBallMode(entity);
  const requestedMode = resolveConfiguredBallMode(entity, legacyMode);
  if (requestedMode !== BALL_MODE.MISSILE) {
    return false;
  }
  const targetID = parseEntityIDBigInt(getFollowIdentityValue(entity));
  return (
    targetID !== null &&
    targetID !== 0n &&
    hasExplicitMissilePresentationFlag(entity)
  );
}

function getFreeBallMode(entity) {
  const legacyMode = getLegacyFreeBallMode(entity);
  const configuredMode = resolveConfiguredBallMode(entity, legacyMode);
  const mode = SUPPORTED_FREE_MODES.has(configuredMode)
    ? configuredMode
    : BALL_MODE.STOP;
  if (mode === BALL_MODE.MISSILE && !isTargetedLiveMissile(entity)) {
    return BALL_MODE.GOTO;
  }
  return mode;
}

function isFreeBallEntity(entity) {
  if (
    entity &&
    Object.prototype.hasOwnProperty.call(entity, "destinyForceFree") &&
    typeof entity.destinyForceFree === "boolean"
  ) {
    return entity.destinyForceFree;
  }
  if (entity && typeof entity.isFree === "boolean") {
    return entity.isFree;
  }
  return Boolean(
    entity &&
    (
      entity.kind === "ship" ||
      entity.kind === "missile" ||
      entity.kind === "drone" ||
      entity.kind === "fighter" ||
      entity.kind === "warpDisruptionProbe" ||
      entity.kind === "forceField" ||
      entity.kind === "container" ||
      entity.kind === "wreck" ||
      entity.kind === RUNTIME_CORPSE_KIND ||
      entity.kind === RUNTIME_UNANCHORED_STRUCTURE_HULL_KIND
    )
  );
}

function hasPositiveIdentity(value) {
  const parsed = parseEntityIDBigInt(value);
  return parsed !== null && parsed > 0n;
}

function isNpcShipEntity(entity) {
  if (!entity || entity.kind !== "ship") {
    return false;
  }
  const npcEntityType = String(entity.npcEntityType || "").trim().toLowerCase();
  return (
    entity.nativeNpc === true ||
    npcEntityType === ENTITY_TYPE.NPC ||
    npcEntityType === ENTITY_TYPE.CONCORD ||
    npcEntityType === "drifter"
  );
}

function isFreeBallInteractive(entity) {
  if (!isFreeBallEntity(entity)) {
    return false;
  }
  if (entity.kind === "container" || entity.kind === "wreck") {
    return true;
  }
  if (entity.kind === RUNTIME_UNANCHORED_STRUCTURE_HULL_KIND) {
    return true;
  }
  if (entity.kind === RUNTIME_CORPSE_KIND) {
    return true;
  }
  if (entity.kind === "missile" || entity.kind === "warpDisruptionProbe") {
    return false;
  }
  if (entity.destinyForceInteractive === true) {
    return true;
  }
  if (entity.destinyForceInteractive === false) {
    return false;
  }
  if (
    Object.prototype.hasOwnProperty.call(entity, "destinyBallFlags") &&
    Number.isFinite(Number(entity.destinyBallFlags))
  ) {
    return (
      resolveConfiguredBallFlags(entity, 0) & BALL_FLAG.IS_INTERACTIVE
    ) !== 0;
  }
  // A fighter squadron is not interactive: the flag is "true if ball is
  // associated with a user" (carbon-destiny Partitionable.h L32), a piloted
  // ship, and retail's squadrons stop when what they orbit dies, cloaks or
  // warps, which Destiny's StopAllFollowers does only to a non-interactive
  // orbiter. Drones keep theirs.
  if (entity.kind === "fighter") {
    return false;
  }
  if (entity.kind === "drone") {
    return (
      hasPositiveIdentity(entity.controllerID) ||
      hasPositiveIdentity(entity.ownerID)
    );
  }
  if (isNpcShipEntity(entity)) {
    return false;
  }
  return Boolean(
    entity.session ||
    hasPositiveIdentity(entity.pilotCharacterID ?? entity.characterID)
  );
}

function hasExplicitMissilePresentationFlag(entity) {
  if (typeof (entity && entity.isMassive) === "boolean") {
    return entity.isMassive === true;
  }
  return Boolean(entity && entity.massive === true);
}

function isShipWarpAlignmentBall(entity) {
  if (
    !entity ||
    entity.kind !== "ship" ||
    getFreeBallMode(entity) !== BALL_MODE.WARP
  ) {
    return false;
  }
  const effectStamp = Number(entity.effectStamp);
  return Number.isInteger(effectStamp) && effectStamp < 0;
}

function getFreeBallFlags(entity) {
  if (entity && entity.kind === "missile") {
    return isTargetedLiveMissile(entity)
      ? BALL_FLAG.IS_FREE | BALL_FLAG.IS_MASSIVE
      : BALL_FLAG.IS_FREE;
  }
  const configured = resolveConfiguredBallFlags(entity, 0) & FREE_WIRE_CONFIG_FLAGS;
  let flags = BALL_FLAG.IS_FREE | configured;
  flags = isFreeBallInteractive(entity)
    ? flags | BALL_FLAG.IS_INTERACTIVE
    : flags & ~BALL_FLAG.IS_INTERACTIVE;

  if (entity && entity.kind === "ship") {
    // Carbon aliases a WARP record's total distance through mLastCollision.
    // A proper WARP record must therefore stay out of the massive collision
    // path, which can overwrite that phase input before the warp solver uses
    // it. TQ's inbound AddBalls records use 0x09 for proper WARP and reserve
    // 0x0d for the negative-effect-stamp alignment presentation.
    // INTERIM: until collision handling in Evolve, Server's
    // INTERIM: Evolve gives no collision response, so a ship is never
    // INTERIM: sent massive, aligning included: a massive ship bounces
    // INTERIM: off a station on the client only (Gradient, carbon-
    // INTERIM: destiny v2.1.1 Ballpark.cpp L470). Collision handling restores
    // INTERIM: 0x0d.
    flags = isShipWarpAlignmentBall(entity) && SHIPS_MASSIVE_ON_THE_WIRE // INTERIM: until collision handling in Evolve
      ? flags | BALL_FLAG.IS_MASSIVE
      : flags & ~BALL_FLAG.IS_MASSIVE;
  } else if (typeof (entity && entity.isMassive) === "boolean") {
    flags = entity.isMassive
      ? flags | BALL_FLAG.IS_MASSIVE
      : flags & ~BALL_FLAG.IS_MASSIVE;
  } else if (typeof (entity && entity.massive) === "boolean") {
    flags = entity.massive
      ? flags | BALL_FLAG.IS_MASSIVE
      : flags & ~BALL_FLAG.IS_MASSIVE;
  }
  return flags & 0xff;
}

function getRigidBallFlags(entity) {
  return getStaticBallFlags(entity);
}

function getShipTargetPoint(entity) {
  if (entity && entity.targetPoint) {
    return buildVector(entity.targetPoint);
  }
  const direction = normalizeVector(
    entity && entity.direction,
    { x: 1, y: 0, z: 0 },
  );
  const position = buildVector(entity && entity.position);
  return {
    x: position.x + (direction.x * 1.0e16),
    y: position.y + (direction.y * 1.0e16),
    z: position.z + (direction.z * 1.0e16),
  };
}

// A WARP record's goto point is the Ball's (retail's mGoto): the raw
// destination while it aligns, moved back by the minimum range once RealWarp
// has run.
function getDestinyWarpTargetPoint(entity) {
  return getShipTargetPoint(entity);
}

function getShipDirection(entity) {
  if (entity && entity.direction) {
    return normalizeVector(entity.direction, { x: 1, y: 0, z: 0 });
  }
  if (entity && entity.targetPoint && entity.position) {
    return normalizeVector({
      x: entity.targetPoint.x - entity.position.x,
      y: entity.targetPoint.y - entity.position.y,
      z: entity.targetPoint.z - entity.position.z,
    }, { x: 1, y: 0, z: 0 });
  }
  return { x: 1, y: 0, z: 0 };
}

function getShipWarpFactor(entity) {
  const factor = toInt32(
    toInt32(entity && entity.warpFactor, 0) ||
      (toFiniteNumber(entity && entity.warpSpeedAU, 0) > 0
        ? Math.round(entity.warpSpeedAU * 1000)
        : 3000),
    3000,
  );
  return Number.isSafeInteger(factor) && factor >= 0 && factor <= 0xffffffff
    ? factor
    : 3000;
}

function resolveOptionalEntityID(value, fallback, label) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  return requireEntityID(value, label);
}

function getEntityCloakMode(entity) {
  return toInt32(
    entity && (entity.isCloaked ?? entity.cloakMode ?? entity.cloaked),
    0,
  );
}

function getEntityEffectStamp(entity) {
  return toInt32(
    entity && (
      entity.effectStamp ??
      entity.destinyEffectStamp ??
      (entity.missileState && entity.missileState.effectStamp)
    ),
    0,
  );
}

function getEntityModeOwnerID(entity) {
  const value = entity && (
    entity.ownerEntityID ??
    entity.launcherEntityID ??
    entity.sourceShipID ??
    entity.sourceEntityID ??
    entity.ownerBallID ??
    entity.modeOwnerID ??
    entity.ownerID ??
    entity.parentEntityID
  );
  return resolveOptionalEntityID(value, 0, "Destiny mode owner");
}

function getEntityFollowID(entity) {
  return resolveOptionalEntityID(
    entity && (
      entity.targetEntityID ??
      entity.followTargetID ??
      entity.followID ??
      entity.followId ??
      entity.parentEntityID
    ),
    0,
    "Destiny follow target",
  );
}

function getEntityFollowRange(entity) {
  return toFiniteNumber(
    entity && (
      entity.followRange ??
      entity.orbitDistance ??
      entity.formationRange ??
      entity.missileRange
    ),
    0,
  );
}

// The range an ORBIT record carries: the distance Server's Evolve orbits at
// (simulation/evolve.js orbitAcceleration reads orbitDistance, then
// followRange). Retail keeps one follow range per Ball for Follow and Orbit;
// Server keeps two fields, and an orbit order leaves followRange at 0.
function getEntityOrbitRange(entity) {
  return toFiniteNumber(
    entity && entity.orbitDistance,
    toFiniteNumber(entity && entity.followRange, 0),
  );
}

function getEntityMushroomSpan(entity) {
  return toFiniteNumber(
    entity && (
      entity.span ??
      entity.mushroomSpan ??
      entity.destinationSpan ??
      entity.targetSpan ??
      (entity.targetPoint && entity.targetPoint.x)
    ),
    0,
  );
}

function getDestinyEffectStamp(entity) {
  return getEntityEffectStamp(entity);
}

function getDestinyFollowRange(entity) {
  return getEntityFollowRange(entity);
}

function getDestinyFollowTargetID(entity) {
  return getEntityFollowID(entity);
}

function getDestinyMushroomSpan(entity) {
  return getEntityMushroomSpan(entity);
}

function getDestinyOwnerBallID(entity) {
  return getEntityModeOwnerID(entity);
}

function getDestinyWarpMinimumRange(entity) {
  return toFiniteNumber(entity && entity.warpMinRange, 0);
}

function getDestinyWarpOwnerID(entity) {
  return BigInt(getShipWarpFactor(entity));
}

function buildAddBallsBootstrapEntity(entity, options = {}) {
  return entity;
}

function encodeRigidBall(entity) {
  const chunks = [];
  const position = buildVector(entity && entity.position);
  const mode = getStaticBallMode(entity);
  const staticTail = resolveStaticBallTail(entity);
  pushBigInt64(
    chunks,
    requireEntityID(entity && entity.itemID, "Destiny ball itemID"),
  );
  pushUInt8(chunks, mode);
  pushFloat(chunks, getEntityBallRadius(entity));
  pushDouble(chunks, position.x);
  pushDouble(chunks, position.y);
  pushDouble(chunks, position.z);
  pushUInt8(chunks, getRigidBallFlags(entity));
  chunks.push(staticTail.tail);
  return Buffer.concat(chunks);
}

function encodeFreeBall(entity, options = {}) {
  const encodedEntity = buildAddBallsBootstrapEntity(entity, options);
  const chunks = [];
  const position = buildVector(encodedEntity && encodedEntity.position);
  const velocity = buildVector(encodedEntity && encodedEntity.velocity);
  const mode = getFreeBallMode(encodedEntity);
  pushBigInt64(
    chunks,
    requireEntityID(encodedEntity && encodedEntity.itemID, "Destiny ball itemID"),
  );
  pushUInt8(chunks, mode);
  pushFloat(chunks, getEntityBallRadius(encodedEntity));
  pushDouble(chunks, position.x);
  pushDouble(chunks, position.y);
  pushDouble(chunks, position.z);
  pushUInt8(chunks, getFreeBallFlags(encodedEntity));

  const fallbackMass = (
    encodedEntity.kind === "container" || encodedEntity.kind === "wreck"
  ) ? 10_000 : 1_000_000;
  pushDouble(
    chunks,
    resolveDestinyPhysicalMass(encodedEntity, fallbackMass),
  );
  pushUInt8(chunks, getEntityCloakMode(encodedEntity));
  appendFreeBallOwnershipHeader(chunks, encodedEntity);
  pushFloat(chunks, toFiniteNumber(encodedEntity.maxVelocity, 0));
  pushDouble(chunks, velocity.x);
  pushDouble(chunks, velocity.y);
  pushDouble(chunks, velocity.z);
  pushFloat(chunks, toFiniteNumber(encodedEntity.inertia, 1));
  pushFloat(chunks, toFiniteNumber(encodedEntity.speedFraction, 0));
  pushUInt8(chunks, 0xff);

  switch (mode) {
    case BALL_MODE.GOTO: {
      const targetPoint = getShipTargetPoint(encodedEntity);
      pushDouble(chunks, targetPoint.x);
      pushDouble(chunks, targetPoint.y);
      pushDouble(chunks, targetPoint.z);
      break;
    }
    case BALL_MODE.FOLLOW:
      pushBigInt64(chunks, getEntityFollowID(encodedEntity));
      pushFloat(chunks, getEntityFollowRange(encodedEntity));
      break;
    case BALL_MODE.FORMATION:
      pushBigInt64(chunks, getEntityFollowID(encodedEntity));
      pushFloat(chunks, getEntityFollowRange(encodedEntity));
      pushInt32(chunks, getEntityEffectStamp(encodedEntity));
      break;
    case BALL_MODE.MISSILE: {
      const targetPoint = getShipTargetPoint(encodedEntity);
      pushBigInt64(chunks, getEntityFollowID(encodedEntity));
      pushFloat(chunks, getEntityFollowRange(encodedEntity));
      pushBigInt64(chunks, getEntityModeOwnerID(encodedEntity));
      pushInt32(chunks, getEntityEffectStamp(encodedEntity));
      pushDouble(chunks, targetPoint.x);
      pushDouble(chunks, targetPoint.y);
      pushDouble(chunks, targetPoint.z);
      break;
    }
    case BALL_MODE.WARP: {
      const targetPoint = getDestinyWarpTargetPoint(encodedEntity);
      pushDouble(chunks, targetPoint.x);
      pushDouble(chunks, targetPoint.y);
      pushDouble(chunks, targetPoint.z);
      pushInt32(chunks, toInt32(encodedEntity && encodedEntity.effectStamp, 0));
      pushDouble(chunks, toFiniteNumber(encodedEntity && encodedEntity.warpDistance, 0));
      pushDouble(chunks, getDestinyWarpMinimumRange(encodedEntity));
      pushBigInt64(chunks, getDestinyWarpOwnerID(encodedEntity));
      break;
    }
    case BALL_MODE.ORBIT:
      pushBigInt64(chunks, getEntityFollowID(encodedEntity));
      pushFloat(chunks, getEntityOrbitRange(encodedEntity));
      break;
    case BALL_MODE.MUSHROOM:
      pushFloat(chunks, getEntityFollowRange(encodedEntity));
      pushDouble(chunks, getEntityMushroomSpan(encodedEntity));
      pushInt32(chunks, getEntityEffectStamp(encodedEntity));
      pushBigInt64(chunks, getEntityModeOwnerID(encodedEntity));
      break;
    case BALL_MODE.TROLL:
      pushInt32(chunks, getEntityEffectStamp(encodedEntity));
      break;
    default:
      break;
  }
  return Buffer.concat(chunks);
}

function encodeEntityBall(entity, options = {}) {
  return isFreeBallEntity(entity)
    ? encodeFreeBall(entity, options)
    : encodeRigidBall(entity);
}

function describeBallMode(mode) {
  for (const [name, code] of Object.entries(FREE_MODE_BY_NAME)) {
    if (code === mode) {
      return name;
    }
  }
  if (mode === BALL_MODE.BOID) {
    return "BOID";
  }
  if (mode === BALL_MODE.MINIBALL) {
    return "MINIBALL";
  }
  return mode === BALL_MODE.RIGID ? "RIGID" : `UNKNOWN_${mode}`;
}

function describeBallFlags(flags) {
  const byte = toInt32(flags, 0) & 0xff;
  return {
    byte,
    isFree: (byte & BALL_FLAG.IS_FREE) !== 0,
    isGlobal: (byte & BALL_FLAG.IS_GLOBAL) !== 0,
    isMassive: (byte & BALL_FLAG.IS_MASSIVE) !== 0,
    isInteractive: (byte & BALL_FLAG.IS_INTERACTIVE) !== 0,
    isSpaceJunk: (byte & BALL_FLAG.IS_SPACEJUNK) !== 0,
    hasMiniBoxes: (byte & BALL_FLAG.HAS_MINIBOXES) !== 0,
    hasMiniBalls: (byte & BALL_FLAG.HAS_MINIBALLS) !== 0,
    hasMiniCapsules: (byte & BALL_FLAG.HAS_MINICAPSULES) !== 0,
  };
}

function getJSONSafeEntityID(value, fallback = 0) {
  const normalized = toJSONSafeEntityID(value);
  return normalized === null ? fallback : normalized;
}

function buildFreeBallDebugSummary(entity) {
  const mode = getFreeBallMode(entity);
  const summary = {
    kind: entity.kind,
    itemID: getJSONSafeEntityID(entity.itemID),
    mode: describeBallMode(mode),
    modeCode: mode,
    flags: describeBallFlags(getFreeBallFlags(entity)),
    radius: getEntityBallRadius(entity),
    position: buildVector(entity.position),
    mass: resolveDestinyPhysicalMass(
      entity,
      entity.kind === "container" || entity.kind === "wreck"
        ? 10_000
        : 1_000_000,
    ),
    isCloaked: getEntityCloakMode(entity),
    harmonic: getJSONSafeEntityID(resolveDestinyHarmonic(entity), -1),
    corporationID: resolveFreeBallCorporationID(entity),
    allianceID: resolveFreeBallAllianceID(entity),
    maxVelocity: toFiniteNumber(entity.maxVelocity, 0),
    velocity: buildVector(entity.velocity),
    inertia: toFiniteNumber(entity.inertia, 1),
    speedFraction: toFiniteNumber(entity.speedFraction, 0),
    modeData: null,
  };

  if (mode === BALL_MODE.GOTO) {
    summary.modeData = { targetPoint: getShipTargetPoint(entity) };
  } else if (mode === BALL_MODE.FOLLOW) {
    summary.modeData = {
      targetEntityID: getJSONSafeEntityID(getEntityFollowID(entity)),
      followRange: getEntityFollowRange(entity),
    };
  } else if (mode === BALL_MODE.FORMATION) {
    summary.modeData = {
      targetEntityID: getJSONSafeEntityID(getEntityFollowID(entity)),
      followRange: getEntityFollowRange(entity),
      effectStamp: getEntityEffectStamp(entity),
    };
  } else if (mode === BALL_MODE.MISSILE) {
    summary.modeData = {
      targetEntityID: getJSONSafeEntityID(getEntityFollowID(entity)),
      followRange: getEntityFollowRange(entity),
      ownerID: getJSONSafeEntityID(getEntityModeOwnerID(entity)),
      effectStamp: getEntityEffectStamp(entity),
      targetPoint: getShipTargetPoint(entity),
    };
  } else if (mode === BALL_MODE.WARP) {
    const totalDistance = toFiniteNumber(entity.warpDistance, 0);
    const minimumRange = toFiniteNumber(entity.warpMinRange, 0);
    const warpFactor = getShipWarpFactor(entity);
    summary.modeData = {
      targetPoint: getDestinyWarpTargetPoint(entity),
      effectStamp: toInt32(entity.effectStamp, 0),
      lastCollision: totalDistance,
      totalDistance,
      minimumRange,
      stopDistance: minimumRange,
      ownerID: getJSONSafeEntityID(getDestinyWarpOwnerID(entity)),
      warpFactor,
    };
  } else if (mode === BALL_MODE.ORBIT) {
    summary.modeData = {
      targetEntityID: getJSONSafeEntityID(getEntityFollowID(entity)),
      orbitDistance: getEntityOrbitRange(entity),
    };
  } else if (mode === BALL_MODE.MUSHROOM) {
    summary.modeData = {
      followRange: getEntityFollowRange(entity),
      span: getEntityMushroomSpan(entity),
      effectStamp: getEntityEffectStamp(entity),
      ownerID: getJSONSafeEntityID(getEntityModeOwnerID(entity)),
    };
  } else if (mode === BALL_MODE.TROLL) {
    summary.modeData = { effectStamp: getEntityEffectStamp(entity) };
  }
  return summary;
}

function debugDescribeEntityBall(entity, options = {}) {
  const debugEntity = buildAddBallsBootstrapEntity(entity, options);
  const encoded = encodeEntityBall(entity, options);
  const summary = isFreeBallEntity(debugEntity)
    ? buildFreeBallDebugSummary(debugEntity)
    : (() => {
        const mode = getStaticBallMode(debugEntity);
        const staticTail = resolveStaticBallTail(debugEntity);
        return {
          kind: debugEntity.kind,
          itemID: getJSONSafeEntityID(debugEntity.itemID),
          mode: describeBallMode(mode),
          modeCode: mode,
          flags: describeBallFlags(getRigidBallFlags(debugEntity)),
          radius: getEntityBallRadius(debugEntity),
          position: buildVector(debugEntity.position),
          staticTailBytes: staticTail.tail.length,
          staticTailSource: staticTail.source,
        };
      })();
  return {
    encodedLength: encoded.length,
    encodedHex: encoded.toString("hex"),
    summary,
  };
}

module.exports = {
  buildAddBallsBootstrapEntity,
  debugDescribeEntityBall,
  describeBallFlags,
  describeBallMode,
  encodeEntityBall,
  encodeFreeBall,
  encodeRigidBall,
  getDestinyEffectStamp,
  getDestinyFollowRange,
  getDestinyFollowTargetID,
  getDestinyMushroomSpan,
  getDestinyOwnerBallID,
  getDestinyWarpMinimumRange,
  getDestinyWarpOwnerID,
  getEntityCloakMode,
  getEntityEffectStamp,
  getEntityFollowID,
  getEntityFollowRange,
  getEntityModeOwnerID,
  getEntityMushroomSpan,
  getFreeBallFlags,
  getFreeBallMode,
  getRigidBallFlags,
  getShipDirection,
  getShipTargetPoint,
  getShipWarpFactor,
  isFreeBallEntity,
  isFreeBallInteractive,
  isTargetedLiveMissile,
};
