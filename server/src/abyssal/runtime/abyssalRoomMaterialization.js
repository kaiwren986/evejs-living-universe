"use strict";

const { normalizeText } = require("../domain/abyssalValueUtils");

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

// Ordered room-content orchestration. Catalog selection, runtime entities,
// persistence and transition ownership stay with the injected authorities.
function validateAbyssalRoomContentProfiles({
  resolveRoomEncounterProfile,
  resolveRoomRewardProfile,
  log,
  cloneValue,
}, basePocketState, roomIndex, roomState) {
  try {
    const resolvedEncounterProfile = resolveRoomEncounterProfile(
      basePocketState,
      roomIndex,
      { logResolution: false },
    );
    resolveRoomRewardProfile(basePocketState, roomIndex, {
      encounterProfile: resolvedEncounterProfile,
      logResolution: false,
    });
  } catch (error) {
    const errorMsg = normalizeText(
      error && error.message,
      "ABYSSAL_ROOM_CONTENT_PROFILE_MISSING",
    );
    log.error(
      `[AbyssalMgr] Abyssal room content resolution failed ` +
        `char=${toInt(basePocketState.characterID, 0)} ` +
        `instance=${toInt(basePocketState.instanceID, 0)} ` +
        `trace=${toInt(basePocketState.traceItemID, 0)} ` +
        `room=${roomIndex}/${roomState.implementedRooms} reason=${errorMsg}`,
    );
    return {
      success: false,
      partial: false,
      errorMsg,
      errors: [errorMsg],
      data: cloneValue(basePocketState),
    };
  }
  return null;
}

function prepareAbyssalRoomContentState({
  setPlaceholderRoomEntry,
  buildRoomShipSpawnState,
  buildPocketStateForCurrentRoom,
  getObjectPosition,
  buildEncounterStateFromRoomEntry,
  getPlaceholderRoomEntry,
  cloneValue,
  buildPlaceholderTimerState,
  getNpcRuntimePolicy,
  registerPocket,
  log,
  schedulePlaceholderPocketMaintenance,
}, basePocketState, existingPocketState, roomState, roomIndex, currentRoomEntry, originPosition, conduitLabel, deps) {
  roomState = setPlaceholderRoomEntry(
    basePocketState,
    roomIndex,
    {
      ...currentRoomEntry,
      roomOriginPosition: originPosition,
      shipSpawnState: buildRoomShipSpawnState(basePocketState, roomIndex),
      conduitLabel,
      enteredAtMs: toInt(currentRoomEntry.enteredAtMs, toInt(deps.now(), 0)),
    },
  );
  const nextPocketState = {
    ...buildPocketStateForCurrentRoom(
      {
        ...(existingPocketState || basePocketState),
        roomOneOriginPosition: getObjectPosition(basePocketState.roomOneOriginPosition) ||
          getObjectPosition(basePocketState.pocketPosition),
      },
      roomState,
    ),
    encounterState: buildEncounterStateFromRoomEntry(
      getPlaceholderRoomEntry(basePocketState, roomIndex),
    ),
    timerState:
      existingPocketState && existingPocketState.timerState
        ? cloneValue(existingPocketState.timerState)
        : buildPlaceholderTimerState(basePocketState, deps),
    timerFailureState: existingPocketState
      ? existingPocketState.timerFailureState ?? null
      : null,
    runOutcome: normalizeText(existingPocketState && existingPocketState.runOutcome, ""),
    runOutcomeAtMs: toInt(existingPocketState && existingPocketState.runOutcomeAtMs, 0),
    runOutcomeDetails: cloneValue(existingPocketState && existingPocketState.runOutcomeDetails) || null,
  };
  nextPocketState.npcRuntimePolicy = cloneValue(
    existingPocketState && existingPocketState.npcRuntimePolicy,
  ) || getNpcRuntimePolicy(nextPocketState);
  registerPocket(nextPocketState);
  if (!(existingPocketState && existingPocketState.timerState)) {
    log.info(
      `[AbyssalMgr] Abyssal timer started char=${nextPocketState.characterID} ` +
        `instance=${nextPocketState.instanceID} durationMs=${nextPocketState.timerState.durationMs} ` +
        `expiresAtMs=${nextPocketState.timerState.expiresAtMs}`,
    );
  }
  schedulePlaceholderPocketMaintenance(deps);
  return {
    success: true,
    data: cloneValue(nextPocketState),
  };
}

function createAbyssalRoomContentMarkers({
  destroyPlaceholderTrace,
  buildAbyssalSceneDescriptor,
  ensurePocketMarker,
  TYPE_ABYSSAL_ORIGIN_CONDUIT,
  TYPE_ABYSSAL_TRANSFER_CONDUIT,
  cloneValue,
}, basePocketState, roomIndex, currentRoomEntry, conduitState, conduitLabel, originPosition, isFinalRoom, isPrewarmPreparation, clientSyncSession, deps) {
  // Retail rooms use their dungeon origin internally but do not expose a
  // separate trace-type origin marker to the client. Remove one left by an
  // older persisted run before continuing recovery or materialisation.
  const legacyOriginMarkerItemID = toInt(currentRoomEntry.originMarkerItemID, 0);
  const legacyOriginCleanupResult = legacyOriginMarkerItemID > 0
    ? destroyPlaceholderTrace(
        basePocketState.solarSystemID,
        legacyOriginMarkerItemID,
        deps,
        "legacy-abyssal-origin-marker-removal",
        "legacy Abyssal origin marker",
        {
          sceneDescriptor:
            buildAbyssalSceneDescriptor(basePocketState, deps) || undefined,
        },
      )
    : null;
  const originResult = legacyOriginCleanupResult && legacyOriginCleanupResult.failed === true
    ? {
        success: false,
        created: false,
        itemID: legacyOriginMarkerItemID,
        changes: [],
        errorMsg: legacyOriginCleanupResult.errorMsg || "ORIGIN_MARKER_REMOVE_FAILED",
      }
    : {
        success: true,
        created: false,
        itemID: 0,
        changes: [],
      };
  const exitResult = ensurePocketMarker(
    "exit",
    conduitLabel,
    conduitState.position,
    {
      ...basePocketState,
      originMarkerItemID: originResult.itemID || basePocketState.originMarkerItemID,
    },
    clientSyncSession,
    deps,
    {
      roomIndex,
      conduitRole: isFinalRoom ? "final_exit" : "transfer",
      typeID: isFinalRoom ? TYPE_ABYSSAL_ORIGIN_CONDUIT : TYPE_ABYSSAL_TRANSFER_CONDUIT,
      dunObjectID: conduitState.dunObjectID,
      dunPosition: conduitState.dunPosition,
      dunRotation: conduitState.dunRotation,
      identity: cloneValue(conduitState.identity),
      capturedRetailObject: conduitState.capturedRetailObject === true,
      prewarm: isPrewarmPreparation,
      deliveryState: normalizeText(currentRoomEntry.deliveryState, ""),
      transitionToken: toInt(currentRoomEntry.deliveryTransitionToken, 0),
      selectedRoomLayoutID: normalizeText(currentRoomEntry.selectedRoomLayoutID, ""),
      roomOriginPosition: cloneValue(originPosition),
      authoredLocalPosition: cloneValue(conduitState.dunPosition),
    },
  );
  return { originResult, exitResult };
}

function buildAbyssalMaterializedEncounterRoomState({
  setPlaceholderRoomEntry,
  getPlaceholderRoomEntry,
  cloneValue,
  listUniquePositiveInts,
  buildPlaceholderRoomState,
  isFinalRoomIndex,
}, nextPocketState, roomIndex, encounterState) {
  return setPlaceholderRoomEntry(
    nextPocketState,
    roomIndex,
    {
      ...getPlaceholderRoomEntry(nextPocketState, roomIndex),
      hostileEntityIDs: cloneValue(encounterState && encounterState.hostileEntityIDs),
      objectiveComplete: encounterState && encounterState.objectiveComplete === true,
      objectiveCompletedAtMs: toInt(
        encounterState && encounterState.objectiveCompletedAtMs,
        nextPocketState.objectiveCompletedAtMs,
      ),
      encounterProfileID: normalizeText(encounterState && encounterState.encounterProfileID, ""),
      encounterName: normalizeText(encounterState && encounterState.encounterName, ""),
      encounterTheme: normalizeText(encounterState && encounterState.encounterTheme, ""),
      encounterFactionTheme: normalizeText(encounterState && encounterState.encounterFactionTheme, ""),
      encounterWeatherTheme: normalizeText(encounterState && encounterState.encounterWeatherTheme, ""),
      rewardProfileOverride: cloneValue(encounterState && encounterState.rewardProfileOverride),
      cacheProfileOverride: cloneValue(encounterState && encounterState.cacheProfileOverride),
      observedObjectEntries: cloneValue(encounterState && encounterState.observedObjectEntries) || [],
      sourceModelID: normalizeText(encounterState && encounterState.sourceModelID, ""),
      sourceVariantID: normalizeText(encounterState && encounterState.sourceVariantID, ""),
      sourceSpawnID: normalizeText(encounterState && encounterState.sourceSpawnID, ""),
      sourceSpawnFamily: normalizeText(encounterState && encounterState.sourceSpawnFamily, ""),
      sourceObservationCount: Math.max(
        0,
        toInt(encounterState && encounterState.sourceObservationCount, 0),
      ),
      sourceEvidenceAuthority: normalizeText(
        encounterState && encounterState.sourceEvidenceAuthority,
        "",
      ),
      encounterAuthority: cloneValue(
        encounterState && encounterState.encounterAuthority,
      ),
      resolvedNpcEntries: cloneValue(encounterState && encounterState.resolvedNpcEntries) || [],
      spawnedNpcItemIDs: listUniquePositiveInts(encounterState && encounterState.spawnedNpcItemIDs),
      plannedObjectiveNpcItemIDs: listUniquePositiveInts(encounterState && encounterState.plannedObjectiveNpcItemIDs),
      materializedObjectiveNpcItemIDs: listUniquePositiveInts(encounterState && encounterState.materializedObjectiveNpcItemIDs),
      objectiveRelevantNpcItemIDs: listUniquePositiveInts(encounterState && encounterState.objectiveRelevantNpcItemIDs),
      controllerDependantLifecycleGroups: Array.isArray(
        encounterState && encounterState.controllerDependantLifecycleGroups,
      )
        ? cloneValue(encounterState.controllerDependantLifecycleGroups)
        : [],
      dependantInactiveNpcItemIDs: listUniquePositiveInts(
        encounterState && encounterState.dependantInactiveNpcItemIDs,
      ),
      destroyedDependantNpcItemIDs: listUniquePositiveInts(
        encounterState && encounterState.destroyedDependantNpcItemIDs,
      ),
      destroyedObjectiveIDs: listUniquePositiveInts(encounterState && encounterState.destroyedObjectiveIDs),
      defeatedObjectiveItemIDs: listUniquePositiveInts(encounterState && encounterState.defeatedObjectiveItemIDs),
      objectiveTotal: toInt(encounterState && encounterState.objectiveTotal, 0),
      objectiveDefeatedCount: toInt(encounterState && encounterState.objectiveDefeatedCount, 0),
      encounterDroneCount: toInt(encounterState && encounterState.encounterDroneCount, 0),
      encounterShipCount: toInt(encounterState && encounterState.encounterShipCount, 0),
      encounterEscortTypeID: toInt(encounterState && encounterState.encounterEscortTypeID, 0),
      spawnRadiusMeters: toInt(encounterState && encounterState.spawnRadiusMeters, 0),
      spawnJitterMeters: toInt(encounterState && encounterState.spawnJitterMeters, 0),
      rewardMultiplier: Number(encounterState && encounterState.rewardMultiplier) || 0,
      rewardQuantityBonus: toInt(encounterState && encounterState.rewardQuantityBonus, 0),
    },
    {
      finalExitAvailable:
        buildPlaceholderRoomState(nextPocketState).finalExitAvailable === true ||
        (
          encounterState &&
          encounterState.objectiveComplete === true &&
          isFinalRoomIndex(nextPocketState, roomIndex)
        ),
    },
  );
}

function stageAbyssalRoomContentEncounter({
  setPlaceholderRoomEntry,
  buildRoomShipSpawnState,
  buildPocketStateForCurrentRoom,
  getObjectPosition,
  listPocketHostileEntityIDs,
  buildEncounterStateFromRoomEntry,
  getPlaceholderRoomEntry,
  cloneValue,
  buildPlaceholderEncounterState,
  listUniquePositiveInts,
  buildPlaceholderTimerState,
  buildAbyssalMaterializedEncounterRoomState,
  getNpcRuntimePolicy,
  registerPocket,
  isAbyssalPocketMutationBatchActive,
  suppressAbyssalRoomRewards,
  log,
  schedulePlaceholderPocketMaintenance,
}, basePocketState, existingPocketState, roomIndex, currentRoomEntry, originPosition, conduitLabel, originResult, exitResult, session, deps, isPrewarmPreparation, recordContentPhase) {
  let roomState = setPlaceholderRoomEntry(
    basePocketState,
    roomIndex,
    {
      ...currentRoomEntry,
      roomOriginPosition: originPosition,
      shipSpawnState: buildRoomShipSpawnState(basePocketState, roomIndex),
      originMarkerItemID: originResult.success
        ? toInt(originResult.itemID, 0)
        : toInt(currentRoomEntry.originMarkerItemID, 0),
      conduitItemID: exitResult.success
        ? toInt(exitResult.itemID, 0)
        : toInt(currentRoomEntry.conduitItemID, 0),
      conduitLabel,
      enteredAtMs: toInt(currentRoomEntry.enteredAtMs, 0) > 0
        ? toInt(currentRoomEntry.enteredAtMs, 0)
        : Math.max(1, toInt(deps.now(), Date.now())),
    },
  );
  let nextPocketState = buildPocketStateForCurrentRoom(
    {
      ...(existingPocketState || basePocketState),
      roomOneOriginPosition: getObjectPosition(basePocketState.roomOneOriginPosition) ||
        getObjectPosition(basePocketState.pocketPosition),
    },
    roomState,
  );
  const shouldReuseEncounterState = Boolean(
    existingPocketState &&
      existingPocketState.encounterState &&
      (
        nextPocketState.objectiveComplete === true ||
        listPocketHostileEntityIDs(nextPocketState).length > 0 ||
        existingPocketState.encounterState.encounterSpawnFailed === true
      ),
  );
  const stagedEncounterState = buildEncounterStateFromRoomEntry(
    getPlaceholderRoomEntry(nextPocketState, roomIndex),
  );
  const encounterState = shouldReuseEncounterState
    ? cloneValue(existingPocketState.encounterState)
    : stagedEncounterState || (
      nextPocketState.objectiveComplete === true
        ? cloneValue(existingPocketState && existingPocketState.encounterState) || {
          hostileEntityIDs: [],
          objectiveComplete: true,
          objectiveCompletedAtMs: toInt(nextPocketState.objectiveCompletedAtMs, 0),
        }
        : buildPlaceholderEncounterState(nextPocketState, session, deps, {
          prewarm: isPrewarmPreparation,
        })
    );
  recordContentPhase("encounter-state-materialization", {
    npcCount: listUniquePositiveInts(encounterState && encounterState.hostileEntityIDs).length,
    family: normalizeText(encounterState && encounterState.sourceSpawnFamily, "unknown"),
    reused: shouldReuseEncounterState,
  });
  const timerState =
    existingPocketState && existingPocketState.timerState
      ? cloneValue(existingPocketState.timerState)
      : buildPlaceholderTimerState(nextPocketState, deps);
  roomState = buildAbyssalMaterializedEncounterRoomState(nextPocketState, roomIndex, encounterState);
  nextPocketState = {
    ...buildPocketStateForCurrentRoom(nextPocketState, roomState),
    allowDebugExit:
      (existingPocketState && existingPocketState.allowDebugExit === true) ||
      (encounterState && encounterState.allowDebugExit === true),
    encounterState: cloneValue(encounterState),
    timerState: cloneValue(timerState),
    timerFailureState: existingPocketState
      ? existingPocketState.timerFailureState ?? null
      : null,
  };
  nextPocketState.npcRuntimePolicy = cloneValue(
    existingPocketState && existingPocketState.npcRuntimePolicy,
  ) || getNpcRuntimePolicy(nextPocketState);
  nextPocketState.runOutcome = normalizeText(
    existingPocketState && existingPocketState.runOutcome,
    "",
  );
  nextPocketState.runOutcomeAtMs = toInt(
    existingPocketState && existingPocketState.runOutcomeAtMs,
    0,
  );
  nextPocketState.runOutcomeDetails = cloneValue(
    existingPocketState && existingPocketState.runOutcomeDetails,
  ) || null;
  registerPocket(nextPocketState);
  recordContentPhase("room-state-staged", {
    persistenceMode: isAbyssalPocketMutationBatchActive(nextPocketState.instanceID)
      ? "batched"
      : "immediate",
  });
  if (normalizeText(encounterState && encounterState.spawnMode, "") === "degraded") {
    nextPocketState = suppressAbyssalRoomRewards(
      nextPocketState,
      roomIndex,
      deps,
      "ROOM_ENCOUNTER_DEGRADED",
    );
  }
  if (!(existingPocketState && existingPocketState.timerState)) {
    log.info(
      `[AbyssalMgr] Abyssal timer started char=${nextPocketState.characterID} ` +
        `instance=${nextPocketState.instanceID} durationMs=${timerState.durationMs} ` +
        `expiresAtMs=${timerState.expiresAtMs}`,
    );
  }
  schedulePlaceholderPocketMaintenance(deps);
  return nextPocketState;
}

function materializeAbyssalRoomEnvironment({
  ensurePlaceholderExtractionNodes,
  getAbyssalSceneryProfileForRoomIndex,
  isAuthoritativeAbyssalSceneryProfile,
  usesIsolatedAbyssalScene,
  ensureAbyssalSceneryVisuals,
  ensureAbyssalEnvironmentalObjects,
}, nextPocketState, clientSyncSession, session, roomIndex, deps, options, recordContentPhase, spawnErrors) {
  const extractionNodeResult = ensurePlaceholderExtractionNodes(nextPocketState, clientSyncSession, deps, {
    roomIndex,
    broadcast: options.suppressPrewarmClientDelivery !== true,
  });
  recordContentPhase("extraction-materialization");
  const extractionNodePocketState =
    extractionNodeResult && extractionNodeResult.data
      ? extractionNodeResult.data
      : nextPocketState;
  const sceneryProfile = getAbyssalSceneryProfileForRoomIndex(
    extractionNodePocketState,
    roomIndex,
  );
  const suppressAuthoritativeSceneryBroadcast = Boolean(
    isAuthoritativeAbyssalSceneryProfile(sceneryProfile) &&
    usesIsolatedAbyssalScene(extractionNodePocketState, deps) &&
    session &&
    session._space &&
    session._space.initialStateSent !== true,
  );
  const sceneryResult = ensureAbyssalSceneryVisuals(
    extractionNodePocketState,
    clientSyncSession,
    deps,
    {
      broadcast:
        options.suppressPrewarmClientDelivery !== true &&
        !suppressAuthoritativeSceneryBroadcast,
    },
  );
  recordContentPhase("scenery-materialization");
  const sceneryPocketState =
    sceneryResult && sceneryResult.data
      ? sceneryResult.data
      : extractionNodePocketState;
  const environmentalResult = ensureAbyssalEnvironmentalObjects(
    sceneryPocketState,
    clientSyncSession,
    deps,
    {
      roomIndex,
      broadcast: options.suppressPrewarmClientDelivery !== true,
    },
  );
  recordContentPhase("environment-materialization");
  if (
    !environmentalResult ||
    environmentalResult.success !== true ||
    environmentalResult.partial === true
  ) {
    spawnErrors.push(
      `environment:${normalizeText(
        environmentalResult && environmentalResult.errorMsg,
        "ABYSSAL_ENVIRONMENT_MATERIALIZATION_INCOMPLETE",
      )}`,
    );
  }
  const environmentalPocketState =
    environmentalResult && environmentalResult.data
      ? environmentalResult.data
      : sceneryPocketState;
  return { environmentalPocketState, extractionNodeResult, sceneryResult, environmentalResult };
}

function finishAbyssalRoomContentMaterialization({
  getContentProfile,
  isSupportedAbyssalContentTier,
  hasTerminalFailureOutcome,
  ensurePlaceholderRewardCache,
  maybeSendAbyssalRoomOneClientFx,
  buildRoomLogContext,
  log,
  logAbyssalRoomContentPrepared,
  getPlaceholderRoomEntry,
  cloneValue,
}, materialization, clientSyncSession, session, deps, roomIndex, options, isPrewarmPreparation, spawnErrors, suppressClientEntryFx, suppressRoomEnteredLog) {
  const { environmentalPocketState, extractionNodeResult, sceneryResult, environmentalResult } = materialization;
  const sceneryContentProfile = getContentProfile(environmentalPocketState);
  const shouldSpawnRewardCacheWithRoom =
    environmentalResult && environmentalResult.success === true &&
    (
      isSupportedAbyssalContentTier(sceneryContentProfile) &&
      options.suppressEarlyRewardCache !== true
    ) ||
    environmentalPocketState.objectiveComplete === true;
  if (shouldSpawnRewardCacheWithRoom && !hasTerminalFailureOutcome(environmentalPocketState)) {
    const rewardResult = ensurePlaceholderRewardCache(environmentalPocketState, clientSyncSession, deps, {
      allowRepairMissing: options.allowRewardCacheRepair === true,
      allowBeforeObjective: isSupportedAbyssalContentTier(sceneryContentProfile),
      broadcast: options.suppressPrewarmClientDelivery !== true,
      roomIndex,
    });
    if (rewardResult && rewardResult.success && rewardResult.data) {
      const fxResult = suppressClientEntryFx
        ? { pocketState: rewardResult.data }
        : maybeSendAbyssalRoomOneClientFx(
          rewardResult.data,
          session,
          deps,
        );
      const effectivePocketState = fxResult.pocketState || rewardResult.data;
      if (!suppressRoomEnteredLog) {
        const roomLogContext = buildRoomLogContext(effectivePocketState, deps);
        log.info(
          `[AbyssalMgr] Room entered char=${roomLogContext.characterID} ship=${roomLogContext.shipID} ` +
            `filament=${roomLogContext.filamentTypeID} name="${roomLogContext.filamentName}" ` +
            `tier=${roomLogContext.tier} weather=${roomLogContext.weather} ` +
            `room=${roomLogContext.roomIndex}/${roomLogContext.totalRooms} roomOrigin=${roomLogContext.roomOrigin} ` +
            `finalShip=${roomLogContext.finalShip} hostileCount=${roomLogContext.hostileCount} ` +
            `cacheID=${roomLogContext.cacheID} conduitID=${roomLogContext.conduitID} ` +
            `timerRemainingMs=${roomLogContext.timerRemainingMs}`,
        );
      }
      if (
        options.suppressEarlyRewardCache !== true ||
        effectivePocketState.objectiveComplete === true
      ) {
        logAbyssalRoomContentPrepared(effectivePocketState, {
          roomIndex,
          active: !isPrewarmPreparation,
          prewarmed: isPrewarmPreparation ||
            toInt(getPlaceholderRoomEntry(effectivePocketState, roomIndex).prewarmedAtMs, 0) > 0,
        });
      }
      return {
        success: spawnErrors.length === 0,
        partial: spawnErrors.length > 0,
        errors: spawnErrors,
        data: cloneValue(effectivePocketState),
        materializationResults: {
          extractionNodeResult,
          sceneryResult,
          environmentalResult,
          rewardResult,
        },
      };
    }
  }

  const fxResult = suppressClientEntryFx
    ? { pocketState: environmentalPocketState }
    : maybeSendAbyssalRoomOneClientFx(
      environmentalPocketState,
      session,
      deps,
    );
  const effectivePocketState = fxResult.pocketState || environmentalPocketState;
  if (!suppressRoomEnteredLog) {
    const roomLogContext = buildRoomLogContext(effectivePocketState, deps);
    log.info(
      `[AbyssalMgr] Room entered char=${roomLogContext.characterID} ship=${roomLogContext.shipID} ` +
        `filament=${roomLogContext.filamentTypeID} name="${roomLogContext.filamentName}" ` +
        `tier=${roomLogContext.tier} weather=${roomLogContext.weather} ` +
        `room=${roomLogContext.roomIndex}/${roomLogContext.totalRooms} roomOrigin=${roomLogContext.roomOrigin} ` +
        `finalShip=${roomLogContext.finalShip} hostileCount=${roomLogContext.hostileCount} ` +
        `cacheID=${roomLogContext.cacheID} conduitID=${roomLogContext.conduitID} ` +
        `timerRemainingMs=${roomLogContext.timerRemainingMs}`,
    );
  }
  if (
    options.suppressEarlyRewardCache !== true ||
    effectivePocketState.objectiveComplete === true
  ) {
    logAbyssalRoomContentPrepared(effectivePocketState, {
      roomIndex,
      active: !isPrewarmPreparation,
      prewarmed: isPrewarmPreparation ||
        toInt(getPlaceholderRoomEntry(effectivePocketState, roomIndex).prewarmedAtMs, 0) > 0,
    });
  }
  return {
    success: spawnErrors.length === 0,
    partial: spawnErrors.length > 0,
    errors: spawnErrors,
    data: cloneValue(effectivePocketState),
    materializationResults: {
      extractionNodeResult,
      sceneryResult,
      environmentalResult,
    },
  };
}

function spawnPlaceholderPocketContent({
  getDependencies,
  cloneValue,
  runPlaceholderPocketMaintenance,
  getActivePocketStateByInstanceID,
  buildPocketStateForCurrentRoom,
  buildPlaceholderRoomState,
  log,
  getPlaceholderRoomEntry,
  getObjectPosition,
  resolveRoomOriginPosition,
  buildRoomConduitState,
  isFinalRoomIndex,
  getFinalExitConduitLabel,
  getTransferConduitLabel,
  validateAbyssalRoomContentProfiles,
  prepareAbyssalRoomContentState,
  createAbyssalRoomContentMarkers,
  stageAbyssalRoomContentEncounter,
  materializeAbyssalRoomEnvironment,
  finishAbyssalRoomContentMaterialization,
},
  validation,
  pocketState,
  session,
  deps = getDependencies(),
  options = {},
) {
  const contentPerfEnabled = deps && deps.abyssalTransitionPerfDiagnosticsEnabled === true;
  const contentStartedAtNs = process.hrtime.bigint();
  let contentLastPhaseAtNs = contentStartedAtNs;
  const suppressClientEntryFx = options.suppressClientEntryFx === true;
  const suppressRoomEnteredLog = options.suppressRoomEnteredLog === true;
  const prepareOnly = options.prepareOnly === true;
  const clientSyncSession = options.suppressPrewarmClientDelivery === true
    ? null
    : session;
  const isPrewarmPreparation = suppressClientEntryFx &&
    suppressRoomEnteredLog &&
    options.suppressEarlyRewardCache === true;
  const existingPocketStateOverride =
    options.existingPocketStateOverride &&
    typeof options.existingPocketStateOverride === "object"
      ? cloneValue(options.existingPocketStateOverride)
      : null;
  runPlaceholderPocketMaintenance(null, deps);
  const existingPocketState =
    existingPocketStateOverride ||
    getActivePocketStateByInstanceID(pocketState.instanceID);
  const basePocketState = buildPocketStateForCurrentRoom(existingPocketState || pocketState);
  let roomState = buildPlaceholderRoomState(basePocketState);
  const roomIndex = roomState.currentRoomIndex;
  const recordContentPhase = (phase, details = {}) => {
    if (!contentPerfEnabled) return;
    const nowNs = process.hrtime.bigint();
    const detailText = Object.entries(details)
      .map(([key, value]) => `${key}=${String(value)}`)
      .join(" ");
    log.info(
      `[AbyssalTransitionPerf] run=${toInt(basePocketState && basePocketState.instanceID, 0)} ` +
        `flow=room-materialization room=${roomIndex} phase=${phase} ` +
        `phaseMs=${(Number(nowNs - contentLastPhaseAtNs) / 1_000_000).toFixed(3)} ` +
        `totalMs=${(Number(nowNs - contentStartedAtNs) / 1_000_000).toFixed(3)} ` +
        detailText,
    );
    contentLastPhaseAtNs = nowNs;
  };
  const currentRoomEntry = getPlaceholderRoomEntry(basePocketState, roomIndex);
  const originPosition = getObjectPosition(currentRoomEntry.roomOriginPosition) ||
    resolveRoomOriginPosition(basePocketState, roomIndex);
  const conduitState = buildRoomConduitState(basePocketState, roomIndex);
  const isFinalRoom = isFinalRoomIndex(basePocketState, roomIndex);
  const conduitLabel = isFinalRoomIndex(basePocketState, roomIndex)
    ? getFinalExitConduitLabel(basePocketState)
    : getTransferConduitLabel(basePocketState);
  const profileFailure = validateAbyssalRoomContentProfiles(basePocketState, roomIndex, roomState);
  if (profileFailure) return profileFailure;
  if (prepareOnly) {
    return prepareAbyssalRoomContentState(
      basePocketState, existingPocketState, roomState, roomIndex, currentRoomEntry,
      originPosition, conduitLabel, deps,
    );
  }
  const { originResult, exitResult } = createAbyssalRoomContentMarkers(
    basePocketState, roomIndex, currentRoomEntry, conduitState, conduitLabel,
    originPosition, isFinalRoom, isPrewarmPreparation, clientSyncSession, deps,
  );
  recordContentPhase("scene-object-creation", {
    markerCount: (originResult.success && toInt(originResult.itemID, 0) > 0 ? 1 : 0) +
      (exitResult.success && toInt(exitResult.itemID, 0) > 0 ? 1 : 0),
  });

  const spawnErrors = [];
  if (!originResult.success) {
    spawnErrors.push(`origin:${originResult.errorMsg}`);
  }
  if (!exitResult.success) {
    spawnErrors.push(`exit:${exitResult.errorMsg}`);
  }

  const nextPocketState = stageAbyssalRoomContentEncounter(
    basePocketState, existingPocketState, roomIndex, currentRoomEntry, originPosition,
    conduitLabel, originResult, exitResult, session, deps, isPrewarmPreparation, recordContentPhase,
  );
  const materialization = materializeAbyssalRoomEnvironment(
    nextPocketState, clientSyncSession, session, roomIndex, deps, options, recordContentPhase, spawnErrors,
  );
  return finishAbyssalRoomContentMaterialization(
    materialization, clientSyncSession, session, deps, roomIndex, options,
    isPrewarmPreparation, spawnErrors, suppressClientEntryFx, suppressRoomEnteredLog,
  );
}

// Capture supplied capabilities once, as the original closure did. Internal
// callbacks are bound once per instance; no runtime state lives in this wiring.
function createAbyssalRoomMaterialization({
  getDependencies,
  cloneValue,
  runPlaceholderPocketMaintenance,
  getActivePocketStateByInstanceID,
  buildPocketStateForCurrentRoom,
  buildPlaceholderRoomState,
  log,
  getPlaceholderRoomEntry,
  getObjectPosition,
  resolveRoomOriginPosition,
  buildRoomConduitState,
  isFinalRoomIndex,
  getFinalExitConduitLabel,
  getTransferConduitLabel,
  resolveRoomEncounterProfile,
  resolveRoomRewardProfile,
  setPlaceholderRoomEntry,
  buildRoomShipSpawnState,
  buildEncounterStateFromRoomEntry,
  buildPlaceholderTimerState,
  getNpcRuntimePolicy,
  registerPocket,
  schedulePlaceholderPocketMaintenance,
  destroyPlaceholderTrace,
  buildAbyssalSceneDescriptor,
  ensurePocketMarker,
  TYPE_ABYSSAL_ORIGIN_CONDUIT,
  TYPE_ABYSSAL_TRANSFER_CONDUIT,
  listPocketHostileEntityIDs,
  buildPlaceholderEncounterState,
  listUniquePositiveInts,
  isAbyssalPocketMutationBatchActive,
  suppressAbyssalRoomRewards,
  ensurePlaceholderExtractionNodes,
  getAbyssalSceneryProfileForRoomIndex,
  isAuthoritativeAbyssalSceneryProfile,
  usesIsolatedAbyssalScene,
  ensureAbyssalSceneryVisuals,
  ensureAbyssalEnvironmentalObjects,
  getContentProfile,
  isSupportedAbyssalContentTier,
  hasTerminalFailureOutcome,
  ensurePlaceholderRewardCache,
  maybeSendAbyssalRoomOneClientFx,
  buildRoomLogContext,
  logAbyssalRoomContentPrepared,
}) {

  const ports = {
    getDependencies,
    cloneValue,
    runPlaceholderPocketMaintenance,
    getActivePocketStateByInstanceID,
    buildPocketStateForCurrentRoom,
    buildPlaceholderRoomState,
    log,
    getPlaceholderRoomEntry,
    getObjectPosition,
    resolveRoomOriginPosition,
    buildRoomConduitState,
    isFinalRoomIndex,
    getFinalExitConduitLabel,
    getTransferConduitLabel,
    resolveRoomEncounterProfile,
    resolveRoomRewardProfile,
    setPlaceholderRoomEntry,
    buildRoomShipSpawnState,
    buildEncounterStateFromRoomEntry,
    buildPlaceholderTimerState,
    getNpcRuntimePolicy,
    registerPocket,
    schedulePlaceholderPocketMaintenance,
    destroyPlaceholderTrace,
    buildAbyssalSceneDescriptor,
    ensurePocketMarker,
    TYPE_ABYSSAL_ORIGIN_CONDUIT,
    TYPE_ABYSSAL_TRANSFER_CONDUIT,
    listPocketHostileEntityIDs,
    buildPlaceholderEncounterState,
    listUniquePositiveInts,
    isAbyssalPocketMutationBatchActive,
    suppressAbyssalRoomRewards,
    ensurePlaceholderExtractionNodes,
    getAbyssalSceneryProfileForRoomIndex,
    isAuthoritativeAbyssalSceneryProfile,
    usesIsolatedAbyssalScene,
    ensureAbyssalSceneryVisuals,
    ensureAbyssalEnvironmentalObjects,
    getContentProfile,
    isSupportedAbyssalContentTier,
    hasTerminalFailureOutcome,
    ensurePlaceholderRewardCache,
    maybeSendAbyssalRoomOneClientFx,
    buildRoomLogContext,
    logAbyssalRoomContentPrepared,
  };
  ports.validateAbyssalRoomContentProfiles = validateAbyssalRoomContentProfiles.bind(null, ports);
  ports.prepareAbyssalRoomContentState = prepareAbyssalRoomContentState.bind(null, ports);
  ports.createAbyssalRoomContentMarkers = createAbyssalRoomContentMarkers.bind(null, ports);
  ports.buildAbyssalMaterializedEncounterRoomState = buildAbyssalMaterializedEncounterRoomState.bind(null, ports);
  ports.stageAbyssalRoomContentEncounter = stageAbyssalRoomContentEncounter.bind(null, ports);
  ports.materializeAbyssalRoomEnvironment = materializeAbyssalRoomEnvironment.bind(null, ports);
  ports.finishAbyssalRoomContentMaterialization = finishAbyssalRoomContentMaterialization.bind(null, ports);
  ports.spawnPlaceholderPocketContent = spawnPlaceholderPocketContent.bind(null, ports);
  Object.freeze(ports);
  return Object.freeze({ spawnPlaceholderPocketContent: ports.spawnPlaceholderPocketContent });
}

module.exports = Object.freeze({ createAbyssalRoomMaterialization });
