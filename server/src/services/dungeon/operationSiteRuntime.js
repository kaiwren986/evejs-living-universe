"use strict";

const {
  toFiniteNumber,
} = require("../../common/numbers");

const operationSpawnpointRecords = new Map();

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function normalizeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function clonePosition(value) {
  return {
    x: toFiniteNumber(value && value.x, 0),
    y: toFiniteNumber(value && value.y, 0),
    z: toFiniteNumber(value && value.z, 0),
  };
}

function getCharacterID(session) {
  return Math.max(
    0,
    toInt(
      session && (
        session.characterID ||
        session.charid ||
        session.characterId
      ),
      0,
    ),
  );
}

function buildOperationSpawnpointKey(characterID, siteID) {
  return `${Math.max(0, toInt(characterID, 0))}:${Math.max(0, toInt(siteID, 0))}`;
}

function resolveOperationSiteArgs(args, session) {
  const first = Array.isArray(args) ? Math.max(0, toInt(args[0], 0)) : 0;
  const second = Array.isArray(args) ? Math.max(0, toInt(args[1], 0)) : 0;
  if (second > 0) {
    return {
      characterID: first || getCharacterID(session),
      siteID: second,
    };
  }
  return {
    characterID: getCharacterID(session),
    siteID: first,
  };
}

function normalizeOperationSpawnpointRecord(record) {
  const source = normalizeObject(record);
  const siteID = Math.max(0, toInt(source.siteID, 0));
  const characterID = Math.max(
    0,
    toInt(source.characterID, toInt(source.charID, toInt(source.charid, 0))),
  );
  if (siteID <= 0) {
    return null;
  }
  const position = clonePosition(source.position || source);
  return {
    characterID,
    siteID,
    solarSystemID: Math.max(
      0,
      toInt(source.solarSystemID, toInt(source.solarsystemid2, toInt(source.solarsystemid, 0))),
    ) || null,
    spawnID: Math.max(0, toInt(source.spawnID, toInt(source.spawnId, 0))) || null,
    ...(source.dungeonInstanceID ? { dungeonInstanceID: Math.max(0, toInt(source.dungeonInstanceID, 0)) } : {}),
    position,
    isOperationSite: source.isOperationSite === false ? false : true,
  };
}

function registerOperationSpawnpointRecord(record) {
  const normalized = normalizeOperationSpawnpointRecord(record);
  if (!normalized) {
    return null;
  }
  operationSpawnpointRecords.set(
    buildOperationSpawnpointKey(normalized.characterID, normalized.siteID),
    normalized,
  );
  return normalized;
}

function resolveOperationSpawnpointRecord(characterID, siteID) {
  const numericSiteID = Math.max(0, toInt(siteID, 0));
  if (numericSiteID <= 0) {
    return null;
  }
  const numericCharacterID = Math.max(0, toInt(characterID, 0));
  return (
    operationSpawnpointRecords.get(buildOperationSpawnpointKey(numericCharacterID, numericSiteID)) ||
    operationSpawnpointRecords.get(buildOperationSpawnpointKey(0, numericSiteID)) ||
    null
  );
}

function clearOperationSpawnpointRecords() {
  operationSpawnpointRecords.clear();
}

function removeOperationSpawnpointRecord(characterID, siteID) {
  return operationSpawnpointRecords.delete(buildOperationSpawnpointKey(characterID, siteID));
}

// A pilot's own authored operation site (the AIR tutorial's rescue, combat and mining sites):
// offsetX metres from the pilot's ship in x, on the first free lane in z, lanes this far apart
// (a grid bubble is about 7,900 km across). Every pilot starts these from the same undock point,
// and sites in one spot showed each pilot the other's ships, rocks and NPCs. A lane is free when
// no active site of the system and nothing else in space stands within half a lane of its point;
// a removed site frees its lane. The warps between these sites run in x, across the lanes.
const PILOT_SITE_LANE_METERS = 20000000;
function pilotLanePosition(session, offsetX) {
  const scene = require("../../space/runtime").getSceneForSession(session);
  const ship = scene && typeof scene.getShipEntityForSession === "function" ? scene.getShipEntityForSession(session) : null;
  if (!ship || !getCharacterID(session)) return undefined;
  // Taken: an active site, or anything else in space there (a wreck an earlier pilot left).
  const taken = [
    ...require("./dungeonRuntime").listActiveInstancesBySystem(scene.systemID, { full: true }).map((instance) => instance && instance.position),
    ...(typeof scene.getDynamicEntities === "function" ? scene.getDynamicEntities() : []).filter((entity) => entity !== ship).map((entity) => entity && entity.position),
  ].filter(Boolean);
  for (let lane = 0; ; lane += 1) {
    const point = { x: ship.position.x + offsetX, y: ship.position.y, z: ship.position.z + lane * PILOT_SITE_LANE_METERS };
    if (!taken.some((position) => Math.hypot(position.x - point.x, position.y - point.y, position.z - point.z) < PILOT_SITE_LANE_METERS / 2)) return point;
  }
}

module.exports = {
  buildOperationSpawnpointKey,
  clearOperationSpawnpointRecords,
  getCharacterID,
  normalizeOperationSpawnpointRecord,
  pilotLanePosition,
  registerOperationSpawnpointRecord,
  removeOperationSpawnpointRecord,
  resolveOperationSiteArgs,
  resolveOperationSpawnpointRecord,
};
