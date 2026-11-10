"use strict";

module.exports = {
  buildPendingReloadActivationSuccess,
  isPendingMissileReloadReactivation,
  queueCommandBurstReloadState,
  queueGroupedMissileReloadStates,
  resolvePendingGroupedMissileReloads,
};

const runtimeEntryDirname = require("path").resolve(__dirname, "..");
const path = require("path");
const {
  buildWeaponModuleSnapshot,
  isChargeOptionalTurretWeapon,
  isMissileWeaponFamily,
  isVortonWeaponFamily,
  isTurretCycleWeaponFamily,
  isDefenderMissileWeaponSnapshot,
  resolveWeaponFamily,
  resolveWeaponSpecialFxGUID,
} = require(path.join(runtimeEntryDirname, "./combat/weaponDogma"));
const {
  flushDogmaReloadsAtSimTime,
  queueAutomaticMissileReload,
  resolvePendingMissileReload,
} = require(path.join(runtimeEntryDirname, "./combat/missiles/missileReloads"));
const {
  queueAutomaticLocalModuleReload,
  resolvePendingLocalModuleReload,
} = require(path.join(runtimeEntryDirname, "./modules/localCycleReloads"));
const {
  ITEM_FLAGS,
} = require(path.join(runtimeEntryDirname, "../services/inventory/itemStore"));
const {
  getEntityRuntimeModuleItem,
} = require("./entityDogmaView");
const {
  getOwningSessionForEntity,
} = require("./entityOwnerSession");
const {
  resolveEffectiveModuleReloadTimeMs,
} = require("./moduleAttributes");
const {
  toFiniteNumber,
  toInt,
} = require("../../common/numbers");

function queueGroupedMissileReloadStates(
  scene,
  attackerEntity,
  effectState,
  moduleEntries,
  startedAtMs,
) {
  const ownerSession = getOwningSessionForEntity(scene, attackerEntity);
  const reloadStates = [];
  const seenModuleIDs = new Set();
  const groupedTargets = resolveGroupedMissileReloadTargets(
    ownerSession,
    attackerEntity,
    effectState,
    moduleEntries,
  );
  for (const entry of Array.isArray(moduleEntries) ? moduleEntries : []) {
    const candidateModuleItem = entry && entry.moduleItem ? entry.moduleItem : null;
    const candidateModuleID = toInt(
      candidateModuleItem && candidateModuleItem.itemID,
      0,
    );
    if (candidateModuleID <= 0 || seenModuleIDs.has(candidateModuleID)) {
      continue;
    }
    seenModuleIDs.add(candidateModuleID);
    const chargeTypeID = toInt(
      entry && entry.chargeItem && entry.chargeItem.typeID,
      toInt(effectState && effectState.chargeTypeID, 0),
    );
    if (chargeTypeID <= 0) {
      continue;
    }
    const targetQuantity = groupedTargets
      ? groupedTargets.get(candidateModuleID)
      : undefined;
    if (groupedTargets && !(targetQuantity > 0)) {
      continue;
    }
    const reloadResult = queueAutomaticMissileReload({
      session: ownerSession,
      entity: attackerEntity,
      moduleItem: candidateModuleItem,
      chargeTypeID,
      reloadTimeMs: Math.max(
        0,
        resolveEffectiveModuleReloadTimeMs(candidateModuleItem, attackerEntity),
      ),
      startedAtMs,
      shipID: toInt(attackerEntity && attackerEntity.itemID, 0),
      targetQuantity,
    });
    if (
      reloadResult.success &&
      reloadResult.data &&
      reloadResult.data.reloadState
    ) {
      reloadStates.push(reloadResult.data.reloadState);
    }
  }
  return reloadStates;
}

// A player's grouped launchers share the cargo out when the bank runs dry, as a
// manual group reload does, instead of the first launchers taking a full load
// each. Returns moduleID -> quantity to fill to (a launcher it cannot raise gets
// none), or null to leave every launcher on the plain fill-to-capacity.
function resolveGroupedMissileReloadTargets(session, attackerEntity, effectState, moduleEntries) {
  const entries = (Array.isArray(moduleEntries) ? moduleEntries : [])
    .filter((entry) => entry && entry.moduleItem);
  if (!session || entries.length <= 1 || (attackerEntity && attackerEntity.nativeNpc === true)) {
    return null;
  }
  const DogmaService = require(path.join(runtimeEntryDirname, "../services/dogma/dogmaService"));
  const dogma = new DogmaService();
  const shipID = toInt(attackerEntity && attackerEntity.itemID, 0);
  const inventoryOwnerID = dogma._getDogmaInventoryOwnerID(session, shipID);
  const entriesByChargeTypeID = new Map();
  for (const entry of entries) {
    const chargeTypeID = toInt(
      entry.chargeItem && entry.chargeItem.typeID,
      toInt(effectState && effectState.chargeTypeID, 0),
    );
    if (chargeTypeID <= 0) {
      continue;
    }
    if (!entriesByChargeTypeID.has(chargeTypeID)) {
      entriesByChargeTypeID.set(chargeTypeID, []);
    }
    entriesByChargeTypeID.get(chargeTypeID).push(entry.moduleItem);
  }
  const targets = new Map();
  for (const [chargeTypeID, moduleItems] of entriesByChargeTypeID) {
    const reserveQuantity = dogma
      ._resolvePendingReloadSourceStacks(inventoryOwnerID, shipID, ITEM_FLAGS.CARGO_HOLD, chargeTypeID)
      .reduce((sum, item) => sum + (Number(item.stacksize || item.quantity || 0) || 0), 0);
    const { level, heldQuantities } = dogma.resolveGroupedReloadLevel(
      moduleItems,
      chargeTypeID,
      reserveQuantity,
      inventoryOwnerID,
      shipID,
    );
    moduleItems.forEach((moduleItem, index) => {
      if (heldQuantities[index] < level) {
        targets.set(toInt(moduleItem.itemID, 0), level);
      }
    });
  }
  return targets;
}

function resolvePendingGroupedMissileReloads(
  entity,
  effectState,
  options = {},
) {
  const reloadStates = Array.isArray(effectState && effectState.pendingMissileBankReloads)
    ? effectState.pendingMissileBankReloads.filter(Boolean)
    : [];
  if (reloadStates.length <= 0) {
    return {
      success: true,
      waiting: false,
      data: {
        completed: false,
      },
    };
  }

  const nowMs = Math.max(0, Number(options.nowMs) || 0);
  for (const reloadState of reloadStates) {
    const completeAtMs = Math.max(0, Number(reloadState && reloadState.completeAtMs) || 0);
    if (completeAtMs > nowMs) {
      return {
        success: true,
        waiting: true,
        data: {
          reloadStates,
        },
      };
    }
  }

  for (const reloadState of reloadStates) {
    const moduleItem = getEntityRuntimeModuleItem(
      entity,
      toInt(reloadState && reloadState.moduleID, 0),
      toInt(reloadState && reloadState.moduleFlagID, 0),
    );
    if (!moduleItem) {
      return {
        success: false,
        errorMsg: "MODULE_NOT_FOUND",
      };
    }
    const individualEffectState = {
      pendingMissileReload: reloadState,
      chargeTypeID: toInt(effectState && effectState.chargeTypeID, 0),
    };
    const reloadResult = resolvePendingMissileReload(
      entity,
      individualEffectState,
      moduleItem,
      {
        nowMs,
      },
    );
    if (!reloadResult.success) {
      return reloadResult;
    }
  }

  effectState.pendingMissileBankReloads = null;
  effectState.chargeTypeID = toInt(
    reloadStates[0] && reloadStates[0].chargeTypeID,
    toInt(effectState && effectState.chargeTypeID, 0),
  );
  return {
    success: true,
    waiting: false,
    data: {
      completed: true,
      reloadStates,
    },
  };
}

function queueCommandBurstReloadState(
  scene,
  session,
  entity,
  moduleItem,
  effectState,
  nowMs,
) {
  if (!scene || !entity || !moduleItem || !effectState) {
    return null;
  }

  const chargeTypeID = toInt(effectState.chargeTypeID, 0);
  if (chargeTypeID <= 0) {
    return null;
  }

  const reloadResult = queueAutomaticLocalModuleReload({
    entity,
    scene,
    session: session || entity.session || null,
    moduleItem,
    chargeTypeID,
    reloadTimeMs: Math.max(
      0,
      toFiniteNumber(effectState.commandBurstReloadTimeMs, 0),
    ),
    startedAtMs: Math.max(0, toFiniteNumber(nowMs, 0)),
    resumeMode: "start",
  });
  if (!reloadResult || reloadResult.success !== true || !reloadResult.data) {
    return null;
  }
  return reloadResult.data.reloadState || null;
}

function isPendingMissileReloadReactivation(effectState, nowMs = 0) {
  if (!effectState || !isMissileWeaponFamily(effectState.weaponFamily)) {
    return false;
  }
  const pendingReloads = [];
  if (effectState.pendingMissileReload) {
    pendingReloads.push(effectState.pendingMissileReload);
  }
  if (Array.isArray(effectState.pendingMissileBankReloads)) {
    pendingReloads.push(...effectState.pendingMissileBankReloads.filter(Boolean));
  }
  if (pendingReloads.length <= 0) {
    return false;
  }
  if (effectState.pendingReloadReactivation === true) {
    return true;
  }
  const now = Math.max(0, toFiniteNumber(nowMs, 0));
  return pendingReloads.some((reloadState) => (
    Math.max(0, toFiniteNumber(reloadState && reloadState.completeAtMs, 0)) > now
  ));
}

function buildPendingReloadActivationSuccess(entity, effectState) {
  return {
    success: true,
    data: {
      entity,
      effectState,
      alreadyActive: true,
      pending: true,
      pendingReloadReactivation: true,
    },
  };
}
