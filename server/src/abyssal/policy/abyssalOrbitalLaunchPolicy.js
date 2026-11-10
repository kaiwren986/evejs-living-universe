"use strict";

const { createPublishedFacade } = require("./publishedFacade");

module.exports = createPublishedFacade([
  "getActiveAbyssalRunForCharacterID",
  "getActiveAbyssalRunForShipID",
  "isAbyssalRestrictionBypassAllowed",
]);
