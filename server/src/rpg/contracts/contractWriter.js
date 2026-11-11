"use strict";

// EveJS RPG fork: the contract writer.
//
// Turns the director's facts into a story: who is hiring, why, who the target
// is, what is said when it is over. Four small model calls (the cast, then one
// speech per speaker in that speaker's own voice) write every line the contract
// will ever need at offer time, so nothing waits on the AI during a fight. When
// the model is off or answers badly, written lines for the same contract are
// used instead; the contract itself never depends on the AI.

const path = require("path");

const llm = require(path.join(__dirname, "../llm/llmClient"));

const CAST_LIMITS = Object.freeze({
  title: 48, clientName: 36, clientRole: 60, bossName: 36, bossEpithet: 40, siteName: 36, reason: 170,
});

const CAST_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: Object.keys(CAST_LIMITS),
  properties: Object.fromEntries(Object.keys(CAST_LIMITS).map((field) => [field, { type: "string" }])),
});

const WORLD =
  "Setting: EVE Online's New Eden. Tone: grounded, working-class, a little noir. Real people with small " +
  "personal stakes, not galaxy-ending threats. Plain text only: no markdown, no lists, no stage directions.";

function clip(value, limit) {
  const text = String(value ?? "").replace(/[<>*_#]/g, "").replace(/\s+/g, " ").trim().replace(/^["“]|["”]$/g, "");
  return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;
}

function sentences(value, count, limit) {
  const text = clip(value, 2000);
  const parts = (text.match(/[^.!?]+[.!?]+["”']?|[^.!?]+$/g) || []).map((part) => part.trim()).filter(Boolean);
  // Whole sentences only: stop before the one that would overflow instead of cutting it.
  let result = "";
  for (const part of parts.slice(0, count)) {
    if (result && result.length + part.length + 1 > limit) break;
    result = result ? `${result} ${part}` : part;
  }
  return clip(result, limit);
}

function isPersonName(name, forbidden) {
  const lower = String(name || "").toLowerCase();
  if (!lower || /\b(corp|corporation|logistics|authority|security|inc|ltd|navy|command|control|captain|pilot|leader|guristas|angel|serpentis|sansha|blood)\b/.test(lower)) return false;
  return !forbidden.some((word) => word && lower.includes(word));
}

function writtenStory(facts) {
  return {
    title: `${facts.factionShort} Bounty`,
    clientName: "Port Security",
    clientRole: `${facts.empireName} traffic control`,
    bossName: `${facts.factionShort} Captain`,
    bossEpithet: "wanted for piracy",
    siteName: `${facts.factionShort} Hideout`,
    reason: "The leader's crew has been raiding local traffic.",
    briefing: `A ${facts.factionName} crew has been raiding traffic out of ${facts.systemName}. ` +
      `Their leader is holed up near ${facts.anchorName || "the outer planets"} with about ${facts.hostileCount} ships. ` +
      "Remove the leader and the rest will scatter. Payment on confirmation of the kill.",
    taunt: "You picked the wrong pocket of space, capsuleer.",
    debrief: "Kill confirmed. The lanes are quieter already. Your payment has been transferred.",
    source: "written",
  };
}

function factSheet(facts) {
  return `- Captain being hired: ${facts.pilotName}, flying ${facts.shipName}\n` +
    `- Hired in: ${facts.originSystemName}\n` +
    `- Target: a hideout near ${facts.anchorName || "the outer planets"} in ${facts.systemName} ` +
    `(${facts.empireName} space, ${facts.jumps === 0 ? "this system" : `${facts.jumps} jump${facts.jumps === 1 ? "" : "s"} away`})\n` +
    `- Pirates: ${facts.factionName}, about ${facts.hostileCount} ships, led from a ${facts.bossHull}\n` +
    "- Job: kill the pirate leader";
}

async function writeCast(facts, history) {
  const past = history.length
    ? "The captain's earlier jobs, oldest first. You may bring back an earlier client or build on what happened, or start fresh:\n" +
      history.map((line) => `- ${line}`).join("\n")
    : "This is the captain's first contract.";
  const reply = await llm.chatJson([
    { role: "system", content: `You invent the cast for a bounty contract in a space game. ${WORLD}` },
    { role: "user", content:
      `Facts (fixed, do not change them):\n${factSheet(facts)}\n\n${past}\n\n` +
      "Invent:\n" +
      "- clientName: the person hiring the captain. A first and last name fitting New Eden. A person, not an organisation.\n" +
      "- clientRole: that person's job and employer, a few words (for example a dock foreman, a widowed hauler, an insurance adjuster).\n" +
      "- bossName: the pirate leader's own first and last name. A new person: not the captain, not the client.\n" +
      "- bossEpithet: the leader's nickname, two or three words.\n" +
      "- siteName: what the pirates call their hideout, two to four words, no planet names.\n" +
      "- reason: one sentence, the personal reason the client wants this leader dead.\n" +
      "- title: a contract title of two to four words, no numbers." },
  ], "contract_cast", CAST_SCHEMA, { maxTokens: 260, temperature: 1.0 });
  if (!reply) return null;
  const cast = {};
  for (const [field, limit] of Object.entries(CAST_LIMITS)) cast[field] = clip(reply[field], limit);
  cast.bossName = clip(cast.bossName.replace(/\s*\([^)]*\)\s*/g, " "), CAST_LIMITS.bossName);
  cast.reason = sentences(cast.reason, 1, CAST_LIMITS.reason);
  const pilotWords = String(facts.pilotName || "").toLowerCase().split(/\s+/).filter((word) => word.length > 2);
  if (!isPersonName(cast.clientName, pilotWords)) return null;
  if (!isPersonName(cast.bossName, [...pilotWords, cast.clientName.toLowerCase()])) return null;
  return Object.values(cast).every(Boolean) ? cast : null;
}

function speak(persona, instruction, maxSentences, limit) {
  return llm.chat([
    { role: "system", content: `${persona} ${WORLD} Speak only your own words, in first person, as if over a comms channel.` },
    { role: "user", content: instruction },
  ], { maxTokens: 190, temperature: 0.9 }).then((text) => (text ? sentences(text, maxSentences, limit) : ""));
}

/**
 * Write the story for a planned contract.
 * @param {object} facts     the director's plan plus pilotName and shipName
 * @param {string[]} history one-line memories of earlier contracts, oldest first
 */
async function writeStory(facts, history = []) {
  const fallback = writtenStory(facts);
  const cast = await writeCast(facts, history);
  if (!cast) return fallback;

  const client = `You are ${cast.clientName}, ${cast.clientRole}.`;
  const sheet = `${factSheet(facts)}\n- Pirate leader: ${cast.bossName}, called "${cast.bossEpithet}"\n- Why you want them dead: ${cast.reason}`;
  const briefing = await speak(client,
    `You are hiring Captain ${facts.pilotName} to kill a pirate leader. Facts:\n${sheet}\n\n` +
    "Brief the captain: what happened, why it matters to you, what you want done. Name the leader and the system. " +
    "Do not mention payment amounts. At most four sentences.", 4, 560);
  const taunt = await speak(
    `You are ${cast.bossName}, "${cast.bossEpithet}", a ${facts.factionName} pirate leader commanding a ${facts.bossHull} at your hideout, ${cast.siteName}.`,
    `Captain ${facts.pilotName} has just warped in, flying ${facts.shipName}, hired to kill you. ` +
    "Broadcast a threat or a sneer at them. One or two sentences.", 2, 200);
  const debrief = await speak(client,
    `Captain ${facts.pilotName} has just killed ${cast.bossName} for you in ${facts.systemName}. Facts:\n${sheet}\n\n` +
    "Tell the captain what this means to you and hint at what you might need next. Payment is already sent. At most three sentences.", 3, 400);

  return {
    ...cast,
    briefing: briefing || fallback.briefing,
    taunt: taunt || fallback.taunt,
    debrief: debrief || fallback.debrief,
    source: "ai",
  };
}

// The line a later contract may build on. Written by the server from facts, never by the model.
function memoryLine(facts, story, outcome) {
  const who = `${story.clientName} (${story.clientRole})`;
  if (outcome === "completed") {
    return `"${story.title}": for ${who}, killed ${facts.factionName} leader ${story.bossName} in ${facts.systemName}. ${story.reason}`;
  }
  return `"${story.title}": took a job from ${who} to kill ${facts.factionName} leader ${story.bossName} in ${facts.systemName}, then walked away from it.`;
}

module.exports = { writeStory, writtenStory, memoryLine };
