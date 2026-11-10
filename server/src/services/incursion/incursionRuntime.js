"use strict";

// Fixture-only compatibility for the existing wire tests. The authority is the
// world-owned lifecycle table; 8C acknowledges its durable public projection.
let projectionOverride = null;

function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function listActiveIncursions() {
  if (projectionOverride !== null) return cloneValue(projectionOverride);
  const presentation = require("./incursionPresentation");
  return presentation.activeTales().map(presentation.report);
}

function replaceActiveIncursions(incursions = []) {
  if (process.env.EVEJS_TEST_STORE_ISOLATED !== "1") throw new Error("INCURSION_PROJECTION_OVERRIDE_TEST_ONLY");
  projectionOverride = Array.isArray(incursions) ? cloneValue(incursions) : [];
}

function resetForTests() {
  projectionOverride = null;
}

module.exports = {
  listActiveIncursions,
  replaceActiveIncursions,
  _testing: {
    resetForTests,
  },
};
