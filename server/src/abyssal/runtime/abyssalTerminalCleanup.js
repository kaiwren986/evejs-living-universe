"use strict";

const { normalizeText } = require("../domain/abyssalValueUtils");

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

// Terminal cleanup coordinates existing owners. It neither owns run state nor
// releases a scene/reservation before the injected prerequisite stages settle.
function reconcileAbyssalTerminalCleanupArtifacts({
  clearPendingAbyssalKSpaceArrival,
  cancelPendingAbyssalTransition,
  stopSuppressorPresentationsForPocketRun,
  collectAbyssalArtifactInventory,
  createAbyssalTerminalArtifactCleanupCoordinator,
  destroyPocketArtifacts,
  ensureAbyssalPocketPersistenceReady,
  updatePocketState,
  schedulePlaceholderPocketMaintenance,
  rememberAbyssalCleanupReport,
  cloneValue,
  log,
}, context) {
  const { resolvedPocketState, deps, options, reason, instanceID, stagedCleanupState, cleanupNowMs } = context;
  if (options.session) {
    clearPendingAbyssalKSpaceArrival(options.session, deps);
  }
  cancelPendingAbyssalTransition(resolvedPocketState.instanceID, deps, reason);
  stopSuppressorPresentationsForPocketRun(resolvedPocketState, deps, {
    reason,
  });
  const artifactInventory = collectAbyssalArtifactInventory(resolvedPocketState, deps);
  const artifactCleanupResult = createAbyssalTerminalArtifactCleanupCoordinator({
    revalidateCleanupAuthority: ({ identity }) => ({
      success: true, cleanupPermitted: true, identity,
    }),
    reconcileOwnedArtifacts: ({ reason: cleanupReason }) =>
      destroyPocketArtifacts(resolvedPocketState, deps, cleanupReason),
    persistCleanupPending: ({ pendingCleanupState }) =>
      ensureAbyssalPocketPersistenceReady(
        updatePocketState(instanceID, {
          terminalCleanupState: pendingCleanupState,
        }),
        deps,
      ),
  }).executeCleanup({
    instanceID,
    characterID: toInt(resolvedPocketState.characterID, 0),
    traceItemID: toInt(resolvedPocketState.traceItemID, 0),
    sceneKey: normalizeText(resolvedPocketState.sceneKey,
      `solar-system:${toInt(resolvedPocketState.solarSystemID, 0)}`),
    participantsSettled: true,
    terminalCleanupState: stagedCleanupState,
    nowMs: cleanupNowMs,
    reason,
  });
  const { artifactResult, cleanupSummary } = artifactCleanupResult;
  if (!artifactCleanupResult.success) {
    const {
      failedArtifactCount, failedResidualSpaceItemCount,
      failedScannerProbeCleanupCount,
    } = artifactCleanupResult;
    const pendingPersistenceSucceeded = Boolean(
      artifactCleanupResult.persistenceResult &&
      artifactCleanupResult.persistenceResult.success === true,
    );
    schedulePlaceholderPocketMaintenance(deps);
    rememberAbyssalCleanupReport({
      reason,
      scope: "active-run",
      instanceID,
      characterID: toInt(resolvedPocketState.characterID, 0),
      cleanupPending: true,
      cleanupFailedCount:
        failedArtifactCount +
        failedResidualSpaceItemCount +
        failedScannerProbeCleanupCount,
      failedArtifactCount,
      failedResidualSpaceItemCount,
      failedScannerProbeCleanupCount,
      failedItemIDs: cloneValue(cleanupSummary.failedItemIDs || []),
      pendingPersistenceSucceeded,
      sceneDisposed: false,
    });
    log.warn(
      `[AbyssalCleanupRetry] run=${instanceID} state=pending reason=${reason} ` +
        `failedArtifacts=${failedArtifactCount} ` +
        `failedResidualSpaceItems=${failedResidualSpaceItemCount} ` +
        `failedScannerProbeCleanup=${failedScannerProbeCleanupCount} ` +
        `persisted=${pendingPersistenceSucceeded}`,
    );
    return {
      success: false,
      pending: true,
      alreadyClean: false,
      errorMsg: artifactCleanupResult.errorMsg || "ABYSSAL_ARTIFACT_CLEANUP_PENDING",
      reason,
      destroyedItemIDs: artifactResult.destroyedItemIDs,
      destroyedScannerProbeIDs: artifactResult.destroyedScannerProbeIDs,
      destroyedHostileIDs: artifactResult.destroyedHostileIDs,
      cleanupSummary: cloneValue(cleanupSummary),
      purged: false,
      sceneDisposed: false,
      sceneAlreadyGone: false,
    };
  }
  Object.assign(context, { artifactInventory, artifactResult, cleanupSummary });
  return null;
}

function clearAbyssalTerminalCleanupRoomScope({
  buildPlaceholderRoomState,
  logAbyssalRoomContentCleaned,
  listAbyssalRoomEntityRecords,
  summarizeAbyssalRoomEntities,
  log,
  formatAbyssalRoomEntityCountsForLog,
  getPocketScene,
  normalizeAbyssalParticipantRoster,
  clearExactAbyssalParticipantRoomScopeMetadata,
  listUniquePositiveInts,
  listAllPocketHostileEntityIDs,
  clearAbyssalEnvironmentalModifiersForRun,
}, context) {
  const { resolvedPocketState, deps, reason, instanceID } = context;
  const cleanupRoomState = buildPlaceholderRoomState(resolvedPocketState);
  const remainingRoomRecords = [];
  for (let roomIndex = 1; roomIndex <= cleanupRoomState.implementedRooms; roomIndex += 1) {
    logAbyssalRoomContentCleaned(resolvedPocketState, {
      roomIndex,
      existingOnly: true,
    });
    remainingRoomRecords.push(
      ...listAbyssalRoomEntityRecords(resolvedPocketState, roomIndex, deps)
        .filter((record) => record.runtimeMaterialized === true),
    );
  }
  const remainingRoomCounts = summarizeAbyssalRoomEntities(remainingRoomRecords);
  log.info(
    `[AbyssalRoomContent] run=${instanceID} room=all phase=cleaned-final ` +
      `${formatAbyssalRoomEntityCountsForLog(remainingRoomCounts)} ` +
      `remainingRoomEntityCount=${remainingRoomCounts.totalRoomEntityCount} ` +
      `remainingDecorationCount=${remainingRoomCounts.decorationCount} ` +
      `remainingFunctionalEnvironmentCount=${remainingRoomCounts.functionalEnvironmentCount} ` +
      `remainingPerimeterCount=${remainingRoomCounts.perimeterCount} ` +
      `remainingWeatherCount=${remainingRoomCounts.weatherCount} ` +
      `remainingVolumetricCloudCount=${remainingRoomCounts.volumetricCloudCount} ` +
      `remainingUnknownCount=${remainingRoomCounts.unknownCount}`,
  );
  const scene = getPocketScene(resolvedPocketState, deps);
  let trackedParticipantShipForPostPurgeRefresh = null;
  if (scene && typeof scene.getEntityByID === "function") {
    const participantShipIDs = normalizeAbyssalParticipantRoster(resolvedPocketState)
      .map((participant) => participant.shipID)
      .filter((participantShipID) => participantShipID > 0);
    const trackedParticipantShip = scene.getEntityByID(
      toInt(resolvedPocketState.shipID, 0),
    );
    trackedParticipantShipForPostPurgeRefresh = trackedParticipantShip || null;
    for (const participantShipID of participantShipIDs) {
      const participantShip = scene.getEntityByID(participantShipID);
      if (
        participantShip &&
        deps.dungeonTrackingRuntime &&
        typeof deps.dungeonTrackingRuntime.clearShipCurrentDungeonRoom === "function"
      ) {
        deps.dungeonTrackingRuntime.clearShipCurrentDungeonRoom(
          participantShip,
          {
            nowMs: toInt(deps.now(), Date.now()),
            reason,
          },
        );
      }
      clearExactAbyssalParticipantRoomScopeMetadata(
        participantShip,
        resolvedPocketState.instanceID,
      );
    }
    for (const entityID of listUniquePositiveInts([
      ...participantShipIDs,
      ...listAllPocketHostileEntityIDs(resolvedPocketState),
    ])) {
      clearAbyssalEnvironmentalModifiersForRun(
        scene.getEntityByID(entityID),
        resolvedPocketState.instanceID,
        {
          scene,
          nowMs: toInt(deps.now(), Date.now()),
          reason,
        },
      );
    }
  }
  Object.assign(context, { remainingRoomCounts, scene, trackedParticipantShipForPostPurgeRefresh });
  return null;
}

function settleAbyssalTerminalCleanupWeather({
  reconcileAbyssalCleanupWeather,
}, context) {
  const { deps, options, reason, instanceID, cleanupNowMs, stagedCleanupState, artifactResult, cleanupSummary } = context;
  let { resolvedPocketState } = context;
  const weatherCleanup = reconcileAbyssalCleanupWeather({
    resolvedPocketState, instanceID, reason, cleanupNowMs, stagedCleanupState,
    artifactResult, cleanupSummary, deps, options,
  });
  if (!weatherCleanup.ready) return weatherCleanup.result;
  resolvedPocketState = weatherCleanup.resolvedPocketState;
  const {
    cleanupShipID, cleanupRunOutcome, weatherRemovalRequired, weatherRemovalResult,
  } = weatherCleanup;
  Object.assign(context, { resolvedPocketState, cleanupShipID, cleanupRunOutcome, weatherRemovalRequired, weatherRemovalResult });
  return null;
}

function disposeAbyssalTerminalCleanupScene({
  buildAbyssalSceneDescriptor,
  usesIsolatedAbyssalScene,
  getActivePocketStateByInstanceID,
  updatePocketState,
  ensureAbyssalPocketPersistenceReady,
  schedulePlaceholderPocketMaintenance,
  log,
  cloneValue,
}, context) {
  const { resolvedPocketState, deps, reason, instanceID, stagedCleanupState, cleanupNowMs, artifactResult, cleanupSummary } = context;
  const runtime = deps;
  const sceneDescriptor = buildAbyssalSceneDescriptor(resolvedPocketState, deps);
  let sceneDisposeResult = null;
  if (usesIsolatedAbyssalScene(resolvedPocketState, deps)) {
    try {
      sceneDisposeResult =
        runtime &&
        typeof runtime.disposeScene === "function" &&
        sceneDescriptor
          ? runtime.disposeScene(sceneDescriptor, {
              force: true,
              reason,
            })
          : {
              success: false,
              errorMsg: "ABYSSAL_SCENE_DISPOSAL_UNAVAILABLE",
            };
    } catch (error) {
      sceneDisposeResult = {
        success: false,
        errorMsg: normalizeText(
          error && error.message,
          "ABYSSAL_SCENE_DISPOSAL_FAILED",
        ),
      };
    }
    const sceneCleanupSettled = Boolean(
      sceneDisposeResult &&
      (sceneDisposeResult.removed === true || sceneDisposeResult.alreadyGone === true),
    );
    if (!sceneCleanupSettled) {
      const sceneFailureReason = normalizeText(
        sceneDisposeResult && sceneDisposeResult.errorMsg,
        "ABYSSAL_SCENE_DISPOSAL_FAILED",
      );
      const pendingPocketState = getActivePocketStateByInstanceID(instanceID)
        ? updatePocketState(instanceID, {
            terminalCleanupState: {
              ...stagedCleanupState,
              status: "pending",
              lastFailedAtMs: cleanupNowMs,
              failureReason: sceneFailureReason,
            },
          })
        : null;
      const pendingPersistence = pendingPocketState
        ? ensureAbyssalPocketPersistenceReady(pendingPocketState, deps)
        : { success: false };
      schedulePlaceholderPocketMaintenance(deps);
      log.warn(
        `[AbyssalCleanupRetry] run=${instanceID} state=pending ` +
          `reason=${sceneFailureReason} persisted=${pendingPersistence.success === true} ` +
          `slotRetained=true`,
      );
      return {
        success: false,
        pending: true,
        alreadyClean: false,
        errorMsg: pendingPersistence.success === true
          ? sceneFailureReason
          : "ABYSSAL_CLEANUP_PENDING_PERSIST_FAILED",
        reason,
        destroyedItemIDs: artifactResult.destroyedItemIDs,
        destroyedScannerProbeIDs: artifactResult.destroyedScannerProbeIDs || [],
        destroyedHostileIDs: artifactResult.destroyedHostileIDs,
        cleanupSummary: cloneValue(cleanupSummary),
        purged: false,
        sceneDisposed: false,
        sceneAlreadyGone: false,
        spatialReservationRetained: true,
      };
    }
  }
  context.sceneDisposeResult = sceneDisposeResult;
  return null;
}

function purgeAbyssalTerminalCleanupRun({
  purgePlaceholderPocket,
  getActivePocketStateByInstanceID,
  updatePocketState,
  ensureAbyssalPocketPersistenceReady,
  schedulePlaceholderPocketMaintenance,
  log,
  cloneValue,
}, context) {
  const { resolvedPocketState, deps, reason, instanceID, stagedCleanupState, cleanupNowMs, artifactResult, cleanupSummary } = context;
  const purged = purgePlaceholderPocket(resolvedPocketState.instanceID, deps, reason);
  if (purged !== true) {
    const pendingPocketState = getActivePocketStateByInstanceID(instanceID)
      ? updatePocketState(instanceID, {
          terminalCleanupState: {
            ...stagedCleanupState,
            status: "pending",
            lastFailedAtMs: cleanupNowMs,
            failureReason: "ABYSSAL_RUN_PURGE_FAILED",
          },
        })
      : null;
    const pendingPersistence = pendingPocketState
      ? ensureAbyssalPocketPersistenceReady(pendingPocketState, deps)
      : { success: false };
    schedulePlaceholderPocketMaintenance(deps);
    log.warn(
      `[AbyssalCleanupRetry] run=${instanceID} state=pending ` +
        `reason=ABYSSAL_RUN_PURGE_FAILED persisted=${pendingPersistence.success === true}`,
    );
    return {
      success: false,
      pending: true,
      alreadyClean: false,
      errorMsg: "ABYSSAL_RUN_PURGE_FAILED",
      reason,
      destroyedItemIDs: artifactResult.destroyedItemIDs,
      destroyedScannerProbeIDs: artifactResult.destroyedScannerProbeIDs || [],
      destroyedHostileIDs: artifactResult.destroyedHostileIDs,
      cleanupSummary: cloneValue(cleanupSummary),
      purged: false,
      sceneDisposed: false,
      sceneAlreadyGone: false,
    };
  }
  context.purged = purged;
  return null;
}

function clearAbyssalTerminalCleanupSessions({
  clearAbyssalSessionState,
  normalizeAbyssalParticipantRoster,
  resolveAbyssalRosterParticipantSession,
}, context) {
  const { resolvedPocketState, deps, options } = context;
  if (options.session) {
    clearAbyssalSessionState(options.session);
  }
  for (const participant of normalizeAbyssalParticipantRoster(resolvedPocketState)) {
    const participantSession = resolveAbyssalRosterParticipantSession(
      resolvedPocketState,
      participant,
      deps,
      options.session,
    );
    if (participantSession) {
      clearAbyssalSessionState(participantSession, {
        preserveCommittedArrivalPresentation: true,
      });
    }
  }
}

function refreshAbyssalTerminalCleanupRetiredShip({
  refreshAbyssalPlayerShipWeather,
}, context) {
  const { resolvedPocketState, deps, options, purged, weatherRemovalRequired, cleanupRunOutcome, scene, cleanupShipID, trackedParticipantShipForPostPurgeRefresh } = context;
  if (
    purged === true &&
    weatherRemovalRequired === false &&
    (
      cleanupRunOutcome === "failed_ship_destroyed" ||
      resolvedPocketState.timeoutState &&
        resolvedPocketState.timeoutState.shipDestroyed === true
    ) &&
    scene
  ) {
    // Destruction replaces the active session ship with a capsule before run
    // cleanup. There is then no live exact-ship session with which to perform
    // the normal durable K-space weather-removal handshake. Recompute the
    // retired scene object once the run authority has been unregistered so a
    // destruction observer cannot retain stale Abyssal-derived attributes.
    const retiredShipRefreshSession = {
      ...(options.session && typeof options.session === "object" ? options.session : {}),
      characterID: toInt(resolvedPocketState.characterID, 0),
      shipID: cleanupShipID,
      shipid: cleanupShipID,
      activeShipID: cleanupShipID,
      activeShipId: cleanupShipID,
      solarsystemid: toInt(resolvedPocketState.solarSystemID, 0),
      solarsystemid2: toInt(resolvedPocketState.solarSystemID, 0),
      spaceSceneKey: normalizeText(
        scene.sceneKey,
        normalizeText(resolvedPocketState.sceneKey, ""),
      ),
      _space: {
        ...(options.session && options.session._space || {}),
        shipID: cleanupShipID,
        systemID: toInt(resolvedPocketState.solarSystemID, 0),
        locationID: toInt(resolvedPocketState.solarSystemID, 0),
        sceneKey: normalizeText(
          scene.sceneKey,
          normalizeText(resolvedPocketState.sceneKey, ""),
        ),
      },
    };
    const retiredShipRefreshResult = refreshAbyssalPlayerShipWeather(
      retiredShipRefreshSession,
      deps,
      {
        broadcast: false,
        notifyTargeting: false,
        notifyGenericModuleAttributes: false,
      },
    );
    if (
      (!retiredShipRefreshResult || retiredShipRefreshResult.refreshed !== true) &&
      trackedParticipantShipForPostPurgeRefresh &&
      typeof scene.refreshShipEntityDerivedState === "function"
    ) {
      scene.refreshShipEntityDerivedState(trackedParticipantShipForPostPurgeRefresh, {
        session: null,
        broadcast: false,
        notifyTargeting: false,
      });
    }
  }
}

function reportAbyssalTerminalCleanup({
  rememberAbyssalCleanupReport,
  log,
}, context) {
  const { resolvedPocketState, reason, artifactInventory, cleanupSummary, remainingRoomCounts, sceneDisposeResult, artifactResult, purged } = context;
  rememberAbyssalCleanupReport({
    reason,
    scope: "active-run",
    instanceID: toInt(resolvedPocketState.instanceID, 0),
    characterID: toInt(resolvedPocketState.characterID, 0),
    artifactCounts: {
      entranceTraces: artifactInventory.entranceTraces.length,
      markers: artifactInventory.markers.length,
      conduits: artifactInventory.conduits.length,
      hostiles: artifactInventory.hostiles.length,
      rewardCaches: artifactInventory.rewardCaches.length,
      extractionNodes: artifactInventory.extractionNodes.length,
      sceneryVisuals: artifactInventory.sceneryVisuals.length,
      environmentalObjects: artifactInventory.environmentalObjects.length,
      weatherEffects: artifactInventory.weatherEffects.length,
    },
    cleanupFailedCount: toInt(cleanupSummary.failedArtifacts, 0),
    artifactRemovalAttemptsAlreadyGoneCount: toInt(
      cleanupSummary.artifactRemovalAttemptsAlreadyGone,
      0,
    ),
    alreadyGoneCount: toInt(cleanupSummary.artifactRemovalAttemptsAlreadyGone, 0),
    alreadyGoneCountScope: "artifact-removal-attempts",
    staleArtifactCount: 0,
    remainingRoomEntityCount: remainingRoomCounts.totalRoomEntityCount,
    remainingDecorationCount: remainingRoomCounts.decorationCount,
    remainingFunctionalEnvironmentCount: remainingRoomCounts.functionalEnvironmentCount,
    remainingPerimeterCount: remainingRoomCounts.perimeterCount,
    remainingWeatherCount: remainingRoomCounts.weatherCount,
    remainingVolumetricCloudCount: remainingRoomCounts.volumetricCloudCount,
    remainingUnknownCount: remainingRoomCounts.unknownCount,
    sceneDisposed: Boolean(sceneDisposeResult && sceneDisposeResult.removed === true),
    sceneAlreadyGone: Boolean(sceneDisposeResult && sceneDisposeResult.alreadyGone === true),
  });
  log.info(
    `[AbyssalMgr] Abyssal run cleanup complete char=${resolvedPocketState.characterID} ` +
      `instance=${resolvedPocketState.instanceID} trace=${resolvedPocketState.traceItemID} ` +
      `reason=${reason} destroyedItems=${artifactResult.destroyedItemIDs.length} ` +
      `destroyedHostiles=${artifactResult.destroyedHostileIDs.length} ` +
      `removedEntranceTraces=${toInt(cleanupSummary.removedEntranceTraces, 0)} ` +
      `removedMarkers=${toInt(cleanupSummary.removedRoomMarkers, 0)} ` +
      `removedConduits=${toInt(cleanupSummary.removedConduits, 0)} ` +
      `removedRewardCaches=${toInt(cleanupSummary.removedRewardCaches, 0)} ` +
      `removedExtractionNodes=${toInt(cleanupSummary.removedExtractionNodes, 0)} ` +
      `removedExtractionNodeLootContainers=${toInt(cleanupSummary.removedExtractionNodeLootContainers, 0)} ` +
      `removedEnvironmentalObjects=${toInt(cleanupSummary.removedEnvironmentalObjects, 0)} ` +
      `removedSceneryVisuals=${toInt(cleanupSummary.removedSceneryVisuals, 0)} ` +
      `removedResidualSpaceItems=${toInt(cleanupSummary.removedResidualSpaceItems, 0)} ` +
      `rewardCachesAlreadyGone=${toInt(cleanupSummary.rewardCachesAlreadyGone, 0)} ` +
      `extractionNodesAlreadyGone=${toInt(cleanupSummary.extractionNodesAlreadyGone, 0)} ` +
      `extractionNodeLootContainersAlreadyGone=${toInt(cleanupSummary.extractionNodeLootContainersAlreadyGone, 0)} ` +
      `failedExtractionNodes=${toInt(cleanupSummary.failedExtractionNodes, 0)} ` +
      `trackedExtractionNodeReferences=${toInt(cleanupSummary.trackedExtractionNodeReferences, 0)} ` +
      `uniqueExtractionNodes=${toInt(cleanupSummary.uniqueExtractionNodes, 0)} ` +
      `duplicateExtractionNodeReferences=${toInt(cleanupSummary.duplicateExtractionNodeReferences, 0)} ` +
      `environmentalObjectsAlreadyGone=${toInt(cleanupSummary.environmentalObjectsAlreadyGone, 0)} ` +
      `sceneryVisualsAlreadyGone=${toInt(cleanupSummary.sceneryVisualsAlreadyGone, 0)} ` +
      `residualSpaceItemsAlreadyGone=${toInt(cleanupSummary.residualSpaceItemsAlreadyGone, 0)} ` +
      `artifactRemovalAttemptsAlreadyGone=${toInt(cleanupSummary.artifactRemovalAttemptsAlreadyGone, 0)} ` +
      `failed=${toInt(cleanupSummary.failedArtifacts, 0)} ` +
      `failedResidualSpaceItems=${toInt(cleanupSummary.failedResidualSpaceItems, 0)} ` +
      `diagnosticSkippedResidualSpaceItems=${toInt(cleanupSummary.diagnosticSkippedResidualSpaceItems, 0)} ` +
      `purged=${purged === true} ` +
      `sceneDisposed=${Boolean(sceneDisposeResult && sceneDisposeResult.removed === true)} ` +
      `sceneAlreadyGone=${Boolean(sceneDisposeResult && sceneDisposeResult.alreadyGone === true)}`,
  );
}

function cleanupAbyssalRun({
  getDependencies,
  prepareAbyssalRunCleanup,
  reconcileAbyssalTerminalCleanupArtifacts,
  clearAbyssalTerminalCleanupRoomScope,
  settleAbyssalTerminalCleanupWeather,
  disposeAbyssalTerminalCleanupScene,
  purgeAbyssalTerminalCleanupRun,
  clearAbyssalTerminalCleanupSessions,
  refreshAbyssalTerminalCleanupRetiredShip,
  reportAbyssalTerminalCleanup,
  cloneValue,
}, pocketState, deps = getDependencies(), options = {}) {
  const preparation = prepareAbyssalRunCleanup(pocketState, deps, options);
  if (!preparation.ready) return preparation.result;
  const context = { ...preparation, deps, options };
  for (const step of [
    reconcileAbyssalTerminalCleanupArtifacts,
    clearAbyssalTerminalCleanupRoomScope,
    settleAbyssalTerminalCleanupWeather,
    disposeAbyssalTerminalCleanupScene,
    purgeAbyssalTerminalCleanupRun,
  ]) {
    const result = step(context);
    if (result) return result;
  }
  clearAbyssalTerminalCleanupSessions(context);
  refreshAbyssalTerminalCleanupRetiredShip(context);
  reportAbyssalTerminalCleanup(context);
  const { purged, reason, artifactResult, weatherRemovalResult, weatherRemovalRequired, sceneDisposeResult } = context;
  return {
    success: purged === true,
    alreadyClean: false,
    reason,
    destroyedItemIDs: artifactResult.destroyedItemIDs,
    destroyedScannerProbeIDs: artifactResult.destroyedScannerProbeIDs || [],
    destroyedHostileIDs: artifactResult.destroyedHostileIDs,
    cleanupSummary: cloneValue(artifactResult.cleanupSummary || {}),
    weatherRemovalResult,
    weatherRemovalDegraded: Boolean(
      weatherRemovalRequired &&
      weatherRemovalResult &&
      weatherRemovalResult.verified !== true
    ),
    purged: purged === true,
    sceneDisposed: Boolean(sceneDisposeResult && sceneDisposeResult.removed === true),
    sceneAlreadyGone: Boolean(sceneDisposeResult && sceneDisposeResult.alreadyGone === true),
  };
}

// Capture supplied capabilities once, as the original closure did. Internal
// callbacks are bound once per instance; no runtime state lives in this wiring.
function createAbyssalTerminalCleanup({
  clearPendingAbyssalKSpaceArrival,
  cancelPendingAbyssalTransition,
  stopSuppressorPresentationsForPocketRun,
  collectAbyssalArtifactInventory,
  createAbyssalTerminalArtifactCleanupCoordinator,
  destroyPocketArtifacts,
  ensureAbyssalPocketPersistenceReady,
  updatePocketState,
  schedulePlaceholderPocketMaintenance,
  rememberAbyssalCleanupReport,
  cloneValue,
  log,
  buildPlaceholderRoomState,
  logAbyssalRoomContentCleaned,
  listAbyssalRoomEntityRecords,
  summarizeAbyssalRoomEntities,
  formatAbyssalRoomEntityCountsForLog,
  getPocketScene,
  normalizeAbyssalParticipantRoster,
  clearExactAbyssalParticipantRoomScopeMetadata,
  listUniquePositiveInts,
  listAllPocketHostileEntityIDs,
  clearAbyssalEnvironmentalModifiersForRun,
  reconcileAbyssalCleanupWeather,
  buildAbyssalSceneDescriptor,
  usesIsolatedAbyssalScene,
  getActivePocketStateByInstanceID,
  purgePlaceholderPocket,
  clearAbyssalSessionState,
  resolveAbyssalRosterParticipantSession,
  refreshAbyssalPlayerShipWeather,
  getDependencies,
  prepareAbyssalRunCleanup,
}) {

  const ports = {
    clearPendingAbyssalKSpaceArrival,
    cancelPendingAbyssalTransition,
    stopSuppressorPresentationsForPocketRun,
    collectAbyssalArtifactInventory,
    createAbyssalTerminalArtifactCleanupCoordinator,
    destroyPocketArtifacts,
    ensureAbyssalPocketPersistenceReady,
    updatePocketState,
    schedulePlaceholderPocketMaintenance,
    rememberAbyssalCleanupReport,
    cloneValue,
    log,
    buildPlaceholderRoomState,
    logAbyssalRoomContentCleaned,
    listAbyssalRoomEntityRecords,
    summarizeAbyssalRoomEntities,
    formatAbyssalRoomEntityCountsForLog,
    getPocketScene,
    normalizeAbyssalParticipantRoster,
    clearExactAbyssalParticipantRoomScopeMetadata,
    listUniquePositiveInts,
    listAllPocketHostileEntityIDs,
    clearAbyssalEnvironmentalModifiersForRun,
    reconcileAbyssalCleanupWeather,
    buildAbyssalSceneDescriptor,
    usesIsolatedAbyssalScene,
    getActivePocketStateByInstanceID,
    purgePlaceholderPocket,
    clearAbyssalSessionState,
    resolveAbyssalRosterParticipantSession,
    refreshAbyssalPlayerShipWeather,
    getDependencies,
    prepareAbyssalRunCleanup,
  };
  ports.reconcileAbyssalTerminalCleanupArtifacts = reconcileAbyssalTerminalCleanupArtifacts.bind(null, ports);
  ports.clearAbyssalTerminalCleanupRoomScope = clearAbyssalTerminalCleanupRoomScope.bind(null, ports);
  ports.settleAbyssalTerminalCleanupWeather = settleAbyssalTerminalCleanupWeather.bind(null, ports);
  ports.disposeAbyssalTerminalCleanupScene = disposeAbyssalTerminalCleanupScene.bind(null, ports);
  ports.purgeAbyssalTerminalCleanupRun = purgeAbyssalTerminalCleanupRun.bind(null, ports);
  ports.clearAbyssalTerminalCleanupSessions = clearAbyssalTerminalCleanupSessions.bind(null, ports);
  ports.refreshAbyssalTerminalCleanupRetiredShip = refreshAbyssalTerminalCleanupRetiredShip.bind(null, ports);
  ports.reportAbyssalTerminalCleanup = reportAbyssalTerminalCleanup.bind(null, ports);
  ports.cleanupAbyssalRun = cleanupAbyssalRun.bind(null, ports);
  Object.freeze(ports);
  return { cleanupAbyssalRun: ports.cleanupAbyssalRun };
}

module.exports = { createAbyssalTerminalCleanup };
