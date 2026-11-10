"use strict";

const { createPublishedFacade } = require("./publishedFacade");

module.exports = createPublishedFacade([
  "buildAbyssalWeatherState",
  "resolveAbyssalWeatherStrengthSelection",
  "resolveDeterministicAbyssalWeatherStrengthPercent",
  "collectAbyssalShipAttributeModifierEntriesForShipID",
  "collectAbyssalNpcShipAttributeModifierEntriesForEntity",
  "collectAbyssalLocationModifierSourcesForShipID",
  "collectAbyssalLocationModifierSourcesForEntity",
  "applyAbyssalWeatherToNpcEntity",
]);
