"use strict";

const crypto = require("crypto");
const path = require("path");

const itemCustody = require(path.join(__dirname, "./itemCustody"));
const itemStore = require(path.join(__dirname, "./itemStore"));

function toPositiveInt(value, fallback = 0) {
  const numeric = Math.trunc(Number(value) || 0);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : fallback;
}

function operationToken(value) {
  return crypto
    .createHash("sha256")
    .update(String(value || "death-outcome"), "utf8")
    .digest("hex")
    .slice(0, 24);
}

function moveToLoot(command = {}) {
  const item = command.item && typeof command.item === "object"
    ? command.item
    : null;
  const itemID = toPositiveInt(item && item.itemID, 0);
  const ownerID = toPositiveInt(item && item.ownerID, 0);
  const sourceLocationID = toPositiveInt(item && item.locationID, 0);
  const sourceFlagID = Math.trunc(Number(item && item.flagID));
  const lootLocationID = toPositiveInt(command.lootLocationID, 0);
  const quantity = toPositiveInt(command.quantity, 0);
  if (
    !itemID ||
    !ownerID ||
    !sourceLocationID ||
    !Number.isInteger(sourceFlagID) ||
    sourceFlagID < 0 ||
    !lootLocationID ||
    lootLocationID === sourceLocationID ||
    !quantity
  ) {
    return { success: false, errorMsg: "DEATH_CUSTODY_ROUTE_INVALID" };
  }
  return itemCustody.transfer({
    items: { itemID, quantity },
    from: itemCustody.custodyRef.ownerLocation(
      ownerID,
      sourceLocationID,
      sourceFlagID,
    ),
    to: itemCustody.custodyRef.container(
      ownerID,
      lootLocationID,
      itemStore.ITEM_FLAGS.HANGAR,
    ),
    reason: itemCustody.CUSTODY_REASON.DEATH_LOOT_DROP,
    actor: toPositiveInt(command.actor, ownerID),
    idempotencyKey:
      String(command.idempotencyKey || "").trim() ||
      `death:${operationToken(command.operationID)}:drop:${itemID}:${quantity}:` +
        `${sourceLocationID}:${sourceFlagID}:${lootLocationID}`,
  });
}

function destroyItem(command = {}) {
  const item = command.item && typeof command.item === "object"
    ? command.item
    : null;
  const itemID = toPositiveInt(item && item.itemID, 0);
  const ownerID = toPositiveInt(item && item.ownerID, 0);
  const locationID = toPositiveInt(item && item.locationID, 0);
  const flagID = Math.trunc(Number(item && item.flagID));
  if (
    !itemID ||
    !ownerID ||
    !locationID ||
    !Number.isInteger(flagID) ||
    flagID < 0
  ) {
    return { success: false, errorMsg: "DEATH_CUSTODY_ROUTE_INVALID" };
  }
  return itemCustody.transfer({
    items: { itemID },
    from: itemCustody.custodyRef.ownerLocation(ownerID, locationID, flagID),
    to: itemCustody.custodyRef.void(),
    options: { removeContents: command.removeContents === true },
    reason: itemCustody.CUSTODY_REASON.DEATH_ITEM_DESTROY,
    actor: toPositiveInt(command.actor, ownerID),
    idempotencyKey:
      String(command.idempotencyKey || "").trim() ||
      `death:${operationToken(command.operationID)}:destroy:${itemID}:` +
        `${ownerID}:${locationID}:${flagID}`,
  });
}

module.exports = {
  destroyItem,
  moveToLoot,
};
