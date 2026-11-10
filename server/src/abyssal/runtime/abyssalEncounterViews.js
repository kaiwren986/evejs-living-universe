"use strict";

const { toInt, normalizeText } = require("../domain/abyssalRuntimeValues");

function buildAbyssalContentResolutionError(ports,
  errorCode,
  pocketState,
  roomIndex,
  component,
) {
  const {
    getContentProfile,
  } = ports;
  const contentProfile = getContentProfile(pocketState) || {};
  const error = new Error(
    `${errorCode} component=${component} ` +
      `filamentTypeID=${toInt(contentProfile.filamentTypeID, 0)} ` +
      `tier=${toInt(contentProfile.tier, -1)} ` +
      `weather=${normalizeText(contentProfile.weatherType, "unknown")} ` +
      `room=${toInt(roomIndex, 0)} ` +
      `run=${toInt(pocketState && pocketState.instanceID, 0)} ` +
      `trace=${toInt(pocketState && pocketState.traceItemID, 0)}`,
  );
  error.code = errorCode;
  error.component = component;
  error.roomIndex = toInt(roomIndex, 0);
  return error;
}

function resolveRoomEncounterProfile(ports, pocketState, roomIndex = null, options = {}) {
  const {
    getContentProfile,
    cloneValue,
    clampRoomIndex,
    buildPlaceholderRoomState,
    getImplementedRoomCount,
    getPlaceholderRoomEntry,
    getRoomEncounterProfilesByIndex,
    isProceduralAbyssalContent,
    resolveRoomNpcProfileForSpawn,
    log,
  } = ports;
  const contentProfile = getContentProfile(pocketState) || {};
  const baseProfile = cloneValue(contentProfile.npcProfile) || {};
  const resolvedRoomIndex = clampRoomIndex(
    roomIndex == null ? buildPlaceholderRoomState(pocketState).currentRoomIndex : roomIndex,
    getImplementedRoomCount(pocketState),
  );
  const roomEntry = getPlaceholderRoomEntry(pocketState, resolvedRoomIndex);
  if (
    normalizeText(roomEntry && roomEntry.encounterProfileID, "") &&
    Array.isArray(roomEntry && roomEntry.resolvedNpcEntries) &&
    roomEntry.resolvedNpcEntries.length > 0
  ) {
    return buildPersistedRoomEncounterProfile(ports, pocketState, roomEntry, contentProfile, resolvedRoomIndex);
  }
  const encounterProfilesByIndex = getRoomEncounterProfilesByIndex(pocketState);
  const resolvedEncounter = encounterProfilesByIndex[String(resolvedRoomIndex)] ||
    encounterProfilesByIndex[resolvedRoomIndex] || null;
  if (isProceduralAbyssalContent(contentProfile)) {
    if (resolvedEncounter?.selectionMode !== "qsna_runtime") {
      throw buildAbyssalContentResolutionError(ports, "ABYSSAL_ROOM_ENCOUNTER_PROFILE_INVALID", pocketState, resolvedRoomIndex, "encounter");
    }
    const resolved = resolveRoomNpcProfileForSpawn(pocketState, resolvedRoomIndex, ports.getDependencies(), options);
    if (resolved.errorMsg) throw new Error(resolved.errorMsg);
    return { ...resolved, npcCount: resolved.amount };
  }
  if (!resolvedEncounter) {
    throw buildAbyssalContentResolutionError(ports,
      "ABYSSAL_ROOM_ENCOUNTER_PROFILE_MISSING",
      pocketState,
      resolvedRoomIndex,
      "encounter",
    );
  }
  if (
    !normalizeText(resolvedEncounter.encounterProfileID, "") ||
    !Array.isArray(resolvedEncounter.npcEntries) ||
    resolvedEncounter.npcEntries.length <= 0
  ) {
    throw buildAbyssalContentResolutionError(ports,
      "ABYSSAL_ROOM_ENCOUNTER_PROFILE_INVALID",
      pocketState,
      resolvedRoomIndex,
      "encounter",
    );
  }
  const npcEntries = Array.isArray(resolvedEncounter.npcEntries)
    ? resolvedEncounter.npcEntries.map((entry, index) => normalizeLegacyEncounterNpcEntry(ports, entry, index, baseProfile))
    : [];
  const normalizedEncounter = buildLegacyRoomEncounterProfile(ports, resolvedEncounter, resolvedRoomIndex, contentProfile, npcEntries);
  if (options.logResolution !== false) {
    log.info(
      `[AbyssalMgr] Room encounter profile resolved char=${toInt(pocketState && pocketState.characterID, 0)} ` +
        `instance=${toInt(pocketState && pocketState.instanceID, 0)} trace=${toInt(pocketState && pocketState.traceItemID, 0)} ` +
        `room=${resolvedRoomIndex}/${getImplementedRoomCount(pocketState)} ` +
        `profile=${normalizedEncounter.encounterProfileID} ` +
        `name="${normalizedEncounter.encounterName}" theme=${normalizedEncounter.factionTheme} ` +
        `npcCount=${normalizedEncounter.npcCount} objective=${normalizedEncounter.objectiveType}`,
    );
    if (
      normalizedEncounter.weatherTheme &&
      normalizedEncounter.weatherTheme === normalizeText(contentProfile.weatherType, "")
    ) {
      log.info(
        `[AbyssalMgr] Weather-themed encounter selected char=${toInt(pocketState && pocketState.characterID, 0)} ` +
          `instance=${toInt(pocketState && pocketState.instanceID, 0)} trace=${toInt(pocketState && pocketState.traceItemID, 0)} ` +
          `room=${resolvedRoomIndex}/${getImplementedRoomCount(pocketState)} ` +
          `weather=${normalizedEncounter.weatherTheme} profile=${normalizedEncounter.encounterProfileID}`,
      );
    }
  }
  return normalizedEncounter;
}

function resolveRoomNpcProfile(ports, pocketState, roomIndex = null, options = {}) {
  const {
    cloneValue,
    cloneRuntimeRewardProfileOverride,
    PLACEHOLDER_ENCOUNTER_OFFSET_METERS,
  } = ports;
  const encounterProfile = resolveRoomEncounterProfile(ports, pocketState, roomIndex, options);
  const primaryNpcEntry = Array.isArray(encounterProfile.npcEntries)
    ? encounterProfile.npcEntries[0] || null
    : null;
  return {
    roomIndex: encounterProfile.roomIndex,
    encounterProfileID: encounterProfile.encounterProfileID,
    encounterName: encounterProfile.encounterName,
    encounterTheme: encounterProfile.encounterTheme,
    factionTheme: encounterProfile.factionTheme,
    weatherTheme: encounterProfile.weatherTheme,
    tierBandID: encounterProfile.tierBandID,
    tierBandLabel: encounterProfile.tierBandLabel,
    tierRange: cloneValue(encounterProfile.tierRange),
    objectiveType: encounterProfile.objectiveType,
    npcEntries: cloneValue(encounterProfile.npcEntries),
    rewardMultiplier: encounterProfile.rewardMultiplier,
    rewardQuantityBonus: encounterProfile.rewardQuantityBonus,
    rewardProfileOverride: cloneRuntimeRewardProfileOverride(
      encounterProfile.rewardProfileOverride,
    ),
    cacheProfileOverride: cloneValue(encounterProfile.cacheProfileOverride),
    observedObjectEntries: cloneValue(encounterProfile.observedObjectEntries) || [],
    sourceModelID: normalizeText(encounterProfile.sourceModelID, ""),
    sourceVariantID: normalizeText(encounterProfile.sourceVariantID, ""),
    sourceSpawnID: normalizeText(encounterProfile.sourceSpawnID, ""),
    sourceSpawnFamily: normalizeText(encounterProfile.sourceSpawnFamily, ""),
    sourceObservationCount: Math.max(0, toInt(encounterProfile.sourceObservationCount, 0)),
    sourceEvidenceAuthority: normalizeText(encounterProfile.sourceEvidenceAuthority, ""),
    encounterAuthority: cloneValue(encounterProfile.encounterAuthority),
    extractionNodeProfileOverride: cloneValue(encounterProfile.extractionNodeProfileOverride),
    runtimeKind: normalizeText(primaryNpcEntry && primaryNpcEntry.runtimeKind, "nativeCombat"),
    profileQuery: normalizeText(
      primaryNpcEntry && primaryNpcEntry.profileQuery,
      "parity_guristas_missile_frigate",
    ),
    profileName: normalizeText(primaryNpcEntry && primaryNpcEntry.profileName, ""),
    requestedProfileQuery: normalizeText(primaryNpcEntry && primaryNpcEntry.requestedProfileQuery, ""),
    fallbackUsed: primaryNpcEntry && primaryNpcEntry.fallbackUsed === true,
    fallbackReason: normalizeText(primaryNpcEntry && primaryNpcEntry.fallbackReason, ""),
    weaponStyle: normalizeText(primaryNpcEntry && primaryNpcEntry.weaponStyle, ""),
    amount: Math.max(1, encounterProfile.npcCount),
    spawnOffsetMeters: toInt(
      primaryNpcEntry && primaryNpcEntry.spawnOffsetMeters,
      PLACEHOLDER_ENCOUNTER_OFFSET_METERS,
    ),
    objectiveRole: normalizeText(
      primaryNpcEntry && primaryNpcEntry.objectiveRole,
      normalizeText(encounterProfile.objectiveType, "kill_all_hostiles"),
    ),
    spawnReference: normalizeText(primaryNpcEntry && primaryNpcEntry.spawnReference, "ship_spawn"),
    spawnDistanceMode: normalizeText(primaryNpcEntry && primaryNpcEntry.spawnDistanceMode, "ahead_of_ship"),
  };
}

function buildPersistedRoomEncounterProfile(ports, pocketState, roomEntry, contentProfile, resolvedRoomIndex) {
  const {
    getRoomEncounterProfilesByIndex,
    cloneValue,
    cloneRuntimeRewardProfileOverride,
  } = ports;
    const authoredProfilesByIndex = getRoomEncounterProfilesByIndex(pocketState);
    const authoredProfile =
      authoredProfilesByIndex[String(resolvedRoomIndex)] ||
      authoredProfilesByIndex[resolvedRoomIndex] ||
      null;
    const authoredProfileMatches =
      normalizeText(authoredProfile && authoredProfile.encounterProfileID, "") ===
      normalizeText(roomEntry.encounterProfileID, "");
    return {
      roomIndex: resolvedRoomIndex,
      encounterProfileID: normalizeText(roomEntry.encounterProfileID, ""),
      encounterName: normalizeText(roomEntry.encounterName, ""),
      encounterTheme: normalizeText(roomEntry.encounterTheme, ""),
      factionTheme: normalizeText(roomEntry.encounterFactionTheme, "mixed"),
      weatherTheme: normalizeText(roomEntry.encounterWeatherTheme, normalizeText(contentProfile.weatherType, "")),
      tierBandID: "low",
      tierBandLabel: "Low",
      tierRange: authoredProfileMatches && authoredProfile && authoredProfile.tierRange
        ? cloneValue(authoredProfile.tierRange)
        : {
          minTier: 1,
          maxTier: 1,
        },
      objectiveType: "kill_objective_hostiles",
      npcEntries: cloneValue(roomEntry.resolvedNpcEntries),
      npcCount: roomEntry.resolvedNpcEntries.reduce(
        (total, entry) => total + Math.max(0, toInt(entry && entry.count, 0)),
        0,
      ),
      rewardMultiplier: Number(roomEntry.rewardMultiplier) > 0 ? Number(roomEntry.rewardMultiplier) : 1,
      rewardQuantityBonus: toInt(roomEntry.rewardQuantityBonus, 0),
      combatBudget: roomEntry.combatBudget && typeof roomEntry.combatBudget === "object"
        ? cloneValue(roomEntry.combatBudget)
        : null,
      encounterDroneCount: toInt(roomEntry.encounterDroneCount, 0),
      encounterShipCount: toInt(roomEntry.encounterShipCount, 0),
      encounterEscortTypeID: toInt(roomEntry.encounterEscortTypeID, 0),
      rewardProfileOverride:
        roomEntry.rewardProfileOverride &&
          typeof roomEntry.rewardProfileOverride === "object"
          ? cloneRuntimeRewardProfileOverride(roomEntry.rewardProfileOverride)
          : authoredProfileMatches &&
            authoredProfile &&
            authoredProfile.rewardProfileOverride &&
            typeof authoredProfile.rewardProfileOverride === "object"
            ? cloneRuntimeRewardProfileOverride(authoredProfile.rewardProfileOverride)
            : null,
      cacheProfileOverride:
        roomEntry.cacheProfileOverride &&
          typeof roomEntry.cacheProfileOverride === "object"
          ? cloneValue(roomEntry.cacheProfileOverride)
          : null,
      observedObjectEntries: Array.isArray(roomEntry.observedObjectEntries)
        ? cloneValue(roomEntry.observedObjectEntries)
        : [],
      sourceModelID: normalizeText(roomEntry.sourceModelID, ""),
      sourceVariantID: normalizeText(roomEntry.sourceVariantID, ""),
      sourceSpawnID: normalizeText(roomEntry.sourceSpawnID, ""),
      sourceSpawnFamily: normalizeText(roomEntry.sourceSpawnFamily, ""),
      sourceObservationCount: Math.max(0, toInt(roomEntry.sourceObservationCount, 0)),
      sourceEvidenceAuthority: normalizeText(roomEntry.sourceEvidenceAuthority, ""),
      encounterAuthority:
        roomEntry.encounterAuthority &&
          typeof roomEntry.encounterAuthority === "object"
          ? cloneValue(roomEntry.encounterAuthority)
          : null,
      extractionNodeProfileOverride:
        authoredProfileMatches &&
          authoredProfile &&
          authoredProfile.extractionNodeProfileOverride &&
          typeof authoredProfile.extractionNodeProfileOverride === "object"
          ? cloneValue(authoredProfile.extractionNodeProfileOverride)
          : null,
      authoredObjective:
        authoredProfileMatches &&
          authoredProfile &&
          authoredProfile.authoredObjective &&
          typeof authoredProfile.authoredObjective === "object"
          ? cloneValue(authoredProfile.authoredObjective)
          : null,
      authoredRoomID: authoredProfileMatches
        ? normalizeText(authoredProfile && authoredProfile.authoredRoomID, "")
        : "",
      placeholderNotes: [],
    };
  }

function normalizeLegacyEncounterNpcEntry(ports, entry, index, baseProfile) {
  const {
    PLACEHOLDER_ENCOUNTER_OFFSET_METERS,
    cloneValue,
  } = ports;
  return {
      npcEntryID: normalizeText(entry && entry.npcEntryID, `entry_${index + 1}`),
      runtimeKind: normalizeText(entry && entry.runtimeKind, normalizeText(baseProfile.runtimeKind, "nativeCombat")),
      profileQuery: normalizeText(
        entry && entry.profileQuery,
        normalizeText(baseProfile.profileQuery, "parity_guristas_missile_frigate"),
      ),
      profileName: normalizeText(entry && entry.profileName, ""),
      requestedProfileQuery: normalizeText(entry && entry.requestedProfileQuery, ""),
      fallbackUsed: entry && entry.fallbackUsed === true,
      fallbackReason: normalizeText(entry && entry.fallbackReason, ""),
      weaponStyle: normalizeText(entry && entry.weaponStyle, ""),
      typeID: toInt(entry && entry.typeID, 0),
      displayName: normalizeText(entry && entry.displayName, ""),
      groupID: toInt(entry && entry.groupID, 0),
      factionID: toInt(entry && entry.factionID, 0),
      role: normalizeText(entry && entry.role, ""),
      count: Math.max(1, toInt(entry && entry.count, 1)),
      minimumCount: Math.max(0, toInt(entry && entry.minimumCount, 0)),
      maximumCount: Math.max(0, toInt(entry && entry.maximumCount, 0)),
      resolvedCount: Math.max(0, toInt(entry && entry.resolvedCount, 0)),
      required: entry && entry.required === true,
      objectiveRelevant: !(entry && entry.objectiveRelevant === false),
      objectiveBlocker: entry && entry.objectiveBlocker === true,
      spawnOffsetMeters: toInt(
        entry && entry.spawnOffsetMeters,
        toInt(baseProfile.spawnOffsetMeters, PLACEHOLDER_ENCOUNTER_OFFSET_METERS),
      ),
      spawnRadiusMeters: toInt(entry && entry.spawnRadiusMeters, 0),
      objectiveRole: normalizeText(
        entry && entry.objectiveRole,
        normalizeText(baseProfile.objectiveRole, "kill_all_hostiles"),
      ),
      spawnReference: normalizeText(
        entry && entry.spawnReference,
        normalizeText(baseProfile.spawnReference, "ship_spawn"),
      ),
      spawnDistanceMode: normalizeText(
        entry && entry.spawnDistanceMode,
        normalizeText(baseProfile.spawnDistanceMode, "ahead_of_ship"),
      ),
      runtimePolicy: cloneValue(
        entry && entry.runtimePolicy && typeof entry.runtimePolicy === "object"
          ? entry.runtimePolicy
          : baseProfile.runtimePolicy,
      ) || null,
      capturedRoomRelativePosition: cloneValue(
        entry && entry.capturedRoomRelativePosition,
      ),
      capturedRetailRotation: cloneValue(entry && entry.capturedRetailRotation),
      capturedRetailBallID: normalizeText(entry && entry.capturedRetailBallID, ""),
      capturedRetailOwnerID: toInt(entry && entry.capturedRetailOwnerID, 0),
      capturedRetailIdentity: cloneValue(entry && entry.capturedRetailIdentity),
      capturedRetailCombat: cloneValue(entry && entry.capturedRetailCombat),
      capabilities: Array.isArray(entry && entry.capabilities)
        ? cloneValue(entry.capabilities)
        : [],
      capabilityData: cloneValue(entry && entry.capabilityData) || {},
      behaviorOverrides: cloneValue(entry && entry.behaviorOverrides) || {},
      controllerEntityID: normalizeText(entry && entry.controllerEntityID, "") || null,
      deactivatesOnEntityID:
        normalizeText(entry && entry.deactivatesOnEntityID, "") || null,
      controllerLossBehavior:
        normalizeText(entry && entry.controllerLossBehavior, "") || null,
      autoRemoveWithController: entry && entry.autoRemoveWithController === true,
      remainsPresentAndTargetableOnControllerLoss:
        entry && entry.remainsPresentAndTargetableOnControllerLoss === true,
      capturedRetailObject: entry && entry.capturedRetailObject === true,
    };
}

function buildLegacyRoomEncounterProfile(ports, resolvedEncounter, resolvedRoomIndex, contentProfile, npcEntries) {
  const {
    cloneRuntimeRewardProfileOverride,
    cloneValue,
  } = ports;
  const rewardMultiplier = Number(resolvedEncounter.rewardMultiplier);
  return {
    roomIndex: resolvedRoomIndex,
    encounterProfileID: normalizeText(
      resolvedEncounter.encounterProfileID,
      "",
    ),
    encounterName: normalizeText(
      resolvedEncounter.encounterName,
      resolvedEncounter.encounterProfileID,
    ),
    encounterTheme: normalizeText(resolvedEncounter.encounterTheme, normalizeText(resolvedEncounter.factionTheme, "placeholder")),
    factionTheme: normalizeText(resolvedEncounter.factionTheme, "placeholder"),
    weatherTheme: normalizeText(resolvedEncounter.weatherTheme, normalizeText(contentProfile.weatherType, "")),
    tierBandID: normalizeText(resolvedEncounter.tierBandID, ""),
    tierBandLabel: normalizeText(resolvedEncounter.tierBandLabel, ""),
    tierRange: {
      minTier: Math.max(0, toInt(resolvedEncounter && resolvedEncounter.tierRange && resolvedEncounter.tierRange.minTier, 0)),
      maxTier: Math.max(0, toInt(resolvedEncounter && resolvedEncounter.tierRange && resolvedEncounter.tierRange.maxTier, 0)),
    },
    objectiveType: normalizeText(resolvedEncounter.objectiveType, "kill_all_hostiles"),
    npcEntries,
    npcCount: npcEntries.reduce((total, entry) => total + Math.max(0, toInt(entry && entry.count, 0)), 0),
    rewardMultiplier: Number.isFinite(rewardMultiplier) && rewardMultiplier > 0 ? rewardMultiplier : 1,
    rewardQuantityBonus: toInt(resolvedEncounter.rewardQuantityBonus, 0),
    rewardProfileOverride:
      resolvedEncounter.rewardProfileOverride &&
        typeof resolvedEncounter.rewardProfileOverride === "object"
        ? cloneRuntimeRewardProfileOverride(resolvedEncounter.rewardProfileOverride)
        : null,
    cacheProfileOverride:
      resolvedEncounter.cacheProfileOverride &&
        typeof resolvedEncounter.cacheProfileOverride === "object"
        ? cloneValue(resolvedEncounter.cacheProfileOverride)
        : null,
    observedObjectEntries: Array.isArray(resolvedEncounter.observedObjectEntries)
      ? cloneValue(resolvedEncounter.observedObjectEntries)
      : [],
    sourceModelID: normalizeText(resolvedEncounter.sourceModelID, ""),
    sourceVariantID: normalizeText(resolvedEncounter.sourceVariantID, ""),
    sourceSpawnID: normalizeText(resolvedEncounter.sourceSpawnID, ""),
    sourceSpawnFamily: normalizeText(resolvedEncounter.sourceSpawnFamily, ""),
    sourceObservationCount: Math.max(0, toInt(resolvedEncounter.sourceObservationCount, 0)),
    sourceEvidenceAuthority: normalizeText(resolvedEncounter.sourceEvidenceAuthority, ""),
    encounterAuthority:
      resolvedEncounter.encounterAuthority &&
        typeof resolvedEncounter.encounterAuthority === "object"
        ? cloneValue(resolvedEncounter.encounterAuthority)
        : null,
    extractionNodeProfileOverride:
      resolvedEncounter.extractionNodeProfileOverride &&
        typeof resolvedEncounter.extractionNodeProfileOverride === "object"
        ? cloneValue(resolvedEncounter.extractionNodeProfileOverride)
        : null,
    authoredObjective:
      resolvedEncounter.authoredObjective &&
        typeof resolvedEncounter.authoredObjective === "object"
        ? cloneValue(resolvedEncounter.authoredObjective)
        : null,
    authoredRoomID: normalizeText(resolvedEncounter.authoredRoomID, ""),
    placeholderNotes: Array.isArray(resolvedEncounter.placeholderNotes)
      ? resolvedEncounter.placeholderNotes.map((entry) => normalizeText(entry, "")).filter(Boolean)
      : [],
    combatBudget: resolvedEncounter.combatBudget && typeof resolvedEncounter.combatBudget === "object"
      ? cloneValue(resolvedEncounter.combatBudget)
      : null,
  };
}

function createAbyssalEncounterViews(ports) {
  return {
    buildAbyssalContentResolutionError: buildAbyssalContentResolutionError.bind(null, ports),
    resolveRoomEncounterProfile: resolveRoomEncounterProfile.bind(null, ports),
    resolveRoomNpcProfile: resolveRoomNpcProfile.bind(null, ports),
  };
}

module.exports = { createAbyssalEncounterViews };
