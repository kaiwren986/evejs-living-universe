"use strict";

// EveJS RPG fork: Living Universe pilots talk in Local through the local model.
//
// Two things happen, both only in systems where a player is present:
//   - a player says something in Local and one or two pilots there answer;
//   - now and then a pilot says something unprompted about what it is doing.
//
// Each line is one model call through rpg/llm/llmClient (one request at a time,
// with a timeout). What a pilot knows comes from the mod: its record (name,
// corporation, faction, home station) and its flight (ship, route, phase). A
// pilot remembers the last few things it and a player said to each other.
//
// When the model is off, slow or answers badly the pilot says nothing. Nothing
// in the game waits on this module. Settings: "pilotVoices" in config/llm.json.

const path = require("path");

const log = require(path.join(__dirname, "../../utils/logger"));
const database = require(path.join(__dirname, "../../gameStore"));
const worldData = require(path.join(__dirname, "../../space/worldData"));
const pilotDirectory = require(path.join(
  __dirname,
  "../../space/npc/ambientTraffic/livingUniversePilotDirectory",
));
const llmClient = require(path.join(__dirname, "../llm/llmClient"));

const TABLE = "rpgPilotMemory";
const KEPT_EXCHANGES = 6;
const KEPT_HISTORY_LINES = 10;
const MAX_LINE_CHARS = 220;

const DEFAULTS = Object.freeze({
  enabled: true,
  // Replies to a player.
  replyChance: 0.85,            // an unaddressed line gets an answer this often
  secondReplyChance: 0.25,      // and a second pilot chimes in this often
  // Unprompted chatter, per system with a player in it.
  ambientEnabled: true,
  ambientFirstMinMs: 25_000,
  ambientFirstMaxMs: 70_000,
  ambientMinMs: 90_000,
  ambientMaxMs: 300_000,
  // Limits.
  maxLinesPerMinute: 6,         // per system
  maxPending: 3,                // model calls waiting or running, all systems
  // Typing delay before a line appears.
  typingBaseMs: 1_500,
  typingPerCharMs: 45,
  typingJitterMs: 2_500,
  maxTokens: 90,
  temperature: 0.9,
});

const TEMPERAMENTS = Object.freeze([
  "dry and deadpan", "cheerful", "tired after a long shift", "wary of strangers", "chatty",
  "terse", "proud of the job", "superstitious", "bored", "friendly but busy", "grumpy",
  "curious about everyone", "polite and formal", "sarcastic",
]);
const QUIRKS = Object.freeze([
  "complains about docking fees", "mentions family back home now and then", "follows ore and fuel prices closely",
  "distrusts capsuleers a little", "is saving up for a better ship", "likes to give unasked advice",
  "blames the stargates for everything", "talks about food a lot", "counts the days to shore leave",
  "has a rivalry with another pilot on the same run", "names every ship they fly", "never says more than needed",
  "is new to this route and a bit lost", "has flown this route for twenty years",
]);
const ROLE_NOTES = Object.freeze({
  shuttle: "You carry passengers and small parcels between stations.",
  hauler: "You haul freight for a living. Margins are thin and schedules are tight.",
  escort: "You fly escort for haulers. You watch the overview and say little about your charge.",
  police: "You fly a security patrol. You are formal, watchful, and do not discuss operations.",
  miner: "You mine for a living. You care about ore, yield and the state of the belts.",
  mining_support: "You command a mining crew from a support ship and look after your miners.",
  highsec_pirate: "You are an outlaw working the trade lanes. You are menacing but careful, and admit nothing.",
});

let started = false;
let chatRuntimeModule = null;
let llm = llmClient;
let randomSource = Math.random;
let pendingCalls = 0;
let nextAmbientCheckAtMs = 0;
const historyBySystemID = new Map();   // systemID -> [{name, text, atMs, characterID, synthetic}]
const postedAtBySystemID = new Map();  // systemID -> [atMs, ...] within the last minute
const nextAmbientAtBySystemID = new Map();
const metrics = { heard: 0, replies: 0, ambient: 0, silent: 0, dropped: 0 };

function settings() {
  const config = llm.loadConfig ? llm.loadConfig() : {};
  const section = config && typeof config.pilotVoices === "object" ? config.pilotVoices : {};
  return { ...DEFAULTS, ...section, enabled: config.enabled !== false && section.enabled !== false };
}

function chatRuntime() {
  if (!chatRuntimeModule) {
    chatRuntimeModule = require(path.join(__dirname, "../../_secondary/chat/chatRuntime"));
  }
  return chatRuntimeModule;
}

function livingRuntime() {
  return require(path.join(__dirname, "../../space/npc/ambientTraffic/livingUniverseRuntime"));
}

function between(minimum, maximum) {
  return minimum + (randomSource() * Math.max(0, maximum - minimum));
}

function pick(list, seed) {
  return list[Math.abs(Math.trunc(seed)) % list.length];
}

function systemName(systemID) {
  const system = worldData.getSolarSystemByID(Number(systemID));
  return system ? String(system.solarSystemName || systemID) : String(systemID);
}

function shipName(typeID) {
  try {
    const { resolveItemByTypeID } = require(path.join(
      __dirname,
      "../../services/inventory/itemTypeRegistry",
    ));
    const type = resolveItemByTypeID(Number(typeID));
    return type && type.name ? String(type.name) : "ship";
  } catch {
    return "ship";
  }
}

// ---------------------------------------------------------------- what a pilot knows

function describeActivity(activity, hereSystemID) {
  if (!activity) {
    return "You are passing through this system.";
  }
  const route = activity.routeSystemIDs || [];
  const first = route.length ? systemName(route[0]) : null;
  const last = route.length ? systemName(route[route.length - 1]) : null;
  const nextIndex = activity.currentNodeIndex + activity.direction;
  const next = route[nextIndex] ? systemName(route[nextIndex]) : null;
  const run = first && last && first !== last ? `the ${first} to ${last} run` : first ? `work around ${first}` : "your run";
  const resource = activity.resourceFamily || "ore";
  const wing = activity.wingSize > 1 ? ` with ${activity.wingSize - 1} other ship${activity.wingSize > 2 ? "s" : ""}` : "";
  switch (activity.phase) {
    case "docked":
    case "station_dwell":
      return `You are docked between trips on ${run}.`;
    case "virtual_departure":
    case "station_departure":
    case "aligning":
    case "warping_to_gate":
      return `You have just undocked${wing} and are heading for the gate${next ? ` to ${next}` : ""} on ${run}.`;
    case "virtual_transit":
    case "gate_arrival":
    case "gate_dwell":
      return `You are at a stargate${wing}, mid-way through ${run}${next ? `, next stop ${next}` : ""}.`;
    case "virtual_crossing":
    case "warping_across_system":
      return `You are crossing this system gate to gate${wing} on ${run}${next ? `, bound for ${next}` : ""}.`;
    case "virtual_station_approach":
    case "warping_to_station":
    case "returning_to_station":
    case "virtual_duty_return":
      return `You are on approach to dock${wing} after ${activity.routeKind === "duty" ? `a ${resource} shift` : `a leg of ${run}`}.`;
    case "virtual_duty_departure":
    case "warping_to_duty":
      return `You are heading out${wing} to ${activity.family === "miner" ? `mine ${resource}` : "your post"} in ${systemName(hereSystemID)}.`;
    case "duty":
    case "duty_live":
      return activity.family === "miner"
        ? `You are in a belt${wing} mining ${resource} in ${systemName(hereSystemID)}.`
        : `You are on station${wing} in ${systemName(hereSystemID)}.`;
    default:
      return `You are flying ${run}.`;
  }
}

function buildPersona(pilot, systemID) {
  let activity = null;
  try {
    activity = livingRuntime().getPilotActivity(pilot.actorID);
  } catch {
    activity = null;
  }
  const system = worldData.getSolarSystemByID(Number(systemID)) || {};
  const security = Number.isFinite(Number(system.security)) ? Number(system.security).toFixed(1) : "?";
  const role = String(pilot.role || (activity && activity.role) || "pilot");
  const lines = [
    `You are ${pilot.characterName}, ${String(pilot.title || "a working pilot").toLowerCase()} in EVE Online's New Eden.`,
    `You fly a ${shipName(activity && activity.shipTypeID)} for ${pilot.homeCorporationName || "your corporation"} (${pilot.homeFactionName || "independent"}).`,
    `Home port: ${pilot.homeStationName || "none"}.`,
    ROLE_NOTES[role] || "",
    describeActivity(activity, systemID),
    activity && activity.tripsCompleted > 0 ? `Trips completed lately: ${activity.tripsCompleted}.` : "",
    activity && activity.losses > 0 ? `You have lost ${activity.losses} ship${activity.losses > 1 ? "s" : ""} recently and it still stings.` : "",
    `Temperament: ${pick(TEMPERAMENTS, pilot.characterID)}. You are someone who ${pick(QUIRKS, pilot.characterID / 7)}.`,
    `You are typing in the Local chat channel of ${systemName(systemID)} (security ${security}).`,
    "Rules: write only the words you type into chat. One line, 25 words at most, casual pilot chatter. " +
      "No quotation marks, no emotes, no stage directions, no markdown, no name prefix. " +
      "You only know what a working pilot of your trade would know; if you do not know, say so or brush it off. " +
      "Never mention being an AI, a model or a game.",
  ];
  return lines.filter(Boolean).join("\n");
}

// ---------------------------------------------------------------- memory

let memoryTableReady = false;
function ensureMemoryTable() {
  if (!memoryTableReady) {
    database.ensureTable(TABLE);
    memoryTableReady = true;
  }
}

function readMemory(pilotID, playerID) {
  try {
    ensureMemoryTable();
    const row = database.read(TABLE, `/${pilotID}/${playerID}`);
    return row && row.success && row.data && Array.isArray(row.data.exchanges) ? row.data : null;
  } catch {
    return null;
  }
}

function remember(pilotID, playerID, playerName, heard, said, nowMs) {
  if (!(playerID > 0)) return;
  try {
    const previous = readMemory(pilotID, playerID);
    const exchanges = [...(previous ? previous.exchanges : []), { atMs: nowMs, heard, said }].slice(-KEPT_EXCHANGES);
    // One row per pilot, keyed by the players it has talked with.
    const row = database.read(TABLE, `/${pilotID}`);
    const record = row && row.success && row.data && typeof row.data === "object" ? { ...row.data } : {};
    record[String(playerID)] = { playerName, exchanges };
    const written = database.write(TABLE, `/${pilotID}`, record);
    if (!written || written.success !== true) {
      log.debug(`[PilotVoices] memory write refused: ${written && written.errorMsg}`);
    }
  } catch (error) {
    log.debug(`[PilotVoices] memory write failed: ${error && error.message}`);
  }
}

function describeMemory(memory, playerName, nowMs) {
  if (!memory || !memory.exchanges.length) return "";
  const lines = memory.exchanges.map((exchange) => {
    const minutes = Math.max(0, Math.round((nowMs - Number(exchange.atMs || nowMs)) / 60_000));
    const when = minutes < 2 ? "just now" : minutes < 90 ? `${minutes} minutes ago` : `${Math.round(minutes / 60)} hours ago`;
    return `- ${when}, ${playerName} said "${exchange.heard}" and you said "${exchange.said}"`;
  });
  return `You have talked with ${playerName} before:\n${lines.join("\n")}`;
}

// ---------------------------------------------------------------- Local bookkeeping

function noteHistory(systemID, line) {
  const history = historyBySystemID.get(systemID) || [];
  history.push(line);
  historyBySystemID.set(systemID, history.slice(-KEPT_HISTORY_LINES));
}

function describeHistory(systemID, nowMs) {
  const history = (historyBySystemID.get(systemID) || []).filter((line) => nowMs - line.atMs < 15 * 60_000);
  return history.length
    ? `Recent Local chat:\n${history.map((line) => `${line.name}: ${line.text}`).join("\n")}`
    : "Local has been quiet.";
}

function underLineLimit(systemID, nowMs, limit) {
  const recent = (postedAtBySystemID.get(systemID) || []).filter((atMs) => nowMs - atMs < 60_000);
  postedAtBySystemID.set(systemID, recent);
  return recent.length < limit;
}

function visiblePilots(systemID) {
  return pilotDirectory.listPilotsForSystem(systemID).filter((pilot) => pilot && pilot.localVisible !== false);
}

function stillHere(pilot, systemID) {
  const current = pilotDirectory.getPilotRecord(pilot.characterID);
  return Boolean(current && Number(current.solarSystemID) === Number(systemID) && current.localVisible !== false);
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// A pilot the player named: full name, or a first or last name of 4+ letters.
function findNamedPilots(pilots, message) {
  const text = String(message || "").toLowerCase();
  return pilots.filter((pilot) => {
    const name = String(pilot.characterName || "").toLowerCase();
    if (!name) return false;
    if (text.includes(name)) return true;
    return name.split(/\s+/).some((part) => (
      part.length >= 4 && new RegExp(`(^|[^a-z])${escapeRegExp(part)}([^a-z]|$)`).test(text)
    ));
  });
}

function chooseResponders(systemID, message, config, nowMs) {
  const pilots = visiblePilots(systemID);
  if (!pilots.length) return [];
  const named = findNamedPilots(pilots, message);
  if (named.length) return named.slice(0, 2);
  if (randomSource() >= config.replyChance) return [];
  const responders = [];
  // Keep a conversation going with whoever spoke last, most of the time.
  const lastSpeaker = [...(historyBySystemID.get(systemID) || [])]
    .reverse()
    .find((line) => line.synthetic && nowMs - line.atMs < 3 * 60_000);
  const continuing = lastSpeaker && pilots.find((pilot) => pilot.characterID === lastSpeaker.characterID);
  if (continuing && randomSource() < 0.7) {
    responders.push(continuing);
  } else {
    responders.push(pilots[Math.floor(randomSource() * pilots.length)]);
  }
  if (pilots.length > 1 && randomSource() < config.secondReplyChance) {
    const others = pilots.filter((pilot) => pilot.characterID !== responders[0].characterID);
    responders.push(others[Math.floor(randomSource() * others.length)]);
  }
  return responders;
}

// ---------------------------------------------------------------- speaking

function cleanLine(text, pilot) {
  let line = String(text || "").split(/\r?\n/).map((part) => part.trim()).filter(Boolean)[0] || "";
  const name = String(pilot.characterName || "");
  if (name && line.toLowerCase().startsWith(`${name.toLowerCase()}:`)) {
    line = line.slice(name.length + 1).trim();
  }
  line = line.replace(/^\*[^*]*\*\s*/, "").replace(/[*_#<>]/g, "").replace(/^["“'](.*)["”']$/s, "$1").trim();
  if (!line || /^[.…\s]+$/.test(line)) return "";
  if (/\b(as an ai|language model|i am an ai|i'm an ai)\b/i.test(line)) return "";
  if (line.length > MAX_LINE_CHARS) {
    const cut = line.slice(0, MAX_LINE_CHARS);
    const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
    line = stop > 60 ? cut.slice(0, stop + 1) : `${cut.trimEnd()}…`;
  }
  return line;
}

function wait(ms) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

async function speak(pilot, systemID, userPrompt, config, kind) {
  if (pendingCalls >= config.maxPending) {
    metrics.dropped += 1;
    return null;
  }
  pendingCalls += 1;
  const startedAtMs = Date.now();
  let line = "";
  try {
    const reply = await llm.chat(
      [
        { role: "system", content: buildPersona(pilot, systemID) },
        { role: "user", content: userPrompt },
      ],
      { maxTokens: config.maxTokens, temperature: config.temperature },
    );
    line = cleanLine(reply, pilot);
  } catch (error) {
    log.debug(`[PilotVoices] model call failed: ${error && error.message}`);
  } finally {
    pendingCalls -= 1;
  }
  if (!line) {
    metrics.silent += 1;
    return null;
  }
  const typingMs = config.typingBaseMs + (line.length * config.typingPerCharMs) + between(0, config.typingJitterMs);
  await wait(Math.max(0, typingMs - (Date.now() - startedAtMs)));
  const nowMs = Date.now();
  if (!stillHere(pilot, systemID) || !underLineLimit(systemID, nowMs, config.maxLinesPerMinute)) {
    metrics.dropped += 1;
    return null;
  }
  const sent = chatRuntime().broadcastSyntheticLocalMessage(
    { ...pilot, solarSystemID: systemID },
    line,
    { solarSystemID: systemID, createdAtMs: nowMs },
  );
  if (!sent) {
    metrics.dropped += 1;
    return null;
  }
  postedAtBySystemID.get(systemID).push(nowMs);
  metrics[kind === "ambient" ? "ambient" : "replies"] += 1;
  return line;
}

async function handleLocalMessage(event) {
  const systemID = Number(event && event.solarSystemID) || 0;
  const message = String(event && event.message || "").trim();
  if (!systemID || !message) return [];
  const entry = event.entry || {};
  const synthetic = event.syntheticNpcPilot === true || entry.syntheticNpcPilot === true;
  // What was said before this line; the line itself goes in the question.
  const before = describeHistory(systemID, Date.now());
  noteHistory(systemID, {
    name: String(entry.characterName || "Unknown"),
    text: message.slice(0, 240),
    atMs: Date.now(),
    characterID: Number(event.authorCharacterID) || 0,
    synthetic,
  });
  if (synthetic || message.startsWith("/")) return [];
  const config = settings();
  if (!config.enabled) return [];
  metrics.heard += 1;
  const playerID = Number(event.authorCharacterID) || 0;
  const playerName = String(entry.characterName || "the capsuleer");
  const nowMs = Date.now();
  const responders = chooseResponders(systemID, message, config, nowMs);
  const spoken = [];
  for (const pilot of responders) {
    const memory = readMemory(pilot.characterID, playerID);
    const prompt = [
      before,
      describeMemory(memory, playerName, nowMs),
      `${playerName}, a capsuleer, just said in Local: "${message.slice(0, 240)}"`,
      spoken.length
        ? `${spoken[0].name} already answered: "${spoken[0].line}". Add your own short take, do not repeat it.`
        : `Answer as ${pilot.characterName}.`,
    ].filter(Boolean).join("\n\n");
    const line = await speak(pilot, systemID, prompt, config, "reply");
    if (line) {
      spoken.push({ name: pilot.characterName, line });
      remember(pilot.characterID, playerID, playerName, message.slice(0, 160), line.slice(0, 160), Date.now());
    }
  }
  return spoken;
}

async function ambientLine(systemID, config) {
  const pilots = visiblePilots(systemID);
  if (!pilots.length) return null;
  const pilot = pilots[Math.floor(randomSource() * pilots.length)];
  const prompt = [
    describeHistory(systemID, Date.now()),
    "Nobody has spoken to you. Type one short thing a pilot might put in Local right now: about your work, " +
      "this route, this system, or something small and personal. Do not greet the channel and do not ask who is around.",
  ].join("\n\n");
  return speak(pilot, systemID, prompt, config, "ambient");
}

function systemsWithPlayers(runtime) {
  const systemIDs = [];
  if (!runtime || !(runtime.scenes instanceof Map)) return systemIDs;
  for (const [systemID, scene] of runtime.scenes) {
    if (!scene || !(scene.sessions instanceof Map)) continue;
    for (const session of scene.sessions.values()) {
      if (session && Number(session.characterID) > 0) {
        systemIDs.push(Number(systemID));
        break;
      }
    }
  }
  return systemIDs;
}

function start() {
  if (started) return;
  started = true;
  chatRuntime().on("local-message", (event) => {
    handleLocalMessage(event).catch((error) => {
      log.warn(`[PilotVoices] reply failed: ${error && error.message}`);
    });
  });
  log.info("[PilotVoices] listening in Local");
}

// Called once per space runtime tick, after the Living Universe tick.
function tick(runtime, nowMs = Date.now()) {
  start();
  if (nowMs < nextAmbientCheckAtMs) return;
  nextAmbientCheckAtMs = nowMs + 5_000;
  const config = settings();
  if (!config.enabled || !config.ambientEnabled) return;
  const occupied = new Set(systemsWithPlayers(runtime));
  for (const systemID of nextAmbientAtBySystemID.keys()) {
    if (!occupied.has(systemID)) nextAmbientAtBySystemID.delete(systemID);
  }
  for (const systemID of occupied) {
    const dueAtMs = nextAmbientAtBySystemID.get(systemID);
    if (dueAtMs === undefined) {
      nextAmbientAtBySystemID.set(systemID, nowMs + between(config.ambientFirstMinMs, config.ambientFirstMaxMs));
      continue;
    }
    if (nowMs < dueAtMs) continue;
    nextAmbientAtBySystemID.set(systemID, nowMs + between(config.ambientMinMs, config.ambientMaxMs));
    ambientLine(systemID, config).catch((error) => {
      log.warn(`[PilotVoices] ambient line failed: ${error && error.message}`);
    });
  }
}

function getStatus() {
  return { started, pendingCalls, systemsTracked: nextAmbientAtBySystemID.size, ...metrics };
}

module.exports = {
  tick,
  start,
  getStatus,
  _testing: {
    handleLocalMessage,
    ambientLine,
    buildPersona,
    cleanLine,
    describeActivity,
    findNamedPilots,
    settings,
    setLlm(replacement) { llm = replacement || llmClient; },
    setRandom(replacement) { randomSource = replacement || Math.random; },
    reset() {
      historyBySystemID.clear();
      postedAtBySystemID.clear();
      nextAmbientAtBySystemID.clear();
      nextAmbientCheckAtMs = 0;
      pendingCalls = 0;
      for (const key of Object.keys(metrics)) metrics[key] = 0;
    },
  },
};
