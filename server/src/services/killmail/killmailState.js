"use strict";

const {
  cloneValue,
} = require("../../common/clone");

const crypto = require("crypto");
const path = require("path");

// Phase 0 / 0.C: killmail state via an ownership-scoped repository.
const {
  createTableRepository,
} = require(path.join(__dirname, "../../gameStore/tableRepository"));
const repo = createTableRepository("service:killmail", { strict: true });
const {
  buildDict,
  buildFiletimeLong,
  buildKeyVal,
  currentFileTime,
} = require(path.join(__dirname, "../_shared/serviceHelpers"));
const {
  getWarRecord,
  listAllWarsDescending,
} = require(path.join(__dirname, "../corporation/warRuntimeState"));
const {
  resolveItemByTypeID,
} = require(path.join(__dirname, "../inventory/itemTypeRegistry"));
const {
  isCapsuleTypeID,
} = require(path.join(__dirname, "../inventory/itemStore"));
const {
  toPublicSolarSystemID,
} = require("../../abyssal").engineSupport.hostLocation;
const {
  buildKillmailProjection,
  isOwnerKillLogVictim,
  prepareKillmailRecord,
} = require(path.join(__dirname, "./killmailPreparationTasks"));

const KILLMAIL_TABLE = "killmails";
const KILLMAIL_VERSION = 1;
const GROUP_CAPSULES = 0;
const GROUP_FRIGATES = 1;
const GROUP_DESTROYERS = 2;
const GROUP_CRUISERS = 3;
const GROUP_BATTLESHIPS = 4;
const GROUP_BATTLECRUISERS = 5;
const GROUP_CAPITALSHIPS = 6;
const GROUP_INDUSTRIALS = 7;
const GROUP_POS = 8;
const GROUP_STRUCTURES = 9;
let killmailTableCache = null;
let killmailBootstrapComplete = false;
let killmailIndexesDirty = true;
let killmailIndexes = null;
const killmailProjectionStats = {
  fullRebuilds: 0,
  incrementalUpdates: 0,
};

function normalizeInteger(value, fallback = 0) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return fallback;
  }
  return Math.trunc(numericValue);
}

function normalizePositiveInteger(value, fallback = null) {
  const numericValue = normalizeInteger(value, 0);
  return numericValue > 0 ? numericValue : fallback;
}

function normalizeNumber(value, fallback = 0) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : fallback;
}

function normalizeNullableNumber(value, fallback = null) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : fallback;
}

function normalizeText(value, fallback = "") {
  if (value === undefined || value === null) {
    return fallback;
  }
  return typeof value === "string" ? value : String(value);
}

function normalizeFiletimeString(value, fallback = null) {
  if (typeof value === "string" && value.trim() !== "") {
    return value;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(Math.trunc(value));
  }
  return fallback || currentFileTime().toString();
}

function buildDefaultTable() {
  return {
    _meta: {
      version: KILLMAIL_VERSION,
      nextKillID: 1,
    },
    pending: {},
    records: {},
  };
}

function markKillmailIndexesDirty() {
  killmailIndexesDirty = true;
  killmailIndexes = null;
}

function readKillmailTable() {
  const result = repo.read(KILLMAIL_TABLE, "/");
  if (!result.success || !result.data || typeof result.data !== "object") {
    return buildDefaultTable();
  }

  const table = cloneValue(result.data);
  if (!table._meta || typeof table._meta !== "object") {
    table._meta = {};
  }
  if (!table.records || typeof table.records !== "object") {
    table.records = {};
  }
  if (!table.pending || typeof table.pending !== "object") {
    table.pending = {};
  }
  if (!Number.isFinite(Number(table._meta.version))) {
    table._meta.version = KILLMAIL_VERSION;
  }
  if (!Number.isFinite(Number(table._meta.nextKillID)) || Number(table._meta.nextKillID) <= 0) {
    table._meta.nextKillID = 1;
  }
  return table;
}

function readKillmailTableView() {
  const result = repo.read(KILLMAIL_TABLE, "/");
  if (!result.success || !result.data || typeof result.data !== "object") {
    return null;
  }
  return result.data;
}

function writeKillmailTable(table, options = {}) {
  const writeOptions = Array.isArray(options.knownChangedPaths)
    ? { knownChangedPaths: options.knownChangedPaths }
    : undefined;
  const writeResult = repo.write(KILLMAIL_TABLE, "/", table, writeOptions);
  if (writeResult && writeResult.success) {
    killmailTableCache = table;
    if (options.recordsChanged !== false) {
      markKillmailIndexesDirty();
    }
    if (
      options.flushImmediately === true &&
      typeof repo.flushTableAsync === "function"
    ) {
      repo.flushTableAsync(KILLMAIL_TABLE);
    }
  }
  return writeResult;
}

function ensureKillmailTableInitialized() {
  if (killmailBootstrapComplete && killmailTableCache) {
    return killmailTableCache;
  }

  const table = readKillmailTable();
  const writeResult = writeKillmailTable(table);
  if (!writeResult.success) {
    return buildDefaultTable();
  }
  killmailTableCache = table;
  killmailBootstrapComplete = true;
  return table;
}

function resetKillmailStateForTests() {
  killmailTableCache = null;
  killmailBootstrapComplete = false;
  markKillmailIndexesDirty();
  killmailProjectionStats.fullRebuilds = 0;
  killmailProjectionStats.incrementalUpdates = 0;
}

function getKillmailProjectionStats() {
  return {
    ...killmailProjectionStats,
    dirty: killmailIndexesDirty,
    ready: Boolean(killmailIndexes),
  };
}

function sortKillmailsDescending(records = []) {
  return records
    .slice()
    .sort(
      (left, right) =>
        normalizeInteger(right && right.killID, 0) -
          normalizeInteger(left && left.killID, 0) ||
        String(right && right.killTime ? right.killTime : "").localeCompare(
          String(left && left.killTime ? left.killTime : ""),
        ),
    );
}

function filterByStartKillID(records = [], startKillID = null) {
  const numericStartKillID = normalizePositiveInteger(startKillID, null);
  if (!numericStartKillID) {
    return records.slice();
  }
  return records.filter(
    (record) => normalizePositiveInteger(record && record.killID, 0) < numericStartKillID,
  );
}

function limitRecords(records = [], limit = null) {
  const numericLimit = normalizeInteger(limit, 0);
  if (numericLimit <= 0) {
    return records.slice();
  }
  return records.slice(0, numericLimit);
}

function redactReservedAbyssalHostFromKillmail(record) {
  if (!record || typeof record !== "object") {
    return record;
  }
  const publicSolarSystemID = toPublicSolarSystemID(
    record.solarSystemID,
    null,
  );
  if (publicSolarSystemID === record.solarSystemID) {
    return record;
  }
  return {
    ...record,
    solarSystemID: publicSolarSystemID,
  };
}

function redactReservedAbyssalHostsFromKillmails(records = []) {
  return (Array.isArray(records) ? records : [])
    .map((record) => redactReservedAbyssalHostFromKillmail(record));
}

function buildEmptyKillmailIndexes() {
  return {
    recordsDesc: [],
    recordsByCharacter: new Map(),
    recordsByCorporationKills: new Map(),
    recordsByCorporationLosses: new Map(),
    recordsByAllianceKills: new Map(),
    recordsByAllianceLosses: new Map(),
    recordsByWar: new Map(),
  };
}

function appendRecordToIndex(indexMap, key, record) {
  if (!key) {
    return;
  }
  if (!indexMap.has(key)) {
    indexMap.set(key, []);
  }
  indexMap.get(key).push(record);
}

function insertRecordDescending(records, record) {
  const killID = normalizePositiveInteger(record && record.killID, 0) || 0;
  const existingIndex = records.findIndex(
    (entry) => normalizePositiveInteger(entry && entry.killID, 0) === killID,
  );
  if (existingIndex >= 0) {
    records[existingIndex] = record;
    return;
  }
  const insertAt = records.findIndex(
    (entry) => normalizePositiveInteger(entry && entry.killID, 0) < killID,
  );
  if (insertAt < 0) {
    records.push(record);
  } else {
    records.splice(insertAt, 0, record);
  }
}

function insertRecordIntoIndex(indexMap, key, record) {
  if (!key) {
    return;
  }
  if (!indexMap.has(key)) {
    indexMap.set(key, []);
  }
  insertRecordDescending(indexMap.get(key), record);
}

function applyKillmailProjection(indexes, record, projection = null) {
  const resolvedProjection = projection || buildKillmailProjection(record);
  insertRecordDescending(indexes.recordsDesc, record);

  if (resolvedProjection.victimCharacterID) {
    insertRecordIntoIndex(
      indexes.recordsByCharacter,
      resolvedProjection.finalCharacterID,
      record,
    );
    if (
      resolvedProjection.victimCharacterID !==
      resolvedProjection.finalCharacterID
    ) {
      insertRecordIntoIndex(
        indexes.recordsByCharacter,
        resolvedProjection.victimCharacterID,
        record,
      );
    }
  }
  const entersOwnerKillLog =
    resolvedProjection.entersOwnerKillLog !== undefined
      ? resolvedProjection.entersOwnerKillLog === true
      : isOwnerKillLogVictim(record);
  if (entersOwnerKillLog) {
    for (const corporationID of resolvedProjection.attackerCorporationIDs || []) {
      insertRecordIntoIndex(indexes.recordsByCorporationKills, corporationID, record);
    }
  }
  insertRecordIntoIndex(
    indexes.recordsByCorporationLosses,
    resolvedProjection.victimCorporationID,
    record,
  );
  if (entersOwnerKillLog) {
    for (const allianceID of resolvedProjection.attackerAllianceIDs || []) {
      insertRecordIntoIndex(indexes.recordsByAllianceKills, allianceID, record);
    }
  }
  insertRecordIntoIndex(
    indexes.recordsByAllianceLosses,
    resolvedProjection.victimAllianceID,
    record,
  );
  insertRecordIntoIndex(indexes.recordsByWar, resolvedProjection.warID, record);
}

function collectAttackerOwnerIDs(record = {}, fieldName) {
  const ownerIDs = new Set();
  const finalOwnerID = normalizePositiveInteger(record && record[`final${fieldName}`], null);
  const attackerFieldName =
    fieldName.length > 0
      ? `${fieldName.charAt(0).toLowerCase()}${fieldName.slice(1)}`
      : fieldName;
  if (finalOwnerID) {
    ownerIDs.add(finalOwnerID);
  }
  for (const attacker of Array.isArray(record && record.attackers) ? record.attackers : []) {
    const ownerID = normalizePositiveInteger(
      attacker && attacker[attackerFieldName],
      null,
    );
    if (ownerID) {
      ownerIDs.add(ownerID);
    }
  }
  return [...ownerIDs];
}

function ensureKillmailIndexes() {
  if (!killmailIndexesDirty && killmailIndexes) {
    return killmailIndexes;
  }

  const table = ensureKillmailTableInitialized();
  killmailProjectionStats.fullRebuilds += 1;
  const indexes = buildEmptyKillmailIndexes();
  const records = Object.values((table && table.records) || {});
  indexes.recordsDesc = sortKillmailsDescending(records);

  for (const record of indexes.recordsDesc) {
    const finalCharacterID = normalizePositiveInteger(record && record.finalCharacterID, null);
    const victimCharacterID = normalizePositiveInteger(record && record.victimCharacterID, null);
    const victimCorporationID = normalizePositiveInteger(record && record.victimCorporationID, null);
    const victimAllianceID = normalizePositiveInteger(record && record.victimAllianceID, null);
    const warID = normalizePositiveInteger(record && record.warID, null);
    const attackerCorporationIDs = collectAttackerOwnerIDs(record, "CorporationID");
    const attackerAllianceIDs = collectAttackerOwnerIDs(record, "AllianceID");

    // ⚠ A CHARACTER'S COMBAT LOG IS CAPSULEER KILLS AND THEIR OWN LOSSES.
    //
    // This index feeds char.GetRecentShipKillsAndLosses. It used to file every
    // record under whoever struck the final blow, and this server writes a
    // killmail for NPC and drone victims too — so a player's log filled up with
    // rats they had shot, which is not something TQ ever puts there. Records
    // whose victim is not a capsuleer belong to the corporation and alliance
    // indexes built below, which is where structure and NPC losses are read
    // from.
    if (victimCharacterID) {
      appendRecordToIndex(indexes.recordsByCharacter, finalCharacterID, record);
      if (victimCharacterID !== finalCharacterID) {
        appendRecordToIndex(indexes.recordsByCharacter, victimCharacterID, record);
      }
    }

    // Kills only reach an owner log when the victim was a capsuleer or a
    // player-corporation asset; see isOwnerKillLogVictim. Losses are always
    // filed, which is where structure and NPC-corporation losses come from.
    const entersOwnerKillLog = isOwnerKillLogVictim(record);
    if (entersOwnerKillLog) {
      for (const corporationID of attackerCorporationIDs) {
        appendRecordToIndex(indexes.recordsByCorporationKills, corporationID, record);
      }
    }
    appendRecordToIndex(indexes.recordsByCorporationLosses, victimCorporationID, record);
    if (entersOwnerKillLog) {
      for (const allianceID of attackerAllianceIDs) {
        appendRecordToIndex(indexes.recordsByAllianceKills, allianceID, record);
      }
    }
    appendRecordToIndex(indexes.recordsByAllianceLosses, victimAllianceID, record);
    appendRecordToIndex(indexes.recordsByWar, warID, record);
  }

  killmailIndexes = indexes;
  killmailIndexesDirty = false;
  return killmailIndexes;
}

function getAllKillmailRecords() {
  return redactReservedAbyssalHostsFromKillmails(
    cloneValue(ensureKillmailIndexes().recordsDesc),
  );
}

function getKillmailRecord(killID) {
  const numericKillID = normalizePositiveInteger(killID, null);
  if (!numericKillID) {
    return null;
  }
  const table = killmailTableCache || readKillmailTableView() || ensureKillmailTableInitialized();
  const record = table.records && table.records[String(numericKillID)];
  return record
    ? redactReservedAbyssalHostFromKillmail(cloneValue(record))
    : null;
}

function pythonStringify(value) {
  if (value === undefined || value === null) {
    return "None";
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return String(value);
}

function getKillmailHashValue(killmail) {
  if (!killmail) {
    return "";
  }
  const hashInput = [
    pythonStringify(killmail.victimCharacterID),
    pythonStringify(killmail.finalCharacterID),
    pythonStringify(killmail.victimShipTypeID),
    pythonStringify(killmail.killTime),
  ].join("");
  return crypto.createHash("sha1").update(hashInput, "utf8").digest("hex");
}

function getTypeBasePrice(typeID) {
  const typeRecord = resolveItemByTypeID(typeID) || null;
  if (!typeRecord) {
    return 0;
  }
  return Math.max(0, normalizeNumber(typeRecord.basePrice, 0));
}

function collectKillmailBasePrices(record = {}) {
  const basePrices = {};
  const visitType = (typeID) => {
    const normalizedTypeID = normalizePositiveInteger(typeID, null);
    if (!normalizedTypeID) {
      return;
    }
    const key = String(normalizedTypeID);
    if (!Object.prototype.hasOwnProperty.call(basePrices, key)) {
      basePrices[key] = getTypeBasePrice(normalizedTypeID);
    }
  };
  const visitItems = (items) => {
    for (const item of Array.isArray(items) ? items : []) {
      visitType(item && item.typeID);
      visitItems(item && item.contents);
    }
  };
  visitType(record.victimShipTypeID);
  visitItems(record.items);
  return basePrices;
}

function buildKillmailPreparationOptions(record = {}, killID = null) {
  return {
    killID: normalizePositiveInteger(killID ?? record.killID, null),
    fallbackKillTime: currentFileTime().toString(),
    basePrices: collectKillmailBasePrices(record),
  };
}

function reserveKillmailEvent(record = {}) {
  const terminalEvent = cloneValue(record);
  const table = ensureKillmailTableInitialized();
  const killID = normalizePositiveInteger(table._meta.nextKillID, 1) || 1;
  const previousNextKillID = table._meta.nextKillID;
  const preparationOptions = buildKillmailPreparationOptions(
    terminalEvent,
    killID,
  );
  table._meta.nextKillID = killID + 1;
  table.pending[String(killID)] = {
    killID,
    reservedAt: currentFileTime().toString(),
    record: terminalEvent,
    preparationOptions,
  };
  const writeResult = writeKillmailTable(table, {
    flushImmediately: true,
    recordsChanged: false,
    knownChangedPaths: [
      "/_meta/nextKillID",
      `/pending/${killID}`,
    ],
  });
  if (!writeResult || !writeResult.success) {
    table._meta.nextKillID = previousNextKillID;
    delete table.pending[String(killID)];
    return null;
  }
  return table.pending[String(killID)];
}

function listPendingKillmailEvents() {
  const table = killmailTableCache || readKillmailTableView();
  if (!table || !table.pending || typeof table.pending !== "object") {
    return [];
  }
  return Object.values(table.pending || {})
    .filter((entry) => normalizePositiveInteger(entry && entry.killID, null))
    .sort((left, right) =>
      normalizePositiveInteger(left && left.killID, 0) -
      normalizePositiveInteger(right && right.killID, 0))
    .map((entry) => cloneValue(entry));
}

function completePendingKillmailEvent(killID) {
  const numericKillID = normalizePositiveInteger(killID, null);
  if (!numericKillID) {
    return false;
  }
  const table = ensureKillmailTableInitialized();
  if (!table.pending[String(numericKillID)]) {
    return true;
  }
  const pending = table.pending[String(numericKillID)];
  delete table.pending[String(numericKillID)];
  const writeResult = writeKillmailTable(table, {
    flushImmediately: true,
    recordsChanged: false,
    knownChangedPaths: [`/pending/${numericKillID}`],
  });
  if (!writeResult || !writeResult.success) {
    table.pending[String(numericKillID)] = pending;
    return false;
  }
  return true;
}

function reserveKillmailID() {
  const table = ensureKillmailTableInitialized();
  const killID = normalizePositiveInteger(table._meta.nextKillID, 1) || 1;
  const previousNextKillID = table._meta.nextKillID;
  table._meta.nextKillID = killID + 1;
  const writeResult = writeKillmailTable(table, {
    recordsChanged: false,
    knownChangedPaths: ["/_meta/nextKillID"],
  });
  if (!writeResult || !writeResult.success) {
    table._meta.nextKillID = previousNextKillID;
    return null;
  }
  return killID;
}

function commitPreparedKillmailRecord(preparedRecord, projection = null) {
  const killID = normalizePositiveInteger(
    preparedRecord && preparedRecord.killID,
    null,
  );
  if (!killID) {
    return null;
  }

  const table = ensureKillmailTableInitialized();
  if (table.records[String(killID)]) {
    return getKillmailRecord(killID);
  }

  const record = cloneValue(preparedRecord);
  require("../dynamic/dynamicBountyRuntime").stampLossRecord(record);
  const activeIndexes = !killmailIndexesDirty && killmailIndexes
    ? killmailIndexes
    : null;
  const knownChangedPaths = [`/records/${killID}`];
  table.records[String(killID)] = record;
  if (normalizePositiveInteger(table._meta.nextKillID, 1) <= killID) {
    table._meta.nextKillID = killID + 1;
    knownChangedPaths.push("/_meta/nextKillID");
  }

  const writeResult = writeKillmailTable(table, {
    flushImmediately: true,
    recordsChanged: !activeIndexes,
    knownChangedPaths,
  });
  if (!writeResult || !writeResult.success) {
    delete table.records[String(killID)];
    return null;
  }
  if (activeIndexes) {
    applyKillmailProjection(activeIndexes, record, projection);
    killmailProjectionStats.incrementalUpdates += 1;
    killmailIndexes = activeIndexes;
    killmailIndexesDirty = false;
  }
  try { require("../dynamic/dynamicBountyRuntime").recordLoss(record); }
  catch (error) { require("../../utils/logger").warn(`[DBS] committed kill=${killID} awaits recovery: ${error.message}`); }
  settleFactionWarfareAchievement(record);
  if (record.finalCharacterID) {
    try { require("../career/careerProgress").sync(Number(record.finalCharacterID)); }
    catch (error) { require("../../utils/logger").warn(`[Career] committed kill awaits projection: ${error.message}`); }
  }
  return getKillmailRecord(killID);
}

function createKillmailRecord(record = {}) {
  const killID = reserveKillmailID();
  if (!killID) {
    return null;
  }
  const prepared = prepareKillmailRecord(
    record,
    buildKillmailPreparationOptions(record, killID),
  );
  return commitPreparedKillmailRecord(prepared.record, prepared.projection);
}

// Self-destruct journals already own their event ID. Commit that ID and the
// loss report in one SQLite image so a crash cannot reserve a second kill.
function createKillmailRecordIdempotent(record, eventID) {
  if (!eventID || typeof eventID !== "string") throw new Error("KILLMAIL_EVENT_ID_REQUIRED");
  const table = cloneValue(ensureKillmailTableInitialized());
  table._meta.terminalEventKillIDs ||= {};
  const priorID = table._meta.terminalEventKillIDs[eventID];
  if (priorID) {
    const flushed = repo.flushTableSync(KILLMAIL_TABLE);
    if (!flushed?.success) throw new Error(flushed?.errorMsg || "KILLMAIL_EVENT_FLUSH_FAILED");
    return getKillmailRecord(priorID);
  }
  const killID = normalizePositiveInteger(table._meta.nextKillID, 1);
  const prepared = prepareKillmailRecord(record, buildKillmailPreparationOptions(record, killID));
  table._meta.nextKillID = killID + 1;
  table._meta.terminalEventKillIDs[eventID] = killID;
  const committedRecord = cloneValue(prepared.record);
  require("../dynamic/dynamicBountyRuntime").stampLossRecord(committedRecord);
  table.records[String(killID)] = committedRecord;
  const written = writeKillmailTable(table);
  if (!written?.success) throw new Error(written?.errorMsg || "KILLMAIL_EVENT_WRITE_FAILED");
  const flushed = repo.flushTableSync(KILLMAIL_TABLE);
  if (!flushed?.success) throw new Error(flushed?.errorMsg || "KILLMAIL_EVENT_FLUSH_FAILED");
  try { require("../dynamic/dynamicBountyRuntime").recordLoss(committedRecord); }
  catch (error) { require("../../utils/logger").warn(`[DBS] committed kill=${killID} awaits recovery: ${error.message}`); }
  settleFactionWarfareAchievement(committedRecord);
  return getKillmailRecord(killID);
}

function settleFactionWarfareAchievement(record) {
  if (!record.achievementFwWinnerCharacterID) return;
  try {
    const result = require("../achievement/achievementRuntime").recordCommittedFactionWarfareKill(record);
    if (!result?.success) throw new Error(result?.errorMsg || "WRITE_ERROR");
  } catch (error) {
    require("../../utils/logger").warn(`[Achievement] committed FW kill=${record.killID} awaits recovery: ${error.message}`);
  }
}

function buildKillmailPayload(record) {
  if (!record) {
    return null;
  }

  return buildKeyVal([
    ["killID", normalizePositiveInteger(record.killID, 0) || 0],
    ["killTime", buildFiletimeLong(record.killTime || currentFileTime())],
    ["solarSystemID", toPublicSolarSystemID(record.solarSystemID, null)],
    ["moonID", normalizePositiveInteger(record.moonID, null)],
    ["victimCharacterID", normalizePositiveInteger(record.victimCharacterID, null)],
    ["victimCorporationID", normalizePositiveInteger(record.victimCorporationID, null)],
    ["victimAllianceID", normalizePositiveInteger(record.victimAllianceID, null)],
    ["victimFactionID", normalizePositiveInteger(record.victimFactionID, null)],
    ["victimShipTypeID", normalizePositiveInteger(record.victimShipTypeID, null)],
    ["victimDamageTaken", Math.max(0, normalizeNumber(record.victimDamageTaken, 0))],
    ["finalCharacterID", normalizePositiveInteger(record.finalCharacterID, null)],
    ["finalCorporationID", normalizePositiveInteger(record.finalCorporationID, null)],
    ["finalAllianceID", normalizePositiveInteger(record.finalAllianceID, null)],
    ["finalFactionID", normalizePositiveInteger(record.finalFactionID, null)],
    ["finalShipTypeID", normalizePositiveInteger(record.finalShipTypeID, null)],
    ["finalWeaponTypeID", normalizePositiveInteger(record.finalWeaponTypeID, null)],
    ["finalSecurityStatus", normalizeNullableNumber(record.finalSecurityStatus, null)],
    ["finalDamageDone", Math.max(0, normalizeNumber(record.finalDamageDone, 0))],
    ["warID", normalizePositiveInteger(record.warID, null)],
    ["iskLost", normalizeNullableNumber(record.iskLost, null)],
    ["iskDestroyed", normalizeNullableNumber(record.iskDestroyed, null)],
    ["bountyClaimed", normalizeNullableNumber(record.bountyClaimed, null)],
    ["loyaltyPoints", normalizeNullableNumber(record.loyaltyPoints, null)],
    ["killRightSupplied", normalizePositiveInteger(record.killRightSupplied, null)],
    ["killBlob", normalizeText(record.killBlob, "")],
  ]);
}

function listKillmailsForCharacter(characterID, options = {}) {
  const numericCharacterID = normalizePositiveInteger(characterID, null);
  if (!numericCharacterID) {
    return [];
  }
  return redactReservedAbyssalHostsFromKillmails(limitRecords(
    filterByStartKillID(
      ensureKillmailIndexes().recordsByCharacter.get(numericCharacterID) || [],
      options.startKillID,
    ),
    options.limit,
  ));
}

function listKillmailsForCorporation(corporationID, relation = "all", options = {}) {
  const numericCorporationID = normalizePositiveInteger(corporationID, null);
  if (!numericCorporationID) {
    return [];
  }

  const indexes = ensureKillmailIndexes();
  const kills = indexes.recordsByCorporationKills.get(numericCorporationID) || [];
  const losses = indexes.recordsByCorporationLosses.get(numericCorporationID) || [];
  let filtered = [];
  if (relation === "kills") {
    filtered = kills;
  } else if (relation === "losses") {
    filtered = losses;
  } else {
    const recordsByKillID = new Map();
    for (const record of [...kills, ...losses]) {
      recordsByKillID.set(normalizePositiveInteger(record && record.killID, 0) || 0, record);
    }
    filtered = sortKillmailsDescending([...recordsByKillID.values()]);
  }

  return redactReservedAbyssalHostsFromKillmails(limitRecords(
    filterByStartKillID(filtered, options.startKillID),
    options.limit,
  ));
}

function isWarActiveAtKillTime(war, killTime) {
  if (!war) {
    return false;
  }
  const killTimeValue = BigInt(normalizeFiletimeString(killTime, currentFileTime().toString()));
  const startedAt = BigInt(normalizeFiletimeString(war.timeStarted, "0"));
  const finishedAt =
    war.timeFinished !== undefined && war.timeFinished !== null
      ? BigInt(normalizeFiletimeString(war.timeFinished, "0"))
      : null;
  if (killTimeValue < startedAt) {
    return false;
  }
  if (finishedAt !== null && finishedAt > 0n && killTimeValue >= finishedAt) {
    return false;
  }
  return true;
}

function isAllyActiveAtKillTime(ally = {}, killTime) {
  const killTimeValue = BigInt(normalizeFiletimeString(killTime, currentFileTime().toString()));
  const startedAt = BigInt(normalizeFiletimeString(ally.timeStarted, "0"));
  const finishedAt =
    ally.timeFinished !== undefined && ally.timeFinished !== null
      ? BigInt(normalizeFiletimeString(ally.timeFinished, "0"))
      : null;
  if (killTimeValue < startedAt) {
    return false;
  }
  if (finishedAt !== null && finishedAt > 0n && killTimeValue >= finishedAt) {
    return false;
  }
  return true;
}

function buildWarOwnerSets(war, killTime) {
  const attackerOwners = new Set();
  const defenderOwners = new Set();
  const attackerID = normalizePositiveInteger(war && war.declaredByID, null);
  const defenderID = normalizePositiveInteger(war && war.againstID, null);

  if (attackerID) {
    attackerOwners.add(attackerID);
  }
  if (defenderID) {
    defenderOwners.add(defenderID);
  }

  for (const [allyID, ally] of Object.entries((war && war.allies) || {})) {
    const numericAllyID = normalizePositiveInteger(allyID, null);
    if (!numericAllyID || !isAllyActiveAtKillTime(ally, killTime)) {
      continue;
    }
    defenderOwners.add(numericAllyID);
  }

  return {
    attackerOwners,
    defenderOwners,
  };
}

function resolveKillmailWarSide(record, war, actor = "victim") {
  if (!record || !war) {
    return null;
  }
  const ownerSets = buildWarOwnerSets(war, record.killTime);
  const corporationID = normalizePositiveInteger(record[`${actor}CorporationID`], null);
  const allianceID = normalizePositiveInteger(record[`${actor}AllianceID`], null);
  if (allianceID && ownerSets.attackerOwners.has(allianceID)) {
    return "attacker";
  }
  if (corporationID && ownerSets.attackerOwners.has(corporationID)) {
    return "attacker";
  }
  if (allianceID && ownerSets.defenderOwners.has(allianceID)) {
    return "defender";
  }
  if (corporationID && ownerSets.defenderOwners.has(corporationID)) {
    return "defender";
  }
  return null;
}

function resolveWarOwnerSide(war, ownerID) {
  const numericOwnerID = normalizePositiveInteger(ownerID, null);
  if (!numericOwnerID || !war) {
    return null;
  }
  const ownerSets = buildWarOwnerSets(war, currentFileTime().toString());
  if (ownerSets.attackerOwners.has(numericOwnerID)) {
    return "attacker";
  }
  if (ownerSets.defenderOwners.has(numericOwnerID)) {
    return "defender";
  }
  return null;
}

function resolveKillmailWarID(record = {}) {
  for (const warEntry of listAllWarsDescending()) {
    if (!isWarActiveAtKillTime(warEntry, record.killTime)) {
      continue;
    }
    const war = getWarRecord(warEntry.warID) || warEntry;
    const victimSide = resolveKillmailWarSide(record, war, "victim");
    if (!victimSide) {
      continue;
    }
    const attackerSides = new Set();
    const finalSide = resolveKillmailWarSide(record, war, "final");
    if (finalSide) {
      attackerSides.add(finalSide);
    }
    for (const attacker of Array.isArray(record.attackers) ? record.attackers : []) {
      const attackerRecord = {
        ...record,
        finalCorporationID: attacker.corporationID,
        finalAllianceID: attacker.allianceID,
      };
      const attackerSide = resolveKillmailWarSide(attackerRecord, war, "final");
      if (attackerSide) {
        attackerSides.add(attackerSide);
      }
    }
    if (
      (victimSide === "attacker" && attackerSides.has("defender")) ||
      (victimSide === "defender" && attackerSides.has("attacker"))
    ) {
      return normalizePositiveInteger(war.warID, null);
    }
  }
  return null;
}

function classifyWarShipGroup(typeID) {
  const typeRecord = resolveItemByTypeID(typeID) || {};
  const categoryID = normalizeInteger(typeRecord.categoryID, 0);
  const groupName = normalizeText(typeRecord.groupName, "").toLowerCase();

  if (categoryID === 65 || groupName.includes("structure")) {
    return GROUP_STRUCTURES;
  }
  if (
    groupName.includes("control tower") ||
    groupName.includes("starbase") ||
    groupName.includes("sentry battery") ||
    groupName.includes("electronic warfare battery")
  ) {
    return GROUP_POS;
  }
  if (isCapsuleTypeID(typeID) || groupName.includes("capsule")) {
    return GROUP_CAPSULES;
  }
  if (
    groupName.includes("carrier") ||
    groupName.includes("dreadnought") ||
    groupName.includes("titan") ||
    groupName.includes("supercarrier") ||
    groupName.includes("force auxiliary") ||
    groupName.includes("capital industrial") ||
    groupName.includes("lancer dreadnought")
  ) {
    return GROUP_CAPITALSHIPS;
  }
  if (
    groupName.includes("freighter") ||
    groupName.includes("industrial") ||
    groupName.includes("transport ship") ||
    groupName.includes("mining barge") ||
    groupName.includes("exhumer") ||
    groupName.includes("blockade runner") ||
    groupName.includes("industrial command")
  ) {
    return GROUP_INDUSTRIALS;
  }
  if (
    groupName.includes("battleship") ||
    groupName.includes("black ops") ||
    groupName.includes("marauder")
  ) {
    return GROUP_BATTLESHIPS;
  }
  if (
    groupName.includes("battlecruiser") ||
    groupName.includes("command ship") ||
    groupName.includes("attack battlecruiser")
  ) {
    return GROUP_BATTLECRUISERS;
  }
  if (
    groupName.includes("cruiser") ||
    groupName.includes("recon ship") ||
    groupName.includes("heavy assault") ||
    groupName.includes("heavy interdictor") ||
    groupName.includes("logistics") ||
    groupName.includes("flag cruiser")
  ) {
    return GROUP_CRUISERS;
  }
  if (
    groupName.includes("destroyer") ||
    groupName.includes("interdictor") ||
    groupName.includes("command destroyer") ||
    groupName.includes("tactical destroyer")
  ) {
    return GROUP_DESTROYERS;
  }
  return GROUP_FRIGATES;
}

function listKillmailsForWar(warID, options = {}) {
  const numericWarID = normalizePositiveInteger(warID, null);
  if (!numericWarID) {
    return [];
  }

  const war = getWarRecord(numericWarID);
  if (!war) {
    return [];
  }

  const groupFilter =
    options.groupID === null || options.groupID === undefined
      ? null
      : normalizeInteger(options.groupID, -1);
  const sideFilter = resolveWarOwnerSide(war, options.entityID);

  return redactReservedAbyssalHostsFromKillmails(
    (ensureKillmailIndexes().recordsByWar.get(numericWarID) || []).filter((record) => {
      if (normalizePositiveInteger(record && record.warID, null) !== numericWarID) {
        return false;
      }
      if (groupFilter !== null && groupFilter >= 0 && classifyWarShipGroup(record && record.victimShipTypeID) !== groupFilter) {
        return false;
      }
      if (!sideFilter) {
        return true;
      }
      const victimSide = resolveKillmailWarSide(record, war, "victim");
      if (sideFilter === "attacker") {
        return victimSide === "defender";
      }
      if (sideFilter === "defender") {
        return victimSide === "attacker";
      }
      return true;
    }),
  );
}

function buildWarDestructionStatistics(warID) {
  const war = getWarRecord(warID);
  if (!war) {
    return {
      shipsKilled: {},
      iskKilled: {},
      killsByGroup: {},
    };
  }

  const shipsKilled = {};
  const iskKilled = {};
  const killsByGroup = {};
  for (const bucket of [
    GROUP_CAPSULES,
    GROUP_FRIGATES,
    GROUP_DESTROYERS,
    GROUP_CRUISERS,
    GROUP_BATTLESHIPS,
    GROUP_BATTLECRUISERS,
    GROUP_CAPITALSHIPS,
    GROUP_INDUSTRIALS,
    GROUP_POS,
    GROUP_STRUCTURES,
  ]) {
    killsByGroup[bucket] = {
      attackerShipLoss: 0,
      attackerIskLoss: 0,
      defenderShipLoss: 0,
      defenderIskLoss: 0,
    };
  }

  for (const record of listKillmailsForWar(warID)) {
    const victimSide = resolveKillmailWarSide(record, war, "victim");
    const groupID = classifyWarShipGroup(record && record.victimShipTypeID);
    const iskLost = Math.max(0, normalizeNumber(record && record.iskLost, 0));
    if (victimSide === "defender") {
      const attackerID = normalizePositiveInteger(war.declaredByID, null);
      if (attackerID) {
        shipsKilled[String(attackerID)] = normalizeInteger(shipsKilled[String(attackerID)], 0) + 1;
        iskKilled[String(attackerID)] = normalizeNumber(iskKilled[String(attackerID)], 0) + iskLost;
      }
      killsByGroup[groupID].defenderShipLoss += 1;
      killsByGroup[groupID].defenderIskLoss += iskLost;
    } else if (victimSide === "attacker") {
      const defenderID = normalizePositiveInteger(war.againstID, null);
      if (defenderID) {
        shipsKilled[String(defenderID)] = normalizeInteger(shipsKilled[String(defenderID)], 0) + 1;
        iskKilled[String(defenderID)] = normalizeNumber(iskKilled[String(defenderID)], 0) + iskLost;
      }
      killsByGroup[groupID].attackerShipLoss += 1;
      killsByGroup[groupID].attackerIskLoss += iskLost;
    }
  }

  return {
    shipsKilled,
    iskKilled,
    killsByGroup,
  };
}

module.exports = {
  GROUP_BATTLECRUISERS,
  GROUP_BATTLESHIPS,
  GROUP_CAPITALSHIPS,
  GROUP_CAPSULES,
  GROUP_CRUISERS,
  GROUP_DESTROYERS,
  GROUP_FRIGATES,
  GROUP_INDUSTRIALS,
  GROUP_POS,
  GROUP_STRUCTURES,
  KILLMAIL_TABLE,
  buildKillmailPayload,
  buildKillmailPreparationOptions,
  buildWarDestructionStatistics,
  classifyWarShipGroup,
  completePendingKillmailEvent,
  commitPreparedKillmailRecord,
  createKillmailRecord,
  createKillmailRecordIdempotent,
  ensureKillmailTableInitialized,
  getAllKillmailRecords,
  getKillmailHashValue,
  getKillmailProjectionStats,
  getKillmailRecord,
  listKillmailsForCharacter,
  listKillmailsForCorporation,
  listPendingKillmailEvents,
  listKillmailsForWar,
  reserveKillmailEvent,
  reserveKillmailID,
  resolveKillmailWarID,
  resetKillmailStateForTests,
};
