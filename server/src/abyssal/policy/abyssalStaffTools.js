"use strict";

const { createPublishedFacade } = require("./publishedFacade");

module.exports = createPublishedFacade([
  "getAbyssalTimeoutPolicy",
  "getAbyssalTimeoutState",
  "playAbyssalCalmDarkFxProbeForSession",
  "spawnAbyssalSceneryProbeForSession",
  "stepAbyssalSceneryProbeForSession",
  "listAbyssalSceneryProbeCatalogue",
  "listAbyssalSceneryProbeCandidateKeys",
  "listAbyssalSceneryProbeCatalogueCategoryKeys",
  "listAbyssalSceneryProbePresetKeys",
  "setAbyssalSuppressorDebugForSession",
  "getAbyssalSuppressorDebugForSession",
  "buildAbyssalStatusReportForSession",
  "listT0DarkLayoutsForStaff",
  "setNextT0DarkLayoutForSession",
  "clearNextT0DarkLayoutForSession",
  "getT0DarkLayoutStatusForSession",
]);
