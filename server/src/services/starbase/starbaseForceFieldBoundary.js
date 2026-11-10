"use strict";

const {
  buildForceFieldBoundaryCorrectionUpdates,
  buildStarbaseHarmonicUpdates,
} = require("../../space/destiny/commands/starbaseForceField");

const BOUNDARY_CLEARANCE_METERS = 1;
const MIN_REPULSION_SPEED = 500;
const MAX_REPULSION_SPEED = 2500;

function vector(value) {
  if (!value || ![value.x, value.y, value.z].every(Number.isFinite)) {
    return null;
  }
  return { x: value.x, y: value.y, z: value.z };
}

function relative(point, center) {
  return { x: point.x - center.x, y: point.y - center.y, z: point.z - center.z };
}

function dot(left, right) {
  return left.x * right.x + left.y * right.y + left.z * right.z;
}

function outsidePoint(center, radius, offset, fallback) {
  let direction = offset;
  let length = Math.hypot(direction.x, direction.y, direction.z);
  if (length < 0.000001) {
    direction = fallback || { x: 1, y: 0, z: 0 };
    length = Math.hypot(direction.x, direction.y, direction.z);
  }
  if (length < 0.000001) {
    direction = { x: 1, y: 0, z: 0 };
    length = 1;
  }
  return {
    x: center.x + direction.x * radius / length,
    y: center.y + direction.y * radius / length,
    z: center.z + direction.z * radius / length,
  };
}

// This is a POS admission response, not general ship/ball collision. The
// client exposes force-field harmonics in playerOwned.py:91-115; the private
// server-side boundary response is not present in ClientCodeGrabber/Latest.
// Keep swept hull protection for approaches, but eject an already-inside ship
// with velocity, never a teleport to the edge. Repulsion strength is server policy.
function resolveDeniedEntry(start, end, center, radius, options = {}) {
  const from = relative(start, center);
  const to = relative(end, center);
  const radiusSquared = radius * radius;
  const startsInside = dot(from, from) < radiusSquared;
  const endsInside = dot(to, to) < radiusSquared;
  if (options.warpCompleted === true) {
    return endsInside ? end : null;
  }
  if (startsInside) {
    // Push revoked/logged-in ships through ordinary motion until they leave.
    // A move already taking them outside needs no correction.
    return endsInside ? end : null;
  }
  const step = relative(end, start);
  const lengthSquared = dot(step, step);
  if (lengthSquared <= 0) {
    return null;
  }
  const inward = dot(from, step);
  const discriminant = inward * inward -
    lengthSquared * (dot(from, from) - radiusSquared);
  if (inward >= 0 || discriminant <= 0) {
    return null;
  }
  const fraction = (-inward - Math.sqrt(discriminant)) / lengthSquared;
  if (fraction < 0 || fraction > 1) {
    return null;
  }
  return outsidePoint(center, radius, {
    x: from.x + step.x * fraction,
    y: from.y + step.y * fraction,
    z: from.z + step.z * fraction,
  });
}

function enforceForceFieldMovement(scene, ship, previousPosition, result, options = {}) {
  // A ship in warp is not massive and crosses fields freely.
  if (!ship || ship.kind !== "ship" ||
      (ship.mode === "WARP" && Number(ship.effectStamp) >= 0 &&
        !(result && result.warpCompleted))) {
    return result;
  }
  const start = vector(previousPosition);
  const end = vector(ship.position);
  if (!start || !end) {
    return result;
  }
  const canEnter = options.canEnter || ((towerID, entity) =>
    require("./starbaseAccessRuntime").canShipEnterForceField(towerID, entity));
  let nearest = null;
  let admittedHarmonic = -1;
  for (const field of options.forceFields || []) {
    const towerID = Number(field &&
      (field.controlTowerID || field.spaceState && field.spaceState.controlTowerID));
    const center = vector(field && field.position);
    const fieldRadius = Number(field && field.radius);
    if (!(towerID > 0) || !center || !(fieldRadius > 0) ||
        (options.canInteract && !options.canInteract(ship, field))) {
      continue;
    }
    const radius = fieldRadius + Math.max(0, Number(ship.radius) || 0) +
      BOUNDARY_CLEARANCE_METERS;
    const point = resolveDeniedEntry(start, end, center, radius, {
      warpCompleted: result && result.warpCompleted === true,
    });
    if (!point) {
      continue;
    }
    if (canEnter(towerID, ship, { nowMs: options.nowMs })) {
      const offset = relative(end, center);
      if (dot(offset, offset) < radius * radius) admittedHarmonic = towerID;
      continue;
    }
    const travel = relative(point, start);
    const distanceSquared = dot(travel, travel);
    if (!nearest || distanceSquared < nearest.distanceSquared) {
      nearest = { fieldID: field.itemID, towerID, point, center, radius, distanceSquared };
    }
  }
  synchronizeShipHarmonic(scene, ship, nearest ? -1 : admittedHarmonic, options.nowMs);
  if (!nearest) {
    return result;
  }
  ship.position = nearest.point;
  // At the exact centre use the incoming side (or reverse heading on login).
  // No distance-sized position correction is needed for a denied warp landing.
  const heading = vector(ship.direction) || { x: 1, y: 0, z: 0 };
  const normal = outsidePoint({ x: 0, y: 0, z: 0 }, 1,
    relative(nearest.point, nearest.center),
    outsidePoint({ x: 0, y: 0, z: 0 }, 1, relative(start, nearest.center), {
      x: -heading.x, y: -heading.y, z: -heading.z,
    }));
  const velocity = vector(ship.velocity) || { x: 0, y: 0, z: 0 };
  const radialSpeed = dot(velocity, normal);
  // Boundary contact needs only a gentle separating impulse. Reserve the
  // stronger escape velocity for ships actually stranded deep inside.
  const startRadius = Math.hypot(...Object.values(relative(start, nearest.center)));
  const boundaryContact = !(result && result.warpCompleted) &&
    startRadius >= nearest.radius - BOUNDARY_CLEARANCE_METERS;
  const outwardSpeed = boundaryContact
    ? Math.max(20, Math.min(100, Math.max(0, -radialSpeed) * 0.1))
    : Math.max(MIN_REPULSION_SPEED,
      Math.min(MAX_REPULSION_SPEED, nearest.radius / 5));
  const impulse = Math.max(0, outwardSpeed - radialSpeed);
  ship.velocity = {
    x: velocity.x + normal.x * impulse,
    y: velocity.y + normal.y * impulse,
    z: velocity.z + normal.z * impulse,
  };
  // Cancel only orders pulling back into the field. Outward pilot orders and
  // tangential velocity remain usable; STOP still drifts under ordinary inertia.
  const target = vector(ship.targetPoint);
  const cancelledCommand = ship.mode !== "STOP" &&
    (!target || dot(relative(target, ship.position), normal) <= 0);
  if (cancelledCommand) {
    ship.mode = "STOP";
    ship.speedFraction = 0;
    ship.targetPoint = { ...ship.position };
    ship.targetEntityID = null;
    ship.effectStamp = 0;
    ship.warpDestination = null;
  }
  const completedWarpState = result && result.completedWarpState;
  return {
    ...result,
    changed: true,
    forceFieldBlocked: true,
    forceFieldID: nearest.fieldID,
    forceFieldCancelledCommand: Boolean(cancelledCommand),
    forceFieldPositionCorrected: dot(relative(nearest.point, end),
      relative(nearest.point, end)) > 0,
    ...(completedWarpState ? {
      completedWarpState: {
        ...completedWarpState,
        exitPosition: { ...nearest.point },
        exitVelocity: { ...ship.velocity },
      },
    } : {}),
  };
}

function synchronizeShipHarmonic(scene, ship, harmonic, nowMs) {
  // Corporation/alliance admission must also satisfy the current client's
  // CompareShipStructureHarmonic helper after login, without entering a secret.
  if (Number(ship.destinyHarmonic ?? ship.harmonic ?? -1) === harmonic) return;
  ship.destinyHarmonic = harmonic;
  ship.harmonic = harmonic;
  if (scene && typeof scene.queueBubbleHistory === "function") {
    scene.queueBubbleHistory(buildStarbaseHarmonicUpdates({
      scene,
      nowMs,
      entityID: ship.itemID,
      harmonic,
      corporationID: Number(ship.corporationID) || 0,
      allianceID: Number(ship.allianceID) || 0,
      isForcefield: false,
    }));
  }
}

function publishForceFieldBoundaryCorrection(scene, ship, nowMs, result = {}) {
  if (!scene || typeof scene.queueBubbleHistory !== "function") {
    return;
  }
  scene.queueBubbleHistory(buildForceFieldBoundaryCorrectionUpdates({
    scene,
    nowMs,
    shipID: ship.itemID,
    position: ship.position,
    velocity: ship.velocity,
    cancelledCommand: result.forceFieldCancelledCommand,
    positionCorrected: result.forceFieldPositionCorrected,
  }));
}

module.exports = {
  BOUNDARY_CLEARANCE_METERS,
  enforceForceFieldMovement,
  publishForceFieldBoundaryCorrection,
};
