"use strict";

// Inventory admission for a prepared mission extraction. A permanent receipt
// wins over later cargo moves, consumption, destruction, or fitting changes.
const custody = require("./itemCustody");
const items = require("./itemStore");
const miningInventory = require("../mining/miningInventory");

function grant(intent, options = {}) {
  const receipt = custody.getCommittedReceipt(intent.grantKey);
  if (!receipt.success) return receipt;
  if (receipt.committed) return { success: true, durable: true, duplicate: true, data: receipt.resultData || {} };
  if (options.purging === true) return { success: true, durable: true, cancelled: true };
  const hull = items.findItemById(intent.shipID);
  if (!hull || Number(hull.ownerID) !== intent.characterID || Number(hull.categoryID) !== 6 || Number(hull.singleton) !== 1) {
    return { success: true, durable: true, cancelled: true };
  }
  const resources = require("../fitting/liveFittingState").buildShipResourceState(intent.characterID, hull);
  const flagID = Number(intent.flagID);
  if (flagID !== items.ITEM_FLAGS.CARGO_HOLD &&
      (!miningInventory.MINING_SHIP_BAY_FLAGS.includes(flagID) || !miningInventory.isItemTypeAllowedInHoldFlag(intent.typeID, flagID))) {
    return { success: false, errorMsg: "MISSION_MINING_HOLD_INVALID" };
  }
  const capacity = flagID === items.ITEM_FLAGS.CARGO_HOLD
    ? Number(resources.cargoCapacity) : miningInventory.getShipHoldCapacityByFlag(resources, flagID);
  const required = items.getInventoryItemUnitVolume({ typeID: intent.typeID, singleton: 0 }) * intent.quantity;
  const used = items.listContainerItems(null, intent.shipID, flagID).reduce((sum, row) => sum +
    items.getInventoryItemUnitVolume(row) * (Number(row.singleton) > 0 ? 1 : Number(row.stacksize ?? row.quantity)), 0);
  if (!Number.isFinite(required) || required <= 0 || !Number.isFinite(used) || used < 0 ||
      !Number.isFinite(capacity) || capacity < 0 || used + required > capacity + 1e-7) {
    return { success: false, errorMsg: "MISSION_MINING_CARGO_FULL" };
  }
  return custody.transfer({ items: { typeID: intent.typeID, quantity: intent.quantity, options: { singleton: 0 } },
    to: custody.custodyRef.ownerLocation(intent.characterID, intent.shipID, flagID), actor: intent.characterID,
    reason: custody.CUSTODY_REASON.MISSION_REWARD_GRANT, idempotencyKey: intent.grantKey });
}

module.exports = { grant };
