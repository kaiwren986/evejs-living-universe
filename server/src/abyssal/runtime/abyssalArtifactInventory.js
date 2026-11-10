"use strict";

const { normalizeText } = require("../domain/abyssalValueUtils");

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

// Shared inventory-backed trace/cache/environment removal and client sync.
// The historical destroyPlaceholderTrace name stays as a compatibility binding;
// exact ownership checks and trace-index cleanup remain explicit injected seams.
function syncInventoryChanges({
  getDependencies,
}, session, changes = [], deps = getDependencies()) {
  if (!session) {
    return;
  }
  const syncInventoryItemForSession = deps.syncInventoryItemForSession;
  if (typeof syncInventoryItemForSession !== "function") {
    return;
  }

  for (const change of Array.isArray(changes) ? changes : []) {
    if (!change || !change.item) {
      continue;
    }
    syncInventoryItemForSession(
      session,
      change.item,
      change.previousData || {},
      { emitCfgLocation: true },
    );
  }
}

function destroyPlaceholderTrace({
  inspectResidualPocketItemAuthority,
  listPocketCleanupAnchors,
  log,
  unregisterTrace,
},
  systemID,
  traceItemID,
  deps,
  reason = "cleanup",
  itemLabel = "Abyssal trace",
  options = {},
) {
  const numericSystemID = toInt(systemID, 0);
  const numericTraceItemID = toInt(traceItemID, 0);
  if (numericTraceItemID <= 0) {
    return {
      success: true,
      removed: false,
      alreadyGone: true,
      failed: false,
      itemID: 0,
      itemLabel,
      reason,
      removalPath: null,
      errorMsg: "ITEM_ID_MISSING",
    };
  }

  const buildResult = (overrides = {}) => ({
    success: overrides.failed !== true,
    removed: overrides.removed === true,
    alreadyGone: overrides.alreadyGone === true,
    failed: overrides.failed === true,
    itemID: numericTraceItemID,
    itemLabel,
    reason,
    removalPath: overrides.removalPath || null,
    errorMsg: normalizeText(overrides.errorMsg, ""),
    identityRejected: overrides.identityRejected === true,
  });
  const expectedPocketState =
    options.expectedPocketState && typeof options.expectedPocketState === "object"
      ? options.expectedPocketState
      : null;
  const existingItemBeforeRemoval = typeof deps.findItemById === "function"
    ? deps.findItemById(numericTraceItemID)
    : null;
  if (existingItemBeforeRemoval && expectedPocketState) {
    const authority = inspectResidualPocketItemAuthority(
      existingItemBeforeRemoval,
      expectedPocketState,
      listPocketCleanupAnchors(expectedPocketState),
    );
    if (!authority.authorized) {
      log.error(
        `[AbyssalCleanupIdentity] refusing item=${numericTraceItemID} ` +
          `instance=${toInt(expectedPocketState.instanceID, 0)} label=${itemLabel} ` +
          `reason=${normalizeText(authority.reason, "IDENTITY_NOT_AUTHORIZED")}`,
      );
      return buildResult({
        failed: true,
        identityRejected: true,
        errorMsg: `ABYSSAL_CLEANUP_IDENTITY_${normalizeText(
          authority.reason,
          "NOT_AUTHORIZED",
        )}`,
      });
    }
  }
  const runtime = deps;
  const sceneDescriptor =
    options.sceneDescriptor && typeof options.sceneDescriptor === "object"
      ? options.sceneDescriptor
      : null;
  let runtimeErrorMsg = "";
  if (typeof runtime.destroyDynamicInventoryEntity === "function") {
    const destroyResult = runtime.destroyDynamicInventoryEntity(
      sceneDescriptor || numericSystemID,
      numericTraceItemID,
      {
        sceneDescriptor: sceneDescriptor || undefined,
        suppressAbyssalRewardMaterialization: true,
        broadcast: options.broadcast !== false,
        reason,
      },
    );
    if (destroyResult && destroyResult.success) {
      if (options.unregisterTrace !== false) {
        unregisterTrace(numericTraceItemID);
      }
      return buildResult({
        removed: true,
        removalPath: "runtime",
      });
    }
    runtimeErrorMsg = normalizeText(destroyResult && destroyResult.errorMsg, "");
  }

  const existingItem = existingItemBeforeRemoval || (
    typeof deps.findItemById === "function"
      ? deps.findItemById(numericTraceItemID)
      : null
  );
  if (!existingItem) {
    if (options.unregisterTrace !== false) {
      unregisterTrace(numericTraceItemID);
    }
    return buildResult({
      alreadyGone: true,
      errorMsg: "ITEM_NOT_FOUND",
    });
  }

  const removeResult = deps.removeInventoryItem(numericTraceItemID, { removeContents: true });
  if (removeResult && removeResult.success) {
    if (options.unregisterTrace !== false) {
      unregisterTrace(numericTraceItemID);
    }
    return buildResult({
      removed: true,
      removalPath: "inventory",
    });
  }

  log.warn(
    `[AbyssalMgr] Failed to remove ${itemLabel} itemID=${numericTraceItemID} system=${numericSystemID} ` +
      `reason=${reason} runtimeError=${runtimeErrorMsg || "REMOVE_FAILED"} ` +
      `inventoryError=${normalizeText(removeResult && removeResult.errorMsg, "REMOVE_FAILED")}`,
  );
  return buildResult({
    failed: true,
    errorMsg: normalizeText(removeResult && removeResult.errorMsg, "REMOVE_FAILED"),
  });
}

function createAbyssalArtifactInventory({
  getDependencies,
  inspectResidualPocketItemAuthority,
  listPocketCleanupAnchors,
  unregisterTrace,
  log,
}) {

  const ports = {
    getDependencies,
    inspectResidualPocketItemAuthority,
    listPocketCleanupAnchors,
    unregisterTrace,
    log,
  };
  ports.syncInventoryChanges = syncInventoryChanges.bind(null, ports);
  ports.destroyPlaceholderTrace = destroyPlaceholderTrace.bind(null, ports);
  Object.freeze(ports);
  return Object.freeze({ syncInventoryChanges: ports.syncInventoryChanges, destroyPlaceholderTrace: ports.destroyPlaceholderTrace });
}

module.exports = { createAbyssalArtifactInventory };
