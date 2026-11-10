"use strict";

// The dungeon owner registers reviewed native sources; the existing scene
// owns their clock and lifecycle. No client RPC can define an effect or bind
// an arbitrary Ball. Other feature owners (Homefront, Abyssal, ESS) retain
// their current effects and are outside this selected component subset.
const authority = require("./appliedProximityEffectAuthority.json");
const { canEntitiesInteractLocally } = require("../../space/destiny/identity/interactionScope");
const { entityIDsEqual } = require("../../space/destiny/identity/entityID");
const dbuffs = require("../../space/modules/commandBurstRuntime");
const sourcesByScene = new WeakMap();
const simNow = scene => Number(scene.getCurrentSimTimeMs());
const getRule = typeID => authority.types[String(typeID)] || null;

function materializationHints(instance, hints) {
  const selected = Object.entries(authority.types).filter(([, rule]) => rule.binding.templateID === instance.templateID);
  if (!selected.length) return hints;
  const installed = require("../dungeon/dungeonAuthority").getTemplateByID(instance.templateID);
  const selectedTypes = new Set(selected.map(([id]) => Number(id)));
  const props = installed?.populationHints?.environmentProps?.filter(prop => selectedTypes.has(prop.typeID)) || [];
  if (props.length !== selected.length) throw new Error("AIR_MINING_NATIVE_COMPONENT_CONTENT_REQUIRED");
  // An old accepted site's saved hints may predate this component. Rebuild
  // only this derived source from current installed content, preserving its
  // finite rocks, extraction receipts, actors and all other accepted hints.
  return { ...hints, environmentProps: [
    ...(hints.environmentProps || []).filter(prop => !selectedTypes.has(prop.typeID)), ...props,
  ] };
}

function sources(scene) {
  if (!sourcesByScene.has(scene)) sourcesByScene.set(scene, new Map());
  return sourcesByScene.get(scene);
}

function bindSource(scene, entity, instance, template) {
  const rule = getRule(entity?.typeID);
  if (!rule) return false;
  const binding = rule.binding;
  if (rule.delaySeconds !== 0 || !Number.isFinite(rule.radius) || rule.radius <= 0 ||
      template?.templateID !== binding.templateID || instance?.templateID !== binding.templateID ||
      entity.dunObjectID !== binding.objectID || entity.dungeonRoomKey !== binding.roomKey ||
      !entityIDsEqual(entity.dungeonSiteInstanceID, instance.instanceID) || !entity.dungeonMaterializedEnvironment ||
      scene.getEntityByID(entity.itemID) !== entity || scene.systemID !== instance.solarSystemID) {
    throw new Error("APPLIED_PROXIMITY_SOURCE_BINDING_INVALID");
  }
  const installed = require("../dungeon/dungeonAuthority").getTemplateByID(instance.templateID);
  const props = installed?.populationHints?.environmentProps?.filter(prop =>
    prop.exact === true && prop.typeID === entity.typeID && prop.dunObjectID === binding.objectID &&
    prop.roomKey === binding.roomKey);
  if (props?.length !== 1 || !["x", "y", "z"].every((axis, index) =>
    entity.dunPosition?.[index] === props[0].positionOffset?.[axis])) {
    throw new Error("APPLIED_PROXIMITY_SOURCE_NOT_AUTHORED");
  }
  const existing = sources(scene).get(entity);
  if (existing) return true;
  const roomKeys = new Set([binding.roomKey]);
  const profiles = installed.siteSceneProfile?.roomProfiles;
  // Dungeon tracking uses room:entry for a site's entry alias. This selected
  // single-room template proves which native room that alias represents.
  // Never grant an alias across a multi-room/gated template.
  if (profiles?.length === 1 && profiles[0].roomKey === binding.roomKey &&
      !(installed.siteSceneProfile.gateProfiles || []).length) roomKeys.add("room:entry");
  sources(scene).set(entity, { entity, instanceID: instance.instanceID, roomKey: binding.roomKey,
    roomKeys,
    sourceKey: `applied-proximity:${instance.instanceID}:${entity.itemID}`, rule,
    collectionValues: new Map(Object.entries(rule.effects).map(([id, value]) => [Number(id), value])),
    targets: new Set() });
  return true;
}

function clearTarget(scene, entry, target, reason) {
  entry.targets.delete(target);
  if (scene.getEntityByID(target.itemID) === target) {
    scene.clearContinuousDbuffSource(target, entry.sourceKey, { nowMs: simNow(scene), reason });
  } else {
    // Retired/replaced entities cannot send a stale HUD to a new projection
    // which happens to use the same numeric ID.
    dbuffs.clearContinuousDbuffSource(target, entry.sourceKey, simNow(scene));
  }
}

function removeSource(scene, entry) {
  for (const target of [...entry.targets]) clearTarget(scene, entry, target, "proximity-source-removed");
  sourcesByScene.get(scene)?.delete(entry.entity);
}

function targetMatches(scene, entry, target) {
  if (target.kind !== "ship" || target.destroyed || !target.position || !entry.entity.position ||
      scene.getEntityByID(target.itemID) !== target ||
      !canEntitiesInteractLocally(entry.entity, target)) return false;
  const instanceID = target.dungeonCurrentInstanceID ?? target.dungeonSiteInstanceID;
  const roomKey = target.dungeonCurrentRoomKey ?? target.dungeonRoomKey;
  if (!entityIDsEqual(instanceID, entry.instanceID) || (roomKey && !entry.roomKeys.has(roomKey))) return false;
  return Math.hypot(target.position.x - entry.entity.position.x,
    target.position.y - entry.entity.position.y, target.position.z - entry.entity.position.z) <= entry.rule.radius;
}

function tickScene(scene) {
  const entries = sourcesByScene.get(scene);
  if (!entries?.size) return;
  const candidates = [...scene.dynamicEntities.values()];
  for (const entry of [...entries.values()]) {
    const instance = require("../dungeon/dungeonRuntime").getInstance(entry.instanceID);
    if (scene.getEntityByID(entry.entity.itemID) !== entry.entity || entry.entity.destroyed ||
        !instance || instance.lifecycleState !== "active") {
      removeSource(scene, entry);
      continue;
    }
    for (const target of [...entry.targets]) {
      if (!targetMatches(scene, entry, target)) clearTarget(scene, entry, target, "proximity-scope-exit");
    }
    for (const target of candidates) {
      if (entry.targets.has(target) || !targetMatches(scene, entry, target)) continue;
      const result = scene.setContinuousDbuffSource(target, entry.sourceKey, entry.collectionValues,
        { nowMs: simNow(scene), reason: "applied-proximity-effects" });
      if (!result.success) throw new Error(`APPLIED_PROXIMITY_DBUFF_UNRESOLVED:${result.unresolvedCollectionIDs}`);
      entry.targets.add(target);
    }
  }
}

function handleEntityRemoved(scene, entity) {
  const entries = sourcesByScene.get(scene);
  if (!entries) return;
  const own = entries.get(entity);
  if (own) removeSource(scene, own);
  for (const entry of entries.values()) {
    if (entry.targets.has(entity)) clearTarget(scene, entry, entity, "proximity-target-removed");
  }
}

function disposeScene(scene) {
  for (const entry of [...(sourcesByScene.get(scene)?.values() || [])]) removeSource(scene, entry);
  sourcesByScene.delete(scene);
}

module.exports = { getRule, materializationHints, bindSource, tickScene, handleEntityRemoved, disposeScene };
