"use strict";

/**
 * Tie a refinery or Metenox to the moon it was deployed at, and give it that
 * moon's ores.
 *
 * Deployment already records the moon mining beacon within 250 km in
 * `devFlags.moonMiningBeaconID` (structureDeploymentPlacement), and the moon
 * drill fit check reads it. This module turns that beacon into the canonical
 * moon binding (`structureState.bindStructureToMoon`) and seeds
 * `moonExtractions.resourcesByStructureID` from the installed moon composition
 * pack (moonCompositionRuntime), the same source survey probes read.
 *
 * Anchoring binds new structures. Structures anchored before this existed, or
 * whose seed predates the installed pack, are brought up to date the first
 * time moon mining asks for them (`ensureMoonMiningReady`).
 */

const path = require("path");

const log = require(path.join(__dirname, "../../utils/logger"));
const database = require(path.join(__dirname, "../../gameStore"));
const worldData = require(path.join(__dirname, "../../space/worldData"));
const { isPochvenSystem } = require(path.join(__dirname, "../../space/pochvenPolicy"));
const pirateFactionPolicy = require(path.join(__dirname, "../../space/npc/pirateFactionPolicy"));
const {
  MINING_POINT_STATUS,
  MOON_MINING_MODE,
  MOON_MINING_SECURITY_CLASS,
  classifyKnownSpaceSecurity,
  evaluateMoonMiningLocationEligibility,
} = require(path.join(__dirname, "./moonMiningEligibility"));
const { getMoonComposition } = require(path.join(__dirname, "./moonCompositionRuntime"));

const MOON_EXTRACTIONS_TABLE = "moonExtractions";
const TYPE_METENOX_MOON_DRILL = 81826;
const STRUCTURE_FAMILY_REFINERY = "refinery";
const DEFAULT_AUTO_FRACTURE_DELAY_SECONDS = 10800;
const ATTRIBUTE_AUTO_FRACTURE_DELAY = 2698;
const ATTRIBUTE_MOON_YIELD_MULTIPLIER = 2704;

function lazy(relativeId) {
  return require(path.join(__dirname, relativeId));
}

function toPositiveInt(value) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : 0;
}

function toFiniteNumber(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function readStructure(structureID) {
  return lazy("./structureState").getStructureByID(structureID, { refresh: false }) || null;
}

/** manual for a refinery, metenox for the Metenox, null for anything else. */
function resolveMoonMiningMode(structure) {
  if (!structure) {
    return null;
  }
  if (toPositiveInt(structure.typeID) === TYPE_METENOX_MOON_DRILL) {
    return MOON_MINING_MODE.METENOX;
  }
  return String(structure.structureFamily || "").toLowerCase() === STRUCTURE_FAMILY_REFINERY
    ? MOON_MINING_MODE.MANUAL
    : null;
}

function resolveSecurityClass(solarSystemID, system) {
  if (isPochvenSystem(solarSystemID, system)) {
    return MOON_MINING_SECURITY_CLASS.POCHVEN;
  }
  if (pirateFactionPolicy.isWormholeSpaceSystem(solarSystemID)) {
    return MOON_MINING_SECURITY_CLASS.WORMHOLE;
  }
  if (pirateFactionPolicy.isSpecialSpaceSystem(solarSystemID, system)) {
    return null;
  }
  return classifyKnownSpaceSecurity(Number(system && (system.security ?? system.securityStatus)));
}

function findMiningPoint(solarSystemID, beaconID) {
  return (worldData.getMoonMiningPointsForSystem(solarSystemID) || []).find((point) => (
    toPositiveInt(point && point.beaconID) === beaconID ||
    toPositiveInt(point && point.itemID) === beaconID
  )) || null;
}

/**
 * The beacon the structure was deployed at. Deployment records it; a structure
 * placed some other way (GM seeding) gets the same 250 km rule deployment
 * uses, and the result is recorded so the moon drill fit check accepts it.
 * The search reads only the system's moon mining points: the deployment
 * helper's full ball list reads structures, which would run the structure
 * tick from inside it.
 */
function findBeaconInRange(structure) {
  const position = structure.position;
  if (!position) {
    return 0;
  }
  const { MAXIMUM_MINING_BEACON_DISTANCE } = lazy("./structureDeploymentPlacement");
  let best = null;
  for (const point of worldData.getMoonMiningPointsForSystem(structure.solarSystemID) || []) {
    const beaconPosition = point && point.position;
    if (!beaconPosition) {
      continue;
    }
    const distance = Math.hypot(
      Number(beaconPosition.x) - Number(position.x),
      Number(beaconPosition.y) - Number(position.y),
      Number(beaconPosition.z) - Number(position.z),
    );
    if (distance < MAXIMUM_MINING_BEACON_DISTANCE && (!best || distance < best.distance)) {
      best = { beaconID: toPositiveInt(point.beaconID) || toPositiveInt(point.itemID), distance };
    }
  }
  return best ? best.beaconID : 0;
}

function resolveDeploymentBeaconID(structure) {
  const devFlags = structure.devFlags && typeof structure.devFlags === "object"
    ? structure.devFlags
    : {};
  const recorded = toPositiveInt(devFlags.moonMiningBeaconID);
  if (recorded && devFlags.moonMiningLocationVerified === true) {
    return recorded;
  }
  const found = findBeaconInRange(structure);
  if (!found) {
    return 0;
  }
  const result = lazy("./structureState").updateStructureRecord(structure.structureID, (current) => ({
    ...current,
    devFlags: {
      ...(current.devFlags || {}),
      moonMiningBeaconID: found,
      moonMiningLocationVerified: true,
    },
  }));
  if (!result || result.success !== true) {
    log.warn(
      `[MoonMiningBinding] could not record beacon ${found} on structure ${structure.structureID}: ` +
        `${(result && result.errorMsg) || "UNKNOWN"}`,
    );
  }
  return found;
}

function readStructureTypeAttribute(typeID, attributeID, fallback) {
  const { getTypeAttributeMap } = lazy("../fitting/liveFittingState");
  const attributes = getTypeAttributeMap(toPositiveInt(typeID)) || {};
  return toFiniteNumber(attributes[attributeID], fallback);
}

function readResourceProfileRecord(structureID) {
  const result = database.read(MOON_EXTRACTIONS_TABLE, `/resourcesByStructureID/${structureID}`);
  return result && result.success && result.data && typeof result.data === "object"
    ? result.data
    : null;
}

function resourcesFromComposition(composition) {
  const resources = {};
  for (const row of composition) {
    resources[String(row.typeID)] = row.fraction;
  }
  return resources;
}

/**
 * Seed the structure's moon ores from the installed pack. A seed made from
 * the installed pack is left alone, and so is one without a pack version,
 * which an operator or a test wrote by hand. A seed from an older pack is
 * replaced, keeping the Metenox harvest fields it carries.
 */
function ensureMoonResourceProfile(structureID, options = {}) {
  const structure = readStructure(toPositiveInt(structureID));
  const moonID = toPositiveInt(structure && (
    structure.moonID ||
    (structure.moonMiningBinding && structure.moonMiningBinding.moonID)
  ));
  if (!structure || !moonID) {
    return { success: false, errorMsg: "STRUCTURE_NOT_BOUND" };
  }
  const existing = readResourceProfileRecord(structure.structureID);
  const existingIsCurrent = Boolean(
    existing &&
    toPositiveInt(existing.moonID) === moonID &&
    Object.keys(existing.resources || {}).length > 0,
  );
  if (existingIsCurrent && !existing.datasetVersion) {
    return { success: true, seeded: false, profile: existing };
  }
  const installed = getMoonComposition(moonID);
  if (!installed) {
    return existingIsCurrent
      ? { success: true, seeded: false, profile: existing }
      : { success: false, errorMsg: "MOON_COMPOSITION_UNAVAILABLE", moonID };
  }
  if (existingIsCurrent && existing.datasetVersion === installed.datasetVersion) {
    return { success: true, seeded: false, profile: existing };
  }
  const profile = {
    ...(existing && toPositiveInt(existing.moonID) === moonID ? existing : {}),
    structureID: structure.structureID,
    moonID,
    solarSystemID: toPositiveInt(structure.solarSystemID),
    ownerID: toPositiveInt(structure.ownerCorpID || structure.ownerID),
    yieldMultiplier: readStructureTypeAttribute(structure.typeID, ATTRIBUTE_MOON_YIELD_MULTIPLIER, 1) || 1,
    autoFractureDelaySeconds: readStructureTypeAttribute(
      structure.typeID,
      ATTRIBUTE_AUTO_FRACTURE_DELAY,
      DEFAULT_AUTO_FRACTURE_DELAY_SECONDS,
    ),
    resources: resourcesFromComposition(installed.composition),
    datasetVersion: installed.datasetVersion,
  };
  // Write only this structure's entry: moonExtractionsService rewrites the
  // table from its own snapshot inside a handler, so a whole-table write here
  // could put back a stale extraction.
  const result = database.write(
    MOON_EXTRACTIONS_TABLE,
    `/resourcesByStructureID/${structure.structureID}`,
    profile,
  );
  if (!result || result.success !== true) {
    return { success: false, errorMsg: (result && result.errorMsg) || "WRITE_FAILED" };
  }
  log.info(
    `[MoonMiningBinding] seeded structure=${structure.structureID} moon=${moonID} ` +
      `ores=${Object.keys(profile.resources).join(",")} source=${options.source || "unspecified"}`,
  );
  return { success: true, seeded: true, profile };
}

/**
 * Bind a refinery or Metenox to the moon at its deployment beacon, then seed
 * its ores. Structures that are not moon miners, are away from any beacon or
 * sit where moon mining is not allowed are skipped, not failed.
 */
function bindStructureToDeploymentMoon(structureID, options = {}) {
  const structure = readStructure(toPositiveInt(structureID));
  if (!structure || structure.destroyedAt) {
    return { success: false, skipped: true, errorMsg: "STRUCTURE_NOT_FOUND" };
  }
  const mode = resolveMoonMiningMode(structure);
  if (!mode) {
    return { success: true, skipped: true, reason: "NOT_A_MOON_STRUCTURE" };
  }
  if (structure.moonMiningBinding) {
    return { success: true, skipped: true, reason: "ALREADY_BOUND", seed: ensureMoonResourceProfile(structure.structureID, options) };
  }
  const beaconID = resolveDeploymentBeaconID(structure);
  if (!beaconID) {
    return { success: true, skipped: true, reason: "NO_MOON_BEACON_IN_RANGE" };
  }
  const solarSystemID = toPositiveInt(structure.solarSystemID);
  const point = findMiningPoint(solarSystemID, beaconID);
  if (!point) {
    return { success: true, skipped: true, reason: "BEACON_HAS_NO_MINING_POINT", beaconID };
  }
  const system = worldData.getSolarSystemByID(solarSystemID) || {};
  const miningPoint = {
    ...point,
    beaconID: toPositiveInt(point.beaconID) || toPositiveInt(point.itemID),
    status: MINING_POINT_STATUS.VERIFIED,
  };
  const eligibility = evaluateMoonMiningLocationEligibility({
    mode,
    system: {
      solarSystemID,
      securityClass: resolveSecurityClass(solarSystemID, system),
      securityStatus: Number(system.security ?? system.securityStatus),
    },
    moonID: toPositiveInt(point.moonID),
    miningPoint,
  });
  if (!eligibility.eligible) {
    return { success: true, skipped: true, reason: eligibility.code };
  }
  const bound = lazy("./structureState").bindStructureToMoon(structure.structureID, {
    locationEligibility: eligibility,
    miningPoint,
  }, { emitLive: options.emitLive !== false });
  if (!bound || bound.success !== true) {
    log.warn(
      `[MoonMiningBinding] structure ${structure.structureID} could not bind to moon ${point.moonID}: ` +
        `${(bound && bound.errorMsg) || "UNKNOWN"}`,
    );
    return { success: false, errorMsg: (bound && bound.errorMsg) || "BIND_FAILED" };
  }
  log.info(
    `[MoonMiningBinding] bound structure=${structure.structureID} moon=${point.moonID} ` +
      `beacon=${miningPoint.beaconID} mode=${mode} source=${options.source || "unspecified"}`,
  );
  return {
    success: true,
    bound: true,
    moonID: toPositiveInt(point.moonID),
    seed: ensureMoonResourceProfile(structure.structureID, options),
  };
}

/**
 * Make sure a moon-mining structure is bound and seeded before moon mining
 * reads it. Cheap when both are already current.
 */
function ensureMoonMiningReady(structureID, options = {}) {
  const structure = readStructure(toPositiveInt(structureID));
  if (!structure || !resolveMoonMiningMode(structure)) {
    return { success: false, errorMsg: "NOT_A_MOON_STRUCTURE" };
  }
  if (!structure.moonMiningBinding) {
    return bindStructureToDeploymentMoon(structure.structureID, options);
  }
  return ensureMoonResourceProfile(structure.structureID, options);
}

module.exports = {
  bindStructureToDeploymentMoon,
  ensureMoonMiningReady,
  ensureMoonResourceProfile,
  resolveMoonMiningMode,
};
