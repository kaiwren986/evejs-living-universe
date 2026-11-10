"use strict";

const path = require("path");

const BaseService = require(path.join(__dirname, "../baseService"));
const log = require(path.join(__dirname, "../../utils/logger"));
const {
  ACCOUNT_KEY,
  ACCOUNT_KEY_NAME,
  JOURNAL_ENTRY_TYPE,
  adjustCharacterBalanceAsync,
  buildMarshalRealMoney,
  buildNotEnoughMoneyUserErrorValues,
  getCharacterWallet,
  getCharacterWalletJournal,
  getCharacterWalletTransactions,
  transferCharacterBalanceAsync,
} = require(path.join(__dirname, "./walletState"));
const { MAX_WALLET_BALANCE } = require(path.join(__dirname, "./walletBalanceLimit"));
const {
  getCorporationWalletBalance,
  getCorporationWalletDivisionsInfo,
  getCorporationWalletJournal,
  getCorporationWalletTransactions,
  getCorporationWalletKeyName,
  normalizeCorporationWalletKey,
  adjustCorporationWalletDivisionBalanceAsync,
} = require(path.join(__dirname, "../corporation/corpWalletState"));
const {
  getCorporationRecord,
} = require(path.join(__dirname, "../corporation/corporationState"));
// Imported as a namespace rather than destructuring `throwWrappedUserError`: this
// file is small and other patches to it want the same helper, and two `const
// { throwWrappedUserError } = ...` lines in one module scope is a redeclaration
// error rather than a merge to resolve.
const machoErrors = require(path.join(__dirname, "../../common/machoErrors"));
const { strVal } = require(path.join(
  __dirname,
  "../../network/tcp/utils/marshal",
));
const {
  getCorporationWalletDivisionTakeRole,
} = require(path.join(__dirname, "../corporation/corporationRuntimeState"));
const {
  corporationAuthorityHasRole,
  corporationAuthorityHasWalletDivisionReadAccess,
  getPersistedCorporationAuthority,
  hasCorporationWalletDivisionReadAccess,
} = require(path.join(__dirname, "../corporation/corporationAuthority"));
const {
  buildCachedMethodCallResult,
} = require(path.join(__dirname, "../cache/objectCacheRuntime"));
const { buildPackedRow } = require(path.join(__dirname, "../_shared/serviceHelpers"));

const JOURNAL_HEADERS = [
  "transactionID",
  "transactionDate",
  "referenceID",
  "entryTypeID",
  "ownerID1",
  "ownerID2",
  "accountKey",
  "amount",
  "balance",
  "description",
  "currency",
  "sortValue",
];
// TQ's Open Wallet recording returns nine-value blue.DBRows in this order.
// Its LARGE PAYLOAD omits the descriptor: these supported column codes are
// inferred from the values/native consumers, not captured descriptor bytes.
const TRANSACTION_COLUMNS = [
  ["transactionID", 0x14],
  ["transactionDate", 0x14],
  ["referenceID", 0x14],
  ["description", 0x82],
  ["ownerID1", 0x03],
  ["ownerID2", 0x03],
  ["entryTypeID", 0x03],
  ["amount", 0x05],
  ["balance", 0x05],
];
const ENTRY_TYPE_METADATA_BY_ID = new Map([
  // Installed accountingEntryTypes.fsdbinary row123. accountsvc.GetStaticData
  // translates entryTypeNameID unconditionally; a literal name cannot replace it.
  [JOURNAL_ENTRY_TYPE.ASSET_SAFETY_TAX, ["AssetSafetyTax", 510859, 570551]],
  [JOURNAL_ENTRY_TYPE.PLAYER_TRADING, ["PlayerTrading", 59793, 234499]],
  [JOURNAL_ENTRY_TYPE.MARKET_TRANSACTION, ["MarketTransaction", 59794, 234500]],
  [JOURNAL_ENTRY_TYPE.GM_CASH_TRANSFER, ["GMCashTransfer", 59795, 234502]],
  [JOURNAL_ENTRY_TYPE.PLAYER_DONATION, ["PlayerDonation", 59802, 234508]],
  [JOURNAL_ENTRY_TYPE.OFFICE_RENTAL_FEE, ["OfficeRentalFee", 59805, 234512]],
  [JOURNAL_ENTRY_TYPE.BOUNTY, ["Bounty", 59808, null]],
  [JOURNAL_ENTRY_TYPE.NPC_BOUNTY_PRIZE, ["BountyPrize", 59809, null]],
  [JOURNAL_ENTRY_TYPE.INSURANCE, ["Insurance", 59811, null]],
  [JOURNAL_ENTRY_TYPE.AGENT_MISSION_REWARD, ["AgentMissionReward", 59825, 234515]],
  [
    JOURNAL_ENTRY_TYPE.AGENT_MISSION_TIME_BONUS_REWARD,
    ["AgentMissionTimeBonusReward", 59826, 234516],
  ],
  [
    JOURNAL_ENTRY_TYPE.CORPORATION_TAX_AGENT_REWARDS,
    ["AgentMissionRewardCorporationTax", 59885, 234555],
  ],
  [
    JOURNAL_ENTRY_TYPE.CORPORATION_TAX_AGENT_BONUS_REWARDS,
    ["AgentMissionTimeBonusRewardCorporationTax", 59886, 234556],
  ],
  [
    JOURNAL_ENTRY_TYPE.RELEASE_OF_IMPOUNDED_PROPERTY,
    ["ReleaseOfImpoundedProperty", 59833, null],
  ],
  [JOURNAL_ENTRY_TYPE.MARKET_ESCROW, ["MarketEscrow", 59834, null]],
  [JOURNAL_ENTRY_TYPE.BROKERS_FEE, ["BrokersFee", 59838, null]],
  [
    JOURNAL_ENTRY_TYPE.ALLIANCE_REGISTRATION_FEE,
    ["AllianceRegistrationFee", 59840, 234575],
  ],
  [
    JOURNAL_ENTRY_TYPE.ALLIANCE_MAINTENANCE_FEE,
    // CCP's reference-type key is historically misspelled "Maintainance".
    ["AllianceMaintainanceFee", 59842, null],
  ],
  // refContrabandFine: entryTypeNameID 59843 and entryJournalMessageID 234587, as the client's own
  // accountingEntryTypes has them.
  [JOURNAL_ENTRY_TYPE.CONTRABAND_FINE, ["ContrabandFine", 59843, 234587]],
  [JOURNAL_ENTRY_TYPE.TRANSACTION_TAX, ["TransactionTax", 59846, 234580]],
  [
    JOURNAL_ENTRY_TYPE.JUMP_CLONE_INSTALLATION,
    ["JumpCloneInstallationFee", 59847, 234617],
  ],
  [JOURNAL_ENTRY_TYPE.NPC_BOUNTY_PRIZES, ["BountyPrizes", 59877, null]],
  [
    JOURNAL_ENTRY_TYPE.CORPORATION_TAX_NPC_BOUNTIES,
    ["BountyPrizeCorporationTax", 59884, 234554],
  ],
  [JOURNAL_ENTRY_TYPE.PLANETARY_IMPORT_TAX, ["PlanetaryImportTax", 59888, null]],
  [JOURNAL_ENTRY_TYPE.PLANETARY_EXPORT_TAX, ["PlanetaryExportTax", 59889, null]],
  [JOURNAL_ENTRY_TYPE.PLANETARY_CONSTRUCTION, ["PlanetaryConstruction", 59890, null]],
  // refRewardManager (Homefront payouts). The client's wallet journal looks each
  // row's type up in this list and breaks on a missing one.
  [JOURNAL_ENTRY_TYPE.CORPORATE_REWARD_PAYOUT, ["RewardManager", 59891, 234626]],
  [
    JOURNAL_ENTRY_TYPE.JUMP_CLONE_ACTIVATION,
    ["JumpCloneActivationFee", 312132, 516539],
  ],
  [JOURNAL_ENTRY_TYPE.SKILL_PURCHASE, ["SkillPurchase", 543737, 543653]],
  [JOURNAL_ENTRY_TYPE.MARKET_PROVIDER_TAX, ["SccSurcharge", 559228, null]],
]);

function buildList(items) {
  return { type: "list", items };
}

function buildKeyVal(entries) {
  return {
    type: "object",
    name: "util.KeyVal",
    args: {
      type: "dict",
      entries,
    },
  };
}

function buildRowset(header, rows) {
  return {
    type: "object",
    name: "eve.common.script.sys.rowset.Rowset",
    args: {
      type: "dict",
      entries: [
        ["header", buildList(header)],
        ["RowClass", { type: "token", value: "util.Row" }],
        ["lines", buildList(rows)],
      ],
    },
  };
}

function normalizeNumber(value, fallback = 0) {
  if (value === undefined || value === null) {
    return fallback;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : fallback;
  }

  if (typeof value === "bigint") {
    return Number(value);
  }

  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }

  if (Buffer.isBuffer(value)) {
    return normalizeNumber(value.toString("utf8"), fallback);
  }

  if (typeof value === "string" && value.trim() !== "") {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : fallback;
  }

  if (typeof value === "object") {
    if (value.type === "wstring" || value.type === "token") {
      return normalizeNumber(value.value, fallback);
    }

    if (value.type === "long" || value.type === "int") {
      return normalizeNumber(value.value, fallback);
    }
  }

  return fallback;
}

function normalizeText(value, fallback = "") {
  if (value === undefined || value === null) {
    return fallback;
  }

  if (Buffer.isBuffer(value)) {
    return value.toString("utf8");
  }

  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "object") {
    if (value.type === "wstring" || value.type === "token") {
      return normalizeText(value.value, fallback);
    }
  }

  return String(value);
}

function resolveExplicitDescription(options = {}, fallback = "") {
  if (Object.prototype.hasOwnProperty.call(options, "description")) {
    return normalizeText(options.description, fallback);
  }
  if (Object.prototype.hasOwnProperty.call(options, "reason")) {
    return normalizeText(options.reason, fallback);
  }
  return fallback;
}

// The marshal decoder hands a dict key back in whichever form the wire used, so one
// kwargs dict legitimately mixes them: `toAccountKey` is outside the marshal string
// table and arrives as a raw Buffer, while `machoVersion` sitting beside it is inside
// it (index 134) and arrives as a plain JS string. Comparing the raw key against a JS
// string matched only the second kind, so extractKwarg returned undefined for every
// key the client actually cares about here -- and normalizeCorporationWalletKey's
// fallback turned that undefined into CORPORATION_WALLET_KEY_START, so every
// corporation wallet division deposit landed in division 1000 whichever division the
// player picked.
//
// strVal is the codec's own helper for exactly this, so the four hand-rolled kwarg
// lookups in this tree normalize keys the one way rather than four slightly different
// ways. Only the key is normalized: values are left as the codec produced them,
// because normalizeText and normalizeNumber below already unwrap Buffers.
function extractKwarg(kwargs, key) {
  if (!kwargs || kwargs.type !== "dict" || !Array.isArray(kwargs.entries)) {
    return undefined;
  }

  const match = kwargs.entries.find(
    (entry) => Array.isArray(entry) && strVal(entry[0]) === key,
  );
  return match ? match[1] : undefined;
}

function resolveAccountKey(rawValue) {
  const numericValue = normalizeNumber(rawValue, ACCOUNT_KEY.CASH);
  const textValue = normalizeText(rawValue, "").trim().toLowerCase();

  if (numericValue >= 1000 && numericValue <= 1006) {
    return {
      id: normalizeCorporationWalletKey(numericValue),
      name: getCorporationWalletKeyName(numericValue),
      field: "balance",
    };
  }

  if (textValue === "cash" || /^cash([2-7])$/.test(textValue)) {
    return {
      id: normalizeCorporationWalletKey(textValue),
      name: getCorporationWalletKeyName(textValue),
      field: "balance",
    };
  }

  if (numericValue === ACCOUNT_KEY.AURUM || textValue === "aurum" || textValue === "aur") {
    return {
      id: ACCOUNT_KEY.AURUM,
      name: ACCOUNT_KEY_NAME.AURUM,
      field: "aurBalance",
    };
  }

  return {
    id: ACCOUNT_KEY.CASH,
    name: ACCOUNT_KEY_NAME.CASH,
    field: "balance",
  };
}

async function transferCharacterBalanceToCorporation(
  fromCharId,
  toCorporationID,
  toAccountKey,
  amount,
  options = {},
) {
  const normalizedAmount = normalizeNumber(amount, 0);
  if (!(normalizedAmount > 0)) {
    return {
      success: false,
      errorMsg: "AMOUNT_REQUIRED",
    };
  }

  const sourceWallet = getCharacterWallet(fromCharId);
  const destinationCorporation = getCorporationRecord(toCorporationID);
  if (!sourceWallet) {
    return {
      success: false,
      errorMsg: "CHARACTER_NOT_FOUND",
    };
  }
  if (!destinationCorporation) {
    return {
      success: false,
      errorMsg: "CORPORATION_NOT_FOUND",
    };
  }
  if (sourceWallet.balance < normalizedAmount) {
    return {
      success: false,
      errorMsg: "INSUFFICIENT_FUNDS",
    };
  }

  const normalizedAccountKey = normalizeCorporationWalletKey(toAccountKey);
  // Refused before the debit, so the character keeps ISK the division could
  // not hold past the wallet limit.
  if (
    getCorporationWalletBalance(toCorporationID, normalizedAccountKey) + normalizedAmount >
    MAX_WALLET_BALANCE
  ) {
    return {
      success: false,
      errorMsg: "BALANCE_LIMIT_EXCEEDED",
    };
  }
  const description = resolveExplicitDescription(
    options,
    `Transfer to corporation ${Number(toCorporationID || 0)}`,
  );
  const debitResult = await adjustCharacterBalanceAsync(fromCharId, -normalizedAmount, {
    description,
    ownerID1: fromCharId,
    ownerID2: toCorporationID,
    referenceID: toCorporationID,
    entryTypeID: JOURNAL_ENTRY_TYPE.PLAYER_DONATION,
  });
  if (!debitResult.success) {
    return debitResult;
  }

  const creditResult = await adjustCorporationWalletDivisionBalanceAsync(
    toCorporationID,
    normalizedAccountKey,
    normalizedAmount,
    {
      description,
      ownerID1: fromCharId,
      ownerID2: toCorporationID,
      referenceID: fromCharId,
      entryTypeID: JOURNAL_ENTRY_TYPE.PLAYER_DONATION,
    },
  );
  if (!creditResult.success) {
    await adjustCharacterBalanceAsync(fromCharId, normalizedAmount, {
      description: `Rollback: ${description}`,
      ownerID1: toCorporationID,
      ownerID2: fromCharId,
      referenceID: fromCharId,
      entryTypeID: JOURNAL_ENTRY_TYPE.PLAYER_DONATION,
    });
    return creditResult;
  }

  return {
    success: true,
    from: debitResult.data,
    to: creditResult.data,
    amount: normalizedAmount,
    accountKey: normalizedAccountKey,
  };
}

function resolveSessionCorporationID(session) {
  return Number(session && (session.corporationID || session.corpid || 0)) || 0;
}

async function transferCorporationWalletBalanceForSession(
  session,
  toID,
  fromAccountKey,
  toAccountKey,
  amount,
  options = {},
) {
  const normalizedAmount = normalizeNumber(amount, 0);
  if (!(normalizedAmount > 0)) {
    return {
      success: false,
      errorMsg: "AMOUNT_REQUIRED",
    };
  }

  const fromCorporationID = resolveSessionCorporationID(session);
  const sourceCorporation = getCorporationRecord(fromCorporationID);
  if (!sourceCorporation) {
    return {
      success: false,
      errorMsg: "CORPORATION_NOT_FOUND",
    };
  }

  const normalizedToID = normalizeNumber(toID, 0);
  if (!(normalizedToID > 0)) {
    return {
      success: false,
      errorMsg: "DESTINATION_REQUIRED",
    };
  }

  const normalizedFromAccountKey = normalizeCorporationWalletKey(
    fromAccountKey ?? session.corpAccountKey ?? session.corpaccountkey,
  );
  // Taking ISK out of a corporation wallet division requires the Account Take role
  // for THAT division -- V24.01 checks exactly this in
  // eve.common.lib.corporations.ValidateCorpWalletDivisionAccess, and the stock client
  // only draws Withdraw/Transfer under the matching walletUtil check. The source
  // corporation is already session-scoped, but the division is caller-supplied, so it
  // has to be validated against the role rather than against session.corpAccountKey:
  // that key is the member's default division, not a permission boundary. Checking the
  // normalized key is what makes the gate and the debit below agree on which division
  // is being emptied. Director and CEO pass without a special case -- their session
  // role mask already carries every Account Take bit.
  const requiredWalletDivisionRole = getCorporationWalletDivisionTakeRole(
    normalizedFromAccountKey,
  );
  if (
    !requiredWalletDivisionRole ||
    !corporationAuthorityHasRole(
      getPersistedCorporationAuthority(session),
      requiredWalletDivisionRole,
    )
  ) {
    // Refused here rather than by returning an errorMsg for the caller to translate.
    // V24.01's ValidateCorpWalletDivisionAccess raises from the validator too, and
    // returning a soft failure would leave the client showing its optimistic
    // "Transfer Successful" for a transfer the server declined.
    log.warn(
      `[AccountService] GiveCashFromCorpAccount denied: no Account Take role `
        + `char=${session.characterID || session.charid} `
        + `corp=${fromCorporationID} `
        + `fromAccountKey=${normalizedFromAccountKey} `
        + `to=${normalizedToID} amount=${normalizedAmount}`,
    );
    machoErrors.throwWrappedUserError("CrpAccessDenied", {
      reason: [
        101,
        "UI/Corporations/AccessRestrictions/NoAccessToWalletDivision",
      ],
    });
  }

  const destinationCorporation = getCorporationRecord(normalizedToID);
  const description = resolveExplicitDescription(
    options,
    `Corporation wallet transfer to ${normalizedToID}`,
  );

  if (destinationCorporation) {
    const normalizedToAccountKey = normalizeCorporationWalletKey(toAccountKey);
    if (
      Number(fromCorporationID) === Number(normalizedToID) &&
      normalizedFromAccountKey === normalizedToAccountKey
    ) {
      // Reporting success for a transfer that moved nothing makes a real failure
      // indistinguishable from a no-op: the client shows no error, the balances do
      // not change, and the player is left guessing which happened. It also hid the
      // routing bug above -- while the division kwarg was being dropped, every
      // division-to-division transfer collapsed to master-to-master and silently
      // "succeeded" here.
      return {
        success: false,
        errorMsg: "SAME_WALLET_DIVISION",
      };
    }
    // Refused before the debit, so the source division keeps ISK the target
    // division could not hold past the wallet limit.
    if (
      getCorporationWalletBalance(normalizedToID, normalizedToAccountKey) + normalizedAmount >
      MAX_WALLET_BALANCE
    ) {
      return {
        success: false,
        errorMsg: "BALANCE_LIMIT_EXCEEDED",
      };
    }

    const debitResult = await adjustCorporationWalletDivisionBalanceAsync(
      fromCorporationID,
      normalizedFromAccountKey,
      -normalizedAmount,
      {
        description,
        ownerID1: fromCorporationID,
        ownerID2: normalizedToID,
        referenceID: normalizedToID,
        entryTypeID: JOURNAL_ENTRY_TYPE.PLAYER_DONATION,
      },
    );
    if (!debitResult.success) {
      return debitResult;
    }

    const creditResult = await adjustCorporationWalletDivisionBalanceAsync(
      normalizedToID,
      normalizedToAccountKey,
      normalizedAmount,
      {
        description,
        ownerID1: fromCorporationID,
        ownerID2: normalizedToID,
        referenceID: fromCorporationID,
        entryTypeID: JOURNAL_ENTRY_TYPE.PLAYER_DONATION,
      },
    );
    if (!creditResult.success) {
      await adjustCorporationWalletDivisionBalanceAsync(
        fromCorporationID,
        normalizedFromAccountKey,
        normalizedAmount,
        {
          description: `Rollback: ${description}`,
          ownerID1: normalizedToID,
          ownerID2: fromCorporationID,
          referenceID: fromCorporationID,
          entryTypeID: JOURNAL_ENTRY_TYPE.PLAYER_DONATION,
        },
      );
      return creditResult;
    }

    return {
      success: true,
      from: debitResult.data,
      to: creditResult.data,
      amount: normalizedAmount,
      fromAccountKey: normalizedFromAccountKey,
      toAccountKey: normalizedToAccountKey,
    };
  }

  const destinationWallet = getCharacterWallet(normalizedToID);
  if (!destinationWallet) {
    return {
      success: false,
      errorMsg: "CHARACTER_NOT_FOUND",
    };
  }
  // Refused before the debit, so the division keeps ISK the character could
  // not hold past the wallet limit.
  if (destinationWallet.balance + normalizedAmount > MAX_WALLET_BALANCE) {
    return {
      success: false,
      errorMsg: "BALANCE_LIMIT_EXCEEDED",
    };
  }

  const debitResult = await adjustCorporationWalletDivisionBalanceAsync(
    fromCorporationID,
    normalizedFromAccountKey,
    -normalizedAmount,
    {
      description,
      ownerID1: fromCorporationID,
      ownerID2: normalizedToID,
      referenceID: normalizedToID,
      entryTypeID: JOURNAL_ENTRY_TYPE.PLAYER_DONATION,
    },
  );
  if (!debitResult.success) {
    return debitResult;
  }

  const creditResult = await adjustCharacterBalanceAsync(normalizedToID, normalizedAmount, {
    description,
    ownerID1: fromCorporationID,
    ownerID2: normalizedToID,
    referenceID: fromCorporationID,
    entryTypeID: JOURNAL_ENTRY_TYPE.PLAYER_DONATION,
  });
  if (!creditResult.success) {
    await adjustCorporationWalletDivisionBalanceAsync(
      fromCorporationID,
      normalizedFromAccountKey,
      normalizedAmount,
      {
        description: `Rollback: ${description}`,
        ownerID1: normalizedToID,
        ownerID2: fromCorporationID,
        referenceID: fromCorporationID,
        entryTypeID: JOURNAL_ENTRY_TYPE.PLAYER_DONATION,
      },
    );
    return creditResult;
  }

  return {
    success: true,
    from: debitResult.data,
    to: creditResult.data,
    amount: normalizedAmount,
    fromAccountKey: normalizedFromAccountKey,
  };
}

// A planetary import or export tax written before the customs settlement kept the office's owner names the office's
// item ID as its second party (a default office's is 1_200_000_000_000 and more), which the transaction row's int32
// column cannot carry (one such row made GetTransactions throw for the whole list) and the client's owner cache
// cannot name (transactionsPanel.py 131 to 134 primes ownerID2 with cfg.eveowners). Read it as the office's owner.
function resolveJournalOwnerID2(entry) {
  const ownerID2 = normalizeNumber(entry.ownerID2, 0);
  const entryTypeID = normalizeNumber(entry.entryTypeID, 0);
  if (
    ownerID2 <= 0x7fffffff ||
    (entryTypeID !== JOURNAL_ENTRY_TYPE.PLANETARY_IMPORT_TAX &&
      entryTypeID !== JOURNAL_ENTRY_TYPE.PLANETARY_EXPORT_TAX)
  ) {
    return ownerID2;
  }
  return require(path.join(__dirname, "../planet/planetOrbitalState")).peekOrbitalOwnerID(ownerID2);
}

function buildJournalRowset(entries) {
  const rows = entries.map((entry) =>
    buildList([
      normalizeNumber(entry.transactionID, 0),
      { type: "long", value: BigInt(String(entry.transactionDate || 0)) },
      normalizeNumber(entry.referenceID, 0),
      normalizeNumber(entry.entryTypeID, JOURNAL_ENTRY_TYPE.ADMIN_ADJUSTMENT),
      normalizeNumber(entry.ownerID1, 0),
      resolveJournalOwnerID2(entry),
      normalizeNumber(entry.accountKey, ACCOUNT_KEY.CASH),
      normalizeNumber(entry.amount, 0),
      normalizeNumber(entry.balance, 0),
      normalizeText(entry.description, ""),
      normalizeNumber(entry.currency, 1),
      normalizeNumber(entry.sortValue, 1),
    ]),
  );

  return buildRowset(JOURNAL_HEADERS, rows);
}

function buildTransactionEntry(entry) {
  // Native GetTransactionKeyVal supplies currency and sortValue locally.
  // The selected accountKey scopes the query, rather than appearing on each row.
  return buildPackedRow(TRANSACTION_COLUMNS, {
    transactionID: normalizeNumber(entry.transactionID, 0),
    transactionDate: { type: "long", value: BigInt(String(entry.transactionDate || 0)) },
    referenceID: entry.referenceID == null ? null : normalizeNumber(entry.referenceID, 0),
    description: entry.description == null ? null : normalizeText(entry.description, ""),
    ownerID1: normalizeNumber(entry.ownerID1, 0),
    ownerID2: resolveJournalOwnerID2(entry),
    entryTypeID: normalizeNumber(entry.entryTypeID, JOURNAL_ENTRY_TYPE.ADMIN_ADJUSTMENT),
    amount: normalizeNumber(entry.amount, 0),
    balance: normalizeNumber(entry.balance, 0),
  });
}

function buildTransactionList(entries) {
  return buildList(entries.map((entry) => buildTransactionEntry(entry)));
}

// Every corporation-wallet read goes through here. Refusing rather than returning an
// empty result is what the client expects: walletSvc.GetCorpWealth wraps its
// GetCashBalance call in `except UserError` and falls back to 0, so a raise is the
// documented way to say "not yours to see". An empty rowset would instead read as
// "this division has no history", which is a different and misleading answer.
function requireCorporationWalletDivisionRead(session, accountKey, method) {
  if (hasCorporationWalletDivisionReadAccess(session, accountKey)) {
    return;
  }
  log.warn(
    `[AccountService] ${method} denied: no read access to corporation wallet division `
      + `char=${session && (session.characterID || session.charid)} `
      + `corp=${resolveSessionCorporationID(session)} accountKey=${accountKey}`,
  );
  machoErrors.throwWrappedUserError("CrpAccessDenied", {
    reason: [
      101,
      "UI/Corporations/AccessRestrictions/NoAccessToWalletDivision",
    ],
  });
}

class AccountService extends BaseService {
  constructor() {
    super("account");
  }

  Handle_GetCashBalance(args, session, kwargs) {
    const isCorpWallet =
      normalizeNumber(extractKwarg(kwargs, "isCorpWallet"), NaN) ||
      normalizeNumber(args && args[0], 0);
    const walletKey = resolveAccountKey(
      extractKwarg(kwargs, "accountKey") ?? (args && args[1]) ??
        // walletSvc.GetCorpWealth forwards None for the active division;
        // TransferMoneyWnd reads it before filling in fromAccountKey locally.
        (isCorpWallet && session
          ? session.corpAccountKey ?? session.corpaccountkey
          : undefined),
    );
    // Money goes out as a float, the type the client's wallet holds. A plain
    // whole number is marshalled as an int64, which throws for a huge balance.
    if (isCorpWallet) {
      requireCorporationWalletDivisionRead(session, walletKey.id, "GetCashBalance");
      return buildMarshalRealMoney(
        getCorporationWalletBalance(
          session && (session.corporationID || session.corpid),
          walletKey.id,
        ),
        0,
      );
    }

    const wallet = getCharacterWallet(session && session.characterID);
    return buildMarshalRealMoney(wallet ? wallet[walletKey.field] : 0, 0);
  }

  Handle_GetKeyMap() {
    return buildList([
      buildKeyVal([
        ["key", ACCOUNT_KEY.CASH],
        ["keyName", ACCOUNT_KEY_NAME.CASH],
        ["name", ACCOUNT_KEY_NAME.CASH],
      ]),
      buildKeyVal([
        ["key", ACCOUNT_KEY.AURUM],
        ["keyName", ACCOUNT_KEY_NAME.AURUM],
        ["name", ACCOUNT_KEY_NAME.AURUM],
      ]),
    ]);
  }

  Handle_GetEntryTypes(args = []) {
    const entryTypes = buildList(
      [...ENTRY_TYPE_METADATA_BY_ID.entries()].map(
        ([entryTypeID, [entryTypeName, entryTypeNameID, entryJournalMessageID]]) =>
          buildKeyVal([
            ["entryTypeID", entryTypeID],
            ["entryTypeNameID", entryTypeNameID],
            ["entryTypeName", entryTypeName],
            ["entryJournalMessageID", entryJournalMessageID],
          ]),
      ),
    );
    return buildCachedMethodCallResult(entryTypes, {
      serviceName: this.name,
      method: "GetEntryTypes",
      args,
    });
  }

  Handle_GetWalletDivisionsInfo(args, session) {
    const corporationID = session && (session.corporationID || session.corpid);
    if (corporationID) {
      // Filtered rather than refused. This is the only call that enumerates the
      // divisions, and the Divisions tab is built from it, so a member who may read
      // some divisions should see those instead of losing the tab entirely. The
      // authority is resolved once here: the per-division helper re-reads the
      // persisted membership on every call.
      const authority = getPersistedCorporationAuthority(session);
      return buildList(
        getCorporationWalletDivisionsInfo(corporationID)
          .filter((division) =>
            corporationAuthorityHasWalletDivisionReadAccess(
              authority,
              normalizeNumber(division.key, ACCOUNT_KEY.CASH),
            ),
          )
          .map((division) =>
            buildKeyVal([
              ["key", normalizeNumber(division.key, ACCOUNT_KEY.CASH)],
              ["balance", buildMarshalRealMoney(division.balance, 0)],
            ]),
          ),
      );
    }

    const wallet = getCharacterWallet(session && session.characterID);
    return buildList([
      buildKeyVal([
        ["key", ACCOUNT_KEY.CASH],
        ["balance", buildMarshalRealMoney(wallet ? wallet.balance : 0, 0)],
      ]),
      buildKeyVal([
        ["key", ACCOUNT_KEY.AURUM],
        ["balance", buildMarshalRealMoney(wallet ? wallet.aurBalance : 0, 0)],
      ]),
    ]);
  }

  Handle_GetAurumBalance(args, session) {
    const wallet = getCharacterWallet(session && session.characterID);
    return buildMarshalRealMoney(wallet ? wallet.aurBalance : 0, 0);
  }

  Handle_GetDefaultWalletDivision() {
    return ACCOUNT_KEY.CASH;
  }

  Handle_GetDefaultContactCost() {
    return null;
  }

  Handle_SetContactCost() {
    return null;
  }

  Handle_GetJournal(args, session) {
    const isCorpWallet = normalizeNumber(args && args[3], 0);
    if (isCorpWallet) {
      requireCorporationWalletDivisionRead(
        session,
        normalizeCorporationWalletKey(args && args[0]),
        "GetJournal",
      );
      return buildJournalRowset(
        getCorporationWalletJournal(session && (session.corporationID || session.corpid), {
          accountKey: args && args[0],
          year: args && args[1],
          month: args && args[2],
        }),
      );
    }
    return buildJournalRowset(
      getCharacterWalletJournal(session && session.characterID),
    );
  }

  Handle_GetJournalForAccounts(args, session) {
    const accountKey = args && args.length > 0 ? args[0] : ACCOUNT_KEY.CASH;
    if (session && (session.corporationID || session.corpid)) {
      requireCorporationWalletDivisionRead(
        session,
        normalizeCorporationWalletKey(accountKey),
        "GetJournalForAccounts",
      );
      return buildJournalRowset(
        getCorporationWalletJournal(session.corporationID || session.corpid, {
          accountKey,
        }),
      );
    }
    return buildJournalRowset(
      getCharacterWalletJournal(session && session.characterID),
    );
  }

  Handle_GetTransactions(args, session, kwargs) {
    const isCorpWallet =
      normalizeNumber(extractKwarg(kwargs, "isCorpWallet"), NaN) ||
      normalizeNumber(args && args[3], 0);
    const walletKey = resolveAccountKey(
      extractKwarg(kwargs, "accountKey") ?? (args && args[0]),
    );
    const year = normalizeNumber(args && args[1], NaN);
    const month = normalizeNumber(args && args[2], NaN);
    if (isCorpWallet) {
      requireCorporationWalletDivisionRead(session, walletKey.id, "GetTransactions");
      return buildTransactionList(
        getCorporationWalletTransactions(
          session && (session.corporationID || session.corpid),
          {
            accountKey: walletKey.id,
            year,
            month,
          },
        ),
      );
    }

    return buildTransactionList(
      getCharacterWalletTransactions(session && session.characterID, {
        accountKey: walletKey.id,
        year,
        month,
      }),
    );
  }

  async Handle_GiveCash(args, session, kwargs) {
    const toID = normalizeNumber(args && args[0], 0);
    const amount = normalizeNumber(args && args[1], 0);
    const reason = normalizeText(
      extractKwarg(kwargs, "reason") ?? (args && args[2]),
      `Player donation to ${toID}`,
    );

    if (!session || !session.characterID || !(toID > 0) || !(amount > 0)) {
      return null;
    }

    const destinationCorporation = getCorporationRecord(toID);
    const result = destinationCorporation
      ? await transferCharacterBalanceToCorporation(
          session.characterID,
          toID,
          extractKwarg(kwargs, "toAccountKey"),
          amount,
          {
            description: reason,
          },
        )
      : await transferCharacterBalanceAsync(session.characterID, toID, amount, {
          description: reason,
        });
    if (!result.success) {
      if (result.errorMsg === "INSUFFICIENT_FUNDS") {
        // Refused before any ISK moved, and for the same reason said: the
        // client's transfer window says the transfer was made whenever
        // GiveCash comes back (transferMoneyWnd.py Confirm, 148 to 151). A
        // wallet short of the gift is the client's NotEnoughMoney, with what
        // it holds and what was asked, as the server's other shortfalls are.
        const wallet = getCharacterWallet(session.characterID);
        machoErrors.throwWrappedUserError(
          "NotEnoughMoney",
          buildNotEnoughMoneyUserErrorValues(amount, wallet ? wallet.balance : 0),
        );
      }
      if (result.errorMsg === "BALANCE_LIMIT_EXCEEDED") {
        // Refused before any ISK moved. Said out loud, because a silent null
        // leaves the client showing its own "transfer successful".
        machoErrors.throwWrappedUserError("CustomInfo", {
          info:
            "That transfer was refused: the receiving wallet cannot hold more than "
            + `${MAX_WALLET_BALANCE.toLocaleString("en-US")} ISK.`,
        });
      }
      log.warn(
        `[AccountService] GiveCash failed: ${result.errorMsg} from=${session.characterID} to=${toID} amount=${amount}`,
      );
      return null;
    }

    if (destinationCorporation) {
      return [
        Number(result.from && result.from.balance) || 0,
        Number(result.to && result.to.balance) || 0,
      ];
    }
    // The wallet's Give ISK tab says the transfer was made, and clears itself, only where this comes back as
    // something (giveIskPanel.py TransferISK: `if ret:`); None left it saying nothing. What Tranquility's server
    // answers a gift to a character is not recorded (its one recorded transfer, to a corporation, answered the two
    // balances). The receiving pilot's balance is not this pilot's to be told, and the client reads nothing of the
    // answer but that it is: True.
    return true;
  }

  async Handle_GiveCashFromCorpAccount(args, session, kwargs) {
    const toID = normalizeNumber(args && args[0], 0);
    const amount = normalizeNumber(args && args[1], 0);
    const fromAccountKey = args && args[2];
    const reason = normalizeText(
      extractKwarg(kwargs, "reason") ?? (args && args[3]),
      `Corporation wallet transfer to ${toID}`,
    );

    if (!session || !(toID > 0) || !(amount > 0)) {
      return null;
    }

    const result = await transferCorporationWalletBalanceForSession(
      session,
      toID,
      fromAccountKey,
      extractKwarg(kwargs, "toAccountKey"),
      amount,
      {
        description: reason,
      },
    );
    if (!result.success) {
      if (result.errorMsg === "INSUFFICIENT_FUNDS") {
        // TransferMoneyWnd.Confirm displays success after any normal return.
        // Report the actual source division's shortfall instead of None.
        const sourceAccountKey = normalizeCorporationWalletKey(
          fromAccountKey ?? session.corpAccountKey ?? session.corpaccountkey,
        );
        machoErrors.throwWrappedUserError(
          "NotEnoughMoney",
          buildNotEnoughMoneyUserErrorValues(amount, getCorporationWalletBalance(
            resolveSessionCorporationID(session), sourceAccountKey,
          )),
        );
      }
      if (result.errorMsg === "BALANCE_LIMIT_EXCEEDED") {
        machoErrors.throwWrappedUserError("CustomInfo", {
          info:
            "That transfer was refused: the receiving wallet cannot hold more than "
            + `${MAX_WALLET_BALANCE.toLocaleString("en-US")} ISK.`,
        });
      }
      if (result.errorMsg === "SAME_WALLET_DIVISION") {
        // Surfaced to the player rather than only logged, because this is the one
        // failure of this handler the client cannot detect for itself: it will
        // happily let a division be picked as its own destination. Throwing returns
        // before the log.warn below, so this refusal leaves no server-side WARN --
        // deliberate, since it is player input error rather than a server fault.
        machoErrors.throwWrappedUserError("CustomInfo", {
          info:
            "That would move ISK from a corporation wallet division into itself. "
            + "Choose a different destination division.",
        });
      }
      log.warn(
        `[AccountService] GiveCashFromCorpAccount failed: ${result.errorMsg} corp=${resolveSessionCorporationID(session)} to=${toID} amount=${amount}`,
      );
    }

    return null;
  }
}

module.exports = AccountService;
