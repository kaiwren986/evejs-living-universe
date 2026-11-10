"use strict";

const path = require("path");

const itemCustody = require(path.join(__dirname, "./itemCustody"));

const TRADE_REASONS = new Set([
  itemCustody.CUSTODY_REASON.TRADE_STAGE,
  itemCustody.CUSTODY_REASON.TRADE_ABORT,
  itemCustody.CUSTODY_REASON.TRADE_COMPLETE,
  itemCustody.CUSTODY_REASON.TRADE_COMPLETE_CONTENT,
  itemCustody.CUSTODY_REASON.TRADE_COMPENSATE,
]);

function toPositiveInt(value, fallback = 0) {
  const numeric = Math.trunc(Number(value) || 0);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : fallback;
}

function quantityOf(item) {
  return Number(item && item.singleton) === 1
    ? 1
    : toPositiveInt(item && (item.stacksize || item.quantity), 1);
}

function transferItem(command = {}) {
  const item = command.item && typeof command.item === "object"
    ? command.item
    : null;
  const itemID = toPositiveInt(item && item.itemID, 0);
  const sourceOwnerID = toPositiveInt(item && item.ownerID, 0);
  const sourceLocationID = toPositiveInt(item && item.locationID, 0);
  const sourceFlagID = Math.trunc(Number(item && item.flagID));
  const destinationOwnerID = toPositiveInt(command.ownerID, sourceOwnerID);
  const destinationLocationID = toPositiveInt(command.locationID, 0);
  const destinationFlagID = Math.trunc(Number(command.flagID));
  const tradeContainerID = toPositiveInt(command.tradeContainerID, 0);
  const reason = String(command.reason || "");
  const requestedQuantity = command.quantity === null || command.quantity === undefined
    ? null
    : toPositiveInt(command.quantity, 0);
  const routeMatches =
    (
      reason === itemCustody.CUSTODY_REASON.TRADE_STAGE &&
      destinationLocationID === tradeContainerID &&
      sourceLocationID !== tradeContainerID &&
      destinationFlagID === 4 &&
      destinationOwnerID === toPositiveInt(command.actor, 0)
    ) ||
    (
      reason === itemCustody.CUSTODY_REASON.TRADE_ABORT &&
      sourceLocationID === tradeContainerID &&
      destinationOwnerID === sourceOwnerID
    ) ||
    (
      reason === itemCustody.CUSTODY_REASON.TRADE_COMPLETE &&
      sourceLocationID === tradeContainerID &&
      destinationOwnerID !== sourceOwnerID
    ) ||
    (
      reason === itemCustody.CUSTODY_REASON.TRADE_COMPLETE_CONTENT &&
      sourceLocationID !== tradeContainerID &&
      destinationLocationID === sourceLocationID &&
      destinationFlagID === sourceFlagID &&
      destinationOwnerID !== sourceOwnerID
    ) ||
    reason === itemCustody.CUSTODY_REASON.TRADE_COMPENSATE;

  if (
    !itemID ||
    !sourceOwnerID ||
    !sourceLocationID ||
    !Number.isInteger(sourceFlagID) ||
    sourceFlagID < 0 ||
    !destinationOwnerID ||
    !destinationLocationID ||
    !Number.isInteger(destinationFlagID) ||
    destinationFlagID < 0 ||
    !tradeContainerID ||
    !TRADE_REASONS.has(reason) ||
    !routeMatches
  ) {
    return { success: false, errorMsg: "TRADE_CUSTODY_ROUTE_INVALID" };
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
    actor: toPositiveInt(command.actor, 0) || null,
    idempotencyKey:
      String(command.idempotencyKey || "").trim() ||
      `trade:${tradeContainerID}:${reason}:${itemID}:` +
        `available:${quantityOf(item)}:` +
        `move:${requestedQuantity === null ? "whole" : requestedQuantity}:` +
        `${sourceOwnerID}:${sourceLocationID}:${sourceFlagID}:` +
        `${destinationOwnerID}:${destinationLocationID}:${destinationFlagID}`,
  });
}

module.exports = {
  transferItem,
};
