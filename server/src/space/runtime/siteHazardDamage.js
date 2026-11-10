"use strict";

// Dungeon owns when and whom a hazard hit. This adapter owns delivery through
// ordinary typed damage and the existing inventory/death owners. The prepared
// event remains in the dungeon outbox until every durable consequence settles.
const { createHash } = require("node:crypto");
const inventory = require("../../services/inventory/itemStore");
const database = require("../../gameStore");
const { toFileTimeFromMs } = require("./runtimeClock");
const { serializeRuntimeEntityScopeMetadata } = require("./entityScopeTags");
const { applyDamageToEntity, getEntityMaxHealthLayers, hasDamageableHealth, normalizeDamageVector,
  sumDamageVector } = require("../combat/damage");
const publishedByEntity = new WeakMap();
// Exact runtime objects whose health calculation may be ahead of publication.
// A disconnect/unregister must not save their old condition over the item row
// while a receipt flush is uncertain, even if a worker later flushes that row.
const unpublishedHealth = new WeakSet();
const settling = new Set();
const DAMAGE_ATTRIBUTE_IDS = [9, 263, 265, 113, 110, 109, 111, 267, 268, 269, 270, 271, 272, 273, 274];

function check(result) {
  if (!result?.success) throw new Error(result?.errorMsg || "SITE_HAZARD_OWNER_FAILED");
  return result.data;
}

function receiptKey(intent) {
  return "site-hazard:" + createHash("sha256")
    .update(JSON.stringify([intent?.eventID, Number(intent?.target?.shipID)])).digest("hex");
}

function prepareTarget(scene, target) {
  if (scene?.dynamicEntities?.get(target?.itemID) !== target || target?.kind !== "ship" ||
      target.persistSpaceState !== true || !hasDamageableHealth(target) ||
      require("./combatDestruction").isRuntimeEntityDestroyingOrDestroyed(target)) {
    throw new Error("SITE_HAZARD_PERSISTENT_TARGET_REQUIRED");
  }
  const current = inventory.findShipItemById(target.itemID);
  if (!current || Number(current.ownerID) !== Number(target.ownerID) ||
      Number(current.typeID) !== Number(target.typeID) || Number(current.locationID) !== Number(scene.systemID) ||
      Number(current.flagID) !== 0) throw new Error("SITE_HAZARD_TARGET_CUSTODY_MISMATCH");
  check(require("./entitySpacePersistence").persistDynamicEntity(target));
  const item = check(inventory.trackItemCustodyRevision(target.itemID));
  if (Number(item.ownerID) !== Number(target.ownerID) || Number(item.typeID) !== Number(target.typeID) ||
      Number(item.locationID) !== Number(scene.systemID) || Number(item.flagID) !== 0) {
    throw new Error("SITE_HAZARD_TARGET_CUSTODY_MISMATCH");
  }
  const layers = getEntityMaxHealthLayers(target);
  const attributes = target.passiveDerivedState?.attributes || {};
  const scope = serializeRuntimeEntityScopeMetadata(target);
  const pilotSession = require("./entityOwnerSession").getOwningSessionForEntity(scene, target);
  const pilotCharacterID = Number(pilotSession?.characterID || target.pilotCharacterID ||
    target.characterID || target.charID || item.ownerID);
  const entityFields = ["itemID", "typeID", "groupID", "categoryID", "kind", "ownerID", "characterID",
    "pilotCharacterID", "corporationID", "allianceID", "warFactionID", "systemID", "sceneKey", "sceneKind",
    "position", "direction", "velocity", "radius"];
  return { version: 1, shipID: item.itemID, ownerID: item.ownerID, pilotCharacterID, typeID: item.typeID,
    systemID: scene.systemID, sceneKey: scene.sceneKey, sceneKind: scene.sceneKind,
    sceneDescriptor: structuredClone(scene.sceneDescriptor || { systemID: scene.systemID }),
    inventoryCustodyRevision: item.inventoryCustodyRevision, scope: structuredClone(scope),
    entity: { ...Object.fromEntries(entityFields.filter(key => target[key] !== undefined)
      .map(key => [key, structuredClone(target[key])])), ...scope, pilotCharacterID },
    damageModel: { shieldCapacity: layers.shield, armorHP: layers.armor, structureHP: layers.structure,
      passiveDerivedState: { attributes: Object.fromEntries(DAMAGE_ATTRIBUTE_IDS
        .filter(id => attributes[id] !== undefined).map(id => [id, Number(attributes[id])])) } } };
}

function validIntent(intent) {
  const target = intent?.target;
  return target?.version === 1 && typeof intent.eventID === "string" && intent.eventID.length > 0 &&
    Number.isSafeInteger(target.shipID) && target.shipID > 0 && Number(target.ownerID) > 0 &&
    Number(target.typeID) > 0 && Number(target.systemID) > 0 && Number(target.inventoryCustodyRevision) > 0 &&
    typeof target.sceneKey === "string" && target.sceneKey.length > 0 &&
    Number.isFinite(Number(intent.atMs)) && Number(intent.atMs) > 0 && sumDamageVector(intent.rawDamage) > 0;
}

function exactLiveTarget(intent, scene, target) {
  return scene?.dynamicEntities?.get(intent.target.shipID) === target &&
    target?.itemID === intent.target.shipID && Number(target.ownerID) === Number(intent.target.ownerID) &&
    Number(target.typeID) === Number(intent.target.typeID);
}

function prepareDeath(intent, damaged, item, liveTarget) {
  const snapshot = intent.target;
  const scene = { systemID: snapshot.systemID, sceneKey: snapshot.sceneKey,
    sceneKind: snapshot.sceneKind, sceneDescriptor: snapshot.sceneDescriptor,
    getCurrentSimTimeMs() { return Number(intent.atMs); } };
  const plan = require("../shipDestruction").prepareDurableShipDeath(
    { ...snapshot.entity, ...damaged, ...snapshot.scope }, structuredClone(item), receiptKey(intent), scene,
    liveTarget?.session || { characterID: snapshot.pilotCharacterID || snapshot.ownerID });
  // Recovery can happen after an insurance contract or wreck lifetime ends.
  // Both owners must settle the originally accepted loss, not a later retry.
  plan.destroyedAtFiletime = String(toFileTimeFromMs(intent.atMs));
  if (plan.capsule) {
    const character = require("../../services/character/characterState").peekCharacterRecord(snapshot.pilotCharacterID || snapshot.ownerID);
    plan.durablePodDeathKey = receiptKey(intent);
    plan.cloneImplants = structuredClone(character?.implants || []);
  }
  return plan;
}

function publishHealth(intent, result, scene, target) {
  if (!exactLiveTarget(intent, scene, target)) return false;
  let published = publishedByEntity.get(target);
  if (!published) publishedByEntity.set(target, published = new Set());
  const key = receiptKey(intent);
  if (published.has(key)) return false;
  // A failed flush publishes no health. Its successful idempotent retry must
  // publish the committed result once, including while the same entity lives.
  target.conditionState = structuredClone(inventory.findShipItemById(intent.target.shipID)?.conditionState || result.data.conditionState);
  unpublishedHealth.delete(target);
  published.add(key);
  const health = require("./shipHealthState");
  const session = require("./entityOwnerSession").getOwningSessionForEntity(scene, target);
  if (session) health.notifyShipHealthAttributesToSession(session, target, result.data.damageResult, intent.atMs);
  require("./combatDamageMessages").notifyEnvironmentalDamageMessage(scene, null, target,
    intent.sourceName || "Site Hazard", require("./combatDamageMessages").getAppliedDamageAmount(result.data.damageResult));
  health.broadcastDamageStateChange(scene, target, intent.atMs);
  return true;
}

function settleDeath(intent, plan, scene, target) {
  const key = receiptKey(intent) + ":settled";
  const prior = inventory.getIdempotentGrantReceipt(key, { requireDurable: true });
  check(prior);
  if (prior.found) return { success: true, duplicate: true };
  if (settling.has(key)) return { success: false, errorMsg: "SITE_HAZARD_DEATH_IN_PROGRESS" };
  settling.add(key);
  try {
    const death = require("../shipDestruction");
    if (exactLiveTarget(intent, scene, target) && !target.destroyed && !target.removed) {
      target.destructionState = "destroying";
      target.destroying = true;
      const destroyed = require("./combatDestruction").destroyCombatEntity(scene, target, {
        attackerEntity: null, destructionNowMs: intent.atMs, destructionReason: "site-hazard",
        sessionChangeReason: "site_hazard", deathReceipt: plan });
      if (!destroyed?.success) {
        target.destructionState = "alive";
        target.destroying = false;
        check(destroyed);
      }
    }
    if (plan.capsule) check(death.finishDurablePodDeath(plan, target?.session));
    else check(death.finishDurableShipDeathHandoff(plan));
    const settled = check(death.settleDurableShipDeath(plan));
    check(database.flushTablesSync(["characters", "items", "insuranceContracts", "notifications", "shipKillCounters"]));
    if (scene && target && scene.dynamicEntities?.get(intent.target.shipID) === target) scene.removeDynamicEntity?.(target.itemID, { broadcast: true });
    if (scene && settled.debrisID && !scene.getEntityByID?.(settled.debrisID)) {
      const debris = inventory.findItemById(settled.debrisID);
      if (debris && (!debris.expiresAtMs || debris.expiresAtMs > scene.getCurrentSimTimeMs())) {
        require("../runtime").spawnDynamicInventoryEntity(intent.target.systemID, settled.debrisID,
          { sceneDescriptor: scene.sceneDescriptor });
      }
    }
    check(inventory.completeSiteHazardDeathIdempotent({ receiptKey: key,
      fingerprint: { eventID: intent.eventID, shipID: intent.target.shipID }, completedAtMs: intent.atMs }));
    return { success: true, data: settled };
  } finally { settling.delete(key); }
}

function deliver(intent, options = {}) {
  if (!validIntent(intent)) return { success: false, errorMsg: "SITE_HAZARD_INTENT_INVALID" };
  const { scene, target } = options;
  const snapshot = intent.target;
  try {
    const result = inventory.commitSiteHazardDamageIdempotent(snapshot, item => {
      if (exactLiveTarget(intent, scene, target)) unpublishedHealth.add(target);
      const damaged = { ...snapshot.entity, ...snapshot.damageModel,
        conditionState: structuredClone(item.conditionState) };
      const damageResult = applyDamageToEntity(damaged, normalizeDamageVector(intent.rawDamage));
      if (!damageResult.success) return damageResult;
      const deathPlan = damageResult.data.destroyed
        ? prepareDeath(intent, damaged, item, exactLiveTarget(intent, scene, target) ? target : null) : null;
      return { success: true, conditionState: damaged.conditionState, damageResult, deathPlan };
    }, { receiptKey: receiptKey(intent), fingerprint: { version: 1, eventID: intent.eventID,
      rawDamage: normalizeDamageVector(intent.rawDamage), target: snapshot, atMs: Number(intent.atMs) }, completedAtMs: intent.atMs });
    if (!result.success) return result;
    if (result.data.stale) return { ...result, stale: true };
    const published = publishHealth(intent, result, scene, target);
    if (result.data.deathPlan) {
      const settled = settleDeath(intent, result.data.deathPlan, scene, target);
      if (!settled.success) return { ...settled, durable: true, damageResult: result.data.damageResult };
    }
    return { ...result, published, conditionState: result.data.conditionState,
      damageResult: result.data.damageResult, destroyed: Boolean(result.data.deathPlan) };
  } catch (error) {
    return { success: false, errorMsg: error.message };
  }
}

function retireEvents(eventIDs) {
  const ids = new Set(eventIDs);
  const result = inventory.pruneIdempotentGrantReceipts(receipt =>
    ["site-hazard-damage", "site-hazard-death-settled"].includes(receipt.operation) && ids.has(receipt.fingerprint?.eventID));
  if (result.success) check(database.flushTableSync("items"));
  return result;
}

module.exports = { prepareTarget, receiptKey, deliver, retireEvents,
  hasUnpublishedHealth: entity => Boolean(entity && unpublishedHealth.has(entity)) };
