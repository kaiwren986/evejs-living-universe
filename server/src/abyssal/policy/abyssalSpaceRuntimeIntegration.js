"use strict";

const { createPublishedFacade } = require("./publishedFacade");

module.exports = createPublishedFacade([
  "collectAbyssalLocationModifierSourcesForEntity",
  "collectAbyssalShipAttributeModifierEntriesForShipID",
  "collectAbyssalNpcShipAttributeModifierEntriesForEntity",
  "getActiveAbyssalRunForCharacterID",
  "handleAbyssalEnvironmentalObjectDestroyed",
  "handleAbyssalNpcDestroyed",
  "handleAbyssalNpcsDestroyed",
  "handleAbyssalRuntimeArtifactDestroyed",
  "handleSessionShipDestroyed",
  "isAbyssalRestrictionBypassAllowed",
  "isCharacterInActiveAbyssalRun",
  "isShipInActiveAbyssalRun",
  "prepareAbyssalRuntimeArtifactDestruction",
  "queuePendingAbyssalNpcDestroyed",
]);
