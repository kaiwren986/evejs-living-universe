// GENERATED FILE - DO NOT EDIT.
// Regenerate with: node tools/AbyssalData/scripts/analyze-abyssal-loot.js --input abyssal-runs.csv
// Artifact layout: tier-json-v1; content schema and model identities are unchanged.
"use strict";

module.exports = Object.freeze({
  "schemaVersion": 1,
  "sourceDataset": "abyssal-runs.csv",
  "sourcePolicy": "non-empty high-confidence rows pooled by tier",
  "weatherOverrides": {},
  "tiers": {
    "0": require("./abyssalLootTables.generated.data/tier-0.json"),
    "1": require("./abyssalLootTables.generated.data/tier-1.json"),
    "2": require("./abyssalLootTables.generated.data/tier-2.json"),
    "3": require("./abyssalLootTables.generated.data/tier-3.json"),
    "4": require("./abyssalLootTables.generated.data/tier-4.json"),
    "5": require("./abyssalLootTables.generated.data/tier-5.json"),
    "6": require("./abyssalLootTables.generated.data/tier-6.json"),
  },
});
