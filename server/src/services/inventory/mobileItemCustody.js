"use strict";

const path = require("path");

const itemCustody = require(path.join(__dirname, "./itemCustody"));

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function deployFromShip(command = {}) {
  const reason = command.reason || itemCustody.CUSTODY_REASON.MOBILE_DEPLOY;
  if (![itemCustody.CUSTODY_REASON.MOBILE_DEPLOY, itemCustody.CUSTODY_REASON.SKYHOOK_DEPLOY].includes(reason)) {
    return { success: false, errorMsg: "MOBILE_DEPLOY_CUSTODY_REASON_INVALID" };
  }
  const item = command.item && typeof command.item === "object"
    ? command.item
    : null;
  const itemID = toInt(item && item.itemID, 0);
  const sourceOwnerID = toInt(item && item.ownerID, 0);
  const sourceLocationID = toInt(item && item.locationID, 0);
  const sourceFlagID = toInt(item && item.flagID, 0);
  const destinationOwnerID = toInt(command.ownerID, sourceOwnerID);
  const systemID = toInt(command.systemID, 0);
  if (
    itemID <= 0 ||
    sourceOwnerID <= 0 ||
    sourceLocationID <= 0 ||
    sourceFlagID <= 0 ||
    sourceLocationID !== toInt(command.shipID, 0) ||
    destinationOwnerID <= 0 ||
    systemID <= 0
  ) {
    return { success: false, errorMsg: "MOBILE_DEPLOY_CUSTODY_SOURCE_INVALID" };
  }

  return itemCustody.transfer({
    items: {
      itemID,
      quantity: command.quantity === undefined ? 1 : command.quantity,
    },
    from: itemCustody.custodyRef.shipBay(
      sourceOwnerID,
      sourceLocationID,
      sourceFlagID,
    ),
    to: itemCustody.custodyRef.inSpace(destinationOwnerID, systemID),
    reason,
    actor: toInt(command.actor, 0) || null,
    idempotencyKey:
      String(command.idempotencyKey || "").trim() ||
      `mobile-deploy:${itemID}:${sourceOwnerID}:${sourceLocationID}:` +
        `${sourceFlagID}:${destinationOwnerID}:${systemID}`,
  });
}

function restoreSpaceItem(runtime, systemID, itemID) {
  if (!runtime || typeof runtime.spawnDynamicInventoryEntity !== "function") {
    return { success: false, errorMsg: "MOBILE_SCOOP_SCENE_RESTORE_UNAVAILABLE" };
  }
  return runtime.spawnDynamicInventoryEntity(systemID, itemID);
}

function scoopToShip(command = {}) {
  const runtime = command.runtime;
  const item = command.item && typeof command.item === "object"
    ? command.item
    : null;
  const itemID = toInt(item && item.itemID, 0);
  const sourceOwnerID = toInt(item && item.ownerID, 0);
  const systemID = toInt(command.systemID, toInt(item && item.locationID, 0));
  const shipID = toInt(command.shipID, 0);
  const destinationOwnerID = toInt(command.ownerID, 0);
  const destinationFlagID = toInt(command.flagID, 0);
  if (
    !runtime ||
    typeof runtime.removeDynamicEntity !== "function" ||
    itemID <= 0 ||
    sourceOwnerID <= 0 ||
    toInt(item && item.locationID, 0) !== systemID ||
    toInt(item && item.flagID, 0) !== 0 ||
    systemID <= 0 ||
    shipID <= 0 ||
    destinationOwnerID <= 0 ||
    ![5, 183].includes(destinationFlagID)
  ) {
    return { success: false, errorMsg: "MOBILE_SCOOP_CUSTODY_SOURCE_INVALID" };
  }

  const removeResult = runtime.removeDynamicEntity(systemID, itemID, {
    persistSpaceState: false,
  });
  if (!removeResult || !removeResult.success) {
    return removeResult || { success: false, errorMsg: "DYNAMIC_ENTITY_NOT_FOUND" };
  }

  const custodyResult = itemCustody.transfer({
    items: { itemID },
    from: itemCustody.custodyRef.inSpace(
      sourceOwnerID,
      systemID,
      item.spaceState || null,
    ),
    to: itemCustody.custodyRef.shipBay(
      destinationOwnerID,
      shipID,
      destinationFlagID,
    ),
    reason: itemCustody.CUSTODY_REASON.MOBILE_SCOOP,
    actor: toInt(command.actor, 0) || null,
    idempotencyKey:
      String(command.idempotencyKey || "").trim() ||
      `mobile-scoop:${itemID}:${sourceOwnerID}:${systemID}:` +
        `${destinationOwnerID}:${shipID}:${destinationFlagID}`,
    options: {
      destinationItemPatch:
        command.destinationItemPatch &&
        typeof command.destinationItemPatch === "object"
          ? command.destinationItemPatch
          : {},
    },
  });
  if (!custodyResult || !custodyResult.success) {
    const restoreResult = restoreSpaceItem(runtime, systemID, itemID);
    return restoreResult && restoreResult.success
      ? custodyResult || { success: false, errorMsg: "MOBILE_SCOOP_FAILED" }
      : {
          success: false,
          errorMsg: "MOBILE_SCOOP_ROLLBACK_FAILED",
          data: { restoreResult: restoreResult || null, cause: custodyResult || null },
        };
  }
  return custodyResult;
}

function expireInSpace(command = {}) {
  const runtime = command.runtime;
  const item = command.item && typeof command.item === "object"
    ? command.item
    : null;
  const itemID = toInt(item && item.itemID, 0);
  const ownerID = toInt(item && item.ownerID, 0);
  const systemID = toInt(command.systemID, toInt(item && item.locationID, 0));
  if (
    !runtime ||
    typeof runtime.destroyDynamicInventoryEntity !== "function" ||
    itemID <= 0 ||
    ownerID <= 0 ||
    toInt(item && item.locationID, 0) !== systemID ||
    toInt(item && item.flagID, -1) !== 0 ||
    systemID <= 0
  ) {
    return { success: false, errorMsg: "MOBILE_EXPIRE_CUSTODY_SOURCE_INVALID" };
  }

  const idempotencyKey =
    String(command.idempotencyKey || "").trim() ||
    `mobile-expire:${itemID}:${ownerID}:${systemID}`;
  const destroyResult = runtime.destroyDynamicInventoryEntity(systemID, itemID, {
    removeContents: command.removeContents !== false,
    custodyReason: itemCustody.CUSTODY_REASON.MOBILE_EXPIRE,
    actor: toInt(command.actor, 0) || null,
    idempotencyKey,
  });
  if (destroyResult && destroyResult.success) {
    return destroyResult;
  }
  if (
    destroyResult &&
    !["SCENE_NOT_FOUND", "DYNAMIC_ENTITY_NOT_FOUND"].includes(destroyResult.errorMsg)
  ) {
    return destroyResult;
  }

  return itemCustody.transfer({
    items: { itemID },
    from: itemCustody.custodyRef.inSpace(ownerID, systemID, item.spaceState || null),
    to: itemCustody.custodyRef.void(),
    reason: itemCustody.CUSTODY_REASON.MOBILE_EXPIRE,
    actor: toInt(command.actor, 0) || null,
    idempotencyKey,
    options: {
      removeContents: command.removeContents !== false,
    },
  });
}

module.exports = {
  deployFromShip,
  expireInSpace,
  scoopToShip,
};
