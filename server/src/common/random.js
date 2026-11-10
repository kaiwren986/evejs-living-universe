"use strict";

// One random source for the server, so a run can be replayed: give it a seed and the same draws
// come back in the same order. `random()` draws from the process-wide default. That default takes
// its seed from config (`randomSeed`); blank means a seed from the clock, which is normal play.
// The gameplay harness fixes the seed. `createRng(seed)` makes a separate generator for a system
// that needs its own stream, such as a placement roll that must not shift when unrelated code
// draws.
//
// Not for anything secret: use node:crypto for tokens and keys.

// FNV-1a, 32 bit: turns any seed text or number into the generator's starting state.
function hashSeed(seed) {
  let hash = 0x811c9dc5;
  const text = String(seed);
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

// mulberry32 from a 32-bit starting state: small, fast and repeatable. Returns a function that
// works like Math.random, with values in [0, 1). Use createRng unless a system already turns its
// seed into a state its own way and must keep making the draws it made before.
function mulberry32(startState) {
  let state = startState >>> 0;
  return function nextRandom() {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

// A generator for any seed text or number.
function createRng(seed) {
  return mulberry32(hashSeed(seed) || 1);
}

let defaultSeed = null;
let defaultRng = null;

function clockSeed() {
  return `clock:${Date.now()}:${process.pid}`;
}

function isBlankSeed(seed) {
  return seed === null || seed === undefined || String(seed).trim() === "";
}

// Seeds the process-wide default. Blank (null, undefined or "") seeds it from the clock. Returns
// the seed in use, so a run can log it and be replayed later.
function setRandomSeed(seed) {
  defaultSeed = isBlankSeed(seed) ? clockSeed() : String(seed).trim();
  defaultRng = createRng(defaultSeed);
  return defaultSeed;
}

function ensureDefault() {
  if (defaultRng === null) {
    // Read on first use, not at load: config must not load just because this module did.
    const config = require("../config");
    setRandomSeed(config.randomSeed);
  }
  return defaultRng;
}

// The seed the default is using, seeding it from config first if nothing has drawn yet.
function getRandomSeed() {
  ensureDefault();
  return defaultSeed;
}

// A draw from the process-wide default, in [0, 1), like Math.random().
function random() {
  return ensureDefault()();
}

// For tests: the default draws from `source` (a function like Math.random) until the returned
// function is called, which puts the previous default back. Tests that fix a sequence of draws
// hand the same function to Math.random and to this, so the draws keep their order whichever
// source the code under test uses.
function overrideRandomSource(source) {
  if (typeof source !== "function") {
    throw new TypeError("overrideRandomSource needs a function that returns a number in [0, 1)");
  }
  const previousSeed = defaultSeed;
  const previousRng = defaultRng;
  defaultSeed = "test-override";
  defaultRng = source;
  return function restoreRandomSource() {
    defaultSeed = previousSeed;
    defaultRng = previousRng;
  };
}

module.exports = {
  createRng,
  getRandomSeed,
  hashSeed,
  mulberry32,
  overrideRandomSource,
  random,
  setRandomSeed,
};
