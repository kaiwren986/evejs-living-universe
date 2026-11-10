"use strict";

const { TABLE, readStaticTable } = require("../_shared/referenceData");
const { cloneValue } = require("../../common/clone");
const { getShipSkinComponent } = require("./shipSkinComponentAuthority");
function getShipSkinSequencingPolicy() {
  const policy = readStaticTable(TABLE.SHIP_SKIN_SEQUENCING_AUTHORITY);
  if (!policy.thresholdsByGroupID || !policy.tierPricing || !policy.tierDurations) throw new Error("SKINR_SEQUENCING_AUTHORITY_MISSING");
  return cloneValue(policy);
}
function calculateSkinDesignPoints(layout) {
  return layout.slots.reduce((sum, slot) => sum + Number(getShipSkinComponent(
    slot.configuration.coating?.coating.sequential || slot.configuration.pattern?.pattern.sequential)?.pointsValue || 0), 0);
}
function calculateSkinDesignTier(layout) {
  const policy = getShipSkinSequencingPolicy();
  const group = policy.shipGroupIDByTypeID[layout.ship_type.sequential];
  const thresholds = policy.thresholdsByGroupID[group];
  if (!thresholds) return null;
  const points = calculateSkinDesignPoints(layout);
  for (const [tier, limit] of Object.entries(thresholds).sort((a, b) => Number(a[0]) - Number(b[0]))) {
    if (points <= limit) return Number(tier);
  }
  return policy.maxTier;
}
function getCumulativeSkillPolicyValue(name, getLevel, skillMultipliers = {}) {
  const policy = getShipSkinSequencingPolicy().skills[name];
  if (!policy) throw new Error(`SKINR_SKILL_POLICY_MISSING:${name}`);
  return Object.entries(policy.skills || {}).reduce((sum, [typeID, values]) => {
    const level = Math.max(0, Math.min(5, Math.trunc(Number(getLevel(Number(typeID))) || 0)));
    const bonus = values.slice(0, level).reduce((total, value) => total + value, 0);
    return sum + bonus * (skillMultipliers[typeID] ?? 1);
  }, Number(policy.base || 0));
}
function getShipSkinSequencingTerms(tier, quantity = 1, durationBonusPercent = 0, policy = getShipSkinSequencingPolicy()) {
  const unitPrice = policy.tierPricing.find(row => row.tier === tier)?.plex;
  const seconds = policy.tierDurations.find(row => row.tier === tier)?.seconds;
  // The native messenger reads Duration.ToSeconds(), discarding nanos, and
  // quotes one job duration regardless of output quantity. Only its price
  // calculation multiplies by runs (shipSkinSequencingSvc.py).
  const durationSeconds = Math.max(1, Math.ceil(seconds * (100 - Math.min(100, durationBonusPercent)) * (100 - policy.discounts.durationPercent) / 10000));
  return {
    price: Math.ceil(unitPrice * (100 - policy.discounts.pricingPercent) / 100) * quantity,
    durationMs: durationSeconds * 1000,
  };
}
module.exports = { getShipSkinSequencingPolicy, calculateSkinDesignPoints, calculateSkinDesignTier, getCumulativeSkillPolicyValue, getShipSkinSequencingTerms };
