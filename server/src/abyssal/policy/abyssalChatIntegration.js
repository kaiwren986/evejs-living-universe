"use strict";

const { createPublishedFacade } = require("./publishedFacade");

module.exports = createPublishedFacade([
  "abortAbyssalRunForAdministrativeTransition",
  "buildAbyssalStatusReportForSession",
  "clearNextT0DarkLayoutForSession",
  "getAbyssalSuppressorDebugForSession",
  "getActiveAbyssalRunForCharacterID",
  "getActiveAbyssalRunForShipID",
  "getT0DarkLayoutStatusForSession",
  "handleSessionShipDestroyed",
  "listAbyssalSceneryProbeCandidateKeys",
  "listAbyssalSceneryProbeCatalogue",
  "listAbyssalSceneryProbeCatalogueCategoryKeys",
  "listAbyssalSceneryProbePresetKeys",
  "listT0DarkLayoutsForStaff",
  "playAbyssalCalmDarkFxProbeForSession",
  "rescueAbyssalSession",
  "setAbyssalSuppressorDebugForSession",
  "setNextT0DarkLayoutForSession",
  "spawnAbyssalSceneryProbeForSession",
  "stepAbyssalSceneryProbeForSession",
]);
