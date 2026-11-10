"use strict";

// The Destiny tick driver: one per Solar system, handed the scene's sim time once
// per Gameplay tick, it says how many Destiny ticks are due under retail's
// tick clock rule (from Ballpark::OnTick,
// carbonengine/destiny v2.1.1 Ballpark.cpp:218-330):
//
// - one tick per whole second of sim time since the last one, the remainder
//   carried over, so ticks fall on whole seconds since the first;
// - up to five due ticks run back to back; past five, one runs and the rest
//   are dropped (the caller logs the resync warning), and the remainder goes;
// - the first tick of a scene is Evolve only, due on the first call;
// - a scene woken from a cold-scene sleep (Server's own: retail scenes never
//   sleep) is resynced first: the intervals it slept through are dropped
//   quietly, and the next advance runs one tick, on the same whole seconds.
//
// It owns the Destiny tick counter, seeded once from the sim clock and never
// read from a clock again: only completeEvolve() advances it, at the end of
// each Evolve, as retail's Evolve increments mCurrentTime. `destinyTick` is
// N, the last tick run; `nextDestinyStamp` is N + 1, the stamp of everything
// queued or sent until the next tick. Time Dilation needs nothing
// here: the scene's sim clock is already dilated.
//
// Pure: no clock, no logging, no scene.

const {
  toFiniteNumber,
} = require("../../common/numbers");
const {
  DESTINY_TICK_INTERVAL_MS,
} = require("../destiny/constants");

const MAX_CATCH_UP_TICKS = 5;

function createDestinyTickDriver(options = {}) {
  const seedSimTimeMs = Math.max(0, toFiniteNumber(options.seedSimTimeMs, 0));
  // Seeded so that the first tick, run at the scene's first Gameplay tick, is
  // numbered by the second of sim time the scene was created in. Retail's own
  // starting value is not known.
  let counter = Math.floor(seedSimTimeMs / DESTINY_TICK_INTERVAL_MS) - 1;
  let lastTickSimTimeMs = null;

  function advance(simTimeMs) {
    const now = Math.max(0, toFiniteNumber(simTimeMs, lastTickSimTimeMs ?? seedSimTimeMs));
    if (lastTickSimTimeMs === null) {
      lastTickSimTimeMs = now;
      return { due: 1, dropped: 0, evolveOnly: true, tickSimTimesMs: [now] };
    }
    const elapsedMs = now - lastTickSimTimeMs;
    const whole = elapsedMs >= DESTINY_TICK_INTERVAL_MS
      ? Math.floor(elapsedMs / DESTINY_TICK_INTERVAL_MS)
      : 0;
    if (whole === 0) {
      return { due: 0, dropped: 0, evolveOnly: false, tickSimTimesMs: [] };
    }
    if (whole > MAX_CATCH_UP_TICKS) {
      lastTickSimTimeMs = now;
      return { due: 1, dropped: whole - 1, evolveOnly: false, tickSimTimesMs: [now] };
    }
    const tickSimTimesMs = [];
    for (let i = 1; i <= whole; i += 1) {
      tickSimTimesMs.push(lastTickSimTimeMs + (i * DESTINY_TICK_INTERVAL_MS));
    }
    lastTickSimTimeMs = tickSimTimesMs[tickSimTimesMs.length - 1];
    return { due: whole, dropped: 0, evolveOnly: false, tickSimTimesMs };
  }

  // A wake from sleep at sim time `simTimeMs`: every whole interval since
  // the last tick but one is dropped, so the next advance runs one tick and
  // ticks keep falling on whole seconds since the first. Returns { dropped }.
  function resync(simTimeMs) {
    if (lastTickSimTimeMs === null) {
      return { dropped: 0 };
    }
    const now = Math.max(0, toFiniteNumber(simTimeMs, lastTickSimTimeMs));
    const whole = Math.floor((now - lastTickSimTimeMs) / DESTINY_TICK_INTERVAL_MS);
    if (whole <= 1) {
      return { dropped: 0 };
    }
    lastTickSimTimeMs += (whole - 1) * DESTINY_TICK_INTERVAL_MS;
    return { dropped: whole - 1 };
  }

  // The sim time Destiny tick `stamp` runs (or ran) at, by this driver's
  // phase: the last tick's sim time plus a second per tick between. Null
  // before the first tick.
  function simTimeOfTick(stamp) {
    if (lastTickSimTimeMs === null || !Number.isFinite(Number(stamp))) {
      return null;
    }
    return lastTickSimTimeMs + ((Number(stamp) - counter) * DESTINY_TICK_INTERVAL_MS);
  }

  function completeEvolve() {
    counter += 1;
    return counter;
  }

  return {
    advance,
    completeEvolve,
    resync,
    simTimeOfTick,
    get destinyTick() {
      return counter;
    },
    get nextDestinyStamp() {
      return counter + 1;
    },
    get lastTickSimTimeMs() {
      return lastTickSimTimeMs;
    },
  };
}

module.exports = {
  DESTINY_TICK_INTERVAL_MS,
  MAX_CATCH_UP_TICKS,
  createDestinyTickDriver,
};
