"use strict";

// Which POS structures are storage, by kind. These are pure type and group checks. This module
// requires nothing, so the inventory, processing and production runtimes can all ask without
// requiring each other.
const n = (value) => Number(value) || 0;
const GROUP_SILO = 404;
const GROUP_REACTOR = 438;
const TYPE_COMPRESSION_ARRAY = 12239;
const TYPE_JUMP_BRIDGE = 27897;

function isCompressionArray(item) {
  return n(item?.categoryID) === 23 && n(item.typeID) === TYPE_COMPRESSION_ARRAY;
}

function isBridgeInventory(item) {
  return n(item?.categoryID) === 23 && n(item.typeID) === TYPE_JUMP_BRIDGE;
}

// Silos and reactors; production owns their material rules.
function isProductionStorage(item) {
  return n(item?.categoryID) === 23 && [GROUP_SILO, GROUP_REACTOR].includes(n(item.groupID));
}

// Specialized single-bay inventories: compression arrays, jump bridges, silos and reactors.
function isProcessingStorage(item) {
  return isCompressionArray(item) || isBridgeInventory(item) || isProductionStorage(item);
}

module.exports = {
  GROUP_SILO,
  GROUP_REACTOR,
  TYPE_COMPRESSION_ARRAY,
  TYPE_JUMP_BRIDGE,
  isCompressionArray,
  isBridgeInventory,
  isProductionStorage,
  isProcessingStorage,
};
