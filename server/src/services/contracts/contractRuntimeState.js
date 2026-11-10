"use strict";

const path = require("path");

const {
  createTableRepository,
} = require(path.join(__dirname, "../../gameStore/tableRepository"));
const { throwWrappedUserError } = require(path.join(
  __dirname,
  "../../common/machoErrors",
));
const {
  currentFileTime: wallClockFileTime,
  normalizeNumber,
  unwrapMarshalValue,
} = require(path.join(__dirname, "../_shared/serviceHelpers"));
const {
  ITEM_FLAGS,
  findItemById,
  getInventoryItemUnitVolume,
  getItemMetadata,
  listContainerItems,
  setPlasticWrapVolumeDurably,
} = require(path.join(__dirname, "../inventory/itemStore"));
const contractItemCustody = require(path.join(
  __dirname,
  "../inventory/contractItemCustody",
));
const { CUSTODY_REASON } = require(path.join(
  __dirname,
  "../inventory/itemCustody",
));
const {
  JOURNAL_ENTRY_TYPE,
  adjustCharacterBalanceAsync,
  getCharacterWallet,
} = require(path.join(__dirname, "../account/walletState"));
const {
  CORPORATION_WALLET_KEY_START,
  adjustCorporationWalletDivisionBalanceAsync,
  getCorporationWalletBalance,
  normalizeCorporationWalletKey,
} = require(path.join(__dirname, "../corporation/corpWalletState"));
const contractSettlementState = require("./contractSettlementState");
const { ROLE_GML, normalizeRoleValue } = require("../account/accountRoleProfiles");
const { isWalletAuthorityProcessEnabled } = require("../account/walletCommandAuthority");
// The settlement store runs this step for scheduled and in-process settlements alike.
contractSettlementState.setSettlementExecutor(settleContractOperation);
const contractNotifications = require("./contractNotifications");
const sessionRegistry = require(path.join(__dirname, "../chat/sessionRegistry"));
const {
  fanCorporationOfficeInventoryChanges,
} = require(path.join(__dirname, "../inventory/corporationOfficeInventoryObservers"));
const worldData = require(path.join(__dirname, "../../space/worldData"));
const log = require(path.join(__dirname, "../../utils/logger"));

const repo = createTableRepository("service:contracts", { strict: true });

const TABLE = "contractRuntime";
const CONTRACT_ID_START = 980000000;
const PRIVATE_CONTRACT_BROKER_FEE = 10000;
const CONTRACT_ESCROW_LOCATION_BASE = 9_300_000_000;
const CONTRACT_ESCROW_OWNER_ID = 1;
const PLASTIC_WRAP_TYPE_ID = 3468;
// Pinned client contractscommon.const_conCourierMaxVolume.
const COURIER_MAX_VOLUME = 1_200_000;
const DAY_FILETIME_TICKS = 24n * 60n * 60n * 10_000_000n;
const SECOND_FILETIME_TICKS = 10_000_000;
const CORP_ROLE_CONTRACT_MANAGER = 72057594037927936n;
const CONTRACTS_PER_PAGE = 100;
const DEFINITIVE_WALLET_ERRORS = new Set([
  "CHARACTER_NOT_FOUND",
  "CORPORATION_NOT_FOUND",
  "IDEMPOTENCY_KEY_INVALID",
  "IDEMPOTENCY_KEY_REUSED",
  "INSUFFICIENT_FUNDS",
]);

const CONTRACT_TYPE = Object.freeze({
  ITEM_EXCHANGE: 1,
  AUCTION: 2,
  COURIER: 3,
});

const CONTRACT_STATUS = Object.freeze({
  OUTSTANDING: 0,
  IN_PROGRESS: 1,
  FINISHED_ISSUER: 2,
  FINISHED_CONTRACTOR: 3,
  FINISHED: 4,
  CANCELLED: 5,
  REJECTED: 6,
  FAILED: 7,
  DELETED: 8,
  REVERSED: 9,
  BID_ON_BY: 10,
  REQUIRES_ATTENTION: -1,
});

const CONTRACT_AVAILABILITY = Object.freeze({
  PUBLIC: 0,
  MYSELF: 1,
  MY_CORP: 2,
  MY_ALLIANCE: 3,
});

const CONTRACT_SEARCH_SORT = Object.freeze({
  ID: 0,
  PRICE: 1,
  EXPIRED: 2,
  STATION_ID: 3,
  SOLARSYSTEM_ID: 4,
  REGION_ID: 5,
  CONSTELLATION_ID: 6,
  CONTRACT_TYPE: 7,
  REWARD: 8,
  COLLATERAL: 9,
  VOLUME: 10,
  ASSIGNEE_ID: 11,
});

const CONTRACT_SEARCH_HINT = Object.freeze({
  BPO: 1,
  BPC: 2,
});

const SECURITY_CLASS = Object.freeze({
  ZERO_SEC: 0,
  LOW_SEC: 1,
  HIGH_SEC: 2,
  SAFE_SEC: 3,
});

const CORP_CONTRACT_ITEM_FLAGS = new Set([
  ITEM_FLAGS.CORP_DELIVERIES,
  115,
  116,
  117,
  118,
  119,
  120,
  121,
]);

let nowProvider = null;
function currentFileTime() {
  return nowProvider
    ? BigInt(Math.trunc(nowProvider())) * 10000n + 116444736000000000n
    : wallClockFileTime();
}
let auctionRuntime = null;
let auctionClaims = null;
function getAuctionRuntime() {
  if (!auctionRuntime) {
    const { createContractAuctionRuntime } = require("./contractAuctionRuntime");
    auctionRuntime = createContractAuctionRuntime(getAuctionPorts());
  }
  return auctionRuntime;
}
function getAuctionClaims() {
  if (!auctionClaims) {
    const { createContractAuctionClaims } = require("./contractAuctionClaims");
    auctionClaims = createContractAuctionClaims(getAuctionPorts());
  }
  return auctionClaims;
}
function validateAuctionEscrow(record) {
  if (!Array.isArray(record.auctionEscrowContents)) {
    throwContractError("This auction has no original contents manifest; custody requires inspection.");
  }
  for (const row of (record.items || []).filter(item => item.inCrate)) {
    const item = findItemById(Number(row.escrowItemID || row.itemID));
    if (!item || Number(item.ownerID) !== CONTRACT_ESCROW_OWNER_ID ||
        Number(item.locationID) !== Number(record.escrowLocationID) || Number(item.flagID) !== 0 ||
        Number(item.typeID) !== Number(row.itemTypeID) || getItemQuantity(item) !== Number(row.quantity)) {
      throwContractError("The original auction goods are missing or changed in escrow.");
    }
  }
  const actual = (record.items || []).filter(item => item.inCrate).flatMap(row => collectContainedItems(Number(row.escrowItemID || row.itemID)));
  if (actual.length !== record.auctionEscrowContents.length) throwContractError("The auction contents differ from the original manifest.");
  for (const saved of record.auctionEscrowContents) {
    const item = findItemById(saved.itemID);
    if (!item || item.ownerID !== saved.ownerID || item.locationID !== saved.locationID ||
        item.flagID !== saved.flagID || item.typeID !== saved.typeID || getItemQuantity(item) !== saved.quantity) {
      throwContractError("An original auction container item is missing or changed.");
    }
  }
}
function buildAuctionItemLegs(record, operation, ownerID, flagID, reason) {
  validateAuctionEscrow(record);
  return buildTerminalEscrowItemLegs(record, operation, ownerID, record.startStationID, flagID, reason);
}

function getAuctionPorts() {
  return {
    CONTRACT_TYPE, CONTRACT_STATUS, settlementState: contractSettlementState,
    getContractRecord, listContractRecords, putContractRecordDurably,
    buildWalletRef, getWalletBalance, getSessionCharacterID, getSessionCorporationID,
    sessionHasCorpContractManagerRole, isIssuedBySessionWithCorpAuthority,
    isIssuedBySession, canAcceptContract, currentFileTime, adjustWalletAsync,
    applyContractWalletLegs, settleContractOperation, assertAuctionWalletAccess,
    scheduleAuctionExpiry: (record) => require("./contractAuctionJobs").scheduleContract(record),
    validateAuctionEscrow, buildAuctionItemLegs, CUSTODY_REASON,
    getOwnerDeliveryFlag, getAcceptorDeliveryFlag, transferContractTerminalItems,
    collectTerminalInventoryChanges, syncInventoryChangesToSession,
    notifyAuctionCompleted: contractNotifications.notifyContractCompleted,
    notifyAuctionBid(record, previousBid, buyout, session) {
      if (previousBid && previousBid.bidderID !== record.bids[0].bidderID) {
        contractNotifications.notifyContractOutbid(record, previousBid.bidderID, session);
      }
      if (buyout) contractNotifications.notifyContractBuyout(record, session);
    },
  };
}

function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function toInteger(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.trunc(numeric);
}

function toPositiveInteger(value, fallback = 0) {
  const numeric = toInteger(value, fallback);
  return numeric > 0 ? numeric : fallback;
}

function normalizeBoolean(value, fallback = false) {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) {
      return true;
    }
    if (["0", "false", "no", "off", ""].includes(normalized)) {
      return false;
    }
  }
  return Boolean(fallback);
}

function normalizeMoney(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.round(Math.max(0, numeric) * 100) / 100;
}

function normalizeText(value, fallback = "") {
  if (value === null || value === undefined) {
    return fallback;
  }
  return String(value);
}

function getSessionCharacterID(session) {
  return toPositiveInteger(
    session && (
      session.characterID ||
      session.charid ||
      session.characterId ||
      session.charID
    ),
    0,
  );
}

function getSessionCorporationID(session) {
  const { peekCharacterRecord } = require("../character/characterState");
  const { getCorporationRecord, isNpcCorporationID } = require("../corporation/corporationState");
  const requestedID = toPositiveInteger(session && (session.corporationID || session.corpid), 0);
  const character = peekCharacterRecord(getSessionCharacterID(session));
  if (requestedID && character && !character.isDeleted && !character.deletedAt &&
      Number(character.corporationID) === requestedID && isNpcCorporationID(requestedID)) {
    const corporation = getCorporationRecord(requestedID);
    return corporation && !corporation.deleted ? requestedID : 0;
  }
  const { getPersistedCorporationAuthority } = require("../corporation/corporationAuthority");
  const authority = getPersistedCorporationAuthority(session);
  return authority ? authority.corporationID : 0;
}

function getSessionAllianceID(session) {
  const { getAllianceMemberAuthority } = require("../corporation/corporationAuthority");
  const authority = getAllianceMemberAuthority(session);
  return authority ? authority.allianceID : 0;
}

function getSessionCorpAccountKey(session) {
  return normalizeCorporationWalletKey(
    session && (
      session.corpAccountKey ||
      session.corpaccountkey ||
      session.accountKey
    ) || CORPORATION_WALLET_KEY_START,
  );
}

function sessionHasCorpContractManagerRole(session) {
  // `corprole` is the target client's effective, authoritative session mask.
  // The other names are compatibility fallbacks for synthetic/legacy sessions;
  // do not OR them or a stale alias could re-grant a role that was removed.
  const { getPersistedCorporationAuthority, corporationAuthorityHasRole } = require("../corporation/corporationAuthority");
  return corporationAuthorityHasRole(getPersistedCorporationAuthority(session), CORP_ROLE_CONTRACT_MANAGER);
}

function canAccessCorporationContractItem(session, ownerID, locationID, flagID, takeRequired = false) {
  const { getPersistedCorporationAuthority } = require("../corporation/corporationAuthority");
  const { getCorporationRolesAtLocation } = require("../corporation/corporationRoleChecks");
  const {
    CORP_ROLE_ACCOUNTANT, CORP_ROLE_JUNIOR_ACCOUNTANT, CORP_ROLE_TRADER,
  } = require("../corporation/corporationRuntimeState");
  const {
    CORP_HANGAR_QUERY_ROLE_BY_FLAG, CORP_HANGAR_TAKE_ROLE_BY_FLAG,
  } = require("../industry/industryConstants");
  const authority = getPersistedCorporationAuthority(session);
  if (!authority || authority.corporationID !== Number(ownerID) || !sessionHasCorpContractManagerRole(session)) return false;
  if (authority.isCEO || authority.isDirector) return true;
  const roles = getCorporationRolesAtLocation(session, locationID);
  if (Number(flagID) === ITEM_FLAGS.CORP_DELIVERIES) {
    const deliveryRoles = takeRequired ? CORP_ROLE_ACCOUNTANT | CORP_ROLE_TRADER
      : CORP_ROLE_ACCOUNTANT | CORP_ROLE_JUNIOR_ACCOUNTANT | CORP_ROLE_TRADER;
    return (roles & deliveryRoles) !== 0n;
  }
  const role = (takeRequired ? CORP_HANGAR_TAKE_ROLE_BY_FLAG : CORP_HANGAR_QUERY_ROLE_BY_FLAG)[Number(flagID)];
  return Boolean(role && (roles & role) === role);
}

function throwContractError(message) {
  throwWrappedUserError("CustomInfo", {
    info: String(message || "The contract operation could not be completed."),
  });
}

function throwContractUserError(message, values = {}) {
  throwWrappedUserError(message, values);
}

function nowFileTimeString() {
  return currentFileTime().toString();
}

function toFileTimeBigInt(value) {
  try {
    if (typeof value === "bigint") {
      return value;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return BigInt(Math.trunc(value));
    }
    const text = String(value || "0").trim();
    return text ? BigInt(text) : 0n;
  } catch (error) {
    return 0n;
  }
}

function addFileTimeDays(fileTimeValue, days) {
  return (
    toFileTimeBigInt(fileTimeValue) +
    BigInt(Math.max(0, toInteger(days, 0))) * DAY_FILETIME_TICKS
  ).toString();
}

function addFileTimeMinutes(fileTimeValue, minutes) {
  return (
    toFileTimeBigInt(fileTimeValue) +
    BigInt(Math.max(0, toInteger(minutes, 0))) * 60n * 10_000_000n
  ).toString();
}

function getContractEscrowLocationID(contractID) {
  return CONTRACT_ESCROW_LOCATION_BASE + toPositiveInteger(contractID, 0);
}

function ensureRuntimeTable() {
  const result = repo.read(TABLE, "/");
  const table =
    result.success && result.data && typeof result.data === "object"
      ? result.data
      : {};

  if (!table._meta || typeof table._meta !== "object") {
    table._meta = { version: 1, nextContractID: CONTRACT_ID_START };
    repo.write(TABLE, "/_meta", table._meta);
  } else if (!toPositiveInteger(table._meta.nextContractID, 0)) {
    table._meta.nextContractID = CONTRACT_ID_START;
    repo.write(TABLE, "/_meta/nextContractID", table._meta.nextContractID);
  }

  return table;
}

function listContractRecords() {
  const table = ensureRuntimeTable();
  return Object.entries(table)
    .filter(([key, value]) => key !== "_meta" && value && typeof value === "object")
    .map(([, value]) => cloneValue(value));
}

function getContractRecord(contractID) {
  const normalizedContractID = toPositiveInteger(contractID, 0);
  if (!normalizedContractID) {
    return null;
  }
  const result = repo.read(TABLE, `/${String(normalizedContractID)}`);
  return result.success && result.data ? cloneValue(result.data) : null;
}

function putContractRecord(record) {
  const contractID = toPositiveInteger(record && record.contractID, 0);
  if (!contractID) {
    return {
      success: false,
      errorMsg: "CONTRACT_ID_REQUIRED",
    };
  }
  return repo.write(TABLE, `/${String(contractID)}`, cloneValue(record));
}

function allocateContractID() {
  const table = ensureRuntimeTable();
  const existingMax = listContractRecords()
    .reduce(
      (maxValue, record) => Math.max(maxValue, toPositiveInteger(record.contractID, 0)),
      CONTRACT_ID_START - 1,
    );
  const nextContractID = Math.max(
    toPositiveInteger(table._meta && table._meta.nextContractID, CONTRACT_ID_START),
    existingMax + 1,
  );
  repo.write(TABLE, "/_meta/nextContractID", nextContractID + 1);
  return nextContractID;
}

function resetForTests() {
  repo.write(TABLE, "/", {
    _meta: {
      version: 1,
      nextContractID: CONTRACT_ID_START,
    },
  }, { force: true });
  contractSettlementState.resetForTests();
}

function extractPlainObject(rawValue) {
  if (!rawValue) {
    return {};
  }

  const unwrapped = unwrapMarshalValue(rawValue);
  if (
    unwrapped &&
    typeof unwrapped === "object" &&
    !Array.isArray(unwrapped) &&
    Object.prototype.hasOwnProperty.call(unwrapped, "contractType")
  ) {
    return { ...unwrapped };
  }

  if (
    unwrapped &&
    typeof unwrapped === "object" &&
    Array.isArray(unwrapped.header)
  ) {
    for (const candidate of unwrapped.header) {
      if (
        candidate &&
        typeof candidate === "object" &&
        !Array.isArray(candidate) &&
        Object.prototype.hasOwnProperty.call(candidate, "contractType")
      ) {
        return { ...candidate };
      }
    }
  }

  if (
    rawValue &&
    typeof rawValue === "object" &&
    Array.isArray(rawValue.header) &&
    rawValue.header.length > 2
  ) {
    const state = unwrapMarshalValue(rawValue.header[2]);
    if (state && typeof state === "object" && !Array.isArray(state)) {
      return { ...state };
    }
  }

  return unwrapped && typeof unwrapped === "object" && !Array.isArray(unwrapped)
    ? { ...unwrapped }
    : {};
}

function normalizePairList(rawValue) {
  const unwrapped = unwrapMarshalValue(rawValue);
  const values = Array.isArray(unwrapped)
    ? unwrapped
    : unwrapped && typeof unwrapped === "object"
      ? Object.values(unwrapped)
      : [];

  const byFirst = new Map();
  for (const entry of values) {
    const pair = Array.isArray(entry)
      ? entry
      : entry && typeof entry === "object"
        ? Object.values(entry)
        : [];
    const first = toPositiveInteger(pair[0], 0);
    const second = toPositiveInteger(pair[1], 0);
    if (!first || !second) {
      continue;
    }
    byFirst.set(first, (byFirst.get(first) || 0) + second);
  }

  return [...byFirst.entries()]
    .map(([first, second]) => [first, second])
    .sort(([left], [right]) => left - right);
}

function normalizeContractInfo(rawInfo) {
  const source = extractPlainObject(rawInfo);
  const contractType = toPositiveInteger(source.contractType, 0);
  return {
    contractType,
    isPrivate: normalizeBoolean(source.isPrivate, false),
    assignedToID: toPositiveInteger(source.assignedToID, 0),
    minutesExpire: toPositiveInteger(source.minutesExpire, 24 * 60),
    numDays: contractType === CONTRACT_TYPE.COURIER
      ? toPositiveInteger(source.numDays, 1)
      : Math.max(0, toInteger(source.numDays, 0)),
    startStationID: toPositiveInteger(source.startStationID, 0),
    destinationID: toPositiveInteger(source.destinationID, 0),
    price: normalizeMoney(source.price, 0),
    reward: normalizeMoney(source.reward, 0),
    collateral: normalizeMoney(source.collateral, 0),
    title: normalizeText(source.title, "").slice(0, 200),
    description: normalizeText(source.description, "").slice(0, 4000),
    itemList: normalizePairList(source.itemList),
    startStationDivision: toPositiveInteger(source.startStationDivision, ITEM_FLAGS.HANGAR),
    requestItemTypeList: normalizePairList(source.requestItemTypeList),
    forCorp: normalizeBoolean(source.forCorp, false),
    multiContract: normalizeBoolean(source.multiContract, false),
  };
}

function sameContractDivisionFlag(itemFlagID, selectedFlagID) {
  const normalizedItemFlagID = toPositiveInteger(itemFlagID, 0);
  const normalizedSelectedFlagID = toPositiveInteger(selectedFlagID, 0);
  if (normalizedItemFlagID === normalizedSelectedFlagID) {
    return true;
  }
  return new Set([
    normalizedItemFlagID,
    normalizedSelectedFlagID,
  ]).size === 2 &&
    normalizedItemFlagID > 0 &&
    normalizedSelectedFlagID > 0 &&
    [
      normalizedItemFlagID,
      normalizedSelectedFlagID,
    ].every((flagID) => flagID === ITEM_FLAGS.HANGAR || flagID === 115);
}

function isAllowedContractSourceFlag(flagID, forCorp, selectedFlagID = 0) {
  const normalizedFlagID = toPositiveInteger(flagID, 0);
  if (forCorp) {
    if (!CORP_CONTRACT_ITEM_FLAGS.has(normalizedFlagID)) {
      return false;
    }
    const normalizedSelectedFlagID = toPositiveInteger(selectedFlagID, 0);
    return normalizedSelectedFlagID <= 0 ||
      sameContractDivisionFlag(normalizedFlagID, normalizedSelectedFlagID);
  }
  return normalizedFlagID === ITEM_FLAGS.HANGAR;
}

function getOwnedContractSourceID(session, forCorp) {
  const ownerID = forCorp
    ? getSessionCorporationID(session)
    : getSessionCharacterID(session);
  if (!ownerID) {
    throwContractError("The contract owner could not be resolved.");
  }
  return ownerID;
}

function getItemQuantity(item) {
  if (!item) {
    return 0;
  }
  if (toInteger(item.singleton, 0) === 1) {
    return 1;
  }
  return toPositiveInteger(item.stacksize ?? item.quantity, 0);
}

function resolveDockableLocation(locationID) {
  const normalizedLocationID = toPositiveInteger(locationID, 0);
  const station = normalizedLocationID ? worldData.getStationByID(normalizedLocationID) : null;
  if (station) {
    const system = worldData.getSolarSystemByID(station.solarSystemID);
    return {
      stationID: normalizedLocationID,
      solarSystemID: toPositiveInteger(station.solarSystemID, 0),
      regionID: toPositiveInteger(
        station.regionID || (system && system.regionID),
        0,
      ),
    };
  }

  const structure = normalizedLocationID ? worldData.getStructureByID(normalizedLocationID) : null;
  if (structure && !structure.destroyedAt) {
    const system = worldData.getSolarSystemByID(structure.solarSystemID);
    return {
      stationID: normalizedLocationID,
      solarSystemID: toPositiveInteger(structure.solarSystemID, 0),
      regionID: toPositiveInteger(
        structure.regionID || (system && system.regionID),
        0,
      ),
    };
  }

  return null;
}

function requireDockableLocation(locationID, label) {
  const location = resolveDockableLocation(locationID);
  if (!location) {
    throwContractError(
      `${label || "Contract location"} is not a station or structure.`,
    );
  }
  return location;
}

function resolveAvailability(info, session) {
  if (!info.isPrivate || !info.assignedToID) {
    return CONTRACT_AVAILABILITY.PUBLIC;
  }
  if (info.assignedToID === getSessionCorporationID(session)) {
    return CONTRACT_AVAILABILITY.MY_CORP;
  }
  if (info.assignedToID === getSessionAllianceID(session)) {
    return CONTRACT_AVAILABILITY.MY_ALLIANCE;
  }
  return CONTRACT_AVAILABILITY.MYSELF;
}

function buildWalletRef(session, forCorp) {
  if (forCorp) {
    const corporationID = getSessionCorporationID(session);
    if (!corporationID) {
      throwContractError("The corporation wallet could not be resolved.");
    }
    return {
      kind: "corporation",
      ownerID: corporationID,
      accountKey: getSessionCorpAccountKey(session),
    };
  }

  const characterID = getSessionCharacterID(session);
  if (!characterID) {
    throwContractError("The character wallet could not be resolved.");
  }
  return {
    kind: "character",
    ownerID: characterID,
    accountKey: 1000,
  };
}

function cloneWalletRef(ref) {
  return {
    kind: ref && ref.kind === "corporation" ? "corporation" : "character",
    ownerID: toPositiveInteger(ref && ref.ownerID, 0),
    accountKey: toPositiveInteger(ref && ref.accountKey, 1000),
  };
}

function getWalletBalance(ref) {
  const walletRef = cloneWalletRef(ref);
  if (walletRef.kind === "corporation") {
    return normalizeMoney(
      getCorporationWalletBalance(walletRef.ownerID, walletRef.accountKey),
      0,
    );
  }
  const wallet = getCharacterWallet(walletRef.ownerID);
  return wallet ? normalizeMoney(wallet.balance, 0) : null;
}

function ensureWalletFunds(ref, amount, description) {
  const normalizedAmount = normalizeMoney(amount, 0);
  if (!(normalizedAmount > 0)) {
    return;
  }
  const balance = getWalletBalance(ref);
  if (balance === null || balance + 0.0001 < normalizedAmount) {
    throwContractError(
      `${description} requires ${normalizedAmount.toFixed(2)} ISK, but the wallet does not have enough funds.`,
    );
  }
}

async function adjustWalletAsync(
  ref,
  delta,
  description,
  contractID,
  counterpartyID,
  commandID,
  journal,
) {
  const normalizedDelta = Math.round((Number(delta) || 0) * 100) / 100;
  if (Math.abs(normalizedDelta) < 0.0001) {
    return { success: true, skipped: true, data: null };
  }
  const walletRef = cloneWalletRef(ref);
  const normalizedCommandID = String(commandID || "").trim();
  const options = {
    idempotencyKey: normalizedCommandID,
    requireExactCredit: true,
    ownerID1: journal?.ownerID1 ?? walletRef.ownerID,
    ownerID2: toPositiveInteger(counterpartyID, 0),
    referenceID: toPositiveInteger(contractID, 0),
    entryTypeID: journal?.entryTypeID ?? JOURNAL_ENTRY_TYPE.PLAYER_TRADING,
    description,
  };
  const metadata = {
    commandID: normalizedCommandID,
    source: "contract-settlement",
  };
  return walletRef.kind === "corporation"
    ? adjustCorporationWalletDivisionBalanceAsync(
        walletRef.ownerID,
        walletRef.accountKey,
        normalizedDelta,
        options,
        metadata,
      )
    : adjustCharacterBalanceAsync(
        walletRef.ownerID,
        normalizedDelta,
        options,
        metadata,
      );
}

function getOwnerDeliveryFlag(forCorp, divisionFlagID = 0) {
  if (!forCorp) {
    return ITEM_FLAGS.HANGAR;
  }
  const normalizedFlagID = toPositiveInteger(divisionFlagID, 0);
  return CORP_CONTRACT_ITEM_FLAGS.has(normalizedFlagID)
    ? normalizedFlagID
    : ITEM_FLAGS.CORP_DELIVERIES;
}

function getAcceptorDeliveryFlag(forCorp) {
  return forCorp ? ITEM_FLAGS.CORP_DELIVERIES : ITEM_FLAGS.HANGAR;
}

function getItemContractQuantity(item, requestedQuantity) {
  const available = getItemQuantity(item);
  if (toInteger(item && item.singleton, 0) === 1) {
    return 1;
  }
  return Math.min(available, toPositiveInteger(requestedQuantity, available));
}

function validateSelectedItem(itemID, quantity, ownerID, locationID, forCorp, selectedFlagID) {
  const item = findItemById(itemID);
  if (!item) {
    throwContractError(`Item ${itemID} could not be found.`);
  }
  if (toPositiveInteger(item.ownerID, 0) !== ownerID) {
    throwContractError(`Item ${itemID} is not owned by the contract issuer.`);
  }
  if (toPositiveInteger(item.locationID, 0) !== locationID) {
    throwContractError(`Item ${itemID} is not at the contract start location.`);
  }
  if (!isAllowedContractSourceFlag(item.flagID, forCorp, selectedFlagID)) {
    throwContractError(`Item ${itemID} cannot be added to a contract from its current hangar.`);
  }
  if (getItemQuantity(item) < quantity) {
    throwContractError(`Item ${itemID} does not have the requested quantity.`);
  }
  return item;
}

function validateCreationItems(info, ownerID, session) {
  let courierVolume = 0;
  for (const [itemID, quantity] of info.itemList) {
    const item = validateSelectedItem(
      itemID,
      quantity,
      ownerID,
      info.startStationID,
      info.forCorp,
      info.startStationDivision,
    );
    if (info.forCorp && !canAccessCorporationContractItem(session, ownerID, info.startStationID, item.flagID, true)) {
      throwContractError("Contract creation requires take access to the item's corporation hangar division.");
    }
    if (info.contractType === CONTRACT_TYPE.COURIER) {
      courierVolume += getInventoryItemUnitVolume(item) * getItemContractQuantity(item, quantity);
    }
  }
  if (info.contractType === CONTRACT_TYPE.COURIER &&
      (!Number.isFinite(courierVolume) || courierVolume > COURIER_MAX_VOLUME)) {
    throwContractUserError("ConExceedsMaxVolume", { max: COURIER_MAX_VOLUME, vol: courierVolume });
  }
}

function buildContractItemRowFromInventory(item, quantity, inCrate, extra = {}) {
  const normalizedTypeID = toPositiveInteger(item && item.typeID, 0);
  return {
    recordID: toPositiveInteger(extra.recordID, 0),
    itemID: toPositiveInteger(extra.itemID ?? (item && item.itemID), 0),
    sourceItemID: toPositiveInteger(extra.sourceItemID ?? (item && item.itemID), 0),
    escrowItemID: toPositiveInteger(extra.escrowItemID ?? (item && item.itemID), 0),
    itemTypeID: normalizedTypeID,
    typeID: normalizedTypeID,
    quantity: toPositiveInteger(quantity, 1),
    inCrate: normalizeBoolean(inCrate, true),
    parentID: toPositiveInteger(extra.parentID, 0),
    flagID: toPositiveInteger(extra.flagID ?? (item && item.flagID), 0),
    copy: toInteger(extra.copy, 0),
    licensedProductionRunsRemaining: toInteger(extra.licensedProductionRunsRemaining, 0),
    materialLevel: toInteger(extra.materialLevel, 0),
    productivityLevel: toInteger(extra.productivityLevel, 0),
    damage: normalizeNumber(extra.damage, 0),
  };
}

function buildRequestedItemRow(typeID, quantity, recordID) {
  return {
    recordID,
    itemID: 0,
    sourceItemID: 0,
    escrowItemID: 0,
    itemTypeID: toPositiveInteger(typeID, 0),
    typeID: toPositiveInteger(typeID, 0),
    quantity: toPositiveInteger(quantity, 1),
    inCrate: false,
    parentID: 0,
    flagID: ITEM_FLAGS.HANGAR,
    copy: 0,
    licensedProductionRunsRemaining: 0,
    materialLevel: 0,
    productivityLevel: 0,
    damage: 0,
  };
}

function findMovedItem(changes, locationID, sourceItemID, typeID) {
  const normalizedLocationID = toPositiveInteger(locationID, 0);
  const normalizedSourceItemID = toPositiveInteger(sourceItemID, 0);
  const normalizedTypeID = toPositiveInteger(typeID, 0);
  const candidates = (Array.isArray(changes) ? changes : [])
    .map((change) => change && change.item)
    .filter((item) => (
      item &&
      toPositiveInteger(item.locationID, 0) === normalizedLocationID &&
      toPositiveInteger(item.typeID, 0) === normalizedTypeID
    ));
  return candidates.find((item) => toPositiveInteger(item.itemID, 0) !== normalizedSourceItemID) ||
    candidates.find((item) => toPositiveInteger(item.itemID, 0) === normalizedSourceItemID) ||
    null;
}

function moveSelectedItemsToEscrow(info, contractID, ownerID) {
  const escrowLocationID = getContractEscrowLocationID(contractID);
  const rows = [];
  const changes = [];
  let recordID = 1;

  for (const [itemID, requestedQuantity] of info.itemList) {
    const currentItem = validateSelectedItem(
      itemID,
      requestedQuantity,
      ownerID,
      info.startStationID,
      info.forCorp,
      info.startStationDivision,
    );
    const moveQuantity = getItemContractQuantity(currentItem, requestedQuantity);
    const moveResult = contractItemCustody.transferItem({
      contractID,
      item: currentItem,
      ownerID: CONTRACT_ESCROW_OWNER_ID,
      locationID: escrowLocationID,
      flagID: 0,
      quantity: moveQuantity,
      reason: CUSTODY_REASON.CONTRACT_ESCROW_STAGE,
      actor: ownerID,
    });
    if (!moveResult.success) {
      throwContractError(`Failed to escrow item ${currentItem.itemID}: ${moveResult.errorMsg || "item move failed"}.`);
    }

    const moveChanges = (moveResult.data && moveResult.data.changes) || [];
    const escrowItem = findMovedItem(
      moveChanges,
      escrowLocationID,
      currentItem.itemID,
      currentItem.typeID,
    );
    if (!escrowItem) {
      throwContractError(`Failed to identify escrowed item ${currentItem.itemID}.`);
    }

    rows.push(buildContractItemRowFromInventory(
      escrowItem,
      moveQuantity,
      true,
      {
        recordID,
        sourceItemID: currentItem.itemID,
        escrowItemID: escrowItem.itemID,
        flagID: escrowItem.flagID,
      },
    ));
    recordID += 1;
    changes.push(...moveChanges);
  }

  return {
    escrowLocationID,
    rows,
    changes,
    nextRecordID: recordID,
  };
}

function appendRequestedItemRows(info, rows, nextRecordID) {
  let recordID = nextRecordID;
  for (const [typeID, quantity] of info.requestItemTypeList) {
    rows.push(buildRequestedItemRow(typeID, quantity, recordID));
    recordID += 1;
  }
  return recordID;
}

function collectContainedItems(rootItemID) {
  const normalizedRootItemID = toPositiveInteger(rootItemID, 0);
  if (!normalizedRootItemID) {
    return [];
  }

  const collected = [];
  const queue = [normalizedRootItemID];
  const seen = new Set([normalizedRootItemID]);
  while (queue.length > 0) {
    const currentLocationID = queue.shift();
    const children = listContainerItems(null, currentLocationID, null)
      .sort((left, right) => toPositiveInteger(left.itemID, 0) - toPositiveInteger(right.itemID, 0));
    for (const child of children) {
      const childItemID = toPositiveInteger(child && child.itemID, 0);
      if (!childItemID || seen.has(childItemID)) {
        continue;
      }
      seen.add(childItemID);
      collected.push(child);
      queue.push(childItemID);
    }
  }
  return collected;
}

function transferContainedItemsToOwner(contractID, rootItemID, destinationOwnerID) {
  const changes = [];
  for (const child of collectContainedItems(rootItemID)) {
    const transferResult = contractItemCustody.transferItem({
      contractID,
      item: child,
      ownerID: destinationOwnerID,
      locationID: child.locationID,
      flagID: child.flagID,
      reason: CUSTODY_REASON.CONTRACT_CONTENT_OWNER_TRANSFER,
      actor: destinationOwnerID,
    });
    if (!transferResult.success) {
      throwContractError(`Failed to transfer contained item ${child.itemID}.`);
    }
    changes.push(...((transferResult.data && transferResult.data.changes) || []));
  }
  return changes;
}

function buildStructureHangarLocationContext(locationID) {
  const normalizedLocationID = toPositiveInteger(locationID, 0);
  return normalizedLocationID > 0
    ? ["Structure", normalizedLocationID, "StructureItemHangar"]
    : null;
}

function syncInventoryChangesToSession(session, changes = [], options = {}) {
  const normalizedChanges = (Array.isArray(changes) ? changes : [])
    .filter((change) => change && change.item);
  // Before the session guard: a contract settles against locations, not
  // logins. An item staged out of a corporation division by an issuer who has
  // since logged off still emptied a hangar somebody else is looking at.
  if (normalizedChanges.length > 0) {
    fanCorporationOfficeInventoryChanges(normalizedChanges, {
      actorSession: session || null,
      emitItemsChangedBatch: true,
    });
  }
  if (!session || typeof session.sendNotification !== "function") {
    return;
  }
  const { emitItemsChangedBatchForSession } = require(path.join(
    __dirname,
    "../character/characterState",
  ));
  if (normalizedChanges.length <= 0) {
    return;
  }
  try {
    emitItemsChangedBatchForSession(session, normalizedChanges, {
      locationContext: options.locationContext || null,
    });
  } catch (error) {
    // Economic state is already durable before the callers reach this best-
    // effort client refresh. A broken connection must not turn a committed
    // contract RPC into a failure or suppress the counterparty lifecycle event.
    log.warn(
      `[ContractRuntime] inventory notification delivery failed: ${error.message}`,
    );
  }
}

function buildBaseContractRecord(info, session, contractID, ownerID, issuerWalletRef) {
  const issuedAt = nowFileTimeString();
  const start = requireDockableLocation(info.startStationID, "Contract start location");
  const end = requireDockableLocation(
    info.destinationID || info.startStationID,
    "Contract destination",
  );
  const issuerID = getSessionCharacterID(session);
  const issuerCorpID = getSessionCorporationID(session);

  return {
    contractID,
    type: info.contractType,
    status: CONTRACT_STATUS.OUTSTANDING,
    availability: resolveAvailability(info, session),
    issuerID,
    issuerCorpID,
    issuerOwnerID: ownerID,
    issuerWallet: cloneWalletRef(issuerWalletRef),
    forCorp: info.forCorp,
    assigneeID: info.isPrivate ? info.assignedToID : 0,
    acceptorID: 0,
    acceptorWallet: null,
    acceptorWalletKey: null,
    dateIssued: issuedAt,
    dateExpired: addFileTimeMinutes(issuedAt, info.minutesExpire),
    dateAccepted: "0",
    dateCompleted: "0",
    numDays: info.numDays,
    startStationID: start.stationID,
    endStationID: info.contractType === CONTRACT_TYPE.COURIER ? end.stationID : 0,
    startSolarSystemID: start.solarSystemID,
    endSolarSystemID: info.contractType === CONTRACT_TYPE.COURIER ? end.solarSystemID : 0,
    startRegionID: start.regionID,
    endRegionID: info.contractType === CONTRACT_TYPE.COURIER ? end.regionID : 0,
    price: info.price,
    reward: info.reward,
    collateral: info.collateral,
    volume: 0,
    title: info.title,
    description: info.description,
    startStationDivision: info.startStationDivision,
    escrowLocationID: getContractEscrowLocationID(contractID),
    packageLocationID: 0,
    plasticWrapItemID: 0,
    rewardEscrow: 0,
    collateralEscrow: 0,
    collateralCredited: false,
    rewardPaid: false,
    items: [],
    packageItems: [],
    ...(info.contractType === CONTRACT_TYPE.AUCTION ? {
      bids: [], nextBidID: 1, auctionVersion: 0,
      auctionIssuerClaimed: false, auctionWinnerClaimed: false,
    } : {}),
    createdAtMs: Date.now(),
    updatedAtMs: Date.now(),
  };
}

function ensureSupportedCreateInfo(info) {
  if (
    info.contractType !== CONTRACT_TYPE.ITEM_EXCHANGE &&
    info.contractType !== CONTRACT_TYPE.AUCTION &&
    info.contractType !== CONTRACT_TYPE.COURIER
  ) {
    return false;
  }
  if (!info.startStationID) {
    throwContractError("Choose a start location before creating the contract.");
  }
  if (info.contractType === CONTRACT_TYPE.COURIER && !info.destinationID) {
    throwContractError("Choose a destination before creating the courier contract.");
  }
  if (info.contractType === CONTRACT_TYPE.COURIER && info.itemList.length === 0) {
    throwContractError("Choose at least one item for the courier contract.");
  }
  if (info.contractType === CONTRACT_TYPE.AUCTION) {
    if (!info.itemList.length) throwContractUserError("ConNoItemsSelected");
    if (info.itemList.length > 500) throwContractUserError("ConTooManyItems", { max: 500 });
    if (info.reward || info.requestItemTypeList.length || info.numDays || info.multiContract) {
      throwContractUserError("ConInvalidContract");
    }
    if (![1440, 4320, 10080, 20160].includes(info.minutesExpire)) {
      throwContractUserError("ConDurationTooLong", { max: 14 });
    }
    if (info.collateral > 0 && info.collateral < info.price) {
      throwContractUserError("ConAuctionBuyoutTooSmall");
    }
    if ((!info.isPrivate || !info.assignedToID) && info.price < 1000000) {
      throwContractUserError("ConBidTooLow", { minimum: 1000000 });
    }
    if (info.price > 10000000000000 || info.collateral > 10000000000000) {
      throwContractUserError("ConTooMuchMoney", { max: 10000000000000 });
    }
  }
  return true;
}

// Fee amounts follow the native creation preview. Debit/refund timing is the
// EveJS settlement policy: broker and deposit at create, deposit only returned
// from a funded sale. No-bid expiry/cancellation forfeits the deposit.
function getAuctionCreationTerms(info, session) {
  const { getCharacterSkillMap } = require("../skills/skillState");
  const skills = getCharacterSkillMap(getSessionCharacterID(session), { skipBootstrap: true });
  const level = typeID => Math.max(0, Math.min(5, Number(skills.get(typeID)?.effectiveSkillLevel ?? skills.get(typeID)?.trainedSkillLevel ?? skills.get(typeID)?.skillLevel) || 0));
  const accountingLevel = level(16622);
  const brokerLevel = level(3446);
  const limit = info.forCorp ? [5,26,27,28,29,30][level(25233)]
    : [7,16,17,18,19,20][level(25235)] + [21,22,23,24,25,26][level(73912)];
  const corporationID = getSessionCorporationID(session);
  const { getCorporationRecord, isNpcCorporationID } = require("../corporation/corporationState");
  const { peekCharacterRecord } = require("../character/characterState");
  const ownCorp = getCorporationRecord(corporationID);
  const internal = assigneeID => Number(assigneeID) > 0 && (
    Number(assigneeID) === corporationID ||
    (!isNpcCorporationID(corporationID) && ownCorp?.isNPC === false &&
      Number(peekCharacterRecord(Number(assigneeID))?.corporationID) === corporationID)
  );
  const outstanding = listContractRecords().filter(record =>
    record.issuerID === getSessionCharacterID(session) &&
    Boolean(record.forCorp) === info.forCorp &&
    [CONTRACT_STATUS.OUTSTANDING, CONTRACT_STATUS.IN_PROGRESS].includes(record.status));
  const pending = contractSettlementState.listPendingContractSettlements().filter(entry => entry.kind === "create" &&
    entry.payload?.baseRecord?.issuerID === getSessionCharacterID(session) &&
    Boolean(entry.payload?.baseRecord?.forCorp) === info.forCorp).map(entry => entry.payload.baseRecord);
  const all = [...outstanding, ...pending];
  const innerRequest = info.isPrivate && internal(info.assignedToID);
  const count = innerRequest ? all.length : all.filter(record => !internal(record.assigneeID)).length;
  const effectiveLimit = innerRequest ? 500 : limit;
  if (all.length >= 500 || count >= effectiveLimit) {
    throwContractUserError("ConTooManyContractsMax", { max: all.length >= 500 ? 500 : effectiveLimit });
  }
  const privateContract = info.isPrivate && info.assignedToID > 0;
  const extraDays = Math.max(0, info.minutesExpire / 1440 - 1);
  return {
    auctionAccountingLevel: accountingLevel,
    auctionBrokerFee: privateContract ? 10000 : normalizeMoney(Math.trunc(Math.min(Math.max(info.price * (0.004 - brokerLevel * 0.0002), 10000), 100000000 * (1 - brokerLevel * 0.05))) * (1 + extraDays * 0.05)),
    auctionDeposit: privateContract ? 0 : Math.trunc(Math.min(Math.max(info.price * 0.01, 100000), 100000000)),
  };
}

function assertAuctionWalletAccess(session, walletRef) {
  if (walletRef.kind !== "corporation") return;
  const { getPersistedCorporationAuthority, corporationAuthorityHasRole } = require("../corporation/corporationAuthority");
  const { getCorporationWalletDivisionTakeRole } = require("../corporation/corporationRuntimeState");
  const takeRole = getCorporationWalletDivisionTakeRole(walletRef.accountKey);
  const authority = getPersistedCorporationAuthority(session);
  if (!takeRole || Number(authority && authority.corporationID) !== Number(walletRef.ownerID) ||
      !corporationAuthorityHasRole(authority, takeRole)) {
    throwContractError("Taking contract funds requires access to this corporation wallet division.");
  }
}

function calculateItemRowsVolume(rows) {
  return rows.reduce((total, row) => {
    const metadata = getItemMetadata(row.itemTypeID);
    return total + (Number(metadata && metadata.volume) || 0) * toPositiveInteger(row.quantity, 1);
  }, 0);
}

function calculateEscrowItemLegsVolume(legs) {
  // Contract rows omit packaging state; the staged item retains it, including
  // after settlement recovery. Count only the quantity selected for each leg.
  return legs.reduce((total, leg) => (
    total + getInventoryItemUnitVolume(leg.escrowItem) * toPositiveInteger(leg.quantity, 1)
  ), 0);
}

function calculateCourierVolume(legs) {
  // The client stores wrap volume in hundredths and rejects a zero-volume wrap.
  return Math.max(0.01, Math.round(calculateEscrowItemLegsVolume(legs) * 100) / 100);
}

function reconcilePublishedCourierVolumes(options = {}) {
  const reconciliation = require("./contractCourierVolumeReconciliation");
  return reconciliation.reconcilePublishedCourierVolumes({
    listContractRecords,
    getPendingContractSettlement: contractSettlementState.getPendingContractSettlement,
    listContainerItems,
    findItemById,
    getInventoryItemUnitVolume,
    getItemMetadata,
    setPlasticWrapVolumeDurably,
    putContractRecordDurably,
    getContractEscrowLocationID,
  }, options);
}

function reconcilePublishedCourierVolume(contractID) {
  return reconcilePublishedCourierVolumes({ contractID });
}

function createPlasticWrap(contractID, ownerID) {
  const grantResult = contractItemCustody.createPlasticWrap({
    contractID,
    ownerID,
    flagID: ITEM_FLAGS.HANGAR,
    typeID: PLASTIC_WRAP_TYPE_ID,
    actor: ownerID,
  });
  if (!grantResult.success) {
    throwContractError(`Failed to create courier package: ${grantResult.errorMsg || "item create failed"}.`);
  }
  const wrapItem = grantResult.data && Array.isArray(grantResult.data.items)
    ? grantResult.data.items[0]
    : null;
  if (!wrapItem) {
    throwContractError("Failed to identify the courier package item.");
  }
  return {
    wrapItem,
    changes: (grantResult.data && grantResult.data.changes) || [],
  };
}

function putContractRecordDurably(record) {
  const contractID = toPositiveInteger(record && record.contractID, 0);
  const previous = getContractRecord(contractID);
  const result = putContractRecord(record);
  if (!result || result.success !== true) {
    return result || { success: false, errorMsg: "CONTRACT_WRITE_FAILED" };
  }
  const restoreCache = () => previous
    ? putContractRecord(previous)
    : repo.remove(TABLE, `/${String(contractID)}`);
  try {
    const flushResult = repo.flushTableSync(TABLE);
    if (flushResult && flushResult.success) return result;
    restoreCache();
    return flushResult || { success: false, errorMsg: "CONTRACT_FLUSH_FAILED" };
  } catch (error) {
    restoreCache();
    throw error;
  }
}

function getCustodyResultItem(result, destinationLocationID, sourceItem, typeID) {
  const changes = result && result.data && Array.isArray(result.data.changes)
    ? result.data.changes
    : [];
  return findMovedItem(
    changes,
    destinationLocationID,
    sourceItem && sourceItem.itemID,
    typeID || (sourceItem && sourceItem.typeID),
  ) || (result && result.data && result.data.item) || null;
}

function durableContractCustodyFailure(result, fallbackError) {
  if (!result || result.success !== true) {
    return result || { success: false, errorMsg: fallbackError };
  }
  if (result.durable !== true) {
    return {
      success: false,
      ambiguous: true,
      errorMsg: "CONTRACT_CUSTODY_NOT_DURABLE",
    };
  }
  return null;
}

function buildContractCreationFingerprint(info, session, ownerID, issuerWalletRef) {
  return JSON.stringify({
    info,
    issuerID: getSessionCharacterID(session),
    issuerCorpID: getSessionCorporationID(session),
    ownerID,
    issuerWalletRef: cloneWalletRef(issuerWalletRef),
  });
}

function prepareContractCreationSettlement(
  info, session, ownerID, issuerWalletRef, privateBrokerFee,
) {
  const requestFingerprint = buildContractCreationFingerprint(
    info,
    session,
    ownerID,
    issuerWalletRef,
  );
  const existing = contractSettlementState.findPendingContractSettlement(
    "create",
    requestFingerprint,
  );
  if (existing) {
    return { success: true, duplicate: true, data: existing };
  }

  const contractID = allocateContractID();
  const metaFlush = repo.flushTableSync(TABLE);
  if (!metaFlush || metaFlush.success !== true) {
    return metaFlush || { success: false, errorMsg: "CONTRACT_ID_FLUSH_FAILED" };
  }
  const baseRecord = buildBaseContractRecord(
    info,
    session,
    contractID,
    ownerID,
    issuerWalletRef,
  );
  if (info.contractType === CONTRACT_TYPE.AUCTION) {
    Object.assign(baseRecord, getAuctionCreationTerms(info, session));
    baseRecord.auctionEscrowContents = info.itemList.flatMap(([itemID]) => collectContainedItems(itemID)).map(item => ({
      itemID: item.itemID, ownerID: item.ownerID, locationID: item.locationID,
      flagID: item.flagID, typeID: item.typeID, quantity: getItemQuantity(item),
    }));
    if (baseRecord.auctionEscrowContents.some(item => Number(item.ownerID) !== ownerID)) {
      throwContractError("Every item inside an auction container must belong to the issuer.");
    }
  }
  const itemLegs = info.itemList.map(([itemID, requestedQuantity], index) => {
    const item = validateSelectedItem(
      itemID,
      requestedQuantity,
      ownerID,
      info.startStationID,
      info.forCorp,
      info.startStationDivision,
    );
    const quantity = getItemContractQuantity(item, requestedQuantity);
    return {
      legID: index + 1,
      sourceItem: cloneValue(item),
      quantity,
      stageKey: `contract:${contractID}:create:item:${index + 1}:stage`,
      returnKey: `contract:${contractID}:create:item:${index + 1}:return`,
      staged: false,
      returned: false,
      escrowItem: null,
      changes: [],
    };
  });
  const walletLegs = [];
  if (info.contractType === CONTRACT_TYPE.AUCTION) {
    walletLegs.push(
      buildContractWalletLeg({ legID: "create:auction-broker", ref: issuerWalletRef, delta: -baseRecord.auctionBrokerFee, description: `Contract ${contractID} auction broker fee`, contractID }),
      buildContractWalletLeg({ legID: "create:auction-deposit", ref: issuerWalletRef, delta: -baseRecord.auctionDeposit, description: `Contract ${contractID} auction deposit`, contractID }),
    );
  } else if (privateBrokerFee > 0) {
    walletLegs.push({
      ...buildContractWalletLeg({
        legID: "create:broker-fee",
        ref: issuerWalletRef,
        delta: -privateBrokerFee,
        description: `Contract ${contractID} broker fee`,
        contractID,
      }),
      journal: {
        entryTypeID: info.forCorp
          ? JOURNAL_ENTRY_TYPE.CONTRACT_BROKERS_FEE_CORP
          : JOURNAL_ENTRY_TYPE.CONTRACT_BROKERS_FEE,
        ownerID1: getSessionCharacterID(session),
      },
    });
  }
  const payload = {
    info: cloneValue(info),
    walletLegs,
    ownerID,
    issuerWalletRef: cloneWalletRef(issuerWalletRef),
    baseRecord,
    itemLegs,
    wrapLeg: info.contractType === CONTRACT_TYPE.COURIER
      ? {
          createKey: `contract:${contractID}:create:wrap:create`,
          removeKey: `contract:${contractID}:create:wrap:remove`,
          created: false,
          removed: false,
          wrapItem: null,
          changes: [],
          // Older pending settlements must replay their original mint fingerprint.
          plasticWrapEncoding: 1,
        }
      : null,
    rewardDebitCommandID: `contract:${contractID}:create:reward-debit`,
    rewardRefundCommandID: `contract:${contractID}:create:reward-refund`,
    rewardApplied: info.reward <= 0,
    rewardRefunded: false,
    rewardResult: null,
    rejectionError: null,
  };
  return contractSettlementState.prepareContractSettlement({
    contractID,
    kind: "create",
    requestFingerprint,
    payload,
  });
}

async function compensateRejectedContractCreation(contractID) {
  const walletReversal = await reverseContractWalletLegs(contractID);
  if (!walletReversal.success) return walletReversal;
  let settlement = contractSettlementState.getPendingContractSettlement(contractID);
  if (!settlement) {
    return { success: true, alreadySettled: true };
  }
  let payload = settlement.payload;

  if (
    payload.rewardApplied &&
    !payload.rewardRefunded &&
    normalizeMoney(payload.info && payload.info.reward, 0) > 0
  ) {
    const refund = await adjustWalletAsync(
      payload.issuerWalletRef,
      payload.info.reward,
      `Contract ${contractID} rejected creation reward refund`,
      contractID,
      0,
      payload.rewardRefundCommandID,
    );
    if (!refund || refund.success !== true) {
      return refund || { success: false, errorMsg: "CONTRACT_REWARD_REFUND_FAILED" };
    }
    const checkpoint = contractSettlementState.updateContractSettlement(
      contractID,
      (current) => ({
        ...current,
        payload: { ...current.payload, rewardRefunded: true },
      }),
    );
    if (!checkpoint.success) {
      return checkpoint;
    }
  }

  settlement = contractSettlementState.getPendingContractSettlement(contractID);
  payload = settlement.payload;
  if (payload.wrapLeg && payload.wrapLeg.created && !payload.wrapLeg.removed) {
    const removeResult = contractItemCustody.removePlasticWrap({
      contractID,
      item: payload.wrapLeg.wrapItem,
      expectedLocationID: getContractEscrowLocationID(contractID),
      actor: payload.ownerID,
      idempotencyKey: payload.wrapLeg.removeKey,
    });
    const failure = durableContractCustodyFailure(
      removeResult,
      "CONTRACT_WRAP_RETURN_FAILED",
    );
    if (failure) {
      return failure;
    }
    const checkpoint = contractSettlementState.updateContractSettlement(
      contractID,
      (current) => ({
        ...current,
        payload: {
          ...current.payload,
          wrapLeg: { ...current.payload.wrapLeg, removed: true },
        },
      }),
    );
    if (!checkpoint.success) {
      return checkpoint;
    }
  }

  settlement = contractSettlementState.getPendingContractSettlement(contractID);
  for (const candidate of [...settlement.payload.itemLegs].reverse()) {
    settlement = contractSettlementState.getPendingContractSettlement(contractID);
    const leg = settlement.payload.itemLegs.find(
      (entry) => entry.legID === candidate.legID,
    );
    if (!leg || !leg.staged || leg.returned) {
      continue;
    }
    const result = contractItemCustody.transferItem({
      contractID,
      item: leg.escrowItem,
      ownerID: leg.sourceItem.ownerID,
      locationID: leg.sourceItem.locationID,
      flagID: leg.sourceItem.flagID,
      quantity: null,
      reason: CUSTODY_REASON.CONTRACT_ESCROW_RETURN,
      actor: payload.ownerID,
      idempotencyKey: leg.returnKey,
    });
    const failure = durableContractCustodyFailure(
      result,
      "CONTRACT_ITEM_RETURN_FAILED",
    );
    if (failure) {
      return failure;
    }
    const checkpoint = contractSettlementState.updateContractSettlement(
      contractID,
      (current) => ({
        ...current,
        payload: {
          ...current.payload,
          itemLegs: current.payload.itemLegs.map((entry) =>
            entry.legID === leg.legID ? { ...entry, returned: true } : entry),
        },
      }),
    );
    if (!checkpoint.success) {
      return checkpoint;
    }
  }

  const errorMsg = settlement.payload.rejectionError || "CONTRACT_CREATION_REJECTED";
  const removed = contractSettlementState.updateContractSettlement(
    contractID,
    () => null,
  );
  return removed.success
    ? { success: true, rejected: true, errorMsg, contractIDs: [] }
    : removed;
}

async function settleContractCreation(contractID, options = {}) {
  let settlement = contractSettlementState.getPendingContractSettlement(contractID);
  if (!settlement) {
    const contract = getContractRecord(contractID);
    return contract
      ? { success: true, alreadySettled: true, contractIDs: [contractID], contract }
      : { success: true, alreadySettled: true, contractIDs: [] };
  }
  if (settlement.payload.rejectionError) {
    return compensateRejectedContractCreation(contractID);
  }

  for (const candidate of settlement.payload.itemLegs) {
    settlement = contractSettlementState.getPendingContractSettlement(contractID);
    const leg = settlement.payload.itemLegs.find(
      (entry) => entry.legID === candidate.legID,
    );
    if (!leg || leg.staged) {
      continue;
    }
    const moveResult = contractItemCustody.transferItem({
      contractID,
      item: leg.sourceItem,
      ownerID: CONTRACT_ESCROW_OWNER_ID,
      locationID: getContractEscrowLocationID(contractID),
      flagID: 0,
      quantity: leg.quantity,
      reason: CUSTODY_REASON.CONTRACT_ESCROW_STAGE,
      actor: settlement.payload.ownerID,
      idempotencyKey: leg.stageKey,
    });
    const failure = durableContractCustodyFailure(
      moveResult,
      "CONTRACT_ITEM_ESCROW_FAILED",
    );
    if (failure) {
      const rejected = contractSettlementState.updateContractSettlement(
        contractID,
        (current) => ({
          ...current,
          payload: {
            ...current.payload,
            rejectionError: failure.errorMsg || "CONTRACT_ITEM_ESCROW_FAILED",
          },
        }),
      );
      return rejected.success
        ? compensateRejectedContractCreation(contractID)
        : rejected;
    }
    const escrowItem = getCustodyResultItem(
      moveResult,
      getContractEscrowLocationID(contractID),
      leg.sourceItem,
      leg.sourceItem.typeID,
    );
    if (!escrowItem) {
      return { success: false, ambiguous: true, errorMsg: "CONTRACT_ESCROW_ITEM_MISSING" };
    }
    const checkpoint = contractSettlementState.updateContractSettlement(
      contractID,
      (current) => ({
        ...current,
        payload: {
          ...current.payload,
          itemLegs: current.payload.itemLegs.map((entry) =>
            entry.legID === leg.legID
              ? {
                  ...entry,
                  staged: true,
                  escrowItem: cloneValue(escrowItem),
                  changes: cloneValue(moveResult.data && moveResult.data.changes || []),
                }
              : entry),
        },
      }),
    );
    if (!checkpoint.success) {
      return checkpoint;
    }
  }

  settlement = contractSettlementState.getPendingContractSettlement(contractID);
  if (settlement.payload.wrapLeg) {
    const volume = calculateEscrowItemLegsVolume(settlement.payload.itemLegs);
    if (!Number.isFinite(volume) || volume > COURIER_MAX_VOLUME) {
      // Pending work from before the validation was added may already be staged.
      // Return it through the existing compensation path without minting a wrap.
      const rejected = contractSettlementState.updateContractSettlement(
        contractID,
        (current) => ({
          ...current,
          payload: { ...current.payload, rejectionError: "CONTRACT_COURIER_VOLUME_TOO_LARGE" },
        }),
      );
      return rejected.success ? compensateRejectedContractCreation(contractID) : rejected;
    }
  }
  if (settlement.payload.wrapLeg && !settlement.payload.wrapLeg.created) {
    const wrapResult = contractItemCustody.createPlasticWrap({
      contractID,
      ownerID: settlement.payload.ownerID,
      flagID: 0,
      typeID: PLASTIC_WRAP_TYPE_ID,
      actor: settlement.payload.ownerID,
      idempotencyKey: settlement.payload.wrapLeg.createKey,
      ...(settlement.payload.wrapLeg.plasticWrapEncoding === 1
        ? { plasticWrapVolume: calculateCourierVolume(settlement.payload.itemLegs) }
        : {}),
    });
    const failure = durableContractCustodyFailure(
      wrapResult,
      "CONTRACT_WRAP_CREATE_FAILED",
    );
    if (failure) {
      const rejected = contractSettlementState.updateContractSettlement(
        contractID,
        (current) => ({
          ...current,
          payload: { ...current.payload, rejectionError: failure.errorMsg },
        }),
      );
      return rejected.success
        ? compensateRejectedContractCreation(contractID)
        : rejected;
    }
    const wrapItem = getCustodyResultItem(
      wrapResult,
      getContractEscrowLocationID(contractID),
      { itemID: 0, typeID: PLASTIC_WRAP_TYPE_ID },
      PLASTIC_WRAP_TYPE_ID,
    ) || (wrapResult.data && wrapResult.data.items && wrapResult.data.items[0]);
    if (!wrapItem) {
      return { success: false, ambiguous: true, errorMsg: "CONTRACT_WRAP_MISSING" };
    }
    const checkpoint = contractSettlementState.updateContractSettlement(
      contractID,
      (current) => ({
        ...current,
        payload: {
          ...current.payload,
          wrapLeg: {
            ...current.payload.wrapLeg,
            created: true,
            wrapItem: cloneValue(wrapItem),
            changes: cloneValue(wrapResult.data && wrapResult.data.changes || []),
          },
        },
      }),
    );
    if (!checkpoint.success) {
      return checkpoint;
    }
  }

  settlement = contractSettlementState.getPendingContractSettlement(contractID);
  if (settlement.payload.wrapLeg) {
    // A legacy mint may already have a durable receipt or even a checkpoint.
    // Repair it before publishing without changing its original mint command.
    const wrapLeg = settlement.payload.wrapLeg;
    const volumeResult = setPlasticWrapVolumeDurably(
      wrapLeg.wrapItem && wrapLeg.wrapItem.itemID,
      calculateCourierVolume(settlement.payload.itemLegs),
    );
    if (!volumeResult || volumeResult.success !== true) {
      return volumeResult || { success: false, ambiguous: true, errorMsg: "CONTRACT_WRAP_VOLUME_FAILED" };
    }
    const wrapItem = volumeResult.data;
    const checkpoint = contractSettlementState.updateContractSettlement(
      contractID,
      (current) => ({
        ...current,
        payload: {
          ...current.payload,
          wrapLeg: {
            ...current.payload.wrapLeg,
            wrapItem: cloneValue(wrapItem),
            changes: current.payload.wrapLeg.changes.map((change) => (
              Number(change.item && change.item.itemID) === Number(wrapItem.itemID)
                ? { ...change, item: cloneValue(wrapItem) }
                : change
            )),
          },
        },
      }),
    );
    if (!checkpoint.success) return checkpoint;
    settlement = contractSettlementState.getPendingContractSettlement(contractID);
  }
  if (!settlement.payload.rewardApplied) {
    const reward = normalizeMoney(settlement.payload.info.reward, 0);
    const debitResult = await adjustWalletAsync(
      settlement.payload.issuerWalletRef,
      -reward,
      `Contract ${contractID} reward escrow`,
      contractID,
      0,
      settlement.payload.rewardDebitCommandID,
    );
    if (!debitResult || debitResult.success !== true) {
      const errorMsg = debitResult && debitResult.errorMsg || "CONTRACT_REWARD_DEBIT_FAILED";
      if (DEFINITIVE_WALLET_ERRORS.has(errorMsg)) {
        const rejected = contractSettlementState.updateContractSettlement(
          contractID,
          (current) => ({
            ...current,
            payload: { ...current.payload, rejectionError: errorMsg },
          }),
        );
        return rejected.success
          ? compensateRejectedContractCreation(contractID)
          : rejected;
      }
      return debitResult || { success: false, errorMsg };
    }
    const checkpoint = contractSettlementState.updateContractSettlement(
      contractID,
      (current) => ({
        ...current,
        payload: {
          ...current.payload,
          rewardApplied: true,
          rewardResult: cloneValue(debitResult),
        },
      }),
    );
    if (!checkpoint.success) {
      return checkpoint;
    }
  }

  const feeResult = await applyContractWalletLegs(contractID);
  if (!feeResult.success) {
    if (DEFINITIVE_WALLET_ERRORS.has(feeResult.errorMsg)) {
      const rejected = contractSettlementState.updateContractSettlement(contractID, current => ({
        ...current, payload: { ...current.payload, rejectionError: feeResult.errorMsg },
      }));
      return rejected.success ? compensateRejectedContractCreation(contractID) : rejected;
    }
    return feeResult;
  }
  settlement = contractSettlementState.getPendingContractSettlement(contractID);
  const payload = settlement.payload;
  const rows = payload.itemLegs.map((leg, index) =>
    buildContractItemRowFromInventory(
      leg.escrowItem,
      leg.quantity,
      true,
      {
        recordID: index + 1,
        sourceItemID: leg.sourceItem.itemID,
        escrowItemID: leg.escrowItem.itemID,
        flagID: leg.escrowItem.flagID,
      },
    ));
  appendRequestedItemRows(payload.info, rows, rows.length + 1);
  const record = {
    ...payload.baseRecord,
    rewardEscrow: payload.info.reward,
    ...(payload.info.contractType === CONTRACT_TYPE.AUCTION ? { auctionFeesPaid: true } : {}),
  };
  if (payload.info.contractType === CONTRACT_TYPE.COURIER) {
    record.packageLocationID = record.escrowLocationID;
    record.plasticWrapItemID = payload.wrapLeg.wrapItem.itemID;
    record.packageItems = payload.itemLegs.map((leg) => ({
      itemID: leg.escrowItem.itemID,
      itemTypeID: leg.escrowItem.typeID,
      quantity: leg.quantity,
    }));
    record.items = [];
    record.volume = calculateCourierVolume(payload.itemLegs);
  } else {
    record.items = rows;
    record.volume = Math.round(calculateItemRowsVolume(
      rows.filter((row) => row.inCrate),
    ) * 100) / 100;
  }
  const writeResult = putContractRecordDurably(record);
  if (!writeResult.success) {
    return writeResult;
  }
  const removed = contractSettlementState.updateContractSettlement(
    contractID,
    () => null,
  );
  if (!removed.success) {
    return removed;
  }

  const inventoryChanges = [
    ...payload.itemLegs.flatMap((leg) => leg.changes || []),
    ...(payload.wrapLeg ? payload.wrapLeg.changes || [] : []),
  ];
  const preferredSession = options.preferredSession ||
    sessionRegistry.findSessionByCharacterID(record.issuerID) || null;
  if (options.syncInventory !== false) {
    syncInventoryChangesToSession(preferredSession, inventoryChanges, {
      locationContext: buildStructureHangarLocationContext(record.startStationID),
    });
  }
  if (record.type === CONTRACT_TYPE.AUCTION) {
    try {
      await require("./contractAuctionJobs").scheduleContract(record);
    } catch (error) {
      // The durable source is replayed on startup even if scheduling is unavailable.
      log.warn(`[ContractRuntime] Auction expiry scheduling deferred contract=${contractID}: ${error.message}`);
    }
  }
  if (options.notify !== false) {
    contractNotifications.notifyContractCreated(record, preferredSession);
    contractNotifications.notifyContractAssigned(record, preferredSession);
  }
  return {
    success: true,
    contractIDs: [contractID],
    contract: cloneValue(record),
    inventoryChanges,
  };
}

async function settleContractOperation(contractID, options = {}) {
  const settlement = contractSettlementState.getPendingContractSettlement(contractID);
  if (!settlement) {
    const contract = getContractRecord(contractID);
    return contract
      ? { success: true, alreadySettled: true, contractIDs: [contractID], contract }
      : { success: true, alreadySettled: true, contractIDs: [] };
  }
  if (String(settlement.kind).startsWith("auction-claim-")) {
    return getAuctionClaims().settle(contractID, options);
  }
  if (settlement.kind === "auction-bid") {
    return getAuctionRuntime().settle(contractID, options);
  }
  if (settlement.kind === "create") {
    return settleContractCreation(contractID, options);
  }
  if (String(settlement.kind || "").startsWith("accept-")) {
    const result = await settleContractAcceptance(contractID, options);
    if (settlement.kind === "accept-courier" && result && result.success && result.rejected) {
      // A rejected acceptance leaves the courier outstanding. It may have
      // been skipped at startup while its settlement was still in flight.
      const repaired = reconcilePublishedCourierVolume(contractID);
      if (repaired.failures.length > 0 || repaired.skipped.length > 0) {
        log.warn(`[CourierVolume] Post-rejection reconciliation for ${contractID} was not completed: ` +
          [...repaired.failures, ...repaired.skipped].map((entry) => entry.reason).join(", "));
      }
    }
    return result;
  }
  if (String(settlement.kind || "").startsWith("terminal-")) {
    return settleContractTerminalOperation(contractID, options);
  }
  return { success: false, errorMsg: "UNSUPPORTED_CONTRACT_SETTLEMENT" };
}

function prepareContractCreationRequest(rawInfo, session) {
  const info = normalizeContractInfo(rawInfo);
  if (!ensureSupportedCreateInfo(info)) {
    return {
      success: false,
      errorMsg: "UNSUPPORTED_CONTRACT_TYPE",
      contractIDs: [],
    };
  }

  // forCorp is a field of the caller's own struct. The client only sets it for
  // a session holding the Contract Manager role, and refuses any other with
  // this same message, so the role is checked here, before the corporation's
  // hangars or wallet are looked at. Creating for oneself needs no role.
  if (info.forCorp && !sessionHasCorpContractManagerRole(session)) {
    throwContractUserError("ConNotContractManager");
  }
  const ownerID = getOwnedContractSourceID(session, info.forCorp);
  // Contract creation may legitimately target a remote station or Upwell
  // structure, but an arbitrary inventory location is never a dockable
  // contract endpoint. Validate this before item custody planning so a forged
  // space-can/wreck ID cannot be reinterpreted as a station and escrowed.
  requireDockableLocation(info.startStationID, "Contract start location");
  if (info.contractType === CONTRACT_TYPE.COURIER) {
    requireDockableLocation(info.destinationID, "Contract destination");
  }
  const issuerWalletRef = buildWalletRef(session, info.forCorp);
  const requestFingerprint = buildContractCreationFingerprint(
    info,
    session,
    ownerID,
    issuerWalletRef,
  );
  const existing = contractSettlementState.findPendingContractSettlement(
    "create",
    requestFingerprint,
  );
  if (existing) {
    return { success: true, duplicate: true, data: existing };
  }

  validateCreationItems(info, ownerID, session);
  const isPrivate = resolveAvailability(info, session) !== CONTRACT_AVAILABILITY.PUBLIC;
  const privateBrokerFee = isPrivate && info.contractType !== CONTRACT_TYPE.AUCTION
    ? PRIVATE_CONTRACT_BROKER_FEE
    : 0;
  if (info.reward > 0 || privateBrokerFee > 0) {
    assertAuctionWalletAccess(session, issuerWalletRef);
  }
  if (info.contractType === CONTRACT_TYPE.AUCTION) {
    assertAuctionWalletAccess(session, issuerWalletRef);
    const terms = getAuctionCreationTerms(info, session);
    ensureWalletFunds(issuerWalletRef, terms.auctionBrokerFee + terms.auctionDeposit, "Auction fees and deposit");
  }
  ensureWalletFunds(
    issuerWalletRef,
    info.reward + privateBrokerFee,
    privateBrokerFee > 0 ? "Contract reward escrow and broker fee" : "Contract reward escrow",
  );
  return prepareContractCreationSettlement(
    info,
    session,
    ownerID,
    issuerWalletRef,
    privateBrokerFee,
  );
}

async function createContract(rawInfo, session, options = {}) {
  const prepared = prepareContractCreationRequest(rawInfo, session);
  if (!prepared || prepared.success !== true) {
    return prepared || { success: false, errorMsg: "CONTRACT_PREPARE_FAILED", contractIDs: [] };
  }
  const result = await contractSettlementState.settleContractSettlement(
    prepared.data.contractID,
    {
      ...options,
      preferredSession: session,
    },
  );
  return result || { success: false, errorMsg: "CONTRACT_SETTLEMENT_FAILED", contractIDs: [] };
}

async function expireContractByGM(contractID, session) {
  // contractentry.py exposes Expire now to ROLE_GML. Prefer the persisted
  // account role over a composed session mask, as other staff actions do.
  const role = normalizeRoleValue(
    session && (session.accountRole ?? session.role ?? session.rolesAtAll), 0n,
  );
  if ((role & ROLE_GML) === 0n) return { success: false, errorMsg: "CONTRACT_GM_REQUIRED" };
  return contractSettlementState.runSerialized(contractID, async () => {
    // Never edit a deadline while a durable bid, acceptance or claim is pending.
    if (contractSettlementState.getPendingContractSettlement(contractID)) {
      return { success: false, errorMsg: "CONTRACT_SETTLEMENT_PENDING" };
    }
    const record = getContractRecord(contractID);
    if (!record || record.status !== CONTRACT_STATUS.OUTSTANDING) {
      return { success: false, errorMsg: "CONTRACT_NOT_OUTSTANDING" };
    }
    if (isContractExpired(record)) return { success: true, contract: record };
    const next = {
      ...record,
      dateExpired: (toFileTimeBigInt(currentFileTime()) - 1n).toString(),
      updatedAtMs: Date.now(),
    };
    if (record.type === CONTRACT_TYPE.AUCTION) {
      next.auctionEnded = true;
      next.auctionVersion = Number(record.auctionVersion || 0) + 1;
    }
    // Existing issuer/winner claim actions retain ownership of all escrow
    // and wallet transfers. Expiry changes their eligibility only.
    const written = putContractRecordDurably(next);
    return written.success ? { success: true, contract: next } : written;
  });
}

function isContractExpired(contract, now = currentFileTime()) {
  const expires = toFileTimeBigInt(contract && contract.dateExpired);
  return expires > 0n && (contract.type === CONTRACT_TYPE.AUCTION ? expires <= now : expires < now);
}

function isIssuedBySession(contract, session) {
  const characterID = getSessionCharacterID(session);
  const corporationID = getSessionCorporationID(session);
  return Boolean(
    contract &&
    (
      toPositiveInteger(contract.issuerID, 0) === characterID ||
      (
        normalizeBoolean(contract.forCorp, false) &&
        toPositiveInteger(contract.issuerCorpID, 0) === corporationID
      )
    ),
  );
}

function isAssignedToSession(contract, session) {
  if (!contract || toPositiveInteger(contract.assigneeID, 0) <= 0) {
    return false;
  }
  const assigneeID = toPositiveInteger(contract.assigneeID, 0);
  return assigneeID === getSessionCharacterID(session) ||
    assigneeID === getSessionCorporationID(session) ||
    assigneeID === getSessionAllianceID(session);
}

function canViewContract(contract, session) {
  const characterID = getSessionCharacterID(session);
  if (!contract || characterID <= 0) return false;
  if (contract.availability === CONTRACT_AVAILABILITY.PUBLIC) return true;
  const corporationID = getSessionCorporationID(session);
  const issuerVisible = normalizeBoolean(contract.forCorp, false)
    ? corporationID > 0 && Number(contract.issuerCorpID) === corporationID
    : Number(contract.issuerID) === characterID;
  return issuerVisible || isAssignedToSession(contract, session) ||
    Number(contract.acceptorID) === characterID ||
    (corporationID > 0 && Number(contract.acceptorID) === corporationID);
}

function isAcceptedBySession(contract, session) {
  if (!contract || toPositiveInteger(contract.acceptorID, 0) <= 0) {
    return false;
  }
  const acceptorID = toPositiveInteger(contract.acceptorID, 0);
  return acceptorID === getSessionCharacterID(session) ||
    (acceptorID === getSessionCorporationID(session) && sessionHasCorpContractManagerRole(session));
}

function isAcceptedBySessionForFailure(contract, session) {
  if (!contract || toPositiveInteger(contract.acceptorID, 0) <= 0) {
    return false;
  }
  const acceptorID = toPositiveInteger(contract.acceptorID, 0);
  if (acceptorID === getSessionCharacterID(session)) {
    return true;
  }
  return acceptorID === getSessionCorporationID(session) &&
    sessionHasCorpContractManagerRole(session);
}

function isIssuedBySessionWithCorpAuthority(contract, session) {
  if (!contract) {
    return false;
  }
  if (!normalizeBoolean(contract.forCorp, false)) {
    return getSessionCharacterID(session) > 0 &&
      toPositiveInteger(contract.issuerID, 0) === getSessionCharacterID(session);
  }
  return getSessionCorporationID(session) > 0 &&
    toPositiveInteger(contract.issuerCorpID, 0) === getSessionCorporationID(session) &&
    sessionHasCorpContractManagerRole(session);
}

function canRejectContract(contract, session) {
  if (!contract || toPositiveInteger(contract.assigneeID, 0) <= 0) {
    return false;
  }
  const assigneeID = toPositiveInteger(contract.assigneeID, 0);
  if (assigneeID === getSessionCharacterID(session)) {
    return true;
  }
  if (!sessionHasCorpContractManagerRole(session)) {
    return false;
  }
  if (assigneeID === getSessionCorporationID(session)) {
    return true;
  }
  const allianceID = getSessionAllianceID(session);
  return allianceID > 0 &&
    assigneeID === allianceID &&
    toPositiveInteger(contract.issuerCorpID, 0) === getSessionCorporationID(session);
}

function canAcceptContract(contract, session) {
  if (!contract || contract.status !== CONTRACT_STATUS.OUTSTANDING) {
    return false;
  }
  if (isContractExpired(contract)) {
    return false;
  }
  if (contract.availability === CONTRACT_AVAILABILITY.PUBLIC) {
    return true;
  }
  return isAssignedToSession(contract, session);
}

function findRequestedItems(ownerID, locationID, forCorp, typeID, session = null) {
  return listContainerItems(ownerID, locationID, null)
    .filter((item) => (
      toPositiveInteger(item && item.typeID, 0) === toPositiveInteger(typeID, 0) &&
      isAllowedContractSourceFlag(item.flagID, forCorp, 0) &&
      (!forCorp || canAccessCorporationContractItem(session, ownerID, locationID, item.flagID, true))
    ))
    .sort((left, right) => toPositiveInteger(left.itemID, 0) - toPositiveInteger(right.itemID, 0));
}

function ensureRequestedItemsAvailable(contract, acceptorOwnerID, acceptForCorp, session) {
  for (const requested of (contract.items || []).filter((row) => !row.inCrate)) {
    let remaining = toPositiveInteger(requested.quantity, 0);
    for (const item of findRequestedItems(
      acceptorOwnerID,
      contract.startStationID,
      acceptForCorp,
      requested.itemTypeID,
      session,
    )) {
      remaining -= getItemQuantity(item);
      if (remaining <= 0) {
        break;
      }
    }
    if (remaining > 0) {
      throwContractError(`The acceptor does not have enough item type ${requested.itemTypeID} at the contract location.`);
    }
  }
}

function transferRequestedItemsToIssuer(contract, acceptorOwnerID, acceptForCorp) {
  const changes = [];
  const issuerFlagID = getOwnerDeliveryFlag(
    normalizeBoolean(contract.forCorp, false),
    contract.startStationDivision,
  );

  for (const requested of (contract.items || []).filter((row) => !row.inCrate)) {
    let remaining = toPositiveInteger(requested.quantity, 0);
    const candidates = findRequestedItems(
      acceptorOwnerID,
      contract.startStationID,
      acceptForCorp,
      requested.itemTypeID,
    );
    for (const item of candidates) {
      if (remaining <= 0) {
        break;
      }
      const moveQuantity = Math.min(remaining, getItemQuantity(item));
      const transferResult = contractItemCustody.transferItem({
        contractID: contract.contractID,
        item,
        ownerID: contract.issuerOwnerID,
        locationID: contract.startStationID,
        flagID: issuerFlagID,
        quantity: toInteger(item.singleton, 0) === 1 ? null : moveQuantity,
        reason: CUSTODY_REASON.CONTRACT_REQUEST_DELIVER,
        actor: acceptorOwnerID,
      });
      if (!transferResult.success) {
        throwContractError(`Failed to transfer requested item ${item.itemID}.`);
      }
      changes.push(...((transferResult.data && transferResult.data.changes) || []));
      const movedItem = findMovedItem(
        transferResult.data && transferResult.data.changes,
        contract.startStationID,
        item.itemID,
        item.typeID,
      );
      if (movedItem) {
        changes.push(...transferContainedItemsToOwner(
          contract.contractID,
          movedItem.itemID,
          contract.issuerOwnerID,
        ));
      }
      remaining -= moveQuantity;
    }
    if (remaining > 0) {
      throwContractError(`The acceptor does not have enough item type ${requested.itemTypeID} at the contract location.`);
    }
  }

  return changes;
}

function transferEscrowRowsToOwner(contract, targetOwnerID, locationID, flagID) {
  const changes = [];
  const nextRows = (contract.items || []).map((row) => ({ ...row }));

  for (const row of nextRows.filter((entry) => entry.inCrate)) {
    const escrowItemID = toPositiveInteger(row.escrowItemID || row.itemID, 0);
    if (!escrowItemID) {
      continue;
    }
    const currentItem = findItemById(escrowItemID);
    const transferResult = contractItemCustody.transferItem({
      contractID: contract.contractID,
      item: currentItem,
      ownerID: targetOwnerID,
      locationID,
      flagID,
      reason: targetOwnerID === toPositiveInteger(contract.issuerOwnerID, 0)
        ? CUSTODY_REASON.CONTRACT_ESCROW_RETURN
        : CUSTODY_REASON.CONTRACT_ESCROW_DELIVER,
      actor: targetOwnerID,
    });
    if (!transferResult.success) {
      throwContractError(`Failed to transfer escrow item ${escrowItemID}.`);
    }
    const transferChanges = (transferResult.data && transferResult.data.changes) || [];
    changes.push(...transferChanges);
    const movedItem = findMovedItem(
      transferChanges,
      locationID,
      escrowItemID,
      row.itemTypeID,
    );
    if (movedItem) {
      row.itemID = movedItem.itemID;
      row.escrowItemID = movedItem.itemID;
      changes.push(...transferContainedItemsToOwner(
        contract.contractID,
        movedItem.itemID,
        targetOwnerID,
      ));
    }
  }

  return {
    rows: nextRows,
    changes,
  };
}

function getPackageWrap(contract) {
  const wrapItemID = toPositiveInteger(contract && contract.plasticWrapItemID, 0);
  return wrapItemID ? findItemById(wrapItemID) : null;
}

function buildContractWalletLeg({
  legID,
  ref,
  delta,
  description,
  contractID,
  counterpartyID = 0,
}) {
  const normalizedDelta = Math.round((Number(delta) || 0) * 100) / 100;
  return {
    legID,
    ref: cloneWalletRef(ref),
    delta: normalizedDelta,
    description,
    counterpartyID: toPositiveInteger(counterpartyID, 0),
    commandID: `contract:${contractID}:${legID}`,
    reverseCommandID: `contract:${contractID}:${legID}:reverse`,
    applied: Math.abs(normalizedDelta) < 0.0001,
    reversed: false,
    result: null,
  };
}

function buildContractContentLegs(contractID, operationKind, parentLegID, rootItemID) {
  return collectContainedItems(rootItemID).map((item, index) => ({
    legID: `${parentLegID}:content:${index + 1}`,
    item: cloneValue(item),
    transferKey:
      `contract:${contractID}:${operationKind}:${parentLegID}:content:${index + 1}`,
    transferred: false,
    changes: [],
  }));
}

function buildRequestedAcceptanceLegs(
  contract,
  acceptorOwnerID,
  acceptForCorp,
  session,
) {
  const availableByItemID = new Map();
  const legs = [];
  for (const requested of (contract.items || []).filter((row) => !row.inCrate)) {
    let remaining = toPositiveInteger(requested.quantity, 0);
    const candidates = findRequestedItems(
      acceptorOwnerID,
      contract.startStationID,
      acceptForCorp,
      requested.itemTypeID,
      session,
    );
    for (const item of candidates) {
      if (remaining <= 0) {
        break;
      }
      const itemID = toPositiveInteger(item.itemID, 0);
      const available = availableByItemID.has(itemID)
        ? availableByItemID.get(itemID)
        : getItemQuantity(item);
      if (available <= 0) {
        continue;
      }
      const quantity = Math.min(remaining, available);
      const legID = `requested:${legs.length + 1}`;
      legs.push({
        legID,
        requestedRecordID: toPositiveInteger(requested.recordID, 0),
        sourceItem: cloneValue(item),
        quantity,
        stageKey: `contract:${contract.contractID}:accept:${legID}:stage`,
        returnKey: `contract:${contract.contractID}:accept:${legID}:return`,
        deliverKey: `contract:${contract.contractID}:accept:${legID}:deliver`,
        staged: false,
        returned: false,
        delivered: false,
        escrowItem: null,
        deliveredItem: null,
        stageChanges: [],
        deliverChanges: [],
        contentLegs: quantity === getItemQuantity(item)
          ? buildContractContentLegs(
              contract.contractID,
              "accept",
              legID,
              item.itemID,
            )
          : [],
      });
      availableByItemID.set(itemID, available - quantity);
      remaining -= quantity;
    }
    if (remaining > 0) {
      throwContractError(
        `The acceptor does not have enough item type ${requested.itemTypeID} at the contract location.`,
      );
    }
  }
  return legs;
}

function buildOfferedAcceptanceLegs(contract) {
  return (contract.items || [])
    .filter((row) => row.inCrate)
    .map((row, index) => {
      const itemID = toPositiveInteger(row.escrowItemID || row.itemID, 0);
      const item = itemID ? findItemById(itemID) : null;
      if (!item) {
        throwContractError(`Escrow item ${itemID || "unknown"} could not be found.`);
      }
      const legID = `offered:${index + 1}`;
      return {
        legID,
        recordID: toPositiveInteger(row.recordID, index + 1),
        row: cloneValue(row),
        item: cloneValue(item),
        deliverKey: `contract:${contract.contractID}:accept:${legID}:deliver`,
        delivered: false,
        deliveredItem: null,
        deliverChanges: [],
        contentLegs: buildContractContentLegs(
          contract.contractID,
          "accept",
          legID,
          item.itemID,
        ),
      };
    });
}

function buildContractAcceptanceFingerprint(
  contract,
  session,
  acceptForCorp,
  acceptorOwnerID,
  acceptorWalletRef,
) {
  return JSON.stringify({
    contractID: contract.contractID,
    contractUpdatedAtMs: contract.updatedAtMs,
    acceptForCorp,
    acceptorID: acceptForCorp
      ? getSessionCorporationID(session)
      : getSessionCharacterID(session),
    acceptorOwnerID,
    acceptorWalletRef: cloneWalletRef(acceptorWalletRef),
  });
}

function prepareContractAcceptanceRequest(contractID, session, rawAcceptForCorp = false) {
  const contract = getContractRecord(contractID);
  if (!contract) {
    return { success: true, missing: true, data: null };
  }
  const acceptForCorp = normalizeBoolean(rawAcceptForCorp, false);
  // The flag is the caller's own argument. The client only offers to accept for
  // the corporation to a session holding the Contract Manager role, so the
  // role is checked here, before the corporation's wallet is resolved or a
  // pending settlement is replayed. Accepting for oneself needs no role. The
  // refusal is the client's own message for a character without the role.
  if (acceptForCorp && !sessionHasCorpContractManagerRole(session)) {
    throwContractUserError("ConNotContractManager");
  }
  const acceptorOwnerID = getOwnedContractSourceID(session, acceptForCorp);
  const acceptorWalletRef = buildWalletRef(session, acceptForCorp);
  const requestFingerprint = buildContractAcceptanceFingerprint(
    contract,
    session,
    acceptForCorp,
    acceptorOwnerID,
    acceptorWalletRef,
  );
  const existing = contractSettlementState.getPendingContractSettlement(
    contract.contractID,
  );
  if (existing) {
    if (
      existing.requestFingerprint !== requestFingerprint ||
      !String(existing.kind || "").startsWith("accept-")
    ) {
      return { success: false, errorMsg: "CONTRACT_OPERATION_PENDING" };
    }
    return { success: true, duplicate: true, data: existing };
  }
  if (!canAcceptContract(contract, session)) {
    throwContractError("This contract is not available to accept.");
  }
  if (isIssuedBySession(contract, session) && !isAssignedToSession(contract, session)) {
    throwContractError("You cannot accept your own unassigned contract.");
  }

  const acceptorID = acceptForCorp
    ? getSessionCorporationID(session)
    : getSessionCharacterID(session);
  const commonPayload = {
    contract: cloneValue(contract),
    acceptForCorp,
    acceptorID,
    acceptorOwnerID,
    acceptorWalletRef: cloneWalletRef(acceptorWalletRef),
    acceptedAt: nowFileTimeString(),
    walletLegs: [],
    requestedLegs: [],
    offeredLegs: [],
    wrapLeg: null,
    rejectionError: null,
  };
  let kind = null;
  if (contract.type === CONTRACT_TYPE.ITEM_EXCHANGE) {
    if (contract.price > 0) assertAuctionWalletAccess(session, acceptorWalletRef);
    ensureRequestedItemsAvailable(contract, acceptorOwnerID, acceptForCorp, session);
    ensureWalletFunds(acceptorWalletRef, contract.price, "Contract price");
    kind = "accept-item-exchange";
    commonPayload.requestedLegs = buildRequestedAcceptanceLegs(
      contract,
      acceptorOwnerID,
      acceptForCorp,
      session,
    );
    commonPayload.offeredLegs = buildOfferedAcceptanceLegs(contract);
    commonPayload.walletLegs = [
      buildContractWalletLeg({
        legID: "accept:price-debit",
        ref: acceptorWalletRef,
        delta: -contract.price,
        description: `Contract ${contract.contractID} price paid`,
        contractID: contract.contractID,
        counterpartyID: contract.issuerOwnerID,
      }),
      buildContractWalletLeg({
        legID: "accept:price-credit",
        ref: contract.issuerWallet,
        delta: contract.price,
        description: `Contract ${contract.contractID} price received`,
        contractID: contract.contractID,
        counterpartyID: acceptorOwnerID,
      }),
      buildContractWalletLeg({
        legID: "accept:reward-credit",
        ref: acceptorWalletRef,
        delta: contract.rewardEscrow,
        description: `Contract ${contract.contractID} reward received`,
        contractID: contract.contractID,
        counterpartyID: contract.issuerOwnerID,
      }),
    ];
  } else if (contract.type === CONTRACT_TYPE.COURIER) {
    if (contract.collateral > 0) assertAuctionWalletAccess(session, acceptorWalletRef);
    ensureWalletFunds(acceptorWalletRef, contract.collateral, "Courier collateral");
    const wrap = getPackageWrap(contract);
    if (!wrap) {
      throwContractError("The courier package could not be found.");
    }
    kind = "accept-courier";
    commonPayload.walletLegs = [buildContractWalletLeg({
      legID: "accept:collateral-debit",
      ref: acceptorWalletRef,
      delta: -contract.collateral,
      description: `Contract ${contract.contractID} collateral escrow`,
      contractID: contract.contractID,
      counterpartyID: contract.issuerOwnerID,
    })];
    commonPayload.wrapLeg = {
      item: cloneValue(wrap),
      transferKey: `contract:${contract.contractID}:accept:wrap:deliver`,
      transferred: false,
      deliveredItem: null,
      changes: [],
    };
  } else {
    return { success: false, errorMsg: "UNSUPPORTED_CONTRACT_TYPE" };
  }

  return contractSettlementState.prepareContractSettlement({
    contractID: contract.contractID,
    kind,
    requestFingerprint,
    payload: commonPayload,
  });
}

async function checkpointContractWalletLeg(contractID, legID, patch) {
  return contractSettlementState.updateContractSettlement(
    contractID,
    (current) => ({
      ...current,
      payload: {
        ...current.payload,
        walletLegs: current.payload.walletLegs.map((leg) =>
          leg.legID === legID ? { ...leg, ...patch } : leg),
      },
    }),
  );
}

async function applyContractWalletLegs(contractID) {
  let settlement = contractSettlementState.getPendingContractSettlement(contractID);
  const auction = settlement.kind === "auction-bid" || settlement.kind.startsWith("auction-claim-");
  for (const candidate of settlement.payload.walletLegs || []) {
    settlement = contractSettlementState.getPendingContractSettlement(contractID);
    const leg = settlement.payload.walletLegs.find(
      (entry) => entry.legID === candidate.legID,
    );
    if (!leg || leg.applied) {
      continue;
    }
    const apply = () => adjustWalletAsync(
      leg.ref,
      leg.delta,
      leg.description,
      contractID,
      leg.counterpartyID,
      leg.commandID,
      leg.journal,
    );
    let result = await apply();
    // A process error string alone cannot prove that the debit did not land.
    // Replay the identical command to obtain the owner's persisted verdict.
    // Local execution is synchronous and has no transport ambiguity.
    if (auction && isWalletAuthorityProcessEnabled() && result?.success === false &&
        ["INSUFFICIENT_FUNDS", "WALLET_LIMIT"].includes(result.errorMsg) && result.duplicate !== true) {
      result = await apply();
    }
    if (auction && result?.fingerprintMismatch === true) {
      return { success: false, errorMsg: "AUCTION_WALLET_RECEIPT_IDENTITY_CHANGED" };
    }
    const noEffectConfirmed = result?.success === false &&
      (!isWalletAuthorityProcessEnabled() || (result.duplicate === true && result.fingerprintMismatch === false));
    if (auction && leg.delta > 0 && result?.errorMsg === "WALLET_LIMIT" && noEffectConfirmed) {
      // Only a proven no-credit result permits a new identity. Persist that
      // identity before using it; retain the full obligation and frozen payload.
      // Existing permanent contract receipts protect successful legs, so this
      // does not depend on Coffee's fork-only pin/release APIs.
      const creditAttempt = Number(leg.creditAttempt || 0) + 1;
      if (!Number.isSafeInteger(creditAttempt)) return { success: false, errorMsg: "AUCTION_CREDIT_ATTEMPTS_EXHAUSTED" };
      const baseCommandID = leg.baseCommandID || leg.commandID;
      const checkpoint = await checkpointContractWalletLeg(contractID, leg.legID, {
        baseCommandID, creditAttempt, commandID: `${baseCommandID}:credit:${creditAttempt}`,
      });
      return checkpoint.success ? { success: false, errorMsg: "AUCTION_CREDIT_LIMIT_PENDING" } : checkpoint;
    }
    if (!result || result.success !== true) {
      if (auction && result?.errorMsg === "INSUFFICIENT_FUNDS" && noEffectConfirmed) {
        return { ...result, noEffectConfirmed: true };
      }
      return result || { success: false, errorMsg: "CONTRACT_WALLET_LEG_FAILED" };
    }
    const appliedDelta = result.delta ?? result.data?.delta;
    if (auction && Number(leg.delta) !== 0 &&
        (!Number.isFinite(appliedDelta) || Math.round(appliedDelta * 100) !== Math.round(leg.delta * 100))) {
      return { success: false, errorMsg: "AUCTION_WALLET_AMOUNT_CHANGED" };
    }
    const checkpoint = await checkpointContractWalletLeg(
      contractID,
      leg.legID,
      { applied: true, result: cloneValue(result) },
    );
    if (!checkpoint.success) {
      return checkpoint;
    }
  }
  return { success: true };
}

async function reverseContractWalletLegs(contractID) {
  let settlement = contractSettlementState.getPendingContractSettlement(contractID);
  const candidates = [...(settlement.payload.walletLegs || [])].reverse();
  for (const candidate of candidates) {
    settlement = contractSettlementState.getPendingContractSettlement(contractID);
    const leg = settlement.payload.walletLegs.find(
      (entry) => entry.legID === candidate.legID,
    );
    if (!leg || !leg.applied || leg.reversed || Math.abs(leg.delta) < 0.0001) {
      continue;
    }
    const result = await adjustWalletAsync(
      leg.ref,
      -leg.delta,
      `${leg.description} reversal`,
      contractID,
      leg.counterpartyID,
      leg.reverseCommandID,
      leg.journal,
    );
    if (!result || result.success !== true) {
      return result || { success: false, errorMsg: "CONTRACT_WALLET_REVERSAL_FAILED" };
    }
    const checkpoint = await checkpointContractWalletLeg(
      contractID,
      leg.legID,
      { reversed: true },
    );
    if (!checkpoint.success) {
      return checkpoint;
    }
  }
  return { success: true };
}

async function compensateRejectedContractAcceptance(contractID) {
  const walletResult = await reverseContractWalletLegs(contractID);
  if (!walletResult.success) {
    return walletResult;
  }

  let settlement = contractSettlementState.getPendingContractSettlement(contractID);
  for (const candidate of [...(settlement.payload.requestedLegs || [])].reverse()) {
    settlement = contractSettlementState.getPendingContractSettlement(contractID);
    const leg = settlement.payload.requestedLegs.find(
      (entry) => entry.legID === candidate.legID,
    );
    if (!leg || !leg.staged || leg.returned) {
      continue;
    }
    const result = contractItemCustody.transferItem({
      contractID,
      item: leg.escrowItem,
      ownerID: leg.sourceItem.ownerID,
      locationID: leg.sourceItem.locationID,
      flagID: leg.sourceItem.flagID,
      quantity: null,
      reason: CUSTODY_REASON.CONTRACT_ESCROW_RETURN,
      actor: settlement.payload.acceptorOwnerID,
      idempotencyKey: leg.returnKey,
    });
    const failure = durableContractCustodyFailure(
      result,
      "CONTRACT_REQUEST_ITEM_RETURN_FAILED",
    );
    if (failure) {
      return failure;
    }
    const checkpoint = contractSettlementState.updateContractSettlement(
      contractID,
      (current) => ({
        ...current,
        payload: {
          ...current.payload,
          requestedLegs: current.payload.requestedLegs.map((entry) =>
            entry.legID === leg.legID ? { ...entry, returned: true } : entry),
        },
      }),
    );
    if (!checkpoint.success) {
      return checkpoint;
    }
  }

  settlement = contractSettlementState.getPendingContractSettlement(contractID);
  const errorMsg = settlement.payload.rejectionError || "CONTRACT_ACCEPTANCE_REJECTED";
  const removed = contractSettlementState.updateContractSettlement(
    contractID,
    () => null,
  );
  return removed.success
    ? { success: true, rejected: true, errorMsg, contract: null }
    : removed;
}

async function stageRequestedAcceptanceItems(contractID) {
  let settlement = contractSettlementState.getPendingContractSettlement(contractID);
  for (const candidate of settlement.payload.requestedLegs || []) {
    settlement = contractSettlementState.getPendingContractSettlement(contractID);
    const leg = settlement.payload.requestedLegs.find(
      (entry) => entry.legID === candidate.legID,
    );
    if (!leg || leg.staged) {
      continue;
    }
    const result = contractItemCustody.transferItem({
      contractID,
      item: leg.sourceItem,
      ownerID: CONTRACT_ESCROW_OWNER_ID,
      locationID: getContractEscrowLocationID(contractID),
      flagID: 0,
      quantity: leg.quantity,
      reason: CUSTODY_REASON.CONTRACT_ESCROW_STAGE,
      actor: settlement.payload.acceptorOwnerID,
      idempotencyKey: leg.stageKey,
    });
    const failure = durableContractCustodyFailure(
      result,
      "CONTRACT_REQUEST_ITEM_STAGE_FAILED",
    );
    if (failure) {
      return failure;
    }
    const escrowItem = getCustodyResultItem(
      result,
      getContractEscrowLocationID(contractID),
      leg.sourceItem,
      leg.sourceItem.typeID,
    );
    if (!escrowItem) {
      return { success: false, ambiguous: true, errorMsg: "CONTRACT_REQUEST_ESCROW_ITEM_MISSING" };
    }
    const checkpoint = contractSettlementState.updateContractSettlement(
      contractID,
      (current) => ({
        ...current,
        payload: {
          ...current.payload,
          requestedLegs: current.payload.requestedLegs.map((entry) =>
            entry.legID === leg.legID
              ? {
                  ...entry,
                  staged: true,
                  escrowItem: cloneValue(escrowItem),
                  stageChanges: cloneValue(result.data && result.data.changes || []),
                }
              : entry),
        },
      }),
    );
    if (!checkpoint.success) {
      return checkpoint;
    }
  }
  return { success: true };
}

function checkpointContractContentLeg(
  contractID,
  parentCollection,
  parentLegID,
  legID,
  changes = [],
) {
  return contractSettlementState.updateContractSettlement(
    contractID,
    (current) => ({
      ...current,
      payload: {
        ...current.payload,
        [parentCollection]: current.payload[parentCollection].map((entry) =>
          entry.legID === parentLegID
            ? {
                ...entry,
                contentLegs: entry.contentLegs.map((contentLeg) =>
                  contentLeg.legID === legID
                    ? {
                        ...contentLeg,
                        transferred: true,
                        changes: cloneValue(changes),
                      }
                    : contentLeg),
              }
            : entry),
      },
    }),
  );
}

function isContractContentOwnershipSatisfied(leg, ownerID) {
  const destinationOwnerID = toPositiveInteger(ownerID, 0);
  const item = leg && leg.item;
  const itemID = toPositiveInteger(item && item.itemID, 0);
  if (
    !destinationOwnerID ||
    !itemID ||
    toPositiveInteger(item.ownerID, 0) !== destinationOwnerID
  ) {
    return false;
  }
  const liveItem = findItemById(itemID);
  return Boolean(
    liveItem &&
    toPositiveInteger(liveItem.ownerID, 0) === destinationOwnerID &&
    toPositiveInteger(liveItem.locationID, 0) === toPositiveInteger(item.locationID, 0) &&
    toInteger(liveItem.flagID, -1) === toInteger(item.flagID, -1)
  );
}

function transferAcceptanceContentLegs(contractID, parentCollection, parentLegID, ownerID) {
  let settlement = contractSettlementState.getPendingContractSettlement(contractID);
  const parent = settlement.payload[parentCollection].find(
    (entry) => entry.legID === parentLegID,
  );
  for (const candidate of parent.contentLegs || []) {
    settlement = contractSettlementState.getPendingContractSettlement(contractID);
    const currentParent = settlement.payload[parentCollection].find(
      (entry) => entry.legID === parentLegID,
    );
    const leg = currentParent.contentLegs.find(
      (entry) => entry.legID === candidate.legID,
    );
    if (!leg || leg.transferred) {
      continue;
    }
    if (isContractContentOwnershipSatisfied(leg, ownerID)) {
      const checkpoint = checkpointContractContentLeg(
        contractID,
        parentCollection,
        parentLegID,
        leg.legID,
      );
      if (!checkpoint.success) {
        return checkpoint;
      }
      continue;
    }
    const result = contractItemCustody.transferItem({
      contractID,
      item: leg.item,
      ownerID,
      locationID: leg.item.locationID,
      flagID: leg.item.flagID,
      quantity: null,
      reason: CUSTODY_REASON.CONTRACT_CONTENT_OWNER_TRANSFER,
      actor: ownerID,
      idempotencyKey: leg.transferKey,
    });
    const failure = durableContractCustodyFailure(
      result,
      "CONTRACT_CONTENT_OWNER_TRANSFER_FAILED",
    );
    if (failure) {
      return failure;
    }
    const checkpoint = checkpointContractContentLeg(
      contractID,
      parentCollection,
      parentLegID,
      leg.legID,
      result.data && result.data.changes || [],
    );
    if (!checkpoint.success) {
      return checkpoint;
    }
  }
  return { success: true };
}

async function deliverItemExchangeAcceptance(contractID) {
  let settlement = contractSettlementState.getPendingContractSettlement(contractID);
  const payload = settlement.payload;
  const contract = payload.contract;
  const issuerFlagID = getOwnerDeliveryFlag(
    normalizeBoolean(contract.forCorp, false),
    contract.startStationDivision,
  );
  for (const candidate of payload.requestedLegs) {
    settlement = contractSettlementState.getPendingContractSettlement(contractID);
    const leg = settlement.payload.requestedLegs.find(
      (entry) => entry.legID === candidate.legID,
    );
    if (!leg.delivered) {
      const result = contractItemCustody.transferItem({
        contractID,
        item: leg.escrowItem,
        ownerID: contract.issuerOwnerID,
        locationID: contract.startStationID,
        flagID: issuerFlagID,
        quantity: null,
        reason: CUSTODY_REASON.CONTRACT_ESCROW_DELIVER,
        actor: payload.acceptorOwnerID,
        idempotencyKey: leg.deliverKey,
      });
      const failure = durableContractCustodyFailure(
        result,
        "CONTRACT_REQUEST_ITEM_DELIVERY_FAILED",
      );
      if (failure) {
        return failure;
      }
      const deliveredItem = getCustodyResultItem(
        result,
        contract.startStationID,
        leg.escrowItem,
        leg.sourceItem.typeID,
      );
      const checkpoint = contractSettlementState.updateContractSettlement(
        contractID,
        (current) => ({
          ...current,
          payload: {
            ...current.payload,
            requestedLegs: current.payload.requestedLegs.map((entry) =>
              entry.legID === leg.legID
                ? {
                    ...entry,
                    delivered: true,
                    deliveredItem: cloneValue(deliveredItem),
                    deliverChanges: cloneValue(result.data && result.data.changes || []),
                  }
                : entry),
          },
        }),
      );
      if (!checkpoint.success) {
        return checkpoint;
      }
    }
    const contentResult = transferAcceptanceContentLegs(
      contractID,
      "requestedLegs",
      leg.legID,
      contract.issuerOwnerID,
    );
    if (!contentResult.success) {
      return contentResult;
    }
  }

  settlement = contractSettlementState.getPendingContractSettlement(contractID);
  for (const candidate of settlement.payload.offeredLegs) {
    settlement = contractSettlementState.getPendingContractSettlement(contractID);
    const leg = settlement.payload.offeredLegs.find(
      (entry) => entry.legID === candidate.legID,
    );
    if (!leg.delivered) {
      const result = contractItemCustody.transferItem({
        contractID,
        item: leg.item,
        ownerID: payload.acceptorOwnerID,
        locationID: contract.startStationID,
        flagID: getAcceptorDeliveryFlag(payload.acceptForCorp),
        quantity: null,
        reason: CUSTODY_REASON.CONTRACT_ESCROW_DELIVER,
        actor: payload.acceptorOwnerID,
        idempotencyKey: leg.deliverKey,
      });
      const failure = durableContractCustodyFailure(
        result,
        "CONTRACT_OFFERED_ITEM_DELIVERY_FAILED",
      );
      if (failure) {
        return failure;
      }
      const deliveredItem = getCustodyResultItem(
        result,
        contract.startStationID,
        leg.item,
        leg.item.typeID,
      );
      const checkpoint = contractSettlementState.updateContractSettlement(
        contractID,
        (current) => ({
          ...current,
          payload: {
            ...current.payload,
            offeredLegs: current.payload.offeredLegs.map((entry) =>
              entry.legID === leg.legID
                ? {
                    ...entry,
                    delivered: true,
                    deliveredItem: cloneValue(deliveredItem),
                    deliverChanges: cloneValue(result.data && result.data.changes || []),
                  }
                : entry),
          },
        }),
      );
      if (!checkpoint.success) {
        return checkpoint;
      }
    }
    const contentResult = transferAcceptanceContentLegs(
      contractID,
      "offeredLegs",
      leg.legID,
      payload.acceptorOwnerID,
    );
    if (!contentResult.success) {
      return contentResult;
    }
  }
  return { success: true };
}

async function deliverCourierAcceptance(contractID) {
  const settlement = contractSettlementState.getPendingContractSettlement(contractID);
  const payload = settlement.payload;
  if (payload.wrapLeg.transferred) {
    return { success: true };
  }
  const result = contractItemCustody.transferItem({
    contractID,
    item: payload.wrapLeg.item,
    ownerID: payload.acceptorOwnerID,
    locationID: payload.contract.startStationID,
    flagID: getAcceptorDeliveryFlag(payload.acceptForCorp),
    quantity: null,
    reason: CUSTODY_REASON.CONTRACT_COURIER_ACCEPT,
    actor: payload.acceptorOwnerID,
    idempotencyKey: payload.wrapLeg.transferKey,
  });
  const failure = durableContractCustodyFailure(
    result,
    "CONTRACT_COURIER_PACKAGE_DELIVERY_FAILED",
  );
  if (failure) {
    return failure;
  }
  const deliveredItem = getCustodyResultItem(
    result,
    payload.contract.startStationID,
    payload.wrapLeg.item,
    PLASTIC_WRAP_TYPE_ID,
  );
  return contractSettlementState.updateContractSettlement(
    contractID,
    (current) => ({
      ...current,
      payload: {
        ...current.payload,
        wrapLeg: {
          ...current.payload.wrapLeg,
          transferred: true,
          deliveredItem: cloneValue(deliveredItem),
          changes: cloneValue(result.data && result.data.changes || []),
        },
      },
    }),
  );
}

function collectAcceptanceInventoryChanges(payload) {
  return [
    ...(payload.requestedLegs || []).flatMap((leg) => [
      ...(leg.stageChanges || []),
      ...(leg.deliverChanges || []),
      ...(leg.contentLegs || []).flatMap((contentLeg) => contentLeg.changes || []),
    ]),
    ...(payload.offeredLegs || []).flatMap((leg) => [
      ...(leg.deliverChanges || []),
      ...(leg.contentLegs || []).flatMap((contentLeg) => contentLeg.changes || []),
    ]),
    ...(payload.wrapLeg ? payload.wrapLeg.changes || [] : []),
  ];
}

async function settleContractAcceptance(contractID, options = {}) {
  let settlement = contractSettlementState.getPendingContractSettlement(contractID);
  if (!settlement) {
    const contract = getContractRecord(contractID);
    return { success: true, alreadySettled: true, contract };
  }
  if (settlement.payload.rejectionError) {
    return compensateRejectedContractAcceptance(contractID);
  }

  if (settlement.kind === "accept-item-exchange") {
    const staged = await stageRequestedAcceptanceItems(contractID);
    if (!staged.success) {
      return staged;
    }
  }
  const walletResult = await applyContractWalletLegs(contractID);
  if (!walletResult.success) {
    const errorMsg = walletResult.errorMsg || "CONTRACT_ACCEPTANCE_WALLET_FAILED";
    if (DEFINITIVE_WALLET_ERRORS.has(errorMsg)) {
      const rejected = contractSettlementState.updateContractSettlement(
        contractID,
        (current) => ({
          ...current,
          payload: { ...current.payload, rejectionError: errorMsg },
        }),
      );
      return rejected.success
        ? compensateRejectedContractAcceptance(contractID)
        : rejected;
    }
    return walletResult;
  }

  const deliveryResult = settlement.kind === "accept-item-exchange"
    ? await deliverItemExchangeAcceptance(contractID)
    : await deliverCourierAcceptance(contractID);
  if (!deliveryResult.success) {
    return deliveryResult;
  }

  settlement = contractSettlementState.getPendingContractSettlement(contractID);
  const payload = settlement.payload;
  const contract = payload.contract;
  let next = null;
  if (settlement.kind === "accept-item-exchange") {
    const offeredByRecordID = new Map(
      payload.offeredLegs.map((leg) => [leg.recordID, leg]),
    );
    next = {
      ...contract,
      status: CONTRACT_STATUS.FINISHED,
      acceptorID: payload.acceptorID,
      acceptorWallet: cloneWalletRef(payload.acceptorWalletRef),
      acceptorWalletKey: payload.acceptorWalletRef.kind === "corporation"
        ? payload.acceptorWalletRef.accountKey
        : null,
      dateAccepted: payload.acceptedAt,
      dateCompleted: payload.acceptedAt,
      rewardEscrow: 0,
      rewardPaid: contract.rewardEscrow > 0,
      items: contract.items.map((row) => {
        const leg = offeredByRecordID.get(toPositiveInteger(row.recordID, 0));
        return leg && leg.deliveredItem
          ? {
              ...row,
              itemID: leg.deliveredItem.itemID,
              escrowItemID: leg.deliveredItem.itemID,
              flagID: leg.deliveredItem.flagID,
            }
          : row;
      }),
      updatedAtMs: Date.now(),
    };
  } else {
    next = {
      ...contract,
      status: CONTRACT_STATUS.IN_PROGRESS,
      acceptorID: payload.acceptorID,
      acceptorWallet: cloneWalletRef(payload.acceptorWalletRef),
      acceptorWalletKey: payload.acceptorWalletRef.kind === "corporation"
        ? payload.acceptorWalletRef.accountKey
        : null,
      dateAccepted: payload.acceptedAt,
      collateralEscrow: contract.collateral,
      updatedAtMs: Date.now(),
    };
  }
  const writeResult = putContractRecordDurably(next);
  if (!writeResult.success) {
    return writeResult;
  }
  const removed = contractSettlementState.updateContractSettlement(
    contractID,
    () => null,
  );
  if (!removed.success) {
    return removed;
  }

  const preferredSession = options.preferredSession ||
    sessionRegistry.findSessionByCharacterID(
      payload.acceptForCorp ? 0 : payload.acceptorID,
    ) || null;
  let inventoryChanges = collectAcceptanceInventoryChanges(payload);
  if (settlement.kind === "accept-courier") {
    // A legacy acceptance in flight at startup could not be repaired while its
    // custody was changing. Retry after its settlement checkpoint is removed.
    const repaired = reconcilePublishedCourierVolume(contractID);
    if (repaired.reconciled > 0) {
      next = getContractRecord(contractID) || next;
      const updatedWrap = findItemById(next.plasticWrapItemID);
      if (updatedWrap) {
        inventoryChanges = inventoryChanges.map((change) =>
          Number(change.item && change.item.itemID) === Number(updatedWrap.itemID)
            ? { ...change, item: updatedWrap }
            : change);
      }
    }
    if (repaired.failures.length > 0 || repaired.skipped.length > 0) {
      log.warn(`[CourierVolume] Post-acceptance reconciliation for ${contractID} was not completed: ` +
        [...repaired.failures, ...repaired.skipped].map((entry) => entry.reason).join(", "));
    }
  }
  if (options.syncInventory !== false) {
    syncInventoryChangesToSession(
      preferredSession,
      inventoryChanges,
    );
  }
  if (options.notify !== false) {
    contractNotifications.notifyContractAccepted(next, preferredSession);
  }
  return { success: true, contract: cloneValue(next) };
}

async function acceptContract(contractID, session, acceptForCorp = false, options = {}) {
  const prepared = prepareContractAcceptanceRequest(
    contractID,
    session,
    acceptForCorp,
  );
  if (!prepared || prepared.success !== true) {
    if (prepared && prepared.errorMsg === "CONTRACT_OPERATION_PENDING") {
      throwContractError("Another contract operation is already pending.");
    }
    return null;
  }
  if (!prepared.data) {
    return null;
  }
  const result = await contractSettlementState.settleContractSettlement(
    prepared.data.contractID,
    { ...options, preferredSession: session },
  );
  if (result && result.rejected) {
    throwContractError(
      `Contract acceptance failed: ${result.errorMsg || "wallet rejection"}.`,
    );
  }
  return result && result.success ? result.contract : null;
}

function ensureNoPendingContractOperation(contractID) {
  if (contractSettlementState.getPendingContractSettlement(contractID)) {
    throwContractError("Another contract operation is already pending.");
  }
}

function listPackageContentItems(contract) {
  return listContainerItems(
    CONTRACT_ESCROW_OWNER_ID,
    contract.packageLocationID || contract.escrowLocationID,
    null,
  )
    .filter((item) => toPositiveInteger(item.itemID, 0) !== toPositiveInteger(contract.plasticWrapItemID, 0))
    .sort((left, right) => toPositiveInteger(left.itemID, 0) - toPositiveInteger(right.itemID, 0));
}

function transferPackageContents(contract, destinationOwnerID, destinationLocationID, destinationFlagID) {
  const changes = [];
  for (const item of listPackageContentItems(contract)) {
    const transferResult = contractItemCustody.transferItem({
      contractID: contract.contractID,
      item,
      ownerID: destinationOwnerID,
      locationID: destinationLocationID,
      flagID: destinationFlagID,
      reason: CUSTODY_REASON.CONTRACT_CONTENT_DELIVER,
      actor: destinationOwnerID,
    });
    if (!transferResult.success) {
      throwContractError(`Failed to transfer package item ${item.itemID}.`);
    }
    const transferChanges = (transferResult.data && transferResult.data.changes) || [];
    changes.push(...transferChanges);
    const movedItem = findMovedItem(
      transferChanges,
      destinationLocationID,
      item.itemID,
      item.typeID,
    );
    if (movedItem && destinationOwnerID !== toPositiveInteger(item.ownerID, 0)) {
      changes.push(...transferContainedItemsToOwner(
        contract.contractID,
        movedItem.itemID,
        destinationOwnerID,
      ));
    }
  }
  return changes;
}

function removePlasticWrap(contract) {
  const wrap = getPackageWrap(contract);
  if (!wrap) {
    return [];
  }
  const removeResult = contractItemCustody.removePlasticWrap({
    contractID: contract.contractID,
    item: wrap,
    expectedLocationID: wrap.locationID,
    actor: toPositiveInteger(contract.acceptorID || contract.issuerID, 0),
  });
  if (!removeResult.success) {
    throwContractError(`Failed to remove courier package ${wrap.itemID}.`);
  }
  return (removeResult.data && removeResult.data.changes) || [];
}

function buildTerminalItemLeg(
  contract,
  operation,
  item,
  destinationOwnerID,
  destinationLocationID,
  destinationFlagID,
  reason,
  index,
  extra = {},
) {
  const legID = `item:${index + 1}`;
  return {
    legID,
    item: cloneValue(item),
    destinationOwnerID,
    destinationLocationID,
    destinationFlagID,
    reason,
    transferKey: `contract:${contract.contractID}:${operation}:${legID}:deliver`,
    transferred: false,
    deliveredItem: null,
    changes: [],
    contentLegs: buildContractContentLegs(
      contract.contractID,
      operation,
      legID,
      item.itemID,
    ),
    ...extra,
  };
}

function buildTerminalEscrowItemLegs(
  contract,
  operation,
  destinationOwnerID,
  destinationLocationID,
  destinationFlagID,
  reason,
) {
  const sourceItems = contract.type !== CONTRACT_TYPE.COURIER
    ? (contract.items || [])
        .filter((row) => row.inCrate)
        .map((row) => ({
          row,
          item: findItemById(toPositiveInteger(row.escrowItemID || row.itemID, 0)),
        }))
    : listPackageContentItems(contract).map((item) => ({ row: null, item }));
  return sourceItems.map((entry, index) => {
    if (!entry.item) {
      throwContractError("A contract escrow item could not be found.");
    }
    return buildTerminalItemLeg(
      contract,
      operation,
      entry.item,
      destinationOwnerID,
      destinationLocationID,
      destinationFlagID,
      reason,
      index,
      entry.row
        ? { recordID: toPositiveInteger(entry.row.recordID, index + 1) }
        : {},
    );
  });
}

function prepareContractTerminalRequest(contractID, operation, session) {
  const contract = getContractRecord(contractID);
  if (!contract) {
    return { success: true, missing: true, data: null };
  }
  const normalizedOperation = String(operation || "");
  const actorCharacterID = getSessionCharacterID(session);
  const existing = contractSettlementState.getPendingContractSettlement(contractID);
  if (existing) {
    if (
      existing.payload &&
      existing.payload.operation === normalizedOperation &&
      toPositiveInteger(existing.payload.actorCharacterID, 0) === actorCharacterID
    ) {
      return { success: true, duplicate: true, data: existing };
    }
    return { success: false, errorMsg: "CONTRACT_OPERATION_PENDING" };
  }

  const payload = {
    operation: normalizedOperation,
    actorCharacterID,
    actorSide: null,
    contract: cloneValue(contract),
    completedAt: nowFileTimeString(),
    walletLegs: [],
    itemLegs: [],
    wrapLeg: null,
  };
  if (normalizedOperation === "reject") {
    if (!canRejectContract(contract, session)) {
      throwContractError("This contract is not assigned to you.");
    }
    if (
      contract.status !== CONTRACT_STATUS.OUTSTANDING ||
      isContractExpired(contract)
    ) {
      throwContractError("Only active outstanding contracts can be rejected.");
    }
    if (contract.type === CONTRACT_TYPE.AUCTION && (contract.bids || []).length) {
      throwContractError("An auction with funded bids cannot be rejected.");
    }
    payload.actorSide = "assignee";
  } else if (normalizedOperation === "complete-courier") {
    if (
      contract.type !== CONTRACT_TYPE.COURIER ||
      contract.status !== CONTRACT_STATUS.IN_PROGRESS
    ) {
      throwContractError("Only in-progress courier contracts can be completed.");
    }
    if (!isAcceptedBySession(contract, session)) {
      throwContractError("Only the contract acceptor can complete this courier contract.");
    }
    payload.actorSide = "acceptor";
    const wrap = getPackageWrap(contract);
    const acceptorOwnerID = toPositiveInteger(
      contract.acceptorWallet && contract.acceptorWallet.ownerID,
      0,
    );
    if (
      !wrap ||
      toPositiveInteger(wrap.ownerID, 0) !== acceptorOwnerID ||
      toPositiveInteger(wrap.locationID, 0) !== toPositiveInteger(contract.endStationID, 0)
    ) {
      throwContractError("The courier package must be intact at the destination.");
    }
    payload.walletLegs = [
      buildContractWalletLeg({
        legID: "complete:collateral-return",
        ref: contract.acceptorWallet,
        delta: contract.collateralEscrow,
        description: `Contract ${contractID} collateral returned`,
        contractID,
        counterpartyID: contract.issuerOwnerID,
      }),
      buildContractWalletLeg({
        legID: "complete:reward-payment",
        ref: contract.acceptorWallet,
        delta: contract.rewardEscrow,
        description: `Contract ${contractID} reward paid`,
        contractID,
        counterpartyID: contract.issuerOwnerID,
      }),
    ];
    payload.itemLegs = buildTerminalEscrowItemLegs(
      contract,
      normalizedOperation,
      contract.issuerOwnerID,
      contract.endStationID,
      getOwnerDeliveryFlag(normalizeBoolean(contract.forCorp, false), contract.startStationDivision),
      CUSTODY_REASON.CONTRACT_CONTENT_DELIVER,
    );
    payload.wrapLeg = {
      item: cloneValue(wrap),
      removeKey: `contract:${contractID}:${normalizedOperation}:wrap:remove`,
      removed: false,
      changes: [],
    };
  } else if (normalizedOperation === "fail-courier") {
    if (
      contract.type !== CONTRACT_TYPE.COURIER ||
      contract.status !== CONTRACT_STATUS.IN_PROGRESS
    ) {
      throwContractError("Only in-progress courier contracts can be failed.");
    }
    const actorIsAcceptor = isAcceptedBySessionForFailure(contract, session);
    const actorIsIssuer = isIssuedBySessionWithCorpAuthority(contract, session);
    const deadline = toFileTimeBigInt(addFileTimeDays(
      contract.dateAccepted,
      contract.numDays,
    ));
    if (!actorIsAcceptor && !(actorIsIssuer && currentFileTime() > deadline)) {
      throwContractError(
        actorIsIssuer
          ? "The issuer cannot fail this courier contract before its deadline."
          : "Only a contract party can fail this courier contract.",
      );
    }
    payload.actorSide = actorIsAcceptor ? "acceptor" : "issuer";
    const acceptorOwnerID = toPositiveInteger(
      contract.acceptorWallet && contract.acceptorWallet.ownerID,
      0,
    );
    const wrap = getPackageWrap(contract);
    const destinationLocationID = toPositiveInteger(
      wrap && wrap.locationID,
      contract.startStationID,
    );
    const destinationFlagID = toPositiveInteger(
      wrap && wrap.flagID,
      getAcceptorDeliveryFlag(false),
    );
    payload.walletLegs = [
      buildContractWalletLeg({
        legID: "fail:collateral-payment",
        ref: contract.issuerWallet,
        delta: contract.collateralEscrow,
        description: `Contract ${contractID} collateral paid to issuer`,
        contractID,
        counterpartyID: acceptorOwnerID,
      }),
      buildContractWalletLeg({
        legID: "fail:reward-refund",
        ref: contract.issuerWallet,
        delta: contract.rewardEscrow,
        description: `Contract ${contractID} reward escrow refunded`,
        contractID,
        counterpartyID: acceptorOwnerID,
      }),
    ];
    payload.itemLegs = buildTerminalEscrowItemLegs(
      contract,
      normalizedOperation,
      acceptorOwnerID,
      destinationLocationID,
      destinationFlagID,
      CUSTODY_REASON.CONTRACT_CONTENT_DELIVER,
    );
    payload.wrapLeg = wrap
      ? {
          item: cloneValue(wrap),
          removeKey: `contract:${contractID}:${normalizedOperation}:wrap:remove`,
          removed: false,
          changes: [],
        }
      : null;
  } else if (normalizedOperation === "delete") {
    if (!isIssuedBySessionWithCorpAuthority(contract, session)) {
      throwContractError("Only the issuer can delete this contract.");
    }
    if (
      contract.status !== CONTRACT_STATUS.OUTSTANDING &&
      contract.status !== CONTRACT_STATUS.REJECTED
    ) {
      throwContractUserError("ConContractNotOutstanding");
    }
    if (contract.type === CONTRACT_TYPE.AUCTION && (contract.bids || []).length) {
      throwContractError("An auction with funded bids cannot be deleted.");
    }
    payload.actorSide = "issuer";
    payload.walletLegs = [buildContractWalletLeg({
      legID: "delete:reward-refund",
      ref: contract.issuerWallet,
      delta: contract.rewardEscrow,
      description: `Contract ${contractID} reward escrow refunded`,
      contractID,
    })];
    const destinationFlagID = getOwnerDeliveryFlag(
      normalizeBoolean(contract.forCorp, false),
      contract.startStationDivision,
    );
    if (contract.type === CONTRACT_TYPE.ITEM_EXCHANGE || contract.type === CONTRACT_TYPE.AUCTION) {
      payload.itemLegs = buildTerminalEscrowItemLegs(
        contract,
        "delete-item-exchange",
        contract.issuerOwnerID,
        contract.startStationID,
        destinationFlagID,
        CUSTODY_REASON.CONTRACT_ESCROW_RETURN,
      );
    } else if (contract.type === CONTRACT_TYPE.COURIER) {
      payload.itemLegs = buildTerminalEscrowItemLegs(
        contract,
        normalizedOperation,
        contract.issuerOwnerID,
        contract.startStationID,
        destinationFlagID,
        CUSTODY_REASON.CONTRACT_CONTENT_DELIVER,
      );
      const wrap = getPackageWrap(contract);
      payload.wrapLeg = wrap
        ? {
            item: cloneValue(wrap),
            removeKey: `contract:${contractID}:${normalizedOperation}:wrap:remove`,
            removed: false,
            changes: [],
          }
        : null;
    }
  } else {
    return { success: false, errorMsg: "UNSUPPORTED_CONTRACT_TERMINAL_OPERATION" };
  }

  return contractSettlementState.prepareContractSettlement({
    contractID,
    kind: `terminal-${normalizedOperation}`,
    requestFingerprint: JSON.stringify({
      contractID,
      operation: normalizedOperation,
      actorCharacterID,
      contractUpdatedAtMs: contract.updatedAtMs,
    }),
    payload,
  });
}

async function transferContractTerminalItems(contractID) {
  let settlement = contractSettlementState.getPendingContractSettlement(contractID);
  for (const candidate of settlement.payload.itemLegs || []) {
    settlement = contractSettlementState.getPendingContractSettlement(contractID);
    const leg = settlement.payload.itemLegs.find(
      (entry) => entry.legID === candidate.legID,
    );
    if (!leg.transferred) {
      const result = contractItemCustody.transferItem({
        contractID,
        item: leg.item,
        ownerID: leg.destinationOwnerID,
        locationID: leg.destinationLocationID,
        flagID: leg.destinationFlagID,
        quantity: null,
        reason: leg.reason,
        actor: settlement.payload.actorCharacterID,
        idempotencyKey: leg.transferKey,
      });
      const failure = durableContractCustodyFailure(
        result,
        "CONTRACT_TERMINAL_ITEM_DELIVERY_FAILED",
      );
      if (failure) {
        return failure;
      }
      const deliveredItem = getCustodyResultItem(
        result,
        leg.destinationLocationID,
        leg.item,
        leg.item.typeID,
      );
      const checkpoint = contractSettlementState.updateContractSettlement(
        contractID,
        (current) => ({
          ...current,
          payload: {
            ...current.payload,
            itemLegs: current.payload.itemLegs.map((entry) =>
              entry.legID === leg.legID
                ? {
                    ...entry,
                    transferred: true,
                    deliveredItem: cloneValue(deliveredItem),
                    changes: cloneValue(result.data && result.data.changes || []),
                  }
                : entry),
          },
        }),
      );
      if (!checkpoint.success) {
        return checkpoint;
      }
    }
    const contentResult = transferAcceptanceContentLegs(
      contractID,
      "itemLegs",
      leg.legID,
      leg.destinationOwnerID,
    );
    if (!contentResult.success) {
      return contentResult;
    }
  }
  return { success: true };
}

function removeContractTerminalWrap(contractID) {
  const settlement = contractSettlementState.getPendingContractSettlement(contractID);
  const wrapLeg = settlement.payload.wrapLeg;
  if (!wrapLeg || wrapLeg.removed) {
    return { success: true };
  }
  const result = contractItemCustody.removePlasticWrap({
    contractID,
    item: wrapLeg.item,
    expectedLocationID: wrapLeg.item.locationID,
    actor: settlement.payload.actorCharacterID,
    idempotencyKey: wrapLeg.removeKey,
  });
  const failure = durableContractCustodyFailure(
    result,
    "CONTRACT_TERMINAL_WRAP_REMOVE_FAILED",
  );
  if (failure) {
    return failure;
  }
  return contractSettlementState.updateContractSettlement(
    contractID,
    (current) => ({
      ...current,
      payload: {
        ...current.payload,
        wrapLeg: {
          ...current.payload.wrapLeg,
          removed: true,
          changes: cloneValue(result.data && result.data.changes || []),
        },
      },
    }),
  );
}

function buildTerminalContractRecord(settlement) {
  const payload = settlement.payload;
  const contract = payload.contract;
  if (payload.operation === "reject") {
    return {
      ...contract,
      status: CONTRACT_STATUS.REJECTED,
      dateCompleted: payload.completedAt,
      updatedAtMs: Date.now(),
    };
  }
  if (payload.operation === "complete-courier") {
    return {
      ...contract,
      status: CONTRACT_STATUS.FINISHED,
      dateCompleted: payload.completedAt,
      collateralEscrow: 0,
      rewardEscrow: 0,
      collateralCredited: true,
      rewardPaid: contract.rewardEscrow > 0,
      updatedAtMs: Date.now(),
    };
  }
  if (payload.operation === "fail-courier") {
    return {
      ...contract,
      status: CONTRACT_STATUS.FAILED,
      dateCompleted: payload.completedAt,
      collateralEscrow: 0,
      rewardEscrow: 0,
      collateralCredited: true,
      updatedAtMs: Date.now(),
    };
  }
  const deliveredByRecordID = new Map(
    (payload.itemLegs || [])
      .filter((leg) => leg.recordID)
      .map((leg) => [leg.recordID, leg]),
  );
  return {
    ...contract,
    status: CONTRACT_STATUS.DELETED,
    dateCompleted: contract.dateCompleted && contract.dateCompleted !== "0"
      ? contract.dateCompleted
      : payload.completedAt,
    rewardEscrow: 0,
    items: (contract.items || []).map((row) => {
      const leg = deliveredByRecordID.get(toPositiveInteger(row.recordID, 0));
      return leg && leg.deliveredItem
        ? {
            ...row,
            itemID: leg.deliveredItem.itemID,
            escrowItemID: leg.deliveredItem.itemID,
            flagID: leg.deliveredItem.flagID,
          }
        : row;
    }),
    updatedAtMs: Date.now(),
  };
}

function collectTerminalInventoryChanges(payload) {
  return [
    ...(payload.itemLegs || []).flatMap((leg) => [
      ...(leg.changes || []),
      ...(leg.contentLegs || []).flatMap((contentLeg) => contentLeg.changes || []),
    ]),
    ...(payload.wrapLeg ? payload.wrapLeg.changes || [] : []),
  ];
}

async function settleContractTerminalOperation(contractID, options = {}) {
  let settlement = contractSettlementState.getPendingContractSettlement(contractID);
  if (!settlement) {
    return {
      success: true,
      alreadySettled: true,
      contract: getContractRecord(contractID),
    };
  }
  const walletResult = await applyContractWalletLegs(contractID);
  if (!walletResult.success) {
    return walletResult;
  }
  const itemResult = await transferContractTerminalItems(contractID);
  if (!itemResult.success) {
    return itemResult;
  }
  const wrapResult = removeContractTerminalWrap(contractID);
  if (!wrapResult.success) {
    return wrapResult;
  }
  settlement = contractSettlementState.getPendingContractSettlement(contractID);
  const next = buildTerminalContractRecord(settlement);
  const writeResult = putContractRecordDurably(next);
  if (!writeResult.success) {
    return writeResult;
  }
  const payload = settlement.payload;
  const removed = contractSettlementState.updateContractSettlement(
    contractID,
    () => null,
  );
  if (!removed.success) {
    return removed;
  }
  const preferredSession = options.preferredSession ||
    sessionRegistry.findSessionByCharacterID(payload.actorCharacterID) || null;
  if (options.syncInventory !== false) {
    syncInventoryChangesToSession(
      preferredSession,
      collectTerminalInventoryChanges(payload),
    );
  }
  if (options.notify !== false) {
    if (payload.operation === "reject") {
      contractNotifications.notifyContractRejected(next, preferredSession);
    } else if (payload.operation === "complete-courier") {
      contractNotifications.notifyContractCompleted(next, preferredSession);
    } else if (payload.operation === "fail-courier") {
      contractNotifications.notifyContractFailed(
        next,
        payload.actorSide,
        preferredSession,
      );
    }
  }
  return { success: true, contract: cloneValue(next) };
}

async function completeContract(contractID, targetStatus, session, options = {}) {
  const normalizedStatus = toInteger(targetStatus, CONTRACT_STATUS.FINISHED);
  let operation = null;
  if (normalizedStatus === CONTRACT_STATUS.REJECTED) {
    operation = "reject";
  } else if (normalizedStatus === CONTRACT_STATUS.FINISHED) {
    operation = "complete-courier";
  } else if (normalizedStatus === CONTRACT_STATUS.FAILED) {
    operation = "fail-courier";
  } else {
    return false;
  }
  const prepared = prepareContractTerminalRequest(contractID, operation, session);
  if (!prepared || prepared.success !== true) {
    if (prepared && prepared.errorMsg === "CONTRACT_OPERATION_PENDING") {
      throwContractError("Another contract operation is already pending.");
    }
    return false;
  }
  if (!prepared.data) {
    return false;
  }
  const result = await contractSettlementState.settleContractSettlement(
    contractID,
    { ...options, preferredSession: session },
  );
  return Boolean(result && result.success);
}

async function deleteContract(contractID, session, options = {}) {
  const prepared = prepareContractTerminalRequest(contractID, "delete", session);
  if (!prepared || prepared.success !== true) {
    if (prepared && prepared.errorMsg === "CONTRACT_OPERATION_PENDING") {
      throwContractError("Another contract operation is already pending.");
    }
    return false;
  }
  if (!prepared.data) {
    return false;
  }
  const result = await contractSettlementState.settleContractSettlement(
    contractID,
    { ...options, preferredSession: session },
  );
  return Boolean(result && result.success);
}

async function deleteMultipleContracts(contractIDs, session, options = {}) {
  const deleted = [];
  const failed = [];
  const ids = Array.isArray(contractIDs) ? contractIDs : [];
  for (const contractID of ids) {
    try {
      if (await deleteContract(contractID, session, options)) {
        deleted.push(toPositiveInteger(contractID, 0));
      } else {
        failed.push(toPositiveInteger(contractID, 0));
      }
    } catch (error) {
      failed.push(toPositiveInteger(contractID, 0));
    }
  }
  return { deleted, failed };
}

function getCourierContractFromItemID(itemID, session = null) {
  const normalizedItemID = toPositiveInteger(itemID, 0);
  if (!normalizedItemID) {
    return null;
  }
  const contract = listContractRecords().find((record) => (
    record.type === CONTRACT_TYPE.COURIER &&
    record.status === CONTRACT_STATUS.IN_PROGRESS &&
    toPositiveInteger(record.plasticWrapItemID, 0) === normalizedItemID
  ));
  if (!contract) {
    return null;
  }
  if (session && contract.acceptorID) {
    const allowed = contract.acceptorID === getSessionCharacterID(session) ||
      contract.acceptorID === getSessionCorporationID(session);
    if (!allowed) {
      return null;
    }
  }
  return cloneValue(contract);
}

function contractMatchesOwner(contract, ownerID) {
  const normalizedOwnerID = toPositiveInteger(ownerID, 0);
  return Boolean(
    normalizedOwnerID &&
    (
      toPositiveInteger(contract.issuerID, 0) === normalizedOwnerID ||
      toPositiveInteger(contract.issuerCorpID, 0) === normalizedOwnerID ||
      toPositiveInteger(contract.acceptorID, 0) === normalizedOwnerID ||
      toPositiveInteger(contract.assigneeID, 0) === normalizedOwnerID ||
      (contract.type === CONTRACT_TYPE.AUCTION && toPositiveInteger(contract.bids?.[0]?.bidderID, 0) === normalizedOwnerID)
    ),
  );
}

function filterContractsForOwner(ownerID, options = {}) {
  const status = toInteger(options.status, null);
  const contractType = toInteger(options.contractType, 0);
  const includeCombinedItemSearch = contractType === 10 || contractType === 11 || contractType === 0;

  return listContractRecords()
    .filter((contract) => !options.session || canViewContract(contract, options.session))
    .filter((contract) => contractMatchesOwner(contract, ownerID))
    .filter((contract) => {
      if (status === null) {
        return true;
      }
      if (status === CONTRACT_STATUS.REQUIRES_ATTENTION) {
        if (contract.type === CONTRACT_TYPE.AUCTION) {
          const requestedOwnerID = toPositiveInteger(ownerID, 0);
          const issuerOwnerID = toPositiveInteger(contract.forCorp ? contract.issuerCorpID : contract.issuerID, 0);
          const winner = contract.bids?.[0];
          return contractNeedsAttention(contract) && (
            (!contract.auctionIssuerClaimed && issuerOwnerID === requestedOwnerID) ||
            (!contract.auctionWinnerClaimed && toPositiveInteger(winner?.bidderID, 0) === requestedOwnerID)
          );
        }
        return (
        isContractExpired(contract) ||
        contract.status === CONTRACT_STATUS.REJECTED ||
        contract.status === CONTRACT_STATUS.FAILED
        );
      }
      return contract.status === status;
    })
    .filter((contract) => (
      includeCombinedItemSearch ||
      contract.type === contractType
    ))
    .sort((left, right) => toPositiveInteger(right.contractID, 0) - toPositiveInteger(left.contractID, 0));
}

function filterMyCurrentContracts(session, isAccepted = false, forCorp = false) {
  const ownerID = forCorp ? getSessionCorporationID(session) : getSessionCharacterID(session);
  return listContractRecords()
    .filter((contract) => canViewContract(contract, session))
    .filter((contract) => {
      if (isAccepted) {
        return toPositiveInteger(contract.acceptorID, 0) === ownerID;
      }
      return forCorp
        ? normalizeBoolean(contract.forCorp, false) && toPositiveInteger(contract.issuerCorpID, 0) === ownerID
        : toPositiveInteger(contract.issuerID, 0) === ownerID;
    })
    .filter((contract) => (
      contract.status === CONTRACT_STATUS.OUTSTANDING ||
      contract.status === CONTRACT_STATUS.IN_PROGRESS
    ))
    .sort((left, right) => toPositiveInteger(right.contractID, 0) - toPositiveInteger(left.contractID, 0));
}

function filterExpiredContracts(session, forCorp = false) {
  return listContractRecords()
    .filter((contract) => contractNeedsAttention(contract))
    .filter((contract) => getContractAttentionScopes(contract, session).includes(Boolean(forCorp)))
    .sort((left, right) => toPositiveInteger(right.contractID, 0) - toPositiveInteger(left.contractID, 0));
}

function isContractVisibleInSearch(contract, session, availabilityFilter = null) {
  if (!canViewContract(contract, session) || contract.status !== CONTRACT_STATUS.OUTSTANDING || isContractExpired(contract)) {
    return false;
  }
  const availability = toInteger(availabilityFilter, CONTRACT_AVAILABILITY.PUBLIC);
  if (availabilityFilter === null || availabilityFilter === undefined) {
    return contract.availability === CONTRACT_AVAILABILITY.PUBLIC || canAcceptContract(contract, session);
  }
  if (availability === CONTRACT_AVAILABILITY.PUBLIC) {
    return contract.availability === CONTRACT_AVAILABILITY.PUBLIC;
  }
  if (availability === CONTRACT_AVAILABILITY.MYSELF) {
    return contractMatchesOwner(contract, getSessionCharacterID(session));
  }
  if (availability === CONTRACT_AVAILABILITY.MY_CORP) {
    return contractMatchesOwner(contract, getSessionCorporationID(session));
  }
  if (availability === CONTRACT_AVAILABILITY.MY_ALLIANCE) {
    return toPositiveInteger(contract.assigneeID, 0) === getSessionAllianceID(session);
  }
  return false;
}

function normalizeNumericSet(rawValue, options = {}) {
  const unwrapped = unwrapMarshalValue(rawValue);
  if (unwrapped === null || unwrapped === undefined || unwrapped === false || unwrapped === "") {
    return new Set();
  }
  const allowZero = Boolean(options.allowZero);
  const values = Array.isArray(unwrapped)
    ? unwrapped
    : unwrapped && typeof unwrapped === "object"
      ? Object.values(unwrapped)
      : [unwrapped];
  return new Set(
    values
      .map((value) => allowZero ? toInteger(value, Number.NaN) : toPositiveInteger(value, 0))
      .filter((value) => Number.isFinite(value) && (allowZero ? value >= 0 : value > 0)),
  );
}

function normalizeItemTypeSet(rawValue) {
  const pairs = normalizePairList(rawValue)
    .map(([typeID]) => typeID)
    .filter((typeID) => typeID > 0);
  if (pairs.length > 0) {
    return new Set(pairs);
  }
  return normalizeNumericSet(rawValue);
}

function getContractStationID(contract, endpoint = "start") {
  return toPositiveInteger(
    endpoint === "end" ? contract && contract.endStationID : contract && contract.startStationID,
    0,
  );
}

function getContractSolarSystemID(contract, endpoint = "start") {
  const direct = toPositiveInteger(
    endpoint === "end" ? contract && contract.endSolarSystemID : contract && contract.startSolarSystemID,
    0,
  );
  if (direct > 0) {
    return direct;
  }
  const stationID = getContractStationID(contract, endpoint);
  const station = stationID > 0 ? worldData.getStationByID(stationID) : null;
  const structure = stationID > 0 && !station ? worldData.getStructureByID(stationID) : null;
  return toPositiveInteger(
    (station && station.solarSystemID) || (structure && structure.solarSystemID),
    0,
  );
}

function getContractRegionID(contract, endpoint = "start") {
  const direct = toPositiveInteger(
    endpoint === "end" ? contract && contract.endRegionID : contract && contract.startRegionID,
    0,
  );
  if (direct > 0) {
    return direct;
  }
  const system = worldData.getSolarSystemByID(getContractSolarSystemID(contract, endpoint));
  return toPositiveInteger(system && system.regionID, 0);
}

function getContractConstellationID(contract, endpoint = "start") {
  const direct = toPositiveInteger(
    endpoint === "end" ? contract && contract.endConstellationID : contract && contract.startConstellationID,
    0,
  );
  if (direct > 0) {
    return direct;
  }
  const system = worldData.getSolarSystemByID(getContractSolarSystemID(contract, endpoint));
  return toPositiveInteger(system && system.constellationID, 0);
}

function resolveLocationScope(locationID) {
  const normalizedLocationID = toPositiveInteger(locationID, 0);
  if (!normalizedLocationID) {
    return { kind: "none", locationID: 0 };
  }
  if (
    worldData.getStationByID(normalizedLocationID) ||
    worldData.getStructureByID(normalizedLocationID)
  ) {
    return { kind: "station", locationID: normalizedLocationID };
  }
  if (
    (normalizedLocationID >= 30000000 && normalizedLocationID < 40000000) ||
    worldData.getSolarSystemByID(normalizedLocationID)
  ) {
    return { kind: "system", locationID: normalizedLocationID };
  }
  if (normalizedLocationID >= 20000000 && normalizedLocationID < 30000000) {
    return { kind: "constellation", locationID: normalizedLocationID };
  }
  if (normalizedLocationID >= 10000000 && normalizedLocationID < 20000000) {
    return { kind: "region", locationID: normalizedLocationID };
  }
  return { kind: "station", locationID: normalizedLocationID };
}

function contractMatchesLocation(contract, locationID, endpoint = "start") {
  const scope = resolveLocationScope(locationID);
  if (!scope.locationID) {
    return true;
  }
  if (scope.kind === "station") {
    return getContractStationID(contract, endpoint) === scope.locationID;
  }
  if (scope.kind === "system") {
    return getContractSolarSystemID(contract, endpoint) === scope.locationID;
  }
  if (scope.kind === "constellation") {
    return getContractConstellationID(contract, endpoint) === scope.locationID;
  }
  if (scope.kind === "region") {
    return getContractRegionID(contract, endpoint) === scope.locationID;
  }
  return false;
}

function getContractSearchItems(contract) {
  return [
    ...((contract && Array.isArray(contract.items)) ? contract.items : []),
    ...((contract && Array.isArray(contract.packageItems)) ? contract.packageItems : []),
  ];
}

function getContractOfferedItems(contract) {
  return getContractSearchItems(contract).filter((item) => (
    !Object.prototype.hasOwnProperty.call(item, "inCrate") ||
    normalizeBoolean(item.inCrate, true)
  ));
}

function contractHasRequestedItems(contract) {
  return (contract && Array.isArray(contract.items) ? contract.items : [])
    .some((item) => !normalizeBoolean(item && item.inCrate, false));
}

function contractMatchesItemFilters(contract, filters, itemTypes) {
  const items = getContractSearchItems(contract);
  if (itemTypes.size > 0 && !items.some((item) => itemTypes.has(toPositiveInteger(item && item.itemTypeID, 0)))) {
    return false;
  }

  const itemCategoryID = toPositiveInteger(filters.itemCategoryID, 0);
  if (
    itemCategoryID > 0 &&
    !items.some((item) => toPositiveInteger(getItemMetadata(item && item.itemTypeID).categoryID, 0) === itemCategoryID)
  ) {
    return false;
  }

  const itemGroupID = toPositiveInteger(filters.itemGroupID, 0);
  if (
    itemGroupID > 0 &&
    !items.some((item) => toPositiveInteger(getItemMetadata(item && item.itemTypeID).groupID, 0) === itemGroupID)
  ) {
    return false;
  }

  const itemTypeName = normalizeText(filters.itemTypeName, "").trim().toLowerCase();
  if (
    itemTypeName &&
    !items.some((item) => normalizeText(getItemMetadata(item && item.itemTypeID).name, "").toLowerCase().includes(itemTypeName))
  ) {
    return false;
  }

  const searchHint = toInteger(filters.searchHint, 0);
  if (searchHint === CONTRACT_SEARCH_HINT.BPO || searchHint === CONTRACT_SEARCH_HINT.BPC) {
    const wantsCopy = searchHint === CONTRACT_SEARCH_HINT.BPC;
    return items.some((item) => (
      toPositiveInteger(getItemMetadata(item && item.itemTypeID).categoryID, 0) === 9 &&
      normalizeBoolean(item && item.copy, false) === wantsCopy
    ));
  }

  return true;
}

function hasFilterValue(value) {
  return value !== null && value !== undefined && value !== false && value !== "";
}

function contractMatchesRange(value, minValue, maxValue, normalizer) {
  const normalizedValue = normalizer(value, 0);
  if (hasFilterValue(minValue) && normalizedValue < normalizer(minValue, 0)) {
    return false;
  }
  if (hasFilterValue(maxValue) && normalizedValue > normalizer(maxValue, Number.MAX_SAFE_INTEGER)) {
    return false;
  }
  return true;
}

function securityClassFromLevel(level) {
  const security = Number(level);
  if (!Number.isFinite(security)) {
    return null;
  }
  if (security <= 0.0) {
    return SECURITY_CLASS.ZERO_SEC;
  }
  if (security < 0.45) {
    return SECURITY_CLASS.LOW_SEC;
  }
  if (security < 0.95) {
    return SECURITY_CLASS.HIGH_SEC;
  }
  return SECURITY_CLASS.SAFE_SEC;
}

function getSolarSystemSecurityClass(solarSystemID) {
  const system = worldData.getSolarSystemByID(solarSystemID);
  return system ? securityClassFromLevel(system.security ?? system.securityStatus) : null;
}

function contractMatchesSecurityClasses(contract, securityClasses) {
  if (securityClasses.size <= 0) {
    return true;
  }
  const startSecurityClass = getSolarSystemSecurityClass(getContractSolarSystemID(contract, "start"));
  return startSecurityClass !== null && securityClasses.has(startSecurityClass);
}

function contractMatchesDescription(contract, description) {
  const needle = normalizeText(description, "").trim().toLowerCase();
  if (!needle) {
    return true;
  }
  const haystack = [
    contract && contract.title,
    contract && contract.description,
  ].map((value) => normalizeText(value, "").toLowerCase()).join("\n");
  return haystack.includes(needle);
}

function contractMatchesType(contract, contractType) {
  if (!contractType || contractType === 11) {
    return true;
  }
  if (contractType === 10) {
    return contract.type === CONTRACT_TYPE.ITEM_EXCHANGE ||
      contract.type === CONTRACT_TYPE.AUCTION;
  }
  return contract.type === contractType;
}

function compareSearchValues(leftValue, rightValue) {
  if (typeof leftValue === "bigint" || typeof rightValue === "bigint") {
    const leftBigInt = typeof leftValue === "bigint" ? leftValue : BigInt(toInteger(leftValue, 0));
    const rightBigInt = typeof rightValue === "bigint" ? rightValue : BigInt(toInteger(rightValue, 0));
    return leftBigInt < rightBigInt ? -1 : leftBigInt > rightBigInt ? 1 : 0;
  }
  const leftNumber = Number(leftValue);
  const rightNumber = Number(rightValue);
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
    return leftNumber - rightNumber;
  }
  return normalizeText(leftValue, "").localeCompare(normalizeText(rightValue, ""));
}

function getSearchSortValue(contract, sortBy) {
  switch (sortBy) {
    case CONTRACT_SEARCH_SORT.PRICE:
      return normalizeMoney(contract && contract.price, 0);
    case CONTRACT_SEARCH_SORT.EXPIRED:
      return toFileTimeBigInt(contract && contract.dateExpired);
    case CONTRACT_SEARCH_SORT.STATION_ID:
      return getContractStationID(contract, "start");
    case CONTRACT_SEARCH_SORT.SOLARSYSTEM_ID:
      return getContractSolarSystemID(contract, "start");
    case CONTRACT_SEARCH_SORT.REGION_ID:
      return getContractRegionID(contract, "start");
    case CONTRACT_SEARCH_SORT.CONSTELLATION_ID:
      return getContractConstellationID(contract, "start");
    case CONTRACT_SEARCH_SORT.CONTRACT_TYPE:
      return toPositiveInteger(contract && contract.type, 0);
    case CONTRACT_SEARCH_SORT.REWARD:
      return normalizeMoney(contract && contract.reward, 0);
    case CONTRACT_SEARCH_SORT.COLLATERAL:
      return normalizeMoney(contract && contract.collateral, 0);
    case CONTRACT_SEARCH_SORT.VOLUME:
      return normalizeNumber(contract && contract.volume, 0);
    case CONTRACT_SEARCH_SORT.ASSIGNEE_ID:
      return toPositiveInteger(contract && contract.assigneeID, 0);
    case CONTRACT_SEARCH_SORT.ID:
    default:
      return toPositiveInteger(contract && contract.contractID, 0);
  }
}

function sortSearchContracts(contracts, filters = {}) {
  const hasExplicitSort = hasFilterValue(filters.sortBy) || hasFilterValue(filters.sortDir);
  const sortBy = hasFilterValue(filters.sortBy)
    ? toInteger(filters.sortBy, CONTRACT_SEARCH_SORT.ID)
    : CONTRACT_SEARCH_SORT.ID;
  const descending = hasExplicitSort
    ? toInteger(filters.sortDir, 0) !== 0
    : true;

  contracts.sort((left, right) => {
    let comparison = compareSearchValues(
      getSearchSortValue(left, sortBy),
      getSearchSortValue(right, sortBy),
    );
    if (descending) {
      comparison *= -1;
    }
    if (comparison !== 0) {
      return comparison;
    }
    return toPositiveInteger(right && right.contractID, 0) -
      toPositiveInteger(left && left.contractID, 0);
  });
}

function searchContracts(session, filters = {}) {
  const startedAt = Date.now();
  const contractType = toInteger(filters.contractType, 0);
  const itemTypes = normalizeItemTypeSet(filters.itemTypes);
  const securityClasses = normalizeNumericSet(filters.securityClasses, { allowZero: true });
  const startNum = Math.max(0, toInteger(filters.startNum, 0));

  let contracts = listContractRecords()
    .filter((contract) => isContractVisibleInSearch(contract, session, filters.availability))
    .filter((contract) => contractMatchesType(contract, contractType))
    .filter((contract) => contractMatchesLocation(contract, filters.locationID, "start"))
    .filter((contract) => contractMatchesLocation(contract, filters.endLocationID, "end"))
    .filter((contract) => !filters.issuerID || (
      contract.issuerID === toPositiveInteger(filters.issuerID, 0) ||
      contract.issuerCorpID === toPositiveInteger(filters.issuerID, 0)
    ))
    .filter((contract) => contractMatchesRange(contract.price, filters.minPrice, filters.maxPrice, normalizeMoney))
    .filter((contract) => contractMatchesRange(contract.reward, filters.minReward, filters.maxReward, normalizeMoney))
    .filter((contract) => contractMatchesRange(contract.collateral, filters.minCollateral, filters.maxCollateral, normalizeMoney))
    .filter((contract) => contractMatchesRange(contract.volume, filters.minVolume, filters.maxVolume, normalizeNumber))
    .filter((contract) => !normalizeBoolean(filters.excludeTrade, false) || !contractHasRequestedItems(contract))
    .filter((contract) => !normalizeBoolean(filters.excludeMultiple, false) || getContractOfferedItems(contract).length <= 1)
    .filter((contract) => !normalizeBoolean(filters.excludeNoBuyout, false) || contract.type !== CONTRACT_TYPE.AUCTION || normalizeMoney(contract.collateral, 0) > 0)
    .filter((contract) => contractMatchesDescription(contract, filters.description))
    .filter((contract) => contractMatchesSecurityClasses(contract, securityClasses))
    .filter((contract) => contractMatchesItemFilters(contract, filters, itemTypes));

  sortSearchContracts(contracts, filters);
  const numFound = contracts.length;
  return {
    contracts: contracts.slice(startNum, startNum + CONTRACTS_PER_PAGE),
    numFound,
    searchTime: Math.max(0, Date.now() - startedAt) * (SECOND_FILETIME_TICKS / 1000),
  };
}

function contractNeedsAttention(contract, now = currentFileTime()) {
  if (contract && contract.type === CONTRACT_TYPE.AUCTION) {
    return [CONTRACT_STATUS.OUTSTANDING, CONTRACT_STATUS.FINISHED_ISSUER, CONTRACT_STATUS.FINISHED_CONTRACTOR].includes(contract.status) &&
      (contract.auctionEnded || isContractExpired(contract, now)) &&
      !(contract.auctionIssuerClaimed && contract.auctionWinnerClaimed);
  }
  return Boolean(
    contract &&
    (
      contract.status === CONTRACT_STATUS.REJECTED ||
      contract.status === CONTRACT_STATUS.FAILED ||
      (
        contract.status === CONTRACT_STATUS.OUTSTANDING &&
        isContractExpired(contract, now)
      )
    )
  );
}

function getContractAttentionScopes(contract, session) {
  if (!contract || !session) {
    return [];
  }
  const characterID = getSessionCharacterID(session);
  const corporationID = getSessionCorporationID(session);
  const isCorporationIssued = normalizeBoolean(contract.forCorp, false);
  if (contract.type === CONTRACT_TYPE.AUCTION) {
    const winner = (contract.bids || [])[0];
    const scopes = new Set();
    if (!contract.auctionIssuerClaimed && (isCorporationIssued ? contract.issuerCorpID === corporationID : contract.issuerID === characterID)) scopes.add(isCorporationIssued);
    if (winner && !contract.auctionWinnerClaimed && (winner.forCorp ? winner.bidderID === corporationID : winner.bidderID === characterID)) scopes.add(Boolean(winner.forCorp));
    return [...scopes];
  }
  const personal = (
    (!isCorporationIssued && contract.issuerID === characterID) ||
    contract.acceptorID === characterID
  );
  const corporation = corporationID > 0 && (
    (isCorporationIssued && contract.issuerCorpID === corporationID) ||
    contract.acceptorID === corporationID
  );
  return [
    ...(personal ? [false] : []),
    ...(corporation ? [true] : []),
  ];
}

function collectMyPageInfo(session) {
  const characterID = getSessionCharacterID(session);
  const corporationID = getSessionCorporationID(session);
  const allianceID = getSessionAllianceID(session);
  const now = currentFileTime();
  const outstandingContracts = [];
  let nonCorp = 0;
  let corp = 0;
  let inProgress = 0;
  let inProgressCorp = 0;
  let biddingOn = 0;
  let biddingOnCorp = 0;
  let requiresAttention = 0;
  let requiresAttentionCorp = 0;

  for (const contract of listContractRecords()) {
    const isCorpContract = normalizeBoolean(contract.forCorp, false);
    const isPersonalIssuer = contract.issuerID === characterID && !isCorpContract;
    const isCorpIssuer = isCorpContract && contract.issuerCorpID === corporationID;
    const isPersonalAcceptor = contract.acceptorID === characterID;
    const isCorpAcceptor = contract.acceptorID === corporationID;
    const isAssignedToCharacter = contract.assigneeID === characterID;
    const isAssignedToCorpOrAlliance = contract.assigneeID === corporationID ||
      (allianceID > 0 && contract.assigneeID === allianceID);
    const needsAttention = contractNeedsAttention(contract, now);
    if (contract.type === CONTRACT_TYPE.AUCTION && contract.status === CONTRACT_STATUS.OUTSTANDING &&
        !contract.auctionEnded && toFileTimeBigInt(contract.dateExpired) > now) {
      if ((contract.bids || []).some(bid => bid.bidderID === characterID && !bid.forCorp)) biddingOn++;
      if ((contract.bids || []).some(bid => bid.bidderID === corporationID && bid.forCorp)) biddingOnCorp++;
    }

    if (contract.status === CONTRACT_STATUS.OUTSTANDING) {
      if (isPersonalIssuer) {
        nonCorp += 1;
      }
      if (isCorpIssuer) {
        corp += 1;
      }
      if (
        (isAssignedToCharacter || isAssignedToCorpOrAlliance) &&
        !isContractExpired(contract, now)
      ) {
        outstandingContracts.push([
          toPositiveInteger(contract.issuerID, 0),
          toPositiveInteger(contract.issuerCorpID, 0),
          toPositiveInteger(contract.assigneeID, 0),
          toPositiveInteger(contract.type, 0),
        ]);
      }
    }

    if (contract.status === CONTRACT_STATUS.IN_PROGRESS) {
      if (isPersonalAcceptor) {
        inProgress += 1;
      }
      if (isCorpAcceptor) {
        inProgressCorp += 1;
      }
    }

    if (needsAttention) {
      const attentionScopes = getContractAttentionScopes(contract, session);
      if (attentionScopes.includes(false)) requiresAttention += 1;
      if (attentionScopes.includes(true)) requiresAttentionCorp += 1;
    }
  }

  return {
    numInProgressCorp: inProgressCorp,
    numOutstandingContractsNonCorp: nonCorp,
    numOutstandingContractsForCorp: corp,
    numOutstandingContracts: nonCorp + corp,
    numBiddingOn: biddingOn,
    numRequiresAttentionCorp: requiresAttentionCorp,
    numInProgress: inProgress,
    numBiddingOnCorp: biddingOnCorp,
    outstandingContracts,
    numRequiresAttention: requiresAttention,
    numContractsLeftCorp: 0,
  };
}

function getMyContractEscrow(session) {
  const characterID = getSessionCharacterID(session);
  const corporationID = getSessionCorporationID(session);
  const corporationVisible = sessionHasCorpContractManagerRole(session);
  let iskEscrow = 0;
  let itemsEscrow = 0;
  for (const contract of listContractRecords()) {
    const issuedByMe = (!normalizeBoolean(contract.forCorp, false) && contract.issuerID === characterID) ||
      (
        normalizeBoolean(contract.forCorp, false) &&
        contract.issuerCorpID === corporationID && corporationVisible
      );
    if (contract.type === CONTRACT_TYPE.AUCTION) {
      const active = ![CONTRACT_STATUS.DELETED, CONTRACT_STATUS.CANCELLED, CONTRACT_STATUS.FINISHED].includes(contract.status);
      const highest = (contract.bids || [])[0];
      if (active && !contract.auctionIssuerClaimed) {
        if (highest && (highest.bidderID === characterID ||
            (highest.forCorp && highest.bidderID === corporationID && corporationVisible))) {
          iskEscrow += normalizeMoney(highest.amount, 0);
        }
        if (issuedByMe && (highest || !contract.auctionEnded)) iskEscrow += normalizeMoney(contract.auctionDeposit, 0);
      }
      if (active && issuedByMe && !contract.auctionWinnerClaimed) itemsEscrow += (contract.items || []).filter(row => row.inCrate).length;
      continue;
    }
    if (!issuedByMe) {
      continue;
    }
    iskEscrow += normalizeMoney(contract.rewardEscrow, 0);
    itemsEscrow += (contract.items || []).filter((row) => row.inCrate).length +
      (contract.packageItems || []).length;
  }
  return {
    iskEscrow: Math.round(iskEscrow * 100) / 100,
    itemsEscrow,
  };
}

function buildLoginInfoRows(session) {
  const characterID = getSessionCharacterID(session);
  const corporationID = getSessionCorporationID(session);
  const allianceID = getSessionAllianceID(session);
  const needsAttention = [];
  const inProgress = [];
  const assignedToMe = [];

  for (const contract of listContractRecords()) {
    const isAcceptor = contract.acceptorID === characterID || contract.acceptorID === corporationID;
    const isAssigned = contract.assigneeID === characterID ||
      contract.assigneeID === corporationID ||
      (allianceID > 0 && contract.assigneeID === allianceID);

    if (contractNeedsAttention(contract)) {
      for (const forCorp of getContractAttentionScopes(contract, session)) {
        // The client consumes this positional value as `isForCorp`, despite
        // the legacy rowset column being named `state`.
        needsAttention.push([contract.contractID, forCorp ? 1 : 0]);
      }
    }
    if (isAcceptor && contract.status === CONTRACT_STATUS.IN_PROGRESS) {
      inProgress.push([
        contract.contractID,
        contract.startStationID,
        contract.endStationID,
        toFileTimeBigInt(addFileTimeDays(contract.dateAccepted, contract.numDays)),
      ]);
    }
    if (
      isAssigned &&
      contract.status === CONTRACT_STATUS.OUTSTANDING &&
      !isContractExpired(contract)
    ) {
      assignedToMe.push([contract.contractID, contract.issuerID]);
    }
  }

  return {
    needsAttention,
    inProgress,
    assignedToMe,
  };
}

module.exports = {
  TABLE,
  CONTRACT_TYPE,
  CONTRACT_STATUS,
  CONTRACT_AVAILABILITY,
  CONTRACT_ID_START,
  CONTRACT_ESCROW_LOCATION_BASE,
  PLASTIC_WRAP_TYPE_ID,
  DAY_FILETIME_TICKS,
  CORP_ROLE_CONTRACT_MANAGER,
  sessionHasCorpContractManagerRole,
  canAccessCorporationContractItem,
  canViewContract,
  addFileTimeDays,
  toFileTimeBigInt,
  getContractEscrowLocationID,
  normalizeContractInfo,
  listContractRecords,
  getContractRecord,
  putContractRecord,
  reconcilePublishedCourierVolumes,
  reconcilePublishedCourierVolume,
  settleContractOperation,
  createContract,
  placeBid: (...args) => getAuctionRuntime().placeBid(...args),
  finishAuction: (...args) => getAuctionClaims().finishAuction(...args),
  reconcileAuctionExpiry: (...args) => getAuctionClaims().reconcileExpiry(...args),
  expireContractByGM,
  getMyBids: (...args) => getAuctionRuntime().getMyBids(...args),
  acceptContract,
  completeContract,
  deleteContract,
  deleteMultipleContracts,
  getCourierContractFromItemID,
  filterContractsForOwner,
  filterMyCurrentContracts,
  filterExpiredContracts,
  searchContracts,
  collectMyPageInfo,
  getMyContractEscrow,
  buildLoginInfoRows,
  _testing: {
    resetForTests,
    setNowProvider(provider) { nowProvider = typeof provider === "function" ? provider : null; },
    putContractRecordDurably,
    collectContainedItems,
    transferContainedItemsToOwner,
    validateSelectedItem,
    getWalletBalance,
    adjustWalletAsync,
    prepareContractCreationRequest,
    prepareContractAcceptanceRequest,
    prepareContractTerminalRequest,
    canRejectContract,
    isAcceptedBySessionForFailure,
    isIssuedBySessionWithCorpAuthority,
  },
};
