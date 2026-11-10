"use strict";

const { normalizeText } = require("../domain/abyssalValueUtils");

// Stateless operations; ownership remains with the injected registry and persistence ports.
function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function allocateAbyssalSpatialReservation(ports, instanceID, runtime) {
  const {
    isAbyssalHostLocationID,
    allocateSpatialSlot,
  } = ports;
  const numericInstanceID = toInt(instanceID, 0);
  if (numericInstanceID <= 0) {
    return {
      success: false,
      errorMsg: "ABYSSAL_SPATIAL_RUN_ID_INVALID",
    };
  }
  const preferredHostSystemID = toInt(
    runtime && typeof runtime.allocateAbyssalLocationID === "function"
      ? runtime.allocateAbyssalLocationID(numericInstanceID)
      : 0,
    0,
  );
  return allocateSpatialSlot(
    numericInstanceID,
    isAbyssalHostLocationID(preferredHostSystemID)
      ? { preferredHostSystemID }
      : {},
  );
}

function reserveAbyssalSpatialSlotForPocketState(ports, pocketState, runtime) {
  const {
    isAbyssalHostLocationID,
    cloneValue,
    getObjectPosition,
    resolveAbyssalSpatialSlotOrigin,
    ABYSSAL_SPATIAL_RESERVATION_SCHEMA_VERSION,
    getSpatialReservation,
    reserveSpatialSlot,
  } = ports;
  const instanceID = toInt(pocketState && pocketState.instanceID, 0);
  const existingReservation = getSpatialReservation(instanceID);
  const persistedReservation =
    pocketState &&
    pocketState.abyssalSpatialReservation &&
    typeof pocketState.abyssalSpatialReservation === "object"
      ? cloneValue(pocketState.abyssalSpatialReservation)
      : null;
  const persistedSlotID = persistedReservation && persistedReservation.slotID;
  const topLevelSlotID = pocketState && pocketState.abyssalSlotID;
  // cloneValue() intentionally normalizes undefined object properties to null.
  // Treat those nulls as absent so pre-A-09 rows take the legacy slot-zero
  // migration path instead of being mistaken for explicit A-09 metadata.
  const hasPersistedSlotID = [persistedSlotID, topLevelSlotID].some((value) =>
    value !== undefined &&
    value !== null &&
    Number.isFinite(Number(value)) &&
    Math.trunc(Number(value)) >= 0
  );

  let reservationResult;
  let migratedLegacyReservation = false;
  const restoredPersistedReservation = hasPersistedSlotID && !existingReservation;
  if (hasPersistedSlotID) {
    const persistedHostSystemID =
      persistedReservation && persistedReservation.hostSystemID;
    const hostSystemID = persistedHostSystemID !== undefined && persistedHostSystemID !== null
      ? toInt(persistedHostSystemID, 0)
      : toInt(pocketState && pocketState.abyssalLocationID, 0);
    const slotID = persistedSlotID !== undefined && persistedSlotID !== null
      ? toInt(persistedSlotID, -1)
      : toInt(pocketState && pocketState.abyssalSlotID, -1);
    const spatialOrigin =
      getObjectPosition(persistedReservation && persistedReservation.spatialOrigin) ||
      getObjectPosition(pocketState && pocketState.abyssalSpatialOrigin) ||
      (
        isAbyssalHostLocationID(hostSystemID) && slotID >= 0
          ? resolveAbyssalSpatialSlotOrigin(hostSystemID, slotID)
          : null
      );
    reservationResult = reserveSpatialSlot({
      ...persistedReservation,
      runID: instanceID,
      hostSystemID,
      slotID,
      spatialOrigin,
      sceneID: `abyssal-run:${instanceID}`,
    }, {
      allowLegacyOrigin: Boolean(
        persistedReservation && persistedReservation.legacySpatialOriginPreserved === true,
      ),
    });
  } else if (isAbyssalHostLocationID(pocketState && pocketState.abyssalLocationID)) {
    // Pre-A-09 runs were exclusive per host and had no slot metadata. Their
    // current Room 1 origin remains authoritative during migration: assigning
    // slot zero preserves live geometry rather than relocating a recovered run.
    const hostSystemID = toInt(pocketState.abyssalLocationID, 0);
    const spatialOrigin =
      getObjectPosition(pocketState.abyssalSpatialOrigin) ||
      getObjectPosition(pocketState.roomOneOriginPosition) ||
      getObjectPosition(pocketState.pocketPosition) ||
      resolveAbyssalSpatialSlotOrigin(hostSystemID, 0);
    migratedLegacyReservation = true;
    reservationResult = reserveSpatialSlot({
      runID: instanceID,
      hostSystemID,
      slotID: 0,
      spatialOrigin,
      sceneID: `abyssal-run:${instanceID}`,
      legacySpatialOriginPreserved: true,
    }, { allowLegacyOrigin: true });
  } else {
    reservationResult = allocateAbyssalSpatialReservation(ports, instanceID, runtime);
  }

  if (!reservationResult || reservationResult.success !== true) {
    return {
      success: false,
      created: false,
      migratedLegacyReservation,
      restoredPersistedReservation,
      errorMsg: normalizeText(
        reservationResult && reservationResult.errorMsg,
        "ABYSSAL_SPATIAL_RESERVATION_FAILED",
      ),
      reservationResult: cloneValue(reservationResult),
    };
  }

  const reservation = cloneValue(reservationResult.reservation);
  return {
    success: true,
    created: !existingReservation && reservationResult.idempotent !== true,
    migratedLegacyReservation,
    restoredPersistedReservation,
    reservation,
    patch: {
      abyssalLocationID: reservation.hostSystemID,
      abyssalSlotID: reservation.slotID,
      abyssalSpatialOrigin: cloneValue(reservation.spatialOrigin),
      abyssalSpatialReservation: {
        ...cloneValue(reservation),
        schemaVersion: ABYSSAL_SPATIAL_RESERVATION_SCHEMA_VERSION,
      },
      sceneKey: reservation.sceneID,
    },
  };
}

function resolveExistingActiveRunConflict(ports, context, deps = ports.getDependencies()) {
  const {
    getActivePocketStateForCharacterID,
    getActiveTraceStateForCharacterID,
    isCreatedAbyssalTraceExpired,
    expireCreatedAbyssalTrace,
    readTraceStateFromItem,
    normalizeAbyssalTraceLifecyclePhase,
    ABYSSAL_TRACE_LIFECYCLE_PHASE,
    canRecoverCreatedAbyssalTraceAfterRestart,
    registerTrace,
    ensureSourceTraceRuntime,
    scheduleCreatedAbyssalTraceExpiry,
    hasPendingDeployment,
  } = ports;
  if (hasPendingDeployment(toInt(context.characterID, 0))) {
    return { reason: "ACTIVE_TRACE_DEPLOYMENT_PENDING" };
  }
  const activePocketState = getActivePocketStateForCharacterID(context.characterID);
  if (activePocketState) {
    return {
      reason: "ACTIVE_POCKET_ALREADY_EXISTS",
      pocketState: activePocketState,
    };
  }

  const conflictNowMs = toInt(deps && deps.now && deps.now(), Date.now());
  let activeTraceState = getActiveTraceStateForCharacterID(context.characterID, deps);
  if (
    activeTraceState &&
    isCreatedAbyssalTraceExpired(activeTraceState, conflictNowMs)
  ) {
    const expirationResult = expireCreatedAbyssalTrace(
      activeTraceState,
      deps,
      "created-trace-deployment-lock-expired",
    );
    if (expirationResult && expirationResult.success) {
      activeTraceState = null;
    } else {
      return {
        reason: "ACTIVE_TRACE_EXPIRATION_FAILED",
        traceState: activeTraceState,
        expirationResult,
      };
    }
  }
  if (activeTraceState) {
    return {
      reason: "ACTIVE_TRACE_ALREADY_EXISTS",
      traceState: activeTraceState,
    };
  }

  let persistedTraceState = null;
  const persistedTraceStates = typeof deps.listSystemSpaceItems === "function"
    ? deps.listSystemSpaceItems(toInt(context.systemID, 0))
        .map((item) => readTraceStateFromItem(item))
        .filter(Boolean)
    : [];
  for (const candidateTraceState of persistedTraceStates) {
    if (
      toInt(candidateTraceState.characterID, 0) !== toInt(context.characterID, 0)
    ) {
      continue;
    }
    const lifecyclePhase = normalizeAbyssalTraceLifecyclePhase(
      candidateTraceState.lifecyclePhase,
    );
    const ownsDeploymentLock = Boolean(
      lifecyclePhase === ABYSSAL_TRACE_LIFECYCLE_PHASE.ACTIVE ||
      (
        lifecyclePhase === ABYSSAL_TRACE_LIFECYCLE_PHASE.CREATED &&
        canRecoverCreatedAbyssalTraceAfterRestart(candidateTraceState)
      )
    );
    if (!ownsDeploymentLock) {
      continue;
    }
    if (isCreatedAbyssalTraceExpired(candidateTraceState, conflictNowMs)) {
      const expirationResult = expireCreatedAbyssalTrace(
        candidateTraceState,
        deps,
        "created-trace-persisted-lock-expired",
      );
      if (expirationResult && expirationResult.success) {
        continue;
      }
      persistedTraceState = candidateTraceState;
      break;
    }
    persistedTraceState = candidateTraceState;
    break;
  }
  if (persistedTraceState) {
    registerTrace(persistedTraceState);
    ensureSourceTraceRuntime(persistedTraceState, deps);
    if (
      normalizeAbyssalTraceLifecyclePhase(persistedTraceState.lifecyclePhase) ===
      ABYSSAL_TRACE_LIFECYCLE_PHASE.CREATED
    ) {
      scheduleCreatedAbyssalTraceExpiry(
        persistedTraceState,
        deps,
        "recovered-created-trace-expired",
      );
    }
    return {
      reason: "ACTIVE_TRACE_ALREADY_EXISTS",
      traceState: persistedTraceState,
    };
  }

  return null;
}

function buildAbyssalHandoffSessionIdentity(ports, session, deps, expected = {}) {
  const {
    getSessionContext,
    getReadOnlySolarSystemScene,
    log,
  } = ports;
  const context = getSessionContext(session);
  const expectedCharacterID = toInt(expected.characterID, 0);
  const expectedShipID = toInt(expected.shipID, 0);
  const expectedSystemID = toInt(expected.systemID, 0);
  if (
    expectedCharacterID <= 0 ||
    expectedShipID <= 0 ||
    context.characterID !== expectedCharacterID ||
    context.shipID !== expectedShipID ||
    (expectedSystemID > 0 && context.systemID !== expectedSystemID)
  ) {
    return {
      success: false,
      errorMsg: "ABYSSAL_HANDOFF_SESSION_IDENTITY_CHANGED",
    };
  }

  const expectedInstanceID = toInt(expected.instanceID, 0);
  if (
    expected.requireBoundInstance === true &&
    expectedInstanceID > 0 &&
    toInt(session && session.abyssalInstanceID, 0) !== expectedInstanceID
  ) {
    return {
      success: false,
      errorMsg: "ABYSSAL_HANDOFF_SESSION_RUN_CHANGED",
    };
  }

  const shipItem = deps.findItemById(expectedShipID);
  const explicitShipOwnerID = toInt(shipItem && shipItem.ownerID, 0);
  if (
    !shipItem ||
    (explicitShipOwnerID > 0 && explicitShipOwnerID !== expectedCharacterID)
  ) {
    return {
      success: false,
      errorMsg: shipItem
        ? "ABYSSAL_HANDOFF_SHIP_OWNER_CHANGED"
        : "ABYSSAL_HANDOFF_SHIP_MISSING",
    };
  }

  const runtime = deps;
  const expectedSceneKind = normalizeText(expected.sceneKind, "");
  const sourceScene = expectedSceneKind === "solarSystem"
    ? getReadOnlySolarSystemScene(runtime, expectedSystemID)
    : (
        runtime && typeof runtime.getSceneForSession === "function"
          ? runtime.getSceneForSession(session)
          : null
      );
  const shipEntity = sourceScene && typeof sourceScene.getEntityByID === "function"
    ? sourceScene.getEntityByID(expectedShipID)
    : runtime && typeof runtime.getEntity === "function"
      ? runtime.getEntity(session, expectedShipID)
      : null;
  if (!shipEntity || toInt(shipEntity.itemID, 0) !== expectedShipID) {
    return {
      success: false,
      errorMsg: "ABYSSAL_HANDOFF_SHIP_NOT_IN_SOURCE_SCENE",
    };
  }

  const fallbackSceneKey = expectedSystemID > 0
    ? `solar-system:${expectedSystemID}`
    : "";
  const expectedSceneKey = normalizeText(expected.sceneKey, fallbackSceneKey);
  const sessionSceneKey = normalizeText(
    session && session._space && session._space.sceneKey,
    normalizeText(session && session.spaceSceneKey, fallbackSceneKey),
  );
  const scene = sourceScene;
  const runtimeSceneKey = normalizeText(scene && scene.sceneKey, sessionSceneKey);
  // During isolated-scene prewarm the runtime may project a copy of the source
  // ship into the destination scene before the authoritative attach. For an
  // entry handoff, membership in the exact K-space scene registry plus the
  // session attachment is authoritative; a mutable projection field is not.
  const shipSceneKey = expectedSceneKind === "solarSystem"
    ? runtimeSceneKey
    : normalizeText(shipEntity.sceneKey, runtimeSceneKey);
  if (
    !expectedSceneKey ||
    sessionSceneKey !== expectedSceneKey ||
    runtimeSceneKey !== expectedSceneKey ||
    shipSceneKey !== expectedSceneKey
  ) {
    log.warn(
      `[AbyssalTransition] source scene identity changed ` +
        `character=${expectedCharacterID} ship=${expectedShipID} ` +
        `expected=${expectedSceneKey || "none"} session=${sessionSceneKey || "none"} ` +
        `runtime=${runtimeSceneKey || "none"} shipScene=${shipSceneKey || "none"}`,
    );
    return {
      success: false,
      errorMsg: "ABYSSAL_HANDOFF_SOURCE_SCENE_CHANGED",
      data: {
        expectedSceneKey,
        sessionSceneKey,
        runtimeSceneKey,
        shipSceneKey,
      },
    };
  }

  return {
    success: true,
    data: {
      context,
      shipItem,
      shipEntity,
      scene,
      sceneKey: expectedSceneKey,
    },
  };
}

function createAbyssalAdmissionIdentity(ports) {
  return {
    allocateAbyssalSpatialReservation: allocateAbyssalSpatialReservation.bind(null, ports),
    reserveAbyssalSpatialSlotForPocketState: reserveAbyssalSpatialSlotForPocketState.bind(null, ports),
    resolveExistingActiveRunConflict: resolveExistingActiveRunConflict.bind(null, ports),
    buildAbyssalHandoffSessionIdentity: buildAbyssalHandoffSessionIdentity.bind(null, ports),
  };
}

module.exports = { createAbyssalAdmissionIdentity };
