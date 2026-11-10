"use strict";

const path = require("path");

const log = require(path.join(__dirname, "../../utils/logger"));
const config = require(path.join(__dirname, "../../config"));
const {
  consumeInventoryItemStacksAtomic,
  findItemById,
  listStarbaseItems,
  listContainerItems,
  updateInventoryItem,
} = require(path.join(__dirname, "../inventory/itemStore"));

const MAX_TIMER_DELAY_MS = 2147000000;
const FUEL_STATE_VERSION = 1;
const fuelTimers = new Map();

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function normalizeTimestamp(value) {
  const numeric = toInt(value, 0);
  return numeric > 0 ? numeric : null;
}

function getControlTowerRuntime() {
  // Kept lazy because the tower lifecycle invokes this runtime while its own
  // module is still being initialized.
  return require(path.join(__dirname, "../ship/controlTowerRuntime"));
}

function getFuelState(item) {
  const stored = item && item.spaceState && item.spaceState.starbaseFuelState;
  const state = stored && typeof stored === "object" ? stored : {};
  return {
    version: Math.max(1, toInt(state.version, FUEL_STATE_VERSION)),
    active: state.active === true,
    periodMs: Math.max(0, toInt(state.periodMs, 0)),
    startedAtMs: normalizeTimestamp(state.startedAtMs),
    lastConsumedAtMs: normalizeTimestamp(state.lastConsumedAtMs),
    nextCycleAtMs: normalizeTimestamp(state.nextCycleAtMs),
    exhaustedAtMs: normalizeTimestamp(state.exhaustedAtMs),
    cyclesConsumed: Math.max(0, toInt(state.cyclesConsumed, 0)),
  };
}

function withFuelState(item, overrides = {}) {
  const current = getFuelState(item);
  return {
    ...(item.spaceState || {}),
    starbaseFuelState: {
      ...current,
      ...overrides,
      version: FUEL_STATE_VERSION,
    },
  };
}

function getStackQuantity(item) {
  if (!item) {
    return 0;
  }
  return toInt(item.singleton, 0) === 1
    ? 1
    : Math.max(0, toInt(item.stacksize ?? item.quantity, 0));
}

function listTypeStacks(containerID, typeID) {
  const numericTypeID = toInt(typeID, 0);
  return listContainerItems(null, toInt(containerID, 0), null)
    .filter((item) => (
      toInt(item && item.typeID, 0) === numericTypeID &&
      getStackQuantity(item) > 0
    ))
    .sort((left, right) => toInt(left.itemID, 0) - toInt(right.itemID, 0));
}

function sumStackQuantity(stacks) {
  return stacks.reduce((total, item) => total + getStackQuantity(item), 0);
}

function buildStackRequests(stacks, requiredQuantity, expectedLocationID) {
  let remaining = Math.max(0, toInt(requiredQuantity, 0));
  const requests = [];
  for (const stack of stacks) {
    if (remaining <= 0) {
      break;
    }
    const available = getStackQuantity(stack);
    const quantity = Math.min(available, remaining);
    requests.push({
      itemID: stack.itemID,
      quantity,
      expectedTypeID: stack.typeID,
      expectedOwnerID: stack.ownerID,
      expectedLocationID,
      expectedFlagID: stack.flagID,
      expectedQuantity: available,
    });
    remaining -= quantity;
  }
  return remaining === 0 ? requests : null;
}

function getAffordableCycleCount(tower, requirements) {
  const fuelStacks = listTypeStacks(tower.itemID, requirements.fuelBlockTypeID);
  const fuelCycles = requirements.fuelBlockQuantity > 0
    ? Math.floor(sumStackQuantity(fuelStacks) / requirements.fuelBlockQuantity)
    : 0;
  if (requirements.charterRequired === true && (
    requirements.charterTypeID <= 0 || requirements.charterQuantity <= 0
  )) {
    return 0;
  }
  if (requirements.charterTypeID <= 0 || requirements.charterQuantity <= 0) {
    return fuelCycles;
  }
  const charterStacks = listTypeStacks(tower.itemID, requirements.charterTypeID);
  const charterCycles = Math.floor(
    sumStackQuantity(charterStacks) / requirements.charterQuantity,
  );
  return Math.min(fuelCycles, charterCycles);
}

function consumeFuelCycles(tower, requirements, cycleCount, checkpoint = null) {
  const cycles = Math.max(0, toInt(cycleCount, 0));
  if (cycles === 0 && !checkpoint) {
    return { success: true, data: { changes: [], consumedQuantity: 0 } };
  }
  if (requirements.charterRequired === true && (
    requirements.charterTypeID <= 0 || requirements.charterQuantity <= 0
  )) {
    return { success: false, errorMsg: "CONTROL_TOWER_CHARTER_UNAVAILABLE" };
  }

  const requests = [];
  const fuelRequests = buildStackRequests(
    listTypeStacks(tower.itemID, requirements.fuelBlockTypeID),
    requirements.fuelBlockQuantity * cycles,
    tower.itemID,
  );
  if (!fuelRequests) {
    return { success: false, errorMsg: "CONTROL_TOWER_FUEL_REQUIRED" };
  }
  requests.push(...fuelRequests);

  if (requirements.charterTypeID > 0 && requirements.charterQuantity > 0) {
    const charterRequests = buildStackRequests(
      listTypeStacks(tower.itemID, requirements.charterTypeID),
      requirements.charterQuantity * cycles,
      tower.itemID,
    );
    if (!charterRequests) {
      return { success: false, errorMsg: "CONTROL_TOWER_CHARTER_REQUIRED" };
    }
    requests.push(...charterRequests);
  }

  // Fuel, charters and the paid-through deadline must share one commit. A
  // restart or rejected write must never leave a debit with the old deadline.
  const result = consumeInventoryItemStacksAtomic(requests, {
    associatedUpdates: checkpoint ? [{
      itemID: tower.itemID,
      expectedItem: tower,
      updater: (item) => ({ ...item, spaceState: withFuelState(item, checkpoint) }),
    }] : [],
  });
  if (!result.success || !checkpoint) return result;
  return { ...result, data: { ...result.data,
    tower: findItemById(tower.itemID),
    changes: (result.data?.changes || []).filter((change) =>
      Number((change.item || change.previousData)?.itemID) !== tower.itemID),
  } };
}

function clearFuelTimer(itemID) {
  const numericItemID = toInt(itemID, 0);
  const timer = fuelTimers.get(numericItemID);
  if (timer) {
    clearTimeout(timer);
    fuelTimers.delete(numericItemID);
  }
}

function clearFuelTimers() {
  for (const itemID of fuelTimers.keys()) {
    clearFuelTimer(itemID);
  }
}

function scheduleFuelReconciliation(itemID, nextCycleAtMs, options = {}, minimumDelayMs = 0) {
  const numericItemID = toInt(itemID, 0);
  const deadline = normalizeTimestamp(nextCycleAtMs);
  clearFuelTimer(numericItemID);
  if (!numericItemID || !deadline) {
    return false;
  }
  const delayMs = Math.min(
    MAX_TIMER_DELAY_MS,
    Math.max(minimumDelayMs, deadline - Date.now()),
  );
  const timer = setTimeout(() => {
    fuelTimers.delete(numericItemID);
    let result;
    try {
      result = reconcileControlTowerFuel(numericItemID, {
        nowMs: Date.now(),
        schedule: true,
        updateScene: options.updateScene !== false,
        broadcast: options.broadcast !== false,
      });
    } catch (error) {
      result = { success: false, errorMsg: error.message };
    }
    if (!result.success) {
      log.warn(
        `[StarbaseFuel] reconciliation failed tower=${numericItemID} ` +
        `error=${result.errorMsg || "UNKNOWN"}`,
      );
      // A transient persistence fault must not strand an online, unpaid tower.
      // Read the saved deadline: a late presentation failure may follow commit.
      const tower = findItemById(numericItemID);
      if (tower && getControlTowerRuntime().getControlTowerOnlineState(tower).isOnline) {
        scheduleFuelReconciliation(numericItemID,
          getFuelState(tower).nextCycleAtMs || deadline, options, 1000);
      }
    }
  }, delayMs);
  if (timer && typeof timer.unref === "function") {
    timer.unref();
  }
  fuelTimers.set(numericItemID, timer);
  return true;
}

function resolveSessionCorporationID(session) {
  return toInt(
    session && (session.corporationID || session.corporationid || session.corpid),
    0,
  );
}

function collectInventorySyncSessions(tower, actingSession = null) {
  const recipients = new Set();
  if (actingSession && typeof actingSession.sendNotification === "function") {
    recipients.add(actingSession);
  }
  const corporationID = toInt(tower && tower.ownerID, 0);
  if (corporationID <= 0) return [...recipients];
  const sessionRegistry = require(path.join(__dirname, "../chat/sessionRegistry"));
  for (const candidate of sessionRegistry.getSessions()) {
    if (
      candidate &&
      typeof candidate.sendNotification === "function" &&
      resolveSessionCorporationID(candidate) === corporationID
    ) {
      recipients.add(candidate);
    }
  }
  return [...recipients];
}

function syncInventoryChanges(session, changes = [], tower = null) {
  if (!Array.isArray(changes) || changes.length === 0) {
    return;
  }
  const { syncInventoryItemForSession } = require(path.join(
    __dirname,
    "../character/characterState",
  ));
  if (typeof syncInventoryItemForSession !== "function") {
    return;
  }
  for (const recipient of collectInventorySyncSessions(tower, session)) {
    for (const change of changes) {
      const item = change && (change.item || change.previousData);
      if (!item) {
        continue;
      }
      try {
        syncInventoryItemForSession(
          recipient,
          change.removed === true
            ? { ...change.previousData, quantity: 0, stacksize: 0 }
            : change.item,
          change.previousData || {},
          { emitCfgLocation: true },
        );
      } catch (error) {
        log.warn(`[StarbaseFuel] inventory observer failed: ${error.message}`);
      }
    }
  }
}

function initializeControlTowerFuelState(itemOrID, options = {}) {
  const itemID = toInt(
    itemOrID && typeof itemOrID === "object" ? itemOrID.itemID : itemOrID,
    0,
  );
  const tower = findItemById(itemID);
  const towerRuntime = getControlTowerRuntime();
  if (!tower || !towerRuntime.isControlTowerType(tower)) {
    return { success: false, errorMsg: "ITEM_NOT_CONTROL_TOWER" };
  }
  if (!towerRuntime.getControlTowerOnlineState(tower).isOnline) {
    clearFuelTimer(itemID);
    return { success: false, errorMsg: "CONTROL_TOWER_NOT_ONLINE" };
  }
  const requirements = towerRuntime.getControlTowerFuelRequirements(tower);
  if (!requirements || requirements.fuelPeriodMs <= 0) {
    return {
      success: false,
      errorMsg: "CONTROL_TOWER_FUEL_CONFIGURATION_UNAVAILABLE",
    };
  }
  const nowMs = Math.max(0, toInt(options.nowMs, Date.now()));
  const current = getFuelState(tower);
  if (current.active && current.nextCycleAtMs) {
    return reconcileControlTowerFuel(tower, options);
  }

  const affordableCycles = getAffordableCycleCount(tower, requirements);
  if (affordableCycles < 1) {
    const offlineResult = offlineTowerForFuelExhaustion(tower, nowMs, options);
    return {
      ...offlineResult,
      initialized: true,
      exhausted: true,
      dueCycles: 1,
      completedCycles: 0,
      fuelState: offlineResult.success
        ? getFuelState(offlineResult.data)
        : getFuelState(tower),
      consumptionChanges: [],
    };
  }

  const nextCycleAtMs = nowMs + requirements.fuelPeriodMs;
  const consumeResult = consumeFuelCycles(tower, requirements, 1, {
    active: true,
    periodMs: requirements.fuelPeriodMs,
    startedAtMs: nowMs,
    lastConsumedAtMs: nowMs,
    nextCycleAtMs,
    exhaustedAtMs: null,
    cyclesConsumed: current.cyclesConsumed + 1,
  });
  if (!consumeResult.success) return consumeResult;
  const updatedTower = consumeResult.data.tower;
  // Publish inventory deltas only after the paid-cycle state is durable. An
  // OnItemChange recipient can synchronously refresh the tower presentation;
  // exposing the fuel removal first would make that refresh see an online,
  // uninitialized tower and incorrectly offline it for fuel exhaustion.
  syncInventoryChanges(
    options.session || null,
    consumeResult.data && consumeResult.data.changes,
    updatedTower,
  );
  if (options.schedule !== false) {
    scheduleFuelReconciliation(itemID, nextCycleAtMs, options);
  }
  log.info(
    `[StarbaseFuel] activated tower=${itemID} startupCycles=1 ` +
    `nextCycleAtMs=${nextCycleAtMs} ` +
    `periodMs=${requirements.fuelPeriodMs}`,
  );
  return {
    success: true,
    data: updatedTower,
    initialized: true,
    completedCycles: 1,
    consumptionChanges: consumeResult.data && consumeResult.data.changes || [],
    fuelState: getFuelState(updatedTower),
  };
}

function deactivateControlTowerFuelState(itemOrID, options = {}) {
  const itemID = toInt(
    itemOrID && typeof itemOrID === "object" ? itemOrID.itemID : itemOrID,
    0,
  );
  const tower = findItemById(itemID);
  clearFuelTimer(itemID);
  if (!tower) {
    return { success: false, errorMsg: "ITEM_NOT_FOUND" };
  }
  const current = getFuelState(tower);
  if (!current.active && !current.nextCycleAtMs) {
    return { success: true, data: tower, changed: false };
  }
  const updateResult = updateInventoryItem(itemID, (currentItem) => ({
    ...currentItem,
    spaceState: withFuelState(currentItem, {
      active: false,
      nextCycleAtMs: null,
      exhaustedAtMs: options.exhaustedAtMs === undefined
        ? current.exhaustedAtMs
        : normalizeTimestamp(options.exhaustedAtMs),
    }),
  }));
  return updateResult.success
    ? { success: true, data: updateResult.data, changed: true }
    : updateResult;
}

function offlineControlTowerForFuelFailure(itemOrID, options = {}) {
  const itemID = toInt(
    itemOrID && typeof itemOrID === "object" ? itemOrID.itemID : itemOrID,
    0,
  );
  const tower = findItemById(itemID);
  const towerRuntime = getControlTowerRuntime();
  if (!tower || !towerRuntime.isControlTowerType(tower)) {
    clearFuelTimer(itemID);
    return { success: false, errorMsg: "ITEM_NOT_CONTROL_TOWER" };
  }
  const exhaustedAtMs = options.exhaustedAtMs === undefined
    ? null
    : normalizeTimestamp(options.exhaustedAtMs);
  const disabledAtMs = exhaustedAtMs || Math.max(
    0,
    toInt(options.nowMs, Date.now()),
  );
  const disabledReason = String(options.reason || "fuelActivationFailed");
  const updateResult = updateInventoryItem(itemID, (currentItem) => ({
    ...currentItem,
    spaceState: withFuelState(
      {
        ...currentItem,
        spaceState: towerRuntime.buildControlTowerSpaceState(currentItem, {
          onlineState: towerRuntime.CONTROL_TOWER_ONLINE_STATE.OFFLINE,
        }),
      },
      {
        ...getFuelState(currentItem),
        active: false,
        nextCycleAtMs: null,
        exhaustedAtMs,
      },
    ),
  }));
  if (!updateResult.success || !updateResult.data) {
    return updateResult;
  }
  clearFuelTimer(itemID);
  if (options.refreshPresentation !== false) {
    towerRuntime._testing.refreshControlTowerAnchorPresentation(updateResult.data);
  }
  require("./starbaseTravelRuntime").notifyInfrastructureChanged(updateResult.data);
  const moduleResult = require(path.join(
    __dirname,
    "./starbaseResourceRuntime",
  )).deactivateTowerModules(updateResult.data, {
    reason: disabledReason,
    nowMs: disabledAtMs,
    refreshPresentation: options.refreshPresentation !== false,
    broadcast: options.broadcast !== false,
  });
  // The tower is already saved offline, so every cleanup step below must still
  // run. Returning early here left its force field up after fuel ran out.
  const industryResult = require("../industry/starbaseIndustryRuntime").reconcileAssemblyJobs(updateResult.data, { nowMs: disabledAtMs });
  if (!industryResult.success) {
    log.warn(
      `[StarbaseFuel] assembly job shutdown failed tower=${itemID} ` +
      `error=${industryResult.errorMsg || "UNKNOWN"}`,
    );
  }
  require("./starbaseProductionCycles").invalidateProductionForItem(updateResult.data, { nowMs: disabledAtMs });
  const forceFieldResult = towerRuntime.removeControlTowerForceFields(
    updateResult.data,
    {
      updateScene: options.updateScene !== false,
      broadcast: options.broadcast !== false,
    },
  );
  if (!moduleResult.success) {
    log.warn(
      `[StarbaseFuel] module shutdown failed tower=${itemID} ` +
      `error=${moduleResult.errorMsg || "UNKNOWN"}`,
    );
  }
  if (!forceFieldResult.success) {
    log.warn(
      `[StarbaseFuel] force-field shutdown failed tower=${itemID} ` +
      `error=${forceFieldResult.errorMsg || "UNKNOWN"}`,
    );
  }
  if (!industryResult.success) {
    return {
      ...industryResult,
      data: updateResult.data,
      forceFieldResult,
      moduleResult,
      cleanupSuccess: false,
    };
  }
  return {
    success: true,
    data: updateResult.data,
    forceFieldResult,
    moduleResult,
    cleanupSuccess: moduleResult.success === true && forceFieldResult.success === true,
  };
}

function offlineTowerForFuelExhaustion(tower, exhaustedAtMs, options = {}) {
  const result = offlineControlTowerForFuelFailure(tower, {
    ...options,
    exhaustedAtMs,
    nowMs: exhaustedAtMs,
    reason: "fuelExhausted",
  });
  if (result.success) {
    log.info(
      `[StarbaseFuel] exhausted tower=${toInt(tower && tower.itemID, 0)} ` +
      `exhaustedAtMs=${exhaustedAtMs}`,
    );
  }
  return result;
}

function reconcileControlTowerFuel(itemOrID, options = {}) {
  const itemID = toInt(
    itemOrID && typeof itemOrID === "object" ? itemOrID.itemID : itemOrID,
    0,
  );
  let tower = findItemById(itemID);
  const towerRuntime = getControlTowerRuntime();
  if (!tower || !towerRuntime.isControlTowerType(tower)) {
    clearFuelTimer(itemID);
    return { success: false, errorMsg: "ITEM_NOT_CONTROL_TOWER" };
  }
  if (!towerRuntime.getControlTowerOnlineState(tower).isOnline) {
    clearFuelTimer(itemID);
    return { success: true, data: tower, active: false, completedCycles: 0 };
  }

  const reinforced = require("./starbaseReinforcementRuntime")
    .reconcileControlTowerReinforcement(tower, options);
  if (!reinforced.success) return reinforced;
  tower = reinforced.data;
  if (reinforced.active) {
    clearFuelTimer(itemID);
    return { success: true, data: tower, active: true, reinforced: true, completedCycles: 0 };
  }

  let fuelState = getFuelState(tower);
  if (!fuelState.active || !fuelState.nextCycleAtMs) {
    return initializeControlTowerFuelState(tower, options);
  }
  const requirements = towerRuntime.getControlTowerFuelRequirements(tower);
  const periodMs = Math.max(0, toInt(requirements && requirements.fuelPeriodMs, 0));
  if (!requirements || periodMs <= 0) {
    return {
      success: false,
      errorMsg: "CONTROL_TOWER_FUEL_CONFIGURATION_UNAVAILABLE",
    };
  }
  const nowMs = Math.max(0, toInt(options.nowMs, Date.now()));
  if (nowMs < fuelState.nextCycleAtMs) {
    if (options.schedule !== false) {
      scheduleFuelReconciliation(itemID, fuelState.nextCycleAtMs, options);
    }
    return {
      success: true,
      data: tower,
      fuelState,
      active: true,
      completedCycles: 0,
    };
  }

  const dueCycles = Math.floor(
    (nowMs - fuelState.nextCycleAtMs) / periodMs,
  ) + 1;
  const affordableCycles = getAffordableCycleCount(tower, requirements);
  const completedCycles = Math.min(dueCycles, affordableCycles);
  const lastConsumedAtMs = completedCycles > 0
    ? fuelState.nextCycleAtMs + ((completedCycles - 1) * periodMs)
    : fuelState.lastConsumedAtMs;
  const nextCycleAtMs = fuelState.nextCycleAtMs + (completedCycles * periodMs);
  const consumeResult = consumeFuelCycles(tower, requirements, completedCycles, {
    active: true,
    periodMs,
    lastConsumedAtMs,
    nextCycleAtMs,
    exhaustedAtMs: null,
    cyclesConsumed: fuelState.cyclesConsumed + completedCycles,
  });
  if (!consumeResult.success) return consumeResult;
  tower = consumeResult.data.tower;
  if (completedCycles < dueCycles) {
    const offlineResult = offlineTowerForFuelExhaustion(
      tower,
      nextCycleAtMs,
      options,
    );
    syncInventoryChanges(
      options.session || null,
      consumeResult.data && consumeResult.data.changes,
      offlineResult.success && offlineResult.data
        ? offlineResult.data
        : tower,
    );
    return {
      ...offlineResult,
      exhausted: true,
      dueCycles,
      completedCycles,
      consumptionChanges: consumeResult.data && consumeResult.data.changes || [],
    };
  }

  fuelState = getFuelState(tower);
  // As with startup payment, publish the inventory removal only after the
  // advanced cycle deadline is durable. A synchronous presentation refresh
  // must never observe the old due timestamp and charge the same cycle twice.
  syncInventoryChanges(
    options.session || null,
    consumeResult.data && consumeResult.data.changes,
    tower,
  );
  if (options.schedule !== false) {
    scheduleFuelReconciliation(itemID, nextCycleAtMs, options);
  }
  log.debug(
    `[StarbaseFuel] reconciled tower=${itemID} cycles=${completedCycles} ` +
    `nextCycleAtMs=${nextCycleAtMs}`,
  );
  return {
    success: true,
    data: tower,
    fuelState,
    active: true,
    dueCycles,
    completedCycles,
    consumptionChanges: consumeResult.data && consumeResult.data.changes || [],
  };
}

function forceControlTowerFuelCycle(itemOrID, options = {}) {
  if (require("./starbaseReinforcementRuntime").isReinforced(itemOrID, options.nowMs ?? Date.now())) {
    return { success: false, errorMsg: "CONTROL_TOWER_REINFORCED" };
  }
  const itemID = toInt(
    itemOrID && typeof itemOrID === "object" ? itemOrID.itemID : itemOrID,
    0,
  );
  let tower = findItemById(itemID);
  const towerRuntime = getControlTowerRuntime();
  if (!tower || !towerRuntime.isControlTowerType(tower)) {
    return { success: false, errorMsg: "ITEM_NOT_CONTROL_TOWER" };
  }
  if (!towerRuntime.getControlTowerOnlineState(tower).isOnline) {
    return { success: false, errorMsg: "CONTROL_TOWER_NOT_ONLINE" };
  }

  let fuelState = getFuelState(tower);
  if (!fuelState.active || !fuelState.nextCycleAtMs) {
    const initialized = initializeControlTowerFuelState(tower, options);
    return {
      ...initialized,
      forced: initialized.success === true,
    };
  }

  // A GM-triggered cycle is paid now and starts a fresh period from now. Using
  // the previously scheduled deadline here would make an early forced cycle
  // push the following automatic payment almost two periods into the future.
  const forcedAtMs = Math.max(1, toInt(options.nowMs, Date.now()));
  const dueNowResult = updateInventoryItem(itemID, (currentItem) => ({
    ...currentItem,
    spaceState: withFuelState(currentItem, {
      ...getFuelState(currentItem),
      nextCycleAtMs: forcedAtMs,
    }),
  }));
  if (!dueNowResult.success || !dueNowResult.data) {
    return dueNowResult;
  }
  tower = dueNowResult.data;
  const result = reconcileControlTowerFuel(tower, {
    ...options,
    nowMs: forcedAtMs,
  });
  tower = result && result.data || findItemById(itemID) || tower;
  fuelState = getFuelState(tower);
  return {
    ...result,
    forced: result && result.success === true,
    forcedAtMs,
    fuelState,
  };
}

function reconcilePersistedControlTowerFuelStates(options = {}) {
  const nowMs = Math.max(0, toInt(options.nowMs, Date.now()));
  const consumeFuelWhileServerOffline = options.consumeFuelWhileServerOffline === undefined
    ? config.posConsumeFuelWhileServerOffline === true
    : options.consumeFuelWhileServerOffline === true;
  const towerRuntime = getControlTowerRuntime();
  const resourceRuntime = require(path.join(
    __dirname,
    "./starbaseResourceRuntime",
  ));
  const towers = listStarbaseItems({ groupID: 365 })
    .filter((item) => towerRuntime.isControlTowerType(item))
    .sort((left, right) => toInt(left.itemID, 0) - toInt(right.itemID, 0));
  const summary = {
    towers: towers.length,
    reconciled: 0,
    online: 0,
    onlining: 0,
    offline: 0,
    fuelCyclesConsumed: 0,
    exhausted: 0,
    deferredOfflineFuelCycles: 0,
    consumeFuelWhileServerOffline,
    failed: 0,
    failures: [],
  };

  for (let tower of towers) {
    const reinforcementResult = require("./starbaseReinforcementRuntime")
      .reconcileControlTowerReinforcement(tower, options);
    if (!reinforcementResult.success) {
      summary.failed += 1;
      summary.failures.push({ itemID: tower.itemID, errorMsg: reinforcementResult.errorMsg });
      continue;
    }
    tower = reinforcementResult.data;
    const initialOnlineState = towerRuntime.getControlTowerOnlineState(tower);
    const initialFuelState = getFuelState(tower);
    if (
      !consumeFuelWhileServerOffline &&
      !reinforcementResult.active &&
      initialOnlineState.isOnline &&
      initialFuelState.active &&
      initialFuelState.nextCycleAtMs
    ) {
      const requirements = towerRuntime.getControlTowerFuelRequirements(tower);
      const periodMs = Math.max(
        0,
        toInt(
          requirements && requirements.fuelPeriodMs,
          initialFuelState.periodMs,
        ),
      );
      if (periodMs > 0) {
        const resumeResult = updateInventoryItem(tower.itemID, (currentItem) => ({
          ...currentItem,
          spaceState: withFuelState(currentItem, {
            active: true,
            periodMs,
            nextCycleAtMs: nowMs + periodMs,
          }),
        }));
        if (!resumeResult.success || !resumeResult.data) {
          summary.failed += 1;
          summary.failures.push({
            itemID: toInt(tower.itemID, 0),
            errorMsg: resumeResult.errorMsg || "CONTROL_TOWER_FUEL_RESUME_FAILED",
          });
          continue;
        }
        summary.deferredOfflineFuelCycles += Math.max(
          0,
          initialFuelState.nextCycleAtMs <= nowMs
            ? Math.floor(
                (nowMs - initialFuelState.nextCycleAtMs) / periodMs,
              ) + 1
            : 0,
        );
      }
    }

    const result = towerRuntime.reconcileControlTowerOnlineState(tower.itemID, {
      nowMs,
      schedule: options.schedule !== false,
      refreshPresentation: false,
      reconcileFuel: true,
      reconcileForceField: true,
      spawnForceField: false,
      updateForceFieldScene: false,
      broadcastForceField: false,
    });
    if (!result.success) {
      summary.failed += 1;
      summary.failures.push({
        itemID: toInt(tower.itemID, 0),
        errorMsg: result.errorMsg || "CONTROL_TOWER_RECONCILIATION_FAILED",
      });
      continue;
    }

    summary.reconciled += 1;
    const fuelResult = result.fuelResult || null;
    summary.fuelCyclesConsumed += Math.max(
      0,
      toInt(fuelResult && fuelResult.completedCycles, 0),
    );
    if (fuelResult && fuelResult.exhausted === true) {
      summary.exhausted += 1;
    }

    const reconciledTower = result.data || findItemById(tower.itemID) || tower;
    const onlineState = towerRuntime.getControlTowerOnlineState(reconciledTower);
    if (onlineState.isOnline) {
      summary.online += 1;
    } else if (
      onlineState.onlineState === towerRuntime.CONTROL_TOWER_ONLINE_STATE.ONLINING
    ) {
      summary.onlining += 1;
    } else {
      summary.offline += 1;
      // Repair legacy or interrupted shutdowns as part of startup convergence.
      // An offline tower must never leave a powered dependent module behind.
      const moduleResult = resourceRuntime.deactivateTowerModules(
        reconciledTower,
        {
          reason: fuelResult && fuelResult.exhausted === true
            ? "fuelExhausted"
            : "controlTowerOffline",
          nowMs,
          refreshPresentation: false,
          broadcast: false,
        },
      );
      if (!moduleResult.success) {
        summary.failed += 1;
        summary.failures.push({
          itemID: toInt(tower.itemID, 0),
          errorMsg: moduleResult.errorMsg || "STARBASE_MODULE_SHUTDOWN_FAILED",
        });
      }
    }
  }

  // Fuel/reinforcement and dependency state are settled before rearming legacy
  // production. Restart never generates output for the server's offline time.
  summary.production = require("./starbaseProductionCycles").reconcilePersistedProduction({ ...options, restart: true });
  return summary;
}

function shutdownControlTowerFuelRuntime() {
  require("./starbaseProductionCycles").clearTimers();
  require("./starbaseReinforcementRuntime")._testing.clearTimers();
  clearFuelTimers();
  const towerRuntime = getControlTowerRuntime();
  if (
    towerRuntime._testing &&
    typeof towerRuntime._testing.clearControlTowerOnlineTimers === "function"
  ) {
    towerRuntime._testing.clearControlTowerOnlineTimers();
  }
  return true;
}

module.exports = {
  FUEL_STATE_VERSION,
  getFuelState,
  getAffordableCycleCount,
  consumeFuelCycles,
  initializeControlTowerFuelState,
  deactivateControlTowerFuelState,
  offlineControlTowerForFuelFailure,
  reconcileControlTowerFuel,
  reconcilePersistedControlTowerFuelStates,
  forceControlTowerFuelCycle,
  shutdownControlTowerFuelRuntime,
  _testing: {
    buildStackRequests,
    collectInventorySyncSessions,
    clearFuelTimer,
    clearFuelTimers,
    scheduleFuelReconciliation,
  },
};
