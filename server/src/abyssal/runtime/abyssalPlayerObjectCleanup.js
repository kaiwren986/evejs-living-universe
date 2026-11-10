"use strict";

const { normalizeText } = require("../domain/abyssalValueUtils");

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function resolveExactAbyssalRunRoomScope(ports, source) {
  const {
    resolveEntityInteractionScope,
  } = ports;
  const scopeSource =
    source && source.scopeMetadata && typeof source.scopeMetadata === "object"
      ? source.scopeMetadata
      : source;
  const scope = resolveEntityInteractionScope(scopeSource);
  const runID = toInt(scope && scope.abyssalInstanceID, 0);
  const roomIndex = toInt(scope && scope.abyssalRoomIndex, 0);
  if (
    !scope ||
    scope.valid !== true ||
    scope.hasAbyssalScope !== true ||
    scope.hasAbyssalRoomScope !== true ||
    runID <= 0 ||
    roomIndex <= 0
  ) {
    return null;
  }
  return { runID, roomIndex };
}

function listAbyssalPlayerObjectAuthoritySources(ports, ...records) {
  const {
    parseCustomInfo,
  } = ports;
  const sources = [];
  for (const record of records) {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      continue;
    }
    sources.push(record);
    if (
      record.spaceState &&
      typeof record.spaceState === "object" &&
      !Array.isArray(record.spaceState)
    ) {
      sources.push(record.spaceState);
    }
    const parsedCustomInfo = parseCustomInfo(record.customInfo);
    for (const state of Object.values(parsedCustomInfo || {})) {
      if (state && typeof state === "object" && !Array.isArray(state)) {
        sources.push(state);
      }
    }
    if (
      record.interdictionProbeState &&
      typeof record.interdictionProbeState === "object" &&
      !Array.isArray(record.interdictionProbeState)
    ) {
      sources.push(record.interdictionProbeState);
    }
  }
  return sources;
}

function inspectExactAbyssalSourceRoomObjectScope(ports,
  pocketState,
  roomIndex,
  records,
) {
  const {
    resolveEntityInteractionScope,
    listPocketCleanupAnchors,
    inspectResidualPocketItemAuthority,
  } = ports;
  const runID = toInt(pocketState && pocketState.instanceID, 0);
  const cleanupAnchors = listPocketCleanupAnchors(pocketState);
  let exactAuthorityFound = false;
  for (const record of records) {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      continue;
    }
    const interactionScope = resolveEntityInteractionScope(record);
    if (
      interactionScope &&
      (interactionScope.hasAbyssalScope || interactionScope.hasAbyssalRoomScope)
    ) {
      if (
        interactionScope.valid !== true ||
        toInt(interactionScope.abyssalInstanceID, 0) !== runID ||
        (
          interactionScope.hasAbyssalRoomScope &&
          toInt(interactionScope.abyssalRoomIndex, 0) !== roomIndex
        )
      ) {
        return { authorized: false, reason: "SCOPE_AUTHORITY_CONFLICT" };
      }
      if (
        interactionScope.hasAbyssalRoomScope &&
        toInt(interactionScope.abyssalRoomIndex, 0) === roomIndex
      ) {
        exactAuthorityFound = true;
      }
    }

    const residualAuthority = inspectResidualPocketItemAuthority(
      record,
      pocketState,
      cleanupAnchors,
    );
    if (
      residualAuthority.authorized === true &&
      residualAuthority.canonical === true &&
      residualAuthority.runIDs.length === 1 &&
      residualAuthority.runIDs[0] === runID &&
      residualAuthority.roomIndexes.length === 1 &&
      residualAuthority.roomIndexes[0] === roomIndex
    ) {
      exactAuthorityFound = true;
      continue;
    }
    if (
      residualAuthority.reason !== "UNTAGGED_RUN" &&
      residualAuthority.reason !== "LEGACY_RUN_ANCHOR_REQUIRED" &&
      residualAuthority.reason !== "LEGACY_RUN_ANCHOR_AUTHORITY"
    ) {
      return {
        authorized: false,
        reason: residualAuthority.reason || "SCOPE_AUTHORITY_CONFLICT",
      };
    }
  }
  return exactAuthorityFound
    ? { authorized: true, reason: "EXACT_RUN_ROOM_AUTHORITY" }
    : { authorized: false, reason: "EXACT_RUN_ROOM_AUTHORITY_REQUIRED" };
}

function inspectAbyssalPlayerCreatedObjectAuthority(ports,
  pocketState,
  records,
) {
  const participantCharacterID = toInt(pocketState && pocketState.characterID, 0);
  const participantShipID = toInt(pocketState && pocketState.shipID, 0);
  const authoritySources = listAbyssalPlayerObjectAuthoritySources(ports, ...records);
  const ownerFields = [
    "ownerCharacterID",
    "controllerOwnerID",
    "launcherCharacterID",
    "characterID",
    "pilotCharacterID",
    "ownerID",
  ];
  const controllerFields = [
    "controllerID",
    "controllerShipID",
    "launcherID",
    "sourceShipID",
    "launchShipID",
    "ownerShipID",
    "shipID",
  ];
  const collectClaims = (fields) => [
    ...new Set(authoritySources.flatMap((source) => fields
      .map((field) => toInt(source && source[field], 0))
      .filter((value) => value > 0))),
  ];
  const ownerClaims = collectClaims(ownerFields);
  const controllerClaims = collectClaims(controllerFields);
  if (
    participantCharacterID <= 0 ||
    participantShipID <= 0 ||
    (
      ownerClaims.length > 0 &&
      ownerClaims.some((ownerID) => ownerID !== participantCharacterID)
    ) ||
    (
      controllerClaims.length > 0 &&
      controllerClaims.some((controllerID) => controllerID !== participantShipID)
    )
  ) {
    return {
      authorized: false,
      reason: "PLAYER_OBJECT_OWNER_CONFLICT",
      ownerClaims,
      controllerClaims,
    };
  }
  if (ownerClaims.length === 0 && controllerClaims.length === 0) {
    return {
      authorized: false,
      reason: "PLAYER_OBJECT_OWNER_AUTHORITY_REQUIRED",
      ownerClaims,
      controllerClaims,
    };
  }
  return {
    authorized: true,
    reason: "EXACT_PARTICIPANT_OBJECT_AUTHORITY",
    ownerClaims,
    controllerClaims,
  };
}

function isRetainedAbyssalPlayerCompanion(ports, records) {
  const {
    parseCustomInfo,
    normalizeLowerText,
    CATEGORY_DRONE,
    CATEGORY_FIGHTER,
  } = ports;
  for (const record of records) {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      continue;
    }
    const kind = normalizeLowerText(record.kind, "");
    const categoryID = toInt(record.categoryID, 0);
    if (
      ["drone", "fighter", "player_companion"].includes(kind) ||
      categoryID === CATEGORY_DRONE ||
      categoryID === CATEGORY_FIGHTER
    ) {
      return true;
    }
    const parsedCustomInfo = parseCustomInfo(record.customInfo);
    if (
      parsedCustomInfo.evejsAbyssalPlayerCompanion &&
      typeof parsedCustomInfo.evejsAbyssalPlayerCompanion === "object"
    ) {
      return true;
    }
  }
  return false;
}

function recordReferencesActiveAbyssalCompanionController(ports,
  record,
  shipID,
  options = {},
) {
  const {
    parseCustomInfo,
  } = ports;
  const numericShipID = toInt(shipID, 0);
  if (!record || typeof record !== "object" || numericShipID <= 0) {
    return false;
  }
  const sources = [record];
  if (options.includeSerializedState !== false) {
    sources.push(
      record.spaceState,
      record.fighterState,
      parseCustomInfo(record.customInfo).evejsAbyssalPlayerCompanion,
    );
  }
  return sources.some((source) =>
    source && typeof source === "object" && [
      source.controllerID,
      source.launcherID,
    ].some((value) => toInt(value, 0) === numericShipID)
  );
}

function buildAbandonedAbyssalCompanionInventoryState(ports, currentItem) {
  const {
    parseCustomInfo,
  } = ports;
  const clearControllerState = (state) =>
    state && typeof state === "object" && !Array.isArray(state)
      ? {
        ...state,
        launcherID: null,
        controllerID: null,
        controllerOwnerID: 0,
        targetID: null,
        targetEntityID: null,
        droneCommand: null,
        fighterCommand: null,
        fighterRecallTubeFlagID: null,
        tubeFlagID: null,
      }
      : state;
  const parsedCustomInfo = parseCustomInfo(currentItem && currentItem.customInfo);
  let customInfo = currentItem && currentItem.customInfo;
  if (
    parsedCustomInfo.evejsAbyssalPlayerCompanion &&
    typeof parsedCustomInfo.evejsAbyssalPlayerCompanion === "object"
  ) {
    parsedCustomInfo.evejsAbyssalPlayerCompanion = {
      ...parsedCustomInfo.evejsAbyssalPlayerCompanion,
      controllerID: null,
    };
    customInfo = JSON.stringify(parsedCustomInfo);
  }
  return {
    ...currentItem,
    launcherID: null,
    controllerID: null,
    controllerOwnerID: 0,
    tubeFlagID: null,
    customInfo,
    spaceState: clearControllerState(currentItem && currentItem.spaceState),
    fighterState: clearControllerState(currentItem && currentItem.fighterState),
  };
}

function resolveAbyssalRetirablePlayerObjectKind(ports, records) {
  const {
    parseCustomInfo,
    normalizeLowerText,
    CATEGORY_DEPLOYABLE,
    GROUP_WARP_DISRUPTION_PROBE,
  } = ports;
  for (const record of records) {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      continue;
    }
    const parsedCustomInfo = parseCustomInfo(record.customInfo);
    if (
      record.evejsAbyssalJettisonContainer === true ||
      (
        parsedCustomInfo.evejsAbyssalJettisonContainer &&
        typeof parsedCustomInfo.evejsAbyssalJettisonContainer === "object"
      )
    ) {
      return "jettison_container";
    }
    if (
      toInt(record.groupID, 0) === GROUP_WARP_DISRUPTION_PROBE ||
      record.interdictionProbeState ||
      (
        parsedCustomInfo.evejsInterdictionProbe &&
        typeof parsedCustomInfo.evejsInterdictionProbe === "object"
      )
    ) {
      return "interdiction_probe";
    }
  }
  for (const record of records) {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      continue;
    }
    const kind = normalizeLowerText(record.kind, "");
    const groupName = normalizeLowerText(record.groupName, "");
    if (
      kind === "deployable" ||
      toInt(record.categoryID, 0) === CATEGORY_DEPLOYABLE
    ) {
      return "deployable";
    }
    if (
      ["container", "jettison_container", "cargo_container"].includes(kind) ||
      groupName === "cargo container" ||
      groupName === "secure cargo container"
    ) {
      return "player_container";
    }
  }
  return "";
}

// Persist exact companion ownership release before detaching runtime controllers.
function abandonExactAbyssalSourceRoomPlayerCompanions(ports, pocketState, roomIndex, deps, reason = "room-transition") {
  const work = { pocketState, roomIndex, deps, reason };
  const unavailable = prepareCompanionAbandonment(ports, work);
  if (unavailable) return unavailable;
  collectCompanionCandidates(ports, work);
  persistCompanionAbandonment(ports, work);
  releaseCompanionControllers(ports, work);
  return verifyCompanionAbandonment(ports, work);
}

function prepareCompanionAbandonment(ports, work) {
  const {
    getPocketScene,
  } = ports;
  const {
    pocketState,
    roomIndex,
    deps,
  } = work;
  const runID = toInt(pocketState && pocketState.instanceID, 0);
  const numericRoomIndex = toInt(roomIndex, 0);
  const systemID = toInt(pocketState && pocketState.solarSystemID, 0);
  const participantShipID = toInt(pocketState && pocketState.shipID, 0);
  const scene = getPocketScene(pocketState, deps);
  const controllerEntity =
  scene && typeof scene.getEntityByID === "function"
    ? scene.getEntityByID(participantShipID)
    : null;
  const summary = {
    considered: 0,
    abandoned: 0,
    alreadyAbandoned: 0,
    failed: 0,
    diagnosticSkipped: 0,
  };
  const abandonedItemIDs = [];
  const diagnostics = [];
  if (
    runID <= 0 ||
    numericRoomIndex <= 0 ||
    systemID <= 0 ||
    participantShipID <= 0 ||
    !scene ||
    !controllerEntity ||
    !deps ||
    typeof deps.listSystemSpaceItems !== "function" ||
    typeof deps.findItemById !== "function" ||
    typeof deps.updateInventoryItem !== "function" ||
    typeof deps.releaseAbyssalPlayerCompanionsForController !== "function"
  ) {
    return {
      success: false,
      errorMsg: "ABYSSAL_SOURCE_PLAYER_COMPANION_ABANDON_UNAVAILABLE",
      abandonedItemIDs,
      cleanupSummary: { ...summary, failed: 1 },
      diagnostics: [{ reason: "PLAYER_COMPANION_ABANDON_AUTHORITY_UNAVAILABLE" }],
    };
  }
  let inventoryItems;
  try {
    inventoryItems = deps.listSystemSpaceItems(systemID);
  } catch (error) {
    inventoryItems = null;
    diagnostics.push({
      reason: normalizeText(error && error.message, "PLAYER_COMPANION_ENUMERATION_FAILED"),
    });
  }
  if (!Array.isArray(inventoryItems)) {
    return {
      success: false,
      errorMsg: "ABYSSAL_SOURCE_PLAYER_COMPANION_ENUMERATION_FAILED",
      abandonedItemIDs,
      cleanupSummary: { ...summary, failed: 1 },
      diagnostics,
    };
  }
  Object.assign(work, { runID, numericRoomIndex, systemID, participantShipID, scene, controllerEntity, summary, abandonedItemIDs, diagnostics, inventoryItems });
}

function collectCompanionCandidates(ports, work) {
  const {
    inventoryItems,
    participantShipID,
    scene,
    deps,
  } = work;
  const candidatesByItemID = new Map();
  const addCandidate = (record, sourceKey) => {
    const itemID = toInt(record && record.itemID, 0);
    if (itemID <= 0 || itemID === participantShipID) {
      return;
    }
    const candidate = candidatesByItemID.get(itemID) || {
      itemID,
      inventoryItem: null,
      sceneEntity: null,
    };
    candidate[sourceKey] = record;
    candidatesByItemID.set(itemID, candidate);
  };
  for (const item of inventoryItems) {
    addCandidate(item, "inventoryItem");
  }
  if (scene.dynamicEntities instanceof Map) {
    for (const entity of scene.dynamicEntities.values()) {
      addCandidate(entity, "sceneEntity");
      if (isRetainedAbyssalPlayerCompanion(ports, [entity])) {
        const inventoryItem = deps.findItemById(toInt(entity && entity.itemID, 0));
        if (inventoryItem) {
          addCandidate(inventoryItem, "inventoryItem");
        }
      }
    }
  }
  const droneEntityIDs = [];
  const fighterEntityIDs = [];
  Object.assign(work, { candidatesByItemID, droneEntityIDs, fighterEntityIDs });
}

function persistCompanionAbandonment(ports, work) {
  const {
    parseCustomInfo,
    normalizeLowerText,
    CATEGORY_FIGHTER,
  } = ports;
  const {
    pocketState,
    numericRoomIndex,
    deps,
    participantShipID,
    candidatesByItemID,
    summary,
    diagnostics,
    droneEntityIDs,
    fighterEntityIDs,
    abandonedItemIDs,
  } = work;
  for (const candidate of candidatesByItemID.values()) {
    const records = [candidate.inventoryItem, candidate.sceneEntity].filter(Boolean);
    if (!isRetainedAbyssalPlayerCompanion(ports, records)) {
      continue;
    }
    const referencesParticipantController = Boolean(
      recordReferencesActiveAbyssalCompanionController(ports,
        candidate.inventoryItem,
        participantShipID,
      ) ||
      recordReferencesActiveAbyssalCompanionController(ports,
        candidate.sceneEntity,
        participantShipID,
        { includeSerializedState: false },
      )
    );
    if (!referencesParticipantController) {
      summary.alreadyAbandoned += 1;
      continue;
    }
    summary.considered += 1;
    const scopeAuthority = inspectExactAbyssalSourceRoomObjectScope(ports,
      pocketState,
      numericRoomIndex,
      records,
    );
    const playerAuthority = inspectAbyssalPlayerCreatedObjectAuthority(ports,
      pocketState,
      records,
    );
    if (scopeAuthority.authorized !== true || playerAuthority.authorized !== true) {
      summary.failed += 1;
      diagnostics.push({
        itemID: candidate.itemID,
        reason: scopeAuthority.authorized !== true
          ? scopeAuthority.reason
          : playerAuthority.reason,
      });
      continue;
    }
    if (!candidate.inventoryItem) {
      summary.failed += 1;
      diagnostics.push({
        itemID: candidate.itemID,
        reason: "PLAYER_COMPANION_INVENTORY_AUTHORITY_REQUIRED",
      });
      continue;
    }
    const persistResult = deps.updateInventoryItem(
      candidate.itemID,
      currentItem => buildAbandonedAbyssalCompanionInventoryState(ports, currentItem),
    );
    if (!persistResult || persistResult.success !== true) {
      summary.failed += 1;
      diagnostics.push({
        itemID: candidate.itemID,
        reason: normalizeText(
          persistResult && persistResult.errorMsg,
          "PLAYER_COMPANION_ABANDON_PERSIST_FAILED",
        ),
      });
      continue;
    }
    const companionKind = records.some((record) =>
      normalizeLowerText(record && record.kind, "") === "fighter" ||
      toInt(record && record.categoryID, 0) === CATEGORY_FIGHTER ||
      normalizeLowerText(
        parseCustomInfo(record && record.customInfo).evejsAbyssalPlayerCompanion &&
          parseCustomInfo(record && record.customInfo).evejsAbyssalPlayerCompanion.companionKind,
        "",
      ) === "fighter"
    )
      ? "fighter"
      : "drone";
    (companionKind === "fighter" ? fighterEntityIDs : droneEntityIDs)
      .push(candidate.itemID);
    abandonedItemIDs.push(candidate.itemID);
  }
}

function releaseCompanionControllers(ports, work) {
  const {
    deps,
    reason,
    summary,
    droneEntityIDs,
    fighterEntityIDs,
    scene,
    controllerEntity,
    diagnostics,
  } = work;
  if (summary.failed === 0 && (droneEntityIDs.length > 0 || fighterEntityIDs.length > 0)) {
    let releaseResult = null;
    try {
      releaseResult = deps.releaseAbyssalPlayerCompanionsForController(
        scene,
        controllerEntity,
        {
          droneEntityIDs,
          fighterEntityIDs,
          lifecycleReason: "abyssal-room-transition",
          stopMovement: true,
          notify: true,
          reason,
        },
      );
    } catch (error) {
      releaseResult = {
        success: false,
        errorMsg: normalizeText(error && error.message, "PLAYER_COMPANION_RUNTIME_RELEASE_FAILED"),
      };
    }
    if (!releaseResult || releaseResult.success !== true) {
      summary.failed += 1;
      diagnostics.push({
        reason: normalizeText(
          releaseResult && releaseResult.errorMsg,
          "PLAYER_COMPANION_RUNTIME_RELEASE_FAILED",
        ),
      });
    }
  }
}

function verifyCompanionAbandonment(ports, work) {
  const {
    log,
  } = ports;
  const {
    deps,
    summary,
    abandonedItemIDs,
    participantShipID,
    scene,
    diagnostics,
    runID,
    numericRoomIndex,
  } = work;
  if (summary.failed === 0) {
    for (const itemID of abandonedItemIDs) {
      const persistedItem = deps.findItemById(itemID);
      const runtimeEntity = typeof scene.getEntityByID === "function"
        ? scene.getEntityByID(itemID)
        : null;
      if (
        recordReferencesActiveAbyssalCompanionController(ports, persistedItem, participantShipID) ||
        recordReferencesActiveAbyssalCompanionController(ports,
          runtimeEntity,
          participantShipID,
          { includeSerializedState: false },
        )
      ) {
        summary.failed += 1;
        diagnostics.push({
          itemID,
          reason: "PLAYER_COMPANION_CONTROLLER_STATE_REMAINS",
        });
      } else {
        summary.abandoned += 1;
      }
    }
  }
  if (summary.failed > 0 || summary.diagnosticSkipped > 0) {
    log.warn(
      `[AbyssalPlayerCompanionAbandon] run=${runID} room=${numericRoomIndex} ` +
        `considered=${summary.considered} abandoned=${summary.abandoned} ` +
        `alreadyAbandoned=${summary.alreadyAbandoned} failed=${summary.failed} ` +
        `entries=${diagnostics.map((entry) =>
          `${toInt(entry.itemID, 0) || "unknown"}:${entry.reason}`).join(",") || "none"}`,
    );
  }
  return {
    success: summary.failed === 0,
    errorMsg: summary.failed > 0
      ? "ABYSSAL_SOURCE_PLAYER_COMPANION_ABANDON_FAILED"
      : null,
    abandonedItemIDs,
    cleanupSummary: summary,
    diagnostics,
  };
}

// Conflicting player-object authority is diagnostic-only, never permission to delete.
function retireExactAbyssalSourceRoomPlayerObjects(ports, pocketState, roomIndex, deps, reason = "room-transition") {
  const work = { pocketState, roomIndex, deps, reason };
  const unavailable = preparePlayerObjectRetirement(ports, work);
  if (unavailable) return unavailable;
  collectPlayerObjectCandidates(ports, work);
  retirePlayerObjectCandidates(ports, work);
  return finishPlayerObjectRetirement(ports, work);
}

function preparePlayerObjectRetirement(ports, work) {
  const {
    pocketState,
    roomIndex,
    deps,
  } = work;
  const runID = toInt(pocketState && pocketState.instanceID, 0);
  const numericRoomIndex = toInt(roomIndex, 0);
  const systemID = toInt(pocketState && pocketState.solarSystemID, 0);
  const summary = {
    considered: 0,
    removed: 0,
    alreadyGone: 0,
    failed: 0,
    skippedCompanions: 0,
    skippedAuthoredArtifacts: 0,
    diagnosticSkipped: 0,
  };
  const removedItemIDs = [];
  const diagnostics = [];
  if (
    runID <= 0 ||
    numericRoomIndex <= 0 ||
    systemID <= 0 ||
    !deps ||
    typeof deps.listSystemSpaceItems !== "function"
  ) {
    return {
      success: false,
      errorMsg: "ABYSSAL_SOURCE_PLAYER_OBJECT_ENUMERATION_UNAVAILABLE",
      removedItemIDs,
      cleanupSummary: { ...summary, failed: 1 },
      diagnostics: [{ reason: "PLAYER_OBJECT_ENUMERATION_UNAVAILABLE" }],
    };
  }
  let inventoryItems;
  try {
    inventoryItems = deps.listSystemSpaceItems(systemID);
  } catch (error) {
    return {
      success: false,
      errorMsg: "ABYSSAL_SOURCE_PLAYER_OBJECT_ENUMERATION_FAILED",
      removedItemIDs,
      cleanupSummary: { ...summary, failed: 1 },
      diagnostics: [{
        reason: normalizeText(error && error.message, "PLAYER_OBJECT_ENUMERATION_FAILED"),
      }],
    };
  }
  if (!Array.isArray(inventoryItems)) {
    return {
      success: false,
      errorMsg: "ABYSSAL_SOURCE_PLAYER_OBJECT_ENUMERATION_FAILED",
      removedItemIDs,
      cleanupSummary: { ...summary, failed: 1 },
      diagnostics: [{ reason: "PLAYER_OBJECT_ENUMERATION_RESULT_INVALID" }],
    };
  }
  Object.assign(work, { runID, numericRoomIndex, systemID, summary, removedItemIDs, diagnostics, inventoryItems });
}

function collectPlayerObjectCandidates(ports, work) {
  const {
    getPocketScene,
    buildTrackedPocketArtifactIDSet,
    listAbyssalRoomBootstrapEntityIDs,
  } = ports;
  const {
    pocketState,
    numericRoomIndex,
    deps,
    inventoryItems,
  } = work;
  const scene = getPocketScene(pocketState, deps);
  const candidatesByItemID = new Map();
  const addCandidate = (record, sourceKey) => {
    const itemID = toInt(record && record.itemID, 0);
    if (itemID <= 0) {
      return;
    }
    const candidate = candidatesByItemID.get(itemID) || {
      itemID,
      inventoryItem: null,
      sceneEntity: null,
    };
    candidate[sourceKey] = record;
    candidatesByItemID.set(itemID, candidate);
  };
  for (const item of inventoryItems) {
    addCandidate(item, "inventoryItem");
  }
  if (scene && scene.dynamicEntities instanceof Map) {
    for (const entity of scene.dynamicEntities.values()) {
      addCandidate(entity, "sceneEntity");
    }
  }
  const authoredArtifactIDs = new Set([
    ...buildTrackedPocketArtifactIDSet(pocketState),
    ...listAbyssalRoomBootstrapEntityIDs(pocketState, numericRoomIndex),
  ]);
  const participantShipID = toInt(pocketState && pocketState.shipID, 0);
  Object.assign(work, { scene, candidatesByItemID, authoredArtifactIDs, participantShipID });
}

function retirePlayerObjectCandidates(ports, work) {
  const {
    destroyResidualPocketSpaceItem,
  } = ports;
  const {
    pocketState,
    numericRoomIndex,
    deps,
    reason,
    candidatesByItemID,
    participantShipID,
    authoredArtifactIDs,
    summary,
    diagnostics,
    scene,
    removedItemIDs,
  } = work;
  for (const candidate of candidatesByItemID.values()) {
    const records = [candidate.inventoryItem, candidate.sceneEntity].filter(Boolean);
    if (candidate.itemID === participantShipID) {
      continue;
    }
    if (authoredArtifactIDs.has(candidate.itemID)) {
      summary.skippedAuthoredArtifacts += 1;
      continue;
    }
    if (isRetainedAbyssalPlayerCompanion(ports, records)) {
      summary.skippedCompanions += 1;
      continue;
    }
    const objectKind = resolveAbyssalRetirablePlayerObjectKind(ports, records);
    if (!objectKind) {
      continue;
    }
    summary.considered += 1;
    const scopeAuthority = inspectExactAbyssalSourceRoomObjectScope(ports,
      pocketState,
      numericRoomIndex,
      records,
    );
    const playerAuthority = inspectAbyssalPlayerCreatedObjectAuthority(ports,
      pocketState,
      records,
    );
    if (scopeAuthority.authorized !== true || playerAuthority.authorized !== true) {
      summary.diagnosticSkipped += 1;
      diagnostics.push({
        itemID: candidate.itemID,
        objectKind,
        reason: scopeAuthority.authorized !== true
          ? scopeAuthority.reason
          : playerAuthority.reason,
      });
      continue;
    }

    const removalResult = destroyResidualPocketSpaceItem(
      pocketState,
      candidate.itemID,
      deps,
      `${normalizeText(reason, "room-transition")}:${objectKind}`,
    );
    const remainingItem = typeof deps.findItemById === "function"
      ? deps.findItemById(candidate.itemID)
      : null;
    const remainingEntity = scene && typeof scene.getEntityByID === "function"
      ? scene.getEntityByID(candidate.itemID)
      : null;
    if (
      removalResult &&
      removalResult.removed === true &&
      !remainingItem &&
      !remainingEntity
    ) {
      summary.removed += 1;
      removedItemIDs.push(candidate.itemID);
    } else if (
      removalResult &&
      removalResult.alreadyGone === true &&
      !remainingItem &&
      !remainingEntity
    ) {
      summary.alreadyGone += 1;
    } else {
      summary.failed += 1;
      diagnostics.push({
        itemID: candidate.itemID,
        objectKind,
        reason: normalizeText(
          removalResult && removalResult.errorMsg,
          remainingEntity
            ? "PLAYER_OBJECT_RUNTIME_ENTITY_REMAINS"
            : remainingItem
              ? "PLAYER_OBJECT_INVENTORY_ITEM_REMAINS"
              : "PLAYER_OBJECT_RETIREMENT_FAILED",
        ),
      });
    }
  }
}

function finishPlayerObjectRetirement(ports, work) {
  const {
    log,
  } = ports;
  const {
    runID,
    numericRoomIndex,
    summary,
    diagnostics,
    removedItemIDs,
  } = work;
  if (summary.failed > 0 || summary.diagnosticSkipped > 0) {
    log.warn(
      `[AbyssalPlayerObjectRetirement] run=${runID} room=${numericRoomIndex} ` +
        `considered=${summary.considered} removed=${summary.removed} ` +
        `alreadyGone=${summary.alreadyGone} failed=${summary.failed} ` +
        `diagnosticOnly=${summary.diagnosticSkipped} entries=${diagnostics
          .map((entry) => `${toInt(entry.itemID, 0) || "unknown"}:${entry.reason}`)
          .join(",") || "none"}`,
    );
  }
  return {
    success: summary.failed === 0,
    errorMsg: summary.failed > 0
      ? "ABYSSAL_SOURCE_PLAYER_OBJECT_RETIREMENT_FAILED"
      : null,
    removedItemIDs,
    cleanupSummary: summary,
    diagnostics,
  };
}

function createAbyssalPlayerObjectCleanup(ports) {
  return {
    resolveExactAbyssalRunRoomScope: resolveExactAbyssalRunRoomScope.bind(null, ports),
    listAbyssalPlayerObjectAuthoritySources: listAbyssalPlayerObjectAuthoritySources.bind(null, ports),
    inspectExactAbyssalSourceRoomObjectScope: inspectExactAbyssalSourceRoomObjectScope.bind(null, ports),
    inspectAbyssalPlayerCreatedObjectAuthority: inspectAbyssalPlayerCreatedObjectAuthority.bind(null, ports),
    isRetainedAbyssalPlayerCompanion: isRetainedAbyssalPlayerCompanion.bind(null, ports),
    recordReferencesActiveAbyssalCompanionController: recordReferencesActiveAbyssalCompanionController.bind(null, ports),
    buildAbandonedAbyssalCompanionInventoryState: buildAbandonedAbyssalCompanionInventoryState.bind(null, ports),
    abandonExactAbyssalSourceRoomPlayerCompanions: abandonExactAbyssalSourceRoomPlayerCompanions.bind(null, ports),
    resolveAbyssalRetirablePlayerObjectKind: resolveAbyssalRetirablePlayerObjectKind.bind(null, ports),
    retireExactAbyssalSourceRoomPlayerObjects: retireExactAbyssalSourceRoomPlayerObjects.bind(null, ports),
  };
}

module.exports = { createAbyssalPlayerObjectCleanup };
