"use strict";

const { normalizeText } = require("../domain/abyssalValueUtils");

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

// Run/room ownership scans and fail-closed cleanup; all state and I/O are injected.
function listAuthoritativeAbyssalRoomRewardArtifacts({
  getDependencies,
  listUniquePositiveInts,
},
  pocketState,
  roomIndex,
  deps = getDependencies(),
  options = {},
) {
  if (!pocketState || typeof deps.listSystemSpaceItems !== "function") {
    return {
      supported: false,
      authoritative: [],
      ambiguous: [],
    };
  }
  const instanceID = toInt(pocketState.instanceID, 0);
  const traceItemID = toInt(pocketState.traceItemID, 0);
  const characterID = toInt(pocketState.characterID, 0);
  const shipID = toInt(pocketState.shipID, 0);
  const solarSystemID = toInt(pocketState.solarSystemID, 0);
  const expectedRole = normalizeText(options.role, "");
  const expectedTypeID = toInt(options.typeID, 0);
  const expectedTypeIDs = listUniquePositiveInts(options.typeIDs);
  if (expectedTypeIDs.length === 0 && expectedTypeID > 0) {
    expectedTypeIDs.push(expectedTypeID);
  }
  const expectedProfileID = normalizeText(options.profileID, "");
  const stateReader = typeof options.stateReader === "function"
    ? options.stateReader
    : null;
  if (
    instanceID <= 0 ||
    traceItemID <= 0 ||
    characterID <= 0 ||
    solarSystemID <= 0 ||
    !expectedRole ||
    !stateReader
  ) {
    return {
      supported: true,
      authoritative: [],
      ambiguous: [],
    };
  }

  let systemItems;
  try {
    systemItems = deps.listSystemSpaceItems(solarSystemID);
  } catch (error) {
    return {
      supported: false,
      errorMsg: normalizeText(error && error.message, "ABYSSAL_REWARD_ARTIFACT_SCAN_FAILED"),
      authoritative: [],
      ambiguous: [],
    };
  }
  const authoritative = [];
  const ambiguous = [];
  for (const item of Array.isArray(systemItems) ? systemItems : []) {
    const state = stateReader(item);
    if (
      !state ||
      normalizeText(state.role, "") !== expectedRole ||
      toInt(state.instanceID, 0) !== instanceID ||
      toInt(state.roomIndex, 0) !== toInt(roomIndex, 0)
    ) {
      continue;
    }
    const itemID = toInt(item && item.itemID, 0);
    const profileID = normalizeText(
      state.cacheProfileID || state.extractionNodeProfileID,
      "",
    );
    const matches = Boolean(
      itemID > 0 &&
      toInt(item && item.ownerID, 0) === characterID &&
      toInt(item && item.locationID, 0) === solarSystemID &&
      expectedTypeIDs.includes(toInt(item && item.typeID, 0)) &&
      toInt(state.traceItemID, 0) === traceItemID &&
      toInt(state.characterID, 0) === characterID &&
      (shipID <= 0 || toInt(state.shipID, 0) === shipID) &&
      toInt(state.solarSystemID, 0) === solarSystemID &&
      (!expectedProfileID || profileID === expectedProfileID) &&
      (
        options.requireSourceStructure !== true ||
        toInt(state.sourceStructureItemID, 0) > 0
      )
    );
    const record = {
      itemID,
      item,
      state,
    };
    if (matches) {
      authoritative.push(record);
    } else {
      ambiguous.push(record);
    }
  }
  const byItemID = (left, right) => left.itemID - right.itemID;
  authoritative.sort(byItemID);
  ambiguous.sort(byItemID);
  return {
    supported: true,
    authoritative,
    ambiguous,
  };
}

function removeDuplicateAbyssalRoomRewardArtifacts({
  getDependencies,
  buildAbyssalSceneDescriptor,
  destroyPlaceholderTrace,
},
  pocketState,
  artifactRecords,
  deps = getDependencies(),
  reason = "reward-artifact-reconciliation",
) {
  const sceneDescriptor = buildAbyssalSceneDescriptor(pocketState, deps);
  return (Array.isArray(artifactRecords) ? artifactRecords : []).map((record) => ({
    itemID: toInt(record && record.itemID, 0),
    result: destroyPlaceholderTrace(
      toInt(pocketState && pocketState.solarSystemID, 0),
      toInt(record && record.itemID, 0),
      deps,
      reason,
      "duplicate Abyssal reward artifact",
      {
        sceneDescriptor: sceneDescriptor || undefined,
      },
    ),
  }));
}

function summarizeAbyssalRewardContainerContents({
  getDependencies,
  resolveInventoryItemLogicalQuantity,
}, containerItemID, deps = getDependencies()) {
  const contents = typeof deps.listContainerItems === "function"
    ? deps.listContainerItems(null, containerItemID, null)
    : [];

  const liveContents = Array.isArray(contents) ? contents : [];

  return {
    contentsGranted: liveContents.some(
      (item) => resolveInventoryItemLogicalQuantity(item) > 0,
    ),
    rewardTypeID: toInt(liveContents[0] && liveContents[0].typeID, 0),
    rewardQuantity: liveContents.reduce(
      (sum, item) => sum + resolveInventoryItemLogicalQuantity(item),
      0,
    ),
  };
}

function failClosedAbyssalRewardArtifactReconciliation({
  getDependencies,
  suppressAbyssalRoomRewards,
  ensureAbyssalPocketPersistenceReady,
  listUniquePositiveInts,
},
  pocketState,
  roomIndex,
  deps = getDependencies(),
  options = {},
) {
  const reconciliationErrorMsg = normalizeText(
    options.errorMsg,
    "ABYSSAL_REWARD_ARTIFACT_RECONCILE_FAILED",
  );
  const suppressionReason = normalizeText(
    options.suppressionReason,
    reconciliationErrorMsg,
  );
  const suppressedPocketState = suppressAbyssalRoomRewards(
    pocketState,
    roomIndex,
    deps,
    suppressionReason,
  ) || pocketState;
  const persistenceResult = ensureAbyssalPocketPersistenceReady(
    suppressedPocketState,
    deps,
  );
  return {
    success: false,
    reconciled: false,
    suppressed: true,
    errorMsg: persistenceResult.success
      ? reconciliationErrorMsg
      : "ABYSSAL_RUN_STATE_PERSIST_FAILED",
    reconciliationErrorMsg,
    suppressionReason,
    persistenceResult,
    failedItemIDs: listUniquePositiveInts(options.failedItemIDs),
    ambiguousItemIDs: listUniquePositiveInts(options.ambiguousItemIDs),
    duplicateRemovalResults: Array.isArray(options.duplicateRemovalResults)
      ? options.duplicateRemovalResults
      : [],
    data: suppressedPocketState,
  };
}

// Capture supplied capabilities once, as the original closure did. Internal
// callbacks are bound once per instance; no runtime state lives in this wiring.
function createAbyssalRewardArtifactReconciliation({
  getDependencies,
  listUniquePositiveInts,
  buildAbyssalSceneDescriptor,
  destroyPlaceholderTrace,
  resolveInventoryItemLogicalQuantity,
  suppressAbyssalRoomRewards,
  ensureAbyssalPocketPersistenceReady,
}) {

  const ports = {
    getDependencies,
    listUniquePositiveInts,
    buildAbyssalSceneDescriptor,
    destroyPlaceholderTrace,
    resolveInventoryItemLogicalQuantity,
    suppressAbyssalRoomRewards,
    ensureAbyssalPocketPersistenceReady,
  };
  ports.listAuthoritativeAbyssalRoomRewardArtifacts = listAuthoritativeAbyssalRoomRewardArtifacts.bind(null, ports);
  ports.removeDuplicateAbyssalRoomRewardArtifacts = removeDuplicateAbyssalRoomRewardArtifacts.bind(null, ports);
  ports.summarizeAbyssalRewardContainerContents = summarizeAbyssalRewardContainerContents.bind(null, ports);
  ports.failClosedAbyssalRewardArtifactReconciliation = failClosedAbyssalRewardArtifactReconciliation.bind(null, ports);
  Object.freeze(ports);
  return Object.freeze({
    listAuthoritativeAbyssalRoomRewardArtifacts: ports.listAuthoritativeAbyssalRoomRewardArtifacts,
    removeDuplicateAbyssalRoomRewardArtifacts: ports.removeDuplicateAbyssalRoomRewardArtifacts,
    summarizeAbyssalRewardContainerContents: ports.summarizeAbyssalRewardContainerContents,
    failClosedAbyssalRewardArtifactReconciliation: ports.failClosedAbyssalRewardArtifactReconciliation,
  });
}

module.exports = { createAbyssalRewardArtifactReconciliation };
