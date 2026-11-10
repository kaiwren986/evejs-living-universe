"use strict";

// Specialized single-bay POS inventories. Production owns silo material rules;
// these adapters share normal inventory custody and current compression data.
const items = require("../inventory/itemStore");
const {
  TYPE_COMPRESSION_ARRAY,
  TYPE_JUMP_BRIDGE,
  isCompressionArray,
  isBridgeInventory,
  isProcessingStorage,
} = require("./starbaseStorageKinds");
const n = (value) => Number(value) || 0;
const fail = (errorMsg) => ({ success: false, errorMsg });
const ok = (data = null) => ({ success: true, data });

function getProcessingFlag(item) { return isCompressionArray(item) ? 5 : 0; }

function getProcessingCapacity(item, flag = getProcessingFlag(item)) {
  if (!isProcessingStorage(item) || n(flag) !== getProcessingFlag(item)) return 0;
  return Math.max(0, n(require("../inventory/itemTypeRegistry").resolveItemByTypeID(item.typeID)?.capacity));
}

function validateProcessingAccess(session, itemOrID, operation = "viewput") {
  const item = items.findItemById(n(itemOrID?.itemID || itemOrID));
  if (!isProcessingStorage(item)) return fail("STARBASE_PROCESSING_NOT_FOUND");
  const production = require("./starbaseProductionRuntime");
  if (production.isProductionStorage(item)) return production.validateProductionInventoryAccess(session, item, operation);
  const storage = require("./starbaseInventoryRuntime");
  const result = storage.validateStarbaseInventoryAccess(session, item, { allowOffline: isBridgeInventory(item) });
  if (!result.success) return result;
  if ([result.data.item, result.data.tower].some((row) => require("./starbaseDefenseRuntime").hasUnavailableHealth(row))) {
    return fail("STARBASE_INVENTORY_OFFLINE");
  }
  return storage.hasMaintenanceInventoryPermission(session, result.data.tower, item.itemID, operation)
    ? result : fail("STARBASE_PROCESSING_ACCESS_DENIED");
}

const units = (row) => n(row.singleton) === 1 ? 1 : n(row.stacksize ?? row.quantity);
const volume = (row) => Math.max(0, n(require("../inventory/itemTypeRegistry").resolveItemByTypeID(row.typeID)?.volume));

function acceptsItem(array, item) {
  if (isBridgeInventory(array)) return n(item?.typeID) === 16273;
  // Current ore/ice conversions come from miningStaticData. Gas is not a legacy
  // compression-array input; do not inherit every modern fleet compressor family.
  return isCompressionArray(array) && n(item?.categoryID) === 25;
}

function validateProcessingDeposit(item, destination, quantity, projected = null) {
  const array = items.findStarbaseItemById(n(destination?.locationID));
  if (!isProcessingStorage(array)) return ok();
  const production = require("./starbaseProductionRuntime");
  if (production.isProductionStorage(array)) return production.validateProductionDeposit(item, destination, quantity, projected);
  if (!item || n(destination.flagID) !== getProcessingFlag(array) || !acceptsItem(array, item)) {
    return fail("STARBASE_PROCESSING_INVALID_ITEM");
  }
  if (quantity === undefined) return ok();
  const requested = quantity == null ? units(item) : Number(quantity);
  if (!Number.isSafeInteger(requested) || requested <= 0) return fail("STARBASE_PROCESSING_INVALID_QUANTITY");
  const contents = projected || items.listContainerItems(null, array.itemID, null);
  const used = contents.filter((row) => row.itemID !== item.itemID).reduce((sum, row) => sum + units(row) * volume(row), 0);
  return used + requested * volume(item) <= getProcessingCapacity(array) + 1e-7
    ? ok() : fail("STARBASE_PROCESSING_CAPACITY");
}

function validateProcessingBatch(moves) {
  const projected = new Map();
  const seen = new Set();
  for (const { item, destination, quantity } of moves) {
    const array = items.findItemById(n(destination?.locationID));
    if (!isProcessingStorage(array)) continue;
    if (seen.has(item.itemID)) return fail("STARBASE_PROCESSING_DUPLICATE_ITEM");
    seen.add(item.itemID);
    const contents = projected.get(array.itemID) || items.listContainerItems(null, array.itemID, null);
    const valid = validateProcessingDeposit(item, destination, quantity, contents);
    if (!valid.success) return valid;
    const count = quantity == null ? units(item) : Number(quantity);
    projected.set(array.itemID, [...contents.filter((row) => row.itemID !== item.itemID),
      { ...item, locationID: array.itemID, flagID: destination.flagID, stacksize: count, quantity: count }]);
  }
  return ok();
}

function getProcessingErrorMessage(code) {
  return ({
    STARBASE_PROCESSING_ACCESS_DENIED: "Your corporation's starbase inventory permissions do not allow this operation.",
    STARBASE_PROCESSING_INVALID_ITEM: "Use the correct inventory bay: compression arrays accept ore and ice; jump bridges accept Liquid Ozone only.",
    STARBASE_PROCESSING_INVALID_QUANTITY: "Select a positive whole number of items to move.",
    STARBASE_PROCESSING_DUPLICATE_ITEM: "The same inventory stack cannot be moved twice in one operation.",
    STARBASE_PROCESSING_CAPACITY: "There is not enough room in this starbase array.",
    STARBASE_COMPRESSION_ARRAY_REQUIRED: "Select an online Compression Array.",
    STARBASE_COMPRESSION_SOURCE_CHANGED: "The array or its contents changed. Refresh the inventory and try again.",
    ITEM_NOT_COMPRESSIBLE: "No supported compression conversion exists for this item.",
    STARBASE_PRODUCTION_MUST_BE_OFFLINE: "Offline this production structure before accessing its inventory.",
    STARBASE_PRODUCTION_ACCESS_DENIED: "Your corporation's starbase inventory permissions do not allow access to this production structure.",
    STARBASE_PRODUCTION_PROVISION_INVALID: "Configure this production structure for a supported material or reaction before loading it.",
    STARBASE_PRODUCTION_CAPACITY: "There is not enough room in this production structure.",
    STARBASE_PRODUCTION_CONTENTS_CONFLICT: "This inventory can hold only its configured material or reaction.",
    STARBASE_LEGACY_REACTION_AUTHORITY_MISSING: "No verified legacy recipe is configured for this reaction.",
  })[code] || null;
}

function publishChanges(session, changes) {
  const warn = (error) => require("../../utils/logger")
    .warn(`[StarbaseCompression] committed inventory notification failed: ${error.message}`);
  for (const change of changes) {
    try {
      require("../character/characterState")
        .syncInventoryItemForSession(session, change.item, change.previousData, { emitCfgLocation: true });
    } catch (error) { warn(error); }
  }
  // Actor delivery and observer fanout are independent post-commit effects.
  // A disconnected actor must not strand other pilots' bound inventories.
  try {
    require("../inventory/corporationOfficeInventoryObservers")
      .fanCorporationOfficeInventoryChanges(changes, { actorSession: session });
  } catch (error) { warn(error); }
}

// The current client has no POS-array compression action (itemCheckers.py:
// 197-218). This is an explicitly diagnostic/server backend, not a fabricated
// RPC or a claim that a removed normal-client action has been restored.
function compressStarbaseItems(session, arrayID, itemIDs) {
  const access = validateProcessingAccess(session, arrayID, "viewputtake");
  if (!access.success) return access;
  const array = access.data.item;
  if (!isCompressionArray(array)) return fail("STARBASE_COMPRESSION_ARRAY_REQUIRED");
  if (!Array.isArray(itemIDs) || !itemIDs.length || itemIDs.length > 256 ||
      itemIDs.some((id) => !Number.isSafeInteger(Number(id)) || Number(id) <= 0) ||
      new Set(itemIDs.map(Number)).size !== itemIDs.length) return fail("STARBASE_PROCESSING_INVALID_ITEM");
  const mining = require("../mining/miningIndustry");
  const statics = require("../mining/miningStaticData");
  const plans = new Map();
  for (const id of itemIDs.map(Number)) {
    const item = items.findItemById(id);
    if (!item || n(item.ownerID) !== n(array.ownerID) || n(item.locationID) !== array.itemID ||
        n(item.flagID) !== 5 || n(item.singleton) === 1 || !acceptsItem(array, item)) return fail("STARBASE_PROCESSING_INVALID_ITEM");
    const outputTypeID = statics.getCompressedTypeID(item.typeID);
    if (!outputTypeID) return fail("ITEM_NOT_COMPRESSIBLE");
    if (!Number.isSafeInteger(units(item)) || units(item) <= 0) return fail("STARBASE_PROCESSING_INVALID_QUANTITY");
    plans.set(id, { before: item, after: mining.rebuildItemAsType(item, outputTypeID, units(item)) });
  }
  const contents = items.listContainerItems(null, array.itemID, null);
  const projectedVolume = contents.reduce((sum, item) => {
    const projected = plans.get(item.itemID)?.after || item;
    return sum + units(projected) * volume(projected);
  }, 0);
  if (projectedVolume > getProcessingCapacity(array) + 1e-7) return fail("STARBASE_PROCESSING_CAPACITY");
  let result;
  try {
    result = items.updateInventoryItemsAtomic([array.itemID, ...plans.keys()], (current) => {
      const plan = plans.get(current.itemID);
      const before = plan?.before || array;
      if (JSON.stringify(current) !== JSON.stringify(before)) throw new Error("STARBASE_COMPRESSION_SOURCE_CHANGED");
      return plan ? plan.after : current;
    });
  } catch (error) { return fail(error.message); }
  if (!result.success) return result;
  const changes = result.data.changes.filter((change) => plans.has(change.item.itemID));
  publishChanges(session, changes);
  return ok({ changes, outputs: changes.map(({ item, previousData }) => [previousData.itemID,
    previousData.typeID, units(previousData), item.itemID, item.typeID, units(item)]) });
}

module.exports = { TYPE_COMPRESSION_ARRAY, TYPE_JUMP_BRIDGE, isCompressionArray, isBridgeInventory,
  isProcessingStorage, getProcessingFlag, getProcessingCapacity, validateProcessingAccess,
  validateProcessingDeposit, validateProcessingBatch, compressStarbaseItems, getProcessingErrorMessage };
