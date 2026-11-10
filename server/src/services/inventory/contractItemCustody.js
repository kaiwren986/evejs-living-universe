"use strict";

const path = require("path");

const itemCustody = require(path.join(__dirname, "./itemCustody"));

const CONTRACT_ESCROW_LOCATION_BASE = 9_300_000_000;
const CONTRACT_ESCROW_OWNER_ID = 1;

const MOVE_REASONS = new Set([
  itemCustody.CUSTODY_REASON.CONTRACT_ESCROW_STAGE,
  itemCustody.CUSTODY_REASON.CONTRACT_REQUEST_DELIVER,
  itemCustody.CUSTODY_REASON.CONTRACT_ESCROW_DELIVER,
  itemCustody.CUSTODY_REASON.CONTRACT_ESCROW_RETURN,
  itemCustody.CUSTODY_REASON.CONTRACT_COURIER_ACCEPT,
  itemCustody.CUSTODY_REASON.CONTRACT_CONTENT_DELIVER,
  itemCustody.CUSTODY_REASON.CONTRACT_CONTENT_OWNER_TRANSFER,
]);

function toPositiveInt(value, fallback = 0) {
  const numeric = Math.trunc(Number(value) || 0);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : fallback;
}

function quantityOf(item) {
  if (Number(item && item.singleton) === 1) {
    return 1;
  }
  return toPositiveInt(item && (item.stacksize || item.quantity), 1);
}

function getContractEscrowLocationID(contractID) {
  const normalizedContractID = toPositiveInt(contractID, 0);
  return normalizedContractID
    ? CONTRACT_ESCROW_LOCATION_BASE + normalizedContractID
    : 0;
}

function refFor(contractID, ownerID, locationID, flagID) {
  const escrowLocationID = getContractEscrowLocationID(contractID);
  if (
    ownerID === CONTRACT_ESCROW_OWNER_ID &&
    locationID === escrowLocationID &&
    flagID === 0
  ) {
    return itemCustody.custodyRef.contractEscrow(contractID);
  }
  return itemCustody.custodyRef.ownerLocation(ownerID, locationID, flagID);
}

function transferItem(command = {}) {
  const item = command.item && typeof command.item === "object"
    ? command.item
    : null;
  const contractID = toPositiveInt(command.contractID, 0);
  const itemID = toPositiveInt(item && item.itemID, 0);
  const sourceOwnerID = toPositiveInt(item && item.ownerID, 0);
  const sourceLocationID = toPositiveInt(item && item.locationID, 0);
  const sourceFlagID = Math.trunc(Number(item && item.flagID));
  const destinationOwnerID = toPositiveInt(command.ownerID, 0);
  const destinationLocationID = toPositiveInt(command.locationID, 0);
  const destinationFlagID = Math.trunc(Number(command.flagID));
  const escrowLocationID = getContractEscrowLocationID(contractID);
  const reason = String(command.reason || "");
  const sourceIsEscrow =
    sourceOwnerID === CONTRACT_ESCROW_OWNER_ID &&
    sourceLocationID === escrowLocationID &&
    sourceFlagID === 0;
  const destinationIsEscrow =
    destinationOwnerID === CONTRACT_ESCROW_OWNER_ID &&
    destinationLocationID === escrowLocationID &&
    destinationFlagID === 0;
  const routeMatches =
    (reason === itemCustody.CUSTODY_REASON.CONTRACT_ESCROW_STAGE && destinationIsEscrow) ||
    ([
      itemCustody.CUSTODY_REASON.CONTRACT_ESCROW_DELIVER,
      itemCustody.CUSTODY_REASON.CONTRACT_ESCROW_RETURN,
      itemCustody.CUSTODY_REASON.CONTRACT_CONTENT_DELIVER,
    ].includes(reason) && sourceIsEscrow) ||
    (reason === itemCustody.CUSTODY_REASON.CONTRACT_COURIER_ACCEPT &&
      sourceLocationID === escrowLocationID && !sourceIsEscrow) ||
    (reason === itemCustody.CUSTODY_REASON.CONTRACT_REQUEST_DELIVER &&
      !sourceIsEscrow && !destinationIsEscrow) ||
    (reason === itemCustody.CUSTODY_REASON.CONTRACT_CONTENT_OWNER_TRANSFER &&
      sourceOwnerID !== destinationOwnerID &&
      sourceLocationID === destinationLocationID &&
      sourceFlagID === destinationFlagID);

  if (
    !contractID ||
    !itemID ||
    !sourceOwnerID ||
    !sourceLocationID ||
    !Number.isInteger(sourceFlagID) ||
    sourceFlagID < 0 ||
    !destinationOwnerID ||
    !destinationLocationID ||
    !Number.isInteger(destinationFlagID) ||
    destinationFlagID < 0 ||
    !MOVE_REASONS.has(reason) ||
    !routeMatches
  ) {
    return { success: false, errorMsg: "CONTRACT_CUSTODY_ROUTE_INVALID" };
  }

  const requestedQuantity = command.quantity === null || command.quantity === undefined
    ? null
    : toPositiveInt(command.quantity, 0);
  if (command.quantity !== null && command.quantity !== undefined && !requestedQuantity) {
    return { success: false, errorMsg: "CONTRACT_CUSTODY_ROUTE_INVALID" };
  }

  return itemCustody.transfer({
    items: {
      itemID,
      ...(requestedQuantity === null ? {} : { quantity: requestedQuantity }),
    },
    from: refFor(
      contractID,
      sourceOwnerID,
      sourceLocationID,
      sourceFlagID,
    ),
    to: refFor(
      contractID,
      destinationOwnerID,
      destinationLocationID,
      destinationFlagID,
    ),
    reason,
    actor: toPositiveInt(command.actor, 0) || null,
    idempotencyKey:
      String(command.idempotencyKey || "").trim() ||
      `contract:${contractID}:${reason}:${itemID}:available:${quantityOf(item)}:` +
        `move:${requestedQuantity === null ? "whole" : requestedQuantity}:` +
        `${sourceOwnerID}:${sourceLocationID}:${sourceFlagID}:` +
        `${destinationOwnerID}:${destinationLocationID}:${destinationFlagID}`,
  });
}

function createPlasticWrap(command = {}) {
  const contractID = toPositiveInt(command.contractID, 0);
  const ownerID = toPositiveInt(command.ownerID, 0);
  const typeID = toPositiveInt(command.typeID, 0);
  const locationID = getContractEscrowLocationID(contractID);
  if (!contractID || !ownerID || !typeID || !locationID) {
    return { success: false, errorMsg: "CONTRACT_CUSTODY_ROUTE_INVALID" };
  }
  return itemCustody.transfer({
    items: {
      typeID,
      quantity: 1,
      options: {
        singleton: 1,
        ...(command.plasticWrapVolume === undefined
          ? {}
          : { plasticWrapVolume: command.plasticWrapVolume }),
      },
    },
    to: itemCustody.custodyRef.ownerLocation(
      ownerID,
      locationID,
      command.flagID,
    ),
    reason: itemCustody.CUSTODY_REASON.CONTRACT_WRAP_CREATE,
    actor: toPositiveInt(command.actor, ownerID),
    idempotencyKey:
      String(command.idempotencyKey || "").trim() ||
      `contract:${contractID}:wrap:create:${ownerID}:${typeID}`,
  });
}

function removePlasticWrap(command = {}) {
  const item = command.item && typeof command.item === "object"
    ? command.item
    : null;
  const contractID = toPositiveInt(command.contractID, 0);
  const itemID = toPositiveInt(item && item.itemID, 0);
  const ownerID = toPositiveInt(item && item.ownerID, 0);
  const locationID = toPositiveInt(item && item.locationID, 0);
  const flagID = Math.trunc(Number(item && item.flagID));
  if (
    !contractID ||
    !itemID ||
    !ownerID ||
    (
      locationID !== getContractEscrowLocationID(contractID) &&
      locationID !== toPositiveInt(command.expectedLocationID, 0)
    ) ||
    !Number.isInteger(flagID) ||
    flagID < 0
  ) {
    return { success: false, errorMsg: "CONTRACT_CUSTODY_ROUTE_INVALID" };
  }
  return itemCustody.transfer({
    items: { itemID },
    from: itemCustody.custodyRef.ownerLocation(ownerID, locationID, flagID),
    to: itemCustody.custodyRef.void(),
    options: { removeContents: false },
    reason: itemCustody.CUSTODY_REASON.CONTRACT_WRAP_REMOVE,
    actor: toPositiveInt(command.actor, 0) || null,
    idempotencyKey:
      String(command.idempotencyKey || "").trim() ||
      `contract:${contractID}:wrap:remove:${itemID}:${ownerID}:${locationID}:${flagID}`,
  });
}

module.exports = {
  CONTRACT_ESCROW_LOCATION_BASE,
  CONTRACT_ESCROW_OWNER_ID,
  createPlasticWrap,
  getContractEscrowLocationID,
  removePlasticWrap,
  transferItem,
};
