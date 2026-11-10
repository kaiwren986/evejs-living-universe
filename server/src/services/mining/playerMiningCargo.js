"use strict";

// The receipt shares the inventory transaction with the ore. Recovery checks
// it before the hull: cargo already moved, consumed or destroyed must not mint
// again, and must still pay its original asteroid depletion.
const items = require("../inventory/itemStore");
const holds = require("./miningInventory");

function apply(grant) {
  const receipt = items.getIdempotentGrantReceipt(grant.receiptKey, { reconcileWriteRefusal: true });
  if (!receipt.success) return receipt;
  if (!receipt.found) {
    const hull = items.findItemById(grant.shipID);
    if (!hull || Number(hull.ownerID) !== grant.characterID || Number(hull.categoryID) !== 6 || Number(hull.singleton) !== 1) {
      return { success: true, cancelled: true };
    }
    if (grant.quantity > 0) {
      const resources = require("../fitting/liveFittingState").buildShipResourceState(grant.characterID, hull);
      const flag = grant.flagID;
      if (flag !== items.ITEM_FLAGS.CARGO_HOLD &&
          (!holds.MINING_SHIP_BAY_FLAGS.includes(flag) || !holds.isItemTypeAllowedInHoldFlag(grant.typeID, flag))) {
        return { success: false, errorMsg: "MINING_HOLD_INVALID" };
      }
      const capacity = flag === items.ITEM_FLAGS.CARGO_HOLD ? Number(resources.cargoCapacity) : holds.getShipHoldCapacityByFlag(resources, flag);
      const required = items.getInventoryItemUnitVolume({ typeID: grant.typeID, singleton: 0 }) * grant.quantity;
      const used = items.listContainerItems(null, grant.shipID, flag).reduce((sum, row) => sum +
        items.getInventoryItemUnitVolume(row) * (Number(row.singleton) > 0 ? 1 : Number(row.stacksize ?? row.quantity)), 0);
      if (!Number.isFinite(required) || required <= 0 || !Number.isFinite(used) || used < 0 ||
          !Number.isFinite(capacity) || capacity < 0 || used + required > capacity + 1e-7) {
        return { success: false, errorMsg: "MINING_CARGO_FULL" };
      }
    }
  }
  if (grant.quantity === 0) return { success: true, data: { changes: [] } };
  return items.grantItemToOwnerLocationIdempotent(grant.characterID, grant.shipID, grant.flagID,
    grant.typeID, grant.quantity, { receiptKey: grant.receiptKey, singleton: 0 });
}

module.exports = { apply };
