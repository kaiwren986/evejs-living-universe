"use strict";

// Wire values from Carbon IDstConstants.h. Keep the public object keys aligned
// with the existing eve.js Destiny facade while the monolith is decomposed.
const BALL_MODE = Object.freeze({
  GOTO: 0,
  FOLLOW: 1,
  STOP: 2,
  WARP: 3,
  ORBIT: 4,
  MISSILE: 5,
  MUSHROOM: 6,
  BOID: 7,
  TROLL: 8,
  MINIBALL: 9,
  FIELD: 10,
  RIGID: 11,
  FORMATION: 12,
});

// These names and values intentionally match the current root destiny.js
// export. The mini-section bits describe stream sections; they do not enable
// any server-side geometry or response behavior.
const BALL_FLAG = Object.freeze({
  IS_FREE: 0x01,
  IS_GLOBAL: 0x02,
  IS_MASSIVE: 0x04,
  IS_INTERACTIVE: 0x08,
  IS_SPACEJUNK: 0x10,
  HAS_MINIBOXES: 0x20,
  HAS_MINIBALLS: 0x40,
  HAS_MINICAPSULES: 0x80,
});

// The Destiny tick's length: one Evolve covers exactly this much sim time,
// and the driver runs one tick per this much. runtime/destinyTickDriver.js and
// simulation/evolve.js read it from here.
const DESTINY_TICK_INTERVAL_MS = 1000;
// Carbon Ballpark.cpp ORBITAL_PRECESSION. The value advances once per native
// Destiny behavior stamp and is used only to choose the deterministic legacy
// orbit plane.
const DESTINY_ORBITAL_PRECESSION_PER_TICK = 0.001;
const DESTINY_SPACE_FRICTION = 1_000_000;
// clientcodegrabber/latest/eve/client/script/environment/effects/WarpFlash.py
// waits for this acceleration before presenting the local warp-tunnel handoff.
const CLIENT_WARP_VISUAL_ACTIVATION_ACCELERATION_MS2 = 310_000;
// An Upwell structure that has finished unanchoring sits in space as its own
// free-ball kind rather than an ordinary jettison container.
const RUNTIME_UNANCHORED_STRUCTURE_HULL_KIND = "unanchoredStructureHull";
// A podded pilot leaves a corpse behind. The client renders groupBiomass as its
// own Corpse space object (clientcodegrabber/latest/eve/client/script/environment
// /spaceObject/repository.py) and offers Scoop to Cargo Hold rather than loot, so
// it is a free ball of its own kind instead of a wreck or a container.
const RUNTIME_CORPSE_KIND = "corpse";

module.exports = {
  BALL_FLAG,
  BALL_MODE,
  CLIENT_WARP_VISUAL_ACTIVATION_ACCELERATION_MS2,
  RUNTIME_CORPSE_KIND,
  RUNTIME_UNANCHORED_STRUCTURE_HULL_KIND,
  DESTINY_ORBITAL_PRECESSION_PER_TICK,
  DESTINY_SPACE_FRICTION,
  DESTINY_TICK_INTERVAL_MS,
};
