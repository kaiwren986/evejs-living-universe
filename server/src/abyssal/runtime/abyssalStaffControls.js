"use strict";
const { normalizeText, toInt } = require("../domain/abyssalRuntimeValues");

function listT0DarkLayoutsForStaff(ports) {
  const {
    logT0DarkLayoutCatalogWarningsOnce,
    listEnabledT0DarkLayoutSets,
    cloneValue,
  } = ports;
  logT0DarkLayoutCatalogWarningsOnce();
  return {
    success: true,
    data: listEnabledT0DarkLayoutSets().map((layoutSet) => ({
      layoutSetID: layoutSet.layoutSetID,
      tier: layoutSet.tier,
      weather: layoutSet.weather,
      filamentTypeIDs: cloneValue(layoutSet.filamentTypeIDs),
      enabled: layoutSet.enabled === true,
      selectionWeight: Number(layoutSet.selectionWeight) || 0,
      evidenceSource: normalizeText(layoutSet.evidence && layoutSet.evidence.sourceFile, "unknown"),
      roomLayoutIDs: Object.fromEntries(
        layoutSet.rooms.map((room) => [String(room.roomIndex), room.layoutID]),
      ),
    })),
  };
}

function setNextT0DarkLayoutForSession(ports, session, layoutSetID, deps = ports.getDependencies()) {
  const {
    getCharacterID,
    logT0DarkLayoutCatalogWarningsOnce,
    resolveT0DarkLayoutSetByID,
    isCompatibleT0DarkLayoutRequest,
    cloneValue,
  } = ports;
  const characterID = getCharacterID(session);
  if (characterID <= 0) return { success: false, errorMsg: "CHARACTER_ID_MISSING" };
  logT0DarkLayoutCatalogWarningsOnce();
  const layoutSet = resolveT0DarkLayoutSetByID(layoutSetID);
  if (!layoutSet || layoutSet.enabled !== true) {
    return { success: false, errorMsg: "UNKNOWN_OR_DISABLED_LAYOUT_ID" };
  }
  if (!isCompatibleT0DarkLayoutRequest({
    filamentTypeID: Array.isArray(layoutSet.filamentTypeIDs) ? layoutSet.filamentTypeIDs[0] : 0,
    tier: layoutSet.tier,
    weatherType: layoutSet.weather,
  })) {
    return { success: false, errorMsg: "INCOMPATIBLE_LAYOUT_ID" };
  }
  const pending = {
    layoutSetID: layoutSet.layoutSetID,
    characterID,
    setAtMs: toInt(deps.now(), Date.now()),
  };
  ports.setT0DarkLayoutOverride(characterID, pending);
  return { success: true, data: cloneValue(pending) };
}

function clearNextT0DarkLayoutForSession(ports, session) {
  const {
    getCharacterID,
  } = ports;
  const characterID = getCharacterID(session);
  if (characterID <= 0) return { success: false, errorMsg: "CHARACTER_ID_MISSING" };
  const cleared = ports.deleteT0DarkLayoutOverride(characterID);
  return { success: true, data: { characterID, cleared } };
}

function getT0DarkLayoutStatusForSession(ports, session) {
  const {
    getCharacterID,
    getActivePocketStateForSession,
    normalizeT0DarkLayoutSelectionState,
    getContentProfile,
    normalizeAbyssalBaseRoomLayoutSelectionState,
    cloneValue,
  } = ports;
  const characterID = getCharacterID(session);
  const pending = ports.getT0DarkLayoutOverride(characterID) || null;
  const activePocketState = getActivePocketStateForSession(session);
  const activeSelection = normalizeT0DarkLayoutSelectionState(activePocketState);
  const activeContentProfile = getContentProfile(activePocketState) || {};
  const activeBaseRoomSelection = activePocketState &&
      activePocketState.selectedBaseRoomLayoutIDs
    ? normalizeAbyssalBaseRoomLayoutSelectionState(activePocketState, {
        runID: activePocketState.instanceID,
        filamentTypeID: activeContentProfile.filamentTypeID,
        tier: activeContentProfile.tier,
        weatherType: activeContentProfile.weatherType,
      })
    : null;
  return {
    success: true,
    data: {
      characterID,
      pendingOverride: cloneValue(pending),
      activeRunID: toInt(activePocketState && activePocketState.instanceID, 0),
      activeSelection: cloneValue(activeSelection),
      activeBaseRoomSelection: cloneValue(activeBaseRoomSelection),
    },
  };
}

function setAbyssalSuppressorDebugForSession(ports, session, enabled, deps = ports.getDependencies()) {
  const {
    getActivePocketStateForSession,
    setSuppressorDebugForRun,
    getCharacterID,
  } = ports;
  const pocketState = getActivePocketStateForSession(session);
  if (!pocketState) {
    return { success: false, errorMsg: "NOT_IN_ACTIVE_ABYSSAL_RUN" };
  }
  return setSuppressorDebugForRun(
    toInt(pocketState.instanceID, 0),
    getCharacterID(session),
    enabled === true,
    toInt(deps.now(), Date.now()),
  );
}

function getAbyssalSuppressorDebugForSession(ports, session) {
  const {
    getActivePocketStateForSession,
    getSuppressorDebugSnapshot,
  } = ports;
  const pocketState = getActivePocketStateForSession(session);
  if (!pocketState) {
    return { success: false, errorMsg: "NOT_IN_ACTIVE_ABYSSAL_RUN" };
  }
  return {
    success: true,
    data: getSuppressorDebugSnapshot(toInt(pocketState.instanceID, 0)),
  };
}

function createAbyssalStaffControls(ports) {
  return {
    listT0DarkLayoutsForStaff: listT0DarkLayoutsForStaff.bind(null, ports),
    setNextT0DarkLayoutForSession: setNextT0DarkLayoutForSession.bind(null, ports),
    clearNextT0DarkLayoutForSession: clearNextT0DarkLayoutForSession.bind(null, ports),
    getT0DarkLayoutStatusForSession: getT0DarkLayoutStatusForSession.bind(null, ports),
    setAbyssalSuppressorDebugForSession: setAbyssalSuppressorDebugForSession.bind(null, ports),
    getAbyssalSuppressorDebugForSession: getAbyssalSuppressorDebugForSession.bind(null, ports),
  };
}

module.exports = { createAbyssalStaffControls };
