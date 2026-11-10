"use strict";

const { createPublishedFacade } = require("./publishedFacade");

module.exports = createPublishedFacade([
  "getActiveAbyssalRunForShipID",
  "resolveAbyssalVisibilityRestrictionForSession",
]);
