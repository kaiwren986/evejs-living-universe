"use strict";

// EveJS RPG fork: checks the pilot voices (server/src/rpg/pilots/pilotVoices.js)
// with a stand-in for the model. Run against a copy of the game store.
//
//   node scripts/verifyPilotVoices.js          stand-in model, asserts behaviour
//   node scripts/verifyPilotVoices.js --live   the real local model: prints what
//                                              pilots say, asserts nothing about wording

process.env.EVEJS_SKIP_NPC_STARTUP = "1";
process.env.EVEJS_LIVING_UNIVERSE_ENABLED = "true";
process.env.EVEJS_LIVING_ECONOMY_ENABLED = "false";
process.env.EVEJS_LIVING_CONFLICT_ENABLED = "false";

const assert = require("assert/strict");

const spaceRuntime = require("../src/space/runtime");
const livingUniverseRuntime = require("../src/space/npc/ambientTraffic/livingUniverseRuntime");
const pilotDirectory = require("../src/space/npc/ambientTraffic/livingUniversePilotDirectory");
const chatRuntime = require("../src/_secondary/chat/chatRuntime");
const llmClient = require("../src/rpg/llm/llmClient");
const pilotVoices = require("../src/rpg/pilots/pilotVoices");

const JITA = 30000142;
const PLAYER_ID = 140000005;
const LIVE = process.argv.includes("--live");

function playerEvent(message) {
  return {
    solarSystemID: JITA,
    authorCharacterID: PLAYER_ID,
    message,
    entry: { characterName: "Test Capsuleer", message },
  };
}

async function main() {
  let now = Date.now();
  for (let index = 0; index < 30; index += 1) {
    livingUniverseRuntime.tick(spaceRuntime, now);
    now += 1000;
  }
  const pilots = pilotDirectory.listPilotsForSystem(JITA).filter((pilot) => pilot.localVisible !== false);
  assert.ok(pilots.length > 5, "Jita needs pilots in Local for this check");

  const voices = pilotVoices._testing;
  voices.reset();
  const calls = [];
  const posted = [];
  chatRuntime.on("synthetic-local-message", (event) => {
    posted.push({ name: event.entry.characterName, message: event.message, characterID: event.authorCharacterID });
  });
  const fastConfig = {
    enabled: true,
    pilotVoices: { typingBaseMs: 0, typingPerCharMs: 0, typingJitterMs: 0, replyChance: 1, secondReplyChance: 0 },
  };

  if (LIVE) {
    voices.setLlm({ chat: llmClient.chat, loadConfig: () => ({ ...llmClient.loadConfig(), ...fastConfig }) });
    const target = pilots[0];
    const lines = [
      "anyone know if the gate to Perimeter is camped?",
      `${target.characterName.split(" ")[0]}, what are you hauling today?`,
      `${target.characterName.split(" ")[0]}, do you remember what I asked you a moment ago?`,
    ];
    for (const line of lines) {
      const spoken = await voices.handleLocalMessage(playerEvent(line));
      console.log(`\n> ${line}`);
      for (const reply of spoken) console.log(`  ${reply.name}: ${reply.line}`);
      if (!spoken.length) console.log("  (nobody answered)");
    }
    const ambient = [];
    for (let index = 0; index < 3; index += 1) {
      const before = posted.length;
      await voices.ambientLine(JITA, voices.settings());
      ambient.push(posted[before] || null);
    }
    console.log("\nUnprompted:");
    for (const line of ambient) console.log(line ? `  ${line.name}: ${line.message}` : "  (silent)");
    console.log(`\n${JSON.stringify(pilotVoices.getStatus())}`);
    return;
  }

  let nextReply = "busy day, margins are thin as ever";
  voices.setLlm({
    loadConfig: () => fastConfig,
    chat: async (messages, options) => {
      calls.push({ messages, options });
      return nextReply;
    },
  });
  voices.setRandom(() => 0.5);

  // 1. An unaddressed line gets one answer, in character, posted to Local.
  let spoken = await voices.handleLocalMessage(playerEvent("quiet in here today"));
  assert.equal(spoken.length, 1);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].message, "busy day, margins are thin as ever");
  const firstSpeaker = pilots.find((pilot) => pilot.characterID === posted[0].characterID);
  assert.ok(firstSpeaker, "the speaker must be a pilot in Jita Local");
  const persona = calls[0].messages[0].content;
  assert.ok(persona.includes(firstSpeaker.characterName));
  assert.ok(persona.includes("Jita"));
  assert.ok(persona.includes(firstSpeaker.homeStationName));
  assert.ok(calls[0].messages[1].content.includes("quiet in here today"));

  // 2. A pilot the player names is the one who answers, and it remembers the last exchange.
  const named = pilots.find((pilot) => (
    pilot.characterID !== firstSpeaker.characterID &&
    pilot.characterName.split(" ")[0].length >= 4
  ));
  nextReply = `${named.characterName}: "heading for the gate, no time to chat"`;
  spoken = await voices.handleLocalMessage(playerEvent(`hey ${named.characterName.split(" ")[0]}, where are you off to?`));
  assert.equal(spoken.length, 1);
  assert.equal(posted[1].characterID, named.characterID);
  assert.equal(posted[1].message, "heading for the gate, no time to chat", "name prefix and quotes are stripped");
  nextReply = "told you, the gate";
  await voices.handleLocalMessage(playerEvent(`${named.characterName}, say that again?`));
  const followUp = calls[calls.length - 1].messages[1].content;
  assert.ok(followUp.includes("You have talked with Test Capsuleer before"));
  assert.ok(followUp.includes("where are you off to?"));
  assert.ok(followUp.includes("quiet in here today"), "recent Local history is given to the model");

  // 3. Silence when the model is off, answers nothing useful, or breaks character.
  const before = posted.length;
  for (const bad of [null, "", "...", "As an AI language model I cannot do that."]) {
    nextReply = bad;
    spoken = await voices.handleLocalMessage(playerEvent("anyone there?"));
    assert.equal(spoken.length, 0);
  }
  assert.equal(posted.length, before);

  // 4. Pilots do not answer each other, and slash commands are ignored.
  const callsBefore = calls.length;
  nextReply = "should not be used";
  await voices.handleLocalMessage({ ...playerEvent("hello"), syntheticNpcPilot: true });
  await voices.handleLocalMessage(playerEvent("/population status"));
  assert.equal(calls.length, callsBefore);

  // 5. Unprompted line, and the per-system limit of lines per minute.
  nextReply = "third run today and the dock crew is still on break";
  const ambient = await voices.ambientLine(JITA, voices.settings());
  assert.equal(ambient, nextReply);
  let accepted = 0;
  for (let index = 0; index < 12; index += 1) {
    if (await voices.ambientLine(JITA, voices.settings())) accepted += 1;
  }
  assert.ok(posted.length <= 6, `at most 6 lines a minute per system, saw ${posted.length}`);
  assert.ok(accepted < 12);

  // 6. The tick only schedules chatter for systems with a player in them.
  voices.reset();
  const scene = spaceRuntime.ensureScene(JITA);
  pilotVoices.tick(spaceRuntime, now);
  assert.equal(pilotVoices.getStatus().systemsTracked, 0);
  scene.sessions.set("pilot-voices-check", { characterID: PLAYER_ID, _space: { systemID: JITA, shipID: 0 } });
  pilotVoices.tick(spaceRuntime, now + 6_000);
  assert.equal(pilotVoices.getStatus().systemsTracked, 1);
  scene.sessions.delete("pilot-voices-check");
  pilotVoices.tick(spaceRuntime, now + 12_000);
  assert.equal(pilotVoices.getStatus().systemsTracked, 0);

  console.log(JSON.stringify({
    success: true,
    pilotsInJitaLocal: pilots.length,
    modelCalls: calls.length,
    linesPosted: posted.length,
    sampleSpeaker: firstSpeaker.characterName,
  }, null, 2));
}

main().then(
  () => setTimeout(() => process.exit(0), 500),
  (error) => {
    console.error(error && error.stack || error);
    setTimeout(() => process.exit(1), 500);
  },
);
