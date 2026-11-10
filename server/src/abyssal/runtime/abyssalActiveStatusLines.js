"use strict";

const { toInt, round6, normalizeText, listUniquePositiveInts, getObjectPosition, formatVectorForLog } = require("../domain/abyssalRuntimeValues");

function buildRunIdentityLines(ports, context) {
  return [
    "Abyssal active run: yes",
    ...context.traceStatusLines,
    `Configured isolated-scene default: ${context.configuredIsolatedScenes}`,
    `Configuration source: ${context.configuredSceneSource}`,
    `Persisted run scene mode: ${context.sceneModeState.sceneMode}`,
    `Current scene key: ${context.currentSceneKey}`,
    `Actual attached scene key: ${context.actualAttachedSceneKey}`,
    `Mode match: ${context.sceneModeMatches}`,
    `Legacy compatibility state: ${context.configuredIsolatedScenes ? "disabled" : "explicitly-enabled-incomplete"}`,
    `activeRunCount: ${ports.getActiveRunCount()}`,
    `instanceID: ${toInt(context.pocketState.instanceID, 0)}`,
    `filament: ${toInt(context.contentProfile.filamentTypeID, 0)} ${normalizeText(context.contentProfile.filamentName, "Unknown Filament")}`,
    `definitionID: ${normalizeText(context.contentProfile.definitionID, "unavailable")}`,
    ...context.contentAuthorityStatusLines,
    `tier: ${toInt(context.contentProfile.tier, 0)}`,
    `weather: ${normalizeText(context.weatherState.weatherType, "unknown")} (${normalizeText(context.weatherState.weatherName, "Unknown Weather")})`,
    `weather strengthPct: ${toInt(context.weatherState.strengthPercent, 0)} deterministic=${context.weatherState.deterministicPlaceholder === true}`,
    `room: ${toInt(context.roomState.currentRoomIndex, 1)}/${toInt(context.roomState.implementedRooms, 1)}`,
    `active transition token: ${context.activeTransitionState ? (context.mayViewTransitionToken ? context.activeTransitionState.token : "redacted") : "none"}`,
    `transition source room: ${toInt(context.activeTransitionState && context.activeTransitionState.sourceRoomIndex, 0) || "none"}`,
    `transition destination room: ${toInt(context.activeTransitionState && context.activeTransitionState.targetRoomIndex, 0) || "none"}`,
    `transition current phase: ${normalizeText(context.activeTransitionState && context.activeTransitionState.currentPhase, "none")}`,
    `transition committed room: ${toInt(context.activeTransitionState && context.activeTransitionState.committedRoomIndex, context.roomState.currentRoomIndex)}`,
    `transition destination prewarmed count: ${toInt(context.activeTransitionState && context.activeTransitionState.destinationPrewarmedCount, 0)}`,
    `transition destination visible count: ${toInt(context.activeTransitionState && context.activeTransitionState.destinationVisibleCount, 0)}`,
    `transition source controllers paused: ${context.activeTransitionState && context.activeTransitionState.sourceControllersPaused === true}`,
    `transition destination controllers active: ${context.activeTransitionState && context.activeTransitionState.destinationControllersActive === true}`,
    `transition early visibility violation count: ${toInt(context.activeTransitionState && context.activeTransitionState.earlyVisibilityViolationCount, 0)}`,
    `run base origin: ${JSON.stringify(getObjectPosition(context.pocketState.roomOneOriginPosition) || getObjectPosition(context.pocketState.pocketPosition) || { x: 0, y: 0, z: 0 })}`,
    `Room 1 origin: ${JSON.stringify(context.roomOrigins[0])}`,
    `Room 2 origin: ${JSON.stringify(context.roomOrigins[1])}`,
    `Room 3 origin: ${JSON.stringify(context.roomOrigins[2])}`,
    `room-origin separation metres: ${toInt(context.roomProfile.roomOriginStrideMeters, 0)}`,
    `Boundary controller: state=${normalizeText(context.boundaryController && context.boundaryController.controllerState, "inactive")} ` +
      `run=${toInt(context.boundaryController && context.boundaryController.runID, 0) || "none"} ` +
      `sceneKey=${normalizeText(context.boundaryController && context.boundaryController.sceneKey, "none")} ` +
      `room=${toInt(context.boundaryController && context.boundaryController.roomIndex, 0) || "none"} ` +
      `ship=${toInt(context.boundaryController && context.boundaryController.shipID, 0) || "none"}`,
    `Boundary geometry: origin=${context.boundaryController && context.boundaryController.roomOrigin ? JSON.stringify(context.boundaryController.roomOrigin) : "none"} ` +
      `radius=${round6(context.boundaryController && context.boundaryController.perimeterRadiusMeters)} ` +
      `radiusSource=${normalizeText(context.boundaryController && context.boundaryController.perimeterRadiusSource, "none")} ` +
      `distance=${round6(context.boundaryController && context.boundaryController.distanceFromRoomOriginMeters)} ` +
      `depth=${round6(context.boundaryController && context.boundaryController.depthOutsideMeters)}`,
    `Boundary cadence: previousSample=${toInt(context.boundaryController && context.boundaryController.previousSampleTimeMs, 0)} ` +
      `nextTick=${toInt(context.boundaryController && context.boundaryController.nextTickTimeMs, 0)} ` +
      `interval=${toInt(context.boundaryController && context.boundaryController.tickIntervalMs, 0)}`,
    `Boundary damage: lastApplied=${round6(context.boundaryController && context.boundaryController.lastAppliedDamage)} ` +
      `baseCurve=${round6(context.boundaryController && context.boundaryController.baseCurveDamage)} ` +
      `varianceMultiplier=${round6(context.boundaryController && context.boundaryController.varianceMultiplier)} ` +
      `outsideFraction=${round6(context.boundaryController && context.boundaryController.outsideExposureFraction)} ` +
      `profile=${normalizeText(context.boundaryController && context.boundaryController.profileID, "none")} ` +
      `evidence=${normalizeText(context.boundaryController && context.boundaryController.evidence && context.boundaryController.evidence.distanceCurve, "none")}`,
  ];
}

function buildLayoutEntityLines(ports, context) {
  const {
    resolveSelectedAbyssalBaseRoomLayoutID,
  } = ports;
  return [
    `hidden prewarmed entity count: ${context.hiddenPrewarmedEntityCount}`,
    `deferred initial publication count: ${context.deferredInitialPublicationCount}`,
    `early publication violation count: ${context.earlyPublicationViolationCount}`,
    `duplicate destination publication count: ${context.duplicateDestinationPublicationCount}`,
    `Base room selection model: ${normalizeText(context.baseRoomLayoutSelectionState && context.baseRoomLayoutSelectionState.baseRoomLayoutSelectionModel, "not-applicable")}`,
    `Base room selection seed: ${context.baseRoomLayoutSelectionState ? toInt(context.baseRoomLayoutSelectionState.baseRoomLayoutSelectionSeed, 0) >>> 0 : "not-applicable"}`,
    `Base Room 1 layout ID: ${normalizeText(context.selectedBaseRoomLayoutIDs["1"] || context.selectedBaseRoomLayoutIDs[1], "not-applicable")}`,
    `Base Room 2 layout ID: ${normalizeText(context.selectedBaseRoomLayoutIDs["2"] || context.selectedBaseRoomLayoutIDs[2], "not-applicable")}`,
    `Base Room 3 layout ID: ${normalizeText(context.selectedBaseRoomLayoutIDs["3"] || context.selectedBaseRoomLayoutIDs[3], "not-applicable")}`,
    `Current base room layout ID: ${normalizeText(resolveSelectedAbyssalBaseRoomLayoutID(context.pocketState || {}, context.roomState.currentRoomIndex), "not-applicable")}`,
    `Tier 0 Dark overlay selection model: ${normalizeText(context.layoutSelectionState && context.layoutSelectionState.layoutSelectionModel, "not-applicable")}`,
    `Tier 0 Dark overlay selection seed: ${context.layoutSelectionState ? toInt(context.layoutSelectionState.layoutSelectionSeed, 0) >>> 0 : "not-applicable"}`,
    `Tier 0 Dark overlay layout set ID: ${normalizeText(context.layoutSelectionState && context.layoutSelectionState.selectedLayoutSetID, "not-applicable")}`,
    `Tier 0 Dark overlay Room 1 layout ID: ${normalizeText(context.selectedRoomLayoutIDs["1"] || context.selectedRoomLayoutIDs[1], "not-applicable")}`,
    `Tier 0 Dark overlay Room 2 layout ID: ${normalizeText(context.selectedRoomLayoutIDs["2"] || context.selectedRoomLayoutIDs[2], "not-applicable")}`,
    `Tier 0 Dark overlay Room 3 layout ID: ${normalizeText(context.selectedRoomLayoutIDs["3"] || context.selectedRoomLayoutIDs[3], "not-applicable")}`,
    `Current Tier 0 Dark overlay room layout ID: ${normalizeText(context.currentRoomLayout && context.currentRoomLayout.layoutID, "not-applicable")}`,
    `Scenery policy: ${normalizeText(context.roomContentDiagnostics.sceneryPolicy, "experimental")}`,
    `Scenery config enabled: ${context.roomContentDiagnostics.sceneryConfigEnabled === true}`,
    `Authoritative scenery count: ${toInt(context.roomContentDiagnostics.authoritativeSceneryCount, 0)}`,
    `Experimental scenery count: ${toInt(context.roomContentDiagnostics.experimentalSceneryCount, 0)}`,
    `Expected decoration count: ${toInt(context.roomContentDiagnostics.expectedDecorationCount, 0)}`,
    `Materialized decoration count: ${toInt(context.roomContentDiagnostics.materializedDecorationCount, 0)}`,
    `Missing authoritative scenery count: ${toInt(context.roomContentDiagnostics.missingAuthoritativeSceneryCount, 0)}`,
    `Duplicate authoritative scenery count: ${toInt(context.roomContentDiagnostics.duplicateAuthoritativeSceneryCount, 0)}`,
    `Current layout evidence source: ${normalizeText(context.currentRoomLayout && context.currentRoomLayout.evidence && context.currentRoomLayout.evidence.sourceFile, "not-applicable")}`,
    `Layout selection source: ${normalizeText(context.layoutSelectionState && context.layoutSelectionState.layoutSelectionSource, "not-applicable")}`,
    `Current expected entity total: ${toInt(context.currentRoomLayout && context.currentRoomLayout.expectedEntityTotal, 0)}`,
    `Current materialized entity total: ${context.deliveredRoomEntityCounts.totalRoomEntityCount}`,
    `Current functional role totals: NPCs=${context.preparedRoomEntityCounts.npcCount} ` +
      `conduits=${context.preparedRoomEntityCounts.conduitCount} ` +
      `cacheOrWreck=${context.preparedRoomEntityCounts.rewardCacheCount + context.preparedRoomEntityCounts.rewardWreckCount} ` +
      `functionalEnvironment=${context.preparedRoomEntityCounts.functionalEnvironmentCount} ` +
      `weather=${context.preparedRoomEntityCounts.weatherCount} ` +
      `volumetricCloud=${context.preparedRoomEntityCounts.volumetricCloudCount}`,
    "Room entities:",
    `  total: ${context.preparedRoomEntityCounts.totalRoomEntityCount}`,
    `  delivered total: ${context.deliveredRoomEntityCounts.totalRoomEntityCount}`,
    `  decorations: ${context.preparedRoomEntityCounts.decorationCount}`,
    `  functional environments: ${context.preparedRoomEntityCounts.functionalEnvironmentCount}`,
    `  perimeter: ${context.preparedRoomEntityCounts.perimeterCount}`,
    `  weather: ${context.preparedRoomEntityCounts.weatherCount}`,
    `  volumetric cloud: ${context.preparedRoomEntityCounts.volumetricCloudCount}`,
    `  NPCs: ${context.preparedRoomEntityCounts.npcCount}`,
    `  conduit: ${context.preparedRoomEntityCounts.conduitCount}`,
    `  cache/wreck: ${context.preparedRoomEntityCounts.rewardCacheCount}/${context.preparedRoomEntityCounts.rewardWreckCount}`,
    `  extraction nodes: ${context.preparedRoomEntityCounts.extractionNodeCount}`,
    `  probes: ${context.preparedRoomEntityCounts.probeCount}`,
    `  unknown: ${context.preparedRoomEntityCounts.unknownCount}`,
    `  environmentCount: ${context.preparedRoomEntityCounts.environmentCount} (weather + volumetric cloud + functional environment + perimeter)`,
    `  authoredSceneryCount: ${context.preparedRoomEntityCounts.authoredSceneryCount} (decorations + functional environment + perimeter)`,
    `  primary role integrity: ${context.preparedRoomEntityCounts.primaryRoleCountSum}/${context.preparedRoomEntityCounts.totalRoomEntityCount}`,
    `  unknown entity IDs: ${context.preparedRoomEntityCounts.unknownEntityIDs.join(",") || "none"}`,
    `  unknown type IDs: ${context.preparedRoomEntityCounts.unknownTypeIDs.join(",") || "none"}`,
    ...context.preparedRoomEntityCounts.functionalEnvironmentEntries.map((entry) =>
      `  functional environment: typeID=${toInt(entry.typeID, 0)} ` +
        `name="${normalizeText(entry.name, "Unknown Type")}" ` +
        `runtimeItemID=${toInt(entry.runtimeItemID, 0)} ` +
        `role=${normalizeText(entry.abyssalEntityRole, "unknown")} ` +
        `presentationEnabled=${entry.presentationEnabled === true} ` +
        `mechanicsEnabled=${entry.mechanicsEnabled === true} ` +
        `range=${Number(entry.rangeMeters) > 0 ? `${Number(entry.rangeMeters)}m` : "unknown"}`
    ),
  ];
}

function buildSuppressorLines(ports, context) {
  return [
    ...context.suppressorControllers.flatMap((controller) => [
      `  suppressor controller: typeID=${toInt(controller.typeID, 0)} ` +
        `name="${normalizeText(controller.name, "Unknown Type")}" ` +
        `runtimeItemID=${toInt(controller.runtimeEntityID, 0)} ` +
        `run=${toInt(controller.runID, 0)} room=${toInt(controller.roomIndex, 0)} ` +
        `profile=${normalizeText(controller.mechanicsProfileID, "none")}`,
      `    state: enabled=${controller.mechanicsEnabled === true} ` +
        `registered=${controller.controllerRegistered === true} ` +
        `paused=${controller.controllerPaused === true} ` +
        `active=${controller.controllerActive === true} ` +
        `degraded=${controller.controllerDegraded === true} ` +
        `reason=${normalizeText(controller.controllerDegradedReason, "none")}`,
      `    evidence values: presentationRadius=${Number(controller.presentationRadiusMeters)}m ` +
        `mechanicsRange=${Number(controller.mechanicsRangeMeters)}m ` +
        `duration=${toInt(controller.activationDurationMs, 0)}ms ` +
        `dogmaEffectID=${toInt(controller.dogmaEffectID, 0)} ` +
        `targetTypeListID=${toInt(controller.targetTypeListID, 0)} ` +
        `resolvedTargetClasses=${(controller.resolvedTargetClasses || []).join(",") || "none"}`,
      `    damage: em=${Number(controller.damage && controller.damage.em) || 0} ` +
        `explosive=${Number(controller.damage && controller.damage.explosive) || 0} ` +
        `kinetic=${Number(controller.damage && controller.damage.kinetic) || 0} ` +
        `thermal=${Number(controller.damage && controller.damage.thermal) || 0}`,
      `    pulses: last=${toInt(controller.lastPulseAt, 0)} ` +
        `next=${toInt(controller.nextPulseAt, 0)} count=${toInt(controller.pulseCount, 0)} ` +
        `eligibleLast=${toInt(controller.eligibleTargetsLastPulse, 0)} ` +
        `insideRangeLast=${toInt(controller.insideRangeTargetsLastPulse, 0)} ` +
        `selectedLast=${toInt(controller.selectedTargetsLastPulse, 0)} ` +
        `affectedLast=${toInt(controller.affectedTargetsLastPulse, 0)} ` +
        `destroyedLast=${toInt(controller.destroyedTargetsLastPulse, 0)} ` +
        `totalAffected=${toInt(controller.totalAffected, 0)} ` +
        `totalDestroyed=${toInt(controller.totalDestroyed, 0)}`,
      `    latest pulse candidates: sceneEntities=${toInt(controller.latestPulseSummary && controller.latestPulseSummary.sceneEntities, 0)} ` +
        `missiles=${toInt(controller.latestPulseSummary && controller.latestPulseSummary.missileCandidates, 0)} ` +
        `drones=${toInt(controller.latestPulseSummary && controller.latestPulseSummary.droneCandidates, 0)} ` +
        `fighters=${toInt(controller.latestPulseSummary && controller.latestPulseSummary.fighterCandidates, 0)} ` +
        `npcs=${toInt(controller.latestPulseSummary && controller.latestPulseSummary.npcCandidates, 0)} ` +
        `deduplicated=${toInt(controller.latestPulseSummary && controller.latestPulseSummary.deduplicatedCandidates, 0)}`,
      `    latest pulse rejections: missingPosition=${toInt(controller.latestPulseSummary && controller.latestPulseSummary.missingPosition, 0)} ` +
        `wrongScene=${toInt(controller.latestPulseSummary && controller.latestPulseSummary.wrongScene, 0)} ` +
        `wrongRun=${toInt(controller.latestPulseSummary && controller.latestPulseSummary.wrongRun, 0)} ` +
        `wrongRoom=${toInt(controller.latestPulseSummary && controller.latestPulseSummary.wrongRoom, 0)} ` +
        `unsupportedClass=${toInt(controller.latestPulseSummary && controller.latestPulseSummary.unsupportedClass, 0)} ` +
        `outsideRange=${toInt(controller.latestPulseSummary && controller.latestPulseSummary.outsideRange, 0)} ` +
        `alreadyDestroyed=${toInt(controller.latestPulseSummary && controller.latestPulseSummary.alreadyDestroyed, 0)} ` +
        `missingController=${toInt(controller.latestPulseSummary && controller.latestPulseSummary.missingController, 0)} ` +
        `hiddenPrewarm=${toInt(controller.latestPulseSummary && controller.latestPulseSummary.hiddenPrewarm, 0)} ` +
        `duplicate=${toInt(controller.latestPulseSummary && controller.latestPulseSummary.duplicate, 0)}`,
    ]),
    ...context.suppressorPresentations.flatMap((presentation) => [
      `  suppressor effect: typeID=${toInt(presentation.typeID, 0)} ` +
        `runtimeItemID=${toInt(presentation.runtimeEntityID, 0)} ` +
        `effectProfileID=${normalizeText(presentation.effectProfileID, "none")} ` +
        `effectName=${normalizeText(presentation.effectName, "none")}`,
      `    presentation state: effectConfigured=${presentation.effectConfigured === true} ` +
        `effectSent=${presentation.effectSent === true} ` +
        `effectActive=${presentation.effectActive === true} ` +
        `effectStartCount=${toInt(presentation.effectStartCount, 0)} ` +
        `effectStopCount=${toInt(presentation.effectStopCount, 0)}`,
      `    presentation lifecycle: lastEffectStartedAt=${toInt(presentation.lastEffectStartedAt, 0)} ` +
        `lastEffectStoppedAt=${toInt(presentation.lastEffectStoppedAt, 0)} ` +
        `lastEffectStopReason=${normalizeText(presentation.lastEffectStopReason, "none")} ` +
        `effectRecipients=${toInt(presentation.effectRecipientCount, 0)} ` +
        `activeEffectRecipients=${toInt(presentation.activeEffectRecipientCount, 0)}`,
    ]),
    ...context.suppressorDebugLines,
  ];
}

function buildClientTrackingLines(ports, context) {
  const {
    getTimerRemainingMs,
    ABYSSAL_TIMEOUT_MODE,
  } = ports;
  return [
    `dungeon tracking content id: ${normalizeText(context.dungeonTrackingState.contentID, "none")}`,
    `dungeon tracking dungeon id: ${toInt(context.dungeonTrackingState.dungeonID, 0)}`,
    `dungeon tracking room id: ${toInt(context.dungeonTrackingState.roomID, 0)}`,
    `dungeon tracking cloud dungeon id: ${toInt(context.dungeonTrackingState.cloudDungeonID, 0)}`,
    `dungeon tracking cloud object type id: ${toInt(context.dungeonTrackingState.cloudObjectTypeID, 0)}`,
    `dungeon tracking cloud dun object id: ${toInt(context.dungeonTrackingState.cloudDunObjectID, 0)}`,
    `dungeon tracking expiry at: ${toInt(context.dungeonTrackingState.expiryAt, 0)}`,
    `dungeon tracking remaining duration: ${toInt(context.dungeonTrackingState.remainingDuration, 0)}`,
    `dungeon tracking pockets completed: ${toInt(context.dungeonTrackingState.pocketsCompleted, 0)}`,
    `dungeon tracking targets remaining: ${toInt(context.dungeonTrackingState.targetsRemaining, 0)}`,
    `dungeon tracking cache objective state: ${normalizeText(context.dungeonTrackingState.cacheObjectiveState, "absent")}`,
    `dungeon tracking notification route: ${normalizeText(context.dungeonTrackingState.notificationState.expiryRoute, "broadcast:charid")}`,
    `dungeon tracking expiry notification timestamp: ${toInt(context.dungeonTrackingState.notificationState.expirySentAtMs, 0)}`,
    `client cloud application: ${normalizeText(context.dungeonTrackingState.clientCloudApplication, "UNVERIFIED")}`,
    `client environment scene key: ${normalizeText(context.clientEnvironment.sceneKey, normalizeText(context.session && context.session.spaceSceneKey, "none"))}`,
    `client environment profile id: ${normalizeText(context.clientEnvironment.profileID, context.activeRoomVisualStatus.profileID)}`,
    `client environment notification route: ${normalizeText(context.clientEnvironment.notificationRoute, "broadcast:shipid")}`,
    `client environment outer-envelope mode: ${normalizeText(context.clientEnvironment.notificationOuterEnvelopeMode, "retail-transfer-mode")}`,
    `client environment companion route: ${normalizeText(context.clientEnvironment.companionNotificationRoute, "broadcast:charid")}`,
    `client environment dungeon id: ${toInt(context.clientEnvironment.volumetricCloudDungeonID, 0)}`,
    `client environment room id: ${toInt(context.clientEnvironment.dungeonRoomID, 0)}`,
    `client environment nebula graphic id: ${toInt(context.clientEnvironment.nebulaGraphicID, 0)}`,
    `client environment notification sent timestamp: ${toInt(context.clientEnvironment.notificationSentAtMs, 0)}`,
    `client environment abyssal location entered timestamp: ${context.enteredAtMs}`,
    `client environment OnExitingDungeon/OnAbyssalLocationExited timestamp: ${context.lastExitedAtMs}`,
    `client environment session location: ${toInt(context.session && context.session.locationid, 0)}`,
    `client environment ego: ${toInt(context.session && context.session._space && context.session._space.shipID, 0)}`,
    `client environment room delivery state: ${normalizeText(context.clientEnvironmentDelivery.status, "none")}`,
    `client environment application: ${normalizeText(context.clientEnvironment.clientApplication, "UNVERIFIED")}`,
    `origin system/location: ${toInt(context.pocketState.sourceSolarSystemID, 0)}/${toInt(context.pocketState.sourceLocationID, 0)}`,
    `origin trace item: ${toInt(context.pocketState.sourceTraceItemID, 0)}`,
    `origin trace position: ${formatVectorForLog(context.pocketState.sourceTracePosition)}`,
    `origin ship position: ${formatVectorForLog(context.pocketState.sourceShipPosition)}`,
    `objective complete: ${context.pocketState.objectiveComplete === true}`,
    `run outcome: ${normalizeText(context.pocketState.runOutcome, "active")}`,
    `timer remainingMs: ${getTimerRemainingMs(context.pocketState, context.deps)}`,
    `timeout mode: ${normalizeText(context.timeoutState.mode, ABYSSAL_TIMEOUT_MODE.LETHAL)}`,
    `lethal timeout enabled: ${context.timeoutState.lethalTimeoutEnabled === true}`,
    `timeout shipDestroyed: ${context.timeoutState.shipDestroyed === true}`,
    `timeout podDestroyed: ${context.timeoutState.podDestroyed === true}`,
    `timeout cleanupTriggered: ${context.timeoutState.cleanupTriggered === true}`,
    `timeout reason: ${normalizeText(context.timeoutState.reason, "none")}`,
    `currentRunArtifactCounts: entranceTraces=${context.artifactInventory.entranceTraces.length} markers=${context.artifactInventory.markers.length} conduits=${context.artifactInventory.conduits.length} hostiles=${context.artifactInventory.hostiles.length} rewardCaches=${context.artifactInventory.rewardCaches.length} extractionNodes=${context.artifactInventory.extractionNodes.length} environmentalObjects=${context.artifactInventory.environmentalObjects.length} sceneryVisuals=${context.artifactInventory.sceneryVisuals.length} weatherEffects=${context.artifactInventory.weatherEffects.length}`,
    `cleanupLastReason: ${normalizeText(context.lastCleanup && context.lastCleanup.reason, "none")}`,
    `cleanupFailedCount: ${toInt(context.lastCleanup && context.lastCleanup.cleanupFailedCount, 0)}`,
    `artifactRemovalAttemptsAlreadyGoneCount: ${context.artifactRemovalAttemptsAlreadyGoneCount}`,
    `staleArtifactCount: ${toInt(context.lastCleanup && context.lastCleanup.staleArtifactCount, 0)}`,
    `runRecoverable: ${toInt(context.pocketState.exitMarkerItemID, 0) > 0}`,
    `shipID: ${toInt(context.pocketState.shipID, 0)}`,
  ];
}

function buildTransitionVisualLines(ports, context) {
  const {
    TRANSITION_POLICY_EXPERIMENTAL,
  } = ports;
  return [
    `transition fx enabled: ${context.activeTransitionFxStatus.enabled === true}`,
    `transition policy: ${normalizeText(context.activeTransitionFxStatus.transitionPolicy, TRANSITION_POLICY_EXPERIMENTAL)}`,
    `transition profile set id: ${normalizeText(context.activeTransitionFxStatus.profileID, "none")}`,
    `transition server-owned policy: ${context.activeTransitionFxStatus.serverOwnedPolicy === true}`,
    `transition fx entry key: ${normalizeText(context.activeTransitionFxStatus.entryKey, "none")}`,
    `transition fx entry guid: ${normalizeText(context.activeTransitionFxStatus.entryGuid, "none")}`,
    `transition fx entry status: ${normalizeText(context.activeTransitionFxStatus.entryStatus, "none")}`,
    `transition fx transfer key: ${normalizeText(context.activeTransitionFxStatus.transferKey, "none")}`,
    `transition fx transfer guid: ${normalizeText(context.activeTransitionFxStatus.transferGuid, "none")}`,
    `transition fx transfer status: ${normalizeText(context.activeTransitionFxStatus.transferStatus, "none")}`,
    `transition fx exit key: ${normalizeText(context.activeTransitionFxStatus.exitKey, "none")}`,
    `transition fx exit guid: ${normalizeText(context.activeTransitionFxStatus.exitGuid, "none")}`,
    `transition fx exit status: ${normalizeText(context.activeTransitionFxStatus.exitStatus, "none")}`,
    `ship hide supported: ${context.activeTransitionFxStatus.shipHideSupported === true} reason=${normalizeText(context.activeTransitionFxStatus.shipHideReason, "none")}`,
    `abyssal client fx enabled: ${context.activeRoomOneFxStatus.enabled === true}`,
    `abyssal client fx requested key: ${normalizeText(context.activeRoomOneFxStatus.requestedKey, "none")}`,
    `abyssal client fx selected key: ${normalizeText(context.activeRoomOneFxStatus.selectedKey, "none")}`,
    `abyssal client fx guid: ${normalizeText(context.activeRoomOneFxStatus.guid, "none")}`,
    `abyssal client fx fallback: ${normalizeText(context.activeRoomOneFxStatus.fallbackReason, "none")}`,
    `abyssal client fx room1 send status: ${normalizeText(context.activeRoomOneFxStatus.sendStatus, "none")}`,
    `abyssal client fx source shipID: ${toInt(context.activeRoomOneFxStatus.sourceShipID, 0)}`,
    `abyssal client fx send error: ${normalizeText(context.activeRoomOneFxStatus.sendErrorMsg, "none")}`,
    `room visuals requested: ${context.activeRoomVisualStatus.requested === true}`,
    `room visuals enabled: ${context.activeRoomVisualStatus.enabled === true}`,
    `room visuals profile id: ${normalizeText(context.activeRoomVisualStatus.profileID, "none")}`,
    `room visuals profile authored: ${context.activeRoomVisualStatus.profileAuthored === true}`,
    `room visuals environment source: ${normalizeText(context.activeRoomVisualStatus.environmentSource, "none")}`,
    `room visuals fallback generated: ${context.activeRoomVisualStatus.fallbackGenerated === true}`,
    `room visuals layout variant: ${normalizeText(context.activeRoomVisualStatus.layoutVariant, "none")}`,
    `room visuals room index: ${toInt(context.activeRoomVisualStatus.roomIndex, 0)}`,
    `room visuals scene cube resource: ${normalizeText(context.activeRoomVisualStatus.sceneCubeResource, "none")}`,
    `room visuals volumetric cloud resource: ${normalizeText(context.activeRoomVisualStatus.volumetricCloudResource, "none")}`,
    `room visuals near-field resource: ${normalizeText(context.activeRoomVisualStatus.nearFieldResource, "none")}`,
    `room visuals lens flare resource: ${normalizeText(context.activeRoomVisualStatus.lensFlareResource, "none")}`,
    `room visuals gradient resource: ${normalizeText(context.activeRoomVisualStatus.gradientResource, "none")}`,
    `room visuals weather object type id: ${toInt(context.activeRoomVisualStatus.weatherObjectTypeID, 0)}`,
    `room visuals transition effect: ${normalizeText(context.activeRoomVisualStatus.transitionEffect, "none")}`,
    `room visuals room layout profile id: ${normalizeText(context.activeRoomVisualStatus.roomLayoutProfileID, "none")}`,
    `room visuals block reason: ${normalizeText(context.activeRoomVisualStatus.blockReason, "none")}`,
    `room visuals skybox: ${normalizeText(context.activeRoomVisualStatus.skybox, "none")}`,
    `room visuals per-room skybox: ${normalizeText(context.activeRoomVisualStatus.perRoomSkybox, "none")}`,
    `room visuals fog: ${normalizeText(context.activeRoomVisualStatus.fog, "none")}`,
    `room visuals color grading: ${normalizeText(context.activeRoomVisualStatus.colorGrading, "none")}`,
    `room visuals background lighting: ${normalizeText(context.activeRoomVisualStatus.backgroundLighting, "none")}`,
    `room visuals ambient client effects: ${normalizeText(context.activeRoomVisualStatus.ambientClientEffects, "none")}`,
  ];
}

function buildSceneryWeatherLines(ports, context) {
  return [
    `scenery visuals requested: ${context.activeSceneryVisualStatus.requested === true}`,
    `scenery visuals enabled: ${context.activeSceneryVisualStatus.enabled === true}`,
    `scenery profile id: ${normalizeText(context.activeSceneryVisualStatus.profileID, "none")}`,
    `structure dressing profile id: ${normalizeText(context.activeSceneryVisualStatus.structureDressingProfileID, "none")}`,
    `scenery artifact count: ${toInt(context.activeSceneryVisualStatus.artifactCount, 0)}`,
    `scenery profile artifact count: ${toInt(context.activeSceneryVisualStatus.profileArtifactCount, 0)}`,
    `scenery entity ids: ${normalizeText(context.activeSceneryVisualStatus.artifactEntityIDs.join(","), "none")}`,
    `scenery type ids: ${normalizeText(context.activeSceneryVisualStatus.artifactTypeIDs.join(","), "none")}`,
    `scenery type names: ${normalizeText(context.activeSceneryVisualStatus.artifactTypeNames.join(","), "none")}`,
    `scenery profile type ids: ${normalizeText(context.activeSceneryVisualStatus.profileTypeIDs.join(","), "none")}`,
    `scenery profile type names: ${normalizeText(context.activeSceneryVisualStatus.profileTypeNames.join(","), "none")}`,
    `structure dressing type id: ${toInt(context.activeSceneryVisualStatus.structureTypeID, 0)}`,
    `structure dressing type name: ${normalizeText(context.activeSceneryVisualStatus.structureTypeName, "none")}`,
    `scenery cloud type id: ${toInt(context.activeSceneryVisualStatus.cloudTypeID, 0)}`,
    `scenery cloud type name: ${normalizeText(context.activeSceneryVisualStatus.cloudTypeName, "none")}`,
    `scenery cloud type ids: ${normalizeText(context.activeSceneryVisualStatus.cloudTypeIDs.join(","), "none")}`,
    `scenery cloud type names: ${normalizeText(context.activeSceneryVisualStatus.cloudTypeNames.join(","), "none")}`,
    `scenery cloud radius overrides: ${normalizeText(context.activeSceneryVisualStatus.cloudRadiusOverrideMeters.join(","), "none")}`,
    `scenery guards active: ${context.activeSceneryVisualStatus.guardsActive === true}`,
    `scenery block reason: ${normalizeText(context.activeSceneryVisualStatus.blockReason, "none")}`,
    `scenery probe active: ${context.activeSceneryProbeStatus.active === true}`,
    `scenery probe profile id: ${normalizeText(context.activeSceneryProbeStatus.profileID, "none")}`,
    `scenery probe key: ${normalizeText(context.activeSceneryProbeStatus.candidateKey, "none")}`,
    `scenery probe preset: ${normalizeText(context.activeSceneryProbeStatus.presetKey, "none")}`,
    `scenery probe entity id: ${toInt(context.activeSceneryProbeStatus.entityID, 0)}`,
    `scenery probe type id: ${toInt(context.activeSceneryProbeStatus.typeID, 0)}`,
    `scenery probe type name: ${normalizeText(context.activeSceneryProbeStatus.typeName, "none")}`,
    `scenery probe catalogue size: ${toInt(context.activeSceneryProbeStatus.catalogueSize, 0)}`,
    `scenery probe catalogue index: ${toInt(context.activeSceneryProbeStatus.catalogueIndex, 0)}/${toInt(context.activeSceneryProbeStatus.catalogueSize, 0)}`,
    `scenery probe category: ${normalizeText(context.activeSceneryProbeStatus.categoryKey, "none")}`,
    `scenery probe radius: ${Number(context.activeSceneryProbeStatus.radiusMeters) || 0}`,
    `scenery probe radius override: ${Number(context.activeSceneryProbeStatus.radiusOverrideMeters) || 0}`,
    `scenery probe notes: ${normalizeText(context.activeSceneryProbeStatus.notes, "none")}`,
    `scenery probe position: ${formatVectorForLog(context.activeSceneryProbeStatus.position)}`,
    `scenery probe previous entity id: ${toInt(context.activeSceneryProbeStatus.previousEntityID, 0)}`,
    `scenery probe addballs sent: ${context.activeSceneryProbeStatus.addBallsSent === true}`,
    `scenery probe guards active: ${context.activeSceneryProbeStatus.guardsActive === true}`,
    `scenery probe block reason: ${normalizeText(context.activeSceneryProbeStatus.blockReason, "none")}`,
    `player effects: ${normalizeText(Array.isArray(context.weatherState.playerAppliedEffectKeys) ? context.weatherState.playerAppliedEffectKeys.join(",") : "", "none")}`,
    `player unsupported: ${normalizeText(Array.isArray(context.weatherDiagnostics.playerUnsupportedEffectKeys) ? context.weatherDiagnostics.playerUnsupportedEffectKeys.join(",") : "", "none")}`,
    `playerRefreshed: ${context.weatherDiagnostics.playerRefreshed === true}`,
    `playerRefreshReason: ${normalizeText(context.weatherDiagnostics.playerRefreshReason, "unavailable")}`,
    `playerModifierSourceRegistered: ${context.weatherDiagnostics.playerModifierSourceRegistered === true}`,
    `playerAttributeSourceKey: ${normalizeText(context.weatherDiagnostics.selectedPlayerAttributeSourceKey, "unavailable")}`,
    `playerLocationSourceKey: ${normalizeText(context.weatherDiagnostics.selectedPlayerLocationSourceKey, "unavailable")}`,
    `playerCleanupExpected: ${context.weatherDiagnostics.cleanupExpected === true}`,
  ];
}

function appendPlayerMetrics(ports, context) {
  const {
    formatMetricReading,
    readEntityMetric,
    ATTRIBUTE_MAX_VELOCITY,
    ATTRIBUTE_SCAN_RESOLUTION,
    ATTRIBUTE_CAPACITOR_RECHARGE_RATE,
    ATTRIBUTE_SHIELD_CAPACITY,
    ATTRIBUTE_ARMOR_HP,
    getAttributeIDByNames,
    buildResistanceLine,
    ATTRIBUTE_SHIELD_EM_RESONANCE,
    ATTRIBUTE_SHIELD_THERMAL_RESONANCE,
    ATTRIBUTE_SHIELD_KINETIC_RESONANCE,
    ATTRIBUTE_SHIELD_EXPLOSIVE_RESONANCE,
    ATTRIBUTE_ARMOR_EM_RESONANCE,
    ATTRIBUTE_ARMOR_THERMAL_RESONANCE,
    ATTRIBUTE_ARMOR_KINETIC_RESONANCE,
    ATTRIBUTE_ARMOR_EXPLOSIVE_RESONANCE,
    ATTRIBUTE_STRUCTURE_EM_RESONANCE,
    ATTRIBUTE_STRUCTURE_THERMAL_RESONANCE,
    ATTRIBUTE_STRUCTURE_KINETIC_RESONANCE,
    ATTRIBUTE_STRUCTURE_EXPLOSIVE_RESONANCE,
    buildPlayerTurretModifierLines,
  } = ports;
  if (!context.shipEntity) {
    context.lines.push("player entity: unavailable (SHIP_ENTITY_NOT_FOUND)");
  } else {
    context.lines.push(formatMetricReading("max velocity", readEntityMetric(context.shipEntity, {
      runtimeFields: ["maxVelocity"],
      attributeID: ATTRIBUTE_MAX_VELOCITY,
    }), " m/s"));
    context.lines.push(formatMetricReading("scan resolution", readEntityMetric(context.shipEntity, {
      runtimeFields: ["scanResolution"],
      attributeID: ATTRIBUTE_SCAN_RESOLUTION,
    })));
    context.lines.push(formatMetricReading("capacitor recharge", readEntityMetric(context.shipEntity, {
      runtimeFields: ["capacitorRechargeRate"],
      attributeID: ATTRIBUTE_CAPACITOR_RECHARGE_RATE,
    })));
    context.lines.push(formatMetricReading("shield HP", readEntityMetric(context.shipEntity, {
      runtimeFields: ["shieldCapacity"],
      attributeID: ATTRIBUTE_SHIELD_CAPACITY,
    })));
    context.lines.push(formatMetricReading("armor HP", readEntityMetric(context.shipEntity, {
      runtimeFields: ["armorHP"],
      attributeID: ATTRIBUTE_ARMOR_HP,
    })));
    context.lines.push(formatMetricReading("structure HP", readEntityMetric(context.shipEntity, {
      runtimeFields: ["structureHP"],
      attributeID: getAttributeIDByNames("hp", "structureHP") || 9,
    })));
    context.lines.push(buildResistanceLine(context.shipEntity, "shield", "EM", ATTRIBUTE_SHIELD_EM_RESONANCE));
    context.lines.push(buildResistanceLine(context.shipEntity, "shield", "thermal", ATTRIBUTE_SHIELD_THERMAL_RESONANCE));
    context.lines.push(buildResistanceLine(context.shipEntity, "shield", "kinetic", ATTRIBUTE_SHIELD_KINETIC_RESONANCE));
    context.lines.push(buildResistanceLine(context.shipEntity, "shield", "explosive", ATTRIBUTE_SHIELD_EXPLOSIVE_RESONANCE));
    context.lines.push(buildResistanceLine(context.shipEntity, "armor", "EM", ATTRIBUTE_ARMOR_EM_RESONANCE));
    context.lines.push(buildResistanceLine(context.shipEntity, "armor", "thermal", ATTRIBUTE_ARMOR_THERMAL_RESONANCE));
    context.lines.push(buildResistanceLine(context.shipEntity, "armor", "kinetic", ATTRIBUTE_ARMOR_KINETIC_RESONANCE));
    context.lines.push(buildResistanceLine(context.shipEntity, "armor", "explosive", ATTRIBUTE_ARMOR_EXPLOSIVE_RESONANCE));
    context.lines.push(buildResistanceLine(context.shipEntity, "structure", "EM", ATTRIBUTE_STRUCTURE_EM_RESONANCE));
    context.lines.push(buildResistanceLine(context.shipEntity, "structure", "thermal", ATTRIBUTE_STRUCTURE_THERMAL_RESONANCE));
    context.lines.push(buildResistanceLine(context.shipEntity, "structure", "kinetic", ATTRIBUTE_STRUCTURE_KINETIC_RESONANCE));
    context.lines.push(buildResistanceLine(context.shipEntity, "structure", "explosive", ATTRIBUTE_STRUCTURE_EXPLOSIVE_RESONANCE));
    context.lines.push(...buildPlayerTurretModifierLines(context.weatherState));
  }
}

function appendNpcProfileStatus(ports, context) {
  context.lines.push(
    `npc effects: ${normalizeText(Array.isArray(context.weatherState.npcAppliedEffectKeys) ? context.weatherState.npcAppliedEffectKeys.join(",") : "", "none")}`,
  );
  context.lines.push(
    `npc unsupported: ${normalizeText(Array.isArray(context.weatherDiagnostics.npcUnsupportedEffectKeys) ? context.weatherDiagnostics.npcUnsupportedEffectKeys.join(",") : "", "none")}`,
  );
  context.lines.push(
    `room encounter archetype: ${normalizeText(context.currentNpcProfile.encounterProfileID, "unknown")} name="${normalizeText(context.currentNpcProfile.encounterName, "unknown")}" room=${toInt(context.currentNpcProfile.roomIndex, context.roomState.currentRoomIndex)} tierBand=${normalizeText(context.currentNpcProfile.tierBandID, "unknown")} tierRange=${toInt(context.currentNpcProfile && context.currentNpcProfile.tierRange && context.currentNpcProfile.tierRange.minTier, 0)}-${toInt(context.currentNpcProfile && context.currentNpcProfile.tierRange && context.currentNpcProfile.tierRange.maxTier, 0)}`,
  );
  context.lines.push(
    `room npc profile: ${normalizeText(context.currentNpcProfile.profileQuery, "unknown")} count=${toInt(context.currentNpcProfile.amount, 0)} encounter=${normalizeText(context.currentNpcProfile.encounterProfileID, "unknown")}`,
  );
  context.lines.push(
    `room npc entries: ${(
      Array.isArray(context.currentNpcProfile.npcEntries)
        ? context.currentNpcProfile.npcEntries
        : []
    ).map((entry) => (
      `${normalizeText(entry && entry.profileQuery, "unknown")} (${normalizeText(entry && entry.profileName, "unknown")}) x${Math.max(1, toInt(entry && entry.count, 1))} fallback=${entry && entry.fallbackUsed === true} reason=${normalizeText(entry && entry.fallbackReason, "none")}`
    )).join("; ") || "none"}`,
  );
  const npcProfileValidation =
    typeof ports.getAbyssalNpcProfileValidationReport === "function"
      ? ports.getAbyssalNpcProfileValidationReport(
        context.currentNpcProfile.profileQuery,
      )
      : null;
  context.lines.push(
    `npc profile validation: npcProfileID=${normalizeText(npcProfileValidation && npcProfileValidation.profileID, "unknown")} ` +
      `npcProfileName=${normalizeText(npcProfileValidation && npcProfileValidation.profileName, "unknown")} ` +
      `validationStatus=${normalizeText(npcProfileValidation && npcProfileValidation.validationStatus, "unknown")} ` +
      `fallbackUsed=${npcProfileValidation && npcProfileValidation.fallbackUsed === true} ` +
      `fallbackReason=${normalizeText(npcProfileValidation && npcProfileValidation.fallbackReason, "none")} ` +
      `weaponStyle=${normalizeText(npcProfileValidation && npcProfileValidation.weaponStyle, "unknown")}`,
  );
}

function appendRewardsRestrictions(ports, context) {
  const {
    summarizeRewardLootEntries,
    listGuaranteedRewardLootEntries,
    listContainerLootEntries,
    listCombinedContainerLootEntries,
  } = ports;
  context.lines.push(
    `room reward profile: ${normalizeText(context.currentRewardProfile && context.currentRewardProfile.rewardProfileID, "unknown")} cacheSpawned=${toInt(context.rewardState.cacheItemID, 0) > 0} cacheItemID=${toInt(context.rewardState.cacheItemID, 0)}`,
  );
  context.lines.push(
    `cache lifecycle: ${normalizeText(context.rewardState.cacheLifecycleState, "none")} opened=${normalizeText(context.rewardState.cacheLifecycleState, "") === "consumed_or_removed"} contentsGranted=${context.rewardState.contentsGranted === true}`,
  );
  context.lines.push(
    `reward loot table: ${normalizeText(context.currentRewardProfile && context.currentRewardProfile.lootTableID, "unknown")} unresolvedRefs=${Math.max(0, toInt(context.currentRewardProfile && context.currentRewardProfile.unresolvedLootReferenceCount, 0))}`,
  );
  context.lines.push(
    `expected guaranteed loot: ${summarizeRewardLootEntries(listGuaranteedRewardLootEntries(context.currentRewardProfile))}`,
  );
  context.lines.push(
    `actual cache loot: ${summarizeRewardLootEntries(listContainerLootEntries(context.rewardState.cacheItemID, context.deps))}`,
  );
  context.lines.push(
    `extraction node profile: ${normalizeText(context.currentExtractionNodeProfile && context.currentExtractionNodeProfile.extractionNodeProfileID, "none")} spawned=${listUniquePositiveInts(context.currentRoomEntry.extractionNodeItemIDs).length > 0} itemIDs=${listUniquePositiveInts(context.currentRoomEntry.extractionNodeItemIDs).join(",") || "none"}`,
  );
  context.lines.push(
    `extraction lifecycle: ${normalizeText(context.currentRoomEntry.extractionNodeLifecycleState, "none")} opened=${normalizeText(context.currentRoomEntry.extractionNodeLifecycleState, "") === "consumed_or_removed"}`,
  );
  context.lines.push(
    `extraction loot table: ${normalizeText(context.currentExtractionNodeProfile && context.currentExtractionNodeProfile.lootTableID, "none")} unresolvedRefs=${Math.max(0, toInt(context.currentExtractionNodeProfile && context.currentExtractionNodeProfile.unresolvedLootReferenceCount, 0))}`,
  );
  context.lines.push(
    `expected side loot: ${summarizeRewardLootEntries(context.currentExtractionNodeProfile && context.currentExtractionNodeProfile.guaranteedLootEntries)}`,
  );
  context.lines.push(
    `actual side loot: ${summarizeRewardLootEntries(listCombinedContainerLootEntries(context.currentRoomEntry.extractionNodeItemIDs, context.deps))}`,
  );
  context.lines.push(
    `dscan restriction: ${normalizeText(context.visibilityRestrictions.dscan && context.visibilityRestrictions.dscan.status, "unknown")} reason=${normalizeText(context.visibilityRestrictions.dscan && context.visibilityRestrictions.dscan.reason, "unknown")}`,
  );
  context.lines.push(
    `probe scan restriction: ${normalizeText(context.visibilityRestrictions.probeScan && context.visibilityRestrictions.probeScan.status, "unknown")} reason=${normalizeText(context.visibilityRestrictions.probeScan && context.visibilityRestrictions.probeScan.reason, "unknown")}`,
  );
  context.lines.push(
    `system scanner restriction: ${normalizeText(context.visibilityRestrictions.systemScanner && context.visibilityRestrictions.systemScanner.status, "unknown")} reason=${normalizeText(context.visibilityRestrictions.systemScanner && context.visibilityRestrictions.systemScanner.reason, "unknown")}`,
  );
  context.lines.push(
    `local restriction: ${normalizeText(context.visibilityRestrictions.local && context.visibilityRestrictions.local.status, "unknown")} reason=${normalizeText(context.visibilityRestrictions.local && context.visibilityRestrictions.local.reason, "unknown")}`,
  );
  context.lines.push(
    `map restriction: ${normalizeText(context.visibilityRestrictions.map && context.visibilityRestrictions.map.status, "unknown")} reason=${normalizeText(context.visibilityRestrictions.map && context.visibilityRestrictions.map.reason, "unknown")}`,
  );
}

function appendNpcEntityStatus(ports, context) {
  const {
    formatMetricReading,
    readEntityMetric,
    ATTRIBUTE_SHIELD_CAPACITY,
    ATTRIBUTE_ARMOR_HP,
    getAttributeIDByNames,
    buildResistanceLine,
    ATTRIBUTE_SHIELD_KINETIC_RESONANCE,
    ATTRIBUTE_ARMOR_KINETIC_RESONANCE,
    ATTRIBUTE_STRUCTURE_KINETIC_RESONANCE,
    ATTRIBUTE_SHIELD_THERMAL_RESONANCE,
    ATTRIBUTE_ARMOR_THERMAL_RESONANCE,
    ATTRIBUTE_STRUCTURE_THERMAL_RESONANCE,
    ATTRIBUTE_SHIELD_EM_RESONANCE,
    ATTRIBUTE_ARMOR_EM_RESONANCE,
    ATTRIBUTE_STRUCTURE_EM_RESONANCE,
  } = ports;
  if (context.npcEntities.length <= 0) {
    context.lines.push("current room NPCs: none");
  } else {
    for (const npcEntry of context.npcEntities) {
      const entity = npcEntry.entity;
      if (!entity) {
        context.lines.push(`npc ${npcEntry.hostileEntityID}: unavailable (ENTITY_NOT_FOUND)`);
        continue;
      }
      const runtimePolicy = entity.evejsAbyssalNpcRuntimePolicy || {};
      context.lines.push(
        `npc ${npcEntry.hostileEntityID}: room=${toInt(entity.evejsAbyssalRoomIndex, 0)} profile=${normalizeText(entity.evejsAbyssalNpcProfileQuery, normalizeText(context.currentNpcProfile.profileQuery, "unknown"))} (${normalizeText(entity.evejsAbyssalNpcProfileName, "unknown")}) noWreck=${runtimePolicy.suppressWreck === true} noBounty=${runtimePolicy.suppressBounty === true} weather=${normalizeText(entity.evejsAbyssalWeatherType, "unknown")} strengthPct=${toInt(entity.evejsAbyssalWeatherStrengthPercent, 0)}`,
      );
      context.lines.push(formatMetricReading(`npc ${npcEntry.hostileEntityID} shield HP`, readEntityMetric(entity, {
        runtimeFields: ["shieldCapacity"],
        attributeID: ATTRIBUTE_SHIELD_CAPACITY,
      })));
      context.lines.push(formatMetricReading(`npc ${npcEntry.hostileEntityID} armor HP`, readEntityMetric(entity, {
        runtimeFields: ["armorHP"],
        attributeID: ATTRIBUTE_ARMOR_HP,
      })));
      context.lines.push(formatMetricReading(`npc ${npcEntry.hostileEntityID} structure HP`, readEntityMetric(entity, {
        runtimeFields: ["structureHP"],
        attributeID: getAttributeIDByNames("hp", "structureHP") || 9,
      })));
      context.lines.push(buildResistanceLine(entity, `npc ${npcEntry.hostileEntityID} shield`, "kinetic", ATTRIBUTE_SHIELD_KINETIC_RESONANCE));
      context.lines.push(buildResistanceLine(entity, `npc ${npcEntry.hostileEntityID} armor`, "kinetic", ATTRIBUTE_ARMOR_KINETIC_RESONANCE));
      context.lines.push(buildResistanceLine(entity, `npc ${npcEntry.hostileEntityID} structure`, "kinetic", ATTRIBUTE_STRUCTURE_KINETIC_RESONANCE));
      context.lines.push(buildResistanceLine(entity, `npc ${npcEntry.hostileEntityID} shield`, "thermal", ATTRIBUTE_SHIELD_THERMAL_RESONANCE));
      context.lines.push(buildResistanceLine(entity, `npc ${npcEntry.hostileEntityID} armor`, "thermal", ATTRIBUTE_ARMOR_THERMAL_RESONANCE));
      context.lines.push(buildResistanceLine(entity, `npc ${npcEntry.hostileEntityID} structure`, "thermal", ATTRIBUTE_STRUCTURE_THERMAL_RESONANCE));
      context.lines.push(buildResistanceLine(entity, `npc ${npcEntry.hostileEntityID} shield`, "EM", ATTRIBUTE_SHIELD_EM_RESONANCE));
      context.lines.push(buildResistanceLine(entity, `npc ${npcEntry.hostileEntityID} armor`, "EM", ATTRIBUTE_ARMOR_EM_RESONANCE));
      context.lines.push(buildResistanceLine(entity, `npc ${npcEntry.hostileEntityID} structure`, "EM", ATTRIBUTE_STRUCTURE_EM_RESONANCE));
    }
  }
}

function finishActiveStatusReport(ports, context) {
  const {
    cloneValue,
  } = ports;
  return {
    activeRun: true,
    lines: context.lines,
    text: context.lines.join("<br>"),
    snapshot: {
      instanceID: toInt(context.pocketState.instanceID, 0),
      filamentTypeID: toInt(context.contentProfile.filamentTypeID, 0),
      filamentName: normalizeText(context.contentProfile.filamentName, ""),
      definitionID: normalizeText(context.contentProfile.definitionID, ""),
      weatherType: normalizeText(context.weatherState.weatherType, ""),
      weatherName: normalizeText(context.weatherState.weatherName, ""),
      strengthPercent: toInt(context.weatherState.strengthPercent, 0),
      roomIndex: toInt(context.roomState.currentRoomIndex, 1),
      roomCount: toInt(context.roomState.implementedRooms, 1),
      runOutcome: normalizeText(context.pocketState.runOutcome, "active"),
      contentCompleteness: cloneValue(context.contentCompletenessReport),
    },
  };
}

function buildActiveStatusReport(ports, context) {
  context.lines = [
    ...buildRunIdentityLines(ports, context),
    ...buildLayoutEntityLines(ports, context),
    ...buildSuppressorLines(ports, context),
    ...buildClientTrackingLines(ports, context),
    ...buildTransitionVisualLines(ports, context),
    ...buildSceneryWeatherLines(ports, context),
  ];
  appendPlayerMetrics(ports, context);
  appendNpcProfileStatus(ports, context);
  appendRewardsRestrictions(ports, context);
  appendNpcEntityStatus(ports, context);
  return finishActiveStatusReport(ports, context);
}

module.exports = { buildActiveStatusReport };
