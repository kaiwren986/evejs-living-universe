"use strict";

// Datacores bought from an R&D agent are minted into the buyer's hangar at the
// station they are talking to the agent in. Same shape as the LP store grant, which
// is the closest existing analogue: spend a non-ISK currency plus ISK, receive items.

const path = require("path");

const itemCustody = require(path.join(__dirname, "./itemCustody"));
const itemStore = require(path.join(__dirname, "./itemStore"));

function toPositiveInt(value, fallback = 0) {
  const numeric = Math.trunc(Number(value) || 0);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : fallback;
}

function normalizeCommand(command = {}) {
  return {
    characterID: toPositiveInt(command.characterID, 0),
    locationID: toPositiveInt(command.locationID, 0),
    typeID: toPositiveInt(command.typeID, 0),
    quantity: toPositiveInt(command.quantity, 0),
    idempotencyKey: String(command.idempotencyKey || "").trim(),
  };
}

function grantDatacores(command = {}) {
  const normalized = normalizeCommand(command);
  if (
    !normalized.characterID ||
    !normalized.locationID ||
    !normalized.typeID ||
    !normalized.quantity ||
    !normalized.idempotencyKey
  ) {
    return { success: false, errorMsg: "RESEARCH_DATACORE_CUSTODY_ROUTE_INVALID" };
  }

  return itemCustody.transfer({
    items: {
      typeID: normalized.typeID,
      quantity: normalized.quantity,
      options: { singleton: 0 },
    },
    to: itemCustody.custodyRef.ownerLocation(
      normalized.characterID,
      normalized.locationID,
      itemStore.ITEM_FLAGS.HANGAR,
    ),
    reason: itemCustody.CUSTODY_REASON.RESEARCH_DATACORE_GRANT,
    actor: normalized.characterID,
    idempotencyKey: normalized.idempotencyKey,
  });
}

module.exports = {
  grantDatacores,
};
