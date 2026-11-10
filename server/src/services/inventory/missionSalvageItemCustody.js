"use strict";

// Inventory owns the two independently receipted effects of mission salvage.
const custody = require("./itemCustody");
const { findItemById, listContainerItems, getInventoryItemUnitVolume, ITEM_FLAGS } = require("./itemStore");

function grant(intent) {
  const receipt = custody.getCommittedReceipt(intent.grantKey);
  if (!receipt.success) return receipt;
  if (receipt.committed) return { success: true, durable: true, duplicate: true, data: receipt.resultData || {} };
  const hull = findItemById(intent.shipID);
  if (!hull || Number(hull.ownerID) !== intent.characterID || Number(hull.categoryID) !== 6 || Number(hull.singleton) !== 1) {
    return { success: false, errorMsg: "MISSION_SALVAGE_DESTINATION_MISSING" };
  }
  // Replayed intents can outlive a cargo move or fitting change. Admit the
  // uncommitted grant against the current hold; durable receipts above remain
  // sufficient even if their already delivered item was moved or consumed.
  const required = getInventoryItemUnitVolume({ typeID: intent.typeID, singleton: 0 }) * intent.quantity;
  const used = listContainerItems(null, intent.shipID, ITEM_FLAGS.CARGO_HOLD)
    .reduce((sum, item) => sum + getInventoryItemUnitVolume(item) *
      (Number(item.singleton) > 0 ? 1 : Number(item.stacksize ?? item.quantity)), 0);
  const capacity = require("../fitting/liveFittingState").buildShipResourceState(intent.characterID, hull).cargoCapacity;
  if (!Number.isFinite(required) || required < 0 || !Number.isFinite(used) || used < 0 ||
      !Number.isFinite(capacity) || capacity < 0 || used + required > capacity + 1e-7) {
    return { success: false, errorMsg: "MISSION_SALVAGE_CARGO_FULL" };
  }
  return custody.transfer({ items: { typeID: intent.typeID, quantity: intent.quantity,
    options: { customInfo: JSON.stringify({ isSalvaged: true }) } },
    to: custody.custodyRef.ownerLocation(intent.characterID, intent.shipID, ITEM_FLAGS.CARGO_HOLD),
    actor: intent.characterID, reason: custody.CUSTODY_REASON.MISSION_REWARD_GRANT,
    idempotencyKey: intent.grantKey });
}

function retire(intent) {
  const receipt = custody.getCommittedReceipt(intent.retireKey);
  if (!receipt.success) return receipt;
  if (receipt.committed) return { success: true, durable: true, duplicate: true };
  // A resolved dungeon ref prevents recreation. An independently removed source
  // has no inventory effect left to perform; never replace it to obtain a receipt.
  const item = findItemById(intent.sourceItemID);
  if (!item) {
    // Ordinary removal can be ahead of disk. Fence the inventory owner before
    // allowing the dungeon to forget this source, even on an absence retry.
    const database = require("../../gameStore");
    const fenced = database.flushTableSync("items");
    if (!fenced?.success) return { success: false, errorMsg: fenced?.errorMsg || "MISSION_SALVAGE_ABSENCE_NOT_DURABLE" };
    const persisted = database.readPersisted("items", `/${intent.sourceItemID}`);
    if (persisted?.errorMsg !== "ENTRY_NOT_FOUND") return { success: false, errorMsg: "MISSION_SALVAGE_ABSENCE_NOT_DURABLE" };
    return { success: true, durable: true, absent: true };
  }
  if (Number(item.ownerID) !== intent.sourceOwnerID || Number(item.locationID) !== intent.sourceLocationID) {
    return { success: false, errorMsg: "MISSION_SALVAGE_SOURCE_CHANGED" };
  }
  return custody.transfer({ items: { itemID: intent.sourceItemID, quantity: 1 },
    from: custody.custodyRef.ownerLocation(intent.sourceOwnerID, intent.sourceLocationID, intent.sourceFlagID),
    to: { kind: custody.CUSTODY_REF_KIND.VOID }, actor: intent.characterID,
    reason: custody.CUSTODY_REASON.MISSION_CARGO_COMMIT, idempotencyKey: intent.retireKey });
}

module.exports = { grant, retire };
