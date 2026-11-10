"use strict";

/**
 * The numbers of moon extraction: how much a chunk holds, how its ores split,
 * how long a chunk waits before it fractures itself, and how long the ore
 * field lasts.
 *
 * Sources:
 * - Yield: the client's own planner, `moonmining/util.py`
 *   CalculateExtractionTotalYield = 720,000 m3 per day of extraction x the
 *   structure's moonYieldMultiplier (attribute 2704), and each ore's share is
 *   its composition fraction of that volume (`outputCont.py`).
 * - Rigs: the SDE rig effects are item modifiers on the structure itself.
 *   rigMoonSpewVolBonus raises 2704 by attribute 2710, rigMoonFractureDelay
 *   raises autoFractureDelay 2698 by 2707, rigMoonAsteroidDecayBonus raises
 *   moonAsteroidDecayTimeMultiplier 2706 by 2708, and rigMoonSpewRadBonus
 *   changes moonAsteroidFieldRadius 2705 by 2709.
 * - Field lifetime: the refinery hull's asteroidDecayTimeDisplayUpdate effect
 *   multiplies its 48-hour decay display (attribute 2728) by 2706, so a
 *   Stability II rig (+100%) gives 96 hours. The client's
 *   ASTEROID_DECAY_DURATION is the same 172,800 seconds.
 */

const path = require("path");

const YIELD_PER_DAY_M3 = 720_000;
const SECONDS_PER_DAY = 86_400;
const DEFAULT_AUTO_FRACTURE_DELAY_SECONDS = 10_800;
const DEFAULT_FIELD_DECAY_HOURS = 48;

const ATTRIBUTE = Object.freeze({
  AUTO_FRACTURE_DELAY: 2698,
  MOON_YIELD_MULTIPLIER: 2704,
  MOON_ASTEROID_FIELD_RADIUS: 2705,
  MOON_ASTEROID_DECAY_TIME_MULTIPLIER: 2706,
  MOON_ASTEROID_DECAY_DISPLAY_HOURS: 2728,
});
const MOON_STRUCTURE_ATTRIBUTE_IDS = new Set([
  ATTRIBUTE.AUTO_FRACTURE_DELAY,
  ATTRIBUTE.MOON_YIELD_MULTIPLIER,
  ATTRIBUTE.MOON_ASTEROID_FIELD_RADIUS,
  ATTRIBUTE.MOON_ASTEROID_DECAY_TIME_MULTIPLIER,
]);
const STRUCTURE_RIG_FLAGS = new Set([92, 93, 94, 95, 96, 97, 98, 99]);

function toFiniteNumber(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function toPositiveInt(value) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : 0;
}

/**
 * The moon-mining attributes of a structure with its fitted rigs applied.
 * Reads the fit from the item store; pass `rigTypeIDs` to evaluate a fit
 * without one.
 */
function resolveStructureMoonAttributes(structure, options = {}) {
  const liveFittingState = require(path.join(__dirname, "../fitting/liveFittingState"));
  const structureTypeID = toPositiveInt(structure && structure.typeID);
  const attributes = { ...liveFittingState.getTypeAttributeMap(structureTypeID) };
  const rigTypeIDs = Array.isArray(options.rigTypeIDs)
    ? options.rigTypeIDs.map(toPositiveInt).filter(Boolean)
    : listFittedRigTypeIDs(structure);
  const modifierEntries = [];
  for (const rigTypeID of rigTypeIDs) {
    const rigAttributes = liveFittingState.getTypeAttributeMap(rigTypeID);
    for (const effect of liveFittingState.getTypeEffectRecords(rigTypeID)) {
      for (const modifier of (effect && effect.modifierInfo) || []) {
        if (
          !modifier ||
          modifier.domain !== "structureID" ||
          modifier.func !== "ItemModifier" ||
          !MOON_STRUCTURE_ATTRIBUTE_IDS.has(toPositiveInt(modifier.modifiedAttributeID))
        ) {
          continue;
        }
        const value = toFiniteNumber(rigAttributes[toPositiveInt(modifier.modifyingAttributeID)], NaN);
        if (!Number.isFinite(value)) {
          continue;
        }
        modifierEntries.push({
          modifiedAttributeID: modifier.modifiedAttributeID,
          operation: modifier.operation,
          value,
          stackingPenalized: true,
        });
      }
    }
  }
  if (modifierEntries.length > 0) {
    liveFittingState.applyModifierGroups(attributes, modifierEntries);
  }
  const decayMultiplier = Math.max(
    0,
    toFiniteNumber(attributes[ATTRIBUTE.MOON_ASTEROID_DECAY_TIME_MULTIPLIER], 1),
  );
  const decayDisplayHours = toFiniteNumber(
    attributes[ATTRIBUTE.MOON_ASTEROID_DECAY_DISPLAY_HOURS],
    DEFAULT_FIELD_DECAY_HOURS,
  );
  return {
    yieldMultiplier: Math.max(0, toFiniteNumber(attributes[ATTRIBUTE.MOON_YIELD_MULTIPLIER], 1)),
    autoFractureDelaySeconds: Math.max(
      0,
      toFiniteNumber(attributes[ATTRIBUTE.AUTO_FRACTURE_DELAY], DEFAULT_AUTO_FRACTURE_DELAY_SECONDS),
    ),
    fieldRadiusMultiplier: Math.max(0, toFiniteNumber(attributes[ATTRIBUTE.MOON_ASTEROID_FIELD_RADIUS], 1)),
    fieldDecaySeconds: Math.round(decayDisplayHours * 3600 * decayMultiplier),
  };
}

function listFittedRigTypeIDs(structure) {
  const structureID = toPositiveInt(structure && structure.structureID);
  if (!structureID) {
    return [];
  }
  const { listContainerItems } = require(path.join(__dirname, "../inventory/itemStore"));
  return (listContainerItems(null, structureID, null) || [])
    .filter((item) => item && STRUCTURE_RIG_FLAGS.has(Number(item.flagID)))
    .map((item) => toPositiveInt(item.typeID))
    .filter(Boolean);
}

/** Chunk volume in m3, as the client's planner computes it. */
function computeChunkVolumeM3(durationSeconds, yieldMultiplier) {
  const duration = Math.max(0, toFiniteNumber(durationSeconds, 0));
  const multiplier = Math.max(0, toFiniteNumber(yieldMultiplier, 1));
  return (YIELD_PER_DAY_M3 * duration / SECONDS_PER_DAY) * multiplier;
}

/**
 * Split a chunk by composition. The result is m3 per ore type, the
 * `oreVolumeByType` the moon-mining notifications carry.
 */
function computeOreVolumeByType(resources, chunkVolumeM3) {
  const volume = Math.max(0, toFiniteNumber(chunkVolumeM3, 0));
  const result = {};
  for (const [rawTypeID, rawFraction] of Object.entries(resources || {})) {
    const typeID = toPositiveInt(rawTypeID);
    const fraction = toFiniteNumber(rawFraction, 0);
    if (typeID && fraction > 0) {
      result[String(typeID)] = fraction * volume;
    }
  }
  return result;
}

// ── Chunk and field geometry ─────────────────────────────────────────
//
// Neither the client nor the SDE fixes where the chunk arrives, how many
// rocks it breaks into or how far they spread; the client only draws what the
// server places. Players report the field about 100 km from the refinery,
// inside the 150 km minimum warp distance so it cannot be warped to from the
// structure; CCP describes it as out of effective mining reach from docking
// range, and says "for longer extractions you get more asteroids, and they
// will be also be bigger". The rock count and field size are project values
// that follow those descriptions.
const CHUNK_ARRIVAL_DISTANCE_METERS = 100_000;
const FIELD_BASE_RADIUS_METERS = 15_000;
const FIELD_REFERENCE_VOLUME_M3 = 4_320_000;
const FIELD_REFERENCE_ROCKS = 30;
const FIELD_MAX_ROCKS = 200;
const FIELD_ROCK_SIZE_SPREAD = 0.4;

// ── Ore grades ───────────────────────────────────────────────────────
//
// Every moon ore has a +15% grade (Brimful, Copious, Lavish, Replete,
// Bountiful) and a +100% grade (Glistening, Twinkling, Shimmering, Glowing,
// Shining) with the same volume per unit and more minerals per batch. A
// survey shows only the base ore. CCP_Masterplan (Lifeblood, 2017): on
// fracture a few asteroids randomly become the +15% type, and occasionally a
// "jackpot" fracture turns every asteroid into the +100% type. CCP never
// published either chance; players estimate about 10% for a jackpot. Both
// chances below are project values.
const JACKPOT_CHANCE = 0.1;
const IMPROVED_GRADE_ROCK_CHANCE = 0.15;
const MOON_ORE_GROUP_IDS = new Set([1884, 1920, 1921, 1922, 1923]);
const ATTRIBUTE_ASTEROID_META_LEVEL = 2699;
const ATTRIBUTE_ORE_BASIC_TYPE = 2711;
const META_LEVEL_IMPROVED = 3;
const META_LEVEL_JACKPOT = 5;

let oreGradesByBaseTypeID = null;

/**
 * Base moon ore typeID -> its +15% and +100% grades, read from the SDE:
 * each grade names its base ore in oreBasicType (2711) and its grade in
 * asteroidMetaLevel (2699: 1 base, 3 for +15%, 5 for +100%). Compressed ore
 * shares both attributes, so it is told apart by its volume.
 */
function getMoonOreGrades() {
  if (oreGradesByBaseTypeID) {
    return oreGradesByBaseTypeID;
  }
  const { listItemTypes } = require(path.join(__dirname, "../inventory/itemTypeRegistry"));
  const { getTypeAttributeMap } = require(path.join(__dirname, "../fitting/liveFittingState"));
  const grades = new Map();
  for (const type of listItemTypes()) {
    if (!type || !MOON_ORE_GROUP_IDS.has(Number(type.groupID)) || !(Number(type.volume) >= 1)) {
      continue;
    }
    const attributes = getTypeAttributeMap(type.typeID) || {};
    const baseTypeID = toPositiveInt(attributes[ATTRIBUTE_ORE_BASIC_TYPE]);
    const metaLevel = toFiniteNumber(attributes[ATTRIBUTE_ASTEROID_META_LEVEL], 0);
    if (!baseTypeID) {
      continue;
    }
    const entry = grades.get(baseTypeID) || { improved: 0, jackpot: 0 };
    if (metaLevel === META_LEVEL_IMPROVED) {
      entry.improved = toPositiveInt(type.typeID);
    } else if (metaLevel === META_LEVEL_JACKPOT) {
      entry.jackpot = toPositiveInt(type.typeID);
    }
    grades.set(baseTypeID, entry);
  }
  oreGradesByBaseTypeID = grades;
  return grades;
}

// The four Moon Chunk models (group 1940), smallest to largest, for chunks up
// to 14, 28 and 42 days of extraction and beyond.
const CHUNK_SHELL_TIERS = Object.freeze([
  Object.freeze({ typeID: 46030, maxVolumeM3: YIELD_PER_DAY_M3 * 14 }),
  Object.freeze({ typeID: 45008, maxVolumeM3: YIELD_PER_DAY_M3 * 28 }),
  Object.freeze({ typeID: 46031, maxVolumeM3: YIELD_PER_DAY_M3 * 42 }),
  Object.freeze({ typeID: 46032, maxVolumeM3: Number.POSITIVE_INFINITY }),
]);

function selectChunkShellTypeID(chunkVolumeM3) {
  const volume = Math.max(0, toFiniteNumber(chunkVolumeM3, 0));
  return CHUNK_SHELL_TIERS.find((tier) => volume <= tier.maxVolumeM3).typeID;
}

// Deterministic [0, 1) from a text seed, so a field's plan never changes.
function seededUnit(seedText) {
  let hash = 2166136261;
  for (let index = 0; index < seedText.length; index += 1) {
    hash ^= seedText.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0x5bd1e995);
  hash ^= hash >>> 15;
  return (hash >>> 0) / 0x1_0000_0000;
}

/**
 * Split a chunk into rocks. Every ore gets at least one rock and rocks go to
 * ores by volume; within an ore, rock sizes vary but the units add up to the
 * ore's whole share, so nothing is created or lost. Rocks spread through a
 * sphere around the chunk, scaled by the structure's field radius multiplier.
 */
function planFieldRocks(oreVolumeByType, options = {}) {
  const seed = String(options.seed || "moon-field");
  const resolveUnitVolume = typeof options.resolveUnitVolume === "function"
    ? options.resolveUnitVolume
    : () => 10;
  const ores = Object.entries(oreVolumeByType || {})
    .map(([rawTypeID, rawVolume]) => {
      const typeID = toPositiveInt(rawTypeID);
      const unitVolume = Math.max(0.000001, toFiniteNumber(resolveUnitVolume(typeID), 10));
      return { typeID, units: Math.floor(Math.max(0, toFiniteNumber(rawVolume, 0)) / unitVolume + 1e-9) };
    })
    .filter((ore) => ore.typeID > 0 && ore.units > 0)
    .sort((left, right) => left.typeID - right.typeID);
  const totalUnits = ores.reduce((sum, ore) => sum + ore.units, 0);
  if (totalUnits <= 0) {
    return { rocks: [], totalUnits: 0 };
  }
  const totalVolume = Object.values(oreVolumeByType || {})
    .reduce((sum, volume) => sum + Math.max(0, toFiniteNumber(volume, 0)), 0);
  const rockCount = Math.min(
    FIELD_MAX_ROCKS,
    Math.max(
      ores.length,
      Math.round(FIELD_REFERENCE_ROCKS * Math.sqrt(Math.max(1, totalVolume / FIELD_REFERENCE_VOLUME_M3))),
    ),
  );

  // One rock per ore first, then the rest by largest remainder of share.
  const extra = Math.max(0, rockCount - ores.length);
  const exact = ores.map((ore) => (extra * ore.units) / totalUnits);
  const counts = exact.map((value) => 1 + Math.floor(value));
  let leftover = rockCount - counts.reduce((sum, value) => sum + value, 0);
  const byRemainder = exact
    .map((value, index) => ({ index, remainder: value - Math.floor(value) }))
    .sort((left, right) => right.remainder - left.remainder || left.index - right.index);
  for (let cursor = 0; leftover > 0 && cursor < byRemainder.length; cursor += 1, leftover -= 1) {
    counts[byRemainder[cursor].index] += 1;
  }

  const radius = FIELD_BASE_RADIUS_METERS * Math.max(0.1, toFiniteNumber(options.fieldRadiusMultiplier, 1));
  const grades = typeof options.resolveGrades === "function" ? null : getMoonOreGrades();
  const gradesOf = (typeID) => (
    grades ? grades.get(typeID) : options.resolveGrades(typeID)
  ) || { improved: 0, jackpot: 0 };
  const jackpot = seededUnit(`${seed}:jackpot`) <
    toFiniteNumber(options.jackpotChance, JACKPOT_CHANCE);
  const improvedChance = toFiniteNumber(options.improvedGradeRockChance, IMPROVED_GRADE_ROCK_CHANCE);
  const rocks = [];
  ores.forEach((ore, oreIndex) => {
    const count = Math.min(counts[oreIndex], ore.units);
    const weights = [];
    for (let index = 0; index < count; index += 1) {
      weights.push(1 + FIELD_ROCK_SIZE_SPREAD * (seededUnit(`${seed}:size:${ore.typeID}:${index}`) * 2 - 1));
    }
    const weightTotal = weights.reduce((sum, value) => sum + value, 0);
    let assigned = 0;
    for (let index = 0; index < count; index += 1) {
      const isLast = index === count - 1;
      const share = isLast
        ? ore.units - assigned
        : Math.max(1, Math.floor((ore.units * weights[index]) / weightTotal));
      assigned += share;
      const ordinal = rocks.length + 1;
      // Uniform in a sphere: cube root for the distance, uniform direction.
      const distance = radius * Math.cbrt(seededUnit(`${seed}:r:${ordinal}`));
      const theta = 2 * Math.PI * seededUnit(`${seed}:theta:${ordinal}`);
      const cosPhi = 2 * seededUnit(`${seed}:phi:${ordinal}`) - 1;
      const sinPhi = Math.sqrt(Math.max(0, 1 - cosPhi * cosPhi));
      const oreGrades = gradesOf(ore.typeID);
      const gradedTypeID = jackpot
        ? oreGrades.jackpot
        : (seededUnit(`${seed}:grade:${ordinal}`) < improvedChance ? oreGrades.improved : 0);
      rocks.push({
        ordinal,
        typeID: gradedTypeID || ore.typeID,
        baseTypeID: ore.typeID,
        quantity: share,
        offset: {
          x: distance * sinPhi * Math.cos(theta),
          y: distance * cosPhi,
          z: distance * sinPhi * Math.sin(theta),
        },
      });
    }
  });
  return { rocks, totalUnits, jackpot };
}

module.exports = {
  ATTRIBUTE,
  CHUNK_ARRIVAL_DISTANCE_METERS,
  CHUNK_SHELL_TIERS,
  DEFAULT_AUTO_FRACTURE_DELAY_SECONDS,
  DEFAULT_FIELD_DECAY_HOURS,
  FIELD_BASE_RADIUS_METERS,
  IMPROVED_GRADE_ROCK_CHANCE,
  JACKPOT_CHANCE,
  YIELD_PER_DAY_M3,
  computeChunkVolumeM3,
  computeOreVolumeByType,
  getMoonOreGrades,
  listFittedRigTypeIDs,
  planFieldRocks,
  resolveStructureMoonAttributes,
  selectChunkShellTypeID,
};
