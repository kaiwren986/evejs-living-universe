"use strict";

const { createPublishedFacade } = require("./publishedFacade");

module.exports = createPublishedFacade([
  "buildAbyssalVisibilityRestrictionSummaryForSession",
  "resolveAbyssalVisibilityRestrictionForSession",
]);
