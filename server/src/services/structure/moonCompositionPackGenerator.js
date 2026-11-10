"use strict";

const crypto = require("node:crypto");
const path = require("node:path");

const {
  calculateAuthorityContentHash,
} = require(path.join(__dirname, "./moonResourceAuthority"));
const pirateFactionPolicy = require(path.join(
  __dirname,
  "../../space/npc/pirateFactionPolicy",
));
const { isPochvenSystem } = require(path.join(__dirname, "../../space/pochvenPolicy"));

const GENERATOR_VERSION = 4;
const RULESET_SCHEMA_VERSION = 2;
const FRACTION_SCALE = 10_000;
const ORE_COUNT_OPTIONS = Object.freeze([2, 3, 4]);

const SPACE_CLASS = Object.freeze({
  HIGHSEC: "highsec",
  LOWSEC: "lowsec",
  NULLSEC: "nullsec",
  WORMHOLE: "wormhole",
  POCHVEN: "pochven",
  SPECIAL: "special",
});

const MOON_ORES_BY_TIER = Object.freeze({
  R4: Object.freeze([45490, 45491, 45492, 45493]),
  R8: Object.freeze([45494, 45495, 45496, 45497]),
  R16: Object.freeze([45498, 45499, 45500, 45501]),
  R32: Object.freeze([45502, 45503, 45504, 45506]),
  R64: Object.freeze([45510, 45511, 45512, 45513]),
});

const COMPONENT_TIERS_BY_PRIMARY_TIER = Object.freeze({
  R4: Object.freeze(["R4"]),
  R8: Object.freeze(["R8", "R4"]),
  R16: Object.freeze(["R16", "R8", "R4"]),
  R32: Object.freeze(["R32", "R16", "R8", "R4"]),
  R64: Object.freeze(["R64", "R32", "R16", "R8", "R4"]),
});

const ALLOWED_TIERS_BY_SPACE = Object.freeze({
  [SPACE_CLASS.HIGHSEC]: Object.freeze(["R4"]),
  [SPACE_CLASS.LOWSEC]: Object.freeze(["R4", "R8", "R16", "R32", "R64"]),
  [SPACE_CLASS.NULLSEC]: Object.freeze(["R4", "R8", "R16", "R32", "R64"]),
  [SPACE_CLASS.WORMHOLE]: Object.freeze(["R4"]),
});

const DEFAULT_RULESET = Object.freeze({
  schemaVersion: RULESET_SCHEMA_VERSION,
  rulesetID: "evejs-moon-materials-v2",
  tierWeightsBySpace: Object.freeze({
    [SPACE_CLASS.HIGHSEC]: Object.freeze({ R4: 1 }),
    // The R labels represent relative rarity. These weights preserve that
    // ordering but are intentionally project-generated, not a claim about
    // Tranquility's undisclosed moon table.
    [SPACE_CLASS.LOWSEC]: Object.freeze({ R4: 16, R8: 8, R16: 4, R32: 2, R64: 1 }),
    [SPACE_CLASS.NULLSEC]: Object.freeze({ R4: 16, R8: 8, R16: 4, R32: 2, R64: 1 }),
    [SPACE_CLASS.WORMHOLE]: Object.freeze({ R4: 1 }),
  }),
  // Public scans show moons containing a few distinct ores, including several
  // ores from the same rarity tier. These are project weights rather than a
  // claim about the undisclosed Tranquility generator.
  oreCountWeights: Object.freeze({ 2: 5, 3: 3, 4: 1 }),
  componentTierWeightsByPrimaryTier: Object.freeze({
    R4: Object.freeze({ R4: 1 }),
    R8: Object.freeze({ R8: 1, R4: 2 }),
    R16: Object.freeze({ R16: 1, R8: 1, R4: 2 }),
    R32: Object.freeze({ R32: 1, R16: 1, R8: 1, R4: 2 }),
    R64: Object.freeze({ R64: 1, R32: 1, R16: 1, R8: 1, R4: 2 }),
  }),
  // Entries are optional, positive multipliers keyed by pirate-faction key,
  // then ore typeID. Omitting an entry means weight 1. Zero is rejected so a
  // faction remains a bias, never an invented hard material whitelist.
  factionOreWeightMultipliers: Object.freeze({}),
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function positiveInteger(value) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : 0;
}

function finiteNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

function canonicalize(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("canonical JSON cannot contain a non-finite number");
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (!isPlainObject(value)) {
    throw new TypeError("canonical JSON must contain only JSON values");
  }
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  );
}

function sha256Json(value) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonicalize(value)), "utf8")
    .digest("hex");
}

function normalizeRuleset(rawRuleset = DEFAULT_RULESET) {
  if (!isPlainObject(rawRuleset)) {
    throw new TypeError("moon composition ruleset must be an object");
  }
  if (rawRuleset.schemaVersion !== RULESET_SCHEMA_VERSION) {
    throw new TypeError(`moon composition ruleset schemaVersion must be ${RULESET_SCHEMA_VERSION}`);
  }
  const rulesetID = String(rawRuleset.rulesetID || "").trim();
  if (!rulesetID) {
    throw new TypeError("moon composition rulesetID is required");
  }
  if (!isPlainObject(rawRuleset.tierWeightsBySpace)) {
    throw new TypeError("moon composition tierWeightsBySpace is required");
  }

  const tierWeightsBySpace = {};
  for (const [spaceClass, allowedTiers] of Object.entries(ALLOWED_TIERS_BY_SPACE)) {
    const rawWeights = rawRuleset.tierWeightsBySpace[spaceClass];
    if (!isPlainObject(rawWeights)) {
      throw new TypeError(`moon composition ruleset lacks ${spaceClass} tier weights`);
    }
    const weights = {};
    for (const tier of allowedTiers) {
      const weight = finiteNumber(rawWeights[tier]);
      if (weight === null || weight <= 0) {
        throw new TypeError(`${spaceClass}.${tier} must be a positive finite weight`);
      }
      weights[tier] = weight;
    }
    for (const tier of Object.keys(rawWeights)) {
      if (!allowedTiers.includes(tier)) {
        throw new TypeError(`${spaceClass}.${tier} is not permitted in this security class`);
      }
    }
    tierWeightsBySpace[spaceClass] = Object.freeze(weights);
  }

  if (!isPlainObject(rawRuleset.oreCountWeights)) {
    throw new TypeError("moon composition oreCountWeights is required");
  }
  const oreCountWeights = {};
  for (const oreCount of ORE_COUNT_OPTIONS) {
    const weight = finiteNumber(rawRuleset.oreCountWeights[oreCount]);
    if (weight === null || weight <= 0) {
      throw new TypeError(`oreCountWeights.${oreCount} must be a positive finite weight`);
    }
    oreCountWeights[oreCount] = weight;
  }
  for (const oreCount of Object.keys(rawRuleset.oreCountWeights)) {
    if (!ORE_COUNT_OPTIONS.includes(Number(oreCount))) {
      throw new TypeError(`oreCountWeights.${oreCount} is not a supported ore count`);
    }
  }

  if (!isPlainObject(rawRuleset.componentTierWeightsByPrimaryTier)) {
    throw new TypeError("moon composition componentTierWeightsByPrimaryTier is required");
  }
  const componentTierWeightsByPrimaryTier = {};
  for (const [primaryTier, componentTiers] of Object.entries(COMPONENT_TIERS_BY_PRIMARY_TIER)) {
    const rawWeights = rawRuleset.componentTierWeightsByPrimaryTier[primaryTier];
    if (!isPlainObject(rawWeights)) {
      throw new TypeError(`componentTierWeightsByPrimaryTier lacks ${primaryTier} weights`);
    }
    const weights = {};
    for (const tier of componentTiers) {
      const weight = finiteNumber(rawWeights[tier]);
      if (weight === null || weight <= 0) {
        throw new TypeError(
          `componentTierWeightsByPrimaryTier.${primaryTier}.${tier} must be a positive finite weight`,
        );
      }
      weights[tier] = weight;
    }
    for (const tier of Object.keys(rawWeights)) {
      if (!componentTiers.includes(tier)) {
        throw new TypeError(
          `componentTierWeightsByPrimaryTier.${primaryTier}.${tier} exceeds the primary tier`,
        );
      }
    }
    componentTierWeightsByPrimaryTier[primaryTier] = Object.freeze(weights);
  }

  const rawFactionWeights = rawRuleset.factionOreWeightMultipliers || {};
  if (!isPlainObject(rawFactionWeights)) {
    throw new TypeError("factionOreWeightMultipliers must be an object");
  }
  const factionOreWeightMultipliers = {};
  for (const [factionKey, rawOreWeights] of Object.entries(rawFactionWeights)) {
    if (!isPlainObject(rawOreWeights)) {
      throw new TypeError(`factionOreWeightMultipliers.${factionKey} must be an object`);
    }
    const oreWeights = {};
    for (const [rawTypeID, rawWeight] of Object.entries(rawOreWeights)) {
      const typeID = positiveInteger(rawTypeID);
      const weight = finiteNumber(rawWeight);
      if (!typeID || weight === null || weight <= 0) {
        throw new TypeError(
          `factionOreWeightMultipliers.${factionKey}.${rawTypeID} must be positive`,
        );
      }
      if (!Object.values(MOON_ORES_BY_TIER).some((types) => types.includes(typeID))) {
        throw new TypeError(`typeID ${typeID} is not a base moon ore`);
      }
      oreWeights[String(typeID)] = weight;
    }
    factionOreWeightMultipliers[String(factionKey).trim().toLowerCase()] = Object.freeze(oreWeights);
  }

  return deepFreeze({
    schemaVersion: RULESET_SCHEMA_VERSION,
    rulesetID,
    tierWeightsBySpace,
    oreCountWeights: Object.freeze(oreCountWeights),
    componentTierWeightsByPrimaryTier: Object.freeze(componentTierWeightsByPrimaryTier),
    factionOreWeightMultipliers,
  });
}

function hmacUnit(seed, context) {
  const digest = crypto
    .createHmac("sha256", seed)
    .update(String(context), "utf8")
    .digest();
  return digest.readUInt32BE(0) / 0x1_0000_0000;
}

function chooseWeighted(seed, context, candidates, getWeight) {
  const rows = candidates.map((candidate) => ({ candidate, weight: Number(getWeight(candidate)) }));
  const total = rows.reduce((sum, row) => sum + (Number.isFinite(row.weight) ? row.weight : 0), 0);
  if (!(total > 0)) {
    throw new TypeError(`No positive generator weight for ${context}`);
  }
  const target = hmacUnit(seed, context) * total;
  let cursor = 0;
  for (const row of rows) {
    cursor += row.weight;
    if (target < cursor) {
      return row.candidate;
    }
  }
  return rows[rows.length - 1].candidate;
}

function normalizeFactionKey(value) {
  const text = String(value || "").trim().toLowerCase();
  return text || "mixed";
}

function securityStatusFromSystem(system) {
  return finiteNumber(system && (system.security ?? system.securityStatus));
}

function defaultSystemContext(system) {
  const solarSystemID = positiveInteger(system && (system.solarSystemID ?? system.systemID));
  if (!solarSystemID) {
    throw new TypeError("moon composition system needs a solarSystemID");
  }
  if (isPochvenSystem(solarSystemID, system)) {
    return { spaceClass: SPACE_CLASS.POCHVEN, factionKey: "triglavians" };
  }
  if (pirateFactionPolicy.isWormholeSpaceSystem(solarSystemID)) {
    return { spaceClass: SPACE_CLASS.WORMHOLE, factionKey: "sleepers" };
  }
  if (pirateFactionPolicy.isSpecialSpaceSystem(solarSystemID, system)) {
    return { spaceClass: SPACE_CLASS.SPECIAL, factionKey: "mixed" };
  }
  const security = securityStatusFromSystem(system);
  if (security === null || security < -1 || security > 1) {
    throw new TypeError(`system ${solarSystemID} has an invalid security status`);
  }
  const factionKey = normalizeFactionKey(
    system.factionKey || pirateFactionPolicy.resolvePirateFactionForSystem(
      solarSystemID,
      { systemRecord: system },
    ).factionKey,
  );
  return {
    spaceClass: security >= 0.45
      ? SPACE_CLASS.HIGHSEC
      : security > 0
        ? SPACE_CLASS.LOWSEC
        : SPACE_CLASS.NULLSEC,
    factionKey,
  };
}

function normalizeMoon(rawMoon) {
  const moonID = positiveInteger(rawMoon && (rawMoon.moonID ?? rawMoon.itemID ?? rawMoon.celestialID));
  const solarSystemID = positiveInteger(rawMoon && rawMoon.solarSystemID);
  if (!moonID || !solarSystemID) {
    throw new TypeError("moon composition moon needs itemID and solarSystemID");
  }
  if (rawMoon.groupID != null && Number(rawMoon.groupID) !== 8) {
    throw new TypeError(`celestial ${moonID} is not a moon (groupID 8)`);
  }
  return { moonID, solarSystemID };
}

function normalizeUniverse(rawUniverse = {}) {
  const rawSystems = Array.isArray(rawUniverse.systems) ? rawUniverse.systems : [];
  const rawMoons = Array.isArray(rawUniverse.moons) ? rawUniverse.moons : [];
  if (rawSystems.length === 0 || rawMoons.length === 0) {
    throw new TypeError("moon composition universe requires non-empty systems and moons arrays");
  }
  const systemsByID = new Map();
  for (const system of rawSystems) {
    const solarSystemID = positiveInteger(system && (system.solarSystemID ?? system.systemID));
    if (!solarSystemID || systemsByID.has(solarSystemID)) {
      throw new TypeError(`invalid or duplicate system ${solarSystemID || "ID"}`);
    }
    systemsByID.set(solarSystemID, system);
  }
  const moons = rawMoons.map(normalizeMoon).sort((left, right) => left.moonID - right.moonID);
  for (let index = 1; index < moons.length; index += 1) {
    if (moons[index - 1].moonID === moons[index].moonID) {
      throw new TypeError(`duplicate moon ${moons[index].moonID}`);
    }
  }
  for (const moon of moons) {
    if (!systemsByID.has(moon.solarSystemID)) {
      throw new TypeError(`moon ${moon.moonID} references unknown system ${moon.solarSystemID}`);
    }
  }
  const moonIDs = new Set(moons.map((moon) => moon.moonID));
  const moonsByID = new Map(moons.map((moon) => [moon.moonID, moon]));
  const rawMiningPoints = Array.isArray(rawUniverse.moonMiningPoints)
    ? rawUniverse.moonMiningPoints
    : [];
  if (rawMiningPoints.length === 0) {
    throw new TypeError("moon composition universe requires verified moon mining points");
  }
  const miningPointsByMoonID = new Map();
  for (const point of rawMiningPoints) {
    const moonID = positiveInteger(point && point.moonID);
    const solarSystemID = positiveInteger(point && point.solarSystemID);
    if (!moonID || !solarSystemID || !moonIDs.has(moonID) ||
      systemsByID.get(solarSystemID) === undefined) {
      throw new TypeError("moon mining point does not match the composition universe");
    }
    const moon = moonsByID.get(moonID);
    if (!moon || moon.solarSystemID !== solarSystemID || miningPointsByMoonID.has(moonID)) {
      throw new TypeError(`invalid or duplicate moon mining point for moon ${moonID || "ID"}`);
    }
    miningPointsByMoonID.set(moonID, point);
  }
  return {
    systemsByID,
    moons: moons.filter((moon) => miningPointsByMoonID.has(moon.moonID)),
    sourceMoonCount: moons.length,
    miningPointsByMoonID,
  };
}

function calculateUniverseHash(moons, systemsByID, resolveSystemContext) {
  const hash = crypto.createHash("sha256");
  for (const moon of moons) {
    const system = systemsByID.get(moon.solarSystemID);
    const context = resolveSystemContext(system);
    hash.update(JSON.stringify([
      moon.moonID,
      moon.solarSystemID,
      securityStatusFromSystem(system),
      positiveInteger(system && system.regionID) || null,
      positiveInteger(system && system.factionID) || null,
      context.spaceClass,
      context.factionKey,
    ]));
    hash.update("\n");
  }
  return hash.digest("hex");
}

function oreWeight(ruleset, factionKey, typeID) {
  const factionWeights = ruleset.factionOreWeightMultipliers[factionKey];
  return factionWeights && factionWeights[String(typeID)] !== undefined
    ? factionWeights[String(typeID)]
    : 1;
}

function allocateBasisPoints(seed, context, typeIDs) {
  if (typeIDs.length === 1) {
    return [{ typeID: typeIDs[0], fraction: 1 }];
  }
  // Independent exponential weights produce both balanced and ore-dominant
  // moons without making the highest rarity tier the largest percentage.
  const weights = typeIDs.map((typeID) => (
    0.05 - Math.log(1 - hmacUnit(seed, `${context}|fraction:type:${typeID}`))
  ));
  const totalWeight = weights.reduce((sum, value) => sum + value, 0);
  const distributable = FRACTION_SCALE - typeIDs.length;
  const allocations = typeIDs.map((typeID, index) => {
    const exactShare = (weights[index] / totalWeight) * distributable;
    return {
      typeID,
      basisPoints: 1 + Math.floor(exactShare),
      remainder: exactShare - Math.floor(exactShare),
    };
  });
  let unassigned = FRACTION_SCALE - allocations.reduce(
    (sum, allocation) => sum + allocation.basisPoints,
    0,
  );
  const remainderOrder = [...allocations].sort(
    (left, right) => right.remainder - left.remainder || left.typeID - right.typeID,
  );
  for (let index = 0; unassigned > 0; index += 1, unassigned -= 1) {
    remainderOrder[index % remainderOrder.length].basisPoints += 1;
  }
  return allocations
    .map(({ typeID, basisPoints }) => ({ typeID, fraction: basisPoints / FRACTION_SCALE }))
    .sort((left, right) => left.typeID - right.typeID);
}

function chooseMoonOres({ moon, context, seed, ruleset, primaryTier }) {
  const oreCount = chooseWeighted(
    seed,
    `count|moon:${moon.moonID}|highest:${primaryTier}`,
    ORE_COUNT_OPTIONS,
    (count) => ruleset.oreCountWeights[count],
  );
  const selectedTypeIDs = [];
  const primaryTypeID = chooseWeighted(
    seed,
    `ore|moon:${moon.moonID}|slot:0|tier:${primaryTier}|faction:${context.factionKey}`,
    MOON_ORES_BY_TIER[primaryTier],
    (typeID) => oreWeight(ruleset, context.factionKey, typeID),
  );
  selectedTypeIDs.push(primaryTypeID);

  const componentCandidates = COMPONENT_TIERS_BY_PRIMARY_TIER[primaryTier].flatMap((tier) => (
    MOON_ORES_BY_TIER[tier].map((typeID) => ({ tier, typeID }))
  ));
  while (selectedTypeIDs.length < oreCount) {
    const slot = selectedTypeIDs.length;
    const candidate = chooseWeighted(
      seed,
      `ore|moon:${moon.moonID}|slot:${slot}|highest:${primaryTier}|faction:${context.factionKey}`,
      componentCandidates.filter(({ typeID }) => !selectedTypeIDs.includes(typeID)),
      ({ tier, typeID }) => (
        ruleset.componentTierWeightsByPrimaryTier[primaryTier][tier] *
        oreWeight(ruleset, context.factionKey, typeID)
      ),
    );
    selectedTypeIDs.push(candidate.typeID);
  }
  return selectedTypeIDs;
}

function generateMoonProfile({ moon, context, seed, ruleset, datasetVersion }) {
  const allowedTiers = ALLOWED_TIERS_BY_SPACE[context.spaceClass];
  if (!allowedTiers) {
    return null;
  }
  const primaryTier = chooseWeighted(
    seed,
    `tier|moon:${moon.moonID}|space:${context.spaceClass}|faction:${context.factionKey}`,
    allowedTiers,
    (tier) => ruleset.tierWeightsBySpace[context.spaceClass][tier],
  );
  const typeIDs = chooseMoonOres({ moon, context, seed, ruleset, primaryTier });
  const composition = allocateBasisPoints(seed, `moon:${moon.moonID}`, typeIDs);
  return {
    moonID: moon.moonID,
    solarSystemID: moon.solarSystemID,
    profileID: `generated:${ruleset.rulesetID}:moon:${moon.moonID}`,
    datasetVersion,
    sourceStatus: "valid",
    composition,
    primaryTier,
  };
}

function addCount(counts, key) {
  counts[key] = (counts[key] || 0) + 1;
}

function generateMoonCompositionDataset(options = {}) {
  const seed = String(options.seed || "");
  if (!seed) {
    throw new TypeError("moon composition generator seed is required");
  }
  const sourceBuild = positiveInteger(options.sourceBuild);
  if (!sourceBuild) {
    throw new TypeError("moon composition generator sourceBuild is required");
  }
  const ruleset = normalizeRuleset(options.ruleset || DEFAULT_RULESET);
  const {
    systemsByID,
    moons,
    sourceMoonCount,
    miningPointsByMoonID,
  } = normalizeUniverse(options.universe);
  const miningPointMetadata = options.miningPointMetadata ||
    options.universe.moonMiningPointMetadata || null;
  if (!miningPointMetadata || miningPointMetadata.sourceBuild !== sourceBuild ||
    typeof miningPointMetadata.datasetVersion !== "string" ||
    typeof miningPointMetadata.contentHash !== "string") {
    throw new TypeError("moon composition generator requires matching mining-point metadata");
  }
  const resolveSystemContext = typeof options.resolveSystemContext === "function"
    ? options.resolveSystemContext
    : defaultSystemContext;
  const universeSha256 = calculateUniverseHash(moons, systemsByID, resolveSystemContext);
  const seedSha256 = crypto.createHash("sha256").update(seed, "utf8").digest("hex");
  const rulesetSha256 = sha256Json(ruleset);
  const datasetVersion = [
    ruleset.rulesetID,
    `generator-${GENERATOR_VERSION}`,
    `source-${sourceBuild}`,
    `points-${miningPointMetadata.contentHash.slice(0, 12)}`,
    `universe-${universeSha256.slice(0, 12)}`,
    `seed-${seedSha256.slice(0, 12)}`,
  ].join("+");
  const profiles = [];
  const generatedBySpaceFactionTier = {};
  const skippedBySpace = {};

  for (const moon of moons) {
    const context = resolveSystemContext(systemsByID.get(moon.solarSystemID));
    if (!context || !Object.values(SPACE_CLASS).includes(context.spaceClass)) {
      throw new TypeError(`moon ${moon.moonID} resolved an invalid system context`);
    }
    const normalizedContext = {
      spaceClass: context.spaceClass,
      factionKey: normalizeFactionKey(context.factionKey),
    };
    if (normalizedContext.spaceClass === SPACE_CLASS.POCHVEN) {
      // Pochven retains legacy moons, but new player moon operations are not
      // available. Do not manufacture a composition table for an unusable
      // system class merely because its static security value is -1.0.
      addCount(skippedBySpace, normalizedContext.spaceClass);
      continue;
    }
    if (normalizedContext.spaceClass === SPACE_CLASS.SPECIAL && options.includeSpecialSpace !== true) {
      addCount(skippedBySpace, normalizedContext.spaceClass);
      continue;
    }
    if (normalizedContext.spaceClass === SPACE_CLASS.SPECIAL) {
      throw new TypeError(
        "special-space moon generation has no validated material policy; leave it disabled",
      );
    }
    const profile = generateMoonProfile({
      moon,
      context: normalizedContext,
      seed,
      ruleset,
      datasetVersion,
    });
    if (!profile) {
      addCount(skippedBySpace, normalizedContext.spaceClass);
      continue;
    }
    addCount(
      generatedBySpaceFactionTier,
      `${normalizedContext.spaceClass}|${normalizedContext.factionKey}|${profile.primaryTier}`,
    );
    delete profile.primaryTier;
    profiles.push(profile);
  }

  const generation = {
    generatorVersion: GENERATOR_VERSION,
    rulesetID: ruleset.rulesetID,
    rulesetSha256,
    seedSha256,
    universeSha256,
    summary: {
      sourceMoons: sourceMoonCount,
      miningPointMoons: moons.length,
      generatedProfiles: profiles.length,
      skippedMoons: sourceMoonCount - profiles.length,
      skippedWithoutMiningPoint: sourceMoonCount - moons.length,
      skippedBySpace: Object.fromEntries(Object.entries(skippedBySpace).sort()),
      generatedBySpaceFactionTier: Object.fromEntries(
        Object.entries(generatedBySpaceFactionTier).sort(([left], [right]) => left.localeCompare(right)),
      ),
    },
  };
  const dataset = {
    schemaVersion: 1,
    datasetVersion,
    sourceBuild,
    authorityClass: "project_generated",
    tranquilityExact: false,
    fallbackPolicy: "fail_closed",
    provenance: [
      {
        sourceID: `evejs-moon-mining-points-${miningPointMetadata.datasetVersion}`,
        sourceKind: "versioned_moon_mining_location_authority",
        sourceVersion: miningPointMetadata.datasetVersion,
        sha256: miningPointMetadata.contentHash,
      },
      {
        sourceID: `evejs-static-universe-${sourceBuild}`,
        sourceKind: "evejs_static_universe",
        sourceVersion: String(sourceBuild),
        sha256: universeSha256,
      },
      {
        sourceID: `evejs-moon-generator-${GENERATOR_VERSION}`,
        sourceKind: "deterministic_project_generator",
        sourceVersion: ruleset.rulesetID,
        sha256: rulesetSha256,
      },
      {
        sourceID: "evejs-moon-world-seed",
        sourceKind: "operator_configured_seed",
        sourceVersion: `sha256:${seedSha256.slice(0, 12)}`,
        sha256: seedSha256,
      },
    ],
    generation,
    miningPointAuthority: {
      datasetVersion: miningPointMetadata.datasetVersion,
      sourceBuild: miningPointMetadata.sourceBuild,
      contentHash: miningPointMetadata.contentHash,
      pointCount: miningPointsByMoonID.size,
    },
    profiles,
  };
  dataset.contentHash = calculateAuthorityContentHash(dataset);
  return deepFreeze(dataset);
}

function loadEveJsUniverse(worldData) {
  if (!worldData || typeof worldData.getSolarSystems !== "function" ||
    typeof worldData.getCelestialsForSystem !== "function" ||
    typeof worldData.getMoonMiningPointsForSystem !== "function" ||
    typeof worldData.getMoonMiningPointMetadata !== "function") {
    throw new TypeError("worldData must expose systems, celestials, and moon mining points");
  }
  const systems = worldData.getSolarSystems();
  const moons = [];
  for (const system of systems) {
    for (const celestial of worldData.getCelestialsForSystem(system.solarSystemID)) {
      if (Number(celestial.groupID) === 8) {
        moons.push(celestial);
      }
    }
  }
  const moonMiningPoints = [];
  for (const system of systems) {
    moonMiningPoints.push(...worldData.getMoonMiningPointsForSystem(system.solarSystemID));
  }
  return {
    systems,
    moons,
    moonMiningPoints,
    moonMiningPointMetadata: worldData.getMoonMiningPointMetadata(),
  };
}

function generateMoonCompositionDatasetFromWorldData(options = {}) {
  const worldData = options.worldData || require(path.join(__dirname, "../../space/worldData"));
  const universe = loadEveJsUniverse(worldData);
  return generateMoonCompositionDataset({
    ...options,
    sourceBuild: options.sourceBuild || universe.moonMiningPointMetadata?.sourceBuild,
    miningPointMetadata: options.miningPointMetadata || universe.moonMiningPointMetadata,
    universe,
  });
}

module.exports = {
  ALLOWED_TIERS_BY_SPACE,
  COMPONENT_TIERS_BY_PRIMARY_TIER,
  DEFAULT_RULESET,
  FRACTION_SCALE,
  GENERATOR_VERSION,
  MOON_ORES_BY_TIER,
  ORE_COUNT_OPTIONS,
  RULESET_SCHEMA_VERSION,
  SPACE_CLASS,
  defaultSystemContext,
  generateMoonCompositionDataset,
  generateMoonCompositionDatasetFromWorldData,
  loadEveJsUniverse,
  normalizeRuleset,
};
