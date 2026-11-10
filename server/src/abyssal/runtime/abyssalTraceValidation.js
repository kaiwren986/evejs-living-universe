"use strict";

const { normalizeText } = require("../domain/abyssalValueUtils");

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

// Each invocation owns its work record; registries and persistence remain external.
function validateAbyssalTraceActivation(ports, args, session, deps = ports.getDependencies()) {
  const work = { args, session, deps };
  for (const validate of [
    resolveActivationTrace,
    validateActivationOwner,
    resolveActivationShip,
    validateActivationMode,
    validateActivationFleet,
    resolveActivationRun,
    validateActivationParticipant,
    validateActivationSecurity,
    validateActivationRange,
    prepareActivationReturnState,
    persistActivationIdentity,
  ]) {
    const rejected = validate(ports, work);
    if (rejected) return rejected;
  }
  return buildActivationResult(ports, work);
}

function resolveActivationTrace(ports, work) {
  const {
    ABYSSAL_TRACE_LIFECYCLE_PHASE,
    ABYSS_ERROR,
    buildValidationError,
    canRecoverCreatedAbyssalTraceAfterRestart,
    ensureSystemStalePlaceholderCleanup,
    expireCreatedAbyssalTrace,
    getActiveTraceState,
    getSessionContext,
    isCreatedAbyssalTraceExpired,
    normalizeAbyssalTraceLifecyclePhase,
    resetPersistedAbyssalRunsAfterServerRestart,
    resolveGateTraceID,
  } = ports;
  const { args, session, deps } = work;
  const context = getSessionContext(session);
  resetPersistedAbyssalRunsAfterServerRestart(context.systemID, deps, "server-restart-reset", session);
  ensureSystemStalePlaceholderCleanup(context.systemID, deps, "entrance-activation");
  const traceItemID = resolveGateTraceID(args, session, deps);
  const traceState = getActiveTraceState(traceItemID, deps);
  if (!traceState) {
    return {
      success: false,
      error: buildValidationError(ABYSS_ERROR.ENTRANCE_MISSING, {
        reason: "TRACE_NOT_FOUND",
        traceItemID,
      }),
    };
  }
  const traceLifecyclePhase = normalizeAbyssalTraceLifecyclePhase(
    traceState.lifecyclePhase,
  );
  if (
    ![
      ABYSSAL_TRACE_LIFECYCLE_PHASE.CREATED,
      ABYSSAL_TRACE_LIFECYCLE_PHASE.ACTIVE,
    ].includes(traceLifecyclePhase)
  ) {
    return {
      success: false,
      error: buildValidationError(ABYSS_ERROR.ENTRANCE_MISSING, {
        reason: traceLifecyclePhase === ABYSSAL_TRACE_LIFECYCLE_PHASE.REMOVED
          ? "TRACE_REMOVED_NON_INTERACTIVE"
          : traceLifecyclePhase === ABYSSAL_TRACE_LIFECYCLE_PHASE.RETURNED
            ? "TRACE_RETURNED_NON_INTERACTIVE"
            : "TRACE_LIFECYCLE_NON_INTERACTIVE",
        traceItemID: traceState.traceItemID,
      }),
    };
  }
  const activationNowMs = toInt(deps && deps.now && deps.now(), Date.now());
  if (
    traceLifecyclePhase === ABYSSAL_TRACE_LIFECYCLE_PHASE.CREATED &&
    isCreatedAbyssalTraceExpired(traceState, activationNowMs)
  ) {
    const expirationResult = expireCreatedAbyssalTrace(
      traceState,
      deps,
      "created-trace-activation-deadline",
    );
    return {
      success: false,
      error: buildValidationError(ABYSS_ERROR.ENTRANCE_MISSING, {
        reason: "TRACE_EXPIRED",
        traceItemID: traceState.traceItemID,
        expiresAtMs: toInt(traceState.expiresAtMs, 0),
        nowMs: activationNowMs,
        invalidated: Boolean(expirationResult && expirationResult.success),
        invalidationMode: normalizeText(
          expirationResult && expirationResult.invalidationMode,
          "failed",
        ),
      }),
    };
  }
  if (
    traceLifecyclePhase === ABYSSAL_TRACE_LIFECYCLE_PHASE.CREATED &&
    !canRecoverCreatedAbyssalTraceAfterRestart(traceState)
  ) {
    return {
      success: false,
      error: buildValidationError(ABYSS_ERROR.ENTRANCE_MISSING, {
        reason: "TRACE_FILAMENT_CONSUMPTION_UNCOMMITTED",
        traceItemID: traceState.traceItemID,
      }),
    };
  }
  Object.assign(work, { context, traceState });
  return null;
}

function validateActivationOwner(ports, work) {
  const {
    ABYSS_ERROR,
    ABYSS_ERROR_KIND,
    buildValidationError,
    getActivePocketStateForCharacterID,
  } = ports;
  const { context, traceState } = work;
  if (context.characterID <= 0 || context.systemID <= 0) {
    return {
      success: false,
      error: buildValidationError(ABYSS_ERROR.SHIP_NOT_IN_SPACE, {
        reason: "CHARACTER_NOT_IN_SPACE",
        traceItemID: traceState.traceItemID,
      }),
    };
  }
  const isTraceOwner = toInt(traceState.characterID, 0) === context.characterID;
  if (
    !isTraceOwner &&
    traceState.activateForFleet !== true &&
    toInt(traceState.maxShips, 1) <= 1 &&
    toInt(traceState.requiredFilaments, 1) <= 1
  ) {
    return {
      success: false,
      error: buildValidationError(ABYSS_ERROR.INVALID_OWNER, {
        reason: "TRACE_OWNER_MISMATCH",
        traceItemID: traceState.traceItemID,
        traceCharacterID: traceState.characterID,
        characterID: context.characterID,
      }),
    };
  }
  const activePocketState = getActivePocketStateForCharacterID(context.characterID);
  if (
    activePocketState &&
    activePocketState.traceItemID > 0 &&
    activePocketState.traceItemID !== traceState.traceItemID
  ) {
    return {
      success: false,
      error: buildValidationError(
        ABYSS_ERROR.UNKNOWN_ERROR,
        {
          reason: "ACTIVE_POCKET_ALREADY_EXISTS",
          traceItemID: traceState.traceItemID,
          activeInstanceID: activePocketState.instanceID,
          activeTraceItemID: activePocketState.traceItemID,
        },
        ABYSS_ERROR_KIND.ACTIVE_RUN_CONFLICT,
      ),
    };
  }
  if (
    traceState.solarSystemID > 0 &&
    traceState.solarSystemID !== context.systemID
  ) {
    return {
      success: false,
      error: buildValidationError(ABYSS_ERROR.ENTRANCE_MISSING, {
        reason: "TRACE_SYSTEM_MISMATCH",
        traceItemID: traceState.traceItemID,
        traceSolarSystemID: traceState.solarSystemID,
        solarSystemID: context.systemID,
      }),
    };
  }
  Object.assign(work, { isTraceOwner });
  return null;
}

function resolveActivationShip(ports, work) {
  const {
    ABYSS_ERROR,
    ABYSS_ERROR_KIND,
    buildValidationError,
    getGroupID,
    getGroupName,
    resolveShipClassProfile,
    resolveTraceContentProfile,
  } = ports;
  const { context, traceState, session, deps } = work;
  const runtime = deps;
  const shipItem = deps.findItemById(context.shipID);
  const shipEntity = context.shipID > 0
    ? runtime.getEntity(session, context.shipID)
    : null;
  if (!shipItem || !shipEntity) {
    return {
      success: false,
      error: buildValidationError(ABYSS_ERROR.SHIP_NOT_IN_SPACE, {
        reason: "SHIP_NOT_IN_SPACE",
        traceItemID: traceState.traceItemID,
        shipID: context.shipID,
      }),
    };
  }
  const shipItemOwnerID = toInt(shipItem.ownerID, 0);
  const shipEntityOwnerID = toInt(shipEntity.ownerID, 0);
  if (
    (shipItemOwnerID > 0 && shipItemOwnerID !== context.characterID) ||
    (shipEntityOwnerID > 0 && shipEntityOwnerID !== context.characterID)
  ) {
    return {
      success: false,
      error: buildValidationError(ABYSS_ERROR.INVALID_OWNER, {
        reason: "SHIP_OWNER_MISMATCH",
        traceItemID: traceState.traceItemID,
        shipID: context.shipID,
        characterID: context.characterID,
        shipItemOwnerID,
        shipEntityOwnerID,
      }),
    };
  }
  const shipProfile = resolveShipClassProfile(shipItem, deps);
  if (!shipProfile) {
    return {
      success: false,
      error: buildValidationError(ABYSS_ERROR.INVALID_SHIP_CLASS, {
        shipTypeID: toInt(shipItem.typeID, 0),
        shipGroupID: getGroupID(shipItem, deps),
        shipGroupName: getGroupName(shipItem, deps),
      }),
    };
  }
  const filamentDefinitionResolution = resolveTraceContentProfile(traceState, shipProfile, deps);
  if (!filamentDefinitionResolution || !filamentDefinitionResolution.success) {
    return {
      success: false,
      error: buildValidationError(
        ABYSS_ERROR.UNSUPPORTED_FILAMENT_DEFINITION,
        {
          reason: normalizeText(
            filamentDefinitionResolution && filamentDefinitionResolution.errorMsg,
            "UNSUPPORTED_FILAMENT_DEFINITION",
          ),
          traceItemID: traceState.traceItemID,
          filamentTypeID: toInt(traceState.filamentTypeID, 0),
          filamentName: normalizeText(traceState.filamentName, ""),
          shipClass: normalizeText(shipProfile && shipProfile.key, ""),
        },
        ABYSS_ERROR_KIND.UNSUPPORTED_FILAMENT_DEFINITION,
      ),
    };
  }
  Object.assign(work, { runtime, shipItem, shipEntity, shipProfile, filamentDefinitionResolution });
  return null;
}

function validateActivationMode(ports, work) {
  const {
    ABYSS_ERROR,
    ABYSS_ERROR_KIND,
    buildValidationError,
    normalizeLowerText,
    resolveFilamentContentDefinition,
  } = ports;
  const { traceState, shipProfile, shipItem, deps } = work;
  const activationFilamentType = deps.resolveItemByTypeID(
    toInt(traceState.filamentTypeID, 0),
  );
  const activationModeResolution = activationFilamentType
    ? resolveFilamentContentDefinition(
      activationFilamentType,
      shipProfile,
      deps,
      toInt(traceState && (traceState.traceItemID || traceState.filamentItemID), 0),
    )
    : null;
  if (!activationModeResolution || !activationModeResolution.success) {
    return {
      success: false,
      error: buildValidationError(
        ABYSS_ERROR.UNSUPPORTED_FILAMENT_DEFINITION,
        {
          reason: normalizeText(
            activationModeResolution && activationModeResolution.errorMsg,
            activationFilamentType
              ? "UNSUPPORTED_FILAMENT_DEFINITION"
              : "FILAMENT_TYPE_NOT_FOUND",
          ),
          traceItemID: traceState.traceItemID,
          filamentTypeID: toInt(traceState.filamentTypeID, 0),
          filamentName: normalizeText(traceState.filamentName, ""),
          shipClass: normalizeText(shipProfile && shipProfile.key, ""),
        },
        ABYSS_ERROR_KIND.UNSUPPORTED_FILAMENT_DEFINITION,
      ),
    };
  }
  const activationModeDefinition = activationModeResolution.definition || {};
  const deployedShipClass = normalizeLowerText(traceState.shipClass, "");
  const activationShipClass = normalizeLowerText(shipProfile.key, "");
  const deployedRequiredFilaments = toInt(traceState.requiredFilaments, 0);
  const activationRequiredFilaments = toInt(
    activationModeDefinition.requiredFilaments,
    toInt(shipProfile.requiredFilaments, 0),
  );
  const deployedMaxShips = toInt(traceState.maxShips, 0);
  const activationMaxShips = toInt(activationModeDefinition.maxShips, 0);
  if (
    !deployedShipClass ||
    deployedShipClass !== activationShipClass ||
    deployedRequiredFilaments <= 0 ||
    deployedRequiredFilaments !== activationRequiredFilaments ||
    deployedMaxShips <= 0 ||
    deployedMaxShips !== activationMaxShips
  ) {
    return {
      success: false,
      error: buildValidationError(ABYSS_ERROR.INVALID_SHIP_CLASS, {
        reason: deployedShipClass !== activationShipClass
          ? "TRACE_SHIP_CLASS_MISMATCH"
          : "TRACE_SHIP_MODE_MISMATCH",
        traceItemID: traceState.traceItemID,
        deployedShipClass,
        activationShipClass,
        deployedRequiredFilaments,
        activationRequiredFilaments,
        deployedMaxShips,
        activationMaxShips,
        shipTypeID: toInt(shipItem.typeID, 0),
      }),
    };
  }
  Object.assign(work, { activationShipClass, activationRequiredFilaments, deployedMaxShips });
  return null;
}

function validateActivationFleet(ports, work) {
  const {
    ABYSS_ERROR,
    buildValidationError,
    isFleetRequiredForAbyssalShipProfile,
    resolveCurrentAuthoritativeAbyssalFleetMembership,
  } = ports;
  const {
    shipProfile,
    activationRequiredFilaments,
    traceState,
    context,
    activationShipClass,
    deps,
  } = work;
  let fleetMembership = null;
  if (isFleetRequiredForAbyssalShipProfile({
    ...shipProfile,
    requiredFilaments: activationRequiredFilaments,
  })) {
    const deployedFleetID = toInt(traceState.fleetID, 0);
    fleetMembership = resolveCurrentAuthoritativeAbyssalFleetMembership(
      context.characterID,
      deps,
    );
    if (fleetMembership.success !== true) {
      return {
        success: false,
        error: buildValidationError(ABYSS_ERROR.FLEET_STATE_INVALID, {
          reason: fleetMembership.reason,
          traceItemID: traceState.traceItemID,
          shipClass: activationShipClass,
          requiredFilaments: activationRequiredFilaments,
          deployedFleetID,
          currentFleetID: toInt(fleetMembership.fleetID, 0),
          authorityError: normalizeText(fleetMembership.errorMsg, ""),
        }),
      };
    }
    if (
      deployedFleetID <= 0 ||
      toInt(fleetMembership.fleetID, 0) !== deployedFleetID
    ) {
      return {
        success: false,
        error: buildValidationError(ABYSS_ERROR.FLEET_MEMBERSHIP_MISMATCH, {
          reason: "TRACE_FLEET_MISMATCH",
          traceItemID: traceState.traceItemID,
          shipClass: activationShipClass,
          requiredFilaments: activationRequiredFilaments,
          deployedFleetID,
          currentFleetID: toInt(fleetMembership.fleetID, 0),
        }),
      };
    }
  }
  Object.assign(work, { fleetMembership });
  return null;
}

function resolveActivationRun(ports, work) {
  const {
    ABYSS_ERROR,
    getPendingTraceActivation,
    getRunByTraceID,
    buildValidationError,
    getAbyssalParticipantRecord,
    getActivePocketStateByInstanceID,
    getPendingAbyssalTransitionState,
    listUniquePositiveInts,
    normalizeLowerText,
  } = ports;
  const { traceState, context, isTraceOwner, deps } = work;
  const indexedRunState = getRunByTraceID(
    traceState.traceItemID,
  );
  const existingRunID = toInt(
    traceState.abyssalRunID,
    toInt(indexedRunState && indexedRunState.instanceID, 0),
  );
  const existingRunState = existingRunID > 0
    ? getActivePocketStateByInstanceID(existingRunID)
    : null;
  const eligibleParticipantCharacterIDs = listUniquePositiveInts(
    traceState.eligibleParticipantCharacterIDs,
  );
  if (
    !isTraceOwner &&
    eligibleParticipantCharacterIDs.length > 1 &&
    !eligibleParticipantCharacterIDs.includes(context.characterID)
  ) {
    return {
      success: false,
      error: buildValidationError(ABYSS_ERROR.FLEET_MEMBERSHIP_MISMATCH, {
        reason: "TRACE_FLEET_ROSTER_MISMATCH",
        traceItemID: traceState.traceItemID,
        characterID: context.characterID,
        deployedFleetID: toInt(traceState.fleetID, 0),
      }),
    };
  }
  const existingEntryTransition = existingRunState
    ? getPendingAbyssalTransitionState(existingRunState)
    : null;
  const existingEntryInitializationPending = Boolean(
    existingEntryTransition &&
    existingEntryTransition.status === "pending" &&
    normalizeLowerText(existingEntryTransition.phase, "") === "entry",
  );
  const pendingActivationRecord = getPendingTraceActivation(
    toInt(traceState.traceItemID, 0),
  ) || null;
  const initializingParticipant = existingRunState
    ? getAbyssalParticipantRecord(existingRunState, context.characterID)
    : null;
  const continuesPendingEntryInitialization = Boolean(
    existingEntryInitializationPending &&
    (
      (
        pendingActivationRecord &&
        toInt(pendingActivationRecord.characterID, 0) === context.characterID
      ) ||
      (
        initializingParticipant &&
        toInt(initializingParticipant.shipID, 0) === context.shipID &&
        toInt(existingRunState && existingRunState.shipID, 0) === context.shipID
      )
    ),
  );
  if (existingEntryInitializationPending && !continuesPendingEntryInitialization) {
    return {
      success: false,
      error: buildValidationError(ABYSS_ERROR.ENTRANCE_MISSING, {
        reason: "ABYSSAL_RUN_NOT_READY_FOR_PARTICIPANTS",
        traceItemID: traceState.traceItemID,
        abyssalRunID: existingRunID,
      }),
    };
  }
  const joinExistingRun = Boolean(
    existingRunState && !existingEntryInitializationPending,
  );
  Object.assign(work, { existingRunState, existingRunID, joinExistingRun });
  return null;
}

function validateActivationParticipant(ports, work) {
  const {
    ABYSSAL_PARTICIPANT_STATUS,
    ABYSSAL_TERMINAL_PARTICIPANT_STATUSES,
    ABYSS_ERROR,
    buildValidationError,
    getAbyssalParticipantRecord,
    normalizeAbyssalParticipantRoster,
    resolveAbyssalParticipantAdmissionState,
  } = ports;
  const {
    joinExistingRun,
    existingRunState,
    existingRunID,
    traceState,
    context,
    deployedMaxShips,
  } = work;
  let participantRecord = null;
  if (joinExistingRun) {
    if (!existingRunState || existingRunState.gameplayAuthorityDetached === true) {
      return {
        success: false,
        error: buildValidationError(ABYSS_ERROR.ENTRANCE_MISSING, {
          reason: "ABYSSAL_RUN_NOT_READY_FOR_PARTICIPANTS",
          traceItemID: traceState.traceItemID,
          abyssalRunID: existingRunID,
        }),
      };
    }
    const participantAdmissionState =
      resolveAbyssalParticipantAdmissionState(existingRunState);
    if (participantAdmissionState.closed) {
      return {
        success: false,
        error: buildValidationError(ABYSS_ERROR.ENTRANCE_MISSING, {
          reason: "ABYSSAL_PARTICIPANT_ADMISSION_CLOSED",
          traceItemID: traceState.traceItemID,
          abyssalRunID: existingRunID,
          currentRoomIndex: participantAdmissionState.currentRoomIndex,
          objectiveComplete: participantAdmissionState.objectiveComplete,
          roomProgressionPending: participantAdmissionState.roomProgressionPending,
          pendingTransitionPhase: participantAdmissionState.pendingTransitionPhase,
        }),
      };
    }
    participantRecord = getAbyssalParticipantRecord(
      existingRunState,
      context.characterID,
    );
    if (
      participantRecord &&
      ABYSSAL_TERMINAL_PARTICIPANT_STATUSES.has(participantRecord.status)
    ) {
      return {
        success: false,
        error: buildValidationError(ABYSS_ERROR.ENTRANCE_MISSING, {
          reason: "ABYSSAL_PARTICIPANT_TERMINAL",
          traceItemID: traceState.traceItemID,
          characterID: context.characterID,
          participantStatus: participantRecord.status,
        }),
      };
    }
    const admittedParticipantCount = normalizeAbyssalParticipantRoster(existingRunState)
      .filter((participant) =>
        participant.status !== ABYSSAL_PARTICIPANT_STATUS.ADMISSION_FAILED
      ).length;
    if (
      (!participantRecord || participantRecord.status === ABYSSAL_PARTICIPANT_STATUS.ADMISSION_FAILED) &&
      admittedParticipantCount >= deployedMaxShips
    ) {
      return {
        success: false,
        error: buildValidationError(ABYSS_ERROR.FLEET_STATE_INVALID, {
          reason: "ABYSSAL_PARTICIPANT_CAPACITY_REACHED",
          traceItemID: traceState.traceItemID,
          abyssalRunID: existingRunID,
          admittedParticipantCount,
          maxShips: deployedMaxShips,
        }),
      };
    }
  }
  Object.assign(work, { participantRecord });
  return null;
}

function validateActivationSecurity(ports, work) {
  const {
    ABYSS_ERROR,
    buildValidationError,
    evaluateAbyssalShipActivationState,
    resolveAbyssalSecurityPolicy,
    toReal,
  } = ports;
  const { context, filamentDefinitionResolution, shipEntity, session, deps, traceState } = work;
  const solarSystem = deps.worldData.getSolarSystemByID(context.systemID);
  if (!solarSystem) {
    return {
      success: false,
      error: buildValidationError(ABYSS_ERROR.UNKNOWN_ERROR, {
        reason: "SOLAR_SYSTEM_NOT_FOUND",
        solarSystemID: context.systemID,
      }),
    };
  }
  const securityPolicy = resolveAbyssalSecurityPolicy(
    filamentDefinitionResolution.definition && filamentDefinitionResolution.definition.tier,
    solarSystem.security,
  );
  if (securityPolicy.allowed !== true) {
    return {
      success: false,
      error: buildValidationError(ABYSS_ERROR.SECURITY_RESTRICTED_SYSTEM, {
        reason: securityPolicy.reason,
        solarSystemID: context.systemID,
        security: toReal(solarSystem.security, 0),
        tier: toInt(
          filamentDefinitionResolution.definition &&
            filamentDefinitionResolution.definition.tier,
          0,
        ),
      }),
    };
  }
  const shipStateBlock = evaluateAbyssalShipActivationState(
    context,
    shipEntity,
    session,
    deps,
    { securityPolicy },
  );
  if (shipStateBlock) {
    return {
      success: false,
      error: buildValidationError(shipStateBlock.code, {
        traceItemID: traceState.traceItemID,
        ...shipStateBlock.details,
      }),
    };
  }
  Object.assign(work, { solarSystem, securityPolicy });
  return null;
}

function validateActivationRange(ports, work) {
  const {
    ABYSS_ERROR,
    TRACE_ACTIVATION_RANGE_METERS,
    TYPE_ABYSSAL_TRACE,
    buildValidationError,
    evaluateGateActivationRange,
    getObjectPosition,
    getObjectRadius,
    resolveTypeRecord,
  } = ports;
  const { traceState, runtime, session, deps, shipEntity } = work;
  const traceItem = deps.findItemById(traceState.traceItemID);
  const traceEntity = traceState.traceItemID > 0
    ? runtime.getEntity(session, traceState.traceItemID)
    : null;
  if (!traceItem && !traceEntity) {
    return {
      success: false,
      error: buildValidationError(ABYSS_ERROR.ENTRANCE_MISSING, {
        reason: "TRACE_ITEM_MISSING",
        traceItemID: traceState.traceItemID,
      }),
    };
  }
  const shipPosition = getObjectPosition(shipEntity);
  const tracePosition = getObjectPosition(traceEntity) || getObjectPosition(traceItem);
  const scene = runtime && typeof runtime.getSceneForSession === "function"
    ? runtime.getSceneForSession(session)
    : null;
  const traceRangeEntity = traceEntity || (traceItem
    ? {
        ...traceItem,
        position: tracePosition,
        radius: getObjectRadius(
          traceItem,
          resolveTypeRecord(traceItem || TYPE_ABYSSAL_TRACE, deps),
        ),
      }
    : null);
  const rangeState = evaluateGateActivationRange(
    scene,
    shipEntity,
    traceRangeEntity,
    TRACE_ACTIVATION_RANGE_METERS,
  );
  if (!rangeState.success) {
    return {
      success: false,
      error: buildValidationError(ABYSS_ERROR.TRACE_TOO_FAR, {
        reason: rangeState.surfaceDistance == null
          ? "TRACE_RANGE_STATE_UNAVAILABLE"
          : "TRACE_OUT_OF_RANGE",
        traceItemID: traceState.traceItemID,
        surfaceDistanceMeters: rangeState.surfaceDistance == null
          ? null
          : Math.trunc(rangeState.surfaceDistance),
        maximumDistanceMeters: rangeState.rangeMeters,
        reconciliationMeters: rangeState.reconciliationMeters,
      }),
    };
  }
  Object.assign(work, { traceItem, traceEntity, shipPosition, tracePosition });
  return null;
}

function prepareActivationReturnState(ports, work) {
  const {
    cloneValue,
    getAbyssalParticipantRecord,
    getObjectPosition,
    getObjectRadius,
    normalizeDirection,
    normalizeLowerText,
    resolveTypeRecord,
    upsertAbyssalParticipantRosterEntry,
  } = ports;
  const {
    securityPolicy,
    traceState,
    context,
    deps,
    shipEntity,
    shipItem,
    isTraceOwner,
    shipProfile,
  } = work;
  const suspectOnReturn = securityPolicy.suspectRequired === true;
  const existingSuspectReturnState = traceState.suspectReturnState &&
    typeof traceState.suspectReturnState === "object"
      ? cloneValue(traceState.suspectReturnState)
      : null;
  const existingSuspectReturnStateName = normalizeLowerText(
    existingSuspectReturnState && existingSuspectReturnState.state,
    "",
  );
  const normalizedSuspectReturnState = {
    ...(existingSuspectReturnState || {}),
    state: suspectOnReturn
      ? (
          existingSuspectReturnStateName && existingSuspectReturnStateName !== "not_required"
            ? existingSuspectReturnStateName
            : "pending"
        )
      : "not_required",
    idempotencyKey: normalizeText(
      existingSuspectReturnState && existingSuspectReturnState.idempotencyKey,
      `abyssal-return-suspect:${traceState.traceItemID}:${context.characterID}`,
    ),
    stagedAtMs: toInt(
      existingSuspectReturnState && existingSuspectReturnState.stagedAtMs,
      toInt(traceState.deployedAtMs, toInt(deps.now(), 0)),
    ),
    desiredUntilMs: toInt(
      existingSuspectReturnState && existingSuspectReturnState.desiredUntilMs,
      0,
    ),
    attemptCount: Math.max(
      0,
      toInt(existingSuspectReturnState && existingSuspectReturnState.attemptCount, 0),
    ),
  };
  const sourceShipPosition = getObjectPosition(shipEntity);
  const sourceShipDirection = normalizeDirection(shipEntity.direction, { x: 1, y: 0, z: 0 });
  const sourceShipRadius = getObjectRadius(shipEntity, resolveTypeRecord(shipItem, deps));
  const existingOwnerParticipant = isTraceOwner
    ? getAbyssalParticipantRecord(traceState, context.characterID)
    : null;
  const refreshedParticipantRoster = isTraceOwner
    ? upsertAbyssalParticipantRosterEntry(traceState, {
        ...(existingOwnerParticipant || {}),
        characterID: context.characterID,
        shipID: context.shipID,
        shipTypeID: toInt(shipItem.typeID, 0),
        shipClass: shipProfile.key,
        role: "owner",
        sourceSolarSystemID: context.systemID,
        sourceLocationID: toInt(shipItem.locationID, context.systemID),
        sourceShipPosition: cloneValue(sourceShipPosition),
        sourceShipDirection,
        sourceShipRadius,
        suspectOnReturn,
      })
    : traceState.participantRoster;
  Object.assign(work, { suspectOnReturn, normalizedSuspectReturnState, sourceShipPosition, sourceShipDirection, sourceShipRadius, refreshedParticipantRoster });
  return null;
}

function persistActivationIdentity(ports, work) {
  const {
    ABYSS_ERROR,
    buildValidationError,
    cloneValue,
    getObjectPosition,
    normalizeAbyssalParticipantRoster,
    persistTraceState,
    toReal,
  } = ports;
  const {
    isTraceOwner,
    traceState,
    filamentDefinitionResolution,
    context,
    shipItem,
    shipProfile,
    sourceShipPosition,
    sourceShipDirection,
    sourceShipRadius,
    refreshedParticipantRoster,
    securityPolicy,
    suspectOnReturn,
    normalizedSuspectReturnState,
    deps,
  } = work;
  const normalizedTraceActivationState = isTraceOwner
    ? {
        ...traceState,
        contentProfile: cloneValue(filamentDefinitionResolution.definition),
        shipID: context.shipID,
        shipTypeID: toInt(shipItem.typeID, 0),
        shipClass: shipProfile.key,
        sourceShipPosition: cloneValue(sourceShipPosition),
        sourceShipDirection,
        sourceShipRadius,
        participantRoster: refreshedParticipantRoster,
        securityPolicy: cloneValue(securityPolicy),
        suspectOnReturn,
        suspectReturnState: normalizedSuspectReturnState,
      }
    : traceState;
  const traceActivationStateChanged =
    JSON.stringify(traceState.contentProfile || null) !==
      JSON.stringify(filamentDefinitionResolution.definition || null) ||
    toInt(traceState.shipID, 0) !== context.shipID ||
    toInt(traceState.shipTypeID, 0) !== toInt(shipItem.typeID, 0) ||
    normalizeText(traceState.shipClass, "") !== shipProfile.key ||
    toReal(traceState.sourceShipRadius, 0) !== sourceShipRadius ||
    JSON.stringify(getObjectPosition(traceState.sourceShipPosition)) !==
      JSON.stringify(sourceShipPosition) ||
    JSON.stringify(traceState.sourceShipDirection || null) !==
      JSON.stringify(sourceShipDirection) ||
    JSON.stringify(normalizeAbyssalParticipantRoster(traceState)) !==
      JSON.stringify(refreshedParticipantRoster) ||
    traceState.suspectOnReturn !== suspectOnReturn ||
    JSON.stringify(traceState.securityPolicy || null) !== JSON.stringify(securityPolicy) ||
    JSON.stringify(traceState.suspectReturnState || null) !==
      JSON.stringify(normalizedSuspectReturnState);
  if (isTraceOwner && traceActivationStateChanged) {
    const persistActivationStateResult = persistTraceState(
      normalizedTraceActivationState,
      deps,
    );
    if (!persistActivationStateResult.success) {
      return {
        success: false,
        error: buildValidationError(ABYSS_ERROR.UNKNOWN_ERROR, {
          reason: "TRACE_ACTIVATION_STATE_PERSIST_FAILED",
          traceItemID: traceState.traceItemID,
        }),
      };
    }
  }
  Object.assign(traceState, normalizedTraceActivationState);
  if (!traceState.filamentName && traceState.filamentTypeID > 0) {
    const filamentType = deps.resolveItemByTypeID(traceState.filamentTypeID);
    if (filamentType && filamentType.name) {
      traceState.filamentName = normalizeText(filamentType.name, "");
    }
  }
  return null;
}

function buildActivationResult(ports, work) {
  const { ABYSSAL_PARTICIPANT_STATUS, cloneValue } = ports;
  const {
    context,
    traceState,
    shipItem,
    shipEntity,
    shipProfile,
    shipPosition,
    traceItem,
    traceEntity,
    tracePosition,
    runtime,
    solarSystem,
    securityPolicy,
    isTraceOwner,
    joinExistingRun,
    existingRunState,
    fleetMembership,
    participantRecord,
    sourceShipPosition,
    sourceShipDirection,
    sourceShipRadius,
    suspectOnReturn,
  } = work;
  return {
    success: true,
    data: {
      context,
      traceItemID: traceState.traceItemID,
      traceState,
      filamentDefinition: traceState.contentProfile,
      shipItem,
      shipEntity,
      shipProfile,
      shipPosition,
      traceItem,
      traceEntity,
      tracePosition,
      runtime,
      solarSystem,
      securityPolicy,
      isTraceOwner,
      joinExistingRun,
      existingRunState,
      fleetMembership,
      participantRecord,
      participantAdmission: (!isTraceOwner || joinExistingRun)
        ? {
            characterID: context.characterID,
            shipID: context.shipID,
            shipTypeID: toInt(shipItem.typeID, 0),
            shipClass: shipProfile.key,
            role: isTraceOwner ? "owner" : "member",
            status: ABYSSAL_PARTICIPANT_STATUS.ADMITTING,
            fleetID: toInt(fleetMembership && fleetMembership.fleetID, 0),
            currentRoomIndex: 1,
            sourceSolarSystemID: context.systemID,
            sourceLocationID: toInt(shipItem.locationID, context.systemID),
            sourceShipPosition: cloneValue(sourceShipPosition),
            sourceShipDirection,
            sourceShipRadius,
            suspectOnReturn,
          }
        : null,
    },
  };
}

function createAbyssalTraceValidation(ports) {
  return {
    validateAbyssalTraceActivation: validateAbyssalTraceActivation.bind(null, ports),
  };
}

module.exports = { createAbyssalTraceValidation };
