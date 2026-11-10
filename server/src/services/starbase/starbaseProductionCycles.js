"use strict";

const inventory = () => require("../inventory/itemStore");
const production = () => require("./starbaseProductionRuntime");
const fail = (errorMsg) => ({ success: false, errorMsg });
const online = (item) => item?.spaceState?.anchorState === "anchored" &&
  item.spaceState.onlineState === "online" && Number(item.spaceState.online) === 1 &&
  !require("./starbaseDefenseRuntime").hasUnavailableHealth(item);
const units = (row) => Number(row.singleton) === 1 ? 1 : Number(row.stacksize ?? row.quantity) || 0;
const volume = (typeID) => Math.max(0, Number(require("../inventory/itemTypeRegistry").resolveItemByTypeID(typeID)?.volume) || 0);
const timers = new Map();

function clearTimers() {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
}

function schedule(towerID, nextAtMs, options) {
  if (options.schedule === false) return;
  clearTimeout(timers.get(towerID)); timers.delete(towerID);
  if (!nextAtMs) return;
  const timer = setTimeout(() => {
    timers.delete(towerID);
    try {
      const result = reconcileTowerProduction(towerID);
      if (result.success) return;
    } catch (error) {
      require("../../utils/logger").warn(`[StarbaseProduction] Timer reconciliation failed for tower ${towerID}; retrying from its saved checkpoint: ${error.message}`);
    }
    schedule(towerID, Date.now() + 60000, {});
  }, Math.max(1, Math.min(2147000000, nextAtMs - Date.now())));
  timer.unref?.(); timers.set(towerID, timer);
}

function commitProduction(requests, options) {
  try {
    return inventory().consumeInventoryItemStacksAtomic(requests, options);
  } catch (error) {
    // itemStore rolls back rejected commits before rethrowing. Still treat a
    // thrown storage boundary conservatively: recovery reads the saved marker,
    // never assumes the failed call's in-memory plan was or was not committed.
    require("../../utils/logger").warn(`[StarbaseProduction] Persistence operation threw; reconciliation will use the saved checkpoint: ${error.message}`);
    return { ...fail("STARBASE_PRODUCTION_WRITE_ERROR"), retryable: true };
  }
}

function publish(result, scene) {
  if (!result.success || !scene) return result;
  try {
    const changes = result.changes || result.data?.changes || [];
    for (const change of changes) {
      const actor = scene.getEntityByID?.(Number(change.item?.itemID));
      if (actor && change.item?.spaceState) {
        actor.spaceState = structuredClone(change.item.spaceState);
        actor.starbaseModuleState = structuredClone(change.item.spaceState.starbaseModuleState || {});
      }
    }
    // Reuse the registered live broker and its real inventory bindings. A new
    // broker would have no subscriptions and would replace the observer source.
    require("../inventory/corporationOfficeInventoryObservers").fanStarbaseInventoryChanges(changes);
  } catch (error) {
    require("../../utils/logger").warn(`[StarbaseProduction] Committed inventory presentation will refresh on next read: ${error.message}`);
  }
  return result;
}

function writeClock(tower, state, options) {
  const result = commitProduction([], { associatedUpdates: [{ itemID: tower.itemID,
    expectedItem: tower, updater: (row) => production().withProduction(row, state) }] });
  if (result.success) schedule(tower.itemID, state.nextCycleAtMs || options.nowMs + 60000, options);
  return publish(result, options.scene);
}

function buildCyclePlan(tower, authority) {
  const runtime = production(), links = runtime.getProductionState(tower).links;
  const nodes = new Map(), degrees = new Map(), edges = new Map(), incoming = new Map();
  const edgeKeys = new Set(), inputKeys = new Set();
  const harvestedTypes = new Set();
  for (const [from, to, typeID] of links) {
    if (from === to || edgeKeys.has(`${from}:${typeID}`) || inputKeys.has(`${to}:${typeID}`)) return fail("STARBASE_PRODUCTION_LINK_INVALID");
    edgeKeys.add(`${from}:${typeID}`); inputKeys.add(`${to}:${typeID}`);
    for (const id of [from, to]) {
      if (!nodes.has(id)) {
        const item = inventory().findItemById(id);
        if (!runtime.isAssociated(tower, item) || item.custodyReservation) return fail("STARBASE_PRODUCTION_STRUCTURE_INVALID");
        if (!require("./starbaseAnchoringPolicy").validateSystemRestrictions(item).success) return fail("STARBASE_ANCHORING_RESTRICTED_IN_SYSTEM");
        const ports = runtime.getProductionPorts(tower, item, authority);
        if (ports.errorMsg) return fail(ports.errorMsg);
        if (item.groupID === 416 && ports.resource) {
          if (harvestedTypes.has(ports.resource.typeID)) return fail("STARBASE_PRODUCTION_HARVESTER_DUPLICATE");
          harvestedTypes.add(ports.resource.typeID);
        }
        nodes.set(id, { item, ports, pool: new Map(), initial: new Map(), contents: [] }); degrees.set(id, 0);
      }
    }
    if (!nodes.get(from).ports.outputs.includes(typeID) || !nodes.get(to).ports.inputs.includes(typeID)) return fail("STARBASE_PRODUCTION_LINK_TYPE_MISMATCH");
    edges.set(from, [...(edges.get(from) || []), [to, typeID]]);
    incoming.set(`${to}:${typeID}`, from); degrees.set(to, degrees.get(to) + 1);
  }
  const queue = [...nodes.keys()].filter((id) => degrees.get(id) === 0).sort((a, b) => a - b), order = [];
  while (queue.length) {
    const id = queue.shift(); order.push(id);
    for (const [to] of edges.get(id) || []) {
      degrees.set(to, degrees.get(to) - 1); if (!degrees.get(to)) queue.push(to);
    }
  }
  if (order.length !== nodes.size) return fail("STARBASE_PRODUCTION_LINK_CYCLE");
  for (const node of nodes.values()) {
    if (node.item.groupID !== 404) continue;
    node.contents = inventory().listContainerItems(null, node.item.itemID, null);
    for (const row of node.contents) {
      if (row.ownerID === tower.ownerID && row.flagID === 0 && !row.custodyReservation) {
        node.pool.set(row.typeID, (node.pool.get(row.typeID) || 0) + units(row));
      }
    }
    node.initial = new Map(node.pool);
  }
  const add = (node, typeID, quantity) => node.pool.set(typeID, (node.pool.get(typeID) || 0) + quantity);
  const push = (sourceID, typeID, quantity) => {
    const targetID = (edges.get(sourceID) || []).find((edge) => edge[1] === typeID)?.[0];
    const target = nodes.get(targetID);
    if (!target || !online(target.item)) return false;
    add(target, typeID, quantity); return true;
  };
  let produced = false;
  for (const id of order) {
    const node = nodes.get(id), { item, ports } = node;
    if (!online(item)) continue;
    if (item.groupID === 404) {
      // Couplings/silos buffer their inventory while the next silo is offline.
      // Draining toward an available silo is capacity-bounded, not lossy.
      for (const [to, typeID] of edges.get(id) || []) {
        const target = nodes.get(to);
        if (target.item.groupID !== 404 || !online(target.item)) continue;
        const used = [...target.pool].reduce((sum, [type, count]) => sum + count * volume(type), 0);
        const free = Math.max(0, runtime.getProductionCapacity(target.item) - used);
        const amount = Math.min(node.pool.get(typeID) || 0, Math.floor(free / Math.max(volume(typeID), 1e-9)));
        if (amount > 0) { add(node, typeID, -amount); add(target, typeID, amount); produced = true; }
      }
    } else if (item.groupID === 416) {
      const resource = ports.resource;
      if (!resource) return fail("STARBASE_LEGACY_MOON_AUTHORITY_MISSING");
      const amount = Math.min(runtime.typeAttribute(item.typeID, 710), resource.abundance) * runtime.typeAttribute(resource.typeID, 726);
      if (!Number.isSafeInteger(amount) || amount <= 0 || !push(id, resource.typeID, amount)) return fail("STARBASE_PRODUCTION_OUTPUT_UNAVAILABLE");
      produced = true;
    } else {
      const recipe = ports.reaction;
      for (const input of recipe.inputs) {
        const source = nodes.get(incoming.get(`${id}:${input.typeID}`));
        const pool = source?.item.groupID === 404 ? source.pool : node.pool;
        if (!source || !online(source.item) || (pool.get(input.typeID) || 0) < input.quantity) return fail("STARBASE_PRODUCTION_INPUT_REQUIRED");
        pool.set(input.typeID, pool.get(input.typeID) - input.quantity);
      }
      for (const output of recipe.outputs) {
        if (!push(id, output.typeID, output.quantity)) return fail("STARBASE_PRODUCTION_OUTPUT_UNAVAILABLE");
      }
      produced = true;
    }
  }
  const requests = [], outputs = [], guards = [];
  for (const { item, pool, initial, contents, ports } of nodes.values()) {
    guards.push(item); if (ports.loaded) guards.push(ports.loaded);
    if (item.groupID !== 404) {
      if ([...pool.values()].some((count) => count !== 0)) return fail("STARBASE_PRODUCTION_DIRECT_LINK_RATE_MISMATCH");
      continue;
    }
    const foreignVolume = contents.filter((row) => row.ownerID !== tower.ownerID || row.flagID !== 0 || row.custodyReservation)
      .reduce((sum, row) => sum + units(row) * volume(row.typeID), 0);
    if (foreignVolume + [...pool].reduce((sum, [type, count]) => sum + count * volume(type), 0) > runtime.getProductionCapacity(item) + 1e-7) {
      return fail("STARBASE_PRODUCTION_CAPACITY");
    }
    for (const typeID of new Set([...pool.keys(), ...initial.keys()])) {
      const delta = (pool.get(typeID) || 0) - (initial.get(typeID) || 0);
      if (delta > 0) outputs.push({ typeID, quantity: delta, ownerID: tower.ownerID, locationID: item.itemID, flagID: 0 });
      let remaining = -delta;
      for (const stack of contents.filter((row) => row.typeID === typeID && row.ownerID === tower.ownerID && row.flagID === 0 && !row.custodyReservation).sort((a, b) => a.itemID - b.itemID)) {
        if (remaining <= 0) break;
        const quantity = Math.min(remaining, units(stack));
        requests.push({ itemID: stack.itemID, quantity, expectedTypeID: typeID, expectedOwnerID: tower.ownerID,
          expectedLocationID: item.itemID, expectedFlagID: 0, expectedQuantity: units(stack) }); remaining -= quantity;
      }
      if (remaining > 0) return fail("STARBASE_PRODUCTION_INPUT_REQUIRED");
    }
  }
  return { success: true, data: { requests, outputs, guards, produced } };
}

function reconcileTowerProduction(towerID, options = {}) {
  const nowMs = Number(options.nowMs) || Date.now(); options = { ...options, nowMs };
  let tower = inventory().findItemById(Number(towerID));
  if (!tower || tower.categoryID !== 23 || tower.groupID !== 365) return fail("CONTROL_TOWER_NOT_FOUND");
  if (tower.custodyReservation) return fail("STARBASE_PRODUCTION_STRUCTURE_INVALID");
  options.scene ||= require("../../space/runtime").findSceneContainingDynamicEntity(tower.itemID);
  const runtime = production();
  let state = runtime.getProductionState(tower);
  if (!state.links.length) return options.force === true ? fail("STARBASE_PRODUCTION_LINK_REQUIRED")
    : { success: true, data: { status: "unconfigured", completed: false } };
  const period = runtime.typeAttribute(tower.typeID, 722);
  if (!Number.isSafeInteger(period) || period <= 0) return fail("STARBASE_PRODUCTION_PERIOD_INVALID");
  let authority;
  try { authority = require("./starbaseProductionAuthority").getProductionAuthority(); }
  catch { return fail("STARBASE_PRODUCTION_AUTHORITY_INVALID"); }
  if (!online(tower) || require("./starbaseReinforcementRuntime").isReinforced(tower.itemID, nowMs)) {
    return writeClock(tower, { ...state, nextCycleAtMs: null, status: "paused", lastError: "STARBASE_PRODUCTION_TOWER_UNAVAILABLE" }, options);
  }
  if (options.restart === true || !state.nextCycleAtMs || state.authorityFingerprint !== authority.fingerprint) {
    const reset = { ...state, nextCycleAtMs: nowMs + period, status: "waiting", lastError: null, authorityFingerprint: authority.fingerprint };
    const result = writeClock(tower, reset, options);
    if (!result.success || options.force !== true) return result;
    return reconcileTowerProduction(towerID, { ...options, restart: false });
  }
  if (options.force !== true && nowMs < state.nextCycleAtMs) {
    schedule(tower.itemID, state.nextCycleAtMs, options);
    return { success: true, data: { status: state.status, completed: false } };
  }
  if (options.reconcileFuel !== false) {
    const fuel = require("./starbaseFuelRuntime").reconcileControlTowerFuel(tower.itemID, {
      nowMs, schedule: options.schedule !== false,
    });
    if (!fuel.success) return fuel;
    tower = inventory().findItemById(tower.itemID);
    state = runtime.getProductionState(tower);
    if (!online(tower) || require("./starbaseReinforcementRuntime").isReinforced(tower.itemID, nowMs)) {
      return writeClock(tower, { ...state, nextCycleAtMs: null, status: "paused", lastError: "STARBASE_PRODUCTION_TOWER_UNAVAILABLE" }, options);
    }
  }
  // Do not backfill production across unobserved server downtime or long stalls.
  // One observed deadline means one cycle; the next deadline starts from now.
  const plan = buildCyclePlan(tower, authority);
  if (!plan.success) {
    const result = writeClock(tower, { ...state, nextCycleAtMs: nowMs + period, status: "blocked", lastError: plan.errorMsg }, options);
    return result.success ? { ...plan, clockCommitted: true } : result;
  }
  const next = { ...state, nextCycleAtMs: nowMs + period, lastCycleAtMs: nowMs,
    cyclesCompleted: state.cyclesCompleted + 1, status: plan.data.produced ? "operating" : "waiting", lastError: null };
  const result = commitProduction(plan.data.requests, {
    producedStacks: plan.data.outputs,
    associatedUpdates: [{ itemID: tower.itemID, expectedItem: tower, updater: (row) => runtime.withProduction(row, next) },
      ...plan.data.guards.map((item) => ({ itemID: item.itemID, expectedItem: item, updater: (row) => row }))],
  });
  if (result.success) {
    result.data.completed = true; result.data.cyclesCompleted = next.cyclesCompleted;
    schedule(tower.itemID, next.nextCycleAtMs, options);
  }
  return publish(result, options.scene);
}

function reconcilePersistedProduction(options = {}) {
  const results = [];
  for (const tower of inventory().listStarbaseItems({ groupID: 365 })) {
    if (tower?.categoryID === 23 && tower.groupID === 365 && production().getProductionState(tower).links.length) {
      results.push({ towerID: tower.itemID, ...reconcileTowerProduction(tower.itemID, options) });
    }
  }
  return results;
}

function invalidateProductionForItem(itemOrID, options = {}) {
  const item = typeof itemOrID === "object" ? itemOrID : inventory().findItemById(Number(itemOrID));
  if (!item || item.categoryID !== 23) return { success: true };
  const towerID = item.groupID === 365 ? item.itemID : item.spaceState?.controlTowerID;
  const tower = inventory().findItemById(towerID);
  if (!tower || !production().getProductionState(tower).links.length) return { success: true };
  if (options.destroyed === true) {
    clearTimeout(timers.get(towerID)); timers.delete(towerID);
    const state = production().getProductionState(tower);
    return writeClock(tower, { ...state, links: item.groupID === 365 ? [] : state.links.filter(([from, to]) => from !== item.itemID && to !== item.itemID),
      nextCycleAtMs: null, status: "interrupted", lastError: "STARBASE_PRODUCTION_STRUCTURE_DESTROYED" },
    { ...options, nowMs: Number(options.nowMs) || Date.now(), schedule: false });
  }
  return reconcileTowerProduction(towerID, { ...options, restart: true });
}

module.exports = { buildCyclePlan, reconcileTowerProduction, reconcilePersistedProduction,
  invalidateProductionForItem, clearTimers };
