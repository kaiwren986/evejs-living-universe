"use strict";

const {
  toNumber,
} = require("../../common/numbers");

const path = require("path");

const {
  findItemById,
  listSystemSpaceItems,
  updateInventoryItemsAtomic,
} = require(path.join(__dirname, "../inventory/itemStore"));
const { TABLE, readStaticTable } = require(path.join(
  __dirname,
  "../_shared/referenceData",
));

const CATEGORY_STARBASE = 23;
const GROUP_CONTROL_TOWER = 365;
const ATTRIBUTE_POWER_OUTPUT = 11;
const ATTRIBUTE_POWER_USAGE = 30;
const ATTRIBUTE_CPU_OUTPUT = 48;
const ATTRIBUTE_CPU_USAGE = 50;

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function round6(value) {
  return Math.round(toNumber(value, 0) * 1e6) / 1e6;
}

function getDogmaAttribute(typeID, attributeID, fallback = 0) {
  const dogma = readStaticTable(TABLE.TYPE_DOGMA) || {};
  const record = dogma.typesByTypeID && dogma.typesByTypeID[String(toInt(typeID, 0))];
  const value = record && record.attributes && record.attributes[String(attributeID)];
  return toNumber(value, fallback);
}

function isControlTower(item) {
  return Boolean(
    item &&
    toInt(item.categoryID, 0) === CATEGORY_STARBASE &&
    toInt(item.groupID, 0) === GROUP_CONTROL_TOWER,
  );
}

function isStarbaseModule(item) {
  return Boolean(
    item &&
    toInt(item.categoryID, 0) === CATEGORY_STARBASE &&
    toInt(item.groupID, 0) !== GROUP_CONTROL_TOWER,
  );
}

function getModuleControlTowerID(item) {
  return toInt(
    item && item.spaceState && item.spaceState.controlTowerID,
    toInt(item && item.controlTowerID, 0),
  );
}

function getStarbaseResourceProfile(item) {
  if (!item || toInt(item.categoryID, 0) !== CATEGORY_STARBASE) {
    return null;
  }
  if (isControlTower(item)) {
    return {
      itemID: toInt(item.itemID, 0),
      typeID: toInt(item.typeID, 0),
      cpuOutput: require("./starbaseReinforcementRuntime").isReinforced(item)
        ? 0 : Math.max(0, getDogmaAttribute(item.typeID, ATTRIBUTE_CPU_OUTPUT, 0)),
      powergridOutput: Math.max(
        0,
        getDogmaAttribute(item.typeID, ATTRIBUTE_POWER_OUTPUT, 0),
      ),
      cpuUsage: 0,
      powergridUsage: 0,
    };
  }
  return {
    itemID: toInt(item.itemID, 0),
    typeID: toInt(item.typeID, 0),
    cpuOutput: 0,
    powergridOutput: 0,
    // Starbase structures use the legacy `cpu` and `power` attributes (50/30),
    // not ship fitting's runtime cpuLoad/powerLoad attributes (49/15).
    cpuUsage: Math.max(0, getDogmaAttribute(item.typeID, ATTRIBUTE_CPU_USAGE, 0)),
    powergridUsage: Math.max(
      0,
      getDogmaAttribute(item.typeID, ATTRIBUTE_POWER_USAGE, 0),
    ),
  };
}

function isModuleResourceActive(item) {
  const state = item && item.spaceState || {};
  return Boolean(
    isStarbaseModule(item) &&
    String(state.anchorState || "").toLowerCase() === "anchored" &&
    String(state.onlineState || "").toLowerCase() === "online" &&
    toInt(state.online, 0) === 1 &&
    getModuleControlTowerID(item) > 0,
  );
}

function isModuleResourceCommitted(item) {
  const state = item && item.spaceState || {};
  const onlineState = String(state.onlineState || "").toLowerCase();
  return Boolean(
    isStarbaseModule(item) &&
    String(state.anchorState || "").toLowerCase() === "anchored" &&
    (onlineState === "onlining" || isModuleResourceActive(item)) &&
    getModuleControlTowerID(item) > 0,
  );
}

function listTowerModules(towerOrID) {
  const tower = towerOrID && typeof towerOrID === "object"
    ? towerOrID
    : findItemById(toInt(towerOrID, 0));
  if (!isControlTower(tower)) {
    return [];
  }
  const systemID = toInt(
    tower.spaceState && tower.spaceState.systemID,
    toInt(tower.locationID, 0),
  );
  return listSystemSpaceItems(systemID)
    .filter((item) => (
      isStarbaseModule(item) &&
      getModuleControlTowerID(item) === toInt(tower.itemID, 0)
    ))
    .sort((left, right) => toInt(left.itemID, 0) - toInt(right.itemID, 0));
}

function getControlTowerResourceState(towerOrID, options = {}) {
  const tower = towerOrID && typeof towerOrID === "object"
    ? towerOrID
    : findItemById(toInt(towerOrID, 0));
  if (!isControlTower(tower)) {
    return null;
  }
  const towerProfile = getStarbaseResourceProfile(tower);
  const excludedItemID = toInt(options.excludeItemID, 0);
  const resourcePredicate = options.includeOnlining === false
    ? isModuleResourceActive
    : isModuleResourceCommitted;
  const modules = listTowerModules(tower)
    .filter((item) => toInt(item.itemID, 0) !== excludedItemID)
    .filter(resourcePredicate);
  if (options.includeModule && isStarbaseModule(options.includeModule)) {
    modules.push(options.includeModule);
  }
  const moduleProfiles = modules.map((item) => ({
    ...getStarbaseResourceProfile(item),
    groupID: toInt(item.groupID, 0),
  }));
  const cpuUsed = round6(moduleProfiles.reduce(
    (total, profile) => total + profile.cpuUsage,
    0,
  ));
  const powergridUsed = round6(moduleProfiles.reduce(
    (total, profile) => total + profile.powergridUsage,
    0,
  ));
  return {
    towerID: toInt(tower.itemID, 0),
    cpuOutput: round6(towerProfile.cpuOutput),
    cpuUsed,
    cpuAvailable: round6(towerProfile.cpuOutput - cpuUsed),
    powergridOutput: round6(towerProfile.powergridOutput),
    powergridUsed,
    powergridAvailable: round6(towerProfile.powergridOutput - powergridUsed),
    modules: moduleProfiles,
  };
}

function validateModuleResources(towerOrID, moduleItem) {
  if (!isStarbaseModule(moduleItem)) {
    return { success: false, errorMsg: "ITEM_NOT_STARBASE_MODULE" };
  }
  const tower = towerOrID && typeof towerOrID === "object"
    ? towerOrID
    : findItemById(toInt(towerOrID, 0));
  if (!isControlTower(tower)) {
    return { success: false, errorMsg: "CONTROL_TOWER_NOT_FOUND" };
  }
  const resourceState = getControlTowerResourceState(tower, {
    excludeItemID: moduleItem.itemID,
    includeModule: moduleItem,
  });
  const candidateProfile = getStarbaseResourceProfile(moduleItem);
  const requiredCpu = round6(candidateProfile.cpuUsage);
  const requiredPowergrid = round6(candidateProfile.powergridUsage);
  const availableCpu = round6(
    resourceState.cpuOutput - (resourceState.cpuUsed - requiredCpu),
  );
  const availablePowergrid = round6(
    resourceState.powergridOutput -
      (resourceState.powergridUsed - requiredPowergrid),
  );
  const validationData = {
    ...resourceState,
    requiredCpu,
    requiredPowergrid,
    availableCpu,
    availablePowergrid,
  };
  if (resourceState.cpuUsed > resourceState.cpuOutput + 0.000001) {
    return {
      success: false,
      errorMsg: "STARBASE_CPU_INSUFFICIENT",
      data: validationData,
    };
  }
  if (resourceState.powergridUsed > resourceState.powergridOutput + 0.000001) {
    return {
      success: false,
      errorMsg: "STARBASE_POWERGRID_INSUFFICIENT",
      data: validationData,
    };
  }
  return { success: true, data: validationData };
}

function refreshModulePresentations(items, options = {}) {
  for (const item of Array.isArray(items) ? items : []) require("./starbaseTravelRuntime").notifyInfrastructureChanged(item);
  if (options.refreshPresentation === false) {
    return { attempted: 0, refreshed: 0 };
  }
  const runtime = require(path.join(__dirname, "../../space/runtime"));
  let attempted = 0;
  let refreshed = 0;
  for (const item of Array.isArray(items) ? items : []) {
    const systemID = toInt(
      item && item.spaceState && item.spaceState.systemID,
      toInt(item && item.locationID, 0),
    );
    const scene = systemID > 0
      ? runtime.getSceneByDescriptor(systemID)
      : null;
    if (!scene || !scene.getEntityByID(item.itemID)) {
      continue;
    }
    attempted += 1;
    const result = scene.refreshInventoryBackedEntityPresentation(item.itemID, {
      broadcast: options.broadcast !== false,
    });
    if (result && result.success === true) {
      refreshed += 1;
    }
  }
  return { attempted, refreshed };
}

function deactivateTowerModules(towerOrID, options = {}) {
  const tower = towerOrID && typeof towerOrID === "object"
    ? towerOrID
    : findItemById(toInt(towerOrID, 0));
  if (!isControlTower(tower)) {
    return { success: false, errorMsg: "CONTROL_TOWER_NOT_FOUND" };
  }
  const modules = listTowerModules(tower).filter((item) => {
    const state = item.spaceState || {};
    return String(state.onlineState || "").toLowerCase() !== "offline" ||
      toInt(state.online, 0) !== 0;
  });
  if (modules.length === 0) {
    return { success: true, data: { items: [], changes: [] }, changed: false };
  }
  const reason = String(options.reason || "controlTowerOffline");
  const nowMs = Math.max(0, toInt(options.nowMs, Date.now()));
  const result = updateInventoryItemsAtomic(
    modules.map((item) => item.itemID),
    (item) => ({
      ...item,
      spaceState: {
        ...(item.spaceState || {}),
        onlineState: "offline",
        online: 0,
        onlineStartedAtMs: null,
        onlineCompletesAtMs: null,
        starbaseDisabledReason: reason,
        starbaseDisabledAtMs: nowMs,
      },
    }),
  );
  if (!result.success) {
    return result;
  }
  return {
    ...result,
    changed: true,
    presentation: refreshModulePresentations(result.data.items, options),
  };
}

module.exports = {
  CATEGORY_STARBASE,
  GROUP_CONTROL_TOWER,
  ATTRIBUTE_POWER_OUTPUT,
  ATTRIBUTE_POWER_USAGE,
  ATTRIBUTE_CPU_OUTPUT,
  ATTRIBUTE_CPU_USAGE,
  isControlTower,
  isStarbaseModule,
  getModuleControlTowerID,
  getStarbaseResourceProfile,
  isModuleResourceActive,
  isModuleResourceCommitted,
  listTowerModules,
  getControlTowerResourceState,
  validateModuleResources,
  deactivateTowerModules,
};
