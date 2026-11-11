"use strict";

// EveJS RPG fork: the server half of the native client mod bridge.
//
// Client mods (client-mods/ in the repo, loaded by the code.ccp hook) call
// sm.RemoteSvc('evejsMod').<Method>(...) over the game's normal connection and
// land in the Handle_<Method> methods here. Replies use the same marshal helpers
// as every other service, so the client receives ordinary Python dicts/lists.

const path = require("path");

const BaseService = require(path.join(__dirname, "../baseService"));
const log = require(path.join(__dirname, "../../utils/logger"));
const { buildDict, buildList } = require(path.join(__dirname, "../_shared/serviceHelpers"));
const worldData = require(path.join(__dirname, "../../space/worldData"));
const { resolveItemByTypeID } = require(path.join(__dirname, "../inventory/itemTypeRegistry"));
const { EVEJS_VERSION } = require(path.join(__dirname, "../../config/manager"));

const llm = require(path.join(__dirname, "../../rpg/llm/llmClient"));
const contracts = require(path.join(__dirname, "../../rpg/contracts/contracts"));
const requisition = require(path.join(__dirname, "../../rpg/dev/requisition"));
const chatHub = require(path.join(__dirname, "../chat/chatHub"));
const { executeChatCommand } = require(path.join(__dirname, "../chat/chatCommands"));

const BRIDGE_VERSION = 6;

// Questions the Crew Link window can ask with one click. The model only phrases
// the answer; every fact it may use comes from the server.
const CREW_TOPICS = Object.freeze({
  report: {
    ask: "Give me a quick status report.",
    fallback: "All hands accounted for, Captain. Nothing to report beyond what's on the board.",
  },
  mood: {
    ask: "How is the crew holding up?",
    fallback: "Steady enough, Captain. They'd take a quiet run if you can find one.",
  },
  next: {
    ask: "What should we do next?",
    fallback: "Your call, Captain. Give us a job and we'll see it done.",
  },
});

function text(value, fallback = "") {
  if (value === null || value === undefined) return fallback;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  if (typeof value === "object" && value.value !== undefined) return text(value.value, fallback);
  return String(value);
}

function characterID(session) {
  return Number(session?.characterID || session?.charid) || 0;
}

function courierCrewLines(ownerID) {
  try {
    const crew = require(path.join(__dirname, "../crew/crewRuntime")).getDefaultCrewService();
    const snapshot = crew?.snapshot?.(ownerID);
    if (!snapshot?.enabled) return ["Crew operations are switched off on this server."];
    if (!snapshot.crew) return ["You have no courier crew yet."];
    const state = snapshot.crew;
    const lines = [`${state.name || "Courier crew"} at ${state.station?.name || state.station?.stationName || "an unknown station"}`];
    for (const person of state.roster || []) lines.push(`  ${person.name}, ${person.role}`);
    lines.push(state.job ? `Current job: ${state.job.phase || "underway"}` : "No job in progress.");
    return lines;
  } catch (error) {
    log.warn(`[evejsMod] crew snapshot failed for ${ownerID}: ${error.message}`);
    return ["Crew records are unavailable right now."];
  }
}

// Structured crew data for the native window: {available, name, station, job, roster[{name, role}]}.
function crewSummary(ownerID) {
  try {
    const crew = require(path.join(__dirname, "../crew/crewRuntime")).getDefaultCrewService();
    const snapshot = crew?.snapshot?.(ownerID);
    if (!snapshot?.enabled) return { available: false, note: "Crew operations are switched off on this server." };
    if (!snapshot.crew) return { available: false, note: "No crew signed on yet." };
    const state = snapshot.crew;
    return {
      available: true,
      name: state.name || "Courier crew",
      station: state.station?.name || state.station?.stationName || "",
      job: state.job ? `${state.job.phase || "underway"}${state.job.destinationStation?.name ? ` to ${state.job.destinationStation.name}` : ""}` : "Standing by",
      roster: (state.roster || []).map((person) => ({ name: person.name, role: person.role || "Crew" })),
    };
  } catch (error) {
    log.warn(`[evejsMod] crew summary failed for ${ownerID}: ${error.message}`);
    return { available: false, note: "Crew records are unavailable right now." };
  }
}

function crewChief(ownerID) {
  try {
    const crew = require(path.join(__dirname, "../crew/crewRuntime")).getDefaultCrewService();
    const person = crew?.snapshot?.(ownerID)?.crew?.roster?.[0];
    if (person?.name) {
      return { name: person.name, role: person.role || "crew chief",
        voice: "a practical, loyal spacer, a little dry" };
    }
  } catch { /* the crew chief is optional */ }
  // No crew signed on: the ship's own AI answers (Aura is EVE's ship AI).
  return { name: "Aura", role: "Ship AI",
    voice: "the ship's onboard AI: calm, precise and quietly warm, never robotic, never servile" };
}

function shipFacts(session) {
  const shipType = resolveItemByTypeID(Number(session?.shipTypeID));
  const systemID = Number(session?.solarsystemid2 || session?.solarsystemid) || 0;
  const system = systemID ? worldData.getSolarSystemByID(systemID) : null;
  return {
    pilot: text(session?.characterName, "the captain"),
    ship: [text(session?.shipName), shipType?.name ? `(${shipType.name})` : ""].join(" ").trim() || "an unknown ship",
    system: text(system?.solarSystemName, "an unknown system"),
    security: Number.isFinite(system?.security) ? system.security.toFixed(1) : "unknown",
    docked: Boolean(session?.stationid || session?.structureid),
  };
}

function contractDict(contract) {
  if (!contract) return null;
  return buildDict(Object.entries(contract).map(([key, value]) => [key, Array.isArray(value) ? buildList(value) : value]));
}

// Contract calls never throw at the client: a failure comes back as {error: "..."}.
async function contractReply(action) {
  try {
    const state = await action();
    return buildDict([
      ["contract", contractDict(state.contract)],
      ["lastPaid", contractDict(state.lastPaid)],
      ["completedCount", state.completedCount],
      ["error", ""],
    ]);
  } catch (error) {
    if (!error.code) log.warn(`[evejsMod] contract call failed: ${error.stack || error.message}`);
    return buildDict([
      ["contract", null], ["lastPaid", null], ["completedCount", 0],
      ["error", error.code ? error.message : "Contracts are unavailable right now."],
    ]);
  }
}

class EvejsModService extends BaseService {
  constructor() {
    super("evejsMod");
    contracts.start();
  }

  // ---- Generated contracts (server/src/rpg/contracts). Each call answers with
  // the pilot's current contract state: {contract, lastPaid, completedCount, error}.
  Handle_GetContracts(args, session) {
    return contractReply(() => contracts.getContracts(characterID(session)));
  }

  Handle_RequestContract(args, session) {
    const shipType = resolveItemByTypeID(Number(session?.shipTypeID));
    return contractReply(() => contracts.requestContract({
      characterID: characterID(session),
      pilotName: text(session?.characterName, "the captain"),
      shipName: text(session?.shipName) || text(shipType?.name, "their ship"),
      shipTypeID: Number(session?.shipTypeID) || 0,
      solarSystemID: Number(session?.solarsystemid2 || session?.solarsystemid) || 0,
      // Optional: ask one particular contact for work.
      contactID: text(args?.[0]) || null,
    }));
  }

  // ---- Contacts: clients the pilot has completed work for (contractContacts.js).
  Handle_GetContacts(args, session) {
    try {
      return buildList(contracts.getContacts(characterID(session)).map((contact) => buildDict(Object.entries(contact))));
    } catch (error) {
      log.warn(`[evejsMod] contacts unavailable: ${error.message}`);
      return buildList([]);
    }
  }

  // Returns {speaker, role, text, source}; source is "ai", "written" or "error".
  async Handle_HailContact(args, session) {
    try {
      const reply = await contracts.hailContact(characterID(session), text(args?.[0]), text(session?.characterName, "the captain"));
      return buildDict(Object.entries(reply));
    } catch (error) {
      if (!error.code) log.warn(`[evejsMod] hail failed: ${error.stack || error.message}`);
      return buildDict([["speaker", ""], ["role", ""], ["source", "error"],
        ["text", error.code ? error.message : "The channel would not open."]]);
    }
  }

  Handle_AcceptContract(args, session) {
    return contractReply(() => contracts.acceptContract(characterID(session), text(args?.[0])));
  }

  // ---- Test ships (server/src/rpg/dev/requisition.js).
  Handle_GetLoadouts() {
    return buildList(requisition.listLoadouts().map((loadout) => buildDict(Object.entries(loadout))));
  }

  // Returns {ok, label, notes[]}; a refusal comes back as ok=false with one note saying why.
  Handle_Requisition(args, session) {
    try {
      const result = requisition.requisition(session, text(args?.[0]), {
        serviceManager: this.serviceManager,
        // The same path the /allskills command takes, so the client's skill sheet updates live.
        grantSkills: () => executeChatCommand(session, "/allskills", chatHub, {
          emitChatFeedback: false, serviceManager: this.serviceManager,
        }),
      });
      return buildDict([["ok", true], ["label", result.label], ["notes", buildList(result.notes)]]);
    } catch (error) {
      if (error.code !== "REQUISITION") log.warn(`[evejsMod] requisition failed: ${error.stack || error.message}`);
      return buildDict([["ok", false], ["label", ""],
        ["notes", buildList([error.code === "REQUISITION" ? error.message : "The requisition failed. Nothing more was delivered."])]]);
    }
  }

  Handle_AbandonContract(args, session) {
    return contractReply(() => contracts.abandonContract(characterID(session), text(args?.[0])));
  }

  // Round trip check used by the client loader and the first mod window.
  Handle_Ping(args, session) {
    const message = text(args?.[0], "ping").slice(0, 200);
    log.info(`[evejsMod] ping from character ${characterID(session)}: ${message}`);
    return `EveJS ${EVEJS_VERSION} heard you: "${message}"`;
  }

  // One-click question to the crew chief, answered in character by the local AI.
  // Returns {speaker, role, text, source}; source is "ai" or "written".
  async Handle_AskCrew(args, session) {
    const ownerID = characterID(session);
    const topic = CREW_TOPICS[text(args?.[0], "report")] || CREW_TOPICS.report;
    const chief = crewChief(ownerID);
    const facts = shipFacts(session);
    const factLines = [
      `Captain: ${facts.pilot}`,
      `Ship: ${facts.ship}`,
      `Location: ${facts.docked ? "docked at a station in" : "in space in"} ${facts.system} (security ${facts.security})`,
      ...courierCrewLines(ownerID).map((line) => `Crew record: ${line.trim()}`),
    ];
    const reply = await llm.chat([
      { role: "system", content:
        `You are ${chief.name}, ${chief.role} aboard the captain's ship in EVE Online's New Eden. ` +
        `Speak in character as ${chief.voice}. Address the captain as Captain. ` +
        "Answer in two to four short sentences. Use only the facts below; never invent numbers, names, " +
        "cargo or events that are not listed. No stage directions, no lists, no markdown.\n\n" +
        `Facts:\n${factLines.join("\n")}` },
      { role: "user", content: topic.ask },
    ], { maxTokens: 160, temperature: 0.8 });
    return buildDict([
      ["speaker", chief.name],
      ["role", chief.role],
      ["text", reply || topic.fallback],
      ["source", reply ? "ai" : "written"],
    ]);
  }

  Handle_GetStatus(args, session) {
    const ownerID = characterID(session);
    const shipType = resolveItemByTypeID(Number(session?.shipTypeID));
    const systemID = Number(session?.solarsystemid2 || session?.solarsystemid) || 0;
    const system = systemID ? worldData.getSolarSystemByID(systemID) : null;
    return buildDict([
      ["bridgeVersion", BRIDGE_VERSION],
      ["serverVersion", EVEJS_VERSION],
      ["characterID", ownerID],
      ["characterName", text(session?.characterName, "Unknown pilot")],
      ["shipID", Number(session?.shipID || session?.shipid) || 0],
      ["shipName", text(session?.shipName)],
      ["shipTypeName", text(shipType?.name)],
      ["solarSystemName", text(system?.solarSystemName || system?.name)],
      ["docked", Boolean(session?.stationid || session?.structureid)],
      ["crew", buildList(courierCrewLines(ownerID))],
      ["security", Number.isFinite(system?.security) ? Math.round(system.security * 10) / 10 : null],
      ["crewInfo", (() => {
        const summary = crewSummary(ownerID);
        return buildDict([
          ["available", summary.available],
          ["note", summary.note || ""],
          ["name", summary.name || ""],
          ["station", summary.station || ""],
          ["job", summary.job || ""],
          ["roster", buildList((summary.roster || []).map((person) =>
            buildDict([["name", person.name], ["role", person.role]])))],
        ]);
      })()],
    ]);
  }
}

module.exports = EvejsModService;
