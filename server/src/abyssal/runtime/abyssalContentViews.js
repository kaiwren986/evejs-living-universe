"use strict";

const { toInt, toReal, normalizeText, normalizeLowerText, getObjectPosition } = require("../domain/abyssalRuntimeValues");

// Existing content/presentation views and versioned recovery compatibility, not new-run content authority.
function getContentProfile(ports, source) {
  // Filament definitions are immutable catalogue data. Returning the authored
  // object avoids deep-copying high-tier empirical reward/encounter catalogues
  // on every room-state lookup. Callers that need a mutable nested value clone
  // that value explicitly before changing it.
  return source && source.contentProfile && typeof source.contentProfile === "object"
    ? source.contentProfile
    : null;
}

function isCapturedT0DarkContent(ports, source) {
  const {
    T0_DARK_RETAIL_CAPTURED_FILAMENT_TYPE_ID,
    T0_DARK_RETAIL_CAPTURED_PROFILE_ID,
    T0_DARK_RETAIL_CAPTURED_LAYOUT_VARIANT,
    isT0DarkRetailCapturedProfile,
  } = ports;
  const contentProfile = getContentProfile(ports, source) || source || {};
  const hasCapturedContentIdentity =
    toInt(contentProfile.filamentTypeID, 0) === T0_DARK_RETAIL_CAPTURED_FILAMENT_TYPE_ID ||
    normalizeText(contentProfile.authoredCaptureID, "") === T0_DARK_RETAIL_CAPTURED_PROFILE_ID ||
    normalizeLowerText(contentProfile.environmentLayoutVariant, "") ===
      normalizeLowerText(T0_DARK_RETAIL_CAPTURED_LAYOUT_VARIANT, "");
  if (!hasCapturedContentIdentity) return false;
  return isT0DarkRetailCapturedProfile({
    tier: contentProfile.tier,
    weatherType: contentProfile.weatherType,
    layoutVariant: contentProfile.environmentLayoutVariant,
  });
}

function isTranquilAbyssalContent(ports, source) {
  const contentProfile = getContentProfile(ports, source) || source || {};
  return (
    ports.isTranquilFilamentTypeID(
      toInt(contentProfile.filamentTypeID, 0),
    ) ||
    isCapturedT0DarkContent(ports, contentProfile)
  );
}

function getT0DarkLayoutCompatibilityOptions(ports, source = null, overrides = {}) {
  const contentProfile = getContentProfile(ports, source) || source || {};
  return {
    filamentTypeID: toInt(
      overrides.filamentTypeID,
      toInt(contentProfile.filamentTypeID, 0),
    ),
    tier: toInt(overrides.tier, toInt(contentProfile.tier, -1)),
    weatherType: normalizeLowerText(
      overrides.weatherType,
      normalizeLowerText(contentProfile.weatherType, ""),
    ),
  };
}

function normalizeT0DarkLayoutSelectionState(ports, source = null, options = {}) {
  const {
    resolveT0DarkLayoutSetByID,
    buildLegacyT0DarkLayoutSelectionState,
    T0_DARK_LAYOUT_SELECTION_MODEL,
  } = ports;
  if (!isCapturedT0DarkContent(ports, source)) return null;
  const selectedLayoutSetID = normalizeText(source && source.selectedLayoutSetID, "");
  const selectedLayoutSet = selectedLayoutSetID
    ? resolveT0DarkLayoutSetByID(selectedLayoutSetID, { includeKnownGoodFallback: true })
    : null;
  if (!selectedLayoutSet) {
    return buildLegacyT0DarkLayoutSelectionState(
      normalizeText(options.legacySource, "legacy-migration"),
    );
  }
  const legacyDefaults = buildLegacyT0DarkLayoutSelectionState(
    normalizeText(source && source.layoutSelectionSource, "recovered"),
  );
  return {
    ...legacyDefaults,
    layoutSelectionSchemaVersion: Math.max(
      1,
      toInt(source && source.layoutSelectionSchemaVersion, legacyDefaults.layoutSelectionSchemaVersion),
    ),
    layoutCatalogVersion: Math.max(
      1,
      toInt(source && source.layoutCatalogVersion, legacyDefaults.layoutCatalogVersion),
    ),
    layoutSelectionModel: normalizeText(
      source && source.layoutSelectionModel,
      T0_DARK_LAYOUT_SELECTION_MODEL,
    ),
    layoutSelectionSeed: toInt(source && source.layoutSelectionSeed, 0) >>> 0,
    selectedLayoutSetID: selectedLayoutSet.layoutSetID,
    selectedRoomLayoutIDs: Object.fromEntries(
      selectedLayoutSet.rooms.map((room) => [String(room.roomIndex), room.layoutID]),
    ),
    layoutSelectionSource: normalizeText(source && source.layoutSelectionSource, "recovered"),
    layoutSelectionWeightsSummary: normalizeText(
      source && source.layoutSelectionWeightsSummary,
      `${selectedLayoutSet.layoutSetID}=${Number(selectedLayoutSet.selectionWeight) || 1}`,
    ),
  };
}

function logT0DarkLayoutCatalogWarningsOnce(ports) {
  const {
    getT0DarkLayoutCatalogValidationReport,
    log,
    T0_DARK_LEGACY_LAYOUT_SET_ID,
  } = ports;
  if (!ports.consumeT0DarkLayoutCatalogWarning()) return;
  const report = getT0DarkLayoutCatalogValidationReport();
  for (const disabled of report.disabled || []) {
    log.warn(
      `[AbyssalLayoutSelection] disabled layoutSetID=${normalizeText(disabled.layoutSetID, "unknown")} ` +
        `reasons=${(disabled.errors || []).join("|")}`,
    );
  }
  if (!Array.isArray(report.enabled) || report.enabled.length <= 0) {
    log.warn(
      `[AbyssalLayoutSelection] no valid Tier 0 Dark layout remains; ` +
        `using known-good fallback layoutSetID=${T0_DARK_LEGACY_LAYOUT_SET_ID}`,
    );
  }
}

function getCapturedT0DarkRoom(ports, source, roomIndex = null) {
  const {
    buildPlaceholderRoomState,
    resolveSelectedT0DarkRoom,
  } = ports;
  if (!isCapturedT0DarkContent(ports, source)) return null;
  const resolvedRoomIndex = roomIndex == null
    ? toInt(buildPlaceholderRoomState(source).currentRoomIndex, 1)
    : toInt(roomIndex, 1);
  const selectionState = normalizeT0DarkLayoutSelectionState(ports, source);
  return resolveSelectedT0DarkRoom(selectionState, resolvedRoomIndex);
}

function getCapturedAuthoredRoom(ports, source, roomIndex = null) {
  const {
    buildPlaceholderRoomState,
  } = ports;
  const contentProfile = getContentProfile(ports, source) || source || {};
  if (isCapturedT0DarkContent(ports, contentProfile)) {
    return null;
  }
  const captureID = normalizeText(contentProfile.authoredCaptureID, "");
  if (!captureID) return null;

  const capture = typeof ports.resolveAuthoredAbyssalCaptureByID ===
    "function"
    ? ports.resolveAuthoredAbyssalCaptureByID(captureID)
    : null;
  if (
    !capture ||
    toInt(capture.tier, -1) !== toInt(contentProfile.tier, -2) ||
    toInt(capture.filamentTypeID, 0) !==
      toInt(contentProfile.filamentTypeID, 0) ||
    normalizeLowerText(capture.weatherType, "") !==
      normalizeLowerText(contentProfile.weatherType, "")
  ) {
    return null;
  }

  const resolvedRoomIndex = roomIndex == null
    ? toInt(buildPlaceholderRoomState(source).currentRoomIndex, 1)
    : toInt(roomIndex, 1);
  return (Array.isArray(capture.rooms) ? capture.rooms : []).find((room) =>
    toInt(room && room.roomNumber, 0) === resolvedRoomIndex
  ) || null;
}

function getCapturedAuthoredRoomEntity(ports, room, referenceField, expectedKinds = []) {
  if (!room || typeof room !== "object") return null;
  const entities = Array.isArray(room.entities) ? room.entities : [];
  const referencedEntityID = normalizeText(room[referenceField], "");
  const referencedEntity = referencedEntityID
    ? entities.find((entity) =>
      normalizeText(entity && entity.entityID, "") === referencedEntityID
    )
    : null;
  if (referencedEntity && getObjectPosition(referencedEntity.position)) {
    return referencedEntity;
  }
  const allowedKinds = new Set(
    (Array.isArray(expectedKinds) ? expectedKinds : [])
      .map((kind) => normalizeLowerText(kind, ""))
      .filter(Boolean),
  );
  return entities.find((entity) =>
    allowedKinds.has(normalizeLowerText(entity && entity.kind, "")) &&
    getObjectPosition(entity && entity.position)
  ) || null;
}

function buildCapturedAuthoredDunRotation(ports, entity) {
  const rotation = entity && entity.rotation;
  return rotation && typeof rotation === "object"
    ? [
      toReal(rotation.x, 0),
      toReal(rotation.y, 0),
      toReal(rotation.z, 0),
    ]
    : [0, 0, 0];
}

function normalizeTranquilPresentationIdentity(ports, identity) {
  const {
    cloneValue,
  } = ports;
  if (!identity || typeof identity !== "object") {
    return null;
  }

  return {
    ...cloneValue(identity),
    displayName: normalizeText(identity.displayName, "") || null,
  };
}

function resolveAbyssalCachePresentationIdentity(ports, source, roomIndex = null) {
  const {
    buildPlaceholderRoomState,
    TYPE_CAPTURED_TRIGLAVIAN_BIOADAPTIVE_CACHE,
    TYPE_ABYSSAL_BIOCOMBINATIVE_CACHE,
    T0_DARK_RETAIL_CAPTURED_LAYOUT,
  } = ports;
  const resolvedRoomIndex = roomIndex == null
    ? toInt(buildPlaceholderRoomState(source).currentRoomIndex, 1)
    : toInt(roomIndex, 1);
  const cacheProfile = getCacheProfile(ports, source) || {};
  const cacheTypeID = toInt(cacheProfile.cacheTypeID, 0);
  const cacheFamily = normalizeText(cacheProfile.cacheFamily, "");

  const usesHostileTriglavianCachePresentation = Boolean(
    cacheTypeID === TYPE_CAPTURED_TRIGLAVIAN_BIOADAPTIVE_CACHE ||
    cacheTypeID === TYPE_ABYSSAL_BIOCOMBINATIVE_CACHE ||
    cacheFamily === "captured_triglavian_bioadaptive_cache" ||
    cacheFamily === "triglavian_bioadaptive_cache" ||
    cacheFamily === "triglavian_biocombinative_cache"
  );

  if (!usesHostileTriglavianCachePresentation) {
    return null;
  }
  const capturedRoom = getCapturedT0DarkRoom(ports, source, resolvedRoomIndex);
  if (capturedRoom && capturedRoom.rewardCache && capturedRoom.rewardCache.identity) {
    return normalizeTranquilPresentationIdentity(ports,
      capturedRoom.rewardCache.identity,
    );
  }

  // Managed Triglavian Abyssal reward caches share the hostile cache
  // presentation required by the stock client. Inventory and reward ownership
  // remain with the participant while presentation ownership and response
  // thresholds cause the cache to render with the intended hostile/red state.
  return normalizeTranquilPresentationIdentity(ports,
    T0_DARK_RETAIL_CAPTURED_LAYOUT.rooms[1].rewardCache.identity,
  );
}

function resolveTranquilCachePresentationIdentity(ports, source, roomIndex = null) {
  return resolveAbyssalCachePresentationIdentity(ports, source, roomIndex);
}

function resolveTranquilConduitPresentationIdentity(ports, source, roomIndex = null) {
  const {
    buildPlaceholderRoomState,
    isFinalRoomIndex,
    T0_DARK_RETAIL_CAPTURED_LAYOUT,
  } = ports;
  const resolvedRoomIndex = roomIndex == null
    ? toInt(buildPlaceholderRoomState(source).currentRoomIndex, 1)
    : toInt(roomIndex, 1);

  const capturedRoom = getCapturedT0DarkRoom(ports, source, resolvedRoomIndex);

  if (
    capturedRoom &&
    capturedRoom.conduit &&
    capturedRoom.conduit.identity
  ) {
    return normalizeTranquilPresentationIdentity(ports,
      capturedRoom.conduit.identity,
    );
  }

  if (!isTranquilAbyssalContent(ports, source)) {
    return null;
  }

  const identityRoomIndex = isFinalRoomIndex(
    source,
    resolvedRoomIndex,
  )
    ? 3
    : 1;

  return normalizeTranquilPresentationIdentity(ports,
    T0_DARK_RETAIL_CAPTURED_LAYOUT.rooms[identityRoomIndex].conduit.identity,
  );
}

function getCacheProfile(ports, source) {
  const {
    buildPlaceholderRoomState,
    getPlaceholderRoomEntry,
    cloneValue,
    TYPE_CAPTURED_TRIGLAVIAN_BIOADAPTIVE_CACHE,
    TYPE_CAPTURED_TRIGLAVIAN_BIOADAPTIVE_CACHE_WRECK,
  } = ports;
  const contentProfile = getContentProfile(ports, source) || source;
  const roomState = source && source.roomState && typeof source.roomState === "object"
    ? buildPlaceholderRoomState(source)
    : null;
  const currentRoomEntry = roomState
    ? getPlaceholderRoomEntry(source, roomState.currentRoomIndex)
    : null;
  if (
    currentRoomEntry &&
    currentRoomEntry.cacheProfileOverride &&
    typeof currentRoomEntry.cacheProfileOverride === "object"
  ) {
    return cloneValue(currentRoomEntry.cacheProfileOverride);
  }
  if (
    isCapturedT0DarkContent(ports, contentProfile) &&
    resolveAbyssalRequiredFilamentCount(ports, source) === 1
  ) {
    return {
      cacheProfileID: "abyssal:cache:tier0-dark-retail-captured-v1",
      cacheFamily: "captured_triglavian_bioadaptive_cache",
      cacheTypeID: TYPE_CAPTURED_TRIGLAVIAN_BIOADAPTIVE_CACHE,
      cacheTypeName: "Triglavian Bioadaptive Cache",
      cacheDisplayName: "Triglavian Bioadaptive Cache",
      wreckTypeID: TYPE_CAPTURED_TRIGLAVIAN_BIOADAPTIVE_CACHE_WRECK,
      wreckTypeName: "Triglavian Bioadaptive Cache Wreck",
      optionalExit: true,
      capturedRetailProfile: true,
      placeholderOnly: false,
    };
  }
  if (contentProfile && contentProfile.cacheProfile && typeof contentProfile.cacheProfile === "object") {
    return resolveMainAbyssalCacheFamily(ports,
      source,
      cloneValue(contentProfile.cacheProfile),
    );
  }
  const rewardProfile = contentProfile && contentProfile.rewardProfile;
  if (rewardProfile && typeof rewardProfile === "object") {
    return resolveMainAbyssalCacheFamily(ports, source, {
      cacheTypeName: normalizeText(rewardProfile.cacheTypeName, ""),
      cacheDisplayName: normalizeText(rewardProfile.cacheDisplayName, ""),
      cacheOffsetMeters: toInt(rewardProfile.cacheOffsetMeters, 0),
      optionalExit: rewardProfile.optionalExit !== false,
    });
  }
  return null;
}

function resolveAbyssalRequiredFilamentCount(ports, source = null) {
  const {
    ABYSSAL_CALM_TIER_REWARD_QUANTITY_MULTIPLIER,
  } = ports;
  const contentProfile = getContentProfile(ports, source) || source || {};
  const explicitCount = toInt(
    source && source.requiredFilaments,
    toInt(contentProfile.requiredFilaments, 0),
  );
  if (explicitCount > 0) {
    return Math.max(1, Math.min(3, explicitCount));
  }
  const shipClass = normalizeLowerText(
    source && source.shipClass,
    normalizeLowerText(contentProfile.hullMode, ""),
  );
  if (shipClass === "cruiser") return 1;
  if (shipClass === "destroyer") return 2;
  if (shipClass === "frigate") return 3;
  // Legacy non-Tranquil runs predate explicit hull-mode persistence and used
  // the three-filament/fleet cache output. Preserve that output on recovery.
  return ABYSSAL_CALM_TIER_REWARD_QUANTITY_MULTIPLIER;
}

function resolveMainAbyssalCacheFamily(ports, source, cacheProfile = {}) {
  const {
    cloneValue,
    TYPE_CAPTURED_TRIGLAVIAN_BIOADAPTIVE_CACHE,
    TYPE_CAPTURED_TRIGLAVIAN_BIOADAPTIVE_CACHE_WRECK,
    TYPE_ABYSSAL_BIOCOMBINATIVE_CACHE,
    TYPE_ABYSSAL_BIOCOMBINATIVE_CACHE_WRECK,
  } = ports;
  const rewardMultiplier = resolveAbyssalRequiredFilamentCount(ports, source);
  if (rewardMultiplier <= 1) {
    return {
      ...cloneValue(cacheProfile),
      cacheFamily: "triglavian_bioadaptive_cache",
      cacheTypeID: TYPE_CAPTURED_TRIGLAVIAN_BIOADAPTIVE_CACHE,
      cacheTypeName: "Triglavian Bioadaptive Cache",
      cacheDisplayName: "Triglavian Bioadaptive Cache",
      wreckTypeID: TYPE_CAPTURED_TRIGLAVIAN_BIOADAPTIVE_CACHE_WRECK,
      wreckTypeName: "Triglavian Bioadaptive Cache Wreck",
      rewardMultiplier,
    };
  }
  return {
    ...cloneValue(cacheProfile),
    cacheFamily: "triglavian_biocombinative_cache",
    cacheTypeID: TYPE_ABYSSAL_BIOCOMBINATIVE_CACHE,
    cacheTypeName: "Triglavian Biocombinative Cache",
    cacheDisplayName: "Triglavian Biocombinative Cache",
    wreckTypeID: TYPE_ABYSSAL_BIOCOMBINATIVE_CACHE_WRECK,
    wreckTypeName: "Biocombinative Cache Wreck",
    capturedRetailProfile: false,
    rewardMultiplier,
  };
}

function getExtractionNodeProfile(ports, source) {
  const {
    cloneValue,
  } = ports;
  const contentProfile = getContentProfile(ports, source) || source;
  return contentProfile && contentProfile.extractionNodeProfile && typeof contentProfile.extractionNodeProfile === "object"
    ? cloneValue(contentProfile.extractionNodeProfile)
    : null;
}

function createAbyssalContentViews(ports) {
  return {
    getContentProfile: getContentProfile.bind(null, ports),
    isCapturedT0DarkContent: isCapturedT0DarkContent.bind(null, ports),
    isTranquilAbyssalContent: isTranquilAbyssalContent.bind(null, ports),
    getT0DarkLayoutCompatibilityOptions: getT0DarkLayoutCompatibilityOptions.bind(null, ports),
    normalizeT0DarkLayoutSelectionState: normalizeT0DarkLayoutSelectionState.bind(null, ports),
    logT0DarkLayoutCatalogWarningsOnce: logT0DarkLayoutCatalogWarningsOnce.bind(null, ports),
    getCapturedT0DarkRoom: getCapturedT0DarkRoom.bind(null, ports),
    getCapturedAuthoredRoom: getCapturedAuthoredRoom.bind(null, ports),
    getCapturedAuthoredRoomEntity: getCapturedAuthoredRoomEntity.bind(null, ports),
    buildCapturedAuthoredDunRotation: buildCapturedAuthoredDunRotation.bind(null, ports),
    normalizeTranquilPresentationIdentity: normalizeTranquilPresentationIdentity.bind(null, ports),
    resolveAbyssalCachePresentationIdentity: resolveAbyssalCachePresentationIdentity.bind(null, ports),
    resolveTranquilCachePresentationIdentity: resolveTranquilCachePresentationIdentity.bind(null, ports),
    resolveTranquilConduitPresentationIdentity: resolveTranquilConduitPresentationIdentity.bind(null, ports),
    getCacheProfile: getCacheProfile.bind(null, ports),
    resolveAbyssalRequiredFilamentCount: resolveAbyssalRequiredFilamentCount.bind(null, ports),
    resolveMainAbyssalCacheFamily: resolveMainAbyssalCacheFamily.bind(null, ports),
    getExtractionNodeProfile: getExtractionNodeProfile.bind(null, ports),
  };
}

module.exports = { createAbyssalContentViews };
