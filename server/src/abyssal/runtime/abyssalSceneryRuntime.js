"use strict";

const { normalizeText } = require("../domain/abyssalValueUtils");

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

// Scenery scene mutation and probe replacement; scene and run state are injected.
function destroyAbyssalSceneryVisualEntity({
  getPocketScene,
  isAbyssalEnvironmentVisualEntity,
},
  pocketStateOrSystemID,
  entityID,
  deps,
  reason = "cleanup",
  options = {},
) {
  const runtime = deps;
  if (!runtime || typeof runtime.ensureScene !== "function") {
    return {
      itemID: toInt(entityID, 0),
      failed: true,
      errorMsg: "SCENE_UNAVAILABLE",
    };
  }
  const scene =
    pocketStateOrSystemID && typeof pocketStateOrSystemID === "object"
      ? getPocketScene(pocketStateOrSystemID, deps)
      : runtime.ensureScene(toInt(pocketStateOrSystemID, 0));
  if (!scene || typeof scene.getEntityByID !== "function") {
    return {
      itemID: toInt(entityID, 0),
      failed: true,
      errorMsg: "SCENE_UNAVAILABLE",
    };
  }
  const entity = scene.getEntityByID(entityID);
  if (!entity || !isAbyssalEnvironmentVisualEntity(entity)) {
    return {
      itemID: toInt(entityID, 0),
      alreadyGone: true,
    };
  }
  if (typeof scene.removeStaticEntity !== "function") {
    return {
      itemID: toInt(entityID, 0),
      failed: true,
      errorMsg: "REMOVE_STATIC_UNSUPPORTED",
    };
  }
  const removeResult = scene.removeStaticEntity(entityID, {
    broadcast: options.broadcast !== false,
    nowMs: toInt(deps.now(), 0),
  });
  if (!removeResult || removeResult.success !== true) {
    return {
      itemID: toInt(entityID, 0),
      failed: true,
      errorMsg: normalizeText(removeResult && removeResult.errorMsg, reason),
    };
  }
  return {
    itemID: toInt(entityID, 0),
    removed: true,
  };
}

function ensureAbyssalSceneryVisuals({
  getDependencies,
  getActivePocketStateByInstanceID,
  cloneValue,
  resolveAbyssalSceneryProfile,
  buildPlaceholderRoomState,
  getPlaceholderRoomEntry,
  setPlaceholderRoomEntry,
  updatePocketState,
  buildPocketStateForCurrentRoom,
  getPocketScene,
  listAbyssalSceneryProfileEntries,
  materializeAbyssalSceneryProfileEntries,
  listUniquePositiveInts,
},
  pocketState,
  session = null,
  deps = getDependencies(),
  options = {},
) {
  const numericInstanceID = toInt(pocketState && pocketState.instanceID, 0);
  if (numericInstanceID <= 0) {
    return {
      success: false,
      errorMsg: "POCKET_STATE_MISSING",
    };
  }
  const resolvedPocketState =
    getActivePocketStateByInstanceID(numericInstanceID) || cloneValue(pocketState);
  const profileResolution = resolveAbyssalSceneryProfile(resolvedPocketState, deps);
  const roomState = buildPlaceholderRoomState(resolvedPocketState);
  const roomEntry = getPlaceholderRoomEntry(resolvedPocketState, roomState.currentRoomIndex);
  if (!profileResolution.applicable || !profileResolution.profile) {
    const nextRoomState = setPlaceholderRoomEntry(
      resolvedPocketState,
      roomState.currentRoomIndex,
      {
        ...roomEntry,
        sceneryVisualEntityIDs: [],
        sceneryVisualTypeIDs: [],
        sceneryVisualProfileID: profileResolution.profileID,
        sceneryVisualLifecycleState: "not_applicable",
        sceneryVisualBlockReason: profileResolution.blockReason,
      },
    );
    return {
      success: true,
      skipped: true,
      data: updatePocketState(numericInstanceID, buildPocketStateForCurrentRoom(resolvedPocketState, nextRoomState)),
    };
  }
  const scene = getPocketScene(resolvedPocketState, deps);
  if (
    !scene ||
    typeof scene.addStaticEntity !== "function" ||
    typeof scene.getEntityByID !== "function" ||
    typeof scene.broadcastAddBalls !== "function"
  ) {
    const nextRoomState = setPlaceholderRoomEntry(
      resolvedPocketState,
      roomState.currentRoomIndex,
      {
        ...roomEntry,
        sceneryVisualEntityIDs: [],
        sceneryVisualTypeIDs: [],
        sceneryVisualProfileID: profileResolution.profileID,
        sceneryVisualLifecycleState: "spawn_failed",
        sceneryVisualBlockReason: "SCENE_STATIC_ENTITY_UNSUPPORTED",
      },
    );
    return {
      success: false,
      errorMsg: "SCENE_STATIC_ENTITY_UNSUPPORTED",
      data: updatePocketState(numericInstanceID, buildPocketStateForCurrentRoom(resolvedPocketState, nextRoomState)),
    };
  }
  const profileEntries = listAbyssalSceneryProfileEntries(profileResolution.profile);
  if (profileEntries.length <= 0) {
    const nextRoomState = setPlaceholderRoomEntry(
      resolvedPocketState,
      roomState.currentRoomIndex,
      {
        ...roomEntry,
        sceneryVisualEntityIDs: [],
        sceneryVisualTypeIDs: [],
        sceneryVisualProfileID: profileResolution.profileID,
        sceneryVisualLifecycleState: "spawn_failed",
        sceneryVisualBlockReason: "TYPE_UNRESOLVED",
      },
    );
    return {
      success: false,
      errorMsg: "TYPE_UNRESOLVED",
      data: updatePocketState(numericInstanceID, buildPocketStateForCurrentRoom(resolvedPocketState, nextRoomState)),
    };
  }
  const materialization = materializeAbyssalSceneryProfileEntries(
    resolvedPocketState, roomState, roomEntry, profileResolution, profileEntries, scene, deps,
  );
  if (materialization.success !== true) return materialization;
  const { entitiesToBroadcast, spawnedEntityIDs, spawnedTypeIDs } = materialization;
  if (spawnedEntityIDs.length <= 0) {
    const nextRoomState = setPlaceholderRoomEntry(
      resolvedPocketState,
      roomState.currentRoomIndex,
      {
        ...roomEntry,
        sceneryVisualEntityIDs: [],
        sceneryVisualTypeIDs: [],
        sceneryVisualProfileID: profileResolution.profileID,
        sceneryVisualLifecycleState: "spawn_failed",
        sceneryVisualBlockReason: "SCENERY_ADD_FAILED",
      },
    );
    return {
      success: false,
      errorMsg: "SCENERY_ADD_FAILED",
      data: updatePocketState(numericInstanceID, buildPocketStateForCurrentRoom(resolvedPocketState, nextRoomState)),
    };
  }
  if (entitiesToBroadcast.length > 0 && options.broadcast !== false) {
    scene.broadcastAddBalls(entitiesToBroadcast, session || null, {});
  }
  const nextRoomState = setPlaceholderRoomEntry(
    resolvedPocketState,
    roomState.currentRoomIndex,
    {
      ...roomEntry,
      sceneryVisualEntityIDs: listUniquePositiveInts(spawnedEntityIDs),
      sceneryVisualTypeIDs: listUniquePositiveInts(spawnedTypeIDs),
      sceneryVisualProfileID: profileResolution.profileID,
      sceneryVisualSpawnedAtMs: toInt(deps.now(), 0),
      sceneryVisualLifecycleState: "spawned",
      sceneryVisualBlockReason: "none",
    },
  );
  const updatedPocketState = updatePocketState(
    numericInstanceID,
    buildPocketStateForCurrentRoom(resolvedPocketState, nextRoomState),
  );
  return {
    success: true,
    created: entitiesToBroadcast.length > 0,
    data: updatedPocketState || resolvedPocketState,
  };
}

function spawnAbyssalSceneryProbeForSession({
  getDependencies,
  getActivePocketStateForSession,
  isAbyssalSceneryVisualsRequested,
  ABYSSAL_SCENERY_GUARD_STATUS,
  getContentProfile,
  isSupportedCalmSceneryContentProfile,
  buildPlaceholderRoomState,
  resolveAbyssalSceneryProbeCandidate,
  resolveAbyssalSceneryProbePreset,
  getPocketScene,
  getPlaceholderRoomEntry,
  destroyAbyssalSceneryVisualEntity,
  buildAbyssalSceneryProbeEntity,
  recordAbyssalSceneryProbeMaterialization,
},
  session,
  candidateKey,
  presetKey = "near",
  deps = getDependencies(),
) {
  const pocketState = getActivePocketStateForSession(session);
  if (!pocketState) {
    return {
      success: false,
      errorMsg: "NOT_IN_ACTIVE_RUN",
    };
  }
  if (!isAbyssalSceneryVisualsRequested(deps)) {
    return {
      success: false,
      errorMsg: "ENV_DISABLED",
    };
  }
  if (ABYSSAL_SCENERY_GUARD_STATUS.active !== true) {
    return {
      success: false,
      errorMsg: "GUARDS_INACTIVE",
    };
  }
  const contentProfile = getContentProfile(pocketState) || {};
  if (!isSupportedCalmSceneryContentProfile(contentProfile)) {
    return {
      success: false,
      errorMsg: "PROFILE_NOT_APPLICABLE",
    };
  }
  const roomState = buildPlaceholderRoomState(pocketState);
  if (toInt(roomState && roomState.currentRoomIndex, 0) !== 1) {
    return {
      success: false,
      errorMsg: "ROOM_NOT_APPLICABLE",
    };
  }
  const candidate = resolveAbyssalSceneryProbeCandidate(candidateKey);
  if (!candidate) {
    return {
      success: false,
      errorMsg: "CANDIDATE_NOT_ALLOWLISTED",
    };
  }
  const preset = resolveAbyssalSceneryProbePreset(presetKey);
  if (!preset) {
    return {
      success: false,
      errorMsg: "PRESET_NOT_ALLOWLISTED",
    };
  }
  const scene = getPocketScene(pocketState, deps);
  if (
    !scene ||
    typeof scene.addStaticEntity !== "function" ||
    typeof scene.getEntityByID !== "function" ||
    typeof scene.broadcastAddBalls !== "function"
  ) {
    return {
      success: false,
      errorMsg: "SCENE_STATIC_ENTITY_UNSUPPORTED",
    };
  }
  const typeRecord = deps.resolveItemByTypeID(toInt(candidate.typeID, 0));
  if (!typeRecord) {
    return {
      success: false,
      errorMsg: "TYPE_UNRESOLVED",
    };
  }
  const currentRoomEntry = getPlaceholderRoomEntry(pocketState, roomState.currentRoomIndex);
  const existingProbeEntityID = toInt(currentRoomEntry && currentRoomEntry.sceneryProbeEntityID, 0);
  const nextProbeOrdinal = Math.max(1, toInt(currentRoomEntry && currentRoomEntry.sceneryProbeOrdinal, 0) + 1);
  let replacedEntityID = 0;
  if (existingProbeEntityID > 0) {
    const removeResult = destroyAbyssalSceneryVisualEntity(
      pocketState,
      existingProbeEntityID,
      deps,
      "scenery-probe-replace",
    );
    if (removeResult && removeResult.failed === true) {
      return {
        success: false,
        errorMsg: normalizeText(removeResult.errorMsg, "PROBE_REMOVE_FAILED"),
      };
    }
    replacedEntityID = existingProbeEntityID;
  }
  const probeEntity = buildAbyssalSceneryProbeEntity(
    pocketState,
    currentRoomEntry,
    candidate,
    preset,
    nextProbeOrdinal,
    deps,
  );
  if (!probeEntity) {
    return {
      success: false,
      errorMsg: "TYPE_UNRESOLVED",
    };
  }
  if (!scene.addStaticEntity(probeEntity)) {
    return {
      success: false,
      errorMsg: "SCENERY_ADD_FAILED",
    };
  }
  scene.broadcastAddBalls([probeEntity], session || null, {});
  return recordAbyssalSceneryProbeMaterialization(
    pocketState, roomState, currentRoomEntry, probeEntity, candidate, preset,
    typeRecord, nextProbeOrdinal, replacedEntityID, deps,
  );
}

function stepAbyssalSceneryProbeForSession({
  getDependencies,
  listAbyssalSceneryProbeCandidateKeys,
  normalizeLowerText,
  getActivePocketStateForSession,
  buildPlaceholderRoomState,
  getPlaceholderRoomEntry,
  getAbyssalSceneryProbeCandidateIndex,
  spawnAbyssalSceneryProbeForSession,
},
  session,
  direction,
  presetKey = "near",
  deps = getDependencies(),
) {
  const keys = listAbyssalSceneryProbeCandidateKeys();
  if (keys.length <= 0) {
    return {
      success: false,
      errorMsg: "CANDIDATE_NOT_ALLOWLISTED",
    };
  }
  const normalizedDirection = normalizeLowerText(direction, "");
  if (normalizedDirection !== "next" && normalizedDirection !== "prev") {
    return {
      success: false,
      errorMsg: "STEP_NOT_ALLOWLISTED",
    };
  }
  const pocketState = getActivePocketStateForSession(session);
  const roomState = pocketState ? buildPlaceholderRoomState(pocketState) : null;
  const currentRoomEntry =
    pocketState && roomState
      ? getPlaceholderRoomEntry(pocketState, roomState.currentRoomIndex)
      : null;
  const currentKey = normalizeLowerText(currentRoomEntry && currentRoomEntry.sceneryProbeCandidateKey, "");
  const currentIndex = getAbyssalSceneryProbeCandidateIndex(currentKey);
  const nextIndex = normalizedDirection === "next"
    ? (currentIndex >= 0 ? (currentIndex + 1) % keys.length : 0)
    : (currentIndex >= 0 ? (currentIndex - 1 + keys.length) % keys.length : keys.length - 1);
  const result = spawnAbyssalSceneryProbeForSession(session, keys[nextIndex], presetKey, deps);
  if (!result.success) {
    return result;
  }
  return {
    success: true,
    data: {
      ...result.data,
      steppedDirection: normalizedDirection,
      steppedFromIndex: currentIndex >= 0 ? currentIndex + 1 : 0,
      steppedFromKey: currentIndex >= 0 ? keys[currentIndex] : "none",
    },
  };
}

function rollbackAbyssalSceneryMaterialization({
  destroyAbyssalSceneryVisualEntity,
  listUniquePositiveInts,
  setPlaceholderRoomEntry,
  updatePocketState,
  buildPocketStateForCurrentRoom,
}, resolvedPocketState, roomState, roomEntry, profileResolution, scene, createdEntities, spawnedEntityIDs, deps, errorMsg) {
  const cleanupErrors = [];
  for (const entity of createdEntities) {
    const itemID = toInt(entity && entity.itemID, 0);
    // New batch entities have not been published. Reused entities are not removed.
    const result = destroyAbyssalSceneryVisualEntity(
      resolvedPocketState, itemID, deps, "spawn_rollback", { broadcast: false },
    );
    if ((result && result.failed === true) || scene.getEntityByID(itemID)) {
      cleanupErrors.push({
        itemID,
        errorMsg: normalizeText(result && result.errorMsg, "SCENERY_ROLLBACK_ENTITY_REMAINS"),
      });
    }
  }
  const retainedEntities = listUniquePositiveInts(spawnedEntityIDs)
    .map((itemID) => scene.getEntityByID(itemID))
    .filter(Boolean);
  const nextRoomState = setPlaceholderRoomEntry(
    resolvedPocketState,
    roomState.currentRoomIndex,
    {
      ...roomEntry,
      sceneryVisualEntityIDs: retainedEntities.map((entity) => toInt(entity.itemID, 0)),
      sceneryVisualTypeIDs: listUniquePositiveInts(retainedEntities.map((entity) => entity.typeID)),
      sceneryVisualProfileID: profileResolution.profileID,
      sceneryVisualLifecycleState: cleanupErrors.length > 0 ? "spawn_failed_cleanup_pending" : "spawn_failed",
      sceneryVisualBlockReason: errorMsg,
    },
  );
  return {
    success: false,
    errorMsg,
    cleanupPendingEntityIDs: cleanupErrors.map((entry) => entry.itemID),
    cleanupErrors,
    data: updatePocketState(
      toInt(resolvedPocketState.instanceID, 0),
      buildPocketStateForCurrentRoom(resolvedPocketState, nextRoomState),
    ),
  };
}

function materializeAbyssalSceneryProfileEntries({
  buildAbyssalSceneryVisualItemID,
  isAbyssalEnvironmentVisualEntity,
  buildAbyssalSceneryVisualEntity,
  rollbackAbyssalSceneryMaterialization,
}, resolvedPocketState, roomState, roomEntry, profileResolution, profileEntries, scene, deps) {
  const entitiesToBroadcast = [];
  const spawnedEntityIDs = [];
  const spawnedTypeIDs = [];
  for (const profileEntry of profileEntries) {
    const entityID = buildAbyssalSceneryVisualItemID(
      resolvedPocketState && resolvedPocketState.instanceID,
      roomState.currentRoomIndex,
      profileEntry && profileEntry.slot,
      profileEntry && profileEntry.capturedRetailObject === true,
    );
    const existingEntity = scene.getEntityByID(entityID);
    if (existingEntity && isAbyssalEnvironmentVisualEntity(existingEntity)) {
      spawnedEntityIDs.push(entityID);
      spawnedTypeIDs.push(toInt(existingEntity.typeID, 0));
      continue;
    }
    const entity = buildAbyssalSceneryVisualEntity(
      resolvedPocketState,
      roomEntry,
      profileResolution.profile,
      profileEntry,
      deps,
    );
    if (!entity || !scene.addStaticEntity(entity)) {
      return rollbackAbyssalSceneryMaterialization(
        resolvedPocketState, roomState, roomEntry, profileResolution, scene,
        entitiesToBroadcast, spawnedEntityIDs, deps,
        entity ? "SCENERY_ADD_FAILED" : "TYPE_UNRESOLVED",
      );
    }
    entitiesToBroadcast.push(entity);
    spawnedEntityIDs.push(entity.itemID);
    spawnedTypeIDs.push(entity.typeID);
  }
  return { success: true, entitiesToBroadcast, spawnedEntityIDs, spawnedTypeIDs };
}

function recordAbyssalSceneryProbeMaterialization({
  setPlaceholderRoomEntry,
  ABYSSAL_SCENERY_PROBE_PROFILE,
  getObjectPosition,
  updatePocketState,
  buildPocketStateForCurrentRoom,
  getAbyssalSceneryProbeCandidateIndex,
  listAbyssalSceneryProbeCandidateKeys,
  ABYSSAL_SCENERY_GUARD_STATUS,
}, pocketState, roomState, currentRoomEntry, probeEntity, candidate, preset, typeRecord, nextProbeOrdinal, replacedEntityID, deps) {
  const nextRoomState = setPlaceholderRoomEntry(
    pocketState,
    roomState.currentRoomIndex,
    {
      ...currentRoomEntry,
      sceneryProbeEntityID: toInt(probeEntity.itemID, 0),
      sceneryProbeTypeID: toInt(probeEntity.typeID, 0),
      sceneryProbeTypeName: normalizeText(typeRecord && typeRecord.name, candidate.typeName),
      sceneryProbeCandidateKey: normalizeText(candidate.key, ""),
      sceneryProbePresetKey: normalizeText(preset.key, ""),
      sceneryProbeProfileID: ABYSSAL_SCENERY_PROBE_PROFILE.profileID,
      sceneryProbeSpawnedAtMs: toInt(deps.now(), 0),
      sceneryProbeLifecycleState: "spawned",
      sceneryProbeBlockReason: "none",
      sceneryProbePosition: getObjectPosition(probeEntity.position),
      sceneryProbeOrdinal: nextProbeOrdinal,
      sceneryProbePreviousEntityID: replacedEntityID,
      sceneryProbeAddBallsSent: true,
    },
  );
  const updatedPocketState = updatePocketState(
    toInt(pocketState && pocketState.instanceID, 0),
    buildPocketStateForCurrentRoom(pocketState, nextRoomState),
  ) || pocketState;
  return {
    success: true,
    data: {
      categoryKey: normalizeText(candidate.categoryKey, "other_environment"),
      catalogueIndex: getAbyssalSceneryProbeCandidateIndex(candidate.key) + 1,
      catalogueSize: listAbyssalSceneryProbeCandidateKeys().length,
      entityID: toInt(probeEntity.itemID, 0),
      typeID: toInt(probeEntity.typeID, 0),
      typeName: normalizeText(typeRecord && typeRecord.name, candidate.typeName),
      candidateKey: normalizeText(candidate.key, ""),
      notes: normalizeText(candidate.notes, "none"),
      presetKey: normalizeText(preset.key, ""),
      position: getObjectPosition(probeEntity.position),
      previousEntityID: replacedEntityID,
      radiusMeters: Number(probeEntity.radius) || 0,
      radiusOverrideMeters: Number(candidate.radiusOverrideMeters) || 0,
      addBallsSent: true,
      guardsActive: ABYSSAL_SCENERY_GUARD_STATUS.active === true,
      replacedEntityID,
      profileID: ABYSSAL_SCENERY_PROBE_PROFILE.profileID,
      pocketState: updatedPocketState,
    },
  };
}

// Capture supplied capabilities once, as the original closure did. Internal
// callbacks are bound once per instance; no runtime state lives in this wiring.
function createAbyssalSceneryRuntime({
  getPocketScene,
  isAbyssalEnvironmentVisualEntity,
  getDependencies,
  getActivePocketStateByInstanceID,
  cloneValue,
  resolveAbyssalSceneryProfile,
  buildPlaceholderRoomState,
  getPlaceholderRoomEntry,
  setPlaceholderRoomEntry,
  updatePocketState,
  buildPocketStateForCurrentRoom,
  listAbyssalSceneryProfileEntries,
  buildAbyssalSceneryVisualItemID,
  buildAbyssalSceneryVisualEntity,
  listUniquePositiveInts,
  getActivePocketStateForSession,
  isAbyssalSceneryVisualsRequested,
  ABYSSAL_SCENERY_GUARD_STATUS,
  getContentProfile,
  isSupportedCalmSceneryContentProfile,
  resolveAbyssalSceneryProbeCandidate,
  resolveAbyssalSceneryProbePreset,
  buildAbyssalSceneryProbeEntity,
  ABYSSAL_SCENERY_PROBE_PROFILE,
  getObjectPosition,
  getAbyssalSceneryProbeCandidateIndex,
  listAbyssalSceneryProbeCandidateKeys,
  normalizeLowerText,
}) {

  const ports = {
    getPocketScene,
    isAbyssalEnvironmentVisualEntity,
    getDependencies,
    getActivePocketStateByInstanceID,
    cloneValue,
    resolveAbyssalSceneryProfile,
    buildPlaceholderRoomState,
    getPlaceholderRoomEntry,
    setPlaceholderRoomEntry,
    updatePocketState,
    buildPocketStateForCurrentRoom,
    listAbyssalSceneryProfileEntries,
    buildAbyssalSceneryVisualItemID,
    buildAbyssalSceneryVisualEntity,
    listUniquePositiveInts,
    getActivePocketStateForSession,
    isAbyssalSceneryVisualsRequested,
    ABYSSAL_SCENERY_GUARD_STATUS,
    getContentProfile,
    isSupportedCalmSceneryContentProfile,
    resolveAbyssalSceneryProbeCandidate,
    resolveAbyssalSceneryProbePreset,
    buildAbyssalSceneryProbeEntity,
    ABYSSAL_SCENERY_PROBE_PROFILE,
    getObjectPosition,
    getAbyssalSceneryProbeCandidateIndex,
    listAbyssalSceneryProbeCandidateKeys,
    normalizeLowerText,
  };
  ports.destroyAbyssalSceneryVisualEntity = destroyAbyssalSceneryVisualEntity.bind(null, ports);
  ports.ensureAbyssalSceneryVisuals = ensureAbyssalSceneryVisuals.bind(null, ports);
  ports.spawnAbyssalSceneryProbeForSession = spawnAbyssalSceneryProbeForSession.bind(null, ports);
  ports.stepAbyssalSceneryProbeForSession = stepAbyssalSceneryProbeForSession.bind(null, ports);
  ports.rollbackAbyssalSceneryMaterialization = rollbackAbyssalSceneryMaterialization.bind(null, ports);
  ports.materializeAbyssalSceneryProfileEntries = materializeAbyssalSceneryProfileEntries.bind(null, ports);
  ports.recordAbyssalSceneryProbeMaterialization = recordAbyssalSceneryProbeMaterialization.bind(null, ports);
  Object.freeze(ports);
  return Object.freeze({
    destroyAbyssalSceneryVisualEntity: ports.destroyAbyssalSceneryVisualEntity,
    ensureAbyssalSceneryVisuals: ports.ensureAbyssalSceneryVisuals,
    spawnAbyssalSceneryProbeForSession: ports.spawnAbyssalSceneryProbeForSession,
    stepAbyssalSceneryProbeForSession: ports.stepAbyssalSceneryProbeForSession,
  });
}

module.exports = Object.freeze({ createAbyssalSceneryRuntime });
