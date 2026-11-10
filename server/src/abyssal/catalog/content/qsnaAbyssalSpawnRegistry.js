"use strict";

const crypto = require("node:crypto");
const path = require("node:path");

const QSNA_ABYSSAL_SPAWN_TABLES = require("./qsnaAbyssalSpawnTables.generated.json");
const {
  ABYSSAL_CONTENT_AUTHORITY,
} = require("../abyssalContentAuthority");

const QSNA_ABYSSAL_NPC_SOURCE_AUTHORITY = "QSNA_ABYSSAL_SPACE_OBSERVED";

function cloneValue(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function normalizeText(value, fallback = "") {
  const normalized = String(value == null ? "" : value).trim();
  return normalized || fallback;
}

function normalizeRandom(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  if (numeric >= 1) return 0.999999999;
  return numeric;
}

function createDeterministicRandom(seed) {
  const normalizedSeed = normalizeText(seed, "qsna-abyssal-default-seed");
  let counter = 0;
  return () => {
    const digest = crypto.createHash("sha256")
      .update(`${normalizedSeed}:${counter}`, "utf8")
      .digest();
    counter += 1;
    return digest.readUInt32BE(0) / 0x1_0000_0000;
  };
}

function randomIntegerInclusive(minimum, maximum, nextRandom) {
  const min = toInt(minimum, 0);
  const max = Math.max(min, toInt(maximum, min));
  if (max <= min) return min;
  return min + Math.floor(normalizeRandom(nextRandom()) * ((max - min) + 1));
}

function rollAppearance(chancePct, nextRandom) {
  const chance = Number(chancePct);
  if (!(chance > 0)) return false;
  if (chance >= 100) return true;
  return normalizeRandom(nextRandom()) < (chance / 100);
}

function allowedQuantities(npc) {
  const maximum = Math.max(0, toInt(npc && npc.observedMaxQuantity, 0));
  if (maximum <= 0) return [0];
  const positiveMinimum = Math.max(
    1,
    Math.min(maximum, toInt(npc && npc.observedMinQuantity, 0)),
  );
  return [
    0,
    ...Array.from(
      { length: (maximum - positiveMinimum) + 1 },
      (_, index) => positiveMinimum + index,
    ),
  ];
}

function isBetterState(candidate, existing) {
  if (!existing) return true;
  if (candidate.cost !== existing.cost) return candidate.cost < existing.cost;
  const candidateSignature = candidate.quantities.join(",");
  const existingSignature = existing.quantities.join(",");
  return candidateSignature < existingSignature;
}

// The source does not expose full quantity distributions. This bounded dynamic
// program makes the smallest absolute adjustment to independently sampled
// quantities while guaranteeing the observed family total bounds. It has a
// finite state space of NPC rows * family maximum and never retries.
function reconcileQuantities(family, sampledQuantities) {
  const npcs = Array.isArray(family && family.npcs) ? family.npcs : [];
  const minimumTotal = Math.max(
    0,
    toInt(family && family.enemiesPerSpawn && family.enemiesPerSpawn.min, 0),
  );
  const maximumTotal = Math.max(
    minimumTotal,
    toInt(family && family.enemiesPerSpawn && family.enemiesPerSpawn.max, minimumTotal),
  );
  let states = new Map([[0, { cost: 0, quantities: [] }]]);
  for (let index = 0; index < npcs.length; index += 1) {
    const desired = Math.max(0, toInt(sampledQuantities[index], 0));
    const nextStates = new Map();
    for (const [currentTotal, state] of states.entries()) {
      for (const quantity of allowedQuantities(npcs[index])) {
        const total = currentTotal + quantity;
        if (total > maximumTotal) continue;
        const candidate = {
          cost: state.cost + Math.abs(quantity - desired),
          quantities: [...state.quantities, quantity],
        };
        if (isBetterState(candidate, nextStates.get(total))) {
          nextStates.set(total, candidate);
        }
      }
    }
    states = nextStates;
  }

  const sampledTotal = sampledQuantities.reduce(
    (total, quantity) => total + Math.max(0, toInt(quantity, 0)),
    0,
  );
  const targetTotal = Math.max(minimumTotal, Math.min(maximumTotal, sampledTotal));
  const candidates = [...states.entries()]
    .filter(([total]) => total >= minimumTotal && total <= maximumTotal)
    .map(([total, state]) => ({ total, ...state }))
    .sort((left, right) =>
      left.cost - right.cost ||
      Math.abs(left.total - targetTotal) - Math.abs(right.total - targetTotal) ||
      left.total - right.total ||
      left.quantities.join(",").localeCompare(right.quantities.join(","))
    );
  if (candidates.length <= 0) {
    const error = new Error(
      `QSNA_ABYSSAL_FAMILY_BOUNDS_UNSATISFIABLE family=${normalizeText(
        family && family.id,
        "unknown",
      )} min=${minimumTotal} max=${maximumTotal}`,
    );
    error.code = "QSNA_ABYSSAL_FAMILY_BOUNDS_UNSATISFIABLE";
    throw error;
  }
  return {
    quantities: candidates[0].quantities,
    sampledTotal,
    reconciledTotal: candidates[0].total,
    adjustmentCost: candidates[0].cost,
  };
}

function sampleFamilyComposition(family, nextRandom) {
  if (typeof nextRandom !== "function") {
    throw new TypeError("QSNA Abyssal composition generation requires an RNG");
  }
  const rng = nextRandom;
  const sampledQuantities = family.npcs.map((npc) => {
    if (!rollAppearance(npc.appearanceChancePct, rng)) return 0;
    const positiveMinimum = Math.max(1, toInt(npc.observedMinQuantity, 0));
    return randomIntegerInclusive(
      positiveMinimum,
      toInt(npc.observedMaxQuantity, positiveMinimum),
      rng,
    );
  });
  return reconcileQuantities(family, sampledQuantities);
}

function buildSafeProfilesByTypeID(safeNpcCatalogByProfileID) {
  const byTypeID = new Map();
  for (const entry of Object.values(safeNpcCatalogByProfileID || {})
    .filter((candidate) => candidate && candidate.safe === true)
    .sort((left, right) =>
      String(left.profileID || "").localeCompare(String(right.profileID || ""))
    )) {
    const typeID = toInt(entry.typeID, 0);
    if (typeID <= 0) continue;
    if (!byTypeID.has(typeID)) byTypeID.set(typeID, []);
    byTypeID.get(typeID).push(entry);
  }
  return byTypeID;
}

function resolveSafeProfileForQsnaTier(safeProfilesByTypeID, typeID, tier) {
  return (safeProfilesByTypeID.get(toInt(typeID, 0)) || []).find((entry) => {
    const eligibility = entry && entry.qsnaTierEligibility;
    return (Array.isArray(eligibility) ? eligibility : [])
      .map((value) => toInt(value, -1))
      .includes(toInt(tier, -2));
  }) || null;
}

function buildNpcEntry({ npc, quantity, safeProfile, familyID, index }) {
  return {
    npcEntryID: `qsna:${familyID}:npc-${index + 1}:type-${npc.typeID}`,
    runtimeKind: "nativeCombat",
    npcProfileKey: String(safeProfile.profileID || ""),
    profileQuery: String(safeProfile.profileID || ""),
    profileName: String(
      safeProfile.profileName || safeProfile.displayName || safeProfile.profileID || "",
    ),
    typeID: toInt(npc.typeID, 0),
    displayName: String(
      safeProfile.displayName || npc.sdeName || "",
    ),
    sourceObservedName: String(npc.name || ""),
    groupID: toInt(safeProfile.groupID, 0),
    factionID: toInt(safeProfile.factionID, 0),
    requestedProfileQuery: String(safeProfile.profileID || ""),
    fallbackUsed: false,
    fallbackReason: "",
    weaponStyle: String(safeProfile.weaponStyle || ""),
    role: "qsna_objective_hostile",
    minimumCount: quantity,
    maximumCount: quantity,
    count: quantity,
    required: true,
    objectiveRelevant: true,
    objectiveRole: "kill_all_hostiles",
    spawnRadiusMeters: 0,
    spawnOffsetMeters: 0,
    spawnReference: "encounter_anchor",
    spawnDistanceMode: "formation",
    appearanceChancePct: Number(npc.appearanceChancePct),
    observedMinQuantity: toInt(npc.observedMinQuantity, 0),
    observedMaxQuantity: toInt(npc.observedMaxQuantity, 0),
  };
}

function buildProfile(scope, { tier, weather, roomIndex, family, nextRandom }) {
  const { safeProfilesByTypeID, encounterThemeByTier, catalog } = scope;
  const sampled = sampleFamilyComposition(family, nextRandom);
  const npcEntries = family.npcs.flatMap((npc, index) => {
    const quantity = toInt(sampled.quantities[index], 0);
    if (quantity <= 0) return [];
    return [buildNpcEntry({
      npc,
      quantity,
      safeProfile: resolveSafeProfileForQsnaTier(
        safeProfilesByTypeID,
        npc.typeID,
        tier,
      ),
      familyID: family.id,
      index,
    })];
  });
  // QSNA supplies empirical marginals, not intact observed room rosters. The
  // selection and reconciliation below construct a new joint composition,
  // so its aggregate authority is project-authored while the input facets
  // retain their observed-empirical authority.
  const encounterAuthority = {
    schemaVersion: 1,
    tier,
    roomIndex,
    weatherType: weather,
    eligibleRoomIndexes: [roomIndex],
    eligibleWeatherTypes: [weather],
    contentAuthority: ABYSSAL_CONTENT_AUTHORITY.PROJECT_AUTHORED,
    evidenceAuthority: ABYSSAL_CONTENT_AUTHORITY.OBSERVED_EMPIRICAL,
    npcIdentityAuthority: ABYSSAL_CONTENT_AUTHORITY.OBSERVED_EMPIRICAL,
    appearanceAuthority: ABYSSAL_CONTENT_AUTHORITY.OBSERVED_EMPIRICAL,
    quantityBoundsAuthority: ABYSSAL_CONTENT_AUTHORITY.OBSERVED_EMPIRICAL,
    familyEnemyCountBoundsAuthority:
      ABYSSAL_CONTENT_AUTHORITY.OBSERVED_EMPIRICAL,
    familySelectionAuthority: ABYSSAL_CONTENT_AUTHORITY.PROJECT_AUTHORED,
    quantitySelectionAuthority: ABYSSAL_CONTENT_AUTHORITY.PROJECT_AUTHORED,
    reconciliationAuthority: ABYSSAL_CONTENT_AUTHORITY.PROJECT_AUTHORED,
    wholeObservedCompositions: false,
    syntheticComposition: true,
    observedSpawnProfile: true,
    qsnaSpawnProfile: true,
    enabled: true,
    fallbackUsed: false,
  };
  return {
    encounterProfileID: `qsna:t${tier}:${weather}:r${roomIndex}:${family.id}`,
    encounterName: `QSNA Tier ${tier} ${weather} Room ${roomIndex} ${family.id}`,
    tier,
    eligibleRoomIndexes: [roomIndex],
    eligibleWeatherTypes: [weather],
    factionTheme: "observed_abyssal_mixed",
    encounterTheme: encounterThemeByTier[tier],
    objectiveType: "kill_objective_hostiles",
    weight: 1,
    npcEntries,
    spawnRadiusMeters: 12_000,
    spawnJitterMeters: 2_000,
    maximumTotalCount: toInt(family.enemiesPerSpawn.max, sampled.reconciledTotal),
    combatBudget: {
      source: "qsna_observed_family_bounds",
      minimumNpcCount: toInt(family.enemiesPerSpawn.min, 0),
      maximumNpcCount: toInt(family.enemiesPerSpawn.max, 0),
      observedAverageNpcCount: Number(family.enemiesPerSpawn.avg),
      sampledNpcCount: sampled.sampledTotal,
      reconciledNpcCount: sampled.reconciledTotal,
      reconciliationAdjustmentCost: sampled.adjustmentCost,
    },
    rewardMultiplier: 1,
    rewardQuantityBonus: 0,
    rewardProfileOverride: null,
    cacheProfileOverride: null,
    observedObjectEntries: [],
    sourceModelID: String(catalog.catalogueID || ""),
    sourceVariantID: `qsna:${tier}:${weather}:${family.id}`,
    sourceSpawnID: family.id,
    sourceSpawnFamily: family.id,
    sourceObservationCount: toInt(family.roomsAnalyzed, 0),
    sourceRoomsAnalyzed: toInt(family.roomsAnalyzed, 0),
    sourceEvidenceAuthority: QSNA_ABYSSAL_NPC_SOURCE_AUTHORITY,
    contentAuthority: encounterAuthority.contentAuthority,
    evidenceAuthority: encounterAuthority.evidenceAuthority,
    observedSpawnProfile: true,
    qsnaSpawnProfile: true,
    selectionModel: "uniform-valid-qsna-family-project-authored",
    familySelectionAuthority: encounterAuthority.familySelectionAuthority,
    npcIdentityAuthority: encounterAuthority.npcIdentityAuthority,
    appearanceAuthority: encounterAuthority.appearanceAuthority,
    quantityBoundsAuthority: encounterAuthority.quantityBoundsAuthority,
    quantitySelectionAuthority: encounterAuthority.quantitySelectionAuthority,
    familyEnemyCountBoundsAuthority:
      encounterAuthority.familyEnemyCountBoundsAuthority,
    reconciliationAuthority: encounterAuthority.reconciliationAuthority,
    wholeObservedCompositions:
      encounterAuthority.wholeObservedCompositions,
    syntheticComposition: encounterAuthority.syntheticComposition,
    encounterAuthority,
    fallbackUsed: false,
    enabled: true,
  };
}

function listProfilesForContext(scope, { tier, weatherType, roomIndex = 1 } = {}) {
  const { readyFamiliesByCombination } = scope;
  const normalizedTier = toInt(tier, -1);
  const weather = normalizeText(weatherType, "").toLowerCase();
  const room = Math.max(1, toInt(roomIndex, 1));
  return (readyFamiliesByCombination.get(`${normalizedTier}:${weather}`) || [])
    .map((family) => buildProfile(scope, {
      tier: normalizedTier,
      weather,
      roomIndex: room,
      family,
      nextRandom: () => 0,
    }))
    .map(cloneValue);
}

function listProfilesForTier(scope, tier) {
  const { catalog } = scope;
    const numericTier = toInt(tier, -1);
    return Object.values(catalog.combinations || {})
      .filter((combination) => toInt(combination && combination.tier, -2) === numericTier)
      .flatMap((combination) => [1, 2, 3].flatMap((roomIndex) =>
        listProfilesForContext(scope, {
          tier: numericTier,
          weatherType: combination.weather,
          roomIndex,
        })
      ));
}

function selectProfileForContext(scope, {
      tier,
      weatherType,
      roomIndex = 1,
      nextRandom = null,
      selectionSeed = "",
    } = {}) {
  const { readyFamiliesByCombination, unavailableFamilies, catalog } = scope;
    const normalizedTier = toInt(tier, -1);
    const weather = normalizeText(weatherType, "").toLowerCase();
    const room = Math.max(1, toInt(roomIndex, 1));
    const key = `${normalizedTier}:${weather}`;
    const families = readyFamiliesByCombination.get(key) || [];
    if (families.length <= 0) {
      const unavailable = unavailableFamilies.filter((entry) =>
        entry.tier === normalizedTier && entry.weather === weather
      );
      return {
        success: false,
        errorMsg: "QSNA_ABYSSAL_ENCOUNTER_CONTEXT_UNAVAILABLE",
        contextKey: `${key}:${room}`,
        runtimeReadyVariantCount: 0,
        unavailableVariantCount: unavailable.length,
        unavailableReasons: [...new Set(unavailable.flatMap((entry) => entry.reasons))],
      };
    }
    const rng = typeof nextRandom === "function"
      ? nextRandom
      : createDeterministicRandom(
        `${catalog.catalogueID}:${key}:${room}:${normalizeText(selectionSeed, "0")}`,
      );
    const familyRoll = normalizeRandom(rng());
    const familyIndex = Math.min(
      families.length - 1,
      Math.floor(familyRoll * families.length),
    );
    const family = families[familyIndex];
    const profile = buildProfile(scope, {
      tier: normalizedTier,
      weather,
      roomIndex: room,
      family,
      nextRandom: rng,
    });
    return {
      success: true,
      contextKey: `${key}:${room}`,
      selectionSeed: normalizeText(selectionSeed, ""),
      selectionRoll: familyRoll,
      selectedFamilyIndex: familyIndex,
      totalWeight: families.length,
      runtimeReadyVariantCount: families.length,
      familySelectionPolicy: catalog.policies.familySelection,
      profile: cloneValue({
        ...profile,
        observedSelection: {
          contextKey: `${key}:${room}`,
          selectionSeed: normalizeText(selectionSeed, ""),
          selectionRoll: familyRoll,
          selectedFamilyIndex: familyIndex,
          runtimeReadyVariantCount: families.length,
          selectionPolicy: catalog.policies.familySelection,
          selectionAuthority: ABYSSAL_CONTENT_AUTHORITY.PROJECT_AUTHORED,
        },
      }),
    };
}

function getAudit(scope) {
  const { readyFamiliesByCombination, catalog, safeProfilesByTypeID, unavailableFamilies } = scope;
    const runtimeReadyFamilyCount = [...readyFamiliesByCombination.values()]
      .reduce((total, families) => total + families.length, 0);
    return {
      catalogueID: String(catalog.catalogueID || ""),
      source: cloneValue(catalog.source || {}),
      authority: cloneValue(catalog.authority || {}),
      policies: cloneValue(catalog.policies || {}),
      summary: cloneValue(catalog.summary || {}),
      safeProfileTypeCount: safeProfilesByTypeID.size,
      runtimeReadyVariantCount: runtimeReadyFamilyCount,
      unavailableVariantCount: unavailableFamilies.length,
      unavailableVariants: cloneValue(unavailableFamilies),
    };
}

function createQsnaAbyssalSpawnRegistry({
  safeNpcCatalogByProfileID,
  encounterThemeByTier,
  catalog = QSNA_ABYSSAL_SPAWN_TABLES,
} = {}) {
  const safeProfilesByTypeID = buildSafeProfilesByTypeID(
    safeNpcCatalogByProfileID,
  );
  const unavailableFamilies = [];
  const readyFamiliesByCombination = new Map();
  const tierMaximumObservedNpcCount = {};

  for (const combination of Object.values(catalog.combinations || {})) {
    const tier = toInt(combination && combination.tier, -1);
    const weather = normalizeText(combination && combination.weather, "").toLowerCase();
    const key = `${tier}:${weather}`;
    const ready = [];
    for (const family of Array.isArray(combination && combination.spawnFamilies)
      ? combination.spawnFamilies
      : []) {
      const missingTypeIDs = family.npcs
        .map((npc) => toInt(npc && npc.typeID, 0))
        .filter((typeID) => !resolveSafeProfileForQsnaTier(
          safeProfilesByTypeID,
          typeID,
          tier,
        ));
      if (missingTypeIDs.length > 0) {
        unavailableFamilies.push({
          tier,
          weather,
          familyID: normalizeText(family && family.id, ""),
          reasons: missingTypeIDs.map((typeID) =>
            `NPC_PROFILE_UNAVAILABLE:typeID=${typeID}`
          ),
        });
        continue;
      }
      ready.push(family);
      tierMaximumObservedNpcCount[String(tier)] = Math.max(
        toInt(tierMaximumObservedNpcCount[String(tier)], 0),
        toInt(family.enemiesPerSpawn && family.enemiesPerSpawn.max, 0),
      );
    }
    readyFamiliesByCombination.set(key, ready);
  }

  const scope = Object.freeze({
    catalog,
    encounterThemeByTier,
    safeProfilesByTypeID,
    unavailableFamilies,
    readyFamiliesByCombination,
  });
  return Object.freeze({
    catalogueID: String(catalog.catalogueID || ""),
    source: cloneValue(catalog.source || {}),
    tierMaximumObservedNpcCount: cloneValue(tierMaximumObservedNpcCount),
    listProfilesForTier: listProfilesForTier.bind(null, scope),
    listProfilesForContext: listProfilesForContext.bind(null, scope),
    selectProfileForContext: selectProfileForContext.bind(null, scope),
    getAudit: getAudit.bind(null, scope),
  });
}

module.exports = {
  QSNA_ABYSSAL_NPC_SOURCE_AUTHORITY,
  QSNA_ABYSSAL_SPAWN_TABLES,
  allowedQuantities,
  createDeterministicRandom,
  createQsnaAbyssalSpawnRegistry,
  normalizeRandom,
  randomIntegerInclusive,
  reconcileQuantities,
  rollAppearance,
  sampleFamilyComposition,
};
