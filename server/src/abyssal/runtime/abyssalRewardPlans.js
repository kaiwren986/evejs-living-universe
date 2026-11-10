"use strict";

const { validateAbyssalRewardPlan, rewardEntryQuantitiesMatch } = require("./abyssalRewardPlanningPolicy");
const { normalizeText } = require("../domain/abyssalValueUtils");

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

// Saved reward-plan orchestration. The current registry/persistence boundary and
// version-specific generation/validation policies are injected; this unit never
// owns RNG, inventory materialization or mutable run state.
function persistAbyssalRewardPlan({
  getDependencies,
  cloneValue,
  getPlaceholderRoomEntry,
  setPlaceholderRoomEntry,
  updatePocketState,
  buildPocketStateForCurrentRoom,
  ensureAbyssalPocketPersistenceReady,
},
  pocketState,
  roomIndex,
  rewardPlan,
  deps = getDependencies(),
) {
  const validatedPlan = cloneValue(validateAbyssalRewardPlan(rewardPlan));
  const roomEntry = getPlaceholderRoomEntry(pocketState, roomIndex);
  const nextRoomState = setPlaceholderRoomEntry(pocketState, roomIndex, {
    ...roomEntry,
    cacheRewardPlan: validatedPlan,
    cacheRewardEntries: cloneValue(validatedPlan.entries),
  });
  const updatedPocketState = updatePocketState(pocketState.instanceID, {
    ...buildPocketStateForCurrentRoom(pocketState, nextRoomState),
    rewardState: {
      ...cloneValue(pocketState.rewardState || {}),
      cacheRewardPlan: validatedPlan,
      cacheRewardEntries: cloneValue(validatedPlan.entries),
    },
  });
  const persistenceResult = updatedPocketState
    ? ensureAbyssalPocketPersistenceReady(updatedPocketState, deps)
    : { success: false, errorMsg: "POCKET_STATE_UPDATE_FAILED" };
  if (!persistenceResult.success) {
    return {
      success: false,
      errorMsg: "ABYSSAL_REWARD_PLAN_PERSIST_FAILED",
      persistenceResult,
      data: updatedPocketState || pocketState,
    };
  }
  return {
    success: true,
    rewardPlan: validatedPlan,
    data: updatedPocketState,
  };
}

function persistObservedRunRewardAllocation({
  getDependencies,
  cloneValue,
  validateObservedRunRewardAllocation,
  buildPlaceholderRoomState,
  getPlaceholderRoomEntry,
  validateAbyssalRewardPlanContext,
  buildAbyssalRewardPlan,
  setPlaceholderRoomEntry,
  buildPocketStateForCurrentRoom,
  updatePocketState,
  ensureAbyssalPocketPersistenceReady,
},
  pocketState,
  rewardProfile,
  allocation,
  deps = getDependencies(),
) {
  try {
    const validatedAllocation = cloneValue(validateObservedRunRewardAllocation(
      allocation,
      pocketState,
      rewardProfile,
    ));
    let nextRoomState = buildPlaceholderRoomState(pocketState);
    const rewardPlansByRoom = {};
    let changed = !pocketState.runRewardAllocation;
    for (const artifact of validatedAllocation.artifactAllocations) {
      const roomIndex = toInt(artifact.roomIndex, 0);
      const scopedPocketState = {
        ...cloneValue(pocketState),
        runRewardAllocation: validatedAllocation,
        roomState: nextRoomState,
      };
      const roomEntry = getPlaceholderRoomEntry(scopedPocketState, roomIndex);
      let rewardPlan = roomEntry.cacheRewardPlan || null;
      if (rewardPlan) {
        rewardPlan = cloneValue(validateAbyssalRewardPlanContext(
          rewardPlan,
          scopedPocketState,
          roomIndex,
          rewardProfile,
        ));
        if (!rewardEntryQuantitiesMatch(rewardPlan.entries, artifact.entries)) {
          throw new TypeError(
            `Observed run reward plan does not match allocation for room ${roomIndex}`,
          );
        }
        if (!rewardEntryQuantitiesMatch(roomEntry.cacheRewardEntries, rewardPlan.entries)) {
          changed = true;
        }
      } else {
        rewardPlan = buildAbyssalRewardPlan(
          scopedPocketState,
          rewardProfile,
          roomIndex,
          deps,
          {
            rngSeed: `${validatedAllocation.rngSeed}:${artifact.artifactID}`,
            resolvedEntries: artifact.entries,
          },
        );
        changed = true;
      }
      rewardPlansByRoom[String(roomIndex)] = cloneValue(rewardPlan);
      nextRoomState = setPlaceholderRoomEntry(
        { ...scopedPocketState, roomState: nextRoomState },
        roomIndex,
        {
          ...roomEntry,
          cacheRewardPlan: rewardPlan,
          cacheRewardEntries: cloneValue(rewardPlan.entries),
        },
      );
    }
    if (!changed) {
      return {
        success: true,
        reused: true,
        rewardAllocation: validatedAllocation,
        rewardPlansByRoom,
        data: pocketState,
      };
    }
    const currentRoomIndex = buildPlaceholderRoomState(pocketState).currentRoomIndex;
    const currentPlan = rewardPlansByRoom[String(currentRoomIndex)] || null;
    const updatePatch = buildPocketStateForCurrentRoom(
      {
        ...cloneValue(pocketState),
        runRewardAllocation: validatedAllocation,
      },
      nextRoomState,
    );
    updatePatch.runRewardAllocation = validatedAllocation;
    updatePatch.rewardState = currentPlan
      ? {
          ...cloneValue(pocketState.rewardState || {}),
          cacheRewardPlan: cloneValue(currentPlan),
          cacheRewardEntries: cloneValue(currentPlan.entries),
        }
      : cloneValue(pocketState.rewardState || null);
    const updatedPocketState = updatePocketState(pocketState.instanceID, updatePatch);
    const persistenceResult = ensureAbyssalPocketPersistenceReady(updatedPocketState, deps);
    if (!persistenceResult.success) {
      return {
        success: false,
        errorMsg: "ABYSSAL_RUN_REWARD_ALLOCATION_PERSIST_FAILED",
        persistenceResult,
        data: updatedPocketState || pocketState,
      };
    }
    return {
      success: true,
      reused: false,
      rewardAllocation: validatedAllocation,
      rewardPlansByRoom,
      data: updatedPocketState,
    };
  } catch (error) {
    return {
      success: false,
      errorMsg: "ABYSSAL_RUN_REWARD_ALLOCATION_INVALID",
      validationError: normalizeText(
        error && error.message,
        "INVALID_RUN_REWARD_ALLOCATION",
      ),
      data: pocketState,
    };
  }
}

function ensureObservedRunRewardAllocation({
  getDependencies,
  isObservedRunRewardAllocationProfile,
  validateObservedRunRewardAllocation,
  cloneValue,
  buildObservedRunRewardAllocation,
  persistObservedRunRewardAllocation,
},
  pocketState,
  rewardProfile,
  deps = getDependencies(),
) {
  if (!isObservedRunRewardAllocationProfile(rewardProfile)) {
    return {
      success: true,
      skipped: true,
      data: pocketState,
    };
  }
  try {
    const allocation = pocketState && pocketState.runRewardAllocation
      ? validateObservedRunRewardAllocation(
          cloneValue(pocketState.runRewardAllocation),
          pocketState,
          rewardProfile,
        )
      : buildObservedRunRewardAllocation(pocketState, rewardProfile, deps);
    return persistObservedRunRewardAllocation(
      pocketState,
      rewardProfile,
      allocation,
      deps,
    );
  } catch (error) {
    return {
      success: false,
      errorMsg: "ABYSSAL_RUN_REWARD_ALLOCATION_INVALID",
      validationError: normalizeText(
        error && error.message,
        "INVALID_RUN_REWARD_ALLOCATION",
      ),
      data: pocketState,
    };
  }
}

function ensureAbyssalRewardPlan({
  getDependencies,
  hasLegacyObservedRunRewardPlanState,
  buildLegacyObservedRunRewardProfile,
  isObservedRunRewardAllocationProfile,
  ensureObservedRunRewardAllocation,
  cloneValue,
  getPlaceholderRoomEntry,
  validateAbyssalRewardPlanContext,
  buildPlaceholderRoomState,
  buildAbyssalRewardPlan,
  persistAbyssalRewardPlan,
},
  pocketState,
  roomIndex,
  rewardProfile,
  deps = getDependencies(),
) {
  const legacyObservedRun = hasLegacyObservedRunRewardPlanState(
    pocketState,
    rewardProfile,
  );
  const effectiveRewardProfile = legacyObservedRun
    ? buildLegacyObservedRunRewardProfile(rewardProfile)
    : rewardProfile;
  if (isObservedRunRewardAllocationProfile(effectiveRewardProfile)) {
    const allocationResult = ensureObservedRunRewardAllocation(
      pocketState,
      effectiveRewardProfile,
      deps,
    );
    if (!allocationResult.success) {
      return allocationResult;
    }
    const resolvedPocketState = allocationResult.data || pocketState;
    const rewardPlan = allocationResult.rewardPlansByRoom &&
      allocationResult.rewardPlansByRoom[String(toInt(roomIndex, 0))] || null;
    if (!rewardPlan) {
      return {
        success: false,
        errorMsg: "ABYSSAL_RUN_REWARD_ALLOCATION_INVALID",
        validationError: `Observed run allocation has no plan for room ${toInt(roomIndex, 0)}`,
        data: resolvedPocketState,
      };
    }
    return {
      success: true,
      reused: allocationResult.reused === true,
      rewardPlan: cloneValue(rewardPlan),
      rewardAllocation: cloneValue(allocationResult.rewardAllocation),
      data: resolvedPocketState,
    };
  }
  const roomEntry = getPlaceholderRoomEntry(pocketState, roomIndex);
  const roomPlan = roomEntry.cacheRewardPlan || null;
  const mirroredPlan = pocketState && pocketState.rewardState &&
    pocketState.rewardState.cacheRewardPlan || null;
  const existingPlan = roomPlan || (
    mirroredPlan && toInt(mirroredPlan.roomIndex, 0) === toInt(roomIndex, 0)
      ? mirroredPlan
      : null
  );
  if (existingPlan) {
    try {
      const validatedPlan = cloneValue(validateAbyssalRewardPlanContext(
        existingPlan,
        pocketState,
        roomIndex,
        effectiveRewardProfile,
      ));
      return {
        success: true,
        reused: true,
        rewardPlan: validatedPlan,
        data: pocketState,
      };
    } catch (error) {
      return {
        success: false,
        errorMsg: "ABYSSAL_REWARD_PLAN_INVALID",
        validationError: normalizeText(error && error.message, "INVALID_REWARD_PLAN"),
        data: pocketState,
      };
    }
  }
  try {
    const currentRoomIndex = toInt(
      buildPlaceholderRoomState(pocketState).currentRoomIndex,
      0,
    );
    const legacyResolvedEntries = Array.isArray(roomEntry.cacheRewardEntries) &&
      roomEntry.cacheRewardEntries.length > 0
      ? roomEntry.cacheRewardEntries
      : currentRoomIndex === toInt(roomIndex, 0) &&
          Array.isArray(pocketState && pocketState.rewardState &&
          pocketState.rewardState.cacheRewardEntries) &&
          pocketState.rewardState.cacheRewardEntries.length > 0
        ? pocketState.rewardState.cacheRewardEntries
        : null;
    const rewardPlan = buildAbyssalRewardPlan(
      pocketState,
      effectiveRewardProfile,
      roomIndex,
      deps,
      legacyResolvedEntries
        ? {
            rngSeed: `legacy-resolved:${toInt(pocketState.instanceID, 0)}:${roomIndex}`,
            resolvedEntries: legacyResolvedEntries,
          }
        : {},
    );
    return persistAbyssalRewardPlan(pocketState, roomIndex, rewardPlan, deps);
  } catch (error) {
    return {
      success: false,
      errorMsg: "ABYSSAL_REWARD_PLAN_RESOLUTION_FAILED",
      validationError: normalizeText(error && error.message, "REWARD_PLAN_RESOLUTION_FAILED"),
      data: pocketState,
    };
  }
}

// Capture supplied capabilities once, as the original closure did. Internal
// callbacks are bound once per instance; no runtime state lives in this wiring.
function createAbyssalRewardPlans({
  getDependencies,
  cloneValue,
  getPlaceholderRoomEntry,
  setPlaceholderRoomEntry,
  buildPocketStateForCurrentRoom,
  updatePocketState,
  ensureAbyssalPocketPersistenceReady,
  buildPlaceholderRoomState,
  validateObservedRunRewardAllocation,
  validateAbyssalRewardPlanContext,
  buildAbyssalRewardPlan,
  isObservedRunRewardAllocationProfile,
  buildObservedRunRewardAllocation,
  hasLegacyObservedRunRewardPlanState,
  buildLegacyObservedRunRewardProfile,
}) {

  const ports = {
    getDependencies,
    cloneValue,
    getPlaceholderRoomEntry,
    setPlaceholderRoomEntry,
    buildPocketStateForCurrentRoom,
    updatePocketState,
    ensureAbyssalPocketPersistenceReady,
    buildPlaceholderRoomState,
    validateObservedRunRewardAllocation,
    validateAbyssalRewardPlanContext,
    buildAbyssalRewardPlan,
    isObservedRunRewardAllocationProfile,
    buildObservedRunRewardAllocation,
    hasLegacyObservedRunRewardPlanState,
    buildLegacyObservedRunRewardProfile,
  };
  ports.persistAbyssalRewardPlan = persistAbyssalRewardPlan.bind(null, ports);
  ports.persistObservedRunRewardAllocation = persistObservedRunRewardAllocation.bind(null, ports);
  ports.ensureObservedRunRewardAllocation = ensureObservedRunRewardAllocation.bind(null, ports);
  ports.ensureAbyssalRewardPlan = ensureAbyssalRewardPlan.bind(null, ports);
  Object.freeze(ports);
  return Object.freeze({
    persistAbyssalRewardPlan: ports.persistAbyssalRewardPlan,
    persistObservedRunRewardAllocation: ports.persistObservedRunRewardAllocation,
    ensureObservedRunRewardAllocation: ports.ensureObservedRunRewardAllocation,
    ensureAbyssalRewardPlan: ports.ensureAbyssalRewardPlan,
  });
}

module.exports = { createAbyssalRewardPlans };
