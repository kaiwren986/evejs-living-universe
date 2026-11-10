"use strict";

const {
  toFiniteNumber,
} = require("../../common/numbers");

const path = require("path");

const database = require(path.join(__dirname, "../../gameStore"));
const log = require(path.join(__dirname, "../../utils/logger"));
const worldData = require(path.join(__dirname, "../../space/worldData"));
const {
  isAbyssalHostLocationID,
} = require("../../abyssal").engineSupport.hostLocation;
const {
  throwWrappedUserError,
} = require(path.join(__dirname, "../../common/machoErrors"));
const {
  buildFiletimeLong,
  buildKeyVal,
  buildRowset,
  currentFileTime,
  normalizeText,
} = require(path.join(__dirname, "../_shared/serviceHelpers"));
const {
  getDockedLocationID,
  getDockedLocationKind,
  isDockedSession,
} = require(path.join(__dirname, "../structure/structureLocation"));
const characterState = require(path.join(__dirname, "../character/characterState"));
const {
  listCharacterIDs,
  getCharacterRecord,
  updateCharacterRecord,
  getActiveShipRecord,
  applyCharacterToSession,
  flushCharacterSessionNotificationPlan,
  syncInventoryItemForSession,
} = characterState;
const {
  ITEM_FLAGS,
  dockShipToLocation,
  findItemById,
  isCapsuleTypeID,
} = require(path.join(__dirname, "../inventory/itemStore"));
const {
  getFittedModuleItems,
  getTypeAttributeValue,
  isEffectivelyOnlineModule,
} = require(path.join(__dirname, "../fitting/liveFittingState"));
const sessionRegistry = require(path.join(__dirname, "../chat/sessionRegistry"));
const {
  broadcastStationGuestLeft,
  broadcastStructureGuestJoined,
  broadcastStructureGuestLeft,
} = require(path.join(__dirname, "../_shared/guestLists"));
const {
  getCharacterWallet,
  applyCharacterWalletProjection,
  adjustCharacterBalanceAsync,
  buildNotEnoughMoneyUserErrorValues,
  JOURNAL_ENTRY_TYPE,
} = require(path.join(__dirname, "../account/walletState"));
const {
  adjustCorporationWalletDivisionBalanceAsync,
  CORPORATION_WALLET_KEY_START,
} = require(path.join(__dirname, "../corporation/corpWalletState"));
const {
  advanceSettlementSequenceWatermark,
  registerSettlementSequenceDomain,
} = require(path.join(__dirname, "../_shared/settlementSequenceWatermark"));
const {
  createNotification,
} = require(path.join(__dirname, "../notifications/notificationState"));
const {
  NOTIFICATION_GROUP,
} = require(path.join(__dirname, "../notifications/notificationConstants"));
const {
  canCharacterDockAtStructure,
} = require(path.join(__dirname, "../structure/structureState"));
const {
  STRUCTURE_SERVICE_ID,
} = require(path.join(__dirname, "../structure/structureConstants"));
const {
  structureHasOnlineService,
  STRUCTURE_SETTING_ID,
} = require(path.join(__dirname, "../structure/structureServiceAuthority"));
const {
  characterHasStructureService,
} = require(path.join(__dirname, "../structure/structurePayloads"));
const {
  getProfileSettingValueForStructure,
} = require(path.join(__dirname, "../structure/structureProfilesState"));
const {
  ATTRIBUTE_MAX_JUMP_CLONES,
  ATTRIBUTE_CLONE_JUMP_COOLDOWN,
  TYPE_CLONE_VAT_BAY_I,
  JUMP_CLONE_INSTALL_COST,
  REF_JUMP_CLONE_INSTALLATION_FEE,
  REF_JUMP_CLONE_ACTIVATION_FEE,
  NOTIFICATION_TYPE_JUMP_CLONE_DELETED_1,
  NOTIFICATION_TYPE_JUMP_CLONE_DELETED_2,
  EVENT_CLONE_JUMP,
  EVENT_CLONE_DESTRUCTION,
  EVENT_CLONE_INSTALLATION,
  EVENT_CLONE_JUMP_TIME_RESET,
  EVENT_CLONE_DESTROYED_WITH_LOCATION,
  EVENT_CLONE_IMPLANT_REMOVAL,
  CLONE_NAME_MAX_LENGTH,
  getCharacterCloneLimit,
  getCharacterCloneJumpCooldownHours,
} = require(path.join(__dirname, "./jumpCloneRules"));

const CLONE_ROW_HEADER = ["jumpCloneID", "locationID", "cloneName"];
const IMPLANT_ROW_HEADER = ["jumpCloneID", "typeID"];
const SHIP_CLONE_ROW_HEADER = ["jumpCloneID", "ownerID", "locationID"];
const CLIENT_ROWSET_NAME = "eve.common.script.sys.rowset.Rowset";
const FILETIME_EPOCH_OFFSET = 116444736000000000n;
const FILETIME_TICKS_PER_MS = 10000n;
const MAX_STRUCTURE_CLONE_BAY_COST = 100000000;
const CLONE_INSTALL_SETTLEMENT_TABLE = "jumpCloneInstallSettlements";
const CLONE_ACTIVATION_SETTLEMENT_TABLE = "jumpCloneActivationSettlements";
const DURABLE_INSTALL_JOB_TYPE = "jump-clone.install";
const DURABLE_INSTALL_JOB_PREFIX = "jump-clone-install:";
const DURABLE_ACTIVATION_JOB_TYPE = "jump-clone.activate";
const DURABLE_ACTIVATION_JOB_PREFIX = "jump-clone-activation:";
const pendingShipCloneOffers = new Map();
const cloneInstallLanes = new Map();
let durableScheduler = null;
const IMPLANT_ATTRIBUTE_NON_DESTRUCTIBLE = Object.freeze([
  "nonDestructible",
  "Non-Destructible",
]);
const IMPLANT_ATTRIBUTE_FOLLOWS_JUMP_CLONES = Object.freeze([
  "followsJumpClones",
  "Follows Jump Clones",
]);

function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function toPositiveInt(value, fallback = 0) {
  const numeric = Math.trunc(Number(value) || 0);
  return numeric > 0 ? numeric : fallback;
}

function getStructureByIDNoRefresh(structureID) {
  try {
    const structureState = require(path.join(__dirname, "../structure/structureState"));
    return structureState.getStructureByID(structureID, { refresh: false });
  } catch (error) {
    // ignored: the structure state is not loaded in this process; no structure (null)
    return null;
  }
}

function toFileTimeMs(value) {
  try {
    const filetime =
      typeof value === "bigint"
        ? value
        : BigInt(String(value && value.value !== undefined ? value.value : value || 0));
    if (filetime <= FILETIME_EPOCH_OFFSET) {
      return 0;
    }
    return Number((filetime - FILETIME_EPOCH_OFFSET) / FILETIME_TICKS_PER_MS);
  } catch (error) {
    // ignored: an unreadable FILETIME counts as time zero
    return 0;
  }
}

function getNowFileTimeString() {
  return currentFileTime().toString();
}

function normalizeImplant(entry = {}) {
  const typeID = toPositiveInt(entry && entry.typeID, 0);
  if (!typeID) {
    return null;
  }
  return {
    ...entry,
    typeID,
    slot: Math.max(0, Math.trunc(Number(entry.slot || 0) || 0)),
    name: normalizeText(entry.name, ""),
  };
}

function implantHasTypeAttribute(implant, names) {
  const typeID = toPositiveInt(implant && implant.typeID, 0);
  if (!typeID) {
    return false;
  }
  return toFiniteNumber(getTypeAttributeValue(typeID, ...names), 0) > 0;
}

function implantFollowsJumpClones(implant) {
  return implantHasTypeAttribute(implant, IMPLANT_ATTRIBUTE_FOLLOWS_JUMP_CLONES);
}

function implantIsNonDestructible(implant) {
  return implantHasTypeAttribute(implant, IMPLANT_ATTRIBUTE_NON_DESTRUCTIBLE);
}

function sortImplantsBySlot(implants = []) {
  return implants
    .map(normalizeImplant)
    .filter(Boolean)
    .sort((left, right) => (
      toPositiveInt(left.slot, 0) - toPositiveInt(right.slot, 0) ||
      toPositiveInt(left.typeID, 0) - toPositiveInt(right.typeID, 0)
    ));
}

function mergeImplantsBySlot(baseImplants = [], overrideImplants = []) {
  const bySlot = new Map();
  const unslotted = [];
  const addImplant = (implant) => {
    const normalized = normalizeImplant(implant);
    if (!normalized) {
      return;
    }
    const slot = toPositiveInt(normalized.slot, 0);
    if (slot > 0) {
      bySlot.set(slot, normalized);
      return;
    }
    unslotted.push(normalized);
  };

  for (const implant of baseImplants) {
    addImplant(implant);
  }
  for (const implant of overrideImplants) {
    addImplant(implant);
  }

  return [
    ...[...bySlot.values()].sort((left, right) => (
      toPositiveInt(left.slot, 0) - toPositiveInt(right.slot, 0) ||
      toPositiveInt(left.typeID, 0) - toPositiveInt(right.typeID, 0)
    )),
    ...unslotted,
  ];
}

function resolveLocationKind(locationID) {
  const numericLocationID = toPositiveInt(locationID, 0);
  if (!numericLocationID) {
    return "unknown";
  }
  if (worldData.getStationByID(numericLocationID)) {
    return "station";
  }
  if (getStructureByIDNoRefresh(numericLocationID)) {
    return "structure";
  }
  const item = findItemById(numericLocationID);
  if (item && Number(item.categoryID || 0) === 6) {
    return "ship";
  }
  return "unknown";
}

function resolveLocationSolarSystemID(locationID, fallback = 0) {
  const station = worldData.getStationByID(locationID);
  if (station) {
    return toPositiveInt(station.solarSystemID, fallback);
  }
  const structure = getStructureByIDNoRefresh(locationID);
  if (structure) {
    return toPositiveInt(structure.solarSystemID, fallback);
  }
  const item = findItemById(locationID);
  if (item) {
    return toPositiveInt(item.locationID, fallback);
  }
  return fallback;
}

function normalizeClone(entry = {}, fallbackID = 0, ownerID = 0) {
  const jumpCloneID = toPositiveInt(
    entry.jumpCloneID ?? entry.cloneID ?? entry.itemID,
    fallbackID,
  );
  const locationID = toPositiveInt(
    entry.locationID ?? entry.stationID ?? entry.structureID,
    0,
  );
  if (!jumpCloneID || !locationID) {
    return null;
  }
  const locationKind =
    entry.locationKind ||
    (entry.stationID ? "station" : null) ||
    (entry.structureID ? "structure" : null) ||
    resolveLocationKind(locationID);
  return {
    jumpCloneID,
    cloneID: jumpCloneID,
    itemID: jumpCloneID,
    ownerID: toPositiveInt(entry.ownerID, ownerID),
    locationID,
    stationID: locationKind === "station" ? locationID : null,
    structureID: locationKind === "structure" ? locationID : null,
    solarSystemID: toPositiveInt(
      entry.solarSystemID,
      resolveLocationSolarSystemID(locationID, 0),
    ),
    locationKind,
    cloneName: normalizeText(entry.cloneName ?? entry.name, ""),
    name: normalizeText(entry.cloneName ?? entry.name, ""),
    implants: (Array.isArray(entry.implants) ? entry.implants : [])
      .map(normalizeImplant)
      .filter(Boolean),
  };
}

function normalizeActiveImplants(record = {}) {
  return (Array.isArray(record.implants) ? record.implants : [])
    .map(normalizeImplant)
    .filter(Boolean);
}

function normalizeJumpClones(record = {}) {
  const charID = toPositiveInt(record.characterID ?? record.charID ?? record.charid, 0);
  return (Array.isArray(record.jumpClones) ? record.jumpClones : [])
    .map((entry, index) => normalizeClone(entry, charID * 100000 + 90000 + index, charID))
    .filter(Boolean)
    .sort((left, right) => left.jumpCloneID - right.jumpCloneID);
}

function getNextCloneID(record = {}, normalizedClones = []) {
  const charID = toPositiveInt(record.characterID ?? record.charID ?? record.charid, 0);
  const highestExistingID = normalizedClones.reduce(
    (highest, clone) => Math.max(highest, toPositiveInt(clone && clone.jumpCloneID, 0)),
    0,
  );
  return Math.max(
    toPositiveInt(record.nextJumpCloneID, 0),
    highestExistingID + 1,
    charID * 100000 + 90000,
  );
}

function normalizeCloneName(value, fallback = "") {
  return normalizeText(value, fallback).slice(0, CLONE_NAME_MAX_LENGTH);
}

function buildCloneRecord({
  jumpCloneID,
  ownerID,
  locationID,
  cloneName,
  implants = [],
  locationKind = null,
}) {
  const resolvedLocationKind = locationKind || resolveLocationKind(locationID);
  return normalizeClone({
    jumpCloneID,
    ownerID,
    locationID,
    locationKind: resolvedLocationKind,
    cloneName: normalizeCloneName(cloneName, ""),
    implants,
  }, jumpCloneID, ownerID);
}

function buildCloneRows(clones = []) {
  return buildRowset(
    CLONE_ROW_HEADER,
    clones.map((clone) => [
      clone.jumpCloneID,
      clone.locationID,
      clone.cloneName || "",
    ]),
    CLIENT_ROWSET_NAME,
  );
}

function buildImplantRows(clones = []) {
  const rows = [];
  for (const clone of clones) {
    for (const implant of clone.implants || []) {
      rows.push([clone.jumpCloneID, implant.typeID]);
    }
  }
  return buildRowset(IMPLANT_ROW_HEADER, rows, CLIENT_ROWSET_NAME);
}

function buildShipCloneRows(clones = []) {
  return buildRowset(
    SHIP_CLONE_ROW_HEADER,
    clones.map((clone) => [
      clone.jumpCloneID,
      clone.ownerID,
      clone.locationID,
    ]),
    CLIENT_ROWSET_NAME,
  );
}

function getCloneState(charID) {
  const record = getCharacterRecord(charID) || {};
  const clones = normalizeJumpClones(record);
  return {
    record,
    implants: normalizeActiveImplants(record),
    clones,
    timeLastCloneJump: String(record.timeLastCloneJump || "0"),
    nextJumpCloneID: getNextCloneID(record, clones),
  };
}

function buildCloneStatePayload(session) {
  const state = getCloneState(session && session.characterID);
  return buildKeyVal([
    ["clones", buildCloneRows(state.clones)],
    ["implants", buildImplantRows(state.clones)],
    ["timeLastJump", buildFiletimeLong(state.timeLastCloneJump || 0n)],
  ]);
}

function getCurrentDockedLocation(session) {
  if (!session || !isDockedSession(session)) {
    return {
      locationID: 0,
      kind: "space",
    };
  }
  return {
    locationID: getDockedLocationID(session),
    kind: getDockedLocationKind(session),
  };
}

function buildStationCloneStatePayload(session) {
  const locationID = getCurrentDockedLocation(session).locationID;
  const state = getCloneState(session && session.characterID);
  return buildCloneRows(state.clones.filter((clone) => clone.locationID === locationID));
}

function buildShipCloneStatePayload(session) {
  const shipID = toPositiveInt(
    session && (session.shipid ?? session.shipID ?? session.activeShipID),
    0,
  );
  const state = getCloneState(session && session.characterID);
  return buildShipCloneRows(
    state.clones.filter((clone) => (
      clone.locationKind === "ship" &&
      (!shipID || clone.locationID === shipID)
    )),
  );
}

function emitSessionNotification(session, eventName, payload = []) {
  if (!session || typeof session.sendNotification !== "function") {
    return;
  }
  session.sendNotification(eventName, "clientID", payload);
}

function syncCharacterDogmaAfterImplantChange(session, characterID) {
  if (!session) {
    return false;
  }
  try {
    const {
      syncCharacterDogmaState,
    } = require(path.join(__dirname, "../dogma/brain/characterBrainRuntime"));
    return syncCharacterDogmaState(session, characterID);
  } catch (error) {
    log.warn(
      `[JumpCloneRuntime] Failed to sync implant dogma state for char=${toPositiveInt(characterID, 0)}: ${error.message}`,
    );
    return false;
  }
}

function emitCloneInvalidations(session, locationID = 0, ownerID = 0) {
  emitSessionNotification(session, "OnJumpCloneCacheInvalidated", []);
  if (locationID) {
    emitSessionNotification(session, "OnStationJumpCloneCacheInvalidated", [
      locationID,
      ownerID || (session && session.characterID) || 0,
    ]);
    emitSessionNotification(session, "OnShipJumpCloneCacheInvalidated", [
      locationID,
      ownerID || (session && session.characterID) || 0,
    ]);
  }
}

function appendCloneEvent(record, eventTypeID, data = {}) {
  const entries = Array.isArray(record.cloneEventLog)
    ? record.cloneEventLog.map((entry) => cloneValue(entry))
    : [];
  entries.unshift({
    eventTypeID,
    created: getNowFileTimeString(),
    ...data,
  });
  record.cloneEventLog = entries.slice(0, 100);
}

function throwNotEnoughMoney(requiredAmount, currentBalance) {
  throwWrappedUserError(
    "NotEnoughMoney",
    buildNotEnoughMoneyUserErrorValues(requiredAmount, currentBalance),
  );
}

function ensureWalletCanPay(charID, amount) {
  const normalizedAmount = Math.max(0, Number(amount) || 0);
  if (normalizedAmount <= 0) {
    return;
  }
  const wallet = getCharacterWallet(charID);
  if (!wallet || wallet.balance + 0.0001 < normalizedAmount) {
    throwNotEnoughMoney(normalizedAmount, wallet ? wallet.balance : 0);
  }
}

function getStructureCloneServiceOwnerCorpID(location) {
  if (!location || location.kind !== "structure") {
    return 0;
  }
  const structure = worldData.getStructureByID(location.locationID);
  return toPositiveInt(
    structure && (structure.ownerCorpID || structure.ownerID),
    0,
  );
}

function normalizeMoney(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric)
    ? Math.max(0, Math.round(numeric * 100) / 100)
    : 0;
}

function ensureCloneInstallSettlementTable() {
  database.ensureTable(CLONE_INSTALL_SETTLEMENT_TABLE);
  const result = database.read(CLONE_INSTALL_SETTLEMENT_TABLE, "/");
  const table = result.success && result.data && typeof result.data === "object"
    ? result.data
    : {};
  if (!table._meta || typeof table._meta !== "object") {
    table._meta = { version: 1, nextOperationID: 1 };
    database.write(CLONE_INSTALL_SETTLEMENT_TABLE, "/_meta", table._meta);
  } else if (!toPositiveInt(table._meta.nextOperationID, 0)) {
    table._meta.nextOperationID = 1;
    database.write(
      CLONE_INSTALL_SETTLEMENT_TABLE,
      "/_meta/nextOperationID",
      1,
    );
  }
  return table;
}

function normalizeCloneInstallSettlement(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const operationID = String(value.operationID || "").trim();
  const charID = toPositiveInt(value.charID, 0);
  const jumpCloneID = toPositiveInt(value.jumpCloneID, 0);
  const locationID = toPositiveInt(value.locationID, 0);
  if (!operationID || !charID || !jumpCloneID || !locationID) {
    return null;
  }
  const amount = normalizeMoney(value.amount);
  const ownerCorpID = toPositiveInt(value.ownerCorpID, 0);
  return {
    operationID,
    charID,
    jumpCloneID,
    locationID,
    locationKind: ["station", "structure", "ship"].includes(value.locationKind)
      ? value.locationKind
      : resolveLocationKind(locationID),
    amount,
    ownerCorpID,
    offeringCharID: toPositiveInt(value.offeringCharID, 0),
    debitApplied: amount <= 0 || Boolean(value.debitApplied),
    creditApplied: amount <= 0 || !ownerCorpID || Boolean(value.creditApplied),
    debitAttempted: amount <= 0 || Boolean(value.debitAttempted),
    creditAttempted:
      amount <= 0 || !ownerCorpID || Boolean(value.creditAttempted),
    debitCommandID: String(
      value.debitCommandID || `${DURABLE_INSTALL_JOB_PREFIX}${operationID}:debit`,
    ),
    creditCommandID: String(
      value.creditCommandID || `${DURABLE_INSTALL_JOB_PREFIX}${operationID}:credit`,
    ),
    ownerCreditReversalCommandID: String(
      value.ownerCreditReversalCommandID ||
        `${DURABLE_INSTALL_JOB_PREFIX}${operationID}:credit-reversal`,
    ),
    debitRefundCommandID: String(
      value.debitRefundCommandID ||
        `${DURABLE_INSTALL_JOB_PREFIX}${operationID}:debit-refund`,
    ),
    compensating: Boolean(value.compensating),
    ownerCreditReversed: Boolean(value.ownerCreditReversed),
    debitRefunded: Boolean(value.debitRefunded),
    createdAt: String(value.createdAt || currentFileTime()),
  };
}

function listPendingCloneInstallSettlements() {
  return Object.entries(ensureCloneInstallSettlementTable())
    .filter(([key]) => key !== "_meta")
    .map(([, value]) => normalizeCloneInstallSettlement(value))
    .filter(Boolean)
    .sort((left, right) => left.operationID.localeCompare(right.operationID));
}

function getPendingCloneInstallSettlement(charID, operationID) {
  const result = database.read(
    CLONE_INSTALL_SETTLEMENT_TABLE,
    `/${String(operationID || "")}`,
  );
  const settlement = result.success
    ? normalizeCloneInstallSettlement(result.data)
    : null;
  return settlement && settlement.charID === toPositiveInt(charID, 0)
    ? settlement
    : null;
}

function findPendingCloneInstallForCharacter(charID) {
  const normalizedCharID = toPositiveInt(charID, 0);
  return listPendingCloneInstallSettlements().find((settlement) =>
    settlement.charID === normalizedCharID) || null;
}

function flushCloneInstallSettlementTable() {
  database.flushTableAsync(CLONE_INSTALL_SETTLEMENT_TABLE);
}

function persistCloneInstallSettlement(settlement) {
  const normalized = normalizeCloneInstallSettlement(settlement);
  if (!normalized) {
    return false;
  }
  const result = database.write(
    CLONE_INSTALL_SETTLEMENT_TABLE,
    `/${normalized.operationID}`,
    normalized,
  );
  if (result && result.success) {
    flushCloneInstallSettlementTable();
    return true;
  }
  return false;
}

function removeCloneInstallSettlement(operationID) {
  const result = database.remove(
    CLONE_INSTALL_SETTLEMENT_TABLE,
    `/${String(operationID || "")}`,
  );
  if (result && result.success) {
    flushCloneInstallSettlementTable();
    return true;
  }
  return false;
}

function runCloneInstallSerialized(charID, operation) {
  const laneKey = String(toPositiveInt(charID, 0));
  const previous = cloneInstallLanes.get(laneKey) || Promise.resolve();
  const current = previous.catch(() => null).then(operation);
  cloneInstallLanes.set(laneKey, current);
  void current.finally(() => {
    if (cloneInstallLanes.get(laneKey) === current) {
      cloneInstallLanes.delete(laneKey);
    }
  }).catch(() => null);
  return current;
}

function ensureCloneActivationSettlementTable() {
  database.ensureTable(CLONE_ACTIVATION_SETTLEMENT_TABLE);
  const result = database.read(CLONE_ACTIVATION_SETTLEMENT_TABLE, "/");
  const root = result.success && result.data && typeof result.data === "object"
    ? result.data
    : {};
  return {
    ...root,
    _meta: {
      version: 1,
      nextOperationID: toPositiveInt(
        root._meta && root._meta.nextOperationID,
        1,
      ),
    },
  };
}

function normalizeCloneActivationSettlement(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const operationID = String(value.operationID || "").trim();
  const charID = toPositiveInt(value.charID, 0);
  const jumpState = value.jumpState && typeof value.jumpState === "object"
    ? cloneValue(value.jumpState)
    : null;
  if (!operationID || !charID || !jumpState || !jumpState.targetClone) {
    return null;
  }
  const amount = normalizeMoney(value.amount);
  const ownerCorpID = toPositiveInt(value.ownerCorpID, 0);
  return {
    operationID,
    charID,
    jumpState,
    amount,
    ownerCorpID,
    debitCommandID: String(
      value.debitCommandID || `${DURABLE_ACTIVATION_JOB_PREFIX}${operationID}:debit`,
    ),
    creditCommandID: String(
      value.creditCommandID || `${DURABLE_ACTIVATION_JOB_PREFIX}${operationID}:credit`,
    ),
    ownerCreditReversalCommandID: String(
      value.ownerCreditReversalCommandID ||
        `${DURABLE_ACTIVATION_JOB_PREFIX}${operationID}:credit-reversal`,
    ),
    debitRefundCommandID: String(
      value.debitRefundCommandID ||
        `${DURABLE_ACTIVATION_JOB_PREFIX}${operationID}:debit-refund`,
    ),
    debitApplied: amount <= 0 || Boolean(value.debitApplied),
    creditApplied: amount <= 0 || !ownerCorpID || Boolean(value.creditApplied),
    transitioned: Boolean(value.transitioned),
    stateApplied: Boolean(value.stateApplied),
    compensating: Boolean(value.compensating),
    ownerCreditReversed: Boolean(value.ownerCreditReversed),
    debitRefunded: Boolean(value.debitRefunded),
    createdAt: String(value.createdAt || currentFileTime()),
  };
}

function listPendingCloneActivationSettlements() {
  return Object.entries(ensureCloneActivationSettlementTable())
    .filter(([key]) => key !== "_meta")
    .map(([, value]) => normalizeCloneActivationSettlement(value))
    .filter(Boolean)
    .sort((left, right) => left.operationID.localeCompare(right.operationID));
}

function findPendingCloneActivationForCharacter(charID) {
  const normalizedCharID = toPositiveInt(charID, 0);
  return listPendingCloneActivationSettlements().find((settlement) =>
    settlement.charID === normalizedCharID) || null;
}

function getPendingCloneActivationSettlement(operationID) {
  const result = database.read(
    CLONE_ACTIVATION_SETTLEMENT_TABLE,
    `/${String(operationID || "")}`,
  );
  return result.success
    ? normalizeCloneActivationSettlement(result.data)
    : null;
}

function persistCloneActivationSettlement(settlement) {
  const normalized = normalizeCloneActivationSettlement(settlement);
  if (!normalized) {
    return false;
  }
  const result = database.write(
    CLONE_ACTIVATION_SETTLEMENT_TABLE,
    `/${normalized.operationID}`,
    normalized,
  );
  if (!result || result.success !== true) {
    return false;
  }
  const flushResult = database.flushTableSync(CLONE_ACTIVATION_SETTLEMENT_TABLE);
  return Boolean(flushResult && flushResult.success);
}

function removeCloneActivationSettlement(operationID) {
  const result = database.remove(
    CLONE_ACTIVATION_SETTLEMENT_TABLE,
    `/${String(operationID || "")}`,
  );
  if (!result || result.success !== true) {
    return false;
  }
  const flushResult = database.flushTableSync(CLONE_ACTIVATION_SETTLEMENT_TABLE);
  return Boolean(flushResult && flushResult.success);
}

function prepareCloneActivation(options = {}) {
  const jumpState = options.jumpState && typeof options.jumpState === "object"
    ? cloneValue(options.jumpState)
    : null;
  const charID = toPositiveInt(jumpState && jumpState.charID, 0);
  if (!charID || !jumpState.targetClone) {
    return { success: false, errorMsg: "INVALID_CLONE_ACTIVATION" };
  }
  const existing = findPendingCloneActivationForCharacter(charID);
  if (existing) {
    return { success: true, duplicate: true, data: existing };
  }
  const root = ensureCloneActivationSettlementTable();
  const sequence = toPositiveInt(root._meta.nextOperationID, 1);
  const operationID = `${charID}:${sequence}`;
  root._meta = { version: 1, nextOperationID: sequence + 1 };
  const settlement = normalizeCloneActivationSettlement({
    operationID,
    charID,
    jumpState,
    amount: normalizeMoney(options.amount),
    ownerCorpID: toPositiveInt(options.ownerCorpID, 0),
    createdAt: String(currentFileTime()),
  });
  root[operationID] = settlement;
  const writeResult = database.write(
    CLONE_ACTIVATION_SETTLEMENT_TABLE,
    "/",
    root,
    { force: true },
  );
  if (!writeResult || writeResult.success !== true) {
    return writeResult || { success: false, errorMsg: "PERSISTENCE_ERROR" };
  }
  const flushResult = database.flushTableSync(CLONE_ACTIVATION_SETTLEMENT_TABLE);
  return flushResult && flushResult.success
    ? { success: true, duplicate: false, data: settlement }
    : flushResult || { success: false, errorMsg: "PERSISTENCE_ERROR" };
}

function prepareCloneInstall(options = {}) {
  const charID = toPositiveInt(options.charID, 0);
  const locationID = toPositiveInt(options.locationID, 0);
  const locationKind = ["station", "structure", "ship"].includes(options.locationKind)
    ? options.locationKind
    : resolveLocationKind(locationID);
  if (!charID || !locationID) {
    return { success: false, errorMsg: "INVALID_CLONE_LOCATION" };
  }

  const pending = findPendingCloneInstallForCharacter(charID);
  if (pending) {
    if (
      pending.locationID === locationID &&
      pending.locationKind === locationKind
    ) {
      return { success: true, existing: true, data: pending };
    }
    return { success: false, errorMsg: "CLONE_INSTALL_PENDING" };
  }

  const record = getCharacterRecord(charID);
  if (!record) {
    return { success: false, errorMsg: "CHARACTER_NOT_FOUND" };
  }
  const clones = normalizeJumpClones(record);
  const jumpCloneID = getNextCloneID(record, clones);
  const table = ensureCloneInstallSettlementTable();
  const operationSequence = toPositiveInt(
    table._meta && table._meta.nextOperationID,
    1,
  );
  database.write(
    CLONE_INSTALL_SETTLEMENT_TABLE,
    "/_meta/nextOperationID",
    operationSequence + 1,
  );
  const operationID = `${charID}:${jumpCloneID}:${operationSequence}`;
  const amount = normalizeMoney(options.amount);
  const ownerCorpID = toPositiveInt(options.ownerCorpID, 0);
  const settlement = {
    operationID,
    charID,
    jumpCloneID,
    locationID,
    locationKind,
    amount,
    ownerCorpID,
    offeringCharID: toPositiveInt(options.offeringCharID, 0),
    debitApplied: amount <= 0,
    creditApplied: amount <= 0 || !ownerCorpID,
    debitAttempted: amount <= 0,
    creditAttempted: amount <= 0 || !ownerCorpID,
    debitCommandID: `${DURABLE_INSTALL_JOB_PREFIX}${operationID}:debit`,
    creditCommandID: `${DURABLE_INSTALL_JOB_PREFIX}${operationID}:credit`,
    ownerCreditReversalCommandID:
      `${DURABLE_INSTALL_JOB_PREFIX}${operationID}:credit-reversal`,
    debitRefundCommandID:
      `${DURABLE_INSTALL_JOB_PREFIX}${operationID}:debit-refund`,
    compensating: false,
    ownerCreditReversed: false,
    debitRefunded: false,
    createdAt: String(currentFileTime()),
  };
  if (!persistCloneInstallSettlement(settlement)) {
    return { success: false, errorMsg: "PERSISTENCE_ERROR" };
  }
  return { success: true, data: normalizeCloneInstallSettlement(settlement) };
}

function checkpointCloneInstall(settlement, patch = {}) {
  return persistCloneInstallSettlement({ ...settlement, ...patch });
}

function commitCloneInstall(settlement) {
  let committedClone = null;
  let collision = false;
  const result = updateCharacterRecord(settlement.charID, (record) => {
    applyCharacterWalletProjection(record, settlement.charID);
    const clones = normalizeJumpClones(record);
    const existing = clones.find((clone) =>
      clone.jumpCloneID === settlement.jumpCloneID);
    if (existing) {
      if (
        existing.locationID !== settlement.locationID ||
        existing.locationKind !== settlement.locationKind
      ) {
        collision = true;
      } else {
        committedClone = existing;
      }
      return record;
    }
    const clone = buildCloneRecord({
      jumpCloneID: settlement.jumpCloneID,
      ownerID: settlement.charID,
      locationID: settlement.locationID,
      locationKind: settlement.locationKind,
      cloneName: "",
      implants: [],
    });
    record.jumpClones = [...clones, clone];
    record.nextJumpCloneID = Math.max(
      toPositiveInt(record.nextJumpCloneID, 0),
      settlement.jumpCloneID + 1,
    );
    appendCloneEvent(record, EVENT_CLONE_INSTALLATION, {
      jumpCloneID: clone.jumpCloneID,
      locationID: clone.locationID,
    });
    committedClone = clone;
    return record;
  });
  if (!result || result.success !== true || collision || !committedClone) {
    return {
      success: false,
      errorMsg: collision ? "CLONE_ID_COLLISION" : "CLONE_COMMIT_FAILED",
    };
  }
  database.flushTableAsync(characterState.CHARACTERS_TABLE || "characters");
  return { success: true, data: committedClone };
}

function emitCloneInstallCompletion(settlement, preferredSession = null) {
  const targetSession = preferredSession ||
    sessionRegistry.findSessionByCharacterID(settlement.charID) || null;
  if (settlement.locationKind === "ship") {
    const offer = pendingShipCloneOffers.get(settlement.charID);
    if (
      offer &&
      toPositiveInt(offer.shipID, 0) === settlement.locationID &&
      toPositiveInt(offer.offeringCharID, 0) === settlement.offeringCharID
    ) {
      pendingShipCloneOffers.delete(settlement.charID);
    }
    const payload = [[
      settlement.offeringCharID,
      settlement.charID,
      settlement.locationID,
      0,
    ]];
    emitSessionNotification(targetSession, "OnShipJumpCloneInstallationDone", payload);
    emitSessionNotification(
      sessionRegistry.findSessionByCharacterID(settlement.offeringCharID),
      "OnShipJumpCloneInstallationDone",
      payload,
    );
  }
  emitCloneInvalidations(targetSession, settlement.locationID, settlement.charID);
}

function isCloneInstallTargetAvailable(settlement) {
  if (settlement.locationKind === "ship") {
    return Boolean(findItemById(settlement.locationID));
  }
  if (settlement.locationKind === "structure") {
    return Boolean(getStructureByIDNoRefresh(settlement.locationID));
  }
  return Boolean(worldData.getStationByID(settlement.locationID));
}

async function compensateCloneInstall(settlement) {
  let current = getPendingCloneInstallSettlement(
    settlement.charID,
    settlement.operationID,
  );
  if (!current) {
    return {
      success: false,
      errorMsg: "CLONE_INSTALL_TARGET_UNAVAILABLE",
      compensated: true,
    };
  }

  if (
    current.creditApplied &&
    current.ownerCorpID &&
    !current.ownerCreditReversed
  ) {
    const reversalResult = await adjustCorporationWalletDivisionBalanceAsync(
      current.ownerCorpID,
      CORPORATION_WALLET_KEY_START,
      -current.amount,
      {
        description: `Cancelled structure clone installation at ${current.locationID}`,
        entryTypeID:
          JOURNAL_ENTRY_TYPE.JUMP_CLONE_INSTALLATION || REF_JUMP_CLONE_INSTALLATION_FEE,
        idempotencyKey: current.ownerCreditReversalCommandID,
        ownerID1: current.charID,
        ownerID2: current.ownerCorpID,
        referenceID: current.locationID,
      },
      {
        commandID: current.ownerCreditReversalCommandID,
        idempotencyKey: current.ownerCreditReversalCommandID,
        source: "jump-clone-install-owner-credit-reversal",
      },
    );
    if (!reversalResult || reversalResult.success !== true) {
      return reversalResult || {
        success: false,
        errorMsg: "OWNER_CREDIT_REVERSAL_FAILED",
      };
    }
    if (!checkpointCloneInstall(current, { ownerCreditReversed: true })) {
      return { success: false, errorMsg: "CREDIT_REVERSAL_CHECKPOINT_FAILED" };
    }
    current = getPendingCloneInstallSettlement(
      current.charID,
      current.operationID,
    );
  }

  if (current && current.debitApplied && !current.debitRefunded) {
    const refundResult = await adjustCharacterBalanceAsync(
      current.charID,
      current.amount,
      {
        description: `Cancelled jump clone installation at ${current.locationID}`,
        entryTypeID:
          JOURNAL_ENTRY_TYPE.JUMP_CLONE_INSTALLATION || REF_JUMP_CLONE_INSTALLATION_FEE,
        idempotencyKey: current.debitRefundCommandID,
        ownerID1: current.ownerCorpID || current.offeringCharID,
        ownerID2: current.charID,
        referenceID: current.locationID,
      },
      {
        commandID: current.debitRefundCommandID,
        idempotencyKey: current.debitRefundCommandID,
        source: "jump-clone-install-debit-refund",
      },
    );
    if (!refundResult || refundResult.success !== true) {
      return refundResult || { success: false, errorMsg: "DEBIT_REFUND_FAILED" };
    }
    if (!checkpointCloneInstall(current, { debitRefunded: true })) {
      return { success: false, errorMsg: "DEBIT_REFUND_CHECKPOINT_FAILED" };
    }
  }

  if (!removeCloneInstallSettlement(settlement.operationID)) {
    return { success: false, errorMsg: "COMPENSATION_FINALIZE_FAILED" };
  }
  return {
    success: false,
    errorMsg: "CLONE_INSTALL_TARGET_UNAVAILABLE",
    compensated: true,
  };
}

async function beginCloneInstallCompensation(settlement) {
  if (!settlement.compensating) {
    if (!checkpointCloneInstall(settlement, { compensating: true })) {
      return { success: false, errorMsg: "COMPENSATION_CHECKPOINT_FAILED" };
    }
    settlement = getPendingCloneInstallSettlement(
      settlement.charID,
      settlement.operationID,
    );
  }
  return compensateCloneInstall(settlement);
}

async function settlePendingCloneInstallInternal(
  charID,
  operationID,
  options = {},
) {
  let settlement = getPendingCloneInstallSettlement(charID, operationID);
  if (!settlement) {
    return { success: true, alreadySettled: true, data: null };
  }
  if (settlement.compensating) {
    return compensateCloneInstall(settlement);
  }
  const targetAvailable = isCloneInstallTargetAvailable(settlement);
  if (!targetAvailable) {
    if (!settlement.debitApplied && !settlement.debitAttempted) {
      removeCloneInstallSettlement(settlement.operationID);
      return {
        success: false,
        errorMsg: "CLONE_INSTALL_TARGET_UNAVAILABLE",
        compensated: true,
      };
    }
    if (
      settlement.debitApplied &&
      (!settlement.ownerCorpID ||
        settlement.creditApplied ||
        !settlement.creditAttempted)
    ) {
      return beginCloneInstallCompensation(settlement);
    }
  }

  if (!settlement.debitApplied) {
    if (!settlement.debitAttempted) {
      if (!checkpointCloneInstall(settlement, { debitAttempted: true })) {
        return { success: false, errorMsg: "DEBIT_ATTEMPT_CHECKPOINT_FAILED" };
      }
      settlement = getPendingCloneInstallSettlement(charID, operationID);
      if (!settlement) {
        return { success: false, errorMsg: "DEBIT_ATTEMPT_CHECKPOINT_MISSING" };
      }
    }
    const debitResult = await adjustCharacterBalanceAsync(
      settlement.charID,
      -settlement.amount,
      {
        description: `Jump clone installation at ${settlement.locationID}`,
        entryTypeID:
          JOURNAL_ENTRY_TYPE.JUMP_CLONE_INSTALLATION || REF_JUMP_CLONE_INSTALLATION_FEE,
        idempotencyKey: settlement.debitCommandID,
        ownerID1: settlement.charID,
        ownerID2: settlement.ownerCorpID || settlement.offeringCharID,
        referenceID: settlement.locationID,
      },
      {
        commandID: settlement.debitCommandID,
        idempotencyKey: settlement.debitCommandID,
        source: "jump-clone-install-debit",
      },
    );
    if (!debitResult || debitResult.success !== true) {
      if (debitResult && debitResult.errorMsg === "INSUFFICIENT_FUNDS") {
        removeCloneInstallSettlement(settlement.operationID);
      }
      return debitResult || { success: false, errorMsg: "WALLET_DEBIT_FAILED" };
    }
    if (!checkpointCloneInstall(settlement, { debitApplied: true })) {
      return { success: false, errorMsg: "DEBIT_CHECKPOINT_FAILED" };
    }
    settlement = getPendingCloneInstallSettlement(charID, operationID);
    if (!settlement) {
      return { success: false, errorMsg: "DEBIT_CHECKPOINT_MISSING" };
    }
    if (!isCloneInstallTargetAvailable(settlement)) {
      return beginCloneInstallCompensation(settlement);
    }
  }

  if (!settlement.creditApplied) {
    if (!settlement.creditAttempted) {
      if (!checkpointCloneInstall(settlement, { creditAttempted: true })) {
        return { success: false, errorMsg: "CREDIT_ATTEMPT_CHECKPOINT_FAILED" };
      }
      settlement = getPendingCloneInstallSettlement(charID, operationID);
      if (!settlement) {
        return { success: false, errorMsg: "CREDIT_ATTEMPT_CHECKPOINT_MISSING" };
      }
    }
    const creditResult = await adjustCorporationWalletDivisionBalanceAsync(
      settlement.ownerCorpID,
      CORPORATION_WALLET_KEY_START,
      settlement.amount,
      {
        description: `Structure clone installation fee at ${settlement.locationID}`,
        entryTypeID:
          JOURNAL_ENTRY_TYPE.JUMP_CLONE_INSTALLATION || REF_JUMP_CLONE_INSTALLATION_FEE,
        idempotencyKey: settlement.creditCommandID,
        ownerID1: settlement.charID,
        ownerID2: settlement.ownerCorpID,
        referenceID: settlement.locationID,
      },
      {
        commandID: settlement.creditCommandID,
        idempotencyKey: settlement.creditCommandID,
        source: "jump-clone-install-owner-credit",
      },
    );
    if (!creditResult || creditResult.success !== true) {
      return creditResult || { success: false, errorMsg: "OWNER_CREDIT_FAILED" };
    }
    if (!checkpointCloneInstall(settlement, { creditApplied: true })) {
      return { success: false, errorMsg: "CREDIT_CHECKPOINT_FAILED" };
    }
    settlement = getPendingCloneInstallSettlement(charID, operationID);
    if (!settlement) {
      return { success: false, errorMsg: "CREDIT_CHECKPOINT_MISSING" };
    }
    if (!isCloneInstallTargetAvailable(settlement)) {
      return beginCloneInstallCompensation(settlement);
    }
  }

  const commitResult = commitCloneInstall(settlement);
  if (!commitResult.success) {
    return commitResult;
  }
  if (!removeCloneInstallSettlement(settlement.operationID)) {
    return { success: false, errorMsg: "SETTLEMENT_FINALIZE_FAILED" };
  }
  emitCloneInstallCompletion(settlement, options.session || null);
  return {
    success: true,
    data: {
      operationID: settlement.operationID,
      clone: cloneValue(commitResult.data),
    },
  };
}

function settlePendingCloneInstall(charID, operationID, options = {}) {
  const settlement = getPendingCloneInstallSettlement(charID, operationID);
  if (!settlement) {
    return Promise.resolve({ success: true, alreadySettled: true, data: null });
  }
  return runCloneInstallSerialized(settlement.charID, () =>
    settlePendingCloneInstallInternal(
      settlement.charID,
      settlement.operationID,
      options,
    ));
}

function buildDurableCloneInstallJob(settlement) {
  const normalized = normalizeCloneInstallSettlement(settlement);
  return normalized ? {
    jobID: `${DURABLE_INSTALL_JOB_PREFIX}${normalized.operationID}`,
    type: DURABLE_INSTALL_JOB_TYPE,
    dueAtMs: Date.now(),
    payload: {
      charID: normalized.charID,
      operationID: normalized.operationID,
    },
  } : null;
}

async function schedulePendingCloneInstall(settlement) {
  if (!durableScheduler) {
    return null;
  }
  const job = buildDurableCloneInstallJob(settlement);
  if (job) {
    await durableScheduler.schedule(job);
  }
  return job;
}

function buildDurableCloneActivationJob(settlement) {
  const normalized = normalizeCloneActivationSettlement(settlement);
  return normalized ? {
    jobID: `${DURABLE_ACTIVATION_JOB_PREFIX}${normalized.operationID}`,
    type: DURABLE_ACTIVATION_JOB_TYPE,
    dueAtMs: Date.now(),
    payload: { operationID: normalized.operationID },
  } : null;
}

async function schedulePendingCloneActivation(settlement) {
  if (!durableScheduler) {
    return null;
  }
  const job = buildDurableCloneActivationJob(settlement);
  if (job) {
    await durableScheduler.schedule(job);
  }
  return job;
}

function bindDurableScheduler(scheduler) {
  if (!scheduler || typeof scheduler.schedule !== "function") {
    throw new TypeError("jump clone scheduler requires a schedule function");
  }
  durableScheduler = scheduler;
  return true;
}

function unbindDurableScheduler(scheduler = null) {
  if (scheduler && durableScheduler !== scheduler) {
    return false;
  }
  durableScheduler = null;
  return true;
}

async function handleDurableCloneInstall(job = {}) {
  const charID = toPositiveInt(job.payload && job.payload.charID, 0);
  const operationID = String(job.payload && job.payload.operationID || "").trim();
  if (!charID || !operationID) {
    throw new Error("jump clone install job is invalid");
  }
  const result = await settlePendingCloneInstall(charID, operationID);
  if (!result || result.success !== true) {
    if (result && result.compensated === true) {
      return { charID, operationID, compensated: true };
    }
    if (result && result.errorMsg === "INSUFFICIENT_FUNDS") {
      return { charID, operationID, paymentFailed: true };
    }
    throw new Error(result && result.errorMsg || "jump clone install failed");
  }
  return result;
}

async function handleDurableCloneActivation(job = {}) {
  const operationID = String(job.payload && job.payload.operationID || "").trim();
  if (!operationID) {
    throw new Error("jump clone activation job is invalid");
  }
  const result = await settlePendingCloneActivation(operationID);
  if (!result || result.success !== true) {
    if (result && result.compensated === true) {
      return { operationID, compensated: true };
    }
    if (result && result.errorMsg === "INSUFFICIENT_FUNDS") {
      return { operationID, paymentFailed: true };
    }
    throw new Error(result && result.errorMsg || "jump clone activation failed");
  }
  return result;
}

// `jump-clone-install:<charID>:<jumpCloneID>:<operationSequence>:<leg>` and
// `jump-clone-activation:<charID>:<operationSequence>:<leg>`. Each table keeps
// its own counter, and a pending settlement's sequence is the last segment of
// its operationID.
const INSTALL_SEQUENCE_DOMAIN = registerSettlementSequenceDomain(
  "jump-clone-install",
  /^jump-clone-install:\d+:\d+:(\d+):/,
);
const ACTIVATION_SEQUENCE_DOMAIN = registerSettlementSequenceDomain(
  "jump-clone-activation",
  /^jump-clone-activation:\d+:(\d+):/,
);

function operationSequenceOf(settlement) {
  const segments = String(settlement && settlement.operationID || "").split(":");
  return Number(segments[segments.length - 1]);
}

function writeSettlementCounter(tableName, counterPath, value) {
  const result = database.write(tableName, counterPath, value);
  if (!result || result.success !== true) {
    return result || { success: false, errorMsg: "PERSISTENCE_ERROR" };
  }
  return database.flushTableSync(tableName);
}

function advanceOperationSequenceWatermarks(receiptScan) {
  advanceSettlementSequenceWatermark({
    logTag: "[JumpCloneInstall]",
    counterName: "nextOperationID",
    domain: INSTALL_SEQUENCE_DOMAIN,
    receiptScan,
    readCounter: () => ensureCloneInstallSettlementTable()._meta.nextOperationID,
    writeCounter: (required) => {
      const table = ensureCloneInstallSettlementTable();
      return toPositiveInt(table._meta.nextOperationID, 1) >= required
        ? { success: true }
        : writeSettlementCounter(
          CLONE_INSTALL_SETTLEMENT_TABLE,
          "/_meta/nextOperationID",
          required,
        );
    },
    pendingSequences: () =>
      listPendingCloneInstallSettlements().map(operationSequenceOf),
  });
  advanceSettlementSequenceWatermark({
    logTag: "[JumpCloneActivation]",
    counterName: "nextOperationID",
    domain: ACTIVATION_SEQUENCE_DOMAIN,
    receiptScan,
    readCounter: () => ensureCloneActivationSettlementTable()._meta.nextOperationID,
    writeCounter: (required) => {
      const root = ensureCloneActivationSettlementTable();
      return root._meta.nextOperationID >= required
        ? { success: true }
        : writeSettlementCounter(
          CLONE_ACTIVATION_SETTLEMENT_TABLE,
          "/_meta",
          { version: 1, nextOperationID: required },
        );
    },
    pendingSequences: () =>
      listPendingCloneActivationSettlements().map(operationSequenceOf),
  });
}

async function reconcileDurableCloneInstalls(options = {}) {
  advanceOperationSequenceWatermarks(options.receiptScan);
  const pending = listPendingCloneInstallSettlements();
  const pendingActivations = listPendingCloneActivationSettlements();
  if (!durableScheduler) {
    return {
      scheduled: 0,
      pending: pending.length,
      installScheduled: 0,
      activationScheduled: 0,
      activationPending: pendingActivations.length,
    };
  }
  await Promise.all([
    ...pending.map((settlement) => schedulePendingCloneInstall(settlement)),
    ...pendingActivations.map((settlement) =>
      schedulePendingCloneActivation(settlement)),
  ]);
  return {
    scheduled: pending.length,
    pending: pending.length,
    installScheduled: pending.length,
    activationScheduled: pendingActivations.length,
    activationPending: pendingActivations.length,
  };
}

function characterHasStructureCloneService(session, structure) {
  if (!structure) {
    return false;
  }
  if (characterHasStructureService(session, structure, STRUCTURE_SERVICE_ID.MEDICAL)) {
    return true;
  }
  if (!structureHasOnlineService(structure, STRUCTURE_SERVICE_ID.JUMP_CLONE)) {
    return false;
  }
  return canCharacterDockAtStructure(session, structure, {
    ignoreRestrictions: false,
  }).success;
}

function getStructureDisplayName(structure, fallbackID = 0) {
  return (
    structure &&
    (
      structure.itemName ||
      structure.name ||
      `Structure ${toPositiveInt(structure.structureID, fallbackID)}`
    )
  );
}

function ensureStructureCloneServiceAccess(session, structureID) {
  const normalizedStructureID = toPositiveInt(structureID, 0);
  const structure = worldData.getStructureByID(normalizedStructureID);
  if (!structure || !characterHasStructureCloneService(session, structure)) {
    throwWrappedUserError("StructureCloneBayDenied", {
      structureName: getStructureDisplayName(structure, normalizedStructureID),
    });
  }
  return structure;
}

function normalizeCloneServiceCost(value, fallback = JUMP_CLONE_INSTALL_COST) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return fallback;
  }
  return Math.max(0, Math.min(MAX_STRUCTURE_CLONE_BAY_COST, numericValue));
}

function getCloneServiceCostForLocation(session, location = getCurrentDockedLocation(session)) {
  if (!location || location.kind !== "structure") {
    return JUMP_CLONE_INSTALL_COST;
  }

  const structure = worldData.getStructureByID(location.locationID);
  if (!structure || !characterHasStructureCloneService(session, structure)) {
    return JUMP_CLONE_INSTALL_COST;
  }

  return normalizeCloneServiceCost(
    getProfileSettingValueForStructure(
      structure,
      STRUCTURE_SETTING_ID.CLONINGBAY_TAX,
      {
        session,
        defaultValue: JUMP_CLONE_INSTALL_COST,
      },
    ),
  );
}

function getCurrentCloneServiceCost(session) {
  return getCloneServiceCostForLocation(session, getCurrentDockedLocation(session));
}

function validateInstallJumpClone(session) {
  const errors = [];
  const charID = toPositiveInt(session && session.characterID, 0);
  const current = getCurrentDockedLocation(session);
  if (!charID || !current.locationID) {
    errors.push("UI/CharacterSheet/CharacterSheetWindow/JumpCloneScroll/JumpNotDockedError");
    return errors;
  }

  const state = getCloneState(charID);
  const limit = getCharacterCloneLimit(charID);
  if (limit <= 0) {
    errors.push("UI/Medical/JumpCloneSkillReqNotMet");
  }
  if (state.clones.length >= limit) {
    errors.push([
      "UI/Medical/JumpCloneUsageAndCapacity",
      {
        count: state.clones.length,
        limit,
      },
    ]);
  }
  if (state.clones.some((clone) => clone.locationID === current.locationID)) {
    errors.push([
      "UI/CharacterSheet/CharacterSheetWindow/JumpCloneScroll/InstalledCloneCount",
      {
        clone_count: state.clones.filter((clone) => clone.locationID === current.locationID).length,
      },
    ]);
  }
  if (current.kind === "structure") {
    const structure = worldData.getStructureByID(current.locationID);
    const dockCheck = canCharacterDockAtStructure(session, structure, {
      ignoreRestrictions: false,
    });
    if (!dockCheck.success || !characterHasStructureCloneService(session, structure)) {
      errors.push("UI/Medical/Errors/UnknownValidationError");
    }
  }

  return errors;
}

async function installCloneAtCurrentLocation(session) {
  const charID = toPositiveInt(session && session.characterID, 0);
  const current = getCurrentDockedLocation(session);
  if (!charID || !current.locationID) {
    throwWrappedUserError("NotAtStation");
  }
  return runCloneInstallSerialized(charID, async () => {
    let settlement = findPendingCloneInstallForCharacter(charID);
    if (settlement && (
      settlement.locationID !== current.locationID ||
      settlement.locationKind !== current.kind
    )) {
      throwWrappedUserError("CustomNotify", {
        notify: "Another jump clone installation is still pending",
      });
    }

    if (!settlement) {
      const validationErrors = validateInstallJumpClone(session);
      if (validationErrors.length > 0) {
        throwWrappedUserError("CustomNotify", {
          notify: Array.isArray(validationErrors[0])
            ? validationErrors[0][0]
            : validationErrors[0],
        });
      }
      const cloneServiceCost = getCloneServiceCostForLocation(session, current);
      ensureWalletCanPay(charID, cloneServiceCost);
      const prepared = prepareCloneInstall({
        charID,
        locationID: current.locationID,
        locationKind: current.kind,
        amount: cloneServiceCost,
        ownerCorpID: getStructureCloneServiceOwnerCorpID(current),
      });
      if (!prepared.success || !prepared.data) {
        throwWrappedUserError("CustomNotify", {
          notify: prepared.errorMsg || "Jump clone install failed",
        });
      }
      settlement = prepared.data;
      void schedulePendingCloneInstall(settlement).catch((error) => {
        log.warn(
          `[JumpCloneRuntime] Durable install scheduling failed operation=${settlement.operationID}: ${error.message}`,
        );
      });
    }

    const result = await settlePendingCloneInstallInternal(
      settlement.charID,
      settlement.operationID,
      { session },
    );
    if (!result || result.success !== true) {
      if (result && result.errorMsg === "INSUFFICIENT_FUNDS") {
        throwNotEnoughMoney(settlement.amount, 0);
      }
      throwWrappedUserError("CustomNotify", {
        notify: result && result.errorMsg || "Jump clone install failed",
      });
    }
    return null;
  });
}

function setJumpCloneName(session, cloneID, newName) {
  const charID = toPositiveInt(session && session.characterID, 0);
  const targetCloneID = toPositiveInt(cloneID, 0);
  if (!charID || !targetCloneID) {
    throwWrappedUserError("CustomNotify", { notify: "Jump clone not found" });
  }
  const name = normalizeCloneName(newName, "");
  let locationID = 0;
  const result = updateCharacterRecord(charID, (record) => {
    const clones = normalizeJumpClones(record);
    const target = clones.find((clone) => clone.jumpCloneID === targetCloneID);
    if (!target) {
      return record;
    }
    target.cloneName = name;
    target.name = name;
    locationID = target.locationID;
    record.jumpClones = clones;
    return record;
  });
  if (!result.success || !locationID) {
    throwWrappedUserError("CustomNotify", { notify: "Jump clone not found" });
  }
  emitCloneInvalidations(session, locationID, charID);
  return null;
}

function createJumpCloneDeletionNotification(charID, typeIDs = [], destroyerID = charID, options = {}) {
  return createNotification(charID, {
    ...options,
    typeID:
      destroyerID === charID
        ? NOTIFICATION_TYPE_JUMP_CLONE_DELETED_1
        : NOTIFICATION_TYPE_JUMP_CLONE_DELETED_2,
    senderID: destroyerID,
    groupID: NOTIFICATION_GROUP.MISC,
    data: {
      locationOwnerID: charID,
      destroyerID,
      typeIDs,
    },
  });
}

function destroyInstalledClone(session, cloneID, options = {}) {
  const charID = toPositiveInt(session && session.characterID, 0);
  const targetCloneID = toPositiveInt(cloneID, 0);
  if (!charID || !targetCloneID) {
    throwWrappedUserError("CustomNotify", { notify: "Jump clone not found" });
  }

  let removedClone = null;
  const result = updateCharacterRecord(charID, (record) => {
    const clones = normalizeJumpClones(record);
    const remainingClones = [];
    for (const clone of clones) {
      if (clone.jumpCloneID === targetCloneID) {
        removedClone = clone;
      } else {
        remainingClones.push(clone);
      }
    }
    if (!removedClone) {
      return record;
    }
    record.jumpClones = remainingClones;
    appendCloneEvent(record, EVENT_CLONE_DESTRUCTION, {
      jumpCloneID: removedClone.jumpCloneID,
      locationID: removedClone.locationID,
      typeIDs: removedClone.implants.map((implant) => implant.typeID),
    });
    return record;
  });
  if (!result.success || !removedClone) {
    throwWrappedUserError("CustomNotify", { notify: "Jump clone not found" });
  }

  if (options.notify !== false) {
    createJumpCloneDeletionNotification(
      charID,
      removedClone.implants.map((implant) => implant.typeID),
      options.destroyerID || charID,
    );
  }
  emitCloneInvalidations(session, removedClone.locationID, charID);
  return null;
}

function removeJumpClonesAtStructure(structureID, options = {}) {
  const locationID = toPositiveInt(structureID, 0);
  if (!locationID) {
    return {
      success: false,
      errorMsg: "STRUCTURE_REQUIRED",
      removedCloneCount: 0,
      affectedCharacterIDs: [],
      removedClones: [],
    };
  }

  const explicitDestroyerID = toPositiveInt(options.destroyerID, 0);
  const structure = explicitDestroyerID ? null : worldData.getStructureByID(locationID);
  const destroyerID =
    explicitDestroyerID ||
    toPositiveInt(structure && (structure.ownerID || structure.ownerCorpID), 0) ||
    locationID;
  const reason = normalizeText(options.reason, "") || "structureCloneLocationRemoved";
  const affectedCharacterIDs = [];
  const removedClones = [];
  const failedCharacterIDs = [];

  for (const charID of listCharacterIDs()) {
    let removedForCharacter = [];
    const result = updateCharacterRecord(charID, (record) => {
      const clones = normalizeJumpClones(record);
      const remainingClones = [];
      removedForCharacter = [];

      for (const clone of clones) {
        if (clone.locationID === locationID) {
          removedForCharacter.push(clone);
        } else {
          remainingClones.push(clone);
        }
      }

      if (removedForCharacter.length === 0) {
        return record;
      }

      record.jumpClones = remainingClones;
      for (const removedClone of removedForCharacter) {
        appendCloneEvent(record, EVENT_CLONE_DESTRUCTION, {
          jumpCloneID: removedClone.jumpCloneID,
          locationID,
          typeIDs: removedClone.implants.map((implant) => implant.typeID),
          reason,
        });
      }
      return record;
    });

    if (!result.success) {
      failedCharacterIDs.push(charID);
      log.warn(
        `[JumpCloneRuntime] Failed to remove structure jump clones char=${charID} structure=${locationID} error=${result.errorMsg || "UNKNOWN"}`,
      );
      continue;
    }
    if (removedForCharacter.length === 0) {
      continue;
    }

    affectedCharacterIDs.push(charID);
    const removedTypeIDs = [];
    for (const removedClone of removedForCharacter) {
      const typeIDs = removedClone.implants.map((implant) => implant.typeID);
      removedTypeIDs.push(...typeIDs);
      removedClones.push({
        charID,
        jumpCloneID: removedClone.jumpCloneID,
        locationID,
        typeIDs,
      });
    }

    if (options.notify !== false) {
      createJumpCloneDeletionNotification(charID, removedTypeIDs, destroyerID);
    }

    const targetSession = sessionRegistry.findSessionByCharacterID(charID);
    emitCloneInvalidations(targetSession, locationID, charID);
  }

  return {
    success: failedCharacterIDs.length === 0,
    errorMsg: failedCharacterIDs.length > 0 ? "CLONE_CLEANUP_PARTIAL_FAILURE" : null,
    removedCloneCount: removedClones.length,
    affectedCharacterIDs,
    removedClones,
    failedCharacterIDs,
  };
}

function isCloneJumpCooldownActive(charID, timeLastCloneJump) {
  const cooldownHours = getCharacterCloneJumpCooldownHours(charID);
  if (cooldownHours <= 0) {
    return false;
  }
  const lastJumpMs = toFileTimeMs(timeLastCloneJump);
  if (!lastJumpMs) {
    return false;
  }
  return Date.now() < lastJumpMs + cooldownHours * 60 * 60 * 1000;
}

function buildCloneJumpState(session, destLocationID, cloneID, confirmed = false) {
  const charID = toPositiveInt(session && session.characterID, 0);
  const current = getCurrentDockedLocation(session);
  if (!charID || !current.locationID) {
    throwWrappedUserError("NotAtStation");
  }
  if (current.kind === "structure") {
    ensureStructureCloneServiceAccess(session, current.locationID);
  }
  const state = getCloneState(charID);
  const targetCloneID = toPositiveInt(cloneID, 0);
  const targetLocationID = toPositiveInt(destLocationID, 0);
  const targetClone = state.clones.find((clone) => (
    clone.jumpCloneID === targetCloneID &&
    (!targetLocationID || clone.locationID === targetLocationID)
  ));
  if (!targetClone) {
    throwWrappedUserError("CustomNotify", { notify: "Jump clone not found" });
  }
  if (targetClone.locationKind === "structure") {
    ensureStructureCloneServiceAccess(session, targetClone.locationID);
  }
  const shouldCheckTimer =
    targetClone.locationID !== current.locationID ||
    targetClone.locationKind === "ship";
  if (shouldCheckTimer && isCloneJumpCooldownActive(charID, state.timeLastCloneJump)) {
    throwWrappedUserError("CustomNotify", {
      notify: "UI/CharacterSheet/CharacterSheetWindow/JumpCloneScroll/JumpCooldownError",
    });
  }
  const suppressCooldownUpdate =
    current.kind === "structure" &&
    targetClone.locationKind === "structure" &&
    targetClone.locationID === current.locationID;

  const originClone = state.clones.find((clone) => (
    clone.locationID === current.locationID &&
    clone.jumpCloneID !== targetClone.jumpCloneID
  ));
  if (originClone && confirmed !== true) {
    throwWrappedUserError("JumpCheckWillLoseExistingClone", {
      locationID: current.locationID,
    });
  }
  if (targetClone.locationKind === "ship" && confirmed !== true) {
    throwWrappedUserError("JumpCheckIntoShip", {
      shipID: targetClone.locationID,
    });
  }
  if (targetClone.locationKind === "structure" && confirmed !== true) {
    throwWrappedUserError("JumpCheckIntoStructure", {
      structureID: targetClone.locationID,
    });
  }

  const replacementCloneID =
    targetClone.locationID === current.locationID
      ? targetClone.jumpCloneID
      : state.nextJumpCloneID;
  const activeFollowImplants = state.implants.filter(implantFollowsJumpClones);
  const oldBodyImplants = state.implants.filter(
    (implant) => !implantFollowsJumpClones(implant),
  );
  const replacementClone = buildCloneRecord({
    jumpCloneID: replacementCloneID,
    ownerID: charID,
    locationID: current.locationID,
    locationKind: current.kind,
    cloneName: originClone ? originClone.cloneName : "",
    implants: oldBodyImplants,
  });
  const nextClones = state.clones
    .filter((clone) => (
      clone.jumpCloneID !== targetClone.jumpCloneID &&
      (!originClone || clone.jumpCloneID !== originClone.jumpCloneID)
    ));
  nextClones.push(replacementClone);
  nextClones.sort((left, right) => left.jumpCloneID - right.jumpCloneID);

  return {
    charID,
    originLocationID: current.locationID,
    originLocationKind: current.kind,
    targetClone,
    originClone,
    nextClones,
    nextImplants: mergeImplantsBySlot(targetClone.implants, activeFollowImplants),
    nextJumpCloneID:
      replacementCloneID >= state.nextJumpCloneID
        ? replacementCloneID + 1
        : state.nextJumpCloneID,
    timeLastCloneJump: suppressCooldownUpdate
      ? String(state.timeLastCloneJump || "0")
      : getNowFileTimeString(),
  };
}

function buildLocationIdentityPatch(record, solarSystemID, extra = {}) {
  const targetSolarSystemID =
    toPositiveInt(solarSystemID, toPositiveInt(record.solarSystemID, 30000142));
  const system = worldData.getSolarSystemByID(targetSolarSystemID);
  return {
    ...record,
    ...extra,
    solarSystemID: targetSolarSystemID,
    constellationID:
      toPositiveInt(system && system.constellationID, toPositiveInt(record.constellationID, 20000020)),
    regionID:
      toPositiveInt(system && system.regionID, toPositiveInt(record.regionID, 10000002)),
    worldSpaceID: 0,
  };
}

function jumpSessionToStructure(session, structureID, options = {}) {
  const structure = worldData.getStructureByID(structureID);
  if (!structure) {
    return {
      success: false,
      errorMsg: "STRUCTURE_NOT_FOUND",
    };
  }
  const dockCheck = canCharacterDockAtStructure(session, structure, {
    ignoreRestrictions: false,
  });
  if (!dockCheck.success) {
    return dockCheck;
  }
  const activeShip = getActiveShipRecord(session.characterID);
  if (!activeShip) {
    return {
      success: false,
      errorMsg: "SHIP_NOT_FOUND",
    };
  }

  const source = getCurrentDockedLocation(session);
  const dockResult = dockShipToLocation(activeShip.itemID, structure.structureID);
  if (!dockResult.success) {
    return dockResult;
  }
  // The guests of the dock the pilot jumps out of are told it left, as they
  // are when the jump is to a station (transitions.jumpSessionToDockableLocation).
  if (source.kind === "station") {
    broadcastStationGuestLeft(session, source.locationID);
  } else if (
    source.kind === "structure" &&
    source.locationID !== structure.structureID
  ) {
    broadcastStructureGuestLeft(session, source.locationID);
  }
  const updateResult = updateCharacterRecord(session.characterID, (record) =>
    buildLocationIdentityPatch(record, structure.solarSystemID, {
      stationID: null,
      structureID: structure.structureID,
      ...(options.jumpCloneActivationOperationID
        ? {
            jumpCloneActivationTransitionReceipt: {
              operationID: String(options.jumpCloneActivationOperationID),
              locationKind: "structure",
              locationID: structure.structureID,
            },
          }
        : {}),
    }),
    { expectedLocationTransitionReason: "structure-jump-clone" },
  );
  if (!updateResult.success) {
    return updateResult;
  }

  const applyResult = applyCharacterToSession(session, session.characterID, {
    emitNotifications: false,
    logSelection: true,
    selectionEvent: false,
    deferDockedShipSessionChange: false,
  });
  if (!applyResult.success) {
    return applyResult;
  }
  flushCharacterSessionNotificationPlan(session, applyResult.notificationPlan);
  syncInventoryItemForSession(
    session,
    dockResult.data,
    {
      locationID: dockResult.previousData && dockResult.previousData.locationID,
      flagID: dockResult.previousData && dockResult.previousData.flagID,
      quantity: dockResult.previousData && dockResult.previousData.quantity,
      singleton: dockResult.previousData && dockResult.previousData.singleton,
      stacksize: dockResult.previousData && dockResult.previousData.stacksize,
    },
    {
      emitCfgLocation: true,
    },
  );
  // The guests of the structure are told the pilot arrived, once its session is
  // there, as they are when a pilot is moved into a structure another way
  // (transitions.jumpSessionToDockableLocation). A guest who lists the pilot
  // already is not told again, and a pilot who was in this structure has not
  // arrived.
  if (
    source.kind !== "structure" ||
    source.locationID !== structure.structureID
  ) {
    broadcastStructureGuestJoined(session, structure.structureID);
  }
  return {
    success: true,
    data: {
      structure,
    },
  };
}

function assertAbyssalCloneJumpAllowed(session) {
  const characterID = toPositiveInt(
    session && (session.characterID || session.charid || session.charID),
    0,
  );
  const shipID = toPositiveInt(
    session && session._space && session._space.shipID ||
      session && (session.shipID || session.shipid || session.activeShipID),
    0,
  );
  const AbyssalMgrService = require("../../abyssal").scenePolicy;
  const characterRun =
    characterID > 0 &&
    typeof AbyssalMgrService.getActiveAbyssalRunForCharacterID === "function"
      ? AbyssalMgrService.getActiveAbyssalRunForCharacterID(characterID)
      : null;
  const shipRun =
    !characterRun &&
    shipID > 0 &&
    typeof AbyssalMgrService.getActiveAbyssalRunForShipID === "function"
      ? AbyssalMgrService.getActiveAbyssalRunForShipID(shipID)
      : null;
  const sceneKey = String(
    session && session._space && session._space.sceneKey ||
      session && session.spaceSceneKey ||
      "",
  ).trim();
  const hasAbyssalSceneAuthority = Boolean(
    String(session && session._space && session._space.sceneKind || "").trim() === "abyssal" ||
    /^abyssal-run:\d+$/.test(sceneKey)
  );
  const systemID = toPositiveInt(
    session &&
      (
        (session._space && session._space.systemID) ||
        session.solarsystemid2 ||
        session.solarsystemid
      ),
    0,
  );
  if (
    characterRun ||
    shipRun ||
    hasAbyssalSceneAuthority ||
    isAbyssalHostLocationID(systemID)
  ) {
    throwWrappedUserError("CustomNotify", {
      notify: "You cannot jump clones while an Abyssal run is active.",
    });
  }
}

function checkpointCloneActivation(settlement, patch = {}) {
  return persistCloneActivationSettlement({ ...settlement, ...patch });
}

function commitWalletProjectionForCloneActivation(charID) {
  const result = updateCharacterRecord(charID, (record) => {
    applyCharacterWalletProjection(record, charID);
    return record;
  });
  if (!result || result.success !== true) {
    return result || { success: false, errorMsg: "CHARACTER_PROJECTION_FAILED" };
  }
  return database.flushTableSync(characterState.CHARACTERS_TABLE || "characters");
}

async function compensateCloneActivation(settlement) {
  let current = getPendingCloneActivationSettlement(settlement.operationID);
  if (!current) {
    return { success: false, compensated: true, errorMsg: "CLONE_ACTIVATION_CANCELLED" };
  }
  if (current.creditApplied && current.ownerCorpID && !current.ownerCreditReversed) {
    const result = await adjustCorporationWalletDivisionBalanceAsync(
      current.ownerCorpID,
      CORPORATION_WALLET_KEY_START,
      -current.amount,
      {
        description: `Cancelled clone activation from ${current.jumpState.originLocationID}`,
        entryTypeID:
          JOURNAL_ENTRY_TYPE.JUMP_CLONE_ACTIVATION || REF_JUMP_CLONE_ACTIVATION_FEE,
        idempotencyKey: current.ownerCreditReversalCommandID,
        ownerID1: current.charID,
        ownerID2: current.ownerCorpID,
        referenceID: current.jumpState.targetClone.locationID,
      },
      {
        commandID: current.ownerCreditReversalCommandID,
        source: "jump-clone-activation-owner-credit-reversal",
      },
    );
    if (!result || result.success !== true) {
      return result || { success: false, errorMsg: "OWNER_CREDIT_REVERSAL_FAILED" };
    }
    if (!checkpointCloneActivation(current, { ownerCreditReversed: true })) {
      return { success: false, errorMsg: "CREDIT_REVERSAL_CHECKPOINT_FAILED" };
    }
    current = getPendingCloneActivationSettlement(current.operationID);
  }
  if (current.debitApplied && !current.debitRefunded) {
    const result = await adjustCharacterBalanceAsync(
      current.charID,
      current.amount,
      {
        description: `Cancelled clone activation to ${current.jumpState.targetClone.locationID}`,
        entryTypeID:
          JOURNAL_ENTRY_TYPE.JUMP_CLONE_ACTIVATION || REF_JUMP_CLONE_ACTIVATION_FEE,
        idempotencyKey: current.debitRefundCommandID,
        ownerID1: current.ownerCorpID,
        ownerID2: current.charID,
        referenceID: current.jumpState.targetClone.locationID,
      },
      {
        commandID: current.debitRefundCommandID,
        source: "jump-clone-activation-debit-refund",
      },
    );
    if (!result || result.success !== true) {
      return result || { success: false, errorMsg: "DEBIT_REFUND_FAILED" };
    }
    if (!checkpointCloneActivation(current, { debitRefunded: true })) {
      return { success: false, errorMsg: "DEBIT_REFUND_CHECKPOINT_FAILED" };
    }
  }
  commitWalletProjectionForCloneActivation(current.charID);
  if (!removeCloneActivationSettlement(current.operationID)) {
    return { success: false, errorMsg: "ACTIVATION_COMPENSATION_FINALIZE_FAILED" };
  }
  return { success: false, compensated: true, errorMsg: "CLONE_ACTIVATION_CANCELLED" };
}

function beginCloneActivationCompensation(settlement) {
  if (!settlement.compensating) {
    if (!checkpointCloneActivation(settlement, { compensating: true })) {
      return Promise.resolve({ success: false, errorMsg: "COMPENSATION_CHECKPOINT_FAILED" });
    }
    settlement = getPendingCloneActivationSettlement(settlement.operationID);
  }
  return compensateCloneActivation(settlement);
}

function sessionAtCloneActivationTarget(session, jumpState) {
  const target = jumpState.targetClone;
  if (target.locationKind === "ship") {
    return false;
  }
  return getCurrentDockedLocation(session).locationID === target.locationID;
}

function persistedCharacterAtCloneActivationTarget(settlement) {
  const target = settlement.jumpState.targetClone;
  const record = getCharacterRecord(settlement.charID) || {};
  const receipt = record.jumpCloneActivationTransitionReceipt;
  if (
    receipt &&
    String(receipt.operationID || "") === settlement.operationID &&
    String(receipt.locationKind || "") === target.locationKind &&
    toPositiveInt(receipt.locationID, 0) === target.locationID
  ) {
    return true;
  }
  if (target.locationKind === "ship") {
    return false;
  }
  const locationID = target.locationKind === "structure"
    ? toPositiveInt(record.structureID || record.structureid, 0)
    : toPositiveInt(record.stationID || record.stationid, 0);
  return locationID === target.locationID;
}

function performCloneActivationTransition(session, jumpState, operationID) {
  if (jumpState.targetClone.locationID === jumpState.originLocationID) {
    return { success: true, unchanged: true };
  }
  const targetKind = jumpState.targetClone.locationKind;
  if (targetKind === "ship") {
    const { jumpSessionToShipCloneBay } = require(path.join(
      __dirname,
      "../../space/transitions",
    ));
    return jumpSessionToShipCloneBay(
      session,
      jumpState.targetClone.locationID,
      { jumpCloneActivationOperationID: operationID },
    );
  }
  if (targetKind === "station") {
    const { jumpSessionToStation } = require(path.join(
      __dirname,
      "../../space/transitions",
    ));
    return jumpSessionToStation(
      session,
      jumpState.targetClone.locationID,
      { jumpCloneActivationOperationID: operationID },
    );
  }
  if (targetKind === "structure") {
    return jumpSessionToStructure(
      session,
      jumpState.targetClone.locationID,
      { jumpCloneActivationOperationID: operationID },
    );
  }
  return { success: false, errorMsg: "CLONE_ACTIVATION_TARGET_UNAVAILABLE" };
}

function applyCloneActivationState(settlement) {
  let alreadyApplied = false;
  const result = updateCharacterRecord(settlement.charID, (record) => {
    applyCharacterWalletProjection(record, settlement.charID);
    const receipts = Array.isArray(record.jumpCloneActivationReceipts)
      ? record.jumpCloneActivationReceipts.map((entry) => ({ ...entry }))
      : [];
    if (receipts.some((entry) => entry.operationID === settlement.operationID)) {
      alreadyApplied = true;
      return record;
    }
    const jumpState = settlement.jumpState;
    record.implants = jumpState.nextImplants;
    record.jumpClones = jumpState.nextClones;
    record.nextJumpCloneID = jumpState.nextJumpCloneID;
    record.timeLastCloneJump = jumpState.timeLastCloneJump;
    appendCloneEvent(record, EVENT_CLONE_JUMP, {
      fromLocationID: jumpState.originLocationID,
      toLocationID: jumpState.targetClone.locationID,
      targetCloneID: jumpState.targetClone.jumpCloneID,
      operationID: settlement.operationID,
    });
    receipts.unshift({
      operationID: settlement.operationID,
      targetCloneID: jumpState.targetClone.jumpCloneID,
      createdAt: getNowFileTimeString(),
    });
    record.jumpCloneActivationReceipts = receipts.slice(0, 32);
    return record;
  });
  if (!result || result.success !== true) {
    return result || { success: false, errorMsg: "CLONE_STATE_COMMIT_FAILED" };
  }
  const flushResult = database.flushTableSync(characterState.CHARACTERS_TABLE || "characters");
  return flushResult && flushResult.success
    ? { success: true, duplicate: alreadyApplied }
    : flushResult || { success: false, errorMsg: "CLONE_STATE_FLUSH_FAILED" };
}

async function settlePendingCloneActivationInternal(operationID, options = {}) {
  let settlement = getPendingCloneActivationSettlement(operationID);
  if (!settlement) {
    return { success: true, alreadySettled: true };
  }
  if (settlement.compensating) {
    return compensateCloneActivation(settlement);
  }
  if (!settlement.debitApplied) {
    const result = await adjustCharacterBalanceAsync(
      settlement.charID,
      -settlement.amount,
      {
        description: `Jump clone activation to ${settlement.jumpState.targetClone.locationID}`,
        entryTypeID:
          JOURNAL_ENTRY_TYPE.JUMP_CLONE_ACTIVATION || REF_JUMP_CLONE_ACTIVATION_FEE,
        idempotencyKey: settlement.debitCommandID,
        ownerID1: settlement.charID,
        ownerID2: settlement.ownerCorpID,
        referenceID: settlement.jumpState.targetClone.locationID,
      },
      {
        commandID: settlement.debitCommandID,
        source: "jump-clone-activation-debit",
      },
    );
    if (!result || result.success !== true) {
      if (result && result.errorMsg === "INSUFFICIENT_FUNDS") {
        removeCloneActivationSettlement(settlement.operationID);
      }
      return result || { success: false, errorMsg: "WALLET_DEBIT_FAILED" };
    }
    if (!checkpointCloneActivation(settlement, { debitApplied: true })) {
      return { success: false, errorMsg: "DEBIT_CHECKPOINT_FAILED" };
    }
    settlement = getPendingCloneActivationSettlement(operationID);
  }
  if (!settlement.creditApplied) {
    const result = await adjustCorporationWalletDivisionBalanceAsync(
      settlement.ownerCorpID,
      CORPORATION_WALLET_KEY_START,
      settlement.amount,
      {
        description: `Structure clone activation fee at ${settlement.jumpState.originLocationID}`,
        entryTypeID:
          JOURNAL_ENTRY_TYPE.JUMP_CLONE_ACTIVATION || REF_JUMP_CLONE_ACTIVATION_FEE,
        idempotencyKey: settlement.creditCommandID,
        ownerID1: settlement.charID,
        ownerID2: settlement.ownerCorpID,
        referenceID: settlement.jumpState.targetClone.locationID,
      },
      {
        commandID: settlement.creditCommandID,
        source: "jump-clone-activation-owner-credit",
      },
    );
    if (!result || result.success !== true) {
      return result || { success: false, errorMsg: "OWNER_CREDIT_FAILED" };
    }
    if (!checkpointCloneActivation(settlement, { creditApplied: true })) {
      return { success: false, errorMsg: "CREDIT_CHECKPOINT_FAILED" };
    }
    settlement = getPendingCloneActivationSettlement(operationID);
  }
  const projectionResult = commitWalletProjectionForCloneActivation(settlement.charID);
  if (!projectionResult || projectionResult.success !== true) {
    return projectionResult || { success: false, errorMsg: "CHARACTER_PROJECTION_FAILED" };
  }
  if (!settlement.transitioned) {
    const session = options.session ||
      sessionRegistry.findSessionByCharacterID(settlement.charID) || null;
    if (
      (session && sessionAtCloneActivationTarget(session, settlement.jumpState)) ||
      persistedCharacterAtCloneActivationTarget(settlement)
    ) {
      if (!checkpointCloneActivation(settlement, { transitioned: true })) {
        return { success: false, errorMsg: "TRANSITION_CHECKPOINT_FAILED" };
      }
    } else if (!session) {
      return beginCloneActivationCompensation(settlement);
    } else {
      const transitionResult = performCloneActivationTransition(
        session,
        settlement.jumpState,
        settlement.operationID,
      );
      if (!transitionResult || transitionResult.success !== true) {
        return beginCloneActivationCompensation(settlement);
      }
      const characterFlushResult = database.flushTableSync(
        characterState.CHARACTERS_TABLE || "characters",
      );
      const itemFlushResult = database.flushTableSync("items");
      if (
        !characterFlushResult || characterFlushResult.success !== true ||
        !itemFlushResult || itemFlushResult.success !== true
      ) {
        return { success: false, errorMsg: "TRANSITION_FLUSH_FAILED" };
      }
      if (!checkpointCloneActivation(settlement, { transitioned: true })) {
        return { success: false, errorMsg: "TRANSITION_CHECKPOINT_FAILED" };
      }
    }
    settlement = getPendingCloneActivationSettlement(operationID);
  }
  if (!settlement.stateApplied) {
    const stateResult = applyCloneActivationState(settlement);
    if (!stateResult.success) {
      return stateResult;
    }
    if (!checkpointCloneActivation(settlement, { stateApplied: true })) {
      return { success: false, errorMsg: "STATE_CHECKPOINT_FAILED" };
    }
    settlement = getPendingCloneActivationSettlement(operationID);
  }
  if (!removeCloneActivationSettlement(operationID)) {
    return { success: false, errorMsg: "ACTIVATION_FINALIZE_FAILED" };
  }
  const session = options.session ||
    sessionRegistry.findSessionByCharacterID(settlement.charID) || null;
  emitCloneInvalidations(session, settlement.jumpState.originLocationID, settlement.charID);
  emitCloneInvalidations(
    session,
    settlement.jumpState.targetClone.locationID,
    settlement.charID,
  );
  syncCharacterDogmaAfterImplantChange(session, settlement.charID);
  return { success: true, operationID };
}

function settlePendingCloneActivation(operationID, options = {}) {
  const settlement = getPendingCloneActivationSettlement(operationID);
  if (!settlement) {
    return Promise.resolve({ success: true, alreadySettled: true });
  }
  return runCloneInstallSerialized(settlement.charID, () =>
    settlePendingCloneActivationInternal(operationID, options));
}

async function performCloneJump(session, destLocationID, cloneID, cost = null, confirmed = false) {
  assertAbyssalCloneJumpAllowed(session);
  const charID = toPositiveInt(session && session.characterID, 0);
  let settlement = findPendingCloneActivationForCharacter(charID);
  if (settlement) {
    if (
      toPositiveInt(settlement.jumpState.targetClone.jumpCloneID, 0) !==
        toPositiveInt(cloneID, 0) ||
      (
        toPositiveInt(destLocationID, 0) &&
        settlement.jumpState.targetClone.locationID !== toPositiveInt(destLocationID, 0)
      )
    ) {
      throwWrappedUserError("CustomNotify", {
        notify: "Another clone activation is still pending",
      });
    }
    const resumed = await settlePendingCloneActivation(
      settlement.operationID,
      { session },
    );
    if (!resumed || resumed.success !== true) {
      if (resumed && resumed.errorMsg === "INSUFFICIENT_FUNDS") {
        throwNotEnoughMoney(settlement.amount, 0);
      }
      throwWrappedUserError("CustomNotify", {
        notify: resumed && resumed.errorMsg || "Clone jump failed",
      });
    }
    return null;
  }
  const jumpState = buildCloneJumpState(session, destLocationID, cloneID, confirmed === true);
  // Retail always disembarks before issuing CloneJump. Keep that sequencing at
  // the client/BFF layer (where the session-change cooldown can be observed),
  // but fail closed here as the final authority: a direct or malformed caller
  // must never carry a normal hull through a consciousness jump.
  const activeShip = getActiveShipRecord(jumpState.charID);
  if (!activeShip || !isCapsuleTypeID(activeShip.typeID)) {
    throwWrappedUserError("CustomNotify", {
      notify: "You must leave your ship before jumping clones",
    });
  }
  const activationCost = getCurrentCloneServiceCost(session);
  ensureWalletCanPay(jumpState.charID, activationCost);
  const prepared = prepareCloneActivation({
    jumpState,
    amount: activationCost,
    ownerCorpID: getStructureCloneServiceOwnerCorpID({
      kind: jumpState.originLocationKind,
      locationID: jumpState.originLocationID,
    }),
  });
  if (!prepared.success || !prepared.data) {
    throwWrappedUserError("CustomNotify", {
      notify: prepared.errorMsg || "Clone activation could not be prepared",
    });
  }
  settlement = prepared.data;
  void schedulePendingCloneActivation(settlement).catch((error) => {
    log.warn(
      `[JumpCloneRuntime] Durable activation scheduling failed operation=${settlement.operationID}: ${error.message}`,
    );
  });
  const result = await settlePendingCloneActivation(
    settlement.operationID,
    { session },
  );
  if (!result || result.success !== true) {
    if (result && result.errorMsg === "INSUFFICIENT_FUNDS") {
      throwNotEnoughMoney(settlement.amount, 0);
    }
    throwWrappedUserError("CustomNotify", {
      notify: result && result.errorMsg || "Clone jump failed",
    });
  }
  return null;
}

function resetLastCloneJumpTime(session) {
  const charID = toPositiveInt(session && session.characterID, 0);
  if (!charID) {
    return null;
  }
  updateCharacterRecord(charID, (record) => {
    record.timeLastCloneJump = "0";
    appendCloneEvent(record, EVENT_CLONE_JUMP_TIME_RESET, {});
    return record;
  });
  emitCloneInvalidations(session, getCurrentDockedLocation(session).locationID, charID);
  return null;
}

function getShipCloneCapacity(ship) {
  if (!ship) {
    return 0;
  }
  return Math.max(0, Math.trunc(
    Number(getTypeAttributeValue(ship.typeID, "maxJumpClones") || 0) || 0,
  ));
}

function getShipSolarSystemID(ship) {
  return toPositiveInt(
    ship && ship.spaceState && ship.spaceState.systemID,
    toPositiveInt(ship && ship.locationID, 0),
  );
}

function getShipSpacePosition(ship) {
  const position = ship && ship.spaceState && ship.spaceState.position;
  if (!position) {
    return null;
  }
  return {
    x: toFiniteNumber(position.x, 0),
    y: toFiniteNumber(position.y, 0),
    z: toFiniteNumber(position.z, 0),
  };
}

function getShipSpaceRadius(ship) {
  return Math.max(
    0,
    toFiniteNumber(ship && ship.spaceRadius, 0),
    toFiniteNumber(ship && ship.spaceState && ship.spaceState.radius, 0),
  );
}

function calculateSurfaceDistanceMeters(sourceShip, targetShip) {
  const sourcePosition = getShipSpacePosition(sourceShip);
  const targetPosition = getShipSpacePosition(targetShip);
  if (!sourcePosition || !targetPosition) {
    return null;
  }
  const dx = sourcePosition.x - targetPosition.x;
  const dy = sourcePosition.y - targetPosition.y;
  const dz = sourcePosition.z - targetPosition.z;
  const centerDistance = Math.sqrt((dx * dx) + (dy * dy) + (dz * dz));
  return Math.max(
    0,
    centerDistance - getShipSpaceRadius(sourceShip) - getShipSpaceRadius(targetShip),
  );
}

function validateCloneVatTargetRange(sourceShip, targetShip) {
  const maxOperationalDistance = Math.max(
    0,
    toFiniteNumber(getTypeAttributeValue(sourceShip && sourceShip.typeID, "maxOperationalDistance"), 0),
  );
  if (maxOperationalDistance <= 0) {
    return false;
  }
  if (!sourceShip || !targetShip || !sourceShip.spaceState || !targetShip.spaceState) {
    return false;
  }
  if (getShipSolarSystemID(sourceShip) !== getShipSolarSystemID(targetShip)) {
    return false;
  }
  const surfaceDistance = calculateSurfaceDistanceMeters(sourceShip, targetShip);
  return surfaceDistance !== null && surfaceDistance <= maxOperationalDistance;
}

function hasCloneReceivingBay(session) {
  const charID = toPositiveInt(session && session.characterID, 0);
  const activeShip = getActiveShipRecord(charID);
  if (!activeShip) {
    return false;
  }
  const canReceive =
    Number(getTypeAttributeValue(activeShip.typeID, "canReceiveCloneJumps") || 0) > 0;
  if (!canReceive) {
    return false;
  }
  const fittedModules = getFittedModuleItems(charID, activeShip.itemID);
  return fittedModules.some((module) => (
    Number(module.typeID) === TYPE_CLONE_VAT_BAY_I &&
    isEffectivelyOnlineModule(module)
  ));
}

function getNumClonesInPilotsStructure(session) {
  const locationID = toPositiveInt(session && (session.structureid || session.shipid), 0);
  if (!locationID) {
    return 0;
  }
  const state = getCloneState(session && session.characterID);
  return state.clones.filter((clone) => clone.locationID === locationID).length;
}

function offerShipCloneInstallation(session, targetCharID) {
  const offeringCharID = toPositiveInt(session && session.characterID, 0);
  const targetCharacterID = toPositiveInt(targetCharID, 0);
  const activeShip = getActiveShipRecord(offeringCharID);
  if (!offeringCharID || !targetCharacterID || !activeShip) {
    throwWrappedUserError("CustomNotify", { notify: "Clone install target unavailable" });
  }
  if (!hasCloneReceivingBay(session)) {
    throwWrappedUserError("InviteClone1");
  }
  const targetSession = sessionRegistry.findSessionByCharacterID(targetCharacterID, {
    excludeSession: null,
  });
  if (!targetSession) {
    throwWrappedUserError("CustomNotify", { notify: "Clone install target unavailable" });
  }
  const targetShip = getActiveShipRecord(targetCharacterID);
  if (!validateCloneVatTargetRange(activeShip, targetShip)) {
    throwWrappedUserError("InviteClone2");
  }

  const offer = {
    offeringCharID,
    targetCharID: targetCharacterID,
    shipID: activeShip.itemID,
    offeredAt: Date.now(),
  };
  pendingShipCloneOffers.set(targetCharacterID, offer);
  emitSessionNotification(targetSession, "OnShipJumpCloneInstallationOffered", [
    [offer.offeringCharID, offer.targetCharID, offer.shipID, 0],
  ]);
  return null;
}

async function acceptShipCloneInstallation(session) {
  const targetCharID = toPositiveInt(session && session.characterID, 0);
  const offer = pendingShipCloneOffers.get(targetCharID);
  if (!offer) {
    throwWrappedUserError("CustomNotify", { notify: "Clone install offer expired" });
  }
  const ship = findItemById(offer.shipID);
  if (!ship) {
    pendingShipCloneOffers.delete(targetCharID);
    throwWrappedUserError("CustomNotify", { notify: "Clone install ship unavailable" });
  }
  const offeringShip = getActiveShipRecord(offer.offeringCharID);
  const targetShip = getActiveShipRecord(targetCharID);
  if (!offeringShip || offeringShip.itemID !== offer.shipID || !validateCloneVatTargetRange(offeringShip, targetShip)) {
    pendingShipCloneOffers.delete(targetCharID);
    throwWrappedUserError("InviteClone2");
  }
  const targetState = getCloneState(targetCharID);
  const capacity = getShipCloneCapacity(ship);
  const installedInShip = targetState.clones.filter((clone) => clone.locationID === ship.itemID).length;
  if (installedInShip >= capacity) {
    throwWrappedUserError("CustomNotify", { notify: "Clone bay is full" });
  }
  const cloneLimit = getCharacterCloneLimit(targetCharID);
  if (targetState.clones.length >= cloneLimit) {
    throwWrappedUserError("CustomNotify", { notify: "UI/Medical/JumpCloneSkillReqNotMet" });
  }

  return runCloneInstallSerialized(targetCharID, async () => {
    let settlement = findPendingCloneInstallForCharacter(targetCharID);
    if (settlement && (
      settlement.locationKind !== "ship" ||
      settlement.locationID !== toPositiveInt(ship.itemID, 0)
    )) {
      throwWrappedUserError("CustomNotify", {
        notify: "Another jump clone installation is still pending",
      });
    }
    if (!settlement) {
      ensureWalletCanPay(targetCharID, JUMP_CLONE_INSTALL_COST);
      const prepared = prepareCloneInstall({
        charID: targetCharID,
        locationID: ship.itemID,
        locationKind: "ship",
        amount: JUMP_CLONE_INSTALL_COST,
        offeringCharID: offer.offeringCharID,
      });
      if (!prepared.success || !prepared.data) {
        throwWrappedUserError("CustomNotify", {
          notify: prepared.errorMsg || "Jump clone install failed",
        });
      }
      settlement = prepared.data;
      void schedulePendingCloneInstall(settlement).catch((error) => {
        log.warn(
          `[JumpCloneRuntime] Durable ship install scheduling failed operation=${settlement.operationID}: ${error.message}`,
        );
      });
    }

    const result = await settlePendingCloneInstallInternal(
      settlement.charID,
      settlement.operationID,
      { session },
    );
    if (!result || result.success !== true) {
      if (result && result.errorMsg === "INSUFFICIENT_FUNDS") {
        throwNotEnoughMoney(settlement.amount, 0);
      }
      throwWrappedUserError("CustomNotify", {
        notify: result && result.errorMsg || "Jump clone install failed",
      });
    }
    return null;
  });
}

function cancelShipCloneInstallation(session) {
  const charID = toPositiveInt(session && session.characterID, 0);
  let offer = pendingShipCloneOffers.get(charID);
  if (!offer) {
    for (const candidate of pendingShipCloneOffers.values()) {
      if (candidate && candidate.offeringCharID === charID) {
        offer = candidate;
        break;
      }
    }
  }
  if (!offer) {
    return null;
  }
  pendingShipCloneOffers.delete(offer.targetCharID);
  const payload = [[offer.offeringCharID, offer.targetCharID, offer.shipID, 0]];
  emitSessionNotification(session, "OnShipJumpCloneInstallationCanceled", payload);
  const targetSession = sessionRegistry.findSessionByCharacterID(offer.targetCharID);
  emitSessionNotification(targetSession, "OnShipJumpCloneInstallationCanceled", payload);
  return null;
}

function clearActiveImplantsForPodDeath(session, options = {}) {
  const charID = toPositiveInt(
    options.characterID || (session && session.characterID),
    0,
  );
  if (!charID) {
    return {
      success: false,
      errorMsg: "CHARACTER_REQUIRED",
    };
  }
  let removedTypeIDs = [];
  const previous = options.airDeathKey || options.durableDeathKey ? cloneValue(getCharacterRecord(charID)) : null;
  const result = updateCharacterRecord(charID, (record) => {
    const airDeath = options.airDeathKey && record.authoredAirTutorial?.encounter?.combat?.deaths?.pod;
    if (options.airDeathKey) {
      if (airDeath?.plan?.key !== options.airDeathKey) throw new Error("AIR_CLONE_DEATH_RECEIPT_MISMATCH");
      if (airDeath.implantReceipt) { removedTypeIDs = airDeath.implantReceipt.removedTypeIDs; return record; }
    }
    if (options.operationID) {
      const operation = record.homeStationSelfDestruct;
      if (!operation || operation.generation !== options.operationID || operation.state === "completed") {
        throw new Error("HOME_CLONE_IMPLANT_OPERATION_MISMATCH");
      }
      if (operation.implantReceipt) {
        removedTypeIDs = operation.implantReceipt.removedTypeIDs;
        return record;
      }
    }
    if (options.durableDeathKey) {
      const receipt = record.durablePodDeathReceipts?.[options.durableDeathKey]?.implants;
      if (receipt) { removedTypeIDs = receipt.removedTypeIDs; return record; }
    }
    const activeImplants = normalizeActiveImplants(record);
    if (activeImplants.length === 0 && !options.operationID && !options.airDeathKey && !options.durableDeathKey) {
      return record;
    }
    const implantKey = implant => String(implant.implantID || implant.itemID || `${implant.typeID}:${implant.installedAt || ""}`);
    const originalImplants = options.airDeathKey ? airDeath.plan.cloneImplants : options.durableDeathKey ? options.originalImplants || [] : null;
    const destroyed = implant => !implantIsNonDestructible(implant) && (!originalImplants || originalImplants.some(original => implantKey(original) === implantKey(implant)));
    const survivingImplants = sortImplantsBySlot(activeImplants.filter(implant => !destroyed(implant)));
    const destroyedImplants = activeImplants.filter(destroyed);
    removedTypeIDs = destroyedImplants.map((implant) => implant.typeID);
    record.implants = survivingImplants;
    if (options.airDeathKey) airDeath.implantReceipt = { key: options.airDeathKey, removedTypeIDs };
    if (options.durableDeathKey) {
      record.durablePodDeathReceipts ||= {};
      const receipt = record.durablePodDeathReceipts[options.durableDeathKey] ||= {};
      receipt.implants = { removedTypeIDs };
    }
    if (options.operationID) {
      record.homeStationSelfDestruct = { ...record.homeStationSelfDestruct,
        implantReceipt: { generation: options.operationID, removedTypeIDs } };
    }
    if (removedTypeIDs.length > 0) {
      appendCloneEvent(record, EVENT_CLONE_DESTROYED_WITH_LOCATION, {
        locationID: options.locationID || (session && session.solarsystemid2) || 0,
        typeIDs: removedTypeIDs,
      });
      appendCloneEvent(record, EVENT_CLONE_IMPLANT_REMOVAL, {
        typeIDs: removedTypeIDs,
      });
    }
    return record;
  });
  if (!result.success) {
    return result;
  }
  if (options.operationID || options.airDeathKey || options.durableDeathKey) {
    const flush = database.flushTableSync("characters");
    if (!flush.success) { if (previous) updateCharacterRecord(charID, () => previous); return flush; }
  }
  if (removedTypeIDs.length > 0) {
    const notification = createJumpCloneDeletionNotification(
      charID,
      removedTypeIDs,
      options.destroyerID || charID,
      options.operationID || options.airDeathKey || options.durableDeathKey ? { idempotencyKey: options.durableDeathKey ? `pod-death-implants:${charID}:${options.durableDeathKey}` : options.airDeathKey ? `air-clone-implants:${charID}:${options.airDeathKey}` : `home-clone-implants:${charID}:${options.operationID}`,
        emitLive: options.emitNotifications !== false } : {},
    );
    if ((options.operationID || options.airDeathKey || options.durableDeathKey) && !notification.success) return notification;
    if (options.emitNotifications !== false) {
      emitCloneInvalidations(session, getCurrentDockedLocation(session).locationID, charID);
    }
    // Notification suppression is used during pre-bootstrap terminal recovery,
    // but the authoritative character brain must still lose destroyed implant
    // modifiers before any later fitting or ship state is calculated.
    syncCharacterDogmaAfterImplantChange(session, charID);
    log.info(
      `[JumpCloneRuntime] Cleared ${removedTypeIDs.length} active implants for pod death char=${charID}`,
    );
  }
  return {
    success: true,
    removedTypeIDs,
  };
}

module.exports = {
  hasPendingCloneActivation: (charID) => !!findPendingCloneActivationForCharacter(charID),
  ATTRIBUTE_MAX_JUMP_CLONES,
  ATTRIBUTE_CLONE_JUMP_COOLDOWN,
  DURABLE_ACTIVATION_JOB_TYPE,
  DURABLE_INSTALL_JOB_TYPE,
  bindDurableScheduler,
  buildDurableCloneInstallJob,
  buildDurableCloneActivationJob,
  buildCloneStatePayload,
  buildStationCloneStatePayload,
  buildShipCloneStatePayload,
  getPriceForClone: getCurrentCloneServiceCost,
  validateInstallJumpClone,
  installCloneAtCurrentLocation,
  setJumpCloneName,
  destroyInstalledClone,
  removeJumpClonesAtStructure,
  performCloneJump,
  resetLastCloneJumpTime,
  getNumClonesInPilotsStructure,
  offerShipCloneInstallation,
  acceptShipCloneInstallation,
  cancelShipCloneInstallation,
  clearActiveImplantsForPodDeath,
  handleDurableCloneInstall,
  handleDurableCloneActivation,
  listPendingCloneActivationSettlements,
  listPendingCloneInstallSettlements,
  reconcileDurableCloneInstalls,
  settlePendingCloneInstall,
  settlePendingCloneActivation,
  unbindDurableScheduler,
  getCharacterCloneLimit,
  getCharacterCloneJumpCooldownHours,
  _testing: {
    normalizeClone,
    normalizeJumpClones,
    normalizeActiveImplants,
    buildCloneRows,
    buildImplantRows,
    buildCloneJumpState,
    prepareCloneActivation,
    prepareCloneInstall,
    pendingShipCloneOffers,
  },
};
