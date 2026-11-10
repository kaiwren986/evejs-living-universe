"use strict";

const crypto = require("node:crypto");

const MOON_MINING_BEACON_TYPE_ID = 46329;
const MOON_MINING_BEACON_GROUP_ID = 1915;
const MOON_MINING_BEACON_ID_BASE = 1_000_000_000;
const POCHVEN_REGION_ID = 10000070;

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function finiteVector(value) {
  return Boolean(value) && typeof value === "object" &&
    Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z);
}

function clonePoint(point) {
  return Object.freeze({
    moonID: point.moonID,
    solarSystemID: point.solarSystemID,
    beaconID: point.beaconID,
    itemID: point.beaconID,
    typeID: MOON_MINING_BEACON_TYPE_ID,
    groupID: MOON_MINING_BEACON_GROUP_ID,
    position: Object.freeze({ ...point.position }),
    distanceFromMoon: point.distanceFromMoon,
    datasetVersion: point.datasetVersion,
  });
}

function distanceBetween(left, right) {
  return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}

function roundDisplayedSecurityStatus(value) {
  if (!Number.isFinite(value) || value < -1 || value > 1) return null;
  if (value > 0 && value < 0.05) return 0.1;
  const rounded = value >= 0
    ? Math.floor((value * 10) + 0.5) / 10
    : Math.ceil((value * 10) - 0.5) / 10;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function isMinableSystem(system) {
  if (!system || typeof system !== "object") return false;
  const systemID = Number(system.solarSystemID);
  if (!Number.isInteger(systemID) || systemID <= 0) return false;
  if (Number(system.regionID) === POCHVEN_REGION_ID) return false;
  if (systemID >= 31_000_000 && systemID < 32_000_000) return true;
  const displayedSecurity = roundDisplayedSecurityStatus(Number(system.security));
  return displayedSecurity !== null && displayedSecurity <= 0.5;
}

function calculateMoonMiningPointContentHash(points) {
  const hash = crypto.createHash("sha256");
  for (const point of [...points].sort((left, right) => left.moonID - right.moonID)) {
    hash.update(JSON.stringify([
      point.moonID,
      point.solarSystemID,
      point.beaconID,
      point.position.x,
      point.position.y,
      point.position.z,
      point.distanceFromMoon,
    ]));
    hash.update("\n");
  }
  return hash.digest("hex");
}

function createMoonMiningPointAuthority({ data, moonsByID, systemsByID } = {}) {
  if (!data || typeof data !== "object" || !Array.isArray(data.points)) {
    return Object.freeze({
      metadata: null,
      getPointByMoonID() { return null; },
      getPointsForSystem() { return []; },
      getAllPoints() { return []; },
    });
  }
  if (data.schemaVersion !== 1 || typeof data.datasetVersion !== "string" ||
    !data.datasetVersion.trim() || !isPositiveInteger(data.sourceBuild)) {
    throw new TypeError("moon mining point authority has an invalid header");
  }

  const pointsByMoonID = new Map();
  const pointsBySystemID = new Map();
  const normalized = [];
  for (const rawPoint of data.points) {
    if (!rawPoint || typeof rawPoint !== "object" ||
      !isPositiveInteger(rawPoint.moonID) || !isPositiveInteger(rawPoint.solarSystemID) ||
      !finiteVector(rawPoint.position) || !Number.isFinite(rawPoint.distanceFromMoon) ||
      rawPoint.distanceFromMoon <= 0) {
      throw new TypeError("moon mining point authority contains an invalid point");
    }
    const beaconID = rawPoint.beaconID == null
      ? MOON_MINING_BEACON_ID_BASE + rawPoint.moonID
      : Number(rawPoint.beaconID);
    if (!isPositiveInteger(beaconID) || beaconID !== MOON_MINING_BEACON_ID_BASE + rawPoint.moonID) {
      throw new TypeError(`moon ${rawPoint.moonID} has an invalid deterministic beacon ID`);
    }
    if (pointsByMoonID.has(rawPoint.moonID)) {
      throw new TypeError(`moon mining point authority duplicates moon ${rawPoint.moonID}`);
    }
    const moon = moonsByID && moonsByID.get(rawPoint.moonID);
    const system = systemsByID && systemsByID.get(rawPoint.solarSystemID);
    if (!moon || Number(moon.groupID) !== 8 || Number(moon.solarSystemID) !== rawPoint.solarSystemID || !system) {
      throw new TypeError(`moon mining point ${rawPoint.moonID} does not match the installed universe`);
    }
    const actualDistance = distanceBetween(moon.position, rawPoint.position);
    if (Math.abs(actualDistance - rawPoint.distanceFromMoon) > 1) {
      throw new TypeError(`moon mining point ${rawPoint.moonID} fails its moon-offset check`);
    }
    const point = clonePoint({
      moonID: rawPoint.moonID,
      solarSystemID: rawPoint.solarSystemID,
      beaconID,
      position: rawPoint.position,
      distanceFromMoon: rawPoint.distanceFromMoon,
      datasetVersion: data.datasetVersion.trim(),
    });
    normalized.push(point);
    if (!isMinableSystem(system)) continue;
    pointsByMoonID.set(point.moonID, point);
    if (!pointsBySystemID.has(point.solarSystemID)) pointsBySystemID.set(point.solarSystemID, []);
    pointsBySystemID.get(point.solarSystemID).push(point);
  }
  const contentHash = calculateMoonMiningPointContentHash(normalized);
  if (typeof data.contentHash !== "string" || data.contentHash.toLowerCase() !== contentHash) {
    throw new TypeError("moon mining point authority content hash does not match its points");
  }
  for (const points of pointsBySystemID.values()) points.sort((left, right) => left.moonID - right.moonID);
  const metadata = Object.freeze({
    schemaVersion: 1,
    datasetVersion: data.datasetVersion.trim(),
    sourceBuild: data.sourceBuild,
    contentHash,
    source: data.source || null,
    totalPointCount: normalized.length,
    minablePointCount: pointsByMoonID.size,
  });
  return Object.freeze({
    metadata,
    getPointByMoonID(moonID) { return pointsByMoonID.get(Number(moonID)) || null; },
    getPointsForSystem(solarSystemID) {
      return [...(pointsBySystemID.get(Number(solarSystemID)) || [])];
    },
    getAllPoints() { return [...pointsByMoonID.values()]; },
  });
}

module.exports = {
  MOON_MINING_BEACON_GROUP_ID,
  MOON_MINING_BEACON_ID_BASE,
  MOON_MINING_BEACON_TYPE_ID,
  calculateMoonMiningPointContentHash,
  createMoonMiningPointAuthority,
  isMinableSystem,
  roundDisplayedSecurityStatus,
};
