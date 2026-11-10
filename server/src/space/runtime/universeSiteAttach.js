"use strict";

module.exports = {
  autoMaterializeNearbyUniverseSiteForAttach,
  resolveEntityLikePosition,
};

const runtimeEntryDirname = require("path").resolve(__dirname, "..");
const path = require("path");
const log = require(path.join(runtimeEntryDirname, "../utils/logger"));
const {
  toFiniteNumber,
  toInt,
} = require("../../common/numbers");
const {
  lazyRequire,
} = require("./runtimeModuleBoundary");
const {
  distanceSquared,
} = require("../../common/vector");

const UNIVERSE_SITE_ATTACH_AUTO_MATERIALIZE_RANGE_METERS = 1_000_000;

const UNIVERSE_SITE_ATTACH_AUTO_MATERIALIZE_RANGE_SQUARED =
  UNIVERSE_SITE_ATTACH_AUTO_MATERIALIZE_RANGE_METERS ** 2;

function resolveEntityLikePosition(entity) {
  if (!entity || typeof entity !== "object") {
    return null;
  }
  if (entity.position && typeof entity.position === "object") {
    return {
      x: toFiniteNumber(entity.position.x, 0),
      y: toFiniteNumber(entity.position.y, 0),
      z: toFiniteNumber(entity.position.z, 0),
    };
  }
  if (
    Number.isFinite(toFiniteNumber(entity.x, Number.NaN)) &&
    Number.isFinite(toFiniteNumber(entity.y, Number.NaN)) &&
    Number.isFinite(toFiniteNumber(entity.z, Number.NaN))
  ) {
    return {
      x: toFiniteNumber(entity.x, 0),
      y: toFiniteNumber(entity.y, 0),
      z: toFiniteNumber(entity.z, 0),
    };
  }
  return null;
}

function autoMaterializeNearbyUniverseSiteForAttach(scene, anchorEntity, options = {}) {
  if (!scene || !anchorEntity) {
    return null;
  }
  const anchorPosition = resolveEntityLikePosition(anchorEntity);
  if (!anchorPosition) {
    return null;
  }

  let nearestSite = null;
  let nearestDistanceSquared = Number.POSITIVE_INFINITY;
  const staticEntities = Array.isArray(scene.staticEntities) ? scene.staticEntities : [];
  for (const entity of staticEntities) {
    if (
      !entity ||
      (
        entity.signalTrackerUniverseSeededSite !== true &&
        String(entity.kind || "").trim() !== "missionSite"
      )
    ) {
      continue;
    }
    const entityPosition = resolveEntityLikePosition(entity);
    if (!entityPosition) {
      continue;
    }
    const candidateDistanceSquared = distanceSquared(anchorPosition, entityPosition);
    if (
      candidateDistanceSquared > UNIVERSE_SITE_ATTACH_AUTO_MATERIALIZE_RANGE_SQUARED ||
      candidateDistanceSquared >= nearestDistanceSquared
    ) {
      continue;
    }
    nearestSite = entity;
    nearestDistanceSquared = candidateDistanceSquared;
  }

  if (!nearestSite) {
    return null;
  }

  try {
    const dungeonUniverseSiteService = lazyRequire("../services/dungeon/dungeonUniverseSiteService");
    if (
      !dungeonUniverseSiteService ||
      typeof dungeonUniverseSiteService.ensureSiteContentsMaterialized !== "function"
    ) {
      return null;
    }
    return dungeonUniverseSiteService.ensureSiteContentsMaterialized(scene, nearestSite, {
      spawnEncounters: true,
      broadcast: options.broadcast === true,
      excludedSession: options.excludedSession || null,
      session: options.session || anchorEntity.session || null,
      nowMs: options.nowMs,
    });
  } catch (error) {
    log.warn(
      `[SpaceRuntime] attach-session site auto-materialize failed for system=${toInt(scene && scene.systemID, 0)}: ${error.message}`,
    );
    return null;
  }
}

Object.assign(module.exports, {
  UNIVERSE_SITE_ATTACH_AUTO_MATERIALIZE_RANGE_METERS,
  UNIVERSE_SITE_ATTACH_AUTO_MATERIALIZE_RANGE_SQUARED,
});
