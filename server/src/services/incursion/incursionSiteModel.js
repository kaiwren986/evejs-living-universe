"use strict";

// Reviewed additional encounters use independent stages and explicit objective
// facts. Accepted NCO v1 operations continue through their original reducer.
const { fingerprint, fail, SITES } = require("./incursionLifecycleContract");
const participation = require("./incursionParticipation");
const reinforcements = require("./incursionReinforcements");
const friendlies = require("./incursionFriendlyActors");
const SCHEMA = "evejs.incursion-site-policy.v2";
const positive = value => Number.isSafeInteger(value) && value > 0;
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const keyValid = value => typeof value === "string" && !["__proto__", "prototype", "constructor"].includes(value) && /^[A-Za-z0-9:_#.-]{1,180}$/.test(value);
function validateCondition(condition, stageKeys, objectiveKeys, actorKeys, depth = 0, budget = { left: 512 }) {
  if (depth > 32 || --budget.left < 0) fail("INCURSION_SITE_CONDITION_INVALID");
  if (!condition || typeof condition !== "object" || Array.isArray(condition)) fail("INCURSION_SITE_CONDITION_INVALID");
  const keys = Object.keys(condition);
  if (keys.length !== 1) fail("INCURSION_SITE_CONDITION_INVALID");
  if (condition.all || condition.any) {
    const children = condition.all || condition.any;
    if (!Array.isArray(children) || !children.length || children.length > 64) fail("INCURSION_SITE_CONDITION_INVALID");
    for (const child of children) validateCondition(child, stageKeys, objectiveKeys, actorKeys, depth + 1, budget);
  } else if (condition.stage) {
    if (!stageKeys.has(condition.stage)) fail("INCURSION_SITE_CONDITION_INVALID");
  } else if (condition.objective) {
    if (!objectiveKeys.has(condition.objective)) fail("INCURSION_SITE_CONDITION_INVALID");
  } else if (condition.destroyed) {
    if (!actorKeys.has(condition.destroyed)) fail("INCURSION_SITE_CONDITION_INVALID");
  } else fail("INCURSION_SITE_CONDITION_INVALID");
}
function validatePolicy(policy) {
  const native = SITES.find(row => row.dungeonID === policy?.dungeonID);
  if (policy?.schema !== SCHEMA || policy.version !== 2 || !native || native.dungeonID === 5166 ||
      policy.rewardGroupID !== native.rewardGroupID || !Array.isArray(policy.stages) || !policy.stages.length || policy.stages.length > 64 ||
      !Array.isArray(policy.objectives) || policy.objectives.length > 64 || !policy.rewardDefinition || !policy.catalogIdentity ||
      policy.participation?.version !== 1 || !(policy.participation.minimumAppliedContribution > 0) ||
      !Number.isFinite(policy.participation.minimumAppliedContribution) || !(policy.participation.radiusMeters > 0) ||
      !Number.isFinite(policy.participation.radiusMeters) || policy.rewardDefinition.groupRewardID !== native.rewardGroupID ||
      policy.participation.winner !== "highest-applied-damage-fleet" ||
      policy.participation.presence !== "active-uncloaked-ship-at-completion" ||
      policy.participation.membership !== "same-fleet-at-effect-and-completion") fail("INCURSION_SITE_POLICY_INVALID");
  const stageKeys = new Set(), encounterKeys = new Set(), actorKeys = new Set(), objectiveKeys = new Set();
  let actors = 0;
  for (const stage of policy.stages) {
    if (!keyValid(stage.key) || stageKeys.has(stage.key) || !keyValid(stage.roomKey) || !keyValid(stage.encounterKey) || encounterKeys.has(stage.encounterKey) ||
        !Array.isArray(stage.actors) || stage.actors.length > 256 || !Array.isArray(stage.prerequisites)) fail("INCURSION_SITE_STAGE_INVALID");
    stageKeys.add(stage.key); encounterKeys.add(stage.encounterKey);
    for (const actor of stage.actors) {
      if (!keyValid(actor.key) || actorKeys.has(actor.key) || !positive(actor.typeID) ||
          !["required", "optional", "terminal"].includes(actor.role)) fail("INCURSION_SITE_ACTOR_INVALID");
      actorKeys.add(actor.key); actors++;
    }
  }
  if (!actors || actors > 2048) fail("INCURSION_SITE_ACTOR_INVALID");
  for (const objective of policy.objectives) {
    if (!keyValid(objective.key) || objectiveKeys.has(objective.key) ||
        !["cargo", "hack", "structure", "departure"].includes(objective.kind) ||
        !keyValid(objective.roomKey) || !Number.isSafeInteger(objective.quantity) || objective.quantity <= 0 ||
        (objective.kind === "cargo" && !positive(objective.typeID)) ||
        (objective.repeatable !== undefined && typeof objective.repeatable !== "boolean") ||
        (objective.repeatable === true && !["cargo", "hack"].includes(objective.kind))) fail("INCURSION_SITE_OBJECTIVE_INVALID");
    objectiveKeys.add(objective.key);
  }
  for (const stage of policy.stages) {
    if (stage.prerequisites.some(key => !stageKeys.has(key) || key === stage.key)) fail("INCURSION_SITE_STAGE_INVALID");
    if (stage.clearCondition) {
      validateCondition(stage.clearCondition, stageKeys, objectiveKeys, actorKeys);
      const localKills = value => value.destroyed ? stage.actors.some(actor => actor.key === value.destroyed)
        : Boolean((value.all || value.any)?.every(localKills));
      if (!localKills(stage.clearCondition)) fail("INCURSION_SITE_CONDITION_INVALID");
    }
  }
  // Cyclic branch prerequisites must fail before an encounter is admitted.
  const visiting = new Set(), visited = new Set();
  const visit = key => {
    if (visiting.has(key)) fail("INCURSION_SITE_STAGE_CYCLE");
    if (visited.has(key)) return;
    visiting.add(key);
    for (const parent of policy.stages.find(stage => stage.key === key).prerequisites) visit(parent);
    visiting.delete(key); visited.add(key);
  };
  for (const stage of policy.stages) visit(stage.key);
  for (const objective of policy.objectives) if (objective.requires) validateCondition(objective.requires, stageKeys, objectiveKeys, actorKeys);
  const references = value => !value ? [] : value.objective ? [value.objective] : (value.all || value.any || []).flatMap(references);
  visiting.clear(); visited.clear();
  const visitObjective = key => {
    if (visiting.has(key)) fail("INCURSION_SITE_OBJECTIVE_CYCLE");
    if (visited.has(key)) return;
    visiting.add(key);
    for (const parent of references(policy.objectives.find(row => row.key === key).requires)) visitObjective(parent);
    visiting.delete(key); visited.add(key);
  };
  for (const objective of policy.objectives) visitObjective(objective.key);
  validateCondition(policy.completion, stageKeys, objectiveKeys, actorKeys);
  const stageReferences = value => !value ? [] : value.stage ? [value.stage] : (value.all || value.any || []).flatMap(stageReferences);
  const referenced = new Set([...policy.stages.flatMap(stage => stage.prerequisites), ...stageReferences(policy.completion),
    ...policy.objectives.flatMap(objective => stageReferences(objective.requires))]);
  for (const key of referenced) if (!policy.stages.find(stage => stage.key === key).clearCondition &&
      !policy.stages.find(stage => stage.key === key).actors.some(actor => actor.role !== "optional")) {
    fail("INCURSION_SITE_STAGE_UNFINISHABLE");
  }
  friendlies.declarations(policy);
  return policy;
}
function createOperation(identity, policy, nowMs) {
  validatePolicy(policy);
  if (!["instanceID", "poolGroupID", "taleID", "solarSystemID", "rewardID", "generation"].every(key => positive(identity?.[key])) ||
      identity.operationID !== `incursion-v2:${identity.instanceID}` || !["tale-slot", "tale-final"].includes(identity.placement) ||
      !["high", "low", "null"].includes(identity.securityBand) || identity.rewardID !== policy.rewardGroupID ||
      !identity.dungeonName || !positive(nowMs)) fail("INCURSION_IDENTITY_INVALID");
  return friendlies.freeze({ version: 2, identity: structuredClone(identity), policy: structuredClone(policy), policyFingerprint: fingerprint(policy),
    status: "active", startedAtMs: nowMs, births: {}, retirements: {}, contributions: {}, events: {},
    stages: Object.fromEntries(policy.stages.map(stage => [stage.key, { active: false, completed: false }])),
    objectives: Object.fromEntries(policy.objectives.map(objective => [objective.key, { quantity: 0, receipts: {} }])) });
}
function checked(previous) {
  if (previous?.version !== 2 || fingerprint(previous.policy) !== previous.policyFingerprint) fail("INCURSION_STATE_INVALID");
  validatePolicy(previous.policy);
  friendlies.assertVersion(previous);
  return structuredClone(previous);
}
function actorDeclaration(state, key) {
  for (const stage of state.policy.stages) {
    const actor = stage.actors.find(row => row.key === key);
    if (actor) return { ...actor, stageKey: stage.key, roomKey: stage.roomKey };
  }
  return reinforcements.actorDeclaration(state, key) || friendlies.actorDeclaration(state.policy, key);
}
function condition(state, value) {
  if (value.all) return value.all.every(child => condition(state, child));
  if (value.any) return value.any.some(child => condition(state, child));
  if (value.stage) return state.stages[value.stage]?.completed === true;
  if (value.destroyed) return state.retirements[value.destroyed]?.reason === "destroyed";
  if (value.objective) {
    const objective = state.policy.objectives.find(row => row.key === value.objective);
    return Boolean(objective && state.objectives[objective.key]?.quantity >= objective.quantity);
  }
  return false;
}
function refresh(state) {
  for (const stage of state.policy.stages) {
    if (!state.stages[stage.key].active) continue;
    const required = stage.actors.filter(actor => actor.role !== "optional");
    state.stages[stage.key].completed = stage.actors.every(actor => state.births[actor.key]) &&
      (stage.clearCondition ? condition(state, stage.clearCondition) : required.length > 0 && required.every(actor => state.retirements[actor.key]));
  }
  if (state.status === "active" && condition(state, state.policy.completion)) state.status = "ready";
  return state;
}
function activateRoom(previous, roomKey, eligibleStageKeys = null) {
  const state = checked(previous);
  if (eligibleStageKeys !== null && (!Array.isArray(eligibleStageKeys) ||
      eligibleStageKeys.some(key => !state.policy.stages.some(stage => stage.key === key)))) fail("INCURSION_SITE_STAGE_INVALID");
  if (state.status !== "active") return state;
  for (const stage of state.policy.stages) if (stage.roomKey === roomKey &&
      (eligibleStageKeys === null || eligibleStageKeys.includes(stage.key)) && stage.prerequisites.every(key => state.stages[key].completed)) {
    state.stages[stage.key].active = true;
  }
  return refresh(state);
}
function canSpawn(state, encounterKey) {
  const stage = state.policy.stages.find(row => row.encounterKey === encounterKey);
  const group = stage ? null : [...reinforcements.cohorts(state), ...friendlies.cohorts(state)].find(row => row.encounterKey === encounterKey);
  return state.status === "active" && (stage ? state.stages[stage.key].active && !state.stages[stage.key].completed
    : Boolean(group?.active && !group.actors.every(actor => state.retirements[actor.key])));
}
function birthsReady(state, key) {
  const actor = actorDeclaration(state, key);
  if (!actor) return false;
  if (actor.auxiliary) return Boolean(state.births[key]);
  const stage = actor.cohortKey ? reinforcements.cohorts(state).find(row => row.key === actor.cohortKey)
    : state.policy.stages.find(row => row.key === actor.stageKey);
  return stage.actors.every(row => state.births[row.key]);
}
function recordBirth(previous, { key, entityID, typeID }) {
  const state = checked(previous), actor = actorDeclaration(state, key);
  if (actor?.auxiliary) friendlies.assertVersion(state, true);
  if (!actor || actor.typeID !== typeID || !positive(entityID)) fail("INCURSION_BIRTH_INVALID");
  const old = state.births[key];
  if (old) {
    if (old.entityID !== entityID || old.typeID !== typeID) fail("INCURSION_BIRTH_CONFLICT");
    return state;
  }
  const active = actor.auxiliary ? friendlies.cohorts(state).find(row => row.encounterKey === actor.encounterKey)?.active
    : actor.cohortKey ? reinforcements.cohorts(state).find(row => row.key === actor.cohortKey)?.active : state.stages[actor.stageKey].active;
  if (state.status !== "active" || !active ||
      Object.values(state.births).some(row => row.entityID === entityID)) fail("INCURSION_BIRTH_OUT_OF_ORDER");
  state.births[key] = { entityID, typeID };
  return state;
}
function recordContribution(previous, event) {
  const state = checked(previous);
  if (!keyValid(event?.eventID) || !nonnegative(event.characterID) || !nonnegative(event.fleetID) ||
      !(event.amount > 0) || !Number.isFinite(event.amount) || (!event.characterID && event.fleetID) ||
      !["damage", "repair"].includes(event.kind)) fail("INCURSION_CONTRIBUTION_INVALID");
  const proof = fingerprint(event), old = state.events[event.eventID];
  if (old) {
    if (old !== proof) fail("INCURSION_CONTRIBUTION_CONFLICT");
    return state;
  }
  if (state.status !== "active") fail("INCURSION_ENCOUNTER_CLOSED");
  if (Object.keys(state.events).length >= 65536) fail("INCURSION_CONTRIBUTION_LIMIT");
  if (event.kind === "damage") {
    if (event.targetKind === "structure") {
      const birth = state.mechanics?.structureBirths?.[event.targetKey];
      if (!birth || birth.entityID !== event.targetEntityID || birth.typeID !== event.targetTypeID ||
          state.mechanics?.healthReceipts?.[event.targetKey]) fail("INCURSION_DAMAGE_TARGET_INVALID");
    } else {
      const actor = actorDeclaration(state, event.targetKey), birth = state.births[event.targetKey];
      if (!actor || !birth || birth.entityID !== event.targetEntityID || state.retirements[event.targetKey]) fail("INCURSION_DAMAGE_TARGET_INVALID");
      if (!birthsReady(state, event.targetKey)) fail("INCURSION_WAVE_BIRTH_PENDING");
    }
  } else if (event.targetKind === "structure") {
    const birth = state.mechanics?.structureBirths?.[event.targetKey];
    if (state.policy.dungeonID !== 5175 || event.cause !== "tcrc-shield-links" || event.repair?.version !== "evejs.incursion-tcrc-repair.v1" ||
        !birth || birth.entityID !== event.targetEntityID || birth.typeID !== event.targetTypeID || state.mechanics?.healthReceipts?.[event.targetKey] ||
        event.characterID !== 0 || event.fleetID !== 0 || event.targetCharacterID !== 0 || event.sourceShipID !== 0 || event.moduleID !== 0 || event.destroyed)
      fail("INCURSION_REPAIR_TARGET_INVALID");
  } else if (!positive(event.targetCharacterID) || event.targetCharacterID === event.characterID) fail("INCURSION_REPAIR_TARGET_INVALID");
  if (event.characterID && event.fleetID && !(event.kind === "damage" && actorDeclaration(state, event.targetKey)?.role === "friendly")) {
    const pilot = state.contributions[event.characterID] ||= {}, fleet = pilot[event.fleetID] ||= { damage: 0, repairs: {} };
    if (event.kind === "damage") fleet.damage += event.amount;
    else fleet.repairs[event.targetCharacterID] = (fleet.repairs[event.targetCharacterID] || 0) + event.amount;
    if (!Number.isFinite(fleet.damage) || Object.values(fleet.repairs).some(value => !Number.isFinite(value))) fail("INCURSION_CONTRIBUTION_OVERFLOW");
  }
  state.events[event.eventID] = proof;
  return state;
}
function recordStructureBirth(previous, { key, entityID, typeID, nativeObjectID }) {
  const state = checked(previous), objective = state.policy.objectives.find(row => row.key === key && row.kind === "structure") ||
    state.policy.mechanics?.logistics?.chains?.filter(row => row.initialState === "hostile" && `${row.key}:health` === key)
      .map(row => ({ nativeObjectID: row.initialObjectID, roomKey: state.policy.mechanics.objectBindings[row.initialObjectID]?.roomKey }))[0];
  const binding = state.policy.mechanics?.objectBindings?.[nativeObjectID];
  if (!objective || !positive(typeID) || !positive(nativeObjectID) || objective.nativeObjectID !== nativeObjectID || binding?.typeID !== typeID ||
      binding.roomKey !== objective.roomKey || !positive(entityID)) fail("INCURSION_STRUCTURE_BIRTH_INVALID");
  const birth = { entityID, typeID, nativeObjectID }, prior = state.mechanics?.structureBirths?.[key];
  if (prior) { if (fingerprint(prior) !== fingerprint(birth)) fail("INCURSION_STRUCTURE_BIRTH_CONFLICT"); return state; }
  if (state.status !== "active") fail("INCURSION_ENCOUNTER_CLOSED");
  state.mechanics ||= {}; state.mechanics.structureBirths ||= {}; state.mechanics.structureBirths[key] = birth;
  return state;
}
function recordRetirement(previous, { key, entityID, typeID, reason, atMs, deathEventID }) {
  const state = checked(previous), actor = actorDeclaration(state, key), birth = state.births[key];
  if (!actor || !birth || birth.entityID !== entityID || birth.typeID !== typeID || reason !== "destroyed" ||
      atMs !== undefined && !positive(atMs) ||
      deathEventID !== undefined && (!keyValid(deathEventID) || !state.events[deathEventID])) fail("INCURSION_RETIREMENT_INVALID");
  if (state.retirements[key]) return state;
  if (state.status !== "active") fail("INCURSION_RETIREMENT_OUT_OF_ORDER");
  if (!birthsReady(state, key)) fail("INCURSION_WAVE_BIRTH_PENDING");
  state.retirements[key] = { entityID, typeID, reason, ...(atMs === undefined ? {} : { retiredAtMs: atMs }),
    ...(deathEventID === undefined ? {} : { deathEventID }) };
  return refresh(state);
}
function recordObjective(previous, fact) {
  const state = checked(previous), objective = state.policy.objectives.find(row => row.key === fact?.objectiveKey);
  if (!objective || !keyValid(fact.receiptID) || fact.kind !== objective.kind || !positive(fact.quantity) ||
      fact.roomKey !== objective.roomKey || (objective.kind === "cargo" && fact.typeID !== objective.typeID)) fail("INCURSION_OBJECTIVE_FACT_INVALID");
  const stored = state.objectives[objective.key], proof = fingerprint(fact), old = stored.receipts[fact.receiptID];
  if (old) {
    if (old !== proof) fail("INCURSION_OBJECTIVE_FACT_CONFLICT");
    return state;
  }
  if (state.status !== "active" || (objective.requires && !condition(state, objective.requires))) fail("INCURSION_OBJECTIVE_NOT_READY");
  if (objective.repeatable ? fact.quantity > objective.quantity || !Number.isSafeInteger(stored.quantity + fact.quantity)
    : stored.quantity + fact.quantity > objective.quantity) fail("INCURSION_OBJECTIVE_EXCESS");
  if (Object.keys(stored.receipts).length >= 65536) fail("INCURSION_OBJECTIVE_LIMIT");
  stored.receipts[fact.receiptID] = proof; stored.quantity += fact.quantity;
  return refresh(state);
}
function finalize(previous, present, nowMs) { return participation.finalize(checked(previous), present, nowMs); }
module.exports = { SCHEMA, validatePolicy, createOperation, actorDeclaration, activateRoom, canSpawn, birthsReady,
  recordBirth, recordStructureBirth, recordContribution, recordRetirement, recordObjective, condition, finalize, fingerprint };
