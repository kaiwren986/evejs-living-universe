"use strict";

const path = require("path");

const config = require(path.join(__dirname, "../../config"));
const database = require(path.join(__dirname, "../../gameStore"));
const log = require(path.join(__dirname, "../../utils/logger"));
const worldData = require(path.join(__dirname, "../../space/worldData"));
const {
  notifyAssetSafetyDelivered,
} = require(path.join(__dirname, "./structureAssetSafetyNotifications"));
const {
  isHighSecuritySystem,
  isLowSecuritySystem,
} = require(path.join(__dirname, "../security/systemSecurity"));
const {
  ITEM_FLAGS,
  createSpaceItemForOwner,
  findItemById,
  getAllItems,
  grantItemToOwnerLocation,
  listContainerItems,
  removeInventoryItem,
  updateInventoryItem,
} = require(path.join(__dirname, "../inventory/itemStore"));
const deliveryItemCustody = require(path.join(
  __dirname,
  "../inventory/deliveryItemCustody",
));
const itemCustody = require(path.join(__dirname, "../inventory/itemCustody"));
const {
  resolveItemByTypeID,
} = require(path.join(__dirname, "../inventory/itemTypeRegistry"));
const {
  TABLE,
  readStaticRows,
} = require(path.join(__dirname, "../_shared/referenceData"));
const {
  NEXT_ASSET_WRAP_ID_START,
  STRUCTURE_FAMILY,
  STRUCTURE_TYPE_PRESETS,
  STRUCTURE_UPKEEP_STATE,
} = require(path.join(__dirname, "./structureConstants"));
const {
  getCharacterIDsInCorporation,
} = require(path.join(__dirname, "../corporation/corporationState"));
const {
  NOTIFICATION_GROUP,
  NOTIFICATION_TYPE,
} = require(path.join(__dirname, "../notifications/notificationConstants"));
const {
  createNotification,
} = require(path.join(__dirname, "../notifications/notificationState"));
const {
  buildStructureScatterPosition,
  getStructureSpaceDirection,
} = require(path.join(__dirname, "./structureSpaceInterop"));

// Player structures live in structureState, required on use as worldData used to, so this
// file does not load the structure runtime and works where nothing else has loaded it.
function getStructureState() {
  return require(path.join(__dirname, "./structureState"));
}

const STRUCTURE_ASSET_SAFETY_TABLE = "structureAssetSafety";
const ASSET_SAFETY_FLAG_ID = 36;
const ASSET_SAFETY_WRAP_TYPE_ID = 60;
const OFFICE_EJECT_CONTAINER_TYPE_ID = 10167;
const CATEGORY_STRUCTURE = 65;
const STRUCTURE_UNANCHOR_ARTIFACT_PREFIX = "evejs:structure-unanchor";
const STRUCTURE_DESTRUCTION_ARTIFACT_PREFIX = "evejs:structure-destruction";
const STRUCTURE_RIG_SLOT_FLAGS = Object.freeze(new Set([92, 93, 94, 95, 96, 97, 98, 99]));
const STRUCTURE_ATTACHED_ITEM_FLAGS = Object.freeze(new Set([
  ...Array.from({ length: 24 }, (_, index) => 11 + index),
  ...Array.from({ length: 8 }, (_, index) => 125 + index),
  ...Array.from({ length: 8 }, (_, index) => 164 + index),
  ITEM_FLAGS.FIGHTER_BAY,
  ITEM_FLAGS.FIGHTER_TUBE_0,
  ITEM_FLAGS.FIGHTER_TUBE_1,
  ITEM_FLAGS.FIGHTER_TUBE_2,
  ITEM_FLAGS.FIGHTER_TUBE_3,
  ITEM_FLAGS.FIGHTER_TUBE_4,
  ITEM_FLAGS.STRUCTURE_FUEL_BAY,
  ITEM_FLAGS.STRUCTURE_DEED,
]));
const CORPORATION_HANGAR_FLAGS = Object.freeze(new Set([
  115, // flagCorpSAG1
  116, // flagCorpSAG2
  117, // flagCorpSAG3
  118, // flagCorpSAG4
  119, // flagCorpSAG5
  120, // flagCorpSAG6
  121, // flagCorpSAG7
  184, // flagCorpGoalDeliveries
]));
// inventorycommon.const.corpAssetSafetyFlags: these remain content flags;
// flag36 belongs to the delivered type60 wrapper, not its corporation divisions.
const CORPORATION_SAFETY_FLAGS = new Set([...CORPORATION_HANGAR_FLAGS, 62, 187]);
const STRUCTURE_DELIVERY_FLAGS = Object.freeze(new Set([
  ITEM_FLAGS.CORP_DELIVERIES,
  ITEM_FLAGS.DELIVERIES,
  ITEM_FLAGS.CAPSULEER_DELIVERIES,
]));
const STRUCTURE_RECOVERABLE_ASSET_FLAGS = Object.freeze(new Set([
  ITEM_FLAGS.HANGAR,
  ITEM_FLAGS.CARGO_HOLD,
  186, // flagMoonMaterialBay
]));
const DAYS_UNTIL_CAN_DELIVER = 5;
const DAYS_UNTIL_AUTO_MOVE = 20;
const DAY_MS = 24 * 60 * 60 * 1000;
const FILETIME_EPOCH_OFFSET = 116444736000000000n;
const FILETIME_TICKS_PER_MS = 10000n;

let wrapCache = null;
let stationCache = null;
let assetSafetyFaultInjector = null;
let wrapTableNeedsFlush = false;
const pendingFallbackRepairFlushes = new Set();

function queueWrapScheduling(assetWrapID) {
  // The scheduler adapter owns timing, while all wrap mutations stay here in
  // the world process. Loading on use avoids a state/adapter module cycle.
  return require("./structureAssetSafetyScheduler").queueWrap(assetWrapID);
}

function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function getCorporationRuntimeState() {
  return require(path.join(
    __dirname,
    "../corporation/corporationRuntimeState",
  ));
}

function getOfficeRentalBilling() {
  return require(path.join(
    __dirname,
    "../corporation/officeRentalBilling",
  ));
}

function getCorporationNotifications() {
  return require(path.join(
    __dirname,
    "../corporation/corporationNotifications",
  ));
}

function normalizeInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function normalizePositiveInt(value, fallback = 0) {
  const numeric = normalizeInt(value, fallback);
  return numeric > 0 ? numeric : fallback;
}

function normalizeTimestampMs(value, fallback = null) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : fallback;
}

function readWrapTable() {
  const result = database.read(STRUCTURE_ASSET_SAFETY_TABLE, "/");
  if (!result.success || !result.data || typeof result.data !== "object") {
    return {
      _meta: {
        nextWrapID: NEXT_ASSET_WRAP_ID_START,
        generatedAt: null,
        lastUpdatedAt: null,
      },
      wraps: [],
    };
  }
  return cloneValue(result.data);
}

function writeWrapTable(payload) {
  const result = database.write(STRUCTURE_ASSET_SAFETY_TABLE, "/", payload);
  if (!result.success) {
    return {
      success: false,
      errorMsg: result.errorMsg || "WRITE_FAILED",
    };
  }
  wrapCache = null;
  wrapTableNeedsFlush = true;
  const flushResult = database.flushTableSync(STRUCTURE_ASSET_SAFETY_TABLE);
  if (!flushResult || flushResult.success !== true) {
    return {
      success: false,
      ambiguous: true,
      errorMsg: flushResult && flushResult.errorMsg || "ASSET_SAFETY_FLUSH_FAILED",
    };
  }
  wrapTableNeedsFlush = false;
  return { success: true, durable: true };
}

function ensureWrapTableDurable() {
  if (!wrapTableNeedsFlush) {
    return { success: true };
  }
  const result = database.flushTableSync(STRUCTURE_ASSET_SAFETY_TABLE);
  if (!result || result.success !== true) {
    return { success: false, ambiguous: true,
      errorMsg: result && result.errorMsg || "ASSET_SAFETY_FLUSH_FAILED" };
  }
  wrapTableNeedsFlush = false;
  return { success: true };
}

function getStaticStations() {
  if (stationCache) {
    return stationCache;
  }

  stationCache = readStaticRows(TABLE.STATIONS)
    .map((station) => ({
      itemID: normalizePositiveInt(station && station.stationID, 0),
      typeID: normalizePositiveInt(station && station.stationTypeID, 0),
      solarSystemID: normalizePositiveInt(station && station.solarSystemID, 0),
      constellationID: normalizePositiveInt(station && station.constellationID, 0),
      regionID: normalizePositiveInt(station && station.regionID, 0),
      itemName: String(
        station && (station.stationName || station.itemName || `Station ${station.stationID}`),
      ),
    }))
    .filter((station) => station.itemID > 0)
    .sort((left, right) => left.itemID - right.itemID);

  return stationCache;
}

function normalizeStationInfo(value) {
  if (!value || typeof value !== "object") {
    return null;
  }

  const itemID = normalizePositiveInt(value.itemID || value.stationID, 0);
  if (!itemID) {
    return null;
  }

  return {
    itemID,
    typeID: normalizePositiveInt(value.typeID || value.stationTypeID, 0),
    solarSystemID: normalizePositiveInt(value.solarSystemID, 0),
    itemName: String(value.itemName || value.stationName || `Station ${itemID}`),
  };
}

function normalizeWrapRecord(entry = {}) {
  const assetWrapID = normalizePositiveInt(entry.assetWrapID, 0);
  const ownerKind = String(entry.ownerKind || "char").trim().toLowerCase() === "corp"
    ? "corp"
    : "char";
  const nearestNPCStationInfo = normalizeStationInfo(entry.nearestNPCStationInfo);
  const createdAt = normalizeTimestampMs(entry.createdAt, null) || Date.now();
  const ejectTimeMs =
    normalizeTimestampMs(entry.ejectTimeMs, null) ||
    normalizeTimestampMs(entry.ejectTime, null) ||
    createdAt;
  const collectionLegs = (Array.isArray(entry.collectionLegs)
    ? entry.collectionLegs
    : [])
    .map((leg, index) => ({
      itemID: normalizePositiveInt(
        leg && (leg.itemID || leg.sourceItem && leg.sourceItem.itemID),
        0,
      ),
      sourceItem: leg && leg.sourceItem && typeof leg.sourceItem === "object"
        ? cloneValue(leg.sourceItem)
        : null,
      // Historical collecting sagas must replay their original flag36 command.
      destinationFlagID: normalizePositiveInt(leg && leg.destinationFlagID, ASSET_SAFETY_FLAG_ID),
      idempotencyKey: String(
        leg && leg.idempotencyKey || `asset-safety:${assetWrapID}:collect:${index}`,
      ),
      status: String(leg && leg.status || "pending") === "committed"
        ? "committed"
        : "pending",
    }))
    .filter((leg) => leg.itemID > 0 && leg.sourceItem);
  const rawDeliverySaga = entry.deliverySaga && typeof entry.deliverySaga === "object"
    ? entry.deliverySaga
    : null;
  const deliverySaga = rawDeliverySaga
    ? {
        destinationID: normalizePositiveInt(rawDeliverySaga.destinationID, 0),
        destinationKind: String(rawDeliverySaga.destinationKind || "station"),
        deliveredAtMs: normalizeTimestampMs(rawDeliverySaga.deliveredAtMs, Date.now()) || Date.now(),
        autoMove: rawDeliverySaga.autoMove === true,
        // Keep old pending deliveries on their original unpacking route.
        deliveryMode: rawDeliverySaga.deliveryMode === "wrapped" ? "wrapped" : "unpacked",
        status: String(rawDeliverySaga.status || "pending") === "completed"
          ? "completed"
          : "pending",
        itemLegs: (Array.isArray(rawDeliverySaga.itemLegs)
          ? rawDeliverySaga.itemLegs
          : [])
          .map((leg, index) => ({
            itemID: normalizePositiveInt(
              leg && (leg.itemID || leg.sourceItem && leg.sourceItem.itemID),
              0,
            ),
            sourceItem: leg && leg.sourceItem && typeof leg.sourceItem === "object"
              ? cloneValue(leg.sourceItem)
              : null,
            idempotencyKey: String(
              leg && leg.idempotencyKey || `asset-safety:${assetWrapID}:deliver:${index}`,
            ),
            status: String(leg && leg.status || "pending") === "committed"
              ? "committed"
              : "pending",
          }))
          .filter((leg) => leg.itemID > 0 && leg.sourceItem),
      }
    : null;

  return {
    assetWrapID,
    ownerID: normalizePositiveInt(entry.ownerID, 0),
    ownerKind,
    sourceStructureID: normalizePositiveInt(entry.sourceStructureID, 0),
    solarSystemID: normalizePositiveInt(entry.solarSystemID, 0),
    wrapName: String(entry.wrapName || `Asset Safety Wrap ${assetWrapID}`),
    lifecycleKey:
      String(entry.lifecycleKey || "").trim() || null,
    wrapTypeID: ASSET_SAFETY_WRAP_TYPE_ID,
    itemIDs: [...new Set((Array.isArray(entry.itemIDs) ? entry.itemIDs : []).map((itemID) => normalizePositiveInt(itemID, 0)).filter(Boolean))].sort((left, right) => left - right),
    createdAt,
    ejectTimeMs,
    daysUntilCanDeliverConst: DAYS_UNTIL_CAN_DELIVER,
    daysUntilAutoMoveConst: DAYS_UNTIL_AUTO_MOVE,
    nearestNPCStationInfo,
    ...(["override", "distance-v1"].includes(entry.nearestNPCStationInfoSource)
      ? { nearestNPCStationInfoSource: entry.nearestNPCStationInfoSource }
      : {}),
    destinationID: normalizePositiveInt(entry.destinationID, 0) || null,
    destinationKind: entry.destinationKind ? String(entry.destinationKind) : null,
    deliveredAt: normalizeTimestampMs(entry.deliveredAt, null),
    ...(["pending", "committed"].includes(entry.deliveryNotificationStatus)
      ? { deliveryNotificationStatus: entry.deliveryNotificationStatus }
      : {}),
    autoMovedAt: normalizeTimestampMs(entry.autoMovedAt, null),
    assetSafetyDisabled: Boolean(entry.assetSafetyDisabled),
    sourceStructureSnapshot:
      entry.sourceStructureSnapshot && typeof entry.sourceStructureSnapshot === "object"
        ? cloneValue(entry.sourceStructureSnapshot)
        : null,
    collectionState: String(entry.collectionState || "ready") === "collecting"
      ? "collecting"
      : "ready",
    collectionNotificationStatus:
      String(entry.collectionNotificationStatus || "pending") === "committed"
        ? "committed"
        : "pending",
    collectionLegs,
    corporationDivisionVersion: entry.corporationDivisionVersion === 1 ? 1 : 0,
    deliverySaga,
    nextRecoveryGeneration: normalizePositiveInt(entry.nextRecoveryGeneration, 1),
    recoverySaga: entry.recoverySaga && typeof entry.recoverySaga === "object"
      ? cloneValue(entry.recoverySaga)
      : null,
  };
}

function ensureWrapCache() {
  if (wrapCache) {
    return wrapCache;
  }

  const payload = readWrapTable();
  const wraps = Array.isArray(payload.wraps)
    ? payload.wraps.map((entry) => normalizeWrapRecord(entry))
    : [];
  wrapCache = {
    meta: {
      nextWrapID: Math.max(
        NEXT_ASSET_WRAP_ID_START,
        normalizePositiveInt(payload._meta && payload._meta.nextWrapID, NEXT_ASSET_WRAP_ID_START),
      ),
      generatedAt: payload._meta && payload._meta.generatedAt ? String(payload._meta.generatedAt) : null,
      lastUpdatedAt: payload._meta && payload._meta.lastUpdatedAt ? String(payload._meta.lastUpdatedAt) : null,
    },
    wraps,
    byWrapID: new Map(wraps.map((wrap) => [wrap.assetWrapID, wrap])),
  };
  return wrapCache;
}

function persistWraps(wraps, metaOverrides = {}) {
  const normalizedWraps = wraps.map((wrap) => normalizeWrapRecord(wrap));
  const nextWrapID = Math.max(
    NEXT_ASSET_WRAP_ID_START,
    ...normalizedWraps.map((wrap) => normalizePositiveInt(wrap.assetWrapID, 0) + 1),
    NEXT_ASSET_WRAP_ID_START,
  );
  return writeWrapTable({
    _meta: {
      ...(ensureWrapCache().meta || {}),
      nextWrapID,
      lastUpdatedAt: new Date().toISOString(),
      ...metaOverrides,
    },
    wraps: normalizedWraps,
  });
}

function updateWrap(assetWrapID, updater) {
  const targetID = normalizePositiveInt(assetWrapID, 0);
  if (!targetID || typeof updater !== "function") {
    return {
      success: false,
      errorMsg: "WRAP_NOT_FOUND",
    };
  }

  const cache = ensureWrapCache();
  const current = cache.byWrapID.get(targetID);
  if (!current) {
    return {
      success: false,
      errorMsg: "WRAP_NOT_FOUND",
    };
  }

  const next = normalizeWrapRecord(updater(cloneValue(current)) || current);
  const writeResult = persistWraps(
    cache.wraps.map((wrap) => (wrap.assetWrapID === targetID ? next : wrap)),
  );
  // An ambiguous flush may already have prepared a saga in game-store memory.
  // Queue a flush-first reconciliation even though this caller must fail.
  if (writeResult.success || writeResult.ambiguous) {
    queueWrapScheduling(next.assetWrapID);
  }
  if (!writeResult.success) {
    return writeResult;
  }

  return {
    success: true,
    data: next,
  };
}

function createWrap(record) {
  const cache = ensureWrapCache();
  const assetWrapID = Math.max(NEXT_ASSET_WRAP_ID_START, cache.meta.nextWrapID || NEXT_ASSET_WRAP_ID_START);
  const next = normalizeWrapRecord({
    ...record,
    assetWrapID,
  });
  const writeResult = persistWraps([...cache.wraps, next], {
    nextWrapID: assetWrapID + 1,
    generatedAt: cache.meta.generatedAt || new Date().toISOString(),
  });
  // Do not strand an ambiguously committed new wrap until a read/restart.
  // The adapter flushes before deriving any job or exposing the new state.
  if (writeResult.success || writeResult.ambiguous) {
    queueWrapScheduling(next.assetWrapID);
  }
  if (!writeResult.success) {
    return writeResult;
  }

  return {
    success: true,
    data: next,
  };
}

function listWraps(options = {}) {
  if (options.refresh !== false) {
    tickAssetSafetyWraps(options.nowMs);
  }
  const includeDelivered = options.includeDelivered === true;
  return ensureWrapCache().wraps
    .filter((wrap) => includeDelivered || !wrap.deliveredAt)
    .map((wrap) => cloneValue(wrap));
}

function getWrapByID(assetWrapID, options = {}) {
  if (options.refresh !== false) {
    tickAssetSafetyWraps(options.nowMs);
  }
  return ensureWrapCache().byWrapID.get(normalizePositiveInt(assetWrapID, 0)) || null;
}

// Keep the personal API for its recovery caller; both owners project the same
// native type60 container from a durable delivered record.
function getDeliveredPersonalWrapItem(assetWrapID) {
  const wrap = getWrapByID(assetWrapID, { refresh: false });
  return wrap?.ownerKind === "char" ? getDeliveredWrapItem(assetWrapID) : null;
}

function getDeliveredWrapItem(assetWrapID) {
  const wrap = getWrapByID(assetWrapID, { refresh: false });
  if (!wrap || !wrap.deliveredAt ||
      (wrap.ownerKind === "corp" && wrap.corporationDivisionVersion !== 1) ||
      wrap.deliverySaga?.deliveryMode !== "wrapped" || !wrap.destinationID) {
    return null;
  }
  if (listContainerItems(wrap.ownerID, wrap.assetWrapID, null).length === 0) {
    return null;
  }
  const type = resolveItemByTypeID(ASSET_SAFETY_WRAP_TYPE_ID);
  if (!type) {
    return null;
  }
  return {
    itemID: wrap.assetWrapID,
    typeID: ASSET_SAFETY_WRAP_TYPE_ID,
    ownerID: wrap.ownerID,
    locationID: wrap.destinationID,
    flagID: ASSET_SAFETY_FLAG_ID,
    groupID: type.groupID,
    categoryID: type.categoryID,
    quantity: -1,
    stacksize: 1,
    singleton: 1,
    itemName: wrap.wrapName,
    customInfo: "",
  };
}

function setWrapRecoveryState(assetWrapID, operation, nextGeneration = null) {
  return updateWrap(assetWrapID, (wrap) => ({
    ...wrap,
    recoverySaga: cloneValue(operation),
    nextRecoveryGeneration: nextGeneration === null
      ? wrap.nextRecoveryGeneration
      : normalizePositiveInt(nextGeneration, wrap.nextRecoveryGeneration),
  }));
}

function getWrapNames(wrapIDs = []) {
  return Object.fromEntries(
    (Array.isArray(wrapIDs) ? wrapIDs : [wrapIDs])
      .map((wrapID) => normalizePositiveInt(wrapID, 0))
      .filter(Boolean)
      .map((wrapID) => {
        const wrap = getWrapByID(wrapID);
        return [wrapID, wrap ? wrap.wrapName : null];
      }),
  );
}

function listWrapsForOwner(ownerKind, ownerID, options = {}) {
  const normalizedOwnerKind = String(ownerKind || "char").trim().toLowerCase() === "corp"
    ? "corp"
    : "char";
  const normalizedOwnerID = normalizePositiveInt(ownerID, 0);
  if (!normalizedOwnerID) {
    return [];
  }

  return listWraps(options).filter(
    (wrap) =>
      wrap.ownerKind === normalizedOwnerKind &&
      normalizePositiveInt(wrap.ownerID, 0) === normalizedOwnerID,
  );
}

function getSessionCharacterID(session) {
  return normalizePositiveInt(
    session && (session.characterID || session.charid || session.userid),
    0,
  );
}

function getSessionCorporationID(session) {
  return normalizePositiveInt(
    session && (session.corporationID || session.corpid),
    0,
  );
}

function sessionCanManageWrap(session, wrap) {
  if (!wrap) {
    return false;
  }
  const structureState = require(path.join(__dirname, "./structureState"));
  if (structureState.hasStructureGmBypass(session)) {
    return true;
  }

  return (
    (wrap.ownerKind === "char" && wrap.ownerID === getSessionCharacterID(session)) ||
    (wrap.ownerKind === "corp" && sessionCanManageCorporationSafety(session, wrap.ownerID))
  );
}

function sessionCanManageCorporationSafety(session, corporationID = getSessionCorporationID(session)) {
  if (!corporationID || Number(corporationID) !== getSessionCorporationID(session)) return false;
  if (getStructureState().hasStructureGmBypass(session)) return true;
  const authority = require("../corporation/corporationAuthority").getPersistedCorporationAuthority(session);
  return Boolean(authority && authority.corporationID === Number(corporationID) &&
    (authority.isDirector || authority.isCEO));
}

function getFallbackNpcStationInfo(solarSystemID) {
  const isUsableSystem = (system) => Boolean(
    system &&
    typeof system.security === "number" && Number.isFinite(system.security) &&
    system.position && ["x", "y", "z"].every(
      (axis) => typeof system.position[axis] === "number" &&
        Number.isFinite(system.position[axis]),
    ) &&
    !isAssetSafetyDisabledSolarSystem(system.solarSystemID),
  );
  const origin = worldData.getSolarSystemByID(normalizePositiveInt(solarSystemID, 0));
  if (!isUsableSystem(origin)) {
    return null;
  }

  // CCP Support Asset Safety selects the nearest qualifying SYSTEM by AU:
  // high -> high (including native Safe class 3); low/null -> low. The NPC
  // station table supplies candidates; station-local positions are unrelated.
  const needsHighSecurity = isHighSecuritySystem(origin);
  let nearest = null;
  let nearestDistance = Infinity;
  for (const station of getStaticStations()) {
    const target = worldData.getSolarSystemByID(station.solarSystemID);
    if (!isUsableSystem(target) || !(needsHighSecurity
      ? isHighSecuritySystem(target)
      : isLowSecuritySystem(target))) {
      continue;
    }
    const distance = Math.hypot(
      target.position.x - origin.position.x,
      target.position.y - origin.position.y,
      target.position.z - origin.position.z,
    );
    // AU conversion is monotonic. Exact distance ties and station choice within
    // one system use IDs for determinism; no captured TQ tie rule is available.
    if (Number.isFinite(distance) && (
      distance < nearestDistance ||
      (distance === nearestDistance && nearest && (
        station.solarSystemID < nearest.solarSystemID ||
        (station.solarSystemID === nearest.solarSystemID && station.itemID < nearest.itemID)
      ))
    )) {
      nearest = station;
      nearestDistance = distance;
    }
  }
  return nearest ? cloneValue(nearest) : null;
}

// Only for recognizing pre-distance snapshots. Unmatched legacy values may be
// explicit overrides, so the repair below must not replace them.
function getLegacyFallbackNpcStationInfo(solarSystemID) {
  const stations = getStaticStations();
  if (stations.length === 0) {
    return null;
  }

  const numericSystemID = normalizePositiveInt(solarSystemID, 0);
  const systemRecord = worldData.getSolarSystemByID(numericSystemID);
  const sameSystem = stations.find((station) => station.solarSystemID === numericSystemID);
  if (sameSystem) {
    return cloneValue(sameSystem);
  }

  if (systemRecord) {
    const sameConstellation = stations.find(
      (station) =>
        normalizePositiveInt(station.constellationID, 0) > 0 &&
        station.constellationID === normalizePositiveInt(systemRecord.constellationID, 0),
    );
    if (sameConstellation) {
      return cloneValue(sameConstellation);
    }

    const sameRegion = stations.find(
      (station) =>
        normalizePositiveInt(station.regionID, 0) > 0 &&
        station.regionID === normalizePositiveInt(systemRecord.regionID, 0),
    );
    if (sameRegion) {
      return cloneValue(sameRegion);
    }
  }

  return cloneValue(stations[0]);
}

function repairPendingWrapFallback(wrap) {
  const needsFlushRetry = wrap && pendingFallbackRepairFlushes.has(wrap.assetWrapID);
  // Never change an in-flight, ambiguous, completed, delivered, or manually
  // selected destination. A saga of ANY status is authoritative here.
  if (!wrap || wrap.deliveredAt || wrap.autoMovedAt || wrap.destinationID ||
      wrap.destinationKind || wrap.deliverySaga || wrap.recoverySaga ||
      wrap.assetSafetyDisabled || (wrap.nearestNPCStationInfoSource && !needsFlushRetry)) {
    return { success: true, data: wrap };
  }
  const legacy = getLegacyFallbackNpcStationInfo(wrap.solarSystemID);
  if (!needsFlushRetry && wrap.nearestNPCStationInfo &&
      wrap.nearestNPCStationInfo.itemID !== (legacy && legacy.itemID)) {
    return { success: true, data: wrap };
  }
  // Historical overrides identical to the old calculation cannot be identified:
  // old records did not persist provenance. New overrides are explicitly marked.
  const nearestNPCStationInfo = getFallbackNpcStationInfo(wrap.solarSystemID);
  // A failed flush can leave the new marker in the game-store memory cache.
  // Retry the durable write before permitting delivery in this process.
  pendingFallbackRepairFlushes.add(wrap.assetWrapID);
  const result = updateWrap(wrap.assetWrapID, (current) => ({
    ...current,
    nearestNPCStationInfo,
    nearestNPCStationInfoSource: "distance-v1",
  }));
  if (result.success) {
    pendingFallbackRepairFlushes.delete(wrap.assetWrapID);
  }
  return result;
}

function isAssetSafetyDisabledSolarSystem(solarSystemID) {
  const numericSystemID = normalizePositiveInt(solarSystemID, 0);
  const systemRecord = worldData.getSolarSystemByID(numericSystemID);
  if (!systemRecord) {
    return false;
  }

  if (numericSystemID >= 31000000) {
    return true;
  }

  if (normalizePositiveInt(systemRecord.regionID, 0) === 10000070) {
    return true;
  }

  return /^J\d+/i.test(String(systemRecord.solarSystemName || "").trim());
}

function isAssetSafetyDisabledForStructure(structure) {
  if (!structure || typeof structure !== "object") {
    return false;
  }
  const preset = STRUCTURE_TYPE_PRESETS[
    normalizePositiveInt(structure.typeID, 0)
  ] || null;
  return Boolean(
    (preset && preset.family === STRUCTURE_FAMILY.FLEX) ||
    isAssetSafetyDisabledSolarSystem(structure.solarSystemID)
  );
}

function getWrapUnlockTimeMs(wrap) {
  return normalizeTimestampMs(wrap && wrap.ejectTimeMs, 0) + DAYS_UNTIL_CAN_DELIVER * DAY_MS;
}

function getWrapAutoMoveTimeMs(wrap) {
  return normalizeTimestampMs(wrap && wrap.ejectTimeMs, 0) + DAYS_UNTIL_AUTO_MOVE * DAY_MS;
}

function listTopLevelStructureItems(ownerID, structureID, options = {}) {
  const excludedItemIDs = new Set(
    (Array.isArray(options.excludeItemIDs) ? options.excludeItemIDs : [])
      .map((itemID) => normalizePositiveInt(itemID, 0))
      .filter(Boolean),
  );

  return listContainerItems(normalizePositiveInt(ownerID, 0), normalizePositiveInt(structureID, 0), null)
    .filter((item) => item && !excludedItemIDs.has(normalizePositiveInt(item.itemID, 0)));
}

function getOwnerKindForAssetSafety(ownerID) {
  const numericOwnerID = normalizePositiveInt(ownerID, 0);
  return numericOwnerID >= 140000000 && numericOwnerID < 200000000
    ? "char"
    : "corp";
}

function isStructureHangarAssetItem(item) {
  const flagID = normalizePositiveInt(item && item.flagID, 0);
  return (
    STRUCTURE_RECOVERABLE_ASSET_FLAGS.has(flagID) ||
    CORPORATION_HANGAR_FLAGS.has(flagID) ||
    STRUCTURE_DELIVERY_FLAGS.has(flagID)
  );
}

function listTopLevelStructureHangarItems(ownerID, structureID, options = {}) {
  return listTopLevelStructureItems(ownerID, structureID, options)
    .filter(isStructureHangarAssetItem);
}

function listTopLevelCorporationOfficeItems(corporationID, office) {
  const numericCorporationID = normalizePositiveInt(corporationID, 0);
  if (!numericCorporationID || !office || typeof office !== "object") {
    return [];
  }

  const officeLocationIDs = [
    office.officeID,
    office.officeFolderID,
    office.itemID,
  ]
    .map((locationID) => normalizePositiveInt(locationID, 0))
    .filter(Boolean);
  const seenItemIDs = new Set();
  const items = [];
  for (const locationID of officeLocationIDs) {
    for (const item of listContainerItems(numericCorporationID, locationID, null)) {
      const itemID = normalizePositiveInt(item && item.itemID, 0);
      if (!itemID || seenItemIDs.has(itemID)) {
        continue;
      }
      seenItemIDs.add(itemID);
      items.push(item);
    }
  }
  return items;
}

function buildOfficeEjectContainerName(structure) {
  const structureName = String(
    structure && (structure.itemName || structure.name || `Structure ${structure.structureID}`),
  );
  return `${structureName} Office Assets`;
}

function buildStructureEjectContainerName(structure) {
  const structureName = String(
    structure && (structure.itemName || structure.name || `Structure ${structure.structureID}`),
  );
  return `${structureName} Asset Safety Container`;
}

function buildStructureDecommissionContainerName(structure) {
  const structureName = String(
    structure && (structure.itemName || structure.name || `Structure ${structure.structureID}`),
  );
  return `${structureName} Decommissioned Fittings`;
}

function buildStructureUnanchorHullMarker(structureID) {
  return `${STRUCTURE_UNANCHOR_ARTIFACT_PREFIX}:hull:${structureID}`;
}

function buildStructureUnanchorFittingsMarker(structureID, coreComplete = false) {
  const marker = `${STRUCTURE_UNANCHOR_ARTIFACT_PREFIX}:fittings:${structureID}`;
  return coreComplete ? `${marker}:core-complete` : marker;
}

function buildStructureUnanchorAssetsMarker(structureID, ownerID) {
  return (
    `${STRUCTURE_UNANCHOR_ARTIFACT_PREFIX}:assets:${structureID}:owner:${ownerID}`
  );
}

function buildStructureUnanchorOfficeMarker(structureID, officeID) {
  return (
    `${STRUCTURE_UNANCHOR_ARTIFACT_PREFIX}:office:${structureID}:office:${officeID}`
  );
}

function normalizeAllInventoryItems() {
  const items = getAllItems();
  return (Array.isArray(items) ? items : Object.values(items || {}))
    .filter(Boolean)
    .sort(
      (left, right) =>
        normalizePositiveInt(left && left.itemID, 0) -
        normalizePositiveInt(right && right.itemID, 0),
    );
}

function isCanonicalStructureUnanchorSpaceArtifact(
  item,
  structure,
  ownerID,
) {
  const solarSystemID = normalizePositiveInt(
    structure && structure.solarSystemID,
    0,
  );
  return Boolean(
    item &&
    normalizePositiveInt(item.ownerID, 0) ===
      normalizePositiveInt(ownerID, 0) &&
    normalizePositiveInt(item.locationID, 0) === solarSystemID &&
    normalizeInt(item.flagID, -1) === 0 &&
    item.spaceState &&
    normalizePositiveInt(item.spaceState.systemID, 0) === solarSystemID
  );
}

function findStructureUnanchorHull(
  structure,
  allItems,
  hullMarker,
) {
  const structureID = normalizePositiveInt(structure && structure.structureID, 0);
  const structureTypeID = normalizePositiveInt(structure && structure.typeID, 0);
  return allItems.find(
    (item) =>
      normalizePositiveInt(item && item.typeID, 0) === structureTypeID &&
      normalizePositiveInt(item && item.categoryID, 0) === CATEGORY_STRUCTURE &&
      normalizePositiveInt(item && item.launcherID, 0) === structureID &&
      normalizeInt(item && item.singleton, 0) === 1 &&
      String(item && item.customInfo || "") === hullMarker,
  ) || null;
}

function findStructureUnanchorFittingsContainers(
  structure,
  ownerID,
  allItems,
  fittingsMarker,
  coreCompleteMarker,
) {
  const structureID = normalizePositiveInt(structure && structure.structureID, 0);
  const solarSystemID = normalizePositiveInt(structure && structure.solarSystemID, 0);
  const legacyName = buildStructureDecommissionContainerName(structure);
  return allItems
    .filter((item) => {
      if (
        normalizePositiveInt(item && item.typeID, 0) !== OFFICE_EJECT_CONTAINER_TYPE_ID ||
        normalizePositiveInt(item && item.launcherID, 0) !== structureID ||
        normalizeInt(item && item.singleton, 0) !== 1
      ) {
        return false;
      }
      const customInfo = String(item && item.customInfo || "");
      if (customInfo === fittingsMarker || customInfo === coreCompleteMarker) {
        return true;
      }
      return (
        normalizePositiveInt(item && item.ownerID, 0) === ownerID &&
        normalizePositiveInt(item && item.locationID, 0) === solarSystemID &&
        normalizeInt(item && item.flagID, -1) === 0 &&
        String(item && item.itemName || "") === legacyName
      );
    })
    .sort((left, right) => {
      const leftMarked = [
        fittingsMarker,
        coreCompleteMarker,
      ].includes(String(left && left.customInfo || ""));
      const rightMarked = [
        fittingsMarker,
        coreCompleteMarker,
      ].includes(String(right && right.customInfo || ""));
      if (leftMarked !== rightMarked) {
        return leftMarked ? -1 : 1;
      }
      return (
        normalizePositiveInt(left && left.itemID, 0) -
        normalizePositiveInt(right && right.itemID, 0)
      );
    });
}

function findStructureUnanchorEjectContainer(
  structure,
  ownerID,
  allItems,
  marker,
) {
  const structureID = normalizePositiveInt(structure && structure.structureID, 0);
  const markedItems = allItems.filter(
    (item) => String(item && item.customInfo || "") === marker,
  );
  const matchingItems = markedItems.filter(
    (item) =>
      normalizePositiveInt(item && item.typeID, 0) ===
        OFFICE_EJECT_CONTAINER_TYPE_ID &&
      normalizePositiveInt(item && item.launcherID, 0) === structureID &&
      normalizeInt(item && item.singleton, 0) === 1 &&
      isCanonicalStructureUnanchorSpaceArtifact(
        item,
        structure,
        ownerID,
      ),
  );
  if (markedItems.length > 1 || markedItems.length !== matchingItems.length) {
    return {
      success: false,
      errorMsg: "INVALID_STRUCTURE_UNANCHOR_EJECT_ARTIFACT",
      data: null,
    };
  }
  return {
    success: true,
    data: matchingItems[0] || null,
  };
}

function isStructureRigSlotItem(item) {
  return STRUCTURE_RIG_SLOT_FLAGS.has(normalizePositiveInt(item && item.flagID, 0));
}

function isStructureAttachedItemForUnanchor(item) {
  return STRUCTURE_ATTACHED_ITEM_FLAGS.has(normalizePositiveInt(item && item.flagID, 0));
}

function msToFiletimeLong(value) {
  const timestampMs = normalizeTimestampMs(value, Date.now()) || Date.now();
  return {
    type: "long",
    value: String(BigInt(timestampMs) * FILETIME_TICKS_PER_MS + FILETIME_EPOCH_OFFSET),
  };
}

function durationMsToLong(value) {
  const durationMs = Math.max(0, normalizeInt(value, 0));
  return {
    type: "long",
    value: String(BigInt(durationMs) * FILETIME_TICKS_PER_MS),
  };
}

function buildAssetSafetyMovedNotificationData(structure, wrap) {
  const structureID = normalizePositiveInt(structure && structure.structureID, 0);
  const structureTypeID = normalizePositiveInt(structure && structure.typeID, 0);
  const solarSystemID = normalizePositiveInt(structure && structure.solarSystemID, 0);
  const structureName = String(
    structure && (structure.itemName || structure.name || `Structure ${structureID}`),
  );
  const minimumDurationMs = DAYS_UNTIL_CAN_DELIVER * DAY_MS;
  const fullDurationMs = DAYS_UNTIL_AUTO_MOVE * DAY_MS;
  const ejectTimeMs = normalizeTimestampMs(wrap && wrap.ejectTimeMs, Date.now()) || Date.now();
  return {
    structureID,
    structureShowInfoData: ["showinfo", structureTypeID, structureID],
    solarsystemID: solarSystemID,
    structureTypeID,
    assetSafetyDurationMinimum: durationMsToLong(minimumDurationMs),
    assetSafetyMinimumTimestamp: msToFiletimeLong(ejectTimeMs + minimumDurationMs),
    assetSafetyDurationFull: durationMsToLong(fullDurationMs),
    assetSafetyFullTimestamp: msToFiletimeLong(ejectTimeMs + fullDurationMs),
    isCorpOwned: wrap && wrap.ownerKind === "corp",
    structureLink: `<a href="showinfo:${structureTypeID}//${structureID}">${structureName}</a>`,
    newStationID:
      normalizePositiveInt(
        wrap && wrap.nearestNPCStationInfo && wrap.nearestNPCStationInfo.itemID,
        0,
      ) || null,
  };
}

function buildStructureItemsNeedAttentionNotificationData(structure) {
  const structureID = normalizePositiveInt(structure && structure.structureID, 0);
  const structureTypeID = normalizePositiveInt(structure && structure.typeID, 0);
  const solarSystemID = normalizePositiveInt(structure && structure.solarSystemID, 0);
  return {
    structureID,
    structureShowInfoData: ["showinfo", structureTypeID, structureID],
    solarsystemID: solarSystemID,
    structureTypeID,
  };
}

function collectAssetSafetyNotificationRecipients(wrap) {
  if (!wrap) {
    return [];
  }
  const ownerID = normalizePositiveInt(wrap.ownerID, 0);
  if (!ownerID) {
    return [];
  }
  if (wrap.ownerKind === "corp") {
    return [...new Set(getCharacterIDsInCorporation(ownerID))];
  }
  return [ownerID];
}

function collectStructureOwnerNotificationRecipients(ownerID) {
  const numericOwnerID = normalizePositiveInt(ownerID, 0);
  if (!numericOwnerID) {
    return [];
  }
  if (getOwnerKindForAssetSafety(numericOwnerID) === "corp") {
    return [...new Set(getCharacterIDsInCorporation(numericOwnerID))];
  }
  return [numericOwnerID];
}

function createAssetSafetyMovedNotifications(structure, wrap) {
  const recipients = collectAssetSafetyNotificationRecipients(wrap);
  if (recipients.length <= 0) {
    return { success: true, count: 0 };
  }
  const senderID = normalizePositiveInt(
    structure && (structure.ownerCorpID || structure.ownerID),
    0,
  );
  const data = buildAssetSafetyMovedNotificationData(structure, wrap);
  let createdCount = 0;
  for (const characterID of recipients) {
    const result = createNotification(characterID, {
      typeID: NOTIFICATION_TYPE.STRUCTURE_ITEMS_TO_ASSET_SAFETY,
      senderID,
      groupID: NOTIFICATION_GROUP.STRUCTURES,
      processed: false,
      idempotencyKey: `asset-safety:${wrap.assetWrapID}:moved:${characterID}`,
      data,
      emitLive: false,
    });
    if (!result || result.success !== true) {
      log.warn(
        `[StructureAssetSafety] Failed to create asset-safety notification ` +
        `structure=${data.structureID} wrap=${wrap.assetWrapID} ` +
        `character=${characterID}: ${result && result.errorMsg ? result.errorMsg : "UNKNOWN"}`,
      );
      return result || { success: false, errorMsg: "NOTIFICATION_WRITE_FAILED" };
    }
    createdCount += 1;
  }
  const flushResult = database.flushTableSync("notifications");
  return flushResult && flushResult.success
    ? { success: true, count: createdCount }
    : {
        success: false,
        ambiguous: true,
        errorMsg: flushResult && flushResult.errorMsg || "NOTIFICATION_FLUSH_FAILED",
      };
}

function createStructureItemsNeedAttentionNotifications(structure, ownerID) {
  const recipients = collectStructureOwnerNotificationRecipients(ownerID);
  if (recipients.length <= 0) {
    return;
  }
  const senderID = normalizePositiveInt(
    structure && (structure.ownerCorpID || structure.ownerID),
    0,
  );
  const data = buildStructureItemsNeedAttentionNotificationData(structure);
  for (const characterID of recipients) {
    const result = createNotification(characterID, {
      typeID: NOTIFICATION_TYPE.STRUCTURE_ITEMS_NEED_ATTENTION,
      senderID,
      groupID: NOTIFICATION_GROUP.STRUCTURES,
      processed: false,
      data,
      emitLive: false,
    });
    if (!result || result.success !== true) {
      log.warn(
        `[StructureAssetSafety] Failed to create items-need-attention notification ` +
        `structure=${data.structureID} owner=${ownerID} ` +
        `character=${characterID}: ${result && result.errorMsg ? result.errorMsg : "UNKNOWN"}`,
      );
    }
  }
}

function ejectStructureAssetsToSpace(ownerID, structure, items, index, options = {}) {
  const numericOwnerID = normalizePositiveInt(ownerID, 0);
  const solarSystemID = normalizePositiveInt(structure && structure.solarSystemID, 0);
  const structureItems = Array.isArray(items) ? items : [];
  if (!numericOwnerID || !solarSystemID) {
    return {
      success: false,
      errorMsg: "STRUCTURE_NOT_FOUND",
    };
  }
  if (structureItems.length === 0) {
    return {
      success: true,
      data: {
        ejectedContainer: null,
        movedItemIDs: [],
      },
    };
  }

  const containerType = resolveItemByTypeID(OFFICE_EJECT_CONTAINER_TYPE_ID);
  if (!containerType) {
    return {
      success: false,
      errorMsg: "DROP_CONTAINER_TYPE_NOT_FOUND",
    };
  }

  const structureID = normalizePositiveInt(structure && structure.structureID, 0);
  const marker = buildStructureUnanchorAssetsMarker(
    structureID,
    numericOwnerID,
  );
  const existingContainerResult = findStructureUnanchorEjectContainer(
    structure,
    numericOwnerID,
    normalizeAllInventoryItems(),
    marker,
  );
  if (!existingContainerResult.success) {
    return existingContainerResult;
  }
  let container = existingContainerResult.data;
  if (!container) {
    const position = buildStructureScatterPosition(structure, index, options);
    const createContainerResult = createSpaceItemForOwner(
      numericOwnerID,
      solarSystemID,
      containerType,
      {
        itemName: buildStructureEjectContainerName(structure),
        position,
        direction: getStructureSpaceDirection(structure),
        targetPoint: position,
        createdAtMs: options.nowMs ?? Date.now(),
        launcherID: structureID,
        customInfo: marker,
      },
    );
    if (!createContainerResult.success || !createContainerResult.data) {
      return createContainerResult;
    }
    container = createContainerResult.data;
  }

  const movedItemIDs = [];
  for (const item of structureItems) {
    const itemID = normalizePositiveInt(item && item.itemID, 0);
    if (!itemID) {
      continue;
    }
    const moveResult = deliveryItemCustody.transferItem({
      item,
      locationID: container.itemID,
      flagID: ITEM_FLAGS.HANGAR,
      actor: numericOwnerID,
      reason: itemCustody.CUSTODY_REASON.STRUCTURE_UNANCHOR_HANDOFF,
    });
    if (!moveResult.success) {
      log.warn(
        `[StructureAssetSafety] Failed to eject structure item ${itemID} into container ${container.itemID}: ${moveResult.errorMsg}`,
      );
      if (movedItemIDs.length > 0) {
        createStructureItemsNeedAttentionNotifications(
          structure,
          numericOwnerID,
        );
      }
      return {
        ...moveResult,
        data: {
          ejectedContainer: findItemById(container.itemID) || container,
          movedItemIDs,
        },
      };
    }
    movedItemIDs.push(itemID);
  }

  if (movedItemIDs.length > 0) {
    createStructureItemsNeedAttentionNotifications(structure, numericOwnerID);
  }

  return {
    success: true,
    data: {
      ejectedContainer: findItemById(container.itemID) || container,
      movedItemIDs,
    },
  };
}

function handOffStructureAttachedItemsForUnanchor(structure, options = {}) {
  const structureID = normalizePositiveInt(structure && structure.structureID, 0);
  const solarSystemID = normalizePositiveInt(structure && structure.solarSystemID, 0);
  const ownerID = normalizePositiveInt(
    structure && (structure.ownerCorpID || structure.ownerID),
    0,
  );
  if (!structureID || !solarSystemID || !ownerID) {
    return {
      success: false,
      errorMsg: "STRUCTURE_NOT_FOUND",
    };
  }

  const structureType = resolveItemByTypeID(structure.typeID);
  if (!structureType) {
    return {
      success: false,
      errorMsg: "STRUCTURE_HULL_TYPE_NOT_FOUND",
    };
  }
  if (
    normalizePositiveInt(structureType.categoryID, 0) !== CATEGORY_STRUCTURE
  ) {
    return {
      success: false,
      errorMsg: "STRUCTURE_HULL_TYPE_NOT_STRUCTURE",
    };
  }

  const topLevelItems = listContainerItems(null, structureID, null)
    .filter((item) => normalizePositiveInt(item && item.locationID, 0) === structureID);
  const rigItems = topLevelItems.filter(isStructureRigSlotItem);
  const attachedItems = topLevelItems.filter((item) =>
    !isStructureRigSlotItem(item) && isStructureAttachedItemForUnanchor(item),
  );
  const quantumCoreItemTypeID = normalizePositiveInt(
    structure && structure.quantumCoreItemTypeID,
    0,
  );
  const existingTopLevelCoreItem = attachedItems.find(
    (item) =>
      normalizePositiveInt(item && item.flagID, 0) === ITEM_FLAGS.STRUCTURE_DEED &&
      normalizeInt(item && item.singleton, 0) === 1 &&
      normalizePositiveInt(item && item.typeID, 0) ===
        quantumCoreItemTypeID,
  );
  const allItems = normalizeAllInventoryItems();
  const hullMarker = buildStructureUnanchorHullMarker(structureID);
  const fittingsMarker = buildStructureUnanchorFittingsMarker(structureID);
  const coreCompleteMarker = buildStructureUnanchorFittingsMarker(structureID, true);
  const markedHullArtifacts = allItems.filter(
    (item) => String(item && item.customInfo || "") === hullMarker,
  );
  const markedFittingsArtifacts = allItems.filter((item) =>
    [fittingsMarker, coreCompleteMarker].includes(
      String(item && item.customInfo || ""),
    ));
  const validMarkedFittingsArtifacts = markedFittingsArtifacts.filter(
    (item) =>
      normalizePositiveInt(item && item.typeID, 0) ===
        OFFICE_EJECT_CONTAINER_TYPE_ID &&
      normalizePositiveInt(item && item.launcherID, 0) === structureID &&
      normalizeInt(item && item.singleton, 0) === 1,
  );
  let unanchoredHull = findStructureUnanchorHull(
    structure,
    allItems,
    hullMarker,
  );
  if (
    markedHullArtifacts.length > 1 ||
    (
      markedHullArtifacts.length === 1 &&
      !unanchoredHull
    )
  ) {
    return {
      success: false,
      errorMsg: "INVALID_STRUCTURE_UNANCHOR_HULL_ARTIFACT",
    };
  }
  if (
    markedFittingsArtifacts.length > 1 ||
    markedFittingsArtifacts.length !== validMarkedFittingsArtifacts.length
  ) {
    return {
      success: false,
      errorMsg: "INVALID_STRUCTURE_UNANCHOR_FITTINGS_ARTIFACT",
    };
  }
  const existingFittingsContainers = findStructureUnanchorFittingsContainers(
    structure,
    ownerID,
    allItems,
    fittingsMarker,
    coreCompleteMarker,
  );
  if (existingFittingsContainers.length > 1) {
    return {
      success: false,
      errorMsg: "INVALID_STRUCTURE_UNANCHOR_FITTINGS_ARTIFACT",
    };
  }
  let decommissionContainer = existingFittingsContainers[0] || null;
  const fittingsContainerIDs = new Set(
    existingFittingsContainers.map((item) =>
      normalizePositiveInt(item && item.itemID, 0),
    ),
  );
  const existingContainedCoreItem = quantumCoreItemTypeID > 0
    ? allItems.find(
      (item) =>
        fittingsContainerIDs.has(normalizePositiveInt(item && item.locationID, 0)) &&
        normalizePositiveInt(item && item.flagID, 0) === ITEM_FLAGS.HANGAR &&
        normalizeInt(item && item.singleton, 0) === 1 &&
        normalizePositiveInt(item && item.typeID, 0) === quantumCoreItemTypeID,
    )
    : null;
  const coreCompletionRecorded = existingFittingsContainers.some(
    (item) => String(item && item.customInfo || "") === coreCompleteMarker,
  );
  const requiresQuantumCore =
    structure &&
    structure.hasQuantumCore === true &&
    quantumCoreItemTypeID > 0;
  const shouldCreateCore =
    requiresQuantumCore &&
    !existingTopLevelCoreItem &&
    !existingContainedCoreItem &&
    !coreCompletionRecorded;
  const needsFittingsContainer = attachedItems.length > 0 || shouldCreateCore;
  const trackedStructure = require(path.join(__dirname, "./structureState"))
    .getStructureByID(structureID, { refresh: false });
  if (
    trackedStructure &&
    unanchoredHull &&
    !isCanonicalStructureUnanchorSpaceArtifact(
      unanchoredHull,
      structure,
      ownerID,
    )
  ) {
    return {
      success: false,
      errorMsg: "INVALID_STRUCTURE_UNANCHOR_HULL_ARTIFACT",
    };
  }
  if (
    trackedStructure &&
    decommissionContainer &&
    !isCanonicalStructureUnanchorSpaceArtifact(
      decommissionContainer,
      structure,
      ownerID,
    )
  ) {
    return {
      success: false,
      errorMsg: "INVALID_STRUCTURE_UNANCHOR_FITTINGS_ARTIFACT",
    };
  }

  let containerType = null;
  if (!decommissionContainer && needsFittingsContainer) {
    containerType = resolveItemByTypeID(OFFICE_EJECT_CONTAINER_TYPE_ID);
    if (!containerType) {
      return {
        success: false,
        errorMsg: "DROP_CONTAINER_TYPE_NOT_FOUND",
      };
    }
  }

  let coreType = null;
  if (shouldCreateCore) {
    coreType = resolveItemByTypeID(quantumCoreItemTypeID);
    if (!coreType) {
      return {
        success: false,
        errorMsg: "QUANTUM_CORE_TYPE_NOT_FOUND",
      };
    }
  }

  if (
    decommissionContainer &&
    ![fittingsMarker, coreCompleteMarker].includes(
      String(decommissionContainer.customInfo || ""),
    )
  ) {
    const adoptLegacyContainerResult = updateInventoryItem(
      decommissionContainer.itemID,
      (current) => ({
        ...current,
        customInfo: fittingsMarker,
      }),
    );
    if (!adoptLegacyContainerResult.success) {
      return adoptLegacyContainerResult;
    }
    decommissionContainer = adoptLegacyContainerResult.data;
  }

  const hullWasCreated = !unanchoredHull;
  if (!unanchoredHull) {
    const position = structure.position || { x: 0, y: 0, z: 0 };
    const createHullResult = createSpaceItemForOwner(
      ownerID,
      solarSystemID,
      structureType,
      {
        itemName:
          structure.itemName ||
          structure.name ||
          structureType.name ||
          `Structure ${structureID}`,
        position,
        direction: getStructureSpaceDirection(structure),
        targetPoint: position,
        createdAtMs: options.nowMs ?? Date.now(),
        launcherID: structureID,
        customInfo: hullMarker,
      },
    );
    if (!createHullResult.success || !createHullResult.data) {
      return createHullResult;
    }
    unanchoredHull = createHullResult.data;
  }

  if (!decommissionContainer && needsFittingsContainer) {
    const position = buildStructureScatterPosition(structure, 0, options);
    const createContainerResult = createSpaceItemForOwner(
      ownerID,
      solarSystemID,
      containerType,
      {
        itemName: buildStructureDecommissionContainerName(structure),
        position,
        direction: getStructureSpaceDirection(structure),
        targetPoint: position,
        createdAtMs: options.nowMs ?? Date.now(),
        launcherID: structureID,
        customInfo: fittingsMarker,
      },
    );
    if (!createContainerResult.success || !createContainerResult.data) {
      return createContainerResult;
    }
    decommissionContainer = createContainerResult.data;
  }

  const movedItemIDs = [];
  for (const item of attachedItems) {
    const itemID = normalizePositiveInt(item && item.itemID, 0);
    if (!itemID) {
      continue;
    }
    const moveResult = deliveryItemCustody.transferItem({
      item,
      locationID: decommissionContainer.itemID,
      flagID: ITEM_FLAGS.HANGAR,
      actor: ownerID,
      reason: itemCustody.CUSTODY_REASON.STRUCTURE_UNANCHOR_HANDOFF,
    });
    if (!moveResult.success) {
      return moveResult;
    }
    movedItemIDs.push(itemID);
  }

  let createdCoreItemID = null;
  if (shouldCreateCore) {
    const coreGrantResult = grantItemToOwnerLocation(
      ownerID,
      decommissionContainer.itemID,
      ITEM_FLAGS.HANGAR,
      coreType,
      1,
      {
        itemName: coreType.name,
        singleton: 1,
      },
    );
    if (!coreGrantResult.success) {
      return coreGrantResult;
    }
    const coreItem =
      coreGrantResult.data &&
      Array.isArray(coreGrantResult.data.items) &&
      coreGrantResult.data.items[0];
    createdCoreItemID = normalizePositiveInt(coreItem && coreItem.itemID, 0);
    if (createdCoreItemID) {
      movedItemIDs.push(createdCoreItemID);
    }
  }

  const completedCoreItemID =
    createdCoreItemID ||
    normalizePositiveInt(existingTopLevelCoreItem && existingTopLevelCoreItem.itemID, 0) ||
    normalizePositiveInt(existingContainedCoreItem && existingContainedCoreItem.itemID, 0) ||
    null;
  const quantumCoreHandoffComplete =
    requiresQuantumCore &&
    (Boolean(completedCoreItemID) || coreCompletionRecorded);
  if (
    decommissionContainer &&
    quantumCoreHandoffComplete &&
    String(decommissionContainer.customInfo || "") !== coreCompleteMarker
  ) {
    const markCoreCompleteResult = updateInventoryItem(
      decommissionContainer.itemID,
      (current) => ({
        ...current,
        customInfo: coreCompleteMarker,
      }),
    );
    if (!markCoreCompleteResult.success) {
      return markCoreCompleteResult;
    }
    decommissionContainer = markCoreCompleteResult.data;
  }

  return {
    success: true,
    data: {
      unanchoredHull: findItemById(unanchoredHull.itemID) || unanchoredHull,
      hull: {
        created: hullWasCreated,
        itemID: normalizePositiveInt(unanchoredHull && unanchoredHull.itemID, 0),
      },
      decommissionContainer: decommissionContainer
        ? findItemById(decommissionContainer.itemID) || decommissionContainer
        : null,
      movedItemIDs,
      destroyedRigItemIDs: [],
      pendingRigItemIDs: rigItems
        .map((item) => normalizePositiveInt(item && item.itemID, 0))
        .filter(Boolean),
      quantumCore: {
        movedExisting: Boolean(existingTopLevelCoreItem),
        created: Boolean(createdCoreItemID),
        itemID: completedCoreItemID,
      },
    },
  };
}

function ejectCorporationOfficeAssetsToSpace(corporationID, structure, office, items, options = {}) {
  const corpID = normalizePositiveInt(corporationID, 0);
  const solarSystemID = normalizePositiveInt(structure && structure.solarSystemID, 0);
  const officeItems = Array.isArray(items) ? items : [];
  if (!corpID || !solarSystemID) {
    return {
      success: false,
      errorMsg: "STRUCTURE_NOT_FOUND",
    };
  }
  if (officeItems.length === 0) {
    return {
      success: true,
      data: {
        createdWrap: null,
        ejectedContainer: null,
        movedItemIDs: [],
      },
    };
  }

  const containerType = resolveItemByTypeID(OFFICE_EJECT_CONTAINER_TYPE_ID);
  if (!containerType) {
    return {
      success: false,
      errorMsg: "DROP_CONTAINER_TYPE_NOT_FOUND",
    };
  }

  const structureID = normalizePositiveInt(structure && structure.structureID, 0);
  const officeID = normalizePositiveInt(
    office && (office.officeID || office.officeFolderID || office.itemID),
    0,
  );
  if (!officeID) {
    return {
      success: false,
      errorMsg: "CORPORATION_OFFICE_NOT_FOUND",
    };
  }
  const structureUnanchor = options.structureUnanchor === true;
  const marker = structureUnanchor
    ? buildStructureUnanchorOfficeMarker(structureID, officeID)
    : "";
  const existingContainerResult = structureUnanchor
    ? findStructureUnanchorEjectContainer(
      structure,
      corpID,
      normalizeAllInventoryItems(),
      marker,
    )
    : {
      success: true,
      data: null,
    };
  if (!existingContainerResult.success) {
    return existingContainerResult;
  }
  let container = existingContainerResult.data;
  if (!container) {
    const position = buildStructureScatterPosition(
      structure,
      normalizeInt(options.scatterIndex, 0),
      options,
    );
    const createContainerResult = createSpaceItemForOwner(
      corpID,
      solarSystemID,
      containerType,
      {
        itemName: buildOfficeEjectContainerName(structure),
        position,
        direction: getStructureSpaceDirection(structure),
        targetPoint: position,
        createdAtMs: options.nowMs ?? Date.now(),
        launcherID: structureID,
        customInfo: marker,
      },
    );
    if (!createContainerResult.success || !createContainerResult.data) {
      return createContainerResult;
    }
    container = createContainerResult.data;
  }

  const movedItemIDs = [];
  for (const item of officeItems) {
    const itemID = normalizePositiveInt(item && item.itemID, 0);
    if (!itemID) {
      continue;
    }
    const moveResult = deliveryItemCustody.transferItem({
      item,
      locationID: container.itemID,
      flagID: ITEM_FLAGS.HANGAR,
      actor: corpID,
      reason: itemCustody.CUSTODY_REASON.STRUCTURE_UNANCHOR_HANDOFF,
    });
    if (!moveResult.success) {
      log.warn(
        `[StructureAssetSafety] Failed to eject office item ${itemID} into container ${container.itemID}: ${moveResult.errorMsg}`,
      );
      if (movedItemIDs.length > 0) {
        createStructureItemsNeedAttentionNotifications(structure, corpID);
      }
      return {
        ...moveResult,
        data: {
          createdWrap: null,
          ejectedContainer: findItemById(container.itemID) || container,
          movedItemIDs,
          officeID,
        },
      };
    }
    movedItemIDs.push(itemID);
  }

  if (movedItemIDs.length > 0) {
    createStructureItemsNeedAttentionNotifications(structure, corpID);
  }

  return {
    success: true,
    data: {
      createdWrap: null,
      ejectedContainer: findItemById(container.itemID) || container,
      movedItemIDs,
      officeID,
    },
  };
}

function injectAssetSafetyFault(point, wrap) {
  if (typeof assetSafetyFaultInjector === "function") {
    assetSafetyFaultInjector(point, cloneValue(wrap));
  }
}

function resumeWrapCollection(wrap, structure = null) {
  let currentWrap = getWrapByID(wrap && wrap.assetWrapID, { refresh: false });
  if (!currentWrap) {
    return { success: false, errorMsg: "WRAP_NOT_FOUND" };
  }
  if (currentWrap.collectionState !== "collecting") {
    return {
      success: true,
      data: {
        createdWrap: cloneValue(currentWrap),
        movedItemIDs: currentWrap.itemIDs.slice(),
      },
    };
  }

  for (let index = 0; index < currentWrap.collectionLegs.length; index += 1) {
    const leg = currentWrap.collectionLegs[index];
    if (leg.status === "committed") {
      continue;
    }
    const moveResult = deliveryItemCustody.transferItem({
      item: leg.sourceItem,
      locationID: currentWrap.assetWrapID,
      flagID: leg.destinationFlagID,
      actor: currentWrap.ownerID,
      reason: itemCustody.CUSTODY_REASON.ASSET_SAFETY_WRAP,
      idempotencyKey: leg.idempotencyKey,
    });
    if (!moveResult || moveResult.success !== true) {
      return {
        ...(moveResult || { success: false, errorMsg: "ASSET_SAFETY_CUSTODY_FAILED" }),
        data: {
          createdWrap: cloneValue(currentWrap),
          movedItemIDs: currentWrap.collectionLegs
            .filter((candidate) => candidate.status === "committed")
            .map((candidate) => candidate.itemID),
        },
      };
    }
    injectAssetSafetyFault("after-wrap-custody", currentWrap);
    const checkpointResult = updateWrap(currentWrap.assetWrapID, (record) => ({
      ...record,
      itemIDs: [...new Set([...(record.itemIDs || []), leg.itemID])]
        .sort((left, right) => left - right),
      collectionLegs: record.collectionLegs.map((candidate, candidateIndex) => (
        candidateIndex === index
          ? { ...candidate, status: "committed" }
          : candidate
      )),
    }));
    if (!checkpointResult.success) {
      return checkpointResult;
    }
    currentWrap = checkpointResult.data;
  }

  const sourceStructure = structure || currentWrap.sourceStructureSnapshot;
  if (currentWrap.collectionNotificationStatus !== "committed") {
    const notificationResult = createAssetSafetyMovedNotifications(
      sourceStructure,
      currentWrap,
    );
    if (!notificationResult || notificationResult.success !== true) {
      return notificationResult || {
        success: false,
        errorMsg: "ASSET_SAFETY_NOTIFICATION_FAILED",
      };
    }
    injectAssetSafetyFault("after-wrap-notification", currentWrap);
  }

  const completionResult = updateWrap(currentWrap.assetWrapID, (record) => ({
    ...record,
    collectionState: "ready",
    collectionNotificationStatus: "committed",
  }));
  if (!completionResult.success) {
    return completionResult;
  }
  return {
    success: true,
    data: {
      createdWrap: completionResult.data,
      movedItemIDs: completionResult.data.itemIDs.slice(),
    },
  };
}

function createWrapFromItems(ownerKind, ownerID, structure, items = [], options = {}) {
  const topLevelItems = (Array.isArray(items) ? items : [])
    .map((item) => {
      const itemID = normalizePositiveInt(item && item.itemID, 0);
      return itemID > 0 ? (findItemById(itemID) || item) : null;
    })
    .filter(Boolean);

  if (topLevelItems.length === 0) {
    return {
      success: true,
      data: {
        createdWrap: null,
        movedItemIDs: [],
      },
    };
  }

  const structureName = String(
    structure && (structure.itemName || structure.name || `Structure ${structure.structureID}`),
  );
  const numericOwnerID = normalizePositiveInt(ownerID, 0);
  const normalizedOwnerKind =
    String(ownerKind || "char").trim().toLowerCase() === "corp"
      ? "corp"
      : "char";
  if (normalizedOwnerKind === "corp" && topLevelItems.some((item) =>
    Number(item.ownerID) !== numericOwnerID || !CORPORATION_SAFETY_FLAGS.has(Number(item.flagID)))) {
    return { success: false, errorMsg: "CORPORATION_SAFETY_DIVISION_UNKNOWN" };
  }
  const structureID = normalizePositiveInt(
    structure && structure.structureID,
    0,
  );
  const wrapName = options.wrapName || `${structureName} Asset Safety`;
  const lifecycleKey = String(options.lifecycleKey || "").trim() || null;
  const existingWrap = lifecycleKey
    ? ensureWrapCache().wraps.find(
      (wrap) =>
        !wrap.deliveredAt &&
        normalizePositiveInt(wrap.ownerID, 0) === numericOwnerID &&
        String(wrap.ownerKind || "") === normalizedOwnerKind &&
        normalizePositiveInt(wrap.sourceStructureID, 0) === structureID &&
        String(wrap.lifecycleKey || "") === lifecycleKey,
    ) || null
    : null;
  const wrapCreateResult = existingWrap
    ? {
      success: true,
      data: existingWrap,
    }
    : createWrap({
      ownerID: numericOwnerID,
      ownerKind: normalizedOwnerKind,
      sourceStructureID: structureID,
      solarSystemID: normalizePositiveInt(structure && structure.solarSystemID, 0),
      wrapName,
      lifecycleKey,
      itemIDs: [],
      createdAt: normalizeTimestampMs(options.nowMs, Date.now()) || Date.now(),
      ejectTimeMs: normalizeTimestampMs(options.nowMs, Date.now()) || Date.now(),
      nearestNPCStationInfo:
        normalizeStationInfo(options.nearestNPCStationInfo) ||
        getFallbackNpcStationInfo(structure && structure.solarSystemID),
      nearestNPCStationInfoSource: normalizeStationInfo(options.nearestNPCStationInfo)
        ? "override"
        : "distance-v1",
      assetSafetyDisabled: Boolean(options.assetSafetyDisabled),
      sourceStructureSnapshot: cloneValue(structure),
      collectionState: "collecting",
      corporationDivisionVersion: normalizedOwnerKind === "corp" ? 1 : 0,
      collectionNotificationStatus: "pending",
      collectionLegs: topLevelItems.map((item) => ({
        itemID: normalizePositiveInt(item && item.itemID, 0),
        sourceItem: cloneValue(item),
        destinationFlagID: normalizedOwnerKind === "corp" ? Number(item.flagID) : ASSET_SAFETY_FLAG_ID,
        status: "pending",
      })),
    });
  if (!wrapCreateResult.success) {
    return wrapCreateResult;
  }

  const wrapID = normalizePositiveInt(wrapCreateResult.data.assetWrapID, 0);
  return resumeWrapCollection(
    getWrapByID(wrapID, { refresh: false }),
    structure,
  );
}

function destroyStructureRigsAfterUnanchorHandoffs(rigItemIDs) {
  const destroyedRigItemIDs = [];
  for (const itemID of [...new Set(
    (Array.isArray(rigItemIDs) ? rigItemIDs : [])
      .map((value) => normalizePositiveInt(value, 0))
      .filter(Boolean),
  )]) {
    if (!findItemById(itemID)) {
      continue;
    }
    const removeResult = removeInventoryItem(itemID, {
      removeContents: true,
    });
    if (!removeResult.success) {
      return {
        ...removeResult,
        data: {
          destroyedRigItemIDs,
        },
      };
    }
    destroyedRigItemIDs.push(itemID);
  }
  return {
    success: true,
    data: {
      destroyedRigItemIDs,
    },
  };
}

function repairCorporationWrapDivisions(wrap) {
  // Never reclaim released cargo or change a captured in-flight unpacking saga.
  if (!wrap || wrap.ownerKind !== "corp" || wrap.corporationDivisionVersion === 1 ||
      wrap.deliveredAt || wrap.deliverySaga?.deliveryMode === "unpacked") {
    return { success: true, data: wrap };
  }
  const fail = () => ({ success: false, errorMsg: "CORPORATION_SAFETY_ORIGIN_UNPROVEN" });
  if (wrap.collectionState !== "ready") return fail();
  const rows = listContainerItems(null, wrap.assetWrapID, null);
  if (!rows.length || rows.length !== wrap.collectionLegs.length ||
      rows.length !== wrap.itemIDs.length ||
      rows.some(row => !wrap.itemIDs.includes(Number(row.itemID))) ||
      new Set(wrap.collectionLegs.map(leg => leg.itemID)).size !== rows.length) return fail();
  const quantity = item => Number(item.singleton) === 1 ? 1 : Number(item.stacksize ?? item.quantity);
  const commands = [];
  for (const row of rows) {
    const leg = wrap.collectionLegs.find(candidate => candidate.itemID === Number(row.itemID));
    const origin = leg?.sourceItem;
    if (!origin || leg.status !== "committed" || Number(origin.itemID) !== Number(row.itemID) ||
        Number(origin.ownerID) !== wrap.ownerID || Number(row.ownerID) !== wrap.ownerID ||
        Number(row.locationID) !== wrap.assetWrapID || !CORPORATION_SAFETY_FLAGS.has(Number(origin.flagID)) ||
        Number(row.typeID) !== Number(origin.typeID) || Number(row.singleton) !== Number(origin.singleton) ||
        quantity(row) !== quantity(origin)) return fail();
    const collected = itemCustody.getCommittedReceipt(leg.idempotencyKey);
    const proof = collected.receipt?.fingerprint;
    if (!collected.success || !collected.committed ||
        proof?.reason !== itemCustody.CUSTODY_REASON.ASSET_SAFETY_WRAP ||
        Number(proof.actor) !== wrap.ownerID || proof.itemSpec?.quantity !== null ||
        proof.source?.kind !== itemCustody.CUSTODY_REF_KIND.OWNER_LOCATION ||
        proof.destination?.kind !== itemCustody.CUSTODY_REF_KIND.OWNER_LOCATION ||
        Number(proof.itemSpec?.itemID) !== leg.itemID ||
        Number(proof.source?.ownerID) !== wrap.ownerID ||
        Number(proof.source?.locationID) !== Number(origin.locationID) ||
        Number(proof.source?.flagID) !== Number(origin.flagID) ||
        Number(proof.destination?.ownerID) !== wrap.ownerID ||
        Number(proof.destination?.locationID) !== wrap.assetWrapID ||
        Number(proof.destination?.flagID) !== ASSET_SAFETY_FLAG_ID) return fail();
    const key = `asset-safety:${wrap.assetWrapID}:corp-division:${leg.itemID}:v1`;
    const repaired = itemCustody.getCommittedReceipt(key);
    if (!repaired.success || (Number(row.flagID) !== ASSET_SAFETY_FLAG_ID &&
        !(repaired.committed && Number(row.flagID) === Number(origin.flagID)))) return fail();
    commands.push({ item: { ...row, flagID: ASSET_SAFETY_FLAG_ID },
      locationID: wrap.assetWrapID, flagID: Number(origin.flagID), actor: wrap.ownerID,
      reason: itemCustody.CUSTODY_REASON.ASSET_SAFETY_WRAP, idempotencyKey: key });
  }
  // All origins are proven before the first repair. A custody receipt commits
  // with each row; replay is safe if the final wrap checkpoint was lost.
  for (const command of commands) {
    const result = deliveryItemCustody.transferItem(command);
    if (!result?.success) return result || fail();
  }
  return updateWrap(wrap.assetWrapID, current => ({ ...current, corporationDivisionVersion: 1 }));
}

function resumeWrapDelivery(wrap) {
  let currentWrap = getWrapByID(wrap && wrap.assetWrapID, { refresh: false });
  if (!currentWrap || !currentWrap.deliverySaga) {
    return { success: false, errorMsg: "WRAP_DELIVERY_NOT_PREPARED" };
  }
  const saga = currentWrap.deliverySaga;
  if (saga.status === "completed" || currentWrap.deliveredAt) {
    const notice = publishPendingDeliveryInvalidation(currentWrap.assetWrapID);
    return { success: true, data: cloneValue(currentWrap), duplicate: true,
      notificationPending: notice.success !== true };
  }

  for (let index = 0; index < saga.itemLegs.length; index += 1) {
    const leg = currentWrap.deliverySaga.itemLegs[index];
    if (leg.status === "committed") {
      continue;
    }
    const moveResult = deliveryItemCustody.transferItem({
      item: leg.sourceItem,
      locationID: currentWrap.deliverySaga.destinationID,
      flagID: ITEM_FLAGS.HANGAR,
      actor: normalizePositiveInt(currentWrap.ownerID, 0),
      reason: itemCustody.CUSTODY_REASON.ASSET_SAFETY_DELIVER,
      idempotencyKey: leg.idempotencyKey,
    });
    if (!moveResult || moveResult.success !== true) {
      return moveResult || {
        success: false,
        errorMsg: "ASSET_SAFETY_DELIVERY_CUSTODY_FAILED",
      };
    }
    injectAssetSafetyFault("after-delivery-custody", currentWrap);
    const checkpointResult = updateWrap(currentWrap.assetWrapID, (record) => ({
      ...record,
      deliverySaga: {
        ...record.deliverySaga,
        itemLegs: record.deliverySaga.itemLegs.map((candidate, candidateIndex) => (
          candidateIndex === index
            ? { ...candidate, status: "committed" }
            : candidate
        )),
      },
    }));
    if (!checkpointResult.success) {
      return checkpointResult;
    }
    currentWrap = checkpointResult.data;
  }

  if (saga.deliveryMode === "wrapped") {
    injectAssetSafetyFault("before-delivery-wrap-checkpoint", currentWrap);
  }

  const completion = updateWrap(currentWrap.assetWrapID, (record) => ({
    ...record,
    destinationID: record.deliverySaga.destinationID,
    destinationKind: record.deliverySaga.destinationKind,
    deliveredAt: record.deliverySaga.deliveredAtMs,
    // Commit delivery and its pending live invalidation together. Historical
    // completed records without this field do not gain a replay notification.
    deliveryNotificationStatus: "pending",
    autoMovedAt:
      record.deliverySaga.autoMove === true
        ? record.deliverySaga.deliveredAtMs
        : record.autoMovedAt,
    itemIDs: record.deliverySaga.itemLegs.length > 0
      ? record.deliverySaga.itemLegs.map((leg) => leg.itemID)
      : record.itemIDs,
    deliverySaga: {
      ...record.deliverySaga,
      status: "completed",
    },
  }));
  if (!completion.success) {
    return completion;
  }
  const notice = publishPendingDeliveryInvalidation(currentWrap.assetWrapID);
  if (!notice.success) {
    log.warn(`[StructureAssetSafety] Delivery invalidation pending for wrap ${currentWrap.assetWrapID}: ${notice.errorMsg}`);
    queueWrapScheduling(currentWrap.assetWrapID);
  }
  return { ...completion, data: getWrapByID(currentWrap.assetWrapID, { refresh: false }),
    notificationPending: notice.success !== true };
}

function publishPendingDeliveryInvalidation(assetWrapID) {
  // A failed flush may have left deliveredAt or the notice marker in the
  // game-store memory cache. Never publish or acknowledge that state early.
  const durable = ensureWrapTableDurable();
  if (!durable.success) {
    return durable;
  }
  const wrap = getWrapByID(assetWrapID, { refresh: false });
  if (!wrap || !wrap.deliveredAt || wrap.deliveryNotificationStatus !== "pending") {
    return { success: true, data: wrap };
  }
  try {
    // Send then checkpoint: a crash in between can safely repeat the native
    // cache invalidation. There is no client acknowledgment/exact-once claim.
    // With no live owner sessions, there is no live cache to invalidate.
    notifyAssetSafetyDelivered(null, wrap);
  } catch (error) {
    return { success: false, errorMsg: error.message || "ASSET_SAFETY_NOTICE_FAILED" };
  }
  return updateWrap(wrap.assetWrapID, (current) => ({
    ...current,
    deliveryNotificationStatus: "committed",
  }));
}

function deliverWrapToDestination(assetWrapID, destinationID, options = {}) {
  // Automatic delivery already runs inside tickAssetSafetyWraps. Refreshing
  // here would re-enter the tick before the current wrap can be delivered.
  const fallbackRepair = repairPendingWrapFallback(
    getWrapByID(assetWrapID, { refresh: false }),
  );
  if (!fallbackRepair.success) {
    return fallbackRepair;
  }
  const wrap = fallbackRepair.data;
  if (!wrap) {
    return {
      success: false,
      errorMsg: "WRAP_NOT_FOUND",
    };
  }
  if (wrap.deliveredAt) {
    return {
      success: false,
      errorMsg: "WRAP_ALREADY_DELIVERED",
    };
  }

  const session = options.session || null;
  if (options.skipAccessCheck !== true && !sessionCanManageWrap(session, wrap)) {
    return {
      success: false,
      errorMsg: "WRAP_ACCESS_DENIED",
    };
  }

  const nowMs = normalizeTimestampMs(options.nowMs, Date.now()) || Date.now();
  const structureState = require(path.join(__dirname, "./structureState"));
  const bypass = Boolean(
    options.ignoreTimer === true || structureState.hasStructureGmBypass(session),
  );
  if (!bypass && nowMs < getWrapUnlockTimeMs(wrap)) {
    return {
      success: false,
      errorMsg: "WRAP_NOT_READY",
    };
  }

  const numericDestinationID = normalizePositiveInt(destinationID, 0) ||
    normalizePositiveInt(
      wrap.nearestNPCStationInfo && wrap.nearestNPCStationInfo.itemID,
      0,
    );
  if (!numericDestinationID) {
    return {
      success: false,
      errorMsg: "DESTINATION_NOT_FOUND",
    };
  }

  let destinationKind = "station";
  const destinationStructure = getStructureState().getStructureByID(numericDestinationID);
  if (destinationStructure) {
    destinationKind = "structure";
    if (
      destinationStructure.destroyedAt ||
      destinationStructure.solarSystemID !== wrap.solarSystemID
    ) {
      return {
        success: false,
        errorMsg: "INVALID_DESTINATION_STRUCTURE",
      };
    }

    const accessResult = structureState.canCharacterDockAtStructure(
      session,
      destinationStructure,
      {
        ignoreRestrictions: structureState.hasStructureGmBypass(session),
      },
    );
    if (!accessResult.success) {
      return {
        success: false,
        errorMsg: accessResult.errorMsg || "DESTINATION_ACCESS_DENIED",
      };
    }
  } else {
    const destinationStation = worldData.getStationByID(numericDestinationID);
    if (!destinationStation) {
      return {
        success: false,
        errorMsg: "DESTINATION_NOT_FOUND",
      };
    }
    if (
      normalizePositiveInt(destinationStation.solarSystemID, 0) !== wrap.solarSystemID &&
      numericDestinationID !== normalizePositiveInt(
        wrap.nearestNPCStationInfo && wrap.nearestNPCStationInfo.itemID,
        0,
      )
    ) {
      return {
        success: false,
        errorMsg: "INVALID_DESTINATION_STATION",
      };
    }
  }

  if (wrap.deliverySaga && wrap.deliverySaga.status !== "completed") {
    if (wrap.deliverySaga.destinationID !== numericDestinationID) {
      return { success: false, errorMsg: "WRAP_DELIVERY_ALREADY_PENDING" };
    }
    return resumeWrapDelivery(wrap);
  }

  const divisions = repairCorporationWrapDivisions(wrap);
  if (!divisions.success) return divisions;

  // Native AssetSafetyDeliveries lists type60/flag36, then opens the wrap by
  // ID. Corporate contents keep their division flags (TreeDataCorpAssetSafety548).
  // Delivery itself releases no items and settles no withdrawal fee.
  const deliveryMode = "wrapped";
  const prepareResult = updateWrap(wrap.assetWrapID, (current) => ({
    ...current,
    deliverySaga: {
      destinationID: numericDestinationID,
      destinationKind,
      deliveredAtMs: nowMs,
      autoMove: options.autoMove === true,
      deliveryMode,
      status: "pending",
      itemLegs: [],
    },
  }));
  if (!prepareResult.success) {
    return prepareResult;
  }
  return resumeWrapDelivery(prepareResult.data);
}

function recoverPendingAssetSafetyWraps() {
  const results = [];
  const wraps = ensureWrapCache().wraps.map((wrap) => cloneValue(wrap));
  for (const wrap of wraps) {
    const result = recoverAssetSafetyWrap(wrap.assetWrapID);
    if (result.idle) {
      continue;
    }
    results.push({ assetWrapID: wrap.assetWrapID, result });
    if (!result.success) {
      log.error(
        `[StructureAssetSafety] Recovery remains pending for wrap ` +
          `${wrap.assetWrapID}: ${result.errorMsg || "unknown recovery error"}`,
      );
    }
  }
  return results;
}

function recoverAssetSafetyWrap(assetWrapID) {
  const durable = ensureWrapTableDurable();
  if (!durable.success) {
    return durable;
  }
  const repair = repairPendingWrapFallback(getWrapByID(assetWrapID, { refresh: false }));
  if (!repair.success) {
    return repair;
  }
  let wrap = repair.data;
  if (!wrap) {
    return { success: true, idle: true };
  }
  if (wrap.collectionState === "collecting") {
    const collection = resumeWrapCollection(wrap, wrap.sourceStructureSnapshot);
    if (!collection.success) {
      return collection;
    }
    wrap = getWrapByID(assetWrapID, { refresh: false });
  }
  const divisions = repairCorporationWrapDivisions(wrap);
  if (!divisions.success) return divisions;
  wrap = divisions.data;
  if (!wrap.deliveredAt && wrap.deliverySaga && wrap.deliverySaga.status !== "completed") {
    return resumeWrapDelivery(wrap);
  }
  if (wrap.deliveredAt && wrap.deliveryNotificationStatus === "pending") {
    return publishPendingDeliveryInvalidation(assetWrapID);
  }
  return { success: true, data: wrap, idle: true };
}

function tickAssetSafetyWraps(nowMs = Date.now()) {
  recoverPendingAssetSafetyWraps();
  const normalizedNowMs = normalizeTimestampMs(nowMs, Date.now()) || Date.now();
  const wraps = ensureWrapCache().wraps;
  let changed = false;

  for (const wrap of wraps) {
    if (wrap.deliveredAt || !wrap.nearestNPCStationInfo) {
      continue;
    }
    if (normalizedNowMs < getWrapAutoMoveTimeMs(wrap)) {
      continue;
    }

    const deliverResult = deliverWrapToDestination(
      wrap.assetWrapID,
      wrap.nearestNPCStationInfo.itemID,
      {
        session: null,
        skipAccessCheck: true,
        ignoreTimer: true,
        autoMove: true,
        nowMs: normalizedNowMs,
      },
    );
    if (!deliverResult.success) {
      log.warn(
        `[StructureAssetSafety] Auto-move failed for wrap ${wrap.assetWrapID}: ${deliverResult.errorMsg}`,
      );
      continue;
    }
    changed = true;
  }

  if (changed) {
    wrapCache = null;
  }
  return listWraps({
    includeDelivered: true,
    nowMs: normalizedNowMs,
    refresh: false,
  });
}

function movePersonalAssetsToSafety(session, solarSystemID, structureID, options = {}) {
  const structureState = require(path.join(__dirname, "./structureState"));
  const charID = getSessionCharacterID(session);
  const structure = structureState.getStructureByID(structureID);
  if (!charID || !structure) {
    return {
      success: false,
      errorMsg: "STRUCTURE_NOT_FOUND",
    };
  }
  if (
    normalizePositiveInt(solarSystemID, structure.solarSystemID) !==
    normalizePositiveInt(structure.solarSystemID, 0)
  ) {
    return {
      success: false,
      errorMsg: "SOLAR_SYSTEM_MISMATCH",
    };
  }

  const assetSafetyDisabled =
    isAssetSafetyDisabledForStructure(structure) &&
    !structureState.hasStructureGmBypass(session);
  if (assetSafetyDisabled) {
    return {
      success: false,
      errorMsg: "ASSET_SAFETY_DISABLED",
    };
  }

  const activeShipID = normalizePositiveInt(
    options.excludeActiveShipID ||
      (session && session.structureID === structure.structureID && (session.activeShipID || session.shipID || session.shipid)),
    0,
  );
  return createWrapFromItems(
    "char",
    charID,
    structure,
    listTopLevelStructureItems(charID, structure.structureID, {
      excludeItemIDs: activeShipID ? [activeShipID] : [],
    }),
    options,
  );
}

function moveCorporationAssetsToSafety(session, solarSystemID, structureID, options = {}) {
  const structureState = require(path.join(__dirname, "./structureState"));
  const corpID = getSessionCorporationID(session);
  if (!sessionCanManageCorporationSafety(session, corpID)) {
    return { success: false, errorMsg: "WRAP_ACCESS_DENIED" };
  }
  const structure = structureState.getStructureByID(structureID);
  if (!corpID || !structure) {
    return {
      success: false,
      errorMsg: "STRUCTURE_NOT_FOUND",
    };
  }
  if (
    normalizePositiveInt(solarSystemID, structure.solarSystemID) !==
    normalizePositiveInt(structure.solarSystemID, 0)
  ) {
    return {
      success: false,
      errorMsg: "SOLAR_SYSTEM_MISMATCH",
    };
  }

  const assetSafetyDisabled =
    isAssetSafetyDisabledForStructure(structure) &&
    !structureState.hasStructureGmBypass(session);
  if (assetSafetyDisabled) {
    return {
      success: false,
      errorMsg: "ASSET_SAFETY_DISABLED",
    };
  }

  return createWrapFromItems(
    "corp",
    corpID,
    structure,
    listTopLevelStructureItems(corpID, structure.structureID),
    options,
  );
}

function moveCorporationOfficeAssetsToSafety(corporationID, structure, office, options = {}) {
  const corpID = normalizePositiveInt(corporationID, 0);
  const structureID = normalizePositiveInt(structure && structure.structureID, 0);
  if (!corpID || !structureID || !office) {
    return {
      success: false,
      errorMsg: "STRUCTURE_NOT_FOUND",
    };
  }

  const officeItems = listTopLevelCorporationOfficeItems(corpID, office);
  if (officeItems.length === 0) {
    return {
      success: true,
      data: {
        createdWrap: null,
        movedItemIDs: [],
      },
    };
  }

  const structureState = require(path.join(__dirname, "./structureState"));
  const assetSafetyDisabled =
    isAssetSafetyDisabledForStructure(structure) &&
    !structureState.hasStructureGmBypass(options.session);
  if (assetSafetyDisabled) {
    return ejectCorporationOfficeAssetsToSpace(
      corpID,
      structure,
      office,
      officeItems,
      options,
    );
  }

  const structureName = String(
    structure && (structure.itemName || structure.name || `Structure ${structureID}`),
  );
  const officeID = normalizePositiveInt(
    office && (office.officeID || office.officeFolderID || office.itemID),
    0,
  );
  return createWrapFromItems(
    "corp",
    corpID,
    structure,
    officeItems,
    {
      ...options,
      lifecycleKey:
        options.lifecycleKey ||
        (
          options.structureUnanchor === true && officeID
            ? buildStructureUnanchorOfficeMarker(structureID, officeID)
            : null
        ),
      wrapName: options.wrapName || `${structureName} Office Asset Safety`,
    },
  );
}

function listCorporationOfficesAtStructure(structureID) {
  const numericStructureID = normalizePositiveInt(structureID, 0);
  if (!numericStructureID) {
    return [];
  }
  return getCorporationRuntimeState()
    .getOfficesAtStation(numericStructureID)
    .filter((office) => (
      normalizePositiveInt(office && office.stationID, 0) === numericStructureID
    ));
}

function buildStructureDestructionOfficeMarker(structureID, officeID) {
  return (
    `${STRUCTURE_DESTRUCTION_ARTIFACT_PREFIX}:office:${structureID}:office:${officeID}`
  );
}

function removeCorporationOfficesAfterStructureDeparture(
  structureID,
  offices,
) {
  const numericStructureID = normalizePositiveInt(structureID, 0);
  const officeKeys = new Set(
    (Array.isArray(offices) ? offices : [])
      .map((office) => {
        const corporationID = normalizePositiveInt(
          office && office.corporationID,
          0,
        );
        const officeID = normalizePositiveInt(
          office && (office.officeID || office.officeFolderID || office.itemID),
          0,
        );
        return corporationID && officeID
          ? `${corporationID}:${officeID}`
          : null;
      })
      .filter(Boolean),
  );
  if (!numericStructureID || officeKeys.size === 0) {
    return {
      success: true,
      data: {
        removedOfficeIDs: [],
      },
    };
  }

  const targetOffices = (Array.isArray(offices) ? offices : [])
    .map((office) => {
      const corporationID = normalizePositiveInt(
        office && office.corporationID,
        0,
      );
      const officeID = normalizePositiveInt(
        office && (office.officeID || office.officeFolderID || office.itemID),
        0,
      );
      return corporationID && officeID
        ? {
          corporationID,
          officeID,
          office,
        }
        : null;
    })
    .filter(Boolean);
  const cancelledBillIDs = [];
  try {
    const { cancelOfficeRentalBillsForOffice } = getOfficeRentalBilling();
    for (const target of targetOffices) {
      const cancelledBills = cancelOfficeRentalBillsForOffice(
        target.corporationID,
        numericStructureID,
      );
      if (
        cancelledBills.some(
          (bill) =>
            String(bill && bill.processingStatus || "") !==
            "cancelled",
        )
      ) {
        return {
          success: false,
          errorMsg: "CORPORATION_OFFICE_BILL_CANCEL_FAILED",
        };
      }
      for (const cancelledBill of cancelledBills) {
        const billID = normalizePositiveInt(
          cancelledBill && cancelledBill.billID,
          0,
        );
        if (billID) {
          cancelledBillIDs.push(billID);
        }
      }
    }
  } catch (error) {
    return {
      success: false,
      errorMsg:
        error && error.message ||
        "CORPORATION_OFFICE_BILL_CANCEL_FAILED",
    };
  }

  const removedOfficeIDs = [];
  const removedOfficeKeys = new Set();
  const updateResult = getCorporationRuntimeState().updateRuntimeState(
    (runtimeTable) => {
      const nextRuntimeTable = cloneValue(runtimeTable);
      for (const [corporationKey, corporationRuntime] of Object.entries(
        nextRuntimeTable.corporations || {},
      )) {
        const corporationID = normalizePositiveInt(corporationKey, 0);
        if (
          !corporationID ||
          !corporationRuntime ||
          !corporationRuntime.offices
        ) {
          continue;
        }
        for (const [officeKey, office] of Object.entries(
          corporationRuntime.offices,
        )) {
          const officeID = normalizePositiveInt(
            office && (
              office.officeID ||
              office.officeFolderID ||
              office.itemID
            ),
            normalizePositiveInt(officeKey, 0),
          );
          const officeIdentity = `${corporationID}:${officeID}`;
          if (
            normalizePositiveInt(office && office.stationID, 0) !==
              numericStructureID ||
            !officeKeys.has(officeIdentity)
          ) {
            continue;
          }
          delete corporationRuntime.offices[officeKey];
          removedOfficeIDs.push(officeID);
          removedOfficeKeys.add(officeIdentity);
        }
      }
      return nextRuntimeTable;
    },
  );
  if (!updateResult || updateResult.success !== true) {
    return {
      success: false,
      errorMsg:
        updateResult && updateResult.errorMsg ||
        "CORPORATION_OFFICE_REMOVE_FAILED",
    };
  }
  try {
    const {
      notifyOfficeBillRefresh,
      notifyOfficeRentalChange,
    } = getCorporationNotifications();
    const affectedCorporationIDs = new Set();
    for (const target of targetOffices) {
      if (
        removedOfficeKeys.has(
          `${target.corporationID}:${target.officeID}`,
        )
      ) {
        notifyOfficeRentalChange(target.corporationID, target.office);
        affectedCorporationIDs.add(target.corporationID);
      }
    }
    for (const corporationID of affectedCorporationIDs) {
      notifyOfficeBillRefresh(corporationID);
    }
  } catch (error) {
    log.warn(
      `[StructureAssetSafety] Failed to notify corporation office removal ` +
      `structure=${numericStructureID}: ${error && error.message || error}`,
    );
  }
  return {
    success: true,
    data: {
      cancelledBillIDs: [...new Set(cancelledBillIDs)]
        .sort((left, right) => left - right),
      removedOfficeIDs: [...new Set(removedOfficeIDs)]
        .sort((left, right) => left - right),
    },
  };
}

function handleStructureDestroyed(structure, options = {}) {
  if (!structure || normalizePositiveInt(structure.structureID, 0) <= 0) {
    return {
      success: false,
      errorMsg: "STRUCTURE_NOT_FOUND",
    };
  }

  const structureState = require(path.join(__dirname, "./structureState"));
  const bypass = structureState.hasStructureGmBypass(options.session);
  const assetSafetyDisabled = (
    isAssetSafetyDisabledForStructure(structure) ||
    Number(structure.upkeepState || 0) === STRUCTURE_UPKEEP_STATE.ABANDONED
  ) && !bypass;
  if (assetSafetyDisabled) {
    log.warn(
      `[StructureAssetSafety] Asset safety is disabled for destroyed structure ${structure.structureID}; structure contents must be handled by the destruction-loot path instead.`,
    );
    return {
      success: false,
      errorMsg: "ASSET_SAFETY_DISABLED",
    };
  }

  const ownerIDs = new Set();
  for (const item of listContainerItems(null, structure.structureID, null)) {
    ownerIDs.add(normalizePositiveInt(item && item.ownerID, 0));
  }

  const createdWraps = [];
  const movedItemIDs = [];
  for (const ownerID of ownerIDs) {
    if (!ownerID) {
      continue;
    }
    const ownerKind = getOwnerKindForAssetSafety(ownerID);
    const wrapResult = createWrapFromItems(
      ownerKind,
      ownerID,
      structure,
      listTopLevelStructureItems(ownerID, structure.structureID),
      {
        nowMs: options.nowMs,
      },
    );
    if (!wrapResult.success) {
      log.warn(
        `[StructureAssetSafety] Failed to create ${ownerKind} wrap for owner ${ownerID} on structure ${structure.structureID}: ${wrapResult.errorMsg}`,
      );
      return {
        success: false,
        errorMsg: "ASSET_SAFETY_HANDOFF_FAILED",
        data: {
          fallbackReason:
            wrapResult.errorMsg || "ASSET_SAFETY_HANDOFF_FAILED",
          partialWrap:
            wrapResult.data && wrapResult.data.createdWrap || null,
          movedItemIDs:
            wrapResult.data &&
            Array.isArray(wrapResult.data.movedItemIDs)
              ? wrapResult.data.movedItemIDs
              : [],
        },
      };
    }
    if (wrapResult.data && wrapResult.data.createdWrap) {
      createdWraps.push(wrapResult.data.createdWrap);
    }
    if (wrapResult.data && Array.isArray(wrapResult.data.movedItemIDs)) {
      movedItemIDs.push(...wrapResult.data.movedItemIDs);
    }
  }

  const structureOffices = listCorporationOfficesAtStructure(
    structure.structureID,
  );
  for (const office of structureOffices) {
    const corporationID = normalizePositiveInt(
      office && office.corporationID,
      0,
    );
    if (!corporationID) {
      return {
        success: false,
        errorMsg: "CORPORATION_OFFICE_NOT_FOUND",
      };
    }
    const officeResult = moveCorporationOfficeAssetsToSafety(
      corporationID,
      structure,
      office,
      {
        ...options,
        lifecycleKey: buildStructureDestructionOfficeMarker(
          structure.structureID,
          normalizePositiveInt(
            office.officeID || office.officeFolderID || office.itemID,
            0,
          ),
        ),
      },
    );
    if (!officeResult.success) {
      return {
        ...officeResult,
        errorMsg: "ASSET_SAFETY_HANDOFF_FAILED",
      };
    }
    if (officeResult.data && officeResult.data.createdWrap) {
      createdWraps.push(officeResult.data.createdWrap);
    }
    if (officeResult.data && Array.isArray(officeResult.data.movedItemIDs)) {
      movedItemIDs.push(...officeResult.data.movedItemIDs);
    }
  }

  const officeRemovalResult = removeCorporationOfficesAfterStructureDeparture(
    structure.structureID,
    structureOffices,
  );
  if (!officeRemovalResult.success) {
    return officeRemovalResult;
  }

  return {
    success: true,
    data: {
      createdWraps,
      movedItemIDs: [...new Set(movedItemIDs)].sort((left, right) => left - right),
      officeRemoval: officeRemovalResult.data,
    },
  };
}

function handleStructureUnanchored(structure, options = {}) {
  const structureID = normalizePositiveInt(
    structure && structure.structureID,
    0,
  );
  if (!structure || structureID <= 0) {
    return {
      success: false,
      errorMsg: "STRUCTURE_NOT_FOUND",
    };
  }

  const structureState = require(path.join(__dirname, "./structureState"));
  const bypass = structureState.hasStructureGmBypass(options.session);
  const assetSafetyDisabled =
    isAssetSafetyDisabledForStructure(structure) && !bypass;
  const structureOffices = listCorporationOfficesAtStructure(structureID);

  const ownerIDs = new Set();
  for (const item of listContainerItems(null, structure.structureID, null)) {
    if (!isStructureHangarAssetItem(item)) {
      continue;
    }
    const ownerID = normalizePositiveInt(item && item.ownerID, 0);
    if (ownerID) {
      ownerIDs.add(ownerID);
    }
  }

  const createdWraps = [];
  const ejectedContainers = [];
  const movedItemIDs = [];
  const attachedHandoffResult = handOffStructureAttachedItemsForUnanchor(
    structure,
    options,
  );
  if (!attachedHandoffResult.success) {
    return attachedHandoffResult;
  }
  let ownerIndex =
    attachedHandoffResult.data && attachedHandoffResult.data.decommissionContainer ? 1 : 0;
  for (const ownerID of ownerIDs) {
    const ownerItems = listTopLevelStructureHangarItems(ownerID, structure.structureID);
    if (ownerItems.length === 0) {
      continue;
    }

    if (assetSafetyDisabled) {
      const ejectResult = ejectStructureAssetsToSpace(
        ownerID,
        structure,
        ownerItems,
        ownerIndex,
        options,
      );
      ownerIndex += 1;
      if (!ejectResult.success) {
        return ejectResult;
      }
      if (ejectResult.data && ejectResult.data.ejectedContainer) {
        ejectedContainers.push(ejectResult.data.ejectedContainer);
      }
      if (ejectResult.data && Array.isArray(ejectResult.data.movedItemIDs)) {
        movedItemIDs.push(...ejectResult.data.movedItemIDs);
      }
      continue;
    }

    const ownerKind = getOwnerKindForAssetSafety(ownerID);
    const wrapResult = createWrapFromItems(
      ownerKind,
      ownerID,
      structure,
      ownerItems,
      {
        lifecycleKey: buildStructureUnanchorAssetsMarker(
          structureID,
          ownerID,
        ),
        nowMs: options.nowMs,
      },
    );
    if (!wrapResult.success) {
      return wrapResult;
    }
    if (wrapResult.data && wrapResult.data.createdWrap) {
      createdWraps.push(wrapResult.data.createdWrap);
    }
    if (wrapResult.data && Array.isArray(wrapResult.data.movedItemIDs)) {
      movedItemIDs.push(...wrapResult.data.movedItemIDs);
    }
  }

  for (const office of structureOffices) {
    const corporationID = normalizePositiveInt(
      office && office.corporationID,
      0,
    );
    if (!corporationID) {
      return {
        success: false,
        errorMsg: "CORPORATION_OFFICE_NOT_FOUND",
      };
    }
    const officeResult = moveCorporationOfficeAssetsToSafety(
      corporationID,
      structure,
      office,
      {
        ...options,
        scatterIndex: ownerIndex,
        structureUnanchor: true,
      },
    );
    ownerIndex += 1;
    if (!officeResult.success) {
      return officeResult;
    }
    if (officeResult.data && officeResult.data.createdWrap) {
      createdWraps.push(officeResult.data.createdWrap);
    }
    if (officeResult.data && officeResult.data.ejectedContainer) {
      ejectedContainers.push(officeResult.data.ejectedContainer);
    }
    if (
      officeResult.data &&
      Array.isArray(officeResult.data.movedItemIDs)
    ) {
      movedItemIDs.push(...officeResult.data.movedItemIDs);
    }
  }

  const officeRemovalResult =
    removeCorporationOfficesAfterStructureDeparture(
      structureID,
      structureOffices,
    );
  if (!officeRemovalResult.success) {
    return officeRemovalResult;
  }
  const rigDestructionResult = destroyStructureRigsAfterUnanchorHandoffs(
    attachedHandoffResult.data &&
      attachedHandoffResult.data.pendingRigItemIDs,
  );
  if (!rigDestructionResult.success) {
    return rigDestructionResult;
  }
  const attachedHandoff = {
    ...(attachedHandoffResult.data || {}),
    destroyedRigItemIDs:
      rigDestructionResult.data &&
      rigDestructionResult.data.destroyedRigItemIDs || [],
    pendingRigItemIDs: [],
  };

  return {
    success: true,
    data: {
      assetSafetyDisabled,
      createdWraps,
      ejectedContainers,
      movedItemIDs,
      removedOfficeIDs:
        officeRemovalResult.data &&
        officeRemovalResult.data.removedOfficeIDs || [],
      attachedHandoff,
    },
  };
}

function getDeliveryTargetsForSession(session, solarSystemID) {
  const structureState = require(path.join(__dirname, "./structureState"));
  const numericSystemID = normalizePositiveInt(solarSystemID, 0);
  const structures = structureState.listDockableStructuresForCharacter(session, {
    solarSystemID: numericSystemID,
  }).map((structure) => ({
    itemID: structure.structureID,
    typeID: structure.typeID,
    solarSystemID: structure.solarSystemID,
    itemName: structure.itemName || structure.name || `Structure ${structure.structureID}`,
  }));
  return {
    structures,
    nearestNPCStationInfo: getFallbackNpcStationInfo(numericSystemID),
  };
}

function shiftWrapEjectTimeGM(assetWrapID, daysDelta) {
  const normalizedDays = Number(daysDelta) || 0;
  return updateWrap(assetWrapID, (current) => ({
    ...current,
    ejectTimeMs: normalizeTimestampMs(current.ejectTimeMs, Date.now()) + Math.round(normalizedDays * DAY_MS),
  }));
}

function resetStructureAssetSafetyStateForTests() {
  wrapCache = null;
  stationCache = null;
  assetSafetyFaultInjector = null;
  wrapTableNeedsFlush = false;
  pendingFallbackRepairFlushes.clear();
}

module.exports = {
  STRUCTURE_ASSET_SAFETY_TABLE,
  ASSET_SAFETY_FLAG_ID,
  ASSET_SAFETY_WRAP_TYPE_ID,
  DAYS_UNTIL_CAN_DELIVER,
  DAYS_UNTIL_AUTO_MOVE,
  listWraps,
  getWrapByID,
  getDeliveredPersonalWrapItem,
  getDeliveredWrapItem,
  sessionCanManageWrap,
  sessionCanManageCorporationSafety,
  setWrapRecoveryState,
  getWrapNames,
  listWrapsForOwner,
  movePersonalAssetsToSafety,
  moveCorporationAssetsToSafety,
  moveCorporationOfficeAssetsToSafety,
  listCorporationOfficesAtStructure,
  removeCorporationOfficesAfterStructureDeparture,
  getDeliveryTargetsForSession,
  deliverWrapToDestination,
  shiftWrapEjectTimeGM,
  tickAssetSafetyWraps,
  recoverPendingAssetSafetyWraps,
  recoverAssetSafetyWrap,
  publishPendingDeliveryInvalidation,
  ensureWrapTableDurable,
  handleStructureDestroyed,
  handleStructureUnanchored,
  isAssetSafetyDisabledSolarSystem,
  isAssetSafetyDisabledForStructure,
  resetStructureAssetSafetyStateForTests,
  _testing: {
    setFaultInjector(handler) {
      assetSafetyFaultInjector = typeof handler === "function" ? handler : null;
    },
    clearFaultInjector() {
      assetSafetyFaultInjector = null;
    },
  },
};
