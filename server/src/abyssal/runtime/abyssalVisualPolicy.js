"use strict";
const { toBool, normalizeText, toInt } = require("../domain/abyssalRuntimeValues");

function isAbyssalSceneryVisualsRequested(ports, deps = ports.getDependencies()) {
  return toBool(deps && deps.abyssalSceneryVisualsEnabled, false);
}

function isSupportedAbyssalContentTier(ports, contentProfile = null) {
  const {
    SUPPORTED_ABYSSAL_CONTENT_TIERS,
  } = ports;
  const numericTier = Number(contentProfile && contentProfile.tier);
  if (!Number.isFinite(numericTier)) {
    return false;
  }
  const tier = Math.trunc(numericTier);
  return SUPPORTED_ABYSSAL_CONTENT_TIERS.includes(tier);
}

function isSupportedBaselineAbyssalContentTier(ports, contentProfile = null) {
  return isSupportedAbyssalContentTier(ports, contentProfile);
}

function isSupportedCalmSceneryContentProfile(ports, contentProfile = null) {
  const {
    CALM_SCENERY_SUPPORTED_WEATHER_TYPES,
  } = ports;
  const weatherType = normalizeText(contentProfile && contentProfile.weatherType, "");
  return (
    isSupportedAbyssalContentTier(ports, contentProfile) &&
    CALM_SCENERY_SUPPORTED_WEATHER_TYPES.includes(weatherType)
  );
}

function isAbyssalVisualFxContentProfile(ports, contentProfile = null) {
  return (
    toInt(contentProfile && contentProfile.filamentTypeID, 0) > 0 &&
    isSupportedAbyssalContentTier(ports, contentProfile) &&
    normalizeText(contentProfile && contentProfile.weatherType, "") !== "" &&
    normalizeText(contentProfile && contentProfile.definitionID, "").startsWith("abyssal:")
  );
}

function createAbyssalVisualPolicy(ports) {
  return {
    isAbyssalSceneryVisualsRequested: isAbyssalSceneryVisualsRequested.bind(null, ports),
    isSupportedAbyssalContentTier: isSupportedAbyssalContentTier.bind(null, ports),
    isSupportedBaselineAbyssalContentTier: isSupportedBaselineAbyssalContentTier.bind(null, ports),
    isSupportedCalmSceneryContentProfile: isSupportedCalmSceneryContentProfile.bind(null, ports),
    isAbyssalVisualFxContentProfile: isAbyssalVisualFxContentProfile.bind(null, ports),
  };
}

module.exports = { createAbyssalVisualPolicy };
