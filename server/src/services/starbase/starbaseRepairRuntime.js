"use strict";

const items = require("../inventory/itemStore");
const resources = require("./starbaseResourceRuntime");

const CATEGORY_STARBASE = 23;
const REMOTE_REPAIR_FAMILIES = new Set(["remoteShield", "remoteArmor", "remoteHull"]);

function number(value, fallback = 0) {
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
}

function isStarbaseEntity(entity) {
  return Boolean(entity && number(entity.categoryID) === CATEGORY_STARBASE);
}

function isTerminal(value) {
  const state = value && value.spaceState || {};
  return !value || value.destroyed === true || value.removed === true ||
    value.destructionState === "destroyed" ||
    state.destructionState === "destroyed" ||
    number(state.starbaseModuleState?.destruction?.version) === 1 ||
    number(value.conditionState && value.conditionState.damage) >= 1;
}

// Category 23 uses the ordinary per-layer assistance effects, not the Upwell
// repair timer. Re-read custody/lifecycle on activation AND on every delivery;
// a stale scene ball must never recreate a destroyed or scooped inventory row.
function validateStarbaseRepairTarget(entity, { scene = null, nowMs = Date.now() } = {}) {
  if (!isStarbaseEntity(entity)) return { success: false, errorMsg: "TARGET_NOT_FOUND" };
  const item = items.findItemById(number(entity.itemID));
  const state = item && item.spaceState || {};
  const systemID = number(state.systemID);
  if (!isStarbaseEntity(item) || number(item.typeID) !== number(entity.typeID) ||
      systemID <= 0 || systemID !== number(entity.systemID) ||
      number(item.locationID) !== systemID || number(item.flagID) !== 0 ||
      (scene && (number(scene.systemID) !== systemID || scene.getEntityByID(entity.itemID) !== entity))) {
    return { success: false, errorMsg: "TARGET_NOT_FOUND" };
  }
  if (isTerminal(item) || isTerminal(entity)) {
    return { success: false, errorMsg: "TARGET_NOT_FOUND" };
  }
  if (state.anchorState !== "anchored") {
    return { success: false, errorMsg: "STARBASE_REPAIR_REQUIRES_ANCHORED_TARGET" };
  }
  if (resources.isControlTower(item) &&
      require("./starbaseReinforcementRuntime").isReinforced(item, nowMs)) {
    return { success: false, errorMsg: "STARBASE_REINFORCED" };
  }
  return { success: true, data: { item } };
}

function validateStarbaseRemoteRepair(entity, family, options = {}) {
  if (!REMOTE_REPAIR_FAMILIES.has(String(family || ""))) {
    return { success: false, errorMsg: "TARGET_NOT_FOUND" };
  }
  return validateStarbaseRepairTarget(entity, options);
}

function canRechargeStarbaseShield(entity, options = {}) {
  return isStarbaseEntity(entity) &&
    number(entity.shieldCapacity) > 0 && number(entity.shieldRechargeRate) > 0 &&
    validateStarbaseRepairTarget(entity, options).success;
}

function restoreCondition(entity, previousConditionState, result) {
  entity.conditionState = { ...previousConditionState };
  return result;
}

// The common remote-repair engine has already calculated the delivered amount.
// Persist before presentation, keeping unrelated lifecycle/fuel/access state
// from the current item instead of copying a potentially stale scene snapshot.
function commitStarbaseHealthChange(entity, previousConditionState, options = {}) {
  const validation = validateStarbaseRepairTarget(entity, options);
  if (!validation.success) return restoreCondition(entity, previousConditionState, validation);
  const item = validation.data.item;
  const condition = { ...(entity.conditionState || {}) };
  const state = item.spaceState || {};
  const wasIncapacitated = item.conditionState && item.conditionState.incapacitated === true ||
    number(state.incapacitated) === 1 || number(entity.incapacitated) === 1;
  // CCP's legacy notes explicitly permit hull repair to reactivate a battery.
  // Full armor+hull recovery (not shield recovery) is the conservative policy
  // for the private recovery threshold; see doc/pos/Phase14.md evidence gap.
  const recovered = options.recoverIncapacitated !== false && wasIncapacitated &&
    resources.isStarbaseModule(item) && number(condition.armorDamage) <= 1e-9 &&
    number(condition.damage) <= 1e-9;
  if (recovered) condition.incapacitated = false;
  let result;
  try {
    result = items.updateInventoryItem(item.itemID, (current) => ({
      ...current,
      conditionState: condition,
      ...(recovered ? { spaceState: {
        ...(current.spaceState || {}),
        incapacitated: 0,
        onlineState: "offline",
        online: 0,
        onlineStartedAtMs: null,
        onlineCompletesAtMs: null,
      } } : {}),
    }));
  } catch (error) {
    result = { success: false, errorMsg: error.code || error.message || "STARBASE_REPAIR_PERSIST_FAILED" };
  }
  if (!result || !result.success || !result.data) {
    return restoreCondition(entity, previousConditionState,
      result || { success: false, errorMsg: "STARBASE_REPAIR_PERSIST_FAILED" });
  }
  entity.conditionState = { ...result.data.conditionState };
  entity.spaceState = { ...(result.data.spaceState || {}) };
  if (recovered) {
    entity.incapacitated = 0;
    entity.onlineState = "offline";
    entity.online = 0;
    entity.onlineStartedAtMs = null;
    entity.onlineCompletesAtMs = null;
    const presentation = require("../ship/controlTowerRuntime")
      .getControlTowerPresentationState(result.data);
    entity.posState = presentation.posState;
    entity.posTimestampMs = presentation.posTimestampMs;
    entity.posDelayTimeMs = presentation.posDelayTimeMs;
  }
  return { success: true, data: { item: result.data, recovered: Boolean(recovered) } };
}

module.exports = {
  isStarbaseEntity,
  validateStarbaseRepairTarget,
  validateStarbaseRemoteRepair,
  canRechargeStarbaseShield,
  commitStarbaseHealthChange,
};
