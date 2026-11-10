"use strict";

// This policy describes static eligibility only. It does not create a universe
// plan, reserve slots, or visit another system. A system's decision is evaluated
// by resolveSystemSitePlan when that system is first entered.
const OPERATION_TYPES = new Set([
  "emergency_aid",
  "dread_assault",
  "raid",
  "suspicious_signal",
  "metaliminal_meteoroid",
  "abyssal_artifact_recovery",
  "salvage_research",
  "stabilize_rift",
  "traffic_stop",
]);

function operationType(family) {
  if (!family.startsWith("homefront_")) return null;
  const type = family
    .slice("homefront_".length)
    .replace(/_(amarr|caldari|gallente|minmatar)$/, "");
  return OPERATION_TYPES.has(type) ? type : null;
}

function mix(value) {
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  return (value ^ (value >>> 16)) >>> 0;
}

function seedFor(type) {
  let seed = 0;
  for (const character of `homefront-population-v1:${type}`)
    seed = mix(seed + character.charCodeAt(0));
  return seed;
}

// A keyed permutation gives each eligible system a distinct rank without
// sorting or deciding content for all the other systems. Cycle walking limits
// the permutation to the catalogue's size. The first N ranks mean exactly N
// sites per operation type if every eligible system is eventually visited.
function populationRank(index, size, seed) {
  if (size <= 1) return 0;
  const halfBits = Math.ceil(Math.log2(size) / 2);
  const mask = (1 << halfBits) - 1;
  let value = index;
  do {
    let left = value >>> halfBits;
    let right = value & mask;
    for (let round = 0; round < 6; round++) {
      const next =
        left ^ (mix(seed ^ right ^ Math.imul(round + 1, 0x9e3779b9)) & mask);
      left = right;
      right = next;
    }
    value = (left << halfBits) | right;
  } while (value >= size);
  return value;
}

function targetCount(config) {
  switch (config.homefrontPopulationPreset || "evejs") {
    case "evejs":
      return 8;
    case "retail":
      return 77;
    case "custom":
      return Math.max(0, Math.trunc(config.homefrontCustomSitesPerType ?? 8));
    default:
      throw new Error("Unknown Homefront population preset");
  }
}

// Each empire's layout of an operation type spawns only in that empire's
// systems. Ranking the type's pooled systems let one empire take every slot and
// left other layouts with none, so the type's total is split evenly across its
// layouts and each layout is ranked over its own systems. A type with a single
// layout keeps the type's seed, so its systems are unchanged.
function prepareGroups(entries) {
  const systemsByFamily = new Map();
  const familiesByType = new Map();
  for (const entry of entries) {
    const type = operationType(entry.family);
    if (!type) continue;
    if (!familiesByType.has(type)) familiesByType.set(type, new Set());
    familiesByType.get(type).add(entry.family);
    if (!systemsByFamily.has(entry.family))
      systemsByFamily.set(entry.family, new Set());
    for (const systemID of entry.homefrontSystemIDs)
      systemsByFamily.get(entry.family).add(systemID);
  }
  const populations = new Map();
  for (const [type, families] of familiesByType) {
    const ordered = [...families].sort();
    ordered.forEach((family, layoutIndex) => {
      populations.set(family, {
        seed: seedFor(ordered.length === 1 ? type : family),
        layoutIndex,
        layoutCount: ordered.length,
        indices: new Map(
          [...systemsByFamily.get(family)]
            .sort((left, right) => left - right)
            .map((id, index) => [id, index]),
        ),
      });
    });
  }
  for (const entry of entries)
    entry.homefrontPopulation = populations.get(entry.family) || null;
}

// This layout's part of its type's total. Any remainder goes to the first
// layouts in name order, and a larger total never takes a slot away.
function layoutShare(population, config) {
  const total = targetCount(config);
  const count = population.layoutCount || 1;
  return (
    Math.floor(total / count) +
    ((population.layoutIndex || 0) < total % count ? 1 : 0)
  );
}

function hostsSystem(population, systemID, config) {
  const index = population.indices.get(systemID);
  if (index === undefined) return false;
  return (
    populationRank(index, population.indices.size, population.seed) <
    layoutShare(population, config)
  );
}

module.exports = {
  operationType,
  prepareGroups,
  hostsSystem,
  targetCount,
  populationRank,
};
