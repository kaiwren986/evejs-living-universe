"use strict";

const {
  toFiniteNumber,
} = require("../../common/numbers");

const path = require("path");

const {
  getControllerByEntityID,
} = require(path.join(__dirname, "./npcRegistry"));
const {
  tickControllersByEntityID,
} = require(path.join(__dirname, "./npcBehaviorLoop"));
const {
  listAmbientStartupControllerRecordsForSystem,
  canDematerializeAmbientStartupController,
} = require(path.join(__dirname, "./npcAmbientMaterialization"));
const {
  listCombatDormancyControllerRecordsForSystem,
  canDematerializeDormantCombatController,
} = require(path.join(__dirname, "./npcCombatDormancy"));

function toPositiveInt(value, fallback = 0) {
  const numeric = Math.trunc(Number(value) || 0);
  return numeric > 0 ? numeric : fallback;
}

function isAnchorRelevanceEnabled() {
  return process.env.EVEJS_DISABLE_NPC_ANCHOR_RELEVANCE !== "1";
}

function getNativeNpcService() {
  return require(path.join(__dirname, "./nativeNpcService"));
}

// A relevance key is a Grid bubble ID, kept as text: the relevant set holds
// it so, and a controller's key is looked up the same way. A number looked
// up in a set of text matches nothing, and every controller read as
// irrelevant.
function normalizeClusterKey(clusterKey) {
  return String(clusterKey || "").trim();
}

function addClusterKey(target, clusterKey) {
  const normalizedClusterKey = normalizeClusterKey(clusterKey);
  if (!normalizedClusterKey) {
    return;
  }
  target.add(normalizedClusterKey);
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function collectRelevantPublicGridClusterKeys(scene, options = {}) {
  const clusterKeys = new Set();
  if (!scene) {
    return clusterKeys;
  }

  for (const clusterKey of normalizeArray(options.relevantClusterKeys)) {
    addClusterKey(clusterKeys, clusterKey);
  }

  for (const entity of normalizeArray(options.relevantEntities)) {
    addClusterKey(
      clusterKeys,
      scene.getGridBubbleIDForEntity
        ? scene.getGridBubbleIDForEntity(entity)
        : null,
    );
  }

  for (const position of normalizeArray(options.relevantPositions)) {
    addClusterKey(
      clusterKeys,
      scene.getGridBubbleIDForPosition
        ? scene.getGridBubbleIDForPosition(position)
        : null,
    );
  }

  if (options.includeSceneSessions !== false && scene.sessions instanceof Map) {
    for (const session of scene.sessions.values()) {
      addClusterKey(
        clusterKeys,
        scene.getGridBubbleIDForSession
          ? scene.getGridBubbleIDForSession(session)
          : null,
      );
      // A pilot on its way somewhere: from the warp order to the drop, its
      // destination is relevant too, so what the warp's prewarm materialized
      // there stays.
      const ship = typeof scene.getShipEntityForSession === "function"
        ? scene.getShipEntityForSession(session)
        : null;
      const destination = ship && ship.warpDestination && ship.warpDestination.targetPoint;
      if (destination && scene.getGridBubbleIDForPosition) {
        addClusterKey(clusterKeys, scene.getGridBubbleIDForPosition(destination));
      }
    }
  }

  return clusterKeys;
}

function hasStartupAnchorRelevanceContext(scene, options = {}) {
  if (!scene || !isAnchorRelevanceEnabled()) {
    return false;
  }
  if (
    normalizeArray(options.relevantClusterKeys).length > 0 ||
    normalizeArray(options.relevantEntities).length > 0 ||
    normalizeArray(options.relevantPositions).length > 0
  ) {
    return true;
  }
  return scene.sessions instanceof Map && scene.sessions.size > 0;
}

function getLiveDynamicEntity(scene, entityID) {
  const normalizedEntityID = toPositiveInt(entityID, 0);
  if (!scene || !normalizedEntityID) {
    return null;
  }
  if (scene.dynamicEntities instanceof Map) {
    return scene.dynamicEntities.get(normalizedEntityID) || null;
  }
  return scene.getEntityByID ? scene.getEntityByID(normalizedEntityID) : null;
}

function getStartupControllerAnchorClusterKey(scene, controllerRecord) {
  if (!scene || !controllerRecord) {
    return null;
  }

  const anchorID = toPositiveInt(controllerRecord.anchorID, 0);
  if (anchorID > 0) {
    const anchorEntity = scene.getEntityByID ? scene.getEntityByID(anchorID) : null;
    if (anchorEntity) {
      return scene.getGridBubbleIDForEntity
        ? scene.getGridBubbleIDForEntity(anchorEntity)
        : null;
    }
  }

  const homePosition =
    controllerRecord.homePosition &&
    typeof controllerRecord.homePosition === "object"
      ? controllerRecord.homePosition
      : null;
  if (homePosition) {
    return scene.getGridBubbleIDForPosition
      ? scene.getGridBubbleIDForPosition(homePosition)
      : null;
  }

  return null;
}

// Whether a controller has a place to judge: a live anchor, or a home.
function hasStartupControllerLocation(scene, controllerRecord) {
  const anchorID = toPositiveInt(controllerRecord && controllerRecord.anchorID, 0);
  if (anchorID > 0 && scene.getEntityByID && scene.getEntityByID(anchorID)) {
    return true;
  }
  return Boolean(
    controllerRecord &&
    controllerRecord.homePosition &&
    typeof controllerRecord.homePosition === "object"
  );
}

function isStartupControllerRelevant(scene, controllerRecord, relevantClusterKeys) {
  if (!scene || !controllerRecord) {
    return false;
  }
  const clusterKey = getStartupControllerAnchorClusterKey(scene, controllerRecord);
  if (!clusterKey) {
    // A home with no Grid bubble (no Ball near it) is on no pilot's grid.
    // Only a controller with no location at all is kept, as before; a far
    // one read as relevant was materialized, made a bubble of its own, and
    // was dematerialized the next tick, every tick.
    return !hasStartupControllerLocation(scene, controllerRecord);
  }
  return relevantClusterKeys.has(normalizeClusterKey(clusterKey));
}

function materializeRelevantAmbientControllers(scene, relevantClusterKeys, options = {}) {
  const materialized = [];
  for (const controllerRecord of listAmbientStartupControllerRecordsForSystem(scene.systemID)) {
    const entityID = toPositiveInt(controllerRecord && controllerRecord.entityID, 0);
    if (!entityID || !isStartupControllerRelevant(scene, controllerRecord, relevantClusterKeys)) {
      continue;
    }
    if (getLiveDynamicEntity(scene, entityID) || getControllerByEntityID(entityID)) {
      continue;
    }
    const result = getNativeNpcService().materializeStoredNativeController(scene, entityID, {
      broadcast: options.broadcast === true,
      excludedSession: options.excludedSession || null,
    });
    if (!result.success) {
      return result;
    }
    if (result.data && result.data.prunedInvalidStoredController === true) {
      continue;
    }
    materialized.push({
      entityID,
      startupRuleID: String(controllerRecord.startupRuleID || "").trim() || null,
      anchorID: toPositiveInt(controllerRecord.anchorID, 0),
      anchorClusterKey: getStartupControllerAnchorClusterKey(scene, controllerRecord),
    });
  }

  return {
    success: true,
    data: {
      materialized,
      materializedCount: materialized.length,
    },
  };
}

function materializeRelevantCombatControllers(scene, relevantClusterKeys, options = {}) {
  const materialized = [];
  for (const controllerRecord of listCombatDormancyControllerRecordsForSystem(scene.systemID)) {
    const entityID = toPositiveInt(controllerRecord && controllerRecord.entityID, 0);
    if (!entityID || !isStartupControllerRelevant(scene, controllerRecord, relevantClusterKeys)) {
      continue;
    }
    if (getLiveDynamicEntity(scene, entityID) || getControllerByEntityID(entityID)) {
      continue;
    }
    const result = getNativeNpcService().materializeStoredNativeController(scene, entityID, {
      broadcast: options.broadcast === true,
      excludedSession: options.excludedSession || null,
    });
    if (!result.success) {
      return result;
    }
    if (result.data && result.data.prunedInvalidStoredController === true) {
      continue;
    }
    materialized.push({
      entityID,
      startupRuleID: String(controllerRecord.startupRuleID || "").trim() || null,
      operatorKind: String(controllerRecord.operatorKind || "").trim() || null,
      anchorID: toPositiveInt(controllerRecord.anchorID, 0),
      anchorClusterKey: getStartupControllerAnchorClusterKey(scene, controllerRecord),
      entityType: String(controllerRecord.entityType || "").trim().toLowerCase() || null,
    });
  }

  if (materialized.length > 0 && options.catchUpBehavior !== false) {
    const nowMs = toFiniteNumber(
      options.nowMs,
      scene.getCurrentSimTimeMs ? scene.getCurrentSimTimeMs() : Date.now(),
    );
    tickControllersByEntityID(
      scene,
      materialized.map((entry) => entry.entityID),
      nowMs,
    );
  }

  return {
    success: true,
    data: {
      materialized,
      materializedCount: materialized.length,
    },
  };
}

function dematerializeIrrelevantAmbientControllers(scene, relevantClusterKeys, options = {}) {
  const dematerialized = [];
  const skipped = [];

  for (const controllerRecord of listAmbientStartupControllerRecordsForSystem(scene.systemID)) {
    const entityID = toPositiveInt(controllerRecord && controllerRecord.entityID, 0);
    if (!entityID || isStartupControllerRelevant(scene, controllerRecord, relevantClusterKeys)) {
      continue;
    }

    const entity = getLiveDynamicEntity(scene, entityID);
    if (!entity) {
      continue;
    }
    const liveController = getControllerByEntityID(entityID) || controllerRecord;
    if (
      !canDematerializeAmbientStartupController(scene, liveController, entity, {
        ignoreSceneSessionCount: true,
      })
    ) {
      skipped.push({
        entityID,
        startupRuleID: String(controllerRecord.startupRuleID || "").trim() || null,
      });
      continue;
    }

    const result = getNativeNpcService().dematerializeNativeController(liveController, {
      broadcast: options.broadcast === true,
      persistState: options.persistState !== false,
    });
    if (!result.success) {
      return result;
    }

    dematerialized.push({
      entityID,
      startupRuleID: String(controllerRecord.startupRuleID || "").trim() || null,
      anchorID: toPositiveInt(controllerRecord.anchorID, 0),
      anchorClusterKey: getStartupControllerAnchorClusterKey(scene, controllerRecord),
    });
  }

  return {
    success: true,
    data: {
      dematerialized,
      dematerializedCount: dematerialized.length,
      skipped,
      skippedCount: skipped.length,
    },
  };
}

function dematerializeIrrelevantCombatControllers(scene, relevantClusterKeys, options = {}) {
  const nowMs = toFiniteNumber(
    options.nowMs,
    scene.getCurrentSimTimeMs ? scene.getCurrentSimTimeMs() : Date.now(),
  );
  const dematerialized = [];
  const skipped = [];

  for (const controllerRecord of listCombatDormancyControllerRecordsForSystem(scene.systemID)) {
    const entityID = toPositiveInt(controllerRecord && controllerRecord.entityID, 0);
    if (!entityID || isStartupControllerRelevant(scene, controllerRecord, relevantClusterKeys)) {
      continue;
    }

    const entity = getLiveDynamicEntity(scene, entityID);
    if (!entity) {
      continue;
    }
    const liveController = getControllerByEntityID(entityID) || controllerRecord;
    if (
      !canDematerializeDormantCombatController(scene, liveController, entity, {
        nowMs,
        ignoreSceneSessionCount: true,
      })
    ) {
      skipped.push({
        entityID,
        startupRuleID: String(controllerRecord.startupRuleID || "").trim() || null,
        operatorKind: String(controllerRecord.operatorKind || "").trim() || null,
      });
      continue;
    }

    const result = getNativeNpcService().dematerializeNativeController(liveController, {
      broadcast: options.broadcast === true,
      persistState: options.persistState !== false,
    });
    if (!result.success) {
      return result;
    }

    dematerialized.push({
      entityID,
      startupRuleID: String(controllerRecord.startupRuleID || "").trim() || null,
      operatorKind: String(controllerRecord.operatorKind || "").trim() || null,
      anchorID: toPositiveInt(controllerRecord.anchorID, 0),
      anchorClusterKey: getStartupControllerAnchorClusterKey(scene, controllerRecord),
      entityType: String(controllerRecord.entityType || "").trim().toLowerCase() || null,
    });
  }

  return {
    success: true,
    data: {
      dematerialized,
      dematerializedCount: dematerialized.length,
      skipped,
      skippedCount: skipped.length,
    },
  };
}

function syncRelevantStartupControllersForScene(scene, options = {}) {
  if (!scene) {
    return {
      success: false,
      errorMsg: "SCENE_NOT_FOUND",
    };
  }

  const relevantClusterKeys = collectRelevantPublicGridClusterKeys(scene, options);
  const ambientMaterializationResult =
    options.materializeAmbientStartup === false
      ? { success: true, data: { materialized: [], materializedCount: 0 } }
      : materializeRelevantAmbientControllers(scene, relevantClusterKeys, options);
  if (!ambientMaterializationResult.success) {
    return ambientMaterializationResult;
  }

  const combatMaterializationResult =
    options.materializeDormantCombat === false
      ? { success: true, data: { materialized: [], materializedCount: 0 } }
      : materializeRelevantCombatControllers(scene, relevantClusterKeys, options);
  if (!combatMaterializationResult.success) {
    return combatMaterializationResult;
  }

  const ambientDematerializationResult =
    options.dematerializeAmbientStartup === false
      ? {
          success: true,
          data: { dematerialized: [], dematerializedCount: 0, skipped: [], skippedCount: 0 },
        }
      : dematerializeIrrelevantAmbientControllers(scene, relevantClusterKeys, options);
  if (!ambientDematerializationResult.success) {
    return ambientDematerializationResult;
  }

  const combatDematerializationResult =
    options.dematerializeDormantCombat === false
      ? {
          success: true,
          data: { dematerialized: [], dematerializedCount: 0, skipped: [], skippedCount: 0 },
        }
      : dematerializeIrrelevantCombatControllers(scene, relevantClusterKeys, options);
  if (!combatDematerializationResult.success) {
    return combatDematerializationResult;
  }

  return {
    success: true,
    data: {
      relevantClusterKeys: [...relevantClusterKeys],
      ambient: {
        ...ambientMaterializationResult.data,
        ...ambientDematerializationResult.data,
      },
      combat: {
        ...combatMaterializationResult.data,
        ...combatDematerializationResult.data,
      },
    },
  };
}

function prewarmStartupControllersForWarpDestination(scene, options = {}) {
  if (!scene) {
    return {
      success: false,
      errorMsg: "SCENE_NOT_FOUND",
    };
  }

  if (!isAnchorRelevanceEnabled()) {
    return {
      success: true,
      data: {
        skipped: true,
        reason: "ANCHOR_RELEVANCE_DISABLED",
      },
    };
  }

  const relevanceOptions = {
    relevantClusterKeys: options.relevantClusterKeys,
    relevantEntities: options.relevantEntities,
    relevantPositions: options.relevantPositions,
  };
  if (!hasStartupAnchorRelevanceContext(scene, relevanceOptions)) {
    return {
      success: true,
      data: {
        skipped: true,
        reason: "NO_RELEVANCE_CONTEXT",
      },
    };
  }

  return syncRelevantStartupControllersForScene(scene, {
    broadcast: false,
    excludedSession: options.excludedSession || null,
    nowMs: options.nowMs,
    catchUpBehavior: true,
    relevantClusterKeys: relevanceOptions.relevantClusterKeys,
    relevantEntities: relevanceOptions.relevantEntities,
    relevantPositions: relevanceOptions.relevantPositions,
    materializeAmbientStartup: options.materializeAmbientStartup !== false,
    materializeDormantCombat: options.materializeDormantCombat !== false,
    dematerializeAmbientStartup: options.dematerializeAmbientStartup !== false,
    dematerializeDormantCombat: options.dematerializeDormantCombat !== false,
  });
}

module.exports = {
  isAnchorRelevanceEnabled,
  hasStartupAnchorRelevanceContext,
  collectRelevantPublicGridClusterKeys,
  getStartupControllerAnchorClusterKey,
  syncRelevantStartupControllersForScene,
  prewarmStartupControllersForWarpDestination,
};
