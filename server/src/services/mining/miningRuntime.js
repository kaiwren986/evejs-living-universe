"use strict";

const { queueDogmaEvent } = require("../../space/runtime/dogmaEvents");

const {
  round6,
  toFiniteNumber,
} = require("../../common/numbers");

const path = require("path");
const { buildCrystalDurabilitySnapshot, isCrystalBurnedOut } = require("../dogma/crystalDurability");

// Memoized resolver for lazy (circular-dependency-safe) requires that run on the
// mining tick path. require(path.join(__dirname, id)) costs ~1.8us/call even
// when cached (path rebuild + resolver lookup); caching the resolved reference
// drops it to a ~4ns Map lookup. Safe because the targets assign module.exports
// once at load (or mutate it in place), so the cached reference never goes stale.
const _lazyModuleCache = new Map();
function lazyRequire(relativeId) {
  let resolved = _lazyModuleCache.get(relativeId);
  if (resolved === undefined) {
    resolved = require(path.join(__dirname, relativeId));
    _lazyModuleCache.set(relativeId, resolved);
  }
  return resolved;
}

const config = require(path.join(__dirname, "../../config"));
const log = require(path.join(__dirname, "../../utils/logger"));
const {
  canEntitiesInteractLocally,
} = require(path.join(
  __dirname,
  "../../space/destiny/identity/interactionScope",
));
const {
  getActiveShipRecord,
  peekCharacterRecord,
  emitItemsChangedForSession,
  syncInventoryItemForSession,
} = require(path.join(__dirname, "../character/characterState"));
const {
  getCachedCharacterSkillMap,
} = require(path.join(__dirname, "../skills/skillState"));
const {
  ITEM_FLAGS,
  grantItemsToCharacterLocation,
} = require(path.join(__dirname, "../inventory/itemStore"));
const {
  findItemById,
  findShipItemById,
  listContainerItems,
} = require(path.join(__dirname, "../inventory/simulationInventoryProjection"));
const {
  getFittedModuleItems,
  getLoadedChargeByFlag,
  getEffectTypeRecord,
  isChargeCompatibleWithModule,
  isModuleOnline,
  buildShipResourceState,
  listHiddenModifierItems,
  buildChargeTupleItemID,
} = require(path.join(__dirname, "../fitting/liveFittingState"));
const {
  resolveItemByTypeID,
} = require(path.join(__dirname, "../inventory/itemTypeRegistry"));
const {
  matchesTypeList,
} = require(path.join(__dirname, "../inventory/typeListAuthority"));
const {
  getPreferredMiningHoldFlagForType,
  getShipHoldCapacityByFlag,
} = require("./miningInventory");
const {
  computeMiningResult,
} = require("./miningMath");
const {
  isMiningEffectRecord,
  buildMiningModuleSnapshot,
  resolveMiningFamily,
} = require("./miningDogma");
const commandBurstRuntime = require(path.join(
  __dirname,
  "../../space/modules/commandBurstRuntime",
));
const {
  getLocationModifierSourcesForSystem,
} = require(path.join(
  __dirname,
  "../exploration/wormholes/wormholeEnvironmentRuntime",
));
const {
  ensureSceneMiningState,
  getMineableState,
  applyMiningDelta,
  shouldPersistMineableState,
  isMineableStaticEntity,
} = require("./miningRuntimeState");
const {
  getNpcFittedModuleItems,
  getNpcLoadedChargeForModule,
  isNativeNpcEntity,
} = require(path.join(__dirname, "../../space/npc/npcEquipment"));
const {
  buildKeyVal,
  currentFileTime,
} = require(path.join(__dirname, "../_shared/serviceHelpers"));

const INV_UPDATE_LOCATION = 3;
const shipResourceStateCache = require("./shipResourceStateCache");
const ATTRIBUTE_ITEM_DAMAGE = 3;
const ATTRIBUTE_QUANTITY = 805;

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

// Resolve the mining family ("ore" / "ice" / "gas") behind a running mining
// effect state, without paying for a full mining snapshot. Prefers the live
// fitted module, falls back to the effective module item captured at
// activation, then to the bare type record — so an offline or removed module
// still resolves. Returns null only when the module cannot be identified at
// all.
function resolveMiningFamilyForEffectState(entity, effectState) {
  if (!effectState) {
    return null;
  }
  const moduleItem =
    resolveEntityModuleItem(entity, effectState.moduleID, effectState.moduleFlagID) ||
    (
      effectState.moduleItemSnapshot &&
      typeof effectState.moduleItemSnapshot === "object"
        ? effectState.moduleItemSnapshot
        : null
    ) ||
    resolveItemByTypeID(toInt(effectState.typeID, 0));
  if (!moduleItem) {
    return null;
  }
  const effectRecord =
    (
      effectState.effectRecord && typeof effectState.effectRecord === "object"
        ? effectState.effectRecord
        : null
    ) ||
    getEffectTypeRecord(toInt(effectState.effectID, 0)) ||
    (effectState.effectName ? { name: String(effectState.effectName) } : null);
  return resolveMiningFamily(moduleItem, effectRecord);
}

// EVE parity gate for short-cycling a running mining module on a manual stop.
// Ore and gas modules settle the elapsed fraction of the cycle immediately,
// whether or not they load a mining crystal — a Modulated Strip Miner II is an
// ore module like any other, and the crystal only changes the yield, not the
// cycle. One family refuses it: ice harvesters and ice mining lasers. EVE
// University, Mining yield: "Short-cycling is equally useful when harvesting
// gas, but should never be used while ice harvesting (as ice mining
// lasers/harvesters only harvest 1 unit of ice per complete cycle; short-cycle
// your ice harvester, and you mine nothing)."
// (https://wiki.eveuniversity.org/Mining_yield)
// If the family cannot be resolved at all we return true, which keeps the
// permissive ore/gas behaviour rather than silently deferring an unknown
// module.
function miningModuleCanShortCycle(entity, effectState) {
  return resolveMiningFamilyForEffectState(entity, effectState) !== "ice";
}

function getSessionFileTime(session) {
  return session && session._space && session._space.simFileTime
    ? session._space.simFileTime
    : currentFileTime();
}

function notifyMiningChargeAttributeChange(
  session,
  shipID,
  moduleFlagID,
  chargeTypeID,
  attributeID,
  nextValue,
  previousValue,
) {
  const numericShipID = toInt(shipID, 0);
  const numericFlagID = toInt(moduleFlagID, 0);
  const numericChargeTypeID = toInt(chargeTypeID, 0);
  const numericAttributeID = toInt(attributeID, 0);
  if (
    !session ||
    typeof session.sendNotification !== "function" ||
    numericShipID <= 0 ||
    numericFlagID <= 0 ||
    numericChargeTypeID <= 0 ||
    numericAttributeID <= 0
  ) {
    return false;
  }

  queueDogmaEvent(session, "OnModuleAttributeChanges", [{
    type: "list",
    items: [[
      // TQ parity: singular inner tuple tag + trailing time.
      "OnModuleAttributeChange",
      toInt(session.characterID, 0),
      buildChargeTupleItemID(numericShipID, numericFlagID, numericChargeTypeID),
      numericAttributeID,
      getSessionFileTime(session),
      Number.isFinite(Number(nextValue)) ? Number(nextValue) : nextValue,
      Number.isFinite(Number(previousValue)) ? Number(previousValue) : previousValue,
      getSessionFileTime(session),
    ]],
  }]);
  return true;
}

function notifyMiningChargeDamageChange(
  session,
  shipID,
  moduleFlagID,
  chargeTypeID,
  nextDamage,
  previousDamage,
) {
  return notifyMiningChargeAttributeChange(
    session,
    shipID,
    moduleFlagID,
    chargeTypeID,
    ATTRIBUTE_ITEM_DAMAGE,
    round6(nextDamage),
    round6(previousDamage),
  );
}

function notifyMiningChargeRemoved(
  session,
  shipID,
  moduleFlagID,
  chargeTypeID,
  previousQuantity,
) {
  return notifyMiningChargeAttributeChange(
    session,
    shipID,
    moduleFlagID,
    chargeTypeID,
    ATTRIBUTE_QUANTITY,
    0,
    Math.max(0, toInt(previousQuantity, 0)),
  );
}

function distance(left, right) {
  const dx = toFiniteNumber(left && left.x, 0) - toFiniteNumber(right && right.x, 0);
  const dy = toFiniteNumber(left && left.y, 0) - toFiniteNumber(right && right.y, 0);
  const dz = toFiniteNumber(left && left.z, 0) - toFiniteNumber(right && right.z, 0);
  return Math.sqrt((dx ** 2) + (dy ** 2) + (dz ** 2));
}

function getSurfaceDistance(left, right) {
  return Math.max(
    0,
    distance(left && left.position, right && right.position) -
      Math.max(0, toFiniteNumber(left && left.radius, 0)) -
      Math.max(0, toFiniteNumber(right && right.radius, 0)),
  );
}

function getMiningCommandSurfaceDistance(scene, sourceEntity, targetEntity, nowMs = null) {
  if (
    scene &&
    typeof scene.getEntitySurfaceDistance === "function"
  ) {
    return scene.getEntitySurfaceDistance(sourceEntity, targetEntity);
  }
  if (scene && typeof scene.getEntitySurfaceDistance === "function") {
    return scene.getEntitySurfaceDistance(sourceEntity, targetEntity);
  }
  return getSurfaceDistance(sourceEntity, targetEntity);
}

function resolveEntityCharacterID(entity) {
  if (!entity || entity.kind !== "ship") {
    return 0;
  }
  return toInt(
    entity.session && entity.session.characterID
      ? entity.session.characterID
      : entity.characterID ?? entity.pilotCharacterID,
    0,
  );
}

function buildEphemeralShipItem(entity, characterID = 0) {
  return {
    itemID: toInt(entity && entity.itemID, 0),
    typeID: toInt(entity && entity.typeID, 0),
    ownerID: toInt(characterID, 0),
    locationID: toInt(entity && entity.systemID, 0),
    flagID: ITEM_FLAGS.HANGAR,
    singleton: 1,
    quantity: 1,
    stacksize: 1,
    itemName: String(entity && entity.itemName || ""),
  };
}

function resolveEntityShipItem(entity) {
  const characterID = resolveEntityCharacterID(entity);
  if (characterID > 0) {
    return (
      getActiveShipRecord(characterID) ||
      findShipItemById(toInt(entity && entity.itemID, 0)) ||
      buildEphemeralShipItem(entity, characterID)
    );
  }
  return buildEphemeralShipItem(entity, characterID);
}

function resolveEntitySkillMap(entity) {
  const characterID = resolveEntityCharacterID(entity);
  return characterID > 0 ? getCachedCharacterSkillMap(characterID) : new Map();
}

function resolveEntityFittedItems(entity) {
  if (!entity || entity.kind !== "ship") {
    return [];
  }
  if (isNativeNpcEntity(entity)) {
    return getNpcFittedModuleItems(entity);
  }
  const characterID = resolveEntityCharacterID(entity);
  if (characterID > 0) {
    return getFittedModuleItems(characterID, toInt(entity.itemID, 0));
  }
  return Array.isArray(entity.fittedItems) ? entity.fittedItems.map((item) => ({ ...item })) : [];
}

function resolveEntityModuleItem(entity, moduleID = 0, moduleFlagID = 0) {
  const normalizedModuleID = toInt(moduleID, 0);
  const normalizedModuleFlagID = toInt(moduleFlagID, 0);
  return resolveEntityFittedItems(entity).find((moduleItem) => (
    (
      normalizedModuleID > 0 &&
      toInt(moduleItem && moduleItem.itemID, 0) === normalizedModuleID
    ) ||
    (
      normalizedModuleFlagID > 0 &&
      toInt(moduleItem && moduleItem.flagID, 0) === normalizedModuleFlagID
    )
  )) || null;
}

function resolveEntityLoadedCharge(entity, moduleItem = null) {
  if (!entity || entity.kind !== "ship" || !moduleItem) {
    return null;
  }
  if (isNativeNpcEntity(entity)) {
    return getNpcLoadedChargeForModule(entity, moduleItem);
  }
  const characterID = resolveEntityCharacterID(entity);
  if (characterID <= 0) {
    return moduleItem.loadedChargeItem || null;
  }
  return getLoadedChargeByFlag(
    characterID,
    toInt(entity.itemID, 0),
    toInt(moduleItem.flagID, 0),
  );
}

function resolveEntityActiveModuleContexts(entity, excludeModuleID = 0) {
  if (!entity || !(entity.activeModuleEffects instanceof Map)) {
    return [];
  }
  const normalizedExcludeModuleID = toInt(excludeModuleID, 0);
  const contexts = [];
  for (const effectState of entity.activeModuleEffects.values()) {
    if (
      !effectState ||
      (
        normalizedExcludeModuleID > 0 &&
        toInt(effectState.moduleID, 0) === normalizedExcludeModuleID
      )
    ) {
      continue;
    }
    const effectRecord = getEffectTypeRecord(toInt(effectState.effectID, 0));
    const moduleItem = resolveEntityModuleItem(
      entity,
      effectState.moduleID,
      effectState.moduleFlagID,
    );
    if (!effectRecord || !moduleItem) {
      continue;
    }
    contexts.push({
      effectState,
      effectRecord,
      moduleItem,
      chargeItem: resolveEntityLoadedCharge(entity, moduleItem),
    });
  }
  return contexts;
}

function buildEntityMiningSnapshot(entity, moduleItem, effectRecord, options = {}) {
  const shipItem = resolveEntityShipItem(entity);
  const resolvedModuleItem = resolveEntityModuleItem(
    entity,
    moduleItem && moduleItem.itemID,
    moduleItem && moduleItem.flagID,
  ) || moduleItem;
  if (!shipItem || !resolvedModuleItem) {
    return null;
  }
  const additionalModifierEntries =
    commandBurstRuntime.collectModifierEntriesForItem(
      entity,
      resolvedModuleItem,
      options.nowMs,
    );
  const loadedCharge = resolveEntityLoadedCharge(entity, resolvedModuleItem);
  const additionalChargeModifierEntries = loadedCharge
    ? commandBurstRuntime.collectModifierEntriesForItem(
        entity,
        loadedCharge,
        options.nowMs,
      )
    : [];
  return buildMiningModuleSnapshot({
    characterID: resolveEntityCharacterID(entity),
    shipItem,
    moduleItem: resolvedModuleItem,
    effectRecord,
    chargeItem: loadedCharge,
    fittedItems: resolveEntityFittedItems(entity),
    skillMap: resolveEntitySkillMap(entity),
    activeModuleContexts: resolveEntityActiveModuleContexts(
      entity,
      resolvedModuleItem.itemID,
    ),
    additionalModifierEntries,
    additionalChargeModifierEntries,
    additionalLocationModifierSources: getLocationModifierSourcesForSystem(
      entity && entity.systemID,
    ),
  });
}

function prepareMiningCycleBoundary(entity, effectState, cycleBoundaryMs) {
  if (!entity || !effectState) {
    return { success: false, stopReason: "module" };
  }

  const moduleItem = resolveEntityModuleItem(
    entity,
    effectState.moduleID,
    effectState.moduleFlagID,
  );
  if (!moduleItem || !isModuleOnline(moduleItem)) {
    return { success: false, stopReason: "module" };
  }

  const effectRecord = getEffectTypeRecord(toInt(effectState.effectID, 0));
  const snapshot = buildEntityMiningSnapshot(entity, moduleItem, effectRecord, {
    nowMs: cycleBoundaryMs,
  });
  if (!snapshot) {
    return { success: false, stopReason: "module" };
  }

  return {
    success: true,
    data: {
      moduleItem,
      snapshot,
      cycleBoundaryMs,
    },
  };
}

function isMiningEffectState(effectState) {
  return Boolean(effectState && effectState.miningEffect === true);
}

function getTargetsForEntity(scene, entity) {
  return scene && typeof scene.getTargetsForEntity === "function"
    ? scene.getTargetsForEntity(entity)
    : [];
}

function computeUsedVolume(items = []) {
  return items.reduce((sum, item) => {
    if (!item) {
      return sum;
    }
    const units =
      toInt(item.singleton, 0) === 1
        ? 1
        : Math.max(0, toInt(item.stacksize ?? item.quantity, 0));
    const volume = Math.max(0, toFiniteNumber(item.volume, 0));
    return sum + (volume * units);
  }, 0);
}

function getPlayerShipStorageSnapshot(entity) {
  const characterID = resolveEntityCharacterID(entity);
  const shipID = toInt(entity && entity.itemID, 0);
  if (characterID <= 0 || shipID <= 0) {
    return null;
  }

  const shipItem = resolveEntityShipItem(entity);
  const fittedItems = resolveEntityFittedItems(entity);
  const skillMap = resolveEntitySkillMap(entity);
  const hiddenModifierItems = listHiddenModifierItems(characterID, shipID, shipItem);
  const resourceState = shipResourceStateCache.getShipResourceState(entity, {
    characterID, shipItem, fittedItems, skillMap, hiddenModifierItems,
    characterRecord: peekCharacterRecord(characterID),
  }, () => buildShipResourceState(characterID, shipItem, {
    fittedItems, skillMap, hiddenModifierItems,
  }));
  const usedByFlag = new Map();
  for (const item of listContainerItems(characterID, shipID, null)) {
    const flagID = toInt(item && item.flagID, 0);
    usedByFlag.set(flagID, round6((usedByFlag.get(flagID) || 0) + computeUsedVolume([item])));
  }

  return {
    characterID,
    shipID,
    resourceState,
    usedByFlag,
  };
}

function getAvailableVolumeForFlag(storageSnapshot, flagID) {
  if (!storageSnapshot || !storageSnapshot.resourceState) {
    return 0;
  }
  const normalizedFlagID = toInt(flagID, 0);
  const capacity =
    normalizedFlagID === ITEM_FLAGS.CARGO_HOLD
      ? toFiniteNumber(storageSnapshot.resourceState.cargoCapacity, 0)
      : getShipHoldCapacityByFlag(storageSnapshot.resourceState, normalizedFlagID);
  const used = toFiniteNumber(storageSnapshot.usedByFlag.get(normalizedFlagID), 0);
  return Math.max(0, round6(capacity - used));
}

function resolveDestinationFlagForPlayer(entity, yieldTypeID) {
  const storageSnapshot = getPlayerShipStorageSnapshot(entity);
  const preferredFlag = storageSnapshot
    ? getPreferredMiningHoldFlagForType(storageSnapshot.resourceState, yieldTypeID)
    : null;
  // A compatible mining hold is the destination, not merely the first bay
  // with free space. Falling through once that hold reaches exactly 0 m3 made
  // a repeating laser spill into ordinary cargo, while a positive sub-unit
  // sliver correctly stopped it. Cargo is the fallback only for hulls that do
  // not expose a compatible mining hold at all.
  const flagID = preferredFlag || ITEM_FLAGS.CARGO_HOLD;
  return {
    flagID,
    availableVolume: getAvailableVolumeForFlag(storageSnapshot, flagID),
  };
}

function resolveLedgerObserverContext(scene, targetEntity) {
  const candidateIDs = [
    targetEntity && targetEntity.observerItemID,
    targetEntity && targetEntity.observerID,
    targetEntity && targetEntity.structureID,
    targetEntity && targetEntity.ownerStructureID,
    targetEntity && targetEntity.sourceStructureID,
    targetEntity && targetEntity.moonMiningStructureID,
    scene && scene.observerItemID,
    scene && scene.observerID,
    scene && scene.structureID,
  ];

  let observerItemID = 0;
  for (const candidate of candidateIDs) {
    const normalized = toInt(candidate, 0);
    if (normalized > 0) {
      observerItemID = normalized;
      break;
    }
  }

  const observerNameCandidates = [
    targetEntity && targetEntity.observerItemName,
    targetEntity && targetEntity.observerName,
    targetEntity && targetEntity.structureName,
    targetEntity && targetEntity.ownerStructureName,
    targetEntity && targetEntity.sourceStructureName,
    scene && scene.observerItemName,
    scene && scene.observerName,
    scene && scene.structureName,
  ];
  let observerItemName = "";
  for (const candidate of observerNameCandidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      observerItemName = candidate.trim();
      break;
    }
  }

  return {
    observerItemID,
    observerItemName,
  };
}

function syncInventoryChangesToSession(session, changes = []) {
  for (const change of Array.isArray(changes) ? changes : []) {
    if (!change || !change.item) {
      continue;
    }
    syncInventoryItemForSession(
      session,
      change.item,
      change.previousData || change.previousState || {},
      {
        emitCfgLocation: true,
      },
    );
  }
}

function buildMinedOreChangeDict(change) {
  if (!change || change.created !== true) {
    return null;
  }
  return {
    type: "dict",
    entries: [[INV_UPDATE_LOCATION, 0]],
  };
}

function buildMinedOreNotificationItem(change) {
  if (!change || !change.item) {
    return null;
  }
  const item = { ...change.item };
  item.clientCustomInfo = change.created === true
    ? buildKeyVal([["isMined", true]])
    : null;
  return item;
}

function syncMinedOreChangesToSession(session, shipID, changes = []) {
  if (!session || typeof session.sendNotification !== "function") {
    return;
  }
  const locationContext = ["Ship", toInt(shipID, 0), "ShipCargo"];
  for (const change of Array.isArray(changes) ? changes : []) {
    const item = buildMinedOreNotificationItem(change);
    if (!item) {
      continue;
    }
    const previousState = change.previousData || change.previousState || {};
    emitItemsChangedForSession(session, item, previousState, {
      idType: "charid",
      locationContext,
      changeDict: buildMinedOreChangeDict(change),
    });
  }
}

function isCrystalTargetCompatibleWithYield(snapshot, mineableState) {
  if (!snapshot || !mineableState) {
    return false;
  }
  if (toInt(snapshot.chargeTypeID, 0) <= 0) {
    return true;
  }

  const targetTypeListID = toInt(snapshot.crystalTargetTypeListID, 0);
  const yieldTypeID = toInt(mineableState.yieldTypeID, 0);
  if (
    targetTypeListID <= 0 ||
    yieldTypeID <= 0 ||
    mineableState.yieldKind !== "ore"
  ) {
    return false;
  }

  return matchesTypeList({ typeID: yieldTypeID }, targetTypeListID);
}

function isFamilyCompatibleWithYield(snapshot, mineableState) {
  if (!snapshot || !mineableState) {
    return false;
  }
  if (snapshot.family === "gas") {
    return mineableState.yieldKind === "gas";
  }
  if (snapshot.family === "ice") {
    return mineableState.yieldKind === "ice";
  }
  return mineableState.yieldKind === "ore";
}

function isMiningSnapshotCompatibleWithState(snapshot, mineableState) {
  return (
    isFamilyCompatibleWithYield(snapshot, mineableState) &&
    isCrystalTargetCompatibleWithYield(snapshot, mineableState)
  );
}

function resolveMiningActivation(scene, entity, moduleItem, effectRecord, options = {}) {
  if (!isMiningEffectRecord(effectRecord, moduleItem)) {
    return { matched: false };
  }
  ensureSceneMiningState(scene);

  const targetID = toInt(options && options.targetID, 0);
  const targetEntity = scene.getEntityByID(targetID);
  const mineableState = getMineableState(scene, targetID);
  if (targetID <= 0) {
    return { matched: true, success: false, errorMsg: "TARGET_REQUIRED" };
  }
  if (
    !targetEntity ||
    targetEntity.airMiningTargetable === false ||
    !mineableState ||
    mineableState.remainingQuantity <= 0 ||
    !canEntitiesInteractLocally(entity, targetEntity)
  ) {
    return { matched: true, success: false, errorMsg: "TARGET_NOT_FOUND" };
  }
  if (!getTargetsForEntity(scene, entity).includes(targetID)) {
    return { matched: true, success: false, errorMsg: "TARGET_NOT_LOCKED" };
  }

  const commandTimeMs =
    scene && typeof scene.getCurrentSimTimeMs === "function"
      ? scene.getCurrentSimTimeMs()
      : Date.now();
  const snapshot = buildEntityMiningSnapshot(entity, moduleItem, effectRecord, {
    nowMs: commandTimeMs,
  });
  if (!snapshot) {
    return { matched: true, success: false, errorMsg: "UNSUPPORTED_MODULE" };
  }
  if (!isFamilyCompatibleWithYield(snapshot, mineableState)) {
    return { matched: true, success: false, errorMsg: "TARGET_INVALID_FOR_MODULE" };
  }

  const chargeItem = resolveEntityLoadedCharge(entity, moduleItem);
  if (
    chargeItem &&
    !(
      isChargeCompatibleWithModule(moduleItem.typeID, chargeItem.typeID) &&
      isCrystalTargetCompatibleWithYield(snapshot, mineableState)
    )
  ) {
    return { matched: true, success: false, errorMsg: "CHARGE_NOT_COMPATIBLE" };
  }
  const actualDistanceMeters = getMiningCommandSurfaceDistance(
    scene,
    entity,
    targetEntity,
    commandTimeMs,
  );
  const rangeDecision = {
    desiredRange: snapshot.maxRangeMeters,
    actualDistance: actualDistanceMeters,
    graceMeters: 1,
    sampledAtSimTimeMs: commandTimeMs,
  };
  if (actualDistanceMeters > snapshot.maxRangeMeters + rangeDecision.graceMeters) {
    return {
      matched: true,
      success: false,
      errorMsg: "TARGET_OUT_OF_RANGE",
      data: { rangeDecision },
    };
  }

  return {
    matched: true,
    success: true,
    data: {
      targetEntity,
      mineableState,
      runtimeAttrs: {
        capNeed: snapshot.capNeed,
        durationMs: snapshot.durationMs,
        durationAttributeID: snapshot.durationAttributeID,
        reactivationDelayMs: snapshot.reactivationDelayMs,
        maxGroupActive: snapshot.maxGroupActive,
        weaponFamily: null,
        miningSnapshot: snapshot,
      },
    },
  };
}

function appendNpcCargo(entity, typeID, quantity) {
  const miningNpcOperations = require("./miningNpcOperations");
  miningNpcOperations.appendNpcMiningCargo(entity, typeID, quantity);
}

function applyCrystalVolatility(scene, entity, moduleItem, snapshot, efficiency, effectState, cycleBoundaryMs) {
  if (!entity || !moduleItem || !snapshot || snapshot.chargeTypeID <= 0) {
    return { success: true, data: { damaged: false, burnedOut: false } };
  }
  const chargeItem = resolveEntityLoadedCharge(entity, moduleItem);
  if (!chargeItem) return { success: false, errorMsg: "CRYSTAL_NOT_FOUND" };
  return lazyRequire("../../space/runtime/loadedChargeState").applyCrystalVolatilityDamage(
    scene, entity, moduleItem, chargeItem, cycleBoundaryMs, {
      chargeAttributes: snapshot.chargeAttributes,
      chanceMultiplier: efficiency,
      cycleState: effectState,
      notifyDamage: notifyMiningChargeDamageChange,
      notifyRemoval(session, host, module, charge, result) {
        if (!session) return;
        syncInventoryChangesToSession(session, result.data.changes);
        notifyMiningChargeRemoved(session, host.itemID, module.flagID, charge.typeID,
          Math.max(1, toInt(charge.stacksize ?? charge.quantity, 0)));
      },
    },
  );
}

function executeMiningCycle(
  scene,
  entity,
  effectState,
  cycleBoundaryMs,
  options = {},
) {
  if (!scene || !entity || !effectState) {
    return { success: false, stopReason: "module" };
  }
  const efficiency = Math.min(
    1,
    Math.max(0, toFiniteNumber(options.efficiency, 1)),
  );
  if (efficiency <= 0) {
    return { success: false, stopReason: "cycle" };
  }

  const targetID = toInt(effectState.targetID, 0);
  const targetEntity = scene.getEntityByID(targetID);
  const airSettlement = lazyRequire("./airMiningSettlement");
  const airRock = airSettlement.isAirRock(targetEntity);
  if (airRock) {
    try { airSettlement.reconcile(targetEntity.dungeonSiteInstanceID, scene); }
    catch (error) { log.warn(`[AIR Mining] recovery refused: ${error.code || error.message}`); return { success: false, stopReason: "cargo" }; }
  }
  const mineableState = getMineableState(scene, targetID);
  if (
    !targetEntity ||
    targetEntity.airMiningTargetable === false ||
    !mineableState ||
    mineableState.remainingQuantity <= 0 ||
    !canEntitiesInteractLocally(entity, targetEntity)
  ) {
    return { success: false, stopReason: "target" };
  }
  if (!getTargetsForEntity(scene, entity).includes(targetID)) {
    return { success: false, stopReason: "target" };
  }

  const preparedCycle =
    options.preparedCycle &&
    options.preparedCycle.moduleItem &&
    options.preparedCycle.snapshot &&
    toInt(options.preparedCycle.moduleItem.itemID, 0) ===
      toInt(effectState.moduleID, 0) &&
    toFiniteNumber(options.preparedCycle.cycleBoundaryMs, NaN) ===
      toFiniteNumber(cycleBoundaryMs, NaN)
      ? { success: true, data: options.preparedCycle }
      : prepareMiningCycleBoundary(entity, effectState, cycleBoundaryMs);
  if (!preparedCycle.success || !preparedCycle.data) {
    return {
      success: false,
      stopReason: preparedCycle.stopReason || "module",
    };
  }
  const { moduleItem, snapshot } = preparedCycle.data;
  if (!moduleItem || !isModuleOnline(moduleItem)) {
    return { success: false, stopReason: "module" };
  }
  if (!snapshot || !isFamilyCompatibleWithYield(snapshot, mineableState)) {
    return { success: false, stopReason: "module" };
  }
  if (
    getMiningCommandSurfaceDistance(scene, entity, targetEntity, cycleBoundaryMs) >
      snapshot.maxRangeMeters + 1
  ) {
    return { success: false, stopReason: "range" };
  }

  const chargeItem = resolveEntityLoadedCharge(entity, moduleItem);
  if (
    chargeItem &&
    !(
      isChargeCompatibleWithModule(moduleItem.typeID, chargeItem.typeID) &&
      isCrystalTargetCompatibleWithYield(snapshot, mineableState)
    )
  ) {
    return { success: false, stopReason: "charge" };
  }

  if (isCrystalBurnedOut(chargeItem, buildCrystalDurabilitySnapshot(snapshot.chargeTypeID, snapshot.chargeAttributes))) {
    applyCrystalVolatility(scene, entity, moduleItem, snapshot, efficiency, effectState, cycleBoundaryMs);
    return { success: false, stopReason: "ammo" };
  }
  effectState.chargeTypeID = snapshot.chargeTypeID;
  let destinationFlagID = ITEM_FLAGS.CARGO_HOLD;
  let availableVolume = Number.POSITIVE_INFINITY;
  if (!isNativeNpcEntity(entity)) {
    const destination = resolveDestinationFlagForPlayer(
      entity,
      mineableState.yieldTypeID,
    );
    destinationFlagID = destination.flagID;
    availableVolume = destination.availableVolume;
    if (availableVolume <= 0) {
      return { success: false, stopReason: "cargo" };
    }
  }

  const miningVolume = Math.max(0, snapshot.miningAmountM3);
  const effectiveMiningVolume = miningVolume * efficiency;
  const quantityVolumeAvailable = mineableState.remainingQuantity * mineableState.unitVolume;
  const maximumTransferredQuantity = Number.isFinite(availableVolume)
    ? Math.max(0, Math.floor(availableVolume / mineableState.unitVolume))
    : Number.POSITIVE_INFINITY;
  if (maximumTransferredQuantity <= 0) {
    return { success: false, stopReason: "cargo" };
  }
  const availableTransferVolume = Number.isFinite(maximumTransferredQuantity)
    ? maximumTransferredQuantity * mineableState.unitVolume
    : availableVolume;
  const clampFactor = Math.min(
    1,
    quantityVolumeAvailable / effectiveMiningVolume,
    availableTransferVolume / effectiveMiningVolume,
  );
  if (clampFactor <= 0) {
    return {
      success: false,
      stopReason: quantityVolumeAvailable <= 0 ? "target" : "cargo",
    };
  }

  const miningResult = computeMiningResult({
    clampFactor,
    volume: miningVolume,
    unitVolume: mineableState.unitVolume,
    asteroidQuantity: mineableState.remainingQuantity,
    wasteVolumeMultiplier: snapshot.wasteVolumeMultiplier,
    wasteProbability: airRock ? 0 : snapshot.wasteProbability,
    critQuantityMultiplier: snapshot.critQuantityMultiplier,
    critProbability: airRock ? 0 : snapshot.critChance,
    efficiency,
  });
  if (Number.isFinite(maximumTransferredQuantity)) {
    miningResult.normalQuantity = Math.min(
      miningResult.normalQuantity,
      maximumTransferredQuantity,
    );
  }
  const maximumBonusQuantity = Number.isFinite(maximumTransferredQuantity)
    ? Math.max(0, maximumTransferredQuantity - miningResult.normalQuantity)
    : miningResult.criticalHitQuantity;
  miningResult.criticalHitQuantity = Math.max(
    0,
    Math.min(miningResult.criticalHitQuantity, maximumBonusQuantity),
  );
  miningResult.criticalHitVolume = miningResult.criticalHitQuantity * mineableState.unitVolume;

  const transferredQuantity = miningResult.getTotalTransferredQuantity();
  if (transferredQuantity <= 0 && miningResult.wastedQuantity <= 0) {
    return { success: false, stopReason: "cargo" };
  }

  let cargoCommit = null;
  let cargoCompensation = null;
  if (isNativeNpcEntity(entity)) {
    const cargo = require("./npcMiningCargo");
    if (shouldPersistMineableState(targetEntity)) {
      cargoCommit = require("./miningCargoCommits").commit({ scene, entity, target: targetEntity,
        state: mineableState, moduleID: moduleItem.itemID, cycleMs: cycleBoundaryMs,
        transferred: transferredQuantity, mined: miningResult.normalQuantity,
        wasted: miningResult.wastedQuantity, critical: miningResult.criticalHitQuantity });
      if (!cargoCommit.success) return { success: false, stopReason: "cargo", errorMsg: cargoCommit.errorMsg };
      cargo.refresh(entity);
      if (cargoCommit.duplicate) return { success: true, data: { targetID, duplicate: true,
        transferredQuantity: cargoCommit.data.transferred, normalQuantity: cargoCommit.data.mined,
        wastedQuantity: cargoCommit.data.wasted, criticalHitQuantity: cargoCommit.data.critical } };
    } else if (transferredQuantity > 0) {
      // Site-specific depletion stays with its existing authority. Refuse a
      // failed cargo write and compensate only this grant if depletion rejects.
      const granted = cargo.appendNpcMiningCargoWithReceipt(entity, mineableState.yieldTypeID, transferredQuantity);
      if (!granted.success) return { success: false, stopReason: "cargo" };
      cargoCompensation = granted.data.receipt;
    }
  } else {
    let grantResult;
    try {
      grantResult = airRock
        ? airSettlement.extract(scene, entity, targetEntity, mineableState, transferredQuantity, miningResult.normalQuantity + miningResult.wastedQuantity, destinationFlagID)
        : grantItemsToCharacterLocation(
      resolveEntityCharacterID(entity),
      toInt(entity.itemID, 0),
      destinationFlagID,
      [{
        itemType: mineableState.yieldTypeID,
        quantity: transferredQuantity,
      }],
      );
    } catch (error) {
      if (!airRock) throw error;
      log.warn(`[AIR Mining] extraction refused: ${error.code || error.message}`);
      return { success: false, stopReason: "cargo" };
    }
    if (!grantResult.success || !grantResult.data) {
      return { success: false, stopReason: "cargo" };
    }
    if (entity.session) {
      syncMinedOreChangesToSession(
        entity.session,
        toInt(entity.itemID, 0),
        grantResult.data.changes,
      );
    }
  }

  const deltaResult = applyMiningDelta(
    scene,
    targetEntity,
    miningResult.normalQuantity,
    miningResult.wastedQuantity,
    {
      broadcast: true,
      nowMs: cycleBoundaryMs,
      sourceEntity: entity,
      moduleItem,
      quantityAdded: transferredQuantity,
      amountWasted: miningResult.wastedQuantity,
      amountCritBonus: miningResult.criticalHitQuantity,
      hasRewards: miningResult.rewardedQuantity > 0,
      committedCargoDelta: cargoCommit?.data,
    },
  );
  if (!deltaResult.success) {
    if (cargoCompensation) require("./npcMiningCargo").rollbackNpcMiningCargoGrant(cargoCompensation, entity);
    return { success: false, stopReason: "target" };
  }

  if (!isNativeNpcEntity(entity)) {
    const miningLedgerState = require("./miningLedgerState");
    const observerContext = resolveLedgerObserverContext(scene, targetEntity);
    miningLedgerState.recordMiningLedgerEvent({
      characterID: resolveEntityCharacterID(entity),
      corporationID: toInt(
        entity &&
          entity.session &&
          (entity.session.corporationID || entity.session.corpid),
        0,
      ),
      solarSystemID: toInt(
        scene && (scene.systemID || scene.solarSystemID),
        toInt(entity && entity.systemID, 0),
      ),
      typeID: mineableState.yieldTypeID,
      quantity: transferredQuantity,
      quantityWasted: miningResult.wastedQuantity,
      quantityCritical: miningResult.criticalHitQuantity,
      shipTypeID: toInt(entity && entity.typeID, 0),
      moduleTypeID: toInt(moduleItem && moduleItem.typeID, 0),
      observerItemID: observerContext.observerItemID,
      observerItemName: observerContext.observerItemName,
      yieldKind: mineableState.yieldKind,
      eventDateMs: cycleBoundaryMs,
    });
    // Advance the "Mine N units of Ore" AIR daily goal by the units mined this
    // cycle. Ore only (gas/ice are separate contribution types). Defensive so
    // daily-goal bookkeeping can never disrupt the mining tick.
    if (mineableState.yieldKind === "ore" && transferredQuantity > 0) {
      try {
        lazyRequire("../dailyGoals/dailyGoalsState").recordActivity(
          resolveEntityCharacterID(entity),
          "mine_ore",
          transferredQuantity,
        );
      } catch (dailyGoalError) {
        log.debug(
          `[MiningRuntime] daily-goal mine_ore hook failed: ${dailyGoalError.message}`,
        );
      }
    }
    if (transferredQuantity > 0) {
      try {
        lazyRequire("../seasons/eventHooks").trail.recordMining(
          entity.session,
          toInt(scene && (scene.systemID || scene.solarSystemID), toInt(entity && entity.systemID, 0)),
          mineableState.yieldTypeID,
          transferredQuantity,
        );
      } catch (campaignError) {
        log.debug(`[MiningRuntime] Gallente mining challenge hook failed: ${campaignError.message}`);
      }
      try {
        lazyRequire("../achievement/achievementRuntime").recordMining(
          resolveEntityCharacterID(entity),
          toInt(
            scene && (scene.systemID || scene.solarSystemID),
            toInt(entity && entity.systemID, 0),
          ),
          mineableState.yieldTypeID,
          transferredQuantity,
        );
      } catch (achievementError) {
        log.debug(
          `[MiningRuntime] achievement mining hook failed: ${achievementError.message}`,
        );
      }
    }
  }

  // Ore and depletion are already committed. Durability failure stops future
  // cycles without making this payout repeatable.
  const crystalResult = applyCrystalVolatility(scene, entity, moduleItem, snapshot, efficiency, effectState, cycleBoundaryMs);
  if (!crystalResult.success) log.warn(`[Mining] crystal durability failed: ${crystalResult.errorMsg}`);
  return {
    success: true,
    data: {
      targetID,
      yieldTypeID: mineableState.yieldTypeID,
      transferredQuantity,
      normalQuantity: miningResult.normalQuantity,
      criticalHitQuantity: miningResult.criticalHitQuantity,
      wastedQuantity: miningResult.wastedQuantity,
      efficiency,
      partialCycle: options.partialCycle === true,
      crystalResult,
      stopReason: !crystalResult.success || crystalResult.data?.burnedOut ? "ammo" : null,
      depleted: Boolean(deltaResult.data && deltaResult.data.depleted),
      nextCycleRuntimeAttrs: {
        capNeed: snapshot.capNeed,
        durationMs: snapshot.durationMs,
        durationAttributeID: snapshot.durationAttributeID,
      },
    },
  };
}

function resolveSceneForSession(session) {
  if (!session || !session._space) {
    return null;
  }
  const spaceRuntime = lazyRequire("../../space/runtime");
  return spaceRuntime.getSceneForSession(session);
}

function buildScanResultsForSession(session) {
  if (config.miningEnabled !== true) {
    return [];
  }
  const scene = resolveSceneForSession(session);
  if (!scene) {
    return [];
  }
  ensureSceneMiningState(scene);
  const shipEntity = scene.getShipEntityForSession(session);
  if (!shipEntity) {
    return [];
  }

  const maxDistanceMeters = Math.max(
    1,
    toFiniteNumber(config.miningSurveyScanDistanceMeters, 250_000),
  );
  const scanResults = [];
  for (const entity of scene.getVisibleEntitiesForSession(session)) {
    if (
      !isMineableStaticEntity(entity) ||
      !canEntitiesInteractLocally(shipEntity, entity)
    ) {
      continue;
    }
    const state = getMineableState(scene, entity.itemID);
    if (!state || state.remainingQuantity <= 0) {
      continue;
    }
    if (getSurfaceDistance(shipEntity, entity) > maxDistanceMeters) {
      continue;
    }
    scanResults.push({
      entityID: toInt(entity.itemID, 0),
      yieldTypeID: toInt(state.yieldTypeID, 0),
      remainingQuantity: toInt(state.remainingQuantity, 0),
      distance: getSurfaceDistance(shipEntity, entity),
    });
  }

  scanResults.sort(
    (left, right) =>
      left.distance - right.distance ||
      left.entityID - right.entityID,
  );
  return scanResults.map((entry) => [
    entry.entityID,
    entry.yieldTypeID,
    entry.remainingQuantity,
  ]);
}

function findMiningEffectRecordForModule(moduleItem) {
  const { getTypeEffectRecords: getEffects } = lazyRequire("../fitting/liveFittingState");
  return getEffects(toInt(moduleItem && moduleItem.typeID, 0))
    .find((effectRecord) => isMiningEffectRecord(effectRecord, moduleItem)) || null;
}

function findFirstMiningModule(entity) {
  return resolveEntityFittedItems(entity)
    .find((moduleItem) => isModuleOnline(moduleItem) && findMiningEffectRecordForModule(moduleItem))
    || null;
}

function resolveMineableCandidates(scene, interactionSource = null) {
  ensureSceneMiningState(scene);
  return scene.staticEntities
    .filter((entity) => (
      isMineableStaticEntity(entity) &&
      (!interactionSource || canEntitiesInteractLocally(interactionSource, entity))
    ))
    .map((entity) => ({
      entity,
      state: getMineableState(scene, entity.itemID),
    }))
    .filter((entry) => entry.state && entry.state.remainingQuantity > 0);
}

function chooseMineableTargetForFleet(scene, fleetRecord) {
  const interactionSource = (
    Array.isArray(fleetRecord && fleetRecord.minerEntityIDs)
      ? fleetRecord.minerEntityIDs
      : []
  )
    .map((entityID) => scene.getEntityByID(toInt(entityID, 0)))
    .find(Boolean) || null;
  const candidates = resolveMineableCandidates(scene, interactionSource);
  if (candidates.length <= 0) {
    return null;
  }

  const preferredTarget = scene.getEntityByID(toInt(fleetRecord && fleetRecord.targetShipID, 0));
  const referencePosition =
    (preferredTarget && preferredTarget.position) ||
    (
      fleetRecord &&
      fleetRecord.originAnchor &&
      fleetRecord.originAnchor.position
    ) ||
    { x: 0, y: 0, z: 0 };

  candidates.sort(
    (left, right) =>
      distance(left.entity.position, referencePosition) -
        distance(right.entity.position, referencePosition) ||
      toInt(left.entity.itemID, 0) - toInt(right.entity.itemID, 0),
  );
  return candidates[0].entity || null;
}

function buildNpcPseudoSession(entity) {
  return {
    characterID: toInt(entity && (entity.pilotCharacterID ?? entity.characterID), 0),
    corporationID: toInt(entity && entity.corporationID, 0),
    allianceID: toInt(entity && entity.allianceID, 0),
    _space: {
      systemID: toInt(entity && entity.systemID, 0),
      shipID: toInt(entity && entity.itemID, 0),
    },
  };
}

function handleSceneCreated(scene) {
  const miningResourceSiteService = require("./miningResourceSiteService");
  if (
    miningResourceSiteService &&
    typeof miningResourceSiteService.handleSceneCreated === "function"
  ) {
    miningResourceSiteService.handleSceneCreated(scene);
  }
  // Moon chunks and the ore fields of fractured chunks, before the mining
  // cache is built so each rock picks up the ore saved for it.
  try {
    require("../structure/moonMiningSpaceRuntime").handleSceneCreated(scene);
  } catch (error) {
    log.warn(`[Mining] moon mining content for system ${scene && scene.systemID} failed to load: ${error.message}`);
  }
  ensureSceneMiningState(scene);
  const restoredWrecks = require("../../space/npc/nativeNpcWreckService").restoreMiningCargoWrecksForScene(scene);
  if (!restoredWrecks.success) throw new Error(`Mined ore wreck recovery refused: ${restoredWrecks.errorMsg}`);
  const miningNpcOperations = require("./miningNpcOperations");
  if (typeof miningNpcOperations.handleSceneCreated === "function") {
    miningNpcOperations.handleSceneCreated(scene);
  }
}

function handleSceneDisposed(scene) {
  const miningNpcOperations = require("./miningNpcOperations");
  if (typeof miningNpcOperations.handleSceneDisposed !== "function") {
    return {
      clearedStartupSeedCount: 0,
      removedFleetCount: 0,
    };
  }
  return miningNpcOperations.handleSceneDisposed(scene);
}

function tickScene(scene, now) {
  ensureSceneMiningState(scene);
  const miningNpcOperations = require("./miningNpcOperations");
  if (typeof miningNpcOperations.tickScene === "function") {
    miningNpcOperations.tickScene(scene, now, {
      autoMineEnabled: config.miningNpcFleetAutoMineEnabled === true,
      chooseMineableTargetForFleet,
      findMiningEffectRecordForModule,
      buildEntityMiningSnapshot,
      isMiningSnapshotCompatibleWithState,
      getSurfaceDistance,
      getTargetsForEntity,
      buildNpcPseudoSession,
    });
  }
}

module.exports = {
  _testing: { getPlayerShipStorageSnapshot },
  handleSceneCreated,
  handleSceneDisposed,
  tickScene,
  isMiningEffectRecord,
  isMiningEffectState,
  isMiningSnapshotCompatibleWithState,
  resolveMiningActivation,
  prepareMiningCycleBoundary,
  executeMiningCycle,
  miningModuleCanShortCycle,
  buildScanResultsForSession,
};
