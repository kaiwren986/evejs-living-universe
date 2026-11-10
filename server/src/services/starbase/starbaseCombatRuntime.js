"use strict";

// Category 23 keeps ordinary damage/custody engines. This adapter owns only
// POS lifecycle consequences and the durable intent needed to retry teardown.
const items = require("../inventory/itemStore");
const resources = require("./starbaseResourceRuntime");
const number = (value) => Number(value) || 0;
const failed = (errorMsg) => ({ success: false, errorMsg });

function isStarbase(entity) {
  return Boolean(entity && number(entity.categoryID) === 23 && number(entity.groupID) !== 411);
}

function resolveSpaceItem(entity) {
  const item = items.findItemById(number(entity && entity.itemID || entity));
  if (!isStarbase(item) || !item.spaceState || number(item.flagID) !== 0 ||
      number(item.locationID) !== number(item.spaceState.systemID)) return null;
  if (entity && typeof entity === "object" &&
      (number(entity.typeID) !== number(item.typeID) ||
       number(entity.systemID || entity.spaceState?.systemID) !== number(item.locationID))) return null;
  return item;
}

function pendingDestruction(item) {
  return Boolean(item?.spaceState?.starbaseModuleState?.destruction?.version === 1);
}

function syncEntity(entity, item) {
  entity.conditionState = { ...item.conditionState };
  entity.spaceState = { ...item.spaceState };
  for (const key of ["onlineState", "online", "incapacitated", "controlTowerID",
    "onlineStartedAtMs", "onlineCompletesAtMs", "anchorStartedAtMs", "anchorCompletesAtMs",
    "starbaseModuleState"]) entity[key] = item.spaceState[key];
  const presentation = require("../ship/controlTowerRuntime").getControlTowerPresentationState(item);
  Object.assign(entity, presentation);
}

function stopOperation(scene, itemID, reason) {
  require("./starbaseModuleRuntime").clearModuleTimer(itemID);
  if (!scene) return;
  const control = require("./starbaseControlRuntime");
  const entity = scene.getEntityByID(itemID);
  const observer = control.getStarbaseControlObserver(entity);
  if (observer) control.relinquishStructureControl(observer, itemID);
  require("./starbaseDefenseController").forgetStructure(scene, itemID);
  require("./starbaseDefenseRuntime").stopBattery(scene, itemID, { reason });
}

function safely(callback) {
  try { callback(); } catch (error) {
    require("../../utils/logger").warn(`[StarbaseCombat] presentation cleanup failed: ${error.message}`);
  }
}

// Reinforcement may clamp an otherwise lethal hit. Combat logs and later
// callbacks must see actual delivered damage, never the pre-clamp proposal.
function clampDamageResult(result, condition) {
  const data = result.data;
  const ratios = { shield: number(condition.shieldCharge),
    armor: 1 - number(condition.armorDamage), structure: 1 - number(condition.damage) };
  data.afterConditionState = { ...condition };
  for (const layer of data.perLayer) {
    const afterHP = data.maxLayers[layer.layer] * Math.max(0, Math.min(1, ratios[layer.layer]));
    const applied = Math.max(0, layer.beforeHP - afterHP);
    const scale = layer.appliedEffective > 0 ? applied / layer.appliedEffective : 0;
    layer.appliedRaw = Object.fromEntries(Object.entries(layer.appliedRaw).map(([key, value]) => [key, value * scale]));
    layer.appliedEffective = applied;
    layer.afterHP = afterHP;
    data.afterLayers[layer.layer] = afterHP;
  }
  data.remainingRaw = Object.fromEntries(Object.entries(data.rawDamage).map(([key, value]) =>
    [key, Math.max(0, value - data.perLayer.reduce((sum, layer) => sum + number(layer.appliedRaw[key]), 0))]));
  data.destroyed = number(condition.damage) >= 1;
}

function commitStarbaseDamage(scene, entity, result, options = {}) {
  const before = result.data.beforeConditionState;
  const rollback = (failure) => { entity.conditionState = { ...before }; return failure; };
  const item = resolveSpaceItem(entity);
  if (!item || pendingDestruction(item)) return rollback(failed("STARBASE_UNAVAILABLE"));
  let intercepted;
  try {
    intercepted = require("./starbaseReinforcementRuntime").interceptControlTowerDamage(
      entity, before, entity.conditionState, { ...options, refreshPresentation: true });
  } catch (error) { return rollback(failed(error.message)); }
  if (!intercepted.success) return rollback(intercepted);
  if (intercepted.protected) {
    entity.conditionState = { ...intercepted.conditionState };
    clampDamageResult(result, entity.conditionState);
    if (intercepted.entered) syncEntity(entity, items.findItemById(item.itemID));
    return { success: true, immune: !intercepted.entered, reinforced: true };
  }
  const incapacitated = resources.isStarbaseModule(item) &&
    (entity.conditionState.incapacitated || number(entity.conditionState.armorDamage) >= 1);
  const changedIncap = incapacitated && !item.conditionState?.incapacitated;
  let saved;
  try {
    saved = result.data.destroyed
      ? destroyStarbase(item.itemID, { ...options, stageOnly: true })
      : items.updateInventoryItem(item.itemID, (current) => ({ ...current,
      conditionState: { ...entity.conditionState, incapacitated: Boolean(incapacitated) },
      spaceState: { ...current.spaceState,
        ...(intercepted.reinforcementState ? { starbaseReinforcementState: intercepted.reinforcementState } : {}),
        ...(incapacitated ? { incapacitated: 1, online: 0, onlineState: "offline",
          onlineStartedAtMs: null, onlineCompletesAtMs: null } : {}),
      },
    }));
  } catch (error) { return rollback(failed(error.message)); }
  if (!saved.success) return rollback(saved);
  syncEntity(entity, saved.data);
  result.data.afterConditionState = { ...entity.conditionState };
  if (changedIncap) {
    safely(() => stopOperation(scene, item.itemID, "incapacitated"));
    safely(() => scene?.broadcastSlimItemChanges?.([entity]));
  }
  return { success: true, data: saved.data };
}

function inactiveSpaceState(item) {
  const state = item.spaceState;
  return { ...state, onlineState: "offline", online: 0,
    onlineStartedAtMs: null, onlineCompletesAtMs: null,
    anchorStartedAtMs: null, anchorCompletesAtMs: null,
    ...(state.starbaseFuelState ? { starbaseFuelState: {
      ...state.starbaseFuelState, active: false, nextCycleAtMs: null,
    } } : {}),
    ...(state.starbaseReinforcementState ? { starbaseReinforcementState: {
      ...state.starbaseReinforcementState, active: false,
    } } : {}),
  };
}

function destroyStarbase(itemOrEntity, options = {}) {
  const itemID = number(itemOrEntity?.itemID || itemOrEntity);
  let item = items.findItemById(itemID);
  if (!item) return { success: true, data: { entityID: itemID, alreadyDestroyed: true } };
  if (!resolveSpaceItem(itemID)) return failed("ITEM_CUSTODY_SOURCE_MISMATCH");
  const scene = options.scene || null;
  if (scene && number(scene.systemID) !== number(item.locationID)) return failed("ITEM_CUSTODY_SOURCE_MISMATCH");
  const tower = resources.isControlTower(item);
  if (!pendingDestruction(item)) {
    const dependents = tower ? resources.listTowerModules(item).filter(isStarbase) : [];
    const fieldIDs = tower ? require("../ship/controlTowerRuntime")
      .listControlTowerForceFields(item).map((field) => field.itemID) : [];
    const updates = [
      { itemID, updater: (current) => ({ ...current,
        conditionState: { ...current.conditionState, damage: 1, armorDamage: 1, shieldCharge: 0, incapacitated: true },
        spaceState: { ...inactiveSpaceState(current), incapacitated: 1,
          starbaseModuleState: { ...current.spaceState.starbaseModuleState,
            destruction: { version: 1, startedAtMs: number(options.nowMs) || Date.now(),
              dependentIDs: dependents.map((module) => module.itemID), fieldIDs },
          },
        },
      }) },
      ...dependents.map((module) => ({ itemID: module.itemID, updater: (current) => ({ ...current,
        spaceState: { ...inactiveSpaceState(current), controlTowerID: null,
          starbaseDisabledReason: "controlTowerDestroyed",
          starbaseModuleState: { ...current.spaceState.starbaseModuleState, formerControlTowerID: itemID },
        },
      }) })),
    ];
    const byID = new Map(updates.map((entry) => [entry.itemID, entry.updater]));
    const staged = items.updateInventoryItemsAtomic([...byID.keys()], (current) => byID.get(current.itemID)(current));
    if (!staged.success) return staged;
    item = items.findItemById(itemID);
  }
  require("./starbaseTravelRuntime").notifyInfrastructureChanged(item);
  if (options.stageOnly) return { success: true, data: item };
  const production = require("./starbaseProductionCycles").invalidateProductionForItem(item, { ...options, destroyed: true });
  if (!production.success) return production;
  const marker = item.spaceState.starbaseModuleState.destruction;
  for (const targetID of [itemID, ...(marker.dependentIDs || [])]) {
    const saved = items.findItemById(targetID);
    const entity = scene?.getEntityByID(targetID);
    if (saved && entity) syncEntity(entity, saved);
    safely(() => stopOperation(scene, targetID, "destroyed"));
    if (entity && targetID !== itemID) safely(() => scene.broadcastSlimItemChanges?.([entity]));
  }
  for (const targetID of [itemID, ...(marker.dependentIDs || [])]) {
    if (!require("./starbaseTravelRuntime").prepareDestruction(targetID)) return failed("STARBASE_TRAVEL_SETTLEMENT_PENDING");
    const industry = require("../industry/starbaseIndustryRuntime")
      .reconcileAssemblyJobs(targetID, { destroyed: true });
    if (!industry.success) return industry;
  }
  if (tower) {
    const towers = require("../ship/controlTowerRuntime");
    towers.clearControlTowerRuntimeTimers(itemID);
    require("./starbaseReinforcementRuntime").clearReinforcementTimer?.(itemID);
    const fuel = require("./starbaseFuelRuntime").deactivateControlTowerFuelState(item);
    if (!fuel.success) return fuel;
    let fields;
    try {
      fields = towers.removeControlTowerForceFields(item, {
        updateScene: Boolean(scene), broadcast: options.broadcast !== false,
      });
    } catch (error) {
      require("../../utils/logger").warn(`[StarbaseCombat] field cleanup pending: ${error.message}`);
      return failed("STARBASE_FORCE_FIELD_CLEANUP_PENDING");
    }
    if (!fields.success) return fields;
    // Inventory may have committed before a presentation callback failed. Keep
    // IDs in the root intent so that a now-unpersisted ghost field is retryable.
    for (const fieldID of marker.fieldIDs || []) {
      const field = scene?.getEntityByID(fieldID);
      if (field) safely(() => scene.unregisterDynamicEntity(field,
        { broadcast: options.broadcast !== false, persistSpaceState: false }));
      if (scene?.getEntityByID(fieldID)) return failed("STARBASE_FORCE_FIELD_CLEANUP_PENDING");
    }
  }
  const custody = require("../inventory/itemCustody");
  const removed = custody.transfer({ items: { itemID },
    from: custody.custodyRef.inSpace(item.ownerID, item.locationID, item.spaceState),
    to: custody.custodyRef.void(), reason: custody.CUSTODY_REASON.SPACE_ENTITY_DESTROY,
    actor: number(options.actor) || null, idempotencyKey: `starbase-destroy:${itemID}`,
    options: { removeContents: true },
  });
  if (!removed.success) return removed;
  const entity = scene?.getEntityByID(itemID);
  if (entity) {
    entity.destroyed = true;
    entity.removed = true;
    entity.destroying = false;
    entity.destructionState = "destroyed";
    entity.persistSpaceState = false;
    safely(() => scene.unregisterDynamicEntity(entity, { ...options, persistSpaceState: false }));
  }
  return { success: true, data: { entityID: itemID, changes: removed.data?.changes || [] } };
}

function reconcileStarbaseDestructions(systemID, options = {}) {
  // Live ticks inspect only scene balls; startup uses authoritative saved rows.
  // Collect the starbase balls before acting, because destruction unregisters
  // entities, instead of copying every ball in the scene ten times a second.
  let candidates;
  if (options.scene) {
    candidates = [];
    for (const entity of options.scene.dynamicEntities.values()) {
      if (isStarbase(entity)) candidates.push(entity);
    }
  } else {
    candidates = options.systemSpaceItems || items.listSystemSpaceItems(systemID);
  }
  const results = [];
  for (const item of candidates) {
    if (isStarbase(item) && pendingDestruction(item)) {
      results.push(destroyStarbase(item.itemID, options));
    } else if (options.scene && isStarbase(item) && item.destroyed && !items.findItemById(item.itemID)) {
      safely(() => options.scene.unregisterDynamicEntity(item, { persistSpaceState: false }));
    }
  }
  return results;
}

module.exports = { isStarbase, resolveSpaceItem, pendingDestruction,
  commitStarbaseDamage, destroyStarbase, reconcileStarbaseDestructions };
