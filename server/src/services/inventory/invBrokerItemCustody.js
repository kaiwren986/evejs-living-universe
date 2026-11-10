"use strict";

const path = require("path");

const itemCustody = require(path.join(__dirname, "./itemCustody"));

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function moveItem(command = {}) {
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
  if (
    itemID <= 0 ||
    sourceOwnerID <= 0 ||
    sourceLocationID <= 0 ||
    sourceFlagID < 0 ||
    destinationOwnerID !== sourceOwnerID ||
    destinationLocationID <= 0 ||
    destinationFlagID < 0
  ) {
    return { success: false, errorMsg: "INV_BROKER_CUSTODY_SOURCE_INVALID" };
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
    reason: itemCustody.CUSTODY_REASON.INV_BROKER_MOVE,
    actor: toInt(command.actor, 0) || null,
    inventoryMoveBatch: command.inventoryMoveBatch,
    idempotencyKey:
      String(command.idempotencyKey || "").trim() ||
      `inv-broker-move:${itemID}:${sourceOwnerID}:${sourceLocationID}:` +
        `${sourceFlagID}:${destinationLocationID}:${destinationFlagID}`,
  });
}

function mergeStacks(command = {}) {
  const sourceItem = command.sourceItem && typeof command.sourceItem === "object"
    ? command.sourceItem
    : null;
  const destinationItem =
    command.destinationItem && typeof command.destinationItem === "object"
      ? command.destinationItem
      : null;
  const sourceItemID = toInt(sourceItem && sourceItem.itemID, 0);
  const destinationItemID = toInt(destinationItem && destinationItem.itemID, 0);
  const ownerID = toInt(sourceItem && sourceItem.ownerID, 0);
  const sourceLocationID = toInt(sourceItem && sourceItem.locationID, 0);
  const sourceFlagID = toInt(sourceItem && sourceItem.flagID, -1);
  const destinationLocationID = toInt(destinationItem && destinationItem.locationID, 0);
  const destinationFlagID = toInt(destinationItem && destinationItem.flagID, -1);
  if (
    sourceItemID <= 0 ||
    destinationItemID <= 0 ||
    sourceItemID === destinationItemID ||
    ownerID <= 0 ||
    sourceLocationID <= 0 ||
    sourceFlagID < 0 ||
    toInt(destinationItem && destinationItem.ownerID, 0) !== ownerID ||
    destinationLocationID <= 0 ||
    destinationFlagID < 0
  ) {
    return { success: false, errorMsg: "INV_BROKER_CUSTODY_MERGE_INVALID" };
  }

  const sourceRef = itemCustody.custodyRef.ownerLocation(
    ownerID,
    sourceLocationID,
    sourceFlagID,
  );
  const destinationRef = itemCustody.custodyRef.ownerLocation(
    ownerID,
    destinationLocationID,
    destinationFlagID,
  );
  return itemCustody.transfer({
    items: {
      itemID: sourceItemID,
      ...(command.quantity === null || command.quantity === undefined
        ? {}
        : { quantity: command.quantity }),
    },
    from: sourceRef,
    to: destinationRef,
    reason: itemCustody.CUSTODY_REASON.INV_BROKER_MERGE,
    actor: toInt(command.actor, 0) || null,
    idempotencyKey:
      String(command.idempotencyKey || "").trim() ||
      `inv-broker-merge:${sourceItemID}:${destinationItemID}:${ownerID}:` +
        `${sourceLocationID}:${sourceFlagID}:${destinationLocationID}:` +
        `${destinationFlagID}`,
    options: { mergeIntoItemID: destinationItemID },
  });
}

module.exports = {
  mergeStacks,
  moveItem,
};
