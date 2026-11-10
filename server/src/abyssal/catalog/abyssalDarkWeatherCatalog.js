"use strict";

const DARK_WEATHER_TYPE = "dark";
const DARK_WEATHER_BONUS_PERCENT = 50;

const DARK_WEATHER_STAGES = Object.freeze([
  Object.freeze({
    stage: 1,
    typeID: 47378,
    name: "Darkness Weather 1",
    penaltyPercent: 30,
    bonusPercent: DARK_WEATHER_BONUS_PERCENT,
  }),
  Object.freeze({
    stage: 2,
    typeID: 47379,
    name: "Darkness Weather 2",
    penaltyPercent: 50,
    bonusPercent: DARK_WEATHER_BONUS_PERCENT,
  }),
  Object.freeze({
    stage: 3,
    typeID: 47380,
    name: "Darkness Weather 3",
    penaltyPercent: 70,
    bonusPercent: DARK_WEATHER_BONUS_PERCENT,
  }),
]);

const DARK_WEATHER_STAGE_BY_STAGE = Object.freeze(
  Object.fromEntries(DARK_WEATHER_STAGES.map((entry) => [String(entry.stage), entry])),
);
const DARK_WEATHER_STAGE_BY_TYPE_ID = Object.freeze(
  Object.fromEntries(DARK_WEATHER_STAGES.map((entry) => [String(entry.typeID), entry])),
);
// T0 uses the documented 30/50 strength band. EveJS currently applies an even
// deterministic split; the exact retail probability distribution is unverified.
// T1-T6 preserve the tier-conditioned probabilities calibrated from the Golden
// telemetry corpus: the stronger band rises 25% -> 50% -> 75% in each bracket.
const DARK_WEATHER_STAGE_WEIGHTS_BY_TIER = Object.freeze([
  Object.freeze([0.50, 0.50]),
  Object.freeze([0.75, 0.25]),
  Object.freeze([0.50, 0.50]),
  Object.freeze([0.25, 0.75]),
  Object.freeze([0.75, 0.25]),
  Object.freeze([0.50, 0.50]),
  Object.freeze([0.25, 0.75]),
]);

function toInteger(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

function fnv1a32(value) {
  const text = String(value == null ? "" : value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function listAllowedDarkWeatherStagesForTier(tier) {
  const normalizedTier = Math.max(0, Math.min(6, toInteger(tier, 0)));
  return normalizedTier <= 3 ? [1, 2] : [2, 3];
}

function listDarkWeatherStageWeightsForTier(tier) {
  const normalizedTier = Math.max(0, Math.min(6, toInteger(tier, 0)));
  return [...DARK_WEATHER_STAGE_WEIGHTS_BY_TIER[normalizedTier]];
}

function getDarkWeatherStage(stage) {
  return DARK_WEATHER_STAGE_BY_STAGE[String(toInteger(stage, 0))] || null;
}

function getDarkWeatherStageByTypeID(typeID) {
  return DARK_WEATHER_STAGE_BY_TYPE_ID[String(toInteger(typeID, 0))] || null;
}

function buildDarkWeatherSelectionSeed(source = {}) {
  const explicitSeed = source.selectionSeed ?? source.weatherSelectionSeed;
  if (explicitSeed != null && String(explicitSeed).trim() !== "") {
    return fnv1a32(`explicit:${String(explicitSeed)}`);
  }
  return fnv1a32([
    source.traceItemID,
    source.runID,
    source.instanceID,
    source.filamentTypeID,
    source.definitionID,
    source.tier,
  ].map((entry) => String(entry == null ? "" : entry)).join("|"));
}

function resolveDarkWeatherSelection(source = {}) {
  const tier = Math.max(0, Math.min(6, toInteger(source.tier, 0)));
  const allowedStages = listAllowedDarkWeatherStagesForTier(tier);
  const explicitStage = toInteger(
    source.weatherStage ?? source.stage,
    0,
  );
  const selectionSeed = buildDarkWeatherSelectionSeed(source);
  const selectionWeights = listDarkWeatherStageWeightsForTier(tier);
  const selectionRoll = (selectionSeed % 1_000_000) / 1_000_000;
  const selectedStage = allowedStages.includes(explicitStage)
    ? explicitStage
    : allowedStages[selectionRoll < selectionWeights[0] ? 0 : 1];
  const stageDefinition = getDarkWeatherStage(selectedStage);
  return Object.freeze({
    weatherType: DARK_WEATHER_TYPE,
    tier,
    selectionSeed,
    selectionRoll,
    selectionWeights: Object.freeze([...selectionWeights]),
    selectionModel: explicitStage > 0
      ? "explicit-stage"
      : "deterministic-per-run-weighted",
    allowedStages: Object.freeze([...allowedStages]),
    ...stageDefinition,
  });
}

module.exports = {
  DARK_WEATHER_TYPE,
  DARK_WEATHER_BONUS_PERCENT,
  DARK_WEATHER_STAGES,
  DARK_WEATHER_STAGE_WEIGHTS_BY_TIER,
  listAllowedDarkWeatherStagesForTier,
  listDarkWeatherStageWeightsForTier,
  getDarkWeatherStage,
  getDarkWeatherStageByTypeID,
  buildDarkWeatherSelectionSeed,
  resolveDarkWeatherSelection,
  _testing: {
    fnv1a32,
  },
};
