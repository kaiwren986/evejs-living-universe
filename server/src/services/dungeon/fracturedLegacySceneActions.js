"use strict";

const runtime = () => require("./dungeonRuntime");
const actions = instance => instance.spawnState?.fracturedLegacyActions || {};
const objectID = entity => Number(entity?.dunObjectID || entity?.dungeonSourceObjectID);
function deliveryComplete(instance) {
  const quantity = Number(instance.spawnState?.fracturedLegacy?.deliveredQuantity);
  return Number.isFinite(quantity) && quantity >= 4000;
}
function entities(scene, instance) {
  return [...(scene.staticEntities || []), ...scene.getDynamicEntities()]
    .filter(entity => Number(entity.dungeonSiteInstanceID) === Number(instance.instanceID));
}
function persist(instance, state, nowMs) {
  return runtime().mergeSpawnState(instance.instanceID, { fracturedLegacyActions: state }, { nowMs, durable: true, force: true });
}
function canMaterializeStructure(instance, entry) {
  return !actions(instance).retiredObjects?.[Number(entry?.dunObjectID)];
}
function retire(scene, instance, entity, nowMs) {
  const result = require("./dungeonUniverseSiteService").destroyMaterializedContentEntity(scene, entity,
    { nowMs, broadcast: true, persistSpaceState: false, terminalDestructionEffectID: 3 });
  if (result !== true && !result?.success) throw new Error(result?.errorMsg || "FRACTURED_STRUCTURE_RETIREMENT_PENDING");
}
function pendingMineEvents(instance) {
  const events = instance.spawnState?.siteHazardDamageEventsByID || {};
  return Object.values(actions(instance).retiredObjects || {})
    .filter(intent => intent.kind === "mine" && !intent.settledAtMs)
    .flatMap(intent => intent.events || [])
    .filter(event => !events[event.eventID]);
}
function reconcilePendingMineEvents(input, options = {}) {
  const instance = runtime().getInstance(input.instanceID) || input;
  const events = pendingMineEvents(instance);
  if (!events.length) return instance;
  // Earlier releases fenced the accepted mine intent separately from the
  // shared outbox. Promote its original frozen victims before health or purge.
  return require("./siteHazardOutcomes").prepareEvents(instance, events, options);
}
function mines(scene, input, template, ship, nowMs) {
  const policy = template.fracturedLegacy.sceneActions?.mines;
  if (!policy || !ship) return;
  let instance = runtime().getInstance(input.instanceID) || input;
  let state = actions(instance), retired = { ...state.retiredObjects };
  const sources = entities(scene, instance).filter(entity => Number(entity.typeID) === Number(policy.typeID) &&
    policy.objectIDs.includes(objectID(entity)));
  const sourceScope = require("../../space/destiny/identity/interactionScope");
  const ownerID = Number(instance.ownership?.missionOwnerCharacterID || instance.ownership?.characterID);
  for (const source of sources) {
    if (ship.mode === "WARP" || retired[objectID(source)] || Number(ship.characterID || ship.pilotCharacterID || ship.ownerID) !== ownerID ||
        Number(ship.dungeonCurrentInstanceID) !== Number(instance.instanceID) || !sourceScope.canEntitiesInteractLocally(source, ship)) continue;
    const distance = Math.hypot(...["x", "y", "z"].map(axis => source.position[axis] - ship.position[axis])) -
      Math.max(0, Number(source.radius) || 0) - Math.max(0, Number(ship.radius) || 0);
    if (!Number.isFinite(distance) || distance > policy.rangeMeters) continue;
    const eventID = `fractured-mine:${instance.instanceID}:${objectID(source)}:${ship.itemID}`;
    const event = { eventID, atMs: nowMs, sourceName: "Upwell Proximity Mine",
      source: { itemID: source.itemID, position: structuredClone(source.position),
        dungeonSiteInstanceID: instance.instanceID, dungeonSiteID: source.dungeonSiteID,
        ...sourceScope.buildChildEntityScopeMetadata(source) }, rawDamage: structuredClone(policy.rawDamage),
      target: require("../../space/runtime/siteHazardDamage").prepareTarget(scene, ship) };
    retired[objectID(source)] = { kind: "mine", atMs: nowMs, events: [event] };
  }
  const mineIntents = Object.values(retired).filter(row => row.kind === "mine" && !row.settledAtMs);
  if (!mineIntents.length) {
    // A durable tombstone is also a retryable removal command. Reconciliation
    // cannot revive a mine even if its previous presentation removal failed.
    for (const source of sources) if (retired[objectID(source)]) retire(scene, instance, source, nowMs);
    return;
  }
  // The mine tombstone, frozen victim and shared health event have one dungeon
  // fence. An accepted intent can never be stranded outside recovery's index.
  const events = mineIntents.flatMap(row => row.events);
  instance = require("./siteHazardOutcomes").prepareEvents(instance, events, { nowMs,
    spawnPatch: { fracturedLegacyActions: { ...state, retiredObjects: retired } } });
  const delivered = require("./siteHazardOutcomes").replayPendingSiteHazardDamage(instance, { scene, nowMs });
  if (!delivered.success) throw new Error(delivered.errorMsg);
  for (const source of sources) if (retired[objectID(source)]) retire(scene, instance, source, nowMs);
  for (const intent of mineIntents) intent.settledAtMs = Math.max(1, nowMs);
  persist(instance, { ...actions(runtime().getInstance(instance.instanceID)), retiredObjects: retired }, nowMs);
}
function finalBranch(scene, input, template, nowMs) {
  let instance = runtime().getInstance(input.instanceID) || input;
  const progress = instance.spawnState?.fracturedLegacy || {}, rule = template.fracturedLegacy.sceneActions;
  const structure = entities(scene, instance).find(entity => objectID(entity) === rule?.researchObjectID);
  const branchPolicy = rule.branchEffects;
  const branchEffectsEnabled = branchPolicy?.version === 1 &&
    template.requiresMechanics?.includes("epic-branch-effects-v1") &&
    (instance.spawnState?.populationHints || template.populationHints)?.epicBranchEffectsVersion === 1;
  if (branchEffectsEnabled) {
    if (progress.branch === branchPolicy.branch) for (const effect of branchPolicy.effects) {
      const anchor = Number(progress[effect.anchor]), startedAtMs = anchor + effect.delayMs;
      const ageMs = nowMs - startedAtMs, lifetimeMs = effect.durationMs * (effect.repeat + 1);
      if (!(anchor > 0) || !Number.isFinite(anchor) || ageMs < 0 || ageMs >= lifetimeMs) continue;
      const owner = require("./epicSceneActions");
      owner.effect(scene, instance, owner.reference(scene, instance, effect.actor), effect, null, startedAtMs);
    }
  } else {
    // Frozen older layouts retain their original proximity policy. Even there,
    // a scene reload must not restart an effect whose finite lifetime elapsed.
    const pulseAgeMs = nowMs - Number(progress.proximityAtMs);
    if (progress.proximityAtMs && pulseAgeMs >= 0 && pulseAgeMs < 10000 && structure)
      require("./epicSceneActions").effect(scene, instance, structure,
        { guid: "effects.PulseSphereAOE", durationMs: 5000, repeat: 1, start: true }, null, progress.proximityAtMs);
  }
  if (progress.branch !== "destroy") return;
  const state = actions(instance), retired = { ...state.retiredObjects };
  if (!retired[rule.researchObjectID]) {
    retired[rule.researchObjectID] = { kind: "purged_research_structure", atMs: nowMs };
    instance = persist(instance, { ...state, retiredObjects: retired }, nowMs);
  }
  if (structure) retire(scene, instance, structure, nowMs);
}
function receiverDeparture(scene, input, template, nowMs) {
  const rule = template.fracturedLegacy.sceneActions?.receiverDeparture;
  if (!rule) return;
  let instance = runtime().getInstance(input.instanceID) || input;
  if (!deliveryComplete(instance)) return;
  const receiver = entities(scene, instance).find(entity => Number(entity.typeID) === 90423);
  if (!receiver) return;
  const state = actions(instance);
  if (!state.receiverDepartureAtMs) instance = persist(instance, { ...state, receiverDepartureAtMs: Math.max(1, nowMs) }, nowMs);
  const retired = require("../../space/npc/nativeNpcService").retireRequiredDungeonActor(receiver, "delivered_cargo_departure", nowMs);
  if (!retired.success) throw new Error(retired.errorMsg);
  const startedAtMs = actions(instance).receiverDepartureAtMs;
  if (nowMs - startedAtMs >= rule.durationMs) {
    const detached = require("../../space/npc/nativeNpcService").dematerializeNativeController({ entityID: receiver.itemID, systemID: scene.systemID }, { persistState: false, broadcast: true });
    if (!detached.success) throw new Error(detached.errorMsg);
    const removed = require("../../space/npc/nativeNpcStore").removeNativeEntityCascade(receiver.itemID);
    if (!removed.success) throw new Error(removed.errorMsg);
    return;
  }
  if (receiver.mode !== "WARP") {
    const destination = require("./epicSceneActions").point(instance, template, template.fracturedLegacy.objectiveRoomKey, rule.destinationOffset);
    const result = require("../../space/npc/npcRuntime").warpToPoint(receiver.itemID, destination,
      { ingressDurationMs: rule.durationMs, visibilitySuppressMs: 0, useNativeWarpProfile: true, jitterRadiusMeters: 0 });
    if (!result.success) throw new Error(result.errorMsg);
  }
}
function tick(scene, input, template, ship, nowMs) {
  const rules = template.fracturedLegacy?.sceneActions;
  if (rules?.version !== 1 || !template.requiresMechanics?.includes("epic-scene-actions-v1") ||
      (input.spawnState?.populationHints || template.populationHints)?.epicSceneActionsVersion !== 1) return;
  // Accepted mine losses are wall-clock facts (including insurance eligibility);
  // progression, FX and receiver movement use native simulation time instead.
  let mineAtMs = nowMs;
  if (rules.mines && ship) {
    mineAtMs = Number(typeof scene?.getCurrentWallclockMs === "function" ? scene.getCurrentWallclockMs() : nowMs);
    if (!Number.isFinite(mineAtMs) || mineAtMs < 0) throw new Error("FRACTURED_MINE_WALL_CLOCK_UNAVAILABLE");
  }
  if (typeof scene?.getCurrentSimTimeMs === "function") {
    nowMs = Number(scene.getCurrentSimTimeMs());
    if (!Number.isFinite(nowMs) || nowMs < 0) throw new Error("FRACTURED_SCENE_CLOCK_UNAVAILABLE");
  }
  if (!rules.receiverDeparture || !deliveryComplete(input))
    require("./epicSceneActions").companions(scene, input, rules.companions, nowMs);
  mines(scene, input, template, ship, mineAtMs);
  if (rules.researchObjectID) finalBranch(scene, input, template, nowMs);
  receiverDeparture(scene, input, template, nowMs);
}
module.exports = { tick, canMaterializeStructure, pendingMineEvents, reconcilePendingMineEvents };
