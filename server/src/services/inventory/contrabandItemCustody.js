"use strict";

const path = require("path");

const itemCustody = require(path.join(__dirname, "./itemCustody"));
const itemStore = require(path.join(__dirname, "./itemStore"));

function toPositiveInt(value, fallback = 0) {
  const numeric = Math.trunc(Number(value) || 0);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : fallback;
}

function revalidateItem(command = {}) {
  const item = itemStore.findItemById(command.itemID);
  if (!item) {
    return { success: false, errorMsg: "ITEM_NOT_FOUND" };
  }
  if (command.observedCustodyRevision !== undefined &&
    Number(item.inventoryCustodyRevision) !== Number(command.observedCustodyRevision)) {
    return { success: false, errorMsg: "CONTRABAND_CUSTODY_REVISION_MISMATCH" };
  }
  if (
    Number(item.ownerID) !== Number(command.characterID) ||
    Number(item.locationID) !== Number(command.locationID) ||
    Number(item.flagID) !== Number(command.flagID) ||
    (command.typeID !== undefined && Number(item.typeID) !== Number(command.typeID)) ||
    (command.singleton !== undefined && Number(item.singleton) !== Number(command.singleton))
  ) {
    return { success: false, errorMsg: "CONTRABAND_CUSTODY_SNAPSHOT_MISMATCH" };
  }
  const available = Number(item.singleton) === 1
    ? 1
    : toPositiveInt(item.stacksize ?? item.quantity, 0);
  const quantity = Math.min(available, toPositiveInt(command.quantity, 0));
  return quantity > 0
    ? { success: true, data: { item, quantity } }
    : { success: false, errorMsg: "INSUFFICIENT_ITEMS" };
}

function getConfiscationReceipt(idempotencyKey) {
  const result = itemCustody.getCommittedReceipt(idempotencyKey);
  return result.success === false ? { ...result, retryable: true } : result;
}

function confiscateItem(command = {}) {
  const characterID = toPositiveInt(command.characterID, 0);
  const itemID = toPositiveInt(command.itemID, 0);
  const locationID = toPositiveInt(command.locationID, 0);
  const flagID = Math.trunc(Number(command.flagID));
  const quantity = toPositiveInt(command.quantity, 0);
  const operationID = String(command.operationID || "").trim();
  const idempotencyKey = String(command.idempotencyKey || "").trim();
  if (
    !characterID ||
    !itemID ||
    !locationID ||
    !Number.isInteger(flagID) ||
    flagID < 0 ||
    !quantity ||
    !operationID ||
    !idempotencyKey
  ) {
    return { success: false, errorMsg: "CONTRABAND_CUSTODY_ROUTE_INVALID" };
  }

  // The generic local-remove route replays its receipt before reading an item.
  // Keep that ordering, but validate a new confiscation against its captured
  // owner/location/type before permitting any removal.
  const committed = getConfiscationReceipt(idempotencyKey);
  if (committed.success === false) {
    return {
      success: false,
      ambiguous: committed.ambiguous === true,
      retryable: true,
      errorMsg: committed.errorMsg || "CONTRABAND_CUSTODY_RECEIPT_LOOKUP_FAILED",
    };
  }
  if (!committed.committed) {
    const current = revalidateItem({ ...command, characterID, itemID, locationID, flagID, quantity });
    if (!current.success) {
      return current;
    }
    if (current.data.quantity !== quantity) {
      return { success: false, errorMsg: "INSUFFICIENT_ITEMS" };
    }
  } else {
    const previous = (committed.resultData && committed.resultData.changes || [])
      .map((change) => change && change.previousData)
      .find((item) => Number(item && item.itemID) === itemID);
    if (
      (command.typeID !== undefined && (!previous || Number(previous.typeID) !== Number(command.typeID))) ||
      (command.singleton !== undefined && (!previous || Number(previous.singleton) !== Number(command.singleton)))
    ) {
      return { success: false, ambiguous: true, errorMsg: "CONTRABAND_CUSTODY_RECEIPT_MISMATCH" };
    }
  }

  return itemCustody.transfer({
    items: { itemID, quantity },
    from: itemCustody.custodyRef.ownerLocation(
      characterID,
      locationID,
      flagID,
    ),
    to: itemCustody.custodyRef.void(),
    options: { removeContents: true },
    reason: itemCustody.CUSTODY_REASON.CONTRABAND_CONFISCATE,
    actor: characterID,
    idempotencyKey,
  });
}

module.exports = { confiscateItem, getConfiscationReceipt, revalidateItem };
