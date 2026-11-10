"use strict";

const { bumpDogmaInvalidationVersion } = require("../character/dogmaInvalidationVersion");

// The verified numeric base-resource subset of the native /dogma editor.
// These are temporary staff-session inputs, never type or mutaplasmid data.
const SHIP_RESOURCE_ATTRIBUTES = Object.freeze({
  cpuOutput: 48,
  turretSlotsLeft: 102,
  launcherSlotsLeft: 101,
  powerOutput: 11,
  capacity: 38,
  capacitorCapacity: 482,
  hiSlots: 14,
  medSlots: 13,
  lowSlots: 12,
  rigSlots: 1137,
  upgradeSlotsLeft: 1154,
  upgradeCapacity: 1132,
});
const byItemID = new Map();
const bySession = new WeakMap();

function hasItemOverrides(itemID) {
  return byItemID.has(Number(itemID));
}

function isFittingCountAttribute(attributeID) {
  return Object.entries(SHIP_RESOURCE_ATTRIBUTES).some(([name, id]) =>
    id === attributeID && /Slots(?:Left)?$/.test(name));
}

function isValidAttributeValue(attributeID, value) {
  return Object.values(SHIP_RESOURCE_ATTRIBUTES).includes(attributeID) &&
    Number.isFinite(value) && (isFittingCountAttribute(attributeID)
      ? Number.isInteger(value) && value >= 0 && value <= 8
      : value > 0 && value <= 1e12);
}

function getAttributeOverrides(item) {
  const record = byItemID.get(Number(item && item.itemID));
  if (!record || Number(item.singleton) !== 1 || record.ownerID !== Number(item.ownerID) || record.typeID !== Number(item.typeID) ||
      record.ownerID !== Number(record.session.characterID) || record.session.socket?.destroyed === true) return {};
  return { ...record.attributes };
}

function setAttributeOverride(session, item, attributeID, value) {
  if (!session || Number(item?.ownerID) !== Number(session.characterID) || Number(item?.categoryID) !== 6 || Number(item?.singleton) !== 1 ||
      !isValidAttributeValue(attributeID, value)) return false;
  const itemID = Number(item.itemID);
  const previous = byItemID.get(itemID);
  const record = { session, ownerID: Number(item.ownerID), typeID: Number(item.typeID),
    attributes: previous?.session === session ? { ...getAttributeOverrides(item) } : {} };
  record.attributes[attributeID] = value;
  byItemID.set(itemID, record);
  if (!bySession.has(session)) bySession.set(session, new Set());
  bySession.get(session).add(itemID);
  bumpDogmaInvalidationVersion();
  return true;
}

function clearShipOverrides(session, itemID) {
  if (byItemID.get(Number(itemID))?.session !== session) return false;
  byItemID.delete(Number(itemID));
  bySession.get(session)?.delete(Number(itemID));
  bumpDogmaInvalidationVersion();
  return true;
}

function forgetSession(session) {
  let changed = false;
  for (const itemID of bySession.get(session) || []) changed = clearShipOverrides(session, itemID) || changed;
  bySession.delete(session);
  return changed;
}

// Called only after the inventory owner commits. A transfer, repackaging or
// destruction ends the override permanently; giving the same ID back cannot
// resurrect an old staff edit. Fitting and ordinary inventory moves retain it.
function noteCommittedItemChanges(originals, stagedRows, removedRows) {
  if (byItemID.size === 0) return;
  for (const key of originals.keys()) {
    const itemID = Number(key), record = byItemID.get(itemID);
    if (!record) continue;
    const next = removedRows.has(key) ? null : stagedRows.get(key);
    if (!next || Number(next.singleton) !== 1 || Number(next.ownerID) !== record.ownerID ||
        Number(next.typeID) !== record.typeID) clearShipOverrides(record.session, itemID);
  }
}

module.exports = { SHIP_RESOURCE_ATTRIBUTES, hasItemOverrides, isFittingCountAttribute, isValidAttributeValue, getAttributeOverrides, setAttributeOverride, clearShipOverrides, forgetSession, noteCommittedItemChanges };
