"use strict";

const { toInt, normalizeText, listUniquePositiveInts } = require("../domain/abyssalRuntimeValues");

const { buildInactiveStatusReport } = require("./abyssalInactiveStatusLines");
const { buildActiveStatusReport } = require("./abyssalActiveStatusLines");

function collectSessionStatus(ports, context) {
  const {
    getSessionContext,
    getActivePocketStateForSession,
    isAbyssalIsolatedScenesEnabled,
    getConfiguredAbyssalSceneModeSource,
    buildAbyssalRoomOneFxStatus,
    buildAbyssalTransitionFxStatus,
    buildAbyssalSceneryVisualStatus,
    buildAbyssalSceneryProbeStatus,
    buildAbyssalRoomVisualStatus,
    buildAbyssalTraceStatusLines,
  } = ports;
  const sessionContext = getSessionContext(context.session);
  const rawPocketState = getActivePocketStateForSession(context.session);
  const configuredIsolatedScenes = isAbyssalIsolatedScenesEnabled();
  const configuredSceneSource = getConfiguredAbyssalSceneModeSource();
  const runtime = context.deps;
  const attachedScene = runtime && typeof runtime.getSceneForSession === "function"
    ? runtime.getSceneForSession(context.session)
    : null;
  const actualAttachedSceneKey = normalizeText(
    attachedScene && attachedScene.sceneKey,
    normalizeText(context.session && context.session._space && context.session._space.sceneKey, "none"),
  );
  const lastCleanupReport = ports.getLastCleanupReport();
  const lastCleanup = lastCleanupReport && typeof lastCleanupReport === "object"
    ? lastCleanupReport
    : null;
  const artifactRemovalAttemptsAlreadyGoneCount = toInt(
    lastCleanup && lastCleanup.artifactRemovalAttemptsAlreadyGoneCount,
    toInt(lastCleanup && lastCleanup.alreadyGoneCount, 0),
  );
  const roomOneFxStatus = buildAbyssalRoomOneFxStatus(null, context.deps, {
    defaultShipID: toInt(sessionContext.shipID, 0),
  });
  const transitionFxStatus = buildAbyssalTransitionFxStatus(null, context.deps);
  const sceneryVisualStatus = buildAbyssalSceneryVisualStatus(null, context.deps);
  const sceneryProbeStatus = buildAbyssalSceneryProbeStatus(null, context.deps);
  const roomVisualStatus = buildAbyssalRoomVisualStatus(null, context.deps);
  const traceStatusLines = buildAbyssalTraceStatusLines(context.session, rawPocketState, context.deps);
  Object.assign(context, {
    sessionContext,
    rawPocketState,
    configuredIsolatedScenes,
    configuredSceneSource,
    runtime,
    attachedScene,
    actualAttachedSceneKey,
    lastCleanupReport,
    lastCleanup,
    artifactRemovalAttemptsAlreadyGoneCount,
    roomOneFxStatus,
    transitionFxStatus,
    sceneryVisualStatus,
    sceneryProbeStatus,
    roomVisualStatus,
    traceStatusLines,
  });
}

function collectRunPresentationStatus(ports, context) {
  const {
    buildPocketStateForCurrentRoom,
    buildAbyssalRoomOneFxStatus,
    buildAbyssalTransitionFxStatus,
    buildAbyssalSceneryVisualStatus,
    buildAbyssalSceneryProbeStatus,
    buildAbyssalRoomVisualStatus,
    getContentProfile,
  } = ports;
  const pocketState = buildPocketStateForCurrentRoom(context.rawPocketState);
  const activeRoomOneFxStatus = buildAbyssalRoomOneFxStatus(pocketState, context.deps, {
    defaultShipID: toInt(context.sessionContext.shipID, toInt(pocketState.shipID, 0)),
  });
  const activeTransitionFxStatus = buildAbyssalTransitionFxStatus(pocketState, context.deps);
  const activeSceneryVisualStatus = buildAbyssalSceneryVisualStatus(pocketState, context.deps);
  const activeSceneryProbeStatus = buildAbyssalSceneryProbeStatus(pocketState, context.deps);
  const activeRoomVisualStatus = buildAbyssalRoomVisualStatus(pocketState, context.deps);

  const contentProfile = getContentProfile(pocketState) || {};
  Object.assign(context, {
    pocketState,
    activeRoomOneFxStatus,
    activeTransitionFxStatus,
    activeSceneryVisualStatus,
    activeSceneryProbeStatus,
    activeRoomVisualStatus,
    contentProfile,
  });
}

function collectContentAuthorityStatus(ports, context) {
  const {
    cloneValue,
  } = ports;
  const contentCompletenessReport =
    context.contentProfile.contentCompletenessReport &&
      typeof context.contentProfile.contentCompletenessReport === "object"
      ? cloneValue(context.contentProfile.contentCompletenessReport)
      : typeof ports.buildAbyssalContentCompletenessReport ===
          "function"
        ? ports.buildAbyssalContentCompletenessReport(
          context.contentProfile,
        )
        : null;
  const contentCompletenessAudit =
    context.contentProfile.contentCompletenessAudit &&
      typeof context.contentProfile.contentCompletenessAudit === "object"
      ? cloneValue(context.contentProfile.contentCompletenessAudit)
      : null;
  const contentAuthority =
    context.contentProfile.contentAuthority &&
      typeof context.contentProfile.contentAuthority === "object"
      ? context.contentProfile.contentAuthority
      : {};
  const contentAuthorityRoomLines = Object.entries(
    contentAuthority.rooms && typeof contentAuthority.rooms === "object"
      ? contentAuthority.rooms
      : {},
  )
    .sort(([left], [right]) => toInt(left, 0) - toInt(right, 0))
    .map(([roomIndex, roomAuthority]) =>
      `Room ${toInt(roomIndex, 0)} content authority: ` +
        [
          "encounter",
          "rewards",
          "scenery",
          "transitions",
          "boundary",
          "suppressors",
          "extraction_nodes",
        ].map((component) =>
          `${component}=${normalizeText(
            roomAuthority && roomAuthority[component],
            context.contentProfile.contentRequirements &&
              context.contentProfile.contentRequirements.rooms &&
              context.contentProfile.contentRequirements.rooms[roomIndex] &&
              context.contentProfile.contentRequirements.rooms[roomIndex][component] ===
                "not_applicable"
              ? "not_applicable"
              : "unknown",
          )}`
        ).join(" ")
    );
  const contentAuthorityStatusLines = [
    `Content policy: ${normalizeText(
      contentCompletenessReport && contentCompletenessReport.policy,
      "unknown",
    )}`,
    `Content completeness: ${
      contentCompletenessReport && contentCompletenessReport.complete === true
        ? "PASS"
        : "FAIL"
    }`,
    `Declared completeness level: ${normalizeText(
      contentCompletenessAudit &&
        contentCompletenessAudit.declaredCompletenessLevel,
      "unknown",
    )}`,
    `Achieved completeness level: ${normalizeText(
      contentCompletenessAudit &&
        contentCompletenessAudit.achievedCompletenessLevel,
      "unknown",
    )}`,
    `Content fallback count: ${toInt(
      contentCompletenessAudit && contentCompletenessAudit.fallbackCount,
      0,
    )}`,
    `Next completeness level: ${normalizeText(
      contentCompletenessAudit && contentCompletenessAudit.nextLevel,
      "none",
    )}`,
    `Next-level blockers: ${
      contentCompletenessAudit &&
      Array.isArray(contentCompletenessAudit.nextLevelBlockers) &&
      contentCompletenessAudit.nextLevelBlockers.length > 0
        ? contentCompletenessAudit.nextLevelBlockers
          .slice(0, 20)
          .map((entry) =>
            `${normalizeText(entry.path || entry.component, "unknown")}:` +
            `${normalizeText(entry.reason, "UNKNOWN")}`
          )
          .join(",")
        : "none"
    }`,
    `Definition authority: ${normalizeText(contentAuthority.definition, "unknown")}`,
    `Weather authority: ${normalizeText(contentAuthority.weather, "unknown")}`,
    `Trace authority: ${normalizeText(contentAuthority.trace, "unknown")}`,
    ...contentAuthorityRoomLines,
    `Placeholder components: ${
      contentCompletenessReport &&
      Array.isArray(contentCompletenessReport.placeholderComponents) &&
      contentCompletenessReport.placeholderComponents.length > 0
        ? contentCompletenessReport.placeholderComponents.join(",")
        : "none"
    }`,
    `Provisional components: ${
      contentCompletenessReport &&
      Array.isArray(contentCompletenessReport.provisionalComponents) &&
      contentCompletenessReport.provisionalComponents.length > 0
        ? contentCompletenessReport.provisionalComponents.join(",")
        : "none"
    }`,
  ];
  Object.assign(context, {
    contentCompletenessReport,
    contentCompletenessAudit,
    contentAuthority,
    contentAuthorityRoomLines,
    contentAuthorityStatusLines,
  });
}

function collectRoomStatus(ports, context) {
  const {
    buildPlaceholderRoomState,
    getPlaceholderRoomEntry,
    normalizeT0DarkLayoutSelectionState,
    normalizeAbyssalBaseRoomLayoutSelectionState,
    resolveSelectedT0DarkRoom,
    buildAbyssalRoomContentDiagnostics,
    getSuppressorDebugSnapshot,
    getBoundaryControllerForRun,
  } = ports;
  const roomState = buildPlaceholderRoomState(context.pocketState);
  const currentRoomEntry = getPlaceholderRoomEntry(context.pocketState, roomState.currentRoomIndex);
  const layoutSelectionState = normalizeT0DarkLayoutSelectionState(context.pocketState);
  const selectedRoomLayoutIDs = layoutSelectionState && layoutSelectionState.selectedRoomLayoutIDs || {};
  const baseRoomLayoutSelectionState = context.pocketState &&
      context.pocketState.selectedBaseRoomLayoutIDs
    ? normalizeAbyssalBaseRoomLayoutSelectionState(context.pocketState, {
        runID: context.pocketState.instanceID,
        filamentTypeID: context.contentProfile && context.contentProfile.filamentTypeID,
        tier: context.contentProfile && context.contentProfile.tier,
        weatherType: context.contentProfile && context.contentProfile.weatherType,
      })
    : null;
  const selectedBaseRoomLayoutIDs =
    baseRoomLayoutSelectionState &&
      baseRoomLayoutSelectionState.selectedBaseRoomLayoutIDs || {};
  const currentRoomLayout = layoutSelectionState
    ? resolveSelectedT0DarkRoom(layoutSelectionState, roomState.currentRoomIndex)
    : null;
  const roomContentDiagnostics = buildAbyssalRoomContentDiagnostics(
    context.pocketState,
    roomState.currentRoomIndex,
    context.deps,
  );
  const preparedRoomEntityCounts = roomContentDiagnostics.preparedEntityCounts;
  const deliveredRoomEntityCounts = roomContentDiagnostics.deliveredEntityCounts;
  const suppressorControllers = roomContentDiagnostics.suppressorControllers || [];
  const suppressorPresentations = roomContentDiagnostics.suppressorPresentations || [];
  const suppressorDebug = getSuppressorDebugSnapshot(toInt(context.pocketState.instanceID, 0));
  const boundaryController = getBoundaryControllerForRun(
    toInt(context.pocketState.instanceID, 0),
  );
  const suppressorDebugLines = [
    `Suppressor debug: ${suppressorDebug.enabled === true ? "ON" : "OFF"} ` +
      `source=${normalizeText(suppressorDebug.source, "default-off")}`,
  ];
  if (suppressorDebug.enabled === true) {
    const lastPulse = suppressorDebug.lastPulse;
    suppressorDebugLines.push(lastPulse
      ? `  last pulse: pulse=${toInt(lastPulse.pulseNumber, 0)} ` +
        `timestamp=${toInt(lastPulse.timestamp, 0)} rawCandidates=${toInt(lastPulse.rawCandidates, 0)} ` +
        `eligible=${toInt(lastPulse.eligible, 0)} insideRange=${toInt(lastPulse.insideRange, 0)} ` +
        `selected=${toInt(lastPulse.selected, 0)} affected=${toInt(lastPulse.affected, 0)} ` +
        `removedMissiles=${toInt(lastPulse.removedMissiles, 0)} ` +
        `damaged=${toInt(lastPulse.damaged, 0)} failed=${toInt(lastPulse.failed, 0)}`
      : "  last pulse: none");
    suppressorDebugLines.push(
      ...suppressorDebug.missileActions.slice(-5).reverse().map((entry) =>
        `  recent missile: id=${toInt(entry.missileID, 0)} ` +
          `pulse=${toInt(entry.pulseNumber, 0)} distance=${entry.distanceAtSelection != null && Number.isFinite(Number(entry.distanceAtSelection)) ? Number(entry.distanceAtSelection) : "unknown"} ` +
          `source=${toInt(entry.sourceShipID, 0)} target=${toInt(entry.targetID, 0)} ` +
          `result=${normalizeText(entry.result, "unknown")}`
      ),
      ...suppressorDebug.targetActions
        .filter((entry) => normalizeText(entry.entityClass, "").includes("drone"))
        .slice(-5)
        .reverse()
        .map((entry) =>
          `  recent drone: id=${toInt(entry.targetID, 0)} pulse=${toInt(entry.pulseNumber, 0)} ` +
            `distance=${entry.distanceMeters != null && Number.isFinite(Number(entry.distanceMeters)) ? Number(entry.distanceMeters) : "unknown"} ` +
            `shield=${entry.shieldBefore != null && Number.isFinite(Number(entry.shieldBefore)) ? Number(entry.shieldBefore) : "unknown"}->${entry.shieldAfter != null && Number.isFinite(Number(entry.shieldAfter)) ? Number(entry.shieldAfter) : "unknown"} ` +
            `armor=${entry.armorBefore != null && Number.isFinite(Number(entry.armorBefore)) ? Number(entry.armorBefore) : "unknown"}->${entry.armorAfter != null && Number.isFinite(Number(entry.armorAfter)) ? Number(entry.armorAfter) : "unknown"} ` +
            `structure=${entry.structureBefore != null && Number.isFinite(Number(entry.structureBefore)) ? Number(entry.structureBefore) : "unknown"}->${entry.structureAfter != null && Number.isFinite(Number(entry.structureAfter)) ? Number(entry.structureAfter) : "unknown"} ` +
            `result=${normalizeText(entry.result, "unknown")}`
        ),
    );
  }
  Object.assign(context, {
    roomState,
    currentRoomEntry,
    layoutSelectionState,
    selectedRoomLayoutIDs,
    baseRoomLayoutSelectionState,
    selectedBaseRoomLayoutIDs,
    currentRoomLayout,
    roomContentDiagnostics,
    preparedRoomEntityCounts,
    deliveredRoomEntityCounts,
    suppressorControllers,
    suppressorPresentations,
    suppressorDebug,
    boundaryController,
    suppressorDebugLines,
  });
}

function collectRuntimeStatus(ports, context) {
  const {
    getResolvedWeatherState,
    resolveRoomNpcProfile,
    resolveRoomRewardProfile,
    resolveRoomExtractionNodeProfile,
    getRewardState,
    getAbyssalTimeoutState,
    getAbyssalEnvironmentNotificationState,
    buildAbyssalDungeonTrackingState,
    buildAbyssalVisibilityRestrictionSummaryForSession,
    collectAbyssalArtifactInventory,
  } = ports;
  const weatherState = getResolvedWeatherState(context.pocketState) || {};
  const weatherDiagnostics =
    context.pocketState.weatherDiagnostics && typeof context.pocketState.weatherDiagnostics === "object"
      ? context.pocketState.weatherDiagnostics
      : {};
  const shipEntity = context.deps.getEntity(context.session, toInt(context.pocketState.shipID, 0));
  const currentNpcProfile = resolveRoomNpcProfile(context.pocketState, context.roomState.currentRoomIndex, {
    logResolution: false,
  });
  const currentRewardProfile = resolveRoomRewardProfile(context.pocketState, context.roomState.currentRoomIndex);
  const currentExtractionNodeProfile = resolveRoomExtractionNodeProfile(context.pocketState, context.roomState.currentRoomIndex);
  const rewardState = getRewardState(context.pocketState) || {};
  const timeoutState = getAbyssalTimeoutState(context.pocketState, context.deps);
  const clientEnvironment =
    context.session && context.session.abyssalClientEnvironment &&
    typeof context.session.abyssalClientEnvironment === "object"
      ? context.session.abyssalClientEnvironment
      : {};
  const clientEnvironmentDelivery =
    context.session && context.session.abyssalClientEnvironmentDelivery &&
    typeof context.session.abyssalClientEnvironmentDelivery === "object"
      ? context.session.abyssalClientEnvironmentDelivery
      : {};
  const environmentNotificationState = getAbyssalEnvironmentNotificationState(
    context.session,
    toInt(context.pocketState.instanceID, 0),
  );
  const currentRoomIndex = toInt(context.roomState.currentRoomIndex, 0);
  const dungeonTrackingState = buildAbyssalDungeonTrackingState(
    context.pocketState,
    context.deps,
    "status",
  );
  const enteredAtMs = toInt(
    environmentNotificationState.enteredAtMsByLocation[currentRoomIndex],
    0,
  );
  const lastExitedAtMs = Math.max(
    0,
    ...Object.values(environmentNotificationState.exitedAtMsByLocation)
      .map((value) => toInt(value, 0)),
  );
  const visibilityRestrictions = buildAbyssalVisibilityRestrictionSummaryForSession(context.session, {
    pocketState: context.pocketState,
  });
  const artifactInventory = collectAbyssalArtifactInventory(context.pocketState, context.deps);
  const npcEntities = listUniquePositiveInts(context.currentRoomEntry.hostileEntityIDs)
    .map((hostileEntityID) => ({
      hostileEntityID,
      entity: context.deps.getEntity(context.session, hostileEntityID),
    }));
  Object.assign(context, {
    weatherState,
    weatherDiagnostics,
    shipEntity,
    currentNpcProfile,
    currentRewardProfile,
    currentExtractionNodeProfile,
    rewardState,
    timeoutState,
    clientEnvironment,
    clientEnvironmentDelivery,
    environmentNotificationState,
    currentRoomIndex,
    dungeonTrackingState,
    enteredAtMs,
    lastExitedAtMs,
    visibilityRestrictions,
    artifactInventory,
    npcEntities,
  });
}

function collectScenePublicationStatus(ports, context) {
  const {
    resolveAbyssalSceneModeState,
    ABYSSAL_SCENE_MODE_ISOLATED,
    getPendingAbyssalTransitionState,
    isAbyssalRestrictionBypassAllowed,
    ABYSSAL_INTERNAL_BYPASS,
    getRoomProfile,
    resolveRoomOriginPosition,
    ABYSSAL_ROOM_DELIVERY_STATE,
  } = ports;
  const sceneModeState = resolveAbyssalSceneModeState(context.pocketState, context.deps);
  const currentSceneKey = normalizeText(sceneModeState.sceneKey, "none");
  const sceneModeMatches = sceneModeState.sceneMode === ABYSSAL_SCENE_MODE_ISOLATED
    ? currentSceneKey !== "none" && context.actualAttachedSceneKey === currentSceneKey
    : !context.actualAttachedSceneKey.startsWith("abyssal-run:");
  const activeTransitionState = getPendingAbyssalTransitionState(context.pocketState);
  const mayViewTransitionToken = isAbyssalRestrictionBypassAllowed({
    session: context.session,
    capability: ABYSSAL_INTERNAL_BYPASS,
  });
  const roomProfile = getRoomProfile(context.pocketState) || {};
  const roomOrigins = [1, 2, 3].map((roomIndex) =>
    resolveRoomOriginPosition(context.pocketState, roomIndex)
  );
  const roomEntries = Object.values(context.roomState.roomStatesByIndex || {});
  const hiddenPrewarmedEntityCount = roomEntries
    .filter((entry) =>
      normalizeText(entry && entry.deliveryState, "") ===
        ABYSSAL_ROOM_DELIVERY_STATE.PREWARMED_HIDDEN
    )
    .reduce(
      (total, entry) => total + Math.max(0, toInt(entry.deferredInitialPublicationCount, 0)),
      0,
    );
  const deferredInitialPublicationCount = roomEntries.reduce(
    (total, entry) => total + Math.max(0, toInt(entry.deferredInitialPublicationCount, 0)),
    0,
  );
  const earlyPublicationViolationCount = roomEntries.reduce(
    (total, entry) => total + Math.max(0, toInt(entry.earlyPublicationViolationCount, 0)),
    0,
  );
  const duplicateDestinationPublicationCount = roomEntries.reduce(
    (total, entry) => total + Math.max(0, toInt(entry.duplicateDestinationPublicationCount, 0)),
    0,
  );
  Object.assign(context, {
    sceneModeState,
    currentSceneKey,
    sceneModeMatches,
    activeTransitionState,
    mayViewTransitionToken,
    roomProfile,
    roomOrigins,
    roomEntries,
    hiddenPrewarmedEntityCount,
    deferredInitialPublicationCount,
    earlyPublicationViolationCount,
    duplicateDestinationPublicationCount,
  });
}

function buildAbyssalStatusReportForSession(ports, session, deps = ports.getDependencies()) {
  const context = { session, deps };
  collectSessionStatus(ports, context);
  if (!context.rawPocketState) return buildInactiveStatusReport(ports, context);
  collectRunPresentationStatus(ports, context);
  collectContentAuthorityStatus(ports, context);
  collectRoomStatus(ports, context);
  collectRuntimeStatus(ports, context);
  collectScenePublicationStatus(ports, context);
  return buildActiveStatusReport(ports, context);
}

function createAbyssalStatusReport(ports) {
  return { buildAbyssalStatusReportForSession: buildAbyssalStatusReportForSession.bind(null, ports) };
}

module.exports = { createAbyssalStatusReport };
