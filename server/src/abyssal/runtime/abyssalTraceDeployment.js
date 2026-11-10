"use strict";

const { TYPE_ABYSSAL_TRACE } = require("../domain/abyssalGatePresentation");
const {
  ABYSSAL_TRACE_LIFECYCLE_PHASE,
  buildAbyssalTraceSlimState,
  resolveAbyssalTraceAutomaticActivationDelayMs,
  resolveAbyssalTraceProfile,
} = require("../catalog/abyssalTraceProfiles");
const { normalizeText } = require("../domain/abyssalValueUtils");

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

// Transaction ordering is intentional: private preparation, consumption, durable
// consume marker, then publication/receipt. Failed post-consume stages use the
// existing compensation seam. Validation and compensation policy are not owned here.
function deployPlaceholderTrace({
  getDependencies,
  resolveConfiguredUnusedTraceDurationMs,
  getObjectPosition,
  normalizeDirection,
  buildInitialTraceState,
  prepareTraceDeployment,
}, validation, session, deps = getDependencies()) {
  const now = deps.now();
  const {
    context,
    filamentItem,
    filamentType,
    filamentDefinition,
    shipItem,
    shipProfile,
    spawnState,
  } = validation.data;
  const durationMs = resolveConfiguredUnusedTraceDurationMs(deps);
  const traceProfile = resolveAbyssalTraceProfile({
    filamentTypeID: toInt(filamentType && filamentType.typeID, 0),
    contentProfile: filamentDefinition,
  });
  if (!traceProfile) {
    return {
      success: false,
      errorMsg: "ABYSSAL_ENTRANCE_TRACE_PROFILE_UNSUPPORTED",
    };
  }
  const shipPosition = getObjectPosition(shipItem && shipItem.spaceState) ||
    getObjectPosition(validation.data.shipEntity);
  const sourceSceneKey = normalizeText(
    session && session._space && session._space.sceneKey,
    `solar-system:${context.systemID}`,
  );
  const sourceShipDirection = normalizeDirection(
    validation.data.shipEntity && validation.data.shipEntity.direction ||
      shipItem && shipItem.spaceState && shipItem.spaceState.direction,
    { x: 1, y: 0, z: 0 },
  );
  const initialTraceState = buildInitialTraceState({
    validation,
    deps,
    now,
    context,
    filamentItem,
    filamentType,
    filamentDefinition,
    shipItem,
    shipProfile,
    spawnState,
    durationMs,
    traceProfile,
    shipPosition,
    sourceSceneKey,
    sourceShipDirection,
  });
  return prepareTraceDeployment({
    validation,
    session,
    deps,
    now,
    context,
    filamentItem,
    filamentType,
    shipProfile,
    spawnState,
    traceProfile,
    shipPosition,
    sourceSceneKey,
    initialTraceState,
  });
}

function buildInitialTraceState({
  ABYSSAL_PARTICIPANT_ROSTER_SCHEMA_VERSION,
  ABYSSAL_PARTICIPANT_STATUS,
  cloneValue,
  getObjectRadius,
  resolveTypeRecord,
  listAuthoritativeAbyssalFleetCharacterIDs,
  GROUP_FILAMENT_TRACE,
}, attempt) {
  const {
    validation,
    deps,
    now,
    context,
    filamentItem,
    filamentType,
    filamentDefinition,
    shipItem,
    shipProfile,
    spawnState,
    durationMs,
    traceProfile,
    shipPosition,
    sourceSceneKey,
    sourceShipDirection,
  } = attempt;
  return {
    traceItemID: 0,
    characterID: context.characterID,
    shipID: context.shipID,
    solarSystemID: context.systemID,
    filamentItemID: filamentItem.itemID,
    filamentTypeID: toInt(filamentType && filamentType.typeID, 0),
    fleetID: context.fleetID,
    requiredFilaments: shipProfile.requiredFilaments,
    maxShips: toInt(filamentDefinition && filamentDefinition.maxShips, 0),
    activateForFleet: context.activateForFleet,
    participantRosterSchemaVersion: ABYSSAL_PARTICIPANT_ROSTER_SCHEMA_VERSION,
    participantRoster: [{
      characterID: context.characterID,
      shipID: context.shipID,
      shipTypeID: toInt(shipItem && shipItem.typeID, 0),
      shipClass: shipProfile.key,
      role: "owner",
      status: ABYSSAL_PARTICIPANT_STATUS.RESERVED,
      fleetID: context.fleetID,
      sourceSolarSystemID: context.systemID,
      sourceLocationID: toInt(shipItem && shipItem.locationID, context.systemID),
      sourceShipPosition: cloneValue(shipPosition),
      sourceShipDirection,
      sourceShipRadius: getObjectRadius(shipItem, resolveTypeRecord(shipItem, deps)),
      suspectOnReturn: validation.data.securityPolicy &&
        validation.data.securityPolicy.suspectRequired === true,
    }],
    eligibleParticipantCharacterIDs: validation.data.fleetMembership &&
      validation.data.fleetMembership.success === true
      ? listAuthoritativeAbyssalFleetCharacterIDs(
          validation.data.fleetMembership.fleet,
          context.characterID,
        )
      : [context.characterID],
    rewardBeneficiaryCharacterID: context.characterID,
    traceProfileID: normalizeText(traceProfile && traceProfile.traceProfileID, ""),
    lifecyclePhase: ABYSSAL_TRACE_LIFECYCLE_PHASE.CREATED,
    abyssalRunID: 0,
    sourceSolarSystemID: context.systemID,
    sourceSceneKey,
    sourceTracePosition: cloneValue(spawnState.position),
    sourceShipPosition: cloneValue(shipPosition),
    sourceShipDirection,
    sourceShipRadius: getObjectRadius(shipItem, resolveTypeRecord(shipItem, deps)),
    traceOrientation: cloneValue(spawnState.direction),
    ownerID: toInt(traceProfile.ownerID, context.characterID),
    typeID: toInt(traceProfile.typeID, TYPE_ABYSSAL_TRACE),
    groupID: toInt(traceProfile.groupID, GROUP_FILAMENT_TRACE),
    activationState: toInt(traceProfile.initialState.controllerActivationStateDefault, 0),
    isAbyssGateOpen: false,
    deployedAtMs: now,
    expiresAtMs: now + durationMs,
    shipClass: shipProfile.key,
    filamentName: String(filamentType && filamentType.name || ""),
    shipTypeID: toInt(shipItem && shipItem.typeID, 0),
    securityPolicy: cloneValue(validation.data.securityPolicy),
    suspectOnReturn: validation.data.securityPolicy &&
      validation.data.securityPolicy.suspectRequired === true,
    suspectReturnState: {
      state: validation.data.securityPolicy &&
        validation.data.securityPolicy.suspectRequired === true
        ? "pending"
        : "not_required",
      idempotencyKey: "",
      stagedAtMs: now,
      desiredUntilMs: 0,
      attemptCount: 0,
    },
    contentProfile: filamentDefinition,
    filamentConsumptionState: {
      schemaVersion: 1,
      status: "prepared",
      deploymentToken: "",
      filamentItemID: toInt(filamentItem && filamentItem.itemID, 0),
      filamentTypeID: toInt(filamentType && filamentType.typeID, 0),
      ownerID: toInt(filamentItem && filamentItem.ownerID, context.characterID),
      originalLocationID: toInt(filamentItem && filamentItem.locationID, context.shipID),
      originalFlagID: toInt(
        filamentItem && filamentItem.flagID,
        deps.ITEM_FLAGS.CARGO_HOLD,
      ),
      corporationID: toInt(context.corporationID, 0),
      customInfo: normalizeText(filamentItem && filamentItem.customInfo, ""),
      quantity: Math.max(1, toInt(shipProfile && shipProfile.requiredFilaments, 1)),
      preparedAtMs: now,
      committedAtMs: 0,
    },
  };
}

function prepareTraceDeployment({
  buildTraceCustomInfo,
  buildAbyssalTraceDeploymentToken,
  cloneValue,
  persistTraceState,
  destroyPlaceholderTrace,
  commitTraceDeployment,
}, attempt) {
  const {
    validation,
    session,
    deps,
    now,
    context,
    filamentItem,
    filamentType,
    shipProfile,
    spawnState,
    traceProfile,
    shipPosition,
    sourceSceneKey,
    initialTraceState,
  } = attempt;
  const initialTraceSlimState = buildAbyssalTraceSlimState(initialTraceState);
  if (initialTraceSlimState && initialTraceSlimState.slimFields) {
    Object.assign(initialTraceState, initialTraceSlimState.slimFields);
  }

  const createResult = deps.createSpaceItemForOwner(
    initialTraceState.ownerID,
    context.systemID,
    TYPE_ABYSSAL_TRACE,
    {
      position: spawnState.position,
      velocity: spawnState.velocity,
      direction: spawnState.direction,
      targetPoint: spawnState.targetPoint,
      speedFraction: spawnState.speedFraction,
      mode: spawnState.mode,
      expiresAtMs: initialTraceState.expiresAtMs,
      customInfo: buildTraceCustomInfo(initialTraceState),
    },
  );
  if (!createResult.success || !createResult.data) {
    return {
      success: false,
      errorMsg: createResult && createResult.errorMsg || "TRACE_ITEM_CREATE_FAILED",
    };
  }

  const traceItem = createResult.data;
  const automaticActivationDelayMs = initialTraceState.activateForFleet === true
    ? null
    : resolveAbyssalTraceAutomaticActivationDelayMs(traceProfile);
  const traceItemID = toInt(traceItem.itemID, 0);
  let traceState = {
    ...initialTraceState,
    traceItemID,
    deploymentToken: buildAbyssalTraceDeploymentToken(traceItemID, now),
    filamentConsumptionState: {
      ...cloneValue(initialTraceState.filamentConsumptionState),
      deploymentToken: buildAbyssalTraceDeploymentToken(traceItemID, now),
    },
    suspectReturnState: {
      ...cloneValue(initialTraceState.suspectReturnState),
      idempotencyKey: `abyssal-return-suspect:${traceItemID}:${context.characterID}`,
    },
    ...(automaticActivationDelayMs == null
      ? {}
      : {
          automaticActivation: {
            enabled: true,
            delayMs: automaticActivationDelayMs,
            status: "waiting-for-publication",
          },
        }),
  };
  const persistResult = persistTraceState(traceState, deps, { register: false });
  if (!persistResult.success) {
    destroyPlaceholderTrace(
      context.systemID,
      traceState.traceItemID,
      deps,
      "metadata-persist-failed",
    );
    return {
      success: false,
      errorMsg: persistResult.errorMsg || "TRACE_METADATA_PERSIST_FAILED",
    };
  }

  const spawnResult = deps.spawnDynamicInventoryEntity(
    context.systemID,
    traceState.traceItemID,
    { broadcast: false },
  );
  if (!spawnResult || !spawnResult.success) {
    destroyPlaceholderTrace(
      context.systemID,
      traceState.traceItemID,
      deps,
      "spawn-failed",
    );
    return {
      success: false,
      errorMsg: spawnResult && spawnResult.errorMsg || "TRACE_SPACE_SPAWN_FAILED",
    };
  }
  return commitTraceDeployment({
    ...attempt,
    traceState,
    automaticActivationDelayMs,
    createResult,
  });
}

function commitTraceDeployment({
  destroyPlaceholderTrace,
  syncInventoryChanges,
  cloneValue,
  persistTraceState,
  compensateFailedAbyssalDeployment,
  publishTraceDeployment,
}, attempt) {
  const {
    validation,
    session,
    deps,
    context,
    filamentItem,
    filamentType,
    shipProfile,
    now,
  } = attempt;
  let { traceState } = attempt;
  // All fallible, non-public trace preparation is complete. Commit the
  // inventory mutation before publishing the trace so a consume failure can
  // never expose a transient entrance to other pilots. Subsequent failures
  // use an explicit compensation receipt below.
  const consumeResult = deps.consumeInventoryItemQuantity(
    filamentItem.itemID,
    shipProfile.requiredFilaments,
    {
      removeContents: true,
    },
  );
  if (!consumeResult.success) {
    destroyPlaceholderTrace(
      context.systemID,
      traceState.traceItemID,
      deps,
      "filament-consume-failed",
    );
    return {
      success: false,
      errorMsg: consumeResult.errorMsg || "FILAMENT_CONSUME_FAILED",
    };
  }
  syncInventoryChanges(session, consumeResult.data && consumeResult.data.changes, deps);

  const committedAtMs = toInt(deps.now(), now);
  const committedTraceState = {
    ...traceState,
    filamentConsumptionState: {
      ...cloneValue(traceState.filamentConsumptionState),
      schemaVersion: 1,
      status: "committed",
      deploymentToken: traceState.deploymentToken,
      filamentItemID: toInt(filamentItem.itemID, 0),
      filamentTypeID: toInt(filamentType && filamentType.typeID, 0),
      quantity: Math.max(1, toInt(shipProfile.requiredFilaments, 1)),
      committedAtMs,
    },
  };
  const consumeCommitPersistResult = persistTraceState(
    committedTraceState,
    deps,
    { register: false },
  );
  if (!consumeCommitPersistResult.success) {
    const compensationResult = compensateFailedAbyssalDeployment(
      validation,
      consumeResult,
      traceState,
      session,
      deps,
      "filament-consume-commit-persist-failed",
    );
    return {
      success: false,
      errorMsg: consumeCommitPersistResult.errorMsg ||
        "FILAMENT_CONSUMPTION_COMMIT_PERSIST_FAILED",
      compensationResult,
    };
  }
  traceState = committedTraceState;
  let latestPersistResult = consumeCommitPersistResult;
  return publishTraceDeployment({
    ...attempt,
    traceState,
    consumeResult,
    latestPersistResult,
  });
}

function publishTraceDeployment({
  publishSourceTraceInitial,
  compensateFailedAbyssalDeployment,
  persistAbyssalTracePublicationState,
  registerTrace,
  getVectorDistance,
  log,
  formatVectorForLog,
  syncInventoryChanges,
}, attempt) {
  const {
    validation,
    session,
    deps,
    context,
    shipPosition,
    spawnState,
    sourceSceneKey,
    automaticActivationDelayMs,
    consumeResult,
    createResult,
  } = attempt;
  let { traceState, latestPersistResult } = attempt;
  const publicationResult = publishSourceTraceInitial(traceState, deps, {
    reason: "deployment",
    actorSession: session,
  });
  const publicationPending = Boolean(
    automaticActivationDelayMs != null &&
    publicationResult &&
    publicationResult.errorMsg === "ABYSSAL_TRACE_ACTOR_NOT_READY" &&
    publicationResult.data &&
    publicationResult.data.pending === true
  );
  if ((!publicationResult || !publicationResult.success) && !publicationPending) {
    const compensationResult = compensateFailedAbyssalDeployment(
      validation,
      consumeResult,
      traceState,
      session,
      deps,
      "initial-publication-failed",
    );
    return {
      success: false,
      errorMsg: publicationResult && publicationResult.errorMsg ||
        "TRACE_INITIAL_PUBLICATION_FAILED",
      compensationResult,
    };
  }
  if (publicationResult && publicationResult.success) {
    const publicationPersistResult = persistAbyssalTracePublicationState(
      traceState,
      publicationResult,
      deps,
    );
    if (!publicationPersistResult.success) {
      const compensationResult = compensateFailedAbyssalDeployment(
        validation,
        consumeResult,
        traceState,
        session,
        deps,
        "publication-receipt-persist-failed",
      );
      return {
        success: false,
        errorMsg: publicationPersistResult.errorMsg ||
          "TRACE_PUBLICATION_RECEIPT_PERSIST_FAILED",
        compensationResult,
      };
    }
    traceState = publicationPersistResult.state;
    latestPersistResult = publicationPersistResult;
  }

  registerTrace(traceState);
  const distanceFromShip = getVectorDistance(shipPosition, spawnState.position);
  log.info(
    `[AbyssalTraceLifecycle] run=0 trace=${traceState.traceItemID} ` +
      `character=${context.characterID} ship=${context.shipID} system=${context.systemID} ` +
      `sceneKey=${sourceSceneKey} phase=created ` +
      `profileID=${normalizeText(traceState.traceProfileID, "legacy-generic")} ` +
      `typeID=${traceState.typeID} groupID=${traceState.groupID} ownerID=${traceState.ownerID} ` +
      `activationState=${traceState.activationState} ` +
      `shipPosition=${formatVectorForLog(shipPosition)} tracePosition=${formatVectorForLog(spawnState.position)} ` +
      `distanceFromShip=${distanceFromShip.toFixed(3)} status=complete reason=deployed`,
  );
  syncInventoryChanges(session, [{
    item: latestPersistResult.item,
    previousData:
      createResult.changes && createResult.changes[0] && createResult.changes[0].previousData || {},
  }], deps);

  return {
    success: true,
    data: {
      traceItemID: traceState.traceItemID,
      state: traceState,
      consumeResult,
    },
  };
}

// Capture supplied capabilities once, as the original closure did. Internal
// callbacks are bound once per instance; no runtime state lives in this wiring.
function createAbyssalTraceDeployment({
  getDependencies,
  resolveConfiguredUnusedTraceDurationMs,
  getObjectPosition,
  normalizeDirection,
  getObjectRadius,
  resolveTypeRecord,
  listAuthoritativeAbyssalFleetCharacterIDs,
  cloneValue,
  buildTraceCustomInfo,
  buildAbyssalTraceDeploymentToken,
  persistTraceState,
  destroyPlaceholderTrace,
  compensateFailedAbyssalDeployment,
  publishSourceTraceInitial,
  persistAbyssalTracePublicationState,
  registerTrace,
  syncInventoryChanges,
  getVectorDistance,
  formatVectorForLog,
  log,
  GROUP_FILAMENT_TRACE,
  ABYSSAL_PARTICIPANT_ROSTER_SCHEMA_VERSION,
  ABYSSAL_PARTICIPANT_STATUS,
}) {

  const ports = {
    getDependencies,
    resolveConfiguredUnusedTraceDurationMs,
    getObjectPosition,
    normalizeDirection,
    getObjectRadius,
    resolveTypeRecord,
    listAuthoritativeAbyssalFleetCharacterIDs,
    cloneValue,
    buildTraceCustomInfo,
    buildAbyssalTraceDeploymentToken,
    persistTraceState,
    destroyPlaceholderTrace,
    compensateFailedAbyssalDeployment,
    publishSourceTraceInitial,
    persistAbyssalTracePublicationState,
    registerTrace,
    syncInventoryChanges,
    getVectorDistance,
    formatVectorForLog,
    log,
    GROUP_FILAMENT_TRACE,
    ABYSSAL_PARTICIPANT_ROSTER_SCHEMA_VERSION,
    ABYSSAL_PARTICIPANT_STATUS,
  };
  ports.deployPlaceholderTrace = deployPlaceholderTrace.bind(null, ports);
  ports.buildInitialTraceState = buildInitialTraceState.bind(null, ports);
  ports.prepareTraceDeployment = prepareTraceDeployment.bind(null, ports);
  ports.commitTraceDeployment = commitTraceDeployment.bind(null, ports);
  ports.publishTraceDeployment = publishTraceDeployment.bind(null, ports);
  Object.freeze(ports);
  return Object.freeze({ deployPlaceholderTrace: ports.deployPlaceholderTrace });
}

module.exports = { createAbyssalTraceDeployment };
