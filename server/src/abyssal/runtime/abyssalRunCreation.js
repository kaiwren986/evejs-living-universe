"use strict";

const { normalizeText } = require("../domain/abyssalValueUtils");

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

// The work record is invocation-local; allocation and durable state stay authoritative.
function createOrResolvePlaceholderPocket(ports, validation, deps = ports.getDependencies()) {
  const work = { validation, deps };
  for (const prepare of [resolveExistingRun, prepareRunContent, allocateRunScene, prepareInitialRoom]) {
    const resolved = prepare(ports, work);
    if (resolved) return resolved;
  }
  work.createdInstance = null;
  try {
    work.createdInstance = deps.dungeonRuntime.createInstance(buildNewRunDefinition(ports, work));
    validateCreatedRunIdentity(ports, work);
    return registerCreatedRun(ports, work);
  } catch (error) {
    return rollbackCreatedRun(ports, { ...work, error });
  }
}

function resolveExistingRun(ports, work) {
  const {
    getRunByTraceID,
    cloneValue,
    buildPocketSiteKey,
    buildPocketStateFromInstance,
    registerPocket,
    logRecoveredT0DarkLayoutSelection,
    logRecoveredAbyssalBaseRoomLayoutSelection,
    logRecoveredAbyssalSceneMode,
  } = ports;
  const {
    validation,
    deps,
  } = work;
  const traceState = validation.data.traceState;
  const cachedPocketState = getRunByTraceID(
    traceState.traceItemID,
  );
  if (cachedPocketState) {
    return {
      success: true,
      created: false,
      data: cloneValue(cachedPocketState),
    };
  }
  const siteKey = buildPocketSiteKey(traceState);
  const existingInstance = deps.dungeonRuntime.findInstanceBySiteKey(siteKey, {
    activeOnly: true,
    full: true,
  });
  if (existingInstance) {
    const resolvedPocketState = buildPocketStateFromInstance(existingInstance, traceState);
    const registeredPocketState = registerPocket(resolvedPocketState);
    if (!registeredPocketState) {
      return {
        success: false,
        errorMsg: "ABYSSAL_SPATIAL_RESERVATION_FAILED",
      };
    }
    logRecoveredT0DarkLayoutSelection(registeredPocketState);
    logRecoveredAbyssalBaseRoomLayoutSelection(registeredPocketState);
    logRecoveredAbyssalSceneMode(registeredPocketState, deps);
    return {
      success: true,
      created: false,
      data: cloneValue(registeredPocketState),
    };
  }
  Object.assign(work, { traceState, siteKey });
  return null;
}

function prepareRunContent(ports, work) {
  const {
    cloneValue,
    buildSourceTransitionState,
    resolveAbyssalTemplateID,
    getContentProfile,
    selectAbyssalEnvironmentLayoutVariant,
    randomUUID,
    buildNewT0DarkLayoutSelection,
    selectAbyssalBaseRoomLayouts,
  } = ports;
  const {
    validation,
    deps,
    traceState,
  } = work;
  const sourceTransitionState = buildSourceTransitionState(validation);
  const templateID = resolveAbyssalTemplateID(traceState);
  const sourceContentProfile = getContentProfile(traceState) || {};
  const candidateRunID = deps.dungeonRuntime && typeof deps.dungeonRuntime.peekNextInstanceID === "function"
    ? toInt(deps.dungeonRuntime.peekNextInstanceID(), traceState.traceItemID)
    : toInt(traceState.traceItemID, 0);
  const environmentLayoutVariant = normalizeText(
    sourceContentProfile.environmentLayoutVariant,
    selectAbyssalEnvironmentLayoutVariant({
      tier: sourceContentProfile.tier,
      weatherType: sourceContentProfile.weatherType,
      selectionSeed: candidateRunID,
    }),
  );
  const contentProfile = {
    ...cloneValue(sourceContentProfile),
    ...(environmentLayoutVariant ? { environmentLayoutVariant } : {}),
  };
  const contentID = randomUUID();
  const layoutSelectionResult = buildNewT0DarkLayoutSelection(validation, candidateRunID);
  if (!layoutSelectionResult || layoutSelectionResult.success !== true) {
    return {
      success: false,
      errorMsg: normalizeText(
        layoutSelectionResult && layoutSelectionResult.errorMsg,
        "ABYSSAL_LAYOUT_SELECTION_FAILED",
      ),
    };
  }
  const layoutSelectionState = layoutSelectionResult.data && layoutSelectionResult.data.selectionState || null;
  const baseRoomLayoutSelectionResult = selectAbyssalBaseRoomLayouts({
    runID: candidateRunID,
    filamentTypeID: contentProfile.filamentTypeID,
    tier: contentProfile.tier,
    weatherType: contentProfile.weatherType,
  });
  if (
    !baseRoomLayoutSelectionResult ||
    baseRoomLayoutSelectionResult.success !== true ||
    !baseRoomLayoutSelectionResult.data ||
    !baseRoomLayoutSelectionResult.data.selectionState
  ) {
    return {
      success: false,
      errorMsg: "ABYSSAL_BASE_ROOM_LAYOUT_SELECTION_FAILED",
    };
  }
  const baseRoomLayoutSelectionState =
    baseRoomLayoutSelectionResult.data.selectionState;
  Object.assign(work, { sourceTransitionState, templateID, candidateRunID, contentProfile, contentID, layoutSelectionState, baseRoomLayoutSelectionState });
  return null;
}

function allocateRunScene(ports, work) {
  const {
    resolveAbyssalSceneModeState,
    ABYSSAL_SCENE_MODE_ISOLATED,
    log,
    allocateAbyssalSpatialReservation,
    formatVectorForLog,
  } = ports;
  const {
    validation,
    deps,
    traceState,
    candidateRunID,
  } = work;
  const runtime = deps;
  const configuredSceneModeState = resolveAbyssalSceneModeState(null, deps);
  if (configuredSceneModeState.sceneMode === ABYSSAL_SCENE_MODE_ISOLATED) {
    let runtimeContractError = "";
    if (!runtime) {
      runtimeContractError = "ABYSSAL_ISOLATED_SCENE_RUNTIME_MISSING";
    } else if (typeof runtime.normalizeSceneDescriptor !== "function") {
      runtimeContractError = "ABYSSAL_ISOLATED_SCENE_DESCRIPTOR_UNSUPPORTED";
    } else if (typeof runtime.buildAbyssalSceneKey !== "function") {
      runtimeContractError = "ABYSSAL_ISOLATED_SCENE_KEY_UNSUPPORTED";
    } else if (typeof runtime.allocateAbyssalLocationID !== "function") {
      runtimeContractError = "ABYSSAL_ISOLATED_SCENE_LOCATION_ALLOCATOR_UNSUPPORTED";
    }
    if (runtimeContractError) {
      log.warn(
        `[AbyssalScene] isolated entry failed char=${validation.data.context.characterID} ` +
          `trace=${traceState.traceItemID} instance=${candidateRunID} ` +
          `reason=${runtimeContractError}`,
      );
      return {
        success: false,
        errorMsg: runtimeContractError,
      };
    }
  }
  const configuredSceneKey = configuredSceneModeState.sceneMode === ABYSSAL_SCENE_MODE_ISOLATED
    ? (
        runtime && typeof runtime.buildAbyssalSceneKey === "function"
          ? runtime.buildAbyssalSceneKey(candidateRunID)
          : `abyssal-run:${candidateRunID}`
      )
    : "";
  const spatialReservationResult =
    configuredSceneModeState.sceneMode === ABYSSAL_SCENE_MODE_ISOLATED
      ? allocateAbyssalSpatialReservation(candidateRunID, runtime)
      : null;
  const spatialReservation =
    spatialReservationResult && spatialReservationResult.success === true
      ? spatialReservationResult.reservation
      : null;
  const abyssalLocationID = toInt(
    spatialReservation && spatialReservation.hostSystemID,
    0,
  );
  if (
    configuredSceneModeState.sceneMode === ABYSSAL_SCENE_MODE_ISOLATED &&
    (!spatialReservationResult || spatialReservationResult.success !== true)
  ) {
    return {
      success: false,
      errorMsg: normalizeText(
        spatialReservationResult && spatialReservationResult.errorMsg,
        "ABYSSAL_SPATIAL_RESERVATION_FAILED",
      ),
    };
  }
  if (spatialReservation) {
    log.info(
      `[AbyssalSpatialReservation] run=${candidateRunID} ` +
        `host=${spatialReservation.hostSystemID} slot=${spatialReservation.slotID} ` +
        `origin=${formatVectorForLog(spatialReservation.spatialOrigin)} ` +
        `scene=${spatialReservation.sceneID} reason=fresh-entry state=allocated`,
    );
  }
  Object.assign(work, { configuredSceneModeState, configuredSceneKey, spatialReservation, abyssalLocationID });
  return null;
}

function prepareInitialRoom(ports, work) {
  const {
    cloneValue,
    buildPlaceholderPocketPosition,
    buildPlaceholderShipSpaceState,
    buildPlaceholderRoomState,
    upsertAbyssalParticipantRosterEntry,
    ABYSSAL_PARTICIPANT_STATUS,
    normalizeAbyssalParticipantRoster,
    getNpcRuntimePolicy,
  } = ports;
  const {
    validation,
    deps,
    traceState,
    spatialReservation,
    contentProfile,
    layoutSelectionState,
    baseRoomLayoutSelectionState,
  } = work;
  const pocketPosition = spatialReservation
    ? cloneValue(spatialReservation.spatialOrigin)
    : buildPlaceholderPocketPosition(validation);
  const shipSpawnState = buildPlaceholderShipSpaceState(validation, pocketPosition);
  const roomState = buildPlaceholderRoomState({
    contentProfile,
    ...cloneValue(layoutSelectionState),
    ...cloneValue(baseRoomLayoutSelectionState),
    solarSystemID: validation.data.context.systemID,
    pocketPosition,
    roomOneOriginPosition: pocketPosition,
    shipSpawnState,
  });
  const initialParticipantRoster = validation.data.participantAdmission
    ? upsertAbyssalParticipantRosterEntry(traceState, {
        ...cloneValue(validation.data.participantAdmission),
        status: ABYSSAL_PARTICIPANT_STATUS.ADMITTING,
      })
    : normalizeAbyssalParticipantRoster(traceState);
  const npcRuntimePolicy = getNpcRuntimePolicy(contentProfile);
  Object.assign(work, { pocketPosition, shipSpawnState, roomState, initialParticipantRoster, npcRuntimePolicy });
  return null;
}

function buildNewRunDefinition(ports, work) {
  const {
    templateID,
    validation,
    pocketPosition,
    siteKey,
    traceState,
  } = work;
  return {
      templateID,
      solarSystemID: validation.data.context.systemID,
      position: pocketPosition,
      lifecycleState: "active",
      siteKey,
      siteFamily: "abyssal",
      siteKind: "abyssal-pocket",
      siteOrigin: "abyssalMgr",
      instanceScope: "private",
      ownership: {
        visibilityScope: "private",
        characterID: traceState.characterID,
      },
      metadata: buildNewRunMetadata(ports, work),
      runtimeFlags: {
        abyssalPlaceholder: true,
      },
    };
}

function buildNewRunMetadata(ports, work) {
  const {
    cloneValue,
    ABYSSAL_PARTICIPANT_ROSTER_SCHEMA_VERSION,
    listUniquePositiveInts,
    buildPersistedAbyssalContentProfile,
    buildAbyssalWeatherState,
    PLACEHOLDER_POCKET_MODE,
    PLACEHOLDER_POCKET_ISOLATION,
  } = ports;
  const {
    sourceTransitionState,
    traceState,
    validation,
    contentProfile,
    initialParticipantRoster,
    abyssalLocationID,
    spatialReservation,
    contentID,
    layoutSelectionState,
    baseRoomLayoutSelectionState,
    candidateRunID,
    deps,
    pocketPosition,
    shipSpawnState,
    roomState,
    npcRuntimePolicy,
    configuredSceneModeState,
    configuredSceneKey,
  } = work;
  return {
        sourceTraceItemID: sourceTransitionState.sourceTraceItemID,
        characterID: traceState.characterID,
        shipID: validation.data.context.shipID,
        shipClass: normalizeText(traceState.shipClass, normalizeText(contentProfile && contentProfile.hullMode, "")),
        requiredFilaments: Math.max(
          1,
          toInt(traceState.requiredFilaments, toInt(contentProfile && contentProfile.requiredFilaments, 1)),
        ),
        maxShips: Math.max(
          1,
          toInt(traceState.maxShips, toInt(contentProfile && contentProfile.maxShips, 1)),
        ),
        fleetID: toInt(traceState.fleetID, 0),
        participantRosterSchemaVersion: ABYSSAL_PARTICIPANT_ROSTER_SCHEMA_VERSION,
        participantRoster: initialParticipantRoster,
        eligibleParticipantCharacterIDs: listUniquePositiveInts(
          traceState.eligibleParticipantCharacterIDs,
        ),
        rewardBeneficiaryCharacterID: toInt(
          traceState.rewardBeneficiaryCharacterID,
          traceState.characterID,
        ),
        sourceSolarSystemID: sourceTransitionState.sourceSolarSystemID,
        sourceLocationID: sourceTransitionState.sourceLocationID,
        abyssalLocationID,
        abyssalSlotID: spatialReservation ? spatialReservation.slotID : undefined,
        abyssalSpatialOrigin: spatialReservation
          ? cloneValue(spatialReservation.spatialOrigin)
          : undefined,
        abyssalSpatialReservation: spatialReservation
          ? cloneValue(spatialReservation)
          : undefined,
        sourceTracePosition: sourceTransitionState.sourceTracePosition,
        sourceShipPosition: sourceTransitionState.sourceShipPosition,
        sourceShipDirection: sourceTransitionState.sourceShipDirection,
        sourceBallID: sourceTransitionState.sourceBallID,
        sourceBubbleID: sourceTransitionState.sourceBubbleID,
        sourcePublicGridClusterKey: sourceTransitionState.sourcePublicGridClusterKey,
        sourceSceneKey: sourceTransitionState.sourceSceneKey,
        sourceShipRadius: sourceTransitionState.sourceShipRadius,
        traceProfileID: sourceTransitionState.traceProfileID,
        filamentTypeID: traceState.filamentTypeID,
        filamentName: normalizeText(traceState.filamentName, ""),
        securityPolicy: cloneValue(traceState.securityPolicy),
        suspectOnReturn: traceState.suspectOnReturn === true,
        suspectReturnState: cloneValue(traceState.suspectReturnState),
        contentID,
        contentProfile: buildPersistedAbyssalContentProfile(contentProfile),
        ...cloneValue(layoutSelectionState),
        ...cloneValue(baseRoomLayoutSelectionState),
        weatherState: buildAbyssalWeatherState(contentProfile, {
          traceItemID: traceState.traceItemID,
          runID: candidateRunID,
          selectionSeed: traceState.traceItemID,
        }),
        activatedAtMs: deps.now(),
        pocketPosition,
        roomOneOriginPosition: pocketPosition,
        shipSpawnState,
        roomState,
        npcRuntimePolicy,
        siteID: traceState.traceItemID,
        label: "Abyssal Pocket (Placeholder)",
        placeholderMode: PLACEHOLDER_POCKET_MODE,
        isolationMode: PLACEHOLDER_POCKET_ISOLATION,
        sceneMode: configuredSceneModeState.sceneMode,
        sceneKey: configuredSceneKey,
        sceneModeSource: configuredSceneModeState.source,
      };
}

function validateCreatedRunIdentity(ports, work) {
  const {
    ABYSSAL_SCENE_MODE_ISOLATED,
  } = ports;
  const {
    configuredSceneModeState,
    candidateRunID,
    deps,
  } = work;
  if (
      configuredSceneModeState.sceneMode === ABYSSAL_SCENE_MODE_ISOLATED &&
      toInt(work.createdInstance && work.createdInstance.instanceID, 0) !== candidateRunID
    ) {
      if (deps.dungeonRuntime && typeof deps.dungeonRuntime.purgeInstance === "function") {
        deps.dungeonRuntime.purgeInstance(toInt(work.createdInstance && work.createdInstance.instanceID, 0), {
          reason: "abyssal-scene-identity-mismatch",
        });
        work.createdInstance = null;
      }
      throw new Error("ABYSSAL_SCENE_IDENTITY_PERSIST_FAILED");
    }
}

function registerCreatedRun(ports, work) {
  const {
    cloneValue,
    buildPocketStateFromInstance,
    registerPocket,
    getContentProfile,
    resolveAbyssalSceneModeState,
    log,
    deleteT0DarkLayoutOverride,
    logNewT0DarkLayoutSelection,
    logAbyssalBaseRoomLayoutSelection,
  } = ports;
  const {
    layoutSelectionState,
    traceState,
    createdInstance,
    pocketPosition,
    shipSpawnState,
    deps,
    contentProfile,
    configuredSceneModeState,
    baseRoomLayoutSelectionState,
  } = work;
  if (layoutSelectionState && layoutSelectionState.layoutSelectionSource === "staff-override") {
    deleteT0DarkLayoutOverride(toInt(traceState.characterID, 0));
  }
  let pocketState = buildPocketStateFromInstance(createdInstance, traceState, {
    pocketPosition,
    shipSpawnState,
    activatedAtMs: deps.now(),
  });
  const registeredPocketState = registerPocket(pocketState);
  if (!registeredPocketState) {
    throw new Error("ABYSSAL_SPATIAL_RESERVATION_FAILED");
  }
  pocketState = registeredPocketState;
  const persistedSceneModeState = resolveAbyssalSceneModeState(pocketState, deps);
  log.info(
    `[AbyssalSceneMode] run=${toInt(pocketState.instanceID, 0)} ` +
      `filamentTypeID=${toInt(contentProfile && contentProfile.filamentTypeID, 0)} ` +
      `mode=${persistedSceneModeState.mode} ` +
      `sceneKey=${normalizeText(persistedSceneModeState.sceneKey, "none")} ` +
      `source=${normalizeText(configuredSceneModeState.source, "default")}`,
  );
  logNewT0DarkLayoutSelection(
    pocketState.instanceID,
    getContentProfile(pocketState) || contentProfile,
    layoutSelectionState,
  );
  logAbyssalBaseRoomLayoutSelection(
    pocketState.instanceID,
    getContentProfile(pocketState) || contentProfile,
    baseRoomLayoutSelectionState,
  );
  return {
    success: true,
    created: true,
    data: cloneValue(pocketState),
  };
}

function rollbackCreatedRun(ports, work) {
  const {
    log,
    formatVectorForLog,
    releaseHostSlot,
  } = ports;
  const {
    createdInstance,
    deps,
    candidateRunID,
    spatialReservation,
    error,
  } = work;
  let durableRunRemoved = !createdInstance;
  if (
    createdInstance &&
    deps.dungeonRuntime &&
    typeof deps.dungeonRuntime.purgeInstance === "function"
  ) {
    try {
      deps.dungeonRuntime.purgeInstance(
        toInt(createdInstance.instanceID, candidateRunID),
        { reason: "abyssal-pocket-create-rollback" },
      );
      durableRunRemoved = true;
    } catch (purgeError) {
      log.error(
        `[AbyssalSpatialReservation] run=${candidateRunID} ` +
          `host=${toInt(spatialReservation && spatialReservation.hostSystemID, 0)} ` +
          `slot=${toInt(spatialReservation && spatialReservation.slotID, -1)} ` +
          `origin=${formatVectorForLog(spatialReservation && spatialReservation.spatialOrigin)} ` +
          `scene=${normalizeText(spatialReservation && spatialReservation.sceneID, "none")} ` +
          `reason=create-rollback state=retained ` +
          `error=${normalizeText(purgeError && purgeError.message, "DURABLE_PURGE_FAILED")}`,
      );
    }
  }
  if (spatialReservation && durableRunRemoved) {
    const releaseResult = releaseHostSlot(candidateRunID, {
      hostSystemID: spatialReservation.hostSystemID,
      slotID: spatialReservation.slotID,
    });
    log.info(
      `[AbyssalSpatialReservation] run=${candidateRunID} ` +
        `host=${spatialReservation.hostSystemID} slot=${spatialReservation.slotID} ` +
        `origin=${formatVectorForLog(spatialReservation.spatialOrigin)} ` +
        `scene=${spatialReservation.sceneID} reason=create-rollback ` +
        `state=${releaseResult && releaseResult.success === true ? "released" : "release-failed"}`,
    );
  }
  return {
    success: false,
    errorMsg: normalizeText(error && error.message, "POCKET_CREATE_FAILED"),
  };
}

function createAbyssalRunCreation(ports) {
  return {
    createOrResolvePlaceholderPocket: createOrResolvePlaceholderPocket.bind(null, ports),
  };
}

module.exports = { createAbyssalRunCreation };
