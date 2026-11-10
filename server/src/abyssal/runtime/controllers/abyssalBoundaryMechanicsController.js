"use strict";

const {
  UNSTABLE_ABYSSAL_DEPTHS_BOUNDARY_PROFILE,
  calculateBoundaryBaseAppliedDamage,
  resolveBoundaryVarianceMultiplier,
} = require("../../domain/abyssalBoundaryProfile");
const { resolvePerimeterRadius } = require("../../domain/abyssalBoundaryGeometry");
const {
  resolveExactAbyssalRunRoomScopeOrNull,
} = require("../../domain/abyssalRunScope");
const {
  normalizeText,
} = require("../../domain/abyssalValueUtils");

const TYPE_ABYSSAL_PERIMETER_LIGHTS = 54_196;
const TYPE_UNSTABLE_ABYSSAL_DEPTHS = 47_465;

const ABYSSAL_BOUNDARY_STATE = Object.freeze({
  SAFE: "SAFE",
  EXPOSED: "EXPOSED",
  TERMINAL: "TERMINAL",
});

const controllersByKey = new Map();
let nextGeneration = 1;

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function toFinite(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function round6(value) {
  return Number(toFinite(value, 0).toFixed(6));
}

// This controller only ever acts on a fully-identified entity, so it takes the
// strict form: null unless run and room agree on positive values.
const resolveExactPositiveAbyssalRunRoomScope = resolveExactAbyssalRunRoomScopeOrNull;

function getPosition(value) {
  const position = value && (value.position || value.spaceState && value.spaceState.position || value);
  if (
    !position ||
    !Number.isFinite(Number(position.x)) ||
    !Number.isFinite(Number(position.y)) ||
    !Number.isFinite(Number(position.z))
  ) {
    return null;
  }
  return {
    x: Number(position.x),
    y: Number(position.y),
    z: Number(position.z),
  };
}

function distanceMeters(left, right) {
  const leftPosition = getPosition(left);
  const rightPosition = getPosition(right);
  if (!leftPosition || !rightPosition) {
    return Number.POSITIVE_INFINITY;
  }
  const dx = leftPosition.x - rightPosition.x;
  const dy = leftPosition.y - rightPosition.y;
  const dz = leftPosition.z - rightPosition.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function buildControllerKey(runID, roomIndex, shipID) {
  return `abyssal-run:${toInt(runID, 0)}:room:${toInt(roomIndex, 0)}:ship:${toInt(shipID, 0)}`;
}

function resolveBoundarySourceEntity(context) {
  if (context && context.sourceEntity) {
    return context.sourceEntity;
  }
  return (Array.isArray(context && context.environmentEntities)
    ? context.environmentEntities
    : []
  ).find((entity) => (
    toInt(entity && entity.typeID, 0) === TYPE_UNSTABLE_ABYSSAL_DEPTHS ||
    normalizeText(entity && entity.evejsAbyssalEnvironmentalProfileID, "") ===
      "abyssal:environment:unstable-depths"
  )) || null;
}

function entityIsRegisteredInExactScene(entity, scene, sceneKey) {
  const entityID = toInt(entity && entity.itemID, 0);
  return Boolean(
    entity &&
    entityID > 0 &&
    scene &&
    scene.dynamicEntities instanceof Map &&
    scene.dynamicEntities.get(entityID) === entity &&
    normalizeText(entity.sceneKey, "") === sceneKey
  );
}

function validateControllerContext(controller, context) {
  const exactSceneKey = `abyssal-run:${controller.runID}`;
  if (!context || typeof context !== "object") {
    return { valid: false, reason: "CONTEXT_UNAVAILABLE" };
  }
  if (context.runTerminal === true) {
    return { valid: false, halt: true, reason: "RUN_TERMINAL" };
  }
  if (context.transitionPending === true) {
    return { valid: false, reason: "ROOM_TRANSITION_PENDING" };
  }
  if (
    toInt(context.runID, 0) !== controller.runID ||
    toInt(context.roomIndex, 0) !== controller.roomIndex ||
    toInt(context.shipID, 0) !== controller.shipID
  ) {
    return { valid: false, reason: "RUN_ROOM_PARTICIPANT_MISMATCH" };
  }
  const sceneKey = normalizeText(context.sceneKey, "");
  if (sceneKey !== controller.sceneKey || sceneKey !== exactSceneKey) {
    return { valid: false, reason: "SCENE_MISMATCH" };
  }
  if (normalizeText(context.deliveryState, "") !== "visible" || context.roomActive !== true) {
    return { valid: false, reason: "ROOM_NOT_VISIBLE_ACTIVE" };
  }
  const shipEntity = context.shipEntity;
  if (
    !entityIsRegisteredInExactScene(shipEntity, context.scene, exactSceneKey) ||
    toInt(shipEntity.itemID, 0) !== controller.shipID ||
    normalizeText(shipEntity.kind, "") !== "ship"
  ) {
    return { valid: false, reason: "PARTICIPANT_SHIP_NOT_IN_EXACT_SCENE" };
  }
  if (
    shipEntity.destroying === true ||
    shipEntity.destroyed === true ||
    ["destroying", "destroyed"].includes(normalizeText(shipEntity.destructionState, ""))
  ) {
    return { valid: false, terminal: true, reason: "SHIP_DESTRUCTION_STARTED" };
  }
  // A capsule is a valid participant ship: a pilot who lost the hull flies on
  // in the pod, and the boundary keeps applying to it as on retail.
  const participantCharacterID = toInt(context.participantCharacterID, 0);
  const shipCharacterID = toInt(
    shipEntity.pilotCharacterID || shipEntity.characterID ||
      shipEntity.session && shipEntity.session.characterID,
    0,
  );
  if (
    participantCharacterID > 0 &&
    shipCharacterID > 0 &&
    participantCharacterID !== shipCharacterID
  ) {
    return { valid: false, reason: "PARTICIPANT_IDENTITY_MISMATCH" };
  }
  const roomOrigin = getPosition(context.roomOrigin);
  if (!roomOrigin) {
    return { valid: false, reason: "ROOM_ORIGIN_UNAVAILABLE" };
  }
  const radius = resolvePerimeterRadius(context, controller.profile);
  if (!(radius.perimeterRadiusMeters > 0)) {
    return { valid: false, reason: "PERIMETER_RADIUS_UNAVAILABLE" };
  }
  const sourceEntity = resolveBoundarySourceEntity(context);
  if (!entityIsRegisteredInExactScene(sourceEntity, context.scene, exactSceneKey)) {
    return { valid: false, reason: "BOUNDARY_SOURCE_UNAVAILABLE" };
  }
  const sourceScope = resolveExactPositiveAbyssalRunRoomScope(sourceEntity);
  if (
    !sourceScope ||
    sourceScope.runID !== controller.runID ||
    sourceScope.roomIndex !== controller.roomIndex
  ) {
    return { valid: false, reason: "BOUNDARY_SOURCE_SCOPE_MISMATCH" };
  }
  return {
    valid: true,
    scene: context.scene,
    shipEntity,
    sourceEntity,
    roomOrigin,
    ...radius,
  };
}

function calculateOutsideIntegration(
  previousSignedDepthMeters,
  currentSignedDepthMeters,
  elapsedMs,
  profile = UNSTABLE_ABYSSAL_DEPTHS_BOUNDARY_PROFILE,
) {
  const previousDepth = toFinite(previousSignedDepthMeters, 0);
  const currentDepth = toFinite(currentSignedDepthMeters, 0);
  const durationMs = Math.max(0, toFinite(elapsedMs, 0));
  let outsideExposureFraction = 0;
  let averageOutsideDepthMeters = 0;

  if (previousDepth > 0 && currentDepth > 0) {
    outsideExposureFraction = 1;
    averageOutsideDepthMeters = (previousDepth + currentDepth) / 2;
  } else if (previousDepth <= 0 && currentDepth > 0) {
    outsideExposureFraction = currentDepth / (currentDepth - previousDepth);
    averageOutsideDepthMeters = currentDepth / 2;
  } else if (previousDepth > 0 && currentDepth <= 0) {
    outsideExposureFraction = previousDepth / (previousDepth - currentDepth);
    averageOutsideDepthMeters = previousDepth / 2;
  }

  outsideExposureFraction = Math.min(1, Math.max(0, outsideExposureFraction));
  const representativeBaseDamagePerSecond = outsideExposureFraction > 0
    ? calculateBoundaryBaseAppliedDamage(averageOutsideDepthMeters, profile)
    : 0;
  const integratedBaseAppliedDamage =
    representativeBaseDamagePerSecond *
    (durationMs / 1_000) *
    outsideExposureFraction;

  return {
    outsideExposureFraction: round6(outsideExposureFraction),
    averageOutsideDepthMeters: round6(averageOutsideDepthMeters),
    representativeBaseDamagePerSecond: round6(representativeBaseDamagePerSecond),
    integratedBaseAppliedDamage: round6(integratedBaseAppliedDamage),
  };
}

function normalizeCallbacks(callbacks = {}) {
  return {
    now: typeof callbacks.now === "function" ? callbacks.now : () => Date.now(),
    setInterval: callbacks.setInterval,
    clearInterval: callbacks.clearInterval,
    resolveContext: callbacks.resolveContext,
    resolveCompanionEntities: callbacks.resolveCompanionEntities,
    applyDamage: callbacks.applyDamage,
    nextRandom: callbacks.nextRandom,
    nextCompanionRandom: callbacks.nextCompanionRandom,
    log: callbacks.log,
    warn: callbacks.warn,
  };
}

function entityDestructionStarted(entity) {
  return Boolean(
    entity && (
      entity.destroying === true ||
      entity.destroyed === true ||
      ["destroying", "destroyed"].includes(
        normalizeText(entity.destructionState, ""),
      )
    ),
  );
}

function resolveExactCompanionEntities(controller, context, validation) {
  let candidates;
  try {
    candidates = typeof controller.callbacks.resolveCompanionEntities === "function"
      ? controller.callbacks.resolveCompanionEntities(context)
      : context && context.companionEntities;
  } catch (error) {
    return {
      success: false,
      errorMsg: normalizeText(
        error && error.message,
        "ABYSSAL_BOUNDARY_COMPANION_RESOLUTION_FAILED",
      ),
    };
  }

  if (!Array.isArray(candidates)) {
    candidates = [];
  }
  const entitiesByID = new Map();
  for (const entity of candidates) {
    const entityID = toInt(entity && entity.itemID, 0);
    const exactScope = resolveExactPositiveAbyssalRunRoomScope(entity);
    if (
      entityID <= 0 ||
      entityID === controller.shipID ||
      entity === validation.sourceEntity ||
      !exactScope ||
      exactScope.runID !== controller.runID ||
      exactScope.roomIndex !== controller.roomIndex ||
      !getPosition(entity) ||
      entityDestructionStarted(entity) ||
      !entityIsRegisteredInExactScene(entity, validation.scene, controller.sceneKey)
    ) {
      continue;
    }
    entitiesByID.set(entityID, entity);
  }
  return {
    success: true,
    entities: [...entitiesByID.values()].sort(
      (left, right) => toInt(left.itemID, 0) - toInt(right.itemID, 0),
    ),
  };
}

function createCompanionState(entity, validation, nowMs) {
  const distanceFromRoomOriginMeters = distanceMeters(entity, validation.roomOrigin);
  const signedDepthMeters =
    distanceFromRoomOriginMeters - validation.perimeterRadiusMeters;
  return {
    entityID: toInt(entity.itemID, 0),
    entityKind: normalizeText(entity.kind, "companion"),
    state: signedDepthMeters > 0
      ? ABYSSAL_BOUNDARY_STATE.EXPOSED
      : ABYSSAL_BOUNDARY_STATE.SAFE,
    exposureStartedAtMs: signedDepthMeters > 0 ? nowMs : 0,
    previousSampleTimeMs: nowMs,
    previousDistanceFromOriginMeters: distanceFromRoomOriginMeters,
    previousSignedDepthMeters: signedDepthMeters,
    distanceFromRoomOriginMeters,
    depthOutsideMeters: Math.max(0, signedDepthMeters),
    lastAppliedDamage: 0,
    baseCurveDamage: 0,
    varianceMultiplier: 1,
    outsideExposureFraction: 0,
    totalAppliedDamage: 0,
    lastTickAtMs: 0,
    tickCount: 0,
  };
}

function markCompanionExposureState(state, signedDepthMeters, nowMs) {
  if (signedDepthMeters > 0) {
    if (state.state !== ABYSSAL_BOUNDARY_STATE.EXPOSED) {
      state.state = ABYSSAL_BOUNDARY_STATE.EXPOSED;
      state.exposureStartedAtMs = nowMs;
    }
    return;
  }
  state.state = ABYSSAL_BOUNDARY_STATE.SAFE;
  state.exposureStartedAtMs = 0;
}

function synchronizeCompanionStates(controller, context, validation, nowMs) {
  const resolved = resolveExactCompanionEntities(controller, context, validation);
  if (!resolved.success) {
    controller.companionStatesByID.clear();
    return resolved;
  }
  const currentEntityIDs = new Set(
    resolved.entities.map((entity) => toInt(entity.itemID, 0)),
  );
  for (const entityID of controller.companionStatesByID.keys()) {
    if (!currentEntityIDs.has(entityID)) {
      controller.companionStatesByID.delete(entityID);
    }
  }
  const initializedEntityIDs = new Set();
  for (const entity of resolved.entities) {
    const entityID = toInt(entity.itemID, 0);
    if (!controller.companionStatesByID.has(entityID)) {
      controller.companionStatesByID.set(
        entityID,
        createCompanionState(entity, validation, nowMs),
      );
      initializedEntityIDs.add(entityID);
    }
  }
  return {
    success: true,
    entities: resolved.entities,
    initializedEntityIDs,
  };
}

function snapshotCompanionState(state) {
  return {
    entityID: state.entityID,
    entityKind: state.entityKind,
    controllerState: state.state,
    exposureStartedAtMs: state.exposureStartedAtMs,
    previousSampleTimeMs: state.previousSampleTimeMs,
    distanceFromRoomOriginMeters: round6(state.distanceFromRoomOriginMeters),
    depthOutsideMeters: round6(state.depthOutsideMeters),
    lastAppliedDamage: state.lastAppliedDamage,
    baseCurveDamage: state.baseCurveDamage,
    varianceMultiplier: state.varianceMultiplier,
    outsideExposureFraction: state.outsideExposureFraction,
    totalAppliedDamage: state.totalAppliedDamage,
    lastTickAtMs: state.lastTickAtMs,
    tickCount: state.tickCount,
  };
}

function emitLog(controller, event, details = {}) {
  if (typeof controller.callbacks.log === "function") {
    controller.callbacks.log(event, snapshotController(controller), details);
  }
}

function emitWarning(controller, errorMsg) {
  if (controller.warningEmitted || typeof controller.callbacks.warn !== "function") {
    return;
  }
  controller.warningEmitted = true;
  controller.callbacks.warn(errorMsg, snapshotController(controller));
}

function clearControllerTimer(controller) {
  if (
    controller &&
    controller.timerHandle != null &&
    typeof controller.callbacks.clearInterval === "function"
  ) {
    controller.callbacks.clearInterval(controller.timerHandle);
  }
  if (controller) {
    controller.timerHandle = null;
  }
}

function sampleControllerPosition(controller, resolved, nowMs) {
  const distanceFromRoomOriginMeters = distanceMeters(
    resolved.shipEntity,
    resolved.roomOrigin,
  );
  const signedDepthMeters =
    distanceFromRoomOriginMeters - resolved.perimeterRadiusMeters;
  controller.previousSampleTimeMs = nowMs;
  controller.previousDistanceFromOriginMeters = distanceFromRoomOriginMeters;
  controller.previousSignedDepthMeters = signedDepthMeters;
  controller.distanceFromRoomOriginMeters = distanceFromRoomOriginMeters;
  controller.depthOutsideMeters = Math.max(0, signedDepthMeters);
  controller.roomOrigin = { ...resolved.roomOrigin };
  controller.perimeterRadiusMeters = resolved.perimeterRadiusMeters;
  controller.perimeterRadiusSource = resolved.perimeterRadiusSource;
  controller.sourceEntityID = toInt(resolved.sourceEntity.itemID, 0);
  return signedDepthMeters;
}

function markExposureState(controller, signedDepthMeters, nowMs) {
  const exposed = signedDepthMeters > 0;
  if (exposed && controller.state !== ABYSSAL_BOUNDARY_STATE.EXPOSED) {
    controller.state = ABYSSAL_BOUNDARY_STATE.EXPOSED;
    controller.exposureStartedAtMs = nowMs;
    emitLog(controller, "exposure-enter", {
      depthOutsideMeters: signedDepthMeters,
    });
  } else if (!exposed && controller.state === ABYSSAL_BOUNDARY_STATE.EXPOSED) {
    controller.state = ABYSSAL_BOUNDARY_STATE.SAFE;
    controller.exposureStartedAtMs = 0;
    emitLog(controller, "exposure-exit", {
      depthOutsideMeters: 0,
    });
  }
}

function processCompanionSamples(controller, context, validation, nowMs) {
  const synchronized = synchronizeCompanionStates(
    controller,
    context,
    validation,
    nowMs,
  );
  if (!synchronized.success) {
    return {
      success: false,
      errorMsg: synchronized.errorMsg,
      results: [],
    };
  }

  const results = [];
  for (const entity of synchronized.entities) {
    processCompanionSample(controller, validation, nowMs, synchronized, results, entity);
  }
  return { success: true, results };
}

function processCompanionSample(controller, validation, nowMs, synchronized, results, entity) {

  const entityID = toInt(entity.itemID, 0);
  const state = controller.companionStatesByID.get(entityID);
  if (!state) {
    return;
  }
  if (synchronized.initializedEntityIDs.has(entityID)) {
    results.push({
      success: true,
      applied: false,
      initialized: true,
      destroyed: false,
      entityID,
      data: snapshotCompanionState(state),
    });
    return;
  }

  const elapsedMs = Math.max(0, nowMs - state.previousSampleTimeMs);
  if (elapsedMs <= 0) {
    results.push({
      success: true,
      applied: false,
      duplicate: true,
      destroyed: false,
      entityID,
      data: snapshotCompanionState(state),
    });
    return;
  }
  const distanceFromRoomOriginMeters = distanceMeters(entity, validation.roomOrigin);
  const signedDepthMeters =
    distanceFromRoomOriginMeters - validation.perimeterRadiusMeters;
  const integration = calculateOutsideIntegration(
    state.previousSignedDepthMeters,
    signedDepthMeters,
    elapsedMs,
    controller.profile,
  );
  const varianceMultiplier = integration.integratedBaseAppliedDamage > 0
    ? resolveBoundaryVarianceMultiplier(
      controller.profile,
      typeof controller.callbacks.nextCompanionRandom === "function"
        ? () => controller.callbacks.nextCompanionRandom(entityID)
        : () => 0.5,
    )
    : 1;
  const curveAppliedDamage = round6(
    Math.max(0, integration.integratedBaseAppliedDamage * varianceMultiplier),
  );
  const exposureDurationMs = signedDepthMeters > 0 && state.exposureStartedAtMs > 0
    ? Math.max(0, nowMs - state.exposureStartedAtMs)
    : 0;
  // Room NPC hulls only take the ramping damage. Killing one outright after
  // the terminal exposure time would let a pilot clear a room by luring its
  // NPCs outside, and NPCs on the live game are seen outside for long periods.
  const terminalExposure = Boolean(
    entity.nativeNpc !== true &&
    signedDepthMeters > 0 &&
    toInt(controller.profile.terminalExposureMs, 0) > 0 &&
    exposureDurationMs >= toInt(controller.profile.terminalExposureMs, 0)
  );
  const appliedDamage = terminalExposure
    ? Math.max(
        curveAppliedDamage,
        toFinite(controller.profile.terminalAppliedDamage, Number.MAX_SAFE_INTEGER),
      )
    : curveAppliedDamage;

  state.previousSampleTimeMs = nowMs;
  state.previousDistanceFromOriginMeters = distanceFromRoomOriginMeters;
  state.previousSignedDepthMeters = signedDepthMeters;
  state.distanceFromRoomOriginMeters = distanceFromRoomOriginMeters;
  state.depthOutsideMeters = Math.max(0, signedDepthMeters);
  state.baseCurveDamage = integration.integratedBaseAppliedDamage;
  state.varianceMultiplier = round6(varianceMultiplier);
  state.outsideExposureFraction = integration.outsideExposureFraction;
  state.lastAppliedDamage = 0;
  state.lastTickAtMs = nowMs;
  state.tickCount += 1;

  let damageResult = null;
  if (appliedDamage > 0 && typeof controller.callbacks.applyDamage === "function") {
    damageResult = controller.callbacks.applyDamage({
      runID: controller.runID,
      sceneKey: controller.sceneKey,
      roomIndex: controller.roomIndex,
      shipID: controller.shipID,
      amount: appliedDamage,
      sourceName: controller.profile.sourceName,
      sourceEntity: validation.sourceEntity,
      targetEntity: entity,
      targetEntityID: entityID,
      companion: true,
      companionEntityID: entityID,
      scene: validation.scene,
      damageQuality: "Hits",
      weapon: null,
      damageType: null,
      nowMs,
      baseCurveDamage: integration.integratedBaseAppliedDamage,
      varianceMultiplier: state.varianceMultiplier,
      outsideExposureFraction: integration.outsideExposureFraction,
      elapsedMs,
      coalescedIntervals: elapsedMs / controller.profile.tickIntervalMs,
      exposureDurationMs,
      terminalExposure,
    });
    if (damageResult && damageResult.success !== false) {
      state.lastAppliedDamage = appliedDamage;
      state.totalAppliedDamage = round6(state.totalAppliedDamage + appliedDamage);
    }
  }

  const destructionCompleted = Boolean(
    damageResult && (
      damageResult.destroyed === true ||
      damageResult.destroyResult && damageResult.destroyResult.success === true
    ),
  );
  if (!destructionCompleted) {
    markCompanionExposureState(state, signedDepthMeters, nowMs);
  }
  const result = {
    success: !damageResult || damageResult.success !== false,
    applied: state.lastAppliedDamage > 0,
    destroyed: destructionCompleted,
    entityID,
    damageResult,
    integration,
    data: snapshotCompanionState(state),
  };
  results.push(result);
  if (destructionCompleted) {
    controller.companionStatesByID.delete(entityID);
  }
}

function processBoundarySample(controller, nowMs, options = {}) {

  if (!controller || controller.cleaned || controller.state === ABYSSAL_BOUNDARY_STATE.TERMINAL) {
    return { success: false, errorMsg: "ABYSSAL_BOUNDARY_CONTROLLER_UNAVAILABLE" };
  }
  const effectiveNowMs = toInt(nowMs, toInt(controller.callbacks.now(), Date.now()));
  if (
    options.forcePartial !== true &&
    effectiveNowMs < controller.nextTickTimeMs
  ) {
    return {
      success: true,
      applied: false,
      early: true,
      data: snapshotController(controller),
    };
  }

  const context = typeof controller.callbacks.resolveContext === "function"
    ? controller.callbacks.resolveContext()
    : null;
  const validation = validateControllerContext(controller, context);
  if (!validation.valid) {
    if (validation.halt === true) {
      clearControllerTimer(controller);
    }
    if (validation.terminal) {
      controller.state = ABYSSAL_BOUNDARY_STATE.TERMINAL;
      clearControllerTimer(controller);
    }
    return {
      success: false,
      terminal: validation.terminal === true,
      errorMsg: validation.reason,
      data: snapshotController(controller),
    };
  }

  if (controller.previousSampleTimeMs <= 0) {
    const signedDepth = sampleControllerPosition(controller, validation, effectiveNowMs);
    markExposureState(controller, signedDepth, effectiveNowMs);
    synchronizeCompanionStates(controller, context, validation, effectiveNowMs);
    controller.nextTickTimeMs = effectiveNowMs + controller.profile.tickIntervalMs;
    return {
      success: true,
      applied: false,
      initialized: true,
      data: snapshotController(controller),
    };
  }
    return integrateBoundaryExposure({
      controller,
      nowMs,
      options,
      effectiveNowMs,
      context,
      validation,
    });
  }

  function integrateBoundaryExposure(attempt) {
    const { effectiveNowMs, controller, validation } = attempt;
const elapsedMs = Math.max(0, effectiveNowMs - controller.previousSampleTimeMs);
  if (elapsedMs <= 0) {
    return {
      success: true,
      applied: false,
      duplicate: true,
      data: snapshotController(controller),
    };
  }
  const distanceFromRoomOriginMeters = distanceMeters(
    validation.shipEntity,
    validation.roomOrigin,
  );
  const signedDepthMeters =
    distanceFromRoomOriginMeters - validation.perimeterRadiusMeters;
  const integration = calculateOutsideIntegration(
    controller.previousSignedDepthMeters,
    signedDepthMeters,
    elapsedMs,
    controller.profile,
  );
  const varianceMultiplier = integration.integratedBaseAppliedDamage > 0
    ? resolveBoundaryVarianceMultiplier(controller.profile, controller.callbacks.nextRandom)
    : 1;
  const curveAppliedDamage = round6(
    Math.max(0, integration.integratedBaseAppliedDamage * varianceMultiplier),
  );
  const exposureDurationMs = signedDepthMeters > 0 && controller.exposureStartedAtMs > 0
    ? Math.max(0, effectiveNowMs - controller.exposureStartedAtMs)
    : 0;
  const terminalExposure = Boolean(
    signedDepthMeters > 0 &&
    toInt(controller.profile.terminalExposureMs, 0) > 0 &&
    exposureDurationMs >= toInt(controller.profile.terminalExposureMs, 0)
  );
  const appliedDamage = terminalExposure
    ? Math.max(
        curveAppliedDamage,
        toFinite(controller.profile.terminalAppliedDamage, Number.MAX_SAFE_INTEGER),
      )
    : curveAppliedDamage;

  controller.previousSampleTimeMs = effectiveNowMs;
  controller.previousDistanceFromOriginMeters = distanceFromRoomOriginMeters;
  controller.previousSignedDepthMeters = signedDepthMeters;
  controller.distanceFromRoomOriginMeters = distanceFromRoomOriginMeters;
  controller.depthOutsideMeters = Math.max(0, signedDepthMeters);
  controller.roomOrigin = { ...validation.roomOrigin };
  controller.perimeterRadiusMeters = validation.perimeterRadiusMeters;
  controller.perimeterRadiusSource = validation.perimeterRadiusSource;
  controller.sourceEntityID = toInt(validation.sourceEntity.itemID, 0);
  controller.baseCurveDamage = integration.integratedBaseAppliedDamage;
  controller.varianceMultiplier = round6(varianceMultiplier);
  controller.outsideExposureFraction = integration.outsideExposureFraction;
  controller.lastAppliedDamage = 0;
  controller.lastTickAtMs = effectiveNowMs;
  controller.tickCount += 1;
  const elapsedIntervals = Math.max(
    1,
    Math.floor(
      Math.max(0, effectiveNowMs - controller.nextTickTimeMs) /
        controller.profile.tickIntervalMs,
    ) + 1,
  );
  controller.nextTickTimeMs += elapsedIntervals * controller.profile.tickIntervalMs;
    return applyBoundaryExposureDamage({
      ...attempt,
      elapsedMs,
      distanceFromRoomOriginMeters,
      signedDepthMeters,
      integration,
      varianceMultiplier,
      curveAppliedDamage,
      exposureDurationMs,
      terminalExposure,
      appliedDamage,
      elapsedIntervals,
    });
  }

  function applyBoundaryExposureDamage(attempt) {
    const {
      appliedDamage,
      controller,
      validation,
      effectiveNowMs,
      integration,
      elapsedMs,
      exposureDurationMs,
      terminalExposure,
      signedDepthMeters,
      context,
    } = attempt;
let damageResult = null;
  if (appliedDamage > 0 && typeof controller.callbacks.applyDamage === "function") {
    damageResult = controller.callbacks.applyDamage({
      runID: controller.runID,
      sceneKey: controller.sceneKey,
      roomIndex: controller.roomIndex,
      shipID: controller.shipID,
      amount: appliedDamage,
      sourceName: controller.profile.sourceName,
      sourceEntity: validation.sourceEntity,
      targetEntity: validation.shipEntity,
      scene: validation.scene,
      damageQuality: "Hits",
      weapon: null,
      damageType: null,
      nowMs: effectiveNowMs,
      baseCurveDamage: integration.integratedBaseAppliedDamage,
      varianceMultiplier: controller.varianceMultiplier,
      outsideExposureFraction: integration.outsideExposureFraction,
      elapsedMs,
      coalescedIntervals: elapsedMs / controller.profile.tickIntervalMs,
      exposureDurationMs,
      terminalExposure,
    });
    if (!damageResult || damageResult.success === false) {
      emitWarning(
        controller,
        normalizeText(
          damageResult && damageResult.errorMsg,
          "ABYSSAL_BOUNDARY_DAMAGE_APPLICATION_FAILED",
        ),
      );
    } else {
      controller.lastAppliedDamage = appliedDamage;
      controller.totalAppliedDamage = round6(controller.totalAppliedDamage + appliedDamage);
      emitLog(controller, "damage-tick", {
        appliedDamage,
        elapsedMs,
        coalescedIntervals: elapsedMs / controller.profile.tickIntervalMs,
        exposureDurationMs,
        terminalExposure,
      });
    }
  }

  const destructionCompleted = Boolean(
    damageResult && (
      damageResult.destroyed === true ||
      damageResult.destroyResult && damageResult.destroyResult.success === true
    ),
  );
  if (destructionCompleted) {
    controller.state = ABYSSAL_BOUNDARY_STATE.TERMINAL;
    controller.exposureStartedAtMs = 0;
    clearControllerTimer(controller);
    emitLog(controller, "destruction-requested", {
      appliedDamage: controller.lastAppliedDamage,
    });
  } else {
    markExposureState(controller, signedDepthMeters, effectiveNowMs);
  }

  const companionSample = destructionCompleted
    ? { success: true, results: [] }
    : processCompanionSamples(
      controller,
      context,
      validation,
      effectiveNowMs,
    );

  return {
    success: !damageResult || damageResult.success !== false,
    applied: controller.lastAppliedDamage > 0,
    destroyed: destructionCompleted,
    damageResult,
    integration,
    companionResults: companionSample.results,
    companionResolutionError: companionSample.success
      ? null
      : companionSample.errorMsg,
    data: snapshotController(controller),
  };
  }

function activateBoundaryController(controller, nowMs = null) {
  if (!controller || controller.cleaned || controller.state === ABYSSAL_BOUNDARY_STATE.TERMINAL) {
    return { success: false, errorMsg: "ABYSSAL_BOUNDARY_CONTROLLER_UNAVAILABLE" };
  }
  if (controller.timerHandle != null) {
    return { success: true, created: false, data: snapshotController(controller) };
  }
  if (
    typeof controller.callbacks.resolveContext !== "function" ||
    typeof controller.callbacks.applyDamage !== "function" ||
    typeof controller.callbacks.setInterval !== "function"
  ) {
    return { success: false, errorMsg: "ABYSSAL_BOUNDARY_CALLBACKS_UNAVAILABLE" };
  }
  const effectiveNowMs = toInt(nowMs, toInt(controller.callbacks.now(), Date.now()));
  const context = controller.callbacks.resolveContext();
  const validation = validateControllerContext(controller, context);
  if (!validation.valid) {
    return { success: false, errorMsg: validation.reason };
  }
  const signedDepth = sampleControllerPosition(controller, validation, effectiveNowMs);
  markExposureState(controller, signedDepth, effectiveNowMs);
  synchronizeCompanionStates(controller, context, validation, effectiveNowMs);
  controller.activatedAtMs = effectiveNowMs;
  controller.nextTickTimeMs = effectiveNowMs + controller.profile.tickIntervalMs;
  const generation = controller.generation;
  controller.timerHandle = controller.callbacks.setInterval(() => {
    tickBoundaryController(
      controller.runID,
      controller.roomIndex,
      controller.shipID,
      toInt(controller.callbacks.now(), Date.now()),
      generation,
    );
  }, controller.profile.tickIntervalMs);
  if (controller.timerHandle == null) {
    return { success: false, errorMsg: "ABYSSAL_BOUNDARY_INTERVAL_REGISTRATION_FAILED" };
  }
  return { success: true, created: true, data: snapshotController(controller) };
}

function registerBoundaryController(options = {}) {
  const runID = toInt(options.runID, 0);
  const roomIndex = toInt(options.roomIndex, 0);
  const shipID = toInt(options.shipID, 0);
  const sceneKey = normalizeText(options.sceneKey, "");
  if (
    runID <= 0 ||
    roomIndex <= 0 ||
    shipID <= 0 ||
    sceneKey !== `abyssal-run:${runID}`
  ) {
    return { success: false, errorMsg: "ABYSSAL_BOUNDARY_CONTROLLER_CONTEXT_INVALID" };
  }
  const callbacks = normalizeCallbacks(options.callbacks);
  const key = buildControllerKey(runID, roomIndex, shipID);
  const existing = controllersByKey.get(key);
  if (existing && !existing.cleaned) {
    existing.callbacks = callbacks;
    return { success: true, created: false, data: snapshotController(existing) };
  }
  for (const controller of [...controllersByKey.values()]) {
    if (controller.runID === runID) {
      cleanupController(controller, "controller-replaced");
    }
  }
  const profile = options.profile || UNSTABLE_ABYSSAL_DEPTHS_BOUNDARY_PROFILE;
  const registeredAtMs = toInt(options.registeredAtMs, toInt(callbacks.now(), Date.now()));
  const controller = {
    key,
    generation: nextGeneration++,
    runID,
    sceneKey,
    roomIndex,
    shipID,
    profile,
    callbacks,
    state: ABYSSAL_BOUNDARY_STATE.SAFE,
    registeredAtMs,
    activatedAtMs: 0,
    exposureStartedAtMs: 0,
    previousSampleTimeMs: 0,
    nextTickTimeMs: 0,
    previousDistanceFromOriginMeters: 0,
    previousSignedDepthMeters: 0,
    distanceFromRoomOriginMeters: 0,
    depthOutsideMeters: 0,
    roomOrigin: null,
    perimeterRadiusMeters: 0,
    perimeterRadiusSource: "unresolved",
    sourceEntityID: 0,
    lastAppliedDamage: 0,
    baseCurveDamage: 0,
    varianceMultiplier: 1,
    outsideExposureFraction: 0,
    totalAppliedDamage: 0,
    lastTickAtMs: 0,
    tickCount: 0,
    companionStatesByID: new Map(),
    warningEmitted: false,
    timerHandle: null,
    cleaned: false,
  };
  controllersByKey.set(key, controller);
  return { success: true, created: true, data: snapshotController(controller) };
}

function ensureActiveBoundaryController(options = {}) {
  const registerResult = registerBoundaryController(options);
  if (!registerResult.success) {
    return registerResult;
  }
  const controller = controllersByKey.get(
    buildControllerKey(options.runID, options.roomIndex, options.shipID),
  );
  const activateResult = activateBoundaryController(controller, options.nowMs);
  return {
    ...activateResult,
    registered: registerResult.created === true,
  };
}

function tickBoundaryController(runID, roomIndex, shipID, nowMs = null, generation = null) {
  const controller = controllersByKey.get(buildControllerKey(runID, roomIndex, shipID));
  if (!controller || (generation != null && controller.generation !== generation)) {
    return { success: false, errorMsg: "ABYSSAL_BOUNDARY_CONTROLLER_NOT_FOUND" };
  }
  return processBoundarySample(controller, nowMs, { forcePartial: false });
}

function cleanupController(controller, reason = "cleanup") {
  if (!controller || controller.cleaned) {
    return false;
  }
  clearControllerTimer(controller);
  controller.companionStatesByID.clear();
  controller.cleaned = true;
  controller.exposureStartedAtMs = 0;
  controller.generation = nextGeneration++;
  controllersByKey.delete(controller.key);
  emitLog(controller, "controller-cleared", { reason });
  return true;
}

function finalizeAndCleanupBoundaryControllersForRun(runID, nowMs = null, reason = "cleanup") {
  const results = [];
  for (const controller of [...controllersByKey.values()]) {
    if (controller.runID !== toInt(runID, 0)) {
      continue;
    }
    const sampleResult = controller.state === ABYSSAL_BOUNDARY_STATE.TERMINAL
      ? { success: true, terminal: true, applied: false, data: snapshotController(controller) }
      : processBoundarySample(controller, nowMs, { forcePartial: true });
    const terminal = Boolean(
      sampleResult && (
        sampleResult.terminal === true ||
        sampleResult.destroyed === true ||
        sampleResult.data && sampleResult.data.controllerState ===
          ABYSSAL_BOUNDARY_STATE.TERMINAL
      ),
    );
    cleanupController(controller, reason);
    results.push({
      ...sampleResult,
      terminal,
      cleaned: true,
    });
  }
  return results;
}

function cleanupBoundaryControllersForRun(runID, reason = "cleanup") {
  let removed = 0;
  for (const controller of [...controllersByKey.values()]) {
    if (controller.runID === toInt(runID, 0) && cleanupController(controller, reason)) {
      removed += 1;
    }
  }
  return removed;
}

function snapshotController(controller) {
  if (!controller) {
    return null;
  }
  const companions = [...controller.companionStatesByID.values()]
    .sort((left, right) => left.entityID - right.entityID)
    .map(snapshotCompanionState);
  return {
    key: controller.key,
    runID: controller.runID,
    sceneKey: controller.sceneKey,
    roomIndex: controller.roomIndex,
    shipID: controller.shipID,
    roomOrigin: controller.roomOrigin ? { ...controller.roomOrigin } : null,
    perimeterRadiusMeters: controller.perimeterRadiusMeters,
    perimeterRadiusSource: controller.perimeterRadiusSource,
    distanceFromRoomOriginMeters: round6(controller.distanceFromRoomOriginMeters),
    depthOutsideMeters: round6(controller.depthOutsideMeters),
    controllerState: controller.state,
    previousSampleTimeMs: controller.previousSampleTimeMs,
    nextTickTimeMs: controller.nextTickTimeMs,
    lastAppliedDamage: controller.lastAppliedDamage,
    baseCurveDamage: controller.baseCurveDamage,
    varianceMultiplier: controller.varianceMultiplier,
    outsideExposureFraction: controller.outsideExposureFraction,
    sourceEntityID: controller.sourceEntityID,
    sourceName: controller.profile.sourceName,
    profileID: controller.profile.profileID,
    evidence: { ...controller.profile.evidence },
    lethalDistanceMeters: controller.profile.lethalDistanceMeters,
    tickIntervalMs: controller.profile.tickIntervalMs,
    tickCount: controller.tickCount,
    totalAppliedDamage: controller.totalAppliedDamage,
    companionCount: companions.length,
    companions,
    timerRegistered: controller.timerHandle != null,
    cleaned: controller.cleaned,
  };
}

function getBoundaryControllerForRun(runID) {
  const controller = [...controllersByKey.values()].find(
    (candidate) => candidate.runID === toInt(runID, 0),
  );
  return snapshotController(controller);
}

function listBoundaryControllers() {
  return [...controllersByKey.values()].map(snapshotController);
}

function resetBoundaryControllersForTests() {
  for (const controller of [...controllersByKey.values()]) {
    cleanupController(controller, "test-reset");
  }
  controllersByKey.clear();
  nextGeneration = 1;
}

module.exports = {
  ABYSSAL_BOUNDARY_STATE,
  TYPE_ABYSSAL_PERIMETER_LIGHTS,
  TYPE_UNSTABLE_ABYSSAL_DEPTHS,
  resolvePerimeterRadius,
  calculateOutsideIntegration,
  registerBoundaryController,
  ensureActiveBoundaryController,
  tickBoundaryController,
  finalizeAndCleanupBoundaryControllersForRun,
  cleanupBoundaryControllersForRun,
  getBoundaryControllerForRun,
  listBoundaryControllers,
  resetBoundaryControllersForTests,
  _testing: {
    buildControllerKey,
    distanceMeters,
    validateControllerContext,
  },
};
