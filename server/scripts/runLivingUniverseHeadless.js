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
  const report = {
    success: true,
    simulatedMinutes,
    ticks,
    wallMs: Math.round(wallMs),
    slowestTickMs: Math.round(slowestTickMs),
    actors: status.actors ?? status.actorCount ?? status.population,
    roles: status.roles,
    flights: status.flights ?? status.flightCount,
    phases: status.phases,
    materialized: status.materialized ?? status.physical,
    lastError: status.lastError ?? null,
    jitaLocalPilots: Array.isArray(jitaLocal) ? jitaLocal.length : jitaLocal,
    jitaLocalSample: Array.isArray(jitaLocal)
      ? jitaLocal.slice(0, 5).map((member) => (
          member && (member.characterName || member.name || member.characterID)
        ))
      : [],
    statusKeys: Object.keys(status),
  };
  console.log(JSON.stringify(report, null, 2));
  assert.ok(report.jitaLocalPilots > 0, "no Living Universe pilots in Jita Local");
}

try {
  main();
  // Console output through a pipe is asynchronous on Windows; let it drain.
  setTimeout(() => process.exit(0), 500);
} catch (error) {
  console.error(error && error.stack || error);
  setTimeout(() => process.exit(1), 500);
}
