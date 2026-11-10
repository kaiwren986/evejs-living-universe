"use strict";

const { createRng, random } = require("../../common/random");

function toNonNegativeInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : fallback;
}

function blueprintRunError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function readBlueprintLicensedRuns(spec) {
  const fields = ["runsRemaining", "licensedRuns", "blueprintRuns"]
    .filter((key) => spec[key] !== undefined && spec[key] !== null);
  const values = fields.map((key) => Number(spec[key]));
  if (fields.some((key) => !["number", "string"].includes(typeof spec[key])) ||
      values.some((value) => !Number.isSafeInteger(value) || value <= 0) ||
      values.some((value) => value !== values[0])) {
    throw blueprintRunError("INVALID_BLUEPRINT_RUNS");
  }
  return values.length > 0 ? values[0] : null;
}

function buildBlueprintCopyState(spec = {}) {
  const runsRemaining = readBlueprintLicensedRuns(spec);
  if (runsRemaining === null) throw blueprintRunError("BLUEPRINT_LOOT_RUNS_REQUIRED");
  return {
    original: false,
    runsRemaining,
    materialEfficiency: toNonNegativeInt(spec.materialEfficiency ?? spec.blueprintMaterialLevel, 0),
    timeEfficiency: toNonNegativeInt(spec.timeEfficiency ?? spec.blueprintProductivityLevel, 0),
    jobID: null,
  };
}

function isBlueprintCopyRewardType(itemType) {
  // Reaction formulas share category 9 but have unlimited use and no copies.
  return Number(itemType && itemType.categoryID) === 9 &&
    ![1888, 1889, 1890, 4097].includes(Number(itemType.groupID)) &&
    !/reaction formula/i.test(`${itemType.groupName || ""} ${itemType.name || ""}`);
}

function resolveBlueprintLootCopyState(itemType, spec = {}, source = {}) {
  if (!isBlueprintCopyRewardType(itemType)) return null;
  const authoredRuns = readBlueprintLicensedRuns(spec);
  if (authoredRuns !== null) return buildBlueprintCopyState({ ...spec, runsRemaining: authoredRuns });

  const rng = typeof source.random === "function" ? source.random
    : source.seed !== undefined && source.seed !== null ? createRng(source.seed) : random;
  const roll = (minimum, maximum, step = 1) => {
    const count = Math.floor((maximum - minimum) / step) + 1;
    return minimum + Math.min(count - 1, Math.max(0, Math.floor(rng() * count))) * step;
  };
  if (spec.licensedRunsMin !== undefined || spec.licensedRunsMax !== undefined) {
    const minimum = Number(spec.licensedRunsMin);
    const maximum = Number(spec.licensedRunsMax);
    if (!Number.isSafeInteger(minimum) || minimum <= 0 ||
        !Number.isSafeInteger(maximum) || maximum < minimum ||
        !["number", "string"].includes(typeof spec.licensedRunsMin) ||
        !["number", "string"].includes(typeof spec.licensedRunsMax)) {
      throw blueprintRunError("INVALID_BLUEPRINT_RUNS");
    }
    return buildBlueprintCopyState({ ...spec, runsRemaining: roll(minimum, maximum) });
  }

  // Loot runs belong to the reward source, not the blueprint's copying limit.
  // Production-facility container observations: https://evenomad.com/drug-production-facilities/
  // Synth Distribution Base copies: Ataraxia production guide, p.11:
  // https://eve-files.com/media/corp/jowen/atap_booster_production_v1.2.pdf
  const booster = /^(Synth|Standard|Improved|Strong) (Blue Pill|Crash|Drop|Exile|Frentix|Mindflood|Sooth Sayer|X-Instinct) Booster Blueprint$/i
    .exec(String(itemType.name || ""));
  if (source.kind === "booster-site-container" && booster &&
      !["chemical_lab", "gas_processing_site"].includes(source.siteTier)) {
    const synth = booster[1].toLowerCase() === "synth";
    if (!synth) return buildBlueprintCopyState({ ...spec, runsRemaining: 50 });
    if (source.siteTier === "distribution_base") {
      return buildBlueprintCopyState({ ...spec, runsRemaining: 500 });
    }
  }
  // Owner-authorized emulation for sources with no recorded instance stats.
  // Resolve once per copy and retain the result with its reward plan/receipt.
  return buildBlueprintCopyState({
    ...spec,
    runsRemaining: roll(1, 5),
    materialEfficiency: spec.materialEfficiency ?? spec.blueprintMaterialLevel ?? roll(0, 10),
    timeEfficiency: spec.timeEfficiency ?? spec.blueprintProductivityLevel ?? roll(0, 20, 2),
  });
}

// The inventory row and its industry state have separate durable writes. A
// caller must retain its grant receipt/source until this succeeds, then retry
// these same item IDs after a failed write instead of minting replacement copies.
function ensureGrantedBlueprintCopyState(items, state = {}, options = {}) {
  const copies = Array.isArray(items) ? items : [];
  const fail = (errorMsg) => ({ success: false, ambiguous: true, errorMsg });
  if (copies.length === 0 || copies.some((item) => (
    !item || Number(item.categoryID) !== 9 || Number(item.singleton) !== 2 ||
    !Number.isSafeInteger(Number(item.itemID)) || Number(item.itemID) <= 0
  ))) {
    return fail("BLUEPRINT_COPY_INSTANCE_MISSING");
  }
  // Resolve lazily: industry imports itemStore and some callers are loaded
  // while the inventory dependency graph is still being initialized.
  const industry = options.industry || require("../industry/industryRuntimeState");
  const database = options.database || require("../../gameStore");
  try {
    for (const item of copies) {
      const current = industry.getBlueprintState(item.itemID);
      if (current) {
        if (current.original !== false || Number(current.typeID) !== Number(item.typeID)) {
          return fail("BLUEPRINT_COPY_STATE_MISMATCH");
        }
        // Never refill runs (including a used-up copy) when replaying a receipt.
        continue;
      }
      const initialized = industry.initializeBlueprintState(item.itemID, {
        ...buildBlueprintCopyState(state),
        typeID: Number(item.typeID),
      });
      if (!initialized || initialized.success !== true) {
        return fail(initialized && initialized.errorMsg || "BLUEPRINT_COPY_STATE_FAILED");
      }
    }
    const flushed = database.flushTableSync("industryBlueprintState");
    if (!flushed || flushed.success !== true) {
      return fail(flushed && flushed.errorMsg || "BLUEPRINT_COPY_STATE_FLUSH_FAILED");
    }
  } catch (error) {
    return fail(String(error && error.message || "BLUEPRINT_COPY_STATE_FAILED"));
  }
  return {
    success: true,
    ambiguous: false,
    data: { itemIDs: copies.map((item) => Number(item.itemID)) },
  };
}

module.exports = {
  buildBlueprintCopyState,
  isBlueprintCopyRewardType,
  resolveBlueprintLootCopyState,
  ensureGrantedBlueprintCopyState,
};
