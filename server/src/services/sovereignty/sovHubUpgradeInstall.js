"use strict";

const { randomUUID } = require("node:crypto");
const database = require("../../gameStore");
const items = require("../inventory/itemStore");
const characterState = require("../character/characterState");
const log = require("../../utils/logger");

function reject(errorCode, statusCode = 400) {
  throw { errorCode, statusCode };
}

function persist() {
  if (!database.flushTableSync("sovereignty")?.success) reject("UPGRADE_PERSISTENCE_FAILED", 503);
}

function debitReceiptKey(install, source) {
  return `${install.receiptKey}:${source.itemID}`;
}

function rememberInstallSources(hub, sources) {
  hub.installedUpgradeSources = { ...hub.installedUpgradeSources };
  for (const source of sources) {
    hub.installedUpgradeSources[source.typeID] = {
      itemID: source.itemID,
      characterID: source.ownerID,
    };
  }
}

function notifyInventoryChanges(session, debit) {
  for (const change of debit.data?.committedChanges || debit.data?.changes || []) {
    if (!change || !change.item) continue;
    // The item store announces a used-up stack as a move to the junk location,
    // which the client drops from its hold most reliably, so it goes out as built.
    const item = change.removed ? change.item : items.findItemById(change.item.itemID) || change.item;
    characterState.syncInventoryItemForSession(session, item, change.previousData || {});
  }
}

// An install left behind by a failed write or a crash is settled from its debit
// receipts before anything else happens at the Hub. An item with a receipt left
// the ship, so its upgrade is added, offline and last, to what the Hub has
// installed now; an item without one never left, so it is dropped. The intent is
// cleared either way, so it cannot block another save, and an upgrade removed in
// the meantime stays removed.
function settleLeftoverInstall(hub, mutateHub) {
  const leftover = hub.pendingUpgradeInstall;
  if (!leftover) return null;
  const debited = (leftover.sources || []).filter((source) => {
    const receipt = items.getIdempotentGrantReceipt(debitReceiptKey(leftover, source), { requireDurable: true });
    if (!receipt.success) reject("UPGRADE_DEBIT_UNCERTAIN", 503);
    return receipt.found === true;
  });
  mutateHub((current) => {
    const installedUpgrades = Array.isArray(current.installedUpgrades) ? [...current.installedUpgrades] : [];
    for (const source of debited) {
      if (!installedUpgrades.some((entry) => Number(entry && entry.typeID) === source.typeID)) {
        installedUpgrades.push({ typeID: source.typeID, online: false });
      }
    }
    if (debited.length > 0) {
      current.installedUpgrades = installedUpgrades;
      rememberInstallSources(current, debited);
      current.upgradesLastUpdatedMs = Date.now();
    }
    current.pendingUpgradeInstall = null;
  });
  persist();
  return debited;
}

function dropInstall(mutateHub) {
  try {
    mutateHub((current) => { current.pendingUpgradeInstall = null; });
    persist();
  } catch (error) {
    // Left for the next save to settle; without receipts it is dropped then.
    log.debug(`[SovHubUpgrades] dropping the pending upgrade install failed: ${error && error.message}`);
  }
}

// Inventory and sovereignty are separate persistence domains. An install writes a
// durable intent, debits each new upgrade item under its own receipt, then saves
// the configuration and clears the intent in one write. Once every debit is
// durable the install stands: if that last write is lost, the next save at the
// Hub settles it from the receipts.
function installHubUpgrades({
  hub, newUpgradeItemIDs = [], configurations = [], identity, session,
  isUpgradeType, buildInstallations, inTransferRange, mutateHub,
}) {
  const characterID = Number(identity.characterID);
  const requestedItemIDs = [...new Set(newUpgradeItemIDs.map(Number))].sort((a, b) => a - b);
  const fingerprint = JSON.stringify({ characterID: identity.characterID, items: requestedItemIDs, configurations });
  const settled = settleLeftoverInstall(hub, mutateHub);
  // A timed-out client keeps the consumed item IDs in its next save, which may
  // also change priority or add more upgrades. Only skip sources paid for by
  // this pilot at this Hub and still installed; never accept arbitrary missing
  // items or bring back an uninstalled upgrade.
  const installedTypeIDsBeforeSave = new Set((hub.installedUpgrades || []).map((entry) => entry.typeID));
  const paidItemIDs = new Set(Object.entries(hub.installedUpgradeSources || {})
    .filter(([typeID, source]) => installedTypeIDsBeforeSave.has(Number(typeID)) && source.characterID === characterID)
    .map(([, source]) => source.itemID));
  for (const source of settled || []) {
    if (source.ownerID === characterID) paidItemIDs.add(source.itemID);
  }
  const itemIDs = requestedItemIDs.filter((itemID) => !paidItemIDs.has(itemID));

  const requested = itemIDs.map((itemID) => {
    const item = items.findItemById(itemID);
    if (!item) reject("NOT_FOUND", 404);
    if (!isUpgradeType(Number(item.typeID))) reject("INVALID_DATA");
    return { itemID, item, typeID: Number(item.typeID) };
  });
  // Validate the whole configuration before any inventory changes.
  const { installations, installedTypeIDs } = buildInstallations(
    requested.map((entry) => entry.typeID),
    configurations,
  );
  const shipID = Number(session?._space?.shipID);
  const ship = shipID ? items.findItemById(shipID) : null;
  const shipInHubSystem = Boolean(ship) &&
    Number(ship.ownerID) === characterID &&
    Number(ship.locationID) === Number(hub.solarSystemID) &&
    Number(identity.solarSystemID) === Number(hub.solarSystemID);
  // Only new items need the ship at the Hub; the window saves a configuration
  // from anywhere.
  const shipInRange = requested.length > 0 && shipInHubSystem && inTransferRange(shipID);
  const seenTypeIDs = new Set(installedTypeIDs);
  const sources = requested.map(({ itemID, item, typeID }) => {
    if (Number(item.ownerID) !== characterID) reject("FORBIDDEN_REQUEST", 403);
    // The Sov Hub window takes an upgrade from any hold of the active ship, and
    // only while that ship is within cargo transfer range of the Hub.
    if (!shipInHubSystem || Number(item.locationID) !== shipID) reject("INVALID_UPGRADE_LOCATION", 403);
    if (!shipInRange) reject("TARGET_TOO_FAR", 403);
    if (seenTypeIDs.has(typeID)) reject("UPGRADE_ALREADY_INSTALLED", 409);
    seenTypeIDs.add(typeID);
    const quantity = item.singleton === 1 ? 1 : Number(item.stacksize ?? item.quantity);
    if (!Number.isSafeInteger(quantity) || quantity < 1) reject("INSUFFICIENT_ITEMS");
    return { itemID, typeID, ownerID: characterID, locationID: shipID, flagID: Number(item.flagID) };
  });

  if (sources.length === 0) {
    mutateHub((current) => {
      current.installedUpgrades = installations;
      current.upgradesLastUpdatedMs = Date.now();
    });
    return { ok: true, hubID: hub.hubID, solarSystemID: hub.solarSystemID };
  }

  const install = { fingerprint, receiptKey: `sov-upgrade:${hub.hubID}:${randomUUID()}`, sources };
  mutateHub((current) => { current.pendingUpgradeInstall = install; });
  persist();
  const debits = [];
  for (const source of sources) {
    const debit = items.consumeInventoryItemQuantityIdempotent(source.itemID, 1, {
      receiptKey: debitReceiptKey(install, source),
      fingerprint: source,
    });
    if (!debit.success || !debit.durable) {
      // Nothing was written, so the intent goes now. A partial or unknown outcome
      // stays for the next save to settle.
      if (debits.length === 0 && debit.ambiguous === false) dropInstall(mutateHub);
      reject("UPGRADE_DEBIT_FAILED", 503);
    }
    debits.push(debit);
  }
  let mutationFlushPending = false;
  try {
    mutateHub((current) => {
      current.installedUpgrades = installations;
      rememberInstallSources(current, sources);
      current.upgradesLastUpdatedMs = Date.now();
      current.pendingUpgradeInstall = null;
    });
  } catch (error) {
    if (error.code !== "HUB_FUEL_PERSISTENCE_FAILED" || error.hubMutationStaged !== true) {
      for (const debit of debits) notifyInventoryChanges(session, debit);
      throw error;
    }
    mutationFlushPending = true;
  }
  let persistencePending = mutationFlushPending;
  try {
    persist();
  } catch (error) {
    // Every item is durably debited, so the install stands. A later flush keeps
    // it, or after a crash the next save settles it from the receipts.
    log.debug(`[SovHubUpgrades] saving the upgrade install on hub ${hub.hubID} failed: ${error && error.message}`);
    persistencePending = true;
  }
  for (const debit of debits) notifyInventoryChanges(session, debit);
  return { ok: true, hubID: hub.hubID, solarSystemID: hub.solarSystemID,
    ...(persistencePending ? { persistencePending: true } : {}) };
}

module.exports = { installHubUpgrades };
