"use strict";

// Cohorts are selected only from the admitted policy. The generation is a
// durable intent; native births and combat deaths retain their existing owners.
const { fingerprint, fail } = require("./incursionLifecycleContract");
const positive = value => Number.isSafeInteger(value) && value > 0;
const keyValid = value => typeof value === "string" && /^[A-Za-z0-9:_#.-]{1,180}$/.test(value) && !["__proto__", "constructor", "prototype"].includes(value);
const dead = (state, key) => Boolean(state.births[key] && state.retirements[key]?.reason === "destroyed" &&
  state.births[key].entityID === state.retirements[key].entityID && state.births[key].typeID === state.retirements[key].typeID);
const allDead = (state, keys) => keys.length > 0 && keys.every(key => dead(state, key));
function families(policy) {
  const mechanics = policy.mechanics || {}, result = [];
  for (const rule of mechanics.respawnGroups || []) {
    const stage = policy.stages.find(row => row.key === rule.stageKey);
    const group = mechanics.stageRules?.find(row => row.key === rule.stageKey)?.groups.find(row => row.key === rule.groupKey);
    if (!stage || !group?.actorKeys?.length || !positive(rule.delayMs) || rule.when !== "whole group destroyed" ||
        !group.actorKeys.every(key => stage.actors.some(actor => actor.key === key))) fail("INCURSION_REINFORCEMENT_POLICY_INVALID");
    result.push({ key: `respawn:${stage.key}:${group.key}`, roomKey: stage.roomKey,
      sourceEncounterKey: stage.encounterKey, initialActorKeys: group.actorKeys,
      actors: stage.actors.filter(actor => group.actorKeys.includes(actor.key)), delayMs: rule.delayMs, maximumGenerations: null });
  }
  for (const group of mechanics.optionalGroups || []) {
    if (!keyValid(group.key) || !Array.isArray(group.actors) || !group.actors.length || !Array.isArray(group.spawnEntries) ||
        group.actors.length !== group.spawnEntries.length || !keyValid(group.roomKey) ||
        !(positive(group.maximumGenerations) || positive(group.respawn?.afterEntireGroupDestroyedMs)) ||
        !["first-uncloaked-pilot-in-room", "successful-mining-custody-receipt"].includes(group.trigger?.kind) ||
        group.trigger.kind === "first-uncloaked-pilot-in-room" && group.roomKey !== `room:${group.trigger.roomID}` ||
        group.trigger.kind === "successful-mining-custody-receipt" && !positive(group.trigger.sourceObjectID)) fail("INCURSION_REINFORCEMENT_POLICY_INVALID");
    result.push({ key: group.key, roomKey: group.roomKey, actors: group.actors, entries: group.spawnEntries,
      initialActorKeys: [], trigger: group.trigger, delayMs: group.respawn?.afterEntireGroupDestroyedMs || 0,
      maximumGenerations: group.maximumGenerations || null, independent: group.trigger?.kind === "successful-mining-custody-receipt" });
  }
  const replacement = mechanics.spawnPolicy?.bomberReplacement;
  if (replacement) {
    const stage = policy.stages.find(row => row.actors.some(actor => actor.role === "terminal"));
    const actors = stage?.actors.filter(actor => actor.typeID === 2950) || [];
    if (![5158, 5201].includes(policy.dungeonID) || actors.length !== 10 || replacement.maxLive !== 10 ||
        !positive(replacement.delayMs) || replacement.mayRunAfterTerminal !== false) fail("INCURSION_REINFORCEMENT_POLICY_INVALID");
    result.push({ key: "boss-bombers", roomKey: stage.roomKey, actors, sourceEncounterKey: stage.encounterKey,
      initialActorKeys: actors.map(actor => actor.key), delayMs: replacement.delayMs, maximumGenerations: null });
  }
  if (new Set(result.map(row => row.key)).size !== result.length || result.some(row => !keyValid(row.key) || row.actors.length > 256 ||
      new Set(row.actors.map(actor => actor.key)).size !== row.actors.length || row.actors.some(actor => !keyValid(actor.key) || !positive(actor.typeID) || !["required", "optional"].includes(actor.role)))) {
    fail("INCURSION_REINFORCEMENT_POLICY_INVALID");
  }
  return result;
}
const generationKey = (family, serial) => `${family.key}#${serial}`;
const actorKey = (key, family, serial) => `${key}#${family.key}:${serial}`;
const encounterKey = (family, serial) => `incursion:reinforcement:${family.key}:${serial}`;
function cohort(policy, reservation, approved = families(policy)) {
  const family = approved.find(row => row.key === reservation?.familyKey);
  if (!family || !positive(reservation.serial) || !positive(reservation.reservedAtMs) || !positive(reservation.dueAtMs) ||
      typeof reservation.triggerID !== "string" || !reservation.triggerID || reservation.triggerID.length > 512 ||
      reservation.key !== generationKey(family, reservation.serial) ||
      family.maximumGenerations && reservation.serial > family.maximumGenerations) fail("INCURSION_REINFORCEMENT_STATE_INVALID");
  const actors = family.actors.map(actor => ({ ...actor, key: actorKey(actor.key, family, reservation.serial),
    baseActorKey: actor.key, cohortKey: reservation.key, roomKey: family.roomKey }));
  const planKey = encounterKey(family, reservation.serial);
  if (!keyValid(planKey) || actors.some(actor => !keyValid(actor.key)) ||
      fingerprint(reservation.actorKeys) !== fingerprint(actors.map(actor => actor.key)) ||
      reservation.encounterKey !== planKey || reservation.roomKey !== family.roomKey || typeof reservation.active !== "boolean") {
    fail("INCURSION_REINFORCEMENT_STATE_INVALID");
  }
  return { key: reservation.key, familyKey: family.key, encounterKey: planKey, roomKey: family.roomKey,
    actors, active: reservation.active, dueAtMs: reservation.dueAtMs };
}
function cohorts(state) {
  const entries = Object.entries(state.mechanics?.groupGenerations || {}), byFamily = new Map(), keys = new Set();
  const approved = families(state.policy);
  const result = entries.map(([key, reservation]) => {
    if (key !== reservation.key) fail("INCURSION_REINFORCEMENT_STATE_INVALID");
    const group = cohort(state.policy, reservation, approved), family = byFamily.get(group.familyKey) || [];
    family.push(reservation); byFamily.set(group.familyKey, family);
    for (const actor of group.actors) {
      if (keys.has(actor.key) || state.policy.stages.some(stage => stage.actors.some(row => row.key === actor.key))) fail("INCURSION_REINFORCEMENT_KEY_CONFLICT");
      keys.add(actor.key);
    }
    return group;
  });
  for (const family of byFamily.values()) if (new Set(family.map(row => row.triggerID)).size !== family.length ||
      family.sort((a, b) => a.serial - b.serial).some((row, index) => row.serial !== index + 1)) fail("INCURSION_REINFORCEMENT_STATE_INVALID");
  return result;
}
function actorDeclaration(state, key) {
  for (const group of cohorts(state)) {
    const actor = group.actors.find(row => row.key === key);
    if (actor) return { ...actor, encounterKey: group.encounterKey };
  }
  return null;
}
function reserve(state, family, triggerID, nowMs, dueAtMs = nowMs) {
  state.mechanics ||= {}; state.mechanics.groupGenerations ||= {};
  const reservations = Object.values(state.mechanics.groupGenerations), previous = reservations.filter(row => row.familyKey === family.key);
  if (previous.some(row => row.triggerID === triggerID)) return;
  if (family.maximumGenerations && previous.length >= family.maximumGenerations) return;
  if (reservations.length >= 65536) fail("INCURSION_REINFORCEMENT_LIMIT");
  const serial = Math.max(0, ...previous.map(row => row.serial)) + 1, key = generationKey(family, serial);
  const reservation = { key, familyKey: family.key, serial, triggerID, roomKey: family.roomKey,
    encounterKey: encounterKey(family, serial), actorKeys: family.actors.map(actor => actorKey(actor.key, family, serial)),
    reservedAtMs: nowMs, dueAtMs, active: false };
  cohort(state.policy, reservation);
  const existing = new Set([...state.policy.stages.flatMap(stage => stage.actors.map(actor => actor.key)), ...reservations.flatMap(row => row.actorKeys)]);
  if (reservation.actorKeys.some(key => existing.has(key))) fail("INCURSION_REINFORCEMENT_KEY_CONFLICT");
  state.mechanics.groupGenerations[key] = reservation;
}
function advance(previous, nowMs) {
  if (!positive(nowMs) || fingerprint(previous.policy) !== previous.policyFingerprint) fail("INCURSION_REINFORCEMENT_STATE_INVALID");
  const state = structuredClone(previous);
  if (state.status !== "active") return state;
  cohorts(state); // Refuse altered saved generations before considering more work.
  for (const family of families(state.policy)) {
    const previous = Object.values(state.mechanics?.groupGenerations || {}).filter(row => row.familyKey === family.key).sort((a, b) => a.serial - b.serial);
    if (family.independent) {
      for (const [id, receipt] of Object.entries(state.mechanics?.miningReceipts || {}).sort(([left, a], [right, b]) => a.atMs - b.atMs || left.localeCompare(right))) {
        if (receipt.sourceObjectID === family.trigger.sourceObjectID && positive(receipt.quantity) && positive(receipt.atMs) &&
            receipt.atMs <= nowMs && receipt.receiptID === id) reserve(state, family, `mining:${id}`, nowMs);
      }
    } else {
      const last = previous.at(-1), keys = last?.actorKeys || family.initialActorKeys;
      if (keys.length && allDead(state, keys)) {
        const deathAtMs = Math.max(...keys.map(key => state.retirements[key].retiredAtMs || nowMs));
        // An old ledger without a health timestamp begins its fixed delay at
        // first reconciliation. Its first reservation freezes that migration.
        reserve(state, family, `cleared:${last?.key || "initial"}`, nowMs, deathAtMs + family.delayMs);
      } else if (!last && !keys.length && family.trigger?.kind === "first-uncloaked-pilot-in-room" &&
          positive(state.mechanics?.roomEntries?.[`room:${family.trigger.roomID}`])) reserve(state, family, "first-entry", nowMs);
    }
  }
  for (const reservation of Object.values(state.mechanics?.groupGenerations || {})) if (nowMs >= reservation.dueAtMs) reservation.active = true;
  return state;
}
function projectPopulationHints(instance, hints) {
  if (instance?.runtimeFlags?.incursionRuntime !== true || hints?.incursionPolicy?.version !== 2) return hints;
  const state = require("./incursionRewardStore").getOperation(`incursion-v2:${instance.instanceID}`);
  if (!state) return hints;
  if (fingerprint(state.identity) !== fingerprint(require("./incursionAdmission").operationIdentity(instance)) ||
      fingerprint(state.policy) !== fingerprint(hints.incursionPolicy)) fail("INCURSION_REINFORCEMENT_SCOPE_MISMATCH");
  const plans = (hints.encounters || []).slice();
  for (const group of cohorts(state)) {
    const family = families(state.policy).find(row => row.key === group.familyKey);
    const entries = family.entries || hints.encounters.find(plan => plan.key === family.sourceEncounterKey)?.spawnEntries;
    if (!Array.isArray(entries)) fail("INCURSION_REINFORCEMENT_PLAN_MISSING");
    const spawnEntries = group.actors.map(actor => {
      const matches = entries.filter(entry => entry.key === actor.baseActorKey), entry = matches[0];
      if (matches.length !== 1 || entry.typeID !== actor.typeID || entry.entityKind !== "npc" || entry.ownerID !== 1000162 ||
          typeof entry.profileID !== "string" || !entry.profileID || entry.profileID !== actor.profileID) fail("INCURSION_REINFORCEMENT_PLAN_INVALID");
      return { ...structuredClone(entry), key: actor.key };
    });
    const plan = { key: group.encounterKey, roomKey: group.roomKey, trigger: "on_room_active", supported: true, exact: true, deadspace: true,
      spawnQuery: spawnEntries.map(entry => entry.profileID).join(","),
      waveIndex: 1, amount: spawnEntries.length, maxSpawnEntries: spawnEntries.length, spawnChance: 1,
      spawnEntries, incursionPhaseOwned: true };
    const prior = plans.find(row => row.key === group.encounterKey);
    if (prior && fingerprint(prior) !== fingerprint(plan)) fail("INCURSION_REINFORCEMENT_KEY_CONFLICT");
    if (!prior) plans.push(plan);
  }
  return { ...hints, encounters: plans };
}
module.exports = { families, cohorts, actorDeclaration, advance, projectPopulationHints };
