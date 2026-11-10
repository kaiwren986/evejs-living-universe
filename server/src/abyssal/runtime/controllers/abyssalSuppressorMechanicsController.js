"use strict";

const path = require("path");

const {
  getTypeList,
  matchesTypeList,
} = require("../../../services/inventory/typeListAuthority");
const {
  SHORT_RANGE_SUPPRESSOR_TARGET_TYPE_LIST_ID,
  getAbyssalSuppressorMechanicsProfileByTypeID,
  validateResolvedTargetTypeList,
} = require("../../catalog/abyssalSuppressorMechanicsProfile");
const {
  enumerateLiveSuppressorCandidates,
  getRuntimeEntityID: getEntityID,
  getRuntimeEntityPosition: getEntityPosition,
  resolveRuntimeTypeContext: getTypeContext,
  resolveSuppressorCandidateClass: resolveTargetClass,
} = require("./abyssalSuppressorTargetAdapter");
const {
  recordSuppressorCandidate,
  recordSuppressorPulse,
  recordSuppressorTargetDamage,
} = require("./abyssalSuppressorDiagnostics");
const {
  resolveAbyssalRunRoomScope,
} = require("../../domain/abyssalRunScope");
const {
  normalizeText,
} = require("../../domain/abyssalValueUtils");

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

function distanceMeters(leftEntity, rightEntity) {
  const left = getEntityPosition(leftEntity);
  const right = getEntityPosition(rightEntity);
  if (!left || !right) {
    return Number.POSITIVE_INFINITY;
  }
  const dx = left.x - right.x;
  const dy = left.y - right.y;
  const dz = left.z - right.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function buildControllerKey(runID, roomIndex, runtimeEntityID) {
  return `abyssal-run:${toInt(runID, 0)}:room:${toInt(roomIndex, 0)}:entity:${toInt(runtimeEntityID, 0)}`;
}

function buildAbyssalSceneKey(runID) {
  const numericRunID = toInt(runID, 0);
  return numericRunID > 0 ? `abyssal-run:${numericRunID}` : "";
}

// This controller must distinguish "claimed no scope" from "claimed a
// contradictory scope", so it takes the rich form.
const resolveExactPositiveAbyssalRunRoomScope = resolveAbyssalRunRoomScope;

function resolveExplicitRoomIndex(entity) {
  const scope = resolveExactPositiveAbyssalRunRoomScope(entity);
  return scope.valid ? scope.roomIndex : 0;
}

function resolveEntityRunRoom(entity, context, entitiesByID, seen = new Set()) {
  const entityID = getEntityID(entity);
  if (!entity || (entityID > 0 && seen.has(entityID))) {
    return null;
  }
  if (entityID > 0) {
    seen.add(entityID);
  }

  const explicitScope = resolveExactPositiveAbyssalRunRoomScope(entity);
  if (explicitScope.present) {
    if (!explicitScope.valid) {
      return null;
    }
    return {
      runID: explicitScope.runID,
      roomIndex: explicitScope.roomIndex,
      source: "explicit",
    };
  }

  for (const referenceField of [
    "sourceShipID",
    "sourceEntityID",
    "ownerShipID",
    "launcherID",
    "controllerID",
    "controllerShipID",
    "launchShipID",
  ]) {
    const referencedEntityID = toInt(entity && entity[referenceField], 0);
    if (referencedEntityID <= 0) {
      continue;
    }
    const referencedEntity = entitiesByID.get(referencedEntityID);
    const referencedScope = resolveEntityRunRoom(
      referencedEntity,
      context,
      entitiesByID,
      seen,
    );
    if (referencedScope) {
      return { ...referencedScope, source: referenceField };
    }
  }

  return null;
}

function isAliveRuntimeCandidate(entity, scene) {
  const entityID = getEntityID(entity);
  return Boolean(
    entity &&
    entityID > 0 &&
    scene &&
    scene.dynamicEntities instanceof Map &&
    scene.dynamicEntities.get(entityID) === entity &&
    entity.destroyed !== true &&
    entity.destroying !== true &&
    entity.removed !== true &&
    !["destroying", "destroyed", "removed"].includes(
      normalizeText(entity.destructionState, "").toLowerCase(),
    )
  );
}

function clearControllerTimer(controller) {
  if (!controller || controller.timerHandle == null) {
    return false;
  }
  const clearIntervalCallback = controller.callbacks.clearInterval;
  if (typeof clearIntervalCallback === "function") {
    clearIntervalCallback(controller.timerHandle);
  }
  controller.timerHandle = null;
  controller.nextPulseAt = 0;
  return true;
}

function logState(controller, state, details = {}) {
  if (controller && typeof controller.callbacks.logState === "function") {
    controller.callbacks.logState({
      controller: snapshotController(controller),
      state,
      ...details,
    });
  }
}

function degradeController(controller, error) {
  if (!controller || controller.degraded) {
    return;
  }
  clearControllerTimer(controller);
  controller.degraded = true;
  controller.active = false;
  controller.paused = true;
  controller.inPulse = false;
  controller.activeTargetIDs = [];
  controller.degradedAt = toInt(controller.callbacks.now(), Date.now());
  controller.degradedReason = normalizeText(
    error && (error.errorMsg || error.message),
    "ABYSSAL_SUPPRESSOR_CONTROLLER_FAILURE",
  );
  logState(controller, "degraded", { errorMsg: controller.degradedReason });
  if (!controller.warningEmitted && typeof controller.callbacks.warn === "function") {
    controller.warningEmitted = true;
    controller.callbacks.warn(controller, controller.degradedReason);
  }
}

function normalizeEffectResult(result) {
  const damageResult = result && result.damageResult;
  const destroyResult = result && result.destroyResult;
  const affected = Boolean(
    result && result.affected === true ||
    damageResult && damageResult.success === true ||
    destroyResult && destroyResult.success === true
  );
  const destroyed = Boolean(
    result && result.destroyed === true ||
    destroyResult && destroyResult.success === true ||
    damageResult && damageResult.data && damageResult.data.destroyed === true
  );
  return {
    affected,
    damaged: Boolean(damageResult && damageResult.success === true),
    destroyed,
    removedMissile: Boolean(result && result.removedMissile === true),
    alreadyGone: Boolean(result && result.alreadyGone === true),
    failed: Boolean(
      result && result.failed === true ||
      damageResult && damageResult.success === false ||
      destroyResult && destroyResult.success === false
    ),
    reason: normalizeText(
      result && (result.reason || result.errorMsg) ||
      damageResult && damageResult.errorMsg ||
      destroyResult && destroyResult.errorMsg,
      affected ? "success" : "no-effect",
    ),
    damageData: damageResult && damageResult.data
      ? damageResult.data
      : null,
  };
}

function applyEffectToTarget(
  controller,
  scene,
  sourceEntity,
  target,
  nowMs,
  diagnosticContext = {},
) {
  const targetClass = resolveTargetClass(target);
  if (normalizeText(target.kind, "") === "missile") {
    if (typeof controller.callbacks.destroyProjectile !== "function") {
      throw new Error("ABYSSAL_SUPPRESSOR_PROJECTILE_REMOVAL_UNAVAILABLE");
    }
    return normalizeEffectResult(controller.callbacks.destroyProjectile({
      controller: snapshotController(controller),
      scene,
      sourceEntity,
      target,
      targetClass,
      nowMs,
      pulseNumber: toInt(diagnosticContext.pulseNumber, 0),
      distanceMeters: toFinite(diagnosticContext.distanceMeters, 0),
    }));
  }
  if (typeof controller.callbacks.applyDamage !== "function") {
    throw new Error("ABYSSAL_SUPPRESSOR_DAMAGE_PIPELINE_UNAVAILABLE");
  }
  return normalizeEffectResult(controller.callbacks.applyDamage({
    controller: snapshotController(controller),
    scene,
    sourceEntity,
    target,
    targetClass,
    damage: { ...controller.profile.damage },
    nowMs,
    pulseNumber: toInt(diagnosticContext.pulseNumber, 0),
    distanceMeters: toFinite(diagnosticContext.distanceMeters, 0),
  }));
}

function resolveDiagnosticCandidateClass(normalizedCandidate, candidate) {
  if (normalizeText(candidate && candidate.kind, "").toLowerCase() === "missile") {
    return "missile";
  }
  if (normalizedCandidate && normalizedCandidate.entityClass === "abyssal-drone-entity") {
    return "abyssal-drone-npc";
  }
  return normalizeText(normalizedCandidate && normalizedCandidate.entityClass, "unknown");
}

function recordCandidateDiagnostic(
  controller,
  pulseNumber,
  normalizedCandidate,
  details = {},
) {
  const candidate = normalizedCandidate && normalizedCandidate.entity;
  return recordSuppressorCandidate({
    runID: controller.runID,
    roomIndex: controller.roomIndex,
    pulseNumber,
    suppressorID: controller.runtimeEntityID,
    candidateID: toInt(normalizedCandidate && normalizedCandidate.runtimeEntityID, getEntityID(candidate)),
    typeID: toInt(normalizedCandidate && normalizedCandidate.typeID, 0),
    groupID: toInt(normalizedCandidate && normalizedCandidate.groupID, 0),
    categoryID: toInt(normalizedCandidate && normalizedCandidate.categoryID, 0),
    entityClass: resolveDiagnosticCandidateClass(normalizedCandidate, candidate),
    sourceRegistry: normalizeText(normalizedCandidate && normalizedCandidate.sourceRegistry, "unknown"),
    ownerID: toInt(normalizedCandidate && normalizedCandidate.ownerID, 0),
    sourceShipID: toInt(normalizedCandidate && normalizedCandidate.sourceShipID, 0),
    sceneKey: normalizeText(normalizedCandidate && normalizedCandidate.sceneKey, "none"),
    position: normalizedCandidate && normalizedCandidate.position
      ? { ...normalizedCandidate.position }
      : null,
    distanceMeters: details.distanceMeters,
    eligible: details.eligible === true,
    insideRange: details.insideRange === true,
    action: normalizeText(details.action, "reject"),
    result: normalizeText(details.result, "failed"),
    reason: normalizeText(details.reason, "unknown"),
  });
}

function pulseSuppressorController(controllerKey, nowMs = null, expectedGeneration = null) {
  const controller = controllersByKey.get(normalizeText(controllerKey, ""));
  if (
    !controller ||
    (expectedGeneration != null && controller.generation !== expectedGeneration) ||
    controller.cleaned ||
    controller.degraded ||
    controller.paused ||
    !controller.active
  ) {
    return { success: true, skipped: true, reason: "INACTIVE_OR_STALE" };
  }
  if (controller.inPulse) {
    return { success: true, skipped: true, reason: "PULSE_ALREADY_RUNNING" };
  }
  controller.inPulse = true;
  const pulseAt = nowMs == null
    ? toInt(controller.callbacks.now(), Date.now())
    : toInt(nowMs, 0);
  try {
    return validateSuppressorPulseContext(controller, pulseAt);
  } catch (error) {
    degradeController(controller, error);
    return {
      success: false,
      errorMsg: normalizeText(error && error.message, "ABYSSAL_SUPPRESSOR_PULSE_FAILED"),
    };
  } finally {
    controller.activeTargetIDs = [];
    controller.inPulse = false;
  }
}

function validateSuppressorPulseContext(controller, pulseAt) {

    const context = controller.callbacks.resolveContext(controller);
    const scene = context && context.scene;
    const pocketState = context && context.pocketState;
    const currentRoomIndex = toInt(context && context.roomIndex, 0);
    const currentSceneKey = normalizeText(
      context && context.sceneKey,
      normalizeText(scene && scene.sceneKey, ""),
    );
    const exactSceneKey = buildAbyssalSceneKey(controller.runID);
    if (
      !context ||
      !scene ||
      !(scene.dynamicEntities instanceof Map) ||
      toInt(context.runID, 0) !== controller.runID ||
      currentRoomIndex !== controller.roomIndex ||
      normalizeText(scene.sceneKey, "") !== exactSceneKey ||
      controller.sceneKey !== exactSceneKey ||
      currentSceneKey !== controller.sceneKey ||
      toInt(pocketState && pocketState.instanceID, 0) !== controller.runID
    ) {
      throw new Error("ABYSSAL_SUPPRESSOR_RUNTIME_SCOPE_STALE");
    }
    const sourceEntity = scene.getEntityByID(controller.runtimeEntityID);
    const sourceScope = resolveExactPositiveAbyssalRunRoomScope(sourceEntity);
    if (
      !sourceEntity ||
      toInt(sourceEntity.typeID, 0) !== controller.typeID ||
      !sourceScope.valid ||
      sourceScope.runID !== controller.runID ||
      sourceScope.roomIndex !== controller.roomIndex
    ) {
      throw new Error("ABYSSAL_SUPPRESSOR_ENTITY_STALE");
    }
    return selectSuppressorPulseCandidates({
      controller,
      pulseAt,
      context,
      scene,
      pocketState,
      currentRoomIndex,
      currentSceneKey,
      exactSceneKey,
      sourceEntity,
      sourceScope,
    });
  }

  function selectSuppressorPulseCandidates(attempt) {
    const { pocketState, controller, scene, currentSceneKey, sourceEntity } = attempt;
const enumeration = enumerateLiveSuppressorCandidates({
      run: pocketState,
      roomIndex: controller.roomIndex,
      scene,
      sceneKey: currentSceneKey,
      suppressorEntity: sourceEntity,
    });
    const entitiesByID = scene.dynamicEntities;
    const scopeContext = {
      runID: controller.runID,
      roomIndex: controller.roomIndex,
      shipID: toInt(pocketState && pocketState.shipID, 0),
      characterID: toInt(pocketState && pocketState.characterID, 0),
      sceneKey: currentSceneKey,
    };
    const pulseNumber = controller.pulseCount + 1;
    const pulseSummary = {
      ...enumeration.diagnostics,
      eligible: 0,
      insideRange: 0,
      selected: 0,
      affected: 0,
      damaged: 0,
      destroyed: 0,
      removedMissiles: 0,
      failed: 0,
      missingPosition: 0,
      wrongScene: 0,
      wrongRun: 0,
      wrongRoom: 0,
      unsupportedType: 0,
      unsupportedClass: 0,
      outsideRange: 0,
      alreadyRemoved: toInt(enumeration.diagnostics.alreadyRemoved, 0),
      alreadyDestroyed: 0,
      missingController: toInt(enumeration.diagnostics.missingController, 0),
      hiddenPrewarm: 0,
      duplicate: toInt(enumeration.diagnostics.duplicate, 0),
    };
    const eligible = [];
    const selection = { controller, scene, currentSceneKey, pulseSummary, pulseNumber, scopeContext, entitiesByID, sourceEntity, eligible };
    for (const normalizedCandidate of enumeration.candidates) {
      inspectSuppressorPulseCandidate(selection, normalizedCandidate);
    }
    return applySuppressorPulseEffects({
      ...attempt,
      enumeration,
      entitiesByID,
      scopeContext,
      pulseNumber,
      pulseSummary,
      eligible,
      selection,
    });
  }

  function applySuppressorPulseEffects(attempt) {
    const { eligible, pulseSummary, controller, scene, pulseNumber, sourceEntity, pulseAt } = attempt;
eligible.sort((left, right) => (
      left.distance - right.distance ||
      getEntityID(left.candidate) - getEntityID(right.candidate)
    ));
    const selected = eligible;
    pulseSummary.selected = selected.length;
    controller.activeTargetIDs = selected.map((entry) => getEntityID(entry.candidate));
    let affected = 0;
    let damaged = 0;
    let destroyed = 0;
    let removedMissiles = 0;
    let failed = 0;
    for (const entry of selected) {
      if (!isAliveRuntimeCandidate(entry.candidate, scene)) {
        failed += 1;
        recordCandidateDiagnostic(controller, pulseNumber, entry.normalizedCandidate, {
          distanceMeters: entry.distance,
          eligible: true,
          insideRange: true,
          action: normalizeText(entry.candidate.kind, "") === "missile"
            ? "remove-missile"
            : "apply-damage",
          result: "already-gone",
          reason: "removed-before-application",
        });
        continue;
      }
      const result = applyEffectToTarget(
        controller,
        scene,
        sourceEntity,
        entry.candidate,
        pulseAt,
        {
          pulseNumber,
          distanceMeters: entry.distance,
        },
      );
      if (result.affected) affected += 1;
      if (result.damaged) damaged += 1;
      if (result.destroyed) destroyed += 1;
      if (result.removedMissile) removedMissiles += 1;
      if (result.failed) failed += 1;
      const diagnosticClass = resolveDiagnosticCandidateClass(
        entry.normalizedCandidate,
        entry.candidate,
      );
      recordCandidateDiagnostic(controller, pulseNumber, entry.normalizedCandidate, {
        distanceMeters: entry.distance,
        eligible: true,
        insideRange: true,
        action: diagnosticClass === "missile" ? "remove-missile" : "apply-damage",
        result: result.alreadyGone
          ? "already-gone"
          : result.failed
            ? "failed"
            : "success",
        reason: result.reason,
      });
      if (diagnosticClass !== "missile") {
        const damageData = result.damageData || {};
        const beforeLayers = damageData.beforeLayers || {};
        const afterLayers = damageData.afterLayers || {};
        recordSuppressorTargetDamage({
          runID: controller.runID,
          roomIndex: controller.roomIndex,
          pulseNumber,
          suppressorID: controller.runtimeEntityID,
          targetID: getEntityID(entry.candidate),
          typeID: toInt(entry.normalizedCandidate.typeID, 0),
          ownerID: toInt(entry.normalizedCandidate.ownerID, 0),
          entityClass: diagnosticClass,
          distanceMeters: entry.distance,
          rawDamageExplosive: toFinite(controller.profile.damage.explosive, 0),
          rawDamageThermal: toFinite(controller.profile.damage.thermal, 0),
          shieldBefore: beforeLayers.shield,
          armorBefore: beforeLayers.armor,
          structureBefore: beforeLayers.structure,
          shieldAfter: afterLayers.shield,
          armorAfter: afterLayers.armor,
          structureAfter: afterLayers.structure,
          destroyed: result.destroyed,
          result: result.failed ? "failed" : "success",
        });
      }
    }
    return recordSuppressorPulseCompletion({
      ...attempt,
      selected,
      affected,
      damaged,
      destroyed,
      removedMissiles,
      failed,
    });
  }

  function recordSuppressorPulseCompletion(attempt) {
    const { controller, pulseAt, pulseSummary, selected, affected, destroyed, damaged, removedMissiles, failed, pulseNumber } = attempt;
controller.lastPulseAt = pulseAt;
    controller.nextPulseAt = pulseAt + controller.profile.activationDurationMs;
    controller.pulseCount += 1;
    controller.eligibleTargetsLastPulse = pulseSummary.eligible;
    controller.insideRangeTargetsLastPulse = pulseSummary.insideRange;
    controller.selectedTargetsLastPulse = selected.length;
    controller.affectedTargetsLastPulse = affected;
    controller.destroyedTargetsLastPulse = destroyed;
    controller.totalAffected += affected;
    controller.totalDestroyed += destroyed;
    pulseSummary.affected = affected;
    pulseSummary.damaged = damaged;
    pulseSummary.destroyed = destroyed;
    pulseSummary.removedMissiles = removedMissiles;
    pulseSummary.failed = failed;
    controller.lastPulseSummary = { ...pulseSummary };
    recordSuppressorPulse({
      runID: controller.runID,
      roomIndex: controller.roomIndex,
      sceneKey: controller.sceneKey,
      suppressorID: controller.runtimeEntityID,
      pulseNumber,
      timestamp: pulseAt,
      active: controller.active,
      paused: controller.paused,
      ...pulseSummary,
    });
    return {
      success: true,
      data: { ...pulseSummary },
    };
  }

function inspectSuppressorPulseCandidate(attempt, normalizedCandidate) {
  const { controller, scene, currentSceneKey, pulseSummary, pulseNumber } = attempt;

  const candidate = normalizedCandidate.entity;
  if (
    getEntityID(candidate) === controller.runtimeEntityID
  ) {
    return;
  }
  if (
    normalizedCandidate.removed ||
    normalizedCandidate.alive !== true ||
    !isAliveRuntimeCandidate(candidate, scene)
  ) {
    pulseSummary.alreadyDestroyed += 1;
    recordCandidateDiagnostic(controller, pulseNumber, normalizedCandidate, {
      action: "reject",
      result: "already-gone",
      reason: normalizedCandidate.removed === true && !candidate
        ? "already-removed"
        : "already-destroyed",
    });
    return;
  }
  if (
    candidate.hiddenDuringAbyssalPrewarm === true
  ) {
    pulseSummary.hiddenPrewarm += 1;
    recordCandidateDiagnostic(controller, pulseNumber, normalizedCandidate, {
      action: "reject",
      result: "failed",
      reason: "hidden-prewarm",
    });
    return;
  }
  if (
    normalizedCandidate.scene !== scene ||
    normalizeText(normalizedCandidate.sceneKey, "") !== currentSceneKey
  ) {
    pulseSummary.wrongScene += 1;
    recordCandidateDiagnostic(controller, pulseNumber, normalizedCandidate, {
      action: "reject",
      result: "failed",
      reason: "wrong-scene",
    });
    return;
  }
  if (!normalizedCandidate.position) {
    pulseSummary.missingPosition += 1;
    recordCandidateDiagnostic(controller, pulseNumber, normalizedCandidate, {
      action: "reject",
      result: "failed",
      reason: "missing-position",
    });
    return;
  }
  if (
    ["drone", "fighter"].includes(normalizedCandidate.entityClass) &&
    !normalizedCandidate.controller
  ) {
    pulseSummary.missingController += 1;
    recordCandidateDiagnostic(controller, pulseNumber, normalizedCandidate, {
      action: "reject",
      result: "failed",
      reason: "missing-controller",
    });
    return;
  }
  return inspectSuppressorCandidateScope({ ...attempt, candidate, normalizedCandidate });
}

function inspectSuppressorCandidateScope(attempt) {
  const {
    controller,
    candidate,
    normalizedCandidate,
    scopeContext,
    entitiesByID,
    pulseSummary,
    pulseNumber,
    sourceEntity,
    eligible,
  } = attempt;
const candidateScope = resolveEntityRunRoom(
    candidate,
    scopeContext,
    entitiesByID,
  );
  if (!candidateScope) {
    if (resolveExplicitRoomIndex(candidate) > 0) {
      pulseSummary.wrongRoom += 1;
      recordCandidateDiagnostic(controller, pulseNumber, normalizedCandidate, {
        action: "reject",
        result: "failed",
        reason: "wrong-room",
      });
    } else {
      pulseSummary.wrongRun += 1;
      recordCandidateDiagnostic(controller, pulseNumber, normalizedCandidate, {
        action: "reject",
        result: "failed",
        reason: "wrong-run",
      });
    }
    return;
  }
  if (candidateScope.runID !== controller.runID) {
    pulseSummary.wrongRun += 1;
    recordCandidateDiagnostic(controller, pulseNumber, normalizedCandidate, {
      action: "reject",
      result: "failed",
      reason: "wrong-run",
    });
    return;
  }
  if (candidateScope.roomIndex !== controller.roomIndex) {
    pulseSummary.wrongRoom += 1;
    recordCandidateDiagnostic(controller, pulseNumber, normalizedCandidate, {
      action: "reject",
      result: "failed",
      reason: "wrong-room",
    });
    return;
  }
  const typeContext = {
    typeID: normalizedCandidate.typeID,
    groupID: normalizedCandidate.groupID,
    categoryID: normalizedCandidate.categoryID,
  };
  if (normalizedCandidate.entityClass === "unsupported") {
    pulseSummary.unsupportedClass += 1;
    recordCandidateDiagnostic(controller, pulseNumber, normalizedCandidate, {
      action: "reject",
      result: "failed",
      reason: "unsupported-class",
    });
    return;
  }
  if (!matchesTypeList(typeContext, controller.profile.targetTypeListID)) {
    pulseSummary.unsupportedType += 1;
    recordCandidateDiagnostic(controller, pulseNumber, normalizedCandidate, {
      action: "reject",
      result: "failed",
      reason: "unsupported-type",
    });
    return;
  }
  const distance = distanceMeters(sourceEntity, normalizedCandidate);
  pulseSummary.eligible += 1;
  if (distance > controller.profile.mechanicsRangeMeters) {
    pulseSummary.outsideRange += 1;
    recordCandidateDiagnostic(controller, pulseNumber, normalizedCandidate, {
      distanceMeters: distance,
      eligible: true,
      insideRange: false,
      action: "reject",
      result: "failed",
      reason: "outside-range",
    });
    return;
  }
  pulseSummary.insideRange += 1;
  eligible.push({
    candidate,
    normalizedCandidate,
    distance,
  });
}

function normalizeCallbacks(callbacks = {}) {
  return {
    now: typeof callbacks.now === "function" ? callbacks.now : () => Date.now(),
    setInterval: callbacks.setInterval,
    clearInterval: callbacks.clearInterval,
    resolveContext: callbacks.resolveContext,
    applyDamage: callbacks.applyDamage,
    destroyProjectile: callbacks.destroyProjectile,
    logState: callbacks.logState,
    logPulse: callbacks.logPulse,
    warn: callbacks.warn,
  };
}

function registerSuppressorController(options = {}) {
  const runID = toInt(options.runID, 0);
  const roomIndex = toInt(options.roomIndex, 0);
  const runtimeEntityID = toInt(options.runtimeEntityID, 0);
  const typeID = toInt(options.typeID, 0);
  const sceneKey = normalizeText(options.sceneKey, "");
  const exactSceneKey = buildAbyssalSceneKey(runID);
  const profile = getAbyssalSuppressorMechanicsProfileByTypeID(typeID);
  if (
    runID <= 0 || roomIndex <= 0 || runtimeEntityID <= 0 ||
    !sceneKey || sceneKey !== exactSceneKey ||
    !profile || profile.mechanicsEnabled !== true
  ) {
    return { success: false, errorMsg: "ABYSSAL_SUPPRESSOR_CONTROLLER_CONTEXT_INVALID" };
  }
  const authorityValidation = validateResolvedTargetTypeList(
    getTypeList(SHORT_RANGE_SUPPRESSOR_TARGET_TYPE_LIST_ID),
  );
  if (!authorityValidation.success) {
    return authorityValidation;
  }
  const callbacks = normalizeCallbacks(options.callbacks);
  if (typeof callbacks.resolveContext !== "function") {
    return { success: false, errorMsg: "ABYSSAL_SUPPRESSOR_CONTEXT_RESOLVER_UNAVAILABLE" };
  }
  const key = buildControllerKey(runID, roomIndex, runtimeEntityID);
  const existing = controllersByKey.get(key);
  if (existing && !existing.cleaned) {
    existing.callbacks = callbacks;
    existing.sceneKey = sceneKey;
    return { success: true, created: false, data: snapshotController(existing) };
  }
  const registeredAt = toInt(options.registeredAt, toInt(callbacks.now(), Date.now()));
  const controller = {
    key,
    generation: nextGeneration++,
    runID,
    roomIndex,
    runtimeEntityID,
    typeID,
    name: profile.name,
    sceneKey,
    profile,
    callbacks,
    registeredAt,
    activatedAt: 0,
    lastPulseAt: 0,
    nextPulseAt: 0,
    pulseCount: 0,
    eligibleTargetsLastPulse: 0,
    insideRangeTargetsLastPulse: 0,
    selectedTargetsLastPulse: 0,
    affectedTargetsLastPulse: 0,
    destroyedTargetsLastPulse: 0,
    lastPulseSummary: null,
    totalAffected: 0,
    totalDestroyed: 0,
    paused: true,
    active: false,
    degraded: false,
    degradedAt: 0,
    degradedReason: "",
    warningEmitted: false,
    inPulse: false,
    activeTargetIDs: [],
    cleaned: false,
    timerHandle: null,
  };
  controllersByKey.set(key, controller);
  logState(controller, "registered");
  return { success: true, created: true, data: snapshotController(controller) };
}

function activateController(controller, nowMs = null) {
  if (!controller || controller.cleaned || controller.degraded) {
    return { success: false, errorMsg: "ABYSSAL_SUPPRESSOR_CONTROLLER_UNAVAILABLE" };
  }
  if (controller.active && !controller.paused && controller.timerHandle != null) {
    return { success: true, created: false, data: snapshotController(controller) };
  }
  if (typeof controller.callbacks.setInterval !== "function") {
    degradeController(controller, new Error("ABYSSAL_SUPPRESSOR_INTERVAL_UNAVAILABLE"));
    return { success: false, errorMsg: controller.degradedReason };
  }
  clearControllerTimer(controller);
  const activatedAt = nowMs == null
    ? toInt(controller.callbacks.now(), Date.now())
    : toInt(nowMs, 0);
  controller.paused = false;
  controller.active = true;
  controller.activatedAt = controller.activatedAt > 0
    ? controller.activatedAt
    : activatedAt;
  controller.nextPulseAt = activatedAt + controller.profile.activationDurationMs;
  const generation = controller.generation;
  controller.timerHandle = controller.callbacks.setInterval(() => {
    pulseSuppressorController(
      controller.key,
      toInt(controller.callbacks.now(), Date.now()),
      generation,
    );
  }, controller.profile.activationDurationMs);
  if (controller.timerHandle == null) {
    degradeController(controller, new Error("ABYSSAL_SUPPRESSOR_INTERVAL_REGISTRATION_FAILED"));
    return { success: false, errorMsg: controller.degradedReason };
  }
  logState(controller, "activated");
  return { success: true, created: true, data: snapshotController(controller) };
}

function activateSuppressorControllersForRoom(runID, roomIndex, nowMs = null) {
  const matching = [...controllersByKey.values()].filter((controller) => (
    controller.runID === toInt(runID, 0) &&
    controller.roomIndex === toInt(roomIndex, 0)
  ));
  return matching.map((controller) => activateController(controller, nowMs));
}

function pauseSuppressorControllersForRoom(runID, roomIndex, reason = "paused") {
  const paused = [];
  for (const controller of controllersByKey.values()) {
    if (
      controller.runID !== toInt(runID, 0) ||
      controller.roomIndex !== toInt(roomIndex, 0) ||
      controller.cleaned
    ) {
      continue;
    }
    clearControllerTimer(controller);
    controller.active = false;
    controller.paused = true;
    controller.inPulse = false;
    controller.activeTargetIDs = [];
    paused.push(snapshotController(controller));
    logState(controller, "paused", { reason });
  }
  return paused;
}

function cleanupController(controller, reason = "cleanup") {
  if (!controller || controller.cleaned) {
    return false;
  }
  clearControllerTimer(controller);
  controller.active = false;
  controller.paused = true;
  controller.inPulse = false;
  controller.activeTargetIDs = [];
  controller.cleaned = true;
  controller.generation = nextGeneration++;
  controllersByKey.delete(controller.key);
  logState(controller, "cleaned", { reason });
  return true;
}

function cleanupSuppressorControllerByEntity(runID, roomIndex, runtimeEntityID, reason = "cleanup") {
  const key = buildControllerKey(runID, roomIndex, runtimeEntityID);
  return cleanupController(controllersByKey.get(key), reason);
}

function cleanupSuppressorControllerByRuntimeEntity(runID, runtimeEntityID, reason = "cleanup") {
  let removed = 0;
  for (const controller of [...controllersByKey.values()]) {
    if (
      controller.runID === toInt(runID, 0) &&
      controller.runtimeEntityID === toInt(runtimeEntityID, 0) &&
      cleanupController(controller, reason)
    ) {
      removed += 1;
    }
  }
  return removed;
}

function cleanupSuppressorControllersForRun(runID, reason = "cleanup") {
  let removed = 0;
  for (const controller of [...controllersByKey.values()]) {
    if (controller.runID === toInt(runID, 0) && cleanupController(controller, reason)) {
      removed += 1;
    }
  }
  return removed;
}

function snapshotController(controller) {
  if (!controller) return null;
  return {
    key: controller.key,
    runID: controller.runID,
    roomIndex: controller.roomIndex,
    runtimeEntityID: controller.runtimeEntityID,
    typeID: controller.typeID,
    name: controller.name,
    sceneKey: controller.sceneKey,
    mechanicsProfileID: controller.profile.profileID,
    presentationEnabled: true,
    mechanicsEnabled: controller.profile.mechanicsEnabled === true,
    controllerRegistered: !controller.cleaned,
    controllerPaused: controller.paused,
    controllerActive: controller.active,
    controllerDegraded: controller.degraded,
    controllerDegradedReason: controller.degradedReason,
    presentationRadiusMeters: controller.profile.presentationRadiusMeters,
    mechanicsRangeMeters: controller.profile.mechanicsRangeMeters,
    activationDurationMs: controller.profile.activationDurationMs,
    dogmaEffectID: controller.profile.dogmaEffectID,
    targetTypeListID: controller.profile.targetTypeListID,
    damage: { ...controller.profile.damage },
    resolvedTargetClasses: [...controller.profile.resolvedTargetClasses],
    registeredAt: controller.registeredAt,
    activatedAt: controller.activatedAt,
    lastPulseAt: controller.lastPulseAt,
    nextPulseAt: controller.nextPulseAt,
    pulseCount: controller.pulseCount,
    eligibleTargetsLastPulse: controller.eligibleTargetsLastPulse,
    insideRangeTargetsLastPulse: controller.insideRangeTargetsLastPulse,
    selectedTargetsLastPulse: controller.selectedTargetsLastPulse,
    affectedTargetsLastPulse: controller.affectedTargetsLastPulse,
    destroyedTargetsLastPulse: controller.destroyedTargetsLastPulse,
    latestPulseSummary: controller.lastPulseSummary
      ? { ...controller.lastPulseSummary }
      : null,
    activeTargetIDs: Array.isArray(controller.activeTargetIDs)
      ? [...controller.activeTargetIDs]
      : [],
    totalAffected: controller.totalAffected,
    totalDestroyed: controller.totalDestroyed,
    timerRegistered: controller.timerHandle != null,
  };
}

function getSuppressorController(runID, roomIndex, runtimeEntityID) {
  return snapshotController(
    controllersByKey.get(buildControllerKey(runID, roomIndex, runtimeEntityID)),
  );
}

function listSuppressorControllersForRun(runID, roomIndex = null) {
  return [...controllersByKey.values()]
    .filter((controller) => (
      controller.runID === toInt(runID, 0) &&
      (roomIndex == null || controller.roomIndex === toInt(roomIndex, 0))
    ))
    .map(snapshotController)
    .sort((left, right) => (
      left.roomIndex - right.roomIndex ||
      left.runtimeEntityID - right.runtimeEntityID
    ));
}

function resetSuppressorControllersForTests() {
  for (const controller of [...controllersByKey.values()]) {
    cleanupController(controller, "test-reset");
  }
  controllersByKey.clear();
  nextGeneration = 1;
}

module.exports = {
  buildControllerKey,
  distanceMeters,
  registerSuppressorController,
  activateSuppressorControllersForRoom,
  pauseSuppressorControllersForRoom,
  cleanupSuppressorControllerByEntity,
  cleanupSuppressorControllerByRuntimeEntity,
  cleanupSuppressorControllersForRun,
  getSuppressorController,
  listSuppressorControllersForRun,
  pulseSuppressorController,
  resolveEntityRunRoom,
  resolveTargetClass,
  resetSuppressorControllersForTests,
};
