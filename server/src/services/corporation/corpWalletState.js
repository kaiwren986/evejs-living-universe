"use strict";

const path = require("path");

const sessionRegistry = require(path.join(
  __dirname,
  "../chat/sessionRegistry",
));
const { currentFileTime } = require(path.join(
  __dirname,
  "../_shared/serviceHelpers",
));
const {
  getCorporationRuntime,
  updateCorporationRuntime,
} = process.env.EVEJS_WALLET_AUTHORITY_OWNER === "1"
  ? require(path.join(__dirname, "../account/walletAuthorityOwnerState"))
  : require(path.join(__dirname, "./corporationRuntimeState"));
const {
  WALLET_COMMAND_TYPE,
  executeWalletCommand,
  executeWalletCommandAsync,
  isWalletAuthorityProcessEnabled,
  registerWalletCommandHandlers,
} = require(path.join(__dirname, "../account/walletCommandAuthority"));
const walletAuthorityProjection = require(path.join(
  __dirname,
  "../account/walletAuthorityProjection",
));
const { MAX_WALLET_BALANCE } = require(path.join(
  __dirname,
  "../account/walletBalanceLimit",
));

const CORPORATION_WALLET_KEY_START = 1000;
const CORPORATION_WALLET_KEY_END = 1006;
const MAX_JOURNAL_ENTRIES = 100;
const MAX_TRANSACTION_ENTRIES = 2000;
const MAX_MARKET_TRANSACTION_ENTRIES = 2000;
const FILETIME_UNIX_EPOCH = 116444736000000000n;
const FILETIME_TICKS_PER_MS = 10000n;
const LAST_30_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
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

function normalizeCorporationWalletKey(rawValue) {
  const numeric = Number(rawValue);
  if (Number.isInteger(numeric)) {
    if (numeric >= CORPORATION_WALLET_KEY_START && numeric <= CORPORATION_WALLET_KEY_END) {
      return numeric;
    }
  }

  const text = String(rawValue || "").trim().toLowerCase();
  if (text === "cash") {
    return CORPORATION_WALLET_KEY_START;
  }
  const match = /^cash([2-7])$/.exec(text);
  if (match) {
    return CORPORATION_WALLET_KEY_START + Number(match[1]) - 1;
  }

  return CORPORATION_WALLET_KEY_START;
}

function normalizePositiveInteger(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.max(0, Math.trunc(numeric));
}

function getCorporationWalletKeyName(accountKey) {
  const normalizedKey = normalizeCorporationWalletKey(accountKey);
  const offset = normalizedKey - CORPORATION_WALLET_KEY_START;
  return offset <= 0 ? "cash" : `cash${offset + 1}`;
}

function buildLedgerEntry(corporationID, accountKey, amount, balance, options = {}) {
  const timestamp = currentFileTime().toString();
  const transactionID = Number(Date.now()) * 100 + Math.floor(Math.random() * 100);
  const description =
    Object.prototype.hasOwnProperty.call(options, "description") &&
    typeof options.description === "string"
      ? options.description
      : "Corporation wallet balance change";
  return {
    transactionID,
    transactionDate: timestamp,
    referenceID: Number(options.referenceID || transactionID) || transactionID,
    entryTypeID: Number(options.entryTypeID || 10) || 10,
    ownerID1: Number(options.ownerID1 || corporationID) || corporationID,
    ownerID2: Number(options.ownerID2 || 0) || 0,
    accountKey,
    amount: normalizeMoney(amount, 0),
    balance: normalizeMoney(balance, 0),
    description,
    currency: Number(options.currency || 1) || 1,
    sortValue: Number(options.sortValue || 1) || 1,
  };
}

function normalizeMarketTransactionEntry(entry = {}, accountKey = CORPORATION_WALLET_KEY_START) {
  const normalizedAccountKey = normalizeCorporationWalletKey(
    entry.keyID ?? entry.accountKey ?? entry.accountID ?? accountKey,
  );
  return {
    transactionID: normalizePositiveInteger(entry.transactionID, 0),
    transactionDate:
      typeof entry.transactionDate === "bigint"
        ? entry.transactionDate.toString()
        : String(entry.transactionDate || "0"),
    typeID: normalizePositiveInteger(entry.typeID, 0),
    quantity: normalizePositiveInteger(entry.quantity, 0),
    price: normalizeMoney(entry.price, 0),
    stationID: normalizePositiveInteger(entry.stationID, 0),
    locationID: normalizePositiveInteger(entry.locationID ?? entry.stationID, 0),
    buyerID: normalizePositiveInteger(entry.buyerID, 0),
    sellerID: normalizePositiveInteger(entry.sellerID, 0),
    clientID: normalizePositiveInteger(entry.clientID, 0),
    accountID: normalizeCorporationWalletKey(entry.accountID ?? normalizedAccountKey),
    buyerAccountID: normalizeCorporationWalletKey(entry.buyerAccountID ?? normalizedAccountKey),
    sellerAccountID: normalizeCorporationWalletKey(entry.sellerAccountID ?? normalizedAccountKey),
    keyID: normalizedAccountKey,
    journalRefID: Math.trunc(Number(entry.journalRefID ?? entry.journal_ref_id) || -1),
  };
}

function appendLimited(list, entry, maxEntries) {
  list.push(entry);
  if (list.length > maxEntries) {
    list.splice(0, list.length - maxEntries);
  }
}

function fileTimeToDate(value) {
  try {
    const filetime = BigInt(String(value || "0"));
    if (filetime <= 0n) {
      return new Date(NaN);
    }
    return new Date(Number((filetime - FILETIME_UNIX_EPOCH) / FILETIME_TICKS_PER_MS));
  } catch (_error) {
    return new Date(NaN);
  }
}

function isLedgerEntryInMonth(entry, year, month) {
  const date = fileTimeToDate(entry && entry.transactionDate);
  if (Number.isNaN(date.valueOf())) {
    return false;
  }
  return date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month;
}

function isLedgerEntryWithinLast30Days(entry) {
  const date = fileTimeToDate(entry && entry.transactionDate);
  if (Number.isNaN(date.valueOf())) {
    return false;
  }
  return date.getTime() >= Date.now() - LAST_30_DAYS_MS;
}

function filterLedgerEntries(entries = [], options = {}) {
  const year = Number(options.year);
  const month = Number(options.month);
  const hasMonthFilter = Number.isFinite(year) && Number.isFinite(month);
  return entries
    .filter((entry) => {
      if (hasMonthFilter) {
        return isLedgerEntryInMonth(entry, year, month);
      }
      if (options.last30DaysDefault) {
        return isLedgerEntryWithinLast30Days(entry);
      }
      return true;
    })
    .map((entry) => cloneValue(entry));
}

function getCorporationWallet(corporationID) {
  const projected = walletAuthorityProjection.getCorporationProjection(corporationID);
  if (projected) {
    return projected.wallet ? cloneValue(projected.wallet) : null;
  }
  const runtime = getCorporationRuntime(corporationID);
  if (!runtime || !runtime.wallet) {
    return null;
  }
  return cloneValue(runtime.wallet);
}

function getCorporationWalletDivision(corporationID, accountKey = CORPORATION_WALLET_KEY_START) {
  const wallet = getCorporationWallet(corporationID);
  const normalizedKey = normalizeCorporationWalletKey(accountKey);
  if (!wallet || !wallet.divisions || !wallet.divisions[String(normalizedKey)]) {
    return null;
  }
  return cloneValue(wallet.divisions[String(normalizedKey)]);
}

function getCorporationWalletBalance(corporationID, accountKey = CORPORATION_WALLET_KEY_START) {
  const normalizedKey = normalizeCorporationWalletKey(accountKey);
  const projected = walletAuthorityProjection.getCorporationBalanceProjection(corporationID, normalizedKey);
  if (projected) {
    return normalizeMoney(projected.balance, 0);
  }
  const runtime = getCorporationRuntime(corporationID);
  const division = runtime?.wallet?.divisions?.[String(normalizedKey)];
  return division ? normalizeMoney(division.balance, 0) : 0;
}

function getCorporationWalletDivisionsInfo(corporationID) {
  const wallet = getCorporationWallet(corporationID);
  const divisions = wallet && wallet.divisions && typeof wallet.divisions === "object"
    ? wallet.divisions
    : {};

  return Array.from({ length: 7 }, (_value, index) => {
    const key = CORPORATION_WALLET_KEY_START + index;
    const division = divisions[String(key)] || {};
    return {
      key,
      balance: normalizeMoney(division.balance, 0),
    };
  });
}

function notifyCorporationWalletChange(corporationID, accountKey, balance) {
  const accountKeyName = getCorporationWalletKeyName(accountKey);
  for (const session of sessionRegistry.getSessions()) {
    if (
      Number(session && (session.corporationID || session.corpid)) !== Number(corporationID) ||
      typeof session.sendNotification !== "function"
    ) {
      continue;
    }
    session.sendNotification("OnAccountChange", "*corpid&corpAccountKey", [
      accountKeyName,
      Number(corporationID),
      balance === null ? null : buildMarshalRealMoney(balance, 0),
    ]);
  }
}

// A duplicate is a command the wallet authority had already committed, answered
// from its receipt, whose balances are as of that original commit. None of them is
// announced: a retry of this same command announces what the wallet holds now,
// and a commandID collision announces nothing at all. walletState's
// resolveAnnouncedCharacterWallet carries the full reasoning.
function isCollidedWalletReplay(result) {
  return Boolean(
    result && result.duplicate === true && result.fingerprintMismatch === true,
  );
}

function resolveAnnouncedDivisionBalance(result, corporationID, accountKey, committedBalance) {
  return result && result.duplicate === true
    ? getCorporationWalletBalance(corporationID, accountKey)
    : committedBalance;
}

function applySetCorporationWalletDivisionBalance({
  corporationID,
  accountKey,
  nextBalance,
  options = {},
  adjustmentReceipt = null,
}) {
  const normalizedCorporationID = Number(corporationID) || 0;
  const normalizedAccountKey = normalizeCorporationWalletKey(accountKey);
  let result = null;

  const writeResult = updateCorporationRuntime(normalizedCorporationID, (runtime) => {
    runtime.wallet =
      runtime.wallet && typeof runtime.wallet === "object"
        ? runtime.wallet
        : { divisions: {} };
    runtime.wallet.divisions =
      runtime.wallet.divisions && typeof runtime.wallet.divisions === "object"
        ? runtime.wallet.divisions
        : {};

    const divisionKey = String(normalizedAccountKey);
    const currentDivision =
      runtime.wallet.divisions[divisionKey] &&
      typeof runtime.wallet.divisions[divisionKey] === "object"
        ? runtime.wallet.divisions[divisionKey]
        : {
            key: normalizedAccountKey,
            balance: 0,
            journal: [],
            transactions: [],
          };

    const previousBalance = normalizeMoney(currentDivision.balance, 0);
    const rewardKey = options.nodeGraphRewardKey;
    const rewardAmount = options.nodeGraphRewardAmount;
    if (rewardKey) {
      const receipt = currentDivision.nodeGraphRewardReceipts?.[rewardKey];
      if (receipt) {
        result = receipt.amount === rewardAmount
          ? { success: true, duplicate: true, data: cloneValue(receipt.data) }
          : { success: false, errorMsg: "IDEMPOTENCY_KEY_REUSED" };
        return runtime;
      }
      if (!/^nodegraph:[a-f0-9]{64}$/.test(rewardKey) || !Number.isFinite(rewardAmount) || rewardAmount < 0 || Object.keys(currentDivision.nodeGraphRewardReceipts || {}).length >= 8192) {
        result = { success: false, errorMsg: "NODEGRAPH_TAX_RECEIPT_INVALID" };
        return runtime;
      }
    }
    // The same wallet limit as a character's cash; a credit past it stops at it.
    const balance = Math.min(
      normalizeMoney(nextBalance, previousBalance),
      MAX_WALLET_BALANCE,
    );
    const delta = normalizeMoney(balance - previousBalance, 0);
    if (rewardKey && delta !== rewardAmount) {
      result = { success: false, errorMsg: "NODEGRAPH_TAX_AMOUNT_INVALID" };
      return runtime;
    }
    let ledgerEntry = null;

    currentDivision.key = normalizedAccountKey;
    currentDivision.balance = balance;
    currentDivision.journal = Array.isArray(currentDivision.journal)
      ? currentDivision.journal
      : [];
    currentDivision.transactions = Array.isArray(currentDivision.transactions)
      ? currentDivision.transactions
      : [];

    if (Math.abs(delta) > 0.0001) {
      ledgerEntry = buildLedgerEntry(
        normalizedCorporationID,
        normalizedAccountKey,
        delta,
        balance,
        options,
      );
      appendLimited(currentDivision.journal, ledgerEntry, MAX_JOURNAL_ENTRIES);
      appendLimited(
        currentDivision.transactions,
        ledgerEntry,
        MAX_TRANSACTION_ENTRIES,
      );
    }

    runtime.wallet.divisions[divisionKey] = currentDivision;
    result = {
      success: true,
      data: {
        corporationID: normalizedCorporationID,
        accountKey: normalizedAccountKey,
        balance,
        delta,
        journalEntry: ledgerEntry ? cloneValue(ledgerEntry) : null,
      },
    };
    if (rewardKey) currentDivision.nodeGraphRewardReceipts = { ...(currentDivision.nodeGraphRewardReceipts || {}), [rewardKey]: { amount: rewardAmount, data: cloneValue(result.data) } };
    if (adjustmentReceipt) {
      currentDivision.adjustmentReceipts = {
        ...(currentDivision.adjustmentReceipts || {}),
        [adjustmentReceipt.key]: { fingerprint: adjustmentReceipt.fingerprint, result: cloneValue(result) },
      };
    }
    return runtime;
  });

  if (adjustmentReceipt && !writeResult?.success) {
    // Do not let the process command ledger cache an ambiguous success/failure.
    // Retrying the same adjustment must first persist its exact receipt.
    const error = new Error(writeResult?.errorMsg || "Corporation wallet adjustment write is pending");
    error.code = "WALLET_ADJUSTMENT_WRITE_AMBIGUOUS";
    throw error;
  }

  if (!result) {
    return {
      success: false,
      errorMsg: "CORPORATION_NOT_FOUND",
    };
  }

  return result;
}

function setCorporationWalletDivisionBalance(
  corporationID,
  accountKey,
  nextBalance,
  options = {},
) {
  const result = executeWalletCommand(WALLET_COMMAND_TYPE.CORPORATION_SET_ISK, {
    corporationID,
    accountKey,
    nextBalance,
    options,
  });
  if (result && result.success) {
    notifyCorporationWalletChange(
      result.data.corporationID,
      result.data.accountKey,
      result.data.balance,
    );
  }
  return result;
}

async function setCorporationWalletDivisionBalanceAsync(
  corporationID,
  accountKey,
  nextBalance,
  options = {},
  metadata = {},
) {
  const result = await executeWalletCommandAsync(
    WALLET_COMMAND_TYPE.CORPORATION_SET_ISK,
    { corporationID, accountKey, nextBalance, options },
    metadata,
  );
  if (result && result.success && !isCollidedWalletReplay(result)) {
    notifyCorporationWalletChange(
      result.data.corporationID,
      result.data.accountKey,
      resolveAnnouncedDivisionBalance(
        result,
        result.data.corporationID,
        result.data.accountKey,
        result.data.balance,
      ),
    );
  }
  return result;
}

function applyAdjustCorporationWalletDivisionBalance({
  corporationID,
  accountKey,
  delta,
  options = {},
}) {
  const normalizedCorporationID = Number(corporationID) || 0;
  const normalizedAccountKey = normalizeCorporationWalletKey(accountKey);
  // Opt-in durable adjustment receipts commit with the balance/journal. The
  // compatibility authority needs them too; never evict a still-replayable key.
  const rawKey = options.idempotencyKey;
  const key = rawKey === null || rawKey === undefined || rawKey === "" ? null : String(rawKey).trim();
  if (key !== null && (!key || key.length > 320)) {
    return { success: false, errorMsg: "IDEMPOTENCY_KEY_INVALID" };
  }
  const fingerprint = key === null ? null : JSON.stringify({
    corporationID: normalizedCorporationID, accountKey: normalizedAccountKey,
    delta: normalizeMoney(delta, 0), referenceID: Number(options.referenceID || 0),
    entryTypeID: Number(options.entryTypeID || 10), ownerID1: Number(options.ownerID1 || normalizedCorporationID),
    ownerID2: Number(options.ownerID2 || 0), currency: Number(options.currency || 1),
    sortValue: Number(options.sortValue || 1),
    description: typeof options.description === "string" ? options.description : "Corporation wallet balance change",
    requireExactCredit: options.requireExactCredit === true,
  });
  if (key !== null) {
    const receipts = getCorporationWalletDivision(normalizedCorporationID, normalizedAccountKey)?.adjustmentReceipts || {};
    const prior = receipts[key];
    if (prior) {
      if (prior.fingerprint !== fingerprint) return { success: false, errorMsg: "IDEMPOTENCY_KEY_REUSED" };
      // A failed local write may have left the runtime cache ahead of storage.
      // Re-write that same receipt/balance before its caller flushes or the
      // process authority commits its command receipt; never apply delta twice.
      const replayWrite = updateCorporationRuntime(normalizedCorporationID, runtime => runtime);
      if (!replayWrite?.success) {
        const error = new Error(replayWrite?.errorMsg || "Corporation wallet receipt write is pending");
        error.code = "WALLET_ADJUSTMENT_WRITE_AMBIGUOUS";
        throw error;
      }
      return { ...cloneValue(prior.result), duplicate: true };
    }
  }
  const currentBalance = getCorporationWalletBalance(
    normalizedCorporationID,
    normalizedAccountKey,
  );
  const nextBalance = normalizeMoney(currentBalance + normalizeMoney(delta, 0), currentBalance);
  if (options.requireExactCredit === true && nextBalance > MAX_WALLET_BALANCE) {
    return { success: false, errorMsg: "WALLET_LIMIT" };
  }
  if (nextBalance < -0.0001) {
    return {
      success: false,
      errorMsg: "INSUFFICIENT_FUNDS",
      data: {
        corporationID: normalizedCorporationID,
        accountKey: normalizedAccountKey,
        balance: currentBalance,
      },
    };
  }

  return applySetCorporationWalletDivisionBalance({
    corporationID: normalizedCorporationID,
    accountKey: normalizedAccountKey,
    nextBalance,
    options,
    adjustmentReceipt: key === null ? null : { key, fingerprint },
  });
}

function adjustCorporationWalletDivisionBalance(
  corporationID,
  accountKey,
  delta,
  options = {},
) {
  const result = executeWalletCommand(
    WALLET_COMMAND_TYPE.CORPORATION_ADJUST_ISK,
    { corporationID, accountKey, delta, options },
  );
  if (result && result.success && !(options.nodeGraphRewardKey && result.duplicate)) {
    notifyCorporationWalletChange(
      result.data.corporationID,
      result.data.accountKey,
      options.idempotencyKey
        ? resolveAnnouncedDivisionBalance(result, result.data.corporationID, result.data.accountKey, result.data.balance)
        : result.data.balance,
    );
  }
  return result;
}

async function adjustCorporationWalletDivisionBalanceAsync(
  corporationID,
  accountKey,
  delta,
  options = {},
  metadata = {},
) {
  const result = await executeWalletCommandAsync(
    WALLET_COMMAND_TYPE.CORPORATION_ADJUST_ISK,
    { corporationID, accountKey, delta, options },
    metadata,
  );
  if (result?.success && ["contract-settlement", "incursion-settlement"].includes(metadata.source) && !isWalletAuthorityProcessEnabled()) {
    const database = require("../../gameStore");
    const committed = database.flushTableSync("corporationRuntime");
    if (!committed?.success) return committed || { success: false, errorMsg: "CONTRACT_WALLET_FLUSH_FAILED" };
  }
  if (result && result.success && !isCollidedWalletReplay(result)) {
    notifyCorporationWalletChange(
      result.data.corporationID,
      result.data.accountKey,
      resolveAnnouncedDivisionBalance(
        result,
        result.data.corporationID,
        result.data.accountKey,
        result.data.balance,
      ),
    );
  }
  return result;
}

function applyTransferCorporationWalletBalance({
  fromCorporationID,
  fromAccountKey,
  toCorporationID,
  toAccountKey = CORPORATION_WALLET_KEY_START,
  amount,
  options = {},
}) {
  const normalizedAmount = normalizeMoney(amount, 0);
  const additionalDebitAmount = normalizeMoney(
    options.additionalDebitAmount,
    0,
  );
  if (!(normalizedAmount > 0) && !(additionalDebitAmount > 0)) {
    return { success: false, errorMsg: "AMOUNT_REQUIRED" };
  }
  const normalizedFromCorporationID = normalizePositiveInteger(
    fromCorporationID,
    0,
  );
  const normalizedToCorporationID = normalizePositiveInteger(
    toCorporationID,
    0,
  );
  if (
    !getCorporationRuntime(normalizedFromCorporationID) ||
    (normalizedAmount > 0 && !getCorporationRuntime(normalizedToCorporationID))
  ) {
    return { success: false, errorMsg: "CORPORATION_NOT_FOUND" };
  }
  const sourceAccountKey = normalizeCorporationWalletKey(fromAccountKey);
  if (
    getCorporationWalletBalance(
      normalizedFromCorporationID,
      sourceAccountKey,
    ) + 0.0001 <
    normalizedAmount + additionalDebitAmount
  ) {
    return { success: false, errorMsg: "INSUFFICIENT_FUNDS" };
  }

  const sourceOwnerID = normalizePositiveInteger(
    options.fromOwnerID,
    normalizedFromCorporationID,
  );
  const targetOwnerID = normalizePositiveInteger(
    options.toOwnerID,
    normalizedToCorporationID,
  );
  const description = typeof options.description === "string"
    ? options.description
    : `Corporation wallet transfer to ${targetOwnerID}`;
  const entryTypeID = normalizePositiveInteger(options.entryTypeID, 10) || 10;
  const referenceID = normalizePositiveInteger(
    options.referenceID,
    targetOwnerID,
  );
  let additionalDebitResult = null;
  if (additionalDebitAmount > 0) {
    const additionalOptions =
      options.additionalDebitOptions &&
      typeof options.additionalDebitOptions === "object"
        ? options.additionalDebitOptions
        : {};
    additionalDebitResult = applyAdjustCorporationWalletDivisionBalance({
      corporationID: normalizedFromCorporationID,
      accountKey: sourceAccountKey,
      delta: -additionalDebitAmount,
      options: {
        description: additionalOptions.description || description,
        entryTypeID: normalizePositiveInteger(
          additionalOptions.entryTypeID,
          entryTypeID,
        ),
        ownerID1: normalizePositiveInteger(
          additionalOptions.ownerID1,
          sourceOwnerID,
        ),
        ownerID2: normalizePositiveInteger(additionalOptions.ownerID2, 0),
        referenceID: normalizePositiveInteger(
          additionalOptions.referenceID,
          referenceID,
        ),
      },
    });
    if (!additionalDebitResult.success) {
      return additionalDebitResult;
    }
  }
  let debitResult = null;
  let creditResult = null;
  if (normalizedAmount > 0) {
    debitResult = applyAdjustCorporationWalletDivisionBalance({
      corporationID: normalizedFromCorporationID,
      accountKey: sourceAccountKey,
      delta: -normalizedAmount,
      options: {
        description,
        entryTypeID,
        ownerID1: sourceOwnerID,
        ownerID2: targetOwnerID,
        referenceID,
      },
    });
    if (!debitResult.success) {
      return debitResult;
    }
    creditResult = applyAdjustCorporationWalletDivisionBalance({
      corporationID: normalizedToCorporationID,
      accountKey: normalizeCorporationWalletKey(toAccountKey),
      delta: normalizedAmount,
      options: {
        description,
        entryTypeID,
        ownerID1: sourceOwnerID,
        ownerID2: targetOwnerID,
        referenceID: normalizePositiveInteger(options.referenceID, sourceOwnerID),
      },
    });
    if (!creditResult.success) {
      return creditResult;
    }
  }
  return {
    success: true,
    amount: normalizedAmount,
    additionalDebitAmount,
    additionalDebit: additionalDebitResult && additionalDebitResult.data,
    from: debitResult ? debitResult.data : additionalDebitResult.data,
    to: creditResult && creditResult.data,
  };
}

function notifyCorporationTransfer(result) {
  if (!result || !result.success) {
    return;
  }
  notifyCorporationWalletChange(
    result.from.corporationID,
    result.from.accountKey,
    resolveAnnouncedDivisionBalance(
      result,
      result.from.corporationID,
      result.from.accountKey,
      result.from.balance,
    ),
  );
  if (result.to) {
    notifyCorporationWalletChange(
      result.to.corporationID,
      result.to.accountKey,
      resolveAnnouncedDivisionBalance(
        result,
        result.to.corporationID,
        result.to.accountKey,
        result.to.balance,
      ),
    );
  }
}

function applyLiquidateCorporationWallet({
  fromCorporationID,
  toCharacterID,
  options = {},
}) {
  const normalizedCorporationID = normalizePositiveInteger(
    fromCorporationID,
    0,
  );
  const normalizedCharacterID = normalizePositiveInteger(toCharacterID, 0);
  const corporationRuntime = getCorporationRuntime(normalizedCorporationID);
  const { getCharacterWallet, _applyAdjustCharacterBalance } = require(path.join(
    __dirname,
    "../account/walletState",
  ));
  if (!corporationRuntime || !getCharacterWallet(normalizedCharacterID)) {
    return { success: false, errorMsg: "OWNER_NOT_FOUND" };
  }

  const divisions = getCorporationWalletDivisionsInfo(
    normalizedCorporationID,
  ).map((division) => ({
    accountKey: normalizeCorporationWalletKey(division && division.key),
    balance: Math.max(0, normalizeMoney(division && division.balance, 0)),
  }));
  const payout = normalizeMoney(
    divisions.reduce((total, division) => total + division.balance, 0),
    0,
  );
  const entryTypeID = normalizePositiveInteger(options.entryTypeID, 10) || 10;
  const description = typeof options.description === "string"
    ? options.description
    : "Corporation liquidation";

  const corporationResults = [];
  for (const division of divisions) {
    const result = applySetCorporationWalletDivisionBalance({
      corporationID: normalizedCorporationID,
      accountKey: division.accountKey,
      nextBalance: 0,
      options: {
        description,
        entryTypeID,
        ownerID1: normalizedCorporationID,
        ownerID2: normalizedCharacterID,
        referenceID: normalizedCorporationID,
      },
    });
    if (!result || result.success !== true) {
      return result || { success: false, errorMsg: "CORPORATION_DEBIT_FAILED" };
    }
    corporationResults.push(result.data);
  }

  let characterResult = null;
  if (payout > 0) {
    characterResult = _applyAdjustCharacterBalance({
      charId: normalizedCharacterID,
      amount: payout,
      options: {
        description,
        entryTypeID,
        ownerID1: normalizedCorporationID,
        ownerID2: normalizedCharacterID,
        referenceID: normalizedCorporationID,
      },
    });
    if (!characterResult || characterResult.success !== true) {
      return characterResult || {
        success: false,
        errorMsg: "CHARACTER_CREDIT_FAILED",
      };
    }
  }

  return {
    success: true,
    payout,
    corporationID: normalizedCorporationID,
    characterID: normalizedCharacterID,
    divisions: corporationResults,
    character: characterResult && characterResult.data,
  };
}

function notifyCorporationLiquidationWallet(corporationID, characterID, payout) {
  // TQ Resign As CEO - Corp Disbands.txt280..340: six cash/None
  // invalidations, then cash/0 and the character's balance. These are not
  // cash2..cash7 balance updates. walletSvc.OnAccountChange ignores None for
  // wealth, while accountsvc still invalidates its transaction caches.
  for (let index = 1; index < 7; index += 1) {
    notifyCorporationWalletChange(
      corporationID,
      CORPORATION_WALLET_KEY_START,
      null,
    );
  }
  notifyCorporationWalletChange(corporationID, CORPORATION_WALLET_KEY_START, 0);
  if (payout > 0) {
    const {
      getCharacterWallet,
      notifyCharacterWalletChange,
    } = require(path.join(__dirname, "../account/walletState"));
    // Publication can follow durable recovery or other wallet commands. Read
    // the current authority projection rather than replaying a receipt balance.
    const wallet = getCharacterWallet(characterID);
    if (wallet) {
      notifyCharacterWalletChange(characterID, wallet, {
        accountKey: "cash",
        balance: wallet.balance,
      });
    }
  }
}

function liquidateCorporationWallet(
  fromCorporationID,
  toCharacterID,
  options = {},
) {
  const result = executeWalletCommand(
    WALLET_COMMAND_TYPE.CORPORATION_LIQUIDATE_TO_CHARACTER,
    { fromCorporationID, toCharacterID, options },
  );
  if (result && result.success === true) {
    notifyCorporationLiquidationWallet(
      result.corporationID, result.characterID, result.payout,
    );
  }
  return result;
}

async function liquidateCorporationWalletAsync(
  fromCorporationID,
  toCharacterID,
  options = {},
  metadata = {},
  publication = {},
) {
  const result = await executeWalletCommandAsync(
    WALLET_COMMAND_TYPE.CORPORATION_LIQUIDATE_TO_CHARACTER,
    { fromCorporationID, toCharacterID, options },
    metadata,
  );
  if (publication.emitNotifications !== false &&
      result && result.success === true && !isCollidedWalletReplay(result)) {
    notifyCorporationLiquidationWallet(
      result.corporationID, result.characterID, result.payout,
    );
  }
  return result;
}

function normalizeDistributionAllocations(allocations = []) {
  const aggregated = new Map();
  for (const candidate of Array.isArray(allocations) ? allocations : []) {
    const kind = candidate && candidate.kind === "corporation"
      ? "corporation"
      : candidate && candidate.kind === "character"
        ? "character"
        : null;
    const ownerID = normalizePositiveInteger(candidate && candidate.ownerID, 0);
    const amount = normalizeMoney(candidate && candidate.amount, 0);
    if (!kind || !ownerID || !(amount > 0)) {
      continue;
    }
    const key = `${kind}:${ownerID}`;
    const current = aggregated.get(key) || { kind, ownerID, amount: 0 };
    current.amount = normalizeMoney(current.amount + amount, 0);
    aggregated.set(key, current);
  }
  return [...aggregated.values()].sort((left, right) =>
    left.kind.localeCompare(right.kind) || left.ownerID - right.ownerID);
}

function applyDistributeCorporationWallet({
  sourceCorporationID,
  sourceAccountKey,
  totalAmount,
  allocations = [],
  options = {},
}) {
  const normalizedSourceID = normalizePositiveInteger(sourceCorporationID, 0);
  const normalizedSourceKey = normalizeCorporationWalletKey(sourceAccountKey);
  const normalizedTotal = normalizeMoney(totalAmount, 0);
  const normalizedAllocations = normalizeDistributionAllocations(allocations);
  const allocatedTotal = normalizeMoney(
    normalizedAllocations.reduce(
      (total, allocation) => total + allocation.amount,
      0,
    ),
    0,
  );
  if (
    !(normalizedTotal > 0) ||
    Math.abs(allocatedTotal - normalizedTotal) > 0.0001
  ) {
    return { success: false, errorMsg: "INVALID_DISTRIBUTION" };
  }
  if (!getCorporationRuntime(normalizedSourceID)) {
    return { success: false, errorMsg: "CORPORATION_NOT_FOUND" };
  }
  const { getCharacterWallet, _applyAdjustCharacterBalance } = require(path.join(
    __dirname,
    "../account/walletState",
  ));
  for (const allocation of normalizedAllocations) {
    const exists = allocation.kind === "character"
      ? Boolean(getCharacterWallet(allocation.ownerID))
      : Boolean(getCorporationRuntime(allocation.ownerID));
    if (!exists) {
      return { success: false, errorMsg: "RECIPIENT_NOT_FOUND" };
    }
  }
  if (
    getCorporationWalletBalance(normalizedSourceID, normalizedSourceKey) +
      0.0001 < normalizedTotal
  ) {
    return { success: false, errorMsg: "INSUFFICIENT_FUNDS" };
  }

  const entryTypeID = normalizePositiveInteger(options.entryTypeID, 10) || 10;
  const debitResult = applyAdjustCorporationWalletDivisionBalance({
    corporationID: normalizedSourceID,
    accountKey: normalizedSourceKey,
    delta: -normalizedTotal,
    options: {
      description: typeof options.debitDescription === "string"
        ? options.debitDescription
        : "Corporation wallet distribution",
      entryTypeID,
      ownerID1: normalizedSourceID,
      ownerID2: normalizePositiveInteger(options.sourceOwnerID2, 0),
      referenceID: normalizePositiveInteger(
        options.referenceID,
        normalizedSourceID,
      ),
    },
  });
  if (!debitResult || debitResult.success !== true) {
    return debitResult || { success: false, errorMsg: "SOURCE_DEBIT_FAILED" };
  }

  const credits = [];
  for (const allocation of normalizedAllocations) {
    const creditOptions = {
      description: typeof options.creditDescription === "string"
        ? options.creditDescription
        : `Corporation distribution from ${normalizedSourceID}`,
      entryTypeID,
      ownerID1: normalizedSourceID,
      ownerID2: allocation.ownerID,
      referenceID: normalizePositiveInteger(
        options.referenceID,
        normalizedSourceID,
      ),
    };
    const creditResult = allocation.kind === "character"
      ? _applyAdjustCharacterBalance({
          charId: allocation.ownerID,
          amount: allocation.amount,
          options: creditOptions,
        })
      : applyAdjustCorporationWalletDivisionBalance({
          corporationID: allocation.ownerID,
          accountKey: CORPORATION_WALLET_KEY_START,
          delta: allocation.amount,
          options: creditOptions,
        });
    if (!creditResult || creditResult.success !== true) {
      return creditResult || {
        success: false,
        errorMsg: "RECIPIENT_CREDIT_FAILED",
      };
    }
    credits.push({ ...allocation, data: creditResult.data });
  }
  return {
    success: true,
    sourceCorporationID: normalizedSourceID,
    totalAmount: normalizedTotal,
    source: debitResult.data,
    credits,
  };
}

function notifyCorporationDistribution(result) {
  if (!result || result.success !== true) {
    return;
  }
  notifyCorporationWalletChange(
    result.source.corporationID,
    result.source.accountKey,
    resolveAnnouncedDivisionBalance(
      result,
      result.source.corporationID,
      result.source.accountKey,
      result.source.balance,
    ),
  );
  const {
    notifyCharacterWalletChange,
    resolveAnnouncedCharacterWallet,
  } = require(path.join(__dirname, "../account/walletState"));
  for (const credit of result.credits || []) {
    if (credit.kind === "character") {
      const wallet = resolveAnnouncedCharacterWallet(credit.ownerID, result, credit.data);
      if (wallet) {
        notifyCharacterWalletChange(credit.ownerID, wallet, {
          accountKey: "cash",
          balance: wallet.balance,
        });
      }
    } else {
      notifyCorporationWalletChange(
        credit.data.corporationID,
        credit.data.accountKey,
        resolveAnnouncedDivisionBalance(
          result,
          credit.data.corporationID,
          credit.data.accountKey,
          credit.data.balance,
        ),
      );
    }
  }
}

function distributeCorporationWallet(
  sourceCorporationID,
  sourceAccountKey,
  totalAmount,
  allocations,
  options = {},
) {
  const result = executeWalletCommand(
    WALLET_COMMAND_TYPE.CORPORATION_DISTRIBUTE_ISK,
    { sourceCorporationID, sourceAccountKey, totalAmount, allocations, options },
  );
  notifyCorporationDistribution(result);
  return result;
}

async function distributeCorporationWalletAsync(
  sourceCorporationID,
  sourceAccountKey,
  totalAmount,
  allocations,
  options = {},
  metadata = {},
) {
  const result = await executeWalletCommandAsync(
    WALLET_COMMAND_TYPE.CORPORATION_DISTRIBUTE_ISK,
    { sourceCorporationID, sourceAccountKey, totalAmount, allocations, options },
    metadata,
  );
  if (!isCollidedWalletReplay(result)) {
    notifyCorporationDistribution(result);
  }
  return result;
}

function transferCorporationWalletBalance(
  fromCorporationID,
  fromAccountKey,
  toCorporationID,
  toAccountKey,
  amount,
  options = {},
) {
  const result = executeWalletCommand(
    WALLET_COMMAND_TYPE.CORPORATION_TRANSFER_ISK,
    {
      fromCorporationID,
      fromAccountKey,
      toCorporationID,
      toAccountKey,
      amount,
      options,
    },
  );
  notifyCorporationTransfer(result);
  return result;
}

async function transferCorporationWalletBalanceAsync(
  fromCorporationID,
  fromAccountKey,
  toCorporationID,
  toAccountKey,
  amount,
  options = {},
  metadata = {},
) {
  const result = await executeWalletCommandAsync(
    WALLET_COMMAND_TYPE.CORPORATION_TRANSFER_ISK,
    {
      fromCorporationID,
      fromAccountKey,
      toCorporationID,
      toAccountKey,
      amount,
      options,
    },
    metadata,
  );
  if (!isCollidedWalletReplay(result)) {
    notifyCorporationTransfer(result);
  }
  return result;
}

function getCorporationWalletJournal(corporationID, options = {}) {
  const division = getCorporationWalletDivision(
    corporationID,
    options.accountKey || CORPORATION_WALLET_KEY_START,
  );
  if (!division) {
    return [];
  }
  return filterLedgerEntries(division.journal || [], options);
}

function getCorporationWalletTransactions(corporationID, options = {}) {
  const division = getCorporationWalletDivision(
    corporationID,
    options.accountKey || CORPORATION_WALLET_KEY_START,
  );
  if (!division) {
    return [];
  }
  return filterLedgerEntries(division.transactions || [], {
    ...options,
    last30DaysDefault: true,
  });
}

function getCorporationMarketTransactions(corporationID, options = {}) {
  const hasAccountKey = options.accountKey !== undefined && options.accountKey !== null;
  const divisions = [];
  if (hasAccountKey) {
    const division = getCorporationWalletDivision(corporationID, options.accountKey);
    if (division) {
      divisions.push(division);
    }
  } else {
    const wallet = getCorporationWallet(corporationID);
    if (wallet && wallet.divisions && typeof wallet.divisions === "object") {
      divisions.push(...Object.values(wallet.divisions));
    }
  }

  if (divisions.length === 0) {
    return [];
  }
  return divisions
    .flatMap((division) => {
      const accountKey = normalizeCorporationWalletKey(division && division.key);
      return (Array.isArray(division && division.marketTransactions)
        ? division.marketTransactions
        : []
      ).map((entry) => normalizeMarketTransactionEntry(cloneValue(entry), accountKey));
    })
    .sort((left, right) => right.transactionID - left.transactionID);
}

function applyAppendCorporationMarketTransaction({
  corporationID,
  accountKey,
  entry = {},
}) {
  const normalizedCorporationID = Number(corporationID) || 0;
  const normalizedAccountKey = normalizeCorporationWalletKey(accountKey);
  const normalizedEntry = normalizeMarketTransactionEntry(
    {
      transactionID: Number(Date.now()) * 100 + Math.floor(Math.random() * 100),
      transactionDate: currentFileTime().toString(),
      ...entry,
    },
    normalizedAccountKey,
  );
  let result = null;

  updateCorporationRuntime(normalizedCorporationID, (runtime) => {
    runtime.wallet =
      runtime.wallet && typeof runtime.wallet === "object"
        ? runtime.wallet
        : { divisions: {} };
    runtime.wallet.divisions =
      runtime.wallet.divisions && typeof runtime.wallet.divisions === "object"
        ? runtime.wallet.divisions
        : {};
    const divisionKey = String(normalizedAccountKey);
    const division =
      runtime.wallet.divisions[divisionKey] &&
      typeof runtime.wallet.divisions[divisionKey] === "object"
        ? runtime.wallet.divisions[divisionKey]
        : {
            key: normalizedAccountKey,
            balance: 0,
            journal: [],
            transactions: [],
            marketTransactions: [],
          };

    division.marketTransactions = Array.isArray(division.marketTransactions)
      ? division.marketTransactions
      : [];
    appendLimited(
      division.marketTransactions,
      normalizedEntry,
      MAX_MARKET_TRANSACTION_ENTRIES,
    );
    runtime.wallet.divisions[divisionKey] = division;
    result = {
      success: true,
      data: cloneValue(normalizedEntry),
    };
    return runtime;
  });

  return result || {
    success: false,
    errorMsg: "CORPORATION_NOT_FOUND",
  };
}

function appendCorporationMarketTransaction(corporationID, accountKey, entry = {}) {
  return executeWalletCommand(
    WALLET_COMMAND_TYPE.CORPORATION_APPEND_MARKET_TRANSACTION,
    { corporationID, accountKey, entry },
  );
}

async function appendCorporationMarketTransactionAsync(
  corporationID,
  accountKey,
  entry = {},
  metadata = {},
) {
  return executeWalletCommandAsync(
    WALLET_COMMAND_TYPE.CORPORATION_APPEND_MARKET_TRANSACTION,
    { corporationID, accountKey, entry },
    metadata,
  );
}

registerWalletCommandHandlers("corporation-wallet", {
  [WALLET_COMMAND_TYPE.CORPORATION_APPEND_MARKET_TRANSACTION]:
    applyAppendCorporationMarketTransaction,
  [WALLET_COMMAND_TYPE.CORPORATION_SET_ISK]:
    applySetCorporationWalletDivisionBalance,
  [WALLET_COMMAND_TYPE.CORPORATION_ADJUST_ISK]:
    applyAdjustCorporationWalletDivisionBalance,
  [WALLET_COMMAND_TYPE.CORPORATION_TRANSFER_ISK]:
    applyTransferCorporationWalletBalance,
  [WALLET_COMMAND_TYPE.CORPORATION_LIQUIDATE_TO_CHARACTER]:
    applyLiquidateCorporationWallet,
  [WALLET_COMMAND_TYPE.CORPORATION_DISTRIBUTE_ISK]:
    applyDistributeCorporationWallet,
});

module.exports = {
  CORPORATION_WALLET_KEY_START,
  CORPORATION_WALLET_KEY_END,
  appendCorporationMarketTransaction,
  appendCorporationMarketTransactionAsync,
  adjustCorporationWalletDivisionBalance,
  adjustCorporationWalletDivisionBalanceAsync,
  getCorporationWallet,
  getCorporationWalletBalance,
  getCorporationWalletDivision,
  getCorporationWalletDivisionsInfo,
  getCorporationWalletJournal,
  getCorporationWalletKeyName,
  getCorporationWalletTransactions,
  getCorporationMarketTransactions,
  distributeCorporationWallet,
  distributeCorporationWalletAsync,
  normalizeCorporationWalletKey,
  liquidateCorporationWallet,
  liquidateCorporationWalletAsync,
  notifyCorporationLiquidationWallet,
  setCorporationWalletDivisionBalance,
  setCorporationWalletDivisionBalanceAsync,
  transferCorporationWalletBalance,
  transferCorporationWalletBalanceAsync,
};
