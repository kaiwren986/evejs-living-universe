"use strict";

const { createAbyssalRewardMaterializationExecutor } = require("./abyssalRewardMaterializationExecutor");
const { normalizeText } = require("../domain/abyssalValueUtils");

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

// Physical reward-container operations over the current engine port. Room reward
// selection, plans, progression and reconciliation policy remain explicit caller
// responsibilities. No module state or manager/runtime imports are retained.
function resolveRewardContainerType({
  getDependencies,
  TYPE_CAPTURED_TRIGLAVIAN_BIOADAPTIVE_CACHE,
  TYPE_ABYSSAL_BIOCOMBINATIVE_CACHE,
  TYPE_ABYSSAL_BIOCOMBINATIVE_CACHE_WRECK,
  TYPE_CAPTURED_TRIGLAVIAN_BIOADAPTIVE_CACHE_WRECK,
  resolveAbyssalStructureType,
}, cacheProfile, deps = getDependencies()) {
  const cacheTypeID = toInt(
    cacheProfile && cacheProfile.cacheTypeID,
    TYPE_CAPTURED_TRIGLAVIAN_BIOADAPTIVE_CACHE,
  );
  const fallbackWreckTypeID = cacheTypeID === TYPE_ABYSSAL_BIOCOMBINATIVE_CACHE
    ? TYPE_ABYSSAL_BIOCOMBINATIVE_CACHE_WRECK
    : TYPE_CAPTURED_TRIGLAVIAN_BIOADAPTIVE_CACHE_WRECK;
  const wreckTypeID = toInt(
    cacheProfile && cacheProfile.wreckTypeID,
    fallbackWreckTypeID,
  );
  return resolveAbyssalStructureType(wreckTypeID, deps);
}

function resolveExtractionNodeContainerType({
  getDependencies,
  TYPE_ABYSSAL_EXTRACTION_SUBNODE,
  TYPE_ABYSSAL_EXTRACTION_SUBNODE_WRECK,
  TYPE_ABYSSAL_EXTRACTION_NODE_WRECK,
  resolveAbyssalStructureType,
},
  extractionNodeProfileOrSourceTypeID,
  deps = getDependencies(),
) {
  const sourceStructureTypeID = toInt(extractionNodeProfileOrSourceTypeID, 0);
  const authoredWreckTypeID = toInt(
    extractionNodeProfileOrSourceTypeID &&
      extractionNodeProfileOrSourceTypeID.wreckTypeID,
    0,
  );
  const wreckTypeID = authoredWreckTypeID > 0
    ? authoredWreckTypeID
    : sourceStructureTypeID === TYPE_ABYSSAL_EXTRACTION_SUBNODE
      ? TYPE_ABYSSAL_EXTRACTION_SUBNODE_WRECK
      : TYPE_ABYSSAL_EXTRACTION_NODE_WRECK;
  return resolveAbyssalStructureType(wreckTypeID, deps);
}

function resolveAbyssalStructureType({
  getDependencies,
}, typeID, deps = getDependencies()) {
  const numericTypeID = toInt(typeID, 0);
  return numericTypeID > 0 && typeof deps.resolveItemByTypeID === "function"
    ? deps.resolveItemByTypeID(numericTypeID)
    : null;
}

function resolveRewardLootType({
  getDependencies,
}, rewardEntry, deps = getDependencies()) {
  const rewardTypeID = toInt(rewardEntry && rewardEntry.itemTypeID, 0);
  if (rewardTypeID > 0 && typeof deps.resolveItemByTypeID === "function") {
    const typeRecord = deps.resolveItemByTypeID(rewardTypeID);
    if (typeRecord) {
      return typeRecord;
    }
  }
  const lookup = deps.resolveItemByName &&
    deps.resolveItemByName(rewardEntry && rewardEntry.itemName);
  return lookup && lookup.success && lookup.match ? lookup.match : null;
}

function resolveAbyssalRewardGrantManifest({
  getDependencies,
  resolveRewardLootType,
  CATEGORY_BLUEPRINT,
}, lootEntries, deps = getDependencies()) {
  const entries = Array.isArray(lootEntries) ? lootEntries : [];
  if (entries.length <= 0) {
    return {
      success: false,
      errorMsg: "REWARD_MANIFEST_EMPTY",
    };
  }
  const grantEntries = [];
  const manifestByTypeID = new Map();
  let rewardTypeID = 0;
  let rewardQuantity = 0;
  for (const rewardEntry of entries) {
    const rewardType = resolveRewardLootType(rewardEntry, deps);
    const typeID = Number(rewardType && rewardType.typeID);
    const quantity = Number(rewardEntry && rewardEntry.quantity);
    if (!Number.isSafeInteger(typeID) || typeID <= 0) {
      return {
        success: false,
        errorMsg: "REWARD_TYPE_NOT_FOUND",
      };
    }
    if (!Number.isSafeInteger(quantity) || quantity <= 0) {
      return {
        success: false,
        errorMsg: "REWARD_QUANTITY_INVALID",
      };
    }
    const combinedTypeQuantity = (manifestByTypeID.get(typeID) || 0) + quantity;
    const combinedRewardQuantity = rewardQuantity + quantity;
    if (
      !Number.isSafeInteger(combinedTypeQuantity) ||
      !Number.isSafeInteger(combinedRewardQuantity)
    ) {
      return {
        success: false,
        errorMsg: "REWARD_QUANTITY_INVALID",
      };
    }
    manifestByTypeID.set(typeID, combinedTypeQuantity);
    rewardTypeID = rewardTypeID || typeID;
    rewardQuantity = combinedRewardQuantity;
    const isBlueprintCopy =
      toInt(rewardType && rewardType.categoryID, 0) === CATEGORY_BLUEPRINT;
    grantEntries.push({
      itemType: rewardType,
      quantity,
      ...(isBlueprintCopy
        ? {
            options: {
              singleton: 2,
              individualItems: true,
            },
          }
        : {}),
    });
  }
  return {
    success: true,
    grantEntries,
    blueprintCopies: grantEntries
      .filter((entry) => entry && entry.options && entry.options.singleton === 2)
      .map((entry) => ({
        typeID: toInt(entry.itemType && entry.itemType.typeID, 0),
        quantity: toInt(entry.quantity, 0),
      })),
    manifest: [...manifestByTypeID.entries()]
      .map(([typeID, quantity]) => ({ typeID, quantity }))
      .sort((left, right) => left.typeID - right.typeID),
    rewardTypeID,
    rewardQuantity,
  };
}

function buildAbyssalRewardManifestReceiptKey({},
  pocketState,
  roomIndex,
  containerItemID,
  sourceStructureItemID = 0,
) {
  const sourceItemID = toInt(sourceStructureItemID, 0);
  return [
    "abyssal-reward-manifest",
    toInt(pocketState && pocketState.instanceID, 0),
    toInt(roomIndex, 0),
    sourceItemID > 0 ? `source-${sourceItemID}` : `container-${toInt(containerItemID, 0)}`,
  ].join(":");
}

function resolveInventoryItemLogicalQuantity({}, item) {
  if (!item || typeof item !== "object") {
    return 0;
  }

  const singleton = toInt(item.singleton, 0);
  const quantity = toInt(item.quantity, 0);
  const stacksize = toInt(item.stacksize, 0);

  // Eve inventory singleton rows encode packaging state in quantity:
  //
  // singleton = 1 -> quantity = -1
  // singleton = 2 -> quantity = -2 (for example blueprint copies)
  //
  // They still represent one logical inventory unit per row.
  if (
    singleton > 0 ||
    quantity === -1 ||
    quantity === -2
  ) {
    return stacksize > 0 ? stacksize : 1;
  }

  if (quantity > 0) {
    return quantity;
  }

  // Negative non-singleton quantities are not valid logical reward amounts.
  // Do not let an unrelated positive stacksize make a corrupt row appear
  // grantable; only the recognized singleton sentinels above are normalized.
  if (quantity < 0) {
    return 0;
  }

  if (stacksize > 0) {
    return stacksize;
  }

  return 0;
}

function inspectAbyssalRewardContainerManifest({
  getDependencies,
  resolveInventoryItemLogicalQuantity,
},
  containerItemID,
  expectedManifest,
  ownerID,
  deps = getDependencies(),
) {
  if (typeof deps.listContainerItems !== "function") {
    return {
      supported: false,
      exact: false,
      empty: false,
      errorMsg: "REWARD_CONTAINER_CONTENT_SCAN_UNAVAILABLE",
      actualManifest: [],
    };
  }
  const contents = deps.listContainerItems(null, containerItemID, null);
  if (!Array.isArray(contents)) {
    return {
      supported: false,
      exact: false,
      empty: false,
      errorMsg: "REWARD_CONTAINER_CONTENT_SCAN_FAILED",
      actualManifest: [],
    };
  }
  const actualByTypeID = new Map();
  let invalidContents = false;
  for (const item of contents) {
    const typeID = Number(item && item.typeID);
    const quantity = resolveInventoryItemLogicalQuantity(item);
    const itemOwnerID = Number(item && item.ownerID);
    const flagID = Number(item && item.flagID) || 0;
    if (
      !Number.isSafeInteger(typeID) ||
      typeID <= 0 ||
      !Number.isSafeInteger(quantity) ||
      quantity <= 0 ||
      itemOwnerID !== Number(ownerID) ||
      flagID !== 0
    ) {
      invalidContents = true;
      continue;
    }
    const combinedQuantity = (actualByTypeID.get(typeID) || 0) + quantity;
    if (!Number.isSafeInteger(combinedQuantity)) {
      invalidContents = true;
      continue;
    }
    actualByTypeID.set(typeID, combinedQuantity);
  }
  const actualManifest = [...actualByTypeID.entries()]
    .map(([typeID, quantity]) => ({ typeID, quantity }))
    .sort((left, right) => left.typeID - right.typeID);
  const normalizedExpectedManifest = (Array.isArray(expectedManifest)
    ? expectedManifest
    : [])
    .map((entry) => ({
      typeID: toInt(entry && entry.typeID, 0),
      quantity: toInt(entry && entry.quantity, 0),
    }))
    .sort((left, right) => left.typeID - right.typeID);
  return {
    supported: true,
    exact: !invalidContents &&
      JSON.stringify(actualManifest) === JSON.stringify(normalizedExpectedManifest),
    empty: contents.length === 0,
    invalidContents,
    actualManifest,
    expectedManifest: normalizedExpectedManifest,
    contents,
  };
}

function isTerminalAbyssalRewardMaterializationError({}, errorMsg) {
  return new Set([
    "CONTAINER_TYPE_NOT_FOUND",
    "ITEM_TYPE_NOT_FOUND",
    "ITEM_QUANTITY_OUT_OF_RANGE",
    "IDEMPOTENCY_RECEIPT_MISMATCH",
    "REWARD_CONTAINER_MANIFEST_MISMATCH",
    "ABYSSAL_REWARD_RETRY_CONTAINER_AMBIGUOUS",
    "ABYSSAL_REWARD_RETRY_CONTAINER_IDENTITY_MISMATCH",
    "BLUEPRINT_COPY_STATE_UNAVAILABLE",
    "BLUEPRINT_COPY_STATE_FAILED",
  ]).has(normalizeText(errorMsg, ""));
}

function applyAbyssalBlueprintCopyStates({
  getDependencies,
  ABYSSAL_BLUEPRINT_COPY_MIN_RUNS,
  ABYSSAL_BLUEPRINT_COPY_MAX_RUNS,
  nextAbyssalLootRandom,
},
  grantResult,
  manifestResult,
  deps = getDependencies(),
) {
  const blueprintCopies = Array.isArray(manifestResult && manifestResult.blueprintCopies)
    ? manifestResult.blueprintCopies
    : [];
  if (blueprintCopies.length <= 0) {
    return { success: true, updatedItemIDs: [] };
  }
  if (typeof deps.updateBlueprintState !== "function") {
    return {
      success: false,
      errorMsg: "BLUEPRINT_COPY_STATE_UNAVAILABLE",
      updatedItemIDs: [],
    };
  }
  const grantedItems = grantResult && grantResult.data && Array.isArray(grantResult.data.items)
    ? grantResult.data.items
    : [];
  const expectedBlueprintCount = blueprintCopies.reduce(
    (total, entry) => total + Math.max(0, toInt(entry && entry.quantity, 0)),
    0,
  );
  const blueprintTypeIDs = new Set(
    blueprintCopies.map((entry) => toInt(entry && entry.typeID, 0)).filter((typeID) => typeID > 0),
  );
  const blueprintItems = grantedItems.filter((item) =>
    blueprintTypeIDs.has(toInt(item && item.typeID, 0))
  );
  if (blueprintItems.length !== expectedBlueprintCount) {
    return {
      success: false,
      errorMsg: "BLUEPRINT_COPY_STATE_UNAVAILABLE",
      updatedItemIDs: [],
      expectedBlueprintCount,
      actualBlueprintCount: blueprintItems.length,
    };
  }

  const updatedItemIDs = [];
  for (const grantedItem of blueprintItems) {
    const grantedItemID = toInt(grantedItem && grantedItem.itemID, 0);
    const typeID = toInt(grantedItem && grantedItem.typeID, 0);
    if (grantedItemID <= 0 || typeID <= 0) {
      return {
        success: false,
        errorMsg: "BLUEPRINT_COPY_STATE_FAILED",
        updatedItemIDs,
      };
    }
    const buildCopyState = (state) => {
      const existingRuns = toInt(state && state.runsRemaining, 0);
      const licensedRuns =
        state && state.original === false &&
        existingRuns >= ABYSSAL_BLUEPRINT_COPY_MIN_RUNS &&
        existingRuns <= ABYSSAL_BLUEPRINT_COPY_MAX_RUNS
          ? existingRuns
          : ABYSSAL_BLUEPRINT_COPY_MIN_RUNS +
            Math.floor(
              nextAbyssalLootRandom(deps) *
                (
                  ABYSSAL_BLUEPRINT_COPY_MAX_RUNS -
                  ABYSSAL_BLUEPRINT_COPY_MIN_RUNS +
                  1
                ),
            );
      return {
        ...state,
        typeID,
        materialEfficiency: 0,
        timeEfficiency: 0,
        original: false,
        runsRemaining: licensedRuns,
        jobID: null,
      };
    };
    let stateResult = deps.updateBlueprintState(
      grantedItemID,
      buildCopyState,
    );
    if (
      (!stateResult || stateResult.success === false) &&
      normalizeText(stateResult && stateResult.errorMsg, "") ===
        "BLUEPRINT_NOT_FOUND"
    ) {
      if (typeof deps.initializeBlueprintState !== "function") {
        return {
          success: false,
          errorMsg: "BLUEPRINT_COPY_STATE_UNAVAILABLE",
          updatedItemIDs,
        };
      }
      stateResult = deps.initializeBlueprintState(
        grantedItemID,
        buildCopyState(null),
      );
    }
    if (!stateResult || stateResult.success === false) {
      return {
        success: false,
        errorMsg: normalizeText(
          stateResult && stateResult.errorMsg,
          "BLUEPRINT_COPY_STATE_FAILED",
        ),
        updatedItemIDs,
      };
    }
    updatedItemIDs.push(grantedItemID);
  }
  return { success: true, updatedItemIDs };
}

function cleanupAbyssalBlueprintCopyStates({
  getDependencies,
  listUniquePositiveInts,
}, itemIDs, deps = getDependencies()) {
  if (typeof deps.removeBlueprintState !== "function") {
    return;
  }
  for (const itemID of listUniquePositiveInts(itemIDs)) {
    deps.removeBlueprintState(itemID);
  }
}

function materializeAbyssalRewardStructureWreck({
  getDependencies,
  parseCustomInfo,
  resolveAbyssalRewardGrantManifest,
  ensureAbyssalPocketPersistenceReady,
  createRewardStructureWreck,
},
  pocketState,
  roomIndex,
  containerType,
  lootEntries,
  spawnState,
  customInfo,
  session = null,
  deps = getDependencies(),
) {
  if (!containerType) {
    return {
      success: false,
      retryable: false,
      errorMsg: "CONTAINER_TYPE_NOT_FOUND",
    };
  }
  const parsedCustomInfo = parseCustomInfo(customInfo);
  const extractionRewardState = parsedCustomInfo && parsedCustomInfo.evejsAbyssalExtractionNode;
  const rewardCacheState = parsedCustomInfo && parsedCustomInfo.evejsAbyssalRewardCache;
  const allowsEmptyManifest = Boolean(
    (
      extractionRewardState &&
      normalizeText(extractionRewardState.role, "") === "extraction_node_loot_container"
    ) || (
      rewardCacheState &&
      normalizeText(rewardCacheState.role, "") === "cache_loot_container" &&
      rewardCacheState.allowEmptyManifest === true
    )
  );
  const normalizedLootEntries = Array.isArray(lootEntries) ? lootEntries : [];
  const manifestResult = allowsEmptyManifest && normalizedLootEntries.length === 0
    ? {
        success: true,
        grantEntries: [],
        blueprintCopies: [],
        manifest: [],
        rewardTypeID: 0,
        rewardQuantity: 0,
      }
    : resolveAbyssalRewardGrantManifest(normalizedLootEntries, deps);
  if (!manifestResult.success) {
    return { ...manifestResult, retryable: false };
  }
  if (
    manifestResult.grantEntries.length > 0 &&
    typeof deps.grantItemsToOwnerLocationIdempotent !== "function"
  ) {
    return {
      success: false,
      retryable: false,
      errorMsg: "REWARD_BATCH_GRANT_UNAVAILABLE",
    };
  }
  const persistenceResult = ensureAbyssalPocketPersistenceReady(pocketState, deps);
  if (!persistenceResult.success) {
    return {
      success: false,
      retryable: true,
      errorMsg: "ABYSSAL_RUN_STATE_PERSIST_FAILED",
      persistenceResult,
    };
  }
  return createRewardStructureWreck({
    pocketState,
    roomIndex,
    containerType,
    spawnState,
    customInfo,
    session,
    deps,
    parsedCustomInfo,
    manifestResult,
  });
}

function createRewardStructureWreck({
  resolveAbyssalStructureType,
  TYPE_CAPTURED_TRIGLAVIAN_BIOADAPTIVE_CACHE_WRECK,
  resolvePlaceholderDurationMs,
  getContentProfile,
  grantNewRewardWreck,
}, attempt) {
  const {
    pocketState,
    containerType,
    spawnState,
    customInfo,
    deps,
    parsedCustomInfo,
  } = attempt;
  const rewardWreckState = parsedCustomInfo && parsedCustomInfo.evejsAbyssalRewardCache;
  const extractionWreckState = parsedCustomInfo && parsedCustomInfo.evejsAbyssalExtractionNode;
  const sourceArtifactState = rewardWreckState || extractionWreckState;
  const sourceStructureTypeID = toInt(
    sourceArtifactState && sourceArtifactState.sourceStructureTypeID,
    0,
  );
  const sourceStructureType = sourceStructureTypeID > 0
    ? resolveAbyssalStructureType(sourceStructureTypeID, deps)
    : null;
  const isRewardWreck = Boolean(
    rewardWreckState && normalizeText(rewardWreckState.role, "") === "cache_loot_container",
  );
  const isExtractionWreck = Boolean(
    extractionWreckState &&
    normalizeText(extractionWreckState.role, "") === "extraction_node_loot_container",
  );
  const createResult = deps.createSpaceItemForOwner(
    pocketState.characterID,
    pocketState.solarSystemID,
    containerType,
    {
      itemName: (isRewardWreck || isExtractionWreck) && sourceStructureType
        ? `Wreck of ${normalizeText(sourceStructureType.name, "Abyssal Cache")}`
        : toInt(containerType && containerType.typeID, 0) ===
            TYPE_CAPTURED_TRIGLAVIAN_BIOADAPTIVE_CACHE_WRECK
          ? "Triglavian Bioadaptive Cache Wreck"
          : "Abyssal Reward Container",
      ...spawnState,
      createdAtMs: toInt(deps.now(), 0),
      expiresAtMs: toInt(
        pocketState && pocketState.timerState && pocketState.timerState.expiresAtMs,
        toInt(deps.now(), 0) + resolvePlaceholderDurationMs(getContentProfile(pocketState), deps),
      ),
      customInfo,
    },
  );
  if (!createResult || !createResult.success || !createResult.data) {
    return {
      success: false,
      retryable: true,
      errorMsg: createResult && createResult.errorMsg || "CONTAINER_CREATE_FAILED",
    };
  }
  return grantNewRewardWreck({
    ...attempt,
    createResult,
    sourceArtifactState,
  });
}

function grantNewRewardWreck({
  buildAbyssalRewardManifestReceiptKey,
  inspectAbyssalRewardContainerManifest,
  isTerminalAbyssalRewardMaterializationError,
  settleNewRewardWreck,
}, attempt) {
  const {
    pocketState,
    roomIndex,
    deps,
    manifestResult,
    createResult,
    sourceArtifactState,
  } = attempt;
  const rewardContainerItem = createResult.data;
  const rewardChanges = [...(createResult.changes || [])];
  const receiptKey = buildAbyssalRewardManifestReceiptKey(
    pocketState,
    roomIndex,
    rewardContainerItem.itemID,
    toInt(sourceArtifactState && sourceArtifactState.sourceStructureItemID, 0),
  );
  const grantExecution = createAbyssalRewardMaterializationExecutor({
    grantItemsToOwnerLocationIdempotent:
      deps.grantItemsToOwnerLocationIdempotent,
  }).executeMaterialization({
    recipientOwnerID: pocketState.characterID,
    destinationLocationID: rewardContainerItem.itemID,
    destinationFlagID: 0,
    grantEntries: manifestResult.grantEntries,
    receiptKey,
    grantOptions: {
      receiptKey,
      grantedAtMs: toInt(deps.now(), 0),
      receiptMetadata: {
        instanceID: toInt(pocketState.instanceID, 0),
        roomIndex: toInt(roomIndex, 0),
        containerItemID: toInt(rewardContainerItem.itemID, 0),
        kind: "abyssal_reward_manifest",
      },
    },
  });
  const grantResult = grantExecution.physicalResult;
  if (!grantResult || grantResult.success !== true) {
    const failedContents = inspectAbyssalRewardContainerManifest(
      rewardContainerItem.itemID,
      manifestResult.manifest,
      pocketState.characterID,
      deps,
    );
    const errorMsg = normalizeText(
      grantResult && grantResult.errorMsg,
      "REWARD_MANIFEST_GRANT_FAILED",
    );
    const retainedForRetry =
      (failedContents.empty || failedContents.exact) &&
      !isTerminalAbyssalRewardMaterializationError(errorMsg);
    if (!retainedForRetry) {
      deps.removeInventoryItem(rewardContainerItem.itemID, { removeContents: true });
    }
    return {
      success: false,
      errorMsg,
      ambiguous: grantResult && grantResult.ambiguous === true,
      retryable: retainedForRetry,
      containerItemID: retainedForRetry
        ? toInt(rewardContainerItem.itemID, 0)
        : 0,
      grantResult,
    };
  }
  return settleNewRewardWreck({
    ...attempt,
    rewardContainerItem,
    rewardChanges,
    receiptKey,
    grantResult,
  });
}

function settleNewRewardWreck({
  applyAbyssalBlueprintCopyStates,
  cleanupAbyssalBlueprintCopyStates,
  inspectAbyssalRewardContainerManifest,
  cloneValue,
  spawnPocketDynamicInventoryEntity,
  syncInventoryChanges,
}, attempt) {
  const {
    pocketState,
    roomIndex,
    containerType,
    session,
    deps,
    manifestResult,
    rewardContainerItem,
    rewardChanges,
    receiptKey,
    grantResult,
  } = attempt;
  const blueprintStateResult = applyAbyssalBlueprintCopyStates(
    grantResult,
    manifestResult,
    deps,
  );
  if (!blueprintStateResult.success) {
    cleanupAbyssalBlueprintCopyStates(
      grantResult && grantResult.data && Array.isArray(grantResult.data.items)
        ? grantResult.data.items.map((item) => item && item.itemID)
        : [],
      deps,
    );
    deps.removeInventoryItem(rewardContainerItem.itemID, { removeContents: true });
    return {
      success: false,
      retryable: false,
      errorMsg: blueprintStateResult.errorMsg,
      blueprintStateResult,
    };
  }

  rewardChanges.push(...(
    grantResult.data && Array.isArray(grantResult.data.changes)
      ? grantResult.data.changes
      : []
  ));
  const verifiedContents = inspectAbyssalRewardContainerManifest(
    rewardContainerItem.itemID,
    manifestResult.manifest,
    pocketState.characterID,
    deps,
  );
  const manifestVerified = manifestResult.manifest.length === 0
    ? verifiedContents.supported && verifiedContents.empty
    : verifiedContents.exact;
  if (!manifestVerified) {
    return {
      success: false,
      ambiguous: true,
      retryable: true,
      reconciliationRequired: true,
      errorMsg: "REWARD_CONTAINER_MANIFEST_MISMATCH",
      containerItemID: toInt(rewardContainerItem.itemID, 0),
      rewardManifest: cloneValue(manifestResult.manifest),
      rewardReceiptKey: receiptKey,
      blueprintCopyItemIDs: cloneValue(blueprintStateResult.updatedItemIDs),
      manifestInspection: verifiedContents,
    };
  }

  const spawnResult = spawnPocketDynamicInventoryEntity(
    pocketState,
    rewardContainerItem.itemID,
    deps,
  );
  if (!spawnResult || !spawnResult.success) {
    return {
      success: false,
      retryable: true,
      errorMsg: spawnResult && spawnResult.errorMsg || "CONTAINER_SPAWN_FAILED",
      containerItemID: toInt(rewardContainerItem.itemID, 0),
      rewardManifest: cloneValue(manifestResult.manifest),
      rewardReceiptKey: receiptKey,
    };
  }

  syncInventoryChanges(session, rewardChanges, deps);
  return {
    success: true,
    data: {
      containerItemID: toInt(rewardContainerItem.itemID, 0),
      containerTypeID: toInt(containerType.typeID, 0),
      rewardTypeID: manifestResult.rewardTypeID,
      rewardQuantity: manifestResult.rewardQuantity,
      contentsGranted: manifestResult.manifest.length > 0,
      rewardManifest: cloneValue(manifestResult.manifest),
      rewardReceiptKey: receiptKey,
      blueprintCopyItemIDs: cloneValue(blueprintStateResult.updatedItemIDs),
      roomIndex,
    },
  };
}

function retryAbyssalRewardLootContainer({
  getDependencies,
  parseCustomInfo,
  materializeAbyssalRewardStructureWreck,
  reconcileRetainedRewardContainer,
},
  pocketState,
  roomIndex,
  containerType,
  retryIntent,
  customInfo,
  deps = getDependencies(),
) {
  let retainedContainerItemID = toInt(
    retryIntent && retryIntent.retainedContainerItemID,
    0,
  );
  let retainedContainer = retainedContainerItemID > 0
    ? deps.findItemById(retainedContainerItemID)
    : null;
  const sourceStructureItemID = toInt(
    retryIntent && retryIntent.sourceStructureItemID,
    0,
  );
  const expectedTypeID = toInt(containerType && containerType.typeID, 0);
  if (
    !retainedContainer &&
    sourceStructureItemID > 0 &&
    typeof deps.listSystemSpaceItems === "function"
  ) {
    let candidates;
    try {
      candidates = deps.listSystemSpaceItems(pocketState.solarSystemID)
        .filter((item) => {
          const parsed = parseCustomInfo(item && item.customInfo);
          const state = parsed && (
            parsed.evejsAbyssalRewardCache ||
            parsed.evejsAbyssalExtractionNode
          );
          return Boolean(
            state &&
            toInt(item && item.typeID, 0) === expectedTypeID &&
            toInt(item && item.ownerID, 0) === toInt(pocketState.characterID, 0) &&
            toInt(item && item.locationID, 0) === toInt(pocketState.solarSystemID, 0) &&
            toInt(state.instanceID, 0) === toInt(pocketState.instanceID, 0) &&
            toInt(state.roomIndex, 0) === toInt(roomIndex, 0) &&
            toInt(state.sourceStructureItemID, 0) === sourceStructureItemID
          );
        });
    } catch (error) {
      return {
        success: false,
        retryable: true,
        errorMsg: normalizeText(
          error && error.message,
          "ABYSSAL_REWARD_RETRY_CONTAINER_SCAN_FAILED",
        ),
      };
    }
    if (candidates.length > 1) {
      return {
        success: false,
        ambiguous: true,
        retryable: false,
        errorMsg: "ABYSSAL_REWARD_RETRY_CONTAINER_AMBIGUOUS",
      };
    }
    retainedContainer = candidates[0] || null;
    retainedContainerItemID = toInt(retainedContainer && retainedContainer.itemID, 0);
  }
  if (!retainedContainer) {
    return materializeAbyssalRewardStructureWreck(
      pocketState,
      roomIndex,
      containerType,
      retryIntent && retryIntent.lootEntries,
      retryIntent && retryIntent.spawnState,
      customInfo,
      null,
      deps,
    );
  }
  return reconcileRetainedRewardContainer({
    pocketState,
    roomIndex,
    retryIntent,
    deps,
    retainedContainerItemID,
    retainedContainer,
    sourceStructureItemID,
    expectedTypeID,
  });
}

function reconcileRetainedRewardContainer({
  parseCustomInfo,
  resolveAbyssalRewardGrantManifest,
  grantRetainedRewardManifest,
}, attempt) {
  const {
    pocketState,
    roomIndex,
    retryIntent,
    deps,
    retainedContainerItemID,
    retainedContainer,
    sourceStructureItemID,
    expectedTypeID,
  } = attempt;
  const parsedCustomInfo = parseCustomInfo(retainedContainer.customInfo);
  const retainedState = parsedCustomInfo && (
    parsedCustomInfo.evejsAbyssalRewardCache ||
    parsedCustomInfo.evejsAbyssalExtractionNode
  );
  if (
    expectedTypeID <= 0 ||
    toInt(retainedContainer.typeID, 0) !== expectedTypeID ||
    toInt(retainedContainer.ownerID, 0) !== toInt(pocketState.characterID, 0) ||
    toInt(retainedContainer.locationID, 0) !== toInt(pocketState.solarSystemID, 0) ||
    !retainedState ||
    toInt(retainedState.instanceID, 0) !== toInt(pocketState.instanceID, 0) ||
    toInt(retainedState.roomIndex, 0) !== toInt(roomIndex, 0) ||
    toInt(retainedState.sourceStructureItemID, 0) !== sourceStructureItemID
  ) {
    return {
      success: false,
      ambiguous: true,
      retryable: false,
      errorMsg: "ABYSSAL_REWARD_RETRY_CONTAINER_IDENTITY_MISMATCH",
      containerItemID: retainedContainerItemID,
    };
  }

  const lootEntries = Array.isArray(retryIntent && retryIntent.lootEntries)
    ? retryIntent.lootEntries
    : [];
  const allowsEmptyManifest = Boolean(
    (
      parsedCustomInfo.evejsAbyssalExtractionNode ||
      parsedCustomInfo.evejsAbyssalRewardCache &&
        parsedCustomInfo.evejsAbyssalRewardCache.allowEmptyManifest === true
    ) && lootEntries.length === 0
  );
  const manifestResult = allowsEmptyManifest
    ? {
        success: true,
        grantEntries: [],
        manifest: [],
        rewardTypeID: 0,
        rewardQuantity: 0,
      }
    : resolveAbyssalRewardGrantManifest(lootEntries, deps);
  if (!manifestResult.success) {
    return { ...manifestResult, retryable: false };
  }
  return grantRetainedRewardManifest({
    ...attempt,
    manifestResult,
  });
}

function grantRetainedRewardManifest({
  inspectAbyssalRewardContainerManifest,
  buildAbyssalRewardManifestReceiptKey,
  isTerminalAbyssalRewardMaterializationError,
  publishRetainedRewardContainer,
}, attempt) {
  const {
    pocketState,
    roomIndex,
    deps,
    retainedContainerItemID,
    sourceStructureItemID,
    manifestResult,
  } = attempt;
  let contents = inspectAbyssalRewardContainerManifest(
    retainedContainerItemID,
    manifestResult.manifest,
    pocketState.characterID,
    deps,
  );
  if (!contents.exact && contents.empty && manifestResult.grantEntries.length > 0) {
    if (typeof deps.grantItemsToOwnerLocationIdempotent !== "function") {
      return {
        success: false,
        retryable: false,
        errorMsg: "REWARD_BATCH_GRANT_UNAVAILABLE",
        containerItemID: retainedContainerItemID,
      };
    }
    const receiptKey = buildAbyssalRewardManifestReceiptKey(
      pocketState,
      roomIndex,
      retainedContainerItemID,
      sourceStructureItemID,
    );
    const grantExecution = createAbyssalRewardMaterializationExecutor({
      grantItemsToOwnerLocationIdempotent:
        deps.grantItemsToOwnerLocationIdempotent,
    }).executeMaterialization({
      recipientOwnerID: pocketState.characterID,
      destinationLocationID: retainedContainerItemID,
      destinationFlagID: 0,
      grantEntries: manifestResult.grantEntries,
      receiptKey,
      grantOptions: {
        receiptKey,
        grantedAtMs: toInt(deps.now(), 0),
        receiptMetadata: {
          instanceID: toInt(pocketState.instanceID, 0),
          roomIndex: toInt(roomIndex, 0),
          containerItemID: retainedContainerItemID,
          sourceStructureItemID,
          kind: "abyssal_reward_manifest_retry",
        },
      },
    });
    const grantResult = grantExecution.physicalResult;
    if (!grantResult || grantResult.success !== true) {
      const errorMsg = normalizeText(
        grantResult && grantResult.errorMsg,
        "REWARD_MANIFEST_GRANT_FAILED",
      );
      return {
        success: false,
        retryable: !isTerminalAbyssalRewardMaterializationError(errorMsg),
        ambiguous: grantResult && grantResult.ambiguous === true,
        errorMsg,
        containerItemID: retainedContainerItemID,
        grantResult,
      };
    }
    contents = inspectAbyssalRewardContainerManifest(
      retainedContainerItemID,
      manifestResult.manifest,
      pocketState.characterID,
      deps,
    );
  }
  return publishRetainedRewardContainer({
    ...attempt,
    contents,
  });
}

function publishRetainedRewardContainer({
  applyAbyssalBlueprintCopyStates,
  spawnPocketDynamicInventoryEntity,
  cloneValue,
  buildAbyssalRewardManifestReceiptKey,
}, attempt) {
  const {
    pocketState,
    roomIndex,
    deps,
    retainedContainerItemID,
    sourceStructureItemID,
    expectedTypeID,
    manifestResult,
    contents,
  } = attempt;
  const manifestVerified = manifestResult.manifest.length === 0
    ? contents.supported && contents.empty
    : contents.exact;
  if (!manifestVerified) {
    return {
      success: false,
      ambiguous: true,
      retryable: true,
      reconciliationRequired: true,
      errorMsg: "REWARD_CONTAINER_MANIFEST_MISMATCH",
      containerItemID: retainedContainerItemID,
      manifestInspection: contents,
    };
  }
  // Inventory rows can have committed before a grant reported an ambiguous
  // outcome. Their exact manifest is not proof that the separate blueprint
  // state committed too. Reconcile copy state before publishing; existing
  // licensed runs are preserved by the same helper as first materialization.
  const blueprintStateResult = applyAbyssalBlueprintCopyStates(
    { data: { items: contents.contents } },
    manifestResult,
    deps,
  );
  if (!blueprintStateResult.success) {
    return {
      success: false,
      retryable: true,
      errorMsg: blueprintStateResult.errorMsg,
      containerItemID: retainedContainerItemID,
      blueprintStateResult,
    };
  }
  const spawnResult = spawnPocketDynamicInventoryEntity(
    pocketState,
    retainedContainerItemID,
    deps,
  );
  if (!spawnResult || spawnResult.success !== true) {
    return {
      success: false,
      retryable: true,
      errorMsg: normalizeText(
        spawnResult && spawnResult.errorMsg,
        "CONTAINER_SPAWN_FAILED",
      ),
      containerItemID: retainedContainerItemID,
    };
  }
  return {
    success: true,
    data: {
      containerItemID: retainedContainerItemID,
      containerTypeID: expectedTypeID,
      blueprintCopyItemIDs: cloneValue(blueprintStateResult.updatedItemIDs),
      rewardTypeID: manifestResult.rewardTypeID,
      rewardQuantity: manifestResult.rewardQuantity,
      contentsGranted: manifestResult.manifest.length > 0,
      rewardManifest: cloneValue(manifestResult.manifest),
      rewardReceiptKey: buildAbyssalRewardManifestReceiptKey(
        pocketState,
        roomIndex,
        retainedContainerItemID,
        sourceStructureItemID,
      ),
      roomIndex,
    },
  };
}

// Capture supplied capabilities once, as the original closure did. Internal
// callbacks are bound once per instance; no runtime state lives in this wiring.
function createAbyssalRewardMaterialization({
  getDependencies,
  cloneValue,
  parseCustomInfo,
  ensureAbyssalPocketPersistenceReady,
  getContentProfile,
  resolvePlaceholderDurationMs,
  spawnPocketDynamicInventoryEntity,
  syncInventoryChanges,
  nextAbyssalLootRandom,
  listUniquePositiveInts,
  CATEGORY_BLUEPRINT,
  TYPE_CAPTURED_TRIGLAVIAN_BIOADAPTIVE_CACHE,
  TYPE_ABYSSAL_BIOCOMBINATIVE_CACHE,
  TYPE_ABYSSAL_BIOCOMBINATIVE_CACHE_WRECK,
  TYPE_CAPTURED_TRIGLAVIAN_BIOADAPTIVE_CACHE_WRECK,
  TYPE_ABYSSAL_EXTRACTION_SUBNODE,
  TYPE_ABYSSAL_EXTRACTION_SUBNODE_WRECK,
  TYPE_ABYSSAL_EXTRACTION_NODE_WRECK,
  ABYSSAL_BLUEPRINT_COPY_MIN_RUNS,
  ABYSSAL_BLUEPRINT_COPY_MAX_RUNS,
}) {

  const ports = {
    getDependencies,
    cloneValue,
    parseCustomInfo,
    ensureAbyssalPocketPersistenceReady,
    getContentProfile,
    resolvePlaceholderDurationMs,
    spawnPocketDynamicInventoryEntity,
    syncInventoryChanges,
    nextAbyssalLootRandom,
    listUniquePositiveInts,
    CATEGORY_BLUEPRINT,
    TYPE_CAPTURED_TRIGLAVIAN_BIOADAPTIVE_CACHE,
    TYPE_ABYSSAL_BIOCOMBINATIVE_CACHE,
    TYPE_ABYSSAL_BIOCOMBINATIVE_CACHE_WRECK,
    TYPE_CAPTURED_TRIGLAVIAN_BIOADAPTIVE_CACHE_WRECK,
    TYPE_ABYSSAL_EXTRACTION_SUBNODE,
    TYPE_ABYSSAL_EXTRACTION_SUBNODE_WRECK,
    TYPE_ABYSSAL_EXTRACTION_NODE_WRECK,
    ABYSSAL_BLUEPRINT_COPY_MIN_RUNS,
    ABYSSAL_BLUEPRINT_COPY_MAX_RUNS,
  };
  ports.resolveRewardContainerType = resolveRewardContainerType.bind(null, ports);
  ports.resolveExtractionNodeContainerType = resolveExtractionNodeContainerType.bind(null, ports);
  ports.resolveAbyssalStructureType = resolveAbyssalStructureType.bind(null, ports);
  ports.resolveRewardLootType = resolveRewardLootType.bind(null, ports);
  ports.resolveAbyssalRewardGrantManifest = resolveAbyssalRewardGrantManifest.bind(null, ports);
  ports.buildAbyssalRewardManifestReceiptKey = buildAbyssalRewardManifestReceiptKey.bind(null, ports);
  ports.resolveInventoryItemLogicalQuantity = resolveInventoryItemLogicalQuantity.bind(null, ports);
  ports.inspectAbyssalRewardContainerManifest = inspectAbyssalRewardContainerManifest.bind(null, ports);
  ports.isTerminalAbyssalRewardMaterializationError = isTerminalAbyssalRewardMaterializationError.bind(null, ports);
  ports.applyAbyssalBlueprintCopyStates = applyAbyssalBlueprintCopyStates.bind(null, ports);
  ports.cleanupAbyssalBlueprintCopyStates = cleanupAbyssalBlueprintCopyStates.bind(null, ports);
  ports.materializeAbyssalRewardStructureWreck = materializeAbyssalRewardStructureWreck.bind(null, ports);
  ports.createRewardStructureWreck = createRewardStructureWreck.bind(null, ports);
  ports.grantNewRewardWreck = grantNewRewardWreck.bind(null, ports);
  ports.settleNewRewardWreck = settleNewRewardWreck.bind(null, ports);
  ports.retryAbyssalRewardLootContainer = retryAbyssalRewardLootContainer.bind(null, ports);
  ports.reconcileRetainedRewardContainer = reconcileRetainedRewardContainer.bind(null, ports);
  ports.grantRetainedRewardManifest = grantRetainedRewardManifest.bind(null, ports);
  ports.publishRetainedRewardContainer = publishRetainedRewardContainer.bind(null, ports);
  Object.freeze(ports);
  return Object.freeze({
    resolveRewardContainerType: ports.resolveRewardContainerType,
    resolveExtractionNodeContainerType: ports.resolveExtractionNodeContainerType,
    resolveAbyssalStructureType: ports.resolveAbyssalStructureType,
    resolveRewardLootType: ports.resolveRewardLootType,
    resolveAbyssalRewardGrantManifest: ports.resolveAbyssalRewardGrantManifest,
    buildAbyssalRewardManifestReceiptKey: ports.buildAbyssalRewardManifestReceiptKey,
    resolveInventoryItemLogicalQuantity: ports.resolveInventoryItemLogicalQuantity,
    inspectAbyssalRewardContainerManifest: ports.inspectAbyssalRewardContainerManifest,
    isTerminalAbyssalRewardMaterializationError: ports.isTerminalAbyssalRewardMaterializationError,
    applyAbyssalBlueprintCopyStates: ports.applyAbyssalBlueprintCopyStates,
    cleanupAbyssalBlueprintCopyStates: ports.cleanupAbyssalBlueprintCopyStates,
    materializeAbyssalRewardStructureWreck: ports.materializeAbyssalRewardStructureWreck,
    retryAbyssalRewardLootContainer: ports.retryAbyssalRewardLootContainer,
  });
}

module.exports = { createAbyssalRewardMaterialization };
