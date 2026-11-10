"use strict";

const { normalizeText } = require("../domain/abyssalValueUtils");

// Registration and durable adoption use the existing state owners; no private cache.
function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function persistRegisteredAbyssalPocketState(ports,
  pocketState,
  deps = ports.getDependencies(),
  options = {},
) {
  const {
    buildPersistedAbyssalRuntimeState, verifyPersistedAbyssalPocketState,
    ABYSSAL_POCKET_PERSISTENCE_ERROR, log, setPersistenceFailure, hasPersistenceFailure,
    getPersistedStateSignature, deletePersistenceFailure, setPersistedStateSignature,
    deletePersistedStateSignature, recordWrite,
  } = ports;
  const instanceID = toInt(pocketState && pocketState.instanceID, 0);
  const requireDurableStore = options.requireDurableStore === true;
  const verifyReadBack = options.verifyReadBack === true;
  const forceWrite = options.forceWrite === true;
  if (!pocketState || instanceID <= 0) {
    return {
      success: false,
      skipped: false,
      durable: false,
      instanceID,
      errorMsg: "POCKET_STATE_MISSING",
    };
  }
  if (
    !deps ||
    !deps.dungeonRuntime ||
    (
      typeof deps.dungeonRuntime.mergeEnvironmentStateDurably !== "function" &&
      typeof deps.dungeonRuntime.mergeEnvironmentState !== "function"
    )
  ) {
    const unavailableResult = {
      success: requireDurableStore !== true,
      skipped: true,
      durable: false,
      instanceID,
      errorMsg: "ABYSSAL_POCKET_DURABLE_STORE_UNAVAILABLE",
    };
    if (requireDurableStore) {
      setPersistenceFailure(instanceID, {
        instanceID,
        errorMsg: unavailableResult.errorMsg,
        failedAtMs: toInt(
          deps && typeof deps.now === "function" ? deps.now() : Date.now(),
          Date.now(),
        ),
      });
    }
    return unavailableResult;
  }
  try {
    const nowMs = toInt(deps.now && deps.now(), Date.now());
    const persistedState = buildPersistedAbyssalRuntimeState(pocketState, nowMs);
    const durableSignature = JSON.stringify(persistedState.pocketState);
    if (
      !forceWrite &&
      !hasPersistenceFailure(instanceID) &&
      getPersistedStateSignature(instanceID) === durableSignature
    ) {
      return {
        success: true,
        skipped: true,
        unchanged: true,
        durable: true,
        instanceID,
        persistedState,
      };
    }
    const durableMergeEnvironmentState =
      typeof deps.dungeonRuntime.mergeEnvironmentStateDurably === "function"
        ? deps.dungeonRuntime.mergeEnvironmentStateDurably.bind(deps.dungeonRuntime)
        : (instanceIDArg, patchArg, mergeOptions = {}) =>
            deps.dungeonRuntime.mergeEnvironmentState(
              instanceIDArg,
              patchArg,
              { ...mergeOptions, durable: true },
            );
    let instance = durableMergeEnvironmentState(
      pocketState.instanceID,
      { abyssalRuntimeState: persistedState },
      { nowMs, force: forceWrite },
    );
    if (verifyReadBack) {
      if (
        !deps.dungeonRuntime ||
        typeof deps.dungeonRuntime.getPersistedInstance !== "function"
      ) {
        throw new Error("ABYSSAL_POCKET_DURABLE_READBACK_UNAVAILABLE");
      }
      // Critical receipt verification must read the physical backend rather
      // than either the Abyssal manager cache or dungeonRuntime's process cache.
      instance = deps.dungeonRuntime.getPersistedInstance(instanceID);
    }
    if (verifyReadBack) {
      const verification = verifyPersistedAbyssalPocketState(
        persistedState.pocketState,
        instance,
      );
      if (!verification.success) {
        throw new Error(verification.errorMsg);
      }
    }
    deletePersistenceFailure(instanceID);
    setPersistedStateSignature(instanceID, durableSignature);
    recordWrite();
    return {
      success: true,
      skipped: false,
      durable: true,
      instanceID,
      instance,
      persistedState,
    };
  } catch (error) {
    const errorMsg = normalizeText(
      error && error.message,
      ABYSSAL_POCKET_PERSISTENCE_ERROR,
    );
    setPersistenceFailure(instanceID, {
      instanceID,
      errorMsg,
      failedAtMs: toInt(deps && deps.now && deps.now(), Date.now()),
    });
    deletePersistedStateSignature(instanceID);
    log.warn(
      `[AbyssalRunStore] persist failed run=${instanceID} reason=${errorMsg}`,
    );
    return {
      success: false,
      skipped: false,
      durable: false,
      instanceID,
      errorMsg,
    };
  }
}

function ensureAbyssalPocketPersistenceReady(ports,
  pocketState,
  deps = ports.getDependencies(),
) {
  const {
    getActivePocketStateByInstanceID, getPersistenceFailure,
  } = ports;
  const instanceID = toInt(pocketState && pocketState.instanceID, 0);
  if (instanceID <= 0) {
    return { success: false, errorMsg: "POCKET_STATE_MISSING" };
  }
  const priorFailure = getPersistenceFailure(instanceID) || null;
  if (!priorFailure) {
    return { success: true, retried: false };
  }
  const currentState = getActivePocketStateByInstanceID(instanceID) || pocketState;
  const retryResult = persistRegisteredAbyssalPocketState(ports, currentState, deps);
  if (retryResult && retryResult.success === true) {
    return { ...retryResult, retried: true };
  }
  return {
    success: false,
    retried: true,
    errorMsg: "ABYSSAL_RUN_STATE_PERSIST_FAILED",
    persistenceErrorMsg: normalizeText(
      retryResult && retryResult.errorMsg,
      priorFailure.errorMsg,
    ),
  };
}

function mergeProtectedAbyssalParticipantDestructionOperations(ports,
  previousState,
  requestedState,
) {
  const {
    getAbyssalParticipantDestructionOperationsByCharacterID,
    evaluateAbyssalParticipantDestructionOperationTransition,
    logRejectedAbyssalParticipantDestructionTransition, cloneValue,
    normalizeAbyssalParticipantDestructionOperation,
  } = ports;
  const previous = getAbyssalParticipantDestructionOperationsByCharacterID(
    previousState,
  );
  const requested = getAbyssalParticipantDestructionOperationsByCharacterID(
    requestedState,
  );
  const merged = {};
  const keys = new Set([...Object.keys(previous), ...Object.keys(requested)]);
  for (const key of keys) {
    const transition = evaluateAbyssalParticipantDestructionOperationTransition(
      previous[key],
      requested[key],
    );
    if (!transition.allowed) {
      logRejectedAbyssalParticipantDestructionTransition(
        previousState || requestedState,
        transition,
      );
      if (previous[key]) merged[key] = cloneValue(previous[key]);
      continue;
    }
    const selected = requested[key] || previous[key];
    if (!selected) continue;
    merged[key] = transition.idempotent && previous[key]
      ? normalizeAbyssalParticipantDestructionOperation({
          ...cloneValue(selected),
          hullIntentCommittedAtMs: toInt(
            previous[key].hullIntentCommittedAtMs,
            selected.hullIntentCommittedAtMs,
          ),
          hullDestroyedAtMs: toInt(
            previous[key].hullDestroyedAtMs,
            selected.hullDestroyedAtMs,
          ),
          intentCommittedAtMs: toInt(
            previous[key].intentCommittedAtMs,
            selected.intentCommittedAtMs,
          ),
          podDestroyedAtMs: toInt(
            previous[key].podDestroyedAtMs,
            selected.podDestroyedAtMs,
          ),
          hullReceipt:
            cloneValue(previous[key].hullReceipt) ||
            cloneValue(selected.hullReceipt),
          receipt:
            cloneValue(previous[key].receipt) || cloneValue(selected.receipt),
        })
      : cloneValue(selected);
  }
  return merged;
}

function registerPocket(ports, pocketState, options = {}) {
  const {
    cloneValue, ABYSSAL_POCKET_MUTATION_DURABILITY, registerAbyssalPocketInMemory,
    AbyssalPocketPersistenceError,
  } = ports;
  const batchedResult = registerAbyssalPocketInMemory(pocketState);
  if (batchedResult) {
    if (batchedResult.success !== true) {
      throw new AbyssalPocketPersistenceError(batchedResult || {});
    }
    return batchedResult.state;
  }
  const result = registerPocketInternal(ports, pocketState, {
    ...options,
    durability: ABYSSAL_POCKET_MUTATION_DURABILITY.DURABLE,
  });
  if (!result || result.success !== true) {
    const errorMsg = normalizeText(result && result.errorMsg, "");
    if (
      errorMsg === "POCKET_STATE_MISSING" ||
      errorMsg === "ABYSSAL_SPATIAL_SLOT_CAPACITY_EXHAUSTED"
    ) {
      return null;
    }
    throw new AbyssalPocketPersistenceError(result || {});
  }
  return cloneValue(result.state);
}

function registerPocketBestEffort(ports,
  pocketState,
  deps = ports.getDependencies(),
  options = {},
) {
  const {
    ABYSSAL_POCKET_MUTATION_DURABILITY, registerAbyssalPocketInMemory,
  } = ports;
  const batchedResult = registerAbyssalPocketInMemory(pocketState);
  if (batchedResult) {
    return {
      ...batchedResult,
      bestEffort: true,
      persistenceResult: {
        success: true,
        skipped: true,
        batched: true,
        durable: false,
      },
    };
  }
  return registerPocketInternal(ports, pocketState, {
    ...options,
    deps,
    durability: ABYSSAL_POCKET_MUTATION_DURABILITY.BEST_EFFORT,
  });
}

function evaluateAbyssalPocketIdentityCompatibility(ports, leftState, rightState) {
  const fields = ["instanceID", "characterID", "shipID", "traceItemID"];
  for (const field of fields) {
    const left = toInt(leftState && leftState[field], 0);
    const right = toInt(rightState && rightState[field], 0);
    if (left > 0 && right > 0 && left !== right) {
      return {
        compatible: false,
        field,
        left,
        right,
        errorMsg: `ABYSSAL_POCKET_IDENTITY_CONFLICT:${field}`,
      };
    }
  }
  return { compatible: true };
}

function prepareRunRegistration(ports, work) {
  const {
    cloneValue, ABYSSAL_POCKET_MUTATION_DURABILITY, ABYSSAL_PARTICIPANT_ROSTER_SCHEMA_VERSION,
    normalizeAbyssalParticipantRoster, listUniquePositiveInts, PLACEHOLDER_POCKET_MODE,
    PLACEHOLDER_POCKET_ISOLATION, getRegisteredRun,
  } = ports;
  const {
    pocketState, options,
  } = work;
  const deps = options.deps || ports.getDependencies();
  const durability = normalizeText(
    options.durability,
    ABYSSAL_POCKET_MUTATION_DURABILITY.DURABLE,
  );
  const durable = durability === ABYSSAL_POCKET_MUTATION_DURABILITY.DURABLE;
  const previousState = getRegisteredRun(
    toInt(pocketState.instanceID, 0),
  );
  const normalizedState = {
    ...cloneValue(pocketState),
    instanceID: toInt(pocketState.instanceID, 0),
    traceItemID: toInt(pocketState.traceItemID, 0),
    characterID: toInt(pocketState.characterID, 0),
    shipID: toInt(pocketState.shipID, 0),
    shipClass: normalizeText(pocketState.shipClass, ""),
    requiredFilaments: Math.max(1, toInt(pocketState.requiredFilaments, 1)),
    maxShips: Math.max(1, toInt(pocketState.maxShips, 1)),
    fleetID: toInt(pocketState.fleetID, 0),
    participantRosterSchemaVersion: ABYSSAL_PARTICIPANT_ROSTER_SCHEMA_VERSION,
    participantRoster: normalizeAbyssalParticipantRoster(pocketState, previousState),
    eligibleParticipantCharacterIDs: listUniquePositiveInts(
      pocketState.eligibleParticipantCharacterIDs,
    ),
    rewardBeneficiaryCharacterID: toInt(
      pocketState.rewardBeneficiaryCharacterID,
      toInt(pocketState.characterID, 0),
    ),
    solarSystemID: toInt(pocketState.solarSystemID, 0),
    abyssalLocationID: toInt(pocketState.abyssalLocationID, 0),
    activatedAtMs: toInt(pocketState.activatedAtMs, 0),
    originMarkerItemID: toInt(pocketState.originMarkerItemID, 0),
    exitMarkerItemID: toInt(pocketState.exitMarkerItemID, 0),
    sourceTraceItemID: toInt(pocketState.sourceTraceItemID, 0),
    sourceSolarSystemID: toInt(pocketState.sourceSolarSystemID, 0),
    sourceLocationID: toInt(pocketState.sourceLocationID, 0),
    sourceBallID: toInt(pocketState.sourceBallID, 0),
    sourceBubbleID: toInt(pocketState.sourceBubbleID, 0),
    placeholderMode: normalizeText(pocketState.placeholderMode, PLACEHOLDER_POCKET_MODE),
    isolationMode: normalizeText(pocketState.isolationMode, PLACEHOLDER_POCKET_ISOLATION),
  };
  Object.assign(work, { deps, durability, durable, previousState, normalizedState });
}

function protectRegisteredRunEvidence(ports, work) {
  const {
    log, cloneValue, normalizeAbyssalRunOutcome, evaluateAbyssalRunOutcomeTransition,
    logRejectedAbyssalRunOutcomeTransition, isKnownAbyssalRunOutcome,
    ABYSSAL_PARTICIPANT_DESTRUCTION_MAP_SCHEMA_VERSION,
    mergeProtectedAbyssalRewardArtifactDestructionOperations,
  } = ports;
  const {
    normalizedState, previousState,
  } = work;
  normalizedState.runOutcome = normalizeAbyssalRunOutcome(
    normalizedState.runOutcome,
  );
  if (previousState) {
    const transition = evaluateAbyssalRunOutcomeTransition(
      previousState.runOutcome,
      normalizedState.runOutcome,
    );
    if (!transition.allowed) {
      logRejectedAbyssalRunOutcomeTransition(
        previousState,
        transition,
        normalizedState.runOutcomeDetails,
      );
      normalizedState.runOutcome = normalizeAbyssalRunOutcome(
        previousState.runOutcome,
      );
      normalizedState.runOutcomeAtMs = toInt(
        previousState.runOutcomeAtMs,
        0,
      );
      normalizedState.runOutcomeDetails = cloneValue(
        previousState.runOutcomeDetails,
      );
    } else if (transition.idempotent) {
      // Preserve the first committed timestamp and details. Repeated callbacks
      // for the same outcome are idempotent observations, not new transitions.
      normalizedState.runOutcomeAtMs = toInt(
        previousState.runOutcomeAtMs,
        toInt(normalizedState.runOutcomeAtMs, 0),
      );
      normalizedState.runOutcomeDetails = cloneValue(
        previousState.runOutcomeDetails,
      ) || cloneValue(normalizedState.runOutcomeDetails);
    }
  } else if (
    normalizedState.runOutcome &&
    !isKnownAbyssalRunOutcome(normalizedState.runOutcome)
  ) {
    // Preserve unknown persisted evidence but treat it as immutable. Startup
    // recovery can retain/clean it explicitly instead of silently rewriting it.
    log.error(
      `[AbyssalMgr] recovered unknown run outcome ` +
        `char=${normalizedState.characterID} instance=${normalizedState.instanceID} ` +
        `trace=${normalizedState.traceItemID} outcome=${normalizedState.runOutcome}`,
    );
  }
  normalizedState.participantDestructionOperationsSchemaVersion =
    ABYSSAL_PARTICIPANT_DESTRUCTION_MAP_SCHEMA_VERSION;
  normalizedState.participantDestructionOperationsByCharacterID =
    mergeProtectedAbyssalParticipantDestructionOperations(ports,
      previousState,
      normalizedState,
    );
  const ownerDestructionOperation =
    normalizedState.participantDestructionOperationsByCharacterID[
      String(normalizedState.characterID)
    ] || null;
  if (ownerDestructionOperation) {
    // Retain the singular owner alias for persisted v1 runs and operational
    // tooling while all new authority is participant-keyed.
    normalizedState.participantDestructionOperation = cloneValue(
      ownerDestructionOperation,
    );
  } else {
    delete normalizedState.participantDestructionOperation;
  }
  normalizedState.rewardArtifactDestructionOperationsByItemID =
    mergeProtectedAbyssalRewardArtifactDestructionOperations(
      previousState,
      normalizedState,
    );
}

function validateRunRegistration(ports, work) {
  const {
    cloneValue, AbyssalRunRegistryError, validateRegistration,
  } = ports;
  const {
    normalizedState, previousState,
  } = work;
  try {
    validateRegistration(normalizedState, {
      replace: Boolean(previousState),
    });
  } catch (error) {
    if (!(error instanceof AbyssalRunRegistryError)) throw error;
    return {
      success: false,
      state: cloneValue(previousState),
      instanceID: normalizedState.instanceID,
      errorMsg: error.code,
      registryError: cloneValue(error.details),
    };
  }
}

function reserveRegistrationScene(ports, work) {
  const {
    log, cloneValue, resolveAbyssalSceneModeState, ABYSSAL_SCENE_MODE_ISOLATED,
    reserveAbyssalSpatialSlotForPocketState, formatVectorForLog, logAmbiguousAbyssalSceneMode,
  } = ports;
  const {
    normalizedState, deps,
  } = work;
  const sceneModeState = resolveAbyssalSceneModeState(normalizedState);
  let spatialReservationResult = null;
  if (sceneModeState.sceneMode === ABYSSAL_SCENE_MODE_ISOLATED) {
    const runtime = deps;
    spatialReservationResult = reserveAbyssalSpatialSlotForPocketState(
      normalizedState,
      runtime,
    );
    if (!spatialReservationResult.success) {
      log.error(
        `[AbyssalSpatialReservation] run=${normalizedState.instanceID} ` +
          `host=${toInt(normalizedState.abyssalLocationID, 0)} ` +
          `slot=${normalizedState.abyssalSlotID === undefined
            ? "missing"
            : toInt(normalizedState.abyssalSlotID, -1)} ` +
          `origin=${formatVectorForLog(normalizedState.abyssalSpatialOrigin)} ` +
          `scene=${normalizeText(normalizedState.sceneKey, "missing")} ` +
          `state=reservation-failed reason=${spatialReservationResult.errorMsg}`,
      );
      return {
        success: false,
        state: null,
        errorMsg: spatialReservationResult.errorMsg,
        spatialReservationResult,
      };
    }
    Object.assign(normalizedState, cloneValue(spatialReservationResult.patch));
    if (
      spatialReservationResult.created === true ||
      spatialReservationResult.migratedLegacyReservation === true
    ) {
      const reservation = spatialReservationResult.reservation;
      log.info(
        `[AbyssalSpatialReservation] run=${normalizedState.instanceID} ` +
          `host=${reservation.hostSystemID} slot=${reservation.slotID} ` +
          `origin=${formatVectorForLog(reservation.spatialOrigin)} ` +
          `scene=${reservation.sceneID} ` +
          `reason=${spatialReservationResult.migratedLegacyReservation === true
            ? "legacy-migration"
            : spatialReservationResult.restoredPersistedReservation === true
              ? "reconstruction"
              : "allocation"}`,
      );
    }
  }
  normalizedState.sceneMode = sceneModeState.sceneMode;
  normalizedState.sceneKey = sceneModeState.sceneMode === ABYSSAL_SCENE_MODE_ISOLATED
    ? normalizeText(sceneModeState.sceneKey, `abyssal-run:${normalizedState.instanceID}`)
    : "";
  normalizedState.sceneModeSource = sceneModeState.source;
  logAmbiguousAbyssalSceneMode(normalizedState, sceneModeState);
  work.spatialReservationResult = spatialReservationResult;
}

function commitRunRegistration(ports, work) {
  const {
    ABYSSAL_POCKET_PERSISTENCE_ERROR, cloneValue, ABYSSAL_POCKET_MUTATION_DURABILITY,
    getAbyssalPocketPersistenceVersion, buildAbyssalPocketMutationSignature, replaceRegisteredRun,
    registerRun, releaseSpatialSlot,
  } = ports;
  const {
    normalizedState, previousState, deps, durable, durability, options, spatialReservationResult,
  } = work;
  const previousVersion = getAbyssalPocketPersistenceVersion(previousState);
  const requestedVersion = getAbyssalPocketPersistenceVersion(normalizedState);
  const stateChanged = previousState
    ? buildAbyssalPocketMutationSignature(previousState) !==
      buildAbyssalPocketMutationSignature(normalizedState)
    : true;
  normalizedState.persistenceVersion = previousState
    ? stateChanged
      ? previousVersion + 1
      : Math.max(1, previousVersion)
    : Math.max(1, requestedVersion);
  const persistenceResult = persistRegisteredAbyssalPocketState(ports,
    normalizedState,
    deps,
    {
      requireDurableStore: durable,
      verifyReadBack: options.verifyReadBack === true,
      forceWrite: options.forceWrite === true,
    },
  );
  if (durable && (!persistenceResult || persistenceResult.success !== true)) {
    if (spatialReservationResult && spatialReservationResult.created === true) {
      releaseSpatialSlot(normalizedState.instanceID, {
        hostSystemID: spatialReservationResult.reservation.hostSystemID,
        slotID: spatialReservationResult.reservation.slotID,
      });
    }
    return {
      success: false,
      state: cloneValue(previousState),
      instanceID: normalizedState.instanceID,
      persistenceResult: cloneValue(persistenceResult),
      errorMsg: normalizeText(
        persistenceResult && persistenceResult.errorMsg,
        ABYSSAL_POCKET_PERSISTENCE_ERROR,
      ),
    };
  }
  if (previousState) replaceRegisteredRun(normalizedState);
  else registerRun(normalizedState);
  return {
    success: true,
    state: cloneValue(normalizedState),
    committedState: cloneValue(normalizedState),
    instanceID: normalizedState.instanceID,
    persistenceResult: cloneValue(persistenceResult),
    durable: Boolean(persistenceResult && persistenceResult.durable === true),
    bestEffort:
      durability === ABYSSAL_POCKET_MUTATION_DURABILITY.BEST_EFFORT,
  };
}

function registerPocketInternal(ports, pocketState, options = {}) {
  if (!pocketState || toInt(pocketState.instanceID, 0) <= 0) {
    return {
      success: false,
      state: null,
      errorMsg: "POCKET_STATE_MISSING",
    };
  }
  const work = { pocketState, options };
  prepareRunRegistration(ports, work);
  protectRegisteredRunEvidence(ports, work);
  const validation = validateRunRegistration(ports, work);
  if (validation) return validation;
  const reservation = reserveRegistrationScene(ports, work);
  if (reservation) return reservation;
  return commitRunRegistration(ports, work);
}

function loadRunAdoptionAuthority(ports, work) {
  const {
    getActivePocketStateByInstanceID, cloneValue,
  } = ports;
  const {
    suppliedPocketState, deps,
  } = work;
  const instanceID = toInt(suppliedPocketState && suppliedPocketState.instanceID, 0);
  if (instanceID <= 0) {
    return {
      success: false,
      adopted: false,
      errorMsg: "POCKET_STATE_MISSING",
      instanceID,
    };
  }
  const activeState = getActivePocketStateByInstanceID(instanceID);
  if (activeState) {
    const compatibility = evaluateAbyssalPocketIdentityCompatibility(ports,
      activeState,
      suppliedPocketState,
    );
    if (!compatibility.compatible) {
      return {
        success: false,
        adopted: false,
        instanceID,
        errorMsg: compatibility.errorMsg,
        compatibility,
      };
    }
    return {
      success: true,
      adopted: false,
      alreadyRegistered: true,
      instanceID,
      state: cloneValue(activeState),
      committedState: cloneValue(activeState),
    };
  }
  if (
    !deps ||
    !deps.dungeonRuntime ||
    typeof deps.dungeonRuntime.getPersistedInstance !== "function"
  ) {
    return {
      success: false,
      adopted: false,
      instanceID,
      errorMsg: "ABYSSAL_POCKET_DURABLE_ADOPTION_READ_UNAVAILABLE",
    };
  }
  let persistedInstance = null;
  try {
    persistedInstance = deps.dungeonRuntime.getPersistedInstance(instanceID);
  } catch (error) {
    return {
      success: false,
      adopted: false,
      instanceID,
      errorMsg: normalizeText(
        error && error.message,
        "ABYSSAL_POCKET_DURABLE_ADOPTION_READ_FAILED",
      ),
    };
  }
  if (!persistedInstance) {
    return {
      success: false,
      adopted: false,
      instanceID,
      errorMsg: "ABYSSAL_POCKET_DURABLE_ADOPTION_SOURCE_MISSING",
    };
  }
  Object.assign(work, { instanceID, persistedInstance });
}

function commitDurableRunAdoption(ports, work) {
  const {
    cloneValue, ABYSSAL_POCKET_MUTATION_DURABILITY, getAbyssalPocketPersistenceVersion,
    buildPocketStateFromInstance,
  } = ports;
  const {
    suppliedPocketState, deps, options, instanceID, persistedInstance,
  } = work;
  const persistedPocketState = buildPocketStateFromInstance(
    persistedInstance,
    null,
  );
  const compatibility = evaluateAbyssalPocketIdentityCompatibility(ports,
    persistedPocketState,
    suppliedPocketState,
  );
  if (!compatibility.compatible) {
    return {
      success: false,
      adopted: false,
      instanceID,
      errorMsg: compatibility.errorMsg,
      compatibility,
    };
  }
  const suppliedVersion = getAbyssalPocketPersistenceVersion(suppliedPocketState);
  const persistedVersion = getAbyssalPocketPersistenceVersion(persistedPocketState);
  if (suppliedVersion > persistedVersion && persistedVersion > 0) {
    return {
      success: false,
      adopted: false,
      instanceID,
      suppliedVersion,
      persistedVersion,
      errorMsg: "ABYSSAL_POCKET_DURABLE_ADOPTION_STATE_AHEAD_OF_STORE",
    };
  }
  const adoptionCandidate = persistedVersion > 0
    ? {
        ...cloneValue(persistedPocketState),
        instance: cloneValue(persistedInstance),
      }
    : {
        ...cloneValue(persistedPocketState || {}),
        ...cloneValue(suppliedPocketState),
        instanceID,
        instance: cloneValue(persistedInstance),
      };
  const registration = registerPocketInternal(ports, adoptionCandidate, {
    deps,
    durability: ABYSSAL_POCKET_MUTATION_DURABILITY.DURABLE,
    verifyReadBack: options.verifyReadBack !== false,
    forceWrite: options.forceWrite === true,
  });
  if (!registration || registration.success !== true) {
    return {
      success: false,
      adopted: false,
      instanceID,
      errorMsg: normalizeText(
        registration && registration.errorMsg,
        "ABYSSAL_POCKET_DURABLE_ADOPTION_FAILED",
      ),
      persistenceResult: cloneValue(
        registration && registration.persistenceResult,
      ),
    };
  }
  return {
    ...registration,
    success: true,
    adopted: true,
    instanceID,
    state: cloneValue(registration.committedState || registration.state),
  };
}

function ensureAbyssalPocketDurablyAdopted(ports, suppliedPocketState, deps = ports.getDependencies(), options = {}) {
  const work = { suppliedPocketState, deps, options };
  const authority = loadRunAdoptionAuthority(ports, work);
  if (authority) return authority;
  return commitDurableRunAdoption(ports, work);
}

function createAbyssalRunRegistration(ports) {
  return {
    persistRegisteredAbyssalPocketState: persistRegisteredAbyssalPocketState.bind(null, ports),
    ensureAbyssalPocketPersistenceReady: ensureAbyssalPocketPersistenceReady.bind(null, ports),
    mergeProtectedAbyssalParticipantDestructionOperations: mergeProtectedAbyssalParticipantDestructionOperations.bind(null, ports),
    registerPocketInternal: registerPocketInternal.bind(null, ports),
    registerPocket: registerPocket.bind(null, ports),
    registerPocketBestEffort: registerPocketBestEffort.bind(null, ports),
    evaluateAbyssalPocketIdentityCompatibility: evaluateAbyssalPocketIdentityCompatibility.bind(null, ports),
    ensureAbyssalPocketDurablyAdopted: ensureAbyssalPocketDurablyAdopted.bind(null, ports),
  };
}

module.exports = { createAbyssalRunRegistration };
