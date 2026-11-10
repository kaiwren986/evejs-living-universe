"use strict";

module.exports = {
  buildAssistanceModuleRuntimeCallbacks,
  buildBombRuntimeCallbacks,
  buildDefenderRuntimeCallbacks,
  buildAutoTargetingRuntimeCallbacks,
  buildHostileModuleRuntimeCallbacks,
  buildJammerModuleRuntimeCallbacks,
  buildLocalCycleRuntimeCallbacks,
  buildMicroJumpDriveRuntimeCallbacks,
  buildPointDefenseRuntimeCallbacks,
  buildSalvagerRuntimeCallbacks,
  buildScannerRuntimeCallbacks,
  buildSmartbombRuntimeCallbacks,
  buildSuperweaponRuntimeCallbacks,
  buildTractorBeamRuntimeCallbacks,
  listScannableEntityInventoryItems,
  recordAreaDamageKillmailOutcome,
};

const runtimeEntryDirname = require("path").resolve(__dirname, "..");
const path = require("path");
const syncLedger = require(path.join(runtimeEntryDirname, "../network/syncLedger"));
const log = require(path.join(runtimeEntryDirname, "../utils/logger"));
const commonRandom = require(path.join(runtimeEntryDirname, "../common/random"));
const {
  CAPSULE_TYPE_ID,
  CAPSULE_TYPE_ID_GOLDEN,
  ITEM_FLAGS,
  updateShipItem,
  updateInventoryItem,
  removeInventoryItem,
  getShipConditionState,
  normalizeShipConditionState,
  getItemMetadata,
  pruneExpiredSpaceItems,
} = require(path.join(runtimeEntryDirname, "../services/inventory/itemStore"));
const {
  findItemById,
  findShipItemById,
  listContainerItems,
  listSystemSpaceItems,
  warmSimulationInventoryProjection,
} = require(path.join(
  runtimeEntryDirname,
  "../services/inventory/simulationInventoryProjection",
));
const {
  canEntitiesInteractLocally,
  isSharedPveTarget,
  resolveEntityInteractionScope,
} = require(path.join(runtimeEntryDirname, "./destiny/identity/interactionScope.js"));
const {
  getFittedModuleItems,
  listFittedItemsForLocation,
  buildSlimModuleTuples,
  buildCharacterTargetingState,
  buildChargeTupleItemID,
  buildShipResourceState,
  SLOT_FAMILY_FLAGS,
  getAttributeIDByNames,
  getEffectIDByNames,
  getTypeDogmaAttributes,
  getTypeDogmaEffects,
  getTypeEffectRecords,
  getPassiveModifierEffectRecords,
  getTypeAttributeValue,
  getEffectTypeRecord,
  getRequiredSkillRequirements,
  getLoadedChargeByFlag,
  isChargeCompatibleWithModule,
  isModuleOnline,
  isStructureDogmaHost,
  resolveDogmaSkillMapForHost,
  appendDirectModifierEntries,
  buildEffectiveItemAttributeMap,
  indexOverloadEffectRecordsByModuleID,
  buildProjectedModuleSourceAttributeMap,
} = require(path.join(runtimeEntryDirname, "../services/fitting/liveFittingState"));
const {
  isNativeNpcEntity,
  getNpcFittedModuleItems,
  getNpcLoadedChargeForModule,
  getNpcWeaponModules,
  buildNpcWeaponModuleSnapshot,
  getNpcHostileModules,
  getNpcAssistanceModules,
  getNpcSelfModules,
  getNpcSuperweaponModules,
  getNpcPropulsionModules,
} = require(path.join(runtimeEntryDirname, "./npc/npcEquipment"));
const nativeNpcStore = require(path.join(runtimeEntryDirname, "./npc/nativeNpcStore"));
const commandBurstRuntime = require(path.join(
  runtimeEntryDirname,
  "./modules/commandBurstRuntime",
));
const hudIconRuntime = require(path.join(
  runtimeEntryDirname,
  "./modules/hudIconRuntime",
));
const hostileModuleRuntime = require(path.join(
  runtimeEntryDirname,
  "./modules/hostileModuleRuntime",
));
const jammerModuleRuntime = require(path.join(
  runtimeEntryDirname,
  "./modules/jammerModuleRuntime",
));
const worldData = require(path.join(runtimeEntryDirname, "./worldData"));
const {
  applyDamageToEntity,
  applyResolvedDamageAmountToEntity,
  buildLiveDamageState,
  hasDamageableHealth,
  getEntityCurrentHealthLayers,
  getEntityMaxHealthLayers,
  sumDamageVector,
} = require(path.join(runtimeEntryDirname, "./combat/damage"));
const {
  noteDamage: noteKillmailDamage,
  resolveHighestDamageAttacker,
  enqueueKillmailFromDestruction: recordKillmailFromDestruction,
  recoverPendingKillmailWork,
} = require(path.join(runtimeEntryDirname, "./combat/killmailTracker"));
const {
  notifyCapacitorChangeToSession,
} = require("./attributeChangeNotification");
const {
  syncInventoryChangesToSession,
} = require("./characterStateBridge");
const {
  getAppliedDamageAmount,
  notifyWeaponDamageMessages,
} = require("./combatDamageMessages");
const {
  evaluateCrimewatchOffensiveAggression,
  recordCrimewatchOffensiveAggression,
} = require("./crimewatchAdapter");
const {
  isReadyForDestiny,
} = require("./destinyDeliveryEligibility");
const {
  getEntityCapacitorAmount,
  persistEntityCapacitorRatio,
  setEntityCapacitorRatio,
} = require("./entityCapacitor");
const {
  getEntityCenterDistance,
  getEntitySurfaceDistance,
} = require("./entityDistance");
const {
  getEntityRuntimeActiveModuleContexts,
  getEntityRuntimeFittedItems,
  getEntityRuntimeLoadedCharge,
  getEntityRuntimeModuleItem,
  getEntityRuntimeShipItem,
  getEntityRuntimeSkillMap,
  getShipEntityInventoryCharacterID,
} = require("./entityDogmaView");
const {
  getOwningSessionForEntity,
} = require("./entityOwnerSession");
const {
  persistDynamicEntity,
} = require("./entitySpacePersistence");
const {
  buildHostileHudState,
  buildJammerHudState,
  notifyHostileHudStateToSession,
} = require("./hudIconStates");
const {
  sessionHasInventoryLootRight,
} = require("./inventoryLootRights");
const {
  buildRuntimeSpaceEntityFromItem,
} = require("./inventorySpaceEntity");
const {
  consumeTurretAmmoCharge,
  notifyRuntimeChargeTransitionToSession,
} = require("./loadedChargeState");
const {
  applyPostMicroJumpWarpScramble,
  isCapitalClassShipEntity,
  isEntityMicroJumpDriveBlocked,
} = require("./microJumpDriveEligibility");
const {
  toFiniteNumber,
  toInt,
} = require("../../common/numbers");
const {
  allocateRuntimeEntityID,
} = require("./runtimeEntityIdentity");
const {
  lazyRequire,
} = require("./runtimeModuleBoundary");
const {
  broadcastDamageStateChange,
  buildShipHealthTransitionResult,
  notifyShipHealthAttributesToSession,
} = require("./shipHealthState");
const {
  getCurrentAlignmentDirection,
} = require("./shipMotionKinematics");
const {
  getControlledStaticStructureDogmaHosts,
} = require("./structureSessionHost");
const {
  breakEntityStructureTether,
} = require("./structureTether");
const {
  getSystemSecurityClass,
} = require("./systemSecurityBand");
const {
  applyWeaponDamageToTarget,
} = require("./targetDamageApplication");
const {
  isEntityLockedTarget,
} = require("./targeting");
const {
  addVectors,
  scaleVector,
} = require("../../common/vector");

const INVENTORY_FLAG_CARGO_HOLD = 5;

function buildLocalCycleRuntimeCallbacks(fallbackCharacterID = 0) {
  return {
    resolveCharacterID(entity) {
      return getShipEntityInventoryCharacterID(entity, fallbackCharacterID);
    },
    getEntityRuntimeShipItem,
    getEntityRuntimeFittedItems,
    getEntityRuntimeActiveModuleContexts,
    getEntityRuntimeLoadedCharge,
    getEntityRuntimeDirectModifierEntriesForItem(entity, targetItem, nowMs = null) {
      const fallbackNowMs =
        entity && entity.session && entity.session._space
          ? toFiniteNumber(entity.session._space.simTimeMs, Date.now())
          : Date.now();
      return commandBurstRuntime.collectModifierEntriesForItem(
        entity,
        targetItem,
        nowMs == null ? fallbackNowMs : toFiniteNumber(nowMs, fallbackNowMs),
      );
    },
    getEntityCapacitorAmount,
    setEntityCapacitorRatio,
    notifyCapacitorChangeToSession,
    buildShipHealthTransitionResult,
    notifyShipHealthAttributesToSession,
    broadcastDamageStateChange,
    persistDynamicEntity,
    notifyRuntimeChargeTransitionToSession,
  };
}

function buildAssistanceModuleRuntimeCallbacks(scene = null) {
  return {
    isEntityLockedTarget,
    // Ancillary remote repairers burn a charge per cycle, so the cycle needs to
    // reach the fitted module and whatever is loaded in it.
    getEntityRuntimeModuleItem,
    getEntityRuntimeLoadedCharge,
    getEntitySurfaceDistance(sourceEntity, targetEntity) {
      return getEntitySurfaceDistance(sourceEntity, targetEntity);
    },
    getEntityCapacitorAmount,
    setEntityCapacitorRatio,
    notifyCapacitorChangeToSession,
    normalizeShipConditionState,
    buildShipHealthTransitionResult,
    notifyShipHealthAttributesToSession,
    broadcastDamageStateChange,
    persistDynamicEntity,
  };
}

function buildHostileModuleRuntimeCallbacks(scene = null) {
  return {
    random() {
      return scene && typeof scene.__hostileRandom === "function"
        ? Number(scene.__hostileRandom()) || 0
        : commonRandom.random();
    },
    getEntityByID(entityID) {
      return scene && typeof scene.getEntityByID === "function"
        ? scene.getEntityByID(entityID)
        : null;
    },
    isEntityLockedTarget,
    getEntitySurfaceDistance(sourceEntity, targetEntity) {
      return getEntitySurfaceDistance(sourceEntity, targetEntity);
    },
    getEntityCapacitorAmount,
    setEntityCapacitorRatio,
    persistEntityCapacitorRatio,
    notifyCapacitorChangeToSession,
  };
}

function buildJammerModuleRuntimeCallbacks(scene = null) {
  return {
    getEntityByID(entityID) {
      return scene && typeof scene.getEntityByID === "function"
        ? scene.getEntityByID(entityID)
        : null;
    },
    isEntityLockedTarget,
    getEntitySurfaceDistance(sourceEntity, targetEntity) {
      return getEntitySurfaceDistance(sourceEntity, targetEntity);
    },
    clearOutgoingTargetLocksExcept(targetEntity, allowedTargetIDs, options = {}) {
      return scene && typeof scene.clearOutgoingTargetLocksExcept === "function"
        ? scene.clearOutgoingTargetLocksExcept(targetEntity, allowedTargetIDs, options)
        : {
          clearedTargetIDs: [],
          cancelledPendingIDs: [],
        };
    },
    random() {
      return scene && typeof scene.__jammerRandom === "function"
        ? Number(scene.__jammerRandom()) || 0
        : commonRandom.random();
    },
    recordOffensiveAggression(attackerEntity, targetEntity, nowMs) {
      return recordCrimewatchOffensiveAggression(
        scene,
        attackerEntity,
        targetEntity,
        nowMs,
      );
    },
  };
}

function buildDefenderRuntimeCallbacks(scene) {
  const custody = buildBombRuntimeCallbacks(scene);
  return {
    consumeLoadedCharge: custody.consumeLoadedCharge,
    publishProjectile: custody.publishBomb,
    warn(message, error) { log.warn(`[Defender] ${message}: ${error.message}`); },
  };
}

function buildBombRuntimeCallbacks(scene, options = {}) {
  return {
    allocateEntityID: allocateRuntimeEntityID,
    hasCurrentSourceOwner(entity) {
      return entity.nativeNpc === true || Boolean(getOwningSessionForEntity(scene, entity));
    },
    consumeLoadedCharge(entity, moduleItem, chargeItem, nowMs) {
      const before = toInt(chargeItem.stacksize ?? chargeItem.quantity, 0);
      try {
        return consumeTurretAmmoCharge(entity, moduleItem, chargeItem, nowMs, 1);
      } catch (error) {
        // A client delivery error may follow the committed quantity update.
        // Resolve current custody before deciding whether admission failed.
        const current = getEntityRuntimeLoadedCharge(entity, moduleItem);
        const after = current ? toInt(current.stacksize ?? current.quantity, 0) : 0;
        log.warn(`[Bomb] Charge delivery failed: ${error.message}`);
        return after === before - 1
          ? { success: true, data: { nextQuantity: after, deliveryFailed: true } }
          : { success: false, errorMsg: "AMMO_UPDATE_FAILED" };
      }
    },
    publishBomb(bomb) {
      scene.broadcastAddBalls([bomb], null, { freshAcquire: true });
    },
    recordLaunch(entity, nowMs) {
      try {
        lazyRequire("../services/security/crimewatchState").recordWeaponTimer(scene, entity, nowMs);
      } catch (error) { log.warn(`[Bomb] Weapon timer failed: ${error.message}`); }
    },
    recordAggression(attacker, target, nowMs) {
      return recordCrimewatchOffensiveAggression(scene, attacker, target, nowMs);
    },
    applyDamage(attacker, target, moduleItem, chargeItem, damage, nowMs) {
      const result = applyWeaponDamageToTarget(scene, attacker, target, damage, nowMs,
        { alignLethalDamageToDestruction: true, action: "bomb" });
      if (target.kind !== "missile") {
        recordAreaDamageKillmailOutcome(attacker, target, moduleItem, damage, result, nowMs, chargeItem);
      }
      // Launch attribution remains immutable. A delayed companion hit may
      // resolve its original pilot's current transport solely for feedback.
      const notificationSource = typeof options.resolveAttackerNotificationSession === "function"
        ? { ...attacker, session: options.resolveAttackerNotificationSession(attacker) }
        : attacker;
      notifyWeaponDamageMessages(notificationSource, target, moduleItem, damage,
        getAppliedDamageAmount(result?.damageResult), sumDamageVector(damage) > 0 ? 3 : 0);
      return result;
    },
    neutralize(target, amount, nowMs) {
      const previous = getEntityCapacitorAmount(target);
      const capacity = Math.max(0, toFiniteNumber(target.capacitorCapacity, 0));
      if (!(amount > 0) || !(capacity > 0)) return;
      setEntityCapacitorRatio(target, Math.max(0, previous - amount) / capacity);
      persistEntityCapacitorRatio(target);
      notifyCapacitorChangeToSession(getOwningSessionForEntity(scene, target), target, nowMs, previous);
    },
    clearLocks(target) {
      return scene.clearOutgoingTargetLocks(target, { notifySelf: true, notifyTarget: true,
        activeReason: "target", pendingReason: "target" });
    },
    random: buildJammerModuleRuntimeCallbacks(scene).random,
    warn(message, error) { log.warn(`[Bomb] ${message}: ${error.message}`); },
  };
}

function buildSmartbombRuntimeCallbacks(scene = null) {
  return {
    listDamageableEntitiesInSmartbombRange(sourceEntity, rangeMeters) {
      if (
        !scene ||
        !(scene.dynamicEntities instanceof Map) ||
        !sourceEntity ||
        !Number.isFinite(Number(rangeMeters)) ||
        Number(rangeMeters) < 0
      ) {
        return [];
      }
      const inRange = [];
      for (const candidate of scene.dynamicEntities.values()) {
        if (
          candidate &&
          toInt(candidate.itemID, 0) !== toInt(sourceEntity.itemID, 0) &&
          hasDamageableHealth(candidate) &&
          getEntitySurfaceDistance(sourceEntity, candidate) <= Number(rangeMeters) + 1e-6
        ) {
          inRange.push(candidate);
        }
      }
      return inRange;
    },
    applySmartbombDamage(attackerEntity, targetEntity, moduleItem, damageVector, whenMs) {
      const result = applyWeaponDamageToTarget(
        scene,
        attackerEntity,
        targetEntity,
        damageVector,
        whenMs,
        {fabricatorDamageKind:"smartbomb", incursionWeaponKind: "smartbomb"},
      );
      recordAreaDamageKillmailOutcome(
        attackerEntity,
        targetEntity,
        moduleItem,
        damageVector,
        result,
        whenMs,
      );
      notifyWeaponDamageMessages(
        attackerEntity,
        targetEntity,
        moduleItem,
        damageVector,
        getAppliedDamageAmount(result && result.damageResult),
        sumDamageVector(damageVector) > 0 ? 3 : 0,
      );
      return result;
    },
    evaluateOffensiveAggression(attackerEntity, targetEntity, nowMs) {
      return evaluateCrimewatchOffensiveAggression(
        scene,
        attackerEntity,
        targetEntity,
        nowMs,
      );
    },
    recordOffensiveAggression(attackerEntity, targetEntity, nowMs) {
      return recordCrimewatchOffensiveAggression(
        scene,
        attackerEntity,
        targetEntity,
        nowMs,
      );
    },
  };
}

function buildAutoTargetingRuntimeCallbacks(scene = null) {
  return {
    // Hostiles worth answering are the ones already pointed at this ship. Skip
    // anything the ship is holding or acquiring so a cycle never spends a lock
    // slot re-acquiring a target it already has.
    listAutoTargetCandidates(sourceEntity, rangeMeters) {
      if (!scene || !sourceEntity || !Number.isFinite(Number(rangeMeters))) {
        return [];
      }
      const lockedTargets =
        sourceEntity.lockedTargets instanceof Map ? sourceEntity.lockedTargets : new Map();
      const pendingLocks =
        sourceEntity.pendingTargetLocks instanceof Map
          ? sourceEntity.pendingTargetLocks
          : new Map();
      const candidates = [];
      for (const targeterID of scene.getTargetersForEntity(sourceEntity)) {
        if (lockedTargets.has(targeterID) || pendingLocks.has(targeterID)) {
          continue;
        }
        const candidate = scene.getEntityByID(targeterID);
        if (
          !candidate ||
          !canEntitiesInteractLocally(sourceEntity, candidate) ||
          getEntitySurfaceDistance(sourceEntity, candidate) >
            Number(rangeMeters) + 1e-6
        ) {
          continue;
        }
        candidates.push(candidate);
      }
      return candidates;
    },
    acquireAutoTarget(sourceEntity, targetEntity, nowMs) {
      if (!scene || !sourceEntity || !targetEntity) {
        return false;
      }
      // Route through the ordinary lock request so capacity, scan resolution,
      // dungeon scope, cloaks and tethers all apply exactly as they would to a
      // lock the player asked for by hand.
      const result = scene.requestAutoTargetLock(sourceEntity, targetEntity, { nowMs });
      return Boolean(result && result.success);
    },
  };
}

function recordAreaDamageKillmailOutcome(
  attackerEntity,
  targetEntity,
  moduleItem,
  damageVector,
  weaponDamageResult,
  whenMs,
  chargeItem = null,
) {
  const damageResult = weaponDamageResult && weaponDamageResult.damageResult;
  const appliedDamageAmount = getAppliedDamageAmount(damageResult);
  if (appliedDamageAmount > 0) {
    noteKillmailDamage(attackerEntity, targetEntity, appliedDamageAmount, {
      whenMs,
      weaponSnapshot: {
        moduleTypeID: toInt(moduleItem && moduleItem.typeID, 0) || null,
        rawShotDamage: damageVector,
      },
      moduleItem,
      chargeItem,
    });
  }

  if (
    weaponDamageResult &&
    weaponDamageResult.destroyResult &&
    weaponDamageResult.destroyResult.success === true
  ) {
    const victimSession =
      weaponDamageResult.victimSession ||
      (weaponDamageResult.destroyResult.data &&
        weaponDamageResult.destroyResult.data.victimSession) ||
      null;
    recordKillmailFromDestruction(targetEntity, weaponDamageResult.destroyResult, {
      attackerEntity,
      victimSession,
      whenMs,
      weaponSnapshot: {
        moduleTypeID: toInt(moduleItem && moduleItem.typeID, 0) || null,
        rawShotDamage: damageVector,
      },
      moduleItem,
      chargeItem,
    });
  }
}

function buildPointDefenseRuntimeCallbacks(scene = null) {
  return {
    getEntityRuntimeLoadedCharge,
    consumeLoadedCharge(attackerEntity, moduleItem, chargeItem, quantity, whenMs) {
      return consumeTurretAmmoCharge(
        attackerEntity,
        moduleItem,
        chargeItem,
        whenMs,
        quantity,
      );
    },
    listDamageableEntitiesInRange(sourceEntity, rangeMeters) {
      if (
        !scene ||
        !(scene.dynamicEntities instanceof Map) ||
        !sourceEntity ||
        !Number.isFinite(Number(rangeMeters)) ||
        Number(rangeMeters) < 0
      ) {
        return [];
      }
      const inRange = [];
      for (const candidate of scene.dynamicEntities.values()) {
        if (
          candidate &&
          toInt(candidate.itemID, 0) !== toInt(sourceEntity.itemID, 0) &&
          hasDamageableHealth(candidate) &&
          getEntityCenterDistance(sourceEntity, candidate) <= Number(rangeMeters) + 1e-6
        ) {
          inRange.push(candidate);
        }
      }
      return inRange;
    },
    applyPointDefenseDamage(attackerEntity, targetEntity, moduleItem, damageVector, whenMs) {
      const result = applyWeaponDamageToTarget(
        scene,
        attackerEntity,
        targetEntity,
        damageVector,
        whenMs,
      );
      recordAreaDamageKillmailOutcome(
        attackerEntity,
        targetEntity,
        moduleItem,
        damageVector,
        result,
        whenMs,
      );
      notifyWeaponDamageMessages(
        attackerEntity,
        targetEntity,
        moduleItem,
        damageVector,
        getAppliedDamageAmount(result && result.damageResult),
        sumDamageVector(damageVector) > 0 ? 3 : 0,
      );
      return result;
    },
    evaluateOffensiveAggression(attackerEntity, targetEntity, nowMs) {
      return evaluateCrimewatchOffensiveAggression(
        scene,
        attackerEntity,
        targetEntity,
        nowMs,
      );
    },
    breakEntityStructureTether(entity, options = {}) {
      return breakEntityStructureTether(scene, entity, options);
    },
  };
}

function buildMicroJumpDriveRuntimeCallbacks(scene = null) {
  return {
    getCurrentAlignmentDirection,
    addVectors,
    scaleVector,
    isMicroJumpDriveBlocked(entity) {
      return isEntityMicroJumpDriveBlocked(
        entity,
        scene && typeof scene.getCurrentSimTimeMs === "function"
          ? scene.getCurrentSimTimeMs()
          : Date.now(),
      );
    },
    breakEntityStructureTether(runtimeScene, entity, options = {}) {
      return breakEntityStructureTether(runtimeScene || scene, entity, options);
    },
    isHighSecuritySpace(entity) {
      const systemID = toInt(
        (entity && entity.systemID) || (scene && scene.systemID),
        0,
      );
      if (systemID <= 0) {
        return false;
      }
      return getSystemSecurityClass(worldData.getSolarSystemByID(systemID)) === 2;
    },
    isCapitalClassShipEntity(entity) {
      return isCapitalClassShipEntity(entity);
    },
    listShipEntitiesInRange(sourceEntity, rangeMeters) {
      const runtimeScene = scene;
      if (
        !runtimeScene ||
        !(runtimeScene.dynamicEntities instanceof Map) ||
        !sourceEntity ||
        !(Number(rangeMeters) >= 0)
      ) {
        return [];
      }
      const inRange = [];
      for (const candidate of runtimeScene.dynamicEntities.values()) {
        if (
          !candidate ||
          candidate.kind !== "ship" ||
          toInt(candidate.itemID, 0) === toInt(sourceEntity.itemID, 0) ||
          !canEntitiesInteractLocally(sourceEntity, candidate)
        ) {
          continue;
        }
        if (
          getEntitySurfaceDistance(sourceEntity, candidate) <= Number(rangeMeters) + 1e-6
        ) {
          inRange.push(candidate);
        }
      }
      return inRange;
    },
    recordOffensiveAggression(attackerEntity, targetEntity, nowMs) {
      return recordCrimewatchOffensiveAggression(
        scene,
        attackerEntity,
        targetEntity,
        nowMs,
      );
    },
    applyPostMicroJumpWarpScramble(entities, durationMs, whenMs) {
      return applyPostMicroJumpWarpScramble(scene, entities, durationMs, whenMs);
    },
  };
}

function buildTractorBeamRuntimeCallbacks(scene = null) {
  return {
    getEntitySurfaceDistance(sourceEntity, targetEntity) {
      return getEntitySurfaceDistance(sourceEntity, targetEntity);
    },
    // A tractor beam simply does not work on a wreck or can the pilot has no
    // right to take from — it is not a flag, the module refuses. Reuse the
    // Michelle.HaveLootRight mirror rather than a second copy of the rule.
    hasLootRightForTarget(sourceEntity, targetEntity) {
      const session = (sourceEntity && sourceEntity.session) ||
        getOwningSessionForEntity(scene, sourceEntity);
      return sessionHasInventoryLootRight(session, targetEntity);
    },
    persistDynamicEntity,
  };
}

function buildSalvagerRuntimeCallbacks(scene = null) {
  return {
    resolveSession(entity) {
      return (entity && entity.session) || getOwningSessionForEntity(scene, entity);
    },
    isEntityLockedTarget,
    getEntitySurfaceDistance(sourceEntity, targetEntity) {
      return getEntitySurfaceDistance(sourceEntity, targetEntity);
    },
    resolveCharacterID(entity) {
      return getShipEntityInventoryCharacterID(entity, 0);
    },
    getEntityRuntimeShipItem,
    getEntityRuntimeFittedItems,
    getEntityRuntimeSkillMap,
    syncInventoryChangesToSession,
    random() {
      return scene && typeof scene.__salvageRandom === "function"
        ? scene.__salvageRandom()
        : commonRandom.random();
    },
    onWreckSalvaged(event = {}) {
      const session = event && event.sourceEntity && event.sourceEntity.session
        ? event.sourceEntity.session
        : null;
      try {
        lazyRequire("../services/achievement/achievementRuntime").recordSalvage(
          event && event.characterID,
          event && event.targetID,
        );
      } catch (error) {
        log.warn(
          `[Achievements] Failed to record completed salvage ` +
            `wreck=${toInt(event && event.targetID, 0)}: ${error.message}`,
        );
      }
      if (session) {
        syncLedger.recordSyncLedgerEvent(session, "space.wreck.salvaged", {
          targetID: toInt(event.targetID, 0),
          moduleTypeID: toInt(event.moduleTypeID, 0),
          rewardTypeIDs: Array.isArray(event.rewards)
            ? event.rewards.map((entry) => toInt(entry && entry.itemType, 0)).filter(Boolean)
            : [],
        });
      }
    },
    spawnInventoryBackedEntity(itemRecord, options = {}) {
      if (!scene || !itemRecord || !itemRecord.itemID) {
        return {
          success: false,
          errorMsg: "CONTAINER_NOT_FOUND",
        };
      }
      const entity = buildRuntimeSpaceEntityFromItem(
        itemRecord,
        scene.systemID,
        scene.getCurrentSimTimeMs(),
      );
      if (!entity) {
        return {
          success: false,
          errorMsg: "UNSUPPORTED_DYNAMIC_ITEM",
        };
      }
      return scene.spawnDynamicEntity(entity, options);
    },
  };
}

// A cargo or ship scan reads somebody else's inventory, so everything it needs
// about the target is resolved here: ships, containers and structures answer
// out of the item store, native NPCs out of their in-memory module and cargo
// arrays, and native wrecks out of their loot store.
function listScannableEntityInventoryItems(entity) {
  if (entity?.fabricatorRole === "core") {
    const state = require("../../services/dungeon/dungeonRuntime").getInstance(entity.dungeonSiteInstanceID)?.spawnState?.fabricator;
    return state ? [...(state.loot > 0 ? [{typeID:91773,quantity:state.loot,stacksize:state.loot,flagID:INVENTORY_FLAG_CARGO_HOLD}] : []), ...Object.entries(state.hybrids || {}).map(([typeID,quantity])=>({typeID:Number(typeID),quantity,stacksize:quantity,flagID:INVENTORY_FLAG_CARGO_HOLD}))] : [];
  }
  if (!entity) {
    return [];
  }
  if (isNativeNpcEntity(entity)) {
    const nativeCargo = Array.isArray(entity.nativeCargoItems)
      ? entity.nativeCargoItems.map((item) => ({
        ...item,
        // Native NPC cargo carries no flag of its own; it is the rat's hold.
        flagID: toInt(item && item.flagID, 0) || INVENTORY_FLAG_CARGO_HOLD,
      }))
      : [];
    return [...getEntityRuntimeFittedItems(entity), ...nativeCargo];
  }
  const locationID = toInt(entity.itemID, 0);
  if (locationID <= 0) {
    return [];
  }
  if (entity.nativeNpcWreck === true) {
    return nativeNpcStore.buildNativeWreckContents(locationID);
  }
  // One unfiltered read covers both halves of the family: fitted modules and
  // their loaded charges sit in the ship at a fitting-slot flag, and everything
  // being transported sits in it at a hold flag. The runtime partitions them.
  const storedItems = listContainerItems(null, locationID, null);
  if (storedItems.length > 0) {
    return storedItems;
  }
  return Array.isArray(entity.fittedItems)
    ? entity.fittedItems.map((item) => ({ ...item }))
    : [];
}

function buildScannerRuntimeCallbacks(scene = null) {
  return {
    getEntityByID(entityID) {
      return scene ? scene.getEntityByID(toInt(entityID, 0)) : null;
    },
    isEntityLockedTarget,
    getEntitySurfaceDistance(sourceEntity, targetEntity) {
      return getEntitySurfaceDistance(sourceEntity, targetEntity);
    },
    // Live value first: effect 8518 `cargoScanResistanceAssign` PostAssigns
    // cargoScanResistance onto the ship from a fitted item, so the hull's own
    // number is only the base.
    getEntityAttributeValue(entity, attributeID, fallback = 0) {
      const numericAttributeID = toInt(attributeID, 0);
      const attributes =
        entity &&
        entity.passiveDerivedState &&
        entity.passiveDerivedState.attributes &&
        typeof entity.passiveDerivedState.attributes === "object"
          ? entity.passiveDerivedState.attributes
          : null;
      if (attributes && Number.isFinite(Number(attributes[numericAttributeID]))) {
        return Number(attributes[numericAttributeID]);
      }
      const typeAttributes = getTypeDogmaAttributes(toInt(entity && entity.typeID, 0));
      if (
        typeAttributes &&
        Number.isFinite(Number(typeAttributes[numericAttributeID]))
      ) {
        return Number(typeAttributes[numericAttributeID]);
      }
      return toFiniteNumber(fallback, 0);
    },
    listEntityInventoryItems: listScannableEntityInventoryItems,
    listContainedItems(containerItemID) {
      const normalizedContainerID = toInt(containerItemID, 0);
      return normalizedContainerID > 0
        ? listContainerItems(null, normalizedContainerID, null)
        : [];
    },
    getEntityCapacitorAmount,
    getEntityCapacitorCapacity(entity) {
      return Math.max(0, toFiniteNumber(entity && entity.capacitorCapacity, 0));
    },
    random() {
      return scene && typeof scene.__scannerRandom === "function"
        ? scene.__scannerRandom()
        : commonRandom.random();
    },
    deliverScanResult(session, notifyType, payload) {
      if (
        !session ||
        typeof session.sendNotification !== "function" ||
        (session.socket && session.socket.destroyed) ||
        !notifyType ||
        !Array.isArray(payload)
      ) {
        return false;
      }
      session.sendNotification(notifyType, "clientID", payload);
      return true;
    },
  };
}

function buildSuperweaponRuntimeCallbacks(scene, fallbackCharacterID = 0) {
  return {
    getControlledStaticStructureDogmaHosts() {
      return getControlledStaticStructureDogmaHosts(scene);
    },
    resolveCharacterID(entity) {
      return getShipEntityInventoryCharacterID(entity, fallbackCharacterID);
    },
    getEntityRuntimeShipItem,
    getEntityRuntimeFittedItems,
    getEntityRuntimeModuleItem,
    getEntityRuntimeActiveModuleContexts,
    getEntityRuntimeLoadedCharge,
    getEntityCapacitorAmount,
    setEntityCapacitorRatio,
    notifyCapacitorChangeToSession,
    persistDynamicEntity,
    allocateRuntimeEntityID,
    applyWeaponDamageToTarget,
    notifyWeaponDamageMessages,
    getAppliedDamageAmount,
    noteKillmailDamage,
    recordKillmailFromDestruction,
    evaluateOffensiveAggression(attackerEntity, targetEntity, nowMs) {
      return evaluateCrimewatchOffensiveAggression(
        scene,
        attackerEntity,
        targetEntity,
        nowMs,
      );
    },
    stopShipEntity(entity, options = {}) {
      return scene && typeof scene.stopShipEntity === "function"
        ? scene.stopShipEntity(entity, options)
        : false;
    },
    applySuperweaponHostileModuleState(sourceEntity, targetEntity, effectState, nowMs, options = {}) {
      if (!scene || !sourceEntity || !targetEntity || !effectState) {
        return {
          success: false,
          errorMsg: "UNSUPPORTED_MODULE",
        };
      }
      const applyResult = hostileModuleRuntime.applyHostileModuleState({
        scene,
        sourceEntity,
        targetEntity,
        effectState,
        nowMs,
      });
      if (!applyResult || applyResult.success !== true) {
        return applyResult || {
          success: false,
          errorMsg: "UNSUPPORTED_MODULE",
        };
      }

      const targetSession = targetEntity.session || null;
      if (
        applyResult.data &&
        applyResult.data.aggregateChanged &&
        typeof scene.refreshShipEntityDerivedState === "function"
      ) {
        scene.refreshShipEntityDerivedState(targetEntity, {
          session: targetSession,
          broadcast: true,
          notifyTargeting: true,
        });
      }

      const hudSyncResult = hudIconRuntime.upsertHudIconState(
        targetEntity,
        buildHostileHudState(targetEntity, sourceEntity, effectState, nowMs),
      );
      if (targetSession && isReadyForDestiny(targetSession) && hudSyncResult.state) {
        notifyHostileHudStateToSession(targetSession, hudSyncResult.state, true, {
          startTimeMs: nowMs,
          durationMs: Math.max(
            1,
            toInt(options.durationMs, toInt(effectState.durationMs, 1000)),
          ),
        });
      }
      return applyResult;
    },
    removeSuperweaponHostileModuleState(sourceEntity, targetEntity, effectState, nowMs) {
      if (!scene || !sourceEntity || !targetEntity || !effectState) {
        return {
          success: false,
          errorMsg: "UNSUPPORTED_MODULE",
        };
      }
      const removeResult = hostileModuleRuntime.removeHostileModuleState({
        targetEntity,
        sourceEntity,
        effectState,
      });
      if (!removeResult || removeResult.success !== true) {
        return removeResult || {
          success: false,
          errorMsg: "UNSUPPORTED_MODULE",
        };
      }

      const targetSession = targetEntity.session || null;
      if (
        removeResult.data &&
        removeResult.data.aggregateChanged &&
        typeof scene.refreshShipEntityDerivedState === "function"
      ) {
        scene.refreshShipEntityDerivedState(targetEntity, {
          session: targetSession,
          broadcast: true,
          notifyTargeting: true,
        });
      }

      const removedHudState = hudIconRuntime.removeHudIconState(
        targetEntity,
        buildHostileHudState(targetEntity, sourceEntity, effectState, nowMs),
      );
      if (targetSession && isReadyForDestiny(targetSession) && removedHudState) {
        notifyHostileHudStateToSession(targetSession, removedHudState, false, {
          startTimeMs: nowMs,
        });
      }
      return removeResult;
    },
    applySuperweaponJammerModuleState(sourceEntity, targetEntity, effectState, nowMs, options = {}) {
      if (!scene || !sourceEntity || !targetEntity || !effectState) {
        return {
          success: false,
          errorMsg: "UNSUPPORTED_MODULE",
        };
      }
      const applyResult = jammerModuleRuntime.applyJammerModuleState({
        targetEntity,
        sourceEntity,
        effectState,
        nowMs,
        callbacks: buildJammerModuleRuntimeCallbacks(scene),
      });
      if (!applyResult || applyResult.success !== true) {
        return applyResult || {
          success: false,
          errorMsg: "UNSUPPORTED_MODULE",
        };
      }

      const targetSession = targetEntity.session || null;
      const jamApplied = Boolean(applyResult.data && applyResult.data.jamApplied === true);
      const previousJamApplied = Boolean(
        applyResult.data && applyResult.data.previousJamApplied === true,
      );
      if (targetSession && isReadyForDestiny(targetSession)) {
        if (jamApplied) {
          const hudSyncResult = hudIconRuntime.upsertHudIconState(
            targetEntity,
            buildJammerHudState(targetEntity, sourceEntity, effectState, nowMs),
          );
          if (hudSyncResult.state) {
            notifyHostileHudStateToSession(targetSession, hudSyncResult.state, true, {
              startTimeMs: nowMs,
              durationMs: Math.max(
                1,
                toInt(options.durationMs, toInt(effectState.jamDurationMs, 1000)),
              ),
              refreshTimerOnly: previousJamApplied,
            });
          }
        } else if (previousJamApplied) {
          const removedHudState = hudIconRuntime.removeHudIconState(
            targetEntity,
            buildJammerHudState(targetEntity, sourceEntity, effectState, nowMs),
          );
          if (removedHudState) {
            notifyHostileHudStateToSession(
              targetSession,
              removedHudState,
              false,
              {
                startTimeMs: nowMs,
              },
            );
          }
        }
      }
      return applyResult;
    },
    removeSuperweaponJammerModuleState(sourceEntity, targetEntity, effectState, nowMs) {
      if (!scene || !sourceEntity || !targetEntity || !effectState) {
        return {
          success: false,
          errorMsg: "UNSUPPORTED_MODULE",
        };
      }
      const removeResult = jammerModuleRuntime.removeJammerModuleState({
        targetEntity,
        sourceEntity,
        effectState,
        nowMs,
      });
      if (!removeResult || removeResult.success !== true) {
        return removeResult || {
          success: false,
          errorMsg: "UNSUPPORTED_MODULE",
        };
      }

      const targetSession = targetEntity.session || null;
      const removedHudState = hudIconRuntime.removeHudIconState(
        targetEntity,
        buildJammerHudState(targetEntity, sourceEntity, effectState, nowMs),
      );
      if (targetSession && isReadyForDestiny(targetSession) && removedHudState) {
        notifyHostileHudStateToSession(targetSession, removedHudState, false, {
          startTimeMs: nowMs,
        });
      }
      return removeResult;
    },
    breakEntityStructureTether(runtimeScene, entity, options = {}) {
      return breakEntityStructureTether(runtimeScene || scene, entity, options);
    },
  };
}

Object.assign(module.exports, {
  INVENTORY_FLAG_CARGO_HOLD,
});
