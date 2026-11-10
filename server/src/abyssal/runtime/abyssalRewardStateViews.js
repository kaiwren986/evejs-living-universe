"use strict";
const { toInt, normalizeText } = require("../domain/abyssalRuntimeValues");

function getRewardState(ports, pocketState) {
  const {
    cloneValue,
    getPlaceholderRoomEntry,
  } = ports;
  if (pocketState && pocketState.rewardState && typeof pocketState.rewardState === "object") {
    return cloneValue(pocketState.rewardState);
  }
  const currentRoomEntry = getPlaceholderRoomEntry(pocketState);
  if (
    currentRoomEntry.cacheItemID > 0 ||
    currentRoomEntry.cacheStructureItemID > 0 ||
    currentRoomEntry.cacheLootContainerItemID > 0 ||
    currentRoomEntry.cacheSpawnedAtMs > 0 ||
    currentRoomEntry.unavailableReason ||
    currentRoomEntry.suppressedReason
  ) {
    return {
      cacheItemID: toInt(currentRoomEntry.cacheItemID, 0),
      cacheStructureItemID: toInt(currentRoomEntry.cacheStructureItemID, 0),
      cacheLootContainerItemID: toInt(currentRoomEntry.cacheLootContainerItemID, 0),
      cacheRewardPlan:
        currentRoomEntry.cacheRewardPlan && typeof currentRoomEntry.cacheRewardPlan === "object"
          ? cloneValue(currentRoomEntry.cacheRewardPlan)
          : null,
      cacheRewardMaterialized: currentRoomEntry.cacheRewardMaterialized === true,
      cacheSpawnedAtMs: toInt(currentRoomEntry.cacheSpawnedAtMs, 0),
      cacheLifecycleState: normalizeText(currentRoomEntry.cacheLifecycleState, ""),
      unavailableReason: normalizeText(currentRoomEntry.unavailableReason, ""),
      suppressedReason: normalizeText(currentRoomEntry.suppressedReason, ""),
      rewardTypeID: toInt(currentRoomEntry.rewardTypeID, 0),
      rewardQuantity: toInt(currentRoomEntry.rewardQuantity, 0),
      contentsGranted: currentRoomEntry.contentsGranted === true,
    };
  }
  return null;
}

function getRewardCacheItemID(ports, pocketState) {
  return toInt(
    getRewardState(ports, pocketState) &&
      getRewardState(ports, pocketState).cacheItemID,
    0,
  );
}

function createAbyssalRewardStateViews(ports) {
  return {
    getRewardState: getRewardState.bind(null, ports),
    getRewardCacheItemID: getRewardCacheItemID.bind(null, ports),
  };
}

module.exports = { createAbyssalRewardStateViews };
