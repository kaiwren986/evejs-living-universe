"use strict";

const { toInt, normalizeText } = require("../domain/abyssalRuntimeValues");

function buildObservedRunRewardAllocationSeed(ports, pocketState, rewardProfile) {
  const explicitSeed = normalizeText(
    pocketState && (pocketState.rewardRngSeed || pocketState.rngSeed),
    "",
  );
  return [
    "abyssal-run-reward-allocation-v1",
    explicitSeed || toInt(pocketState && pocketState.instanceID, 0),
    toInt(pocketState && pocketState.characterID, 0),
    toInt(pocketState && pocketState.activatedAtMs, 0),
    normalizeText(rewardProfile && rewardProfile.rewardProfileID, "unknown"),
  ].join(":");
}

function selectObservedRunRewardOutcome(ports, rewardProfile, deps) {
  const {
    nextAbyssalLootRandom,
    cloneValue,
  } = ports;
  const outcomes = (Array.isArray(rewardProfile && rewardProfile.observedRunLootOutcomes)
    ? rewardProfile.observedRunLootOutcomes
    : [])
    .filter((outcome) =>
      outcome &&
      outcome.productionEligible === true &&
      toInt(outcome.effectiveProductionWeight, 0) > 0 &&
      Array.isArray(outcome.entries) &&
      outcome.entries.length > 0 &&
      (
        normalizeText(outcome.rewardEvidenceStatus, "") ===
          "observed_non_empty" ||
        !normalizeText(outcome.rewardEvidenceStatus, "")
      )
    );
  const totalWeight = outcomes.reduce(
    (total, outcome) =>
      total + Math.max(0, toInt(outcome.effectiveProductionWeight, 0)),
    0,
  );
  if (!(totalWeight > 0)) {
    throw new TypeError(
      "Observed reward profile has no production-eligible non-empty run outcomes",
    );
  }
  let cursor = nextAbyssalLootRandom(deps) * totalWeight;
  let selectedOutcome = outcomes[outcomes.length - 1];
  for (const outcome of outcomes) {
    cursor -= Math.max(0, toInt(outcome.effectiveProductionWeight, 0));
    if (cursor < 0) {
      selectedOutcome = outcome;
      break;
    }
  }
  return cloneValue(selectedOutcome);
}

function normalizeObservedRunRewardManifest(ports, entries, deps) {
  const {
    mergeAbyssalRewardEntries,
    resolveRewardLootType,
    cloneValue,
  } = ports;
  const manifest = mergeAbyssalRewardEntries(entries)
    .map((entry, index) => {
      const rewardType = resolveRewardLootType(entry, deps);
      const itemTypeID = toInt(
        rewardType && rewardType.typeID,
        toInt(entry && entry.itemTypeID, 0),
      );
      const quantity = Number(entry && entry.quantity);
      if (itemTypeID <= 0) {
        throw new TypeError(
          `Observed run reward manifest entry ${index} has no authoritative type ID`,
        );
      }
      if (!Number.isSafeInteger(quantity) || quantity <= 0) {
        throw new TypeError(
          `Observed run reward manifest entry ${index} has an invalid quantity`,
        );
      }
      return {
        ...cloneValue(entry),
        itemTypeID,
        itemName: normalizeText(
          rewardType && rewardType.name,
          normalizeText(entry && entry.itemName, ""),
        ),
        baseQuantity: toInt(entry && entry.baseQuantity, quantity),
        quantity,
        minQuantity: quantity,
        maxQuantity: quantity,
        probability: 1,
      };
    })
    .sort((left, right) => left.itemTypeID - right.itemTypeID);
  if (manifest.length <= 0) {
    throw new TypeError("Observed whole-run reward manifest is empty");
  }
  return manifest;
}

function listObservedRunRewardArtifactDescriptors(ports, pocketState) {
  const {
    buildPlaceholderRoomState,
    cloneValue,
    getCacheProfile,
  } = ports;
  const roomState = buildPlaceholderRoomState(pocketState);
  const artifacts = [];
  for (let roomIndex = 1; roomIndex <= roomState.implementedRooms; roomIndex += 1) {
    const roomScopedState = {
      ...cloneValue(pocketState),
      roomState: buildPlaceholderRoomState(pocketState, { currentRoomIndex: roomIndex }),
    };
    const cacheProfile = getCacheProfile(roomScopedState);
    const cacheTypeID = toInt(cacheProfile && cacheProfile.cacheTypeID, 0);
    if (!cacheProfile || cacheTypeID <= 0) {
      continue;
    }
    artifacts.push({
      artifactID: [
        "abyssal-run-reward-artifact",
        toInt(pocketState && pocketState.instanceID, 0),
        `room-${roomIndex}`,
        "main-cache",
      ].join(":"),
      roomIndex,
      artifactRole: "main_cache",
      cacheProfileID: normalizeText(
        cacheProfile.cacheProfileID,
        normalizeText(cacheProfile.cacheFamily, ""),
      ),
      cacheTypeID,
    });
  }
  return artifacts;
}

function validateObservedRunRewardAllocation(ports, allocation, pocketState = null, rewardProfile = null) {
  const {
    validatePureObservedRunRewardAllocation,
  } = ports;
  return validatePureObservedRunRewardAllocation(allocation, {
    ...(pocketState ? {
      instanceID: toInt(pocketState.instanceID, 0),
      artifacts: listObservedRunRewardArtifactDescriptors(ports, pocketState),
    } : {}),
    ...(rewardProfile ? {
      sourceRewardProfileID: normalizeText(rewardProfile.rewardProfileID, ""),
      lootTableID: normalizeText(rewardProfile.lootTableID, ""),
      observedRunLootOutcomes: rewardProfile.observedRunLootOutcomes,
    } : {}),
  });
}

function buildObservedRunRewardAllocation(ports,
  pocketState,
  rewardProfile,
  deps = ports.getDependencies(),
  options = {},
) {
  const {
    isObservedRunRewardAllocationProfile,
    createDeterministicAbyssalRewardDependencies,
    cloneValue,
    buildPureObservedRunRewardAllocation,
  } = ports;
  if (!isObservedRunRewardAllocationProfile(rewardProfile)) {
    throw new TypeError("Reward profile does not use observed run allocation");
  }
  const rngSeed = normalizeText(
    options.rngSeed,
    buildObservedRunRewardAllocationSeed(ports, pocketState, rewardProfile),
  );
  const deterministicDeps = createDeterministicAbyssalRewardDependencies(deps, rngSeed);
  const selectedOutcome = selectObservedRunRewardOutcome(ports,
    rewardProfile,
    deterministicDeps,
  );
  const empiricalOutcomeID = normalizeText(selectedOutcome.lootOutcomeID, "");
  const wholeRunManifest = normalizeObservedRunRewardManifest(ports,
    selectedOutcome.entries.map((entry) => ({
      ...cloneValue(entry),
      sourceLootOutcomeID: empiricalOutcomeID,
      sourceLootOutcomeObservationCount: Math.max(
        1,
        toInt(selectedOutcome.observationCount, 1),
      ),
      sourceLootOutcomeConfidenceCounts: cloneValue(
        selectedOutcome.confidenceCounts || {},
      ),
    })),
    deps,
  );
  const artifacts = listObservedRunRewardArtifactDescriptors(ports, pocketState);
  const allocation = buildPureObservedRunRewardAllocation({
    instanceID: toInt(pocketState && pocketState.instanceID, 0),
    sourceRewardProfileID: normalizeText(rewardProfile.rewardProfileID, ""),
    lootTableID: normalizeText(rewardProfile.lootTableID, ""),
    empiricalOutcomeID,
    rngSeed,
    wholeRunManifest,
    artifacts,
    createdAtMs: Math.max(0, toInt(pocketState && pocketState.activatedAtMs, 0)),
  });
  return validateObservedRunRewardAllocation(ports, allocation, pocketState, rewardProfile);
}

function hasLegacyObservedRunRewardPlanState(ports, pocketState, rewardProfile) {
  const {
    isObservedRunRewardAllocationProfile,
    buildPlaceholderRoomState,
  } = ports;
  if (
    !isObservedRunRewardAllocationProfile(rewardProfile) ||
    pocketState && pocketState.runRewardAllocation
  ) {
    return false;
  }
  const rewardProfileID = normalizeText(rewardProfile && rewardProfile.rewardProfileID, "");
  const mirroredPlan = pocketState && pocketState.rewardState &&
    pocketState.rewardState.cacheRewardPlan;
  if (
    mirroredPlan &&
    normalizeText(mirroredPlan.sourceRewardProfileID, "") === rewardProfileID
  ) {
    return true;
  }
  const roomState = buildPlaceholderRoomState(pocketState);
  return Object.values(roomState.roomStatesByIndex || {}).some((roomEntry) => {
    const plan = roomEntry && roomEntry.cacheRewardPlan;
    return plan &&
      normalizeText(plan.sourceRewardProfileID, "") === rewardProfileID;
  });
}

function buildLegacyObservedRunRewardProfile(ports, rewardProfile) {
  const {
    cloneValue,
  } = ports;
  return {
    ...cloneValue(rewardProfile),
    observedRunLootAllocation: {
      schemaVersion: 1,
      model: "whole_observed_run_outcome_in_final_room_cache",
      roomIndex: 3,
      roomAttributionSource: "not_observed",
    },
  };
}

function validateAbyssalRewardPlanContext(ports, plan, pocketState, roomIndex, rewardProfile) {
  const {
    getContentProfile,
    validatePureAbyssalRewardPlanContext,
  } = ports;
  const contentProfile = getContentProfile(pocketState) || {};
  const expected = {
    planID: [
      "abyssal-reward-plan",
      toInt(pocketState && pocketState.instanceID, 0),
      toInt(roomIndex, 0),
    ].join(":"),
    sourceRewardProfileID: normalizeText(rewardProfile && rewardProfile.rewardProfileID, ""),
    lootTableID: normalizeText(rewardProfile && rewardProfile.lootTableID, ""),
    quantityPolicy: normalizeText(rewardProfile && rewardProfile.quantityPolicy, ""),
    tier: Math.max(0, toInt(contentProfile.tier, rewardProfile && rewardProfile.tier)),
    weather: normalizeText(contentProfile.weatherType, rewardProfile && rewardProfile.weatherTheme),
    roomIndex: toInt(roomIndex, 0),
  };
  return validatePureAbyssalRewardPlanContext(plan, expected);
}

function buildAbyssalRewardPlan(ports,
  pocketState,
  rewardProfile,
  roomIndex,
  deps = ports.getDependencies(),
  options = {},
) {
  const {
    validateRewardProfileQuantityPolicy,
    getContentProfile,
    buildAbyssalRewardRollSeed,
    createDeterministicAbyssalRewardDependencies,
    cloneValue,
    isObservedRunRewardAllocationProfile,
    getObservedRunRewardArtifactAllocation,
    buildResolvedRewardCacheLootEntries,
    mergeAbyssalRewardEntries,
    resolveRewardLootType,
    buildPureAbyssalRewardPlan,
  } = ports;
  validateRewardProfileQuantityPolicy(rewardProfile);
  const contentProfile = getContentProfile(pocketState) || {};
  const rngSeed = normalizeText(
    options.rngSeed,
    buildAbyssalRewardRollSeed(pocketState, rewardProfile, roomIndex),
  );
  const deterministicDeps = createDeterministicAbyssalRewardDependencies(deps, rngSeed);
  let resolvedEntries = null;
  if (Array.isArray(options.resolvedEntries)) {
    resolvedEntries = cloneValue(options.resolvedEntries);
  } else if (isObservedRunRewardAllocationProfile(rewardProfile)) {
    const allocation = pocketState && pocketState.runRewardAllocation
      ? validateObservedRunRewardAllocation(ports,
          cloneValue(pocketState.runRewardAllocation),
          pocketState,
          rewardProfile,
        )
      : buildObservedRunRewardAllocation(ports,
          pocketState,
          rewardProfile,
          deps,
          {
            rngSeed: normalizeText(
              options.rngSeed,
              buildObservedRunRewardAllocationSeed(ports, pocketState, rewardProfile),
            ),
          },
        );
    const artifactAllocation = getObservedRunRewardArtifactAllocation(
      allocation,
      roomIndex,
    );
    if (!artifactAllocation) {
      throw new TypeError(
        `Observed run reward allocation has no main cache for room ${roomIndex}`,
      );
    }
    resolvedEntries = cloneValue(artifactAllocation.entries);
  } else {
    resolvedEntries = buildResolvedRewardCacheLootEntries(
      rewardProfile,
      pocketState,
      deterministicDeps,
    );
  }
  const selectedEntries = mergeAbyssalRewardEntries(resolvedEntries).map((entry) => {
    const rewardType = resolveRewardLootType(entry, deps);
    const itemTypeID = toInt(rewardType && rewardType.typeID, toInt(entry && entry.itemTypeID, 0));
    return {
      ...cloneValue(entry),
      itemTypeID,
      itemName: normalizeText(rewardType && rewardType.name, normalizeText(entry.itemName, "")),
    };
  });
  return buildPureAbyssalRewardPlan({
    instanceID: toInt(pocketState && pocketState.instanceID, 0),
    sourceRewardProfileID: normalizeText(rewardProfile.rewardProfileID, ""),
    lootTableID: normalizeText(rewardProfile.lootTableID, ""),
    quantityPolicy: rewardProfile.quantityPolicy,
    tier: Math.max(0, toInt(contentProfile.tier, rewardProfile.tier)),
    weather: normalizeText(contentProfile.weatherType, rewardProfile.weatherTheme),
    roomIndex: toInt(roomIndex, 0),
    rngSeed,
    entries: selectedEntries,
    createdAtMs: toInt(deps && deps.now && deps.now(), Date.now()),
  });
}

function markAbyssalRewardPlanGranted(ports, plan, receiptKey, grantedAtMs) {
  const {
    cloneValue,
    validateAbyssalRewardPlan,
  } = ports;
  const validated = cloneValue(validateAbyssalRewardPlan(plan));
  const normalizedReceiptKey = normalizeText(receiptKey, "");
  validated.grantProgress = {
    status: "completed",
    entries: Object.fromEntries(validated.entries.map((entry) => [entry.grantID, {
      status: "completed",
      receiptKey: normalizedReceiptKey,
      completedAtMs: toInt(grantedAtMs, Date.now()),
    }])),
    receiptKeys: normalizedReceiptKey ? [normalizedReceiptKey] : [],
    completedAtMs: toInt(grantedAtMs, Date.now()),
  };
  return validated;
}

function isIntentionallyEmptyObservedRunRoomRewardPlan(ports,
  pocketState,
  rewardProfile,
  rewardPlan,
) {
  const {
    isObservedRunRewardAllocationProfile,
    cloneValue,
    getObservedRunRewardArtifactAllocation,
  } = ports;
  if (
    !isObservedRunRewardAllocationProfile(rewardProfile) ||
    !rewardPlan ||
    !Array.isArray(rewardPlan.entries) ||
    rewardPlan.entries.length > 0 ||
    !pocketState ||
    !pocketState.runRewardAllocation
  ) {
    return false;
  }
  try {
    const allocation = validateObservedRunRewardAllocation(ports,
      cloneValue(pocketState.runRewardAllocation),
      pocketState,
      rewardProfile,
    );
    const artifactAllocation = getObservedRunRewardArtifactAllocation(
      allocation,
      rewardPlan.roomIndex,
    );
    return Array.isArray(allocation.wholeRunManifest) &&
      allocation.wholeRunManifest.length > 0 &&
      artifactAllocation &&
      Array.isArray(artifactAllocation.entries) &&
      artifactAllocation.entries.length === 0;
  } catch (_error) {
    // ignored: an allocation that fails validation is not an observed empty room (false)
    return false;
  }
}

function createAbyssalRewardPlanModels(ports) {
  return {
    buildObservedRunRewardAllocationSeed: buildObservedRunRewardAllocationSeed.bind(null, ports),
    selectObservedRunRewardOutcome: selectObservedRunRewardOutcome.bind(null, ports),
    normalizeObservedRunRewardManifest: normalizeObservedRunRewardManifest.bind(null, ports),
    listObservedRunRewardArtifactDescriptors: listObservedRunRewardArtifactDescriptors.bind(null, ports),
    validateObservedRunRewardAllocation: validateObservedRunRewardAllocation.bind(null, ports),
    buildObservedRunRewardAllocation: buildObservedRunRewardAllocation.bind(null, ports),
    hasLegacyObservedRunRewardPlanState: hasLegacyObservedRunRewardPlanState.bind(null, ports),
    buildLegacyObservedRunRewardProfile: buildLegacyObservedRunRewardProfile.bind(null, ports),
    validateAbyssalRewardPlanContext: validateAbyssalRewardPlanContext.bind(null, ports),
    buildAbyssalRewardPlan: buildAbyssalRewardPlan.bind(null, ports),
    markAbyssalRewardPlanGranted: markAbyssalRewardPlanGranted.bind(null, ports),
    isIntentionallyEmptyObservedRunRoomRewardPlan: isIntentionallyEmptyObservedRunRoomRewardPlan.bind(null, ports),
  };
}

module.exports = { createAbyssalRewardPlanModels };
