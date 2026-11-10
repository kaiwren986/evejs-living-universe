"use strict";

const { TYPE_ABYSSAL_TRACE } = require("../domain/abyssalGatePresentation");
const {
  ABYSSAL_TRACE_LIFECYCLE_PHASE,
  buildAbyssalTraceSlimState,
  normalizeAbyssalTraceLifecyclePhase,
  resolveAbyssalTraceAutomaticActivationDelayMs,
  resolveAbyssalTracePostReturnLifetimeMs,
  resolveAbyssalTraceProfile,
} = require("../catalog/abyssalTraceProfiles");
const {
  ABYSSAL_TRACE_RETIREMENT_FAMILY,
  ABYSSAL_TRACE_RETIREMENT_STAGE,
  createAbyssalTraceRetirementCoordinator,
} = require("./abyssalTraceRetirementCoordinator");
const { normalizeText } = require("../domain/abyssalValueUtils");

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function normalizeLowerText(value, fallback = "") {
  return normalizeText(value, fallback).toLowerCase();
}

// Stateless orchestration over the existing trace registry and current engine port.
// Metadata codecs, deployment compensation, and return obligations remain explicit
// injected seams during extraction; this module never imports the manager/runtime.
// cloneValue is injected deliberately: the manager's guarded structural clone is
// not interchangeable with the catalogue JSON clone.
function registerTrace({
  canRecoverCreatedAbyssalTraceAfterRestart,
  abyssalTraceStateRegistry,
}, traceState) {
  if (!traceState || toInt(traceState.traceItemID, 0) <= 0) {
    return;
  }

  const lifecyclePhase = normalizeAbyssalTraceLifecyclePhase(traceState.lifecyclePhase);
  const ownsActiveDeploymentLock = Boolean(
    lifecyclePhase === ABYSSAL_TRACE_LIFECYCLE_PHASE.ACTIVE ||
    (
      lifecyclePhase === ABYSSAL_TRACE_LIFECYCLE_PHASE.CREATED &&
      canRecoverCreatedAbyssalTraceAfterRestart(traceState)
    )
  );
  abyssalTraceStateRegistry.registerTrace(traceState, {
    ownsCharacterLock: ownsActiveDeploymentLock,
  });
}

function clearCreatedAbyssalTraceExpirySchedule({
  getDependencies,
  abyssalTraceStateRegistry,
},
  traceItemID,
  deps = getDependencies(),
) {
  const numericTraceItemID = toInt(traceItemID, 0);
  return abyssalTraceStateRegistry.clearCreatedExpirySchedule(
    numericTraceItemID,
    deps && deps.clearScheduledTimeout,
  );
}

function unregisterTrace({
  getDependencies,
  abyssalTraceStateRegistry,
  clearPendingAbyssalTraceActivationHandle,
}, traceItemID) {
  const numericTraceItemID = toInt(traceItemID, 0);
  const deps = getDependencies();
  return abyssalTraceStateRegistry.cleanupTrace(numericTraceItemID, {
    clearPendingActivation(record) {
      clearPendingAbyssalTraceActivationHandle(record, deps);
    },
    clearScheduledTimeout: deps && deps.clearScheduledTimeout,
  });
}

function getActiveTraceState({
  abyssalTraceStateRegistry,
  scheduleSourceTraceRemoval,
  readTraceStateFromItem,
  registerTrace,
  ensureSourceTraceRuntime,
  cloneValue,
}, traceItemID, deps) {
  const numericTraceItemID = toInt(traceItemID, 0);
  const cached = abyssalTraceStateRegistry.getTrace(numericTraceItemID) || null;
  if (cached) {
    if (
      normalizeAbyssalTraceLifecyclePhase(cached.lifecyclePhase) ===
      ABYSSAL_TRACE_LIFECYCLE_PHASE.RETURNED
    ) {
      scheduleSourceTraceRemoval(cached, deps);
    }
    return { ...cached };
  }

  const item = deps.findItemById(numericTraceItemID);
  const state = readTraceStateFromItem(item);
  if (!state) {
    return null;
  }
  registerTrace(state);
  ensureSourceTraceRuntime(state, deps);
  if (
    normalizeAbyssalTraceLifecyclePhase(state.lifecyclePhase) ===
    ABYSSAL_TRACE_LIFECYCLE_PHASE.RETURNED
  ) {
    scheduleSourceTraceRemoval(state, deps);
  }
  return cloneValue(state);
}

function persistTraceState({
  getDependencies,
  readTraceStateFromItem,
  buildTraceCustomInfo,
  cloneValue,
  registerTrace,
}, traceState, deps = getDependencies(), options = {}) {
  const traceItemID = toInt(traceState && traceState.traceItemID, 0);
  const item = traceItemID > 0 && typeof deps.findItemById === "function"
    ? deps.findItemById(traceItemID)
    : null;
  if (!item) {
    return { success: false, errorMsg: "TRACE_ITEM_MISSING", state: traceState };
  }
  const persistedState = readTraceStateFromItem(item);
  if (
    persistedState &&
    toInt(persistedState.characterID, 0) > 0 &&
    toInt(persistedState.characterID, 0) !== toInt(traceState.characterID, 0)
  ) {
    return { success: false, errorMsg: "TRACE_OWNER_MISMATCH", state: persistedState };
  }
  const customInfo = buildTraceCustomInfo(traceState);
  let persistedItem = item;
  let previousData = cloneValue(item);
  if (typeof deps.updateInventoryItem === "function") {
    const updateResult = deps.updateInventoryItem(traceItemID, (currentItem) => ({
      ...currentItem,
      customInfo,
    }));
    if (!updateResult || !updateResult.success || !updateResult.data) {
      return {
        success: false,
        errorMsg: normalizeText(
          updateResult && updateResult.errorMsg,
          "TRACE_METADATA_PERSIST_FAILED",
        ),
        state: traceState,
      };
    }
    persistedItem = updateResult.data;
    previousData = updateResult.previousData || previousData;
  } else {
    item.customInfo = customInfo;
  }
  if (options.register !== false) {
    registerTrace(traceState);
  }
  return {
    success: true,
    item: persistedItem,
    previousData,
    state: cloneValue(traceState),
  };
}

function publishSourceTraceInitial({
  getDependencies,
  GROUP_FILAMENT_TRACE,
  log,
}, traceState, deps = getDependencies(), options = {}) {
  const runtime = deps;
  const traceItemID = toInt(traceState && traceState.traceItemID, 0);
  const sourceSolarSystemID = toInt(
    traceState && traceState.sourceSolarSystemID,
    toInt(traceState && traceState.solarSystemID, 0),
  );
  const reason = normalizeText(options.reason, "deployment");
  const traceProfile = resolveAbyssalTraceProfile(traceState);
  const result = runtime && typeof runtime.publishAbyssalTraceInitial === "function"
      ? runtime.publishAbyssalTraceInitial(sourceSolarSystemID, traceItemID, {
        requiredCharacterID: toInt(traceState && traceState.characterID, 0),
        targetSession: options.targetSession || null,
        actorSession: options.actorSession || null,
        expectedTypeID: toInt(traceState && traceState.typeID, TYPE_ABYSSAL_TRACE),
        expectedGroupID: traceProfile
          ? toInt(traceState && traceState.groupID, GROUP_FILAMENT_TRACE)
          : undefined,
        expectedOwnerID: toInt(traceState && traceState.ownerID, 0),
        expectedActivationState: toInt(traceState && traceState.activationState, 0),
      })
    : {
        success: false,
        errorMsg: "TRACE_PUBLICATION_UNAVAILABLE",
        data: null,
      };
  const data = result && result.data || {};
  const publicationReceipt = data.actorPublicationReceipt || null;
  const publicationIdentity = publicationReceipt && publicationReceipt.sessionIdentity || {};
  const slimMetadata = data.slimMetadata || {};
  const failureReasons = Array.isArray(data.failures)
    ? data.failures.slice(0, 8).join("|")
    : "";
  const message =
    `[AbyssalTracePublication] trace=${traceItemID} itemID=${traceItemID} ` +
    `sceneKey=${normalizeText(traceState && traceState.sourceSceneKey, `solar-system:${sourceSolarSystemID}`)} ` +
    `system=${sourceSolarSystemID} sourceBubbleID=${toInt(data.sourceBubbleID, 0)} ` +
    `eligibleRecipients=${toInt(data.eligibleRecipients, 0)} ` +
    `publishedRecipients=${toInt(data.publishedRecipients, 0)} ` +
    `alreadyVisibleRecipients=${toInt(data.alreadyVisibleRecipients, 0)} ` +
    `actorDelivered=${data.actorDelivered === true} ` +
    `session=${toInt(publicationIdentity.clientID, 0)}:${toInt(publicationIdentity.characterID, 0)} ` +
    `addBallsStamp=${toInt(publicationReceipt && publicationReceipt.addBallsStamp, 0)} ` +
    `queuedAt=${toInt(publicationReceipt && publicationReceipt.queuedAt, 0)} ` +
    `writtenAt=${toInt(publicationReceipt && publicationReceipt.writtenAt, 0)} ` +
    `publicationComplete=${publicationReceipt && publicationReceipt.status === "complete"} ` +
    `slimTypeID=${toInt(slimMetadata.typeID, 0)} slimGroupID=${toInt(slimMetadata.groupID, 0)} ` +
    `slimOwnerID=${toInt(slimMetadata.ownerID, 0)} ` +
    `slimActivationState=${toInt(slimMetadata.activationState, -1)} ` +
    `status=${result && result.success ? "complete" : "failed"} reason=${reason}` +
    (failureReasons ? ` failures=${failureReasons}` : "");
  if (result && result.success) {
    log.info(message);
  } else {
    log.warn(message);
  }
  return result;
}

function isCompleteAbyssalTracePublicationReceipt({}, receipt, traceItemID = 0) {
  const expectedTraceItemID = toInt(traceItemID, 0);
  return Boolean(
    receipt &&
    receipt.status === "complete" &&
    toInt(receipt.traceItemID, 0) > 0 &&
    (expectedTraceItemID <= 0 || toInt(receipt.traceItemID, 0) === expectedTraceItemID) &&
    toInt(receipt.addBallsStamp, 0) > 0 &&
    toInt(receipt.writtenAt, 0) > 0 &&
    normalizeText(receipt.publicationToken, ""),
  );
}

function hasCommittedAbyssalFilamentConsumption({
  buildAbyssalTraceDeploymentToken,
}, traceState) {
  const state =
    traceState &&
    traceState.filamentConsumptionState &&
    typeof traceState.filamentConsumptionState === "object"
      ? traceState.filamentConsumptionState
      : null;
  const traceItemID = toInt(traceState && traceState.traceItemID, 0);
  const deploymentToken = normalizeText(
    traceState && traceState.deploymentToken,
    buildAbyssalTraceDeploymentToken(
      traceItemID,
      traceState && traceState.deployedAtMs,
    ),
  );
  const committedToken = normalizeText(state && state.deploymentToken, "");
  const requiredQuantity = Math.max(
    1,
    toInt(traceState && traceState.requiredFilaments, 1),
  );
  return Boolean(
    state &&
    normalizeLowerText(state.status, "") === "committed" &&
    traceItemID > 0 &&
    deploymentToken &&
    committedToken === deploymentToken &&
    toInt(state.filamentItemID, 0) === toInt(traceState && traceState.filamentItemID, 0) &&
    toInt(state.filamentTypeID, 0) === toInt(traceState && traceState.filamentTypeID, 0) &&
    toInt(state.quantity, 0) === requiredQuantity &&
    toInt(state.committedAtMs, 0) > 0
  );
}

function canRecoverCreatedAbyssalTraceAfterRestart({
  hasCommittedAbyssalFilamentConsumption,
  isCompleteAbyssalTracePublicationReceipt,
}, traceState) {
  return Boolean(
    hasCommittedAbyssalFilamentConsumption(traceState) ||
    // Compatibility for traces written before the explicit consume marker:
    // publication was ordered strictly after consumption, so a complete
    // server receipt is durable proof that this was not a pre-consume crash.
    isCompleteAbyssalTracePublicationReceipt(
      traceState && traceState.publicationReceipt,
      toInt(traceState && traceState.traceItemID, 0),
    )
  );
}

function persistAbyssalTracePublicationState({
  getDependencies,
  isCompleteAbyssalTracePublicationReceipt,
  cloneValue,
  persistTraceState,
},
  traceState,
  publicationResult,
  deps = getDependencies(),
) {
  const traceItemID = toInt(traceState && traceState.traceItemID, 0);
  const receipt =
    publicationResult &&
    publicationResult.data &&
    publicationResult.data.actorPublicationReceipt ||
    null;
  if (!isCompleteAbyssalTracePublicationReceipt(receipt, traceItemID)) {
    return {
      success: false,
      errorMsg: "ABYSSAL_TRACE_PUBLICATION_RECEIPT_INVALID",
      state: traceState,
    };
  }
  const traceProfile = resolveAbyssalTraceProfile(traceState);
  const delayMs = traceState && traceState.activateForFleet === true
    ? null
    : resolveAbyssalTraceAutomaticActivationDelayMs(traceProfile);
  const delayStartAtMs = toInt(receipt.writtenAt, 0);
  const nextState = {
    ...traceState,
    publicationReceipt: cloneValue(receipt),
    publicationStatus: "complete",
    ...(delayMs == null
      ? {}
      : {
          automaticActivation: {
            enabled: true,
            delayMs,
            scheduledAtMs: delayStartAtMs,
            dueAtMs: delayStartAtMs + delayMs,
            status: "activation-pending",
            publicationToken: normalizeText(receipt.publicationToken, ""),
          },
        }),
  };
  const persistResult = persistTraceState(nextState, deps, { register: false });
  return persistResult.success
    ? { ...persistResult, state: nextState, receipt: cloneValue(receipt) }
    : persistResult;
}

function ensureSourceTraceRuntime({
  getDependencies,
  getReadOnlySolarSystemScene,
}, traceState, deps = getDependencies()) {
  const traceItemID = toInt(traceState && traceState.traceItemID, 0);
  const sourceSolarSystemID = toInt(
    traceState && traceState.sourceSolarSystemID,
    toInt(traceState && traceState.solarSystemID, 0),
  );
  const item = traceItemID > 0 && typeof deps.findItemById === "function"
    ? deps.findItemById(traceItemID)
    : null;
  if (!item) {
    return { success: false, errorMsg: "TRACE_ITEM_MISSING", runtimeEntityPresent: false };
  }
  if (toInt(item.locationID, 0) !== sourceSolarSystemID) {
    return { success: false, errorMsg: "TRACE_SOURCE_SYSTEM_MISMATCH", runtimeEntityPresent: false };
  }
  const runtime = deps;
  const existingScene = getReadOnlySolarSystemScene(runtime, sourceSolarSystemID);
  const existingEntity = existingScene && typeof existingScene.getEntityByID === "function"
    ? existingScene.getEntityByID(traceItemID)
    : null;
  if (existingEntity) {
    return { success: true, rehydrated: false, runtimeEntityPresent: true, entity: existingEntity };
  }
  if (!runtime || typeof runtime.spawnDynamicInventoryEntity !== "function") {
    return { success: false, errorMsg: "TRACE_RUNTIME_UNAVAILABLE", runtimeEntityPresent: false };
  }
  const spawnResult = runtime.spawnDynamicInventoryEntity(sourceSolarSystemID, traceItemID);
  return {
    success: Boolean(spawnResult && spawnResult.success),
    rehydrated: Boolean(spawnResult && spawnResult.success),
    runtimeEntityPresent: Boolean(spawnResult && spawnResult.success),
    errorMsg: spawnResult && spawnResult.success
      ? null
      : normalizeText(spawnResult && spawnResult.errorMsg, "TRACE_RUNTIME_REHYDRATE_FAILED"),
    entity: spawnResult && spawnResult.data && spawnResult.data.entity || null,
  };
}

function buildReturnedSourceTraceRetirementIdentity({}, source = null) {
  return {
    traceItemID: toInt(source && source.traceItemID, 0),
    instanceID: toInt(
      source && source.instanceID,
      toInt(source && source.abyssalRunID, 0),
    ),
    characterID: toInt(source && source.characterID, 0),
    sourceSolarSystemID: toInt(source && source.sourceSolarSystemID, 0),
  };
}

function revalidateReturnedSourceTraceRetirement({
  getDependencies,
  buildReturnedSourceTraceRetirementIdentity,
  abyssalTraceStateRegistry,
  readTraceStateFromItem,
  isAbyssalReturnProtectionPending,
  isAbyssalSuspectReturnPending,
  resolveAbyssalReturnedTraceProtectionDeadlineMs,
},
  stageRequest,
  deps = getDependencies(),
) {
  const expectedIdentity = buildReturnedSourceTraceRetirementIdentity(stageRequest);
  const traceItemID = expectedIdentity.traceItemID;
  const item = traceItemID > 0 && typeof deps.findItemById === "function"
    ? deps.findItemById(traceItemID)
    : null;
  if (!item) {
    const activeState = abyssalTraceStateRegistry.getTrace(traceItemID) || null;
    const activeCharacterTraceID = abyssalTraceStateRegistry.getTraceIDForCharacter(
      expectedIdentity.characterID,
    );
    return {
      success: true,
      identity: expectedIdentity,
      lifecyclePhase: ABYSSAL_TRACE_LIFECYCLE_PHASE.RETURNED,
      removalDeadlineMs: 0,
      physicallyAbsent: true,
      alreadyRemoved: true,
      retirementFinalized: Boolean(
        !activeState &&
        toInt(activeCharacterTraceID, 0) !== traceItemID &&
        !abyssalTraceStateRegistry.hasRemovalSchedule(traceItemID)
      ),
      pendingReturnProtection: false,
      pendingSuspectReturn: false,
      pendingObligationDeadlineMs: 0,
      traceState: null,
    };
  }

  const traceState = readTraceStateFromItem(item);
  if (!traceState) {
    return { success: false, errorMsg: "TRACE_STATE_MISSING" };
  }
  const identity = buildReturnedSourceTraceRetirementIdentity(traceState);
  if (toInt(item.locationID, 0) !== identity.sourceSolarSystemID) {
    return {
      success: false,
      identity,
      errorMsg: "TRACE_OWNERSHIP_MISMATCH",
    };
  }
  const nowMs = toInt(stageRequest && stageRequest.nowMs, 0);
  return {
    success: true,
    identity,
    lifecyclePhase: normalizeAbyssalTraceLifecyclePhase(
      traceState.lifecyclePhase,
    ),
    removalDeadlineMs: toInt(traceState.removalDeadlineMs, 0),
    physicallyAbsent: false,
    alreadyRemoved: false,
    retirementFinalized: false,
    pendingReturnProtection: isAbyssalReturnProtectionPending(
      traceState,
      nowMs,
      deps,
    ),
    pendingSuspectReturn: isAbyssalSuspectReturnPending(traceState),
    pendingObligationDeadlineMs:
      resolveAbyssalReturnedTraceProtectionDeadlineMs(
        traceState,
        nowMs,
      ),
    traceState,
  };
}

function removeReturnedSourceTraceRepresentation({
  getDependencies,
  destroyPlaceholderTrace,
},
  stageRequest,
  deps = getDependencies(),
) {
  return destroyPlaceholderTrace(
    toInt(stageRequest && stageRequest.sourceSolarSystemID, 0),
    toInt(stageRequest && stageRequest.traceItemID, 0),
    deps,
    normalizeText(stageRequest && stageRequest.reason, "post-return-expiry"),
    "source K-space Abyssal Trace",
    { unregisterTrace: false },
  ) || {
    success: false,
    errorMsg: "TRACE_REMOVAL_FAILED",
  };
}

function finalizeReturnedSourceTraceRetirement({
  getDependencies,
  unregisterTrace,
  abyssalTraceStateRegistry,
},
  stageRequest,
  deps = getDependencies(),
) {
  const traceItemID = toInt(stageRequest && stageRequest.traceItemID, 0);
  unregisterTrace(traceItemID);
  return {
    success: true,
    traceItemID,
    scheduleCancelled: !abyssalTraceStateRegistry.hasRemovalSchedule(traceItemID),
  };
}

function attemptReturnedSourceTraceRetirement({
  getDependencies,
  buildReturnedSourceTraceRetirementIdentity,
  revalidateReturnedSourceTraceRetirement,
  removeReturnedSourceTraceRepresentation,
  finalizeReturnedSourceTraceRetirement,
  log,
},
  traceState,
  deps = getDependencies(),
  reason = "post-return-expiry",
  nowMs,
) {
  const identity = buildReturnedSourceTraceRetirementIdentity(traceState);
  const attemptNowMs = nowMs == null ? Number.NaN : Number(nowMs);
  const coordinator = createAbyssalTraceRetirementCoordinator({
    revalidateTraceRetirement(stageRequest) {
      return revalidateReturnedSourceTraceRetirement(stageRequest, deps);
    },
    removeTraceRepresentation(stageRequest) {
      return removeReturnedSourceTraceRepresentation(stageRequest, deps);
    },
    finalizeTraceRetirement(stageRequest) {
      return finalizeReturnedSourceTraceRetirement(stageRequest, deps);
    },
  });
  const result = coordinator.executeRetirement({
    traceFamily: ABYSSAL_TRACE_RETIREMENT_FAMILY.RETURNED_SOURCE_TRACE,
    ...identity,
    nowMs: attemptNowMs,
    reason,
  });
  if (result && result.success === true && result.deferred !== true) {
    log.info(
      `[AbyssalTraceLifecycle] run=${identity.instanceID} ` +
        `trace=${identity.traceItemID} phase=removed reason=${reason} ` +
        `inventoryRemoved=${Boolean(
          result.removalResult && result.removalResult.removed === true,
        )} runtimeRemoved=${Boolean(
          result.removalResult && result.removalResult.removalPath === "runtime",
        )} status=complete alreadyGone=${result.status === "already_retired"}`,
    );
  } else if (result && result.success !== true) {
    log.warn(
      `[AbyssalTraceLifecycle] run=${identity.instanceID} ` +
        `trace=${identity.traceItemID} phase=removed reason=${reason} ` +
        `status=failed stage=${normalizeText(result.stage, "unknown")} ` +
        `error=${normalizeText(result.errorMsg, "TRACE_RETIREMENT_FAILED")}`,
    );
  }
  return result;
}

function removeOwnedSourceTrace({
  getDependencies,
  unregisterTrace,
  log,
  readTraceStateFromItem,
  abyssalTraceStateRegistry,
  destroyPlaceholderTrace,
}, traceState, deps = getDependencies(), reason = "cleanup") {
  const traceItemID = toInt(traceState && traceState.traceItemID, 0);
  const sourceSolarSystemID = toInt(
    traceState && traceState.sourceSolarSystemID,
    toInt(traceState && traceState.solarSystemID, 0),
  );
  const item = traceItemID > 0 && typeof deps.findItemById === "function"
    ? deps.findItemById(traceItemID)
    : null;
  if (!item) {
    unregisterTrace(traceItemID);
    log.info(
      `[AbyssalTraceLifecycle] run=${toInt(traceState && traceState.abyssalRunID, 0)} ` +
        `trace=${traceItemID} phase=removed reason=${reason} inventoryRemoved=false ` +
        `runtimeRemoved=false status=complete alreadyGone=true`,
    );
    return { success: true, alreadyGone: true, removed: false };
  }
  const persistedState = readTraceStateFromItem(item);
  const ownershipMatches = Boolean(
    persistedState &&
      toInt(persistedState.traceItemID, 0) === traceItemID &&
      toInt(persistedState.characterID, 0) === toInt(traceState.characterID, 0) &&
      toInt(persistedState.sourceSolarSystemID, 0) === sourceSolarSystemID &&
      (
        toInt(traceState.abyssalRunID, 0) <= 0 ||
        toInt(persistedState.abyssalRunID, 0) === toInt(traceState.abyssalRunID, 0)
      )
  );
  if (!ownershipMatches || toInt(item.locationID, 0) !== sourceSolarSystemID) {
    log.warn(
      `[AbyssalTraceLifecycle] run=${toInt(traceState && traceState.abyssalRunID, 0)} ` +
        `trace=${traceItemID} phase=removed reason=${reason} inventoryRemoved=false ` +
        `runtimeRemoved=false status=failed ownershipMatch=false`,
    );
    return { success: false, failed: true, errorMsg: "TRACE_OWNERSHIP_MISMATCH" };
  }
  abyssalTraceStateRegistry.clearRemovalSchedule(
    traceItemID,
    deps && deps.clearScheduledTimeout,
  );
  const result = destroyPlaceholderTrace(
    sourceSolarSystemID,
    traceItemID,
    deps,
    reason,
    "source K-space Abyssal Trace",
  );
  log.info(
    `[AbyssalTraceLifecycle] run=${toInt(traceState && traceState.abyssalRunID, 0)} ` +
      `trace=${traceItemID} phase=removed reason=${reason} ` +
      `inventoryRemoved=${result && result.removed === true} ` +
      `runtimeRemoved=${result && result.removalPath === "runtime"} ` +
      `status=${result && result.success ? "complete" : "failed"}`,
  );
  return result;
}

function scheduleSourceTraceRemoval({
  getDependencies,
  resolveAbyssalReturnedTraceProtectionDeadlineMs,
  abyssalTraceStateRegistry,
  cloneValue,
  persistTraceState,
  attemptReturnedSourceTraceRetirement,
  scheduleSourceTraceRemoval,
  log,
}, traceState, deps = getDependencies(), reason = "post-return-expiry") {
  const profile = resolveAbyssalTraceProfile(traceState);
  const traceItemID = toInt(traceState && traceState.traceItemID, 0);
  if (!profile || traceItemID <= 0 || typeof deps.scheduleTimeout !== "function") {
    return { success: false, scheduled: false, errorMsg: "TRACE_REMOVAL_SCHEDULING_UNAVAILABLE" };
  }
  const nowMs = toInt(deps.now(), Date.now());
  const configuredLifetimeMs = resolveAbyssalTracePostReturnLifetimeMs(profile);
  const persistedDeadlineMs = toInt(traceState.removalDeadlineMs, 0);
  const returnProtectionDeadlineMs =
    resolveAbyssalReturnedTraceProtectionDeadlineMs(
      traceState,
      nowMs,
    );
  const deadlineMs = Math.max(
    persistedDeadlineMs > 0 ? persistedDeadlineMs : nowMs + configuredLifetimeMs,
    returnProtectionDeadlineMs,
  );
  const existingSchedule = abyssalTraceStateRegistry.getRemovalSchedule(traceItemID) || null;
  if (existingSchedule) {
    if (toInt(existingSchedule.deadlineMs, 0) >= deadlineMs) {
      return {
        success: true,
        scheduled: true,
        duplicate: true,
        deadlineMs: existingSchedule.deadlineMs,
        delayMs: Math.max(0, existingSchedule.deadlineMs - nowMs),
      };
    }
    abyssalTraceStateRegistry.clearRemovalSchedule(
      traceItemID,
      deps && deps.clearScheduledTimeout,
    );
  }
  const nextState = {
    ...cloneValue(traceState),
    removalScheduled: true,
    removalDeadlineMs: deadlineMs,
  };
  const persistResult = persistTraceState(nextState, deps);
  if (!persistResult.success) {
    return { success: false, scheduled: false, errorMsg: persistResult.errorMsg };
  }
  const runtime = deps;
  if (runtime && typeof runtime.updateAbyssalTracePresentation === "function") {
    runtime.updateAbyssalTracePresentation(
      nextState.sourceSolarSystemID,
      nextState.traceItemID,
      nextState,
    );
  }
  const delayMs = Math.max(0, deadlineMs - nowMs);
  const removalSchedule = {
    handle: null, deadlineMs, reason, state: cloneValue(nextState),
  };
  try {
    removalSchedule.handle = deps.scheduleTimeout(() => {
      if (!abyssalTraceStateRegistry.takeRemovalScheduleIfCurrent(
        traceItemID, removalSchedule,
      )) return;
      const callbackNowMs = toInt(deps.now(), 0);
      const retirementResult = attemptReturnedSourceTraceRetirement(
        nextState,
        deps,
        reason,
        callbackNowMs,
      );
      if (
        retirementResult &&
        retirementResult.success === true &&
        retirementResult.deferred === true &&
        toInt(retirementResult.retryAtMs, 0) > callbackNowMs
      ) {
        const revalidatedTraceState = retirementResult.stageResults &&
          retirementResult.stageResults[
            ABYSSAL_TRACE_RETIREMENT_STAGE.REVALIDATE
          ] &&
          retirementResult.stageResults[
            ABYSSAL_TRACE_RETIREMENT_STAGE.REVALIDATE
          ].traceState;
        scheduleSourceTraceRemoval(
          revalidatedTraceState || nextState,
          deps,
          reason,
        );
      }
    }, delayMs);
  } catch (error) {
    const errorMsg = normalizeText(
      error && error.message,
      "TRACE_REMOVAL_SCHEDULING_FAILED",
    );
    const retryableState = {
      ...cloneValue(nextState),
      removalScheduled: false,
      removalScheduleError: errorMsg,
    };
    persistTraceState(retryableState, deps);
    if (runtime && typeof runtime.updateAbyssalTracePresentation === "function") {
      runtime.updateAbyssalTracePresentation(
        retryableState.sourceSolarSystemID,
        retryableState.traceItemID,
        retryableState,
      );
    }
    log.warn(
      `[AbyssalTraceLifecycle] trace removal scheduling failed ` +
        `trace=${traceItemID} reason=${errorMsg}`,
    );
    return {
      success: false,
      scheduled: false,
      retryable: true,
      deadlineMs,
      delayMs,
      state: retryableState,
      errorMsg,
    };
  }
  abyssalTraceStateRegistry.setRemovalSchedule(traceItemID, removalSchedule);
  return { success: true, scheduled: true, deadlineMs, delayMs, state: nextState };
}

function transitionSourceTraceState({
  getDependencies,
  cloneValue,
  persistTraceState,
  clearCreatedAbyssalTraceExpirySchedule,
}, traceState, lifecyclePhase, deps = getDependencies(), options = {}) {
  const profile = resolveAbyssalTraceProfile(traceState);
  if (!profile) {
    return { success: true, skipped: true, state: traceState };
  }
  const normalizedPhase = normalizeAbyssalTraceLifecyclePhase(lifecyclePhase);
  const phaseSlimState = buildAbyssalTraceSlimState({
    ...traceState,
    lifecyclePhase: normalizedPhase,
  });
  const slimFields = phaseSlimState && phaseSlimState.slimFields || {};
  const nextState = {
    ...cloneValue(traceState),
    ...cloneValue(slimFields),
    lifecyclePhase: normalizedPhase,
    traceProfileID: profile.traceProfileID,
    abyssalRunID: toInt(options.abyssalRunID, toInt(traceState.abyssalRunID, 0)),
    ...(normalizedPhase === ABYSSAL_TRACE_LIFECYCLE_PHASE.RETURNED
      ? { returnedAtMs: toInt(options.returnedAtMs, toInt(deps.now(), 0)) }
      : {}),
  };
  const persistResult = persistTraceState(nextState, deps);
  if (!persistResult.success) {
    return persistResult;
  }
  if (normalizedPhase !== ABYSSAL_TRACE_LIFECYCLE_PHASE.CREATED) {
    clearCreatedAbyssalTraceExpirySchedule(nextState.traceItemID, deps);
  }
  const runtime = deps;
  if (
    options.broadcast === true &&
    runtime &&
    typeof runtime.updateAbyssalTracePresentation === "function"
  ) {
    const runtimeResult = runtime.updateAbyssalTracePresentation(
      nextState.sourceSolarSystemID,
      nextState.traceItemID,
      nextState,
    );
    return { ...persistResult, runtimeResult, state: nextState };
  }
  return { ...persistResult, state: nextState };
}

function buildAbyssalTraceDeploymentToken({}, traceItemID, deployedAtMs) {
  return `${toInt(traceItemID, 0)}:${toInt(deployedAtMs, 0)}`;
}

function isCreatedAbyssalTraceExpired({}, traceState, nowMs) {
  return Boolean(
    traceState &&
    normalizeAbyssalTraceLifecyclePhase(traceState.lifecyclePhase) ===
      ABYSSAL_TRACE_LIFECYCLE_PHASE.CREATED &&
    toInt(traceState.expiresAtMs, 0) > 0 &&
    toInt(nowMs, 0) >= toInt(traceState.expiresAtMs, 0)
  );
}

function expireCreatedAbyssalTrace({
  getDependencies,
  clearPendingAbyssalTraceActivation,
  clearCreatedAbyssalTraceExpirySchedule,
  invalidateFailedAbyssalDeploymentTrace,
  log,
},
  traceState,
  deps = getDependencies(),
  reason = "created-trace-expired",
) {
  const traceItemID = toInt(traceState && traceState.traceItemID, 0);
  if (
    traceItemID <= 0 ||
    normalizeAbyssalTraceLifecyclePhase(traceState && traceState.lifecyclePhase) !==
      ABYSSAL_TRACE_LIFECYCLE_PHASE.CREATED
  ) {
    return { success: true, expired: false, skipped: true };
  }
  const nowMs = toInt(deps && deps.now && deps.now(), Date.now());
  const expiresAtMs = toInt(traceState.expiresAtMs, 0);
  if (expiresAtMs <= 0 || nowMs < expiresAtMs) {
    return {
      success: true,
      expired: false,
      skipped: true,
      expiresAtMs,
    };
  }
  clearPendingAbyssalTraceActivation(traceItemID, deps);
  clearCreatedAbyssalTraceExpirySchedule(traceItemID, deps);
  const invalidationResult = invalidateFailedAbyssalDeploymentTrace(
    traceState,
    deps,
    reason,
  );
  log.warn(
    `[AbyssalTraceLifecycle] run=0 trace=${traceItemID} phase=expired ` +
      `expiresAtMs=${expiresAtMs} nowMs=${nowMs} ` +
      `invalidationMode=${normalizeText(
        invalidationResult && invalidationResult.invalidationMode,
        "failed",
      )} status=${invalidationResult && invalidationResult.success ? "complete" : "failed"}`,
  );
  return {
    ...invalidationResult,
    expired: true,
    traceItemID,
    expiresAtMs,
    nowMs,
  };
}

function scheduleCreatedAbyssalTraceExpiry({
  getDependencies,
  expireCreatedAbyssalTrace,
  abyssalTraceStateRegistry,
  clearCreatedAbyssalTraceExpirySchedule,
  getActiveTraceState,
  isCreatedAbyssalTraceExpired,
  scheduleCreatedAbyssalTraceExpiry,
},
  traceState,
  deps = getDependencies(),
  reason = "created-trace-expired",
) {
  const traceItemID = toInt(traceState && traceState.traceItemID, 0);
  const expiresAtMs = toInt(traceState && traceState.expiresAtMs, 0);
  if (
    traceItemID <= 0 ||
    expiresAtMs <= 0 ||
    normalizeAbyssalTraceLifecyclePhase(traceState && traceState.lifecyclePhase) !==
      ABYSSAL_TRACE_LIFECYCLE_PHASE.CREATED
  ) {
    return { success: true, scheduled: false, skipped: true };
  }
  const nowMs = toInt(deps && deps.now && deps.now(), Date.now());
  if (nowMs >= expiresAtMs) {
    const expirationResult = expireCreatedAbyssalTrace(traceState, deps, reason);
    return {
      success: Boolean(expirationResult && expirationResult.success),
      scheduled: false,
      expired: true,
      expirationResult,
    };
  }
  if (!deps || typeof deps.scheduleTimeout !== "function") {
    return {
      success: false,
      scheduled: false,
      errorMsg: "TRACE_EXPIRY_SCHEDULING_UNAVAILABLE",
    };
  }
  const existingSchedule = abyssalTraceStateRegistry.getCreatedExpirySchedule(traceItemID) || null;
  if (existingSchedule && toInt(existingSchedule.deadlineMs, 0) === expiresAtMs) {
    return {
      success: true,
      scheduled: true,
      duplicate: true,
      deadlineMs: expiresAtMs,
      delayMs: Math.max(0, expiresAtMs - nowMs),
    };
  }
  clearCreatedAbyssalTraceExpirySchedule(traceItemID, deps);
  const delayMs = Math.max(0, expiresAtMs - nowMs);
  const expirySchedule = { handle: null, deadlineMs: expiresAtMs, reason };
  try {
    expirySchedule.handle = deps.scheduleTimeout(() => {
      if (!abyssalTraceStateRegistry.takeCreatedExpiryScheduleIfCurrent(
        traceItemID, expirySchedule,
      )) return;
      const currentTraceState = getActiveTraceState(traceItemID, deps);
      if (
        !currentTraceState ||
        normalizeAbyssalTraceLifecyclePhase(currentTraceState.lifecyclePhase) !==
          ABYSSAL_TRACE_LIFECYCLE_PHASE.CREATED
      ) {
        return;
      }
      const callbackNowMs = toInt(deps && deps.now && deps.now(), Date.now());
      if (!isCreatedAbyssalTraceExpired(currentTraceState, callbackNowMs)) {
        scheduleCreatedAbyssalTraceExpiry(currentTraceState, deps, reason);
        return;
      }
      expireCreatedAbyssalTrace(currentTraceState, deps, reason);
    }, delayMs);
  } catch (error) {
    return {
      success: false,
      scheduled: false,
      deadlineMs: expiresAtMs,
      delayMs,
      errorMsg: normalizeText(
        error && error.message,
        "TRACE_EXPIRY_SCHEDULING_FAILED",
      ),
    };
  }
  abyssalTraceStateRegistry.setCreatedExpirySchedule(traceItemID, expirySchedule);
  return {
    success: true,
    scheduled: true,
    deadlineMs: expiresAtMs,
    delayMs,
  };
}

// Capture supplied capabilities once, as the original closure did. Internal
// callbacks are bound once per instance; no runtime state lives in this wiring.
function createAbyssalTraceLifecycle({
  getDependencies,
  abyssalTraceStateRegistry,
  buildTraceCustomInfo,
  readTraceStateFromItem,
  cloneValue,
  getReadOnlySolarSystemScene,
  destroyPlaceholderTrace,
  clearPendingAbyssalTraceActivation,
  clearPendingAbyssalTraceActivationHandle,
  invalidateFailedAbyssalDeploymentTrace,
  isAbyssalReturnProtectionPending,
  isAbyssalSuspectReturnPending,
  resolveAbyssalReturnedTraceProtectionDeadlineMs,
  log,
  GROUP_FILAMENT_TRACE,
}) {

  const ports = {
    getDependencies,
    abyssalTraceStateRegistry,
    buildTraceCustomInfo,
    readTraceStateFromItem,
    cloneValue,
    getReadOnlySolarSystemScene,
    destroyPlaceholderTrace,
    clearPendingAbyssalTraceActivation,
    clearPendingAbyssalTraceActivationHandle,
    invalidateFailedAbyssalDeploymentTrace,
    isAbyssalReturnProtectionPending,
    isAbyssalSuspectReturnPending,
    resolveAbyssalReturnedTraceProtectionDeadlineMs,
    log,
    GROUP_FILAMENT_TRACE,
  };
  ports.registerTrace = registerTrace.bind(null, ports);
  ports.clearCreatedAbyssalTraceExpirySchedule = clearCreatedAbyssalTraceExpirySchedule.bind(null, ports);
  ports.unregisterTrace = unregisterTrace.bind(null, ports);
  ports.getActiveTraceState = getActiveTraceState.bind(null, ports);
  ports.persistTraceState = persistTraceState.bind(null, ports);
  ports.publishSourceTraceInitial = publishSourceTraceInitial.bind(null, ports);
  ports.isCompleteAbyssalTracePublicationReceipt = isCompleteAbyssalTracePublicationReceipt.bind(null, ports);
  ports.hasCommittedAbyssalFilamentConsumption = hasCommittedAbyssalFilamentConsumption.bind(null, ports);
  ports.canRecoverCreatedAbyssalTraceAfterRestart = canRecoverCreatedAbyssalTraceAfterRestart.bind(null, ports);
  ports.persistAbyssalTracePublicationState = persistAbyssalTracePublicationState.bind(null, ports);
  ports.ensureSourceTraceRuntime = ensureSourceTraceRuntime.bind(null, ports);
  ports.buildReturnedSourceTraceRetirementIdentity = buildReturnedSourceTraceRetirementIdentity.bind(null, ports);
  ports.revalidateReturnedSourceTraceRetirement = revalidateReturnedSourceTraceRetirement.bind(null, ports);
  ports.removeReturnedSourceTraceRepresentation = removeReturnedSourceTraceRepresentation.bind(null, ports);
  ports.finalizeReturnedSourceTraceRetirement = finalizeReturnedSourceTraceRetirement.bind(null, ports);
  ports.attemptReturnedSourceTraceRetirement = attemptReturnedSourceTraceRetirement.bind(null, ports);
  ports.removeOwnedSourceTrace = removeOwnedSourceTrace.bind(null, ports);
  ports.scheduleSourceTraceRemoval = scheduleSourceTraceRemoval.bind(null, ports);
  ports.transitionSourceTraceState = transitionSourceTraceState.bind(null, ports);
  ports.buildAbyssalTraceDeploymentToken = buildAbyssalTraceDeploymentToken.bind(null, ports);
  ports.isCreatedAbyssalTraceExpired = isCreatedAbyssalTraceExpired.bind(null, ports);
  ports.expireCreatedAbyssalTrace = expireCreatedAbyssalTrace.bind(null, ports);
  ports.scheduleCreatedAbyssalTraceExpiry = scheduleCreatedAbyssalTraceExpiry.bind(null, ports);
  Object.freeze(ports);
  return Object.freeze({
    registerTrace: ports.registerTrace,
    clearCreatedAbyssalTraceExpirySchedule: ports.clearCreatedAbyssalTraceExpirySchedule,
    unregisterTrace: ports.unregisterTrace,
    getActiveTraceState: ports.getActiveTraceState,
    persistTraceState: ports.persistTraceState,
    publishSourceTraceInitial: ports.publishSourceTraceInitial,
    isCompleteAbyssalTracePublicationReceipt: ports.isCompleteAbyssalTracePublicationReceipt,
    hasCommittedAbyssalFilamentConsumption: ports.hasCommittedAbyssalFilamentConsumption,
    canRecoverCreatedAbyssalTraceAfterRestart: ports.canRecoverCreatedAbyssalTraceAfterRestart,
    persistAbyssalTracePublicationState: ports.persistAbyssalTracePublicationState,
    ensureSourceTraceRuntime: ports.ensureSourceTraceRuntime,
    buildReturnedSourceTraceRetirementIdentity: ports.buildReturnedSourceTraceRetirementIdentity,
    revalidateReturnedSourceTraceRetirement: ports.revalidateReturnedSourceTraceRetirement,
    removeReturnedSourceTraceRepresentation: ports.removeReturnedSourceTraceRepresentation,
    finalizeReturnedSourceTraceRetirement: ports.finalizeReturnedSourceTraceRetirement,
    attemptReturnedSourceTraceRetirement: ports.attemptReturnedSourceTraceRetirement,
    removeOwnedSourceTrace: ports.removeOwnedSourceTrace,
    scheduleSourceTraceRemoval: ports.scheduleSourceTraceRemoval,
    transitionSourceTraceState: ports.transitionSourceTraceState,
    buildAbyssalTraceDeploymentToken: ports.buildAbyssalTraceDeploymentToken,
    isCreatedAbyssalTraceExpired: ports.isCreatedAbyssalTraceExpired,
    expireCreatedAbyssalTrace: ports.expireCreatedAbyssalTrace,
    scheduleCreatedAbyssalTraceExpiry: ports.scheduleCreatedAbyssalTraceExpiry,
  });
}

module.exports = { createAbyssalTraceLifecycle };
