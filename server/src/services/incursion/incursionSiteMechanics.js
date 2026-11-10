"use strict";

// Frozen site predicates decide progression. Native room activation, absent
// actors and wall-clock catch-up alone are never substitutes for these facts.
const model = require("./incursionSiteModel");
const clock = require("./incursionClock");
const reinforcements = require("./incursionReinforcements");
const { fail, fingerprint } = require("./incursionLifecycleContract");
const positive = value => Number.isSafeInteger(value) && value > 0;
const stageFor = (policy, key) => policy.stages.find(stage => stage.key === key);
const ruleFor = (policy, key) => policy.mechanics.stageRules.find(rule => rule.key === key);
const objectiveFor = (policy, key) => policy.objectives.find(objective => objective.key === key);
function validatePredicate(policy, value, depth = 0, budget = { left: 1024 }) {
  const invalid = () => fail("INCURSION_SITE_MECHANIC_INVALID");
  if (!value || typeof value !== "object" || Array.isArray(value) || depth > 32 || --budget.left < 0) invalid();
  switch (value.kind) {
    case "all": case "any":
      if (!Array.isArray(value.predicates) || !value.predicates.length || value.predicates.length > 64) invalid();
      for (const child of value.predicates) validatePredicate(policy, child, depth + 1, budget);
      break;
    case "not": validatePredicate(policy, value.predicate, depth + 1, budget); break;
    case "site-active": case "not-required-for-site-terminal": break;
    case "first-uncloaked-pilot-in-room": case "elapsed-after-first-uncloaked-entry":
      if (!positive(value.roomID) || !policy.roomKeys.includes(`room:${value.roomID}`) ||
          (value.kind === "elapsed-after-first-uncloaked-entry" && (!Number.isSafeInteger(value.delayMs) || value.delayMs < 0))) invalid();
      break;
    case "all-stages-cleared":
      if (!Array.isArray(value.stageKeys) || !value.stageKeys.length || value.stageKeys.some(key => !stageFor(policy, key))) invalid();
      break;
    case "stage-started": case "all-declared-actors-destroyed":
      if (!stageFor(policy, value.stageKey)) invalid();
      break;
    case "all-group-actors-destroyed":
      if (!ruleFor(policy, value.stageKey)?.groups?.some(group => group.key === value.groupKey && group.actorKeys?.length)) invalid();
      break;
    case "all-tagged-actors-destroyed":
      if (!stageFor(policy, value.stageKey)?.actors.some(actor => actor.tags?.includes(value.tag))) invalid();
      break;
    case "terminal-actor-destroyed":
      if (!stageFor(policy, value.stageKey)?.actors.some(actor => actor.typeID === value.typeID && actor.role === "terminal")) invalid();
      break;
    case "all-reserved-group-generations-destroyed":
      if (!policy.mechanics.optionalGroups?.some(group => group.key === value.familyKey)) invalid();
      break;
    case "objective-cargo-consumed": case "at-least-one-objective-cargo-consumption": {
      const objective = objectiveFor(policy, value.objectiveKey);
      if (objective?.kind !== "cargo" || objective.typeID !== value.typeID || !positive(value.quantity)) invalid();
      break;
    }
    case "terminal-health-receipt":
      if (objectiveFor(policy, value.objectiveKey)?.kind !== "structure" || value.reason !== "destroyed") invalid();
      break;
    case "successful-mining-custody-receipt":
      if (!positive(value.sourceObjectID) || !policy.mechanics.objectBindings[String(value.sourceObjectID)]) invalid();
      break;
    default: invalid();
  }
}
function validatePolicy(policy) {
  model.validatePolicy(policy);
  const mechanics = policy.mechanics;
  if (mechanics?.version !== 1 || !Array.isArray(policy.roomKeys) || !policy.roomKeys.length ||
      !Array.isArray(mechanics.stageRules) || mechanics.stageRules.length !== policy.stages.length ||
      !mechanics.objectBindings || typeof mechanics.objectBindings !== "object" ||
      !Array.isArray(mechanics.gates) || !Array.isArray(mechanics.objectives) ||
      new Set(mechanics.stageRules.map(rule => rule.key)).size !== mechanics.stageRules.length) fail("INCURSION_SITE_MECHANIC_INVALID");
  for (const rule of mechanics.stageRules) {
    const stage = stageFor(policy, rule.key);
    if (!stage || !Array.isArray(rule.groups)) fail("INCURSION_SITE_MECHANIC_INVALID");
    const grouped = rule.groups.flatMap(group => group.actorKeys || []);
    if (grouped.length !== stage.actors.length || new Set(grouped).size !== grouped.length ||
        grouped.some(key => !stage.actors.some(actor => actor.key === key))) fail("INCURSION_SITE_MECHANIC_INVALID");
    validatePredicate(policy, rule.trigger); validatePredicate(policy, rule.clearedWhen);
  }
  for (const gate of mechanics.gates) {
    if (!positive(gate.nativeObjectID) || !mechanics.objectBindings[gate.nativeObjectID] ||
        !policy.roomKeys.concat(policy.lobbyRoomKey).includes(`room:${gate.fromRoomID}`) ||
        !policy.roomKeys.includes(`room:${gate.toRoomID}`) ||
        (gate.lockedVisualObjectID && !mechanics.objectBindings[gate.lockedVisualObjectID])) fail("INCURSION_SITE_MECHANIC_INVALID");
    validatePredicate(policy, gate.unlocksWhen);
  }
  for (const objective of policy.objectives) if (objective.mechanicsRequires) validatePredicate(policy, objective.mechanicsRequires);
  reinforcements.families(policy);
  return policy;
}
function destroyed(state, actorKey) {
  const birth = state.births[actorKey], retired = state.retirements[actorKey];
  return Boolean(birth && retired?.reason === "destroyed" && retired.entityID === birth.entityID && retired.typeID === birth.typeID);
}
function allDestroyed(state, keys) {
  return keys.length > 0 && keys.every(key => destroyed(state, key));
}
function evaluate(state, value, nowMs = clock.now()) {
  validatePredicate(state.policy, value);
  const policy = state.policy, mechanics = state.mechanics || {};
  switch (value.kind) {
    case "all": return value.predicates.every(child => evaluate(state, child, nowMs));
    case "any": return value.predicates.some(child => evaluate(state, child, nowMs));
    case "not": return !evaluate(state, value.predicate, nowMs);
    case "site-active": return state.status === "active";
    case "not-required-for-site-terminal": return false;
    case "first-uncloaked-pilot-in-room": return positive(mechanics.roomEntries?.[`room:${value.roomID}`]);
    case "elapsed-after-first-uncloaked-entry": {
      const entry = mechanics.roomEntries?.[`room:${value.roomID}`];
      return positive(entry) && nowMs >= entry && nowMs - entry >= value.delayMs;
    }
    case "all-stages-cleared": return value.stageKeys.every(key => state.stages[key]?.completed === true);
    case "stage-started": return state.stages[value.stageKey]?.active === true;
    case "all-declared-actors-destroyed": return allDestroyed(state, stageFor(policy, value.stageKey).actors.map(actor => actor.key));
    case "all-group-actors-destroyed": return allDestroyed(state, ruleFor(policy, value.stageKey).groups.find(group => group.key === value.groupKey).actorKeys);
    case "all-tagged-actors-destroyed": return allDestroyed(state, stageFor(policy, value.stageKey).actors.filter(actor => actor.tags?.includes(value.tag)).map(actor => actor.key));
    case "terminal-actor-destroyed": return allDestroyed(state, stageFor(policy, value.stageKey).actors.filter(actor => actor.role === "terminal" && actor.typeID === value.typeID).map(actor => actor.key));
    case "all-reserved-group-generations-destroyed": {
      const family = policy.mechanics.optionalGroups.find(group => group.key === value.familyKey);
      const groups = reinforcements.cohorts(state).filter(group => group.familyKey === value.familyKey);
      if (groups.length < (family.maximumGenerations || Infinity) && mechanics.pendingMiningReceipts?.length) return false;
      return groups.every(group => allDestroyed(state, group.actors.map(actor => actor.key)));
    }
    case "objective-cargo-consumed": case "at-least-one-objective-cargo-consumption":
      return state.objectives[value.objectiveKey]?.quantity >= value.quantity && Object.keys(state.objectives[value.objectiveKey].receipts).length > 0;
    case "terminal-health-receipt": {
      const fact = mechanics.healthReceipts?.[value.objectiveKey];
      return Boolean(fact?.receiptID && fact.reason === value.reason && (!value.cause || fact.cause === value.cause));
    }
    case "successful-mining-custody-receipt": return Object.values(mechanics.miningReceipts || {}).some(receipt => receipt.sourceObjectID === value.sourceObjectID);
    default: return false;
  }
}
function loadedScene(instance) {
  return require.cache[require.resolve("../../space/runtime")]?.exports?.scenes?.get(instance.solarSystemID) || null;
}
function enteredRooms(instance, policy) {
  const scene = loadedScene(instance), rooms = new Set();
  if (!scene || Number(scene.systemID) !== instance.solarSystemID) return rooms;
  for (const session of scene.sessions?.values() || []) {
    const ship = scene.getShipEntityForSession?.(session), roomKey = ship?.dungeonCurrentRoomKey;
    if (!ship || session.socket?.destroyed || ship.session !== session || scene.getEntityByID?.(ship.itemID) !== ship ||
        ship.kind !== "ship" || ship.nativeNpc || Number(ship.groupID) === 29 || ship.destroyed || ship.destroying || ship.warpState ||
        String(ship.mode).toUpperCase() === "WARP" || ship.isCloaked || ship.cloakMode || ship.cloaked ||
        !positive(Number(session.characterID || session.charid)) || Number(ship.dungeonCurrentInstanceID) !== instance.instanceID ||
        !policy.roomKeys.includes(roomKey)) continue;
    const center = require("./incursionEncounterRuntime").siteRoomPosition(instance, roomKey);
    const distance = Math.hypot(...["x", "y", "z"].map(axis => Number(ship.position?.[axis]) - center[axis]));
    if (distance <= policy.participation.radiusMeters) rooms.add(roomKey);
  }
  return rooms;
}
function advance(instance, previous) {
  validatePolicy(previous.policy);
  if (fingerprint(previous.policy) !== previous.policyFingerprint) fail("INCURSION_STATE_INVALID");
  let state = structuredClone(previous);
  if (state.status !== "active") return state;
  const nowMs = clock.now();
  if (!positive(nowMs)) fail("INCURSION_CLOCK_INVALID");
  const present = enteredRooms(instance, state.policy);
  for (const roomKey of present) {
    state.mechanics ||= {}; state.mechanics.roomEntries ||= {};
    state.mechanics.roomEntries[roomKey] ||= nowMs;
  }
  // A delayed first-entry clock remains durable when all pilots leave. Its
  // actor intent can activate offline without waking a scene or spawning NPCs.
  const eligible = state.policy.mechanics.stageRules.filter(rule => evaluate(state, rule.trigger, nowMs)).map(rule => rule.key);
  for (const roomKey of state.policy.roomKeys) state = model.activateRoom(state, roomKey, eligible);
  return reinforcements.advance(state, nowMs);
}
function reconcileGates(instance, operation) {
  const dungeon = require("../dungeon/dungeonRuntime"), nowMs = clock.now();
  for (const gate of operation.policy.mechanics.gates) {
    const key = `gate:${gate.nativeObjectID}`, state = evaluate(operation, gate.unlocksWhen, nowMs) ? "unlocked" : "locked";
    const current = dungeon.getInstance(instance.instanceID) || instance;
    if (current.gateStatesByKey?.[key]?.state === state) continue;
    dungeon.upsertGateState(instance.instanceID, key, { state }, { nowMs });
  }
}
function gateProfile(instance, profile) {
  if (!profile.incursionPhaseOwned) return profile;
  const policy = instance.spawnState?.populationHints?.incursionPolicy;
  if (policy?.version !== 2) fail("INCURSION_SITE_MECHANIC_INVALID");
  const gate = policy.mechanics.gates.find(row => `gate:${row.nativeObjectID}` === profile.gateKey);
  if (!gate) fail("INCURSION_SITE_MECHANIC_INVALID");
  const locked = instance.gateStatesByKey?.[profile.gateKey]?.state !== "unlocked";
  const binding = policy.mechanics.objectBindings[String(locked && gate.lockedVisualObjectID || gate.nativeObjectID)];
  if (!binding) fail("INCURSION_SITE_MECHANIC_INVALID");
  return { ...profile, typeID: binding.typeID, dunObjectID: binding.objectID, roomKey: binding.roomKey,
    positionOffset: binding.positionOffset, nameID: binding.nameID, dunRotation: binding.dunRotation };
}
module.exports = { validatePolicy, evaluate, advance, reconcileGates, gateProfile };
