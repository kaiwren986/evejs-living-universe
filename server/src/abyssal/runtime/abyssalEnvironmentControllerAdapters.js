"use strict";

const { normalizeText } = require("../domain/abyssalValueUtils");

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

// Boundary controller refusals that describe an expected server-authored state
// rather than an environmental fault. A scheduled room transition deliberately
// holds the boundary controller off the source room for the length of its
// departure window, so ensureBoundaryControllerForPocketState() answers
// ABYSSAL_BOUNDARY_TRANSITION_PENDING on every maintenance pass inside that
// window. Scoring those refusals as environmental-health failures let a
// transition guarantee its own abort: the maintenance pass flipped the source
// room to environmentalMechanicsState="blocked" (and suppressed its rewards)
// while the transition was still in flight, and the handoff revalidation then
// refused the very room it was leaving with
// ABYSSAL_ROOM_ENVIRONMENTAL_MECHANICS_BLOCKED. Real faults - missing
// materialization, unresolved effect collections, degraded suppressors, a
// genuinely unavailable controller - are still scored, so the monitor keeps
// guarding what it was built to guard.
const BENIGN_ABYSSAL_BOUNDARY_CONTROLLER_STATES = Object.freeze([
  "ABYSSAL_BOUNDARY_TRANSITION_PENDING",
]);

// Environmental controller adapters only. Injected registries own controllers,
// generations and timers; the engine owns scenes, FX and the damage pipeline.
function buildSuppressorFxStartTime({
  getDependencies,
  FILETIME_TICKS_PER_MS,
  FILETIME_UNIX_EPOCH_OFFSET,
}, session, deps = getDependencies()) {
  const runtime = deps;
  const scene = runtime && typeof runtime.getSceneForSession === "function"
    ? runtime.getSceneForSession(session)
    : null;
  if (scene && typeof scene.getCurrentSessionFileTime === "function") {
    return scene.getCurrentSessionFileTime(
      session,
      typeof scene.getCurrentSimTimeMs === "function"
        ? scene.getCurrentSimTimeMs()
        : undefined,
    );
  }
  return (
    BigInt(Math.max(0, toInt(deps && deps.now ? deps.now() : Date.now(), Date.now()))) *
      FILETIME_TICKS_PER_MS +
    FILETIME_UNIX_EPOCH_OFFSET
  );
}

function buildSuppressorPresentationCallbacks({
  getDependencies,
  buildAbyssalSuppressorStartFxOptions,
  buildSuppressorFxStartTime,
  isSuppressorDebugEnabled,
  log,
}, deps = getDependencies()) {
  return {
    now: () => toInt(deps.now(), Date.now()),
    sendStart({ state, profile, session }) {
      const runtime = deps;
      if (!runtime || typeof runtime.playSpecialFx !== "function") {
        return { success: false, errorMsg: "ABYSSAL_SUPPRESSOR_FX_START_UNAVAILABLE" };
      }
      const fxOptions = buildAbyssalSuppressorStartFxOptions(
        toInt(state && state.runtimeEntityID, 0),
        {
          startTime: buildSuppressorFxStartTime(session, deps),
          timeFromStart: 0,
        },
        toInt(profile && profile.typeID, 0),
      );
      if (!fxOptions || !profile || profile.presentationEnabled !== true) {
        return { success: false, errorMsg: "ABYSSAL_SUPPRESSOR_FX_PROFILE_INVALID" };
      }
      return runtime.playSpecialFx(session, profile.effectName, fxOptions);
    },
    sendStop({ state, profile, session }) {
      const runtime = deps;
      if (!runtime || typeof runtime.stopSpecialFx !== "function") {
        return { success: false, errorMsg: "ABYSSAL_SUPPRESSOR_FX_STOP_UNAVAILABLE" };
      }
      return runtime.stopSpecialFx(session, profile.effectName, {
        sourceID: toInt(state && state.runtimeEntityID, 0),
      });
    },
    logLifecycle(entry = {}) {
      const runID = toInt(entry.runID, 0);
      if (!isSuppressorDebugEnabled(runID)) return;
      log.info(
        `[AbyssalSuppressorFX] run=${runID} room=${toInt(entry.roomIndex, 0)} ` +
          `entity=${toInt(entry.runtimeEntityID, 0)} ` +
          `session=${toInt(entry.characterID, 0)} ` +
          `effect=${normalizeText(entry.effectName, "none")} ` +
          `state=${normalizeText(entry.state, "unknown")} ` +
          `reason=${normalizeText(entry.reason, "none")}`,
      );
    },
    warn(entry = {}) {
      log.warn(
        `[AbyssalSuppressorFX] run=${toInt(entry.runID, 0)} ` +
          `room=${toInt(entry.roomIndex, 0)} ` +
          `entity=${toInt(entry.runtimeEntityID, 0)} ` +
          `session=${toInt(entry.characterID, 0)} ` +
          `effect=${normalizeText(entry.effectName, "none")} ` +
          `state=failed reason=${normalizeText(entry.reason, "unknown")} ` +
          `phase=${normalizeText(entry.phase, "unknown")}`,
      );
    },
  };
}

function deliverSuppressorPresentationForSession({
  getDependencies,
  buildPlaceholderRoomState,
  clampRoomIndex,
  ensureSuppressorControllersForRoom,
  getPocketScene,
  getPlaceholderRoomEntry,
  listUniquePositiveInts,
  buildSuppressorPresentationCallbacks,
  getAbyssalSuppressorPresentationProfileByTypeID,
  getSuppressorController,
  startSuppressorPresentationForSession,
},
  pocketState,
  session,
  deps = getDependencies(),
  options = {},
) {
  if (!pocketState || !session) return [];
  const roomState = buildPlaceholderRoomState(pocketState);
  const roomIndex = clampRoomIndex(
    toInt(options.roomIndex, roomState.currentRoomIndex),
    roomState.implementedRooms,
  );
  ensureSuppressorControllersForRoom(pocketState, roomIndex, deps);
  const scene = getPocketScene(pocketState, deps);
  const roomEntry = getPlaceholderRoomEntry(pocketState, roomIndex);
  const deliveredEntityIDs = listUniquePositiveInts(
    options.deliveredEntityIDs === undefined
      ? roomEntry.deliveredEntityIDs
      : options.deliveredEntityIDs,
  );
  const callbacks = buildSuppressorPresentationCallbacks(deps);
  const results = [];
  for (const runtimeEntityID of deliveredEntityIDs) {
    const entity = scene && typeof scene.getEntityByID === "function"
      ? scene.getEntityByID(runtimeEntityID)
      : null;
    const profile = getAbyssalSuppressorPresentationProfileByTypeID(
      toInt(entity && entity.typeID, 0),
    );
    if (!entity || !profile) continue;
    const controller = getSuppressorController(
      toInt(pocketState.instanceID, 0),
      roomIndex,
      runtimeEntityID,
    );
    results.push(startSuppressorPresentationForSession({
      runID: toInt(pocketState.instanceID, 0),
      roomIndex,
      runtimeEntityID,
      session,
      currentRoomIndex: roomState.currentRoomIndex,
      ballDelivered: true,
      roomVisible:
        roomIndex === roomState.currentRoomIndex &&
        Boolean(session._space && session._space.initialStateSent === true),
      entityActive: Boolean(
        controller &&
        controller.controllerActive === true &&
        entity.destroyed !== true &&
        entity.removed !== true &&
        entity.hiddenDuringAbyssalPrewarm !== true
      ),
      allowRetry: options.allowRetry === true,
      reason: normalizeText(options.reason, "room-delivered"),
      callbacks,
    }));
  }
  return results;
}

function stopSuppressorPresentationForPocketSession({
  getDependencies,
  buildPlaceholderRoomState,
  clampRoomIndex,
  listSuppressorPresentationStatesForRun,
  stopSuppressorPresentationForSession,
  buildSuppressorPresentationCallbacks,
},
  pocketState,
  session,
  deps = getDependencies(),
  options = {},
) {
  const runID = toInt(pocketState && pocketState.instanceID, 0);
  const roomState = buildPlaceholderRoomState(pocketState);
  const roomIndex = clampRoomIndex(
    toInt(options.roomIndex, roomState.currentRoomIndex),
    roomState.implementedRooms,
  );
  const results = [];
  for (const state of listSuppressorPresentationStatesForRun(runID, roomIndex)) {
    results.push(stopSuppressorPresentationForSession({
      runID,
      roomIndex,
      runtimeEntityID: state.runtimeEntityID,
      session,
      notifyClient: options.notifyClient !== false,
      reason: normalizeText(options.reason, "cleanup"),
      callbacks: buildSuppressorPresentationCallbacks(deps),
    }));
  }
  return results;
}

function stopSuppressorPresentationsForPocketRun({
  getDependencies,
  stopSuppressorPresentationsForRun,
  buildSuppressorPresentationCallbacks,
},
  pocketState,
  deps = getDependencies(),
  options = {},
) {
  return stopSuppressorPresentationsForRun({
    runID: toInt(pocketState && pocketState.instanceID, 0),
    roomIndex: options.roomIndex,
    runtimeEntityID: options.runtimeEntityID,
    notifyClient: options.notifyClient !== false,
    reason: normalizeText(options.reason, "cleanup"),
    callbacks: buildSuppressorPresentationCallbacks(deps),
  });
}

function applySuppressorDamageThroughRuntime({},
  runtime,
  { scene, sourceEntity, target, damage, nowMs },
) {
  if (!runtime || typeof runtime.applyDroneWeaponDamageToTarget !== "function") {
    throw new Error("ABYSSAL_SUPPRESSOR_DAMAGE_PIPELINE_UNAVAILABLE");
  }
  return runtime.applyDroneWeaponDamageToTarget(
    scene,
    sourceEntity,
    target,
    damage,
    nowMs,
    {
      action: "abyssal-suppressor-point-defense",
      destructionReason: "abyssal-automata-suppressor",
    },
  );
}

function buildSuppressorControllerCallbacks({
  getDependencies,
  getActivePocketStateByInstanceID,
  buildPlaceholderRoomState,
  getPocketScene,
  resolveSuppressorSceneKey,
  applySuppressorDamageThroughRuntime,
  removeSelectedMissile,
  log,
}, deps = getDependencies()) {
  return {
    now: () => toInt(deps.now(), Date.now()),
    setInterval(callback, intervalMs) {
      return typeof deps.scheduleInterval === "function"
        ? deps.scheduleInterval(callback, intervalMs)
        : null;
    },
    clearInterval(handle) {
      if (typeof deps.clearScheduledInterval === "function") {
        deps.clearScheduledInterval(handle);
      }
    },
    resolveContext(controller) {
      const pocketState = getActivePocketStateByInstanceID(
        toInt(controller && controller.runID, 0),
      );
      if (!pocketState) {
        return null;
      }
      const roomState = buildPlaceholderRoomState(pocketState);
      const scene = getPocketScene(pocketState, deps);
      return {
        pocketState,
        scene,
        sceneKey: resolveSuppressorSceneKey(pocketState, scene, deps),
        runID: toInt(pocketState.instanceID, 0),
        roomIndex: toInt(roomState.currentRoomIndex, 0),
      };
    },
    applyDamage({ scene, sourceEntity, target, damage, nowMs }) {
      const runtime = deps;
      return applySuppressorDamageThroughRuntime(runtime, {
        scene,
        sourceEntity,
        target,
        damage,
        nowMs,
      });
    },
    destroyProjectile({ controller, scene, target, nowMs, pulseNumber, distanceMeters }) {
      return removeSelectedMissile({
        scene,
        missile: target,
        runID: toInt(controller && controller.runID, 0),
        roomIndex: toInt(controller && controller.roomIndex, 0),
        suppressorEntityID: toInt(controller && controller.runtimeEntityID, 0),
        pulseNumber,
        selectedAt: nowMs,
        distanceMeters,
      });
    },
    logState({ controller, state, reason = "", errorMsg = "" }) {
      log.info(
        `[AbyssalSuppressorLifecycle] run=${toInt(controller && controller.runID, 0)} ` +
          `room=${toInt(controller && controller.roomIndex, 0)} ` +
          `entity=${toInt(controller && controller.runtimeEntityID, 0)} ` +
          `typeID=${toInt(controller && controller.typeID, 0)} ` +
          `state=${normalizeText(state, "unknown")} ` +
          `reason=${normalizeText(reason, normalizeText(errorMsg, "none"))}`,
      );
    },
    warn(controller, reason) {
      log.warn(
        `[AbyssalEnvironmentMechanic] run=${toInt(controller && controller.runID, 0)} ` +
          `room=${toInt(controller && controller.roomIndex, 0)} ` +
          `entity=${toInt(controller && controller.runtimeEntityID, 0)} ` +
          `typeID=${toInt(controller && controller.typeID, 0)} ` +
          `profile=${normalizeText(controller && controller.profile && controller.profile.profileID, "none")} ` +
          `state=degraded reason=${normalizeText(reason, "unknown")}`,
      );
    },
  };
}

function resolveSuppressorSceneKey({
  getDependencies,
  usesIsolatedAbyssalScene,
  buildAbyssalSceneDescriptor,
}, pocketState, scene, deps = getDependencies()) {
  const directSceneKey = normalizeText(scene && scene.sceneKey, "");
  if (directSceneKey) {
    return directSceneKey;
  }
  if (usesIsolatedAbyssalScene(pocketState, deps)) {
    const descriptor = buildAbyssalSceneDescriptor(pocketState, deps);
    const descriptorSceneKey = normalizeText(descriptor && descriptor.sceneKey, "");
    if (descriptorSceneKey) {
      return descriptorSceneKey;
    }
  }
  const systemID = toInt(pocketState && pocketState.solarSystemID, 0);
  const runtime = deps;
  return runtime && typeof runtime.buildSolarSystemSceneKey === "function"
    ? normalizeText(runtime.buildSolarSystemSceneKey(systemID), "")
    : systemID > 0
      ? `solar-system:${systemID}`
      : "";
}

function ensureSuppressorControllersForRoom({
  getDependencies,
  getPocketScene,
  getPlaceholderRoomEntry,
  listUniquePositiveInts,
  getAbyssalSuppressorPresentationProfileByTypeID,
  resolveSuppressorSceneKey,
  registerSuppressorPresentationState,
  log,
  getAbyssalSuppressorMechanicsProfileByTypeID,
  registerSuppressorController,
  buildSuppressorControllerCallbacks,
},
  pocketState,
  roomIndex,
  deps = getDependencies(),
) {
  const runID = toInt(pocketState && pocketState.instanceID, 0);
  const numericRoomIndex = toInt(roomIndex, 0);
  const scene = getPocketScene(pocketState, deps);
  const roomEntry = getPlaceholderRoomEntry(pocketState, numericRoomIndex);
  if (
    runID <= 0 ||
    numericRoomIndex <= 0 ||
    !scene ||
    typeof scene.getEntityByID !== "function"
  ) {
    return [];
  }
  const results = [];
  for (const runtimeEntityID of listUniquePositiveInts(
    roomEntry && roomEntry.environmentalObjectItemIDs,
  )) {
    const entity = scene.getEntityByID(runtimeEntityID);
    const typeID = toInt(entity && entity.typeID, 0);
    const presentationProfile = getAbyssalSuppressorPresentationProfileByTypeID(typeID);
    const presentationSceneKey = resolveSuppressorSceneKey(pocketState, scene, deps);
    if (
      entity &&
      presentationProfile &&
      presentationSceneKey === `abyssal-run:${runID}`
    ) {
      const presentationResult = registerSuppressorPresentationState({
        runID,
        roomIndex: numericRoomIndex,
        runtimeEntityID,
        typeID,
        sceneKey: presentationSceneKey,
        entityMaterialized: true,
      });
      if (!presentationResult.success) {
        log.warn(
          `[AbyssalSuppressorFX] run=${runID} room=${numericRoomIndex} ` +
            `entity=${runtimeEntityID} session=0 effect=${presentationProfile.effectName} ` +
            `state=failed reason=${normalizeText(presentationResult.errorMsg, "registration-failed")}`,
        );
      }
    }
    const profile = getAbyssalSuppressorMechanicsProfileByTypeID(typeID);
    if (!entity || !profile || profile.mechanicsEnabled !== true) {
      continue;
    }
    const result = registerSuppressorController({
      runID,
      roomIndex: numericRoomIndex,
      runtimeEntityID,
      typeID,
      sceneKey: resolveSuppressorSceneKey(pocketState, scene, deps),
      registeredAt: toInt(deps.now(), 0),
      callbacks: buildSuppressorControllerCallbacks(deps),
    });
    results.push(result);
    if (!result.success) {
      log.warn(
        `[AbyssalEnvironmentMechanic] run=${runID} room=${numericRoomIndex} ` +
          `entity=${runtimeEntityID} typeID=${toInt(entity.typeID, 0)} ` +
          `profile=${profile.profileID} state=degraded ` +
          `reason=${normalizeText(result.errorMsg, "registration-failed")}`,
      );
    }
  }
  return results;
}

function activateSuppressorControllersForPocketRoom({
  getDependencies,
  ensureSuppressorControllersForRoom,
  activateSuppressorControllersForRoom,
},
  pocketState,
  roomIndex,
  deps = getDependencies(),
) {
  ensureSuppressorControllersForRoom(pocketState, roomIndex, deps);
  return activateSuppressorControllersForRoom(
    toInt(pocketState && pocketState.instanceID, 0),
    toInt(roomIndex, 0),
    toInt(deps.now(), Date.now()),
  );
}

function listExactAbyssalBoundaryCompanionEntities({
  resolveExactAbyssalRunRoomScope,
  normalizeLowerText,
},
  pocketState,
  roomIndex,
  scene,
  options = {},
) {
  if (!scene || !(scene.dynamicEntities instanceof Map)) {
    return [];
  }
  const runID = toInt(pocketState && pocketState.instanceID, 0);
  const participantShipID = toInt(
    options.participantShipID,
    toInt(pocketState && pocketState.shipID, 0),
  );
  const participantCharacterID = toInt(
    options.participantCharacterID,
    toInt(pocketState && pocketState.characterID, 0),
  );
  if (runID <= 0 || roomIndex <= 0 || participantShipID <= 0 || participantCharacterID <= 0) {
    return [];
  }
  const companionKinds = new Set(["drone", "fighter", "probe"]);
  const matchesExactAuthority = (entity, fields, expectedValue) => {
    const values = [
      ...new Set(fields
        .map((field) => toInt(entity && entity[field], 0))
        .filter((value) => value > 0)),
    ];
    return values.length > 0 && values.every((value) => value === expectedValue);
  };
  const companions = [];
  for (const entity of scene.dynamicEntities.values()) {
    const entityID = toInt(entity && entity.itemID, 0);
    const exactScope = resolveExactAbyssalRunRoomScope(entity);
    if (
      entityID <= 0 ||
      entityID === participantShipID ||
      !exactScope ||
      exactScope.runID !== runID ||
      exactScope.roomIndex !== roomIndex
    ) {
      continue;
    }
    const kind = normalizeLowerText(entity && entity.kind, "");
    // NPC hulls belong to the room rather than to a participant. They still
    // need their own exposure clock, including logistics and inactive escorts.
    if (kind === "ship" && entity.nativeNpc === true) {
      if (entity.hiddenDuringAbyssalPrewarm !== true && entity.removed !== true) {
        companions.push(entity);
      }
      continue;
    }
    if (!companionKinds.has(kind)) {
      continue;
    }
    const controllerFields = [
      "controllerID",
      "controllerShipID",
      "launcherID",
      "sourceShipID",
      "launchShipID",
    ];
    const ownerFields = [
      "ownerCharacterID",
      "controllerOwnerID",
      "launcherCharacterID",
      "characterID",
      "ownerID",
    ];
    const hasControllerAuthority = matchesExactAuthority(
      entity,
      controllerFields,
      participantShipID,
    );
    const hasOwnerAuthority = matchesExactAuthority(
      entity,
      ownerFields,
      participantCharacterID,
    );
    const controllerClaimsPresent = controllerFields.some(
      (field) => toInt(entity && entity[field], 0) > 0,
    );
    const ownerClaimsPresent = ownerFields.some(
      (field) => toInt(entity && entity[field], 0) > 0,
    );
    if (
      (!hasControllerAuthority && !hasOwnerAuthority) ||
      (controllerClaimsPresent && !hasControllerAuthority) ||
      (ownerClaimsPresent && !hasOwnerAuthority)
    ) {
      continue;
    }
    companions.push(entity);
  }
  return companions.sort(
    (left, right) => toInt(left && left.itemID, 0) - toInt(right && right.itemID, 0),
  );
}

function buildBoundaryControllerContext({
  getDependencies,
  getActivePocketStateByInstanceID,
  buildPlaceholderRoomState,
  getPlaceholderRoomEntry,
  getPocketScene,
  listUniquePositiveInts,
  TYPE_UNSTABLE_ABYSSAL_DEPTHS,
  resolveAbyssalLiveCombatParticipant,
  getPendingAbyssalTransitionState,
  normalizeLowerText,
  ABYSSAL_ROOM_DELIVERY_STATE,
  hasTerminalFailureOutcome,
  isCapsuleTypeID,
  getObjectPosition,
  listExactAbyssalBoundaryCompanionEntities,
}, instanceID, deps = getDependencies(), options = {}) {
  const pocketState = getActivePocketStateByInstanceID(instanceID);
  if (!pocketState) {
    return null;
  }
  const roomState = buildPlaceholderRoomState(pocketState);
  const roomIndex = toInt(roomState.currentRoomIndex, 0);
  const roomEntry = getPlaceholderRoomEntry(pocketState, roomIndex);
  const scene = getPocketScene(pocketState, deps);
  if (!scene || typeof scene.getEntityByID !== "function") {
    return null;
  }
  const environmentEntities = listUniquePositiveInts(
    roomEntry && roomEntry.environmentalObjectItemIDs,
  )
    .map((entityID) => scene.getEntityByID(entityID))
    .filter(Boolean);
  const sourceEntity = environmentEntities.find((entity) =>
    toInt(entity && entity.typeID, 0) === TYPE_UNSTABLE_ABYSSAL_DEPTHS
  ) || null;
  const participantSelection = resolveAbyssalLiveCombatParticipant(
    pocketState,
    scene,
    { roomIndex },
  );
  // Keep the immutable owner only as fail-closed diagnostic context when no
  // roster participant passes exact scope validation. Successful controller
  // authority always comes from the durable-roster selection above.
  const participantShipID = participantSelection.success
    ? participantSelection.shipID
    : toInt(pocketState.shipID, 0);
  const participantCharacterID = participantSelection.success
    ? participantSelection.characterID
    : toInt(pocketState.characterID, 0);
  const shipEntity = participantSelection.success
    ? participantSelection.shipEntity
    : scene.getEntityByID(participantShipID);
  const pendingTransition = getPendingAbyssalTransitionState(pocketState);
  const pendingTransitionPhase = normalizeLowerText(
    pendingTransition && pendingTransition.phase,
    "",
  );
  const pendingEntryAdmission = Boolean(
    options.allowPendingEntry === true && pendingTransitionPhase === "entry"
  );
  const pendingDestinationActivation = Boolean(
    options.allowPendingDestinationActivation === true &&
    pendingTransitionPhase === "transfer" &&
    pendingTransition &&
    pendingTransition.status === "pending" &&
    toInt(pendingTransition.targetRoomIndex, 0) === roomIndex &&
    toInt(pendingTransition.committedRoomIndex, 0) === roomIndex
  );
  const recordedDeliveryState = normalizeText(roomEntry && roomEntry.deliveryState, "");
  return {
    runID: toInt(pocketState.instanceID, 0),
    sceneKey: normalizeText(scene.sceneKey, ""),
    roomIndex,
    shipID: participantShipID,
    participantCharacterID,
    roomActive: Boolean(roomEntry && roomIndex === roomState.currentRoomIndex),
    deliveryState:
      pendingEntryAdmission
        ? ABYSSAL_ROOM_DELIVERY_STATE.VISIBLE
        : recordedDeliveryState || ABYSSAL_ROOM_DELIVERY_STATE.VISIBLE,
    transitionPending: Boolean(
      !pendingEntryAdmission &&
      !pendingDestinationActivation &&
      pendingTransition &&
      pendingTransition.status === "pending"
    ),
    transitionPhase: pendingTransitionPhase,
    pendingEntryAdmission,
    pendingDestinationActivation,
    // Completing the final objective is not terminal for boundary mechanics:
    // the ship remains in the room until the final exit transition commits.
    runTerminal: hasTerminalFailureOutcome(pocketState),
    isCapsule: isCapsuleTypeID(toInt(shipEntity && shipEntity.typeID, 0)),
    roomOrigin: getObjectPosition(roomEntry && roomEntry.roomOriginPosition),
    roomEntry,
    scene,
    shipEntity,
    sourceEntity,
    environmentEntities,
    companionEntities: listExactAbyssalBoundaryCompanionEntities(
      pocketState,
      roomIndex,
      scene,
      {
        participantShipID,
        participantCharacterID,
      },
    ),
  };
}

function logBoundaryControllerEvent({
  log,
  round6,
}, event, snapshot, details = {}) {
  log.debug(
    `[AbyssalBoundary] ${normalizeText(event, "state")} ` +
      `run=${toInt(snapshot && snapshot.runID, 0)} ` +
      `sceneKey=${normalizeText(snapshot && snapshot.sceneKey, "none")} ` +
      `room=${toInt(snapshot && snapshot.roomIndex, 0)} ` +
      `ship=${toInt(snapshot && snapshot.shipID, 0)} ` +
      `depth=${round6(snapshot && snapshot.depthOutsideMeters)} ` +
      `applied=${round6(details && details.appliedDamage)} ` +
      `state=${normalizeText(snapshot && snapshot.controllerState, "none")}`,
  );
}

function isBenignAbyssalBoundaryControllerState({}, errorMsg) {
  const normalized = normalizeText(errorMsg, "");
  if (!normalized) {
    return true;
  }
  return BENIGN_ABYSSAL_BOUNDARY_CONTROLLER_STATES.includes(normalized);
}

function ensureBoundaryControllerForPocketState({
  getDependencies,
  buildBoundaryControllerContext,
  ABYSSAL_ROOM_DELIVERY_STATE,
  ensureActiveBoundaryController,
  logBoundaryControllerEvent,
  log,
},
  pocketState,
  deps = getDependencies(),
  nowMs = null,
  options = {},
) {
  const runID = toInt(pocketState && pocketState.instanceID, 0);
  const context = buildBoundaryControllerContext(runID, deps, options);
  if (!context) {
    return { success: false, errorMsg: "ABYSSAL_BOUNDARY_CONTEXT_UNAVAILABLE" };
  }
  const pendingEntryActivation = Boolean(
    options.allowPendingEntry === true &&
    (!context.transitionPhase || context.transitionPhase === "entry")
  );
  const pendingDestinationActivation = Boolean(
    options.allowPendingDestinationActivation === true &&
    context.pendingDestinationActivation === true
  );
  if (
    context.deliveryState !== ABYSSAL_ROOM_DELIVERY_STATE.VISIBLE &&
    !pendingEntryActivation &&
    !pendingDestinationActivation
  ) {
    return {
      success: false,
      errorMsg: "ABYSSAL_BOUNDARY_ROOM_NOT_VISIBLE",
      deliveryState: context.deliveryState,
    };
  }
  if (
    context.transitionPending &&
    !(
      pendingEntryActivation || pendingDestinationActivation
    )
  ) {
    return { success: false, errorMsg: "ABYSSAL_BOUNDARY_TRANSITION_PENDING" };
  }
  if (context.runTerminal) {
    return { success: false, errorMsg: "ABYSSAL_BOUNDARY_RUN_TERMINAL" };
  }
  // A capsule is a participant ship like any other: a pilot who lost the hull
  // flies on in the pod, and the boundary applies to it as on retail.
  if (!context.sourceEntity) {
    return { success: false, errorMsg: "ABYSSAL_BOUNDARY_SOURCE_MISSING" };
  }
  if (context.sourceEntity.evejsAbyssalEnvironmentalMechanicsEnabled !== true) {
    return { success: false, errorMsg: "ABYSSAL_BOUNDARY_SOURCE_DISABLED" };
  }
  const runtime = deps;
  return ensureActiveBoundaryController({
    runID,
    sceneKey: context.sceneKey,
    roomIndex: context.roomIndex,
    shipID: context.shipID,
    nowMs: nowMs == null ? toInt(deps.now(), 0) : toInt(nowMs, 0),
    callbacks: {
      now: () => toInt(deps.now(), Date.now()),
      setInterval: deps.scheduleBoundaryInterval || deps.scheduleInterval,
      clearInterval:
        deps.clearScheduledBoundaryInterval || deps.clearScheduledInterval,
      nextRandom: typeof deps.nextBoundaryRandom === "function"
        ? deps.nextBoundaryRandom
        : deps.nextRandom,
      resolveContext: () => buildBoundaryControllerContext(runID, deps, options),
      applyDamage: (damageContext) => {
        if (
          !runtime ||
          typeof runtime.applyResolvedEnvironmentalDamageToTarget !== "function"
        ) {
          return {
            success: false,
            errorMsg: "RESOLVED_ENVIRONMENTAL_DAMAGE_UNAVAILABLE",
          };
        }
        return runtime.applyResolvedEnvironmentalDamageToTarget(
          damageContext.scene,
          damageContext.sourceEntity,
          damageContext.targetEntity,
          damageContext.amount,
          damageContext.nowMs,
          {
            sourceName: damageContext.sourceName,
            damageQuality: "Hits",
            weapon: null,
            damageType: null,
            destructionReason: "abyssal-boundary",
            sessionChangeReason: "abyssal_boundary",
          },
        );
      },
      log: logBoundaryControllerEvent,
      warn: (errorMsg, snapshot) => {
        log.warn(
          `[AbyssalBoundary] warning run=${toInt(snapshot && snapshot.runID, runID)} ` +
            `room=${toInt(snapshot && snapshot.roomIndex, context.roomIndex)} ` +
            `ship=${toInt(snapshot && snapshot.shipID, context.shipID)} ` +
            `reason=${normalizeText(errorMsg, "UNKNOWN")}`,
        );
      },
    },
  });
}

// Capture supplied capabilities once, as the original closure did. Internal
// callbacks are bound once per instance; no runtime state lives in this wiring.
function createAbyssalEnvironmentControllerAdapters({
  getDependencies,
  FILETIME_TICKS_PER_MS,
  FILETIME_UNIX_EPOCH_OFFSET,
  buildAbyssalSuppressorStartFxOptions,
  isSuppressorDebugEnabled,
  log,
  buildPlaceholderRoomState,
  clampRoomIndex,
  getPocketScene,
  getPlaceholderRoomEntry,
  listUniquePositiveInts,
  getAbyssalSuppressorPresentationProfileByTypeID,
  getSuppressorController,
  startSuppressorPresentationForSession,
  listSuppressorPresentationStatesForRun,
  stopSuppressorPresentationForSession,
  stopSuppressorPresentationsForRun,
  getActivePocketStateByInstanceID,
  removeSelectedMissile,
  usesIsolatedAbyssalScene,
  buildAbyssalSceneDescriptor,
  registerSuppressorPresentationState,
  getAbyssalSuppressorMechanicsProfileByTypeID,
  registerSuppressorController,
  activateSuppressorControllersForRoom,
  resolveExactAbyssalRunRoomScope,
  normalizeLowerText,
  TYPE_UNSTABLE_ABYSSAL_DEPTHS,
  resolveAbyssalLiveCombatParticipant,
  getPendingAbyssalTransitionState,
  ABYSSAL_ROOM_DELIVERY_STATE,
  hasTerminalFailureOutcome,
  isCapsuleTypeID,
  getObjectPosition,
  round6,
  ensureActiveBoundaryController,
}) {

  const ports = {
    getDependencies,
    FILETIME_TICKS_PER_MS,
    FILETIME_UNIX_EPOCH_OFFSET,
    buildAbyssalSuppressorStartFxOptions,
    isSuppressorDebugEnabled,
    log,
    buildPlaceholderRoomState,
    clampRoomIndex,
    getPocketScene,
    getPlaceholderRoomEntry,
    listUniquePositiveInts,
    getAbyssalSuppressorPresentationProfileByTypeID,
    getSuppressorController,
    startSuppressorPresentationForSession,
    listSuppressorPresentationStatesForRun,
    stopSuppressorPresentationForSession,
    stopSuppressorPresentationsForRun,
    getActivePocketStateByInstanceID,
    removeSelectedMissile,
    usesIsolatedAbyssalScene,
    buildAbyssalSceneDescriptor,
    registerSuppressorPresentationState,
    getAbyssalSuppressorMechanicsProfileByTypeID,
    registerSuppressorController,
    activateSuppressorControllersForRoom,
    resolveExactAbyssalRunRoomScope,
    normalizeLowerText,
    TYPE_UNSTABLE_ABYSSAL_DEPTHS,
    resolveAbyssalLiveCombatParticipant,
    getPendingAbyssalTransitionState,
    ABYSSAL_ROOM_DELIVERY_STATE,
    hasTerminalFailureOutcome,
    isCapsuleTypeID,
    getObjectPosition,
    round6,
    ensureActiveBoundaryController,
  };
  ports.buildSuppressorFxStartTime = buildSuppressorFxStartTime.bind(null, ports);
  ports.buildSuppressorPresentationCallbacks = buildSuppressorPresentationCallbacks.bind(null, ports);
  ports.deliverSuppressorPresentationForSession = deliverSuppressorPresentationForSession.bind(null, ports);
  ports.stopSuppressorPresentationForPocketSession = stopSuppressorPresentationForPocketSession.bind(null, ports);
  ports.stopSuppressorPresentationsForPocketRun = stopSuppressorPresentationsForPocketRun.bind(null, ports);
  ports.applySuppressorDamageThroughRuntime = applySuppressorDamageThroughRuntime.bind(null, ports);
  ports.buildSuppressorControllerCallbacks = buildSuppressorControllerCallbacks.bind(null, ports);
  ports.resolveSuppressorSceneKey = resolveSuppressorSceneKey.bind(null, ports);
  ports.ensureSuppressorControllersForRoom = ensureSuppressorControllersForRoom.bind(null, ports);
  ports.activateSuppressorControllersForPocketRoom = activateSuppressorControllersForPocketRoom.bind(null, ports);
  ports.listExactAbyssalBoundaryCompanionEntities = listExactAbyssalBoundaryCompanionEntities.bind(null, ports);
  ports.buildBoundaryControllerContext = buildBoundaryControllerContext.bind(null, ports);
  ports.logBoundaryControllerEvent = logBoundaryControllerEvent.bind(null, ports);
  ports.isBenignAbyssalBoundaryControllerState = isBenignAbyssalBoundaryControllerState.bind(null, ports);
  ports.ensureBoundaryControllerForPocketState = ensureBoundaryControllerForPocketState.bind(null, ports);
  Object.freeze(ports);
  return Object.freeze({
    buildSuppressorFxStartTime: ports.buildSuppressorFxStartTime,
    buildSuppressorPresentationCallbacks: ports.buildSuppressorPresentationCallbacks,
    deliverSuppressorPresentationForSession: ports.deliverSuppressorPresentationForSession,
    stopSuppressorPresentationForPocketSession: ports.stopSuppressorPresentationForPocketSession,
    stopSuppressorPresentationsForPocketRun: ports.stopSuppressorPresentationsForPocketRun,
    applySuppressorDamageThroughRuntime: ports.applySuppressorDamageThroughRuntime,
    buildSuppressorControllerCallbacks: ports.buildSuppressorControllerCallbacks,
    resolveSuppressorSceneKey: ports.resolveSuppressorSceneKey,
    ensureSuppressorControllersForRoom: ports.ensureSuppressorControllersForRoom,
    activateSuppressorControllersForPocketRoom: ports.activateSuppressorControllersForPocketRoom,
    listExactAbyssalBoundaryCompanionEntities: ports.listExactAbyssalBoundaryCompanionEntities,
    buildBoundaryControllerContext: ports.buildBoundaryControllerContext,
    logBoundaryControllerEvent: ports.logBoundaryControllerEvent,
    isBenignAbyssalBoundaryControllerState: ports.isBenignAbyssalBoundaryControllerState,
    ensureBoundaryControllerForPocketState: ports.ensureBoundaryControllerForPocketState,
  });
}

module.exports = Object.freeze({ createAbyssalEnvironmentControllerAdapters });
