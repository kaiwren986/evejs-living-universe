"use strict";

const tables = require("./abyssalRewardTables.generated.json");

function cloneValue(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function getWeatherRewardProfile(tier, weatherType) {
  const tierRecord = tables.tiers[String(toInt(tier, -1))] || null;
  const weather = String(weatherType || "").trim().toLowerCase();
  return cloneValue(
    tierRecord && tierRecord.weatherProfiles[weather] || null,
  );
}

module.exports = Object.freeze({
  catalogueID: String(tables.catalogueID || ""),
  getWeatherRewardProfile,
  source: cloneValue(tables.source || {}),
  summary: cloneValue(tables.summary || {}),
});
