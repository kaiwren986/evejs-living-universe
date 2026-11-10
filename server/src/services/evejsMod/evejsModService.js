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

const BRIDGE_VERSION = 1;

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

class EvejsModService extends BaseService {
  constructor() {
    super("evejsMod");
  }

  // Round trip check used by the client loader and the first mod window.
  Handle_Ping(args, session) {
    const message = text(args?.[0], "ping").slice(0, 200);
    log.info(`[evejsMod] ping from character ${characterID(session)}: ${message}`);
    return `EveJS ${EVEJS_VERSION} heard you: "${message}"`;
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
    ]);
  }
}

module.exports = EvejsModService;
