"use strict";

// Living Universe port: headless acceptance run. Drives the pilot runtime for a
// stretch of simulated time with nobody logged in and reports what it did.
// Economy and conflict are forced off. Run it against a copy of the game store
// (see doc/LIVING_UNIVERSE_PORT.md), never the live one.
//
//   node scripts/runLivingUniverseHeadless.js [simulatedMinutes=10] [stepMs=1000]

process.env.EVEJS_SKIP_NPC_STARTUP = "1";
process.env.EVEJS_LIVING_UNIVERSE_ENABLED = "true";
process.env.EVEJS_LIVING_ECONOMY_ENABLED = "false";
process.env.EVEJS_LIVING_CONFLICT_ENABLED = "false";
process.env.EVEJS_LIVING_CONFLICT_CAMPAIGNS_ENABLED = "false";
process.env.EVEJS_LIVING_CONFLICT_ROAMING_ENABLED = "false";
process.env.EVEJS_LIVING_UNIVERSE_POPULATION_SIZE =
  process.env.EVEJS_LIVING_UNIVERSE_POPULATION_SIZE || "5000";

const assert = require("assert/strict");

const config = require("../src/config");
const spaceRuntime = require("../src/space/runtime");
const livingUniverseRuntime = require(
  "../src/space/npc/ambientTraffic/livingUniverseRuntime",
);
const chatRuntime = require("../src/_secondary/chat/chatRuntime");

const JITA_SYSTEM_ID = 30000142;

function main() {
  const simulatedMinutes = Math.max(1, Number(process.argv[2]) || 10);
  const stepMs = Math.max(100, Number(process.argv[3]) || 1000);
  assert.equal(config.livingUniverseEnabled, true);
  assert.equal(config.livingEconomyEnabled, false);
  assert.equal(config.livingConflictEnabled, false);

  const startedAtMs = Date.now();
  const endAtMs = startedAtMs + (simulatedMinutes * 60_000);
  let ticks = 0;
  let slowestTickMs = 0;
  const wallStartedAt = process.hrtime.bigint();
  for (let now = startedAtMs; now <= endAtMs; now += stepMs) {
    const tickStartedAt = process.hrtime.bigint();
    livingUniverseRuntime.tick(spaceRuntime, now);
    const tickMs = Number(process.hrtime.bigint() - tickStartedAt) / 1e6;
    slowestTickMs = Math.max(slowestTickMs, tickMs);
    ticks += 1;
  }
  const wallMs = Number(process.hrtime.bigint() - wallStartedAt) / 1e6;

  const status = livingUniverseRuntime.getStatus(endAtMs);
  const jitaLocal = chatRuntime.getSyntheticLocalMembers(JITA_SYSTEM_ID);

  // Second phase: someone is watching Jita. Flights that pass through must now
  // spawn as real hulls through the ordinary tick path. The scene itself is
  // not ticked here, so this proves spawning, not flying.
  const observedMinutes = 3;
  const observerKey = "living-universe-headless-observer";
  const jitaScene = spaceRuntime.ensureScene(JITA_SYSTEM_ID);
  jitaScene.sessions.set(observerKey, {
    characterID: 0,
    _space: { systemID: JITA_SYSTEM_ID, shipID: 0 },
  });
  let peakMaterializedShips = 0;
  const observedEndAtMs = endAtMs + (observedMinutes * 60_000);
  for (let now = endAtMs + stepMs; now <= observedEndAtMs; now += stepMs) {
    livingUniverseRuntime.tick(spaceRuntime, now);
    peakMaterializedShips = Math.max(
      peakMaterializedShips,
      Number(livingUniverseRuntime.getStatus(now).materializedShips) || 0,
    );
  }
  const observedStatus = livingUniverseRuntime.getStatus(observedEndAtMs);
  jitaScene.sessions.delete(observerKey);
  // With nobody watching, the next ticks fold the hulls back into the simulation.
  for (let now = observedEndAtMs + stepMs; now <= observedEndAtMs + 30_000; now += stepMs) {
    livingUniverseRuntime.tick(spaceRuntime, now);
  }
  const afterStatus = livingUniverseRuntime.getStatus(observedEndAtMs + 30_000);
  const report = {
    success: true,
    simulatedMinutes,
    ticks,
    wallMs: Math.round(wallMs),
    slowestTickMs: Math.round(slowestTickMs),
    actors: status.actorCount,
    roles: status.roles,
    flights: status.flightCount,
    phases: status.phases,
    observedJita: {
      simulatedMinutes: observedMinutes,
      peakMaterializedShips,
      materializations: observedStatus.metrics && observedStatus.metrics.materializations,
      shipsLeftAfterObserverGone: afterStatus.materializedShips,
    },
    jitaLocalPilots: Array.isArray(jitaLocal) ? jitaLocal.length : jitaLocal,
    jitaLocalSample: Array.isArray(jitaLocal)
      ? jitaLocal.slice(0, 5).map((member) => (
          member && (member.characterName || member.name || member.characterID)
        ))
      : [],
  };
  console.log(JSON.stringify(report, null, 2));
  assert.equal(report.actors, Number(process.env.EVEJS_LIVING_UNIVERSE_POPULATION_SIZE));
  assert.ok(Object.keys(report.roles || {}).length > 0, "actors have no roles");
  assert.ok(report.jitaLocalPilots > 0, "no Living Universe pilots in Jita Local");
  assert.ok(peakMaterializedShips > 0, "no ships spawned while Jita was observed");
}

try {
  main();
  // Console output through a pipe is asynchronous on Windows; let it drain.
  setTimeout(() => process.exit(0), 500);
} catch (error) {
  console.error(error && error.stack || error);
  setTimeout(() => process.exit(1), 500);
}
