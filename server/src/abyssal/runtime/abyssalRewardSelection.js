"use strict";

const crypto = require("node:crypto");
const { toInt, normalizeText, listUniquePositiveInts, listUniqueNonNegativeInts } = require("../domain/abyssalRuntimeValues");

function summarizeRewardLootEntries(ports, lootEntries = []) {
  const entries = Array.isArray(lootEntries)
    ? lootEntries.filter((entry) => normalizeText(entry && entry.itemName, "") && toInt(entry && entry.quantity, 0) > 0)
    : [];
  if (entries.length <= 0) {
    return "none";
  }
  return entries
    .map((entry) => `${normalizeText(entry.itemName, "Unknown Item")} x${toInt(entry.quantity, 0)}`)
    .join(", ");
}

function listGuaranteedRewardLootEntries(ports, rewardProfile = null) {
  if (!rewardProfile || !Array.isArray(rewardProfile.lootEntries)) {
    return [];
  }
  return rewardProfile.lootEntries.filter((entry) => {
    const probability = entry && Object.prototype.hasOwnProperty.call(entry, "probability")
      ? Number(entry.probability)
      : 1;
    return normalizeText(entry && entry.itemName, "") &&
      toInt(entry && entry.quantity, 0) > 0 &&
      (!Number.isFinite(probability) || probability >= 1);
  });
}

function buildRewardLootRollContext(ports, rewardProfile = null, pocketState = null) {
  const {
    getContentProfile,
  } = ports;
  const contentProfile = getContentProfile(pocketState) || rewardProfile || {};
  return {
    roomIndex: Math.max(0, toInt(rewardProfile && rewardProfile.roomIndex, 0)),
    tier: Math.max(0, toInt(contentProfile && contentProfile.tier, rewardProfile && rewardProfile.tier)),
    weatherType: normalizeText(
      contentProfile && contentProfile.weatherType,
      normalizeText(rewardProfile && rewardProfile.weatherTheme, ""),
    ),
  };
}

function sumRewardLootQuantities(ports, lootEntries = []) {
  return (Array.isArray(lootEntries) ? lootEntries : []).reduce(
    (total, entry) => total + Math.max(0, toInt(entry && entry.quantity, 0)),
    0,
  );
}

function sumTier1EquivalentRewardLootQuantities(ports, lootEntries = []) {
  const {
    ABYSSAL_CALM_TIER_REWARD_QUANTITY_MULTIPLIER,
  } = ports;
  return (Array.isArray(lootEntries) ? lootEntries : []).reduce(
    (total, entry) => {
      const originalQuantity = Math.max(
        0,
        toInt(entry && entry.originalQuantity, toInt(entry && entry.quantity, 0)),
      );
      return total + Math.max(0, Math.round(originalQuantity * ABYSSAL_CALM_TIER_REWARD_QUANTITY_MULTIPLIER));
    },
    0,
  );
}

function logTier0RewardResolution(ports, pocketState = null, roomIndex = 0, source = "cache", resolvedEntries = []) {
  const {
    getContentProfile,
    log,
    ABYSSAL_TIER0_REWARD_OUTPUT_MULTIPLIER,
  } = ports;
  const contentProfile = getContentProfile(pocketState) || {};
  if (toInt(contentProfile && contentProfile.tier, -1) !== 0 || typeof log.debug !== "function") {
    return;
  }
  log.debug(
    `[AbyssalMgr] Abyssal reward resolved ` +
      `instance=${toInt(pocketState && pocketState.instanceID, 0)} ` +
      `tier=0 room=${Math.max(0, toInt(roomIndex, 0))} source=${normalizeText(source, "cache")} ` +
      `tierMultiplier=${ABYSSAL_TIER0_REWARD_OUTPUT_MULTIPLIER} ` +
      `tier1EquivalentQuantity=${sumTier1EquivalentRewardLootQuantities(ports, resolvedEntries)} ` +
      `resolvedQuantity=${sumRewardLootQuantities(ports, resolvedEntries)}`,
  );
}

function formatRewardDiagnosticItems(ports, lootEntries = []) {
  return `[${(Array.isArray(lootEntries) ? lootEntries : [])
    .filter((entry) => toInt(entry && entry.itemTypeID, 0) > 0 && toInt(entry && entry.quantity, 0) > 0)
    .map((entry) => `${toInt(entry.itemTypeID, 0)}:${toInt(entry.quantity, 0)}`)
    .join(",")}]`;
}

function logTier2RewardResolution(ports,
  pocketState = null,
  roomIndex = 0,
  source = "cache",
  rewardProfileID = "",
  resolvedEntries = [],
) {
  const {
    getContentProfile,
    log,
    getTierRewardQuantityMultiplier,
  } = ports;
  const contentProfile = getContentProfile(pocketState) || {};
  if (toInt(contentProfile && contentProfile.tier, -1) !== 2 || typeof log.debug !== "function") {
    return;
  }
  const tier1EquivalentItems = (Array.isArray(resolvedEntries) ? resolvedEntries : []).map((entry) => ({
    ...entry,
    quantity: Math.max(0, Math.round(toInt(entry && entry.quantity, 0) / 2)),
  }));
  const doubleMatch = (Array.isArray(resolvedEntries) ? resolvedEntries : []).every((entry) => (
    toInt(entry && entry.quantity, 0) ===
      Math.round(toInt(entry && entry.quantity, 0) / 2) * 2
  ));
  log.debug(
    `[AbyssalMgr] Abyssal reward resolved ` +
      `instance=${toInt(pocketState && pocketState.instanceID, 0)} ` +
      `tier=2 room=${Math.max(0, toInt(roomIndex, 0))} source=${normalizeText(source, "cache")} ` +
      `rewardProfile=${normalizeText(rewardProfileID, "unknown")} ` +
      `tierMultiplier=${getTierRewardQuantityMultiplier(pocketState)} ` +
      `tier1EquivalentItems=${formatRewardDiagnosticItems(ports, tier1EquivalentItems)} ` +
      `resolvedItems=${formatRewardDiagnosticItems(ports, resolvedEntries)} ` +
      `doubleMatch=${doubleMatch}`,
  );
}

function isRewardLootEntryEligibleForContext(ports, entry = null, context = {}) {
  const allowedRoomIndexes = listUniquePositiveInts(entry && entry.allowedRoomIndexes);
  const allowedTiers = listUniqueNonNegativeInts(entry && entry.allowedTiers);
  const allowedWeatherTypes = Array.isArray(entry && entry.allowedWeatherTypes)
    ? entry.allowedWeatherTypes
      .map((value) => normalizeText(value, ""))
      .filter(Boolean)
    : [];
  const roomIndex = Math.max(0, toInt(context && context.roomIndex, 0));
  const tier = Math.max(0, toInt(context && context.tier, 0));
  const weatherType = normalizeText(context && context.weatherType, "");
  return (
    (allowedRoomIndexes.length <= 0 || allowedRoomIndexes.includes(roomIndex)) &&
    (allowedTiers.length <= 0 || allowedTiers.includes(tier)) &&
    (allowedWeatherTypes.length <= 0 || allowedWeatherTypes.includes(weatherType))
  );
}

function nextAbyssalLootRandom(ports, deps = ports.getDependencies()) {
  const randomValue = deps && typeof deps.nextRandom === "function"
    ? Number(deps.nextRandom())
    : Math.random();
  if (!Number.isFinite(randomValue)) {
    return 0;
  }
  if (randomValue <= 0) {
    return 0;
  }
  if (randomValue >= 1) {
    return 0.999999999;
  }
  return randomValue;
}

function rollRewardEntryQuantity(ports, rewardEntry = null, deps = ports.getDependencies()) {
  const quantityBuckets = Array.isArray(rewardEntry && rewardEntry.quantityBuckets)
    ? rewardEntry.quantityBuckets.filter((bucket) => (
      Number.isSafeInteger(Number(bucket && bucket.quantity)) &&
      Number(bucket.quantity) > 0 &&
      Number.isSafeInteger(Number(bucket && bucket.weight)) &&
      Number(bucket.weight) > 0
    ))
    : [];
  if (quantityBuckets.length > 0) {
    const totalWeight = quantityBuckets.reduce((sum, bucket) => sum + Number(bucket.weight), 0);
    const roll = nextAbyssalLootRandom(ports, deps) * totalWeight;
    let cumulativeWeight = 0;
    for (const bucket of quantityBuckets) {
      cumulativeWeight += Number(bucket.weight);
      if (roll < cumulativeWeight) {
        return Number(bucket.quantity);
      }
    }
    return Number(quantityBuckets[quantityBuckets.length - 1].quantity);
  }
  const fallbackQuantity = Math.max(0, toInt(rewardEntry && rewardEntry.quantity, 0));
  const minQuantity = Math.max(0, toInt(rewardEntry && rewardEntry.minQuantity, fallbackQuantity));
  const maxQuantity = Math.max(minQuantity, toInt(rewardEntry && rewardEntry.maxQuantity, minQuantity));
  if (maxQuantity <= minQuantity) {
    return minQuantity;
  }
  return minQuantity + Math.floor(nextAbyssalLootRandom(ports, deps) * ((maxQuantity - minQuantity) + 1));
}

function selectWeightedRewardLootEntry(ports, weightedLootPool = null, deps = ports.getDependencies(), context = {}) {
  const candidateEntries = Array.isArray(weightedLootPool && weightedLootPool.entries)
    ? weightedLootPool.entries.filter((entry) => (
      isRewardLootEntryEligibleForContext(ports, entry, context) &&
      normalizeText(entry && entry.itemName, "") &&
      Math.max(0, toInt(entry && entry.maxQuantity, toInt(entry && entry.quantity, 0))) > 0 &&
      Number(entry && entry.weight) > 0
    ))
    : [];
  if (candidateEntries.length <= 0) {
    return null;
  }
  const totalWeight = candidateEntries.reduce(
    (sum, entry) => sum + Math.max(0, Number(entry && entry.weight) || 0),
    0,
  );
  if (!(totalWeight > 0)) {
    return null;
  }
  const roll = nextAbyssalLootRandom(ports, deps) * totalWeight;
  let cumulativeWeight = 0;
  for (const entry of candidateEntries) {
    cumulativeWeight += Math.max(0, Number(entry && entry.weight) || 0);
    if (roll < cumulativeWeight) {
      return entry;
    }
  }
  return candidateEntries[candidateEntries.length - 1] || null;
}

function buildAbyssalRewardRollSeed(ports, pocketState, rewardProfile, roomIndex) {
  const {
    isObservedRunRewardAllocationProfile,
  } = ports;
  const explicitSeed = normalizeText(
    pocketState && (pocketState.rewardRngSeed || pocketState.rngSeed),
    "",
  );
  const profileIdentity = rewardProfile && rewardProfile.rewardMode === "empirical_tier_pool"
    ? normalizeText(rewardProfile && rewardProfile.lootTableID, "empirical-tier-pool")
    : isObservedRunRewardAllocationProfile(rewardProfile)
      ? `${normalizeText(rewardProfile.rewardProfileID, "unknown")}:whole-run`
      : `${normalizeText(rewardProfile && rewardProfile.rewardProfileID, "unknown")}:room-${toInt(roomIndex, 0)}`;
  return [
    "abyssal-reward-roll-v1",
    explicitSeed || toInt(pocketState && pocketState.instanceID, 0),
    toInt(pocketState && pocketState.characterID, 0),
    toInt(pocketState && pocketState.activatedAtMs, 0),
    profileIdentity,
  ].join(":");
}

function createDeterministicAbyssalRewardDependencies(ports, deps, seed) {
  let counter = 0;
  return {
    ...deps,
    nextRandom() {
      const digest = crypto.createHash("sha256")
        .update(`${seed}:${counter++}`)
        .digest();
      return digest.readUInt32BE(0) / 4_294_967_296;
    },
  };
}

function createAbyssalRewardSelection(ports) {
  return {
    summarizeRewardLootEntries: summarizeRewardLootEntries.bind(null, ports),
    listGuaranteedRewardLootEntries: listGuaranteedRewardLootEntries.bind(null, ports),
    buildRewardLootRollContext: buildRewardLootRollContext.bind(null, ports),
    sumRewardLootQuantities: sumRewardLootQuantities.bind(null, ports),
    sumTier1EquivalentRewardLootQuantities: sumTier1EquivalentRewardLootQuantities.bind(null, ports),
    logTier0RewardResolution: logTier0RewardResolution.bind(null, ports),
    formatRewardDiagnosticItems: formatRewardDiagnosticItems.bind(null, ports),
    logTier2RewardResolution: logTier2RewardResolution.bind(null, ports),
    isRewardLootEntryEligibleForContext: isRewardLootEntryEligibleForContext.bind(null, ports),
    nextAbyssalLootRandom: nextAbyssalLootRandom.bind(null, ports),
    rollRewardEntryQuantity: rollRewardEntryQuantity.bind(null, ports),
    selectWeightedRewardLootEntry: selectWeightedRewardLootEntry.bind(null, ports),
    buildAbyssalRewardRollSeed: buildAbyssalRewardRollSeed.bind(null, ports),
    createDeterministicAbyssalRewardDependencies: createDeterministicAbyssalRewardDependencies.bind(null, ports),
  };
}

module.exports = { createAbyssalRewardSelection };
