"use strict";

// The four simulation supplies open into packaged hulls and loose equipment.
// The capture's later assembly and fitting commands are separate gameplay.
const database = require("../../gameStore");
const accounts = require("../newEdenStore/storeState");
const characters = require("../character/characterState");
const inventory = require("../inventory/itemStore");
const { resolveItemByTypeID } = require("../inventory/itemTypeRegistry");
const manifests = require("./visionsOfGreatness.data.json").supplyCratesByTypeID;

const clone = value => JSON.parse(JSON.stringify(value));
const check = result => {
  if (!result?.success) throw new Error(result?.errorMsg || "VISIONS_CRATE_SETTLEMENT_FAILED");
  return result;
};
const isSupplyCrate = typeID => Boolean(manifests[String(Number(typeID))]);

function model(characterID) {
  const character = characters.getCharacterRecord(characterID), accountID = Number(character?.accountId);
  if (!character || !Number.isSafeInteger(accountID) || accountID <= 0) throw new Error("CHARACTER_NOT_FOUND");
  return { character, accountID, account: accounts.readRuntimeAccount(accountID) };
}

function previous(characterID, crateID, pendingOnly = false) {
  const { account } = model(characterID);
  return Object.values(account.visionsCrateOpenings || {})
    .filter(row => row.characterID === characterID && row.crateID === crateID && (!pendingOnly || row.state === "pending"))
    .sort((a, b) => b.sequence - a.sequence)[0] || null;
}

function save(accountID, operation) {
  const account = accounts.readRuntimeAccount(accountID);
  (account.visionsCrateOpenings ||= {})[operation.id] = clone(operation);
  check(accounts.writeRewardAccount(accountID, account));
  check(database.flushTableSync("newEdenStoreRuntime"));
}

function preview(item) {
  const manifest = manifests[item.typeID];
  if (!manifest) throw new Error("VISIONS_CRATE_UNSUPPORTED");
  return manifest.entries.map(entry => [entry.typeID, entry.quantity, ""]);
}

function location(characterID, crateID) {
  if (!(characterID > 0) || !characters.getCharacterRecord(characterID)) return null;
  const item = inventory.findItemById(crateID);
  if (item?.ownerID === characterID && isSupplyCrate(item.typeID)) return [item.locationID, item.flagID];
  const operation = previous(characterID, crateID);
  return operation ? [operation.locationID, operation.flagID] : null;
}

function publish(operation, changes, session) {
  const currentChanges = changes.map(change => {
    const previousItem = change.item || change.previousData;
    const current = inventory.findItemById(previousItem.itemID);
    return { ...change, previousData: change.previousData || change.previousState,
      item: current?.ownerID === operation.characterID
      ? current : inventory.buildRemovedItemNotificationState(previousItem) };
  });
  for (const target of require("../raffles/raffleInventory").getCharacterSessions(operation.characterID, { includeSession: session })) {
    characters.emitItemsChangedBatchForSession(target, currentChanges);
  }
}

function settle(accountID, id, session) {
  let operation = accounts.readRuntimeAccount(accountID).visionsCrateOpenings?.[id];
  if (!operation || operation.accountID !== accountID) throw new Error("VISIONS_CRATE_INTENT_NOT_FOUND");
  // A refused flush can leave a visible cached intent. Fence it on every
  // retry before any source unit may be consumed or a completion acknowledged.
  check(database.flushTableSync("newEdenStoreRuntime"));
  if (operation.state === "completed") return clone(operation.result.nativeItems);
  const { character } = model(operation.characterID);
  if (Number(character.accountId) !== accountID) throw new Error("VISIONS_CRATE_OWNER_CHANGED");
  const result = check(inventory.exchangeInventoryItemStacksIdempotent([{
    itemID: operation.crateID, quantity: 1, expectedQuantity: operation.initialQuantity,
    expectedTypeID: operation.crateTypeID, expectedOwnerID: operation.characterID,
    expectedLocationID: operation.locationID, expectedFlagID: operation.flagID,
  }], operation.entries.map(entry => ({ typeID: entry.typeID, quantity: entry.quantity,
    ownerID: operation.characterID, locationID: operation.locationID, flagID: operation.flagID })),
  { receiptKey: operation.id, fingerprint: operation.fingerprint }));
  if (!result.durable) throw new Error("VISIONS_CRATE_EXCHANGE_NOT_DURABLE");
  // Consumption, every output and these immutable result rows share a single
  // durable items commit. A lost account acknowledgement cannot lose supplies
  // or generate replacements for outputs that were moved, used or destroyed.
  const committedChanges = result.receipt.resultData.changes;
  const outputs = committedChanges.filter(change => change.item && change.item.typeID !== operation.crateTypeID);
  const nativeItems = operation.entries.map(entry => {
    const output = outputs.find(change => change.item.typeID === entry.typeID);
    if (!output) throw new Error("VISIONS_CRATE_RECEIPT_OUTPUT_MISSING");
    return [output.item.itemID, entry.typeID, entry.quantity];
  });
  operation = { ...operation, state: "completed", result: { nativeItems } };
  save(accountID, operation);
  publish(operation, committedChanges, session);
  return clone(nativeItems);
}

function open(characterID, crateID, session) {
  const pending = previous(characterID, crateID, true);
  if (pending) return settle(pending.accountID, pending.id, session);
  const item = inventory.findItemById(crateID);
  if (!item) {
    const completed = previous(characterID, crateID);
    if (completed?.state === "completed") return settle(completed.accountID, completed.id, session);
    throw new Error("VISIONS_CRATE_NOT_FOUND");
  }
  if (item.ownerID !== characterID || !isSupplyCrate(item.typeID) || item.singleton !== 0 || item.stacksize < 1) throw new Error("VISIONS_CRATE_NOT_OWNED");
  const { character, accountID, account } = model(characterID);
  const stationID = Number(session?.stationID || session?.stationid || character.stationID);
  if (!(stationID > 0) || item.locationID !== stationID || item.flagID !== inventory.ITEM_FLAGS.HANGAR) throw new Error("VISIONS_CRATE_REQUIRES_DOCKED_HANGAR");
  const entries = clone(manifests[item.typeID].entries);
  if (entries.some(entry => !resolveItemByTypeID(entry.typeID) || entry.singleton !== 0 || !Number.isSafeInteger(entry.quantity) || entry.quantity < 1)) throw new Error("VISIONS_CRATE_CONTENTS_UNAVAILABLE");
  const all = Object.values(account.visionsCrateOpenings || {});
  if (all.length >= 8192) throw new Error("VISIONS_CRATE_RECEIPT_LIMIT");
  const sequence = all.filter(row => row.characterID === characterID && row.crateID === crateID).length + 1;
  const fingerprint = { characterID, crateID, crateTypeID: item.typeID, locationID: item.locationID,
    flagID: item.flagID, initialQuantity: item.stacksize, sequence };
  const operation = { ...fingerprint, fingerprint, accountID, sequence, entries,
    id: `visions-crate:${accountID}:${characterID}:${crateID}:${sequence}`, state: "pending" };
  save(accountID, operation);
  return settle(accountID, operation.id, session);
}

function wasDelivered(characterID, itemID) {
  if (!(characterID > 0) || !characters.getCharacterRecord(characterID)) return false;
  const delivered = Object.values(model(characterID).account.visionsCrateOpenings || {}).some(operation => operation.characterID === characterID &&
    operation.state === "completed" && operation.result.nativeItems.some(row => row[0] === itemID));
  if (delivered) check(database.flushTableSync("newEdenStoreRuntime"));
  return delivered;
}

module.exports = { isSupplyCrate, preview, location, previous, open, settle, wasDelivered };
