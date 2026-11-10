"use strict";

const { toInt, normalizeText } = require("../domain/abyssalRuntimeValues");

function resolveRoomRewardProfile(ports, pocketState, roomIndex = null, options = {}) {
  const {
    getContentProfile,
    getAuthoredRoomEncounterProfile,
    getCapturedT0DarkRoom,
    shouldUseTier0AbyssalSpaceEmpiricalContent,
    resolveRoomEncounterProfile,
    clampRoomIndex,
    getImplementedRoomCount,
    buildAbyssalContentResolutionError,
    migrateLegacySerializedRewardProfile,
    validateRewardProfileQuantityPolicy,
    ABYSSAL_REWARD_QUANTITY_POLICY,
    cloneValue,
  } = ports;
  const contentProfile = getContentProfile(pocketState) || {};
  const authoredEncounterProfile = getAuthoredRoomEncounterProfile(pocketState, roomIndex);
  const authoredRewardProfileOverride =
    authoredEncounterProfile && authoredEncounterProfile.rewardProfileOverride ||
    null;
  const capturedRoom = getCapturedT0DarkRoom(pocketState, roomIndex);
  if (
    capturedRoom &&
    capturedRoom.rewardCache &&
    !shouldUseTier0AbyssalSpaceEmpiricalContent(contentProfile) &&
    !(authoredRewardProfileOverride && authoredRewardProfileOverride.replaceCapturedReward === true)
  ) {
    return buildCapturedRoomRewardProfile(ports, capturedRoom);
  }
  const baseRewardProfile =
    contentProfile.rewardProfile && typeof contentProfile.rewardProfile === "object"
      ? cloneRewardProfileForResolution(ports, contentProfile.rewardProfile)
      : null;
  const encounterProfile = options.encounterProfile || resolveRoomEncounterProfile(
    pocketState,
    roomIndex,
    {
      logResolution: false,
    },
  );
  const candidateRewardProfileOverride =
    encounterProfile && encounterProfile.rewardProfileOverride ||
    authoredEncounterProfile && authoredEncounterProfile.rewardProfileOverride ||
    null;
  const usesProceduralSdeRewards =
    baseRewardProfile &&
    baseRewardProfile.rewardMode === "procedural_sde_weighted_pool";
  const empiricalRewardSourceModelID = normalizeText(
    baseRewardProfile && baseRewardProfile.sourceModelID,
    "",
  );
  const usesEmpiricalTier1Through6Rewards = usesEmpiricalTierRewardSource(ports, contentProfile);
  const rewardProfileOverride = usesProceduralSdeRewards
    ? null
    : usesEmpiricalTier1Through6Rewards &&
      empiricalRewardSourceModelID &&
      normalizeText(
        candidateRewardProfileOverride &&
          candidateRewardProfileOverride.sourceModelID,
        "",
      ) !== empiricalRewardSourceModelID
      ? null
      : candidateRewardProfileOverride;
  const rawRewardProfile = rewardProfileOverride
    ? cloneRewardProfileForResolution(ports, rewardProfileOverride)
    : baseRewardProfile;
  if (!rawRewardProfile) {
    const resolvedRoomIndex = encounterProfile && encounterProfile.roomIndex ||
      clampRoomIndex(roomIndex, getImplementedRoomCount(pocketState));
    throw buildAbyssalContentResolutionError(
      "ABYSSAL_ROOM_REWARD_PROFILE_MISSING",
      pocketState,
      resolvedRoomIndex,
      "reward",
    );
  }
  const rewardProfile = rawRewardProfile.quantityPolicy
    ? rawRewardProfile
    : migrateLegacySerializedRewardProfile(rawRewardProfile);
  validateRewardProfileQuantityPolicy(rewardProfile);
  const resolvedRoomIndex =
    encounterProfile && encounterProfile.roomIndex ||
    clampRoomIndex(roomIndex, getImplementedRoomCount(pocketState));
  const baseLootEntries = Array.isArray(rewardProfile.baseLootEntries) && rewardProfile.baseLootEntries.length > 0
    ? rewardProfile.baseLootEntries
    : Array.isArray(rewardProfile.lootEntries)
      ? rewardProfile.lootEntries
      : [];
  const roomMultipliersByIndex =
    rewardProfile.roomMultipliersByIndex && typeof rewardProfile.roomMultipliersByIndex === "object"
      ? rewardProfile.roomMultipliersByIndex
      : null;
  const rewardMultiplier =
    roomMultipliersByIndex &&
      Number(roomMultipliersByIndex[String(resolvedRoomIndex)] ?? roomMultipliersByIndex[resolvedRoomIndex]) ||
    Number(encounterProfile && encounterProfile.rewardMultiplier);
  const normalizedRoomMultiplier = Number.isFinite(rewardMultiplier) && rewardMultiplier > 0
    ? rewardMultiplier
    : 1;
  const rewardQuantityBonus = toInt(encounterProfile && encounterProfile.rewardQuantityBonus, 0);
  if (
    rewardProfile.quantityPolicy === ABYSSAL_REWARD_QUANTITY_POLICY.RETAIL_FINAL &&
    (normalizedRoomMultiplier !== 1 || rewardQuantityBonus !== 0)
  ) {
    throw new TypeError(
      `retail_final Abyssal reward profile ${rewardProfile.rewardProfileID || "<unknown>"} ` +
      "cannot be passed through another quantity multiplier",
    );
  }
  return {
    ...rewardProfile,
    encounterProfileID: encounterProfile && encounterProfile.encounterProfileID || "",
    roomIndex: resolvedRoomIndex,
    rewardMultiplier: normalizedRoomMultiplier,
    roomMultiplier: normalizedRoomMultiplier,
    rewardQuantityBonus,
    baseLootEntries: cloneValue(baseLootEntries),
    lootEntries: cloneValue(baseLootEntries),
  };
}

function getTierRewardQuantityMultiplier(ports, source = null) {
  const {
    getContentProfile,
    ABYSSAL_CALM_TIER_REWARD_QUANTITY_MULTIPLIER,
    ABYSSAL_TIER0_REWARD_OUTPUT_MULTIPLIER,
    ABYSSAL_MAX_REWARD_TIER,
  } = ports;
  const contentProfile = getContentProfile(source) || source || {};
  const numericTier = Number(contentProfile && contentProfile.tier);
  const tier = Number.isFinite(numericTier) ? Math.trunc(numericTier) : null;
  if (tier === 0) {
    return ABYSSAL_CALM_TIER_REWARD_QUANTITY_MULTIPLIER * ABYSSAL_TIER0_REWARD_OUTPUT_MULTIPLIER;
  }
  if (tier >= 1 && tier <= ABYSSAL_MAX_REWARD_TIER) {
    return ABYSSAL_CALM_TIER_REWARD_QUANTITY_MULTIPLIER * tier;
  }
  return 1;
}

function getCacheRewardQuantityMultiplier(ports, source = null) {
  const {
    resolveAbyssalRequiredFilamentCount,
    getContentProfile,
    ABYSSAL_CALM_TIER_REWARD_QUANTITY_MULTIPLIER,
  } = ports;
  const hullMultiplier = resolveAbyssalRequiredFilamentCount(source);
  const contentProfile = getContentProfile(source) || source || {};
  if (toInt(contentProfile.tier, -1) === 0) {
    // Golden runtime authority treats the filament stack size as the main
    // cache reward multiplier in every tier. The captured T0 replay happened
    // to be cruiser mode (one filament); small-hull T0 runs still receive the
    // two/three-player cache family and 2x/3x total loot.
    return hullMultiplier;
  }
  const tierMultiplier = Number(getTierRewardQuantityMultiplier(ports, source));
  const baselineHullMultiplier = ABYSSAL_CALM_TIER_REWARD_QUANTITY_MULTIPLIER;
  const combinedMultiplier = tierMultiplier * hullMultiplier / baselineHullMultiplier;
  return Number.isFinite(combinedMultiplier) && combinedMultiplier > 0
    ? combinedMultiplier
    : hullMultiplier;
}

function applyRewardQuantityMultiplier(ports,
  lootEntries = [],
  source = null,
  quantityPolicy = null,
) {
  const {
    applyRewardQuantityPolicy,
  } = ports;
  return applyRewardQuantityPolicy(lootEntries, {
    tierMultiplier: getTierRewardQuantityMultiplier(ports, source),
    quantityPolicy,
  });
}

function isObservedRunRewardAllocationProfile(ports, rewardProfile = null) {
  const {
    ABYSSAL_RUN_REWARD_ALLOCATION_MODEL,
  } = ports;
  return Boolean(
    rewardProfile &&
    rewardProfile.rewardMode === "observed_empirical_complete_run_outcome" &&
    rewardProfile.observedRunLootAllocation &&
    rewardProfile.observedRunLootAllocation.model ===
      ABYSSAL_RUN_REWARD_ALLOCATION_MODEL
  );
}

function cloneRuntimeRewardProfileOverride(ports, rewardProfile = null) {
  const {
    cloneValue,
  } = ports;
  if (!rewardProfile || typeof rewardProfile !== "object") {
    return null;
  }
  // Empirical whole-run reward catalogues are immutable definition data. The
  // selected encounter and the durable runRewardAllocation are sufficient to
  // reconstruct/validate rewards, so copying thousands of source outcomes into
  // every room and encounter state only creates multi-megabyte retained state.
  return isObservedRunRewardAllocationProfile(ports, rewardProfile)
    ? null
    : cloneValue(rewardProfile);
}

function cloneRewardProfileForResolution(ports, rewardProfile = null) {
  const {
    cloneValue,
  } = ports;
  if (!rewardProfile || typeof rewardProfile !== "object") {
    return null;
  }
  return isObservedRunRewardAllocationProfile(ports, rewardProfile)
    ? rewardProfile
    : cloneValue(rewardProfile);
}

function getRewardTierMultiplierApplied(ports, rewardProfile = null, source = null) {
  const {
    validateRewardProfileQuantityPolicy,
    rewardQuantityPolicyAppliesTierScaling,
  } = ports;
  const quantityPolicy = validateRewardProfileQuantityPolicy(rewardProfile);
  return rewardQuantityPolicyAppliesTierScaling(quantityPolicy)
    ? getCacheRewardQuantityMultiplier(ports, source)
    : 1;
}

function applyRoomRewardQuantityAdjustments(ports, lootEntries, rewardProfile) {
  const roomMultiplier = Number(rewardProfile && rewardProfile.roomMultiplier);
  const normalizedRoomMultiplier = Number.isFinite(roomMultiplier) && roomMultiplier > 0
    ? roomMultiplier
    : 1;
  const rewardQuantityBonus = toInt(rewardProfile && rewardProfile.rewardQuantityBonus, 0);
  return (Array.isArray(lootEntries) ? lootEntries : []).map((entry, index) => {
    const quantity = Number(entry && entry.quantity);
    if (!Number.isSafeInteger(quantity) || quantity < 0) {
      throw new TypeError(`Abyssal reward entry ${index} has an invalid base quantity`);
    }
    const adjustedQuantity = Math.round(quantity * normalizedRoomMultiplier) + rewardQuantityBonus;
    if (!Number.isSafeInteger(adjustedQuantity) || adjustedQuantity < 0) {
      throw new TypeError(`Abyssal reward entry ${index} has an invalid room-adjusted quantity`);
    }
    return { ...entry, quantity: adjustedQuantity };
  });
}

function buildCapturedRoomRewardProfile(ports, capturedRoom) {
  const {
    T0_DARK_RETAIL_CAPTURED_PROFILE_ID,
    ABYSSAL_REWARD_QUANTITY_POLICY,
    cloneValue,
  } = ports;
    const lootEntries = capturedRoom.rewardCache.loot.map((entry) => ({
      itemName: normalizeText(entry.itemName, `Captured reward type ${entry.typeID}`),
      itemTypeID: toInt(entry.itemTypeID, toInt(entry.typeID, 0)),
      quantity: Math.max(0, toInt(entry.quantity, 0)),
      minQuantity: Math.max(0, toInt(entry.quantity, 0)),
      maxQuantity: Math.max(0, toInt(entry.quantity, 0)),
      probability: 1,
      weight: 1,
      allowedRoomIndexes: [capturedRoom.roomIndex],
      allowedTiers: [0],
      allowedWeatherTypes: ["dark"],
      unresolvedReference: false,
      resolutionReason: "RETAIL_CAPTURED",
    }));
    return {
      rewardProfileID:
        `${T0_DARK_RETAIL_CAPTURED_PROFILE_ID}:room-${capturedRoom.roomIndex}:reward`,
      lootTableID:
        `${T0_DARK_RETAIL_CAPTURED_PROFILE_ID}:room-${capturedRoom.roomIndex}:wreck-contents`,
      displayName: `Captured Tranquil Dark Room ${capturedRoom.roomIndex} Cache`,
      tier: 0,
      weatherTheme: "dark",
      rewardKind: "cache_loot",
      rewardMode: "retail_captured_exact",
      rewardTableKind: "retail_captured_exact",
      capturedExact: true,
      capturedRetailProfile: true,
      quantityPolicy: ABYSSAL_REWARD_QUANTITY_POLICY.RETAIL_FINAL,
      suppressRewardsOnTimeout: true,
      authoredProbabilities: false,
      roomIndex: capturedRoom.roomIndex,
      roomMultiplier: 1,
      rewardMultiplier: 1,
      rewardQuantityBonus: 0,
      baseLootEntries: cloneValue(lootEntries),
      lootEntries,
      weightedLootPools: [],
      rareLootEntries: [],
      extractionNodeLootEntries: [],
      unresolvedLootReferences: [],
      unresolvedLootReferenceCount: 0,
      placeholderNotes: [
        "Exact contents observed when the captured retail room wreck was opened.",
      ],
    };
  }

function usesEmpiricalTierRewardSource(ports, contentProfile) {
  return (
      typeof ports.shouldUseTier1AbyssalSpaceEmpiricalContent ===
        "function" &&
      ports.shouldUseTier1AbyssalSpaceEmpiricalContent(
        contentProfile,
      )
    ) || (
      typeof ports.shouldUseTier2AbyssalSpaceEmpiricalContent ===
        "function" &&
      ports.shouldUseTier2AbyssalSpaceEmpiricalContent(
        contentProfile,
      )
    ) || (
      typeof ports.shouldUseTier3AbyssalSpaceEmpiricalContent ===
        "function" &&
      ports.shouldUseTier3AbyssalSpaceEmpiricalContent(
        contentProfile,
      )
    ) || (
      typeof ports.shouldUseTier4AbyssalSpaceEmpiricalContent ===
        "function" &&
      ports.shouldUseTier4AbyssalSpaceEmpiricalContent(
        contentProfile,
      )
    ) || (
      typeof ports.shouldUseTier5AbyssalSpaceEmpiricalContent ===
        "function" &&
      ports.shouldUseTier5AbyssalSpaceEmpiricalContent(
        contentProfile,
      )
    ) || (
      typeof ports.shouldUseTier6AbyssalSpaceEmpiricalContent ===
        "function" &&
      ports.shouldUseTier6AbyssalSpaceEmpiricalContent(
        contentProfile,
      )
    );
}

function createAbyssalRewardProfiles(ports) {
  return {
    resolveRoomRewardProfile: resolveRoomRewardProfile.bind(null, ports),
    getTierRewardQuantityMultiplier: getTierRewardQuantityMultiplier.bind(null, ports),
    getCacheRewardQuantityMultiplier: getCacheRewardQuantityMultiplier.bind(null, ports),
    applyRewardQuantityMultiplier: applyRewardQuantityMultiplier.bind(null, ports),
    isObservedRunRewardAllocationProfile: isObservedRunRewardAllocationProfile.bind(null, ports),
    cloneRuntimeRewardProfileOverride: cloneRuntimeRewardProfileOverride.bind(null, ports),
    cloneRewardProfileForResolution: cloneRewardProfileForResolution.bind(null, ports),
    getRewardTierMultiplierApplied: getRewardTierMultiplierApplied.bind(null, ports),
    applyRoomRewardQuantityAdjustments: applyRoomRewardQuantityAdjustments.bind(null, ports),
  };
}

module.exports = { createAbyssalRewardProfiles };
