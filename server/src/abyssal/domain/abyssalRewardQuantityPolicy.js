"use strict";

const ABYSSAL_REWARD_QUANTITY_POLICY = Object.freeze({
  RETAIL_FINAL: "retail_final",
  AUTHORED_BASE: "authored_base",
  PLACEHOLDER_BASE: "placeholder_base",
  PRE_SCALED: "pre_scaled",
});

const SUPPORTED_POLICIES = new Set(Object.values(ABYSSAL_REWARD_QUANTITY_POLICY));
const POLICIES_REQUIRING_TIER_SCALING = new Set([
  ABYSSAL_REWARD_QUANTITY_POLICY.AUTHORED_BASE,
  ABYSSAL_REWARD_QUANTITY_POLICY.PLACEHOLDER_BASE,
]);

function validateInventoryQuantity(quantity, label = "Abyssal reward quantity") {
  const numericQuantity = Number(quantity);
  if (!Number.isFinite(numericQuantity) || numericQuantity < 0) {
    throw new TypeError(`${label} must be a finite non-negative number`);
  }
  if (!Number.isSafeInteger(numericQuantity)) {
    throw new TypeError(`${label} must be a safe integer`);
  }
  return numericQuantity;
}

function validateTierMultiplier(tierMultiplier) {
  const numericMultiplier = Number(tierMultiplier);
  if (!Number.isFinite(numericMultiplier) || numericMultiplier <= 0) {
    throw new TypeError("Abyssal reward tier multiplier must be finite and positive");
  }
  return numericMultiplier;
}

function validateRewardQuantityPolicy(quantityPolicy) {
  if (!quantityPolicy) {
    throw new TypeError("Abyssal reward quantity policy is required");
  }
  if (!SUPPORTED_POLICIES.has(quantityPolicy)) {
    throw new TypeError(`Unsupported Abyssal reward quantity policy: ${quantityPolicy}`);
  }
  return quantityPolicy;
}

function validateRewardProfileQuantityPolicy(rewardProfile) {
  if (!rewardProfile || typeof rewardProfile !== "object") {
    throw new TypeError("Abyssal reward profile is required");
  }
  if (Object.prototype.hasOwnProperty.call(rewardProfile, "authoredQuantities")) {
    throw new TypeError(
      "Abyssal reward profile contains conflicting legacy field authoredQuantities",
    );
  }
  const policy = validateRewardQuantityPolicy(rewardProfile.quantityPolicy);
  const validateEntry = (entry, label) => {
    if (!entry || typeof entry !== "object") {
      throw new TypeError(`${label} must be an object`);
    }
    for (const field of ["quantity", "minQuantity", "maxQuantity"]) {
      if (Object.prototype.hasOwnProperty.call(entry, field)) {
        validateInventoryQuantity(entry[field], `${label} ${field}`);
      }
    }
    if (
      Object.prototype.hasOwnProperty.call(entry, "minQuantity") &&
      Object.prototype.hasOwnProperty.call(entry, "maxQuantity") &&
      Number(entry.maxQuantity) < Number(entry.minQuantity)
    ) {
      throw new TypeError(`${label} maxQuantity must be at least minQuantity`);
    }
    for (const [bucketIndex, bucket] of (Array.isArray(entry.quantityBuckets)
      ? entry.quantityBuckets
      : []).entries()) {
      const bucketLabel = `${label} quantity bucket ${bucketIndex}`;
      const bucketQuantity = validateInventoryQuantity(bucket && bucket.quantity, bucketLabel);
      const bucketWeight = validateInventoryQuantity(
        bucket && bucket.weight,
        `${bucketLabel} weight`,
      );
      if (bucketQuantity <= 0 || bucketWeight <= 0) {
        throw new TypeError(`${bucketLabel} quantity and weight must be positive`);
      }
    }
  };
  for (const collectionName of [
    "baseLootEntries",
    "lootEntries",
    "empiricalLootEntries",
    "rareLootEntries",
    "extractionNodeLootEntries",
  ]) {
    for (const [index, entry] of (Array.isArray(rewardProfile[collectionName])
      ? rewardProfile[collectionName]
      : []).entries()) {
      validateEntry(entry, `Abyssal reward ${collectionName}[${index}]`);
    }
  }
  for (const [poolIndex, pool] of (Array.isArray(rewardProfile.weightedLootPools)
    ? rewardProfile.weightedLootPools
    : []).entries()) {
    for (const [entryIndex, entry] of (Array.isArray(pool && pool.entries)
      ? pool.entries
      : []).entries()) {
      validateEntry(
        entry,
        `Abyssal reward weightedLootPools[${poolIndex}].entries[${entryIndex}]`,
      );
    }
  }
  return policy;
}

// Compatibility is intentionally limited to reward profiles read from durable
// pre-policy run snapshots. New profile builders must never call this helper.
// Legacy `true` meant "already scaled/bypass" at runtime, so PRE_SCALED is the
// only mapping that preserves an in-flight run without changing its payout.
function migrateLegacySerializedRewardProfile(rewardProfile) {
  if (!rewardProfile || typeof rewardProfile !== "object") {
    return rewardProfile;
  }
  if (rewardProfile.quantityPolicy) {
    validateRewardProfileQuantityPolicy(rewardProfile);
    return { ...rewardProfile };
  }
  const hasLegacyBoolean = Object.prototype.hasOwnProperty.call(
    rewardProfile,
    "authoredQuantities",
  );
  if (!hasLegacyBoolean && rewardProfile.capturedExact !== true) {
    validateRewardProfileQuantityPolicy(rewardProfile);
  }
  const { authoredQuantities, tierMultiplier: _legacyTierMultiplier, ...withoutLegacyFields } =
    rewardProfile;
  // Old profile builders stored their profile-level multiplier in `lootEntries`
  // while retaining unscaled `baseLootEntries`. Treat the serialized loot view
  // as canonical so an in-flight run keeps its historical quantity exactly.
  const canonicalLootEntries = Array.isArray(rewardProfile.lootEntries)
    ? rewardProfile.lootEntries.map((entry) => ({ ...entry }))
    : Array.isArray(rewardProfile.baseLootEntries)
      ? rewardProfile.baseLootEntries.map((entry) => ({ ...entry }))
      : [];
  const migrated = {
    ...withoutLegacyFields,
    baseLootEntries: canonicalLootEntries.map((entry) => ({ ...entry })),
    lootEntries: canonicalLootEntries.map((entry) => ({ ...entry })),
    quantityPolicy: rewardProfile.capturedExact === true || authoredQuantities === true
      ? ABYSSAL_REWARD_QUANTITY_POLICY.PRE_SCALED
      : ABYSSAL_REWARD_QUANTITY_POLICY.PLACEHOLDER_BASE,
    legacyQuantityPolicyMigration: "pre-explicit-policy-v1",
  };
  validateRewardProfileQuantityPolicy(migrated);
  return migrated;
}

function rewardQuantityPolicyAppliesTierScaling(quantityPolicy) {
  return POLICIES_REQUIRING_TIER_SCALING.has(
    validateRewardQuantityPolicy(quantityPolicy),
  );
}

function resolveRewardQuantity({
  baseQuantity,
  tierMultiplier,
  quantityPolicy,
  alreadyResolved = false,
} = {}) {
  if (alreadyResolved) {
    throw new TypeError("Abyssal reward quantity has already been resolved");
  }
  const quantity = validateInventoryQuantity(baseQuantity, "Abyssal reward base quantity");
  const multiplier = validateTierMultiplier(tierMultiplier);
  const policy = validateRewardQuantityPolicy(quantityPolicy);
  const resolvedQuantity = rewardQuantityPolicyAppliesTierScaling(policy)
    ? Math.round(quantity * multiplier)
    : quantity;
  if (!Number.isSafeInteger(resolvedQuantity) || resolvedQuantity < 0) {
    throw new TypeError("Resolved Abyssal reward quantity must be a safe non-negative integer");
  }
  return resolvedQuantity;
}

function applyRewardQuantityPolicy(entries, {
  tierMultiplier,
  quantityPolicy,
} = {}) {
  const policy = validateRewardQuantityPolicy(quantityPolicy);
  const multiplier = validateTierMultiplier(tierMultiplier);
  return (Array.isArray(entries) ? entries : []).map((entry, index) => {
    if (entry && entry.quantityPolicyApplied === true) {
      throw new TypeError(`Abyssal reward entry ${index} has already been quantity-resolved`);
    }
    const baseQuantity = validateInventoryQuantity(
      entry && entry.quantity,
      `Abyssal reward entry ${index} quantity`,
    );
    const quantity = resolveRewardQuantity({
      baseQuantity,
      tierMultiplier: multiplier,
      quantityPolicy: policy,
    });
    return {
      ...entry,
      baseQuantity,
      quantity,
      minQuantity: quantity,
      maxQuantity: quantity,
      quantityPolicy: policy,
      tierMultiplierApplied: rewardQuantityPolicyAppliesTierScaling(policy)
        ? multiplier
        : 1,
      quantityPolicyApplied: true,
    };
  });
}

module.exports = {
  ABYSSAL_REWARD_QUANTITY_POLICY,
  applyRewardQuantityPolicy,
  migrateLegacySerializedRewardProfile,
  resolveRewardQuantity,
  rewardQuantityPolicyAppliesTierScaling,
  validateInventoryQuantity,
  validateRewardProfileQuantityPolicy,
  validateRewardQuantityPolicy,
};
