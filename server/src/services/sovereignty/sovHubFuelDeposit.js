"use strict";

const { randomUUID } = require("node:crypto");
const database = require("../../gameStore");
const items = require("../inventory/itemStore");
const characterState = require("../character/characterState");
const log = require("../../utils/logger");

const REAGENT_TYPES = new Set([81143, 81144]);
const SOURCE_FLAGS = new Set([items.ITEM_FLAGS.CARGO_HOLD, items.ITEM_FLAGS.COLONY_RESOURCES_HOLD]);

function failure(errorCode, statusCode = 400) {
  return { ok: false, errorCode, statusCode };
}

function persist() {
  const result = database.flushTableSync("sovereignty");
  if (!result || !result.success) throw new Error("FUEL_DEPOSIT_PERSISTENCE_FAILED");
}

function validateSource(hub, identity, session, itemID, amount) {
  const item = items.findItemById(itemID);
  if (!item) return failure("NOT_FOUND", 404);
  if (!REAGENT_TYPES.has(Number(item.typeID))) return failure("INVALID_FUEL_TYPE");
  if (Number(item.ownerID) !== Number(identity.characterID)) return failure("FORBIDDEN_REQUEST", 403);
  const shipID = Number(session && session._space && session._space.shipID);
  const ship = shipID && items.findItemById(shipID);
  if (!ship || Number(ship.ownerID) !== Number(identity.characterID) ||
      Number(ship.locationID) !== hub.solarSystemID ||
      Number(identity.solarSystemID) !== hub.solarSystemID ||
      Number(item.locationID) !== shipID || !SOURCE_FLAGS.has(Number(item.flagID))) {
    return failure("INVALID_FUEL_LOCATION", 403);
  }
  const available = item.singleton === 1 ? 1 : Number(item.stacksize ?? item.quantity);
  if (!Number.isSafeInteger(available) || amount > available) return failure("INSUFFICIENT_ITEMS");
  return { ok: true, item };
}

function creditFuel(hubRecord, fuelTypeID, amount) {
  const ledger = hubRecord.fuelByTypeID || {};
  const nextAmount = Number(ledger[String(fuelTypeID)]?.amount || 0) + amount;
  if (!Number.isSafeInteger(nextAmount)) throw new Error("FUEL_QUANTITY_OUT_OF_RANGE");
  hubRecord.fuelByTypeID = { ...ledger, [String(fuelTypeID)]: { amount: nextAmount } };
  hubRecord.fuelLastUpdatedMs = Date.now();
}

function withoutDeposits(pendingFuelDeposits, receiptKeys) {
  const remaining = {};
  for (const [key, pending] of Object.entries(pendingFuelDeposits || {})) {
    if (!receiptKeys.has(pending && pending.receiptKey)) remaining[key] = pending;
  }
  return remaining;
}

// A deposit left behind by a failed write or a crash is settled from its debit
// receipt before anything else happens at the Hub. A receipt means the reagents
// left the ship, so the Hub is credited; no receipt means they never did, so the
// intent is dropped. Settled intents are cleared either way, so none can block a
// later deposit.
function settleLeftoverDeposits(hub, mutateHub) {
  const leftovers = Object.values(hub.pendingFuelDeposits || {}).filter(Boolean);
  if (leftovers.length === 0) return [];
  const debited = leftovers.filter((pending) => {
    const receipt = items.getIdempotentGrantReceipt(pending.receiptKey, { requireDurable: true });
    if (!receipt.success) throw new Error(receipt.errorMsg || "FUEL_DEBIT_UNCERTAIN");
    return receipt.found === true;
  });
  mutateHub((current) => {
    const present = new Set(Object.values(current.pendingFuelDeposits || {})
      .map((pending) => pending && pending.receiptKey));
    for (const pending of debited) {
      // PR #154's first flow could leave an already credited marker behind.
      if (present.has(pending.receiptKey) && pending.phase !== "credited") {
        creditFuel(current, pending.fuelTypeID, pending.amount);
      }
    }
    current.pendingFuelDeposits = withoutDeposits(
      current.pendingFuelDeposits,
      new Set(leftovers.map((pending) => pending.receiptKey)),
    );
  });
  persist();
  return debited;
}

function dropDeposit(mutateHub, receiptKey) {
  try {
    mutateHub((current) => {
      current.pendingFuelDeposits = withoutDeposits(current.pendingFuelDeposits, new Set([receiptKey]));
    });
    persist();
  } catch (error) {
    // Left for the next deposit to settle; without a receipt it is dropped then.
    log.debug(`[SovHubFuel] dropping deposit receipt ${receiptKey} failed: ${error && error.message}`);
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

// Inventory and sovereignty are separate persistence domains. A deposit writes a
// durable intent, debits the reagents under that intent's receipt, then credits
// the Hub and clears the intent in one write. Once the debit is durable the
// deposit stands: if that last write is lost, the next deposit at the Hub
// settles it from the receipt.
function depositHubFuel({ hub, itemID, amount, identity, session, inTransferRange, mutateHub }) {
  if (!Number.isSafeInteger(amount) || amount <= 0 ||
      !Number.isSafeInteger(itemID) || itemID <= 0 || !identity.characterID) {
    return failure("INVALID_DATA");
  }
  const characterID = Number(identity.characterID);
  try {
    // Settling finishes a retry of a deposit whose reagents already left the ship.
    const retried = settleLeftoverDeposits(hub, mutateHub).find((pending) => (
      pending.characterID === characterID && pending.itemID === itemID && pending.amount === amount
    ));
    if (retried) {
      return { ok: true, hubID: hub.hubID, solarSystemID: hub.solarSystemID, fuelTypeID: retried.fuelTypeID };
    }

    const source = validateSource(hub, identity, session, itemID, amount);
    if (!source.ok) return source;
    if (!inTransferRange(Number(source.item.locationID))) return failure("TARGET_TOO_FAR", 403);
    const fuelTypeID = Number(source.item.typeID);
    if (!Number.isSafeInteger(Number(hub.fuelByTypeID?.[String(fuelTypeID)]?.amount || 0) + amount)) {
      return failure("FUEL_QUANTITY_OUT_OF_RANGE");
    }
    const pending = {
      receiptKey: `sov-hub-fuel:${hub.hubID}:${randomUUID()}`,
      amount, itemID, fuelTypeID, characterID,
      shipID: Number(source.item.locationID), flagID: Number(source.item.flagID),
    };
    mutateHub((current) => {
      current.pendingFuelDeposits = { ...(current.pendingFuelDeposits || {}), [pending.receiptKey]: pending };
    });
    persist();

    const debit = items.consumeInventoryItemQuantityIdempotent(itemID, amount, {
      receiptKey: pending.receiptKey,
      fingerprint: { hubID: hub.hubID, itemID, amount, characterID,
        shipID: pending.shipID, flagID: pending.flagID, fuelTypeID },
    });
    if (!debit.success || !debit.durable) {
      // Nothing was written, so the intent goes now. An unknown outcome stays for
      // the next deposit to settle.
      if (debit.ambiguous === false) dropDeposit(mutateHub, pending.receiptKey);
      return failure(debit.errorMsg || "FUEL_DEBIT_FAILED", 503);
    }

    let mutationFlushPending = false;
    try {
      mutateHub((current) => {
        creditFuel(current, fuelTypeID, amount);
        current.pendingFuelDeposits = withoutDeposits(current.pendingFuelDeposits, new Set([pending.receiptKey]));
      });
    } catch (error) {
      if (error.code !== "HUB_FUEL_PERSISTENCE_FAILED" || error.hubMutationStaged !== true) {
        // The receipt remains in the pending intent for a retry. The client
        // must still remove the item that was already durably consumed.
        notifyInventoryChanges(session, debit);
        throw error;
      }
      mutationFlushPending = true;
    }
    let persistencePending = mutationFlushPending;
    try {
      persist();
    } catch (error) {
      // The debit is durable, so the deposit stands. A later flush keeps the
      // credit, or after a crash the next deposit settles it from the receipt.
      log.debug(`[SovHubFuel] saving the fuel deposit to hub ${hub.hubID} failed: ${error && error.message}`);
      persistencePending = true;
    }
    notifyInventoryChanges(session, debit);
    return { ok: true, hubID: hub.hubID, solarSystemID: hub.solarSystemID, fuelTypeID,
      ...(persistencePending ? { persistencePending: true } : {}) };
  } catch (error) {
    return failure(error.message || "FUEL_DEPOSIT_FAILED", 503);
  }
}

module.exports = { depositHubFuel };
