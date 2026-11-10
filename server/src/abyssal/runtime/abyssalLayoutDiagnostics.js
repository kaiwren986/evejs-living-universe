"use strict";
const { toInt, normalizeText, normalizeLowerText } = require("../domain/abyssalRuntimeValues");

function buildNewT0DarkLayoutSelection(ports, validation, runID) {
  const {
    getContentProfile,
    getT0DarkLayoutCompatibilityOptions,
    isCompatibleT0DarkLayoutRequest,
    logT0DarkLayoutCatalogWarningsOnce,
    selectT0DarkLayoutSet,
  } = ports;
  const traceState = validation && validation.data && validation.data.traceState || {};
  const contentProfile = getContentProfile(traceState) || {};
  const compatibility = getT0DarkLayoutCompatibilityOptions(contentProfile, {
    filamentTypeID: traceState.filamentTypeID,
  });
  if (!isCompatibleT0DarkLayoutRequest(compatibility)) {
    return { success: true, data: null };
  }
  logT0DarkLayoutCatalogWarningsOnce();
  const characterID = toInt(traceState.characterID, 0);
  const pendingOverride = ports.getT0DarkLayoutOverride(characterID) || null;
  return selectT0DarkLayoutSet({
    ...compatibility,
    runID,
    overrideLayoutID: normalizeText(pendingOverride && pendingOverride.layoutSetID, ""),
  });
}

function logNewT0DarkLayoutSelection(ports, runID, contentProfile, selectionState) {
  const {
    log,
  } = ports;
  if (!selectionState) return;
  const roomLayoutIDs = selectionState.selectedRoomLayoutIDs || {};
  log.info(
    `[AbyssalLayoutSelection] run=${toInt(runID, 0)} ` +
      `filamentTypeID=${toInt(contentProfile && contentProfile.filamentTypeID, 0)} ` +
      `tier=${toInt(contentProfile && contentProfile.tier, -1)} ` +
      `weather=${normalizeLowerText(contentProfile && contentProfile.weatherType, "unknown")} ` +
      `selectionModel=${normalizeText(selectionState.layoutSelectionModel, "unknown")} ` +
      `seed=${toInt(selectionState.layoutSelectionSeed, 0) >>> 0} ` +
      `layoutSetID=${normalizeText(selectionState.selectedLayoutSetID, "none")} ` +
      `room1LayoutID=${normalizeText(roomLayoutIDs["1"] || roomLayoutIDs[1], "none")} ` +
      `room2LayoutID=${normalizeText(roomLayoutIDs["2"] || roomLayoutIDs[2], "none")} ` +
      `room3LayoutID=${normalizeText(roomLayoutIDs["3"] || roomLayoutIDs[3], "none")} ` +
      `weights=${normalizeText(selectionState.layoutSelectionWeightsSummary, "none")} ` +
      `source=${normalizeText(selectionState.layoutSelectionSource, "random-selection")}`,
  );
}

function logRecoveredT0DarkLayoutSelection(ports, pocketState) {
  const {
    ABYSSAL_DIAGNOSTIC_DEDUPE_SCOPE,
    isCapturedT0DarkContent,
    normalizeT0DarkLayoutSelectionState,
    log,
  } = ports;
  const runID = toInt(pocketState && pocketState.instanceID, 0);
  if (
    runID <= 0 ||
    ports.hasDedupeKey(
      ABYSSAL_DIAGNOSTIC_DEDUPE_SCOPE.LAYOUT_RECOVERY,
      runID,
    ) ||
    !isCapturedT0DarkContent(pocketState)
  ) {
    return;
  }
  ports.recordDedupeKey(
    ABYSSAL_DIAGNOSTIC_DEDUPE_SCOPE.LAYOUT_RECOVERY,
    runID,
  );
  const selectionState = normalizeT0DarkLayoutSelectionState(pocketState);
  log.info(
    `[AbyssalLayoutSelection] run=${runID} state=recovered ` +
      `layoutSetID=${normalizeText(selectionState && selectionState.selectedLayoutSetID, "none")}`,
  );
}

function logAbyssalBaseRoomLayoutSelection(ports,
  runID,
  contentProfile,
  selectionState,
  state = "selected",
) {
  const {
    log,
  } = ports;
  if (!selectionState) return;
  const roomLayoutIDs = selectionState.selectedBaseRoomLayoutIDs || {};
  log.info(
    `[AbyssalBaseRoomLayoutSelection] run=${toInt(runID, 0)} ` +
      `state=${normalizeText(state, "selected")} ` +
      `filamentTypeID=${toInt(contentProfile && contentProfile.filamentTypeID, 0)} ` +
      `tier=${toInt(contentProfile && contentProfile.tier, -1)} ` +
      `weather=${normalizeLowerText(contentProfile && contentProfile.weatherType, "unknown")} ` +
      `selectionModel=${normalizeText(selectionState.baseRoomLayoutSelectionModel, "unknown")} ` +
      `seed=${toInt(selectionState.baseRoomLayoutSelectionSeed, 0) >>> 0} ` +
      `room1LayoutID=${normalizeText(roomLayoutIDs["1"] || roomLayoutIDs[1], "none")} ` +
      `room2LayoutID=${normalizeText(roomLayoutIDs["2"] || roomLayoutIDs[2], "none")} ` +
      `room3LayoutID=${normalizeText(roomLayoutIDs["3"] || roomLayoutIDs[3], "none")} ` +
      `source=${normalizeText(selectionState.baseRoomLayoutSelectionSource, "unknown")}`,
  );
}

function logRecoveredAbyssalBaseRoomLayoutSelection(ports, pocketState) {
  const {
    ABYSSAL_DIAGNOSTIC_DEDUPE_SCOPE,
    getContentProfile,
    normalizeAbyssalBaseRoomLayoutSelectionState,
  } = ports;
  const runID = toInt(pocketState && pocketState.instanceID, 0);
  if (
    runID <= 0 ||
    ports.hasDedupeKey(
      ABYSSAL_DIAGNOSTIC_DEDUPE_SCOPE.BASE_ROOM_LAYOUT_RECOVERY,
      runID,
    ) ||
    !pocketState ||
    !pocketState.selectedBaseRoomLayoutIDs
  ) {
    return;
  }
  ports.recordDedupeKey(
    ABYSSAL_DIAGNOSTIC_DEDUPE_SCOPE.BASE_ROOM_LAYOUT_RECOVERY,
    runID,
  );
  const contentProfile = getContentProfile(pocketState) || {};
  const selectionState = normalizeAbyssalBaseRoomLayoutSelectionState(
    pocketState || {},
    {
      runID,
      filamentTypeID: contentProfile.filamentTypeID,
      tier: contentProfile.tier,
      weatherType: contentProfile.weatherType,
    },
  );
  logAbyssalBaseRoomLayoutSelection(ports,
    runID,
    contentProfile,
    selectionState,
    "recovered",
  );
}

function createAbyssalLayoutDiagnostics(ports) {
  return {
    buildNewT0DarkLayoutSelection: buildNewT0DarkLayoutSelection.bind(null, ports),
    logNewT0DarkLayoutSelection: logNewT0DarkLayoutSelection.bind(null, ports),
    logRecoveredT0DarkLayoutSelection: logRecoveredT0DarkLayoutSelection.bind(null, ports),
    logAbyssalBaseRoomLayoutSelection: logAbyssalBaseRoomLayoutSelection.bind(null, ports),
    logRecoveredAbyssalBaseRoomLayoutSelection: logRecoveredAbyssalBaseRoomLayoutSelection.bind(null, ports),
  };
}

module.exports = { createAbyssalLayoutDiagnostics };
