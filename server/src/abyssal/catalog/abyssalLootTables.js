"use strict";

const generated = require("./abyssalLootTables.generated");
const {
  ABYSSAL_REWARD_QUANTITY_POLICY,
  validateRewardQuantityPolicy,
} = require("../domain/abyssalRewardQuantityPolicy");
const {
  ABYSSAL_CONTENT_AUTHORITY,
} = require("./abyssalContentAuthority");

function deepFreeze(value) {
  if (!value || typeof value !== "object") {
    return value;
  }
  for (const nestedValue of Object.values(value)) {
    deepFreeze(nestedValue);
  }
  return Object.isFrozen(value) ? value : Object.freeze(value);
}

function validateQuantityBuckets(quantityBuckets, context) {
  if (!Array.isArray(quantityBuckets) || quantityBuckets.length === 0) {
    throw new TypeError(`${context} requires empirical quantity buckets`);
  }
  for (const bucket of quantityBuckets) {
    if (!Number.isSafeInteger(bucket && bucket.quantity) || bucket.quantity <= 0) {
      throw new TypeError(`${context} contains an invalid empirical quantity`);
    }
    if (!Number.isSafeInteger(bucket && bucket.weight) || bucket.weight <= 0) {
      throw new TypeError(`${context} contains an invalid empirical bucket weight`);
    }
  }
}

function validateGeneratedLootTables(source = generated) {
  if (!source || source.schemaVersion !== 1 || !source.tiers) {
    throw new TypeError("Unsupported generated Abyssal loot-table schema");
  }
  for (let tier = 0; tier <= 6; tier += 1) {
    const table = source.tiers[String(tier)];
    if (!table || !table.lootTableID || !Array.isArray(table.entries)) {
      throw new TypeError(`Generated Abyssal Tier ${tier} loot table is missing`);
    }
    validateRewardQuantityPolicy(table.quantityPolicy);
    if (table.quantityPolicy !== ABYSSAL_REWARD_QUANTITY_POLICY.RETAIL_FINAL) {
      throw new TypeError(`Generated Abyssal Tier ${tier} quantities must be retail_final`);
    }
    const typeIDs = new Set();
    for (const entry of table.entries) {
      const context = `Generated Abyssal Tier ${tier} entry ${entry && entry.itemName}`;
      if (!Number.isSafeInteger(entry && entry.itemTypeID) || entry.itemTypeID <= 0) {
        throw new TypeError(`${context} has no authoritative type ID`);
      }
      if (typeIDs.has(entry.itemTypeID)) {
        throw new TypeError(`${context} duplicates type ID ${entry.itemTypeID}`);
      }
      typeIDs.add(entry.itemTypeID);
      if (
        !Number.isInteger(entry.dropChanceBps) ||
        entry.dropChanceBps < 0 ||
        entry.dropChanceBps > 10_000
      ) {
        throw new TypeError(`${context} has invalid basis-point probability`);
      }
      validateQuantityBuckets(entry.quantityBuckets, context);
    }
  }
  return true;
}

validateGeneratedLootTables();
deepFreeze(generated);

function getAbyssalEmpiricalTierLootTable(tier) {
  const numericTier = Number(tier);
  if (!Number.isInteger(numericTier) || numericTier < 0 || numericTier > 6) {
    return null;
  }
  return generated.tiers[String(numericTier)] || null;
}

function buildEmpiricalAbyssalRewardProfile({
  tier,
  roomIndex = 1,
  weatherTheme = "",
  rewardProfileID = "",
  displayName = "",
  replaceCapturedReward = true,
} = {}) {
  const table = getAbyssalEmpiricalTierLootTable(tier);
  if (!table) {
    throw new TypeError(`No generated Abyssal loot table exists for Tier ${tier}`);
  }
  const normalizedRoomIndex = Math.max(1, Math.min(3, Math.trunc(Number(roomIndex) || 1)));
  return {
    rewardProfileID: rewardProfileID || `${table.lootTableID}:room-${normalizedRoomIndex}`,
    lootTableID: table.lootTableID,
    displayName: displayName || `Tier ${tier} empirical reward cache`,
    tier: Number(tier),
    weatherTheme: String(weatherTheme || "").toLowerCase(),
    rewardKind: "cache_loot",
    rewardMode: "empirical_tier_pool",
    rewardTableKind: "empirical_tier_pool",
    capturedExact: false,
    replaceCapturedReward: replaceCapturedReward === true,
    sourceModelID: "abyssal-space:high-confidence-tier-pools-v1",
    contentAuthority: ABYSSAL_CONTENT_AUTHORITY.OBSERVED_EMPIRICAL,
    suppressRewardsOnTimeout: true,
    authoredProbabilities: false,
    quantityPolicy: table.quantityPolicy,
    roomMultipliersByIndex: { 1: 1, 2: 1, 3: 1 },
    baseLootEntries: [],
    lootEntries: [],
    weightedLootPools: [],
    empiricalRunAllocation: {
      roomIndex: normalizedRoomIndex,
      roomCount: 3,
      policy: "stable_item_partition",
    },
    sourceEligibleRuns: table.sourceEligibleRuns,
    unresolvedLootReferences: [],
    unresolvedLootReferenceCount: 0,
    placeholderNotes: [],
  };
}

module.exports = {
  buildEmpiricalAbyssalRewardProfile,
  getAbyssalEmpiricalTierLootTable,
  validateGeneratedLootTables,
};
