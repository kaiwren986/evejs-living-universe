"use strict";

// Moving a native NPC wreck's loot into the salvage loot container. The
// salvager converts a looted native wreck into an inventory container; this
// half of that conversion changes item custody (native wreck rows become owned
// inventory items), so it lives with the other custody helpers here. It was
// moved unchanged from space/modules/salvagerRuntime.js, which keeps the
// container creation, wreck removal and rollback around it (a49264051 made the
// whole conversion atomic, which a per-item itemCustody.transfer cannot be).

const path = require("path");

const {
  cloneValue,
} = require("../../common/clone");
const {
  toPositiveInt,
} = require("../../common/numbers");
const {
  ITEM_FLAGS,
  grantItemsToOwnerLocation,
} = require(path.join(__dirname, "./itemStore"));
const {
  resolveItemByTypeID,
} = require(path.join(__dirname, "./itemTypeRegistry"));
const nativeNpcStore = require(path.join(__dirname, "../../space/npc/nativeNpcStore"));

function callSalvageMutationSafely(executor, fallbackErrorMsg) {
  try {
    return executor();
  } catch (error) {
    return {
      success: false,
      errorMsg:
        String(error && error.message || "").trim() || fallbackErrorMsg,
    };
  }
}

function transferNativeWreckLootToContainer(wreckRecord, containerID, fallbackOwnerID = 0) {
  const wreckID = toPositiveInt(wreckRecord && wreckRecord.wreckID, 0);
  const changes = [];
  const contents = nativeNpcStore.listNativeWreckItemsForWreck(wreckID);
  const removedSourceRecords = [];

  for (const itemRecord of contents) {
    const singleton = itemRecord && itemRecord.singleton === true;
    const quantity = singleton
      ? 1
      : Math.max(1, toPositiveInt(itemRecord && itemRecord.quantity, 1));
    const ownerID = toPositiveInt(
      (itemRecord && itemRecord.ownerID) || fallbackOwnerID,
      0,
    );
    const itemType = resolveItemByTypeID(
      toPositiveInt(itemRecord && itemRecord.typeID, 0),
    ) || {
      typeID: toPositiveInt(itemRecord && itemRecord.typeID, 0),
      name: String(itemRecord && itemRecord.itemName || "Item"),
    };
    const grantResult = callSalvageMutationSafely(
      () => grantItemsToOwnerLocation(
        ownerID,
        containerID,
        ITEM_FLAGS.HANGAR,
        [{
          itemType,
          quantity,
          options: {
            singleton: singleton ? 1 : 0,
            itemName: String(itemRecord && itemRecord.itemName || itemType.name || "Item"),
            customInfo: String(itemRecord && itemRecord.customInfo || ""),
            moduleState: itemRecord && itemRecord.moduleState
              ? cloneValue(itemRecord.moduleState)
              : undefined,
          },
        }],
      ),
      "LOOT_TRANSFER_FAILED",
    );
    if (!grantResult.success || !grantResult.data) {
      return {
        success: false,
        errorMsg: grantResult.errorMsg || "LOOT_TRANSFER_FAILED",
        changes,
        removedSourceRecords,
      };
    }
    changes.push(...(grantResult.data.changes || []));
  }

  // Do not retire any native source until every destination grant succeeded.
  // A later source-row failure can then restore only the already removed rows
  // while the inventory grant changes are compensated as one CAS transaction.
  for (const itemRecord of contents) {
    const removeResult = callSalvageMutationSafely(
      () => nativeNpcStore.removeNativeWreckItem(
        toPositiveInt(itemRecord && itemRecord.wreckItemID, 0),
      ),
      "LOOT_TRANSFER_FAILED",
    );
    if (!removeResult || removeResult.success !== true) {
      return {
        success: false,
        errorMsg: removeResult && removeResult.errorMsg || "LOOT_TRANSFER_FAILED",
        changes,
        removedSourceRecords,
      };
    }
    removedSourceRecords.push(cloneValue(itemRecord));
  }

  return {
    success: true,
    changes,
    removedSourceRecords,
  };
}

module.exports = {
  transferNativeWreckLootToContainer,
};
