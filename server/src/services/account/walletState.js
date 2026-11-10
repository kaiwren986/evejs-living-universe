"use strict";

const path = require("path");

const sessionRegistry = require(path.join(
  __dirname,
  "../chat/sessionRegistry",
));
const {
  PLEX_LOG_CATEGORY,
  getFileTimeNowString,
  getTransactionID,
  appendCharacterPlexTransaction,
  fileTimeStringToDate,
} = require(path.join(__dirname, "./plexVaultLogState"));
const {
  WALLET_COMMAND_TYPE,
  executeWalletCommand,
  executeWalletCommandAsync,
  isWalletAuthorityProcessEnabled,
  registerWalletCommandHandlers,
} = require(path.join(__dirname, "./walletCommandAuthority"));
const walletAuthorityProjection = require(path.join(
  __dirname,
  "./walletAuthorityProjection",
));
const { MAX_WALLET_BALANCE } = require(path.join(
  __dirname,
  "./walletBalanceLimit",
));
const publicGatewayNotices = require(path.join(
  __dirname,
  "../../_secondary/express/publicGatewayNotices",
));

const ACCOUNT_KEY = {
  CASH: 1000,
  AURUM: 1200,
};
const ACCOUNT_KEY_NAME = {
  CASH: "cash",
  AURUM: "AURUM",
};
const JOURNAL_ENTRY_TYPE = {
  PLAYER_TRADING: 1,
  MARKET_TRANSACTION: 2,
  GM_CASH_TRANSFER: 3,
  CAREER_PROGRAM_PAYOUT: 185,
  PLAYER_DONATION: 10,
  OFFICE_RENTAL_FEE: 13,
  BOUNTY: 16,
  NPC_BOUNTY_PRIZE: 17,
  INSURANCE: 19,
  AGENT_MISSION_REWARD: 33,
  AGENT_MISSION_TIME_BONUS_REWARD: 34,
  CORPORATION_REGISTRATION_FEE: 39,
  RELEASE_OF_IMPOUNDED_PROPERTY: 41,
  MARKET_ESCROW: 42,
  BROKERS_FEE: 46,
  ALLIANCE_REGISTRATION_FEE: 48,
  // appConst.refWarFee: "Fee for war against {name}", the defender in arg1 (walletEntryFormat.py).
  WAR_FEE: 49,
  ALLIANCE_MAINTENANCE_FEE: 50,
  // appConst.refContrabandFine: a fine for contraband smuggling, as the client's journal names and words it.
  CONTRABAND_FINE: 51,
  TRANSACTION_TAX: 54,
  CONTRACT_BROKERS_FEE: 72,
  CONTRACT_BROKERS_FEE_CORP: 80,
  NPC_BOUNTY_PRIZES: 85,
  ESS_MAIN_BANK_AUTOPAYMENT: 155, // appConst.refESSMainBankAutopayment, build 3396210.
  // refCorporationTaxNpcBounties: the corporation's cut of an NPC bounty prize
  // (17 or 85). The client's journal reads a row's type name before any None
  // check, so this must stay registered in accountService's entry types too.
  CORPORATION_TAX_NPC_BOUNTIES: 92,
  CORPORATION_TAX_AGENT_REWARDS: 93,
  CORPORATION_TAX_AGENT_BONUS_REWARDS: 94,
  PLANETARY_IMPORT_TAX: 96,
  PLANETARY_EXPORT_TAX: 97,
  PLANETARY_CONSTRUCTION: 98,
  CORPORATE_REWARD_PAYOUT: 99,
  JUMP_CLONE_INSTALLATION: 55,
  JUMP_CLONE_ACTIVATION: 128,
  SKILL_PURCHASE: 141,
  MARKET_PROVIDER_TAX: 149,
  // appConst.refDatacoreFee -- the ISK half of an R&D datacore purchase.
  DATACORE_FEE: 112,
  // Installed appConst.refAssetSafetyTax; charged when items leave a safety wrap.
  ASSET_SAFETY_TAX: 123,
  STRUCTURE_GATE_JUMP: 140,
};
JOURNAL_ENTRY_TYPE.ADMIN_ADJUSTMENT = JOURNAL_ENTRY_TYPE.GM_CASH_TRANSFER;
const JOURNAL_CURRENCY = {
  ISK: 1,
  AURUM: 2,
};
const DEFAULT_WALLET = {
  balance: 100000.0,
  aurBalance: 0.0,
  plexBalance: 2222,
  balanceChange: 0.0,
};
const MAX_JOURNAL_ENTRIES = 100;
const MAX_MARKET_TRANSACTION_ENTRIES = 2000;
const MAX_WALLET_OPERATION_RECEIPTS = 512;

function getCharacterState() {
  return process.env.EVEJS_WALLET_AUTHORITY_OWNER === "1"
    ? require(path.join(__dirname, "./walletAuthorityOwnerState"))
    : require(path.join(__dirname, "../character/characterState"));
}

function publishPlexBalanceChangedNotice(characterID, balanceInCents, deltaInCents) {
  const gateway = publicGatewayNotices.getPublicGateway();
  return gateway && typeof gateway.publishPlexBalanceChangedNotice === "function"
    ? gateway.publishPlexBalanceChangedNotice(
        characterID,
        balanceInCents,
        deltaInCents,
      )
    : null;
}

function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeWalletIdempotencyKey(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const key = String(value).trim();
  return key.length > 0 && key.length <= 320 ? key : "";
}

function buildWalletAdjustmentFingerprint(charId, amount, options = {}) {
  return JSON.stringify({
    charId: Number(charId || 0) || 0,
    amount: normalizeMoney(amount, 0),
    referenceID: Number(options.referenceID || options.ownerID2 || 0) || 0,
    entryTypeID:
      Number(options.entryTypeID || JOURNAL_ENTRY_TYPE.ADMIN_ADJUSTMENT) || 0,
    ownerID1: Number(options.ownerID1 || charId || 0) || 0,
    ownerID2: Number(options.ownerID2 || 0) || 0,
    accountKey: Number(options.accountKey || ACCOUNT_KEY.CASH) || ACCOUNT_KEY.CASH,
    description: resolveLedgerReason(options, "Wallet balance change"),
    currency:
      Number(options.currency || JOURNAL_CURRENCY.ISK) || JOURNAL_CURRENCY.ISK,
    ...(options.minimumBalance !== undefined ? { minimumBalance: options.minimumBalance } : {}),
  });
}

function buildPlexAdjustmentFingerprint(charId, amount, options = {}) {
  const categoryMessageID =
    Number(options.categoryMessageID || 0) || PLEX_LOG_CATEGORY.CCP;
  return JSON.stringify({
    charId: Number(charId || 0) || 0,
    amount: normalizePlexDelta(amount, 0),
    categoryMessageID,
    summaryMessageID:
      Number(options.summaryMessageID || 0) || categoryMessageID,
    summaryText: String(options.summaryText || ""),
    reason: resolveLedgerReason(options, "No details given"),
    recordTransaction: options.recordTransaction !== false,
    requireSufficientFunds: options.requireSufficientFunds === true,
  });
}

function findWalletOperationReceipt(record, idempotencyKey) {
  if (/^crew-equipment:(mining|hauling|manufacturing):[1-3]$/.test(idempotencyKey)) return record.crewEquipmentWalletReceipts?.[idempotencyKey] || null;
  const crew = /^crew-buy-wallet:(\d+):[a-f0-9]{64}:(debit|refund)$/.exec(idempotencyKey);
  if (crew) { const prior = record.crewPurchaseWalletReceipts?.[crew[2]]; return prior?.serial >= Number(crew[1]) ? prior : null; }
  if (idempotencyKey.startsWith("incursion:")) return record.incursionWalletReceipts?.[idempotencyKey] || null;
  if (idempotencyKey.startsWith("discovery:")) return record.discoveryWalletReceipts?.[idempotencyKey] || null;
  if (idempotencyKey.startsWith("campaign:")) return record.campaignWalletReceipts?.[idempotencyKey] || null;
  if (idempotencyKey.startsWith("contract:") && record.contractWalletReceipts?.[idempotencyKey]) return record.contractWalletReceipts[idempotencyKey];
  if (idempotencyKey.startsWith("freelance:")) return record.freelanceWalletReceipts?.[idempotencyKey] || null;
  if (idempotencyKey.startsWith("nodegraph:")) return record.nodeGraphWalletReceipts?.[idempotencyKey] || null;
  return Array.isArray(record && record.walletOperationReceipts)
    ? record.walletOperationReceipts.find(
        (receipt) => receipt && receipt.idempotencyKey === idempotencyKey,
      ) || null
    : null;
}

function appendWalletOperationReceipt(record, receipt) {
  // Nine permanent supplier receipts per pilot; ordinary wallet-history pruning
  // must never allow an interrupted equipment purchase to charge again.
  if (/^crew-equipment:(mining|hauling|manufacturing):[1-3]$/.test(receipt.idempotencyKey)) {
    record.crewEquipmentWalletReceipts = { ...(record.crewEquipmentWalletReceipts || {}), [receipt.idempotencyKey]: cloneValue(receipt) }; return;
  }
  const crew = /^crew-buy-wallet:(\d+):[a-f0-9]{64}:(debit|refund)$/.exec(receipt.idempotencyKey);
  if (crew) { record.crewPurchaseWalletReceipts = { ...(record.crewPurchaseWalletReceipts || {}), [crew[2]]: { ...cloneValue(receipt), serial: Number(crew[1]) } }; return; }
  if (receipt.idempotencyKey.startsWith("incursion:")) {
    record.incursionWalletReceipts = { ...(record.incursionWalletReceipts || {}), [receipt.idempotencyKey]: cloneValue(receipt) };
    return;
  }
  if (receipt.idempotencyKey.startsWith("discovery:")) {
    record.discoveryWalletReceipts = { ...(record.discoveryWalletReceipts || {}), [receipt.idempotencyKey]: cloneValue(receipt) };
    return;
  }
  if (receipt.idempotencyKey.startsWith("campaign:")) {
    record.campaignWalletReceipts = { ...(record.campaignWalletReceipts || {}), [receipt.idempotencyKey]: cloneValue(receipt) };
    return;
  }
  if (receipt.idempotencyKey.startsWith("contract:")) {
    record.contractWalletReceipts = { ...(record.contractWalletReceipts || {}), [receipt.idempotencyKey]: cloneValue(receipt) };
    return;
  }
  if (receipt.idempotencyKey.startsWith("freelance:")) {
    record.freelanceWalletReceipts = { ...(record.freelanceWalletReceipts || {}), [receipt.idempotencyKey]: cloneValue(receipt) };
    return;
  }
  if (receipt.idempotencyKey.startsWith("nodegraph:")) {
    record.nodeGraphWalletReceipts = { ...(record.nodeGraphWalletReceipts || {}), [receipt.idempotencyKey]: cloneValue(receipt) };
    return;
  }
  const receipts = Array.isArray(record && record.walletOperationReceipts)
    ? record.walletOperationReceipts.filter(
        (candidate) =>
          candidate && candidate.idempotencyKey !== receipt.idempotencyKey,
      )
    : [];
  receipts.unshift(cloneValue(receipt));
  record.walletOperationReceipts = receipts.slice(0, MAX_WALLET_OPERATION_RECEIPTS);
}

function normalizeMoney(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }

  return Math.round(numeric * 100) / 100;
}

function buildMarshalRealMoney(value, fallback = 0) {
  return {
    type: "real",
    value: normalizeMoney(value, fallback),
  };
}

function buildNotEnoughMoneyUserErrorValues(requiredAmount, currentBalance) {
  return {
    balance: normalizeMoney(currentBalance, 0),
    amount: normalizeMoney(requiredAmount, 0),
  };
}

function normalizePlex(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }

  return Math.max(0, Math.trunc(numeric));
}

function normalizePlexDelta(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }

  return Math.trunc(numeric);
}

function resolveLedgerReason(options = {}, fallback = "No details given") {
  for (const key of ["reason", "description"]) {
    if (
      Object.prototype.hasOwnProperty.call(options, key) &&
      typeof options[key] === "string"
    ) {
      return options[key];
    }
  }
  return fallback;
}

function getCharacterWallet(charId) {
  const projected = walletAuthorityProjection.getCharacterBalanceProjection(charId);
  if (projected) {
    return {
      characterID: Number(charId),
      balance: normalizeMoney(projected.balance, DEFAULT_WALLET.balance),
      aurBalance: normalizeMoney(projected.aurBalance, DEFAULT_WALLET.aurBalance),
      plexBalance: normalizePlex(projected.plexBalance, DEFAULT_WALLET.plexBalance),
      balanceChange: normalizeMoney(
        projected.balanceChange,
        DEFAULT_WALLET.balanceChange,
      ),
    };
  }
  const record = getCharacterState().getCharacterRecord(charId);
  if (!record) {
    return null;
  }

  return {
    characterID: Number(charId),
    balance: normalizeMoney(record.balance, DEFAULT_WALLET.balance),
    aurBalance: normalizeMoney(record.aurBalance, DEFAULT_WALLET.aurBalance),
    plexBalance: normalizePlex(record.plexBalance, DEFAULT_WALLET.plexBalance),
    balanceChange: normalizeMoney(
      record.balanceChange,
      DEFAULT_WALLET.balanceChange,
    ),
  };
}

function getCharacterWalletJournal(charId) {
  const projected = walletAuthorityProjection.getCharacterProjection(charId);
  if (projected) {
    return Array.isArray(projected.walletJournal)
      ? projected.walletJournal.map((entry) => cloneValue(entry))
      : [];
  }
  const record = getCharacterState().getCharacterRecord(charId);
  if (!record || !Array.isArray(record.walletJournal)) {
    return [];
  }

  return record.walletJournal.map((entry) => cloneValue(entry));
}

function appendLimitedRecordEntry(record, fieldName, entry, maxEntries) {
  const nextEntries = Array.isArray(record && record[fieldName])
    ? record[fieldName].map((candidate) => cloneValue(candidate))
    : [];
  nextEntries.unshift(cloneValue(entry));
  record[fieldName] = nextEntries.slice(0, maxEntries);
}

function appendWalletJournalEntry(record, entry) {
  appendLimitedRecordEntry(record, "walletJournal", entry, MAX_JOURNAL_ENTRIES);
}

function normalizeFileTimeString(value, fallback = null) {
  if (typeof value === "string" && value.trim() !== "") {
    return value;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(Math.trunc(value));
  }
  return fallback || getFileTimeNowString();
}

function normalizeMarketTransactionEntry(entry = {}) {
  const transactionID = Number(entry.transactionID);
  return {
    transactionID: Number.isFinite(transactionID) ? Math.trunc(transactionID) : getTransactionID(),
    transactionDate: normalizeFileTimeString(entry.transactionDate),
    typeID: Math.max(0, Math.trunc(Number(entry.typeID) || 0)),
    quantity: Math.max(0, Math.trunc(Number(entry.quantity) || 0)),
    price: normalizeMoney(entry.price, 0),
    stationID: Math.max(0, Math.trunc(Number(entry.stationID) || 0)),
    locationID: Math.max(
      0,
      Math.trunc(Number(entry.locationID ?? entry.stationID) || 0),
    ),
    buyerID: Math.max(0, Math.trunc(Number(entry.buyerID) || 0)),
    sellerID: Math.max(0, Math.trunc(Number(entry.sellerID) || 0)),
    clientID: Math.max(0, Math.trunc(Number(entry.clientID) || 0)),
    accountID: Math.max(
      0,
      Math.trunc(Number(entry.accountID || ACCOUNT_KEY.CASH) || ACCOUNT_KEY.CASH),
    ),
    buyerAccountID: Math.max(
      0,
      Math.trunc(
        Number(entry.buyerAccountID || ACCOUNT_KEY.CASH) || ACCOUNT_KEY.CASH,
      ),
    ),
    sellerAccountID: Math.max(
      0,
      Math.trunc(
        Number(entry.sellerAccountID || ACCOUNT_KEY.CASH) || ACCOUNT_KEY.CASH,
      ),
    ),
    journalRefID: Math.trunc(Number(entry.journalRefID ?? entry.journal_ref_id) || -1),
  };
}

function getCharacterMarketTransactions(charId) {
  const projected = walletAuthorityProjection.getCharacterProjection(charId);
  if (projected) {
    return [...(Array.isArray(projected.marketTransactions)
      ? projected.marketTransactions
      : [])]
      .map((entry) => normalizeMarketTransactionEntry(cloneValue(entry)))
      .sort((left, right) => right.transactionID - left.transactionID);
  }
  const record = getCharacterState().getCharacterRecord(charId);
  if (!record || !Array.isArray(record.marketTransactions)) {
    return [];
  }

  return [...record.marketTransactions]
    .map((entry) => normalizeMarketTransactionEntry(cloneValue(entry)))
    .sort((left, right) => right.transactionID - left.transactionID);
}

function applyAppendCharacterMarketTransaction({ charId, entry }) {
  const normalizedEntry = normalizeMarketTransactionEntry(entry);
  const writeResult = getCharacterState().updateCharacterRecord(charId, (record) => {
    appendLimitedRecordEntry(
      record,
      "marketTransactions",
      normalizedEntry,
      MAX_MARKET_TRANSACTION_ENTRIES,
    );
    return record;
  });

  // Deliberately does NOT spread writeResult. In the wallet owner process
  // updateCharacterRecord answers with the entire owner record in `data`, and
  // the authority persists a command's result inside that same record's
  // walletAuthorityReceipts list -- so returning it made every append store a
  // full copy of the record, receipt list included, and the stored record
  // doubled in size per market transaction. No caller reads `data` here.
  return writeResult && writeResult.success === true
    ? { success: true, entry: normalizedEntry }
    : {
        success: false,
        errorMsg: (writeResult && writeResult.errorMsg) || "WRITE_ERROR",
        entry: normalizedEntry,
      };
}

function applyCharacterWalletProjection(record, charId) {
  if (!isWalletAuthorityProcessEnabled()) {
    return record;
  }
  const projected = walletAuthorityProjection.getCharacterProjection(charId);
  if (!record || typeof record !== "object" || !projected) {
    return record;
  }
  record.balance = normalizeMoney(projected.balance, DEFAULT_WALLET.balance);
  record.aurBalance = normalizeMoney(
    projected.aurBalance,
    DEFAULT_WALLET.aurBalance,
  );
  record.plexBalance = normalizePlex(
    projected.plexBalance,
    DEFAULT_WALLET.plexBalance,
  );
  record.balanceChange = normalizeMoney(
    projected.balanceChange,
    DEFAULT_WALLET.balanceChange,
  );
  for (const fieldName of [
    "walletJournal",
    "marketTransactions",
    "plexVaultTransactions",
  ]) {
    record[fieldName] = Array.isArray(projected[fieldName])
      ? projected[fieldName].map((entry) => cloneValue(entry))
      : [];
  }
  return record;
}

function appendCharacterMarketTransaction(charId, entry) {
  return executeWalletCommand(
    WALLET_COMMAND_TYPE.CHARACTER_APPEND_MARKET_TRANSACTION,
    { charId, entry },
  );
}

async function appendCharacterMarketTransactionAsync(charId, entry, metadata = {}) {
  return executeWalletCommandAsync(
    WALLET_COMMAND_TYPE.CHARACTER_APPEND_MARKET_TRANSACTION,
    { charId, entry },
    metadata,
  );
}

function normalizeTransactionDateParts(entry) {
  const date = fileTimeStringToDate(entry && entry.transactionDate);
  return {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
  };
}

function isEntryWithinLast30Days(entry) {
  const entryDate = fileTimeStringToDate(entry && entry.transactionDate);
  if (Number.isNaN(entryDate.valueOf())) {
    return false;
  }
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  return entryDate.getTime() >= thirtyDaysAgo;
}

function getCharacterWalletTransactions(charId, options = {}) {
  const accountKey = Number(options.accountKey || ACCOUNT_KEY.CASH) || ACCOUNT_KEY.CASH;
  const year = Number(options.year);
  const month = Number(options.month);
  const hasMonthFilter = Number.isFinite(year) && Number.isFinite(month);

  return getCharacterWalletJournal(charId).filter((entry) => {
    if (
      (Number(entry && entry.accountKey) || ACCOUNT_KEY.CASH) !== accountKey
    ) {
      return false;
    }

    if (hasMonthFilter) {
      const dateParts = normalizeTransactionDateParts(entry);
      return dateParts.year === year && dateParts.month === month;
    }

    return isEntryWithinLast30Days(entry);
  });
}

function syncWalletToSession(session, wallet) {
  if (!session || !wallet) {
    return;
  }

  session.balance = wallet.balance;
  session.aurBalance = wallet.aurBalance;
  session.plexBalance = wallet.plexBalance;
  session.balanceChange = wallet.balanceChange;
}

function emitAccountChangeToSession(session, options = {}) {
  if (!session || typeof session.sendNotification !== "function") {
    return;
  }

  const accountKey = options.accountKey || ACCOUNT_KEY_NAME.CASH;
  const ownerID =
    Number(options.ownerID || session.characterID || session.userid || 0) || 0;
  const balance = normalizeMoney(options.balance, 0);

  session.sendNotification("OnAccountChange", "clientID", [
    accountKey,
    ownerID,
    buildMarshalRealMoney(balance, 0),
  ]);
}

function notifyCharacterWalletChange(charId, wallet, options = {}) {
  const sessions = sessionRegistry
    .getSessions()
    .filter(
      (session) => Number(session.characterID || 0) === Number(charId || 0),
    );

  for (const session of sessions) {
    syncWalletToSession(session, wallet);
    emitAccountChangeToSession(session, {
      accountKey: options.accountKey || ACCOUNT_KEY_NAME.CASH,
      ownerID: charId,
      balance:
        options.balance !== undefined && options.balance !== null
          ? options.balance
          : wallet.balance,
    });
  }
}

// The client hears of a PLEX change only through the public gateway's
// BalanceChangedNotice (plex/client/message_bus/notice_listener.py); it has no
// listener for a macho notification, so none is sent. The live sessions keep
// their wallet fields in step.
function notifyCharacterPlexBalanceChange(charId, wallet) {
  const sessions = sessionRegistry
    .getSessions()
    .filter(
      (session) => Number(session.characterID || 0) === Number(charId || 0),
    );

  for (const session of sessions) {
    syncWalletToSession(session, wallet);
  }
}

// Which wallet, if any, a wallet command's result may announce to the client.
//
// A duplicate is a command the wallet authority had already committed, answered
// from its receipt instead of being executed again. The balance in that receipt
// is as of the original commit, so it is never announced. Two things produce a
// duplicate:
//
//   - A retry of this same command. The transport resends after the authority
//     process exits or a request times out, and the first attempt may already
//     have committed without the client hearing about it. Announcing nothing
//     would leave the player looking at a balance from before a charge that did
//     happen, so the wallet as it stands now is announced instead.
//   - A commandID collision, flagged fingerprintMismatch. The receipt belongs to
//     another operation and no money moved for this one, so nothing is announced.
function resolveAnnouncedCharacterWallet(charId, result, committedWallet) {
  if (!result || result.success !== true) {
    return null;
  }
  if (result.duplicate !== true) {
    return committedWallet;
  }
  return result.fingerprintMismatch === true ? null : getCharacterWallet(charId);
}

function announceCharacterIskResult(charId, result, committedWallet, accountKey) {
  const wallet = resolveAnnouncedCharacterWallet(charId, result, committedWallet);
  if (wallet) {
    notifyCharacterWalletChange(charId, wallet, {
      accountKey,
      balance: wallet.balance,
    });
  }
}

function announceCharacterPlexResult(charId, result) {
  const wallet = resolveAnnouncedCharacterWallet(charId, result, result && result.data);
  if (!wallet) {
    return;
  }
  if (result.duplicate === true) {
    // The client may already have shown this delta, and the gateway notice is
    // a change feed, so a replay only refreshes the sessions' wallet fields.
    notifyCharacterPlexBalanceChange(charId, wallet);
    return;
  }
  notifyCharacterPlexBalanceChange(charId, wallet);
  publishPlexBalanceChangedNotice(charId, wallet.plexBalance, result.delta);
}

function applySetCharacterBalance({
  charId,
  nextBalance,
  options = {},
  idempotencyReceipt = null,
}) {
  const currentWallet = getCharacterWallet(charId);
  if (!currentWallet) {
    return {
      success: false,
      errorMsg: "CHARACTER_NOT_FOUND",
    };
  }

  const requestedBalance = normalizeMoney(nextBalance, currentWallet.balance);
  if (requestedBalance < 0) {
    return {
      success: false,
      errorMsg: "INSUFFICIENT_FUNDS",
    };
  }
  // Every character ISK write lands here, so this is the one place the wallet
  // limit has to hold. A credit past it stops at it; the excess is not kept.
  const normalizedBalance = Math.min(requestedBalance, MAX_WALLET_BALANCE);
  const capped = normalizedBalance < requestedBalance;

  const delta = normalizeMoney(normalizedBalance - currentWallet.balance, 0);
  const journalEntry = {
    transactionID: getTransactionID(),
    transactionDate: getFileTimeNowString(),
    referenceID: Number(options.referenceID || options.ownerID2 || 0) || 0,
    entryTypeID:
      Number(options.entryTypeID || JOURNAL_ENTRY_TYPE.ADMIN_ADJUSTMENT) || 0,
    ownerID1: Number(options.ownerID1 || charId || 0) || 0,
    ownerID2: Number(options.ownerID2 || 0) || 0,
    accountKey: Number(options.accountKey || ACCOUNT_KEY.CASH) || ACCOUNT_KEY.CASH,
    amount: delta,
    balance: normalizedBalance,
    description: resolveLedgerReason(options, "Wallet balance change"),
    currency:
      Number(options.currency || JOURNAL_CURRENCY.ISK) || JOURNAL_CURRENCY.ISK,
    sortValue: 1,
  };

  const updatedWallet = {
    ...currentWallet,
    balance: normalizedBalance,
    balanceChange: delta,
  };
  const receiptResult = {
    data: updatedWallet,
    previousBalance: currentWallet.balance,
    delta,
    journalEntry,
    ...(capped ? { capped: true } : {}),
  };

  const writeResult = getCharacterState().updateCharacterRecord(charId, (record) => {
    record.balance = normalizedBalance;
    record.balanceChange = delta;
    appendWalletJournalEntry(record, journalEntry);
    if (idempotencyReceipt) {
      appendWalletOperationReceipt(record, {
        ...idempotencyReceipt,
        result: receiptResult,
      });
    }
    return record;
  });

  if (!writeResult.success) {
    return writeResult;
  }

  return {
    success: true,
    ...receiptResult,
    ...(idempotencyReceipt ? { duplicate: false } : {}),
  };
}

function setCharacterBalance(charId, nextBalance, options = {}) {
  const result = executeWalletCommand(WALLET_COMMAND_TYPE.CHARACTER_SET_ISK, {
    charId,
    nextBalance,
    options,
  });
  if (result && result.success) {
    notifyCharacterWalletChange(charId, result.data, {
      accountKey: options.accountKeyName || ACCOUNT_KEY_NAME.CASH,
      balance: result.data.balance,
    });
  }
  return result;
}

async function setCharacterBalanceAsync(charId, nextBalance, options = {}, metadata = {}) {
  const result = await executeWalletCommandAsync(
    WALLET_COMMAND_TYPE.CHARACTER_SET_ISK,
    { charId, nextBalance, options },
    metadata,
  );
  announceCharacterIskResult(
    charId,
    result,
    result && result.data,
    options.accountKeyName || ACCOUNT_KEY_NAME.CASH,
  );
  return result;
}

function applyAdjustCharacterBalance({ charId, amount, options = {} }) {
  const characterState = getCharacterState();
  const currentRecord = characterState.getCharacterRecord(charId);
  if (!currentRecord) {
    return {
      success: false,
      errorMsg: "CHARACTER_NOT_FOUND",
    };
  }

  const delta = normalizeMoney(amount, 0);
  const normalizedOptions = {
    ...options,
    description: resolveLedgerReason(
      options,
      delta >= 0 ? "Wallet credit" : "Wallet debit",
    ),
  };
  const idempotencyKey = normalizeWalletIdempotencyKey(options.idempotencyKey);
  if (idempotencyKey === "") {
    return {
      success: false,
      errorMsg: "IDEMPOTENCY_KEY_INVALID",
    };
  }
  const fingerprint = idempotencyKey
    ? buildWalletAdjustmentFingerprint(charId, delta, normalizedOptions)
    : null;
  if (idempotencyKey) {
    const receipt = findWalletOperationReceipt(currentRecord, idempotencyKey);
    if (receipt) {
      // Older accepted ACP claims used reference 3. Keep their permanent
      // economic receipt payable without rewriting the historical journal or
      // authorizing a different amount, owner, account or description.
      const compatibleCareerReceipt = options.allowLegacyCareerJournalReceipt === true &&
        idempotencyKey.startsWith("campaign:") && delta > 0 &&
        normalizedOptions.entryTypeID === JOURNAL_ENTRY_TYPE.CAREER_PROGRAM_PAYOUT &&
        normalizedOptions.description === "AIR Career Program reward" &&
        receipt.fingerprint === buildWalletAdjustmentFingerprint(charId, delta,
          { ...normalizedOptions, entryTypeID: JOURNAL_ENTRY_TYPE.GM_CASH_TRANSFER });
      if (receipt.fingerprint !== fingerprint && !compatibleCareerReceipt) {
        return {
          success: false,
          errorMsg: "IDEMPOTENCY_KEY_REUSED",
        };
      }
      return {
        success: true,
        ...cloneValue(receipt.result),
        duplicate: true,
      };
    }
    if (idempotencyKey.startsWith("nodegraph:") && Object.keys(currentRecord.nodeGraphWalletReceipts || {}).length >= 8192) {
      return { success: false, errorMsg: "NODEGRAPH_WALLET_RECEIPT_LIMIT" };
    }
    if (idempotencyKey.startsWith("incursion:") && Object.keys(currentRecord.incursionWalletReceipts || {}).length >= 8192) {
      return { success: false, errorMsg: "INCURSION_WALLET_RECEIPT_LIMIT" };
    }
    if (idempotencyKey.startsWith("contract:") && Object.keys(currentRecord.contractWalletReceipts || {}).length >= 8192) {
      return { success: false, errorMsg: "CONTRACT_WALLET_RECEIPT_LIMIT" };
    }
    if (idempotencyKey.startsWith("freelance:") && Object.keys(currentRecord.freelanceWalletReceipts || {}).length >= 8192) {
      return { success: false, errorMsg: "FREELANCE_WALLET_RECEIPT_LIMIT" };
    }
    if (idempotencyKey.startsWith("discovery:") && Object.keys(currentRecord.discoveryWalletReceipts || {}).length >= 8192) {
      return { success: false, errorMsg: "DISCOVERY_WALLET_RECEIPT_LIMIT" };
    }
    if (idempotencyKey.startsWith("campaign:") && Object.keys(currentRecord.campaignWalletReceipts || {}).length >= 8192) {
      return { success: false, errorMsg: "CAMPAIGN_WALLET_RECEIPT_LIMIT" };
    }
  }

  const currentWallet = getCharacterWallet(charId);
  if (options.minimumBalance !== undefined && (!Number.isFinite(options.minimumBalance) || options.minimumBalance < 0)) return { success: false, errorMsg: "WALLET_RESERVE_INVALID" };
  if (delta < 0 && options.minimumBalance !== undefined && normalizeMoney(currentWallet.balance + delta, 0) < options.minimumBalance) return { success: false, errorMsg: "WALLET_RESERVE" };
  if ((idempotencyKey?.startsWith("nodegraph:") || options.requireExactCredit === true) && currentWallet.balance + delta > MAX_WALLET_BALANCE) {
    return { success: false, errorMsg: "WALLET_LIMIT" };
  }
  return applySetCharacterBalance({
    charId,
    nextBalance: currentWallet.balance + delta,
    options: normalizedOptions,
    idempotencyReceipt: idempotencyKey
      ? { idempotencyKey, fingerprint }
      : null,
  });
}

function adjustCharacterBalance(charId, amount, options = {}) {
  const result = executeWalletCommand(WALLET_COMMAND_TYPE.CHARACTER_ADJUST_ISK, {
    charId,
    amount,
    options,
  });
  if (result && result.success && result.duplicate !== true) {
    notifyCharacterWalletChange(charId, result.data, {
      accountKey: options.accountKeyName || ACCOUNT_KEY_NAME.CASH,
      balance: result.data.balance,
    });
  }
  return result;
}

async function adjustCharacterBalanceAsync(charId, amount, options = {}, metadata = {}) {
  const result = await executeWalletCommandAsync(
    WALLET_COMMAND_TYPE.CHARACTER_ADJUST_ISK,
    { charId, amount, options },
    metadata,
  );
  // Contract journals may acknowledge this leg immediately. In local execution
  // the owner record and its permanent receipt must reach SQLite first; process
  // execution already provides this barrier inside the wallet owner.
  if (result?.success && ["contract-settlement", "campaign-redemption", "career-reward", "incursion-settlement"].includes(metadata.source) && !isWalletAuthorityProcessEnabled()) {
    const database = require("../../gameStore");
    const committed = database.flushTableSync("characters");
    if (!committed?.success) return committed || { success: false, errorMsg: "CONTRACT_WALLET_FLUSH_FAILED" };
  }
  announceCharacterIskResult(
    charId,
    result,
    result && result.data,
    options.accountKeyName || ACCOUNT_KEY_NAME.CASH,
  );
  return result;
}

function applyTransferCharacterBalance({
  fromCharId,
  toCharId,
  amount,
  options = {},
}) {
  const normalizedAmount = normalizeMoney(amount, 0);
  if (!(normalizedAmount > 0)) {
    return {
      success: false,
      errorMsg: "AMOUNT_REQUIRED",
    };
  }

  const sourceWallet = getCharacterWallet(fromCharId);
  const targetWallet = getCharacterWallet(toCharId);
  if (!sourceWallet || !targetWallet) {
    return {
      success: false,
      errorMsg: "CHARACTER_NOT_FOUND",
    };
  }

  if (sourceWallet.balance < normalizedAmount) {
    return {
      success: false,
      errorMsg: "INSUFFICIENT_FUNDS",
    };
  }
  // Refused before the debit: nothing rolls a debit back, and a credit past
  // the wallet limit would silently lose the excess.
  if (targetWallet.balance + normalizedAmount > MAX_WALLET_BALANCE) {
    return {
      success: false,
      errorMsg: "BALANCE_LIMIT_EXCEEDED",
    };
  }

  const description = resolveLedgerReason(
    options,
    `Transfer to ${Number(toCharId || 0)}`,
  );
  const debitResult = applyAdjustCharacterBalance({
    charId: fromCharId,
    amount: -normalizedAmount,
    options: {
      description,
      ownerID1: fromCharId,
      ownerID2: toCharId,
      referenceID: toCharId,
      entryTypeID: JOURNAL_ENTRY_TYPE.PLAYER_DONATION,
    },
  });
  if (!debitResult.success) {
    return debitResult;
  }

  const creditResult = applyAdjustCharacterBalance({
    charId: toCharId,
    amount: normalizedAmount,
    options: {
      description,
      ownerID1: fromCharId,
      ownerID2: toCharId,
      referenceID: fromCharId,
      entryTypeID: JOURNAL_ENTRY_TYPE.PLAYER_DONATION,
    },
  });
  if (!creditResult.success) {
    return creditResult;
  }

  return {
    success: true,
    from: debitResult.data,
    to: creditResult.data,
    amount: normalizedAmount,
  };
}

function transferCharacterBalance(fromCharId, toCharId, amount, options = {}) {
  const result = executeWalletCommand(WALLET_COMMAND_TYPE.CHARACTER_TRANSFER_ISK, {
    fromCharId,
    toCharId,
    amount,
    options,
  });
  if (result && result.success) {
    notifyCharacterWalletChange(fromCharId, result.from, {
      accountKey: ACCOUNT_KEY_NAME.CASH,
      balance: result.from.balance,
    });
    notifyCharacterWalletChange(toCharId, result.to, {
      accountKey: ACCOUNT_KEY_NAME.CASH,
      balance: result.to.balance,
    });
  }
  return result;
}

async function transferCharacterBalanceAsync(
  fromCharId,
  toCharId,
  amount,
  options = {},
  metadata = {},
) {
  const result = await executeWalletCommandAsync(
    WALLET_COMMAND_TYPE.CHARACTER_TRANSFER_ISK,
    { fromCharId, toCharId, amount, options },
    metadata,
  );
  announceCharacterIskResult(
    fromCharId,
    result,
    result && result.from,
    ACCOUNT_KEY_NAME.CASH,
  );
  announceCharacterIskResult(
    toCharId,
    result,
    result && result.to,
    ACCOUNT_KEY_NAME.CASH,
  );
  return result;
}

function applySetCharacterPlexBalance({
  charId,
  nextBalance,
  options = {},
  idempotencyReceipt = null,
}) {
  const currentWallet = getCharacterWallet(charId);
  if (!currentWallet) {
    return {
      success: false,
      errorMsg: "CHARACTER_NOT_FOUND",
    };
  }

  const normalizedBalance = normalizePlex(
    nextBalance,
    currentWallet.plexBalance,
  );
  const delta = normalizedBalance - currentWallet.plexBalance;
  const updatedWallet = {
    ...currentWallet,
    plexBalance: normalizedBalance,
  };
  const receiptResult = {
    data: updatedWallet,
    previousBalance: currentWallet.plexBalance,
    delta,
    transaction: null,
  };
  const writeResult = getCharacterState().updateCharacterRecord(charId, (record) => {
    record.plexBalance = normalizedBalance;
    if (idempotencyReceipt) {
      appendWalletOperationReceipt(record, {
        ...idempotencyReceipt,
        result: receiptResult,
      });
    }
    return record;
  });
  if (!writeResult.success) {
    return writeResult;
  }

  let plexTransaction = null;
  if (delta !== 0 && options.recordTransaction !== false) {
    const reason = resolveLedgerReason(options, "No details given");
    const categoryMessageID =
      Number(options.categoryMessageID || 0) || PLEX_LOG_CATEGORY.CCP;
    const logResult = appendCharacterPlexTransaction(charId, {
      transactionID: Number(options.transactionID || 0) || getTransactionID(),
      transactionDate: normalizeFileTimeString(options.transactionDate),
      amount: delta,
      balance: normalizedBalance,
      categoryMessageID,
      summaryMessageID:
        Number(options.summaryMessageID || 0) || categoryMessageID,
      summaryText: options.summaryText || reason,
      reason,
    });
    if (logResult && logResult.success) {
      plexTransaction = logResult.entry;
    }
  }

  return {
    success: true,
    data: updatedWallet,
    previousBalance: currentWallet.plexBalance,
    delta,
    transaction: plexTransaction,
    ...(idempotencyReceipt ? { duplicate: false } : {}),
  };
}

function setCharacterPlexBalance(charId, nextBalance, options = {}) {
  const result = executeWalletCommand(WALLET_COMMAND_TYPE.CHARACTER_SET_PLEX, {
    charId,
    nextBalance,
    options,
  });
  if (result && result.success) {
    notifyCharacterPlexBalanceChange(charId, result.data);
    publishPlexBalanceChangedNotice(
      charId,
      result.data.plexBalance,
      result.delta,
    );
  }
  return result;
}

async function setCharacterPlexBalanceAsync(charId, nextBalance, options = {}, metadata = {}) {
  const result = await executeWalletCommandAsync(
    WALLET_COMMAND_TYPE.CHARACTER_SET_PLEX,
    { charId, nextBalance, options },
    metadata,
  );
  announceCharacterPlexResult(charId, result);
  return result;
}

function applyAdjustCharacterPlexBalance({ charId, amount, options = {} }) {
  const characterState = getCharacterState();
  const currentRecord = characterState.getCharacterRecord(charId);
  if (!currentRecord) {
    return {
      success: false,
      errorMsg: "CHARACTER_NOT_FOUND",
    };
  }

  const delta = normalizePlexDelta(amount, 0);
  const idempotencyKey = normalizeWalletIdempotencyKey(options.idempotencyKey);
  if (idempotencyKey === "") {
    return {
      success: false,
      errorMsg: "IDEMPOTENCY_KEY_INVALID",
    };
  }
  const fingerprint = idempotencyKey
    ? buildPlexAdjustmentFingerprint(charId, delta, options)
    : null;
  if (idempotencyKey) {
    const receipt = findWalletOperationReceipt(currentRecord, idempotencyKey);
    if (receipt) {
      if (receipt.fingerprint !== fingerprint) {
        return {
          success: false,
          errorMsg: "IDEMPOTENCY_KEY_REUSED",
        };
      }
      return {
        success: true,
        ...cloneValue(receipt.result),
        duplicate: true,
      };
    }
  }

  const currentWallet = getCharacterWallet(charId);
  if (
    delta < 0 &&
    options.requireSufficientFunds === true &&
    currentWallet.plexBalance < Math.abs(delta)
  ) {
    return {
      success: false,
      errorMsg: "INSUFFICIENT_FUNDS",
    };
  }

  if (options.requireExactCredit === true && !Number.isSafeInteger(currentWallet.plexBalance + delta)) {
    return { success: false, errorMsg: "WALLET_LIMIT" };
  }
  return applySetCharacterPlexBalance({
    charId,
    nextBalance: currentWallet.plexBalance + delta,
    options,
    idempotencyReceipt: idempotencyKey
      ? { idempotencyKey, fingerprint }
      : null,
  });
}

function adjustCharacterPlexBalance(charId, amount, options = {}) {
  const result = executeWalletCommand(WALLET_COMMAND_TYPE.CHARACTER_ADJUST_PLEX, {
    charId,
    amount,
    options,
  });
  if (result && result.success && result.duplicate !== true) {
    notifyCharacterPlexBalanceChange(charId, result.data);
    publishPlexBalanceChangedNotice(
      charId,
      result.data.plexBalance,
      result.delta,
    );
  }
  return result;
}

async function adjustCharacterPlexBalanceAsync(charId, amount, options = {}, metadata = {}) {
  const result = await executeWalletCommandAsync(
    WALLET_COMMAND_TYPE.CHARACTER_ADJUST_PLEX,
    { charId, amount, options },
    metadata,
  );
  announceCharacterPlexResult(charId, result);
  return result;
}

// Lowers every character wallet above the wallet limit to the limit, through
// the wallet authority, so each change gets a journal entry. Boot runs it once,
// before anything can pay or spend: a balance edited while the server was down
// (Config Editor, player import) never passed the limit at write time. It never
// throws, because a wallet it cannot lower must not stop the server starting.
async function lowerCharacterBalancesToWalletLimitAsync() {
  const summary = { checked: 0, lowered: 0, failed: [] };
  let characterIDs = [];
  try {
    characterIDs = getCharacterState().listCharacterIDs();
  } catch (error) {
    summary.failed.push(`character list: ${error.message}`);
    return summary;
  }

  for (const charId of characterIDs) {
    summary.checked += 1;
    try {
      const wallet = getCharacterWallet(charId);
      if (!wallet || !(wallet.balance > MAX_WALLET_BALANCE)) {
        continue;
      }
      const result = await setCharacterBalanceAsync(
        charId,
        MAX_WALLET_BALANCE,
        {
          description:
            `Balance lowered to the wallet limit of ${MAX_WALLET_BALANCE.toLocaleString("en-US")} ISK`,
        },
        { source: "startup.wallet-limit" },
      );
      if (result && result.success) {
        summary.lowered += 1;
      } else {
        summary.failed.push(`${charId}: ${(result && result.errorMsg) || "UNKNOWN"}`);
      }
    } catch (error) {
      summary.failed.push(`${charId}: ${error.message}`);
    }
  }
  return summary;
}

registerWalletCommandHandlers("character-wallet", {
  [WALLET_COMMAND_TYPE.CHARACTER_APPEND_MARKET_TRANSACTION]:
    applyAppendCharacterMarketTransaction,
  [WALLET_COMMAND_TYPE.CHARACTER_SET_ISK]: applySetCharacterBalance,
  [WALLET_COMMAND_TYPE.CHARACTER_ADJUST_ISK]: applyAdjustCharacterBalance,
  [WALLET_COMMAND_TYPE.CHARACTER_TRANSFER_ISK]: applyTransferCharacterBalance,
  [WALLET_COMMAND_TYPE.CHARACTER_SET_PLEX]: applySetCharacterPlexBalance,
  [WALLET_COMMAND_TYPE.CHARACTER_ADJUST_PLEX]:
    applyAdjustCharacterPlexBalance,
});

module.exports = {
  ACCOUNT_KEY,
  ACCOUNT_KEY_NAME,
  JOURNAL_ENTRY_TYPE,
  JOURNAL_CURRENCY,
  buildMarshalRealMoney,
  lowerCharacterBalancesToWalletLimitAsync,
  buildNotEnoughMoneyUserErrorValues,
  applyCharacterWalletProjection,
  getCharacterWallet,
  getCharacterWalletJournal,
  getCharacterWalletTransactions,
  getCharacterMarketTransactions,
  appendCharacterMarketTransaction,
  appendCharacterMarketTransactionAsync,
  syncWalletToSession,
  emitAccountChangeToSession,
  notifyCharacterWalletChange,
  notifyCharacterPlexBalanceChange,
  resolveAnnouncedCharacterWallet,
  setCharacterBalance,
  setCharacterBalanceAsync,
  adjustCharacterBalance,
  adjustCharacterBalanceAsync,
  setCharacterPlexBalance,
  setCharacterPlexBalanceAsync,
  adjustCharacterPlexBalance,
  adjustCharacterPlexBalanceAsync,
  transferCharacterBalance,
  transferCharacterBalanceAsync,
  _applyAdjustCharacterBalance: applyAdjustCharacterBalance,
};
