"use strict";

const path = require("path");

const itemCustody = require(path.join(__dirname, "./itemCustody"));
const itemStore = require(path.join(__dirname, "./itemStore"));
const {
  ensureGrantedBlueprintCopyState,
  isBlueprintCopyRewardType,
} = require("./blueprintRewardState");

function toPositiveInt(value, fallback = 0) {
  const numeric = Math.trunc(Number(value) || 0);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : fallback;
}

function normalizeCommand(command = {}) {
  return {
    characterID: toPositiveInt(command.characterID, 0),
    locationID: toPositiveInt(command.locationID, 0),
    itemID: toPositiveInt(command.itemID, 0),
    typeID: toPositiveInt(command.typeID, 0),
    quantity: toPositiveInt(command.quantity, 0),
    operationID: String(command.operationID || "").trim(),
    idempotencyKey: String(command.idempotencyKey || "").trim(),
  };
}

function consumeRequiredItem(command = {}) {
  const normalized = normalizeCommand(command);
  if (
    !normalized.characterID ||
    !normalized.locationID ||
    !normalized.itemID ||
    !normalized.typeID ||
    !normalized.quantity ||
    !normalized.operationID ||
    !normalized.idempotencyKey
  ) {
    return { success: false, errorMsg: "LP_STORE_CUSTODY_ROUTE_INVALID" };
  }

  return itemCustody.transfer({
    items: {
      itemID: normalized.itemID,
      quantity: normalized.quantity,
    },
    from: itemCustody.custodyRef.ownerLocation(
      normalized.characterID,
      normalized.locationID,
      itemStore.ITEM_FLAGS.HANGAR,
    ),
    to: itemCustody.custodyRef.void(),
    reason: itemCustody.CUSTODY_REASON.LP_STORE_REQUIRED_CONSUME,
    actor: normalized.characterID,
    idempotencyKey: normalized.idempotencyKey,
  });
}

function grantItem(command = {}, reason, options = {}) {
  const normalized = normalizeCommand(command);
  if (
    !normalized.characterID ||
    !normalized.locationID ||
    !normalized.typeID ||
    !normalized.quantity ||
    !normalized.operationID ||
    !normalized.idempotencyKey
  ) {
    return { success: false, errorMsg: "LP_STORE_CUSTODY_ROUTE_INVALID" };
  }

  return itemCustody.transfer({
    items: {
      typeID: normalized.typeID,
      quantity: normalized.quantity,
      options,
    },
    to: itemCustody.custodyRef.ownerLocation(
      normalized.characterID,
      normalized.locationID,
      itemStore.ITEM_FLAGS.HANGAR,
    ),
    reason,
    actor: normalized.characterID,
    idempotencyKey: normalized.idempotencyKey,
  });
}

function refundRequiredItem(command = {}) {
  return grantItem(
    command,
    itemCustody.CUSTODY_REASON.LP_STORE_REQUIRED_REFUND,
    { singleton: 0 },
  );
}

function recoverCommittedBlueprintReward(command) {
  const normalized = normalizeCommand(command);
  const committed = itemCustody.getCommittedReceipt(normalized.idempotencyKey);
  if (!committed.success) {
    return { ...committed, ambiguous: true };
  }
  if (!committed.committed) {
    return null;
  }

  const receipt = committed.receipt;
  const metadata = receipt.metadata && receipt.metadata.itemCustody;
  const copyCount = toPositiveInt(command.numberOfOffers, normalized.quantity);
  const itemIDs = committed.resultData && committed.resultData.itemIDs;
  const mismatch = () => ({
    success: false, ambiguous: true, errorMsg: "LP_STORE_BLUEPRINT_RECEIPT_MISMATCH",
  });
  if (
    Number(receipt.ownerID) !== normalized.characterID ||
    Number(receipt.locationID) !== normalized.locationID ||
    Number(receipt.flagID) !== itemStore.ITEM_FLAGS.HANGAR ||
    Number(receipt.typeID) !== normalized.typeID ||
    metadata?.commandType !== itemCustody.CUSTODY_COMMAND_TYPE.TRANSFER ||
    metadata.idempotencyKey !== normalized.idempotencyKey ||
    metadata.reason !== itemCustody.CUSTODY_REASON.LP_STORE_REWARD_GRANT ||
    !Array.isArray(itemIDs) || itemIDs.length !== Number(receipt.quantity)
  ) {
    return mismatch();
  }
  const remainingItems = itemIDs.map((itemID) => itemStore.findItemById(itemID)).filter(Boolean);
  if (remainingItems.some((item) => Number(item.typeID) !== normalized.typeID)) {
    return mismatch();
  }
  // Old purchases could commit originals before losing rewardApplied. Replay
  // their original item count, including moved or removed rows, without turning
  // them into copies or rejecting and refunding an already-delivered reward.
  if (Number(receipt.quantity) === normalized.quantity &&
      remainingItems.every((item) => Number(item.singleton) === 1)) {
    return grantItem(normalized, itemCustody.CUSTODY_REASON.LP_STORE_REWARD_GRANT);
  }
  return Number(receipt.quantity) === copyCount ? null : mismatch();
}

function grantReward(command = {}) {
  const blueprintCopy = isBlueprintCopyRewardType(itemStore.getItemMetadata(command.typeID));
  if (blueprintCopy) {
    const recovered = recoverCommittedBlueprintReward(command);
    if (recovered) return recovered;
  }
  const runsRemaining = toPositiveInt(command.blueprintRuns, 0);
  if (blueprintCopy && !runsRemaining) {
    return { success: false, errorMsg: "INVALID_BLUEPRINT_RUNS" };
  }
  // An LP offer's quantity is the licensed runs of one copy. Keep copies
  // separate in bulk purchases, including purchases resumed from older saves.
  const result = grantItem(
    blueprintCopy
      ? { ...command, quantity: toPositiveInt(command.numberOfOffers, command.quantity) }
      : command,
    itemCustody.CUSTODY_REASON.LP_STORE_REWARD_GRANT,
    blueprintCopy ? { singleton: 2 } : {},
  );
  if (!result.success || !blueprintCopy) {
    return result;
  }
  // A receipt can outlive its copies after they are used up or removed.
  if (result.duplicate === true && result.data.items.length === 0) {
    return result;
  }
  const initialized = ensureGrantedBlueprintCopyState(
    result.data.items,
    { runsRemaining },
  );
  return initialized.success ? result : initialized;
}

module.exports = {
  consumeRequiredItem,
  grantReward,
  refundRequiredItem,
};
