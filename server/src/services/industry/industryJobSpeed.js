"use strict";

const path = require("path");

const config = require(path.join(__dirname, "../../config"));
const {
  INDUSTRY_REFERENCE,
} = require(path.join(__dirname, "./industryConstants"));

function resolveIndustryJobSpeedMultiplier(value = config.industryJobSpeedMultiplier) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 1;
}

function resolveIndustryJobTimeFactor(value = config.industryJobSpeedMultiplier) {
  return 1 / resolveIndustryJobSpeedMultiplier(value);
}

// The client calculates job duration from the same facility activity modifiers
// that the server consumes during quote validation. Advertising the configured
// factor here keeps the client preview and its InstallJob request synchronized.
function applyIndustryJobSpeedModifier(activities) {
  if (!activities || typeof activities !== "object") {
    return activities;
  }

  const timeFactor = resolveIndustryJobTimeFactor();
  if (Math.abs(timeFactor - 1) <= 1e-12) {
    return activities;
  }

  for (const activity of Object.values(activities)) {
    if (!Array.isArray(activity)) {
      continue;
    }
    if (!Array.isArray(activity[0])) {
      activity[0] = [];
    }
    activity[0].push([
      timeFactor,
      null,
      null,
      null,
      INDUSTRY_REFERENCE.FACILITY,
    ]);
  }
  return activities;
}

module.exports = {
  applyIndustryJobSpeedModifier,
  resolveIndustryJobSpeedMultiplier,
  resolveIndustryJobTimeFactor,
};
