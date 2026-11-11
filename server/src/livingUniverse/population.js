"use strict";

// Living Universe (port to EveJS 261108.1): who the pilots are.
//
// Builds the persistent population: each pilot gets a role, a home station and
// an employer chosen from that station's region (affiliations.js), and a stable
// identity (pilotDirectory.js: character ID from 2,120,000,000, name, portrait).
// Everything is derived from the pilot's number, so the same population comes
// out on every machine; once created, pilots are stored and never regenerated.
//
// This slice has no ships or flights. Where a pilot is, and whether they are
// online, is tracked by presence.js.

const path = require("path");

const worldData = require(path.join(__dirname, "../space/worldData"));
const { resolveAffiliation } = require("./affiliations");

// Share of the population per role, in percent. Roles are the mod's own.
const ROLE_SHARE = Object.freeze([
  ["hauler", 30], ["miner", 26], ["shuttle", 22], ["police", 10], ["escort", 6], ["highsec_pirate", 6],
]);
const AFFILIATION_FAMILY = Object.freeze({
  hauler: "hauler", miner: "miner", shuttle: "shuttle", police: "police", escort: "convoy", highsec_pirate: "pirate",
});
const HIGHSEC = 0.45;

function hashText(text) {
  let hash = 2166136261;
  for (const char of String(text)) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash;
}

let homeStations = null;

// Stations pilots can call home: every empire station, high security first.
function listHomeStations() {
  if (homeStations) return homeStations;
  const high = [];
  const low = [];
  for (const system of worldData.getSolarSystems()) {
    const security = Number(system.security);
    if (!(security > 0)) continue; // null security and wormholes are for later slices
    for (const station of worldData.getStationsForSystem(system.solarSystemID)) {
      (security >= HIGHSEC ? high : low).push(station);
    }
  }
  const byID = (a, b) => a.stationID - b.stationID;
  homeStations = { high: high.sort(byID), low: low.sort(byID) };
  return homeStations;
}

function roleFor(number) {
  let roll = hashText(`lu:${number}:role`) % 100;
  for (const [role, share] of ROLE_SHARE) {
    roll -= share;
    if (roll < 0) return role;
  }
  return ROLE_SHARE[0][0];
}

/** The pilot with this number (1-based), before an identity is attached. */
function planActor(number) {
  const role = roleFor(number);
  const stations = listHomeStations();
  // Pirates and one pilot in eight live in low security.
  const pool = (role === "highsec_pirate" || hashText(`lu:${number}:band`) % 8 === 0) && stations.low.length
    ? stations.low : stations.high;
  const station = pool[hashText(`lu:${number}:home`) % pool.length];
  const system = worldData.getSolarSystemByID(station.solarSystemID);
  const affiliation = resolveAffiliation({
    family: AFFILIATION_FAMILY[role], station, system, seed: `lu:${number}`,
  });
  return {
    actorID: `lu-${number}`,
    number,
    role,
    profession: affiliation.profession,
    homeStationID: station.stationID,
    homeStationName: station.stationName,
    homeSystemID: station.solarSystemID,
    homeSystemName: station.solarSystemName,
    corporationID: affiliation.corporationID,
    corporationName: affiliation.corporationName,
    factionID: affiliation.factionID,
    factionName: affiliation.factionName,
    raceID: affiliation.raceID,
    // Presence (presence.js): where they are and whether they show in Local.
    currentSystemID: station.solarSystemID,
    docked: true,
    online: false,
    nextMoveAtMs: 0,
  };
}

module.exports = { planActor, hashText };
