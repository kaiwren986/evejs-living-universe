"use strict";

// A CRAB death owns its rolled wreck before its NPC graph is retired. The
// checkpoint is stored with the actor, so a failed child deletion or a restart
// cannot turn that accepted death back into a healthy encounter member.
const database = require("../../gameStore");
const log = require("../../utils/logger");
const { isDeepStrictEqual } = require("node:util");
const native = () => require("./nativeNpcStore");
const uncertainPublications = new Set();
const clone = value => JSON.parse(JSON.stringify(value));
const checked = result => {
  if (!result?.success) throw new Error(result?.errorMsg || "NPC_DEATH_RECOVERY_PENDING");
  return result.data;
};

function readPlan(record) {
  const plan = record?.nativeDeathWreck;
  if (!plan || plan.version !== 1 || plan.entityID !== record.entityID ||
      plan.systemID !== record.systemID || plan.typeID !== record.typeID ||
      plan.wreck?.sourceEntityID !== record.entityID || plan.wreck.systemID !== record.systemID ||
      !Number.isSafeInteger(plan.wreck.wreckID) || plan.wreck.wreckID <= 0 ||
      !Array.isArray(plan.items) || plan.items.some(item => item.wreckID !== plan.wreck.wreckID)) {
    throw new Error("NPC_DEATH_PLAN_INVALID");
  }
  return plan;
}

function fenceActor(record) {
  if (record.transient !== true) checked(database.flushTableSync("npcEntities"));
}

function isPendingWreck(record) {
  if (!record?.nativeDeathEntityID) return false;
  const actor = native().getNativeEntity(record.nativeDeathEntityID);
  if (!actor) return false; // Actor retirement follows durable publication.
  return uncertainPublications.has(actor.entityID) || actor.nativeDeathWreck?.published !== true;
}

function publish(record) {
  if (!record?.nativeDeathWreck) return { success: true, handled: false };
  try {
    record = native().getNativeEntity(record.entityID);
    if (!record) return { success: true, handled: true, retired: true };
    const plan = readPlan(record);
    fenceActor(record);
    if (plan.published === true) {
      uncertainPublications.delete(record.entityID);
      return { success: true, handled: true, data: plan };
    }
    const existing = database.read("npcWrecks", `/wrecks/${plan.wreck.wreckID}`);
    if (existing.success && !isDeepStrictEqual(existing.data, plan.wreck)) {
      throw new Error("NPC_DEATH_WRECK_CONFLICT");
    }
    if (!existing.success && existing.errorMsg !== "ENTRY_NOT_FOUND") checked(existing);
    checked(native().upsertNativeWreck(plan.wreck, { transient: plan.wreck.transient }));
    for (const item of plan.items) {
      const prior = database.read("npcWreckItems", `/items/${item.wreckItemID}`);
      if (prior.success && !isDeepStrictEqual(prior.data, item)) throw new Error("NPC_DEATH_LOOT_CONFLICT");
      if (!prior.success && prior.errorMsg !== "ENTRY_NOT_FOUND") checked(prior);
      checked(native().upsertNativeWreckItem(item, { transient: plan.wreck.transient }));
    }
    if (plan.wreck.transient !== true) {
      checked(database.flushTableSync("npcWrecks"));
      checked(database.flushTableSync("npcWreckItems"));
    }
    uncertainPublications.add(record.entityID);
    checked(native().upsertNativeEntity({ ...record,
      nativeDeathWreck: { ...plan, published: true },
    }, { transient: record.transient }));
    fenceActor(record);
    uncertainPublications.delete(record.entityID);
    return { success: true, handled: true, data: { ...plan, published: true } };
  } catch (error) {
    return { success: false, errorMsg: error.message };
  }
}

function settle(scene, record) {
  try {
    record = native().getNativeEntity(record.entityID);
    if (!record) return { success: true, data: { retired: true } };
    const plan = readPlan(record);
    if (!scene || Number(scene.systemID) !== plan.systemID || scene.sceneKey !== plan.sceneKey) {
      throw new Error("NPC_DEATH_SCENE_MISMATCH");
    }
    fenceActor(record);
    const entity = scene.getEntityByID(record.entityID);
    if (entity) {
      entity.destructionState = "destroyed";
      entity.destroyed = true;
      entity.destroying = false;
      checked(require("../runtime").removeDynamicEntity(scene.sceneDescriptor || scene.systemID, record.entityID, {
        sceneDescriptor: scene.sceneDescriptor, allowSessionOwned: false,
        persistSpaceState: false, terminalDestructionEffectID: 3,
      }));
    }
    require("./npcRegistry").unregisterController(record.entityID);
    const publication = publish(record);
    if (!publication.success) return publication;
    // Publication has its own durable acknowledgement. It is safe to expose
    // this wreck even when retiring one of the actor's child rows was refused.
    const wreck = native().getNativeWreck(plan.wreck.wreckID);
    const now = scene.getCurrentSimTimeMs();
    if (wreck && wreck.expiresAtMs > now && !scene.getEntityByID(wreck.wreckID)) {
      const projected = require("./nativeNpcWreckService").spawnNativeWreck(scene.systemID, wreck.wreckID, { scene });
      if (!projected.success) return projected;
    }
    // Keep the terminal source as the retry owner until projection succeeds.
    return native().removeNativeEntityCascade(record.entityID);
  } catch (error) {
    return { success: false, errorMsg: error.message };
  }
}

function commit(scene, entity, record, { wreck, items, rolledLootEntries, destroyedFighterCount }) {
  try {
    const plan = { version: 1, entityID: record.entityID, systemID: record.systemID,
      typeID: record.typeID, sceneKey: scene.sceneKey, published: false,
      wreck: { ...clone(wreck), nativeDeathEntityID: record.entityID },
      items: items.map(item => ({ ...clone(item), nativeDeathEntityID: record.entityID })),
      rolledLootEntries: clone(rolledLootEntries), destroyedFighterCount };
    const next = { ...record, conditionState: { ...entity.conditionState, damage: 1 }, nativeDeathWreck: plan };
    // Reserve the manifest IDs before a durable actor refers to them.
    checked(database.flushTablesSync(["npcWrecks", "npcWreckItems"]));
    checked(native().upsertNativeEntity(next, { transient: record.transient }));
    try { fenceActor(next); } catch (error) {
      // A refused checkpoint has not accepted a death. Restore its preimage
      // before the combat caller makes the existing projection targetable.
      checked(native().upsertNativeEntity(record, { transient: record.transient }));
      fenceActor(record);
      throw error;
    }
    const result = settle(scene, next);
    if (!result.success) log.warn(`[NativeNpcDeath] Cleanup pending entity=${record.entityID}: ${result.errorMsg}`);
    // The accepted terminal checkpoint, rather than successful garbage
    // collection, owns combat credit. Recovery never awards another kill.
    return { success: true, pendingCleanup: !result.success, data: {
      wreck: plan.wreck, shipID: record.entityID, destroyedFighterCount,
      wreckItems: plan.items, rolledLootEntries: plan.rolledLootEntries,
    } };
  } catch (error) {
    return { success: false, errorMsg: error.message };
  }
}

function recoverScene(scene) {
  for (const record of native().listNativeEntitiesForSystem(scene.systemID)) {
    if (!record.nativeDeathWreck || record.nativeDeathWreck.sceneKey !== scene.sceneKey) continue;
    const result = settle(scene, record);
    if (!result.success) log.warn(`[NativeNpcDeath] Recovery pending entity=${record.entityID}: ${result.errorMsg}`);
  }
}

module.exports = { commit, publish, settle, recoverScene, isPendingWreck };
