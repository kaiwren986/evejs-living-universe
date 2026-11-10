"use strict";

// A warp's jitter: retail never lands a warp exactly on its
// point. A warp to zero lands within 2,500 m, the client's warpJitterRadius
// (eve/common/lib/appConst.py L1547). The warp's destination is moved by a
// random offset inside that radius before its sphere test and its warp-at
// range, the order retail's NPC warp jitters in (AdjustDstByJitter,
// behaviors/entity.py L53-65; the player warp's is unshipped server code).
//
// Every warp draws from a stream of its own (createRng), never from the
// server's shared stream (common/random's random()), so a warp shifts no
// other system's draws under a fixed seed. Retail's generator is unshipped
// (AdjustDstByJitter has no body in the client).

const path = require("path");
const { createRng } = require(path.join(__dirname, "../../../common/random"));

const WARP_JITTER_RADIUS_METERS = 2_500;
// NPCWarpTo's default jitterRadius (behaviors/entity.py L53).
const NPC_WARP_JITTER_RADIUS_METERS = 20_000;

// A uniform point inside the ball of `radiusMeters`, from three draws of
// `random` (each in [0, 1)): the direction's height and angle, then the
// distance (the cube root keeps the ball uniform).
function jitterOffset(radiusMeters, random) {
  const radius = Math.max(0, Number(radiusMeters) || 0);
  const height = (2 * random()) - 1;
  const angle = 2 * Math.PI * random();
  const distance = radius * Math.cbrt(random());
  const ring = Math.sqrt(Math.max(0, 1 - (height * height)));
  return {
    x: distance * ring * Math.cos(angle),
    y: distance * ring * Math.sin(angle),
    z: distance * height,
  };
}

// The seed of a pilot warp's stream: the ship, the tick and the ship's order
// count, so two ships ordering in one tick, or one ship ordering twice, draw
// apart, and a replayed run draws the same.
function pilotWarpStreamSeed(shipID, simTimeMs, orderCount) {
  return `pilotWarp:${shipID}:${simTimeMs}:${orderCount}`;
}

// The seed of an NPC warp's stream. An NPC warps at most once in a tick.
function npcWarpStreamSeed(entityID, simTimeMs) {
  return `npcWarp:${entityID}:${simTimeMs}`;
}

// One warp's jitter, pilot or fleet: `next()` is the next offset (a fleet
// warp draws one per ship), `random` the stream itself (a stargate landing's
// scatter draws from it too). `seed` names the stream; `options.random`
// replaces it (tests); `options.radiusMeters` replaces the radius.
function createWarpJitter(seed, options = {}) {
  const random = typeof options.random === "function" ? options.random : createRng(seed);
  const radiusMeters = Number.isFinite(Number(options.radiusMeters))
    ? Number(options.radiusMeters)
    : WARP_JITTER_RADIUS_METERS;
  return {
    radiusMeters,
    random,
    next: () => jitterOffset(radiusMeters, random),
  };
}

module.exports = {
  NPC_WARP_JITTER_RADIUS_METERS,
  WARP_JITTER_RADIUS_METERS,
  createWarpJitter,
  jitterOffset,
  npcWarpStreamSeed,
  pilotWarpStreamSeed,
};
