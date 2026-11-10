"use strict";

// Pure decisions from server-owned births, paid effects, terminal receipts and
// the completion-time presence snapshot. The adapter owns persistence/physics.
const crypto = require("node:crypto");
const clone = value => structuredClone(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const amount = value => typeof value === "number" && Number.isFinite(value) && value > 0;
function fail(code) { const error = new Error(code); error.code = code; throw error; }
function canonical(value) {
  return Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
}
const fingerprint = value => crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");

function validatePolicy(policy) {
  if (policy?.schema !== "evejs.incursion-vanguard-policy.v1" || policy.version !== 1 ||
      !Array.isArray(policy.waves) || policy.waves.length !== 4 ||
      !policy.rewardDefinition || !policy.catalogIdentity ||
      policy.participation?.version !== 1 || !amount(policy.participation.minimumAppliedContribution) ||
      policy.participation.winner !== "highest-applied-damage-fleet" ||
      policy.participation.presence !== "active-uncloaked-ship-at-completion" ||
      policy.participation.membership !== "same-fleet-at-effect-and-completion") fail("INCURSION_POLICY_INVALID");
  const keys = new Set();
  for (const wave of policy.waves) {
    if (!wave.key || !Array.isArray(wave.actors) || !wave.actors.length) fail("INCURSION_WAVE_INVALID");
    for (const actor of wave.actors) {
      if (!actor.key || !positive(actor.typeID) || keys.has(actor.key)) fail("INCURSION_ACTOR_INVALID");
      keys.add(actor.key);
    }
  }
  return policy;
}

function createOperation(identity, policy, nowMs) {
  validatePolicy(policy);
  if (!["instanceID", "poolGroupID", "taleID", "solarSystemID", "rewardID"].every(key => positive(identity?.[key])) ||
      typeof identity.operationID !== "string" || identity.operationID !== `vanguard-v1:${identity.instanceID}` ||
      !["high", "low", "null"].includes(identity.securityBand) || !identity.dungeonName ||
      !Number.isSafeInteger(nowMs) || nowMs < 0 || identity.rewardID !== policy.rewardDefinition.groupRewardID) fail("INCURSION_IDENTITY_INVALID");
  return { version: 1, identity: clone(identity), policy: clone(policy), policyFingerprint: fingerprint(policy),
    status: "active", waveIndex: 0, startedAtMs: nowMs, births: {}, retirements: {}, contributions: {}, events: {} };
}

function checked(state) {
  if (!state || state.version !== 1 || fingerprint(state.policy) !== state.policyFingerprint) fail("INCURSION_STATE_INVALID");
  validatePolicy(state.policy);
  return clone(state);
}

function actorDeclaration(state, key) {
  for (const [waveIndex, wave] of state.policy.waves.entries()) {
    const actor = wave.actors.find(row => row.key === key);
    if (actor) return { ...actor, waveIndex };
  }
  return null;
}

function recordBirth(previous, { key, entityID, typeID }) {
  const state = checked(previous), actor = actorDeclaration(state, key);
  if (!actor || actor.typeID !== typeID || !positive(entityID)) fail("INCURSION_BIRTH_INVALID");
  const existing = state.births[key];
  if (existing) {
    if (existing.entityID !== entityID || existing.typeID !== typeID) fail("INCURSION_BIRTH_CONFLICT");
    return state;
  }
  if (state.status !== "active" || actor.waveIndex !== state.waveIndex ||
      Object.values(state.births).some(row => row.entityID === entityID)) fail("INCURSION_BIRTH_OUT_OF_ORDER");
  state.births[key] = { entityID, typeID };
  return state;
}

function recordContribution(previous, event) {
  const state = checked(previous);
  if (!event || typeof event.eventID !== "string" || !event.eventID || event.eventID.length > 240 ||
      !nonnegative(event.characterID) || !nonnegative(event.fleetID) || !amount(event.amount) ||
      (!event.characterID && event.fleetID) ||
      !["damage", "repair"].includes(event.kind)) fail("INCURSION_CONTRIBUTION_INVALID");
  const stamp = fingerprint(event), old = state.events[event.eventID];
  if (old) {
    if (old !== stamp) fail("INCURSION_CONTRIBUTION_CONFLICT");
    return state;
  }
  if (state.status !== "active") fail("INCURSION_ENCOUNTER_CLOSED");
  if (Object.keys(state.events).length >= 65536) fail("INCURSION_CONTRIBUTION_LIMIT");
  if (event.kind === "damage") {
    const actor = actorDeclaration(state, event.targetKey), birth = state.births[event.targetKey];
    if (!actor || actor.waveIndex !== state.waveIndex || !birth || birth.entityID !== event.targetEntityID ||
        state.retirements[event.targetKey]) fail("INCURSION_DAMAGE_TARGET_INVALID");
  } else if (!positive(event.targetCharacterID) || event.targetCharacterID === event.characterID) {
    fail("INCURSION_REPAIR_TARGET_INVALID");
  }
  if (!event.characterID || !event.fleetID) {
    state.events[event.eventID] = stamp;
    return state;
  }
  const pilot = state.contributions[event.characterID] ||= {};
  const fleet = pilot[event.fleetID] ||= { damage: 0, repairs: {} };
  if (event.kind === "damage") fleet.damage += event.amount;
  else fleet.repairs[event.targetCharacterID] = (fleet.repairs[event.targetCharacterID] || 0) + event.amount;
  if (!Number.isFinite(fleet.damage) || Object.values(fleet.repairs).some(value => !Number.isFinite(value))) fail("INCURSION_CONTRIBUTION_OVERFLOW");
  state.events[event.eventID] = stamp;
  return state;
}

function recordRetirement(previous, { key, entityID, typeID, reason }) {
  const state = checked(previous), actor = actorDeclaration(state, key), birth = state.births[key];
  if (!actor || !birth || birth.entityID !== entityID || birth.typeID !== typeID || reason !== "destroyed") fail("INCURSION_RETIREMENT_INVALID");
  if (state.retirements[key]) return state;
  if (state.status !== "active" || actor.waveIndex !== state.waveIndex) fail("INCURSION_RETIREMENT_OUT_OF_ORDER");
  state.retirements[key] = { entityID, typeID, reason };
  const wave = state.policy.waves[state.waveIndex];
  if (wave.actors.every(row => state.births[row.key] && state.retirements[row.key])) {
    state.waveIndex++;
    if (state.waveIndex === state.policy.waves.length) state.status = "ready";
  }
  return state;
}

function finalize(previous, present, nowMs) {
  return require("./incursionParticipation").finalize(checked(previous), present, nowMs);
}

module.exports = { fingerprint, validatePolicy, createOperation, recordBirth, recordContribution, recordRetirement, finalize };
