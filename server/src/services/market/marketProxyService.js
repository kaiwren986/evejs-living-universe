"use strict";

const path = require("path");

const BaseService = require(path.join(__dirname, "../baseService"));
const database = require(path.join(__dirname, "../../gameStore"));
const log = require(path.join(__dirname, "../../utils/logger"));
const achievementRuntime = require(path.join(
  __dirname,
  "../achievement/achievementRuntime",
));
const {
  hasCorporationWalletDivisionReadAccess,
  getPersistedCorporationAuthority,
  corporationAuthorityHasRole,
} = require(path.join(__dirname, "../corporation/corporationAuthority"));
const { throwWrappedUserError, isMachoWrappedException } = require(path.join(
  __dirname,
  "../../common/machoErrors",
));
const {
  buildDict,
  buildKeyVal,
  buildList,
  buildRowset,
  buildFiletimeLong,
  normalizeBigInt,
} = require(path.join(__dirname, "../_shared/serviceHelpers"));
const { marketDaemonClient } = require(path.join(
  __dirname,
  "./marketDaemonClient",
));
const { buildCachedMethodCallResult } = require(path.join(
  __dirname,
  "../cache/objectCacheRuntime",
));
const {
  ACCOUNT_KEY,
  JOURNAL_ENTRY_TYPE,
  adjustCharacterBalanceAsync,
  appendCharacterMarketTransactionAsync,
  getCharacterMarketTransactions,
  getCharacterWallet,
} = require(path.join(__dirname, "../account/walletState"));
const {
  adjustCorporationWalletDivisionBalanceAsync,
  appendCorporationMarketTransactionAsync,
  CORPORATION_WALLET_KEY_START,
  getCorporationMarketTransactions,
  getCorporationWalletBalance,
  normalizeCorporationWalletKey,
} = require(path.join(__dirname, "../corporation/corpWalletState"));
const {
  getCorporationOfficeByInventoryID,
  getCorporationWalletDivisionTakeRole,
  CORP_ROLE_ACCOUNTANT,
} = require(path.join(__dirname, "../corporation/corporationRuntimeState"));
// Corp hangar division flags and their take roles. Imported rather than
// redeclared: these are plain corp constants that happen to live under
// industry/, and a second copy of a role bit is exactly how the two drift.
const {
  CORP_HANGAR_TAKE_ROLE_BY_FLAG,
} = require(path.join(__dirname, "../industry/industryConstants"));
// Picks rolesAtHQ/rolesAtBase/rolesAtOther for a location. Hangar take roles are
// locational, so a flat corprole check would grant access at every station.
const {
  rolesAtLocation,
} = require(path.join(__dirname, "../industry/industryAccess"));
const {
  ITEM_FLAGS,
  findItemById,
  getAllItems,
  listContainerItems,
} = require(path.join(__dirname, "../inventory/itemStore"));
const itemCustody = require(path.join(__dirname, "../inventory/itemCustody"));
const marketItemCustody = require(path.join(
  __dirname,
  "../inventory/marketItemCustody",
));
const {
  resolveItemByTypeID,
} = require(path.join(__dirname, "../inventory/itemTypeRegistry"));
const { notifyInventoryChangesToCharacter } = require(path.join(
  __dirname,
  "../raffles/raffleInventory",
));
const { fanCorporationOfficeInventoryChanges } = require(path.join(
  __dirname,
  "../inventory/corporationOfficeInventoryObservers",
));
const sessionRegistry = require(path.join(
  __dirname,
  "../chat/sessionRegistry",
));
const {
  allocateMarketSagaIDDurable,
  getEscrowRecord,
  listEscrowRecords,
  putEscrowRecord,
  putEscrowRecordDurable,
  removeEscrowRecord: removeEscrowRecordState,
  removeEscrowRecordDurable: removeEscrowRecordDurableState,
  getCrewSaleReceipt, completeCrewSaleSaga,
  getCrewPurchaseReceipt, completeCrewPurchaseSaga,
} = require(path.join(__dirname, "./marketEscrowState"));
const {
  RANGE_STATION,
  RANGE_REGION,
  getOrderJumpDistance,
  getStationConstellationID,
  getStationSolarSystemID,
  isBidOrderInRange,
  isSellOrderInRange,
} = require(path.join(__dirname, "./marketTopology"));
const {
  MARKET_MAX_ORDER_PRICE,
  computeBrokerFeeInfo,
  computeSccSurchargeInfo,
  computeSalesTaxAmount,
  getMarketContext,
  getStationDistanceFromSession,
  isAllowedBuyRange,
  isAllowedDuration,
} = require(path.join(__dirname, "./marketRules"));
const {
  getMarketRuntimeState,
  updateMarketRuntimeState,
} = require(path.join(__dirname, "./marketRuntimeState"));
const { getStationRecord } = require(path.join(
  __dirname,
  "../_shared/stationStaticData",
));
const structureState = require(path.join(
  __dirname,
  "../structure/structureState",
));
const {
  STRUCTURE_SERVICE_ID,
} = require(path.join(__dirname, "../structure/structureConstants"));
const {
  STRUCTURE_SETTING_ID,
} = require(path.join(__dirname, "../structure/structureServiceAuthority"));
const {
  getProfileSettingValueForStructure,
} = require(path.join(__dirname, "../structure/structureProfilesState"));
const {
  characterHasStructureService,
} = require(path.join(__dirname, "../structure/structurePayloads"));

const ROWSET_NAME = "eve.common.script.sys.rowset.Rowset";
const STRUCTURE_MARKET_TAX_FALLBACK_PERCENT = 1.0;
const STRUCTURE_MARKET_TAX_MAX_PERCENT = 11.5;

const ORDER_HEADER = [
  "price",
  "volRemaining",
  "typeID",
  "range",
  "orderID",
  "volEntered",
  "minVolume",
  "bid",
  "issueDate",
  "duration",
  "stationID",
  "regionID",
  "solarSystemID",
  "constellationID",
  "jumps",
];

const ORDER_ROW_DESCRIPTOR_COLUMNS = [
  ["price", 5],
  ["volRemaining", 3],
  ["typeID", 3],
  ["range", 3],
  ["orderID", 20],
  ["volEntered", 3],
  ["minVolume", 3],
  ["bid", 3],
  ["issueDate", 64],
  ["duration", 3],
  ["stationID", 3],
  ["regionID", 3],
  ["solarSystemID", 3],
  ["constellationID", 3],
  ["jumps", 3],
];

const HISTORY_HEADER = [
  "historyDate",
  "lowPrice",
  "highPrice",
  "avgPrice",
  "volume",
  "orders",
];

const OWNER_ORDER_HEADER = [
  "orderID",
  "typeID",
  "charID",
  "regionID",
  "stationID",
  "range",
  "bid",
  "price",
  "volEntered",
  "volRemaining",
  "issueDate",
  "minVolume",
  "contraband",
  "duration",
  "isCorp",
  "solarSystemID",
  "escrow",
  "constellationID",
  "keyID",
  "orderState",
  "lastStateChange",
];

let EMPTY_ORDER_ROWSET = null;
const EMPTY_OWNER_ORDER_ROWSET = buildRowset(OWNER_ORDER_HEADER, [], ROWSET_NAME);

const FILETIME_EPOCH_OFFSET = 116444736000000000n;
const PLEX_TYPE_ID = 44992;
// Matches the bit this codebase already uses for the Trader role elsewhere
// (server/src/services/corporation/corporationRuntimeState.js); re-declared
// locally rather than exported/imported, following this file's own pattern
// for the other corp-role constants it reads off session.corprole.
const CORP_ROLE_TRADER = 18014398509481984n;
const ORDER_REASON_CREATED = "Created";
const ORDER_REASON_MODIFIED = "Modified";
const ORDER_REASON_CANCELLED = "Cancelled";
const ORDER_REASON_FILLED = "Filled";
const ORDER_REASON_PARTIAL = "PartialFill";
// The client's word for an order run out: it holds OnOwnOrdersChanged's reason against 'Expiry' and no other
// (eve/client/script/ui/shared/market/buyMultiFromBase.py 559, marketbase.py 544).
const ORDER_REASON_EXPIRED = "Expiry";
const MARKET_ESCROW_LOCATION_BASE = marketItemCustody.MARKET_ESCROW_LOCATION_BASE;
// Sell escrow parks items at MARKET_ESCROW_LOCATION_BASE + orderID, and daemon
// order ids are SQLite rowids counting up from 1, so every live escrow location
// sits inside the market's own virtual-location slot. That bound is what makes a
// range scan over the items table possible (sweepStrandedMarketEscrowItems) -
// and what keeps it off the neighbouring contract, reprocessing, mission,
// planetary, industry and jump-bridge escrow slots.
const MARKET_ESCROW_LOCATION_LIMIT = marketItemCustody.MARKET_ESCROW_LOCATION_LIMIT;
// A sell escrow record is written BEFORE the items are moved into escrow, so
// that no crash window can strand items with no durable record pointing at
// them. `placing` marks the window where the record exists but the custody move
// may not have landed; it is promoted to `active` once the items are in escrow.
// Records written before this field existed are read as `active`.
const MARKET_ESCROW_STATE_PLACING = "placing";
const MARKET_ESCROW_STATE_ACTIVE = "active";
const MARKET_EXPIRY_SWEEP_THROTTLE_MS = 1_000;
const MARKET_EXPIRY_GRACE_MS = 1_000;
const MARKET_EXPIRY_DAY_MS = 24 * 60 * 60 * 1_000;
const DURABLE_EXPIRY_JOB_TYPE = "market-order.expire";
const DURABLE_FILL_RECOVERY_JOB_TYPE = "market-fill.recover";
const BROKER_RATE_EPSILON = 0.000001;
const HISTORY_ROW_DESCRIPTOR_COLUMNS = [
  ["historyDate", 64],
  ["lowPrice", 5],
  ["highPrice", 5],
  ["avgPrice", 5],
  ["volume", 20],
  ["orders", 3],
];
let marketExpiryPollPromise = null;
let lastForcedExpirySweepAt = 0;
let durableMarketScheduler = null;
const activeDurableMarketExpiryJobs = new Set();
const playerSellFillSagaPromises = new Map();
const playerBuyFillSagaPromises = new Map();
const seedMarketFillSagaPromises = new Map();
// Sell placement validates the seller's stack and only escrows it many awaits
// later. Custody refuses to escrow the same stack twice, but on its own that
// refusal arrives after the loser has already paid its broker fee and put a
// live order on the daemon's book, which then has to roll back. RPC dispatch is
// fire-and-forget per session, so a double-click really can put two placements
// for one stack in flight at once; holding the item for the whole placement
// turns the loser into a clean "try again" before it spends anything. Keyed on
// the item alone, because that is the contended resource: two different stacks -
// and two different characters - never wait on each other.
const sellPlacementItemsInFlight = new Set();

function buildRowDescriptor(columns) {
  return {
    type: "objectex1",
    header: [
      { type: "token", value: "blue.DBRowDescriptor" },
      [columns],
    ],
    list: [],
    dict: [],
  };
}

function roundIsk(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return 0;
  }
  return Math.round(numericValue * 100) / 100;
}

function floatCloseEnough(left, right, epsilon = BROKER_RATE_EPSILON) {
  return Math.abs((Number(left) || 0) - (Number(right) || 0)) <= epsilon;
}

function getNumericSessionValue(session, keys = [], fallback = 0) {
  for (const key of keys) {
    const numericValue = normalizePositiveInteger(session && session[key], 0);
    if (numericValue > 0) {
      return numericValue;
    }
  }
  return fallback;
}

function buildSignedLong(value, fallback = 0n) {
  return {
    type: "long",
    value: normalizeBigInt(value, fallback),
  };
}

function isoTimestampToFileTimeBigInt(rawValue = null) {
  if (rawValue === null || rawValue === undefined || rawValue === "") {
    return null;
  }

  const timestampMs = Date.parse(String(rawValue));
  if (!Number.isFinite(timestampMs)) {
    return null;
  }

  return BigInt(Math.trunc(timestampMs)) * 10000n + FILETIME_EPOCH_OFFSET;
}

function buildBestByTuple(price, quantity, typeID, stationID) {
  return [
    roundIsk(price),
    Number(quantity) || 0,
    Number(typeID) || 0,
    Number(stationID) || 0,
  ];
}

function buildBestByOrder(price, quantity, typeID, stationID) {
  return buildKeyVal([
    ["price", roundIsk(price)],
    ["volRemaining", Number(quantity) || 0],
    ["typeID", Number(typeID) || 0],
    ["stationID", Number(stationID) || 0],
  ]);
}

function buildSummaryDict(summaryRows = [], valueKind = "tuple") {
  const entries = [];

  for (const row of Array.isArray(summaryRows) ? summaryRows : []) {
    const bestAskPrice = Number(row && row.best_ask_price);
    const totalAskQuantity = Number(row && row.total_ask_quantity);
    const stationID = Number(row && row.best_ask_station_id);
    const typeID = Number(row && row.type_id);

    if (
      !Number.isFinite(typeID) ||
      typeID <= 0 ||
      !Number.isFinite(bestAskPrice) ||
      bestAskPrice <= 0 ||
      !Number.isFinite(totalAskQuantity) ||
      totalAskQuantity <= 0 ||
      !Number.isFinite(stationID) ||
      stationID <= 0
    ) {
      continue;
    }

    entries.push([
      typeID,
      valueKind === "bestByOrder"
        ? buildBestByOrder(bestAskPrice, totalAskQuantity, typeID, stationID)
        : buildBestByTuple(bestAskPrice, totalAskQuantity, typeID, stationID),
    ]);
  }

  return buildDict(entries);
}

// Jumps are position-dependent, so callers must scope the cached method result
// to the current solar system whenever they include this rowset.
function buildOrderRowset(rows = [], options = {}) {
  const currentStationID = normalizePositiveInteger(options.currentStationID, 0);
  const currentSolarSystemID = normalizePositiveInteger(options.currentSolarSystemID, 0);
  const rowDescriptor = buildRowDescriptor(ORDER_ROW_DESCRIPTOR_COLUMNS);
  const lines = [];

  for (const row of Array.isArray(rows) ? rows : []) {
    const issuedAt = isoTimestampToFileTimeBigInt(row && row.issued_at);
    const stationID = Number(row && row.station_id) || 0;
    const solarSystemID = Number(row && row.solar_system_id) || 0;
    const jumpDistance = currentSolarSystemID > 0
      ? getOrderJumpDistance({
          currentStationID,
          currentSolarSystemID,
          orderStationID: stationID,
          orderSolarSystemID: solarSystemID,
        })
      : 0;
    lines.push([
      roundIsk(row && row.price),
      Number(row && row.vol_remaining) || 0,
      Number(row && row.type_id) || 0,
      Number(row && row.range_value) || 0,
      buildSignedLong(row && row.order_id),
      Number(row && row.vol_entered) || 0,
      Number(row && row.min_volume) || 0,
      row && row.bid ? 1 : 0,
      buildFiletimeLong(issuedAt),
      Number(row && row.duration_days) || 0,
      stationID,
      Number(row && row.region_id) || 0,
      solarSystemID,
      Number(row && row.constellation_id) || 0,
      Math.max(0, jumpDistance),
    ]);
  }

  return {
    type: "object",
    name: ROWSET_NAME,
    args: buildDict([
      ["header", rowDescriptor],
      ["columns", buildList(ORDER_HEADER)],
      ["RowClass", { type: "token", value: "blue.DBRow" }],
      ["lines", buildList(lines)],
    ]),
  };
}

EMPTY_ORDER_ROWSET = buildOrderRowset([]);

function buildHistoryRowset(historyRows = []) {
  const rowDescriptor = buildRowDescriptor(HISTORY_ROW_DESCRIPTOR_COLUMNS);
  const lines = [];

  for (const row of Array.isArray(historyRows) ? historyRows : []) {
    lines.push([
      normalizeBigInt(isoTimestampToFileTimeBigInt(row && row.day), 0n),
      roundIsk(row && row.low_price),
      roundIsk(row && row.high_price),
      roundIsk(row && row.avg_price),
      Number(row && row.volume) || 0,
      Number(row && row.order_count) || 0,
    ]);
  }

  return {
    type: "object",
    name: ROWSET_NAME,
    args: buildDict([
      ["header", rowDescriptor],
      ["columns", buildList(HISTORY_HEADER)],
      ["RowClass", { type: "token", value: "blue.DBRow" }],
      ["lines", buildList(lines)],
    ]),
  };
}

function buildEmptyHistoryRowset() {
  return buildHistoryRowset([]);
}

function splitHistoryRows(historyRows = []) {
  const rows = Array.isArray(historyRows) ? historyRows : [];
  if (rows.length === 0) {
    return {
      oldRows: [],
      newRows: [],
    };
  }

  return {
    oldRows: rows.slice(0, Math.max(0, rows.length - 1)),
    newRows: rows.slice(-1),
  };
}

function buildHistoryPair(historyRows = []) {
  const { oldRows, newRows } = splitHistoryRows(historyRows);
  return [buildHistoryRowset(oldRows), buildHistoryRowset(newRows)];
}

function mapOwnerOrderStateCode(state) {
  switch (String(state || "").trim().toLowerCase()) {
    case "filled":
      return 1;
    case "expired":
      return 2;
    case "cancelled":
      return 3;
    default:
      return 0;
  }
}

function mapOwnerOrderRow(ownerOrder) {
  const nestedRow = ownerOrder && ownerOrder.row ? ownerOrder.row : {};
  const state = String(ownerOrder && ownerOrder.state ? ownerOrder.state : "open");
  const issueDate = isoTimestampToFileTimeBigInt(nestedRow.issued_at);
  const lastStateChangeDate = isoTimestampToFileTimeBigInt(
    ownerOrder && ownerOrder.last_state_change_at,
  );
  const stateCode = mapOwnerOrderStateCode(state);
  const isCorp = Boolean(ownerOrder && ownerOrder.is_corp);
  const ownerID = Number(ownerOrder && ownerOrder.owner_id) || 0;
  const charID = isCorp ? 0 : ownerID;
  const escrow = nestedRow.bid
    ? roundIsk((Number(nestedRow.price) || 0) * (Number(nestedRow.vol_remaining) || 0))
    : 0;

  return [
    buildSignedLong(nestedRow.order_id || ownerOrder.order_id),
    Number(nestedRow.type_id) || 0,
    charID,
    Number(nestedRow.region_id) || 0,
    Number(nestedRow.station_id) || 0,
    Number(nestedRow.range_value) || 0,
    nestedRow.bid ? 1 : 0,
    roundIsk(nestedRow.price),
    Number(nestedRow.vol_entered) || 0,
    Number(nestedRow.vol_remaining) || 0,
    buildFiletimeLong(issueDate),
    Number(nestedRow.min_volume) || 0,
    0,
    Number(nestedRow.duration_days) || 0,
    isCorp ? 1 : 0,
    Number(nestedRow.solar_system_id) || 0,
    escrow,
    Number(nestedRow.constellation_id) || 0,
    1000,
    stateCode,
    stateCode === 0 ? null : buildFiletimeLong(lastStateChangeDate || issueDate),
  ];
}

function buildOwnerOrdersRowset(ownerOrders = []) {
  const lines = [];
  for (const ownerOrder of Array.isArray(ownerOrders) ? ownerOrders : []) {
    lines.push(mapOwnerOrderRow(ownerOrder));
  }
  return {
    type: "object",
    name: ROWSET_NAME,
    args: buildDict([
      ["header", buildList(OWNER_ORDER_HEADER)],
      ["columns", buildList(OWNER_ORDER_HEADER)],
      ["RowClass", { type: "token", value: "util.Row" }],
      ["lines", buildList(lines.map((line) => buildList(line)))],
    ]),
  };
}

function buildMarketTransactionEntry(entry = {}) {
  const fields = [
    ["transactionID", normalizeInteger(entry && entry.transactionID, 0)],
    [
      "transactionDate",
      buildFiletimeLong(normalizeBigInt(entry && entry.transactionDate, 0n)),
    ],
    ["typeID", normalizePositiveInteger(entry && entry.typeID, 0)],
    ["quantity", normalizePositiveInteger(entry && entry.quantity, 0)],
    ["price", roundIsk(entry && entry.price)],
    ["stationID", normalizePositiveInteger(entry && entry.stationID, 0)],
    ["locationID", normalizePositiveInteger(entry && entry.locationID, 0)],
    ["buyerID", normalizePositiveInteger(entry && entry.buyerID, 0)],
    ["sellerID", normalizePositiveInteger(entry && entry.sellerID, 0)],
    ["clientID", normalizePositiveInteger(entry && entry.clientID, 0)],
    ["accountID", normalizePositiveInteger(entry && entry.accountID, ACCOUNT_KEY.CASH)],
    ["buyerAccountID", normalizePositiveInteger(entry && entry.buyerAccountID, ACCOUNT_KEY.CASH)],
    ["sellerAccountID", normalizePositiveInteger(entry && entry.sellerAccountID, ACCOUNT_KEY.CASH)],
    ["journalRefID", normalizeInteger(entry && entry.journalRefID, -1)],
  ];
  if (entry && (entry.keyID !== undefined || entry.accountKey !== undefined)) {
    fields.push([
      "keyID",
      normalizePositiveInteger(entry.keyID ?? entry.accountKey, ACCOUNT_KEY.CASH),
    ]);
  }
  return buildKeyVal(fields);
}

function buildMarketTransactionList(entries = []) {
  return buildList(
    ensureArray(entries).map((entry) => buildMarketTransactionEntry(entry)),
  );
}

function filterMarketTransactionsFromDate(entries = [], fromDate = null) {
  const threshold = normalizeBigInt(fromDate, 0n);
  if (threshold <= 0n) {
    return ensureArray(entries);
  }

  return ensureArray(entries).filter(
    (entry) => normalizeBigInt(entry && entry.transactionDate, 0n) >= threshold,
  );
}

function collectRequestedTypeIds(rawValue, out, depth = 0) {
  if (depth > 8 || rawValue === null || rawValue === undefined) {
    return;
  }

  if (typeof rawValue === "number" || typeof rawValue === "bigint") {
    const numericValue = Number(rawValue);
    if (Number.isInteger(numericValue) && numericValue > 0) {
      out.push(numericValue);
    }
    return;
  }

  if (typeof rawValue === "string" && rawValue.trim() !== "") {
    const numericValue = Number(rawValue);
    if (Number.isInteger(numericValue) && numericValue > 0) {
      out.push(numericValue);
    }
    return;
  }

  if (Array.isArray(rawValue)) {
    for (const value of rawValue) {
      collectRequestedTypeIds(value, out, depth + 1);
    }
    return;
  }

  if (rawValue instanceof Set) {
    for (const value of rawValue) {
      collectRequestedTypeIds(value, out, depth + 1);
    }
    return;
  }

  if (rawValue && typeof rawValue === "object") {
    if (
      (rawValue.type === "objectex1" || rawValue.type === "objectex2")
    ) {
      if (Array.isArray(rawValue.header)) {
        for (const entry of rawValue.header) {
          collectRequestedTypeIds(entry, out, depth + 1);
        }
      }
      if (Array.isArray(rawValue.list)) {
        for (const entry of rawValue.list) {
          collectRequestedTypeIds(entry, out, depth + 1);
        }
      }
      if (Array.isArray(rawValue.dict)) {
        for (const entry of rawValue.dict) {
          collectRequestedTypeIds(entry, out, depth + 1);
        }
      }
      return;
    }

    if (
      (rawValue.type === "list" || rawValue.type === "set") &&
      Array.isArray(rawValue.items)
    ) {
      for (const item of rawValue.items) {
        collectRequestedTypeIds(item, out, depth + 1);
      }
      return;
    }

    if (
      rawValue.type === "dict" &&
      Array.isArray(rawValue.entries)
    ) {
      for (const [, value] of rawValue.entries) {
        collectRequestedTypeIds(value, out, depth + 1);
      }
      return;
    }

    if (Object.prototype.hasOwnProperty.call(rawValue, "value")) {
      collectRequestedTypeIds(rawValue.value, out, depth + 1);
    }
  }
}

function extractRequestedTypeIds(rawValue) {
  const requestedTypeIds = [];
  collectRequestedTypeIds(rawValue, requestedTypeIds, 0);
  return Array.from(
    new Set(
      requestedTypeIds.filter(
        (typeID) => Number.isInteger(typeID) && Number.isFinite(typeID) && typeID > 0,
      ),
    ),
  );
}

function normalizeOrderId(value) {
  if (value && typeof value === "object" && value.type === "long") {
    return normalizeBigInt(value.value, 0n).toString();
  }
  return normalizeBigInt(value, 0n).toString();
}

function normalizeNumericValue(value, fallback = Number.NaN) {
  if (value === undefined || value === null) {
    return fallback;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : fallback;
  }

  if (typeof value === "bigint") {
    return Number(value);
  }

  if (typeof value === "string") {
    const trimmedValue = value.trim();
    if (trimmedValue === "") {
      return fallback;
    }
    const pythonLongValue = trimmedValue.match(/^(-?\d+)[lL]$/);
    const normalizedText = pythonLongValue ? pythonLongValue[1] : trimmedValue;
    const numericValue = Number(normalizedText);
    return Number.isFinite(numericValue) ? numericValue : fallback;
  }

  if (typeof value === "object") {
    if (Object.prototype.hasOwnProperty.call(value, "value")) {
      return normalizeNumericValue(value.value, fallback);
    }
  }

  return fallback;
}

function normalizeInteger(value, fallback = 0) {
  const numericValue = normalizeNumericValue(value, Number.NaN);
  if (!Number.isFinite(numericValue)) {
    return fallback;
  }
  return Math.trunc(numericValue);
}

function normalizePositiveInteger(value, fallback = 0) {
  const numericValue = normalizeNumericValue(value, Number.NaN);
  if (Number.isFinite(numericValue) && numericValue > 0) {
    return Math.trunc(numericValue);
  }
  return fallback;
}

function normalizeBoolean(value) {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized === "1" || normalized === "true" || normalized === "yes";
  }
  return Boolean(value);
}

function unwrapMarshalValue(rawValue, depth = 0) {
  if (depth > 12 || rawValue === null || rawValue === undefined) {
    return rawValue;
  }

  if (Buffer.isBuffer(rawValue)) {
    return rawValue.toString("utf8");
  }

  if (
    typeof rawValue === "string" ||
    typeof rawValue === "number" ||
    typeof rawValue === "boolean"
  ) {
    return rawValue;
  }

  if (typeof rawValue === "bigint") {
    return rawValue.toString();
  }

  if (Array.isArray(rawValue)) {
    return rawValue.map((entry) => unwrapMarshalValue(entry, depth + 1));
  }

  if (rawValue && typeof rawValue === "object") {
    switch (rawValue.type) {
      case "int":
      case "real":
      case "token":
      case "wstring":
      case "string":
        return unwrapMarshalValue(rawValue.value, depth + 1);
      case "long":
        return normalizeBigInt(rawValue.value, 0n).toString();
      case "list":
      case "tuple":
      case "set":
        return Array.isArray(rawValue.items)
          ? rawValue.items.map((entry) => unwrapMarshalValue(entry, depth + 1))
          : [];
      case "dict":
        return new Map(
          (Array.isArray(rawValue.entries) ? rawValue.entries : []).map(
            ([key, value]) => [
              unwrapMarshalValue(key, depth + 1),
              unwrapMarshalValue(value, depth + 1),
            ],
          ),
        );
      case "object":
        if (isMarshalKeyValObjectName(rawValue.name, depth + 1)) {
          const entries =
            rawValue.args &&
            rawValue.args.type === "dict" &&
            Array.isArray(rawValue.args.entries)
              ? rawValue.args.entries
              : [];
        return Object.fromEntries(
          entries.map(([key, value]) => [
            unwrapMarshalValue(key, depth + 1),
            unwrapMarshalValue(value, depth + 1),
          ]),
        );
        }
        return rawValue;
      case "objectex1":
      case "objectex2":
        if (
          Array.isArray(rawValue.header) &&
          rawValue.header.length > 0 &&
          rawValue.header[0] &&
          rawValue.header[0].type === "token" &&
          rawValue.header[0].value === "blue.DBRowDescriptor"
        ) {
          return rawValue;
        }
        return {
          header: unwrapMarshalValue(rawValue.header, depth + 1),
          list: unwrapMarshalValue(rawValue.list, depth + 1),
          dict: unwrapMarshalValue(rawValue.dict, depth + 1),
        };
      default:
        if (Object.prototype.hasOwnProperty.call(rawValue, "value")) {
          return unwrapMarshalValue(rawValue.value, depth + 1);
        }
    }

    return Object.fromEntries(
      Object.entries(rawValue).map(([key, value]) => [
        key,
        unwrapMarshalValue(value, depth + 1),
      ]),
    );
  }

  return rawValue;
}

function isMarshalKeyValObjectName(rawName, depth = 0) {
  const normalizedName = unwrapMarshalValue(rawName, depth);
  return (
    normalizedName === "util.KeyVal" ||
    normalizedName === "utillib.KeyVal" ||
    normalizedName === "KeyVal"
  );
}

function marshalListToPlainArray(rawValue) {
  const unwrapped = unwrapMarshalValue(rawValue);
  if (Array.isArray(unwrapped)) {
    return unwrapped;
  }
  return [];
}

function marshalObjectToPlainObject(rawValue) {
  if (rawValue instanceof Map) {
    return Object.fromEntries(rawValue.entries());
  }

  if (
    rawValue &&
    typeof rawValue === "object" &&
    (rawValue.type === "objectex1" || rawValue.type === "objectex2") &&
    Array.isArray(rawValue.header) &&
    rawValue.header.length >= 3 &&
    rawValue.header[2] &&
    rawValue.header[2].type === "dict" &&
    Array.isArray(rawValue.header[2].entries)
  ) {
    return Object.fromEntries(
      rawValue.header[2].entries.map(([key, value]) => [
        unwrapMarshalValue(key),
        unwrapMarshalValue(value),
      ]),
    );
  }

  const unwrapped = unwrapMarshalValue(rawValue);
  if (unwrapped instanceof Map) {
    return Object.fromEntries(unwrapped.entries());
  }

  if (unwrapped && typeof unwrapped === "object" && !Array.isArray(unwrapped)) {
    if (
      Array.isArray(unwrapped.header) &&
      unwrapped.header.length >= 3 &&
      unwrapped.header[2] instanceof Map
    ) {
      return Object.fromEntries(unwrapped.header[2].entries());
    }
    if (unwrapped.dict instanceof Map) {
      return Object.fromEntries(unwrapped.dict.entries());
    }
    return unwrapped;
  }
  return {};
}

function buildCreatedPreviousState(item, fallbackFlagID = ITEM_FLAGS.HANGAR) {
  return {
    locationID: 0,
    flagID: normalizeInteger(item && item.flagID, fallbackFlagID),
    quantity: 0,
    stacksize: 0,
    singleton: normalizeInteger(item && item.singleton, 0),
  };
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function getCharacterSessions(characterID) {
  return sessionRegistry
    .getSessions()
    .filter(
      (session) =>
        normalizePositiveInteger(session && session.characterID, 0) ===
        normalizePositiveInteger(characterID, 0),
    );
}

function buildOrderNotificationEntry(orderLike, overrides = {}) {
  const issueDate = isoTimestampToFileTimeBigInt(
    overrides.issued_at ??
      overrides.issuedAt ??
      (orderLike && orderLike.issued_at) ??
      (orderLike && orderLike.issuedAt),
  );
  const orderID =
    overrides.order_id ??
    overrides.orderId ??
    (orderLike && orderLike.order_id) ??
    (orderLike && orderLike.orderId);
  const row = orderLike && orderLike.row ? orderLike.row : orderLike || {};

  return buildKeyVal([
    ["orderID", buildSignedLong(orderID)],
    ["typeID", normalizePositiveInteger(overrides.type_id ?? row.type_id ?? row.typeID, 0)],
    ["charID", normalizePositiveInteger(
      overrides.char_id ??
        overrides.charID ??
        orderLike.owner_id ??
        orderLike.ownerId ??
        0,
      0,
    )],
    ["regionID", normalizePositiveInteger(overrides.region_id ?? row.region_id ?? row.regionID, 0)],
    ["stationID", normalizePositiveInteger(overrides.station_id ?? row.station_id ?? row.stationID, 0)],
    ["range", normalizeInteger(overrides.range_value ?? row.range_value ?? row.range ?? row.rangeValue, 0)],
    ["bid", normalizeBoolean(overrides.bid ?? row.bid) ? 1 : 0],
    ["price", roundIsk(overrides.price ?? row.price)],
    ["volEntered", normalizePositiveInteger(overrides.vol_entered ?? row.vol_entered ?? row.volEntered, 0)],
    ["volRemaining", normalizePositiveInteger(overrides.vol_remaining ?? row.vol_remaining ?? row.volRemaining, 0)],
    ["issueDate", buildFiletimeLong(issueDate)],
    ["minVolume", normalizePositiveInteger(overrides.min_volume ?? row.min_volume ?? row.minVolume, 1)],
    ["contraband", 0],
    ["duration", normalizeInteger(overrides.duration_days ?? row.duration_days ?? row.duration ?? 0, 0)],
    ["isCorp", normalizeBoolean(overrides.is_corp ?? orderLike.is_corp ?? orderLike.isCorp) ? 1 : 0],
    ["solarSystemID", normalizePositiveInteger(overrides.solar_system_id ?? row.solar_system_id ?? row.solarSystemID, 0)],
    ["escrow", roundIsk((Number(overrides.price ?? row.price) || 0) * (Number(overrides.vol_remaining ?? row.vol_remaining ?? row.volRemaining) || 0))],
  ]);
}

function notifyOwnOrdersChanged(characterID, orders = [], reason = ORDER_REASON_PARTIAL, isCorp = false) {
  const payload = buildList(
    ensureArray(orders).map((order) => buildOrderNotificationEntry(order)),
  );
  for (const session of getCharacterSessions(characterID)) {
    session.sendNotification("OnOwnOrdersChanged", "clientID", [
      payload,
      String(reason || ORDER_REASON_PARTIAL),
      isCorp ? 1 : 0,
    ]);
  }
}

function buildImmediateMarketRefreshOrder({
  characterID,
  owner = null,
  stationID,
  regionID,
  solarSystemID,
  constellationID,
  typeID,
  price,
  quantity,
  bid = false,
} = {}) {
  const normalizedQuantity = normalizePositiveInteger(quantity, 0);
  const normalizedTypeID = normalizePositiveInteger(typeID, 0);

  return {
    order_id: 0,
    owner_id: normalizePositiveInteger(
      owner && owner.isCorp ? owner.id : characterID,
      0,
    ),
    is_corp: Boolean(owner && owner.isCorp),
    state: "filled",
    row: {
      order_id: 0,
      type_id: normalizedTypeID,
      price: roundIsk(price),
      vol_entered: normalizedQuantity,
      vol_remaining: 0,
      min_volume: 1,
      bid: normalizeBoolean(bid),
      issued_at: new Date().toISOString(),
      duration_days: 0,
      range_value: normalizeBoolean(bid) ? RANGE_STATION : 32767,
      station_id: normalizePositiveInteger(stationID, 0),
      region_id: normalizePositiveInteger(regionID, 0),
      solar_system_id: normalizePositiveInteger(solarSystemID, 0),
      constellation_id: normalizePositiveInteger(constellationID, 0),
    },
  };
}

// An immediate buy order's ID: of a range of its own, apart from the daemon's (whose order IDs are near 2.26 x 10^18,
// measured 2026-10-16), and never stored (the order is made and run out within the one call). Where this run's range
// starts is taken from the clock, so that two runs do not hand a client the same ID.
let nextImmediateOrderID = 8_000_000_000_000_000 + (Date.now() % 1_000_000_000) * 1_000;

/**
 * An order made for one line of a multibuy (marketsvc.BuyMulti: BuyMultipleItems answers the orders made, and the
 * client's multibuy window keeps their IDs and waits for each one's expiry, putting back what was left unbought:
 * buyMultiFromBase._PerformTrade 296 to 311, _ProccessExpiredOrders 569 to 590). An immediate order: a duration of
 * nought, at the station, its quantity what was asked, its remainder what was not bought.
 */
function buildImmediateBuyOrder({ characterID, owner = null, stationID, regionID, typeID, price, quantity, remaining, minVolume = 1 } = {}) {
  const orderID = nextImmediateOrderID;
  nextImmediateOrderID += 1;
  return {
    order_id: orderID,
    owner_id: normalizePositiveInteger(owner && owner.isCorp ? owner.id : characterID, 0),
    is_corp: Boolean(owner && owner.isCorp),
    state: "expired",
    row: {
      order_id: orderID,
      type_id: normalizePositiveInteger(typeID, 0),
      price: roundIsk(price),
      vol_entered: normalizePositiveInteger(quantity, 0),
      vol_remaining: Math.max(0, normalizeInteger(remaining, 0)),
      min_volume: normalizePositiveInteger(minVolume, 1),
      bid: true,
      issued_at: new Date().toISOString(),
      duration_days: 0,
      range_value: RANGE_STATION,
      station_id: normalizePositiveInteger(stationID, 0),
      region_id: normalizePositiveInteger(regionID, 0),
      solar_system_id: normalizePositiveInteger(getStationSolarSystemID(stationID), 0),
      constellation_id: normalizePositiveInteger(getStationConstellationID(stationID), 0),
    },
  };
}

function notifyMarketItemReceived(characterID, item) {
  if (!item) {
    return;
  }

  for (const session of getCharacterSessions(characterID)) {
    session.sendNotification("OnMarketItemReceived", "clientID", [
      normalizePositiveInteger(item.itemID, 0),
      normalizePositiveInteger(item.typeID, 0),
      normalizeInteger(item.flagID, ITEM_FLAGS.HANGAR),
      normalizePositiveInteger(item.locationID, 0),
    ]);
  }
}

function transformVisibleBuyerChanges(changes = [], ownerID) {
  return ensureArray(changes)
    .filter((change) => change && change.item)
    .map((change) => ({
      item: change.item,
      previousData: buildCreatedPreviousState(change.item),
      ownerID: normalizePositiveInteger(ownerID, 0),
    }));
}

function computeOrderValue(price, quantity) {
  return roundIsk((Number(price) || 0) * (Number(quantity) || 0));
}

function getMarketTypeLabel(typeID) {
  const itemType = resolveItemByTypeID(typeID);
  if (itemType && itemType.name) {
    return `${itemType.name} (${normalizePositiveInteger(typeID, 0)})`;
  }

  return `type ${normalizePositiveInteger(typeID, 0)}`;
}

function getMarketCounterpartyOwnerID(stationID) {
  const structure = getStructureMarketLocation(stationID);
  if (structure) {
    return normalizePositiveInteger(
      structure.ownerCorpID || structure.ownerID,
      0,
    );
  }

  const stationRecord = getStationRecord(null, stationID);
  return normalizePositiveInteger(
    stationRecord && (stationRecord.corporationID || stationRecord.ownerID),
    0,
  );
}

function buildNativeStationMetadata(stationID) {
  const station = require("../../space/worldData").getStationByID(Number(stationID));
  // Seeded market coverage is independent of the game's installed NPC station
  // catalog. Never relay a player's supplied location metadata or structures.
  if (!station || Number(station.stationID) !== Number(stationID) || station.isStructure) return undefined;
  return {
    station_id: Number(station.stationID), solar_system_id: Number(station.solarSystemID),
    constellation_id: Number(station.constellationID), region_id: Number(station.regionID),
    station_name: String(station.stationName || ""), security: Number(station.security || 0),
  };
}

async function recordCharacterMarketTransaction(characterID, entry = {}) {
  const normalizedCharacterID = normalizePositiveInteger(characterID, 0);
  if (!normalizedCharacterID) {
    return null;
  }

  return appendCharacterMarketTransactionAsync(normalizedCharacterID, {
    accountID: ACCOUNT_KEY.CASH,
    buyerAccountID: ACCOUNT_KEY.CASH,
    sellerAccountID: ACCOUNT_KEY.CASH,
    ...entry,
  });
}

// Records a completed trade's transaction-history entry against whichever
// wallet actually paid/was paid for it - a character's own market
// transaction list, or (when walletOwner.isCorp) the owning corporation's,
// so Handle_CorpGetTransactions shows corp-wallet trades too.
async function recordMarketTransactionForWalletOwner(walletOwner, entry = {}) {
  if (walletOwner && walletOwner.isCorp) {
    return appendCorporationMarketTransactionAsync(
      walletOwner.id,
      walletOwner.accountKey,
      entry,
    );
  }
  return recordCharacterMarketTransaction(walletOwner ? walletOwner.id : 0, entry);
}

// Achievement progress belongs to the character who bought or sold the item,
// not necessarily the wallet owner: corporation-wallet orders still originate
// from one character.  Callers persist the completion marker in the market
// fill saga before clearing it, so a restart replays this safely instead of
// losing an otherwise committed fill.
function recordCompletedMarketFillAchievements(saga = {}) {
  const careerPurchase = require("../career/careerIndustrySources").recordBlueprintPurchase(saga);
  if (!careerPurchase?.success) return careerPurchase || { success: false, errorMsg: "CAREER_BLUEPRINT_PURCHASE_FAILED" };
  if (saga.achievementContributionsRecorded === true) {
    return { success: true, data: { changed: false } };
  }
  const operationKey = String(saga.operationKey || "").trim();
  if (!operationKey) {
    return { success: false, errorMsg: "INVALID_MARKET_FILL" };
  }
  const purchaseAmount = roundIsk(saga.grossCost);
  const saleAmount = roundIsk(saga.grossAmount ?? saga.grossCost);
  const results = [];
  if (normalizePositiveInteger(saga.buyerCharacterID, 0) && purchaseAmount > 0) {
    results.push(achievementRuntime.recordMarketPurchase(
      saga.buyerCharacterID,
      purchaseAmount,
      operationKey,
    ));
  }
  if (normalizePositiveInteger(saga.sellerCharacterID, 0) && saleAmount > 0) {
    results.push(achievementRuntime.recordMarketSale(
      saga.sellerCharacterID,
      saleAmount,
      operationKey,
    ));
  }
  const failure = results.find((result) => !result || result.success !== true);
  if (failure) {
    return {
      success: false,
      errorMsg: failure.errorMsg || "ACHIEVEMENT_CONTRIBUTION_FAILED",
    };
  }
  saga.achievementContributionsRecorded = true;
  return {
    success: true,
    data: { changed: results.some((result) => Boolean(result.data && result.data.changed)) },
  };
}

function buildCharacterMarketContext(session, characterID, stationID) {
  const context = getMarketContext({
    characterID,
    stationID,
    session,
  });
  const structure = getStructureMarketLocation(stationID);
  if (!structure) {
    return context;
  }

  const configuredPercent = getProfileSettingValueForStructure(
    structure,
    STRUCTURE_SETTING_ID.MARKET_TAX,
    { session },
  );
  // A tax that is not set comes back as null, and Number(null) is 0, which
  // is a tax set to nothing. structureSettings.CharacterGetService answers
  // True for it and the client reckons its rate from that answer over 100.0,
  // which is the fallback's 1%, so an unset tax is the fallback here too.
  const isTaxSet = configuredPercent !== undefined && configuredPercent !== null;
  const percentValue = Number(configuredPercent);
  const brokerFeePercent = isTaxSet && Number.isFinite(percentValue)
    ? Math.max(0, Math.min(STRUCTURE_MARKET_TAX_MAX_PERCENT, percentValue))
    : STRUCTURE_MARKET_TAX_FALLBACK_PERCENT;
  return {
    ...context,
    structureMarketOwnerID: getMarketCounterpartyOwnerID(stationID),
    structureMarketBrokerFeePercent: brokerFeePercent,
    brokerCommissionRate: brokerFeePercent / 100.0,
  };
}

async function creditStructureMarketBrokerFeeOwner(
  characterID,
  stationID,
  amount,
  description,
) {
  const normalizedAmount = roundIsk(amount);
  if (!(normalizedAmount > 0)) {
    return null;
  }

  const structure = getStructureMarketLocation(stationID);
  const ownerCorpID = normalizePositiveInteger(
    structure && (structure.ownerCorpID || structure.ownerID),
    0,
  );
  if (!ownerCorpID) {
    return null;
  }

  const creditResult = await adjustCorporationWalletDivisionBalanceAsync(
    ownerCorpID,
    CORPORATION_WALLET_KEY_START,
    normalizedAmount,
    {
      description,
      ownerID1: normalizePositiveInteger(characterID, 0),
      ownerID2: ownerCorpID,
      referenceID: normalizePositiveInteger(stationID, 0),
      entryTypeID: JOURNAL_ENTRY_TYPE.BROKERS_FEE,
    },
  );
  if (!creditResult || creditResult.success !== true) {
    log.warn(
      `[MarketProxy] Failed to credit structure broker fee ownerCorp=${ownerCorpID} structure=${stationID}: ${creditResult && creditResult.errorMsg ? creditResult.errorMsg : "UNKNOWN"}`,
    );
  }
  return creditResult;
}

function getEscrowType(record) {
  return String(record && record.escrowType ? record.escrowType : "")
    .trim()
    .toLowerCase();
}

function getEscrowState(record) {
  const escrowState = String(record && record.escrowState ? record.escrowState : "")
    .trim()
    .toLowerCase();
  return escrowState || MARKET_ESCROW_STATE_ACTIVE;
}

function upsertBuyEscrowRecord(orderLike, overrides = {}, options = {}) {
  const orderRow = getOwnerOrderResponseOrder(orderLike);
  const orderID = normalizeOrderId(overrides.order_id ?? orderRow.order_id ?? orderLike.order_id);
  const ownerId = normalizePositiveInteger(
    overrides.owner_id ?? orderLike.owner_id ?? orderLike.ownerId,
    0,
  );
  const stationId = normalizePositiveInteger(
    overrides.station_id ?? orderRow.station_id ?? orderRow.stationID,
    0,
  );
  const typeId = normalizePositiveInteger(
    overrides.type_id ?? orderRow.type_id ?? orderRow.typeID,
    0,
  );
  const price = roundIsk(overrides.price ?? orderRow.price);
  const remainingQuantity = normalizePositiveInteger(
    overrides.vol_remaining ?? orderRow.vol_remaining ?? orderRow.volRemaining,
    0,
  );
  const existingRecord = getEscrowRecord(orderID);
  const issuedAt = String(
    overrides.issued_at ?? orderRow.issued_at ?? existingRecord?.issuedAt ?? "",
  ).trim();
  const durationDays = normalizePositiveInteger(
    overrides.duration_days ?? orderRow.duration_days ?? existingRecord?.durationDays,
    0,
  );

  if (!ownerId || !stationId || !typeId || remainingQuantity <= 0) {
    return removeEscrowRecord(orderID);
  }

  // `ownerId` always stays the acting character (a buy order has no item
  // custody, but keeping the meaning consistent with the sell-escrow record
  // below matters for the shared refund path in applyTerminalOrderEvent).
  // `walletOwnerId`/`accountKey` name which wallet paid the escrow and
  // therefore gets it back on cancel/expiry - the corporation's when isCorp,
  // otherwise the same character.
  const isCorp = normalizeBoolean(
    overrides.is_corp ?? orderLike.is_corp ?? orderLike.isCorp,
  );
  const walletOwnerId = isCorp
    ? normalizePositiveInteger(
        overrides.wallet_owner_id ?? orderLike.wallet_owner_id ?? orderLike.walletOwnerId,
        ownerId,
      )
    : ownerId;
  const accountKey = isCorp
    ? normalizeCorporationWalletKey(
        overrides.account_key ?? orderLike.account_key ?? orderLike.accountKey,
      )
    : null;

  const record = {
    orderId: orderID,
    ownerId,
    isCorp,
    walletOwnerId,
    accountKey,
    escrowType: "buy",
    typeId,
    stationId,
    price,
    remainingQuantity,
    escrowAmount: computeOrderValue(price, remainingQuantity),
    issuedAt,
    durationDays,
    fillAttemptSequence: normalizePositiveInteger(
      existingRecord && existingRecord.fillAttemptSequence,
      0,
    ),
    createdAt:
      (existingRecord && existingRecord.createdAt) || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  return options.durable === true
    ? putEscrowRecordDurable(record)
    : putEscrowRecord(record);
}

function removeEscrowRecord(orderID) {
  const result = removeEscrowRecordState(orderID);
  if (!result || result.success !== false) {
    queueDurableMarketOrderExpiryCancellation(orderID);
  }
  return result;
}

function removeEscrowRecordDurable(orderID) {
  const result = removeEscrowRecordDurableState(orderID);
  if (!result || result.success !== false) {
    queueDurableMarketOrderExpiryCancellation(orderID);
  }
  return result;
}

function upsertSellEscrowRecord(record = {}, options = {}) {
  const escrowRecord = {
    ...record,
    escrowType: "sell",
  };
  return options.durable === true
    ? putEscrowRecordDurable(escrowRecord)
    : putEscrowRecord(escrowRecord);
}

function ensureValidDuration(durationDays) {
  if (!isAllowedDuration(durationDays)) {
    throwWrappedUserError("CustomInfo", {
      info: `Market order duration ${durationDays} days is not supported.`,
    });
  }
}

function ensureValidBuyRange(rangeValue, limits) {
  const normalizedRange = normalizeInteger(rangeValue, RANGE_STATION);
  if (!isAllowedBuyRange(normalizedRange)) {
    throwWrappedUserError("CustomInfo", {
      info: `Market order range ${normalizedRange} is not supported.`,
    });
  }

  if (
    normalizedRange === RANGE_REGION &&
    normalizeInteger(limits && limits.vis, RANGE_STATION) !== RANGE_REGION
  ) {
    throwWrappedUserError("CustomInfo", {
      info: "The current Visibility skill level does not allow region-wide buy orders.",
    });
  }

  if (
    normalizedRange !== RANGE_REGION &&
    normalizedRange > normalizeInteger(limits && limits.vis, RANGE_STATION)
  ) {
    throwWrappedUserError("CustomInfo", {
      info: "The current Visibility skill level does not allow that buy-order range.",
    });
  }
}

function ensureValidMinVolume(quantity, minVolume) {
  const normalizedQuantity = normalizePositiveInteger(quantity, 0);
  const normalizedMinVolume = normalizePositiveInteger(minVolume, 1);
  if (normalizedMinVolume > normalizedQuantity) {
    throwWrappedUserError("MktInvalidMinVolumeCannotExceedQuantity");
  }
}

function ensureValidPrice(price) {
  const normalizedPrice = roundIsk(price);
  if (!(normalizedPrice > 0)) {
    throwWrappedUserError("CustomInfo", {
      info: "The market order price must be greater than zero.",
    });
  }
  if (normalizedPrice > MARKET_MAX_ORDER_PRICE) {
    throwWrappedUserError("CustomInfo", {
      info: `The market order price cannot exceed ${MARKET_MAX_ORDER_PRICE.toFixed(2)} ISK.`,
    });
  }
}

function ensureOpenOrderLimit(context, openOrders = []) {
  const openOrderCount = ensureArray(openOrders).filter((order) => {
    const state = String(order && order.state ? order.state : "open").toLowerCase();
    return state === "open";
  }).length;
  const maxOrderCount = normalizePositiveInteger(
    context && context.limits && context.limits.cnt,
    0,
  );
  if (maxOrderCount > 0 && openOrderCount >= maxOrderCount) {
    throwWrappedUserError("CustomInfo", {
      info: `The character already has ${openOrderCount} active market orders, which meets the current market-order skill limit of ${maxOrderCount}.`,
    });
  }
}

function ensureRemoteBuyOrderPlacementAllowed(session, stationID, context) {
  const jumps = getStationDistanceFromSession(session, stationID);
  if (jumps > normalizeInteger(context && context.limits && context.limits.bid, RANGE_STATION)) {
    throwWrappedUserError("CustomInfo", {
      info: "The current Procurement skill level does not allow placing a buy order at that location.",
    });
  }
}

function ensureRemoteSellOrderPlacementAllowed(session, stationID, context) {
  const jumps = getStationDistanceFromSession(session, stationID);
  if (jumps > normalizeInteger(context && context.limits && context.limits.ask, RANGE_STATION)) {
    throwWrappedUserError("CustomInfo", {
      info: "The current Marketing skill level does not allow selling from that location.",
    });
  }
}

function ensureRemoteOrderModificationAllowed(session, stationID, context) {
  const jumps = getStationDistanceFromSession(session, stationID);
  if (jumps > normalizeInteger(context && context.limits && context.limits.mod, RANGE_STATION)) {
    throwWrappedUserError("CustomInfo", {
      info: "The current Daytrading skill level does not allow modifying that order from the current location.",
    });
  }
}

function validateExpectedBrokerFeePercentage(expectedBrokerFee, marketContext) {
  if (
    expectedBrokerFee === null ||
    expectedBrokerFee === undefined ||
    expectedBrokerFee === ""
  ) {
    return;
  }

  const actualBrokerFee = Number(
    marketContext && marketContext.brokerCommissionRate,
  );
  if (!Number.isFinite(actualBrokerFee)) {
    return;
  }

  const normalizedExpected = Number(expectedBrokerFee);
  if (!Number.isFinite(normalizedExpected)) {
    return;
  }

  if (floatCloseEnough(actualBrokerFee, normalizedExpected)) {
    return;
  }

  throwWrappedUserError("MktBrokersFeeUnexpected2", {
    actualBrokerFeePerc: roundIsk(actualBrokerFee * 100),
    expectedBrokerFeePercentage: normalizedExpected,
    originalBrokersFeePerc: normalizedExpected,
  });
}

function getLastProcessedOrderEventId() {
  const runtimeState = getMarketRuntimeState();
  return normalizeBigInt(
    runtimeState && (
      runtimeState.lastProcessedOrderEventId ||
      runtimeState.lastProcessedExpiryEventId
    ),
    0n,
  );
}

function setLastProcessedOrderEventId(eventId) {
  const normalizedEventId = normalizeBigInt(eventId, 0n).toString();
  return updateMarketRuntimeState({
    lastProcessedOrderEventId: normalizedEventId,
    lastProcessedExpiryEventId: normalizedEventId,
  });
}

// `characterID` here is really "the wallet key" - for a corp-wallet-backed
// market order (options.isCorp) it is a corporationID, and the balance check
// and the debit/credit below both route to that corporation's wallet
// division (options.accountKey) instead of a character's personal wallet.
// The acting character never disappears from these calls - it stays present
// as ownerID2 for the journal/ledger entry - only *which wallet pays* moves.
function ensureCharacterHasFunds(characterID, amount, description, options = {}) {
  const normalizedAmount = roundIsk(amount);
  if (options.isCorp) {
    const accountKey = normalizeCorporationWalletKey(options.accountKey);
    const balance = getCorporationWalletBalance(characterID, accountKey);
    if (balance + 0.0001 < normalizedAmount) {
      throwWrappedUserError("CustomInfo", {
        info: `${description} requires ${normalizedAmount.toFixed(2)} ISK, but the corporation wallet does not have enough funds.`,
      });
    }
    return;
  }

  const wallet = getCharacterWallet(characterID);
  if (!wallet) {
    throwWrappedUserError("CustomInfo", {
      info: "Character wallet is unavailable.",
    });
  }

  if (wallet.balance + 0.0001 < normalizedAmount) {
    throwWrappedUserError("CustomInfo", {
      info: `${description} requires ${normalizedAmount.toFixed(2)} ISK, but the character wallet does not have enough funds.`,
    });
  }
}

async function debitCharacterWallet(
  characterID,
  amount,
  description,
  ownerID2 = 0,
  options = {},
) {
  const normalizedAmount = roundIsk(Math.abs(amount));
  if (!(normalizedAmount > 0)) {
    return null;
  }

  if (options.minimumBalance === undefined) ensureCharacterHasFunds(characterID, normalizedAmount, description, options);

  if (options.isCorp) {
    const accountKey = normalizeCorporationWalletKey(options.accountKey);
    const result = await adjustCorporationWalletDivisionBalanceAsync(
      characterID,
      accountKey,
      -normalizedAmount,
      {
        description,
        ownerID1: options.ownerID1 ?? characterID,
        ownerID2: options.ownerID2 ?? ownerID2,
        referenceID: options.referenceID ?? ownerID2,
        entryTypeID: options.entryTypeID ?? JOURNAL_ENTRY_TYPE.ADMIN_ADJUSTMENT,
      },
    );
    if (!result.success) {
      throwWrappedUserError("CustomInfo", {
        info: `${description} failed: ${result.errorMsg || "wallet write error"}.`,
      });
    }
    return result;
  }

  const result = await adjustCharacterBalanceAsync(characterID, -normalizedAmount, {
    description,
    ownerID1: options.ownerID1 ?? characterID,
    ownerID2: options.ownerID2 ?? ownerID2,
    referenceID: options.referenceID ?? ownerID2,
    entryTypeID: options.entryTypeID ?? JOURNAL_ENTRY_TYPE.ADMIN_ADJUSTMENT,
    idempotencyKey: options.idempotencyKey,
      ...(options.minimumBalance !== undefined ? { minimumBalance: options.minimumBalance } : {}),
  });
  if (!result.success) {
      if (options.minimumBalance !== undefined) {
        const error = new Error(result.errorMsg || "CREW_PURCHASE_WALLET_PENDING");
        error.walletDefinitive = ["WALLET_RESERVE", "INSUFFICIENT_FUNDS", "CHARACTER_NOT_FOUND", "WALLET_RESERVE_INVALID"].includes(result.errorMsg);
        throw error;
      }
    throwWrappedUserError("CustomInfo", {
      info: `${description} failed: ${result.errorMsg || "wallet write error"}.`,
    });
  }

  return result;
}

async function creditCharacterWallet(
  characterID,
  amount,
  description,
  ownerID2 = 0,
  options = {},
) {
  const normalizedAmount = roundIsk(Math.abs(amount));
  if (!(normalizedAmount > 0)) {
    return null;
  }

  if (options.isCorp) {
    const accountKey = normalizeCorporationWalletKey(options.accountKey);
    const result = await adjustCorporationWalletDivisionBalanceAsync(
      characterID,
      accountKey,
      normalizedAmount,
      {
        description,
        ownerID1: options.ownerID1 ?? ownerID2,
        ownerID2: options.ownerID2 ?? characterID,
        referenceID: options.referenceID ?? ownerID2,
        entryTypeID: options.entryTypeID ?? JOURNAL_ENTRY_TYPE.ADMIN_ADJUSTMENT,
      },
    );
    if (!result.success) {
      throwWrappedUserError("CustomInfo", {
        info: `${description} failed: ${result.errorMsg || "wallet write error"}.`,
      });
    }
    return result;
  }

  const result = await adjustCharacterBalanceAsync(characterID, normalizedAmount, {
    description,
    ownerID1: options.ownerID1 ?? ownerID2,
    ownerID2: options.ownerID2 ?? characterID,
    referenceID: options.referenceID ?? ownerID2,
    entryTypeID: options.entryTypeID ?? JOURNAL_ENTRY_TYPE.ADMIN_ADJUSTMENT,
    idempotencyKey: options.idempotencyKey,
  });
  if (!result.success) {
    throwWrappedUserError("CustomInfo", {
      info: `${description} failed: ${result.errorMsg || "wallet write error"}.`,
    });
  }

  return result;
}

async function applySignedCharacterWalletDelta(
  characterID,
  amount,
  description,
  ownerID2 = 0,
  options = {},
) {
  const normalizedAmount = roundIsk(amount);
  if (Math.abs(normalizedAmount) <= 0) {
    return null;
  }

  if (normalizedAmount > 0) {
    return creditCharacterWallet(
      characterID,
      normalizedAmount,
      description,
      ownerID2,
      options,
    );
  }

  return debitCharacterWallet(
    characterID,
    Math.abs(normalizedAmount),
    description,
    ownerID2,
    options,
  );
}

function assertPersonalMarketOnly(useCorp = false) {
  if (normalizeBoolean(useCorp)) {
    throwWrappedUserError("CustomInfo", {
      info: "Corporation market orders are not wired into corporation wallets and hangars yet.",
    });
  }
}

function sessionHasCorpTraderRole(session) {
  return corporationAuthorityHasRole(getPersistedCorporationAuthority(session), CORP_ROLE_TRADER);
}

// Resolves which wallet a market order placement pays from. `useCorp` comes
// straight off the client request; everything else comes off the session so
// a player can't spend a corporation's wallet they don't have the Trader
// role in, or one they aren't even a member of. `accountKey` is the corp
// wallet division the character's role assignment defaults to
// (session.corpAccountKey, set at login by
// characterState.applyCharacterToSession/getCorporationSessionRoleState) -
// the same division retail EVE routes a member's corp transactions into.
function resolveMarketOrderOwner(session, useCorp) {
  const characterID = getNumericSessionValue(session, ["charid", "characterID"]);
  if (!normalizeBoolean(useCorp)) {
    return { isCorp: false, id: characterID, accountKey: null };
  }

  const corporationID = getNumericSessionValue(session, ["corpid", "corporationID"]);
  if (!corporationID) {
    throwWrappedUserError("CustomInfo", {
      info: "No corporation is active on this session.",
    });
  }
  if (!sessionHasCorpTraderRole(session)) {
    throwWrappedUserError("CustomInfo", {
      info: "The Trader role is required to place market orders against the corporation wallet.",
    });
  }

  const accountKey = normalizeCorporationWalletKey(session && session.corpAccountKey);
  const takeRole = getCorporationWalletDivisionTakeRole(accountKey);
  if (!takeRole || !corporationAuthorityHasRole(getPersistedCorporationAuthority(session), takeRole)) {
    throwWrappedUserError("CrpAccessDenied");
  }

  return {
    isCorp: true,
    id: corporationID,
    accountKey,
  };
}

/**
 * Resolve where a sell order's goods come out of, as an explicit custody pin.
 *
 * Two sources are allowed. A character's own station hangar, which is the
 * original behaviour; and a corporation hangar division, where the item row is
 * owned by the corporation and parked at the office rather than the station
 * (ownerID=corporationID, locationID=officeID, flagID=115..121).
 *
 * The pin returned here is both what custody checks the stack against at move
 * time and what the escrow record stores, so a cancelled or expired order hands
 * the goods back to exactly the division they came from.
 *
 * Throws a user error naming the real reason on every rejection: this path used
 * to report "not owned by the active character" for a corp hangar item, which
 * reads like a permissions bug and is not what went wrong.
 */
function resolveSellItemCustodySource({ session, item, characterID, stationID, itemID }) {
  const itemOwnerID = normalizePositiveInteger(item && item.ownerID, 0);
  const itemLocationID = normalizePositiveInteger(item && item.locationID, 0);
  const itemFlagID = normalizeInteger(item && item.flagID, 0);

  if (itemOwnerID === characterID) {
    if (itemLocationID !== stationID || itemFlagID !== ITEM_FLAGS.HANGAR) {
      throwWrappedUserError("CustomInfo", {
        info: `Inventory item ${itemID} must be in the station hangar to sell it on the market.`,
      });
    }
    return {
      ownerID: characterID,
      locationID: stationID,
      flagID: ITEM_FLAGS.HANGAR,
      isCorpHangar: false,
    };
  }

  const corporationID = getNumericSessionValue(session, ["corpid", "corporationID"]);
  if (!corporationID || itemOwnerID !== corporationID) {
    throwWrappedUserError("CustomInfo", {
      info: `Inventory item ${itemID} is not owned by the active character.`,
    });
  }

  const takeRole = CORP_HANGAR_TAKE_ROLE_BY_FLAG[itemFlagID];
  if (!takeRole) {
    throwWrappedUserError("CustomInfo", {
      info: `Inventory item ${itemID} must be in a corporation hangar division to sell it on the market.`,
    });
  }

  // The office both proves the goods sit somewhere this corporation rents and
  // pins the station, since a corp hangar item's locationID is the office, not
  // the station the order is being placed at.
  const office = getCorporationOfficeByInventoryID(corporationID, itemLocationID);
  if (!office || normalizePositiveInteger(office.stationID, 0) !== stationID) {
    throwWrappedUserError("CustomInfo", {
      info: `Inventory item ${itemID} is not in a corporation hangar at this station.`,
    });
  }

  if ((rolesAtLocation(session, stationID) & takeRole) !== takeRole) {
    throwWrappedUserError("CustomInfo", {
      info: `The corporation hangar division holding item ${itemID} requires a take role this character does not have at this station.`,
    });
  }

  return {
    ownerID: corporationID,
    locationID: itemLocationID,
    flagID: itemFlagID,
    isCorpHangar: true,
  };
}

function getStructureMarketLocation(stationID) {
  const numericStationID = normalizePositiveInteger(stationID, 0);
  if (!numericStationID) {
    return null;
  }
  return structureState.getStructureByID(numericStationID) || null;
}

function ensureStructureMarketServiceAccess(session, stationID) {
  const structure = getStructureMarketLocation(stationID);
  if (!structure) {
    return null;
  }

  if (!characterHasStructureService(session, structure, STRUCTURE_SERVICE_ID.MARKET)) {
    throwWrappedUserError("StructureMarketDenied", {
      structureName:
        structure.itemName ||
        structure.name ||
        `Structure ${normalizePositiveInteger(structure.structureID, stationID)}`,
    });
  }

  return structure;
}

function createStructureMarketRowAccessScope(session, nowMs = Date.now()) {
  let structuresByID = null;
  const accessByStationID = new Map();

  function ensureStructureSnapshot() {
    if (structuresByID !== null) {
      return;
    }

    const snapshot = structureState.tickStructures(nowMs);
    if (!Array.isArray(snapshot)) {
      throw new Error("Structure market snapshot is unavailable");
    }
    structuresByID = new Map();
    for (const structure of snapshot) {
      const structureID = normalizePositiveInteger(
        structure && structure.structureID,
        0,
      );
      if (structureID) {
        structuresByID.set(structureID, structure);
      }
    }
  }

  function canUseStation(stationID) {
    if (accessByStationID.has(stationID)) {
      return accessByStationID.get(stationID);
    }

    ensureStructureSnapshot();
    const structure = structuresByID.get(stationID) || null;
    const canUse =
      !structure ||
      characterHasStructureService(
        session,
        structure,
        STRUCTURE_SERVICE_ID.MARKET,
      );
    accessByStationID.set(stationID, canUse);
    return canUse;
  }

  return {
    filterRows(rows = [], stationKeys = ["station_id", "stationID"]) {
      return ensureArray(rows).filter((row) => {
        const stationID = normalizePositiveInteger(
          stationKeys
            .map((key) => row && row[key])
            .find((value) => normalizePositiveInteger(value, 0) > 0),
          0,
        );
        return !stationID || canUseStation(stationID);
      });
    },
  };
}

function getOwnerOrderResponseOrder(orderResponse) {
  return orderResponse && orderResponse.row ? orderResponse.row : orderResponse || {};
}

function listEscrowItemsForOrder(orderId, ownerId) {
  const escrowRecord = getEscrowRecord(orderId);
  if (!escrowRecord || getEscrowType(escrowRecord) !== "sell") {
    return [];
  }

  // The escrowed stack keeps the owner it had at placement, so for a corp
  // hangar sale it sits under the corporation, not the listing character.
  // Prefer the recorded source owner over the caller's guess: callers on the
  // fill path pass the seller character, and trusting that would return an
  // empty list for every corp sale - the buyer would pay and receive nothing.
  const escrowOwnerID =
    normalizePositiveInteger(escrowRecord.sourceOwnerId, 0) ||
    normalizePositiveInteger(ownerId, 0);

  return listContainerItems(
    escrowOwnerID,
    normalizePositiveInteger(escrowRecord.escrowLocationID, 0),
    ITEM_FLAGS.HANGAR,
  );
}

function throwMarketUnavailable(method, error) {
  const errorDetails = error && error.stack
    ? error.stack
    : String(error && error.message || error || "unknown market failure");
  log.error(`[MarketProxy] ${method} failed: ${errorDetails}`);
  throwWrappedUserError("CustomInfo", {
    info: "Market is currently offline, elysian says sorry!",
  });
}

function isDefinitiveMarketDaemonRejection(error) {
  return Boolean(
    error &&
    error.code === "MARKET_DAEMON_RPC_REJECTED" &&
    error.marketDaemonOutcomeUnknown === false,
  );
}

function canCompensateRejectedPrimaryFill(saga, error) {
  if (!saga || saga.daemonAttempted !== true) {
    return true;
  }
  if (saga.fillResponse) {
    return false;
  }
  return isDefinitiveMarketDaemonRejection(error) ||
    error && error.marketDaemonRequestSent === false;
}

function isMarketDaemonUnavailableError(error) {
  if (error && error.marketDaemonOutcomeUnknown === true) {
    return true;
  }
  const message = String(error && error.message ? error.message : error || "")
    .toLowerCase();
  return (
    message.includes("market daemon rpc connect timeout") ||
    message.includes("market daemon rpc socket closed before connect") ||
    message.includes("market daemon rpc connection is not ready") ||
    message.includes("market daemon rpc connection closed") ||
    message.includes("market daemon rpc request timed out") ||
    message.includes("econnrefused") ||
    message.includes("econnreset") ||
    message.includes("enetunreach") ||
    message.includes("ehostunreach")
  );
}

function isMarketDaemonMissingOrderError(error, orderID) {
  // The daemon RPC currently exposes errors as strings, so keep this match
  // exact and order-specific before deleting durable local state.
  return String(error && error.message ? error.message : error || "") ===
    `order ${normalizeOrderId(orderID)} not found`;
}

async function requestExpirySweepIfDue(force = false, daemonCallOptions = {}) {
  const now = Date.now();
  if (!force && now - lastForcedExpirySweepAt < MARKET_EXPIRY_SWEEP_THROTTLE_MS) {
    return null;
  }

  lastForcedExpirySweepAt = now;
  return marketDaemonClient.call("SweepExpiredOrders", {}, daemonCallOptions);
}

async function applyTerminalOrderEvent(event) {
  const order = event && event.order ? event.order : null;
  if (!order) {
    return false;
  }

  const eventType = String(event && event.event_type || "").trim().toLowerCase();
  if (eventType !== "expired" && eventType !== "cancelled") {
    return false;
  }
  const orderID = normalizeOrderId(order && order.order_id);
  const orderRow = getOwnerOrderResponseOrder(order);
  // `ownerID` is the wallet target for a buy-order refund - a corporation ID
  // for a corp-wallet order, which is exactly right there (the escrowed ISK
  // came from that wallet). It is never used for item custody below: that
  // stays keyed to escrowRecord.ownerId, our own bookkeeping, which is
  // always the listing character regardless of whose wallet paid.
  const ownerID = normalizePositiveInteger(order && order.owner_id, 0);
  const isCorp = normalizeBoolean(order && order.is_corp);
  if (!ownerID) {
    return false;
  }
  const escrowRecord = getEscrowRecord(orderID);
  const escrowType = getEscrowType(escrowRecord);
  const isBuyOrder = normalizeBoolean(orderRow && orderRow.bid);
  if (!escrowRecord || escrowType !== (isBuyOrder ? "buy" : "sell")) {
    return false;
  }
  // The acting character, for notifications and (sell orders) item return -
  // always a character even when the order's wallet owner is a corporation.
  const characterID = normalizePositiveInteger(escrowRecord.ownerId, ownerID);
  const stationID = normalizePositiveInteger(orderRow && orderRow.station_id, 0);
  const terminalLabel = eventType === "expired" ? "expired" : "cancelled";

  let returnedChanges = [];
  if (isBuyOrder) {
    await creditCharacterWallet(
      ownerID,
      roundIsk(escrowRecord.escrowAmount),
      `Market escrow refund for ${terminalLabel} buy order ${orderID}`,
      stationID,
      {
        ...(isCorp ? { isCorp: true, accountKey: escrowRecord.accountKey } : {}),
        entryTypeID: JOURNAL_ENTRY_TYPE.MARKET_ESCROW,
        ownerID1: getMarketCounterpartyOwnerID(stationID) || stationID,
        ownerID2: ownerID,
        referenceID: stationID,
        idempotencyKey: `market:terminal:${eventType}:${orderID}:buy-refund`,
      },
    );
    flushCharacterWalletSagaBoundary(
      `Persisting ${terminalLabel} market escrow refund`,
    );
  } else {
    returnedChanges = moveEscrowItemsBackToSeller(
      orderID,
      characterID,
      stationID,
      { notify: false },
    );
    if (returnedChanges.length === 0) {
      // Benign, not an error: the escrow record is written before the custody
      // move, so a placement interrupted in that window leaves a record whose
      // escrow location is legitimately empty. Nothing to hand back - the
      // record removal below is the whole settlement.
      log.warn(
        `[MarketProxy] ${terminalLabel} sell order ${orderID} held no escrowed items to return owner=${characterID}`,
      );
    }
  }
  requireDurableMarketSagaWrite(
    removeEscrowRecordDurable(orderID),
    `Completing ${terminalLabel} market escrow recovery for order ${orderID}`,
  );
  if (returnedChanges.length > 0) {
    notifyInventoryChangesToCharacter(characterID, returnedChanges);
    // A corporation sell order returns its goods to the division they were
    // escrowed from, so the members watching that division are owed the row.
    fanCorporationOfficeInventoryChanges(returnedChanges);
  }

  notifyOwnOrdersChanged(characterID, [{
    ...order,
    state: terminalLabel,
  }], eventType === "expired" ? ORDER_REASON_EXPIRED : ORDER_REASON_CANCELLED, isCorp);
  return true;
}

async function applyExpiredOrderEvent(event) {
  return applyTerminalOrderEvent({
    ...event,
    event_type: "expired",
  });
}

async function applyCancelledStructureMarketOrder(order) {
  if (!order) {
    return false;
  }

  return applyTerminalOrderEvent({
    event_type: "cancelled",
    order: {
      ...order,
      state: "cancelled",
    },
  });
}

async function cancelStructureMarketOrdersForServiceLoss(structure, options = {}) {
  const stationID = normalizePositiveInteger(structure && structure.structureID, 0);
  if (!stationID) {
    return {
      success: false,
      errorMsg: "INVALID_STRUCTURE",
      cancelledCount: 0,
      orders: [],
    };
  }

  const quietDaemonUnavailable = options && options.quietDaemonUnavailable === true;
  const daemonCallOptions = quietDaemonUnavailable
    ? { suppressConnectFailureLog: true }
    : {};

  let response = null;
  try {
    await processPendingExpiryEvents({
      forceSweep: true,
      daemonCallOptions,
    });
    response = await marketDaemonClient.call("CancelStationOrders", {
      station_id: stationID,
    }, daemonCallOptions);
  } catch (error) {
    if (quietDaemonUnavailable && isMarketDaemonUnavailableError(error)) {
      return {
        success: false,
        errorMsg: "MARKET_DAEMON_UNAVAILABLE",
        retryable: true,
        cancelledCount: 0,
        appliedCount: 0,
        orders: [],
      };
    }
    throw error;
  }
  const orders = Array.isArray(response && response.orders)
    ? response.orders
    : [];

  let appliedCount = 0;
  for (const order of orders) {
    if (await applyCancelledStructureMarketOrder(order)) {
      appliedCount += 1;
    }
  }

  return {
    success: true,
    cancelledCount: normalizePositiveInteger(
      response && response.cancelled_count,
      orders.length,
    ),
    appliedCount,
    orders,
  };
}

async function processPendingExpiryEvents({
  forceSweep = false,
  daemonCallOptions = {},
} = {}) {
  if (marketExpiryPollPromise) {
    return marketExpiryPollPromise;
  }

  marketExpiryPollPromise = (async () => {
    await requestExpirySweepIfDue(forceSweep, daemonCallOptions);

    let afterEventId = getLastProcessedOrderEventId();
    while (true) {
      const events = await marketDaemonClient.call("GetOrderEvents", {
        after_event_id: afterEventId.toString(),
        limit: 100,
      }, daemonCallOptions);
      if (!Array.isArray(events) || events.length === 0) {
        break;
      }

      for (const event of events) {
        await applyTerminalOrderEvent(event);
        afterEventId = normalizeBigInt(event && event.event_id, afterEventId);
        setLastProcessedOrderEventId(afterEventId);
      }

      if (events.length < 100) {
        break;
      }
    }
  })().finally(() => {
    marketExpiryPollPromise = null;
  });

  return marketExpiryPollPromise;
}

// Read handlers must never join an in-flight fill saga: processPendingExpiryEvents()
// returns the shared poll promise, so awaiting it inside a read makes that read
// block for the whole write saga (an order list that owns nothing still waited
// out an entire multi-item purchase). Kick the sweep off and answer from the
// daemon, which is the authority for order state either way.
function queuePendingExpiryEvents(options = {}) {
  const promise = processPendingExpiryEvents(options);
  void promise.catch((error) => {
    log.warn(
      `[MarketProxy] Background expiry event processing failed: ${error && error.message}`,
    );
  });
  return promise;
}

function buildDurableMarketExpiryJobID(orderID) {
  return `market-order:${normalizeOrderId(orderID)}:expire`;
}

function getMarketOrderExpiryAtMs(orderLike) {
  const orderRow = getOwnerOrderResponseOrder(orderLike);
  const issuedAt = String(
    orderRow?.issued_at ?? orderRow?.issuedAt ?? orderLike?.issuedAt ?? "",
  ).trim();
  const issuedAtMs = Date.parse(issuedAt);
  const durationDays = normalizePositiveInteger(
    orderRow?.duration_days ?? orderRow?.durationDays ?? orderLike?.durationDays,
    0,
  );
  if (!Number.isFinite(issuedAtMs) || durationDays <= 0) {
    return 0;
  }
  return issuedAtMs + durationDays * MARKET_EXPIRY_DAY_MS;
}

function buildDurableMarketExpiryJob(orderLike) {
  const orderRow = getOwnerOrderResponseOrder(orderLike);
  const orderID = normalizeOrderId(
    orderLike?.order_id ?? orderLike?.orderId ?? orderRow?.order_id ?? orderRow?.orderId,
  );
  const expiryAtMs = getMarketOrderExpiryAtMs(orderLike);
  if (orderID === "0" || expiryAtMs <= 0) {
    return null;
  }
  return {
    jobID: buildDurableMarketExpiryJobID(orderID),
    type: DURABLE_EXPIRY_JOB_TYPE,
    dueAtMs: expiryAtMs + MARKET_EXPIRY_GRACE_MS,
    payload: {
      orderID,
      expiryAtMs,
    },
  };
}

function buildDurableMarketFillRecoveryJob(anchorRecord, saga = null) {
  const pendingFill = saga || anchorRecord && anchorRecord.pendingFill;
  const anchorOrderID = String(
    anchorRecord && anchorRecord.orderId || pendingFill && pendingFill.anchorOrderID || "",
  ).trim();
  const operationKey = String(pendingFill && pendingFill.operationKey || "").trim();
  if (!anchorOrderID || !operationKey || !pendingFill.direction) {
    return null;
  }
  return {
    jobID: `market-fill:${operationKey}:recover`,
    type: DURABLE_FILL_RECOVERY_JOB_TYPE,
    dueAtMs: Date.now(),
    payload: {
      anchorOrderID,
      operationKey,
      direction: String(pendingFill.direction),
      orderID: normalizeOrderId(pendingFill.orderID),
    },
  };
}

async function scheduleDurableMarketFillRecovery(anchorRecord, saga = null) {
  if (!durableMarketScheduler) {
    return null;
  }
  const job = buildDurableMarketFillRecoveryJob(anchorRecord, saga);
  if (!job) {
    return null;
  }
  await durableMarketScheduler.schedule(job);
  return job;
}

async function queueDurableMarketFillRecovery(anchorRecord, saga, error) {
  try {
    const job = await scheduleDurableMarketFillRecovery(anchorRecord, saga);
    if (job) {
      log.warn(
        `[MarketProxy] Queued ambiguous fill recovery ` +
          `operation=${saga.operationKey} order=${normalizeOrderId(saga.orderID)} ` +
          `error=${String(error && error.message || error)}`,
      );
    }
    return job;
  } catch (scheduleError) {
    log.error(
      `[MarketProxy] Failed to schedule fill recovery ` +
        `operation=${saga && saga.operationKey || "unknown"}: ` +
        `${scheduleError && scheduleError.stack || scheduleError}`,
    );
    return null;
  }
}

async function scheduleDurableMarketOrderExpiry(orderLike) {
  if (!durableMarketScheduler) {
    return null;
  }
  const job = buildDurableMarketExpiryJob(orderLike);
  if (!job) {
    return null;
  }
  await durableMarketScheduler.schedule(job);
  return job;
}

async function cancelDurableMarketOrderExpiry(orderID) {
  if (!durableMarketScheduler) {
    return false;
  }
  const jobID = buildDurableMarketExpiryJobID(orderID);
  if (activeDurableMarketExpiryJobs.has(jobID)) {
    return false;
  }
  await durableMarketScheduler.cancel(jobID);
  return true;
}

function queueDurableMarketOrderExpiry(orderLike) {
  if (!durableMarketScheduler) {
    return Promise.resolve(null);
  }
  const promise = scheduleDurableMarketOrderExpiry(orderLike);
  void promise.catch((error) => {
    log.warn(`[MarketProxy] Durable order expiry scheduling failed: ${error.message}`);
  });
  return promise;
}

function queueDurableMarketOrderExpiryCancellation(orderID) {
  if (!durableMarketScheduler) {
    return Promise.resolve(false);
  }
  const promise = cancelDurableMarketOrderExpiry(orderID);
  void promise.catch((error) => {
    log.warn(
      `[MarketProxy] Durable expiry cancellation deferred order=${normalizeOrderId(orderID)}: ${error.message}`,
    );
  });
  return promise;
}

function bindDurableScheduler(scheduler) {
  if (
    !scheduler ||
    typeof scheduler.schedule !== "function" ||
    typeof scheduler.cancel !== "function"
  ) {
    throw new TypeError("market scheduler requires schedule and cancel functions");
  }
  durableMarketScheduler = scheduler;
  return true;
}

function unbindDurableScheduler(scheduler = null) {
  if (scheduler && durableMarketScheduler !== scheduler) {
    return false;
  }
  durableMarketScheduler = null;
  activeDurableMarketExpiryJobs.clear();
  return true;
}

// Resolve every sell escrow left in `placing` state by an interrupted
// placement. A `placing` record is promoted to `active` microseconds after it
// is written, so one that survives a restart always means the placement died
// mid-flight; which way it is resolved depends on whether the custody move
// landed before the crash.
async function reconcilePlacingSellEscrowRecords() {
  for (const escrowRecord of listEscrowRecords()) {
    if (
      getEscrowType(escrowRecord) !== "sell" ||
      getEscrowState(escrowRecord) !== MARKET_ESCROW_STATE_PLACING
    ) {
      continue;
    }

    const orderID = normalizeOrderId(escrowRecord.orderId);
    const ownerID = normalizePositiveInteger(escrowRecord.ownerId, 0);
    const escrowLocationID = normalizePositiveInteger(
      escrowRecord.escrowLocationID,
      0,
    );
    // Look under the owner the stack actually carries in escrow - the
    // corporation for a corp hangar sale. Looking under the listing character
    // would find nothing, and "nothing reached escrow" is the branch that
    // cancels the daemon order and deletes the record, which would strand the
    // corporation's goods at the virtual escrow location with nothing naming
    // them.
    const escrowStackOwnerID =
      normalizePositiveInteger(escrowRecord.sourceOwnerId, 0) || ownerID;
    const escrowedItems = escrowLocationID
      ? listContainerItems(escrowStackOwnerID, escrowLocationID, ITEM_FLAGS.HANGAR)
      : [];

    if (escrowedItems.length > 0) {
      // The items reached escrow and only the promotion write was lost. Roll
      // forward: the order is live on the daemon and its stock really is held.
      requireDurableMarketSagaWrite(
        upsertSellEscrowRecord({
          ...escrowRecord,
          escrowState: MARKET_ESCROW_STATE_ACTIVE,
          updatedAt: new Date().toISOString(),
        }, { durable: true }),
        `Completing interrupted market escrow placement for order ${orderID}`,
      );
      log.warn(
        `[MarketProxy] Startup reconciliation completed interrupted sell escrow order=${orderID} owner=${ownerID} stacks=${escrowedItems.length}`,
      );
      continue;
    }

    // Nothing ever reached escrow, so the seller still holds the goods while
    // the daemon advertises them. Roll the daemon order back rather than leave
    // an order that would fill out of an empty escrow.
    try {
      await marketDaemonClient.call("CancelOrder", { order_id: orderID });
    } catch (error) {
      if (isMarketDaemonUnavailableError(error)) {
        log.warn(
          `[MarketProxy] Startup rollback of interrupted sell escrow deferred order=${orderID}: ${error.message}`,
        );
        continue;
      }
      if (!isMarketDaemonMissingOrderError(error, orderID)) {
        throw error;
      }
    }
    requireDurableMarketSagaWrite(
      removeEscrowRecordDurable(orderID),
      `Rolling back interrupted market escrow placement for order ${orderID}`,
    );
    log.warn(
      `[MarketProxy] Startup reconciliation rolled back interrupted sell escrow order=${orderID} owner=${ownerID}: no items reached escrow`,
    );
  }
}

// The market daemon no longer knows this order - its database was reset, or the
// order was acked but never durably committed. Settle it exactly like a cancel
// so sell escrow goes back to the seller's hangar and buy escrow ISK is
// refunded; applyTerminalOrderEvent owns both legs and their idempotency keys,
// so route through it instead of duplicating the settlement (a second refund
// for an order already settled as cancelled reuses the same wallet key and is
// absorbed as a duplicate).
async function releaseOrphanedMarketEscrow(escrowRecord, error) {
  const orderID = normalizeOrderId(escrowRecord && escrowRecord.orderId);
  const ownerID = normalizePositiveInteger(escrowRecord && escrowRecord.ownerId, 0);
  const escrowType = getEscrowType(escrowRecord);
  const settled = await applyTerminalOrderEvent({
    event_type: "cancelled",
    order: {
      order_id: orderID,
      owner_id: ownerID,
      is_corp: normalizeBoolean(escrowRecord && escrowRecord.isCorp),
      state: "cancelled",
      row: {
        order_id: orderID,
        bid: escrowType === "buy",
        station_id: normalizePositiveInteger(escrowRecord && escrowRecord.stationId, 0),
        type_id: normalizePositiveInteger(escrowRecord && escrowRecord.typeId, 0),
        price: roundIsk(escrowRecord && escrowRecord.price),
        vol_remaining: normalizePositiveInteger(
          escrowRecord && escrowRecord.remainingQuantity,
          0,
        ),
        issued_at: String(escrowRecord && escrowRecord.issuedAt || ""),
        duration_days: normalizePositiveInteger(
          escrowRecord && escrowRecord.durationDays,
          0,
        ),
      },
    },
  });
  if (!settled) {
    requireDurableMarketSagaWrite(
      removeEscrowRecordDurable(orderID),
      `Removing orphaned market escrow for order ${orderID}`,
    );
  }
  log.warn(
    `[MarketProxy] Startup reconciliation released orphaned market escrow order=${orderID} owner=${ownerID} escrow=${escrowType} settled=${settled}: ${error && error.message}`,
  );
}

function resolveStrandedEscrowOwnerHomeStationID(ownerID) {
  // Lazy require: characterState is only needed on the fallback leg of a
  // recovery that should almost never run, and market modules deliberately keep
  // their startup import graph thin.
  const {
    peekCharacterRecord,
    resolveHomeStationInfo,
  } = require(path.join(__dirname, "../character/characterState"));
  const characterRecord = peekCharacterRecord(ownerID);
  if (!characterRecord) {
    return 0;
  }
  return normalizePositiveInteger(
    resolveHomeStationInfo(characterRecord).homeStationID,
    0,
  );
}

// Where a recovered stack goes. The daemon still knows most orders, and its
// station is exactly where moveEscrowItemsBackToSeller would have put the
// items. When it does not (its database was reset, or the strand predates it)
// fall back to the owner's home station: it is the one station the character is
// guaranteed to be able to dock at and reach a hangar in, which is the only
// property the return leg needs.
async function resolveStrandedEscrowStationID(orderID, ownerID) {
  try {
    const order = await fetchOrderById(orderID);
    const stationID = normalizePositiveInteger(
      getOwnerOrderResponseOrder(order).station_id,
      0,
    );
    if (stationID) {
      return { stationID, source: "daemon-order" };
    }
  } catch (error) {
    if (isMarketDaemonUnavailableError(error)) {
      // Do not guess a destination while the authority is merely offline; the
      // sweep is idempotent, so the next boot picks the strand up again.
      return { stationID: 0, source: "daemon-unavailable" };
    }
    if (!isMarketDaemonMissingOrderError(error, orderID)) {
      throw error;
    }
  }
  return {
    stationID: resolveStrandedEscrowOwnerHomeStationID(ownerID),
    source: "owner-home-station",
  };
}

// Items can only leave a market escrow location through its escrow record, so a
// stack parked at MARKET_ESCROW_LOCATION_BASE + orderID with no record naming it
// is unreachable forever: no order lists it, no cancel or expiry can find it,
// and the owner cannot see it. Scan the escrow location range every boot and
// hand anything recordless back. Idempotent by construction - a recovered stack
// is no longer in the range - and a no-op on a clean store.
async function sweepStrandedMarketEscrowItems() {
  const strandedGroups = new Map();
  for (const item of Object.values(getAllItems() || {})) {
    const locationID = normalizePositiveInteger(item && item.locationID, 0);
    if (
      locationID <= MARKET_ESCROW_LOCATION_BASE ||
      locationID >= MARKET_ESCROW_LOCATION_LIMIT
    ) {
      continue;
    }
    const orderID = normalizeOrderId(locationID - MARKET_ESCROW_LOCATION_BASE);
    if (marketItemCustody.getEscrowLocationID(orderID) !== locationID) {
      // Round-trip guard: only ever touch a location the market itself would
      // have minted for this order id.
      continue;
    }
    if (getEscrowRecord(orderID)) {
      // A live escrow record owns these items; the normal fill, cancel and
      // expiry paths are responsible for them.
      continue;
    }
    const ownerID = normalizePositiveInteger(item && item.ownerID, 0);
    if (!ownerID) {
      continue;
    }
    const groupKey = `${orderID}:${ownerID}`;
    if (!strandedGroups.has(groupKey)) {
      strandedGroups.set(groupKey, { orderID, ownerID, items: [] });
    }
    strandedGroups.get(groupKey).items.push(item);
  }

  let recovered = 0;
  let deferred = 0;
  for (const { orderID, ownerID, items } of strandedGroups.values()) {
    const { stationID, source } = await resolveStrandedEscrowStationID(
      orderID,
      ownerID,
    );
    if (!stationID) {
      deferred += items.length;
      log.warn(
        `[MarketProxy] Stranded market escrow recovery deferred order=${orderID} owner=${ownerID} stacks=${items.length}: no destination station (${source})`,
      );
      continue;
    }

    const returnedChanges = [];
    for (const strandedItem of items) {
      const returnResult = marketItemCustody.transferItem({
        item: strandedItem,
        ownerID,
        locationID: stationID,
        flagID: ITEM_FLAGS.HANGAR,
        orderID,
        actor: ownerID,
        reason: itemCustody.CUSTODY_REASON.MARKET_ESCROW_RETURN,
        // Recovering a strand is retryable across boots, so the key is stable
        // rather than derived from the move's own shape: a retry after a
        // half-applied move must be absorbed, never replayed.
        idempotencyKey: `market:escrow-strand-recovery:${orderID}:${normalizePositiveInteger(strandedItem.itemID, 0)}`,
      });
      if (!returnResult.success) {
        log.warn(
          `[MarketProxy] Stranded market escrow recovery failed order=${orderID} owner=${ownerID} item=${strandedItem.itemID}: ${returnResult.errorMsg || "custody error"}`,
        );
        continue;
      }
      recovered += 1;
      log.warn(
        `[MarketProxy] Recovered stranded market escrow order=${orderID} owner=${ownerID} item=${strandedItem.itemID} type=${strandedItem.typeID} quantity=${normalizePositiveInteger(strandedItem.quantity, 1)} to station=${stationID} (${source})`,
      );
      for (const change of ensureArray(returnResult.data && returnResult.data.changes)) {
        if (change && change.item) {
          returnedChanges.push({
            item: change.item,
            previousData: buildCreatedPreviousState(change.item),
          });
        }
      }
    }
    if (returnedChanges.length > 0) {
      notifyInventoryChangesToCharacter(ownerID, returnedChanges);
    }
  }

  return { recovered, deferred };
}

async function reconcileDurableMarketOrders() {
  if (!durableMarketScheduler) {
    return { scheduled: 0, skipped: 0 };
  }

  await reconcilePlacingSellEscrowRecords();

  let scheduled = 0;
  let skipped = 0;
  const existingJobs = typeof durableMarketScheduler.list === "function"
    ? await durableMarketScheduler.list()
    : [];
  const existingJobsByID = new Map(
    ensureArray(existingJobs).map((job) => [String(job && job.jobID || ""), job]),
  );
  for (const escrowRecord of listEscrowRecords()) {
    const saga = escrowRecord && escrowRecord.pendingFill;
    const job = buildDurableMarketFillRecoveryJob(escrowRecord, saga);
    if (!job) {
      continue;
    }
    const existingJob = existingJobsByID.get(job.jobID);
    if (existingJob) {
      skipped += 1;
      if (String(existingJob.state || "") === "dead-letter") {
        log.error(
          `[MarketProxy] Fill recovery remains dead-lettered ` +
            `operation=${saga.operationKey} order=${normalizeOrderId(saga.orderID)} ` +
            `error=${String(existingJob.lastError || "unknown failure")}`,
        );
      }
      continue;
    }
    await durableMarketScheduler.schedule(job);
    scheduled += 1;
  }

  try {
    await processPendingExpiryEvents({
      forceSweep: true,
      daemonCallOptions: { suppressConnectFailureLog: true },
    });
  } catch (error) {
    if (!isMarketDaemonUnavailableError(error)) {
      throw error;
    }
    log.warn(`[MarketProxy] Startup expiry settlement deferred: ${error.message}`);
  }

  for (const escrowRecord of listEscrowRecords()) {
    if (escrowRecord && escrowRecord.pendingFill) {
      continue;
    }
    const escrowType = getEscrowType(escrowRecord);
    if (escrowType !== "buy" && escrowType !== "sell") {
      continue;
    }
    let order = escrowRecord;
    if (!buildDurableMarketExpiryJob(order)) {
      try {
        order = await fetchOrderById(escrowRecord.orderId);
      } catch (error) {
        if (isMarketDaemonMissingOrderError(error, escrowRecord.orderId)) {
          await releaseOrphanedMarketEscrow(escrowRecord, error);
          skipped += 1;
          continue;
        }
        if (!isMarketDaemonUnavailableError(error)) {
          throw error;
        }
        skipped += 1;
        continue;
      }
    }
    if (String(order && order.state || "open").toLowerCase() !== "open") {
      continue;
    }
    const job = await scheduleDurableMarketOrderExpiry(order);
    if (job) scheduled += 1;
    else skipped += 1;
  }

  // Runs last so that anything the passes above put back, settled or removed is
  // already reflected in the escrow table; whatever is still sitting in the
  // escrow location range at this point has no owner in the market state.
  await sweepStrandedMarketEscrowItems();

  return { scheduled, skipped };
}

async function handleDurableMarketOrderExpiry(job) {
  const scheduledJobID = String(job && job.jobID || "");
  const orderID = normalizeOrderId(job && job.payload && job.payload.orderID);
  const expectedExpiryAtMs = Math.trunc(
    Number(job && job.payload && job.payload.expiryAtMs) || 0,
  );
  if (!scheduledJobID || orderID === "0" || expectedExpiryAtMs <= 0) {
    throw new Error("market expiry job is invalid");
  }
  if (Date.now() + MARKET_EXPIRY_GRACE_MS < expectedExpiryAtMs) {
    throw new Error(`market expiry fired before order ${orderID} was due`);
  }

  activeDurableMarketExpiryJobs.add(scheduledJobID);
  try {
    await processPendingExpiryEvents({ forceSweep: true });
    const order = await fetchOrderById(orderID);
    if (String(order && order.state || "").toLowerCase() === "open") {
      throw new Error(`market order ${orderID} remained open after its expiry deadline`);
    }
    if (getEscrowRecord(orderID)) {
      throw new Error(`market order ${orderID} terminal settlement is incomplete`);
    }
    return { orderID, state: String(order && order.state || "terminal") };
  } finally {
    activeDurableMarketExpiryJobs.delete(scheduledJobID);
  }
}

async function waitForMarketExpiryPollerIdleForTests() {
  const pendingPoll = marketExpiryPollPromise;
  if (pendingPoll) {
    await pendingPoll;
  }
}

function stopMarketExpiryPollerForTests() {
  return false;
}

async function fetchOrderById(orderID) {
  return marketDaemonClient.call("GetOrder", {
    order_id: normalizeOrderId(orderID),
  });
}

async function loadCharacterOrderOrThrow(session, orderID) {
  const order = await fetchOrderById(orderID);
  const ownerID = normalizePositiveInteger(order && order.owner_id, 0);
  const isCorp = normalizeBoolean(order && order.is_corp);
  const characterID = getNumericSessionValue(session, ["charid", "characterID"]);

  if (isCorp) {
    // A corp-wallet order's owner_id is the corporation, not the character -
    // ownership means the session's own corp placed it and the character
    // still holds the Trader role (matching the placement-time gate in
    // resolveMarketOrderOwner).
    const corporationID = getNumericSessionValue(session, ["corpid", "corporationID"]);
    if (!ownerID || !corporationID || ownerID !== corporationID || !sessionHasCorpTraderRole(session)) {
      throwWrappedUserError("CustomInfo", {
        info: `Order ${normalizeOrderId(orderID)} is not owned by the active character's corporation.`,
      });
    }
    return order;
  }

  if (!ownerID || ownerID !== characterID) {
    throwWrappedUserError("CustomInfo", {
      info: `Order ${normalizeOrderId(orderID)} is not owned by the active character.`,
    });
  }

  return order;
}

async function recordTrade(typeID, price, quantity) {
  if (!(normalizePositiveInteger(typeID, 0) > 0) || !(normalizePositiveInteger(quantity, 0) > 0)) {
    return null;
  }

  return marketDaemonClient.call("RecordTrade", {
    type_id: normalizePositiveInteger(typeID, 0),
    price: roundIsk(price),
    quantity: normalizePositiveInteger(quantity, 0),
  });
}

async function fetchCharacterOrders(characterID) {
  if (!normalizePositiveInteger(characterID, 0)) {
    return [];
  }

  const result = await marketDaemonClient.call("GetCharOrders", {
    owner_id: normalizePositiveInteger(characterID, 0),
    is_corp: false,
  });
  return Array.isArray(result) ? result : [];
}

function syncOpenBuyEscrowRecords(ownerOrders = []) {
  for (const ownerOrder of ensureArray(ownerOrders)) {
    const state = String(ownerOrder && ownerOrder.state ? ownerOrder.state : "open").toLowerCase();
    const orderRow = getOwnerOrderResponseOrder(ownerOrder);
    if (state !== "open") {
      continue;
    }
    if (normalizeBoolean(orderRow && orderRow.bid)) {
      upsertBuyEscrowRecord(ownerOrder);
    }
    queueDurableMarketOrderExpiry(ownerOrder);
  }
}

function notifyBuyerDelivery(characterID, changes = []) {
  const visibleChanges = transformVisibleBuyerChanges(changes, characterID);
  if (visibleChanges.length === 0) {
    return;
  }

  notifyInventoryChangesToCharacter(characterID, visibleChanges);
  for (const change of visibleChanges) {
    notifyMarketItemReceived(characterID, change.item);
  }
}

function consumeSeedMarketInventoryQuantity(itemOrID, quantity, options = {}) {
  const sourceItem = itemOrID && typeof itemOrID === "object"
    ? itemOrID
    : findItemById(normalizePositiveInteger(itemOrID, 0));
  const requestedQuantity = normalizePositiveInteger(quantity, 0);
  return marketItemCustody.consumeSeedItem({
    item: sourceItem,
    quantity: requestedQuantity,
    actor: sourceItem && sourceItem.ownerID,
    idempotencyKey: options.idempotencyKey,
  });
}

/**
 * Where a cancelled or expired sell order's goods go back to.
 *
 * The escrow record carries the source pin the placement validated, so the
 * return is the exact inverse of the move that took them. Orders escrowed
 * before that pin existed have no source fields; those are always character
 * hangar sales, so the old destination is the correct fallback.
 *
 * Getting this wrong in the corporation direction is not a cosmetic bug: goods
 * taken from a corporation hangar and handed back to the acting character's
 * personal hangar is theft, and a cancel is the ordinary way to trigger it.
 */
function resolveEscrowReturnDestination(escrowRecord, fallbackOwnerId, fallbackStationId) {
  const sourceOwnerID = normalizePositiveInteger(escrowRecord && escrowRecord.sourceOwnerId, 0);
  const sourceLocationID = normalizePositiveInteger(escrowRecord && escrowRecord.sourceLocationId, 0);
  const sourceFlagID = normalizeInteger(
    escrowRecord && escrowRecord.sourceFlagId,
    Number.NaN,
  );
  if (sourceOwnerID && sourceLocationID && Number.isInteger(sourceFlagID) && sourceFlagID >= 0) {
    return {
      ownerID: sourceOwnerID,
      locationID: sourceLocationID,
      flagID: sourceFlagID,
    };
  }
  return {
    ownerID: normalizePositiveInteger(fallbackOwnerId, 0),
    locationID: normalizePositiveInteger(fallbackStationId, 0),
    flagID: ITEM_FLAGS.HANGAR,
  };
}

function moveEscrowItemsBackToSeller(orderId, ownerId, stationId, options = {}) {
  const escrowRecord = getEscrowRecord(orderId);
  const destination = resolveEscrowReturnDestination(escrowRecord, ownerId, stationId);
  // The stack sits in escrow under whoever owned it at placement, so it has to
  // be listed under that owner too - a corp sale's goods are never under the
  // listing character.
  const escrowItems = listEscrowItemsForOrder(orderId, destination.ownerID);
  const returnedChanges = [];

  for (const escrowItem of escrowItems) {
    const returnResult = marketItemCustody.transferItem({
      item: escrowItem,
      ownerID: destination.ownerID,
      locationID: destination.locationID,
      flagID: destination.flagID,
      orderID: orderId,
      actor: ownerId,
      reason: itemCustody.CUSTODY_REASON.MARKET_ESCROW_RETURN,
    });
    if (!returnResult.success) {
      throwWrappedUserError("CustomInfo", {
        info: `Failed to return escrowed items for order ${normalizeOrderId(orderId)}.`,
      });
    }

    for (const change of ensureArray(returnResult.data && returnResult.data.changes)) {
      if (change && change.item) {
        returnedChanges.push({
          item: change.item,
          previousData: buildCreatedPreviousState(change.item),
        });
      }
    }
  }

  if (returnedChanges.length > 0 && options.notify !== false) {
    notifyInventoryChangesToCharacter(ownerId, returnedChanges);
    // ownerId is the listing character, so the notification above reaches
    // nobody else even when the goods themselves belong to the corporation
    // and land back in one of its divisions.
    fanCorporationOfficeInventoryChanges(returnedChanges);
  }
  return returnedChanges;
}

function deliverSeedItemToCharacter(
  characterID,
  stationID,
  typeID,
  quantity,
  options = {},
) {
  const typeRecord = resolveItemByTypeID(normalizePositiveInteger(typeID, 0));
  const grantOptions = Number(typeRecord && typeRecord.groupID) === 963
    ? { singleton: 0, individualItems: true }
    : {};
  const grantResult = marketItemCustody.grantSeedItem({
    ownerID: characterID,
    locationID: stationID,
    flagID: ITEM_FLAGS.HANGAR,
    typeID: normalizePositiveInteger(typeID, 0),
    quantity: normalizePositiveInteger(quantity, 0),
    options: grantOptions,
    actor: characterID,
    idempotencyKey: options.idempotencyKey,
  });

  if (!grantResult.success) {
    throwWrappedUserError("CustomInfo", {
      info: `Failed to deliver purchased item type ${typeID} to the destination hangar.`,
    });
  }

  const deliveredChanges = ensureArray(grantResult.data && grantResult.data.changes)
    .filter((change) => change && change.item)
    .map((change) => ({
      item: change.item,
      previousData: change.created === true
        ? buildCreatedPreviousState(change.item)
        : change.previousData ||
          change.previousState ||
          buildCreatedPreviousState(change.item),
    }));
  if (options.notify !== false) {
    notifyInventoryChangesToCharacter(characterID, deliveredChanges);
    for (const change of deliveredChanges) {
      notifyMarketItemReceived(characterID, change.item);
    }
  }
  return {
    ...grantResult,
    deliveredChanges,
  };
}

function requireDurableMarketSagaWrite(result, context) {
  if (result && result.success === true) {
    return;
  }
  throwWrappedUserError("CustomInfo", {
    info: `${context} failed: ${result && result.errorMsg || "persistence error"}.`,
  });
}

function flushCharacterWalletSagaBoundary(context) {
  requireDurableMarketSagaWrite(
    database.flushTableSync("characters"),
    context,
  );
}

function allocateSeedMarketFillSagaIdentity(direction) {
  const allocation = allocateMarketSagaIDDurable();
  requireDurableMarketSagaWrite(
    allocation,
    "Allocating seeded market fill saga",
  );
  const sagaID = normalizePositiveInteger(allocation.sagaID, 0);
  const idempotencyNamespace = String(allocation.idempotencyNamespace || "").trim();
  if (!idempotencyNamespace) {
    throw new Error("Seeded market fill saga allocation did not return an idempotency namespace.");
  }
  return {
    sagaID,
    anchorOrderID: `seed-fill-${sagaID}`,
    operationKey: `market:${String(direction || "seed-fill")}:${idempotencyNamespace}:${sagaID}`,
  };
}

function persistSeedMarketFillSaga(anchorRecord, saga) {
  saga.updatedAt = new Date().toISOString();
  requireDurableMarketSagaWrite(
    putEscrowRecordDurable({
      ...anchorRecord,
      orderId: saga.anchorOrderID,
      escrowType: "seed-fill",
      pendingFill: saga,
      updatedAt: saga.updatedAt,
    }),
    `Persisting seeded market fill saga ${saga.operationKey}`,
  );
}

function buildSeedSellFillSaga({
  sellOrder,
  buyerCharacterID,
  buyerWalletID = null,
  buyerIsCorp = false,
  buyerAccountKey = null,
  destinationStationID,
  typeID,
  tradedQuantity,
  availableQuantity,
  orderPrice,
  grossCost,
  stationMarketOwnerID,
  chargeBuyerWallet,
  crossingOrderID,
  crossingOrderPrice,
  crossingAvailableQuantity,
} = {}) {
  const identity = allocateSeedMarketFillSagaIdentity("buyer-consumes-seed-sell");
  return {
    schemaVersion: 1,
    direction: "buyer-consumes-seed-sell",
    ...identity,
    status: "forward",
    orderID: normalizeOrderId(sellOrder && sellOrder.order_id),
    buyerCharacterID,
    // Wallet target for the ISK side only - defaults to the buyer's own
    // wallet; item delivery always stays keyed to buyerCharacterID above.
    buyerWalletID: buyerWalletID || buyerCharacterID,
    buyerIsCorp,
    buyerAccountKey,
    destinationStationID,
    typeID,
    tradedQuantity,
    availableQuantity,
    orderPrice,
    grossCost,
    stationMarketOwnerID,
    chargeBuyerWallet: chargeBuyerWallet !== false,
    crossingOrderID: crossingOrderID ? normalizeOrderId(crossingOrderID) : null,
    crossingOrderPrice: roundIsk(crossingOrderPrice),
    crossingAvailableQuantity: normalizePositiveInteger(
      crossingAvailableQuantity,
      0,
    ),
    priceImprovementRefund: crossingOrderID
      ? Math.max(
          0,
          roundIsk(
            computeOrderValue(crossingOrderPrice, tradedQuantity) - grossCost,
          ),
        )
      : 0,
    buyerDebited: false,
    priceImprovementRefunded: false,
    daemonAttempted: false,
    fillResponse: null,
    crossingDaemonAttempted: false,
    crossingFillResponse: null,
    delivered: false,
    deliveryChanges: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function debitCrewPurchase(saga, typeLabel) {
  return debitCharacterWallet(saga.buyerCharacterID, saga.grossCost, `Market purchase of ${typeLabel}`, saga.destinationStationID, {
    entryTypeID: JOURNAL_ENTRY_TYPE.MARKET_TRANSACTION, ownerID1: saga.buyerCharacterID,
    ownerID2: saga.stationMarketOwnerID || saga.destinationStationID, referenceID: saga.destinationStationID,
    minimumBalance: saga.crewPurchase.walletReserve,
    idempotencyKey: `crew-buy-wallet:${saga.crewPurchase.serial}:${saga.crewPurchase.jobID}:debit`,
  });
}
async function compensateSeedSellFillSaga(anchorRecord, saga, typeLabel) {
  saga.status = "compensating";
  persistSeedMarketFillSaga(anchorRecord, saga);
  if (saga.crewPurchase && saga.buyerDebitAttempted && !saga.buyerDebited && !saga.buyerDebitRejected) {
    try { await debitCrewPurchase(saga, typeLabel); flushCharacterWalletSagaBoundary("Confirming crew purchase debit before refund"); saga.buyerDebited = true; }
    catch (error) { if (!error.walletDefinitive) throw error; saga.buyerDebitRejected = true; }
    persistSeedMarketFillSaga(anchorRecord, saga);
  }

  const buyerWalletOptions = saga.buyerIsCorp
    ? { isCorp: true, accountKey: saga.buyerAccountKey }
    : {};

  if (saga.priceImprovementRefunded) {
    await debitCharacterWallet(
      saga.buyerWalletID,
      saga.priceImprovementRefund,
      `Seeded market price improvement rollback for ${typeLabel}`,
      saga.destinationStationID,
      {
        ...buyerWalletOptions,
        entryTypeID: JOURNAL_ENTRY_TYPE.MARKET_ESCROW,
        ownerID1: saga.stationMarketOwnerID || saga.destinationStationID,
        ownerID2: saga.buyerCharacterID,
        referenceID: saga.destinationStationID,
        idempotencyKey: `${saga.operationKey}:wallet:price-improvement-compensate`,
      },
    );
    flushCharacterWalletSagaBoundary("Persisting seeded price improvement compensation");
    saga.priceImprovementRefunded = false;
    persistSeedMarketFillSaga(anchorRecord, saga);
  }

  if (saga.buyerDebited) {
    await creditCharacterWallet(
      saga.buyerWalletID,
      saga.grossCost,
      `Seeded market purchase refund for ${typeLabel}`,
      saga.destinationStationID,
      {
        ...buyerWalletOptions,
        entryTypeID: JOURNAL_ENTRY_TYPE.MARKET_TRANSACTION,
        ownerID1: saga.buyerCharacterID,
        ownerID2: saga.stationMarketOwnerID || saga.destinationStationID,
        referenceID: saga.destinationStationID,
        idempotencyKey: saga.crewPurchase ? `crew-buy-wallet:${saga.crewPurchase.serial}:${saga.crewPurchase.jobID}:refund` : `${saga.operationKey}:wallet:buyer-compensate`,
      },
    );
    flushCharacterWalletSagaBoundary("Persisting seeded buyer compensation");
    saga.buyerDebited = false;
    persistSeedMarketFillSaga(anchorRecord, saga);
  }

  requireDurableMarketSagaWrite(
    saga.crewPurchase ? completeCrewPurchaseSaga(saga, true) : removeEscrowRecordDurable(saga.anchorOrderID),
    `Clearing compensated seeded market fill saga ${saga.operationKey}`,
  );
}

async function executeSeedSellFillSagaUnlocked(
  anchorRecord,
  saga,
  typeLabel,
  options = {},
) {
  if (saga.crewPurchase) {
    const prior = getCrewPurchaseReceipt(saga.buyerCharacterID);
    if (prior?.serial >= saga.crewPurchase.serial) {
      if (prior.serial !== saga.crewPurchase.serial || prior.jobID !== saga.crewPurchase.jobID) throw new Error("CREW_PURCHASE_STALE");
      return { compensated: prior.result.rejected, crewResult: prior.result };
    }
    if (!saga.buyerDebitAttempted) {
      const stock = listContainerItems(saga.buyerCharacterID, saga.destinationStationID, ITEM_FLAGS.HANGAR)
        .filter(i => i.typeID === saga.typeID && i.singleton === 0 && !i.custodyReservation).reduce((sum,i) => sum+i.quantity,0);
      if (stock + saga.tradedQuantity > saga.crewPurchase.targetStock) {
        await compensateSeedSellFillSaga(anchorRecord, saga, typeLabel); return { compensated: true };
      }
    }
  }
  if (saga.status === "compensating") {
    await compensateSeedSellFillSaga(anchorRecord, saga, typeLabel);
    return { compensated: true };
  }

  try {
    const buyerWalletOptions = saga.buyerIsCorp
      ? { isCorp: true, accountKey: saga.buyerAccountKey }
      : {};
    let buyerWalletResult = null;
    if (saga.chargeBuyerWallet && !saga.buyerDebited) {
      if (saga.crewPurchase) { saga.buyerDebitAttempted = true; persistSeedMarketFillSaga(anchorRecord, saga); }
      try { buyerWalletResult = saga.crewPurchase ? await debitCrewPurchase(saga, typeLabel) : await debitCharacterWallet(
        saga.buyerWalletID,
        saga.grossCost,
        `Market purchase of ${typeLabel}`,
        saga.destinationStationID,
        {
          ...buyerWalletOptions,
          entryTypeID: JOURNAL_ENTRY_TYPE.MARKET_TRANSACTION,
          ownerID1: saga.buyerCharacterID,
          ownerID2: saga.stationMarketOwnerID || saga.destinationStationID,
          referenceID: saga.destinationStationID,
          idempotencyKey: `${saga.operationKey}:wallet:buyer-debit`,
        },
      ); } catch (error) { if (saga.crewPurchase && error.walletDefinitive) { saga.buyerDebitRejected = true; persistSeedMarketFillSaga(anchorRecord, saga); } throw error; }
      flushCharacterWalletSagaBoundary("Persisting seeded market buyer debit");
      saga.buyerDebited = true;
      persistSeedMarketFillSaga(anchorRecord, saga);
    }

    if (saga.priceImprovementRefund > 0 && !saga.priceImprovementRefunded) {
      await creditCharacterWallet(
        saga.buyerWalletID,
        saga.priceImprovementRefund,
        `Market price improvement refund for ${typeLabel} order ${saga.crossingOrderID}`,
        saga.destinationStationID,
        {
          ...buyerWalletOptions,
          entryTypeID: JOURNAL_ENTRY_TYPE.MARKET_ESCROW,
          ownerID1: saga.stationMarketOwnerID || saga.destinationStationID,
          ownerID2: saga.buyerCharacterID,
          referenceID: saga.destinationStationID,
          idempotencyKey: `${saga.operationKey}:wallet:price-improvement-refund`,
        },
      );
      flushCharacterWalletSagaBoundary("Persisting seeded price improvement refund");
      saga.priceImprovementRefunded = true;
      persistSeedMarketFillSaga(anchorRecord, saga);
    }

    saga.daemonAttempted = true;
    persistSeedMarketFillSaga(anchorRecord, saga);
    saga.fillResponse = await marketDaemonClient.call("FillOrder", {
      order_id: saga.orderID,
      fill_quantity: saga.tradedQuantity,
      idempotency_key: `${saga.operationKey}:daemon-fill`,
    });
    persistSeedMarketFillSaga(anchorRecord, saga);

    if (saga.crossingOrderID) {
      saga.crossingDaemonAttempted = true;
      persistSeedMarketFillSaga(anchorRecord, saga);
      saga.crossingFillResponse = await marketDaemonClient.call("FillOrder", {
        order_id: saga.crossingOrderID,
        fill_quantity: saga.tradedQuantity,
        idempotency_key: `${saga.operationKey}:crossing-daemon-fill`,
      });
      const crossingEscrowRecord = getEscrowRecord(saga.crossingOrderID);
      if (crossingEscrowRecord) {
        if (saga.crossingFillResponse.state === "filled") {
          requireDurableMarketSagaWrite(
            removeEscrowRecordDurable(saga.crossingOrderID),
            `Completing crossing market order ${saga.crossingOrderID}`,
          );
        } else {
          requireDurableMarketSagaWrite(
            putEscrowRecordDurable({
              ...crossingEscrowRecord,
              remainingQuantity: saga.crossingFillResponse.vol_remaining,
              escrowAmount: computeOrderValue(
                saga.crossingOrderPrice,
                saga.crossingFillResponse.vol_remaining,
              ),
              updatedAt: new Date().toISOString(),
            }),
            `Updating crossing market escrow ${saga.crossingOrderID}`,
          );
        }
      }
    }

    if (!saga.delivered) {
      const deliveryResult = deliverSeedItemToCharacter(
        saga.buyerCharacterID,
        saga.destinationStationID,
        saga.typeID,
        saga.tradedQuantity,
        {
          notify: Boolean(saga.crewPurchase),
          idempotencyKey: `${saga.operationKey}:inventory:deliver`,
        },
      );
      saga.deliveryChanges = deliveryResult.deliveredChanges || [];
      saga.delivered = true;
      persistSeedMarketFillSaga(anchorRecord, saga);
    }

    requireDurableMarketSagaWrite(
      recordCompletedMarketFillAchievements(saga),
      `Recording market achievement contributions ${saga.operationKey}`,
    );
    persistSeedMarketFillSaga(anchorRecord, saga);

    requireDurableMarketSagaWrite(
      saga.crewPurchase ? completeCrewPurchaseSaga(saga) : removeEscrowRecordDurable(saga.anchorOrderID),
      `Completing seeded market fill saga ${saga.operationKey}`,
    );
    return {
      compensated: false,
      fillResponse: saga.fillResponse,
      crossingFillResponse: saga.crossingFillResponse,
      buyerWalletResult,
      buyerChanges: saga.deliveryChanges,
    };
  } catch (error) {
    if (canCompensateRejectedPrimaryFill(saga, error)) {
      await compensateSeedSellFillSaga(anchorRecord, saga, typeLabel);
    } else if (options.scheduleRecovery !== false) {
      await queueDurableMarketFillRecovery(anchorRecord, saga, error);
    }
    throw error;
  }
}

async function handleDurableMarketFillRecovery(job) {
  const payload = job && job.payload || {};
  const anchorOrderID = String(payload.anchorOrderID || "").trim();
  const operationKey = String(payload.operationKey || "").trim();
  if (!anchorOrderID || !operationKey) {
    throw new Error("market fill recovery job is invalid");
  }

  const anchorRecord = getEscrowRecord(anchorOrderID);
  const saga = anchorRecord && anchorRecord.pendingFill;
  if (!saga) {
    return { operationKey, state: "already-settled" };
  }
  if (String(saga.operationKey || "") !== operationKey) {
    throw new Error(
      `market fill recovery operation mismatch anchor=${anchorOrderID}`,
    );
  }

  try {
    const typeLabel = getMarketTypeLabel(saga.typeID);
    let result = null;
    if (saga.direction === "buyer-consumes-seed-sell") {
      result = await executeSeedSellFillSaga(
        anchorRecord,
        saga,
        typeLabel,
        { scheduleRecovery: false },
      );
    } else if (saga.direction === "seller-fills-seed-buy") {
      result = await executeSeedBuyFillSaga(
        anchorRecord,
        saga,
        typeLabel,
        { scheduleRecovery: false },
      );
    } else if (saga.direction === "buyer-consumes-player-sell") {
      result = await executePlayerSellFillSaga(
        anchorRecord,
        saga,
        typeLabel,
        { scheduleRecovery: false },
      );
    } else if (saga.direction === "seller-fills-player-buy") {
      result = await executePlayerBuyFillSaga(
        anchorRecord,
        saga,
        typeLabel,
        { scheduleRecovery: false },
      );
    } else {
      throw new Error(`market fill recovery direction is invalid: ${saga.direction}`);
    }
    return {
      operationKey,
      state: result && result.compensated ? "compensated" : "settled",
    };
  } catch (error) {
    const wasCompensated = !getEscrowRecord(anchorOrderID) &&
      canCompensateRejectedPrimaryFill(saga, error);
    const errorDetails = error && error.stack
      ? error.stack
      : String(error && error.message || error);
    log.error(
      `[MarketProxy] Fill recovery failed ` +
        `operation=${operationKey} direction=${saga.direction} ` +
        `order=${normalizeOrderId(saga.orderID)} attempt=${Number(job.attempt || 0)}: ` +
        `${errorDetails}`,
    );
    if (wasCompensated) {
      return { operationKey, state: "failed-and-compensated" };
    }
    throw error;
  }
}

async function executeSeedSellFillSaga(
  anchorRecord,
  saga,
  typeLabel,
  options = {},
) {
  const operationKey = String(saga && saga.operationKey || "").trim();
  const activePromise = seedMarketFillSagaPromises.get(operationKey);
  if (activePromise) {
    return activePromise;
  }
  const sagaPromise = executeSeedSellFillSagaUnlocked(
    anchorRecord,
    saga,
    typeLabel,
    options,
  ).finally(() => {
    if (seedMarketFillSagaPromises.get(operationKey) === sagaPromise) {
      seedMarketFillSagaPromises.delete(operationKey);
    }
  });
  seedMarketFillSagaPromises.set(operationKey, sagaPromise);
  return sagaPromise;
}

function buildSeedBuyFillSaga({
  buyOrder,
  sellerCharacterID,
  sellerWalletID = null,
  sellerIsCorp = false,
  sellerAccountKey = null,
  destinationStationID,
  typeID,
  fillableQuantity,
  availableQuantity,
  orderPrice,
  grossAmount,
  salesTax,
  stationMarketOwnerID,
  sourceItemID,
  sourceOrderID,
  crossingOrderID,
  crossingAvailableQuantity,
} = {}) {
  const identity = allocateSeedMarketFillSagaIdentity("seller-fills-seed-buy");
  const normalizedSourceOrderID = normalizePositiveInteger(sourceOrderID, 0);
  const sourceItems = normalizedSourceOrderID > 0
    ? listEscrowItemsForOrder(normalizedSourceOrderID, sellerCharacterID)
    : [findItemById(sourceItemID)].filter(Boolean);
  const itemLegs = [];
  let sourceRemaining = normalizePositiveInteger(fillableQuantity, 0);
  for (const sourceItem of sourceItems) {
    if (sourceRemaining <= 0) {
      break;
    }
    const itemQuantity = normalizeInteger(sourceItem && sourceItem.singleton, 0) === 1
      ? 1
      : normalizePositiveInteger(sourceItem && sourceItem.stacksize, 0);
    const quantity = Math.min(sourceRemaining, itemQuantity);
    itemLegs.push({
      sourceItem,
      quantity,
      reserveKey: `${identity.operationKey}:inventory:reserve:${itemLegs.length}`,
      releaseKey: `${identity.operationKey}:inventory:release:${itemLegs.length}`,
      consumeKey: `${identity.operationKey}:inventory:consume:${itemLegs.length}`,
      destinationItem: null,
      reserveChanges: [],
      reserved: false,
      released: false,
      consumed: false,
    });
    sourceRemaining -= quantity;
  }
  if (sourceRemaining > 0) {
    throwWrappedUserError("CustomInfo", {
      info: normalizedSourceOrderID > 0
        ? `Escrow for sell order ${normalizeOrderId(normalizedSourceOrderID)} did not contain enough items.`
        : `Inventory item ${normalizePositiveInteger(sourceItemID, 0)} did not contain enough items.`,
    });
  }

  return {
    schemaVersion: 1,
    direction: "seller-fills-seed-buy",
    ...identity,
    status: "forward",
    orderID: normalizeOrderId(buyOrder && buyOrder.order_id),
    sellerCharacterID,
    // Wallet target for the ISK side only; item custody above stays keyed to
    // sellerCharacterID.
    sellerWalletID: sellerWalletID || sellerCharacterID,
    sellerIsCorp,
    sellerAccountKey,
    destinationStationID,
    typeID,
    fillableQuantity,
    availableQuantity,
    orderPrice,
    grossAmount,
    salesTax,
    stationMarketOwnerID,
    sourceOrderID: normalizedSourceOrderID || null,
    crossingOrderID: crossingOrderID ? normalizeOrderId(crossingOrderID) : null,
    crossingAvailableQuantity: normalizePositiveInteger(
      crossingAvailableQuantity,
      0,
    ),
    itemLegs,
    daemonAttempted: false,
    fillResponse: null,
    crossingDaemonAttempted: false,
    crossingFillResponse: null,
    sellerCredited: false,
    taxDebited: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function compensateSeedBuyFillSaga(anchorRecord, saga) {
  saga.status = "compensating";
  persistSeedMarketFillSaga(anchorRecord, saga);
  if (saga.crewSale) for (const leg of saga.itemLegs) {
    if (!leg.reserved) {
      const receipt = itemCustody.getCommittedReceipt(leg.reserveKey);
      if (!receipt.success) throw new Error("CREW_SALE_CUSTODY_PENDING");
      if (receipt.committed) {
        const ids = [...(receipt.resultData?.itemIDs || []), ...(receipt.resultData?.changes || []).map(change => change.item?.itemID).filter(Boolean)];
        const restored = ids.map(id => findItemById(id)).find(item => item?.ownerID === saga.sellerCharacterID && item.locationID === marketItemCustody.getSeedFillEscrowLocationID(saga.sagaID));
        if (itemCustody.getCommittedReceipt(leg.releaseKey).committed) { leg.reserved = true; leg.released = true; }
        else if (restored) { leg.destinationItem = restored; leg.reserved = true; }
        else throw new Error("CREW_SALE_RESERVATION_UNRESOLVED");
      }
    }
  }
  persistSeedMarketFillSaga(anchorRecord, saga);
  for (let index = saga.itemLegs.length - 1; index >= 0; index -= 1) {
    const leg = saga.itemLegs[index];
    if (!leg.reserved || leg.released || !leg.destinationItem) {
      continue;
    }
    const releaseResult = marketItemCustody.releaseSeedItem({
      item: leg.destinationItem,
      quantity: leg.quantity,
      sagaID: saga.sagaID,
      locationID: leg.sourceItem.locationID,
      flagID: leg.sourceItem.flagID,
      actor: saga.sellerCharacterID,
      idempotencyKey: leg.releaseKey,
    });
    if (!releaseResult.success) {
      throwWrappedUserError("CustomInfo", {
        info: `Failed to release seeded market reservation for item ${leg.destinationItem.itemID}.`,
      });
    }
    leg.released = true;
    persistSeedMarketFillSaga(anchorRecord, saga);
  }
  requireDurableMarketSagaWrite(
    saga.crewSale ? completeCrewSaleSaga(saga, true) : removeEscrowRecordDurable(saga.anchorOrderID),
    `Clearing compensated seeded market fill saga ${saga.operationKey}`,
  );
}

async function executeSeedBuyFillSagaUnlocked(
  anchorRecord,
  saga,
  typeLabel,
  options = {},
) {
  if (saga.crewSale) {
    const prior = getCrewSaleReceipt(saga.sellerCharacterID);
    if (prior?.serial >= saga.crewSale.serial) {
      if (prior.serial !== saga.crewSale.serial || prior.jobID !== saga.crewSale.jobID) throw new Error("CREW_SALE_STALE");
      return { compensated: prior.result.rejected, crewResult: prior.result };
    }
    // Before the first reservation only. A committed custody receipt also
    // proves reservation when its native checkpoint was interrupted.
    if (!saga.itemLegs.some(leg => leg.reserved || itemCustody.getCommittedReceipt(leg.reserveKey).committed)) {
      const stock = listContainerItems(saga.sellerCharacterID, saga.crewSale.stationID, ITEM_FLAGS.HANGAR)
        .filter(i => i.typeID === saga.typeID && i.singleton === 0 && !i.custodyReservation)
        .reduce((sum, i) => sum + i.quantity, 0);
      if (stock - saga.fillableQuantity < saga.crewSale.reserve) {
        compensateSeedBuyFillSaga(anchorRecord, saga); return { compensated: true };
      }
    }
  }
  if (saga.status === "compensating") {
    compensateSeedBuyFillSaga(anchorRecord, saga);
    return { compensated: true };
  }

  try {
    for (const leg of saga.itemLegs) {
      if (leg.reserved) {
        continue;
      }
      const reserveResult = marketItemCustody.reserveSeedItem({
        item: leg.sourceItem,
        quantity: leg.quantity,
        sagaID: saga.sagaID,
        actor: saga.sellerCharacterID,
        idempotencyKey: leg.reserveKey,
      });
      if (!reserveResult.success || !reserveResult.data || !reserveResult.data.item) {
        throwWrappedUserError("CustomInfo", {
          info: `Failed to reserve seeded market sale item ${leg.sourceItem.itemID}.`,
        });
      }
      leg.destinationItem = reserveResult.data.item;
      leg.reserveChanges = ensureArray(reserveResult.data.changes);
      leg.reserved = true;
      persistSeedMarketFillSaga(anchorRecord, saga);
    }

    saga.daemonAttempted = true;
    persistSeedMarketFillSaga(anchorRecord, saga);
    saga.fillResponse = await marketDaemonClient.call("FillOrder", {
      order_id: saga.orderID,
      fill_quantity: saga.fillableQuantity,
      idempotency_key: `${saga.operationKey}:daemon-fill`,
    });
    persistSeedMarketFillSaga(anchorRecord, saga);

    if (saga.crossingOrderID) {
      saga.crossingDaemonAttempted = true;
      persistSeedMarketFillSaga(anchorRecord, saga);
      saga.crossingFillResponse = await marketDaemonClient.call("FillOrder", {
        order_id: saga.crossingOrderID,
        fill_quantity: saga.fillableQuantity,
        idempotency_key: `${saga.operationKey}:crossing-daemon-fill`,
      });
    }

    for (const leg of saga.itemLegs) {
      if (leg.consumed) {
        continue;
      }
      const consumeResult = consumeSeedMarketInventoryQuantity(
        leg.destinationItem,
        leg.quantity,
        { idempotencyKey: leg.consumeKey },
      );
      if (!consumeResult.success) {
        throwWrappedUserError("CustomInfo", {
          info: `Failed to consume seeded market sale item ${leg.destinationItem.itemID}.`,
        });
      }
      leg.consumed = true;
      persistSeedMarketFillSaga(anchorRecord, saga);
    }

    const sellerWalletOptions = saga.sellerIsCorp
      ? { isCorp: true, accountKey: saga.sellerAccountKey }
      : {};
    let sellerWalletResult = null;
    if (!saga.sellerCredited) {
      sellerWalletResult = await creditCharacterWallet(
        saga.sellerWalletID,
        saga.grossAmount,
        `Market sale proceeds for ${typeLabel}`,
        saga.destinationStationID,
        {
          ...sellerWalletOptions,
          entryTypeID: JOURNAL_ENTRY_TYPE.MARKET_TRANSACTION,
          ownerID1: saga.stationMarketOwnerID || saga.destinationStationID,
          ownerID2: saga.sellerCharacterID,
          referenceID: saga.destinationStationID,
          idempotencyKey: `${saga.operationKey}:wallet:seller-credit`,
        },
      );
      flushCharacterWalletSagaBoundary("Persisting seeded market seller proceeds");
      saga.sellerCredited = true;
      persistSeedMarketFillSaga(anchorRecord, saga);
    }
    if (saga.salesTax > 0 && !saga.taxDebited) {
      await debitCharacterWallet(
        saga.sellerWalletID,
        saga.salesTax,
        `Transaction tax for sale of ${typeLabel}`,
        saga.destinationStationID,
        {
          ...sellerWalletOptions,
          entryTypeID: JOURNAL_ENTRY_TYPE.TRANSACTION_TAX,
          ownerID1: saga.stationMarketOwnerID || saga.destinationStationID,
          ownerID2: saga.sellerCharacterID,
          referenceID: saga.destinationStationID,
          idempotencyKey: `${saga.operationKey}:wallet:tax-debit`,
        },
      );
      flushCharacterWalletSagaBoundary("Persisting seeded market tax debit");
      saga.taxDebited = true;
      persistSeedMarketFillSaga(anchorRecord, saga);
    }

    if (saga.crossingOrderID) {
      const crossingEscrowRecord = getEscrowRecord(saga.crossingOrderID);
      if (crossingEscrowRecord) {
        if (saga.crossingFillResponse.state === "filled") {
          requireDurableMarketSagaWrite(
            removeEscrowRecordDurable(saga.crossingOrderID),
            `Completing crossing market order ${saga.crossingOrderID}`,
          );
        } else {
          requireDurableMarketSagaWrite(
            putEscrowRecordDurable({
              ...crossingEscrowRecord,
              remainingQuantity: saga.crossingFillResponse.vol_remaining,
              updatedAt: new Date().toISOString(),
            }),
            `Updating crossing market escrow ${saga.crossingOrderID}`,
          );
        }
      }
    }

    requireDurableMarketSagaWrite(
      recordCompletedMarketFillAchievements(saga),
      `Recording market achievement contributions ${saga.operationKey}`,
    );
    persistSeedMarketFillSaga(anchorRecord, saga);

    requireDurableMarketSagaWrite(
      saga.crewSale ? completeCrewSaleSaga(saga) : removeEscrowRecordDurable(saga.anchorOrderID),
      `Completing seeded market fill saga ${saga.operationKey}`,
    );
    return {
      compensated: false,
      fillResponse: saga.fillResponse,
      crossingFillResponse: saga.crossingFillResponse,
      sellerWalletResult,
      sellerInventoryChanges: saga.itemLegs.flatMap(
        (leg) => leg.reserveChanges || [],
      ),
    };
  } catch (error) {
    if (canCompensateRejectedPrimaryFill(saga, error)) {
      compensateSeedBuyFillSaga(anchorRecord, saga);
    } else if (options.scheduleRecovery !== false) {
      await queueDurableMarketFillRecovery(anchorRecord, saga, error);
    }
    throw error;
  }
}

async function executeSeedBuyFillSaga(
  anchorRecord,
  saga,
  typeLabel,
  options = {},
) {
  const operationKey = String(saga && saga.operationKey || "").trim();
  const activePromise = seedMarketFillSagaPromises.get(operationKey);
  if (activePromise) {
    return activePromise;
  }
  const sagaPromise = executeSeedBuyFillSagaUnlocked(
    anchorRecord,
    saga,
    typeLabel,
    options,
  ).finally(() => {
    if (seedMarketFillSagaPromises.get(operationKey) === sagaPromise) {
      seedMarketFillSagaPromises.delete(operationKey);
    }
  });
  seedMarketFillSagaPromises.set(operationKey, sagaPromise);
  return sagaPromise;
}

async function recoverPendingSeedMarketFillSagas() {
  for (const anchorRecord of listEscrowRecords()) {
    const saga = anchorRecord && anchorRecord.pendingFill;
    if (!saga) {
      continue;
    }
    if (saga.direction === "buyer-consumes-seed-sell") {
      await executeSeedSellFillSaga(
        anchorRecord,
        saga,
        getMarketTypeLabel(saga.typeID),
      );
    } else if (saga.direction === "seller-fills-seed-buy") {
      await executeSeedBuyFillSaga(
        anchorRecord,
        saga,
        getMarketTypeLabel(saga.typeID),
      );
    }
  }
}

function buildPlayerSellFillOperationKey({
  orderID,
  availableQuantity,
  tradedQuantity,
  buyerCharacterID,
  sellerCharacterID,
  chargeBuyerWallet = true,
  attempt = 1,
  crossingOrderID = null,
  crossingAvailableQuantity = 0,
} = {}) {
  return [
    "market",
    "player-sell-fill",
    normalizeOrderId(orderID),
    `remaining-${normalizePositiveInteger(availableQuantity, 0)}`,
    `quantity-${normalizePositiveInteger(tradedQuantity, 0)}`,
    `buyer-${normalizePositiveInteger(buyerCharacterID, 0)}`,
    `seller-${normalizePositiveInteger(sellerCharacterID, 0)}`,
    chargeBuyerWallet ? "funding-wallet" : "funding-buy-escrow",
    crossingOrderID
      ? `crossing-${normalizeOrderId(crossingOrderID)}-remaining-${normalizePositiveInteger(crossingAvailableQuantity, 0)}`
      : "crossing-none",
    `attempt-${normalizePositiveInteger(attempt, 1)}`,
  ].join(":");
}

function persistPlayerSellFillSaga(escrowRecord, saga) {
  saga.updatedAt = new Date().toISOString();
  requireDurableMarketSagaWrite(
    putEscrowRecordDurable({
      ...escrowRecord,
      fillAttemptSequence: saga.attempt,
      pendingFill: saga,
      updatedAt: saga.updatedAt,
    }),
    `Persisting market fill saga ${saga.operationKey}`,
  );
}

function buildPlayerSellFillSaga({
  sellOrder,
  escrowRecord,
  sellerCharacterID,
  sellerWalletID = null,
  sellerIsCorp = false,
  sellerAccountKey = null,
  buyerCharacterID,
  buyerWalletID = null,
  buyerIsCorp = false,
  buyerAccountKey = null,
  destinationStationID,
  typeID,
  tradedQuantity,
  availableQuantity,
  orderPrice,
  grossCost,
  salesTax,
  stationMarketOwnerID,
  chargeBuyerWallet = true,
  crossingOrderID = null,
  crossingOrderPrice = 0,
  crossingAvailableQuantity = 0,
} = {}) {
  const orderID = normalizeOrderId(sellOrder && sellOrder.order_id);
  const attempt = normalizePositiveInteger(
    escrowRecord && escrowRecord.fillAttemptSequence,
    0,
  ) + 1;
  const operationKey = buildPlayerSellFillOperationKey({
    orderID,
    availableQuantity,
    tradedQuantity,
    buyerCharacterID,
    sellerCharacterID,
    chargeBuyerWallet,
    attempt,
    crossingOrderID,
    crossingAvailableQuantity,
  });
  const itemLegs = [];
  let escrowRemaining = normalizePositiveInteger(tradedQuantity, 0);
  for (const escrowItem of listEscrowItemsForOrder(orderID, sellerCharacterID)) {
    if (escrowRemaining <= 0) {
      break;
    }
    const itemQuantity =
      normalizeInteger(escrowItem && escrowItem.singleton, 0) === 1
        ? 1
        : normalizePositiveInteger(escrowItem && escrowItem.stacksize, 0);
    const quantity = Math.min(escrowRemaining, itemQuantity);
    itemLegs.push({
      sourceItem: escrowItem,
      quantity,
      forwardKey: `${operationKey}:inventory:${itemLegs.length}`,
      compensationKey: `${operationKey}:inventory-compensate:${itemLegs.length}`,
      destinationItem: null,
      compensated: false,
    });
    escrowRemaining -= quantity;
  }
  if (escrowRemaining > 0) {
    throwWrappedUserError("CustomInfo", {
      info: `Escrow for sell order ${orderID} did not contain enough items.`,
    });
  }

  return {
    schemaVersion: 1,
    direction: "buyer-consumes-player-sell",
    operationKey,
    attempt,
    status: "forward",
    orderID,
    buyerCharacterID,
    // Wallet targets for the ISK side only; item custody above stays keyed
    // to buyerCharacterID/sellerCharacterID regardless of these.
    buyerWalletID: buyerWalletID || buyerCharacterID,
    buyerIsCorp,
    buyerAccountKey,
    sellerCharacterID,
    sellerWalletID: sellerWalletID || sellerCharacterID,
    sellerIsCorp,
    sellerAccountKey,
    destinationStationID,
    typeID,
    tradedQuantity,
    availableQuantity,
    orderPrice,
    grossCost,
    salesTax,
    stationMarketOwnerID,
    chargeBuyerWallet: chargeBuyerWallet !== false,
    crossingOrderID: crossingOrderID
      ? normalizeOrderId(crossingOrderID)
      : null,
    crossingOrderPrice: roundIsk(crossingOrderPrice),
    crossingAvailableQuantity: normalizePositiveInteger(
      crossingAvailableQuantity,
      0,
    ),
    priceImprovementRefund: crossingOrderID
      ? Math.max(
          0,
          roundIsk(
            computeOrderValue(crossingOrderPrice, tradedQuantity) - grossCost,
          ),
        )
      : 0,
    priceImprovementRefunded: false,
    crossingDaemonAttempted: false,
    crossingFillResponse: null,
    itemLegs,
    buyerDebited: false,
    sellerCredited: false,
    taxDebited: false,
    daemonAttempted: false,
    fillResponse: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

async function compensatePlayerSellFillSaga(escrowRecord, saga, typeLabel) {
  saga.status = "compensating";
  persistPlayerSellFillSaga(escrowRecord, saga);
  const sellerWalletOptions = {
    ...(saga.sellerIsCorp ? { isCorp: true, accountKey: saga.sellerAccountKey } : {}),
    ownerID1: saga.buyerCharacterID,
    ownerID2: saga.sellerCharacterID,
    referenceID: saga.destinationStationID,
  };
  const buyerWalletOptions = saga.buyerIsCorp
    ? { isCorp: true, accountKey: saga.buyerAccountKey }
    : {};

  if (saga.taxDebited) {
    await creditCharacterWallet(
      saga.sellerWalletID,
      saga.salesTax,
      `Transaction tax rollback for sale of ${typeLabel}`,
      saga.destinationStationID,
      {
        ...(saga.sellerIsCorp ? { isCorp: true, accountKey: saga.sellerAccountKey } : {}),
        entryTypeID: JOURNAL_ENTRY_TYPE.TRANSACTION_TAX,
        ownerID1: saga.stationMarketOwnerID || saga.destinationStationID,
        ownerID2: saga.sellerCharacterID,
        referenceID: saga.destinationStationID,
        idempotencyKey: `${saga.operationKey}:wallet:tax-compensate`,
      },
    );
    flushCharacterWalletSagaBoundary("Persisting market tax compensation");
    saga.taxDebited = false;
    persistPlayerSellFillSaga(escrowRecord, saga);
  }

  if (saga.sellerCredited) {
    await debitCharacterWallet(
      saga.sellerWalletID,
      saga.grossCost,
      `Market sale proceeds rollback for ${typeLabel}`,
      saga.buyerCharacterID,
      {
        entryTypeID: JOURNAL_ENTRY_TYPE.MARKET_TRANSACTION,
        ...sellerWalletOptions,
        idempotencyKey: `${saga.operationKey}:wallet:seller-compensate`,
      },
    );
    flushCharacterWalletSagaBoundary("Persisting seller proceeds compensation");
    saga.sellerCredited = false;
    persistPlayerSellFillSaga(escrowRecord, saga);
  }

  if (saga.priceImprovementRefunded) {
    await debitCharacterWallet(
      saga.buyerWalletID,
      saga.priceImprovementRefund,
      `Market price improvement rollback for ${typeLabel}`,
      saga.destinationStationID,
      {
        ...buyerWalletOptions,
        entryTypeID: JOURNAL_ENTRY_TYPE.MARKET_ESCROW,
        ownerID1: saga.stationMarketOwnerID || saga.destinationStationID,
        ownerID2: saga.buyerCharacterID,
        referenceID: saga.destinationStationID,
        idempotencyKey: `${saga.operationKey}:wallet:price-improvement-compensate`,
      },
    );
    flushCharacterWalletSagaBoundary("Persisting price improvement compensation");
    saga.priceImprovementRefunded = false;
    persistPlayerSellFillSaga(escrowRecord, saga);
  }

  for (let index = saga.itemLegs.length - 1; index >= 0; index -= 1) {
    const leg = saga.itemLegs[index];
    if (!leg.destinationItem || leg.compensated) {
      continue;
    }
    const compensationResult = marketItemCustody.transferItem({
      item: leg.destinationItem,
      ownerID: saga.sellerCharacterID,
      locationID: marketItemCustody.getEscrowLocationID(saga.orderID),
      flagID: ITEM_FLAGS.HANGAR,
      quantity: leg.quantity,
      orderID: saga.orderID,
      actor: saga.sellerCharacterID,
      reason: itemCustody.CUSTODY_REASON.MARKET_FILL_COMPENSATE,
      idempotencyKey: leg.compensationKey,
    });
    if (!compensationResult.success) {
      throwWrappedUserError("CustomInfo", {
        info: `Failed to compensate market item ${leg.destinationItem.itemID}.`,
      });
    }
    leg.compensated = true;
    persistPlayerSellFillSaga(escrowRecord, saga);
  }

  if (saga.buyerDebited) {
    await creditCharacterWallet(
      saga.buyerWalletID,
      saga.grossCost,
      `Market purchase refund for ${typeLabel}`,
      saga.destinationStationID,
      {
        ...buyerWalletOptions,
        entryTypeID: JOURNAL_ENTRY_TYPE.MARKET_TRANSACTION,
        ownerID1: saga.buyerCharacterID,
        ownerID2: saga.sellerCharacterID,
        referenceID: saga.destinationStationID,
        idempotencyKey: `${saga.operationKey}:wallet:buyer-compensate`,
      },
    );
    flushCharacterWalletSagaBoundary("Persisting buyer refund compensation");
    saga.buyerDebited = false;
    persistPlayerSellFillSaga(escrowRecord, saga);
  }

  requireDurableMarketSagaWrite(
    putEscrowRecordDurable({
      ...escrowRecord,
      fillAttemptSequence: saga.attempt,
      pendingFill: null,
      updatedAt: new Date().toISOString(),
    }),
    `Clearing compensated market fill saga ${saga.operationKey}`,
  );
}

async function executePlayerSellFillSagaUnlocked(
  escrowRecord,
  saga,
  typeLabel,
  options = {},
) {
  if (saga.status === "compensating") {
    await compensatePlayerSellFillSaga(escrowRecord, saga, typeLabel);
    return { compensated: true };
  }

  try {
    const buyerWalletOptions = saga.buyerIsCorp
      ? { isCorp: true, accountKey: saga.buyerAccountKey }
      : {};
    const sellerWalletOptions = saga.sellerIsCorp
      ? { isCorp: true, accountKey: saga.sellerAccountKey }
      : {};
    let buyerWalletResult = null;
    let sellerWalletResult = null;
    if (saga.chargeBuyerWallet !== false && !saga.buyerDebited) {
      buyerWalletResult = await debitCharacterWallet(
        saga.buyerWalletID,
        saga.grossCost,
        `Market purchase of ${typeLabel}`,
        saga.destinationStationID,
        {
          ...buyerWalletOptions,
          entryTypeID: JOURNAL_ENTRY_TYPE.MARKET_TRANSACTION,
          ownerID1: saga.buyerCharacterID,
          ownerID2: saga.sellerCharacterID,
          referenceID: saga.destinationStationID,
          idempotencyKey: `${saga.operationKey}:wallet:buyer-debit`,
        },
      );
      flushCharacterWalletSagaBoundary("Persisting market buyer debit");
      saga.buyerDebited = true;
      persistPlayerSellFillSaga(escrowRecord, saga);
    }

    for (const leg of saga.itemLegs) {
      if (leg.destinationItem) {
        continue;
      }
      const moveResult = marketItemCustody.transferItem({
        item: leg.sourceItem,
        ownerID: saga.buyerCharacterID,
        locationID: saga.destinationStationID,
        flagID: ITEM_FLAGS.HANGAR,
        quantity: leg.quantity,
        orderID: saga.orderID,
        actor: saga.buyerCharacterID,
        reason: itemCustody.CUSTODY_REASON.MARKET_ESCROW_DELIVER,
        idempotencyKey: leg.forwardKey,
      });
      if (!moveResult.success || !(moveResult.data && moveResult.data.item)) {
        throwWrappedUserError("CustomInfo", {
          info: `Failed to move escrowed market item ${leg.sourceItem.itemID} to the buyer.`,
        });
      }
      leg.destinationItem = moveResult.data.item;
      persistPlayerSellFillSaga(escrowRecord, saga);
    }

    if (!saga.sellerCredited) {
      sellerWalletResult = await creditCharacterWallet(
        saga.sellerWalletID,
        saga.grossCost,
        `Market sale proceeds for ${typeLabel}`,
        saga.buyerCharacterID,
        {
          ...sellerWalletOptions,
          entryTypeID: JOURNAL_ENTRY_TYPE.MARKET_TRANSACTION,
          ownerID1: saga.buyerCharacterID,
          ownerID2: saga.sellerCharacterID,
          referenceID: saga.destinationStationID,
          idempotencyKey: `${saga.operationKey}:wallet:seller-credit`,
        },
      );
      flushCharacterWalletSagaBoundary("Persisting market seller credit");
      saga.sellerCredited = true;
      persistPlayerSellFillSaga(escrowRecord, saga);
    }

    if (saga.salesTax > 0 && !saga.taxDebited) {
      await debitCharacterWallet(
        saga.sellerWalletID,
        saga.salesTax,
        `Transaction tax for sale of ${typeLabel}`,
        saga.destinationStationID,
        {
          ...sellerWalletOptions,
          entryTypeID: JOURNAL_ENTRY_TYPE.TRANSACTION_TAX,
          ownerID1: saga.stationMarketOwnerID || saga.destinationStationID,
          ownerID2: saga.sellerCharacterID,
          referenceID: saga.destinationStationID,
          idempotencyKey: `${saga.operationKey}:wallet:tax-debit`,
        },
      );
      flushCharacterWalletSagaBoundary("Persisting market tax debit");
      saga.taxDebited = true;
      persistPlayerSellFillSaga(escrowRecord, saga);
    }

    if (saga.priceImprovementRefund > 0 && !saga.priceImprovementRefunded) {
      await creditCharacterWallet(
        saga.buyerWalletID,
        saga.priceImprovementRefund,
        `Market price improvement refund for ${typeLabel} order ${saga.crossingOrderID}`,
        saga.destinationStationID,
        {
          ...buyerWalletOptions,
          entryTypeID: JOURNAL_ENTRY_TYPE.MARKET_ESCROW,
          ownerID1: saga.stationMarketOwnerID || saga.destinationStationID,
          ownerID2: saga.buyerCharacterID,
          referenceID: saga.destinationStationID,
          idempotencyKey: `${saga.operationKey}:wallet:price-improvement-refund`,
        },
      );
      flushCharacterWalletSagaBoundary("Persisting market price improvement refund");
      saga.priceImprovementRefunded = true;
      persistPlayerSellFillSaga(escrowRecord, saga);
    }

    saga.daemonAttempted = true;
    persistPlayerSellFillSaga(escrowRecord, saga);
    const fillResponse = await marketDaemonClient.call("FillOrder", {
      order_id: saga.orderID,
      fill_quantity: saga.tradedQuantity,
      idempotency_key: `${saga.operationKey}:daemon-fill`,
    });
    saga.fillResponse = fillResponse;
    persistPlayerSellFillSaga(escrowRecord, saga);

    if (saga.crossingOrderID) {
      saga.crossingDaemonAttempted = true;
      persistPlayerSellFillSaga(escrowRecord, saga);
      saga.crossingFillResponse = await marketDaemonClient.call("FillOrder", {
        order_id: saga.crossingOrderID,
        fill_quantity: saga.tradedQuantity,
        idempotency_key: `${saga.operationKey}:crossing-daemon-fill`,
      });
      const crossingEscrowRecord = getEscrowRecord(saga.crossingOrderID);
      if (crossingEscrowRecord) {
        if (saga.crossingFillResponse.state === "filled") {
          requireDurableMarketSagaWrite(
            removeEscrowRecordDurable(saga.crossingOrderID),
            `Completing crossing market order ${saga.crossingOrderID}`,
          );
        } else {
          requireDurableMarketSagaWrite(
            putEscrowRecordDurable({
              ...crossingEscrowRecord,
              remainingQuantity: saga.crossingFillResponse.vol_remaining,
              escrowAmount: computeOrderValue(
                saga.crossingOrderPrice,
                saga.crossingFillResponse.vol_remaining,
              ),
              updatedAt: new Date().toISOString(),
            }),
            `Updating crossing market escrow ${saga.crossingOrderID}`,
          );
        }
      }
    }

    requireDurableMarketSagaWrite(
      recordCompletedMarketFillAchievements(saga),
      `Recording market achievement contributions ${saga.operationKey}`,
    );
    persistPlayerSellFillSaga(escrowRecord, saga);

    if (fillResponse.state === "filled") {
      requireDurableMarketSagaWrite(
        removeEscrowRecordDurable(saga.orderID),
        `Completing market fill saga ${saga.operationKey}`,
      );
    } else {
      requireDurableMarketSagaWrite(
        putEscrowRecordDurable({
          ...escrowRecord,
          fillAttemptSequence: saga.attempt,
          remainingQuantity: fillResponse.vol_remaining,
          pendingFill: null,
          updatedAt: new Date().toISOString(),
        }),
        `Completing market fill saga ${saga.operationKey}`,
      );
    }

    return {
      compensated: false,
      fillResponse,
      crossingFillResponse: saga.crossingFillResponse,
      buyerWalletResult,
      sellerWalletResult,
      buyerChanges: saga.itemLegs.map((leg) => ({ item: leg.destinationItem })),
    };
  } catch (error) {
    if (canCompensateRejectedPrimaryFill(saga, error)) {
      await compensatePlayerSellFillSaga(escrowRecord, saga, typeLabel);
    } else if (options.scheduleRecovery !== false) {
      await queueDurableMarketFillRecovery(escrowRecord, saga, error);
    }
    throw error;
  }
}

async function executePlayerSellFillSaga(
  escrowRecord,
  saga,
  typeLabel,
  options = {},
) {
  const operationKey = String(saga && saga.operationKey || "").trim();
  const activePromise = playerSellFillSagaPromises.get(operationKey);
  if (activePromise) {
    return activePromise;
  }
  const sagaPromise = executePlayerSellFillSagaUnlocked(
    escrowRecord,
    saga,
    typeLabel,
    options,
  ).finally(() => {
    if (playerSellFillSagaPromises.get(operationKey) === sagaPromise) {
      playerSellFillSagaPromises.delete(operationKey);
    }
  });
  playerSellFillSagaPromises.set(operationKey, sagaPromise);
  return sagaPromise;
}

async function recoverPendingPlayerSellFillSagas() {
  for (const escrowRecord of listEscrowRecords()) {
    const saga = escrowRecord && escrowRecord.pendingFill;
    if (!saga || saga.direction !== "buyer-consumes-player-sell") {
      continue;
    }
    await executePlayerSellFillSaga(
      escrowRecord,
      saga,
      getMarketTypeLabel(saga.typeID),
    );
  }
}

async function matchSellOrdersForBuyer({
  session,
  buyerCharacterID,
  buyerOwner = null,
  regionID,
  typeID,
  maxPrice,
  requestedQuantity,
  orderRange,
  currentStationID,
  currentSolarSystemID,
  chargeBuyerWallet = true,
  crossingOrderID = null,
  crossingOrderPrice = 0,
  crossingOrderAvailableQuantity = 0,
} = {}) {
  // `buyerCharacterID` stays the acting character throughout (item delivery,
  // tax/skill context, notifications); `resolvedBuyerOwner` names whose
  // wallet actually pays - passed down only to the wallet-touching legs of
  // the fill sagas below.
  const resolvedBuyerOwner =
    buyerOwner || { isCorp: false, id: buyerCharacterID, accountKey: null };
  const buyerWalletOptions = resolvedBuyerOwner.isCorp
    ? { isCorp: true, accountKey: resolvedBuyerOwner.accountKey }
    : {};
  const buyerWalletID = resolvedBuyerOwner.isCorp
    ? resolvedBuyerOwner.id
    : buyerCharacterID;
  const book = await marketDaemonClient.call("GetOrders", {
    region_id: regionID,
    type_id: typeID,
  });
  const typeLabel = getMarketTypeLabel(typeID);
  const structureMarketAccess = createStructureMarketRowAccessScope(
    session,
    Date.now(),
  );

  let remainingQuantity = normalizePositiveInteger(requestedQuantity, 0);
  let totalSpent = 0;
  let totalBought = 0;
  let crossingRemainingQuantity = normalizePositiveInteger(
    crossingOrderAvailableQuantity,
    0,
  );
  let crossingFillResponse = null;

  for (const sellOrder of structureMarketAccess.filterRows(
    book && book.sells,
  )) {
    if (remainingQuantity <= 0) {
      break;
    }

    if (hasPendingMarketFillSagaForOrder(sellOrder && sellOrder.order_id)) {
      continue;
    }

    const orderPrice = Number(sellOrder && sellOrder.price) || 0;
    if (!(orderPrice > 0) || orderPrice - 0.0001 > Number(maxPrice || 0)) {
      continue;
    }

    const availableQuantity = normalizePositiveInteger(
      sellOrder && sellOrder.vol_remaining,
      0,
    );
    if (availableQuantity <= 0) {
      continue;
    }

    if (
      !isSellOrderInRange(
        sellOrder,
        currentStationID,
        currentSolarSystemID,
        orderRange,
      )
    ) {
      continue;
    }

    const tradedQuantity = Math.min(remainingQuantity, availableQuantity);
    const destinationStationID = normalizePositiveInteger(
      sellOrder && sellOrder.station_id,
      currentStationID,
    );
    const grossCost = roundIsk(orderPrice * tradedQuantity);
    const isSeedSellOrder =
      String(sellOrder && sellOrder.source || "").toLowerCase() === "seed";
    const stationMarketOwnerID = getMarketCounterpartyOwnerID(
      destinationStationID,
    );
    const marketCounterpartyOwnerID =
      isSeedSellOrder ? stationMarketOwnerID : 0;
    let purchaseCounterpartyID =
      marketCounterpartyOwnerID || destinationStationID;
    let buyerWalletResult = null;

    try {
      if (isSeedSellOrder) {
        const saga = buildSeedSellFillSaga({
          sellOrder,
          buyerCharacterID,
          buyerWalletID,
          buyerIsCorp: resolvedBuyerOwner.isCorp,
          buyerAccountKey: resolvedBuyerOwner.accountKey,
          destinationStationID,
          typeID,
          tradedQuantity,
          availableQuantity,
          orderPrice,
          grossCost,
          stationMarketOwnerID,
          chargeBuyerWallet,
          crossingOrderID,
          crossingOrderPrice,
          crossingAvailableQuantity: crossingRemainingQuantity,
        });
        const anchorRecord = {
          orderId: saga.anchorOrderID,
          escrowType: "seed-fill",
          pendingFill: saga,
          createdAt: saga.createdAt,
          updatedAt: saga.updatedAt,
        };
        persistSeedMarketFillSaga(anchorRecord, saga);
        const sagaResult = await executeSeedSellFillSaga(
          anchorRecord,
          saga,
          typeLabel,
        );
        buyerWalletResult = sagaResult.buyerWalletResult;
        if (sagaResult.crossingFillResponse) {
          crossingFillResponse = sagaResult.crossingFillResponse;
          crossingRemainingQuantity = normalizePositiveInteger(
            crossingFillResponse.vol_remaining,
            0,
          );
        }
        notifyBuyerDelivery(buyerCharacterID, sagaResult.buyerChanges);
      } else {
        const playerSellOrder = await fetchOrderById(sellOrder && sellOrder.order_id);
        // The escrow record - our own bookkeeping - is the source of truth
        // for who this sell order's items belong to (always the listing
        // character; see the "wallet only" scope note in
        // executeSellEntryUnlocked). The daemon's own order.owner_id can be
        // a corporation for a corp-wallet sell order, which is why item
        // custody must not be keyed off it.
        const escrowRecord = getEscrowRecord(sellOrder && sellOrder.order_id);
        const sellerCharacterID = normalizePositiveInteger(
          escrowRecord && escrowRecord.ownerId,
          0,
        );
        if (!sellerCharacterID || !escrowRecord) {
          throwWrappedUserError("CustomInfo", {
            info: `Market sell order ${normalizeOrderId(sellOrder && sellOrder.order_id)} is missing escrow state.`,
          });
        }
        const sellerOwner = escrowRecord.isCorp
          ? {
              isCorp: true,
              id: normalizePositiveInteger(escrowRecord.walletOwnerId, 0),
              accountKey: escrowRecord.accountKey,
            }
          : { isCorp: false, id: sellerCharacterID, accountKey: null };
        const sellerWalletID = sellerOwner.isCorp ? sellerOwner.id : sellerCharacterID;
        purchaseCounterpartyID = sellerCharacterID;
        const grossAmount = roundIsk(orderPrice * tradedQuantity);
        const sellerMarketContext = buildCharacterMarketContext(
          null,
          sellerCharacterID,
          destinationStationID,
        );
        const salesTax = computeSalesTaxAmount(sellerMarketContext, grossAmount);
        const saga = buildPlayerSellFillSaga({
          sellOrder,
          escrowRecord,
          sellerCharacterID,
          sellerWalletID,
          sellerIsCorp: sellerOwner.isCorp,
          sellerAccountKey: sellerOwner.accountKey,
          buyerCharacterID,
          buyerWalletID,
          buyerIsCorp: resolvedBuyerOwner.isCorp,
          buyerAccountKey: resolvedBuyerOwner.accountKey,
          destinationStationID,
          typeID,
          tradedQuantity,
          availableQuantity,
          orderPrice,
          grossCost,
          salesTax,
          stationMarketOwnerID,
          chargeBuyerWallet,
          crossingOrderID,
          crossingOrderPrice,
          crossingAvailableQuantity: crossingRemainingQuantity,
        });
        persistPlayerSellFillSaga(escrowRecord, saga);
        const sagaResult = await executePlayerSellFillSaga(
          escrowRecord,
          saga,
          typeLabel,
        );
        const fillResponse = sagaResult.fillResponse;
        if (sagaResult.crossingFillResponse) {
          crossingFillResponse = sagaResult.crossingFillResponse;
          crossingRemainingQuantity = normalizePositiveInteger(
            crossingFillResponse.vol_remaining,
            0,
          );
        }
        buyerWalletResult = sagaResult.buyerWalletResult;
        const sellerWalletResult = sagaResult.sellerWalletResult;

        notifyBuyerDelivery(buyerCharacterID, sagaResult.buyerChanges);
        try {
          await recordTrade(typeID, orderPrice, tradedQuantity);
        } catch (error) {
          log.warn(
            `[MarketProxy] Failed to record committed fill ${saga.operationKey}: ${error.message}`,
          );
        }
        await recordMarketTransactionForWalletOwner(resolvedBuyerOwner, {
          transactionDate: buyerWalletResult && buyerWalletResult.journalEntry
            ? buyerWalletResult.journalEntry.transactionDate
            : null,
          typeID,
          quantity: tradedQuantity,
          price: orderPrice,
          stationID: destinationStationID,
          buyerID: buyerWalletID,
          sellerID: sellerWalletID,
          clientID: sellerWalletID,
          journalRefID:
            buyerWalletResult && buyerWalletResult.journalEntry
              ? buyerWalletResult.journalEntry.transactionID
              : -1,
        });
        await recordMarketTransactionForWalletOwner(sellerOwner, {
          transactionDate: sellerWalletResult && sellerWalletResult.journalEntry
            ? sellerWalletResult.journalEntry.transactionDate
            : null,
          typeID,
          quantity: tradedQuantity,
          price: orderPrice,
          stationID: destinationStationID,
          buyerID: buyerWalletID,
          sellerID: sellerWalletID,
          clientID: buyerWalletID,
          journalRefID:
            sellerWalletResult && sellerWalletResult.journalEntry
              ? sellerWalletResult.journalEntry.transactionID
              : -1,
        });

        notifyOwnOrdersChanged(
          sellerCharacterID,
          [{
            ...playerSellOrder,
            row: {
              ...getOwnerOrderResponseOrder(playerSellOrder),
              vol_remaining: fillResponse.vol_remaining,
              price: fillResponse.price,
            },
            state: fillResponse.state,
          }],
          fillResponse.state === "filled" ? ORDER_REASON_FILLED : ORDER_REASON_PARTIAL,
          sellerOwner.isCorp,
        );
      }
      if (String(sellOrder && sellOrder.source || "").toLowerCase() === "seed") {
        await recordMarketTransactionForWalletOwner(resolvedBuyerOwner, {
          transactionDate: buyerWalletResult && buyerWalletResult.journalEntry
            ? buyerWalletResult.journalEntry.transactionDate
            : null,
          typeID,
          quantity: tradedQuantity,
          price: orderPrice,
          stationID: destinationStationID,
          buyerID: buyerWalletID,
          sellerID: marketCounterpartyOwnerID,
          clientID: marketCounterpartyOwnerID,
          journalRefID:
            buyerWalletResult && buyerWalletResult.journalEntry
              ? buyerWalletResult.journalEntry.transactionID
              : -1,
        });
      }
    } catch (error) {
      throw error;
    }

    totalSpent = roundIsk(totalSpent + grossCost);
    totalBought += tradedQuantity;
    remainingQuantity -= tradedQuantity;
  }

  return {
    boughtQuantity: totalBought,
    remainingQuantity,
    totalSpent: roundIsk(totalSpent),
    crossingFillResponse,
  };
}

function buildPlayerBuyFillOperationKey({
  orderID,
  availableQuantity,
  fillableQuantity,
  buyerCharacterID,
  sellerCharacterID,
  sourceOrderID,
  sourceItemID,
  attempt,
  crossingOrderID = null,
  crossingAvailableQuantity = 0,
} = {}) {
  return [
    "market",
    "player-buy-fill",
    normalizeOrderId(orderID),
    `remaining-${normalizePositiveInteger(availableQuantity, 0)}`,
    `quantity-${normalizePositiveInteger(fillableQuantity, 0)}`,
    `buyer-${normalizePositiveInteger(buyerCharacterID, 0)}`,
    `seller-${normalizePositiveInteger(sellerCharacterID, 0)}`,
    normalizePositiveInteger(sourceOrderID, 0) > 0
      ? `source-order-${normalizeOrderId(sourceOrderID)}`
      : `source-item-${normalizePositiveInteger(sourceItemID, 0)}`,
    crossingOrderID
      ? `crossing-${normalizeOrderId(crossingOrderID)}-remaining-${normalizePositiveInteger(crossingAvailableQuantity, 0)}`
      : "crossing-none",
    `attempt-${normalizePositiveInteger(attempt, 1)}`,
  ].join(":");
}

function persistPlayerBuyFillSaga(escrowRecord, saga) {
  saga.updatedAt = new Date().toISOString();
  requireDurableMarketSagaWrite(
    putEscrowRecordDurable({
      ...escrowRecord,
      fillAttemptSequence: saga.attempt,
      pendingFill: saga,
      updatedAt: saga.updatedAt,
    }),
    `Persisting market fill saga ${saga.operationKey}`,
  );
}

function buildPlayerBuyFillSaga({
  buyOrder,
  escrowRecord,
  buyerCharacterID,
  sellerCharacterID,
  sellerWalletID = null,
  sellerIsCorp = false,
  sellerAccountKey = null,
  destinationStationID,
  typeID,
  fillableQuantity,
  availableQuantity,
  orderPrice,
  grossAmount,
  salesTax,
  stationMarketOwnerID,
  sourceItemID,
  sourceOrderID,
  crossingOrderID = null,
  crossingAvailableQuantity = 0,
} = {}) {
  const orderID = normalizeOrderId(buyOrder && buyOrder.order_id);
  const normalizedSourceOrderID = normalizePositiveInteger(sourceOrderID, 0);
  const attempt = normalizePositiveInteger(
    escrowRecord && escrowRecord.fillAttemptSequence,
    0,
  ) + 1;
  const operationKey = buildPlayerBuyFillOperationKey({
    orderID,
    availableQuantity,
    fillableQuantity,
    buyerCharacterID,
    sellerCharacterID,
    sourceOrderID: normalizedSourceOrderID,
    sourceItemID,
    attempt,
    crossingOrderID,
    crossingAvailableQuantity,
  });
  const sourceItems = normalizedSourceOrderID > 0
    ? listEscrowItemsForOrder(normalizedSourceOrderID, sellerCharacterID)
    : [findItemById(sourceItemID)].filter(Boolean);
  const itemLegs = [];
  let sourceRemaining = normalizePositiveInteger(fillableQuantity, 0);
  for (const sourceItem of sourceItems) {
    if (sourceRemaining <= 0) {
      break;
    }
    const itemQuantity =
      normalizeInteger(sourceItem && sourceItem.singleton, 0) === 1
        ? 1
        : normalizePositiveInteger(sourceItem && sourceItem.stacksize, 0);
    const quantity = Math.min(sourceRemaining, itemQuantity);
    itemLegs.push({
      sourceItem,
      quantity,
      forwardKey: `${operationKey}:inventory:${itemLegs.length}`,
      compensationKey: `${operationKey}:inventory-compensate:${itemLegs.length}`,
      destinationItem: null,
      changes: [],
      compensated: false,
    });
    sourceRemaining -= quantity;
  }
  if (sourceRemaining > 0) {
    throwWrappedUserError("CustomInfo", {
      info: normalizedSourceOrderID > 0
        ? `Escrow for sell order ${normalizeOrderId(normalizedSourceOrderID)} did not contain enough items.`
        : `Inventory item ${normalizePositiveInteger(sourceItemID, 0)} did not contain enough items.`,
    });
  }

  return {
    schemaVersion: 1,
    direction: "seller-fills-player-buy",
    operationKey,
    attempt,
    status: "forward",
    orderID,
    buyerCharacterID,
    sellerCharacterID,
    // Wallet target for the ISK side only; item custody above stays keyed to
    // sellerCharacterID.
    sellerWalletID: sellerWalletID || sellerCharacterID,
    sellerIsCorp,
    sellerAccountKey,
    destinationStationID,
    typeID,
    fillableQuantity,
    availableQuantity,
    orderPrice,
    grossAmount,
    salesTax,
    stationMarketOwnerID,
    sourceOrderID: normalizedSourceOrderID || null,
    crossingOrderID: crossingOrderID
      ? normalizeOrderId(crossingOrderID)
      : null,
    crossingAvailableQuantity: normalizePositiveInteger(
      crossingAvailableQuantity,
      0,
    ),
    crossingDaemonAttempted: false,
    crossingFillResponse: null,
    itemLegs,
    sellerCredited: false,
    taxDebited: false,
    daemonAttempted: false,
    fillResponse: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

async function compensatePlayerBuyFillSaga(escrowRecord, saga, typeLabel) {
  saga.status = "compensating";
  persistPlayerBuyFillSaga(escrowRecord, saga);
  const sellerWalletOptions = saga.sellerIsCorp
    ? { isCorp: true, accountKey: saga.sellerAccountKey }
    : {};

  if (saga.taxDebited) {
    await creditCharacterWallet(
      saga.sellerWalletID,
      saga.salesTax,
      `Transaction tax rollback for sale of ${typeLabel}`,
      saga.destinationStationID,
      {
        ...sellerWalletOptions,
        entryTypeID: JOURNAL_ENTRY_TYPE.TRANSACTION_TAX,
        ownerID1: saga.stationMarketOwnerID || saga.destinationStationID,
        ownerID2: saga.sellerCharacterID,
        referenceID: saga.destinationStationID,
        idempotencyKey: `${saga.operationKey}:wallet:tax-compensate`,
      },
    );
    flushCharacterWalletSagaBoundary("Persisting market tax compensation");
    saga.taxDebited = false;
    persistPlayerBuyFillSaga(escrowRecord, saga);
  }

  if (saga.sellerCredited) {
    await debitCharacterWallet(
      saga.sellerWalletID,
      saga.grossAmount,
      `Market sale proceeds rollback for ${typeLabel}`,
      saga.buyerCharacterID,
      {
        ...sellerWalletOptions,
        entryTypeID: JOURNAL_ENTRY_TYPE.MARKET_TRANSACTION,
        ownerID1: saga.buyerCharacterID,
        ownerID2: saga.sellerCharacterID,
        referenceID: saga.destinationStationID,
        idempotencyKey: `${saga.operationKey}:wallet:seller-compensate`,
      },
    );
    flushCharacterWalletSagaBoundary("Persisting seller proceeds compensation");
    saga.sellerCredited = false;
    persistPlayerBuyFillSaga(escrowRecord, saga);
  }

  for (let index = saga.itemLegs.length - 1; index >= 0; index -= 1) {
    const leg = saga.itemLegs[index];
    if (!leg.destinationItem || leg.compensated) {
      continue;
    }
    const compensationResult = marketItemCustody.transferItem({
      item: leg.destinationItem,
      ownerID: saga.sellerCharacterID,
      locationID: leg.sourceItem.locationID,
      flagID: leg.sourceItem.flagID,
      quantity: leg.quantity,
      ...(saga.sourceOrderID ? { orderID: saga.sourceOrderID } : {}),
      actor: saga.sellerCharacterID,
      reason: itemCustody.CUSTODY_REASON.MARKET_FILL_COMPENSATE,
      idempotencyKey: leg.compensationKey,
    });
    if (!compensationResult.success) {
      throwWrappedUserError("CustomInfo", {
        info: `Failed to compensate market item ${leg.destinationItem.itemID}.`,
      });
    }
    leg.compensated = true;
    persistPlayerBuyFillSaga(escrowRecord, saga);
  }

  requireDurableMarketSagaWrite(
    putEscrowRecordDurable({
      ...escrowRecord,
      fillAttemptSequence: saga.attempt,
      pendingFill: null,
      updatedAt: new Date().toISOString(),
    }),
    `Clearing compensated market fill saga ${saga.operationKey}`,
  );
}

async function executePlayerBuyFillSagaUnlocked(
  escrowRecord,
  saga,
  typeLabel,
  options = {},
) {
  if (saga.status === "compensating") {
    await compensatePlayerBuyFillSaga(escrowRecord, saga, typeLabel);
    return { compensated: true };
  }

  try {
    const sellerWalletOptions = saga.sellerIsCorp
      ? { isCorp: true, accountKey: saga.sellerAccountKey }
      : {};
    let sellerWalletResult = null;
    for (const leg of saga.itemLegs) {
      if (leg.destinationItem) {
        continue;
      }
      const moveResult = marketItemCustody.transferItem({
        item: leg.sourceItem,
        ownerID: saga.buyerCharacterID,
        locationID: saga.destinationStationID,
        flagID: ITEM_FLAGS.HANGAR,
        quantity: leg.quantity,
        ...(saga.sourceOrderID ? { orderID: saga.sourceOrderID } : {}),
        actor: saga.sellerCharacterID,
        reason: saga.sourceOrderID
          ? itemCustody.CUSTODY_REASON.MARKET_ESCROW_DELIVER
          : itemCustody.CUSTODY_REASON.MARKET_DIRECT_DELIVER,
        idempotencyKey: leg.forwardKey,
      });
      if (!moveResult.success || !(moveResult.data && moveResult.data.item)) {
        throwWrappedUserError("CustomInfo", {
          info: `Failed to transfer sold item ${leg.sourceItem.itemID} into buyer delivery.`,
        });
      }
      leg.destinationItem = moveResult.data.item;
      leg.changes = ensureArray(moveResult.data && moveResult.data.changes);
      persistPlayerBuyFillSaga(escrowRecord, saga);
    }

    if (!saga.sellerCredited) {
      sellerWalletResult = await creditCharacterWallet(
        saga.sellerWalletID,
        saga.grossAmount,
        `Market sale proceeds for ${typeLabel}`,
        saga.buyerCharacterID,
        {
          ...sellerWalletOptions,
          entryTypeID: JOURNAL_ENTRY_TYPE.MARKET_TRANSACTION,
          ownerID1: saga.buyerCharacterID,
          ownerID2: saga.sellerCharacterID,
          referenceID: saga.destinationStationID,
          idempotencyKey: `${saga.operationKey}:wallet:seller-credit`,
        },
      );
      flushCharacterWalletSagaBoundary("Persisting market seller credit");
      saga.sellerCredited = true;
      persistPlayerBuyFillSaga(escrowRecord, saga);
    }

    if (saga.salesTax > 0 && !saga.taxDebited) {
      await debitCharacterWallet(
        saga.sellerWalletID,
        saga.salesTax,
        `Transaction tax for sale of ${typeLabel}`,
        saga.destinationStationID,
        {
          ...sellerWalletOptions,
          entryTypeID: JOURNAL_ENTRY_TYPE.TRANSACTION_TAX,
          ownerID1: saga.stationMarketOwnerID || saga.destinationStationID,
          ownerID2: saga.sellerCharacterID,
          referenceID: saga.destinationStationID,
          idempotencyKey: `${saga.operationKey}:wallet:tax-debit`,
        },
      );
      flushCharacterWalletSagaBoundary("Persisting market tax debit");
      saga.taxDebited = true;
      persistPlayerBuyFillSaga(escrowRecord, saga);
    }

    saga.daemonAttempted = true;
    persistPlayerBuyFillSaga(escrowRecord, saga);
    const fillResponse = await marketDaemonClient.call("FillOrder", {
      order_id: saga.orderID,
      fill_quantity: saga.fillableQuantity,
      idempotency_key: `${saga.operationKey}:daemon-fill`,
    });
    saga.fillResponse = fillResponse;
    persistPlayerBuyFillSaga(escrowRecord, saga);

    if (saga.crossingOrderID) {
      saga.crossingDaemonAttempted = true;
      persistPlayerBuyFillSaga(escrowRecord, saga);
      saga.crossingFillResponse = await marketDaemonClient.call("FillOrder", {
        order_id: saga.crossingOrderID,
        fill_quantity: saga.fillableQuantity,
        idempotency_key: `${saga.operationKey}:crossing-daemon-fill`,
      });
      const crossingEscrowRecord = getEscrowRecord(saga.crossingOrderID);
      if (crossingEscrowRecord) {
        if (saga.crossingFillResponse.state === "filled") {
          requireDurableMarketSagaWrite(
            removeEscrowRecordDurable(saga.crossingOrderID),
            `Completing crossing market order ${saga.crossingOrderID}`,
          );
        } else {
          requireDurableMarketSagaWrite(
            putEscrowRecordDurable({
              ...crossingEscrowRecord,
              remainingQuantity: saga.crossingFillResponse.vol_remaining,
              updatedAt: new Date().toISOString(),
            }),
            `Updating crossing market escrow ${saga.crossingOrderID}`,
          );
        }
      }
    }

    requireDurableMarketSagaWrite(
      recordCompletedMarketFillAchievements(saga),
      `Recording market achievement contributions ${saga.operationKey}`,
    );
    persistPlayerBuyFillSaga(escrowRecord, saga);

    if (fillResponse.state === "filled") {
      requireDurableMarketSagaWrite(
        removeEscrowRecordDurable(saga.orderID),
        `Completing market fill saga ${saga.operationKey}`,
      );
    } else {
      requireDurableMarketSagaWrite(
        putEscrowRecordDurable({
          ...escrowRecord,
          fillAttemptSequence: saga.attempt,
          remainingQuantity: fillResponse.vol_remaining,
          escrowAmount: computeOrderValue(
            fillResponse.price,
            fillResponse.vol_remaining,
          ),
          pendingFill: null,
          updatedAt: new Date().toISOString(),
        }),
        `Completing market fill saga ${saga.operationKey}`,
      );
    }

    return {
      compensated: false,
      fillResponse,
      crossingFillResponse: saga.crossingFillResponse,
      sellerWalletResult,
      sellerInventoryChanges: saga.itemLegs.flatMap((leg) => leg.changes || []),
      buyerChanges: saga.itemLegs.map((leg) => ({ item: leg.destinationItem })),
    };
  } catch (error) {
    if (canCompensateRejectedPrimaryFill(saga, error)) {
      await compensatePlayerBuyFillSaga(escrowRecord, saga, typeLabel);
    } else if (options.scheduleRecovery !== false) {
      await queueDurableMarketFillRecovery(escrowRecord, saga, error);
    }
    throw error;
  }
}

async function executePlayerBuyFillSaga(
  escrowRecord,
  saga,
  typeLabel,
  options = {},
) {
  const operationKey = String(saga && saga.operationKey || "").trim();
  const activePromise = playerBuyFillSagaPromises.get(operationKey);
  if (activePromise) {
    return activePromise;
  }
  const sagaPromise = executePlayerBuyFillSagaUnlocked(
    escrowRecord,
    saga,
    typeLabel,
    options,
  ).finally(() => {
    if (playerBuyFillSagaPromises.get(operationKey) === sagaPromise) {
      playerBuyFillSagaPromises.delete(operationKey);
    }
  });
  playerBuyFillSagaPromises.set(operationKey, sagaPromise);
  return sagaPromise;
}

async function recoverPendingPlayerBuyFillSagas() {
  for (const escrowRecord of listEscrowRecords()) {
    const saga = escrowRecord && escrowRecord.pendingFill;
    if (!saga || saga.direction !== "seller-fills-player-buy") {
      continue;
    }
    await executePlayerBuyFillSaga(
      escrowRecord,
      saga,
      getMarketTypeLabel(saga.typeID),
    );
  }
}

async function recoverPendingMarketFillSagas() {
  await recoverPendingSeedMarketFillSagas();
  await recoverPendingPlayerSellFillSagas();
  await recoverPendingPlayerBuyFillSagas();
}

function hasPendingCrossingFillSaga(orderID) {
  const normalizedOrderID = normalizeOrderId(orderID);
  return listEscrowRecords().some((escrowRecord) => {
    const saga = escrowRecord && escrowRecord.pendingFill;
    return Boolean(
      saga &&
      saga.daemonAttempted &&
      normalizeOrderId(saga.crossingOrderID) === normalizedOrderID,
    );
  });
}

function hasPendingMarketFillSagaForOrder(orderID) {
  const normalizedOrderID = normalizeOrderId(orderID);
  if (normalizedOrderID === "0") {
    return false;
  }
  return listEscrowRecords().some((escrowRecord) => {
    const saga = escrowRecord && escrowRecord.pendingFill;
    return Boolean(
      saga &&
      (
        normalizeOrderId(saga.orderID) === normalizedOrderID ||
        normalizeOrderId(saga.crossingOrderID) === normalizedOrderID
      ),
    );
  });
}

async function matchBuyOrdersForSeller({
  session,
  sellerCharacterID,
  sellerOwner = null,
  regionID,
  stationID,
  solarSystemID,
  typeID,
  minimumPrice,
  requestedQuantity,
  sourceItemID,
  sourceOrderId,
  crossingOrderID = null,
  crossingOrderAvailableQuantity = 0,
} = {}) {
  // As in matchSellOrdersForBuyer: `sellerCharacterID` stays the acting
  // character (item custody, tax/skill context); `resolvedSellerOwner` names
  // whose wallet gets the proceeds.
  const resolvedSellerOwner =
    sellerOwner || { isCorp: false, id: sellerCharacterID, accountKey: null };
  const sellerWalletOptions = resolvedSellerOwner.isCorp
    ? { isCorp: true, accountKey: resolvedSellerOwner.accountKey }
    : {};
  const sellerWalletID = resolvedSellerOwner.isCorp
    ? resolvedSellerOwner.id
    : sellerCharacterID;
  const book = await marketDaemonClient.call("GetOrders", {
    region_id: regionID,
    type_id: typeID,
  });

  let remainingQuantity = normalizePositiveInteger(requestedQuantity, 0);
  let totalSold = 0;
  let totalGross = 0;
  let crossingRemainingQuantity = normalizePositiveInteger(
    crossingOrderAvailableQuantity,
    0,
  );
  let crossingFillResponse = null;
  const sellerMarketContext = buildCharacterMarketContext(
    null,
    sellerCharacterID,
    stationID,
  );
  const typeLabel = getMarketTypeLabel(typeID);
  const structureMarketAccess = createStructureMarketRowAccessScope(
    session,
    Date.now(),
  );

  for (const buyOrder of structureMarketAccess.filterRows(
    book && book.buys,
  )) {
    if (remainingQuantity <= 0) {
      break;
    }

    if (hasPendingMarketFillSagaForOrder(buyOrder && buyOrder.order_id)) {
      continue;
    }

    const isSeedBuyOrder = String(buyOrder && buyOrder.source ? buyOrder.source : "")
      .trim()
      .toLowerCase() === "seed";
    const orderPrice = Number(buyOrder && buyOrder.price) || 0;
    if (!(orderPrice > 0) || orderPrice + 0.0001 < Number(minimumPrice || 0)) {
      continue;
    }

    const availableQuantity = normalizePositiveInteger(
      buyOrder && buyOrder.vol_remaining,
      0,
    );
    if (availableQuantity <= 0) {
      continue;
    }

    if (!isBidOrderInRange(buyOrder, stationID, solarSystemID)) {
      continue;
    }

    const minVolume = normalizePositiveInteger(buyOrder && buyOrder.min_volume, 1);
    const fillableQuantity = Math.min(remainingQuantity, availableQuantity);
    const meetsMinVolume =
      fillableQuantity >= minVolume ||
      (availableQuantity < minVolume && fillableQuantity >= availableQuantity);
    if (!meetsMinVolume) {
      continue;
    }

    let playerBuyOrder = null;
    let buyerCharacterID = 0;
    let buyerEscrowRecord = null;
    if (!isSeedBuyOrder) {
      playerBuyOrder = await fetchOrderById(buyOrder && buyOrder.order_id);
      buyerEscrowRecord = getEscrowRecord(buyOrder && buyOrder.order_id);
      // Item delivery must go to the character who actually placed this buy
      // order (escrowRecord.ownerId, our own bookkeeping) - not
      // playerBuyOrder.owner_id, which is a corporation ID for a corp-wallet
      // buy order. See the "wallet only" scope note in executeBuyRequest.
      buyerCharacterID = normalizePositiveInteger(
        buyerEscrowRecord && buyerEscrowRecord.ownerId,
        0,
      );
      if (!buyerCharacterID) {
        continue;
      }
    }
    const buyerOwner = buyerEscrowRecord && buyerEscrowRecord.isCorp
      ? {
          isCorp: true,
          id: normalizePositiveInteger(buyerEscrowRecord.walletOwnerId, 0),
          accountKey: buyerEscrowRecord.accountKey,
        }
      : { isCorp: false, id: buyerCharacterID, accountKey: null };

    const destinationStationID = normalizePositiveInteger(
      buyOrder && buyOrder.station_id,
      stationID,
    );
    if (!isSeedBuyOrder) {
      const escrowRecord = buyerEscrowRecord;
      if (!escrowRecord || getEscrowType(escrowRecord) !== "buy") {
        throwWrappedUserError("CustomInfo", {
          info: `Market buy order ${normalizeOrderId(buyOrder && buyOrder.order_id)} is missing escrow state.`,
        });
      }
      const grossAmount = roundIsk(orderPrice * fillableQuantity);
      const stationMarketOwnerID = getMarketCounterpartyOwnerID(
        destinationStationID,
      );
      const salesTax = computeSalesTaxAmount(sellerMarketContext, grossAmount);
      const saga = buildPlayerBuyFillSaga({
        buyOrder,
        escrowRecord,
        buyerCharacterID,
        sellerCharacterID,
        sellerWalletID,
        sellerIsCorp: resolvedSellerOwner.isCorp,
        sellerAccountKey: resolvedSellerOwner.accountKey,
        destinationStationID,
        typeID,
        fillableQuantity,
        availableQuantity,
        orderPrice,
        grossAmount,
        salesTax,
        stationMarketOwnerID,
        sourceItemID,
        sourceOrderID: sourceOrderId,
        crossingOrderID,
        crossingAvailableQuantity: crossingRemainingQuantity,
      });
      persistPlayerBuyFillSaga(escrowRecord, saga);
      const sagaResult = await executePlayerBuyFillSaga(
        escrowRecord,
        saga,
        typeLabel,
      );
      const fillResponse = sagaResult.fillResponse;
      if (sagaResult.crossingFillResponse) {
        crossingFillResponse = sagaResult.crossingFillResponse;
        crossingRemainingQuantity = normalizePositiveInteger(
          crossingFillResponse.vol_remaining,
          0,
        );
      }
      const sellerWalletResult = sagaResult.sellerWalletResult;

      if (sagaResult.sellerInventoryChanges.length > 0) {
        notifyInventoryChangesToCharacter(
          sellerCharacterID,
          sagaResult.sellerInventoryChanges,
        );
      }
      notifyBuyerDelivery(buyerCharacterID, sagaResult.buyerChanges);
      try {
        await recordTrade(typeID, orderPrice, fillableQuantity);
      } catch (error) {
        log.warn(
          `[MarketProxy] Failed to record committed fill ${saga.operationKey}: ${error.message}`,
        );
      }
      await recordMarketTransactionForWalletOwner(resolvedSellerOwner, {
        transactionDate: sellerWalletResult && sellerWalletResult.journalEntry
          ? sellerWalletResult.journalEntry.transactionDate
          : null,
        typeID,
        quantity: fillableQuantity,
        price: orderPrice,
        stationID: destinationStationID,
        buyerID: buyerOwner.isCorp ? buyerOwner.id : buyerCharacterID,
        sellerID: sellerWalletID,
        clientID: buyerOwner.isCorp ? buyerOwner.id : buyerCharacterID,
        journalRefID:
          sellerWalletResult && sellerWalletResult.journalEntry
            ? sellerWalletResult.journalEntry.transactionID
            : -1,
      });
      await recordMarketTransactionForWalletOwner(buyerOwner, {
        typeID,
        quantity: fillableQuantity,
        price: orderPrice,
        stationID: destinationStationID,
        buyerID: buyerOwner.isCorp ? buyerOwner.id : buyerCharacterID,
        sellerID: sellerWalletID,
        clientID: sellerWalletID,
        journalRefID: -1,
      });
      notifyOwnOrdersChanged(
        buyerCharacterID,
        [{
          ...playerBuyOrder,
          row: {
            ...getOwnerOrderResponseOrder(playerBuyOrder),
            vol_remaining: fillResponse.vol_remaining,
            price: fillResponse.price,
          },
          state: fillResponse.state,
        }],
        fillResponse.state === "filled" ? ORDER_REASON_FILLED : ORDER_REASON_PARTIAL,
        buyerOwner.isCorp,
      );

      totalSold += fillableQuantity;
      totalGross = roundIsk(totalGross + grossAmount);
      remainingQuantity -= fillableQuantity;
      continue;
    }

    const grossAmount = roundIsk(orderPrice * fillableQuantity);
    const stationMarketOwnerID = getMarketCounterpartyOwnerID(
      destinationStationID,
    );
    const salesTax = computeSalesTaxAmount(sellerMarketContext, grossAmount);
    const saga = buildSeedBuyFillSaga({
      buyOrder,
      sellerCharacterID,
      sellerWalletID,
      sellerIsCorp: resolvedSellerOwner.isCorp,
      sellerAccountKey: resolvedSellerOwner.accountKey,
      destinationStationID,
      typeID,
      fillableQuantity,
      availableQuantity,
      orderPrice,
      grossAmount,
      salesTax,
      stationMarketOwnerID,
      sourceItemID,
      sourceOrderID: sourceOrderId,
      crossingOrderID,
      crossingAvailableQuantity: crossingRemainingQuantity,
    });
    const anchorRecord = {
      orderId: saga.anchorOrderID,
      escrowType: "seed-fill",
      pendingFill: saga,
      createdAt: saga.createdAt,
      updatedAt: saga.updatedAt,
    };
    persistSeedMarketFillSaga(anchorRecord, saga);
    const sagaResult = await executeSeedBuyFillSaga(
      anchorRecord,
      saga,
      typeLabel,
    );
    if (sagaResult.crossingFillResponse) {
      crossingFillResponse = sagaResult.crossingFillResponse;
      crossingRemainingQuantity = normalizePositiveInteger(
        crossingFillResponse.vol_remaining,
        0,
      );
    }
    if (sagaResult.sellerInventoryChanges.length > 0) {
      notifyInventoryChangesToCharacter(
        sellerCharacterID,
        sagaResult.sellerInventoryChanges,
      );
    }
    try {
      await recordTrade(typeID, orderPrice, fillableQuantity);
    } catch (error) {
      log.warn(
        `[MarketProxy] Failed to record committed fill ${saga.operationKey}: ${error.message}`,
      );
    }
    const sellerWalletResult = sagaResult.sellerWalletResult;
    await recordMarketTransactionForWalletOwner(resolvedSellerOwner, {
      transactionDate: sellerWalletResult && sellerWalletResult.journalEntry
        ? sellerWalletResult.journalEntry.transactionDate
        : null,
      typeID,
      quantity: fillableQuantity,
      price: orderPrice,
      stationID: destinationStationID,
      buyerID: getMarketCounterpartyOwnerID(destinationStationID),
      sellerID: sellerWalletID,
      clientID: getMarketCounterpartyOwnerID(destinationStationID),
      journalRefID:
        sellerWalletResult && sellerWalletResult.journalEntry
          ? sellerWalletResult.journalEntry.transactionID
          : -1,
    });

    totalSold += fillableQuantity;
    totalGross = roundIsk(totalGross + grossAmount);
    remainingQuantity -= fillableQuantity;
  }

  return {
    soldQuantity: totalSold,
    remainingQuantity,
    totalGross,
    crossingFillResponse,
  };
}

async function executeBuyRequest({
  session,
  characterID,
  stationID,
  regionID,
  typeID,
  maxPrice,
  requestedQuantity,
  orderRange,
  minVolume,
  durationDays,
  expectedBrokerFee,
  owner = null,
} = {}) {
  // Which wallet pays escrow/fees/tax for this order - the acting character's
  // own wallet by default, or a corporation wallet when `owner.isCorp`. Item
  // delivery and skill/tax-rate context always stay keyed to `characterID`
  // (the acting character) regardless: only the ISK side moves.
  const payer = owner || { isCorp: false, id: characterID, accountKey: null };
  const payerWalletOptions = payer.isCorp
    ? { isCorp: true, accountKey: payer.accountKey }
    : {};
  const payerWalletID = payer.isCorp ? payer.id : characterID;
  const normalizedQuantity = normalizePositiveInteger(requestedQuantity, 0);
  const normalizedPrice = roundIsk(maxPrice);
  const normalizedDuration = normalizeInteger(durationDays, 0);
  const normalizedMinVolume = Math.max(
    1,
    normalizePositiveInteger(minVolume, 1),
  );
  const typeLabel = getMarketTypeLabel(typeID);
  ensureValidPrice(normalizedPrice);
  ensureValidDuration(normalizedDuration);
  ensureValidMinVolume(normalizedQuantity, normalizedMinVolume);
  ensureStructureMarketServiceAccess(session, stationID);
  const marketContext = buildCharacterMarketContext(session, characterID, stationID);

  if (normalizedDuration > 0) {
    validateExpectedBrokerFeePercentage(expectedBrokerFee, marketContext);
    ensureValidBuyRange(orderRange, marketContext.limits);
    ensureRemoteBuyOrderPlacementAllowed(session, stationID, marketContext);
  }

  const openOrders = normalizedDuration > 0
    ? await fetchCharacterOrders(characterID)
    : [];
  if (normalizedDuration > 0) {
    syncOpenBuyEscrowRecords(openOrders);
    ensureOpenOrderLimit(marketContext, openOrders);
  }

  const reserveUpperBound = roundIsk(normalizedPrice * normalizedQuantity);
  const brokerFeeUpperBound = normalizedDuration > 0
    ? computeBrokerFeeInfo(marketContext, null, reserveUpperBound).amount
    : 0;
  const sccSurchargeUpperBound = normalizedDuration > 0
    ? computeSccSurchargeInfo(marketContext, null, reserveUpperBound).amount
    : 0;

  ensureCharacterHasFunds(
    payerWalletID,
    reserveUpperBound + brokerFeeUpperBound + sccSurchargeUpperBound,
    `Placing a buy order for ${typeLabel}`,
    payerWalletOptions,
  );

  const matchResult = await matchSellOrdersForBuyer({
    session,
    buyerCharacterID: characterID,
    buyerOwner: payer,
    regionID,
    typeID,
    maxPrice: normalizedPrice,
    requestedQuantity: normalizedQuantity,
    orderRange: normalizeInteger(orderRange, RANGE_STATION),
    currentStationID: stationID,
    currentSolarSystemID: getStationSolarSystemID(stationID),
  });

  let createdOrder = null;
  if (normalizedDuration > 0 && matchResult.remainingQuantity > 0) {
    const remainingReserve = roundIsk(normalizedPrice * matchResult.remainingQuantity);
    const brokerFeeInfo = computeBrokerFeeInfo(
      marketContext,
      null,
      remainingReserve,
    );
    const sccSurchargeInfo = computeSccSurchargeInfo(
      marketContext,
      null,
      remainingReserve,
    );
    const stationMarketOwnerID = getMarketCounterpartyOwnerID(stationID);
    await debitCharacterWallet(
      payerWalletID,
      remainingReserve,
      `Market escrow for buy order ${typeLabel}`,
      stationID,
      {
        ...payerWalletOptions,
        entryTypeID: JOURNAL_ENTRY_TYPE.MARKET_ESCROW,
        ownerID1: stationMarketOwnerID || stationID,
        ownerID2: characterID,
        referenceID: stationID,
      },
    );
    await debitCharacterWallet(
      payerWalletID,
      brokerFeeInfo.amount,
      `Broker fee for buy order ${typeLabel}`,
      stationID,
      {
        ...payerWalletOptions,
        entryTypeID: JOURNAL_ENTRY_TYPE.BROKERS_FEE,
        ownerID1: stationMarketOwnerID || stationID,
        ownerID2: characterID,
        referenceID: stationID,
      },
    );
    await debitCharacterWallet(
      payerWalletID,
      sccSurchargeInfo.amount,
      `SCC surcharge for buy order ${typeLabel}`,
      stationID,
      {
        ...payerWalletOptions,
        entryTypeID: JOURNAL_ENTRY_TYPE.MARKET_PROVIDER_TAX,
        ownerID1: stationMarketOwnerID || stationID,
        ownerID2: characterID,
        referenceID: stationID,
      },
    );

    try {
      const placedOrder = await marketDaemonClient.call("PlaceOrder", {
        owner_id: payerWalletID,
        is_corp: payer.isCorp,
        station_id: stationID,
        station_metadata: buildNativeStationMetadata(stationID),
        type_id: typeID,
        price: normalizedPrice,
        quantity: matchResult.remainingQuantity,
        min_volume: normalizedMinVolume,
        duration_days: normalizedDuration,
        range_value: normalizeInteger(orderRange, RANGE_STATION),
        bid: true,
        source: "player",
      });

      createdOrder = {
        order_id: placedOrder.order_id,
        owner_id: payerWalletID,
        is_corp: payer.isCorp,
        wallet_owner_id: payerWalletID,
        account_key: payer.accountKey,
        state: "open",
        row: {
          order_id: placedOrder.order_id,
          price: normalizedPrice,
          vol_remaining: matchResult.remainingQuantity,
          type_id: typeID,
          range_value: normalizeInteger(orderRange, RANGE_STATION),
          vol_entered: matchResult.remainingQuantity,
          min_volume: normalizedMinVolume,
          bid: true,
          issued_at: new Date().toISOString(),
          duration_days: normalizedDuration,
          station_id: stationID,
          region_id: regionID,
          solar_system_id: getStationSolarSystemID(stationID),
          constellation_id: getStationConstellationID(stationID),
        },
      };
      requireDurableMarketSagaWrite(
        upsertBuyEscrowRecord(
          { ...createdOrder, owner_id: characterID },
          {},
          { durable: true },
        ),
        `Persisting buy-order escrow ${normalizeOrderId(placedOrder.order_id)}`,
      );
      await creditStructureMarketBrokerFeeOwner(
        characterID,
        stationID,
        brokerFeeInfo.amount,
        `Structure broker fee for buy order ${typeLabel}`,
      );
      notifyOwnOrdersChanged(characterID, [createdOrder], ORDER_REASON_CREATED, payer.isCorp);
    } catch (error) {
      if (createdOrder) {
        await marketDaemonClient.call("CancelOrder", {
          order_id: normalizeOrderId(createdOrder.order_id),
        }).catch(() => null);
        removeEscrowRecordDurable(createdOrder.order_id);
        createdOrder = null;
      }
      await creditCharacterWallet(
        payerWalletID,
        remainingReserve,
        `Market escrow refund for failed buy order ${typeLabel}`,
        stationID,
        {
          ...payerWalletOptions,
          entryTypeID: JOURNAL_ENTRY_TYPE.MARKET_ESCROW,
          ownerID1: stationMarketOwnerID || stationID,
          ownerID2: characterID,
          referenceID: stationID,
        },
      );
      await creditCharacterWallet(
        payerWalletID,
        brokerFeeInfo.amount,
        `Broker fee refund for failed buy order ${typeLabel}`,
        stationID,
        {
          ...payerWalletOptions,
          entryTypeID: JOURNAL_ENTRY_TYPE.BROKERS_FEE,
          ownerID1: stationMarketOwnerID || stationID,
          ownerID2: characterID,
          referenceID: stationID,
        },
      );
      await creditCharacterWallet(
        payerWalletID,
        sccSurchargeInfo.amount,
        `SCC surcharge refund for failed buy order ${typeLabel}`,
        stationID,
        {
          ...payerWalletOptions,
          entryTypeID: JOURNAL_ENTRY_TYPE.MARKET_PROVIDER_TAX,
          ownerID1: stationMarketOwnerID || stationID,
          ownerID2: characterID,
          referenceID: stationID,
        },
      );
      throw error;
    }
    try {
      await scheduleDurableMarketOrderExpiry(createdOrder);
    } catch (error) {
      log.warn(
        `[MarketProxy] Buy-order expiry scheduling deferred order=${normalizeOrderId(createdOrder.order_id)}: ${error.message}`,
      );
    }
  }

  if (matchResult.boughtQuantity > 0 && !createdOrder) {
    notifyOwnOrdersChanged(
      characterID,
      [buildImmediateMarketRefreshOrder({
        characterID,
        owner: payer,
        stationID,
        regionID,
        solarSystemID: getStationSolarSystemID(stationID),
        constellationID: getStationConstellationID(stationID),
        typeID,
        price: normalizedPrice,
        quantity: matchResult.boughtQuantity,
        bid: false,
      })],
      ORDER_REASON_FILLED,
      payer.isCorp,
    );
  }

  return {
    boughtQuantity: matchResult.boughtQuantity,
    totalSpent: matchResult.totalSpent,
    createdOrder,
    remainingQuantity: matchResult.remainingQuantity,
  };
}

async function executeSellEntryUnlocked({
  session,
  entry,
  durationDays,
  expectedBrokerFee,
  owner = null,
} = {}) {
  const characterID = getNumericSessionValue(session, ["charid", "characterID"]);
  // As in executeBuyRequest: `payer` names which wallet receives proceeds and
  // pays the broker fee/SCC surcharge. The item being sold always comes out
  // of the acting character's own hangar (checked below) and stays that way
  // regardless of `owner` - only where the ISK lands changes.
  const payer = owner || { isCorp: false, id: characterID, accountKey: null };
  const payerWalletOptions = payer.isCorp
    ? { isCorp: true, accountKey: payer.accountKey }
    : {};
  const payerWalletID = payer.isCorp ? payer.id : characterID;
  const regionID = getNumericSessionValue(session, ["regionid", "regionID"]);
  const typeID = normalizePositiveInteger(entry && entry.typeID, 0);
  const typeLabel = getMarketTypeLabel(typeID);
  const stationID = normalizePositiveInteger(entry && entry.stationID, 0);
  const price = roundIsk(entry && entry.price);
  const requestedQuantity = normalizePositiveInteger(entry && entry.quantity, 0);
  const itemID = normalizePositiveInteger(entry && entry.itemID, 0);
  const item = findItemById(itemID);

  if (!characterID || !regionID || !typeID || !stationID || !itemID || !requestedQuantity) {
    throwWrappedUserError("CustomInfo", {
      info: "Sell order request is missing required item details.",
    });
  }
  if (!item) {
    throwWrappedUserError("CustomInfo", {
      info: `Inventory item ${itemID} is no longer available.`,
    });
  }
  // Pin the seller-side location, validating it in the same step. Everything
  // between here and the escrow move is asynchronous, so the item row read at
  // move time proves nothing about where this flow agreed to take the goods
  // from - it can already be inside another order's escrow. Custody compares
  // the stack against this pin, so a stack that moved in the meantime fails the
  // transfer instead of being quietly relocated.
  const escrowSource = resolveSellItemCustodySource({
    session,
    item,
    characterID,
    stationID,
    itemID,
  });

  // Corporation goods may only be sold on the corporation's behalf. Without
  // this, a member holding a division take role could list corp stock and take
  // the proceeds personally, which is theft dressed as a market order. The
  // client already sends useCorp for a corp hangar sale; this is the server
  // refusing to take its word for it.
  if (escrowSource.isCorpHangar) {
    if (!payer.isCorp) {
      throwWrappedUserError("CustomInfo", {
        info: `Inventory item ${itemID} belongs to the corporation, so the sale must be made on the corporation's behalf.`,
      });
    }
    if (normalizePositiveInteger(payer.id, 0) !== escrowSource.ownerID) {
      throwWrappedUserError("CustomInfo", {
        info: `Inventory item ${itemID} belongs to a different corporation than the one being paid.`,
      });
    }
  }

  const normalizedDuration = normalizeInteger(durationDays, 0);
  ensureValidPrice(price);
  ensureValidDuration(normalizedDuration);
  ensureStructureMarketServiceAccess(session, stationID);
  const marketContext = buildCharacterMarketContext(session, characterID, stationID);
  if (normalizedDuration > 0) {
    validateExpectedBrokerFeePercentage(expectedBrokerFee, marketContext);
  }
  ensureRemoteSellOrderPlacementAllowed(session, stationID, marketContext);

  if (normalizedDuration > 0) {
    const openOrders = await fetchCharacterOrders(characterID);
    syncOpenBuyEscrowRecords(openOrders);
    ensureOpenOrderLimit(marketContext, openOrders);
  }

  const sellResult = await matchBuyOrdersForSeller({
    session,
    sellerCharacterID: characterID,
    sellerOwner: payer,
    regionID,
    stationID,
    solarSystemID: getStationSolarSystemID(stationID),
    typeID,
    minimumPrice: price,
    requestedQuantity,
    sourceItemID: itemID,
  });

  let createdOrder = null;
  if (normalizedDuration > 0 && sellResult.remainingQuantity > 0) {
    const openOrderValue = computeOrderValue(price, sellResult.remainingQuantity);
    const brokerFeeInfo = computeBrokerFeeInfo(
      marketContext,
      null,
      openOrderValue,
    );
    const sccSurchargeInfo = computeSccSurchargeInfo(
      marketContext,
      null,
      openOrderValue,
    );
    const stationMarketOwnerID = getMarketCounterpartyOwnerID(stationID);
    await debitCharacterWallet(
      payerWalletID,
      brokerFeeInfo.amount,
      `Broker fee for sell order ${typeLabel}`,
      stationID,
      {
        ...payerWalletOptions,
        entryTypeID: JOURNAL_ENTRY_TYPE.BROKERS_FEE,
        ownerID1: stationMarketOwnerID || stationID,
        ownerID2: characterID,
        referenceID: stationID,
      },
    );
    await debitCharacterWallet(
      payerWalletID,
      sccSurchargeInfo.amount,
      `SCC surcharge for sell order ${typeLabel}`,
      stationID,
      {
        ...payerWalletOptions,
        entryTypeID: JOURNAL_ENTRY_TYPE.MARKET_PROVIDER_TAX,
        ownerID1: stationMarketOwnerID || stationID,
        ownerID2: characterID,
        referenceID: stationID,
      },
    );

    let placedOrder = null;
    try {
      placedOrder = await marketDaemonClient.call("PlaceOrder", {
        owner_id: payerWalletID,
        is_corp: payer.isCorp,
        station_id: stationID,
        station_metadata: buildNativeStationMetadata(stationID),
        type_id: typeID,
        price,
        quantity: sellResult.remainingQuantity,
        min_volume: 1,
        duration_days: normalizedDuration,
        range_value: RANGE_STATION,
        bid: false,
        source: "player",
      });
    } catch (error) {
      // The fee and the surcharge are already debited and no order was placed.
      // Nothing has reached escrow yet, so there is no order to cancel, no
      // record to drop and no stack to return: only the two charges to give
      // back. That holds when the daemon refused the order or was never sent
      // it. A request it left unanswered may have placed the order, so, as the
      // fills do (canCompensateRejectedPrimaryFill), nothing is given back for
      // an outcome that is not known.
      if (
        isDefinitiveMarketDaemonRejection(error) ||
        error && error.marketDaemonRequestSent === false
      ) {
        await creditCharacterWallet(
          payerWalletID,
          brokerFeeInfo.amount,
          `Broker fee refund for failed sell order ${typeLabel}`,
          stationID,
          {
            ...payerWalletOptions,
            entryTypeID: JOURNAL_ENTRY_TYPE.BROKERS_FEE,
            ownerID1: stationMarketOwnerID || stationID,
            ownerID2: characterID,
            referenceID: stationID,
          },
        );
        await creditCharacterWallet(
          payerWalletID,
          sccSurchargeInfo.amount,
          `SCC surcharge refund for failed sell order ${typeLabel}`,
          stationID,
          {
            ...payerWalletOptions,
            entryTypeID: JOURNAL_ENTRY_TYPE.MARKET_PROVIDER_TAX,
            ownerID1: stationMarketOwnerID || stationID,
            ownerID2: characterID,
            referenceID: stationID,
          },
        );
      }
      throw error;
    }

    const escrowLocationID =
      MARKET_ESCROW_LOCATION_BASE + normalizePositiveInteger(placedOrder.order_id, 0);
    const issuedAt = new Date().toISOString();
    // Three separate identities, and conflating any two of them is a bug:
    //   ownerId       the listing character - notifications, and who acted
    //   source*       where the goods came from and must go back to on a
    //                 cancel or expiry: a character's station hangar, or a
    //                 corporation hangar division at an office
    //   walletOwnerId who is paid, which may be a corporation either way
    const sellEscrowRecord = {
      orderId: normalizeOrderId(placedOrder.order_id),
      ownerId: characterID,
      sourceOwnerId: escrowSource.ownerID,
      sourceLocationId: escrowSource.locationID,
      sourceFlagId: escrowSource.flagID,
      isCorp: payer.isCorp,
      walletOwnerId: payerWalletID,
      accountKey: payer.accountKey,
      typeId: typeID,
      stationId: stationID,
      escrowLocationID,
      remainingQuantity: sellResult.remainingQuantity,
      issuedAt,
      durationDays: normalizedDuration,
      createdAt: issuedAt,
      updatedAt: issuedAt,
    };

    try {
      // Durability order matters here. The escrow custody move flushes the items
      // table before it returns, so writing the escrow record after it left a
      // crash window where the items sat at the virtual escrow location with no
      // record naming them - invisible to startup reconciliation, to expiry and
      // to cancel, and therefore lost. Write the record first, in `placing`
      // state: every crash point from here on leaves something reconciliation
      // can see and resolve.
      const placingResult = upsertSellEscrowRecord({
        ...sellEscrowRecord,
        escrowState: MARKET_ESCROW_STATE_PLACING,
      }, { durable: true });
      if (!placingResult.success) {
        throwWrappedUserError("CustomInfo", {
          info: `Failed to persist escrow state for market order ${normalizeOrderId(placedOrder.order_id)}.`,
        });
      }

      const moveResult = marketItemCustody.transferItem({
        item: findItemById(itemID),
        expectedSource: escrowSource,
        locationID: escrowLocationID,
        flagID: ITEM_FLAGS.HANGAR,
        quantity: sellResult.remainingQuantity,
        orderID: placedOrder.order_id,
        actor: characterID,
        reason: itemCustody.CUSTODY_REASON.MARKET_ESCROW_PLACE,
      });
      if (!moveResult.success) {
        throwWrappedUserError("CustomInfo", {
          info: `Failed to escrow inventory item ${itemID} for market order ${normalizeOrderId(placedOrder.order_id)}.`,
        });
      }

      const escrowedChanges = ensureArray(moveResult.data && moveResult.data.changes);
      notifyInventoryChangesToCharacter(characterID, escrowedChanges);
      // Placing a corporation sell order takes the stack OUT of a division.
      // Without this the other members keep seeing goods that are already in
      // escrow, and only discover otherwise by trying to move them.
      // The seller's own session already received these rows from the character
      // notification above; naming it here keeps the fan-out from sending them twice.
      fanCorporationOfficeInventoryChanges(escrowedChanges, {
        actorSession: session || null,
      });

      const putResult = upsertSellEscrowRecord({
        ...sellEscrowRecord,
        escrowState: MARKET_ESCROW_STATE_ACTIVE,
        updatedAt: new Date().toISOString(),
      }, { durable: true });
      if (!putResult.success) {
        throwWrappedUserError("CustomInfo", {
          info: `Failed to persist escrow state for market order ${normalizeOrderId(placedOrder.order_id)}.`,
        });
      }

      await creditStructureMarketBrokerFeeOwner(
        characterID,
        stationID,
        brokerFeeInfo.amount,
        `Structure broker fee for sell order ${typeLabel}`,
      );

      createdOrder = {
        order_id: placedOrder.order_id,
        owner_id: payerWalletID,
        is_corp: payer.isCorp,
        state: "open",
        row: {
          order_id: placedOrder.order_id,
          price,
          vol_remaining: sellResult.remainingQuantity,
          type_id: typeID,
          range_value: RANGE_STATION,
          vol_entered: sellResult.remainingQuantity,
          min_volume: 1,
          bid: false,
          issued_at: issuedAt,
          duration_days: normalizedDuration,
          station_id: stationID,
          region_id: regionID,
          solar_system_id: getStationSolarSystemID(stationID),
          constellation_id: getStationConstellationID(stationID),
        },
      };
      notifyOwnOrdersChanged(characterID, [createdOrder], ORDER_REASON_CREATED, payer.isCorp);
    } catch (error) {
      // Drop the escrow record before the daemon call: CancelOrder can throw
      // when the daemon is unreachable, and a leftover record would otherwise
      // outlive the rollback and claim escrow that is about to be handed back.
      removeEscrowRecordDurable(placedOrder.order_id);
      await marketDaemonClient.call("CancelOrder", {
        order_id: normalizeOrderId(placedOrder.order_id),
      });
      // Roll the goods back to the pin the placement took them from. Listing
      // under the acting character and returning to the station hangar is only
      // right for a personal sale; for a corp hangar sale it would find nothing
      // and, if it did, would drop corporation stock into a station hangar flag
      // instead of the division it came from.
      const strandedEscrowItems = listContainerItems(
        escrowSource.ownerID,
        escrowLocationID,
        ITEM_FLAGS.HANGAR,
      );
      for (const strandedItem of strandedEscrowItems) {
        marketItemCustody.transferItem({
          item: strandedItem,
          ownerID: escrowSource.ownerID,
          locationID: escrowSource.locationID,
          flagID: escrowSource.flagID,
          orderID: placedOrder.order_id,
          actor: characterID,
          reason: itemCustody.CUSTODY_REASON.MARKET_ESCROW_RETURN,
        });
      }
      await creditCharacterWallet(
        payerWalletID,
        brokerFeeInfo.amount,
        `Broker fee refund for failed sell order ${typeLabel}`,
        stationID,
        {
          ...payerWalletOptions,
          entryTypeID: JOURNAL_ENTRY_TYPE.BROKERS_FEE,
          ownerID1: stationMarketOwnerID || stationID,
          ownerID2: characterID,
          referenceID: stationID,
        },
      );
      await creditCharacterWallet(
        payerWalletID,
        sccSurchargeInfo.amount,
        `SCC surcharge refund for failed sell order ${typeLabel}`,
        stationID,
        {
          ...payerWalletOptions,
          entryTypeID: JOURNAL_ENTRY_TYPE.MARKET_PROVIDER_TAX,
          ownerID1: stationMarketOwnerID || stationID,
          ownerID2: characterID,
          referenceID: stationID,
        },
      );
      throw error;
    }
    try {
      await scheduleDurableMarketOrderExpiry(createdOrder);
    } catch (error) {
      log.warn(
        `[MarketProxy] Sell-order expiry scheduling deferred order=${normalizeOrderId(createdOrder.order_id)}: ${error.message}`,
      );
    }
  }

  if (sellResult.soldQuantity > 0 && !createdOrder) {
    notifyOwnOrdersChanged(
      characterID,
      [buildImmediateMarketRefreshOrder({
        characterID,
        owner: payer,
        stationID,
        regionID,
        solarSystemID: getStationSolarSystemID(stationID),
        constellationID: getStationConstellationID(stationID),
        typeID,
        price,
        quantity: sellResult.soldQuantity,
        bid: false,
      })],
      ORDER_REASON_FILLED,
      payer.isCorp,
    );
  }

  return {
    soldQuantity: sellResult.soldQuantity,
    remainingQuantity: sellResult.remainingQuantity,
    createdOrder,
  };
}

async function executeSellEntry(request = {}) {
  const itemID = normalizePositiveInteger(
    request && request.entry && request.entry.itemID,
    0,
  );
  if (!itemID) {
    // No item to contend over; let the entry validation report what is missing.
    return executeSellEntryUnlocked(request);
  }
  if (sellPlacementItemsInFlight.has(itemID)) {
    throwWrappedUserError("CustomInfo", {
      info: `Inventory item ${itemID} is already being placed on the market. Wait for that order to finish and try again.`,
    });
  }
  sellPlacementItemsInFlight.add(itemID);
  try {
    return await executeSellEntryUnlocked(request);
  } finally {
    sellPlacementItemsInFlight.delete(itemID);
  }
}

async function applyBuyOrderCrossingAfterModify(session, order, newPrice) {
  const orderRow = getOwnerOrderResponseOrder(order);
  const remainingVolume = normalizePositiveInteger(orderRow && orderRow.vol_remaining, 0);
  if (remainingVolume <= 0) {
    removeEscrowRecord(order && order.order_id);
    return {
      state: String(order && order.state ? order.state : "open"),
      vol_remaining: remainingVolume,
      price: roundIsk(newPrice),
    };
  }

  // Item delivery/notifications must be keyed to the placing character
  // (escrowRecord.ownerId), never order.owner_id - a corporation ID for a
  // corp-wallet buy order. chargeBuyerWallet:false below means no wallet
  // touch happens here regardless (already paid at placement), so
  // buyerOwner only matters for transaction-history attribution.
  const crossingEscrowRecord = getEscrowRecord(order && order.order_id);
  const buyerCharacterID = normalizePositiveInteger(
    crossingEscrowRecord && crossingEscrowRecord.ownerId,
    normalizePositiveInteger(order && order.owner_id, 0),
  );
  const buyerOwner = crossingEscrowRecord && crossingEscrowRecord.isCorp
    ? {
        isCorp: true,
        id: normalizePositiveInteger(crossingEscrowRecord.walletOwnerId, 0),
        accountKey: crossingEscrowRecord.accountKey,
      }
    : { isCorp: false, id: buyerCharacterID, accountKey: null };

  const matchResult = await matchSellOrdersForBuyer({
    buyerCharacterID,
    buyerOwner,
    regionID: normalizePositiveInteger(orderRow && orderRow.region_id, 0),
    typeID: normalizePositiveInteger(orderRow && orderRow.type_id, 0),
    maxPrice: roundIsk(newPrice),
    requestedQuantity: remainingVolume,
    orderRange: normalizeInteger(orderRow && orderRow.range_value, RANGE_STATION),
    currentStationID: normalizePositiveInteger(orderRow && orderRow.station_id, 0),
    currentSolarSystemID: normalizePositiveInteger(orderRow && orderRow.solar_system_id, 0),
    chargeBuyerWallet: false,
    crossingOrderID: normalizeOrderId(order && order.order_id),
    crossingOrderPrice: roundIsk(newPrice),
    crossingOrderAvailableQuantity: remainingVolume,
  });

  if (matchResult.boughtQuantity <= 0) {
    upsertBuyEscrowRecord(
      {
        ...order,
        row: {
          ...orderRow,
          price: roundIsk(newPrice),
          vol_remaining: remainingVolume,
        },
      },
      { account_key: crossingEscrowRecord && crossingEscrowRecord.accountKey },
    );
    return {
      state: "open",
      vol_remaining: remainingVolume,
      price: roundIsk(newPrice),
    };
  }

  return matchResult.crossingFillResponse || {
    state: "open",
    vol_remaining: Math.max(0, remainingVolume - matchResult.boughtQuantity),
    price: roundIsk(newPrice),
  };
}

async function applySellOrderCrossingAfterModify(session, order, newPrice) {
  const orderRow = getOwnerOrderResponseOrder(order);
  const remainingVolume = normalizePositiveInteger(orderRow && orderRow.vol_remaining, 0);
  if (remainingVolume <= 0) {
    removeEscrowRecord(order && order.order_id);
    return {
      state: String(order && order.state ? order.state : "open"),
      vol_remaining: remainingVolume,
      price: roundIsk(newPrice),
    };
  }

  // Item custody must be keyed to the listing character (escrowRecord.ownerId),
  // never order.owner_id - a corporation ID for a corp-wallet sell order.
  const crossingEscrowRecord = getEscrowRecord(order && order.order_id);
  const sellerCharacterID = normalizePositiveInteger(
    crossingEscrowRecord && crossingEscrowRecord.ownerId,
    normalizePositiveInteger(order && order.owner_id, 0),
  );
  const sellerOwner = crossingEscrowRecord && crossingEscrowRecord.isCorp
    ? {
        isCorp: true,
        id: normalizePositiveInteger(crossingEscrowRecord.walletOwnerId, 0),
        accountKey: crossingEscrowRecord.accountKey,
      }
    : { isCorp: false, id: sellerCharacterID, accountKey: null };

  const matchResult = await matchBuyOrdersForSeller({
    sellerCharacterID,
    sellerOwner,
    regionID: normalizePositiveInteger(orderRow && orderRow.region_id, 0),
    stationID: normalizePositiveInteger(orderRow && orderRow.station_id, 0),
    solarSystemID: normalizePositiveInteger(orderRow && orderRow.solar_system_id, 0),
    typeID: normalizePositiveInteger(orderRow && orderRow.type_id, 0),
    minimumPrice: roundIsk(newPrice),
    requestedQuantity: remainingVolume,
    sourceOrderId: normalizeOrderId(order && order.order_id),
    crossingOrderID: normalizeOrderId(order && order.order_id),
    crossingOrderAvailableQuantity: remainingVolume,
  });

  if (matchResult.soldQuantity <= 0) {
    return {
      state: "open",
      vol_remaining: remainingVolume,
      price: roundIsk(newPrice),
    };
  }

  return matchResult.crossingFillResponse || {
    state: "open",
    vol_remaining: Math.max(0, remainingVolume - matchResult.soldQuantity),
    price: roundIsk(newPrice),
  };
}

class MarketProxyService extends BaseService {
  constructor() {
    super("marketProxy");
    marketDaemonClient.startBackgroundConnect();
  }

  async Handle_StartupCheck() {
    log.debug("[MarketProxy] StartupCheck");
    try {
      await marketDaemonClient.startupCheck();
      return null;
    } catch (error) {
      throwMarketUnavailable("StartupCheck", error);
    }
  }

  Handle_GetMarketGroups() {
    log.debug("[MarketProxy] GetMarketGroups");
    return buildRowset(
      [
        "parentGroupID",
        "marketGroupID",
        "marketGroupName",
        "description",
        "graphicID",
        "hasTypes",
        "iconID",
        "dataID",
        "marketGroupNameID",
        "descriptionID",
      ],
      [],
      ROWSET_NAME,
    );
  }

  async Handle_GetStationAsks(args, session) {
    const stationID = getNumericSessionValue(session, [
      "stationid",
      "stationID",
      "structureid",
      "structureID",
      "locationid",
    ]);
    if (!stationID) {
      throwWrappedUserError("CustomInfo", {
        info: "Station market data is only available while docked in a station.",
      });
    }
    ensureStructureMarketServiceAccess(session, stationID);

    log.debug(`[MarketProxy] GetStationAsks station=${stationID}`);
    try {
      const result = await marketDaemonClient.call("GetStationAsks", {
        station_id: stationID,
      });
      const structureMarketAccess = createStructureMarketRowAccessScope(
        session,
        Date.now(),
      );
      return buildCachedMethodCallResult(
        buildSummaryDict(
          structureMarketAccess.filterRows(
            result,
            ["best_ask_station_id", "bestAskStationID"],
          ),
          "tuple",
        ),
        {
          method: "GetStationAsks",
          sessionInfo: "stationid",
          sessionInfoValue: stationID,
        },
      );
    } catch (error) {
      throwMarketUnavailable("GetStationAsks", error);
    }
  }

  async Handle_GetSystemAsks(args, session) {
    const solarSystemID = getNumericSessionValue(session, [
      "solarsystemid2",
      "solarsystemid",
      "solarSystemID",
    ]);
    if (!solarSystemID) {
      throwWrappedUserError("CustomInfo", {
        info: "System market data is only available while your session is in a solar system.",
      });
    }

    log.debug(`[MarketProxy] GetSystemAsks system=${solarSystemID}`);
    try {
      const result = await marketDaemonClient.call("GetSystemAsks", {
        solar_system_id: solarSystemID,
      });
      const structureMarketAccess = createStructureMarketRowAccessScope(
        session,
        Date.now(),
      );
      return buildCachedMethodCallResult(
        buildSummaryDict(
          structureMarketAccess.filterRows(
            result,
            ["best_ask_station_id", "bestAskStationID"],
          ),
          "tuple",
        ),
        {
          method: "GetSystemAsks",
          sessionInfo: "solarsystemid2",
          sessionInfoValue: solarSystemID,
        },
      );
    } catch (error) {
      throwMarketUnavailable("GetSystemAsks", error);
    }
  }

  async Handle_GetRegionBest(args, session) {
    const regionID = getNumericSessionValue(session, ["regionid", "regionID"]);
    if (!regionID) {
      throwWrappedUserError("CustomInfo", {
        info: "Region market data is unavailable because your session has no active region.",
      });
    }

    log.debug(`[MarketProxy] GetRegionBest region=${regionID}`);
    try {
      const result = await marketDaemonClient.call("GetRegionBest", {
        region_id: regionID,
      });
      const structureMarketAccess = createStructureMarketRowAccessScope(
        session,
        Date.now(),
      );
      return buildSummaryDict(
        structureMarketAccess.filterRows(
          result,
          ["best_ask_station_id", "bestAskStationID"],
        ),
        "bestByOrder",
      );
    } catch (error) {
      throwMarketUnavailable("GetRegionBest", error);
    }
  }

  async Handle_GetOrders(args, session) {
    const typeID = Number(args && args.length > 0 ? args[0] : 0) || 0;
    const regionID = getNumericSessionValue(session, ["regionid", "regionID"]);
    const currentStationID = getNumericSessionValue(session, [
      "stationid",
      "stationID",
      "structureid",
      "structureID",
      "locationid",
    ]);
    const currentSolarSystemID = getNumericSessionValue(session, [
      "solarsystemid2",
      "solarsystemid",
      "solarSystemID",
    ]);
    log.debug(`[MarketProxy] GetOrders type=${typeID} region=${regionID}`);

    if (!typeID || !regionID) {
      return buildCachedMethodCallResult(
        [EMPTY_ORDER_ROWSET, EMPTY_ORDER_ROWSET],
        {
          method: "GetOrders",
          args: [typeID],
          sessionInfo: "solarsystemid2",
          sessionInfoValue: currentSolarSystemID,
        },
      );
    }

    try {
      const result = await marketDaemonClient.call("GetOrders", {
        region_id: regionID,
        type_id: typeID,
      });
      const structureMarketAccess = createStructureMarketRowAccessScope(
        session,
        Date.now(),
      );
      const sells = structureMarketAccess.filterRows(
        result && result.sells,
      );
      const buys = structureMarketAccess.filterRows(
        result && result.buys,
      );
      return buildCachedMethodCallResult(
        [
          buildOrderRowset(sells, {
            currentStationID,
            currentSolarSystemID,
          }),
          buildOrderRowset(buys, {
            currentStationID,
            currentSolarSystemID,
          }),
        ],
        {
          method: "GetOrders",
          args: [typeID],
          sessionInfo: "solarsystemid2",
          sessionInfoValue: currentSolarSystemID,
        },
      );
    } catch (error) {
      throwMarketUnavailable("GetOrders", error);
    }
  }

  async Handle_GetOldPriceHistory(args) {
    const typeID = Number(args && args.length > 0 ? args[0] : 0) || 0;
    log.debug(`[MarketProxy] GetOldPriceHistory type=${typeID}`);
    if (!typeID) {
      return buildEmptyHistoryRowset();
    }

    try {
      const result = await marketDaemonClient.call("GetHistory", {
        type_id: typeID,
      });
      return buildHistoryPair(result && result.rows)[0];
    } catch (error) {
      throwMarketUnavailable("GetOldPriceHistory", error);
    }
  }

  async Handle_GetNewPriceHistory(args) {
    const typeID = Number(args && args.length > 0 ? args[0] : 0) || 0;
    log.debug(`[MarketProxy] GetNewPriceHistory type=${typeID}`);
    if (!typeID) {
      return buildEmptyHistoryRowset();
    }

    try {
      const result = await marketDaemonClient.call("GetHistory", {
        type_id: typeID,
      });
      return buildHistoryPair(result && result.rows)[1];
    } catch (error) {
      throwMarketUnavailable("GetNewPriceHistory", error);
    }
  }

  async Handle_GetHistoryForManyTypeIDs(args) {
    const typeIDs = extractRequestedTypeIds(args && args.length > 0 ? args[0] : []);
    log.debug(`[MarketProxy] GetHistoryForManyTypeIDs count=${typeIDs.length}`);
    if (typeIDs.length === 0) {
      return buildDict([]);
    }

    try {
      let historyResponses = [];
      try {
        historyResponses = await marketDaemonClient.call("GetHistories", {
          type_ids: typeIDs,
        });
      } catch (batchError) {
        if (!String(batchError && batchError.message).includes("GetHistories")) {
          throw batchError;
        }
        historyResponses = await Promise.all(
          typeIDs.map((typeID) =>
            marketDaemonClient.call("GetHistory", {
              type_id: typeID,
            })),
        );
      }

      const historyEntries = (Array.isArray(historyResponses) ? historyResponses : [])
        .map((historyResponse) => {
          const typeID = Number(historyResponse && historyResponse.type_id) || 0;
          if (!typeID) {
            return null;
          }

          return [
            typeID,
            buildHistoryPair(historyResponse && historyResponse.rows),
          ];
        })
        .filter(Boolean);

      return buildDict(historyEntries);
    } catch (error) {
      throwMarketUnavailable("GetHistoryForManyTypeIDs", error);
    }
  }

  async Handle_GetCharOrders(args, session) {
    const characterID = getNumericSessionValue(session, ["charid", "characterID"]);
    log.debug(`[MarketProxy] GetCharOrders char=${characterID}`);
    if (!characterID) {
      return EMPTY_OWNER_ORDER_ROWSET;
    }

    try {
      const result = await marketDaemonClient.call("GetCharOrders", {
        owner_id: characterID,
        is_corp: false,
      });
      const openOrders = (Array.isArray(result) ? result : []).filter(
        (order) => String(order && order.state ? order.state : "open").toLowerCase() === "open",
      );
      syncOpenBuyEscrowRecords(openOrders);
      const rowset = buildCachedMethodCallResult(
        buildOwnerOrdersRowset(openOrders),
        {
          method: "GetCharOrders",
          sessionInfo: "charid",
          sessionInfoValue: characterID,
        },
      );
      // Kicked only after this read has taken its own escrow snapshot, so the
      // handler never starts a terminal-event sweep alongside its own writes.
      queuePendingExpiryEvents();
      return rowset;
    } catch (error) {
      throwMarketUnavailable("GetCharOrders", error);
    }
  }

  async Handle_GetCorporationOrders(args, session) {
    const authority = getPersistedCorporationAuthority(session);
    if (!corporationAuthorityHasRole(authority, CORP_ROLE_ACCOUNTANT)) {
      throwWrappedUserError("CrpAccessDenied");
    }
    const corporationID = authority.corporationID;
    log.debug(`[MarketProxy] GetCorporationOrders corp=${corporationID}`);
    if (!corporationID) {
      return EMPTY_OWNER_ORDER_ROWSET;
    }

    try {
      const result = await marketDaemonClient.call("GetCorporationOrders", {
        owner_id: corporationID,
        is_corp: true,
      });
      const openOrders = (Array.isArray(result) ? result : []).filter(
        (order) => String(order && order.state ? order.state : "open").toLowerCase() === "open",
      );
      return buildCachedMethodCallResult(
        buildOwnerOrdersRowset(openOrders),
        {
          method: "GetCorporationOrders",
          sessionInfo: "corpid",
          sessionInfoValue: corporationID,
        },
      );
    } catch (error) {
      throwMarketUnavailable("GetCorporationOrders", error);
    }
  }

  async Handle_GetMarketOrderHistory(args, session) {
    const characterID = getNumericSessionValue(session, ["charid", "characterID"]);
    // The history tab is also used for personal orders. Include corporate
    // orders only for current accounting members; a stale corporation session
    // must not expose the former corporation's completed orders.
    const authority = getPersistedCorporationAuthority(session);
    const corporationID = corporationAuthorityHasRole(authority, CORP_ROLE_ACCOUNTANT)
      ? authority.corporationID
      : 0;
    log.debug(
      `[MarketProxy] GetMarketOrderHistory char=${characterID} corp=${corporationID}`,
    );

    if (!characterID && !corporationID) {
      return EMPTY_OWNER_ORDER_ROWSET;
    }

    try {
      await processPendingExpiryEvents();
      const [charOrders, corpOrders] = await Promise.all([
        characterID
          ? marketDaemonClient.call("GetCharOrders", {
              owner_id: characterID,
              is_corp: false,
            })
          : Promise.resolve([]),
        corporationID
          ? marketDaemonClient.call("GetCorporationOrders", {
              owner_id: corporationID,
              is_corp: true,
            })
          : Promise.resolve([]),
      ]);

      const historyOrders = [...(Array.isArray(charOrders) ? charOrders : []), ...(Array.isArray(corpOrders) ? corpOrders : [])]
        .filter(
          (order) => String(order && order.state ? order.state : "open").toLowerCase() !== "open",
        );

      return buildCachedMethodCallResult(
        buildOwnerOrdersRowset(historyOrders),
        {
          method: "GetMarketOrderHistory",
          sessionInfo: "charid",
          sessionInfoValue: characterID,
        },
      );
    } catch (error) {
      throwMarketUnavailable("GetMarketOrderHistory", error);
    }
  }

  Handle_CharGetTransactions(args, session) {
    const characterID = getNumericSessionValue(session, ["charid", "characterID"]);
    const fromDate = args && args.length > 0 ? args[0] : null;
    log.debug(
      `[MarketProxy] CharGetTransactions char=${characterID} fromDate=${normalizeBigInt(fromDate, 0n).toString()}`,
    );

    if (!characterID) {
      return buildList([]);
    }

    return buildMarketTransactionList(
      filterMarketTransactionsFromDate(
        getCharacterMarketTransactions(characterID),
        fromDate,
      ),
    );
  }

  Handle_CorpGetTransactions(args, session) {
    const corporationID = getNumericSessionValue(session, [
      "corpid",
      "corporationID",
    ]);
    const fromDate = args && args.length > 0 ? args[0] : null;
    const accountKey = args && args.length > 1 && args[1] !== null
      ? normalizePositiveInteger(args[1], ACCOUNT_KEY.CASH)
      : null;
    // Corporation market transactions are wallet history and carry the same read rule:
    // Accountant or Junior Accountant sees every division, anyone else only the
    // divisions they hold Account Take for. A null accountKey means "every division",
    // and falls out of the same check -- no division bit can satisfy it, so it needs an
    // accountant. The stock client agrees: the Market Transactions tab is built only
    // under walletUtil.AmAccountantOrTrader, whose body checks exactly those two roles.
    if (
      corporationID &&
      !hasCorporationWalletDivisionReadAccess(session, accountKey)
    ) {
      log.warn(
        `[MarketProxy] CorpGetTransactions denied: no read access to corporation `
          + `wallet division char=${getNumericSessionValue(session, ["charid", "characterID"])} `
          + `corp=${corporationID} accountKey=${accountKey === null ? "any" : accountKey}`,
      );
      throwWrappedUserError("CrpAccessDenied", {
        reason: [
          101,
          "UI/Corporations/AccessRestrictions/NoAccessToWalletDivision",
        ],
      });
    }
    log.debug(
      `[MarketProxy] CorpGetTransactions corp=${corporationID} accountKey=${accountKey === null ? "any" : accountKey} fromDate=${normalizeBigInt(fromDate, 0n).toString()}`,
    );
    const result = corporationID
      ? buildMarketTransactionList(
          filterMarketTransactionsFromDate(
            getCorporationMarketTransactions(corporationID, { accountKey }),
            fromDate,
          ),
        )
      : buildList([]);
    return buildCachedMethodCallResult(result, {
      serviceName: this.name,
      method: "CorpGetTransactions",
      args: [fromDate, accountKey],
      sessionInfo: "corpid",
      sessionInfoValue: corporationID,
    });
  }

  async Handle_GetCharEscrow(args, session) {
    const characterID = getNumericSessionValue(session, ["charid", "characterID"]);
    log.debug(`[MarketProxy] GetCharEscrow char=${characterID}`);
    if (!characterID) {
      return buildKeyVal([
        ["iskEscrow", 0],
        ["itemsEscrow", 0],
      ]);
    }

    try {
      await processPendingExpiryEvents();
      const ownerOrders = await fetchCharacterOrders(characterID);
      syncOpenBuyEscrowRecords(ownerOrders);
      const escrowRecords = listEscrowRecords()
        .filter(
          (record) =>
            normalizePositiveInteger(record && record.ownerId, 0) === characterID &&
            !normalizeBoolean(record && record.isCorp),
        );

      const iskEscrow = escrowRecords
        .filter((record) => getEscrowType(record) === "buy")
        .reduce(
          (total, record) => total + roundIsk(record && record.escrowAmount),
          0,
        );
      const itemsEscrow = escrowRecords
        .filter((record) => getEscrowType(record) === "sell")
        .reduce(
          (total, record) =>
            total + normalizePositiveInteger(record && record.remainingQuantity, 0),
          0,
        );

      return buildKeyVal([
        ["iskEscrow", roundIsk(iskEscrow)],
        ["itemsEscrow", itemsEscrow],
      ]);
    } catch (error) {
      throwMarketUnavailable("GetCharEscrow", error);
    }
  }

  async Handle_GetPlexBest(args, session) {
    log.debug("[MarketProxy] GetPlexBest");
    const regionID = getNumericSessionValue(session, ["regionid", "regionID"]);
    if (!regionID) {
      return buildCachedMethodCallResult(
        buildDict([]),
        {
          method: "GetPlexBest",
          sessionInfo: "regionid",
          sessionInfoValue: regionID,
        },
      );
    }

    try {
      const result = await marketDaemonClient.call("GetRegionBest", {
        region_id: regionID,
      });
      const plexRows = (Array.isArray(result) ? result : []).filter(
        (row) => Number(row && row.type_id) === PLEX_TYPE_ID,
      );
      const structureMarketAccess = createStructureMarketRowAccessScope(
        session,
        Date.now(),
      );
      return buildCachedMethodCallResult(
        buildSummaryDict(
          structureMarketAccess.filterRows(
            plexRows,
            ["best_ask_station_id", "bestAskStationID"],
          ),
          "bestByOrder",
        ),
        {
          method: "GetPlexBest",
          sessionInfo: "regionid",
          sessionInfoValue: regionID,
        },
      );
    } catch (error) {
      throwMarketUnavailable("GetPlexBest", error);
    }
  }

  async Handle_GetPlexOrders(args, session) {
    log.debug("[MarketProxy] GetPlexOrders");
    const regionID = getNumericSessionValue(session, ["regionid", "regionID"]);
    if (!regionID) {
      return buildCachedMethodCallResult(
        [EMPTY_ORDER_ROWSET, EMPTY_ORDER_ROWSET],
        {
          method: "GetPlexOrders",
          sessionInfo: "regionid",
          sessionInfoValue: regionID,
        },
      );
    }

    try {
      const result = await marketDaemonClient.call("GetOrders", {
        region_id: regionID,
        type_id: PLEX_TYPE_ID,
      });
      const structureMarketAccess = createStructureMarketRowAccessScope(
        session,
        Date.now(),
      );
      const sells = structureMarketAccess.filterRows(
        result && result.sells,
      );
      const buys = structureMarketAccess.filterRows(
        result && result.buys,
      );
      return buildCachedMethodCallResult(
        [
          buildOrderRowset(sells),
          buildOrderRowset(buys),
        ],
        {
          method: "GetPlexOrders",
          sessionInfo: "regionid",
          sessionInfoValue: regionID,
        },
      );
    } catch (error) {
      throwMarketUnavailable("GetPlexOrders", error);
    }
  }

  async Handle_GetPlexHistory() {
    log.debug("[MarketProxy] GetPlexHistory");
    try {
      const result = await marketDaemonClient.call("GetHistory", {
        type_id: PLEX_TYPE_ID,
      });
      return buildDict([
        [PLEX_TYPE_ID, buildHistoryPair(result && result.rows)],
      ]);
    } catch (error) {
      throwMarketUnavailable("GetPlexHistory", error);
    }
  }

  async Handle_GetPlexOldPriceHistory() {
    log.debug("[MarketProxy] GetPlexOldPriceHistory");
    try {
      const result = await marketDaemonClient.call("GetHistory", {
        type_id: PLEX_TYPE_ID,
      });
      return buildHistoryPair(result && result.rows)[0];
    } catch (error) {
      throwMarketUnavailable("GetPlexOldPriceHistory", error);
    }
  }

  async Handle_GetPlexNewPriceHistory() {
    log.debug("[MarketProxy] GetPlexNewPriceHistory");
    try {
      const result = await marketDaemonClient.call("GetHistory", {
        type_id: PLEX_TYPE_ID,
      });
      return buildHistoryPair(result && result.rows)[1];
    } catch (error) {
      throwMarketUnavailable("GetPlexNewPriceHistory", error);
    }
  }

  async Handle_CancelCharOrder(args, session) {
    const orderID = normalizeOrderId(args && args.length > 0 ? args[0] : 0);
    log.debug(`[MarketProxy] CancelCharOrder order=${orderID}`);

    try {
      await processPendingExpiryEvents({ forceSweep: true });
      const order = await loadCharacterOrderOrThrow(session, orderID);
      const orderRow = getOwnerOrderResponseOrder(order);
      if (String(order && order.state ? order.state : "open").toLowerCase() !== "open") {
        return null;
      }
      const stationID = normalizePositiveInteger(orderRow && orderRow.station_id, 0);
      ensureStructureMarketServiceAccess(session, stationID);
      const cancelResponse = await marketDaemonClient.call("CancelOrder", {
        order_id: orderID,
      });

      if (String(cancelResponse && cancelResponse.state || "") === "cancelled") {
        await applyTerminalOrderEvent({
          event_type: "cancelled",
          order: {
            ...order,
            state: "cancelled",
          },
        });
      }
      return null;
    } catch (error) {
      if (isMachoWrappedException(error)) {
        throw error;
      }
      throwMarketUnavailable("CancelCharOrder", error);
    }
  }

  async Handle_PlaceBuyOrder(args, session) {
    const stationID = normalizePositiveInteger(args && args[0], 0);
    const typeID = normalizePositiveInteger(args && args[1], 0);
    const price = roundIsk(args && args[2]);
    const quantity = normalizePositiveInteger(args && args[3], 0);
    const orderRange = normalizeInteger(args && args[4], RANGE_STATION);
    const minVolume = normalizePositiveInteger(args && args[5], 1);
    const durationDays = normalizeInteger(args && args[6], 0);
    const useCorp = normalizeBoolean(args && args[7]);
    const expectedBrokerFee = args && args.length > 8 ? args[8] : null;
    const characterID = getNumericSessionValue(session, ["charid", "characterID"]);
    const regionID = getNumericSessionValue(session, ["regionid", "regionID"]);

    log.debug(
      `[MarketProxy] PlaceBuyOrder char=${characterID} station=${stationID} type=${typeID} quantity=${quantity} duration=${durationDays}`,
    );

    const owner = resolveMarketOrderOwner(session, useCorp);
    if (!characterID || !regionID || !stationID || !typeID || !quantity) {
      throwWrappedUserError("CustomInfo", {
        info: "Buy order request is missing required market details.",
      });
    }
    ensureValidPrice(price);

    try {
      await processPendingExpiryEvents({ forceSweep: true });
      const result = await executeBuyRequest({
        session,
        characterID,
        stationID,
        regionID,
        typeID,
        maxPrice: price,
        requestedQuantity: quantity,
        orderRange,
        minVolume,
        durationDays,
        expectedBrokerFee,
        owner,
      });

      if (!result.createdOrder && result.boughtQuantity <= 0) {
        throwWrappedUserError("CustomInfo", {
          info: "No matching sell orders were available at the requested price.",
        });
      }

      return null;
    } catch (error) {
      if (isMachoWrappedException(error)) {
        throw error;
      }
      throwMarketUnavailable("PlaceBuyOrder", error);
    }
  }

  async Handle_BuyMultipleItems(args, session) {
    const stationID = normalizePositiveInteger(args && args[0], 0);
    const itemList = marshalListToPlainArray(args && args[1]);
    const useCorp = normalizeBoolean(args && args[2]);
    const characterID = getNumericSessionValue(session, ["charid", "characterID"]);
    const regionID = getNumericSessionValue(session, ["regionid", "regionID"]);

    log.debug(
      `[MarketProxy] BuyMultipleItems char=${characterID} station=${stationID} count=${itemList.length}`,
    );

    const owner = resolveMarketOrderOwner(session, useCorp);
    if (!characterID || !regionID || !stationID) {
      return [];
    }

    try {
      await processPendingExpiryEvents({ forceSweep: true });
      // The orders made, one for each line bought (marketsvc.BuyMulti answers them), each run out once bought: the
      // client's multibuy window waits for every one's expiry (OnOwnOrdersChanged, 'Expiry') and puts back what was
      // left unbought, or closes once nothing is (buyMultiFromBase _PerformTrade, _ProccessExpiredOrders).
      const ordersMade = [];
      for (const rawEntry of itemList) {
        const entry = marshalObjectToPlainObject(rawEntry);
        const typeID = normalizePositiveInteger(entry && entry.typeID, 0);
        const quantity = normalizePositiveInteger(entry && entry.quantity, 0);
        const price = roundIsk(entry && entry.price);
        if (!typeID || !quantity) {
          continue;
        }
        ensureValidPrice(price);

        const minVolume = normalizePositiveInteger(entry && entry.minVolume, 1);
        const bought = await executeBuyRequest({
          session,
          characterID,
          stationID,
          regionID,
          typeID,
          maxPrice: price,
          requestedQuantity: quantity,
          orderRange: RANGE_STATION,
          minVolume,
          durationDays: 0,
          owner,
        });
        ordersMade.push(buildImmediateBuyOrder({
          characterID,
          owner,
          stationID,
          regionID,
          typeID,
          price,
          quantity,
          remaining: bought && Number.isFinite(Number(bought.remainingQuantity)) ? Number(bought.remainingQuantity) : quantity,
          minVolume,
        }));
      }

      if (ordersMade.length > 0) {
        notifyOwnOrdersChanged(characterID, ordersMade, ORDER_REASON_EXPIRED, Boolean(owner && owner.isCorp));
      }
      return buildList(ordersMade.map((order) => buildOrderNotificationEntry(order)));
    } catch (error) {
      if (isMachoWrappedException(error)) {
        throw error;
      }
      throwMarketUnavailable("BuyMultipleItems", error);
    }
  }

  async Handle_PlaceMultiSellOrder(args, session) {
    const itemList = marshalListToPlainArray(args && args[0]);
    const useCorp = normalizeBoolean(args && args[1]);
    const durationDays = normalizeInteger(args && args[2], 0);
    const expectedBrokerFee = args && args.length > 3 ? args[3] : null;
    const characterID = getNumericSessionValue(session, ["charid", "characterID"]);

    log.debug(
      `[MarketProxy] PlaceMultiSellOrder char=${characterID} count=${itemList.length} duration=${durationDays}`,
    );

    const owner = resolveMarketOrderOwner(session, useCorp);
    if (!characterID || itemList.length === 0) {
      return false;
    }

    let hadTradeOrOrder = false;
    try {
      await processPendingExpiryEvents({ forceSweep: true });
      for (const rawEntry of itemList) {
        const entry = marshalObjectToPlainObject(rawEntry);
        const result = await executeSellEntry({
          session,
          entry,
          durationDays,
          expectedBrokerFee,
          owner,
        });
        if ((result && result.soldQuantity > 0) || (result && result.createdOrder)) {
          hadTradeOrOrder = true;
        }
      }

      return hadTradeOrOrder;
    } catch (error) {
      if (isMachoWrappedException(error)) {
        throw error;
      }
      throwMarketUnavailable("PlaceMultiSellOrder", error);
    }
  }

  async Handle_PlacePlexSellOrder(args, session) {
    const entry = marshalObjectToPlainObject(args && args[0]);
    const useCorp = normalizeBoolean(args && args[1]);
    const durationDays = normalizeInteger(args && args[2], 0);
    const expectedBrokerFee = args && args.length > 3 ? args[3] : null;

    log.debug(
      `[MarketProxy] PlacePlexSellOrder item=${normalizePositiveInteger(entry && entry.itemID, 0)} duration=${durationDays}`,
    );

    assertPersonalMarketOnly(useCorp);
    if (normalizePositiveInteger(entry && entry.typeID, 0) !== PLEX_TYPE_ID) {
      throwWrappedUserError("CustomInfo", {
        info: "PLEX sell orders must use a PLEX inventory item.",
      });
    }

    try {
      await processPendingExpiryEvents({ forceSweep: true });
      const result = await executeSellEntry({
        session,
        entry,
        durationDays,
        expectedBrokerFee,
      });
      return Boolean((result && result.soldQuantity > 0) || (result && result.createdOrder));
    } catch (error) {
      if (isMachoWrappedException(error)) {
        throw error;
      }
      throwMarketUnavailable("PlacePlexSellOrder", error);
    }
  }

  async Handle_ModifyCharOrder(args, session) {
    const orderID = normalizeOrderId(args && args[0]);
    const newPrice = roundIsk(args && args[1]);

    log.debug(`[MarketProxy] ModifyCharOrder order=${orderID} price=${newPrice}`);

    ensureValidPrice(newPrice);

    try {
      await processPendingExpiryEvents({ forceSweep: true });
      const order = await loadCharacterOrderOrThrow(session, orderID);
      const orderRow = getOwnerOrderResponseOrder(order);
      if (String(order && order.state ? order.state : "open").toLowerCase() !== "open") {
        return null;
      }
      const oldPrice = Number(orderRow && orderRow.price) || 0;
      const remainingVolume = normalizePositiveInteger(orderRow && orderRow.vol_remaining, 0);
      const ownerID = normalizePositiveInteger(order && order.owner_id, 0);
      const orderIsCorp = normalizeBoolean(order && order.is_corp);
      // The daemon only knows owner_id/is_corp - the wallet division lives in
      // our own escrow bookkeeping, so it must be read from there rather than
      // re-derived, or a modify would silently reset it to the default
      // division.
      const modifyEscrowRecord = getEscrowRecord(orderID);
      if (orderIsCorp) {
        const takeRole = getCorporationWalletDivisionTakeRole(
          normalizeCorporationWalletKey(modifyEscrowRecord && modifyEscrowRecord.accountKey),
        );
        if (!takeRole || !corporationAuthorityHasRole(getPersistedCorporationAuthority(session), takeRole)) {
          throwWrappedUserError("CrpAccessDenied");
        }
      }
      const ownerWalletOptions = orderIsCorp
        ? { isCorp: true, accountKey: modifyEscrowRecord && modifyEscrowRecord.accountKey }
        : {};
      const stationID = normalizePositiveInteger(orderRow && orderRow.station_id, 0);
      const typeLabel = getMarketTypeLabel(orderRow && orderRow.type_id);
      ensureStructureMarketServiceAccess(session, stationID);
      const marketContext = buildCharacterMarketContext(session, ownerID, stationID);
      ensureRemoteOrderModificationAllowed(session, stationID, marketContext);
      if (!(remainingVolume > 0) || Math.abs(newPrice - oldPrice) < 0.0001) {
        return null;
      }

      const oldOrderValue = computeOrderValue(oldPrice, remainingVolume);
      const newOrderValue = computeOrderValue(newPrice, remainingVolume);
      const brokerFeeInfo = computeBrokerFeeInfo(
        marketContext,
        oldOrderValue,
        newOrderValue,
      );
      const sccSurchargeInfo = computeSccSurchargeInfo(
        marketContext,
        oldOrderValue,
        newOrderValue,
      );
      const reserveDelta = normalizeBoolean(orderRow && orderRow.bid)
        ? roundIsk(newOrderValue - oldOrderValue)
        : 0;
      const stationMarketOwnerID = getMarketCounterpartyOwnerID(stationID);
      await applySignedCharacterWalletDelta(
        ownerID,
        -reserveDelta,
        reserveDelta > 0
          ? `Market escrow increase for modified ${typeLabel} order ${orderID}`
          : `Market escrow refund for modified ${typeLabel} order ${orderID}`,
        stationID,
        {
          ...ownerWalletOptions,
          entryTypeID: JOURNAL_ENTRY_TYPE.MARKET_ESCROW,
          ownerID1: stationMarketOwnerID || stationID,
          ownerID2: ownerID,
          referenceID: stationID,
        },
      );
      await applySignedCharacterWalletDelta(
        ownerID,
        -brokerFeeInfo.amount,
        brokerFeeInfo.amount > 0
          ? `Broker fee for modified ${typeLabel} order ${orderID}`
          : `Broker fee refund for modified ${typeLabel} order ${orderID}`,
        stationID,
        {
          ...ownerWalletOptions,
          entryTypeID: JOURNAL_ENTRY_TYPE.BROKERS_FEE,
          ownerID1: stationMarketOwnerID || stationID,
          ownerID2: ownerID,
          referenceID: stationID,
        },
      );
      await applySignedCharacterWalletDelta(
        ownerID,
        -sccSurchargeInfo.amount,
        sccSurchargeInfo.amount > 0
          ? `SCC surcharge for modified ${typeLabel} order ${orderID}`
          : `SCC surcharge refund for modified ${typeLabel} order ${orderID}`,
        stationID,
        {
          ...ownerWalletOptions,
          entryTypeID: JOURNAL_ENTRY_TYPE.MARKET_PROVIDER_TAX,
          ownerID1: stationMarketOwnerID || stationID,
          ownerID2: ownerID,
          referenceID: stationID,
        },
      );

      let finalState = String(order && order.state ? order.state : "open");
      let finalRemainingVolume = remainingVolume;
      try {
        const modifyResponse = await marketDaemonClient.call("ModifyOrder", {
          order_id: orderID,
          new_price: newPrice,
        });
        finalState = String(modifyResponse && modifyResponse.state ? modifyResponse.state : "open");
        finalRemainingVolume = normalizePositiveInteger(
          modifyResponse && modifyResponse.vol_remaining,
          remainingVolume,
        );

        if (normalizeBoolean(orderRow && orderRow.bid)) {
          const fillResponse = await applyBuyOrderCrossingAfterModify(session, order, newPrice);
          finalState = String(fillResponse && fillResponse.state ? fillResponse.state : finalState);
          finalRemainingVolume = normalizePositiveInteger(
            fillResponse && fillResponse.vol_remaining,
            finalRemainingVolume,
          );
        } else {
          const fillResponse = await applySellOrderCrossingAfterModify(session, order, newPrice);
          finalState = String(fillResponse && fillResponse.state ? fillResponse.state : finalState);
          finalRemainingVolume = normalizePositiveInteger(
            fillResponse && fillResponse.vol_remaining,
            finalRemainingVolume,
          );
        }
      } catch (error) {
        if (!hasPendingCrossingFillSaga(orderID)) {
          await applySignedCharacterWalletDelta(
            ownerID,
            reserveDelta,
            reserveDelta > 0
              ? `Market escrow refund for failed modified ${typeLabel} order ${orderID}`
              : `Market escrow reversal for failed modified ${typeLabel} order ${orderID}`,
            stationID,
            {
              ...ownerWalletOptions,
              entryTypeID: JOURNAL_ENTRY_TYPE.MARKET_ESCROW,
              ownerID1: stationMarketOwnerID || stationID,
              ownerID2: ownerID,
              referenceID: stationID,
            },
          );
          await applySignedCharacterWalletDelta(
            ownerID,
            brokerFeeInfo.amount,
            brokerFeeInfo.amount > 0
              ? `Broker fee refund for failed modified ${typeLabel} order ${orderID}`
              : `Broker fee reversal for failed modified ${typeLabel} order ${orderID}`,
            stationID,
            {
              ...ownerWalletOptions,
              entryTypeID: JOURNAL_ENTRY_TYPE.BROKERS_FEE,
              ownerID1: stationMarketOwnerID || stationID,
              ownerID2: ownerID,
              referenceID: stationID,
            },
          );
          await applySignedCharacterWalletDelta(
            ownerID,
            sccSurchargeInfo.amount,
            sccSurchargeInfo.amount > 0
              ? `SCC surcharge refund for failed modified ${typeLabel} order ${orderID}`
              : `SCC surcharge reversal for failed modified ${typeLabel} order ${orderID}`,
            stationID,
            {
              ...ownerWalletOptions,
              entryTypeID: JOURNAL_ENTRY_TYPE.MARKET_PROVIDER_TAX,
              ownerID1: stationMarketOwnerID || stationID,
              ownerID2: ownerID,
              referenceID: stationID,
            },
          );
        }
        throw error;
      }

      await creditStructureMarketBrokerFeeOwner(
        ownerID,
        stationID,
        brokerFeeInfo.amount,
        `Structure broker fee for modified ${typeLabel} order ${orderID}`,
      );

      if (normalizeBoolean(orderRow && orderRow.bid)) {
        if (finalState === "filled") {
          removeEscrowRecord(orderID);
        } else {
          upsertBuyEscrowRecord(
            {
              ...order,
              row: {
                ...orderRow,
                price: newPrice,
                vol_remaining: finalRemainingVolume,
              },
            },
            {
              account_key: modifyEscrowRecord && modifyEscrowRecord.accountKey,
            },
          );
        }
      }

      notifyOwnOrdersChanged(
        ownerID,
        [{
          ...order,
          row: {
            ...orderRow,
            price: newPrice,
            vol_remaining: finalRemainingVolume,
          },
          state: finalState,
        }],
        finalState === "filled"
          ? ORDER_REASON_FILLED
          : finalRemainingVolume < remainingVolume
            ? ORDER_REASON_PARTIAL
            : ORDER_REASON_MODIFIED,
        orderIsCorp,
      );
      return null;
    } catch (error) {
      if (isMachoWrappedException(error)) {
        throw error;
      }
      throwMarketUnavailable("ModifyCharOrder", error);
    }
  }

  async Handle_ModifyPlexCharOrder(args, session) {
    return this.Handle_ModifyCharOrder(args, session);
  }
}

module.exports = MarketProxyService;
module.exports.quoteCrewSalesTax = (ownerID, stationID, gross) => computeSalesTaxAmount(buildCharacterMarketContext(null, ownerID, stationID), gross);
module.exports.isCrewQuoteOrderPending = orderID => hasPendingMarketFillSagaForOrder(orderID);
module.exports.prepareCrewPurchase = async function prepareCrewPurchase(ownerID, stationID, order, tag, limits) {
  const station = require("../../space/worldData").getStationByID(stationID), metadata = resolveItemByTypeID(order.typeID);
  if (!station || metadata?.groupID !== 18 || !/^[a-f0-9]{64}$/.test(tag.jobID) || !Number.isSafeInteger(tag.serial) || tag.serial < 1) throw new Error("CREW_PURCHASE_INVALID");
  const stock = () => listContainerItems(ownerID,stationID,ITEM_FLAGS.HANGAR).filter(i=>i.typeID===order.typeID&&i.singleton===0&&!i.custodyReservation).reduce((sum,i)=>sum+i.quantity,0);
  if (stock() >= order.targetStock) return { ready:false,status:"stock_target_met" };
  const book = await marketDaemonClient.call("GetOrders",{region_id:station.regionID,type_id:order.typeID});
  const available = Math.min(limits.allowance, Math.max(0, getCharacterWallet(ownerID).balance - limits.walletReserve));
  if (available < 0.01) return {ready:false,status:"wallet_reserve"};
  const needed = order.targetStock-stock();
  if (needed <= 0) return {ready:false,status:"stock_target_met"};
  const asks = (book?.sells||[]).filter(o=>o.source==="seed"&&o.bid===false&&Number(o.station_id)===stationID&&Number(o.type_id)===order.typeID&&o.price>=0.01&&Math.abs(o.price*100-Math.round(o.price*100))<0.0001&&o.price<=order.maximumPrice&&o.vol_remaining>0&&!hasPendingMarketFillSagaForOrder(o.order_id)).sort((a,b)=>a.price-b.price||String(a.order_id).localeCompare(String(b.order_id)));
  for (const ask of asks) {
    const priceCents = Math.round(ask.price*100), quantity = Math.min(needed,order.batchSize,ask.vol_remaining,Math.floor(Math.round(available*100)/priceCents));
    if (quantity < Math.min(ask.min_volume||1,ask.vol_remaining)) continue;
    const cost = roundIsk(quantity*ask.price);
    const saga = buildSeedSellFillSaga({sellOrder:ask,buyerCharacterID:ownerID,destinationStationID:stationID,typeID:order.typeID,
      tradedQuantity:quantity,availableQuantity:ask.vol_remaining,orderPrice:ask.price,grossCost:cost,stationMarketOwnerID:getMarketCounterpartyOwnerID(stationID),chargeBuyerWallet:true});
    saga.crewPurchase = {...tag,walletReserve:limits.walletReserve,targetStock:order.targetStock};
    return {ready:true,saga,summary:{typeID:order.typeID,name:metadata.name,quantity,unitPrice:ask.price,cost,orderID:saga.orderID}};
  }
  return {ready:false,status:asks.length?"budget_too_small":"waiting_for_sellers"};
};
module.exports.settleCrewPurchase = async function settleCrewPurchase(saga) {
  const prior = getCrewPurchaseReceipt(saga.buyerCharacterID);
  if (prior?.serial >= saga.crewPurchase.serial) {
    if (prior.serial !== saga.crewPurchase.serial || prior.jobID !== saga.crewPurchase.jobID) throw new Error("CREW_PURCHASE_STALE");
    return prior.result;
  }
  let anchor = getEscrowRecord(saga.anchorOrderID);
  if (!anchor) {anchor={orderId:saga.anchorOrderID,escrowType:"seed-fill",pendingFill:saga,createdAt:saga.createdAt};persistSeedMarketFillSaga(anchor,saga);}
  if (anchor.pendingFill?.operationKey !== saga.operationKey) throw new Error("CREW_PURCHASE_CONFLICT");
  try {await executeSeedSellFillSaga(anchor,anchor.pendingFill,getMarketTypeLabel(saga.typeID),{scheduleRecovery:false});}
  catch(error){if(getCrewPurchaseReceipt(saga.buyerCharacterID)?.jobID!==saga.crewPurchase.jobID)throw error;}
  const done=getCrewPurchaseReceipt(saga.buyerCharacterID);if(done?.jobID!==saga.crewPurchase.jobID)throw new Error("CREW_PURCHASE_PENDING");return done.result;
};
// Server-owned crew trading: one exact local NPC bid fill per durable intent.
// The crew never fabricates a docked pilot session or creates market demand.
module.exports.prepareCrewSale = async function prepareCrewSale(ownerID, stationID, order, tag) {
  const station = require("../../space/worldData").getStationByID(stationID);
  const metadata = resolveItemByTypeID(order.typeID);
  if (!station || ![7, 8].includes(metadata?.categoryID) || !/^[a-f0-9]{64}$/.test(tag.jobID) || !Number.isSafeInteger(tag.serial) || tag.serial < 1) throw new Error("CREW_SALE_INVALID");
  let stocks = listContainerItems(ownerID, stationID, ITEM_FLAGS.HANGAR).filter(i => i.typeID === order.typeID && i.singleton === 0 && !i.custodyReservation && i.quantity > 0);
  let surplus = stocks.reduce((sum, i) => sum + i.quantity, 0) - order.reserve;
  if (surplus <= 0) return { ready: false, status: "reserve_met" };
  const book = await marketDaemonClient.call("GetOrders", { region_id: station.regionID, type_id: order.typeID });
  stocks = listContainerItems(ownerID, stationID, ITEM_FLAGS.HANGAR).filter(i => i.typeID === order.typeID && i.singleton === 0 && !i.custodyReservation && i.quantity > 0);
  surplus = stocks.reduce((sum, i) => sum + i.quantity, 0) - order.reserve;
  if (surplus <= 0) return { ready: false, status: "reserve_met" };
  const bids = (book?.buys || []).filter(b => b.source === "seed" && b.bid === true && Number(b.station_id) === stationID &&
    Number(b.type_id) === order.typeID && Number(b.price) >= order.minimumPrice && b.price > 0 && b.vol_remaining > 0 && !hasPendingMarketFillSagaForOrder(b.order_id))
    .sort((a, b) => b.price - a.price || String(a.order_id).localeCompare(String(b.order_id)));
  for (const bid of bids) for (const item of stocks.sort((a,b) => a.itemID - b.itemID)) {
    const quantity = Math.min(surplus, item.quantity, order.batchSize, bid.vol_remaining);
    if (quantity < Math.min(bid.min_volume || 1, bid.vol_remaining)) continue;
    const gross = roundIsk(bid.price * quantity), tax = computeSalesTaxAmount(buildCharacterMarketContext(null, ownerID, stationID), gross);
    const saga = buildSeedBuyFillSaga({ buyOrder: bid, sellerCharacterID: ownerID, destinationStationID: stationID,
      typeID: order.typeID, fillableQuantity: quantity, availableQuantity: bid.vol_remaining, orderPrice: bid.price,
      grossAmount: gross, salesTax: tax, stationMarketOwnerID: getMarketCounterpartyOwnerID(stationID), sourceItemID: item.itemID });
    saga.crewSale = { ...tag, stationID, reserve: order.reserve };
    return { ready: true, saga, summary: { typeID: order.typeID, name: metadata.name, quantity, unitPrice: bid.price, gross, tax, net: roundIsk(gross-tax), orderID: saga.orderID } };
  }
  return { ready: false, status: "waiting_for_buyers" };
};
module.exports.settleCrewSale = async function settleCrewSale(saga) {
  const prior = getCrewSaleReceipt(saga.sellerCharacterID);
  if (prior?.serial >= saga.crewSale.serial) {
    if (prior.serial !== saga.crewSale.serial || prior.jobID !== saga.crewSale.jobID) throw new Error("CREW_SALE_STALE");
    return prior.result;
  }
  let anchor = getEscrowRecord(saga.anchorOrderID);
  if (!anchor) { anchor = { orderId: saga.anchorOrderID, escrowType: "seed-fill", pendingFill: saga, createdAt: saga.createdAt }; persistSeedMarketFillSaga(anchor, saga); }
  if (anchor.pendingFill?.operationKey !== saga.operationKey) throw new Error("CREW_SALE_CONFLICT");
  try { await executeSeedBuyFillSaga(anchor, anchor.pendingFill, getMarketTypeLabel(saga.typeID), { scheduleRecovery: false }); }
  catch (error) { if (!getCrewSaleReceipt(saga.sellerCharacterID) || getCrewSaleReceipt(saga.sellerCharacterID).jobID !== saga.crewSale.jobID) throw error; }
  const done = getCrewSaleReceipt(saga.sellerCharacterID);
  if (done?.jobID !== saga.crewSale.jobID) throw new Error("CREW_SALE_PENDING");
  return done.result;
};
module.exports.cancelStructureMarketOrdersForServiceLoss =
  cancelStructureMarketOrdersForServiceLoss;
module.exports.DURABLE_EXPIRY_JOB_TYPE = DURABLE_EXPIRY_JOB_TYPE;
module.exports.DURABLE_FILL_RECOVERY_JOB_TYPE = DURABLE_FILL_RECOVERY_JOB_TYPE;
module.exports.bindDurableScheduler = bindDurableScheduler;
module.exports.handleDurableMarketFillRecovery = handleDurableMarketFillRecovery;
module.exports.handleDurableMarketOrderExpiry = handleDurableMarketOrderExpiry;
module.exports.reconcileDurableMarketOrders = reconcileDurableMarketOrders;
module.exports.unbindDurableScheduler = unbindDurableScheduler;
module.exports.__testHooks = {
  MARKET_ESCROW_LOCATION_BASE,
  MARKET_ESCROW_STATE_ACTIVE,
  MARKET_ESCROW_STATE_PLACING,
  applyCancelledStructureMarketOrder,
  applySellOrderCrossingAfterModify,
  applyTerminalOrderEvent,
  buildDurableMarketFillRecoveryJob,
  buildOrderRowset,
  buildDurableMarketExpiryJob,
  buildDurableMarketExpiryJobID,
  createStructureMarketRowAccessScope,
  consumeInventoryItemQuantity: consumeSeedMarketInventoryQuantity,
  deliverSeedItemToCharacter,
  isMarketDaemonUnavailableError,
  marshalObjectToPlainObject,
  normalizeInteger,
  normalizeNumericValue,
  normalizePositiveInteger,
  reconcilePlacingSellEscrowRecords,
  recordCompletedMarketFillAchievements,
  recoverPendingMarketFillSagas,
  recoverPendingPlayerSellFillSagas,
  releaseOrphanedMarketEscrow,
  scheduleDurableMarketFillRecovery,
  scheduleDurableMarketOrderExpiry,
  sweepStrandedMarketEscrowItems,
  stopMarketExpiryPollerForTests,
  waitForMarketExpiryPollerIdleForTests,
};
