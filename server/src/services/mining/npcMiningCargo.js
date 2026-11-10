"use strict";

// The native store owns cargo. Scene arrays are refreshed only after its durable
// receipt commits; compensation is fenced against every later row mutation.
const { randomUUID } = require("node:crypto");
const store = require("../../space/npc/nativeNpcStore");
const { resolveItemByTypeID } = require("../inventory/itemTypeRegistry");
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const fail = errorMsg => ({ success: false, errorMsg });

function refresh(entity) {
  const items = store.buildNativeCargoItems(entity.itemID).map(item => ({ ...item,
    volume: Math.max(0, Number(resolveItemByTypeID(item.typeID)?.volume || 0)) }));
  // Fitted charge projections are owned by equipment, not mining cargo.
  for (const item of entity.nativeCargoItems || []) {
    if (item.moduleID > 0 && !items.some(row => row.itemID === item.itemID)) items.push(item);
  }
  entity.nativeCargoItems = items;
}

function prepareGrant(entity, typeID, quantity, commandID = randomUUID()) {
  if (!entity || !Number.isSafeInteger(Number(entity.itemID)) || Number(entity.itemID) <= 0 ||
      !Number.isSafeInteger(typeID) || typeID <= 0 || !Number.isSafeInteger(quantity) || quantity <= 0) {
    return fail("NPC_MINING_CARGO_INVALID");
  }
  const previous = store.listNativeCargoForEntity(entity.itemID).find(row => row.typeID === typeID && !row.moduleID) || null;
  if ((entity.nativeNpc || !entity.transient) && !store.getNativeEntity(entity.itemID)) return fail("NPC_NOT_FOUND");
  const itemType = resolveItemByTypeID(typeID);
  if (!itemType) return fail("NPC_MINING_CARGO_TYPE_INVALID");
  let cargoID = previous?.cargoID;
  if (!cargoID) {
    const allocated = store.allocateCargoID();
    if (!allocated?.success || !(allocated.data > 0)) return fail(allocated?.errorMsg || "NPC_MINING_CARGO_ID_FAILED");
    cargoID = allocated.data;
    // Reserve the identity before a caller may persist a cross-owner intent.
    {
      const flushed = store.flushNativeCargoSync();
      if (!flushed?.success) return fail(flushed?.errorMsg || "NPC_MINING_CARGO_ID_FLUSH_FAILED");
    }
  }
  const nextQuantity = Number(previous?.quantity || 0) + quantity;
  if (!Number.isSafeInteger(nextQuantity)) return fail("NPC_MINING_CARGO_QUANTITY_INVALID");
  const next = { ...(previous || {}), cargoID, entityID: Number(entity.itemID),
    ownerID: Number(entity.ownerID ?? entity.pilotCharacterID ?? entity.characterID),
    moduleID: 0, typeID, groupID: Number(itemType.groupID || 0), categoryID: Number(itemType.categoryID || 0),
    itemName: String(itemType.name || `type ${typeID}`), quantity: nextQuantity, singleton: false,
    transient: false,
    ...(entity.transient ? { miningOwnerInstanceID: store.miningCargoOwnerInstanceID } : {}) };
  return { success: true, data: { commandID, cargoID, previous: clone(previous), next,
    expectedRevision: Number(previous?.miningRevision || 0), transient: false } };
}

function apply(mutation, entity = null) {
  const result = store.applyMiningCargoMutation(mutation);
  if (result.success && entity) refresh(entity);
  return result;
}

function appendNpcMiningCargoWithReceipt(entity, typeID, quantity, options = {}) {
  const prepared = prepareGrant(entity, Number(typeID), Number(quantity), options.commandID);
  if (!prepared.success) return prepared;
  const result = apply(prepared.data, entity);
  return result.success ? { ...result, data: { ...result.data, receipt: prepared.data } } : result;
}

function rollbackNpcMiningCargoGrant(receipt, entity = null) {
  if (!receipt?.commandID) return fail("NPC_MINING_CARGO_RECEIPT_INVALID");
  return apply({ commandID: `${receipt.commandID}:rollback`, cargoID: receipt.cargoID,
    previous: receipt.next, next: receipt.previous, transient: receipt.transient,
    expectedRevision: receipt.expectedRevision + 1,
    requiredPreviousCommandID: receipt.commandID }, entity);
}

function removeNpcMiningCargoItemWithReceipt(entity, cargoID, options = {}) {
  const previous = store.getNativeCargo(Number(cargoID));
  if (!previous || previous.entityID !== Number(entity?.itemID) || previous.moduleID > 0) return fail("NPC_MINING_CARGO_REMOVE_INVALID");
  const receipt = { commandID: options.commandID || randomUUID(), cargoID: previous.cargoID,
    previous, next: null, expectedRevision: Number(previous.miningRevision || 0), transient: false,
    disposition: options.disposition || "removed" };
  const result = apply(receipt, entity);
  return result.success ? { ...result, data: { ...result.data, receipt } } : result;
}

module.exports = { prepareGrant, apply, refresh, appendNpcMiningCargoWithReceipt,
  rollbackNpcMiningCargoGrant, removeNpcMiningCargoItemWithReceipt,
  rollbackNpcMiningCargoRemoval: rollbackNpcMiningCargoGrant };
