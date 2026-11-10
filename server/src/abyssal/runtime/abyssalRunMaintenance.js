"use strict";

const { normalizeText } = require("../domain/abyssalValueUtils");

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

// Isolate failures per run; only the owning outer pass releases maintenance exclusion.
function runPlaceholderPocketMaintenancePass(ports, nowMs = null, deps = ports.getDependencies()) {
  const effectiveNowMs = ports.resolveEffectiveAbyssalMaintenanceNowMs(nowMs, deps);
  for (const rawState of ports.listActiveRuns()) {
    const instanceID = toInt(rawState && rawState.instanceID, 0);
    try {
      maintainActiveRun(ports, { rawState, instanceID, effectiveNowMs, deps });
    } catch (error) {
      ports.recordAbyssalMaintenanceFailure(instanceID, rawState, error, "active-run-maintenance");
    }
  }
  return { tombstoneEviction: ports.runAbyssalRecoveryTombstoneMaintenance(effectiveNowMs, deps) };
}

function maintainActiveRun(ports, work) {
  if (prepareRunMaintenance(ports, work)) return;
  reconcileMaintenanceRewards(ports, work);
  reconcileMaintenanceControllers(ports, work);
  reconcileMaintenanceExtractionNodes(ports, work);
  inspectMaintenanceRoomScope(ports, work);
  if (work.environmentalLifecycleState && !work.sourceRoomDeparturePending) {
    inspectMaintenanceEnvironment(ports, work);
    persistMaintenanceEnvironment(ports, work);
  }
  if (work.trackedObjectiveEntityIDs.length > 0 && work.currentRoomEntry.objectiveComplete !== true &&
      work.scene && typeof work.scene.getEntityByID === "function") {
    reconcileMaintenanceObjectiveEvidence(ports, work);
    completeMaintenanceObjective(ports, work);
  }
  finalizeRunMaintenance(ports, work);
}

function prepareRunMaintenance(ports, work) {
  const {
    hasImmutableAbyssalRunOutcome,
    hasPendingAbyssalTerminalCleanup,
    hasUnresolvedAbyssalRecoveryObligation,
    buildPocketStateForCurrentRoom,
    cloneValue,
    reconcilePendingAbyssalEntryRecovery,
    hasTerminalFailureOutcome,
    syncExpiredAbyssalPocketState,
    shouldDeferAbyssalWeatherRemovalMaintenanceRetry,
    cleanupAbyssalRun,
    resolveAbyssalRecoveryCleanupReason,
  } = ports;
  const {
    rawState,
    effectiveNowMs,
    deps,
  } = work;
  const terminalOutcomeAtPassStart = hasImmutableAbyssalRunOutcome(rawState);
  const gameplayAuthorityDetachedAtPassStart = Boolean(
    rawState && rawState.gameplayAuthorityDetached === true
  );
  const liveGameplayStoppedAtPassStart = Boolean(
    terminalOutcomeAtPassStart || gameplayAuthorityDetachedAtPassStart
  );
  const terminalCleanupPendingAtPassStart = hasPendingAbyssalTerminalCleanup(rawState);
  const detachedRecoveryPendingAtPassStart = Boolean(
    gameplayAuthorityDetachedAtPassStart &&
    hasUnresolvedAbyssalRecoveryObligation(rawState),
  );
  let pocketState = buildPocketStateForCurrentRoom(cloneValue(rawState));
  if (!pocketState) {
    return true;
  }
  if (
    pocketState.entryRecoveryState &&
    pocketState.entryRecoveryState.pending === true
  ) {
    reconcilePendingAbyssalEntryRecovery(pocketState, null, deps);
    return true;
  }
  if (
    !liveGameplayStoppedAtPassStart ||
    hasTerminalFailureOutcome(pocketState)
  ) {
    pocketState = syncExpiredAbyssalPocketState(
      pocketState,
      effectiveNowMs,
      deps,
    );
    if (!pocketState) {
      return true;
    }
  }
  if (
    hasPendingAbyssalTerminalCleanup(pocketState) ||
    (
      pocketState.gameplayAuthorityDetached === true &&
      hasUnresolvedAbyssalRecoveryObligation(pocketState)
    )
  ) {
    if (
      !terminalCleanupPendingAtPassStart &&
      !detachedRecoveryPendingAtPassStart
    ) {
      // A terminal side effect failed during this pass and just staged its
      // durable retry. Do not immediately repeat it in the same pass.
      return true;
    }
    if (
      shouldDeferAbyssalWeatherRemovalMaintenanceRetry(
        pocketState,
        effectiveNowMs,
        deps,
      )
    ) {
      return true;
    }
    cleanupAbyssalRun(pocketState, deps, {
      reason: resolveAbyssalRecoveryCleanupReason(
        pocketState,
        "maintenance-cleanup-retry",
      ),
    });
    return true;
  }
  if (liveGameplayStoppedAtPassStart) {
    return true;
  }
  if (hasTerminalFailureOutcome(pocketState)) {
    return true;
  }
  Object.assign(work, {
    pocketState,
  });
}

function reconcileMaintenanceRewards(ports, work) {
  const {
    reconcilePendingAbyssalMemberDestructions,
    reconcilePendingAbyssalRewardArtifactDestructions,
    buildPlaceholderRoomState,
    getPlaceholderRoomEntry,
    listUniquePositiveInts,
    suppressAbyssalRoomRewards,
    retryPendingAbyssalRewardMaterializations,
    finalizeResolvedAbyssalRewardArtifactDestructions,
  } = ports;
  const {
    instanceID,
    effectiveNowMs,
    deps,
  } = work;
  let {
    pocketState,
  } = work;
  pocketState = reconcilePendingAbyssalMemberDestructions(
    pocketState,
    deps,
    effectiveNowMs,
  ) || pocketState;
  pocketState = reconcilePendingAbyssalRewardArtifactDestructions(
    pocketState,
    deps,
  ) || pocketState;
  let roomState = buildPlaceholderRoomState(pocketState);
  let currentRoomEntry = getPlaceholderRoomEntry(pocketState, roomState.currentRoomIndex);
  if (listUniquePositiveInts(currentRoomEntry.rewardSuppressionPendingRemovalItemIDs).length > 0) {
    pocketState = suppressAbyssalRoomRewards(
      pocketState,
      roomState.currentRoomIndex,
      deps,
      normalizeText(currentRoomEntry.suppressedReason, "REWARD_SUPPRESSION_CLEANUP_PENDING"),
    ) || pocketState;
    roomState = buildPlaceholderRoomState(pocketState);
    currentRoomEntry = getPlaceholderRoomEntry(pocketState, roomState.currentRoomIndex);
  }
  if (
    currentRoomEntry.cacheRewardRetryIntent ||
    (
      currentRoomEntry.extractionNodeRewardRetryIntentsByItemID &&
      Object.keys(currentRoomEntry.extractionNodeRewardRetryIntentsByItemID).length > 0
    )
  ) {
    const rewardRetryResult = retryPendingAbyssalRewardMaterializations(
      pocketState,
      roomState.currentRoomIndex,
      deps,
    );
    pocketState = rewardRetryResult.data || pocketState;
    roomState = buildPlaceholderRoomState(pocketState);
    currentRoomEntry = getPlaceholderRoomEntry(pocketState, roomState.currentRoomIndex);
  }
  pocketState = finalizeResolvedAbyssalRewardArtifactDestructions(
    pocketState,
    deps,
  ) || pocketState;
  roomState = buildPlaceholderRoomState(pocketState);
  currentRoomEntry = getPlaceholderRoomEntry(pocketState, roomState.currentRoomIndex);
  Object.assign(work, {
    pocketState,
    roomState,
    currentRoomEntry,
  });
}

function reconcileMaintenanceControllers(ports, work) {
  const {
    buildPlaceholderRoomState,
    getPlaceholderRoomEntry,
    reconcilePendingAbyssalObjectiveDeaths,
    getActivePocketStateByInstanceID,
    getPocketScene,
    runAbyssalNpcControllerWatchdog,
    hasObjectiveDeaths,
  } = ports;
  const {
    instanceID,
    effectiveNowMs,
    deps,
  } = work;
  let {
    pocketState,
    roomState,
    currentRoomEntry,
  } = work;
  // Death evidence must reconcile before watchdog checks; refresh the authoritative state afterward.
  if (hasObjectiveDeaths(instanceID)) {
    reconcilePendingAbyssalObjectiveDeaths(instanceID, deps);
    pocketState = getActivePocketStateByInstanceID(instanceID) || pocketState;
    roomState = buildPlaceholderRoomState(pocketState);
    currentRoomEntry = getPlaceholderRoomEntry(pocketState, roomState.currentRoomIndex);
  }
  const scene = getPocketScene(pocketState, deps);
  runAbyssalNpcControllerWatchdog(
    pocketState,
    currentRoomEntry,
    scene,
    deps,
    effectiveNowMs,
  );
  pocketState = getActivePocketStateByInstanceID(instanceID) || pocketState;
  roomState = buildPlaceholderRoomState(pocketState);
  currentRoomEntry = getPlaceholderRoomEntry(pocketState, roomState.currentRoomIndex);
  Object.assign(work, {
    pocketState,
    roomState,
    currentRoomEntry,
    scene,
  });
}

function reconcileMaintenanceExtractionNodes(ports, work) {
  const {
    buildPocketStateForCurrentRoom,
    buildPlaceholderRoomState,
    getPlaceholderRoomEntry,
    listUniquePositiveInts,
    setPlaceholderRoomEntry,
    updatePocketState,
  } = ports;
  const {
    instanceID,
    deps,
  } = work;
  let {
    pocketState,
    roomState,
    currentRoomEntry,
  } = work;
  const trackedExtractionNodeItemIDs = listUniquePositiveInts(currentRoomEntry.extractionNodeItemIDs);
  if (trackedExtractionNodeItemIDs.length > 0) {
    const existingExtractionNodeItemIDs = trackedExtractionNodeItemIDs
      .filter((itemID) => deps.findItemById(itemID));
    if (existingExtractionNodeItemIDs.length !== trackedExtractionNodeItemIDs.length) {
      roomState = setPlaceholderRoomEntry(
        pocketState,
        roomState.currentRoomIndex,
        {
          ...currentRoomEntry,
          extractionNodeItemIDs: existingExtractionNodeItemIDs,
          extractionNodeLifecycleState:
            existingExtractionNodeItemIDs.length > 0
              ? normalizeText(currentRoomEntry.extractionNodeLifecycleState, "spawned")
              : "consumed_or_removed",
        },
      );
      pocketState = updatePocketState(instanceID, {
        ...buildPocketStateForCurrentRoom(pocketState, roomState),
      }) || pocketState;
      roomState = buildPlaceholderRoomState(pocketState);
      currentRoomEntry = getPlaceholderRoomEntry(pocketState, roomState.currentRoomIndex);
    }
  }
  Object.assign(work, {
    pocketState,
    roomState,
    currentRoomEntry,
  });
}

function inspectMaintenanceRoomScope(ports, work) {
  const {
    listUniquePositiveInts,
    listPocketHostileEntityIDs,
    listPocketObjectiveRelevantEntityIDs,
    normalizeLowerText,
    getPendingAbyssalTransitionState,
  } = ports;
  const {
    pocketState,
    roomState,
    currentRoomEntry,
  } = work;
  // Source-room departure deliberately quiesces environmental mechanics; do not degrade that expected pause.
  const hostileEntityIDs = listPocketHostileEntityIDs(pocketState);
  const objectiveRelevantEntityIDs = listPocketObjectiveRelevantEntityIDs(pocketState);
  const trackedObjectiveEntityIDs = listUniquePositiveInts([
    ...objectiveRelevantEntityIDs,
    ...listUniquePositiveInts(currentRoomEntry.plannedObjectiveNpcItemIDs),
    ...listUniquePositiveInts(currentRoomEntry.materializedObjectiveNpcItemIDs),
    ...listUniquePositiveInts(currentRoomEntry.destroyedObjectiveIDs),
    ...listUniquePositiveInts(currentRoomEntry.defeatedObjectiveItemIDs),
  ]);
  const environmentalLifecycleState = normalizeLowerText(
    currentRoomEntry && currentRoomEntry.environmentalObjectLifecycleState,
    "",
  );
  const pendingEnvironmentalTransition = getPendingAbyssalTransitionState(pocketState);
  const sourceRoomDeparturePending = Boolean(
    pendingEnvironmentalTransition &&
    pendingEnvironmentalTransition.status === "pending" &&
    ["transfer", "exit"].includes(
      normalizeLowerText(pendingEnvironmentalTransition.phase, ""),
    ) &&
    toInt(pendingEnvironmentalTransition.sourceRoomIndex, 0) ===
      roomState.currentRoomIndex
  );
  Object.assign(work, {
    hostileEntityIDs,
    trackedObjectiveEntityIDs,
    environmentalLifecycleState,
    sourceRoomDeparturePending,
  });
}

function inspectMaintenanceEnvironment(ports, work) {
  const {
    buildPlaceholderRoomState,
    getPlaceholderRoomEntry,
    getActivePocketStateByInstanceID,
    evaluateEnvironmentalEffectsForPocketState,
    buildAbyssalEnvironmentalMaterializationReadiness,
    buildAbyssalEnvironmentalEffectReadiness,
    activateSuppressorControllersForPocketRoom,
    listSuppressorControllersForRun,
    isBenignAbyssalBoundaryControllerState,
  } = ports;
  const {
    instanceID,
    effectiveNowMs,
    deps,
  } = work;
  let {
    pocketState,
    roomState,
    currentRoomEntry,
  } = work;
  const environmentalEffectResult = evaluateEnvironmentalEffectsForPocketState(
    pocketState,
    deps,
    effectiveNowMs,
    { roomIndex: roomState.currentRoomIndex },
  );
  pocketState = getActivePocketStateByInstanceID(instanceID) || pocketState;
  roomState = buildPlaceholderRoomState(pocketState);
  currentRoomEntry = getPlaceholderRoomEntry(pocketState, roomState.currentRoomIndex);
  const environmentalMaterialization =
  buildAbyssalEnvironmentalMaterializationReadiness(
    pocketState,
    roomState.currentRoomIndex,
    deps,
  );
  const environmentalEffects = buildAbyssalEnvironmentalEffectReadiness(
    pocketState,
    roomState.currentRoomIndex,
    environmentalEffectResult,
    deps,
  );
  const suppressorActivationResults = activateSuppressorControllersForPocketRoom(
    pocketState,
    roomState.currentRoomIndex,
    deps,
  );
  const suppressorControllers = listSuppressorControllersForRun(
    instanceID,
    roomState.currentRoomIndex,
  );
  const expectedSuppressorIDs = environmentalMaterialization.expectedSuppressorIDs;
  const suppressorControllersByEntityID = new Map(
    suppressorControllers.map((controller) => [
      toInt(controller && controller.runtimeEntityID, 0),
      controller,
    ]),
  );
  const suppressorsReady = Boolean(
    suppressorActivationResults.length ===
      environmentalMaterialization.expectedSuppressorCount &&
    suppressorActivationResults.every((result) => result && result.success === true) &&
    suppressorControllers.length === expectedSuppressorIDs.length &&
    expectedSuppressorIDs.every((entityID) => {
      const controller = suppressorControllersByEntityID.get(entityID);
      return Boolean(
        controller &&
        controller.controllerActive === true &&
        controller.controllerPaused !== true &&
        controller.controllerDegraded !== true &&
        controller.timerRegistered === true
      );
    })
  );
  const boundaryControllerFault = isBenignAbyssalBoundaryControllerState(
    environmentalEffectResult.boundaryControllerError,
  )
    ? ""
    : normalizeText(environmentalEffectResult.boundaryControllerError, "");
  const mechanicsReady = Boolean(
    environmentalMaterialization.ready &&
    environmentalEffects.ready &&
    suppressorsReady &&
    !boundaryControllerFault
  );
  const failureReason = mechanicsReady
  ? ""
  : !environmentalMaterialization.ready
    ? normalizeText(
        environmentalMaterialization.errorMsg,
        "ABYSSAL_ENVIRONMENT_MATERIALIZATION_INCOMPLETE",
      )
    : !environmentalEffects.ready
      ? normalizeText(
          environmentalEffects.errorMsg,
          "ABYSSAL_ENVIRONMENT_EFFECTS_NOT_READY",
        )
      : !suppressorsReady
        ? "ABYSSAL_ENVIRONMENT_SUPPRESSORS_NOT_READY"
        : normalizeText(
            boundaryControllerFault,
            "ABYSSAL_ENVIRONMENT_BOUNDARY_NOT_READY",
          );
  Object.assign(work, {
    pocketState,
    roomState,
    currentRoomEntry,
    mechanicsReady,
    failureReason,
    environmentalEffects,
  });
}

function persistMaintenanceEnvironment(ports, work) {
  const {
    buildPocketStateForCurrentRoom,
    buildPlaceholderRoomState,
    getPlaceholderRoomEntry,
    suppressAbyssalRoomRewards,
    setPlaceholderRoomEntry,
    updatePocketState,
    normalizeLowerText,
    log,
    getRuntimeTelemetry,
    setRuntimeTelemetry,
  } = ports;
  const {
    instanceID,
    effectiveNowMs,
    deps,
    mechanicsReady,
    failureReason,
    environmentalEffects,
  } = work;
  let {
    pocketState,
    roomState,
    currentRoomEntry,
  } = work;
  const priorFailureCount = Math.max(
    0,
    toInt(currentRoomEntry.environmentalMechanicsFailureCount, 0),
  );
  const priorRuntimeTelemetry =
  getRuntimeTelemetry(instanceID) || {};
  const runtimeFailureCount = mechanicsReady
  ? 0
  : Math.max(
      priorFailureCount,
      toInt(priorRuntimeTelemetry.environmentalMechanicsFailureCount, 0),
    ) + 1;
  setRuntimeTelemetry(instanceID, {
    ...priorRuntimeTelemetry,
    lastCheckedAtMs: effectiveNowMs,
    roomIndex: roomState.currentRoomIndex,
    mechanicsReady,
    environmentalMechanicsFailureCount: runtimeFailureCount,
    failureReason,
  });
  const nextMechanicsState = mechanicsReady ? "active" : "blocked";
  const nextDurableFailureCount = mechanicsReady ? 0 : 1;
  const nextUnresolvedCollectionIDs = [
    ...environmentalEffects.unresolvedCollectionIDs,
  ];
  const priorUnresolvedCollectionIDs = Array.isArray(
    currentRoomEntry.environmentalMechanicsUnresolvedCollectionIDs,
  )
    ? currentRoomEntry.environmentalMechanicsUnresolvedCollectionIDs
    : [];
  const durableMechanicsTransition = Boolean(
    normalizeLowerText(currentRoomEntry.environmentalMechanicsState, "") !==
      nextMechanicsState ||
    normalizeText(currentRoomEntry.environmentalMechanicsFailureReason, "") !==
      failureReason ||
    toInt(currentRoomEntry.environmentalMechanicsFailureCount, 0) !==
      nextDurableFailureCount ||
    JSON.stringify(priorUnresolvedCollectionIDs) !==
      JSON.stringify(nextUnresolvedCollectionIDs)
  );
  if (durableMechanicsTransition) {
    roomState = setPlaceholderRoomEntry(
      pocketState,
      roomState.currentRoomIndex,
      {
        ...currentRoomEntry,
        environmentalMechanicsState: nextMechanicsState,
        environmentalMechanicsFailureReason: failureReason,
        environmentalMechanicsFailureCount: nextDurableFailureCount,
        environmentalMechanicsUnresolvedCollectionIDs:
          nextUnresolvedCollectionIDs,
      },
    );
    pocketState = updatePocketState(instanceID, {
      ...buildPocketStateForCurrentRoom(pocketState, roomState),
    }) || pocketState;
  }
  if (!mechanicsReady) {
    pocketState = suppressAbyssalRoomRewards(
      pocketState,
      roomState.currentRoomIndex,
      deps,
      failureReason,
    ) || pocketState;
    log.warn(
      `[AbyssalEnvironmentalHealth] run=${instanceID} ` +
        `room=${roomState.currentRoomIndex} state=blocked ` +
        `failureCount=${runtimeFailureCount} reason=${failureReason} ` +
        `unresolvedCollections=${environmentalEffects.unresolvedCollectionIDs.join(",") || "none"}`,
    );
  }
  roomState = buildPlaceholderRoomState(pocketState);
  currentRoomEntry = getPlaceholderRoomEntry(pocketState, roomState.currentRoomIndex);
  Object.assign(work, {
    pocketState,
    roomState,
    currentRoomEntry,
  });
}

function reconcileMaintenanceObjectiveEvidence(ports, work) {
  const {
    buildPocketStateForCurrentRoom,
    cloneValue,
    buildPlaceholderRoomState,
    getPlaceholderRoomEntry,
    setPlaceholderRoomEntry,
    updatePocketState,
    getRoomObjectiveIDSets,
  } = ports;
  const {
    instanceID,
    hostileEntityIDs,
  } = work;
  let {
    pocketState,
    roomState,
    currentRoomEntry,
  } = work;
  const {
    plannedObjectiveNpcItemIDs,
    materializedObjectiveNpcItemIDs,
    liveObjectiveIDs,
    destroyedObjectiveIDs,
    defeatedObjectiveItemIDs,
  } = getRoomObjectiveIDSets(currentRoomEntry);
  const remainingHostileEntityIDs = hostileEntityIDs.filter((entityID) => !destroyedObjectiveIDs.includes(entityID));
  const remainingObjectiveEntityIDs = liveObjectiveIDs;
  const requiredObjectiveCount = Math.max(
    toInt(currentRoomEntry.objectiveTotal, 0),
    plannedObjectiveNpcItemIDs.length,
  );
  if (remainingHostileEntityIDs.length !== hostileEntityIDs.length) {
    roomState = setPlaceholderRoomEntry(
      pocketState,
      roomState.currentRoomIndex,
      {
        ...currentRoomEntry,
        hostileEntityIDs: remainingHostileEntityIDs,
        plannedObjectiveNpcItemIDs,
        materializedObjectiveNpcItemIDs,
        objectiveRelevantNpcItemIDs: remainingObjectiveEntityIDs,
        defeatedObjectiveItemIDs,
        destroyedObjectiveIDs,
        objectiveTotal: requiredObjectiveCount,
        objectiveDefeatedCount: defeatedObjectiveItemIDs.length,
      },
    );
    pocketState = updatePocketState(instanceID, {
      ...buildPocketStateForCurrentRoom(pocketState, roomState),
      encounterState: {
        ...cloneValue(pocketState.encounterState || {}),
        hostileEntityIDs: remainingHostileEntityIDs,
        plannedObjectiveNpcItemIDs,
        materializedObjectiveNpcItemIDs,
        objectiveRelevantNpcItemIDs: remainingObjectiveEntityIDs,
        defeatedObjectiveItemIDs,
        destroyedObjectiveIDs,
        objectiveTotal: requiredObjectiveCount,
        objectiveDefeatedCount: defeatedObjectiveItemIDs.length,
      },
    }) || pocketState;
    roomState = buildPlaceholderRoomState(pocketState);
    currentRoomEntry = getPlaceholderRoomEntry(pocketState, roomState.currentRoomIndex);
  }
  const allPlannedObjectivesMaterialized =
  plannedObjectiveNpcItemIDs.length > 0 &&
  plannedObjectiveNpcItemIDs.every((entityID) => materializedObjectiveNpcItemIDs.includes(entityID));
  const allRequiredObjectivesDestroyed =
  allPlannedObjectivesMaterialized &&
  plannedObjectiveNpcItemIDs.every((entityID) => destroyedObjectiveIDs.includes(entityID));
  const roomEncounterDegraded =
  normalizeText(
    currentRoomEntry &&
      currentRoomEntry.npcControllerActivationState,
    "",
  ) === "degraded" ||
  normalizeText(
    pocketState &&
      pocketState.encounterState &&
      pocketState.encounterState.spawnMode,
    "",
  ) === "degraded";
  Object.assign(work, {
    pocketState,
    roomState,
    currentRoomEntry,
    plannedObjectiveNpcItemIDs,
    materializedObjectiveNpcItemIDs,
    destroyedObjectiveIDs,
    defeatedObjectiveItemIDs,
    remainingHostileEntityIDs,
    remainingObjectiveEntityIDs,
    requiredObjectiveCount,
    allRequiredObjectivesDestroyed,
    roomEncounterDegraded,
  });
}

function completeMaintenanceObjective(ports, work) {
  const {
    buildPocketStateForCurrentRoom,
    cloneValue,
    buildPlaceholderRoomState,
    getPlaceholderRoomEntry,
    setPlaceholderRoomEntry,
    updatePocketState,
    isFinalRoomIndex,
    recordAuditEvent,
    buildRoomLogContext,
    log,
    markCurrentRoomConduitOpen,
    refreshAbyssalDungeonTrackingState,
    recordAbyssalRunOutcome,
  } = ports;
  const {
    instanceID,
    effectiveNowMs,
    deps,
    plannedObjectiveNpcItemIDs,
    materializedObjectiveNpcItemIDs,
    destroyedObjectiveIDs,
    defeatedObjectiveItemIDs,
    remainingHostileEntityIDs,
    remainingObjectiveEntityIDs,
    requiredObjectiveCount,
    allRequiredObjectivesDestroyed,
    roomEncounterDegraded,
  } = work;
  let {
    pocketState,
    roomState,
    currentRoomEntry,
  } = work;
  if (
      remainingObjectiveEntityIDs.length === 0 &&
      allRequiredObjectivesDestroyed &&
      !roomEncounterDegraded
    ) {
    const roomObjectiveCompleted = isFinalRoomIndex(pocketState, roomState.currentRoomIndex);
    const nextRoomState = setPlaceholderRoomEntry(
      pocketState,
      roomState.currentRoomIndex,
      {
        ...currentRoomEntry,
        hostileEntityIDs: remainingHostileEntityIDs,
        plannedObjectiveNpcItemIDs,
        materializedObjectiveNpcItemIDs,
        objectiveRelevantNpcItemIDs: [],
        defeatedObjectiveItemIDs,
        destroyedObjectiveIDs,
        objectiveTotal: requiredObjectiveCount,
        objectiveDefeatedCount: defeatedObjectiveItemIDs.length,
        objectiveComplete: true,
        objectiveCompletedAtMs: effectiveNowMs,
      },
      {
        finalExitAvailable: roomObjectiveCompleted,
      },
    );
    const updatedPocketState = updatePocketState(instanceID, {
      ...buildPocketStateForCurrentRoom(pocketState, nextRoomState),
      hostileEntityIDs: [],
      objectiveComplete: true,
      objectiveCompletedAtMs: effectiveNowMs,
      encounterState: {
        ...cloneValue(pocketState.encounterState || {}),
        hostileEntityIDs: remainingHostileEntityIDs,
        plannedObjectiveNpcItemIDs,
        materializedObjectiveNpcItemIDs,
        objectiveRelevantNpcItemIDs: [],
        defeatedObjectiveItemIDs,
        destroyedObjectiveIDs,
        objectiveTotal: requiredObjectiveCount,
        objectiveDefeatedCount: defeatedObjectiveItemIDs.length,
        objectiveComplete: true,
        objectiveCompletedAtMs: effectiveNowMs,
      },
    });
    if (updatedPocketState) {
      pocketState = updatedPocketState;
      roomState = buildPlaceholderRoomState(updatedPocketState);
      currentRoomEntry = getPlaceholderRoomEntry(updatedPocketState, roomState.currentRoomIndex);
      recordAuditEvent("abyssal_placeholder_objective_complete", [], null, {
        instanceID,
        traceItemID: updatedPocketState.traceItemID,
        roomIndex: roomState.currentRoomIndex,
      });
      const roomLogContext = buildRoomLogContext(updatedPocketState, deps);
      log.info(
        `[AbyssalMgr] Room objective complete char=${updatedPocketState.characterID} ` +
          `ship=${roomLogContext.shipID} filament=${roomLogContext.filamentTypeID} ` +
          `name="${roomLogContext.filamentName}" tier=${roomLogContext.tier} weather=${roomLogContext.weather} ` +
          `instance=${updatedPocketState.instanceID} trace=${updatedPocketState.traceItemID} ` +
          `room=${roomLogContext.roomIndex}/${roomLogContext.totalRooms} roomOrigin=${roomLogContext.roomOrigin} ` +
          `finalShip=${roomLogContext.finalShip} hostileCount=${roomLogContext.hostileCount} ` +
          `cacheID=${roomLogContext.cacheID} conduitID=${roomLogContext.conduitID} ` +
          `timerRemainingMs=${roomLogContext.timerRemainingMs}`,
      );
      log.info(
        `[AbyssalMgr] Abyssal encounter complete ` +
          `instance=${toInt(updatedPocketState.instanceID, 0)} ` +
          `room=${toInt(roomState.currentRoomIndex, 0)} ` +
          `profileID=${normalizeText(currentRoomEntry.encounterProfileID, normalizeText(updatedPocketState.encounterState && updatedPocketState.encounterState.encounterProfileID, "unknown"))} ` +
          `defeated=${defeatedObjectiveItemIDs.length} ` +
          `required=${requiredObjectiveCount} ` +
          `conduitID=${toInt(currentRoomEntry.conduitItemID, 0)}`,
      );
      const openedPocketState = markCurrentRoomConduitOpen(
        updatedPocketState,
        null,
        deps,
        "objective-complete",
        effectiveNowMs,
      );
      if (openedPocketState) {
        pocketState = openedPocketState;
        roomState = buildPlaceholderRoomState(openedPocketState);
        currentRoomEntry = getPlaceholderRoomEntry(openedPocketState, roomState.currentRoomIndex);
      }
      refreshAbyssalDungeonTrackingState(
        openedPocketState || updatedPocketState,
        deps,
        "room_objective_complete",
      );
      if (roomObjectiveCompleted) {
        recordAbyssalRunOutcome(openedPocketState || updatedPocketState, "completed", deps, {
          reason: "final_room_hostiles_cleared",
        });
      }
    }
  }
  Object.assign(work, {
    pocketState,
    roomState,
    currentRoomEntry,
  });
}

function finalizeRunMaintenance(ports, work) {
  const {
    hasTerminalFailureOutcome,
    syncExpiredAbyssalPocketState,
    buildPlaceholderRoomState,
    hasFailedTimeoutOutcome,
    ensurePlaceholderRewardCache,
  } = ports;
  const {
    effectiveNowMs,
    deps,
  } = work;
  let {
    pocketState,
  } = work;
  pocketState = syncExpiredAbyssalPocketState(pocketState, effectiveNowMs, deps);
  if (!pocketState || hasFailedTimeoutOutcome(pocketState)) {
    return;
  }
  if (
    pocketState &&
    pocketState.objectiveComplete === true &&
    !hasTerminalFailureOutcome(pocketState)
  ) {
    ensurePlaceholderRewardCache(
      pocketState,
      null,
      deps,
      {
        roomIndex: buildPlaceholderRoomState(pocketState).currentRoomIndex,
      },
    );
  }
}

function runPlaceholderPocketMaintenance(ports, nowMs = null, deps = ports.getDependencies()) {
  const {
    cloneValue,
    tryBeginPass,
    getActiveWriteCount,
    finishPass,
  } = ports;
  const beginResult = tryBeginPass();
  if (!beginResult.started) {
    return {
      success: true,
      skipped: true,
      reason: beginResult.reason,
    };
  }
  const startedAtMs = Date.now();
  try {
    const passResult = runPlaceholderPocketMaintenancePass(ports, nowMs, deps);
    return {
      success: true,
      skipped: false,
      writeCount: getActiveWriteCount(),
      tombstoneEviction: cloneValue(passResult && passResult.tombstoneEviction),
    };
  } finally {
    const durationMs = Math.max(0, Date.now() - startedAtMs);
    finishPass(durationMs);
  }
}

function schedulePlaceholderPocketMaintenance(ports, deps = ports.getDependencies()) {
  const {
    recordAbyssalMaintenanceFailure,
    hasAbyssalRecoveryTombstoneBacklog,
    PLACEHOLDER_POCKET_MAINTENANCE_INTERVAL_MS,
    ABYSSAL_RECOVERY_TOMBSTONE_IDLE_MAINTENANCE_INTERVAL_MS,
    getActiveRunCount,
    hasTimerHandle,
    takeTimerHandleIfCurrent,
    setTimerHandle,
    hasTombstoneScanInProgress,
    getDependencies,
  } = ports;
  if (hasTimerHandle()) {
    return;
  }
  const hasActiveRuns = getActiveRunCount() > 0;
  const hasTombstoneWork = hasAbyssalRecoveryTombstoneBacklog() ||
    hasTombstoneScanInProgress();
  if (!hasActiveRuns && !hasTombstoneWork) {
    return;
  }
  if (!(deps && typeof deps.scheduleTimeout === "function")) {
    return;
  }
  let maintenanceHandle;
  maintenanceHandle = deps.scheduleTimeout(() => {
    if (takeTimerHandleIfCurrent(maintenanceHandle) === null) return;
    try {
      runPlaceholderPocketMaintenance(ports, null, getDependencies());
    } catch (error) {
      recordAbyssalMaintenanceFailure(
        0,
        null,
        error,
        "scheduled-maintenance-callback",
      );
    } finally {
      if (
        getActiveRunCount() > 0 ||
        hasAbyssalRecoveryTombstoneBacklog() ||
        hasTombstoneScanInProgress()
      ) {
        schedulePlaceholderPocketMaintenance(ports, getDependencies());
      }
    }
  }, hasActiveRuns || hasTombstoneScanInProgress()
    ? PLACEHOLDER_POCKET_MAINTENANCE_INTERVAL_MS
    : ABYSSAL_RECOVERY_TOMBSTONE_IDLE_MAINTENANCE_INTERVAL_MS);
  setTimerHandle(maintenanceHandle);
}

function createAbyssalRunMaintenance(ports) {
  return {
    runPlaceholderPocketMaintenance: runPlaceholderPocketMaintenance.bind(null, ports),
    schedulePlaceholderPocketMaintenance: schedulePlaceholderPocketMaintenance.bind(null, ports),
  };
}

module.exports = { createAbyssalRunMaintenance };
