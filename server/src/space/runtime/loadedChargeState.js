"use strict";

module.exports = {
  applyCrystalVolatilityDamage,
  consumeTurretAmmoCharge,
  ensureChargeTupleDogmaPrimeForSession,
  getChargeItemQuantity,
  notifyChargeDamageChangeToSession,
  notifyChargeQuantityChangeToSession,
  notifyRuntimeChargeTransitionToSession,
  scheduleChargeDamageChangeForFreshTuplePrime,
};

const runtimeEntryDirname = require("path").resolve(__dirname, "..");
const path = require("path");
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
const {
  buildAttributeChange,
  notifyAttributeChanges,
} = require("./attributeChangeNotification");
const {
  resolveChargeDogmaPrimeEntry,
} = require("./characterStateBridge");
const {
  buildCrystalDurabilitySnapshot,
  planCrystalDurabilityCycle,
  resolveCrystalDamage,
} = require("../../services/dogma/crystalDurability");
const {
  ATTRIBUTE_ITEM_DAMAGE,
  ATTRIBUTE_QUANTITY,
} = require("./dogmaAttributeIds");
const {
  getEntityRuntimeLoadedCharge,
  getShipEntityInventoryCharacterID,
} = require("./entityDogmaView");
const {
  getCombatNotificationSession,
} = require("./entityOwnerSession");
const {
  clamp,
  roundNumber,
  toFiniteNumber,
  toInt,
} = require("../../common/numbers");
const {
  resolveSessionNotificationFileTime,
} = require("./sessionNotificationTime");

const CHARGE_TUPLE_PRIME_SETTLE_DELAY_MS = 0;

const CHARGE_TUPLE_PRIME_GRACE_WINDOW_MS = 1000;

function ensureChargeTupleDogmaPrimeForSession(
  session,
  shipID,
  moduleFlagID,
  chargeItem,
  options = {},
) {
  const numericShipID = toInt(shipID, 0);
  const numericFlagID = toInt(moduleFlagID, 0);
  const numericChargeTypeID = toInt(chargeItem && chargeItem.typeID, 0);
  const hasQuantityOverride =
    options.quantityOverride !== undefined &&
    options.quantityOverride !== null;
  const quantity = hasQuantityOverride
    ? Math.max(0, toInt(options.quantityOverride, 0))
    : getChargeItemQuantity(chargeItem);
  if (
    !session ||
    typeof session.sendNotification !== "function" ||
    !session._space ||
    numericShipID <= 0 ||
    numericFlagID <= 0 ||
    numericChargeTypeID <= 0 ||
    (!hasQuantityOverride && quantity <= 0)
  ) {
    return false;
  }

  if (!(session._space.primedChargeTupleKeys instanceof Set)) {
    session._space.primedChargeTupleKeys = new Set();
  }
  if (!(session._space.recentlyPrimedChargeTupleKeys instanceof Map)) {
    session._space.recentlyPrimedChargeTupleKeys = new Map();
  }

  const tupleKey = `${numericShipID}:${numericFlagID}:${numericChargeTypeID}`;
  if (session._space.primedChargeTupleKeys.has(tupleKey)) {
    return false;
  }

  session._space.primedChargeTupleKeys.add(tupleKey);
  const when =
    options.when != null
      ? options.when
      : resolveSessionNotificationFileTime(session);
  const ownerID = toInt(
    options.ownerID,
    toInt(chargeItem && chargeItem.ownerID, toInt(session.characterID, 0)),
  );
  const tupleItemID = buildChargeTupleItemID(
    numericShipID,
    numericFlagID,
    numericChargeTypeID,
  );
  const tupleChargeItem = {
    ...(chargeItem && typeof chargeItem === "object" ? chargeItem : {}),
    itemID: tupleItemID,
    ownerID: ownerID || null,
    locationID: numericShipID,
    flagID: numericFlagID,
    typeID: numericChargeTypeID,
    quantity,
    stacksize: quantity,
    singleton: 0,
    groupID: toInt(chargeItem && chargeItem.groupID, 0),
    categoryID: toInt(chargeItem && chargeItem.categoryID, 0),
    customInfo: String((chargeItem && chargeItem.customInfo) || ""),
  };

  session.sendNotification("OnGodmaPrimeItem", "clientID", [
    numericShipID,
    resolveChargeDogmaPrimeEntry(tupleChargeItem, {
      description: "charge",
      now: when,
    }),
  ]);
  const clearTimer = setTimeout(() => {
    const recentPrimeMap =
      session &&
      session._space &&
      session._space.recentlyPrimedChargeTupleKeys instanceof Map
        ? session._space.recentlyPrimedChargeTupleKeys
        : null;
    if (!recentPrimeMap) {
      return;
    }
    const currentTimer = recentPrimeMap.get(tupleKey);
    if (currentTimer === clearTimer) {
      recentPrimeMap.delete(tupleKey);
    }
  }, CHARGE_TUPLE_PRIME_GRACE_WINDOW_MS);
  if (typeof clearTimer.unref === "function") {
    clearTimer.unref();
  }
  session._space.recentlyPrimedChargeTupleKeys.set(tupleKey, clearTimer);
  return true;
}

function scheduleChargeDamageChangeForFreshTuplePrime(
  session,
  shipID,
  moduleFlagID,
  chargeTypeID,
  nextDamage,
  previousDamage,
  when = null,
) {
  const numericShipID = toInt(shipID, 0);
  const numericFlagID = toInt(moduleFlagID, 0);
  const numericChargeTypeID = toInt(chargeTypeID, 0);
  if (
    !session ||
    !session._space ||
    typeof session.sendNotification !== "function" ||
    numericShipID <= 0 ||
    numericFlagID <= 0 ||
    numericChargeTypeID <= 0
  ) {
    return false;
  }

  if (!(session._space.deferredChargeDamageChangeTimers instanceof Map)) {
    session._space.deferredChargeDamageChangeTimers = new Map();
  }
  const tupleKey = `${numericShipID}:${numericFlagID}:${numericChargeTypeID}`;
  const activeTimer = session._space.deferredChargeDamageChangeTimers.get(tupleKey);
  if (activeTimer) {
    clearTimeout(activeTimer);
  }

  const deferredTimer = setTimeout(() => {
    const timerMap =
      session &&
      session._space &&
      session._space.deferredChargeDamageChangeTimers instanceof Map
        ? session._space.deferredChargeDamageChangeTimers
        : null;
    if (timerMap) {
      timerMap.delete(tupleKey);
    }
    const recentPrimeMap =
      session &&
      session._space &&
      session._space.recentlyPrimedChargeTupleKeys instanceof Map
        ? session._space.recentlyPrimedChargeTupleKeys
        : null;
    if (recentPrimeMap && recentPrimeMap.has(tupleKey)) {
      clearTimeout(recentPrimeMap.get(tupleKey));
      recentPrimeMap.delete(tupleKey);
    }
    if (
      !session ||
      !session._space ||
      typeof session.sendNotification !== "function" ||
      (session.socket && session.socket.destroyed)
    ) {
      return;
    }
    notifyAttributeChanges(session, [buildAttributeChange(
      session,
      buildChargeTupleItemID(numericShipID, numericFlagID, numericChargeTypeID),
      ATTRIBUTE_ITEM_DAMAGE,
      roundNumber(toFiniteNumber(nextDamage, 0), 6),
      roundNumber(toFiniteNumber(previousDamage, 0), 6),
      when,
    )]);
  }, CHARGE_TUPLE_PRIME_SETTLE_DELAY_MS);
  if (typeof deferredTimer.unref === "function") {
    deferredTimer.unref();
  }
  session._space.deferredChargeDamageChangeTimers.set(tupleKey, deferredTimer);
  return true;
}

function notifyChargeDamageChangeToSession(
  session,
  shipID,
  moduleFlagID,
  chargeTypeID,
  nextDamage,
  previousDamage,
  when = null,
) {
  const numericShipID = toInt(shipID, 0);
  const numericFlagID = toInt(moduleFlagID, 0);
  const numericChargeTypeID = toInt(chargeTypeID, 0);
  if (
    !session ||
    numericShipID <= 0 ||
    numericFlagID <= 0 ||
    numericChargeTypeID <= 0
  ) {
    return false;
  }

  return notifyAttributeChanges(session, [buildAttributeChange(
    session,
    buildChargeTupleItemID(numericShipID, numericFlagID, numericChargeTypeID),
    ATTRIBUTE_ITEM_DAMAGE,
    roundNumber(toFiniteNumber(nextDamage, 0), 6),
    roundNumber(toFiniteNumber(previousDamage, 0), 6),
    when,
  )]);
}

function notifyChargeQuantityChangeToSession(
  session,
  shipID,
  moduleFlagID,
  chargeTypeID,
  nextQuantity,
  previousQuantity,
  when = null,
) {
  const numericShipID = toInt(shipID, 0);
  const numericFlagID = toInt(moduleFlagID, 0);
  const numericChargeTypeID = toInt(chargeTypeID, 0);
  if (
    !session ||
    numericShipID <= 0 ||
    numericFlagID <= 0 ||
    numericChargeTypeID <= 0
  ) {
    return false;
  }

  return notifyAttributeChanges(session, [buildAttributeChange(
    session,
    buildChargeTupleItemID(numericShipID, numericFlagID, numericChargeTypeID),
    ATTRIBUTE_QUANTITY,
    Math.max(0, toInt(nextQuantity, 0)),
    Math.max(0, toInt(previousQuantity, 0)),
    when,
  )]);
}

function getChargeItemQuantity(chargeItem) {
  return Math.max(
    0,
    toInt(chargeItem && (chargeItem.stacksize ?? chargeItem.quantity), 0),
  );
}

function notifyRuntimeChargeTransitionToSession(
  session,
  shipID,
  moduleFlagID,
  previousState = null,
  nextState = null,
  ownerID = 0,
  options = {},
) {
  const previousTypeID = toInt(previousState && previousState.typeID, 0);
  const nextTypeID = toInt(nextState && nextState.typeID, 0);
  const previousQuantity = Math.max(0, toInt(previousState && previousState.quantity, 0));
  const nextQuantity = Math.max(0, toInt(nextState && nextState.quantity, 0));

  if (previousTypeID === nextTypeID && previousQuantity === nextQuantity) {
    return false;
  }

  let notified = false;
  const when = options.when != null ? options.when : null;
  if (previousTypeID > 0) {
    notified =
      notifyChargeQuantityChangeToSession(
        session,
        shipID,
        moduleFlagID,
        previousTypeID,
        previousTypeID === nextTypeID ? nextQuantity : 0,
        previousQuantity,
        when,
      ) || notified;
  }
  if (nextTypeID > 0 && nextTypeID !== previousTypeID) {
    const nextChargeItem =
      options.nextChargeItem && typeof options.nextChargeItem === "object"
        ? options.nextChargeItem
        : {
            typeID: nextTypeID,
            ownerID,
            quantity: 0,
            stacksize: 0,
          };
    ensureChargeTupleDogmaPrimeForSession(
      session,
      shipID,
      moduleFlagID,
      {
        ...nextChargeItem,
        typeID: nextTypeID,
        quantity: 0,
        stacksize: 0,
      },
      {
        ownerID,
        quantityOverride: 0,
        when,
      },
    );
    notified =
      notifyChargeQuantityChangeToSession(
        session,
        shipID,
        moduleFlagID,
        nextTypeID,
        nextQuantity,
        0,
        when,
      ) || notified;
  }

  return notified;
}

function consumeTurretAmmoCharge(
  attackerEntity,
  moduleItem,
  chargeItem,
  whenMs = null,
  quantity = 1,
) {
  if (!attackerEntity || !moduleItem || !chargeItem) {
    return {
      success: false,
      errorMsg: "NO_AMMO",
      stopReason: "ammo",
    };
  }

  const consumeQuantity = Math.max(1, toInt(quantity, 1));
  const previousQuantity = getChargeItemQuantity(chargeItem);
  if (previousQuantity <= 0) {
    return {
      success: false,
      errorMsg: "NO_AMMO",
      stopReason: "ammo",
    };
  }

  if (previousQuantity < consumeQuantity) {
    return {
      success: false,
      errorMsg: "NO_AMMO",
      stopReason: "ammo",
    };
  }

  const nextQuantity = Math.max(0, previousQuantity - consumeQuantity);
  let updatedChargeItem = null;
  const previousChargeItemSnapshot =
    chargeItem && typeof chargeItem === "object"
      ? {
          ...chargeItem,
          quantity: previousQuantity,
          stacksize: previousQuantity,
        }
      : null;

  if (isNativeNpcEntity(attackerEntity)) {
    const entityID = toInt(attackerEntity.itemID, 0);
    const chargeItemID = toInt(chargeItem.itemID, 0);
    const moduleID = toInt(moduleItem.itemID, 0);
    const cargoRecord = nativeNpcStore
      .listNativeCargoForEntity(entityID)
      .find((entry) => (
        toInt(entry && entry.cargoID, 0) === chargeItemID ||
        (
          chargeItemID <= 0 &&
          moduleID > 0 &&
          toInt(entry && entry.moduleID, 0) === moduleID
        )
      )) || null;

    if (cargoRecord) {
      const persistResult = nextQuantity > 0
        ? nativeNpcStore.upsertNativeCargo({
          ...cargoRecord,
          quantity: nextQuantity,
        }, {
          transient: cargoRecord.transient === true,
        })
        : nativeNpcStore.removeNativeCargo(cargoRecord.cargoID);
      if (!persistResult.success) {
        return {
          success: false,
          errorMsg: persistResult.errorMsg || "AMMO_UPDATE_FAILED",
          stopReason: "ammo",
        };
      }
    }

    if (Array.isArray(attackerEntity.nativeCargoItems)) {
      attackerEntity.nativeCargoItems = attackerEntity.nativeCargoItems.flatMap((cargoItem) => {
        const matchesCharge = (
          toInt(cargoItem && cargoItem.itemID, 0) === chargeItemID ||
          (
            chargeItemID <= 0 &&
            moduleID > 0 &&
            toInt(cargoItem && cargoItem.moduleID, 0) === moduleID
          )
        );
        if (!matchesCharge) {
          return [cargoItem];
        }
        if (nextQuantity <= 0) {
          return [];
        }
        return [{
          ...cargoItem,
          quantity: nextQuantity,
          stacksize: nextQuantity,
        }];
      });
    }

    updatedChargeItem = nextQuantity > 0
      ? getEntityRuntimeLoadedCharge(attackerEntity, moduleItem) || {
        ...chargeItem,
        quantity: nextQuantity,
        stacksize: nextQuantity,
      }
      : null;
  } else {
    const chargeItemID = toInt(chargeItem.itemID, 0);
    if (chargeItemID <= 0) {
      return {
        success: false,
        errorMsg: "AMMO_NOT_FOUND",
        stopReason: "ammo",
      };
    }

    const persistResult = nextQuantity > 0
      ? updateInventoryItem(chargeItemID, (currentItem) => ({
        ...currentItem,
        quantity: nextQuantity,
        stacksize: nextQuantity,
      }))
      : removeInventoryItem(chargeItemID);
    if (!persistResult.success) {
      return {
        success: false,
        errorMsg: persistResult.errorMsg || "AMMO_UPDATE_FAILED",
        stopReason: "ammo",
      };
    }

    updatedChargeItem = nextQuantity > 0
      ? findItemById(chargeItemID) || {
        ...chargeItem,
        quantity: nextQuantity,
        stacksize: nextQuantity,
      }
      : null;
  }

  const chargeObserver = getCombatNotificationSession(attackerEntity);
  if (chargeObserver) {
    notifyRuntimeChargeTransitionToSession(
      chargeObserver,
      attackerEntity.itemID,
      moduleItem.flagID,
      {
        typeID: chargeItem.typeID,
        quantity: previousQuantity,
      },
      {
        typeID: chargeItem.typeID,
        quantity: nextQuantity,
      },
      toInt(
        updatedChargeItem && updatedChargeItem.ownerID,
        toInt(
          chargeItem && chargeItem.ownerID,
          getShipEntityInventoryCharacterID(attackerEntity, 0),
        ),
      ),
      {
        previousChargeItem: previousChargeItemSnapshot,
        nextChargeItem:
          updatedChargeItem && typeof updatedChargeItem === "object"
            ? {
                ...updatedChargeItem,
              }
            : null,
      },
    );
  }

  return {
    success: true,
    data: {
      chargeItem: updatedChargeItem,
      previousQuantity,
      nextQuantity,
      depleted: nextQuantity <= 0,
    },
    stopReason: nextQuantity <= 0 ? "ammo" : null,
  };
}

function applyCrystalVolatilityDamage(
  scene,
  attackerEntity,
  moduleItem,
  chargeItem,
  whenMs = null,
  options = {},
) {
  if (!scene || !attackerEntity || !moduleItem || !chargeItem) {
    return {
      success: false,
      errorMsg: "CRYSTAL_NOT_FOUND",
    };
  }

  const cycleOwner = options.cycleState || attackerEntity;
  const cycleAtMs = whenMs == null ? scene.getCurrentSimTimeMs() : toFiniteNumber(whenMs, scene.getCurrentSimTimeMs());
  if (!(cycleOwner.crystalDurabilityPlans instanceof Map)) cycleOwner.crystalDurabilityPlans = new Map();
  const cached = cycleOwner.crystalDurabilityPlans.get(moduleItem.itemID);
  let cycle = cached && cached.chargeID === chargeItem.itemID && cached.atMs === cycleAtMs ? cached : null;
  if (cycle?.result?.data?.burnedOut) return cycle.result;
  const cargoRecord = isNativeNpcEntity(attackerEntity)
    ? nativeNpcStore.listNativeCargoForEntity(attackerEntity.itemID).find(entry => Number(entry.cargoID) === Number(chargeItem.itemID))
    : null;
  const currentCharge = isNativeNpcEntity(attackerEntity)
    ? cargoRecord && { ...chargeItem, typeID: cargoRecord.typeID, moduleState: cargoRecord.moduleState }
    : findItemById(chargeItem.itemID);
  if (!currentCharge || Number(currentCharge.typeID) !== Number(chargeItem.typeID) ||
      (cargoRecord && Number(cargoRecord.moduleID) !== Number(moduleItem.itemID)) ||
      (!cargoRecord && (Number(currentCharge.locationID) !== Number(attackerEntity.itemID) ||
        Number(currentCharge.flagID) !== Number(moduleItem.flagID)))) {
    return { success: false, errorMsg: "CRYSTAL_NOT_FOUND" };
  }
  chargeItem = currentCharge;
  if (cycle?.result) return { ...cycle.result, data: { ...cycle.result.data, chargeItem } };
  if (!cycle) {
    const snapshot = buildCrystalDurabilitySnapshot(chargeItem.typeID,
      options.chargeAttributes || getTypeDogmaAttributes(chargeItem.typeID), options.chanceMultiplier ?? 1);
    const plan = planCrystalDurabilityCycle({ chargeItem, durabilitySnapshot: snapshot, random: options.random || Math.random });
    if (!plan.success) return plan;
    cycle = { chargeID: chargeItem.itemID, atMs: cycleAtMs, plan: plan.data };
    cycleOwner.crystalDurabilityPlans.set(moduleItem.itemID, cycle);
  }
  const { previousDamage, nextDamage, burnedOut, damaged } = cycle.plan;
  const persistedDamage = resolveCrystalDamage(chargeItem);
  if (persistedDamage !== previousDamage && persistedDamage !== nextDamage) {
    return { success: false, errorMsg: "CRYSTAL_STATE_CHANGED" };
  }
  if (!damaged && !burnedOut) {
    cycle.result = { success: true, data: { chargeItem, damaged: false, burnedOut: false } };
    return cycle.result;
  }
  const chargeObserver = getCombatNotificationSession(attackerEntity);
  const when = resolveSessionNotificationFileTime(chargeObserver, whenMs);
  let updatedChargeItem = chargeItem;
  const damageNeeded = !cycle.damageCommitted && damaged;
  if (damageNeeded && isNativeNpcEntity(attackerEntity)) {
    const cargoRecord = nativeNpcStore
      .listNativeCargoForEntity(attackerEntity.itemID)
      .find((entry) => toInt(entry && entry.cargoID, 0) === toInt(chargeItem && chargeItem.itemID, 0));
    if (!cargoRecord) {
      return {
        success: false,
        errorMsg: "CRYSTAL_NOT_FOUND",
      };
    }

    const updateResult = nativeNpcStore.upsertNativeCargo({
      ...cargoRecord,
      moduleState: {
        ...(cargoRecord && cargoRecord.moduleState ? cargoRecord.moduleState : {}),
        damage: nextDamage,
      },
    }, {
      transient: cargoRecord.transient === true,
    });
    if (!updateResult.success) {
      return updateResult;
    }

    if (Array.isArray(attackerEntity.nativeCargoItems)) {
      attackerEntity.nativeCargoItems = attackerEntity.nativeCargoItems.map((cargoItem) => (
        toInt(cargoItem && cargoItem.itemID, 0) === toInt(chargeItem && chargeItem.itemID, 0)
          ? {
              ...cargoItem,
              moduleState: {
                ...(cargoItem && cargoItem.moduleState ? cargoItem.moduleState : {}),
                damage: nextDamage,
              },
            }
          : cargoItem
      ));
    }
    updatedChargeItem = getEntityRuntimeLoadedCharge(attackerEntity, moduleItem) || {
      ...chargeItem,
      moduleState: {
        ...(chargeItem && chargeItem.moduleState ? chargeItem.moduleState : {}),
        damage: nextDamage,
      },
    };
  } else if (damageNeeded) {
    const updateResult = updateInventoryItem(chargeItem.itemID, (currentItem) => ({
      ...currentItem,
      singleton: 1,
      moduleState: {
        ...(currentItem && currentItem.moduleState ? currentItem.moduleState : {}),
        damage: nextDamage,
      },
    }));
    if (!updateResult.success) {
      return updateResult;
    }
    updatedChargeItem = findItemById(chargeItem.itemID) || chargeItem;
  }
  cycle.damageCommitted = true;
  if (damageNeeded && chargeObserver) {
    (options.notifyDamage || notifyChargeDamageChangeToSession)(
      chargeObserver,
      attackerEntity.itemID,
      moduleItem.flagID,
      chargeItem.typeID,
      nextDamage,
      previousDamage,
      when,
    );
  }
  if (moduleItem.loadedChargeItem) moduleItem.loadedChargeItem = updatedChargeItem;
  if (!burnedOut) {
    cycle.result = {
      success: true,
      data: {
        chargeItem: updatedChargeItem,
        damaged,
        burnedOut: false,
        previousDamage,
        nextDamage,
      },
    };
    return cycle.result;
  }

  let removeResult = null;
  if (isNativeNpcEntity(attackerEntity)) {
    const cargoRecord = nativeNpcStore
      .listNativeCargoForEntity(attackerEntity.itemID)
      .find((entry) => toInt(entry && entry.cargoID, 0) === toInt(chargeItem && chargeItem.itemID, 0))
      || null;
    if (cargoRecord) {
      removeResult = nativeNpcStore.removeNativeCargo(cargoRecord.cargoID);
    } else if (Array.isArray(attackerEntity.nativeCargoItems)) {
      removeResult = { success: true };
    } else {
      removeResult = {
        success: false,
        errorMsg: "CRYSTAL_NOT_FOUND",
      };
    }
    if (removeResult.success && Array.isArray(attackerEntity.nativeCargoItems)) {
      attackerEntity.nativeCargoItems = attackerEntity.nativeCargoItems.filter(
        (cargoItem) => toInt(cargoItem && cargoItem.itemID, 0) !== toInt(chargeItem && chargeItem.itemID, 0),
      );
    }
  } else {
    removeResult = removeInventoryItem(chargeItem.itemID);
  }
  if (removeResult.success && moduleItem.loadedChargeItem) moduleItem.loadedChargeItem = null;
  if (removeResult.success && options.notifyRemoval) {
    options.notifyRemoval(chargeObserver, attackerEntity, moduleItem, chargeItem, removeResult);
  } else if (removeResult.success && chargeObserver) {
    notifyRuntimeChargeTransitionToSession(
      chargeObserver,
      attackerEntity.itemID,
      moduleItem.flagID,
      {
        typeID: chargeItem.typeID,
        quantity: 1,
      },
      {
        typeID: chargeItem.typeID,
        quantity: 0,
      },
      toInt(
        chargeItem && chargeItem.ownerID,
        getShipEntityInventoryCharacterID(attackerEntity, 0),
      ),
      {
        previousChargeItem:
          chargeItem && typeof chargeItem === "object"
            ? {
                ...chargeItem,
                quantity: 1,
                stacksize: 1,
              }
            : null,
        nextChargeItem: null,
      },
    );
  }

  const result = {
    success: removeResult.success,
    errorMsg: removeResult.success ? null : removeResult.errorMsg,
    data: {
      chargeItem: removeResult.success ? null : updatedChargeItem,
      damaged,
      burnedOut: removeResult.success,
      previousDamage,
      nextDamage,
    },
  };
  if (result.success) cycle.result = result;
  return result;
}

Object.assign(module.exports, {
  CHARGE_TUPLE_PRIME_GRACE_WINDOW_MS,
  CHARGE_TUPLE_PRIME_SETTLE_DELAY_MS,
});
