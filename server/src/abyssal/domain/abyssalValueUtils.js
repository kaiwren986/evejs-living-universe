"use strict";

// Small value helpers the Abyssal catalogs and profile modules all need.
//
// Each was independently redefined in ~10 Abyssal files. The copies were verified
// functionally identical before consolidation - they differed only in brace style,
// loop-variable naming, and (for normalizeText) an optional fallback argument that
// the shorter form defaults to "" anyway, making it a strict subset.
//
// DELIBERATELY NOT CONSOLIDATED: abyssalStructuralClone.js owns the runtime clone.
// That is a recursive structural clone which maps undefined -> null and
// preserves object keys whose value is undefined; the JSON round-trip below does
// neither. They are not interchangeable, and merging them would silently change
// what survives a clone.

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const nestedValue of Object.values(value)) {
    deepFreeze(nestedValue);
  }
  return value;
}

// null and undefined pass through unchanged; everything else round-trips through
// JSON, so functions, symbols and undefined-valued keys are dropped.
function cloneValue(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function normalizeText(value, fallback = "") {
  const text = String(value == null ? "" : value).trim();
  return text || fallback;
}

module.exports = {
  cloneValue,
  deepFreeze,
  normalizeText,
};
