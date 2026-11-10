"use strict";

const {
  ENVIRONMENTAL_EFFECT_KIND,
  getAbyssalEnvironmentalDefinition,
} = require("../catalog/abyssalEnvironmentalCatalog");
const {
  resolveEntityInteractionScope,
} = require("../../space/destiny/identity/interactionScope");
const {
  entityIDsEqual,
  normalizePersistentEntityID,
} = require("../../space/destiny/identity/entityID");
const {
  normalizeText,
} = require("../domain/abyssalValueUtils");

function toInt(value, fallback = 0) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toFiniteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getPosition(entity) {
  const position = entity && (entity.position || entity.dunPosition);
  if (!position || typeof position !== "object") {
    return null;
  }
  const x = toFiniteNumber(position.x, Number.NaN);
  const y = toFiniteNumber(position.y, Number.NaN);
  const z = toFiniteNumber(position.z, Number.NaN);
  if (![x, y, z].every(Number.isFinite)) {
    return null;
  }
  return { x, y, z };
}

function distanceMeters(a, b) {
  const left = getPosition(a);
  const right = getPosition(b);
  if (!left || !right) {
    return Number.POSITIVE_INFINITY;
  }
  const dx = left.x - right.x;
  const dy = left.y - right.y;
  const dz = left.z - right.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function entityMatchesRunRoom(entity, pocketState, roomIndex) {
  if (!entity || !pocketState) {
    return false;
  }
  const instanceID = normalizePersistentEntityID(pocketState.instanceID);
  const exactRoomIndex = toInt(roomIndex, 0);
  if (instanceID === null || exactRoomIndex <= 0) {
    return false;
  }
  const scope = resolveEntityInteractionScope(entity);
  return Boolean(
    scope &&
      scope.valid === true &&
      scope.hasAbyssalScope === true &&
      scope.abyssalInstanceID !== null &&
      entityIDsEqual(scope.abyssalInstanceID, instanceID) &&
      toInt(scope.abyssalRoomIndex, 0) === exactRoomIndex
  );
}

function listRoomEnvironmentalEntities(roomEntry, scene) {
  if (!roomEntry || !scene || typeof scene.getEntityByID !== "function") {
    return [];
  }
  const entityIDs = Array.isArray(roomEntry.environmentalObjectItemIDs)
    ? roomEntry.environmentalObjectItemIDs
    : [];
  return entityIDs
    .map((entityID) => scene.getEntityByID(toInt(entityID, 0)))
    .filter((entity) => entity && entity.evejsAbyssalEnvironmentalObject === true);
}

function ensureModifierContainer(entity) {
  if (!entity.evejsAbyssalEnvironmentalModifiers || typeof entity.evejsAbyssalEnvironmentalModifiers !== "object") {
    entity.evejsAbyssalEnvironmentalModifiers = {};
  }
  return entity.evejsAbyssalEnvironmentalModifiers;
}

function makeModifierKey(environmentEntity) {
  return [
    "abyssalEnvironmental",
    toInt(environmentEntity && environmentEntity.evejsAbyssalInstanceID, 0),
    toInt(environmentEntity && environmentEntity.evejsAbyssalRoomIndex, 0),
    toInt(environmentEntity && environmentEntity.itemID, 0),
  ].join(":");
}

function buildDbuffCollectionValues(definition) {
  const values = new Map();
  for (const entry of Array.isArray(definition && definition.dbuffCollectionValues)
    ? definition.dbuffCollectionValues
    : []) {
    const collectionID = toInt(entry && entry.collectionID, 0);
    const value = toFiniteNumber(entry && entry.value, Number.NaN);
    if (collectionID > 0 && Number.isFinite(value)) {
      values.set(collectionID, value);
    }
  }
  return values;
}

function definitionAffectsEntity(definition, entity) {
  const affectedKinds = Array.isArray(definition && definition.affectedEntityKinds)
    ? definition.affectedEntityKinds.map((value) => normalizeText(value, ""))
    : [];
  return affectedKinds.length <= 0 || affectedKinds.includes(normalizeText(entity && entity.kind, ""));
}

function applyLocalizedModifier(entity, environmentEntity, definition, scene, nowMs) {
  const modifierKey = makeModifierKey(environmentEntity);
  const collectionValues = buildDbuffCollectionValues(definition);
  const dogmaResult =
    scene && typeof scene.setContinuousDbuffSource === "function"
      ? scene.setContinuousDbuffSource(entity, modifierKey, collectionValues, {
          nowMs,
          reason: "abyssal-environment-enter",
        })
      : { success: false, changed: false, unresolvedCollectionIDs: [...collectionValues.keys()] };
  if (dogmaResult.success !== true) {
    return {
      applied: false,
      changed: false,
      unresolvedCollectionIDs: Array.isArray(dogmaResult.unresolvedCollectionIDs)
        ? dogmaResult.unresolvedCollectionIDs
        : [...collectionValues.keys()],
    };
  }

  const modifierContainer = ensureModifierContainer(entity);
  const existing = modifierContainer[modifierKey];
  modifierContainer[modifierKey] = {
    sourceItemID: toInt(environmentEntity && environmentEntity.itemID, 0),
    profileID: normalizeText(definition && definition.profileID, ""),
    effectKind: normalizeText(definition && definition.effectKind, ""),
    radiusMeters: toFiniteNumber(definition && definition.radiusMeters, 0),
    dbuffCollectionValues: Object.fromEntries(collectionValues),
    appliedAtMs: existing && toInt(existing.appliedAtMs, 0) > 0
      ? toInt(existing.appliedAtMs, 0)
      : toInt(nowMs, 0),
    lastEvaluatedAtMs: toInt(nowMs, 0),
  };
  return {
    applied: !existing,
    changed: dogmaResult.changed === true,
    unresolvedCollectionIDs: [],
  };
}

function removeLocalizedModifier(entity, environmentEntityOrKey, scene, nowMs, reason = "abyssal-environment-exit") {
  if (!entity || !entity.evejsAbyssalEnvironmentalModifiers) {
    return { removed: false, changed: false };
  }
  const modifierKey = typeof environmentEntityOrKey === "string"
    ? environmentEntityOrKey
    : makeModifierKey(environmentEntityOrKey);
  if (!Object.prototype.hasOwnProperty.call(entity.evejsAbyssalEnvironmentalModifiers, modifierKey)) {
    return { removed: false, changed: false };
  }
  const dogmaResult =
    scene && typeof scene.clearContinuousDbuffSource === "function"
      ? scene.clearContinuousDbuffSource(entity, modifierKey, { nowMs, reason })
      : { changed: false };
  delete entity.evejsAbyssalEnvironmentalModifiers[modifierKey];
  if (Object.keys(entity.evejsAbyssalEnvironmentalModifiers).length <= 0) {
    delete entity.evejsAbyssalEnvironmentalModifiers;
  }
  return { removed: true, changed: dogmaResult.changed === true };
}

function clearAbyssalEnvironmentalModifiersForRun(entity, instanceID, options = {}) {
  if (!entity || !entity.evejsAbyssalEnvironmentalModifiers) {
    return 0;
  }
  let removed = 0;
  const prefix = `abyssalEnvironmental:${toInt(instanceID, 0)}:`;
  for (const key of Object.keys(entity.evejsAbyssalEnvironmentalModifiers)) {
    if (!key.startsWith(prefix)) {
      continue;
    }
    removeLocalizedModifier(
      entity,
      key,
      options.scene || null,
      toInt(options.nowMs, Date.now()),
      normalizeText(options.reason, "abyssal-environment-run-cleanup"),
    );
    removed += 1;
  }
  return removed;
}

function evaluateAbyssalEnvironmentalEffects(options = {}) {
  const pocketState = options.pocketState;
  const roomEntry = options.roomEntry;
  const scene = options.scene;
  const nowMs = toInt(options.nowMs, 0);
  const candidates = Array.isArray(options.candidateEntities)
    ? options.candidateEntities.filter(Boolean)
    : [];
  const roomIndex = toInt(roomEntry && roomEntry.roomIndex, 0);
  const environmentEntities = listRoomEnvironmentalEntities(roomEntry, scene);
  const result = {
    evaluated: environmentEntities.length,
    appliedModifiers: 0,
    removedModifiers: 0,
    dogmaStateChanges: 0,
    disabledEffects: 0,
    delegatedEffects: 0,
    presentationOnly: 0,
    unresolvedCollectionIDs: [],
  };

  const activeModifierKeys = new Set();
  for (const environmentEntity of environmentEntities) {
    if (!entityMatchesRunRoom(environmentEntity, pocketState, roomIndex)) {
      continue;
    }
    const profileID = normalizeText(environmentEntity.evejsAbyssalEnvironmentalProfileID, "");
    const definition = getAbyssalEnvironmentalDefinition(profileID);
    if (
      definition &&
      definition.mechanicsEnabled === true &&
      definition.effectKind === ENVIRONMENTAL_EFFECT_KIND.LOCALIZED_MODIFIER
    ) {
      activeModifierKeys.add(makeModifierKey(environmentEntity));
    }
  }

  const runPrefix = `abyssalEnvironmental:${toInt(pocketState && pocketState.instanceID, 0)}:`;
  for (const candidate of candidates) {
    const candidateInCurrentScope = entityMatchesRunRoom(
      candidate,
      pocketState,
      roomIndex,
    );
    const modifierKeys = Object.keys(candidate.evejsAbyssalEnvironmentalModifiers || {});
    for (const modifierKey of modifierKeys) {
      const isManagedModifier = modifierKey.startsWith(runPrefix) ||
        (
          candidateInCurrentScope &&
          modifierKey.startsWith("abyssalEnvironmental:")
        );
      if (isManagedModifier && !activeModifierKeys.has(modifierKey)) {
        const removeResult = removeLocalizedModifier(
          candidate,
          modifierKey,
          scene,
          nowMs,
          "abyssal-environment-source-retired",
        );
        if (removeResult.removed) {
          result.removedModifiers += 1;
        }
        if (removeResult.changed) {
          result.dogmaStateChanges += 1;
        }
      }
    }
  }

  for (const environmentEntity of environmentEntities) {
    if (!entityMatchesRunRoom(environmentEntity, pocketState, roomIndex)) {
      result.disabledEffects += 1;
      continue;
    }
    const profileID = normalizeText(environmentEntity.evejsAbyssalEnvironmentalProfileID, "");
    const definition = getAbyssalEnvironmentalDefinition(profileID);
    if (!definition || definition.mechanicsEnabled !== true) {
      result.disabledEffects += 1;
      result.presentationOnly += 1;
      continue;
    }
    if (definition.effectKind === ENVIRONMENTAL_EFFECT_KIND.BOUNDARY_DAMAGE) {
      result.delegatedEffects += 1;
      continue;
    }
    if (definition.effectKind !== ENVIRONMENTAL_EFFECT_KIND.LOCALIZED_MODIFIER) {
      result.disabledEffects += 1;
      continue;
    }
    const radiusMeters = toFiniteNumber(
      environmentEntity.evejsAbyssalEnvironmentalRadiusMeters,
      toFiniteNumber(definition.radiusMeters, 0),
    );
    for (const candidate of candidates) {
      if (!entityMatchesRunRoom(candidate, pocketState, roomIndex) || !definitionAffectsEntity(definition, candidate)) {
        const removeResult = removeLocalizedModifier(
          candidate,
          environmentEntity,
          scene,
          nowMs,
          "abyssal-environment-scope-exit",
        );
        if (removeResult.removed) {
          result.removedModifiers += 1;
        }
        if (removeResult.changed) {
          result.dogmaStateChanges += 1;
        }
        continue;
      }
      if (radiusMeters > 0 && distanceMeters(environmentEntity, candidate) > radiusMeters) {
        const removeResult = removeLocalizedModifier(candidate, environmentEntity, scene, nowMs);
        if (removeResult.removed) {
          result.removedModifiers += 1;
        }
        if (removeResult.changed) {
          result.dogmaStateChanges += 1;
        }
        continue;
      }
      const applyResult = applyLocalizedModifier(candidate, environmentEntity, definition, scene, nowMs);
      if (applyResult.applied) {
        result.appliedModifiers += 1;
      }
      if (applyResult.changed) {
        result.dogmaStateChanges += 1;
      }
      result.unresolvedCollectionIDs.push(...applyResult.unresolvedCollectionIDs);
    }
  }
  result.unresolvedCollectionIDs = [...new Set(result.unresolvedCollectionIDs)].sort((a, b) => a - b);
  return result;
}

module.exports = {
  distanceMeters,
  entityMatchesRunRoom,
  evaluateAbyssalEnvironmentalEffects,
  clearAbyssalEnvironmentalModifiersForRun,
  _testing: {
    buildDbuffCollectionValues,
    definitionAffectsEntity,
    makeModifierKey,
  },
};
