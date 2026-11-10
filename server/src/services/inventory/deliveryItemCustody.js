"use strict";

const path = require("path");

const itemCustody = require(path.join(__dirname, "./itemCustody"));
const itemStore = require(path.join(__dirname, "./itemStore"));

const DELIVERY_REASONS = new Set([
  itemCustody.CUSTODY_REASON.INV_BROKER_OWNER_TRANSFER,
  itemCustody.CUSTODY_REASON.STRUCTURE_DELIVERY,
  itemCustody.CUSTODY_REASON.STRUCTURE_CARGO_DEPOSIT,
  itemCustody.CUSTODY_REASON.STRUCTURE_UNANCHOR_HANDOFF,
  itemCustody.CUSTODY_REASON.ASSET_SAFETY_WRAP,
  itemCustody.CUSTODY_REASON.ASSET_SAFETY_DELIVER,
]);

// Every reason here is durable, so the key a command carries is consulted
// forever. The state-derived default below is only sound when the coordinates
// it reads can name exactly one logical operation for the lifetime of the item
// — which is what lets a saga leg or a resumed unanchor re-derive its own key
// after a crash and land on its own receipt instead of moving the item twice.
//
// A player dragging an item between their hangar and a corp office breaks that
// premise: a whole-item cross-owner transfer preserves the item ID, so the
// return trip restores the exact coordinates the first hand-off was keyed on,
// and every later hand-off re-derives the first one's key. It would replay that
// receipt — reporting success while moving nothing — and, because the receipt
// fingerprint names the acting character, permanently refuse the same move to
// anyone else. Reasons whose coordinates recur that way have no state-derived
// identity to fall back on and must be keyed by the caller, per operation.
const CALLER_SCOPED_KEY_REASONS = new Set([
  itemCustody.CUSTODY_REASON.INV_BROKER_OWNER_TRANSFER,
]);

// Keys minted by the state-derived default before owner transfers moved to
// caller-scoped keys. Nothing can derive this shape for that reason any more,
// so those rows are unreachable weight in a ledger that never shrinks.
const LEGACY_DEFAULT_KEY_PREFIX = "delivery:";

let legacyReceiptsPruned = false;

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function quantityOf(item) {
  return toInt(item && item.singleton, 0) === 1
    ? 1
    : Math.max(1, toInt(item && (item.stacksize || item.quantity), 1));
}

function isLegacyOwnerTransferReceipt(receipt) {
  const metadata = receipt && receipt.metadata && typeof receipt.metadata === "object"
    ? receipt.metadata.itemCustody
    : null;
  if (!metadata || typeof metadata !== "object") {
    return false;
  }
  const reason = itemCustody.CUSTODY_REASON.INV_BROKER_OWNER_TRANSFER;
  return (
    String(metadata.reason || "") === reason &&
    String(metadata.idempotencyKey || "").startsWith(
      `${LEGACY_DEFAULT_KEY_PREFIX}${reason}:`,
    )
  );
}

// Only this module ever minted the superseded key shape, so only it can prove
// which rows carry it. A failed prune costs nothing but ledger size — the keys
// are already unreachable — so the one-shot never reports upward.
function pruneLegacyOwnerTransferReceipts() {
  if (legacyReceiptsPruned) {
    return;
  }
  legacyReceiptsPruned = true;
  if (typeof itemStore.pruneIdempotentGrantReceipts !== "function") {
    return;
  }
  itemStore.pruneIdempotentGrantReceipts(isLegacyOwnerTransferReceipt);
}

function transferItem(command = {}) {
  pruneLegacyOwnerTransferReceipts();
  const item = command.item && typeof command.item === "object"
    ? command.item
    : null;
  const itemID = toInt(item && item.itemID, 0);
  const sourceOwnerID = toInt(item && item.ownerID, 0);
  const sourceLocationID = toInt(item && item.locationID, 0);
  const sourceFlagID = toInt(item && item.flagID, -1);
  const destinationOwnerID = toInt(command.ownerID, sourceOwnerID);
  const destinationLocationID = toInt(command.locationID, 0);
  const destinationFlagID = toInt(command.flagID, -1);
  const reason = String(command.reason || "");
  const suppliedIdempotencyKey = String(command.idempotencyKey || "").trim();
  const requestedQuantity = command.quantity === null || command.quantity === undefined
    ? null
    : toInt(command.quantity, 0);
  if (
    itemID <= 0 ||
    sourceOwnerID <= 0 ||
    sourceLocationID <= 0 ||
    sourceFlagID < 0 ||
    destinationOwnerID <= 0 ||
    destinationLocationID <= 0 ||
    destinationFlagID < 0 ||
    !DELIVERY_REASONS.has(reason)
  ) {
    return { success: false, errorMsg: "DELIVERY_CUSTODY_SOURCE_INVALID" };
  }
  if (!suppliedIdempotencyKey && CALLER_SCOPED_KEY_REASONS.has(reason)) {
    return {
      success: false,
      errorMsg: "DELIVERY_CUSTODY_IDEMPOTENCY_KEY_REQUIRED",
    };
  }

  return itemCustody.transfer({
    items: {
      itemID,
      ...(command.quantity === null || command.quantity === undefined
        ? {}
        : { quantity: command.quantity }),
    },
    from: itemCustody.custodyRef.ownerLocation(
      sourceOwnerID,
      sourceLocationID,
      sourceFlagID,
    ),
    to: itemCustody.custodyRef.ownerLocation(
      destinationOwnerID,
      destinationLocationID,
      destinationFlagID,
    ),
    reason,
    actor: toInt(command.actor, 0) || null,
    inventoryMoveBatch: command.inventoryMoveBatch,
    idempotencyKey:
      suppliedIdempotencyKey ||
      `${LEGACY_DEFAULT_KEY_PREFIX}${reason}:${itemID}:${sourceOwnerID}:` +
        `${sourceLocationID}:available:${quantityOf(item)}:` +
        `move:${requestedQuantity === null ? "whole" : requestedQuantity}:` +
        `${sourceFlagID}:${destinationOwnerID}:${destinationLocationID}:` +
        `${destinationFlagID}`,
  });
}

module.exports = {
  transferItem,
  _testing: {
    isLegacyOwnerTransferReceipt,
    resetLegacyReceiptPruneForTests() {
      legacyReceiptsPruned = false;
    },
  },
};
