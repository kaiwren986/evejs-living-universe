"use strict";

module.exports = {
  buildChangedStructureRows,
  buildStructureChangeMap,
  getSessionCorpID,
  getStructureOwnerCorpID,
  getStructureServiceStateSignature,
  getStructureSlimItemSignature,
  getStructureStaticEntitySignature,
  hasCorporationStructureDirectoryChange,
  haveStructureServiceStatesChanged,
  isSessionDockedInStructure,
  notifyCorporationStructuresUpdatedSessions,
  notifyCurrentStructureStateSessions,
  notifyDockedStructureHangarViewSessions,
  notifyDockedStructureServiceSessions,
  notifyStructureBrowserStateSessions,
  resolveStructureLifecyclePresentation,
  syncRuntimeStructureStateChanges,
};

const runtimeEntryDirname = require("path").resolve(__dirname, "..");
const {
  isAnsiblexStructure,
  getJumpBridgeDestinationSolarSystemID,
} = require("../../services/structure/structureJumpBridgeLinks");
const path = require("path");
const {
  STRUCTURE_STATE,
} = require(path.join(
  runtimeEntryDirname,
  "../services/structure/structureConstants",
));
const sessionRegistry = require(path.join(
  runtimeEntryDirname,
  "../services/chat/sessionRegistry",
));
const { notifyDockingAccessChangedForStructures } = require("../../services/structure/structureAccessNotifications");
const {
  buildStructureHangarViewState,
} = require(path.join(
  runtimeEntryDirname,
  "../services/structure/structureHangarViewState",
));
const destiny = require(path.join(runtimeEntryDirname, "./destiny/index.js"));
const {
  toInt,
} = require("../../common/numbers");

const STRUCTURE_REPAIR_COMPLETE_FX_GUID = "effects.StructureRepairStateComplete";

const STRUCTURE_ECM_BURST_FX_GUID = "effects.StructureECMBurst";

function getStructureStaticEntitySignature(entity) {
  return JSON.stringify({
    itemName: entity && entity.itemName,
    ownerID: entity && entity.ownerID,
    corporationID: entity && entity.corporationID,
    allianceID: entity && entity.allianceID,
    state: entity && entity.state,
    stateStartedAt: entity && entity.stateStartedAt,
    stateEndsAt: entity && entity.stateEndsAt,
    deployStartedAt: entity && entity.deployStartedAt,
    deployEndsAt: entity && entity.deployEndsAt,
    timerPausedAt: entity && entity.timerPausedAt,
    upkeepState: entity && entity.upkeepState,
    deedState: entity && entity.deedState,
    repairing: entity && entity.repairing,
    serviceStates: entity && entity.serviceStates,
    modules: entity && entity.modules,
    targetSolarsystemID: entity && entity.targetSolarsystemID,
    activationState: entity && entity.activationState,
    dunRotation: entity && entity.dunRotation,
    destinationID: entity && entity.destinationID,
    unanchoring: entity && entity.unanchoring,
    selfDestructTime: entity?.selfDestructTime === undefined ? undefined : String(entity.selfDestructTime),
    shieldCapacity: entity && entity.shieldCapacity,
    armorHP: entity && entity.armorHP,
    structureHP: entity && entity.structureHP,
    conditionState: entity && entity.conditionState,
    tetheringRange: entity && entity.tetheringRange,
    tetherRepairEffectMode: entity && entity.tetherRepairEffectMode,
    maxTargetRange: entity && entity.maxTargetRange,
    maxLockedTargets: entity && entity.maxLockedTargets,
    docked: entity && entity.docked,
    entosisCapture: entity && entity.entosisCapture,
    campaignSourceInfo: entity && entity.campaignSourceInfo,
    moonID: entity && entity.moonID,
    autoMoonMinerLastHarvestAt: entity && entity.autoMoonMinerLastHarvestAt,
  });
}

function getStructureSlimItemSignature(entity) {
  return JSON.stringify(
    destiny.buildSlimItemDict(entity),
    (_key, value) => (typeof value === "bigint" ? String(value) : value),
  );
}

function buildChangedStructureRows(changePayload = {}) {
  const previousByID = new Map(
    (Array.isArray(changePayload.previousRows)
      ? changePayload.previousRows
      : [])
      .map((row) => [toInt(row && row.structureID, 0), row])
      .filter(([structureID]) => structureID > 0),
  );
  const nextByID = new Map(
    (Array.isArray(changePayload.nextRows) ? changePayload.nextRows : [])
      .map((row) => [toInt(row && row.structureID, 0), row])
      .filter(([structureID]) => structureID > 0),
  );
  const structureIDs = new Set([
    ...previousByID.keys(),
    ...nextByID.keys(),
  ]);

  return [...structureIDs]
    .map((structureID) => ({
      structureID,
      previous: previousByID.get(structureID) || null,
      next: nextByID.get(structureID) || null,
    }))
    .filter(
      (entry) =>
        JSON.stringify(entry.previous) !== JSON.stringify(entry.next),
    );
}

function buildStructureChangeMap(changedStructures = []) {
  return new Map(
    (Array.isArray(changedStructures) ? changedStructures : [])
      .map((change) => [
        toInt(change && change.structureID, 0),
        change,
      ])
      .filter(([structureID]) => structureID > 0),
  );
}

function resolveStructureLifecyclePresentation(previous = null, next = null) {
  const previousState = toInt(previous && previous.state, 0);
  const nextState = toInt(next && next.state, 0);
  if (!previous || !next || previousState === nextState) {
    return null;
  }

  if (
    previousState === STRUCTURE_STATE.ANCHOR_VULNERABLE &&
    nextState === STRUCTURE_STATE.ANCHORING
  ) {
    return { includeRepairCompleteFx: true };
  }
  if (
    previousState === STRUCTURE_STATE.ANCHORING &&
    nextState === STRUCTURE_STATE.ONLINING_VULNERABLE
  ) {
    return { includeRepairCompleteFx: false };
  }
  if (
    previousState === STRUCTURE_STATE.ONLINING_VULNERABLE &&
    nextState === STRUCTURE_STATE.SHIELD_VULNERABLE
  ) {
    return { includeRepairCompleteFx: true };
  }

  return null;
}

function hasCorporationStructureDirectoryChange(previous = null, next = null) {
  if (!previous || !next) {
    return Boolean(previous || next);
  }
  return (
    toInt(previous.state, 0) !== toInt(next.state, 0) ||
    toInt(previous.upkeepState, 0) !== toInt(next.upkeepState, 0) ||
    (previous.hasQuantumCore === true) !== (next.hasQuantumCore === true) ||
    haveStructureServiceStatesChanged(previous, next)
  );
}

function isSessionDockedInStructure(session, structureID) {
  return (
    toInt(structureID, 0) > 0 &&
    toInt(session && (session.structureID || session.structureid), 0) ===
      toInt(structureID, 0)
  );
}

function getStructureOwnerCorpID(structure = null) {
  return toInt(
    structure &&
      (
        structure.ownerCorpID ||
        structure.ownerID ||
        structure.corporationID
      ),
    0,
  );
}

function getSessionCorpID(session = null) {
  return toInt(
    session && (session.corpid || session.corporationID || session.corpID),
    0,
  );
}

function notifyDockedStructureHangarViewSessions(changedStructures = []) {
  if (!Array.isArray(changedStructures) || changedStructures.length === 0) {
    return 0;
  }

  let deliveredCount = 0;
  const sessions =
    typeof sessionRegistry.getSessions === "function"
      ? sessionRegistry.getSessions()
      : [];
  for (const change of changedStructures) {
    const structure = change && change.next ? change.next : null;
    const structureID = toInt(change && change.structureID, 0);
    if (!structure || structureID <= 0) {
      continue;
    }
    const hangarViewState = buildStructureHangarViewState(structure);

    for (const session of sessions) {
      if (
        !isSessionDockedInStructure(session, structureID) ||
        typeof session.sendNotification !== "function"
      ) {
        continue;
      }
      session.sendNotification(
        "OnHangarViewStateUpdated",
        "structureid",
        [structureID, hangarViewState],
      );
      deliveredCount += 1;
    }
  }

  return deliveredCount;
}

function notifyStructureBrowserStateSessions(changedStructures = []) {
  if (!Array.isArray(changedStructures) || changedStructures.length === 0) {
    return 0;
  }

  const sessions =
    typeof sessionRegistry.getSessions === "function"
      ? sessionRegistry.getSessions()
      : [];
  let deliveredCount = 0;

  for (const change of changedStructures) {
    const previous = change && change.previous ? change.previous : null;
    const next = change && change.next ? change.next : null;
    const structureID = toInt(
      (change && change.structureID) ||
        (next && next.structureID) ||
        (previous && previous.structureID),
      0,
    );
    const previousState = toInt(previous && previous.state, 0);
    const nextState = toInt(next && next.state, 0);
    const ownerCorpID =
      getStructureOwnerCorpID(next) || getStructureOwnerCorpID(previous);
    const solarSystemID = toInt(
      (next && next.solarSystemID) || (previous && previous.solarSystemID),
      0,
    );

    if (
      !next ||
      structureID <= 0 ||
      nextState <= 0 ||
      ownerCorpID <= 0 ||
      previousState === nextState
    ) {
      continue;
    }

    for (const session of sessions) {
      if (
        getSessionCorpID(session) !== ownerCorpID ||
        typeof session.sendNotification !== "function"
      ) {
        continue;
      }
      session.sendNotification(
        "OnStructureStateChanged",
        "clientID",
        [solarSystemID, structureID, nextState],
      );
      deliveredCount += 1;
    }
  }

  return deliveredCount;
}

function getStructureServiceStateSignature(structure = null) {
  const serviceStates =
    structure &&
    structure.serviceStates &&
    typeof structure.serviceStates === "object"
      ? structure.serviceStates
      : {};
  return JSON.stringify(
    Object.entries(serviceStates)
      .map(([serviceID, stateID]) => [
        toInt(serviceID, 0),
        toInt(stateID, 0),
      ])
      .filter(([serviceID]) => serviceID > 0)
      .sort((left, right) => left[0] - right[0]),
  );
}

function haveStructureServiceStatesChanged(
  previousStructure = null,
  nextStructure = null,
) {
  return (
    getStructureServiceStateSignature(previousStructure) !==
    getStructureServiceStateSignature(nextStructure)
  );
}

function notifyDockedStructureServiceSessions(changedStructures = []) {
  if (!Array.isArray(changedStructures) || changedStructures.length === 0) {
    return 0;
  }

  const sessions =
    typeof sessionRegistry.getSessions === "function"
      ? sessionRegistry.getSessions()
      : [];
  let deliveredCount = 0;

  for (const change of changedStructures) {
    const structureID = toInt(change && change.structureID, 0);
    if (
      structureID <= 0 ||
      !change ||
      !change.next ||
      !haveStructureServiceStatesChanged(change.previous, change.next)
    ) {
      continue;
    }

    for (const session of sessions) {
      if (
        !isSessionDockedInStructure(session, structureID) ||
        typeof session.sendNotification !== "function"
      ) {
        continue;
      }
      session.sendNotification(
        "OnStructureServiceChanged",
        "clientID",
        [structureID],
      );
      deliveredCount += 1;
    }
  }

  return deliveredCount;
}

function notifyCurrentStructureStateSessions(changedStructures = []) {
  if (!Array.isArray(changedStructures) || changedStructures.length === 0) {
    return 0;
  }

  const sessions =
    typeof sessionRegistry.getSessions === "function"
      ? sessionRegistry.getSessions()
      : [];
  let deliveredCount = 0;

  for (const change of changedStructures) {
    const previous = change && change.previous ? change.previous : null;
    const next = change && change.next ? change.next : null;
    const structureID = toInt(change && change.structureID, 0);
    const nextState = toInt(next && next.state, 0);
    if (
      !previous ||
      !next ||
      structureID <= 0 ||
      nextState <= 0 ||
      toInt(previous.state, 0) === nextState
    ) {
      continue;
    }
    const solarSystemID = toInt(next.solarSystemID || previous.solarSystemID, 0);
    for (const session of sessions) {
      if (
        toInt(session && (session.shipID || session.shipid), 0) !== structureID &&
        toInt(session && (session.structureID || session.structureid), 0) !== structureID
      ) {
        continue;
      }
      if (typeof session.sendNotification !== "function") {
        continue;
      }
      session.sendNotification(
        "OnCurrentStructureStateChanged",
        "shipid",
        [solarSystemID, structureID, nextState],
      );
      deliveredCount += 1;
    }
  }

  return deliveredCount;
}

function notifyCorporationStructuresUpdatedSessions(changedStructures = []) {
  if (!Array.isArray(changedStructures) || changedStructures.length === 0) {
    return 0;
  }

  const corporationIDs = new Set();
  for (const change of changedStructures) {
    const previous = change && change.previous ? change.previous : null;
    const next = change && change.next ? change.next : null;
    if (!hasCorporationStructureDirectoryChange(previous, next)) {
      continue;
    }
    const ownerCorpID = getStructureOwnerCorpID(next) || getStructureOwnerCorpID(previous);
    if (ownerCorpID > 0) {
      corporationIDs.add(ownerCorpID);
    }
  }
  if (corporationIDs.size === 0) {
    return 0;
  }

  const sessions =
    typeof sessionRegistry.getSessions === "function"
      ? sessionRegistry.getSessions()
      : [];
  let deliveredCount = 0;
  for (const session of sessions) {
    if (
      !corporationIDs.has(getSessionCorpID(session)) ||
      typeof session.sendNotification !== "function"
    ) {
      continue;
    }
    session.sendNotification(
      "OnCorporationStructuresUpdated",
      "*corpid&corprole",
      [],
    );
    deliveredCount += 1;
  }
  return deliveredCount;
}

// TQ broadcasts OnDockingAccessChangedForCurrentSolarSystem to the structure's
// solar system (idtype *solarsystemid, no arguments) when a structure there
// changes, as it did after a citadel started anchoring (golden log "Citadel
// Launch - Position - Start Anchor Timer", line 1513). The client drops its
// cached list of the system's structures on it (structureDirectory.py) and
// refreshes brackets and docking proximity.
function notifyDockingAccessChangedSessions(changedStructures = []) {
  if (!Array.isArray(changedStructures) || changedStructures.length === 0) {
    return 0;
  }
  const structures = [];
  for (const change of changedStructures) {
    const previous = change && change.previous ? change.previous : null;
    const next = change && change.next ? change.next : null;
    if (!hasCorporationStructureDirectoryChange(previous, next)) {
      continue;
    }
    structures.push(next || previous);
  }
  return notifyDockingAccessChangedForStructures(structures);
}

function syncRuntimeStructureStateChanges(runtime, changePayload = {}) {
  if (!runtime) {
    return {
      syncedSystemCount: 0,
      dockedHangarDeliveryCount: 0,
      dockedServiceDeliveryCount: 0,
      currentStructureStateDeliveryCount: 0,
      structureBrowserDeliveryCount: 0,
      corporationStructuresUpdatedDeliveryCount: 0,
      dockingAccessChangedDeliveryCount: 0,
    };
  }
  const changedStructures = buildChangedStructureRows(changePayload);
  const systemIDs = [
    ...new Set(
      (Array.isArray(changePayload.systemIDs)
        ? changePayload.systemIDs
        : [])
        .map((systemID) => toInt(systemID, 0))
        .filter((systemID) => systemID > 0),
    ),
  ];
  // A remote bridge's alignment, fuel or removal changes the local Jump menu.
  // Include incoming links also when a new nearby structure blocks its service.
  const changedSystemIDs = new Set(systemIDs);
  const affectedSystemIDs = new Set(systemIDs);
  for (const change of changedStructures) {
    for (const bridge of [change.previous, change.next]) {
      if (isAnsiblexStructure(bridge)) {
        const destinationID = getJumpBridgeDestinationSolarSystemID(bridge);
        if (destinationID) affectedSystemIDs.add(destinationID);
      }
    }
  }
  // There is no index from a destination system back to the gates aimed at it,
  // so this scans every structure. It reads the live records rather than
  // listStructures, which would clone the whole table on each fanout.
  const structureState = require("../../services/structure/structureState");
  for (const bridge of structureState.peekStructures()) {
    if (isAnsiblexStructure(bridge) &&
      changedSystemIDs.has(getJumpBridgeDestinationSolarSystemID(bridge))) {
      affectedSystemIDs.add(Number(bridge.solarSystemID));
    }
  }
  let syncedSystemCount = 0;
  const currentStructureStateDeliveryCount =
    notifyCurrentStructureStateSessions(changedStructures);

  for (const systemID of affectedSystemIDs) {
    if (!(runtime.scenes instanceof Map) || !runtime.scenes.has(systemID)) {
      continue;
    }
    runtime.syncStructureSceneState(systemID, {
      reason: "structureStateChange",
      structureStateChanges: changedStructures,
    });
    syncedSystemCount += 1;
  }

  const dockedHangarDeliveryCount =
    notifyDockedStructureHangarViewSessions(changedStructures);
  const dockedServiceDeliveryCount =
    notifyDockedStructureServiceSessions(changedStructures);
  const structureBrowserDeliveryCount =
    notifyStructureBrowserStateSessions(changedStructures);
  const corporationStructuresUpdatedDeliveryCount =
    notifyCorporationStructuresUpdatedSessions(changedStructures);
  const dockingAccessChangedDeliveryCount =
    notifyDockingAccessChangedSessions(changedStructures);

  return {
    syncedSystemCount,
    dockedHangarDeliveryCount,
    dockedServiceDeliveryCount,
    currentStructureStateDeliveryCount,
    structureBrowserDeliveryCount,
    corporationStructuresUpdatedDeliveryCount,
    dockingAccessChangedDeliveryCount,
  };
}

Object.assign(module.exports, {
  STRUCTURE_ECM_BURST_FX_GUID,
  STRUCTURE_REPAIR_COMPLETE_FX_GUID,
});
