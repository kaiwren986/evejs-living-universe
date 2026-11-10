"use strict";

const {
  toFiniteNumber,
} = require("../../common/numbers");

const path = require("path");

const log = require(path.join(__dirname, "../../utils/logger"));
const spaceRuntime = require(path.join(__dirname, "../../space/runtime"));
const {
  findItemById,
  listStarbaseItems,
  listSystemSpaceItems,
  normalizeShipConditionState,
  updateInventoryItem,
} = require(path.join(__dirname, "../inventory/itemStore"));
const {
  getTypeAttributeValue,
} = require(path.join(__dirname, "../fitting/liveFittingState"));
const controlTowerRuntime = require(path.join(
  __dirname,
  "../ship/controlTowerRuntime",
));

const CATEGORY_STARBASE = 23;
const GROUP_FORCE_FIELD = 411;
function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function clamp(value, minimum, maximum) {
  return Math.min(Math.max(toFiniteNumber(value, minimum), minimum), maximum);
}

function getItemSystemID(item) {
  return toInt(
    item && item.spaceState && item.spaceState.systemID,
    toInt(item && item.locationID, 0),
  );
}

function getSessionSystemID(session) {
  return toInt(
    session && session._space && session._space.systemID,
    toInt(session && (session.solarsystemid2 || session.solarsystemid), 0),
  );
}

function isPosStructure(item) {
  return Boolean(
    item &&
    toInt(item.categoryID, 0) === CATEGORY_STARBASE &&
    toInt(item.groupID, 0) !== GROUP_FORCE_FIELD &&
    toInt(item.itemID, 0) > 0 &&
    getItemSystemID(item) > 0 &&
    toInt(item.locationID, 0) === getItemSystemID(item) &&
    toInt(item.flagID, -1) === 0 &&
    item.spaceState,
  );
}

function normalizeTargetText(value) {
  const trimmed = String(value || "").trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1).trim();
    }
  }
  return trimmed;
}

function getSessionReferencePosition(session) {
  const shipID = toInt(
    session && session._space && session._space.shipID,
    toInt(session && (session.shipID || session.shipid || session.activeShipID), 0),
  );
  const runtimeEntity = shipID > 0
    ? spaceRuntime.getEntity(session, shipID)
    : null;
  const position =
    (runtimeEntity && runtimeEntity.position) ||
    (
      session &&
      session.shipItem &&
      session.shipItem.spaceState &&
      session.shipItem.spaceState.position
    ) ||
    null;
  if (
    !position ||
    !Number.isFinite(Number(position.x)) ||
    !Number.isFinite(Number(position.y)) ||
    !Number.isFinite(Number(position.z))
  ) {
    return null;
  }
  return {
    x: Number(position.x),
    y: Number(position.y),
    z: Number(position.z),
  };
}

function distanceSquared(left, right) {
  if (!left || !right) {
    return Number.POSITIVE_INFINITY;
  }
  const dx = Number(left.x) - Number(right.x);
  const dy = Number(left.y) - Number(right.y);
  const dz = Number(left.z) - Number(right.z);
  return [dx, dy, dz].every(Number.isFinite)
    ? (dx ** 2) + (dy ** 2) + (dz ** 2)
    : Number.POSITIVE_INFINITY;
}

function listPosStructures() {
  return listStarbaseItems()
    .filter(isPosStructure)
    .sort((left, right) => toInt(left.itemID, 0) - toInt(right.itemID, 0));
}

function resolveHereStructure(session) {
  const systemID = getSessionSystemID(session);
  if (systemID <= 0) {
    return {
      success: false,
      errorMsg: "POS_CURRENT_SYSTEM_UNAVAILABLE",
    };
  }
  const structures = listSystemSpaceItems(systemID).filter(isPosStructure);
  if (structures.length <= 0) {
    return {
      success: false,
      errorMsg: "POS_STRUCTURE_NOT_FOUND_HERE",
    };
  }
  const referencePosition = getSessionReferencePosition(session);
  const sorted = structures.sort((left, right) => {
    const leftDistance = distanceSquared(
      referencePosition,
      left && left.spaceState && left.spaceState.position,
    );
    const rightDistance = distanceSquared(
      referencePosition,
      right && right.spaceState && right.spaceState.position,
    );
    return leftDistance - rightDistance ||
      toInt(left && left.itemID, 0) - toInt(right && right.itemID, 0);
  });
  return {
    success: true,
    data: sorted[0],
  };
}

function resolvePosStructure(session, targetText) {
  const target = normalizeTargetText(targetText);
  if (!target || target.toLowerCase() === "here") {
    return resolveHereStructure(session);
  }

  const numericID = toInt(target, 0);
  if (numericID > 0) {
    const item = findItemById(numericID);
    if (!item) {
      return { success: false, errorMsg: "POS_STRUCTURE_NOT_FOUND" };
    }
    return isPosStructure(item)
      ? { success: true, data: item }
      : { success: false, errorMsg: "ITEM_NOT_POS_STRUCTURE" };
  }

  const normalizedName = target.toLowerCase();
  const matches = listPosStructures().filter((item) => (
    String(item.itemName || "").trim().toLowerCase() === normalizedName
  ));
  if (matches.length <= 0) {
    return { success: false, errorMsg: "POS_STRUCTURE_NOT_FOUND" };
  }
  const currentSystemID = getSessionSystemID(session);
  const localMatches = matches.filter(
    (item) => getItemSystemID(item) === currentSystemID,
  );
  const preferredMatches = localMatches.length > 0 ? localMatches : matches;
  if (preferredMatches.length !== 1) {
    return {
      success: false,
      errorMsg: "POS_STRUCTURE_NAME_AMBIGUOUS",
      data: { matches: preferredMatches },
    };
  }
  return { success: true, data: preferredMatches[0] };
}

function syncPosRuntime(item, options = {}) {
  if (!isPosStructure(item)) {
    return { success: false, errorMsg: "ITEM_NOT_POS_STRUCTURE" };
  }
  const systemID = getItemSystemID(item);
  const syncResult = spaceRuntime.spawnDynamicInventoryEntity(
    systemID,
    item.itemID,
    { broadcast: options.broadcast !== false },
  );
  if (!syncResult || syncResult.success !== true) {
    return {
      success: false,
      errorMsg: syncResult && syncResult.errorMsg || "POS_RUNTIME_SYNC_FAILED",
      data: item,
    };
  }
  const damageStateDeliveredCount = options.broadcastDamageStateChange === true
    ? spaceRuntime.broadcastEntityDamageStateChange(systemID, item.itemID, {
        whenMs: options.whenMs,
      })
    : 0;
  return {
    success: true,
    data: findItemById(item.itemID) || item,
    runtime: syncResult.data || null,
    damageStateDeliveredCount,
  };
}

function validatePosRuntimeSupport(item) {
  if (!isPosStructure(item)) {
    return { success: false, errorMsg: "ITEM_NOT_POS_STRUCTURE" };
  }
  if (controlTowerRuntime.isControlTowerType(item)) {
    return { success: true };
  }
  const runtimeEntity = spaceRuntime.buildRuntimeSpaceEntityFromItemRecord(
    item,
    getItemSystemID(item),
    Date.now(),
  );
  return runtimeEntity && runtimeEntity.kind === "starbase"
    ? { success: true }
    : { success: false, errorMsg: "UNSUPPORTED_POS_RUNTIME" };
}

function settleControlTowerTimers(itemID, nowMs = Date.now(), options = {}) {
  const item = findItemById(itemID);
  if (!controlTowerRuntime.isControlTowerType(item)) {
    return;
  }
  controlTowerRuntime.reconcileControlTowerAnchorState(itemID, {
    nowMs,
    schedule: false,
    refreshPresentation: false,
  });
  controlTowerRuntime.reconcileControlTowerOnlineState(itemID, {
    nowMs,
    schedule: false,
    refreshPresentation: false,
    reconcileForceField: false,
    reconcileFuel: options.reconcileFuel !== false,
  });
}

function reconcileControlTowerRuntimeState(item, online) {
  if (!controlTowerRuntime.isControlTowerType(item)) {
    return { success: true };
  }
  return online
    ? controlTowerRuntime.ensureControlTowerForceField(item, {
        spawn: true,
        updateScene: true,
        broadcast: true,
      })
    : controlTowerRuntime.removeControlTowerForceFields(item, {
        updateScene: true,
        broadcast: true,
      });
}

function forcePosAnchorState(itemID, anchored) {
  const targetID = toInt(itemID, 0);
  const item = findItemById(targetID);
  if (!isPosStructure(item)) {
    return { success: false, errorMsg: "ITEM_NOT_POS_STRUCTURE" };
  }
  const supportResult = validatePosRuntimeSupport(item);
  if (!supportResult.success) {
    return supportResult;
  }
  const nextAnchorState = anchored ? "anchored" : "unanchored";
  const result = updateInventoryItem(targetID, (current) => ({
    ...current,
    spaceState: {
      ...(current.spaceState || {}),
      anchorState: nextAnchorState,
      isAnchored: anchored,
      anchorStartedAtMs: null,
      anchorCompletesAtMs: null,
      ...(!anchored
        ? {
            onlineState: "offline",
            online: 0,
            onlineStartedAtMs: null,
            onlineCompletesAtMs: null,
          }
        : {}),
    },
  }));
  if (!result.success || !result.data) {
    return result;
  }
  settleControlTowerTimers(targetID, Date.now(), { reconcileFuel: false });
  const runtimeStateResult = reconcileControlTowerRuntimeState(
    result.data,
    anchored && String(result.data.spaceState.onlineState) === "online",
  );
  if (!runtimeStateResult.success) {
    return runtimeStateResult;
  }
  const syncResult = syncPosRuntime(findItemById(targetID) || result.data);
  return syncResult.success
    ? { success: true, data: syncResult.data }
    : syncResult;
}

function forcePosOnlineState(itemID, online, options = {}) {
  const targetID = toInt(itemID, 0);
  const item = findItemById(targetID);
  if (!isPosStructure(item)) {
    return { success: false, errorMsg: "ITEM_NOT_POS_STRUCTURE" };
  }
  const supportResult = validatePosRuntimeSupport(item);
  if (!supportResult.success) {
    return supportResult;
  }
  if (online && controlTowerRuntime.isControlTowerType(item)) {
    const fuelValidation = controlTowerRuntime.validateControlTowerFuel(item);
    if (!fuelValidation.success) {
      return fuelValidation;
    }
  }
  const result = updateInventoryItem(targetID, (current) => ({
    ...current,
    spaceState: {
      ...(current.spaceState || {}),
      ...(online
        ? {
            anchorState: "anchored",
            isAnchored: true,
            anchorStartedAtMs: null,
            anchorCompletesAtMs: null,
          }
        : {}),
      onlineState: online ? "online" : "offline",
      online: online ? 1 : 0,
      onlineStartedAtMs: null,
      onlineCompletesAtMs: null,
    },
  }));
  if (!result.success || !result.data) {
    return result;
  }
  settleControlTowerTimers(targetID, Date.now(), { reconcileFuel: false });
  let current = findItemById(targetID) || result.data;
  if (controlTowerRuntime.isControlTowerType(current)) {
    const fuelRuntime = require(path.join(__dirname, "./starbaseFuelRuntime"));
    const fuelResult = online
      ? fuelRuntime.initializeControlTowerFuelState(current, {
          session: options.session || null,
          schedule: options.schedule !== false,
          updateScene: false,
          broadcast: false,
        })
      : fuelRuntime.deactivateControlTowerFuelState(current);
    if (!fuelResult.success) {
      return fuelResult;
    }
    current = fuelResult.data || findItemById(targetID) || current;
    if (!online) {
      const moduleResult = require(path.join(__dirname, "./starbaseResourceRuntime"))
        .deactivateTowerModules(current, {
          reason: "controlTowerOffline",
          refreshPresentation: true,
          broadcast: true,
        });
      if (!moduleResult.success) {
        return moduleResult;
      }
    }
  }
  const runtimeStateResult = reconcileControlTowerRuntimeState(current, online);
  if (!runtimeStateResult.success) {
    return runtimeStateResult;
  }
  const syncResult = syncPosRuntime(findItemById(targetID) || current);
  return syncResult.success
    ? { success: true, data: syncResult.data }
    : syncResult;
}

function shiftTimestamp(value, deltaMs) {
  const timestamp = toInt(value, 0);
  return timestamp > 0 ? Math.max(1, timestamp - deltaMs) : null;
}

function shiftOptionalTimerState(timerState, deltaMs) {
  if (!timerState || typeof timerState !== "object") {
    return timerState;
  }
  const shifted = { ...timerState };
  for (const key of [
    "startedAtMs",
    "lastConsumedAtMs",
    "nextCycleAtMs",
    "exhaustedAtMs",
  ]) {
    if (Object.prototype.hasOwnProperty.call(shifted, key)) {
      shifted[key] = shiftTimestamp(shifted[key], deltaMs);
    }
  }
  return shifted;
}

function fastForwardPosTimers(itemID, seconds, options = {}) {
  const targetID = toInt(itemID, 0);
  const amountSeconds = Number(seconds);
  if (!Number.isFinite(amountSeconds) || amountSeconds < 0) {
    return { success: false, errorMsg: "POS_FAST_FORWARD_SECONDS_INVALID" };
  }
  const item = findItemById(targetID);
  if (!isPosStructure(item)) {
    return { success: false, errorMsg: "ITEM_NOT_POS_STRUCTURE" };
  }
  const supportResult = validatePosRuntimeSupport(item);
  if (!supportResult.success) {
    return supportResult;
  }
  const deltaMs = amountSeconds * 1000;
  const result = updateInventoryItem(targetID, (current) => ({
    ...current,
    spaceState: {
      ...(current.spaceState || {}),
      anchorStartedAtMs: shiftTimestamp(
        current.spaceState && current.spaceState.anchorStartedAtMs,
        deltaMs,
      ),
      anchorCompletesAtMs: shiftTimestamp(
        current.spaceState && current.spaceState.anchorCompletesAtMs,
        deltaMs,
      ),
      onlineStartedAtMs: shiftTimestamp(
        current.spaceState && current.spaceState.onlineStartedAtMs,
        deltaMs,
      ),
      onlineCompletesAtMs: shiftTimestamp(
        current.spaceState && current.spaceState.onlineCompletesAtMs,
        deltaMs,
      ),
      ...(current.spaceState && current.spaceState.starbaseFuelState
        ? {
            starbaseFuelState: shiftOptionalTimerState(
              current.spaceState.starbaseFuelState,
              deltaMs,
            ),
          }
        : {}),
    },
  }));
  if (!result.success || !result.data) {
    return result;
  }
  const nowMs = toInt(options.nowMs, Date.now());
  settleControlTowerTimers(targetID, nowMs);
  const current = findItemById(targetID) || result.data;
  const online = String(current.spaceState && current.spaceState.onlineState) === "online";
  const runtimeStateResult = reconcileControlTowerRuntimeState(current, online);
  if (!runtimeStateResult.success) {
    return runtimeStateResult;
  }
  const syncResult = syncPosRuntime(findItemById(targetID) || current);
  return syncResult.success
    ? { success: true, data: syncResult.data }
    : syncResult;
}

function repairPosStructure(itemID) {
  const targetID = toInt(itemID, 0);
  const item = findItemById(targetID);
  if (!isPosStructure(item)) {
    return { success: false, errorMsg: "ITEM_NOT_POS_STRUCTURE" };
  }
  const supportResult = validatePosRuntimeSupport(item);
  if (!supportResult.success) {
    return supportResult;
  }
  const result = updateInventoryItem(targetID, (current) => ({
    ...current,
    conditionState: normalizeShipConditionState({
      ...(current.conditionState || {}),
      damage: 0,
      armorDamage: 0,
      shieldCharge: 1,
      incapacitated: false,
    }),
    spaceState: {
      ...(current.spaceState || {}),
      incapacitated: 0,
    },
  }));
  if (!result.success || !result.data) {
    return result;
  }
  const syncResult = syncPosRuntime(result.data, {
    broadcastDamageStateChange: true,
  });
  return syncResult.success
    ? { success: true, data: syncResult.data }
    : syncResult;
}

function getPosMaximumLayers(item) {
  return {
    shield: Math.max(
      0,
      toFiniteNumber(getTypeAttributeValue(item.typeID, "shieldCapacity"), 0),
    ),
    armor: Math.max(
      0,
      toFiniteNumber(getTypeAttributeValue(item.typeID, "armorHP"), 0),
    ),
    hull: Math.max(
      0,
      toFiniteNumber(
        getTypeAttributeValue(item.typeID, "hp", "structureHP"),
        0,
      ),
    ),
  };
}

function applyLayerDamage(currentHP, amount) {
  if (amount === null) {
    return 0;
  }
  return Math.max(0, currentHP - Math.min(currentHP, amount));
}

function removeKilledPosStructure(item) {
  return require("./starbaseCombatRuntime").destroyStarbase(item.itemID, {
    scene: spaceRuntime.getSceneByDescriptor(getItemSystemID(item)), reason: "pos-gm-kill",
  });
}

function applyPosDamage(itemID, layer, amount = null) {
  const targetID = toInt(itemID, 0);
  const item = findItemById(targetID);
  if (!isPosStructure(item)) {
    return { success: false, errorMsg: "ITEM_NOT_POS_STRUCTURE" };
  }
  const supportResult = validatePosRuntimeSupport(item);
  if (!supportResult.success) {
    return supportResult;
  }
  const rawLayer = String(layer || "").trim().toLowerCase();
  const normalizedLayer = rawLayer === "armour" ? "armor" : rawLayer;
  if (!["shield", "armor", "hull", "kill"].includes(normalizedLayer)) {
    return { success: false, errorMsg: "INVALID_DAMAGE_LAYER" };
  }
  const numericAmount = amount === null || amount === undefined
    ? null
    : Number(amount);
  if (numericAmount !== null && (!Number.isFinite(numericAmount) || numericAmount <= 0)) {
    return { success: false, errorMsg: "POS_DAMAGE_AMOUNT_INVALID" };
  }
  if (normalizedLayer === "kill") {
    const destroyResult = removeKilledPosStructure(item);
    return destroyResult.success
      ? { success: true, data: { destroyed: true, item } }
      : destroyResult;
  }

  const maximum = getPosMaximumLayers(item);
  if (maximum.shield <= 0 && maximum.armor <= 0 && maximum.hull <= 0) {
    return { success: false, errorMsg: "POS_HEALTH_UNAVAILABLE" };
  }
  const condition = normalizeShipConditionState(item.conditionState);
  const current = {
    shield: maximum.shield * clamp(condition.shieldCharge, 0, 1),
    armor: maximum.armor * (1 - clamp(condition.armorDamage, 0, 1)),
    hull: maximum.hull * (1 - clamp(condition.damage, 0, 1)),
  };
  const after = { ...current };
  if (normalizedLayer === "shield") {
    after.shield = applyLayerDamage(current.shield, numericAmount);
  } else if (normalizedLayer === "armor") {
    after.shield = 0;
    after.armor = applyLayerDamage(current.armor, numericAmount);
  } else {
    after.shield = 0;
    after.armor = 0;
    after.hull = applyLayerDamage(current.hull, numericAmount);
  }

  const result = updateInventoryItem(targetID, (currentItem) => ({
    ...currentItem,
    conditionState: normalizeShipConditionState({
      ...(currentItem.conditionState || {}),
      shieldCharge: maximum.shield > 0 ? after.shield / maximum.shield : 0,
      armorDamage: maximum.armor > 0 ? 1 - (after.armor / maximum.armor) : 1,
      damage: maximum.hull > 0 ? 1 - (after.hull / maximum.hull) : 1,
    }),
  }));
  if (!result.success || !result.data) {
    return result;
  }
  const syncResult = syncPosRuntime(result.data, {
    broadcastDamageStateChange: true,
  });
  if (!syncResult.success) {
    return syncResult;
  }
  return {
    success: true,
    data: {
      item: syncResult.data,
      layer: normalizedLayer,
      amount: numericAmount,
      beforeLayers: current,
      afterLayers: after,
      destroyed: false,
    },
  };
}

function forcePosFuelCycle(itemID, options = {}) {
  const targetID = toInt(itemID, 0);
  const item = findItemById(targetID);
  if (!controlTowerRuntime.isControlTowerType(item)) {
    return { success: false, errorMsg: "ITEM_NOT_CONTROL_TOWER" };
  }
  return require(path.join(__dirname, "./starbaseFuelRuntime"))
    .forceControlTowerFuelCycle(targetID, options);
}

function setPosTimerScale(itemID, scale) {
  const targetID = toInt(itemID, 0);
  const numericScale = Number(scale);
  if (!Number.isFinite(numericScale) || numericScale <= 0) {
    return { success: false, errorMsg: "POS_TIMER_SCALE_INVALID" };
  }
  const item = findItemById(targetID);
  if (!isPosStructure(item)) {
    return { success: false, errorMsg: "ITEM_NOT_POS_STRUCTURE" };
  }
  const supportResult = validatePosRuntimeSupport(item);
  if (!supportResult.success) {
    return supportResult;
  }
  const result = updateInventoryItem(targetID, (current) => ({
    ...current,
    spaceState: {
      ...(current.spaceState || {}),
      posTimerScale: numericScale,
    },
  }));
  if (!result.success || !result.data) {
    return result;
  }
  const syncResult = syncPosRuntime(result.data);
  return syncResult.success
    ? { success: true, data: syncResult.data }
    : syncResult;
}

function formatPosStructure(item) {
  if (!item) {
    return "POS structure ?";
  }
  const state = item.spaceState || {};
  return [
    `${item.itemName || `POS structure ${item.itemID}`}(${item.itemID})`,
    `anchor=${String(state.anchorState || "unanchored")}`,
    `online=${String(state.onlineState || "offline")}`,
    `system=${getItemSystemID(item)}`,
  ].join(" | ");
}

function logPosGmAction(session, action, item, details = "") {
  log.info(
    `[POS GM] char=${toInt(session && session.characterID, 0)} ` +
    `action=${action} item=${toInt(item && item.itemID, 0)}${details ? ` ${details}` : ""}`,
  );
}

module.exports = {
  CATEGORY_STARBASE,
  GROUP_FORCE_FIELD,
  applyPosDamage,
  forcePosFuelCycle,
  fastForwardPosTimers,
  forcePosAnchorState,
  forcePosOnlineState,
  formatPosStructure,
  getItemSystemID,
  isPosStructure,
  listPosStructures,
  logPosGmAction,
  repairPosStructure,
  resolvePosStructure,
  setPosTimerScale,
  syncPosRuntime,
  validatePosRuntimeSupport,
  _testing: {
    distanceSquared,
    getPosMaximumLayers,
    getSessionReferencePosition,
    normalizeTargetText,
    resolveHereStructure,
    shiftTimestamp,
  },
};
