"use strict";
const { toInt, normalizeText, normalizeLowerText, listUniquePositiveInts, listUniqueNonNegativeInts } = require("../domain/abyssalRuntimeValues");

function resolveEmpiricalRewardLootEntries(ports, rewardProfile, deps, context) {
  const {
    getAbyssalEmpiricalTierLootTable,
    nextAbyssalLootRandom,
    rollRewardEntryQuantity,
    cloneValue,
  } = ports;
  let empiricalEntries = Array.isArray(rewardProfile && rewardProfile.empiricalLootEntries)
    ? rewardProfile.empiricalLootEntries
    : [];
  if (rewardProfile && rewardProfile.rewardMode === "empirical_tier_pool") {
    const table = getAbyssalEmpiricalTierLootTable(rewardProfile.tier);
    if (!table || table.lootTableID !== rewardProfile.lootTableID) {
      throw new TypeError(
        `Abyssal empirical reward profile references an invalid loot table: ${rewardProfile.lootTableID}`,
      );
    }
    empiricalEntries = table.entries;
  }
  const allocation = rewardProfile && rewardProfile.empiricalRunAllocation || {};
  const roomCount = Math.max(1, toInt(allocation.roomCount, 1));
  const roomIndex = Math.max(1, Math.min(roomCount, toInt(allocation.roomIndex, context.roomIndex || 1)));
  const selected = [];
  for (const entry of empiricalEntries) {
    const assignedRoom = 1 + Math.floor(nextAbyssalLootRandom(deps) * roomCount);
    const dropChanceBps = Math.max(0, Math.min(10_000, toInt(entry && entry.dropChanceBps, 0)));
    const dropped = Math.floor(nextAbyssalLootRandom(deps) * 10_000) < dropChanceBps;
    const quantity = dropped ? rollRewardEntryQuantity(entry, deps) : 0;
    // The Survey Database is the run-spanning core payout. Split its sampled
    // run quantity deterministically across rooms; all other item occurrences
    // belong to exactly one stable room. This preserves the empirical per-run
    // total without tripling it and avoids empty higher-tier cache plans.
    const isRunSpanningCore = normalizeLowerText(entry && entry.itemName, "") ===
      "triglavian survey database";
    const allocatedQuantity = isRunSpanningCore
      ? Math.floor(quantity / roomCount) + (roomIndex <= quantity % roomCount ? 1 : 0)
      : assignedRoom === roomIndex
        ? quantity
        : 0;
    if (dropped && allocatedQuantity > 0) {
      selected.push({
        ...cloneValue(entry),
        quantity: allocatedQuantity,
        minQuantity: allocatedQuantity,
        maxQuantity: allocatedQuantity,
        probability: 1,
      });
    }
  }
  return selected;
}

function resolveObservedRunRewardLootEntries(ports,
  rewardProfile,
  deps,
  context,
  pocketState = null,
) {
  const {
    isObservedRunRewardAllocationProfile,
    validateObservedRunRewardAllocation,
    cloneValue,
    buildObservedRunRewardAllocation,
    getObservedRunRewardArtifactAllocation,
    selectObservedRunRewardOutcome,
  } = ports;
  if (
    !rewardProfile ||
    rewardProfile.rewardMode !== "observed_empirical_complete_run_outcome"
  ) {
    return null;
  }
  if (isObservedRunRewardAllocationProfile(rewardProfile)) {
    const runAllocation = pocketState && pocketState.runRewardAllocation
      ? validateObservedRunRewardAllocation(
          cloneValue(pocketState.runRewardAllocation),
          pocketState,
          rewardProfile,
        )
      : buildObservedRunRewardAllocation(pocketState, rewardProfile, deps);
    const artifactAllocation = getObservedRunRewardArtifactAllocation(
      runAllocation,
      toInt(context && context.roomIndex, 0),
    );
    if (!artifactAllocation) {
      throw new TypeError(
        `Observed run reward allocation has no main cache for room ${toInt(
          context && context.roomIndex,
          0,
        )}`,
      );
    }
    return cloneValue(artifactAllocation.entries);
  }
  const allocation = rewardProfile.observedRunLootAllocation || {};
  const allocationRoomIndex = Math.max(1, toInt(allocation.roomIndex, 3));
  if (toInt(context && context.roomIndex, 0) !== allocationRoomIndex) {
    return [];
  }
  const selectedOutcome = selectObservedRunRewardOutcome(rewardProfile, deps);
  return selectedOutcome.entries.map((entry) => ({
    ...cloneValue(entry),
    sourceLootOutcomeID: normalizeText(selectedOutcome.lootOutcomeID, ""),
    sourceLootOutcomeObservationCount: Math.max(
      1,
      toInt(selectedOutcome.observationCount, 1),
    ),
    sourceLootOutcomeConfidenceCounts: cloneValue(
      selectedOutcome.confidenceCounts || {},
    ),
    quantity: Math.max(1, toInt(entry.quantity, 1)),
    minQuantity: Math.max(1, toInt(entry.quantity, 1)),
    maxQuantity: Math.max(1, toInt(entry.quantity, 1)),
    probability: 1,
  }));
}

function buildResolvedRewardCacheLootEntries(ports,
  rewardProfile = null,
  pocketState = null,
  deps = ports.getDependencies(),
) {
  const {
    buildRewardLootRollContext,
    listGuaranteedRewardLootEntries,
    isRewardLootEntryEligibleForContext,
    nextAbyssalLootRandom,
    selectWeightedRewardLootEntry,
    rollRewardEntryQuantity,
    applyRoomRewardQuantityAdjustments,
    mergeAbyssalRewardEntries,
    applyRewardQuantityPolicy,
    getCacheRewardQuantityMultiplier,
    validateRewardProfileQuantityPolicy,
    buildPlaceholderRoomState,
    logTier0RewardResolution,
    logTier2RewardResolution,
  } = ports;
  if (!rewardProfile) {
    return [];
  }
  const context = buildRewardLootRollContext(rewardProfile, pocketState);
  const observedRunEntries = resolveObservedRunRewardLootEntries(ports,
    rewardProfile,
    deps,
    context,
    pocketState,
  );
  const resolvedEntries = Array.isArray(observedRunEntries)
    ? observedRunEntries
    : resolveEmpiricalRewardLootEntries(ports, rewardProfile, deps, context);
  for (const rewardEntry of listGuaranteedRewardLootEntries(rewardProfile)) {
    if (!isRewardLootEntryEligibleForContext(rewardEntry, context)) {
      continue;
    }
    const quantity = Math.max(0, toInt(rewardEntry && rewardEntry.quantity, 0));
    if (quantity <= 0) {
      continue;
    }
    resolvedEntries.push({
      ...rewardEntry,
      quantity,
      minQuantity: quantity,
      maxQuantity: quantity,
      probability: 1,
    });
  }
  const weightedLootPools = Array.isArray(rewardProfile.weightedLootPools)
    ? rewardProfile.weightedLootPools
    : [];
  for (const weightedLootPool of weightedLootPools) {
    if (!isRewardLootEntryEligibleForContext(weightedLootPool, context)) {
      continue;
    }
    const chance = Number(weightedLootPool && weightedLootPool.chance);
    const normalizedChance = Number.isFinite(chance)
      ? Math.min(1, Math.max(0, chance))
      : 1;
    if (normalizedChance <= 0 || nextAbyssalLootRandom(deps) >= normalizedChance) {
      continue;
    }
    const rolls = Math.max(1, toInt(weightedLootPool && weightedLootPool.rolls, 1));
    for (let rollIndex = 0; rollIndex < rolls; rollIndex += 1) {
      const selectedEntry = selectWeightedRewardLootEntry(weightedLootPool, deps, context);
      const quantity = rollRewardEntryQuantity(selectedEntry, deps);
      if (!selectedEntry || quantity <= 0) {
        continue;
      }
      resolvedEntries.push({
        ...selectedEntry,
        quantity,
        minQuantity: quantity,
        maxQuantity: quantity,
        probability: 1,
      });
    }
  }
  const roomAdjustedEntries = applyRoomRewardQuantityAdjustments(
    mergeAbyssalRewardEntries(resolvedEntries),
    rewardProfile,
  );
  const scaledEntries = mergeAbyssalRewardEntries(applyRewardQuantityPolicy(
    roomAdjustedEntries,
    {
      tierMultiplier: getCacheRewardQuantityMultiplier(pocketState),
      quantityPolicy: validateRewardProfileQuantityPolicy(rewardProfile),
    },
  ));
  const rewardRoomIndex = toInt(
    rewardProfile && rewardProfile.roomIndex,
    toInt(buildPlaceholderRoomState(pocketState).currentRoomIndex, 0),
  );
  logTier0RewardResolution(pocketState, rewardRoomIndex, "cache", scaledEntries);
  logTier2RewardResolution(
    pocketState,
    rewardRoomIndex,
    "cache",
    rewardProfile && rewardProfile.rewardProfileID,
    scaledEntries,
  );
  return scaledEntries;
}

function listContainerLootEntries(ports, containerItemID, deps = ports.getDependencies()) {
  const {
    resolveInventoryItemLogicalQuantity,
  } = ports;
  if (toInt(containerItemID, 0) <= 0 || typeof deps.listContainerItems !== "function") {
    return [];
  }
  return deps.listContainerItems(null, toInt(containerItemID, 0), null)
  .map((item) => ({
    itemName: normalizeText(item && (item.itemName || item.name), ""),
    quantity: resolveInventoryItemLogicalQuantity(item),
  }))
  .filter((entry) => entry.itemName && entry.quantity > 0);
}

function listCombinedContainerLootEntries(ports, containerItemIDs = [], deps = ports.getDependencies()) {
  const {
    mergeAbyssalRewardEntries,
  } = ports;
  const combinedEntries = [];
  for (const containerItemID of listUniquePositiveInts(containerItemIDs)) {
    combinedEntries.push(...listContainerLootEntries(ports, containerItemID, deps));
  }
  return mergeAbyssalRewardEntries(combinedEntries);
}

function resolveRoomExtractionNodeProfile(ports, pocketState, roomIndex = null, options = {}) {
  const {
    getContentProfile,
    getExtractionNodeProfile,
    isProceduralAbyssalContent,
    buildAbyssalContentResolutionError,
    buildPlaceholderRoomState,
    clampRoomIndex,
    resolveRoomEncounterProfile,
    getAuthoredRoomEncounterProfile,
    isTranquilAbyssalContent,
    cloneValue,
    applyRewardQuantityMultiplier,
    logTier0RewardResolution,
    logTier2RewardResolution,
  } = ports;
  const contentProfile = getContentProfile(pocketState) || {};
  const baseProfile = getExtractionNodeProfile(pocketState);
  if (isProceduralAbyssalContent(contentProfile) &&
      (!baseProfile || !Array.isArray(baseProfile.guaranteedLootEntries))) {
    throw buildAbyssalContentResolutionError("ABYSSAL_EXTRACTION_PROFILE_INVALID", pocketState, roomIndex, "extraction");
  }
  const roomState = buildPlaceholderRoomState(pocketState);
  const resolvedRoomIndex = clampRoomIndex(
    roomIndex == null ? roomState.currentRoomIndex : roomIndex,
    roomState.implementedRooms,
  );
  const encounterProfile = options.encounterProfile || resolveRoomEncounterProfile(
    pocketState,
    resolvedRoomIndex,
    {
      logResolution: false,
    },
  );
  const authoredEncounterProfile = getAuthoredRoomEncounterProfile(pocketState, roomIndex);
  const requiresSupportedEmpiricalEncounter =
    toInt(contentProfile.tier, -1) >= 2 &&
    ports.shouldUseCorrelatedAbyssalSpaceEmpiricalContent(contentProfile);
  if (
    requiresSupportedEmpiricalEncounter &&
    (
      typeof ports.isSupportedAbyssalExtractionEncounter !== "function" ||
      !ports.isSupportedAbyssalExtractionEncounter({
        encounterProfile,
        tier: toInt(contentProfile.tier, -1),
        weatherType: normalizeText(contentProfile.weatherType, ""),
        roomIndex: resolvedRoomIndex,
      })
    )
  ) {
    return null;
  }
  const extractionNodeProfileOverride = isProceduralAbyssalContent(contentProfile) || isTranquilAbyssalContent(pocketState)
    ? null
    : encounterProfile && encounterProfile.extractionNodeProfileOverride ||
      authoredEncounterProfile && authoredEncounterProfile.extractionNodeProfileOverride ||
      null;
  const extractionNodeProfile = extractionNodeProfileOverride
    ? cloneValue(extractionNodeProfileOverride)
    : baseProfile;
  if (!extractionNodeProfile) {
    return null;
  }
  const eligibleRoomIndexes = listUniquePositiveInts(extractionNodeProfile.eligibleRoomIndexes);
  const eligibleTiers = listUniqueNonNegativeInts(extractionNodeProfile.eligibleTiers);
  const rawTier = Number(contentProfile && contentProfile.tier);
  const currentTier = Number.isFinite(rawTier) ? Math.max(0, Math.trunc(rawTier)) : 1;
  const guaranteedLootEntries = Array.isArray(extractionNodeProfile.guaranteedLootEntries)
    ? extractionNodeProfile.guaranteedLootEntries
    : Array.isArray(contentProfile.rewardProfile && contentProfile.rewardProfile.extractionNodeLootEntries)
      ? contentProfile.rewardProfile.extractionNodeLootEntries
      : [];
  const scaledGuaranteedLootEntries = applyRewardQuantityMultiplier(
    guaranteedLootEntries.map((entry) => ({
      ...entry,
      quantity: Math.max(0, toInt(entry && entry.quantity, 0)),
    })),
    pocketState,
    extractionNodeProfile.quantityPolicy,
  );
  logTier0RewardResolution(pocketState, resolvedRoomIndex, "extraction", scaledGuaranteedLootEntries);
  logTier2RewardResolution(
    pocketState,
    resolvedRoomIndex,
    "extraction",
    extractionNodeProfile && extractionNodeProfile.extractionNodeProfileID,
    scaledGuaranteedLootEntries,
  );
  return {
    ...cloneValue(extractionNodeProfile),
    roomIndex: resolvedRoomIndex,
    eligibleForRoom:
      extractionNodeProfile.enabled === true &&
      (eligibleRoomIndexes.length <= 0 || eligibleRoomIndexes.includes(resolvedRoomIndex)) &&
      (eligibleTiers.length <= 0 || eligibleTiers.includes(currentTier)),
    guaranteedLootEntries: scaledGuaranteedLootEntries,
  };
}

function buildResolvedExtractionNodeLootEntries(ports,
  extractionNodeProfile,
  pocketState,
  deps = ports.getDependencies(),
) {
  const {
    cloneValue,
    nextAbyssalLootRandom,
    mergeAbyssalRewardEntries,
  } = ports;
  const guaranteedEntries = Array.isArray(
    extractionNodeProfile && extractionNodeProfile.guaranteedLootEntries,
  )
    ? cloneValue(extractionNodeProfile.guaranteedLootEntries)
    : [];
  const independentEntries = Array.isArray(
    extractionNodeProfile && extractionNodeProfile.independentLootEntries,
  )
    ? extractionNodeProfile.independentLootEntries
    : [];
  const emptyChance = Math.max(0, Math.min(
    1,
    Number(extractionNodeProfile && extractionNodeProfile.lootEmptyChance) || 0,
  ));
  const resolvesWholeNodeEmptiness = Boolean(
    extractionNodeProfile &&
    extractionNodeProfile.wholeNodeEmptyRoll === true &&
    emptyChance > 0,
  );
  if (
    resolvesWholeNodeEmptiness &&
    nextAbyssalLootRandom(deps) < emptyChance
  ) {
    return [];
  }
  if (independentEntries.length === 0) {
    return guaranteedEntries;
  }
  // Profiles which do not opt into whole-node emptiness retain the existing
  // independent-entry resolution order and always preserve guaranteed loot.
  if (
    !resolvesWholeNodeEmptiness &&
    nextAbyssalLootRandom(deps) < emptyChance
  ) {
    return guaranteedEntries;
  }
  const selected = [];
  for (const entry of independentEntries) {
    const probability = Math.max(0, Math.min(1, Number(entry && entry.probability) || 0));
    if (nextAbyssalLootRandom(deps) < probability) {
      selected.push({
        ...cloneValue(entry),
        quantity: Math.max(1, toInt(entry && entry.quantity, 1)),
      });
    }
  }
  if (selected.length === 0) {
    const fallbackIndex = Math.floor(nextAbyssalLootRandom(deps) * independentEntries.length);
    const fallback = independentEntries[fallbackIndex] || independentEntries[0];
    if (fallback) {
      selected.push({
        ...cloneValue(fallback),
        quantity: Math.max(1, toInt(fallback.quantity, 1)),
      });
    }
  }
  return mergeAbyssalRewardEntries([...guaranteedEntries, ...selected]);
}

function createAbyssalRewardLootResolution(ports) {
  return {
    resolveEmpiricalRewardLootEntries: resolveEmpiricalRewardLootEntries.bind(null, ports),
    resolveObservedRunRewardLootEntries: resolveObservedRunRewardLootEntries.bind(null, ports),
    buildResolvedRewardCacheLootEntries: buildResolvedRewardCacheLootEntries.bind(null, ports),
    listContainerLootEntries: listContainerLootEntries.bind(null, ports),
    listCombinedContainerLootEntries: listCombinedContainerLootEntries.bind(null, ports),
    resolveRoomExtractionNodeProfile: resolveRoomExtractionNodeProfile.bind(null, ports),
    buildResolvedExtractionNodeLootEntries: buildResolvedExtractionNodeLootEntries.bind(null, ports),
  };
}

module.exports = { createAbyssalRewardLootResolution };
