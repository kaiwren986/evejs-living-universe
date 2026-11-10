"use strict";

// Finite mission/incursion resources prepare extraction before inventory effects.
// Ore custody, depletion, and the paid mining trigger share a stable cycle key.
const { isDeepStrictEqual } = require("node:util");
const runtime = () => require("./dungeonRuntime");
const clone = value => structuredClone(value);
const active = new Set();
const journalOf = instance => instance?.spawnState?.missionMining || { version: 1, extractionsByKey: {}, paidQuantity: 0, armedAtMs: 0 };

function policyFor(instance) {
  const incursion = require("../incursion/incursionMining").policyFor(instance);
  if (incursion) return incursion;
  const template = instance && require("./dungeonAuthority").getTemplateByID(instance.templateID);
  const policy = template?.populationHints?.miningTrigger;
  if (policy?.version === 1 && Number.isSafeInteger(policy.oreTypeID) && policy.oreTypeID > 0 &&
      Number.isSafeInteger(policy.minimumMinedQuantity) && policy.minimumMinedQuantity > 0) return policy;
  return null;
}

function isMissionRock(entity) {
  if (entity?.dungeonMaterializedMiningRock !== true) return false;
  const instance = runtime().getInstance(Number(entity.dungeonSiteInstanceID));
  if (!instance) return false;
  if (require("../incursion/incursionMining").isRock(entity)) return true;
  if (require("./fracturedLegacyRuntime").isRock(entity)) return true;
  if (policyFor(instance)) return true;
  return instance.templateID === "client-dungeon:4093" && entity.careerGasStockVersion === 1 &&
    Number(entity.dungeonSourceObjectID || entity.dunObjectID) === 962121 &&
    [28629, 28695].includes(Number(entity.miningYieldTypeID || entity.slimTypeID)) &&
    Number(entity.miningOriginalQuantity) === 100;
}

function commit(instanceID, patch, nowMs) {
  return runtime().mergeSpawnState(instanceID, patch, { nowMs, durable: true, force: true });
}

function publish(intent, changes, locationContext = ["Ship", intent.shipID, "ShipCargo"]) {
  if (!changes?.length) return;
  const items = require("../inventory/itemStore"), characters = require("../character/characterState");
  const current = changes.map(change => ({ ...change, item: items.findItemById(change.item?.itemID) ||
    items.buildRemovedItemNotificationState(change.item || change.previousData) }));
  for (const session of require("../raffles/raffleInventory").getCharacterSessions(intent.characterID)) {
    characters.emitItemsChangedBatchForSession(session, current, { locationContext });
  }
}

// A duplicate custody receipt holds only item IDs, and the live client was never
// told about this cargo. Announce what the pilot still owns: a row that has since
// gone to another owner stays private, and a row that is gone has nothing to show.
function publishCommitted(intent, itemIDs) {
  const items = require("../inventory/itemStore");
  const owned = [...new Set(itemIDs || [])].map(itemID => items.findItemById(itemID))
    .filter(item => Number(item?.ownerID) === intent.characterID);
  const groups = new Map();
  for (const item of owned) {
    const locationContext = currentLocationContext(intent, item), key = JSON.stringify(locationContext);
    if (!groups.has(key)) groups.set(key, { locationContext, changes: [] });
    groups.get(key).changes.push({ item });
  }
  for (const group of groups.values()) publish(intent, group.changes, group.locationContext);
}

// Follows the client's neocomInventoryBadging._get_item_location. Its badging picks
// a storage from this context, and treats no context as the storage in view, so
// this must describe where the row is now.
function currentLocationContext(intent, item) {
  const { ITEM_FLAGS } = require("../inventory/itemStore");
  const locationID = Number(item.locationID), flagID = Number(item.flagID);
  if (flagID === ITEM_FLAGS.CARGO_HOLD || locationID === intent.shipID) return ["Ship", locationID, "ShipCargo"];
  if (flagID !== ITEM_FLAGS.HANGAR) return null;
  if (require("../../space/worldData").getStationByID(locationID)) return ["Station", locationID, "StationItems"];
  if (require("../structure/structureState").getStructureByID(locationID, { refresh: false })) {
    return ["Structure", locationID, "StructureItemHangar"];
  }
  return null;
}

function synchronizeScene(instance, scene) {
  if (!scene) return;
  const owner = require("../mining/miningRuntimeState");
  for (const [id, quantity] of Object.entries(instance.spawnState?.miningRockRemainingByID || {})) {
    const entity = scene.getEntityByID(Number(id));
    if (!entity || entity.dungeonMaterializedMiningRock !== true) continue;
    const current = owner.getMineableState(scene, Number(id));
    if (current && current.remainingQuantity !== quantity) {
      const updated = owner.updateMineableState(scene, entity, { ...current, remainingQuantity: quantity });
      if (!updated.success) throw new Error(updated.errorMsg || "MISSION_MINING_SCENE_PENDING");
    }
  }
}

function finish(instanceID, key, options = {}) {
  let instance = runtime().getInstance(instanceID), journal = clone(journalOf(instance));
  const intent = journal.extractionsByKey[key];
  if (!intent || intent.status === "cancelled") return { success: false, errorMsg: "MISSION_MINING_CANCELLED" };
  if (intent.status === "complete") return { success: true, durable: true, duplicate: true, data: { intent } };
  const grant = require("../inventory/missionMiningItemCustody").grant(intent, options);
  if (!grant.success || grant.durable !== true) return { success: false, errorMsg: grant.errorMsg || "MISSION_MINING_GRANT_PENDING" };
  instance = runtime().getInstance(instanceID);
  journal = clone(journalOf(instance));
  journal.extractionsByKey[key] = { ...intent, status: grant.cancelled ? "cancelled" : "complete" };
  if (grant.cancelled) {
    commit(instanceID, { missionMining: journal }, options.nowMs || intent.cycleAtMs);
    return { success: false, errorMsg: "MISSION_MINING_CANCELLED" };
  }
  journal.paidQuantity = Object.values(journal.extractionsByKey)
    .filter(value => value.status === "complete").reduce((sum, value) => sum + value.quantity, 0);
  const policy = policyFor(instance);
  if (policy && !journal.armedAtMs && journal.paidQuantity >= policy.minimumMinedQuantity) journal.armedAtMs = intent.cycleAtMs;
  const remaining = instance.spawnState?.miningRockRemainingByID || {};
  commit(instanceID, { missionMining: journal, miningRockRemainingByID: { ...remaining,
    [intent.rockID]: Math.min(remaining[intent.rockID] ?? intent.beforeState.remainingQuantity, intent.afterState.remainingQuantity),
  } }, options.nowMs || intent.cycleAtMs);
  if (options.publish === true) {
    if (grant.duplicate) publishCommitted(intent, grant.data?.itemIDs);
    else publish(intent, grant.data?.changes || []);
  }
  return { ...grant, duplicate: false, data: { ...(grant.data || {}), intent,
    committedMiningDelta: { previousState: intent.beforeState, state: intent.afterState } } };
}

function reconcile(instanceOrID, options = {}) {
  const instanceID = Number(instanceOrID?.instanceID || instanceOrID);
  if (active.has(instanceID)) return { success: false, errorMsg: "MISSION_MINING_REENTRANT" };
  active.add(instanceID);
  try {
    let instance = runtime().getInstance(instanceID);
    if (!instance?.spawnState?.missionMining) return { success: true, changes: [] };
    const journal = journalOf(instance), durable = runtime().getPersistedInstance(instanceID);
    // Recommit a retained prepare or acknowledgement after a refused fence.
    if (!isDeepStrictEqual(journal, journalOf(durable)) ||
        Object.values(journal.extractionsByKey || {}).some(intent => intent.status === "prepared")) {
      const durableIntents = journalOf(durable).extractionsByKey || {};
      const acknowledged = Object.entries(journal.extractionsByKey || {})
        .filter(([key, intent]) => intent.status === "complete" && durableIntents[key]?.status !== "complete")
        .map(([, intent]) => intent);
      // An intent left complete by a refused flush never reaches finish() below.
      // Read its receipt first: once committed, a failed read could not be retried.
      const announcements = acknowledged.map(intent => {
        const receipt = require("../inventory/itemCustody").getCommittedReceipt(intent.grantKey);
        if (!receipt.success || receipt.ambiguous) throw new Error(receipt.errorMsg || "MISSION_MINING_RECEIPT_PENDING");
        return { intent, itemIDs: receipt.resultData?.itemIDs };
      });
      instance = commit(instanceID, { missionMining: journal,
        miningRockRemainingByID: instance.spawnState.miningRockRemainingByID || {} }, options.nowMs);
      for (const { intent, itemIDs } of announcements) publishCommitted(intent, itemIDs);
    }
    const changes = [];
    for (const [key, intent] of Object.entries(journalOf(instance).extractionsByKey || {})) {
      if (intent.status !== "prepared") continue;
      const result = finish(instanceID, key, { ...options, publish: true });
      if (!result.success && result.errorMsg !== "MISSION_MINING_CANCELLED") return result;
      changes.push(...(result.data?.changes || []));
    }
    synchronizeScene(runtime().getInstance(instanceID), options.scene);
    return { success: true, durable: true, changes };
  } catch (error) { return { success: false, errorMsg: error.message }; }
  finally { active.delete(instanceID); }
}

function extract(scene, source, rock, state, cycle) {
  const instance = runtime().getInstance(Number(rock?.dungeonSiteInstanceID));
  const characterID = Number(source?.session?.characterID || source?.characterID || source?.pilotCharacterID);
  const ownerID = Number(instance?.ownership?.missionOwnerCharacterID || instance?.ownership?.characterID);
  const hull = require("../inventory/simulationInventoryProjection").findItemById(Number(source?.itemID));
  const policy = policyFor(instance);
  const quantity = Number(cycle.transferredQuantity), depleted = Number(cycle.normalQuantity) + Number(cycle.wastedQuantity);
  const ownedPrivate = instance?.instanceScope === "private" && instance.ownership?.visibilityScope === "private" &&
    ownerID > 0 && characterID === ownerID;
  // The manual-site command deliberately creates public, ownerless sites.
  // Their finite stock is shared, while each extraction still belongs to its
  // real pilot and hull. Ordinary private mission ownership stays strict.
  const ownerlessManual = instance?.instanceScope === "shared" && ownerID === 0 &&
    instance.runtimeFlags?.manualSpawn === true && instance.metadata?.manualSpawn === true &&
    ["manualSpawnSiteCommand", "authoredOperation"].includes(instance.metadata?.providerID);
  const sharedIncursion = require("../incursion/incursionMining").canExtract(scene, instance, source, rock);
  if (!isMissionRock(rock) || !instance || instance.lifecycleState !== "active" ||
      characterID <= 0 || (!ownedPrivate && !ownerlessManual && !sharedIncursion) ||
      Number(hull?.ownerID) !== characterID || Number(hull?.categoryID) !== 6 ||
      scene?.getEntityByID?.(Number(source.itemID)) !== source || scene.getEntityByID(Number(rock.itemID)) !== rock ||
      Number(scene.systemID) !== Number(instance.solarSystemID) ||
      (policy && Number(state.yieldTypeID) !== Number(policy.oreTypeID)) ||
      !Number.isSafeInteger(quantity) || quantity <= 0 || !Number.isSafeInteger(depleted) || depleted <= 0 ||
      depleted > Number(state.remainingQuantity) || !Number.isSafeInteger(Number(cycle.moduleID)) || Number(cycle.moduleID) <= 0 ||
      !Number.isSafeInteger(Number(cycle.cycleBoundaryMs)) || Number(cycle.cycleBoundaryMs) <= 0) {
    return { success: false, errorMsg: "MISSION_MINING_CYCLE_INVALID" };
  }
  const key = `mission-mine:${instance.instanceID}:${rock.itemID}:${source.itemID}:${cycle.moduleID}:${cycle.cycleBoundaryMs}`;
  let journal = clone(journalOf(instance));
  journal.extractionsByKey ||= {};
  if (!journal.extractionsByKey[key]) {
    if (Object.values(journal.extractionsByKey).some(intent => intent.status === "prepared")) return { success: false, errorMsg: "MISSION_MINING_EXTRACTION_PENDING" };
    const intent = { version: 1, status: "prepared", grantKey: key, characterID, shipID: Number(source.itemID),
      rockID: Number(rock.itemID), dunObjectID: Number(rock.dunObjectID || rock.dungeonSourceObjectID) || null,
      typeID: Number(state.yieldTypeID), moduleID: Number(cycle.moduleID),
      flagID: Number(cycle.flagID), quantity, normalQuantity: Number(cycle.normalQuantity),
      wastedQuantity: Number(cycle.wastedQuantity), criticalHitQuantity: Number(cycle.criticalHitQuantity),
      cycleAtMs: Number(cycle.cycleBoundaryMs), ...(sharedIncursion ? { incursionAtMs: require("../incursion/incursionClock").now() } : {}),
      beforeState: clone(state),
      afterState: { ...clone(state), remainingQuantity: state.remainingQuantity - depleted, updatedAtMs: Number(cycle.cycleBoundaryMs) } };
    journal.extractionsByKey[key] = intent;
    commit(instance.instanceID, { missionMining: journal }, intent.cycleAtMs);
  } else {
    // Even an existing cached prepare must be durable before inventory retries.
    commit(instance.instanceID, { missionMining: journal }, Number(cycle.cycleBoundaryMs));
  }
  return finish(instance.instanceID, key, { nowMs: Number(cycle.cycleBoundaryMs) });
}

function beforePurge(instance) {
  if (!Object.values(journalOf(instance).extractionsByKey || {}).some(intent => intent.status === "prepared")) return;
  const result = reconcile(instance, { purging: true });
  if (!result.success) throw new Error(result.errorMsg);
}

module.exports = { isMissionRock, extract, reconcile, beforePurge, policyFor };
