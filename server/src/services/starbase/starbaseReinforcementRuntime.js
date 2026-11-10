"use strict";

// Legacy POS reinforcement owns a single durable deadline, not Upwell timers.
// Keep dependencies lazy: itemStore calls the pure normalizer while loading.
const STRONTIUM_TYPE_ID = 16275;
const STRONTIUM_BAY_FLAG = 122;
const ENTRY_SHIELD_FRACTION = 0.25;
const REARM_SHIELD_FRACTION = 0.5;
const timers = new Map();
const integer = (value, fallback = 0) => Number.isFinite(Number(value))
  ? Math.trunc(Number(value)) : fallback;
const store = () => require("../inventory/itemStore");
const resources = () => require("./starbaseResourceRuntime");
const towerRuntime = () => require("../ship/controlTowerRuntime");

function normalizeReinforcementState(value = {}) {
  const timestamp = (input) => Math.max(0, integer(input)) || null;
  const startedAtMs = timestamp(value.startedAtMs);
  const endsAtMs = timestamp(value.endsAtMs);
  return {
    version: 1,
    active: value.active === true && startedAtMs !== null && endsAtMs > startedAtMs,
    startedAtMs,
    endsAtMs,
    exitedAtMs: timestamp(value.exitedAtMs),
    strontiumConsumed: Math.max(0, integer(value.strontiumConsumed)),
    canReinforce: value.canReinforce !== false,
  };
}

function resolveItem(itemOrID) {
  return itemOrID && typeof itemOrID === "object" ? itemOrID
    : store().findItemById(integer(itemOrID));
}

function getReinforcementState(itemOrID) {
  const item = resolveItem(itemOrID);
  return normalizeReinforcementState(item && item.spaceState &&
    item.spaceState.starbaseReinforcementState || {});
}

function isReinforced(itemOrID, nowMs = Date.now()) {
  const item = resolveItem(itemOrID);
  const state = getReinforcementState(item);
  return resources().isControlTower(item) && state.active && integer(nowMs) < state.endsAtMs;
}

function getReinforcementProfile(itemOrID) {
  const item = resolveItem(itemOrID);
  if (!resources().isControlTower(item)) return null;
  const { TABLE, readStaticTable } = require("../_shared/referenceData");
  const table = readStaticTable(TABLE.TYPE_DOGMA) || {};
  const attributes = table.typesByTypeID && table.typesByTypeID[String(item.typeID)] &&
    table.typesByTypeID[String(item.typeID)].attributes || {};
  const size = integer(attributes[1031]);
  if (size < 1 || size > 3) return null;
  // Pinned controlTowerResources purpose4: small100/medium200/large400 per
  // tower period. Attribute1233 is exclusively the secondary Strontium bay.
  return {
    typeID: STRONTIUM_TYPE_ID,
    flagID: STRONTIUM_BAY_FLAG,
    quantityPerPeriod: [4361, 16286].includes(Number(item.typeID))
      ? 200 : 100 * (2 ** (size - 1)),
    periodMs: Math.max(1, integer(attributes[722], 3600000)),
    capacity: Math.max(0, Number(attributes[1233]) || 0),
  };
}

function clearTimer(itemID) {
  const timer = timers.get(integer(itemID));
  if (timer) clearTimeout(timer);
  timers.delete(integer(itemID));
}

function schedule(tower, options) {
  clearTimer(tower.itemID);
  const state = getReinforcementState(tower);
  if (!state.active || options.schedule === false) return;
  const timer = setTimeout(() => {
    timers.delete(tower.itemID);
    try {
      const result = reconcileControlTowerReinforcement(tower.itemID);
      if (result.success) require("./starbaseFuelRuntime").reconcileControlTowerFuel(tower.itemID);
      else schedule(tower, {});
    } catch (error) {
      require("../../utils/logger").warn(`[StarbaseReinforcement] reconciliation failed: ${error.message}`);
      schedule(tower, {});
    }
  }, Math.min(2147000000, Math.max(1000, state.endsAtMs - Date.now())));
  if (timer.unref) timer.unref();
  timers.set(tower.itemID, timer);
}

function publishChanges(changes, options = {}) {
  for (const change of changes) require("./starbaseTravelRuntime").notifyInfrastructureChanged(change.item || change.previousData);
  if (options.refreshPresentation === false) return;
  // A failed observer cannot roll back a committed deadline or strand its timer.
  const runtime = require("../../space/runtime");
  for (const change of changes) {
    const item = change.item || change.previousData;
    if (!item || !item.spaceState) continue;
    try {
      const scene = runtime.getSceneByDescriptor(item.spaceState.systemID || item.locationID);
      if (scene && scene.getEntityByID(item.itemID)) {
        scene.refreshInventoryBackedEntityPresentation(item.itemID, { broadcast: true });
        if (resources().isControlTower(item)) {
          runtime.broadcastEntityDamageStateChange(item.spaceState.systemID || item.locationID, item.itemID);
        }
      }
    } catch (error) {
      require("../../utils/logger").warn(`[StarbaseReinforcement] presentation failed: ${error.message}`);
    }
  }
  const inventoryChanges = changes.filter((change) =>
    (change.item || change.previousData)?.typeID === STRONTIUM_TYPE_ID);
  if (inventoryChanges.length) {
    try { require("../inventory/corporationOfficeInventoryObservers")
      .fanStarbaseInventoryChanges(inventoryChanges, { actorSession: options.session }); }
    catch (_) { /* ignored: a disconnected observer cannot undo entry */ }
  }
  if (typeof options.onInventoryChanges === "function") {
    try { options.onInventoryChanges(changes); } catch (_) { /* ignored: committed state wins */ }
  }
}

function reconcileControlTowerReinforcement(itemOrID, options = {}) {
  const tower = store().findItemById(integer(itemOrID && itemOrID.itemID || itemOrID));
  if (!resources().isControlTower(tower)) return { success: false, errorMsg: "ITEM_NOT_CONTROL_TOWER" };
  const nowMs = Math.max(1, integer(options.nowMs, Date.now()));
  const state = getReinforcementState(tower);
  if (!state.active) return { success: true, data: tower, active: false, exited: false };
  if (nowMs < state.endsAtMs) {
    schedule(tower, options);
    return { success: true, data: tower, active: true, exited: false };
  }
  const result = store().updateInventoryItem(tower.itemID, (item) => ({
    ...item,
    spaceState: { ...item.spaceState, starbaseReinforcementState: {
      ...state, active: false, exitedAtMs: state.endsAtMs, canReinforce: false,
    } },
  }));
  if (!result.success) return result;
  clearTimer(tower.itemID);
  publishChanges([{ previousData: tower, item: result.data }], options);
  return { ...result, active: false, exited: true };
}

function interceptControlTowerDamage(entity, before, proposed, options = {}) {
  const itemID = integer(entity && (entity.itemID || entity.id) || entity);
  const tower = store().findItemById(itemID);
  const unchanged = { success: true, protected: false, entered: false, conditionState: proposed };
  if (!resources().isControlTower(tower)) return unchanged;
  const nowMs = Math.max(1, integer(options.nowMs, Date.now()));
  const state = getReinforcementState(tower);
  if (isReinforced(tower, nowMs)) {
    return { ...unchanged, protected: true, conditionState: { ...before }, reinforcementState: state };
  }
  const shieldBefore = Number((before && before.shieldCharge) ?? 1);
  const shieldAfter = Number((proposed && proposed.shieldCharge) ?? 1);
  const canReinforce = state.canReinforce || shieldBefore >= REARM_SHIELD_FRACTION;
  if (!state.canReinforce && shieldBefore >= REARM_SHIELD_FRACTION && shieldAfter > ENTRY_SHIELD_FRACTION) {
    // Remember recovery even if several smaller hits separate 50% from 25%.
    // The ordinary combat commit saves this latch together with proposed HP;
    // failure must leave both unchanged, not grant a free state-only write.
    return { ...unchanged, reinforcementState: { ...state, active: false, canReinforce: true } };
  }
  if (!canReinforce || shieldBefore <= ENTRY_SHIELD_FRACTION || shieldAfter > ENTRY_SHIELD_FRACTION ||
      !towerRuntime().getControlTowerOnlineState(tower).isOnline ||
      require("./starbaseDefenseRuntime").hasUnavailableHealth(tower)) return unchanged;
  const profile = getReinforcementProfile(tower);
  if (!profile) return unchanged;
  const stacks = store().listContainerItems(null, itemID, STRONTIUM_BAY_FLAG)
    .filter((item) => item.typeID === STRONTIUM_TYPE_ID && item.ownerID === tower.ownerID && !item.singleton)
    .sort((a, b) => a.itemID - b.itemID);
  const total = stacks.reduce((sum, item) => sum + Math.max(0, integer(item.stacksize ?? item.quantity)), 0);
  const quantity = Math.min(total, Math.floor(profile.capacity / 3));
  if (quantity <= 0) return unchanged;
  const durationMs = Math.floor(quantity * profile.periodMs / profile.quantityPerPeriod);
  const conditionState = { ...before, shieldCharge: ENTRY_SHIELD_FRACTION };
  const reinforcementState = normalizeReinforcementState({
    active: true, startedAtMs: nowMs, endsAtMs: nowMs + durationMs,
    strontiumConsumed: quantity, canReinforce: false,
  });
  const fuel = require("./starbaseFuelRuntime");
  const requests = fuel._testing.buildStackRequests(stacks, quantity, itemID);
  const modules = resources().listTowerModules(tower).filter((item) =>
    resources().getStarbaseResourceProfile(item).cpuUsage > 0 &&
    ["online", "onlining"].includes(item.spaceState.onlineState));
  const associatedUpdates = [{ itemID, expectedItem: tower, updater: (item) => ({
    ...item, conditionState,
    spaceState: {
      ...item.spaceState, starbaseReinforcementState: reinforcementState,
      ...(item.spaceState.starbaseFuelState && item.spaceState.starbaseFuelState.active
        ? { starbaseFuelState: { ...item.spaceState.starbaseFuelState,
            nextCycleAtMs: (integer(item.spaceState.starbaseFuelState.nextCycleAtMs) || nowMs) + durationMs } }
        : {}),
    },
  }) }, ...modules.map((module) => ({ itemID: module.itemID, expectedItem: module,
    updater: (item) => ({ ...item, spaceState: { ...item.spaceState,
      onlineState: "offline", online: 0, onlineStartedAtMs: null, onlineCompletesAtMs: null,
      starbaseDisabledReason: "controlTowerReinforced", starbaseDisabledAtMs: nowMs,
    } }),
  }))];
  const result = store().consumeInventoryItemStacksAtomic(requests, { associatedUpdates });
  if (!result.success) return { ...result, conditionState: { ...before } };
  const updated = store().findItemById(itemID);
  fuel._testing.clearFuelTimer(itemID);
  schedule(updated, options);
  try { require("../industry/starbaseIndustryRuntime").reconcileAssemblyJobs(itemID); }
  catch (error) { require("../../utils/logger").warn(`[StarbaseReinforcement] industry reconciliation pending: ${error.message}`); }
  publishChanges(result.changes, options);
  return { success: true, protected: true, entered: true, conditionState, reinforcementState,
    data: updated, inventoryChanges: result.changes };
}

function validateTowerBayMutation(tower, flagID, nowMs = Date.now()) {
  if (!resources().isControlTower(tower)) return null;
  if (isReinforced(tower, nowMs)) return "CONTROL_TOWER_REINFORCED";
  if (integer(flagID) === STRONTIUM_BAY_FLAG &&
      Number((tower.conditionState && tower.conditionState.shieldCharge) ?? 1) < REARM_SHIELD_FRACTION) {
    return "CONTROL_TOWER_STRONTIUM_SHIELD_TOO_LOW";
  }
  return null;
}

module.exports = {
  STRONTIUM_TYPE_ID, STRONTIUM_BAY_FLAG, ENTRY_SHIELD_FRACTION, REARM_SHIELD_FRACTION,
  normalizeReinforcementState, getReinforcementState, isReinforced, getReinforcementProfile,
  interceptControlTowerDamage, reconcileControlTowerReinforcement, validateTowerBayMutation,
  clearReinforcementTimer: clearTimer,
  _testing: { clearTimers() { for (const id of timers.keys()) clearTimer(id); } },
};
