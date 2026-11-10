"use strict";

module.exports = {
  applyDamageToFighterSquadronSafe,
  getDroneCategoryID,
  getDroneRuntimeService,
  getFighterCategoryID,
  getFighterRuntimeService,
  handleDroneControllerLostSafe,
  handleDroneDestroyedSafe,
  handleFighterControllerLostSafe,
  handleFighterDestroyedSafe,
  handleFighterPostDamageSafe,
  hydrateDroneEntityFromInventoryItem,
  hydrateFighterEntityFromInventoryItem,
  queueControlledFightersReturnToTubesSafe,
};

const {
  toInt,
} = require("../../common/numbers");
const {
  lazyRequire,
} = require("./runtimeModuleBoundary");

function getDroneRuntimeService() {
  return lazyRequire("../services/drone/droneRuntime");
}

function getFighterRuntimeService() {
  return lazyRequire("../services/fighter/fighterRuntime");
}

function getDroneCategoryID() {
  const droneRuntime = getDroneRuntimeService();
  return toInt(droneRuntime && droneRuntime.DRONE_CATEGORY_ID, 18) || 18;
}

function getFighterCategoryID() {
  const fighterRuntime = getFighterRuntimeService();
  return toInt(fighterRuntime && fighterRuntime.FIGHTER_CATEGORY_ID, 87) || 87;
}

function hydrateDroneEntityFromInventoryItem(entity, itemRecord) {
  const droneRuntime = getDroneRuntimeService();
  if (droneRuntime && typeof droneRuntime.hydrateDroneEntityFromItem === "function") {
    return droneRuntime.hydrateDroneEntityFromItem(entity, itemRecord);
  }
  return entity;
}

function hydrateFighterEntityFromInventoryItem(entity, itemRecord, options = {}) {
  const fighterRuntime = getFighterRuntimeService();
  if (fighterRuntime && typeof fighterRuntime.hydrateFighterEntityFromItem === "function") {
    return fighterRuntime.hydrateFighterEntityFromItem(entity, itemRecord, options);
  }
  return entity;
}

function applyDamageToFighterSquadronSafe(scene, fighterEntity, rawDamage, whenMs = null) {
  const fighterRuntime = getFighterRuntimeService();
  if (fighterRuntime && typeof fighterRuntime.applyDamageToFighterSquadron === "function") {
    return fighterRuntime.applyDamageToFighterSquadron(
      scene,
      fighterEntity,
      rawDamage,
      whenMs,
    );
  }
  return null;
}

function handleFighterPostDamageSafe(scene, fighterEntity, damageResult, options = {}) {
  const fighterRuntime = getFighterRuntimeService();
  if (fighterRuntime && typeof fighterRuntime.handleFighterPostDamage === "function") {
    return fighterRuntime.handleFighterPostDamage(
      scene,
      fighterEntity,
      damageResult,
      options,
    );
  }
  return false;
}

function handleFighterDestroyedSafe(scene, fighterEntity) {
  const fighterRuntime = getFighterRuntimeService();
  if (fighterRuntime && typeof fighterRuntime.handleFighterDestroyed === "function") {
    return fighterRuntime.handleFighterDestroyed(scene, fighterEntity);
  }
  return false;
}

function handleDroneDestroyedSafe(scene, droneEntity) {
  const droneRuntime = getDroneRuntimeService();
  if (droneRuntime && typeof droneRuntime.handleDroneDestroyed === "function") {
    return droneRuntime.handleDroneDestroyed(scene, droneEntity);
  }
  return false;
}

function handleDroneControllerLostSafe(scene, controllerEntity, options = {}) {
  const droneRuntime = getDroneRuntimeService();
  if (droneRuntime && typeof droneRuntime.handleControllerLost === "function") {
    return droneRuntime.handleControllerLost(scene, controllerEntity, options);
  }
  return {
    success: false,
    releasedCount: 0,
    recoveredCount: 0,
  };
}

function handleFighterControllerLostSafe(scene, controllerEntity, options = {}) {
  const fighterRuntime = getFighterRuntimeService();
  if (fighterRuntime && typeof fighterRuntime.handleControllerLost === "function") {
    return fighterRuntime.handleControllerLost(scene, controllerEntity, options);
  }
  return {
    success: false,
    releasedCount: 0,
    recoveredCount: 0,
  };
}

function queueControlledFightersReturnToTubesSafe(
  scene,
  controllerEntity,
  options = {},
) {
  const fighterRuntime = getFighterRuntimeService();
  if (
    !fighterRuntime ||
    typeof fighterRuntime.queueControlledFightersReturnToTubes !== "function"
  ) {
    return {
      success: false,
      queuedCount: 0,
      errorMsg: "FIGHTER_RUNTIME_NOT_AVAILABLE",
    };
  }
  try {
    return fighterRuntime.queueControlledFightersReturnToTubes(
      scene,
      controllerEntity,
      options,
    );
  } catch (error) {
    return {
      success: false,
      queuedCount: 0,
      errorMsg: error && error.message
        ? error.message
        : "FIGHTER_RECALL_FAILED",
    };
  }
}
