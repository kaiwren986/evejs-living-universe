"use strict";

// Dungeon salvage outbox: prepare before inventory, acknowledge only durable
// receipts. A retry retains the original hull and cannot mint another Black Box.
const runtime = () => require("./dungeonRuntime");
const inventory = () => require("../inventory/missionSalvageItemCustody");
const intents = instance => instance?.spawnState?.missionSalvageByContentKey || {};
const delivering = new Set();

function validateCycle(context) {
  const { scene, sourceEntity, targetEntity: target, effectState: effect, characterID, shipItem, locked, nowMs } = context;
  if (target?.dungeonSiteContentRole !== "salvage_objective") return { matched: false };
  const instance = runtime().getInstance(Number(target.dungeonSiteInstanceID));
  const template = instance && require("./dungeonAuthority").getTemplateByID(instance.templateID);
  const objective = template?.populationHints?.fetchObjective;
  const owner = Number(instance?.ownership?.missionOwnerCharacterID || instance?.ownership?.characterID);
  const key = String(target.dungeonSiteContentKey || "");
  const ref = instance?.spawnState?.contentEntityRefsByKey?.[key];
  if (!instance || !key || objective?.mechanic !== "successful_salvager_cycle" ||
      Number(objective.triggerEntity?.typeID) !== Number(target.typeID) ||
      Number(objective.triggerEntity?.dunObjectID) !== Number(target.dungeonSourceObjectID || target.dunObjectID) ||
      Number(ref?.itemID) !== Number(target.itemID) || Number(ref?.resolvedAtMs) > 0 ||
      Number(scene?.systemID) !== Number(instance.solarSystemID) || owner !== Number(characterID) ||
      instance.ownership?.visibilityScope !== "private" || instance.runtimeFlags?.missionRuntime !== true ||
      Number(shipItem?.ownerID) !== owner || !Number(shipItem?.itemID) || locked !== true ||
      Number(sourceEntity?.itemID) !== Number(shipItem?.itemID) ||
      effect?.salvagerEffect !== true || Number(effect.typeID) !== Number(objective.moduleTypeID) ||
      Number(effect.typeID) !== 26983 || Number(effect.effectID) === 5163 ||
      !(Number(effect.nextCycleAtMs) > 0 && Number(effect.nextCycleAtMs) <= Number(nowMs))) {
    return { matched: true, success: false, stopReason: "target" };
  }
  return { matched: true, success: true, instance, objective, key };
}

function commit(instanceID, patch, nowMs) {
  return runtime().mergeSpawnState(instanceID, patch, { nowMs, durable: true, force: true });
}

function publish(characterID, changes) {
  try {
    const items = require("../inventory/itemStore"), characters = require("../character/characterState");
    const currentChanges = changes.map(change => ({ ...change, item: items.findItemById(change.item?.itemID) ||
      items.buildRemovedItemNotificationState(change.item || change.previousData) }));
    for (const session of require("../raffles/raffleInventory").getCharacterSessions(characterID)) {
      characters.emitItemsChangedBatchForSession(session, currentChanges, { locationContext: ["Ship", changes[0]?.item?.locationID, "ShipCargo"] });
    }
    require("../agent/loadedMissionRuntime").getLoadedMissionRuntime()?.notifyMissionInventoryChanges?.(characterID, currentChanges);
  } catch (error) {
    require("../../utils/logger").debug(`[MissionSalvage] inventory notification deferred: ${error.message}`);
  }
}

function replayPending(instanceOrID, options = {}) {
  const instanceID = Number(instanceOrID?.instanceID || instanceOrID), nowMs = Math.max(1, Number(options.nowMs) || Date.now());
  if (delivering.has(instanceID)) return { success: false, errorMsg: "MISSION_SALVAGE_REENTRANT" };
  delivering.add(instanceID);
  let changes = [];
  try {
    let instance = runtime().getInstance(instanceID);
    for (const [key, intent] of Object.entries(intents(instance))) {
      if (intent.status === "delivered") continue;
      // A previous synchronous flush may have failed after changing memory.
      // Force the exact retained intent durable again before any owner effect.
      instance = commit(instanceID, { missionSalvageByContentKey: intents(instance) }, nowMs);
      const grant = inventory().grant(intent);
      if (!grant?.success || grant.durable !== true) return { success: false, errorMsg: grant?.errorMsg || "MISSION_SALVAGE_GRANT_PENDING" };
      changes.push(...(grant.data?.changes || []));
      instance = runtime().getInstance(instanceID);
      const refs = instance.spawnState?.contentEntityRefsByKey || {};
      instance = commit(instanceID, {
        missionSalvageByContentKey: { ...intents(instance), [key]: { ...intent, status: "granted" } },
        contentEntityRefsByKey: { ...refs, [key]: { ...refs[key], resolvedAtMs: refs[key]?.resolvedAtMs || nowMs } },
        fetchObjectiveGrantedAtMs: instance.spawnState?.fetchObjectiveGrantedAtMs || nowMs,
      }, nowMs);
      runtime().markInstanceObjectiveSatisfied(instanceID, { nowMs, reason: "mission_salvage_cycle" });
      // markInstanceObjectiveSatisfied uses the ordinary write path; flush the
      // instance with the granted intent before retiring its source.
      instance = commit(instanceID, { missionSalvageByContentKey: intents(runtime().getInstance(instanceID)) }, nowMs);
      const retired = inventory().retire(intent);
      if (!retired?.success || retired.durable !== true) return { success: false, errorMsg: retired?.errorMsg || "MISSION_SALVAGE_RETIRE_PENDING" };
      const scene = options.scene;
      const live = scene?.getEntityByID?.(intent.sourceItemID);
      if (live) {
        const result = scene.removeDynamicEntity(intent.sourceItemID, { broadcast: true });
        if (result?.success === false) return { success: false, errorMsg: "MISSION_SALVAGE_SCENE_REMOVE_PENDING" };
      }
      instance = commit(instanceID, { missionSalvageByContentKey: {
        ...intents(runtime().getInstance(instanceID)), [key]: { ...intent, status: "delivered", deliveredAtMs: nowMs },
      } }, nowMs);
      publish(intent.characterID, grant.data?.changes || []);
    }
    return { success: true, durable: true, changes };
  } catch (error) {
    return { success: false, errorMsg: error.message };
  } finally { delivering.delete(instanceID); }
}

function completeCycle(context) {
  const validated = validateCycle(context);
  if (!validated.success) return validated;
  const { instance, objective, key } = validated;
  try {
    if (!intents(instance)[key]) {
      const source = require("../inventory/simulationInventoryProjection").findItemById(Number(context.targetEntity.itemID));
      if (!source) return { matched: true, success: false, errorMsg: "MISSION_SALVAGE_SOURCE_MISSING" };
      const prefix = `mission-salvage:${instance.instanceID}:${key}`;
      const intent = { version: 1, status: "pending", characterID: Number(context.characterID), shipID: Number(context.shipItem.itemID),
        sourceItemID: Number(source.itemID), sourceOwnerID: Number(source.ownerID), sourceLocationID: Number(source.locationID), sourceFlagID: Number(source.flagID),
        typeID: Number(objective.objectiveTypeID), quantity: Number(objective.objectiveQuantity),
        grantKey: `${prefix}:grant`, retireKey: `${prefix}:retire`, atMs: context.nowMs };
      if (intent.typeID !== 27276 || intent.quantity !== 1) throw new Error("MISSION_SALVAGE_CONTRACT_INVALID");
      commit(instance.instanceID, { missionSalvageByContentKey: { ...intents(instance), [key]: intent } }, context.nowMs);
    }
    return { matched: true, ...replayPending(instance.instanceID, { scene: context.scene, nowMs: context.nowMs }) };
  } catch (error) { return { matched: true, success: false, errorMsg: error.message }; }
}

function suppressMaterialization(instance, key, options = {}) {
  const record = intents(instance)[key];
  if (!record) return false;
  if (record.status !== "delivered") replayPending(instance, options);
  return true;
}

function beforePurge(instance) {
  if (Object.values(intents(instance)).some(intent => intent.status !== "delivered")) {
    const result = replayPending(instance);
    if (!result.success) throw new Error(result.errorMsg);
  }
}

module.exports = { validateCycle, completeCycle, replayPending, suppressMaterialization, beforePurge };
