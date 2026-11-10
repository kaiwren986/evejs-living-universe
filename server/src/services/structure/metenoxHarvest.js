"use strict";

/**
 * What a Metenox Moon Drill harvests each hour.
 *
 * Retail (Equinox notes; CCP_Kestrel on the 22.01 known-issues thread): the
 * drill mines 30,000 m3 of the moon's ore per hour, reprocesses it at 40%,
 * and keeps only the moon materials; ordinary minerals are discarded. A
 * player report on the same thread, 42.59% Zeolites giving 332 Atmospheric
 * Gases a cycle, is exactly floor(0.4259 x 30,000 / 10 / 100 x 65 x 0.4).
 * The client's output whitelist (typeList 611) is group 427, Moon Materials.
 *
 * Output lands in the Moon Material Bay (flag 186, attribute 5693 capacity).
 * The drill window (autoMoonMiningService) reads the cycle output and harvest
 * times from the structure's moon profile, which this module keeps current.
 */

const path = require("path");

const log = require(path.join(__dirname, "../../utils/logger"));
const { getWallclockNowMs } = require(path.join(__dirname, "../../space/runtime/runtimeClock"));
const database = require(path.join(__dirname, "../../gameStore"));
const { resolveItemByTypeID } = require(path.join(__dirname, "../inventory/itemTypeRegistry"));

const ORE_M3_PER_HOUR = 30_000;
const REPROCESSING_EFFICIENCY = 0.4;
const CYCLE_SECONDS = 3600;
const GROUP_MOON_MATERIAL = 427;
const FLAG_MOON_MATERIAL_BAY = 186;
const ATTRIBUTE_OUTPUT_BAY_CAPACITY = 5693;
const DEFAULT_OUTPUT_BAY_CAPACITY = 500_000;
const MOON_EXTRACTIONS_TABLE = "moonExtractions";

// The structure tick runs several times a second for every Metenox. Remember
// the schedule last written per structure, so an unchanged one costs a Map
// lookup rather than a profile read and output computation.
const lastSettledScheduleByStructureID = new Map();

function toPositiveInt(value) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : 0;
}

function toFiniteNumber(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function isMoonMaterialType(typeID) {
  const type = resolveItemByTypeID(typeID);
  return Boolean(type && Number(type.groupID) === GROUP_MOON_MATERIAL);
}

/**
 * Moon materials per one-hour cycle for a moon composition
 * ({oreTypeID: fraction}). Each material is summed over the ores that give
 * it, then rounded down once.
 */
function computeCycleOutput(resources) {
  const { getTypeMaterials } = require(path.join(__dirname, "../reprocessing/reprocessingStaticData"));
  const exact = new Map();
  for (const [rawTypeID, rawFraction] of Object.entries(resources || {})) {
    const oreTypeID = toPositiveInt(rawTypeID);
    const fraction = toFiniteNumber(rawFraction, 0);
    const ore = oreTypeID ? resolveItemByTypeID(oreTypeID) : null;
    if (!ore || !(fraction > 0)) {
      continue;
    }
    const unitVolume = Math.max(0.000001, toFiniteNumber(ore.volume, 10));
    const portionSize = Math.max(1, toPositiveInt(ore.portionSize) || 100);
    const batches = (fraction * ORE_M3_PER_HOUR) / unitVolume / portionSize;
    for (const material of getTypeMaterials(oreTypeID)) {
      const materialTypeID = toPositiveInt(material && material.materialTypeID);
      if (!materialTypeID || !isMoonMaterialType(materialTypeID)) {
        continue;
      }
      const amount = batches * toFiniteNumber(material.quantity, 0) * REPROCESSING_EFFICIENCY;
      exact.set(materialTypeID, (exact.get(materialTypeID) || 0) + amount);
    }
  }
  const output = {};
  for (const [materialTypeID, amount] of [...exact.entries()].sort((left, right) => left[0] - right[0])) {
    const units = Math.floor(amount + 1e-9);
    if (units > 0) {
      output[String(materialTypeID)] = units;
    }
  }
  return output;
}

function readProfile(structureID) {
  const result = database.read(MOON_EXTRACTIONS_TABLE, `/resourcesByStructureID/${structureID}`);
  return result && result.success && result.data && typeof result.data === "object"
    ? result.data
    : null;
}

function writeProfileFields(structureID, profile, fields) {
  const changed = Object.entries(fields).some(
    ([key, value]) => JSON.stringify(profile[key]) !== JSON.stringify(value),
  );
  if (!changed) {
    return true;
  }
  const result = database.write(
    MOON_EXTRACTIONS_TABLE,
    `/resourcesByStructureID/${structureID}`,
    { ...profile, ...fields },
  );
  return Boolean(result && result.success === true);
}

/**
 * The Metenox's seeded moon profile. The harvest runs inside the structure
 * tick, where binding a structure (which rewrites the structure table) is not
 * safe; anchoring and the drill window's own calls bind and seed instead.
 */
function readReadyProfile(structureID) {
  const profile = readProfile(structureID);
  return profile && Object.keys(profile.resources || {}).length > 0 ? profile : null;
}

function readOutputBayUsedVolume(structureID) {
  const { listContainerItems } = require(path.join(__dirname, "../inventory/itemStore"));
  let used = 0;
  for (const item of listContainerItems(null, structureID, FLAG_MOON_MATERIAL_BAY) || []) {
    const type = resolveItemByTypeID(item && item.typeID) || {};
    const quantity = Math.max(0, toFiniteNumber(item && (item.stacksize ?? item.quantity), 0));
    used += Math.max(0, toFiniteNumber(type.volume, 0)) * quantity;
  }
  return used;
}

function readOutputBayCapacity(structure) {
  const { getTypeAttributeMap } = require(path.join(__dirname, "../fitting/liveFittingState"));
  const attributes = getTypeAttributeMap(toPositiveInt(structure && structure.typeID)) || {};
  return Math.max(0, toFiniteNumber(attributes[ATTRIBUTE_OUTPUT_BAY_CAPACITY], DEFAULT_OUTPUT_BAY_CAPACITY));
}

/**
 * Put `cycles` hours of output in the Moon Material Bay. When the bay cannot
 * take all of it, every material is cut by the same share so the mix stays
 * true; a full bay takes nothing.
 */
function deliverOutput(structure, cycleOutput, cycles) {
  const structureID = toPositiveInt(structure && structure.structureID);
  const ownerID = toPositiveInt(structure && (structure.ownerCorpID || structure.ownerID));
  if (!structureID || !ownerID || cycles <= 0) {
    return { delivered: {}, changes: [] };
  }
  const wanted = Object.entries(cycleOutput).map(([typeID, units]) => ({
    typeID: toPositiveInt(typeID),
    units: units * cycles,
    unitVolume: Math.max(0, toFiniteNumber((resolveItemByTypeID(typeID) || {}).volume, 0)),
  }));
  const wantedVolume = wanted.reduce((sum, entry) => sum + entry.units * entry.unitVolume, 0);
  const freeVolume = Math.max(0, readOutputBayCapacity(structure) - readOutputBayUsedVolume(structureID));
  const share = wantedVolume > freeVolume && wantedVolume > 0 ? freeVolume / wantedVolume : 1;
  const { grantItemToOwnerLocation } = require(path.join(__dirname, "../inventory/itemStore"));
  const delivered = {};
  const changes = [];
  for (const entry of wanted) {
    const units = Math.floor(entry.units * share);
    if (!entry.typeID || units <= 0) {
      continue;
    }
    const result = grantItemToOwnerLocation(
      ownerID,
      structureID,
      FLAG_MOON_MATERIAL_BAY,
      resolveItemByTypeID(entry.typeID),
      units,
    );
    if (!result || result.success !== true) {
      log.warn(
        `[MetenoxHarvest] Metenox ${structureID} could not store ${units} of type ${entry.typeID}: ` +
          `${(result && result.errorMsg) || "UNKNOWN"}`,
      );
      continue;
    }
    delivered[String(entry.typeID)] = units;
    changes.push(...((result.data && result.data.changes) || []));
  }
  return { delivered, changes };
}

/**
 * Keep the drill window's view current and harvest completed cycles.
 *
 * @param {object} structure the Metenox after its fuel cycle
 * @param {object} options
 * @param {boolean} options.online whether the drill service runs
 * @param {number} [options.nextHarvestMs] when the next cycle completes
 * @param {number} [options.cycles] completed, paid-for cycles to harvest now
 * @param {number} [options.nowMs]
 */
function settleMetenoxHarvest(structure, options = {}) {
  const structureID = toPositiveInt(structure && structure.structureID);
  if (!structureID) {
    return { changes: [] };
  }
  const cycles = Math.max(0, Math.trunc(toFiniteNumber(options.cycles, 0)));
  const nextHarvestMs = options.online === true
    ? Math.max(0, Math.trunc(toFiniteNumber(options.nextHarvestMs, 0)))
    : 0;
  const scheduleKey = `${options.online === true}:${nextHarvestMs}`;
  if (cycles === 0 && lastSettledScheduleByStructureID.get(structureID) === scheduleKey) {
    return { changes: [] };
  }
  const profile = readReadyProfile(structureID);
  if (!profile) {
    return { changes: [] };
  }
  if (options.online !== true) {
    if (writeProfileFields(structureID, profile, {
      nextHarvestTimeMs: 0,
      miningCycleTimeSeconds: 0,
    })) {
      lastSettledScheduleByStructureID.set(structureID, scheduleKey);
    }
    return { changes: [] };
  }
  const cycleOutput = computeCycleOutput(profile.resources);
  const harvest = cycles > 0
    ? deliverOutput(structure, cycleOutput, cycles)
    : { delivered: {}, changes: [] };
  const fields = {
    autoMoonMiningCycleOutput: cycleOutput,
    nextHarvestTimeMs: nextHarvestMs,
    miningCycleTimeSeconds: CYCLE_SECONDS,
  };
  if (cycles > 0) {
    fields.lastHarvestTimeMs = Math.max(0, Math.trunc(toFiniteNumber(options.nowMs, getWallclockNowMs())));
  }
  if (writeProfileFields(structureID, profile, fields)) {
    lastSettledScheduleByStructureID.set(structureID, scheduleKey);
  }
  return { delivered: harvest.delivered, changes: harvest.changes, cycleOutput };
}

function resetMetenoxHarvestForTests() {
  lastSettledScheduleByStructureID.clear();
}

module.exports = {
  CYCLE_SECONDS,
  FLAG_MOON_MATERIAL_BAY,
  ORE_M3_PER_HOUR,
  REPROCESSING_EFFICIENCY,
  computeCycleOutput,
  resetMetenoxHarvestForTests,
  settleMetenoxHarvest,
};
