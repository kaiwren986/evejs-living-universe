"use strict";
// Reads installed static JSON only. Never imports gameStore or starts a server.
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { createCrewWorld } = require("../../server/src/services/crew/crewRuntime");
const root = path.resolve(__dirname, "../..");
const data = path.join(root, "_local/gameStore/data");
const read = (table, key) => JSON.parse(fs.readFileSync(path.join(data, table, "data.json"), "utf8"))[key];
const systems = read("solarSystems", "solarSystems"), stations = read("stations", "stations"), gates = read("stargates", "stargates");
const systemsByID = new Map(systems.map((system) => [system.solarSystemID, system]));
const stationsByID = new Map(stations.map((station) => [station.stationID, station]));
const gatesBySystem = new Map();
for (const gate of gates) { if (!gatesBySystem.has(gate.solarSystemID)) gatesBySystem.set(gate.solarSystemID, []); gatesBySystem.get(gate.solarSystemID).push(gate); }
const world = createCrewWorld({ getStationByID: (id) => stationsByID.get(id), getSolarSystemByID: (id) => systemsByID.get(id),
  getSolarSystems: () => systems, getStationsForSystem: (id) => stations.filter((station) => station.solarSystemID === id),
  getStargatesForSystem: (id) => gatesBySystem.get(id) || [] });
const source = world.station(60003760), destination = stations.find((station) => station.solarSystemID === 30000145);
assert.ok(source && destination, "Jita and New Caldari stations must exist in the installed static data");
const route = world.route(source.solarSystemID, destination.solarSystemID);
assert.equal(route[0], source.solarSystemID); assert.equal(route.at(-1), destination.solarSystemID); assert.ok(route.length <= 33);
assert.ok(world.searchStations("Jita").some((station) => station.stationID === source.stationID));
const result = { success: true, source: source.stationName, destination: destination.stationName,
  route: route.map((id) => ({ solarSystemID: id, name: systemsByID.get(id).solarSystemName })),
  systems: systems.length, stations: stations.length, worldDatabaseOpened: false, eveLaunched: false };
const output = path.join(root, "_local/living-universe-audit");
fs.mkdirSync(output, { recursive: true }); fs.writeFileSync(path.join(output, "crew-topology.json"), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result, null, 2));
