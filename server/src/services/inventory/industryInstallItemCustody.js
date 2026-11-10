"use strict";

const path = require("node:path");

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
    quantity: toPositiveInt(command.quantity, 0),
    sourceLocationID: toPositiveInt(command.sourceLocationID, 0),
    sourceFlagID: toFlag(command.sourceFlagID, 0),
    destinationLocationID: toPositiveInt(command.destinationLocationID, 0),
    destinationFlagID: toFlag(command.destinationFlagID, 0),
    escrowLocationID: toPositiveInt(command.escrowLocationID, 0),
    idempotencyKey: String(command.idempotencyKey || "").trim(),
  };
}

function move(command, sourceLocationID, sourceFlagID, destinationLocationID, destinationFlagID, reason) {
  if (
    !command.actorID ||
    !command.ownerID ||
    !command.itemID ||
    !command.quantity ||
    !sourceLocationID ||
    !destinationLocationID ||
    !command.idempotencyKey
  ) {
    return { success: false, errorMsg: "INDUSTRY_INSTALL_CUSTODY_ROUTE_INVALID" };
  }
  return itemCustody.transfer({
    items: { itemID: command.itemID, quantity: command.quantity },
    from: itemCustody.custodyRef.ownerLocation(
      command.ownerID,
      sourceLocationID,
      sourceFlagID,
    ),
    to: itemCustody.custodyRef.ownerLocation(
      command.ownerID,
      destinationLocationID,
      destinationFlagID,
    ),
    reason,
    actor: command.actorID,
    idempotencyKey: command.idempotencyKey,
  });
}

function remove(
  command,
  sourceLocationID,
  sourceFlagID,
  reason,
  options = {},
) {
  if (
    !command.actorID ||
    !command.ownerID ||
    !command.itemID ||
    !command.quantity ||
    !sourceLocationID ||
    !command.idempotencyKey
  ) {
    return { success: false, errorMsg: "INDUSTRY_INSTALL_CUSTODY_ROUTE_INVALID" };
  }
  return itemCustody.transfer({
    items: { itemID: command.itemID, quantity: command.quantity },
    from: itemCustody.custodyRef.ownerLocation(
      command.ownerID,
      sourceLocationID,
      sourceFlagID,
    ),
    to: itemCustody.custodyRef.void(),
    options: { removeContents: options.removeContents !== false },
    reason,
    actor: command.actorID,
    idempotencyKey: command.idempotencyKey,
  });
}

function stageMaterial(rawCommand = {}) {
  const command = normalizeCommand(rawCommand);
  return move(
    command,
    command.sourceLocationID,
    command.sourceFlagID,
    command.escrowLocationID,
    0,
    itemCustody.CUSTODY_REASON.INDUSTRY_MATERIAL_STAGE,
  );
}

function returnMaterial(rawCommand = {}) {
  const command = normalizeCommand(rawCommand);
  return move(
    command,
    command.escrowLocationID,
    0,
    command.destinationLocationID,
    command.destinationFlagID,
    itemCustody.CUSTODY_REASON.INDUSTRY_MATERIAL_RETURN,
  );
}

function commitMaterial(rawCommand = {}) {
  const command = normalizeCommand(rawCommand);
  return remove(
    command,
    command.escrowLocationID,
    0,
    itemCustody.CUSTODY_REASON.INDUSTRY_MATERIAL_COMMIT,
  );
}

function stageBlueprint(rawCommand = {}) {
  const command = normalizeCommand(rawCommand);
  return move(
    command,
    command.sourceLocationID,
    command.sourceFlagID,
    command.escrowLocationID,
    0,
    itemCustody.CUSTODY_REASON.INDUSTRY_BLUEPRINT_STAGE,
  );
}

function returnBlueprint(rawCommand = {}) {
  const command = normalizeCommand(rawCommand);
  return move(
    command,
    command.sourceLocationID || command.escrowLocationID,
    command.sourceFlagID,
    command.destinationLocationID,
    command.destinationFlagID,
    itemCustody.CUSTODY_REASON.INDUSTRY_BLUEPRINT_RETURN,
  );
}

function consumeBlueprint(rawCommand = {}) {
  const command = normalizeCommand(rawCommand);
  return remove(
    command,
    command.sourceLocationID || command.escrowLocationID,
    command.sourceFlagID,
    itemCustody.CUSTODY_REASON.INDUSTRY_BLUEPRINT_CONSUME,
    { removeContents: false },
  );
}

function installBlueprint(rawCommand = {}) {
  const command = normalizeCommand(rawCommand);
  return move(
    command,
    command.escrowLocationID,
    0,
    command.destinationLocationID,
    command.destinationFlagID,
    itemCustody.CUSTODY_REASON.INDUSTRY_BLUEPRINT_INSTALL,
  );
}

module.exports = {
  commitMaterial,
  consumeBlueprint,
  installBlueprint,
  returnBlueprint,
  returnMaterial,
  stageBlueprint,
  stageMaterial,
};
