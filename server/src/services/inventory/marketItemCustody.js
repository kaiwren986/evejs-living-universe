"use strict";

const path = require("path");

const itemCustody = require(path.join(__dirname, "./itemCustody"));

const MARKET_ESCROW_LOCATION_BASE = 9_200_000_000;
// Virtual escrow locations are allocated in 100-million-wide slots, and the slot
// after this one belongs to contract escrow (9_300_000_000). Anything at or past
// this limit is somebody else's escrow, so a market-side range scan must stop
// here.
const MARKET_ESCROW_LOCATION_LIMIT = MARKET_ESCROW_LOCATION_BASE + 100_000_000;
const MARKET_SEED_FILL_ESCROW_LOCATION_BASE = 10_200_000_000;
const MARKET_SEED_FILL_ESCROW_LOCATION_LIMIT =
  MARKET_SEED_FILL_ESCROW_LOCATION_BASE + 100_000_000;
// Every subsystem that parks items outside a real hangar takes its own
// 100-million-wide slot in one shared virtual-location band: market 9.2B,
// contract 9.3B, reprocessing 9.4B, mission rewards 9.5B, planetary customs
// 9.6B, industry 9.7B and jump-bridge fuel 9.8B. No character can hold goods
// anywhere in that band, so nothing in it is ever the seller side of a sell
// escrow placement - not another market order's escrow, and not a neighbouring
// subsystem's either.
const VIRTUAL_ESCROW_LOCATION_BASE = MARKET_ESCROW_LOCATION_BASE;
const VIRTUAL_ESCROW_LOCATION_LIMIT = 9_900_000_000;
const MARKET_REASONS = new Set([
  itemCustody.CUSTODY_REASON.MARKET_ESCROW_PLACE,
  itemCustody.CUSTODY_REASON.MARKET_ESCROW_DELIVER,
  itemCustody.CUSTODY_REASON.MARKET_DIRECT_DELIVER,
  itemCustody.CUSTODY_REASON.MARKET_FILL_COMPENSATE,
  itemCustody.CUSTODY_REASON.MARKET_ESCROW_RETURN,
  itemCustody.CUSTODY_REASON.MARKET_SEED_RESERVE,
  itemCustody.CUSTODY_REASON.MARKET_SEED_RELEASE,
]);

function toPositiveInt(value, fallback = 0) {
  const numeric = Math.trunc(Number(value) || 0);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : fallback;
}

function getEscrowLocationID(orderID) {
  const numericOrderID = toPositiveInt(orderID, 0);
  return numericOrderID > 0
    ? MARKET_ESCROW_LOCATION_BASE + numericOrderID
    : 0;
}

function isVirtualEscrowLocationID(locationID) {
  const numericLocationID = toPositiveInt(locationID, 0);
  return (
    (numericLocationID >= VIRTUAL_ESCROW_LOCATION_BASE &&
      numericLocationID < VIRTUAL_ESCROW_LOCATION_LIMIT) ||
    (numericLocationID >= MARKET_SEED_FILL_ESCROW_LOCATION_BASE &&
      numericLocationID < MARKET_SEED_FILL_ESCROW_LOCATION_LIMIT)
  );
}

function getSeedFillEscrowLocationID(sagaID) {
  const numericSagaID = toPositiveInt(sagaID, 0);
  return numericSagaID > 0
    ? MARKET_SEED_FILL_ESCROW_LOCATION_BASE + numericSagaID
    : 0;
}

function quantityOf(item) {
  return Number(item && item.singleton) === 1
    ? 1
    : toPositiveInt(item && (item.stacksize || item.quantity), 1);
}

function grantSeedItem(command = {}) {
  const ownerID = toPositiveInt(command.ownerID, 0);
  const locationID = toPositiveInt(command.locationID, 0);
  const flagID = Math.trunc(Number(command.flagID));
  const typeID = toPositiveInt(command.typeID, 0);
  const quantity = toPositiveInt(command.quantity, 0);
  if (!ownerID || !locationID || !Number.isInteger(flagID) || flagID < 0 || !typeID || !quantity) {
    return { success: false, errorMsg: "MARKET_CUSTODY_ROUTE_INVALID" };
  }

  return itemCustody.transfer({
    items: {
      typeID,
      quantity,
      options: command.options && typeof command.options === "object"
        ? command.options
        : {},
    },
    to: itemCustody.custodyRef.ownerLocation(ownerID, locationID, flagID),
    reason: itemCustody.CUSTODY_REASON.MARKET_SEED_DELIVER,
    actor: toPositiveInt(command.actor, ownerID),
    idempotencyKey:
      String(command.idempotencyKey || "").trim() ||
      `market:seed-deliver:${ownerID}:${locationID}:${flagID}:${typeID}:${quantity}`,
  });
}

function consumeSeedItem(command = {}) {
  const item = command.item && typeof command.item === "object"
    ? command.item
    : null;
  const itemID = toPositiveInt(item && item.itemID, 0);
  const ownerID = toPositiveInt(item && item.ownerID, 0);
  const locationID = toPositiveInt(item && item.locationID, 0);
  const flagID = Math.trunc(Number(item && item.flagID));
  const quantity = toPositiveInt(command.quantity, 0);
  if (!itemID || !ownerID || !locationID || !Number.isInteger(flagID) || flagID < 0 || !quantity) {
    return { success: false, errorMsg: "MARKET_CUSTODY_ROUTE_INVALID" };
  }

  return itemCustody.transfer({
    items: { itemID, quantity },
    from: itemCustody.custodyRef.ownerLocation(ownerID, locationID, flagID),
    to: itemCustody.custodyRef.void(),
    reason: itemCustody.CUSTODY_REASON.MARKET_SEED_CONSUME,
    actor: toPositiveInt(command.actor, ownerID),
    idempotencyKey:
      String(command.idempotencyKey || "").trim() ||
      `market:seed-consume:${itemID}:${ownerID}:${locationID}:${flagID}:` +
        `available:${quantityOf(item)}:consume:${quantity}`,
  });
}

function transferSeedReservation(command = {}, release = false) {
  const item = command.item && typeof command.item === "object"
    ? command.item
    : null;
  const itemID = toPositiveInt(item && item.itemID, 0);
  const ownerID = toPositiveInt(item && item.ownerID, 0);
  const sourceLocationID = toPositiveInt(item && item.locationID, 0);
  const sourceFlagID = Math.trunc(Number(item && item.flagID));
  const destinationLocationID = release
    ? toPositiveInt(command.locationID, 0)
    : getSeedFillEscrowLocationID(command.sagaID);
  const destinationFlagID = release
    ? Math.trunc(Number(command.flagID))
    : sourceFlagID;
  const seedEscrowLocationID = getSeedFillEscrowLocationID(command.sagaID);
  const quantity = command.quantity === null || command.quantity === undefined
    ? null
    : toPositiveInt(command.quantity, 0);
  if (
    !itemID ||
    !ownerID ||
    !sourceLocationID ||
    !Number.isInteger(sourceFlagID) ||
    sourceFlagID < 0 ||
    !destinationLocationID ||
    !Number.isInteger(destinationFlagID) ||
    destinationFlagID < 0 ||
    !seedEscrowLocationID ||
    (release
      ? sourceLocationID !== seedEscrowLocationID
      : destinationLocationID !== seedEscrowLocationID)
  ) {
    return { success: false, errorMsg: "MARKET_CUSTODY_ROUTE_INVALID" };
  }

  return itemCustody.transfer({
    items: {
      itemID,
      ...(quantity === null ? {} : { quantity }),
    },
    from: itemCustody.custodyRef.ownerLocation(
      ownerID,
      sourceLocationID,
      sourceFlagID,
    ),
    to: itemCustody.custodyRef.ownerLocation(
      ownerID,
      destinationLocationID,
      destinationFlagID,
    ),
    reason: release
      ? itemCustody.CUSTODY_REASON.MARKET_SEED_RELEASE
      : itemCustody.CUSTODY_REASON.MARKET_SEED_RESERVE,
    actor: toPositiveInt(command.actor, ownerID),
    idempotencyKey: String(command.idempotencyKey || "").trim() ||
      `market:seed-${release ? "release" : "reserve"}:${toPositiveInt(command.sagaID, 0)}:` +
        `${itemID}:available:${quantityOf(item)}:move:${quantity === null ? "whole" : quantity}:` +
        `${sourceLocationID}:${sourceFlagID}:${destinationLocationID}:${destinationFlagID}`,
  });
}

function reserveSeedItem(command = {}) {
  return transferSeedReservation(command, false);
}

function releaseSeedItem(command = {}) {
  return transferSeedReservation(command, true);
}

function transferItem(command = {}) {
  const item = command.item && typeof command.item === "object"
    ? command.item
    : null;
  const itemID = toPositiveInt(item && item.itemID, 0);
  const currentOwnerID = toPositiveInt(item && item.ownerID, 0);
  const currentLocationID = toPositiveInt(item && item.locationID, 0);
  const currentFlagID = Math.trunc(Number(item && item.flagID));
  // Where the caller agreed to take the goods from, as opposed to where the
  // item row happens to sit right now. Sell placement validates the seller's
  // hangar many awaits before it moves anything, so deriving the custody source
  // from the row makes itemCustody's source check compare the item against
  // itself and pass unconditionally - which is exactly how a second concurrent
  // sell used to relocate a stack straight out of the first order's escrow.
  // With a pin, a stack that moved after validation fails the transfer.
  const expectedSource =
    command.expectedSource && typeof command.expectedSource === "object"
      ? command.expectedSource
      : null;
  const sourceOwnerID = expectedSource
    ? toPositiveInt(expectedSource.ownerID, currentOwnerID)
    : currentOwnerID;
  const sourceLocationID = expectedSource
    ? toPositiveInt(expectedSource.locationID, 0)
    : currentLocationID;
  const sourceFlagID = expectedSource
    ? Math.trunc(Number(expectedSource.flagID))
    : currentFlagID;
  const destinationOwnerID = toPositiveInt(command.ownerID, sourceOwnerID);
  const destinationLocationID = toPositiveInt(command.locationID, 0);
  const destinationFlagID = Math.trunc(Number(command.flagID));
  const orderID = toPositiveInt(command.orderID, 0);
  const escrowLocationID = getEscrowLocationID(orderID);
  const reason = String(command.reason || "");
  const requestedQuantity = command.quantity === null || command.quantity === undefined
    ? null
    : toPositiveInt(command.quantity, 0);
  const isEscrowSource = sourceLocationID === escrowLocationID;
  const isEscrowDestination = destinationLocationID === escrowLocationID;
  // A stack already parked in somebody's escrow is spoken for and cannot back a
  // second order. Its own escrow location is the one exception: arriving there
  // is what this command does, so seeing it there is an idempotent replay.
  const isHeldInForeignEscrow =
    isVirtualEscrowLocationID(currentLocationID) &&
    currentLocationID !== escrowLocationID;
  const routeMatches =
    (reason === itemCustody.CUSTODY_REASON.MARKET_ESCROW_PLACE &&
      isEscrowDestination &&
      // Fail closed: without a pin there is nothing to check the item against,
      // so an unpinned placement is a route error rather than a free pass.
      Boolean(expectedSource) &&
      !isVirtualEscrowLocationID(sourceLocationID) &&
      !isHeldInForeignEscrow) ||
    (reason === itemCustody.CUSTODY_REASON.MARKET_ESCROW_DELIVER && isEscrowSource) ||
    (reason === itemCustody.CUSTODY_REASON.MARKET_DIRECT_DELIVER && !orderID) ||
    (reason === itemCustody.CUSTODY_REASON.MARKET_FILL_COMPENSATE &&
      (isEscrowDestination || !orderID)) ||
    (reason === itemCustody.CUSTODY_REASON.MARKET_ESCROW_RETURN && isEscrowSource);

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
    !MARKET_REASONS.has(reason) ||
    !routeMatches
  ) {
    return { success: false, errorMsg: "MARKET_CUSTODY_ROUTE_INVALID" };
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
      `market:${reason}:${orderID || "immediate"}:${itemID}:` +
        `available:${quantityOf(item)}:` +
        `move:${requestedQuantity === null ? "whole" : requestedQuantity}:` +
        `${sourceOwnerID}:${sourceLocationID}:${sourceFlagID}:` +
        `${destinationOwnerID}:${destinationLocationID}:${destinationFlagID}`,
  });
}

module.exports = {
  MARKET_ESCROW_LOCATION_BASE,
  MARKET_ESCROW_LOCATION_LIMIT,
  MARKET_SEED_FILL_ESCROW_LOCATION_BASE,
  consumeSeedItem,
  getEscrowLocationID,
  getSeedFillEscrowLocationID,
  grantSeedItem,
  releaseSeedItem,
  reserveSeedItem,
  transferItem,
};
