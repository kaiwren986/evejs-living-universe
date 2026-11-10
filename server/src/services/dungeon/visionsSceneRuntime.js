"use strict";

// Captured Visions interaction predicates. The dungeon owner persists progress;
// hacking keeps its existing durable outcome owner and repairs use real health.
const DUNGEONS = Object.freeze({ 17183: 14097, 17184: 14098, 17185: 14099, 17186: 14100 });

function contract(template) {
  const value = template?.visionsOfGreatness;
  return value?.epicArcID === 132 && DUNGEONS[value.missionID] === Number(template.sourceDungeonID) &&
    template.requiresMechanics?.includes("visions-of-greatness-v1") ? value : null;
}

function hacksComplete(instance, template) {
  const policy = contract(template)?.hacks;
  if (!policy) return true;
  return Array.isArray(policy.dunObjectIDs) && policy.dunObjectIDs.length === 3 &&
    policy.dunObjectIDs.every(id => instance.spawnState?.hackingContainers?.[`platform:${id}`]?.state === 2);
}

function canSpawnEncounter(instance, template, plan) {
  if (!require("./visionsCaldariRuntime").canSpawnEncounter(instance, template, plan)) return false;
  const policy = contract(template)?.hacks;
  return !policy?.encounterKeys?.includes(plan.key) || hacksComplete(instance, template);
}

function roomReady(instance, template, roomKey) {
  if (!require("./visionsCaldariRuntime").roomReady(instance, template, roomKey)) return false;
  const policy = contract(template);
  if (!policy) return true;
  if (policy.repair?.roomKey === roomKey && !instance.spawnState?.visionsOfGreatness?.repairCompletedAtMs) return false;
  return policy.hacks?.roomKey !== roomKey || hacksComplete(instance, template);
}

function gateReady(instance, template, gateKey) {
  if (!require("./visionsCaldariRuntime").gateReady(instance, template, gateKey)) return false;
  const policy = contract(template);
  return !policy?.repair || (policy.repair.gateKey || policy.repair.gate) !== gateKey ||
    Number(instance.spawnState?.visionsOfGreatness?.repairCompletedAtMs) > 0;
}

function repairProgress(scene, instance, template, nowMs) {
  const policy = contract(template)?.repair;
  if (!policy || instance.spawnState?.visionsOfGreatness?.repairCompletedAtMs) return null;
  const actor = scene.getDynamicEntities().find(entity =>
    Number(entity.dungeonSiteInstanceID) === Number(instance.instanceID) &&
    Number(entity.typeID) === Number(policy.typeID) &&
    (!entity.visionsActorKey || entity.visionsActorKey === policy.actorKey) && entity.conditionState);
  const armorDamage = Number(actor?.conditionState?.armorDamage);
  if (!actor || !Number.isFinite(armorDamage) || armorDamage < 0 || armorDamage > 1 - Number(policy.armorFraction || 1)) return null;
  return { ...(instance.spawnState?.visionsOfGreatness || {}), repairCompletedAtMs: Math.max(1, nowMs) };
}

function initializeSpawned(template, instance, entry, spawned) {
  if (!contract(template) || !spawned?.entity) return false;
  const entity = spawned.entity;
  entity.visionsActorKey = entry.key;
  require("./visionsCaldariRuntime").configureActor(entity, instance, template);
  if (typeof entry.blocksEncounterProgress === "boolean") {
    spawned.encounterProgressBlocker = entry.blocksEncounterProgress;
    entity.dungeonEncounterBlocksProgress = entry.blocksEncounterProgress;
  }
  if (!entry.initialConditionState) return false;
  const health = { ...entity.conditionState };
  for (const key of ["damage", "armorDamage", "shieldCharge", "charge"]) {
    const value = Number(entry.initialConditionState[key]);
    if (Number.isFinite(value)) health[key] = Math.max(0, Math.min(1, value));
  }
  if (contract(template).repair?.actorKey === entry.key && instance.spawnState?.visionsOfGreatness?.repairCompletedAtMs) {
    health.armorDamage = 0;
  }
  entity.conditionState = health;
  return true;
}

function prepareModuleCycle(instance, template, source, target, event) {
  const policy = contract(template);
  const characterID = Number(source?.characterID || source?.charID || source?.session?.characterID || source?.ownerID);
  const ownerID = Number(instance.ownership?.missionOwnerCharacterID || instance.ownership?.characterID);
  const actorKey = target?.dungeonSiteContentKey || target?.visionsActorKey;
  if (!policy || !ownerID || characterID !== ownerID || !actorKey ||
      Number(target.dungeonSiteInstanceID) !== Number(instance.instanceID) ||
      Number(source.dungeonCurrentInstanceID) !== Number(instance.instanceID) ||
      !(Number(event?.moduleID) > 0)) return null;
  const rule = policy.interactions?.find(rule => rule.family === event.family &&
    rule.targetTypeIDs?.includes(Number(target.typeID)) &&
    target.dungeonEncounterKey === `instance:${instance.instanceID}:${rule.encounterKey}`);
  if (!rule) return null;
  const key = `${rule.family}:${rule.scope === "encounter" ? rule.encounterKey : actorKey}`;
  return { key, record: { family: rule.family, encounterKey: rule.encounterKey, actorKey,
    targetTypeID: Number(target.typeID), characterID, moduleID: Number(event.moduleID),
    cycleID: String(event.cycleID || ""), acceptedAtMs: Math.max(1, Number(event.cycleAtMs) || Date.now()) } };
}

function pendingOutcomes(instance, template, entities) {
  const policy = contract(template);
  if (!policy) return [];
  const scoped = entities.filter(entity => Number(entity.dungeonSiteInstanceID) === Number(instance.instanceID) && entity.nativeNpc === true);
  const actions = new Map();
  const add = (entity, action) => actions.set(entity.itemID, { entity, action });
  const progress = instance.spawnState?.visionsOfGreatness || {};
  if (progress.repairCompletedAtMs) {
    for (const entity of scoped) {
      if (policy.repair?.reliefEncounterKeys?.some(key => entity.dungeonEncounterKey === `instance:${instance.instanceID}:${key}`)) add(entity, "depart");
    }
  }
  for (const rule of policy.interactions || []) {
    const proofs = Object.values(progress.effects || {}).filter(proof => proof.family === rule.family && proof.encounterKey === rule.encounterKey);
    if (!proofs.length) continue;
    const ready = (rule.afterEncounterKeys || []).every(key => {
      const state = instance.spawnState?.encounterStatesByKey?.[key];
      return state?.spawnedAtMs > 0 && state?.completedAtMs > 0 && state.remainingEntityIDs?.length === 0;
    });
    if (!ready) continue;
    for (const entity of scoped) {
      const matchingEncounter = entity.dungeonEncounterKey === `instance:${instance.instanceID}:${rule.encounterKey}`;
      const matchingActor = proofs.some(proof => proof.actorKey === (entity.dungeonSiteContentKey || entity.visionsActorKey));
      if (matchingEncounter && (rule.scope === "encounter" || matchingActor) || rule.companionTypeIDs?.includes(Number(entity.typeID))) add(entity, rule.action);
    }
  }
  for (const outcome of require("./visionsCaldariRuntime").pendingEscapes(instance, template, scoped)) {
    add(outcome.entity, outcome.action);
  }
  return [...actions.values()];
}

function tick(scene, instance, template, nowMs) {
  const policy = contract(template);
  if (!policy?.cinematicTimeline || !template.requiresMechanics?.includes("epic-scene-actions-v1") ||
      (instance.spawnState?.populationHints || template.populationHints)?.epicSceneActionsVersion !== 1) return;
  const ownerID = Number(instance.ownership?.missionOwnerCharacterID || instance.ownership?.characterID);
  const ship = scene.getDynamicEntities().find(entity => entity.session &&
    Number(entity.characterID || entity.pilotCharacterID || entity.ownerID) === ownerID &&
    Number(entity.dungeonCurrentInstanceID) === Number(instance.instanceID));
  const actions = require("./epicSceneActions");
  if (policy.companions && (instance.spawnState?.populationHints || template.populationHints)?.visionsCompanionActionsVersion === 1)
    actions.companions(scene, instance, policy.companions, nowMs);
  actions.timeline(scene, instance, template, policy.cinematicTimeline, ship, nowMs);
}

module.exports = { contract, hacksComplete, canSpawnEncounter, roomReady, gateReady, repairProgress,
  initializeSpawned, prepareModuleCycle, pendingOutcomes, tick };
