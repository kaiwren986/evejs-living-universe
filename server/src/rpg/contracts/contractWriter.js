"use strict";

// EveJS RPG fork: the contract writer.
//
// Turns the director's facts into a story: who is hiring, why, who the target
// is, what is said when it is over. Four small model calls (the cast, then one
// speech per speaker in that speaker's own voice) write every line the contract
// will ever need at offer time, so nothing waits on the AI during a fight. When
// the model is off or answers badly, written lines for the same contract are
// used instead; the contract itself never depends on the AI.
//
// A contract can come from a contact (contractContacts.js). The contact's name,
// role and voice are then fixed, and the model is given their shared history
// with the captain so the new job can follow from the old ones.

const path = require("path");

const llm = require(path.join(__dirname, "../llm/llmClient"));

const CAST_LIMITS = Object.freeze({
  title: 48, clientName: 36, clientRole: 60, clientVoice: 70, bossName: 36, bossEpithet: 40, siteName: 36, reason: 170,
});
// A contact already has a name, role and voice; only the rest is invented.
const CLIENT_FIELDS = Object.freeze(["clientName", "clientRole", "clientVoice"]);

function castSchema(fields) {
  return {
    type: "object",
    additionalProperties: false,
    required: fields,
    properties: Object.fromEntries(fields.map((field) => [field, { type: "string" }])),
  };
}

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

function writtenStory(facts, contact = null) {
  return {
    title: `${facts.factionShort} Bounty`,
    clientName: contact ? contact.name : "Port Security",
    clientRole: contact ? contact.role : `${facts.empireName} traffic control`,
    clientVoice: contact ? contact.voice : "",
    bossName: `${facts.factionShort} Captain`,
    bossEpithet: "wanted for piracy",
    siteName: `${facts.factionShort} Hideout`,
    reason: "The leader's crew has been raiding local traffic.",
    briefing: `${contact ? "Captain, I have more work for you. " : ""}A ${facts.factionName} crew has been raiding traffic out of ${facts.systemName}. ` +
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

function sharedHistory(contact) {
  if (!contact.history.length) return "You have not worked with the captain before.";
  return "Your history with the captain, oldest first:\n" + contact.history.map((line) => `- ${line}`).join("\n");
}

// Who a speaker is. For a contact this carries their history and trust, so
// every line they say (briefing, debrief, a hail) comes from the same person.
function personaPrompt(contact, pilotName) {
  const voice = contact.voice ? ` You speak in a way that is ${contact.voice}.` : "";
  const known = contact.tierLabel
    ? ` You already know Captain ${pilotName}: do not introduce yourself. Where you stand with them: ${contact.tierLabel.toLowerCase()}` +
      ` (${contact.jobsCompleted} job${contact.jobsCompleted === 1 ? "" : "s"} done for you` +
      `${contact.jobsAbandoned ? `, ${contact.jobsAbandoned} abandoned` : ""}).\n${sharedHistory(contact)}\n`
    : "";
  return `You are ${contact.name}, ${contact.role}.${voice}${known} ${WORLD} ` +
    "Speak only your own words, in first person, as if over a comms channel.";
}

async function writeCast(facts, history, contact) {
  const fields = Object.keys(CAST_LIMITS).filter((field) => !contact || !CLIENT_FIELDS.includes(field));
  const past = contact
    ? `The client is fixed: ${contact.name}, ${contact.role}. ${sharedHistory(contact).replace(/^Your history with the captain/, "Their history with the captain").replace(/^You have not/, "They have not")}\n` +
      "The new job should make sense coming from this person, and may follow from an earlier one."
    : history.length
      ? "The captain's earlier jobs for other people, oldest first (for flavour; this client is someone new):\n" +
        history.map((line) => `- ${line}`).join("\n")
      : "This is the captain's first contract.";
  const invent = [
    contact ? null : "- clientName: the person hiring the captain. A first and last name fitting New Eden. A person, not an organisation.",
    contact ? null : "- clientRole: that person's job and employer, a few words (for example a dock foreman, a widowed hauler, an insurance adjuster).",
    contact ? null : "- clientVoice: how that person talks, a short phrase (for example: clipped and formal; tired, with dry humour; fast and nervous).",
    "- bossName: the pirate leader's own first and last name. A new person: not the captain, not the client.",
    "- bossEpithet: the leader's nickname, two or three words.",
    "- siteName: what the pirates call their hideout, two to four words, no planet names.",
    "- reason: one sentence, the personal reason the client wants this leader dead.",
    "- title: a contract title of two to four words, no numbers.",
  ].filter(Boolean).join("\n");
  const reply = await llm.chatJson([
    { role: "system", content: `You invent the cast for a bounty contract in a space game. ${WORLD}` },
    { role: "user", content: `Facts (fixed, do not change them):\n${factSheet(facts)}\n\n${past}\n\nInvent:\n${invent}` },
  ], "contract_cast", castSchema(fields), { maxTokens: 280, temperature: 1.0 });
  if (!reply) return null;
  const cast = {};
  for (const field of fields) cast[field] = clip(reply[field], CAST_LIMITS[field]);
  if (contact) Object.assign(cast, { clientName: contact.name, clientRole: contact.role, clientVoice: contact.voice });
  cast.bossName = clip(cast.bossName.replace(/\s*\([^)]*\)\s*/g, " "), CAST_LIMITS.bossName);
  cast.reason = sentences(cast.reason, 1, CAST_LIMITS.reason);
  const pilotWords = String(facts.pilotName || "").toLowerCase().split(/\s+/).filter((word) => word.length > 2);
  if (!contact && !isPersonName(cast.clientName, pilotWords)) return null;
  if (!isPersonName(cast.bossName, [...pilotWords, cast.clientName.toLowerCase()])) return null;
  // clientVoice is flavour: an empty one is fine, every other field is required.
  return Object.entries(cast).every(([field, value]) => field === "clientVoice" || Boolean(value)) ? cast : null;
}

function speak(system, instruction, maxSentences, limit) {
  return llm.chat([
    { role: "system", content: system },
    { role: "user", content: instruction },
  ], { maxTokens: 190, temperature: 0.9 }).then((text) => (text ? sentences(text, maxSentences, limit) : ""));
}

/**
 * Write the story for a planned contract.
 * @param {object} facts          the director's plan plus pilotName and shipName
 * @param {string[]} history      one-line memories of earlier contracts, oldest first
 * @param {object|null} contact   contractContacts.persona() when a contact is hiring
 */
async function writeStory(facts, history = [], contact = null) {
  const fallback = writtenStory(facts, contact);
  const cast = await writeCast(facts, history, contact);
  if (!cast) return fallback;

  const client = personaPrompt(contact || { name: cast.clientName, role: cast.clientRole, voice: cast.clientVoice, history: [] }, facts.pilotName);
  const sheet = `${factSheet(facts)}\n- Pirate leader: ${cast.bossName}, called "${cast.bossEpithet}"\n- Why you want them dead: ${cast.reason}`;
  const briefing = await speak(client,
    `You are hiring Captain ${facts.pilotName} to kill a pirate leader. Facts:\n${sheet}\n\n` +
    "Brief the captain: what happened, why it matters to you, what you want done. Name the leader and the system. " +
    `${contact ? "Refer to your shared history where it is natural. " : ""}Do not mention payment amounts. At most four sentences.`, 4, 560);
  const taunt = await speak(
    `You are ${cast.bossName}, "${cast.bossEpithet}", a ${facts.factionName} pirate leader commanding a ${facts.bossHull} at your hideout, ${cast.siteName}. ` +
    `${WORLD} Speak only your own words, in first person, as if over a comms channel.`,
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

module.exports = { writeStory, writtenStory, memoryLine, personaPrompt, sentences };
