"use strict";

const {
  ABYSSAL_CONTENT_AUTHORITY,
} = require("./abyssalContentAuthority");
const {
  ABYSSAL_REWARD_QUANTITY_POLICY,
} = require("../domain/abyssalRewardQuantityPolicy");

const ABYSSAL_PROCEDURAL_REWARD_MODEL_ID =
  "abyssal:procedural-sde-reward-catalogue-v1";
const CATEGORY_BLUEPRINT = 9;
const CATEGORY_SHIP = 6;
const GROUP_ABYSSAL_FILAMENT = 1979;
const GROUP_MUTAPLASMID = 1964;
const GROUP_SEQUENCE_BINDER = 4725;
const PRECURSOR_RACE_ID = 135;

const ABYSSAL_TIER_NAMES = Object.freeze([
  "Tranquil",
  "Calm",
  "Agitated",
  "Fierce",
  "Raging",
  "Chaotic",
  "Cataclysmic",
]);

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function normalizeText(value) {
  return String(value == null ? "" : value).trim();
}

function isPublishedType(type) {
  return Boolean(
    type &&
    toInt(type.typeID, 0) > 0 &&
    normalizeText(type.name) &&
    type.published !== false
  );
}

function toRewardEntry(type, overrides = {}) {
  return {
    itemName: normalizeText(type.name),
    itemTypeID: toInt(type.typeID, 0),
    quantity: Math.max(1, toInt(overrides.quantity, 1)),
    minQuantity: Math.max(1, toInt(overrides.minQuantity, 1)),
    maxQuantity: Math.max(
      1,
      toInt(overrides.maxQuantity, toInt(overrides.minQuantity, 1)),
    ),
    probability: 1,
    weight: Number.isFinite(Number(overrides.weight))
      ? Math.max(Number.EPSILON, Number(overrides.weight))
      : 1,
  };
}

function getMutaplasmidQualityRank(type) {
  const name = normalizeText(type && type.name);
  if (!name || toInt(type && type.groupID, 0) !== GROUP_MUTAPLASMID) {
    return -1;
  }
  if (/^(?:Glorified|Exigent|Radical)\b/i.test(name)) return 3;
  if (/^Unstable\b/i.test(name)) return 2;
  if (/^Gravid\b/i.test(name)) return 1;
  if (/^Decayed\b/i.test(name)) return 0;
  return -1;
}

function getBlueprintQualityRank(type) {
  const name = normalizeText(type && type.name);
  const groupName = normalizeText(type && type.groupName);
  if (/\b(?:XL|X-Large|Capital|Dreadnought|Marauder|Tiamat|Hydra)\b/i.test(
    `${name} ${groupName}`,
  )) {
    return 3;
  }
  if (/\b(?:II|Zorya's|Veles|Perun|L|Large|Battleship|Heavy Assault|Logistics|Force Recon|Covert Ops|Assault Frigate)\b/i.test(
    `${name} ${groupName}`,
  )) {
    return 2;
  }
  if (/\b(?:M|Medium|Heavy|Cruiser|Battlecruiser|Command Destroyer)\b/i.test(
    `${name} ${groupName}`,
  )) {
    return 1;
  }
  return 0;
}

function minimumTierForQualityRank(rank) {
  return [0, 1, 3, 5][Math.max(0, Math.min(3, toInt(rank, 0)))];
}

function buildQualityWeightedEntries(types, tier, rankResolver) {
  const eligible = types
    .map((type) => ({ type, rank: rankResolver(type) }))
    .filter(({ rank }) => rank >= 0 && minimumTierForQualityRank(rank) <= tier);
  const countsByRank = new Map();
  for (const { rank } of eligible) {
    countsByRank.set(rank, (countsByRank.get(rank) || 0) + 1);
  }
  const targetRank = Math.min(3, tier / 2);
  return eligible
    .map(({ type, rank }) => toRewardEntry(type, {
      weight: 1_000 * Math.pow(4, -Math.abs(rank - targetRank)) /
        countsByRank.get(rank),
    }))
    .sort((left, right) => left.itemTypeID - right.itemTypeID);
}

function classifyProceduralRewardTypes(itemTypes = []) {
  const publishedTypes = (Array.isArray(itemTypes) ? itemTypes : [])
    .filter(isPublishedType);
  const byName = new Map(publishedTypes.map((type) => [
    normalizeText(type.name).toLowerCase(),
    type,
  ]));
  const requiredMaterials = [
    "Triglavian Survey Database",
    "Zero-Point Condensate",
    "Crystalline Isogen-10",
  ].map((name) => byName.get(name.toLowerCase()) || null);
  if (requiredMaterials.some((type) => !type)) {
    throw new TypeError("Procedural Abyssal rewards require all core material types");
  }

  const precursorShipNames = new Set(publishedTypes
    .filter((type) =>
      toInt(type.categoryID, 0) === CATEGORY_SHIP &&
      toInt(type.raceID, 0) === PRECURSOR_RACE_ID
    )
    .map((type) => normalizeText(type.name).toLowerCase()));

  return {
    coreMaterials: requiredMaterials,
    mutaplasmids: publishedTypes.filter((type) =>
      toInt(type.groupID, 0) === GROUP_MUTAPLASMID &&
      /\bMutaplasmid$/i.test(normalizeText(type.name)) &&
      getMutaplasmidQualityRank(type) >= 0
    ),
    filaments: publishedTypes.filter((type) =>
      toInt(type.groupID, 0) === GROUP_ABYSSAL_FILAMENT &&
      /\bFilament$/i.test(normalizeText(type.name))
    ),
    moduleBlueprints: publishedTypes.filter((type) =>
      toInt(type.categoryID, 0) === CATEGORY_BLUEPRINT &&
      /(?:entropic|mutadaptive)/i.test(normalizeText(type.name))
    ),
    exoticAmmoBlueprints: publishedTypes.filter((type) =>
      toInt(type.categoryID, 0) === CATEGORY_BLUEPRINT &&
      /\bExotic Plasma\b.*\bBlueprint$/i.test(normalizeText(type.name))
    ),
    precursorShipBlueprints: publishedTypes.filter((type) =>
      toInt(type.categoryID, 0) === CATEGORY_BLUEPRINT &&
      /\bBlueprint$/i.test(normalizeText(type.name)) &&
      precursorShipNames.has(
        normalizeText(type.name).replace(/\s+Blueprint$/i, "").toLowerCase(),
      )
    ),
    sequenceBinders: publishedTypes.filter((type) =>
      toInt(type.groupID, 0) === GROUP_SEQUENCE_BINDER
    ),
  };
}

function buildCoreMaterialEntries(classified, tier) {
  const scale = Math.pow(tier + 1, 2);
  const quantitiesByName = new Map([
    ["triglavian survey database", 5 * scale],
    ["zero-point condensate", scale],
    ["crystalline isogen-10", 2 * scale],
  ]);
  return classified.coreMaterials.map((type) => toRewardEntry(type, {
    quantity: quantitiesByName.get(normalizeText(type.name).toLowerCase()),
  }));
}

function buildFilamentEntries(classified, tier, weatherType) {
  const eligibleTierNames = new Set([
    ABYSSAL_TIER_NAMES[tier],
    ABYSSAL_TIER_NAMES[Math.min(6, tier + 1)],
  ]);
  const normalizedWeather = normalizeText(weatherType).toLowerCase();
  return classified.filaments
    .filter((type) => eligibleTierNames.has(normalizeText(type.name).split(/\s+/)[0]))
    .map((type) => {
      const name = normalizeText(type.name);
      const isSameTier = name.startsWith(`${ABYSSAL_TIER_NAMES[tier]} `);
      const isSameWeather = name.toLowerCase().includes(` ${normalizedWeather} `);
      return toRewardEntry(type, {
        weight: (isSameTier ? 4 : 1) * (isSameWeather ? 2 : 1),
        maxQuantity: tier >= 4 ? 2 : 1,
      });
    })
    .sort((left, right) => left.itemTypeID - right.itemTypeID);
}

function buildWeightedPool(poolID, displayName, chance, rolls, entries) {
  return {
    poolID,
    displayName,
    chance: Math.max(0, Math.min(1, chance)),
    rolls: Math.max(1, toInt(rolls, 1)),
    entries,
  };
}

function buildProceduralAbyssalRewardProfile({
  tier,
  weatherType,
  itemTypes,
  classifiedTypes = null,
} = {}) {
  const numericTier = toInt(tier, -1);
  if (numericTier < 0 || numericTier > 6) {
    throw new TypeError(`Unsupported procedural Abyssal reward tier: ${tier}`);
  }
  const normalizedWeather = normalizeText(weatherType).toLowerCase();
  const classified = classifiedTypes || classifyProceduralRewardTypes(itemTypes);
  const mutaplasmidEntries = buildQualityWeightedEntries(
    classified.mutaplasmids,
    numericTier,
    getMutaplasmidQualityRank,
  );
  const moduleBlueprintEntries = buildQualityWeightedEntries(
    classified.moduleBlueprints,
    numericTier,
    getBlueprintQualityRank,
  );
  const ammoBlueprintEntries = buildQualityWeightedEntries(
    classified.exoticAmmoBlueprints,
    numericTier,
    getBlueprintQualityRank,
  );
  const shipBlueprintEntries = buildQualityWeightedEntries(
    classified.precursorShipBlueprints,
    numericTier,
    getBlueprintQualityRank,
  );

  return {
    rewardProfileID:
      `abyssal:reward:tier${numericTier}:${normalizedWeather}:procedural-sde-v1`,
    lootTableID:
      `abyssal:loot:tier${numericTier}:${normalizedWeather}:procedural-sde-v1`,
    displayName:
      `Tier ${numericTier} ${normalizedWeather} Procedural Abyssal Reward`,
    tier: numericTier,
    weatherTheme: normalizedWeather,
    rewardKind: "cache_loot",
    rewardMode: "procedural_sde_weighted_pool",
    rewardTableKind: "procedural_sde_weighted_pool",
    capturedExact: false,
    replaceCapturedReward: true,
    sourceModelID: ABYSSAL_PROCEDURAL_REWARD_MODEL_ID,
    contentAuthority: ABYSSAL_CONTENT_AUTHORITY.PROJECT_AUTHORED,
    authoredProbabilities: true,
    quantityPolicy: ABYSSAL_REWARD_QUANTITY_POLICY.RETAIL_FINAL,
    roomMultipliersByIndex: { 1: 1, 2: 1, 3: 1 },
    baseLootEntries: buildCoreMaterialEntries(classified, numericTier),
    weightedLootPools: [
      buildWeightedPool(
        "abyssal:loot:procedural:mutaplasmids",
        "Tier-weighted Mutaplasmids",
        1,
        1 + Math.floor(numericTier / 2),
        mutaplasmidEntries,
      ),
      buildWeightedPool(
        "abyssal:loot:procedural:filaments",
        "Same or next-tier Abyssal Filaments",
        1,
        1,
        buildFilamentEntries(classified, numericTier, normalizedWeather),
      ),
      buildWeightedPool(
        "abyssal:loot:procedural:module-blueprints",
        "Entropic and Mutadaptive Blueprint Copies",
        Math.min(0.35, 0.05 * (numericTier + 1)),
        1,
        moduleBlueprintEntries,
      ),
      buildWeightedPool(
        "abyssal:loot:procedural:ammo-blueprints",
        "Exotic Plasma Blueprint Copies",
        Math.min(0.56, 0.08 * (numericTier + 1)),
        1,
        ammoBlueprintEntries,
      ),
      buildWeightedPool(
        "abyssal:loot:procedural:ship-blueprints",
        "Precursor Ship Blueprint Copies",
        Math.min(0.12, 0.005 * Math.pow(numericTier + 1, 1.6)),
        1,
        shipBlueprintEntries,
      ),
      buildWeightedPool(
        "abyssal:loot:procedural:sequence-binders",
        "Sequence Binders",
        Math.min(0.14, 0.02 * (numericTier + 1)),
        1,
        classified.sequenceBinders.map((type) => toRewardEntry(type)),
      ),
    ].filter((pool) => pool.entries.length > 0),
    observedRunLootOutcomes: [],
    observedRunLootAllocation: null,
    placeholderNotes: [
      "Project-authored procedural distribution derived from published SDE item identity.",
      "Quality weights and probabilities intentionally increase with tier but are not retail-exact.",
    ],
  };
}

module.exports = {
  ABYSSAL_PROCEDURAL_REWARD_MODEL_ID,
  ABYSSAL_TIER_NAMES,
  buildProceduralAbyssalRewardProfile,
  classifyProceduralRewardTypes,
  getBlueprintQualityRank,
  getMutaplasmidQualityRank,
  minimumTierForQualityRank,
};
