"use strict";

// Stable evidence identifiers retained by compact production content. The
// historical Tier telemetry catalogues are derived offline from the canonical
// all-tier CSV; these identifiers do not imply a runtime JSON dependency.
const CATALOGUE_ID = "abyssal-space:tier0-observed-2026-07-v1";
const TIER1_CATALOGUE_ID = "abyssal-space:tier1-observed-2026-08-v1";
const TIER2_CATALOGUE_ID = "abyssal-space:tier2-observed-2026-08-v1";
const TIER3_CATALOGUE_ID = "abyssal-space:tier3-observed-2026-08-v1";
const TIER4_CATALOGUE_ID = "abyssal-space:tier4-observed-2026-08-v1";
const TIER5_CATALOGUE_ID = "abyssal-space:tier5-observed-2026-08-v1";
const TIER6_CATALOGUE_ID = "abyssal-space:tier6-observed-2026-08-v1";

const CATALOGUE_ID_BY_TIER = Object.freeze({
  0: CATALOGUE_ID,
  1: TIER1_CATALOGUE_ID,
  2: TIER2_CATALOGUE_ID,
  3: TIER3_CATALOGUE_ID,
  4: TIER4_CATALOGUE_ID,
  5: TIER5_CATALOGUE_ID,
  6: TIER6_CATALOGUE_ID,
});

function resolveAbyssalTelemetryCatalogueID(tier) {
  return CATALOGUE_ID_BY_TIER[String(Number(tier))] || "";
}

module.exports = {
  CATALOGUE_ID,
  CATALOGUE_ID_BY_TIER,
  TIER1_CATALOGUE_ID,
  TIER2_CATALOGUE_ID,
  TIER3_CATALOGUE_ID,
  TIER4_CATALOGUE_ID,
  TIER5_CATALOGUE_ID,
  TIER6_CATALOGUE_ID,
  resolveAbyssalTelemetryCatalogueID,
};
