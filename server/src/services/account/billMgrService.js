"use strict";

const path = require("path");

const BaseService = require(path.join(__dirname, "../baseService"));
const log = require(path.join(__dirname, "../../utils/logger"));
const {
  throwWrappedUserError,
} = require(path.join(__dirname, "../../common/machoErrors"));
const {
  buildDict,
  buildFiletimeLong,
  buildKeyVal,
  buildList,
  extractDictEntries,
} = require(path.join(__dirname, "../_shared/serviceHelpers"));
const { strVal } = require(path.join(
  __dirname,
  "../../network/tcp/utils/marshal",
));
const {
  buildNotEnoughMoneyUserErrorValues,
} = require(path.join(__dirname, "./walletState"));
const {
  buildAutomaticPaySettingsSnapshot,
  getBillRecord,
  listBillsForCreditor,
  listUnpaidBillsForDebtor,
  payBillFromCharacter,
  payBillFromCorporation,
  setAutomaticPaySettingsForOwner,
} = require(path.join(__dirname, "./billRuntimeState"));
const {
  processDueOfficeRentalBills,
} = require(path.join(__dirname, "../corporation/officeRentalBilling"));
const {
  processDueWarBills,
} = require(path.join(__dirname, "../corporation/warRuntimeState"));
const {
  CORP_ROLE_ACCOUNTANT,
  CORP_ROLE_JUNIOR_ACCOUNTANT,
  getCorporationWalletDivisionTakeRole,
} = require(path.join(__dirname, "../corporation/corporationRuntimeState"));
const {
  corporationAuthorityHasRole,
  getAllianceExecutorRoleAuthority,
  getPersistedCorporationAuthority,
} = require(path.join(__dirname, "../corporation/corporationAuthority"));

function resolveAllianceID(session) {
  return Number(session && (session.allianceID || session.allianceid)) || 0;
}

function resolveCharacterID(session) {
  return Number(session && (session.characterID || session.charid)) || 0;
}

// extractDictEntries hands back the decoder's entries untouched, so the key still
// carries whatever form the wire used -- a raw Buffer for any key outside the marshal
// string table, which `fromAccountKey` is. Comparing it raw dropped the kwarg and
// Handle_PayCorporationBill fell back to division 1000, paying the bill out of the
// master wallet whichever division the player picked. strVal is the codec's own
// normalizer; see the note on accountService.extractKwarg for the full shape.
function extractKwargValue(kwargs, key) {
  for (const [entryKey, entryValue] of extractDictEntries(kwargs)) {
    if (strVal(entryKey) === key) {
      return entryValue;
    }
  }
  return undefined;
}

function normalizeBoolLike(value) {
  if (
    value &&
    typeof value === "object" &&
    (value.type === "int" || value.type === "long")
  ) {
    return Number(value.value || 0) !== 0;
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return Number(value) !== 0;
  }
  return Boolean(value);
}

function buildBillPayload(bill) {
  return buildKeyVal([
    ["billID", Number(bill && bill.billID ? bill.billID : 0)],
    ["billTypeID", Number(bill && bill.billTypeID ? bill.billTypeID : 0)],
    ["amount", Number(bill && bill.amount ? bill.amount : 0)],
    ["interest", Number(bill && bill.interest ? bill.interest : 0)],
    ["debtorID", Number(bill && bill.debtorID ? bill.debtorID : 0)],
    ["creditorID", Number(bill && bill.creditorID ? bill.creditorID : 0)],
    [
      "dueDateTime",
      buildFiletimeLong(bill && bill.dueDateTime ? bill.dueDateTime : "0"),
    ],
    ["paid", bill && bill.paid ? 1 : 0],
    [
      "paidDateTime",
      bill && bill.paidDateTime ? buildFiletimeLong(bill.paidDateTime) : null,
    ],
    ["paidByOwnerID", Number(bill && bill.paidByOwnerID ? bill.paidByOwnerID : 0)],
    [
      "externalID",
      bill && bill.externalID !== undefined && bill.externalID !== null
        ? Number(bill.externalID)
        : -1,
    ],
    [
      "externalID2",
      bill && bill.externalID2 !== undefined && bill.externalID2 !== null
        ? Number(bill.externalID2)
        : -1,
    ],
  ]);
}

// Eleven distinct refusals (BILL_NOT_FOUND, BILL_NOT_PAYABLE, BILL_PAYMENT_IN_PROGRESS,
// WALLET_DEBIT_FAILED, …) reach the client as one opaque CustomNotify, so the reason has
// to be logged here or it is unrecoverable from the server log (EW-0402).
function throwBillPaymentFailure(result, bill = null, billID = 0) {
  const errorMsg = result && result.errorMsg ? String(result.errorMsg) : "BILL_PAYMENT_FAILED";
  const loggedBillID = Number(billID) || Number(bill && bill.billID) || 0;
  log.warn(
    `[BillMgr] Bill payment refused bill=${loggedBillID} reason=${errorMsg}`,
  );
  if (errorMsg === "INSUFFICIENT_FUNDS") {
    const balance =
      result && result.data && result.data.balance !== undefined
        ? result.data.balance
        : 0;
    throwWrappedUserError(
      "NotEnoughMoney",
      buildNotEnoughMoneyUserErrorValues(Number(bill && bill.amount) || 0, balance),
    );
  }

  if (errorMsg === "ONLY_EXECUTOR_CAN_PAY") {
    throwWrappedUserError("CrpAccessDenied");
  }

  throwWrappedUserError("CustomNotify", {
    notify: errorMsg,
  });
}

function parseAutomaticPaySettings(rawSettings) {
  const parsed = {};
  for (const [ownerID, settingsValue] of extractDictEntries(rawSettings)) {
    const numericOwnerID = Number(ownerID) || 0;
    if (!numericOwnerID) {
      continue;
    }
    parsed[numericOwnerID] = {};
    for (const [key, value] of extractDictEntries(settingsValue)) {
      if (key === "divisionID") {
        parsed[numericOwnerID].divisionID =
          Number(
            value &&
              typeof value === "object" &&
              (value.type === "int" || value.type === "long")
              ? value.value
              : value,
          ) || 1000;
        continue;
      }
      parsed[numericOwnerID][Number(key) || 0] = normalizeBoolLike(value);
    }
  }
  return parsed;
}

function requireAutomaticPayReadAuthority(session) {
  const authority = getPersistedCorporationAuthority(session);
  if (
    !corporationAuthorityHasRole(authority, CORP_ROLE_ACCOUNTANT) &&
    !corporationAuthorityHasRole(authority, CORP_ROLE_JUNIOR_ACCOUNTANT)
  ) {
    throwWrappedUserError("CrpAccessDenied");
  }
  return authority;
}

function requireAutomaticPayWriteAuthority(session) {
  const authority = getPersistedCorporationAuthority(session);
  if (!corporationAuthorityHasRole(authority, CORP_ROLE_ACCOUNTANT)) {
    throwWrappedUserError("CrpAccessDenied");
  }
  return authority;
}

class BillManagerService extends BaseService {
  constructor() {
    super("billMgr");
  }

  Handle_GetAutomaticPaySettings(args, session) {
    const authority = requireAutomaticPayReadAuthority(session);
    const ownerIDs = [authority.corporationID];
    const allianceID = Number(authority.corporation.allianceID) || 0;
    const allianceAuthority = allianceID
      ? getAllianceExecutorRoleAuthority(
        session,
        allianceID,
        CORP_ROLE_ACCOUNTANT,
      ) || getAllianceExecutorRoleAuthority(
        session,
        allianceID,
        CORP_ROLE_JUNIOR_ACCOUNTANT,
      )
      : null;
    if (allianceAuthority) {
      ownerIDs.push(allianceID);
    }
    return buildDict(
      Object.entries(buildAutomaticPaySettingsSnapshot(ownerIDs)).map(
        ([ownerID, settings]) => [
          Number(ownerID),
          buildDict(
            Object.entries(settings).map(([key, value]) => [key === "divisionID" ? key : Number(key), value]),
          ),
        ],
      ),
    );
  }

  Handle_SendAutomaticPaySettings(args, session) {
    const authority = requireAutomaticPayWriteAuthority(session);
    const parsedSettings = parseAutomaticPaySettings(args && args[0]);
    const allianceID = Number(authority.corporation.allianceID) || 0;
    const allianceAuthority = allianceID
      ? getAllianceExecutorRoleAuthority(
        session,
        allianceID,
        CORP_ROLE_ACCOUNTANT,
      )
      : null;
    const allowedOwnerIDs = new Set([authority.corporationID]);
    if (allianceAuthority) {
      allowedOwnerIDs.add(allianceID);
    }

    // Validate the complete snapshot before writing any row. The client sends
    // every displayed owner back in one request, so a forged alliance owner
    // must fail atomically instead of partially changing the corporation row.
    const entries = Object.entries(parsedSettings);
    if (entries.some(([ownerID]) => !allowedOwnerIDs.has(Number(ownerID)))) {
      throwWrappedUserError("CrpAccessDenied");
    }
    for (const [, settings] of entries) {
      const takeRole = getCorporationWalletDivisionTakeRole(settings.divisionID ?? 1000);
      if (!takeRole || !corporationAuthorityHasRole(authority, takeRole)) {
        throwWrappedUserError("CrpAccessDenied");
      }
    }
    for (const [ownerID, settings] of entries) {
      if (allowedOwnerIDs.has(Number(ownerID))) {
        setAutomaticPaySettingsForOwner(ownerID, settings);
      }
    }
    return null;
  }

  Handle_GetCorporationBills(args, session) {
    const authority = requireAutomaticPayReadAuthority(session);
    return buildList(
      listUnpaidBillsForDebtor(authority.corporationID).map((bill) =>
        buildBillPayload(bill),
      ),
    );
  }

  Handle_GetCorporationBillsReceivable(args, session) {
    const authority = requireAutomaticPayReadAuthority(session);
    return buildList(
      listBillsForCreditor(authority.corporationID).map((bill) =>
        buildBillPayload(bill),
      ),
    );
  }

  async Handle_PayCorporationBill(args, session, kwargs) {
    const authority = getPersistedCorporationAuthority(session);
    if (!corporationAuthorityHasRole(authority, CORP_ROLE_ACCOUNTANT)) {
      throwWrappedUserError("CrpAccessDenied");
    }
    const billID = Number(args && args[0]) || 0;
    const fromAccountKey =
      Number(
        extractKwargValue(kwargs, "fromAccountKey") ??
          (args && args[1]) ??
          1000,
      ) || 1000;
    const bill = getBillRecord(billID);
    const takeRole = getCorporationWalletDivisionTakeRole(fromAccountKey);
    if (!takeRole || !corporationAuthorityHasRole(authority, takeRole)) {
      throwWrappedUserError("CrpAccessDenied");
    }
    const result = await payBillFromCorporation(
      billID,
      authority.corporationID,
      fromAccountKey,
    );
    if (!result || result.success !== true) {
      throwBillPaymentFailure(result, bill, billID);
    }
    await processDueOfficeRentalBills({ billID, session });
    await processDueWarBills({ billID, session });
    return null;
  }

  async Handle_CharPayBill(args, session) {
    const billID = Number(args && args[0]) || 0;
    const bill = getBillRecord(billID);
    const result = await payBillFromCharacter(
      billID,
      resolveCharacterID(session),
    );
    if (!result || result.success !== true) {
      throwBillPaymentFailure(result, bill, billID);
    }
    return null;
  }
}

module.exports = BillManagerService;
