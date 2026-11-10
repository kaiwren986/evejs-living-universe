"use strict";

// Existing dungeon/NPC owners retain all durable state and actor custody. This
// adapter supplies the external world hooks absent from the native graph.
const crypto = require("node:crypto");
const progress = require("./visionsCaldariProgress");
const { buildDict, buildList, buildFiletimeLong } = require("../_shared/serviceHelpers");
const epochs = new WeakMap();
const lastValuesByScene = new WeakMap();
const runtime = () => require("./dungeonRuntime");

function policy(instance, template) {
  const admitted = instance?.spawnState?.populationHints?.visionsCaldariPolicy;
  if (admitted?.version !== 1 || admitted.schema !== "evejs.visions-caldari-policy.v1" ||
      Number(instance?.metadata?.missionContentID) !== 17184 ||
      Number(instance?.sourceDungeonID || template?.sourceDungeonID) !== 14098 ||
      instance.templateID !== template?.templateID || instance.runtimeFlags?.missionRuntime !== true ||
      !(Number(instance.ownership?.missionOwnerCharacterID) > 0)) return null;
  return instance.spawnState?.visionsOfGreatness?.caldari?.policy || admitted;
}
function state(instance) { return instance?.spawnState?.visionsOfGreatness?.caldari || null; }
function scoped(scene, instance) {
  return scene.getDynamicEntities().filter(entity => Number(entity.dungeonSiteInstanceID) === Number(instance.instanceID) && entity.nativeNpc === true);
}
function configureActor(entity, instance, template) {
  const p = policy(instance, template);
  if (Array.isArray(p?.actors?.fleetCombatPhases) && entity?.nativeNpc === true &&
      Number(entity.dungeonSiteInstanceID) === Number(instance.instanceID) &&
      entity.dungeonEncounterKey === `instance:${instance.instanceID}:federation-screen` &&
      !p.actors.fleetCombatPhases.includes(state(instance)?.phase)) {
    const registry = require("../../space/npc/npcRegistry");
    const controller = registry.getControllerByEntityID(entity.itemID);
    if (controller) {
      const behavior = require("../../space/npc/npcBehaviorLoop");
      behavior.setBehaviorOverrides(entity.itemID, { ...controller.behaviorOverrides,
        autoAggro: false, autoActivateWeapons: false, allowFriendlyNpcTargets: false });
      behavior.issueManualOrder(entity.itemID, { type: "stop", allowWeapons: false });
    }
  }
  if (p?.actors?.disruptorWeaponPolicy === "ewar-only" && entity?.nativeNpc === true && Number(entity.typeID) === 93958 &&
      Number(entity.dungeonSiteInstanceID) === Number(instance.instanceID) &&
      entity.dungeonEncounterKey === `instance:${instance.instanceID}:maulus-disruptors`) {
    entity.visionsCaldariWeaponBanksDisabled = true;
  }
}
function ownerShip(scene, instance) {
  const ownerID = Number(instance.ownership.missionOwnerCharacterID);
  return scene.getDynamicEntities().find(entity => entity.session && scene.sessions?.get(entity.session.clientID) === entity.session &&
    Number(entity.characterID || entity.pilotCharacterID || entity.session.characterID) === ownerID &&
    Number(entity.dungeonCurrentInstanceID) === Number(instance.instanceID));
}
function elapsedSince(instance, event) {
  const s = state(instance);
  const intent = Object.values(s?.pendingIntents || {}).find(row => row.event === event);
  const at = intent?.activeAtMs ?? s?.eventTimes?.[event];
  return Number.isFinite(at) ? Math.max(0, s.activeElapsedMs - at) : -1;
}
function canSpawnEncounter(instance, template, plan) {
  const p = policy(instance, template);
  if (!p) return true;
  if (plan.key === "maulus-disruptors") return elapsedSince(instance, "room1Entered") >= p.actors.disruptorSpawnDelayMs;
  if (plan.key === "federation-screen") return elapsedSince(instance, "room2Entered") >= p.actors.fleetSpawnDelayMs;
  return true;
}
function roomReady(instance, template, roomKey) {
  if (!policy(instance, template)) return true;
  const phase = state(instance)?.phase;
  if (roomKey === "room:33217") return ["enterRoom2", "protectLead", "protect", "destroyLead", "destroy", "completionLead", "complete"].includes(phase);
  return roomKey !== "room:33253" || phase === "complete";
}
function gateReady(instance, template, gateKey) {
  return gateKey !== "gate:1498725" || roomReady(instance, template, "room:33217");
}
function pendingEscapes(instance, template, entities) {
  if (!policy(instance, template) || !["rescue", "enterRoom2Lead", "enterRoom2"].includes(state(instance)?.phase)) return [];
  const effects = Object.values(instance.spawnState?.visionsOfGreatness?.effects || {});
  return entities.filter(entity => Number(entity.dungeonSiteInstanceID) === Number(instance.instanceID) &&
    entity.dungeonEncounterKey === `instance:${instance.instanceID}:caldari-civilians` &&
    effects.some(proof => proof.family === "ecm" && proof.encounterKey === "maulus-disruptors" &&
      proof.actorKey === `maulus-disruptors:${String(entity.dungeonSiteContentKey).split(":").pop()}`))
    .map(entity => ({ entity, action: "depart" }));
}
function marshal(value) {
  if (Array.isArray(value)) return buildList(value.map(marshal));
  if (value && typeof value === "object" && !value.type) return buildDict(Object.entries(value).map(([key, item]) => [key, marshal(item)]));
  return value;
}
function values(instance, template, scene = null, session = null) {
  const p = policy(instance, template);
  if (!p) return null;
  const s = state(instance) || progress.createProgress(p, 0, "unmaterialized");
  scene ||= require("../../space/runtime").scenes.get(Number(instance.solarSystemID));
  const nowMs = scene?.getCurrentSimTimeMs() || Date.now();
  const raw = { ...(s.presentation?.currentValues || {}), ...progress.buildValues(s) };
  const timer = progress.buildTimer(s);
  // Native objectiveChain137 expects FILETIME longs inside a Python dict.
  // Rebase paused/recovered remaining time onto this scene's current sim axis.
  const filetime = ms => buildFiletimeLong(scene?.getCurrentSessionFileTime && session
    ? scene.getCurrentSessionFileTime(session, ms)
    : 116444736000000000n + BigInt(Math.trunc(ms)) * 10000n);
  raw.timer = timer && ["rescue", "protect", "destroy"].includes(s.phase)
    ? { start_time: filetime(nowMs + timer.remainingMs - timer.durationMs), end_time: filetime(nowMs + timer.remainingMs) } : null;
  return Object.fromEntries(Object.entries(raw).map(([key, item]) => [key, marshal(item)]));
}
function applyActorOrders(scene, instance, p, s) {
  const actors = scoped(scene, instance);
  const protectedActors = actors.filter(entity => entity.dungeonEncounterKey === `instance:${instance.instanceID}:protected-civilians`)
    .sort((a, b) => String(a.dungeonSiteContentKey).localeCompare(String(b.dungeonSiteContentKey)));
  const behavior = require("../../space/npc/npcBehaviorLoop");
  const registry = require("../../space/npc/npcRegistry");
  const protecting = s.phase === "protect" && s.clock.ownerPresent;
  const plans = instance.spawnState.populationHints.encounters;
  for (const entity of actors) {
    const controller = registry.getControllerByEntityID(entity.itemID);
    if (!controller) continue;
    const fleet = entity.dungeonEncounterKey === `instance:${instance.instanceID}:federation-screen`;
    const civilian = entity.dungeonEncounterKey === `instance:${instance.instanceID}:protected-civilians`;
    const disruptor = p.actors.disruptorWeaponPolicy === "ewar-only" &&
      entity.dungeonEncounterKey === `instance:${instance.instanceID}:maulus-disruptors`;
    if (!fleet && !civilian && !disruptor) continue;
    const fleetCombatAllowed = !Array.isArray(p.actors.fleetCombatPhases) || p.actors.fleetCombatPhases.includes(s.phase);
    const holdingFleet = fleet && (!s.clock.ownerPresent || !fleetCombatAllowed);
    const entry = plans.flatMap(plan => plan.spawnEntries || []).find(row => row.key === entity.dungeonSiteContentKey);
    const ordinal = Number(String(entity.dungeonSiteContentKey).split(":").pop()) || 1;
    const target = fleet && protecting && protectedActors.length ? protectedActors[(ordinal - 1) % protectedActors.length] : null;
    const orderKey = `${s.phase}:${s.clock.ownerPresent}:${target?.itemID || 0}`;
    if (controller.visionsCaldariOrderKey === orderKey) continue;
    // Existing NPC friendly-fire permission requires a shared, nonempty
    // operator. Scope that permission to these private instance actors only.
    controller.operatorKind = `visions-caldari:${instance.instanceID}`;
    const overrides = { ...entry?.behaviorOverrides, allowFriendlyNpcTargets: !disruptor && protecting };
    if (disruptor) {
      // Native point actor combat tuning is unrecovered. The admitted authored
      // policy keeps its ordinary hostile EWAR while disabling weapon banks.
      // The shared combat switch also drives hostile EWAR. Keep it enabled;
      // the equipment resolver suppresses only this actor's weapon banks.
      entity.visionsCaldariWeaponBanksDisabled = true;
      if (!s.clock.ownerPresent) overrides.autoAggro = false;
    }
    if (fleet && (protecting || holdingFleet)) overrides.autoAggro = false;
    if (holdingFleet) overrides.autoActivateWeapons = false;
    behavior.setBehaviorOverrides(entity.itemID, overrides);
    controller.visionsCaldariOrderKey = orderKey;
    if (!fleet) continue;
    if (target) {
      if (controller.manualOrder?.targetID !== target.itemID || controller.manualOrder?.type !== "attack") {
        behavior.issueManualOrder(entity.itemID, { type: "attack", targetID: target.itemID, allowWeapons: true });
      }
    } else if (holdingFleet) {
      behavior.issueManualOrder(entity.itemID, { type: "stop", allowWeapons: false });
    } else if (controller.manualOrder) behavior.issueManualOrder(entity.itemID, { type: "resume" });
  }
}
function tick(scene, instance, template, nowMs) {
  const p = policy(instance, template);
  if (!p) return false;
  // This owner is called by wall-clock maintenance and by sim-time combat
  // callbacks. Only the scene's clock may advance the admitted encounter.
  nowMs = scene.getCurrentSimTimeMs();
  if (!epochs.has(scene)) epochs.set(scene, crypto.randomUUID());
  const ship = ownerShip(scene, instance);
  const retirements = Object.values(instance.spawnState?.requiredActorRetirements || {});
  const facts = { ownerPresent: Boolean(ship), roomID: ship ? Number(String(ship.dungeonCurrentRoomKey).split(":").pop()) || p.native.roomIDs.lobby : null,
    escapedCount: retirements.filter(row => row.reason === "depart" && /^caldari-civilians:[1-5]$/.test(row.contentKey)).length,
    destroyedCount: retirements.filter(row => row.reason === "destroyed" && /^protected-civilian-[1-5]$/.test(row.contentKey)).length,
    fleetKillCount: retirements.filter(row => row.reason === "destroyed" && /^federation-screen:(?:[1-9]|10)$/.test(row.contentKey)).length };
  const result = progress.advanceProgress({ policy: p, state: state(instance), facts, nowMs, sceneEpoch: epochs.get(scene) });
  const next = result.state;
  next.eventTimes ||= {};
  for (const intent of result.intents) if (intent.kind === "nativeEvent") next.eventTimes[intent.event] ??= intent.activeAtMs;
  // Cue receipts precede publication; replay can repeat presentation but never
  // an economic grant. Uppercase world/reward hooks have no economic owner here.
  let saved = next;
  runtime().mergeSpawnState(instance.instanceID, { visionsOfGreatness: {
    ...instance.spawnState?.visionsOfGreatness, caldari: saved,
  } }, { nowMs, durable: true, force: true });
  const current = runtime().getInstance(instance.instanceID);
  applyActorOrders(scene, current, p, saved);
  const tracking = require("./dungeonTrackingRuntime");
  const acknowledged = [];
  for (const notification of result.notifications || []) {
    const delivered = tracking.notifyDungeonValuesForScene(scene, current,
      Object.fromEntries(Object.entries(notification.values).map(([key, value]) => [key, marshal(value)])));
    if (delivered > 0) acknowledged.push(notification.id);
  }
  if (acknowledged.length) {
    saved = progress.advanceProgress({ state: saved, facts: { ...facts, acknowledgedNotificationIDs: acknowledged }, nowMs, sceneEpoch: epochs.get(scene) }).state;
    runtime().mergeSpawnState(instance.instanceID, { visionsOfGreatness: { ...current.spawnState.visionsOfGreatness, caldari: saved } },
      { nowMs, durable: true, force: true });
  }
  const currentValues = values(current, template, scene);
  const signature = JSON.stringify([currentValues, [...(scene.sessions?.values() || [])]
    .map(session => [session.clientID, session._space?.clockOffsetMs || 0])],
  (_, value) => typeof value === "bigint" ? value.toString() : value);
  if (!lastValuesByScene.has(scene)) lastValuesByScene.set(scene, new Map());
  const previousValues = lastValuesByScene.get(scene);
  if (previousValues.get(instance.instanceID) !== signature) {
    tracking.notifyDungeonValuesForScene(scene, current, session => values(current, template, scene, session));
    previousValues.set(instance.instanceID, signature);
  }
  return true;
}

module.exports = { policy, state, values, tick, pendingEscapes, canSpawnEncounter, roomReady, gateReady, configureActor };
