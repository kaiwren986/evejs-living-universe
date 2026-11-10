"use strict";

// AIR's three finite rocks need a recoverable extraction, rather than an
// unreceipted mint followed by a best-effort depletion write.
const dungeon = require("../dungeon/dungeonRuntime");
const custody = require("../inventory/itemCustody");
const { graphError } = require("../nodegraph/nodeGraphCompiler");
const { cloneValue: clone } = require("../../common/clone");
function requireSuccess(result) {
  if (!result?.success) throw graphError("AIR_MINING_SETTLEMENT_FAILED", result?.errorMsg);
  return result;
}
function persist(instanceID, state, remaining) {
  dungeon.mergeSpawnState(instanceID, { airMining: state, ...(remaining ? { miningRockRemainingByID: remaining } : {}) });
  requireSuccess(require("../../gameStore").flushTableSync("dungeonRuntimeState"));
}
function isAirRock(entity) {
  return entity?.dungeonMaterializedMiningRock === true && dungeon.getInstance(entity.dungeonSiteInstanceID)?.templateID === "evejs.air-tutorial:9245";
}
function finish(instanceID, key) {
  const site = dungeon.getInstance(instanceID), state = clone(site.spawnState.airMining);
  const intent = state.extractions[key];
  const receipt = requireSuccess(custody.getCommittedReceipt(key));
  const ship = require("../inventory/itemStore").findItemById(intent.shipID);
  if (!receipt.committed && (!ship || ship.ownerID !== intent.characterID)) {
    // An uncommitted extraction cannot create cargo in a destroyed or sold
    // hull. Leave its ore available; a later valid extraction may retry it.
    intent.status = "cancelled";
    persist(instanceID, state);
    return { success: false, errorMsg: "AIR_MINING_SHIP_STALE" };
  }
  const grant = requireSuccess(custody.transfer({
    items: { typeID: 60771, quantity: intent.quantity, options: { singleton: 0 } },
    to: custody.custodyRef.ownerLocation(intent.characterID, intent.shipID, intent.flagID),
    actor: intent.characterID, reason: custody.CUSTODY_REASON.AIR_MINING_GRANT, idempotencyKey: key,
  }));
  // A receipt replay must never restore ore depleted by a later extraction.
  if (intent.status !== "complete") {
    intent.status = "complete";
    const remaining = site.spawnState.miningRockRemainingByID || {};
    persist(instanceID, state, { ...remaining, [intent.rockID]: Math.min(remaining[intent.rockID] ?? intent.before, intent.after) });
  }
  return grant;
}
function reconcile(instanceID, scene = null) {
  const site = dungeon.getInstance(instanceID);
  if (site?.templateID !== "evejs.air-tutorial:9245") return;
  const pending = Object.entries(site.spawnState.airMining?.extractions || {}).filter(([, intent]) => intent.status === "prepared");
  // A previous failed prepare flush can leave its intent only in the cache.
  // Require a durable journal again before a retry can mint any cargo.
  if (pending.length) persist(instanceID, clone(site.spawnState.airMining));
  for (const [key] of pending) finish(instanceID, key);
  if (scene) {
    const remaining = dungeon.getInstance(instanceID).spawnState.miningRockRemainingByID || {};
    for (const [id, quantity] of Object.entries(remaining)) {
      const entity = scene.getEntityByID(Number(id));
      if (!entity) continue;
      const owner = require("./miningRuntimeState"), current = owner.getMineableState(scene, Number(id));
      if (current && current.remainingQuantity !== quantity) requireSuccess(owner.updateMineableState(scene, entity, { ...current, remainingQuantity: quantity }));
    }
  }
}
function extract(scene, source, rock, state, quantity, depletedQuantity, flagID) {
  const site = dungeon.getInstance(rock.dungeonSiteInstanceID);
  const characterID = Number(source.session?.characterID || 0);
  if (!characterID || site?.ownership?.characterID !== characterID || rock.airMiningTargetable === false) throw graphError("AIR_MINING_OWNER_FORBIDDEN");
  if (!Number.isSafeInteger(quantity) || quantity <= 0 || quantity !== depletedQuantity || quantity > state.remainingQuantity || state.originalQuantity !== 38) throw graphError("AIR_MINING_QUANTITY_INVALID");
  const mining = clone(site.spawnState.airMining || { extractions: {} });
  mining.extractions ||= {};
  const key = `air-mine:${site.instanceID}:${rock.itemID}:${state.remainingQuantity}`;
  if (!mining.extractions[key] || mining.extractions[key].status === "cancelled") {
    if (Object.keys(mining.extractions).length >= 128) throw graphError("AIR_MINING_EXTRACTION_LIMIT");
    mining.extractions[key] = { status: "prepared", characterID, shipID: source.itemID, flagID, rockID: rock.itemID, objectID: rock.dunObjectID, before: state.remainingQuantity, after: Math.max(0, state.remainingQuantity - depletedQuantity), quantity };
    persist(site.instanceID, mining);
  }
  return finish(site.instanceID, key);
}
function harvested(instanceID, objectID) {
  return Object.values(dungeon.getInstance(instanceID)?.spawnState.airMining?.extractions || {}).filter(entry => entry.status === "complete" && entry.objectID === objectID).reduce((sum, entry) => sum + entry.quantity, 0);
}
module.exports = { isAirRock, extract, reconcile, harvested };
