"use strict";

// Compatibility-only recipes. Evaluation order and contents are unchanged.
function buildTranquilDarkPlaceholder(ports) {
  return (0, ports.buildPlaceholderRewardProfile)({
    rewardProfileID: "abyssal:reward:tranquil-dark-placeholder",
    displayName: "Tranquil Dark Reward Cache (Placeholder)",
    tier: 0,
    weatherTheme: "dark",
    quantityPolicy: ports.ABYSSAL_REWARD_QUANTITY_POLICY.PLACEHOLDER_BASE,
  });
}

function buildTranquilElectricalPlaceholder(ports) {
  return (0, ports.buildPlaceholderRewardProfile)({
    rewardProfileID: "abyssal:reward:tranquil-electrical-placeholder",
    displayName: "Tranquil Electrical Reward Cache (Placeholder)",
    tier: 0,
    weatherTheme: "electrical",
    quantityPolicy: ports.ABYSSAL_REWARD_QUANTITY_POLICY.PLACEHOLDER_BASE,
  });
}

function buildTranquilExoticPlaceholder(ports) {
  return (0, ports.buildPlaceholderRewardProfile)({
    rewardProfileID: "abyssal:reward:tranquil-exotic-placeholder",
    displayName: "Tranquil Exotic Reward Cache (Placeholder)",
    tier: 0,
    weatherTheme: "exotic",
    quantityPolicy: ports.ABYSSAL_REWARD_QUANTITY_POLICY.PLACEHOLDER_BASE,
  });
}

function buildTranquilFirestormPlaceholder(ports) {
  return (0, ports.buildPlaceholderRewardProfile)({
    rewardProfileID: "abyssal:reward:tranquil-firestorm-placeholder",
    displayName: "Tranquil Firestorm Reward Cache (Placeholder)",
    tier: 0,
    weatherTheme: "firestorm",
    quantityPolicy: ports.ABYSSAL_REWARD_QUANTITY_POLICY.PLACEHOLDER_BASE,
  });
}

function buildTranquilGammaPlaceholder(ports) {
  return (0, ports.buildPlaceholderRewardProfile)({
    rewardProfileID: "abyssal:reward:tranquil-gamma-placeholder",
    displayName: "Tranquil Gamma Reward Cache (Placeholder)",
    tier: 0,
    weatherTheme: "gamma",
    quantityPolicy: ports.ABYSSAL_REWARD_QUANTITY_POLICY.PLACEHOLDER_BASE,
  });
}

function buildCalmDarkPlaceholder(ports) {
  return (0, ports.buildPlaceholderRewardProfile)({
    rewardProfileID: "abyssal:reward:calm-dark-placeholder",
    lootTableID: ports.ABYSSAL_CALM_REWARD_LOOT_TABLE_ID,
    displayName: "Calm Dark Reward Cache (Placeholder)",
    tier: 1,
    weatherTheme: "dark",
    baseLootEntries: (0, ports.cloneValue)(ports.ABYSSAL_CALM_GOLDEN_CACHE_BASE_LOOT_ENTRIES),
    weightedLootPools: [
      (0, ports.cloneValue)(ports.ABYSSAL_CALM_SURVEY_CACHE_LOOT_POOL),
      (0, ports.cloneValue)(ports.ABYSSAL_CALM_BONUS_CACHE_LOOT_POOL),
      (0, ports.cloneValue)(ports.ABYSSAL_CALM_GOLDEN_FILAMENT_CACHE_LOOT_POOL),
      (0, ports.cloneValue)(ports.ABYSSAL_CALM_MUTAPLASMID_CACHE_LOOT_POOL),
    ],
    authoredProbabilities: true,
    placeholderNotes: [
      "Calm loot uses a conservative, locally resolved, retail-inspired authored table.",
    ],
  });
}

function buildCalmElectricalPlaceholder(ports) {
  return (0, ports.buildPlaceholderRewardProfile)({
    rewardProfileID: "abyssal:reward:calm-electrical-placeholder",
    lootTableID: ports.ABYSSAL_CALM_REWARD_LOOT_TABLE_ID,
    displayName: "Calm Electrical Reward Cache (Placeholder)",
    tier: 1,
    weatherTheme: "electrical",
    baseLootEntries: (0, ports.cloneValue)(ports.ABYSSAL_CALM_GOLDEN_CACHE_BASE_LOOT_ENTRIES),
    weightedLootPools: [
      (0, ports.cloneValue)(ports.ABYSSAL_CALM_SURVEY_CACHE_LOOT_POOL),
      (0, ports.cloneValue)(ports.ABYSSAL_CALM_BONUS_CACHE_LOOT_POOL),
      (0, ports.cloneValue)(ports.ABYSSAL_CALM_GOLDEN_FILAMENT_CACHE_LOOT_POOL),
      (0, ports.cloneValue)(ports.ABYSSAL_CALM_MUTAPLASMID_CACHE_LOOT_POOL),
    ],
    authoredProbabilities: true,
    placeholderNotes: [
      "Calm loot uses a conservative, locally resolved, retail-inspired authored table.",
    ],
  });
}

function buildCalmExoticPlaceholder(ports) {
  return (0, ports.buildPlaceholderRewardProfile)({
    rewardProfileID: "abyssal:reward:calm-exotic-placeholder",
    lootTableID: ports.ABYSSAL_CALM_REWARD_LOOT_TABLE_ID,
    displayName: "Calm Exotic Reward Cache (Placeholder)",
    tier: 1,
    weatherTheme: "exotic",
    baseLootEntries: (0, ports.cloneValue)(ports.ABYSSAL_CALM_GOLDEN_CACHE_BASE_LOOT_ENTRIES),
    weightedLootPools: [
      (0, ports.cloneValue)(ports.ABYSSAL_CALM_SURVEY_CACHE_LOOT_POOL),
      (0, ports.cloneValue)(ports.ABYSSAL_CALM_BONUS_CACHE_LOOT_POOL),
      (0, ports.cloneValue)(ports.ABYSSAL_CALM_GOLDEN_FILAMENT_CACHE_LOOT_POOL),
      (0, ports.cloneValue)(ports.ABYSSAL_CALM_MUTAPLASMID_CACHE_LOOT_POOL),
    ],
    authoredProbabilities: true,
    placeholderNotes: [
      "Calm loot uses a conservative, locally resolved, retail-inspired authored table.",
    ],
  });
}

function buildCalmFirestormPlaceholder(ports) {
  return (0, ports.buildPlaceholderRewardProfile)({
    rewardProfileID: "abyssal:reward:calm-firestorm-placeholder",
    lootTableID: ports.ABYSSAL_CALM_REWARD_LOOT_TABLE_ID,
    displayName: "Calm Firestorm Reward Cache (Placeholder)",
    tier: 1,
    weatherTheme: "firestorm",
    baseLootEntries: (0, ports.cloneValue)(ports.ABYSSAL_CALM_GOLDEN_CACHE_BASE_LOOT_ENTRIES),
    weightedLootPools: [
      (0, ports.cloneValue)(ports.ABYSSAL_CALM_SURVEY_CACHE_LOOT_POOL),
      (0, ports.cloneValue)(ports.ABYSSAL_CALM_BONUS_CACHE_LOOT_POOL),
      (0, ports.cloneValue)(ports.ABYSSAL_CALM_GOLDEN_FILAMENT_CACHE_LOOT_POOL),
      (0, ports.cloneValue)(ports.ABYSSAL_CALM_MUTAPLASMID_CACHE_LOOT_POOL),
    ],
    authoredProbabilities: true,
    placeholderNotes: [
      "Calm loot uses a conservative, locally resolved, retail-inspired authored table.",
    ],
  });
}

function buildCalmGammaPlaceholder(ports) {
  return (0, ports.buildPlaceholderRewardProfile)({
    rewardProfileID: "abyssal:reward:calm-gamma-placeholder",
    lootTableID: ports.ABYSSAL_CALM_REWARD_LOOT_TABLE_ID,
    displayName: "Calm Gamma Reward Cache (Placeholder)",
    tier: 1,
    weatherTheme: "gamma",
    baseLootEntries: (0, ports.cloneValue)(ports.ABYSSAL_CALM_GOLDEN_CACHE_BASE_LOOT_ENTRIES),
    weightedLootPools: [
      (0, ports.cloneValue)(ports.ABYSSAL_CALM_SURVEY_CACHE_LOOT_POOL),
      (0, ports.cloneValue)(ports.ABYSSAL_CALM_BONUS_CACHE_LOOT_POOL),
      (0, ports.cloneValue)(ports.ABYSSAL_CALM_GOLDEN_FILAMENT_CACHE_LOOT_POOL),
      (0, ports.cloneValue)(ports.ABYSSAL_CALM_MUTAPLASMID_CACHE_LOOT_POOL),
    ],
    authoredProbabilities: true,
    placeholderNotes: [
      "Calm loot uses a conservative, locally resolved, retail-inspired authored table.",
    ],
  });
}

function buildAgitatedDarkPlaceholder(ports) {
  return (0, ports.buildPlaceholderRewardProfile)({
    rewardProfileID: "abyssal:reward:agitated-dark-placeholder",
    lootTableID: "abyssal:loot:agitated-dark-baseline",
    displayName: "Agitated Dark Reward Cache",
    tier: 2,
    weatherTheme: "dark",
    baseLootEntries: (0, ports.cloneValue)(ports.ABYSSAL_CALM_GUARANTEED_CACHE_LOOT_ENTRIES),
    weightedLootPools: [
      (0, ports.cloneValue)(ports.ABYSSAL_CALM_BONUS_CACHE_LOOT_POOL),
      (0, ports.cloneValue)(ports.ABYSSAL_CALM_FILAMENT_CACHE_LOOT_POOL),
      (0, ports.cloneValue)(ports.ABYSSAL_CALM_MUTAPLASMID_CACHE_LOOT_POOL),
    ],
    authoredProbabilities: true,
    placeholderNotes: [
      "Agitated baseline uses the Calm reward item composition with Tier 2 runtime scaling.",
    ],
  });
}

function buildAgitatedElectricalPlaceholder(ports) {
  return (0, ports.buildPlaceholderRewardProfile)({
    rewardProfileID: "abyssal:reward:agitated-electrical-placeholder",
    lootTableID: "abyssal:loot:agitated-electrical-baseline",
    displayName: "Agitated Electrical Reward Cache",
    tier: 2,
    weatherTheme: "electrical",
    baseLootEntries: (0, ports.cloneValue)(ports.ABYSSAL_CALM_GUARANTEED_CACHE_LOOT_ENTRIES),
    weightedLootPools: [
      (0, ports.cloneValue)(ports.ABYSSAL_CALM_BONUS_CACHE_LOOT_POOL),
      (0, ports.cloneValue)(ports.ABYSSAL_CALM_FILAMENT_CACHE_LOOT_POOL),
      (0, ports.cloneValue)(ports.ABYSSAL_CALM_MUTAPLASMID_CACHE_LOOT_POOL),
    ],
    authoredProbabilities: true,
    placeholderNotes: [
      "Agitated baseline uses the Calm reward item composition with Tier 2 runtime scaling.",
    ],
  });
}

function buildAgitatedExoticPlaceholder(ports) {
  return (0, ports.buildPlaceholderRewardProfile)({
    rewardProfileID: "abyssal:reward:agitated-exotic-placeholder",
    lootTableID: "abyssal:loot:agitated-exotic-baseline",
    displayName: "Agitated Exotic Reward Cache",
    tier: 2,
    weatherTheme: "exotic",
    baseLootEntries: (0, ports.cloneValue)(ports.ABYSSAL_CALM_GUARANTEED_CACHE_LOOT_ENTRIES),
    weightedLootPools: [
      (0, ports.cloneValue)(ports.ABYSSAL_CALM_BONUS_CACHE_LOOT_POOL),
      (0, ports.cloneValue)(ports.ABYSSAL_CALM_FILAMENT_CACHE_LOOT_POOL),
      (0, ports.cloneValue)(ports.ABYSSAL_CALM_MUTAPLASMID_CACHE_LOOT_POOL),
    ],
    authoredProbabilities: true,
    placeholderNotes: [
      "Agitated baseline uses the Calm reward item composition with Tier 2 runtime scaling.",
    ],
  });
}

function buildAgitatedFirestormPlaceholder(ports) {
  return (0, ports.buildPlaceholderRewardProfile)({
    rewardProfileID: "abyssal:reward:agitated-firestorm-placeholder",
    lootTableID: "abyssal:loot:agitated-firestorm-baseline",
    displayName: "Agitated Firestorm Reward Cache",
    tier: 2,
    weatherTheme: "firestorm",
    baseLootEntries: (0, ports.cloneValue)(ports.ABYSSAL_CALM_GUARANTEED_CACHE_LOOT_ENTRIES),
    weightedLootPools: [
      (0, ports.cloneValue)(ports.ABYSSAL_CALM_BONUS_CACHE_LOOT_POOL),
      (0, ports.cloneValue)(ports.ABYSSAL_CALM_FILAMENT_CACHE_LOOT_POOL),
      (0, ports.cloneValue)(ports.ABYSSAL_CALM_MUTAPLASMID_CACHE_LOOT_POOL),
    ],
    authoredProbabilities: true,
    placeholderNotes: [
      "Agitated baseline uses the Calm reward item composition with Tier 2 runtime scaling.",
    ],
  });
}

function buildAgitatedGammaPlaceholder(ports) {
  return (0, ports.buildPlaceholderRewardProfile)({
    rewardProfileID: "abyssal:reward:agitated-gamma-placeholder",
    lootTableID: "abyssal:loot:agitated-gamma-baseline",
    displayName: "Agitated Gamma Reward Cache",
    tier: 2,
    weatherTheme: "gamma",
    baseLootEntries: (0, ports.cloneValue)(ports.ABYSSAL_CALM_GUARANTEED_CACHE_LOOT_ENTRIES),
    weightedLootPools: [
      (0, ports.cloneValue)(ports.ABYSSAL_CALM_BONUS_CACHE_LOOT_POOL),
      (0, ports.cloneValue)(ports.ABYSSAL_CALM_FILAMENT_CACHE_LOOT_POOL),
      (0, ports.cloneValue)(ports.ABYSSAL_CALM_MUTAPLASMID_CACHE_LOOT_POOL),
    ],
    authoredProbabilities: true,
    placeholderNotes: [
      "Agitated baseline uses the Calm reward item composition with Tier 2 runtime scaling.",
    ],
  });
}

function buildFierceDarkPlaceholder(ports) {
  return (0, ports.buildPlaceholderRewardProfile)({
    rewardProfileID: "abyssal:reward:fierce-dark-placeholder",
    lootTableID: "abyssal:loot:fierce-dark-baseline",
    displayName: "Fierce Dark Reward Cache",
    tier: 3,
    weatherTheme: "dark",
    baseLootEntries: (0, ports.cloneValue)(ports.ABYSSAL_CALM_GUARANTEED_CACHE_LOOT_ENTRIES),
    weightedLootPools: [
      (0, ports.cloneValue)(ports.ABYSSAL_CALM_BONUS_CACHE_LOOT_POOL),
      (0, ports.cloneValue)(ports.ABYSSAL_CALM_FILAMENT_CACHE_LOOT_POOL),
      (0, ports.cloneValue)(ports.ABYSSAL_CALM_MUTAPLASMID_CACHE_LOOT_POOL),
    ],
    authoredProbabilities: true,
  });
}

function buildFierceElectricalPlaceholder(ports) {
  return (0, ports.buildPlaceholderRewardProfile)({
    rewardProfileID: "abyssal:reward:fierce-electrical-placeholder",
    lootTableID: "abyssal:loot:fierce-electrical-baseline",
    displayName: "Fierce Electrical Reward Cache",
    tier: 3,
    weatherTheme: "electrical",
    baseLootEntries: (0, ports.cloneValue)(ports.ABYSSAL_CALM_GUARANTEED_CACHE_LOOT_ENTRIES),
    weightedLootPools: [
      (0, ports.cloneValue)(ports.ABYSSAL_CALM_BONUS_CACHE_LOOT_POOL),
      (0, ports.cloneValue)(ports.ABYSSAL_CALM_FILAMENT_CACHE_LOOT_POOL),
      (0, ports.cloneValue)(ports.ABYSSAL_CALM_MUTAPLASMID_CACHE_LOOT_POOL),
    ],
    authoredProbabilities: true,
  });
}

function buildFierceExoticPlaceholder(ports) {
  return (0, ports.buildPlaceholderRewardProfile)({
    rewardProfileID: "abyssal:reward:fierce-exotic-placeholder",
    lootTableID: "abyssal:loot:fierce-exotic-baseline",
    displayName: "Fierce Exotic Reward Cache",
    tier: 3,
    weatherTheme: "exotic",
    baseLootEntries: (0, ports.cloneValue)(ports.ABYSSAL_CALM_GUARANTEED_CACHE_LOOT_ENTRIES),
    weightedLootPools: [
      (0, ports.cloneValue)(ports.ABYSSAL_CALM_BONUS_CACHE_LOOT_POOL),
      (0, ports.cloneValue)(ports.ABYSSAL_CALM_FILAMENT_CACHE_LOOT_POOL),
      (0, ports.cloneValue)(ports.ABYSSAL_CALM_MUTAPLASMID_CACHE_LOOT_POOL),
    ],
    authoredProbabilities: true,
  });
}

function buildFierceFirestormPlaceholder(ports) {
  return (0, ports.buildPlaceholderRewardProfile)({
    rewardProfileID: "abyssal:reward:fierce-firestorm-placeholder",
    lootTableID: "abyssal:loot:fierce-firestorm-baseline",
    displayName: "Fierce Firestorm Reward Cache",
    tier: 3,
    weatherTheme: "firestorm",
    baseLootEntries: (0, ports.cloneValue)(ports.ABYSSAL_CALM_GUARANTEED_CACHE_LOOT_ENTRIES),
    weightedLootPools: [
      (0, ports.cloneValue)(ports.ABYSSAL_CALM_BONUS_CACHE_LOOT_POOL),
      (0, ports.cloneValue)(ports.ABYSSAL_CALM_FILAMENT_CACHE_LOOT_POOL),
      (0, ports.cloneValue)(ports.ABYSSAL_CALM_MUTAPLASMID_CACHE_LOOT_POOL),
    ],
    authoredProbabilities: true,
  });
}

function buildFierceGammaPlaceholder(ports) {
  return (0, ports.buildPlaceholderRewardProfile)({
    rewardProfileID: "abyssal:reward:fierce-gamma-placeholder",
    lootTableID: "abyssal:loot:fierce-gamma-baseline",
    displayName: "Fierce Gamma Reward Cache",
    tier: 3,
    weatherTheme: "gamma",
    baseLootEntries: (0, ports.cloneValue)(ports.ABYSSAL_CALM_GUARANTEED_CACHE_LOOT_ENTRIES),
    weightedLootPools: [
      (0, ports.cloneValue)(ports.ABYSSAL_CALM_BONUS_CACHE_LOOT_POOL),
      (0, ports.cloneValue)(ports.ABYSSAL_CALM_FILAMENT_CACHE_LOOT_POOL),
      (0, ports.cloneValue)(ports.ABYSSAL_CALM_MUTAPLASMID_CACHE_LOOT_POOL),
    ],
    authoredProbabilities: true,
  });
}

function buildRagingDarkPlaceholder(ports) {
  return (0, ports.buildPlaceholderRewardProfile)({
    rewardProfileID: "abyssal:reward:raging-dark-placeholder",
    lootTableID: "abyssal:loot:raging-dark-baseline",
    displayName: "Raging Dark Reward Cache",
    tier: 4,
    weatherTheme: "dark",
    baseLootEntries: (0, ports.cloneValue)(ports.ABYSSAL_CALM_GUARANTEED_CACHE_LOOT_ENTRIES),
    weightedLootPools: [
      (0, ports.cloneValue)(ports.ABYSSAL_CALM_BONUS_CACHE_LOOT_POOL),
      (0, ports.cloneValue)(ports.ABYSSAL_CALM_FILAMENT_CACHE_LOOT_POOL),
      (0, ports.cloneValue)(ports.ABYSSAL_CALM_MUTAPLASMID_CACHE_LOOT_POOL),
    ],
    authoredProbabilities: true,
  });
}

function buildRagingElectricalPlaceholder(ports) {
  return (0, ports.buildPlaceholderRewardProfile)({
    rewardProfileID: "abyssal:reward:raging-electrical-placeholder",
    lootTableID: "abyssal:loot:raging-electrical-baseline",
    displayName: "Raging Electrical Reward Cache",
    tier: 4,
    weatherTheme: "electrical",
    baseLootEntries: (0, ports.cloneValue)(ports.ABYSSAL_CALM_GUARANTEED_CACHE_LOOT_ENTRIES),
    weightedLootPools: [
      (0, ports.cloneValue)(ports.ABYSSAL_CALM_BONUS_CACHE_LOOT_POOL),
      (0, ports.cloneValue)(ports.ABYSSAL_CALM_FILAMENT_CACHE_LOOT_POOL),
      (0, ports.cloneValue)(ports.ABYSSAL_CALM_MUTAPLASMID_CACHE_LOOT_POOL),
    ],
    authoredProbabilities: true,
  });
}

function buildRagingExoticPlaceholder(ports) {
  return (0, ports.buildPlaceholderRewardProfile)({
    rewardProfileID: "abyssal:reward:raging-exotic-placeholder",
    lootTableID: "abyssal:loot:raging-exotic-baseline",
    displayName: "Raging Exotic Reward Cache",
    tier: 4,
    weatherTheme: "exotic",
    baseLootEntries: (0, ports.cloneValue)(ports.ABYSSAL_CALM_GUARANTEED_CACHE_LOOT_ENTRIES),
    weightedLootPools: [
      (0, ports.cloneValue)(ports.ABYSSAL_CALM_BONUS_CACHE_LOOT_POOL),
      (0, ports.cloneValue)(ports.ABYSSAL_CALM_FILAMENT_CACHE_LOOT_POOL),
      (0, ports.cloneValue)(ports.ABYSSAL_CALM_MUTAPLASMID_CACHE_LOOT_POOL),
    ],
    authoredProbabilities: true,
  });
}

function buildRagingFirestormPlaceholder(ports) {
  return (0, ports.buildPlaceholderRewardProfile)({
    rewardProfileID: "abyssal:reward:raging-firestorm-placeholder",
    lootTableID: "abyssal:loot:raging-firestorm-baseline",
    displayName: "Raging Firestorm Reward Cache",
    tier: 4,
    weatherTheme: "firestorm",
    baseLootEntries: (0, ports.cloneValue)(ports.ABYSSAL_CALM_GUARANTEED_CACHE_LOOT_ENTRIES),
    weightedLootPools: [
      (0, ports.cloneValue)(ports.ABYSSAL_CALM_BONUS_CACHE_LOOT_POOL),
      (0, ports.cloneValue)(ports.ABYSSAL_CALM_FILAMENT_CACHE_LOOT_POOL),
      (0, ports.cloneValue)(ports.ABYSSAL_CALM_MUTAPLASMID_CACHE_LOOT_POOL),
    ],
    authoredProbabilities: true,
  });
}

function buildRagingGammaPlaceholder(ports) {
  return (0, ports.buildPlaceholderRewardProfile)({
    rewardProfileID: "abyssal:reward:raging-gamma-placeholder",
    lootTableID: "abyssal:loot:raging-gamma-baseline",
    displayName: "Raging Gamma Reward Cache",
    tier: 4,
    weatherTheme: "gamma",
    baseLootEntries: (0, ports.cloneValue)(ports.ABYSSAL_CALM_GUARANTEED_CACHE_LOOT_ENTRIES),
    weightedLootPools: [
      (0, ports.cloneValue)(ports.ABYSSAL_CALM_BONUS_CACHE_LOOT_POOL),
      (0, ports.cloneValue)(ports.ABYSSAL_CALM_FILAMENT_CACHE_LOOT_POOL),
      (0, ports.cloneValue)(ports.ABYSSAL_CALM_MUTAPLASMID_CACHE_LOOT_POOL),
    ],
    authoredProbabilities: true,
  });
}

function buildChaoticDarkPlaceholder(ports) {
  return (0, ports.buildPlaceholderRewardProfile)({
    rewardProfileID: "abyssal:reward:chaotic-dark-placeholder",
    lootTableID: "abyssal:loot:chaotic-dark-baseline",
    displayName: "Chaotic Dark Reward Cache",
    tier: 5,
    weatherTheme: "dark",
    baseLootEntries: (0, ports.cloneValue)(ports.ABYSSAL_CALM_GUARANTEED_CACHE_LOOT_ENTRIES),
    weightedLootPools: [
      (0, ports.cloneValue)(ports.ABYSSAL_CALM_BONUS_CACHE_LOOT_POOL),
      (0, ports.cloneValue)(ports.ABYSSAL_CALM_FILAMENT_CACHE_LOOT_POOL),
      (0, ports.cloneValue)(ports.ABYSSAL_CALM_MUTAPLASMID_CACHE_LOOT_POOL),
    ],
    authoredProbabilities: true,
  });
}

function buildChaoticElectricalPlaceholder(ports) {
  return (0, ports.buildPlaceholderRewardProfile)({
    rewardProfileID: "abyssal:reward:chaotic-electrical-placeholder",
    lootTableID: "abyssal:loot:chaotic-electrical-baseline",
    displayName: "Chaotic Electrical Reward Cache",
    tier: 5,
    weatherTheme: "electrical",
    baseLootEntries: (0, ports.cloneValue)(ports.ABYSSAL_CALM_GUARANTEED_CACHE_LOOT_ENTRIES),
    weightedLootPools: [
      (0, ports.cloneValue)(ports.ABYSSAL_CALM_BONUS_CACHE_LOOT_POOL),
      (0, ports.cloneValue)(ports.ABYSSAL_CALM_FILAMENT_CACHE_LOOT_POOL),
      (0, ports.cloneValue)(ports.ABYSSAL_CALM_MUTAPLASMID_CACHE_LOOT_POOL),
    ],
    authoredProbabilities: true,
  });
}

function buildChaoticExoticPlaceholder(ports) {
  return (0, ports.buildPlaceholderRewardProfile)({
    rewardProfileID: "abyssal:reward:chaotic-exotic-placeholder",
    lootTableID: "abyssal:loot:chaotic-exotic-baseline",
    displayName: "Chaotic Exotic Reward Cache",
    tier: 5,
    weatherTheme: "exotic",
    baseLootEntries: (0, ports.cloneValue)(ports.ABYSSAL_CALM_GUARANTEED_CACHE_LOOT_ENTRIES),
    weightedLootPools: [
      (0, ports.cloneValue)(ports.ABYSSAL_CALM_BONUS_CACHE_LOOT_POOL),
      (0, ports.cloneValue)(ports.ABYSSAL_CALM_FILAMENT_CACHE_LOOT_POOL),
      (0, ports.cloneValue)(ports.ABYSSAL_CALM_MUTAPLASMID_CACHE_LOOT_POOL),
    ],
    authoredProbabilities: true,
  });
}

function buildChaoticFirestormPlaceholder(ports) {
  return (0, ports.buildPlaceholderRewardProfile)({
    rewardProfileID: "abyssal:reward:chaotic-firestorm-placeholder",
    lootTableID: "abyssal:loot:chaotic-firestorm-baseline",
    displayName: "Chaotic Firestorm Reward Cache",
    tier: 5,
    weatherTheme: "firestorm",
    baseLootEntries: (0, ports.cloneValue)(ports.ABYSSAL_CALM_GUARANTEED_CACHE_LOOT_ENTRIES),
    weightedLootPools: [
      (0, ports.cloneValue)(ports.ABYSSAL_CALM_BONUS_CACHE_LOOT_POOL),
      (0, ports.cloneValue)(ports.ABYSSAL_CALM_FILAMENT_CACHE_LOOT_POOL),
      (0, ports.cloneValue)(ports.ABYSSAL_CALM_MUTAPLASMID_CACHE_LOOT_POOL),
    ],
    authoredProbabilities: true,
  });
}

function buildChaoticGammaPlaceholder(ports) {
  return (0, ports.buildPlaceholderRewardProfile)({
    rewardProfileID: "abyssal:reward:chaotic-gamma-placeholder",
    lootTableID: "abyssal:loot:chaotic-gamma-baseline",
    displayName: "Chaotic Gamma Reward Cache",
    tier: 5,
    weatherTheme: "gamma",
    baseLootEntries: (0, ports.cloneValue)(ports.ABYSSAL_CALM_GUARANTEED_CACHE_LOOT_ENTRIES),
    weightedLootPools: [
      (0, ports.cloneValue)(ports.ABYSSAL_CALM_BONUS_CACHE_LOOT_POOL),
      (0, ports.cloneValue)(ports.ABYSSAL_CALM_FILAMENT_CACHE_LOOT_POOL),
      (0, ports.cloneValue)(ports.ABYSSAL_CALM_MUTAPLASMID_CACHE_LOOT_POOL),
    ],
    authoredProbabilities: true,
  });
}

function buildCataclysmicFirestormPlaceholder(ports) {
  return (0, ports.buildPlaceholderRewardProfile)({
    rewardProfileID: "abyssal:reward:cataclysmic-firestorm-placeholder",
    lootTableID: "abyssal:loot:cataclysmic-firestorm-baseline",
    displayName: "Cataclysmic Firestorm Reward Cache",
    tier: 6,
    weatherTheme: "firestorm",
    baseLootEntries: (0, ports.cloneValue)(ports.ABYSSAL_CALM_GUARANTEED_CACHE_LOOT_ENTRIES),
    weightedLootPools: [
      (0, ports.cloneValue)(ports.ABYSSAL_CALM_BONUS_CACHE_LOOT_POOL),
      (0, ports.cloneValue)(ports.ABYSSAL_CALM_FILAMENT_CACHE_LOOT_POOL),
      (0, ports.cloneValue)(ports.ABYSSAL_CALM_MUTAPLASMID_CACHE_LOOT_POOL),
    ],
    authoredProbabilities: true,
  });
}

function buildCataclysmicDarkPlaceholder(ports) {
  return (0, ports.buildPlaceholderRewardProfile)({
    rewardProfileID: "abyssal:reward:cataclysmic-dark-placeholder",
    lootTableID: "abyssal:loot:cataclysmic-dark-baseline",
    displayName: "Cataclysmic Dark Reward Cache",
    tier: 6,
    weatherTheme: "dark",
    baseLootEntries: (0, ports.cloneValue)(ports.ABYSSAL_CALM_GUARANTEED_CACHE_LOOT_ENTRIES),
    weightedLootPools: [
      (0, ports.cloneValue)(ports.ABYSSAL_CALM_BONUS_CACHE_LOOT_POOL),
      (0, ports.cloneValue)(ports.ABYSSAL_CALM_FILAMENT_CACHE_LOOT_POOL),
      (0, ports.cloneValue)(ports.ABYSSAL_CALM_MUTAPLASMID_CACHE_LOOT_POOL),
    ],
    authoredProbabilities: true,
  });
}

function buildCataclysmicElectricalPlaceholder(ports) {
  return (0, ports.buildPlaceholderRewardProfile)({
    rewardProfileID: "abyssal:reward:cataclysmic-electrical-placeholder",
    lootTableID: "abyssal:loot:cataclysmic-electrical-baseline",
    displayName: "Cataclysmic Electrical Reward Cache",
    tier: 6,
    weatherTheme: "electrical",
    baseLootEntries: (0, ports.cloneValue)(ports.ABYSSAL_CALM_GUARANTEED_CACHE_LOOT_ENTRIES),
    weightedLootPools: [
      (0, ports.cloneValue)(ports.ABYSSAL_CALM_BONUS_CACHE_LOOT_POOL),
      (0, ports.cloneValue)(ports.ABYSSAL_CALM_FILAMENT_CACHE_LOOT_POOL),
      (0, ports.cloneValue)(ports.ABYSSAL_CALM_MUTAPLASMID_CACHE_LOOT_POOL),
    ],
    authoredProbabilities: true,
  });
}

function buildCataclysmicExoticPlaceholder(ports) {
  return (0, ports.buildPlaceholderRewardProfile)({
    rewardProfileID: "abyssal:reward:cataclysmic-exotic-placeholder",
    lootTableID: "abyssal:loot:cataclysmic-exotic-baseline",
    displayName: "Cataclysmic Exotic Reward Cache",
    tier: 6,
    weatherTheme: "exotic",
    baseLootEntries: (0, ports.cloneValue)(ports.ABYSSAL_CALM_GUARANTEED_CACHE_LOOT_ENTRIES),
    weightedLootPools: [
      (0, ports.cloneValue)(ports.ABYSSAL_CALM_BONUS_CACHE_LOOT_POOL),
      (0, ports.cloneValue)(ports.ABYSSAL_CALM_FILAMENT_CACHE_LOOT_POOL),
      (0, ports.cloneValue)(ports.ABYSSAL_CALM_MUTAPLASMID_CACHE_LOOT_POOL),
    ],
    authoredProbabilities: true,
  });
}

function buildCataclysmicGammaPlaceholder(ports) {
  return (0, ports.buildPlaceholderRewardProfile)({
    rewardProfileID: "abyssal:reward:cataclysmic-gamma-placeholder",
    lootTableID: "abyssal:loot:cataclysmic-gamma-baseline",
    displayName: "Cataclysmic Gamma Reward Cache",
    tier: 6,
    weatherTheme: "gamma",
    baseLootEntries: (0, ports.cloneValue)(ports.ABYSSAL_CALM_GUARANTEED_CACHE_LOOT_ENTRIES),
    weightedLootPools: [
      (0, ports.cloneValue)(ports.ABYSSAL_CALM_BONUS_CACHE_LOOT_POOL),
      (0, ports.cloneValue)(ports.ABYSSAL_CALM_FILAMENT_CACHE_LOOT_POOL),
      (0, ports.cloneValue)(ports.ABYSSAL_CALM_MUTAPLASMID_CACHE_LOOT_POOL),
    ],
    authoredProbabilities: true,
  });
}

function createAbyssalCompatibilityRewardTemplates(ports) {
  return {
    "abyssal:reward:tranquil-dark-placeholder": buildTranquilDarkPlaceholder(ports),
    "abyssal:reward:tranquil-electrical-placeholder": buildTranquilElectricalPlaceholder(ports),
    "abyssal:reward:tranquil-exotic-placeholder": buildTranquilExoticPlaceholder(ports),
    "abyssal:reward:tranquil-firestorm-placeholder": buildTranquilFirestormPlaceholder(ports),
    "abyssal:reward:tranquil-gamma-placeholder": buildTranquilGammaPlaceholder(ports),
    "abyssal:reward:calm-dark-placeholder": buildCalmDarkPlaceholder(ports),
    "abyssal:reward:calm-electrical-placeholder": buildCalmElectricalPlaceholder(ports),
    "abyssal:reward:calm-exotic-placeholder": buildCalmExoticPlaceholder(ports),
    "abyssal:reward:calm-firestorm-placeholder": buildCalmFirestormPlaceholder(ports),
    "abyssal:reward:calm-gamma-placeholder": buildCalmGammaPlaceholder(ports),
    "abyssal:reward:agitated-dark-placeholder": buildAgitatedDarkPlaceholder(ports),
    "abyssal:reward:agitated-electrical-placeholder": buildAgitatedElectricalPlaceholder(ports),
    "abyssal:reward:agitated-exotic-placeholder": buildAgitatedExoticPlaceholder(ports),
    "abyssal:reward:agitated-firestorm-placeholder": buildAgitatedFirestormPlaceholder(ports),
    "abyssal:reward:agitated-gamma-placeholder": buildAgitatedGammaPlaceholder(ports),
    "abyssal:reward:fierce-dark-placeholder": buildFierceDarkPlaceholder(ports),
    "abyssal:reward:fierce-electrical-placeholder": buildFierceElectricalPlaceholder(ports),
    "abyssal:reward:fierce-exotic-placeholder": buildFierceExoticPlaceholder(ports),
    "abyssal:reward:fierce-firestorm-placeholder": buildFierceFirestormPlaceholder(ports),
    "abyssal:reward:fierce-gamma-placeholder": buildFierceGammaPlaceholder(ports),
    "abyssal:reward:raging-dark-placeholder": buildRagingDarkPlaceholder(ports),
    "abyssal:reward:raging-electrical-placeholder": buildRagingElectricalPlaceholder(ports),
    "abyssal:reward:raging-exotic-placeholder": buildRagingExoticPlaceholder(ports),
    "abyssal:reward:raging-firestorm-placeholder": buildRagingFirestormPlaceholder(ports),
    "abyssal:reward:raging-gamma-placeholder": buildRagingGammaPlaceholder(ports),
    "abyssal:reward:chaotic-dark-placeholder": buildChaoticDarkPlaceholder(ports),
    "abyssal:reward:chaotic-electrical-placeholder": buildChaoticElectricalPlaceholder(ports),
    "abyssal:reward:chaotic-exotic-placeholder": buildChaoticExoticPlaceholder(ports),
    "abyssal:reward:chaotic-firestorm-placeholder": buildChaoticFirestormPlaceholder(ports),
    "abyssal:reward:chaotic-gamma-placeholder": buildChaoticGammaPlaceholder(ports),
    "abyssal:reward:cataclysmic-firestorm-placeholder": buildCataclysmicFirestormPlaceholder(ports),
    "abyssal:reward:cataclysmic-dark-placeholder": buildCataclysmicDarkPlaceholder(ports),
    "abyssal:reward:cataclysmic-electrical-placeholder": buildCataclysmicElectricalPlaceholder(ports),
    "abyssal:reward:cataclysmic-exotic-placeholder": buildCataclysmicExoticPlaceholder(ports),
    "abyssal:reward:cataclysmic-gamma-placeholder": buildCataclysmicGammaPlaceholder(ports),
  };
}

module.exports = { createAbyssalCompatibilityRewardTemplates };
