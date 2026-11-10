"use strict";

const catalog = require("./groupRewardCatalog.json");
const crypto = require("node:crypto");
const { validateRewardGroup } = require("./groupRewardEvaluator");
function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
if (catalog.schema !== "evejs.group-reward-catalog.v1" || catalog.version !== 1 || !Array.isArray(catalog.groups)) {
  throw new Error("GROUP_REWARD_CATALOG_INVALID");
}
const groups = new Map();
for (const group of catalog.groups) {
  validateRewardGroup(group);
  if (groups.has(group.groupRewardID)) throw new Error("GROUP_REWARD_CATALOG_DUPLICATE");
  groups.set(group.groupRewardID, freeze(group));
}
freeze(catalog);
function canonical(value) {
  return Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
}
const CATALOG_IDENTITY = freeze({ schema: catalog.schema, version: catalog.version,
  sha256: crypto.createHash("sha256").update(JSON.stringify(canonical(catalog))).digest("hex"),
  supportedBuild: catalog.source.supportedBuild, resourceSha256: catalog.source.resourceSha256,
  selectedOutputSha256: catalog.source.selectedOutputSha256 });
function getGroupReward(groupRewardID) {
  return Number.isSafeInteger(groupRewardID) ? groups.get(groupRewardID) || null : null;
}
module.exports = { getGroupReward, GROUP_REWARD_IDS: Object.freeze([...groups.keys()]),
  CATALOG_VERSION: catalog.version, CATALOG_IDENTITY, SOURCE: catalog.source };
