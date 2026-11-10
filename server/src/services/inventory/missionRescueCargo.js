"use strict";

// Dropping rescue cargo hands it over: TQ moves it to the destination's NPC owner
// (a captured Onslaught run). The ordinary item owners do the move; this only says
// which container takes the handover. It reads the live site, never client input.
function getRescueDestination(session, containerItem) {
  const state = containerItem && containerItem.spaceState;
  if (!state || state.dungeonSiteContentRole !== "mission_rescue") return null;
  const instance = require("../dungeon/dungeonRuntime").getInstance(state.dungeonSiteInstanceID);
  const template = instance && require("../dungeon/dungeonAuthority").getTemplateByID(instance.templateID);
  const policy = (instance && instance.spawnState && instance.spawnState.populationHints ||
    template && template.populationHints || {}).rescueObjective;
  const scene = require("../../space/runtime").getSceneForSession(session);
  const entity = scene && scene.getEntityByID(containerItem.itemID);
  return policy && policy.kind === "container_transfer_then_combat" && entity &&
    policy.destinationObjectID === entity.dungeonSourceObjectID ? { item: containerItem, policy, instance } : null;
}

// Project-owned excess policy: accept only the outstanding rescue quantity.
// Eligibility/progression stay with the existing access and source-empty owners.
// Read the same destination rows/flags as processMissionRescueObjective; the
// current item index includes prior pending moves in this synchronous batch.
function limitRescueCargoQuantity(destination, item, requestedQuantity) {
  if (!destination || !item || item.typeID !== destination.policy.typeID) return requestedQuantity;
  if (Number(destination.instance?.spawnState?.rescueObjective?.deliveredAtMs) > 0) return 0;
  const { listContainerItems, ITEM_FLAGS } = require("./itemStore");
  const required = Math.max(0, Math.trunc(Number(destination.policy.quantity) || 0));
  const delivered = listContainerItems(null, destination.item.itemID)
    .filter(row => row.typeID === destination.policy.typeID &&
      (row.flagID === ITEM_FLAGS.CARGO_HOLD || row.flagID === 0 && row.ownerID === destination.item.ownerID))
    .reduce((sum, row) => sum + Math.max(0, Math.trunc(Number(row.quantity) || 0)), 0);
  const requested = requestedQuantity === null || requestedQuantity === undefined
    ? Number(item.singleton) === 1 ? 1 : Math.max(0, Math.trunc(Number(item.stacksize ?? item.quantity) || 0))
    : Math.max(0, Math.trunc(Number(requestedQuantity) || 0));
  return Math.min(requested, Math.max(0, required - delivered));
}

module.exports = { getRescueDestination, limitRescueCargoQuantity };
