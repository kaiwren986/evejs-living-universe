"use strict";

// PLEX vault transfers in the inventory broker (invbroker): WithdrawPlexFromVault and
// DepositPlexToVault, the calls the client's PLEX vault and Sell PLEX window make
// (eve/client/script/ui/shared/inventory/plexVault.py, market/sellMulti.py). These are
// InvBrokerService methods; invBrokerService.js puts them on the class prototype.
//
// The client answers each call with a reference and then waits up to 10 s for a result notice
// carrying that reference (vgs/common/listeners.py): OnPlexItemAddedToInventory(itemID,
// reference) or OnPlexWithdrawFailed(errorKey, reference) for a withdrawal, OnPlexDeposited(
// reference) or OnPlexDepositFailed(errorKey, reference) for a deposit. The wallet runs as its own
// process in production, so the vault is debited and credited through its async commands. It registers for them
// only after the call returns, so the notice goes out after the reply.
//
// PLEX leaves the vault only to be sold (owner, 2026-10-28): a VaultToMarket withdrawal puts the
// PLEX in the hangar as a stack for the sell order the client places next; any other withdrawal
// is refused.

const crypto = require("crypto");
const path = require("path");

const {
  adjustCharacterPlexBalanceAsync,
  getCharacterWallet,
} = require(path.join(__dirname, "../../account/walletState"));
const {
  giveItemToHangarForSession,
  syncInventoryItemForSession,
} = require(path.join(__dirname, "../../character/characterState"));
const {
  consumeInventoryItemQuantity,
  findItemById,
} = require(path.join(__dirname, "../itemStore"));
const {
  resolveItemByTypeID,
} = require(path.join(__dirname, "../itemTypeRegistry"));
const log = require(path.join(__dirname, "../../../utils/logger"));

const TYPE_PLEX = 44992;
const INVOICE_VAULT_TO_MARKET = "VaultToMarket";
const RESULT_NOTICE_DELAY_MS = 50;

function newReference() {
  return crypto.randomUUID();
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

function sendResultNotice(session, name, args) {
  setTimeout(() => {
    if (session && typeof session.sendNotification === "function") {
      session.sendNotification(name, "charid", args);
    }
  }, RESULT_NOTICE_DELAY_MS);
}

module.exports = {
  // args: quantity, locationID, invoiceType, flagID, otherPartyID
  async Handle_WithdrawPlexFromVault(args, session) {
    const reference = newReference();
    const charID = positiveInteger(session && (session.characterID || session.charid));
    const quantity = positiveInteger(args && args[0]);
    const invoiceType = String(args && args[2] || "");
    const fail = (errorKey) => {
      log.debug(
        `[PlexVault] withdraw refused char=${charID} quantity=${quantity} invoice=${invoiceType} error=${errorKey}`,
      );
      sendResultNotice(session, "OnPlexWithdrawFailed", [errorKey, reference]);
      return reference;
    };

    if (!charID) {
      return fail("PlexWithdrawalAccountNotFound");
    }
    if (invoiceType !== INVOICE_VAULT_TO_MARKET) {
      return fail("PlexWithdrawalInternalError");
    }
    if (!quantity) {
      return fail("PlexWithdrawalInvalidAmount");
    }
    if (getCharacterWallet(charID).plexBalance < quantity) {
      return fail("PlexWithdrawalInsufficientFunds");
    }
    const plexType = resolveItemByTypeID(TYPE_PLEX);
    if (!plexType) {
      return fail("PlexWithdrawalInternalError");
    }

    const debit = await adjustCharacterPlexBalanceAsync(charID, -quantity, {
      requireSufficientFunds: true,
      description: "PLEX vault to market",
    });
    if (!debit || debit.success !== true) {
      return fail(
        debit && debit.errorMsg === "INSUFFICIENT_FUNDS"
          ? "PlexWithdrawalInsufficientFunds"
          : "PlexWithdrawalInternalError",
      );
    }
    const grant = giveItemToHangarForSession(session, plexType, quantity);
    const items = grant && grant.success && grant.data && Array.isArray(grant.data.items)
      ? grant.data.items
      : [];
    const item = items.find((entry) => Number(entry && entry.typeID) === TYPE_PLEX) || items[0];
    if (!item) {
      await adjustCharacterPlexBalanceAsync(charID, quantity, { description: "PLEX vault refund" });
      return fail("PlexWithdrawalInternalError");
    }
    sendResultNotice(session, "OnPlexItemAddedToInventory", [Number(item.itemID), reference]);
    return reference;
  },

  // args: locationID, itemID, quantity, invoiceType
  async Handle_DepositPlexToVault(args, session) {
    const reference = newReference();
    const charID = positiveInteger(session && (session.characterID || session.charid));
    const itemID = positiveInteger(args && args[1]);
    const quantity = positiveInteger(args && args[2]);
    const fail = (errorKey) => {
      log.debug(
        `[PlexVault] deposit refused char=${charID} item=${itemID} quantity=${quantity} error=${errorKey}`,
      );
      sendResultNotice(session, "OnPlexDepositFailed", [errorKey, reference]);
      return reference;
    };

    if (!charID) {
      return fail("PlexDepositAccountNotFound");
    }
    const item = itemID ? findItemById(itemID) : null;
    if (
      !item ||
      Number(item.typeID) !== TYPE_PLEX ||
      Number(item.ownerID) !== charID ||
      !quantity
    ) {
      return fail("PlexDepositInvalidAmount");
    }
    const consume = consumeInventoryItemQuantity(itemID, quantity);
    if (!consume || consume.success !== true) {
      return fail("PlexDepositInvalidAmount");
    }
    for (const change of (consume.data && consume.data.changes) || []) {
      if (change && change.item) {
        syncInventoryItemForSession(session, change.item, change.previousData || {}, {
          emitCfgLocation: false,
        });
      }
    }
    const credit = await adjustCharacterPlexBalanceAsync(charID, quantity, {
      description: "PLEX inventory to vault",
    });
    if (!credit || credit.success !== true) {
      return fail("PlexDepositInternalError");
    }
    sendResultNotice(session, "OnPlexDeposited", [reference]);
    return reference;
  },
};
