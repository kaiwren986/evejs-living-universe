"use strict";

// Living Universe (port to EveJS 261108.1): the persistent pilot population.
//
// Slice 1 of the port: identities and presence. A fixed population of named
// pilots is created once, stored one row per pilot (table livingUniversePilots,
// keyed by character ID) and loaded on every start. A slow walker moves them
// between "docked and offline" and "in space" in systems near home, which is
// what later puts them in Local. Ships, jobs and the economy are later slices
// and will attach to these same pilots.
//
// Upstream code reaches this only through hooks.js.

const fs = require("fs");
const path = require("path");

const database = require(path.join(__dirname, "../gameStore"));
const worldData = require(path.join(__dirname, "../space/worldData"));
const log = require(path.join(__dirname, "../utils/logger"));
const directory = require("./pilotDirectory");
const { planActor, hashText } = require("./population");

const TABLE = "livingUniversePilots";
const SOURCE_ID = "living-universe";
const CONFIG_PATH = path.resolve(__dirname, "../../../config/livingUniverse.json");
const DEFAULTS = Object.freeze({ enabled: true, populationSize: 5000 });

const TICK_MS = 15000;
const MOVES_PER_TICK = 150;        // spreads 5,000 pilots' changes thinly over time
const SAVE_EVERY_MS = 3 * 60 * 1000;
const MINUTE = 60 * 1000;

const actors = new Map();          // characterID -> actor (the stored row)
const dirty = new Set();           // characterIDs changed since the last save
const listeners = new Set();       // presence listeners: ({systemIDs, pilots}) => void
let timer = null;
let lastSaveAtMs = 0;
let started = false;

function loadConfig() {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) };
  } catch {
    return { ...DEFAULTS };
  }
}

function isEnabled() {
  return started;
}

// What the directory needs to know about where a pilot is right now.
function presenceOf(actor) {
  const inSpace = actor.online && !actor.docked;
  return {
    solarSystemID: actor.currentSystemID,
    stationID: actor.docked ? actor.homeStationID : null,
    localVisible: inSpace,
    state: !actor.online ? "offline" : actor.docked ? "docked" : "in_space",
    assignment: actor.role,
  };
}

const directoryOptions = { sourceID: SOURCE_ID, resolvePresence: presenceOf };

function save(force = false) {
  if (!dirty.size || (!force && Date.now() - lastSaveAtMs < SAVE_EVERY_MS)) return;
  for (const characterID of dirty) {
    const actor = actors.get(characterID);
    // A copy: the store keeps what it is given, and these objects keep changing.
    if (actor) database.write(TABLE, `/${characterID}`, JSON.parse(JSON.stringify(actor)));
  }
  dirty.clear();
  lastSaveAtMs = Date.now();
  if (force) database.flushTableSync(TABLE);
}

function nextStretch(actor, nowMs) {
  // Online stretches are shorter than offline ones: roughly a third of pilots are out at once.
  const span = actor.online ? 10 + (hashText(`${actor.actorID}:${nowMs}:on`) % 35) : 20 + (hashText(`${actor.actorID}:${nowMs}:off`) % 80);
  return nowMs + span * MINUTE;
}

// One step in a pilot's day: undock, hop to a neighbouring system, or dock and log off.
function move(actor, nowMs) {
  const roll = hashText(`${actor.actorID}:${nowMs}:move`) % 100;
  if (!actor.online) {
    actor.online = true;
    actor.docked = false;
    actor.currentSystemID = actor.currentSystemID || actor.homeSystemID;
  } else if (roll < 55) {
    const gates = worldData.getStargatesForSystem(actor.currentSystemID)
      .filter((gate) => Number(worldData.getSolarSystemByID(gate.destinationSolarSystemID)?.security) > 0);
    if (gates.length) actor.currentSystemID = gates[hashText(`${actor.actorID}:${nowMs}:gate`) % gates.length].destinationSolarSystemID;
  } else {
    // Home for the night.
    actor.online = false;
    actor.docked = true;
    actor.currentSystemID = actor.homeSystemID;
  }
  actor.nextMoveAtMs = nextStretch(actor, nowMs);
}

function tick() {
  try {
    const nowMs = Date.now();
    const moved = [];
    for (const actor of actors.values()) {
      if (actor.nextMoveAtMs > nowMs) continue;
      move(actor, nowMs);
      moved.push(actor);
      dirty.add(actor.pilot.characterID);
      if (moved.length >= MOVES_PER_TICK) break;
    }
    if (moved.length) {
      const change = directory.syncActorChanges(moved, directoryOptions);
      for (const listener of listeners) {
        try { listener({ systemIDs: change.affectedSystemIDs, pilots: change.pilots }); }
        catch (error) { log.warn(`[LivingUniverse] presence listener failed: ${error.message}`); }
      }
    }
    save();
  } catch (error) {
    log.warn(`[LivingUniverse] tick failed: ${error.message}`);
  }
}

function recover(size) {
  database.ensureTable(TABLE);
  const root = database.read(TABLE, "/");
  const rows = Object.values((root.success && root.data) || {})
    .filter((row) => row && row.pilot && row.number >= 1 && row.number <= size);
  for (const row of rows) actors.set(row.pilot.characterID, JSON.parse(JSON.stringify(row)));
  return rows.length;
}

function create(size) {
  const nowMs = Date.now();
  const have = new Set([...actors.values()].map((actor) => actor.number));
  const fresh = [];
  for (let number = 1; number <= size; number += 1) {
    if (have.has(number)) continue;
    const actor = planActor(number);
    // Start mid-day rather than with everyone asleep: about a third are out already.
    if (hashText(`lu:${number}:start`) % 100 < 32) {
      actor.online = true;
      actor.docked = false;
    }
    actor.nextMoveAtMs = nowMs + (hashText(`lu:${number}:first`) % 45) * MINUTE;
    fresh.push(actor);
  }
  if (!fresh.length) return 0;
  directory.syncActorChanges(fresh, directoryOptions); // attaches actor.pilot (the identity)
  for (const actor of fresh) {
    actors.set(actor.pilot.characterID, actor);
    dirty.add(actor.pilot.characterID);
  }
  save(true);
  return fresh.length;
}

function start() {
  if (started) return true;
  const config = loadConfig();
  if (!config.enabled) {
    log.info("[LivingUniverse] disabled in config/livingUniverse.json");
    return false;
  }
  const size = Math.max(0, Math.min(20000, Math.trunc(Number(config.populationSize) || 0)));
  const begun = Date.now();
  const recovered = recover(size);
  const created = create(size);
  directory.syncActors([...actors.values()], directoryOptions);
  started = true;
  // Pilots arriving and leaving show up in Local for anyone in that system.
  onPresenceChange(({ systemIDs }) => {
    const chat = require(path.join(__dirname, "../_secondary/chat/chatRuntime"));
    for (const systemID of systemIDs) chat.repushLocalMembershipForSolarSystem(systemID);
  });
  timer = setInterval(tick, TICK_MS);
  timer.unref?.();
  const online = [...actors.values()].filter((actor) => actor.online).length;
  log.info(`[LivingUniverse] ${actors.size} pilots (recovered ${recovered}, created ${created}), ${online} in space, ready in ${Date.now() - begun} ms`);
  return true;
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  if (started) {
    try { save(true); } catch (error) { log.warn(`[LivingUniverse] final save failed: ${error.message}`); }
  }
  started = false;
}

/** The character-style record for a pilot, or null. Safe to call when disabled. */
function getPilotRecord(characterID) {
  return started ? directory.getPilotRecord(characterID) : null;
}

function isPilotID(characterID) {
  const id = Number(characterID);
  return id > directory.PILOT_CHARACTER_ID_BASE && id <= directory.PILOT_CHARACTER_ID_BASE + 20000;
}

function listPilotsInSystem(systemID) {
  return started ? directory.listPilotsForSystem(systemID) : [];
}

function onPresenceChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function stats() {
  const all = [...actors.values()];
  return { total: all.length, online: all.filter((actor) => actor.online).length };
}

module.exports = {
  start, stop, isEnabled, isPilotID, getPilotRecord, listPilotsInSystem, onPresenceChange, stats,
  portraitSourceFor: (characterID) => directory.getPortraitSourceCharacterID(characterID),
};
