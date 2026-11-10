"use strict";

// The NPC stations Tranquility's structureDirectory.GetMyCharacterStructures holds besides the Upwell structures a
// character may dock at. Recorded (LOGS/Archive/Open Structure Browser.txt, 2026-07-03): NPC stations such as 60009478
// and 60002230 among the structures, each a plain dict of its type, its number as structureID, no wars, its services
// and its owner corporation and system. Every NPC station recorded lies in the pilot's region (Essence, 10000064), and
// the client keeps what it reads of the call per region (structureDirectory.GetMarketDockableLocationsInRegion, whose
// market set marketQuote.PickStation and the multibuy's station list read, with a branch for a station), so the
// stations are the session's region's.
//
// A station's services are its own (eve/common/script/util/structuresCommon.py GetStationServices: its operation's,
// with repair facilities added in high-security space) each turned into the structure service it is
// (STATION_SERVICE_MAPPING), as keys with None for value. A station service with no structure service becomes the key
// None, as recorded ({1: None, ..., 12: None, None: None}).

const fs = require("fs");
const path = require("path");

const worldData = require(path.join(__dirname, "../../space/worldData"));
const { buildDict, buildList } = require(path.join(__dirname, "../_shared/serviceHelpers"));

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const STATION_OPERATIONS_PATHS = [
  path.join(REPO_ROOT, "tools", "DataSync", "source_json", "eve-online-static-data-3396210-jsonl", "stationOperations.jsonl"),
  path.join(REPO_ROOT, "_local", "sde", "eve-online-static-data-3396210-jsonl", "stationOperations.jsonl"),
];

// structuresCommon.STATION_SERVICE_MAPPING: appConst.stationService* (1 to 27) to structures.SERVICE_* (null for none).
// A station service not in it (stationServicePaintshop, 18) is .get()'s None too.
const STATION_SERVICE_MAPPING = new Map([
  [1, 7], // BountyMissions -> MISSION
  [2, 7], // AssassinationMissions -> MISSION
  [3, 7], // CourierMission -> MISSION
  [4, null], // Interbus
  [5, 4], // ReprocessingPlant -> REPROCESSING
  [6, 4], // Refinery -> REPROCESSING
  [7, 5], // Market -> MARKET
  [8, null], // BlackMarket
  [9, null], // StockExchange
  [10, 6], // Cloning -> MEDICAL
  [11, 6], // Surgery -> MEDICAL
  [12, 6], // DNATherapy -> MEDICAL
  [13, 8], // RepairFacilities -> REPAIR
  [14, 20], // Factory -> INDUSTRY
  [15, 20], // Laboratory -> INDUSTRY
  [16, null], // Gambling
  [17, 2], // Fitting -> FITTING
  [19, null], // News
  [20, null], // Storage
  [21, 9], // Insurance -> INSURANCE
  [22, 1], // Docking -> DOCKING
  [23, 3], // OfficeRental -> OFFICES
  [24, 10], // JumpCloneFacility -> JUMP_CLONE
  [25, 11], // LoyaltyPointStore -> LOYALTY_STORE
  [26, 12], // NavyOffices -> FACTION_WARFARE
  [27, 13], // SecurityOffice -> SECURITY_OFFICE
]);
const STATION_SERVICE_REPAIR_FACILITIES = 13;
// eveuniverse/security.py SecurityClassFromLevel: high security from 0.45.
const HIGH_SECURITY_LEVEL = 0.45;

let operationServicesCache = null;

/** evestations.data.get_station_services_for_operation, by operation: the SDE's stationOperations' services. */
function operationServices() {
  if (operationServicesCache) {
    return operationServicesCache;
  }
  const byOperation = new Map();
  const file = STATION_OPERATIONS_PATHS.find((candidate) => fs.existsSync(candidate));
  if (file) {
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }
      const row = JSON.parse(line);
      const operationID = Number(row && row._key) || 0;
      if (operationID > 0) {
        byOperation.set(operationID, Array.isArray(row.services) ? row.services.map(Number) : []);
      }
    }
  }
  operationServicesCache = byOperation;
  return byOperation;
}

/** structuresCommon.GetStationServices: the operation's services, and repair facilities in high-security space. */
function stationServices(station) {
  const services = new Set(operationServices().get(Number(station.operationID) || 0) || []);
  const system = worldData.getSolarSystemByID(station.solarSystemID);
  const security = Number(system && system.security);
  if (Number.isFinite(security) && security >= HIGH_SECURITY_LEVEL) {
    services.add(STATION_SERVICE_REPAIR_FACILITIES);
  }
  return services;
}

/** The structure services a station has, the unmapped ones as one null (dict keys: each once). */
function stationStructureServices(station) {
  const mapped = new Set();
  for (const serviceID of stationServices(station)) {
    mapped.add(STATION_SERVICE_MAPPING.has(serviceID) ? STATION_SERVICE_MAPPING.get(serviceID) : null);
  }
  return [...mapped];
}

function sessionRegionID(session) {
  const regionID = Number(session && (session.regionid || session.regionID)) || 0;
  if (regionID > 0) {
    return regionID;
  }
  const solarSystemID = Number(session && (session.solarsystemid2 || session.solarsystemid || session.solarSystemID)) || 0;
  const system = solarSystemID > 0 ? worldData.getSolarSystemByID(solarSystemID) : null;
  return Number(system && system.regionID) || 0;
}

/** The NPC stations of the session's region. */
function listRegionNpcStations(session) {
  const regionID = sessionRegionID(session);
  if (regionID <= 0) {
    return [];
  }
  const stations = [];
  for (const system of worldData.getSolarSystems()) {
    if (Number(system && system.regionID) !== regionID) {
      continue;
    }
    for (const station of worldData.getStationsForSystem(system.solarSystemID) || []) {
      if (Number(station && station.stationID) > 0) {
        stations.push(station);
      }
    }
  }
  return stations.sort((left, right) => left.stationID - right.stationID);
}

/** A station's GetMyCharacterStructures entry, as recorded: a plain dict. */
function buildNpcStationDirectoryEntry(station) {
  return [
    station.stationID,
    buildDict([
      ["typeID", Number(station.stationTypeID) || 0],
      ["structureID", station.stationID],
      ["wars", buildList([])],
      ["services", buildDict(stationStructureServices(station).map((serviceID) => [serviceID, null]))],
      ["ownerID", Number(station.corporationID) || 0],
      ["solarSystemID", Number(station.solarSystemID) || 0],
    ]),
  ];
}

module.exports = {
  STATION_SERVICE_MAPPING,
  listRegionNpcStations,
  stationStructureServices,
  buildNpcStationDirectoryEntry,
};
