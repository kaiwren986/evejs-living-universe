"use strict";

const { normalizeText } = require("../domain/abyssalValueUtils");

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

// These three readiness boundaries intentionally keep distinct compatibility and timing contracts.
function buildAbyssalDestinationMechanicsReadiness(ports, pocketState, session, deps = ports.getDependencies(), options = {}) {
  const work = { pocketState, session, deps, options };
  inspectDestinationMechanicsRoster(ports, work);
  inspectDestinationMechanicsEnvironment(ports, work);
  buildDestinationMechanicsReceipt(ports, work);
  return finishDestinationMechanicsReadiness(ports, work);
}

function inspectDestinationMechanicsRoster(ports, work) {
  const {
    getActivePocketStateByInstanceID,
    buildPlaceholderRoomState,
    getPlaceholderRoomEntry,
    listUniquePositiveInts,
    getPocketScene,
    resolveAbyssalLiveCombatParticipant,
    resolveExactAbyssalRunRoomScope,
    listActiveAbyssalRoomNpcIDs,
  } = ports;
  const {
    pocketState,
    session,
    deps,
    options,
  } = work;
  const activePocketState = getActivePocketStateByInstanceID(
    toInt(pocketState && pocketState.instanceID, 0),
  ) || pocketState;
  const runID = toInt(activePocketState && activePocketState.instanceID, 0);
  const roomState = buildPlaceholderRoomState(activePocketState);
  const roomIndex = toInt(options.roomIndex, roomState.currentRoomIndex);
  const activeRoomEntry = getPlaceholderRoomEntry(activePocketState, roomIndex);
  const suppliedRoomEntry = getPlaceholderRoomEntry(pocketState, roomIndex);
  const countMaterializedRoomEntities = (entry) => listUniquePositiveInts([
    ...(entry && entry.hostileEntityIDs || []),
    entry && entry.originMarkerItemID,
    entry && entry.conduitItemID,
    entry && entry.cacheItemID,
    entry && entry.cacheStructureItemID,
    entry && entry.cacheLootContainerItemID,
    ...(entry && entry.extractionNodeItemIDs || []),
    ...(entry && entry.extractionNodeLootContainerItemIDs || []),
    ...(entry && entry.rewardSuppressionPendingRemovalItemIDs || []),
    ...(entry && entry.environmentalObjectItemIDs || []),
    ...(entry && entry.sceneryVisualEntityIDs || []),
    entry && entry.sceneryProbeEntityID,
  ]).length;
  const roomEntry = countMaterializedRoomEntities(suppliedRoomEntry) >
    countMaterializedRoomEntities(activeRoomEntry)
    ? suppliedRoomEntry
    : activeRoomEntry;
  const scene = getPocketScene(activePocketState, deps);
  const participantSelection = resolveAbyssalLiveCombatParticipant(
    activePocketState,
    scene,
    { roomIndex },
  );
  const shipID = participantSelection.shipID;
  const shipEntity = participantSelection.shipEntity;
  const shipScope = resolveExactAbyssalRunRoomScope(shipEntity);
  // Validate every live hostile, including non-objective dependants, just as activation does.
  const plannedNpcIDs = listActiveAbyssalRoomNpcIDs(roomEntry);
  const npcActivationResult = options.npcActivationResult || null;
  const npcActivationData = npcActivationResult && npcActivationResult.data || {};
  const npcReadiness = Array.isArray(npcActivationData.readiness)
    ? npcActivationData.readiness
    : [];
  const npcReadinessByID = new Map(
    npcReadiness.map((entry) => [toInt(entry && entry.npcID, 0), entry]),
  );
  const plannedNpcIDSet = new Set(plannedNpcIDs);
  const unreadyNpcIDs = plannedNpcIDs.filter((npcID) => {
    const entry = npcReadinessByID.get(npcID);
    return !entry || entry.ready !== true;
  });
  const unexpectedNpcReadinessIDs = listUniquePositiveInts(
    npcReadiness.map((entry) => entry && entry.npcID),
  ).filter((npcID) => !plannedNpcIDSet.has(npcID));
  Object.assign(work, { activePocketState, runID, roomIndex, roomEntry, scene, shipID, participantSelection, shipScope, plannedNpcIDs, npcActivationResult, npcActivationData, npcReadiness, unreadyNpcIDs, unexpectedNpcReadinessIDs });
}

function inspectDestinationMechanicsEnvironment(ports, work) {
  const {
    listUniquePositiveInts,
    buildAbyssalEnvironmentalMaterializationReadiness,
    buildAbyssalEnvironmentalEffectReadiness,
    listSuppressorControllersForRun,
    buildAbyssalDestinationRequirements,
  } = ports;
  const {
    activePocketState,
    roomIndex,
    deps,
    options,
    runID,
    scene,
  } = work;
  const environmentalMaterialization =
    buildAbyssalEnvironmentalMaterializationReadiness(
      activePocketState,
      roomIndex,
      deps,
    );
  const environmentalEffects = buildAbyssalEnvironmentalEffectReadiness(
    activePocketState,
    roomIndex,
    options.environmentalEffectResult || null,
    deps,
  );
  const expectedSuppressorIDs = environmentalMaterialization.expectedSuppressorIDs;
  const expectedSuppressorIDSet = new Set(expectedSuppressorIDs);
  const suppressorControllers = listSuppressorControllersForRun(runID, roomIndex);
  const suppressorControllerByEntityID = new Map(
    suppressorControllers.map((controller) => [
      toInt(controller && controller.runtimeEntityID, 0),
      controller,
    ]),
  );
  const unreadySuppressorIDs = expectedSuppressorIDs.filter((entityID) => {
    const controller = suppressorControllerByEntityID.get(entityID);
    return !controller ||
      controller.controllerActive !== true ||
      controller.controllerPaused === true ||
      controller.controllerDegraded === true ||
      controller.timerRegistered !== true;
  });
  const unexpectedSuppressorControllerIDs = listUniquePositiveInts(
    suppressorControllers.map((controller) => controller && controller.runtimeEntityID),
  ).filter((entityID) => !expectedSuppressorIDSet.has(entityID));
  const suppressorActivationResults = Array.isArray(options.suppressorActivationResults)
    ? options.suppressorActivationResults
    : [];
  const failedSuppressorActivations = suppressorActivationResults.filter(
    (result) => !result || result.success !== true,
  );
  const boundaryResult = options.boundaryResult || null;
  const boundaryState = boundaryResult && boundaryResult.data || {};
  const weatherResult = options.weatherResult || null;
  const requirements = buildAbyssalDestinationRequirements(
    activePocketState,
    roomIndex,
    scene,
    deps,
  );
  Object.assign(work, { environmentalMaterialization, environmentalEffects, expectedSuppressorIDs, suppressorControllers, unreadySuppressorIDs, unexpectedSuppressorControllerIDs, suppressorActivationResults, failedSuppressorActivations, boundaryResult, boundaryState, weatherResult, requirements });
}

function buildDestinationMechanicsReceipt(ports, work) {
  const {
    hasTerminalFailureOutcome,
    isAbyssalWeatherApplicationReady,
    cloneValue,
  } = ports;
  const {
    activePocketState,
    participantSelection,
    shipScope,
    runID,
    roomIndex,
    requirements,
    environmentalMaterialization,
    environmentalEffects,
    plannedNpcIDs,
    npcActivationResult,
    npcActivationData,
    npcReadiness,
    unreadyNpcIDs,
    unexpectedNpcReadinessIDs,
    failedSuppressorActivations,
    suppressorActivationResults,
    suppressorControllers,
    expectedSuppressorIDs,
    unreadySuppressorIDs,
    unexpectedSuppressorControllerIDs,
    boundaryResult,
    boundaryState,
    shipID,
    weatherResult,
  } = work;
  const readiness = {
    runStillActive: Boolean(activePocketState && !hasTerminalFailureOutcome(activePocketState)),
    participantScopeReady: Boolean(
      participantSelection.success &&
      shipScope &&
      shipScope.runID === runID &&
      shipScope.roomIndex === roomIndex
    ),
    destinationRuntimeReady: requirements.missingCriticalRuntimeIDs.length === 0,
    environmentalMaterializationReady: environmentalMaterialization.ready === true,
    environmentalEffectsReady: environmentalEffects.ready === true,
    npcControllersReady: Boolean(
      plannedNpcIDs.length > 0 &&
      npcActivationResult &&
      npcActivationResult.success === true &&
      npcActivationData.degraded !== true &&
      npcActivationData.compatibility !== true &&
      npcReadiness.length === plannedNpcIDs.length &&
      unreadyNpcIDs.length === 0 &&
      unexpectedNpcReadinessIDs.length === 0
    ),
    suppressorControllersReady: Boolean(
      failedSuppressorActivations.length === 0 &&
      suppressorActivationResults.length ===
        environmentalMaterialization.expectedSuppressorCount &&
      suppressorControllers.length === expectedSuppressorIDs.length &&
      unreadySuppressorIDs.length === 0 &&
      unexpectedSuppressorControllerIDs.length === 0
    ),
    boundaryControllerReady: Boolean(
      boundaryResult &&
      boundaryResult.success === true &&
      toInt(boundaryState.runID, 0) === runID &&
      toInt(boundaryState.roomIndex, 0) === roomIndex &&
      toInt(boundaryState.shipID, 0) === shipID &&
      boundaryState.timerRegistered === true &&
      boundaryState.cleaned !== true
    ),
    authoritativeWeatherReady: isAbyssalWeatherApplicationReady(weatherResult),
    plannedNpcIDs,
    npcReadiness,
    unreadyNpcIDs,
    unexpectedNpcReadinessIDs,
    expectedSuppressorIDs,
    suppressorControllers,
    unreadySuppressorIDs,
    unexpectedSuppressorControllerIDs,
    failedSuppressorActivationCount: failedSuppressorActivations.length,
    boundaryResult: cloneValue(boundaryResult),
    weatherResult: cloneValue(weatherResult),
    missingCriticalRuntimeIDs: requirements.missingCriticalRuntimeIDs,
    environmentalMaterialization,
    environmentalEffects,
  };
  Object.assign(work, { readiness });
}

function finishDestinationMechanicsReadiness(ports, work) {
  const {
    log,
  } = ports;
  const {
    readiness,
    environmentalMaterialization,
    environmentalEffects,
    runID,
    roomIndex,
    unreadyNpcIDs,
    unreadySuppressorIDs,
    requirements,
  } = work;
  readiness.ready = Boolean(
    readiness.runStillActive &&
    readiness.participantScopeReady &&
    readiness.destinationRuntimeReady &&
    readiness.environmentalMaterializationReady &&
    readiness.environmentalEffectsReady &&
    readiness.npcControllersReady &&
    readiness.suppressorControllersReady &&
    readiness.boundaryControllerReady &&
    readiness.authoritativeWeatherReady
  );
  readiness.errorMsg = readiness.ready
    ? ""
    : !readiness.participantScopeReady
      ? "ABYSSAL_DESTINATION_PARTICIPANT_SCOPE_NOT_READY"
      : !readiness.destinationRuntimeReady
        ? "ABYSSAL_DESTINATION_RUNTIME_NOT_READY"
        : !readiness.environmentalMaterializationReady
          ? normalizeText(
              environmentalMaterialization.errorMsg,
              "ABYSSAL_DESTINATION_ENVIRONMENT_NOT_READY",
            )
          : !readiness.environmentalEffectsReady
            ? normalizeText(
                environmentalEffects.errorMsg,
                "ABYSSAL_DESTINATION_ENVIRONMENT_EFFECTS_NOT_READY",
              )
        : !readiness.npcControllersReady
          ? "ABYSSAL_DESTINATION_NPC_CONTROLLERS_NOT_READY"
          : !readiness.suppressorControllersReady
            ? "ABYSSAL_DESTINATION_SUPPRESSORS_NOT_READY"
            : !readiness.boundaryControllerReady
              ? "ABYSSAL_DESTINATION_BOUNDARY_NOT_READY"
              : "ABYSSAL_DESTINATION_WEATHER_NOT_READY";
  log.info(
    `[AbyssalDestinationMechanics] run=${runID} room=${roomIndex} ` +
      `ready=${readiness.ready} participantScope=${readiness.participantScopeReady} ` +
      `runtime=${readiness.destinationRuntimeReady} npc=${readiness.npcControllersReady} ` +
      `environmentMaterialization=${readiness.environmentalMaterializationReady} ` +
      `environmentEffects=${readiness.environmentalEffectsReady} ` +
      `suppressors=${readiness.suppressorControllersReady} ` +
      `boundary=${readiness.boundaryControllerReady} weather=${readiness.authoritativeWeatherReady} ` +
      `unreadyNpcIDs=${unreadyNpcIDs.join(",") || "none"} ` +
      `unreadySuppressorIDs=${unreadySuppressorIDs.join(",") || "none"} ` +
      `missingRuntimeIDs=${requirements.missingCriticalRuntimeIDs.join(",") || "none"} ` +
      `unresolvedCollections=${environmentalEffects.unresolvedCollectionIDs.join(",") || "none"} ` +
      `reason=${readiness.errorMsg || "READY"}`,
  );
  return readiness;
}

function buildAbyssalDestinationPreDeliveryReadiness(ports, pocketState, session, sourceRoomIndex, destinationRoomIndex, deps = ports.getDependencies()) {
  const work = { pocketState, session, sourceRoomIndex, destinationRoomIndex, deps };
  inspectPreDeliveryScene(ports, work);
  inspectPreDeliveryNpcControllers(ports, work);
  inspectPreDeliveryDefinitions(ports, work);
  buildPreDeliveryReceipt(ports, work);
  return finishPreDeliveryReadiness(ports, work);
}

function inspectPreDeliveryScene(ports, work) {
  const {
    getActivePocketStateByInstanceID,
    buildPlaceholderRoomState,
    getPlaceholderRoomEntry,
    getPocketScene,
    buildAbyssalEnvironmentalMaterializationReadiness,
    buildAbyssalDestinationRequirements,
    buildAbyssalSceneDescriptor,
  } = ports;
  const {
    pocketState,
    session,
    destinationRoomIndex,
    deps,
  } = work;
  const activePocketState = getActivePocketStateByInstanceID(
    toInt(pocketState && pocketState.instanceID, 0),
  );
  const roomState = buildPlaceholderRoomState(activePocketState || pocketState);
  const destinationRoomEntry = getPlaceholderRoomEntry(
    activePocketState || pocketState,
    destinationRoomIndex,
  );
  const scene = getPocketScene(activePocketState || pocketState, deps);
  const expectedSceneKey = normalizeText(
    buildAbyssalSceneDescriptor(activePocketState || pocketState, deps) &&
      buildAbyssalSceneDescriptor(activePocketState || pocketState, deps).sceneKey,
    "",
  );
  const sessionSceneKey = normalizeText(
    session && (session.spaceSceneKey || (session._space && session._space.sceneKey)),
    "",
  );
  const requirements = buildAbyssalDestinationRequirements(
    activePocketState || pocketState,
    destinationRoomIndex,
    scene,
    deps,
  );
  const environmentalMaterialization =
    buildAbyssalEnvironmentalMaterializationReadiness(
      activePocketState || pocketState,
      destinationRoomIndex,
      deps,
    );
  Object.assign(work, { activePocketState, roomState, destinationRoomEntry, scene, expectedSceneKey, sessionSceneKey, requirements, environmentalMaterialization });
}

function inspectPreDeliveryNpcControllers(ports, work) {
  const {
    listUniquePositiveInts,
  } = ports;
  const {
    destinationRoomEntry,
    deps,
    scene,
  } = work;
  const hostileEntityIDs = listUniquePositiveInts(destinationRoomEntry && destinationRoomEntry.hostileEntityIDs);
  const plannedObjectiveNpcItemIDs = listUniquePositiveInts(
    destinationRoomEntry && destinationRoomEntry.plannedObjectiveNpcItemIDs,
  );
  const materializedObjectiveNpcItemIDs = listUniquePositiveInts(
    destinationRoomEntry && destinationRoomEntry.materializedObjectiveNpcItemIDs,
  );
  const objectiveRelevantNpcItemIDs = listUniquePositiveInts(
    destinationRoomEntry && destinationRoomEntry.objectiveRelevantNpcItemIDs,
  );
  const materializedObjectiveNpcIDSet = new Set(materializedObjectiveNpcItemIDs);
  const plannedObjectiveNpcIDSet = new Set(plannedObjectiveNpcItemIDs);
  const hostileEntityIDSet = new Set(hostileEntityIDs);
  const missingMaterializedObjectiveNpcIDs = plannedObjectiveNpcItemIDs.filter(
    (entityID) => !materializedObjectiveNpcIDSet.has(entityID),
  );
  const unexpectedMaterializedObjectiveNpcIDs = materializedObjectiveNpcItemIDs.filter(
    (entityID) => !plannedObjectiveNpcIDSet.has(entityID),
  );
  const missingHostileObjectiveNpcIDs = plannedObjectiveNpcItemIDs.filter(
    (entityID) => !hostileEntityIDSet.has(entityID),
  );
  const npcRuntime = deps;
  const controllersUnavailable = !npcRuntime || typeof npcRuntime.getControllerByEntityID !== "function";
  const unpausedOrMissingControllerIDs = hostileEntityIDs.filter((entityID) => {
    const entity = scene && typeof scene.getEntityByID === "function"
      ? scene.getEntityByID(entityID)
      : null;
    const controller = controllersUnavailable ? null : npcRuntime.getControllerByEntityID(entityID);
    if (controller) {
      return !(
        controller.controllerPaused === true ||
        controller.controllerLifecycleState === "materialized_paused"
      );
    }
    return !(
      entity && (
        entity.controllerPaused === true ||
        entity.controllerLifecycleState === "materialized_paused"
      )
    );
  });
  Object.assign(work, { hostileEntityIDs, plannedObjectiveNpcItemIDs, materializedObjectiveNpcItemIDs, objectiveRelevantNpcItemIDs, missingMaterializedObjectiveNpcIDs, unexpectedMaterializedObjectiveNpcIDs, missingHostileObjectiveNpcIDs, unpausedOrMissingControllerIDs });
}

function inspectPreDeliveryDefinitions(ports, work) {
  const {
    listUniquePositiveInts,
    sceneBubbleHasEntity,
    getObjectPosition,
    isAbyssalSceneryVisualsRequested,
    SCENERY_POLICY_AUTHORITATIVE,
  } = ports;
  const {
    destinationRoomEntry,
    hostileEntityIDs,
    scene,
    deps,
    requirements,
  } = work;
  const destinationBubbleAnchorIDs = listUniquePositiveInts([
    destinationRoomEntry && destinationRoomEntry.originMarkerItemID,
    destinationRoomEntry && destinationRoomEntry.conduitItemID,
    ...hostileEntityIDs,
    ...(Array.isArray(destinationRoomEntry && destinationRoomEntry.extractionNodeItemIDs)
      ? destinationRoomEntry.extractionNodeItemIDs
      : []),
  ]);
  const destinationBubbleReady = destinationBubbleAnchorIDs.some((entityID) => {
    const entity = scene && typeof scene.getEntityByID === "function"
      ? scene.getEntityByID(entityID)
      : null;
    return Boolean(
      entity && (
        toInt(entity.bubbleID, 0) > 0 ||
        sceneBubbleHasEntity(scene, entityID)
      )
    );
  });
  const destinationDefinitionsReady = Boolean(
    destinationRoomEntry &&
    getObjectPosition(destinationRoomEntry.roomOriginPosition) &&
    getObjectPosition(destinationRoomEntry.shipSpawnState && destinationRoomEntry.shipSpawnState.position) &&
    (
      (
        !isAbyssalSceneryVisualsRequested(deps) &&
        requirements.sceneryPolicy !== SCENERY_POLICY_AUTHORITATIVE
      ) ||
      requirements.sceneryProfileEntries.length > 0
    )
  );
  Object.assign(work, { destinationBubbleReady, destinationDefinitionsReady });
}

function buildPreDeliveryReceipt(ports, work) {
  const {
    hasTerminalFailureOutcome,
  } = ports;
  const {
    activePocketState,
    roomState,
    sourceRoomIndex,
    destinationRoomIndex,
    destinationDefinitionsReady,
    destinationRoomEntry,
    plannedObjectiveNpcItemIDs,
    materializedObjectiveNpcItemIDs,
    objectiveRelevantNpcItemIDs,
    missingMaterializedObjectiveNpcIDs,
    unexpectedMaterializedObjectiveNpcIDs,
    missingHostileObjectiveNpcIDs,
    requirements,
    destinationBubbleReady,
    environmentalMaterialization,
    hostileEntityIDs,
    unpausedOrMissingControllerIDs,
    scene,
    expectedSceneKey,
    sessionSceneKey,
  } = work;
  const readiness = {
    runStillActive: Boolean(activePocketState && !hasTerminalFailureOutcome(activePocketState)),
    transitionStillCurrent: Boolean(
      roomState.currentRoomIndex === toInt(sourceRoomIndex, 0) &&
      toInt(destinationRoomIndex, 0) === toInt(sourceRoomIndex, 0) + 1
    ),
    destinationDefinitionsReady,
    destinationEncounterDefinitionsReady: Boolean(
      destinationRoomEntry &&
      normalizeText(destinationRoomEntry.encounterProfileID, "") &&
      Array.isArray(destinationRoomEntry.resolvedNpcEntries) &&
      destinationRoomEntry.resolvedNpcEntries.length > 0 &&
      toInt(destinationRoomEntry.objectiveTotal, 0) > 0 &&
      plannedObjectiveNpcItemIDs.length > 0
    ),
    destinationNpcMaterializationReady: Boolean(
      plannedObjectiveNpcItemIDs.length > 0 &&
      materializedObjectiveNpcItemIDs.length === plannedObjectiveNpcItemIDs.length &&
      objectiveRelevantNpcItemIDs.length === plannedObjectiveNpcItemIDs.length &&
      missingMaterializedObjectiveNpcIDs.length === 0 &&
      unexpectedMaterializedObjectiveNpcIDs.length === 0 &&
      missingHostileObjectiveNpcIDs.length === 0
    ),
    destinationCriticalRuntimeReady: Boolean(
      requirements.runtimeEntityIDs.length > 0 &&
      requirements.missingCriticalRuntimeIDs.length === 0 &&
      destinationBubbleReady
    ),
    destinationEnvironmentalMaterializationReady:
      environmentalMaterialization.ready === true,
    destinationControllersReady: Boolean(
      hostileEntityIDs.length > 0 && unpausedOrMissingControllerIDs.length === 0
    ),
    destinationConduitReady: toInt(destinationRoomEntry && destinationRoomEntry.conduitItemID, 0) > 0,
    sessionSceneReady: Boolean(
      scene && expectedSceneKey && sessionSceneKey === expectedSceneKey &&
      normalizeText(scene.sceneKey, expectedSceneKey) === expectedSceneKey
    ),
    destinationBubbleReady,
    criticalRuntimeIDs: requirements.runtimeEntityIDs,
    missingCriticalRuntimeIDs: requirements.missingCriticalRuntimeIDs,
    definitionOnlyIDs: requirements.definitionOnlyIDs,
    unexpectedRequiredIDs: requirements.unexpectedRequiredIDs,
    requirementCandidates: [
      ...requirements.runtimeCandidates,
      ...requirements.definitionCandidates,
    ],
    hostileEntityIDs,
    plannedObjectiveNpcItemIDs,
    materializedObjectiveNpcItemIDs,
    objectiveRelevantNpcItemIDs,
    missingMaterializedObjectiveNpcIDs,
    unexpectedMaterializedObjectiveNpcIDs,
    missingHostileObjectiveNpcIDs,
    unpausedOrMissingControllerIDs,
    environmentalMaterialization,
  };
  Object.assign(work, { readiness });
}

function finishPreDeliveryReadiness(ports, work) {
  const {
    log,
  } = ports;
  const {
    readiness,
    environmentalMaterialization,
    pocketState,
    sourceRoomIndex,
    destinationRoomIndex,
    plannedObjectiveNpcItemIDs,
    materializedObjectiveNpcItemIDs,
    missingMaterializedObjectiveNpcIDs,
    unexpectedMaterializedObjectiveNpcIDs,
    missingHostileObjectiveNpcIDs,
    unpausedOrMissingControllerIDs,
  } = work;
  readiness.ready = Boolean(
    readiness.runStillActive &&
    readiness.transitionStillCurrent &&
    readiness.destinationDefinitionsReady &&
    readiness.destinationEncounterDefinitionsReady &&
    readiness.destinationNpcMaterializationReady &&
    readiness.destinationCriticalRuntimeReady &&
    readiness.destinationEnvironmentalMaterializationReady &&
    readiness.destinationControllersReady &&
    readiness.destinationConduitReady &&
    readiness.sessionSceneReady
  );
  readiness.errorMsg = readiness.ready
    ? ""
    : (
        readiness.missingCriticalRuntimeIDs.length > 0
          ? "ABYSSAL_DESTINATION_CRITICAL_ENTITY_MISSING"
          : readiness.destinationEnvironmentalMaterializationReady !== true
            ? normalizeText(
                environmentalMaterialization.errorMsg,
                "ABYSSAL_DESTINATION_ENVIRONMENT_NOT_READY",
              )
          : readiness.destinationEncounterDefinitionsReady !== true
            ? "ABYSSAL_DESTINATION_ENCOUNTER_DEFINITION_NOT_READY"
            : readiness.destinationNpcMaterializationReady !== true
              ? "ABYSSAL_DESTINATION_NPC_MATERIALIZATION_INCOMPLETE"
              : readiness.destinationControllersReady !== true
                ? "ABYSSAL_DESTINATION_CONTROLLER_NOT_READY"
                : readiness.destinationDefinitionsReady !== true
                  ? "ABYSSAL_DESTINATION_DEFINITION_NOT_READY"
                  : "ABYSSAL_DESTINATION_PREDELIVERY_NOT_READY"
      );
  log.info(
    `[AbyssalTransferPrerequisites] run=${toInt(pocketState && pocketState.instanceID, 0)} ` +
      `fromRoom=${toInt(sourceRoomIndex, 0)} toRoom=${toInt(destinationRoomIndex, 0)} ` +
      `ready=${readiness.ready} runStillActive=${readiness.runStillActive} ` +
      `transitionStillCurrent=${readiness.transitionStillCurrent} ` +
      `destinationDefinitionsReady=${readiness.destinationDefinitionsReady} ` +
      `destinationEncounterDefinitionsReady=${readiness.destinationEncounterDefinitionsReady} ` +
      `destinationNpcMaterializationReady=${readiness.destinationNpcMaterializationReady} ` +
      `destinationCriticalRuntimeReady=${readiness.destinationCriticalRuntimeReady} ` +
      `destinationEnvironmentalMaterializationReady=${readiness.destinationEnvironmentalMaterializationReady} ` +
      `destinationControllersReady=${readiness.destinationControllersReady} ` +
      `destinationConduitReady=${readiness.destinationConduitReady} ` +
      `destinationBubbleReady=${readiness.destinationBubbleReady} ` +
      `sessionSceneReady=${readiness.sessionSceneReady} ` +
      `missingCriticalRuntimeIDs=${readiness.missingCriticalRuntimeIDs.join(",") || "none"} ` +
      `definitionOnlyIDs=${readiness.definitionOnlyIDs.join(",") || "none"} ` +
      `unexpectedRequiredIDs=${readiness.unexpectedRequiredIDs.join(",") || "none"} ` +
      `plannedNpcIDs=${plannedObjectiveNpcItemIDs.join(",") || "none"} ` +
      `materializedNpcIDs=${materializedObjectiveNpcItemIDs.join(",") || "none"} ` +
      `missingMaterializedNpcIDs=${missingMaterializedObjectiveNpcIDs.join(",") || "none"} ` +
      `unexpectedMaterializedNpcIDs=${unexpectedMaterializedObjectiveNpcIDs.join(",") || "none"} ` +
      `missingHostileNpcIDs=${missingHostileObjectiveNpcIDs.join(",") || "none"} ` +
      `unpausedOrMissingControllerIDs=${unpausedOrMissingControllerIDs.join(",") || "none"}`,
  );
  return readiness;
}

function buildAbyssalActiveRoomReadiness(ports, pocketState, session, deps = ports.getDependencies(), options = {}) {
  const work = { pocketState, session, deps, options };
  inspectActiveRoomScene(ports, work);
  inspectActiveRoomNpcs(ports, work);
  inspectActiveRoomEnvironment(ports, work);
  buildActiveRoomReceipt(ports, work);
  return finishActiveRoomReadiness(ports, work);
}

function inspectActiveRoomScene(ports, work) {
  const {
    getActivePocketStateByInstanceID,
    buildPlaceholderRoomState,
    getPlaceholderRoomEntry,
    getPocketScene,
    buildAbyssalDestinationRequirements,
    buildAbyssalSceneDescriptor,
  } = ports;
  const {
    pocketState,
    session,
    deps,
  } = work;
  const activePocketState = getActivePocketStateByInstanceID(
    toInt(pocketState && pocketState.instanceID, 0),
  ) || pocketState;
  const roomState = buildPlaceholderRoomState(activePocketState);
  const roomIndex = roomState.currentRoomIndex;
  const roomEntry = getPlaceholderRoomEntry(activePocketState, roomIndex);
  const scene = getPocketScene(activePocketState, deps);
  const sceneDescriptor = buildAbyssalSceneDescriptor(activePocketState, deps);
  const expectedSceneKey = normalizeText(
    sceneDescriptor && sceneDescriptor.sceneKey,
    normalizeText(scene && scene.sceneKey, ""),
  );
  const sessionSceneKey = normalizeText(
    session && (session.spaceSceneKey || session._space && session._space.sceneKey),
    "",
  );
  const shipID = toInt(activePocketState && activePocketState.shipID, 0);
  const shipEntity = scene && typeof scene.getEntityByID === "function"
    ? scene.getEntityByID(shipID)
    : null;
  const requirements = buildAbyssalDestinationRequirements(
    activePocketState,
    roomIndex,
    scene,
    deps,
  );
  const conduitItemID = toInt(roomEntry && roomEntry.conduitItemID, 0);
  const conduitItem = conduitItemID > 0 && typeof deps.findItemById === "function"
    ? deps.findItemById(conduitItemID)
    : null;
  const conduitEntity = conduitItemID > 0 && scene && typeof scene.getEntityByID === "function"
    ? scene.getEntityByID(conduitItemID)
    : null;
  Object.assign(work, { activePocketState, roomState, roomIndex, roomEntry, scene, expectedSceneKey, sessionSceneKey, shipID, shipEntity, requirements, conduitItemID, conduitItem, conduitEntity });
}

function inspectActiveRoomNpcs(ports, work) {
  const {
    listUniquePositiveInts,
    buildAbyssalNpcControllerReadiness,
  } = ports;
  const {
    roomEntry,
    scene,
    deps,
    options,
    activePocketState,
    shipEntity,
    roomIndex,
  } = work;
  const plannedObjectiveIDs = listUniquePositiveInts(
    roomEntry && roomEntry.plannedObjectiveNpcItemIDs,
  );
  const materializedObjectiveIDs = new Set(listUniquePositiveInts(
    roomEntry && roomEntry.materializedObjectiveNpcItemIDs,
  ));
  const allHostileNpcIDs = listUniquePositiveInts(
    roomEntry && roomEntry.hostileEntityIDs,
  );
  const requiredNpcIDs = plannedObjectiveIDs.length > 0
    ? plannedObjectiveIDs
    : listUniquePositiveInts(roomEntry && roomEntry.objectiveRelevantNpcItemIDs);
  const missingMaterializedNpcIDs = requiredNpcIDs.filter((npcID) =>
    !materializedObjectiveIDs.has(npcID) ||
    !(scene && typeof scene.getEntityByID === "function" && scene.getEntityByID(npcID))
  );
  const npcRuntime = deps;
  const missingHostileNpcIDs = allHostileNpcIDs.filter((npcID) =>
    !(scene && typeof scene.getEntityByID === "function" && scene.getEntityByID(npcID))
  );
  const inactiveNpcControllerIDs = allHostileNpcIDs.filter((npcID) => {
    const entity = scene && typeof scene.getEntityByID === "function"
      ? scene.getEntityByID(npcID)
      : null;
    if (!entity) {
      return true;
    }
    const controller = npcRuntime && typeof npcRuntime.getControllerByEntityID === "function"
      ? npcRuntime.getControllerByEntityID(npcID)
      : null;
    if (controller) {
      return controller.controllerPaused === true ||
        controller.controllerLifecycleState !== "active";
    }
    return !(
      entity &&
      entity.controllerPaused !== true &&
      entity.controllerLifecycleState === "active"
    );
  });
  const pendingNpcControllerReadiness = options.allowPendingNpcControllers === true
    ? allHostileNpcIDs.map((npcID) => buildAbyssalNpcControllerReadiness(
        activePocketState,
        npcID,
        scene,
        npcRuntime,
        {
          expectPaused: true,
          playerEntity: shipEntity,
          roomIndex,
          roomActive: true,
        },
      ))
    : [];
  const pendingNpcControllersReady = Boolean(
    options.allowPendingNpcControllers === true &&
      pendingNpcControllerReadiness.length === allHostileNpcIDs.length &&
      pendingNpcControllerReadiness.every((entry) => entry.ready === true),
  );
  Object.assign(work, { allHostileNpcIDs, requiredNpcIDs, missingMaterializedNpcIDs, missingHostileNpcIDs, inactiveNpcControllerIDs, pendingNpcControllerReadiness, pendingNpcControllersReady });
}

function inspectActiveRoomEnvironment(ports, work) {
  const {
    listUniquePositiveInts,
    buildAbyssalEnvironmentalMaterializationReadiness,
    buildAbyssalEnvironmentalEffectReadiness,
    listSuppressorControllersForRun,
  } = ports;
  const {
    requirements,
    options,
    activePocketState,
    roomIndex,
    deps,
  } = work;
  const sceneryDiagnostics = requirements.sceneryDiagnostics || {};
  const suppressorActivationResults = Array.isArray(options.suppressorActivationResults)
    ? options.suppressorActivationResults
    : [];
  const environmentalMaterialization =
    buildAbyssalEnvironmentalMaterializationReadiness(
      activePocketState,
      roomIndex,
      deps,
    );
  const environmentalEffects = buildAbyssalEnvironmentalEffectReadiness(
    activePocketState,
    roomIndex,
    options.environmentalEffectResult || null,
    deps,
  );
  const expectedSuppressorIDs = environmentalMaterialization.expectedSuppressorIDs;
  const suppressorControllers = listSuppressorControllersForRun(
    toInt(activePocketState && activePocketState.instanceID, 0),
    roomIndex,
  );
  const suppressorControllersByEntityID = new Map(
    suppressorControllers.map((controller) => [
      toInt(controller && controller.runtimeEntityID, 0),
      controller,
    ]),
  );
  const unreadySuppressorIDs = expectedSuppressorIDs.filter((entityID) => {
    const controller = suppressorControllersByEntityID.get(entityID);
    return !controller ||
      controller.controllerActive !== true ||
      controller.controllerPaused === true ||
      controller.controllerDegraded === true ||
      controller.timerRegistered !== true;
  });
  const unexpectedSuppressorControllerIDs = listUniquePositiveInts(
    suppressorControllers.map((controller) => controller && controller.runtimeEntityID),
  ).filter((entityID) => !expectedSuppressorIDs.includes(entityID));
  const boundaryResult = options.boundaryResult || null;
  const weatherResult = options.weatherResult || null;
  const npcActivationCompatibility = Boolean(
    options.npcActivationResult &&
    options.npcActivationResult.data &&
    options.npcActivationResult.data.compatibility === true
  );
  Object.assign(work, { sceneryDiagnostics, suppressorActivationResults, environmentalMaterialization, environmentalEffects, expectedSuppressorIDs, suppressorControllers, unreadySuppressorIDs, unexpectedSuppressorControllerIDs, boundaryResult, weatherResult, npcActivationCompatibility });
}

function buildActiveRoomReceipt(ports, work) {
  const {
    hasTerminalFailureOutcome,
    isAbyssalWeatherApplicationReady,
    getObjectPosition,
    normalizeLowerText,
  } = ports;
  const {
    activePocketState,
    roomIndex,
    roomEntry,
    scene,
    expectedSceneKey,
    sessionSceneKey,
    shipEntity,
    shipID,
    conduitItemID,
    conduitItem,
    conduitEntity,
    options,
    requiredNpcIDs,
    allHostileNpcIDs,
    missingMaterializedNpcIDs,
    missingHostileNpcIDs,
    pendingNpcControllersReady,
    npcActivationCompatibility,
    inactiveNpcControllerIDs,
    sceneryDiagnostics,
    environmentalMaterialization,
    environmentalEffects,
    suppressorActivationResults,
    suppressorControllers,
    expectedSuppressorIDs,
    unreadySuppressorIDs,
    unexpectedSuppressorControllerIDs,
    boundaryResult,
    weatherResult,
    requirements,
    pendingNpcControllerReadiness,
  } = work;
  const readiness = {
    runStillActive: Boolean(activePocketState && !hasTerminalFailureOutcome(activePocketState)),
    roomIdentityReady: Boolean(
      roomIndex > 0 &&
      getObjectPosition(roomEntry && roomEntry.roomOriginPosition) &&
      getObjectPosition(roomEntry && roomEntry.shipSpawnState)
    ),
    sceneIdentityReady: Boolean(
      scene &&
      expectedSceneKey &&
      normalizeText(scene.sceneKey, expectedSceneKey) === expectedSceneKey &&
      sessionSceneKey === expectedSceneKey &&
      shipEntity &&
      toInt(shipEntity.itemID, 0) === shipID
    ),
    conduitReady: Boolean(conduitItemID > 0 && conduitItem && conduitEntity),
    spawnComplete: Boolean(
      options.spawnResult &&
      options.spawnResult.success === true &&
      options.spawnResult.partial !== true
    ),
    npcDefinitionsReady: Boolean(
      Array.isArray(roomEntry && roomEntry.resolvedNpcEntries) &&
      roomEntry.resolvedNpcEntries.length > 0 &&
      requiredNpcIDs.length > 0 &&
      allHostileNpcIDs.length >= requiredNpcIDs.length
    ),
    npcMaterializationReady: Boolean(
      missingMaterializedNpcIDs.length === 0 &&
      missingHostileNpcIDs.length === 0
    ),
    npcControllersReady: Boolean(
      options.npcActivationResult &&
      options.npcActivationResult.success === true &&
      (
        pendingNpcControllersReady ||
        npcActivationCompatibility ||
        (
          inactiveNpcControllerIDs.length === 0 &&
          normalizeLowerText(roomEntry && roomEntry.npcControllerActivationState, "") === "active"
        )
      )
    ),
    authoritativeSceneryReady: Boolean(
      toInt(sceneryDiagnostics.missingAuthoritativeSceneryCount, 0) === 0 &&
      toInt(sceneryDiagnostics.duplicateAuthoritativeSceneryCount, 0) === 0
    ),
    environmentalMaterializationReady: Boolean(
      options.environmentalResult &&
      options.environmentalResult.success === true &&
      options.environmentalResult.partial !== true &&
      environmentalMaterialization.ready === true
    ),
    environmentalEffectsReady: environmentalEffects.ready === true,
    suppressorControllersReady: Boolean(
      suppressorActivationResults.length ===
        environmentalMaterialization.expectedSuppressorCount &&
      suppressorActivationResults.every((result) => result && result.success === true) &&
      suppressorControllers.length === expectedSuppressorIDs.length &&
      unreadySuppressorIDs.length === 0 &&
      unexpectedSuppressorControllerIDs.length === 0
    ),
    boundaryControllerReady: Boolean(boundaryResult && boundaryResult.success === true),
    authoritativeWeatherReady: isAbyssalWeatherApplicationReady(weatherResult),
    missingCriticalRuntimeIDs: requirements.missingCriticalRuntimeIDs,
    missingMaterializedNpcIDs,
    missingHostileNpcIDs,
    inactiveNpcControllerIDs,
    pendingNpcControllersReady,
    pendingNpcControllerReadiness,
    npcActivationCompatibility,
    npcControllersActivated: Boolean(
      npcActivationCompatibility ||
      (
        inactiveNpcControllerIDs.length === 0 &&
        normalizeLowerText(roomEntry && roomEntry.npcControllerActivationState, "") === "active"
      )
    ),
    environmentalMaterialization,
    environmentalEffects,
    expectedSuppressorIDs,
    unreadySuppressorIDs,
    unexpectedSuppressorControllerIDs,
  };
  Object.assign(work, { readiness });
}

function finishActiveRoomReadiness(ports, work) {
  const {
    log,
  } = ports;
  const {
    readiness,
    activePocketState,
    roomIndex,
    environmentalMaterialization,
    environmentalEffects,
    weatherResult,
    boundaryResult,
    missingMaterializedNpcIDs,
    missingHostileNpcIDs,
    inactiveNpcControllerIDs,
    unreadySuppressorIDs,
  } = work;
  readiness.ready = Boolean(
    readiness.runStillActive &&
    readiness.roomIdentityReady &&
    readiness.sceneIdentityReady &&
    readiness.conduitReady &&
    readiness.spawnComplete &&
    readiness.npcDefinitionsReady &&
    readiness.npcMaterializationReady &&
    readiness.npcControllersReady &&
    readiness.authoritativeSceneryReady &&
    readiness.environmentalMaterializationReady &&
    readiness.environmentalEffectsReady &&
    readiness.suppressorControllersReady &&
    readiness.boundaryControllerReady &&
    readiness.authoritativeWeatherReady &&
    readiness.missingCriticalRuntimeIDs.length === 0
  );
  readiness.materializationReady = readiness.ready;
  readiness.gameplayReady = Boolean(
    readiness.ready && readiness.npcControllersActivated
  );
  readiness.errorMsg = readiness.ready
    ? ""
    : !readiness.conduitReady
      ? "ABYSSAL_ACTIVE_ROOM_CONDUIT_NOT_READY"
      : !readiness.sceneIdentityReady
        ? "ABYSSAL_ACTIVE_ROOM_SCENE_NOT_READY"
        : !readiness.npcDefinitionsReady || !readiness.npcMaterializationReady
          ? "ABYSSAL_ACTIVE_ROOM_NPCS_NOT_READY"
          : !readiness.npcControllersReady
            ? "ABYSSAL_ACTIVE_ROOM_NPC_CONTROLLERS_NOT_READY"
            : !readiness.authoritativeSceneryReady
              ? "ABYSSAL_ACTIVE_ROOM_SCENERY_NOT_READY"
              : !readiness.authoritativeWeatherReady
                ? "ABYSSAL_ACTIVE_ROOM_WEATHER_NOT_READY"
              : !readiness.environmentalMaterializationReady ||
                  !readiness.environmentalEffectsReady ||
                  !readiness.suppressorControllersReady ||
                  !readiness.boundaryControllerReady
                ? "ABYSSAL_ACTIVE_ROOM_ENVIRONMENT_NOT_READY"
                : "ABYSSAL_ACTIVE_ROOM_MATERIALIZATION_PARTIAL";
  log.info(
    `[AbyssalActiveRoomReadiness] run=${toInt(activePocketState && activePocketState.instanceID, 0)} ` +
      `room=${roomIndex} materializationReady=${readiness.materializationReady} ` +
      `gameplayReady=${readiness.gameplayReady} sceneReady=${readiness.sceneIdentityReady} ` +
      `conduit=${readiness.conduitReady} ` +
      `spawn=${readiness.spawnComplete} npcDefinitions=${readiness.npcDefinitionsReady} ` +
      `npcMaterialization=${readiness.npcMaterializationReady} ` +
      `npcControllerRegistrationReady=${readiness.npcControllersReady} ` +
      `npcControllersActivated=${readiness.npcControllersActivated} ` +
      `npcCompatibility=${readiness.npcActivationCompatibility} ` +
      `scenery=${readiness.authoritativeSceneryReady} ` +
      `environment=${readiness.environmentalMaterializationReady} ` +
      `environmentError=${normalizeText(environmentalMaterialization.errorMsg, "none")} ` +
      `environmentExpected=${toInt(environmentalMaterialization.totalAuthoredCount, 0)} ` +
      `environmentMaterialized=${toInt(environmentalMaterialization.materializedCount, 0)} ` +
      `environmentMissingSlots=${environmentalMaterialization.missingOrInvalidSlots.join(",") || "none"} ` +
      `environmentEffects=${readiness.environmentalEffectsReady} ` +
      `environmentEffectError=${normalizeText(environmentalEffects.errorMsg, "none")} ` +
      `environmentEffectEvaluated=${toInt(environmentalEffects.evaluatedCount, 0)}/` +
        `${toInt(environmentalEffects.authoredCount, 0)} ` +
      `suppressors=${readiness.suppressorControllersReady} ` +
      `boundary=${readiness.boundaryControllerReady} ` +
      `weather=${readiness.authoritativeWeatherReady} ` +
      `weatherSource=${Boolean(weatherResult && weatherResult.playerModifierSourceRegistered)} ` +
      `weatherRefresh=${Boolean(weatherResult && weatherResult.playerRefreshed)} ` +
      `weatherDerived=${Boolean(weatherResult && weatherResult.playerDerivedEffectsVerified)} ` +
      `boundaryError=${normalizeText(boundaryResult && boundaryResult.errorMsg, "none")} ` +
      `missingRuntime=${readiness.missingCriticalRuntimeIDs.join(",") || "none"} ` +
      `missingNpcs=${missingMaterializedNpcIDs.join(",") || "none"} ` +
      `missingHostiles=${missingHostileNpcIDs.join(",") || "none"} ` +
      `inactiveControllers=${inactiveNpcControllerIDs.join(",") || "none"} ` +
      `unreadySuppressors=${unreadySuppressorIDs.join(",") || "none"} ` +
      `unresolvedCollections=${environmentalEffects.unresolvedCollectionIDs.join(",") || "none"} ` +
      `reason=${readiness.errorMsg || (
        readiness.gameplayReady ? "GAMEPLAY_READY" : "MATERIALIZATION_READY_GAMEPLAY_PENDING"
      )}`,
  );
  return readiness;
}

function createAbyssalRoomReadiness(ports) {
  return {
    buildAbyssalDestinationMechanicsReadiness: buildAbyssalDestinationMechanicsReadiness.bind(null, ports),
    buildAbyssalDestinationPreDeliveryReadiness: buildAbyssalDestinationPreDeliveryReadiness.bind(null, ports),
    buildAbyssalActiveRoomReadiness: buildAbyssalActiveRoomReadiness.bind(null, ports),
  };
}

module.exports = { createAbyssalRoomReadiness };
