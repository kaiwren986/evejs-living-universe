"use strict";

const { normalizeText } = require("../domain/abyssalValueUtils");

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

// Startup reconciles durable terminal effects before any administrative return.
// Location resolution and residual teardown remain distinct retry obligations.
function buildAbyssalStartupReconciliationContext({
  log,
  inspectAbyssalTaggedSpaceItem,
}, input) {
  const { currentSystemID, deps, reason, session, activeInstances, discoveryPass, recoveryNowMs } = input;
  log.info(
    `[AbyssalStartup] recovery reconciliation begin reason=${reason} ` +
      `activeRuns=${Array.isArray(activeInstances) ? activeInstances.length : 0} ` +
      `currentSystem=${toInt(currentSystemID, 0)}`,
  );
  const recoveredInstanceIDs = [];
  const completedExitInstanceIDs = [];
  const completedDeathInstanceIDs = [];
  const completedCleanupInstanceIDs = [];
  const shutdownReturnedInstanceIDs = [];
  const evacuatedShipIDs = [];
  const failedInstanceIDs = [];
  const failedCharacterIDs = [];
  // Participants whose persisted location could not be resolved at all. Only
  // these may gate a login: once the ship is back in k-space, residual pocket
  // cleanup is bookkeeping and must never stand between the owner and space.
  const unresolvedCharacterIDs = [];
  const resolvedButUncleanedInstanceIDs = [];
  const cleanedSystemIDs = new Set();
  const recoveredTraceItemIDs = [];
  const traceRecoveryWarnings = [];
  if (toInt(currentSystemID, 0) > 0) {
    cleanedSystemIDs.add(toInt(currentSystemID, 0));
  }
  if (discoveryPass && deps && typeof deps.getAllItems === "function") {
    const allItemsSource = deps.getAllItems();
    const allItems = Array.isArray(allItemsSource)
      ? allItemsSource
      : allItemsSource && typeof allItemsSource === "object"
        ? Object.values(allItemsSource)
        : [];
    for (const item of allItems) {
      const artifact = inspectAbyssalTaggedSpaceItem(item);
      if (!artifact || artifact.role === "unknownTaggedArtifact") {
        continue;
      }
      const artifactSystemID = toInt(
        item && item.spaceState && item.spaceState.systemID,
        toInt(item && item.locationID, 0),
      );
      if (artifactSystemID > 0) {
        cleanedSystemIDs.add(artifactSystemID);
      }
    }
  }
  return { ...input, recoveredInstanceIDs, completedExitInstanceIDs, completedDeathInstanceIDs, completedCleanupInstanceIDs, shutdownReturnedInstanceIDs, evacuatedShipIDs, failedInstanceIDs, failedCharacterIDs, unresolvedCharacterIDs, resolvedButUncleanedInstanceIDs, cleanedSystemIDs, recoveredTraceItemIDs, traceRecoveryWarnings };
}

function rehydrateAbyssalStartupRun({
  readTraceStateFromItem,
  restoreAbyssalTimerDeadlineAfterRestart,
  buildPocketStateFromInstance,
  log,
  ensureAbyssalPocketDurablyAdopted,
  abyssalMaintenanceState,
  cloneValue,
  logRecoveredT0DarkLayoutSelection,
  logRecoveredAbyssalSceneMode,
  normalizeAbyssalTraceLifecyclePhase,
}, pass, instance) {
  const { deps, failedInstanceIDs, failedCharacterIDs, unresolvedCharacterIDs, completedCleanupInstanceIDs, cleanedSystemIDs } = pass;
  const instanceID = toInt(instance && instance.instanceID, 0);
  if (instanceID <= 0) {
    return null;
  }
  const metadata = instance && instance.metadata && typeof instance.metadata === "object"
    ? instance.metadata
    : {};
  const traceItemID = toInt(metadata.sourceTraceItemID, 0);
  const traceItem = traceItemID > 0 && typeof deps.findItemById === "function"
    ? deps.findItemById(traceItemID)
    : null;
  const persistedTraceState = readTraceStateFromItem(traceItem);
  let pocketState = restoreAbyssalTimerDeadlineAfterRestart(
    buildPocketStateFromInstance(instance, persistedTraceState),
    deps,
  );
  const characterID = toInt(pocketState && pocketState.characterID, 0);
  const shipID = toInt(pocketState && pocketState.shipID, 0);
  const sourceSystemID = toInt(pocketState && pocketState.sourceSolarSystemID, 0);
  if (characterID <= 0 || shipID <= 0 || sourceSystemID <= 0) {
    failedInstanceIDs.push(instanceID);
    if (characterID > 0) {
      failedCharacterIDs.push(characterID);
      unresolvedCharacterIDs.push(characterID);
    }
    log.warn(
      `[AbyssalStartup] recovery rehydrate failed instance=${instanceID} ` +
        `character=${characterID} ship=${shipID} sourceSystem=${sourceSystemID} ` +
        `reason=INCOMPLETE_PERSISTED_RUN_IDENTITY`,
    );
    return null;
  }

  const adoptionResult = ensureAbyssalPocketDurablyAdopted(
    pocketState,
    deps,
    { verifyReadBack: true },
  );
  if (!adoptionResult || adoptionResult.success !== true) {
    const adoptionFailureReason = normalizeText(
      adoptionResult && adoptionResult.errorMsg,
      "ABYSSAL_POCKET_DURABLE_ADOPTION_FAILED",
    );
    const priorRetryState =
      abyssalMaintenanceState.getRecoveryRetryState(instanceID) || null;
    if (
      adoptionFailureReason === "ABYSSAL_POCKET_DURABLE_ADOPTION_SOURCE_MISSING" &&
      priorRetryState &&
      priorRetryState.participantLocationResolved === true
    ) {
      // A prior pass already proved that the participant left the Abyssal
      // host and classified the remaining work as terminal bookkeeping. If
      // that cleanup subsequently purged the durable dungeon row, the retry
      // snapshot must not turn the resolved K-space location back into an
      // unresolved login blocker.
      completedCleanupInstanceIDs.push(instanceID);
      cleanedSystemIDs.add(sourceSystemID);
      const cleanupHostSystemID = toInt(instance && instance.solarSystemID, 0);
      if (cleanupHostSystemID > 0) {
        cleanedSystemIDs.add(cleanupHostSystemID);
      }
      log.info(
        `[AbyssalStartup] residual cleanup already purged instance=${instanceID} ` +
          `character=${characterID} ship=${shipID} ` +
          `priorStage=${normalizeText(priorRetryState.stage, "residual_cleanup")}`,
      );
      return null;
    }
    failedInstanceIDs.push(instanceID);
    failedCharacterIDs.push(characterID);
    unresolvedCharacterIDs.push(characterID);
    log.warn(
      `[AbyssalStartup] recovery rehydrate failed instance=${instanceID} ` +
        `character=${characterID} ship=${shipID} sourceSystem=${sourceSystemID} ` +
        `reason=${adoptionFailureReason}`,
    );
    return null;
  }
  pocketState = cloneValue(
    adoptionResult.committedState || adoptionResult.state,
  );
  logRecoveredT0DarkLayoutSelection(pocketState);
  logRecoveredAbyssalSceneMode(pocketState, deps);

  // A process restart is an administrative interruption and must not create a
  // new gameplay timeout or destruction outcome. However, a terminal outcome
  // that was durably committed before restart must be reconciled and must never
  // be converted into a safe administrative return.
  const startupTracePhase = normalizeAbyssalTraceLifecyclePhase(
    persistedTraceState && persistedTraceState.lifecyclePhase,
  );

  // Do not perform the general startup safe return here.
  //
  // Recovery below must first reconcile:
  // 1. pending terminal cleanup,
  // 2. inferred participant hull loss,
  // 3. committed participant death,
  // 4. an already committed final exit,
  // 5. persisted terminal failure outcomes.
  //
  // Only a proven nonterminal run should reach the later administrative
  // safe-return path.
  return { ...pass, instance, instanceID, pocketState, characterID, shipID, sourceSystemID, traceItemID, persistedTraceState, startupTracePhase };
}

function reconcileAbyssalStartupCleanup({
  hasPendingAbyssalTerminalCleanup,
  requiresAbyssalParticipantDestructionReceiptForCleanup,
  hasDurableAbyssalParticipantPodDestructionReceipt,
  getAbyssalTerminalCleanupState,
  cleanupAbyssalRun,
  getCharacterID,
  log,
  hasUnresolvedAbyssalRecoveryObligation,
  resolveAbyssalRecoveryCleanupReason,
}, context) {
  const { deps, reason, session, instance, instanceID, characterID, shipID, sourceSystemID, pocketState, cleanedSystemIDs, completedCleanupInstanceIDs, failedInstanceIDs,
    failedCharacterIDs, resolvedButUncleanedInstanceIDs } = context;
  const startupCleanupBlockedByMissingPodReceipt = Boolean(
    hasPendingAbyssalTerminalCleanup(pocketState) &&
    requiresAbyssalParticipantDestructionReceiptForCleanup(
      pocketState,
      deps,
    ) &&
    !hasDurableAbyssalParticipantPodDestructionReceipt(pocketState)
  );
  if (
    hasPendingAbyssalTerminalCleanup(pocketState) &&
    !startupCleanupBlockedByMissingPodReceipt
  ) {
    const cleanupState = getAbyssalTerminalCleanupState(pocketState) || {};
    const cleanupResult = cleanupAbyssalRun(pocketState, deps, {
      reason: normalizeText(cleanupState.reason, "startup-cleanup-retry"),
      session:
        session && getCharacterID(session) === characterID
          ? session
          : null,
    });
    const cleanupHostSystemID = toInt(instance && instance.solarSystemID, 0);
    cleanedSystemIDs.add(sourceSystemID);
    if (cleanupHostSystemID > 0) {
      cleanedSystemIDs.add(cleanupHostSystemID);
    }
    if (cleanupResult && cleanupResult.success === true) {
      completedCleanupInstanceIDs.push(instanceID);
      log.info(
        `[AbyssalStartup] pending cleanup reconciled instance=${instanceID} ` +
          `character=${characterID} ship=${shipID}`,
      );
    } else {
      failedInstanceIDs.push(instanceID);
      failedCharacterIDs.push(characterID);
      // Terminal cleanup only runs after the run reached a terminal outcome,
      // by which point the participant is already back in k-space.
      resolvedButUncleanedInstanceIDs.push(instanceID);
      log.warn(
        `[AbyssalStartup] pending cleanup remains instance=${instanceID} ` +
          `character=${characterID} ship=${shipID} reason=${normalizeText(
            cleanupResult && cleanupResult.errorMsg,
            "ABYSSAL_STARTUP_CLEANUP_RETRY_FAILED",
          )}`,
      );
    }
    return true;
  }
  if (startupCleanupBlockedByMissingPodReceipt) {
    log.warn(
      `[AbyssalStartup] pending cleanup deferred until durable pod receipt ` +
        `instance=${instanceID} character=${characterID} ship=${shipID}`,
    );
  }
  if (
    !hasPendingAbyssalTerminalCleanup(pocketState) &&
    pocketState.gameplayAuthorityDetached === true &&
    hasUnresolvedAbyssalRecoveryObligation(pocketState)
  ) {
    const cleanupResult = cleanupAbyssalRun(pocketState, deps, {
      reason: resolveAbyssalRecoveryCleanupReason(
        pocketState,
        "startup-detached-cleanup-retry",
      ),
      session:
        session && getCharacterID(session) === characterID
          ? session
          : null,
    });
    const cleanupHostSystemID = toInt(instance && instance.solarSystemID, 0);
    cleanedSystemIDs.add(sourceSystemID);
    if (cleanupHostSystemID > 0) {
      cleanedSystemIDs.add(cleanupHostSystemID);
    }
    if (cleanupResult && cleanupResult.success === true) {
      completedCleanupInstanceIDs.push(instanceID);
      log.info(
        `[AbyssalStartup] detached cleanup reconciled instance=${instanceID} ` +
          `character=${characterID} ship=${shipID}`,
      );
    } else {
      failedInstanceIDs.push(instanceID);
      failedCharacterIDs.push(characterID);
      resolvedButUncleanedInstanceIDs.push(instanceID);
      log.warn(
        `[AbyssalStartup] detached cleanup remains instance=${instanceID} ` +
          `character=${characterID} ship=${shipID} reason=${normalizeText(
            cleanupResult && cleanupResult.errorMsg,
            "ABYSSAL_STARTUP_DETACHED_CLEANUP_RETRY_FAILED",
          )}`,
      );
    }
    return true;
  }
  return false;
}

function reconcileAbyssalStartupDeath({
  ABYSSAL_TRACE_LIFECYCLE_PHASE,
  inferUnrecordedAbyssalHullLossAfterRestart,
  getCharacterID,
  reconcileCommittedAbyssalParticipantDeath,
}, context) {
  let { pocketState } = context;
  const { deps, reason, session, instance, instanceID, characterID, shipID, sourceSystemID, startupTracePhase, cleanedSystemIDs, completedDeathInstanceIDs, recoveredInstanceIDs } = context;
  const inferredHullLoss = startupTracePhase === ABYSSAL_TRACE_LIFECYCLE_PHASE.RETURNED
    ? { inferred: false, reason: "STARTUP_RETURN_ALREADY_COMMITTED" }
    : inferUnrecordedAbyssalHullLossAfterRestart(
        pocketState,
        session && getCharacterID(session) === characterID ? session : null,
        deps,
      );
  if (inferredHullLoss.inferred === true && inferredHullLoss.pocketState) {
    pocketState = inferredHullLoss.pocketState;
  }

  const participantDeathRecovery = startupTracePhase === ABYSSAL_TRACE_LIFECYCLE_PHASE.RETURNED
    ? { reconciled: false, reason: "STARTUP_RETURN_ALREADY_COMMITTED" }
    : reconcileCommittedAbyssalParticipantDeath(
        pocketState,
        session && getCharacterID(session) === characterID ? session : null,
        deps,
      );
  if (participantDeathRecovery.reconciled === true) {
    const deathHostSystemID = toInt(instance && instance.solarSystemID, 0);
    cleanedSystemIDs.add(sourceSystemID);
    if (deathHostSystemID > 0) {
      cleanedSystemIDs.add(deathHostSystemID);
    }
    if (participantDeathRecovery.completed === true) {
      completedDeathInstanceIDs.push(instanceID);
    } else {
      recoveredInstanceIDs.push(instanceID);
    }
    return true;
  }
  context.pocketState = pocketState;
  return false;
}

function inspectAbyssalStartupCommittedExit({
  getPendingAbyssalTransitionState,
  normalizeAbyssalTraceLifecyclePhase,
  getObjectPosition,
  buildPlaceholderReturnSpaceState,
  getVectorDistance,
  normalizeLowerText,
  ABYSSAL_TRACE_LIFECYCLE_PHASE,
}, context) {
  const { deps, instance, shipID, sourceSystemID, pocketState, persistedTraceState } = context;
  // Deferred transition callbacks only live in process memory. Reconcile the
  // durable side effects before clearing a stale post-restart lock: an exit
  // whose ship (or source Trace) has already committed to K-space must finish
  // cleanup, while entry/room handoffs can safely resume from the last
  // persisted room after their orphaned intent is cancelled.
  const persistedPendingTransition = getPendingAbyssalTransitionState(pocketState);
  const persistedTracePhase = normalizeAbyssalTraceLifecyclePhase(
    persistedTraceState && persistedTraceState.lifecyclePhase,
  );
  const persistedShipItem = typeof deps.findItemById === "function"
    ? deps.findItemById(shipID)
    : null;
  const persistedShipSystemID = toInt(
    persistedShipItem && persistedShipItem.spaceState && persistedShipItem.spaceState.systemID,
    toInt(persistedShipItem && persistedShipItem.locationID, 0),
  );
  const hostSystemID = toInt(instance && instance.solarSystemID, 0);
  const persistedShipPosition = getObjectPosition(
    persistedShipItem && persistedShipItem.spaceState,
  );
  const expectedReturnPosition = getObjectPosition(
    buildPlaceholderReturnSpaceState(pocketState),
  );
  const shipAtExactSourceReturn = Boolean(
    persistedShipSystemID === sourceSystemID &&
    persistedShipPosition &&
    expectedReturnPosition &&
    getVectorDistance(persistedShipPosition, expectedReturnPosition) <= 1
  );
  const recordedExitTransition = Boolean(
    persistedPendingTransition &&
    persistedPendingTransition.phase === "exit" &&
    ["pending", "completed"].includes(
      normalizeLowerText(persistedPendingTransition.status, ""),
    )
  );
  const exitAlreadyCommitted = Boolean(
    persistedTracePhase === ABYSSAL_TRACE_LIFECYCLE_PHASE.RETURNED ||
    (
      (
        recordedExitTransition ||
        normalizeLowerText(pocketState && pocketState.runOutcome, "") === "exited"
      ) &&
      (
        shipAtExactSourceReturn ||
        (
          hostSystemID > 0 &&
          hostSystemID !== sourceSystemID &&
          persistedShipSystemID === sourceSystemID
        )
      )
    )
  );
  Object.assign(context, { hostSystemID, persistedShipItem, persistedShipSystemID, persistedTracePhase, exitAlreadyCommitted });
}

function reconcileAbyssalStartupCommittedExit({
  ABYSSAL_TRACE_LIFECYCLE_PHASE,
  registerTrace,
  ensureSourceTraceRuntime,
  isAbyssalSuspectReturnPending,
  scheduleSourceTraceRemoval,
  markSourceTraceReturnedForPocket,
  buildPlaceholderReturnSpaceState,
  log,
  getCharacterID,
  settlePendingAbyssalReturnProtectionForSession,
  hasTerminalFailureOutcome,
  recordAbyssalRunOutcome,
  cleanupAbyssalRun,
}, context) {
  const { deps, reason, session, instance, instanceID, characterID, shipID, sourceSystemID, pocketState, persistedTraceState, persistedTracePhase, traceItemID,
    persistedShipItem, persistedShipSystemID, hostSystemID, exitAlreadyCommitted,
    failedInstanceIDs, failedCharacterIDs, resolvedButUncleanedInstanceIDs, completedExitInstanceIDs, cleanedSystemIDs } = context;
  if (exitAlreadyCommitted) {
    let traceReturnResult = { success: true, skipped: true };
    if (persistedTraceState) {
      if (persistedTracePhase === ABYSSAL_TRACE_LIFECYCLE_PHASE.RETURNED) {
        registerTrace(persistedTraceState);
        ensureSourceTraceRuntime(persistedTraceState, deps);
        if (!isAbyssalSuspectReturnPending(persistedTraceState)) {
          scheduleSourceTraceRemoval(
            persistedTraceState,
            deps,
            "post-restart-final-exit",
          );
        }
      } else {
        traceReturnResult = markSourceTraceReturnedForPocket(
          pocketState,
          persistedShipItem && persistedShipItem.spaceState ||
            buildPlaceholderReturnSpaceState(pocketState),
          deps,
        );
      }
    }
    if (!traceReturnResult || traceReturnResult.success !== true) {
      failedInstanceIDs.push(instanceID);
      failedCharacterIDs.push(characterID);
      resolvedButUncleanedInstanceIDs.push(instanceID);
      log.warn(
        `[AbyssalStartup] committed exit reconciliation failed instance=${instanceID} ` +
          `character=${characterID} ship=${shipID} trace=${traceItemID} ` +
          `reason=${normalizeText(
            traceReturnResult && traceReturnResult.errorMsg,
            "TRACE_RETURN_STATE_FAILED",
          )}`,
      );
      return true;
    }
    const returnProtectionRecoverySession =
      session && getCharacterID(session) === characterID
        ? session
        : null;
    const returnProtectionRecoveryResult = returnProtectionRecoverySession
      ? settlePendingAbyssalReturnProtectionForSession(
          returnProtectionRecoverySession,
          deps,
        )
      : { success: true, skipped: true, reason: "SESSION_UNAVAILABLE" };
    if (returnProtectionRecoveryResult.success !== true) {
      log.warn(
        `[AbyssalStartup] committed exit return protection remains pending ` +
          `instance=${instanceID} character=${characterID} ship=${shipID} ` +
          `trace=${traceItemID} reason=${normalizeText(
            returnProtectionRecoveryResult.errorMsg,
            "ABYSSAL_RETURN_PROTECTION_REPLAY_FAILED",
          )}`,
      );
    }
    const completedPocketState = hasTerminalFailureOutcome(pocketState)
      ? pocketState
      : recordAbyssalRunOutcome(pocketState, "exited", deps, {
          reason: "server_restart_final_exit_reconciliation",
        }) || pocketState;
    const cleanupResult = cleanupAbyssalRun(completedPocketState, deps, {
      reason: "final-exit",
      session:
        session && getCharacterID(session) === characterID
          ? session
          : null,
    });
    if (!cleanupResult || cleanupResult.success !== true) {
      failedInstanceIDs.push(instanceID);
      failedCharacterIDs.push(characterID);
      resolvedButUncleanedInstanceIDs.push(instanceID);
      log.warn(
        `[AbyssalStartup] committed exit cleanup failed instance=${instanceID} ` +
          `character=${characterID} ship=${shipID} trace=${traceItemID}`,
      );
      return true;
    }
    completedExitInstanceIDs.push(instanceID);
    cleanedSystemIDs.add(sourceSystemID);
    if (hostSystemID > 0) {
      cleanedSystemIDs.add(hostSystemID);
    }
    log.info(
      `[AbyssalStartup] committed exit reconciled instance=${instanceID} ` +
        `character=${characterID} ship=${shipID} trace=${traceItemID} ` +
        `shipSystem=${persistedShipSystemID} tracePhase=${persistedTracePhase}`,
    );
    return true;
  }
  return false;
}

function retainAbyssalStartupTerminalRun({
  hasTerminalFailureOutcome,
  registerTrace,
  ensureSourceTraceRuntime,
  getPendingAbyssalTransitionState,
  cancelPendingAbyssalTransition,
  log,
}, context) {
  let { pocketState } = context;
  const { deps, reason, session, instance, instanceID, characterID, shipID, sourceSystemID, persistedTraceState, traceItemID, hostSystemID,
    recoveredTraceItemIDs, recoveredInstanceIDs, cleanedSystemIDs } = context;
  // A terminal failure that committed before process exit must never be
  // converted into a downtime-safe return. In particular, a disconnected
  // failed-timeout run remains destruction/cleanup pending until its normal
  // terminal reconciliation can complete.
  if (hasTerminalFailureOutcome(pocketState)) {
    if (persistedTraceState) {
      registerTrace(persistedTraceState);
      ensureSourceTraceRuntime(persistedTraceState, deps);
      recoveredTraceItemIDs.push(traceItemID);
    }
    const pendingTerminalTransition = getPendingAbyssalTransitionState(pocketState);
    if (
      pendingTerminalTransition &&
      pendingTerminalTransition.status === "pending"
    ) {
      pocketState = cancelPendingAbyssalTransition(
        instanceID,
        deps,
        "server-restart-terminal-transition",
      ) || pocketState;
    }
    recoveredInstanceIDs.push(instanceID);
    cleanedSystemIDs.add(sourceSystemID);
    if (hostSystemID > 0) {
      cleanedSystemIDs.add(hostSystemID);
    }
    log.warn(
      `[AbyssalStartup] terminal run retained for destruction reconciliation ` +
        `instance=${instanceID} character=${characterID} ship=${shipID} ` +
        `outcome=${normalizeText(pocketState.runOutcome, "unknown")}`,
    );
    return true;
  }
  return false;
}

function reconcileAbyssalStartupAdministrativeReturn({
  getPendingAbyssalTransitionState,
  cancelPendingAbyssalTransition,
  evacuateShipFromPurgedPlaceholderPocket,
  getCharacterID,
  log,
}, context) {
  let { pocketState } = context;
  const { deps, reason, session, instance, instanceID, characterID, shipID, sourceSystemID, traceItemID, hostSystemID, failedInstanceIDs, failedCharacterIDs,
    resolvedButUncleanedInstanceIDs, unresolvedCharacterIDs, shutdownReturnedInstanceIDs, evacuatedShipIDs, cleanedSystemIDs } = context;
  const pendingTransitionBeforeReturn = getPendingAbyssalTransitionState(pocketState);
  if (
    pendingTransitionBeforeReturn &&
    pendingTransitionBeforeReturn.status === "pending"
  ) {
    pocketState = cancelPendingAbyssalTransition(
      instanceID,
      deps,
      "server-restart-orphaned-transition",
    ) || pocketState;
  }
  const shutdownReturnResult = evacuateShipFromPurgedPlaceholderPocket(
    instance,
    session && getCharacterID(session) === characterID ? session : null,
    deps,
    reason,
  );
  if (!shutdownReturnResult || shutdownReturnResult.success !== true) {
    failedInstanceIDs.push(instanceID);
    failedCharacterIDs.push(characterID);
    // The move to k-space and the pocket teardown are separate commits. If the
    // ship never left the pocket the participant has nowhere to log in to; if
    // it did, the leftover is pocket bookkeeping and the owner is free to fly.
    if (shutdownReturnResult && shutdownReturnResult.returnCommitted === true) {
      resolvedButUncleanedInstanceIDs.push(instanceID);
    } else {
      unresolvedCharacterIDs.push(characterID);
    }
    log.warn(
      `[AbyssalStartup] downtime return failed instance=${instanceID} ` +
        `character=${characterID} ship=${shipID} trace=${traceItemID} ` +
        `returnCommitted=${shutdownReturnResult && shutdownReturnResult.returnCommitted === true} ` +
        `reason=${normalizeText(
          shutdownReturnResult && shutdownReturnResult.errorMsg,
          "ABYSSAL_STARTUP_RETURN_FAILED",
        )}`,
    );
    return;
  }
  const evacuatedShipID = toInt(
    shutdownReturnResult && shutdownReturnResult.shipID,
    shipID,
  );
  shutdownReturnedInstanceIDs.push(instanceID);
  evacuatedShipIDs.push(evacuatedShipID);
  cleanedSystemIDs.add(sourceSystemID);
  if (hostSystemID > 0) {
    cleanedSystemIDs.add(hostSystemID);
  }
  log.info(
    `[AbyssalStartup] downtime return complete instance=${instanceID} ` +
      `character=${characterID} ship=${evacuatedShipID} trace=${traceItemID} ` +
      `alreadyReturned=${shutdownReturnResult.alreadyAtReturnTarget === true}`,
  );
}

function cleanupAbyssalStartupSystems({
  abyssalPendingWorkRegistry,
  cleanupStalePlaceholderArtifactsInSystem,
}, context) {
  const { cleanedSystemIDs, deps, reason } = context;
  const removedItemIDs = [];
  for (const systemID of cleanedSystemIDs) {
    abyssalPendingWorkRegistry.deleteStaleCleanupSystem(systemID);
    const cleanupResult = cleanupStalePlaceholderArtifactsInSystem(
      systemID,
      deps,
      reason,
      { forceRemoveLiveAbyssals: true },
    );
    if (cleanupResult && Array.isArray(cleanupResult.removedItemIDs)) {
      removedItemIDs.push(...cleanupResult.removedItemIDs);
    }
    abyssalPendingWorkRegistry.markStaleCleanupSystem(systemID);
  }
  return removedItemIDs;
}

function reportAbyssalStartupReconciliation({
  log,
  schedulePlaceholderPocketMaintenance,
}, context) {
  const { recoveredInstanceIDs, completedExitInstanceIDs, completedDeathInstanceIDs, completedCleanupInstanceIDs, shutdownReturnedInstanceIDs, evacuatedShipIDs, failedInstanceIDs, failedCharacterIDs, unresolvedCharacterIDs, resolvedButUncleanedInstanceIDs, cleanedSystemIDs, recoveredTraceItemIDs, traceRecoveryWarnings, removedItemIDs, deps } = context;
  log.info(
    `[AbyssalStartup] recovery reconciliation complete success=${failedInstanceIDs.length === 0} ` +
      `recoveredRuns=${recoveredInstanceIDs.length} failedRuns=${failedInstanceIDs.join(",") || "none"} ` +
      `recoveredInstanceIDs=${recoveredInstanceIDs.join(",") || "none"} ` +
      `completedExits=${completedExitInstanceIDs.join(",") || "none"} ` +
      `completedDeaths=${completedDeathInstanceIDs.join(",") || "none"} ` +
      `completedCleanupRetries=${completedCleanupInstanceIDs.join(",") || "none"} ` +
      `shutdownReturns=${shutdownReturnedInstanceIDs.join(",") || "none"} ` +
      `recoveredTraces=${recoveredTraceItemIDs.join(",") || "none"} ` +
      `traceWarnings=${traceRecoveryWarnings.length} removedItems=${removedItemIDs.length} ` +
      `cleanedSystems=${[...cleanedSystemIDs].join(",") || "none"}`,
  );

  if (recoveredInstanceIDs.length > 0) {
    schedulePlaceholderPocketMaintenance(deps);
  }
}

function recordAbyssalStartupRecoveryRetries({
  abyssalMaintenanceState,
  buildPocketStateFromInstance,
  ABYSSAL_RECOVERY_RETRY_MAX_DELAY_MS,
  ABYSSAL_RECOVERY_RETRY_BASE_DELAY_MS,
  cloneValue,
  listUniquePositiveInts,
}, context) {
  const { recoveredInstanceIDs, completedExitInstanceIDs, completedDeathInstanceIDs, completedCleanupInstanceIDs, shutdownReturnedInstanceIDs, evacuatedShipIDs, failedInstanceIDs, failedCharacterIDs, unresolvedCharacterIDs, resolvedButUncleanedInstanceIDs, cleanedSystemIDs, recoveredTraceItemIDs, traceRecoveryWarnings, activeInstances, recoveryNowMs, removedItemIDs } = context;
  const failedInstanceIDSet = new Set(failedInstanceIDs);
  for (const instance of activeInstances) {
    const runID = toInt(instance && instance.instanceID, 0);
    if (runID > 0 && !failedInstanceIDSet.has(runID)) {
      abyssalMaintenanceState.deleteRecoveryRetryState(runID);
    }
  }
  for (const runID of failedInstanceIDSet) {
    const instanceSnapshot = activeInstances.find((instance) =>
      toInt(instance && instance.instanceID, 0) === runID
    ) || null;
    const retryPocketState = instanceSnapshot
      ? buildPocketStateFromInstance(instanceSnapshot, null)
      : null;
    const priorRetryState = abyssalMaintenanceState.getRecoveryRetryState(runID) || null;
    const attemptCount = Math.max(0, toInt(priorRetryState && priorRetryState.attemptCount, 0)) + 1;
    const characterID = toInt(
      retryPocketState && retryPocketState.characterID,
      toInt(priorRetryState && priorRetryState.characterID, 0),
    );
    const shipID = toInt(
      retryPocketState && retryPocketState.shipID,
      toInt(priorRetryState && priorRetryState.shipID, 0),
    );
    const retryDelayMs = Math.min(
      ABYSSAL_RECOVERY_RETRY_MAX_DELAY_MS,
      ABYSSAL_RECOVERY_RETRY_BASE_DELAY_MS * (2 ** Math.min(10, attemptCount - 1)),
    );
    const participantLocationResolved = Boolean(
      (
        priorRetryState &&
        priorRetryState.participantLocationResolved === true
      ) || resolvedButUncleanedInstanceIDs.includes(runID)
    );
    abyssalMaintenanceState.setRecoveryRetryState(runID, {
      runID,
      characterID,
      shipID,
      stage:
        characterID <= 0 || shipID <= 0
          ? "identity_validation"
          : participantLocationResolved
            ? "residual_cleanup"
            : "startup_safe_return",
      participantLocationResolved,
      attemptCount,
      lastAttemptAt: recoveryNowMs,
      nextAttemptAt: recoveryNowMs + retryDelayMs,
      lastError: "ABYSSAL_STARTUP_RECOVERY_FAILED",
      blockingStatus: "affected_participant_only",
      instanceSnapshot: cloneValue(instanceSnapshot),
    });
  }
  abyssalMaintenanceState.setStartupDiscoveryApplied(true);
  const pendingRecoveryRetries = abyssalMaintenanceState.listRecoveryRetryStates();
  const pendingFailedInstanceIDs = pendingRecoveryRetries.map((entry) => entry.runID);
  const pendingFailedCharacterIDs = listUniquePositiveInts(
    pendingRecoveryRetries.map((entry) => entry.characterID),
  );

  const resetResult = {
    success: pendingRecoveryRetries.length === 0,
    skipped: false,
    recoveredInstanceIDs,
    completedExitInstanceIDs,
    completedDeathInstanceIDs,
    completedCleanupInstanceIDs,
    shutdownReturnedInstanceIDs,
    purgedInstanceIDs: [],
    failedInstanceIDs: pendingFailedInstanceIDs,
    failedCharacterIDs: pendingFailedCharacterIDs,
    unresolvedCharacterIDs: listUniquePositiveInts(unresolvedCharacterIDs),
    resolvedButUncleanedInstanceIDs: listUniquePositiveInts(
      resolvedButUncleanedInstanceIDs,
    ),
    cleanedSystemIDs: [...cleanedSystemIDs],
    removedItemIDs,
    recoveredTraceItemIDs,
    traceRecoveryWarnings,
    evacuatedShipIDs: listUniquePositiveInts(evacuatedShipIDs),
  };
  abyssalMaintenanceState.setStartupResetResult(resetResult);
  abyssalMaintenanceState.setStartupResetApplied(pendingRecoveryRetries.length === 0);
  return resetResult;
}

function resetPersistedAbyssalRunsAfterServerRestart({
  getDependencies,
  abyssalMaintenanceState,
  getCharacterID,
  cloneValue,
  listUniquePositiveInts,
  buildAbyssalStartupReconciliationContext,
  rehydrateAbyssalStartupRun,
  reconcileAbyssalStartupCleanup,
  reconcileAbyssalStartupDeath,
  inspectAbyssalStartupCommittedExit,
  reconcileAbyssalStartupCommittedExit,
  retainAbyssalStartupTerminalRun,
  reconcileAbyssalStartupAdministrativeReturn,
  cleanupAbyssalStartupSystems,
  reportAbyssalStartupReconciliation,
  recordAbyssalStartupRecoveryRetries,
},
  currentSystemID,
  deps = getDependencies(),
  reason = "server-restart-reset",
  session = null,
) {
  const startupRecoveryState = abyssalMaintenanceState.getStartupRecoveryState();
  if (
    startupRecoveryState.resetApplied &&
    abyssalMaintenanceState.getRecoveryRetryCount() <= 0
  ) {
    return startupRecoveryState.resetResult || {
      success: true,
      skipped: true,
      purgedInstanceIDs: [],
      cleanedSystemIDs: [],
    };
  }
  const runtime = deps && deps.dungeonRuntime && typeof deps.dungeonRuntime === "object"
    ? deps.dungeonRuntime
    : null;
  const recoveryNowMs = toInt(deps && deps.now && deps.now(), Date.now());
  const recoveryCharacterID = toInt(session && getCharacterID(session), 0);
  const discoveryPass = startupRecoveryState.discoveryApplied !== true;
  let activeInstances = [];
  if (discoveryPass) {
    activeInstances = runtime && typeof runtime.listInstancesByFamily === "function"
      ? runtime.listInstancesByFamily("abyssal", {
        activeOnly: true,
        full: true,
      })
      : [];
  } else {
    activeInstances = abyssalMaintenanceState.listRecoveryRetryStates()
      .filter((retryState) =>
        toInt(retryState && retryState.nextAttemptAt, 0) <= recoveryNowMs &&
        (
          recoveryCharacterID <= 0 ||
          toInt(retryState && retryState.characterID, 0) === recoveryCharacterID
        )
      )
      .map((retryState) => {
        const refreshedInstance =
          runtime && typeof runtime.getInstance === "function"
            ? runtime.getInstance(toInt(retryState && retryState.runID, 0))
            : null;
        return cloneValue(refreshedInstance || retryState.instanceSnapshot);
      })
      .filter(Boolean);
    if (activeInstances.length <= 0) {
      const pendingRetries = abyssalMaintenanceState.listRecoveryRetryStates();
      return {
        ...(startupRecoveryState.resetResult || {}),
        success: pendingRetries.length <= 0,
        skipped: true,
        retryDeferred: pendingRetries.length > 0,
        failedInstanceIDs: pendingRetries.map((entry) => entry.runID),
        failedCharacterIDs: listUniquePositiveInts(
          pendingRetries.map((entry) => entry.characterID),
        ),
      };
    }
  }
  const context = buildAbyssalStartupReconciliationContext({
    currentSystemID, deps, reason, session, activeInstances, discoveryPass, recoveryNowMs,
  });
  for (const instance of Array.isArray(activeInstances) ? activeInstances : []) {
    const run = rehydrateAbyssalStartupRun(context, instance);
    if (!run) continue;
    if (reconcileAbyssalStartupCleanup(run)) continue;
    if (reconcileAbyssalStartupDeath(run)) continue;
    inspectAbyssalStartupCommittedExit(run);
    if (reconcileAbyssalStartupCommittedExit(run)) continue;
    if (retainAbyssalStartupTerminalRun(run)) continue;
    reconcileAbyssalStartupAdministrativeReturn(run);
  }
  context.removedItemIDs = cleanupAbyssalStartupSystems(context);
  reportAbyssalStartupReconciliation(context);
  return recordAbyssalStartupRecoveryRetries(context);
}

function prepareStartupRecoveryBarrier({
  getDependencies,
  resetPersistedAbyssalRunsAfterServerRestart,
  log,
  getCharacterID,
  listUniquePositiveInts,
  runAbyssalRecoveryTombstoneMaintenance,
  activeAbyssalRunRegistry,
  hasAbyssalRecoveryTombstoneBacklog,
  schedulePlaceholderPocketMaintenance,
}, reason = "startup", sessionOrOptions = null, deps = getDependencies()) {
  const source = sessionOrOptions && typeof sessionOrOptions === "object"
    ? sessionOrOptions
    : null;
  const session = source && source._space !== undefined ? source : null;
  // `toInt(null, fallback)` returns 0, not the fallback: Number(null) is 0 and
  // 0 is finite. Written as a nested toInt the fallback is unreachable whenever
  // the caller passed an options bag rather than a live session, which is every
  // caller on the login path. Pick the first positive candidate instead.
  const firstPositiveInt = (candidates) => {
    for (const candidate of candidates) {
      const numeric = toInt(candidate, 0);
      if (numeric > 0) {
        return numeric;
      }
    }
    return 0;
  };
  const currentSystemID = firstPositiveInt([
    session && (session.solarsystemid2 || session.solarsystemid),
    source && source.systemID,
    source && (source.solarsystemid2 || source.solarsystemid),
  ]);
  const result = resetPersistedAbyssalRunsAfterServerRestart(
    currentSystemID,
    deps,
    normalizeText(reason, "startup"),
    session,
  );
  if (result && result.success === false) {
    log.warn(
      `[AbyssalStartup] recovery barrier failed reason=${reason} ` +
        `failedRuns=${Array.isArray(result.failedInstanceIDs) ? result.failedInstanceIDs.join(",") : "unknown"}`,
    );
  }
  const characterID = firstPositiveInt([
    session && getCharacterID(session),
    source && (source.characterID || source.charid || source.characterId),
  ]);
  // A failed run owned by somebody else must never prevent ordinary login or
  // space restoration, and neither may a failure that has already put this
  // participant back in k-space. Residual pocket teardown is bookkeeping the
  // maintenance loop owns; gating login on it would trade a cosmetic leftover
  // for an unenterable game. Only an unresolved persisted location gates.
  const unresolvedCharacterIDs = listUniquePositiveInts(
    result && result.unresolvedCharacterIDs,
  );
  const tombstoneEviction = runAbyssalRecoveryTombstoneMaintenance(null, deps);
  if (
    activeAbyssalRunRegistry.size > 0 ||
    hasAbyssalRecoveryTombstoneBacklog() ||
    tombstoneEviction.scanInProgress === true
  ) {
    schedulePlaceholderPocketMaintenance(deps);
  }
  return {
    ...(result || { success: true, skipped: true }),
    blocksSession:
      characterID > 0 && unresolvedCharacterIDs.includes(characterID),
    tombstoneEviction,
  };
}

function ensureSystemStalePlaceholderCleanup({
  abyssalPendingWorkRegistry,
  cleanupStalePlaceholderArtifactsInSystem,
}, systemID, deps, reason = "lazy-startup-recovery") {
  const numericSystemID = toInt(systemID, 0);
  if (numericSystemID <= 0) {
    return {
      success: true,
      skipped: true,
      removedItemIDs: [],
    };
  }
  if (abyssalPendingWorkRegistry.hasStaleCleanupSystem(numericSystemID)) {
    return {
      success: true,
      skipped: true,
      removedItemIDs: [],
    };
  }
  abyssalPendingWorkRegistry.markStaleCleanupSystem(numericSystemID);
  return cleanupStalePlaceholderArtifactsInSystem(numericSystemID, deps, reason);
}

// Capture supplied capabilities once, as the original closure did. Internal
// callbacks are bound once per instance; no runtime state lives in this wiring.
function createAbyssalStartupReconciliation({
  log,
  inspectAbyssalTaggedSpaceItem,
  readTraceStateFromItem,
  restoreAbyssalTimerDeadlineAfterRestart,
  buildPocketStateFromInstance,
  ensureAbyssalPocketDurablyAdopted,
  abyssalMaintenanceState,
  cloneValue,
  logRecoveredT0DarkLayoutSelection,
  logRecoveredAbyssalSceneMode,
  normalizeAbyssalTraceLifecyclePhase,
  hasPendingAbyssalTerminalCleanup,
  requiresAbyssalParticipantDestructionReceiptForCleanup,
  hasDurableAbyssalParticipantPodDestructionReceipt,
  getAbyssalTerminalCleanupState,
  cleanupAbyssalRun,
  getCharacterID,
  hasUnresolvedAbyssalRecoveryObligation,
  resolveAbyssalRecoveryCleanupReason,
  ABYSSAL_TRACE_LIFECYCLE_PHASE,
  inferUnrecordedAbyssalHullLossAfterRestart,
  reconcileCommittedAbyssalParticipantDeath,
  getPendingAbyssalTransitionState,
  getObjectPosition,
  buildPlaceholderReturnSpaceState,
  getVectorDistance,
  normalizeLowerText,
  registerTrace,
  ensureSourceTraceRuntime,
  isAbyssalSuspectReturnPending,
  scheduleSourceTraceRemoval,
  markSourceTraceReturnedForPocket,
  settlePendingAbyssalReturnProtectionForSession,
  hasTerminalFailureOutcome,
  recordAbyssalRunOutcome,
  cancelPendingAbyssalTransition,
  evacuateShipFromPurgedPlaceholderPocket,
  abyssalPendingWorkRegistry,
  cleanupStalePlaceholderArtifactsInSystem,
  schedulePlaceholderPocketMaintenance,
  ABYSSAL_RECOVERY_RETRY_MAX_DELAY_MS,
  ABYSSAL_RECOVERY_RETRY_BASE_DELAY_MS,
  listUniquePositiveInts,
  getDependencies,
  runAbyssalRecoveryTombstoneMaintenance,
  activeAbyssalRunRegistry,
  hasAbyssalRecoveryTombstoneBacklog,
}) {

  const ports = {
    log,
    inspectAbyssalTaggedSpaceItem,
    readTraceStateFromItem,
    restoreAbyssalTimerDeadlineAfterRestart,
    buildPocketStateFromInstance,
    ensureAbyssalPocketDurablyAdopted,
    abyssalMaintenanceState,
    cloneValue,
    logRecoveredT0DarkLayoutSelection,
    logRecoveredAbyssalSceneMode,
    normalizeAbyssalTraceLifecyclePhase,
    hasPendingAbyssalTerminalCleanup,
    requiresAbyssalParticipantDestructionReceiptForCleanup,
    hasDurableAbyssalParticipantPodDestructionReceipt,
    getAbyssalTerminalCleanupState,
    cleanupAbyssalRun,
    getCharacterID,
    hasUnresolvedAbyssalRecoveryObligation,
    resolveAbyssalRecoveryCleanupReason,
    ABYSSAL_TRACE_LIFECYCLE_PHASE,
    inferUnrecordedAbyssalHullLossAfterRestart,
    reconcileCommittedAbyssalParticipantDeath,
    getPendingAbyssalTransitionState,
    getObjectPosition,
    buildPlaceholderReturnSpaceState,
    getVectorDistance,
    normalizeLowerText,
    registerTrace,
    ensureSourceTraceRuntime,
    isAbyssalSuspectReturnPending,
    scheduleSourceTraceRemoval,
    markSourceTraceReturnedForPocket,
    settlePendingAbyssalReturnProtectionForSession,
    hasTerminalFailureOutcome,
    recordAbyssalRunOutcome,
    cancelPendingAbyssalTransition,
    evacuateShipFromPurgedPlaceholderPocket,
    abyssalPendingWorkRegistry,
    cleanupStalePlaceholderArtifactsInSystem,
    schedulePlaceholderPocketMaintenance,
    ABYSSAL_RECOVERY_RETRY_MAX_DELAY_MS,
    ABYSSAL_RECOVERY_RETRY_BASE_DELAY_MS,
    listUniquePositiveInts,
    getDependencies,
    runAbyssalRecoveryTombstoneMaintenance,
    activeAbyssalRunRegistry,
    hasAbyssalRecoveryTombstoneBacklog,
  };
  ports.buildAbyssalStartupReconciliationContext = buildAbyssalStartupReconciliationContext.bind(null, ports);
  ports.rehydrateAbyssalStartupRun = rehydrateAbyssalStartupRun.bind(null, ports);
  ports.reconcileAbyssalStartupCleanup = reconcileAbyssalStartupCleanup.bind(null, ports);
  ports.reconcileAbyssalStartupDeath = reconcileAbyssalStartupDeath.bind(null, ports);
  ports.inspectAbyssalStartupCommittedExit = inspectAbyssalStartupCommittedExit.bind(null, ports);
  ports.reconcileAbyssalStartupCommittedExit = reconcileAbyssalStartupCommittedExit.bind(null, ports);
  ports.retainAbyssalStartupTerminalRun = retainAbyssalStartupTerminalRun.bind(null, ports);
  ports.reconcileAbyssalStartupAdministrativeReturn = reconcileAbyssalStartupAdministrativeReturn.bind(null, ports);
  ports.cleanupAbyssalStartupSystems = cleanupAbyssalStartupSystems.bind(null, ports);
  ports.reportAbyssalStartupReconciliation = reportAbyssalStartupReconciliation.bind(null, ports);
  ports.recordAbyssalStartupRecoveryRetries = recordAbyssalStartupRecoveryRetries.bind(null, ports);
  ports.resetPersistedAbyssalRunsAfterServerRestart = resetPersistedAbyssalRunsAfterServerRestart.bind(null, ports);
  ports.prepareStartupRecoveryBarrier = prepareStartupRecoveryBarrier.bind(null, ports);
  ports.ensureSystemStalePlaceholderCleanup = ensureSystemStalePlaceholderCleanup.bind(null, ports);
  Object.freeze(ports);
  return { resetPersistedAbyssalRunsAfterServerRestart: ports.resetPersistedAbyssalRunsAfterServerRestart, prepareStartupRecoveryBarrier: ports.prepareStartupRecoveryBarrier, ensureSystemStalePlaceholderCleanup: ports.ensureSystemStalePlaceholderCleanup };
}

module.exports = { createAbyssalStartupReconciliation };
