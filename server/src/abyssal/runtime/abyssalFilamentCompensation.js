"use strict";

const { normalizeText } = require("../domain/abyssalValueUtils");

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function classifyAbyssalFilamentCompensationFailure(ports, reason, options = {}) {
  const {
    ABYSSAL_FILAMENT_COMPENSATION_FAILURE_CLASS,
    isPostEntryForfeitReason,
  } = ports;
  const failureReason = normalizeText(reason, "deployment-rollback");
  const normalizedReason = failureReason.toUpperCase();
  if (normalizedReason.startsWith("PLAYER_WORLD_INVALIDATION:")) {
    return {
      failureClass:
        ABYSSAL_FILAMENT_COMPENSATION_FAILURE_CLASS.PLAYER_WORLD_INVALIDATION,
      refundEligible: false,
      failureReason,
    };
  }
  if (
    options.authoritativeEntryCommitted === true ||
    isPostEntryForfeitReason(normalizedReason)
  ) {
    return {
      failureClass:
        ABYSSAL_FILAMENT_COMPENSATION_FAILURE_CLASS.POST_AUTHORITATIVE_ENTRY,
      refundEligible: false,
      failureReason,
    };
  }
  return {
    failureClass:
      ABYSSAL_FILAMENT_COMPENSATION_FAILURE_CLASS.SERVER_INFRASTRUCTURE,
    refundEligible: true,
    failureReason,
  };
}

function persistAbyssalFilamentCompensationClaim(ports, claim, deps = ports.getDependencies()) {
  const {
    cloneValue,
  } = ports;
  if (!deps || typeof deps.persistAbyssalFilamentCompensationClaim !== "function") {
    return {
      success: false,
      durable: false,
      errorMsg: "FILAMENT_COMPENSATION_STORE_UNAVAILABLE",
      data: claim || null,
    };
  }
  let result;
  try {
    result = deps.persistAbyssalFilamentCompensationClaim(claim);
  } catch (error) {
    return {
      success: false,
      durable: false,
      ambiguous: true,
      errorMsg: normalizeText(
        error && error.message,
        "FILAMENT_COMPENSATION_CLAIM_PERSIST_FAILED",
      ),
      data: claim || null,
    };
  }
  if (!result || result.success !== true || result.durable !== true) {
    return {
      success: false,
      durable: false,
      ambiguous: Boolean(result && result.ambiguous === true),
      errorMsg: normalizeText(
        result && result.errorMsg,
        "FILAMENT_COMPENSATION_CLAIM_PERSIST_FAILED",
      ),
      data: result && result.data || claim || null,
    };
  }
  return {
    ...result,
    data: cloneValue(result.data || claim),
  };
}

function readAbyssalFilamentCompensationClaim(ports,
  deploymentToken,
  deps = ports.getDependencies(),
) {
  if (!deps || typeof deps.readAbyssalFilamentCompensationClaim !== "function") {
    return {
      success: false,
      found: false,
      errorMsg: "FILAMENT_COMPENSATION_STORE_UNAVAILABLE",
      data: null,
    };
  }
  try {
    const result = deps.readAbyssalFilamentCompensationClaim(deploymentToken);
    return result && typeof result === "object"
      ? result
      : {
          success: false,
          found: false,
          errorMsg: "FILAMENT_COMPENSATION_CLAIM_READ_FAILED",
          data: null,
        };
  } catch (error) {
    return {
      success: false,
      found: false,
      ambiguous: true,
      errorMsg: normalizeText(
        error && error.message,
        "FILAMENT_COMPENSATION_CLAIM_READ_FAILED",
      ),
      data: null,
    };
  }
}

function resolveAbyssalFilamentCompensationSource(ports, traceState, options = {}) {
  const validationData = options.validation && options.validation.data || {};
  const filamentItem = validationData.filamentItem || null;
  const consumptionState =
    traceState &&
    traceState.filamentConsumptionState &&
    typeof traceState.filamentConsumptionState === "object"
      ? traceState.filamentConsumptionState
      : {};
  const characterID = toInt(
    traceState && traceState.characterID,
    toInt(validationData.context && validationData.context.characterID, 0),
  );
  const corporationID = toInt(
    consumptionState.corporationID,
    toInt(validationData.context && validationData.context.corporationID, 0),
  );
  const ownerID = toInt(
    consumptionState.ownerID,
    toInt(filamentItem && filamentItem.ownerID, 0),
  );
  const originalLocationID = toInt(
    consumptionState.originalLocationID,
    toInt(filamentItem && filamentItem.locationID, 0),
  );
  const originalFlagID = toInt(
    consumptionState.originalFlagID,
    toInt(filamentItem && filamentItem.flagID, 0),
  );
  const filamentTypeID = toInt(
    consumptionState.filamentTypeID,
    toInt(
      traceState && traceState.filamentTypeID,
      toInt(filamentItem && filamentItem.typeID, 0),
    ),
  );
  const quantity = Math.max(
    1,
    toInt(
      consumptionState.quantity,
      toInt(
        traceState && traceState.requiredFilaments,
        toInt(validationData.shipProfile && validationData.shipProfile.requiredFilaments, 1),
      ),
    ),
  );
  return {
    characterID,
    corporationID,
    ownerID,
    originalLocationID,
    originalFlagID,
    filamentTypeID,
    quantity,
    customInfo: normalizeText(
      consumptionState.customInfo,
      normalizeText(filamentItem && filamentItem.customInfo, ""),
    ),
    authoritative: Boolean(
      ownerID > 0 &&
      originalLocationID > 0 &&
      originalFlagID > 0 &&
      filamentTypeID > 0 &&
      quantity > 0
    ),
  };
}

function buildAbyssalFilamentCompensationTraceIdentity(ports, traceState) {
  const {
    buildAbyssalTraceDeploymentToken,
  } = ports;
  return {
    traceItemID: toInt(traceState && traceState.traceItemID, 0),
    deploymentToken: normalizeText(
      traceState && traceState.deploymentToken,
      buildAbyssalTraceDeploymentToken(
        traceState && traceState.traceItemID,
        traceState && traceState.deployedAtMs,
      ),
    ),
    characterID: toInt(traceState && traceState.characterID, 0),
    shipID: toInt(traceState && traceState.shipID, 0),
    sourceSolarSystemID: toInt(
      traceState && traceState.sourceSolarSystemID,
      toInt(traceState && traceState.solarSystemID, 0),
    ),
    deployedAtMs: toInt(traceState && traceState.deployedAtMs, 0),
  };
}

function abyssalFilamentCompensationTupleMatches(ports, left, right) {
  return Boolean(
    left &&
    right &&
    normalizeText(left.deploymentToken, "") ===
      normalizeText(right.deploymentToken, "") &&
    toInt(left.traceItemID, 0) === toInt(right.traceItemID, 0) &&
    toInt(left.characterID, 0) === toInt(right.characterID, 0) &&
    toInt(left.filamentOwnerID, 0) === toInt(right.filamentOwnerID, 0) &&
    toInt(left.filamentTypeID, 0) === toInt(right.filamentTypeID, 0) &&
    toInt(left.quantity, 0) === toInt(right.quantity, 0)
  );
}

function stageAbyssalFilamentCompensationClaim(ports,
  traceState,
  deps = ports.getDependencies(),
  reason = "deployment-rollback",
  options = {},
) {
  const {
    ABYSSAL_FILAMENT_COMPENSATION_STATE,
    cloneValue,
    hasCommittedAbyssalFilamentConsumption,
    isCompleteAbyssalTracePublicationReceipt,
  } = ports;
  const traceIdentity = buildAbyssalFilamentCompensationTraceIdentity(ports, traceState);
  const classification = classifyAbyssalFilamentCompensationFailure(ports, reason, options);
  const source = resolveAbyssalFilamentCompensationSource(ports, traceState, options);
  const consumptionProven = Boolean(
    options.consumeResult && options.consumeResult.success === true ||
    hasCommittedAbyssalFilamentConsumption(traceState) ||
    isCompleteAbyssalTracePublicationReceipt(
      traceState && traceState.publicationReceipt,
      traceIdentity.traceItemID,
    )
  );
  if (
    traceIdentity.traceItemID <= 0 ||
    !traceIdentity.deploymentToken ||
    source.characterID <= 0 ||
    source.filamentTypeID <= 0
  ) {
    return {
      success: false,
      durable: false,
      errorMsg: "FILAMENT_COMPENSATION_IDENTITY_INCOMPLETE",
    };
  }
  if (classification.refundEligible && (!source.authoritative || !consumptionProven)) {
    return {
      success: false,
      durable: false,
      errorMsg: source.authoritative
        ? "FILAMENT_CONSUMPTION_NOT_PROVEN"
        : "FILAMENT_COMPENSATION_SOURCE_UNPROVEN",
    };
  }

  const receiptKey = `abyssal-filament-compensation:${traceIdentity.deploymentToken}`;
  if (receiptKey.length > 512) {
    return {
      success: false,
      durable: false,
      errorMsg: "FILAMENT_COMPENSATION_IDEMPOTENCY_KEY_INVALID",
    };
  }
  const nowMs = toInt(deps && deps.now && deps.now(), Date.now());
  const candidate = {
    schemaVersion: 1,
    deploymentToken: traceIdentity.deploymentToken,
    receiptKey,
    state: ABYSSAL_FILAMENT_COMPENSATION_STATE.PENDING,
    failureClass: classification.failureClass,
    failureReason: classification.failureReason,
    refundEligible: classification.refundEligible,
    consumptionProven,
    traceItemID: traceIdentity.traceItemID,
    characterID: source.characterID,
    corporationID: source.corporationID,
    shipID: traceIdentity.shipID,
    sourceSolarSystemID: traceIdentity.sourceSolarSystemID,
    deployedAtMs: traceIdentity.deployedAtMs,
    filamentOwnerID: source.ownerID,
    filamentTypeID: source.filamentTypeID,
    quantity: source.quantity,
    originalLocationID: source.originalLocationID,
    originalFlagID: source.originalFlagID,
    filamentCustomInfo: source.customInfo,
    destination: null,
    traceInvalidated: false,
    traceInvalidationMode: "",
    attemptCount: 0,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
    completedAtMs: 0,
    completionOutcome: "",
    receipt: null,
  };
  const readResult = readAbyssalFilamentCompensationClaim(ports,
    traceIdentity.deploymentToken,
    deps,
  );
  if (!readResult.success) {
    return {
      success: false,
      durable: false,
      ambiguous: Boolean(readResult.ambiguous),
      errorMsg: readResult.errorMsg,
      claim: null,
    };
  }
  if (readResult.found && readResult.data) {
    if (!abyssalFilamentCompensationTupleMatches(ports, readResult.data, candidate)) {
      return {
        success: false,
        durable: true,
        ambiguous: true,
        errorMsg: "FILAMENT_COMPENSATION_CLAIM_MISMATCH",
        claim: cloneValue(readResult.data),
      };
    }
    // The first durable classification wins. In particular, a terminal
    // player/world forfeiture can never be upgraded into a later refund.
    return {
      success: true,
      durable: true,
      duplicate: true,
      claim: cloneValue(readResult.data),
    };
  }
  const persistResult = persistAbyssalFilamentCompensationClaim(ports, candidate, deps);
  return {
    ...persistResult,
    claim: persistResult.success ? cloneValue(persistResult.data) : null,
  };
}

function isReachableAbyssalCompensationStation(ports, stationID, deps) {
  const numericStationID = toInt(stationID, 0);
  if (numericStationID <= 0) {
    return false;
  }
  if (deps && typeof deps.isAbyssalCompensationStationReachable === "function") {
    try {
      return deps.isAbyssalCompensationStationReachable(numericStationID) === true;
    } catch (_error) {
      // ignored: a failing reachability check counts as not reachable (false)
      return false;
    }
  }
  return Boolean(
    deps &&
    deps.worldData &&
    typeof deps.worldData.getStationByID === "function" &&
    deps.worldData.getStationByID(numericStationID)
  );
}

function resolveAbyssalFilamentCompensationDestination(ports,
  claim,
  session,
  deps = ports.getDependencies(),
) {
  const {
    getSessionContext,
    getCategoryID,
    CATEGORY_SHIP,
    listUniquePositiveInts,
  } = ports;
  const characterID = toInt(claim && claim.characterID, 0);
  const corporationID = toInt(claim && claim.corporationID, 0);
  const ownerID = toInt(claim && claim.filamentOwnerID, 0);
  const originalLocationID = toInt(claim && claim.originalLocationID, 0);
  const characterRecord =
    characterID > 0 && deps && typeof deps.getCharacterRecord === "function"
      ? deps.getCharacterRecord(characterID)
      : null;
  const sessionContext = getSessionContext(session);
  const activeShipID = toInt(
    characterRecord && (
      characterRecord.shipID ||
      characterRecord.shipid ||
      characterRecord.activeShipID ||
      characterRecord.activeShipId
    ),
    sessionContext.characterID === characterID ? sessionContext.shipID : 0,
  );
  const originalShipItem =
    originalLocationID > 0 &&
    activeShipID === originalLocationID &&
    deps &&
    typeof deps.findItemById === "function"
      ? deps.findItemById(originalLocationID)
      : null;
  if (
    originalShipItem &&
    toInt(originalShipItem.ownerID, 0) === characterID &&
    getCategoryID(originalShipItem, deps) === CATEGORY_SHIP
  ) {
    return {
      success: true,
      destination: {
        ownerID,
        locationID: originalLocationID,
        flagID: toInt(deps && deps.ITEM_FLAGS && deps.ITEM_FLAGS.CARGO_HOLD, 5),
        kind: "original-active-ship-cargo",
        selectedAtMs: toInt(deps && deps.now && deps.now(), Date.now()),
      },
    };
  }

  const stationCandidates = listUniquePositiveInts([
    characterRecord && (characterRecord.stationID || characterRecord.stationid),
    session && (session.stationID || session.stationid),
    characterRecord && characterRecord.homeStationID,
    characterRecord && characterRecord.cloneStationID,
    session && (session.homeStationID || session.homestationid),
    session && (session.cloneStationID || session.clonestationid),
  ]);
  const stationID = stationCandidates.find((candidate) =>
    isReachableAbyssalCompensationStation(ports, candidate, deps)
  ) || 0;
  const isCharacterOwner = ownerID === characterID && characterID > 0;
  const isCorporationOwner = ownerID === corporationID && corporationID > 0;
  if (stationID <= 0 || (!isCharacterOwner && !isCorporationOwner)) {
    return {
      success: false,
      errorMsg: stationID <= 0
        ? "FILAMENT_COMPENSATION_DESTINATION_UNAVAILABLE"
        : "FILAMENT_COMPENSATION_OWNER_UNREACHABLE",
    };
  }
  return {
    success: true,
    destination: {
      ownerID,
      locationID: stationID,
      flagID: isCharacterOwner
        ? toInt(deps && deps.ITEM_FLAGS && deps.ITEM_FLAGS.HANGAR, 4)
        : toInt(deps && deps.ITEM_FLAGS && deps.ITEM_FLAGS.CORP_DELIVERIES, 62),
      kind: isCharacterOwner
        ? "character-station-hangar"
        : "corporation-station-deliveries",
      selectedAtMs: toInt(deps && deps.now && deps.now(), Date.now()),
    },
  };
}

function abyssalFilamentCompensationDestinationMatches(ports, left, right) {
  return Boolean(
    left &&
    right &&
    toInt(left.ownerID, 0) === toInt(right.ownerID, 0) &&
    toInt(left.locationID, 0) === toInt(right.locationID, 0) &&
    toInt(left.flagID, 0) === toInt(right.flagID, 0) &&
    normalizeText(left.kind, "") === normalizeText(right.kind, "")
  );
}

function abyssalFilamentCompensationReceiptMatchesClaim(ports, receipt, claim) {
  const destination = claim && claim.destination || null;
  return Boolean(
    receipt &&
    claim &&
    normalizeText(receipt.receiptKey, "") === normalizeText(claim.receiptKey, "") &&
    toInt(receipt.ownerID, 0) === toInt(claim.filamentOwnerID, 0) &&
    toInt(receipt.typeID, 0) === toInt(claim.filamentTypeID, 0) &&
    toInt(receipt.quantity, 0) === toInt(claim.quantity, 0) &&
    destination &&
    toInt(receipt.locationID, 0) === toInt(destination.locationID, 0) &&
    toInt(receipt.flagID, 0) === toInt(destination.flagID, 0)
  );
}

function markAbyssalFilamentCompensationTraceInvalidated(ports,
  claim,
  invalidationResult,
  deps = ports.getDependencies(),
) {
  const {
    cloneValue,
  } = ports;
  const nowMs = toInt(deps && deps.now && deps.now(), Date.now());
  const nextClaim = {
    ...cloneValue(claim),
    traceInvalidated: true,
    traceInvalidatedAtMs: nowMs,
    traceInvalidationMode: normalizeText(
      invalidationResult && invalidationResult.invalidationMode,
      invalidationResult && invalidationResult.alreadyGone
        ? "already-gone"
        : "removed",
    ),
    updatedAtMs: nowMs,
  };
  const persistResult = persistAbyssalFilamentCompensationClaim(ports, nextClaim, deps);
  return {
    ...persistResult,
    claim: persistResult.success ? cloneValue(persistResult.data) : cloneValue(claim),
  };
}

function completeAbyssalFilamentCompensationClaim(ports,
  claim,
  outcome,
  deps = ports.getDependencies(),
  receipt = null,
) {
  const {
    ABYSSAL_FILAMENT_COMPENSATION_STATE,
    cloneValue,
  } = ports;
  const nowMs = toInt(deps && deps.now && deps.now(), Date.now());
  const completedClaim = {
    ...cloneValue(claim),
    state: ABYSSAL_FILAMENT_COMPENSATION_STATE.COMPLETED,
    completionOutcome: normalizeText(outcome, "completed"),
    completedAtMs: nowMs,
    updatedAtMs: nowMs,
    receipt: receipt ? cloneValue(receipt) : cloneValue(claim && claim.receipt),
  };
  const persistResult = persistAbyssalFilamentCompensationClaim(ports, completedClaim, deps);
  return {
    ...persistResult,
    claim: persistResult.success ? cloneValue(persistResult.data) : cloneValue(claim),
  };
}

function invalidateFailedAbyssalDeploymentTrace(ports,
  traceState,
  deps = ports.getDependencies(),
  reason = "deployment-rollback",
) {
  const {
    cloneValue,
    destroyPlaceholderTrace,
    ABYSSAL_TRACE_LIFECYCLE_PHASE,
    persistTraceState,
    unregisterTrace,
  } = ports;
  const traceItemID = toInt(traceState && traceState.traceItemID, 0);
  const systemID = toInt(
    traceState && traceState.sourceSolarSystemID,
    toInt(traceState && traceState.solarSystemID, 0),
  );
  const traceRemovalResult = destroyPlaceholderTrace(
    systemID,
    traceItemID,
    deps,
    reason,
  );
  if (traceRemovalResult && traceRemovalResult.success === true) {
    return {
      success: true,
      invalidationMode: traceRemovalResult.removed ? "removed" : "already-gone",
      traceRemovalResult,
    };
  }

  const invalidatedAtMs = toInt(deps && deps.now && deps.now(), Date.now());
  const tombstonedTraceState = {
    ...cloneValue(traceState),
    lifecyclePhase: ABYSSAL_TRACE_LIFECYCLE_PHASE.REMOVED,
    activationState: 0,
    isAbyssGateOpen: false,
    expiresAtMs: invalidatedAtMs,
    automaticActivation: {
      ...cloneValue(traceState && traceState.automaticActivation || {}),
      enabled: false,
      status: "cancelled",
      cancelledAtMs: invalidatedAtMs,
      cancellationReason: normalizeText(reason, "deployment-rollback"),
    },
  };
  const tombstoneResult = persistTraceState(tombstonedTraceState, deps, {
    register: false,
  });
  if (tombstoneResult && tombstoneResult.success === true) {
    unregisterTrace(traceItemID);
    return {
      success: true,
      invalidationMode: "persisted-tombstone",
      traceRemovalResult,
      tombstoneResult,
    };
  }
  return {
    success: false,
    errorMsg: "TRACE_INVALIDATION_FAILED",
    traceRemovalResult,
    tombstoneResult,
  };
}

function ensureAbyssalFilamentCompensationTraceInvalidated(ports,
  claim,
  deps = ports.getDependencies(),
) {
  const {
    cloneValue,
    ABYSSAL_TRACE_LIFECYCLE_PHASE,
    readTraceStateFromItem,
    normalizeAbyssalTraceLifecyclePhase,
  } = ports;
  if (!claim) {
    return {
      success: false,
      errorMsg: "FILAMENT_COMPENSATION_CLAIM_INVALID",
    };
  }
  if (claim.traceInvalidated === true) {
    return {
      success: true,
      alreadyInvalidated: true,
      claim: cloneValue(claim),
    };
  }
  // A no-refund claim is only a durable decision record. Player/world
  // invalidations may deliberately preserve the still-unused trace, and a
  // post-entry failure must never mint a second entrance by rewriting it.
  if (claim.refundEligible !== true) {
    return {
      success: true,
      skipped: true,
      claim: cloneValue(claim),
    };
  }

  const traceItemID = toInt(claim.traceItemID, 0);
  const item =
    traceItemID > 0 && deps && typeof deps.findItemById === "function"
      ? deps.findItemById(traceItemID)
      : null;
  let invalidationResult;
  if (!item) {
    invalidationResult = {
      success: true,
      alreadyGone: true,
      invalidationMode: "already-gone",
    };
  } else {
    const persistedTraceState = readTraceStateFromItem(item);
    const persistedDeploymentToken = normalizeText(
      persistedTraceState && persistedTraceState.deploymentToken,
      "",
    );
    if (
      !persistedTraceState ||
      (
        persistedDeploymentToken &&
        persistedDeploymentToken !== normalizeText(claim.deploymentToken, "")
      )
    ) {
      // Never destroy an item whose durable identity no longer matches the
      // failed deployment. The old trace is already gone from our perspective.
      invalidationResult = {
        success: true,
        alreadyGone: true,
        invalidationMode: persistedTraceState
          ? "replacement-trace-present"
          : "unrecognized-item-present",
      };
    } else if (
      normalizeAbyssalTraceLifecyclePhase(persistedTraceState.lifecyclePhase) ===
        ABYSSAL_TRACE_LIFECYCLE_PHASE.REMOVED
    ) {
      invalidationResult = {
        success: true,
        alreadyGone: true,
        invalidationMode: "persisted-tombstone",
      };
    } else {
      invalidationResult = invalidateFailedAbyssalDeploymentTrace(ports,
        persistedTraceState,
        deps,
        normalizeText(claim.failureReason, "filament-compensation-reconcile"),
      );
    }
  }
  if (!invalidationResult || invalidationResult.success !== true) {
    return {
      success: false,
      errorMsg: normalizeText(
        invalidationResult && invalidationResult.errorMsg,
        "TRACE_INVALIDATION_FAILED",
      ),
      invalidationResult,
      claim: cloneValue(claim),
    };
  }
  return {
    ...markAbyssalFilamentCompensationTraceInvalidated(ports,
      claim,
      invalidationResult,
      deps,
    ),
    invalidationResult,
  };
}

function reconcileAbyssalFilamentCompensationsForSession(ports,
  session,
  deps = ports.getDependencies(),
) {
  const {
    cloneValue,
    getCharacterID,
  } = ports;
  const characterID = getCharacterID(session);
  if (
    characterID <= 0 ||
    !deps ||
    typeof deps.listAbyssalFilamentCompensationClaimsForCharacter !== "function"
  ) {
    return {
      success: characterID <= 0,
      skipped: true,
      errorMsg: characterID > 0
        ? "FILAMENT_COMPENSATION_STORE_UNAVAILABLE"
        : "",
      results: [],
    };
  }
  let listResult;
  try {
    listResult = deps.listAbyssalFilamentCompensationClaimsForCharacter(
      characterID,
      { includeCompleted: false },
    );
  } catch (error) {
    listResult = {
      success: false,
      errorMsg: normalizeText(
        error && error.message,
        "FILAMENT_COMPENSATION_CLAIM_LIST_FAILED",
      ),
    };
  }
  if (!listResult || listResult.success !== true) {
    return {
      success: false,
      errorMsg: normalizeText(
        listResult && listResult.errorMsg,
        "FILAMENT_COMPENSATION_CLAIM_LIST_FAILED",
      ),
      results: [],
    };
  }

  const results = [];
  for (const listedClaim of Array.isArray(listResult.data) ? listResult.data : []) {
    let claim = cloneValue(listedClaim);
    if (claim.refundEligible === true && claim.traceInvalidated !== true) {
      const invalidationResult = ensureAbyssalFilamentCompensationTraceInvalidated(ports,
        claim,
        deps,
      );
      if (!invalidationResult.success) {
        results.push({
          deploymentToken: claim.deploymentToken,
          success: false,
          refunded: false,
          errorMsg: invalidationResult.errorMsg,
          invalidationResult,
        });
        continue;
      }
      claim = cloneValue(invalidationResult.claim || claim);
    }
    const settlementResult = settleAbyssalFilamentCompensationClaim(ports,
      claim,
      session,
      deps,
    );
    results.push({
      deploymentToken: claim.deploymentToken,
      ...settlementResult,
    });
  }
  return {
    success: results.every((entry) => entry && entry.success === true),
    attempted: results.length,
    refunded: results.filter((entry) => entry && entry.refunded === true).length,
    results,
  };
}

function compensateFailedAbyssalDeployment(ports,
  validation,
  consumeResult,
  traceState,
  session,
  deps = ports.getDependencies(),
  reason = "deployment-rollback",
) {
  const {
    log,
  } = ports;
  const stageResult = stageAbyssalFilamentCompensationClaim(ports,
    traceState,
    deps,
    reason,
    { validation, consumeResult },
  );
  if (!stageResult.success) {
    log.error(
      `[AbyssalMgr] Deployment compensation failed closed before trace invalidation ` +
        `trace=${toInt(traceState && traceState.traceItemID, 0)} ` +
        `reason=${reason} error=${normalizeText(stageResult.errorMsg, "UNKNOWN")}`,
    );
    return {
      success: false,
      refunded: false,
      errorMsg: stageResult.errorMsg,
      stageResult,
    };
  }
  const invalidationResult = invalidateFailedAbyssalDeploymentTrace(ports,
    traceState,
    deps,
    reason,
  );
  if (!invalidationResult.success) {
    log.error(
      `[AbyssalMgr] Deployment compensation blocked until trace is unusable ` +
        `trace=${toInt(traceState && traceState.traceItemID, 0)} reason=${reason}`,
    );
    return {
      success: false,
      refunded: false,
      errorMsg: invalidationResult.errorMsg,
      invalidationResult,
      stageResult,
    };
  }
  const invalidationPersistResult = markAbyssalFilamentCompensationTraceInvalidated(ports,
    stageResult.claim,
    invalidationResult,
    deps,
  );
  if (!invalidationPersistResult.success) {
    return {
      success: false,
      refunded: false,
      errorMsg: invalidationPersistResult.errorMsg,
      invalidationResult,
      stageResult,
      invalidationPersistResult,
    };
  }
  const filamentCompensationResult = settleAbyssalFilamentCompensationClaim(ports,
    invalidationPersistResult.claim,
    session,
    deps,
  );
  return {
    success: filamentCompensationResult.success === true,
    refunded: filamentCompensationResult.refunded === true,
    invalidationResult,
    stageResult,
    invalidationPersistResult,
    filamentCompensationResult,
    errorMsg: filamentCompensationResult.success === true
      ? ""
      : filamentCompensationResult.errorMsg,
  };
}

// Durable receipt ambiguity blocks refund; the original classification and exact tuple remain authoritative.
function settleAbyssalFilamentCompensationClaim(ports, claim, session, deps = ports.getDependencies()) {
  const work = { claim, session, deps };
  for (const settle of [inspectCompensationEligibility, inspectCompensationReceipt,
    persistCompensationDestination, persistCompensationApplyingClaim, grantCompensation]) {
    const result = settle(ports, work);
    if (result) return result;
  }
  return completeCompensationGrant(ports, work);
}

function inspectCompensationEligibility(ports, work) {
  const {
    ABYSSAL_FILAMENT_COMPENSATION_STATE,
    cloneValue,
    normalizeLowerText,
  } = ports;
  const {
    claim,
    deps,
  } = work;
  if (!claim || !normalizeText(claim.deploymentToken, "")) {
    return {
      success: false,
      refunded: false,
      errorMsg: "FILAMENT_COMPENSATION_CLAIM_INVALID",
    };
  }
  if (
    normalizeLowerText(claim.state, "") ===
      ABYSSAL_FILAMENT_COMPENSATION_STATE.COMPLETED
  ) {
    return {
      success: true,
      refunded: normalizeText(claim.completionOutcome, "") === "refunded",
      duplicate: true,
      claim: cloneValue(claim),
    };
  }
  if (claim.refundEligible !== true) {
    const completionResult = completeAbyssalFilamentCompensationClaim(ports,
      claim,
      "forfeited_no_refund",
      deps,
    );
    return {
      ...completionResult,
      refunded: false,
    };
  }
  if (claim.traceInvalidated !== true) {
    return {
      success: false,
      refunded: false,
      errorMsg: "FILAMENT_COMPENSATION_TRACE_STILL_USABLE",
      claim: cloneValue(claim),
    };
  }
  if (
    !deps ||
    typeof deps.getIdempotentGrantReceipt !== "function" ||
    typeof deps.grantItemToOwnerLocationIdempotent !== "function"
  ) {
    return {
      success: false,
      refunded: false,
      errorMsg: "FILAMENT_COMPENSATION_IDEMPOTENT_GRANT_UNAVAILABLE",
      claim: cloneValue(claim),
    };
  }
}

function inspectCompensationReceipt(ports, work) {
  const {
    cloneValue,
  } = ports;
  const {
    claim,
    deps,
  } = work;
  let receiptResult;
  try {
    receiptResult = deps.getIdempotentGrantReceipt(claim.receiptKey, {
      requireDurable: true,
    });
  } catch (error) {
    receiptResult = {
      success: false,
      durable: false,
      ambiguous: true,
      errorMsg: normalizeText(
        error && error.message,
        "FILAMENT_COMPENSATION_RECEIPT_READ_FAILED",
      ),
    };
  }
  if (!receiptResult || receiptResult.success !== true || receiptResult.durable !== true) {
    return {
      success: false,
      refunded: false,
      ambiguous: true,
      errorMsg: normalizeText(
        receiptResult && receiptResult.errorMsg,
        "FILAMENT_COMPENSATION_RECEIPT_AMBIGUOUS",
      ),
      claim: cloneValue(claim),
      receiptResult,
    };
  }
  if (receiptResult.found === true && receiptResult.data) {
    if (!abyssalFilamentCompensationReceiptMatchesClaim(ports, receiptResult.data, claim)) {
      return {
        success: false,
        refunded: false,
        ambiguous: true,
        errorMsg: "FILAMENT_COMPENSATION_RECEIPT_MISMATCH",
        claim: cloneValue(claim),
        receiptResult,
      };
    }
    const completionResult = completeAbyssalFilamentCompensationClaim(ports,
      claim,
      "refunded",
      deps,
      receiptResult.data,
    );
    return {
      ...completionResult,
      refunded: completionResult.success === true,
      duplicate: true,
      receiptResult,
    };
  }
}

function persistCompensationDestination(ports, work) {
  const {
    ABYSSAL_FILAMENT_COMPENSATION_STATE,
    cloneValue,
    normalizeLowerText,
  } = ports;
  const {
    claim,
    session,
    deps,
  } = work;
  const destinationResult = resolveAbyssalFilamentCompensationDestination(ports,
    claim,
    session,
    deps,
  );
  if (!destinationResult.success) {
    return {
      success: false,
      refunded: false,
      errorMsg: destinationResult.errorMsg,
      claim: cloneValue(claim),
    };
  }
  const nowMs = toInt(deps && deps.now && deps.now(), Date.now());
  let pendingClaim = cloneValue(claim);
  if (
    normalizeLowerText(pendingClaim.state, "") !==
      ABYSSAL_FILAMENT_COMPENSATION_STATE.PENDING ||
    !abyssalFilamentCompensationDestinationMatches(ports,
      pendingClaim.destination,
      destinationResult.destination,
    )
  ) {
    const pendingPersistResult = persistAbyssalFilamentCompensationClaim(ports, {
      ...pendingClaim,
      state: ABYSSAL_FILAMENT_COMPENSATION_STATE.PENDING,
      destination: cloneValue(destinationResult.destination),
      updatedAtMs: nowMs,
      lastReceiptCheckAtMs: nowMs,
      lastReceiptCheckOutcome: "durably-absent",
    }, deps);
    if (!pendingPersistResult.success) {
      return {
        ...pendingPersistResult,
        refunded: false,
        claim: cloneValue(pendingClaim),
      };
    }
    pendingClaim = cloneValue(pendingPersistResult.data);
  }
  Object.assign(work, { destinationResult, nowMs, pendingClaim });
}

function persistCompensationApplyingClaim(ports, work) {
  const {
    ABYSSAL_FILAMENT_COMPENSATION_STATE,
    cloneValue,
    resolveTypeRecord,
  } = ports;
  const {
    deps,
    pendingClaim,
    destinationResult,
    nowMs,
  } = work;
  const applyingClaim = {
    ...pendingClaim,
    state: ABYSSAL_FILAMENT_COMPENSATION_STATE.APPLYING,
    destination: cloneValue(destinationResult.destination),
    attemptCount: toInt(pendingClaim.attemptCount, 0) + 1,
    lastAttemptAtMs: nowMs,
    updatedAtMs: nowMs,
  };
  const applyingPersistResult = persistAbyssalFilamentCompensationClaim(ports,
    applyingClaim,
    deps,
  );
  if (!applyingPersistResult.success) {
    return {
      ...applyingPersistResult,
      refunded: false,
      claim: cloneValue(pendingClaim),
    };
  }
  const durableApplyingClaim = cloneValue(applyingPersistResult.data);
  const filamentType = resolveTypeRecord(durableApplyingClaim.filamentTypeID, deps);
  if (!filamentType) {
    return {
      success: false,
      refunded: false,
      errorMsg: "FILAMENT_COMPENSATION_TYPE_UNAVAILABLE",
      claim: durableApplyingClaim,
    };
  }
  Object.assign(work, { durableApplyingClaim, filamentType });
}

function grantCompensation(ports, work) {
  const {
    ABYSSAL_FILAMENT_COMPENSATION_STATE,
  } = ports;
  const {
    deps,
    destinationResult,
    durableApplyingClaim,
    filamentType,
  } = work;
  let grantResult;
  try {
    grantResult = deps.grantItemToOwnerLocationIdempotent(
      destinationResult.destination.ownerID,
      destinationResult.destination.locationID,
      destinationResult.destination.flagID,
      filamentType,
      toInt(durableApplyingClaim.quantity, 0),
      {
        singleton: 0,
        customInfo: normalizeText(durableApplyingClaim.filamentCustomInfo, ""),
        receiptKey: durableApplyingClaim.receiptKey,
        receiptMetadata: {
          kind: "abyssal-filament-compensation",
          deploymentToken: durableApplyingClaim.deploymentToken,
          traceItemID: durableApplyingClaim.traceItemID,
          failureClass: durableApplyingClaim.failureClass,
        },
      },
    );
  } catch (error) {
    grantResult = {
      success: false,
      durable: false,
      ambiguous: true,
      errorMsg: normalizeText(error && error.message, "FILAMENT_COMPENSATION_GRANT_THREW"),
    };
  }
  if (!grantResult || grantResult.success !== true || grantResult.durable !== true) {
    const ambiguous = !grantResult || grantResult.ambiguous !== false;
    if (!ambiguous) {
      persistAbyssalFilamentCompensationClaim(ports, {
        ...durableApplyingClaim,
        state: ABYSSAL_FILAMENT_COMPENSATION_STATE.PENDING,
        lastError: normalizeText(
          grantResult && grantResult.errorMsg,
          "FILAMENT_COMPENSATION_GRANT_FAILED",
        ),
        updatedAtMs: toInt(deps && deps.now && deps.now(), Date.now()),
      }, deps);
    }
    return {
      success: false,
      refunded: false,
      ambiguous,
      errorMsg: normalizeText(
        grantResult && grantResult.errorMsg,
        ambiguous
          ? "FILAMENT_COMPENSATION_GRANT_AMBIGUOUS"
          : "FILAMENT_COMPENSATION_GRANT_FAILED",
      ),
      claim: durableApplyingClaim,
      grantResult,
    };
  }
  Object.assign(work, { grantResult });
}

function completeCompensationGrant(ports, work) {
  const {
    syncInventoryChanges,
    log,
  } = ports;
  const {
    session,
    deps,
    grantResult,
    durableApplyingClaim,
    destinationResult,
  } = work;
  syncInventoryChanges(
    session,
    grantResult.data && grantResult.data.changes,
    deps,
  );
  const completionResult = completeAbyssalFilamentCompensationClaim(ports,
    durableApplyingClaim,
    "refunded",
    deps,
    grantResult.receipt,
  );
  if (!completionResult.success) {
    return {
      ...completionResult,
      refunded: true,
      grantResult,
      claim: durableApplyingClaim,
    };
  }
  log.warn(
    `[AbyssalMgr] Filament consumption compensated ` +
      `char=${toInt(durableApplyingClaim.characterID, 0)} ` +
      `typeID=${toInt(durableApplyingClaim.filamentTypeID, 0)} ` +
      `quantity=${toInt(durableApplyingClaim.quantity, 0)} ` +
      `destination=${toInt(destinationResult.destination.locationID, 0)} ` +
      `reason=${normalizeText(durableApplyingClaim.failureReason, "deployment-rollback")}`,
  );
  return {
    ...completionResult,
    refunded: true,
    grantResult,
  };
}

function createAbyssalFilamentCompensation(ports) {
  return {
    classifyAbyssalFilamentCompensationFailure: classifyAbyssalFilamentCompensationFailure.bind(null, ports),
    persistAbyssalFilamentCompensationClaim: persistAbyssalFilamentCompensationClaim.bind(null, ports),
    readAbyssalFilamentCompensationClaim: readAbyssalFilamentCompensationClaim.bind(null, ports),
    resolveAbyssalFilamentCompensationSource: resolveAbyssalFilamentCompensationSource.bind(null, ports),
    buildAbyssalFilamentCompensationTraceIdentity: buildAbyssalFilamentCompensationTraceIdentity.bind(null, ports),
    abyssalFilamentCompensationTupleMatches: abyssalFilamentCompensationTupleMatches.bind(null, ports),
    stageAbyssalFilamentCompensationClaim: stageAbyssalFilamentCompensationClaim.bind(null, ports),
    isReachableAbyssalCompensationStation: isReachableAbyssalCompensationStation.bind(null, ports),
    resolveAbyssalFilamentCompensationDestination: resolveAbyssalFilamentCompensationDestination.bind(null, ports),
    abyssalFilamentCompensationDestinationMatches: abyssalFilamentCompensationDestinationMatches.bind(null, ports),
    abyssalFilamentCompensationReceiptMatchesClaim: abyssalFilamentCompensationReceiptMatchesClaim.bind(null, ports),
    markAbyssalFilamentCompensationTraceInvalidated: markAbyssalFilamentCompensationTraceInvalidated.bind(null, ports),
    completeAbyssalFilamentCompensationClaim: completeAbyssalFilamentCompensationClaim.bind(null, ports),
    settleAbyssalFilamentCompensationClaim: settleAbyssalFilamentCompensationClaim.bind(null, ports),
    invalidateFailedAbyssalDeploymentTrace: invalidateFailedAbyssalDeploymentTrace.bind(null, ports),
    ensureAbyssalFilamentCompensationTraceInvalidated: ensureAbyssalFilamentCompensationTraceInvalidated.bind(null, ports),
    reconcileAbyssalFilamentCompensationsForSession: reconcileAbyssalFilamentCompensationsForSession.bind(null, ports),
    compensateFailedAbyssalDeployment: compensateFailedAbyssalDeployment.bind(null, ports),
  };
}

module.exports = { createAbyssalFilamentCompensation };
