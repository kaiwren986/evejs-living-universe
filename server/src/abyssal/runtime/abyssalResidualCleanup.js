"use strict";

const { normalizeText } = require("../domain/abyssalValueUtils");

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

// Residual removal retains the manager's exact-run authority and retired-capsule gates.
// The low-level destroy operation is used only after the caller establishes authority.
function buildTrackedPocketArtifactIDSet({
  buildPlaceholderRoomState,
}, pocketState) {
  const trackedIDs = new Set();
  if (!pocketState) {
    return trackedIDs;
  }

  const traceItemID = toInt(pocketState.traceItemID, 0);
  if (traceItemID > 0) {
    trackedIDs.add(traceItemID);
  }

  const roomState = buildPlaceholderRoomState(pocketState);
  for (const roomEntry of Object.values(roomState.roomStatesByIndex || {})) {
    for (const itemID of [
      roomEntry && roomEntry.originMarkerItemID,
      roomEntry && roomEntry.conduitItemID,
      roomEntry && roomEntry.cacheItemID,
      roomEntry && roomEntry.cacheStructureItemID,
      roomEntry && roomEntry.cacheLootContainerItemID,
      ...(Array.isArray(roomEntry && roomEntry.extractionNodeItemIDs)
        ? roomEntry.extractionNodeItemIDs
        : []),
      ...(Array.isArray(roomEntry && roomEntry.extractionNodeLootContainerItemIDs)
        ? roomEntry.extractionNodeLootContainerItemIDs
        : []),
      ...(Array.isArray(roomEntry && roomEntry.rewardSuppressionPendingRemovalItemIDs)
        ? roomEntry.rewardSuppressionPendingRemovalItemIDs
        : []),
      ...(Array.isArray(roomEntry && roomEntry.environmentalObjectItemIDs)
        ? roomEntry.environmentalObjectItemIDs
        : []),
    ]) {
      const numericItemID = toInt(itemID, 0);
      if (numericItemID > 0) {
        trackedIDs.add(numericItemID);
      }
    }
  }

  return trackedIDs;
}

function destroyResidualPocketSpaceItem({
  usesIsolatedAbyssalScene,
  buildAbyssalSceneDescriptor,
  log,
}, pocketState, itemID, deps, reason = "cleanup") {
  const numericSystemID = toInt(pocketState && pocketState.solarSystemID, 0);
  const numericItemID = toInt(itemID, 0);
  if (numericItemID <= 0) {
    return {
      success: true,
      removed: false,
      alreadyGone: true,
      failed: false,
      itemID: 0,
      errorMsg: "ITEM_ID_MISSING",
    };
  }

  const runtime = deps;
  const isolatedScene = usesIsolatedAbyssalScene(pocketState, deps);
  const sceneDescriptor = isolatedScene
    ? buildAbyssalSceneDescriptor(pocketState, deps)
    : null;
  if (isolatedScene && !sceneDescriptor) {
    return {
      success: false,
      removed: false,
      alreadyGone: false,
      failed: true,
      itemID: numericItemID,
      errorMsg: "ABYSSAL_RESIDUAL_SCENE_DESCRIPTOR_INVALID",
    };
  }
  let runtimeErrorMsg = "";
  if (runtime && typeof runtime.destroyDynamicInventoryEntity === "function") {
    const destroyResult = runtime.destroyDynamicInventoryEntity(
      sceneDescriptor || numericSystemID,
      numericItemID,
      {
        sceneDescriptor: sceneDescriptor || undefined,
        suppressAbyssalRewardMaterialization: true,
        removeContents: true,
        reason,
      },
    );
    if (destroyResult && destroyResult.success) {
      return {
        success: true,
        removed: true,
        alreadyGone: false,
        failed: false,
        itemID: numericItemID,
      };
    }
    runtimeErrorMsg = normalizeText(destroyResult && destroyResult.errorMsg, "");
  }

  const existingItem = typeof deps.findItemById === "function"
    ? deps.findItemById(numericItemID)
    : null;
  if (!existingItem) {
    return {
      success: true,
      removed: false,
      alreadyGone: true,
      failed: false,
      itemID: numericItemID,
      errorMsg: "ITEM_NOT_FOUND",
    };
  }

  const removeResult = deps.removeInventoryItem(numericItemID, { removeContents: true });
  if (removeResult && removeResult.success) {
    return {
      success: true,
      removed: true,
      alreadyGone: false,
      failed: false,
      itemID: numericItemID,
    };
  }

  log.warn(
    `[AbyssalMgr] Failed to remove residual pocket item itemID=${numericItemID} system=${numericSystemID} ` +
      `reason=${reason} runtimeError=${runtimeErrorMsg || "REMOVE_FAILED"} ` +
      `inventoryError=${normalizeText(removeResult && removeResult.errorMsg, "REMOVE_FAILED")}`,
  );
  return {
    success: false,
    removed: false,
    alreadyGone: false,
    failed: true,
    itemID: numericItemID,
    errorMsg: normalizeText(removeResult && removeResult.errorMsg, "REMOVE_FAILED"),
  };
}

function createAbyssalResidualCleanupSummary({}) {
  return {
    removedResidualSpaceItems: 0,
    residualSpaceItemsAlreadyGone: 0,
    failedResidualSpaceItems: 0,
    diagnosticSkippedResidualSpaceItems: 0,
    removedRunScopedCorpses: 0,
    runScopedCorpsesAlreadyGone: 0,
    failedRunScopedCorpses: 0,
    removedRunScopedCapsules: 0,
    runScopedCapsulesAlreadyGone: 0,
    failedRunScopedCapsules: 0,
  };
}

function cleanupResidualPocketSpaceItems({
  createAbyssalResidualCleanupSummary,
  listPocketCleanupAnchors,
  buildTrackedPocketArtifactIDSet,
  getAbyssalTimeoutState,
  hasTerminalFailureOutcome,
  CATEGORY_SHIP,
  listUniquePositiveInts,
  isCapsuleTypeID,
  isItemWithinPocketCleanupAnchors,
  inspectResidualPocketItemAuthority,
  isCorpseType,
  destroyResidualPocketSpaceItem,
  log,
}, pocketState, deps, reason = "cleanup") {
  const systemID = toInt(pocketState && pocketState.solarSystemID, 0);
  if (systemID <= 0 || typeof deps.listSystemSpaceItems !== "function") {
    return {
      removedItemIDs: [],
      cleanupSummary: createAbyssalResidualCleanupSummary(),
      diagnostics: [],
    };
  }

  const cleanupAnchors = listPocketCleanupAnchors(pocketState);
  const trackedArtifactIDs = buildTrackedPocketArtifactIDSet(pocketState);
  const removedItemIDs = [];
  const cleanupSummary = createAbyssalResidualCleanupSummary();
  const timeoutState = getAbyssalTimeoutState(pocketState, deps);
  const participantCharacterID = toInt(pocketState && pocketState.characterID, 0);
  const characterRecord =
    participantCharacterID > 0 && typeof deps.getCharacterRecord === "function"
      ? deps.getCharacterRecord(participantCharacterID)
      : null;
  const currentCharacterShipID = toInt(characterRecord && characterRecord.shipID, 0);
  const terminalCapsuleCleanupAuthorized = Boolean(
    hasTerminalFailureOutcome(pocketState) &&
    timeoutState.shipDestroyed === true &&
    timeoutState.podDestroyed === true &&
    participantCharacterID > 0 &&
    currentCharacterShipID > 0
  );
  const diagnostics = [];
  const spaceItems = Array.isArray(deps.listSystemSpaceItems(systemID))
    ? deps.listSystemSpaceItems(systemID)
    : [];
  for (const item of spaceItems) {
    const itemID = toInt(item && item.itemID, 0);
    if (itemID <= 0 || trackedArtifactIDs.has(itemID)) {
      continue;
    }
    if (itemID === toInt(pocketState && pocketState.shipID, 0)) {
      continue;
    }
    const itemIsShip = toInt(item && item.categoryID, 0) === CATEGORY_SHIP;
    let runScopedCapsule = false;
    if (itemIsShip) {
      const ownerIDs = listUniquePositiveInts([
        item && item.ownerID,
        item && item.characterID,
        item && item.pilotCharacterID,
      ]);
      runScopedCapsule = Boolean(
        terminalCapsuleCleanupAuthorized &&
        isCapsuleTypeID(toInt(item && item.typeID, 0)) &&
        itemID !== currentCharacterShipID &&
        ownerIDs.length === 1 &&
        ownerIDs[0] === participantCharacterID
      );
      if (!runScopedCapsule) {
        continue;
      }
    }
    const withinCleanupAnchor = isItemWithinPocketCleanupAnchors(item, cleanupAnchors);
    const authority = inspectResidualPocketItemAuthority(item, pocketState, cleanupAnchors);
    if (authority.authorized !== true) {
      if (
        withinCleanupAnchor ||
        (Array.isArray(authority.runIDs) && authority.runIDs.length > 0) ||
        (Array.isArray(authority.roomIndexes) && authority.roomIndexes.length > 0)
      ) {
        diagnostics.push({
          itemID,
          reason: authority.reason,
          runIDs: authority.runIDs,
          roomIndexes: authority.roomIndexes,
        });
        cleanupSummary.diagnosticSkippedResidualSpaceItems += 1;
      }
      continue;
    }
    const runScopedCorpse = isCorpseType(item);
    const removeResult = destroyResidualPocketSpaceItem(pocketState, itemID, deps, reason);
    if (removeResult.removed === true) {
      removedItemIDs.push(itemID);
      cleanupSummary.removedResidualSpaceItems += 1;
      if (runScopedCorpse) {
        cleanupSummary.removedRunScopedCorpses += 1;
      }
      if (runScopedCapsule) {
        cleanupSummary.removedRunScopedCapsules += 1;
      }
    } else if (removeResult.alreadyGone === true) {
      cleanupSummary.residualSpaceItemsAlreadyGone += 1;
      if (runScopedCorpse) {
        cleanupSummary.runScopedCorpsesAlreadyGone += 1;
      }
      if (runScopedCapsule) {
        cleanupSummary.runScopedCapsulesAlreadyGone += 1;
      }
    } else if (removeResult.failed === true) {
      cleanupSummary.failedResidualSpaceItems += 1;
      if (runScopedCorpse) {
        cleanupSummary.failedRunScopedCorpses += 1;
      }
      if (runScopedCapsule) {
        cleanupSummary.failedRunScopedCapsules += 1;
      }
    }
  }

  if (diagnostics.length > 0) {
    log.warn(
      `[AbyssalCleanupIsolation] run=${toInt(pocketState && pocketState.instanceID, 0)} ` +
        `sceneKey=${normalizeText(pocketState && pocketState.sceneKey, "none")} ` +
        `diagnosticOnly=${diagnostics.length} entries=${diagnostics
          .map((entry) => `${entry.itemID}:${entry.reason}`)
          .join(",")}`,
    );
  }

  return {
    removedItemIDs,
    cleanupSummary,
    diagnostics,
  };
}

// Capture supplied capabilities once, as the original closure did. Internal
// callbacks are bound once per instance; no runtime state lives in this wiring.
function createAbyssalResidualCleanup({
  buildPlaceholderRoomState,
  usesIsolatedAbyssalScene,
  buildAbyssalSceneDescriptor,
  log,
  listPocketCleanupAnchors,
  getAbyssalTimeoutState,
  hasTerminalFailureOutcome,
  CATEGORY_SHIP,
  listUniquePositiveInts,
  isCapsuleTypeID,
  isItemWithinPocketCleanupAnchors,
  inspectResidualPocketItemAuthority,
  isCorpseType,
}) {

  const ports = {
    buildPlaceholderRoomState,
    usesIsolatedAbyssalScene,
    buildAbyssalSceneDescriptor,
    log,
    listPocketCleanupAnchors,
    getAbyssalTimeoutState,
    hasTerminalFailureOutcome,
    CATEGORY_SHIP,
    listUniquePositiveInts,
    isCapsuleTypeID,
    isItemWithinPocketCleanupAnchors,
    inspectResidualPocketItemAuthority,
    isCorpseType,
  };
  ports.buildTrackedPocketArtifactIDSet = buildTrackedPocketArtifactIDSet.bind(null, ports);
  ports.destroyResidualPocketSpaceItem = destroyResidualPocketSpaceItem.bind(null, ports);
  ports.createAbyssalResidualCleanupSummary = createAbyssalResidualCleanupSummary.bind(null, ports);
  ports.cleanupResidualPocketSpaceItems = cleanupResidualPocketSpaceItems.bind(null, ports);
  Object.freeze(ports);
  return { buildTrackedPocketArtifactIDSet: ports.buildTrackedPocketArtifactIDSet, destroyResidualPocketSpaceItem: ports.destroyResidualPocketSpaceItem, cleanupResidualPocketSpaceItems: ports.cleanupResidualPocketSpaceItems };
}

module.exports = { createAbyssalResidualCleanup };
