"use strict";

const path = require("path");

const {
  resolveItemByTypeID,
} = require("../../../services/inventory/itemTypeRegistry");
const {
  normalizeText,
} = require("../../domain/abyssalValueUtils");

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function getRuntimeEntityID(entity) {
  return toInt(entity && (entity.itemID || entity.entityID || entity.id), 0);
}

function getRuntimeEntityPosition(entity) {
  const position = entity && (entity.position || entity.dunPosition);
  if (Array.isArray(position) && position.length >= 3) {
    const [x, y, z] = position.map(Number);
    return [x, y, z].every(Number.isFinite) ? { x, y, z } : null;
  }
  if (!position || typeof position !== "object") {
    return null;
  }
  const x = Number(position.x);
  const y = Number(position.y);
  const z = Number(position.z);
  return [x, y, z].every(Number.isFinite) ? { x, y, z } : null;
}

function resolveRuntimeTypeContext(entity) {
  const typeID = toInt(entity && entity.typeID, 0);
  const typeRecord = typeID > 0 ? resolveItemByTypeID(typeID) : null;
  return {
    typeID,
    groupID: toInt(entity && entity.groupID, toInt(typeRecord && typeRecord.groupID, 0)),
    categoryID: toInt(
      entity && entity.categoryID,
      toInt(typeRecord && typeRecord.categoryID, 0),
    ),
  };
}

function resolveSuppressorCandidateClass(entity) {
  const typeContext = resolveRuntimeTypeContext(entity);
  if (typeContext.groupID === 1_997) return "abyssal-drone-entity";
  if (typeContext.categoryID === 87) return "fighter";
  if (typeContext.categoryID === 18) return "drone";
  if (typeContext.categoryID === 8) return "deployed-charge-entity";
  return "unsupported";
}

function isRuntimeEntityRemoved(entity) {
  const destructionState = normalizeText(
    entity && entity.destructionState,
    "",
  ).toLowerCase();
  return Boolean(
    !entity ||
    entity.destroyed === true ||
    entity.destroying === true ||
    entity.removed === true ||
    ["destroying", "destroyed", "removed"].includes(destructionState)
  );
}

function resolveCandidateController(scene, entity) {
  if (entity && entity.controller && typeof entity.controller === "object") {
    return entity.controller;
  }
  const controllerID = toInt(
    entity && (entity.controllerID || entity.ownerShipID || entity.launcherID),
    0,
  );
  if (
    controllerID > 0 &&
    scene &&
    scene.dynamicEntities instanceof Map
  ) {
    return scene.dynamicEntities.get(controllerID) || null;
  }
  return null;
}

function normalizeSuppressorCandidate(entity, scene, sourceRegistries = []) {
  const typeContext = resolveRuntimeTypeContext(entity);
  const runtimeEntityID = getRuntimeEntityID(entity);
  const entitySceneKey = normalizeText(
    entity && entity.sceneKey,
    normalizeText(scene && scene.sceneKey, ""),
  );
  const removed = isRuntimeEntityRemoved(entity);
  return {
    runtimeEntityID,
    typeID: typeContext.typeID,
    groupID: typeContext.groupID,
    categoryID: typeContext.categoryID,
    ownerID: toInt(
      entity && (
        entity.ownerCharacterID ||
        entity.pilotCharacterID ||
        entity.characterID ||
        entity.launcherCharacterID ||
        entity.ownerID
      ),
      0,
    ),
    sourceShipID: toInt(
      entity && (
        entity.sourceShipID ||
        entity.sourceEntityID ||
        entity.ownerShipID ||
        entity.launcherID ||
        entity.controllerID
      ),
      0,
    ),
    entityClass: resolveSuppressorCandidateClass(entity),
    position: getRuntimeEntityPosition(entity),
    scene,
    sceneKey: entitySceneKey,
    controller: resolveCandidateController(scene, entity),
    alive: !removed,
    removed,
    sourceRegistry: sourceRegistries.join("+") || "unknown",
    entity,
  };
}

function enumerateLiveSuppressorCandidates(options = {}) {
  const scene = options.scene;
  const dynamicEntities = scene && scene.dynamicEntities instanceof Map
    ? scene.dynamicEntities
    : new Map();
  const sceneEntities = [...dynamicEntities.values()].filter(Boolean);
  const diagnostics = {
    sceneEntities: sceneEntities.length,
    sceneDynamicEntities: sceneEntities.length,
    sceneMissileIndex: 0,
    sceneDroneIndex: scene && scene.droneEntityIDs instanceof Set
      ? scene.droneEntityIDs.size
      : 0,
    sceneFighterIndex: scene && scene.fighterEntityIDs instanceof Set
      ? scene.fighterEntityIDs.size
      : 0,
    sceneNpcIndex: 0,
    rawCandidates: 0,
    missileCandidates: 0,
    droneCandidates: 0,
    fighterCandidates: 0,
    npcCandidates: 0,
    deduplicatedCandidates: 0,
    duplicate: 0,
    alreadyRemoved: 0,
    missingController: 0,
  };
  const candidateEntitiesByID = new Map();
  const registriesByID = new Map();
  const missingIndexedCandidates = [];
  const classIDs = {
    missile: new Set(),
    drone: new Set(),
    fighter: new Set(),
    npc: new Set(),
  };

  const addEntity = (entity, sourceRegistry, candidateClass) => {
    diagnostics.rawCandidates += 1;
    const runtimeEntityID = getRuntimeEntityID(entity);
    if (runtimeEntityID <= 0) {
      diagnostics.missingController += 1;
      return;
    }
    classIDs[candidateClass].add(runtimeEntityID);
    if (candidateEntitiesByID.has(runtimeEntityID)) {
      diagnostics.duplicate += 1;
    } else {
      candidateEntitiesByID.set(runtimeEntityID, entity);
    }
    const registries = registriesByID.get(runtimeEntityID) || [];
    if (!registries.includes(sourceRegistry)) {
      registries.push(sourceRegistry);
    }
    registriesByID.set(runtimeEntityID, registries);
  };

  const addIndexedEntities = (ids, sourceRegistry, candidateClass) => {
    if (!(ids instanceof Set)) return;
    for (const rawEntityID of ids) {
      const runtimeEntityID = toInt(rawEntityID, 0);
      const entity = dynamicEntities.get(runtimeEntityID) || null;
      if (!entity) {
        diagnostics.rawCandidates += 1;
        diagnostics.alreadyRemoved += 1;
        diagnostics.missingController += 1;
        missingIndexedCandidates.push({
          runtimeEntityID,
          typeID: 0,
          groupID: 0,
          categoryID: 0,
          ownerID: 0,
          sourceShipID: 0,
          entityClass: candidateClass,
          position: null,
          scene,
          sceneKey: normalizeText(scene && scene.sceneKey, ""),
          controller: null,
          alive: false,
          removed: true,
          sourceRegistry,
          entity: null,
        });
        continue;
      }
      addEntity(entity, sourceRegistry, candidateClass);
    }
  };

  for (const entity of sceneEntities) {
    const entityClass = resolveSuppressorCandidateClass(entity);
    if (
      normalizeText(entity.kind, "").toLowerCase() === "missile" ||
      entityClass === "deployed-charge-entity"
    ) {
      addEntity(
        entity,
        normalizeText(entity.kind, "").toLowerCase() === "missile"
          ? "scene.dynamicEntities:missile"
          : "scene.dynamicEntities:deployed-charge",
        "missile",
      );
    }
    if (entityClass === "drone") {
      addEntity(entity, "scene.dynamicEntities:drone", "drone");
    }
    if (entityClass === "fighter") {
      addEntity(entity, "scene.dynamicEntities:fighter", "fighter");
    }
    if (entityClass === "abyssal-drone-entity") {
      addEntity(entity, "scene.dynamicEntities:abyssal-drone-entity", "npc");
    }
  }
  addIndexedEntities(scene && scene.droneEntityIDs, "scene.droneEntityIDs", "drone");
  addIndexedEntities(scene && scene.fighterEntityIDs, "scene.fighterEntityIDs", "fighter");

  diagnostics.missileCandidates = classIDs.missile.size;
  diagnostics.droneCandidates = classIDs.drone.size;
  diagnostics.fighterCandidates = classIDs.fighter.size;
  diagnostics.npcCandidates = classIDs.npc.size;
  diagnostics.sceneMissileIndex = [...dynamicEntities.values()].filter((entity) => (
    entity && normalizeText(entity.kind, "").toLowerCase() === "missile"
  )).length;
  diagnostics.sceneNpcIndex = diagnostics.npcCandidates;
  const candidates = [...candidateEntitiesByID.entries()]
    .map(([runtimeEntityID, entity]) => normalizeSuppressorCandidate(
      entity,
      scene,
      registriesByID.get(runtimeEntityID),
    ))
    .concat(missingIndexedCandidates)
    .sort((left, right) => left.runtimeEntityID - right.runtimeEntityID);
  diagnostics.deduplicatedCandidates = candidates.length;
  return { candidates, diagnostics };
}

module.exports = {
  enumerateLiveSuppressorCandidates,
  getRuntimeEntityID,
  getRuntimeEntityPosition,
  normalizeSuppressorCandidate,
  resolveRuntimeTypeContext,
  resolveSuppressorCandidateClass,
};
