"use strict";

const { toInt, normalizeText, listUniquePositiveInts } = require("../domain/abyssalRuntimeValues");

function buildRoomNpcProfileFromEncounterProfile(ports, encounterProfile = null, resolvedRoomIndex = 1) {
  const {
    cloneValue,
    cloneRuntimeRewardProfileOverride,
    summarizeAbyssalTier1ResolvedEntries,
  } = ports;
  const npcEntries = Array.isArray(encounterProfile && encounterProfile.npcEntries)
    ? cloneValue(encounterProfile.npcEntries)
    : [];
  const primaryNpcEntry = npcEntries[0] || null;
  const rewardMultiplier = Number(encounterProfile && encounterProfile.rewardMultiplier);
  const roomNpcProfile = {
    roomIndex: resolvedRoomIndex,
    encounterProfileID: normalizeText(encounterProfile && encounterProfile.encounterProfileID, ""),
    encounterName: normalizeText(encounterProfile && encounterProfile.encounterName, ""),
    encounterTheme: normalizeText(encounterProfile && encounterProfile.encounterTheme, ""),
    factionTheme: normalizeText(encounterProfile && encounterProfile.factionTheme, "mixed"),
    weatherTheme: normalizeText(encounterProfile && encounterProfile.weatherTheme, ""),
    tierBandID: normalizeText(encounterProfile && encounterProfile.tierBandID, "low"),
    tierBandLabel: normalizeText(encounterProfile && encounterProfile.tierBandLabel, "Low"),
    tierRange: cloneValue(encounterProfile && encounterProfile.tierRange) || { minTier: 1, maxTier: 1 },
    objectiveType: normalizeText(encounterProfile && encounterProfile.objectiveType, "kill_objective_hostiles"),
    npcEntries,
    rewardMultiplier: Number.isFinite(rewardMultiplier) && rewardMultiplier > 0 ? rewardMultiplier : 1,
    rewardQuantityBonus: toInt(encounterProfile && encounterProfile.rewardQuantityBonus, 0),
    rewardProfileOverride:
      encounterProfile &&
        encounterProfile.rewardProfileOverride &&
        typeof encounterProfile.rewardProfileOverride === "object"
        ? cloneRuntimeRewardProfileOverride(encounterProfile.rewardProfileOverride)
        : null,
    cacheProfileOverride:
      encounterProfile &&
        encounterProfile.cacheProfileOverride &&
        typeof encounterProfile.cacheProfileOverride === "object"
        ? cloneValue(encounterProfile.cacheProfileOverride)
        : null,
    observedObjectEntries:
      encounterProfile && Array.isArray(encounterProfile.observedObjectEntries)
        ? cloneValue(encounterProfile.observedObjectEntries)
        : [],
    sourceModelID: normalizeText(encounterProfile && encounterProfile.sourceModelID, ""),
    sourceVariantID: normalizeText(encounterProfile && encounterProfile.sourceVariantID, ""),
    sourceSpawnID: normalizeText(encounterProfile && encounterProfile.sourceSpawnID, ""),
    sourceSpawnFamily: normalizeText(encounterProfile && encounterProfile.sourceSpawnFamily, ""),
    sourceObservationCount: Math.max(
      0,
      toInt(encounterProfile && encounterProfile.sourceObservationCount, 0),
    ),
    sourceEvidenceAuthority: normalizeText(
      encounterProfile && encounterProfile.sourceEvidenceAuthority,
      "",
    ),
    encounterAuthority:
      encounterProfile && encounterProfile.encounterAuthority &&
        typeof encounterProfile.encounterAuthority === "object"
        ? cloneValue(encounterProfile.encounterAuthority)
        : {
          schemaVersion: 1,
          tier: toInt(encounterProfile && encounterProfile.tier, -1),
          roomIndex: resolvedRoomIndex,
          weatherType: normalizeText(
            encounterProfile && encounterProfile.weatherTheme,
            "",
          ),
          eligibleRoomIndexes: listUniquePositiveInts(
            encounterProfile && encounterProfile.eligibleRoomIndexes,
          ),
          eligibleWeatherTypes:
            encounterProfile && Array.isArray(encounterProfile.eligibleWeatherTypes)
              ? encounterProfile.eligibleWeatherTypes
                .map((entry) => normalizeText(entry, ""))
                .filter(Boolean)
              : [],
          contentAuthority: normalizeText(
            encounterProfile && encounterProfile.contentAuthority,
            "",
          ),
          observedSpawnProfile:
            encounterProfile && encounterProfile.observedSpawnProfile === true,
          qsnaSpawnProfile:
            encounterProfile && encounterProfile.qsnaSpawnProfile === true,
          enabled: encounterProfile && encounterProfile.enabled !== false,
          fallbackUsed: encounterProfile && encounterProfile.fallbackUsed === true,
        },
    extractionNodeProfileOverride:
      encounterProfile &&
        encounterProfile.extractionNodeProfileOverride &&
        typeof encounterProfile.extractionNodeProfileOverride === "object"
        ? cloneValue(encounterProfile.extractionNodeProfileOverride)
        : null,
    combatBudget: encounterProfile && encounterProfile.combatBudget && typeof encounterProfile.combatBudget === "object"
      ? cloneValue(encounterProfile.combatBudget)
      : null,
    runtimeKind: normalizeText(primaryNpcEntry && primaryNpcEntry.runtimeKind, "nativeCombat"),
    profileQuery: normalizeText(primaryNpcEntry && primaryNpcEntry.profileQuery, "parity_guristas_missile_frigate"),
    profileName: normalizeText(primaryNpcEntry && primaryNpcEntry.profileName, ""),
    requestedProfileQuery: normalizeText(primaryNpcEntry && primaryNpcEntry.requestedProfileQuery, ""),
    fallbackUsed: primaryNpcEntry && primaryNpcEntry.fallbackUsed === true,
    fallbackReason: normalizeText(primaryNpcEntry && primaryNpcEntry.fallbackReason, ""),
    weaponStyle: normalizeText(primaryNpcEntry && primaryNpcEntry.weaponStyle, ""),
    amount: npcEntries.reduce((total, entry) => total + Math.max(0, toInt(entry && entry.count, 0)), 0),
    objectiveCount: npcEntries
      .filter((entry) => entry.objectiveRelevant !== false)
      .reduce((total, entry) => total + Math.max(0, toInt(entry && entry.count, 0)), 0),
    spawnRadiusMeters: Math.max(5_000, toInt(encounterProfile && encounterProfile.spawnRadiusMeters, 10_000)),
    spawnJitterMeters: Math.max(0, toInt(encounterProfile && encounterProfile.spawnJitterMeters, 0)),
    spawnOffsetMeters: Math.max(5_000, toInt(encounterProfile && encounterProfile.spawnRadiusMeters, 10_000)),
    objectiveRole: "kill_all_hostiles",
    spawnReference: "encounter_anchor",
    spawnDistanceMode: "formation",
  };
  const encounterSummary = summarizeAbyssalTier1ResolvedEntries(npcEntries);
  roomNpcProfile.encounterDroneCount = toInt(encounterProfile && encounterProfile.encounterDroneCount, encounterSummary.droneCount);
  roomNpcProfile.encounterShipCount = toInt(encounterProfile && encounterProfile.encounterShipCount, encounterSummary.shipCount);
  roomNpcProfile.encounterEscortTypeID = toInt(encounterProfile && encounterProfile.encounterEscortTypeID, encounterSummary.escortTypeID);
  return roomNpcProfile;
}

function buildCapturedT0DarkRoomNpcProfile(ports, pocketState, roomIndex) {
  const {
    getCapturedT0DarkRoom,
    EVIDENCE_STATUS_CAPTURED_RETAIL,
    CAPTURED_T0_DARK_NPC_PROFILE_BY_TYPE_ID,
    cloneValue,
    CAPTURED_T0_DARK_NPC_COMBAT_BY_TYPE_ID,
    T0_DARK_RETAIL_CAPTURED_PROFILE_ID,
  } = ports;
  const capturedRoom = getCapturedT0DarkRoom(pocketState, roomIndex);
  if (
    !capturedRoom ||
    normalizeText(capturedRoom.evidenceStatus, "") !== EVIDENCE_STATUS_CAPTURED_RETAIL
  ) return null;
  const npcEntries = [];
  for (const [index, capturedNpc] of capturedRoom.npcEntries.entries()) {
    const requestedProfileID =
      CAPTURED_T0_DARK_NPC_PROFILE_BY_TYPE_ID[toInt(capturedNpc.typeID, 0)] || "";
    const report = requestedProfileID &&
      typeof ports.getAbyssalNpcProfileValidationReport === "function"
      ? ports.getAbyssalNpcProfileValidationReport(requestedProfileID)
      : null;
    if (
      !report ||
      report.fallbackUsed === true ||
      toInt(report.typeID, 0) !== toInt(capturedNpc.typeID, 0)
    ) {
      return {
        errorMsg:
          `CAPTURED_T0_DARK_NPC_PROFILE_UNAVAILABLE room=${roomIndex} typeID=${capturedNpc.typeID}`,
      };
    }
    npcEntries.push({
      npcEntryID: `captured_room_${roomIndex}_npc_${index + 1}_type_${capturedNpc.typeID}`,
      runtimeKind: "nativeCombat",
      npcProfileKey: report.profileID,
      profileQuery: report.profileID,
      profileName: report.profileName,
      typeID: toInt(capturedNpc.typeID, 0),
      displayName: capturedNpc.name,
      groupID: toInt(capturedNpc.groupID, 0),
      factionID: toInt(report.factionID, 0),
      requestedProfileQuery: requestedProfileID,
      fallbackUsed: false,
      fallbackReason: "",
      weaponStyle: normalizeText(report.weaponStyle, ""),
      capabilities: Array.isArray(report.capabilities)
        ? cloneValue(report.capabilities)
        : [],
      role: "captured_objective_hostile",
      minimumCount: 1,
      maximumCount: 1,
      count: 1,
      resolvedCount: 1,
      required: true,
      objectiveRelevant: true,
      objectiveRole: "kill_all_hostiles",
      spawnRadiusMeters: 0,
      spawnOffsetMeters: 0,
      spawnReference: "captured_room_origin",
      spawnDistanceMode: "captured_exact_transform",
      capturedRoomRelativePosition: cloneValue(capturedNpc.position),
      capturedRetailRotation: cloneValue(capturedNpc.rotation),
      capturedRetailBallID: normalizeText(capturedNpc.retailBallID, ""),
      capturedRetailOwnerID: toInt(capturedNpc.presentationOwnerID, toInt(capturedNpc.ownerID, 0)),
      capturedRetailIdentity: cloneValue(capturedNpc.identity),
      capturedRetailCombat: cloneValue(
        CAPTURED_T0_DARK_NPC_COMBAT_BY_TYPE_ID[toInt(capturedNpc.typeID, 0)] || null,
      ),
      capturedRetailObject: true,
    });
  }
  const npcProfile = buildRoomNpcProfileFromEncounterProfile(ports, {
    encounterProfileID:
      `${T0_DARK_RETAIL_CAPTURED_PROFILE_ID}:room-${roomIndex}:encounter`,
    encounterName: `Captured Tranquil Dark Room ${roomIndex}`,
    encounterTheme: "captured_tier0_dark",
    factionTheme: "captured_mixed",
    weatherTheme: "dark",
    tierBandID: "tranquil",
    tierBandLabel: "Tranquil",
    tierRange: { minTier: 0, maxTier: 0 },
    objectiveType: "kill_objective_hostiles",
    npcEntries,
    rewardMultiplier: 1,
    rewardQuantityBonus: 0,
    spawnRadiusMeters: 0,
    spawnJitterMeters: 0,
    encounterDroneCount: npcEntries.filter((entry) => entry.groupID === 1997).length,
    encounterShipCount: npcEntries.filter((entry) => entry.groupID === 1982).length,
    encounterEscortTypeID: 0,
  }, roomIndex);
  npcProfile.selectionState = {
    encounterProfileID: npcProfile.encounterProfileID,
    encounterName: npcProfile.encounterName,
    encounterTheme: npcProfile.encounterTheme,
    encounterFactionTheme: npcProfile.factionTheme,
    encounterWeatherTheme: npcProfile.weatherTheme,
    resolvedNpcEntries: cloneValue(npcEntries),
    objectiveTotal: npcEntries.length,
    encounterDroneCount: npcProfile.encounterDroneCount,
    encounterShipCount: npcProfile.encounterShipCount,
    encounterEscortTypeID: 0,
    rewardMultiplier: 1,
    rewardQuantityBonus: 0,
    combatBudget: null,
    spawnRadiusMeters: 0,
    spawnJitterMeters: 0,
    capturedRetailProfile: true,
  };
  return npcProfile;
}

function shouldUseTier0AbyssalSpaceEmpiricalContent(ports, contentProfile = null) {
  return ports.shouldUseTier0AbyssalSpaceEmpiricalContent(contentProfile);
}

function shouldUseCorrelatedAbyssalSpaceEmpiricalContent(ports, contentProfile = null) {
  const profile = contentProfile || {};
  const tier = toInt(profile.tier, -1);
  return Boolean(
    (
      typeof ports.shouldUseCorrelatedAbyssalSpaceEmpiricalContent === "function" &&
      ports.shouldUseCorrelatedAbyssalSpaceEmpiricalContent(profile)
    ) ||
    (tier === 0 && profile.tier0AbyssalSpaceTelemetryEnabled === true) ||
    (tier === 1 && profile.tier1AbyssalSpaceTelemetryEnabled === true) ||
    (tier === 2 && profile.tier2AbyssalSpaceTelemetryEnabled === true) ||
    (tier === 3 && profile.tier3AbyssalSpaceTelemetryEnabled === true) ||
    (tier === 4 && profile.tier4AbyssalSpaceTelemetryEnabled === true) ||
    (tier === 5 && profile.tier5AbyssalSpaceTelemetryEnabled === true) ||
    (tier === 6 && profile.tier6AbyssalSpaceTelemetryEnabled === true) ||
    normalizeText(
      profile.authoredContentSelection &&
        profile.authoredContentSelection.selectionMode,
      "",
    ) === "observed_empirical"
  );
}

function resolveRoomNpcProfileForSpawn(ports, pocketState, roomIndex = null, deps = ports.getDependencies(), options = {}) {
  const {
    buildPlaceholderRoomState,
    clampRoomIndex,
    getContentProfile,
    getPlaceholderRoomEntry,
    resolveRoomEncounterProfile,
  } = ports;
  const roomState = buildPlaceholderRoomState(pocketState);
  const resolvedRoomIndex = clampRoomIndex(
    roomIndex == null ? roomState.currentRoomIndex : roomIndex,
    roomState.implementedRooms,
  );
  const contentProfile = getContentProfile(pocketState) || {};
  const {
    tier0AbyssalSpaceTelemetryEnabled,
    tier1AbyssalSpaceTelemetryEnabled,
    tier2AbyssalSpaceTelemetryEnabled,
    tier3AbyssalSpaceTelemetryEnabled,
    tier4AbyssalSpaceTelemetryEnabled,
    tier5AbyssalSpaceTelemetryEnabled,
    tier6AbyssalSpaceTelemetryEnabled,
    useCorrelatedAbyssalSpaceTelemetry,
  } = buildNpcTelemetryFlags(ports, contentProfile);
  const capturedNpcProfile = useCorrelatedAbyssalSpaceTelemetry
    ? null
    : buildCapturedT0DarkRoomNpcProfile(ports,
      pocketState,
      resolvedRoomIndex,
    );
  if (capturedNpcProfile) {
    return capturedNpcProfile;
  }
  const roomEntry = getPlaceholderRoomEntry(pocketState, resolvedRoomIndex);
  if (
    normalizeText(roomEntry && roomEntry.encounterProfileID, "") &&
    Array.isArray(roomEntry && roomEntry.resolvedNpcEntries) &&
    roomEntry.resolvedNpcEntries.length > 0
  ) {
    return buildSavedRoomNpcProfile(ports, roomEntry, resolvedRoomIndex);
  }
  if (
    !useCorrelatedAbyssalSpaceTelemetry &&
    normalizeText(contentProfile.authoredCaptureID, "")
  ) {
    let authoredEncounterProfile;
    try {
      authoredEncounterProfile = resolveRoomEncounterProfile(
        pocketState,
        resolvedRoomIndex,
        options,
      );
    } catch (error) {
      return {
        errorMsg: normalizeText(
          error && error.message,
          "ABYSSAL_ROOM_ENCOUNTER_PROFILE_MISSING",
        ),
      };
    }
    if (normalizeText(authoredEncounterProfile && authoredEncounterProfile.authoredRoomID, "")) {
      return buildRoomNpcProfileFromEncounterProfile(ports,
        authoredEncounterProfile,
        resolvedRoomIndex,
      );
    }
  }
  const context = {
    tier: toInt(contentProfile.tier, 0),
    roomIndex: resolvedRoomIndex,
    weatherType: normalizeText(contentProfile.weatherType, ""),
    tier0AbyssalSpaceTelemetryEnabled,
    tier1AbyssalSpaceTelemetryEnabled,
    tier2AbyssalSpaceTelemetryEnabled,
    tier3AbyssalSpaceTelemetryEnabled,
    tier4AbyssalSpaceTelemetryEnabled,
    tier5AbyssalSpaceTelemetryEnabled,
    tier6AbyssalSpaceTelemetryEnabled,
  };
  const selection = selectRoomNpcEncounter(ports, pocketState, contentProfile, context, resolvedRoomIndex, useCorrelatedAbyssalSpaceTelemetry, deps);
  if (selection.errorMsg) return selection;
  const selectedProfile = selection.selectedProfile;
  if (!selectedProfile) {
    return resolveMissingRoomNpcEncounter(ports, context, pocketState, resolvedRoomIndex, options);
  }
  return finishSelectedRoomNpcProfile(ports, selectedProfile, context, resolvedRoomIndex, useCorrelatedAbyssalSpaceTelemetry, options, deps);
}

function hasPrewarmedAbyssalEncounter(ports, roomEntry = null) {
  return Boolean(
    roomEntry &&
    (
      toInt(roomEntry.prewarmedAtMs, 0) > 0 ||
      listUniquePositiveInts(roomEntry.hostileEntityIDs).length > 0 ||
      (
        normalizeText(roomEntry.encounterProfileID, "") &&
        Array.isArray(roomEntry.resolvedNpcEntries) &&
        roomEntry.resolvedNpcEntries.length > 0
      )
    )
  );
}

function getAuthoredRoomEncounterProfile(ports, pocketState, roomIndex = null) {
  const {
    buildPlaceholderRoomState,
    clampRoomIndex,
    getRoomEncounterProfilesByIndex,
  } = ports;
  const roomState = buildPlaceholderRoomState(pocketState);
  const resolvedRoomIndex = clampRoomIndex(
    roomIndex == null ? roomState.currentRoomIndex : roomIndex,
    roomState.implementedRooms,
  );
  const authoredProfilesByIndex = getRoomEncounterProfilesByIndex(pocketState);
  return authoredProfilesByIndex[String(resolvedRoomIndex)] ||
    authoredProfilesByIndex[resolvedRoomIndex] ||
    null;
}

function buildNpcTelemetryFlags(ports, contentProfile) {
  const {
    isProceduralAbyssalContent,
  } = ports;
  const tier0AbyssalSpaceTelemetryEnabled =
    shouldUseTier0AbyssalSpaceEmpiricalContent(ports, contentProfile);
  const tier1AbyssalSpaceTelemetryEnabled =
    typeof ports.shouldUseTier1AbyssalSpaceEmpiricalContent ===
      "function" &&
    ports.shouldUseTier1AbyssalSpaceEmpiricalContent(
      contentProfile,
    );
  const tier2AbyssalSpaceTelemetryEnabled =
    typeof ports.shouldUseTier2AbyssalSpaceEmpiricalContent ===
      "function" &&
    ports.shouldUseTier2AbyssalSpaceEmpiricalContent(
      contentProfile,
    );
  const tier3AbyssalSpaceTelemetryEnabled =
    typeof ports.shouldUseTier3AbyssalSpaceEmpiricalContent ===
      "function" &&
    ports.shouldUseTier3AbyssalSpaceEmpiricalContent(
      contentProfile,
    );
  const tier4AbyssalSpaceTelemetryEnabled =
    typeof ports.shouldUseTier4AbyssalSpaceEmpiricalContent ===
      "function" &&
    ports.shouldUseTier4AbyssalSpaceEmpiricalContent(
      contentProfile,
    );
  const tier5AbyssalSpaceTelemetryEnabled =
    typeof ports.shouldUseTier5AbyssalSpaceEmpiricalContent ===
      "function" &&
    ports.shouldUseTier5AbyssalSpaceEmpiricalContent(
      contentProfile,
    );
  const tier6AbyssalSpaceTelemetryEnabled =
    typeof ports.shouldUseTier6AbyssalSpaceEmpiricalContent ===
      "function" &&
    ports.shouldUseTier6AbyssalSpaceEmpiricalContent(
      contentProfile,
    );
  const useCorrelatedAbyssalSpaceTelemetry =
    isProceduralAbyssalContent(contentProfile) || tier0AbyssalSpaceTelemetryEnabled || tier1AbyssalSpaceTelemetryEnabled ||
      tier2AbyssalSpaceTelemetryEnabled || tier3AbyssalSpaceTelemetryEnabled ||
      tier4AbyssalSpaceTelemetryEnabled || tier5AbyssalSpaceTelemetryEnabled ||
      tier6AbyssalSpaceTelemetryEnabled;
  return {
    tier0AbyssalSpaceTelemetryEnabled,
    tier1AbyssalSpaceTelemetryEnabled,
    tier2AbyssalSpaceTelemetryEnabled,
    tier3AbyssalSpaceTelemetryEnabled,
    tier4AbyssalSpaceTelemetryEnabled,
    tier5AbyssalSpaceTelemetryEnabled,
    tier6AbyssalSpaceTelemetryEnabled,
    useCorrelatedAbyssalSpaceTelemetry,
  };
}

function buildSavedRoomNpcProfile(ports, roomEntry, resolvedRoomIndex) {
  const {
    cloneRuntimeRewardProfileOverride,
    cloneValue,
  } = ports;
    return buildRoomNpcProfileFromEncounterProfile(ports, {
      encounterProfileID: roomEntry.encounterProfileID,
      encounterName: roomEntry.encounterName,
      encounterTheme: roomEntry.encounterTheme,
      factionTheme: roomEntry.encounterFactionTheme,
      weatherTheme: roomEntry.encounterWeatherTheme,
      objectiveType: "kill_objective_hostiles",
      npcEntries: roomEntry.resolvedNpcEntries,
      spawnRadiusMeters: roomEntry.spawnRadiusMeters,
      spawnJitterMeters: roomEntry.spawnJitterMeters,
      rewardMultiplier: roomEntry.rewardMultiplier,
      rewardQuantityBonus: roomEntry.rewardQuantityBonus,
      rewardProfileOverride: cloneRuntimeRewardProfileOverride(
        roomEntry.rewardProfileOverride,
      ),
      cacheProfileOverride: cloneValue(roomEntry.cacheProfileOverride),
      observedObjectEntries: cloneValue(roomEntry.observedObjectEntries) || [],
      sourceModelID: roomEntry.sourceModelID,
      sourceVariantID: roomEntry.sourceVariantID,
      sourceSpawnID: roomEntry.sourceSpawnID,
      sourceSpawnFamily: roomEntry.sourceSpawnFamily,
      sourceObservationCount: roomEntry.sourceObservationCount,
      sourceEvidenceAuthority: roomEntry.sourceEvidenceAuthority,
      encounterAuthority: cloneValue(roomEntry.encounterAuthority),
      combatBudget: roomEntry.combatBudget && typeof roomEntry.combatBudget === "object"
        ? cloneValue(roomEntry.combatBudget)
        : null,
      encounterDroneCount: roomEntry.encounterDroneCount,
      encounterShipCount: roomEntry.encounterShipCount,
      encounterEscortTypeID: roomEntry.encounterEscortTypeID,
    }, resolvedRoomIndex);
  }

function selectRoomNpcEncounter(ports, pocketState, contentProfile, context, resolvedRoomIndex, useCorrelatedAbyssalSpaceTelemetry, deps) {
  const {
    isProceduralAbyssalContent,
    cloneValue,
    selectWeightedAbyssalTier1EncounterProfile,
  } = ports;
  let selectedProfile = null;
  if (isProceduralAbyssalContent(contentProfile) &&
      typeof ports.selectObservedAbyssalEncounterProfile !== "function") {
    return { errorMsg: "ABYSSAL_OBSERVED_NPC_SPAWN_UNAVAILABLE: selector missing" };
  }
  if (
    (
      useCorrelatedAbyssalSpaceTelemetry ||
      contentProfile.observedNpcSpawnSelectionEnabled === true
    ) &&
    typeof ports.selectObservedAbyssalEncounterProfile ===
      "function"
  ) {
    const observedSelection =
      ports.selectObservedAbyssalEncounterProfile({
        tier: context.tier,
        weatherType: context.weatherType,
        roomIndex: resolvedRoomIndex,
        selectionSeed:
          `${normalizeText(
            contentProfile.observedNpcSpawnSelectionSeed,
            toInt(pocketState && pocketState.traceItemID, 0),
          )}:` +
          `${toInt(pocketState && pocketState.instanceID, 0)}:` +
          `${resolvedRoomIndex}`,
      });
    if (!observedSelection || observedSelection.success !== true) {
      return {
        errorMsg:
          "ABYSSAL_OBSERVED_NPC_SPAWN_UNAVAILABLE " +
          `tier=${context.tier} room=${resolvedRoomIndex} ` +
          `weather=${context.weatherType} reason=${normalizeText(
            observedSelection && observedSelection.errorMsg,
            "OBSERVED_ABYSSAL_ENCOUNTER_CONTEXT_UNAVAILABLE",
          )} details=${JSON.stringify({
            unavailableVariantCount: toInt(
              observedSelection &&
                observedSelection.unavailableVariantCount,
              0,
            ),
            unavailableReasons:
              observedSelection &&
              Array.isArray(observedSelection.unavailableReasons)
                ? observedSelection.unavailableReasons
                : [],
          })}`,
      };
    }
    selectedProfile = cloneValue(observedSelection.profile);
  } else {
    selectedProfile = selectWeightedAbyssalTier1EncounterProfile(
      context,
      deps,
    );
  }
  return { selectedProfile };
}

function resolveMissingRoomNpcEncounter(ports, context, pocketState, resolvedRoomIndex, options) {
  const {
    resolveRoomNpcProfile,
  } = ports;
    const requiredTheme = normalizeText(
      context.tier === 0
        ? ports.ABYSSAL_TIER0_COMBINED_ENCOUNTER_THEME
        : context.tier === 1
          ? ports.ABYSSAL_TIER1_COMBINED_ENCOUNTER_THEME
          : context.tier === 2
            ? ports.ABYSSAL_TIER2_COMBINED_ENCOUNTER_THEME
            : context.tier === 3
              ? ports.ABYSSAL_TIER3_COMBINED_ENCOUNTER_THEME
              : context.tier === 4
                ? ports.ABYSSAL_TIER4_COMBINED_ENCOUNTER_THEME
                : context.tier === 5
                  ? ports.ABYSSAL_TIER5_COMBINED_ENCOUNTER_THEME
                  : ports.ABYSSAL_TIER6_COMBINED_ENCOUNTER_THEME,
      "abyssal_mixed_triglavian_drone",
    );
    if ((context.tier >= 0 && context.tier <= 6) && context.weatherType) {
      const unavailableCode = context.tier === 0
        ? "ABYSSAL_TIER0_ENCOUNTER_PROFILE_UNAVAILABLE"
        : context.tier === 1
          ? "ABYSSAL_TIER1_ENCOUNTER_PROFILE_UNAVAILABLE"
          : `ABYSSAL_TIER${context.tier}_ENCOUNTER_PROFILE_UNAVAILABLE`;
      return {
        errorMsg: `${unavailableCode} tier=${context.tier} room=${resolvedRoomIndex} weather=${context.weatherType} theme=${requiredTheme}`,
      };
    }
    try {
      return resolveRoomNpcProfile(pocketState, resolvedRoomIndex, options);
    } catch (error) {
      return {
        errorMsg: normalizeText(
          error && error.message,
          "ABYSSAL_ROOM_ENCOUNTER_PROFILE_MISSING",
        ),
      };
    }
  }

function finishSelectedRoomNpcProfile(ports, selectedProfile, context, resolvedRoomIndex, useCorrelatedAbyssalSpaceTelemetry, options, deps) {
  const {
    resolveAbyssalTier1EncounterNpcEntries,
    materializeSelectedAbyssalEncounterProfile,
    log,
    cloneValue,
  } = ports;
  const resolvedEntriesResult = resolveAbyssalTier1EncounterNpcEntries(selectedProfile, deps);
  if (!resolvedEntriesResult.success) {
    return {
      errorMsg: resolvedEntriesResult.errorMsg,
    };
  }
  const resolvedEncounterProfile = {
    ...materializeSelectedAbyssalEncounterProfile(selectedProfile),
    weatherTheme: context.weatherType,
    tierBandID: "low",
    tierBandLabel: "Low",
    tierRange: {
      minTier: context.tier,
      maxTier: context.tier,
    },
    npcEntries: resolvedEntriesResult.data.resolvedEntries,
  };
  const npcProfile = buildRoomNpcProfileFromEncounterProfile(ports, resolvedEncounterProfile, resolvedRoomIndex);
  if (
    (context.tier >= 2 && context.tier <= 6) ||
    useCorrelatedAbyssalSpaceTelemetry
  ) {
    log.info(
      `[AbyssalMgr] Tier encounter selected tier=${context.tier} theme=${npcProfile.encounterTheme} ` +
        `room=${resolvedRoomIndex} weather=${context.weatherType} profile=${npcProfile.encounterProfileID} ` +
        `sourceSpawn=${normalizeText(npcProfile.sourceSpawnID, "none")} ` +
        `npcCount=${npcProfile.amount} droneCount=${npcProfile.encounterDroneCount} ` +
        `shipCount=${npcProfile.encounterShipCount} objectiveCount=${npcProfile.objectiveCount} ` +
        `prewarmed=${options.prewarmed === true}`,
    );
  }
  npcProfile.selectionState = {
    encounterProfileID: npcProfile.encounterProfileID,
    encounterName: npcProfile.encounterName,
    encounterTheme: npcProfile.encounterTheme,
    encounterFactionTheme: npcProfile.factionTheme,
    encounterWeatherTheme: npcProfile.weatherTheme,
    resolvedNpcEntries: cloneValue(npcProfile.npcEntries),
    objectiveTotal: toInt(npcProfile.objectiveCount, 0),
    encounterDroneCount: toInt(npcProfile.encounterDroneCount, 0),
    encounterShipCount: toInt(npcProfile.encounterShipCount, 0),
    encounterEscortTypeID: toInt(npcProfile.encounterEscortTypeID, 0),
    rewardMultiplier: npcProfile.rewardMultiplier,
    rewardQuantityBonus: npcProfile.rewardQuantityBonus,
    rewardProfileOverride: cloneValue(npcProfile.rewardProfileOverride),
    cacheProfileOverride: cloneValue(npcProfile.cacheProfileOverride),
    observedObjectEntries: cloneValue(npcProfile.observedObjectEntries) || [],
    sourceModelID: npcProfile.sourceModelID,
    sourceVariantID: npcProfile.sourceVariantID,
    sourceSpawnID: npcProfile.sourceSpawnID,
    sourceSpawnFamily: npcProfile.sourceSpawnFamily,
    sourceObservationCount: npcProfile.sourceObservationCount,
    sourceEvidenceAuthority: npcProfile.sourceEvidenceAuthority,
    encounterAuthority: cloneValue(npcProfile.encounterAuthority),
    combatBudget: cloneValue(npcProfile.combatBudget),
    spawnRadiusMeters: npcProfile.spawnRadiusMeters,
    spawnJitterMeters: npcProfile.spawnJitterMeters,
    prewarmed: options.prewarmed === true,
  };
  return npcProfile;
}

function createAbyssalNpcProfiles(ports) {
  return {
    buildRoomNpcProfileFromEncounterProfile: buildRoomNpcProfileFromEncounterProfile.bind(null, ports),
    buildCapturedT0DarkRoomNpcProfile: buildCapturedT0DarkRoomNpcProfile.bind(null, ports),
    shouldUseTier0AbyssalSpaceEmpiricalContent: shouldUseTier0AbyssalSpaceEmpiricalContent.bind(null, ports),
    shouldUseCorrelatedAbyssalSpaceEmpiricalContent: shouldUseCorrelatedAbyssalSpaceEmpiricalContent.bind(null, ports),
    resolveRoomNpcProfileForSpawn: resolveRoomNpcProfileForSpawn.bind(null, ports),
    hasPrewarmedAbyssalEncounter: hasPrewarmedAbyssalEncounter.bind(null, ports),
    getAuthoredRoomEncounterProfile: getAuthoredRoomEncounterProfile.bind(null, ports),
  };
}

module.exports = { createAbyssalNpcProfiles };
