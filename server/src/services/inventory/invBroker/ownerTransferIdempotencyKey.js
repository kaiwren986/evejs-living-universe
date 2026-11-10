"use strict";

// Idempotency keys for the inventory broker's cross-owner hand-offs, shared by its item
// moves and corporation delivery. One counter per process.

const crypto = require("crypto");
const path = require("path");

const itemCustody = require(path.join(__dirname, "../itemCustody"));

// A cross-owner hand-off writes a durable custody receipt that is consulted for
// the lifetime of the database, so the key it is filed under has to name the
// operation, not the item state the operation happened to start from. Dragging
// an item into a corp hangar and back restores those coordinates exactly, and a
// state-derived key would make every later hand-off replay the first one's
// receipt: success reported, nothing moved, and the move refused outright to any
// other character because the receipt fingerprint names the first actor. The
// broker never retries a hand-off — a failed call is reported to the client and
// the player drags again, which is a new operation — so a fresh identity per
// call is exactly the right grain. The random boot segment keeps two processes
// (and a restarted one) from ever reusing a counter value.
const OWNER_TRANSFER_BOOT_INSTANCE_ID = crypto
  .randomBytes(12)
  .toString("base64url");
let nextOwnerTransferOperationID = 1;

function buildOwnerTransferIdempotencyKey() {
  const operationID = nextOwnerTransferOperationID;
  nextOwnerTransferOperationID += 1;
  return (
    `${itemCustody.CUSTODY_REASON.INV_BROKER_OWNER_TRANSFER}:` +
    `${OWNER_TRANSFER_BOOT_INSTANCE_ID}:${operationID}`
  );
}

module.exports = {
  buildOwnerTransferIdempotencyKey,
};
