"use strict";

function defaultToFiniteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function createDestinyWarpTargetPlanner(deps = {}) {
  const toFiniteNumber =
    typeof deps.toFiniteNumber === "function"
      ? deps.toFiniteNumber
      : defaultToFiniteNumber;
  const addVectors =
    typeof deps.addVectors === "function"
      ? deps.addVectors
      : (left, right) => ({
          x: toFiniteNumber(left && left.x, 0) +
            toFiniteNumber(right && right.x, 0),
          y: toFiniteNumber(left && left.y, 0) +
            toFiniteNumber(right && right.y, 0),
          z: toFiniteNumber(left && left.z, 0) +
            toFiniteNumber(right && right.z, 0),
        });
  const cloneVector =
    typeof deps.cloneVector === "function"
      ? deps.cloneVector
      : (source = null) => ({
          x: toFiniteNumber(source && source.x, 0),
          y: toFiniteNumber(source && source.y, 0),
          z: toFiniteNumber(source && source.z, 0),
        });
  const dotProduct =
    typeof deps.dotProduct === "function"
      ? deps.dotProduct
      : (left, right) => (
          toFiniteNumber(left && left.x, 0) *
            toFiniteNumber(right && right.x, 0) +
          toFiniteNumber(left && left.y, 0) *
            toFiniteNumber(right && right.y, 0) +
          toFiniteNumber(left && left.z, 0) *
            toFiniteNumber(right && right.z, 0)
        );
  const normalizeVector =
    typeof deps.normalizeVector === "function"
      ? deps.normalizeVector
      : (source, fallback) => cloneVector(source || fallback);
  const resolveStargatePhysicalRadius =
    typeof deps.resolveStargatePhysicalRadius === "function"
      ? deps.resolveStargatePhysicalRadius
      : () => 0;
  const scaleVector =
    typeof deps.scaleVector === "function"
      ? deps.scaleVector
      : (vector, scalar) => ({
          x: toFiniteNumber(vector && vector.x, 0) *
            toFiniteNumber(scalar, 0),
          y: toFiniteNumber(vector && vector.y, 0) *
            toFiniteNumber(scalar, 0),
          z: toFiniteNumber(vector && vector.z, 0) *
            toFiniteNumber(scalar, 0),
        });
  const subtractVectors =
    typeof deps.subtractVectors === "function"
      ? deps.subtractVectors
      : (left, right) => ({
          x: toFiniteNumber(left && left.x, 0) -
            toFiniteNumber(right && right.x, 0),
          y: toFiniteNumber(left && left.y, 0) -
            toFiniteNumber(right && right.y, 0),
          z: toFiniteNumber(left && left.z, 0) -
            toFiniteNumber(right && right.z, 0),
        });
  // A warp hands its landing the stream to draw from, its own (never the
  // server's shared stream, common/random's random()), as `options.random`.
  // This leaf requires nothing, so a call given none draws from deps.random,
  // else from Math.random, looked up at each draw.
  const defaultRandom = typeof deps.random === "function" ? deps.random : () => Math.random();
  const resolveRandom = (options) => (
    options && typeof options.random === "function" ? options.random : defaultRandom
  );
  const DEFAULT_RIGHT = cloneVector(deps.DEFAULT_RIGHT || { x: 1, y: 0, z: 0 });
  const MAX_STARGATE_JUMP_DISTANCE_METERS = Math.max(
    toFiniteNumber(deps.MAX_STARGATE_JUMP_DISTANCE_METERS, 2500),
    0,
  );
  const WARP_EXIT_VARIANCE_RADIUS_METERS = Math.max(
    toFiniteNumber(deps.WARP_EXIT_VARIANCE_RADIUS_METERS, 2500),
    0,
  );

  function getStationWarpTargetPosition(station) {
    return cloneVector(station && station.position);
  }

  function getRandomPointInSphere(radius, options = {}) {
    const random = resolveRandom(options);
    const maxRadius = Math.max(0, toFiniteNumber(radius, 0));
    if (maxRadius <= 0) {
      return { x: 0, y: 0, z: 0 };
    }

    const theta = random() * Math.PI * 2;
    const vertical = (random() * 2) - 1;
    const distanceScale = Math.cbrt(random());
    const radialDistance = maxRadius * distanceScale;
    const planarDistance =
      Math.sqrt(Math.max(0, 1 - (vertical * vertical))) * radialDistance;

    return {
      x: Math.cos(theta) * planarDistance,
      y: vertical * radialDistance,
      z: Math.sin(theta) * planarDistance,
    };
  }

  function getStargateWarpExitPoint(entity, stargate, minimumRange = 0) {
    const gateRadius = resolveStargatePhysicalRadius(stargate);
    const shipRadius = Math.max(0, toFiniteNumber(entity && entity.radius, 0));
    const minimumOffset = gateRadius + shipRadius + 500;
    const requestedRange = Math.max(
      minimumOffset,
      toFiniteNumber(minimumRange, 0),
    );
    const gatePosition = cloneVector(stargate && stargate.position);
    const fallbackDirection = normalizeVector(
      entity && entity.direction ? entity.direction : DEFAULT_RIGHT,
      DEFAULT_RIGHT,
    );
    const fromGateToShip = normalizeVector(
      subtractVectors(entity && entity.position, gatePosition),
      fallbackDirection,
    );

    return addVectors(
      gatePosition,
      scaleVector(fromGateToShip, requestedRange),
    );
  }

  function getStargateWarpExitEnvelopePoint(
    entity,
    stargate,
    minimumRange = 0,
  ) {
    const gateRadius = resolveStargatePhysicalRadius(stargate);
    const requestedRange = Math.max(0, toFiniteNumber(minimumRange, 0));
    const explicitSurfaceRange =
      requestedRange > MAX_STARGATE_JUMP_DISTANCE_METERS
        ? requestedRange
        : 0;
    const gatePosition = cloneVector(stargate && stargate.position);
    const fallbackDirection = normalizeVector(
      entity && entity.direction ? entity.direction : DEFAULT_RIGHT,
      DEFAULT_RIGHT,
    );
    const fromGateToShip = normalizeVector(
      subtractVectors(entity && entity.position, gatePosition),
      fallbackDirection,
    );

    return addVectors(
      gatePosition,
      scaleVector(fromGateToShip, gateRadius + explicitSurfaceRange),
    );
  }

  function getStargateWarpLandingPoint(entity, stargate, minimumRange = 0, options = {}) {
    const requestedClearance = Math.max(0, toFiniteNumber(minimumRange, 0));
    const scatterRadius =
      requestedClearance > MAX_STARGATE_JUMP_DISTANCE_METERS
        ? WARP_EXIT_VARIANCE_RADIUS_METERS
        : 0;
    return addVectors(
      getStargateWarpExitPoint(entity, stargate, minimumRange),
      getRandomPointInSphere(scatterRadius, options),
    );
  }

  function getRandomPointInHemisphere(radius, normal, options = {}) {
    const point = getRandomPointInSphere(radius, options);
    const hemisphereNormal = normalizeVector(normal, DEFAULT_RIGHT);
    const projection = dotProduct(point, hemisphereNormal);
    if (projection >= 0) {
      return point;
    }

    return subtractVectors(
      point,
      scaleVector(hemisphereNormal, projection * 2),
    );
  }

  // A warp's landing at a stargate. With `options.scatter` false:
  // the gate's surface point toward the ship (or the warp-at range beyond
  // it, past the 2,500 m jump range), stopped exactly there, with no scatter
  // of its own: the warp's jitter (warpCommands.js) is its one random
  // offset, so a warp to 0 lands within 2,500 m of the surface, in jump
  // range. Otherwise a scatter within 2,500 m on the ship's side, drawn
  // from `options.random`.
  function resolveStargateWarpTarget(entity, stargate, minimumRange = 0, options = {}) {
    if (options && options.scatter === false) {
      return {
        rawDestination: getStargateWarpExitEnvelopePoint(
          entity,
          stargate,
          Math.max(0, toFiniteNumber(minimumRange, 0)),
        ),
        stopDistance: 0,
      };
    }
    const random = resolveRandom(options);
    const requestedRange = Math.max(0, toFiniteNumber(minimumRange, 0));
    const nativeStopDistance = Math.max(
      1,
      random() * WARP_EXIT_VARIANCE_RADIUS_METERS,
    );
    const gatePosition = cloneVector(stargate && stargate.position);
    const fallbackDirection = normalizeVector(
      entity && entity.direction ? entity.direction : DEFAULT_RIGHT,
      DEFAULT_RIGHT,
    );
    const fromGateToShip = normalizeVector(
      subtractVectors(entity && entity.position, gatePosition),
      fallbackDirection,
    );
    const travelDirection = scaleVector(fromGateToShip, -1);
    const warpExitPoint = getStargateWarpExitEnvelopePoint(
      entity,
      stargate,
      requestedRange,
    );
    const landingPoint = addVectors(
      warpExitPoint,
      getRandomPointInHemisphere(
        WARP_EXIT_VARIANCE_RADIUS_METERS,
        fromGateToShip,
        { random },
      ),
    );

    return {
      rawDestination: addVectors(
        landingPoint,
        scaleVector(travelDirection, nativeStopDistance),
      ),
      stopDistance: nativeStopDistance,
    };
  }

  return {
    getRandomPointInHemisphere,
    getRandomPointInSphere,
    getStargateWarpExitEnvelopePoint,
    getStargateWarpExitPoint,
    getStargateWarpLandingPoint,
    getStationWarpTargetPosition,
    resolveStargateWarpTarget,
  };
}

module.exports = {
  createDestinyWarpTargetPlanner,
};
