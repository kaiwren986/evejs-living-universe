"use strict";

const path = require("path");

const {
  getBlueprintDefinitionByProductTypeID,
  getBlueprintDefinitionByTypeID,
} = require(path.join(__dirname, "./industryStaticData"));
const {
  INDUSTRY_ACTIVITY,
} = require(path.join(__dirname, "./industryConstants"));
const {
  getItemMetadata,
} = require(path.join(__dirname, "../inventory/itemStore"));
const {
  getAdjustedAveragePrice,
} = require(path.join(__dirname, "../_shared/averageMarketPrices"));

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function toFloat(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

const priceCache = new Map();
const blueprintPriceCache = new Map();

function normalizePricingActivityID(activityID) {
  const numericActivityID = toInt(activityID, INDUSTRY_ACTIVITY.MANUFACTURING);
  if (
    numericActivityID === INDUSTRY_ACTIVITY.RESEARCH_TIME ||
    numericActivityID === INDUSTRY_ACTIVITY.RESEARCH_MATERIAL ||
    numericActivityID === INDUSTRY_ACTIVITY.COPYING ||
    numericActivityID === INDUSTRY_ACTIVITY.INVENTION
  ) {
    return INDUSTRY_ACTIVITY.MANUFACTURING;
  }
  return numericActivityID;
}

function getFallbackTypePrice(typeID) {
  const metadata = getItemMetadata(typeID, null);
  return Math.max(0, toFloat(metadata && metadata.basePrice, 0));
}

// A plain type's price in a blueprint's price: its adjusted average price where
// it has one that is not nought, and otherwise 0 (industryCommon.py
// GetBlueprintPrice, 534-543). The adjusted prices are the ones this server
// serves its clients, so a type a client is served no price for, an unpublished
// one or one whose base price is 0, has none here either.
function resolveAdjustedAverageTypePrice(typeID) {
  const adjustedAveragePrice = getAdjustedAveragePrice(typeID);
  return adjustedAveragePrice ? adjustedAveragePrice : 0;
}

function getActivityMaterials(definition, activityID) {
  if (!definition || !definition.activities || typeof definition.activities !== "object") {
    return [];
  }
  if (normalizePricingActivityID(activityID) !== INDUSTRY_ACTIVITY.MANUFACTURING) {
    return [];
  }
  const activity = definition.activities.manufacturing;
  return Array.isArray(activity && activity.materials) ? activity.materials : [];
}

function resolveEstimatedTypePrice(typeID, activityID, visited = null) {
  const numericTypeID = toInt(typeID, 0);
  if (numericTypeID <= 0) {
    return 0;
  }

  const normalizedActivityID = normalizePricingActivityID(activityID);
  const cacheKey = `${normalizedActivityID}:${numericTypeID}`;
  if (priceCache.has(cacheKey)) {
    return priceCache.get(cacheKey);
  }

  const traversal = visited || new Set();
  if (traversal.has(cacheKey)) {
    return getFallbackTypePrice(numericTypeID);
  }
  traversal.add(cacheKey);

  let resolvedPrice = 0;
  const definition = getBlueprintDefinitionByProductTypeID(numericTypeID);
  const materials = getActivityMaterials(definition, normalizedActivityID);
  if (materials.length > 0) {
    resolvedPrice = materials.reduce((sum, material) => {
      const materialTypeID = toInt(material && material.typeID, 0);
      const materialQuantity = Math.max(0, toInt(material && material.quantity, 0));
      if (materialTypeID <= 0 || materialQuantity <= 0) {
        return sum;
      }
      return (
        sum +
        resolveEstimatedTypePrice(materialTypeID, normalizedActivityID, traversal) *
          materialQuantity
      );
    }, 0);
  }

  if (!(resolvedPrice > 0)) {
    resolvedPrice = getFallbackTypePrice(numericTypeID);
  }

  priceCache.set(cacheKey, resolvedPrice);
  traversal.delete(cacheKey);
  return resolvedPrice;
}

function normalizeBlueprintPricingActivityID(activityID) {
  const numericActivityID = toInt(activityID, INDUSTRY_ACTIVITY.MANUFACTURING);
  if (
    numericActivityID === INDUSTRY_ACTIVITY.RESEARCH_TIME ||
    numericActivityID === INDUSTRY_ACTIVITY.RESEARCH_MATERIAL ||
    numericActivityID === INDUSTRY_ACTIVITY.COPYING ||
    numericActivityID === INDUSTRY_ACTIVITY.INVENTION
  ) {
    return INDUSTRY_ACTIVITY.MANUFACTURING;
  }
  return numericActivityID;
}

function getBlueprintActivityKey(activityID) {
  const normalizedActivityID = normalizeBlueprintPricingActivityID(activityID);
  if (normalizedActivityID === INDUSTRY_ACTIVITY.REACTION) {
    return "reaction";
  }
  return "manufacturing";
}

// The materials a blueprint lists for the activity, and null where the type is
// no blueprint or the blueprint has no such activity. A blueprint that has the
// activity and lists no materials for it answers [], which is not null: the
// shared code prices the first two as plain types and the last at its sum, 0.
function getBlueprintActivityMaterials(blueprintTypeID, activityID) {
  const definition = getBlueprintDefinitionByTypeID(blueprintTypeID);
  if (!definition || !definition.activities || typeof definition.activities !== "object") {
    return null;
  }
  const activityKey = getBlueprintActivityKey(activityID);
  const activity = definition.activities[activityKey];
  if (!activity || typeof activity !== "object") {
    return null;
  }
  return Array.isArray(activity.materials) ? activity.materials : [];
}

// A blueprint's price for an activity: what a job's cost is reckoned from.
//
// This is shared code, the same on CCP's client and server
// (eve/common/script/util/industryCommon.py GetBlueprintPrice, 520-543), and
// the client reckons a job's cost from it before it sends the job, so the
// number here has to be that function's:
//   it gets the blueprint type, takes manufacturing for a science activity,
//   and answers the sum, over the activity's materials in their own order, of
//   each material's own GetBlueprintPrice times its quantity. That sum is the
//   answer whatever it comes to, 0 where no material has a price and 0 where
//   the activity lists no materials;
//   only where that raised KeyError or UserError, the type being no blueprint
//   or the blueprint having no such activity, is the answer the type's
//   adjusted average price, and 0 where it has none.
// A blueprint type's own adjusted price is never a blueprint's price while the
// blueprint has the activity.
function resolveBlueprintActivityPrice(typeID, activityID, visited = null) {
  const numericTypeID = toInt(typeID, 0);
  if (numericTypeID <= 0) {
    return 0;
  }

  const normalizedActivityID = normalizeBlueprintPricingActivityID(activityID);
  const cacheKey = `${normalizedActivityID}:${numericTypeID}`;
  if (blueprintPriceCache.has(cacheKey)) {
    return blueprintPriceCache.get(cacheKey);
  }

  const traversal = visited || new Set();
  if (traversal.has(cacheKey)) {
    return resolveAdjustedAverageTypePrice(numericTypeID);
  }
  traversal.add(cacheKey);

  const materials = getBlueprintActivityMaterials(numericTypeID, normalizedActivityID);
  let resolvedPrice = 0;
  if (materials) {
    // One term at a time in the blueprint's own order: these are doubles, and
    // the client's whole ISK are held against the server's.
    resolvedPrice = materials.reduce((sum, material) => {
      const materialTypeID = toInt(material && material.typeID, 0);
      const materialQuantity = Math.max(0, toInt(material && material.quantity, 0));
      if (materialTypeID <= 0 || materialQuantity <= 0) {
        return sum;
      }
      return (
        sum +
        resolveBlueprintActivityPrice(materialTypeID, normalizedActivityID, traversal) *
          materialQuantity
      );
    }, 0);
  } else {
    resolvedPrice = resolveAdjustedAverageTypePrice(numericTypeID);
  }

  blueprintPriceCache.set(cacheKey, resolvedPrice);
  traversal.delete(cacheKey);
  return resolvedPrice;
}

function clearIndustryPricingCache() {
  priceCache.clear();
  blueprintPriceCache.clear();
}

module.exports = {
  clearIndustryPricingCache,
  normalizePricingActivityID,
  resolveAdjustedAverageTypePrice,
  resolveBlueprintActivityPrice,
  resolveEstimatedTypePrice,
};
