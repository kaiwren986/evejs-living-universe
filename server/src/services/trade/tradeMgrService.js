"use strict";

const path = require("path");

const BaseService = require(path.join(__dirname, "../baseService"));
const config = require(path.join(__dirname, "../../config"));
const { PROXY_NODE_ID } = require(path.join(__dirname, "../../network/protocolProfile"));
const database = require(path.join(__dirname, "../../gameStore"));
const log = require(path.join(__dirname, "../../utils/logger"));
const {
  throwWrappedUserError,
} = require(path.join(__dirname, "../../common/machoErrors"));
const {
  buildKeyVal,
  buildList,
  buildObjectEx1,
  currentFileTime,
  extractList,
  isMarshalKeyValName,
  normalizeNumber,
  normalizeText,
  unwrapMarshalValue,
} = require(path.join(__dirname, "../_shared/serviceHelpers"));
const {
  buildInventoryItemRow,
  emitItemsChangedBatchForSession,
  emitFittingTransactionForSession,
} = require(path.join(__dirname, "../character/characterState"));
const {
  DEFAULT_STATION,
} = require(path.join(__dirname, "../_shared/stationStaticData"));
const {
  ITEM_FLAGS,
  findItemById,
  listContainerItems,
} = require(path.join(__dirname, "../inventory/itemStore"));
const itemCustody = require(path.join(__dirname, "../inventory/itemCustody"));
const tradeItemCustody = require(path.join(
  __dirname,
  "../inventory/tradeItemCustody",
));
const tradeRuntimeState = require(path.join(__dirname, "./tradeRuntimeState"));
const assetSafetyRecovery = require(path.join(__dirname, "../structure/structureAssetSafetyRecovery"));
const { resolveItemByTypeID } = require("../inventory/itemTypeRegistry");
const { isShipFittingFlag, getFittedModuleItems, getLoadedChargeByFlag,
  isChargeCompatibleWithModule } = require("../fitting/liveFittingState");
const {
  getCorporationOfficeByInventoryID,
  getLockedItemsByLocation,
} = require(path.join(__dirname, "../corporation/corporationRuntimeState"));
const {
  CORP_HANGAR_FLAGS,
} = require(path.join(__dirname, "../industry/industryConstants"));
const {
  canTakeFromCorporationHangarForInventory,
} = require(path.join(__dirname, "../inventory/invBroker/corporationHangarTakeAccess"));
const {
  isTradableInventoryItem,
} = require(path.join(__dirname, "../inventory/typeListAuthority"));
const {
  adjustCharacterBalanceAsync,
  getCharacterWallet,
  JOURNAL_ENTRY_TYPE,
} = require(path.join(__dirname, "../account/walletState"));
const {
  isWalletAuthorityProcessEnabled,
} = require(path.join(__dirname, "../account/walletCommandAuthority"));
const sessionRegistry = require(path.join(__dirname, "../chat/sessionRegistry"));
const {
  getDockedLocationID,
  getDockedLocationKind,
  isDockedSession,
} = require(path.join(__dirname, "../structure/structureLocation"));

const TRADE_COMPLETED_TTL_MS = 2 * 60 * 1000;
const ASSET_SAFETY_WRAP_TYPE_ID = 60;
const TRADE_MONIKER_NAME = "carbon.common.script.net.moniker.Moniker";
const TRADE_LIST_HEADER = [
  "tradeContainerID",
  "traders",
  "state",
  "money",
  "items",
];
let activeTradeMgrService = null;
let tradeFaultInjector = null;
const DBTYPE = {
  BOOL: 0x0b,
  I1: 0x10,
  UI1: 0x11,
  I2: 0x02,
  UI2: 0x12,
  I4: 0x03,
  UI4: 0x13,
  I8: 0x14,
  UI8: 0x15,
  CY: 0x06,
  FILETIME: 0x40,
  R4: 0x04,
  R8: 0x05,
};

function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizePositiveInteger(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric <= 0) {
    return fallback;
  }
  return numeric;
}

function buildBoundSubstruct(boundObjectID) {
  return {
    type: "substruct",
    value: {
      type: "substream",
      value: [boundObjectID, currentFileTime()],
    },
  };
}

function buildMarshalSet(values = []) {
  return buildObjectEx1("__builtin__.set", [
    buildList(Array.isArray(values) ? values : []),
  ]);
}

function buildTradeListRow(header = [], line = []) {
  return {
    type: "object",
    name: "carbon.common.script.sys.row.Row",
    args: {
      type: "dict",
      entries: [
        ["header", buildList(header)],
        ["line", buildList(line)],
      ],
    },
  };
}

function numericArray(values = []) {
  return (Array.isArray(values) ? values : extractList(values))
    .map((value) => Number(value) || 0)
    .filter((value) => value > 0);
}

function setsEqual(left, right) {
  if (left.size !== right.size) {
    return false;
  }
  for (const value of left) {
    if (!right.has(value)) {
      return false;
    }
  }
  return true;
}

function getDbTypeSizeBits(type) {
  switch (type) {
    case DBTYPE.CY:
    case DBTYPE.I8:
    case DBTYPE.UI8:
    case DBTYPE.FILETIME:
    case DBTYPE.R8:
      return 64;
    case DBTYPE.I4:
    case DBTYPE.UI4:
    case DBTYPE.R4:
      return 32;
    case DBTYPE.I2:
    case DBTYPE.UI2:
      return 16;
    case DBTYPE.I1:
    case DBTYPE.UI1:
      return 8;
    case DBTYPE.BOOL:
      return 1;
    default:
      return 0;
  }
}

function decompressRle(buffer, expectedLength) {
  const output = Buffer.alloc(Math.max(0, expectedLength), 0);
  let inputIndex = 0;
  let outputIndex = 0;

  while (inputIndex < buffer.length && outputIndex < output.length) {
    const control = buffer[inputIndex++];
    const lowNibble = control & 0x0f;
    const highNibble = (control >> 4) & 0x0f;

    for (const nibble of [lowNibble, highNibble]) {
      if (outputIndex >= output.length) {
        break;
      }
      if (nibble < 8) {
        const count = Math.min(8 - nibble, output.length - outputIndex);
        if (count > 0) {
          buffer.copy(output, outputIndex, inputIndex, inputIndex + count);
          inputIndex += count;
          outputIndex += count;
        }
      } else {
        const count = Math.min(nibble - 7, output.length - outputIndex);
        output.fill(0, outputIndex, outputIndex + count);
        outputIndex += count;
      }
    }
  }

  return output;
}

function decodePackedNumericValue(type, buffer, offset) {
  switch (type) {
    case DBTYPE.CY:
    case DBTYPE.I8:
      return buffer.readBigInt64LE(offset);
    case DBTYPE.UI8:
    case DBTYPE.FILETIME:
      return buffer.readBigUInt64LE(offset);
    case DBTYPE.I4:
    case DBTYPE.UI4:
      // Native Windows DBRow getter uses the same signed32 PyInt constructor.
      return buffer.readInt32LE(offset);
    case DBTYPE.R4:
      return buffer.readFloatLE(offset);
    case DBTYPE.R8:
      return buffer.readDoubleLE(offset);
    case DBTYPE.I2:
      return buffer.readInt16LE(offset);
    case DBTYPE.UI2:
      return buffer.readUInt16LE(offset);
    case DBTYPE.I1:
      return buffer.readInt8(offset);
    case DBTYPE.UI1:
      return buffer.readUInt8(offset);
    default:
      return null;
  }
}

function normalizePackedRowColumns(packedRow) {
  if (Array.isArray(packedRow && packedRow.columns)) {
    return packedRow.columns;
  }

  const header = packedRow && packedRow.header;
  if (
    header &&
    header.type &&
    (header.type === "objectex1" || header.type === "objectex2") &&
    Array.isArray(header.header) &&
    header.header.length >= 2 &&
    Array.isArray(header.header[1]) &&
    header.header[1].length >= 1 &&
    Array.isArray(header.header[1][0])
  ) {
    return header.header[1][0];
  }

  return [];
}

function decodePackedRowNumericFields(packedRow) {
  if (!packedRow || typeof packedRow !== "object") {
    return {};
  }

  const columns = normalizePackedRowColumns(packedRow);
  const rleData = Buffer.isBuffer(packedRow.rleData)
    ? packedRow.rleData
    : null;
  if (!columns.length || !rleData) {
    return {};
  }

  const sizeMap = [];
  const booleanColumns = new Map();
  let booleansBitLength = 0;
  let nullsBitLength = 0;
  let byteDataBitLength = 0;

  for (let index = 0; index < columns.length; index += 1) {
    const [, type] = columns[index];
    const size = getDbTypeSizeBits(type);
    if (type === DBTYPE.BOOL) {
      booleanColumns.set(index, booleansBitLength);
      booleansBitLength += 1;
    }
    nullsBitLength += 1;
    if (size >= 8) {
      byteDataBitLength += size;
    }
    sizeMap.push({ size, index, type });
  }

  sizeMap.sort((left, right) => {
    if (right.size !== left.size) {
      return right.size - left.size;
    }
    return left.index - right.index;
  });

  const bitDataByteLength = ((booleansBitLength + nullsBitLength) >> 3) + 1;
  const byteDataByteLength = byteDataBitLength >> 3;
  const packedBuffer = decompressRle(rleData, byteDataByteLength + bitDataByteLength);
  const rowData = packedBuffer.subarray(0, byteDataByteLength);
  const bitData = packedBuffer.subarray(byteDataByteLength);
  const fields = {};
  let rowOffset = 0;

  for (const entry of sizeMap) {
    const [name] = columns[entry.index] || [];
    const normalizedName = normalizeText(name, "");
    if (!normalizedName) {
      continue;
    }

    const nullBit = entry.index + booleansBitLength;
    const nullByte = nullBit >> 3;
    const nullMask = 1 << (nullBit & 0x7);
    const isNull = Boolean(bitData[nullByte] & nullMask);

    if (entry.size > 1) {
      if (isNull) {
        fields[normalizedName] = null;
        continue;
      }
      const byteLength = entry.size >> 3;
      fields[normalizedName] = decodePackedNumericValue(entry.type, rowData, rowOffset);
      rowOffset += byteLength;
      continue;
    }

    if (entry.type !== DBTYPE.BOOL) {
      continue;
    }

    if (isNull) {
      fields[normalizedName] = null;
      continue;
    }

    const boolBit = booleanColumns.get(entry.index);
    const boolByte = boolBit >> 3;
    const boolMask = 1 << (boolBit & 0x7);
    fields[normalizedName] = Boolean(bitData[boolByte] & boolMask);
  }

  return fields;
}

function extractManifestFieldRaw(manifestValue, fieldName) {
  if (!manifestValue || typeof manifestValue !== "object") {
    return null;
  }

  if (
    manifestValue.type === "object" &&
    isMarshalKeyValName(manifestValue.name) &&
    manifestValue.args &&
    manifestValue.args.type === "dict"
  ) {
    return extractManifestFieldRaw(manifestValue.args, fieldName);
  }

  if (manifestValue.type === "dict" && Array.isArray(manifestValue.entries)) {
    for (const [entryKey, entryValue] of manifestValue.entries) {
      if (normalizeText(entryKey, "") === fieldName) {
        return entryValue;
      }
    }
    return null;
  }

  const unwrapped = unwrapMarshalValue(manifestValue);
  return unwrapped && typeof unwrapped === "object" && !Array.isArray(unwrapped)
    ? unwrapped[fieldName]
    : null;
}

function extractManifestTradeItemEntries(value) {
  if (Array.isArray(value)) {
    return value.filter((entry) => !Buffer.isBuffer(entry) || entry.length > 0);
  }

  if (value instanceof Set) {
    return [...value].filter((entry) => !Buffer.isBuffer(entry) || entry.length > 0);
  }

  if (!value || typeof value !== "object") {
    return [];
  }

  if (
    (value.type === "list" || value.type === "tuple" || value.type === "set") &&
    Array.isArray(value.items)
  ) {
    return value.items.filter((entry) => !Buffer.isBuffer(entry) || entry.length > 0);
  }

  if (
    (value.type === "objectex1" || value.type === "objectex2") &&
    Array.isArray(value.header) &&
    value.header.length >= 2 &&
    normalizeText(value.header[0], "") === "__builtin__.set"
  ) {
    const headerArgs = Array.isArray(value.header[1]) ? value.header[1] : [];
    const headerItems = extractManifestTradeItemEntries(headerArgs[0]);
    const tailItems = Array.isArray(value.list)
      ? value.list.filter((entry) => !Buffer.isBuffer(entry) || entry.length > 0)
      : [];
    return [...headerItems, ...tailItems];
  }

  const unwrapped = unwrapMarshalValue(value);
  return Array.isArray(unwrapped) ? unwrapped : [];
}

function getItemIDFromManifestEntry(entry) {
  if (entry === null || entry === undefined) {
    return 0;
  }

  if (typeof entry === "number" || typeof entry === "bigint") {
    return Number(entry) || 0;
  }

  if (typeof entry === "object") {
    if (Number(entry.itemID) > 0) {
      return Number(entry.itemID);
    }
    if (entry.type === "packedrow") {
      const decodedFields = decodePackedRowNumericFields(entry);
      if (Number(decodedFields.itemID) > 0) {
        return Number(decodedFields.itemID);
      }
    }
    if (entry.fields && Number(entry.fields.itemID) > 0) {
      return Number(entry.fields.itemID);
    }
    if (entry.line && Array.isArray(entry.line.items) && Number(entry.line.items[0]) > 0) {
      return Number(entry.line.items[0]);
    }
  }

  return 0;
}

class TradeMgrService extends BaseService {
  constructor() {
    super("trademgr");
    this._trades = new Map();
    this._boundContexts = new Map();
    this._tradeByParticipant = new Map();
    activeTradeMgrService = this;
    const recoveryPromise = this._recoverDurableTrades();
    this._recoverySettled = !recoveryPromise;
    this._recoveryPromise = recoveryPromise || Promise.resolve();
    if (recoveryPromise) {
      recoveryPromise.then(() => {
        this._recoverySettled = true;
      });
    }
  }

  ready() {
    return this._recoveryPromise;
  }

  callMethod(method, args, session, kwargs) {
    const dispatch = () => super.callMethod(method, args, session, kwargs);
    return this._recoverySettled
      ? dispatch()
      : this._recoveryPromise.then(dispatch);
  }

  _buildNotify(message) {
    return {
      notify: normalizeText(message, "Trade failed."),
    };
  }

  _throwTradeError(message) {
    throwWrappedUserError("CustomNotify", this._buildNotify(message));
  }

  _nextTradeContainerID() {
    const allocation = tradeRuntimeState.allocateTradeContainerIDDurable();
    if (!allocation || allocation.success !== true) {
      this._throwTradeError("Trade state could not be persisted.");
    }
    return Number(allocation.tradeContainerID) || 0;
  }

  _serializeTrade(trade) {
    const stagedItemOrigins = {};
    for (const [itemID, origin] of trade.stagedItemOrigins || []) {
      stagedItemOrigins[String(itemID)] = cloneValue(origin);
    }
    return {
      schemaVersion: 1,
      tradeID: String(trade.tradeID || ""),
      tradeContainerID: Number(trade.tradeContainerID || 0) || 0,
      dockedLocationID: Number(trade.dockedLocationID || 0) || 0,
      dockedLocationKind: normalizeText(trade.dockedLocationKind, "station"),
      solarSystemID: Number(trade.solarSystemID || 0) || 0,
      traders: Array.isArray(trade.traders) ? trade.traders.slice() : [],
      participantClientIDs: Array.isArray(trade.participantClientIDs)
        ? trade.participantClientIDs.slice()
        : [],
      moneyOffers: Array.isArray(trade.moneyOffers) ? trade.moneyOffers.slice() : [0, 0],
      offerStates: Array.isArray(trade.offerStates) ? trade.offerStates.slice() : [0, 0],
      offerManifests: Array.isArray(trade.offerManifests)
        ? cloneValue(trade.offerManifests)
        : [null, null],
      status: String(trade.status || "open"),
      stagedItemOrigins,
      nextStageID: normalizePositiveInteger(trade.nextStageID, 1),
      completionGeneration: normalizePositiveInteger(trade.completionGeneration, 1),
      pendingStage: trade.pendingStage ? cloneValue(trade.pendingStage) : null,
      abortSaga: trade.abortSaga ? cloneValue(trade.abortSaga) : null,
      completionSaga: trade.completionSaga ? cloneValue(trade.completionSaga) : null,
      updatedAt: new Date().toISOString(),
    };
  }

  _hydrateTrade(record) {
    const origins = record && record.stagedItemOrigins &&
      typeof record.stagedItemOrigins === "object"
      ? record.stagedItemOrigins
      : {};
    return {
      ...cloneValue(record),
      tradeID: String(record.tradeID || `trade:${Number(record.tradeContainerID) || 0}`),
      moneyOffers: Array.isArray(record.moneyOffers) ? record.moneyOffers.slice() : [0, 0],
      offerStates: Array.isArray(record.offerStates) ? record.offerStates.slice() : [0, 0],
      offerManifests: Array.isArray(record.offerManifests)
        ? cloneValue(record.offerManifests)
        : [null, null],
      stagedItemOrigins: new Map(
        Object.entries(origins)
          .map(([itemID, origin]) => [Number(itemID) || 0, cloneValue(origin)])
          .filter(([itemID]) => itemID > 0),
      ),
      nextStageID: normalizePositiveInteger(record.nextStageID, 1),
      completionGeneration: normalizePositiveInteger(record.completionGeneration, 1),
      boundObjectID: null,
      cleanupTimer: null,
    };
  }

  _persistTrade(trade) {
    return tradeRuntimeState.putTradeRecordDurable(this._serializeTrade(trade));
  }

  _persistTradeOrThrow(trade) {
    const result = this._persistTrade(trade);
    if (!result || result.success !== true) {
      this._throwTradeError("Trade state could not be persisted.");
    }
    return result;
  }

  _injectFault(point, trade) {
    if (typeof tradeFaultInjector === "function") {
      tradeFaultInjector(point, trade && this._serializeTrade(trade));
    }
  }

  _createBoundObjectID() {
    const boundId = config.getNextBoundId();
    return `N=${PROXY_NODE_ID}:${boundId}`;
  }

  _ensureTradeBoundObject(trade) {
    if (!trade.boundObjectID) {
      trade.boundObjectID = this._createBoundObjectID();
      this._boundContexts.set(trade.boundObjectID, trade.tradeID);
      if (this.serviceManager) {
        this.serviceManager.registerBoundObject(trade.boundObjectID, this);
      }
    }

    return trade.boundObjectID;
  }

  _bindTradeForSession(trade, session) {
    const boundObjectID = this._ensureTradeBoundObject(trade);
    this.serviceManager?.registerBoundObjectSession?.(boundObjectID, session);
    if (session) {
      if (!session._boundObjectIDs || typeof session._boundObjectIDs !== "object") {
        session._boundObjectIDs = {};
      }
      session._boundObjectIDs[this.name] = boundObjectID;
      session.lastBoundObjectID = boundObjectID;
    }
    return buildBoundSubstruct(boundObjectID);
  }

  _getTradeByBoundObjectID(boundObjectID) {
    if (!boundObjectID) {
      return null;
    }
    const tradeID = this._boundContexts.get(String(boundObjectID)) || null;
    if (!tradeID) {
      return null;
    }
    return this._trades.get(tradeID) || null;
  }

  _getTradeFromSession(session) {
    const currentBoundObjectID =
      session && session.currentBoundObjectID ? session.currentBoundObjectID : null;
    const sessionTrade = this._getTradeByBoundObjectID(currentBoundObjectID);
    if (sessionTrade) {
      return sessionTrade;
    }

    const cachedBoundObjectID =
      session &&
      session._boundObjectIDs &&
      typeof session._boundObjectIDs[this.name] === "string"
        ? session._boundObjectIDs[this.name]
        : null;
    return this._getTradeByBoundObjectID(cachedBoundObjectID);
  }

  _buildTradeBindParams(trade) {
    return [
      Number(trade && trade.dockedLocationID || 0) || 0,
      Number(trade && trade.solarSystemID || 0) || 0,
      Array.isArray(trade && trade.traders) ? trade.traders.slice() : [],
      Array.isArray(trade && trade.participantClientIDs)
        ? trade.participantClientIDs.slice()
        : [],
    ];
  }

  _buildTradeMoniker(trade) {
    return {
      type: "object",
      name: TRADE_MONIKER_NAME,
      args: [
        this.name,
        PROXY_NODE_ID,
        this._buildTradeBindParams(trade),
        null,
      ],
    };
  }

  _getTradeByBindParams(bindParams, session = null) {
    const params = unwrapMarshalValue(bindParams);
    const dockedLocationID = Number(Array.isArray(params) ? params[0] : 0) || 0;
    const traders = numericArray(Array.isArray(params) ? params[2] : []);

    for (const trade of this._trades.values()) {
      if (!trade || trade.status !== "open") {
        continue;
      }
      if (dockedLocationID > 0 && Number(trade.dockedLocationID || 0) !== dockedLocationID) {
        continue;
      }
      if (traders.length > 0 && !setsEqual(new Set(trade.traders), new Set(traders))) {
        continue;
      }
      return trade;
    }

    const characterID = Number(session && session.characterID || 0) || 0;
    const tradeID = characterID > 0 ? this._tradeByParticipant.get(characterID) : null;
    return tradeID ? this._trades.get(tradeID) || null : null;
  }

  _getParticipantIndex(trade, characterID) {
    const numericCharacterID = Number(characterID) || 0;
    if (!trade || !Array.isArray(trade.traders)) {
      return -1;
    }
    return trade.traders.findIndex((candidate) => Number(candidate) === numericCharacterID);
  }

  _getParticipantSession(characterID, excludeSession = null) {
    return sessionRegistry.findSessionByCharacterID(characterID, {
      excludeSession,
    });
  }

  _isTradeParticipantDockedInTrade(trade, session) {
    if (!trade || !session || !isDockedSession(session)) {
      return false;
    }

    return Number(getDockedLocationID(session) || 0) === Number(trade.dockedLocationID || 0);
  }

  _resolveTradeContext(session, { requireOpen = false } = {}) {
    const trade = this._getTradeFromSession(session);
    if (!trade) {
      this._throwTradeError("Trade session is no longer available.");
    }

    const characterID = Number(session && session.characterID || 0);
    const participantIndex = this._getParticipantIndex(trade, characterID);
    if (participantIndex < 0) {
      this._throwTradeError("You are not a participant in this trade.");
    }

    if (trade.status === "open" && !this._isTradeParticipantDockedInTrade(trade, session)) {
      this._abortTrade(trade, { notifyParticipants: true });
    }

    if (requireOpen && trade.status !== "open") {
      this._throwTradeError("Trade session is no longer available.");
    }

    return {
      trade,
      participantIndex,
      characterID,
    };
  }

  // Inventory and dogma calls name the container itself. Do not infer their
  // trade from a different/current cached trademgr moniker.
  getInventoryTrade(containerID, session) {
    const numericID = Number(containerID) || 0;
    const trade = [...this._trades.values()].find((entry) => entry.tradeContainerID === numericID);
    if (!trade) return null;
    if (!this._recoverySettled || trade.status !== "open" ||
        this._getParticipantIndex(trade, Number(session?.characterID || session?.charid)) < 0 ||
        !this._isTradeParticipantDockedInTrade(trade, session)) {
      throwWrappedUserError("FakeItemNotFound");
    }
    if (!this._ensureAllParticipantsStillValid(trade)) throwWrappedUserError("FakeItemNotFound");
    return trade;
  }

  getInventoryTradeItem(trade, session) {
    // Retain the existing virtual trade self-item's type; fill its actual type
    // metadata because native UnloadModuleToContainer reads groupID.
    const type = resolveItemByTypeID(DEFAULT_STATION.stationTypeID);
    if (!type) throwWrappedUserError("FakeItemNotFound");
    return { ...type, itemID: trade.tradeContainerID, typeID: type.typeID,
      ownerID: Number(session.characterID || session.charid), locationID: trade.dockedLocationID,
      flagID: ITEM_FLAGS.HANGAR, quantity: -1, stacksize: 1, singleton: 1 };
  }

  addInventoryTradeItems(containerID, itemIDs, sourceID, quantity, session, options = {}) {
    const trade = this.getInventoryTrade(containerID, session);
    if (!trade) throwWrappedUserError("FakeItemNotFound");
    const ids = [...new Set(itemIDs.map(Number))];
    if (!ids.length) this._throwTradeError("Select items to offer in the trade.");
    for (const id of ids) this._validateOfferedItem(findItemById(id), session, sourceID);
    const result = { changes: [], stagedRootItemIDs: [] };
    for (const id of ids) {
      const staged = this._stageItemIntoTrade(trade, session, id, sourceID, quantity, options);
      result.changes.push(...staged.changes);
      result.stagedRootItemIDs.push(...staged.stagedRootItemIDs);
    }
    this._notifyTradeItemPriming(trade, result.stagedRootItemIDs);
    this._resetOfferState(trade);
    return result;
  }

  _fittedTradeSource(item) {
    const ship = item && findItemById(item.locationID);
    return ship && Number(ship.categoryID) === 6 && isShipFittingFlag(Number(item.flagID)) &&
      [7, 8].includes(Number(item.categoryID)) ? ship : null;
  }

  _validateFittedTradeSource(item, session) {
    const ship = this._fittedTradeSource(item);
    if (!ship) return;
    const actorID = Number(session.characterID || session.charid);
    if (Number(ship.ownerID) !== actorID || Number(ship.itemID) !==
        Number(session.activeShipID || session.shipID || session.shipid)) {
      this._throwTradeError("Only fitted items on your active ship can be offered through this path.");
    }
    const broker = this.serviceManager?.lookup("invbroker");
    if (!broker) this._throwTradeError("The fitted inventory service is not ready.");
    if (broker._isRigHeldBySlot(item)) this._throwTradeError("A fitted rig cannot be moved into trade.");
    if (Number(item.categoryID) === 7) {
      if (getLoadedChargeByFlag(actorID, ship.itemID, item.flagID)) {
        this._throwTradeError("Unload the module's ammunition into this trade before offering the module.");
      }
      const overflow = broker._getUnfitCargoOverflow(session, item, { locationID: 0, flagID: ITEM_FLAGS.HANGAR });
      if (overflow) broker._throwUnfitCargoOverflowUserError(overflow);
    }
  }

  _notifyFittedTradeChange(session, item, previous, sourceContext) {
    const actorID = Number(session.characterID || session.charid);
    const shipID = Number(session.activeShipID || session.shipID || session.shipid);
    const fitted = (row) => row && Number(row.ownerID) === actorID &&
      Number(row.locationID) === shipID && isShipFittingFlag(Number(row.flagID));
    const nowFitted = fitted(item), wasFitted = fitted(previous);
    if (!shipID || (!nowFitted && !wasFitted)) return false;
    if (Number(item.categoryID) !== 8) {
      emitFittingTransactionForSession(session, shipID, [{ item, previousData: previous }]);
      return true;
    }
    const dogma = this.serviceManager?.lookup("dogmaIM");
    if (!dogma) return false;
    // At Trade the charge is an ordinary real stack. On return, retire that
    // stack and restore the slot's tuple identity, never a real fitted row.
    const clientChanges = nowFitted
      ? dogma._filterInventoryChangesForClient(session, [{ item, previousData: previous }])
      : [{ item, previousData: previous }];
    emitItemsChangedBatchForSession(session, clientChanges, { idType: "clientID", locationContext: null });
    const flagID = Number(nowFitted ? item.flagID : previous.flagID);
    const key = `${shipID}:${flagID}`;
    if (!sourceContext.chargeTransitionsManaged && !sourceContext.notifiedChargeSlots.has(key)) {
      sourceContext.notifiedChargeSlots.add(key);
      const prior = fitted(sourceContext.sourceItem) ? sourceContext.sourceItem : wasFitted ? previous : null;
      const before = prior ? { typeID: Number(prior.typeID), quantity: Number(prior.stacksize ?? prior.quantity) }
        : { typeID: 0, quantity: 0 };
      const after = dogma._captureChargeStateSnapshot(actorID, shipID, flagID);
      dogma._notifyChargeQuantityTransition(session, actorID, shipID, flagID, before, after, {
        previousChargeItem: prior, nextChargeItem: dogma._captureChargeItemSnapshot(actorID, shipID, flagID),
      });
      const module = getFittedModuleItems(actorID, shipID).find((entry) => Number(entry.flagID) === flagID);
      if (module) {
        dogma._notifyWeaponModuleAttributeTransition(session, module, prior,
          dogma._captureChargeItemSnapshot(actorID, shipID, flagID));
      }
      dogma._refreshDockedFittingState(session, [{ item, previousData: previous }]);
    }
    return true;
  }

  _canReturnFittedTradeItem(leg) {
    const target = leg.destination;
    if (![7, 8].includes(Number(leg.sourceItem.categoryID)) || !isShipFittingFlag(Number(target.flagID))) return true;
    const ship = findItemById(target.locationID);
    if (!ship || Number(ship.categoryID) !== 6 || Number(ship.singleton) !== 1 ||
        Number(ship.ownerID) !== Number(target.ownerID)) return false;
    const modules = getFittedModuleItems(target.ownerID, target.locationID)
      .filter((entry) => Number(entry.flagID) === Number(target.flagID));
    if (Number(leg.sourceItem.categoryID) === 7) {
      return !modules.some((entry) => Number(entry.itemID) !== Number(leg.itemID));
    }
    const module = modules.find((entry) => Number(entry.itemID) === Number(target.loadedChargeModuleID));
    const charge = getLoadedChargeByFlag(target.ownerID, target.locationID, target.flagID);
    return Boolean(module && isChargeCompatibleWithModule(module.typeID, leg.sourceItem.typeID) &&
      (!charge || Number(charge.itemID) === Number(leg.itemID)));
  }

  _buildListResponse(trade) {
    return buildTradeListRow(TRADE_LIST_HEADER, [
      Number(trade.tradeContainerID) || 0,
      trade.traders.slice(),
      buildList((trade.offerManifests || [null, null]).slice()),
      buildList(trade.moneyOffers.slice()),
      this._buildTradeItemsSetPayload(trade),
    ]);
  }

  _buildTradeItemRows(tradeOrItems) {
    const items = Array.isArray(tradeOrItems)
      ? tradeOrItems
      : this._listTradeItems(tradeOrItems);
    return items.map((item) => buildInventoryItemRow(item));
  }

  _buildTradeItemsSetPayload(tradeOrItems) {
    return buildMarshalSet(this._buildTradeItemRows(tradeOrItems));
  }

  _buildOfferManifestPayload(trade) {
    return buildKeyVal([
      ["tradeContainerID", Number(trade.tradeContainerID) || 0],
      ["money", buildList(trade.moneyOffers.slice())],
      ["tradeItems", this._buildTradeItemsSetPayload(trade)],
    ]);
  }

  _buildSelfInvItem(trade, session) {
    return buildKeyVal([
      ["itemID", Number(trade.tradeContainerID) || 0],
      ["typeID", DEFAULT_STATION.stationTypeID],
      ["ownerID", Number(session && session.characterID || 0) || 0],
      ["locationID", Number(trade.dockedLocationID || 0) || 0],
      ["flagID", ITEM_FLAGS.HANGAR],
      ["stacksize", 1],
      ["quantity", -1],
      ["singleton", 1],
    ]);
  }

  _listTradeItems(trade) {
    return listContainerItems(null, trade.tradeContainerID, null)
      .sort((left, right) => Number(left.itemID || 0) - Number(right.itemID || 0));
  }

  _cleanupTradeIndex(trade) {
    if (!trade || !Array.isArray(trade.traders)) {
      return;
    }
    for (const characterID of trade.traders) {
      const numericCharacterID = Number(characterID) || 0;
      if (numericCharacterID > 0 && this._tradeByParticipant.get(numericCharacterID) === trade.tradeID) {
        this._tradeByParticipant.delete(numericCharacterID);
      }
    }
  }

  _scheduleTradeCleanup(trade, ttlMs = TRADE_COMPLETED_TTL_MS) {
    if (!trade) {
      return;
    }

    if (trade.cleanupTimer) {
      clearTimeout(trade.cleanupTimer);
      trade.cleanupTimer = null;
    }

    const timer = setTimeout(() => {
      this._cleanupTradeIndex(trade);
      if (trade.boundObjectID) {
        this._boundContexts.delete(trade.boundObjectID);
      }
      this._trades.delete(trade.tradeID);
      const removeResult = tradeRuntimeState.removeTradeRecordDurable(
        trade.tradeContainerID,
      );
      if (!removeResult || removeResult.success !== true) {
        log.warn(
          `[TradeMgr] Failed to retire durable trade ${trade.tradeID}: ` +
            `${removeResult && removeResult.errorMsg || "unknown persistence error"}`,
        );
      }
    }, Math.max(1000, Number(ttlMs) || TRADE_COMPLETED_TTL_MS));
    if (typeof timer.unref === "function") {
      timer.unref();
    }
    trade.cleanupTimer = timer;
  }

  _notifyParticipants(trade, name, payload, options = {}) {
    for (const characterID of trade.traders) {
      const session = this._getParticipantSession(characterID, null);
      if (!session || typeof session.sendNotification !== "function") {
        continue;
      }
      session.sendNotification(name, options.idType || "clientID", payload);
    }
  }

  _resetOfferState(trade, options = {}) {
    trade.offerStates = [0, 0];
    trade.offerManifests = [null, null];
    if (options.persist !== false) {
      this._persistTradeOrThrow(trade);
    }
    if (options.notify !== false) {
      this._notifyParticipants(trade, "OnTradeOffer", [
        trade.tradeContainerID,
        buildList(trade.offerManifests.slice()),
      ]);
    }
  }

  _notifyItemChangeToTradeParticipants(trade, changedItem, previousState = {}, sourceContext = {}) {
    for (const characterID of trade.traders) {
      const session = this._getParticipantSession(characterID, null);
      if (!session) {
        continue;
      }

      const numericCharacterID = Number(characterID) || 0;
      const nextOwnerID = Number(changedItem && changedItem.ownerID || 0) || 0;
      const previousOwnerID = Number(previousState && previousState.ownerID || 0) || 0;
      const nextLocationID = Number(changedItem && changedItem.locationID || 0) || 0;
      const previousLocationID = Number(previousState && previousState.locationID || 0) || 0;
      const touchesTradeContainer =
        nextLocationID === trade.tradeContainerID ||
        previousLocationID === trade.tradeContainerID;
      const touchesSessionOwner =
        nextOwnerID === numericCharacterID ||
        previousOwnerID === numericCharacterID;
      // A partial corporation offer debits a row that remains in the office,
      // owned by the corporation. Its acting pilot still needs that row's
      // quantity change for the native invCache; the other trader does not.
      const touchesActingSource =
        Number(sourceContext.characterID || 0) === numericCharacterID &&
        Number(sourceContext.itemID || 0) === Number(changedItem && changedItem.itemID || 0);

      if (!touchesTradeContainer && !touchesSessionOwner && !touchesActingSource) {
        continue;
      }

      if (this._notifyFittedTradeChange(session, changedItem, previousState, sourceContext)) continue;

      emitItemsChangedBatchForSession(
        session,
        [{ item: changedItem, previousData: previousState || {} }],
        { idType: "clientID", locationContext: null },
      );
    }
  }

  _notifyChangeList(trade, changes = [], sourceContext = {}) {
    sourceContext = { ...sourceContext, notifiedChargeSlots: new Set() };
    for (const change of Array.isArray(changes) ? changes : []) {
      if (!change || !change.item) {
        continue;
      }
      this._notifyItemChangeToTradeParticipants(
        trade,
        change.item,
        change.previousData || {},
        sourceContext,
      );
    }
  }

  _notifyTradeItemPriming(trade, rootItemIDs = []) {
    const normalizedRootIDs = [...new Set(
      (Array.isArray(rootItemIDs) ? rootItemIDs : [rootItemIDs])
        .map((value) => Number(value) || 0)
        .filter((value) => value > 0),
    )];
    if (normalizedRootIDs.length <= 0) {
      return;
    }

    const primeItemIDs = [];
    const seen = new Set();
    for (const rootItemID of normalizedRootIDs) {
      if (!seen.has(rootItemID)) {
        seen.add(rootItemID);
        primeItemIDs.push(rootItemID);
      }
      for (const child of this._collectContainedItems(rootItemID)) {
        const childItemID = Number(child && child.itemID || 0);
        if (childItemID <= 0 || seen.has(childItemID)) {
          continue;
        }
        seen.add(childItemID);
        primeItemIDs.push(childItemID);
      }
    }

    if (primeItemIDs.length <= 0) {
      return;
    }

    this._notifyParticipants(trade, "OnPrimingNeededForTradeItems", [
      primeItemIDs,
    ]);
  }

  _getTradeParticipantSessions(trade) {
    return trade.traders
      .map((characterID) => this._getParticipantSession(characterID, null))
      .filter(Boolean);
  }

  _ensureAllParticipantsStillValid(trade) {
    if (!trade || trade.status !== "open") {
      return false;
    }

    const participantSessions = this._getTradeParticipantSessions(trade);
    if (participantSessions.length !== 2) {
      this._abortTrade(trade, { notifyParticipants: true });
      return false;
    }

    if (!participantSessions.every((session) => this._isTradeParticipantDockedInTrade(trade, session))) {
      this._abortTrade(trade, { notifyParticipants: true });
      return false;
    }

    return true;
  }

  _collectContainedItems(rootItemID) {
    const numericRootItemID = Number(rootItemID) || 0;
    if (numericRootItemID <= 0) {
      return [];
    }

    const collected = [];
    const queue = [numericRootItemID];
    const seen = new Set([numericRootItemID]);

    while (queue.length > 0) {
      const currentLocationID = queue.shift();
      const children = listContainerItems(null, currentLocationID, null)
        .sort((left, right) => Number(left.itemID || 0) - Number(right.itemID || 0));
      for (const child of children) {
        const childItemID = Number(child && child.itemID || 0);
        if (childItemID <= 0 || seen.has(childItemID)) {
          continue;
        }
        seen.add(childItemID);
        collected.push(child);
        queue.push(childItemID);
      }
    }

    return collected;
  }

  _transferContainedItemsToOwner(trade, rootItemID, destinationOwnerID) {
    const changes = [];
    const descendants = this._collectContainedItems(rootItemID);
    for (const child of descendants) {
      const transferResult = tradeItemCustody.transferItem({
        item: child,
        ownerID: destinationOwnerID,
        locationID: child.locationID,
        flagID: child.flagID,
        tradeContainerID: trade.tradeContainerID,
        actor: destinationOwnerID,
        reason: itemCustody.CUSTODY_REASON.TRADE_COMPLETE_CONTENT,
      });
      if (!transferResult.success) {
        return {
          ...transferResult,
          data: {
            ...((transferResult && transferResult.data) || {}),
            changes,
          },
        };
      }
      changes.push(...(((transferResult.data && transferResult.data.changes) || [])));
    }

    return {
      success: true,
      data: {
        changes,
      },
    };
  }

  _buildCompletionLocationContext(trade, changes = []) {
    const firstChange = Array.isArray(changes) ? changes[0] : null;
    const previousLocationID = Number(
      firstChange && firstChange.previousData && firstChange.previousData.locationID || 0,
    ) || 0;
    const nextLocationID = Number(
      firstChange && firstChange.item && firstChange.item.locationID || 0,
    ) || 0;

    if (
      previousLocationID !== Number(trade.tradeContainerID || 0) ||
      nextLocationID !== Number(trade.dockedLocationID || 0)
    ) {
      return null;
    }

    if (normalizeText(trade.dockedLocationKind, "") === "structure") {
      return [
        "Structure",
        Number(trade.dockedLocationID || 0) || 0,
        "StructureItemHangar",
      ];
    }

    return null;
  }

  _groupItemChangesByPreviousContext(changes = []) {
    const groups = new Map();
    for (const change of Array.isArray(changes) ? changes : []) {
      if (!change || !change.item) {
        continue;
      }
      const previous = change.previousData || {};
      const key = JSON.stringify({
        ownerID: previous.ownerID,
        locationID: previous.locationID,
        flagID: previous.flagID,
        quantity: previous.quantity,
        singleton: previous.singleton,
        stacksize: previous.stacksize,
      });
      if (!groups.has(key)) {
        groups.set(key, []);
      }
      groups.get(key).push(change);
    }
    return [...groups.values()];
  }

  _notifyTradeCompletionItemChanges(trade, changes = []) {
    const sessions = this._getTradeParticipantSessions(trade);
    if (sessions.length <= 0) {
      return;
    }

    for (const group of this._groupItemChangesByPreviousContext(changes)) {
      const locationContext = this._buildCompletionLocationContext(trade, group);
      for (const session of sessions) {
        emitItemsChangedBatchForSession(session, group, {
          idType: "charid",
          locationContext,
        });
        emitItemsChangedBatchForSession(session, group, {
          idType: "clientID",
          locationContext: null,
        });
      }
    }
  }

  _abortTrade(trade, options = {}) {
    if (!trade || !["open", "aborting"].includes(trade.status)) {
      return {
        success: true,
        alreadyClosed: true,
      };
    }

    if (trade.status === "open" && trade.pendingStage) {
      const stageRecoveryResult = this._resumePendingStage(trade);
      if (!stageRecoveryResult || stageRecoveryResult.success !== true) {
        return stageRecoveryResult || {
          success: false,
          errorMsg: "TRADE_STAGE_RECOVERY_FAILED",
        };
      }
    }

    if (!trade.abortSaga) {
      const stagedItems = this._listTradeItems(trade);
      const legs = [];
      for (const stagedItem of stagedItems) {
        const itemID = Number(stagedItem.itemID) || 0;
        const returnContext = trade.stagedItemOrigins.get(itemID) || null;
        if (!returnContext) {
          return {
            success: false,
            errorMsg: "TRADE_STAGE_ORIGIN_MISSING",
          };
        }
        legs.push({
          itemID,
          sourceItem: cloneValue(stagedItem),
          destination: cloneValue(returnContext),
          reason:
            Number(stagedItem.ownerID || 0) === Number(returnContext.ownerID || 0)
              ? itemCustody.CUSTODY_REASON.TRADE_ABORT
              : itemCustody.CUSTODY_REASON.TRADE_COMPENSATE,
          idempotencyKey: `trade:${trade.tradeContainerID}:abort:${itemID}`,
          status: "pending",
        });
      }
      trade.status = "aborting";
      // The native tuple-backed charge must regain its original parent module
      // before its quantity/type can be restored to the fitting model.
      legs.sort((a, b) => {
        const order = (leg) => isShipFittingFlag(Number(leg.destination.flagID))
          ? Number(leg.sourceItem.categoryID) === 7 ? 0 : Number(leg.sourceItem.categoryID) === 8 ? 2 : 1 : 1;
        return order(a) - order(b);
      });
      trade.abortSaga = {
        phase: "returning-items",
        legs,
      };
      const persistResult = this._persistTrade(trade);
      if (!persistResult || persistResult.success !== true) {
        return persistResult || { success: false, errorMsg: "TRADE_RUNTIME_WRITE_FAILED" };
      }
    }

    for (const leg of trade.abortSaga.legs || []) {
      if (leg.status === "committed") {
        continue;
      }
      // A return may have committed before its saga checkpoint. Resolve that
      // receipt before applying a new source-slot guard to a finished command.
      const receipt = itemCustody.getCommittedReceipt(leg.idempotencyKey);
      if (!receipt.success || receipt.ambiguous) {
        return { success: false, pending: true, errorMsg: "TRADE_ABORT_RECEIPT_PENDING" };
      }
      if (receipt.committed) {
        leg.status = "committed";
        const checkpoint = this._persistTrade(trade);
        if (!checkpoint?.success) return checkpoint;
        continue;
      }
      if (!this._canReturnFittedTradeItem(leg)) {
        const missingIdentity = Number(leg.sourceItem.categoryID) === 8 &&
          !Number(leg.destination.loadedChargeModuleID);
        return { success: false, pending: true,
          errorMsg: missingIdentity ? "TRADE_FITTING_ORIGIN_UNVERIFIED" : "TRADE_FITTING_RETURN_BLOCKED" };
      }
      const moveResult = tradeItemCustody.transferItem({
        item: leg.sourceItem,
        ownerID: leg.destination.ownerID,
        locationID: leg.destination.locationID,
        flagID: leg.destination.flagID,
        tradeContainerID: trade.tradeContainerID,
        actor: leg.sourceItem.ownerID,
        reason: leg.reason || itemCustody.CUSTODY_REASON.TRADE_ABORT,
        idempotencyKey: leg.idempotencyKey,
      });
      if (!moveResult.success) {
        return moveResult;
      }
      leg.status = "committed";
      const persistResult = this._persistTrade(trade);
      if (!persistResult || persistResult.success !== true) {
        return persistResult || { success: false, errorMsg: "TRADE_RUNTIME_WRITE_FAILED" };
      }
      this._injectFault("after-abort-item", trade);
      this._notifyChangeList(trade, moveResult.data && moveResult.data.changes);
    }

    trade.status = "aborted";
    trade.offerStates = [0, 0];
    trade.offerManifests = [null, null];
    trade.moneyOffers = [0, 0];
    trade.stagedItemOrigins.clear();
    trade.pendingStage = null;
    trade.abortSaga.phase = "completed";
    const persistResult = this._persistTrade(trade);
    if (!persistResult || persistResult.success !== true) {
      return persistResult || { success: false, errorMsg: "TRADE_RUNTIME_WRITE_FAILED" };
    }
    this._cleanupTradeIndex(trade);

    if (options.notifyParticipants !== false) {
      this._notifyParticipants(trade, "OnTradeCancel", [
        trade.tradeContainerID,
      ]);
    }

    this._scheduleTradeCleanup(trade);
    return { success: true };
  }

  _parseManifest(args) {
    const rawManifest = Array.isArray(args) ? args[0] : null;
    const manifest = unwrapMarshalValue(rawManifest);
    const money = Array.isArray(manifest && manifest.money)
      ? manifest.money.map((value) => Math.round((Number(value) || 0) * 100) / 100)
      : [];
    const rawTradeItems = extractManifestFieldRaw(rawManifest, "tradeItems");
    const tradeItems = new Set(
      extractManifestTradeItemEntries(rawTradeItems)
        .map((entry) => getItemIDFromManifestEntry(entry))
        .filter((itemID) => Number.isInteger(itemID) && itemID > 0),
    );

    return {
      tradeContainerID: Number(manifest && manifest.tradeContainerID || 0) || 0,
      money,
      tradeItems,
    };
  }

  _resolveMoveQuantity(kwargs) {
    const normalizedKwargs = unwrapMarshalValue(kwargs);
    const quantity = normalizedKwargs && Object.prototype.hasOwnProperty.call(normalizedKwargs, "qty")
      ? normalizedKwargs.qty
      : null;
    return quantity === null || quantity === undefined
      ? null
      : normalizePositiveInteger(quantity, 1);
  }

  _stageItemIntoTrade(trade, session, itemID, sourceLocationID, quantity = null, options = {}) {
    const item = findItemById(itemID);
    this._validateOfferedItem(item, session, sourceLocationID);

    const originContext = {
      ownerID: Number(item.ownerID || 0) || 0,
      locationID: Number(item.locationID || 0) || 0,
      flagID: Number(item.flagID || 0) || 0,
    };
    if (Number(item.categoryID) === 8 && this._fittedTradeSource(item)) {
      const available = Number(item.stacksize ?? item.quantity);
      if (quantity !== null && quantity !== undefined && Number(quantity) !== available) {
        this._throwTradeError("Unload the whole charge stack into trade; partial fitted-charge trade is not available yet.");
      }
      const module = getFittedModuleItems(item.ownerID, item.locationID)
        .find((entry) => Number(entry.flagID) === Number(item.flagID));
      if (!module) this._throwTradeError("The charge's original fitted module is no longer available.");
      originContext.loadedChargeModuleID = Number(module.itemID);
    }
    const stageID = normalizePositiveInteger(trade.nextStageID, 1);
    trade.nextStageID = stageID + 1;
    trade.pendingStage = {
      stageID,
      actorID: Number(session.characterID),
      item: cloneValue(item),
      quantity,
      originContext: cloneValue(originContext),
      idempotencyKey: `trade:${trade.tradeContainerID}:stage:${stageID}`,
    };
    this._persistTradeOrThrow(trade);

    const moveResult = tradeItemCustody.transferItem({
      item: trade.pendingStage.item,
      ownerID: trade.pendingStage.actorID,
      locationID: trade.tradeContainerID,
      flagID: ITEM_FLAGS.HANGAR,
      quantity,
      tradeContainerID: trade.tradeContainerID,
      actor: trade.pendingStage.actorID,
      reason: itemCustody.CUSTODY_REASON.TRADE_STAGE,
      idempotencyKey: trade.pendingStage.idempotencyKey,
    });
    if (!moveResult.success) {
      if (moveResult.ambiguous !== true) {
        trade.pendingStage = null;
        this._persistTradeOrThrow(trade);
      }
      this._throwTradeError("The item could not be moved into the trade window.");
    }
    this._injectFault("after-stage-custody", trade);

    const changes = (moveResult.data && moveResult.data.changes) || [];
    const committedChanges = (moveResult.data && moveResult.data.committedChanges) || changes;
    const stagedRootItemIDs = [];
    for (const change of committedChanges) {
      const changedItem = change && change.item ? change.item : null;
      if (!changedItem) {
        continue;
      }
      if (Number(changedItem.locationID || 0) === trade.tradeContainerID) {
        trade.stagedItemOrigins.set(Number(changedItem.itemID) || 0, cloneValue(originContext));
        stagedRootItemIDs.push(Number(changedItem.itemID) || 0);
      }
    }
    const replayedStagedItem = moveResult.data && moveResult.data.item;
    const replayedStagedItemID = Number(replayedStagedItem && replayedStagedItem.itemID || 0) || 0;
    if (
      replayedStagedItemID > 0 &&
      Number(replayedStagedItem.locationID || 0) === trade.tradeContainerID &&
      !stagedRootItemIDs.includes(replayedStagedItemID)
    ) {
      trade.stagedItemOrigins.set(replayedStagedItemID, cloneValue(originContext));
      stagedRootItemIDs.push(replayedStagedItemID);
    }

    trade.pendingStage = null;
    this._persistTradeOrThrow(trade);

    this._notifyChangeList(trade, changes, {
      characterID: Number(session.characterID),
      itemID: Number(item.itemID),
      sourceItem: item,
      chargeTransitionsManaged: options.chargeTransitionsManaged === true,
    });
    return {
      changes,
      stagedRootItemIDs,
    };
  }

  _resolveSourceAccessibility(item, session) {
    if (!item || !session) {
      return null;
    }

    const dockedLocationID = Number(getDockedLocationID(session) || 0) || 0;
    if (dockedLocationID <= 0) {
      return null;
    }

    const characterID = Number(session.characterID || 0);
    if (Number(item.ownerID || 0) !== characterID) {
      const corporationID = Number(session.corporationID || session.corpid || 0);
      if (corporationID <= 0 || Number(item.ownerID || 0) !== corporationID ||
          !CORP_HANGAR_FLAGS.includes(Number(item.flagID))) {
        return null;
      }
      // TQ In station trade.txt386 stages a direct office division row under
      // the offering character. Nested corporate sources keep their refusal:
      // their container passwords, locks and ancestor access need a separate audit.
      const office = getCorporationOfficeByInventoryID(corporationID, item.locationID);
      if (!office || office.impounded || Number(office.stationID) !== dockedLocationID ||
          !canTakeFromCorporationHangarForInventory(
            session, corporationID, office.stationID, item.flagID,
          )) {
        return null;
      }
      const lockLocations = new Set([
        office.stationID, office.officeID, office.officeFolderID, office.itemID,
      ].map(Number).filter((locationID) => locationID > 0));
      for (const locationID of lockLocations) {
        if (getLockedItemsByLocation(corporationID, locationID).some((entry) =>
          Number(entry && entry.itemID || entry) === Number(item.itemID))) {
          return null;
        }
      }
      return { rootLocationID: dockedLocationID };
    }

    const visited = new Set();
    let current = item;
    while (current) {
      const currentItemID = Number(current.itemID || 0) || 0;
      const currentLocationID = Number(current.locationID || 0) || 0;

      if (currentLocationID === dockedLocationID) {
        return {
          rootLocationID: dockedLocationID,
        };
      }

      if (currentLocationID <= 0 || visited.has(currentLocationID) || currentItemID === currentLocationID) {
        return null;
      }

      visited.add(currentLocationID);
      current = findItemById(currentLocationID);
    }

    return null;
  }

  _validateOfferedItem(item, session, sourceLocationID) {
    if (assetSafetyRecovery.findSourceWrap(item)) {
      this._throwTradeError("Recover items from asset safety to a personal inventory before offering them in trade.");
    }
    const numericCharacterID = Number(session && session.characterID || 0) || 0;
    const numericSourceLocationID = Number(sourceLocationID) || 0;
    const numericCorporationID = Number(session && (session.corporationID || session.corpid) || 0);
    if (!item || ![numericCharacterID, numericCorporationID].includes(Number(item.ownerID || 0))) {
      this._throwTradeError("That item is not available to trade.");
    }

    if (Number(item.itemID || 0) === Number(session && session.activeShipID || 0)) {
      throwWrappedUserError("PeopleAboardShip", {});
    }

    if (Number(item.typeID || 0) === ASSET_SAFETY_WRAP_TYPE_ID) {
      throwWrappedUserError("CannotTradeAssetSafety", {});
    }

    if (!isTradableInventoryItem(item)) {
      // inventoryrestrictions.ItemCannotBeTraded is a Python class name, not
      // a dialog key. Its native constructor uses this type-list formatter.
      throwWrappedUserError("CannotTradeNonTradable", {
        itemList: [29, buildList([Number(item.typeID || 0) || 0])],
      });
    }

    const accessibility = this._resolveSourceAccessibility(item, session);
    if (!accessibility) {
      this._throwTradeError("That item is not available to trade from your current docked inventory.");
    }

    if (numericSourceLocationID > 0 && Number(item.locationID || 0) !== numericSourceLocationID) {
      this._throwTradeError("That item is no longer in the source inventory.");
    }
    this._validateFittedTradeSource(item, session);
  }

  _prepareCompletionSaga(trade) {
    if (trade.completionSaga) {
      return { success: true, saga: trade.completionSaga };
    }

    const generation = normalizePositiveInteger(trade.completionGeneration, 1);
    const operationKey = `trade:${trade.tradeContainerID}:complete:${generation}`;
    const itemLegs = [];
    for (const stagedItem of this._listTradeItems(trade)) {
      const senderIndex = this._getParticipantIndex(trade, stagedItem.ownerID);
      if (senderIndex < 0) {
        return { success: false, errorMsg: "TRADE_ITEM_OWNER_INVALID" };
      }
      const recipientCharacterID = trade.traders[senderIndex === 0 ? 1 : 0];
      const appendItemLeg = (sourceItem, destination, reason) => {
        const legIndex = itemLegs.length;
        itemLegs.push({
          itemID: Number(sourceItem.itemID) || 0,
          sourceItem: cloneValue(sourceItem),
          destination: cloneValue(destination),
          reason,
          idempotencyKey: `${operationKey}:item:${legIndex}:forward`,
          compensationKey: `${operationKey}:item:${legIndex}:compensate`,
          status: "pending",
          compensationStatus: "pending",
          changes: [],
        });
      };
      appendItemLeg(
        stagedItem,
        {
          ownerID: recipientCharacterID,
          locationID: trade.dockedLocationID,
          flagID: ITEM_FLAGS.HANGAR,
        },
        itemCustody.CUSTODY_REASON.TRADE_COMPLETE,
      );
      for (const child of this._collectContainedItems(stagedItem.itemID)) {
        appendItemLeg(
          child,
          {
            ownerID: recipientCharacterID,
            locationID: child.locationID,
            flagID: child.flagID,
          },
          itemCustody.CUSTODY_REASON.TRADE_COMPLETE_CONTENT,
        );
      }
    }

    const walletLegs = [];
    const transfers = [
      [trade.traders[0], trade.traders[1], trade.moneyOffers[0]],
      [trade.traders[1], trade.traders[0], trade.moneyOffers[1]],
    ];
    for (const [fromCharacterID, toCharacterID, rawAmount] of transfers) {
      const amount = Math.round((Number(rawAmount) || 0) * 100) / 100;
      if (!(amount > 0)) {
        continue;
      }
      const directionIndex = walletLegs.length;
      walletLegs.push({
        characterID: fromCharacterID,
        counterpartyID: toCharacterID,
        amount: -amount,
        ownerID1: fromCharacterID,
        ownerID2: toCharacterID,
        referenceID: toCharacterID,
        description: `Trade with ${toCharacterID}`,
        idempotencyKey: `${operationKey}:wallet:${directionIndex}:debit`,
        compensationKey: `${operationKey}:wallet:${directionIndex}:debit-compensate`,
        status: "pending",
        compensationStatus: "pending",
      });
      walletLegs.push({
        characterID: toCharacterID,
        counterpartyID: fromCharacterID,
        amount,
        ownerID1: fromCharacterID,
        ownerID2: toCharacterID,
        referenceID: fromCharacterID,
        description: `Trade with ${fromCharacterID}`,
        idempotencyKey: `${operationKey}:wallet:${directionIndex}:credit`,
        compensationKey: `${operationKey}:wallet:${directionIndex}:credit-compensate`,
        status: "pending",
        compensationStatus: "pending",
      });
    }

    trade.completionGeneration = generation + 1;
    trade.status = "completing";
    trade.completionSaga = {
      generation,
      operationKey,
      phase: "items",
      walletPreflightPassed: false,
      itemLegs,
      walletLegs,
    };
    const persistResult = this._persistTrade(trade);
    return persistResult && persistResult.success
      ? { success: true, saga: trade.completionSaga }
      : persistResult || { success: false, errorMsg: "TRADE_RUNTIME_WRITE_FAILED" };
  }

  _persistCharacterWalletBoundary() {
    if (isWalletAuthorityProcessEnabled()) {
      return { success: true, durable: true };
    }
    const result = database.flushTableSync("characters");
    return result && result.success
      ? { success: true, durable: true }
      : {
          success: false,
          ambiguous: true,
          errorMsg: result && result.errorMsg || "CHARACTER_WALLET_FLUSH_FAILED",
        };
  }

  async _compensateCompletionSaga(trade, cause) {
    const saga = trade.completionSaga;
    if (!saga) {
      return cause;
    }
    saga.phase = "compensating";
    trade.status = "compensating";
    let persistResult = this._persistTrade(trade);
    if (!persistResult || persistResult.success !== true) {
      return persistResult || { success: false, errorMsg: "TRADE_RUNTIME_WRITE_FAILED" };
    }

    for (const leg of [...saga.walletLegs].reverse()) {
      if (leg.status !== "committed" || leg.compensationStatus === "committed") {
        continue;
      }
      let compensationResult;
      try {
        compensationResult = await adjustCharacterBalanceAsync(
          leg.characterID,
          -leg.amount,
          {
            ownerID1: leg.characterID,
            ownerID2: leg.counterpartyID,
            referenceID: leg.counterpartyID,
            entryTypeID: JOURNAL_ENTRY_TYPE.PLAYER_TRADING,
            description: `Trade rollback with ${leg.counterpartyID}`,
            idempotencyKey: leg.compensationKey,
          },
          {
            commandID: leg.compensationKey,
            idempotencyKey: leg.compensationKey,
            source: "trade.completion.compensate",
          },
        );
      } catch (error) {
        return {
          success: false,
          ambiguous: true,
          pending: true,
          errorMsg: error && (error.code || error.message) ||
            "TRADE_WALLET_COMPENSATION_AMBIGUOUS",
        };
      }
      if (!compensationResult || compensationResult.success !== true) {
        return compensationResult || { success: false, errorMsg: "TRADE_WALLET_COMPENSATION_FAILED" };
      }
      const flushResult = this._persistCharacterWalletBoundary();
      if (!flushResult.success) {
        return flushResult;
      }
      this._injectFault("after-wallet-compensation", trade);
      leg.compensationStatus = "committed";
      persistResult = this._persistTrade(trade);
      if (!persistResult || persistResult.success !== true) {
        return persistResult || { success: false, errorMsg: "TRADE_RUNTIME_WRITE_FAILED" };
      }
    }

    for (const leg of [...saga.itemLegs].reverse()) {
      if (leg.status !== "committed" || leg.compensationStatus === "committed") {
        continue;
      }
      const compensationSource = {
        ...cloneValue(leg.sourceItem),
        ownerID: leg.destination.ownerID,
        locationID: leg.destination.locationID,
        flagID: leg.destination.flagID,
      };
      const compensationResult = tradeItemCustody.transferItem({
        item: compensationSource,
        ownerID: leg.sourceItem.ownerID,
        locationID: leg.sourceItem.locationID,
        flagID: leg.sourceItem.flagID,
        tradeContainerID: trade.tradeContainerID,
        actor: leg.sourceItem.ownerID,
        reason: itemCustody.CUSTODY_REASON.TRADE_COMPENSATE,
        idempotencyKey: leg.compensationKey,
      });
      if (!compensationResult || compensationResult.success !== true) {
        return compensationResult || { success: false, errorMsg: "TRADE_ITEM_COMPENSATION_FAILED" };
      }
      this._injectFault("after-item-compensation", trade);
      leg.compensationStatus = "committed";
      persistResult = this._persistTrade(trade);
      if (!persistResult || persistResult.success !== true) {
        return persistResult || { success: false, errorMsg: "TRADE_RUNTIME_WRITE_FAILED" };
      }
    }

    trade.status = "open";
    trade.offerStates = [0, 0];
    trade.offerManifests = [null, null];
    trade.completionSaga = null;
    persistResult = this._persistTrade(trade);
    if (!persistResult || persistResult.success !== true) {
      return persistResult || { success: false, errorMsg: "TRADE_RUNTIME_WRITE_FAILED" };
    }
    return {
      success: false,
      compensated: true,
      errorMsg: cause && cause.errorMsg || "TRADE_COMPLETION_FAILED",
    };
  }

  async _completeTradeDurably(trade) {
    const prepareResult = this._prepareCompletionSaga(trade);
    if (!prepareResult.success) {
      return prepareResult;
    }
    const saga = trade.completionSaga;

    for (const leg of saga.itemLegs) {
      if (leg.status === "committed") {
        continue;
      }
      const transferResult = tradeItemCustody.transferItem({
        item: leg.sourceItem,
        ownerID: leg.destination.ownerID,
        locationID: leg.destination.locationID,
        flagID: leg.destination.flagID,
        tradeContainerID: trade.tradeContainerID,
        actor: leg.destination.ownerID,
        reason: leg.reason,
        idempotencyKey: leg.idempotencyKey,
      });
      if (!transferResult || transferResult.success !== true) {
        return transferResult && transferResult.ambiguous === true
          ? { ...transferResult, pending: true }
          : await this._compensateCompletionSaga(trade, transferResult);
      }
      this._injectFault("after-completion-item", trade);
      leg.status = "committed";
      leg.changes = cloneValue(
        transferResult.data && transferResult.data.changes || [],
      );
      const persistResult = this._persistTrade(trade);
      if (!persistResult || persistResult.success !== true) {
        return {
          ...(persistResult || { success: false, errorMsg: "TRADE_RUNTIME_WRITE_FAILED" }),
          pending: true,
        };
      }
    }

    saga.phase = "wallet";
    if (!saga.walletPreflightPassed) {
      const [leftWallet, rightWallet] = trade.traders.map((characterID) =>
        getCharacterWallet(characterID),
      );
      if (!leftWallet || !rightWallet) {
        return await this._compensateCompletionSaga(trade, {
          success: false,
          errorMsg: "CHARACTER_NOT_FOUND",
        });
      }
      if (
        leftWallet.balance < trade.moneyOffers[0] ||
        rightWallet.balance < trade.moneyOffers[1]
      ) {
        return await this._compensateCompletionSaga(trade, {
          success: false,
          errorMsg: "INSUFFICIENT_FUNDS",
        });
      }
      saga.walletPreflightPassed = true;
      const persistResult = this._persistTrade(trade);
      if (!persistResult || persistResult.success !== true) {
        return {
          ...(persistResult || { success: false, errorMsg: "TRADE_RUNTIME_WRITE_FAILED" }),
          pending: true,
        };
      }
    }

    for (const leg of saga.walletLegs) {
      if (leg.status === "committed") {
        continue;
      }
      let adjustmentResult;
      try {
        adjustmentResult = await adjustCharacterBalanceAsync(
          leg.characterID,
          leg.amount,
          {
            ownerID1: leg.ownerID1,
            ownerID2: leg.ownerID2,
            referenceID: leg.referenceID,
            entryTypeID: JOURNAL_ENTRY_TYPE.PLAYER_TRADING,
            description: leg.description,
            idempotencyKey: leg.idempotencyKey,
          },
          {
            commandID: leg.idempotencyKey,
            idempotencyKey: leg.idempotencyKey,
            source: "trade.completion.settle",
          },
        );
      } catch (error) {
        return {
          success: false,
          ambiguous: true,
          pending: true,
          errorMsg: error && (error.code || error.message) ||
            "TRADE_WALLET_SETTLEMENT_AMBIGUOUS",
        };
      }
      if (!adjustmentResult || adjustmentResult.success !== true) {
        return await this._compensateCompletionSaga(trade, adjustmentResult);
      }
      const flushResult = this._persistCharacterWalletBoundary();
      if (!flushResult.success) {
        return { ...flushResult, pending: true };
      }
      this._injectFault("after-completion-wallet", trade);
      leg.status = "committed";
      const persistResult = this._persistTrade(trade);
      if (!persistResult || persistResult.success !== true) {
        return {
          ...(persistResult || { success: false, errorMsg: "TRADE_RUNTIME_WRITE_FAILED" }),
          pending: true,
        };
      }
    }

    saga.phase = "completed";
    trade.status = "completed";
    trade.stagedItemOrigins.clear();
    const persistResult = this._persistTrade(trade);
    if (!persistResult || persistResult.success !== true) {
      return {
        ...(persistResult || { success: false, errorMsg: "TRADE_RUNTIME_WRITE_FAILED" }),
        pending: true,
      };
    }
    return {
      success: true,
      data: {
        changes: saga.itemLegs.flatMap((leg) => cloneValue(leg.changes || [])),
      },
    };
  }

  _resumePendingStage(trade) {
    const pendingStage = trade.pendingStage;
    if (!pendingStage) {
      return { success: true };
    }
    const moveResult = tradeItemCustody.transferItem({
      item: pendingStage.item,
      ownerID: pendingStage.actorID || pendingStage.originContext.ownerID,
      locationID: trade.tradeContainerID,
      flagID: ITEM_FLAGS.HANGAR,
      quantity: pendingStage.quantity,
      tradeContainerID: trade.tradeContainerID,
      actor: pendingStage.actorID || pendingStage.originContext.ownerID,
      reason: itemCustody.CUSTODY_REASON.TRADE_STAGE,
      idempotencyKey: pendingStage.idempotencyKey,
    });
    if (!moveResult || moveResult.success !== true) {
      return moveResult || { success: false, errorMsg: "TRADE_STAGE_RECOVERY_FAILED" };
    }
    const committedChanges = moveResult.data && (
      moveResult.data.committedChanges || moveResult.data.changes
    ) || [];
    const stagedItems = committedChanges
      .map((change) => change && change.item)
      .filter((item) => (
        item && Number(item.locationID || 0) === trade.tradeContainerID
      ));
    if (
      moveResult.data && moveResult.data.item &&
      Number(moveResult.data.item.locationID || 0) === trade.tradeContainerID
    ) {
      stagedItems.push(moveResult.data.item);
    }
    for (const stagedItem of stagedItems) {
      const itemID = Number(stagedItem.itemID) || 0;
      if (itemID > 0) {
        trade.stagedItemOrigins.set(
          itemID,
          cloneValue(pendingStage.originContext),
        );
      }
    }
    if (stagedItems.length <= 0) {
      return { success: false, errorMsg: "TRADE_STAGE_RECOVERY_ITEM_MISSING" };
    }
    trade.pendingStage = null;
    return this._persistTrade(trade);
  }

  _recoverDurableTrades() {
    const recoveryTrades = [];
    for (const record of tradeRuntimeState.listTradeRecords()) {
      const trade = this._hydrateTrade(record);
      if (!trade.tradeID || !trade.tradeContainerID) {
        continue;
      }
      if (["completed", "aborted"].includes(trade.status)) {
        const removeResult = tradeRuntimeState.removeTradeRecordDurable(
          trade.tradeContainerID,
        );
        if (!removeResult || removeResult.success !== true) {
          log.warn(
            `[TradeMgr] Failed to retire recovered trade ${trade.tradeID}: ` +
              `${removeResult && removeResult.errorMsg || "unknown persistence error"}`,
          );
        }
        continue;
      }
      this._trades.set(trade.tradeID, trade);
      for (const characterID of trade.traders || []) {
        if (["open", "completing", "compensating", "aborting"].includes(trade.status)) {
          this._tradeByParticipant.set(Number(characterID) || 0, trade.tradeID);
        }
      }

      if (["completing", "compensating"].includes(trade.status)) {
        recoveryTrades.push(trade);
      } else {
        this._finishDurableTradeRecovery(trade, { success: true });
      }
    }

    if (recoveryTrades.length <= 0) {
      return null;
    }

    return recoveryTrades.reduce(
      (pending, trade) => pending.then(async () => {
        try {
          await this._recoverDurableTrade(trade);
        } catch (error) {
          log.error(
            `[TradeMgr] Durable recovery threw for ${trade.tradeID}: ` +
              `${error && error.message || "unknown recovery error"}`,
          );
        }
      }),
      Promise.resolve(),
    );
  }

  async _recoverDurableTrade(trade) {
    let recoveryResult = { success: true };
    if (trade.status === "completing") {
      recoveryResult = await this._completeTradeDurably(trade);
    } else if (trade.status === "compensating") {
      recoveryResult = await this._compensateCompletionSaga(trade, {
        success: false,
        errorMsg: "TRADE_COMPLETION_INTERRUPTED",
      });
    }

    return this._finishDurableTradeRecovery(trade, recoveryResult);
  }

  _finishDurableTradeRecovery(trade, initialResult) {
    let recoveryResult = initialResult;
    if (
      recoveryResult &&
      (recoveryResult.success === true || recoveryResult.compensated === true) &&
      trade.status === "open" &&
      trade.pendingStage
    ) {
      recoveryResult = this._resumePendingStage(trade);
    }
    if (
      recoveryResult &&
      (recoveryResult.success === true || recoveryResult.compensated === true) &&
      trade.status === "open"
    ) {
      recoveryResult = this._abortTrade(trade, { notifyParticipants: false });
    } else if (trade.status === "aborting") {
      recoveryResult = this._abortTrade(trade, { notifyParticipants: false });
    }

    if (!recoveryResult || (recoveryResult.success !== true && recoveryResult.compensated !== true)) {
      log.error(
        `[TradeMgr] Durable recovery remains pending for ${trade.tradeID}: ` +
          `${recoveryResult && recoveryResult.errorMsg || "unknown recovery error"}`,
      );
      return recoveryResult;
    }
    if (["completed", "aborted"].includes(trade.status)) {
      this._cleanupTradeIndex(trade);
      this._scheduleTradeCleanup(trade, 1000);
    }
    return recoveryResult;
  }

  Handle_InitiateTrade(args, session) {
    const targetCharacterID = normalizePositiveInteger(
      Array.isArray(args) ? args[0] : 0,
      0,
    );
    const initiatorCharacterID = Number(session && session.characterID || 0) || 0;
    if (initiatorCharacterID <= 0 || targetCharacterID <= 0) {
      this._throwTradeError("Trade target could not be resolved.");
    }
    if (initiatorCharacterID === targetCharacterID) {
      this._throwTradeError("You cannot trade with yourself.");
    }

    if (!isDockedSession(session)) {
      this._throwTradeError("Both pilots must be docked in the same station or structure to trade.");
    }

    const targetSession = this._getParticipantSession(targetCharacterID, session);
    if (!targetSession || !isDockedSession(targetSession)) {
      this._throwTradeError("The selected pilot must be docked and online to trade.");
    }

    const initiatorDockedLocationID = Number(getDockedLocationID(session) || 0) || 0;
    const targetDockedLocationID = Number(getDockedLocationID(targetSession) || 0) || 0;
    if (initiatorDockedLocationID <= 0 || initiatorDockedLocationID !== targetDockedLocationID) {
      this._throwTradeError("Both pilots must be docked in the same station or structure to trade.");
    }
    const solarSystemID = Number(
      session.solarsystemid2 ||
      session.solarsystemid ||
      session.solarSystemID ||
      targetSession.solarsystemid2 ||
      targetSession.solarsystemid ||
      targetSession.solarSystemID ||
      0,
    ) || 0;

    const existingInitiatorTradeID = this._tradeByParticipant.get(initiatorCharacterID) || null;
    const existingTargetTradeID = this._tradeByParticipant.get(targetCharacterID) || null;
    if (
      existingInitiatorTradeID &&
      existingTargetTradeID &&
      existingInitiatorTradeID === existingTargetTradeID
    ) {
      const existingTrade = this._trades.get(existingInitiatorTradeID) || null;
      if (existingTrade) {
        return this._buildTradeMoniker(existingTrade);
      }
    }

    if (existingInitiatorTradeID || existingTargetTradeID) {
      this._throwTradeError("One of those pilots is already in another direct trade.");
    }

    const tradeContainerID = this._nextTradeContainerID();
    const tradeID = `trade:${tradeContainerID}`;
    const trade = {
      tradeID,
      tradeContainerID,
      dockedLocationID: initiatorDockedLocationID,
      dockedLocationKind: getDockedLocationKind(session),
      solarSystemID,
      traders: [initiatorCharacterID, targetCharacterID],
      participantClientIDs: [
        Number(session.clientID || session.clientid || 0) || 0,
        Number(targetSession.clientID || targetSession.clientid || 0) || 0,
      ],
      moneyOffers: [0, 0],
      offerStates: [0, 0],
      offerManifests: [null, null],
      status: "open",
      stagedItemOrigins: new Map(),
      nextStageID: 1,
      completionGeneration: 1,
      pendingStage: null,
      abortSaga: null,
      completionSaga: null,
      boundObjectID: null,
      cleanupTimer: null,
    };

    this._persistTradeOrThrow(trade);
    this._trades.set(trade.tradeID, trade);
    this._tradeByParticipant.set(initiatorCharacterID, trade.tradeID);
    this._tradeByParticipant.set(targetCharacterID, trade.tradeID);

    const initiatorMoniker = this._buildTradeMoniker(trade);
    const targetMoniker = this._buildTradeMoniker(trade);

    targetSession.sendNotification("OnTradeInitiate", "charid", [
      initiatorCharacterID,
      targetMoniker,
    ]);

    log.info(
      `[TradeMgr] Initiated trade ${trade.tradeID} between ${initiatorCharacterID} and ${targetCharacterID} at ${trade.dockedLocationID}`,
    );

    return initiatorMoniker;
  }

  Handle_MachoBindObject(args, session) {
    const bindParams = Array.isArray(args) ? args[0] : null;
    const nestedCall = Array.isArray(args) ? args[1] : null;
    const trade = this._getTradeByBindParams(bindParams, session);
    if (!trade) {
      this._throwTradeError("Trade session is no longer available.");
    }

    const boundObjectID = this._ensureTradeBoundObject(trade);
    if (session) {
      if (!session._boundObjectIDs || typeof session._boundObjectIDs !== "object") {
        session._boundObjectIDs = {};
      }
      session._boundObjectIDs[this.name] = boundObjectID;
      session.lastBoundObjectID = boundObjectID;
    }
    if (
      this.serviceManager &&
      typeof this.serviceManager.registerBoundObjectParams === "function"
    ) {
      this.serviceManager.registerBoundObjectParams(boundObjectID, bindParams);
    }

    let callResult = null;
    if (nestedCall && Array.isArray(nestedCall) && nestedCall.length > 0) {
      const methodName = normalizeText(nestedCall[0], "");
      const callArgs = Array.isArray(nestedCall[1]) ? nestedCall[1] : [];
      const callKwargs = nestedCall.length > 2 ? nestedCall[2] : null;
      const previousBoundObjectID = session ? session.currentBoundObjectID : undefined;
      if (session) {
        session.currentBoundObjectID = boundObjectID;
      }
      const restoreBoundObject = () => {
        if (session) {
          session.currentBoundObjectID = previousBoundObjectID;
        }
      };
      try {
        callResult = this.callMethod(methodName, callArgs, session, callKwargs);
      } catch (error) {
        restoreBoundObject();
        throw error;
      }
      if (callResult && typeof callResult.then === "function") {
        return callResult.then(
          (resolvedResult) => {
            restoreBoundObject();
            return [buildBoundSubstruct(boundObjectID), resolvedResult];
          },
          (error) => {
            restoreBoundObject();
            throw error;
          },
        );
      }
      restoreBoundObject();
    }

    return [buildBoundSubstruct(boundObjectID), callResult];
  }

  Handle_List(args, session) {
    const { trade } = this._resolveTradeContext(session, { requireOpen: false });
    return this._buildListResponse(trade);
  }

  Handle_GetSelfInvItem(args, session) {
    const { trade } = this._resolveTradeContext(session, { requireOpen: false });
    return this._buildSelfInvItem(trade, session);
  }

  Handle_Add(args, session, kwargs) {
    const { trade } = this._resolveTradeContext(session, { requireOpen: true });
    if (!this._ensureAllParticipantsStillValid(trade)) {
      this._throwTradeError("Trade session is no longer available.");
    }

    const itemID = normalizePositiveInteger(Array.isArray(args) ? args[0] : 0, 0);
    const sourceLocationID = normalizePositiveInteger(Array.isArray(args) ? args[1] : 0, 0);
    const quantity = this._resolveMoveQuantity(kwargs);

    const stageResult = this._stageItemIntoTrade(
      trade,
      session,
      itemID,
      sourceLocationID,
      quantity,
    );

    this._notifyTradeItemPriming(trade, stageResult.stagedRootItemIDs);
    this._resetOfferState(trade);
    return true;
  }

  Handle_MultiAdd(args, session) {
    const { trade } = this._resolveTradeContext(session, { requireOpen: true });
    if (!this._ensureAllParticipantsStillValid(trade)) {
      this._throwTradeError("Trade session is no longer available.");
    }

    const itemIDs = numericArray(Array.isArray(args) ? args[0] : []);
    const sourceLocationID = normalizePositiveInteger(Array.isArray(args) ? args[1] : 0, 0);
    if (itemIDs.length <= 0) {
      return false;
    }

    for (const itemID of itemIDs) {
      this._validateOfferedItem(findItemById(itemID), session, sourceLocationID);
    }

    const stagedRootItemIDs = [];
    for (const itemID of itemIDs) {
      const stageResult = this._stageItemIntoTrade(
        trade,
        session,
        itemID,
        sourceLocationID,
        null,
      );
      stagedRootItemIDs.push(...stageResult.stagedRootItemIDs);
    }

    this._notifyTradeItemPriming(trade, stagedRootItemIDs);
    this._resetOfferState(trade);
    return true;
  }

  Handle_OfferMoney(args, session) {
    const { trade, participantIndex, characterID } = this._resolveTradeContext(
      session,
      { requireOpen: true },
    );
    if (!this._ensureAllParticipantsStillValid(trade)) {
      this._throwTradeError("Trade session is no longer available.");
    }

    const amount = Math.round((normalizeNumber(Array.isArray(args) ? args[0] : 0, 0) || 0) * 100) / 100;
    if (amount < 0) {
      this._throwTradeError("ISK offer must be zero or greater.");
    }

    const wallet = getCharacterWallet(characterID);
    if (!wallet || wallet.balance < amount) {
      this._throwTradeError("You do not have enough ISK to offer that amount.");
    }

    trade.moneyOffers[participantIndex] = amount;
    this._persistTradeOrThrow(trade);
    this._notifyParticipants(trade, "OnTradeMoneyOffer", [
      trade.tradeContainerID,
      buildList(trade.moneyOffers.slice()),
    ]);
    this._resetOfferState(trade);
    return true;
  }

  Handle_MakeOffer(args, session) {
    const { trade, participantIndex } = this._resolveTradeContext(session, { requireOpen: true });
    if (!this._ensureAllParticipantsStillValid(trade)) {
      this._throwTradeError("Trade session is no longer available.");
    }

    const manifest = this._parseManifest(args);
    const stagedItemIDs = new Set(
      this._listTradeItems(trade)
        .map((item) => Number(item.itemID) || 0)
        .filter((itemID) => itemID > 0),
    );
    const normalizedMoney = trade.moneyOffers.map((value) => Math.round((Number(value) || 0) * 100) / 100);
    const manifestMoney = trade.moneyOffers.map((_, index) =>
      Math.round((Number(manifest.money[index]) || 0) * 100) / 100,
    );
    const manifestMatches =
      manifest.tradeContainerID === trade.tradeContainerID &&
      manifest.money.length === trade.moneyOffers.length &&
      normalizedMoney.every((value, index) => value === manifestMoney[index]) &&
      setsEqual(stagedItemIDs, manifest.tradeItems);

    if (!manifestMatches) {
      trade.offerStates = [0, 0];
      trade.offerManifests = [null, null];
      this._persistTradeOrThrow(trade);
      session.sendNotification("OnTradeOfferReset", "clientID", [
        trade.tradeContainerID,
        true,
      ]);
      this._notifyParticipants(trade, "OnTradeOffer", [
        trade.tradeContainerID,
        buildList(trade.offerManifests.slice()),
      ]);
      return false;
    }

    trade.offerStates[participantIndex] = 1;
    trade.offerManifests[participantIndex] = this._buildOfferManifestPayload(trade);
    if (!(trade.offerStates[0] && trade.offerStates[1])) {
      this._persistTradeOrThrow(trade);
      this._notifyParticipants(trade, "OnTradeOffer", [
        trade.tradeContainerID,
        buildList(trade.offerManifests.slice()),
      ]);
      return true;
    }

    const completionItemsPayload = this._buildTradeItemsSetPayload(trade);
    return this._completeTradeDurably(trade).then((completionResult) => {
      if (!completionResult.success) {
        if (trade.status === "open") {
          trade.offerStates = [0, 0];
          trade.offerManifests = [null, null];
          this._persistTradeOrThrow(trade);
          this._notifyParticipants(trade, "OnTradeOffer", [
            trade.tradeContainerID,
            buildList(trade.offerManifests.slice()),
          ]);
        }
        this._throwTradeError(
          completionResult.pending === true
            ? "Trade completion is pending durable recovery."
            : completionResult.errorMsg === "INSUFFICIENT_FUNDS"
              ? "One pilot no longer has enough ISK to complete the trade."
              : completionResult.compensated === true
                ? "Trade completion failed while moving staged items."
                : "Trade completion failed while restoring staged items.",
        );
      }

      this._notifyTradeCompletionItemChanges(
        trade,
        completionResult.data && completionResult.data.changes,
      );
      this._cleanupTradeIndex(trade);
      this._notifyParticipants(trade, "OnTradeComplete", [
        trade.tradeContainerID,
        completionItemsPayload,
      ]);
      this._scheduleTradeCleanup(trade);
      return true;
    });
  }

  Handle_Abort(args, session) {
    const trade = this._getTradeFromSession(session);
    if (!trade || !["open", "aborting"].includes(trade.status)) {
      return true;
    }

    const participantIndex = this._getParticipantIndex(
      trade,
      Number(session && session.characterID || 0),
    );
    if (participantIndex < 0) {
      return true;
    }

    const abortResult = this._abortTrade(trade, { notifyParticipants: true });
    if (!abortResult || abortResult.success !== true) {
      if (abortResult?.errorMsg === "TRADE_FITTING_ORIGIN_UNVERIFIED") {
        this._throwTradeError("Trade cancellation is pending: this historical charge origin lacks its original module identity and needs inspection before restoration.");
      }
      if (abortResult?.errorMsg === "TRADE_FITTING_RETURN_BLOCKED") {
        this._throwTradeError("Trade cancellation is pending: restore the original module and clear its original fitting slot before retrying cancellation.");
      }
      this._throwTradeError("Trade cancellation is pending durable recovery.");
    }
    return true;
  }

  abortTradesForSession(session) {
    const characterID = Number(session && session.characterID || session && session.charid || 0) || 0;
    if (characterID <= 0) {
      return {
        success: false,
        errorMsg: "CHARACTER_REQUIRED",
      };
    }
    const tradeID = this._tradeByParticipant.get(characterID) || null;
    if (!tradeID) {
      return {
        success: true,
        count: 0,
      };
    }
    const trade = this._trades.get(tradeID) || null;
    if (!trade || trade.status !== "open") {
      return {
        success: true,
        count: 0,
      };
    }
    const abortResult = this._abortTrade(trade, { notifyParticipants: true });
    if (!abortResult || abortResult.success !== true) {
      return {
        success: false,
        errorMsg: abortResult && abortResult.errorMsg || "TRADE_ABORT_FAILED",
      };
    }
    return {
      success: true,
      count: 1,
    };
  }
}

function abortTradesForSession(session) {
  if (!activeTradeMgrService) {
    return {
      success: true,
      count: 0,
    };
  }
  return activeTradeMgrService.abortTradesForSession(session);
}

module.exports = TradeMgrService;
module.exports.abortTradesForSession = abortTradesForSession;
module.exports._testing = {
  setFaultInjector(handler) {
    tradeFaultInjector = typeof handler === "function" ? handler : null;
  },
  clearFaultInjector() {
    tradeFaultInjector = null;
  },
};
