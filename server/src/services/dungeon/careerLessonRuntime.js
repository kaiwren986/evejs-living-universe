"use strict";

// Private career lessons consume facts from the paid module and ship-death
// owners. Distance is never evidence that a module lesson succeeded.
const IDS = new Set([4169, 4170, 4171, 4172, 9417, 9418, 9419, 4191, 4173, 4174,
  4072, 4102, 4103, 4104, 9412, 9413, 9414, 4178]);
const runtime = () => require("./dungeonRuntime");
function contract(template) {
  return IDS.has(Number(template?.sourceDungeonID)) && template.requiresMechanics?.includes("career-lessons-v1")
    ? template.careerLesson : null;
}
function state(instance) { return instance.spawnState?.careerLesson || {}; }
function save(instance, patch, nowMs) {
  return runtime().mergeSpawnState(instance.instanceID, { careerLesson: { ...state(runtime().getInstance(instance.instanceID) || instance), ...patch } },
    { nowMs, durable: true, force: true });
}
function owner(instance) { return Number(instance.ownership?.missionOwnerCharacterID); }
// TQ (Glue): the agent's last word ("Stand down, pilot. ...") comes when the lesson's pilot,
// the lesson done, starts the warp out of the site. Once per site; the caller sends it and
// marks it with departureMessageSent.
function departureMessage(instance, template, characterID) {
  const rule = instance && contract(template), done = instance ? state(instance) : {};
  return rule?.departureMessage && owner(instance) === Number(characterID) &&
    done.completionDeliveredAtMs > 0 && !done.departureMessageSentAtMs ? rule.departureMessage : null;
}
function departureMessageSent(instance, nowMs) {
  return save(instance, { departureMessageSentAtMs: Math.max(1, nowMs) }, nowMs);
}
function moduleCycle(instance, template, source, target, event) {
  const rule = contract(template);
  if (rule?.kind !== "module" || rule.family !== event?.family || !(event.moduleID > 0) ||
      Number(source?.characterID || source?.pilotCharacterID || source?.session?.characterID || source?.ownerID) !== owner(instance) ||
      Number(source?.dungeonCurrentInstanceID) !== Number(instance.instanceID) ||
      Number(target?.dungeonSiteInstanceID) !== Number(instance.instanceID) ||
      Number(target.typeID) !== Number(rule.targetTypeID) ||
      target.dungeonEncounterKey !== `instance:${instance.instanceID}:${rule.encounterKey}` ||
      rule.family.endsWith("repair") && !(event.appliedAmount > 0)) return { success: true, handled: false };
  if (rule.family.endsWith("repair") && state(instance).repairInitializationPending) {
    return { success: false, handled: true, errorMsg: "CAREER_REPAIR_INITIALIZATION_PENDING" };
  }
  try {
    if (state(instance).completedAtMs) {
      const fence = require("../../gameStore").flushTableSync("dungeonRuntimeState");
      return fence?.success ? { success: true, handled: true, duplicate: true }
        : { success: false, handled: true, errorMsg: fence?.errorMsg || "CAREER_LESSON_RECEIPT_PENDING" };
    }
    save(instance, { completedAtMs: state(instance).completedAtMs || Math.max(1, event.cycleAtMs),
      effect: state(instance).effect || { ...event, characterID: owner(instance), targetID: target.itemID },
      ...(rule.family.endsWith("repair") ? { repairedCondition: { ...target.conditionState } } : {}) }, event.cycleAtMs);
    return { success: true, handled: true };
  } catch (error) { return { success: false, handled: true, errorMsg: error.message }; }
}
function initializeSpawned(template, instance, entry, spawned) {
  const rule = contract(template);
  if (!rule || !spawned?.entity || Number(entry.typeID) !== Number(rule.targetTypeID) || !entry.initialConditionState) return false;
  spawned.entity.conditionState = { ...spawned.entity.conditionState,
    ...(state(instance).repairedCondition || entry.initialConditionState) };
  return true;
}
// The lesson's target (the module's target) when it is this site's: the entity, or its saved
// native NPC record.
function isLessonTarget(rule, instanceID, actor) {
  return Number(actor?.dungeonSiteInstanceID) === Number(instanceID) && Number(actor.typeID) === Number(rule.targetTypeID) &&
    actor.dungeonEncounterKey === `instance:${instanceID}:${rule.encounterKey}`;
}
// A site's passive NPC: a spawn entry with passive: true (The Pacifist's CONCORD Fleet).
function isPassiveSiteNpc(template, instanceID, record) {
  const prefix = `instance:${instanceID}:`, key = String(record.dungeonEncounterKey || "");
  const wave = key.startsWith(prefix) && (template?.populationHints?.encounters || []).find(row => row.key === key.slice(prefix.length));
  return Boolean(wave && (wave.spawnEntries || []).some(entry => entry.passive === true && Number(entry.typeID) === Number(record.typeID)));
}
// A repair lesson's Damaged Vessel is the pilot's friend. The client's own standing thresholds
// for its type are neutral; a spawned NPC otherwise gets hostile ones and shows red in the overview.
// A site's passive NPC gets them too.
function npcPresentationOverrides(record) {
  const instanceID = Number(record?.dungeonSiteInstanceID);
  if (!(instanceID > 0)) return undefined;
  const instance = runtime().getInstance(instanceID);
  const template = instance && require("./dungeonAuthority").getTemplateByIDReadOnly(instance.templateID);
  const rule = template && contract(template);
  if (!isPassiveSiteNpc(template, instanceID, record) && (!rule?.family?.endsWith("repair") || !isLessonTarget(rule, instanceID, record))) return undefined;
  const standings = require("../_shared/clientEntityStandings").getEntityStandingsForType(record.typeID);
  return standings ? { hostileResponseThreshold: standings.hostileResponseThreshold,
    friendlyResponseThreshold: standings.friendlyResponseThreshold, bounty: 0 } : undefined;
}
function cleared(instance, key) {
  const encounter = instance.spawnState?.encounterStatesByKey?.[key];
  return encounter?.spawnedAtMs > 0 && encounter.completedAtMs > 0 && encounter.remainingEntityIDs?.length === 0;
}
function ready(instance, template) {
  const rule = contract(template);
  if (!rule) return true;
  if (instance.lifecycleState === "completed" && !state(instance).revision) return true;
  if (rule.kind === "stand") {
    const fleetAtMs = Number(instance.spawnState?.encounterStatesByKey?.fleet?.spawnedAtMs);
    const loss = state(instance);
    // New plans record causality after the fleet gate below. Legacy receipts
    // retain their original timing check; settlement time cannot move a loss.
    const lossAtMs = Number(loss.lossPlan?.debrisOptions?.createdAtMs ?? loss.lossCompletedAtMs);
    // Updating must not revoke a closed outcome still awaiting agent hand-in.
    const closedOutcome = instance.lifecycleState === "completed" && instance.objectiveSatisfiedAtMs > 0;
    return cleared(instance, "defender") &&
      (fleetAtMs > 0 && loss.lossCompletedAtMs > 0 && (loss.lossAfterFleetArrival === true || lossAtMs >= fleetAtMs || closedOutcome) || cleared(instance, "fleet"));
  }
  return state(instance).completedAtMs > 0;
}
function giftHull(instance) {
  const proof = require("../inventory/itemCustody").getCommittedReceipt(
    `mission-initial-gift:${owner(instance)}:${instance.metadata?.missionAgentID}:${instance.metadata?.missionSequence}`);
  if (!proof.success) throw new Error(proof.errorMsg);
  return proof.committed && proof.resultData?.itemIDs?.length === 1 ? Number(proof.resultData.itemIDs[0]) : 0;
}
// The supplied hull's type. The lesson accepts any ship of that type, like the client's "Board
// Ship" goal: a pilot may own several (one from an earlier try, one bought), and only the type
// is shown. The receipt keeps the type after the handed-over ship itself is gone.
function giftHullType(instance) {
  const proof = require("../inventory/itemCustody").getCommittedReceipt(
    `mission-initial-gift:${owner(instance)}:${instance.metadata?.missionAgentID}:${instance.metadata?.missionSequence}`);
  if (!proof.success) throw new Error(proof.errorMsg);
  return proof.committed ? Number(proof.receipt?.typeID) || 0 : 0;
}
function isGiftHullType(instance, entity) {
  const typeID = giftHullType(instance);
  return typeID > 0 && Number(entity?.typeID) === typeID;
}
function prepareLoss(scene, instance, template, entity, ship, nowMs) {
  const rule = contract(template);
  if (rule?.kind === "stand" && (!cleared(instance, "defender") ||
      !(instance.spawnState?.encounterStatesByKey?.fleet?.spawnedAtMs > 0))) return null;
  if (!["mercy", "stand"].includes(rule?.kind) || !owner(instance) || !isGiftHullType(instance, entity) ||
      Number(entity.dungeonCurrentInstanceID) !== Number(instance.instanceID) || Number(ship?.ownerID) !== owner(instance)) return null;
  if (state(instance).lossPlan) return state(instance).lossPlan;
  const plan = require("../../space/shipDestruction").prepareDurableShipDeath(entity, ship,
    `career-lesson:${instance.instanceID}:loss:${ship.itemID}`, scene, entity.session);
  // Do not stamp an existing plan: it may represent a pre-fleet legacy loss.
  // Save this proof with the new plan, before destruction, so recovery retains
  // event order even when encounter wall time and the TiDi sim clock differ.
  save(instance, { lossPlan: plan, ...(rule.kind === "stand" ? { lossAfterFleetArrival: true } : {}) }, nowMs);
  return plan;
}
function prepareShipLoss(scene, entity, ship) {
  const instance = runtime().getInstance(entity?.dungeonCurrentInstanceID);
  const template = instance && require("./dungeonAuthority").getTemplateByID(instance.templateID);
  if (!instance || !contract(template)) return null;
  return prepareLoss(scene, instance, template, entity, ship, scene.getCurrentSimTimeMs());
}
// Module lessons whose completion waits for the scene's next batch (one per instance).
const pendingDeliveries = new Set();
function tick(scene, instance, template, nowMs) {
  const rule = contract(template);
  if (!rule || !owner(instance)) return;
  const shipEntity = scene.getDynamicEntities().find(entity => Number(entity.characterID || entity.pilotCharacterID) === owner(instance) &&
    Number(entity.dungeonCurrentInstanceID) === Number(instance.instanceID));
  let progress = state(instance);
  if (progress.repairInitializationPending && !progress.completedAtMs) {
    const actor = scene.getDynamicEntities().find(entity => Number(entity.dungeonSiteInstanceID) === Number(instance.instanceID) &&
      Number(entity.typeID) === rule.targetTypeID && entity.dungeonEncounterKey === `instance:${instance.instanceID}:${rule.encounterKey}`);
    if (actor) {
      const entry = template.populationHints.encounters.find(row => row.key === rule.encounterKey)?.spawnEntries?.[0];
      const native = require("../../space/npc/nativeNpcStore"), record = native.getNativeEntity(actor.itemID);
      const conditionState = { ...actor.conditionState, ...entry.initialConditionState };
      const saved = record && native.upsertNativeEntity({ ...record, conditionState }, { transient: record.transient === true });
      if (!saved?.success) throw new Error(saved?.errorMsg || "CAREER_REPAIR_INITIALIZATION_PENDING");
      actor.conditionState = conditionState;
      save(instance, { repairInitializationPending: false }, nowMs);
      progress = state(runtime().getInstance(instance.instanceID));
    }
  }
  if (rule.kind === "module" && !progress.completedAtMs && shipEntity && cleared(runtime().getInstance(instance.instanceID), rule.encounterKey)) {
    require("./dungeonUniverseSiteService").respawnCareerLessonTarget(scene,runtime().getInstance(instance.instanceID), template, rule.encounterKey, { nowMs });
  }
  // TQ: the module's activation reaches the client first, then the target's reply (the Fleeing
  // Pirate after a successful warp disruption) and the finished goal. The activation is a Dogma
  // event that leaves with this tick's batch, so the reply and the completion follow that batch;
  // a completion ahead of the activation leaves the client's goal graph without its target.
  const done = state(runtime().getInstance(instance.instanceID) || instance);
  if (rule.kind === "module" && done.completedAtMs && !done.completionDeliveredAtMs) {
    if (pendingDeliveries.has(instance.instanceID)) return;
    const session = shipEntity?.session;
    const deliver = () => {
      pendingDeliveries.delete(instance.instanceID);
      const latest = runtime().getInstance(instance.instanceID);
      if (!latest || state(latest).completionDeliveredAtMs) return;
      const at = Math.max(1, scene.getCurrentSimTimeMs?.() || nowMs);
      const sent = rule.completionMessage && session && !state(latest).completionMessageSentAtMs && latest.lifecycleState !== "completed";
      if (sent) {
        const tracking = require("./dungeonTrackingRuntime"), transmission = tracking.buildTransmission(rule.completionMessage);
        if (transmission) tracking.sendRoomTransmission(session, latest, transmission);
      }
      // TQ: the repaired vessel says he is getting out of here. He warps off his grid and is
      // removed once he lands (the NPC's own warp-off order).
      const target = rule.departsAfterCompletion === true &&
        scene.getDynamicEntities().find(entity => isLessonTarget(rule, instance.instanceID, entity));
      if (target) {
        const ordered = require("../../space/npc/npcBehaviorLoop").issueManualOrder(target.itemID,
          { type: "warpOff", awayFromPosition: shipEntity?.position || null });
        if (!ordered?.success) require("../../utils/logger").warn(`[CareerLesson] departure not ordered: ${ordered?.errorMsg}`);
      }
      save(latest, { completionDeliveredAtMs: at, ...(sent ? { completionMessageSentAtMs: at } : {}) }, at);
      const final = runtime().getInstance(instance.instanceID);
      if (ready(final, template)) runtime().markInstanceObjectiveSatisfied(instance.instanceID, { nowMs: at, reason: `career_${rule.kind}_outcome` });
    };
    if (session && typeof scene.afterDestinyBatch === "function" && scene.afterDestinyBatch(session, deliver, { runIfLeft: true })) {
      pendingDeliveries.add(instance.instanceID);
    } else {
      deliver();
    }
    return;
  }
  if (rule.kind === "mercy" && !progress.lossPlan && shipEntity?.session && shipEntity.mode !== "WARP") {
    const headquarters = scene.getDynamicEntities().concat([...scene.staticEntitiesByID?.values() || []]).find(entity =>
      Number(entity.dungeonSiteInstanceID) === Number(instance.instanceID) && entity.dungeonEnvironmentKey === rule.structureKey);
    // Measured between the surfaces, like the overview distance: a hideout is kilometres wide.
    if (headquarters && Math.hypot(shipEntity.position.x - headquarters.position.x, shipEntity.position.y - headquarters.position.y,
      shipEntity.position.z - headquarters.position.z) - (Number(headquarters.radius) || 0) - (Number(shipEntity.radius) || 0) <= rule.rangeMeters) {
      const gift = giftHull(instance);
      // A supplied hull lost elsewhere can never die here, and a ship of another type
      // is not the lesson's to destroy, so the step is waived rather than a soft-lock.
      if (!isGiftHullType(instance, shipEntity) && !(gift && require("../inventory/itemStore").findItemById(gift))) {
        save(instance, { lossCompletedAtMs: Math.max(1, nowMs), lossWaived: true }, nowMs);
      } else {
        prepareLoss(scene, instance, template, shipEntity, require("../inventory/itemStore").findShipItemById(shipEntity.itemID), nowMs);
      }
      progress = state(runtime().getInstance(instance.instanceID));
    }
  }
  if (progress.lossPlan && !progress.lossCompletedAtMs) {
    const death = require("../../space/shipDestruction"), plan = progress.lossPlan;
    const original = scene.getEntityByID(plan.shipRecord.itemID);
    if (original?.session && Number(original.session._space?.shipID) === Number(plan.shipRecord.itemID)) {
      const result = death.destroySessionShip(original.session, { deathReceipt: plan, destructionReason: "career-lesson" });
      if (!result.success) throw new Error(result.errorMsg);
    }
    for (const result of [death.settleDurableShipDeath(plan), death.finishDurableShipDeathHandoff(plan)]) {
      if (!result.success) throw new Error(result.errorMsg);
    }
    const active = require("../character/characterState").getActiveShipRecord(owner(instance));
    if (!active || !require("../inventory/itemStore").isCapsuleTypeID(active.typeID)) return;
    save(instance, { lossCompletedAtMs: Math.max(1, nowMs), capsuleID: active.itemID }, nowMs);
  }
  const latest = runtime().getInstance(instance.instanceID);
  if (rule.kind === "mercy" && state(latest).lossCompletedAtMs) {
    // The Hideout itself stays: it is the client's site object and cannot be destroyed.
    // TQ: the blast destroys the site's pirates. They leave wrecks; nobody killed them, so
    // no bounty is paid (the wreck path pays none, only combat kills do).
    const pirates = scene.getDynamicEntities().filter(entity => entity.kind === "ship" && entity.nativeNpc === true &&
      Number(entity.dungeonSiteInstanceID) === Number(instance.instanceID));
    for (const { itemID } of pirates) {
      // One wreck can change the scene (encounter bookkeeping), so each pirate is looked up again.
      const entity = scene.getEntityByID(itemID);
      if (!entity) continue;
      const removed = require("../../space/shipDestruction").destroyShipEntityWithWreck(scene.systemID, entity, { scene, nowMs });
      if (!removed?.success) throw new Error(removed?.errorMsg || "CAREER_BLAST_NPC_DESTRUCTION_PENDING");
    }
    if (!state(latest).completedAtMs) save(latest, { completedAtMs: Math.max(1, nowMs) }, nowMs);
  }
  const final = runtime().getInstance(instance.instanceID);
  if (!ready(final, template)) return;
  // TQ (The Stand): after the supplied ship is lost the agent writes "Okay, get the hell out of
  // there!" in a popup, then the mission is done. The pilot sits in a capsule by now, so the
  // message goes to the character's session, not to the lost ship's entity.
  if (rule.kind === "stand" && rule.completionMessage && state(final).lossCompletedAtMs > 0 &&
      !state(final).completionMessageSentAtMs && final.lifecycleState !== "completed") {
    const session = require("../chat/sessionRegistry").findSessionByCharacterID(owner(final));
    const tracking = require("./dungeonTrackingRuntime"), transmission = tracking.buildTransmission(rule.completionMessage);
    if (session && transmission) tracking.sendRoomTransmission(session, final, transmission);
    save(final, { completionMessageSentAtMs: Math.max(1, nowMs) }, nowMs);
  }
  runtime().markInstanceObjectiveSatisfied(instance.instanceID, { nowMs, reason: `career_${rule.kind}_outcome` });
}

function upgrade(instance, template, nowMs) {
  const rule = contract(template), saved = instance.spawnState?.populationHints;
  if (!rule || !saved || saved.source !== "career_agents" || state(instance).revision === 1 ||
      !["active", "seeded"].includes(instance.lifecycleState)) return null;
  const hints = structuredClone(saved);
  hints.completion = { completeOnEncounterClear: false };
  hints.encounters = hints.encounters.filter(row => !["reach_structure", "reach_rebel_leader", "reach_damaged_vessel"].includes(row.key));
  if (rule.kind === "module") for (const plan of hints.encounters) if (plan.key === rule.encounterKey) {
    const current = template.populationHints.encounters.find(row => row.key === rule.encounterKey)?.spawnEntries?.[0];
    for (const entry of plan.spawnEntries || []) if (entry.typeID === rule.targetTypeID && current?.initialConditionState) {
      entry.initialConditionState = structuredClone(current.initialConditionState);
      entry.behaviorOverrides = structuredClone(current.behaviorOverrides);
    }
  }
  return { spawnState: { ...structuredClone(instance.spawnState), populationHints: hints,
    careerLesson: { ...state(instance), revision: 1, upgradedAtMs: nowMs,
      repairInitializationPending: Boolean(rule.kind === "module" && rule.family.endsWith("repair")) } },
    objectiveState: { ...structuredClone(instance.objectiveState), state: "in_progress", completedAtMs: 0 },
    objectiveSatisfiedAtMs: 0, objectiveSatisfiedReason: null,
    metadata: { ...instance.metadata, objectiveSatisfiedAtMs: 0, objectiveSatisfiedReason: null } };
}
module.exports = { contract, state, save, ready, departureMessage, departureMessageSent, moduleCycle, initializeSpawned, prepareShipLoss, tick, upgrade, npcPresentationOverrides };
