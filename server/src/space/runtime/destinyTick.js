"use strict";

// The Destiny tick body. The scene runs it at the top of its Gameplay tick, right
// after the sim clock advances and before any gameplay, as many times as its
// Destiny tick driver (destinyTickDriver.js) says are due. Each tick is, as
// retail's Ballpark::OnTick runs it (carbonengine/destiny v2.1.1
// Ballpark.cpp:218-330):
//
//   doPreTick   stop the followers of a Ball in another Grid bubble; the
//               align gate (a warp's scramble and sphere checks); apply
//               the one stamped action list's Ballpark actions in call order,
//               its updates held (scene/movementQueue.js,
//               scene/destinyHistory.js); the Grid bubble update
//               (each bubble's entered and left lists from the marks, a diff
//               for an Observer whose bubble changed, then the commit;
//               scene/visibility.js); then route the held updates in call
//               order, each to its Ball's Grid bubble history or to one
//               Observer's character history by the memberships the update
//               left, and build the SetStates asked for since the last tick
//               (each at the front of its Observer's character history)
//   evolve      move every Ball over exactly 1 s, three passes over two slots
//               (runtime/scene/evolve.js); the counter advances at
//               its end, so `destinyTick` becomes this tick's number N
//   doPostTick  send what the tick routed, stamped N: one batch per Grid
//               bubble with a history, shared by its Observers, and one per
//               Observer with a character history. Nothing else
//               sends a Destiny update.
//
// The first tick of a scene is Evolve only. Past five due ticks, one runs and
// the rest are dropped with retail's resync warning. A scene the runtime let
// sleep (a cold scene, npcSceneActivity.js; retail scenes never sleep) is
// noted asleep, and on its wake the driver is resynced first: the ticks it
// slept through are dropped, and one runs. The warning is
// for a stall, not a sleep. Between ticks, nothing
// moves a Ball: gameplay reads them as the last Evolve left them and
// queues its changes for the next tick, which carries `nextDestinyStamp`.
//
// The scene supplies each phase's work: applyDestinyTickQueue(frame),
// updateGridBubbles(frame) and routeDestinyTickQueue(frame),
// evolveDestinyTick(frame), and sendDestinyTickOutput(frame).
//
// doPreTick runs in retail's order (_ticker.py:59-131): the
// list applies, then the bubble update reads every +1/-1 mark, those an
// applied action wrote (a teleport's re-box, a cloak that takes its Ball out
// of the lists) included, then the updates are routed. Server builds an
// action's updates as it applies it; they are held until the update has run,
// so every one is routed by the memberships it left, and the entries and
// exits it builds stay ahead of them in each character history. The
// send phase is the doPostTick function below, which the contract tests'
// emission ledger names (doPostTick@space/runtime/destinyTick).

const path = require("path");
const log = require(path.join(__dirname, "../../utils/logger"));
const {
  DESTINY_TICK_INTERVAL_MS,
} = require("./destinyTickDriver");

// What one Destiny tick hands the Gameplay tick after it: the belt rats a
// warp landing wakes. Everything it sends is in the histories.
function createDestinyTickOutput() {
  return {
    beltRatArrivalEvents: [],
  };
}

function createDestinyTickFrame(scene, tickSimTimeMs, evolveOnly) {
  return {
    // The number this tick gets: N + 1 while it runs, `destinyTick` after its
    // Evolve.
    stamp: scene.destinyTickDriver.nextDestinyStamp,
    evolveOnly,
    // Evolve always covers exactly one tick, ending at this tick's sim time.
    deltaSeconds: DESTINY_TICK_INTERVAL_MS / 1000,
    startSimTimeMs: tickSimTimeMs - DESTINY_TICK_INTERVAL_MS,
    simTimeMs: tickSimTimeMs,
    // An Evolve-only tick has no doPostTick: what it produces joins the
    // next tick's output (getDestinyTickOutput).
    output: evolveOnly ? null : createDestinyTickOutput(),
  };
}

function doPreTick(scene, frame) {
  // clean_up_followers: a Ball following one in another Grid bubble
  // stops, its Stop applying with the rest of the queue.
  if (typeof scene.cleanUpDestinyFollowers === "function") {
    scene.cleanUpDestinyFollowers();
  }
  // A drone whose controller left its Grid bubble stops and disconnects: its
  // controller has lost control of it (Server's choice).
  if (typeof scene.stopDronesOfDepartedControllers === "function") {
    scene.stopDronesOfDepartedControllers();
  }
  // The align gate: a ship aligning for warp is
  // stopped by a scramble or a sphere, by changes queued here that apply with
  // the queue below, before this tick's Evolve.
  if (typeof scene.gateAligningWarps === "function") {
    scene.gateAligningWarps();
  }
  scene.applyDestinyTickQueue(frame);
  scene.updateGridBubbles(frame);
  scene.routeDestinyTickQueue(frame);
}

// The counter advances even when Evolve throws: its passes may already have
// swapped the slots, and the driver has used the sim second, so a tick left
// unnumbered would leave every later stamp one behind sim time for good.
function evolve(scene, frame) {
  try {
    scene.evolveDestinyTick(frame);
  } finally {
    scene.destinyTickDriver.completeEvolve();
  }
}

function doPostTick(scene, frame) {
  scene.sendDestinyTickOutput(frame);
}

// A phase that throws is logged at error with its scene and tick, and the
// tick goes on to its next phase: Evolve runs gameplay (a missile
// hit's damage and destruction, a warp's landing and start), and one bug
// there must never stop the scene's clock or reach the process. Evolve
// contains its own hooks per Ball, so a throw that gets here is rarer.
function runDestinyTickPhase(scene, frame, name, run) {
  try {
    run(scene, frame);
  } catch (error) {
    log.error(
      `[SpaceRuntime] system=${scene.systemID}: Destiny tick ${frame.stamp} ${name} failed, ` +
      `the tick goes on: ${error && error.stack ? error.stack : error}`,
    );
  }
}

// BringOutTheDeads at the top of every Destiny tick, as retail's OnTick runs
// it: under catch-up, a Ball made moribund in tick k's Evolve
// is removed before tick k+1's doPreTick, not only after the whole batch.
// The Gameplay tick still sweeps after the batch, so gameplay never reads a
// moribund Ball.
function bringOutTheDeads(scene) {
  if (typeof scene.bringOutTheDeads === "function") {
    scene.bringOutTheDeads();
  }
}

function runDestinyTick(scene, frame) {
  scene._destinyTickFrame = frame;
  try {
    runDestinyTickPhase(scene, frame, "bringOutTheDeads", bringOutTheDeads);
    if (!frame.evolveOnly) {
      runDestinyTickPhase(scene, frame, "doPreTick", doPreTick);
    }
    runDestinyTickPhase(scene, frame, "evolve", evolve);
    if (!frame.evolveOnly) {
      runDestinyTickPhase(scene, frame, "doPostTick", doPostTick);
    }
  } finally {
    scene._destinyTickFrame = null;
  }
}

// The runtime skipped a Gameplay tick of `scene` (a cold scene asleep): its
// next run is a wake.
function noteSceneAsleep(scene) {
  if (scene) {
    scene._destinyTickAsleep = true;
  }
}

// Runs every Destiny tick due at the scene's sim time `simNowMs`. Returns the
// frames of the ticks run, in order.
function runDueDestinyTicks(scene, simNowMs) {
  const driver = scene.destinyTickDriver;
  if (scene._destinyTickAsleep === true) {
    scene._destinyTickAsleep = false;
    driver.resync(simNowMs);
  }
  const due = driver.advance(simNowMs);
  if (due.dropped > 0) {
    log.warn(
      `[SpaceRuntime] system=${scene.systemID}: ${due.due + due.dropped} time intervals in batch: resynching ` +
      `(Destiny tick ${driver.nextDestinyStamp} runs, ${due.dropped} dropped)`,
    );
  }
  const frames = [];
  for (const tickSimTimeMs of due.tickSimTimesMs) {
    const frame = createDestinyTickFrame(scene, tickSimTimeMs, due.evolveOnly);
    runDestinyTick(scene, frame);
    frames.push(frame);
  }
  return frames;
}

module.exports = {
  createDestinyTickOutput,
  noteSceneAsleep,
  runDueDestinyTicks,
};
