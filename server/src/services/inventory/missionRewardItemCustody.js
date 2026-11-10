"use strict";

const path = require("path");

const itemCustody = require(path.join(__dirname, "./itemCustody"));

function toPositiveInt(value, fallback = 0) {
  const numeric = Math.trunc(Number(value) || 0);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : fallback;
}

function toFlag(value, fallback = 0) {
  const numeric = Math.trunc(Number(value));
  return Number.isInteger(numeric) && numeric >= 0 ? numeric : fallback;
}

function normalizeCommand(command = {}) {
  return {
    actorID: toPositiveInt(command.actorID, 0),
    ownerID: toPositiveInt(command.ownerID, 0),
    itemID: toPositiveInt(command.itemID, 0),
    typeID: toPositiveInt(command.typeID, 0),
    quantity: toPositiveInt(command.quantity, 0),
    blueprintRuns: toPositiveInt(command.blueprintRuns, 0),
    original: command.original === true,
    sourceLocationID: toPositiveInt(command.sourceLocationID, 0),
    sourceFlagID: toFlag(command.sourceFlagID, 0),
    destinationLocationID: toPositiveInt(command.destinationLocationID, 0),
    destinationFlagID: toFlag(command.destinationFlagID, 0),
    escrowLocationID: toPositiveInt(command.escrowLocationID, 0),
    idempotencyKey: String(command.idempotencyKey || "").trim(),
  };
}

function validMove(command, sourceLocationID, destinationLocationID) {
  return Boolean(
    command.actorID &&
      command.ownerID &&
      command.itemID &&
      command.quantity &&
      sourceLocationID &&
      destinationLocationID &&
      command.idempotencyKey
  );
}

function move(command, source, destination, reason) {
  return itemCustody.transfer({
    items: { itemID: command.itemID, quantity: command.quantity },
    from: source,
    to: destination,
    reason,
    actor: command.actorID,
    idempotencyKey: command.idempotencyKey,
  });
}

function stageCargo(rawCommand = {}) {
  const command = normalizeCommand(rawCommand);
  if (!validMove(command, command.sourceLocationID, command.escrowLocationID)) {
    return { success: false, errorMsg: "MISSION_CUSTODY_ROUTE_INVALID" };
  }
  return move(
    command,
    itemCustody.custodyRef.ownerLocation(
      command.ownerID,
      command.sourceLocationID,
      command.sourceFlagID,
    ),
    itemCustody.custodyRef.ownerLocation(
      command.ownerID,
      command.escrowLocationID,
      0,
    ),
    itemCustody.CUSTODY_REASON.MISSION_CARGO_STAGE,
  );
}

function returnCargo(rawCommand = {}) {
  const command = normalizeCommand(rawCommand);
  if (!validMove(command, command.escrowLocationID, command.destinationLocationID)) {
    return { success: false, errorMsg: "MISSION_CUSTODY_ROUTE_INVALID" };
  }
  return move(
    command,
    itemCustody.custodyRef.ownerLocation(
      command.ownerID,
      command.escrowLocationID,
      0,
    ),
    itemCustody.custodyRef.ownerLocation(
      command.ownerID,
      command.destinationLocationID,
      command.destinationFlagID,
    ),
    itemCustody.CUSTODY_REASON.MISSION_CARGO_RETURN,
  );
}

function removeFromEscrow(rawCommand, reason) {
  const command = normalizeCommand(rawCommand);
  if (
    !command.actorID ||
    !command.ownerID ||
    !command.itemID ||
    !command.quantity ||
    !command.escrowLocationID ||
    !command.idempotencyKey
  ) {
    return { success: false, errorMsg: "MISSION_CUSTODY_ROUTE_INVALID" };
  }
  return itemCustody.transfer({
    items: { itemID: command.itemID, quantity: command.quantity },
    from: itemCustody.custodyRef.ownerLocation(
      command.ownerID,
      command.escrowLocationID,
      0,
    ),
    to: itemCustody.custodyRef.void(),
    options: { removeContents: true },
    reason,
    actor: command.actorID,
    idempotencyKey: command.idempotencyKey,
  });
}

function commitCargo(command = {}) {
  return removeFromEscrow(command, itemCustody.CUSTODY_REASON.MISSION_CARGO_COMMIT);
}

function grantReward(rawCommand = {}) {
  const command = normalizeCommand(rawCommand);
  if (
    !command.actorID ||
    !command.ownerID ||
    !command.typeID ||
    !command.quantity ||
    !command.escrowLocationID ||
    !command.idempotencyKey
  ) {
    return { success: false, errorMsg: "MISSION_CUSTODY_ROUTE_INVALID" };
  }
  return itemCustody.transfer({
    items: {
      typeID: command.typeID,
      quantity: command.quantity,
      options: { singleton: command.blueprintRuns > 0 ? 2 : command.original ? 1 : 0 },
    },
    to: itemCustody.custodyRef.ownerLocation(
      command.ownerID,
      command.escrowLocationID,
      0,
    ),
    reason: itemCustody.CUSTODY_REASON.MISSION_REWARD_GRANT,
    actor: command.actorID,
    idempotencyKey: command.idempotencyKey,
  });
}

function deliverReward(rawCommand = {}) {
  const command = normalizeCommand(rawCommand);
  if (!validMove(command, command.escrowLocationID, command.destinationLocationID)) {
    return { success: false, errorMsg: "MISSION_CUSTODY_ROUTE_INVALID" };
  }
  return move(
    command,
    itemCustody.custodyRef.ownerLocation(
      command.ownerID,
      command.escrowLocationID,
      0,
    ),
    itemCustody.custodyRef.ownerLocation(
      command.ownerID,
      command.destinationLocationID,
      command.destinationFlagID,
    ),
    itemCustody.CUSTODY_REASON.MISSION_REWARD_DELIVER,
  );
}

function revokeReward(command = {}) {
  return removeFromEscrow(command, itemCustody.CUSTODY_REASON.MISSION_REWARD_REVOKE);
}

module.exports = {
  commitCargo,
  deliverReward,
  grantReward,
  returnCargo,
  revokeReward,
  stageCargo,
};
